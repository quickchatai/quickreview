// The profile's `[posting]` policy on the BENCHMARK route — the offline twin
// of src/posting.ts `assembleReview`'s policy step (src/postingpolicy.ts).
//
// A benchmark session posts nothing: it writes `comments.json` (the inline
// comments), `review.md` (the body) and `findings-record.json` into its case
// dir (aacr.ts `benchAppendix`), and every scorer — AACR-Bench's own, the
// defect judge, Martian's ingest (bench/aacr/ext/martian_ingest.py) — reads
// those files. So the policy is applied to the files themselves, after the
// session and before anything reads them, exactly once:
//
//   * the session's three files are kept beside, untouched
//     (`POLICED_ORIGINALS`), so what the session wrote is never lost;
//   * `comments.json` keeps only the inline comments the policy selects (in
//     the session's order);
//   * `review.md` is cut to the verdict line and one sentence
//     (`body = "verdict"`), or keeps its shape with the withheld findings'
//     bullets removed (`body = "full"`); either way its verdict line is
//     recounted over what still posts;
//   * `findings-record.json` marks every cut finding `withheld` with its word
//     — the same disposition production records — and synthesises an entry
//     for a cut comment the session never recorded, so nothing vanishes.
//
// Items are the inline comments plus the findings the record marks posted
// that went to the BODY (aacr.ts `placePosted`, the rule `bodyPostedFindings`
// scores by) — the body ones count against the budget too, because they are
// scored as comments. Each inline comment's record entry is the one
// `placePosted` pairs it with, one to one: cutting a comment marks ITS entry,
// never a neighbour's, and a comment with none gets a synthesised entry.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  firstSentence,
  selectPosted,
  siteKey,
  verdictLineFor,
  type PolicyClass,
  type PostingPolicy,
  type WithholdWord,
} from "../postingpolicy.js";
import { markWithheld, postedClassOf, withheldReason } from "../reviewrender.js";
import { SANCTIONED_TAGS } from "../severity.js";
import {
  benchPath,
  CASE_FILES,
  parseSessionComments,
  placePosted,
  posInt,
  type BenchSite,
} from "./aacr.js";
import { checkAnchor, runsByPath } from "../anchors.js";

/** The session's own files, kept beside the policed ones. */
export const POLICED_ORIGINALS = [
  "comments.session.json",
  "review.session.md",
  "findings-record.session.json",
  "posting-policy.json",
] as const;

export interface BenchPostingReport {
  kept: number;
  withheld: Array<{
    path: string;
    line: number;
    source: "inline" | "body";
    cls: PolicyClass;
    severity: string | null;
    word: WithholdWord;
    title: string;
  }>;
  body: "full" | "verdict";
}

interface Item {
  source: "inline" | "body";
  path: string;
  line: number;
  cls: PolicyClass;
  severity: string | null;
  title: string;
  /** The side its line counts on (inline rows may say LEFT; body items RIGHT). */
  side: "LEFT" | "RIGHT";
  /** inline: the session's raw row, written back verbatim when kept. */
  row?: unknown;
  /** The record entry it states (a body item's always; an inline comment's
   * when the record has one). */
  entry?: Record<string, unknown>;
}

const SEV_TAIL = /_\s*(P[0-3]|nit)\s*·\s*confidence/i;

function classOf(tag: string): PolicyClass {
  return tag === "blocker" || tag === "question" || tag === "nit" ? tag : "check";
}

/** Every sanctioned tag (`severity.ts`), as a title strips it. */
const ANY_TAG_RE = new RegExp(
  SANCTIONED_TAGS.map((t) => t.replace(/[[\]]/g, "\\$&")).join("|"),
  "gi",
);

function firstLineTitle(body: string): string {
  const first = (body.split("\n", 1)[0] ?? "").trim();
  return first.replace(ANY_TAG_RE, "").trim();
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Remove each bullet naming `` `path:line` `` (and its indented
 * continuation) from a markdown body. */
function dropBullets(md: string, refs: ReadonlySet<string>): string {
  if (refs.size === 0) return md;
  const lines = md.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] as string;
    const isBullet = /^\s*[-*] /.test(l);
    if (isBullet && [...refs].some((r) => l.includes(r))) {
      // skip its continuation: indented lines and blank lines followed by indent
      while (i + 1 < lines.length) {
        const nx = lines[i + 1] as string;
        if (/^\s{2,}\S/.test(nx)) i++;
        else if (/^\s*$/.test(nx) && /^\s{2,}\S/.test(lines[i + 2] ?? "")) i++;
        else break;
      }
      continue;
    }
    out.push(l);
  }
  // A section heading left with nothing under it goes too.
  const cleaned: string[] = [];
  for (let i = 0; i < out.length; i++) {
    const l = out[i] as string;
    if (/^###\s/.test(l)) {
      let j = i + 1;
      while (j < out.length && /^\s*$/.test(out[j] as string)) j++;
      if (
        j >= out.length ||
        /^#{1,3}\s/.test(out[j] as string) ||
        /^_Automated review/.test(out[j] as string)
      )
        continue;
    }
    cleaned.push(l);
  }
  return cleaned.join("\n").replace(/\n{3,}/g, "\n\n");
}

const VERDICT_RE = /\*\*Verdict:\s*([^*]+?)\*\*[^\n]*/;

function verdictLabel(md: string, verdict: string | null): string {
  if (verdict === "APPROVE") return "Approved";
  if (verdict === "REQUEST_CHANGES") return "Changes requested";
  const m = VERDICT_RE.exec(md);
  return m ? (m[1] as string).trim() : "Reviewed";
}

/** The first sentence of the body's plain opening paragraph, else of the
 * verdict `summary`. */
function openingSentence(md: string, summary: string): string {
  for (const para of md.split(/\n\s*\n/)) {
    const p = para.trim();
    if (!p) continue;
    if (/^(#|[-*] |_|<|\*\*Verdict|```|\|)/.test(p)) continue;
    const s = firstSentence(p);
    if (s) return s;
  }
  return firstSentence(summary);
}

/**
 * The pure core: the session's three outputs in, the policed three out, plus
 * the report. `outcome` gives the decided verdict and its summary.
 */
export function policeBenchOutput(args: {
  comments: unknown;
  reviewMd: string;
  record: unknown;
  outcome: { verdict: string | null; summary: string };
  policy: PostingPolicy;
  /** The PR's per-file patches, when known: within one severity the budget
   * then prefers an item on a changed line, as production posting does. */
  patches?: Record<string, string>;
}): { comments: unknown[]; reviewMd: string; record: unknown; report: BenchPostingReport } {
  const { policy } = args;
  const runs = args.patches ? runsByPath(args.patches) : undefined;
  const rawRows: unknown[] = Array.isArray(args.comments)
    ? args.comments
    : typeof args.comments === "object" &&
        args.comments !== null &&
        Array.isArray((args.comments as { comments?: unknown }).comments)
      ? (args.comments as { comments: unknown[] }).comments
      : [];
  const record =
    typeof args.record === "object" && args.record !== null && !Array.isArray(args.record)
      ? (structuredClone(args.record) as Record<string, unknown>)
      : null;
  const entries: Array<Record<string, unknown>> = Array.isArray(record?.["findings"])
    ? (record["findings"] as unknown[]).filter(
        (e): e is Record<string, unknown> => typeof e === "object" && e !== null,
      )
    : [];
  const posted = entries.filter((e) => e["disposition"] === "posted");

  const items: Item[] = [];
  const sites: BenchSite[] = [];
  const bodies: string[] = [];
  const passthrough: unknown[] = []; // rows the scorer drops anyway
  for (const row of rawRows) {
    const parsed = parseSessionComments([row]).comments[0];
    if (!parsed) {
      passthrough.push(row);
      continue;
    }
    items.push({
      source: "inline",
      path: parsed.path,
      line: parsed.line,
      cls: classOf(parsed.tag),
      severity: null,
      title: firstLineTitle(parsed.body),
      side: parsed.side === "LEFT" ? "LEFT" : "RIGHT",
      row,
    });
    bodies.push(parsed.body);
    sites.push({
      path: parsed.path,
      line: parsed.line,
      ...(parsed.start_line !== undefined ? { start_line: parsed.start_line } : {}),
      tag: parsed.tag,
    });
  }
  const places = placePosted(posted, args.reviewMd, sites);
  places.forEach((place, i) => {
    if (place?.at === "inline") items[place.comment]!.entry = posted[i]!;
  });
  // An inline comment's severity: its trailer's, else its record entry's.
  items.forEach((it, i) => {
    const sev = SEV_TAIL.exec(bodies[i]!)?.[1] || str(it.entry?.["severity"]);
    it.severity = sev ? (sev.toUpperCase() === "NIT" ? "nit" : sev.toUpperCase()) : null;
  });
  posted.forEach((e, i) => {
    if (places[i]?.at !== "body") return;
    const path = benchPath(e["path"]);
    const line = posInt(e["line"])!;
    items.push({
      source: "body",
      path,
      line,
      cls: postedClassOf(e["posted_as"]),
      severity: str(e["severity"]) || null,
      title: str(e["title"]) || str(e["reason"]).split("\n", 1)[0] || `${path}:${line}`,
      side: "RIGHT",
      entry: e,
    });
  });

  const sel = selectPosted(
    items,
    (it) => ({
      cls: it.cls,
      severity: it.severity,
      key: siteKey(it.title),
      ...(runs
        ? { changedLine: checkAnchor(runs, { path: it.path, side: it.side, line: it.line }).ok }
        : {}),
    }),
    policy,
  );
  const kept = new Set(sel.kept);

  // The record: every cut finding is `withheld`, with its word.
  for (const { item, word } of sel.withheld) {
    if (item.entry) markWithheld(item.entry, word);
    else if (record) {
      entries.push({
        id: `posting-${entries.length + 1}`,
        path: item.path,
        line: item.line,
        lens: "unknown",
        severity: item.severity,
        disposition: "withheld",
        word,
        reason: `${withheldReason(word)} The session posted it without a findings-record entry: ${item.title}`,
      });
    }
  }
  if (record) {
    record["findings"] = entries;
    record["comments_posted"] = items.filter((i) => i.source === "inline" && kept.has(i)).length;
  }

  // The body.
  const counts = { blocker: 0, nit: 0, question: 0 };
  for (const it of sel.kept) if (it.cls !== "check") counts[it.cls] += 1;
  const label = verdictLabel(args.reviewMd, args.outcome.verdict);
  let reviewMd: string;
  if (policy.body === "verdict") {
    const lines = [verdictLineFor(label, counts)];
    const s = openingSentence(args.reviewMd, args.outcome.summary);
    if (s) lines.push("", s);
    const bodyKept = sel.kept.filter((i) => i.source === "body");
    if (bodyKept.length)
      lines.push("", ...bodyKept.map((i) => `- \`${i.path}:${i.line}\` — ${i.title}`));
    reviewMd = `${lines.join("\n")}\n`;
  } else {
    const refs = new Set(sel.withheld.map(({ item }) => `\`${item.path}:${item.line}\``));
    reviewMd = dropBullets(args.reviewMd, refs);
    if (sel.withheld.length > 0)
      reviewMd = reviewMd.replace(VERDICT_RE, verdictLineFor(label, counts));
  }

  return {
    comments: [
      ...items.filter((i) => i.source === "inline" && kept.has(i)).map((i) => i.row),
      ...passthrough,
    ],
    reviewMd,
    record: record ?? args.record,
    report: {
      kept: sel.kept.length,
      withheld: sel.withheld.map(({ item, word }) => ({
        path: item.path,
        line: item.line,
        source: item.source,
        cls: item.cls,
        severity: item.severity,
        word,
        title: item.title,
      })),
      body: policy.body,
    },
  };
}

function readJsonOr(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Apply the policy to one case dir, in place: the session's files move to
 * `POLICED_ORIGINALS`, the policed ones take their names, and the report goes
 * to `posting-policy.json`. Null when the session wrote no comments file, or
 * one that does not parse (nothing to police — the case scores as it stands).
 */
export function enforceBenchPosting(
  caseDir: string,
  policy: PostingPolicy,
  patches?: Record<string, string>,
): BenchPostingReport | null {
  const cPath = join(caseDir, CASE_FILES.comments);
  if (!existsSync(cPath)) return null;
  // A comments file that does not parse is left as the session wrote it, so
  // the case reads as unparseable output — never rewritten as an empty review.
  const comments = readJsonOr(cPath);
  if (comments === undefined) return null;
  const rPath = join(caseDir, CASE_FILES.review);
  const fPath = join(caseDir, CASE_FILES.findings);
  const reviewMd = existsSync(rPath) ? readFileSync(rPath, "utf8") : "";
  const record = readJsonOr(fPath);
  const outcome = readJsonOr(join(caseDir, CASE_FILES.outcome)) as
    Record<string, unknown> | undefined;
  const out = policeBenchOutput({
    comments,
    reviewMd,
    record,
    outcome: {
      verdict: typeof outcome?.["verdict"] === "string" ? outcome["verdict"] : null,
      summary: typeof outcome?.["summary"] === "string" ? outcome["summary"] : "",
    },
    policy,
    ...(patches ? { patches } : {}),
  });
  renameSync(cPath, join(caseDir, POLICED_ORIGINALS[0]));
  writeFileSync(cPath, JSON.stringify(out.comments, null, 2) + "\n");
  if (existsSync(rPath)) renameSync(rPath, join(caseDir, POLICED_ORIGINALS[1]));
  writeFileSync(rPath, out.reviewMd);
  if (existsSync(fPath) && record !== undefined) {
    renameSync(fPath, join(caseDir, POLICED_ORIGINALS[2]));
    writeFileSync(fPath, JSON.stringify(out.record, null, 2) + "\n");
  }
  writeFileSync(
    join(caseDir, "posting-policy.json"),
    JSON.stringify({ policy, ...out.report }, null, 2) + "\n",
  );
  return out.report;
}

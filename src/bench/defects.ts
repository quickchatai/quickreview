// The defect benchmark — does a review FIND the real defects in a PR, and is
// what it says true?
//
// AACR-Bench scores a review by whether it wrote the same COMMENT as a
// dataset reference (same file, ±1 line, "same point" to a judge). Hand checks
// of its v1.0 references found about half of them wrong at the code and only
// ~10% naming an important defect, and the scoring rewards silence and
// posting a finding twice (bench/aacr/README.md). This module replaces that
// question with the one a review is for:
//
//   · GROUND TRUTH is a verified list of the real defects each PR introduces
//     or exposes (bench/aacr/defects/<set>.json): a blind expert hunt, the
//     dataset's references and every comment any reviewer posted, each checked
//     against the code, merged and graded high / medium / low.
//   · RECALL: for each defect, did the review identify it — anywhere, in its
//     own words, at the cause or at the symptom? found / partial / missed.
//   · PRECISION: every comment that finds no listed defect is checked against
//     the code: correct and worth raising, correct but minor, partly correct,
//     wrong, or unverifiable. A correct new defect is a CANDIDATE for the
//     ground truth (never added automatically).
//
// The judge is a pi session with read-only tools in the PR's own checkout
// (cli.ts `defect-judge`); this module is the pure part: the ground-truth
// shape, the review as the author received it, the prompt, the strict parse
// of the judge's answer, and the scoring. Old runs are re-judged from their
// run dir alone — nothing here needs the review to be re-run.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeRowsForJudge } from "./claudeshape.js";

export const SEVERITIES = ["high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];
/** Recall weights: a missed blocker costs three follow-ups. */
export const SEVERITY_WEIGHT: Record<Severity, number> = { high: 3, medium: 2, low: 1 };

export interface DefectSite {
  path: string;
  from_line: number;
  to_line: number;
  /** cause | symptom | other-site */
  role?: string;
}

export interface Defect {
  id: string;
  title: string;
  statement: string;
  sites: DefectSite[];
  kind: string;
  severity: Severity;
  evidence: string;
  /** What a comment must say to count, and near-misses that must not. */
  notes?: string;
  provenance?: unknown;
}

/** A candidate checked against the code and rejected (wrong, pre-existing,
 * unreachable, a nit…), with the reason. The judge reads these so a comment
 * repeating one is never credited as a new defect. */
export interface ExcludedClaim {
  source: string;
  reason: string;
}

export interface DefectCase {
  instance_id: string;
  pr_summary: string;
  defects: Defect[];
  excluded: ExcludedClaim[];
}

export interface DefectSet {
  set: string;
  /** Bumped on every ground-truth change; a judgement records the version it
   * was scored against, so a re-judge never silently mixes two truths. */
  version: string;
  method: string;
  cases: Record<string, DefectCase>;
}

function str(v: unknown, what: string): string {
  if (typeof v !== "string" || !v.trim())
    throw new Error(`defect set: ${what} must be a non-empty string`);
  return v;
}

function int(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1)
    throw new Error(`defect set: ${what} must be a positive integer`);
  return v;
}

export function parseDefectSet(raw: unknown): DefectSet {
  const r = (raw ?? {}) as Record<string, unknown>;
  const cases: Record<string, DefectCase> = {};
  const rc = (r["cases"] ?? {}) as Record<string, unknown>;
  if (typeof rc !== "object" || Array.isArray(rc))
    throw new Error("defect set: cases must be an object");
  for (const [iid, v] of Object.entries(rc)) {
    const c = (v ?? {}) as Record<string, unknown>;
    const ids = new Set<string>();
    const defects = (Array.isArray(c["defects"]) ? c["defects"] : []).map((d, i) => {
      const x = (d ?? {}) as Record<string, unknown>;
      const id = str(x["id"], `${iid} defect #${i} id`);
      if (ids.has(id)) throw new Error(`defect set: ${iid} has duplicate defect id ${id}`);
      ids.add(id);
      const severity = x["severity"];
      if (!SEVERITIES.includes(severity as Severity))
        throw new Error(`defect set: ${iid} ${id} severity must be high | medium | low`);
      const sites = (Array.isArray(x["sites"]) ? x["sites"] : []).map((s, k) => {
        const y = (s ?? {}) as Record<string, unknown>;
        const from = int(y["from_line"], `${iid} ${id} site #${k} from_line`);
        const to = int(y["to_line"], `${iid} ${id} site #${k} to_line`);
        return {
          path: str(y["path"], `${iid} ${id} site #${k} path`),
          from_line: Math.min(from, to),
          to_line: Math.max(from, to),
          ...(typeof y["role"] === "string" ? { role: y["role"] } : {}),
        };
      });
      if (!sites.length) throw new Error(`defect set: ${iid} ${id} has no site`);
      return {
        id,
        title: str(x["title"], `${iid} ${id} title`),
        statement: str(x["statement"], `${iid} ${id} statement`),
        sites,
        kind: str(x["kind"], `${iid} ${id} kind`),
        severity: severity as Severity,
        evidence: str(x["evidence"], `${iid} ${id} evidence`),
        ...(typeof x["notes"] === "string" ? { notes: x["notes"] } : {}),
        ...(x["provenance"] !== undefined ? { provenance: x["provenance"] } : {}),
      };
    });
    const excluded = (Array.isArray(c["excluded"]) ? c["excluded"] : [])
      .map((e) => (e ?? {}) as Record<string, unknown>)
      .filter((e) => typeof e["source"] === "string" && typeof e["reason"] === "string")
      .map((e) => ({ source: e["source"] as string, reason: e["reason"] as string }));
    cases[iid] = {
      instance_id: iid,
      pr_summary: typeof c["pr_summary"] === "string" ? c["pr_summary"] : "",
      defects,
      excluded,
    };
  }
  return {
    set: str(r["set"], "set"),
    version: str(r["version"], "version"),
    method: typeof r["method"] === "string" ? r["method"] : "",
    cases,
  };
}

// ---- the review as the author received it ----------------------------------

export interface ReviewComment {
  id: string;
  path: string | null;
  line: number | null;
  end_line: number | null;
  /** blocker | question | nit | … — null for a reviewer that tags nothing. */
  tag: string | null;
  text: string;
}

export interface ReviewForJudge {
  verdict: string | null;
  body: string | null;
  comments: ReviewComment[];
}

const TAG_RE = /^\s*\[([a-z][a-z ]*)\]\s*/i;
const FOOTER_RE = /\n*_P\d[^\n]*_\s*$/;
const MAX_BODY = 12_000;

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Assemble one case's review from a run dir — ours or the OCR arm's. The
 * scored `results/all/<id>.json` is the comment list (it already carries the
 * findings a round posted in the body); the verdict and body come from the
 * case dir when the arm has them. A case that produced nothing is an empty
 * review, which misses every defect — never an error.
 */
export function reviewForJudge(runDir: string, instanceId: string): ReviewForJudge {
  const scored = readJson(join(runDir, "results", "all", `${instanceId}.json`)) as
    { review?: { comments?: unknown[] } } | undefined;
  // The Claude Code arm's file carries the same OCR-shaped view (claudecode.ts
  // `withClaudeView`: the harness's findings, or the prose parser's); one
  // written before that view existed is read the harness's Claude reader's way
  // (src/bench/claudeshape.ts) — zero rows for a raw-text answer.
  const rows: unknown[] = scored?.review?.comments ?? claudeRowsForJudge(scored) ?? [];
  const comments: ReviewComment[] = [];
  for (const row of rows) {
    const r = (row ?? {}) as Record<string, unknown>;
    const raw = typeof r["content"] === "string" ? r["content"] : "";
    if (!raw.trim()) continue;
    const m = TAG_RE.exec(raw);
    const tag = m ? m[1]!.toLowerCase() : null;
    const text = raw.replace(TAG_RE, "").replace(FOOTER_RE, "").trim();
    const line = typeof r["start_line"] === "number" ? r["start_line"] : null;
    const end = typeof r["end_line"] === "number" ? r["end_line"] : line;
    comments.push({
      id: `C${comments.length + 1}`,
      path: typeof r["path"] === "string" ? r["path"] : null,
      line,
      end_line: end,
      tag,
      text,
    });
  }
  // Comments on DELETED lines: posted in production, but the AACR scorer reads
  // only the RIGHT side, so the scored file above leaves them out. A defect
  // review counts them. Appended last, so every other comment keeps its id.
  const posted = readJson(join(runDir, "cases", instanceId, "comments.json"));
  for (const row of Array.isArray(posted) ? (posted as unknown[]) : []) {
    const r = (row ?? {}) as Record<string, unknown>;
    if (typeof r["side"] !== "string" || r["side"].toUpperCase() !== "LEFT") continue;
    const raw = typeof r["body"] === "string" ? r["body"] : "";
    if (!raw.trim()) continue;
    const m = TAG_RE.exec(raw);
    const line = typeof r["line"] === "number" ? r["line"] : null;
    comments.push({
      id: `C${comments.length + 1}`,
      path: typeof r["path"] === "string" ? `${r["path"]} (deleted line)` : null,
      line,
      end_line: line,
      tag: m ? m[1]!.toLowerCase() : null,
      text: raw.replace(TAG_RE, "").replace(FOOTER_RE, "").trim(),
    });
  }
  const summary = readJson(join(runDir, "cases", instanceId, "case-summary.json")) as
    { verdict?: unknown } | undefined;
  const bodyPath = join(runDir, "cases", instanceId, "review.md");
  let body: string | null = existsSync(bodyPath) ? readFileSync(bodyPath, "utf8").trim() : null;
  if (body && body.length > MAX_BODY) body = `${body.slice(0, MAX_BODY)}\n[… body truncated]`;
  return {
    verdict: typeof summary?.verdict === "string" ? summary.verdict : null,
    body: body || null,
    comments,
  };
}

// ---- the prompt ---------------------------------------------------------------

export interface JudgePr {
  instance_id: string;
  repo: string;
  title: string | null;
  merge_base: string;
  head: string;
}

function site(s: DefectSite): string {
  const span = s.from_line === s.to_line ? `${s.from_line}` : `${s.from_line}-${s.to_line}`;
  return `${s.path}:${span}${s.role ? ` (${s.role})` : ""}`;
}

/** Rejected claims shown to the judge: each reason capped, the list capped. */
const MAX_EXCLUDED_REASON = 600;
const MAX_EXCLUDED_TOTAL = 14_000;

export function judgePrompt(
  pr: JudgePr,
  defects: readonly Defect[],
  review: ReviewForJudge,
  excluded: readonly ExcludedClaim[] = [],
): string {
  let budget = MAX_EXCLUDED_TOTAL;
  const ex: string[] = [];
  for (const e of excluded) {
    const reason =
      e.reason.length > MAX_EXCLUDED_REASON
        ? `${e.reason.slice(0, MAX_EXCLUDED_REASON)}…`
        : e.reason;
    const line = `- ${e.source}: ${reason}`;
    if (line.length > budget) {
      ex.push(`- (${excluded.length - ex.length} more rejected claims not shown)`);
      break;
    }
    budget -= line.length;
    ex.push(line);
  }
  const d = defects.length
    ? defects
        .map(
          (x) =>
            `${x.id} [${x.severity}, ${x.kind}] ${x.title}\n   ${x.statement}\n   sites: ${x.sites.map(site).join("; ")}` +
            (x.notes ? `\n   counts if: ${x.notes}` : ""),
        )
        .join("\n")
    : "(none — this PR has no real defect in the ground truth)";
  const c = review.comments.length
    ? review.comments
        .map((x) => {
          const where = x.path
            ? `${x.path}:${x.line ?? "?"}${x.end_line && x.end_line !== x.line ? `-${x.end_line}` : ""}`
            : "(no anchor)";
          return `${x.id} ${x.tag ? `[${x.tag}] ` : ""}${where}\n${x.text}`;
        })
        .join("\n\n")
    : "(no comments)";
  return `You are the judge of a code-review benchmark that measures one thing: does a review FIND the real defects in a pull request and point them out, and is what it says true? Wording, tone, tags and exact line numbers do not matter; substance does.

THE PULL REQUEST: ${pr.title ?? "(untitled)"} — ${pr.repo}, head ${pr.head}, merge base ${pr.merge_base}. The repository is checked out at the PR head in your working directory. You may read any code (read tool; bash for git diff/show/log/grep, rg, ls, find, sed -n, head, tail, wc). Never run project code.

THE REAL DEFECTS (ground truth — each verified against the code; trust these):
${d}

${
  ex.length
    ? `CLAIMS ALREADY CHECKED AGAINST THE CODE AND REJECTED (not defects — each with the reason it failed). A comment repeating one of these is never a new defect: judge it incorrect, partly-correct or correct-minor as its reason says, reading the code if the comment adds something the reason does not cover:
${ex.join("\n")}

`
    : ""
}THE REVIEW (what the author received):
Verdict: ${review.verdict ?? "(none)"}
${review.body ? `Body:\n${review.body}\n` : ""}Comments:
${c}

YOUR TASK
1. For EACH defect decide whether the review found it:
   - found: some comment (or the body) identifies THIS defect — the same underlying problem, with its essential point right (see "counts if"), so the author would fix it. It may sit at the cause or the symptom site, or name the site in its text.
   - partial: the review points at this problem or its site, but with a wrong or missing mechanism or consequence, so the author could fix the wrong thing.
   - missed: nothing in the review identifies it.
2. For EACH comment: which defect it finds (its id, or null), and whether it is correct. Check every comment that finds no listed defect against the code:
   - correct-valuable: true at the head and worth raising before merge;
   - correct-minor: true but low value (style, a test request, a nice-to-have, a nit);
   - partly-correct: a real problem, but the mechanism, scope or severity is materially wrong;
   - incorrect: false at the head (the code does not do what it says, or the scenario cannot happen);
   - unverifiable: cannot be decided from the repository.
   A comment that finds a listed defect is correct-valuable, or partly-correct if it found it only partially. Set new_defect true only for a correct-valuable comment that describes a real defect that is neither in the list nor among the rejected claims.
Be strict both ways: do not credit a comment for sounding plausible, and do not dismiss one without reading the code it cites.

Answer with ONE JSON object and nothing after it:
{"defects":[{"id":"D1","verdict":"found|partial|missed","comments":["C2"],"why":"one sentence"}],"comments":[{"id":"C1","defect":"D1","verdict":"correct-valuable|correct-minor|partly-correct|incorrect|unverifiable","new_defect":false,"why":"one sentence with file:line"}]}
Every defect id and every comment id above must appear exactly once.`;
}

// ---- the judge's answer -------------------------------------------------------

export const DEFECT_VERDICTS = ["found", "partial", "missed"] as const;
export type DefectVerdictKind = (typeof DEFECT_VERDICTS)[number];
export const COMMENT_VERDICTS = [
  "correct-valuable",
  "correct-minor",
  "partly-correct",
  "incorrect",
  "unverifiable",
] as const;
export type CommentVerdictKind = (typeof COMMENT_VERDICTS)[number];

export interface DefectVerdict {
  id: string;
  verdict: DefectVerdictKind;
  comments: string[];
  why: string;
}

export interface CommentVerdict {
  id: string;
  defect: string | null;
  verdict: CommentVerdictKind;
  new_defect: boolean;
  why: string;
}

export interface CaseJudgement {
  instance_id: string;
  round: number;
  defect_set_version: string;
  model: string;
  defects: DefectVerdict[];
  comments: CommentVerdict[];
  usage?: { input: number; output: number; cacheRead: number };
  error?: string;
  /** sha256 of the review this round judged: a re-run review in the same
   * run dir makes the round stale (defectjudge.ts re-judges it on resume). */
  review_hash?: string;
}

/** The stamp a judged round carries for the review it judged. */
export function reviewHash(review: ReviewForJudge): string {
  return createHash("sha256").update(JSON.stringify(review)).digest("hex");
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  const x = [...a].sort();
  const y = [...b].sort();
  return x.length === y.length && x.every((id, i) => id === y[i]);
}

/**
 * Did this saved round judge THIS review? `review --resume` rewrites a case's
 * review in the same run dir, and comment ids (C1, …) are stable across the
 * rewrite, so an old round's verdicts would attach to new text. A round written
 * before the stamp existed stands while it judged exactly this review's comment
 * ids (a clean answer covers every one, parseJudgement).
 */
export function judgedReview(j: CaseJudgement, review: ReviewForJudge): boolean {
  return j.review_hash !== undefined
    ? j.review_hash === reviewHash(review)
    : sameIds(
        j.comments.map((c) => c.id),
        review.comments.map((c) => c.id),
      );
}

/** The last balanced top-level JSON object in `text` (fences allowed). */
export function lastJsonObject(text: string): unknown {
  const s = text.replace(/```(?:json)?/g, "");
  for (let end = s.lastIndexOf("}"); end >= 0; end = s.lastIndexOf("}", end - 1)) {
    let depth = 0;
    let inStr = false;
    for (let i = end; i >= 0; i--) {
      const ch = s[i];
      // Walking backwards: a quote toggles string state unless escaped.
      if (ch === '"') {
        let bs = 0;
        for (let k = i - 1; k >= 0 && s[k] === "\\"; k--) bs++;
        if (bs % 2 === 0) inStr = !inStr;
        continue;
      }
      if (inStr) continue;
      if (ch === "}") depth++;
      else if (ch === "{" && --depth === 0) {
        try {
          return JSON.parse(s.slice(i, end + 1));
        } catch {
          break;
        }
      }
    }
  }
  return undefined;
}

/**
 * Strict parse: every listed defect and every comment must be judged exactly
 * once, with a verdict from the closed vocabulary. An answer that fails is an
 * ERROR for that case (recorded, never guessed) — a judge that silently drops
 * a defect would score it as missed.
 */
export function parseJudgement(
  text: string,
  defects: readonly Defect[],
  review: ReviewForJudge,
): { defects: DefectVerdict[]; comments: CommentVerdict[] } {
  const obj = lastJsonObject(text) as { defects?: unknown; comments?: unknown } | undefined;
  if (!obj || typeof obj !== "object") throw new Error("judge answer has no JSON object");
  const dIds = new Set(defects.map((d) => d.id));
  const cIds = new Set(review.comments.map((c) => c.id));
  const dv = new Map<string, DefectVerdict>();
  for (const row of Array.isArray(obj.defects) ? obj.defects : []) {
    const r = (row ?? {}) as Record<string, unknown>;
    const id = typeof r["id"] === "string" ? r["id"] : "";
    if (!dIds.has(id)) throw new Error(`judge answer names unknown defect ${JSON.stringify(id)}`);
    if (dv.has(id)) throw new Error(`judge answer judges defect ${id} twice`);
    const verdict = r["verdict"];
    if (!DEFECT_VERDICTS.includes(verdict as DefectVerdictKind))
      throw new Error(`judge answer: defect ${id} verdict ${JSON.stringify(verdict)}`);
    const comments = (Array.isArray(r["comments"]) ? (r["comments"] as unknown[]) : []).filter(
      (c): c is string => typeof c === "string" && cIds.has(c),
    );
    dv.set(id, {
      id,
      verdict: verdict as DefectVerdictKind,
      comments,
      why: typeof r["why"] === "string" ? r["why"] : "",
    });
  }
  const missingD = [...dIds].filter((id) => !dv.has(id));
  if (missingD.length) throw new Error(`judge answer skips defect(s) ${missingD.join(", ")}`);
  const cv = new Map<string, CommentVerdict>();
  for (const row of Array.isArray(obj.comments) ? obj.comments : []) {
    const r = (row ?? {}) as Record<string, unknown>;
    const id = typeof r["id"] === "string" ? r["id"] : "";
    // A comment the review does not have (the judge read a body finding as
    // one) carries no score: ignored. A SKIPPED real comment still fails.
    if (!cIds.has(id)) continue;
    if (cv.has(id)) throw new Error(`judge answer judges comment ${id} twice`);
    const verdict = r["verdict"];
    if (!COMMENT_VERDICTS.includes(verdict as CommentVerdictKind))
      throw new Error(`judge answer: comment ${id} verdict ${JSON.stringify(verdict)}`);
    const defect = typeof r["defect"] === "string" && dIds.has(r["defect"]) ? r["defect"] : null;
    cv.set(id, {
      id,
      defect,
      verdict: verdict as CommentVerdictKind,
      new_defect: r["new_defect"] === true,
      why: typeof r["why"] === "string" ? r["why"] : "",
    });
  }
  const missingC = [...cIds].filter((id) => !cv.has(id));
  if (missingC.length) throw new Error(`judge answer skips comment(s) ${missingC.join(", ")}`);
  return { defects: [...dv.values()], comments: [...cv.values()] };
}

// ---- scoring --------------------------------------------------------------------

const CREDIT: Record<DefectVerdictKind, number> = { found: 1, partial: 0.5, missed: 0 };

export interface RunScore {
  cases: number;
  judged: number;
  errors: number;
  /** Error-free rounds that judged a different review (never scored). */
  stale: number;
  rounds: number;
  defects: { total: number; found: number; partial: number; missed: number; recall: number };
  by_severity: Record<Severity, { total: number; credit: number; recall: number }>;
  weighted_recall: number;
  comments: Record<CommentVerdictKind, number> & {
    total: number;
    finds_defect: number;
    correct_share: number;
    valuable_share: number;
    wrong_blockers: number;
  };
  new_defect_candidates: { instance_id: string; comment: string; why: string }[];
  /** Approved although the PR has a high-severity defect the review missed. */
  approved_over_missed_high: string[];
}

/** The exit code of a defect-judge/-report run: 1 whenever the measurement is
 * incomplete — a judge error, a stale round, a case defect-judge could not judge, or a case
 * with no usable round on disk (a bare defect-report over a partial judge
 * dir). The report still discloses it ("judged k/N"); the exit code must too. */
export function scoreExitCode(
  score: Pick<RunScore, "cases" | "judged" | "errors" | "stale">,
  judgeIncomplete: boolean,
): 0 | 1 {
  return score.errors || score.stale || judgeIncomplete || score.judged < score.cases ? 1 : 0;
}

/**
 * Average over rounds, per case, then pool over cases. A case with no usable
 * round (every round errored) counts every defect as MISSED and every comment
 * as UNVERIFIABLE — an unjudged case never silently leaves the denominator.
 */
export function scoreRun(
  set: DefectSet,
  instanceIds: readonly string[],
  judgements: Record<string, CaseJudgement[]>,
  reviews: Record<string, ReviewForJudge>,
): RunScore {
  const sev = Object.fromEntries(
    SEVERITIES.map((s) => [s, { total: 0, credit: 0, recall: 0 }]),
  ) as RunScore["by_severity"];
  const cv = Object.fromEntries(COMMENT_VERDICTS.map((v) => [v, 0])) as Record<
    CommentVerdictKind,
    number
  >;
  let total = 0,
    found = 0,
    partial = 0,
    missed = 0,
    wTotal = 0,
    wCredit = 0;
  let cTotal = 0,
    cFinds = 0,
    wrongBlockers = 0,
    judged = 0,
    errors = 0,
    stale = 0,
    rounds = 0;
  const candidates: RunScore["new_defect_candidates"] = [];
  const approvedOverMissed: string[] = [];
  for (const iid of instanceIds) {
    const defects = set.cases[iid]?.defects ?? [];
    const review = reviews[iid] ?? { verdict: null, body: null, comments: [] };
    const clean = (judgements[iid] ?? []).filter((j) => !j.error);
    errors += (judgements[iid] ?? []).length - clean.length;
    const ok = clean.filter((j) => judgedReview(j, review));
    stale += clean.length - ok.length;
    rounds = Math.max(rounds, (judgements[iid] ?? []).length);
    if (ok.length) judged++;
    const n = ok.length || 1;
    let missedHigh = false;
    for (const d of defects) {
      let credit = 0,
        f = 0,
        p = 0,
        m = 0;
      for (const j of ok) {
        const v = j.defects.find((x) => x.id === d.id)?.verdict ?? "missed";
        credit += CREDIT[v];
        if (v === "found") f++;
        else if (v === "partial") p++;
        else m++;
      }
      if (!ok.length) m = 1;
      credit /= n;
      total++;
      found += f / n;
      partial += p / n;
      missed += m / n;
      sev[d.severity].total++;
      sev[d.severity].credit += credit;
      wTotal += SEVERITY_WEIGHT[d.severity];
      wCredit += SEVERITY_WEIGHT[d.severity] * credit;
      if (d.severity === "high" && credit === 0) missedHigh = true;
    }
    for (const c of review.comments) {
      cTotal++;
      if (!ok.length) {
        cv.unverifiable++;
        continue;
      }
      let finds = 0,
        wrongBlocker = 0;
      for (const j of ok) {
        const v = j.comments.find((x) => x.id === c.id);
        const kind: CommentVerdictKind = v?.verdict ?? "unverifiable";
        cv[kind] += 1 / n;
        if (v?.defect) finds++;
        if (c.tag === "blocker" && (kind === "incorrect" || kind === "partly-correct"))
          wrongBlocker++;
        if (v?.new_defect && !candidates.some((x) => x.instance_id === iid && x.comment === c.id))
          candidates.push({ instance_id: iid, comment: c.id, why: v.why });
      }
      cFinds += finds / n;
      wrongBlockers += wrongBlocker / n;
    }
    if (missedHigh && /^approve/i.test(review.verdict ?? "")) approvedOverMissed.push(iid);
  }
  for (const s of SEVERITIES) sev[s].recall = sev[s].total ? sev[s].credit / sev[s].total : 0;
  const correct = cv["correct-valuable"] + cv["correct-minor"];
  return {
    cases: instanceIds.length,
    judged,
    errors,
    stale,
    rounds,
    defects: { total, found, partial, missed, recall: total ? (found + 0.5 * partial) / total : 0 },
    by_severity: sev,
    weighted_recall: wTotal ? wCredit / wTotal : 0,
    comments: {
      ...cv,
      total: cTotal,
      finds_defect: cFinds,
      correct_share: cTotal ? correct / cTotal : 0,
      valuable_share: cTotal ? cv["correct-valuable"] / cTotal : 0,
      wrong_blockers: wrongBlockers,
    },
    new_defect_candidates: candidates,
    approved_over_missed_high: approvedOverMissed,
  };
}

const pct = (x: number): string => `${Math.round(x * 100)}%`;
const num = (x: number): string => (Number.isInteger(x) ? String(x) : x.toFixed(1));

/** What this report measures — the one paragraph every defect report opens
 * with (the whole story: bench/aacr/METRICS.md). */
export const DEFECT_REPORT_PREAMBLE =
  "_What this measures: did the review FIND the real defects in the change — verified against the code and graded high/medium/low by consequence — wherever in the review it said so, and is each thing it said true. This is what the review is built for; the lead number is problems found. How it differs from AACR-Bench's own metric: bench/aacr/METRICS.md._";

export function renderDefectReport(
  label: string,
  set: DefectSet,
  score: RunScore,
  extra: {
    tokensInPerPr?: number;
    tokensOutPerPr?: number;
    medianMinPerPr?: number;
    usdPerPr?: number;
    usdTotal?: number;
    usdSource?: string;
  } = {},
): string {
  const s = score;
  const sevRow = SEVERITIES.map((k) =>
    s.by_severity[k].total
      ? `${num(s.by_severity[k].credit)}/${s.by_severity[k].total} (${pct(s.by_severity[k].recall)})`
      : "—",
  );
  const c = s.comments;
  const lines = [
    `# Defect benchmark — ${label}`,
    "",
    DEFECT_REPORT_PREAMBLE,
    "",
    `- Ground truth: \`${set.set}\` defect set, version \`${set.version}\` — ${set.method || "verified real defects"}`,
    `- Judged ${s.judged}/${s.cases} cases, ${s.rounds} round(s)${s.errors ? `, ${s.errors} judge error(s) (counted as missed / unverifiable)` : ""}${s.stale ? `, ${s.stale} stale round(s) that judged an earlier review (not scored — re-run defect-judge --resume)` : ""}`,
    "",
    "## Did the review find the real defects?",
    "",
    "| Defects | Found | Partly | Missed | Recall | Weighted recall (high 3, medium 2, low 1) | High | Medium | Low |",
    "|---|---|---|---|---|---|---|---|---|",
    `| ${s.defects.total} | ${num(s.defects.found)} | ${num(s.defects.partial)} | ${num(s.defects.missed)} | ${pct(s.defects.recall)} | ${pct(s.weighted_recall)} | ${sevRow.join(" | ")} |`,
    "",
    "## Is what it says true?",
    "",
    "| Comments | Find a listed defect | Correct, worth raising | Correct, minor | Partly correct | Wrong | Unverifiable | Correct share | Worth-raising share | Wrong or overclaimed blockers |",
    "|---|---|---|---|---|---|---|---|---|---|",
    `| ${c.total} | ${num(c.finds_defect)} | ${num(c["correct-valuable"])} | ${num(c["correct-minor"])} | ${num(c["partly-correct"])} | ${num(c.incorrect)} | ${num(c.unverifiable)} | ${pct(c.correct_share)} | ${pct(c.valuable_share)} | ${num(c.wrong_blockers)} |`,
    "",
  ];
  if (extra.tokensInPerPr !== undefined)
    lines.push(
      "## Cost",
      "",
      "| $ / PR (pi's prices) | $ total | Input tokens / PR | Output tokens / PR | Median minutes / PR |",
      "|---|---|---|---|---|",
      `| ${extra.usdPerPr !== undefined ? `$${extra.usdPerPr.toFixed(3)}` : "—"} | ${extra.usdTotal !== undefined ? `$${extra.usdTotal.toFixed(2)}` : "—"} | ${Math.round((extra.tokensInPerPr ?? 0) / 1000)}k | ${((extra.tokensOutPerPr ?? 0) / 1000).toFixed(1)}k | ${(extra.medianMinPerPr ?? 0).toFixed(1)} |`,
      "",
      ...(extra.usdSource ? [extra.usdSource, ""] : []),
    );
  if (s.approved_over_missed_high.length)
    lines.push(
      `Approved despite a missed high-severity defect: ${s.approved_over_missed_high.join(", ")}`,
      "",
    );
  if (s.new_defect_candidates.length) {
    lines.push(
      "## Candidates for the ground truth",
      "",
      "Correct, valuable comments the judge says describe a real defect the list lacks. They are NOT added automatically — each must be verified against the code first.",
      "",
    );
    for (const x of s.new_defect_candidates)
      lines.push(`- ${x.instance_id} ${x.comment}: ${x.why}`);
    lines.push("");
  }
  return lines.join("\n");
}

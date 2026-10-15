// The posted review rendered from the findings record (`[review]
// render_outputs`).
//
// Without this lever a round ends with the session generating four files token
// by token: the inline-comments JSON, the review body, the findings record and
// the verdict. The first two restate the third — every posted comment is a
// `posted` entry of the record, and the body's sections are one bullet per
// posted entry — so with this lever the session writes the record ONCE, with
// the few posting fields only it can write (each posted entry's comment title
// and body, its side, a follower's lead, whether it goes inline), plus the
// plain opening paragraph and the lenses line, and this module renders the
// other two deterministically in the round template's format (step 6:
// opener → verdict line → lenses line → Blockers / Nits / Questions → For a
// human to double-check → overflow → details → footer; inline comments as
// `[tag] title`, body, `_severity · confidence · lens_`).
//
// Rendering never decides anything: the tag is the record's `posted_as` (the
// session's — the validator's — call), nothing is dropped, an inline anchor is
// whatever the record claims (posting validates it as before), and every
// problem the input has is returned rather than thrown, so a thin record still
// renders the review the record describes.
import { ASK_HUMAN_TAG, CHECK_THIS_TAG, DEFERRED_TAG, ordinaryPostTag } from "./severity.js";
import { postCheckRecord, recordNumber, type PostCheckMerge } from "./dedup.js";
import { findingMarker, findingRecordKey } from "./findingkey.js";
import {
  firstSentence as policyFirstSentence,
  isDefaultPosting,
  selectPosted,
  siteKey,
  type PolicyClass,
  type PostingPolicy,
  type WithholdWord,
} from "./postingpolicy.js";

/** The standard footer, word for word posting.ts `reviewFooter` (pinned equal
 * by tests/reviewrender.test.ts). Not imported: posting.ts is the recorded
 * unwired module of tests/fences-reachability.test.ts, and an import for one
 * string would make it read as live. */
export function renderedFooter(botLogin?: string): string {
  return (
    `_Automated review by \`${botLogin?.trim() || "the review bot"}\` (quickreview sandbox). ` +
    "Reply to any comment to discuss; ask for a human reviewer if you want this escalated._"
  );
}

/** GitHub's per-review inline cap (posting.ts INLINE_COMMENT_CAP). */
const INLINE_CAP = 50;

export interface RenderedComment {
  path: string;
  line: number;
  side: "RIGHT" | "LEFT";
  start_line?: number;
  body: string;
}

export interface RenderedReview {
  /** The review body (review.md). */
  body: string;
  /** The inline comments (comments.json), in the posting script's shape. */
  comments: RenderedComment[];
  /** Posted entries rendered into the body instead of inline. */
  in_body: number;
  /** What the record lacked; rendering went ahead with a fallback. */
  problems: string[];
}

type Tag = "blocker" | "question" | "nit" | "check this" | "ask your human" | "deferred";
const TAGS: readonly Tag[] = [
  "blocker",
  "question",
  "nit",
  "check this",
  "ask your human",
  "deferred",
];

interface Posted {
  id: string;
  /** The entry's `round_findings` key (src/findingkey.ts) — what a marker names. */
  recordKey: string;
  path: string | null;
  line: number | null;
  start_line: number | null;
  side: "RIGHT" | "LEFT";
  tag: Tag;
  /** For ask-your-human and deferred: the ordinary severity tag beside the
   * marker; otherwise the tag itself. */
  sevTag: "blocker" | "question" | "nit";
  title: string;
  body: string;
  severity: string | null;
  confidence: number | null;
  reachability: string | null;
  lens: string;
  /** A follower row of a root cause posted at several sites. */
  same_as: string | null;
  inline: boolean;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function firstSentence(text: string): string {
  const m = /^(.+?[.!?])(\s|$)/s.exec(text.trim());
  return (m ? m[1]! : text.trim()).replace(/\s+/g, " ");
}

/** The ordinary tag a posted entry is counted and posted under: its own
 * posting tag; `question` for `[check this]`; for `[ask your human]` and
 * `[deferred]` the tag its severity maps to (a question without one). */
function severityTagOf(
  tag: Tag,
  severity: string | null,
  confidence: number | null,
  reachability: string | null,
): "blocker" | "question" | "nit" {
  return ordinaryPostTag(tag, severity, confidence, reachability)!;
}

/** A findings-record entry's ordinary tag (`severityTagOf`), whichever route
 * renders it — null when its `posted_as` is outside the grammar. */
export function postedSeverityTag(
  raw: Record<string, unknown>,
): "blocker" | "question" | "nit" | null {
  const tag = (str(raw.posted_as) ?? "").toLowerCase().replace(/^\[|\]$/g, "") as Tag;
  if (!TAGS.includes(tag)) return null;
  return severityTagOf(tag, str(raw.severity), recordNumber(raw.confidence), str(raw.reachability));
}

function readPosted(
  raw: Record<string, unknown>,
  i: number,
  problems: string[],
  recordKey: string,
): Posted {
  const id = str(raw.id) ?? `#${i + 1}`;
  const rawTag = (str(raw.posted_as) ?? "").toLowerCase().replace(/^\[|\]$/g, "") as Tag;
  const tag: Tag = TAGS.includes(rawTag) ? rawTag : "question";
  if (!TAGS.includes(rawTag))
    problems.push(
      `${id}: posted_as ${JSON.stringify(raw.posted_as)} is outside the grammar — rendered as a question`,
    );
  const severity = str(raw.severity);
  const confidence = recordNumber(raw.confidence);
  const reachability = str(raw.reachability);
  const sevTag = severityTagOf(tag, severity, confidence, reachability);
  const reason = str(raw.reason) ?? "";
  const title = str(raw.title) ?? (reason ? firstSentence(reason) : "");
  if (!str(raw.title)) problems.push(`${id}: no title — the reason's first sentence stands in`);
  const body = str(raw.body) ?? reason;
  if (!str(raw.body)) problems.push(`${id}: no body — the reason stands in`);
  const line = recordNumber(raw.line);
  const start = recordNumber(raw.start_line);
  return {
    id,
    recordKey,
    path: str(raw.path),
    line,
    start_line: start !== null && line !== null && start < line ? start : null,
    side: str(raw.side)?.toUpperCase() === "LEFT" ? "LEFT" : "RIGHT",
    tag,
    sevTag,
    title,
    body,
    severity,
    confidence,
    reachability,
    lens: str(raw.lens) ?? "unknown",
    same_as: str(raw.same_as),
    inline: raw.inline !== false,
  };
}

function head(p: Posted): string {
  if (p.tag === "check this") return `${CHECK_THIS_TAG} ${p.title}`;
  if (p.tag === "ask your human") return `${ASK_HUMAN_TAG} [${p.sevTag}] ${p.title}`;
  if (p.tag === "deferred") return `${DEFERRED_TAG} [${p.sevTag}] ${p.title}`;
  return `[${p.tag}] ${p.title}`;
}

function trailer(p: Posted): string {
  const parts: string[] = [];
  if (p.severity) parts.push(p.severity);
  if (p.confidence !== null) parts.push(`confidence ${p.confidence.toFixed(2)}`);
  if (p.reachability && p.reachability !== "routine") parts.push(p.reachability);
  parts.push(`lens ${p.lens}`);
  return `_${parts.join(" · ")}_`;
}

/** One inline comment's text: `[tag] title`, the body, the trailer. */
function commentText(p: Posted): string {
  return `${head(p)}\n\n${p.body}\n\n${trailer(p)}`;
}

function ref(p: Posted): string {
  return p.path ? (p.line !== null ? `\`${p.path}:${p.line}\`` : `\`${p.path}\``) : "`(no file)`";
}

function bullet(p: Posted): string {
  const meta = [p.severity, p.confidence !== null ? p.confidence.toFixed(2) : null]
    .filter((x) => x !== null)
    .join("/");
  return `- ${ref(p)} — ${p.title} _(${meta ? `${meta}, ` : ""}${p.lens})_`;
}

function verdictLabel(v: string | null): string {
  return v === "APPROVE" ? "Approved" : v === "REQUEST_CHANGES" ? "Changes requested" : "Commented";
}

/** Render the review body and the inline comments from a findings record
 * (the session's JSON, parsed). Pure; never throws on a malformed record. */
export function renderReviewFromRecord(
  record: unknown,
  opts: {
    botLogin?: string;
    /** Fallbacks for a record that lacks them (the bench's outcome.json
     * carries the verdict and summary). The record's own values win. */
    verdict?: string | null;
    summary?: string | null;
    lensesApplied?: string | null;
    /** The profile's `[posting] body`: `verdict` renders the verdict line,
     * one sentence and a bullet per finding with no inline anchor. */
    bodyMode?: "full" | "verdict";
    /** Append the hidden `<!-- qcr:f=<round>:<key> -->` marker to
     * every inline comment, so the posted comment links back to its finding.
     * The live route only (src/reviewrendercli.ts): the bench never passes it,
     * so its outputs carry no markers. */
    findingMarkers?: { roundNo: number };
  } = {},
): RenderedReview {
  const problems: string[] = [];
  const given = (typeof record === "object" && record !== null ? record : {}) as Record<
    string,
    unknown
  >;
  const rec: Record<string, unknown> = {
    ...given,
    verdict: given.verdict ?? opts.verdict ?? null,
    summary: given.summary ?? opts.summary ?? null,
    lenses_applied: given.lenses_applied ?? opts.lensesApplied ?? null,
  };
  const entries = Array.isArray(rec.findings) ? (rec.findings as unknown[]) : [];
  if (!Array.isArray(rec.findings)) problems.push("the record has no findings array");
  const posted = entries
    // The index in the WHOLE findings array is what the record parser keys a
    // key-less entry by, so it is taken before the filter.
    .map((e, index) => ({ e, index }))
    .filter(
      (x): x is { e: Record<string, unknown>; index: number } =>
        typeof x.e === "object" &&
        x.e !== null &&
        str((x.e as Record<string, unknown>).disposition) === "posted",
    )
    .map(({ e, index }, i) => readPosted(e, i, problems, findingRecordKey(e, index)));
  const markers = opts.findingMarkers;

  // Inline: every posted entry with an anchor, unless the record put it in the
  // body; the first 50, the rest overflow to the body (round-first.md step 6).
  const comments: RenderedComment[] = [];
  const overflow: Array<{ p: Posted; why: string }> = [];
  for (const p of posted) {
    if (!p.inline || p.path === null || p.line === null) {
      overflow.push({
        p,
        why: p.path === null || p.line === null ? "no anchor" : "posted in the body",
      });
      continue;
    }
    if (comments.length >= INLINE_CAP) {
      overflow.push({ p, why: `over the ${INLINE_CAP}-inline-comment cap` });
      continue;
    }
    comments.push({
      path: p.path,
      line: p.line,
      side: p.side,
      ...(p.start_line !== null ? { start_line: p.start_line } : {}),
      body: markers
        ? `${commentText(p)}\n\n${findingMarker(markers.roundNo, p.recordKey)}`
        : commentText(p),
    });
  }

  // The verdict line and the sections count ROOT CAUSES: a follower row
  // (same_as) is posted inline but neither counted nor bulleted.
  const leads = posted.filter((p) => p.same_as === null);
  const of = (t: "blocker" | "nit" | "question") =>
    leads.filter((p) => p.tag !== "check this" && p.tag !== "deferred" && p.sevTag === t);
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const counts: string[] = [];
  if (of("blocker").length) counts.push(plural(of("blocker").length, "blocker"));
  if (of("nit").length) counts.push(plural(of("nit").length, "nit"));
  if (of("question").length) counts.push(plural(of("question").length, "question"));

  const verdict = str(rec.verdict);
  if (verdict !== "APPROVE" && verdict !== "REQUEST_CHANGES")
    problems.push(`verdict ${JSON.stringify(rec.verdict)} is neither APPROVE nor REQUEST_CHANGES`);
  const summary = str(rec.summary);
  if (!summary) problems.push("no summary — the body opens on the verdict line");
  const lensesLine = str(rec.lenses_applied);
  if (!lensesLine) problems.push("no lenses_applied — the posted lenses stand in");

  if (opts.bodyMode === "verdict") {
    const lines = [
      `**Verdict: ${verdictLabel(verdict)}** — ${counts.length ? counts.join(", ") : "no findings"}.`,
    ];
    const one = summary ? policyFirstSentence(summary) : "";
    if (one) lines.push("", one);
    if (overflow.length) lines.push("", ...overflow.map(({ p }) => `- ${ref(p)} — ${p.title}`));
    return { body: lines.join("\n") + "\n", comments, in_body: overflow.length, problems };
  }
  const out: string[] = [];
  if (summary) out.push(summary, "");
  out.push(
    `**Verdict: ${verdictLabel(verdict)}** — ${counts.length ? counts.join(", ") : "no findings"}.`,
    "",
    `_Lenses applied: ${lensesLine ?? ([...new Set(posted.map((p) => p.lens))].join(", ") || "none recorded")}._`,
  );
  const section = (title: string, items: string[]) => {
    if (items.length) out.push("", `### ${title}`, "", ...items);
  };
  section("Blockers", of("blocker").map(bullet));
  section("Nits", of("nit").map(bullet));
  section("Questions", of("question").map(bullet));
  section("Deferred", leads.filter((p) => p.tag === "deferred").map(bullet));
  section(
    "For a human to double-check",
    leads.filter((p) => p.tag === "check this").map((p) => `- ${ref(p)} — ${p.title}`),
  );
  section(
    "Additional findings (not posted inline)",
    overflow.map(
      ({ p, why }) => `- ${bullet(p).slice(2)} — _${why}_\n\n  ${p.body.replace(/\n/g, "\n  ")}`,
    ),
  );
  const details = str(rec.details);
  if (details) out.push("", details);
  out.push("", renderedFooter(opts.botLogin));
  return { body: out.join("\n") + "\n", comments, in_body: overflow.length, problems };
}

/** What a render route needs from the install's config — the ONE place both
 * routes (scripts/render-review.sh → src/reviewrendercli.ts, and the bench
 * runner) turn a config into render options, so they cannot drift. */
export interface PostedRenderConfig {
  review: { dedup_merge?: boolean };
  github?: { bot_login?: string };
  /** The profile's `[posting]` policy, overlaid on the config the same way
   * on both routes (wire.ts / the bench: `applyProfilePosting`). */
  posting?: PostingPolicy;
}

export interface PostedRenderOptions {
  botLogin?: string;
  verdict?: string | null;
  summary?: string | null;
  lensesApplied?: string | null;
  /** `[review] dedup_merge`: run the post-check (src/dedup.ts) first. */
  dedupMerge?: boolean;
  /** The profile's `[posting]` policy; absent or all-default ⇒ no cut. */
  policy?: PostingPolicy;
  /** The live route's hidden finding markers (see `renderReviewFromRecord`).
   * Never set by `postedRenderOptions`, so a caller that does not ask — the
   * bench — renders without them. */
  findingMarkers?: { roundNo: number };
}

export function postedRenderOptions(
  cfg: PostedRenderConfig,
  fallbacks: Pick<PostedRenderOptions, "verdict" | "summary" | "lensesApplied"> = {},
): PostedRenderOptions {
  return {
    ...(cfg.github?.bot_login ? { botLogin: cfg.github.bot_login } : {}),
    ...fallbacks,
    dedupMerge: cfg.review.dedup_merge === true,
    ...(isDefaultPosting(cfg.posting) ? {} : { policy: cfg.posting! }),
  };
}

/** A record entry's `posted_as` as the posting policy classes it. */
export function postedClassOf(postedAs: unknown): PolicyClass {
  const t = (typeof postedAs === "string" ? postedAs : "")
    .trim()
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  return t === "blocker" || t === "question" || t === "nit" ? t : "check";
}

/** Why a withheld entry is in the record and not on the PR. */
export const withheldReason = (word: WithholdWord): string =>
  `Withheld by this repo's posting policy (${word}); kept here, never posted.`;

/** A posted record entry made `withheld` by the posting policy, in place —
 * its tag kept as `withheld_as`, the word and the reason recorded — as every
 * route records it. */
export function markWithheld(entry: Record<string, unknown>, word: WithholdWord): void {
  entry.withheld_as = entry.posted_as;
  delete entry.posted_as;
  entry.disposition = "withheld";
  entry.word = word;
  entry.reason =
    `${withheldReason(word)} ${typeof entry.reason === "string" ? entry.reason : ""}`.trim();
}

export interface PolicyWithheld {
  id: string;
  word: WithholdWord;
  path: string | null;
  line: number | null;
  cls: PolicyClass;
  severity: string | null;
  title: string;
  /** Would it have posted inline (it carried an anchor and no `inline: false`)? */
  inline: boolean;
}

/**
 * The profile's `[posting]` cut over a findings record (src/postingpolicy.ts
 * `selectPosted`), applied by BOTH render routes — so the live shell route
 * enforces it too, not only the bench (src/bench/benchposting.ts, which the
 * bench still uses when it does not render). Items are the record's posted
 * entries in record order; a follower row (`same_as`) carries its lead's key,
 * so `repeat_sites = false` withholds it. No changed-line ranking: neither
 * route's render step holds the diff, so the two rank identically. Every cut
 * entry becomes `withheld` with its word — nothing is deleted.
 */
export function applyPostingPolicyToRecord(
  record: unknown,
  policy: PostingPolicy | undefined,
): { record: unknown; withheld: PolicyWithheld[] } {
  if (isDefaultPosting(policy) || typeof record !== "object" || record === null)
    return { record, withheld: [] };
  const rec = record as Record<string, unknown>;
  if (!Array.isArray(rec.findings)) return { record, withheld: [] };
  const entries = (rec.findings as unknown[]).map((e) =>
    typeof e === "object" && e !== null ? { ...(e as Record<string, unknown>) } : e,
  );
  const posted = entries.filter(
    (e): e is Record<string, unknown> =>
      typeof e === "object" &&
      e !== null &&
      (e as Record<string, unknown>).disposition === "posted",
  );
  const byId = new Map(posted.map((e) => [String(e.id ?? ""), e]));
  const titleOf = (e: Record<string, unknown>) =>
    typeof e.title === "string" && e.title.trim()
      ? e.title
      : typeof e.reason === "string"
        ? policyFirstSentence(e.reason)
        : "";
  const sel = selectPosted(
    posted,
    (e) => {
      const lead = typeof e.same_as === "string" ? byId.get(e.same_as) : undefined;
      return {
        cls: postedClassOf(e.posted_as),
        severity: typeof e.severity === "string" && e.severity.trim() ? e.severity.trim() : null,
        key: siteKey(titleOf(lead ?? e)),
      };
    },
    policy,
  );
  if (!sel.withheld.length) return { record, withheld: [] };
  const withheld: PolicyWithheld[] = [];
  for (const { item, word } of sel.withheld) {
    markWithheld(item, word);
    const line = typeof item.line === "number" ? item.line : null;
    const path = typeof item.path === "string" && item.path.trim() ? item.path : null;
    withheld.push({
      id: String(item.id ?? ""),
      word,
      path,
      line,
      cls: postedClassOf(item.withheld_as),
      severity:
        typeof item.severity === "string" && item.severity.trim() ? item.severity.trim() : null,
      title: titleOf(item),
      inline: path !== null && line !== null && item.inline !== false,
    });
  }
  return { record: { ...rec, findings: entries }, withheld };
}

/**
 * The render step both routes run (docs/duplicate-merge.md: the bench
 * matches a live round): the post-check over the record when
 * `dedupMerge` is on, then `renderReviewFromRecord`. Returns the record to
 * write back (the same object when the post-check merged nothing, or when it
 * is off) beside what to post.
 */
export function renderPostedReview(
  record: unknown,
  opts: PostedRenderOptions = {},
): {
  rendered: RenderedReview;
  record: unknown;
  merges: PostCheckMerge[];
  withheld: PolicyWithheld[];
} {
  const { dedupMerge, policy, ...renderOpts } = opts;
  const checked = dedupMerge ? postCheckRecord(record) : { record, merges: [] as PostCheckMerge[] };
  const cut = applyPostingPolicyToRecord(checked.record, policy);
  const rendered = renderReviewFromRecord(cut.record, {
    ...renderOpts,
    ...(policy?.body === "verdict" ? { bodyMode: "verdict" as const } : {}),
  });
  let out = cut.record;
  if ((checked.merges.length || cut.withheld.length) && typeof out === "object" && out !== null)
    out = { ...(out as Record<string, unknown>), comments_posted: rendered.comments.length };
  return { rendered, record: out, merges: checked.merges, withheld: cut.withheld };
}

/** The posting fields a rendered round's findings record carries, as the
 * round templates (`{{render_note}}`) and the bench appendix both state them. */
export const RENDER_RECORD_FIELDS = [
  "On every `posted` entry, besides the fields the record always carries:",
  "`title` (the comment's one-line title, no tag), `body` (the comment body",
  "exactly as it would be posted — a blocker consequence-first and",
  "self-sufficient — WITHOUT the tag line and WITHOUT the severity trailer;",
  "both are rendered from `posted_as`, `severity`, `confidence` and `lens`),",
  "`side` when it is `LEFT`, `start_line` for a multi-line anchor,",
  '`same_as: "<lead id>"` on a follower row of a root cause posted at',
  "several sites (it posts inline but is not counted twice), and",
  "`inline: false` for a finding that belongs in the body only. At the top",
  "level: `verdict`, `summary` (the plain opening paragraph), `lenses_applied`",
  "(the lenses line's text, raises and adds with their reasons) and, when you",
  "have any, `details` (the collapsible verification material, already",
  "wrapped in `<details>`).",
].join("\n");

/** The round prompt's `{{render_note}}` — "" unless the order says this
 * install renders its posted review (`[review] render_outputs`), so a round
 * order without the flag renders the template unchanged. Under the flag the
 * record already carries the verdict's `verdict`, `head_sha` and `summary`, so
 * the note also hands the verdict file to `scripts/commit-verdict.sh
 * --from-record` — the session neither retypes it nor reads the clock, which
 * would otherwise lengthen the round's serial tail. */
export function renderRenderNote(order: {
  render_outputs?: boolean;
  pr: number;
  round_no: number;
}): string {
  if (!order.render_outputs) return "";
  const n = order.pr;
  const k = order.round_no;
  return [
    "",
    "**Rendered posting — do not write the review body or the inline-comments",
    "JSON by hand.** This install renders both from the findings record. Before",
    `posting, write the findings record (step 7's shape) at \`state/findings/pr-${n}-round-${k}.json\``,
    "FIRST, with the posting fields below, then run",
    `\`bash scripts/render-review.sh ${n} ${k}\`: it writes`,
    `\`state/pr-${n}-round-${k}-review.md\` and \`state/pr-${n}-round-${k}-comments.json\``,
    "in this step's format (opener, verdict line, lenses line, sections,",
    "double-check items, overflow, footer; each inline comment as its tag line,",
    "body and trailer). Read what it prints, fix the record if it names a",
    "problem, re-run it, then post those two files exactly as this step says.",
    "In step 7 the findings record is then already written: correct",
    "`comments_posted` if fewer posted, then the ledger, then the verdict file.",
    "",
    RENDER_RECORD_FIELDS,
    "",
    "Only `posted` entries render. Every other disposition, and the record's",
    "`prior` array, is recorded and never rendered: a prior finding that is",
    "still open keeps its existing thread, so it is not a `posted` entry of",
    "this round — say so in `summary` or `details` when the body should.",
    "",
    "**The verdict file comes from the same record — do not retype it.** Put",
    "step 7's `passes` array in the record's top level too (with",
    "`approval_withheld: true` when the approval is withheld, and `sweep` /",
    "`escalations` when the verdict carries them). Then, after the ledger, the",
    `round's last action is \`scripts/commit-verdict.sh --from-record pr-${n}-round-${k}.json\`:`,
    "it builds the verdict file from the record's `verdict`, `head_sha`,",
    "`summary` and those fields, stamps `finished_at`, and publishes it — so you",
    "neither stage the verdict JSON nor look up the time. If it refuses, it names",
    "the missing field and publishes nothing: fix the record and run it again,",
    "or stage the verdict by hand as step 7 says. A `head_moved` outcome is",
    "always staged by hand.",
    "",
  ].join("\n");
}

// The learner's MINER: deterministic, daemon-side, no model in the loop —
// every human outcome the daemon already records becomes a CANDIDATE lesson
// for the EOD curator to adopt or decline.
//
// It reads both halves of the evidence — what humans pushed back on
// (suppression-shaped) and what the reviewer missed (recall-shaped) — from
// state.db and the base clone's git, and writes nothing a round or the bench
// sees.
//
// THE SOURCES, each a draft with a deterministic `ref` (the dedup key — a
// re-mine of the same event is the same row):
//
//   human fates (src/outcomes.ts)      one per finding CHAIN whose fate is
//       `refuted_conceded` (the bot conceded — after a human's reply, or on
//       its own re-check — dont-raise) or `upheld_after_reply` (a human
//       replied and the bot kept it standing — either way; `fateSummary`
//       says which the record supports). The chain's ROOT (its first posting) names the candidate,
//       so a reposting never mints a second one. The outcome capture
//       re-decides fates and may join a posting to an earlier chain later, so
//       every mine re-reads the undecided fate candidates
//       (`reviewFateCandidates`): a changed fate revises one in place, and one
//       whose fate is no longer a candidate's or whose root changed is
//       WITHDRAWN (recorded, never deleted). `fixed` and `open_at_close`
//       are not candidates on their own: they are the COUNTERWEIGHT each
//       cluster shows (`fixed_90d`, `ignored_90d`), so a dont-raise lesson is
//       never written over a class humans usually fix.
//   the feedback ledger                one per `feedback_signals` row: a
//       `[feedback]` comment and a deleted bot comment carry the finding they
//       answered (dont-raise); a set-aside review, a merge over a block and a
//       withdrawn trigger are WHOLE-REVIEW signals (`review.*` classes),
//       counted per review and never smeared over a lens.
//   tagged pr_comments                 a `[feedback]` comment a drain dropped
//       (the reconcile sweep keeps its text in `pr_comments` with `tagged = 1`
//       but deliberately never a ledger row) — the same ref as the ledger's,
//       so one comment is one candidate whichever route saw it.
//   recall (look-for)                  a human REQUEST_CHANGES review, or a
//       human root inline comment, on a PR whose standing bot verdict before
//       it was APPROVE (not the PR's author; a recheck's flip to
//       REQUEST_CHANGES ends the approval — `verdictAt`); and, for a
//       bot-approved PR that merged, a later commit within
//       `recall_window_days` that changed lines the PR had changed
//       (`WorktreeManager.postMergeTouches`, read-only git) — ONE candidate
//       per (PR, commit), its paths listed. "Lines the bot approved" is read
//       as "the PR's diff while the bot's approval stood": an inline comment
//       can only sit on the PR's diff, and a push after the approval is
//       audited by the recheck, which either upholds it (the approval then
//       covers the new head) or flips it (and the approval ends).
//   recheck (look-for)                 a post-approval recheck's APPROVE →
//       REQUEST_CHANGES REVERSAL (`recheck_request_changes`) — the REVIEWER's
//       own conclusion, never a person's: the one exception to "learned only
//       from people" (MANIFESTO.md), and only as a candidate the curator
//       decides. Unfiltered, flips crowd the packet (most offers were flips,
//       many reversing no approval at all, and human-sourced candidates queued
//       behind them). So, three gates (`mineRecheckFlips`): it counts only
//       when the bot's standing verdict just BEFORE the event was APPROVE
//       (`verdictAt`, the event itself excluded — a second decision file at
//       the same head finds the first flip standing); there is ONE candidate
//       per (PR, head) (a duplicate wake mints nothing); and the packet labels
//       the quote as the reviewer's own re-check conclusion (`quoteAuthor`)
//       and offers these only after every human-sourced and digest candidate
//       — and its clusters after every other cluster — in classes of their
//       own (`recheck.<top directory>`, `recheckClass`) that no human source
//       can produce, so a reversal never joins or counts toward a human
//       class's recurrence and coverage, and unrelated reversals are not one
//       bucket.
//   digest-backfill                    the "Learnings" bullets of the digests
//       written while memory refused every write (the window is
//       `lessons_digest_backfill_from`..`_to`) — candidates, never lessons
//       directly. The bullets are the OVERSEER's words (the review system's
//       own), and the packet labels them so (`quoteAuthor`), never as a
//       person's.
//
// CLASSES. Every candidate has a class slug the packet clusters by and a
// lesson names to cover it: a finding's `<lens>.<kind>` (`baseline.authz`), a
// miss's `missed.<top directory>`, a recheck reversal's `recheck.<top
// directory>` (a first segment no other source produces: no lens is named
// `recheck`), a whole-review signal's `review.<signal>`, a digest bullet's
// `<lens>.<type>`. Deterministic, header-safe (`LESSON_CLASS_RE`).
//
// Every quoted word rides in `quote`, capped at 400 characters, and is fenced
// as data when rendered (src/memory/datafence.ts); whose words they are is
// `quoteAuthor` (a person's, the review system's own digest bullet, or the
// reviewer's own re-check conclusion).
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isBotIdentity } from "../capture.js";
import { caseName } from "../cases.js";
import { FEEDBACK_PREFIX_RE } from "../feedback.js";
import { recheckHead12, recheckKeyPrefix } from "../findingkey.js";
import { canonicalLensIds, storedLensIds } from "../lensids.js";
import { cleanQuotedText } from "../memory/datafence.js";
import { LESSON_CLASS_RE } from "../memory/lessons.js";
import { carriedToRef } from "../outcomes.js";
import { tableExists, type StateStore } from "../state.js";
export { tableExists } from "../state.js";
import type { PostMergeScan } from "../worktrees.js";

/** Where a candidate came from. `recheck` is the one source that is the
 * REVIEWER's own conclusion — every other is a person's
 * outcome, or (`digest-backfill`) the overseer's lost digest bullets. */
export type CandidateSource =
  "fate" | "feedback" | "tagged-comment" | "recall" | "recheck" | "digest-backfill";

export type CandidateKind =
  | "refuted_conceded"
  | "upheld_after_reply"
  | "feedback_comment"
  | "bot_comment_deleted"
  | "review_set_aside"
  | "merged_over_block"
  | "trigger_withdrawn"
  | "tagged_comment"
  | "human_root_comment"
  | "human_request_changes"
  | "post_merge_change"
  | "recheck_flip"
  | "digest_learning";

/** Whose words a candidate's `quote` is: a person's (a reply, a comment, a
 * commit subject), the review system's own (a digest bullet the overseer
 * wrote), or the REVIEWER's own re-check conclusion (its reason for
 * reversing its own approval). The packet labels them — the curator
 * must never read the bot's own conclusion as a human's evidence. */
export function quoteAuthor(kind: CandidateKind): "person" | "review-system" | "reviewer-recheck" {
  if (kind === "digest_learning") return "review-system";
  if (kind === "recheck_flip") return "reviewer-recheck";
  return "person";
}

/** Which way a lesson from this evidence would point. `review` — a
 * whole-review signal (no lens, no finding); `ops` — about the review
 * system, not the code. */
export type Polarity = "look-for" | "dont-raise" | "either" | "review" | "ops";

export interface CandidateDraft {
  ref: string;
  source: CandidateSource;
  kind: CandidateKind;
  polarity: Polarity;
  class: string;
  lens_ids: string[];
  pr: number | null;
  round_no: number | null;
  finding_key: string | null;
  path: string | null;
  line: number | null;
  /** One daemon-written line. */
  summary: string;
  /** Words another person wrote (a reply, a comment, a commit subject, a
   * digest bullet), at most `QUOTE_CHARS`; fenced as data when rendered. */
  quote: string | null;
  evidence: string[];
  /** When the underlying event happened (recurrence counts by this). */
  occurred_at: string;
}

/** Characters of quoted text a candidate keeps. */
export const QUOTE_CHARS = 400;

const DAY_MS = 86_400_000;

// ---- classes ----------------------------------------------------------------

/** One class segment: lowercase alphanumerics and dashes, at most 40. */
export function slugPart(s: string | null | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

function safeClass(c: string, fallback: string): string {
  return LESSON_CLASS_RE.test(c) ? c : fallback;
}

/** A finding's class: `<first lens without pass->.<kind>`, `review` when the
 * finding names no known lens, `general` when it carries no kind. */
export function findingClass(lensIds: readonly string[], kind: string | null | undefined): string {
  const lens = slugPart((lensIds[0] ?? "").replace(/^pass-/, "")) || "review";
  const k = slugPart(kind) || "general";
  return safeClass(`${lens}.${k}`, "review.general");
}

/** The area slug a path clusters under: its top directory, `root` for a
 * file at the root (or a top directory that slugs to nothing). */
function topDirSlug(path: string): string {
  return (path.includes("/") ? slugPart(path.split("/")[0]) : "") || "root";
}

/** A miss's class: `missed.<top directory>` (`missed.root` for a file at the
 * root, `missed.review` with no path). */
export function missedClass(path: string | null | undefined): string {
  if (!path) return "missed.review";
  return safeClass(`missed.${topDirSlug(path)}`, "missed.review");
}

/** A recheck REVERSAL's class: `recheck.<top directory>` of
 * the first anchor its findings record names (`recheck.root` for a file at
 * the root, `recheck.review` with no record). The `recheck.` first segment is
 * reserved to this source — `missedClass` writes `missed.`, a finding's and a
 * digest bullet's first segment is a known lens (none is named `recheck`) or
 * `review`/`feedback`/`digest` — so the reviewer's own reversals never share
 * a cluster, a recurrence count or a covering lesson with a class human
 * evidence built (a reviewed repo's `recheck/` directory included), and
 * reversals in unrelated areas are not one bucket a single lesson "covers". */
export function recheckClass(path: string | null | undefined): string {
  if (!path) return "recheck.review";
  return safeClass(`recheck.${topDirSlug(path)}`, "recheck.review");
}

// ---- small helpers ------------------------------------------------------------

function sha16(s: string): string {
  return createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex").slice(0, 16);
}

/** Another person's words, cleaned of control bytes and cut to QUOTE_CHARS. */
export function quoteOf(text: string | null | undefined): string | null {
  if (typeof text !== "string") return null;
  const t = cleanQuotedText(text);
  if (t === "") return null;
  return t.length > QUOTE_CHARS ? `${t.slice(0, QUOTE_CHARS - 1)}…` : t;
}

/** A daemon-written line: one line, control bytes gone, capped. */
function oneLine(s: string, cap = 300): string {
  const t = s
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > cap ? `${t.slice(0, cap - 1)}…` : t;
}

/** A finding's canonical lens ids: the outcome capture's `lens_ids` column, else parsed from
 * the raw `lens` (a row the boot has not filled yet). */
export function lensIdsOf(
  raw: string | null | undefined,
  lensText: string | null | undefined,
): string[] {
  return storedLensIds(raw) ?? canonicalLensIds(lensText ?? "");
}

interface FindingFacts {
  round_no: number;
  finding_key: string;
  lens: string;
  lens_ids: string | null;
  kind: string | null;
  severity: string | null;
  posted_as: string | null;
  path: string | null;
  line: number | null;
  title: string | null;
}

function findingRow(
  store: StateStore,
  pr: number,
  roundNo: number,
  key: string,
): FindingFacts | undefined {
  return store.db
    .prepare(
      `SELECT round_no, finding_key, lens, lens_ids, kind, severity, posted_as, path, line, title
         FROM round_findings WHERE pr = ? AND round_no = ? AND finding_key = ?`,
    )
    .get(pr, roundNo, key) as FindingFacts | undefined;
}

/** The finding a bot comment carried (the outcome capture's link), when known. */
function findingOfComment(
  store: StateStore,
  pr: number,
  commentId: number | null,
): FindingFacts | undefined {
  if (commentId === null || !tableExists(store, "finding_comments")) return undefined;
  const link = store.db
    .prepare(
      "SELECT round_no, finding_key FROM finding_comments WHERE comment_id = ? AND pr = ? AND finding_key IS NOT NULL",
    )
    .get(commentId, pr) as { round_no: number; finding_key: string } | undefined;
  return link ? findingRow(store, pr, link.round_no, link.finding_key) : undefined;
}

/** A PR-chosen file path in a daemon-written line: one line, no control
 * byte, no backtick, code-quoted — it sits OUTSIDE the data fences, so a
 * crafted file name must not read as prose. */
export function pathText(path: string): string {
  return `\`${oneLine(path, 200).replace(/`/g, "'")}\``;
}

function where(f: { path: string | null; line: number | null }): string {
  if (!f.path) return "";
  return ` at ${pathText(f.path)}${f.line !== null ? `:${f.line}` : ""}`;
}

function findingPhrase(f: FindingFacts): string {
  const lens = lensIdsOf(f.lens_ids, f.lens)[0] ?? (f.lens || "no lens");
  const tag = [f.severity, f.posted_as].filter(Boolean).join(" ");
  return `${lens} finding${f.title ? ` "${oneLine(f.title, 120)}"` : ""}${tag ? ` (${tag})` : ""}${where(f)}`;
}

/** The PR's author, when the record knows it. */
function prAuthor(store: StateStore, pr: number): string | null {
  const a = store.getPr(pr)?.author;
  if (a) return a;
  if (!tableExists(store, "backfill_pr_meta")) return null;
  const row = store.db.prepare("SELECT author FROM backfill_pr_meta WHERE pr = ?").get(pr) as
    { author: string } | undefined;
  return row?.author || null;
}

/** The bot's verdict standing at `atIso` on `pr` — the latest
 * `verdict_applied` at or before it, or a post-approval recheck's flip
 * (`recheck_request_changes`, which posts REQUEST_CHANGES without a
 * `verdict_applied` of its own) when that came later — or null when none had
 * been applied. A human comment after a flip is not "after the bot approved",
 * and a PR merged after one was not bot-approved at the merge.
 *
 * `beforeEventId` reads the verdict standing just BEFORE one event of the
 * events table (a recheck flip is judged by what stood before IT — the
 * flip itself, and anything logged after it in the same millisecond, never
 * count). */
export function verdictAt(
  store: StateStore,
  pr: number,
  atIso: string,
  opts: { beforeEventId?: number } = {},
): string | null {
  // The events table stamps `toISOString()`; GitHub's own times carry no
  // milliseconds. Compare like with like.
  const t = Date.parse(atIso);
  if (Number.isFinite(t)) atIso = new Date(t).toISOString();
  const before = opts.beforeEventId ?? Number.MAX_SAFE_INTEGER;
  const row = store.db
    .prepare(
      `SELECT kind, json_extract(payload, '$.verdict') AS verdict FROM events
        WHERE kind IN ('verdict_applied', 'recheck_request_changes') AND pr = ? AND ts <= ? AND id < ?
        ORDER BY id DESC LIMIT 1`,
    )
    .get(pr, atIso, before) as { kind: string; verdict: string | null } | undefined;
  if (row?.kind === "recheck_request_changes") return "REQUEST_CHANGES";
  return row?.verdict ?? null;
}

// ---- 1. human fates -------------------------------------------------------------

const CANDIDATE_FATES = ["refuted_conceded", "upheld_after_reply"] as const;

interface OutcomeRow {
  pr: number;
  round_no: number;
  finding_key: string;
  comment_id: number | null;
  fate: string;
  basis: string | null;
  decided_at: string | null;
  human_replies?: number;
  carried_to: string | null;
  fate_changed_at: string;
}

/** The chain roots of a PR's outcomes and the fate each chain reads (the
 * outcome capture carries a reposted finding: `carried_to` = `<round>:<key>` on the earlier
 * row). */
export function chainRoots(
  rows: readonly OutcomeRow[],
): Array<{ root: OutcomeRow; end: OutcomeRow }> {
  const byKey = new Map(rows.map((r) => [carriedToRef(r.round_no, r.finding_key), r]));
  const pointed = new Set(rows.map((r) => r.carried_to).filter((c): c is string => !!c));
  const out: Array<{ root: OutcomeRow; end: OutcomeRow }> = [];
  for (const r of rows) {
    if (pointed.has(carriedToRef(r.round_no, r.finding_key))) continue;
    let end = r;
    const seen = new Set<string>();
    while (end.carried_to && byKey.has(end.carried_to) && !seen.has(end.carried_to)) {
      seen.add(end.carried_to);
      end = byKey.get(end.carried_to)!;
    }
    out.push({ root: r, end });
  }
  return out;
}

/** The newest human reply in a bot comment's thread, when captured — newest
 * by when it was written (a reply the sweep backfilled late is captured after
 * newer ones), its capture time when GitHub gave none, the row id last. */
function latestReply(store: StateStore, pr: number, commentId: number | null): string | null {
  if (commentId === null) return null;
  const row = store.db
    .prepare(
      `SELECT body FROM pr_comments WHERE pr = ? AND (in_reply_to_id = ? OR thread_id = ?) AND comment_id <> ?
        ORDER BY COALESCE(created_at, captured_at) DESC, id DESC LIMIT 1`,
    )
    .get(pr, commentId, commentId, commentId) as { body: string } | undefined;
  return row?.body ?? null;
}

function isCandidateFate(fate: string): boolean {
  return (CANDIDATE_FATES as readonly string[]).includes(fate);
}

function outcomeRows(store: StateStore, pr: number): OutcomeRow[] {
  return store.db
    .prepare("SELECT * FROM finding_outcomes WHERE pr = ? ORDER BY round_no, finding_key")
    .all(pr) as OutcomeRow[];
}

/** Did a human reply anywhere along the chain from `root` to `end`? */
function chainHasHumanReply(rows: readonly OutcomeRow[], root: OutcomeRow): boolean {
  const byKey = new Map(rows.map((r) => [carriedToRef(r.round_no, r.finding_key), r]));
  const seen = new Set<string>();
  let at: OutcomeRow | undefined = root;
  while (at) {
    const k = carriedToRef(at.round_no, at.finding_key);
    if (seen.has(k)) break;
    seen.add(k);
    if ((at.human_replies ?? 0) > 0) return true;
    at = at.carried_to ? byKey.get(at.carried_to) : undefined;
  }
  return false;
}

/**
 * What the fate says happened, in words the record supports. A refutation
 * with no human reply on the chain is the REVIEWER's own concession on
 * re-check (basis `conceded_unchanged`), never "a human refuted it"; an
 * upheld fate is a human reply the bot kept standing — the record shows a
 * reply, not that it was pushback (many such replies say "Fixed"/"Done").
 */
export function fateSummary(fate: string, humanReplied: boolean): string {
  if (fate === "refuted_conceded")
    return humanReplied
      ? "a human refuted it and the bot conceded"
      : "the reviewer conceded it on re-check (no human reply recorded)";
  return "a human replied and the bot kept it standing";
}

/** The candidate of one finding chain, named by its root, read from its END's
 * fate (the chain's latest posting is the one humans answered last). */
function fateDraft(
  store: StateStore,
  pr: number,
  root: OutcomeRow,
  end: OutcomeRow,
  rows: readonly OutcomeRow[] = [root, end],
): CandidateDraft {
  const at = end.decided_at ?? end.fate_changed_at;
  const f = findingRow(store, pr, root.round_no, root.finding_key);
  const lensIds = f ? lensIdsOf(f.lens_ids, f.lens) : [];
  const refuted = end.fate === "refuted_conceded";
  const caseRef = caseName(pr, root.round_no, root.finding_key);
  return {
    ref: `fate:${pr}:${root.round_no}:${sha16(root.finding_key)}`,
    source: "fate",
    kind: end.fate as CandidateKind,
    polarity: refuted ? "dont-raise" : "either",
    class: findingClass(lensIds, f?.kind),
    lens_ids: lensIds,
    pr,
    round_no: root.round_no,
    finding_key: root.finding_key,
    path: f?.path ?? null,
    line: f?.line ?? null,
    summary: oneLine(
      `PR #${pr}: ${f ? findingPhrase(f) : `finding ${root.finding_key}`} — ${fateSummary(
        end.fate,
        chainHasHumanReply(rows, root),
      )}${end.basis ? ` (${end.basis})` : ""}`,
    ),
    quote: quoteOf(latestReply(store, pr, end.comment_id ?? root.comment_id)),
    evidence: [
      `pr:${pr}`,
      `case:${caseRef}`,
      ...(root.comment_id !== null ? [`comment:${root.comment_id}`] : []),
    ],
    occurred_at: at,
  };
}

export function mineFates(store: StateStore, sinceIso: string): CandidateDraft[] {
  if (!tableExists(store, "finding_outcomes")) return [];
  const prs = (
    store.db
      .prepare(
        `SELECT DISTINCT pr FROM finding_outcomes
          WHERE fate IN (${CANDIDATE_FATES.map(() => "?").join(", ")}) AND COALESCE(decided_at, fate_changed_at) >= ?`,
      )
      .all(...CANDIDATE_FATES, sinceIso) as Array<{ pr: number }>
  ).map((r) => r.pr);
  const out: CandidateDraft[] = [];
  for (const pr of prs) {
    const rows = outcomeRows(store, pr);
    for (const { root, end } of chainRoots(rows)) {
      if (!isCandidateFate(end.fate)) continue;
      const at = end.decided_at ?? end.fate_changed_at;
      if (at < sinceIso) continue;
      out.push(fateDraft(store, pr, root, end, rows));
    }
  }
  return out;
}

/** What a fate candidate minted earlier reads NOW: the outcome capture re-decides a fate on
 * every capture (the latest decisive evidence wins) and a posting may join an
 * earlier chain later, so a candidate is never written once and trusted. */
export type FateReview = { kind: "current"; draft: CandidateDraft } | { kind: "gone"; why: string };

/**
 * Re-read each fate candidate against the outcomes as they stand: `current`
 * (its chain still has this root and a candidate fate — the draft as it
 * would be minted today, the horizon not applied) or `gone` (the fate is no
 * longer a candidate fate, the posting joined an earlier chain, or its row is
 * gone). Candidates missing a PR, round or key are not judged.
 */
export function reviewFateCandidates(
  store: StateStore,
  cands: ReadonlyArray<{
    id: number;
    pr: number | null;
    round_no: number | null;
    finding_key: string | null;
  }>,
): Map<number, FateReview> {
  const out = new Map<number, FateReview>();
  if (!tableExists(store, "finding_outcomes")) return out;
  const chainsOf = new Map<number, { rows: OutcomeRow[]; chains: ReturnType<typeof chainRoots> }>();
  for (const c of cands) {
    if (c.pr === null || c.round_no === null || c.finding_key === null) continue;
    let entry = chainsOf.get(c.pr);
    if (!entry) {
      const rows = outcomeRows(store, c.pr);
      entry = { rows, chains: chainRoots(rows) };
      chainsOf.set(c.pr, entry);
    }
    const key = carriedToRef(c.round_no, c.finding_key);
    const chain = entry.chains.find(
      (ch) => carriedToRef(ch.root.round_no, ch.root.finding_key) === key,
    );
    if (chain) {
      out.set(
        c.id,
        isCandidateFate(chain.end.fate)
          ? { kind: "current", draft: fateDraft(store, c.pr, chain.root, chain.end, entry.rows) }
          : { kind: "gone", why: `its fate is now ${chain.end.fate}` },
      );
      continue;
    }
    if (!entry.rows.some((r) => carriedToRef(r.round_no, r.finding_key) === key)) {
      out.set(c.id, { kind: "gone", why: "its finding has no outcome row any more" });
      continue;
    }
    // Not a root any more: some earlier posting carries to it.
    const byKey = new Map(entry.rows.map((r) => [carriedToRef(r.round_no, r.finding_key), r]));
    const holder = entry.chains.find((ch) => {
      let at: OutcomeRow | undefined = ch.root;
      const seen = new Set<string>();
      while (at) {
        const k = carriedToRef(at.round_no, at.finding_key);
        if (k === key) return true;
        if (seen.has(k) || !at.carried_to) return false;
        seen.add(k);
        at = byKey.get(at.carried_to);
      }
      return false;
    });
    out.set(c.id, {
      kind: "gone",
      why: holder
        ? `it joined the chain first posted in round ${holder.root.round_no}, whose candidate stands for it`
        : "it is no longer the root of a finding chain",
    });
  }
  return out;
}

// ---- 2. the feedback ledger, and the [feedback] comments a drain dropped -------

interface SignalRow {
  id: number;
  kind: string;
  pr: number;
  comment_id: number | null;
  review_id: number | null;
  in_reply_to_id: number | null;
  scope: string;
  author: string | null;
  body: string | null;
  created_at: string;
}

/** The ONE ref of a `[feedback]` comment, whichever route recorded it. */
export function feedbackCommentRef(scope: string, commentId: number): string {
  return `feedback-comment:${scope || "comment"}:${commentId}`;
}

function feedbackCommentDraft(
  store: StateStore,
  c: {
    kind: "feedback_comment" | "tagged_comment";
    pr: number;
    scope: string;
    comment_id: number;
    in_reply_to_id: number | null;
    body: string | null;
    at: string;
  },
): CandidateDraft {
  const f = findingOfComment(store, c.pr, c.in_reply_to_id);
  const lensIds = f ? lensIdsOf(f.lens_ids, f.lens) : [];
  return {
    ref: feedbackCommentRef(c.scope, c.comment_id),
    source: c.kind === "feedback_comment" ? "feedback" : "tagged-comment",
    kind: c.kind,
    polarity: "dont-raise",
    class: f ? findingClass(lensIds, f.kind) : "feedback.general",
    lens_ids: lensIds,
    pr: c.pr,
    round_no: f?.round_no ?? null,
    finding_key: f?.finding_key ?? null,
    path: f?.path ?? null,
    line: f?.line ?? null,
    summary: oneLine(
      `PR #${c.pr}: a human [feedback] comment${f ? ` on the ${findingPhrase(f)}` : c.in_reply_to_id !== null ? ` replying to bot comment ${c.in_reply_to_id}` : ""}${
        c.kind === "tagged_comment"
          ? " (dropped during a drain; recovered by the comment sweep)"
          : ""
      }`,
    ),
    quote: quoteOf((c.body ?? "").replace(FEEDBACK_PREFIX_RE, "").replace(/^\s+/, "")),
    evidence: [
      `pr:${c.pr}`,
      // A review body's id is a review's, never a comment's.
      `${c.scope === "review" ? "review" : "comment"}:${c.comment_id}`,
      ...(c.in_reply_to_id !== null ? [`comment:${c.in_reply_to_id}`] : []),
    ],
    occurred_at: c.at,
  };
}

export function mineFeedback(store: StateStore, sinceIso: string): CandidateDraft[] {
  const rows = store.db
    .prepare("SELECT * FROM feedback_signals WHERE created_at >= ? ORDER BY id")
    .all(sinceIso) as SignalRow[];
  const out: CandidateDraft[] = [];
  for (const s of rows) {
    switch (s.kind) {
      case "feedback_comment":
        if (s.comment_id === null) break;
        out.push(
          feedbackCommentDraft(store, {
            kind: "feedback_comment",
            pr: s.pr,
            scope: s.scope,
            comment_id: s.comment_id,
            in_reply_to_id: s.in_reply_to_id,
            body: s.body,
            at: s.created_at,
          }),
        );
        break;
      case "bot_comment_deleted": {
        const f = findingOfComment(store, s.pr, s.comment_id);
        const lensIds = f ? lensIdsOf(f.lens_ids, f.lens) : [];
        out.push({
          ref: `feedback:${s.id}`,
          source: "feedback",
          kind: "bot_comment_deleted",
          polarity: "dont-raise",
          class: f ? findingClass(lensIds, f.kind) : "feedback.deleted",
          lens_ids: lensIds,
          pr: s.pr,
          round_no: f?.round_no ?? null,
          finding_key: f?.finding_key ?? null,
          path: f?.path ?? null,
          line: f?.line ?? null,
          summary: oneLine(
            `PR #${s.pr}: a human deleted bot comment ${s.comment_id ?? "?"}${f ? ` (the ${findingPhrase(f)})` : ""}`,
          ),
          quote: null,
          evidence: [`pr:${s.pr}`, ...(s.comment_id !== null ? [`comment:${s.comment_id}`] : [])],
          occurred_at: s.created_at,
        });
        break;
      }
      case "review_set_aside":
      case "merged_over_block":
      case "trigger_withdrawn": {
        const what =
          s.kind === "review_set_aside"
            ? `bot review ${s.review_id ?? "?"} was dismissed (GitHub's own stale-review dismissal is filtered only heuristically)`
            : s.kind === "merged_over_block"
              ? "the PR merged while the bot's REQUEST_CHANGES stood (low-weight: branch protection unknown)"
              : "the review trigger was withdrawn before the review completed";
        out.push({
          ref: `feedback:${s.id}`,
          source: "feedback",
          kind: s.kind,
          polarity: "review",
          class:
            s.kind === "review_set_aside"
              ? "review.set-aside"
              : s.kind === "merged_over_block"
                ? "review.merged-over-block"
                : "review.trigger-withdrawn",
          lens_ids: [],
          pr: s.pr,
          round_no: null,
          finding_key: null,
          path: null,
          line: null,
          summary: oneLine(`PR #${s.pr}: ${what} — a whole-review signal, never one finding's`),
          quote: null,
          evidence: [`pr:${s.pr}`, ...(s.review_id !== null ? [`review:${s.review_id}`] : [])],
          occurred_at: s.created_at,
        });
        break;
      }
      default:
        break;
    }
  }
  return out;
}

export function mineTaggedComments(store: StateStore, sinceIso: string): CandidateDraft[] {
  const rows = store.db
    .prepare(
      `SELECT pr, source, comment_id, in_reply_to_id, body, created_at, captured_at FROM pr_comments
        WHERE tagged = 1 AND captured_at >= ? ORDER BY id`,
    )
    .all(sinceIso) as Array<{
    pr: number;
    source: string;
    comment_id: number;
    in_reply_to_id: number | null;
    body: string;
    created_at: string | null;
    captured_at: string;
  }>;
  return rows.map((c) =>
    feedbackCommentDraft(store, {
      kind: "tagged_comment",
      pr: c.pr,
      scope: c.source,
      comment_id: c.comment_id,
      in_reply_to_id: c.in_reply_to_id,
      body: c.body,
      at: c.created_at ?? c.captured_at,
    }),
  );
}

// ---- 3. recall: what a human found on lines the bot approved -------------------

export function mineHumanRecall(
  store: StateStore,
  sinceIso: string,
  botLogin: string,
): CandidateDraft[] {
  const rows = store.db
    .prepare(
      `SELECT pr, source, comment_id, in_reply_to_id, author, author_type, path, line, body,
              created_at, captured_at, review_state
         FROM pr_comments
        WHERE captured_at >= ? AND tagged = 0
          AND ((source = 'review_comment' AND in_reply_to_id IS NULL)
               OR (source = 'review' AND review_state = 'changes_requested'))
        ORDER BY id`,
    )
    .all(sinceIso) as Array<{
    pr: number;
    source: string;
    comment_id: number;
    in_reply_to_id: number | null;
    author: string;
    author_type: string;
    path: string | null;
    line: number | null;
    body: string;
    created_at: string | null;
    captured_at: string;
    review_state: string | null;
  }>;
  const out: CandidateDraft[] = [];
  for (const c of rows) {
    if (isBotIdentity(c.author, c.author_type, botLogin)) continue;
    const author = prAuthor(store, c.pr);
    // Unknown author: kept (a reviewer's comment must not be lost to a
    // missing record); the PR's own author commenting is a note, not a miss.
    if (author !== null && author === c.author) continue;
    const at = c.created_at ?? c.captured_at;
    if (verdictAt(store, c.pr, at) !== "APPROVE") continue;
    const rc = c.source === "review";
    out.push({
      ref: rc ? `human-rc:${c.comment_id}` : `human-root:${c.comment_id}`,
      source: "recall",
      kind: rc ? "human_request_changes" : "human_root_comment",
      polarity: "look-for",
      class: rc ? "missed.review" : missedClass(c.path),
      lens_ids: [],
      pr: c.pr,
      round_no: null,
      finding_key: null,
      path: c.path,
      line: c.line,
      summary: oneLine(
        rc
          ? `PR #${c.pr}: another human reviewer REQUESTED CHANGES after the bot approved`
          : `PR #${c.pr}: another human reviewer raised something${where(c)} after the bot approved`,
      ),
      quote: quoteOf(c.body),
      evidence: [`pr:${c.pr}`, `${rc ? "review" : "comment"}:${c.comment_id}`],
      occurred_at: at,
    });
  }
  return out;
}

// ---- 3b. recheck reversals: the REVIEWER's own conclusion ----------------------

/** A recheck head as the recheck's own key (`recheckHead12`). Null for
 * anything that is not a sha. */
export function recheckHeadKey(head: unknown): string | null {
  if (typeof head !== "string" || !/^[0-9a-f]{7,40}$/i.test(head)) return null;
  return recheckHead12(head);
}

/** The posted rows of the recheck's own findings record at that head (the
 * reasoning behind the reversal) — its lens ids and first anchor.
 * Empty when it wrote none, or the record cannot be read. */
function recheckFindings(
  store: StateStore,
  pr: number,
  head12: string,
): { lens_ids: string[]; path: string | null; line: number | null } {
  const prefix = recheckKeyPrefix(head12);
  try {
    const rows = store.db
      .prepare(
        `SELECT lens, lens_ids, path, line FROM round_findings
          WHERE pr = ? AND substr(finding_key, 1, ?) = ? AND disposition = 'posted' ORDER BY id`,
      )
      .all(pr, prefix.length, prefix) as Array<{
      lens: string;
      lens_ids: string | null;
      path: string | null;
      line: number | null;
    }>;
    const lens = [...new Set(rows.flatMap((r) => lensIdsOf(r.lens_ids, r.lens)))];
    const anchored = rows.find((r) => r.path);
    return { lens_ids: lens, path: anchored?.path ?? null, line: anchored?.line ?? null };
  } catch {
    return { lens_ids: [], path: null, line: null };
  }
}

/**
 * A post-approval recheck's APPROVE → REQUEST_CHANGES REVERSAL is a look-for
 * CANDIDATE — the reviewer's own conclusion, so never a lesson on its own and
 * never a person's evidence. Three gates:
 *   * the bot's standing verdict just BEFORE the event was APPROVE
 *     (`verdictAt`, the event itself excluded): a decision "reversing" a
 *     verdict that already stood at REQUEST_CHANGES — a second decision file,
 *     a duplicate wake after the first flip — reverses nothing;
 *   * ONE candidate per (PR, head) — `recheck-flip:<pr>:<head12>`, the
 *     recheck's own head key — so duplicate wake events at one head mint
 *     nothing, whichever of them passed the gate first;
 *   * worded as the reviewer's re-check in the summary, and the quote (its
 *     own reason) labelled as such in the packet (`quoteAuthor`).
 * Lens and anchor come from the recheck's own findings record when it wrote
 * one; the class is `recheckClass` of that anchor — a class no human source
 * produces, so a reversal never joins, or counts toward, a class human
 * evidence built.
 */
export function mineRecheckFlips(store: StateStore, sinceIso: string): CandidateDraft[] {
  const rows = store.db
    .prepare(
      `SELECT id, ts, pr, payload FROM events WHERE kind = 'recheck_request_changes' AND ts >= ? ORDER BY id`,
    )
    .all(sinceIso) as Array<{ id: number; ts: string; pr: number | null; payload: string | null }>;
  const out: CandidateDraft[] = [];
  const minted = new Set<string>();
  for (const e of rows) {
    if (e.pr === null) continue;
    let head: unknown = null;
    let reason: unknown = null;
    try {
      const p = JSON.parse(e.payload ?? "{}") as { head_sha?: unknown; reason?: unknown };
      head = p.head_sha;
      reason = p.reason;
    } catch {
      /* no detail: no head, so no (PR, head) key — below */
    }
    // No head, no key: a reversal that cannot be told apart from its own
    // duplicates is not minted at all.
    const head12 = recheckHeadKey(head);
    if (head12 === null) continue;
    const ref = `recheck-flip:${e.pr}:${head12}`;
    if (minted.has(ref)) continue;
    if (verdictAt(store, e.pr, e.ts, { beforeEventId: e.id }) !== "APPROVE") continue;
    minted.add(ref);
    const sha = head as string;
    const f = recheckFindings(store, e.pr, head12);
    out.push({
      ref,
      source: "recheck",
      kind: "recheck_flip",
      polarity: "look-for",
      class: recheckClass(f.path),
      lens_ids: f.lens_ids,
      pr: e.pr,
      round_no: null,
      finding_key: null,
      path: f.path,
      line: f.line,
      summary: oneLine(
        `PR #${e.pr}: the REVIEWER's own post-approval re-check reversed its APPROVE to REQUEST_CHANGES at ${sha.slice(0, 7)}${f.path ? `, first${where(f)}` : ""} — the reviewer's conclusion, no person's; was the miss in the code it had approved?`,
      ),
      quote: quoteOf(typeof reason === "string" ? reason : null),
      evidence: [`pr:${e.pr}`, `commit:${sha.toLowerCase()}`],
      occurred_at: e.ts,
    });
  }
  return out;
}

/** The reader post-merge recall needs (`WorktreeManager`). */
export interface RecallGit {
  postMergeTouches(q: {
    pr: number;
    baseRef: string;
    mergedAt: string;
    windowDays: number;
  }): Promise<PostMergeScan | null>;
}

/** How many merged PRs one scan pass reads with git, how long it may take,
 * how often an in-window PR is re-read, and how often an unknown answer is
 * retried before the PR is given up on. The learner runs a pass on EVERY
 * 5-minute tick (`prsPerTick`) as well as in the day's mine (`prsPerMine`),
 * so it keeps up with the day's bot-approved merges and drains a backlog. */
export const RECALL_SCAN_LIMITS = Object.freeze({
  prsPerMine: 10,
  prsPerTick: 3,
  /** Wall time one pass may start new scans in. */
  budgetMs: 20_000,
  /** A PR still inside its window is re-read at most this often. */
  rescanMs: DAY_MS,
  attempts: 3,
});

/** One later commit's touches of a PR's lines, as ONE candidate: a single
 * commit touching many files (a translation sweep, a rename) is one event. */
function postMergeDraft(
  row: { pr: number; merged_at: string },
  commit: string,
  touches: readonly PostMergeScan["touches"][number][],
  nowIso: string,
): CandidateDraft {
  const first = touches[0]!;
  const spans = touches.map(
    (t) => `${pathText(t.path)}:${t.start}${t.end !== t.start ? `-${t.end}` : ""}`,
  );
  const shown = spans.slice(0, 4).join(", ");
  const more = spans.length > 4 ? ` and ${spans.length - 4} more` : "";
  const paths = [...new Set(touches.map((t) => t.path))];
  return {
    ref: `post-merge:${row.pr}:${commit}`,
    source: "recall",
    kind: "post_merge_change",
    polarity: "look-for",
    class: missedClass(first.path),
    lens_ids: [],
    pr: row.pr,
    round_no: null,
    finding_key: null,
    path: first.path,
    line: first.start,
    summary: oneLine(
      `PR #${row.pr} (bot-approved, merged ${row.merged_at.slice(0, 10)}): commit ${commit.slice(0, 7)} on ${first.committed_at.slice(0, 10)} changed lines the PR had changed — ${shown}${more}`,
      500,
    ),
    quote: quoteOf(first.subject),
    evidence: [
      `pr:${row.pr}`,
      `commit:${commit}`,
      ...paths
        .slice(0, 10)
        .filter((p) => /^[^\s,]{1,200}$/.test(p))
        .map((p) => `path:${p}`),
    ],
    occurred_at: first.committed_at || nowIso,
  };
}

/**
 * Post-merge recall: every PR merged within the horizon whose standing bot
 * verdict at the merge was APPROVE is scanned until its window has passed —
 * commits keep landing for `windowDays` after a merge. A git answer of
 * "unknown" (no merge commit names the PR, the branch not fetched) is
 * retried, then given up on, recorded; so is a scan with a read that failed
 * (`unread`) — a cap's partiality is final, a failed read's is not.
 *
 * One pass reads at most `maxPrs` PRs and starts none after `budgetMs`. The
 * ORDER (`tierOf`): a window that passed since its last read gets its final
 * read first; then in-window PRs never read, the one closing soonest first (a
 * fresh miss is worth most while its class is still live), then in-window
 * re-reads; the stale backlog — closed windows never read, the most recent
 * first — and closed PRs still owed come last. A PR is re-read at most once
 * per `rescanMs`.
 *
 * `persist` stores a read PR's drafts in the same transaction that records
 * the read: a scan marked done whose candidates never landed would be lost
 * for good (done PRs are never read again).
 */
export async function minePostMerge(
  store: StateStore,
  opts: {
    sinceIso: string;
    now: Date;
    windowDays: number;
    baseBranch: string;
    git: RecallGit;
    log?: (msg: string, extra?: unknown) => void;
    /** PRs this pass reads (default `RECALL_SCAN_LIMITS.prsPerMine`). */
    maxPrs?: number;
    /** Wall time after which no new read starts. */
    budgetMs?: number;
    /** The wall clock the budget is measured on (tests inject one). */
    clock?: () => number;
    /** Store one PR's drafts; runs inside the transaction recording its read. */
    persist: (drafts: CandidateDraft[]) => void;
  },
): Promise<{ drafts: CandidateDraft[]; scanned: number; unknown: number }> {
  const merges = store.db
    .prepare(
      `SELECT pr, MIN(ts) AS merged_at FROM events
        WHERE kind = 'pr_closed' AND json_extract(payload, '$.merged') = 1 AND pr IS NOT NULL AND ts >= ?
        GROUP BY pr`,
    )
    .all(opts.sinceIso) as Array<{ pr: number; merged_at: string }>;
  const ins = store.db.prepare(
    "INSERT OR IGNORE INTO learner_recall_scans (pr, merged_at) VALUES (?, ?)",
  );
  for (const m of merges) ins.run(m.pr, m.merged_at);
  const nowMs = opts.now.getTime();
  const windowMs = opts.windowDays * DAY_MS;
  const all = store.db.prepare("SELECT * FROM learner_recall_scans WHERE done = 0").all() as Array<{
    pr: number;
    merged_at: string;
    attempts: number;
    last_scan_at: string | null;
  }>;
  const endOf = (r: { merged_at: string }) => Date.parse(r.merged_at) + windowMs;
  /** The read a PR is due, as a priority tier (lower first), or null. */
  const tierOf = (r: { merged_at: string; last_scan_at: string | null }): number | null => {
    const open = endOf(r) >= nowMs;
    const last = r.last_scan_at === null ? NaN : Date.parse(r.last_scan_at);
    if (!Number.isFinite(last)) return open ? 1 : 3; // never read
    if (!open && last <= endOf(r)) return 0; // its window passed since: the final read
    if (nowMs - last < RECALL_SCAN_LIMITS.rescanMs) return null; // read recently
    return open ? 2 : 4; // a re-read: in-window, or a closed one still owed
  };
  // Tiers: 0 the final read of a window that just passed, 1 an in-window PR
  // never read, 2 an in-window re-read, 3 the closed never-read backlog,
  // 4 a closed PR still owed (an unknown answer, a clone not fetched far
  // enough). Inside a tier: open windows closing soonest first, closed ones
  // most recent first.
  const eligible = all
    .map((r) => ({ r, tier: tierOf(r) }))
    .filter((x): x is { r: (typeof all)[number]; tier: number } => x.tier !== null)
    .sort(
      (a, b) =>
        a.tier - b.tier ||
        (endOf(a.r) >= nowMs ? endOf(a.r) - endOf(b.r) : endOf(b.r) - endOf(a.r)) ||
        a.r.pr - b.r.pr,
    )
    .map((x) => x.r);
  const maxPrs = Math.max(0, opts.maxPrs ?? RECALL_SCAN_LIMITS.prsPerMine);
  const clock = opts.clock ?? (() => performance.now());
  const started = clock();
  const drafts: CandidateDraft[] = [];
  let scanned = 0;
  let unknown = 0;
  const nowIso = opts.now.toISOString();
  const finish = store.db.prepare(
    `UPDATE learner_recall_scans SET attempts = ?, last_scan_at = ?, merge_commit = ?, touches = ?,
       base_ref = ?, done = ?, outcome = ? WHERE pr = ?`,
  );
  for (const row of eligible) {
    if (scanned >= maxPrs) break;
    if (opts.budgetMs !== undefined && scanned > 0 && clock() - started >= opts.budgetMs) break;
    const windowEnd = Date.parse(row.merged_at) + windowMs;
    const closed = nowMs > windowEnd;
    if (verdictAt(store, row.pr, row.merged_at) !== "APPROVE") {
      finish.run(row.attempts, nowIso, null, null, null, 1, "not bot-approved at merge", row.pr);
      continue;
    }
    const baseRef =
      (
        store.db
          .prepare(
            `SELECT json_extract(payload, '$.base_ref') AS base_ref FROM events
              WHERE kind = 'round_dispatched' AND pr = ? ORDER BY id DESC LIMIT 1`,
          )
          .get(row.pr) as { base_ref: string | null } | undefined
      )?.base_ref || opts.baseBranch;
    scanned += 1;
    let scan: PostMergeScan | null = null;
    try {
      scan = await opts.git.postMergeTouches({
        pr: row.pr,
        baseRef,
        mergedAt: row.merged_at,
        windowDays: opts.windowDays,
      });
    } catch (err) {
      opts.log?.(`learner: post-merge scan of #${row.pr} failed`, err);
    }
    if (scan === null) {
      unknown += 1;
      const attempts = row.attempts + 1;
      const giveUp = attempts >= RECALL_SCAN_LIMITS.attempts && closed;
      finish.run(
        attempts,
        nowIso,
        null,
        null,
        baseRef,
        giveUp ? 1 : 0,
        giveUp ? "unknown: gave up" : "unknown",
        row.pr,
      );
      continue;
    }
    const byCommit = new Map<string, PostMergeScan["touches"]>();
    for (const t of scan.touches) byCommit.set(t.commit, [...(byCommit.get(t.commit) ?? []), t]);
    const prDrafts = [...byCommit].map(([commit, touches]) =>
      postMergeDraft(row, commit, touches, nowIso),
    );
    // Done only once the window has passed AND the clone holds it: the
    // learner never fetches, and a clone whose base tip predates the window's
    // end has not seen its last commits — reading that as "nothing more
    // touched" is the unknown-as-nothing this source must never do.
    const tipMs = Date.parse(scan.tip_at);
    const fetchedPast = Number.isFinite(tipMs) && tipMs >= windowEnd;
    // A read that FAILED (not a cap) may be recovered by another: a closed
    // window is re-read, at least once past its end and for up to `attempts`
    // days after it, then given up on, recorded.
    const lastMs = row.last_scan_at === null ? NaN : Date.parse(row.last_scan_at);
    const unreadRetry =
      scan.unread === true &&
      !(
        Number.isFinite(lastMs) &&
        lastMs > windowEnd &&
        nowMs - windowEnd >= RECALL_SCAN_LIMITS.attempts * RECALL_SCAN_LIMITS.rescanMs
      );
    const done = closed && fetchedPast && !unreadRetry;
    store.db.transaction(() => {
      if (prDrafts.length > 0) opts.persist(prDrafts);
      finish.run(
        row.attempts + 1,
        nowIso,
        scan.merge,
        scan.touches.length,
        baseRef,
        done ? 1 : 0,
        `${scan.shape}${scan.truncated ? " (partial)" : ""}${
          closed && !fetchedPast ? " (the clone is not fetched past the window yet)" : ""
        }${
          closed && fetchedPast && scan.unread === true
            ? unreadRetry
              ? " (a read failed: retried)"
              : " (a read failed: gave up)"
            : ""
        }`,
        row.pr,
      );
    })();
    drafts.push(...prDrafts);
  }
  return { drafts, scanned, unknown };
}

// ---- 4. the digest backfill ----------------------------------------------------

/** The bullets of a digest's `## Learnings` section, in order. A bullet's
 * indented continuation lines are joined to it; "none"-type bullets dropped. */
export function parseDigestLearnings(md: string): string[] {
  const lines = md.split("\n");
  const out: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (/^#{1,3}\s/.test(line)) {
      inSection = /^#{2,3}\s*Learnings\b/i.test(line);
      continue;
    }
    if (!inSection) continue;
    const bullet = /^\s{0,3}(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) {
      out.push(bullet[1]!.trim());
      continue;
    }
    if (/^\s{2,}\S/.test(line) && out.length > 0) out[out.length - 1] += ` ${line.trim()}`;
  }
  return out.filter(
    (b) => b !== "" && !/^\(?(none|nothing|n\/a|no (new )?(learnings|entries|lessons))\b/i.test(b),
  );
}

const DIGEST_TYPES: Readonly<Record<string, Polarity>> = {
  "missed-finding": "look-for",
  "false-positive": "dont-raise",
  refuted: "dont-raise",
  "wontfix-pattern": "dont-raise",
  wontfix: "dont-raise",
  "repo-gotcha": "either",
};

/** A bullet's `type` word: any key of DIGEST_TYPES, the longer spelling first
 * (`wontfix-pattern` before `wontfix`). */
const DIGEST_TYPE_RE = new RegExp(
  `\\b(${Object.keys(DIGEST_TYPES)
    .sort((a, b) => b.length - a.length)
    .join("|")})\\b`,
  "i",
);

const OPS_RE =
  /invalid api key|openviking|memory (?:was |is )?(?:down|unreachable|unavailable)|entries persisted|kind=bug|\boperations?\b|\binfra(?:structure)?\b/i;

/** A digest bullet's class and polarity: its `type` word and the first lens
 * it names; an ops bullet is `digest.operations`. */
export function digestBulletClass(bullet: string): {
  class: string;
  polarity: Polarity;
  lens_ids: string[];
} {
  const lens = canonicalLensIds(
    [...bullet.matchAll(/\bpass-[a-z-]+/gi)].map((m) => m[0]).join(","),
  );
  const type = DIGEST_TYPE_RE.exec(bullet)?.[1]?.toLowerCase();
  if (!type && OPS_RE.test(bullet))
    return { class: "digest.operations", polarity: "ops", lens_ids: [] };
  const lensPart = lens[0] ? slugPart(lens[0].replace(/^pass-/, "")) : "digest";
  return {
    class: safeClass(`${lensPart}.${type ?? "unclassified"}`, "digest.unclassified"),
    polarity: type ? DIGEST_TYPES[type]! : "either",
    lens_ids: lens,
  };
}

/** Every date `from`..`to` inclusive (`YYYY-MM-DD`). */
export function datesBetween(from: string, to: string): string[] {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return [];
  const out: string[] = [];
  for (let t = a; t <= b && out.length < 400; t += DAY_MS)
    out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/**
 * The lost digest learnings as candidates (`source = digest-backfill`):
 * every `## Learnings` bullet of `digest/<date>.md` for each date in the
 * range. `absent` counts the dates with no digest file; `unreadable` the
 * files that could not be read (the backfill is then not done).
 */
export function mineDigestBackfill(opts: { dir: string; from: string; to: string }): {
  drafts: CandidateDraft[];
  files: number;
  absent: number;
  unreadable: number;
} {
  const drafts: CandidateDraft[] = [];
  let files = 0;
  let absent = 0;
  let unreadable = 0;
  for (const date of datesBetween(opts.from, opts.to)) {
    const path = join(opts.dir, `${date}.md`);
    if (!existsSync(path)) {
      absent += 1;
      continue;
    }
    let md: string;
    try {
      md = readFileSync(path, "utf8");
    } catch {
      unreadable += 1;
      continue;
    }
    files += 1;
    for (const bullet of parseDigestLearnings(md)) {
      const norm = bullet.toLowerCase().replace(/\s+/g, " ").trim();
      const c = digestBulletClass(bullet);
      drafts.push({
        ref: `digest:${date}:${sha16(norm)}`,
        source: "digest-backfill",
        kind: "digest_learning",
        polarity: c.polarity,
        class: c.class,
        lens_ids: c.lens_ids,
        pr:
          Number(/\bPR #(\d{1,7})\b|\/pull\/(\d{1,7})/.exec(bullet)?.slice(1).find(Boolean)) ||
          null,
        round_no: null,
        finding_key: null,
        path: null,
        line: null,
        summary: oneLine(
          `The ${date} digest listed this learning while memory refused every write, so it never became an entry`,
        ),
        quote: quoteOf(bullet),
        evidence: [`digest:${date}`],
        occurred_at: `${date}T12:00:00.000Z`,
      });
    }
  }
  return { drafts, files, absent, unreadable };
}

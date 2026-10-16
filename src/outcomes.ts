// Outcome capture: what became of every finding the reviewer posted.
//
// Why. `round_findings` records why each candidate was raised or killed; this
// module records what happened after a finding reached the PR — did the
// author fix it, argue it away, or leave it standing? — and links each posted
// finding to the GitHub comment that carried it, so a human reply joins back
// to the lens that raised the finding. The learner (finding cases, lessons)
// needs exactly that join. This module builds it, daemon-side and deterministic — no model in the
// loop, no GitHub write, nothing a round or a bench prompt can see.
//
// Three tables, owned here (on the state database, like the ping-pong
// ledger's):
//
// - `finding_comments` — one row per ROOT inline comment the bot posted, with
//   the facts needed to link it (path, original line, review id, the marker,
//   the title line) and the link itself: `(round_no, finding_key)` and how it
//   was made (`via`). Linking, most trusted first:
//     1. `marker` — the hidden `<!-- qcr:f=<round>:<key> -->` the live render
//        route stamps into every comment (src/findingkey.ts). Exact.
//     2. `thread_id` — the record's own `thread_id` names the comment.
//     3. `path_line` — the one posted finding at that path and line in the
//        comment's round (the round its review id names, else the registry's
//        attribution); ties broken by the title line (`path_line_title`), then
//        the tag (`path_line_tag`). A comment none of these settles stays
//        UNMATCHED (null) — never a guess.
//   Facts arrive from the reconcile comment sweep's existing read (the bot's
//   own inline comments), from the human replies
//   already in `pr_comments` (a reply names its thread's root, path and line —
//   GitHub's CURRENT line, which drifts as the branch moves, so it is the
//   weakest fact), and from the record's `thread_id`. A fallback link is kept
//   while its facts stand; when the bot's own comment supplies different ones
//   (the line it was posted on, its review id), the link is re-opened and
//   resolved again. No new GitHub read, and no gate: this only ever reads.
// - `finding_outcomes` — per posted finding, a FATE from the closed set
//   below, with the rule that decided it (`basis`), the evidence and when.
// - `review_outcomes` — the WHOLE-REVIEW signals (a review a human set aside,
//   a merge over a standing block), recorded per review and never smeared over
//   the review's findings: nothing says which finding made a human set a
//   review aside.
//
// The fates, and what decides them. Every piece of evidence is timestamped;
// the LATEST decisive one wins, so a finding upheld after a reply and fixed by
// a later push reads `fixed`.
//   fixed               — the session's thread decision said `fixed`; a human
//                         reply in the thread cites a commit made after the
//                         review (checked in git: a sha-shaped token that is
//                         no such commit — a UUID segment, a colour, the
//                         commit that introduced the behaviour — is no fix);
//                         the thread was resolved after a push that changed
//                         the anchored lines; or the finding is gone at the
//                         next round and the code at its anchor changed.
//   refuted_conceded    — the session's decision said `refuted`; a later round
//                         recorded it `conceded` with the code at its anchor
//                         unchanged and no sha cited; or the session resolved
//                         the thread with no push since the review and no
//                         unobserved head. The last two are INFERRED from the session's own act, so a
//                         human reply that accepts the point (`concedesPoint`:
//                         "fair catch", "fixed", "updated the description")
//                         turns them into `unknown`, basis `conflict:…`.
//   upheld_after_reply  — a human replied and the bot held: the decision said
//                         `held` or kept the thread open, or the next round
//                         posted the finding again. A thread kept open right
//                         after a reply citing a commit is no hold: a fix git
//                         verified stands, one it cannot check is `unknown`.
//   open_at_close       — none of the above, and the PR is closed.
//   unknown             — none of the above, and the PR is open.
// A `conceded` record is not read as a refutation on its own: most of them
// are fixes ("Fixed in <sha>"). It counts as `fixed` when a
// sha was cited or the anchored code changed, as `refuted_conceded` only when
// the code provably did not, and as no evidence when that cannot be told — a
// cited sha git cannot check included.
//
// A resolve is the session's: the event exists only when its thread decision
// said `resolve`. GitHub answering "already resolved" (a human clicked first)
// changes who clicked, not what the session judged, so it reads as the
// session's resolve; only the human-only refusals (`[check this]`,
// `[deferred]`) are no resolve at all. A decision that names its own
// `outcome` overrides the resolve it made.
//
// A later round's entry is this finding only when that is provable: it names
// this finding's thread or `settled:` it, or it names this finding's round in
// `raised_in_round` and either carries this finding's key or — same path,
// shared lens, within `CONTINUATION_LINES` — is nearer to this finding than
// to any other entry of that round. Only such a STRONG match carries
// evidence. A WEAK one (the next round, same path and lens, nearby, any
// round named or none) may be a different finding, so it only keeps this one
// from reading "gone", erring to `unknown`.
//
// A finding the next round posted again is CARRIED: the earlier row inherits
// the later one's evidence, so one finding raised in three rounds reads one
// fate three times rather than three different ones.
//
// Bounded. The reconcile pass runs `sweep()`: open PRs and PRs closed in the
// last day, at most `OUTCOME_SWEEP_MAX_PRS`, and a PR whose inputs have not
// moved since its last capture is skipped. Git reads (`AnchorGit`) are local,
// read-only and memoised; a commit the clone does not hold is UNKNOWN, never a
// change and never no-change. Every failure is the sweep's own — reconcile's
// health (which lifts a deploy drain) never waits on it.
import { parseFindingMarker } from "./findingkey.js";
import { storedLensIds } from "./lensids.js";
import type { ReviewCommentFull } from "./github.js";
import { bareTag } from "./severity.js";
import { yieldToLoop } from "./yieldloop.js";
import type { PrCommentRow, PrStateRow, RoundFindingRow, RoundRow, StateStore } from "./state.js";

export const FINDING_FATES = [
  "fixed",
  "refuted_conceded",
  "upheld_after_reply",
  "open_at_close",
  "unknown",
] as const;
export type FindingFate = (typeof FINDING_FATES)[number];

type DecisiveFate = "fixed" | "refuted_conceded" | "upheld_after_reply";
/** What one piece of evidence can say: a decisive fate, or `unknown` — a
 * rule that would have decided, held back by evidence that contradicts it
 * (its basis names the conflict). The latest piece still wins. */
type EvidenceFate = DecisiveFate | "unknown";

/** How a posted comment was linked to its finding, most trusted first. */
export type LinkVia = "marker" | "thread_id" | "path_line" | "path_line_title" | "path_line_tag";

/** A whole-review signal, recorded per review. */
export type ReviewOutcomeKind = "set_aside" | "merged_over_block";

/** The git reads the fate rules need. `null` = unknown, never a guess.
 * `WorktreeManager` implements both over the base clone. */
export interface AnchorGit {
  /** Did the code at a finding's anchor change between two commits? */
  anchorTouched(
    path: string,
    line: number | null,
    from: string,
    to: string,
  ): Promise<boolean | null>;
  /** Is `sha` a commit `to` contains and `from` does not — made after the
   * head a finding was raised at? */
  introducedBetween(sha: string, from: string, to: string): Promise<boolean | null>;
}

/** Bump when a rule changes, so every PR is re-captured once. */
export const OUTCOME_RULES_VERSION = 4;
/** PRs captured per reconcile pass. */
export const OUTCOME_SWEEP_MAX_PRS = 25;
/** How long after a close a PR is still captured — the close is evidence. */
export const OUTCOME_CLOSED_WINDOW_MS = 24 * 60 * 60 * 1000;
/**
 * Does the bounded pass (`OutcomeCapture.sweep`) still visit this PR? Open
 * PRs, and PRs closed within `OUTCOME_CLOSED_WINDOW_MS`; a PR with no
 * `pr_state` row never. The ONE spelling of the window: the case writer
 * (src/cases.ts) catches up the PRs outside it itself.
 */
export function inCaptureWindow(
  p: Pick<PrStateRow, "state" | "updated_at"> | null | undefined,
  nowMs: number,
): boolean {
  if (!p) return false;
  return p.state !== "closed" || nowMs - (ms(p.updated_at) ?? 0) <= OUTCOME_CLOSED_WINDOW_MS;
}
/** A PR whose inputs have not moved is still re-captured this often: a git
 * answer that was unknown (a commit not yet fetched) may since be known. */
export const OUTCOME_RECAPTURE_MS = 6 * 60 * 60 * 1000;
/** Wall time one pass may spend before it stops STARTING PRs: the pass runs
 * inside reconcile, ahead of the dispatch pump, so the first capture after a
 * deploy (every open PR, cold git) must not hold the pump for long. The PRs
 * left over come first next pass. */
export const OUTCOME_SWEEP_BUDGET_MS = 10_000;
/** How far a later round's entry may sit from a finding's line and still be
 * that finding (lines move as the branch moves). */
export const CONTINUATION_LINES = 10;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS finding_comments (
  comment_id INTEGER PRIMARY KEY,
  pr INTEGER NOT NULL,
  review_id INTEGER,
  path TEXT,
  line INTEGER,
  head TEXT,
  marker_round INTEGER,
  marker_key TEXT,
  created_at TEXT,
  -- 'github' (the bot's own comment, read) | 'reply' (a human reply named it)
  -- | 'record' (a findings record's thread_id named it)
  source TEXT NOT NULL,
  round_no INTEGER,
  finding_key TEXT,
  via TEXT,
  linked_at TEXT,
  seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS finding_comments_finding
  ON finding_comments (pr, round_no, finding_key);
CREATE TABLE IF NOT EXISTS finding_outcomes (
  pr INTEGER NOT NULL,
  round_no INTEGER NOT NULL,
  finding_key TEXT NOT NULL,
  comment_id INTEGER,
  fate TEXT NOT NULL,
  basis TEXT,
  evidence TEXT,
  decided_at TEXT,
  human_replies INTEGER NOT NULL DEFAULT 0,
  carried_to TEXT,
  fate_changed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (pr, round_no, finding_key)
);
CREATE TABLE IF NOT EXISTS review_outcomes (
  signal_id INTEGER PRIMARY KEY,
  pr INTEGER NOT NULL,
  kind TEXT NOT NULL,
  round_no INTEGER,
  gh_review_id INTEGER,
  at TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS outcome_capture_marks (
  pr INTEGER PRIMARY KEY,
  signature TEXT NOT NULL,
  captured_at TEXT NOT NULL
);
`;

export interface FindingCommentRow {
  comment_id: number;
  pr: number;
  review_id: number | null;
  path: string | null;
  line: number | null;
  head: string | null;
  marker_round: number | null;
  marker_key: string | null;
  created_at: string | null;
  source: string;
  round_no: number | null;
  finding_key: string | null;
  via: LinkVia | null;
  linked_at: string | null;
  /** When the row was first written or its facts last changed. */
  seen_at: string;
}

/**
 * A retried posting can stamp one finding's marker on two comments: the
 * earliest keeps the link (`via = marker`), every later one stays unlinked
 * with the marker. Per linked comment, its twins' ids, ascending — the other
 * threads that are the same finding's. One rule for the outcome capture and
 * the finding cases.
 */
export function markerTwins(rows: readonly FindingCommentRow[]): Map<number, number[]> {
  const linked = new Map<string, FindingCommentRow>();
  for (const c of rows)
    if (c.round_no !== null && c.finding_key !== null) linked.set(fkey(c.round_no, c.finding_key), c);
  const out = new Map<number, number[]>();
  for (const c of [...rows].sort((a, b) => a.comment_id - b.comment_id)) {
    if (c.finding_key !== null || c.marker_round === null || c.marker_key === null) continue;
    const root = linked.get(fkey(c.marker_round, c.marker_key));
    if (root?.via !== "marker") continue;
    out.set(root.comment_id, [...(out.get(root.comment_id) ?? []), c.comment_id]);
  }
  return out;
}

/** A `finding_outcomes.carried_to` address: `<round>:<key>`. */
export function carriedToRef(roundNo: number, findingKey: string): string {
  return `${roundNo}:${findingKey}`;
}

/** The finding a `carried_to` address names — split at the FIRST ':', since
 * the key itself may hold ':' — or null when the round part is not an
 * integer. */
export function parseCarriedTo(ref: string): { round_no: number; finding_key: string } | null {
  const cut = ref.indexOf(":");
  const round = Number(ref.slice(0, cut));
  if (cut <= 0 || !Number.isInteger(round)) return null;
  return { round_no: round, finding_key: ref.slice(cut + 1) };
}

export interface FindingOutcomeRow {
  pr: number;
  round_no: number;
  finding_key: string;
  comment_id: number | null;
  fate: FindingFate;
  basis: string | null;
  evidence: string | null;
  decided_at: string | null;
  human_replies: number;
  carried_to: string | null;
  fate_changed_at: string;
  updated_at: string;
}

export interface ReviewOutcomeRow {
  signal_id: number;
  pr: number;
  kind: ReviewOutcomeKind;
  round_no: number | null;
  gh_review_id: number | null;
  at: string;
  recorded_at: string;
}

export interface CaptureResult {
  posted: number;
  linked: number;
  unmatched: number;
  /** Findings whose fate is new or changed by this capture. */
  changed: number;
  fates: Record<FindingFate, number>;
}

export interface OutcomeSweepReport {
  considered: number;
  captured: number;
  skipped: number;
  fates_changed: number;
  errors: string[];
}

// ---- small pure helpers ---------------------------------------------------

/** How many sha-shaped tokens of one reply are checked in git. */
const MAX_CITED_SHAS = 5;
/** How many later heads a cited sha is checked against. */
const MAX_LATER_HEADS = 8;

/** The sha-shaped tokens a human reply carries (7–40 hex characters with at
 * least one digit and one letter, standing alone — "Fixed in 3f2a9c1", a
 * commit URL; never `#`-prefixed like a colour, never a dash-joined run like
 * a UUID's segments), distinct, in order, at most `MAX_CITED_SHAS`. A token
 * is only a CANDIDATE: whether it is a fix is git's question
 * (`AnchorGit.introducedBetween`). */
export function citedShas(text: string | null | undefined): string[] {
  if (typeof text !== "string") return [];
  const out: string[] = [];
  for (const m of text.matchAll(/(?<![0-9a-z#-])[0-9a-f]{7,40}(?![0-9a-z-])/gi)) {
    const t = m[0].toLowerCase();
    if (/[0-9]/.test(t) && /[a-f]/.test(t) && !out.includes(t)) out.push(t);
    if (out.length >= MAX_CITED_SHAS) break;
  }
  return out;
}

/** The first candidate `citedShas` finds, or null. */
export function citedSha(text: string | null | undefined): string | null {
  return citedShas(text)[0] ?? null;
}

/** The tags and title a comment opens with: `[blocker] title`,
 * `**[check this]** title`, `[ask your human] [question] title`. */
export function commentHead(body: string | null | undefined): { tags: string[]; title: string } {
  const first =
    (typeof body === "string" ? body : "").split("\n").find((l) => l.trim() !== "") ?? "";
  let rest = first.trim();
  const tags: string[] = [];
  for (;;) {
    rest = rest.replace(/^[*_`~>\s]+/, "");
    const m = /^\[([^\]]{1,40})\][*_`~\s]*/.exec(rest);
    if (!m) break;
    tags.push(m[1]!.trim().toLowerCase());
    rest = rest.slice(m[0].length);
  }
  return { tags, title: rest.replace(/[*_~\s]+$/, "").trim() };
}

function normTitle(t: string | null | undefined): string {
  return (t ?? "")
    .toLowerCase()
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.!?:;\s]+$/, "")
    .trim();
}

function ms(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function lensIdsOf(row: RoundFindingRow): string[] {
  return storedLensIds(row.lens_ids) ?? [];
}

/**
 * Which entry of the round `e` names in `raised_in_round` is `e` again? Only
 * an entry on the same path, sharing a lens, within `CONTINUATION_LINES`:
 * the one carrying `e`'s key when it is such an entry, else the single
 * nearest such entry (a file-level line counts as the farthest near one). A
 * tie is nobody's: two findings a few lines apart in one file and one lens
 * must not both inherit one entry's fate. Returns the owner's key, or null.
 *
 * An equal key ALONE is no match: sessions number their keys per round (f1,
 * f2, …), so a later round's `f1` is usually a different finding; a key-only
 * match would carry one finding's fate onto another far away in the file.
 */
export function predecessorOf(
  round: readonly RoundFindingRow[],
  e: RoundFindingRow,
): string | null {
  const dist = (s: RoundFindingRow) =>
    s.line === null || e.line === null ? CONTINUATION_LINES : Math.abs(s.line - e.line);
  const candidates = round.filter((s) => sameSite(s, e));
  const keyed = candidates.find((s) => s.finding_key === e.finding_key);
  if (keyed) return keyed.finding_key;
  if (candidates.length === 0) return null;
  const best = Math.min(...candidates.map(dist));
  const nearest = candidates.filter((s) => dist(s) === best);
  return nearest.length === 1 ? nearest[0]!.finding_key : null;
}

/** Could `b` be `a` again? The same path, a shared lens, within
 * `CONTINUATION_LINES` (an entry without a line is near). The one eligibility
 * rule of predecessor ownership and of the weak next-round match; who wins
 * among the eligible is each caller's own rule. */
function sameSite(a: RoundFindingRow, b: RoundFindingRow): boolean {
  if (!a.path || a.path !== b.path) return false;
  if (a.line !== null && b.line !== null && Math.abs(a.line - b.line) > CONTINUATION_LINES)
    return false;
  const ids = lensIdsOf(a);
  return lensIdsOf(b).some((id) => ids.includes(id));
}

const fkey = (round: number, key: string): string => `${round}\u0000${key}`;
const FATE_RANK: Record<EvidenceFate, number> = {
  fixed: 3,
  refuted_conceded: 2,
  upheld_after_reply: 1,
  unknown: 0,
};

interface Evidence {
  fate: EvidenceFate;
  basis: string;
  at: number;
  detail: string;
}

/**
 * Does a human reply ACCEPT the finding — agree it was right, or say it was
 * fixed or the description corrected? A deliberately small lexicon, read
 * only to hold back a refutation the record would otherwise infer from the
 * session's own act (it resolved the thread, or a later round conceded) with
 * the anchored code unchanged. Many such "refutations" are agreements: "fair
 * catch", "You are right, … I have corrected it", "Updated: the description
 * now says …", a fix made away from the anchor. It over-matches on purpose
 * — a hit only turns a refutation into `unknown`, never into a fix.
 */
const CONCESSION_RE =
  /\b(?:you(?:'|\u2019)?re (?:right|correct)|you are (?:right|correct)|(?:good|fair|great|nice) (?:catch|point|spot)|fixed|addressed|corrected|updated|amended|reworded|clarified|agreed|accepted|acknowledged|my (?:omission|mistake|bad)|will fix|made (?:it )?part of this pr)\b|^\s*done\b/im;

export function concedesPoint(text: string | null | undefined): boolean {
  return typeof text === "string" && CONCESSION_RE.test(text);
}

/** The latest evidence; at one instant, fixed > refuted > upheld > unknown. */
export function decideFate<E extends { fate: EvidenceFate; at: number }>(
  evidence: readonly E[],
): E | null {
  let best: E | null = null;
  for (const e of evidence)
    if (!best || e.at > best.at || (e.at === best.at && FATE_RANK[e.fate] > FATE_RANK[best.fate]))
      best = e;
  return best;
}

// ---- the per-PR facts one capture reads -------------------------------------

interface PrFacts {
  rows: RoundFindingRow[];
  posted: RoundFindingRow[];
  byRound: Map<number, RoundFindingRow[]>;
  /** Rounds with a parsed findings record: when, and at which head. */
  recorded: Map<number, { at: number; head: string | null }>;
  rounds: RoundRow[];
  links: Map<string, FindingCommentRow>;
  /** Per linked comment, its marker twins (`markerTwins`): each is still
   * that finding's thread, so its replies and decisions are its evidence. */
  twins: Map<number, number[]>;
  replies: Map<number, PrCommentRow[]>;
  decisions: Array<{
    at: number;
    thread_id: number;
    comment_id: number;
    resolution: string;
    outcome: string | null;
  }>;
  /** The session's resolves. `skipped` is GitHub's answer: null (the bot
   * resolved it), `already-resolved` (a human had), or a human-only refusal. */
  resolves: Array<{ at: number; thread_id: number; comment_id: number; skipped: string | null }>;
  pushes: Array<{ at: number; head_sha: string }>;
  /** The PR's head now, as the state database knows it. */
  currentHead: string | null;
  closedAt: number | null;
}

/** What a human reply — or the human replies of a thread — say about a fix
 * commit: a cited sha git confirmed (`verified`), one git could not check
 * (`unverified` — no evidence, and no "no sha was cited" either), or none
 * (`none`: no token, or every token provably not a later commit). */
type CitedFix =
  | { state: "verified"; sha: string; reply: PrCommentRow }
  | { state: "unverified" }
  | { state: "none" };

/** The thread's reading (`overall`: the LATEST verified citation, so a fix
 * cited after an intervening hold still supersedes it) and each reply's own
 * (`byReply`, by comment id: a decision on one reply is judged by THAT reply's
 * citation, never another's). */
interface CitedFixes {
  overall: CitedFix;
  byReply: Map<number, CitedFix["state"]>;
}

/** When a human reply was made: GitHub's time, else when it was captured. */
function replyMs(r: PrCommentRow): number {
  return ms(r.created_at) ?? ms(r.captured_at) ?? 0;
}

/** A resolve that counts: the bot's own, or one GitHub answered "already
 * resolved" (a human clicked first; the session still decided `resolve`). The
 * human-only refusals are no resolve at all. */
function resolveCounts(skipped: string | null): boolean {
  return skipped === null || skipped === "already-resolved";
}

function intOf(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return null;
}

export interface OutcomeCaptureDeps {
  store: StateStore;
  /** `[github] bot_login` — whose root comments are findings. */
  botLogin: string;
  /** Absent ⇒ every "did the code change" question is unknown. */
  git?: AnchorGit;
  now?: () => Date;
}

export class OutcomeCapture {
  private readonly store: StateStore;
  private readonly now: () => Date;

  constructor(private readonly deps: OutcomeCaptureDeps) {
    this.store = deps.store;
    this.now = deps.now ?? (() => new Date());
    this.store.db.exec(SCHEMA);
  }

  private ts(): string {
    return this.now().toISOString();
  }

  // ---- facts in ---------------------------------------------------------------

  /**
   * Keep the link facts of the bot's own ROOT inline comments from a read the
   * caller already made (the reconcile comment sweep's `listReviewCommentsFull`).
   * Replies, other authors' comments and the body beyond its first line are
   * not kept. Returns how many rows were new or gained facts.
   *
   * Facts that change re-open the row's link: a fallback link made from a
   * human reply's drifted line, or before the review id was known, was a
   * resolution of the OLD facts, so it goes back to unmatched and the next
   * `linkComments` resolves it from the new ones. Only a marker link whose
   * marker is unchanged stands.
   */
  observeBotComments(pr: number, comments: readonly ReviewCommentFull[]): number {
    const keep =
      "(finding_comments.via = 'marker'" +
      " AND finding_comments.marker_round IS excluded.marker_round" +
      " AND finding_comments.marker_key IS excluded.marker_key)";
    const stmt = this.store.db.prepare(
      `INSERT INTO finding_comments
         (comment_id, pr, review_id, path, line, head, marker_round, marker_key, created_at,
          source, seen_at)
       VALUES (@comment_id, @pr, @review_id, @path, @line, @head, @marker_round, @marker_key,
          @created_at, 'github', @seen_at)
       ON CONFLICT(comment_id) DO UPDATE SET
         review_id = excluded.review_id, path = excluded.path, line = excluded.line,
         head = excluded.head, marker_round = excluded.marker_round,
         marker_key = excluded.marker_key, created_at = excluded.created_at, source = 'github',
         seen_at = excluded.seen_at,
         round_no = CASE WHEN ${keep} THEN finding_comments.round_no ELSE NULL END,
         finding_key = CASE WHEN ${keep} THEN finding_comments.finding_key ELSE NULL END,
         via = CASE WHEN ${keep} THEN finding_comments.via ELSE NULL END,
         linked_at = CASE WHEN ${keep} THEN finding_comments.linked_at ELSE NULL END
       WHERE finding_comments.source != 'github'
          OR finding_comments.review_id IS NOT excluded.review_id
          OR finding_comments.path IS NOT excluded.path
          OR finding_comments.line IS NOT excluded.line
          OR finding_comments.head IS NOT excluded.head
          OR finding_comments.marker_round IS NOT excluded.marker_round
          OR finding_comments.marker_key IS NOT excluded.marker_key`,
    );
    let changed = 0;
    const seen = this.ts();
    this.store.db.transaction(() => {
      for (const c of comments) {
        if (c.user !== this.deps.botLogin || c.in_reply_to_id !== null) continue;
        const marker = parseFindingMarker(c.body);
        const head = commentHead(c.body);
        const info = stmt.run({
          comment_id: c.id,
          pr,
          review_id: c.pull_request_review_id ?? null,
          path: c.path || null,
          // The line it was POSTED on — `line` drifts as the branch moves.
          line: c.original_line ?? c.line ?? null,
          head: [head.tags.map((t) => `[${t}]`).join(" "), head.title]
            .filter(Boolean)
            .join(" ")
            .slice(0, 300),
          marker_round: marker?.round_no ?? null,
          marker_key: marker?.key ?? null,
          created_at: c.created_at ?? null,
          seen_at: seen,
        });
        changed += info.changes;
      }
    })();
    return changed;
  }

  /** Link facts the state database already holds: the root a human reply
   * names (when the registry says the bot posted it — its path, and its line
   * as GitHub reported it then, which may have drifted from the posted one)
   * and a record's own `thread_id`. Never overwrites a row: the bot's own
   * comment, when read, replaces these facts (and re-opens their link). */
  private ingestLocalFacts(pr: number, posted: readonly RoundFindingRow[]): void {
    const insert = this.store.db.prepare(
      `INSERT OR IGNORE INTO finding_comments (comment_id, pr, path, line, created_at, source, seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    // The registry knows when the bot posted the comment. Without it a
    // reply- or record-sourced row has no posting time, and a fate rule
    // falls back to the round's record time — a later round's, on a link
    // the registry contradicts.
    const backfill = this.store.db.prepare(
      "UPDATE finding_comments SET created_at = ? WHERE comment_id = ? AND created_at IS NULL",
    );
    const seen = this.ts();
    const add = (commentId: number, path: string | null, line: number | null, source: string) => {
      const postedAt = this.store.botCommentPostedAt(commentId);
      insert.run(commentId, pr, path, line, postedAt, source, seen);
      if (postedAt !== null) backfill.run(postedAt, commentId);
    };
    this.store.db.transaction(() => {
      for (const c of this.store.prComments(pr)) {
        if (c.source !== "review_comment" || c.in_reply_to_id === null) continue;
        if (!this.store.isBotComment(c.in_reply_to_id)) continue;
        add(c.in_reply_to_id, c.path, c.line, "reply");
      }
      for (const f of posted) {
        if (f.thread_id === null || !this.store.isBotComment(f.thread_id)) continue;
        add(f.thread_id, f.path, f.line, "record");
      }
    })();
  }

  // ---- linking ------------------------------------------------------------------

  /** The rounds of a PR that have a parsed findings record. */
  private recordedRounds(pr: number, rows: readonly RoundFindingRow[]) {
    const out = new Map<number, { at: number; head: string | null }>();
    for (const r of rows) {
      const at = ms(r.recorded_at) ?? 0;
      const prev = out.get(r.round_no);
      out.set(r.round_no, {
        at: prev ? Math.min(prev.at, at) : at,
        head: prev?.head || r.head_sha || null,
      });
    }
    // A record with no entries leaves no rows — its event is the evidence
    // the round was recorded at all.
    for (const e of this.store.prEvents(pr, ["findings_recorded"])) {
      const round = intOf(e.payload.round_no);
      if (round === null || out.has(round)) continue;
      out.set(round, { at: ms(e.ts) ?? 0, head: null });
    }
    // A head the rows do not carry: the round's posted review's commit.
    for (const r of this.store.roundsFor(pr)) {
      const rec = out.get(r.round_no);
      if (rec && !rec.head && r.gh_commit_id) rec.head = r.gh_commit_id;
    }
    return out;
  }

  /**
   * Link every bot comment of a PR to its finding (see the module header for
   * the order). A marker link is final. Every other comment is resolved
   * AGAIN on every capture, from its facts alone, so the result never
   * depends on the order comments are visited or on what an earlier pass
   * linked.
   *
   *   * The round: the one the comment's review id names, else the one the
   *     registry (`bot_comments.round_no`) attributes it to. When either is
   *     known, ONLY that round's findings are candidates — a comment whose
   *     round holds no posted finding at its path and line is unmatched,
   *     never linked to another round's finding. Only a comment
   *     neither names falls back to the first round recorded after it was
   *     posted.
   *   * A finding two comments could claim by fallback is NEITHER's, and one
   *     a marker claims is the marker's.
   *
   * Returns the counts after.
   */
  linkComments(pr: number): { linked: number; unmatched: number } {
    const rows = this.store.roundFindings(pr);
    const posted = rows.filter((r) => r.disposition === "posted");
    this.ingestLocalFacts(pr, posted);
    const comments = this.store.db
      .prepare("SELECT * FROM finding_comments WHERE pr = ? ORDER BY comment_id")
      .all(pr) as FindingCommentRow[];
    const byKey = new Map(rows.map((r) => [fkey(r.round_no, r.finding_key), r]));
    const recorded = this.recordedRounds(pr, rows);
    const reviewRound = new Map<number, number>();
    for (const r of this.store.roundsFor(pr))
      if (r.gh_review_id !== null) reviewRound.set(r.gh_review_id, r.round_no);

    const update = this.store.db.prepare(
      "UPDATE finding_comments SET round_no = ?, finding_key = ?, via = ?, linked_at = ? WHERE comment_id = ?",
    );
    const unlink = this.store.db.prepare(
      "UPDATE finding_comments SET round_no = NULL, finding_key = NULL, via = NULL, linked_at = NULL WHERE comment_id = ?",
    );
    const at = this.ts();
    const resolve = (c: FindingCommentRow): { f: RoundFindingRow; via: LinkVia } | null => {
      if (c.marker_round !== null && c.marker_key !== null) {
        const f = byKey.get(fkey(c.marker_round, c.marker_key));
        if (f) return { f, via: "marker" };
        // Its round's record is not parsed yet: wait for it rather than guess.
        if (!recorded.has(c.marker_round)) return null;
        // Parsed, and the key is not in it (the record was rewritten after
        // rendering): the fallback below may still place it.
      }
      const byThread = posted.filter((f) => f.thread_id === c.comment_id);
      if (byThread.length === 1) return { f: byThread[0]!, via: "thread_id" };
      if (c.path === null || c.line === null) return null;
      const here = posted.filter((f) => f.path === c.path && f.line === c.line);
      if (here.length === 0) return null;
      const exactRound = c.review_id !== null ? reviewRound.get(c.review_id) : undefined;
      const named = exactRound ?? this.store.botCommentRound(c.comment_id) ?? undefined;
      let pool: RoundFindingRow[];
      if (named !== undefined) pool = here.filter((f) => f.round_no === named);
      else {
        // The comment's round is the first whose record was parsed after the
        // comment was posted (a record is written after posting).
        const rounds = [...new Set(here.map((f) => f.round_no))].sort((a, b) => a - b);
        const created = ms(c.created_at);
        const round =
          created === null
            ? rounds.length === 1
              ? rounds[0]
              : undefined
            : rounds.find((r) => (recorded.get(r)?.at ?? -Infinity) >= created);
        pool = round === undefined ? [] : here.filter((f) => f.round_no === round);
      }
      if (pool.length === 1) return { f: pool[0]!, via: "path_line" };
      if (pool.length === 0 || c.head === null) return null;
      const head = commentHead(c.head);
      const byTitle = pool.filter((f) => f.title && normTitle(f.title) === normTitle(head.title));
      if (byTitle.length === 1) return { f: byTitle[0]!, via: "path_line_title" };
      const tag = head.tags.find((t) => t !== "ask your human" && t !== "deferred") ?? head.tags[0];
      const byTag = pool.filter((f) => f.posted_as && bareTag(f.posted_as) === tag);
      if (byTag.length === 1) return { f: byTag[0]!, via: "path_line_tag" };
      return null;
    };

    // Pass 1: every comment's own answer, from its facts alone.
    const hits = new Map<number, { f: RoundFindingRow; via: LinkVia } | null>();
    const claims = new Map<string, { marker: number[]; fallback: number[] }>();
    for (const c of comments) {
      const hit =
        c.via === "marker" && c.round_no !== null && c.finding_key !== null
          ? (() => {
              const f = byKey.get(fkey(c.round_no, c.finding_key));
              return f ? { f, via: "marker" as LinkVia } : resolve(c);
            })()
          : resolve(c);
      hits.set(c.comment_id, hit);
      if (!hit) continue;
      const k = fkey(hit.f.round_no, hit.f.finding_key);
      const claim = claims.get(k) ?? { marker: [], fallback: [] };
      (hit.via === "marker" ? claim.marker : claim.fallback).push(c.comment_id);
      claims.set(k, claim);
    }
    // Pass 2: a finding goes to its marker (the earliest comment, when a
    // retried posting stamped one marker twice), else to its one fallback
    // claimant; contested by fallbacks alone, it goes to nobody.
    this.store.db.transaction(() => {
      for (const c of comments) {
        const hit = hits.get(c.comment_id) ?? null;
        let keep: { f: RoundFindingRow; via: LinkVia } | null = null;
        if (hit) {
          const claim = claims.get(fkey(hit.f.round_no, hit.f.finding_key))!;
          if (hit.via === "marker") keep = Math.min(...claim.marker) === c.comment_id ? hit : null;
          else keep = claim.marker.length === 0 && claim.fallback.length === 1 ? hit : null;
        }
        if (!keep) {
          if (c.finding_key !== null) unlink.run(c.comment_id);
          continue;
        }
        if (
          c.finding_key === keep.f.finding_key &&
          c.round_no === keep.f.round_no &&
          c.via === keep.via
        )
          continue;
        update.run(keep.f.round_no, keep.f.finding_key, keep.via, at, c.comment_id);
      }
    })();
    const counts = this.store.db
      .prepare(
        "SELECT COUNT(finding_key) AS linked, COUNT(*) - COUNT(finding_key) AS unmatched FROM finding_comments WHERE pr = ?",
      )
      .get(pr) as { linked: number; unmatched: number };
    return counts;
  }

  // ---- fates ----------------------------------------------------------------

  private loadFacts(pr: number): PrFacts {
    const rows = this.store.roundFindings(pr);
    const posted = rows.filter((r) => r.disposition === "posted");
    const byRound = new Map<number, RoundFindingRow[]>();
    for (const r of rows) byRound.set(r.round_no, [...(byRound.get(r.round_no) ?? []), r]);
    const comments = this.commentsFor(pr);
    const links = new Map<string, FindingCommentRow>();
    for (const c of comments)
      if (c.round_no !== null && c.finding_key !== null) links.set(fkey(c.round_no, c.finding_key), c);
    const twins = markerTwins(comments);
    const replies = new Map<number, PrCommentRow[]>();
    for (const c of this.store.prComments(pr)) {
      if (c.source !== "review_comment" || c.in_reply_to_id === null) continue;
      if (c.author === this.deps.botLogin) continue;
      replies.set(c.in_reply_to_id, [...(replies.get(c.in_reply_to_id) ?? []), c]);
    }
    const events = this.store.prEvents(pr, [
      "pingpong_decision_applied",
      "pingpong_thread_resolved",
      "head_push",
      "pr_closed",
    ]);
    const facts: PrFacts = {
      rows,
      posted,
      byRound,
      recorded: this.recordedRounds(pr, rows),
      rounds: this.store.roundsFor(pr),
      links,
      twins,
      replies,
      decisions: [],
      resolves: [],
      pushes: [],
      currentHead: null,
      closedAt: null,
    };
    for (const e of events) {
      const at = ms(e.ts) ?? 0;
      const thread = intOf(e.payload.thread_id);
      const comment = intOf(e.payload.comment_id);
      if (e.kind === "pingpong_decision_applied" && thread !== null && comment !== null)
        facts.decisions.push({
          at,
          thread_id: thread,
          comment_id: comment,
          resolution: typeof e.payload.resolution === "string" ? e.payload.resolution : "",
          outcome: typeof e.payload.outcome === "string" ? e.payload.outcome : null,
        });
      else if (e.kind === "pingpong_thread_resolved" && thread !== null && comment !== null)
        facts.resolves.push({
          at,
          thread_id: thread,
          comment_id: comment,
          // A value that is neither null nor a known string is no resolve.
          skipped:
            e.payload.skipped === undefined || e.payload.skipped === null
              ? null
              : typeof e.payload.skipped === "string"
                ? e.payload.skipped
                : "unreadable",
        });
      else if (e.kind === "head_push" && typeof e.payload.head_sha === "string")
        facts.pushes.push({ at, head_sha: e.payload.head_sha });
      else if (e.kind === "pr_closed") facts.closedAt = at;
    }
    // Closed is the PR's state NOW: a PR reopened since its close is open.
    const row = this.store.getPr(pr);
    facts.currentHead = row?.head_sha || null;
    if (row && row.state !== "closed") facts.closedAt = null;
    else if (row && facts.closedAt === null) facts.closedAt = ms(row.updated_at) ?? 0;
    return facts;
  }

  /** Later-round entries that are this finding again (see the module
   * header). Strong: the entry names its thread or its `settled:` thread, or
   * names its round in `raised_in_round` with the same path and is THIS
   * finding's by key, else by being the one nearest same-lens entry of that
   * round. Weak — the NEXT round only — the same path and lens near the same
   * line, whoever it belongs to. */
  private continuations(
    f: RoundFindingRow,
    facts: PrFacts,
    threads: readonly number[],
  ): { strong: RoundFindingRow[]; next: { round: number; weak: RoundFindingRow[] } | null } {
    const ownRound = facts.byRound.get(f.round_no) ?? [];
    const strong: RoundFindingRow[] = [];
    for (const e of facts.rows) {
      if (e.round_no <= f.round_no) continue;
      const word = (e.word ?? "").trim().toLowerCase();
      if (threads.some((t) => e.thread_id === t || word === `settled:${t}`)) {
        strong.push(e);
        continue;
      }
      if (e.raised_in_round !== f.round_no || !f.path || e.path !== f.path) continue;
      if (predecessorOf(ownRound, e) === f.finding_key) strong.push(e);
    }
    const nextRound = [...facts.recorded.keys()]
      .filter((r) => r > f.round_no)
      .sort((a, b) => a - b)[0];
    if (nextRound === undefined) return { strong, next: null };
    const weak = (facts.byRound.get(nextRound) ?? []).filter((e) => sameSite(f, e));
    return { strong, next: { round: nextRound, weak } };
  }

  private async touched(f: RoundFindingRow, to: string | null): Promise<boolean | null> {
    if (!this.deps.git || !f.path || !f.head_sha || !to) return null;
    try {
      return await this.deps.git.anchorTouched(f.path, f.line, f.head_sha, to);
    } catch {
      return null;
    }
  }

  /** The heads a fix of `f` can live in: the PR's head now, the heads of the
   * rounds after `f`'s, and every pushed head, newest first — never `f`'s own. */
  private laterHeads(f: RoundFindingRow, facts: PrFacts): string[] {
    const out: string[] = [];
    const add = (h: string | null | undefined) => {
      if (h && h !== f.head_sha && !out.includes(h)) out.push(h);
    };
    add(facts.currentHead);
    for (const r of [...facts.recorded.keys()].sort((a, b) => b - a))
      if (r > f.round_no) add(facts.recorded.get(r)?.head);
    for (const p of [...facts.pushes].reverse()) add(p.head_sha);
    return out.slice(0, MAX_LATER_HEADS);
  }

  /** Does a human reply cite a commit made after `f`'s head (see `CitedFix`)?
   * Every reply is read, each on its own. */
  private async citedFix(
    f: RoundFindingRow,
    facts: PrFacts,
    replies: readonly PrCommentRow[],
  ): Promise<CitedFixes> {
    const heads = this.laterHeads(f, facts);
    const byReply = new Map<number, CitedFix["state"]>();
    let latest: Extract<CitedFix, { state: "verified" }> | null = null;
    let unverified = false;
    for (const r of replies) {
      const own = await this.replyCitesFix(f, heads, r);
      byReply.set(r.comment_id, own.state);
      if (own.state === "verified") {
        if (latest === null || replyMs(r) >= replyMs(latest.reply)) latest = own;
      } else if (own.state === "unverified") unverified = true;
    }
    const overall: CitedFix = latest ?? (unverified ? { state: "unverified" } : { state: "none" });
    return { overall, byReply };
  }

  /** One reply's citation: the first of its shas git confirms is a commit
   * after `f`'s head, else unverified when git could not answer for one. */
  private async replyCitesFix(
    f: RoundFindingRow,
    heads: readonly string[],
    r: PrCommentRow,
  ): Promise<CitedFix> {
    let unverified = false;
    for (const sha of citedShas(r.body)) {
      if (!this.deps.git || !f.head_sha || heads.length === 0) {
        unverified = true;
        continue;
      }
      for (const to of heads) {
        let answer: boolean | null;
        try {
          answer = await this.deps.git.introducedBetween(sha, f.head_sha, to);
        } catch {
          answer = null;
        }
        if (answer === true) return { state: "verified", sha, reply: r };
        if (answer === null) unverified = true;
      }
    }
    return unverified ? { state: "unverified" } : { state: "none" };
  }

  private async evidenceFor(
    f: RoundFindingRow,
    facts: PrFacts,
    memo: Map<string, Promise<ChainEvidence>>,
  ): Promise<ChainEvidence> {
    const k = fkey(f.round_no, f.finding_key);
    let p = memo.get(k);
    if (!p) {
      p = this.computeEvidence(f, facts, memo);
      memo.set(k, p);
    }
    return p;
  }

  private async computeEvidence(
    f: RoundFindingRow,
    facts: PrFacts,
    memo: Map<string, Promise<ChainEvidence>>,
  ): Promise<ChainEvidence> {
    const evidence: Evidence[] = [];
    const link = facts.links.get(fkey(f.round_no, f.finding_key)) ?? null;
    const thread = link?.comment_id ?? null;
    /** Every thread of this finding: its linked comment's, and its twins'. */
    const threads = thread === null ? [] : [thread, ...(facts.twins.get(thread) ?? [])];
    const postedAt =
      ms(link?.created_at) ?? facts.recorded.get(f.round_no)?.at ?? ms(f.recorded_at) ?? 0;
    // Backfilled replies and marker twins interleave by when they were written.
    const replies = threads
      .flatMap((t) => facts.replies.get(t) ?? [])
      .sort((a, b) => replyMs(a) - replyMs(b) || a.comment_id - b.comment_id);
    /** A human reply in the thread, no later than `at`, that accepts the
     * point (`concedesPoint`) — the latest one, or null. */
    const humanConceded = (at: number): PrCommentRow | null =>
      [...replies].reverse().find((r) => replyMs(r) <= at && concedesPoint(r.body)) ?? null;

    // 1. A human reply that cites a commit made after the review — "Fixed in
    //    3f2a9c1", checked in git. One git cannot check is no evidence, and no
    //    "nothing was cited" either.
    const cites = await this.citedFix(f, facts, replies);
    const cited = cites.overall;
    const fixCited = cited.state === "verified";
    if (cited.state === "verified")
      evidence.push({
        fate: "fixed",
        basis: "sha_cited",
        at: replyMs(cited.reply),
        detail: `reply ${cited.reply.comment_id} cites ${cited.sha}, a commit after the review`,
      });

    // 2. The session's thread decisions.
    const decided = new Set<number>();
    if (thread !== null) {
      for (const d of facts.decisions.filter((x) => threads.includes(x.thread_id))) {
        const fate: DecisiveFate | null =
          d.outcome === "fixed"
            ? "fixed"
            : d.outcome === "refuted"
              ? "refuted_conceded"
              : d.outcome === "held"
                ? "upheld_after_reply"
                : null;
        if (fate) {
          decided.add(d.comment_id);
          evidence.push({
            fate,
            basis: "pingpong_outcome",
            at: d.at,
            detail: `thread decision on reply ${d.comment_id}: ${d.outcome}`,
          });
        } else if (d.resolution === "keep_open") {
          // Keeping a thread open right after "Fixed in <sha>" is the
          // session not having re-verified the new head yet — not the bot
          // holding against a human. When the human reply it answered (the
          // decision's own comment id) cites a commit: a fix git verified
          // stands (nothing is added — `sha_cited` is the evidence); one git
          // cannot check yet leaves the finding undecided. Another reply's
          // citation decides nothing here.
          const answered = replies.find((r) => r.comment_id === d.comment_id) ?? null;
          const citesSha = answered !== null && citedShas(answered.body).length > 0;
          const answeredCite = answered
            ? (cites.byReply.get(answered.comment_id) ?? "none")
            : "none";
          if (citesSha && answeredCite === "verified") continue;
          evidence.push(
            citesSha && answeredCite === "unverified"
              ? {
                  fate: "unknown",
                  basis: "conflict:kept_open_after_unverified_sha",
                  at: d.at,
                  detail: `kept open after reply ${answered.comment_id} cited a commit git could not check`,
                }
              : {
                  fate: "upheld_after_reply",
                  basis: "kept_open",
                  at: d.at,
                  detail: `thread decision on reply ${d.comment_id}: keep_open`,
                },
          );
        }
      }
      // 3. The session's resolves, where its decision did not say why. A
      //    thread a human had already resolved is still the session's resolve
      //    (it decided `resolve`), at the latest at the event's time.
      for (const r of facts.resolves.filter(
        (x) => threads.includes(x.thread_id) && resolveCounts(x.skipped),
      )) {
        if (decided.has(r.comment_id)) continue;
        const who = r.skipped === "already-resolved" ? " (a human had resolved it first)" : "";
        if (fixCited) {
          evidence.push({
            fate: "fixed",
            basis: "resolved_after_cited_fix",
            at: r.at,
            detail: `resolved after a reply cited a commit${who}`,
          });
          continue;
        }
        const since = facts.pushes.filter((p) => p.at > postedAt && p.at <= r.at);
        const head = since[since.length - 1]?.head_sha ?? null;
        if (head === null) {
          if (cited.state === "unverified") continue;
          // Push events carry observation times. A head that differs now may
          // have landed before this resolve and only been captured afterwards.
          const observedHead =
            facts.pushes.filter((p) => p.at <= postedAt).at(-1)?.head_sha ?? f.head_sha;
          if (
            !facts.currentHead ||
            !observedHead ||
            facts.currentHead.toLowerCase() !== observedHead.toLowerCase()
          ) {
            evidence.push({
              fate: "unknown",
              basis: "conflict:resolved_unobserved_head",
              at: r.at,
              detail: `resolved without a push observed before it${who}, but the current head does not confirm the reviewed head`,
            });
            continue;
          }
          const accepted = humanConceded(r.at);
          evidence.push(
            accepted
              ? {
                  fate: "unknown",
                  basis: "conflict:resolved_no_change",
                  at: r.at,
                  detail: `resolved with no push since the review${who}, but reply ${accepted.comment_id} accepts the point`,
                }
              : {
                  fate: "refuted_conceded",
                  basis: "resolved_no_change",
                  at: r.at,
                  detail: `resolved with no push since the review${who}`,
                },
          );
          continue;
        }
        if ((await this.touched(f, head)) === true)
          evidence.push({
            fate: "fixed",
            basis: "resolved_after_push",
            at: r.at,
            detail: `resolved after ${head.slice(0, 12)} changed the anchored lines${who}`,
          });
      }
    }

    // 4. Later rounds. Only a strong match is this finding's evidence.
    const { strong, next } = this.continuations(f, facts, threads);
    const conceded = strong.filter((e) => e.disposition === "conceded");
    for (const e of conceded) {
      const head = facts.recorded.get(e.round_no)?.head ?? e.head_sha ?? null;
      const changed = await this.touched(f, head);
      const at = facts.recorded.get(e.round_no)?.at ?? ms(e.recorded_at) ?? 0;
      if (fixCited || changed === true)
        evidence.push({
          fate: "fixed",
          basis: "conceded_after_fix",
          at,
          detail: `round ${e.round_no} recorded it conceded after ${fixCited ? "a cited commit" : "the anchored lines changed"}`,
        });
      else if (changed === false && cited.state === "none") {
        const accepted = humanConceded(at);
        evidence.push(
          accepted
            ? {
                fate: "unknown",
                basis: "conflict:conceded_unchanged",
                at,
                detail: `round ${e.round_no} recorded it conceded with the anchored lines unchanged, but reply ${accepted.comment_id} accepts the point (a fix may sit away from the anchor)`,
              }
            : {
                fate: "refuted_conceded",
                basis: "conceded_unchanged",
                at,
                detail: `round ${e.round_no} recorded it conceded with the anchored lines unchanged`,
              },
        );
      }
    }

    // Posted again, provably the same finding: CARRIED — this row inherits the
    // later one's evidence. Only a strong match carries: a weak one (same
    // path and lens, nearby) may be a different finding, so it only keeps
    // this one from reading "gone".
    const reposted =
      strong.filter((e) => e.disposition === "posted").sort((a, b) => a.round_no - b.round_no)[0] ??
      null;
    let carriedTo: RoundFindingRow | null = null;
    if (reposted) {
      carriedTo = reposted;
      const againAt = facts.recorded.get(reposted.round_no)?.at ?? ms(reposted.recorded_at) ?? 0;
      if (replies.some((r) => replyMs(r) < againAt))
        evidence.push({
          fate: "upheld_after_reply",
          basis: "reposted_after_reply",
          at: againAt,
          detail: `round ${reposted.round_no} posted it again after a human reply`,
        });
    } else if (
      next &&
      conceded.length === 0 &&
      next.weak.length === 0 &&
      !strong.some((e) => e.round_no === next.round)
    ) {
      // Gone at the next round. Fixed only if the code at its anchor changed.
      const head = facts.recorded.get(next.round)?.head ?? null;
      if ((await this.touched(f, head)) === true)
        evidence.push({
          fate: "fixed",
          basis: "gone_after_change",
          at: facts.recorded.get(next.round)?.at ?? 0,
          detail: `gone at round ${next.round}, whose head changed the anchored lines`,
        });
    }
    if (carriedTo) {
      const successor = carriedTo;
      const later = await this.evidenceFor(successor, facts, memo);
      evidence.push(
        ...later.evidence.map((e) => ({
          ...e,
          basis: e.basis.startsWith("carried:") ? e.basis : `carried:${e.basis}`,
          detail: `round ${successor.round_no} ${successor.finding_key}: ${e.detail}`,
        })),
      );
    }
    return {
      evidence,
      comment: thread,
      replies: replies.length,
      carriedTo: carriedTo ? carriedToRef(carriedTo.round_no, carriedTo.finding_key) : null,
    };
  }

  /** Record the whole-review signals of a PR, one row per signal. */
  private recordReviewOutcomes(pr: number, rounds: readonly RoundRow[]): void {
    const upsert = this.store.db.prepare(
      `INSERT INTO review_outcomes (signal_id, pr, kind, round_no, gh_review_id, at, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(signal_id) DO UPDATE SET round_no = excluded.round_no,
         gh_review_id = excluded.gh_review_id`,
    );
    const at = this.ts();
    for (const s of this.store.feedbackSignalsFor(pr)) {
      if (s.kind === "review_set_aside" && s.review_id !== null) {
        const round = rounds.find((r) => r.gh_review_id === s.review_id) ?? null;
        upsert.run(s.id, pr, "set_aside", round?.round_no ?? null, s.review_id, s.created_at, at);
      } else if (s.kind === "merged_over_block") {
        // The review that stood: the latest decided round before the merge,
        // and only if it decided REQUEST_CHANGES — otherwise unknown.
        const signalAt = ms(s.created_at) ?? Infinity;
        const decided = rounds
          .filter(
            (r) =>
              (r.verdict === "APPROVE" || r.verdict === "REQUEST_CHANGES") &&
              (ms(r.finished_at ?? r.started_at) ?? Infinity) <= signalAt,
          )
          .sort((a, b) => a.round_no - b.round_no);
        const last = decided[decided.length - 1];
        const stood = last && last.verdict === "REQUEST_CHANGES" ? last : null;
        upsert.run(
          s.id,
          pr,
          "merged_over_block",
          stood?.round_no ?? null,
          stood?.gh_review_id ?? null,
          s.created_at,
          at,
        );
      }
    }
  }

  /** Link, then decide and record the fate of every posted finding of a PR. */
  async capturePr(pr: number): Promise<CaptureResult> {
    const link = this.linkComments(pr);
    const facts = this.loadFacts(pr);
    this.recordReviewOutcomes(pr, facts.rounds);
    // The fingerprint of exactly the inputs read above, taken BEFORE the first
    // await: a reply, push, decision or record that lands while the git reads
    // below are in flight was not read, so it must move the fingerprint away
    // from this mark and bring the PR back next pass.
    const signature = this.signature(pr);
    const memo = new Map<string, Promise<ChainEvidence>>();
    const decided: Array<{ f: RoundFindingRow; chain: ChainEvidence }> = [];
    for (const f of facts.posted)
      decided.push({ f, chain: await this.evidenceFor(f, facts, memo) });

    const fates = Object.fromEntries(FINDING_FATES.map((x) => [x, 0])) as Record<
      FindingFate,
      number
    >;
    const at = this.ts();
    const existing = new Map(
      (
        this.store.db
          .prepare("SELECT round_no, finding_key, fate FROM finding_outcomes WHERE pr = ?")
          .all(pr) as Array<{ round_no: number; finding_key: string; fate: string }>
      ).map((r) => [fkey(r.round_no, r.finding_key), r.fate]),
    );
    const upsert = this.store.db.prepare(
      `INSERT INTO finding_outcomes
         (pr, round_no, finding_key, comment_id, fate, basis, evidence, decided_at, human_replies,
          carried_to, fate_changed_at, updated_at)
       VALUES (@pr, @round_no, @finding_key, @comment_id, @fate, @basis, @evidence, @decided_at,
          @human_replies, @carried_to, @at, @at)
       ON CONFLICT(pr, round_no, finding_key) DO UPDATE SET
         comment_id = excluded.comment_id, fate = excluded.fate, basis = excluded.basis,
         evidence = excluded.evidence, decided_at = excluded.decided_at,
         human_replies = excluded.human_replies, carried_to = excluded.carried_to,
         fate_changed_at = CASE WHEN finding_outcomes.fate = excluded.fate
           THEN finding_outcomes.fate_changed_at ELSE excluded.fate_changed_at END,
         updated_at = excluded.updated_at`,
    );
    let changed = 0;
    this.store.db.transaction(() => {
      for (const { f, chain } of decided) {
        const best = decideFate(chain.evidence);
        // A latest piece of evidence that is a CONFLICT reads `unknown`, PR
        // open or closed — its basis says why — and is decided by nobody.
        const fate: FindingFate = best
          ? best.fate
          : facts.closedAt !== null
            ? "open_at_close"
            : "unknown";
        const decidedAt =
          best && best.fate !== "unknown"
            ? new Date(best.at).toISOString()
            : !best && facts.closedAt !== null
              ? new Date(facts.closedAt).toISOString()
              : null;
        fates[fate]++;
        if (existing.get(fkey(f.round_no, f.finding_key)) !== fate) changed++;
        upsert.run({
          pr,
          round_no: f.round_no,
          finding_key: f.finding_key,
          comment_id: chain.comment,
          fate,
          basis: best ? best.basis : fate === "open_at_close" ? "closed" : null,
          evidence: best ? best.detail.slice(0, 500) : null,
          decided_at: decidedAt,
          human_replies: chain.replies,
          carried_to: chain.carriedTo,
          at,
        });
      }
      // A row whose finding is no longer posted (a re-recorded round) goes.
      const live = new Set(decided.map(({ f }) => fkey(f.round_no, f.finding_key)));
      const drop = this.store.db.prepare(
        "DELETE FROM finding_outcomes WHERE pr = ? AND round_no = ? AND finding_key = ?",
      );
      for (const k of existing.keys())
        if (!live.has(k)) {
          const [round, key] = k.split("\u0000");
          drop.run(pr, Number(round), key);
        }
    })();
    this.markCaptured(pr, signature);
    return {
      posted: facts.posted.length,
      linked: link.linked,
      unmatched: link.unmatched,
      changed,
      fates,
    };
  }

  // ---- the bounded pass -----------------------------------------------------

  /** A fingerprint of everything a capture reads, so an unmoved PR is skipped. */
  signature(pr: number): string {
    const get = (sql: string) => this.store.db.prepare(sql).get(pr) as Record<string, unknown>;
    const row = this.store.getPr(pr);
    return JSON.stringify([
      OUTCOME_RULES_VERSION,
      this.deps.git ? 1 : 0,
      get("SELECT COUNT(*) c, MAX(id) m, MAX(recorded_at) r FROM round_findings WHERE pr = ?"),
      get("SELECT COUNT(*) c, MAX(id) m FROM pr_comments WHERE pr = ?"),
      get(
        "SELECT MAX(id) m FROM events WHERE pr = ? AND kind IN " +
          "('pingpong_decision_applied','pingpong_thread_resolved','head_push','pr_closed','findings_recorded')",
      ),
      get("SELECT COUNT(*) c, MAX(id) m FROM feedback_signals WHERE pr = ?"),
      get(
        // `seen_at` moves when a comment's facts change (its anchor or head
        // corrected), which can re-link it with every count unchanged.
        "SELECT COUNT(*) c, COUNT(finding_key) l, COUNT(marker_key) k, COUNT(review_id) v, MAX(seen_at) s FROM finding_comments WHERE pr = ?",
      ),
      get("SELECT COUNT(*) c FROM bot_comments WHERE pr = ?"),
      // a posting receipt landing later (gh_review_id) can settle a link
      get(
        "SELECT COUNT(*) c, COUNT(gh_review_id) v, COUNT(gh_commit_id) h, MAX(finished_at) f FROM rounds WHERE pr = ?",
      ),
      row?.state ?? null,
      row?.head_sha ?? null,
    ]);
  }

  private markCaptured(pr: number, signature: string): void {
    this.store.db
      .prepare(
        `INSERT INTO outcome_capture_marks (pr, signature, captured_at) VALUES (?, ?, ?)
         ON CONFLICT(pr) DO UPDATE SET signature = excluded.signature, captured_at = excluded.captured_at`,
      )
      .run(pr, signature, this.ts());
  }

  /**
   * One bounded pass: open PRs and PRs closed within the window, the ones
   * captured longest ago first, at most `maxPrs` and no new PR once
   * `budgetMs` of wall time is spent, skipping a PR whose inputs have not
   * moved (unless its capture is older than the recapture period). Never
   * throws; a PR that fails is named in `errors` and retried next pass.
   */
  async sweep(
    opts: { maxPrs?: number; force?: boolean; budgetMs?: number } = {},
  ): Promise<OutcomeSweepReport> {
    const report: OutcomeSweepReport = {
      considered: 0,
      captured: 0,
      skipped: 0,
      fates_changed: 0,
      errors: [],
    };
    const nowMs = this.now().getTime();
    const max = opts.maxPrs ?? OUTCOME_SWEEP_MAX_PRS;
    const started = performance.now();
    const budget = opts.budgetMs ?? OUTCOME_SWEEP_BUDGET_MS;
    try {
      const marks = new Map(
        (
          this.store.db
            .prepare("SELECT pr, signature, captured_at FROM outcome_capture_marks")
            .all() as Array<{
            pr: number;
            signature: string;
            captured_at: string;
          }>
        ).map((m) => [m.pr, m]),
      );
      const candidates = this.store
        .allPrs()
        .filter((p) => inCaptureWindow(p, nowMs))
        .sort((a, b) => {
          const ma = marks.get(a.number)?.captured_at ?? "";
          const mb = marks.get(b.number)?.captured_at ?? "";
          return ma < mb ? -1 : ma > mb ? 1 : a.number - b.number;
        });
      for (const p of candidates) {
        if (report.captured >= max) break;
        if (report.captured > 0 && performance.now() - started > budget) break;
        // A real event-loop turn per PR: a capture whose git answers are all
        // memoized (or with no git at all) never awaits real I/O, so a run of
        // them would otherwise block the loop as one long synchronous stretch.
        await yieldToLoop();
        report.considered++;
        try {
          const mark = marks.get(p.number);
          if (
            !opts.force &&
            mark &&
            nowMs - (ms(mark.captured_at) ?? 0) < OUTCOME_RECAPTURE_MS &&
            mark.signature === this.signature(p.number)
          ) {
            report.skipped++;
            continue;
          }
          const r = await this.capturePr(p.number);
          report.captured++;
          report.fates_changed += r.changed;
        } catch (err) {
          report.errors.push(`outcomes #${p.number}: ${String(err)}`);
        }
      }
    } catch (err) {
      report.errors.push(`outcomes: ${String(err)}`);
    }
    if (report.fates_changed > 0 || report.errors.length > 0)
      this.store.logEvent("outcomes_captured", null, report);
    return report;
  }

  // ---- reading back ---------------------------------------------------------

  outcomesFor(pr: number): FindingOutcomeRow[] {
    return this.store.db
      .prepare("SELECT * FROM finding_outcomes WHERE pr = ? ORDER BY round_no, finding_key")
      .all(pr) as FindingOutcomeRow[];
  }

  commentsFor(pr: number): FindingCommentRow[] {
    return this.store.db
      .prepare("SELECT * FROM finding_comments WHERE pr = ? ORDER BY comment_id")
      .all(pr) as FindingCommentRow[];
  }

  reviewOutcomesFor(pr: number): ReviewOutcomeRow[] {
    return this.store.db
      .prepare("SELECT * FROM review_outcomes WHERE pr = ? ORDER BY signal_id")
      .all(pr) as ReviewOutcomeRow[];
  }

  /**
   * The per-lens fate table over findings posted since `sinceIso`. A finding
   * several lenses raised counts once under each of them; one raised outside
   * any known lens counts under `(no lens)`. Whole-review signals are counted
   * per review, never per lens.
   */
  summary(sinceIso: string): OutcomeSummary {
    const rows = this.store.db
      .prepare(
        `SELECT f.lens_ids, f.lens, o.fate, o.human_replies,
                EXISTS (SELECT 1 FROM finding_comments c WHERE c.pr = f.pr AND c.round_no = f.round_no
                          AND c.finding_key = f.finding_key) AS linked
           FROM round_findings f
           LEFT JOIN finding_outcomes o
             ON o.pr = f.pr AND o.round_no = f.round_no AND o.finding_key = f.finding_key
          WHERE f.disposition = 'posted' AND f.recorded_at >= ?`,
      )
      .all(sinceIso) as Array<{
      lens_ids: string | null;
      lens: string;
      fate: FindingFate | null;
      human_replies: number | null;
      linked: number;
    }>;
    const empty = (): LensOutcomeCounts => ({
      posted: 0,
      linked: 0,
      uncaptured: 0,
      ...(Object.fromEntries(FINDING_FATES.map((x) => [x, 0])) as Record<FindingFate, number>),
    });
    const byLens = new Map<string, LensOutcomeCounts>();
    const total = empty();
    let replied = 0;
    let repliedKnown = 0;
    for (const r of rows) {
      const ids = storedLensIds(r.lens_ids) ?? [];
      const count = (c: LensOutcomeCounts) => {
        c.posted++;
        if (r.linked) c.linked++;
        if (r.fate) c[r.fate]++;
        else c.uncaptured++;
      };
      for (const id of ids.length ? ids : ["(no lens)"]) {
        const c = byLens.get(id) ?? empty();
        count(c);
        byLens.set(id, c);
      }
      count(total);
      if ((r.human_replies ?? 0) > 0) {
        replied++;
        if (r.fate && r.fate !== "unknown" && r.fate !== "open_at_close") repliedKnown++;
      }
    }
    const reviews = this.store.db
      .prepare(
        "SELECT kind, COUNT(*) AS n FROM review_outcomes WHERE at >= ? GROUP BY kind ORDER BY kind",
      )
      .all(sinceIso) as Array<{ kind: ReviewOutcomeKind; n: number }>;
    return {
      since: sinceIso,
      total,
      lenses: [...byLens.entries()]
        .sort(([a, x], [b, y]) => y.posted - x.posted || a.localeCompare(b))
        .map(([lens, counts]) => ({ lens, ...counts })),
      replied_threads: replied,
      replied_known: repliedKnown,
      reviews: Object.fromEntries(reviews.map((r) => [r.kind, r.n])),
    };
  }
}

interface ChainEvidence {
  evidence: Evidence[];
  comment: number | null;
  replies: number;
  carriedTo: string | null;
}

export interface LensOutcomeCounts extends Record<FindingFate, number> {
  posted: number;
  linked: number;
  /** Posted findings no capture has reached yet. */
  uncaptured: number;
}

export interface OutcomeSummary {
  since: string;
  total: LensOutcomeCounts;
  lenses: Array<{ lens: string } & LensOutcomeCounts>;
  /** Posted findings with at least one human reply in their thread … */
  replied_threads: number;
  /** … and how many of them have a fate other than unknown / open at close. */
  replied_known: number;
  reviews: Partial<Record<ReviewOutcomeKind, number>>;
}

/** The summary as the operator reads it (`qcr outcomes`). */
export function renderOutcomeSummary(s: OutcomeSummary): string {
  const pct = (n: number, d: number) => (d === 0 ? "—" : `${Math.round((100 * n) / d)}%`);
  const cols = [
    "posted",
    "linked",
    "fixed",
    "refuted",
    "upheld",
    "open@close",
    "unknown",
    "uncaptured",
  ];
  const line = (name: string, c: LensOutcomeCounts) =>
    [
      name.padEnd(24),
      ...[
        c.posted,
        c.linked,
        c.fixed,
        c.refuted_conceded,
        c.upheld_after_reply,
        c.open_at_close,
        c.unknown,
        c.uncaptured,
      ].map((n, i) => String(n).padStart(cols[i]!.length + 1)),
    ].join("");
  const out = [
    `Posted findings since ${s.since} — fate per lens (a finding several lenses raised counts under each).`,
    "",
    ["lens".padEnd(24), ...cols.map((c) => ` ${c}`)].join(""),
    ...s.lenses.map((l) => line(l.lens, l)),
    line("all findings", s.total),
    "",
    `linked to their comment: ${s.total.linked}/${s.total.posted} (${pct(s.total.linked, s.total.posted)})`,
    `human-replied threads with a known fate: ${s.replied_known}/${s.replied_threads} (${pct(s.replied_known, s.replied_threads)})`,
    `whole-review signals (per review, never per lens): set aside ${s.reviews.set_aside ?? 0}, merged over a block ${s.reviews.merged_over_block ?? 0}`,
  ];
  return out.join("\n");
}

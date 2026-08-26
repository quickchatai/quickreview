// SQLite state store (state/state.db) + the atomic status.json snapshot.
// Tables: pr_state, rounds, bot_comments (registry), deliveries
// (webhook dedupe), events (append log).
import Database from "better-sqlite3";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { OpenVikingStatus } from "./openviking/types.js";
import type { VerdictPassEntry } from "./types.js";

export type PrLifecycleState =
  | "tracked"
  | "queued"
  | "reviewing"
  | "awaiting_author"
  | "awaiting_human"
  | "closed";

/** Who asked for the queued round. `human` = a fresh label add, a
 * fresh team re-review request, an overseer/manual trigger, or an author reply
 * landing while queued — a person acted and expects a full round. `system` = a
 * push/CI/staleness re-trigger at an existing trigger state — the dispatcher
 * may consult the delta classifier and short-circuit an empty/trivial
 * delta. Null (legacy rows, direct requeues) is treated as human: the safe
 * default is a full round. */
export type TriggerProvenance = "human" | "system";

export interface PrStateRow {
  number: number;
  state: PrLifecycleState;
  head_sha: string;
  title: string;
  author: string;
  trigger_ts: string | null;
  trigger_provenance: TriggerProvenance | null;
  stale_recheck: number;
  migration_gate: number;
  /** Overseer pause-pr: no dispatch/re-trigger until resumed (or closed). */
  paused: number;
  updated_at: string;
}

export interface RoundRow {
  id: number;
  pr: number;
  round_no: number;
  round_type: string;
  lenses: string;
  verdict: string | null;
  /** LEGACY: the old self-reported spend column. No longer written —
   * boot folds surviving values into est_usd and every consumer reads est_usd.
   * Kept in the DDL because a live DB cannot drop it without a table rebuild. */
  spend_usd: number | null;
  duration_s: number | null;
  /** Session-written 3-4 sentence round summary (verdict file `summary`). */
  summary: string | null;
  started_at: string;
  deadline_at: string;
  finished_at: string | null;
  status: string;
  // ---- metrics / backfill columns (additive, nullable) ----
  /** Diffstat of the head this round reviewed (summed over the files API). */
  additions: number | null;
  deletions: number | null;
  changed_files: number | null;
  /** 1 for rows imported from GitHub history — never live behaviour. */
  backfilled: number;
  /** GitHub review databaseId — the backfill idempotence key. */
  gh_review_id: number | null;
  gh_commit_id: string | null;
  /** The trigger instant this round answered, copied off pr_state at start so
   * time-to-first-verdict survives the `trigger_ts = null` reset at dispatch. */
  trigger_ts: string | null;
  // ---- measured usage (from pi session JSONLs, not self-reported) --
  tokens_in: number | null;
  /** Output tokens including reasoning tokens. */
  tokens_out: number | null;
  tokens_cache_read: number | null;
  /** Daemon-side USD estimate (config pricing); null when a model is unpriced. */
  est_usd: number | null;
  /** The tier `pass-validate` ran at this round — recorded so a
   * later audit can tell which tier killed which finding. Null on rounds
   * started before the column existed (and on backfilled history). */
  validate_tier: string | null;
  /** Executed-pass telemetry: JSON array of VerdictPassEntry — the
   * passes the session ACTUALLY ran, as reported in the verdict file. Distinct
   * from `lenses`, which is the daemon's PLAN. Null = unknown (round predates
   * the field, or the session ran an older prompt and reported nothing). */
  executed_passes: string | null;
  /** hardening: when the lost-prompt net FIRST observed this round
   * fully silent (prompt consumed, session alive, no JSONL activity). The net
   * fires only on the SECOND consecutive silent sweep; any non-silent
   * observation clears the mark. Same persistence idiom as the
   * reviewed_heads/approval_withheld marks — a mark the daemon writes so a
   * restart cannot forget it — but round-scoped, so it lives on the round
   * row rather than in a per-PR table. Null = never seen silent. */
  silent_since: string | null;
  /** The receipt token stamped into this round's wake file (#5362), echoed
   * back by pi into the session JSONL when — and only when — the prompt is
   * ACCEPTED. Null means the round was dispatched by a build that stamped no
   * marker, so its delivery is UNKNOWABLE rather than unconfirmed: readers
   * must fall back to the older inference instead of concluding "lost". */
  prompt_marker: string | null;
  /** How many times this round's prompt has been re-delivered (#5362). Cheap
   * recovery (rewrite the wake file, same round and session), bounded on its
   * own rather than out of the `max_self_requeues` budget. */
  redeliveries: number;
  /** The per-round comment count: inline comments this round posted,
   * as the session reports it in its findings record. Null = unknown (no
   * record, or a record that omitted the count) — never confused with 0. */
  comments_posted: number | null;
  /** WHY this round was cancelled — null on every round that was
   * not cancelled, and on legacy cancellations the boot migration could
   * not classify from their prose summary. The prose stays in `summary`; this
   * is the machine-readable half every aggregate groups by. */
  cancel_cause: string | null;
}

/**
 * The reasons a round can be cancelled.
 *
 * Cancellation used to be prose only: `summary` carried a sentence and nothing
 * anywhere read it back. The diagnosis had to reconstruct the split by
 * grepping that prose — 55 cancellations since the cutover, 70% of them the
 * benign boot-time orphan sweep, and NOTHING consumed the signal while the
 * rare `overdue` (5 occurrences) raised an alarm. The loud signal was the rare
 * one. These are the causes; `LOUD_CANCEL_CAUSES` is which of them deserve a
 * human's attention.
 */
export type CancelCause =
  /** Boot-time orphan sweep: tmux lives in the container, so a restart orphans
   * every in-flight round BY CONSTRUCTION. A redeploy artefact, never a defect. */
  | "orphan_sweep"
  /** The round stopped dead inside its deadline window with no verdict. The
   * real defect (Q5: against completed rounds of 0.6–23.4 minutes, a
   * 75-minute overrun is never a slow round). */
  | "deadline_overrun"
  /** The round's prompt never reached the session and redelivery could not
   * repair it (#5362) — a delivery fault, not a review fault. */
  | "lost_prompt"
  /** The PR advanced mid-round; the session correctly posted nothing and the
   * round was redispatched against the fresh head. Benign. */
  | "head_moved"
  /** The round verdicted without executing any passes — redone rather than
   * handed to a person. */
  | "incomplete_round"
  /** A newer round on the same PR outlived this one. The benign explanation
   * the diagnosis refuted as the DOMINANT one: 6.5%, not the story. */
  | "superseded"
  /** An operator unwedge lever (`rerun-round` / `restart-session`). */
  | "operator"
  /** Legacy prose the migration could not classify. Never inferred as
   * benign: unknown is unknown. */
  | "unknown";

export const CANCEL_CAUSES: readonly CancelCause[] = [
  "orphan_sweep",
  "deadline_overrun",
  "lost_prompt",
  "head_moved",
  "incomplete_round",
  "superseded",
  "operator",
  "unknown",
];

/**
 * The causes that deserve a human (and the whole point of the ticket).
 *
 * `orphan_sweep` is deliberately NOT here: it is what a clean redeploy does to
 * every round in flight, it fired 38 times in eight days of heavy building, and
 * alarming on it would train everyone to ignore cancellation entirely — the
 * exact inversion found. `head_moved` and `superseded` are the system
 * working. What is left is a round that stopped dead: that gets an anomaly row.
 */
export const LOUD_CANCEL_CAUSES: ReadonlySet<CancelCause> = new Set<CancelCause>(["deadline_overrun"]);

export function isLoudCancelCause(cause: string | null | undefined): boolean {
  return cause !== null && cause !== undefined && LOUD_CANCEL_CAUSES.has(cause as CancelCause);
}

/** Short human labels — one wording, shared by the CLI, the digest and the TUI. */
export const CANCEL_CAUSE_LABEL: Record<CancelCause, string> = {
  orphan_sweep: "orphan sweep (redeploy)",
  deadline_overrun: "stopped dead",
  lost_prompt: "prompt lost",
  head_moved: "head moved",
  incomplete_round: "incomplete round",
  superseded: "superseded",
  operator: "operator",
  unknown: "unclassified",
};

export function cancelCauseLabel(cause: string | null | undefined): string {
  const key = (cause ?? "unknown") as CancelCause;
  return CANCEL_CAUSE_LABEL[key] ?? key;
}

/** One cause's tally, as every cancellation surface reports it. */
export interface CancellationTally {
  cause: CancelCause;
  count: number;
  /** Whether this cause is human-attention grade (`LOUD_CANCEL_CAUSES`). */
  loud: boolean;
}

/** One parsed row of the durable reasoning record. */
export interface RoundFindingRow {
  id: number;
  pr: number;
  round_id: number | null;
  round_no: number;
  head_sha: string;
  finding_key: string;
  path: string | null;
  line: number | null;
  lens: string;
  tier: string | null;
  /** 1 when the lens is not in the round's plan — the add protocol ran it. */
  unplanned: number;
  severity: string | null;
  confidence: number | null;
  reachability: string | null;
  kind: string | null;
  disposition: string;
  axis: string | null;
  word: string | null;
  reason: string | null;
  evidence: string | null;
  posted_as: string | null;
  raised_in_round: number | null;
  thread_id: number | null;
  recorded_at: string;
}

/**
 * What the store needs to write one recorded finding. Structural on purpose —
 * `FindingsRecordEntry` (src/findingsrecord.ts) satisfies it without state.ts
 * having to know anything about files, parsing or the record's schema.
 */
export interface RoundFindingInput {
  key: string;
  path?: string | null;
  line?: number | null;
  lens?: string | null;
  tier?: string | null;
  severity?: string | null;
  confidence?: number | null;
  reachability?: string | null;
  kind?: string | null;
  disposition?: string | null;
  axis?: string | null;
  word?: string | null;
  reason?: string | null;
  evidence?: string | null;
  posted_as?: string | null;
  raised_in_round?: number | null;
  thread_id?: number | null;
}

/** PR lifecycle facts for PRs the daemon never tracked (M2 backfill fills it).
 * Deliberately a separate table: no live query reads it, so importing hundreds
 * of historical PRs cannot leak into the board, status.json or dispatch. */
export interface BackfillPrMetaRow {
  pr: number;
  title: string;
  author: string;
  created_at: string;
  merged_at: string | null;
  closed_at: string | null;
  merged: number;
  imported_at: string;
}

// ---- Slack concierge rows ---------------------------------------
// Slack `ts` values are TEXT ALWAYS ("1755431234.001900"): they are opaque
// message ids whose precision a float would destroy.

/** Who a Slack message came from, in rights terms (resolved by the router). */
export type SlackTier = "anyone" | "author" | "owner_legacy" | "ignored";

/** What the router did with a Slack message. Everything that is not
 * `injected` names the reason it never reached a session. */
export type SlackDisposition =
  | "injected"
  | "dropped_echo"
  | "dropped_stale"
  | "dropped_cap"
  | "dropped_subtype"
  | "dropped_dupe"
  | "dropped_channel";

/** What the daemon posts into Slack. `kind` drives the caps in slack/policy. */
export type SlackPostKind = "reply" | "pickup" | "verdict" | "announce";

/** One PR ⇄ one Slack thread (the root message the daemon opened for it). */
export interface SlackThreadRow {
  pr: number;
  channel: string;
  root_ts: string;
  created_at: string;
  last_post_at: string | null;
  post_count: number;
}

export interface SlackEventRow {
  event_id: string;
  channel: string;
  ts: string;
  thread_ts: string | null;
  slack_user: string | null;
  tier: SlackTier;
  disposition: SlackDisposition;
  received_at: string;
  injected_at: string | null;
}

export interface SlackPostRow {
  id: number;
  idem_key: string;
  kind: SlackPostKind;
  pr: number | null;
  thread_ts: string | null;
  ts: string | null;
  chars: number;
  posted_at: string;
  ok: number;
  error: string | null;
}

export interface SlackCooldownRow {
  key: string;
  last_fired_at: string;
  warsaw_day: string;
  fire_count: number;
  /** Repeats swallowed inside the cooldown window (AlertPolicy fold counter). */
  fold_count: number;
  /** 1 once the one-per-Warsaw-day escalation bypass has been spent. */
  bypassed: number;
}

/** Deploy-window drain state (2026-08-25) — one persistent row. */
export interface DrainState {
  draining: boolean;
  /** Webhook deliveries dropped while the CURRENT drain window stood. */
  drained_deliveries: number;
  /** When the current drain was engaged; null when not draining. */
  since: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pr_state (
  number INTEGER PRIMARY KEY,
  state TEXT NOT NULL,
  head_sha TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  trigger_ts TEXT,
  stale_recheck INTEGER NOT NULL DEFAULT 0,
  -- LEGACY (escalation scrapped 2026-08-18): no longer read or written. Kept
  -- in the DDL so live databases, which cannot drop it without a table
  -- rebuild, keep satisfying its NOT NULL via the default.
  escalation_worthy INTEGER NOT NULL DEFAULT 0,
  migration_gate INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pr INTEGER NOT NULL,
  round_no INTEGER NOT NULL,
  round_type TEXT NOT NULL,
  lenses TEXT NOT NULL,
  verdict TEXT,
  spend_usd REAL,
  duration_s REAL,
  started_at TEXT NOT NULL,
  deadline_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running'
);
CREATE TABLE IF NOT EXISTS bot_comments (
  comment_id INTEGER PRIMARY KEY,
  pr INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'review_comment',
  posted_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS backfill_pr_meta (
  pr INTEGER PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  merged_at TEXT,
  closed_at TEXT,
  merged INTEGER NOT NULL DEFAULT 0,
  imported_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS deliveries (
  guid TEXT PRIMARY KEY,
  event TEXT NOT NULL,
  action TEXT,
  received_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  pr INTEGER,
  payload TEXT
);
-- The [feedback] tuning loop: explicit [feedback]-prefixed PR
-- comments plus behavioral signals (bot review dismissed, PR merged over a
-- standing block, bot comment deleted, trigger withdrawn). Deduped per kind
-- on its natural key so webhook redeliveries and reconcile overlaps never
-- double-ingest. day is the Warsaw day token the same-day addendum keys on.
CREATE TABLE IF NOT EXISTS feedback_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  pr INTEGER NOT NULL,
  comment_id INTEGER,
  review_id INTEGER,
  in_reply_to_id INTEGER,
  -- NOT NULL with an empty-string sentinel: SQL UNIQUE treats NULLs as
  -- distinct, which would void the comment-key dedupe for kinds without a
  -- scope (a re-delivered deleted-comment event would triple-write memory).
  scope TEXT NOT NULL DEFAULT '',
  author TEXT,
  body TEXT,
  day TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS feedback_by_comment
  ON feedback_signals (kind, scope, comment_id) WHERE comment_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS feedback_by_review
  ON feedback_signals (kind, review_id) WHERE review_id IS NOT NULL;
-- Keyless kinds (merged_over_block, trigger_withdrawn) dedupe per PR per
-- Warsaw day — a re-blocked, re-merged PR months later is a fresh signal.
CREATE UNIQUE INDEX IF NOT EXISTS feedback_by_pr_day
  ON feedback_signals (kind, pr, day) WHERE comment_id IS NULL AND review_id IS NULL;
-- Human-comment capture (deciding): every human comment on a
-- tracked PR, kept locally because the companion cannot read GitHub and review
-- prose has no other local copy (bot_comments stores ids only). A SIDE
-- RECORD — nothing here changes how a comment is routed, and nothing here
-- classifies it. Identity is GitHub's own (source, comment_id), never body
-- text, so a webhook delivery and a reconcile sweep of the same comment
-- collapse to one row.
CREATE TABLE IF NOT EXISTS pr_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pr INTEGER NOT NULL,
  -- 'review_comment' (inline) | 'issue_comment' (top-level) | 'review' (a
  -- submitted review's own body). Part of the identity: GitHub numbers review
  -- ids and comment ids in separate spaces.
  source TEXT NOT NULL,
  comment_id INTEGER NOT NULL,
  in_reply_to_id INTEGER,
  thread_id INTEGER,
  review_id INTEGER,
  author TEXT NOT NULL DEFAULT '',
  -- GitHub's account type. Only humans are captured; the column is what lets a
  -- reader still tell the two apart in the record itself.
  author_type TEXT NOT NULL DEFAULT 'User',
  -- 1 when the body starts with [feedback]. A fact about the text, not a
  -- verdict on it: the tag's privileges stay in feedback.ts.
  tagged INTEGER NOT NULL DEFAULT 0,
  path TEXT,
  line INTEGER,
  body TEXT NOT NULL DEFAULT '',
  created_at TEXT,
  captured_at TEXT NOT NULL,
  -- 'webhook' | 'reconcile' — which path saw it first, i.e. the webhook-health
  -- signal the sweep exists to expose.
  captured_via TEXT NOT NULL DEFAULT 'webhook'
);
CREATE UNIQUE INDEX IF NOT EXISTS pr_comments_identity ON pr_comments (source, comment_id);
CREATE INDEX IF NOT EXISTS pr_comments_pr ON pr_comments (pr, id);
-- The durable reasoning record (deciding): why each candidate
-- finding was raised or killed. Parsed out of the session-written
-- state/findings/pr-<n>-round-<k>.json — the file is the artifact, these are
-- the countable rows's "how often the review backs down" needs.
-- The unplanned flag is the daemon's own judgement (the lens is not in
-- rounds.lenses), never the session's: the add protocol lets the main pi run a
-- lens that appears in no plan, so the executed set is never assumed equal to
-- the plan.
CREATE TABLE IF NOT EXISTS round_findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pr INTEGER NOT NULL,
  round_id INTEGER,
  round_no INTEGER NOT NULL,
  head_sha TEXT NOT NULL DEFAULT '',
  finding_key TEXT NOT NULL,
  path TEXT,
  line INTEGER,
  lens TEXT NOT NULL DEFAULT '',
  tier TEXT,
  unplanned INTEGER NOT NULL DEFAULT 0,
  severity TEXT,
  confidence REAL,
  reachability TEXT,
  kind TEXT,
  -- posted | killed | downgraded | merged | folded | withheld | conceded |
  -- unknown. conceded = refuted-and-conceded: the state that lets a later
  -- round tell escalating an OPEN finding from resurrecting a SETTLED one.
  disposition TEXT NOT NULL DEFAULT 'unknown',
  axis TEXT,
  word TEXT,
  reason TEXT,
  evidence TEXT,
  posted_as TEXT,
  raised_in_round INTEGER,
  thread_id INTEGER,
  recorded_at TEXT NOT NULL
);
-- Re-recording a round (a re-nudge that finally lands, a sweep replay)
-- REPLACES its rows rather than doubling them.
CREATE UNIQUE INDEX IF NOT EXISTS round_findings_identity
  ON round_findings (pr, round_no, finding_key);
CREATE INDEX IF NOT EXISTS round_findings_pr ON round_findings (pr, round_no);
CREATE INDEX IF NOT EXISTS round_findings_lens ON round_findings (lens, disposition);
CREATE INDEX IF NOT EXISTS events_kind_pr ON events(kind, pr, id);
-- Wakes held while their PR's round was in flight (single-shepherd invariant
-- S4: the PR's ONE main pi is never given two instructions at once). Flushed
-- in insertion order once the round ends.
CREATE TABLE IF NOT EXISTS pending_wakes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  pr         INTEGER NOT NULL,
  payload    TEXT NOT NULL,
  reason     TEXT NOT NULL,
  held_at    TEXT NOT NULL,
  claim_token TEXT,
  claimed_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS pending_wakes_pr ON pending_wakes(pr, id);
-- The reviewed-head mark: one row per PR, the head this system last
-- reviewed. Deliberately NOT part of pr_state: the mark outlives lifecycle
-- churn and is read by guards that must not depend on the current state.
CREATE TABLE IF NOT EXISTS reviewed_heads (
  pr                   INTEGER PRIMARY KEY,
  head_sha             TEXT NOT NULL,
  reviewed_at          TEXT NOT NULL,
  verdict              TEXT,
  posted_event         TEXT,
  round_no             INTEGER,
  last_author_reply_at TEXT
);
-- Post-approval delta rechecks: one row per nudge actually sent.
-- The unique fingerprint is the runaway guard — a redelivered webhook or a
-- reconcile replay re-asks the same question exactly zero times.
CREATE TABLE IF NOT EXISTS rechecks (
  pr           INTEGER NOT NULL,
  fingerprint  TEXT NOT NULL,
  head_sha     TEXT NOT NULL,
  trigger      TEXT NOT NULL,
  reason       TEXT,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (pr, fingerprint)
);
-- Approval withheld for red CI: one row per PR, the head whose
-- approval was withheld and why. Presence of a row is the promise the gate
-- makes to the author — "this is waiting on CI alone" — and the thing the
-- ci_completed trigger reads to notice that CI went green. Cleared when the
-- PR is dispatched for another round, which is where the verdict is re-decided.
CREATE TABLE IF NOT EXISTS approval_withheld (
  pr         INTEGER PRIMARY KEY,
  head_sha   TEXT NOT NULL,
  ci_state   TEXT,
  reason     TEXT,
  created_at TEXT NOT NULL
);
-- Deploy-window drain (2026-08-25): ONE row, id = 1. While draining the
-- webhook drops deliveries (counted here), the pump starts nothing, and
-- recheck/ping-pong/EOD hold -- in-flight rounds still run to their natural
-- end. Persistent on purpose: the flag must survive the container restart the
-- drain exists for; it is lifted by the new boot's first HEALTHY reconcile
-- pass, or by an explicit 'drain off' command.
CREATE TABLE IF NOT EXISTS drain_state (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  draining           INTEGER NOT NULL DEFAULT 0,
  drained_deliveries INTEGER NOT NULL DEFAULT 0,
  since              TEXT,
  updated_at         TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS filed_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,           -- 'improvement_pr' | 'issue'
  title TEXT NOT NULL,
  ref TEXT,
  filed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS slack_threads (
  pr           INTEGER PRIMARY KEY,
  channel      TEXT NOT NULL,
  root_ts      TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_post_at TEXT,
  post_count   INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS slack_threads_root ON slack_threads(channel, root_ts);
CREATE TABLE IF NOT EXISTS slack_events (
  event_id     TEXT PRIMARY KEY,
  channel      TEXT NOT NULL,
  ts           TEXT NOT NULL,
  thread_ts    TEXT,
  slack_user   TEXT,
  tier         TEXT NOT NULL,
  disposition  TEXT NOT NULL,
  received_at  TEXT NOT NULL,
  injected_at  TEXT
);
CREATE TABLE IF NOT EXISTS slack_posts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  idem_key   TEXT NOT NULL UNIQUE,
  kind       TEXT NOT NULL,
  pr         INTEGER,
  thread_ts  TEXT,
  ts         TEXT,
  chars      INTEGER NOT NULL DEFAULT 0,
  posted_at  TEXT NOT NULL,
  ok         INTEGER NOT NULL DEFAULT 1,
  error      TEXT
);
CREATE INDEX IF NOT EXISTS slack_posts_day ON slack_posts(posted_at);
CREATE TABLE IF NOT EXISTS slack_cooldowns (
  key           TEXT PRIMARY KEY,
  last_fired_at TEXT NOT NULL,
  warsaw_day    TEXT NOT NULL,
  fire_count    INTEGER NOT NULL DEFAULT 1,
  fold_count    INTEGER NOT NULL DEFAULT 0,
  bypassed      INTEGER NOT NULL DEFAULT 0
);
`;

/**
 * The reviewed-head mark: the last head this system actually
 * reviewed on a PR, what it decided there, and the newest author reply seen
 * since. One row per PR — the mark is a *position*, not a history; the rounds
 * table keeps the history.
 *
 * Two readers: the no-new-evidence guard (posting time and dispatch time) and
 * the post-approval delta recheck that follows, which needs exactly
 * `head_sha` to diff the current head against.
 */
/** One row of the [feedback] tuning-loop ledger. */
export interface FeedbackSignalRow {
  id: number;
  kind: string;
  pr: number;
  comment_id: number | null;
  review_id: number | null;
  in_reply_to_id: number | null;
  /** '' for kinds without a comment surface (NOT NULL sentinel — see DDL). */
  scope: string;
  author: string | null;
  body: string | null;
  /** Warsaw day token (YYYY-MM-DD) — the same-day addendum's key. */
  day: string;
  created_at: string;
}

/** One captured human comment. `tagged` is 0/1 (SQLite boolean). */
export interface PrCommentRow {
  id: number;
  pr: number;
  source: string;
  comment_id: number;
  in_reply_to_id: number | null;
  thread_id: number | null;
  review_id: number | null;
  author: string;
  author_type: string;
  tagged: number;
  path: string | null;
  line: number | null;
  body: string;
  created_at: string | null;
  captured_at: string;
  captured_via: string;
}

export interface ReviewedHeadRow {
  pr: number;
  head_sha: string;
  /** When the mark was last (re)stamped — the instant author replies race. */
  reviewed_at: string;
  /** The verdict applied at this head, when one was ("APPROVE" | …). */
  verdict: string | null;
  /** The review event actually POSTed at this head, when one was. */
  posted_event: string | null;
  round_no: number | null;
  /** Newest author reply observed after the mark was stamped (new evidence). */
  last_author_reply_at: string | null;
}

/**
 * An approval withheld for red CI. The row says: this head was
 * reviewed, nothing blocked, and the approval is waiting on CI and nothing
 * else. Read by the `ci_completed` retry (cigate.ts) and by dispatch, which
 * treats a standing withholding as new evidence at the same head.
 */
export interface ApprovalWithheldRow {
  pr: number;
  head_sha: string;
  /** The CI state observed when the approval was withheld ("red" | "pending"). */
  ci_state: string | null;
  reason: string | null;
  created_at: string;
}

/** One recorded anomaly — the queryable twin of an overseer inject. */
export interface AnomalyRecord {
  ts: string;
  /** What went wrong: 'malformed' | 'overdue' | 'migration_precheck_degraded' | … */
  kind: string;
  pr: number | null;
  round_no: number | null;
  detail: string;
}

/** A wake held while its PR's round was in flight (single-shepherd S4). */
export interface PendingWakeRow {
  id: number;
  pr: number;
  payload: string;
  reason: string;
  held_at: string;
  claim_token: string | null;
  claimed_at: string | null;
  attempts: number;
}

/** Per-PR ceiling on held wakes. A PR whose author writes more than this while
 * one round runs loses the oldest holds — logged, never silent. */
export const MAX_HELD_WAKES = 5;

/**
 * How long an `overdue` round may sit before it counts as STRANDED.
 *
 * Deliberately far wider than `expire_overdue_after_h` (24h by config): that
 * sweep buries rounds whose PR has moved on, this one is about rounds nothing
 * will ever come back for. Seven days is "a week went by and nobody noticed",
 * which is precisely what happened to pr 4662 round 2.
 */
export const STRANDED_ROUND_HORIZON_H = 168;

/** Optional per-round facts recorded at (or just after) round start. */
export interface RoundStartMeta {
  additions?: number | null;
  deletions?: number | null;
  changed_files?: number | null;
  trigger_ts?: string | null;
  /** The tier the round's validator runs at. */
  validate_tier?: string | null;
}

export class StateStore {
  readonly db: Database.Database;

  constructor(path: string, private readonly now: () => Date = () => new Date()) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
    // Additive migration for stores created before pause-pr existed.
    try {
      this.db.exec("ALTER TABLE pr_state ADD COLUMN paused INTEGER NOT NULL DEFAULT 0");
    } catch {
      /* column already present */
    }
    try {
      this.db.exec("ALTER TABLE rounds ADD COLUMN summary TEXT");
    } catch {
      /* column already present */
    }
    // Metrics + backfill columns. Each ALTER is independent so a
    // partially-migrated store converges; re-running is a no-op.
    for (const ddl of [
      "ALTER TABLE rounds ADD COLUMN additions INTEGER",
      "ALTER TABLE rounds ADD COLUMN deletions INTEGER",
      "ALTER TABLE rounds ADD COLUMN changed_files INTEGER",
      "ALTER TABLE rounds ADD COLUMN backfilled INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE rounds ADD COLUMN gh_review_id INTEGER",
      "ALTER TABLE rounds ADD COLUMN gh_commit_id TEXT",
      "ALTER TABLE rounds ADD COLUMN trigger_ts TEXT",
      "ALTER TABLE bot_comments ADD COLUMN round_no INTEGER",
      // Measured usage — nullable, additive.
      "ALTER TABLE rounds ADD COLUMN tokens_in INTEGER",
      "ALTER TABLE rounds ADD COLUMN tokens_out INTEGER",
      "ALTER TABLE rounds ADD COLUMN tokens_cache_read INTEGER",
      "ALTER TABLE rounds ADD COLUMN est_usd REAL",
      // Slack concierge — cooldown fold/bypass memory, additive so a
      // store created by an earlier slice converges.
      "ALTER TABLE slack_cooldowns ADD COLUMN fold_count INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE slack_cooldowns ADD COLUMN bypassed INTEGER NOT NULL DEFAULT 0",
      // The validator's tier for the round — nullable, additive.
      "ALTER TABLE rounds ADD COLUMN validate_tier TEXT",
      // Executed-pass telemetry — JSON array, nullable, additive.
      "ALTER TABLE rounds ADD COLUMN executed_passes TEXT",
      // Trigger provenance — "human" | "system", nullable, additive.
      // Null = legacy/unknown, which dispatch treats as human (full round).
      "ALTER TABLE pr_state ADD COLUMN trigger_provenance TEXT",
      // hardening: first-seen-silent mark for the lost-prompt net —
      // nullable, additive.
      "ALTER TABLE rounds ADD COLUMN silent_since TEXT",
      // The prompt receipt token stamped into this round's wake file (#5362) —
      // nullable, additive. NULL means the round was dispatched by a build
      // that did not stamp one, so its delivery CANNOT be verified and every
      // reader must fall back to the older inference. Never backfill it: a
      // fabricated token would assert a receipt nobody ever saw.
      "ALTER TABLE rounds ADD COLUMN prompt_marker TEXT",
      // How many times this round's prompt has been re-delivered (#5362).
      // Redelivery is cheap and does NOT spend the self-requeue budget, so it
      // needs its own bound.
      "ALTER TABLE rounds ADD COLUMN redeliveries INTEGER NOT NULL DEFAULT 0",
      // The per-round comment count: how many inline comments the
      // round actually posted, as the SESSION reports it in its findings
      // record. Nullable — null is "unknown", distinct from 0 = "posted none".
      // The registry's own answer is bot_comments.round_no; the two disagreeing
      // is itself a signal, so both are kept.
      "ALTER TABLE rounds ADD COLUMN comments_posted INTEGER",
      // Why a cancelled round was cancelled — nullable, additive.
      // Null on every non-cancelled round; the boot migration classifies the
      // historical cancellations from their prose summary once.
      "ALTER TABLE rounds ADD COLUMN cancel_cause TEXT",
      // held wakes are leased and acked only after delivery.
      "ALTER TABLE pending_wakes ADD COLUMN claim_token TEXT",
      "ALTER TABLE pending_wakes ADD COLUMN claimed_at TEXT",
      "ALTER TABLE pending_wakes ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0",
    ]) {
      try {
        this.db.exec(ddl);
      } catch {
        /* column already present */
      }
    }
    this.runDataMigrations();
  }

  /**
   * One-shot, idempotent data migrations — run on every boot, after
   * the schema ALTERs, and safe on the live VM DB (pure UPDATEs, no DDL).
   *
   * 1. Spend fold: `spend_usd` is retired — `est_usd` is the ONE spend field.
   *    Legacy self-reported figures with no measured value fold into est_usd
   *    so history keeps its cost; re-running matches nothing.
   * 2. Zombie expiry: the Aug 13–14 shakeout left rounds stuck `overdue`
   *    forever, polluting aggregates. Rounds from before 2026-08-15 whose PR
   *    has since verdicted (a round of the same or higher number delivered a
   *    verdict) or closed move to terminal `expired`. Rounds a rerun could
   *    still service (open PR, nothing decided since) are left alone — live
   *    rerun of a stuck round is's job, never this one's.
   * 3. Cancel-cause backfill: every cancellation before this slice
   *    recorded its reason as PROSE in `summary` and nothing read it back.
   *    The prose is stable (each cancelling call site writes one fixed
   *    phrasing), so it classifies exactly once here into `cancel_cause`.
   *    Anything that does not match stays `unknown` — never guessed benign.
   */
  private runDataMigrations(): void {
    this.db
      .prepare("UPDATE rounds SET est_usd = spend_usd WHERE est_usd IS NULL AND spend_usd IS NOT NULL")
      .run();
    const info = this.db
      .prepare(
        `UPDATE rounds SET status = 'expired', finished_at = COALESCE(finished_at, @now)
          WHERE status = 'overdue'
            AND started_at < '2026-08-15'
            AND (
              EXISTS (SELECT 1 FROM pr_state p WHERE p.number = rounds.pr AND p.state = 'closed')
              OR EXISTS (SELECT 1 FROM rounds r2 WHERE r2.pr = rounds.pr AND r2.id != rounds.id
                           AND r2.backfilled = 0 AND r2.verdict IS NOT NULL AND r2.round_no >= rounds.round_no)
            )`,
      )
      .run({ now: this.ts() });
    if (info.changes > 0) this.logEvent("rounds_expired", null, { count: info.changes, one_shot: true });
    this.classifyLegacyCancellations();
  }

  /** backfill: read the historical cancellation prose into
   * `cancel_cause`. Idempotent (only NULL causes are touched) and additive —
   * it never rewrites `summary`, which stays the human record. */
  private classifyLegacyCancellations(): void {
    const info = this.db
      .prepare(
        `UPDATE rounds SET cancel_cause = CASE
            WHEN summary LIKE 'orphaned —%'                       THEN 'orphan_sweep'
            WHEN summary LIKE 'superseded —%'                     THEN 'superseded'
            WHEN summary LIKE 'cancelled by %'                    THEN 'operator'
            WHEN summary LIKE '%passed its deadline%'             THEN 'deadline_overrun'
            WHEN summary LIKE '%dropped in delivery%'             THEN 'lost_prompt'
            WHEN summary LIKE '%head_moved%'                      THEN 'head_moved'
            WHEN summary LIKE '%without executing any passes%'    THEN 'incomplete_round'
            ELSE 'unknown'
          END
          WHERE status = 'cancelled' AND cancel_cause IS NULL`,
      )
      .run();
    if (info.changes > 0) this.logEvent("cancel_causes_backfilled", null, { count: info.changes });
  }

  close(): void {
    this.db.close();
  }

  private ts(): string {
    return this.now().toISOString();
  }

  // ---- pr_state ----------------------------------------------------------

  getPr(n: number): PrStateRow | undefined {
    return this.db.prepare("SELECT * FROM pr_state WHERE number = ?").get(n) as PrStateRow | undefined;
  }

  allPrs(): PrStateRow[] {
    return this.db.prepare("SELECT * FROM pr_state ORDER BY number").all() as PrStateRow[];
  }

  /** `paused` is deliberately not part of the upsert: it is owned by
   * setPaused() so state transitions can never clobber an overseer pause.
   * `trigger_provenance` is optional for callers that predate it —
   * absent means null, i.e. the full-round default. */
  upsertPr(
    row: Omit<PrStateRow, "updated_at" | "paused" | "trigger_provenance"> & {
      paused?: number;
      trigger_provenance?: TriggerProvenance | null;
    },
  ): void {
    this.db
      .prepare(
        `INSERT INTO pr_state (number, state, head_sha, title, author, trigger_ts, trigger_provenance, stale_recheck, migration_gate, updated_at)
         VALUES (@number, @state, @head_sha, @title, @author, @trigger_ts, @trigger_provenance, @stale_recheck, @migration_gate, @updated_at)
         ON CONFLICT(number) DO UPDATE SET
           state=@state, head_sha=@head_sha, title=@title, author=@author, trigger_ts=@trigger_ts,
           trigger_provenance=@trigger_provenance, stale_recheck=@stale_recheck, migration_gate=@migration_gate,
           updated_at=@updated_at`,
      )
      .run(
        (({ paused: _paused, ...cols }) => ({
          ...cols,
          trigger_provenance: row.trigger_provenance ?? null,
          updated_at: this.ts(),
        }))(row),
      );
  }

  setPaused(n: number, paused: boolean): void {
    this.db.prepare("UPDATE pr_state SET paused = ?, updated_at = ? WHERE number = ?").run(paused ? 1 : 0, this.ts(), n);
  }

  setPrState(n: number, state: PrLifecycleState): void {
    this.db.prepare("UPDATE pr_state SET state = ?, updated_at = ? WHERE number = ?").run(state, this.ts(), n);
  }

  // ---- rounds ------------------------------------------------------------

  startRound(
    pr: number,
    roundType: string,
    lenses: string[],
    deadlineMin: number,
    meta: RoundStartMeta = {},
  ): number {
    const started = this.now();
    const deadline = new Date(started.getTime() + deadlineMin * 60_000);
    const nextNo = ((this.db.prepare("SELECT MAX(round_no) AS m FROM rounds WHERE pr = ?").get(pr) as { m: number | null }).m ?? 0) + 1;
    const info = this.db
      .prepare(
        `INSERT INTO rounds (pr, round_no, round_type, lenses, started_at, deadline_at, status,
                             additions, deletions, changed_files, trigger_ts, validate_tier)
         VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)`,
      )
      .run(
        pr,
        nextNo,
        roundType,
        lenses.join(","),
        started.toISOString(),
        deadline.toISOString(),
        meta.additions ?? null,
        meta.deletions ?? null,
        meta.changed_files ?? null,
        meta.trigger_ts ?? null,
        meta.validate_tier ?? null,
      );
    return Number(info.lastInsertRowid);
  }

  /** Diffstat/trigger stamp for a round that already exists (late arrival). */
  setRoundMeta(id: number, meta: RoundStartMeta): void {
    const sets: string[] = [];
    const args: Array<number | string | null> = [];
    for (const key of ["additions", "deletions", "changed_files", "trigger_ts", "validate_tier"] as const) {
      if (meta[key] !== undefined) {
        sets.push(`${key} = ?`);
        args.push(meta[key] as number | string | null);
      }
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE rounds SET ${sets.join(", ")} WHERE id = ?`).run(...args, id);
  }

  /** Rounds that actually DELIVERED a verdict for a PR — backfilled history
   * and dead rounds (cancelled/orphaned/overdue: verdict NULL) excluded.
   * Dispatch's first-review-vs-re-review choice and the nit-cap "review age"
   * key on this (§2.1; live 2026-08-18: #5313's two failed rounds
   * aged it to a "round 3 re-review" with the nit cap active despite zero
   * posted reviews — a failed round must not age the PR).
   *
   * **Read the name carefully (finding 3).** This is not "how
   * many rounds has this PR had"; it is "how many rounds DELIVERED a verdict".
   * A PR whose first round is cancelled therefore produces a SECOND round
   * still typed `"first"`, and the `first` / `re-review` split in `round_type`
   * really means *has this PR ever been successfully reviewed*. That is the
   * ratified behaviour and stays (a failed round must not age the PR, nor
   * switch the nit cap on for a review the author never saw) — but any
   * measurement that reads `round_type` as "round ordinal" is reading it
   * wrong, and `rounds.round_no` is the ordinal it wants. Pinned by
   * tests/state.test.ts. */
  priorRoundCount(pr: number): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) AS c FROM rounds WHERE pr = ? AND backfilled = 0 AND verdict IS NOT NULL")
        .get(pr) as { c: number }
    ).c;
  }

  roundsFor(pr: number): RoundRow[] {
    return this.db.prepare("SELECT * FROM rounds WHERE pr = ? ORDER BY round_no").all(pr) as RoundRow[];
  }

  allRounds(): RoundRow[] {
    return this.db.prepare("SELECT * FROM rounds ORDER BY started_at, id").all() as RoundRow[];
  }

  /** `estUsd` is a caller-supplied initial estimate; it lands in `est_usd` (the
   * ONE spend field) only when no measured figure exists yet —
   * recordRoundUsage's measurement always supersedes it. The retired
   * `spend_usd` column is never written. */
  finishRound(id: number, verdict: string, estUsd: number | null, summary: string | null = null): void {
    const row = this.db.prepare("SELECT started_at FROM rounds WHERE id = ?").get(id) as { started_at: string } | undefined;
    const duration = row ? (this.now().getTime() - Date.parse(row.started_at)) / 1000 : null;
    this.db
      .prepare(
        "UPDATE rounds SET verdict = ?, est_usd = COALESCE(est_usd, ?), duration_s = ?, finished_at = ?, summary = ?, status = 'done' WHERE id = ?",
      )
      .run(verdict, estUsd, duration, this.ts(), summary, id);
  }

  /** Measured usage for a round (pi session JSONLs). Overwrites —
   * a re-measured round keeps only the latest figures. */
  recordRoundUsage(
    id: number,
    usage: { tokens_in: number; tokens_out: number; tokens_cache_read?: number | null; est_usd: number | null },
  ): void {
    this.db
      .prepare("UPDATE rounds SET tokens_in = ?, tokens_out = ?, tokens_cache_read = ?, est_usd = ? WHERE id = ?")
      .run(usage.tokens_in, usage.tokens_out, usage.tokens_cache_read ?? null, usage.est_usd, id);
  }

  /**
   * Executed-pass telemetry for a round — what the session reported
   * it ACTUALLY ran, stored beside (never instead of) the planned `lenses`.
   * Overwrites: a re-delivered verdict keeps only the latest report.
   */
  recordExecutedPasses(id: number, passes: readonly VerdictPassEntry[]): void {
    this.db.prepare("UPDATE rounds SET executed_passes = ? WHERE id = ?").run(JSON.stringify(passes), id);
  }

  /** Parsed executed-pass telemetry; null = unknown (absent or unparseable —
   * an unparseable stored value reads as unknown, matching the input side). */
  executedPasses(id: number): VerdictPassEntry[] | null {
    const row = this.db.prepare("SELECT executed_passes FROM rounds WHERE id = ?").get(id) as
      | { executed_passes: string | null }
      | undefined;
    if (!row?.executed_passes) return null;
    try {
      const parsed = JSON.parse(row.executed_passes);
      return Array.isArray(parsed) ? (parsed as VerdictPassEntry[]) : null;
    } catch {
      return null;
    }
  }

  // ---- the durable reasoning record ----------------------------

  /** The per-round comment count: how many inline comments the round posted,
   * as the session reported it. Idempotent overwrite. */
  recordRoundComments(id: number, count: number): void {
    this.db.prepare("UPDATE rounds SET comments_posted = ? WHERE id = ?").run(Math.max(0, Math.trunc(count)), id);
  }

  /**
   * Store one round's reasoning record as rows.
   *
   * `planned` is the round's PLAN (`rounds.lenses`), used only to stamp
   * `unplanned` — a lens outside it is recorded, never rejected: the add
   * protocol lets the main pi run a lens that appears in no plan, so the
   * executed set is never assumed equal to the plan.
   *
   * Idempotent per (pr, round_no, finding_key): a record that arrives twice
   * (re-nudge landing, sweep replay) replaces its rows instead of doubling
   * them. Returns how many entries were stored.
   */
  recordRoundFindings(
    round: { pr: number; round_id: number | null; round_no: number; head_sha: string | null },
    findings: readonly RoundFindingInput[],
    planned: readonly string[] = [],
  ): number {
    const plan = new Set(planned.filter(Boolean));
    const at = this.ts();
    const stmt = this.db.prepare(
      `INSERT INTO round_findings
         (pr, round_id, round_no, head_sha, finding_key, path, line, lens, tier, unplanned,
          severity, confidence, reachability, kind, disposition, axis, word, reason, evidence,
          posted_as, raised_in_round, thread_id, recorded_at)
       VALUES
         (@pr, @round_id, @round_no, @head_sha, @finding_key, @path, @line, @lens, @tier, @unplanned,
          @severity, @confidence, @reachability, @kind, @disposition, @axis, @word, @reason, @evidence,
          @posted_as, @raised_in_round, @thread_id, @recorded_at)
       ON CONFLICT(pr, round_no, finding_key) DO UPDATE SET
         round_id=@round_id, head_sha=@head_sha, path=@path, line=@line, lens=@lens, tier=@tier,
         unplanned=@unplanned, severity=@severity, confidence=@confidence, reachability=@reachability,
         kind=@kind, disposition=@disposition, axis=@axis, word=@word, reason=@reason,
         evidence=@evidence, posted_as=@posted_as, raised_in_round=@raised_in_round,
         thread_id=@thread_id, recorded_at=@recorded_at`,
    );
    const write = this.db.transaction((rows: readonly RoundFindingInput[]) => {
      for (const f of rows) {
        stmt.run({
          pr: round.pr,
          round_id: round.round_id,
          round_no: round.round_no,
          head_sha: round.head_sha ?? "",
          finding_key: f.key,
          path: f.path ?? null,
          line: f.line ?? null,
          lens: f.lens ?? "",
          tier: f.tier ?? null,
          // Unknown-lens entries are never called "unplanned": that would
          // assert a fact about a lens the record does not name.
          unplanned: f.lens && plan.size > 0 && !plan.has(f.lens) ? 1 : 0,
          severity: f.severity ?? null,
          confidence: f.confidence ?? null,
          reachability: f.reachability ?? null,
          kind: f.kind ?? null,
          disposition: f.disposition ?? "unknown",
          axis: f.axis ?? null,
          word: f.word ?? null,
          reason: f.reason ?? null,
          evidence: f.evidence ?? null,
          posted_as: f.posted_as ?? null,
          raised_in_round: f.raised_in_round ?? null,
          thread_id: f.thread_id ?? null,
          recorded_at: at,
        });
      }
    });
    write(findings);
    return findings.length;
  }

  /** Every recorded finding for a PR, oldest round first. */
  roundFindings(pr: number): RoundFindingRow[] {
    return this.db
      .prepare("SELECT * FROM round_findings WHERE pr = ? ORDER BY round_no, id")
      .all(pr) as RoundFindingRow[];
  }

  /** Findings for one round. */
  findingsForRound(pr: number, roundNo: number): RoundFindingRow[] {
    return this.db
      .prepare("SELECT * FROM round_findings WHERE pr = ? AND round_no = ? ORDER BY id")
      .all(pr, roundNo) as RoundFindingRow[];
  }

  /**
   * The refuted-and-conceded set for a PR: findings a previous round posted,
   * the author refuted, and the reviewer accepted the refutation on. This is
   * what lets a later round tell "escalating an OPEN finding" — legitimate,
   * and deliberately so (the owner, 2026-08-19: blocking late beats never) —
   * from "resurrecting a SETTLED one", which is not.
   */
  concededFindings(pr: number): RoundFindingRow[] {
    return this.db
      .prepare("SELECT * FROM round_findings WHERE pr = ? AND disposition = 'conceded' ORDER BY round_no, id")
      .all(pr) as RoundFindingRow[];
  }

  /**
   * The once-per-round findings-record re-nudge mark — the
   * ledger idiom exactly: events-table backed, so no new DDL and boot-safe on
   * the live DB by construction. Scanned with no recency window; the cap is
   * per round, not per recent history.
   */
  recordFindingsNudge(pr: number, key: string, extra?: Record<string, unknown>): void {
    this.logEvent("findings_record_nudged", pr, { key, ...(extra ?? {}) });
  }

  /** Was the findings-record re-nudge for this (pr, key) already sent? */
  findingsNudgeSent(pr: number, key: string): boolean {
    const rows = this.db
      .prepare("SELECT payload FROM events WHERE kind = 'findings_record_nudged' AND pr = ?")
      .all(pr) as Array<{ payload: string | null }>;
    return rows.some((r) => {
      if (!r.payload) return false;
      try {
        return (JSON.parse(r.payload) as { key?: unknown }).key === key;
      } catch {
        return false;
      }
    });
  }

  /** A dispatch attempt creates its round row before handing the order to the
   * session hook. If that handoff fails, remove the provisional row so it
   * cannot consume capacity or inflate the round number on retry. */
  discardRunningRound(id: number): void {
    this.db.prepare("DELETE FROM rounds WHERE id = ? AND status = 'running'").run(id);
  }

  markRoundOverdue(id: number): void {
    // Stamp `finished_at` (#5362 W8). An overdue round is terminal — nothing
    // reruns it, `expireOverdueRounds` only reaches it once the PR has closed
    // or verdicted on a later round, and a PR whose ONLY round blew its
    // deadline satisfies neither. Leaving `finished_at` NULL therefore left a
    // row whose "duration" grew forever: #4662 round 2 read as a 10,197-minute
    // round, seven days after it was judged. The status is deliberately NOT
    // changed to `expired` here — that would drop the round from spend and
    // every other aggregate, hiding tokens this round really burned.
    this.db
      .prepare("UPDATE rounds SET status = 'overdue', finished_at = COALESCE(finished_at, ?) WHERE id = ?")
      .run(this.ts(), id);
  }

  /** Administrative close of a round that will never produce a verdict —
   * superseded by a newer round, or orphaned when its tmux session died.
   * Unlike overdue it carries no anomaly semantics and touches no PR state.
   *
   * `cause` is the machine-readable half of `reason`: cancellation
   * is grouped by it everywhere it is now surfaced, and a caller that omits it
   * lands in `unknown` rather than being silently folded into a benign bucket.
   * Every live call site passes one — the default exists for tests and for
   * paths added later, and `unknown` showing up in the tallies is itself the
   * signal that a new cancelling path forgot to declare itself. */
  markRoundCancelled(id: number, reason: string, cause: CancelCause = "unknown"): void {
    this.db
      .prepare(
        "UPDATE rounds SET status = 'cancelled', summary = ?, cancel_cause = ?, finished_at = ? WHERE id = ? AND status = 'running'",
      )
      .run(reason, cause, this.ts(), id);
  }

  /**
   * Cancellations grouped by cause — the query the diagnosis had to
   * reconstruct by grepping prose. `since` is an inclusive ISO lower bound on
   * `started_at`; null is all of history. Ordered loud-first, then by count,
   * so the surface that renders it does not have to know the policy.
   */
  cancellationsByCause(since: string | null = null): CancellationTally[] {
    const rows = this.db
      .prepare(
        `SELECT COALESCE(cancel_cause, 'unknown') AS cause, COUNT(*) AS c
           FROM rounds WHERE status = 'cancelled' AND (@since IS NULL OR started_at >= @since)
          GROUP BY cause`,
      )
      .all({ since }) as Array<{ cause: string; c: number }>;
    return rows
      .map((r) => ({ cause: r.cause as CancelCause, count: r.c, loud: isLoudCancelCause(r.cause) }))
      .sort((a, b) => Number(b.loud) - Number(a.loud) || b.count - a.count || a.cause.localeCompare(b.cause));
  }

  /** The cancelled rounds a human should look at — loud causes only. */
  loudCancellations(since: string | null = null): RoundRow[] {
    const causes = [...LOUD_CANCEL_CAUSES];
    const holes = causes.map(() => "?").join(",");
    return this.db
      .prepare(
        `SELECT * FROM rounds WHERE status = 'cancelled' AND cancel_cause IN (${holes})
           AND (? IS NULL OR started_at >= ?) ORDER BY started_at`,
      )
      .all(...causes, since, since) as RoundRow[];
  }

  /** hardening: stamp the first sweep that saw this round fully
   * silent. Idempotent — the first observation wins, so two sweeps' spacing
   * is real elapsed time, never a same-tick double-write. */
  markRoundSilent(id: number): void {
    this.db
      .prepare("UPDATE rounds SET silent_since = ? WHERE id = ? AND silent_since IS NULL AND status = 'running'")
      .run(this.ts(), id);
  }

  /** Clear the first-seen-silent mark: the round showed a sign of life (or an
   * ambiguous signal) — silence must be observed on consecutive sweeps. */
  clearRoundSilent(id: number): void {
    this.db.prepare("UPDATE rounds SET silent_since = NULL WHERE id = ?").run(id);
  }

  /**
   * Cancel every running round on a PR and return their ids (#5362 W4).
   *
   * The operator's two unwedge levers — `rerun-round` and `restart-session` —
   * both set the PR back to `queued` and pump, but the pump skips a PR whose
   * round is still `running` ("one PR = one worktree = at most one round"), so
   * neither could clear a phantom round: the state flipped, nothing
   * dispatched, and the PR sat queued behind a round that would never end.
   * The anomaly message told the overseer to run `rerun-round` for exactly the
   * case `rerun-round` could not fix.
   *
   * Cancelling is the missing half. It never touches GitHub and never posts:
   * the round keeps a NULL verdict, so `priorRoundCount`/review_no do not age
   * (a failed round must not age the PR), which is the same discipline the
   * self-requeue path follows.
   */
  cancelRunningRounds(pr: number, reason: string): number[] {
    const rows = this.db
      .prepare("SELECT id, round_no FROM rounds WHERE pr = ? AND status = 'running'")
      .all(pr) as Array<{ id: number; round_no: number }>;
    for (const r of rows) {
      this.markRoundCancelled(r.id, `cancelled by ${reason}`, "operator");
      this.logEvent("round_cancelled_by_operator", pr, { round_id: r.id, round_no: r.round_no, reason });
    }
    return rows.map((r) => r.id);
  }

  /** Push a running round's deadline out from NOW (#5362). Used only when the
   * round has not started — its prompt never reached the session — so none of
   * the elapsed time was review time and the full window is owed again. */
  extendRoundDeadline(id: number, minutes: number): void {
    const deadline = new Date(this.now().getTime() + minutes * 60_000).toISOString();
    this.db.prepare("UPDATE rounds SET deadline_at = ? WHERE id = ? AND status = 'running'").run(deadline, id);
  }

  /** Record the receipt token stamped into this round's wake file (#5362).
   * Written at dispatch, read by the prompt-receipt check. A round with a NULL
   * marker was dispatched by a build that stamped none — its delivery cannot
   * be verified, and readers must say "unknown" rather than "not delivered". */
  stampPromptMarker(id: number, marker: string): void {
    this.db.prepare("UPDATE rounds SET prompt_marker = ? WHERE id = ?").run(marker, id);
  }

  /** Count one re-delivery of a round's prompt and return the new total
   * (#5362). Redelivery is the cheap recovery — rewrite the wake file, same
   * round, same session, same conversation — so it is bounded separately from
   * `max_self_requeues`, which is the expensive one (a fresh round, and for a
   * live-but-wedged session a kill). */
  countRedelivery(id: number): number {
    this.db.prepare("UPDATE rounds SET redeliveries = redeliveries + 1 WHERE id = ?").run(id);
    const row = this.db.prepare("SELECT redeliveries FROM rounds WHERE id = ?").get(id) as
      | { redeliveries: number }
      | undefined;
    return row?.redeliveries ?? 0;
  }

  /** PRs holding wakes with no round running (#5362 W3). `flushHeldWakes` is
   * driven only by the verdict and anomaly paths, so a round cancelled as
   * superseded, orphaned-without-requeue, or self-requeued into a chain that
   * never verdicts leaves its held wakes — author replies included — in this
   * table with nothing left to flush them. The reconcile sweep reads this. */
  prsWithStrandedWakes(): number[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT w.pr AS pr FROM pending_wakes w
          WHERE NOT EXISTS (SELECT 1 FROM rounds r WHERE r.pr = w.pr AND r.status = 'running')`,
      )
      .all() as Array<{ pr: number }>;
    return rows.map((r) => r.pr);
  }

  /** True when a newer round exists for the PR (any status) — the given round
   * is historical and must not drive deadline/overdue side effects. */
  hasLaterRound(pr: number, roundNo: number): boolean {
    const row = this.db
      .prepare("SELECT COUNT(*) AS c FROM rounds WHERE pr = ? AND round_no > ?")
      .get(pr, roundNo) as { c: number };
    return row.c > 0;
  }

  runningRounds(): RoundRow[] {
    return this.db.prepare("SELECT * FROM rounds WHERE status = 'running' ORDER BY started_at").all() as RoundRow[];
  }

  /** True while this PR has a round in flight — the S4 test before any wake. */
  hasRunningRound(pr: number): boolean {
    const row = this.db.prepare("SELECT COUNT(*) AS c FROM rounds WHERE pr = ? AND status = 'running'").get(pr) as { c: number };
    return row.c > 0;
  }

  // ---- held wakes (single-shepherd S4) -----------------------------------

  /** Hold a rendered wake until this PR's round ends. Returns the ids dropped
   * to stay under `cap` (oldest first) so the caller can log them — a silently
   * dropped author reply is worse than a late one. */
  holdWake(pr: number, payload: string, reason: string, cap = MAX_HELD_WAKES): number[] {
    this.db
      .prepare("INSERT INTO pending_wakes (pr, payload, reason, held_at) VALUES (?, ?, ?, ?)")
      .run(pr, payload, reason, this.now().toISOString());
    const overflow = this.db
      .prepare("SELECT id FROM pending_wakes WHERE pr = ? ORDER BY id DESC LIMIT -1 OFFSET ?")
      .all(pr, cap) as Array<{ id: number }>;
    for (const row of overflow) this.db.prepare("DELETE FROM pending_wakes WHERE id = ?").run(row.id);
    return overflow.map((r) => r.id);
  }

  heldWakes(pr: number): PendingWakeRow[] {
    return this.db.prepare("SELECT * FROM pending_wakes WHERE pr = ? ORDER BY id").all(pr) as PendingWakeRow[];
  }

  /** Lease only the oldest held wake. A live lease blocks later rows so
   * concurrent flushers cannot reorder author messages. */
  claimNextHeldWake(pr: number, token: string, leaseBefore: string): PendingWakeRow | null {
    const claim = this.db.transaction((n: number): PendingWakeRow | null => {
      const row = this.db.prepare("SELECT * FROM pending_wakes WHERE pr = ? ORDER BY id LIMIT 1").get(n) as PendingWakeRow | undefined;
      if (!row) return null;
      if (row.claim_token && row.claimed_at && row.claimed_at > leaseBefore) return null;
      const now = this.now().toISOString();
      const changed = this.db.prepare(
        `UPDATE pending_wakes SET claim_token=?, claimed_at=?, attempts=attempts+1
          WHERE id=? AND (claim_token IS NULL OR claimed_at IS NULL OR claimed_at <= ?)`,
      ).run(token, now, row.id, leaseBefore).changes;
      if (changed !== 1) return null;
      return this.db.prepare("SELECT * FROM pending_wakes WHERE id = ?").get(row.id) as PendingWakeRow;
    });
    return claim(pr);
  }

  ackHeldWake(id: number, token: string): boolean {
    return this.db.prepare("DELETE FROM pending_wakes WHERE id = ? AND claim_token = ?").run(id, token).changes === 1;
  }

  releaseHeldWake(id: number, token: string): boolean {
    return this.db.prepare(
      "UPDATE pending_wakes SET claim_token=NULL, claimed_at=NULL WHERE id = ? AND claim_token = ?",
    ).run(id, token).changes === 1;
  }

  /** Explicit destructive cleanup for a closed PR; never use for delivery. */
  dropHeldWakes(pr: number): number {
    return this.db.prepare("DELETE FROM pending_wakes WHERE pr = ?").run(pr).changes;
  }

  roundsOn(dateIso: string): RoundRow[] {
    return this.db.prepare("SELECT * FROM rounds WHERE started_at LIKE ? ORDER BY started_at").all(`${dateIso}%`) as RoundRow[];
  }

  /**
   * est_usd is the ONE spend field (legacy spend_usd folded into it
   * at boot).
   *
   * **Expired rounds ARE counted** (finding 1, fixed).
   * They used to be filtered out here and in every other spend aggregate, on
   * the reasoning that a zombie row should not pollute the numbers —
   * but a round that blew its deadline still ran the passes and still burned
   * the tokens, so excluding it did not remove noise, it ERASED REAL COST.
   * Expiry is a bookkeeping status, not a refund. Round *counts* and duration
   * statistics still exclude them (see metrics.ts): those are the figures an
   * abandoned row genuinely distorts.
   */
  totalSpend(): number {
    return (this.db.prepare("SELECT COALESCE(SUM(est_usd), 0) AS s FROM rounds").get() as { s: number }).s;
  }

  /**
   * Recurring zombie expiry: move to terminal `expired` every round
   * stuck `overdue` past `horizonHours` (measured from its deadline) whose PR
   * has since verdicted (same-or-higher round number delivered a verdict) or
   * closed. Deliberately narrower than "any old overdue round": a round a
   * rerun could still service (open PR, nothing decided since) is
   * to rescue, never this sweep's to bury. Returns the expired round ids.
   */
  expireOverdueRounds(horizonHours: number): number[] {
    const cutoff = new Date(this.now().getTime() - horizonHours * 3_600_000).toISOString();
    const rows = this.db
      .prepare(
        `SELECT id, pr, round_no FROM rounds
          WHERE status = 'overdue' AND deadline_at < ?
            AND (
              EXISTS (SELECT 1 FROM pr_state p WHERE p.number = rounds.pr AND p.state = 'closed')
              OR EXISTS (SELECT 1 FROM rounds r2 WHERE r2.pr = rounds.pr AND r2.id != rounds.id
                           AND r2.backfilled = 0 AND r2.verdict IS NOT NULL AND r2.round_no >= rounds.round_no)
            )`,
      )
      .all(cutoff) as Array<{ id: number; pr: number; round_no: number }>;
    if (rows.length === 0) return [];
    const stamp = this.db.prepare(
      "UPDATE rounds SET status = 'expired', finished_at = COALESCE(finished_at, ?) WHERE id = ? AND status = 'overdue'",
    );
    for (const r of rows) stamp.run(this.ts(), r.id);
    this.logEvent("rounds_expired", null, { count: rows.length, rounds: rows.map((r) => ({ id: r.id, pr: r.pr, round_no: r.round_no })) });
    return rows.map((r) => r.id);
  }

  /**
   * The rounds `expireOverdueRounds` deliberately refuses to bury.
   *
   * Its guard is narrow on purpose: an `overdue` round whose PR is still open
   * and still undecided might yet be rescued by a rerun, and burying it would
   * hide a PR that was never reviewed. But nothing ever reruns an overdue
   * round automatically — `markRoundOverdue` is terminal — so in practice such
   * a row just SITS there. found exactly one, stranded since the
   * 2026-08-14 cutover: pr 4662 round 2, ten days overdue, invisible.
   *
   * A round past this far wider horizon is not "pending rescue", it is
   * stranded, and the answer is to say so out loud (the caller raises the
   * anomaly) rather than to keep quietly not-deciding. `sinceHours` is
   * measured from the deadline.
   */
  strandedOverdueRounds(horizonHours: number = STRANDED_ROUND_HORIZON_H): RoundRow[] {
    const cutoff = new Date(this.now().getTime() - horizonHours * 3_600_000).toISOString();
    return this.db
      .prepare("SELECT * FROM rounds WHERE status = 'overdue' AND deadline_at < ? ORDER BY deadline_at")
      .all(cutoff) as RoundRow[];
  }

  /**
   * Terminalize the stranded rounds above. Returns the rows as they
   * were, so the caller can name each one in its anomaly — after this they are
   * `expired`, which since no longer erases their spend, so nothing is
   * lost by closing the row. The PR is NOT requeued and GitHub is not touched:
   * deciding to redo a ten-day-old review is a human's call, and this sweep's
   * whole job is to make sure a human is told.
   */
  expireStrandedRounds(horizonHours: number = STRANDED_ROUND_HORIZON_H): RoundRow[] {
    const rows = this.strandedOverdueRounds(horizonHours);
    if (rows.length === 0) return [];
    const stamp = this.db.prepare(
      "UPDATE rounds SET status = 'expired', finished_at = COALESCE(finished_at, ?) WHERE id = ? AND status = 'overdue'",
    );
    for (const r of rows) stamp.run(this.ts(), r.id);
    this.logEvent("rounds_stranded", null, {
      count: rows.length,
      horizon_h: horizonHours,
      rounds: rows.map((r) => ({ id: r.id, pr: r.pr, round_no: r.round_no, deadline_at: r.deadline_at })),
    });
    return rows;
  }

  // ---- backfilled rounds (M2 importer writes; nothing live reads them) ----

  /** Every GitHub review id already imported — the idempotence key set. */
  importedReviewIds(): Set<number> {
    const rows = this.db.prepare("SELECT gh_review_id AS id FROM rounds WHERE gh_review_id IS NOT NULL").all() as Array<{ id: number }>;
    return new Set(rows.map((r) => r.id));
  }

  /** Lowest round_no on a PR (null when it has no rounds) — the importer
   * numbers historical rounds *below* it so live numbering is never disturbed. */
  minRoundNo(pr: number): number | null {
    return (this.db.prepare("SELECT MIN(round_no) AS m FROM rounds WHERE pr = ?").get(pr) as { m: number | null }).m;
  }

  /** Start of the daemon era: the oldest natively-run round. Reviews submitted
   * at or after it are already recorded, so the importer stops there. */
  daemonEpoch(): string | null {
    return (
      this.db.prepare("SELECT MIN(started_at) AS m FROM rounds WHERE backfilled = 0").get() as { m: string | null }
    ).m;
  }

  /** Insert one imported historical round. Returns false when the review was
   * already imported (INSERT ... WHERE NOT EXISTS on gh_review_id). */
  insertBackfilledRound(row: {
    pr: number;
    round_no: number;
    verdict: string | null;
    started_at: string;
    finished_at: string;
    gh_review_id: number;
    gh_commit_id: string | null;
    trigger_ts: string | null;
    summary?: string | null;
  }): boolean {
    const info = this.db
      .prepare(
        `INSERT INTO rounds (pr, round_no, round_type, lenses, verdict, spend_usd, duration_s, summary,
                             started_at, deadline_at, finished_at, status, backfilled,
                             gh_review_id, gh_commit_id, trigger_ts)
         SELECT @pr, @round_no, 'backfill', '', @verdict, NULL, NULL, @summary,
                @started_at, @finished_at, @finished_at, 'done', 1,
                @gh_review_id, @gh_commit_id, @trigger_ts
         WHERE NOT EXISTS (SELECT 1 FROM rounds WHERE gh_review_id = @gh_review_id)`,
      )
      .run({ ...row, summary: row.summary ?? null });
    return info.changes === 1;
  }

  // ---- backfill PR metadata (M2 writes, metrics reads) -------------------

  upsertBackfillPrMeta(row: Omit<BackfillPrMetaRow, "imported_at"> & { imported_at?: string }): void {
    this.db
      .prepare(
        `INSERT INTO backfill_pr_meta (pr, title, author, created_at, merged_at, closed_at, merged, imported_at)
         VALUES (@pr, @title, @author, @created_at, @merged_at, @closed_at, @merged, @imported_at)
         ON CONFLICT(pr) DO UPDATE SET
           title=@title, author=@author, created_at=@created_at, merged_at=@merged_at,
           closed_at=@closed_at, merged=@merged, imported_at=@imported_at`,
      )
      .run({ ...row, imported_at: row.imported_at ?? this.ts() });
  }

  backfillPrMeta(pr: number): BackfillPrMetaRow | undefined {
    return this.db.prepare("SELECT * FROM backfill_pr_meta WHERE pr = ?").get(pr) as BackfillPrMetaRow | undefined;
  }

  allBackfillPrMeta(): BackfillPrMetaRow[] {
    return this.db.prepare("SELECT * FROM backfill_pr_meta ORDER BY pr").all() as BackfillPrMetaRow[];
  }

  // ---- bot-comment registry ---------------------------------------------

  /**
   * `roundNo` links the comment to the round that produced it (review-depth
   * metric). When omitted it defaults to the round the comment most plausibly
   * came out of — the only defensible attribution for comments discovered
   * after the fact.
   *
   * that fallback used to consider ONLY daemon-run rounds
   * (`backfilled = 0`) and gave up at null otherwise, which is why the column
   * was populated on 2 rows of 275 — the live write sites are the reconcile
   * registry backfill and the webhook, neither of which passes a round, and a
   * PR whose only rounds came from the history import matched nothing.
   * The ladder now falls through to a backfilled round before it gives up: an
   * imported round is a worse attribution than a live one and a far better one
   * than null. A RUNNING round wins over both — a comment arriving while a
   * round is in flight came out of that round, not the one before it.
   */
  registerBotComment(commentId: number, pr: number, kind = "review_comment", roundNo?: number | null): void {
    const pick = (sql: string): number | null =>
      (this.db.prepare(sql).get(pr) as { round_no: number } | undefined)?.round_no ?? null;
    const linked =
      roundNo ??
      pick("SELECT round_no FROM rounds WHERE pr = ? AND status = 'running' ORDER BY id DESC LIMIT 1") ??
      pick("SELECT round_no FROM rounds WHERE pr = ? AND backfilled = 0 ORDER BY id DESC LIMIT 1") ??
      pick("SELECT round_no FROM rounds WHERE pr = ? ORDER BY id DESC LIMIT 1");
    this.db
      .prepare("INSERT OR IGNORE INTO bot_comments (comment_id, pr, kind, posted_at, round_no) VALUES (?, ?, ?, ?, ?)")
      .run(commentId, pr, kind, this.ts(), linked);
  }

  botCommentPr(commentId: number): number | undefined {
    const row = this.db.prepare("SELECT pr FROM bot_comments WHERE comment_id = ?").get(commentId) as { pr: number } | undefined;
    return row?.pr;
  }

  isBotComment(commentId: number): boolean {
    return this.botCommentPr(commentId) !== undefined;
  }

  // ---- reviewed-head mark (guard 2; reuses it) -----------

  /**
   * Stamp the head this system reviewed. Moving to a NEW head replaces the
   * whole row — the author-reply memory belongs to the head it was seen at, so
   * carrying it forward would make the next round look like it already had new
   * evidence. Re-stamping the SAME head only fills in the fields given and
   * refreshes `reviewed_at`, which is what retires a reply that has now been
   * answered.
   */
  recordReviewedHead(
    pr: number,
    mark: { head_sha: string; verdict?: string | null; posted_event?: string | null; round_no?: number | null },
  ): void {
    const prev = this.reviewedHead(pr);
    const same = prev?.head_sha === mark.head_sha;
    this.db
      .prepare(
        `INSERT INTO reviewed_heads (pr, head_sha, reviewed_at, verdict, posted_event, round_no, last_author_reply_at)
         VALUES (@pr, @head_sha, @reviewed_at, @verdict, @posted_event, @round_no, @last_author_reply_at)
         ON CONFLICT(pr) DO UPDATE SET
           head_sha=@head_sha, reviewed_at=@reviewed_at, verdict=@verdict,
           posted_event=@posted_event, round_no=@round_no, last_author_reply_at=@last_author_reply_at`,
      )
      .run({
        pr,
        head_sha: mark.head_sha,
        reviewed_at: this.ts(),
        verdict: mark.verdict ?? (same ? prev!.verdict : null),
        posted_event: mark.posted_event ?? (same ? prev!.posted_event : null),
        round_no: mark.round_no ?? (same ? prev!.round_no : null),
        last_author_reply_at: null,
      });
  }

  reviewedHead(pr: number): ReviewedHeadRow | undefined {
    return this.db.prepare("SELECT * FROM reviewed_heads WHERE pr = ?").get(pr) as ReviewedHeadRow | undefined;
  }

  /** Record an author reply against the PR's mark — the second half of "no new
   * evidence". Only ever moves the stamp forward; a PR with no mark has nothing
   * to skip, so the reply is simply not recorded. */
  noteAuthorReply(pr: number, atIso?: string): void {
    const at = atIso ?? this.ts();
    this.db
      .prepare(
        "UPDATE reviewed_heads SET last_author_reply_at = ? WHERE pr = ? AND (last_author_reply_at IS NULL OR last_author_reply_at < ?)",
      )
      .run(at, pr, at);
  }

  // ---- withheld approvals -------------------------------------

  /**
   * Mark that an approval was withheld at `head_sha` because CI was not green.
   * One row per PR: the mark is a position, not a history (the event log keeps
   * the history), and a later withholding at a newer head replaces it.
   */
  recordApprovalWithheld(pr: number, mark: { head_sha: string; ci_state?: string | null; reason?: string | null }): void {
    this.db
      .prepare(
        `INSERT INTO approval_withheld (pr, head_sha, ci_state, reason, created_at)
         VALUES (@pr, @head_sha, @ci_state, @reason, @created_at)
         ON CONFLICT(pr) DO UPDATE SET
           head_sha=@head_sha, ci_state=@ci_state, reason=@reason, created_at=@created_at`,
      )
      .run({
        pr,
        head_sha: mark.head_sha,
        ci_state: mark.ci_state ?? null,
        reason: mark.reason ?? null,
        created_at: this.ts(),
      });
  }

  approvalWithheld(pr: number): ApprovalWithheldRow | undefined {
    return this.db.prepare("SELECT * FROM approval_withheld WHERE pr = ?").get(pr) as ApprovalWithheldRow | undefined;
  }

  /** Drop the mark — the verdict is about to be decided again. */
  clearApprovalWithheld(pr: number): void {
    this.db.prepare("DELETE FROM approval_withheld WHERE pr = ?").run(pr);
  }

  // ---- post-approval delta rechecks ---------------------------

  /**
   * Claim one recheck nudge. Returns false when this PR has already been
   * nudged for this fingerprint (trigger + head + evidence) — the guard that
   * keeps a re-delivered trigger from re-asking a question already asked.
   */
  claimRecheck(
    pr: number,
    fingerprint: string,
    mark: { head_sha: string; trigger: string; reason?: string },
  ): boolean {
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO rechecks (pr, fingerprint, head_sha, trigger, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(pr, fingerprint, mark.head_sha, mark.trigger, mark.reason ?? null, this.ts());
    return info.changes === 1;
  }

  /** Has this exact recheck question already been claimed? (reconcile
   * backstop pre-check — keeps the sweep from re-classifying per tick). */
  hasRecheck(pr: number, fingerprint: string): boolean {
    return this.db.prepare("SELECT 1 FROM rechecks WHERE pr = ? AND fingerprint = ?").get(pr, fingerprint) !== undefined;
  }

  /** Release a claimed recheck whose delivery failed — the claim must not
   * outlive a nudge that never reached the session (live: #5290 boot-order
   * inject failure burned the head's only recheck, 2026-08-19). */
  releaseRecheck(pr: number, fingerprint: string): void {
    this.db.prepare("DELETE FROM rechecks WHERE pr = ? AND fingerprint = ?").run(pr, fingerprint);
  }

  /** Recheck claims older than `olderThanIso`, across every PR (#5362 W2). The
   * undelivered-nudge sweep reads this: a claim whose nudge never landed
   * suppresses the reconcile push-backstop forever, and unlike a round there
   * is no deadline underneath a recheck to catch that. */
  recheckClaimsBefore(olderThanIso: string): Array<{ pr: number; fingerprint: string; head_sha: string; trigger: string; created_at: string }> {
    return this.db
      .prepare("SELECT pr, fingerprint, head_sha, trigger, created_at FROM rechecks WHERE created_at < ? ORDER BY created_at")
      .all(olderThanIso) as Array<{ pr: number; fingerprint: string; head_sha: string; trigger: string; created_at: string }>;
  }

  /** Every recheck nudge sent for a PR, oldest first (TUI/audit). */
  rechecksFor(pr: number): Array<{ pr: number; fingerprint: string; head_sha: string; trigger: string; reason: string | null; created_at: string }> {
    return this.db.prepare("SELECT * FROM rechecks WHERE pr = ? ORDER BY created_at").all(pr) as Array<{
      pr: number;
      fingerprint: string;
      head_sha: string;
      trigger: string;
      reason: string | null;
      created_at: string;
    }>;
  }

  // ---- webhook delivery dedupe ------------------------------------------

  /** Returns false when the guid was already seen (duplicate delivery). */
  recordDelivery(guid: string, event: string, action: string | null): boolean {
    const info = this.db
      .prepare("INSERT OR IGNORE INTO deliveries (guid, event, action, received_at) VALUES (?, ?, ?, ?)")
      .run(guid, event, action, this.ts());
    return info.changes === 1;
  }

  // ---- feedback signals ----------------------------------------

  /** Record one feedback signal; false when its natural key already exists
   * (webhook redelivery, reconcile overlap). */
  recordFeedbackSignal(sig: {
    kind: string;
    pr: number;
    comment_id?: number | null;
    review_id?: number | null;
    in_reply_to_id?: number | null;
    scope?: string | null;
    author?: string | null;
    body?: string | null;
    day: string;
  }): boolean {
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO feedback_signals
           (kind, pr, comment_id, review_id, in_reply_to_id, scope, author, body, day, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sig.kind,
        sig.pr,
        sig.comment_id ?? null,
        sig.review_id ?? null,
        sig.in_reply_to_id ?? null,
        sig.scope ?? "",
        sig.author ?? null,
        sig.body ?? null,
        sig.day,
        this.ts(),
      );
    return info.changes > 0;
  }

  /** The day's explicit [feedback] comments — the same-day validator
   * addendum's input, oldest first. */
  feedbackCommentsForDay(day: string): FeedbackSignalRow[] {
    return this.db
      .prepare("SELECT * FROM feedback_signals WHERE day = ? AND kind = 'feedback_comment' ORDER BY id")
      .all(day) as FeedbackSignalRow[];
  }

  // ---- captured human comments ---------------------------------

  /** Record one captured comment; false when GitHub's own identity
   * `(source, comment_id)` is already on file — which is what makes the
   * reconcile sweep idempotent against the webhook that already saw it. Never
   * keyed on body text: an edited comment is the same comment. */
  recordPrComment(c: {
    pr: number;
    source: string;
    comment_id: number;
    in_reply_to_id?: number | null;
    thread_id?: number | null;
    review_id?: number | null;
    author?: string | null;
    author_type?: string | null;
    tagged?: boolean;
    path?: string | null;
    line?: number | null;
    body?: string | null;
    created_at?: string | null;
    captured_via?: string;
  }): boolean {
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO pr_comments
           (pr, source, comment_id, in_reply_to_id, thread_id, review_id, author, author_type,
            tagged, path, line, body, created_at, captured_at, captured_via)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        c.pr,
        c.source,
        c.comment_id,
        c.in_reply_to_id ?? null,
        c.thread_id ?? null,
        c.review_id ?? null,
        c.author ?? "",
        c.author_type ?? "User",
        c.tagged ? 1 : 0,
        c.path ?? null,
        c.line ?? null,
        c.body ?? "",
        c.created_at ?? null,
        this.ts(),
        c.captured_via ?? "webhook",
      );
    return info.changes > 0;
  }

  /** A PR's captured comments, oldest first — the companion's local copy of
   * the conversation. */
  prComments(pr: number): PrCommentRow[] {
    return this.db.prepare("SELECT * FROM pr_comments WHERE pr = ? ORDER BY id").all(pr) as PrCommentRow[];
  }

  /** True when this exact GitHub comment is already captured. */
  hasPrComment(source: string, comment_id: number): boolean {
    return (
      this.db.prepare("SELECT 1 FROM pr_comments WHERE source = ? AND comment_id = ?").get(source, comment_id) !==
      undefined
    );
  }

  /** Comment-capture sweep watermark: the sweep costs three GitHub
   * reads per PR, so reconcile skips a PR whose row has not moved since its
   * last clean sweep. Kept in the events table (kind = 'comment_sweep'), the
   * same no-new-DDL idiom as the anomaly record — boot-safe on the live DB. */
  markCommentSweep(pr: number, rowUpdatedAt: string): void {
    this.logEvent("comment_sweep", pr, { row_updated_at: rowUpdatedAt });
  }

  /** The pr_state `updated_at` this PR was last cleanly swept at, when any. */
  lastCommentSweep(pr: number): string | undefined {
    const row = this.db
      .prepare("SELECT payload FROM events WHERE kind = 'comment_sweep' AND pr = ? ORDER BY id DESC LIMIT 1")
      .get(pr) as { payload: string | null } | undefined;
    if (!row?.payload) return undefined;
    try {
      const parsed = JSON.parse(row.payload) as { row_updated_at?: unknown };
      return typeof parsed.row_updated_at === "string" ? parsed.row_updated_at : undefined;
    } catch {
      return undefined;
    }
  }

  /** Timestamp of the latest event of `kind` for `pr`, when any — the
   * stale-dismissal heuristic reads head_push through this. */
  lastEventAt(kind: string, pr: number): string | undefined {
    const row = this.db
      .prepare("SELECT ts FROM events WHERE kind = ? AND pr = ? ORDER BY id DESC LIMIT 1")
      .get(kind, pr) as { ts: string } | undefined;
    return row?.ts;
  }

  // ---- event log ---------------------------------------------------------

  logEvent(kind: string, pr: number | null, payload?: unknown): void {
    this.db
      .prepare("INSERT INTO events (ts, kind, pr, payload) VALUES (?, ?, ?, ?)")
      .run(this.ts(), kind, pr, payload === undefined ? null : JSON.stringify(payload));
  }

  /**
   * The durable anomaly record. Every call-site that raises an
   * overseer anomaly (malformed verdict, blown deadline, degraded migration
   * pre-check, degraded recheck merge-verify, …) writes ONE queryable
   * `anomaly` event here. Kept in the events table (kind = 'anomaly'), so
   * it needs no new DDL and is boot-safe on the live DB by construction.
   *
   * this is also the ONE funnel to the overseer wake — the record is
   * forwarded to the optional sink (the daemon wires `AnomalyWakePolicy`),
   * which applies the severity map + dedup and injects for WAKE classes only.
   * `injectMessage` is the call site's richer wake text; it is NOT persisted
   * (the `detail` field is the audit trail). No sink (bare store, tests, CLI)
   * ⇒ the row is written and nothing wakes, exactly as before.
   */
  // ---- deploy-window drain (2026-08-25) ----------------------------------

  /** The drain flag + its drop counter. A missing row means "not draining". */
  drainState(): DrainState {
    const row = this.db
      .prepare("SELECT draining, drained_deliveries, since FROM drain_state WHERE id = 1")
      .get() as { draining: number; drained_deliveries: number; since: string | null } | undefined;
    if (!row) return { draining: false, drained_deliveries: 0, since: null };
    return { draining: row.draining === 1, drained_deliveries: row.drained_deliveries, since: row.since };
  }

  /**
   * Flip the drain. Turning it ON starts a fresh drop window (counter reset);
   * turning it OFF returns how many deliveries were dropped while it stood, so
   * the lift log line can say what the reconcile poll now has to recover.
   * Idempotent: repeating the current state changes nothing.
   */
  setDraining(on: boolean): { changed: boolean; dropped: number } {
    const prev = this.drainState();
    if (prev.draining === on) return { changed: false, dropped: prev.drained_deliveries };
    if (on) {
      this.db
        .prepare(
          `INSERT INTO drain_state (id, draining, drained_deliveries, since, updated_at)
           VALUES (1, 1, 0, @ts, @ts)
           ON CONFLICT(id) DO UPDATE SET draining = 1, drained_deliveries = 0, since = @ts, updated_at = @ts`,
        )
        .run({ ts: this.ts() });
      return { changed: true, dropped: 0 };
    }
    this.db.prepare("UPDATE drain_state SET draining = 0, updated_at = ? WHERE id = 1").run(this.ts());
    return { changed: true, dropped: prev.drained_deliveries };
  }

  /** Count one webhook delivery dropped while draining; returns the new total. */
  countDrainedDelivery(): number {
    this.db
      .prepare("UPDATE drain_state SET drained_deliveries = drained_deliveries + 1, updated_at = ? WHERE id = 1")
      .run(this.ts());
    return this.drainState().drained_deliveries;
  }

  logAnomaly(kind: string, pr: number | null, roundNo: number | null, detail: string, injectMessage?: string): void {
    this.logEvent("anomaly", pr, { kind, round_no: roundNo, detail });
    if (this.anomalySink) {
      const ts = this.ts();
      this.anomalySink({ ts, kind, pr, round_no: roundNo, detail, injectMessage });
    }
  }

  private anomalySink: ((signal: AnomalyRecord & { injectMessage?: string | undefined }) => void) | null = null;

  /** Install the overseer wake sink. The sink must never throw —
   * logAnomaly sits inside posting paths and stays sync. */
  setAnomalySink(sink: (signal: AnomalyRecord & { injectMessage?: string | undefined }) => void): void {
    this.anomalySink = sink;
  }

  /** Recorded anomalies, newest last. The query the inject files never allowed. */
  anomalies(limit = 100): AnomalyRecord[] {
    const rows = this.db
      .prepare(
        "SELECT ts, pr, payload FROM (SELECT id, ts, pr, payload FROM events WHERE kind = 'anomaly' ORDER BY id DESC LIMIT ?) ORDER BY id",
      )
      .all(limit) as Array<{ ts: string; pr: number | null; payload: string | null }>;
    return rows.map((r) => {
      let kind = "unknown";
      let roundNo: number | null = null;
      let detail = "";
      if (r.payload) {
        try {
          const p = JSON.parse(r.payload) as { kind?: unknown; round_no?: unknown; detail?: unknown };
          if (typeof p.kind === "string") kind = p.kind;
          if (typeof p.round_no === "number") roundNo = p.round_no;
          if (typeof p.detail === "string") detail = p.detail;
        } catch {
          /* an unparseable payload still surfaces as an anomaly row */
        }
      }
      return { ts: r.ts, kind, pr: r.pr, round_no: roundNo, detail };
    });
  }

  // ---- overseer heartbeat --------------------------------------

  /** Record that the daily heartbeat fired for `date` (local "YYYY-MM-DD"). */
  recordHeartbeat(date: string): void {
    this.logEvent("overseer_heartbeat", null, { date });
  }

  /** The last local date the heartbeat fired, or null. Events-table backed, so
   * it survives restarts — the boot catch-up's at-most-once guard. */
  lastHeartbeatDate(): string | null {
    const row = this.db
      .prepare("SELECT payload FROM events WHERE kind = 'overseer_heartbeat' ORDER BY id DESC LIMIT 1")
      .get() as { payload: string | null } | undefined;
    if (!row?.payload) return null;
    try {
      const p = JSON.parse(row.payload) as { date?: unknown };
      return typeof p.date === "string" ? p.date : null;
    } catch {
      return null;
    }
  }

  /**
   * The once-per-round ledger re-nudge mark. Kept in the events
   * table (kind = 'ledger_stale_nudged'), same move as the anomaly
   * record: no new DDL, boot-safe on the live DB by construction. The key is
   * `round-<no>` on the round-end path and `head-<sha>` on the round-less
   * recheck path; a scan with no recency window — the cap is per round, not
   * per recent history.
   */
  recordLedgerNudge(pr: number, key: string, extra?: Record<string, unknown>): void {
    this.logEvent("ledger_stale_nudged", pr, { key, ...(extra ?? {}) });
  }

  /** Was the ledger re-nudge for this (pr, key) already sent? */
  ledgerNudgeSent(pr: number, key: string): boolean {
    const rows = this.db
      .prepare("SELECT payload FROM events WHERE kind = 'ledger_stale_nudged' AND pr = ?")
      .all(pr) as Array<{ payload: string | null }>;
    return rows.some((r) => {
      if (!r.payload) return false;
      try {
        return (JSON.parse(r.payload) as { key?: unknown }).key === key;
      } catch {
        return false;
      }
    });
  }

  /**
   * Has the migration-collision COMMENT with this fingerprint already been
   * posted for this PR? Scans every such event for the PR — no
   * recency window, because a PR that accumulates rounds must not start
   * re-posting the same comment once the newest N events are other collisions.
   */
  migrationCollisionCommented(pr: number, fingerprint: string): boolean {
    const rows = this.db
      .prepare("SELECT payload FROM events WHERE kind = 'migration_collision_comment' AND pr = ?")
      .all(pr) as Array<{ payload: string | null }>;
    return rows.some((r) => {
      if (!r.payload) return false;
      try {
        return (JSON.parse(r.payload) as { fingerprint?: unknown }).fingerprint === fingerprint;
      } catch {
        return false;
      }
    });
  }

  /**
   * Self-requeues already spent on a PR at a given head (cap
   * accounting). Counts `round_self_requeued` events whose payload head_sha
   * matches — a new head resets the budget, exactly like the withheld/reviewed
   * marks are per-head positions. No recency window: the budget is per head,
   * not per day.
   */
  selfRequeueCount(pr: number, headSha: string): number {
    const rows = this.db
      .prepare("SELECT payload FROM events WHERE kind = 'round_self_requeued' AND pr = ?")
      .all(pr) as Array<{ payload: string | null }>;
    return rows.filter((r) => {
      if (!r.payload) return false;
      try {
        return (JSON.parse(r.payload) as { head_sha?: unknown }).head_sha === headSha;
      } catch {
        return false;
      }
    }).length;
  }

  /** Head sha of the last applied verdict for a PR (from the event log). */
  lastVerdictHead(pr: number): string | undefined {
    const row = this.db
      .prepare("SELECT payload FROM events WHERE kind = 'verdict_applied' AND pr = ? ORDER BY id DESC LIMIT 1")
      .get(pr) as { payload: string | null } | undefined;
    if (!row?.payload) return undefined;
    try {
      const head = (JSON.parse(row.payload) as { head_sha?: unknown }).head_sha;
      return typeof head === "string" && head.length > 0 ? head : undefined;
    } catch {
      return undefined;
    }
  }

  eventsOn(dateIso: string): Array<{ ts: string; kind: string; pr: number | null; payload: string | null }> {
    return this.db.prepare("SELECT ts, kind, pr, payload FROM events WHERE ts LIKE ? ORDER BY id").all(`${dateIso}%`) as any;
  }

  /** Newest-last tail of the event log — the TUI events strip. */
  recentEvents(limit: number): Array<{ ts: string; kind: string; pr: number | null; payload: string | null }> {
    return this.db
      .prepare("SELECT ts, kind, pr, payload FROM (SELECT id, ts, kind, pr, payload FROM events ORDER BY id DESC LIMIT ?) ORDER BY id")
      .all(limit) as any;
  }

  // ---- filed items (improvement PRs / issues, cap accounting) -----------

  recordFiledItem(kind: "improvement_pr" | "issue", title: string, ref: string | null): void {
    this.db.prepare("INSERT INTO filed_items (kind, title, ref, filed_at) VALUES (?, ?, ?, ?)").run(kind, title, ref, this.ts());
  }

  filedSince(kind: "improvement_pr" | "issue", sinceIso: string): number {
    return (
      this.db.prepare("SELECT COUNT(*) AS c FROM filed_items WHERE kind = ? AND filed_at >= ?").get(kind, sinceIso) as { c: number }
    ).c;
  }

  // ---- Slack: PR ⇄ thread map -------------------------------------------

  /** Bind a PR to its Slack thread root. Re-binding the same PR (a rebuilt
   * thread) overwrites channel/root_ts and resets the per-thread counters. */
  upsertSlackThread(row: { pr: number; channel: string; root_ts: string }): void {
    this.db
      .prepare(
        `INSERT INTO slack_threads (pr, channel, root_ts, created_at, last_post_at, post_count)
         VALUES (@pr, @channel, @root_ts, @created_at, NULL, 0)
         ON CONFLICT(pr) DO UPDATE SET channel=@channel, root_ts=@root_ts`,
      )
      .run({ ...row, created_at: this.ts() });
  }

  slackThreadForPr(pr: number): SlackThreadRow | undefined {
    return this.db.prepare("SELECT * FROM slack_threads WHERE pr = ?").get(pr) as SlackThreadRow | undefined;
  }

  /** The reverse lookup the router needs: an inbound reply carries a
   * thread_ts, and that is the only thing tying it to a PR. */
  slackThreadByRoot(channel: string, rootTs: string): SlackThreadRow | undefined {
    return this.db.prepare("SELECT * FROM slack_threads WHERE channel = ? AND root_ts = ?").get(channel, rootTs) as
      | SlackThreadRow
      | undefined;
  }

  allSlackThreads(): SlackThreadRow[] {
    return this.db.prepare("SELECT * FROM slack_threads ORDER BY pr").all() as SlackThreadRow[];
  }

  /** Stamp a successful post against the PR's thread (counter + last time). */
  touchSlackThread(pr: number): void {
    this.db.prepare("UPDATE slack_threads SET post_count = post_count + 1, last_post_at = ? WHERE pr = ?").run(this.ts(), pr);
  }

  // ---- Slack: inbound event ledger (dedupe + turn accounting) ------------

  /** Returns false when `event_id` was already recorded — Slack redelivers on
   * every missed ack, exactly like a webhook X-GitHub-Delivery replay. */
  recordSlackEvent(row: {
    event_id: string;
    channel: string;
    ts: string;
    thread_ts?: string | null;
    slack_user?: string | null;
    tier: SlackTier;
    disposition: SlackDisposition;
    injected_at?: string | null;
  }): boolean {
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO slack_events
           (event_id, channel, ts, thread_ts, slack_user, tier, disposition, received_at, injected_at)
         VALUES (@event_id, @channel, @ts, @thread_ts, @slack_user, @tier, @disposition, @received_at, @injected_at)`,
      )
      .run({
        ...row,
        thread_ts: row.thread_ts ?? null,
        slack_user: row.slack_user ?? null,
        injected_at: row.injected_at ?? null,
        received_at: this.ts(),
      });
    return info.changes === 1;
  }

  /** The row is written the moment the event lands; the disposition is settled
   * once the router has decided (and stamps injected_at when it injected). */
  setSlackEventDisposition(eventId: string, disposition: SlackDisposition, injected = disposition === "injected"): void {
    this.db
      .prepare("UPDATE slack_events SET disposition = ?, injected_at = ? WHERE event_id = ?")
      .run(disposition, injected ? this.ts() : null, eventId);
  }

  slackEvent(eventId: string): SlackEventRow | undefined {
    return this.db.prepare("SELECT * FROM slack_events WHERE event_id = ?").get(eventId) as SlackEventRow | undefined;
  }

  /** Injected turns inside a half-open [since, until) window; `slackUser`
   * narrows it to one person. Windows are ISO instants — the Warsaw-day
   * boundaries are computed by slack/policy from the eod.ts zone helpers,
   * never re-derived here (mirrors filedSince/improvementRateReason). */
  slackTurnsBetween(sinceIso: string, untilIso: string, slackUser?: string | null): number {
    const sql =
      "SELECT COUNT(*) AS c FROM slack_events WHERE disposition = 'injected' AND received_at >= ? AND received_at < ?" +
      (slackUser ? " AND slack_user = ?" : "");
    const args: Array<string> = slackUser ? [sinceIso, untilIso, slackUser] : [sinceIso, untilIso];
    return (this.db.prepare(sql).get(...args) as { c: number }).c;
  }

  // ---- Slack: outbound post ledger (idempotence + caps) ------------------

  /**
   * The idempotence guarantee: `idem_key` is UNIQUE, so a retried post is
   * rejected here rather than duplicated in the channel. Returns false when
   * the key was already spent — the caller must then NOT post.
   */
  recordSlackPost(row: {
    idem_key: string;
    kind: SlackPostKind;
    pr?: number | null;
    thread_ts?: string | null;
    ts?: string | null;
    chars?: number;
    ok?: boolean;
    error?: string | null;
  }): boolean {
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO slack_posts (idem_key, kind, pr, thread_ts, ts, chars, posted_at, ok, error)
         VALUES (@idem_key, @kind, @pr, @thread_ts, @ts, @chars, @posted_at, @ok, @error)`,
      )
      .run({
        idem_key: row.idem_key,
        kind: row.kind,
        pr: row.pr ?? null,
        thread_ts: row.thread_ts ?? null,
        ts: row.ts ?? null,
        chars: row.chars ?? 0,
        posted_at: this.ts(),
        ok: row.ok === false ? 0 : 1,
        error: row.error ?? null,
      });
    return info.changes === 1;
  }

  /** Fill in the Slack-assigned message ts (and outcome) after the API call. */
  settleSlackPost(idemKey: string, result: { ts?: string | null; ok: boolean; error?: string | null }): void {
    this.db
      .prepare("UPDATE slack_posts SET ts = ?, ok = ?, error = ? WHERE idem_key = ?")
      .run(result.ts ?? null, result.ok ? 1 : 0, result.error ?? null, idemKey);
  }

  slackPost(idemKey: string): SlackPostRow | undefined {
    return this.db.prepare("SELECT * FROM slack_posts WHERE idem_key = ?").get(idemKey) as SlackPostRow | undefined;
  }

  /** Successful posts in [since, until), optionally of one kind. */
  slackPostsBetween(sinceIso: string, untilIso: string, kind?: SlackPostKind): number {
    const sql =
      "SELECT COUNT(*) AS c FROM slack_posts WHERE ok = 1 AND posted_at >= ? AND posted_at < ?" + (kind ? " AND kind = ?" : "");
    const args: Array<string> = kind ? [sinceIso, untilIso, kind] : [sinceIso, untilIso];
    return (this.db.prepare(sql).get(...args) as { c: number }).c;
  }

  /** Successful posts into one thread in [since, until) — the per-thread cap. */
  slackThreadPostsBetween(threadTs: string, sinceIso: string, untilIso: string): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) AS c FROM slack_posts WHERE ok = 1 AND thread_ts = ? AND posted_at >= ? AND posted_at < ?")
        .get(threadTs, sinceIso, untilIso) as { c: number }
    ).c;
  }

  /** Announcements posted since an instant — the per-hour limiter's window is
   * rolling, not calendar-aligned. */
  slackPostsSince(sinceIso: string, kind?: SlackPostKind): number {
    const sql = "SELECT COUNT(*) AS c FROM slack_posts WHERE ok = 1 AND posted_at >= ?" + (kind ? " AND kind = ?" : "");
    const args: Array<string> = kind ? [sinceIso, kind] : [sinceIso];
    return (this.db.prepare(sql).get(...args) as { c: number }).c;
  }

  // ---- Slack: announcement cooldowns ------------------------------------

  slackCooldown(key: string): SlackCooldownRow | undefined {
    return this.db.prepare("SELECT * FROM slack_cooldowns WHERE key = ?").get(key) as SlackCooldownRow | undefined;
  }

  /** Record a fire. A fire in a new Warsaw day resets the fold counter and the
   * daily bypass; `bypass` marks the one escalation allowed per day. */
  recordSlackCooldownFire(key: string, warsawDay: string, bypass = false): void {
    const prev = this.slackCooldown(key);
    const sameDay = prev?.warsaw_day === warsawDay;
    this.db
      .prepare(
        `INSERT INTO slack_cooldowns (key, last_fired_at, warsaw_day, fire_count, fold_count, bypassed)
         VALUES (@key, @last_fired_at, @warsaw_day, @fire_count, 0, @bypassed)
         ON CONFLICT(key) DO UPDATE SET
           last_fired_at=@last_fired_at, warsaw_day=@warsaw_day, fire_count=@fire_count, fold_count=0, bypassed=@bypassed`,
      )
      .run({
        key,
        last_fired_at: this.ts(),
        warsaw_day: warsawDay,
        fire_count: sameDay ? prev!.fire_count + 1 : 1,
        bypassed: (sameDay && prev!.bypassed === 1) || bypass ? 1 : 0,
      });
  }

  /** A repeat swallowed inside the cooldown window; returns the new fold count. */
  foldSlackCooldown(key: string): number {
    this.db.prepare("UPDATE slack_cooldowns SET fold_count = fold_count + 1 WHERE key = ?").run(key);
    return this.slackCooldown(key)?.fold_count ?? 0;
  }
}

// ---- status.json ---------------------------------------------------------

export interface StatusSnapshot {
  written_at: string;
  dry_run: boolean;
  prs: Array<
    Pick<PrStateRow, "number" | "state" | "title" | "head_sha" | "stale_recheck"> &
      Partial<Pick<PrStateRow, "trigger_ts" | "updated_at" | "author" | "paused">> & {
        rounds?: number;
        last_verdict?: string | null;
      }
  >;
  running_rounds: number;
  /** Absent in snapshots written before the TUI additions — readers default. */
  max_concurrent_rounds?: number;
  total_spend_usd: number;
  today_spend_usd?: number;
  digest_headline?: string;
  /** Present while pi sessions are failing API calls with token-expired
   * errors (src/authwatch.ts, fresh < 30 min). The TUI raises an alert. */
  pi_auth_expired?: { last_at: string; hits: number };
  /** The supervised OpenViking server: reachable, `/ready`, reported
   * version (drift-checked against the pin), RSS and CPU. Absent in snapshots
   * from a daemon with no supervisor wired — readers must default. */
  openviking?: OpenVikingStatus;
  /** Deploy-window drain (2026-08-25): present (and true) only while
   * draining, beside the count of webhook deliveries dropped so far and when
   * the drain was engaged. Absent in older snapshots — readers default to
   * "not draining". */
  draining?: boolean;
  drained_deliveries?: number;
  draining_since?: string;
  /** watcher-global breaker and durable backlog health. */
  thread_decisions?: {
    breaker_state: "closed" | "open" | "half_open";
    open_until?: string;
    pending: number;
    failed: number;
  };
  heartbeat: string;
}

/** Write status.json atomically (temp + rename) — readers may hit it mid-write. */
export function writeStatusJson(stateDir: string, snapshot: StatusSnapshot): void {
  mkdirSync(stateDir, { recursive: true });
  const target = join(stateDir, "status.json");
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
  renameSync(tmp, target);
}

export function buildStatusSnapshot(
  store: StateStore,
  dryRun: boolean,
  digestHeadline?: string,
  now: () => Date = () => new Date(),
  maxConcurrentRounds?: number,
  piAuth?: { last_at: string; hits: number },
  openviking?: OpenVikingStatus,
  threadDecisions?: StatusSnapshot["thread_decisions"],
): StatusSnapshot {
  const today = now().toISOString().slice(0, 10);
  const drain = store.drainState();
  // Expired zombie rounds stay out of the per-PR round COUNTS —
  // but they DO count in every spend aggregate (below).
  const roundStats = store.db
    .prepare("SELECT pr, COUNT(*) AS c, (SELECT verdict FROM rounds r2 WHERE r2.pr = rounds.pr AND verdict IS NOT NULL ORDER BY round_no DESC LIMIT 1) AS v FROM rounds WHERE status != 'expired' GROUP BY pr")
    .all() as Array<{ pr: number; c: number; v: string | null }>;
  const byPr = new Map(roundStats.map((r) => [r.pr, r]));
  return {
    written_at: now().toISOString(),
    dry_run: dryRun,
    prs: store.allPrs().map((p) => ({
      rounds: byPr.get(p.number)?.c ?? 0,
      last_verdict: byPr.get(p.number)?.v ?? null,
      number: p.number,
      state: p.state,
      title: p.title,
      head_sha: p.head_sha,
      stale_recheck: p.stale_recheck,
      trigger_ts: p.trigger_ts,
      updated_at: p.updated_at,
      author: p.author,
      paused: p.paused,
    })),
    running_rounds: store.runningRounds().length,
    ...(maxConcurrentRounds !== undefined ? { max_concurrent_rounds: maxConcurrentRounds } : {}),
    total_spend_usd: store.totalSpend(),
    // Expired rounds COUNT (reversing): a round that blew its
    // deadline still burned its tokens — same rule as totalSpend/cli/metrics.
    today_spend_usd: store.roundsOn(today).reduce((n, r) => n + (r.est_usd ?? 0), 0),
    ...(digestHeadline ? { digest_headline: digestHeadline } : {}),
    ...(piAuth ? { pi_auth_expired: piAuth } : {}),
    ...(openviking ? { openviking } : {}),
    ...(threadDecisions ? { thread_decisions: threadDecisions } : {}),
    ...(drain.draining
      ? {
          draining: true,
          drained_deliveries: drain.drained_deliveries,
          ...(drain.since ? { draining_since: drain.since } : {}),
        }
      : {}),
    heartbeat: now().toISOString(),
  };
}

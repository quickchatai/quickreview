// SQLite state store (state/state.db) + the atomic status.json snapshot.
// Tables: pr_state, rounds, bot_comments (registry), deliveries
// (webhook dedupe), events (append log).
import Database from "better-sqlite3";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { OpenVikingStatus } from "./openviking/types.js";
import type { PassPlanEntry, VerdictPassEntry } from "./types.js";

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

export interface ReviewFailureRow {
  incident_id: string;
  pr: number;
  command_id: string | null;
  round_id: number | null;
  round_no: number | null;
  head_sha: string;
  stage: string;
  detail: string;
  attempts: number;
  retry_cap: number;
  failed_at: string;
  updated_at: string;
  recovered_at: string | null;
  recovery: string | null;
  next_action: "operator_unwedge" | "closed";
  work_owed: number;
}

export interface SuccessorObligationRow {
  pr: number;
  predecessor_round_id: number;
  head_sha: string;
  requested_at: string;
  provenance: TriggerProvenance;
  reason: string;
  updated_at: string;
}

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
  /** deterministic shell-post identity and confirmed outcome. Null key
   * means a legacy round whose verdict cannot be receipt-gated. */
  posting_key: string | null;
  posted_event: string | null;
  posted_at: string | null;
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
  /** Exact dispatch-time policy for classifying reasoned added passes. */
  pass_plan: string | null;
  addable_passes: string | null;
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
  /** The daemon→Pi parent failed a finite start/finish stage before a merits
   * verdict existed. Loud: infrastructure failed, review still owed. */
  | "infrastructure_failure"
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
  "infrastructure_failure",
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
export const LOUD_CANCEL_CAUSES: ReadonlySet<CancelCause> = new Set<CancelCause>(["deadline_overrun", "infrastructure_failure"]);

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
  infrastructure_failure: "infrastructure failure",
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

/** Who a Slack message came from, in rights terms (resolved by the router).
 *
 * split the old personal top tier into two ROLES so the audit trail
 * names which kind of authority acted:
 *   `owner`  — the configured owner (`[owner] slack_id`): the full
 *              personal command rights the retired `owner_legacy` tier carried.
 *   `system` — the daemon's own unattended turns (EOD sweep, anomaly wake,
 *              connections signal), stamped only by `OriginStore.writeLocal`;
 *              `computeTier` never returns it for a Slack user.
 * The retired spelling `"owner_legacy"` is ACCEPTED on input and folded to `owner`
 * by `foldSlackTier` — the ESCALATE→NEEDS_HUMAN pattern: accepted on read,
 * never emitted. */
export type SlackTier = "anyone" | "author" | "owner" | "system" | "ignored";

/**
 * Parse a persisted tier string into the current vocabulary. The retired
 * `"owner_legacy"` spelling (legacy origin records and slack_events rows still
 * on disk) folds to `"owner"`; anything else unknown is `null` — an unknown
 * tier grants nothing. EVERY read path of a persisted tier goes through this
 * fold (origin records via `parseOriginRecord`, slack_events rows via
 * `StateStore.slackEvent`). Pinned by tests/legacy-acceptance.test.ts — a
 * permanent belt, not a cleanup candidate.
 */
export function foldSlackTier(raw: unknown): SlackTier | null {
  if (raw === "owner_legacy") return "owner"; // legacy — accepted on input, never emitted
  return raw === "anyone" || raw === "author" || raw === "owner" || raw === "system" || raw === "ignored"
    ? raw
    : null;
}

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
  /** Ops-day token (YYYY-MM-DD, [ops]/[slack.policy] timezone). Stored in the
   * legacy `warsaw_day` column — see the schema note; the accessor
   * aliases it so the historical name never leaves state.ts. */
  day: string;
  fire_count: number;
  /** Repeats swallowed inside the cooldown window (AlertPolicy fold counter). */
  fold_count: number;
  /** 1 once the one-per-day escalation bypass has been spent. */
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

const SESSION_COMMAND_COLUMNS_SQL = `(
  id             TEXT PRIMARY KEY,
  pr             INTEGER NOT NULL,
  session        TEXT NOT NULL,
  kind           TEXT NOT NULL,
  round_no       INTEGER,
  payload_sha256 TEXT NOT NULL,
  payload_path   TEXT NOT NULL,
  inject_path    TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('pending', 'running', 'acked', 'failed', 'cancelled')),
  owner_token    TEXT,
  attempt        INTEGER NOT NULL DEFAULT 0,
  recovery_attempts INTEGER NOT NULL DEFAULT 0,
  unknown_checks INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  next_check_at  TEXT NOT NULL,
  started_at     TEXT,
  settled_at     TEXT,
  failed_at      TEXT,
  failure        TEXT
)`;

const SESSION_COMMAND_INDEXES_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS session_commands_one_active
  ON session_commands(session) WHERE status IN ('pending', 'running');
CREATE UNIQUE INDEX IF NOT EXISTS session_commands_inject_path ON session_commands(inject_path);
CREATE INDEX IF NOT EXISTS session_commands_pr_created ON session_commands(pr, created_at);`;

const PENDING_WAKE_ORDER_SQL = `held_at,
  CASE WHEN reason GLOB 'operator_recovered:*' THEN 0 ELSE 1 END,
  id`;
const PENDING_WAKE_REVERSE_ORDER_SQL = `held_at DESC,
  CASE WHEN reason GLOB 'operator_recovered:*' THEN 0 ELSE 1 END DESC,
  id DESC`;

const BLOCKING_SESSION_COMMAND_SQL = `(
  c.status IN ('pending', 'running')
  OR (
    c.status='failed' AND (
      c.kind!='round'
      OR NOT EXISTS (SELECT 1 FROM rounds r WHERE r.pr=c.pr AND r.round_no=c.round_no)
      OR EXISTS (SELECT 1 FROM rounds r WHERE r.pr=c.pr AND r.round_no=c.round_no AND r.status='running')
    )
  )
)`;

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
-- double-ingest. day is the ops-day token the same-day addendum keys on.
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
-- ops day — a re-blocked, re-merged PR months later is a fresh signal.
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
-- Durable daemon→Pi command slot. Commands are historical rows, but
-- the partial UNIQUE index permits exactly one pending/running owner per PR
-- session. Payload bytes live at payload_path; the row is ownership + finite
-- lease evidence and is shared by round dispatch and ordinary wakes.
CREATE TABLE IF NOT EXISTS session_commands ${SESSION_COMMAND_COLUMNS_SQL};
${SESSION_COMMAND_INDEXES_SQL}
-- Durable heartbeat for local correctness supervisors. last_attempt_at
-- advances before async work; a callback that hangs therefore becomes stale
-- even while the daemon's process heartbeat keeps advancing.
CREATE TABLE IF NOT EXISTS supervisor_leases (
  name            TEXT PRIMARY KEY,
  last_attempt_at TEXT,
  last_success_at TEXT,
  last_error_at   TEXT,
  last_error      TEXT
);
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
-- GitHub exposes label/team requests as levels, while review intent
-- is an edge. Persist the previous reconcile observation so a level already
-- present before a push cannot masquerade as a fresh human re-review request.
CREATE TABLE IF NOT EXISTS trigger_levels (
  pr          INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  present     INTEGER NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (pr, kind)
);
-- a newer head observed while an older round owns the PR is durable
-- work owed. It survives the predecessor's every terminal path and is retained
-- after queue promotion until a verdict actually covers the target head.
CREATE TABLE IF NOT EXISTS successor_obligations (
  pr                   INTEGER PRIMARY KEY,
  predecessor_round_id INTEGER NOT NULL,
  head_sha             TEXT NOT NULL,
  requested_at         TEXT NOT NULL,
  provenance           TEXT NOT NULL,
  reason               TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
-- canonical FAILED_LOUD review debt. Orthogonal to GitHub lifecycle:
-- a PR may be queued while this hold prevents dispatch. The row remains until
-- explicit operator recovery, so exhausted work can never look merely tracked.
CREATE TABLE IF NOT EXISTS review_failures (
  incident_id  TEXT PRIMARY KEY,
  pr           INTEGER NOT NULL,
  command_id   TEXT,
  round_id     INTEGER,
  round_no     INTEGER,
  head_sha     TEXT NOT NULL,
  stage        TEXT NOT NULL,
  detail       TEXT NOT NULL,
  attempts     INTEGER NOT NULL,
  retry_cap    INTEGER NOT NULL,
  failed_at    TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  recovered_at TEXT,
  recovery     TEXT,
  next_action  TEXT NOT NULL,
  work_owed    INTEGER NOT NULL CHECK(work_owed IN (0,1))
);
CREATE UNIQUE INDEX IF NOT EXISTS review_failures_one_open_pr
  ON review_failures(pr) WHERE work_owed=1;
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
  -- (ops-timezone lift): the STORED name predates the configurable
  -- operations timezone and is deliberately KEPT — a rename migration on live
  -- state buys nothing. It now holds the ops-day token whatever the
  -- configured zone; code reads it as "day" (SlackCooldownRow) through the
  -- alias in slackCooldown(), so "warsaw" appears nowhere outside this file.
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
  /** Ops-day token (YYYY-MM-DD, [ops] timezone) — the same-day addendum's key. */
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

/** Durable command lifecycle at the daemon→Pi boundary. */
export type SessionCommandStatus = "pending" | "running" | "acked" | "failed" | "cancelled";
export type SessionCommandKind = "round" | "wake" | "legacy";

/** One durable daemon→Pi command. `next_check_at` is non-null in every state so
 * no active command can exist without a finite supervisor obligation. */
export interface SessionCommandRow {
  id: string;
  pr: number;
  session: string;
  kind: SessionCommandKind;
  round_no: number | null;
  payload_sha256: string;
  payload_path: string;
  inject_path: string;
  status: SessionCommandStatus;
  owner_token: string | null;
  attempt: number;
  /** Automatic kill-before-replay attempts. Unlike bridge reservations, this
   * advances even when session rebirth fails before a new owner can claim. */
  recovery_attempts: number;
  /** Consecutive supervisor observations where JSONL/liveness evidence was
   * unavailable. Reset on retry; bounded so unknown cannot buy silence. */
  unknown_checks: number;
  created_at: string;
  updated_at: string;
  next_check_at: string;
  started_at: string | null;
  settled_at: string | null;
  failed_at: string | null;
  failure: string | null;
}

export interface SupervisorLeaseRow {
  name: string;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_error_at: string | null;
  last_error: string | null;
}

export interface CreateSessionCommand {
  id: string;
  pr: number;
  session: string;
  kind: SessionCommandKind;
  round_no: number | null;
  payload_sha256: string;
  payload_path: string;
  inject_path: string;
  next_check_at: string;
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

/** Per-PR ceiling on held wakes. Ordinary wakes yield their oldest rows when
 * pressure exceeds this cap. Operator-recovered rows are protected: if those
 * alone exceed the cap, preserving owed work wins over the numeric ceiling. */
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
  pass_plan?: PassPlanEntry[];
  addable_passes?: Array<{ lens: string; tier: string }>;
}

export class StateStore {
  readonly db: Database.Database;

  constructor(readonly path: string, private readonly now: () => Date = () => new Date()) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    // The inject bridge is a second WAL writer. A short daemon-side wait keeps
    // routine cross-process commits from turning into partial handoffs while
    // preserving a finite failure that supervisor health can expose.
    this.db.pragma("busy_timeout = 2000");
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
      "ALTER TABLE rounds ADD COLUMN posting_key TEXT",
      "ALTER TABLE rounds ADD COLUMN posted_event TEXT",
      "ALTER TABLE rounds ADD COLUMN posted_at TEXT",
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
      // immutable dispatched policy for sanctioned added passes.
      "ALTER TABLE rounds ADD COLUMN pass_plan TEXT",
      "ALTER TABLE rounds ADD COLUMN addable_passes TEXT",
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
      // one finite ambiguity allowance per command attempt.
      "ALTER TABLE session_commands ADD COLUMN unknown_checks INTEGER NOT NULL DEFAULT 0",
      // automatic same-command replay attempts are durable even when
      // rebirth fails before a new bridge can reserve the command.
      "ALTER TABLE session_commands ADD COLUMN recovery_attempts INTEGER NOT NULL DEFAULT 0",
    ]) {
      try {
        this.db.exec(ddl);
      } catch {
        /* column already present */
      }
    }
    this.migrateSessionCommandCancelledStatus();
    this.runDataMigrations();
  }

  /** Existing databases carry a CHECK constraint that predates operator
   * cancellation. Rebuild this one table in-place; every column and index is
   * copied, and the transaction makes the old or new shape visible atomically. */
  private migrateSessionCommandCancelledStatus(): void {
    const table = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='session_commands'")
      .get() as { sql: string } | undefined;
    if (!table || table.sql.includes("'cancelled'")) return;
    this.db.transaction(() => {
      this.db.exec(`
        DROP INDEX IF EXISTS session_commands_one_active;
        DROP INDEX IF EXISTS session_commands_inject_path;
        DROP INDEX IF EXISTS session_commands_pr_created;
        ALTER TABLE session_commands RENAME TO session_commands_before_cancelled;
        CREATE TABLE session_commands ${SESSION_COMMAND_COLUMNS_SQL};
        INSERT INTO session_commands
          (id, pr, session, kind, round_no, payload_sha256, payload_path, inject_path,
           status, owner_token, attempt, recovery_attempts, unknown_checks, created_at, updated_at,
           next_check_at, started_at, settled_at, failed_at, failure)
        SELECT id, pr, session, kind, round_no, payload_sha256, payload_path, inject_path,
           status, owner_token, attempt, recovery_attempts, unknown_checks, created_at, updated_at,
           next_check_at, started_at, settled_at, failed_at, failure
          FROM session_commands_before_cancelled;
        DROP TABLE session_commands_before_cancelled;
        ${SESSION_COMMAND_INDEXES_SQL}
      `);
    })();
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

  /** Publish an operator rerun without writing a pre-fence PR snapshot back
   * over newer reconcile/webhook state. A close that wins the fence is final. */
  queuePrForOperatorRecovery(n: number, triggerTs: string): boolean {
    return this.db.prepare(
      `UPDATE pr_state SET state='queued', trigger_ts=?, updated_at=?
        WHERE number=? AND state!='closed'`,
    ).run(triggerTs, this.ts(), n).changes === 1;
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
                             additions, deletions, changed_files, trigger_ts, validate_tier, pass_plan, addable_passes)
         VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?)`,
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
        meta.pass_plan ? JSON.stringify(meta.pass_plan) : null,
        meta.addable_passes ? JSON.stringify(meta.addable_passes) : null,
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
    for (const key of ["pass_plan", "addable_passes"] as const) {
      if (meta[key] !== undefined) {
        sets.push(`${key} = ?`);
        args.push(JSON.stringify(meta[key]));
      }
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE rounds SET ${sets.join(", ")} WHERE id = ?`).run(...args, id);
  }

  stampPostingKey(id: number, postingKey: string): void {
    this.db.prepare("UPDATE rounds SET posting_key=? WHERE id=? AND posting_key IS NULL").run(postingKey, id);
  }

  confirmRoundPosting(
    id: number,
    receipt: { posting_key: string; actual_event: string; gh_review_id: number | null; gh_commit_id: string; confirmed_at: string },
  ): boolean {
    return this.db.prepare(
      `UPDATE rounds
          SET gh_review_id=COALESCE(gh_review_id, @gh_review_id),
              gh_commit_id=COALESCE(gh_commit_id, @gh_commit_id),
              posted_event=COALESCE(posted_event, @actual_event),
              posted_at=COALESCE(posted_at, @confirmed_at)
        WHERE id=@id AND posting_key=@posting_key
          AND (gh_review_id IS NULL OR @gh_review_id IS NULL OR gh_review_id=@gh_review_id)
          AND (gh_commit_id IS NULL OR gh_commit_id=@gh_commit_id)
          AND (posted_event IS NULL OR posted_event=@actual_event)`,
    ).run({ id, ...receipt }).changes === 1;
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

  // ---- durable PR-session command slot ------------------------

  createSessionCommand(input: CreateSessionCommand): SessionCommandRow {
    const ts = this.ts();
    this.db.prepare(
      `INSERT INTO session_commands
         (id, pr, session, kind, round_no, payload_sha256, payload_path, inject_path,
          status, owner_token, attempt, created_at, updated_at, next_check_at)
       VALUES (@id, @pr, @session, @kind, @round_no, @payload_sha256, @payload_path,
          @inject_path, 'pending', NULL, 0, @ts, @ts, @next_check_at)`,
    ).run({ ...input, ts });
    return this.getSessionCommand(input.id)!;
  }

  getSessionCommand(id: string): SessionCommandRow | undefined {
    return this.db.prepare("SELECT * FROM session_commands WHERE id = ?").get(id) as SessionCommandRow | undefined;
  }

  getSessionCommandByInjectPath(path: string): SessionCommandRow | undefined {
    return this.db.prepare("SELECT * FROM session_commands WHERE inject_path = ?").get(path) as SessionCommandRow | undefined;
  }

  activeSessionCommand(session: string): SessionCommandRow | undefined {
    return this.db
      .prepare("SELECT * FROM session_commands WHERE session = ? AND status IN ('pending', 'running') LIMIT 1")
      .get(session) as SessionCommandRow | undefined;
  }

  /** Work still owed by the session. `failed` is terminal for one attempt but
   * deliberately blocks successors until recovery retries the same id. */
  blockingSessionCommand(session: string): SessionCommandRow | undefined {
    return this.db.prepare(
      `SELECT c.* FROM session_commands c
        WHERE c.session=@session AND ${BLOCKING_SESSION_COMMAND_SQL}
        ORDER BY c.created_at DESC LIMIT 1`,
    ).get({ session }) as SessionCommandRow | undefined;
  }

  /** Every durable owner that blocks this PR session, oldest first. Both the
   * PR and canonical session name are required so operator recovery cannot
   * touch a malformed row belonging to another session. */
  blockingSessionCommandsForPr(pr: number): SessionCommandRow[] {
    return this.db.prepare(
      `SELECT c.* FROM session_commands c
        WHERE c.pr=@pr AND c.session=@session AND ${BLOCKING_SESSION_COMMAND_SQL}
        ORDER BY c.created_at, c.id`,
    ).all({ pr, session: `pr-${pr}` }) as SessionCommandRow[];
  }

  /**
   * Terminalize stale ownership after the operator has killed the target Pi.
   * Non-round commands own the only durable copy of their conversational
   * payload, so the caller must supply every one byte-for-byte; those payloads
   * become ordered held wakes in the same transaction that releases the slot.
   */
  cancelBlockingSessionCommandsForOperator(
    pr: number,
    recovered: Array<{ id: string; payload: string }>,
    reason: "restart-session",
    expectedCommandIds: string[],
  ): { cancelled_command_ids: string[]; recovered_wake_ids: number[] } {
    const reset = this.db.transaction(() => {
      const rows = this.blockingSessionCommandsForPr(pr);
      const currentIds = rows.map((row) => row.id).sort();
      const capturedIds = [...expectedCommandIds].sort();
      if (currentIds.length !== capturedIds.length || currentIds.some((id, i) => id !== capturedIds[i])) {
        throw new Error(`operator recovery blocker set changed while fencing #${pr}`);
      }
      const expected = rows.filter((row) => row.kind !== "round").map((row) => row.id).sort();
      const supplied = recovered.map((row) => row.id).sort();
      if (expected.length !== supplied.length || expected.some((id, i) => id !== supplied[i])) {
        throw new Error(`operator recovery payload set does not match blocking commands for #${pr}`);
      }
      const byId = new Map(recovered.map((row) => [row.id, row.payload]));
      const wakeIds: number[] = [];
      const ts = this.ts();
      for (const row of rows) {
        if (row.kind !== "round") {
          const payload = byId.get(row.id);
          if (payload === undefined) throw new Error(`operator recovery payload missing for ${row.id}`);
          const inserted = this.db.prepare(
            "INSERT INTO pending_wakes (pr, payload, reason, held_at) VALUES (?, ?, ?, ?)",
          ).run(pr, payload, `operator_recovered:${row.kind}:${row.id}`, row.created_at);
          wakeIds.push(Number(inserted.lastInsertRowid));
        }
        const changed = this.db.prepare(
          `UPDATE session_commands
              SET status='cancelled', owner_token=NULL, updated_at=@ts,
                  next_check_at=@ts, failure=@failure
            WHERE id=@id AND pr=@pr AND session=@session
              AND status IN ('pending', 'running', 'failed')`,
        ).run({
          id: row.id,
          pr,
          session: `pr-${pr}`,
          ts,
          failure: `operator ${reason}`,
        }).changes;
        if (changed !== 1) throw new Error(`operator recovery lost command ${row.id}`);
      }
      const droppedWakeIds = this.trimHeldWakes(pr);
      return {
        cancelled_command_ids: rows.map((row) => row.id),
        recovered_wake_ids: wakeIds,
        dropped_wake_ids: droppedWakeIds,
      };
    })();
    const result = {
      cancelled_command_ids: reset.cancelled_command_ids,
      recovered_wake_ids: reset.recovered_wake_ids,
    };
    if (reset.cancelled_command_ids.length > 0) {
      this.logEvent("session_commands_operator_cancelled", pr, { reason, ...reset });
    }
    return result;
  }

  activeSessionCommands(): SessionCommandRow[] {
    return this.db
      .prepare("SELECT * FROM session_commands WHERE status IN ('pending', 'running') ORDER BY created_at, id")
      .all() as SessionCommandRow[];
  }

  /** Finite command-stage obligations. Acked round commands remain due only
   * while their round is still running: settlement without a verdict is a
   * liveness failure, whereas completed historical commands need no scans.
   * A failed non-round command remains due until bounded same-command replay
   * succeeds or a durable review_failure records operator-owned exhaustion. */
  dueSessionCommands(at: string): SessionCommandRow[] {
    return this.db.prepare(
      `SELECT c.* FROM session_commands c
        WHERE c.next_check_at <= @at
          AND (
            c.status IN ('pending', 'running')
            OR (
              c.status='failed' AND c.kind!='round'
              AND NOT EXISTS (
                SELECT 1 FROM review_failures f
                 WHERE f.command_id=c.id AND f.work_owed=1
              )
            )
            OR (
              c.status IN ('acked', 'failed') AND c.kind='round'
              AND EXISTS (
                SELECT 1 FROM rounds r
                 WHERE r.pr=c.pr AND r.round_no=c.round_no AND r.status='running'
              )
            )
          )
        ORDER BY c.next_check_at, c.created_at, c.id`,
    ).all({ at }) as SessionCommandRow[];
  }

  /** Persist one bounded allowance for unreadable/contradictory evidence. */
  deferSessionCommandEvidence(id: string, nextCheckAt: string): boolean {
    const ts = this.ts();
    return this.db.prepare(
      `UPDATE session_commands
          SET unknown_checks=unknown_checks+1, updated_at=@ts, next_check_at=@next
        WHERE id=@id AND status IN ('pending', 'running')`,
    ).run({ id, ts, next: nextCheckAt }).changes === 1;
  }

  /** Reconcile durable positive JSONL evidence the bridge could not stamp. */
  observeSessionCommandStarted(id: string, startedAt: string, nextCheckAt: string): boolean {
    const ts = this.ts();
    return this.db.prepare(
      `UPDATE session_commands
          SET status='running', started_at=COALESCE(started_at, @started),
              updated_at=@ts, next_check_at=@next
        WHERE id=@id AND status IN ('pending', 'running')`,
    ).run({ id, started: startedAt, ts, next: nextCheckAt }).changes === 1;
  }

  scheduleSessionCommandCheck(id: string, nextCheckAt: string): boolean {
    const ts = this.ts();
    return this.db.prepare(
      `UPDATE session_commands SET updated_at=@ts, next_check_at=@next
        WHERE id=@id AND status IN ('pending', 'running', 'acked', 'failed')`,
    ).run({ id, ts, next: nextCheckAt }).changes === 1;
  }

  /** Spend one durable automatic replay allowance before crossing the async
   * tmux/filesystem boundary. A failed rebirth therefore cannot retry forever
   * merely because no new bridge lived long enough to increment `attempt`. */
  beginSessionCommandRecovery(id: string, expectedAttempts: number): boolean {
    const ts = this.ts();
    return this.db.prepare(
      `UPDATE session_commands
          SET recovery_attempts=recovery_attempts+1, updated_at=@ts
        WHERE id=@id AND recovery_attempts=@expected
          AND status IN ('pending', 'running', 'failed')
          AND NOT EXISTS (
            SELECT 1 FROM review_failures f
             WHERE f.command_id=session_commands.id AND f.work_owed=1
          )`,
    ).run({ id, expected: expectedAttempts, ts }).changes === 1;
  }

  /** Supervisor terminalization is owner-independent only after external
   * evidence/lease classification. Its guarded active-state update fences a
   * concurrent bridge settlement that won first. */
  failActiveSessionCommand(id: string, failure: string): boolean {
    const ts = this.ts();
    return this.db.prepare(
      `UPDATE session_commands
          SET status='failed', failed_at=@ts, failure=@failure,
              updated_at=@ts, next_check_at=@ts
        WHERE id=@id AND status IN ('pending', 'running')`,
    ).run({ id, failure, ts }).changes === 1;
  }

  ackSettledSessionCommand(id: string): boolean {
    const ts = this.ts();
    return this.db.prepare(
      `UPDATE session_commands
          SET status='acked', settled_at=COALESCE(settled_at, @ts),
              updated_at=@ts, next_check_at=@ts, failure=NULL
        WHERE id=@id AND status='running' AND started_at IS NOT NULL`,
    ).run({ id, ts }).changes === 1;
  }

  failSettledSessionCommand(id: string, failure: string): boolean {
    const ts = this.ts();
    return this.db.prepare(
      `UPDATE session_commands
          SET status='failed', failed_at=@ts, failure=@failure,
              updated_at=@ts, next_check_at=@ts
        WHERE id=@id AND status='acked'`,
    ).run({ id, failure, ts }).changes === 1;
  }

  sessionCommandForRound(pr: number, roundNo: number): SessionCommandRow | undefined {
    return this.db
      .prepare("SELECT * FROM session_commands WHERE pr = ? AND kind = 'round' AND round_no = ? ORDER BY created_at DESC LIMIT 1")
      .get(pr, roundNo) as SessionCommandRow | undefined;
  }

  claimSessionCommand(id: string, ownerToken: string, nextCheckAt: string): SessionCommandRow | undefined {
    const ts = this.ts();
    const changed = this.db.prepare(
      `UPDATE session_commands
          SET status='running', owner_token=@owner, attempt=attempt+1,
              started_at=NULL, updated_at=@ts, next_check_at=@next
        WHERE id=@id AND status='pending'`,
    ).run({ id, owner: ownerToken, ts, next: nextCheckAt }).changes;
    return changed === 1 ? this.getSessionCommand(id) : undefined;
  }

  markSessionCommandStarted(id: string, ownerToken: string, nextCheckAt: string): boolean {
    const ts = this.ts();
    return this.db.prepare(
      `UPDATE session_commands
          SET started_at=COALESCE(started_at, @ts), updated_at=@ts, next_check_at=@next
        WHERE id=@id AND status='running' AND owner_token=@owner`,
    ).run({ id, owner: ownerToken, ts, next: nextCheckAt }).changes === 1;
  }

  finishSessionCommand(
    id: string,
    ownerToken: string,
    status: "acked" | "failed",
    failure?: string,
  ): boolean {
    const ts = this.ts();
    const changed = this.db.prepare(
      `UPDATE session_commands
          SET status=@status, updated_at=@ts, next_check_at=@ts,
              settled_at=CASE WHEN @status='acked' THEN @ts ELSE settled_at END,
              failed_at=CASE WHEN @status='failed' THEN @ts ELSE failed_at END,
              failure=CASE WHEN @status='failed' THEN @failure ELSE NULL END
        WHERE id=@id AND status='running' AND owner_token=@owner
          AND (@status='failed' OR started_at IS NOT NULL)`,
    ).run({ id, owner: ownerToken, status, failure: failure ?? null, ts }).changes;
    return changed === 1;
  }

  failPendingSessionCommand(id: string, failure: string): boolean {
    const ts = this.ts();
    return this.db.prepare(
      `UPDATE session_commands
          SET status='failed', failed_at=@ts, failure=@failure, updated_at=@ts, next_check_at=@ts
        WHERE id=@id AND status='pending'`,
    ).run({ id, failure, ts }).changes === 1;
  }

  /** Kill-before-replay CAS. The caller has already proved the old session is
   * absent. A round may only replay before correlated acceptance; ordinary
   * wakes may replay after acceptance because the old consumer is fenced and
   * the same row still owns the immutable payload. */
  retrySessionCommandAfterFence(id: string, expectedAttempt: number, nextCheckAt: string): boolean {
    const retry = this.db.transaction((): boolean => {
      const row = this.getSessionCommand(id);
      if (
        !row || !["pending", "running", "failed"].includes(row.status)
        || row.attempt !== expectedAttempt
        || (row.kind === "round" && row.started_at !== null)
      ) return false;
      if (row.kind === "round") {
        const round = this.db.prepare(
          "SELECT status FROM rounds WHERE pr=? AND round_no=?",
        ).get(row.pr, row.round_no) as { status: string } | undefined;
        if (round?.status !== "running") return false;
      }
      const ts = this.ts();
      return this.db.prepare(
        `UPDATE session_commands
            SET status='pending', owner_token=NULL, updated_at=@ts,
                next_check_at=@next, unknown_checks=0,
                started_at=NULL, settled_at=NULL, failed_at=NULL, failure=NULL
          WHERE id=@id AND status IN ('pending', 'running', 'failed')
            AND attempt=@attempt
            AND NOT EXISTS (
              SELECT 1 FROM session_commands active
               WHERE active.session=session_commands.session
                 AND active.id!=session_commands.id
                 AND active.status IN ('pending', 'running')
            )`,
      ).run({ id, attempt: expectedAttempt, ts, next: nextCheckAt }).changes === 1;
    });
    return retry();
  }

  retrySessionCommand(id: string, opts: { inject_path: string; next_check_at: string }): boolean {
    const ts = this.ts();
    return this.db.prepare(
      `UPDATE session_commands
          SET status='pending', owner_token=NULL, inject_path=@inject_path,
              updated_at=@ts, next_check_at=@next_check_at, unknown_checks=0,
              started_at=NULL, settled_at=NULL, failed_at=NULL, failure=NULL
        WHERE id=@id AND status IN ('acked', 'failed')
          AND NOT EXISTS (
            SELECT 1 FROM session_commands active
             WHERE active.session=session_commands.session
               AND active.id!=session_commands.id
               AND active.status IN ('pending', 'running')
          )`,
    ).run({ id, ...opts, ts }).changes === 1;
  }

  // ---- supervisor liveness ----------------------------------------------

  supervisorLease(name: string): SupervisorLeaseRow | undefined {
    return this.db.prepare("SELECT * FROM supervisor_leases WHERE name = ?").get(name) as SupervisorLeaseRow | undefined;
  }

  markSupervisorAttempt(name: string, at = this.ts()): void {
    this.db.prepare(
      `INSERT INTO supervisor_leases (name, last_attempt_at)
       VALUES (?, ?)
       ON CONFLICT(name) DO UPDATE SET last_attempt_at=excluded.last_attempt_at`,
    ).run(name, at);
  }

  markSupervisorSuccess(name: string, at = this.ts()): void {
    this.db.prepare(
      `INSERT INTO supervisor_leases (name, last_success_at, last_error_at, last_error)
       VALUES (?, ?, NULL, NULL)
       ON CONFLICT(name) DO UPDATE SET
         last_success_at=excluded.last_success_at, last_error_at=NULL, last_error=NULL`,
    ).run(name, at);
  }

  markSupervisorError(name: string, error: string, at = this.ts()): void {
    this.db.prepare(
      `INSERT INTO supervisor_leases (name, last_error_at, last_error)
       VALUES (?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         last_error_at=excluded.last_error_at, last_error=excluded.last_error`,
    ).run(name, at, error);
  }

  // ---- held wakes (single-shepherd S4) -----------------------------------

  /** Enforce the ordinary wake budget without ever deleting an obligation
   * restored by operator recovery. Protected rows consume capacity first; if
   * they alone exceed the cap, all survive and new ordinary wakes are dropped. */
  private trimHeldWakes(pr: number, cap = MAX_HELD_WAKES): number[] {
    const protectedCount = (this.db.prepare(
      "SELECT COUNT(*) AS c FROM pending_wakes WHERE pr=? AND reason GLOB 'operator_recovered:*'",
    ).get(pr) as { c: number }).c;
    const ordinaryCap = Math.max(0, cap - protectedCount);
    const overflow = this.db.prepare(
      `SELECT id FROM pending_wakes
        WHERE pr=? AND reason NOT GLOB 'operator_recovered:*'
        ORDER BY ${PENDING_WAKE_REVERSE_ORDER_SQL} LIMIT -1 OFFSET ?`,
    ).all(pr, ordinaryCap) as Array<{ id: number }>;
    for (const row of overflow) this.db.prepare("DELETE FROM pending_wakes WHERE id = ?").run(row.id);
    return overflow.map((row) => row.id);
  }

  /** Hold a rendered wake until this PR's round ends. Returns the ids dropped
   * to stay under `cap` (oldest first) so the caller can log them — a silently
   * dropped author reply is worse than a late one. */
  holdWake(pr: number, payload: string, reason: string, cap = MAX_HELD_WAKES): number[] {
    this.db
      .prepare("INSERT INTO pending_wakes (pr, payload, reason, held_at) VALUES (?, ?, ?, ?)")
      .run(pr, payload, reason, this.now().toISOString());
    return this.trimHeldWakes(pr, cap);
  }

  heldWakes(pr: number): PendingWakeRow[] {
    return this.db.prepare(`SELECT * FROM pending_wakes WHERE pr = ?
      ORDER BY ${PENDING_WAKE_ORDER_SQL}`).all(pr) as PendingWakeRow[];
  }

  hasHeldWakes(pr: number): boolean {
    return (this.db.prepare("SELECT COUNT(*) AS c FROM pending_wakes WHERE pr=?").get(pr) as { c: number }).c > 0;
  }

  /** Lease only the oldest held wake. A live lease blocks later rows so
   * concurrent flushers cannot reorder author messages. */
  claimNextHeldWake(pr: number, token: string, leaseBefore: string): PendingWakeRow | null {
    const claim = this.db.transaction((n: number): PendingWakeRow | null => {
      const row = this.db.prepare(`SELECT * FROM pending_wakes WHERE pr = ?
        ORDER BY ${PENDING_WAKE_ORDER_SQL} LIMIT 1`).get(n) as PendingWakeRow | undefined;
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

  /** The review ids this daemon recorded posting for ONE pr — the
   * per-review ledger, read as a trace by the ungated-review audit.
   * Scoped per PR (unlike `importedReviewIds`) because the audit asks a
   * per-PR question and a global set would let one PR's row vouch for another. */
  postedReviewIds(pr: number): Set<number> {
    const rows = this.db
      .prepare("SELECT gh_review_id AS id FROM rounds WHERE pr = ? AND gh_review_id IS NOT NULL")
      .all(pr) as Array<{ id: number }>;
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

  /**
   * Repair the legacy false mark left by a deterministic migration
   * COMMENT. This is deliberately evidence-gated: a null-verdict COMMENT is
   * removed only when the event ledger proves that this daemon executed its
   * migration pre-check at the same head. A substantive verdict/round mark, a
   * dry-run record, or an unrelated COMMENT is never touched.
   */
  repairMigrationPrecheckReviewedHead(pr: number): boolean {
    const mark = this.reviewedHead(pr);
    if (
      !mark
      || mark.verdict !== null
      || mark.round_no !== null
      || (mark.posted_event ?? "").toUpperCase() !== "COMMENT"
    ) return false;
    const rows = this.db
      .prepare("SELECT payload FROM events WHERE kind='migration_collision_comment' AND pr=?")
      .all(pr) as Array<{ payload: string | null }>;
    const proven = rows.some((row) => {
      if (!row.payload) return false;
      try {
        const payload = JSON.parse(row.payload) as { head_sha?: unknown; executed?: unknown };
        return payload.executed === true
          && typeof payload.head_sha === "string"
          && payload.head_sha.toLowerCase() === mark.head_sha.toLowerCase();
      } catch {
        return false;
      }
    });
    if (!proven) return false;
    const removed = this.db.prepare(
      `DELETE FROM reviewed_heads
        WHERE pr=? AND lower(head_sha)=lower(?)
          AND verdict IS NULL AND round_no IS NULL
          AND upper(COALESCE(posted_event, ''))='COMMENT'`,
    ).run(pr, mark.head_sha).changes === 1;
    if (removed) this.logEvent("migration_precheck_reviewed_head_repaired", pr, { head_sha: mark.head_sha });
    return removed;
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

  // ---- durable FAILED_LOUD review debt -----------------------

  openReviewFailure(pr: number): ReviewFailureRow | undefined;
  openReviewFailure(input: {
    pr: number;
    command_id?: string | null;
    round_id?: number | null;
    round_no?: number | null;
    head_sha: string;
    stage: string;
    detail: string;
    attempts: number;
    retry_cap: number;
  }): ReviewFailureRow;
  openReviewFailure(
    arg: number | {
      pr: number;
      command_id?: string | null;
      round_id?: number | null;
      round_no?: number | null;
      head_sha: string;
      stage: string;
      detail: string;
      attempts: number;
      retry_cap: number;
    },
  ): ReviewFailureRow | undefined {
    if (typeof arg === "number") {
      return this.db.prepare("SELECT * FROM review_failures WHERE pr=? AND work_owed=1 ORDER BY failed_at LIMIT 1").get(arg) as ReviewFailureRow | undefined;
    }
    const ts = this.ts();
    const incidentId = arg.command_id
      ? `review-failure:${arg.command_id}`
      : `review-failure:pr-${arg.pr}-round-${arg.round_no ?? "unknown"}`;
    const failure = this.db.transaction((): ReviewFailureRow => {
      this.db.prepare(
        `UPDATE review_failures
            SET work_owed=0, recovered_at=@ts, recovery='superseded-by-new-failure', next_action='closed', updated_at=@ts
          WHERE pr=@pr AND work_owed=1 AND incident_id!=@incident_id`,
      ).run({ pr: arg.pr, incident_id: incidentId, ts });
      this.db.prepare(
        `INSERT INTO review_failures
          (incident_id, pr, command_id, round_id, round_no, head_sha, stage, detail,
           attempts, retry_cap, failed_at, updated_at, next_action, work_owed)
         VALUES (@incident_id, @pr, @command_id, @round_id, @round_no, @head_sha, @stage, @detail,
                 @attempts, @retry_cap, @ts, @ts, 'operator_unwedge', 1)
         ON CONFLICT(incident_id) DO UPDATE SET
           head_sha=excluded.head_sha, stage=excluded.stage, detail=excluded.detail,
           attempts=excluded.attempts, retry_cap=excluded.retry_cap,
           updated_at=excluded.updated_at, recovered_at=NULL, recovery=NULL,
           next_action='operator_unwedge', work_owed=1`,
      ).run({
        incident_id: incidentId,
        pr: arg.pr,
        command_id: arg.command_id ?? null,
        round_id: arg.round_id ?? null,
        round_no: arg.round_no ?? null,
        head_sha: arg.head_sha,
        stage: arg.stage,
        detail: arg.detail,
        attempts: arg.attempts,
        retry_cap: arg.retry_cap,
        ts,
      });
      const row = this.getPr(arg.pr);
      const successor = this.successorFor(arg.pr);
      if (row && row.state !== "closed") {
        this.db.prepare(
          `UPDATE pr_state
              SET state='queued', head_sha=?, trigger_ts=?, trigger_provenance=?, updated_at=?
            WHERE number=? AND state!='closed'`,
        ).run(successor?.head_sha ?? arg.head_sha, successor?.requested_at ?? ts, successor?.provenance ?? "system", ts, arg.pr);
      }
      return this.db.prepare("SELECT * FROM review_failures WHERE incident_id=?").get(incidentId) as ReviewFailureRow;
    })();
    this.logEvent("review_failed_loud", arg.pr, {
      incident_id: failure.incident_id,
      command_id: failure.command_id,
      round_no: failure.round_no,
      stage: failure.stage,
      attempts: failure.attempts,
      retry_cap: failure.retry_cap,
      next_action: failure.next_action,
    });
    return failure;
  }

  openReviewFailures(): ReviewFailureRow[] {
    return this.db.prepare("SELECT * FROM review_failures WHERE work_owed=1 ORDER BY failed_at, incident_id").all() as ReviewFailureRow[];
  }

  recentReviewRecoveries(since: string): ReviewFailureRow[] {
    return this.db.prepare(
      "SELECT * FROM review_failures WHERE work_owed=0 AND recovered_at IS NOT NULL AND recovered_at>=? ORDER BY recovered_at DESC, incident_id",
    ).all(since) as ReviewFailureRow[];
  }

  recoverReviewFailure(
    pr: number,
    recovery: string,
    match?: { incident_id?: string; round_no?: number; head_sha?: string },
  ): ReviewFailureRow | undefined {
    const ts = this.ts();
    const current = this.openReviewFailure(pr);
    if (
      !current
      || (match?.incident_id !== undefined && current.incident_id !== match.incident_id)
      || (match?.round_no !== undefined && current.round_no !== match.round_no)
      || (match?.head_sha !== undefined && current.head_sha !== match.head_sha)
    ) return undefined;
    const recovered = this.db.transaction((): ReviewFailureRow | undefined => {
      const changed = this.db.prepare(
        `UPDATE review_failures
            SET work_owed=0, recovered_at=?, recovery=?, next_action='closed', updated_at=?
          WHERE incident_id=? AND work_owed=1`,
      ).run(ts, recovery, ts, current.incident_id).changes;
      if (changed !== 1) return undefined;
      // Recovery and durable work publication are one commit. A process crash
      // after this point may delay the pump, but cannot forget what u asked for.
      const row = this.getPr(pr);
      const successor = this.successorFor(pr);
      if (row && row.state !== "closed") {
        this.db.prepare(
          `UPDATE pr_state
              SET state='queued', head_sha=?, trigger_ts=COALESCE(trigger_ts, ?),
                  trigger_provenance=COALESCE(trigger_provenance, ?), updated_at=?
            WHERE number=? AND state!='closed'`,
        ).run(successor?.head_sha ?? current.head_sha, successor?.requested_at ?? ts, successor?.provenance ?? "system", ts, pr);
      }
      return this.db.prepare("SELECT * FROM review_failures WHERE incident_id=?").get(current.incident_id) as ReviewFailureRow;
    })();
    if (!recovered) return undefined;
    this.logEvent("review_failure_recovered", pr, { incident_id: current.incident_id, recovery });
    return recovered;
  }

  // ---- durable fresh-head successor --------------------------

  successorFor(pr: number): SuccessorObligationRow | undefined {
    return this.db.prepare("SELECT * FROM successor_obligations WHERE pr = ?").get(pr) as SuccessorObligationRow | undefined;
  }

  recordSuccessor(input: {
    pr: number;
    predecessor_round_id: number;
    head_sha: string;
    provenance: TriggerProvenance;
    reason: string;
  }): void {
    if (!input.head_sha) return;
    const ts = this.ts();
    this.db.prepare(
      `INSERT INTO successor_obligations
         (pr, predecessor_round_id, head_sha, requested_at, provenance, reason, updated_at)
       VALUES (@pr, @predecessor_round_id, @head_sha, @ts, @provenance, @reason, @ts)
       ON CONFLICT(pr) DO UPDATE SET
         predecessor_round_id=excluded.predecessor_round_id,
         head_sha=excluded.head_sha,
         -- The PR has owed successor work since the FIRST observed push. Keep
         -- that FIFO position while coalescing the target to the newest head;
         -- a later human edge upgrades provenance but does not manufacture a
         -- newer arrival time for already-waiting work.
         requested_at=successor_obligations.requested_at,
         provenance=CASE
           WHEN successor_obligations.provenance='human' OR excluded.provenance='human' THEN 'human'
           ELSE 'system'
         END,
         reason=excluded.reason,
         updated_at=excluded.updated_at`,
    ).run({ ...input, ts });
    this.logEvent("successor_required", input.pr, {
      predecessor_round_id: input.predecessor_round_id,
      head_sha: input.head_sha,
      provenance: input.provenance,
      reason: input.reason,
    });
  }

  /** Translate the obligation into ordinary queued work without deleting its
   * evidence. Queue publication + target head are one transaction; the row is
   * cleared only when a verdict later covers that head. */
  promoteSuccessor(pr: number): boolean {
    const promoted = this.db.transaction((): SuccessorObligationRow | undefined => {
      const successor = this.successorFor(pr);
      const row = this.getPr(pr);
      if (!successor || !row || row.state === "closed" || row.paused || this.hasRunningRound(pr)) return undefined;
      if (
        row.state === "queued" && row.head_sha === successor.head_sha
        && row.trigger_ts === successor.requested_at && row.trigger_provenance === successor.provenance
      ) return undefined;
      this.db.prepare(
        `UPDATE pr_state
            SET state='queued', head_sha=?, trigger_ts=?, trigger_provenance=?, updated_at=?
          WHERE number=? AND state!='closed'`,
      ).run(successor.head_sha, successor.requested_at, successor.provenance, this.ts(), pr);
      return successor;
    })();
    if (!promoted) return false;
    this.logEvent("successor_promoted", pr, {
      predecessor_round_id: promoted.predecessor_round_id,
      head_sha: promoted.head_sha,
      provenance: promoted.provenance,
    });
    return true;
  }

  /** A confirmed merits verdict covers the owed head; an older verdict cannot
   * erase it. */
  settleSuccessor(pr: number, reviewedHead: string): boolean {
    const successor = this.successorFor(pr);
    if (!successor || !reviewedHead || successor.head_sha !== reviewedHead) return false;
    const changed = this.db.prepare("DELETE FROM successor_obligations WHERE pr=? AND head_sha=?").run(pr, reviewedHead).changes === 1;
    if (changed) this.logEvent("successor_settled", pr, { head_sha: reviewedHead });
    return changed;
  }

  clearSuccessor(pr: number, reason: string): boolean {
    const successor = this.successorFor(pr);
    if (!successor) return false;
    const changed = this.db.prepare("DELETE FROM successor_obligations WHERE pr=?").run(pr).changes === 1;
    if (changed) this.logEvent("successor_cleared", pr, { head_sha: successor.head_sha, reason });
    return changed;
  }

  // ---- trigger-level observations ----------------------------

  triggerLevel(pr: number, kind: "label" | "team_request"): boolean | undefined {
    const row = this.db.prepare("SELECT present FROM trigger_levels WHERE pr = ? AND kind = ?").get(pr, kind) as
      | { present: number }
      | undefined;
    return row === undefined ? undefined : row.present === 1;
  }

  observeTriggerLevel(pr: number, kind: "label" | "team_request", present: boolean): void {
    this.db
      .prepare(
        `INSERT INTO trigger_levels (pr, kind, present, observed_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(pr, kind) DO UPDATE SET present=excluded.present, observed_at=excluded.observed_at`,
      )
      .run(pr, kind, present ? 1 : 0, this.ts());
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
    const row = this.db.prepare("SELECT * FROM slack_events WHERE event_id = ?").get(eventId) as
      | SlackEventRow
      | undefined;
    if (!row) return undefined;
    // Rows written before carry the retired "owner_legacy" tier spelling;
    // fold on read (accepted on input, never emitted). An unrecognisable value
    // is returned as-is — this is a ledger read, not a rights grant.
    const folded = foldSlackTier(row.tier);
    return folded !== null && folded !== row.tier ? { ...row, tier: folded } : row;
  }

  /** Injected turns inside a half-open [since, until) window; `slackUser`
   * narrows it to one person. Windows are ISO instants — the policy-day
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
    // `warsaw_day AS day`: the one place the legacy column name maps onto the
    // neutral row field (see the schema note).
    return this.db
      .prepare("SELECT key, last_fired_at, warsaw_day AS day, fire_count, fold_count, bypassed FROM slack_cooldowns WHERE key = ?")
      .get(key) as SlackCooldownRow | undefined;
  }

  /** Record a fire. A fire in a new ops day resets the fold counter and the
   * daily bypass; `bypass` marks the one escalation allowed per day. */
  recordSlackCooldownFire(key: string, day: string, bypass = false): void {
    const prev = this.slackCooldown(key);
    const sameDay = prev?.day === day;
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
        warsaw_day: day,
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
        /** The authoritative running plan/timing. Live lens activity is a
         * separate ephemeral sidecar; neither source impersonates the other. */
        current_round?: Pick<RoundRow, "round_no" | "round_type" | "status" | "started_at" | "deadline_at" | "lenses" | "validate_tier">;
        /** canonical operator hold. Presence overrides the ordinary PR
         * lifecycle label: review work is still owed and `u` is the action. */
        review_failure?: Pick<ReviewFailureRow, "incident_id" | "command_id" | "round_no" | "head_sha" | "stage" | "detail" | "attempts" | "retry_cap" | "failed_at" | "next_action">;
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
  /** Terminal FAILED_LOUD obligations are visible during drain but do not
   * count as live rounds; operator recovery remains dormant until drain lifts. */
  drain_failed_loud?: number;
  /** local correctness supervisor. A fresh process heartbeat with a
   * stale/failed scan is pipeline-unhealthy, not healthy. */
  round_stage_supervisor?: {
    healthy: boolean;
    stale_after_s: number;
    last_attempt_at: string | null;
    last_success_at: string | null;
    last_error_at: string | null;
    last_error: string | null;
  };
  /** separates process liveness from review-pipeline health. Cause
   * keys are stable alert/dedupe identities, never prose or timestamps. */
  pipeline?: {
    healthy: boolean;
    failed_loud: number;
    causes: Array<{
      key: string;
      pr: number | null;
      since: string;
      stage: string;
      detail: string;
      next_action: string;
      command_id?: string;
      round_no?: number;
      attempts?: number;
      retry_cap?: number;
      age_s?: number;
    }>;
    recoveries?: Array<{ key: string; pr: number; recovered_at: string; recovery: string | null }>;
    oldest_expired?: {
      key: string;
      pr: number | null;
      since: string;
      stage: string;
      detail: string;
      next_action: string;
      age_s?: number;
    };
  };
  /** Provider/auth health is a sibling of pipeline and OpenViking health;
   * never let one domain impersonate another. */
  provider?: { healthy: boolean; detail?: string; last_at?: string };
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
  roundStageSupervisor?: StatusSnapshot["round_stage_supervisor"],
): StatusSnapshot {
  const at = now();
  const today = at.toISOString().slice(0, 10);
  const drain = store.drainState();
  // Expired zombie rounds stay out of the per-PR round COUNTS —
  // but they DO count in every spend aggregate (below).
  const roundStats = store.db
    .prepare("SELECT pr, COUNT(*) AS c, (SELECT verdict FROM rounds r2 WHERE r2.pr = rounds.pr AND verdict IS NOT NULL ORDER BY round_no DESC LIMIT 1) AS v FROM rounds WHERE status != 'expired' GROUP BY pr")
    .all() as Array<{ pr: number; c: number; v: string | null }>;
  const byPr = new Map(roundStats.map((r) => [r.pr, r]));
  const runningByPr = new Map(store.runningRounds().map((r) => [r.pr, r]));
  const failures = store.openReviewFailures();
  const failureByPr = new Map(failures.map((failure) => [failure.pr, failure]));
  const pipelineCauses: NonNullable<StatusSnapshot["pipeline"]>["causes"] = failures.map((failure) => ({
    key: failure.incident_id,
    pr: failure.pr,
    since: failure.failed_at,
    stage: failure.stage,
    detail: failure.detail,
    next_action: failure.next_action,
    ...(failure.command_id ? { command_id: failure.command_id } : {}),
    ...(failure.round_no !== null ? { round_no: failure.round_no } : {}),
    attempts: failure.attempts,
    retry_cap: failure.retry_cap,
    age_s: Math.max(0, Math.floor((at.getTime() - Date.parse(failure.failed_at)) / 1000)),
  }));
  if (roundStageSupervisor && !roundStageSupervisor.healthy) {
    pipelineCauses.push({
      key: "round-stage-supervisor",
      pr: null,
      since: roundStageSupervisor.last_error_at ?? roundStageSupervisor.last_attempt_at ?? at.toISOString(),
      stage: "supervisor",
      detail: roundStageSupervisor.last_error ?? "round-stage supervisor lease is stale",
      next_action: "inspect-supervisor",
      age_s: Math.max(0, Math.floor((at.getTime() - Date.parse(roundStageSupervisor.last_error_at ?? roundStageSupervisor.last_attempt_at ?? at.toISOString())) / 1000)),
    });
  }
  pipelineCauses.sort((a, b) => a.key.localeCompare(b.key));
  const oldest = [...pipelineCauses].sort((a, b) => a.since.localeCompare(b.since))[0];
  const recoveries = store.recentReviewRecoveries(new Date(at.getTime() - 10 * 60_000).toISOString()).map((failure) => ({
    key: failure.incident_id,
    pr: failure.pr,
    recovered_at: failure.recovered_at!,
    recovery: failure.recovery,
  }));
  return {
    written_at: at.toISOString(),
    dry_run: dryRun,
    prs: store.allPrs().map((p) => ({
      rounds: byPr.get(p.number)?.c ?? 0,
      last_verdict: byPr.get(p.number)?.v ?? null,
      ...(runningByPr.get(p.number)
        ? {
            current_round: {
              round_no: runningByPr.get(p.number)!.round_no,
              round_type: runningByPr.get(p.number)!.round_type,
              status: runningByPr.get(p.number)!.status,
              started_at: runningByPr.get(p.number)!.started_at,
              deadline_at: runningByPr.get(p.number)!.deadline_at,
              lenses: runningByPr.get(p.number)!.lenses,
              validate_tier: runningByPr.get(p.number)!.validate_tier,
            },
          }
        : {}),
      number: p.number,
      state: p.state,
      title: p.title,
      head_sha: p.head_sha,
      stale_recheck: p.stale_recheck,
      trigger_ts: p.trigger_ts,
      updated_at: p.updated_at,
      author: p.author,
      paused: p.paused,
      ...(failureByPr.get(p.number)
        ? {
            review_failure: {
              incident_id: failureByPr.get(p.number)!.incident_id,
              command_id: failureByPr.get(p.number)!.command_id,
              round_no: failureByPr.get(p.number)!.round_no,
              head_sha: failureByPr.get(p.number)!.head_sha,
              stage: failureByPr.get(p.number)!.stage,
              detail: failureByPr.get(p.number)!.detail,
              attempts: failureByPr.get(p.number)!.attempts,
              retry_cap: failureByPr.get(p.number)!.retry_cap,
              failed_at: failureByPr.get(p.number)!.failed_at,
              next_action: failureByPr.get(p.number)!.next_action,
            },
          }
        : {}),
    })),
    running_rounds: store.runningRounds().length,
    ...(maxConcurrentRounds !== undefined ? { max_concurrent_rounds: maxConcurrentRounds } : {}),
    total_spend_usd: store.totalSpend(),
    // Expired rounds COUNT (reversing): a round that blew its
    // deadline still burned its tokens — same rule as totalSpend/cli/metrics.
    today_spend_usd: store.roundsOn(today).reduce((n, r) => n + (r.est_usd ?? 0), 0),
    ...(digestHeadline ? { digest_headline: digestHeadline } : {}),
    ...(piAuth ? { pi_auth_expired: piAuth, provider: { healthy: false, detail: `pi auth expired (${piAuth.hits} hit${piAuth.hits === 1 ? "" : "s"})`, last_at: piAuth.last_at } } : {}),
    ...(openviking ? { openviking } : {}),
    ...(threadDecisions ? { thread_decisions: threadDecisions } : {}),
    ...(roundStageSupervisor ? { round_stage_supervisor: roundStageSupervisor } : {}),
    ...(roundStageSupervisor || pipelineCauses.length > 0
      ? {
          pipeline: {
            healthy: pipelineCauses.length === 0,
            failed_loud: failures.length,
            causes: pipelineCauses,
            recoveries,
            ...(oldest
              ? { oldest_expired: { key: oldest.key, pr: oldest.pr, since: oldest.since, stage: oldest.stage, detail: oldest.detail, next_action: oldest.next_action, age_s: oldest.age_s } }
              : {}),
          },
        }
      : {}),
    ...(drain.draining
      ? {
          draining: true,
          drained_deliveries: drain.drained_deliveries,
          ...(drain.since ? { draining_since: drain.since } : {}),
          drain_failed_loud: failures.length,
        }
      : {}),
    heartbeat: at.toISOString(),
  };
}

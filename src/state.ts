// SQLite state store (state/state.db) + the atomic status.json snapshot.
// Core tables: pr_state, rounds, bot_comments (registry), deliveries
// (webhook dedupe), events (append log).
import { findingRowFields } from "@quickchatai/pi-quickreview/src/finding-row.js";
import { roundStageDeadlines } from "@quickchatai/pi-quickreview/src/round-stage-deadlines.js";
import Database from "better-sqlite3";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { OpenVikingStatus } from "./openviking/types.js";
import type { ArchiveStatus } from "./archive/status.js";
import type { PermitStatus } from "./ipc/permits.js";
import type { LoginRefreshStatus } from "./loginrefresh/types.js";
import type { DaemonLoadStatus } from "./eventloop.js";
import type { MemoryIncident, MemoryStatus } from "./memory/health.js";
import type { RoundStageSupervisorHealth } from "./session-command-supervisor.js";
import type { SweepStatus } from "@quickchatai/pi-quickreview/src/sweepstatus.js";
import type {
  CollisionCommentRecord,
  PriorFindingCheckRow,
  ReviewedHeadRow,
  RoundFindingInput,
  RoundFindingRow,
  RoundRow,
} from "@quickchatai/pi-quickreview/src/storerows.js";
// The records the core reads are its own (packages/pi-plugin/src/storerows.ts).
export type {
  CollisionCommentRecord,
  PriorFindingCheckRow,
  ReviewedHeadRow,
  RoundFindingInput,
  RoundFindingRow,
  RoundRow,
};
import {
  holdActive,
  mayLift,
  mergeHold,
  type HoldOutcome,
  type LeverGrant,
  type LeverHold,
  type LeverIssuer,
  type LeverKind,
} from "./levers.js";
import {
  parseRecheckPromptMarker,
  type PassPlanEntry,
  type SessionCommandObservation,
  type VerdictPassEntry,
} from "@quickchatai/pi-quickreview/src/types.js";
import {
  standingLifecycleState,
  standingVerdict as standingReviewVerdict,
} from "@quickchatai/pi-quickreview/src/standing-review.js";
import { canonicalLensIds } from "@quickchatai/pi-quickreview/src/lensids.js";
import { postingKeyHead } from "./posting-receipt.js";
import { WITHHOLD_WORDS } from "@quickchatai/pi-quickreview/src/postingpolicy.js";

/** The lifecycle states a PR can occupy. There is no "awaiting human" member:
 * the review is never handed to a human, so nothing produces or holds such a
 * state (the never-hand-to-a-human rule). */
export type PrLifecycleState = "tracked" | "queued" | "reviewing" | "awaiting_author" | "closed";

/** Who asked for the queued round. `human` = a fresh label add, a
 * fresh team re-review request, an overseer/manual trigger, or an author reply
 * landing while queued — a person acted and expects a full round. `system` = a
 * push/CI/staleness re-trigger at an existing trigger state — the dispatcher
 * may consult the recheck's delta classifier and short-circuit an empty/trivial
 * delta. Null (legacy rows, direct requeues) is treated as human: the safe
 * default is a full round. */
export type TriggerProvenance = "human" | "system";

export type TerminalReviewFailureDisposition = "closed" | "absent";

export type ExactHeadReviewedFailureResolution =
  | { kind: "not_applicable" }
  | { kind: "blocked"; reason: string }
  | {
      kind: "resolved";
      incident_id: string;
      command_id: string;
      restored_state: "awaiting_author" | "tracked";
      standing_verdict: "REQUEST_CHANGES" | "APPROVE";
      already_resolved: boolean;
    };

export type TerminalReviewFailureResolution =
  | {
      ok: true;
      disposition: TerminalReviewFailureDisposition;
      incident_id: string;
      command_id: string;
      command_status: "cancelled" | "acked";
      already_resolved: boolean;
    }
  | { ok: false; reason: string };

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
  /** Circuit-breaker generation. Zero is the first delayed retry
   * after the ordinary per-head fast retries are spent. */
  retry_epoch: number;
  /** Advances only when a settled incident reopens, never on retry scheduling. */
  reopen_epoch?: number;
  next_retry_at: string | null;
  failed_at: string;
  updated_at: string;
  recovered_at: string | null;
  recovery: string | null;
  next_action: "operator_unwedge" | "retry_wait" | "closed";
  work_owed: number;
}

/** One exact future round's daemon-authored recovery instruction. It is
 * append-only history keyed by round number, not mutable ambient PR state, so
 * a later ordinary round can never inherit a stale recovery override. */
export interface RoundRecoveryInstructionRow {
  pr: number;
  target_round_no: number;
  target_head_sha: string;
  stage: "first_pass_start";
  source_incident_id: string | null;
  source_command_id: string;
  source_round_no: number;
  immediate_attempt: number;
  retry_epoch: number;
  created_at: string;
}

export interface AutomaticReviewRetry {
  pr: number;
  incident_id: string;
  target_head_sha: string;
  target_round_no: number;
  retry_epoch: number;
}

/** Circuit-breaker timing is policy, not activity-derived. The first delayed
 * attempt waits 15 minutes; repeated pre-fanout failures double to a six-hour
 * ceiling and continue at that bounded rate until progress or terminal truth. */
export const AUTO_REVIEW_RETRY_INITIAL_MIN = 15;
export const AUTO_REVIEW_RETRY_MAX_MIN = 360;

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
  /** `pause-pr` hold: no dispatch/re-trigger while it stands. Read back
   * through `getPr`/`allPrs`, it is already folded against the hold's expiry
   * — a lapsed session pause reads 0. */
  paused: number;
  /** Who holds the pause and until when (null = until resumed; operator
   * only); all null when not paused. */
  pause_issuer: LeverIssuer | null;
  pause_expires_at: string | null;
  pause_reason: string | null;
  pause_since: string | null;
  updated_at: string;
}

/**
 * The reasons a round can be cancelled — the machine-readable half every
 * aggregate groups by (the prose stays in `summary`). `LOUD_CANCEL_CAUSES` is
 * which of them deserve a human's attention.
 */
export type CancelCause =
  /** Boot-time orphan sweep: tmux lives in the container, so a restart orphans
   * every in-flight round BY CONSTRUCTION. A redeploy artefact, never a defect. */
  | "orphan_sweep"
  /** The round stopped dead inside its deadline window with no verdict. A
   * real defect: a deadline overrun is never just a slow round. */
  | "deadline_overrun"
  /** The round's prompt never reached the session and redelivery could not
   * repair it — a delivery fault, not a review fault. */
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
  /** A newer round on the same PR outlived this one. Benign. */
  | "superseded"
  /** An operator unwedge lever (`rerun-round` / `restart-session`). */
  | "operator"
  /** Posting guard 2 refused the round's review because the head was already
   * reviewed with no author reply since. The review
   * work was healthy and the refusal was correct; nothing reached GitHub and
   * the prior standing review stands. Benign by definition — dispatch should
   * have skipped the round, and the durable event says which half did. */
  | "no_new_evidence"
  /** Older cancellation prose the migration could not classify. Never
   * inferred as benign: unknown is unknown. */
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
  "no_new_evidence",
  "unknown",
];

/**
 * The causes that deserve a human.
 *
 * `orphan_sweep` is deliberately not here: it is what a clean redeploy does to
 * every round in flight, and alarming on it would train everyone to ignore
 * cancellation entirely. `head_moved` and `superseded` are the system working.
 * What is left is a round that stopped dead: that gets an anomaly row.
 */
export const LOUD_CANCEL_CAUSES: ReadonlySet<CancelCause> = new Set<CancelCause>([
  "deadline_overrun",
  "infrastructure_failure",
]);

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
  no_new_evidence: "nothing new to post (guard 2)",
  operator: "operator",
  unknown: "unclassified",
};

export function cancelCauseLabel(cause: string | null | undefined): string {
  const key = (cause ?? "unknown") as CancelCause;
  return CANCEL_CAUSE_LABEL[key] ?? key;
}

/** A round's stored `executed_passes`, parsed; null = unknown (absent or
 * unparseable — an unparseable stored value reads as unknown, matching the
 * input side). */
export function parseExecutedPasses(raw: string | null | undefined): VerdictPassEntry[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as VerdictPassEntry[]) : null;
  } catch {
    return null;
  }
}

/** One cause's tally, as every cancellation surface reports it. */
export interface CancellationTally {
  cause: CancelCause;
  count: number;
  /** Whether this cause is human-attention grade (`LOUD_CANCEL_CAUSES`). */
  loud: boolean;
}

/** The one cancellation order: loud causes first, then by count, then by
 * cause — so a surface renders in order and never has to know the policy. */
export function cancellationOrder(a: CancellationTally, b: CancellationTally): number {
  return Number(b.loud) - Number(a.loud) || b.count - a.count || a.cause.localeCompare(b.cause);
}

/** Spend and measured tokens summed over `rounds`. Expired rounds count:
 * they blew a deadline, they did not get a refund — excluding them would
 * erase real token cost (see StateStore.totalSpend). */
export function roundUsage(
  rounds: readonly Pick<RoundRow, "est_usd" | "tokens_in" | "tokens_out">[],
): {
  spend_usd: number;
  tokens_in: number;
  tokens_out: number;
} {
  return {
    spend_usd: rounds.reduce((n, r) => n + (r.est_usd ?? 0), 0),
    tokens_in: rounds.reduce((n, r) => n + (r.tokens_in ?? 0), 0),
    tokens_out: rounds.reduce((n, r) => n + (r.tokens_out ?? 0), 0),
  };
}

/** Total cancellations and the subset requiring operator attention. */
export function cancellationTotals(tallies: ReadonlyArray<{ count: number; loud: boolean }>): {
  total: number;
  loud: number;
} {
  return {
    total: tallies.reduce((n, t) => n + t.count, 0),
    loud: tallies.filter((t) => t.loud).reduce((n, t) => n + t.count, 0),
  };
}

/** The cancelled rounds among `rounds`, grouped by cause (an unclassified
 * one is `unknown`) and in `cancellationOrder`. */
export function tallyCancellations(
  rounds: Iterable<{ status: string; cancel_cause: string | null }>,
): CancellationTally[] {
  const counts = new Map<string, number>();
  for (const r of rounds) {
    if (r.status !== "cancelled") continue;
    const cause = r.cancel_cause ?? "unknown";
    counts.set(cause, (counts.get(cause) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([cause, count]) => ({
      cause: cause as CancelCause,
      count,
      loud: isLoudCancelCause(cause),
    }))
    .sort(cancellationOrder);
}

/** Whether an optional source's table exists in this state database. */
export function tableExists(store: StateStore, name: string): boolean {
  return (
    store.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  );
}

/** The snapshot's heartbeat, with its legacy written_at field as fallback. */
export function snapshotHeartbeat(snapshot: {
  heartbeat?: unknown;
  written_at?: unknown;
}): string | null {
  return typeof snapshot.heartbeat === "string"
    ? snapshot.heartbeat
    : typeof snapshot.written_at === "string"
      ? snapshot.written_at
      : null;
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

// ---- Slack concierge rows ---------------------------------------------------
// Slack `ts` values are TEXT ALWAYS ("1755431234.001900"): they are opaque
// message ids whose precision a float would destroy.

/** Who a Slack message came from, in rights terms (resolved by the router).
 * The top tier is two roles, so the audit trail names which kind of authority
 * acted:
 *   `owner`  — the configured owner (`[owner] slack_id`): full personal
 *              command rights.
 *   `system` — the daemon's own unattended turns (EOD sweep, anomaly wake,
 *              connections signal), stamped only by `OriginStore.writeLocal`;
 *              `computeTier` never returns it for a Slack user.
 * A retired legacy spelling is accepted on input and folded to `owner` by
 * `foldSlackTier` — accepted on read, never emitted. */
export type SlackTier = "anyone" | "author" | "owner" | "system" | "ignored";

/**
 * Parse a persisted tier string into the current vocabulary. The retired
 * legacy top-tier spelling (older origin records and slack_events rows still
 * on disk) folds to `"owner"`; anything else unknown is `null` — an unknown
 * tier grants nothing. Every read path of a persisted tier goes through this
 * fold (origin records via `parseOriginRecord`, slack_events rows via
 * `StateStore.slackEvent`). Pinned by tests/legacy-acceptance.test.ts — a
 * permanent belt, not a cleanup candidate.
 */
export function foldSlackTier(raw: unknown): SlackTier | null {
  if (raw === "owner_legacy") return "owner"; // legacy — accepted on input, never emitted
  return raw === "anyone" ||
    raw === "author" ||
    raw === "owner" ||
    raw === "system" ||
    raw === "ignored"
    ? raw
    : null;
}

/** What the router did with a Slack message. Everything that is not
 * `injected` names the reason it never reached a session. `injected` and the
 * cap and delivery drops are history: the overseer is retired, so the router
 * now ends every admitted message in `dropped_no_overseer`. */
export type SlackDisposition =
  | "injected"
  | "dropped_echo"
  | "dropped_stale"
  | "dropped_delivery_failed"
  | "dropped_cap"
  | "dropped_no_overseer"
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

export interface SlackReopeningRow {
  incident_id: string;
  generation: string;
  pr: number;
  episode: string;
  cause: string;
  text: string;
  channel: string;
  ts: string;
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

/** The `reason` of the drain the worker crash-loop breaker sets. */
export const WORKER_FAILURES_DRAIN_REASON = "worker_failures";

/** The kinds of host lease: the operator's takeover, and a debug round. */
export type HostLeaseKind = "takeover" | "debug";

/** One PR's host lease row. */
export interface HostLeaseRow {
  pr: number;
  kind: HostLeaseKind;
  state: "held" | "ending";
  token: string;
  command_id: string;
  holder: string;
  granted_at: string;
  touched_at: string;
  ending_at: string | null;
  ending_why: string | null;
}

/** Why a host lease was not granted. */
export type HostLeaseGrant =
  { ok: true; row: HostLeaseRow } | { ok: false; why: "held" | "worker"; reason: string };

/** One PR's worker crash-loop breaker row. */
export interface WorkerBreakerRow {
  pr: number;
  /** Consecutive failed workers since the last success. */
  failures: number;
  /** Set once the PR is parked: no worker is spawned for it until an operator unparks it. */
  parked_at: string | null;
  last_error: string | null;
  last_failure_at: string | null;
  last_command_id: string | null;
}

/** Deploy-window drain state — one persistent row. Read back
 * through `drainState()` it is already folded against the hold's expiry: a
 * lapsed session drain reads `draining: false`. The union makes
 * the holder part of what "draining" means: there is no draining state
 * without an issuer. */
export type DrainState =
  | {
      draining: false;
      /** Webhook deliveries dropped while the LAST drain window stood. */
      drained_deliveries: number;
    }
  | {
      draining: true;
      /** Webhook deliveries dropped while the CURRENT drain window stood. */
      drained_deliveries: number;
      /** When the current drain was engaged. */
      since: string | null;
      /** Who holds the drain. */
      issued_by: LeverIssuer;
      /** When the hold lapses; null = until lifted (operator only). */
      expires_at: string | null;
      /** Why a SYSTEM engaged it (`worker_failures`, the crash-loop breaker); null
       * for a hand-set drain. A drain with a reason is lifted only by an explicit
       * `drain off`, never by a boot's first reconcile pass. */
      reason: string | null;
      /** The operator's no-auto-lift HOLD (`qcr drain on --hold`): no
       * boot's first reconcile lifts it, only an explicit operator `drain off`.
       * Always the operator's, never with an expiry. */
      hold: boolean;
    };

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
  redeliveries   INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  next_check_at  TEXT NOT NULL,
  started_at     TEXT,
  settled_at     TEXT,
  failed_at      TEXT,
  failure        TEXT,
  est_usd        REAL,
  lens_usd       REAL,
  usage_final    INTEGER NOT NULL DEFAULT 0
)`;

const SESSION_COMMAND_INDEXES_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS session_commands_one_active
  ON session_commands(session) WHERE status IN ('pending', 'running');
CREATE UNIQUE INDEX IF NOT EXISTS session_commands_inject_path ON session_commands(inject_path);
CREATE INDEX IF NOT EXISTS session_commands_pr_created ON session_commands(pr, created_at);`;

/** The prefix of every held-wake reason operator recovery writes
 * (`operator_recovered:<kind>:<id>`): owed work the per-PR cap never evicts
 * and the flush delivers first within its instant. */
export const OPERATOR_RECOVERED_WAKE_PREFIX = "operator_recovered:";

const PENDING_WAKE_ORDER_SQL = `held_at,
  CASE WHEN reason GLOB '${OPERATOR_RECOVERED_WAKE_PREFIX}*' THEN 0 ELSE 1 END,
  id`;

const BLOCKING_SESSION_COMMAND_SQL = `(
  c.status IN ('pending', 'running')
  OR (
    c.status='failed' AND c.kind!='answer' AND (
      c.kind!='round'
      OR NOT EXISTS (SELECT 1 FROM rounds r WHERE r.pr=c.pr AND r.round_no=c.round_no)
      OR EXISTS (SELECT 1 FROM rounds r WHERE r.pr=c.pr AND r.round_no=c.round_no AND r.status='running')
    )
  )
)`;

/** Does any once-per-key mark row (an events payload `{key, …}`) carry
 * `key`? An empty or unparseable payload carries none. */
function someMarkHasKey(rows: ReadonlyArray<{ payload: string | null }>, key: string): boolean {
  return rows.some((r) => {
    if (!r.payload) return false;
    try {
      return (JSON.parse(r.payload) as { key?: unknown }).key === key;
    } catch {
      return false;
    }
  });
}

/** A lever hold as stored (a pause on a PR row, the drain row): null when
 * not engaged. A hold with no issuer recorded predates issuers and reads as
 * the operator's with no expiry — the only shape it could have been, and the
 * fail-safe one: nothing lapses that nobody bounded. */
function storedHold(
  engaged: boolean,
  issuer: LeverIssuer | null,
  expiresAt: string | null,
): LeverHold | null {
  if (!engaged) return null;
  return { issuer: issuer ?? "operator", expires_at: issuer ? expiresAt : null };
}

/** When an `overdue` round may be buried as `expired` (the boot's one-shot
 * expiry and the recurring sweep apply it under their own age cut-offs): its
 * PR has closed, or a later-or-equal round of that PR delivered a verdict.
 * A round a rerun could still service (open PR, nothing decided since) never
 * matches. */
const OVERDUE_ROUND_BURIABLE_SQL = `(
  EXISTS (SELECT 1 FROM pr_state p WHERE p.number = rounds.pr AND p.state = 'closed')
  OR EXISTS (SELECT 1 FROM rounds r2 WHERE r2.pr = rounds.pr AND r2.id != rounds.id
               AND r2.backfilled = 0 AND r2.verdict IS NOT NULL AND r2.round_no >= rounds.round_no)
)`;

/** Durable escalation obligations, separate from the deliveries-only cap. */
export interface EscalationRecoveryRow {
  pr: number;
  target: string;
  scope_key: string;
  head_sha: string;
  body: string;
  marker: string;
  shape: "comment" | "review_request";
  origin: "rule" | "session";
  rule: string | null;
  round_no: number | null;
  phase: "prepared" | "posting" | "request_pending";
  last_error: string | null;
  next_attempt_at: string | null;
  updated_at: string;
}
export type EscalationRecoveryInput = Omit<
  EscalationRecoveryRow,
  "phase" | "last_error" | "next_attempt_at" | "updated_at"
>;

export interface WebhookInboxRow {
  guid: string;
  event: string;
  action: string | null;
  payload: string;
  interpretation: string | null;
  local_result: string | null;
  received_at: string;
  attempted_at: string | null;
  next_attempt_at: string | null;
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
  -- LEGACY (the old escalation mechanism): no longer read or written. Kept
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
-- Every per-PR read of rounds (hasRunningRound, roundsFor, the status
-- snapshot's latest-verdict subquery, the due-command check) was a full scan
-- of the table: 0.14 ms a call, 2,548 calls a reconcile pass, and 70-140 ms
-- for each heartbeat and each command-supervisor scan on 2,434 live rows.
CREATE INDEX IF NOT EXISTS rounds_pr_round ON rounds(pr, round_no);
CREATE TABLE IF NOT EXISTS webhook_inbox (
  guid TEXT PRIMARY KEY,event TEXT NOT NULL,action TEXT,payload TEXT NOT NULL,
  interpretation TEXT,local_result TEXT,received_at TEXT NOT NULL,attempted_at TEXT,next_attempt_at TEXT,last_error TEXT
);
CREATE TABLE IF NOT EXISTS bot_comments (
  comment_id INTEGER NOT NULL,
  pr INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'review_comment',
  posted_at TEXT NOT NULL,
  PRIMARY KEY (kind, comment_id)
);
-- The per-PR count of the bot's comments (qcr why, the outcome capture's
-- signature) read the whole table; closed-PR history stays live here, so it
-- must stop costing a scan (docs/archiving.md §9.7).
CREATE INDEX IF NOT EXISTS bot_comments_pr ON bot_comments(pr);
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
-- Human-comment capture: every human comment on a
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
-- The durable reasoning record: why each candidate
-- finding was raised or killed. Parsed out of the session-written
-- state/findings/pr-<n>-round-<k>.json — the file is the artifact, these are
-- the countable rows "how often the review backs down" needs.
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
  -- posted | killed | doubted | downgraded | merged | folded | withheld |
  -- conceded | unknown. conceded = refuted-and-conceded: the state that lets a
  -- later round tell escalating an OPEN finding from resurrecting a SETTLED
  -- one. doubted = the validator's validity veto kept as a mark:
  -- never posted, shown in the TUI.
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
-- Follow-up rounds: the prior findings a round was handed to verify
-- (listed by the daemon at order build) and the status the session reported
-- for each in its findings record's top-level "prior" array. One row per
-- (checking round, checked finding). status NULL = listed, not reported.
-- listed_at NULL = reported without having been listed (a ref the session
-- took from its own ledger) — kept, never dropped.
CREATE TABLE IF NOT EXISTS prior_finding_checks (
  pr INTEGER NOT NULL,
  checked_round INTEGER NOT NULL,
  head_sha TEXT NOT NULL DEFAULT '',
  round_no INTEGER NOT NULL,
  finding_key TEXT NOT NULL,
  blocking INTEGER NOT NULL DEFAULT 0,
  status TEXT,
  evidence TEXT,
  listed_at TEXT,
  reported_at TEXT,
  PRIMARY KEY (pr, checked_round, round_no, finding_key)
);
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
-- Wakes held while their PR's round was in flight (single-shepherd invariant:
-- the PR's ONE main pi is never given two instructions at once). Flushed
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
-- Post-approval delta rechecks: one durable claim per question.
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
-- Rendered non-push questions remain owed independently of capped active wakes.
CREATE TABLE IF NOT EXISTS recheck_deliveries (
  pr INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  payload TEXT NOT NULL,
  reason TEXT NOT NULL,
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
-- An observed absent-to-present human request is owed until lifecycle publication.
CREATE TABLE IF NOT EXISTS trigger_edges (
  pr INTEGER NOT NULL,
  kind TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  PRIMARY KEY (pr, kind)
);
-- A newer head observed while an older round owns the PR is durable
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
-- Canonical FAILED_LOUD review debt. Orthogonal to GitHub lifecycle:
-- a PR may be queued while this hold prevents dispatch. Most failure classes
-- remain until explicit operator recovery. The exact pre-fanout class is
-- instead a durable circuit breaker with a finite next_retry_at.
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
  retry_epoch  INTEGER NOT NULL DEFAULT 0,
  reopen_epoch INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  failed_at    TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  recovered_at TEXT,
  recovery     TEXT,
  next_action  TEXT NOT NULL,
  work_owed    INTEGER NOT NULL CHECK(work_owed IN (0,1))
);
CREATE UNIQUE INDEX IF NOT EXISTS review_failures_one_open_pr
  ON review_failures(pr) WHERE work_owed=1;
-- Identity-bound instructions for one recovery successor. Rows are
-- historical receipts, so retry epochs survive restart and a successful
-- fanout naturally resets the next unrelated round to epoch zero.
CREATE TABLE IF NOT EXISTS round_recovery_instructions (
  pr                 INTEGER NOT NULL,
  target_round_no    INTEGER NOT NULL,
  target_head_sha    TEXT NOT NULL,
  stage              TEXT NOT NULL,
  source_incident_id TEXT,
  source_command_id  TEXT NOT NULL,
  source_round_no    INTEGER NOT NULL,
  immediate_attempt  INTEGER NOT NULL,
  retry_epoch        INTEGER NOT NULL,
  created_at         TEXT NOT NULL,
  PRIMARY KEY (pr, target_round_no)
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
-- Deploy-window drain: ONE row, id = 1. While draining the
-- webhook drops deliveries (counted here), the pump starts nothing, and
-- recheck/ping-pong/EOD hold -- in-flight rounds still run to their natural
-- end. Persistent on purpose: the flag must survive the container restart the
-- drain exists for; it is lifted by the new boot's first HEALTHY reconcile
-- pass, or by an explicit 'drain off' command. A HOLD (column hold = 1, added
-- by migrateDrainHold) is lifted only by an explicit 'drain off'.
CREATE TABLE IF NOT EXISTS drain_state (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  draining           INTEGER NOT NULL DEFAULT 0,
  drained_deliveries INTEGER NOT NULL DEFAULT 0,
  since              TEXT,
  updated_at         TEXT NOT NULL
);
-- Worker crash-loop breaker: consecutive worker failures per PR. A PR
-- with parked_at set gets no worker until the operator's rerun-round or
-- restart-session clears the row. worker_breaker_global.epoch ticks at every
-- worker success (and at the lift of the breaker's drain); a failure counts
-- toward the global drain only while it carries the current epoch.
CREATE TABLE IF NOT EXISTS worker_breaker (
  pr              INTEGER PRIMARY KEY,
  failures        INTEGER NOT NULL DEFAULT 0,
  parked_at       TEXT,
  last_error      TEXT,
  last_failure_at TEXT,
  last_command_id TEXT,
  failure_epoch   INTEGER NOT NULL DEFAULT 0,
  updated_at      TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS worker_breaker_global (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  epoch      INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
-- The host lease: who holds a PR's session while the operator works
-- in it. One row per PR, so a PR has one holder. It is granted only while no worker
-- command owns the session (the grant checks session_commands in its own
-- transaction), it holds dispatch and parks wakes while it stands, and a worker
-- is refused while it does. state 'ending' is a lease whose pi was told to stop
-- and not yet seen gone: it stays, and keeps every worker out, until the daemon has
-- confirmed the process is gone (two writers never append to one JSONL).
CREATE TABLE IF NOT EXISTS pr_host_leases (
  pr         INTEGER PRIMARY KEY,
  kind       TEXT NOT NULL,       -- 'takeover' (a debug round shares the table)
  state      TEXT NOT NULL,       -- 'held' | 'ending'
  token      TEXT NOT NULL,       -- fences the row: only the grant's holder updates it
  command_id TEXT NOT NULL,       -- the host's IPC command id (its capability)
  holder     TEXT NOT NULL,       -- who asked, for a person reading status
  granted_at TEXT NOT NULL,
  touched_at TEXT NOT NULL,       -- the last activity the daemon saw
  ending_at  TEXT,
  ending_why TEXT
);
-- Session lever grants: every bounded drain / pause a SESSION was
-- granted, with the minutes it drew from that day's budget. The per-day cap
-- is the SUM over this table; the operator's own levers never write here.
CREATE TABLE IF NOT EXISTS lever_grants (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,       -- 'drain' | 'pause'
  pr         INTEGER,             -- the paused PR; NULL for a drain
  minutes    INTEGER NOT NULL,
  day        TEXT NOT NULL,       -- [ops] timezone day the grant is charged to
  granted_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS lever_grants_day ON lever_grants (kind, day, pr);
-- Operator command files handled. The operator's commands/operator/
-- directory is root-owned and NOT writable by the daemon, so a handled file
-- cannot be archived by rename the way commands/processed/ does it; this
-- ledger is what keeps a restart from executing one twice. Keyed by file
-- VERSION (name + inode + mtime + size, operatorCommandVersion), not by
-- name: a name written again with new content is a new command.
CREATE TABLE IF NOT EXISTS operator_commands (
  version    TEXT PRIMARY KEY,
  file       TEXT NOT NULL,
  handled_at TEXT NOT NULL
);
-- Owed post-settlement work. A terminal replay marker and its obligations
-- share a transaction; completion receipts prevent later duplicate effects.
CREATE TABLE IF NOT EXISTS round_work (
  key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  pr INTEGER NOT NULL,
  round_no INTEGER NOT NULL,
  payload TEXT NOT NULL,
  due_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS round_work_pending ON round_work (kind, due_at) WHERE completed_at IS NULL;
CREATE TABLE IF NOT EXISTS filed_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,           -- 'improvement_pr' | 'issue'
  title TEXT NOT NULL,
  ref TEXT,
  filed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS command_effect_receipts (
  delivery_key TEXT PRIMARY KEY,
  result TEXT
);
-- Commands without a richer handler-owned recovery journal reserve before
-- effects; a pending row means interrupted/unknown, never permission to repeat.
CREATE TABLE IF NOT EXISTS command_delivery_receipts (
  delivery_key TEXT PRIMARY KEY,
  result TEXT
);
-- Stable command delivery receipts for issue filing; the cap reservation and
-- pending receipt are committed together before the gated creation request.
CREATE TABLE IF NOT EXISTS filing_receipts (
  delivery_key TEXT PRIMARY KEY,
  slot INTEGER NOT NULL REFERENCES filed_items(id),
  result TEXT
);
-- Escalation deliveries (the optional off-by-default feature).
--
-- One row per escalation that ACTUALLY REACHED GITHUB. A suppressed one --
-- dry-run, or a posting guard refusing -- writes no row, so a dry-run
-- bring-up can never consume the dedup key or the cap that a later live run
-- needs.
--
-- The unique index below buys exactly this and no more: the same person is not
-- pointed at the same file (or the same named decision) on the same PR twice.
-- It is scoped per (pr, target), so it is not a defence against a session
-- naming several different files on one PR -- that is what
-- [escalation] max_per_pr bounds, and the two together are the whole budget.
-- Rows exist only when [escalation] enabled = true; on a default install the
-- table stays empty forever.
CREATE TABLE IF NOT EXISTS escalations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  pr           INTEGER NOT NULL,
  target       TEXT NOT NULL,
  scope_key    TEXT NOT NULL,
  shape        TEXT NOT NULL,   -- 'comment' | 'review_request'
  origin       TEXT NOT NULL,   -- 'rule' | 'session'
  rule         TEXT,
  round_no     INTEGER,
  delivered_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS escalations_once ON escalations(pr, target, scope_key);
-- Only confirmed deliveries spend ledger slots; ambiguous POSTs reserve capacity.
CREATE TABLE IF NOT EXISTS escalation_recovery (
  pr INTEGER NOT NULL,
  target TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  body TEXT NOT NULL,
  marker TEXT NOT NULL,
  shape TEXT NOT NULL,
  origin TEXT NOT NULL,
  rule TEXT,
  round_no INTEGER,
  phase TEXT NOT NULL,
  last_error TEXT,
  next_attempt_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (pr, target, scope_key)
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
CREATE TABLE IF NOT EXISTS slack_reopenings (
  incident_id TEXT PRIMARY KEY,
  generation TEXT NOT NULL,
  pr INTEGER NOT NULL,
  episode TEXT NOT NULL,
  cause TEXT NOT NULL,
  text TEXT NOT NULL,
  channel TEXT NOT NULL,
  ts TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS slack_cooldowns (
  key           TEXT PRIMARY KEY,
  last_fired_at TEXT NOT NULL,
  -- The STORED name predates the configurable operations timezone and is
  -- deliberately KEPT — a rename migration on live
  -- state buys nothing. It now holds the ops-day token whatever the
  -- configured zone; code reads it as "day" (SlackCooldownRow) through the
  -- alias in slackCooldown(), so "warsaw" appears nowhere outside this file.
  warsaw_day    TEXT NOT NULL,
  fire_count    INTEGER NOT NULL DEFAULT 1,
  fold_count    INTEGER NOT NULL DEFAULT 0,
  bypassed      INTEGER NOT NULL DEFAULT 0
);
-- Archiving (docs/archiving.md §8.1): one row per PR the archiver
-- has started on. The row is committed BEFORE the first byte of a PR leaves,
-- with the newest original mtime among the transcripts it is about to move
-- (max_mtime_ms) — that arms the receipt guard (an archived receipt reads
-- UNKNOWN, never absent). Plan mode writes no row.
CREATE TABLE IF NOT EXISTS archive_prs (
  pr               INTEGER PRIMARY KEY,
  state            TEXT NOT NULL
                   CHECK (state IN ('archiving', 'archived', 'restoring', 'restored', 'restore_failed')),
  passes           INTEGER NOT NULL DEFAULT 0,
  started_at       TEXT,
  archived_at      TEXT,
  restored_at      TEXT,
  transcript_files INTEGER NOT NULL DEFAULT 0,
  state_files      INTEGER NOT NULL DEFAULT 0,
  bytes_in         INTEGER NOT NULL DEFAULT 0,
  bytes_out        INTEGER NOT NULL DEFAULT 0,
  max_mtime_ms     INTEGER,
  last_error       TEXT,
  updated_at       TEXT NOT NULL
);
-- The DB mover's watermarks (docs/archiving.md §9.2): 'events.last_id',
-- 'deliveries.last_rowid'. Absent = nothing moved yet.
CREATE TABLE IF NOT EXISTS archive_marks (
  name  TEXT PRIMARY KEY,
  value NOT NULL
);
-- Event rows moved to the archive DB, per (kind, UTC day), updated in the
-- same transaction as the live delete (docs/archiving.md §9.4): what keeps the
-- all-time window of qcr metrics continuous.
CREATE TABLE IF NOT EXISTS archived_event_counts (
  kind TEXT NOT NULL,
  day  TEXT NOT NULL,
  n    INTEGER NOT NULL,
  PRIMARY KEY (kind, day)
);
-- A session review POST GitHub answered 5xx (or not at all), handed
-- to the daemon as a deferred posting receipt. One row per posting key: the
-- retry schedule runs from first_failed_at (config [daemon]
-- posting_retry_offsets_min, inside posting_retry_window_min); attempts is
-- written BEFORE each attempt's first GitHub call, so a restart mid-attempt
-- resumes at the next offset and never repeats one. The exact payload lives
-- in the outbox job beside the receipt (state/posting-receipts/). status:
-- pending | confirmed | exhausted | abandoned.
CREATE TABLE IF NOT EXISTS posting_retries (
  posting_key     TEXT PRIMARY KEY,
  pr              INTEGER NOT NULL,
  round_no        INTEGER NOT NULL,
  head_sha        TEXT NOT NULL,
  first_failed_at TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',
  last_error      TEXT,
  updated_at      TEXT NOT NULL
);
`;

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
  /** The signal's reviewer-memory entry: `pending` — owed, the backfill pump
   * writes it; `written` — in memory (`memory_uri` names it, or NULL for an
   * older entry written under an unrecorded name); `failed` — memory refused
   * it `FEEDBACK_MEMORY_MAX_ATTEMPTS` times and the pump gave up, loudly;
   * `skipped` — memory is switched off. NULL only before the boot migration
   * has classified an older row. */
  memory_state: FeedbackMemoryState | null;
  memory_attempts: number;
  memory_last_error: string | null;
  memory_uri: string | null;
  /** Since when memory has owed this row: its insert, the migration that
   * classified an older row owed, or the re-queue of a row given up on. NULL
   * for a row that was never owed (written at once, skipped). */
  memory_owed_since: string | null;
}

/** Where a feedback signal's memory entry stands. */
export type FeedbackMemoryState = "pending" | "written" | "failed" | "skipped";

/** The feedback ledger's memory backlog, for the backlog wake and the
 * status.json `memory` block. */
export interface FeedbackMemoryBacklog {
  pending: number;
  failed: number;
  /** Since when the longest-owed pending row has been owed
   * (`memory_owed_since`, else its `created_at`); null when none is pending. */
  oldest_pending_at: string | null;
  /** That row. */
  oldest_pending: FeedbackSignalRow | null;
}

/** What `recordFeedbackSignal` takes: the ledger row's natural fields, plus
 * the memory state it starts in (`pending` by default) and an
 * optional note for `memory_last_error` (why a row starts `skipped`). */
export interface FeedbackSignalInput {
  kind: string;
  pr: number;
  comment_id?: number | null;
  review_id?: number | null;
  in_reply_to_id?: number | null;
  scope?: string | null;
  author?: string | null;
  body?: string | null;
  day: string;
  memory_state?: FeedbackMemoryState;
  memory_note?: string | null;
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
  /** A captured review's own state, lowercased; null for a
   * comment, and for a review captured before the column existed. */
  review_state?: string | null;
}

/** One deferred review posting the daemon owes. */
export interface PostingRetryRow {
  posting_key: string;
  pr: number;
  round_no: number;
  head_sha: string;
  first_failed_at: string;
  attempts: number;
  last_attempt_at: string | null;
  status: "pending" | "confirmed" | "exhausted" | "abandoned";
  last_error: string | null;
  updated_at: string;
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

/** Self-requeues a PR has spent, split by whether the row could be
 * attributed to the head asked about. `unattributed` rows are requeues that
 * certainly happened, at a head that cannot be read — they count against the
 * cap. */
export interface SelfRequeueSpend {
  at_head: number;
  unattributed: number;
}

/** One string field out of an event payload, or `undefined` when the payload
 * is null, is not JSON, or does not carry that field as a string. The two
 * per-PR ledger reads in `StateStore` (`migrationCollisionCommented`,
 * `selfRequeueSpend`) build their three-state answers on this: a row that
 * yields `undefined` is UNREADABLE, never a row that "did not match". */
function readStringField(payload: string | null, field: string): string | undefined {
  if (!payload) return undefined;
  try {
    const value = (JSON.parse(payload) as Record<string, unknown>)[field];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** A boolean field of an event payload; `undefined` when absent or unreadable. */
function readBooleanField(payload: string | null, field: string): boolean | undefined {
  if (!payload) return undefined;
  try {
    const value = (JSON.parse(payload) as Record<string, unknown>)[field];
    return typeof value === "boolean" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Durable command lifecycle at the daemon→Pi boundary. */
export type SessionCommandStatus = "pending" | "running" | "acked" | "failed" | "cancelled";
export type SessionCommandKind = "round" | "wake" | "answer" | "legacy";

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
  /** Same-session redeliveries — the row handed back
   * to `pending` with its file rewritten, the session left alive. Bounded by
   * `[daemon] max_prompt_redeliveries` before any kill-and-replay. */
  redeliveries: number;
  created_at: string;
  updated_at: string;
  next_check_at: string;
  started_at: string | null;
  settled_at: string | null;
  failed_at: string | null;
  failure: string | null;
  /** What the command's worker reported it spent: the session, its in-process
   * lenses and the warm-ups. Null until a report arrives. */
  est_usd: number | null;
  /** The lens share of `est_usd`. */
  lens_usd: number | null;
  /** 1 once the worker's closing report arrived: `est_usd` is the whole command's
   * spend. Before it, a figure is a partial (and a crashed worker never closes). */
  usage_final: number;
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

/** A wake held while its PR's round was in flight (single-shepherd invariant). */
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

/** Per-PR ceiling on held ORDINARY wakes. Ordinary wakes yield rows when
 * pressure exceeds this cap — push recheck nudges first, oldest first (the
 * reconcile backstop asks them again), then the rest oldest first.
 * Operator-recovered and actively leased rows are protected: preserving
 * owed work wins over the numeric ceiling. Author replies are outside the cap
 * altogether (`AUTHOR_REPLY_WAKE_REASON`): never evicted and never counted. */
export const MAX_HELD_WAKES = 5;

/** The reason prefix of every recheck nudge (`recheck:<trigger>`). The
 * held-wake cap releases the claim of an evicted one. While its PR is paused,
 * a held recheck is deferred (`wakes.ts`): a pause stops the PR's review work,
 * and a recheck is review work — held until the resume, never dropped. A
 * pause stops no other wake: the flush skips the deferred rechecks and
 * delivers everything else in arrival order. */
export const RECHECK_WAKE_PREFIX = "recheck:";

/** The held-wake reason of a recheck nudge for one trigger. */
export function recheckWakeReason(trigger: string): string {
  return `${RECHECK_WAKE_PREFIX}${trigger}`;
}

/** The one held-wake reason a sweep raises again — the
 * reconcile push backstop (`reconcile.ts`) re-asks an APPROVE-standing PR's
 * delta at its current head whenever that push question is unclaimed. A
 * `recheck:ci` or `recheck:base_advance` nudge has no such sweep: once
 * evicted, only an identical webhook can ask it again. */
export const RECHECK_WITH_BACKSTOP_WAKE_REASON = recheckWakeReason("push");

/** The held-wake reason of an author reply in a bot thread. Each one is a
 * claimed obligation (`pingpong_handled` refuses every redelivery, and the
 * reconcile comment sweep only captures), so an evicted reply would never be
 * answered. A burst is delivered as one coalesced run, so they cost the
 * session one turn, not one each — the cap has nothing to save by dropping
 * them. */
export const AUTHOR_REPLY_WAKE_REASON = "author_reply";

/** One held wake the per-PR cap removed. */
export interface EvictedWake {
  id: number;
  reason: string;
  /** The recheck claim this eviction released — the fingerprint — so the
   * next identical trigger may ask the question again (a claim is released
   * on a provable non-delivery, and a nudge evicted from the held queue was
   * never sent). Null otherwise. */
  released_recheck: string | null;
  /** True only for a push recheck, which the reconcile backstop re-raises
   * (`RECHECK_WITH_BACKSTOP_WAKE_REASON`). CI/base claims retain their
   * independent rendered delivery obligation instead of being released. */
  re_raised_by_reconcile: boolean;
}

/**
 * How long an `overdue` round may sit before it counts as STRANDED.
 *
 * Deliberately far wider than `expire_overdue_after_h` (24h by config): that
 * sweep buries rounds whose PR has moved on, this one is about rounds nothing
 * will ever come back for. Seven days is "a week went by and nobody noticed".
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
  /** Follow-up round columns (see RoundRow). */
  head_sha?: string | null;
  merge_base?: string | null;
  scope?: "full" | "delta" | null;
  delta_base_sha?: string | null;
  delta_lines?: number | null;
  delta_files?: number | null;
  sweep_owed?: boolean | null;
  sweep_plan?: PassPlanEntry[] | null;
  sweep_status?: SweepStatus | null;
}

/** One recheck claim, as `rechecksFor` reads it. */
export interface RecheckClaimRow {
  pr: number;
  fingerprint: string;
  head_sha: string;
  trigger: string;
  reason: string | null;
  created_at: string;
  /** 0 = answered without a wake (no receipt token can exist). */
  nudged: number;
  /** When the undelivered sweep found the wake's receipt token. */
  receipt_at: string | null;
  /** When the sweep last asked about it without deciding. */
  receipt_checked_at: string | null;
}

/**
 * state.db and its WAL files are the daemon's alone: where the
 * model's tools run as another uid they share the state directory's group, and
 * the database holds every PR's records. SQLite creates the -wal and -shm files
 * with the database file's mode, so the three are set once here. Best effort: a
 * file another uid owns is left as it is.
 */
function ownerOnly(path: string): void {
  for (const f of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      chmodSync(f, 0o600);
    } catch {
      // absent, or not ours to change
    }
  }
}

export class StateStore {
  readonly db: Database.Database;

  constructor(
    readonly path: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    if (path !== ":memory:") ownerOnly(path);
    // The inject bridge is a second WAL writer. A short daemon-side wait keeps
    // routine cross-process commits from turning into partial handoffs while
    // preserving a finite failure that supervisor health can expose. The wait
    // covers autocommit statements and BEGIN IMMEDIATE only: a deferred
    // transaction that reads before it writes upgrades its lock without the
    // busy handler and throws SQLITE_BUSY at once, so such a transaction runs
    // `.immediate()` (tests/state-cross-writer-busy.test.ts).
    this.db.pragma("busy_timeout = 2000");
    this.db.exec(SCHEMA);
    // Additive columns. Each ALTER is independent so a
    // partially-migrated store converges; re-running is a no-op.
    for (const ddl of [
      "ALTER TABLE pr_state ADD COLUMN paused INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE rounds ADD COLUMN summary TEXT",
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
      // The integrity fingerprint taken when this round's worktree was
      // prepared, re-checked when the round is measured. JSON
      // {digest, files} — the files map is kept so the anomaly can name which
      // path moved rather than only that something did. It covers git's
      // configuration surface and this system's own policy surface
      // (config.toml, scripts/, dist/, …) despite the column's name.
      "ALTER TABLE rounds ADD COLUMN git_config_fingerprint TEXT",
      "ALTER TABLE bot_comments ADD COLUMN round_no INTEGER",
      // Measured usage — nullable, additive.
      "ALTER TABLE rounds ADD COLUMN tokens_in INTEGER",
      "ALTER TABLE rounds ADD COLUMN tokens_out INTEGER",
      "ALTER TABLE rounds ADD COLUMN tokens_cache_read INTEGER",
      "ALTER TABLE rounds ADD COLUMN est_usd REAL",
      // Slack concierge — cooldown fold/bypass memory.
      "ALTER TABLE slack_cooldowns ADD COLUMN fold_count INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE slack_cooldowns ADD COLUMN bypassed INTEGER NOT NULL DEFAULT 0",
      // The validator's tier for the round — nullable, additive.
      "ALTER TABLE rounds ADD COLUMN validate_tier TEXT",
      // Executed-pass telemetry — JSON array, nullable, additive.
      "ALTER TABLE rounds ADD COLUMN executed_passes TEXT",
      // Immutable dispatched policy for sanctioned added passes.
      "ALTER TABLE rounds ADD COLUMN pass_plan TEXT",
      "ALTER TABLE rounds ADD COLUMN addable_passes TEXT",
      // Trigger provenance — "human" | "system", nullable, additive.
      // Null = legacy/unknown, which dispatch treats as human (full round).
      "ALTER TABLE pr_state ADD COLUMN trigger_provenance TEXT",
      // Lever holds: who holds the drain / a pause and until when.
      // Nullable, additive. A row with no issuer that is draining or paused
      // reads as an OPERATOR hold with no expiry — the only shape it could
      // have been, and the fail-safe one: nothing lapses that nobody bounded.
      "ALTER TABLE drain_state ADD COLUMN issued_by TEXT",
      "ALTER TABLE drain_state ADD COLUMN expires_at TEXT",
      // Why a system engaged the drain (the worker crash-loop breaker) — nullable, additive.
      "ALTER TABLE drain_state ADD COLUMN reason TEXT",
      "ALTER TABLE pr_state ADD COLUMN pause_issuer TEXT",
      "ALTER TABLE pr_state ADD COLUMN pause_expires_at TEXT",
      "ALTER TABLE pr_state ADD COLUMN pause_reason TEXT",
      "ALTER TABLE pr_state ADD COLUMN pause_since TEXT",
      // First-seen-silent mark for the lost-prompt net —
      // nullable, additive.
      "ALTER TABLE rounds ADD COLUMN silent_since TEXT",
      // The prompt receipt token stamped into this round's wake file —
      // nullable, additive. NULL means the round was dispatched by a build
      // that did not stamp one, so its delivery CANNOT be verified and every
      // reader must fall back to the older inference. Never backfill it: a
      // fabricated token would assert a receipt nobody ever saw.
      "ALTER TABLE rounds ADD COLUMN prompt_marker TEXT",
      // How many times this round's prompt has been re-delivered.
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
      // Old rows are deliberately unknown; only rounds created by a
      // build that brackets the preflight posting call can enter auto-retry.
      "ALTER TABLE rounds ADD COLUMN preflight_posting_state TEXT NOT NULL DEFAULT 'unknown'",
      "ALTER TABLE rounds ADD COLUMN fanout_started_at TEXT",
      // An owed round-end measurement survives a
      // restart (the window's end, NULL once measured). Nullable, additive.
      "ALTER TABLE rounds ADD COLUMN usage_owed_to TEXT",
      // Follow-up rounds — nullable, additive. NULL scope on a
      // non-first round = a legacy full re-review.
      "ALTER TABLE rounds ADD COLUMN head_sha TEXT",
      "ALTER TABLE rounds ADD COLUMN scope TEXT",
      "ALTER TABLE rounds ADD COLUMN delta_base_sha TEXT",
      "ALTER TABLE rounds ADD COLUMN delta_lines INTEGER",
      "ALTER TABLE rounds ADD COLUMN delta_files INTEGER",
      "ALTER TABLE rounds ADD COLUMN sweep_owed INTEGER",
      "ALTER TABLE rounds ADD COLUMN sweep_plan TEXT",
      "ALTER TABLE rounds ADD COLUMN sweep_status TEXT",
      "ALTER TABLE rounds ADD COLUMN merge_base TEXT",
      // Held wakes are leased and acked only after delivery.
      "ALTER TABLE pending_wakes ADD COLUMN claim_token TEXT",
      "ALTER TABLE pending_wakes ADD COLUMN claimed_at TEXT",
      "ALTER TABLE pending_wakes ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0",
      // One finite ambiguity allowance per command attempt.
      "ALTER TABLE session_commands ADD COLUMN unknown_checks INTEGER NOT NULL DEFAULT 0",
      // Automatic same-command replay attempts are durable even when
      // rebirth fails before a new bridge can reserve the command.
      "ALTER TABLE session_commands ADD COLUMN recovery_attempts INTEGER NOT NULL DEFAULT 0",
      // Same-session redeliveries of a command whose
      // start lease ran out on a live, ready bridge — bounded on their own,
      // before any kill-and-replay recovery is spent.
      "ALTER TABLE session_commands ADD COLUMN redeliveries INTEGER NOT NULL DEFAULT 0",
      // What the command's worker reported it spent. `usage_final` is set
      // only by the worker's closing report; a figure without it is a crash's partial.
      "ALTER TABLE session_commands ADD COLUMN est_usd REAL",
      "ALTER TABLE session_commands ADD COLUMN lens_usd REAL",
      "ALTER TABLE session_commands ADD COLUMN usage_final INTEGER NOT NULL DEFAULT 0",
      // Durable circuit-breaker generation and due time. Nullable due
      // means this failure remains in the operator-owned classes.
      "ALTER TABLE review_failures ADD COLUMN retry_epoch INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE review_failures ADD COLUMN next_retry_at TEXT",
      "ALTER TABLE review_failures ADD COLUMN reopen_epoch INTEGER NOT NULL DEFAULT 0",
      // The feedback ledger tracks its own memory write, so a
      // signal memory did not take is owed, not lost. `memory_state` is
      // nullable on purpose: NULL means "a row from before this column", and
      // the boot's data migration classifies those once
      // (`classifyLegacyFeedbackMemory`). Every row written since carries a
      // state from its insert.
      "ALTER TABLE feedback_signals ADD COLUMN memory_state TEXT",
      "ALTER TABLE feedback_signals ADD COLUMN memory_attempts INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE feedback_signals ADD COLUMN memory_last_error TEXT",
      "ALTER TABLE feedback_signals ADD COLUMN memory_uri TEXT",
      // …and since when it has been owed: the insert for a new row, the
      // migration's instant for an older row, the re-queue's for a row given
      // up on and queued again. The backlog wake measures from it — an old
      // signal queued today has waited minutes, not weeks.
      "ALTER TABLE feedback_signals ADD COLUMN memory_owed_since TEXT",
      // Outcome capture: the posted comment's one-line title as
      // the session wrote it (null when the record carries none — it is never
      // invented), and the canonical lens ids parsed from the free-text
      // `lens` (packages/pi-plugin/src/lensids.ts; JSON array, `[]` = raised outside any known
      // lens). Both nullable and additive; the boot fills `lens_ids` for rows
      // recorded before the column (`fillLensIds`).
      "ALTER TABLE round_findings ADD COLUMN title TEXT",
      "ALTER TABLE round_findings ADD COLUMN lens_ids TEXT",
      // The learner: the state a captured REVIEW was submitted
      // with (`approved` | `changes_requested` | `commented`, GitHub's own
      // word, lowercased). Nullable: inline and top-level comments have none,
      // and a review captured before the column is unknown — the miner then
      // never reads it as a request for changes.
      "ALTER TABLE pr_comments ADD COLUMN review_state TEXT",
    ])
      this.addColumn(ddl);
    this.migrateBotCommentNamespaces();
    this.db.exec("CREATE INDEX IF NOT EXISTS bot_comments_id ON bot_comments(comment_id)");
    this.migrateRecheckReceipts();
    this.migrateDrainHold();
    this.migrateSessionCommandCancelledStatus();
    this.runDataMigrations();
  }

  /**
   * Run one additive `ALTER TABLE … ADD COLUMN`: true when it added the
   * column, false when the column was already there. Any other failure (a
   * full disk, a locked database, a malformed DDL) is thrown naming the DDL,
   * so an upgrade that did not apply stops the boot rather than surfacing
   * later as a missing-column error with the cause gone.
   */
  private addColumn(ddl: string): boolean {
    try {
      this.db.exec(ddl);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/duplicate column name/i.test(message)) return false;
      throw new Error(`state.db migration failed: ${ddl}: ${message}`, { cause: err });
    }
  }

  /** Preserve GitHub's independent numeric comment namespaces across upgrades. */
  private migrateBotCommentNamespaces(): void {
    const keys = (this.db.pragma("table_info(bot_comments)") as Array<{ name: string; pk: number }>)
      .filter((c) => c.pk > 0)
      .map((c) => c.name);
    if (keys.length === 2 && keys.includes("kind") && keys.includes("comment_id")) return;
    this.db.transaction(() => {
      this.db.exec(`CREATE TABLE bot_comments_namespace_upgrade (
        comment_id INTEGER NOT NULL,pr INTEGER NOT NULL,kind TEXT NOT NULL DEFAULT 'review_comment',
        posted_at TEXT NOT NULL,round_no INTEGER,PRIMARY KEY(kind,comment_id));
        INSERT INTO bot_comments_namespace_upgrade SELECT comment_id,pr,kind,posted_at,round_no FROM bot_comments;
        DROP TABLE bot_comments;
        ALTER TABLE bot_comments_namespace_upgrade RENAME TO bot_comments;
        CREATE INDEX bot_comments_pr ON bot_comments(pr);`);
    })();
  }

  /**
   * Three columns make the undelivered-recheck sweep incremental, so it never
   * re-proves every claim's receipt on every pass:
   *   - `nudged` — 0 for a claim no wake was ever sent for (a trivial-delta
   *     no-op, `noop:*`, or a dispatch short-circuit). Such a claim carries no
   *     receipt token by construction, so the sweep must never read it: it
   *     would release it as "undelivered" the moment the session wrote
   *     anything, and the push backstop would re-ask a question already
   *     answered.
   *   - `receipt_at` — when the sweep found the claim's token: a delivered
   *     nudge is a fact, recorded once and never re-read.
   *   - `receipt_checked_at` — when the sweep last asked about a claim still
   *     undecided; the sweep visits the least recently asked first, so a
   *     per-pass budget never starves the same tail.
   * Additive and idempotent; the backfill runs only in the boot that adds
   * `nudged`, from the reason the claim was written with, and commits with
   * the column — a boot cut short between the two leaves neither.
   */
  private migrateRecheckReceipts(): void {
    this.db.transaction(() => {
      if (!this.addColumn("ALTER TABLE rechecks ADD COLUMN nudged INTEGER NOT NULL DEFAULT 1"))
        return;
      const info = this.db
        .prepare(
          `UPDATE rechecks SET nudged = 0
            WHERE reason LIKE 'noop:%' OR reason LIKE 'dispatch-short-circuit:%'`,
        )
        .run();
      if (info.changes > 0)
        this.logEvent("recheck_claims_unnudged_backfilled", null, { count: info.changes });
    })();
    this.addColumn("ALTER TABLE rechecks ADD COLUMN receipt_at TEXT");
    this.addColumn("ALTER TABLE rechecks ADD COLUMN receipt_checked_at TEXT");
  }

  /**
   * The operator's no-auto-lift drain HOLD: `drain_state.hold`.
   *
   * The boot that adds the column CARRIES a standing operator drain over as a
   * hold. That drain was set by a daemon that could not spell a hold, and the
   * one place this matters is the cutover: the legacy daemon takes the
   * cutover's `qcr drain on` (it refuses an unknown `hold` field), and the
   * release's first boot is the boot that adds this column — so the drain the
   * owner set before the release still stands after the new daemon's first
   * healthy reconcile, until the owner's checked worker round and an explicit
   * `qcr drain off`. Only an OPERATOR drain with no expiry and no system
   * reason is carried (a NULL issuer predates issuers and reads as the
   * operator's); a session's bounded drain is not. Like
   * `migrateRecheckReceipts`, the carry commits with the column.
   */
  private migrateDrainHold(): void {
    this.db.transaction(() => {
      if (!this.addColumn("ALTER TABLE drain_state ADD COLUMN hold INTEGER NOT NULL DEFAULT 0"))
        return;
      const info = this.db
        .prepare(
          `UPDATE drain_state SET hold = 1
            WHERE id = 1 AND draining = 1 AND COALESCE(issued_by, 'operator') = 'operator'
              AND expires_at IS NULL AND reason IS NULL`,
        )
        .run();
      if (info.changes > 0) this.logEvent("drain_hold_carried", null, {});
    })();
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
           status, owner_token, attempt, recovery_attempts, unknown_checks, redeliveries,
           created_at, updated_at, next_check_at, started_at, settled_at, failed_at, failure,
           est_usd, lens_usd, usage_final)
        SELECT id, pr, session, kind, round_no, payload_sha256, payload_path, inject_path,
           status, owner_token, attempt, recovery_attempts, unknown_checks, redeliveries,
           created_at, updated_at, next_check_at, started_at, settled_at, failed_at, failure,
           est_usd, lens_usd, usage_final
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
   * 2. Zombie expiry: rounds stuck `overdue` from before 2026-08-15 whose PR
   *    has since verdicted (a round of the same or higher number delivered a
   *    verdict) or closed move to terminal `expired`, so they stop polluting
   *    aggregates. Rounds a rerun could still service (open PR, nothing
   *    decided since) are left alone — rerunning a stuck round is the
   *    self-requeue's job, never this one's.
   * 3. Cancel-cause backfill: older cancellations recorded their reason only
   *    as prose in `summary`. The prose is stable (each cancelling call site writes one fixed
   *    phrasing), so it classifies exactly once here into `cancel_cause`.
   *    Anything that does not match stays `unknown` — never guessed benign.
   */
  private runDataMigrations(): void {
    this.db
      .prepare(
        "UPDATE rounds SET est_usd = spend_usd WHERE est_usd IS NULL AND spend_usd IS NOT NULL",
      )
      .run();
    const info = this.db
      .prepare(
        `UPDATE rounds SET status = 'expired', finished_at = COALESCE(finished_at, @now)
          WHERE status = 'overdue'
            AND started_at < '2026-08-15'
            AND ${OVERDUE_ROUND_BURIABLE_SQL}`,
      )
      .run({ now: this.ts() });
    if (info.changes > 0)
      this.logEvent("rounds_expired", null, { count: info.changes, one_shot: true });
    this.classifyLegacyCancellations();
    this.classifyLegacyFeedbackMemory();
    this.fillLensIds();
  }

  /**
   * Canonical lens ids for every recorded finding that has none
   * yet — the rows recorded before the column existed. Parsed from the raw
   * `lens` by the one parser the recorder uses, so the two never disagree.
   * Idempotent: only NULL rows are touched, and a parsed row is never NULL
   * again (`[]` is an answer).
   */
  private fillLensIds(): void {
    const rows = this.db
      .prepare("SELECT id, lens FROM round_findings WHERE lens_ids IS NULL")
      .all() as Array<{ id: number; lens: string }>;
    if (rows.length === 0) return;
    const set = this.db.prepare("UPDATE round_findings SET lens_ids = ? WHERE id = ?");
    this.db.transaction(() => {
      for (const r of rows) set.run(JSON.stringify(canonicalLensIds(r.lens)), r.id);
    })();
  }

  /**
   * Backfill classification: a feedback row from before the memory columns
   * has no memory state. Its write was attempted once, at ingest, and a
   * failure left exactly one trace — a `feedback_memory_write_failed` event
   * for that PR and kind, logged right after the row. Each such event marks
   * the row it followed (same PR and kind, the newest created at or before the
   * event that no earlier event already claimed) `pending`, with the event's
   * error, so the pump writes it. One row per event, never two events
   * on one row: two [feedback] comments from one review submission are
   * interpreted concurrently, so both rows can precede both failure events,
   * and the old payload names no signal — matching each event to a DISTINCT
   * row is what keeps the count of owed rows equal to the count of failures.
   * (Which of two such rows failed cannot be told apart; marking the wrong
   * one owed is caught by the pump, which finds an entry that landed before
   * writing it.) The owed rows are owed since the migration.
   * Every other legacy row is `written`: its entry exists under a name
   * nobody recorded (`memory_uri` stays NULL). Idempotent: only NULL states
   * are touched, and the run is recorded as `feedback_memory_ledger_migrated`
   * with its instant — the pump's cut-off for checking whether a legacy
   * row's entry landed after all (a write that timed out may have).
   */
  private classifyLegacyFeedbackMemory(): void {
    const rows = this.db
      .prepare(
        "SELECT id, kind, pr, created_at FROM feedback_signals WHERE memory_state IS NULL ORDER BY id",
      )
      .all() as Array<{ id: number; kind: string; pr: number; created_at: string }>;
    if (rows.length === 0) return;
    const failures = this.db
      .prepare(
        "SELECT ts, pr, payload FROM events WHERE kind = 'feedback_memory_write_failed' ORDER BY id",
      )
      .all() as Array<{ ts: string; pr: number | null; payload: string | null }>;
    const owed = new Map<number, string>();
    for (const ev of failures) {
      let kind = "";
      let error = "";
      try {
        const p = JSON.parse(ev.payload ?? "{}") as {
          kind?: unknown;
          error?: unknown;
          signal?: unknown;
        };
        // A newer failure names its signal, whose row already has a state.
        if (typeof p.signal === "number") continue;
        kind = typeof p.kind === "string" ? p.kind : "";
        error = typeof p.error === "string" ? p.error : "";
      } catch {
        continue;
      }
      let match: { id: number; created_at: string } | null = null;
      for (const r of rows) {
        if (r.pr !== ev.pr || r.kind !== kind || r.created_at > ev.ts || owed.has(r.id)) continue;
        if (!match || r.created_at >= match.created_at) match = r;
      }
      if (match) owed.set(match.id, error || "write failed before memory writes were tracked");
    }
    const at = this.ts();
    const markPending = this.db.prepare(
      `UPDATE feedback_signals SET memory_state = 'pending', memory_attempts = 1,
         memory_last_error = ?, memory_owed_since = ? WHERE id = ? AND memory_state IS NULL`,
    );
    const markWritten = this.db.prepare(
      "UPDATE feedback_signals SET memory_state = 'written' WHERE id = ? AND memory_state IS NULL",
    );
    this.db.transaction(() => {
      for (const r of rows) {
        const error = owed.get(r.id);
        if (error !== undefined) markPending.run(error, at, r.id);
        else markWritten.run(r.id);
      }
    })();
    this.logEvent("feedback_memory_ledger_migrated", null, {
      at,
      pending: owed.size,
      written: rows.length - owed.size,
    });
  }

  /** Backfill: read the historical cancellation prose into
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

  /** The store's injected clock, exposed for daemon-level deterministic
   * sweeps so retry due checks and their SQLite writes share one instant. */
  currentTimeIso(): string {
    return this.ts();
  }

  // ---- pr_state ----------------------------------------------------------

  getPr(n: number): PrStateRow | undefined {
    const row = this.db.prepare("SELECT * FROM pr_state WHERE number = ?").get(n) as
      PrStateRow | undefined;
    return row && this.withLivePause(row);
  }

  allPrs(): PrStateRow[] {
    return (this.db.prepare("SELECT * FROM pr_state ORDER BY number").all() as PrStateRow[]).map(
      (r) => this.withLivePause(r),
    );
  }

  /**
   * The one reading of a PR's pause: `paused` is 1 only while the
   * hold is in force. A lapsed session pause therefore stops binding at its
   * expiry whether or not the sweep has run yet, at every reader — dispatch,
   * reconcile, the successor promotion and the snapshot all come through
   * here. A pause with no issuer recorded is the operator's: it predates any
   * session bound and never lapses on its own.
   */
  private withLivePause(row: PrStateRow): PrStateRow {
    if (!row.paused) return row;
    const hold = this.pauseHold(row);
    return holdActive(hold, this.ts())
      ? { ...row, pause_issuer: hold.issuer }
      : { ...row, paused: 0 };
  }

  private pauseHold(row: PrStateRow): LeverHold | null {
    return storedHold(Boolean(row.paused), row.pause_issuer, row.pause_expires_at);
  }

  /**
   * Hold `n` out of dispatch and re-trigger under `grant`. The
   * precedence is `mergeHold`'s: a session cannot narrow or replace an
   * operator's pause, an operator's grant replaces a session's, and a repeat
   * from the same issuer only ever widens. Returns the hold that now stands.
   */
  pausePr(n: number, grant: LeverGrant, reason: string): { outcome: HoldOutcome; hold: LeverHold } {
    const row = this.getPr(n);
    if (!row) throw new Error(`pausePr: unknown PR #${n}`);
    const merged = mergeHold(this.pauseHold(row), grant);
    if (merged.outcome === "unchanged") return merged;
    const ts = this.ts();
    // `since` carries over only while a hold is still IN FORCE — decided from
    // the folded row, like every other reader: a grant landing on a lapsed
    // pause the sweep has not retired yet is a new hold and gets a new since.
    const since = (row.paused ? row.pause_since : null) ?? ts;
    this.db
      .prepare(
        `UPDATE pr_state SET paused = 1, pause_issuer = ?, pause_expires_at = ?, pause_reason = ?, pause_since = ?, updated_at = ?
          WHERE number = ?`,
      )
      .run(merged.hold.issuer, merged.hold.expires_at, reason, since, ts, n);
    return merged;
  }

  /** Lift a pause. A session's resume is REFUSED while the operator holds it. */
  resumePr(n: number, by: LeverIssuer): { changed: boolean; refused?: "held-by-operator" } {
    const row = this.getPr(n);
    const hold = row ? this.pauseHold(row) : null;
    if (!hold) return { changed: false };
    if (!mayLift(hold, by)) return { changed: false, refused: "held-by-operator" };
    this.db
      .prepare(
        "UPDATE pr_state SET paused = 0, pause_issuer = NULL, pause_expires_at = NULL, pause_reason = NULL, pause_since = NULL, updated_at = ? WHERE number = ?",
      )
      .run(this.ts(), n);
    return { changed: true };
  }

  /** `paused` is deliberately not part of the upsert: it is owned by
   * `pausePr`/`resumePr` (and the expiry sweep) so state transitions can never
   * clobber a standing pause.
   * `trigger_provenance` is optional — absent means null, i.e. the
   * full-round default. */
  upsertPr(
    row: Omit<
      PrStateRow,
      | "updated_at"
      | "paused"
      | "pause_issuer"
      | "pause_expires_at"
      | "pause_reason"
      | "pause_since"
      | "trigger_provenance"
    > & {
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

  setPrState(n: number, state: PrLifecycleState): void {
    this.db
      .prepare("UPDATE pr_state SET state = ?, updated_at = ? WHERE number = ?")
      .run(state, this.ts(), n);
  }

  /** Publish an operator rerun without writing a pre-fence PR snapshot back
   * over newer reconcile/webhook state. A close that wins the fence is final. */
  queuePrForOperatorRecovery(n: number, triggerTs: string): boolean {
    return (
      this.db
        .prepare(
          `UPDATE pr_state SET state='queued', trigger_ts=?, updated_at=?
        WHERE number=? AND state!='closed'`,
        )
        .run(triggerTs, this.ts(), n).changes === 1
    );
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
    const nextNo = this.nextRoundNo(pr);
    const {
      additions,
      deletions,
      changed_files,
      trigger_ts,
      validate_tier,
      pass_plan,
      addable_passes,
      ...followUp
    } = meta;
    const info = this.db
      .prepare(
        `INSERT INTO rounds (pr, round_no, round_type, lenses, started_at, deadline_at, status,
                             additions, deletions, changed_files, trigger_ts, validate_tier, pass_plan, addable_passes,
                             preflight_posting_state)
         VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, 'none')`,
      )
      .run(
        pr,
        nextNo,
        roundType,
        lenses.join(","),
        started.toISOString(),
        deadline.toISOString(),
        additions ?? null,
        deletions ?? null,
        changed_files ?? null,
        trigger_ts ?? null,
        validate_tier ?? null,
        pass_plan ? JSON.stringify(pass_plan) : null,
        addable_passes ? JSON.stringify(addable_passes) : null,
      );
    const id = Number(info.lastInsertRowid);
    // The follow-up columns ride the same meta, written only when
    // given, so a round started without them keeps them NULL.
    this.setRoundMeta(id, followUp);
    return id;
  }

  /** The number the PR's next round takes: one past its highest. */
  private nextRoundNo(pr: number): number {
    return (
      ((
        this.db.prepare("SELECT MAX(round_no) AS m FROM rounds WHERE pr = ?").get(pr) as {
          m: number | null;
        }
      ).m ?? 0) + 1
    );
  }

  /** Diffstat/trigger stamp for a round that already exists (late arrival). */
  setRoundMeta(id: number, meta: RoundStartMeta): void {
    const sets: string[] = [];
    const args: Array<number | string | null> = [];
    for (const key of [
      "additions",
      "deletions",
      "changed_files",
      "trigger_ts",
      "validate_tier",
      "head_sha",
      "merge_base",
      "scope",
      "delta_base_sha",
      "delta_lines",
      "delta_files",
      "sweep_status",
    ] as const) {
      if (meta[key] !== undefined) {
        sets.push(`${key} = ?`);
        args.push(meta[key]);
      }
    }
    for (const key of ["pass_plan", "addable_passes"] as const) {
      if (meta[key] !== undefined) {
        sets.push(`${key} = ?`);
        args.push(JSON.stringify(meta[key]));
      }
    }
    if (meta.sweep_owed !== undefined) {
      sets.push("sweep_owed = ?");
      args.push(meta.sweep_owed === null ? null : meta.sweep_owed ? 1 : 0);
    }
    if (meta.sweep_plan !== undefined) {
      sets.push("sweep_plan = ?");
      args.push(meta.sweep_plan === null ? null : JSON.stringify(meta.sweep_plan));
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE rounds SET ${sets.join(", ")} WHERE id = ?`).run(...args, id);
  }

  /** Re-stamp a running round's plan with the one actually dispatched: the
   * repo's written style guide is found only after the worktree is prepared,
   * and it can add pass-style, so the plan startRound recorded can
   * be short of the order's. */
  setRoundPlan(
    id: number,
    lenses: string[],
    meta: Pick<RoundStartMeta, "validate_tier" | "pass_plan" | "addable_passes">,
  ): void {
    this.db.prepare("UPDATE rounds SET lenses = ? WHERE id = ?").run(lenses.join(","), id);
    this.setRoundMeta(id, meta);
  }

  stampPostingKey(id: number, postingKey: string): void {
    this.db
      .prepare("UPDATE rounds SET posting_key=? WHERE id=? AND posting_key IS NULL")
      .run(postingKey, id);
  }

  /** Persist successful stage progress once, both for diagnostics and to reset
   * the per-head fast-retry generation after a later unrelated round. The stamp
   * and its `round_fanout_started` event commit together: a stamp alone would
   * make every later call a no-op, so the budget reset could never be written. */
  recordRoundFanoutStarted(id: number, commandId: string, startedAt: string): boolean {
    return this.db
      .transaction(() => this.recordRoundFanoutStartedTx(id, commandId, startedAt))
      .immediate();
  }

  private recordRoundFanoutStartedTx(id: number, commandId: string, startedAt: string): boolean {
    const row = this.db
      .prepare(
        `SELECT r.pr, r.round_no, r.posting_key, c.id AS command_id
         FROM rounds r JOIN session_commands c ON c.pr=r.pr AND c.kind='round' AND c.round_no=r.round_no
        WHERE r.id=? AND r.status='running' AND c.id=?`,
      )
      .get(id, commandId) as
      { pr: number; round_no: number; posting_key: string | null; command_id: string } | undefined;
    if (!row) return false;
    const changed =
      this.db
        .prepare(
          "UPDATE rounds SET fanout_started_at=? WHERE id=? AND status='running' AND fanout_started_at IS NULL",
        )
        .run(startedAt, id).changes === 1;
    if (changed) {
      const head = row.posting_key
        ? postingKeyHead(row.posting_key, row.pr, row.round_no)
        : undefined;
      this.logEvent("round_fanout_started", row.pr, {
        round_id: id,
        round_no: row.round_no,
        command_id: row.command_id,
        ...(head ? { head_sha: head } : {}),
        started_at: startedAt,
      });
    }
    return changed;
  }

  /** Bracket the only GitHub mutation that can precede command delivery. */
  recordRoundPreflightPosting(
    id: number,
    state: "ambiguous" | "executed" | "dryrun" | "refused",
  ): void {
    this.db
      .prepare(`UPDATE rounds SET preflight_posting_state=? WHERE id=? AND status='running'`)
      .run(state, id);
  }

  confirmRoundPosting(
    id: number,
    receipt: {
      posting_key: string;
      actual_event: string;
      gh_review_id: number | null;
      gh_commit_id: string;
      confirmed_at: string;
    },
  ): boolean {
    return (
      this.db
        .prepare(
          `UPDATE rounds
          SET gh_review_id=COALESCE(gh_review_id, @gh_review_id),
              gh_commit_id=COALESCE(gh_commit_id, @gh_commit_id),
              posted_event=COALESCE(posted_event, @actual_event),
              posted_at=COALESCE(posted_at, @confirmed_at)
        WHERE id=@id AND posting_key=@posting_key
          AND (gh_review_id IS NULL OR @gh_review_id IS NULL OR gh_review_id=@gh_review_id)
          AND (gh_commit_id IS NULL OR gh_commit_id=@gh_commit_id)
          AND (posted_event IS NULL OR posted_event=@actual_event)`,
        )
        .run({ id, ...receipt }).changes === 1
    );
  }

  /** Rounds that actually DELIVERED a verdict for a PR — backfilled history
   * and dead rounds (cancelled/orphaned/overdue: verdict NULL) excluded.
   * Dispatch's first-review-vs-re-review choice and the nit-cap "review age"
   * key on this: a failed round must not age the PR.
   *
   * **Read the name carefully.** This is not "how many rounds has this PR
   * had"; it is "how many rounds DELIVERED a verdict". A PR whose first round
   * is cancelled therefore produces a SECOND round still typed `"first"`, and
   * the `first` / `re-review` split in `round_type` really means *has this PR
   * ever been successfully reviewed*. That is intended (a failed round must
   * not age the PR, nor switch the nit cap on for a review the author never
   * saw) — but any
   * measurement that reads `round_type` as "round ordinal" is reading it
   * wrong, and `rounds.round_no` is the ordinal it wants. Pinned by
   * tests/state.test.ts. */
  priorRoundCount(pr: number): number {
    return (
      this.db
        .prepare(
          "SELECT COUNT(*) AS c FROM rounds WHERE pr = ? AND backfilled = 0 AND verdict IS NOT NULL",
        )
        .get(pr) as { c: number }
    ).c;
  }

  /**
   * Has this PR had a FULL LOOK since its first round? A delivered
   * (verdicted, never backfilled) non-first round that reviewed the whole PR:
   * a full-scope round, a legacy re-review (scope NULL — every re-review
   * before follow-up rounds was a full one), or a follow-up round whose
   * pre-approval sweep ran. The pre-approval sweep is owed only while this is
   * false. A staleness round (a post-approval delta look, whatever scope
   * it was stamped with) is NOT one: when in doubt the sweep is owed, never
   * skipped.
   */
  fullLookSinceFirst(pr: number): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM rounds
            WHERE pr = ? AND backfilled = 0 AND verdict IS NOT NULL AND round_type != 'first'
              AND ((round_type = 're-review' AND (scope IS NULL OR scope = 'full'))
                   OR sweep_status = 'ran')
            LIMIT 1`,
        )
        .get(pr) !== undefined
    );
  }

  roundsFor(pr: number): RoundRow[] {
    return this.db
      .prepare("SELECT * FROM rounds WHERE pr = ? ORDER BY round_no")
      .all(pr) as RoundRow[];
  }

  allRounds(): RoundRow[] {
    return this.db.prepare("SELECT * FROM rounds ORDER BY started_at, id").all() as RoundRow[];
  }

  /** `estUsd` is a caller-supplied initial estimate; it lands in `est_usd` (the
   * one spend field) only when no measured figure exists yet —
   * recordRoundUsage's measurement always supersedes it. The retired
   * `spend_usd` column is never written.
   *
   * `expectedStatus` makes it a claim: the row is
   * finished only while its status is still the one the caller read before
   * it awaited anything, and the return says whether it was. Without it the
   * write is unconditional. */
  finishRound(
    id: number,
    verdict: string,
    estUsd: number | null,
    summary: string | null = null,
    expectedStatus?: string,
  ): boolean {
    const row = this.db
      .prepare("SELECT started_at, finished_at, duration_s, status FROM rounds WHERE id = ?")
      .get(id) as
      Pick<RoundRow, "started_at" | "finished_at" | "duration_s" | "status"> | undefined;
    const finishedAt =
      row?.status === "done" && row.finished_at !== null ? row.finished_at : this.ts();
    const duration =
      row?.status === "done" && row.duration_s !== null
        ? row.duration_s
        : row
          ? (Date.parse(finishedAt) - Date.parse(row.started_at)) / 1000
          : null;
    const set =
      "UPDATE rounds SET verdict = ?, est_usd = COALESCE(est_usd, ?), duration_s = ?, finished_at = ?, summary = ?, status = 'done' WHERE id = ?";
    const result =
      expectedStatus === undefined
        ? this.db.prepare(set).run(verdict, estUsd, duration, finishedAt, summary, id)
        : this.db
            .prepare(`${set} AND status = ?`)
            .run(verdict, estUsd, duration, finishedAt, summary, id, expectedStatus);
    return result.changes > 0;
  }

  /** A round end fixed its usage window and owes the measurement.
   * Synchronous, so it lands in the same turn as the
   * round end's terminal write. */
  oweRoundMeasurement(id: number, measuredTo: string): void {
    this.db.prepare("UPDATE rounds SET usage_owed_to = ? WHERE id = ?").run(measuredTo, id);
  }

  /** The owed measurement has finished — usage recorded, or recorded
   * unknown — and is owed no more. */
  settleRoundMeasurement(id: number): void {
    this.db.prepare("UPDATE rounds SET usage_owed_to = NULL WHERE id = ?").run(id);
  }

  /** Every round whose round-end measurement is still owed, oldest first. */
  owedRoundMeasurements(): RoundRow[] {
    return this.db
      .prepare("SELECT * FROM rounds WHERE usage_owed_to IS NOT NULL ORDER BY id")
      .all() as RoundRow[];
  }

  /** A worker's spend report for its command. Overwrites: the figures only
   * grow within a worker, so the latest is the fullest. A closed report is never
   * reopened by a late partial.
   *
   * The closing report is the last thing a worker sends, so the round's usage
   * measurement (fired when the verdict is applied) usually ran first and fell back
   * to the transcripts. Closing the report therefore re-states `rounds.est_usd` of an
   * already-measured round from the workers' figures; the tokens stay the
   * transcripts'. A round not yet measured needs nothing: its measurement reads the
   * report. */
  recordCommandUsage(
    commandId: string,
    usage: { est_usd: number; lens_usd: number | null; final: boolean },
  ): boolean {
    // One transaction: the closed report and the round's re-stated cost land
    // together, or a replay (which sees `usage_final = 1`) could never finish it.
    return this.db
      .transaction((): boolean => {
        const changed =
          this.db
            .prepare(
              `UPDATE session_commands
              SET est_usd = ?, lens_usd = ?, usage_final = ?, updated_at = ?
            WHERE id = ? AND usage_final = 0`,
            )
            .run(usage.est_usd, usage.lens_usd, usage.final ? 1 : 0, this.ts(), commandId).changes >
          0;
        if (changed && usage.final) this.restateMeasuredRoundUsd(commandId);
        return changed;
      })
      .immediate();
  }

  /** Re-state the est_usd of the (already measured) round a command belongs to from
   * the workers' reports, when they now cover it. Tokens are left alone. */
  private restateMeasuredRoundUsd(commandId: string): void {
    const rounds = this.db
      .prepare(
        `SELECT r.id FROM rounds r JOIN session_commands c ON c.pr = r.pr AND c.round_no = r.round_no
          WHERE c.id = ? AND c.kind = 'round' AND r.tokens_in IS NOT NULL`,
      )
      .all(commandId) as { id: number }[];
    for (const { id } of rounds) {
      const reported = this.workerReportedUsd(id);
      if (reported !== null)
        this.db.prepare("UPDATE rounds SET est_usd = ? WHERE id = ?").run(reported, id);
    }
  }

  /** What the workers of a round reported it cost, or null when the transcripts
   * must measure it instead: no command of the round reported, or one that was
   * claimed has no closed, single-worker report. A crashed worker's figure is a
   * partial, and a requeued, recovered or redelivered command's last worker did
   * not see the spend of the one before it. Rows never claimed cost nothing. */
  workerReportedUsd(roundId: number): number | null {
    const rows = this.db
      .prepare(
        `SELECT c.est_usd, c.usage_final, c.attempt, c.recovery_attempts, c.redeliveries
           FROM session_commands c JOIN rounds r ON r.pr = c.pr AND r.round_no = c.round_no
          WHERE r.id = ? AND c.kind = 'round'`,
      )
      .all(roundId) as Pick<
      SessionCommandRow,
      "est_usd" | "usage_final" | "attempt" | "recovery_attempts" | "redeliveries"
    >[];
    let total: number | null = null;
    for (const r of rows) {
      if (r.attempt === 0) continue;
      const single = r.attempt === 1 && r.recovery_attempts === 0 && r.redeliveries === 0;
      if (!single || r.usage_final !== 1 || r.est_usd === null) return null;
      total = (total ?? 0) + r.est_usd;
    }
    return total;
  }

  /** Measured usage for a round (pi session JSONLs). Overwrites —
   * a re-measured round keeps only the latest figures. */
  recordRoundUsage(
    id: number,
    usage: {
      tokens_in: number;
      tokens_out: number;
      tokens_cache_read?: number | null;
      est_usd: number | null;
    },
  ): void {
    this.db
      .prepare(
        "UPDATE rounds SET tokens_in = ?, tokens_out = ?, tokens_cache_read = ?, est_usd = ? WHERE id = ?",
      )
      .run(usage.tokens_in, usage.tokens_out, usage.tokens_cache_read ?? null, usage.est_usd, id);
  }

  /**
   * Executed-pass telemetry for a round — what the session reported
   * it ACTUALLY ran, stored beside (never instead of) the planned `lenses`.
   * Overwrites: a re-delivered verdict keeps only the latest report.
   */
  recordExecutedPasses(id: number, passes: readonly VerdictPassEntry[]): void {
    this.db
      .prepare("UPDATE rounds SET executed_passes = ? WHERE id = ?")
      .run(JSON.stringify(passes), id);
  }

  /** Parsed executed-pass telemetry; null = unknown (`parseExecutedPasses`). */
  executedPasses(id: number): VerdictPassEntry[] | null {
    const row = this.db.prepare("SELECT executed_passes FROM rounds WHERE id = ?").get(id) as
      { executed_passes: string | null } | undefined;
    return parseExecutedPasses(row?.executed_passes);
  }

  // ---- the durable reasoning record ---------------------------------------

  /** The per-round comment count: how many inline comments the round posted,
   * as the session reported it. Idempotent overwrite. */
  recordRoundComments(id: number, count: number): void {
    this.db
      .prepare("UPDATE rounds SET comments_posted = ? WHERE id = ?")
      .run(Math.max(0, Math.trunc(count)), id);
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
          posted_as, raised_in_round, thread_id, recorded_at, title, lens_ids)
       VALUES
         (@pr, @round_id, @round_no, @head_sha, @finding_key, @path, @line, @lens, @tier, @unplanned,
          @severity, @confidence, @reachability, @kind, @disposition, @axis, @word, @reason, @evidence,
          @posted_as, @raised_in_round, @thread_id, @recorded_at, @title, @lens_ids)
       ON CONFLICT(pr, round_no, finding_key) DO UPDATE SET
         round_id=@round_id, head_sha=@head_sha, path=@path, line=@line, lens=@lens, tier=@tier,
         unplanned=@unplanned, severity=@severity, confidence=@confidence, reachability=@reachability,
         kind=@kind, disposition=@disposition, axis=@axis, word=@word, reason=@reason,
         evidence=@evidence, posted_as=@posted_as, raised_in_round=@raised_in_round,
         thread_id=@thread_id, recorded_at=@recorded_at, title=@title, lens_ids=@lens_ids`,
    );
    const write = this.db.transaction((rows: readonly RoundFindingInput[]) => {
      for (const f of rows) {
        const lensIds = canonicalLensIds(f.lens);
        stmt.run({
          pr: round.pr,
          round_id: round.round_id,
          round_no: round.round_no,
          head_sha: round.head_sha ?? "",
          ...findingRowFields(f),
          // Unknown-lens entries are never called "unplanned": that would
          // assert a fact about a lens the record does not name. A spelling
          // that names known lenses (`pass-baseline + pass-sweep`,
          // `pass-sweep:G1`) is judged by those lenses; any other is judged
          // as written.
          unplanned:
            f.lens &&
            plan.size > 0 &&
            (lensIds.length > 0 ? lensIds.some((id) => !plan.has(id)) : !plan.has(f.lens))
              ? 1
              : 0,
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

  /** The findings the validator doubted on a PR, oldest round
   * first — kept as "may not be valid", never posted, read by the TUI. */
  doubtedFindings(pr: number): RoundFindingRow[] {
    return this.db
      .prepare(
        "SELECT * FROM round_findings WHERE pr = ? AND disposition = 'doubted' ORDER BY round_no, id",
      )
      .all(pr) as RoundFindingRow[];
  }

  /** The survivors a profile's `[posting]` policy kept off the PR
   * (disposition `withheld` with a posting-policy word), oldest round first:
   * kept, never posted, read by the TUI beside the doubted ones. */
  withheldFindings(pr: number): RoundFindingRow[] {
    return this.db
      .prepare(
        `SELECT * FROM round_findings WHERE pr = ? AND disposition = 'withheld'
          AND word IN (${WITHHOLD_WORDS.map(() => "?").join(", ")}) ORDER BY round_no, id`,
      )
      .all(pr, ...WITHHOLD_WORDS) as RoundFindingRow[];
  }

  /**
   * The refuted-and-conceded set for a PR: findings a previous round posted,
   * the author refuted, and the reviewer accepted the refutation on. This is
   * what lets a later round tell "escalating an OPEN finding" — legitimate,
   * and deliberately so: blocking late beats never — from "resurrecting a
   * SETTLED one", which is not.
   */
  concededFindings(pr: number): RoundFindingRow[] {
    return this.db
      .prepare(
        "SELECT * FROM round_findings WHERE pr = ? AND disposition = 'conceded' ORDER BY round_no, id",
      )
      .all(pr) as RoundFindingRow[];
  }

  // ---- prior-finding checks -----------------------------------------------

  /** Record the prior findings a follow-up round was HANDED: one row per
   * listed finding. Idempotent — a re-listing refreshes the head, blocking
   * flag and listing time and keeps any status already reported. */
  recordPriorListing(
    pr: number,
    checkedRound: number,
    headSha: string,
    items: ReadonlyArray<{ round_no: number; finding_key: string; blocking: boolean }>,
  ): void {
    const at = this.ts();
    const stmt = this.db.prepare(
      `INSERT INTO prior_finding_checks
         (pr, checked_round, head_sha, round_no, finding_key, blocking, listed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(pr, checked_round, round_no, finding_key) DO UPDATE SET
         head_sha = excluded.head_sha, blocking = excluded.blocking, listed_at = excluded.listed_at`,
    );
    this.db.transaction(() => {
      for (const i of items)
        stmt.run(pr, checkedRound, headSha, i.round_no, i.finding_key, i.blocking ? 1 : 0, at);
    })();
  }

  /** Store the statuses a round's findings record REPORTED for prior
   * findings. A listed row gets its status; a reported ref that was never
   * listed is inserted (listed_at NULL, blocking 0) rather than dropped.
   * Idempotent: a re-recorded record overwrites its own reports. Returns
   * how many reports were stored. */
  recordPriorReports(
    pr: number,
    checkedRound: number,
    headSha: string,
    reports: ReadonlyArray<{
      round_no: number;
      finding_key: string;
      status: string;
      evidence: string | null;
    }>,
  ): number {
    const at = this.ts();
    const stmt = this.db.prepare(
      `INSERT INTO prior_finding_checks
         (pr, checked_round, head_sha, round_no, finding_key, blocking, status, evidence, reported_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
       ON CONFLICT(pr, checked_round, round_no, finding_key) DO UPDATE SET
         status = excluded.status, evidence = excluded.evidence, reported_at = excluded.reported_at`,
    );
    this.db.transaction(() => {
      for (const r of reports)
        stmt.run(pr, checkedRound, headSha, r.round_no, r.finding_key, r.status, r.evidence, at);
    })();
    return reports.length;
  }

  /** Every prior-finding check row for a PR, oldest checking round first. */
  priorFindingChecks(pr: number): PriorFindingCheckRow[] {
    return this.db
      .prepare(
        "SELECT * FROM prior_finding_checks WHERE pr = ? ORDER BY checked_round, round_no, finding_key",
      )
      .all(pr) as PriorFindingCheckRow[];
  }

  /**
   * The once-per-round findings-record re-nudge mark — events-table backed,
   * so no new DDL and boot-safe on the live DB by construction. Scanned with
   * no recency window; the cap is per round, not per recent history.
   */
  recordFindingsNudge(pr: number, key: string, extra?: Record<string, unknown>): void {
    this.logEvent("findings_record_nudged", pr, { key, ...(extra ?? {}) });
  }

  /** Was the findings-record re-nudge for this (pr, key) already sent? */
  findingsNudgeSent(pr: number, key: string): boolean {
    const rows = this.db
      .prepare("SELECT payload FROM events WHERE kind = 'findings_record_nudged' AND pr = ?")
      .all(pr) as Array<{ payload: string | null }>;
    return someMarkHasKey(rows, key);
  }

  /** A dispatch attempt creates its round row before handing the order to the
   * session hook. If that handoff fails, remove the provisional row so it
   * cannot consume capacity or inflate the round number on retry. */
  discardRunningRound(id: number): void {
    this.db.prepare("DELETE FROM rounds WHERE id = ? AND status = 'running'").run(id);
  }

  markRoundOverdue(id: number): void {
    // Stamp `finished_at`. An overdue round is terminal — nothing reruns it,
    // `expireOverdueRounds` only reaches it once the PR has closed or
    // verdicted on a later round, and a PR whose ONLY round blew its deadline
    // satisfies neither. A NULL `finished_at` would leave a row whose
    // "duration" grows forever. The status is deliberately NOT
    // changed to `expired` here — that would drop the round from spend and
    // every other aggregate, hiding tokens this round really burned.
    this.db
      .prepare(
        "UPDATE rounds SET status = 'overdue', finished_at = COALESCE(finished_at, ?) WHERE id = ?",
      )
      .run(this.ts(), id);
  }

  /** Administrative close of a round that will never produce a verdict —
   * superseded by a newer round, or orphaned when its tmux session died.
   * Unlike overdue it carries no anomaly semantics and touches no PR state.
   *
   * `cause` is the machine-readable half of `reason`: cancellation
   * is grouped by it everywhere it is surfaced, and a caller that omits it
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
   * Cancellations grouped by cause. `since` is an inclusive ISO lower bound on
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
      .sort(cancellationOrder);
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

  /** Stamp the first sweep that saw this round fully
   * silent. Idempotent — the first observation wins, so two sweeps' spacing
   * is real elapsed time, never a same-tick double-write. */
  markRoundSilent(id: number): void {
    this.db
      .prepare(
        "UPDATE rounds SET silent_since = ? WHERE id = ? AND silent_since IS NULL AND status = 'running'",
      )
      .run(this.ts(), id);
  }

  /** Clear the first-seen-silent mark: the round showed a sign of life (or an
   * ambiguous signal) — silence must be observed on consecutive sweeps. */
  clearRoundSilent(id: number): void {
    this.db.prepare("UPDATE rounds SET silent_since = NULL WHERE id = ?").run(id);
  }

  /**
   * Cancel every running round on a PR and return their ids.
   *
   * The operator's two unwedge levers — `rerun-round` and `restart-session` —
   * both set the PR back to `queued` and pump, but the pump skips a PR whose
   * round is still `running` ("one PR = one worktree = at most one round"), so
   * without this a phantom round would keep the PR queued forever.
   *
   * Cancelling never touches GitHub and never posts:
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
      this.logEvent("round_cancelled_by_operator", pr, {
        round_id: r.id,
        round_no: r.round_no,
        reason,
      });
    }
    return rows.map((r) => r.id);
  }

  /** Push a running round's deadline out from NOW. Used only when the
   * round has not started — its prompt never reached the session — so none of
   * the elapsed time was review time and the full window is owed again. */
  extendRoundDeadline(id: number, minutes: number): void {
    const deadline = new Date(this.now().getTime() + minutes * 60_000).toISOString();
    this.db
      .prepare("UPDATE rounds SET deadline_at = ? WHERE id = ? AND status = 'running'")
      .run(deadline, id);
  }

  /** Record the receipt token stamped into this round's wake file.
   * Written at dispatch, read by the prompt-receipt check. A round with a NULL
   * marker was dispatched by a build that stamped none — its delivery cannot
   * be verified, and readers must say "unknown" rather than "not delivered". */
  stampPromptMarker(id: number, marker: string): void {
    this.db.prepare("UPDATE rounds SET prompt_marker = ? WHERE id = ?").run(marker, id);
  }

  /** Count one re-delivery of a round's prompt and return the new total.
   * Redelivery is the cheap recovery — rewrite the wake file, same
   * round, same session, same conversation — so it is bounded separately from
   * `max_self_requeues`, which is the expensive one (a fresh round, and for a
   * live-but-wedged session a kill). */
  countRedelivery(id: number): number {
    this.db.prepare("UPDATE rounds SET redeliveries = redeliveries + 1 WHERE id = ?").run(id);
    const row = this.db.prepare("SELECT redeliveries FROM rounds WHERE id = ?").get(id) as
      { redeliveries: number } | undefined;
    return row?.redeliveries ?? 0;
  }

  /** PRs holding wakes with no round running. `flushHeldWakes` is
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

  /** The status of this PR's round `roundNo` (the newest row carrying that
   * number), or undefined when there is no such row. */
  roundStatus(pr: number, roundNo: number): string | undefined {
    const row = this.db
      .prepare("SELECT status FROM rounds WHERE pr = ? AND round_no = ? ORDER BY id DESC LIMIT 1")
      .get(pr, roundNo) as { status: string } | undefined;
    return row?.status;
  }

  runningRounds(): RoundRow[] {
    return this.db
      .prepare("SELECT * FROM rounds WHERE status = 'running' ORDER BY started_at")
      .all() as RoundRow[];
  }

  /** True while this PR has a round in flight — the single-shepherd test
   * before any wake. */
  hasRunningRound(pr: number): boolean {
    const row = this.db
      .prepare("SELECT COUNT(*) AS c FROM rounds WHERE pr = ? AND status = 'running'")
      .get(pr) as { c: number };
    return row.c > 0;
  }

  // ---- durable PR-session command slot ------------------------------------

  createSessionCommand(input: CreateSessionCommand): SessionCommandRow {
    const ts = this.ts();
    this.db
      .prepare(
        `INSERT INTO session_commands
         (id, pr, session, kind, round_no, payload_sha256, payload_path, inject_path,
          status, owner_token, attempt, created_at, updated_at, next_check_at)
       VALUES (@id, @pr, @session, @kind, @round_no, @payload_sha256, @payload_path,
          @inject_path, 'pending', NULL, 0, @ts, @ts, @next_check_at)`,
      )
      .run({ ...input, ts });
    return this.getSessionCommand(input.id)!;
  }

  getSessionCommand(id: string): SessionCommandRow | undefined {
    return this.db.prepare("SELECT * FROM session_commands WHERE id = ?").get(id) as
      SessionCommandRow | undefined;
  }

  getSessionCommandByInjectPath(path: string): SessionCommandRow | undefined {
    return this.db.prepare("SELECT * FROM session_commands WHERE inject_path = ?").get(path) as
      SessionCommandRow | undefined;
  }

  activeSessionCommand(session: string): SessionCommandRow | undefined {
    return this.db
      .prepare(
        "SELECT * FROM session_commands WHERE session = ? AND status IN ('pending', 'running') LIMIT 1",
      )
      .get(session) as SessionCommandRow | undefined;
  }

  /** Work still owed by the session. `failed` is terminal for one attempt but
   * deliberately blocks successors until recovery retries the same id. */
  blockingSessionCommand(session: string): SessionCommandRow | undefined {
    return this.db
      .prepare(
        `SELECT c.* FROM session_commands c
        WHERE c.session=@session AND ${BLOCKING_SESSION_COMMAND_SQL}
        ORDER BY c.created_at DESC LIMIT 1`,
      )
      .get({ session }) as SessionCommandRow | undefined;
  }

  /** Every durable owner that blocks this PR session, oldest first. Both the
   * PR and canonical session name are required so operator recovery cannot
   * touch a malformed row belonging to another session. */
  blockingSessionCommandsForPr(pr: number): SessionCommandRow[] {
    return this.db
      .prepare(
        `SELECT c.* FROM session_commands c
        WHERE c.pr=@pr AND c.session=@session AND ${BLOCKING_SESSION_COMMAND_SQL}
        ORDER BY c.created_at, c.id`,
      )
      .all({ pr, session: `pr-${pr}` }) as SessionCommandRow[];
  }

  /** The oldest command other than `exceptId` that still owns PR `pr`'s
   * session slot. Queried by PR, not by the canonical session spelling: a
   * malformed or legacy row is still durable PR ownership and must not
   * disappear behind cleanup of a named incident. */
  private otherBlockingCommandForPr(pr: number, exceptId: string): SessionCommandRow | undefined {
    return this.db
      .prepare(
        `SELECT c.* FROM session_commands c
        WHERE c.pr=@pr AND c.id<>@except_id AND ${BLOCKING_SESSION_COMMAND_SQL}
        ORDER BY c.created_at, c.id LIMIT 1`,
      )
      .get({ pr, except_id: exceptId }) as SessionCommandRow | undefined;
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
      if (
        currentIds.length !== capturedIds.length ||
        currentIds.some((id, i) => id !== capturedIds[i])
      ) {
        throw new Error(`operator recovery blocker set changed while fencing #${pr}`);
      }
      const expected = rows
        .filter((row) => row.kind !== "round" && row.kind !== "answer")
        .map((row) => row.id)
        .sort();
      const supplied = recovered.map((row) => row.id).sort();
      if (expected.length !== supplied.length || expected.some((id, i) => id !== supplied[i])) {
        throw new Error(
          `operator recovery payload set does not match blocking commands for #${pr}`,
        );
      }
      const byId = new Map(recovered.map((row) => [row.id, row.payload]));
      const wakeIds: number[] = [];
      const ts = this.ts();
      for (const row of rows) {
        // An operator's message to an idle PR was answered or it was not: it is
        // never held as a wake for later (rule 9), so recovery cancels it as it is.
        if (row.kind !== "round" && row.kind !== "answer") {
          const payload = byId.get(row.id);
          if (payload === undefined)
            throw new Error(`operator recovery payload missing for ${row.id}`);
          const inserted = this.db
            .prepare("INSERT INTO pending_wakes (pr, payload, reason, held_at) VALUES (?, ?, ?, ?)")
            .run(
              pr,
              payload,
              // A recheck nudge keeps its `recheck:` class (a pause defers it).
              `${OPERATOR_RECOVERED_WAKE_PREFIX}${
                parseRecheckPromptMarker(payload) ? RECHECK_WAKE_PREFIX : ""
              }${row.kind}:${row.id}`,
              row.created_at,
            );
          wakeIds.push(Number(inserted.lastInsertRowid));
        }
        const changed = this.db
          .prepare(
            `UPDATE session_commands
              SET status='cancelled', owner_token=NULL, updated_at=@ts,
                  next_check_at=@ts, failure=@failure
            WHERE id=@id AND pr=@pr AND session=@session
              AND status IN ('pending', 'running', 'failed')`,
          )
          .run({
            id: row.id,
            pr,
            session: `pr-${pr}`,
            ts,
            failure: `operator ${reason}`,
          }).changes;
        if (changed !== 1) throw new Error(`operator recovery lost command ${row.id}`);
      }
      const droppedWakeIds = this.trimHeldWakes(pr).map((wake) => wake.id);
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

  /**
   * A closed PR owes its session nothing more: terminalize every outstanding
   * ordinary (non-round) command so the bounded recovery sweep can never
   * replay one into a respawned pr-<n> after the close hook killed it.
   * Round commands keep their own lifecycle — recovery
   * already refuses one whose round is no longer running. A failed command
   * that already carries owed operator debt is left alone: it is never
   * replayed (dueSessionCommands excludes it) and `u` resolves that debt
   * only against a command still in 'failed'.
   */
  cancelSessionCommandsForClosedPr(pr: number): string[] {
    const ts = this.ts();
    const ids = this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT id FROM session_commands
            WHERE pr=@pr AND session=@session AND kind!='round'
              AND status IN ('pending', 'running', 'failed')
              AND NOT EXISTS (
                SELECT 1 FROM review_failures f
                 WHERE f.command_id=session_commands.id AND f.work_owed=1
              )`,
        )
        .all({ pr, session: `pr-${pr}` }) as Array<{ id: string }>;
      this.db
        .prepare(
          `UPDATE session_commands
            SET status='cancelled', owner_token=NULL, updated_at=@ts,
                next_check_at=@ts, failure='pr closed'
          WHERE pr=@pr AND session=@session AND kind!='round'
            AND status IN ('pending', 'running', 'failed')
            AND NOT EXISTS (
              SELECT 1 FROM review_failures f
               WHERE f.command_id=session_commands.id AND f.work_owed=1
            )`,
        )
        .run({ pr, session: `pr-${pr}`, ts });
      return rows.map((row) => row.id);
    })();
    if (ids.length > 0) {
      this.logEvent("session_commands_closed_cancelled", pr, { cancelled_command_ids: ids });
    }
    return ids;
  }

  activeSessionCommands(): SessionCommandRow[] {
    return this.db
      .prepare(
        "SELECT * FROM session_commands WHERE status IN ('pending', 'running') ORDER BY created_at, id",
      )
      .all() as SessionCommandRow[];
  }

  /** Finite command-stage obligations. Acked round commands remain due only
   * while their round is still running: settlement without a verdict is a
   * liveness failure, whereas completed historical commands need no scans.
   * A failed non-round command remains due until bounded same-command replay
   * succeeds or a durable review_failure records operator-owned exhaustion. */
  dueSessionCommands(at: string): SessionCommandRow[] {
    return this.db
      .prepare(
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
      )
      .all({ at }) as SessionCommandRow[];
  }

  /** Persist one bounded allowance for unreadable/contradictory evidence. */
  deferSessionCommandEvidence(id: string, nextCheckAt: string): boolean {
    const ts = this.ts();
    return (
      this.db
        .prepare(
          `UPDATE session_commands
          SET unknown_checks=unknown_checks+1, updated_at=@ts, next_check_at=@next
        WHERE id=@id AND status IN ('pending', 'running')`,
        )
        .run({ id, ts, next: nextCheckAt }).changes === 1
    );
  }

  /** Reconcile durable positive JSONL evidence the bridge could not stamp. */
  observeSessionCommandStarted(id: string, startedAt: string, nextCheckAt: string): boolean {
    const ts = this.ts();
    return (
      this.db
        .prepare(
          `UPDATE session_commands
          SET status='running', started_at=COALESCE(started_at, @started),
              updated_at=@ts, next_check_at=@next
        WHERE id=@id AND status IN ('pending', 'running')`,
        )
        .run({ id, started: startedAt, ts, next: nextCheckAt }).changes === 1
    );
  }

  scheduleSessionCommandCheck(id: string, nextCheckAt: string): boolean {
    const ts = this.ts();
    return (
      this.db
        .prepare(
          `UPDATE session_commands SET updated_at=@ts, next_check_at=@next
        WHERE id=@id AND status IN ('pending', 'running', 'acked', 'failed')`,
        )
        .run({ id, ts, next: nextCheckAt }).changes === 1
    );
  }

  /** Preserve an unusable payload's diagnosis without changing command
   * status or ownership. Only commands eligible for replay accept it. */
  noteSessionCommandRecoveryFailure(id: string, failure: string): boolean {
    const ts = this.ts();
    return (
      this.db
        .prepare(
          `UPDATE session_commands SET failure=@failure, updated_at=@ts
        WHERE id=@id AND status IN ('pending', 'running', 'failed')
          AND (kind != 'round' OR started_at IS NULL)`,
        )
        .run({ id, failure, ts }).changes === 1
    );
  }

  /** Spend one durable automatic replay allowance before crossing the async
   * tmux/filesystem boundary. A failed rebirth therefore cannot retry forever
   * merely because no new bridge lived long enough to increment `attempt`. */
  beginSessionCommandRecovery(id: string, expectedAttempts: number): boolean {
    const ts = this.ts();
    return (
      this.db
        .prepare(
          `UPDATE session_commands
          SET recovery_attempts=recovery_attempts+1, updated_at=@ts
        WHERE id=@id AND recovery_attempts=@expected
          AND status IN ('pending', 'running', 'failed')
          AND NOT EXISTS (
            SELECT 1 FROM review_failures f
             WHERE f.command_id=session_commands.id AND f.work_owed=1
          )`,
        )
        .run({ id, expected: expectedAttempts, ts }).changes === 1
    );
  }

  /** Supervisor terminalization is owner-independent only after external
   * evidence/lease classification. Its guarded active-state update fences a
   * concurrent bridge settlement that won first. */
  failActiveSessionCommand(id: string, failure: string): boolean {
    const ts = this.ts();
    return (
      this.db
        .prepare(
          `UPDATE session_commands
          SET status='failed', failed_at=@ts, failure=@failure,
              updated_at=@ts, next_check_at=@ts
        WHERE id=@id AND status IN ('pending', 'running')`,
        )
        .run({ id, failure, ts }).changes === 1
    );
  }

  /**
   * End an idle-PR answer command that did not serve its message. It is
   * `cancelled`, never `failed`: a failed non-round command is owed work that
   * blocks its PR's next round until a replay settles it, and an operator's
   * message is answered now or not at all. The reason stays in `failure`.
   */
  cancelAnswerCommand(id: string, reason: string): boolean {
    const ts = this.ts();
    return (
      this.db
        .prepare(
          `UPDATE session_commands
          SET status='cancelled', owner_token=NULL, failure=@reason,
              updated_at=@ts, next_check_at=@ts
        WHERE id=@id AND kind='answer' AND status IN ('pending', 'running', 'failed')`,
        )
        .run({ id, reason, ts }).changes === 1
    );
  }

  ackSettledSessionCommand(id: string): boolean {
    const ts = this.ts();
    return (
      this.db
        .prepare(
          `UPDATE session_commands
          SET status='acked', settled_at=COALESCE(settled_at, @ts),
              updated_at=@ts, next_check_at=@ts, failure=NULL
        WHERE id=@id AND status='running' AND started_at IS NOT NULL`,
        )
        .run({ id, ts }).changes === 1
    );
  }

  failSettledSessionCommand(id: string, failure: string): boolean {
    const ts = this.ts();
    return (
      this.db
        .prepare(
          `UPDATE session_commands
          SET status='failed', failed_at=@ts, failure=@failure,
              updated_at=@ts, next_check_at=@ts
        WHERE id=@id AND status='acked'`,
        )
        .run({ id, failure, ts }).changes === 1
    );
  }

  sessionCommandForRound(pr: number, roundNo: number): SessionCommandRow | undefined {
    return this.db
      .prepare(
        "SELECT * FROM session_commands WHERE pr = ? AND kind = 'round' AND round_no = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(pr, roundNo) as SessionCommandRow | undefined;
  }

  /** The PR's commands created at or after `sinceIso`, oldest first: the worker
   * host reads a wake's fate off its command row, since a worker leaves no
   * transcript scan behind (`WorkerSessionHost.wakeReceiptPresent`). */
  sessionCommandsSince(pr: number, sinceIso: string): SessionCommandRow[] {
    return this.db
      .prepare(
        "SELECT * FROM session_commands WHERE pr = ? AND created_at >= ? ORDER BY created_at, id",
      )
      .all(pr, sinceIso) as SessionCommandRow[];
  }

  claimSessionCommand(
    id: string,
    ownerToken: string,
    nextCheckAt: string,
  ): SessionCommandRow | undefined {
    const ts = this.ts();
    const changed = this.db
      .prepare(
        `UPDATE session_commands
          SET status='running', owner_token=@owner, attempt=attempt+1,
              started_at=NULL, updated_at=@ts, next_check_at=@next
        WHERE id=@id AND status='pending'`,
      )
      .run({ id, owner: ownerToken, ts, next: nextCheckAt }).changes;
    return changed === 1 ? this.getSessionCommand(id) : undefined;
  }

  markSessionCommandStarted(id: string, ownerToken: string, nextCheckAt: string): boolean {
    const ts = this.ts();
    return (
      this.db
        .prepare(
          `UPDATE session_commands
          SET started_at=COALESCE(started_at, @ts), updated_at=@ts, next_check_at=@next
        WHERE id=@id AND status='running' AND owner_token=@owner`,
        )
        .run({ id, owner: ownerToken, ts, next: nextCheckAt }).changes === 1
    );
  }

  finishSessionCommand(
    id: string,
    ownerToken: string,
    status: "acked" | "failed",
    failure?: string,
  ): boolean {
    const ts = this.ts();
    const changed = this.db
      .prepare(
        `UPDATE session_commands
          SET status=@status, updated_at=@ts, next_check_at=@ts,
              settled_at=CASE WHEN @status='acked' THEN @ts ELSE settled_at END,
              failed_at=CASE WHEN @status='failed' THEN @ts ELSE failed_at END,
              failure=CASE WHEN @status='failed' THEN @failure ELSE NULL END
        WHERE id=@id AND status='running' AND owner_token=@owner
          AND (@status='failed' OR started_at IS NOT NULL)`,
      )
      .run({ id, owner: ownerToken, status, failure: failure ?? null, ts }).changes;
    return changed === 1;
  }

  failPendingSessionCommand(id: string, failure: string): boolean {
    const ts = this.ts();
    return (
      this.db
        .prepare(
          `UPDATE session_commands
          SET status='failed', failed_at=@ts, failure=@failure, updated_at=@ts, next_check_at=@ts
        WHERE id=@id AND status='pending'`,
        )
        .run({ id, failure, ts }).changes === 1
    );
  }

  /**
   * Hand a command that never started back to `pending` for a REDELIVERY
   * into the same live session — same id, path and bytes, no kill. A CAS on
   * the row the SUPERVISOR found due — its attempt, redelivery count and
   * `next_check_at` — so a bridge that reserved the command after that due
   * check (a new attempt, a fresh lease) wins, and a submission pi may still
   * be preflighting is never handed back as stale. Never for a started
   * command: that one was delivered.
   */
  requeueSessionCommandForRedelivery(
    id: string,
    expected: SessionCommandObservation,
    nextCheckAt: string,
  ): boolean {
    const ts = this.ts();
    return (
      this.db
        .prepare(
          `UPDATE session_commands
            SET status='pending', owner_token=NULL, updated_at=@ts, next_check_at=@next,
                unknown_checks=0, redeliveries=redeliveries+1, failure=NULL
          WHERE id=@id AND status IN ('pending', 'running') AND started_at IS NULL
            AND attempt=@attempt AND redeliveries=@redeliveries
            AND next_check_at=@observed_next
            -- A round prompt is only ever re-offered while its round is still
            -- running (the rule queuePrCommand applies at birth).
            AND (kind != 'round' OR EXISTS (
              SELECT 1 FROM rounds r
               WHERE r.pr = session_commands.pr AND r.round_no = session_commands.round_no
                 AND r.status = 'running'))`,
        )
        .run({
          id,
          ts,
          next: nextCheckAt,
          attempt: expected.attempt,
          redeliveries: expected.redeliveries,
          observed_next: expected.next_check_at,
        }).changes === 1
    );
  }

  /** Kill-before-replay CAS. The caller has already proved the old session is
   * absent. A round may only replay before correlated acceptance; ordinary
   * wakes may replay after acceptance because the old consumer is fenced and
   * the same row still owns the immutable payload. The replay lands in a NEW
   * session generation, so its same-session redelivery budget starts again:
   * otherwise the fresh conversation's first missed
   * start would skip redelivery and kill it too. Bounded all the same — every
   * replay spends one `recovery_attempts`. */
  retrySessionCommandAfterFence(id: string, expectedAttempt: number, nextCheckAt: string): boolean {
    // `.immediate()`: the read below must wait inside busy_timeout for the write
    // lock, not fail on the read-to-write upgrade.
    const retry = this.db.transaction((): boolean => {
      const row = this.getSessionCommand(id);
      if (
        !row ||
        !["pending", "running", "failed"].includes(row.status) ||
        row.attempt !== expectedAttempt ||
        (row.kind === "round" && row.started_at !== null)
      )
        return false;
      if (row.kind === "round") {
        const round = this.db
          .prepare("SELECT status FROM rounds WHERE pr=? AND round_no=?")
          .get(row.pr, row.round_no) as { status: string } | undefined;
        if (round?.status !== "running") return false;
      }
      const ts = this.ts();
      return (
        this.db
          .prepare(
            `UPDATE session_commands
            SET status='pending', owner_token=NULL, updated_at=@ts,
                next_check_at=@next, unknown_checks=0, redeliveries=0,
                started_at=NULL, settled_at=NULL, failed_at=NULL, failure=NULL
          WHERE id=@id AND status IN ('pending', 'running', 'failed')
            AND attempt=@attempt
            AND NOT EXISTS (
              SELECT 1 FROM session_commands active
               WHERE active.session=session_commands.session
                 AND active.id!=session_commands.id
                 AND active.status IN ('pending', 'running')
            )`,
          )
          .run({ id, attempt: expectedAttempt, ts, next: nextCheckAt }).changes === 1
      );
    });
    return retry.immediate();
  }

  /** A terminal command handed back for a fresh delivery (`redeliverRound`,
   * bounded by the round's own `redeliveries`): a new delivery lifecycle, so
   * the same-session redelivery budget starts again. A round prompt is
   * handed back only while its round still runs, as on the other two replay
   * paths: a round ended meanwhile is never revived. */
  retrySessionCommand(id: string, opts: { inject_path: string; next_check_at: string }): boolean {
    const ts = this.ts();
    return (
      this.db
        .prepare(
          `UPDATE session_commands
          SET status='pending', owner_token=NULL, inject_path=@inject_path,
              updated_at=@ts, next_check_at=@next_check_at, unknown_checks=0, redeliveries=0,
              started_at=NULL, settled_at=NULL, failed_at=NULL, failure=NULL
        WHERE id=@id AND status IN ('acked', 'failed')
          AND (kind != 'round' OR EXISTS (
            SELECT 1 FROM rounds r
             WHERE r.pr = session_commands.pr AND r.round_no = session_commands.round_no
               AND r.status = 'running'))
          AND NOT EXISTS (
            SELECT 1 FROM session_commands active
             WHERE active.session=session_commands.session
               AND active.id!=session_commands.id
               AND active.status IN ('pending', 'running')
          )`,
        )
        .run({ id, ...opts, ts }).changes === 1
    );
  }

  /**
   * A worker-hosted command whose worker is gone, handed back to `pending` so a
   * fresh worker resumes it under the SAME id (the JSONL's marker is what makes
   * the worker continue instead of sending the order again). Only the
   * WorkerSupervisor calls it. `ownerToken` fences the CAS to the spawn that held
   * the row; the daemon's boot passes null, since no owner survives a restart.
   * Spends one `recovery_attempts`, the bound the supervisor reads. A round's
   * command is only handed back while its round still runs.
   */
  requeueWorkerCommand(id: string, ownerToken: string | null, nextCheckAt: string): boolean {
    const ts = this.ts();
    return (
      this.db
        .prepare(
          `UPDATE session_commands
            SET status='pending', owner_token=NULL, updated_at=@ts, next_check_at=@next,
                unknown_checks=0, started_at=NULL, failure=NULL,
                recovery_attempts=recovery_attempts+1
          WHERE id=@id AND status='running'
            AND (@owner IS NULL OR owner_token=@owner)
            AND (kind != 'round' OR EXISTS (
              SELECT 1 FROM rounds r
               WHERE r.pr = session_commands.pr AND r.round_no = session_commands.round_no
                 AND r.status = 'running'))`,
        )
        .run({ id, owner: ownerToken, ts, next: nextCheckAt }).changes === 1
    );
  }

  // ---- supervisor liveness ----------------------------------------------

  supervisorLease(name: string): SupervisorLeaseRow | undefined {
    return this.db.prepare("SELECT * FROM supervisor_leases WHERE name = ?").get(name) as
      SupervisorLeaseRow | undefined;
  }

  markSupervisorAttempt(name: string, at = this.ts()): void {
    this.db
      .prepare(
        `INSERT INTO supervisor_leases (name, last_attempt_at)
       VALUES (?, ?)
       ON CONFLICT(name) DO UPDATE SET last_attempt_at=excluded.last_attempt_at`,
      )
      .run(name, at);
  }

  markSupervisorSuccess(name: string, at = this.ts()): void {
    this.db
      .prepare(
        `INSERT INTO supervisor_leases (name, last_success_at, last_error_at, last_error)
       VALUES (?, ?, NULL, NULL)
       ON CONFLICT(name) DO UPDATE SET
         last_success_at=excluded.last_success_at, last_error_at=NULL, last_error=NULL`,
      )
      .run(name, at);
  }

  markSupervisorError(name: string, error: string, at = this.ts()): void {
    this.db
      .prepare(
        `INSERT INTO supervisor_leases (name, last_error_at, last_error)
       VALUES (?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         last_error_at=excluded.last_error_at, last_error=excluded.last_error`,
      )
      .run(name, at, error);
  }

  // ---- held wakes (single-shepherd invariant) -----------------------------

  /** Enforce the ordinary wake budget without ever deleting an obligation
   * restored by operator recovery, leased to an in-flight delivery, or owed
   * to an author. Operator-recovered and leased rows consume
   * capacity first; if they alone meet or exceed the cap, all survive and new
   * ordinary wakes are dropped. Author replies neither count nor go. What
   * goes, goes in this order: push recheck nudges, oldest first — the only
   * class a sweep re-raises (the reconcile push backstop asks the question
   * again once its claim is released); then every other ordinary wake,
   * oldest first, a ci or base-advance recheck among them (nothing re-asks
   * those, so they get no priority to go). Every evicted recheck's claim is
   * released for pushes; CI/base questions retain their exact payload.
   * Must run inside the caller's transaction with the capped-wake delete. */
  private trimHeldWakes(pr: number, cap = MAX_HELD_WAKES): EvictedWake[] {
    const protectedCount = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS c FROM pending_wakes
        WHERE pr=@pr AND reason != @author
          AND (reason GLOB '${OPERATOR_RECOVERED_WAKE_PREFIX}*' OR claim_token IS NOT NULL)`,
        )
        .get({ pr, author: AUTHOR_REPLY_WAKE_REASON }) as { c: number }
    ).c;
    const ordinaryCap = Math.max(0, cap - protectedCount);
    // Kept first: every other ordinary wake, newest first; then push recheck
    // nudges, newest first. Everything past the cap is evicted — so push
    // rechecks go before any other wake, and the oldest of each class first.
    const overflow = this.db
      .prepare(
        `SELECT id, reason, payload FROM pending_wakes
        WHERE pr=@pr AND reason != @author
          AND reason NOT GLOB '${OPERATOR_RECOVERED_WAKE_PREFIX}*' AND claim_token IS NULL
        ORDER BY CASE WHEN reason = @backstopped THEN 1 ELSE 0 END,
          held_at DESC, id DESC
        LIMIT -1 OFFSET @keep`,
      )
      .all({
        pr,
        author: AUTHOR_REPLY_WAKE_REASON,
        backstopped: RECHECK_WITH_BACKSTOP_WAKE_REASON,
        keep: ordinaryCap,
      }) as Array<{
      id: number;
      reason: string;
      payload: string;
    }>;
    const evicted: EvictedWake[] = [];
    for (const row of overflow) {
      this.db.prepare("DELETE FROM pending_wakes WHERE id = ?").run(row.id);
      let released: string | null = null;
      if (row.reason.startsWith(RECHECK_WAKE_PREFIX)) {
        const marker = parseRecheckPromptMarker(row.payload);
        if (marker && marker.pr === pr) {
          const claim = this.db
            .prepare("SELECT trigger FROM rechecks WHERE pr=? AND fingerprint=?")
            .get(pr, marker.fingerprint) as { trigger: string } | undefined;
          if (claim?.trigger === "ci" || claim?.trigger === "base_advance") {
            this.retainRecheckDelivery(pr, marker.fingerprint, row.payload, row.reason);
            this.logEvent("recheck_wake_recovery_pending", pr, {
              fingerprint: marker.fingerprint,
              reason: row.reason,
            });
          } else {
            this.releaseRecheck(pr, marker.fingerprint);
            released = marker.fingerprint;
          }
        }
      }
      evicted.push({
        id: row.id,
        reason: row.reason,
        released_recheck: released,
        re_raised_by_reconcile:
          released !== null && row.reason === RECHECK_WITH_BACKSTOP_WAKE_REASON,
      });
    }
    return evicted.sort((a, b) => a.id - b.id);
  }

  /** Hold a rendered wake until this PR's round ends. Returns the ids dropped
   * to stay under `cap` (oldest first) so the caller can log them — a silently
   * dropped author reply is worse than a late one. Insert + cap enforcement is
   * one transaction, including when another delivery already owns a lease. */
  holdWake(pr: number, payload: string, reason: string, cap = MAX_HELD_WAKES): number[] {
    return this.holdWakeEvicting(pr, payload, reason, cap).map((wake) => wake.id);
  }

  /** `holdWake`, answering with what the cap evicted and which recheck claims
   * the eviction released. */
  holdWakeEvicting(
    pr: number,
    payload: string,
    reason: string,
    cap = MAX_HELD_WAKES,
  ): EvictedWake[] {
    return this.holdWakeWithIdentity(pr, payload, reason, cap).dropped;
  }

  /** The inserted identity remains observable even when the cap evicts it. */
  holdWakeWithIdentity(
    pr: number,
    payload: string,
    reason: string,
    cap = MAX_HELD_WAKES,
  ): { id: number; dropped: EvictedWake[] } {
    return this.db.transaction(() => {
      const inserted = this.db
        .prepare("INSERT INTO pending_wakes (pr, payload, reason, held_at) VALUES (?, ?, ?, ?)")
        .run(pr, payload, reason, this.now().toISOString());
      return { id: Number(inserted.lastInsertRowid), dropped: this.trimHeldWakes(pr, cap) };
    })();
  }

  heldWakes(pr: number, skipReasonPrefix?: string): PendingWakeRow[] {
    return this.db
      .prepare(
        `SELECT * FROM pending_wakes WHERE pr=@pr
      AND (@skip IS NULL OR substr(CASE WHEN substr(reason,1,@recoveredLength)=@recovered
        THEN substr(reason,@recoveredLength+1) ELSE reason END,1,length(@skip)) != @skip)
      ORDER BY ${PENDING_WAKE_ORDER_SQL}`,
      )
      .all({
        pr,
        skip: skipReasonPrefix ?? null,
        recovered: OPERATOR_RECOVERED_WAKE_PREFIX,
        recoveredLength: OPERATOR_RECOVERED_WAKE_PREFIX.length,
      }) as PendingWakeRow[];
  }

  hasHeldWakes(pr: number): boolean {
    return (
      (
        this.db.prepare("SELECT COUNT(*) AS c FROM pending_wakes WHERE pr=?").get(pr) as {
          c: number;
        }
      ).c > 0
    );
  }

  /** Lease an oldest-first prefix as one delivery unit. A live lease anywhere
   * in that prefix blocks the claim, so concurrent flushers cannot split or
   * reorder an author-message burst. */
  /** Lease the oldest `count` held wakes for one delivery, or null when they
   * are not all free. Wakes whose reason starts with `skipReasonPrefix` are
   * passed over (a paused PR's deferred rechecks). */
  claimHeldWakeBatch(
    pr: number,
    token: string,
    leaseBefore: string,
    count: number,
    skipReasonPrefix?: string,
  ): PendingWakeRow[] | null {
    if (!Number.isSafeInteger(count) || count < 1)
      throw new Error(`invalid held-wake batch size ${count}`);
    const claim = this.db.transaction((n: number): PendingWakeRow[] | null => {
      const rows = this.heldWakes(n, skipReasonPrefix).slice(0, count);
      if (rows.length !== count) return null;
      if (rows.some((row) => row.claim_token && row.claimed_at && row.claimed_at > leaseBefore))
        return null;
      const ids = rows.map((row) => row.id);
      const holes = ids.map(() => "?").join(",");
      const now = this.now().toISOString();
      const changed = this.db
        .prepare(
          `UPDATE pending_wakes SET claim_token=?, claimed_at=?, attempts=attempts+1
          WHERE id IN (${holes}) AND (claim_token IS NULL OR claimed_at IS NULL OR claimed_at <= ?)`,
        )
        .run(token, now, ...ids, leaseBefore).changes;
      if (changed !== ids.length)
        throw new Error(`held-wake batch claim lost ${changed}/${ids.length} rows`);
      return this.db
        .prepare(
          `SELECT * FROM pending_wakes WHERE id IN (${holes})
        ORDER BY ${PENDING_WAKE_ORDER_SQL}`,
        )
        .all(...ids) as PendingWakeRow[];
    });
    return claim(pr);
  }

  ackHeldWakeBatch(ids: number[], token: string): boolean {
    if (ids.length === 0) return false;
    const ack = this.db.transaction((): boolean => {
      const holes = ids.map(() => "?").join(",");
      const owned = (
        this.db
          .prepare(
            `SELECT COUNT(*) AS c FROM pending_wakes WHERE id IN (${holes}) AND claim_token = ?`,
          )
          .get(...ids, token) as { c: number }
      ).c;
      if (owned !== ids.length) return false;
      const deleted = this.db
        .prepare(`DELETE FROM pending_wakes WHERE id IN (${holes}) AND claim_token = ?`)
        .run(...ids, token).changes;
      if (deleted !== ids.length)
        throw new Error(`held-wake batch ack lost ${deleted}/${ids.length} rows`);
      return true;
    });
    return ack();
  }

  releaseHeldWakeBatch(ids: number[], token: string): boolean {
    if (ids.length === 0) return false;
    const release = this.db.transaction((): boolean => {
      const holes = ids.map(() => "?").join(",");
      const owned = (
        this.db
          .prepare(
            `SELECT COUNT(*) AS c FROM pending_wakes WHERE id IN (${holes}) AND claim_token = ?`,
          )
          .get(...ids, token) as { c: number }
      ).c;
      if (owned !== ids.length) return false;
      const changed = this.db
        .prepare(
          `UPDATE pending_wakes SET claim_token=NULL, claimed_at=NULL
          WHERE id IN (${holes}) AND claim_token = ?`,
        )
        .run(...ids, token).changes;
      if (changed !== ids.length)
        throw new Error(`held-wake batch release lost ${changed}/${ids.length} rows`);
      return true;
    });
    return release();
  }

  /** Explicit destructive cleanup for a closed PR; never use for delivery. */
  dropHeldWakes(pr: number): number {
    return this.db.prepare("DELETE FROM pending_wakes WHERE pr = ?").run(pr).changes;
  }

  /** Rounds whose `started_at` falls in [startIso, endIso) — both UTC ISO
   * instants, which compare correctly as strings (every writer uses
   * `toISOString()`). The zone-local-day reader: `roundsOn` buckets by the
   * UTC date prefix. */
  roundsStartedBetween(startIso: string, endIso: string): RoundRow[] {
    return this.db
      .prepare("SELECT * FROM rounds WHERE started_at >= ? AND started_at < ? ORDER BY started_at")
      .all(startIso, endIso) as RoundRow[];
  }

  roundsOn(dateIso: string): RoundRow[] {
    return this.db
      .prepare("SELECT * FROM rounds WHERE started_at LIKE ? ORDER BY started_at")
      .all(`${dateIso}%`) as RoundRow[];
  }

  /**
   * est_usd is the one spend field (legacy spend_usd is folded into it at
   * boot).
   *
   * **Expired rounds ARE counted**: a round that blew its deadline still ran
   * the passes and still burned the tokens, so excluding it would erase real
   * cost. Expiry is a bookkeeping status, not a refund. Round *counts* and duration
   * statistics still exclude them (see metrics.ts): those are the figures an
   * abandoned row genuinely distorts.
   */
  totalSpend(): number {
    return (
      this.db.prepare("SELECT COALESCE(SUM(est_usd), 0) AS s FROM rounds").get() as { s: number }
    ).s;
  }

  /**
   * Recurring zombie expiry: move to terminal `expired` every round
   * stuck `overdue` past `horizonHours` (measured from its deadline) whose PR
   * has since verdicted (same-or-higher round number delivered a verdict) or
   * closed. Deliberately narrower than "any old overdue round": a round a
   * rerun could still service (open PR, nothing decided since) is the
   * self-requeue's to rescue, never this sweep's to bury. Returns the expired round ids.
   */
  expireOverdueRounds(horizonHours: number): number[] {
    const cutoff = new Date(this.now().getTime() - horizonHours * 3_600_000).toISOString();
    const rows = this.db
      .prepare(
        `SELECT id, pr, round_no FROM rounds
          WHERE status = 'overdue' AND deadline_at < ?
            AND ${OVERDUE_ROUND_BURIABLE_SQL}`,
      )
      .all(cutoff) as Array<{ id: number; pr: number; round_no: number }>;
    if (rows.length === 0) return [];
    this.expireOverdue(rows.map((r) => r.id));
    this.logEvent("rounds_expired", null, {
      count: rows.length,
      rounds: rows.map((r) => ({ id: r.id, pr: r.pr, round_no: r.round_no })),
    });
    return rows.map((r) => r.id);
  }

  /** Move these `overdue` rounds to terminal `expired`, keeping a finish
   * time already recorded. A round no longer overdue is left as it is. */
  private expireOverdue(ids: readonly number[]): void {
    const stamp = this.db.prepare(
      "UPDATE rounds SET status = 'expired', finished_at = COALESCE(finished_at, ?) WHERE id = ? AND status = 'overdue'",
    );
    for (const id of ids) stamp.run(this.ts(), id);
  }

  /**
   * The rounds `expireOverdueRounds` deliberately refuses to bury.
   *
   * Its guard is narrow on purpose: an `overdue` round whose PR is still open
   * and still undecided might yet be rescued by a rerun, and burying it would
   * hide a PR that was never reviewed. But nothing ever reruns an overdue
   * round automatically — `markRoundOverdue` is terminal — so in practice such
   * a row just sits there, invisible.
   *
   * A round past this far wider horizon is not "pending rescue", it is
   * stranded, and the answer is to say so out loud (the caller raises the
   * anomaly) rather than to keep quietly not-deciding. `horizonHours` is
   * measured from the deadline.
   */
  strandedOverdueRounds(horizonHours: number = STRANDED_ROUND_HORIZON_H): RoundRow[] {
    const cutoff = new Date(this.now().getTime() - horizonHours * 3_600_000).toISOString();
    return this.db
      .prepare(
        "SELECT * FROM rounds WHERE status = 'overdue' AND deadline_at < ? ORDER BY deadline_at",
      )
      .all(cutoff) as RoundRow[];
  }

  /**
   * Terminalize the stranded rounds above. Returns the rows as they were, so
   * the caller can name each one in its anomaly — after this they are
   * `expired`, which does not erase their spend, so nothing is lost by
   * closing the row. The PR is NOT requeued and GitHub is not touched:
   * deciding to redo a ten-day-old review is a human's call, and this sweep's
   * whole job is to make sure a human is told.
   */
  expireStrandedRounds(horizonHours: number = STRANDED_ROUND_HORIZON_H): RoundRow[] {
    const rows = this.strandedOverdueRounds(horizonHours);
    if (rows.length === 0) return [];
    this.expireOverdue(rows.map((r) => r.id));
    this.logEvent("rounds_stranded", null, {
      count: rows.length,
      horizon_h: horizonHours,
      rounds: rows.map((r) => ({
        id: r.id,
        pr: r.pr,
        round_no: r.round_no,
        deadline_at: r.deadline_at,
      })),
    });
    return rows;
  }

  // ---- backfilled rounds (M2 importer writes; nothing live reads them) ----

  /** Every GitHub review id already imported — the idempotence key set. */
  importedReviewIds(): Set<number> {
    const rows = this.db
      .prepare("SELECT gh_review_id AS id FROM rounds WHERE gh_review_id IS NOT NULL")
      .all() as Array<{ id: number }>;
    return new Set(rows.map((r) => r.id));
  }

  /** Stash the round-start integrity fingerprint (git's config and the
   * policy surface). Best-effort by design — a store that cannot record it
   * yields a round with no check, never a failed round. */
  recordRoundGitConfig(roundId: number, fingerprint: unknown): void {
    this.db
      .prepare("UPDATE rounds SET git_config_fingerprint = ? WHERE id = ?")
      .run(JSON.stringify(fingerprint), roundId);
  }

  /** The stashed fingerprint, or undefined when the round predates the check
   * (or never got one). Absent is never read as "changed". */
  roundGitConfig(roundId: number): unknown | undefined {
    const row = this.db
      .prepare("SELECT git_config_fingerprint AS f FROM rounds WHERE id = ?")
      .get(roundId) as { f: string | null } | undefined;
    if (!row?.f) return undefined;
    try {
      return JSON.parse(row.f);
    } catch {
      return undefined;
    }
  }

  /** The review ids this daemon recorded posting for ONE pr — the
   * per-review ledger, read as a trace by the ungated-review audit.
   * Scoped per PR (unlike `importedReviewIds`) because the audit asks a
   * per-PR question and a global set would let one PR's row vouch for another. */
  /** Every inline review-comment id the daemon registered as its own on this PR
   * (`bot_comments`, kind `review_comment`): an issue comment may share the
   * number and is a different comment. */
  botCommentIds(pr: number): Set<number> {
    const rows = this.db
      .prepare("SELECT comment_id AS id FROM bot_comments WHERE pr = ? AND kind = 'review_comment'")
      .all(pr) as Array<{ id: number }>;
    return new Set(rows.map((r) => r.id));
  }

  postedReviewIds(pr: number): Set<number> {
    const rows = this.db
      .prepare("SELECT gh_review_id AS id FROM rounds WHERE pr = ? AND gh_review_id IS NOT NULL")
      .all(pr) as Array<{ id: number }>;
    return new Set(rows.map((r) => r.id));
  }

  /** Lowest round_no on a PR (null when it has no rounds) — the importer
   * numbers historical rounds *below* it so live numbering is never disturbed. */
  minRoundNo(pr: number): number | null {
    return (
      this.db.prepare("SELECT MIN(round_no) AS m FROM rounds WHERE pr = ?").get(pr) as {
        m: number | null;
      }
    ).m;
  }

  /** Start of the daemon era: the oldest natively-run round. Reviews submitted
   * at or after it are already recorded, so the importer stops there. */
  daemonEpoch(): string | null {
    return (
      this.db.prepare("SELECT MIN(started_at) AS m FROM rounds WHERE backfilled = 0").get() as {
        m: string | null;
      }
    ).m;
  }

  /** Keep imported history chronological across incremental snapshots. Native
   * rounds retain their numbers; historical comment attribution follows its round. */
  resequenceBackfilledRounds(pr: number): void {
    this.db.transaction(() => {
      const rows = this.db
        .prepare(
          "SELECT id, round_no FROM rounds WHERE pr=? AND backfilled=1 ORDER BY finished_at, gh_review_id, id",
        )
        .all(pr) as Array<{ id: number; round_no: number }>;
      const native = this.db
        .prepare("SELECT MIN(round_no) AS n FROM rounds WHERE pr=? AND backfilled=0")
        .get(pr) as { n: number | null };
      const base = native.n === null ? 1 : native.n - rows.length;
      // Snapshot attribution first so overlapping number ranges cannot remap
      // a comment twice. Imports produce no findings/session rows.
      const numbers = new Map(rows.map((row, i) => [row.round_no, base + i]));
      const comments = this.db
        .prepare("SELECT comment_id, kind, round_no FROM bot_comments WHERE pr=?")
        .all(pr) as Array<{ comment_id: number; kind: string; round_no: number | null }>;
      const commentUpdate = this.db.prepare(
        "UPDATE bot_comments SET round_no=? WHERE comment_id=? AND kind=?",
      );
      for (const comment of comments) {
        const number = comment.round_no === null ? undefined : numbers.get(comment.round_no);
        if (number !== undefined) commentUpdate.run(number, comment.comment_id, comment.kind);
      }
      const update = this.db.prepare("UPDATE rounds SET round_no=? WHERE id=? AND backfilled=1");
      rows.forEach((row, i) => update.run(base + i, row.id));
    })();
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

  upsertBackfillPrMeta(
    row: Omit<BackfillPrMetaRow, "imported_at"> & { imported_at?: string },
  ): void {
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
    return this.db.prepare("SELECT * FROM backfill_pr_meta WHERE pr = ?").get(pr) as
      BackfillPrMetaRow | undefined;
  }

  allBackfillPrMeta(): BackfillPrMetaRow[] {
    return this.db
      .prepare("SELECT * FROM backfill_pr_meta ORDER BY pr")
      .all() as BackfillPrMetaRow[];
  }

  // ---- bot-comment registry ---------------------------------------------

  /**
   * `roundNo` links the comment to the round that produced it (review-depth
   * metric). When omitted it defaults to the round the comment most plausibly
   * came out of — the only defensible attribution for comments discovered
   * after the fact.
   *
   * The live write sites (the reconcile registry backfill and the webhook)
   * pass no round, so the fallback ladder is what attributes most comments.
   * It falls through to a backfilled round before it gives up: an imported
   * round is a worse attribution than a live one and a far better one than
   * null. A RUNNING round wins over both — a comment arriving while a
   * round is in flight came out of that round, not the one before it.
   */
  registerBotComment(
    commentId: number,
    pr: number,
    kind = "review_comment",
    roundNo?: number | null,
  ): void {
    const pick = (sql: string): number | null =>
      (this.db.prepare(sql).get(pr) as { round_no: number } | undefined)?.round_no ?? null;
    const linked =
      roundNo ??
      pick(
        "SELECT round_no FROM rounds WHERE pr = ? AND status = 'running' ORDER BY id DESC LIMIT 1",
      ) ??
      pick(
        "SELECT round_no FROM rounds WHERE pr = ? AND backfilled = 0 ORDER BY id DESC LIMIT 1",
      ) ??
      pick("SELECT round_no FROM rounds WHERE pr = ? ORDER BY id DESC LIMIT 1");
    this.db
      .prepare(
        "INSERT OR IGNORE INTO bot_comments (comment_id, pr, kind, posted_at, round_no) VALUES (?, ?, ?, ?, ?)",
      )
      .run(commentId, pr, kind, this.ts(), linked);
  }

  /** Legacy unqualified reads answer only when the numeric ID is unambiguous. */
  private botCommentRecord(
    commentId: number,
    kind?: string,
  ): { pr: number; posted_at: string | null; round_no: number | null } | undefined {
    const rows = (
      kind === undefined
        ? this.db
            .prepare("SELECT pr,posted_at,round_no FROM bot_comments WHERE comment_id=? LIMIT 2")
            .all(commentId)
        : this.db
            .prepare("SELECT pr,posted_at,round_no FROM bot_comments WHERE kind=? AND comment_id=?")
            .all(kind, commentId)
    ) as Array<{ pr: number; posted_at: string | null; round_no: number | null }>;
    return rows.length === 1 ? rows[0] : undefined;
  }

  botCommentPr(commentId: number, kind?: string): number | undefined {
    return this.botCommentRecord(commentId, kind)?.pr;
  }

  isBotComment(commentId: number, kind?: string): boolean {
    return this.botCommentPr(commentId, kind) !== undefined;
  }

  /** Registration time, for the outcome linker's known namespace. */
  botCommentPostedAt(commentId: number, kind?: string): string | null {
    return this.botCommentRecord(commentId, kind)?.posted_at ?? null;
  }

  /** The round attributed to a comment in its own namespace. */
  botCommentRound(commentId: number, kind?: string): number | null {
    return this.botCommentRecord(commentId, kind)?.round_no ?? null;
  }

  // ---- reviewed-head mark (guard 2; the delta recheck reuses it) ----------

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
    mark: {
      head_sha: string;
      verdict?: string | null;
      posted_event?: string | null;
      round_no?: number | null;
    },
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
        verdict: mark.verdict ?? (same ? prev.verdict : null),
        posted_event: mark.posted_event ?? (same ? prev.posted_event : null),
        round_no: mark.round_no ?? (same ? prev.round_no : null),
        last_author_reply_at: null,
      });
  }

  /**
   * Record the decided verdict on the mark at `headSha`, leaving every other
   * field — `reviewed_at`, the reply stamp — as it is. For a decision that
   * reaches the daemon after its review was stamped at that head (the
   * post-approval recheck's change request). No mark at that head: nothing
   * written.
   */
  recordReviewedVerdict(pr: number, headSha: string, verdict: string): boolean {
    return (
      this.db
        .prepare(
          "UPDATE reviewed_heads SET verdict = ? WHERE pr = ? AND lower(head_sha) = lower(?)",
        )
        .run(verdict, pr, headSha).changes === 1
    );
  }

  reviewedHead(pr: number): ReviewedHeadRow | undefined {
    return this.db.prepare("SELECT * FROM reviewed_heads WHERE pr = ?").get(pr) as
      ReviewedHeadRow | undefined;
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
      !mark ||
      mark.verdict !== null ||
      mark.round_no !== null ||
      (mark.posted_event ?? "").toUpperCase() !== "COMMENT"
    )
      return false;
    const rows = this.db
      .prepare("SELECT payload FROM events WHERE kind='migration_collision_comment' AND pr=?")
      .all(pr) as Array<{ payload: string | null }>;
    const proven = rows.some((row) => {
      if (!row.payload) return false;
      try {
        const payload = JSON.parse(row.payload) as { head_sha?: unknown; executed?: unknown };
        return (
          payload.executed === true &&
          typeof payload.head_sha === "string" &&
          payload.head_sha.toLowerCase() === mark.head_sha.toLowerCase()
        );
      } catch {
        return false;
      }
    });
    if (!proven) return false;
    const removed =
      this.db
        .prepare(
          `DELETE FROM reviewed_heads
        WHERE pr=? AND lower(head_sha)=lower(?)
          AND verdict IS NULL AND round_no IS NULL
          AND upper(COALESCE(posted_event, ''))='COMMENT'`,
        )
        .run(pr, mark.head_sha).changes === 1;
    if (removed)
      this.logEvent("migration_precheck_reviewed_head_repaired", pr, { head_sha: mark.head_sha });
    return removed;
  }

  /** Record an author reply against the PR's mark — the second half of "no new
   * evidence". Only ever moves the stamp forward; a PR with no mark has nothing
   * to skip, so the reply is simply not recorded. */
  noteAuthorReply(pr: number, atIso?: string): void {
    this.noteNewEvidence(pr, atIso);
  }

  /** Record new evidence at the PR's reviewed head — an author reply, or a
   * question the post-approval recheck asked at that head (an adverse CI
   * conclusion, a base advance). Guard 2 and dispatch's no-new-evidence skip
   * read it as the mark's reply stamp. Only ever moves the stamp forward. */
  noteNewEvidence(pr: number, atIso?: string): void {
    const at = atIso ?? this.ts();
    this.db
      .prepare(
        "UPDATE reviewed_heads SET last_author_reply_at = ? WHERE pr = ? AND (last_author_reply_at IS NULL OR last_author_reply_at < ?)",
      )
      .run(at, pr, at);
  }

  // ---- withheld approvals -----------------------------------------------

  /**
   * Mark that an approval was withheld at `head_sha` because CI was not green.
   * One row per PR: the mark is a position, not a history (the event log keeps
   * the history), and a later withholding at a newer head replaces it.
   */
  recordApprovalWithheld(
    pr: number,
    mark: { head_sha: string; ci_state?: string | null; reason?: string | null },
  ): void {
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
    return this.db.prepare("SELECT * FROM approval_withheld WHERE pr = ?").get(pr) as
      ApprovalWithheldRow | undefined;
  }

  /** Drop the mark — the verdict is about to be decided again. */
  clearApprovalWithheld(pr: number): void {
    this.db.prepare("DELETE FROM approval_withheld WHERE pr = ?").run(pr);
  }

  // ---- deferred review postings -----------------------------

  /** Adopt a deferred posting receipt into the retry ledger: insert once
   * (the first failure is the receipt's `deferred_at`), then return the row
   * as it stands — a later adopt never resets a schedule. */
  adoptPostingRetry(input: {
    posting_key: string;
    pr: number;
    round_no: number;
    head_sha: string;
    first_failed_at: string;
    now: string;
  }): PostingRetryRow {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO posting_retries
           (posting_key, pr, round_no, head_sha, first_failed_at, attempts, status, updated_at)
         VALUES (@posting_key, @pr, @round_no, @head_sha, @first_failed_at, 0, 'pending', @now)`,
      )
      .run(input);
    return this.postingRetry(input.posting_key)!;
  }

  postingRetry(postingKey: string): PostingRetryRow | undefined {
    return this.db
      .prepare("SELECT * FROM posting_retries WHERE posting_key = ?")
      .get(postingKey) as PostingRetryRow | undefined;
  }

  /** Count an attempt BEFORE its first GitHub call: a crash inside it
   * resumes at the next offset, never repeats this one. Only a pending row
   * whose count is still `expected` moves (a lost race changes nothing). */
  beginPostingRetryAttempt(postingKey: string, expected: number, now: string): boolean {
    return (
      this.db
        .prepare(
          `UPDATE posting_retries SET attempts = attempts + 1, last_attempt_at = @now, updated_at = @now
           WHERE posting_key = @posting_key AND status = 'pending' AND attempts = @expected`,
        )
        .run({ posting_key: postingKey, expected, now }).changes === 1
    );
  }

  notePostingRetryError(postingKey: string, error: string, now: string): void {
    this.db
      .prepare(
        `UPDATE posting_retries SET last_error = @error, updated_at = @now
         WHERE posting_key = @posting_key AND status = 'pending'`,
      )
      .run({ posting_key: postingKey, error, now });
  }

  /** Terminal: only a pending row settles, once. */
  settlePostingRetry(
    postingKey: string,
    status: "confirmed" | "exhausted" | "abandoned",
    detail: string | null,
    now: string,
  ): boolean {
    return (
      this.db
        .prepare(
          `UPDATE posting_retries SET status = @status, last_error = COALESCE(@detail, last_error), updated_at = @now
           WHERE posting_key = @posting_key AND status = 'pending'`,
        )
        .run({ posting_key: postingKey, status, detail, now }).changes === 1
    );
  }

  pendingPostingRetries(): PostingRetryRow[] {
    return this.db
      .prepare("SELECT * FROM posting_retries WHERE status = 'pending' ORDER BY first_failed_at")
      .all() as PostingRetryRow[];
  }

  // ---- durable FAILED_LOUD review debt ---------------------------------

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
    arg:
      | number
      | {
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
      return this.db
        .prepare(
          "SELECT * FROM review_failures WHERE pr=? AND work_owed=1 ORDER BY failed_at LIMIT 1",
        )
        .get(arg) as ReviewFailureRow | undefined;
    }
    const ts = this.ts();
    const incidentId = arg.command_id
      ? `review-failure:${arg.command_id}`
      : `review-failure:pr-${arg.pr}-round-${arg.round_no ?? "unknown"}`;

    // The automatic-retry class is deliberately proven here, not selected by
    // an untrusted field. The exact command must own the exact now-terminal
    // round, and the supervisor stage must be before the first lens. Every
    // other class — especially posting ambiguity — stays operator-owned.
    const command = arg.command_id ? this.getSessionCommand(arg.command_id) : undefined;
    const round =
      arg.round_id === null || arg.round_id === undefined
        ? undefined
        : (this.db.prepare("SELECT * FROM rounds WHERE id=?").get(arg.round_id) as
            RoundRow | undefined);
    const postingHead =
      round?.posting_key && arg.round_no !== null && arg.round_no !== undefined
        ? postingKeyHead(round.posting_key, arg.pr, arg.round_no)
        : undefined;
    const exactPreFanout =
      arg.stage === "first_pass_start" &&
      postingHead !== undefined &&
      arg.round_no !== null &&
      arg.round_no !== undefined &&
      command?.pr === arg.pr &&
      command.session === `pr-${arg.pr}` &&
      command.kind === "round" &&
      command.round_no === arg.round_no &&
      ["failed", "acked", "cancelled"].includes(command.status) &&
      round?.pr === arg.pr &&
      round.round_no === arg.round_no &&
      round.status !== "running" &&
      ["none", "dryrun", "refused"].includes(round.preflight_posting_state);
    const priorRecovery = exactPreFanout
      ? this.roundRecoveryInstruction(arg.pr, arg.round_no!)
      : undefined;
    const exactRecovery =
      priorRecovery?.target_head_sha === postingHead ? priorRecovery : undefined;
    const retryEpoch = exactRecovery?.retry_epoch ?? 0;
    // `arg.head_sha` historically meant the newest OWED head (a successor may
    // already have moved pr_state). The safe class preserves the deterministic
    // posting-key head; a newer authoritative successor resets backoff later.
    const failureHead = exactPreFanout ? postingHead : arg.head_sha;
    const retryDelayMin = Math.min(
      AUTO_REVIEW_RETRY_INITIAL_MIN * 2 ** retryEpoch,
      AUTO_REVIEW_RETRY_MAX_MIN,
    );
    const nextRetryAt = exactPreFanout
      ? new Date(Date.parse(ts) + retryDelayMin * 60_000).toISOString()
      : null;
    const nextAction = exactPreFanout ? "retry_wait" : "operator_unwedge";

    const failure = this.db.transaction((): ReviewFailureRow => {
      this.db
        .prepare(
          `UPDATE review_failures
            SET work_owed=0, recovered_at=@ts, recovery='superseded-by-new-failure',
                next_action='closed', next_retry_at=NULL, updated_at=@ts
          WHERE pr=@pr AND work_owed=1 AND incident_id!=@incident_id`,
        )
        .run({ pr: arg.pr, incident_id: incidentId, ts });
      this.db
        .prepare(
          `INSERT INTO review_failures
          (incident_id, pr, command_id, round_id, round_no, head_sha, stage, detail,
           attempts, retry_cap, retry_epoch, next_retry_at, failed_at, updated_at,
           next_action, work_owed)
         VALUES (@incident_id, @pr, @command_id, @round_id, @round_no, @head_sha, @stage, @detail,
                 @attempts, @retry_cap, @retry_epoch, @next_retry_at, @ts, @ts,
                 @next_action, 1)
         ON CONFLICT(incident_id) DO UPDATE SET
           head_sha=excluded.head_sha, stage=excluded.stage, detail=excluded.detail,
           attempts=excluded.attempts, retry_cap=excluded.retry_cap,
           retry_epoch=excluded.retry_epoch, next_retry_at=excluded.next_retry_at,
           reopen_epoch=review_failures.reopen_epoch + CASE WHEN review_failures.work_owed=0 THEN 1 ELSE 0 END,
           updated_at=excluded.updated_at, recovered_at=NULL, recovery=NULL,
           next_action=excluded.next_action, work_owed=1`,
        )
        .run({
          incident_id: incidentId,
          pr: arg.pr,
          command_id: arg.command_id ?? null,
          round_id: arg.round_id ?? null,
          round_no: arg.round_no ?? null,
          head_sha: failureHead,
          stage: arg.stage,
          detail: arg.detail,
          attempts: arg.attempts,
          retry_cap: arg.retry_cap,
          retry_epoch: retryEpoch,
          next_retry_at: nextRetryAt,
          next_action: nextAction,
          ts,
        });
      const row = this.getPr(arg.pr);
      const successor = this.successorFor(arg.pr);
      // A human request already waiting in the queue keeps its identity and FIFO
      // position; only an absent or system one is stamped with the failure's.
      const keepQueuedHuman =
        !successor &&
        row?.state === "queued" &&
        row.trigger_provenance === "human" &&
        row.trigger_ts !== null;
      if (row && row.state !== "closed") {
        this.db
          .prepare(
            `UPDATE pr_state
              SET state='queued', head_sha=?, trigger_ts=?, trigger_provenance=?, updated_at=?
            WHERE number=? AND state!='closed'`,
          )
          .run(
            successor?.head_sha ?? arg.head_sha,
            successor?.requested_at ?? (keepQueuedHuman ? row.trigger_ts : ts),
            successor?.provenance ?? (keepQueuedHuman ? "human" : "system"),
            ts,
            arg.pr,
          );
      }
      return this.db
        .prepare("SELECT * FROM review_failures WHERE incident_id=?")
        .get(incidentId) as ReviewFailureRow;
    })();
    this.logEvent("review_failed_loud", arg.pr, {
      incident_id: failure.incident_id,
      command_id: failure.command_id,
      round_no: failure.round_no,
      stage: failure.stage,
      attempts: failure.attempts,
      retry_cap: failure.retry_cap,
      retry_epoch: failure.retry_epoch,
      next_retry_at: failure.next_retry_at,
      next_action: failure.next_action,
    });
    return failure;
  }

  /** Atomically hand one killed/fenced infrastructure round from active
   * ownership to durable failure debt. No process crash can observe the round
   * cancelled without its exact command failed and obligation opened. */
  terminalizeInfrastructureReviewFailure(input: {
    pr: number;
    round_id: number;
    round_no: number;
    command_id: string;
    head_sha: string;
    stage: string;
    detail: string;
    attempts: number;
    retry_cap: number;
    summary: string;
  }): ReviewFailureRow | undefined {
    const terminalize = this.db.transaction((): ReviewFailureRow | undefined => {
      const round = this.db.prepare("SELECT * FROM rounds WHERE id=?").get(input.round_id) as
        RoundRow | undefined;
      const command = this.getSessionCommand(input.command_id);
      if (
        round?.pr !== input.pr ||
        round.round_no !== input.round_no ||
        round.status !== "running" ||
        command?.pr !== input.pr ||
        command.session !== `pr-${input.pr}` ||
        command.kind !== "round" ||
        command.round_no !== input.round_no ||
        !["pending", "running", "acked", "failed"].includes(command.status)
      )
        return undefined;
      const ts = this.ts();
      const roundChanged = this.db
        .prepare(
          `UPDATE rounds SET status='cancelled', summary=@summary,
            cancel_cause='infrastructure_failure', finished_at=@ts
          WHERE id=@round_id AND pr=@pr AND round_no=@round_no AND status='running'`,
        )
        .run({ ...input, ts }).changes;
      if (roundChanged !== 1) return undefined;
      const commandChanged = this.db
        .prepare(
          `UPDATE session_commands
            SET status='failed', owner_token=NULL, failed_at=COALESCE(failed_at, @ts),
                failure=@detail, updated_at=@ts, next_check_at=@ts
          WHERE id=@command_id AND pr=@pr AND session=@session AND kind='round'
            AND round_no=@round_no AND status IN ('pending','running','acked','failed')`,
        )
        .run({ ...input, session: `pr-${input.pr}`, ts }).changes;
      if (commandChanged !== 1)
        throw new Error(`infrastructure command CAS lost for ${input.command_id}`);
      return this.openReviewFailure({
        pr: input.pr,
        command_id: input.command_id,
        round_id: input.round_id,
        round_no: input.round_no,
        head_sha: input.head_sha,
        stage: input.stage,
        detail: input.detail,
        attempts: input.attempts,
        retry_cap: input.retry_cap,
      });
    });
    return terminalize();
  }

  reviewFailureForCommand(commandId: string): ReviewFailureRow | undefined {
    return this.db
      .prepare("SELECT * FROM review_failures WHERE command_id=? ORDER BY failed_at DESC LIMIT 1")
      .get(commandId) as ReviewFailureRow | undefined;
  }

  openReviewFailures(): ReviewFailureRow[] {
    return this.db
      .prepare("SELECT * FROM review_failures WHERE work_owed=1 ORDER BY failed_at, incident_id")
      .all() as ReviewFailureRow[];
  }

  recentReviewRecoveries(since: string): ReviewFailureRow[] {
    return this.db
      .prepare(
        "SELECT * FROM review_failures WHERE work_owed=0 AND recovered_at IS NOT NULL AND recovered_at>=? ORDER BY recovered_at DESC, incident_id",
      )
      .all(since) as ReviewFailureRow[];
  }

  roundRecoveryInstruction(
    pr: number,
    targetRoundNo: number,
  ): RoundRecoveryInstructionRow | undefined {
    return this.db
      .prepare("SELECT * FROM round_recovery_instructions WHERE pr=? AND target_round_no=?")
      .get(pr, targetRoundNo) as RoundRecoveryInstructionRow | undefined;
  }

  /** Recovery behavior belongs to one exact successor identity. A stale row is
   * immutable history, never permission to alter a later head/round. */
  roundRecoveryInstructionForDispatch(
    pr: number,
    targetRoundNo: number,
    targetHeadSha: string,
  ): RoundRecoveryInstructionRow | undefined {
    const instruction = this.roundRecoveryInstruction(pr, targetRoundNo);
    if (
      !instruction ||
      instruction.target_head_sha !== targetHeadSha ||
      instruction.source_round_no + 1 !== targetRoundNo ||
      instruction.stage !== "first_pass_start"
    )
      return undefined;
    const sourceRound = this.roundsFor(pr).find(
      (round) => round.round_no === instruction.source_round_no,
    );
    const sourceCommand = this.getSessionCommand(instruction.source_command_id);
    if (
      sourceRound?.status !== "cancelled" ||
      sourceCommand?.pr !== pr ||
      sourceCommand.kind !== "round" ||
      sourceCommand.round_no !== instruction.source_round_no ||
      !["failed", "cancelled"].includes(sourceCommand.status)
    )
      return undefined;
    if (instruction.source_incident_id) {
      const failure = this.db
        .prepare("SELECT * FROM review_failures WHERE incident_id=?")
        .get(instruction.source_incident_id) as ReviewFailureRow | undefined;
      if (
        !failure ||
        failure.pr !== pr ||
        failure.command_id !== instruction.source_command_id ||
        failure.round_id !== sourceRound.id ||
        failure.work_owed !== 0
      )
        return undefined;
    }
    return instruction;
  }

  /** Kill-before-replay is followed by one durable transaction: cancel the
   * exact old round, bind optional changed behavior to its immediate successor,
   * and publish ordinary queued work. A crash can see either the live parent or
   * the complete debt, never an inert cancellation. */
  cancelRoundAndQueueRecovery(input: {
    pr: number;
    round_id: number;
    round_no: number;
    summary: string;
    cause: CancelCause;
    fallback_head_sha: string;
    trigger_ts: string;
    recovery?: {
      stage: "first_pass_start";
      source_command_id: string;
      immediate_attempt: number;
      retry_epoch: number;
    };
  }): { target_round_no: number; target_head_sha: string; queued: boolean } | undefined {
    return this.db.transaction(() => {
      const source = this.db.prepare("SELECT * FROM rounds WHERE id=?").get(input.round_id) as
        RoundRow | undefined;
      if (
        source?.pr !== input.pr ||
        source.round_no !== input.round_no ||
        source.status !== "running"
      )
        return undefined;
      const row = this.getPr(input.pr);
      if (!row) throw new Error(`cannot publish recovery for missing PR #${input.pr}`);
      const successor = this.successorFor(input.pr);
      const targetHead = successor?.head_sha ?? input.fallback_head_sha;
      const targetRoundNo = this.nextRoundNo(input.pr);
      const ts = this.ts();
      const cancelled = this.db
        .prepare(
          `UPDATE rounds SET status='cancelled', summary=@summary, cancel_cause=@cause, finished_at=@ts
          WHERE id=@round_id AND pr=@pr AND round_no=@round_no AND status='running'`,
        )
        .run({ ...input, ts }).changes;
      if (cancelled !== 1) return undefined;
      if (input.recovery && row.state !== "closed") {
        this.insertRecoveryInstruction({
          pr: input.pr,
          target_round_no: targetRoundNo,
          target_head_sha: targetHead,
          stage: input.recovery.stage,
          source_incident_id: null,
          source_command_id: input.recovery.source_command_id,
          source_round_no: input.round_no,
          immediate_attempt: input.recovery.immediate_attempt,
          retry_epoch: input.recovery.retry_epoch,
          created_at: ts,
        });
      }
      if (row.state === "closed")
        return { target_round_no: targetRoundNo, target_head_sha: targetHead, queued: false };
      this.db
        .prepare(
          `UPDATE pr_state
            SET state='queued', head_sha=@head_sha, trigger_ts=@trigger_ts,
                trigger_provenance=@provenance, updated_at=@ts
          WHERE number=@pr AND state!='closed'`,
        )
        .run({
          pr: input.pr,
          head_sha: targetHead,
          trigger_ts: successor?.requested_at ?? input.trigger_ts,
          provenance: successor?.provenance ?? row.trigger_provenance,
          ts,
        });
      return { target_round_no: targetRoundNo, target_head_sha: targetHead, queued: true };
    })();
  }

  /** Attach changed behavior to the exact immediate successor before it is
   * dispatched. Historical rows are immutable by identity; an unexpected
   * competing writer is a correctness failure rather than last-write-wins. */
  recordRoundRecoveryInstruction(
    input: Omit<RoundRecoveryInstructionRow, "created_at">,
  ): RoundRecoveryInstructionRow {
    this.insertRecoveryInstruction({ ...input, created_at: this.ts() });
    return this.roundRecoveryInstruction(input.pr, input.target_round_no)!;
  }

  /** The one writer of a recovery-instruction row; callers own the
   * transaction it lands in. A second row for the same target throws. */
  private insertRecoveryInstruction(row: RoundRecoveryInstructionRow): void {
    this.db
      .prepare(
        `INSERT INTO round_recovery_instructions
         (pr, target_round_no, target_head_sha, stage, source_incident_id,
          source_command_id, source_round_no, immediate_attempt, retry_epoch, created_at)
       VALUES (@pr, @target_round_no, @target_head_sha, @stage, @source_incident_id,
          @source_command_id, @source_round_no, @immediate_attempt, @retry_epoch, @created_at)`,
      )
      .run(row);
  }

  /** Put a due automatic retry off by one initial interval without
   * activating it, and say why. Only a failure still waiting on its retry
   * moves. */
  private deferAutoRetry(failure: ReviewFailureRow, at: string, reason: string): void {
    const next = new Date(Date.parse(at) + AUTO_REVIEW_RETRY_INITIAL_MIN * 60_000).toISOString();
    this.db
      .prepare(
        `UPDATE review_failures SET next_retry_at=?, updated_at=?
        WHERE incident_id=? AND work_owed=1 AND next_action='retry_wait'`,
      )
      .run(next, this.ts(), failure.incident_id);
    this.logEvent("review_failure_auto_retry_deferred", failure.pr, {
      incident_id: failure.incident_id,
      reason,
      next_retry_at: next,
    });
  }

  /**
   * Circuit-breaker sweep. The whole due transition is one SQLite
   * transaction: exact debt + failed predecessor command are terminalized,
   * the recovery instruction is bound to the next round number, and ordinary
   * queued work is published. The caller may then invoke the normal dispatch
   * pump; this method itself cannot create a round, a Pi command, or a GitHub
   * mutation.
   *
   * `next_retry_at` is the durable claim: the UPDATE below requires the same
   * incident, generation and due state selected at the top of the transaction.
   * Concurrent sweeps, operator `u`, reconcile and verdict settlement can
   * therefore produce at most one winner.
   */
  activateDueReviewFailureRetries(at: string): AutomaticReviewRetry[] {
    const due = this.db
      .prepare(
        `SELECT incident_id FROM review_failures
        WHERE work_owed=1 AND next_action='retry_wait'
          AND next_retry_at IS NOT NULL AND next_retry_at<=?
        ORDER BY next_retry_at, failed_at, incident_id`,
      )
      .all(at) as Array<{ incident_id: string }>;
    const activated: AutomaticReviewRetry[] = [];

    for (const candidate of due) {
      // A reconciled/webhook `closed` row is already terminal GitHub truth.
      // Reuse the exact terminal-resolution transaction rather than scheduling
      // pointless review work; contradictory ownership/wakes make it refuse and retain
      // the finite retry below.
      const before = this.db
        .prepare("SELECT * FROM review_failures WHERE incident_id=?")
        .get(candidate.incident_id) as ReviewFailureRow | undefined;
      if (before?.command_id && this.getPr(before.pr)?.state === "closed") {
        const terminal = this.resolveTerminalReviewFailure({
          pr: before.pr,
          incident_id: before.incident_id,
          command_id: before.command_id,
          head_sha: before.head_sha,
          disposition: "closed",
        });
        if (terminal.ok) continue;
      }
      const result = this.db.transaction((): AutomaticReviewRetry | undefined => {
        const failure = this.db
          .prepare(
            `SELECT * FROM review_failures
            WHERE incident_id=? AND work_owed=1 AND next_action='retry_wait'
              AND next_retry_at IS NOT NULL AND next_retry_at<=?`,
          )
          .get(candidate.incident_id, at) as ReviewFailureRow | undefined;
        if (
          !failure ||
          failure.stage !== "first_pass_start" ||
          !failure.command_id ||
          failure.round_id === null ||
          failure.round_no === null
        )
          return undefined;

        const pr = this.getPr(failure.pr);
        if (!pr || pr.state === "closed" || pr.paused) {
          // A close is handled by the exact terminal-failure path; a pause is
          // an explicit operator hold. Both retain a finite re-check rather
          // than falling into an actionless state here.
          this.deferAutoRetry(
            failure,
            at,
            !pr
              ? "pr-state-absent"
              : pr.state === "closed"
                ? "terminal-resolution-not-ready"
                : "operator-paused",
          );
          return undefined;
        }
        const command = this.getSessionCommand(failure.command_id);
        const round = this.db.prepare("SELECT * FROM rounds WHERE id=?").get(failure.round_id) as
          RoundRow | undefined;
        const active = this.db
          .prepare(
            "SELECT id FROM session_commands WHERE pr=? AND status IN ('pending','running') LIMIT 1",
          )
          .get(failure.pr) as { id: string } | undefined;
        if (
          command?.pr !== failure.pr ||
          command.session !== `pr-${failure.pr}` ||
          command.kind !== "round" ||
          command.round_no !== failure.round_no ||
          !["failed", "acked", "cancelled"].includes(command.status) ||
          round?.pr !== failure.pr ||
          round.round_no !== failure.round_no ||
          round.status === "running" ||
          this.hasRunningRound(failure.pr) ||
          active
        ) {
          // Contradictory/live ownership is never bulldozed. Keep the exact
          // debt visible and schedule another finite inspection.
          this.deferAutoRetry(
            failure,
            at,
            active
              ? `active-command:${active.id}`
              : this.hasRunningRound(failure.pr)
                ? "running-round"
                : "identity-mismatch",
          );
          return undefined;
        }

        const successor = this.successorFor(failure.pr);
        const targetHead = successor?.head_sha || pr.head_sha || failure.head_sha;
        const targetRoundNo = this.nextRoundNo(failure.pr);
        // A new authoritative head is new work and gets its own fast-retry /
        // backoff generation. The delayed wake still carries the predecessor
        // identity, but old-head failures do not punish the new head's rate.
        const retryEpoch = targetHead === failure.head_sha ? failure.retry_epoch + 1 : 0;
        const triggerTs =
          successor?.requested_at ??
          (pr.trigger_provenance === "human" && pr.trigger_ts ? pr.trigger_ts : this.ts());
        const provenance =
          successor?.provenance ?? (pr.trigger_provenance === "human" ? "human" : "system");

        this.insertRecoveryInstruction({
          pr: failure.pr,
          target_round_no: targetRoundNo,
          target_head_sha: targetHead,
          stage: "first_pass_start",
          source_incident_id: failure.incident_id,
          source_command_id: failure.command_id,
          source_round_no: failure.round_no,
          immediate_attempt: failure.attempts,
          retry_epoch: retryEpoch,
          created_at: this.ts(),
        });
        const commandChanged = this.db
          .prepare(
            `UPDATE session_commands
              SET status='cancelled', owner_token=NULL,
                  settled_at=COALESCE(settled_at, @ts), updated_at=@ts,
                  next_check_at=@ts,
                  failure=CASE WHEN failure IS NULL OR failure='' THEN @reason ELSE failure || '; ' || @reason END
            WHERE id=@id AND pr=@pr AND session=@session AND kind='round'
              AND round_no=@round_no AND status IN ('failed','acked','cancelled')`,
          )
          .run({
            id: failure.command_id,
            pr: failure.pr,
            session: `pr-${failure.pr}`,
            round_no: failure.round_no,
            ts: this.ts(),
            reason: `automatic pre-fanout retry epoch ${retryEpoch}`,
          }).changes;
        if (commandChanged !== 1)
          throw new Error(`automatic retry command CAS lost for ${failure.command_id}`);
        const failureChanged = this.db
          .prepare(
            `UPDATE review_failures
              SET work_owed=0, recovered_at=@ts, recovery=@recovery,
                  next_action='closed', next_retry_at=NULL, updated_at=@ts
            WHERE incident_id=@incident_id AND work_owed=1
              AND next_action='retry_wait' AND retry_epoch=@expected_epoch
              AND next_retry_at IS NOT NULL AND next_retry_at<=@at`,
          )
          .run({
            incident_id: failure.incident_id,
            expected_epoch: failure.retry_epoch,
            at,
            ts: this.ts(),
            recovery: `automatic-retry:${retryEpoch}`,
          }).changes;
        if (failureChanged !== 1)
          throw new Error(`automatic retry failure CAS lost for ${failure.incident_id}`);
        // The pause test must be the one `getPr` answered above
        // (`withLivePause`): a session pause past its expiry no longer binds
        // even while the column still reads 1 because the lever sweep has
        // not run yet. Reading the raw column alone would lose the CAS and throw.
        const prChanged = this.db
          .prepare(
            `UPDATE pr_state
              SET state='queued', head_sha=@head, trigger_ts=@trigger,
                  trigger_provenance=@provenance, updated_at=@ts
            WHERE number=@pr AND state!='closed'
              AND (paused=0 OR (pause_issuer IS NOT NULL
                AND pause_expires_at IS NOT NULL AND pause_expires_at<=@ts))`,
          )
          .run({
            pr: failure.pr,
            head: targetHead,
            trigger: triggerTs,
            provenance,
            ts: this.ts(),
          }).changes;
        if (prChanged !== 1)
          throw new Error(`automatic retry PR-state CAS lost for #${failure.pr}`);
        return {
          pr: failure.pr,
          incident_id: failure.incident_id,
          target_head_sha: targetHead,
          target_round_no: targetRoundNo,
          retry_epoch: retryEpoch,
        };
      })();
      if (!result) continue;
      activated.push(result);
      this.logEvent("review_failure_auto_retry_queued", result.pr, result);
      this.logEvent("review_failure_recovered", result.pr, {
        incident_id: result.incident_id,
        recovery: `automatic-retry:${result.retry_epoch}`,
      });
    }
    return activated;
  }

  /**
   * Retire a posting-receipt failure whose target head already has the review
   * guard 2 says must not be posted again. This is not a general recovery: the
   * exact failed round, command, debt and substantive standing mark must all
   * agree, with no author evidence since the mark. The ordinary recovery path
   * remains authoritative for every other shape.
   */
  resolveExactHeadReviewedFailure(input: {
    pr: number;
    incident_id: string;
    command_id: string;
    round_id: number;
    round_no: number;
    head_sha: string;
  }): ExactHeadReviewedFailureResolution {
    const recovery = "exact-head-already-reviewed";
    return this.db.transaction((): ExactHeadReviewedFailureResolution => {
      const current = this.openReviewFailure(input.pr);
      if (!current) {
        const prior = this.db
          .prepare("SELECT * FROM review_failures WHERE incident_id=?")
          .get(input.incident_id) as ReviewFailureRow | undefined;
        const command = this.getSessionCommand(input.command_id);
        const mark = this.reviewedHead(input.pr);
        const standingVerdict = standingReviewVerdict(mark);
        if (
          prior?.pr === input.pr &&
          prior.command_id === input.command_id &&
          prior.round_id === input.round_id &&
          prior.round_no === input.round_no &&
          prior.head_sha === input.head_sha &&
          prior.work_owed === 0 &&
          prior.recovery === recovery &&
          (command?.status === "cancelled" || command?.status === "acked") &&
          mark?.head_sha === input.head_sha &&
          standingVerdict !== null
        ) {
          return {
            kind: "resolved",
            incident_id: input.incident_id,
            command_id: input.command_id,
            restored_state: standingLifecycleState(standingVerdict),
            standing_verdict: standingVerdict,
            already_resolved: true,
          };
        }
        return { kind: "blocked", reason: `review failure identity changed for PR #${input.pr}` };
      }
      if (current.stage !== "posting_receipt") return { kind: "not_applicable" };
      if (
        current.incident_id !== input.incident_id ||
        current.command_id !== input.command_id ||
        current.round_id !== input.round_id ||
        current.round_no !== input.round_no ||
        current.head_sha !== input.head_sha
      )
        return {
          kind: "blocked",
          reason: `open review failure identity changed for PR #${input.pr}`,
        };

      const mark = this.reviewedHead(input.pr);
      const standingVerdict = standingReviewVerdict(mark);
      if (
        !mark ||
        mark.head_sha !== input.head_sha ||
        standingVerdict === null ||
        (mark.last_author_reply_at !== null && mark.last_author_reply_at >= mark.reviewed_at)
      )
        return { kind: "not_applicable" };

      const pr = this.getPr(input.pr);
      if (!pr || pr.state === "closed" || pr.head_sha !== input.head_sha) {
        return {
          kind: "blocked",
          reason: `PR #${input.pr} local head/state changed during exact-head recovery`,
        };
      }
      // A fresh explicit trigger is new work even on an unchanged head. Fall
      // through to ordinary recovery, which preserves this human-owned queue
      // identity, rather than clearing it as obsolete receipt debt.
      if (pr.trigger_provenance === "human") return { kind: "not_applicable" };
      if (this.hasRunningRound(input.pr))
        return { kind: "blocked", reason: `PR #${input.pr} still has a running round` };
      const active = this.db
        .prepare(
          "SELECT * FROM session_commands WHERE pr=? AND status IN ('pending','running') ORDER BY created_at, id LIMIT 1",
        )
        .get(input.pr) as SessionCommandRow | undefined;
      if (active)
        return {
          kind: "blocked",
          reason: `PR #${input.pr} still has active command ${active.id} (${active.status})`,
        };
      // A held wake or successor is genuine new work. Do not consume it here;
      // hand the caller back to ordinary recovery, which preserves/promotes it.
      if (this.heldWakes(input.pr).length > 0 || this.successorFor(input.pr))
        return { kind: "not_applicable" };

      const command = this.getSessionCommand(input.command_id);
      const round = this.db.prepare("SELECT * FROM rounds WHERE id=?").get(input.round_id) as
        RoundRow | undefined;
      if (
        !command ||
        command.pr !== input.pr ||
        command.session !== `pr-${input.pr}` ||
        command.kind !== "round" ||
        command.round_no !== input.round_no ||
        (command.status !== "acked" && command.status !== "failed") ||
        !round ||
        round.pr !== input.pr ||
        round.round_no !== input.round_no ||
        round.status !== "cancelled" ||
        round.verdict !== null
      )
        return {
          kind: "blocked",
          reason: `failed command/round identity changed for ${input.command_id}`,
        };
      const otherFailed = this.otherBlockingCommandForPr(input.pr, input.command_id);
      if (otherFailed)
        return {
          kind: "blocked",
          reason: `PR #${input.pr} still has blocking command ${otherFailed.id}`,
        };

      const ts = this.ts();
      const commandStatus = command.status;
      const commandChanged =
        commandStatus === "failed"
          ? this.db
              .prepare(
                `UPDATE session_commands
              SET status='cancelled', owner_token=NULL, settled_at=COALESCE(settled_at, @ts),
                  updated_at=@ts, next_check_at=@ts,
                  failure=CASE WHEN failure IS NULL OR failure='' THEN @reason ELSE failure || '; ' || @reason END
            WHERE id=@command_id AND pr=@pr AND session=@session AND kind='round'
              AND round_no=@round_no AND status='failed'`,
              )
              .run({
                ...input,
                session: `pr-${input.pr}`,
                ts,
                reason: `operator resolved ${recovery} review debt`,
              }).changes
          : // An acked command proves successful prompt delivery, not failed work.
            // Keep it acked; a no-op CAS still fences its exact terminal identity
            // in the transaction which closes only the posting-receipt debt.
            this.db
              .prepare(
                `UPDATE session_commands SET status='acked'
            WHERE id=@command_id AND pr=@pr AND session=@session AND kind='round'
              AND round_no=@round_no AND status='acked'`,
              )
              .run({ ...input, session: `pr-${input.pr}` }).changes;
      if (commandChanged !== 1)
        throw new Error(`exact-head command CAS lost for ${input.command_id}`);

      const failureChanged = this.db
        .prepare(
          `UPDATE review_failures
            SET work_owed=0, recovered_at=@ts, recovery=@recovery,
                next_action='closed', next_retry_at=NULL, updated_at=@ts
          WHERE incident_id=@incident_id AND pr=@pr AND command_id=@command_id
            AND round_id=@round_id AND round_no=@round_no AND head_sha=@head_sha
            AND stage='posting_receipt' AND work_owed=1`,
        )
        .run({ ...input, recovery, ts }).changes;
      if (failureChanged !== 1)
        throw new Error(`exact-head failure CAS lost for ${input.incident_id}`);

      const restoredState = standingLifecycleState(standingVerdict);
      const prChanged = this.db
        .prepare(
          `UPDATE pr_state
            SET state=@state, trigger_ts=NULL, trigger_provenance=NULL, updated_at=@ts
          WHERE number=@pr AND head_sha=@head_sha AND state!='closed'`,
        )
        .run({ pr: input.pr, head_sha: input.head_sha, state: restoredState, ts }).changes;
      if (prChanged !== 1) throw new Error(`exact-head PR-state CAS lost for #${input.pr}`);

      this.logEvent("review_failure_recovered", input.pr, {
        incident_id: input.incident_id,
        recovery,
      });
      this.logEvent("exact_head_review_failure_retired", input.pr, {
        incident_id: input.incident_id,
        command_id: input.command_id,
        round_id: input.round_id,
        round_no: input.round_no,
        head_sha: input.head_sha,
        standing_verdict: standingVerdict,
        standing_round_no: mark.round_no,
        posted_event: mark.posted_event,
        command_status: commandStatus,
        restored_state: restoredState,
      });
      return {
        kind: "resolved",
        incident_id: input.incident_id,
        command_id: input.command_id,
        restored_state: restoredState,
        standing_verdict: standingVerdict,
        already_resolved: false,
      };
    })();
  }

  /**
   * Resolve debt which authoritative GitHub truth has already made terminal.
   * This is deliberately narrower than operator recovery: it never republishes
   * work. The exact failed command and failure row terminalize together, or
   * neither changes. Contradictory live ownership refuses rather than guessing.
   */
  resolveTerminalReviewFailure(input: {
    pr: number;
    incident_id: string;
    command_id: string;
    head_sha: string;
    disposition: TerminalReviewFailureDisposition;
  }): TerminalReviewFailureResolution {
    const recovery = `terminal-${input.disposition}`;
    const resolved = this.db.transaction((): TerminalReviewFailureResolution => {
      const current = this.openReviewFailure(input.pr);
      if (!current) {
        const prior = this.db
          .prepare("SELECT * FROM review_failures WHERE incident_id=?")
          .get(input.incident_id) as ReviewFailureRow | undefined;
        const command = this.getSessionCommand(input.command_id);
        if (
          prior?.pr === input.pr &&
          prior.command_id === input.command_id &&
          prior.head_sha === input.head_sha &&
          prior.work_owed === 0 &&
          prior.recovery === recovery &&
          command?.pr === input.pr &&
          command.session === `pr-${input.pr}` &&
          (command.status === "cancelled" ||
            (command.status === "acked" && command.kind === "round"))
        ) {
          return {
            ok: true,
            disposition: input.disposition,
            incident_id: input.incident_id,
            command_id: input.command_id,
            command_status: command.status,
            already_resolved: true,
          };
        }
        return { ok: false, reason: `no matching open review failure for PR #${input.pr}` };
      }
      if (
        current.incident_id !== input.incident_id ||
        current.command_id !== input.command_id ||
        current.head_sha !== input.head_sha
      ) {
        return { ok: false, reason: `open review failure identity changed for PR #${input.pr}` };
      }

      const pr = this.getPr(input.pr);
      if (input.disposition === "closed" && pr?.state !== "closed") {
        return { ok: false, reason: `local PR #${input.pr} is not closed` };
      }
      if (input.disposition === "absent" && pr !== undefined) {
        return { ok: false, reason: `absent PR #${input.pr} still has local state ${pr.state}` };
      }
      if (this.hasRunningRound(input.pr))
        return { ok: false, reason: `PR #${input.pr} still has a running round` };
      // Query by PR, not only by the canonical session spelling: malformed or
      // legacy rows must not become an invisible concurrent owner.
      const active = this.db
        .prepare(
          "SELECT * FROM session_commands WHERE pr=? AND status IN ('pending','running') ORDER BY created_at, id LIMIT 1",
        )
        .get(input.pr) as SessionCommandRow | undefined;
      if (active)
        return {
          ok: false,
          reason: `PR #${input.pr} still has active command ${active.id} (${active.status})`,
        };
      const wakes = this.heldWakes(input.pr);
      if (wakes.length > 0)
        return { ok: false, reason: `PR #${input.pr} still has ${wakes.length} held wake(s)` };
      if (this.successorFor(input.pr))
        return { ok: false, reason: `PR #${input.pr} still has a successor obligation` };

      const command = this.getSessionCommand(input.command_id);
      if (
        !command ||
        command.pr !== input.pr ||
        command.session !== `pr-${input.pr}` ||
        (command.status !== "failed" &&
          !(
            command.status === "acked" &&
            command.kind === "round" &&
            current.stage === "posting_receipt"
          )) ||
        command.round_no !== current.round_no
      ) {
        return { ok: false, reason: `failed command identity changed for ${input.command_id}` };
      }
      if (command.kind === "round" || current.round_id !== null || current.round_no !== null) {
        if (command.kind !== "round" || current.round_id === null || current.round_no === null) {
          return {
            ok: false,
            reason: `failed command/failure round identity is incomplete for ${input.command_id}`,
          };
        }
        const round = this.db.prepare("SELECT * FROM rounds WHERE id=?").get(current.round_id) as
          RoundRow | undefined;
        if (
          !round ||
          round.pr !== input.pr ||
          round.round_no !== current.round_no ||
          round.round_no !== command.round_no
        ) {
          return {
            ok: false,
            reason: `failed command/failure round identity changed for ${input.command_id}`,
          };
        }
        if (round.status === "running")
          return {
            ok: false,
            reason: `PR #${input.pr} linked round ${round.round_no} is still running`,
          };
      }
      const otherBlocker = this.otherBlockingCommandForPr(input.pr, input.command_id);
      if (otherBlocker)
        return {
          ok: false,
          reason: `PR #${input.pr} still has blocking command ${otherBlocker.id}`,
        };

      const ts = this.ts();
      const commandChanged =
        command.status === "failed"
          ? this.db
              .prepare(
                `UPDATE session_commands
            SET status='cancelled', owner_token=NULL, settled_at=COALESCE(settled_at, @ts),
                updated_at=@ts, next_check_at=@ts,
                failure=CASE WHEN failure IS NULL OR failure='' THEN @reason ELSE failure || '; ' || @reason END
          WHERE id=@command_id AND pr=@pr AND session=@session AND status='failed'`,
              )
              .run({
                command_id: input.command_id,
                pr: input.pr,
                session: `pr-${input.pr}`,
                ts,
                reason: `operator resolved ${recovery} review debt`,
              }).changes
          : this.db
              .prepare(
                `UPDATE session_commands SET status='acked'
         WHERE id=@command_id AND pr=@pr AND session=@session AND kind='round'
           AND round_no=@round_no AND status='acked'`,
              )
              .run({
                command_id: input.command_id,
                pr: input.pr,
                session: `pr-${input.pr}`,
                round_no: current.round_no,
              }).changes;
      const commandStatus = command.status === "acked" ? "acked" : "cancelled";
      if (commandChanged !== 1)
        throw new Error(`terminal debt command CAS lost for ${input.command_id}`);

      const failureChanged = this.db
        .prepare(
          `UPDATE review_failures
            SET work_owed=0, recovered_at=@ts, recovery=@recovery,
                next_action='closed', next_retry_at=NULL, updated_at=@ts
          WHERE incident_id=@incident_id AND pr=@pr AND command_id=@command_id
            AND head_sha=@head_sha AND work_owed=1`,
        )
        .run({ ...input, recovery, ts }).changes;
      if (failureChanged !== 1)
        throw new Error(`terminal debt failure CAS lost for ${input.incident_id}`);
      // Audit and state transition are one SQLite commit. There is no window
      // where debt is gone but its exact terminal proof is unrecorded.
      this.logEvent("review_failure_recovered", input.pr, {
        incident_id: input.incident_id,
        recovery,
      });
      this.logEvent("terminal_review_failure_resolved", input.pr, {
        incident_id: input.incident_id,
        command_id: input.command_id,
        head_sha: input.head_sha,
        disposition: input.disposition,
        command_status: commandStatus,
      });
      return {
        ok: true,
        disposition: input.disposition,
        incident_id: input.incident_id,
        command_id: input.command_id,
        command_status: commandStatus,
        already_resolved: false,
      };
    })();
    return resolved;
  }

  recoverReviewFailure(
    pr: number,
    recovery: string,
    match?: { incident_id?: string; round_no?: number; head_sha?: string },
  ): ReviewFailureRow | undefined {
    const ts = this.ts();
    const current = this.openReviewFailure(pr);
    if (
      !current ||
      (match?.incident_id !== undefined && current.incident_id !== match.incident_id) ||
      (match?.round_no !== undefined && current.round_no !== match.round_no) ||
      (match?.head_sha !== undefined && current.head_sha !== match.head_sha)
    )
      return undefined;
    const recovered = this.db.transaction((): ReviewFailureRow | undefined => {
      const changed = this.db
        .prepare(
          `UPDATE review_failures
            SET work_owed=0, recovered_at=?, recovery=?, next_action='closed', next_retry_at=NULL, updated_at=?
          WHERE incident_id=? AND work_owed=1`,
        )
        .run(ts, recovery, ts, current.incident_id).changes;
      if (changed !== 1) return undefined;
      // Recovery and durable work publication are one commit. A process crash
      // after this point may delay the pump, but cannot forget what u asked for.
      const row = this.getPr(pr);
      const successor = this.successorFor(pr);
      // The newest known head owes the review: a successor, else the PR's
      // own head (a push seen while it sat queued records no successor),
      // else the failed round's.
      const targetHead = successor?.head_sha || row?.head_sha || current.head_sha;
      const command = current.command_id ? this.getSessionCommand(current.command_id) : undefined;
      const round =
        current.round_id === null
          ? undefined
          : (this.db.prepare("SELECT * FROM rounds WHERE id=?").get(current.round_id) as
              RoundRow | undefined);
      if (
        row &&
        row.state !== "closed" &&
        current.stage === "first_pass_start" &&
        current.command_id &&
        current.round_no !== null &&
        command?.pr === pr &&
        command.kind === "round" &&
        command.round_no === current.round_no &&
        round?.pr === pr &&
        round.round_no === current.round_no &&
        round.status !== "running"
      ) {
        const targetRoundNo = this.nextRoundNo(pr);
        this.insertRecoveryInstruction({
          pr,
          target_round_no: targetRoundNo,
          target_head_sha: targetHead,
          stage: "first_pass_start",
          source_incident_id: current.incident_id,
          source_command_id: current.command_id,
          source_round_no: current.round_no,
          immediate_attempt: current.attempts,
          retry_epoch: targetHead === current.head_sha ? current.retry_epoch : 0,
          created_at: ts,
        });
      }
      if (row && row.state !== "closed") {
        this.db
          .prepare(
            `UPDATE pr_state
              SET state='queued', head_sha=?, trigger_ts=COALESCE(trigger_ts, ?),
                  trigger_provenance=COALESCE(trigger_provenance, ?), updated_at=?
            WHERE number=? AND state!='closed'`,
          )
          .run(
            targetHead,
            successor?.requested_at ?? ts,
            successor?.provenance ?? "system",
            ts,
            pr,
          );
      }
      return this.db
        .prepare("SELECT * FROM review_failures WHERE incident_id=?")
        .get(current.incident_id) as ReviewFailureRow;
    })();
    if (!recovered) return undefined;
    this.logEvent("review_failure_recovered", pr, { incident_id: current.incident_id, recovery });
    return recovered;
  }

  // ---- durable fresh-head successor ------------------------------------

  successorFor(pr: number): SuccessorObligationRow | undefined {
    return this.db.prepare("SELECT * FROM successor_obligations WHERE pr = ?").get(pr) as
      SuccessorObligationRow | undefined;
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
    this.db
      .prepare(
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
      )
      .run({ ...input, ts });
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
      if (!successor || !row || row.state === "closed" || row.paused || this.hasRunningRound(pr))
        return undefined;
      if (
        row.state === "queued" &&
        row.head_sha === successor.head_sha &&
        row.trigger_ts === successor.requested_at &&
        row.trigger_provenance === successor.provenance
      )
        return undefined;
      this.db
        .prepare(
          `UPDATE pr_state
            SET state='queued', head_sha=?, trigger_ts=?, trigger_provenance=?, updated_at=?
          WHERE number=? AND state!='closed'`,
        )
        .run(successor.head_sha, successor.requested_at, successor.provenance, this.ts(), pr);
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
    const changed =
      this.db
        .prepare("DELETE FROM successor_obligations WHERE pr=? AND head_sha=?")
        .run(pr, reviewedHead).changes === 1;
    if (changed) this.logEvent("successor_settled", pr, { head_sha: reviewedHead });
    return changed;
  }

  clearSuccessor(pr: number, reason: string): boolean {
    const successor = this.successorFor(pr);
    if (!successor) return false;
    const changed =
      this.db.prepare("DELETE FROM successor_obligations WHERE pr=?").run(pr).changes === 1;
    if (changed) this.logEvent("successor_cleared", pr, { head_sha: successor.head_sha, reason });
    return changed;
  }

  // ---- trigger-level observations --------------------------------------

  triggerLevel(pr: number, kind: "label" | "team_request"): boolean | undefined {
    const row = this.db
      .prepare("SELECT present FROM trigger_levels WHERE pr = ? AND kind = ?")
      .get(pr, kind) as { present: number } | undefined;
    return row === undefined ? undefined : row.present === 1;
  }

  observeTriggerLevel(pr: number, kind: "label" | "team_request", present: boolean): void {
    this.db
      .transaction(() => {
        if (present && this.triggerLevel(pr, kind) === false && this.getPr(pr)?.state !== "closed")
          this.db
            .prepare("INSERT OR IGNORE INTO trigger_edges (pr,kind,requested_at) VALUES (?,?,?)")
            .run(pr, kind, this.ts());
        this.db
          .prepare(
            `INSERT INTO trigger_levels (pr, kind, present, observed_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(pr, kind) DO UPDATE SET present=excluded.present, observed_at=excluded.observed_at`,
          )
          .run(pr, kind, present ? 1 : 0, this.ts());
      })
      .immediate();
  }

  triggerEdgePending(pr: number, kind: "label" | "team_request"): boolean {
    return (
      this.db.prepare("SELECT 1 FROM trigger_edges WHERE pr=? AND kind=?").get(pr, kind) !==
      undefined
    );
  }

  acknowledgeTriggerEdges(pr: number): void {
    this.db.prepare("DELETE FROM trigger_edges WHERE pr=?").run(pr);
  }

  // ---- post-approval delta rechecks -------------------------------------

  /**
   * Claim one recheck nudge. Returns false when this PR has already been
   * nudged for this fingerprint (trigger + head + evidence) — the guard that
   * keeps a re-delivered trigger from re-asking a question already asked.
   */
  claimRecheck(
    pr: number,
    fingerprint: string,
    mark: {
      head_sha: string;
      trigger: string;
      reason?: string;
      /** False for a claim that answers the question WITHOUT a wake (a
       * trivial-delta no-op, a dispatch short-circuit): it carries no receipt
       * token, so the undelivered sweep never reads it. Default true. */
      nudge?: boolean;
      delivery?: { payload: string; reason: string };
    },
  ): boolean {
    return this.db.transaction(() => {
      const info = this.db
        .prepare(
          `INSERT OR IGNORE INTO rechecks (pr, fingerprint, head_sha, trigger, reason, created_at, nudged)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          pr,
          fingerprint,
          mark.head_sha,
          mark.trigger,
          mark.reason ?? null,
          this.ts(),
          mark.nudge === false ? 0 : 1,
        );
      if (info.changes === 1 && mark.delivery)
        this.retainRecheckDelivery(pr, fingerprint, mark.delivery.payload, mark.delivery.reason);
      return info.changes === 1;
    })();
  }

  /** Keep the exact question independently of its capped active wake. */
  retainRecheckDelivery(pr: number, fingerprint: string, payload: string, reason: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO recheck_deliveries (pr,fingerprint,payload,reason)
      SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM rechecks WHERE pr=? AND fingerprint=?)`,
      )
      .run(pr, fingerprint, payload, reason, pr, fingerprint);
  }

  recheckDelivery(pr: number, fingerprint: string): { payload: string; reason: string } | null {
    return (
      (this.db
        .prepare("SELECT payload,reason FROM recheck_deliveries WHERE pr=? AND fingerprint=?")
        .get(pr, fingerprint) as { payload: string; reason: string } | undefined) ?? null
    );
  }

  /** Has this exact recheck question already been claimed? */
  hasRecheck(pr: number, fingerprint: string): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM rechecks WHERE pr = ? AND fingerprint = ?")
        .get(pr, fingerprint) !== undefined
    );
  }

  /** Release a claimed recheck whose delivery failed — the claim must not
   * outlive a nudge that never reached the session, or the head's only
   * recheck is spent on nothing. */
  releaseRecheck(pr: number, fingerprint: string): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM rechecks WHERE pr = ? AND fingerprint = ?").run(pr, fingerprint);
      this.db
        .prepare("DELETE FROM recheck_deliveries WHERE pr=? AND fingerprint=?")
        .run(pr, fingerprint);
    })();
  }

  /** The receipt guard's read (docs/archiving.md §8.1): the PR's
   * archive row — its state and the newest original mtime among the
   * transcripts the archiver moved — or null when the PR was never archived.
   * One primary-key read; `sessions.wakeReceiptPresent` turns a live `false`
   * into UNKNOWN while an unrestored archive could hold the marker. */
  archiveScope(pr: number): { state: string; max_mtime_ms: number | null } | null {
    return (
      (this.db.prepare("SELECT state, max_mtime_ms FROM archive_prs WHERE pr = ?").get(pr) as
        { state: string; max_mtime_ms: number | null } | undefined) ?? null
    );
  }

  /** The recheck claims the undelivered-nudge sweep must still ask about:
   * a claim whose nudge never landed suppresses the reconcile
   * push-backstop forever, and unlike a round there is no deadline underneath
   * a recheck to catch that.
   *
   * Only claims that can still be that: older than
   * `olderThanIso` (the grace), a real nudge (`nudged` — a no-op claim never
   * carried a token), whose receipt has not already been found (`receipt_at`
   * — a delivered nudge stays delivered), on a PR that is not closed (the
   * backstop never reads a closed PR; once reconcile reopens one, its claims
   * are swept again). Least recently asked first, then oldest. */
  recheckClaimsAwaitingReceipt(olderThanIso: string): Array<{
    pr: number;
    fingerprint: string;
    head_sha: string;
    trigger: string;
    created_at: string;
  }> {
    return this.db
      .prepare(
        `SELECT r.pr, r.fingerprint, r.head_sha, r.trigger, r.created_at
           FROM rechecks r LEFT JOIN pr_state p ON p.number = r.pr
          WHERE r.created_at < ? AND r.nudged = 1 AND r.receipt_at IS NULL
            AND (p.state IS NULL OR p.state != 'closed')
          ORDER BY r.receipt_checked_at IS NOT NULL, r.receipt_checked_at, r.created_at, r.pr, r.fingerprint`,
      )
      .all(olderThanIso) as Array<{
      pr: number;
      fingerprint: string;
      head_sha: string;
      trigger: string;
      created_at: string;
    }>;
  }

  /** The sweep found this claim's receipt token: delivered, never asked again. */
  markRecheckReceipt(pr: number, fingerprint: string): void {
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE rechecks SET receipt_at=? WHERE pr=? AND fingerprint=?")
        .run(this.ts(), pr, fingerprint);
      this.db
        .prepare("DELETE FROM recheck_deliveries WHERE pr=? AND fingerprint=?")
        .run(pr, fingerprint);
    })();
  }

  /** The sweep asked about this claim and could not decide (no evidence
   * either way, or a nudge still held): it goes to the back of the queue. */
  markRecheckReceiptChecked(pr: number, fingerprint: string): void {
    this.db
      .prepare("UPDATE rechecks SET receipt_checked_at = ? WHERE pr = ? AND fingerprint = ?")
      .run(this.ts(), pr, fingerprint);
  }

  /** Every recheck claim for a PR, oldest first (TUI/audit) — the nudges
   * sent and the claims answered without one (`nudged = 0`). */
  rechecksFor(pr: number): RecheckClaimRow[] {
    return this.db
      .prepare("SELECT * FROM rechecks WHERE pr = ? ORDER BY created_at")
      .all(pr) as RecheckClaimRow[];
  }

  // ---- webhook delivery dedupe ------------------------------------------

  /** Returns false when the guid was already seen (duplicate delivery). */
  recordDelivery(guid: string, event: string, action: string | null): boolean {
    const info = this.db
      .prepare(
        "INSERT OR IGNORE INTO deliveries (guid, event, action, received_at) VALUES (?, ?, ?, ?)",
      )
      .run(guid, event, action, this.ts());
    return info.changes === 1;
  }

  /** Acceptance and its replay payload commit together. Legacy GUIDs remain consumed. */
  acceptWebhookDelivery(
    guid: string,
    event: string,
    action: string | null,
    payload: string,
  ): boolean {
    return this.db
      .transaction(() => {
        if (this.webhookInbox(guid) || !this.recordDelivery(guid, event, action)) return false;
        this.db
          .prepare(
            "INSERT INTO webhook_inbox (guid,event,action,payload,received_at) VALUES (?,?,?,?,?)",
          )
          .run(guid, event, action, payload, this.ts());
        return true;
      })
      .immediate();
  }

  webhookInbox(guid: string): WebhookInboxRow | undefined {
    return this.db.prepare("SELECT * FROM webhook_inbox WHERE guid=?").get(guid) as
      WebhookInboxRow | undefined;
  }

  readyWebhookInbox(now: string, limit = 20): WebhookInboxRow[] {
    return this.db
      .prepare(
        "SELECT * FROM webhook_inbox WHERE next_attempt_at IS NULL OR next_attempt_at<=? ORDER BY COALESCE(attempted_at,''),received_at,guid LIMIT ?",
      )
      .all(now, limit) as WebhookInboxRow[];
  }

  prepareWebhookInbox(guid: string, interpretation: string): void {
    this.db
      .prepare("UPDATE webhook_inbox SET interpretation=? WHERE guid=?")
      .run(interpretation, guid);
  }

  webhookLocalOnce<T>(guid: string | undefined, run: () => T): T {
    if (!guid) return this.db.transaction(run).immediate();
    return this.db
      .transaction(() => {
        const row = this.webhookInbox(guid);
        if (!row) throw new Error("webhook delivery has no durable inbox receipt");
        if (row.local_result !== null) return (JSON.parse(row.local_result) as { value: T }).value;
        const value = run();
        this.db
          .prepare("UPDATE webhook_inbox SET local_result=? WHERE guid=?")
          .run(JSON.stringify({ value }), guid);
        return value;
      })
      .immediate();
  }

  deferWebhookDelivery(guid: string, error: string, now: number): void {
    this.db
      .prepare(
        "UPDATE webhook_inbox SET attempted_at=?,next_attempt_at=?,last_error=? WHERE guid=?",
      )
      .run(new Date(now).toISOString(), new Date(now + 30_000).toISOString(), error, guid);
  }

  completeWebhookDelivery(guid: string): void {
    this.db.prepare("DELETE FROM webhook_inbox WHERE guid=?").run(guid);
  }

  // ---- feedback signals ---------------------------------------------------

  /** Record one feedback signal; false when its natural key already exists
   * (webhook redelivery, reconcile overlap). */
  recordFeedbackSignal(sig: FeedbackSignalInput): boolean {
    return this.recordFeedbackSignalRow(sig) !== null;
  }

  /** Record one feedback signal and return its row, or null when its natural
   * key already exists. A new row starts `pending` in memory unless the
   * caller says memory is off (`skipped`). */
  recordFeedbackSignalRow(sig: FeedbackSignalInput): FeedbackSignalRow | null {
    const memoryState: FeedbackMemoryState = sig.memory_state ?? "pending";
    const now = this.ts();
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO feedback_signals
           (kind, pr, comment_id, review_id, in_reply_to_id, scope, author, body, day, created_at,
            memory_state, memory_last_error, memory_owed_since)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        now,
        memoryState,
        sig.memory_note ?? null,
        memoryState === "pending" ? now : null,
      );
    if (info.changes === 0) return null;
    return this.feedbackSignal(Number(info.lastInsertRowid));
  }

  /** One feedback row by id, or null. */
  feedbackSignal(id: number): FeedbackSignalRow | null {
    const row = this.db.prepare("SELECT * FROM feedback_signals WHERE id = ?").get(id) as
      FeedbackSignalRow | undefined;
    return row ?? null;
  }

  /** The rows memory still owes, oldest first (the backfill pump's queue);
   * with `createdSince`, only rows created at or after it. */
  pendingFeedbackMemory(limit: number, createdSince?: string): FeedbackSignalRow[] {
    return this.db
      .prepare(
        `SELECT * FROM feedback_signals WHERE memory_state = 'pending' AND created_at >= ?
          ORDER BY created_at, id LIMIT ?`,
      )
      .all(createdSince ?? "", Math.max(0, Math.floor(limit))) as FeedbackSignalRow[];
  }

  /** Record one memory-write outcome on a feedback row. `attempted` counts
   * the attempt. Only a `pending` row moves — a written, failed or skipped
   * row is final, so a late answer from an earlier attempt cannot undo it. */
  markFeedbackMemory(
    id: number,
    outcome: {
      state: FeedbackMemoryState;
      uri?: string | null;
      error?: string | null;
      attempted?: boolean;
    },
  ): boolean {
    const info = this.db
      .prepare(
        `UPDATE feedback_signals
            SET memory_state = ?,
                memory_uri = COALESCE(?, memory_uri),
                memory_last_error = ?,
                memory_attempts = memory_attempts + ?
          WHERE id = ? AND memory_state = 'pending'`,
      )
      .run(
        outcome.state,
        outcome.uri ?? null,
        outcome.error ?? null,
        outcome.attempted === false ? 0 : 1,
        id,
      );
    return info.changes > 0;
  }

  /** What memory still owes the feedback ledger. */
  feedbackMemoryBacklog(): FeedbackMemoryBacklog {
    const counts = this.db
      .prepare(
        `SELECT SUM(memory_state = 'pending') AS pending, SUM(memory_state = 'failed') AS failed
           FROM feedback_signals`,
      )
      .get() as { pending: number | null; failed: number | null };
    const oldest =
      (this.db
        .prepare(
          `SELECT * FROM feedback_signals WHERE memory_state = 'pending'
            ORDER BY COALESCE(memory_owed_since, created_at), id LIMIT 1`,
        )
        .get() as FeedbackSignalRow | undefined) ?? null;
    return {
      pending: counts.pending ?? 0,
      failed: counts.failed ?? 0,
      oldest_pending_at: oldest ? (oldest.memory_owed_since ?? oldest.created_at) : null,
      oldest_pending: oldest,
    };
  }

  /**
   * Put every row the pump gave up on back in the queue:
   * `failed` → `pending`, its attempts reset and its owed-since set to now,
   * its last error kept. `failed` means "memory refused it N times while it
   * read healthy" — a cause a deploy or an operator can fix — so it is never
   * a permanent exclusion; the pump calls this on its first healthy tick
   * after a start and once a day. Returns how many rows moved.
   */
  requeueFailedFeedbackMemory(): number {
    const at = this.ts();
    const ids = (
      this.db
        .prepare("SELECT id FROM feedback_signals WHERE memory_state = 'failed'")
        .all() as Array<{
        id: number;
      }>
    ).map((r) => r.id);
    if (ids.length === 0) return 0;
    const info = this.db
      .prepare(
        `UPDATE feedback_signals
            SET memory_state = 'pending', memory_attempts = 0, memory_owed_since = ?
          WHERE memory_state = 'failed'`,
      )
      .run(at);
    this.logEvent("feedback_memory_requeued", null, {
      at,
      count: info.changes,
      ids: ids.slice(0, 50),
    });
    return info.changes;
  }

  /** When the pump last raised the backlog wake for the backlog that is
   * still open, or null (never, or that backlog cleared). Events-table
   * backed, so a restart inside a backlog keeps the re-wake cadence instead
   * of waking again at once. */
  feedbackBacklogWokenAt(): string | null {
    const p = this.lastEventPayload("memory_write_backlog_woken");
    return p && typeof p["at"] === "string" ? p["at"] : null;
  }

  /** Record a backlog wake (its instant), or the backlog clearing (null). */
  recordFeedbackBacklogWoken(at: string | null): void {
    this.logEvent(
      "memory_write_backlog_woken",
      null,
      at === null ? { at: null, cleared: true } : { at },
    );
  }

  /** When the boot migration classified the legacy feedback rows, or null
   * if it never had any to classify. A pending row created before it may
   * have landed in memory under an unrecorded name; the pump checks. */
  feedbackLegacyCutoff(): string | null {
    const p = this.lastEventPayload("feedback_memory_ledger_migrated");
    return p && typeof p["at"] === "string" ? p["at"] : null;
  }

  /** The day's explicit [feedback] comments — the same-day validator
   * addendum's input, oldest first. */
  feedbackCommentsForDay(day: string): FeedbackSignalRow[] {
    return this.db
      .prepare(
        "SELECT * FROM feedback_signals WHERE day = ? AND kind = 'feedback_comment' ORDER BY id",
      )
      .all(day) as FeedbackSignalRow[];
  }

  /** Every feedback signal on one PR, oldest first (the outcome capture
   * reads review-level outcomes from here). */
  feedbackSignalsFor(pr: number): FeedbackSignalRow[] {
    return this.db
      .prepare("SELECT * FROM feedback_signals WHERE pr = ? ORDER BY id")
      .all(pr) as FeedbackSignalRow[];
  }

  /** Every feedback signal recorded at or after `since` (an ISO instant),
   * oldest first — the review history digest's feedback half. */
  feedbackSignalsSince(since: string): FeedbackSignalRow[] {
    return this.db
      .prepare("SELECT * FROM feedback_signals WHERE created_at >= ? ORDER BY id")
      .all(since) as FeedbackSignalRow[];
  }

  // ---- captured human comments --------------------------------------------

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
    review_state?: string | null;
  }): boolean {
    const reviewState =
      typeof c.review_state === "string" && c.review_state.trim() !== ""
        ? c.review_state.trim().toLowerCase()
        : null;
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO pr_comments
           (pr, source, comment_id, in_reply_to_id, thread_id, review_id, author, author_type,
            tagged, path, line, body, created_at, captured_at, captured_via, review_state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        reviewState,
      );
    // A review captured before the column existed has no state; the sweep that sees
    // it again fills it in (once — a recorded state is never rewritten).
    if (info.changes === 0 && reviewState !== null)
      this.db
        .prepare(
          "UPDATE pr_comments SET review_state = ? WHERE source = ? AND comment_id = ? AND review_state IS NULL",
        )
        .run(reviewState, c.source, c.comment_id);
    return info.changes > 0;
  }

  /** A PR's captured comments, oldest first — the companion's local copy of
   * the conversation. */
  prComments(pr: number): PrCommentRow[] {
    return this.db
      .prepare("SELECT * FROM pr_comments WHERE pr = ? ORDER BY id")
      .all(pr) as PrCommentRow[];
  }

  /** True when this exact GitHub comment is already captured. */
  hasPrComment(source: string, comment_id: number): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM pr_comments WHERE source = ? AND comment_id = ?")
        .get(source, comment_id) !== undefined
    );
  }

  /** Comment-capture sweep watermark: the sweep costs three GitHub
   * reads per PR, so reconcile skips a PR whose row has not moved since its
   * last clean sweep. Kept in the events table (kind = 'comment_sweep'), the
   * same no-new-DDL idiom as the anomaly record — boot-safe on the live DB. */
  markCommentSweep(pr: number, rowUpdatedAt: string): void {
    this.logEvent("comment_sweep", pr, { row_updated_at: rowUpdatedAt });
  }

  /** The watermark this PR was last cleanly swept at, when any — reconcile's
   * pairing of the pr_state `updated_at` with GitHub's; opaque here. */
  lastCommentSweep(pr: number): string | undefined {
    const row = this.db
      .prepare(
        "SELECT payload FROM events WHERE kind = 'comment_sweep' AND pr = ? ORDER BY id DESC LIMIT 1",
      )
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

  /**
   * The most recent `round_memory_seeded` row whose pinned head was READ
   * (`head_state` populated or empty) — the baseline dispatch compares a
   * newly-empty head against (populated → empty across a restart is
   * otherwise silent). Rows written before `head_state` existed
   * are not candidates, so a deploy never fires the transition by itself.
   */
  lastReadPinnedHead(): { pr: number | null; ts: string; head_chars: number } | null {
    const row = this.db
      .prepare(
        "SELECT pr, ts, json_extract(payload, '$.head_chars') AS head_chars FROM events " +
          "WHERE kind = 'round_memory_seeded' AND json_extract(payload, '$.head_state') IN ('populated', 'empty') " +
          "ORDER BY id DESC LIMIT 1",
      )
      .get() as { pr: number | null; ts: string; head_chars: number | null } | undefined;
    if (!row) return null;
    return {
      pr: row.pr,
      ts: row.ts,
      head_chars: typeof row.head_chars === "number" ? row.head_chars : 0,
    };
  }

  logEvent(kind: string, pr: number | null, payload?: unknown): void {
    this.db
      .prepare("INSERT INTO events (ts, kind, pr, payload) VALUES (?, ?, ?, ?)")
      .run(this.ts(), kind, pr, payload === undefined ? null : JSON.stringify(payload));
  }

  // ---- deploy-window drain -----------------------------------------------

  /**
   * The drain flag + its drop counter, folded against the hold's expiry: a
   * session drain past its `expires_at` reads `draining: false` here, at
   * every reader, whether or not the sweep has retired the row yet. A missing
   * row means "not draining"; a draining row with no issuer recorded is the
   * operator's (no expiry).
   */
  drainState(): DrainState {
    const row = this.db
      .prepare(
        "SELECT draining, drained_deliveries, since, issued_by, expires_at, reason, hold FROM drain_state WHERE id = 1",
      )
      .get() as
      | {
          draining: number;
          drained_deliveries: number;
          since: string | null;
          issued_by: LeverIssuer | null;
          expires_at: string | null;
          reason: string | null;
          hold: number;
        }
      | undefined;
    if (!row) return { draining: false, drained_deliveries: 0 };
    const hold = this.drainHold(row);
    if (!holdActive(hold, this.ts()))
      return { draining: false, drained_deliveries: row.drained_deliveries };
    return {
      draining: true,
      drained_deliveries: row.drained_deliveries,
      since: row.since,
      issued_by: hold.issuer,
      expires_at: hold.expires_at,
      reason: row.reason,
      // A hold is the operator's and never lapses; a row that says otherwise
      // (no writer produces one) reads as no hold rather than an unliftable one.
      hold: row.hold === 1 && hold.issuer === "operator" && hold.expires_at === null,
    };
  }

  private drainHold(row: {
    draining: number;
    issued_by: LeverIssuer | null;
    expires_at: string | null;
  }): LeverHold | null {
    return storedHold(row.draining === 1, row.issued_by, row.expires_at);
  }

  /**
   * Engage the drain under `grant`. A fresh engagement starts a new
   * drop window (counter reset); a grant landing on a standing drain follows
   * `mergeHold` — an operator's grant upgrades a session's, a session's never
   * narrows an operator's, a repeat from the same issuer only widens — and
   * keeps the window it found. Returns the state that now stands.
   */
  engageDrain(
    grant: LeverGrant,
    reason: string | null = null,
  ): { outcome: HoldOutcome; state: DrainState } {
    const standing = this.drainState();
    const merged = mergeHold(
      standing.draining
        ? {
            issuer: standing.issued_by,
            expires_at: standing.expires_at,
            ...(standing.hold ? { hold: true as const } : {}),
          }
        : null,
      grant,
    );
    const hold = merged.hold.hold === true ? 1 : 0;
    if (merged.outcome === "unchanged") return { outcome: merged.outcome, state: standing };
    const ts = this.ts();
    if (merged.outcome === "engaged") {
      this.db
        .prepare(
          `INSERT INTO drain_state (id, draining, drained_deliveries, since, issued_by, expires_at, reason, hold, updated_at)
           VALUES (1, 1, 0, @ts, @issuer, @expires, @reason, @hold, @ts)
           ON CONFLICT(id) DO UPDATE SET draining = 1, drained_deliveries = 0, since = @ts, issued_by = @issuer, expires_at = @expires, reason = @reason, hold = @hold, updated_at = @ts`,
        )
        .run({ ts, issuer: merged.hold.issuer, expires: merged.hold.expires_at, reason, hold });
    } else {
      // An upgrade or an extension keeps the standing reason unless one is given.
      this.db
        .prepare(
          "UPDATE drain_state SET issued_by = ?, expires_at = ?, reason = COALESCE(?, reason), hold = ?, updated_at = ? WHERE id = 1",
        )
        .run(merged.hold.issuer, merged.hold.expires_at, reason, hold, ts);
    }
    return { outcome: merged.outcome, state: this.drainState() };
  }

  /**
   * Lift the drain, returning how many deliveries were dropped while it stood
   * so the lift log line can say what the reconcile poll now has to recover.
   * A session's lift is REFUSED while the operator holds the drain; the
   * operator (and the boot auto-lift, which is the operator's deploy flow
   * completing) lifts anything. Idempotent when nothing is draining.
   */
  liftDrain(by: LeverIssuer): { changed: boolean; dropped: number; refused?: "held-by-operator" } {
    const standing = this.drainState();
    if (!standing.draining) return { changed: false, dropped: standing.drained_deliveries };
    if (!mayLift({ issuer: standing.issued_by, expires_at: standing.expires_at }, by)) {
      return { changed: false, dropped: standing.drained_deliveries, refused: "held-by-operator" };
    }
    this.db
      .prepare(
        "UPDATE drain_state SET draining = 0, issued_by = NULL, expires_at = NULL, reason = NULL, hold = 0, updated_at = ? WHERE id = 1",
      )
      .run(this.ts());
    // The breaker's drain lifted: its failures are answered for, so they stop
    // counting toward the next one.
    if (standing.reason === WORKER_FAILURES_DRAIN_REASON) this.resetWorkerFailureWindow();
    return { changed: true, dropped: standing.drained_deliveries };
  }

  /**
   * Retire every hold whose expiry has passed. The readers already
   * fold expiry, so this changes no decision — it makes the row match what
   * the readers have been answering and returns what lapsed, for the ledger.
   */
  expireLevers(): { drain: boolean; pauses: number[] } {
    const now = this.ts();
    const drain =
      this.db
        .prepare(
          "UPDATE drain_state SET draining = 0, issued_by = NULL, expires_at = NULL, reason = NULL, hold = 0, updated_at = ? WHERE id = 1 AND draining = 1 AND expires_at IS NOT NULL AND expires_at <= ?",
        )
        .run(now, now).changes > 0;
    const pauses = (
      this.db
        .prepare(
          "SELECT number FROM pr_state WHERE paused = 1 AND pause_expires_at IS NOT NULL AND pause_expires_at <= ? ORDER BY number",
        )
        .all(now) as Array<{ number: number }>
    ).map((r) => r.number);
    if (pauses.length > 0) {
      this.db
        .prepare(
          `UPDATE pr_state SET paused = 0, pause_issuer = NULL, pause_expires_at = NULL, pause_reason = NULL, pause_since = NULL, updated_at = ?
            WHERE number IN (${pauses.map(() => "?").join(",")})`,
        )
        .run(now, ...pauses);
    }
    return { drain, pauses };
  }

  // ---- host lease -------------------------------------------------

  hostLease(pr: number): HostLeaseRow | undefined {
    return this.db.prepare("SELECT * FROM pr_host_leases WHERE pr = ?").get(pr) as
      HostLeaseRow | undefined;
  }

  hostLeases(): HostLeaseRow[] {
    return this.db.prepare("SELECT * FROM pr_host_leases ORDER BY pr").all() as HostLeaseRow[];
  }

  /**
   * Take the PR's host lease. Granted only when no lease stands and no worker
   * command owns the session (`pending` or `running`; a debug lease may adopt a
   * pending round order), both read in the
   * transaction that writes the row, so a worker's claim and this grant cannot
   * both win. A worker that is already running without a row (an orphan the
   * boot has not reaped) is the caller's check, by its process lease.
   */
  grantHostLease(o: {
    pr: number;
    kind: HostLeaseKind;
    token: string;
    commandId: string;
    holder: string;
    at: string;
  }): HostLeaseGrant {
    return this.db
      .transaction((): HostLeaseGrant => {
        const held = this.hostLease(o.pr);
        if (held)
          return {
            ok: false,
            why: "held",
            reason: `PR #${o.pr} is already under a ${held.kind} lease (${held.holder}, ${held.state})`,
          };
        const command = this.activeSessionCommand(`pr-${o.pr}`);
        // A debug round is armed for the PR's NEXT round, so a round order
        // submitted and not yet claimed by anyone is the one it will take. A claimed
        // command (running), and any other kind, is a worker's.
        const adoptable =
          o.kind === "debug" && command?.kind === "round" && command.status === "pending";
        if (command && !adoptable)
          return {
            ok: false,
            why: "worker",
            reason: `a worker command (${command.kind} ${command.id}, ${command.status}) owns PR #${o.pr}'s session: abort the round or wait for it`,
          };
        this.db
          .prepare(
            `INSERT INTO pr_host_leases (pr, kind, state, token, command_id, holder, granted_at, touched_at)
           VALUES (@pr, @kind, 'held', @token, @commandId, @holder, @at, @at)`,
          )
          .run(o);
        this.logEvent("host_lease_granted", o.pr, { kind: o.kind, holder: o.holder });
        return { ok: true, row: this.hostLease(o.pr)! };
      })
      .immediate();
  }

  /** Record activity on a lease the token owns. False for any other row. */
  touchHostLease(pr: number, token: string, at: string): boolean {
    return (
      this.db
        .prepare(
          "UPDATE pr_host_leases SET touched_at = ? WHERE pr = ? AND token = ? AND touched_at < ?",
        )
        .run(at, pr, token, at).changes > 0
    );
  }

  /** The host was told to stop. The row stays, and keeps workers out, until
   * `releaseHostLease`. */
  endHostLease(pr: number, token: string, at: string, why: string): boolean {
    return (
      this.db
        .prepare(
          `UPDATE pr_host_leases SET state = 'ending', ending_at = COALESCE(ending_at, ?),
             ending_why = COALESCE(ending_why, ?) WHERE pr = ? AND token = ?`,
        )
        .run(at, why, pr, token).changes > 0
    );
  }

  /** Free the lease: the host is confirmed gone. */
  releaseHostLease(pr: number, token: string): boolean {
    return this.db
      .transaction(() => {
        const row = this.hostLease(pr);
        if (!row || row.token !== token) return false;
        this.db.prepare("DELETE FROM pr_host_leases WHERE pr = ? AND token = ?").run(pr, token);
        this.logEvent("host_lease_released", pr, { kind: row.kind, why: row.ending_why });
        return true;
      })
      .immediate();
  }

  // ---- worker crash-loop breaker ----------------------------------

  workerBreaker(pr: number): WorkerBreakerRow | undefined {
    return this.db
      .prepare(
        "SELECT pr, failures, parked_at, last_error, last_failure_at, last_command_id FROM worker_breaker WHERE pr = ?",
      )
      .get(pr) as WorkerBreakerRow | undefined;
  }

  /** Every PR with a failure on record or a park, for status.json. */
  workerBreakerRows(): WorkerBreakerRow[] {
    return this.db
      .prepare(
        "SELECT pr, failures, parked_at, last_error, last_failure_at, last_command_id FROM worker_breaker WHERE failures > 0 OR parked_at IS NOT NULL ORDER BY pr",
      )
      .all() as WorkerBreakerRow[];
  }

  isWorkerParked(pr: number): boolean {
    return this.workerBreaker(pr)?.parked_at != null;
  }

  /**
   * One more consecutive worker failure for `pr`. The PR is parked when the count
   * reaches `parkAfter`; `parked` says whether it stands parked now and
   * `newlyParked` whether THIS failure parked it (the caller raises the anomaly
   * once).
   */
  recordWorkerFailure(
    pr: number,
    o: { commandId: string; error: string; at: string; parkAfter: number },
  ): { failures: number; parked: boolean; newlyParked: boolean } {
    return this.db
      .transaction(() => {
        const row = this.workerBreaker(pr);
        const failures = (row?.failures ?? 0) + 1;
        const wasParked = row?.parked_at != null;
        const parkedAt = wasParked ? row.parked_at : failures >= o.parkAfter ? o.at : null;
        this.db
          .prepare(
            `INSERT INTO worker_breaker (pr, failures, parked_at, last_error, last_failure_at, last_command_id, failure_epoch, updated_at)
           VALUES (@pr, @failures, @parked, @error, @at, @command, @epoch, @at)
           ON CONFLICT(pr) DO UPDATE SET failures = @failures, parked_at = @parked, last_error = @error,
             last_failure_at = @at, last_command_id = @command, failure_epoch = @epoch, updated_at = @at`,
          )
          .run({
            pr,
            failures,
            parked: parkedAt,
            error: o.error,
            at: o.at,
            command: o.commandId,
            epoch: this.workerEpoch(),
          });
        return {
          failures,
          parked: parkedAt !== null,
          newlyParked: !wasParked && parkedAt !== null,
        };
      })
      .immediate();
  }

  /** A worker for `pr` served its round: its consecutive count restarts, and the
   * global window (failures across PRs "with no success") restarts too. A parked PR
   * stays parked: an answer served before the park must not undo it. */
  recordWorkerSuccess(pr: number, at: string): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE worker_breaker SET failures = 0, updated_at = ? WHERE pr = ? AND parked_at IS NULL",
        )
        .run(at, pr);
      this.resetWorkerFailureWindow();
    })();
  }

  /** The operator's unpark (rerun-round, restart-session): the row goes. */
  clearWorkerBreaker(pr: number): boolean {
    return this.db.prepare("DELETE FROM worker_breaker WHERE pr = ?").run(pr).changes > 0;
  }

  /** PRs whose latest worker failure is at or after `since` and since the last
   * success (or the last lift of the breaker's drain). */
  failedWorkerPrsSince(since: string): number[] {
    return (
      this.db
        .prepare(
          "SELECT pr FROM worker_breaker WHERE failures > 0 AND last_failure_at >= ? AND failure_epoch = ? ORDER BY pr",
        )
        .all(since, this.workerEpoch()) as Array<{ pr: number }>
    ).map((r) => r.pr);
  }

  private workerEpoch(): number {
    const row = this.db.prepare("SELECT epoch FROM worker_breaker_global WHERE id = 1").get() as
      { epoch: number } | undefined;
    return row?.epoch ?? 0;
  }

  /** Start the global failure window afresh: earlier failures stop counting. */
  resetWorkerFailureWindow(): void {
    this.db
      .prepare(
        `INSERT INTO worker_breaker_global (id, epoch, updated_at) VALUES (1, 1, @ts)
         ON CONFLICT(id) DO UPDATE SET epoch = epoch + 1, updated_at = @ts`,
      )
      .run({ ts: this.ts() });
  }

  /** Charge a session grant to `day`'s budget. `pr` is null for a drain. */
  recordLeverGrant(
    kind: LeverKind,
    pr: number | null,
    minutes: number,
    day: string,
    expiresAt: string,
  ): void {
    this.db
      .prepare(
        "INSERT INTO lever_grants (kind, pr, minutes, day, granted_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(kind, pr, minutes, day, this.ts(), expiresAt);
  }

  /** Minutes already granted to sessions for `kind` on `day` — per PR for pauses. */
  leverMinutesUsed(kind: LeverKind, day: string, pr: number | null): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(SUM(minutes), 0) AS used FROM lever_grants WHERE kind = ? AND day = ? AND pr IS ?",
      )
      .get(kind, day, pr) as { used: number };
    return row.used;
  }

  /** Has this VERSION of an operator command file already been executed?
   * `version` is `operatorCommandVersion`'s key. */
  operatorCommandHandled(version: string): boolean {
    return (
      this.db.prepare("SELECT 1 FROM operator_commands WHERE version = ?").get(version) !==
      undefined
    );
  }

  markOperatorCommandHandled(version: string, file: string): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO operator_commands (version, file, handled_at) VALUES (?, ?, ?)",
      )
      .run(version, file, this.ts());
  }

  /** Count one webhook delivery dropped while draining; returns the new total. */
  countDrainedDelivery(): number {
    this.db
      .prepare(
        "UPDATE drain_state SET drained_deliveries = drained_deliveries + 1, updated_at = ? WHERE id = 1",
      )
      .run(this.ts());
    return this.drainState().drained_deliveries;
  }

  /**
   * The durable anomaly record. Every call-site that raises an overseer
   * anomaly (malformed verdict, blown deadline, degraded migration pre-check,
   * degraded recheck merge-verify, …) writes ONE queryable `anomaly` event
   * here. Kept in the events table (kind = 'anomaly'), so it needs no new DDL
   * and is boot-safe on the live DB by construction.
   *
   * This is also the one funnel to the overseer wake — the record is
   * forwarded to the optional sink (the daemon wires `AnomalyWakePolicy`),
   * which applies the severity map + dedup and injects for WAKE classes only.
   * `injectMessage` is the call site's richer wake text; it is NOT persisted
   * (the `detail` field is the audit trail). No sink (bare store, tests, CLI)
   * ⇒ the row is written and nothing wakes.
   */
  logAnomaly(
    kind: string,
    pr: number | null,
    roundNo: number | null,
    detail: string,
    injectMessage?: string,
  ): void {
    this.logEvent("anomaly", pr, { kind, round_no: roundNo, detail });
    if (this.anomalySink) {
      const ts = this.ts();
      this.anomalySink({ ts, kind, pr, round_no: roundNo, detail, injectMessage });
    }
  }

  private anomalySink:
    ((signal: AnomalyRecord & { injectMessage?: string | undefined }) => void) | null = null;

  /** Install the overseer wake sink. The sink must never throw —
   * logAnomaly sits inside posting paths and stays sync. */
  setAnomalySink(
    sink: (signal: AnomalyRecord & { injectMessage?: string | undefined }) => void,
  ): void {
    this.anomalySink = sink;
  }

  /** Whether an anomaly of this kind was ever recorded on this PR — the
   * once-per-PR gate for an alert whose cause persists across rounds (a torn
   * ledger row is torn on every round until someone repairs it, and one
   * overseer wake per round would bury the anomalies that need reading). An
   * anomaly row whose own payload cannot be read never counts as "already
   * raised": that reading would silence the alert on the strength of nothing. */
  anomalyRaised(kind: string, pr: number): boolean {
    const rows = this.db
      .prepare("SELECT payload FROM events WHERE kind = 'anomaly' AND pr = ?")
      .all(pr) as Array<{ payload: string | null }>;
    return rows.some((r) => readStringField(r.payload, "kind") === kind);
  }

  /** Recorded anomalies, newest last. */
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
          const p = JSON.parse(r.payload) as {
            kind?: unknown;
            round_no?: unknown;
            detail?: unknown;
          };
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

  // ---- memory incident ----------------------------------------------------

  /** The memory incident the health monitor last recorded as OPEN, or null
   * when the last record closed it (or none exists). Events-table backed, so
   * a daemon restart inside an outage continues the same incident — the TUI
   * files one tracker ticket per incident START, and a restart must not mint
   * a new start. An unreadable row reads as no incident (the monitor then
   * opens a fresh one on its next measurement — a duplicate ticket at worst,
   * never a silenced outage). */
  memoryIncident(): MemoryIncident | null {
    const p = this.lastEventPayload("memory_incident");
    if (!p || p["closed"] === true) return null;
    const kind = p["kind"];
    const since = p["since"];
    if ((kind === "auth_failed" || kind === "down") && typeof since === "string")
      return { kind, since };
    return null;
  }

  /** Record the open incident (or its close, with null). */
  recordMemoryIncident(incident: MemoryIncident | null): void {
    this.logEvent("memory_incident", null, incident ?? { closed: true });
  }

  /** The newest event of `kind`'s payload as an object, or null (none, or not
   * an object). For once-per-X marks kept in the events table. */
  lastEventPayload(kind: string): Record<string, unknown> | null {
    const row = this.db
      .prepare("SELECT payload FROM events WHERE kind = ? ORDER BY id DESC LIMIT 1")
      .get(kind) as { payload: string | null } | undefined;
    if (!row?.payload) return null;
    try {
      const p: unknown = JSON.parse(row.payload);
      return p && typeof p === "object" && !Array.isArray(p)
        ? (p as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  // ---- deferred EOD sweeps ------------------------------------------------

  /** The ops days whose EOD sweep a drain held back and that have not fired
   * yet, oldest first. Events-table backed (last record wins), so a deferred
   * sweep survives the restart a deploy-window drain is usually FOR. */
  eodDeferredDates(): string[] {
    const p = this.lastEventPayload("eod_deferred");
    const dates = p?.["dates"];
    if (!Array.isArray(dates)) return [];
    return dates.filter((d): d is string => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d));
  }

  /** Record the deferred set (the whole list — the last record wins). */
  recordEodDeferred(dates: string[]): void {
    this.logEvent("eod_deferred", null, { dates: [...new Set(dates)].sort() });
  }

  // ---- overseer heartbeat -----------------------------------------------

  /** Record that the daily heartbeat fired for `date` (local "YYYY-MM-DD"). */
  recordHeartbeat(date: string): void {
    this.logEvent("overseer_heartbeat", null, { date });
  }

  /** The last local date the heartbeat fired, or null. Events-table backed, so
   * it survives restarts — the boot catch-up's at-most-once guard. */
  lastHeartbeatDate(): string | null {
    const date = this.lastEventPayload("overseer_heartbeat")?.["date"];
    return typeof date === "string" ? date : null;
  }

  /**
   * The once-per-round ledger re-nudge mark. Kept in the events table
   * (kind = 'ledger_stale_nudged'), like the anomaly record: no new DDL,
   * boot-safe on the live DB by construction. The key is
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
    return someMarkHasKey(rows, key);
  }

  /**
   * What the event log says about the migration-collision COMMENT with this
   * fingerprint on this PR (the collision comment's dedupe). Scans every such event for the
   * PR — no recency window, because a PR that accumulates rounds must not
   * start re-posting the same comment once the newest N events are other
   * collisions.
   *
   * `unknown` is a PR whose log holds a comment row this code cannot read (a
   * null or corrupt payload). Such a row means a comment WAS posted, at a
   * fingerprint nobody can recover — so "never commented" is not a claim the
   * log supports, and the caller must not post on it (a duplicate
   * comment on the reviewed repo is an external mutation, which outranks the
   * low odds of the daemon corrupting its own JSON).
   */
  migrationCollisionCommented(
    pr: number,
    fingerprint: string,
    opts: { live?: boolean } = {},
  ): CollisionCommentRecord {
    const rows = this.db
      .prepare(
        `SELECT kind,payload FROM events
      WHERE kind IN ('migration_collision_comment','migration_collision_comment_pending','migration_collision_comment_refused') AND pr=? ORDER BY id DESC`,
      )
      .all(pr) as Array<{ kind: string; payload: string | null }>;
    let unreadable = false;
    let latest: CollisionCommentRecord | undefined;
    for (const row of rows) {
      const stamped = readStringField(row.payload, "fingerprint");
      if (stamped === undefined) {
        unreadable = true;
        continue;
      }
      if (stamped !== fingerprint) continue;
      if (row.kind === "migration_collision_comment") {
        if (readBooleanField(row.payload, "executed") !== false) return "commented";
        latest ??= opts.live ? "not_commented" : "dryrun";
      } else
        latest ??= row.kind === "migration_collision_comment_pending" ? "pending" : "not_commented";
    }
    return unreadable ? "unknown" : (latest ?? "not_commented");
  }

  /**
   * Self-requeues spent in the current failed-stage GENERATION at a head
   * (the self-requeue cap's accounting), split into the ones `round_self_requeued`
   * stamped with THIS head and the ones whose payload cannot be read at all.
   * A new head resets the budget naturally; an exact planned fanout (or a
   * completed verdict that was too fast for the supervisor tick to observe) at
   * the same head starts a fresh generation, so historical incidents never
   * punish later successful work forever. Rows are read in ledger order so a
   * generation is a run of rows after the last same-head reset.
   *
   * `unattributed` rows are requeues that certainly happened at SOME head, in
   * the current generation. The caller counts them against the cap (they can
   * only ever tighten it), so a corrupt payload can never buy a requeue past
   * the budget.
   */
  selfRequeueSpend(pr: number, headSha: string): SelfRequeueSpend {
    const rows = this.db
      .prepare(
        `SELECT kind, payload FROM events
          WHERE pr=? AND kind IN ('round_self_requeued','round_fanout_started','verdict_applied')
          ORDER BY id`,
      )
      .all(pr) as Array<{ kind: string; payload: string | null }>;
    const spend: SelfRequeueSpend = { at_head: 0, unattributed: 0 };
    for (const row of rows) {
      const stamped = readStringField(row.payload, "head_sha");
      if (row.kind === "round_self_requeued") {
        if (stamped === undefined) spend.unattributed += 1;
        else if (stamped === headSha) spend.at_head += 1;
      } else if (stamped === headSha) {
        spend.at_head = 0;
        spend.unattributed = 0;
      }
    }
    return spend;
  }

  /** `selfRequeueSpend` collapsed to the number the cap is compared against:
   * attributed and unattributed rows both spend the budget. */
  selfRequeueCount(pr: number, headSha: string): number {
    const spend = this.selfRequeueSpend(pr, headSha);
    return spend.at_head + spend.unattributed;
  }

  /** Head sha of the last applied verdict for a PR (from the event log). */
  lastVerdictHead(pr: number): string | undefined {
    const row = this.db
      .prepare(
        "SELECT payload FROM events WHERE kind = 'verdict_applied' AND pr = ? ORDER BY id DESC LIMIT 1",
      )
      .get(pr) as { payload: string | null } | undefined;
    if (!row?.payload) return undefined;
    try {
      const head = (JSON.parse(row.payload) as { head_sha?: unknown }).head_sha;
      return typeof head === "string" && head.length > 0 ? head : undefined;
    } catch {
      return undefined;
    }
  }

  eventsOn(
    dateIso: string,
  ): Array<{ ts: string; kind: string; pr: number | null; payload: string | null }> {
    return this.db
      .prepare("SELECT ts, kind, pr, payload FROM events WHERE ts LIKE ? ORDER BY id")
      .all(`${dateIso}%`) as any;
  }

  /** Every event of the given kinds for one PR, oldest first, its payload
   * decoded (an undecodable payload reads as `{}`) — the outcome capture's
   * read of the ping-pong decisions, resolves, pushes and closes. */
  prEvents(
    pr: number,
    kinds: readonly string[],
  ): Array<{ id: number; ts: string; kind: string; payload: Record<string, unknown> }> {
    if (kinds.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT id, ts, kind, payload FROM events WHERE pr = ? AND kind IN (${kinds
          .map(() => "?")
          .join(",")}) ORDER BY id`,
      )
      .all(pr, ...kinds) as Array<{ id: number; ts: string; kind: string; payload: string | null }>;
    return rows.map((r) => {
      let payload: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(r.payload ?? "{}") as unknown;
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
          payload = parsed as Record<string, unknown>;
      } catch {
        /* undecodable: an empty payload */
      }
      return { id: r.id, ts: r.ts, kind: r.kind, payload };
    });
  }

  /** Newest-last tail of the event log — the TUI events strip. */
  recentEvents(
    limit: number,
  ): Array<{ ts: string; kind: string; pr: number | null; payload: string | null }> {
    return this.db
      .prepare(
        "SELECT ts, kind, pr, payload FROM (SELECT id, ts, kind, pr, payload FROM events ORDER BY id DESC LIMIT ?) ORDER BY id",
      )
      .all(limit) as any;
  }

  // ---- filed items (improvement PRs / issues, cap accounting) -----------

  /** Charge one cap slot; the row's id, for `settleFiledItem` /
   * `releaseFiledItem` when the slot was reserved before the creation. */
  recordFiledItem(kind: "improvement_pr" | "issue", title: string, ref: string | null): number {
    return Number(
      this.db
        .prepare("INSERT INTO filed_items (kind, title, ref, filed_at) VALUES (?, ?, ?, ?)")
        .run(kind, title, ref, this.ts()).lastInsertRowid,
    );
  }

  /** Name what a reserved slot filed, once GitHub answered. */
  settleFiledItem(id: number, ref: string | null): void {
    this.db.prepare("UPDATE filed_items SET ref = ? WHERE id = ?").run(ref, id);
  }

  /** Free a reserved slot whose creation GitHub definitely refused. */
  releaseFiledItem(id: number): void {
    this.db.prepare("DELETE FROM filed_items WHERE id = ?").run(id);
  }

  commandEffectReceipt(key: string): { result: string | null } | undefined {
    return this.db
      .prepare("SELECT result FROM command_effect_receipts WHERE delivery_key = ?")
      .get(key) as { result: string | null } | undefined;
  }

  reserveCommandEffect(key: string): boolean {
    return (
      this.db
        .prepare("INSERT OR IGNORE INTO command_effect_receipts (delivery_key) VALUES (?)")
        .run(key).changes === 1
    );
  }

  settleCommandEffect(key: string, result: unknown): void {
    this.db
      .prepare(
        "UPDATE command_effect_receipts SET result = ? WHERE delivery_key = ? AND result IS NULL",
      )
      .run(JSON.stringify(result), key);
  }

  commandDeliveryReceipt(key: string): { result: string | null } | undefined {
    return this.db
      .prepare("SELECT result FROM command_delivery_receipts WHERE delivery_key=?")
      .get(key) as { result: string | null } | undefined;
  }

  reserveCommandDelivery(key: string): boolean {
    return (
      this.db
        .prepare("INSERT OR IGNORE INTO command_delivery_receipts (delivery_key) VALUES (?)")
        .run(key).changes === 1
    );
  }

  settleCommandDelivery(key: string, result: string): void {
    this.db
      .prepare("UPDATE command_delivery_receipts SET result=? WHERE delivery_key=?")
      .run(result, key);
  }

  filingReceipt(key: string): { slot: number; result: string | null } | undefined {
    return this.db
      .prepare("SELECT slot, result FROM filing_receipts WHERE delivery_key = ?")
      .get(key) as { slot: number; result: string | null } | undefined;
  }

  reserveFiling(
    key: string,
    kind: "issue" | "improvement_pr",
    title: string,
    ref: string | null,
  ): number {
    return this.db.transaction(() => {
      const slot = this.recordFiledItem(kind, title, ref);
      this.db
        .prepare("INSERT INTO filing_receipts (delivery_key, slot) VALUES (?, ?)")
        .run(key, slot);
      return slot;
    })();
  }

  settleFiling(key: string, slot: number, ref: string | null, result: unknown): void {
    this.db.transaction(() => {
      this.settleFiledItem(slot, ref);
      this.db
        .prepare("UPDATE filing_receipts SET result = ? WHERE delivery_key = ? AND slot = ?")
        .run(JSON.stringify(result), key, slot);
    })();
  }

  releaseFiling(key: string, slot: number): void {
    this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM filing_receipts WHERE delivery_key = ? AND slot = ?")
        .run(key, slot);
      this.releaseFiledItem(slot);
    })();
  }

  filedSince(kind: "improvement_pr" | "issue", sinceIso: string): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) AS c FROM filed_items WHERE kind = ? AND filed_at >= ?")
        .get(kind, sinceIso) as { c: number }
    ).c;
  }

  // ---- escalations (empty unless the feature is switched on) --------------

  /** Has this exact person already been pointed at this exact thing on this
   * PR? The dedup that makes an escalation a one-time notification rather
   * than a per-round nag. `key` is `"<target>|<scopeKey>"`, split on the
   * FIRST `|` only: a target is a login and cannot hold one, but a scope key
   * embeds a path or decision name that can (JS `split("|", 2)` truncates the
   * rest instead of keeping it). */
  escalationDelivered(pr: number, key: string): boolean {
    const bar = key.indexOf("|");
    const target = bar < 0 ? key : key.slice(0, bar);
    const scopeKey = bar < 0 ? "" : key.slice(bar + 1);
    const row = this.db
      .prepare(
        "SELECT 1 AS x FROM escalations WHERE pr = ? AND target = ? AND scope_key = ? LIMIT 1",
      )
      .get(pr, target, scopeKey) as { x: number } | undefined;
    return row !== undefined;
  }

  /** How many escalations this PR has taken, across every round — the input
   * to `[escalation] max_per_pr`. */
  escalationCount(pr: number): number {
    return (
      this.db.prepare("SELECT COUNT(*) AS c FROM escalations WHERE pr = ?").get(pr) as { c: number }
    ).c;
  }

  recordEscalation(
    pr: number,
    row: {
      target: string;
      scope_key: string;
      shape: string;
      origin: string;
      rule: string | null;
      round_no: number | null;
    },
  ): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO escalations (pr, target, scope_key, shape, origin, rule, round_no, delivered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(pr, row.target, row.scope_key, row.shape, row.origin, row.rule, row.round_no, this.ts());
  }

  escalationRecovery(pr: number, target: string, scope: string): EscalationRecoveryRow | null {
    return (
      (this.db
        .prepare("SELECT * FROM escalation_recovery WHERE pr=? AND target=? AND scope_key=?")
        .get(pr, target, scope) as EscalationRecoveryRow | undefined) ?? null
    );
  }

  prepareEscalationRecovery(row: EscalationRecoveryInput): EscalationRecoveryRow {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO escalation_recovery
      (pr,target,scope_key,head_sha,body,marker,shape,origin,rule,round_no,phase,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,'prepared',?)`,
      )
      .run(
        row.pr,
        row.target,
        row.scope_key,
        row.head_sha,
        row.body,
        row.marker,
        row.shape,
        row.origin,
        row.rule,
        row.round_no,
        this.ts(),
      );
    return this.escalationRecovery(row.pr, row.target, row.scope_key)!;
  }

  claimEscalationComment(row: EscalationRecoveryRow): boolean {
    return (
      this.db
        .prepare(
          "UPDATE escalation_recovery SET phase='posting',updated_at=? WHERE pr=? AND target=? AND scope_key=? AND phase='prepared'",
        )
        .run(this.ts(), row.pr, row.target, row.scope_key).changes === 1
    );
  }

  escalationPostingCount(pr: number): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM escalation_recovery WHERE pr=? AND phase='posting'")
        .get(pr) as { n: number }
    ).n;
  }

  retryEscalationComment(row: EscalationRecoveryRow, error: string, nextAttemptAt: string): void {
    this.db
      .prepare(
        "UPDATE escalation_recovery SET phase='prepared',last_error=?,next_attempt_at=?,updated_at=? WHERE pr=? AND target=? AND scope_key=?",
      )
      .run(error, nextAttemptAt, this.ts(), row.pr, row.target, row.scope_key);
  }

  noteEscalationRecovery(row: EscalationRecoveryRow, error: string): void {
    this.db
      .prepare(
        "UPDATE escalation_recovery SET last_error=?,updated_at=? WHERE pr=? AND target=? AND scope_key=?",
      )
      .run(error, this.ts(), row.pr, row.target, row.scope_key);
  }

  /** The delivery receipt and remaining queue obligation advance atomically. */
  settleEscalationComment(row: EscalationRecoveryRow): void {
    this.db.transaction(() => {
      this.recordEscalation(row.pr, row);
      if (row.shape === "review_request")
        this.db
          .prepare(
            "UPDATE escalation_recovery SET phase='request_pending',last_error=NULL,updated_at=? WHERE pr=? AND target=? AND scope_key=?",
          )
          .run(this.ts(), row.pr, row.target, row.scope_key);
      else this.finishEscalationRecovery(row);
    })();
  }

  finishEscalationRecovery(row: EscalationRecoveryRow): void {
    this.db
      .prepare("DELETE FROM escalation_recovery WHERE pr=? AND target=? AND scope_key=?")
      .run(row.pr, row.target, row.scope_key);
  }

  pendingEscalationRecoveries(limit = 20): EscalationRecoveryRow[] {
    return this.db
      .prepare(
        "SELECT * FROM escalation_recovery WHERE next_attempt_at IS NULL OR next_attempt_at<=? ORDER BY updated_at,pr,target,scope_key LIMIT ?",
      )
      .all(this.ts(), Math.max(1, Math.min(100, Math.floor(limit)))) as EscalationRecoveryRow[];
  }

  /** Every escalation on a PR, oldest first — the operator's audit view. */
  escalationsFor(pr: number): Array<{
    target: string;
    scope_key: string;
    shape: string;
    origin: string;
    rule: string | null;
    round_no: number | null;
    delivered_at: string;
  }> {
    return this.db
      .prepare(
        "SELECT target, scope_key, shape, origin, rule, round_no, delivered_at FROM escalations WHERE pr = ? ORDER BY id",
      )
      .all(pr) as any;
  }

  // ---- Slack: PR ⇄ thread map -------------------------------------------

  /** Bind a PR to its Slack thread root. Re-binding the same PR to a new
   * root (a rebuilt thread) overwrites channel/root_ts and resets the
   * per-thread counters and creation time — they described the old thread;
   * re-binding the root it already has changes nothing. */
  upsertSlackThread(row: { pr: number; channel: string; root_ts: string }): void {
    this.db
      .prepare(
        `INSERT INTO slack_threads (pr, channel, root_ts, created_at, last_post_at, post_count)
         VALUES (@pr, @channel, @root_ts, @created_at, NULL, 0)
         ON CONFLICT(pr) DO UPDATE SET channel=@channel, root_ts=@root_ts,
           created_at=excluded.created_at, last_post_at=NULL, post_count=0
         WHERE slack_threads.channel != @channel OR slack_threads.root_ts != @root_ts`,
      )
      .run({ ...row, created_at: this.ts() });
  }

  slackThreadForPr(pr: number): SlackThreadRow | undefined {
    return this.db.prepare("SELECT * FROM slack_threads WHERE pr = ?").get(pr) as
      SlackThreadRow | undefined;
  }

  /** The reverse lookup the router needs: an inbound reply carries a
   * thread_ts, and that is the only thing tying it to a PR. */
  slackThreadByRoot(channel: string, rootTs: string): SlackThreadRow | undefined {
    return this.db
      .prepare("SELECT * FROM slack_threads WHERE channel = ? AND root_ts = ?")
      .get(channel, rootTs) as SlackThreadRow | undefined;
  }

  allSlackThreads(): SlackThreadRow[] {
    return this.db.prepare("SELECT * FROM slack_threads ORDER BY pr").all() as SlackThreadRow[];
  }

  /** Stamp a successful post against the PR's thread (counter + last time). */
  touchSlackThread(pr: number): void {
    this.db
      .prepare(
        "UPDATE slack_threads SET post_count = post_count + 1, last_post_at = ? WHERE pr = ?",
      )
      .run(this.ts(), pr);
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
  setSlackEventDisposition(
    eventId: string,
    disposition: SlackDisposition,
    injected = disposition === "injected",
  ): void {
    this.db
      .prepare("UPDATE slack_events SET disposition = ?, injected_at = ? WHERE event_id = ?")
      .run(disposition, injected ? this.ts() : null, eventId);
  }

  slackEvent(eventId: string): SlackEventRow | undefined {
    const row = this.db.prepare("SELECT * FROM slack_events WHERE event_id = ?").get(eventId) as
      SlackEventRow | undefined;
    if (!row) return undefined;
    // Older rows carry the retired legacy tier spelling; fold on read
    // (accepted on input, never emitted). An unrecognisable value is returned
    // as-is — this is a ledger read, not a rights grant.
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

  /**
   * Claim a FAILED post again for a retry: the row becomes a fresh claim
   * (ok = 1, no ts, stamped now), so the rolling-hour ceiling counts the new
   * attempt exactly as it counts a first one. False when the row is not a
   * failure — delivered, or claimed and not yet settled.
   */
  reclaimSlackPost(
    idemKey: string,
    row: { thread_ts?: string | null; chars?: number } = {},
  ): boolean {
    const info = this.db
      .prepare(
        `UPDATE slack_posts SET ok = 1, ts = NULL, error = NULL, posted_at = @posted_at,
           thread_ts = @thread_ts, chars = @chars
         WHERE idem_key = @idem_key AND ok = 0`,
      )
      .run({
        idem_key: idemKey,
        posted_at: this.ts(),
        thread_ts: row.thread_ts ?? null,
        chars: row.chars ?? 0,
      });
    return info.changes === 1;
  }

  /** Preserve an unknown create reservation and its diagnostic without admitting a retry. */
  noteSlackPostUnknown(idemKey: string, error: string): void {
    this.db
      .prepare("UPDATE slack_posts SET error = ? WHERE idem_key = ? AND ok = 1 AND ts IS NULL")
      .run(error, idemKey);
  }

  /** Fill in the Slack-assigned message ts (and outcome) after the API call. */
  settleSlackPost(
    idemKey: string,
    result: { ts?: string | null; ok: boolean; error?: string | null },
  ): void {
    this.db
      .prepare("UPDATE slack_posts SET ts = ?, ok = ?, error = ? WHERE idem_key = ?")
      .run(result.ts ?? null, result.ok ? 1 : 0, result.error ?? null, idemKey);
  }

  /** A definitive missing-message response can release only that exact old receipt. */
  forgetMissingSlackMessage(idemKey: string, ts: string): boolean {
    return (
      this.db
        .prepare(
          "UPDATE slack_posts SET ts = NULL, ok = 0, error = 'message_not_found' WHERE idem_key = ? AND ts = ? AND ok = 1",
        )
        .run(idemKey, ts).changes === 1
    );
  }

  queueSlackReopening(row: SlackReopeningRow): void {
    this.db
      .prepare(
        `INSERT INTO slack_reopenings
      (incident_id,generation,pr,episode,cause,text,channel,ts)
      VALUES (@incident_id,@generation,@pr,@episode,@cause,@text,@channel,@ts)
      ON CONFLICT(incident_id) DO UPDATE SET generation=excluded.generation,
        pr=excluded.pr,episode=excluded.episode,cause=excluded.cause,
        text=excluded.text,channel=excluded.channel,ts=excluded.ts`,
      )
      .run(row);
  }

  owedSlackReopenings(): SlackReopeningRow[] {
    return this.db
      .prepare("SELECT * FROM slack_reopenings ORDER BY incident_id")
      .all() as SlackReopeningRow[];
  }

  clearSlackReopening(incidentId: string, generation: string): void {
    this.db
      .prepare("DELETE FROM slack_reopenings WHERE incident_id = ? AND generation = ?")
      .run(incidentId, generation);
  }

  slackPost(idemKey: string): SlackPostRow | undefined {
    return this.db.prepare("SELECT * FROM slack_posts WHERE idem_key = ?").get(idemKey) as
      SlackPostRow | undefined;
  }

  /** Successful posts in [since, until), optionally of one kind. */
  slackPostsBetween(sinceIso: string, untilIso: string, kind?: SlackPostKind): number {
    const sql =
      "SELECT COUNT(*) AS c FROM slack_posts WHERE ok = 1 AND posted_at >= ? AND posted_at < ?" +
      (kind ? " AND kind = ?" : "");
    const args: Array<string> = kind ? [sinceIso, untilIso, kind] : [sinceIso, untilIso];
    return (this.db.prepare(sql).get(...args) as { c: number }).c;
  }

  /** Successful posts into one thread in [since, until) — the per-thread cap. */
  slackThreadPostsBetween(threadTs: string, sinceIso: string, untilIso: string): number {
    return (
      this.db
        .prepare(
          "SELECT COUNT(*) AS c FROM slack_posts WHERE ok = 1 AND thread_ts = ? AND posted_at >= ? AND posted_at < ?",
        )
        .get(threadTs, sinceIso, untilIso) as { c: number }
    ).c;
  }

  /** Announcements posted since an instant — the per-hour limiter's window is
   * rolling, not calendar-aligned. */
  slackPostsSince(sinceIso: string, kind?: SlackPostKind): number {
    const sql =
      "SELECT COUNT(*) AS c FROM slack_posts WHERE ok = 1 AND posted_at >= ?" +
      (kind ? " AND kind = ?" : "");
    const args: Array<string> = kind ? [sinceIso, kind] : [sinceIso];
    return (this.db.prepare(sql).get(...args) as { c: number }).c;
  }

  // ---- Slack: announcement cooldowns ------------------------------------

  slackCooldown(key: string): SlackCooldownRow | undefined {
    // `warsaw_day AS day`: the one place the legacy column name maps onto the
    // neutral row field (see the schema note).
    return this.db
      .prepare(
        "SELECT key, last_fired_at, warsaw_day AS day, fire_count, fold_count, bypassed FROM slack_cooldowns WHERE key = ?",
      )
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
        fire_count: sameDay ? prev.fire_count + 1 : 1,
        bypassed: (sameDay && prev.bypassed === 1) || bypass ? 1 : 0,
      });
  }

  /** Put a cooldown row back exactly as it was before a fire that never
   * reached the channel (`undefined` = there was no row). Used when an
   * admitted announcement is refused at claim time by the rolling-hour
   * ceiling: that refusal must write nothing, like the admission-time one. */
  restoreSlackCooldown(key: string, prior: SlackCooldownRow | undefined): void {
    if (prior === undefined) {
      this.db.prepare("DELETE FROM slack_cooldowns WHERE key = ?").run(key);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO slack_cooldowns (key, last_fired_at, warsaw_day, fire_count, fold_count, bypassed)
         VALUES (@key, @last_fired_at, @warsaw_day, @fire_count, @fold_count, @bypassed)
         ON CONFLICT(key) DO UPDATE SET
           last_fired_at=@last_fired_at, warsaw_day=@warsaw_day, fire_count=@fire_count,
           fold_count=@fold_count, bypassed=@bypassed`,
      )
      .run({
        key,
        last_fired_at: prior.last_fired_at,
        warsaw_day: prior.day,
        fire_count: prior.fire_count,
        fold_count: prior.fold_count,
        bypassed: prior.bypassed,
      });
  }

  /** A repeat swallowed inside the cooldown window; returns the new fold count. */
  foldSlackCooldown(key: string): number {
    this.db
      .prepare("UPDATE slack_cooldowns SET fold_count = fold_count + 1 WHERE key = ?")
      .run(key);
    return this.slackCooldown(key)?.fold_count ?? 0;
  }
}

// ---- status.json ---------------------------------------------------------

export interface RoundStageBounds {
  first_pass_max_min: number;
  passes_max_min: number;
  running_max_min: number;
  /** Added to the passes limit and the hard cap of a round whose
   * pre-approval sweep is owed — the supervisor's own reading. */
  follow_up_sweep_extra_min?: number;
}

/** What hosts a PR's session, as status.json reports it per PR. Absent means
 * `tmux` (a daemon that predates the field). The TUI's PR pane picks its
 * surface from it (src/tui/viewer.ts `paneSurface`); a value outside this list
 * is read as `tmux`, never guessed at. */
export const PR_RUNTIMES = ["tmux", "worker", "answer", "idle", "debug", "takeover"] as const;
export type PrRuntime = (typeof PR_RUNTIMES)[number];

export interface StatusSnapshot {
  written_at: string;
  dry_run: boolean;
  /** Where the daemon runs (src/runhost.ts). Absent: not reported (an older
   * daemon, or one assembled without its host facts). */
  run_host?: import("./runhost.js").RunHostStatus;
  prs: Array<
    Pick<PrStateRow, "number" | "state" | "title" | "head_sha" | "stale_recheck"> &
      Partial<Pick<PrStateRow, "trigger_ts" | "updated_at" | "author" | "paused">> & {
        /** What hosts this PR's session now. Absent: `tmux`. */
        runtime?: PrRuntime;
        rounds?: number;
        last_verdict?: string | null;
        /** The authoritative running plan/timing. Live lens activity is a
         * separate ephemeral sidecar; neither source impersonates the other. */
        current_round?: Pick<
          RoundRow,
          | "round_no"
          | "round_type"
          | "status"
          | "started_at"
          | "deadline_at"
          | "lenses"
          | "validate_tier"
        > & {
          /** Exact durable delivery identity for correlating the ephemeral Pi
           * sidecar. Absent while the round is still being prepared. */
          command_id?: string;
          command_sha256?: string;
          head_sha?: string;
          /** Finished review waiting on GitHub, not another model round. */
          posting_delivery?: {
            attempts: number;
            next_attempt_at: string;
            last_error?: string;
            /** A deferred POST the daemon retries on a bounded schedule: the first failure. */
            deferred_since?: string;
          };
          /** Immutable command-start-derived bounds. Absent until exact start
           * exists (and on snapshots from older daemons). */
          stage_deadlines?: {
            first_pass_start: string;
            passes_complete: string;
            running_hard_bound: string;
          };
        };
        /** Canonical failure obligation. Presence overrides
         * ordinary lifecycle; `retry_wait` carries its finite automatic exit,
         * while `operator_unwedge` keeps `u` as the required action. */
        review_failure?: Pick<
          ReviewFailureRow,
          | "incident_id"
          | "command_id"
          | "round_no"
          | "head_sha"
          | "stage"
          | "detail"
          | "attempts"
          | "retry_cap"
          | "retry_epoch"
          | "next_retry_at"
          | "failed_at"
          | "next_action"
        >;
        /** The `pause-pr` hold: present exactly while `paused` is 1
         * — who holds it, why, since when, and when it lapses (null = until
         * resumed; operator only). */
        pause?: {
          issuer: LeverIssuer;
          reason: string | null;
          since: string | null;
          expires_at: string | null;
        };
        /** The worker crash-loop breaker: present while the PR has
         * consecutive worker failures on record or is parked. `parked_at` set means
         * no worker is spawned for it until rerun-round or restart-session. */
        worker_crash?: {
          failures: number;
          parked_at: string | null;
          last_error: string | null;
          last_at: string | null;
        };
      }
  >;
  running_rounds: number;
  /** Absent in snapshots written before the TUI additions — readers default. */
  max_concurrent_rounds?: number;
  total_spend_usd: number;
  today_spend_usd?: number;
  digest_headline?: string;
  /** Present while pi sessions are failing API calls with token-expired
   * errors (packages/pi-plugin/src/authwatch.ts, fresh < 30 min). The TUI raises an alert. */
  pi_auth_expired?: { last_at: string; hits: number };
  /** The supervised OpenViking server: reachable, `/ready`, reported
   * version (drift-checked against the pin), RSS and CPU. Absent in snapshots
   * from a daemon with no supervisor wired — readers must default. */
  openviking?: OpenVikingStatus;
  /** Reviewer-memory HEALTH (src/memory/health.ts) — beside the
   * unauthenticated `openviking` block, never instead of it: whether memory
   * actually works with the credentials in use, judged by an authenticated
   * probe per credential and by the daemon's own requests. What a person
   * sees about memory (TUI banner, notification, tracker ticket, `qcr
   * status`, the companion's view) is read from here. Absent in snapshots
   * from an older daemon — readers say "not reported", never "healthy". */
  memory?: MemoryStatus;
  /** The daemon's own load (src/eventloop.ts): `event_loop` — its
   * event-loop delay, p50/p99/max over the last window, the longest stall
   * since start and when, and whether that is a stall (with the cause its
   * evidence names: the cgroup's throttling, the daemon's own CPU time across
   * the stall, or neither) — and `cpu`, the container's CFS throttling over the
   * same window from /sys/fs/cgroup/cpu.stat (UNKNOWN with its reason when
   * that cannot be read). Absent in snapshots from an older daemon — readers
   * say "not reported", never "ok". */
  daemon?: DaemonLoadStatus;
  /** The closed-PR archiver (src/archive/status.ts): its mode and
   * state, why it holds, what it would move (`backlog` — null until its first
   * plan completes, never 0) and what it moved. Absent in snapshots from an
   * older daemon — readers (`readArchiveStatus`) say "not reported". */
  archive?: ArchiveStatus;
  /** The bot login's refresher (src/loginrefresh/): the supervised process
   * and the file it publishes — `expires_at`, `last_refresh`, `last_error`,
   * `paused`. Absent unless `[login_refresh] enabled`; readers say "not
   * reported". */
  login_refresh?: LoginRefreshStatus;
  /** The central lens permit broker (src/ipc/permits.ts): the ceiling,
   * the permits in use and the grants queued, with the split per command.
   * Absent while no daemon broker runs (the tmux bot, a stub daemon) —
   * readers say "not reported". */
  permits?: PermitStatus;
  /** Deploy-window drain: present (and true) only while
   * draining, beside the count of webhook deliveries dropped so far and when
   * the drain was engaged. Absent in older snapshots — readers default to
   * "not draining". */
  draining?: boolean;
  drained_deliveries?: number;
  draining_since?: string;
  /** Who holds the drain and when it lapses; `draining_until` is
   * absent for the operator's until-lifted hold. Present only while draining. */
  draining_by?: LeverIssuer;
  draining_until?: string;
  /** Why a system engaged the drain (`worker_failures`); absent for a hand-set one. */
  draining_reason?: string;
  /** The operator's no-auto-lift HOLD: true when no boot lifts this
   * drain (only `qcr drain off`), false when the next healthy boot would.
   * Always written while draining by a daemon that knows holds; ABSENT from
   * an older daemon's snapshot, which readers must show as unknown. */
  draining_hold?: boolean;
  /** Terminal FAILED_LOUD obligations are visible during drain but do not
   * count as live rounds; operator recovery remains dormant until drain lifts. */
  drain_failed_loud?: number;
  /** Local correctness supervisor. A fresh process heartbeat with a
   * stale/failed scan is pipeline-unhealthy, not healthy. */
  round_stage_supervisor?: RoundStageSupervisorHealth;
  /** Review-pipeline health, separate from process liveness. Cause
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
      retry_epoch?: number;
      next_retry_at?: string;
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
  /** Thread-decision watcher: global breaker and durable backlog health. */
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

/**
 * The status snapshot's `pipeline` block alone — what `GET /health` serves,
 * without building the whole snapshot (every PR, every round) on each probe,
 * so the probe that measures a stalled loop does not itself stall it. Absent
 * exactly when the snapshot would omit it.
 */
export function buildPipelineStatus(
  store: StateStore,
  at: Date,
  roundStageSupervisor?: StatusSnapshot["round_stage_supervisor"],
): StatusSnapshot["pipeline"] {
  return pipelineFrom(store, at, store.openReviewFailures(), roundStageSupervisor);
}

function pipelineFrom(
  store: StateStore,
  at: Date,
  failures: ReturnType<StateStore["openReviewFailures"]>,
  roundStageSupervisor: StatusSnapshot["round_stage_supervisor"] | undefined,
): StatusSnapshot["pipeline"] {
  const pipelineCauses: NonNullable<StatusSnapshot["pipeline"]>["causes"] = failures.map(
    (failure) => ({
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
      retry_epoch: failure.retry_epoch,
      ...(failure.next_retry_at ? { next_retry_at: failure.next_retry_at } : {}),
      age_s: Math.max(0, Math.floor((at.getTime() - Date.parse(failure.failed_at)) / 1000)),
    }),
  );
  if (roundStageSupervisor && !roundStageSupervisor.healthy) {
    const since =
      roundStageSupervisor.last_error_at ??
      roundStageSupervisor.last_attempt_at ??
      at.toISOString();
    pipelineCauses.push({
      key: "round-stage-supervisor",
      pr: null,
      since,
      stage: "supervisor",
      detail: roundStageSupervisor.last_error ?? "round-stage supervisor lease is stale",
      next_action: "inspect-supervisor",
      age_s: Math.max(0, Math.floor((at.getTime() - Date.parse(since)) / 1000)),
    });
  }
  pipelineCauses.sort((a, b) => a.key.localeCompare(b.key));
  const oldest = [...pipelineCauses].sort((a, b) => a.since.localeCompare(b.since))[0];
  const recoveries = store
    .recentReviewRecoveries(new Date(at.getTime() - 10 * 60_000).toISOString())
    .map((failure) => ({
      key: failure.incident_id,
      pr: failure.pr,
      recovered_at: failure.recovered_at!,
      recovery: failure.recovery,
    }));
  if (!roundStageSupervisor && pipelineCauses.length === 0) return undefined;
  return {
    healthy: pipelineCauses.length === 0,
    failed_loud: failures.length,
    causes: pipelineCauses,
    recoveries,
    ...(oldest
      ? {
          oldest_expired: {
            key: oldest.key,
            pr: oldest.pr,
            since: oldest.since,
            stage: oldest.stage,
            detail: oldest.detail,
            next_action: oldest.next_action,
            age_s: oldest.age_s,
          },
        }
      : {}),
  };
}

/**
 * The heartbeat's per-PR round count and latest verdict — every 30 s over the
 * whole `rounds` table, closed-PR history included, which stays live
 * (docs/archiving.md §4). Exported so the index that keeps it a walk of
 * `rounds_pr_round` rather than a scan per PR is pinned against THIS text
 * (tests/archive-schema.test.ts).
 */
export const ROUND_STATS_SQL =
  "SELECT pr, COUNT(*) AS c, (SELECT verdict FROM rounds r2 WHERE r2.pr = rounds.pr AND verdict IS NOT NULL ORDER BY round_no DESC LIMIT 1) AS v FROM rounds WHERE status != 'expired' GROUP BY pr";

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
  roundStageBounds?: RoundStageBounds,
  memory?: MemoryStatus,
  daemonLoad?: DaemonLoadStatus,
  archive?: ArchiveStatus,
  loginRefresh?: LoginRefreshStatus,
  permits?: PermitStatus,
  runtimeOf?: (pr: number) => PrRuntime | undefined,
): StatusSnapshot {
  const at = now();
  const today = at.toISOString().slice(0, 10);
  const drain = store.drainState();
  // Expired zombie rounds stay out of the per-PR round COUNTS — but they DO
  // count in every spend aggregate (below).
  const roundStats = store.db.prepare(ROUND_STATS_SQL).all() as Array<{
    pr: number;
    c: number;
    v: string | null;
  }>;
  const byPr = new Map(roundStats.map((r) => [r.pr, r]));
  const runningByPr = new Map(store.runningRounds().map((r) => [r.pr, r]));
  const failures = store.openReviewFailures();
  const failureByPr = new Map(failures.map((failure) => [failure.pr, failure]));
  const pipeline = pipelineFrom(store, at, failures, roundStageSupervisor);
  const crashByPr = new Map(store.workerBreakerRows().map((row) => [row.pr, row]));
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
              ...(() => {
                const round = runningByPr.get(p.number)!;
                const command = store.sessionCommandForRound(p.number, round.round_no);
                const postingHead = round.posting_key
                  ? postingKeyHead(round.posting_key, p.number, round.round_no)
                  : undefined;
                const identity = command
                  ? {
                      command_id: command.id,
                      command_sha256: command.payload_sha256,
                      ...(postingHead ? { head_sha: postingHead } : {}),
                    }
                  : {};
                if (!command?.started_at || !roundStageBounds) return identity;
                const started = Date.parse(command.started_at);
                if (!Number.isFinite(started)) return identity;
                const deadlines = roundStageDeadlines(
                  started,
                  roundStageBounds,
                  round.sweep_owed === 1,
                );
                return {
                  ...identity,
                  stage_deadlines: {
                    first_pass_start: new Date(deadlines.first_pass_start).toISOString(),
                    passes_complete: new Date(deadlines.passes_complete).toISOString(),
                    running_hard_bound: new Date(deadlines.running_hard_bound).toISOString(),
                  },
                };
              })(),
            },
          }
        : {}),
      ...(() => {
        const runtime = runtimeOf?.(p.number);
        return runtime === undefined ? {} : { runtime };
      })(),
      number: p.number,
      state: p.state,
      title: p.title,
      head_sha: p.head_sha,
      stale_recheck: p.stale_recheck,
      trigger_ts: p.trigger_ts,
      updated_at: p.updated_at,
      author: p.author,
      paused: p.paused,
      ...(p.paused
        ? {
            pause: {
              issuer: p.pause_issuer ?? "operator",
              reason: p.pause_reason,
              since: p.pause_since,
              expires_at: p.pause_expires_at,
            },
          }
        : {}),
      ...(crashByPr.get(p.number)
        ? {
            worker_crash: {
              failures: crashByPr.get(p.number)!.failures,
              parked_at: crashByPr.get(p.number)!.parked_at,
              last_error: crashByPr.get(p.number)!.last_error,
              last_at: crashByPr.get(p.number)!.last_failure_at,
            },
          }
        : {}),
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
              retry_epoch: failureByPr.get(p.number)!.retry_epoch,
              next_retry_at: failureByPr.get(p.number)!.next_retry_at,
              failed_at: failureByPr.get(p.number)!.failed_at,
              next_action: failureByPr.get(p.number)!.next_action,
            },
          }
        : {}),
    })),
    running_rounds: store.runningRounds().length,
    ...(maxConcurrentRounds !== undefined ? { max_concurrent_rounds: maxConcurrentRounds } : {}),
    total_spend_usd: store.totalSpend(),
    today_spend_usd: roundUsage(store.roundsOn(today)).spend_usd,
    ...(digestHeadline ? { digest_headline: digestHeadline } : {}),
    ...(piAuth
      ? {
          pi_auth_expired: piAuth,
          provider: {
            healthy: false,
            detail: `pi auth expired (${piAuth.hits} hit${piAuth.hits === 1 ? "" : "s"})`,
            last_at: piAuth.last_at,
          },
        }
      : {}),
    ...(openviking ? { openviking } : {}),
    ...(memory ? { memory } : {}),
    ...(daemonLoad ? { daemon: daemonLoad } : {}),
    ...(archive ? { archive } : {}),
    ...(loginRefresh ? { login_refresh: loginRefresh } : {}),
    ...(permits ? { permits } : {}),
    ...(threadDecisions ? { thread_decisions: threadDecisions } : {}),
    ...(roundStageSupervisor ? { round_stage_supervisor: roundStageSupervisor } : {}),
    ...(pipeline ? { pipeline } : {}),
    ...(drain.draining
      ? {
          draining: true,
          drained_deliveries: drain.drained_deliveries,
          ...(drain.since ? { draining_since: drain.since } : {}),
          draining_by: drain.issued_by,
          ...(drain.expires_at ? { draining_until: drain.expires_at } : {}),
          ...(drain.reason ? { draining_reason: drain.reason } : {}),
          draining_hold: drain.hold,
          drain_failed_loud: failures.length,
        }
      : {}),
    heartbeat: at.toISOString(),
  };
}

// The PR lifecycle state machine (spec §3 "Daemon", §4 "PR sessions").
//
// ASSUMPTION:'s transition table is cited by the spec but the ticket
// body was not available to this build session; the table below is derived
// from spec §3/§4/§8 and the B2 brief, and is the authoritative version until
// is reconciled against it. Every row is unit-tested.
//
// States (state.ts `PrLifecycleState`):
//   tracked         known, no work owed — includes "reviewed & approved"
//   queued          a trigger is outstanding; waiting for a dispatch slot
//   reviewing       a round is running (trigger already consumed)
//   awaiting_author REQUEST_CHANGES posted; the author owes a push/reply
//   awaiting_human  escalated — the human reviewer owns it (never auto-approved)
//   closed          merged or closed; session archived, worktree dropped
// Plus the `stale_recheck` flag: set when the staleness scan finds an approved
// review whose commit no longer matches head; cleared when the round dispatches.
//
// ┌─────────────────┬──────────────────────────────────────────────────────────┐
// │ event \ state   │ tracked   queued   reviewing  awaiting_  awaiting_ closed │
// │                 │                                author    human           │
// ├─────────────────┼──────────────────────────────────────────────────────────┤
// │ track           │ tracked   queued   reviewing  aw_author  aw_human  closed │  (idempotent adopt)
// │ trigger         │ queued    queued   reviewing¹ queued     queued    closed²│
// │ stale_detected  │ queued    queued   reviewing¹ queued     aw_human³ closed │
// │ dispatched      │ reviewing reviewing reviewing reviewing  reviewing closed⁴│
// │ verdict APPROVE │ tracked   tracked  tracked    tracked    aw_human⁵ closed │
// │ verdict R_C     │ aw_author aw_author aw_author aw_author  aw_human⁵ closed │
// │ verdict ESCAL.  │ aw_human  aw_human aw_human   aw_human   aw_human  closed │
// │ round_overdue   │ aw_human  aw_human aw_human   aw_human   aw_human  closed │  (never an approve path)
// │ author_reply    │ tracked   queued   reviewing  aw_author  aw_human  closed │  (ping-pong: no lifecycle change)
// │ synchronize     │ tracked⁶  queued   reviewing¹ queued     aw_human³ closed │
// │ escalation_det. │ aw_human  queued⁷  reviewing⁷ aw_human   aw_human  closed │
// │ closed          │ closed    closed   closed     closed     closed    closed │
// │ reopened        │ tracked   queued   reviewing  aw_author  aw_human  tracked│
// └─────────────────┴──────────────────────────────────────────────────────────┘
// ¹ a trigger arriving mid-round is not lost: the round in flight covers the
//   current head, and the reconcile poll re-derives the triggered set after it
//   finishes (GitHub truth wins — spec §3).
// ² closed is terminal for the lifecycle; a reopened PR must first `reopened`.
// ³ once escalated, the human owns the PR: pushes and staleness do not pull it
//   back into the AI queue. Only an explicit re-trigger does.
// ⁴ dispatch never runs against a closed PR (dispatch filters on `queued`).
// ⁵ a verdict cannot demote an escalation: awaiting_human is sticky against
//   APPROVE/REQUEST_CHANGES — the never-auto-approve-an-escalation invariant.
// ⁶ pushes to an untriggered PR do nothing: "triggered PRs only, no sweeps"
//   (spec §8). Staleness (an approved review going stale) is the exception.
// ⁷ the escalation reviewer being requested while a round is queued/running
//   does not cancel the round; the verdict then lands on awaiting_human.
//
// The never-retract-an-approval invariant is structural: no event and no
// transition in this module touches an existing review (spec §8).
import type { PrLifecycleState, StateStore } from "./state.js";

export type SmEventType =
  | "track"
  | "trigger"
  | "stale_detected"
  | "dispatched"
  | "verdict"
  | "round_overdue"
  | "author_reply"
  | "synchronize"
  | "escalation_detected"
  | "closed"
  | "reopened";

export type SmEvent =
  | { type: "track" }
  | { type: "trigger"; source: "label" | "team_request" | "manual" | "reconcile" }
  | { type: "stale_detected" }
  | { type: "dispatched" }
  | { type: "verdict"; verdict: "APPROVE" | "REQUEST_CHANGES" | "ESCALATE" }
  | { type: "round_overdue" }
  | { type: "author_reply" }
  | { type: "synchronize" }
  | { type: "escalation_detected" }
  | { type: "closed" }
  | { type: "reopened" };

/** State a PR enters when first adopted (webhook or reconcile). */
export const INITIAL_STATE: PrLifecycleState = "tracked";

/** Pure transition. Unknown combinations keep the current state (no-op). */
export function transition(current: PrLifecycleState, event: SmEvent): PrLifecycleState {
  if (event.type === "closed") return "closed";
  if (event.type === "reopened") return current === "closed" ? "tracked" : current;
  if (current === "closed") return "closed";

  switch (event.type) {
    case "track":
      return current;

    case "trigger":
      if (current === "reviewing") return "reviewing";
      return "queued";

    case "stale_detected":
      if (current === "reviewing") return "reviewing";
      if (current === "awaiting_human") return "awaiting_human";
      return "queued";

    case "dispatched":
      return "reviewing";

    case "verdict":
      if (event.verdict === "ESCALATE") return "awaiting_human";
      if (current === "awaiting_human") return "awaiting_human";
      return event.verdict === "REQUEST_CHANGES" ? "awaiting_author" : "tracked";

    case "round_overdue":
      return "awaiting_human";

    case "author_reply":
      return current;

    case "synchronize":
      if (current === "awaiting_author") return "queued";
      if (current === "tracked" || current === "reviewing" || current === "queued" || current === "awaiting_human")
        return current;
      return current;

    case "escalation_detected":
      if (current === "queued" || current === "reviewing") return current;
      return "awaiting_human";
  }
}

/** Bot-authored PRs never enter the machine (spec §3, §2). */
export function isBotAuthor(author: string, botLogin: string): boolean {
  return author === botLogin || author.endsWith("[bot]");
}

export interface PrMeta {
  title?: string;
  head_sha?: string;
  author?: string;
  trigger_ts?: string | null;
}

export interface ApplyResult {
  pr: number;
  from: PrLifecycleState | null;
  to: PrLifecycleState;
  changed: boolean;
  skipped?: "bot-author";
}

/** Apply an event to the store: upsert the row, transition, maintain the
 * `stale_recheck` flag and `trigger_ts`, and log the transition. */
export function applyEvent(
  store: StateStore,
  pr: number,
  event: SmEvent,
  meta: PrMeta = {},
  opts: { botLogin?: string; now?: () => Date; reason?: string } = {},
): ApplyResult {
  const now = opts.now ?? (() => new Date());
  const existing = store.getPr(pr);
  const author = meta.author ?? existing?.author ?? "";
  if (opts.botLogin && author && isBotAuthor(author, opts.botLogin)) {
    return { pr, from: existing?.state ?? null, to: existing?.state ?? INITIAL_STATE, changed: false, skipped: "bot-author" };
  }

  const from = existing?.state ?? null;
  const base = existing?.state ?? INITIAL_STATE;
  const to = transition(base, event);

  let staleRecheck = existing?.stale_recheck ?? 0;
  if (event.type === "stale_detected") staleRecheck = 1;
  if (event.type === "dispatched") staleRecheck = 0;

  let triggerTs = meta.trigger_ts !== undefined ? meta.trigger_ts : (existing?.trigger_ts ?? null);
  if (event.type === "trigger" || event.type === "stale_detected" || event.type === "synchronize") {
    if (to === "queued" && !triggerTs) triggerTs = now().toISOString();
  }
  if (event.type === "dispatched") triggerTs = null;

  store.upsertPr({
    number: pr,
    state: to,
    head_sha: meta.head_sha ?? existing?.head_sha ?? "",
    title: meta.title ?? existing?.title ?? "",
    author,
    trigger_ts: triggerTs,
    stale_recheck: staleRecheck,
    escalation_worthy: existing?.escalation_worthy ?? 0,
    migration_gate: existing?.migration_gate ?? 0,
  });

  const changed = from !== to;
  if (changed || event.type === "trigger" || event.type === "stale_detected") {
    store.logEvent("pr_transition", pr, { from, to, event: event.type, reason: opts.reason ?? null });
  }
  return { pr, from, to, changed };
}

/** Persist dispatch-time gate results on the PR row (used by dispatch). */
export function setPrGates(store: StateStore, pr: number, escalationWorthy: boolean, migrationGate: boolean): void {
  const row = store.getPr(pr);
  if (!row) return;
  store.upsertPr({
    number: row.number,
    state: row.state,
    head_sha: row.head_sha,
    title: row.title,
    author: row.author,
    trigger_ts: row.trigger_ts,
    stale_recheck: row.stale_recheck,
    escalation_worthy: escalationWorthy ? 1 : 0,
    migration_gate: migrationGate ? 1 : 0,
  });
}

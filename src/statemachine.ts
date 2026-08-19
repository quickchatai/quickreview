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
//   awaiting_human  parked for a person — the round ended without a decision
//                   (never auto-approved). NOTE (2026-08-18): the escalation
//                   mechanics were scrapped; reaching this state no longer
//                   requests a reviewer on GitHub. It is a daemon-side park,
//                   surfaced in the TUI and Slack, cleared by a re-trigger.
//   closed          merged or closed; session archived, worktree dropped
// `stale_recheck` remains as legacy state for old rows/rounds; ordinary pushes
// never set it or queue work. Only an explicit review re-request starts a round.
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
// │ verdict N_HUMAN │ aw_human  aw_human aw_human   aw_human   aw_human  closed │
// │ round_overdue   │ aw_human  aw_human aw_human   aw_human   aw_human  closed │  (never an approve path)
// │ author_reply    │ tracked   queued   reviewing  aw_author  aw_human  closed │  (ping-pong: no lifecycle change)
// │ synchronize     │ tracked   queued   reviewing  aw_author  aw_human  closed │
// │ human_requested │ aw_human  queued⁷  reviewing⁷ aw_human   aw_human  closed │
// │ closed          │ closed    closed   closed     closed     closed    closed │
// │ reopened        │ tracked   queued   reviewing  aw_author  aw_human  tracked│
// └─────────────────┴──────────────────────────────────────────────────────────┘
// ¹ a trigger arriving mid-round is not lost: the round in flight covers the
//   current head, and the reconcile poll re-derives the triggered set after it
//   finishes (GitHub truth wins — spec §3).
// ² closed is terminal for the lifecycle; a reopened PR must first `reopened`.
// ³ once parked, the human owns the PR. Only an explicit re-trigger queues
//   another full review.
// ⁴ dispatch never runs against a closed PR (dispatch filters on `queued`).
// ⁵ a verdict cannot un-park a PR: awaiting_human is sticky against
//   APPROVE/REQUEST_CHANGES — the never-auto-approve-a-parked-PR invariant.
// ⁷ an author asking for a human mid-round does not cancel the round; the
//   verdict then lands on awaiting_human.
//
// The never-retract-an-approval invariant is structural: no event and no
// transition in this module touches an existing review (spec §8).
import type { PrLifecycleState, StateStore, TriggerProvenance } from "./state.js";
import type { Verdict } from "./types.js";

export type SmEventType =
  | "track"
  | "trigger"
  | "stale_detected"
  | "dispatched"
  | "verdict"
  | "round_overdue"
  | "author_reply"
  | "synchronize"
  | "human_requested"
  | "closed"
  | "reopened";

export type SmEvent =
  | { type: "track" }
  | { type: "trigger"; source: "label" | "team_request" | "manual" | "reconcile" }
  | { type: "stale_detected" }
  | { type: "dispatched" }
  | { type: "verdict"; verdict: Verdict }
  | { type: "round_overdue" }
  | { type: "author_reply" }
  | { type: "synchronize" }
  /** Someone asked for a person on this PR (author ping-pong `human_requested`).
   * Parks it; no GitHub reviewer is requested. */
  | { type: "human_requested" }
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
      if (event.verdict === "NEEDS_HUMAN") return "awaiting_human";
      if (current === "awaiting_human") return "awaiting_human";
      return event.verdict === "REQUEST_CHANGES" ? "awaiting_author" : "tracked";

    case "round_overdue":
      return "awaiting_human";

    case "author_reply":
      return current;

    case "synchronize":
      // A push refreshes metadata only. Full reviews are explicit: trigger
      // label or configured team review request.
      return current;

    case "human_requested":
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

  // Trigger provenance: who asked for the queued round. A fresh
  // label / team re-review request / manual trigger is a HUMAN ask; a
  // reconcile re-derivation, CI-green retry or staleness detection is SYSTEM.
  // Human sticks while the PR is queued — a system re-trigger never
  // downgrades a pending human ask — and dispatch clears it with the trigger.
  let provenance: TriggerProvenance | null = existing?.trigger_provenance ?? null;
  if ((event.type === "trigger" || event.type === "stale_detected") && to === "queued") {
    const fresh: TriggerProvenance =
      event.type === "trigger" && event.source !== "reconcile" ? "human" : "system";
    if (fresh === "human" || !(base === "queued" && provenance === "human")) provenance = fresh;
  }
  // An author reply on a queued PR is a person expecting attention:
  // the queued round dispatches in full whoever queued it first.
  if (event.type === "author_reply" && base === "queued") provenance = "human";
  if (event.type === "dispatched") provenance = null;

  store.upsertPr({
    number: pr,
    state: to,
    head_sha: meta.head_sha ?? existing?.head_sha ?? "",
    title: meta.title ?? existing?.title ?? "",
    author,
    trigger_ts: triggerTs,
    trigger_provenance: provenance,
    stale_recheck: staleRecheck,
    migration_gate: existing?.migration_gate ?? 0,
  });

  const changed = from !== to;
  if (changed || event.type === "trigger" || event.type === "stale_detected") {
    store.logEvent("pr_transition", pr, { from, to, event: event.type, reason: opts.reason ?? null });
  }
  return { pr, from, to, changed };
}

/** Persist the dispatch-time migration gate on the PR row (used by dispatch). */
export function setPrGates(store: StateStore, pr: number, migrationGate: boolean): void {
  const row = store.getPr(pr);
  if (!row) return;
  store.upsertPr({
    number: row.number,
    state: row.state,
    head_sha: row.head_sha,
    title: row.title,
    author: row.author,
    trigger_ts: row.trigger_ts,
    trigger_provenance: row.trigger_provenance,
    stale_recheck: row.stale_recheck,
    migration_gate: migrationGate ? 1 : 0,
  });
}

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
//   awaiting_human  RETIRED (the owner, 2026-08-19): the review is never handed
//                   to a human — the AI decides on the merits and keeps
//                   driving, attaching a "for a human to double-check" list
//                   where it is unsure. The enum value remains valid only for
//                   legacy rows; NOTHING transitions into it any more, and the
//                   reconcile poll migrates lingering rows to their
//                   verdict-implied state.
//   closed          merged or closed; session archived, worktree dropped
// `stale_recheck` remains as legacy state for old rows/rounds; ordinary pushes
// never set it or queue work. Only an explicit review re-request starts a round.
// `stale_recheck` + `trigger_ts` are cleared on dispatch AND on verdict/
// round_overdue: a settled PR carries no trigger residue, and the
// reconcile poll sweeps any legacy residue (a tracked/awaiting_author PR with
// no round running never legitimately holds either).
//
// ┌─────────────────┬──────────────────────────────────────────────────────────┐
// │ event \ state   │ tracked   queued   reviewing  awaiting_  (legacy)  closed │
// │                 │                                author    aw_human         │
// ├─────────────────┼──────────────────────────────────────────────────────────┤
// │ track           │ tracked   queued   reviewing  aw_author  aw_human  closed │  (idempotent adopt)
// │ trigger         │ queued    queued   reviewing¹ queued     queued    closed²│
// │ stale_detected  │ queued    queued   reviewing¹ queued     queued    closed │
// │ dispatched      │ reviewing reviewing reviewing reviewing  reviewing closed³│
// │ verdict APPROVE │ tracked   tracked  tracked    tracked    tracked   closed │
// │ verdict R_C     │ aw_author aw_author aw_author aw_author  aw_author closed │
// │ verdict N_HUMAN │ tracked   tracked  tracked    tracked    tracked   closed │  (legacy input: review posted, no approval — AI keeps driving)
// │ round_overdue   │ standing⁴ standing⁴ standing⁴ standing⁴  standing⁴ closed │  (never an approve path)
// │ author_reply    │ tracked   queued   reviewing  aw_author  aw_human  closed │  (ping-pong: no lifecycle change)
// │ synchronize     │ tracked   queued   reviewing  aw_author  aw_human  closed │
// │ human_requested │ tracked   queued   reviewing  aw_author  aw_human  closed │  (noted, never a handover — AI keeps working)
// │ closed          │ closed    closed   closed     closed     closed    closed │
// │ reopened        │ tracked   queued   reviewing  aw_author  aw_human  tracked│
// └─────────────────┴──────────────────────────────────────────────────────────┘
// ¹ a trigger arriving mid-round is not lost: the round in flight covers the
//   current head, and the reconcile poll re-derives the triggered set after it
//   finishes (GitHub truth wins — spec §3).
// ² closed is terminal for the lifecycle; a reopened PR must first `reopened`.
// ³ dispatch never runs against a closed PR (dispatch filters on `queued`).
// ⁴ a blown/malformed round returns the PR to the state its STANDING verdict
//   implies (REQUEST_CHANGES ⇒ awaiting_author, anything else ⇒ tracked),
//   carried on the event by the caller. No park: the AI keeps driving; the
//   anomaly + self-requeue cap are the safety net (the owner, 2026-08-19).
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
  /** `standing` = the PR's last applied verdict (normalized), so the return
   * state can be derived without a park. Absent ⇒ tracked. */
  | { type: "round_overdue"; standing?: Verdict | null }
  | { type: "author_reply" }
  | { type: "synchronize" }
  /** Someone asked for a person on this PR (author ping-pong `human_requested`).
   * Noted for the record only — the AI keeps driving (the owner, 2026-08-19):
   * never a handover, never a park, no GitHub reviewer requested. */
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
      return "queued";

    case "dispatched":
      return "reviewing";

    case "verdict":
      // NEEDS_HUMAN is retired as an outcome (the owner, 2026-08-19): a legacy
      // session emitting it posted its review without an approval — the PR
      // stays in normal flow and the AI keeps driving. Never a park.
      if (event.verdict === "NEEDS_HUMAN") return "tracked";
      return event.verdict === "REQUEST_CHANGES" ? "awaiting_author" : "tracked";

    case "round_overdue":
      // No park: return to the standing verdict's state. Never an approve
      // path — "tracked" here means "known, no work owed", not approved.
      return event.standing === "REQUEST_CHANGES" ? "awaiting_author" : "tracked";

    case "author_reply":
      return current;

    case "synchronize":
      // A push refreshes metadata only. Full reviews are explicit: trigger
      // label or configured team review request.
      return current;

    case "human_requested":
      return current;
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
  const runningRound = base === "reviewing"
    ? store.runningRounds().find((round) => round.pr === pr)
    : undefined;
  const advancedHead = runningRound && meta.head_sha && existing?.head_sha && meta.head_sha !== existing.head_sha
    ? meta.head_sha
    : undefined;

  let staleRecheck = existing?.stale_recheck ?? 0;
  if (event.type === "stale_detected") staleRecheck = 1;
  if (event.type === "dispatched") staleRecheck = 0;
  // A settled round leaves no trigger residue: a verdict or blown
  // round lands the PR in tracked/awaiting_author, and a stale_recheck flag or
  // trigger_ts surviving there would misclassify the NEXT explicit re-review
  // as a staleness round (dispatch roundTypeFor) and let it jump the FIFO.
  if (event.type === "verdict" || event.type === "round_overdue") staleRecheck = 0;

  let triggerTs = meta.trigger_ts !== undefined ? meta.trigger_ts : (existing?.trigger_ts ?? null);
  if (event.type === "trigger" || event.type === "stale_detected" || event.type === "synchronize") {
    if (to === "queued" && !triggerTs) triggerTs = now().toISOString();
  }
  if (event.type === "dispatched" || event.type === "verdict" || event.type === "round_overdue") triggerTs = null;

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

  if (runningRound && advancedHead && (event.type === "synchronize" || event.type === "track" || event.type === "trigger")) {
    store.recordSuccessor({
      pr,
      predecessor_round_id: runningRound.id,
      head_sha: advancedHead,
      provenance: event.type === "trigger" && event.source !== "reconcile" ? "human" : "system",
      reason: event.type === "trigger" ? "trigger-on-new-head" : "head-advanced",
    });
  } else if (runningRound && event.type === "trigger") {
    // A same-head request is already covered by the active round. If a newer
    // head is already owed, however, retain that target and upgrade its
    // provenance when this was a fresh human request.
    const successor = store.successorFor(pr);
    if (successor) {
      store.recordSuccessor({
        pr,
        predecessor_round_id: runningRound.id,
        head_sha: successor.head_sha,
        provenance: event.source === "reconcile" ? "system" : "human",
        reason: "trigger-while-reviewing",
      });
    }
  }
  if (event.type === "closed") store.clearSuccessor(pr, "pr-closed");

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

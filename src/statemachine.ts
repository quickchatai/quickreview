// The PR lifecycle state machine (spec §3 "Daemon", §4 "PR sessions").
//
// The transition table below is derived from spec §3/§4/§8 and is the
// authoritative version until it is read back against the transition table
// the spec cites. Every row is unit-tested.
//
// States (state.ts `PrLifecycleState`):
//   tracked         known, no work owed — includes "reviewed & approved"
//   queued          a trigger is outstanding; waiting for a dispatch slot
//   reviewing       a round is running (trigger already consumed)
//   awaiting_author REQUEST_CHANGES posted; the author owes a push/reply
//   closed          merged or closed; session archived, worktree dropped
//
// There is no "awaiting human" state: the review is never handed to a human —
// the AI decides on the merits and keeps driving, attaching a "for a human to
// double-check" list where it is unsure. Nothing here can produce such a state.
// `stale_recheck` remains as legacy state for old rows/rounds; ordinary pushes
// never set it. A push to an idle PR queues no work — only an explicit review
// re-request starts a round — but a push while a round is running is recorded
// as durable successor work (`recordSuccessor`), queued once that round
// settles.
// `stale_recheck` + `trigger_ts` are cleared on dispatch AND on verdict/
// round_overdue/closed: a settled PR carries no trigger residue, and the
// reconcile poll sweeps any legacy residue (a tracked/awaiting_author PR with
// no round running never legitimately holds either).
//
// ┌─────────────────┬────────────────────────────────────────────────┐
// │ event \ state   │ tracked   queued   reviewing  awaiting_  closed │
// │                 │                                author           │
// ├─────────────────┼────────────────────────────────────────────────┤
// │ track           │ tracked   queued   reviewing  aw_author  closed │  (idempotent adopt)
// │ trigger         │ queued    queued   reviewing¹ queued     closed²│
// │ stale_detected  │ queued    queued   reviewing¹ queued     closed │
// │ dispatched      │ reviewing reviewing reviewing reviewing  closed³│
// │ verdict APPROVE │ tracked   tracked  tracked    tracked    closed │
// │ verdict R_C     │ aw_author aw_author aw_author aw_author  closed │
// │ verdict N_HUMAN │ tracked   tracked  tracked    tracked    closed │  (legacy input: review posted, no approval — AI keeps driving)
// │ round_overdue   │ standing⁴ standing⁴ standing⁴ standing⁴  closed │  (never an approve path)
// │ author_reply    │ tracked   queued   reviewing  aw_author  closed │  (ping-pong: no lifecycle change)
// │ synchronize     │ tracked   queued   reviewing  aw_author  closed │
// │ human_requested │ tracked   queued   reviewing  aw_author  closed │  (noted, never a handover — AI keeps working)
// │ closed          │ closed    closed   closed     closed     closed │
// │ reopened        │ tracked   queued   reviewing  aw_author  tracked│
// └─────────────────┴────────────────────────────────────────────────┘
// ¹ a trigger arriving mid-round is not lost: the round in flight covers the
//   head it started on, a newer head is recorded as durable successor work
//   (`recordSuccessor`, promoted when the round settles), and the reconcile
//   poll re-derives the triggered set after it finishes (GitHub truth wins —
//   spec §3).
// ² closed is terminal for the lifecycle; a reopened PR must first `reopened`.
// ³ dispatch never runs against a closed PR (dispatch filters on `queued`).
// ⁴ a blown/malformed round returns the PR to the state its STANDING verdict
//   implies (REQUEST_CHANGES ⇒ awaiting_author, anything else ⇒ tracked),
//   carried on the event by the caller. No park: the AI keeps driving; the
//   anomaly + self-requeue cap are the safety net.
//
// The never-retract-an-approval invariant is structural: no event and no
// transition in this module touches an existing review (spec §8).
import type { PrLifecycleState, StateStore, TriggerProvenance } from "./state.js";
import { isBotAuthor } from "./guards.js";
import { standingLifecycleState, type StandingDecidedVerdict } from "./standing-review.js";
import type { Verdict } from "./types.js";

/** Every event name. `applyEvent` types the name it logs as this union, so an
 * `SmEvent` member it does not list fails to compile, and the fences that read
 * this union see the vocabulary `transition` consumes. */
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
   * Noted for the record only — the AI keeps driving:
   * never a handover, never a park, no GitHub reviewer requested. */
  | { type: "human_requested" }
  | { type: "closed" }
  | { type: "reopened" };

/** Who asked for the round a trigger queues: a fresh label / team re-review
 * request / manual trigger is a HUMAN ask; a reconcile re-derivation, CI-green
 * retry or staleness detection is SYSTEM. */
function triggerProvenance(event: SmEvent): TriggerProvenance {
  return event.type === "trigger" && event.source !== "reconcile" ? "human" : "system";
}

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
      // NEEDS_HUMAN is not an outcome; a legacy
      // session emitting it posted its review without an approval — the PR
      // stays in normal flow (tracked) and the AI keeps driving. Never a park.
      return standingLifecycleState(event.verdict);

    case "round_overdue":
      // No park: return to the standing verdict's state. Never an approve
      // path — "tracked" here means "known, no work owed", not approved.
      return standingLifecycleState(event.standing);

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

/** A merge landing over a standing REQUEST_CHANGES — the feedback signal both
 * close paths (the webhook and reconcile's closed-sync) derive, read off the
 * lifecycle state from BEFORE the close is applied. */
export function mergedOverBlock(
  merged: boolean,
  priorState: PrLifecycleState | undefined,
): boolean {
  return merged && priorState === "awaiting_author";
}

/** Bot-authored PRs never enter the machine (spec §3). The predicate lives
 * with the posting guards (src/guards.ts), which read a bot's approval as no
 * human's. */
export { isBotAuthor };

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
  return store.db.transaction(() => applyEventTransaction(store, pr, event, meta, opts))();
}

function applyEventTransaction(
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
    return {
      pr,
      from: existing?.state ?? null,
      to: existing?.state ?? INITIAL_STATE,
      changed: false,
      skipped: "bot-author",
    };
  }

  const from = existing?.state ?? null;
  const base = existing?.state ?? INITIAL_STATE;
  const to = transition(base, event);
  const runningRound =
    base === "reviewing" ? store.runningRounds().find((round) => round.pr === pr) : undefined;
  const advancedHead =
    runningRound && meta.head_sha && existing?.head_sha && meta.head_sha !== existing.head_sha
      ? meta.head_sha
      : undefined;

  // The events that consume the trigger: `dispatched` starts its round, and a
  // `verdict` or `round_overdue` settles one — or settles a trigger that never
  // dispatched (the no-new-evidence skip). Each clears `stale_recheck`,
  // `trigger_ts` and the provenance together. A settled PR carries no trigger
  // residue: a stale_recheck flag or trigger_ts surviving in
  // tracked/awaiting_author would misclassify the NEXT explicit re-review as a
  // staleness round (dispatch roundTypeFor) and let it jump the FIFO, and a
  // "human" provenance would read to the exact-head retirement as a fresh ask.
  const consumesTrigger =
    event.type === "dispatched" ||
    event.type === "verdict" ||
    event.type === "round_overdue" ||
    event.type === "closed";

  let staleRecheck = existing?.stale_recheck ?? 0;
  if (event.type === "stale_detected") staleRecheck = 1;
  if (consumesTrigger) staleRecheck = 0;

  let triggerTs = meta.trigger_ts !== undefined ? meta.trigger_ts : (existing?.trigger_ts ?? null);
  if (event.type === "trigger" || event.type === "stale_detected" || event.type === "synchronize") {
    if (to === "queued" && !triggerTs) triggerTs = now().toISOString();
  }
  if (consumesTrigger) triggerTs = null;

  // Trigger provenance: who asked for the queued round (`triggerProvenance`).
  // Human sticks while the PR is queued — a system re-trigger never
  // downgrades a pending human ask — and dispatch clears it with the trigger.
  let provenance: TriggerProvenance | null = existing?.trigger_provenance ?? null;
  if ((event.type === "trigger" || event.type === "stale_detected") && to === "queued") {
    const fresh = triggerProvenance(event);
    if (fresh === "human" || !(base === "queued" && provenance === "human")) provenance = fresh;
  }
  // An author reply on a queued PR is a person expecting attention:
  // the queued round dispatches in full whoever queued it first.
  if (event.type === "author_reply" && base === "queued") provenance = "human";
  if (consumesTrigger) provenance = null;

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

  if (
    runningRound &&
    advancedHead &&
    (event.type === "synchronize" || event.type === "track" || event.type === "trigger")
  ) {
    store.recordSuccessor({
      pr,
      predecessor_round_id: runningRound.id,
      head_sha: advancedHead,
      provenance: triggerProvenance(event),
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
        provenance: triggerProvenance(event),
        reason: "trigger-while-reviewing",
      });
    }
  }
  if (event.type === "closed") {
    store.acknowledgeTriggerEdges(pr);
    store.clearSuccessor(pr, "pr-closed");
    store.recoverReviewFailure(pr, "pr-closed");
  }

  // Publication and observation acknowledgment share the lifecycle transaction.
  if (event.type === "trigger" && (event.source === "label" || event.source === "team_request"))
    store.acknowledgeTriggerEdges(pr);

  const changed = from !== to;
  const name: SmEventType = event.type;
  // A trigger is logged even when it changes nothing (metrics count it as a
  // request) — but not one a closed PR absorbed: closed is terminal, and that
  // trigger asked for nothing.
  const trigger = name === "trigger" || name === "stale_detected";
  if (changed || (trigger && base !== "closed")) {
    store.logEvent("pr_transition", pr, {
      from,
      to,
      event: name,
      reason: opts.reason ?? null,
    });
  }
  return { pr, from, to, changed };
}

/**
 * Return a PR to the state its STANDING review put it in, with no round
 * having decided anything new: the dispatch-time no-new-evidence
 * skip and the posting-time guarded no-op both land here. A decided standing
 * verdict replays as a `verdict` event — the same table a real verdict uses,
 * so this can never reach a state a verdict could not. No decided verdict
 * (a COMMENT-only mark) lands `tracked` via `round_overdue` with a null
 * standing: known, nothing owed, never an approval. The caller owns the
 * anomaly that explains WHY nothing stands; this only moves the row. Returns
 * the state the row is in afterwards — `closed` stays closed.
 */
export function restoreStandingLifecycle(
  store: StateStore,
  pr: number,
  standing: StandingDecidedVerdict | null,
  opts: { botLogin?: string; now?: () => Date; reason: string },
): PrLifecycleState {
  const event: SmEvent = standing
    ? { type: "verdict", verdict: standing }
    : { type: "round_overdue", standing: null };
  return applyEvent(store, pr, event, {}, opts).to;
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

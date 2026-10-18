// Held wakes — the single-shepherd invariant S4 (docs/single-shepherd-invariant.md).
//
// A PR has exactly one main pi, and it owns the whole review: rounds and author
// exchanges. Two instructions in flight at once is therefore a topology
// violation, not a scheduling detail: an author-reply wake landing between a
// round's pass dispatch and its posting step makes the session answer for
// findings it has not posted yet, out of a context it is still assembling.
//
// So: while a PR's round is running, its wakes are held (persisted in
// `pending_wakes`), and the round-end paths flush them in arrival order.
// Nothing is dropped silently — the per-PR cap logs what it evicts.
//
// The cap never evicts an author reply: each one is a claimed obligation
// nothing else will raise again. What the cap may evict goes push recheck
// nudges first (their claim is
// released and the reconcile push backstop asks the question again), then
// every other ordinary wake, oldest first — a ci or base-advance recheck
// among them: nothing re-raises those, so an eviction releases its claim and
// records the quiet `recheck_wake_dropped`. A burst of author replies is
// delivered in chunks of at most MAX_AUTHOR_REPLIES_PER_DELIVERY, so the
// never-evicted backlog cannot grow one prompt without bound.
import { randomUUID } from "node:crypto";
import { AUTHOR_REPLY_WAKE_HEADING } from "./pingpong.js";
import {
  AUTHOR_REPLY_WAKE_REASON,
  OPERATOR_RECOVERED_WAKE_PREFIX,
  RECHECK_WAKE_PREFIX,
  type EvictedWake,
  type PendingWakeRow,
  type StateStore,
} from "./state.js";

/** The most author replies one coalesced delivery carries. A longer backlog
 * goes in several runs, oldest first, so the prompt stays bounded. */
export const MAX_AUTHOR_REPLIES_PER_DELIVERY = 10;

export interface WakeDeps {
  store: StateStore;
  /** SessionHooks.inject — wake the PR's main pi with a rendered message. */
  inject: (pr: number, message: string) => Promise<void>;
  log?: (msg: string, extra?: unknown) => void;
}

export type WakeDisposition = "injected" | "held";

/**
 * Deliver a wake to a PR's main pi, or hold it when that PR's round is in
 * flight. `reason` is a short tag for the event log ("author_reply", …).
 */
export async function wakeOrHold(
  deps: WakeDeps,
  pr: number,
  message: string,
  reason: string,
  opts: {
    /** For a caller that has already claimed the obligation durably (the
     * author-reply path claims the message before waking): the wake is
     * persisted as held BEFORE anything is awaited, then flushed. A rethrow,
     * or a process exit while the injection waits on a session rebirth, would
     * otherwise lose it — the claim refuses every redelivery. A failed
     * injection leaves the wake held for the flush paths. Callers that
     * release their own claim on failure leave this off. */
    holdOnFailure?: boolean;
    /** Synchronous claim on this same database, committed with its held wake. */
    claim?: () => boolean;
    /** A recheck nudge (`recheck:*`) on a paused PR is held, not delivered:
     * the pause defers the question until it lifts (`RECHECK_WAKE_PREFIX`). */
    deferWhilePaused?: boolean;
  } = {},
): Promise<WakeDisposition> {
  const { store } = deps;
  const log = deps.log ?? ((): void => {});
  if (opts.claim) {
    const id = store.db.transaction(() => {
      if (!opts.claim!()) return null;
      return hold(deps, pr, message, reason);
    })();
    if (id === null) return "held";
    if (
      (opts.deferWhilePaused && store.getPr(pr)?.paused) ||
      store.hasRunningRound(pr) ||
      store.blockingSessionCommand(`pr-${pr}`)
    )
      return "held";
    // No network/process action runs inside the claim transaction.
    const flushed = await flushHeldWakeBatches(deps, pr);
    if (flushed.ids.includes(id)) return "injected";
    if (!stillHeld(store, pr, id)) throw new Error(`wake ${id} was evicted before delivery`);
    store.logEvent("wake_inject_failed_held", pr, { reason });
    log(`wakes: #${pr} ${reason} wake not delivered — held for retry`);
    return "held";
  }

  if (opts.deferWhilePaused && store.getPr(pr)?.paused) {
    hold(deps, pr, message, reason);
    store.logEvent("wake_deferred_paused", pr, { reason });
    return "held";
  }
  if (!store.hasRunningRound(pr) && !store.blockingSessionCommand(`pr-${pr}`)) {
    // An existing backlog goes first (arrival order): queue behind it and
    // flush oldest-first, rather than letting this wake take the slot ahead of
    // wakes still waiting for the stranded-wake sweep. The flush may carry
    // this wake out with the backlog (a coalesced author-reply burst), so what
    // is reported is whether it is still held.
    if (store.hasHeldWakes(pr) || opts.holdOnFailure) {
      const id = hold(deps, pr, message, reason);
      const flushed = await flushHeldWakeBatches(deps, pr);
      if (flushed.ids.includes(id)) return "injected";
      if (!stillHeld(store, pr, id)) throw new Error(`wake ${id} was evicted before delivery`);
      if (opts.holdOnFailure) {
        store.logEvent("wake_inject_failed_held", pr, { reason });
        log(`wakes: #${pr} ${reason} wake not delivered — held for retry`);
      }
      return "held";
    }
    try {
      await deps.inject(pr, message);
      return "injected";
    } catch (err) {
      // Another path may have won the partial-UNIQUE slot after our check.
      // Once durable ownership exists, this wake becomes the ordered backlog;
      // any other injection error propagates unless the caller asked to hold.
      const raced = store.blockingSessionCommand(`pr-${pr}`);
      if (raced) {
        store.logEvent("wake_slot_raced", pr, {
          reason,
          active_command: raced.id,
          error: String(err),
        });
      } else {
        throw err;
      }
    }
  }
  hold(deps, pr, message, reason);
  return "held";
}

/** Is this exact wake still held? Absence alone never proves delivery. */
function stillHeld(store: StateStore, pr: number, id: number): boolean {
  return store.heldWakes(pr).some((wake) => wake.id === id);
}

function hold(deps: WakeDeps, pr: number, message: string, reason: string): number {
  const { store } = deps;
  const log = deps.log ?? ((): void => {});
  const { id, dropped } = store.holdWakeWithIdentity(pr, message, reason);
  store.logEvent("wake_held", pr, {
    reason,
    dropped: dropped.length,
    held: store.heldWakes(pr).length,
  });
  if (dropped.length > 0) {
    log(`wakes: #${pr} dropped ${dropped.length} held wake(s) over the cap`);
    // `reason` is the INCOMING wake's; what went is in `ids`/`dropped_reasons`.
    store.logEvent("wake_dropped", pr, {
      reason,
      ids: dropped.map((wake) => wake.id),
      dropped_reasons: dropped.map((wake) => wake.reason),
    });
    for (const wake of dropped) {
      if (wake.released_recheck === null) continue;
      store.logEvent("recheck_claim_released_evicted", pr, {
        wake_id: wake.id,
        reason: wake.reason,
        fingerprint: wake.released_recheck,
        re_raised_by: wake.re_raised_by_reconcile ? "reconcile_backstop" : null,
      });
      // A ci or base-advance recheck has no sweep to ask it again: a
      // post-approval audit that will now run only if the same webhook comes
      // back. Recorded where the daily heartbeat reads it (quiet grade —
      // `anomalies.ts` lists it nowhere), never silent.
      if (!wake.re_raised_by_reconcile)
        store.logAnomaly(
          RECHECK_WAKE_DROPPED_KIND,
          pr,
          null,
          `held-wake cap evicted ${wake.reason} nudge ${wake.id} (${wake.released_recheck}); its claim is released, but no sweep re-raises a ${wake.reason} recheck — only an identical webhook asks it again`,
        );
    }
    // Structurally impossible (the store never selects an author reply or an
    // operator-recovered row for eviction) — and if a later edit makes it
    // possible, a person hears about it at once: that reply's claim refuses
    // every redelivery, so it would never be answered.
    const owed = dropped.filter(isOwedWakeReason);
    if (owed.length > 0)
      store.logAnomaly(
        AUTHOR_REPLY_DROPPED_KIND,
        pr,
        null,
        `held-wake cap evicted ${owed.length} owed wake(s) (${owed
          .map((wake) => `${wake.id}:${wake.reason}`)
          .join(", ")}) — an author reply or recovered obligation was dropped unanswered`,
      );
  }
  if (dropped.some((wake) => wake.id === id))
    throw new Error(`wake ${id} was evicted before delivery`);
  return id;
}

/** The anomaly a dropped author reply raises (WAKE grade). */
export const AUTHOR_REPLY_DROPPED_KIND = "author_reply_wake_dropped";

/** The anomaly an evicted recheck nudge that nothing
 * re-raises records (a ci or base-advance recheck; QUIET grade — unlisted in
 * `anomalies.ts`, read at the daily heartbeat). */
export const RECHECK_WAKE_DROPPED_KIND = "recheck_wake_dropped";

/** Is every wake this PR holds a recheck its pause defers? Then the
 * stranded-wake sweep has nothing to deliver until the resume. */
export function pauseDefersAllHeldWakes(store: StateStore, pr: number): boolean {
  if (!store.getPr(pr)?.paused) return false;
  const held = store.heldWakes(pr);
  return held.length > 0 && held.every((wake) => wake.reason.startsWith(RECHECK_WAKE_PREFIX));
}

function isOwedWakeReason(wake: EvictedWake): boolean {
  return (
    wake.reason === AUTHOR_REPLY_WAKE_REASON ||
    wake.reason.startsWith(OPERATOR_RECOVERED_WAKE_PREFIX)
  );
}

function isAuthorReplyWake(wake: PendingWakeRow): boolean {
  if (wake.reason === AUTHOR_REPLY_WAKE_REASON) return true;
  return (
    wake.reason.startsWith(OPERATOR_RECOVERED_WAKE_PREFIX) &&
    wake.payload.startsWith(AUTHOR_REPLY_WAKE_HEADING)
  );
}

/** A wake with its repo facts appended — the wake itself, byte for byte,
 * when there are none. Shared by the ping-pong wake and the recheck nudge. */
export function withRepoFacts(wake: string, facts: string): string {
  return facts ? `${wake.replace(/\s+$/, "")}${facts}` : wake;
}

function leadingDeliveryCount(wakes: PendingWakeRow[]): number {
  if (wakes.length === 0) return 0;
  if (!isAuthorReplyWake(wakes[0]!)) return 1;
  let count = 1;
  while (
    count < wakes.length &&
    count < MAX_AUTHOR_REPLIES_PER_DELIVERY &&
    isAuthorReplyWake(wakes[count]!)
  )
    count++;
  return count;
}

function deliveryPayload(pr: number, wakes: PendingWakeRow[]): string {
  if (wakes.length === 1) return wakes[0]!.payload;
  return [
    `# Coalesced author-reply burst — PR #${pr}`,
    "",
    `Process every author message below independently, in order, in this single run (${wakes.length} total).`,
    "Each section is one complete original wake. Follow every section's `What to do` instructions and write",
    "every distinct response file it names. Do not merge, skip, or answer multiple comments with one reply;",
    "the one-reply-per-author-message rule still applies. Do not stop after the first response file.",
    "",
    ...wakes.flatMap((wake, index) => [
      `## Original author message ${index + 1}/${wakes.length} — held wake ${wake.id}`,
      "",
      wake.payload,
      "",
    ]),
  ].join("\n");
}

/**
 * Flush held wakes oldest-first with durable lease→deliver→ack semantics.
 * A contiguous burst of author replies is one delivery unit: Pi handles every
 * distinct response obligation in one run instead of serializing N full runs.
 * Other wake classes remain one-at-a-time and never move across the burst.
 *
 * Failure releases the whole oldest unit and stops, so later messages never
 * overtake it. A crash after inject but before ack may duplicate delivery;
 * without a wake receipt, at-least-once is the honest side of the
 * loss-vs-duplicate tradeoff.
 *
 * Never into a running round: a flush that finds the PR's next
 * round already in flight — dispatched while the previous round's end was
 * still awaiting something — delivers nothing; the wakes stay held for that
 * round's end. An acked round command does not block the session slot, so the
 * slot check alone cannot see such a round.
 */
export async function flushHeldWakes(deps: WakeDeps, pr: number): Promise<number> {
  return (await flushHeldWakeBatches(deps, pr)).delivered;
}

async function flushHeldWakeBatches(
  deps: WakeDeps,
  pr: number,
): Promise<{ delivered: number; ids: number[] }> {
  const { store } = deps;
  const log = deps.log ?? ((): void => {});
  let delivered = 0;
  const deliveredIds: number[] = [];
  let attempted = 0;
  const leaseMs = 5 * 60_000;
  while (true) {
    if (store.hasRunningRound(pr)) break;
    if (store.blockingSessionCommand(`pr-${pr}`)) break;
    // A paused PR's recheck nudges wait for the resume; the rest go now.
    const skip = store.getPr(pr)?.paused ? RECHECK_WAKE_PREFIX : undefined;
    const queued = store.heldWakes(pr, skip);
    const batchSize = leadingDeliveryCount(queued);
    if (batchSize === 0) break;
    const token = randomUUID();
    const wakes = store.claimHeldWakeBatch(
      pr,
      token,
      new Date(Date.now() - leaseMs).toISOString(),
      batchSize,
      skip,
    );
    if (!wakes) break;
    const ids = wakes.map((wake) => wake.id);
    attempted += wakes.length;
    try {
      await deps.inject(pr, deliveryPayload(pr, wakes));
      if (!store.ackHeldWakeBatch(ids, token)) {
        const first = wakes[0]!;
        log(
          `wakes: #${pr} delivered held wake batch ${ids.join(",")}, but its lease was lost before ack`,
        );
        store.logEvent("wake_ack_lost", pr, {
          id: first.id,
          reason: first.reason,
          attempt: first.attempts,
          ids,
          reasons: wakes.map((wake) => wake.reason),
          attempts: wakes.map((wake) => wake.attempts),
        });
        break;
      }
      delivered += wakes.length;
      deliveredIds.push(...ids);
      if (wakes.length > 1) {
        store.logEvent("wakes_coalesced", pr, {
          ids,
          count: wakes.length,
          reasons: wakes.map((wake) => wake.reason),
        });
      }
      // `inject` transferred ownership into the one durable session-command
      // slot. Stop here: deleting the upstream rows is safe, but a second
      // inject before the slot acks would put two instructions in flight.
      if (store.blockingSessionCommand(`pr-${pr}`)) break;
    } catch (err) {
      const first = wakes[0]!;
      const released = store.releaseHeldWakeBatch(ids, token);
      log(`wakes: #${pr} failed to deliver held wake batch ${ids.join(",")}`, err);
      store.logEvent("wake_flush_failed", pr, {
        id: first.id,
        reason: first.reason,
        attempt: first.attempts,
        ids,
        reasons: wakes.map((wake) => wake.reason),
        attempts: wakes.map((wake) => wake.attempts),
        released,
        error: String(err),
      });
      break;
    }
  }
  if (attempted > 0)
    store.logEvent("wakes_flushed", pr, {
      delivered,
      attempted,
      remaining: store.heldWakes(pr).length,
    });
  return { delivered, ids: deliveredIds };
}

// Held wakes — the single-shepherd invariant S4 (docs/single-shepherd-invariant.md).
//
// A PR has exactly ONE main pi, and it owns the whole review: rounds AND author
// exchanges. Two instructions in flight at once is therefore a topology
// violation, not a scheduling detail: an author-reply wake landing between a
// round's pass dispatch and its posting step makes the session answer for
// findings it has not posted yet, out of a context it is still assembling.
//
// So: while a PR's round is running, its wakes are HELD (persisted in
// `pending_wakes`), and the round-end paths flush them in arrival order.
// Nothing is dropped silently — the per-PR cap logs what it evicts.
import { randomUUID } from "node:crypto";
import type { PendingWakeRow, StateStore } from "./state.js";

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
): Promise<WakeDisposition> {
  const { store } = deps;
  const log = deps.log ?? ((): void => {});
  if (!store.hasRunningRound(pr) && !store.blockingSessionCommand(`pr-${pr}`)) {
    try {
      await deps.inject(pr, message);
      return "injected";
    } catch (err) {
      // Another path may have won the partial-UNIQUE slot after our check.
      // Once durable ownership exists, this wake becomes the ordered backlog;
      // any other injection error still propagates normally.
      const raced = store.blockingSessionCommand(`pr-${pr}`);
      if (!raced) throw err;
      store.logEvent("wake_slot_raced", pr, {
        reason,
        active_command: raced.id,
        error: String(err),
      });
    }
  }
  const dropped = store.holdWake(pr, message, reason);
  store.logEvent("wake_held", pr, {
    reason,
    dropped: dropped.length,
    held: store.heldWakes(pr).length,
  });
  if (dropped.length > 0) {
    log(`wakes: #${pr} dropped ${dropped.length} held wake(s) over the cap`);
    store.logEvent("wake_dropped", pr, { reason, ids: dropped });
  }
  return "held";
}

const AUTHOR_REPLY_HEADING = "# Author reply — PR #";

function isAuthorReplyWake(wake: PendingWakeRow): boolean {
  if (wake.reason === "author_reply") return true;
  return (
    wake.reason.startsWith("operator_recovered:") && wake.payload.startsWith(AUTHOR_REPLY_HEADING)
  );
}

function leadingDeliveryCount(wakes: PendingWakeRow[]): number {
  if (wakes.length === 0) return 0;
  if (!isAuthorReplyWake(wakes[0]!)) return 1;
  let count = 1;
  while (count < wakes.length && isAuthorReplyWake(wakes[count]!)) count++;
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
 */
export async function flushHeldWakes(deps: WakeDeps, pr: number): Promise<number> {
  const { store } = deps;
  const log = deps.log ?? ((): void => {});
  let delivered = 0;
  let attempted = 0;
  const leaseMs = 5 * 60_000;
  while (true) {
    if (store.blockingSessionCommand(`pr-${pr}`)) break;
    const queued = store.heldWakes(pr);
    const batchSize = leadingDeliveryCount(queued);
    if (batchSize === 0) break;
    const token = randomUUID();
    const wakes = store.claimHeldWakeBatch(
      pr,
      token,
      new Date(Date.now() - leaseMs).toISOString(),
      batchSize,
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
      if (wakes.length > 1) {
        store.logEvent("wakes_coalesced", pr, {
          ids,
          count: wakes.length,
          reasons: wakes.map((wake) => wake.reason),
        });
      }
      // `inject` transferred ownership into the one durable session-command
      // slot. Stop here: deleting the upstream rows is safe, but a second
      // inject before the slot acks would violate S4.
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
  return delivered;
}

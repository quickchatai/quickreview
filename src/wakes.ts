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
import type { StateStore } from "./state.js";

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
export async function wakeOrHold(deps: WakeDeps, pr: number, message: string, reason: string): Promise<WakeDisposition> {
  const { store } = deps;
  const log = deps.log ?? ((): void => {});
  if (!store.hasRunningRound(pr)) {
    await deps.inject(pr, message);
    return "injected";
  }
  const dropped = store.holdWake(pr, message, reason);
  store.logEvent("wake_held", pr, { reason, dropped: dropped.length, held: store.heldWakes(pr).length });
  if (dropped.length > 0) {
    log(`wakes: #${pr} dropped ${dropped.length} held wake(s) over the cap`);
    store.logEvent("wake_dropped", pr, { reason, ids: dropped });
  }
  return "held";
}

/**
 * Flush every wake held for a PR, oldest first. Called once a round is over
 * (verdict applied, or the round abandoned as overdue). Returns how many were
 * delivered. A failing injection is logged and the remaining wakes are still
 * attempted — the alternative is one dead session swallowing an author's reply
 * forever.
 */
export async function flushHeldWakes(deps: WakeDeps, pr: number): Promise<number> {
  const { store } = deps;
  const log = deps.log ?? ((): void => {});
  const held = store.takeHeldWakes(pr);
  let delivered = 0;
  for (const wake of held) {
    try {
      await deps.inject(pr, wake.payload);
      delivered++;
    } catch (err) {
      log(`wakes: #${pr} failed to deliver held wake ${wake.id}`, err);
      store.logEvent("wake_flush_failed", pr, { id: wake.id, reason: wake.reason, error: String(err) });
    }
  }
  if (held.length > 0) store.logEvent("wakes_flushed", pr, { delivered, held: held.length });
  return delivered;
}

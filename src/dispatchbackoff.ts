// Per-PR dispatch backoff.
//
// A dispatch that fails before any round owns the review leaves the PR
// queued, and the pump comes back every tick (DISPATCH_TICK_S). Without a
// bound each tick repeats the whole attempt — the worktree prepare, the
// trigger consumption, the in-progress label and its removal — against a
// failure that is usually still there, and the only trace is a
// `dispatch_failed` event. This holds a failing PR back on an exponential
// `not before`, honours GitHub's own Retry-After, and raises one
// `dispatch_failing` anomaly once a streak reaches `DISPATCH_FAILING_AFTER`.
// Any dispatch of the PR that ends without failing (a round handed off, a
// skip that settled it) clears the streak.
//
// The state is per store (the daemon instance) and in memory: a restart is a
// fresh attempt, which costs at most one more failure before the backoff is
// re-earned.
import { GitHubRequestError } from "@quickchatai/pi-quickreview/src/githubcore.js";
import type { StateStore } from "./state.js";

/** The first wait after a failed dispatch. */
export const DISPATCH_BACKOFF_BASE_MS = 30_000;
/** The longest wait the doubling reaches. */
export const DISPATCH_BACKOFF_MAX_MS = 30 * 60_000;
/** Consecutive failures that raise the one `dispatch_failing` anomaly. */
export const DISPATCH_FAILING_AFTER = 4;

interface Streak {
  failures: number;
  notBefore: number;
  raised: boolean;
}

const streaks = new WeakMap<StateStore, Map<number, Streak>>();

function streaksOf(store: StateStore): Map<number, Streak> {
  let m = streaks.get(store);
  if (!m) {
    m = new Map();
    streaks.set(store, m);
  }
  return m;
}

/** The wait after the `failures`-th consecutive failure: 30 s doubling to
 * 30 min, never shorter than what GitHub asked for. */
export function dispatchBackoffMs(failures: number, retryAfterMs?: number): number {
  const doubled = DISPATCH_BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1);
  const own = Math.min(DISPATCH_BACKOFF_MAX_MS, doubled);
  return retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > own
    ? retryAfterMs
    : own;
}

/** Why this PR may not dispatch yet, or null when it may. */
export function dispatchBackoffHold(store: StateStore, pr: number, now: number): string | null {
  const s = streaksOf(store).get(pr);
  if (!s || now >= s.notBefore) return null;
  return `backing off after ${s.failures} failed dispatch(es); next attempt at ${new Date(s.notBefore).toISOString()}`;
}

/** Record a failed dispatch; returns the new streak length. Raises the
 * `dispatch_failing` anomaly once per streak, when it reaches
 * `DISPATCH_FAILING_AFTER`. */
export function noteDispatchFailure(
  store: StateStore,
  pr: number,
  err: unknown,
  now: number,
): number {
  const m = streaksOf(store);
  const s = m.get(pr) ?? { failures: 0, notBefore: 0, raised: false };
  s.failures += 1;
  const retryAfterMs = err instanceof GitHubRequestError ? err.retryAfterMs : undefined;
  const waitMs = dispatchBackoffMs(s.failures, retryAfterMs);
  s.notBefore = now + waitMs;
  m.set(pr, s);
  store.logEvent("dispatch_backoff", pr, {
    failures: s.failures,
    wait_ms: waitMs,
    not_before: new Date(s.notBefore).toISOString(),
  });
  if (s.failures >= DISPATCH_FAILING_AFTER && !s.raised) {
    s.raised = true;
    store.logAnomaly(
      "dispatch_failing",
      pr,
      null,
      `#${pr} failed to dispatch ${s.failures} times in a row; the last error: ${String(err).slice(0, 300)}. It stays queued and is retried on a backoff (next at ${new Date(s.notBefore).toISOString()}).`,
    );
  }
  return s.failures;
}

/** A dispatch of this PR ended without failing: the streak is over. */
export function clearDispatchFailures(store: StateStore, pr: number): void {
  streaksOf(store).delete(pr);
}

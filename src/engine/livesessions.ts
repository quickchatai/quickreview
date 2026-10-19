// The SDK sessions this process has running, so a signal handler elsewhere
// (src/reviewdetach.ts runDetachedChild) can stop them: the in-process twin of
// the pi process groups procruntime.ts keeps (`livePiGroupIds`, `killPiGroups`).
// A pi child is stopped by killing its group; an SDK session lives in this very
// process, so the stop is `abort()`, then `dispose()`, then the process exit.
//
// Kept apart from sdkruntime.ts so that the detached driver can import it
// without loading the pi SDK (tests/fences-engine.test.ts S2).

/** What a stop needs of a session: a RuntimeSession fits. */
export interface StoppableSession {
  abort(): Promise<void>;
  dispose(): Promise<void>;
}

const live = new Set<StoppableSession>();
let sdkRoute = false;

/** A session is running; the returned release forgets it (call it on dispose). */
export function trackSession(session: StoppableSession): () => void {
  live.add(session);
  return () => {
    live.delete(session);
  };
}

/** How many sessions are running now. */
export function liveSessionCount(): number {
  return live.size;
}

/** This process hosts its pi sessions on the SDK: a stop signal ends it through
 * `stopLiveSessions` and an exit, not through the pi children's groups. Set by
 * the route as it picks the runtime, before any session exists, so a signal
 * that arrives while the host is still being built is already an SDK stop. */
export function markSdkRoute(): void {
  sdkRoute = true;
}

export function onSdkRoute(): boolean {
  return sdkRoute;
}

/** Test seam: forget the route mark and any session left. */
export function resetLiveSessions(): void {
  live.clear();
  sdkRoute = false;
}

/** Resolve when `step` has, or after `ms`, whichever comes first: a stop that
 * waited on a wedged session would never reach the exit behind it. */
async function within(step: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  try {
    await Promise.race([step.catch(() => undefined), limit]);
  } finally {
    clearTimeout(timer);
  }
}

/** Stop every running session: all aborted, then all disposed, each step given
 * `graceMs` at most. Never rejects. */
export async function stopLiveSessions(graceMs = 5_000): Promise<void> {
  const sessions = [...live];
  await within(Promise.allSettled(sessions.map((s) => s.abort())), graceMs);
  await within(Promise.allSettled(sessions.map((s) => s.dispose())), graceMs);
}

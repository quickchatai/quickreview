// QCR FORK — file added by PATCH 12 (createOpenViking). Not upstream.
//
// Every hook the extension registers runs inside the review session's process,
// and upstream registered them bare: an OpenViking call that never answers
// holds the turn, and one that throws is left to pi's error channel. A review
// must go on without memory, so each hook gets a deadline and a catch. On
// either, the hook is treated as having done nothing (no system-prompt
// addition, no injected recall, no sync) and says so in the debug log.
//
// The pure half, free of pi and of the OV client, so tests/openviking-fork.test.ts
// can call it (`index.ts` wires it in).
import { RECALL_WAIT_MS } from "./qcr-recall.js";

export type HookName =
  | "session_start"
  | "before_agent_start"
  | "context"
  | "tool_call"
  | "turn_end"
  | "session_shutdown"
  | "agent_end"
  | "command";

/** How long a hook may hold pi. `session_start` and `before_agent_start` share
 * `start()` (a health probe, the session attach, a bounded replay of the
 * offline queue, the profile read), so they get the longest. `context` is the
 * recall wait (R3) plus a second for the rest of the hook. */
export const HOOK_TIMEOUT_MS: Readonly<Record<HookName, number>> = {
  session_start: 60_000,
  before_agent_start: 60_000,
  context: RECALL_WAIT_MS + 1_000,
  tool_call: 2_000,
  turn_end: 30_000,
  session_shutdown: 5_000,
  agent_end: 1_000,
  command: 15_000,
};

const TIMED_OUT = Symbol("hook timed out");

/**
 * Runs `run` under a deadline and a catch. Resolves to its value, or, when it
 * throws or misses the deadline, to `onFail(reason)` (undefined without one).
 * The work itself cannot be cancelled: a late result is dropped and a late
 * rejection is logged, never left unhandled.
 */
export async function boundedHook<T>(
  name: string,
  ms: number,
  run: () => Promise<T> | T,
  log: (message: string) => void,
  onFail?: (reason: string) => T,
): Promise<T | undefined> {
  const work = Promise.resolve().then(run);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve(TIMED_OUT);
    }, ms);
    timer.unref?.();
  });
  work.then(
    () => {},
    (err) => {
      if (timedOut) log(`hook ${name}: failed after its deadline: ${describe(err)}`);
    },
  );
  try {
    const result = await Promise.race([work, deadline]);
    if (result === TIMED_OUT) {
      log(`hook ${name}: no answer in ${ms} ms; carried on without it`);
      return onFail?.(`timed out after ${ms} ms`);
    }
    return result;
  } catch (err) {
    log(`hook ${name}: failed: ${describe(err)}`);
    return onFail?.(describe(err));
  } finally {
    clearTimeout(timer);
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

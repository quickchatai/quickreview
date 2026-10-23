// The per-pass deadline: its env knob, the retry-once runner and the result a
// pass that timed out twice answers with. Pure — no pi, no filesystem. Lifted
// from the retired extensions/subagents.ts.

/** The shape of a native subagent tool result, as far as the glue reads it. */
export interface ParallelNativeResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  details: { mode?: string; results: unknown[]; [key: string]: unknown };
  isError?: boolean;
  [key: string]: unknown;
}

/** Env var carrying the per-pass deadline in minutes (on the VM, config.toml
 * [pi] subagent_pass_deadline_min riding the session command line). Absent,
 * "0" or malformed ⇒ no deadline: the companion and the bench run unchanged
 * unless they set it. */
export const PASS_DEADLINE_ENV = "QCR_SUBAGENT_PASS_DEADLINE_MIN";

/** The per-pass deadline in ms, or undefined for none. Minutes may be
 * fractional; anything but a plain non-negative number up to 240 is a
 * misconfiguration and means no deadline (never a surprise kill). */
export function resolvePassDeadlineMs(
  env: Record<string, string | undefined> = process.env,
): number | undefined {
  const raw = (env[PASS_DEADLINE_ENV] ?? "").trim();
  if (!/^\d{1,3}(?:\.\d{1,6})?$/.test(raw)) return undefined;
  const minutes = Number(raw);
  if (!(minutes > 0) || minutes > 240) return undefined;
  return Math.max(1, Math.round(minutes * 60_000));
}

/** "8", "0.5" — the deadline as the operator wrote it, for the failure text. */
export function minutesText(ms: number): string {
  const min = ms / 60_000;
  return Number.isInteger(min) ? String(min) : String(Number(min.toFixed(3)));
}

/** The failure text a pass that timed out twice returns in its slot. */
export function passTimeoutMessage(agent: string, deadlineMs: number): string {
  return `pass ${agent} timed out after ${minutesText(deadlineMs)} min (retried once)`;
}

/**
 * Run one pass under the per-pass deadline: each attempt gets its own
 * AbortSignal composed of the caller's signal OR a fresh timer, which native
 * honours by killing its child (SIGTERM, then SIGKILL). An attempt the TIMER
 * ended is retried once with a fresh deadline; a second timeout answers
 * "timed_out". The caller's abort always wins and is never retried: it
 * rethrows exactly as before. A result native returns after the timer fired
 * (the child finished as it was being killed) is a result, not a timeout.
 */
export async function runUnderDeadline<T>(
  attempt: (signal: AbortSignal) => Promise<T>,
  callerSignal: AbortSignal | undefined,
  deadlineMs: number,
  onTimeout?: (attemptNo: number) => void,
): Promise<T | "timed_out"> {
  for (let attemptNo = 1; attemptNo <= 2; attemptNo++) {
    callerSignal?.throwIfAborted();
    const timer = new AbortController();
    const handle = setTimeout(
      () => timer.abort(new Error(`per-pass deadline of ${minutesText(deadlineMs)} min reached`)),
      deadlineMs,
    );
    const signal = callerSignal ? AbortSignal.any([callerSignal, timer.signal]) : timer.signal;
    try {
      return await attempt(signal);
    } catch (err) {
      if (callerSignal?.aborted || !timer.signal.aborted) throw err;
      onTimeout?.(attemptNo);
    } finally {
      clearTimeout(handle);
    }
  }
  return "timed_out";
}

/** The one task a call runs, when it runs exactly one: a single-mode
 * `{agent, task}` call or a one-element `tasks` array. */
export function soleTask(
  params: Record<string, unknown>,
): { agent: string; task: unknown; mode: "single" | "parallel" } | undefined {
  if (Array.isArray(params.tasks)) {
    if (params.tasks.length !== 1) return undefined;
    const t = params.tasks[0];
    const agent =
      typeof t === "object" && t !== null ? (t as Record<string, unknown>).agent : undefined;
    return typeof agent === "string"
      ? { agent, task: (t as Record<string, unknown>).task, mode: "parallel" }
      : undefined;
  }
  if (params.chain !== undefined) return undefined;
  return typeof params.agent === "string"
    ? { agent: params.agent, task: params.task, mode: "single" }
    : undefined;
}

/** A pass that timed out twice, in native's own result shape for its mode,
 * so the combined result, round-progress and the session read it as one
 * failed pass with the timeout named. */
export function timedOutResult(
  sole: { agent: string; task: unknown; mode: "single" | "parallel" },
  deadlineMs: number,
): ParallelNativeResult {
  const message = passTimeoutMessage(sole.agent, deadlineMs);
  const result = {
    agent: sole.agent,
    agentSource: "unknown",
    task: sole.task,
    exitCode: 1,
    messages: [],
    stderr: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
    stopReason: "error",
    errorMessage: message,
    timedOut: true,
  };
  const text =
    sole.mode === "parallel"
      ? `Parallel: 0/1 succeeded\n\n### [${sole.agent}] failed (timeout)\n\n${message}`
      : `Agent timeout: ${message}`;
  return {
    content: [{ type: "text", text }],
    details: { mode: sole.mode, agentScope: undefined, projectAgentsDir: null, results: [result] },
    isError: true,
  };
}

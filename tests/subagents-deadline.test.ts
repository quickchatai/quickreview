// The per-pass deadline in the subagent glue: a lens child still running at
// the deadline is aborted (native kills its child on abort), retried ONCE with
// a fresh deadline, and a second timeout becomes that pass's failed result —
// the other passes intact. The caller's abort always wins and is never
// retried; no path leaks a semaphore permit.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SUBAGENT_PASS_DEADLINE_MIN, parseConfig } from "../src/config.js";
import {
  PASS_DEADLINE_ENV,
  WIDE_FANOUT_ENV,
  WeightedSemaphore,
  passTimeoutMessage,
  resolvePassDeadlineMs,
  runUnderDeadline,
  wrapExecute,
} from "../extensions/subagents.js";

type Behaviour = "hang" | number; // hang until aborted, or finish after N ms

/** A native stand-in honouring the abort contract native has: on abort it
 * rejects ("Subagent was aborted") — only after its child is gone. Each
 * agent's attempts follow its script, one entry per attempt. */
function nativeStub(script: Record<string, Behaviour[]>) {
  const calls: Array<{ agent: string; signal: AbortSignal | undefined; abortedAtStart: boolean }> =
    [];
  const execute = async (_id: string, params: Record<string, unknown>, signal?: AbortSignal) => {
    const tasks = Array.isArray(params.tasks)
      ? (params.tasks as Array<{ agent: string; task: string }>)
      : [{ agent: params.agent as string, task: params.task as string }];
    const agent = tasks[0]!.agent;
    const attempt = calls.filter((c) => c.agent === agent).length;
    calls.push({ agent, signal, abortedAtStart: signal?.aborted === true });
    const behaviour = script[agent]?.[attempt] ?? 0;
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(new Error("Subagent was aborted"));
      if (signal?.aborted) return abort();
      signal?.addEventListener("abort", abort, { once: true });
      if (behaviour !== "hang") setTimeout(resolve, behaviour);
    });
    const results = tasks.map((t) => ({ ...t, exitCode: 0, messages: [] }));
    return Array.isArray(params.tasks)
      ? {
          content: [
            { type: "text", text: `Parallel: 1/1 succeeded\n\n### [${agent}] completed\n\nok` },
          ],
          details: { mode: "parallel", results },
        }
      : { content: [{ type: "text", text: "ok" }], details: { mode: "single", results } };
  };
  return { calls, execute: execute as unknown as Parameters<typeof wrapExecute>[0] };
}

const DEADLINE_MS = 120;
// 120 ms in the env's unit (minutes).
const DEADLINE_ENV = { [PASS_DEADLINE_ENV]: String(DEADLINE_MS / 60_000) };
const WIDE = { [WIDE_FANOUT_ENV]: "1", ...DEADLINE_ENV };
const tasks = (...agents: string[]) => agents.map((agent) => ({ agent, task: `t-${agent}` }));

interface Combined {
  content: Array<{ type: string; text?: string }>;
  details: {
    results: Array<{ agent: string; exitCode: number; errorMessage?: string; stopReason?: string }>;
  };
  isError?: boolean;
}

describe("resolvePassDeadlineMs", () => {
  it("reads minutes from the env; absent, 0 or garbage means no deadline", () => {
    expect(resolvePassDeadlineMs({})).toBeUndefined();
    expect(resolvePassDeadlineMs({ [PASS_DEADLINE_ENV]: "0" })).toBeUndefined();
    expect(resolvePassDeadlineMs({ [PASS_DEADLINE_ENV]: "8x" })).toBeUndefined();
    expect(resolvePassDeadlineMs({ [PASS_DEADLINE_ENV]: "-1" })).toBeUndefined();
    expect(resolvePassDeadlineMs({ [PASS_DEADLINE_ENV]: "999" })).toBeUndefined();
    expect(resolvePassDeadlineMs({ [PASS_DEADLINE_ENV]: "8" })).toBe(480_000);
    expect(resolvePassDeadlineMs({ [PASS_DEADLINE_ENV]: "0.5" })).toBe(30_000);
  });

  it("names the pass and the deadline in the failure text", () => {
    expect(passTimeoutMessage("pass-security--sol-high", 480_000)).toBe(
      "pass pass-security--sol-high timed out after 8 min (retried once)",
    );
  });
});

describe("per-pass deadline — wide fan-out", () => {
  it("aborts a stuck pass, retries it once, and a second timeout fails that slot alone", async () => {
    const native = nativeStub({ "pass-b": ["hang", "hang"] });
    const sem = new WeightedSemaphore(4);
    const wrapped = wrapExecute(native.execute, sem, WIDE);
    const out = (await wrapped("c", { tasks: tasks("pass-a", "pass-b", "pass-c") })) as Combined;
    expect(native.calls.filter((c) => c.agent === "pass-b")).toHaveLength(2);
    expect(native.calls.filter((c) => c.agent === "pass-a")).toHaveLength(1);
    const [a, b, c] = out.details.results;
    expect(a).toMatchObject({ agent: "pass-a", exitCode: 0 });
    expect(c).toMatchObject({ agent: "pass-c", exitCode: 0 });
    expect(b).toMatchObject({
      agent: "pass-b",
      exitCode: 1,
      stopReason: "error",
      errorMessage: passTimeoutMessage("pass-b", DEADLINE_MS),
    });
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toMatch(/^Parallel: 2\/3 succeeded/);
    expect(out.content[0]!.text).toContain("timed out after");
    expect(sem.held).toBe(0);
  });

  it("gives the retry a FRESH deadline: a retry slower than what is left of the first still succeeds", async () => {
    // Attempt 1 hangs to the deadline; attempt 2 takes 0.75 of a deadline —
    // past what a shared deadline would leave, inside a fresh one.
    const native = nativeStub({ "pass-b": ["hang", Math.round(DEADLINE_MS * 0.75)] });
    const sem = new WeightedSemaphore(4);
    const wrapped = wrapExecute(native.execute, sem, WIDE);
    const out = (await wrapped("c", { tasks: tasks("pass-a", "pass-b") })) as Combined;
    const tries = native.calls.filter((c) => c.agent === "pass-b");
    expect(tries).toHaveLength(2);
    expect(tries[0]!.signal).not.toBe(tries[1]!.signal);
    expect(tries[1]!.abortedAtStart).toBe(false);
    expect(tries[0]!.signal?.aborted).toBe(true);
    expect(tries[1]!.signal?.aborted).toBe(false);
    expect(out.isError).toBeUndefined();
    expect(out.details.results.map((r) => r.exitCode)).toEqual([0, 0]);
    expect(sem.held).toBe(0);
  });

  it("keeps the pass's one permit across the retry and never leaks one", async () => {
    const native = nativeStub({ "pass-a": ["hang", "hang"] });
    const sem = new WeightedSemaphore(1);
    const wrapped = wrapExecute(native.execute, sem, WIDE);
    const run = wrapped("c", { tasks: tasks("pass-a", "pass-b") });
    // Mid-retry pass-a still holds the only permit, so pass-b has not started.
    while (native.calls.length < 2) await new Promise((r) => setTimeout(r, 5));
    expect(sem.held).toBe(1);
    expect(native.calls.map((c) => c.agent)).toEqual(["pass-a", "pass-a"]);
    const out = (await run) as Combined;
    expect(out.details.results.map((r) => r.exitCode)).toEqual([1, 0]);
    expect(sem.held).toBe(0);
  });

  it("the caller's abort wins: it rejects, is never retried, and releases every permit", async () => {
    const native = nativeStub({ "pass-a": ["hang"], "pass-b": ["hang"] });
    const sem = new WeightedSemaphore(4);
    const wrapped = wrapExecute(native.execute, sem, WIDE);
    const caller = new AbortController();
    const run = wrapped("c", { tasks: tasks("pass-a", "pass-b") }, caller.signal);
    setTimeout(() => caller.abort(), DEADLINE_MS / 4);
    await expect(run).rejects.toThrow(/aborted/);
    expect(native.calls).toHaveLength(2); // one attempt each — no retry
    expect(sem.held).toBe(0);
  });
});

describe("per-pass deadline — single-pass calls", () => {
  it("a single-mode call that times out twice returns one failed single-mode result", async () => {
    const native = nativeStub({ "pass-security--sol-high": ["hang", "hang"] });
    const sem = new WeightedSemaphore(4);
    const wrapped = wrapExecute(native.execute, sem, DEADLINE_ENV);
    const out = (await wrapped("c", {
      agent: "pass-security--sol-high",
      task: "t",
    })) as Combined & { details: { mode: string } };
    expect(native.calls).toHaveLength(2);
    expect(out.isError).toBe(true);
    expect(out.details.mode).toBe("single");
    expect(out.details.results[0]!.errorMessage).toBe(
      passTimeoutMessage("pass-security--sol-high", DEADLINE_MS),
    );
    expect(sem.held).toBe(0);
  });

  it("with no deadline configured the caller's own signal passes straight through", async () => {
    const native = nativeStub({ "pass-a": [DEADLINE_MS * 1.5] });
    const sem = new WeightedSemaphore(4);
    const wrapped = wrapExecute(native.execute, sem, {});
    const caller = new AbortController();
    const out = (await wrapped("c", { agent: "pass-a", task: "t" }, caller.signal)) as Combined;
    expect(native.calls[0]!.signal).toBe(caller.signal);
    expect(out.details.results[0]!.exitCode).toBe(0);
  });
});

describe("runUnderDeadline", () => {
  it("rethrows a non-deadline failure without retrying", async () => {
    let n = 0;
    await expect(
      runUnderDeadline(
        async () => {
          n++;
          throw new Error("boom");
        },
        undefined,
        DEADLINE_MS,
      ),
    ).rejects.toThrow("boom");
    expect(n).toBe(1);
  });

  it("reports each timeout and answers timed_out after the second", async () => {
    const seen: number[] = [];
    const hang = (signal: AbortSignal) =>
      new Promise<never>((_, reject) =>
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
      );
    const value = await runUnderDeadline(hang, undefined, 30, (n) => seen.push(n));
    expect(value).toBe("timed_out");
    expect(seen).toEqual([1, 2]);
  });
});

describe("config.toml [pi] subagent_pass_deadline_min", () => {
  const toml = readFileSync(resolve(import.meta.dirname, "fixtures/config.toml"), "utf8");
  const withKey = (v: string) => toml.replace("[pi]", `[pi]\nsubagent_pass_deadline_min = ${v}`);

  it("defaults to 8 minutes; 0 switches it off; fractions are minutes", () => {
    expect(parseConfig(toml).pi.subagent_pass_deadline_min).toBe(
      DEFAULT_SUBAGENT_PASS_DEADLINE_MIN,
    );
    expect(DEFAULT_SUBAGENT_PASS_DEADLINE_MIN).toBe(8);
    expect(parseConfig(withKey("0")).pi.subagent_pass_deadline_min).toBe(0);
    expect(parseConfig(withKey("2.5")).pi.subagent_pass_deadline_min).toBe(2.5);
  });

  it("refuses a value that is not 0-240 minutes rather than silently dropping the deadline", () => {
    expect(() => parseConfig(withKey("-1"))).toThrow(/subagent_pass_deadline_min/);
    expect(() => parseConfig(withKey("241"))).toThrow(/subagent_pass_deadline_min/);
    expect(() => parseConfig(withKey('"8"'))).toThrow(/subagent_pass_deadline_min/);
  });
});

describe("per-pass deadline in native batch mode", () => {
  it("times out and retries only the stuck child of a parallel call", async () => {
    const native = nativeStub({ "pass-a": [0], "pass-b": ["hang", "hang"] });
    const wrapped = wrapExecute(native.execute, new WeightedSemaphore(2), DEADLINE_ENV);
    const out = (await wrapped("batch", { tasks: tasks("pass-a", "pass-b") })) as Combined;
    expect(out.details.results[0]).toMatchObject({ agent: "pass-a", exitCode: 0 });
    expect(out.details.results[1]).toMatchObject({ agent: "pass-b", exitCode: 1 });
    expect(native.calls.filter((call) => call.agent === "pass-b")).toHaveLength(2);
    expect(native.calls.filter((call) => call.agent === "pass-a")).toHaveLength(1);
  });
});

it("keeps native batches at four concurrent children when adding individual deadlines", async () => {
  const names = ["a", "b", "c", "d", "e", "f"];
  const native = nativeStub(Object.fromEntries(names.map((name) => [name, [30]])));
  const wrapped = wrapExecute(native.execute, new WeightedSemaphore(12), DEADLINE_ENV);
  const pending = wrapped("batch", { tasks: tasks(...names) });
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(native.calls).toHaveLength(4);
  await pending;
  expect(native.calls).toHaveLength(6);
});

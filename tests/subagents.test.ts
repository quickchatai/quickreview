// The first-party glue over pi's native subagent extension.
//
// The native extension itself is pi's code, loaded at runtime from the
// installed pinned package (nothing vendored, nothing to drift); what THESE
// tests pin is our glue policy, because each line is an invariant with an
// incident or a rule behind it:
//  - sanitizeParams strips every `cwd` (a child in a reviewed-repo worktree
//    would load that repo's `.pi/` project config under always-on trust),
//    pins agentScope (repo-controlled `.pi/agents` must be unreachable unless
//    deliberately enabled) and disables the project-agents confirm modal
//    (the reviewer never blocks on interactive pi input);
//  - the weighted semaphore enforces a PROCESS-WIDE fan-out cap — the native
//    extension caps only within a single tasks-array call, and the round
//    templates fan out as many single-mode calls in one turn (4 by default,
//    set per install via QCR_SUBAGENT_MAX_CONCURRENCY).
import { describe, expect, it } from "vitest";
import {
  CONCURRENCY_ENV,
  DEFAULT_MAX_CONCURRENCY,
  NATIVE_IN_CALL_CONCURRENCY,
  NATIVE_MAX_PARALLEL_TASKS,
  SCOPE_ENV,
  WIDE_FANOUT_ENV,
  WeightedSemaphore,
  callWeight,
  nativeExtensionPath,
  resolveMaxConcurrency,
  resolveScope,
  resolveWideFanout,
  sanitizeParams,
  wrapExecute,
} from "../extensions/subagents.js";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("sanitizeParams", () => {
  it("strips cwd everywhere — top level, tasks[], chain[]", () => {
    const out = sanitizeParams(
      {
        agent: "pass-baseline--sol-high",
        task: "t",
        cwd: "/opt/quickreview/wt/pr-5",
        tasks: [
          { agent: "a", task: "1", cwd: "/opt/quickreview/wt/pr-5" },
          { agent: "b", task: "2" },
        ],
        chain: [{ agent: "c", task: "3", cwd: "/evil" }],
      },
      {},
    );
    expect(out.cwd).toBeUndefined();
    expect((out.tasks as Record<string, unknown>[]).map((t) => t.cwd)).toEqual([
      undefined,
      undefined,
    ]);
    expect((out.chain as Record<string, unknown>[])[0]?.cwd).toBeUndefined();
    // Everything else passes through untouched.
    expect(out.agent).toBe("pass-baseline--sol-high");
    expect((out.tasks as Record<string, unknown>[])[0]?.task).toBe("1");
  });

  it("pins agentScope to user by default and disables the project-agents confirm", () => {
    const out = sanitizeParams({ agent: "a", task: "t", agentScope: "both" }, {});
    expect(out.agentScope).toBe("user");
    expect(out.confirmProjectAgents).toBe(false);
  });

  it("honours a valid scope override from the environment only", () => {
    expect(sanitizeParams({ agentScope: "both" }, { [SCOPE_ENV]: "project" }).agentScope).toBe(
      "project",
    );
    // A garbage env value falls back to user, never to what the model asked.
    expect(sanitizeParams({ agentScope: "both" }, { [SCOPE_ENV]: "everything" }).agentScope).toBe(
      "user",
    );
  });
});

describe("scope + concurrency resolution", () => {
  it("scope: user unless the env names a valid scope", () => {
    expect(resolveScope({})).toBe("user");
    expect(resolveScope({ [SCOPE_ENV]: "project" })).toBe("project");
    expect(resolveScope({ [SCOPE_ENV]: "both" })).toBe("both");
    expect(resolveScope({ [SCOPE_ENV]: "ALL" })).toBe("user");
  });

  it("concurrency: default 4; VM-style 6 from the env; garbage falls back", () => {
    expect(resolveMaxConcurrency({})).toBe(DEFAULT_MAX_CONCURRENCY);
    expect(resolveMaxConcurrency({ [CONCURRENCY_ENV]: "6" })).toBe(6);
    for (const bad of ["0", "-2", "NaN", "", "1e3", "999"]) {
      expect(resolveMaxConcurrency({ [CONCURRENCY_ENV]: bad }), bad).toBe(DEFAULT_MAX_CONCURRENCY);
    }
  });
});

describe("callWeight", () => {
  it("single and chain calls weigh 1", () => {
    expect(callWeight({ agent: "a", task: "t" }, 6)).toBe(1);
    expect(callWeight({ chain: [{}, {}, {}] }, 6)).toBe(1);
  });

  it("a parallel call weighs its task count, bounded by the native in-call cap", () => {
    expect(callWeight({ tasks: [{}, {}] }, 6)).toBe(2);
    expect(callWeight({ tasks: [{}, {}, {}, {}, {}, {}, {}, {}] }, 6)).toBe(
      NATIVE_IN_CALL_CONCURRENCY,
    );
    // …and by the permit count, so one oversized call can always start.
    expect(callWeight({ tasks: [{}, {}, {}, {}] }, 2)).toBe(2);
  });
});

describe("WeightedSemaphore", () => {
  it("bounds concurrent holders and wakes waiters FIFO", async () => {
    const sem = new WeightedSemaphore(2);
    await sem.acquire(1);
    await sem.acquire(1);
    let third = false;
    const p = sem.acquire(1).then(() => {
      third = true;
    });
    await tick();
    expect(third).toBe(false);
    sem.release(1);
    await p;
    expect(third).toBe(true);
    expect(sem.held).toBe(2);
  });

  it("weighted acquire holds several permits at once", async () => {
    const sem = new WeightedSemaphore(6);
    await sem.acquire(4);
    expect(sem.held).toBe(4);
    let entered = false;
    const p = sem.acquire(4).then(() => {
      entered = true;
    });
    await tick();
    expect(entered).toBe(false); // only 2 free
    sem.release(4);
    await p;
    expect(sem.held).toBe(4);
  });

  it("never deadlocks on a weight above the permit count (clamped)", async () => {
    const sem = new WeightedSemaphore(2);
    await sem.acquire(10); // clamped to 2
    expect(sem.held).toBe(2);
    sem.release(10);
    expect(sem.held).toBe(0);
  });
});

describe("wrapExecute", () => {
  const asExecute = (fn: (...args: unknown[]) => Promise<unknown>) =>
    fn as unknown as Parameters<typeof wrapExecute>[0];

  it("caps concurrent native executions at the semaphore's permits", async () => {
    let inFlight = 0;
    let peak = 0;
    const gates: Array<() => void> = [];
    const execute = asExecute(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((r) => gates.push(r));
      inFlight -= 1;
      return { content: [{ type: "text", text: "ok" }] };
    });
    const sem = new WeightedSemaphore(2);
    const wrapped = wrapExecute(execute, sem, {});
    const calls = [1, 2, 3, 4].map((i) => wrapped(`id${i}`, { agent: "a", task: `t${i}` }));
    await tick();
    expect(peak).toBe(2); // the 3rd and 4th are parked on the semaphore
    while (gates.length > 0) {
      gates.shift()?.();
      await tick();
    }
    // These ARE promises — wrapExecute returns an async function. They are
    // DECLARED through pi's ToolExecute, which is our deliberately-minimal
    // ambient declaration of someone else's API, and widening that to satisfy
    // a lint rule is what the VERIFY-ON-PIN discipline exists to prevent.
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await Promise.all(calls);
    expect(peak).toBe(2);
    expect(sem.held).toBe(0);
  });

  it("sanitizes params before the native tool sees them", async () => {
    let seen: Record<string, unknown> | undefined;
    const execute = asExecute(async (_id, params) => {
      seen = params as Record<string, unknown>;
      return { content: [] };
    });
    const wrapped = wrapExecute(execute, new WeightedSemaphore(4), {});
    await wrapped("id", { agent: "a", task: "t", cwd: "/wt/pr-9", agentScope: "both" });
    expect(seen?.cwd).toBeUndefined();
    expect(seen?.agentScope).toBe("user");
    expect(seen?.confirmProjectAgents).toBe(false);
  });

  it("chunks an oversized parallel call at the native hard limit and preserves every ordered result", async () => {
    const batchSizes: number[] = [];
    const execute = asExecute(async (_id, params) => {
      const tasks = (params as { tasks: Array<{ agent: string; task: string }> }).tasks;
      batchSizes.push(tasks.length);
      if (tasks.length > NATIVE_MAX_PARALLEL_TASKS) throw new Error("native task cap exceeded");
      const results = tasks.map((task) => ({
        ...task,
        agentSource: "user",
        exitCode: task.task === "task-3" ? 1 : 0,
        messages: [{ role: "assistant", content: task.task }],
        stderr: "",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          contextTokens: 2,
          turns: 1,
        },
      }));
      return {
        content: [{ type: "text", text: tasks.map((task) => task.task).join(",") }],
        details: { mode: "parallel", results },
      };
    });
    const wrapped = wrapExecute(execute, new WeightedSemaphore(6), {});
    const tasks = Array.from({ length: 10 }, (_, i) => ({
      agent: `pass-${i}`,
      task: `task-${i}`,
      cwd: "/evil",
    }));

    const result = (await wrapped("round", { tasks })) as unknown as {
      content: Array<{ text: string }>;
      details: { results: Array<{ task: string }> };
    };

    expect(batchSizes).toEqual([8, 2]);
    expect(result.details.results.map((row) => row.task)).toEqual(tasks.map((task) => task.task));
    expect(result.content[0]?.text).toMatch(/^Parallel: 9\/10 succeeded/);
    expect(result.content[0]?.text).toContain("task-0");
    expect(result.content[0]?.text).toContain("task-9");
  });

  it("honours configured process caps below native's four-child concurrency", async () => {
    const batchSizes: number[] = [];
    const execute = asExecute(async (_id, params) => {
      const tasks = (params as { tasks: Array<{ agent: string; task: string }> }).tasks;
      batchSizes.push(tasks.length);
      return {
        content: [
          { type: "text", text: `Parallel: ${tasks.length}/${tasks.length} succeeded\n\nok` },
        ],
        details: { mode: "parallel", results: tasks.map((task) => ({ ...task, exitCode: 0 })) },
      };
    });
    const wrapped = wrapExecute(execute, new WeightedSemaphore(2), {});
    const tasks = Array.from({ length: 5 }, (_, i) => ({ agent: `pass-${i}`, task: `task-${i}` }));

    await wrapped("round", { tasks });

    expect(batchSizes).toEqual([2, 2, 1]);
  });

  it("fails explicitly on native final-result contract drift and releases permits", async () => {
    const sem = new WeightedSemaphore(6);
    const wrapped = wrapExecute(
      asExecute(async () => ({ content: [] })),
      sem,
      {},
    );
    const tasks = Array.from({ length: 9 }, (_, i) => ({ agent: `pass-${i}`, task: `task-${i}` }));

    await expect(wrapped("round", { tasks })).rejects.toThrow(
      "native parallel result contract changed",
    );
    expect(sem.held).toBe(0);
  });

  it("streams cumulative ordered details across oversized-call chunks", async () => {
    const execute = asExecute(async (_id, params, _signal, onUpdate) => {
      const tasks = (params as { tasks: Array<{ agent: string; task: string }> }).tasks;
      const results = tasks.map((task) => ({ ...task, exitCode: 0 }));
      (onUpdate as ((value: unknown) => void) | undefined)?.({
        content: [{ type: "text", text: "progress" }],
        details: { mode: "parallel", results },
      });
      return { content: [{ type: "text", text: "done" }], details: { mode: "parallel", results } };
    });
    const wrapped = wrapExecute(execute, new WeightedSemaphore(6), {});
    const counts: number[] = [];
    const tasks = Array.from({ length: 9 }, (_, i) => ({ agent: `pass-${i}`, task: `task-${i}` }));

    await wrapped("round", { tasks }, undefined, (update: unknown) => {
      counts.push((update as { details: { results: unknown[] } }).details.results.length);
    });

    expect(counts).toEqual([8, 9]);
  });

  it("does not start native work when cancelled while waiting for a permit", async () => {
    const sem = new WeightedSemaphore(1);
    await sem.acquire(1);
    const controller = new AbortController();
    let calls = 0;
    const wrapped = wrapExecute(
      asExecute(async () => {
        calls += 1;
        return { content: [] };
      }),
      sem,
      {},
    );
    const pending = wrapped("queued", { agent: "a", task: "t" }, controller.signal);
    await tick();
    controller.abort(new Error("cancelled in queue"));
    sem.release(1);

    await expect(pending).rejects.toThrow("cancelled in queue");
    expect(calls).toBe(0);
    expect(sem.held).toBe(0);
  });

  it("does not start a later oversized-call chunk after cancellation and releases permits", async () => {
    const controller = new AbortController();
    let calls = 0;
    const sem = new WeightedSemaphore(6);
    const execute = asExecute(async (_id, params) => {
      calls += 1;
      const tasks = (params as { tasks: Array<{ agent: string; task: string }> }).tasks;
      controller.abort(new Error("stop after first batch"));
      return {
        content: [],
        details: { mode: "parallel", results: tasks.map((task) => ({ ...task, exitCode: 0 })) },
      };
    });
    const wrapped = wrapExecute(execute, sem, {});
    const tasks = Array.from({ length: 9 }, (_, i) => ({ agent: `pass-${i}`, task: `task-${i}` }));

    await expect(wrapped("round", { tasks }, controller.signal)).rejects.toThrow(
      "stop after first batch",
    );
    expect(calls).toBe(1);
    expect(sem.held).toBe(0);
  });

  it("releases permits when the native execute throws", async () => {
    const sem = new WeightedSemaphore(1);
    const wrapped = wrapExecute(
      asExecute(async () => {
        throw new Error("boom");
      }),
      sem,
      {},
    );
    await expect(wrapped("id", { agent: "a", task: "t" })).rejects.toThrow("boom");
    expect(sem.held).toBe(0);
    // A later call still gets through — the permit came back.
    const ok = wrapExecute(
      asExecute(async () => ({ content: [] })),
      sem,
      {},
    );
    await expect(ok("id2", { agent: "a", task: "t" })).resolves.toEqual({ content: [] });
  });
});

describe("wide fan-out (QCR_SUBAGENT_WIDE_FANOUT=1, bench/aacr/PERF.md §1)", () => {
  const WIDE = { [WIDE_FANOUT_ENV]: "1" };
  const asExecute = (fn: (...args: unknown[]) => Promise<unknown>) =>
    fn as unknown as Parameters<typeof wrapExecute>[0];
  function nativeStub(log: { inFlight: number; peak: number; sizes: number[] }) {
    return asExecute(async (_id, params) => {
      const tasks = (params as { tasks: Array<{ agent: string; task: string }> }).tasks;
      log.sizes.push(tasks.length);
      if (tasks.length > NATIVE_IN_CALL_CONCURRENCY) throw new Error("native in-call cap exceeded");
      log.inFlight += tasks.length;
      log.peak = Math.max(log.peak, log.inFlight);
      await tick();
      await tick();
      log.inFlight -= tasks.length;
      return {
        content: [
          {
            type: "text",
            text: `Parallel: ${tasks.length}/${tasks.length} succeeded\n\n${tasks.map((t) => t.task).join(",")}`,
          },
        ],
        details: { mode: "parallel", results: tasks.map((task) => ({ ...task, exitCode: 0 })) },
      };
    });
  }

  it("is off unless the env says exactly 1", () => {
    expect(resolveWideFanout({})).toBe(false);
    expect(resolveWideFanout({ [WIDE_FANOUT_ENV]: "0" })).toBe(false);
    expect(resolveWideFanout({ [WIDE_FANOUT_ENV]: "yes" })).toBe(false);
    expect(resolveWideFanout(WIDE)).toBe(true);
  });

  it("runs one 12-task call 12 wide under a cap of 12, in chunks native accepts, results in task order", async () => {
    const log = { inFlight: 0, peak: 0, sizes: [] as number[] };
    const wrapped = wrapExecute(nativeStub(log), new WeightedSemaphore(12), WIDE);
    const tasks = Array.from({ length: 12 }, (_, i) => ({
      agent: `pass-${i}`,
      task: `task-${i}`,
      cwd: "/evil",
    }));
    const result = (await wrapped("round", { tasks })) as unknown as {
      content: Array<{ text: string }>;
      details: { results: Array<{ task: string; cwd?: string }> };
    };
    expect(log.sizes).toEqual([4, 4, 4]);
    expect(log.peak).toBe(12);
    expect(result.details.results.map((r) => r.task)).toEqual(tasks.map((t) => t.task));
    expect(result.details.results.every((r) => r.cwd === undefined)).toBe(true);
    expect(result.content[0]?.text).toMatch(/^Parallel: 12\/12 succeeded/);
  });

  it("still never exceeds the process-wide cap, across one call or several", async () => {
    const log = { inFlight: 0, peak: 0, sizes: [] as number[] };
    const wrapped = wrapExecute(nativeStub(log), new WeightedSemaphore(6), WIDE);
    const mk = (n: number, p: string) =>
      Array.from({ length: n }, (_, i) => ({ agent: `${p}${i}`, task: `${p}${i}` }));
    await Promise.all([wrapped("a", { tasks: mk(10, "a") }), wrapped("b", { tasks: mk(5, "b") })]);
    expect(log.peak).toBeLessThanOrEqual(6);
    expect(log.sizes.reduce((x, y) => x + y, 0)).toBe(15);
  });

  it("leaves single-mode calls and the native shape alone when off", async () => {
    const log = { inFlight: 0, peak: 0, sizes: [] as number[] };
    const wrapped = wrapExecute(nativeStub(log), new WeightedSemaphore(12), {});
    const tasks = Array.from({ length: 4 }, (_, i) => ({ agent: `p${i}`, task: `t${i}` }));
    await wrapped("round", { tasks });
    expect(log.sizes).toEqual([4]);
  });
});

describe("nativeExtensionPath", () => {
  it("addresses the shipped example inside the installed package", () => {
    expect(
      nativeExtensionPath("/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/examples"),
    ).toBe(
      "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/index.ts",
    );
  });
});

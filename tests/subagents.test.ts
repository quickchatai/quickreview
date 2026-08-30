// the first-party glue over pi's native subagent extension.
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
//  - the weighted semaphore restores the PROCESS-WIDE fan-out cap the old
//    extension had — the native one caps only within a single tasks-array
//    call, and the round templates fan out as many single-mode calls in one
//    turn (4 default / 6 on the VM via QCR_SUBAGENT_MAX_CONCURRENCY).
import { describe, expect, it } from "vitest";
import {
  CONCURRENCY_ENV,
  DEFAULT_MAX_CONCURRENCY,
  NATIVE_IN_CALL_CONCURRENCY,
  SCOPE_ENV,
  WeightedSemaphore,
  callWeight,
  nativeExtensionPath,
  resolveMaxConcurrency,
  resolveScope,
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
    expect((out.tasks as Record<string, unknown>[]).map((t) => t.cwd)).toEqual([undefined, undefined]);
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
    expect(sanitizeParams({ agentScope: "both" }, { [SCOPE_ENV]: "project" }).agentScope).toBe("project");
    // A garbage env value falls back to user, never to what the model asked.
    expect(sanitizeParams({ agentScope: "both" }, { [SCOPE_ENV]: "everything" }).agentScope).toBe("user");
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
    expect(callWeight({ tasks: [{}, {}, {}, {}, {}, {}, {}, {}] }, 6)).toBe(NATIVE_IN_CALL_CONCURRENCY);
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
    const ok = wrapExecute(asExecute(async () => ({ content: [] })), sem, {});
    await expect(ok("id2", { agent: "a", task: "t" })).resolves.toEqual({ content: [] });
  });
});

describe("nativeExtensionPath", () => {
  it("addresses the shipped example inside the installed package", () => {
    expect(nativeExtensionPath("/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/examples")).toBe(
      "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/index.ts",
    );
  });
});

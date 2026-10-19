// P2.6: TurnBudget, the one place a turn's deadline and $ cap are enforced.
// A fake target stands in for a session; timers are faked, no process spawns.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TurnBudget, termThenKill, type BudgetTarget } from "../src/engine/budget.js";
import { readBeat, startHeartbeat } from "../src/heartbeat.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const message = (cost: number) =>
  JSON.stringify({
    type: "message_end",
    message: { role: "assistant", usage: { cost: { total: cost } } },
  });
const update = (id: string, costs: number[], name = "lens") => ({
  type: "tool_execution_update",
  toolName: name,
  toolCallId: id,
  partialResult: { details: { results: costs.map((c) => ({ usage: { cost: { total: c } } })) } },
});

function fakeTarget(): BudgetTarget & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    abort: async () => {
      calls.push("abort");
    },
    dispose: async () => {
      calls.push("dispose");
    },
  };
}

/** A budget that is ended after the test: an unended one keeps its deadline in the heartbeat. */
const made: TurnBudget[] = [];
function make(target: BudgetTarget, opts: ConstructorParameters<typeof TurnBudget>[1]): TurnBudget {
  const b = new TurnBudget(target, opts);
  made.push(b);
  return b;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  for (const b of made.splice(0)) b.end();
  vi.useRealTimers();
});

describe("TurnBudget deadline", () => {
  it("aborts when the deadline passes, then disposes after the grace, then the backstop", async () => {
    const t = fakeTarget();
    const backstop = vi.fn();
    const trips: string[] = [];
    const b = make(t, {
      timeoutMs: 1_000,
      graceMs: 200,
      onTrip: (r) => trips.push(r),
      backstop,
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(t.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    expect(trips).toEqual(["timeout"]);
    expect(b.tripped).toBe("timeout");
    expect(t.calls).toEqual(["abort"]);
    await vi.advanceTimersByTimeAsync(199);
    expect(t.calls).toEqual(["abort", "dispose"]);
    expect(backstop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(backstop).toHaveBeenCalledWith("timeout");
    await b.settled();
  });

  it("stops after abort when the turn ends inside the grace", async () => {
    const t = fakeTarget();
    const backstop = vi.fn();
    const b = make(t, { timeoutMs: 100, graceMs: 500, backstop });
    await vi.advanceTimersByTimeAsync(101);
    b.end();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.calls).toEqual(["abort"]);
    expect(backstop).not.toHaveBeenCalled();
  });

  it("does not trip once the turn has ended", async () => {
    const t = fakeTarget();
    const b = make(t, { timeoutMs: 100, backstop: vi.fn() });
    b.end();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.calls).toEqual([]);
    expect(b.tripped).toBeNull();
  });

  it("goes on to dispose when abort rejects or never settles", async () => {
    const calls: string[] = [];
    const backstop = vi.fn();
    make(
      {
        abort: () => {
          calls.push("abort");
          return new Promise<void>(() => {});
        },
        dispose: () => {
          calls.push("dispose");
          return Promise.reject(new Error("boom"));
        },
      },
      { timeoutMs: 10, graceMs: 50, backstop },
    );
    await vi.advanceTimersByTimeAsync(11);
    expect(calls).toEqual(["abort"]);
    await vi.advanceTimersByTimeAsync(50);
    expect(calls).toEqual(["abort", "dispose"]);
    await vi.advanceTimersByTimeAsync(50);
    expect(backstop).toHaveBeenCalledTimes(1);
  });

  it("takes a grace per reason", async () => {
    const t = fakeTarget();
    make(t, { timeoutMs: 10, graceMs: { timeout: 300, cap: 5 }, backstop: vi.fn() });
    await vi.advanceTimersByTimeAsync(11);
    await vi.advanceTimersByTimeAsync(100);
    expect(t.calls).toEqual(["abort"]);
    await vi.advanceTimersByTimeAsync(200);
    expect(t.calls).toEqual(["abort", "dispose"]);
  });
});

describe("TurnBudget $ cap", () => {
  it("trips on message_end spend and on live lens updates, once", async () => {
    const t = fakeTarget();
    const b = make(t, { timeoutMs: 60_000, capUsd: 1, graceMs: 100, backstop: vi.fn() });
    b.observe(message(0.4));
    expect(b.tripped).toBeNull();
    b.observe(update("c1", [0.2]));
    b.observe(update("c1", [0.2, 0.3])); // the live figure grows to 0.5: 0.9 in all
    expect(b.tripped).toBeNull();
    b.observe(update("c1", [0.2, 0.3, 0.2])); // 1.1
    expect(b.tripped).toBe("cap");
    expect(b.spentUsd).toBeCloseTo(1.1);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.calls).toEqual(["abort"]);
    b.observe(message(5)); // after the trip nothing is metered or tripped again
    expect(b.spentUsd).toBeCloseTo(1.1);
    expect(t.calls).toEqual(["abort"]);
    b.end();
  });

  it("takes parsed events as well as lines", () => {
    const b = make(fakeTarget(), { timeoutMs: 60_000, capUsd: 0.5, backstop: vi.fn() });
    b.observe({
      type: "message_end",
      message: { role: "assistant", usage: { cost: { total: 0.6 } } },
    });
    expect(b.tripped).toBe("cap");
    b.end();
  });

  it("meters nothing without a cap", () => {
    const b = make(fakeTarget(), { timeoutMs: 60_000, backstop: vi.fn() });
    b.observe(message(100));
    expect(b.tripped).toBeNull();
    expect(b.spentUsd).toBe(0);
    b.end();
  });

  it("the first reason stands", async () => {
    const b = make(fakeTarget(), {
      timeoutMs: 100,
      capUsd: 1,
      graceMs: 10_000,
      backstop: vi.fn(),
    });
    b.observe(message(2));
    await vi.advanceTimersByTimeAsync(500);
    expect(b.tripped).toBe("cap");
    b.end();
  });
});

describe("termThenKill", () => {
  it("terminates now and kills after the grace", () => {
    const sigs: string[] = [];
    termThenKill((s) => sigs.push(s), 5_000);
    expect(sigs).toEqual(["SIGTERM"]);
    vi.advanceTimersByTime(5_000);
    expect(sigs).toEqual(["SIGTERM", "SIGKILL"]);
  });
});

describe("heartbeat", () => {
  it("rewrites its beat with the latest tracked deadline and the live groups", async () => {
    const dir = mkdtempSync(join(tmpdir(), "beat-"));
    try {
      const file = join(dir, "heartbeat.json");
      let clock = 1_000;
      const stop = startHeartbeat(file, { intervalMs: 100, now: () => clock, pgids: () => [42] });
      expect(readBeat(file)).toMatchObject({ seq: 1, at: 1_000, deadline_at: null, pgids: [42] });
      const b = make(fakeTarget(), { timeoutMs: 5_000, backstop: vi.fn() });
      // tracking the deadline writes a beat at once, not at the next interval
      expect(readBeat(file)).toMatchObject({ seq: 2, at: 1_000 });
      expect(readBeat(file)?.deadline_at).toBeGreaterThan(0);
      clock = 1_100;
      await vi.advanceTimersByTimeAsync(100);
      const beat = readBeat(file);
      expect(beat?.seq).toBe(3);
      expect(beat?.at).toBe(1_100);
      expect(beat?.deadline_at).toBeGreaterThan(0);
      b.end();
      await vi.advanceTimersByTimeAsync(100);
      expect(readBeat(file)?.deadline_at).toBeNull();
      stop();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(readBeat(file)?.seq).toBe(4);
      expect(readBeat(join(dir, "missing.json"))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

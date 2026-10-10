// The reconcile poll's one-pass-at-a-time guard, and its bound. One pass at a
// time keeps overlapping passes from paying every step twice; the bound keeps
// a pass that never settles from holding the guard for the rest of the daemon's life — and with it the
// authoritative reconcile, the push backstop and the sweep that releases a
// lost nudge's claim.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SingleFlight } from "../src/singleflight.js";

const OVERDUE_MS = 900_000;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function flight(): { sf: SingleFlight; overdue: number[] } {
  const overdue: number[] = [];
  const sf = new SingleFlight({
    overdueMs: () => OVERDUE_MS,
    now: () => Date.now(), // the faked clock
    onOverdue: (age) => overdue.push(age),
  });
  return { sf, overdue };
}

/** A pass the test settles by hand. */
function gatedPass(): { pass: () => Promise<string>; release: () => void; started: () => boolean } {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let started = false;
  return {
    pass: async () => {
      started = true;
      await gate;
      return "done";
    },
    release: () => release(),
    started: () => started,
  };
}

describe("SingleFlight — one pass at a time", () => {
  it("a second run waits for the first, then runs its own", async () => {
    const { sf } = flight();
    const a = gatedPass();
    const b = gatedPass();
    const ra = sf.run(a.pass);
    expect(a.started()).toBe(true); // started before run() returned
    expect(sf.running()).toBe(true);
    const rb = sf.run(b.pass);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(b.started()).toBe(false);
    a.release();
    await expect(ra).resolves.toBe("done");
    await vi.advanceTimersByTimeAsync(0);
    expect(b.started()).toBe(true);
    b.release();
    await expect(rb).resolves.toBe("done");
    expect(sf.running()).toBe(false);
  });

  it("a failed pass releases the guard: its caller gets the error, a waiter runs", async () => {
    const { sf } = flight();
    let fail!: (e: Error) => void;
    const failing = sf.run(() => new Promise<void>((_, reject) => (fail = reject)));
    const next = gatedPass();
    const waiting = sf.run(next.pass);
    fail(new Error("boom"));
    await expect(failing).rejects.toThrow("boom");
    await vi.advanceTimersByTimeAsync(0);
    expect(next.started()).toBe(true);
    next.release();
    await expect(waiting).resolves.toBe("done");
    expect(sf.running()).toBe(false);
  });
});

describe("SingleFlight — the bound", () => {
  it("a pass that never settles is abandoned once it is overdue, reported once, and a new pass runs", async () => {
    const { sf, overdue } = flight();
    const hung = gatedPass();
    void sf.run(hung.pass);
    await vi.advanceTimersByTimeAsync(OVERDUE_MS - 1);
    expect(sf.running()).toBe(true); // not yet: the tick is still skipped
    expect(overdue).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sf.running()).toBe(false); // abandoned
    expect(overdue).toEqual([OVERDUE_MS]);
    expect(sf.running()).toBe(false);
    expect(overdue).toHaveLength(1); // reported once, not per check
    const next = gatedPass();
    const rn = sf.run(next.pass);
    expect(next.started()).toBe(true);
    expect(sf.running()).toBe(true);
    // The abandoned pass waking late clears nothing: the guard is the new pass's.
    hung.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(sf.running()).toBe(true);
    next.release();
    await expect(rn).resolves.toBe("done");
    expect(sf.running()).toBe(false);
  });

  it("a caller waiting on a hung pass starts its own at the overdue point, never later", async () => {
    const { sf, overdue } = flight();
    const hung = gatedPass();
    void sf.run(hung.pass);
    await vi.advanceTimersByTimeAsync(OVERDUE_MS / 3);
    const waiter = gatedPass();
    const rw = sf.run(waiter.pass);
    await vi.advanceTimersByTimeAsync((OVERDUE_MS * 2) / 3 - 1);
    expect(waiter.started()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(waiter.started()).toBe(true);
    expect(overdue).toEqual([OVERDUE_MS]);
    waiter.release();
    await expect(rw).resolves.toBe("done");
    expect(vi.getTimerCount()).toBe(0); // the wait's timer is cleared
  });

  it("a wait that ends because the pass settled clears its timer", async () => {
    const { sf } = flight();
    const a = gatedPass();
    const ra = sf.run(a.pass);
    const rb = sf.run(async () => "b");
    expect(vi.getTimerCount()).toBe(1);
    a.release();
    await ra;
    await expect(rb).resolves.toBe("b");
    expect(vi.getTimerCount()).toBe(0);
  });
});

import { describe, expect, it } from "vitest";
import { anomalySeverity } from "../src/anomalies.js";
import {
  diffPinned,
  fingerprintPinned,
  PINNED_DEGRADED_KIND,
  PINNED_MODIFIED_KIND,
  readPinnedFromSweep,
  renderPinnedModifiedMessage,
  startEodPinWatch,
  type EodPinWatchDeps,
  type PinnedEntryView,
} from "../src/eodpinwatch.js";
import { startEodTimer } from "../src/eod.js";

const TZ = "Europe/Warsaw";

function entry(
  id: string,
  block: number,
  hash: string,
  ts = "2026-08-20 09:00:00",
): PinnedEntryView {
  return { id, ts, block, hash };
}

interface Logged {
  kind: string;
  detail: string;
  inject: string | undefined;
}

interface Harness {
  watch: ReturnType<typeof startEodPinWatch>;
  anomalies: Logged[];
  timers: Array<{ cb: () => void; ms: number }>;
  /** Run every armed timer callback once, newest arming appended. */
  tick: () => void;
  advance: (ms: number) => void;
  reads: number;
}

function harness(
  pinnedByRead: Array<readonly PinnedEntryView[] | (() => Promise<readonly PinnedEntryView[]>)>,
  over: Partial<EodPinWatchDeps> = {},
): Harness {
  let clock = new Date("2026-08-20T16:00:00Z"); // 18:00 Warsaw
  const timers: Array<{ cb: () => void; ms: number }> = [];
  const anomalies: Logged[] = [];
  const h = {
    anomalies,
    timers,
    reads: 0,
    tick(): void {
      const pending = timers.splice(0, timers.length);
      for (const t of pending) t.cb();
    },
    advance(ms: number): void {
      clock = new Date(clock.getTime() + ms);
    },
  } as Harness;
  h.watch = startEodPinWatch({
    readPinned: () => {
      const next = pinnedByRead[h.reads] ?? pinnedByRead[pinnedByRead.length - 1] ?? [];
      h.reads += 1;
      return typeof next === "function" ? next() : Promise.resolve(next);
    },
    logAnomaly: (kind, _pr, _round, detail, inject) => anomalies.push({ kind, detail, inject }),
    timeZone: TZ,
    windowMin: 90,
    pollMs: 60_000,
    now: () => clock,
    setTimer: (cb, ms) => {
      timers.push({ cb, ms });
      return timers.length - 1;
    },
    clearTimer: () => {},
    ...over,
  });
  return h;
}

describe("fingerprintPinned", () => {
  it("is order-independent and addresses by the (ts, id, block) triple", () => {
    const a = [
      entry("b1", 0, "h1"),
      entry("b1", 1, "h2"),
      entry("b2", 0, "h3", "2026-08-19 10:00:00"),
    ];
    const shuffled = [a[2]!, a[0]!, a[1]!];
    expect(fingerprintPinned(a).fingerprint).toBe(fingerprintPinned(shuffled).fingerprint);
    // Two entries of the SAME batch must not collapse into one address.
    expect(fingerprintPinned(a).entries.size).toBe(3);
  });

  it("changes when any hash, address or membership changes", () => {
    const base = fingerprintPinned([entry("b1", 0, "h1"), entry("b1", 1, "h2")]).fingerprint;
    expect(fingerprintPinned([entry("b1", 0, "h1x"), entry("b1", 1, "h2")]).fingerprint).not.toBe(
      base,
    );
    expect(fingerprintPinned([entry("b1", 0, "h1")]).fingerprint).not.toBe(base);
    expect(
      fingerprintPinned([entry("b1", 0, "h1"), entry("b1", 1, "h2"), entry("b9", 0, "h9")])
        .fingerprint,
    ).not.toBe(base);
  });

  it("names what moved", () => {
    const before = fingerprintPinned([entry("b1", 0, "h1"), entry("b1", 1, "h2")]);
    const after = fingerprintPinned([
      entry("b1", 0, "h1"),
      entry("b1", 1, "EDITED"),
      entry("b2", 0, "new"),
    ]);
    const d = diffPinned(before, after);
    expect(d.changed).toEqual(["2026-08-20 09:00:00 #b1 block 1"]);
    expect(d.added).toEqual(["2026-08-20 09:00:00 #b2 block 0"]);
    expect(d.removed).toEqual([]);
  });
});

describe("the watchdog never delays or blocks the sweep", () => {
  it("injects in the same tick even when the pinned read never settles", async () => {
    const order: string[] = [];
    const h = harness([
      () => {
        order.push("read");
        return new Promise<readonly PinnedEntryView[]>(() => {});
      },
    ]);
    const wrapped = h.watch.wrapInject(async () => {
      order.push("inject");
    });
    const inFlight = wrapped("EOD SWEEP 2026-08-20");
    // SAME TICK: the injection has already been entered before this assertion,
    // i.e. the watchdog put no await between the fire and the sweep prompt.
    // Awaiting the snapshot would leave `order` as ["read"] here and then hang
    // forever on the line below.
    expect(order).toEqual(["read", "inject"]);
    await inFlight;
    expect(h.reads).toBe(1);
    expect(h.watch.isOpen()).toBe(true);
    h.watch.stop();
  });

  it("injects when the reader throws synchronously", async () => {
    let injected = 0;
    const watch = startEodPinWatch({
      readPinned: () => {
        throw new Error("store client not constructed");
      },
      logAnomaly: () => {},
      timeZone: TZ,
      setTimer: () => 0,
      clearTimer: () => {},
    });
    const wrapped = watch.wrapInject(async () => {
      injected += 1;
    });
    await expect(wrapped("x")).resolves.toBeUndefined();
    expect(injected).toBe(1);
    watch.stop();
  });

  it("still injects when the whole watchdog is broken", async () => {
    let injected = 0;
    const watch = startEodPinWatch({
      readPinned: async () => [],
      logAnomaly: () => {},
      timeZone: TZ,
      setTimer: () => {
        throw new Error("timer subsystem exploded");
      },
      clearTimer: () => {},
    });
    const wrapped = watch.wrapInject(async () => {
      injected += 1;
    });
    await wrapped("x");
    expect(injected).toBe(1);
  });

  it("propagates the inject's own outcome untouched", async () => {
    const h = harness([[entry("b1", 0, "h1")]]);
    const wrapped = h.watch.wrapInject(async () => {
      throw new Error("tmux gone");
    });
    await expect(wrapped("x")).rejects.toThrow("tmux gone");
    h.watch.stop();
  });

  it("wires onto startEodTimer without changing the fire path", async () => {
    const h = harness([[entry("b1", 0, "h1")]]);
    let clock = new Date("2026-08-20T09:00:00Z");
    const timers: Array<{ cb: () => void; ms: number }> = [];
    const injected: string[] = [];
    const timer = startEodTimer({
      timeHHMM: "18:00",
      timeZone: TZ,
      now: () => clock,
      readPrompt: () => "sweep {{date}}",
      injectOverseer: h.watch.wrapInject(async (m) => {
        injected.push(m);
      }),
      setTimer: (cb, ms) => {
        timers.push({ cb, ms });
        return timers.length - 1;
      },
      clearTimer: () => {},
    });
    clock = new Date("2026-08-20T16:00:00Z");
    timers[0]!.cb();
    await new Promise((r) => setTimeout(r, 0));
    expect(injected).toEqual(["sweep 2026-08-20"]);
    expect(h.watch.isOpen()).toBe(true);
    timer.stop();
    h.watch.stop();
  });
});

describe("window close and verdict", () => {
  it("says nothing when the pinned area is unchanged", async () => {
    const pinned = [entry("b1", 0, "h1"), entry("b1", 1, "h2")];
    const h = harness([pinned, pinned]);
    await h.watch.wrapInject(async () => {})("x");
    h.advance(91 * 60_000);
    h.tick();
    await h.watch.settled();
    expect(h.anomalies).toEqual([]);
    expect(h.watch.isOpen()).toBe(false);
  });

  it("raises the loud kind naming the changed entries, and discloses BOTH explanations", async () => {
    const h = harness([
      [entry("b1", 0, "h1"), entry("b1", 1, "h2")],
      [entry("b1", 0, "h1"), entry("b1", 1, "CONSOLIDATED")],
    ]);
    await h.watch.wrapInject(async () => {})("x");
    h.advance(91 * 60_000);
    h.tick();
    await h.watch.settled();

    expect(h.anomalies).toHaveLength(1);
    const a = h.anomalies[0]!;
    expect(a.kind).toBe(PINNED_MODIFIED_KIND);
    expect(a.detail).toContain("2026-08-20 09:00:00 #b1 block 1");
    expect(a.detail).toContain("2026-08-20");
    // The false positive is disclosed in the wake text, not buried in a doc.
    expect(a.inject).toBeDefined();
    expect(a.inject).toContain("TWO explanations");
    expect(a.inject).toMatch(/curator/i);
    expect(a.inject).toMatch(/TUI/);
    expect(a.inject).toContain("do not assume (1)");
    expect(a.inject).toContain("2026-08-20 09:00:00 #b1 block 1");
  });

  it("catches an added pin and a removed pin too", async () => {
    const h = harness([[entry("b1", 0, "h1")], [entry("b2", 0, "h2")]]);
    await h.watch.wrapInject(async () => {})("x");
    h.advance(91 * 60_000);
    h.tick();
    await h.watch.settled();
    expect(h.anomalies[0]!.kind).toBe(PINNED_MODIFIED_KIND);
    expect(h.anomalies[0]!.detail).toContain("added 1");
    expect(h.anomalies[0]!.detail).toContain("removed 1");
  });

  it("closes early when the day's digest appears", async () => {
    let digest = false;
    const h = harness([[entry("b1", 0, "h1")], [entry("b1", 0, "EDITED")]], {
      digestReady: () => digest,
    });
    await h.watch.wrapInject(async () => {})("x");
    h.advance(60_000);
    h.tick();
    await h.watch.settled();
    expect(h.watch.isOpen()).toBe(true); // still watching, no digest yet
    expect(h.anomalies).toEqual([]);

    digest = true;
    h.advance(60_000);
    h.tick();
    await h.watch.settled();
    expect(h.watch.isOpen()).toBe(false);
    expect(h.anomalies[0]!.kind).toBe(PINNED_MODIFIED_KIND);
    // Closed on the digest, well inside the 90-minute window.
    expect(h.reads).toBe(2);
  });

  it("ignores a digest that already existed when the window opened", async () => {
    const h = harness([[entry("b1", 0, "h1")], [entry("b1", 0, "h1")]], {
      digestReady: () => true,
    });
    await h.watch.wrapInject(async () => {})("x");
    h.advance(60_000);
    h.tick();
    await h.watch.settled();
    // A pre-existing digest says nothing about THIS sweep — the window runs on.
    expect(h.watch.isOpen()).toBe(true);
    h.advance(91 * 60_000);
    h.tick();
    await h.watch.settled();
    expect(h.watch.isOpen()).toBe(false);
  });

  it("falls back to the window timer when the digest check throws", async () => {
    const h = harness([[entry("b1", 0, "h1")], [entry("b1", 0, "h1")]], {
      digestReady: () => {
        throw new Error("EACCES");
      },
    });
    await h.watch.wrapInject(async () => {})("x");
    h.advance(91 * 60_000);
    h.tick();
    await h.watch.settled();
    expect(h.watch.isOpen()).toBe(false);
    expect(h.anomalies).toEqual([]);
  });
});

describe("degradation is 'could not check', never 'changed'", () => {
  it("raises the quiet kind when the before-snapshot fails", async () => {
    const h = harness([
      () => Promise.reject(new Error("ECONNREFUSED 127.0.0.1:1933")),
      [entry("b1", 0, "h1")],
    ]);
    await h.watch.wrapInject(async () => {})("x");
    h.advance(91 * 60_000);
    h.tick();
    await h.watch.settled();
    expect(h.anomalies).toHaveLength(1);
    expect(h.anomalies[0]!.kind).toBe(PINNED_DEGRADED_KIND);
    expect(h.anomalies[0]!.detail).toContain("before-sweep snapshot");
    expect(h.anomalies[0]!.detail).toContain("UNVERIFIED");
    // No wake text: this kind is heartbeat-tier by design.
    expect(h.anomalies[0]!.inject).toBeUndefined();
  });

  it("raises the quiet kind when the after-snapshot fails", async () => {
    const h = harness([[entry("b1", 0, "h1")], () => Promise.reject(new Error("gone"))]);
    await h.watch.wrapInject(async () => {})("x");
    h.advance(91 * 60_000);
    h.tick();
    await h.watch.settled();
    expect(h.anomalies).toHaveLength(1);
    expect(h.anomalies[0]!.kind).toBe(PINNED_DEGRADED_KIND);
    expect(h.anomalies[0]!.detail).toContain("after-sweep snapshot");
  });

  it("a store sweep that could not read everything degrades — never a removal, never 'unchanged'", async () => {
    // The production reader: `read()` folds a dead server into `[]`, which the
    // watchdog took as a real, empty pinned area — every pin "removed" when
    // only the after-read failed, "unchanged" when both did.
    const pinned = { ...entry("b1", 0, "h1"), pinned: true };
    const dead = { entries: [], unread: ["ls viking://memories: ECONNREFUSED 127.0.0.1:1933"] };
    for (const sweeps of [
      [{ entries: [pinned], unread: [] }, dead],
      [dead, dead],
      [
        { entries: [pinned], unread: [] },
        { entries: [], unread: ["read x.md: 500"] },
      ],
    ]) {
      let n = 0;
      const reader = readPinnedFromSweep({ sweep: async () => sweeps[n++]! });
      const h = harness([() => reader(), () => reader()]);
      await h.watch.wrapInject(async () => {})("x");
      h.advance(91 * 60_000);
      h.tick();
      await h.watch.settled();
      expect(h.anomalies.map((a) => a.kind)).toEqual([PINNED_DEGRADED_KIND]);
    }
    // A complete sweep is an answer: unpinned entries filtered out, nothing raised.
    const whole = readPinnedFromSweep({
      sweep: async () => ({
        entries: [pinned, { ...entry("b2", 0, "h2"), pinned: false }],
        unread: [],
      }),
    });
    await expect(whole()).resolves.toEqual([pinned]);
  });

  it("reads the pinned AREA when the store has one (S5) — the directory every round's head reads", async () => {
    const pinned = { ...entry("b1", 0, "h1"), pinned: true };
    let sweeps = 0;
    let invalidated = 0;
    const reader = readPinnedFromSweep({
      invalidate: () => {
        invalidated += 1;
      },
      sweep: async () => {
        sweeps += 1;
        return { entries: [], unread: ["a full sweep must not be needed"] };
      },
      pinnedSweep: async () => ({ entries: [pinned], unread: [] }),
    });
    await expect(reader()).resolves.toEqual([pinned]);
    expect(sweeps).toBe(0);
    expect(invalidated).toBe(1);
    const partial = readPinnedFromSweep({
      sweep: async () => ({ entries: [], unread: [] }),
      pinnedSweep: async () => ({ entries: [], unread: ["read pinned/x.md: 500"] }),
    });
    await expect(partial()).rejects.toThrow(/not fully readable/);
  });

  it("degrades on a hung read without ever claiming a change", async () => {
    const h = harness(
      [() => new Promise<readonly PinnedEntryView[]>(() => {}), [entry("b1", 0, "h1")]],
      {
        readTimeoutMs: 5,
      },
    );
    await h.watch.wrapInject(async () => {})("x");
    h.advance(91 * 60_000);
    h.tick();
    await h.watch.settled();
    expect(h.anomalies.map((a) => a.kind)).toEqual([PINNED_DEGRADED_KIND]);
    expect(h.anomalies[0]!.detail).toContain("timeout");
  });
});

describe("severity policy", () => {
  it("promotes the modified kind to a wake and leaves degraded quiet", () => {
    expect(anomalySeverity(PINNED_MODIFIED_KIND)).toBe("wake");
    expect(anomalySeverity(PINNED_DEGRADED_KIND)).toBe("quiet");
  });
});

describe("lifecycle", () => {
  it("abandons an open window on stop rather than judging it", async () => {
    const h = harness([[entry("b1", 0, "h1")], [entry("b1", 0, "EDITED")]]);
    await h.watch.wrapInject(async () => {})("x");
    h.watch.stop();
    await h.watch.settled();
    expect(h.anomalies).toEqual([]);
    expect(h.watch.isOpen()).toBe(false);
  });

  it("holds no timer and makes no calls between sweeps", () => {
    const h = harness([[entry("b1", 0, "h1")]]);
    expect(h.timers).toHaveLength(0);
    expect(h.reads).toBe(0);
  });

  it("renders a window in local wall time", () => {
    const before = fingerprintPinned([entry("b1", 0, "h1")], Date.parse("2026-08-20T16:00:00Z"));
    const after = fingerprintPinned([entry("b1", 0, "h2")], Date.parse("2026-08-20T17:30:00Z"));
    const msg = renderPinnedModifiedMessage({
      date: "2026-08-20",
      diff: diffPinned(before, after),
      before,
      after,
      timeZone: TZ,
    });
    expect(msg).toContain("18:00–19:30 Europe/Warsaw");
  });
});

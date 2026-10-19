// Overseer wake policy: severity map + dedup on the logAnomaly
// funnel, and the daily 09:00 Warsaw heartbeat (fake inject sink, fake clock).
import { describe, expect, it } from "vitest";
import {
  ANOMALY_DEDUP_WINDOW_MS,
  AnomalyWakePolicy,
  anomalySeverity,
  detailKeyedKinds,
  renderHeartbeatMessage,
  startHeartbeat,
  wakeKinds,
} from "../src/anomalies.js";
import { EVENT_LOOP_WAKE_KIND } from "../src/eventloop.js";
import { MEMORY_WAKE } from "../src/memory/health.js";
import { LEARNER_WAKE } from "../src/learner/learner.js";
import { StateStore } from "../src/state.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const TZ = "Europe/Warsaw";

/** A store whose logAnomaly forwards to a wake policy writing into `injected`. */
function storeWithPolicy(opts: { nowMs?: () => number; failInject?: boolean } = {}): {
  store: StateStore;
  injected: string[];
} {
  const injected: string[] = [];
  const store = new StateStore(":memory:");
  const policy = new AnomalyWakePolicy({
    writeInbox: (m) => {
      if (opts.failInject) return Promise.reject(new Error("tmux gone"));
      injected.push(m);
      return Promise.resolve();
    },
    ...(opts.nowMs ? { now: () => new Date(opts.nowMs!()) } : {}),
  });
  store.setAnomalySink((s) => policy.onAnomaly(s));
  return { store, injected };
}

describe("WAKE_KINDS — pinned by deep equality", () => {
  // Promoting a kind to WAKE is a decision, never a side effect of adding one:
  // a new kind defaults quiet, and this list is the record of every promotion.
  it("is exactly this set", () => {
    expect(wakeKinds()).toEqual(
      [
        "archive_disk_low",
        "archive_live_cap",
        "archive_restore_failed",
        "author_reply_wake_dropped",
        "daemon_event_loop_stalled",
        "eod_curation_missing",
        "eod_inject_failed",
        "eod_lessons_not_persisted",
        "eod_pinned_area_modified",
        "findings_record_unresolved",
        "git_config_modified",
        "ledger_stale_unresolved",
        "malformed",
        "memory_auth_failed",
        "memory_down",
        "memory_provision_failed",
        "memory_write_backlog",
        "migration_collision_comment_withheld",
        "migration_precheck_degraded",
        "overdue",
        "pass_plan_mismatch",
        "pi_auth_expired",
        "login_refresh_failed",
        "policy_surface_modified",
        "review_failed_loud",
        "round_stranded",
        "ungated_approval",
      ].sort(),
    );
  });

  // A curation that did not reach memory wakes — the learner's two kinds,
  // spelled once in src/learner/learner.ts.
  it("the learner's two kinds wake", () => {
    for (const kind of Object.values(LEARNER_WAKE))
      expect(anomalySeverity(kind), kind).toBe("wake");
  });

  // The daemon's own event loop held — spelled once in
  // src/eventloop.ts; the watch's cooldown rate-limits it, not the detail.
  it("the event-loop stall wakes, keyed on kind (not detail)", () => {
    expect(anomalySeverity(EVENT_LOOP_WAKE_KIND)).toBe("wake");
    expect(detailKeyedKinds()).not.toContain(EVENT_LOOP_WAKE_KIND);
  });

  // The memory health monitor's kinds are wakes, so an outage reaches a
  // person; the counted gap row and the per-round degraded kind stay quiet.
  it("the memory health kinds wake; openviking_gap stays quiet", () => {
    for (const kind of Object.values(MEMORY_WAKE)) expect(anomalySeverity(kind), kind).toBe("wake");
    expect(anomalySeverity("openviking_gap")).toBe("quiet");
    expect(anomalySeverity("round_memory_degraded")).toBe("quiet");
  });
});

describe("anomalySeverity — the map", () => {
  it("wake classes: malformed/overdue verdicts, plan≠executed, degraded migration pre-check, withheld collision comment", () => {
    for (const kind of [
      "malformed",
      "overdue",
      "pass_plan_mismatch",
      "migration_precheck_degraded",
      "migration_collision_comment_withheld",
    ]) {
      expect(anomalySeverity(kind), kind).toBe("wake");
    }
  });

  it("quiet classes and anything unlisted default quiet — new kinds never spam", () => {
    for (const kind of [
      "recheck_merge_verify_degraded",
      "recheck_delta_failed",
      "slack_connections",
      "brand_new_kind",
    ]) {
      expect(anomalySeverity(kind), kind).toBe("quiet");
    }
  });

  // The two cancellation kinds, and why they sit on opposite sides.
  it("a stranded round wakes: nothing else will ever come back for it", () => {
    expect(anomalySeverity("round_stranded")).toBe("wake");
  });

  it("`round_stopped_dead` stays quiet HERE — its wake is the self-requeue inject, and would double", () => {
    expect(anomalySeverity("round_stopped_dead")).toBe("quiet");
  });
});

describe("logAnomaly → wake funnel", () => {
  it("a wake-class anomaly writes the DB row AND the overseer inject, verbatim from injectMessage", () => {
    const { store, injected } = storeWithPolicy();
    store.logAnomaly(
      "malformed",
      42,
      3,
      "bad verdict json",
      "ANOMALY (malformed) — PR #42 round 3\nbespoke body",
    );
    expect(store.anomalies().map((a) => a.kind)).toEqual(["malformed"]);
    expect(injected).toEqual(["ANOMALY (malformed) — PR #42 round 3\nbespoke body"]);
  });

  it("builds a generic inject when the call site passes no message", () => {
    const { store, injected } = storeWithPolicy();
    store.logAnomaly("overdue", 7, 2, "round blew the deadline");
    expect(injected).toEqual(["ANOMALY (overdue) — PR #7 round 2\nround blew the deadline"]);
  });

  it("quiet classes stay DB-only", () => {
    const { store, injected } = storeWithPolicy();
    store.logAnomaly("recheck_merge_verify_degraded", 5, null, "merge-verify degraded");
    store.logAnomaly("recheck_delta_failed", 5, null, "delta read failed");
    expect(store.anomalies()).toHaveLength(2);
    expect(injected).toEqual([]);
  });

  it("an UNLISTED kind is quiet even when the caller offers an inject message (default-quiet rule)", () => {
    const { store, injected } = storeWithPolicy();
    store.logAnomaly(
      "slack_connections",
      null,
      null,
      "2 consumers",
      "should not be used by the funnel",
    );
    store.logAnomaly("never_seen_before", 9, 1, "novel failure", "also unused");
    expect(store.anomalies()).toHaveLength(2);
    expect(injected).toEqual([]);
  });

  it("memory wakes dedup on what they SAY: a different transition wakes, an identical repeat does not", () => {
    // The monitor raises a memory wake per transition; keyed on kind alone, a
    // second transition inside the window would be swallowed.
    let nowMs = 1_000_000;
    const { store, injected } = storeWithPolicy({ nowMs: () => nowMs });
    store.logAnomaly("memory_auth_failed", null, null, "daemon auth_failed", "first");
    nowMs += 60_000;
    store.logAnomaly("memory_auth_failed", null, null, "daemon + sessions auth_failed", "second");
    nowMs += 60_000;
    store.logAnomaly("memory_auth_failed", null, null, "daemon + sessions auth_failed", "repeat");
    expect(injected).toEqual(["first", "second"]);
    expect(store.anomalies()).toHaveLength(3);
    // Every other wake kind keeps the kind+pr key.
    store.logAnomaly("overdue", 10, 1, "a");
    store.logAnomaly("overdue", 10, 2, "b — a different detail, still the same wake");
    expect(injected).toHaveLength(3);
  });

  it("the detail-keyed kinds are exactly the memory kinds — pinned", () => {
    // The write backlog is among them: its raiser (the backfill pump) fires
    // on the crossing, every 6 h, and once per tick that gave rows up.
    expect(detailKeyedKinds()).toEqual([
      "eod_curation_missing",
      "eod_lessons_not_persisted",
      "memory_auth_failed",
      "memory_down",
      "memory_provision_failed",
      "memory_write_backlog",
    ]);
    for (const kind of detailKeyedKinds()) expect(anomalySeverity(kind), kind).toBe("wake");
  });

  it("dedups identical kind+pr inside the window — the row is still written every time", () => {
    let nowMs = 1_000_000;
    const { store, injected } = storeWithPolicy({ nowMs: () => nowMs });
    store.logAnomaly("overdue", 10, 1, "first");
    nowMs += ANOMALY_DEDUP_WINDOW_MS - 1;
    store.logAnomaly("overdue", 10, 2, "second — suppressed wake");
    expect(injected).toHaveLength(1);
    expect(store.anomalies()).toHaveLength(2); // audit trail never deduped
    // Past the window it wakes again.
    nowMs += 2;
    store.logAnomaly("overdue", 10, 3, "third — window elapsed");
    expect(injected).toHaveLength(2);
  });

  it("does not dedup across different PRs or different kinds", () => {
    const { store, injected } = storeWithPolicy();
    store.logAnomaly("overdue", 1, 1, "a");
    store.logAnomaly("overdue", 2, 1, "b");
    store.logAnomaly("malformed", 1, 1, "c");
    expect(injected).toHaveLength(3);
  });

  it("a failed inject never throws out of logAnomaly, and the row survives", () => {
    const { store } = storeWithPolicy({ failInject: true });
    expect(() => store.logAnomaly("malformed", 3, 1, "detail")).not.toThrow();
    expect(store.anomalies()).toHaveLength(1);
  });

  it("a failed inject holds no dedup window: the next identical signal wakes", async () => {
    const injected: string[] = [];
    let fail = true;
    const policy = new AnomalyWakePolicy({
      writeInbox: (m) => {
        if (fail) return Promise.reject(new Error("tmux gone"));
        injected.push(m);
        return Promise.resolve();
      },
      now: () => new Date(0),
    });
    const signal = {
      ts: new Date(0).toISOString(),
      kind: "round_stranded",
      pr: 7,
      round_no: 2,
      detail: "stranded",
    };
    policy.onAnomaly(signal);
    await new Promise((r) => setImmediate(r));
    fail = false;
    policy.onAnomaly(signal);
    await new Promise((r) => setImmediate(r));
    expect(injected).toHaveLength(1);
    // Delivered now: the window holds the third.
    policy.onAnomaly(signal);
    await new Promise((r) => setImmediate(r));
    expect(injected).toHaveLength(1);
  });

  it("a failed inject is retried by the policy itself — a one-shot producer never signals again", async () => {
    const injected: string[] = [];
    const timers: Array<() => void> = [];
    let failures = 2;
    const policy = new AnomalyWakePolicy({
      writeInbox: (m) => {
        if (failures-- > 0) return Promise.reject(new Error("tmux gone"));
        injected.push(m);
        return Promise.resolve();
      },
      now: () => new Date(0),
      retryBackoffMs: [60_000, 60_000],
      setTimer: (cb) => timers.push(cb),
    });
    policy.onAnomaly({
      ts: new Date(0).toISOString(),
      kind: "round_stranded",
      pr: 7,
      round_no: 2,
      detail: "stranded",
    });
    await new Promise((r) => setImmediate(r));
    expect(timers).toHaveLength(1);
    timers.shift()!(); // retry 1 fails
    await new Promise((r) => setImmediate(r));
    expect(injected).toEqual([]);
    timers.shift()!(); // retry 2 delivers
    await new Promise((r) => setImmediate(r));
    expect(injected).toHaveLength(1);
    expect(injected[0]).toContain("stranded");
    expect(timers).toHaveLength(0);
  });

  it("past the last retry the wake is lost (the row stays); a later identical signal skips the retry", async () => {
    const timers: Array<() => void> = [];
    let calls = 0;
    let fail = true;
    const policy = new AnomalyWakePolicy({
      writeInbox: () => {
        calls += 1;
        return fail ? Promise.reject(new Error("tmux gone")) : Promise.resolve();
      },
      now: () => new Date(0),
      retryBackoffMs: [60_000],
      setTimer: (cb) => timers.push(cb),
    });
    const signal = {
      ts: new Date(0).toISOString(),
      kind: "round_stranded",
      pr: 7,
      round_no: 2,
      detail: "stranded",
    };
    policy.onAnomaly(signal);
    await new Promise((r) => setImmediate(r));
    timers.shift()!();
    await new Promise((r) => setImmediate(r));
    expect(calls).toBe(2);
    expect(timers).toHaveLength(0); // exhausted
    // A new failure arms a retry; the next identical signal delivers first,
    // and the retry then injects nothing more.
    policy.onAnomaly(signal);
    await new Promise((r) => setImmediate(r));
    expect(timers).toHaveLength(1);
    fail = false;
    policy.onAnomaly(signal);
    await new Promise((r) => setImmediate(r));
    expect(calls).toBe(4);
    timers.shift()!();
    await new Promise((r) => setImmediate(r));
    expect(calls).toBe(4);
  });

  it("a newer failed signal owns the only retry chain, even at the same clock instant", async () => {
    const timers: Array<() => void> = [];
    const pending: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
    let calls = 0;
    const policy = new AnomalyWakePolicy({
      writeInbox: () => {
        calls++;
        return new Promise<void>((resolve, reject) => pending.push({ resolve, reject }));
      },
      now: () => new Date(0),
      retryBackoffMs: [60_000, 60_000],
      setTimer: (cb) => {
        timers.push(cb);
        return cb;
      },
      clearTimer: () => {}, // also exercise an obsolete callback already queued
    });
    const signal = {
      ts: new Date(0).toISOString(),
      kind: "round_stranded",
      pr: 7,
      round_no: 2,
      detail: "stranded",
    };
    policy.onAnomaly(signal);
    pending.shift()!.reject(new Error("first unavailable"));
    await new Promise((r) => setImmediate(r));
    const obsolete = timers.shift()!;
    policy.onAnomaly(signal);
    pending.shift()!.reject(new Error("second unavailable"));
    await new Promise((r) => setImmediate(r));
    obsolete();
    expect(calls).toBe(2);
    timers.shift()!();
    expect(calls).toBe(3);
    pending.shift()!.resolve();
    await new Promise((r) => setImmediate(r));
    expect(timers).toHaveLength(0);
    policy.stop();
  });

  it("a hook that throws synchronously is contained: logAnomaly never throws, and it is retried", async () => {
    const timers: Array<() => void> = [];
    const store = new StateStore(":memory:");
    const policy = new AnomalyWakePolicy({
      writeInbox: () => {
        throw new Error("sync failure");
      },
      now: () => new Date(0),
      retryBackoffMs: [60_000],
      setTimer: (cb) => timers.push(cb),
    });
    store.setAnomalySink((s) => policy.onAnomaly(s));
    expect(() => store.logAnomaly("round_stranded", 3, 1, "detail")).not.toThrow();
    await new Promise((r) => setImmediate(r));
    expect(store.anomalies()).toHaveLength(1);
    expect(timers).toHaveLength(1);
    policy.stop();
  });

  it("stop() disarms a pending retry", async () => {
    const timers: Array<() => void> = [];
    const cleared: unknown[] = [];
    let calls = 0;
    const policy = new AnomalyWakePolicy({
      writeInbox: () => {
        calls += 1;
        return Promise.reject(new Error("tmux gone"));
      },
      now: () => new Date(0),
      retryBackoffMs: [60_000],
      setTimer: (cb) => {
        timers.push(cb);
        return cb;
      },
      clearTimer: (h) => cleared.push(h),
    });
    policy.onAnomaly({
      ts: new Date(0).toISOString(),
      kind: "round_stranded",
      pr: 7,
      round_no: 2,
      detail: "stranded",
    });
    await new Promise((r) => setImmediate(r));
    policy.stop();
    expect(cleared).toEqual([timers[0]]);
    timers[0]!(); // even a timer that ran anyway injects nothing
    await new Promise((r) => setImmediate(r));
    expect(calls).toBe(1);
  });

  it("a bare store (no sink) still records — nothing wakes, nothing throws", () => {
    const store = new StateStore(":memory:");
    store.logAnomaly("malformed", 1, 1, "no sink wired");
    expect(store.anomalies()).toHaveLength(1);
  });
});

// ---- heartbeat -------------------------------------------------------------

class FakeClock {
  private timers: Array<{ cb: () => void; at: number }> = [];
  constructor(public nowMs: number) {}
  now = (): Date => new Date(this.nowMs);
  setTimer = (cb: () => void, ms: number): unknown => {
    const t = { cb, at: this.nowMs + ms };
    this.timers.push(t);
    return t;
  };
  clearTimer = (h: unknown): void => {
    this.timers = this.timers.filter((t) => t !== h);
  };
  /** Advance wall time, running due timers (and their microtasks) in order. */
  async advanceTo(iso: string): Promise<void> {
    const targetMs = new Date(iso).getTime();
    for (;;) {
      const due = this.timers.filter((t) => t.at <= targetMs).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.nowMs = Math.max(this.nowMs, due.at);
      due.cb();
      await new Promise((r) => setImmediate(r));
    }
    this.nowMs = targetMs;
  }
}

function heartbeatHarness(
  startIso: string,
  store = new StateStore(":memory:"),
): {
  clock: FakeClock;
  store: StateStore;
  injected: string[];
  start: () => ReturnType<typeof startHeartbeat>;
} {
  const clock = new FakeClock(new Date(startIso).getTime());
  const injected: string[] = [];
  return {
    clock,
    store,
    injected,
    start: () =>
      startHeartbeat({
        timeHHMM: "09:00",
        timeZone: TZ,
        lastFired: () => store.lastHeartbeatDate(),
        recordFired: (date) => store.recordHeartbeat(date),
        writeInbox: (m) => {
          injected.push(m);
          return Promise.resolve();
        },
        now: clock.now,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
      }),
  };
}

describe("heartbeat persistence (StateStore)", () => {
  it("records and reads back the last fired date across an events-table round trip", () => {
    const store = new StateStore(":memory:");
    expect(store.lastHeartbeatDate()).toBeNull();
    store.recordHeartbeat("2026-08-19");
    store.recordHeartbeat("2026-08-20");
    expect(store.lastHeartbeatDate()).toBe("2026-08-20");
  });
});

describe("renderHeartbeatMessage", () => {
  it("names the date, the since-hint, and the read-and-report boundary", () => {
    const m = renderHeartbeatMessage("2026-08-20", "2026-08-19");
    expect(m).toContain("HEARTBEAT — 2026-08-20");
    expect(m).toContain("since the last heartbeat (2026-08-19)");
    expect(m).toContain("Flag-owner");
    expect(renderHeartbeatMessage("2026-08-20", null)).toContain("first heartbeat on record");
  });
});

describe("startHeartbeat — daily fire", () => {
  it(
    "boot before 09:00 Warsaw: no catch-up, fires at 09:00, then once per following day",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      // 2026-08-19 06:00Z = 08:00 Warsaw (CEST).
      const h = heartbeatHarness("2026-08-19T06:00:00Z");
      const hb = h.start();
      await hb.booted;
      expect(h.injected).toEqual([]);
      expect(hb.nextFire().toISOString()).toBe("2026-08-19T07:00:00.000Z"); // 09:00 CEST

      await h.clock.advanceTo("2026-08-19T07:00:01Z");
      expect(h.injected).toHaveLength(1);
      expect(h.injected[0]).toContain("HEARTBEAT — 2026-08-19");
      expect(h.store.lastHeartbeatDate()).toBe("2026-08-19");

      await h.clock.advanceTo("2026-08-20T12:00:00Z");
      expect(h.injected).toHaveLength(2);
      expect(h.injected[1]).toContain("2026-08-20");
      expect(h.injected[1]).toContain("since the last heartbeat (2026-08-19)");
      hb.stop();
    },
  );

  it("boot AFTER 09:00 with no fire today: exactly one catch-up, then tomorrow", async () => {
    const h = heartbeatHarness("2026-08-19T12:00:00Z"); // 14:00 Warsaw
    const hb = h.start();
    await hb.booted;
    expect(h.injected).toHaveLength(1);
    expect(h.injected[0]).toContain("2026-08-19");
    expect(h.store.lastHeartbeatDate()).toBe("2026-08-19");
    expect(hb.nextFire().toISOString()).toBe("2026-08-20T07:00:00.000Z");
    hb.stop();
  });

  it("catch-up is at most ONE even after days of downtime — missed days are not replayed", async () => {
    const store = new StateStore(":memory:");
    store.recordHeartbeat("2026-08-14"); // last fire five days ago
    const h = heartbeatHarness("2026-08-19T12:00:00Z", store);
    const hb = h.start();
    await hb.booted;
    expect(h.injected).toHaveLength(1); // today only, not 15th–18th
    expect(h.injected[0]).toContain("HEARTBEAT — 2026-08-19");
    expect(h.injected[0]).toContain("(2026-08-14)"); // the reading window is named
    hb.stop();
  });

  it("restart after today's fire: no second inject (persisted date is the guard)", async () => {
    const store = new StateStore(":memory:");
    store.recordHeartbeat("2026-08-19");
    const h = heartbeatHarness("2026-08-19T12:00:00Z", store);
    const hb = h.start();
    await hb.booted;
    expect(h.injected).toEqual([]);
    expect(hb.nextFire().toISOString()).toBe("2026-08-20T07:00:00.000Z");
    hb.stop();
  });

  it(
    "fires once per Warsaw day across spring-forward (2026-03-29), offset flipping",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const h = heartbeatHarness("2026-03-28T00:00:00Z");
      const hb = h.start();
      await hb.booted;
      await h.clock.advanceTo("2026-03-30T23:00:00Z");
      expect(h.injected).toHaveLength(3);
      expect(h.injected.map((m) => m.split("\n")[0])).toEqual([
        "HEARTBEAT — 2026-03-28",
        "HEARTBEAT — 2026-03-29",
        "HEARTBEAT — 2026-03-30",
      ]);
      hb.stop();
    },
  );

  it("keeps the next daily heartbeat owed when an earlier day's retry crosses its slot", async () => {
    const store = new StateStore(":memory:");
    const clock = new FakeClock(new Date("2026-08-19T06:00:00Z").getTime());
    const delivered: string[] = [];
    let fail = true;
    const hb = startHeartbeat({
      timeHHMM: "09:00",
      timeZone: TZ,
      lastFired: () => store.lastHeartbeatDate(),
      recordFired: (date) => store.recordHeartbeat(date),
      writeInbox: async (message) => {
        if (fail) {
          fail = false;
          throw new Error("temporarily unavailable");
        }
        delivered.push(message);
      },
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      retryBackoffMs: [24 * 60 * 60_000 + 60_000],
    });
    try {
      await hb.booted;
      await clock.advanceTo("2026-08-20T07:02:00Z");
      expect(delivered.map((text) => /HEARTBEAT — (\d{4}-\d{2}-\d{2})/.exec(text)?.[1])).toEqual([
        "2026-08-19",
        "2026-08-20",
      ]);
      expect(store.lastHeartbeatDate()).toBe("2026-08-20");
    } finally {
      hb.stop();
      store.close();
    }
  });

  it("a failed inject is retried the same day, then the next day's slot is armed", async () => {
    const store = new StateStore(":memory:");
    const clock = new FakeClock(new Date("2026-08-19T06:00:00Z").getTime());
    const injected: string[] = [];
    let failures = 2;
    const hb = startHeartbeat({
      timeHHMM: "09:00",
      timeZone: TZ,
      lastFired: () => store.lastHeartbeatDate(),
      recordFired: (date) => store.recordHeartbeat(date),
      writeInbox: (m) => {
        if (failures > 0) {
          failures -= 1;
          return Promise.reject(new Error("tmux gone"));
        }
        injected.push(m);
        return Promise.resolve();
      },
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      retryBackoffMs: [60_000, 300_000],
    });
    await hb.booted;
    await clock.advanceTo("2026-08-19T07:00:01Z"); // the slot: fails
    expect(injected).toEqual([]);
    expect(hb.nextFire().toISOString()).toBe("2026-08-19T07:01:00.000Z");
    await clock.advanceTo("2026-08-19T07:10:00Z"); // retry 1 fails, retry 2 delivers
    expect(injected).toHaveLength(1);
    expect(injected[0]).toContain("HEARTBEAT — 2026-08-19");
    expect(store.lastHeartbeatDate()).toBe("2026-08-19");
    expect(hb.nextFire().toISOString()).toBe("2026-08-20T07:00:00.000Z");
    hb.stop();
  });

  it("a day's retries exhausted: the next day's slot is armed, nothing more today", async () => {
    const clock = new FakeClock(new Date("2026-08-19T06:00:00Z").getTime());
    let calls = 0;
    const hb = startHeartbeat({
      timeHHMM: "09:00",
      timeZone: TZ,
      lastFired: () => null,
      recordFired: () => {},
      writeInbox: () => {
        calls += 1;
        return Promise.reject(new Error("tmux gone"));
      },
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      retryBackoffMs: [60_000],
    });
    await hb.booted;
    await clock.advanceTo("2026-08-19T08:00:00Z");
    expect(calls).toBe(2); // the slot and one retry
    expect(hb.nextFire().toISOString()).toBe("2026-08-20T07:00:00.000Z");
    hb.stop();
  });

  it("a failed boot catch-up is retried too", async () => {
    const store = new StateStore(":memory:");
    const clock = new FakeClock(new Date("2026-08-19T12:00:00Z").getTime());
    let failures = 1;
    const injected: string[] = [];
    const hb = startHeartbeat({
      timeHHMM: "09:00",
      timeZone: TZ,
      lastFired: () => store.lastHeartbeatDate(),
      recordFired: (date) => store.recordHeartbeat(date),
      writeInbox: (m) => {
        if (failures-- > 0) return Promise.reject(new Error("tmux gone"));
        injected.push(m);
        return Promise.resolve();
      },
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      retryBackoffMs: [60_000],
    });
    await hb.booted;
    expect(injected).toEqual([]);
    await clock.advanceTo("2026-08-19T12:02:00Z");
    expect(injected).toHaveLength(1);
    expect(injected[0]).toContain("HEARTBEAT — 2026-08-19");
    expect(hb.nextFire().toISOString()).toBe("2026-08-20T07:00:00.000Z");
    hb.stop();
  });

  it("a delivered check-in whose stamp fails to record is not injected again", async () => {
    const clock = new FakeClock(new Date("2026-08-19T06:00:00Z").getTime());
    let calls = 0;
    const hb = startHeartbeat({
      timeHHMM: "09:00",
      timeZone: TZ,
      lastFired: () => null,
      recordFired: () => {
        throw new Error("SQLITE_BUSY");
      },
      writeInbox: () => {
        calls += 1;
        return Promise.resolve();
      },
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      retryBackoffMs: [60_000, 300_000],
    });
    await hb.booted;
    await clock.advanceTo("2026-08-19T08:00:00Z");
    expect(calls).toBe(1);
    expect(hb.nextFire().toISOString()).toBe("2026-08-20T07:00:00.000Z");
    hb.stop();
  });

  it("stop() disarms — nothing fires after", async () => {
    const h = heartbeatHarness("2026-08-19T06:00:00Z");
    const hb = h.start();
    await hb.booted;
    hb.stop();
    await h.clock.advanceTo("2026-08-21T12:00:00Z");
    expect(h.injected).toEqual([]);
  });
});

// The exec boundary's two wake tiers, pinned: without these assertions,
// reverting the tiers in `src/anomalies.ts` would leave the suite green. Both
// directions are asserted, because the quiet tier is as deliberate as the
// loud one — an unaccounted non-APPROVE
// review is a durable row, and alarming on it would train the reader to skip
// the kind that matters.
describe("exec-boundary anomaly tiers", () => {
  it("wakes on the outcomes that defeat rule 1 and the CI hard-gate", () => {
    // An APPROVE the daemon has no record of posting bypasses the mutation
    // gate, the CI gate and every posting guard at once.
    expect(anomalySeverity("ungated_approval")).toBe("wake");
    // Git config rewritten mid-round makes that round's output untrusted:
    // config-supplied shell turns a plain `git diff` into arbitrary execution.
    expect(anomalySeverity("git_config_modified")).toBe("wake");
    // The boundary's own policy surface rewritten mid-round is worse
    // still — every later round in the container runs under the rewrite.
    expect(anomalySeverity("policy_surface_modified")).toBe("wake");
  });

  it("stays quiet on the sibling that is a record, not an alarm", () => {
    expect(anomalySeverity("ungated_review")).toBe("quiet");
  });
});

// reviewer-memory health: the state machine that makes a memory
// outage reach a person. Fake probes, fake clock, fake wake sink, fake
// incident store; no I/O.
//
// The acceptance criteria of the slice, pinned here:
//   * state is `unknown` before the first probe;
//   * a 401 wakes on the first probe (and from a real request);
//   * a dead transport raises `memory_down` at 10 min;
//   * the two credentials are judged and reported separately;
//   * a drain defers `memory_down`, never an auth failure.
import { describe, expect, it } from "vitest";
import { AnomalyWakePolicy } from "../src/anomalies.js";
import { StateStore } from "../src/state.js";
import {
  MEMORY_WAKE,
  MemoryHealthMonitor,
  disabledMemoryStatus,
  memoryStatusLine,
  pendingMemoryStatus,
  type CredentialName,
  type MemoryIncident,
  type ProbeAnswer,
} from "../src/memory/health.js";

const MIN = 60_000;
const T0 = Date.parse("2026-10-06T12:00:00.000Z");

const OK: ProbeAnswer = { result: "ok", status: 200, code: "", ms: 3 };
const AUTH: ProbeAnswer = {
  result: "auth_failed",
  status: 401,
  code: "UNAUTHENTICATED",
  ms: 4,
  detail: "Invalid API Key",
};
const DEAD: ProbeAnswer = {
  result: "unreachable",
  status: 0,
  code: "transport",
  ms: 1,
  detail: "connect ECONNREFUSED 127.0.0.1:1933",
};
const ABSENT: ProbeAnswer = { result: "absent", status: 0, code: "absent", ms: 0 };

function harness(
  opts: {
    daemon?: ProbeAnswer;
    sessions?: ProbeAnswer;
    draining?: boolean;
    stored?: MemoryIncident | null;
  } = {},
) {
  let clock = T0;
  const answers: Record<CredentialName, ProbeAnswer> = {
    daemon: opts.daemon ?? OK,
    sessions: opts.sessions ?? OK,
  };
  const wakes: Array<{ kind: string; detail: string; message: string }> = [];
  const saved: Array<MemoryIncident | null> = [];
  let stored: MemoryIncident | null = opts.stored ?? null;
  let draining = opts.draining ?? false;
  let probes = 0;
  const monitor = new MemoryHealthMonitor({
    probes: {
      daemon: async () => {
        probes += 1;
        return answers.daemon;
      },
      sessions: async () => answers.sessions,
    },
    wake: (kind, detail, message) => wakes.push({ kind, detail, message }),
    draining: () => draining,
    now: () => new Date(clock),
    incidents: {
      load: () => stored,
      save: (i) => {
        stored = i;
        saved.push(i);
      },
    },
    where: { daemon: "secrets/openviking_reviewer_key", sessions: "ovcli.conf in the pi HOME" },
  });
  return {
    monitor,
    wakes,
    saved,
    stored: () => stored,
    probes: () => probes,
    set: (name: CredentialName, a: ProbeAnswer) => {
      answers[name] = a;
    },
    at: (ms: number) => {
      clock = T0 + ms;
    },
    drain: (on: boolean) => {
      draining = on;
    },
    /** Advance to `ms` after boot and probe. */
    probeAt: async (ms: number) => {
      clock = T0 + ms;
      await monitor.probeNow();
    },
  };
}

describe("memory health — before anything is measured", () => {
  it("is `unknown` before the first probe, with nothing claimed", () => {
    const h = harness();
    const s = h.monitor.status();
    expect(s.enabled).toBe(true);
    expect(s.state).toBe("unknown");
    expect(s.last_ok_at).toBeNull();
    expect(s.last_probe_at).toBeNull();
    expect(s.credentials).toEqual({ daemon: null, sessions: null });
    expect(s.incident).toBeNull();
    expect(s.provision).toBeNull();
    expect(h.wakes).toEqual([]);
  });

  it("an unknown block never reads healthy to a person", () => {
    const h = harness();
    expect(memoryStatusLine(h.monitor.status(), new Date(T0))).toMatch(/^memory: UNKNOWN/);
    // An older daemon's snapshot carries no block at all.
    expect(memoryStatusLine(undefined)).toMatch(/NOT REPORTED/);
    expect(memoryStatusLine(disabledMemoryStatus("[openviking] enabled = false"))).toBe(
      "memory: not monitored — [openviking] enabled = false",
    );
    // Before the daemon has built its monitor: unknown, never "off".
    const pending = pendingMemoryStatus(new Date(T0));
    expect(pending).toMatchObject({
      enabled: true,
      state: "unknown",
      credentials: { daemon: null },
    });
    expect(pending).not.toHaveProperty("disabled_reason");
    expect(memoryStatusLine(pending, new Date(T0))).toMatch(/^memory: UNKNOWN/);
  });

  it("start() probes at once and then on the interval", async () => {
    const scheduled: Array<{ fn: () => void; ms: number }> = [];
    let clock = T0;
    let probes = 0;
    const monitor = new MemoryHealthMonitor({
      probes: {
        daemon: async () => {
          probes += 1;
          return OK;
        },
        sessions: async () => OK,
      },
      wake: () => {},
      now: () => new Date(clock),
      schedule: (fn, ms) => {
        scheduled.push({ fn, ms });
        return () => {};
      },
      intervalMs: 120_000,
    });
    monitor.start();
    expect(scheduled.map((s) => s.ms)).toEqual([0]);
    scheduled[0]!.fn();
    await monitor.probeNow(); // joins the in-flight probe
    await new Promise((r) => setImmediate(r));
    expect(probes).toBe(1);
    expect(monitor.status().state).toBe("healthy");
    expect(scheduled.map((s) => s.ms)).toEqual([0, 120_000]);
    clock += 120_000;
    monitor.stop();
  });
});

describe("memory health — authentication failures wake at once", () => {
  it("a 401 on the FIRST probe wakes memory_auth_failed — no boot grace for auth", async () => {
    const h = harness({ daemon: AUTH });
    await h.probeAt(0);
    const s = h.monitor.status();
    expect(s.state).toBe("auth_failed");
    expect(h.wakes.map((w) => w.kind)).toEqual([MEMORY_WAKE.auth]);
    expect(h.wakes[0]!.message).toContain("MEMORY AUTH FAILED");
    expect(h.wakes[0]!.message).toContain(
      "daemon key (secrets/openviking_reviewer_key): auth_failed (401 UNAUTHENTICATED: Invalid API Key)",
    );
    expect(h.wakes[0]!.message).toContain("sessions' ovcli.conf (ovcli.conf in the pi HOME): ok");
    expect(h.wakes[0]!.message).toContain("Rounds are NOT blocked");
    // Reported per credential.
    expect(s.credentials.daemon).toMatchObject({
      result: "auth_failed",
      status: 401,
      source: "probe",
    });
    expect(s.credentials.sessions).toMatchObject({ result: "ok", source: "probe" });
    expect(s.incident).toEqual({ kind: "auth_failed", since: new Date(T0).toISOString() });
    expect(h.saved).toEqual([{ kind: "auth_failed", since: new Date(T0).toISOString() }]);
  });

  it("the sessions' credential is judged on its own: the daemon key fine, ovcli.conf refused", async () => {
    const h = harness({ sessions: AUTH });
    await h.probeAt(0);
    expect(h.monitor.status().state).toBe("auth_failed");
    expect(h.wakes[0]!.detail).toContain("sessions auth_failed");
    expect(h.wakes[0]!.detail).not.toContain("daemon auth_failed");
  });

  it("a missing key is an authentication failure, never quiet", async () => {
    const h = harness({ daemon: { result: "no_key", status: 0, code: "no_key", ms: 0 } });
    await h.probeAt(0);
    expect(h.monitor.status().state).toBe("auth_failed");
    expect(h.wakes.map((w) => w.kind)).toEqual([MEMORY_WAKE.auth]);
  });

  it("an absent ovcli.conf (no session born yet) is not a failure", async () => {
    const h = harness({ sessions: ABSENT });
    await h.probeAt(0);
    expect(h.monitor.status().state).toBe("healthy");
    expect(h.monitor.status().credentials.sessions).toMatchObject({ result: "absent" });
  });

  it("a 401 from one of the daemon's OWN requests wakes before any probe", () => {
    const h = harness();
    h.monitor.recordRequest({
      op: "search",
      outcome: "auth",
      status: 401,
      code: "UNAUTHENTICATED",
      ms: 12,
      message: "Invalid API Key",
    });
    expect(h.monitor.status().state).toBe("auth_failed");
    expect(h.monitor.status().credentials.daemon).toMatchObject({
      result: "auth_failed",
      source: "request",
    });
    expect(h.wakes.map((w) => w.kind)).toEqual([MEMORY_WAKE.auth]);
  });

  it("re-wakes on each transition and every 6 h while it lasts — not on every probe", async () => {
    const h = harness({ daemon: AUTH });
    await h.probeAt(0);
    for (let m = 2; m < 6 * 60; m += 2) await h.probeAt(m * MIN);
    expect(h.wakes).toHaveLength(1);
    await h.probeAt(6 * 60 * MIN);
    expect(h.wakes).toHaveLength(2);
    // A transition INSIDE auth_failed — the failing set changes — wakes too.
    h.set("sessions", AUTH);
    await h.probeAt(6 * 60 * MIN + 2 * MIN);
    expect(h.wakes).toHaveLength(3);
    expect(h.wakes[2]!.detail).toContain("sessions");
    // Recovery, then a NEW failure: a new transition, a new wake.
    h.set("daemon", OK);
    h.set("sessions", OK);
    await h.probeAt(6 * 60 * MIN + 4 * MIN);
    expect(h.monitor.status().state).toBe("healthy");
    h.set("daemon", AUTH);
    await h.probeAt(6 * 60 * MIN + 6 * MIN);
    expect(h.wakes).toHaveLength(4);
  });

  it("a drain NEVER suppresses an auth failure", async () => {
    const h = harness({ daemon: AUTH, draining: true });
    await h.probeAt(0);
    expect(h.wakes.map((w) => w.kind)).toEqual([MEMORY_WAKE.auth]);
  });

  it("a successful request proves the daemon key again", async () => {
    const h = harness({ daemon: AUTH });
    await h.probeAt(0);
    h.at(MIN);
    h.monitor.recordRequest({ op: "read", outcome: "ok", status: 200, code: "", ms: 5 });
    expect(h.monitor.status().state).toBe("healthy");
    expect(h.monitor.status().incident).toBeNull();
    expect(h.stored()).toBeNull();
  });
});

describe("memory health — a dead transport", () => {
  it("is unknown inside the boot grace, degraded after it, and raises memory_down at 10 min", async () => {
    const h = harness({ daemon: DEAD, sessions: DEAD });
    await h.probeAt(0);
    expect(h.monitor.status().state).toBe("unknown");
    await h.probeAt(2 * MIN);
    await h.probeAt(4 * MIN);
    expect(h.monitor.status().state).toBe("unknown");
    await h.probeAt(6 * MIN);
    expect(h.monitor.status().state).toBe("degraded");
    await h.probeAt(8 * MIN);
    expect(h.wakes).toEqual([]);
    await h.probeAt(10 * MIN);
    const s = h.monitor.status();
    expect(s.state).toBe("down");
    expect(h.wakes.map((w) => w.kind)).toEqual([MEMORY_WAKE.down]);
    expect(h.wakes[0]!.message).toContain("MEMORY DOWN");
    expect(h.wakes[0]!.message).toContain("none since the daemon booted");
    expect(h.wakes[0]!.message).toContain("ECONNREFUSED");
    expect(s.incident).toEqual({ kind: "down", since: new Date(T0 + 10 * MIN).toISOString() });
    expect(s.last_error).toMatchObject({ op: expect.stringMatching(/^probe:/), code: "transport" });
    // Not again on the next probe…
    await h.probeAt(12 * MIN);
    expect(h.wakes).toHaveLength(1);
    // …but again 6 h later.
    await h.probeAt(10 * MIN + 6 * 60 * MIN);
    expect(h.wakes).toHaveLength(2);
  });

  it("counts from the last authenticated answer once there was one", async () => {
    const h = harness();
    await h.probeAt(0);
    expect(h.monitor.status().state).toBe("healthy");
    h.set("daemon", DEAD);
    await h.probeAt(2 * MIN);
    expect(h.monitor.status().state).toBe("degraded");
    await h.probeAt(8 * MIN);
    expect(h.monitor.status().state).toBe("degraded");
    // Ten minutes since the last authenticated answer (at 0), not since boot.
    await h.probeAt(10 * MIN);
    expect(h.monitor.status().state).toBe("down");
    expect(h.wakes.map((w) => w.kind)).toEqual([MEMORY_WAKE.down]);
  });

  it("a drain DEFERS memory_down until it lifts", async () => {
    const h = harness({ daemon: DEAD, draining: true });
    await h.probeAt(0);
    await h.probeAt(10 * MIN);
    await h.probeAt(12 * MIN);
    expect(h.monitor.status().state).toBe("down");
    expect(h.wakes).toEqual([]);
    h.drain(false);
    await h.probeAt(14 * MIN);
    expect(h.wakes.map((w) => w.kind)).toEqual([MEMORY_WAKE.down]);
  });
});

describe("memory health — incidents survive a restart, recovery closes them", () => {
  it("a restart inside an incident keeps its START (one tracker ticket per incident)", async () => {
    const stored = { kind: "auth_failed" as const, since: "2026-10-06T09:00:00.000Z" };
    const h = harness({ daemon: AUTH, stored });
    // Before any measurement the persisted incident is still shown.
    expect(h.monitor.status().incident).toEqual(stored);
    await h.probeAt(0);
    expect(h.monitor.status().incident).toEqual(stored);
    expect(h.stored()).toEqual(stored);
  });

  it("a restart that finds memory healthy closes the persisted incident", async () => {
    const h = harness({ stored: { kind: "down", since: "2026-10-06T09:00:00.000Z" } });
    await h.probeAt(0);
    expect(h.monitor.status().incident).toBeNull();
    expect(h.saved).toEqual([null]);
  });

  it("a restart inside a DOWN outage keeps its start through the boot grace and the degraded window", async () => {
    // The usual outage — the server down or unreachable — across a daemon
    // restart (a deploy sync, a crash loop). `degraded` at 6–8 min carries NO
    // authenticated answer, so it decides nothing: the incident is the same
    // one at 10 min, never a new start (a new start = a second ticket, and a
    // daemon restarted often enough would never reach the ticket age at all).
    const stored = { kind: "down" as const, since: "2026-10-06T09:00:00.000Z" };
    const h = harness({ daemon: DEAD, sessions: DEAD, stored });
    for (const m of [0, 2, 4, 6, 8, 10, 12]) {
      await h.probeAt(m * MIN);
      expect(h.monitor.status().incident).toEqual(stored);
    }
    expect(h.monitor.status().state).toBe("down");
    expect(h.saved).not.toContain(null);
    expect(h.stored()).toEqual(stored);
  });

  it("a restart inside an AUTH outage whose first answer is late keeps its start too", async () => {
    // The server warms past the boot grace (a boot re-embed), then refuses.
    const stored = { kind: "auth_failed" as const, since: "2026-10-06T09:00:00.000Z" };
    const h = harness({ daemon: DEAD, sessions: DEAD, stored });
    for (const m of [0, 2, 4, 6]) await h.probeAt(m * MIN);
    expect(h.monitor.status().state).toBe("degraded");
    expect(h.monitor.status().incident).toEqual(stored);
    h.set("daemon", AUTH);
    await h.probeAt(7 * MIN);
    expect(h.monitor.status().state).toBe("auth_failed");
    expect(h.monitor.status().incident).toEqual(stored);
    expect(h.saved).not.toContain(null);
  });

  it("degraded closes an incident only once memory has ANSWERED since it began", async () => {
    // Live: down at 10 min, then one good probe — but the request window is
    // full of failures, so the state is `degraded`. An authenticated answer
    // since the incident began IS a measured recovery: the outage is over.
    const h = harness({ daemon: DEAD });
    await h.probeAt(0);
    await h.probeAt(10 * MIN);
    expect(h.monitor.status().incident).not.toBeNull();
    for (let i = 0; i < 4; i++)
      h.monitor.recordRequest({
        op: "read",
        outcome: "failed",
        status: 0,
        code: "transport",
        ms: 1,
      });
    h.set("daemon", OK);
    await h.probeAt(11 * MIN);
    expect(h.monitor.status().state).toBe("degraded");
    expect(h.monitor.status().incident).toBeNull();
    expect(h.saved.at(-1)).toBeNull();
  });

  it("an incident whose kind changes keeps its start", async () => {
    const h = harness({ daemon: DEAD });
    await h.probeAt(0);
    await h.probeAt(10 * MIN);
    const since = h.monitor.status().incident!.since;
    h.set("daemon", AUTH);
    await h.probeAt(12 * MIN);
    expect(h.monitor.status().incident).toEqual({ kind: "auth_failed", since });
  });
});

describe("memory health — the daemon's own requests and round seeds", () => {
  it("counts requests per operation, and gaps per op:code", async () => {
    const h = harness();
    await h.probeAt(0);
    h.monitor.recordRequest({ op: "read", outcome: "ok", status: 200, code: "", ms: 3 });
    h.monitor.recordRequest({ op: "read", outcome: "failed", status: 0, code: "transport", ms: 3 });
    h.monitor.recordRequest({
      op: "batch_write",
      outcome: "conflict",
      status: 409,
      code: "CONFLICT",
      ms: 3,
    });
    h.monitor.recordRoundSeed({ degraded: true, ms: 3000, reasons: ["head: timeout"] });
    expect(h.monitor.recordGap({ op: "read", code: "transport" })).toBe(1);
    expect(h.monitor.recordGap({ op: "read", code: "transport" })).toBe(2);
    const s = h.monitor.status();
    expect(s.requests["read"]).toEqual({
      total: 2,
      ok: 1,
      absent: 0,
      conflict: 0,
      auth_failed: 0,
      failed: 1,
    });
    expect(s.requests["batch_write"]).toEqual({
      total: 1,
      ok: 0,
      absent: 0,
      conflict: 1,
      auth_failed: 0,
      failed: 0,
    });
    expect(s.requests["round_seed"]).toMatchObject({ total: 1, failed: 1 });
    expect(s.requests["probe"]).toMatchObject({ total: 2, ok: 2 });
    expect(s.gaps).toEqual({ "read:transport": 2 });
    expect(s.last_error).toMatchObject({ op: "round_seed", message: "head: timeout" });
  });

  it("the degraded window needs ≥3 failures AND at least half — both boundaries", async () => {
    const fail = { op: "read", outcome: "failed" as const, status: 503, code: "http_503", ms: 1 };
    const ok = { op: "read", outcome: "ok" as const, status: 200, code: "", ms: 1 };
    // Two failures and nothing else: under the minimum of three.
    const two = harness();
    await two.probeAt(0);
    two.monitor.recordRoundSeed({ degraded: true, ms: 3000 });
    two.monitor.recordRoundSeed({ degraded: true, ms: 3000 });
    expect(two.monitor.status().state).toBe("healthy");
    // Three failures among four successes: fewer than half.
    const h = harness();
    await h.probeAt(0);
    for (let i = 0; i < 4; i++) h.monitor.recordRequest(ok);
    for (let i = 0; i < 3; i++) h.monitor.recordRequest(fail);
    expect(h.monitor.status().state).toBe("healthy");
    // One more failure: 4 of 8 — at least half, and at least three.
    h.monitor.recordRequest(fail);
    expect(h.monitor.status().state).toBe("degraded");
    expect(h.wakes).toEqual([]);
  });

  it("a NOT_FOUND answer is an authenticated answer — never a failure, never last_error", async () => {
    const h = harness();
    await h.probeAt(0);
    const before = h.monitor.status().last_error;
    for (let i = 0; i < 5; i++)
      h.monitor.recordRequest({
        op: "session_delete",
        outcome: "absent",
        status: 404,
        code: "NOT_FOUND",
        ms: 2,
        message: "no such session",
      });
    const s = h.monitor.status();
    expect(s.state).toBe("healthy");
    expect(s.last_error).toEqual(before);
    expect(s.requests["session_delete"]).toEqual({
      total: 5,
      ok: 0,
      absent: 5,
      conflict: 0,
      auth_failed: 0,
      failed: 0,
    });
  });

  it("a NOT_FOUND proves the daemon key like a success does", async () => {
    const h = harness({ daemon: AUTH });
    await h.probeAt(0);
    h.at(MIN);
    h.monitor.recordRequest({ op: "ls", outcome: "absent", status: 404, code: "NOT_FOUND", ms: 2 });
    expect(h.monitor.status().state).toBe("healthy");
    expect(h.monitor.status().last_ok_at).toBe(new Date(T0 + MIN).toISOString());
  });

  it("too many recent failures read DEGRADED even with a good probe — and recover", async () => {
    const h = harness();
    await h.probeAt(0);
    for (let i = 0; i < 3; i++) h.monitor.recordRoundSeed({ degraded: true, ms: 3000 });
    expect(h.monitor.status().state).toBe("degraded");
    expect(h.wakes).toEqual([]); // degraded is visible, not woken
    // The failures age out of the window.
    await h.probeAt(11 * MIN);
    expect(h.monitor.status().state).toBe("healthy");
  });

  it("a 409 precondition refusal is an answer, not a failure", async () => {
    const h = harness();
    await h.probeAt(0);
    for (let i = 0; i < 5; i++)
      h.monitor.recordRequest({
        op: "batch_write",
        outcome: "conflict",
        status: 409,
        code: "CONFLICT",
        ms: 1,
      });
    expect(h.monitor.status().state).toBe("healthy");
  });

  it("a throwing wake sink or probe never escapes", async () => {
    const monitor = new MemoryHealthMonitor({
      probes: {
        daemon: () => Promise.reject(new Error("boom")),
        sessions: async () => OK,
      },
      wake: () => {
        throw new Error("sink down");
      },
      now: () => new Date(T0 + 10 * MIN),
    });
    await expect(monitor.probeNow()).resolves.toBeUndefined();
    expect(monitor.status().credentials.daemon).toMatchObject({
      result: "unreachable",
      detail: "boom",
    });
  });

  it("the provision summary rides the block", () => {
    const h = harness();
    h.monitor.setProvision({ state: "failed", errors: ["no root key"] });
    expect(h.monitor.status().provision).toEqual({ state: "failed", errors: ["no root key"] });
  });
});

describe("memoryStatusLine — what `qcr status` prints", () => {
  it("names the state, the incident and each credential", async () => {
    const h = harness({ daemon: AUTH });
    await h.probeAt(0);
    const line = memoryStatusLine(h.monitor.status(), new Date(T0 + 125 * MIN));
    expect(line).toMatch(/^memory: AUTH FAILED for 2h05m/);
    expect(line).toContain("incident since 2026-10-06T12:00:00.000Z");
    expect(line).toContain("daemon key auth_failed (401 UNAUTHENTICATED: Invalid API Key)");
    expect(line).toContain("sessions' ovcli.conf ok");
  });

  it("healthy says when it last answered", async () => {
    const h = harness();
    await h.probeAt(0);
    expect(memoryStatusLine(h.monitor.status())).toMatch(
      /^memory: healthy \(last ok 2026-10-06T12:00:00.000Z\)/,
    );
  });
});

// The wake path as wire.ts builds it: monitor → store.logAnomaly → the real
// AnomalyWakePolicy, whose generic dedup holds an identical kind+pr for 10
// minutes. A memory wake is a TRANSITION the monitor already rate-limits, so a
// different transition inside those 10 minutes must still reach the overseer.
describe("memory wakes through the REAL anomaly wake policy", () => {
  function wired(daemon: ProbeAnswer, sessions: ProbeAnswer) {
    let clock = T0;
    const answers: Record<CredentialName, ProbeAnswer> = { daemon, sessions };
    const injected: string[] = [];
    const store = new StateStore(":memory:");
    const policy = new AnomalyWakePolicy({
      injectOverseer: async (m) => {
        injected.push(m);
      },
      now: () => new Date(clock),
    });
    store.setAnomalySink((sig) => policy.onAnomaly(sig));
    const monitor = new MemoryHealthMonitor({
      probes: { daemon: async () => answers.daemon, sessions: async () => answers.sessions },
      wake: (kind, detail, message) => store.logAnomaly(kind, null, null, detail, message),
      now: () => new Date(clock),
    });
    return {
      injected,
      store,
      set: (name: CredentialName, a: ProbeAnswer) => {
        answers[name] = a;
      },
      probeAt: async (ms: number) => {
        clock = T0 + ms;
        await monitor.probeNow();
      },
    };
  }

  it("the daemon key failing, then the sessions' too, 2 minutes later: TWO wakes", async () => {
    const w = wired(AUTH, OK);
    await w.probeAt(0);
    expect(w.injected).toHaveLength(1);
    expect(w.injected[0]).toContain("daemon key");
    // The key-change watcher rewrote ovcli.conf with the same bad key.
    w.set("sessions", AUTH);
    await w.probeAt(2 * MIN);
    expect(w.injected).toHaveLength(2);
    expect(w.injected[1]).toMatch(/sessions' ovcli\.conf[^\n]*auth_failed/);
  });

  it("an identical repeat inside the window (a flapping credential) is still held back", async () => {
    const w = wired(AUTH, OK);
    await w.probeAt(0);
    w.set("daemon", OK);
    await w.probeAt(2 * MIN);
    w.set("daemon", AUTH);
    await w.probeAt(4 * MIN);
    // The monitor raised both transitions (two rows) …
    expect(w.store.anomalies().filter((a) => a.kind === MEMORY_WAKE.auth)).toHaveLength(2);
    // … and the overseer, already told this exact thing 4 minutes ago, once.
    expect(w.injected).toHaveLength(1);
  });
});

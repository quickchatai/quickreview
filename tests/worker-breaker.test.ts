// The worker crash-loop breaker: the store's counters, the TUI alert and
// the worker log rotation. The supervisor's end of it (a fake failing worker, the
// park, the drain, the replay that never re-posts) is in tests/worker-supervisor.test.ts.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateStore, buildStatusSnapshot } from "../src/state.js";
import { maybeWriteWorkerCrashAlerts } from "../src/tui/alerts.js";
import { stripAnsi } from "../src/tui/paint.js";
import { topBar, type BoardView } from "../src/tui/board.js";
import { WorkerBreaker } from "../src/workerbreaker.js";
import { DEFAULT_WORKER_LOG_LIMITS, rotateWorkerLogs, workerLogPath } from "../src/workerlog.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wb-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const upsert = (store: StateStore, n: number): void =>
  store.upsertPr({
    number: n,
    state: "queued",
    head_sha: "h",
    title: `PR ${n}`,
    author: "a",
    trigger_ts: null,
    trigger_provenance: "system",
    stale_recheck: 0,
    migration_gate: 0,
  });

describe("the breaker over the store", () => {
  it("parks at the second consecutive failure and reports `newlyParked` once", () => {
    const store = new StateStore(":memory:");
    const b = new WorkerBreaker(store);
    expect(b.failure(1, "c1", "boom").newlyParked).toBe(false);
    const second = b.failure(1, "c2", "boom\n  again");
    expect(second).toMatchObject({ parked: true, newlyParked: true, failures: 2 });
    expect(b.failure(1, "c3", "boom").newlyParked).toBe(false);
    expect(store.workerBreaker(1)?.last_error).toBe("boom");
    expect(b.gate(1)).toMatchObject({ ok: false, why: "parked" });
    expect(store.anomalies().filter((a) => a.kind === "worker_crash_loop")).toHaveLength(1);
  });

  it("a success on a PR resets only its own count; a parked PR stays parked", () => {
    const store = new StateStore(":memory:");
    const b = new WorkerBreaker(store);
    b.failure(1, "c", "x");
    b.failure(2, "c", "x");
    b.success(1);
    expect(store.workerBreaker(1)?.failures).toBe(0);
    expect(store.workerBreaker(2)?.failures).toBe(1);
    b.failure(2, "c", "x");
    expect(store.isWorkerParked(2)).toBe(true);
    b.success(2);
    expect(store.isWorkerParked(2)).toBe(true);
  });

  it("drains on the third PR, with the reason, and not on three failures of one PR", () => {
    const store = new StateStore(":memory:");
    const b = new WorkerBreaker(store);
    for (let i = 0; i < 5; i++) b.failure(1, `c${i}`, "x");
    expect(store.drainState().draining).toBe(false);
    b.failure(2, "c", "x");
    expect(store.drainState().draining).toBe(false);
    expect(b.failure(3, "c", "x").drained).toBe(true);
    expect(store.drainState()).toMatchObject({
      draining: true,
      reason: "worker_failures",
      issued_by: "operator",
    });
    // Already draining: a fourth PR does not engage again.
    expect(b.failure(4, "c", "x").drained).toBe(false);
  });

  it("a hand-set drain keeps no reason, and the breaker does not take it over", () => {
    const store = new StateStore(":memory:");
    store.engageDrain({ issuer: "operator", expires_at: null });
    const b = new WorkerBreaker(store);
    for (const pr of [1, 2, 3]) b.failure(pr, "c", "x");
    expect(store.drainState()).toMatchObject({ draining: true, reason: null });
  });
});

describe("the TUI alert", () => {
  const snap = (over: Partial<ReturnType<typeof buildStatusSnapshot>> = {}) => {
    const store = new StateStore(":memory:");
    upsert(store, 9);
    const b = new WorkerBreaker(store);
    b.failure(9, "c1", "the provider refused");
    b.failure(9, "c2", "the provider refused");
    return { ...buildStatusSnapshot(store, true), ...over };
  };

  it("writes one alert per park, once, and nothing from a stale snapshot", () => {
    const alerts = join(dir, "alerts");
    const mem = { written: new Set<string>() };
    const s = snap();
    expect(maybeWriteWorkerCrashAlerts(alerts, s, false, mem)).toEqual([]);
    const names = maybeWriteWorkerCrashAlerts(alerts, s, true, mem);
    expect(names).toHaveLength(1);
    const file = JSON.parse(readFileSync(join(alerts, names[0]!), "utf8"));
    expect(file).toMatchObject({ tier: "alert", cause: "worker-crash-loop", pr: 9 });
    expect(file.body).toContain("the provider refused");
    expect(maybeWriteWorkerCrashAlerts(alerts, s, true, mem)).toEqual([]);
  });

  it("a failed write leaves the park unrecorded, so the next poll retries it", () => {
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "x");
    const mem = { written: new Set<string>() };
    const s = snap();
    expect(() => maybeWriteWorkerCrashAlerts(join(blocker, "alerts"), s, true, mem)).toThrow();
    expect(mem.written.size).toBe(0);
    const names = maybeWriteWorkerCrashAlerts(join(dir, "alerts"), s, true, mem);
    expect(names).toHaveLength(1);
  });

  it("writes one alert for the breaker's drain", () => {
    const alerts = join(dir, "alerts");
    const mem = { written: new Set<string>() };
    const s = snap({
      draining: true,
      draining_reason: "worker_failures",
      draining_since: "2026-10-19T10:00:00Z",
    });
    const names = maybeWriteWorkerCrashAlerts(alerts, s, true, mem);
    expect(
      names.map((n) => JSON.parse(readFileSync(join(alerts, n), "utf8")).cause).sort(),
    ).toEqual(["worker-crash-loop", "worker-failures-drain"]);
  });

  it("the board shows the drain's cause", () => {
    const store = new StateStore(":memory:");
    store.engageDrain({ issuer: "operator", expires_at: null }, "worker_failures");
    const view: BoardView = {
      health: { kind: "ok", heartbeatAgeS: 5 },
      dryRun: false,
      snapshot: buildStatusSnapshot(store, true),
      events: [],
      selected: 0,
      eventsFocus: false,
      eventsScroll: 0,
      help: false,
    };
    expect(stripAnsi(topBar(view, 200))).toContain("workers keep failing");
  });
});

describe("worker log rotation", () => {
  const put = (name: string, bytes: number, ageMs = 0): void => {
    const f = join(dir, name);
    writeFileSync(f, "x".repeat(bytes));
    const t = (Date.now() - ageMs) / 1000;
    utimesSync(f, t, t);
  };

  it("moves a log over the limit to .1, keeps the configured generations, and starts afresh", () => {
    const limits = { ...DEFAULT_WORKER_LOG_LIMITS, maxBytes: 100, keepRotated: 2 };
    put("c1.log", 150);
    rotateWorkerLogs(dir, "c1", Date.now(), limits);
    expect(existsSync(join(dir, "c1.log"))).toBe(false);
    expect(readFileSync(join(dir, "c1.log.1"), "utf8")).toHaveLength(150);
    writeFileSync(workerLogPath(dir, "c1"), "y".repeat(200));
    rotateWorkerLogs(dir, "c1", Date.now(), limits);
    writeFileSync(workerLogPath(dir, "c1"), "z".repeat(300));
    rotateWorkerLogs(dir, "c1", Date.now(), limits);
    expect(readdirSync(dir).sort()).toEqual(["c1.log.1", "c1.log.2"]);
    expect(readFileSync(join(dir, "c1.log.1"), "utf8")).toHaveLength(300);
    expect(readFileSync(join(dir, "c1.log.2"), "utf8")).toHaveLength(200);
  });

  it("leaves a small log alone and prunes other commands' logs by age and by count", () => {
    const limits = { ...DEFAULT_WORKER_LOG_LIMITS, maxFiles: 3, maxAgeMs: 10_000 };
    put("mine.log", 10);
    put("old.log", 10, 60_000);
    put("a.log", 10, 1000);
    put("b.log", 10, 2000);
    put("c.log", 10, 3000);
    rotateWorkerLogs(dir, "mine", Date.now(), limits);
    // old: by age. Of the rest, the newest 3 files stay (mine, a, b); c is past the count.
    expect(readdirSync(dir).sort()).toEqual(["a.log", "b.log", "mine.log"]);
  });

  it("never throws, even for a directory that is not there", () => {
    expect(() => rotateWorkerLogs(join(dir, "nope"), "c", Date.now())).not.toThrow();
    mkdirSync(join(dir, "empty"));
  });
});

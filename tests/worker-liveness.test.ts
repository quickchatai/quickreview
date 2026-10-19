// [P8.8] Worker liveness: what the archiver, the startup orphan sweep and
// operator recovery ask instead of tmux. A fake /proc stands in for the machine,
// so "the pid was reused" and "another container" are cases, not hopes.
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prEligibility } from "../src/archive/eligibility.js";
import { reconcileOrphanedRounds } from "../src/reconcile.js";
import { StateStore } from "../src/state.js";
import { createWorkerLiveness, inFlightPrs } from "../src/workerliveness.js";
import { WorkerLeases, leaseDirOf, type ProcView, type WorkerLease } from "../src/workerlease.js";

const BOOT = "boot-1/box-a";
const T0 = "2026-10-19T08:00:00.000Z";
const HEAD = "a".repeat(40);

let dir: string;
let store: StateStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-worker-liveness-"));
  store = new StateStore(":memory:", () => new Date(T0));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function machine(procs: Record<number, { start: string; pgid: number }>, boot = BOOT): ProcView {
  const table = new Map(Object.entries(procs).map(([pid, p]) => [Number(pid), p]));
  return {
    identity: (pid) => table.get(pid),
    members: (pgid) =>
      [...table].filter(([, p]) => p.pgid === pgid).map(([pid, p]) => ({ pid, start: p.start })),
    bootId: () => boot,
  };
}

function lease(pr: number, over: Partial<WorkerLease> = {}): WorkerLease {
  return {
    v: 1,
    owner_token: `tok-${pr}`,
    command_id: `c${pr}`,
    session: `pr-${pr}`,
    pr,
    generation: 1,
    pid: 100 + pr,
    pgid: 100 + pr,
    start_time: "1000",
    boot_id: BOOT,
    command: "botworker",
    created_at: T0,
    ...over,
  };
}

function leases(...ls: WorkerLease[]): WorkerLeases {
  const l = new WorkerLeases(leaseDirOf(dir));
  for (const x of ls) l.create(x);
  return l;
}

function track(pr: number, state: "reviewing" | "closed" | "tracked" = "reviewing"): void {
  store.upsertPr({
    number: pr,
    state,
    head_sha: HEAD,
    title: `PR ${pr}`,
    author: "alice",
    trigger_ts: null,
    stale_recheck: 0,
    migration_gate: 0,
  });
}

function roundCommand(pr: number, id = `cmd-${pr}`): void {
  const payload = "round order\n";
  const payloadPath = join(dir, `${id}.payload.md`);
  const injectPath = join(dir, `${id}.inject.md`);
  writeFileSync(payloadPath, payload);
  writeFileSync(injectPath, payload);
  store.createSessionCommand({
    id,
    pr,
    session: `pr-${pr}`,
    kind: "round",
    round_no: 1,
    payload_sha256: createHash("sha256").update(payload).digest("hex"),
    payload_path: payloadPath,
    inject_path: injectPath,
    next_check_at: T0,
  });
}

describe("[P8.8] createWorkerLiveness", () => {
  it("a lease whose leader the process table confirms is a running worker", () => {
    leases(lease(7));
    const live = createWorkerLiveness({
      runDir: dir,
      proc: machine({ 107: { start: "1000", pgid: 107 } }),
    });
    expect(live.liveSessions()).toEqual(["pr-7"]);
    expect(live.runs(7)).toBe(true);
    expect(live.runs(8)).toBe(false);
  });

  it("a lease is no proof: a reused pid, another container, a dead leader hold nothing", () => {
    leases(lease(1), lease(2), lease(3), lease(4, { boot_id: "boot-1/box-b" }));
    const live = createWorkerLiveness({
      runDir: dir,
      proc: machine({
        101: { start: "9999", pgid: 101 }, // the pid now belongs to another process
        102: { start: "1000", pgid: 102 }, // ours
        104: { start: "1000", pgid: 104 }, // right process, but the lease is from another box
      }),
    });
    expect(live.liveSessions()).toEqual(["pr-2"]);
  });

  it("a worker whose leader died but whose tools still run still holds the PR", () => {
    leases(lease(5));
    const live = createWorkerLiveness({
      runDir: dir,
      proc: machine({ 900: { start: "1500", pgid: 105 } }),
    });
    expect(live.runs(5)).toBe(true);
  });

  it("a lease taken before the process exists counts: the worker is on its way", () => {
    leases(lease(6, { pid: null, pgid: null, start_time: null }));
    expect(createWorkerLiveness({ runDir: dir, proc: machine({}) }).runs(6)).toBe(true);
  });

  it("a file that is not a lease counts as a live worker until the boot removes it", () => {
    leases();
    writeFileSync(join(leaseDirOf(dir), "pr-9.lease.json"), "{ not json");
    expect(createWorkerLiveness({ runDir: dir, proc: machine({}) }).liveSessions()).toEqual([
      "pr-9",
    ]);
  });

  it("no lease directory is an answer (nothing ever ran) and is not created by a read", () => {
    const live = createWorkerLiveness({ runDir: dir, proc: machine({}) });
    expect(live.liveSessions()).toEqual([]);
    expect(live.runs(1)).toBe(false);
    expect(existsSync(leaseDirOf(dir))).toBe(false);
  });

  it("a lease directory that cannot be listed is UNKNOWN, never none", () => {
    writeFileSync(leaseDirOf(dir), ""); // a file where the directory should be
    const live = createWorkerLiveness({ runDir: dir, proc: machine({}) });
    expect(live.liveSessions()).toBeNull();
    expect(live.runs(1)).toBeNull();
  });
});

describe("[P8.8] the archiver reads it: a worker holds its closed PR, an idle one is eligible", () => {
  function closed(pr: number): void {
    track(pr, "closed");
    store.logEvent("pr_closed", pr, { merged: true });
  }
  const NOW = new Date("2026-11-30T08:00:00.000Z");

  it("worker_alive holds the PR until the worker is gone", () => {
    closed(11);
    const outside = (workerAlive: boolean | null) => ({
      workerAlive,
      birthInFlight: false,
      injectFiles: [] as string[],
    });
    const at = (workerAlive: boolean | null) =>
      prEligibility(store, 11, { now: NOW, afterDays: 14, outside: outside(workerAlive) });
    expect(at(true)).toMatchObject({ eligible: false, reason: "worker_alive" });
    expect(at(null)).toMatchObject({ eligible: false, reason: "worker_unknown" });
    expect(at(false).reasons).not.toContain("worker_alive");
  });
});

describe("[P8.8] the startup orphan sweep reads leases and the one-active index", () => {
  it("keeps a round a worker still runs, and cancels one nothing runs", () => {
    for (const pr of [20, 21]) {
      track(pr);
      store.startRound(pr, "first", ["pass-baseline"], 75);
    }
    leases(lease(20));
    const live = createWorkerLiveness({
      runDir: dir,
      proc: machine({ 120: { start: "1000", pgid: 120 } }),
    });

    const res = reconcileOrphanedRounds(store, inFlightPrs(store, live), {});

    expect(res.cancelled).toEqual([21]);
    expect(res.requeued).toEqual([21]);
    expect(store.roundStatus(20, 1)).toBe("running");
  });

  it("keeps a round whose command still waits for the next worker (a restart requeued it)", () => {
    track(30);
    store.startRound(30, "first", ["pass-baseline"], 75);
    roundCommand(30);
    const live = createWorkerLiveness({ runDir: dir, proc: machine({}) });

    expect(inFlightPrs(store, live)).toEqual([30]);
    expect(reconcileOrphanedRounds(store, inFlightPrs(store, live), {}).cancelled).toEqual([]);
    expect(store.roundStatus(30, 1)).toBe("running");
  });

  it("leaves every running round alone when the leases cannot be read", () => {
    track(40);
    store.startRound(40, "first", ["pass-baseline"], 75);
    writeFileSync(leaseDirOf(dir), "");
    const live = createWorkerLiveness({ runDir: dir, proc: machine({}) });
    expect(inFlightPrs(store, live)).toEqual([40]);
  });
});

describe("[P8.8] a boot with a legacy-shaped state: no tmux, no lease, every PR idle", () => {
  it("finds no worker for any open PR, sweeps only the rounds that lost theirs, and archives the closed", async () => {
    // The state a pre-cutover host leaves: open PRs in every state, a round that
    // was running under tmux, a closed PR, no lease directory, no tmux anywhere.
    track(50, "tracked");
    track(51, "reviewing");
    track(52, "queued" as never);
    track(53, "closed");
    store.logEvent("pr_closed", 53, { merged: true });
    store.startRound(51, "first", ["pass-baseline"], 75);

    const live = createWorkerLiveness({ runDir: dir, proc: machine({}) });

    expect(live.liveSessions()).toEqual([]);
    for (const pr of [50, 51, 52, 53]) expect(live.runs(pr)).toBe(false);
    expect(inFlightPrs(store, live)).toEqual([]);

    // Every open PR is idle with its JSONL: the one running round has no
    // session, so it is requeued; nothing else is touched.
    const swept = reconcileOrphanedRounds(store, inFlightPrs(store, live), {});
    expect(swept.cancelled).toEqual([51]);
    expect(swept.requeued).toEqual([51]);
    expect(store.getPr(51)!.state).toBe("queued");
    for (const pr of [50, 52]) expect(store.getPr(pr)!.state).not.toBe("closed");

    // The archiver's view: the closed PR is not held by a worker.
    const e = prEligibility(store, 53, {
      now: new Date("2026-11-30T00:00:00.000Z"),
      afterDays: 14,
      outside: {
        workerAlive: live.runs(53),
        birthInFlight: false,
        injectFiles: [],
      },
    });
    expect(e.eligible).toBe(true);
  });
});

// The archiver's runtime (docs/archiving.md §10) with a fake
// clock and a fake schedule: never before the first healthy reconcile plus
// the start delay; held — with no inventory work at all — while draining,
// stalled, CPU-starved or short of disk (or not knowing the disk); mode off
// arms no timer; stop() prevents a re-arm; ticks coalesce and the mutex is
// strict. Plus the fences: daemon bookkeeping only (rule 9), no memory.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  Archiver,
  PLAN_REFRESH_MS,
  StrictMutex,
  archivePolicy,
  freeBytes,
  loadHold,
  type ArchiverDeps,
  type StatfsLike,
} from "../src/archive/archiver.js";
import type { ArchivePlan } from "../src/archive/plan.js";
import { ARCHIVE_DEFAULTS, type ArchiveConfig } from "../src/config.js";
import type { DaemonLoadStatus } from "../src/eventloop.js";
import { StateStore } from "../src/state.js";

const T0 = Date.parse("2026-10-21T12:00:00.000Z");
const MIN = 60_000;
const GB = 1024 ** 3;

/** A minimal plan — the archiver only reads its summary. */
function fakePlan(at: number, prs = 3): ArchivePlan {
  const tally = { files: 0, bytes: 0 };
  return {
    computed_at: new Date(at).toISOString(),
    took_ms: 1,
    after_days: 14,
    events_after_days: 35,
    files_cutoff: new Date(at - 14 * 86_400_000).toISOString(),
    registry: { prs, open: 0, closed: prs, waiting: 0, eligible: prs, held: 0, archived: 0 },
    candidates: [],
    empty: [],
    held: [{ pr: 9, reason: "failure_open", reasons: ["failure_open"] }],
    orphans: ["pr-1"],
    artifacts: {
      transcripts: tally,
      round_prompts: tally,
      session_commands: tally,
      findings: tally,
      posting_receipts: tally,
      round_files: tally,
      session_files: tally,
      inject_done: tally,
      stale_injects: tally,
      verdicts: tally,
      live_logs: tally,
      lens_sessions: tally,
    },
    ledger_snapshots: tally,
    legacy_copies: tally,
    events: { rows: 7, cutoff: "", from_id: 0, examined: 0, windows: 0, by_kind: {} },
    deliveries: { rows: 5, cutoff: "", from_id: 0, examined: 0, windows: 0 },
    backlog: { prs, bytes: 1234, event_rows: 7, delivery_rows: 5 },
    births_observed: true,
    workers: "answered",
    same_device: true,
    max_sync_span_ms: 4.2,
  };
}

/** A daemon load reading. */
function load(
  state: "unknown" | "ok" | "stalled",
  cpu: { ratio: number } | "unknown",
): DaemonLoadStatus {
  return {
    event_loop: { state } as DaemonLoadStatus["event_loop"],
    cpu:
      cpu === "unknown"
        ? { state: "unknown", source: "/sys/fs/cgroup/cpu.stat", reason: "no reading", at: null }
        : {
            state: "measured",
            source: "/sys/fs/cgroup/cpu.stat",
            at: new Date(T0).toISOString(),
            window_s: 300,
            periods: 3000,
            throttled_periods: Math.round(3000 * cpu.ratio),
            throttled_ratio: cpu.ratio,
            throttled_s: 1,
            usage_s: 1,
          },
  };
}

interface Rig {
  archiver: Archiver;
  store: StateStore;
  clock: { ms: number };
  healthy: { at: Date | null };
  plans: number;
  statfsCalls: string[];
  scheduled: Array<{ fn: () => void; ms: number; cancelled: boolean }>;
  /** Run the newest armed, uncancelled timer. */
  fire: () => void;
  set: (o: { load?: DaemonLoadStatus; statfs?: (p: string) => Promise<StatfsLike> }) => void;
}

function rig(cfg: Partial<ArchiveConfig> = {}, extra: Partial<ArchiverDeps> = {}): Rig {
  const store = new StateStore(":memory:");
  const clock = { ms: T0 };
  const healthy: { at: Date | null } = { at: null };
  const scheduled: Rig["scheduled"] = [];
  let loadNow: DaemonLoadStatus | undefined = load("ok", { ratio: 0 });
  let statfs: (p: string) => Promise<StatfsLike> = async () => ({ bavail: 10 * GB, bsize: 1 });
  const r = {
    store,
    clock,
    healthy,
    plans: 0,
    statfsCalls: [] as string[],
    scheduled,
  } as Partial<Rig> & { plans: number; statfsCalls: string[] };
  const archiver = new Archiver({
    store,
    cfg: { ...ARCHIVE_DEFAULTS, ...cfg },
    root: "/sandbox",
    sessionsRoot: "/sandbox/state/pi-sessions",
    firstHealthyReconcileAt: () => healthy.at,
    load: () => loadNow,
    starvedRatio: 0.2,
    statfs: (p) => {
      r.statfsCalls.push(p);
      return statfs(p);
    },
    plan: async () => {
      r.plans += 1;
      return fakePlan(clock.ms);
    },
    // The worker-log sweep does real directory IO; this file's clocks are fake.
    sweepLive: async (o) => ({
      at: o.now.toISOString(),
      bytes: 0,
      files: 0,
      bytes_after: 0,
      removed_files: 0,
      removed_bytes: 0,
      unarchived_files: 0,
      unarchived_bytes: 0,
      manifest_unreadable: [],
    }),
    now: () => new Date(clock.ms),
    schedule: (fn, ms) => {
      const entry = { fn, ms, cancelled: false };
      scheduled.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    ...extra,
  });
  return Object.assign(r, {
    archiver,
    fire: () => {
      const next = [...scheduled].reverse().find((s) => !s.cancelled);
      if (!next) throw new Error("no timer armed");
      next.cancelled = true;
      next.fn();
    },
    set: (o: { load?: DaemonLoadStatus; statfs?: (p: string) => Promise<StatfsLike> }) => {
      if ("load" in o) loadNow = o.load;
      if (o.statfs) statfs = o.statfs;
    },
  }) as Rig;
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

describe("start: never before the first healthy reconcile plus start_delay_min", () => {
  it("no plan before the reconcile, none inside the delay, the first at reconcile + delay", async () => {
    const h = rig({ start_delay_min: 10 });
    h.archiver.start();
    expect(h.scheduled).toHaveLength(1);
    expect(h.scheduled[0]!.ms).toBe(60_000);

    h.fire();
    await settle();
    expect(h.plans).toBe(0);
    expect(h.archiver.status()).toMatchObject({ state: "held", held_reason: "awaiting_reconcile" });
    // Re-armed after the tick.
    expect(h.scheduled.filter((s) => !s.cancelled)).toHaveLength(1);

    h.healthy.at = new Date(h.clock.ms);
    h.clock.ms += 9 * MIN + 59_000;
    h.fire();
    await settle();
    expect(h.plans).toBe(0);
    expect(h.archiver.status()).toMatchObject({
      state: "held",
      held_reason: "start_delay",
      held_until: new Date(h.healthy.at.getTime() + 10 * MIN).toISOString(),
    });
    expect(h.archiver.status().backlog).toBeNull();

    h.clock.ms = h.healthy.at.getTime() + 10 * MIN;
    h.fire();
    await settle();
    expect(h.plans).toBe(1);
    expect(h.archiver.status()).toMatchObject({
      state: "plan",
      held_reason: null,
      held_until: null,
    });
    h.archiver.stop();
    h.store.close();
  });

  it("start_delay_min = 0 plans on the first tick after a healthy reconcile", async () => {
    const h = rig({ start_delay_min: 0 });
    h.healthy.at = new Date(T0);
    expect((await h.archiver.tick()).planned).toBe(true);
    h.store.close();
  });
});

describe("holds: nothing started, no inventory work", () => {
  const open = (h: Rig): void => {
    h.healthy.at = new Date(T0 - 60 * MIN);
  };

  it("draining ⇒ held/draining, no plan and not even a statfs", async () => {
    const h = rig();
    open(h);
    h.store.engageDrain({ issuer: "operator", expires_at: null });
    expect(await h.archiver.tick()).toEqual({
      state: "held",
      held_reason: "draining",
      planned: false,
    });
    expect(h.plans).toBe(0);
    expect(h.statfsCalls).toEqual([]);
    expect(h.archiver.status()).toMatchObject({
      state: "held",
      held_reason: "draining",
      backlog: null,
    });
    // The drain lifts: the next tick plans.
    h.store.liftDrain("operator");
    expect((await h.archiver.tick()).planned).toBe(true);
    h.store.close();
  });

  it("a stalled event-loop reading ⇒ held/loop_stalled", async () => {
    const h = rig();
    open(h);
    h.set({ load: load("stalled", { ratio: 0 }) });
    expect(await h.archiver.tick()).toMatchObject({ state: "held", held_reason: "loop_stalled" });
    expect(h.plans).toBe(0);
    expect(h.statfsCalls).toEqual([]);
    h.store.close();
  });

  it("CPU starvation (throttled ≥ the starved ratio) ⇒ held/cpu_starved", async () => {
    const h = rig();
    open(h);
    h.set({ load: load("ok", { ratio: 0.2 }) });
    expect(await h.archiver.tick()).toMatchObject({ state: "held", held_reason: "cpu_starved" });
    h.set({ load: load("ok", { ratio: 0.19 }) });
    expect((await h.archiver.tick()).planned).toBe(true);
    h.store.close();
  });

  it("an UNKNOWN load reading is not a hold", async () => {
    const h = rig();
    open(h);
    h.set({ load: load("unknown", "unknown") });
    expect((await h.archiver.tick()).planned).toBe(true);
    h.set({ load: undefined });
    expect(loadHold({ draining: false, load: undefined, starvedRatio: 0.2 })).toBeNull();
    h.store.close();
  });

  it("free space below the headroom on EITHER mount ⇒ held/disk_low, with the reading", async () => {
    const h = rig({ disk_headroom_gb: 2 });
    open(h);
    h.set({
      statfs: async (p) => ({ bavail: p.endsWith("/state") ? 1 * GB : 50 * GB, bsize: 1 }),
    });
    expect(await h.archiver.tick()).toMatchObject({ state: "held", held_reason: "disk_low" });
    expect(h.plans).toBe(0);
    expect(h.archiver.status().disk).toEqual({
      archive_free: 50 * GB,
      state_free: 1 * GB,
      headroom: 2 * GB,
    });
    expect(h.statfsCalls.sort()).toEqual(["/sandbox/archive", "/sandbox/state"]);
    h.store.close();
  });

  it("…and the mirror: a low ARCHIVE mount with a roomy state mount holds too", async () => {
    const h = rig({ disk_headroom_gb: 2 });
    open(h);
    h.set({
      statfs: async (p) => ({ bavail: p.endsWith("/archive") ? 1 * GB : 50 * GB, bsize: 1 }),
    });
    expect(await h.archiver.tick()).toMatchObject({ state: "held", held_reason: "disk_low" });
    expect(h.plans).toBe(0);
    expect(h.archiver.status().disk).toEqual({
      archive_free: 1 * GB,
      state_free: 50 * GB,
      headroom: 2 * GB,
    });
    h.store.close();
  });

  it("both mounts at exactly the headroom plan — the hold is strictly below it", async () => {
    const h = rig({ disk_headroom_gb: 2 });
    open(h);
    h.set({ statfs: async () => ({ bavail: 2 * GB, bsize: 1 }) });
    expect(await h.archiver.tick()).toMatchObject({ state: "plan", planned: true });
    expect(h.plans).toBe(1);
    h.store.close();
  });

  it("a failed statfs ⇒ held/disk_unknown, the disk null — never a guess", async () => {
    const h = rig();
    open(h);
    h.set({
      statfs: async () => {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      },
    });
    expect(await h.archiver.tick()).toMatchObject({ state: "held", held_reason: "disk_unknown" });
    expect(h.archiver.status().disk).toBeNull();
    expect(h.plans).toBe(0);
    h.store.close();
  });

  it("a mount dir not created yet is measured on its nearest existing ancestor", async () => {
    const asked: string[] = [];
    const free = await freeBytes("/sandbox/archive", async (p) => {
      asked.push(p);
      if (p === "/sandbox/archive") throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return { bavail: 7n, bsize: 4096n };
    });
    expect(asked).toEqual(["/sandbox/archive", "/sandbox"]);
    expect(free).toBe(7 * 4096);
  });
});

describe("mode, stop, coalescing, the mutex", () => {
  it('mode "off" arms no timer, plans nothing, and says off', async () => {
    const h = rig({ mode: "off" });
    h.healthy.at = new Date(T0 - 60 * MIN);
    h.archiver.start();
    expect(h.scheduled).toEqual([]);
    expect(h.archiver.status()).toMatchObject({ mode: "off", state: "off", backlog: null });
    expect(await h.archiver.tick()).toMatchObject({ state: "off", planned: false });
    expect(h.plans).toBe(0);
    h.store.close();
  });

  it("stop() during a tick prevents the re-arm", async () => {
    let finish!: () => void;
    const h = rig(
      {},
      {
        plan: () =>
          new Promise<ArchivePlan>((resolve) => {
            finish = () => resolve(fakePlan(T0));
          }),
      },
    );
    h.healthy.at = new Date(T0 - 60 * MIN);
    h.archiver.start();
    h.fire();
    await settle();
    expect(h.archiver.status().state).toBe("running");
    h.archiver.stop();
    finish();
    await settle();
    expect(h.scheduled.filter((s) => !s.cancelled)).toEqual([]);
    // start() after stop() does nothing either.
    h.archiver.start();
    expect(h.scheduled.filter((s) => !s.cancelled)).toEqual([]);
    h.store.close();
  });

  it("stop() cuts a plan in flight through its signal, and that is not a failure", async () => {
    let seen: AbortSignal | null = null;
    const h = rig(
      {},
      {
        plan: ({ signal }) =>
          new Promise<ArchivePlan>((_resolve, reject) => {
            seen = signal;
            signal.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      },
    );
    h.healthy.at = new Date(T0 - 60 * MIN);
    const tick = h.archiver.tick();
    await settle();
    h.archiver.stop();
    expect(seen!.aborted).toBe(true);
    expect((await tick).state).toBe("unknown");
    expect(h.archiver.status().last_error).toBeNull();
    h.store.close();
  });

  it("a tick called while one runs joins it — one plan", async () => {
    const h = rig();
    h.healthy.at = new Date(T0 - 60 * MIN);
    const a = h.archiver.tick();
    const b = h.archiver.tick();
    expect(a).toBe(b);
    await Promise.all([a, b]);
    expect(h.plans).toBe(1);
    h.store.close();
  });

  it("the plan is recomputed at most every PLAN_REFRESH_MS", async () => {
    const h = rig();
    h.healthy.at = new Date(T0 - 60 * MIN);
    expect((await h.archiver.tick()).planned).toBe(true);
    h.clock.ms += PLAN_REFRESH_MS - 1;
    expect((await h.archiver.tick()).planned).toBe(false);
    expect(h.archiver.status().state).toBe("plan");
    h.clock.ms += 1;
    expect((await h.archiver.tick()).planned).toBe(true);
    expect(h.plans).toBe(2);
    h.store.close();
  });

  it("a failing plan is state failed with the error — and the backlog stays null, never 0", async () => {
    const h = rig(
      {},
      {
        plan: async () => {
          throw new Error("EACCES: state/findings");
        },
      },
    );
    h.healthy.at = new Date(T0 - 60 * MIN);
    expect((await h.archiver.tick()).state).toBe("failed");
    expect(h.archiver.status()).toMatchObject({
      state: "failed",
      last_error: "EACCES: state/findings",
      backlog: null,
      held_prs: null,
      orphans: null,
    });
    h.store.close();
  });

  it("the strict mutex runs holders one at a time, in arrival order", async () => {
    const m = new StrictMutex();
    const order: string[] = [];
    const first = await m.acquire();
    expect(m.held()).toBe(true);
    const second = m.acquire().then((release) => {
      order.push("second");
      return release;
    });
    await settle();
    expect(order).toEqual([]);
    order.push("first-released");
    first();
    first(); // idempotent
    const r2 = await second;
    expect(order).toEqual(["first-released", "second"]);
    r2();
    expect(m.held()).toBe(false);
  });

  it("the default schedule arms one real timer, and stop() clears it", () => {
    vi.useFakeTimers();
    try {
      const store = new StateStore(":memory:");
      const a = new Archiver({
        store,
        cfg: { ...ARCHIVE_DEFAULTS },
        root: "/sandbox",
        sessionsRoot: "/sandbox/state/pi-sessions",
        firstHealthyReconcileAt: () => null,
      });
      a.start();
      expect(vi.getTimerCount()).toBe(1);
      a.stop();
      expect(vi.getTimerCount()).toBe(0);
      store.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the policy reads every [archive] knob", () => {
  it("in the units the archiver works in", () => {
    expect(
      archivePolicy({
        ...ARCHIVE_DEFAULTS,
        interval_s: 30,
        start_delay_min: 5,
        tick_budget_s: 12,
        max_mb_per_s: 2.5,
        disk_headroom_gb: 0.5,
      }),
    ).toEqual({
      mode: "plan",
      afterDays: 14,
      eventsAfterDays: 35,
      intervalMs: 30_000,
      startDelayMs: 5 * MIN,
      tickBudgetMs: 12_000,
      maxPrsPerTick: 5,
      maxBytesPerS: Math.round(2.5 * 1024 * 1024),
      diskHeadroomBytes: 0.5 * GB,
      dbBatchRows: 500,
      gzipLevel: 6,
      liveRetentionMs: 30 * 24 * 60 * MIN,
      liveCapBytes: 20 * GB,
    });
  });
});

describe("fences — daemon bookkeeping only", () => {
  const dir = join(import.meta.dirname, "..", "src", "archive");
  const sources = readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => [f, readFileSync(join(dir, f), "utf8")] as const);

  it("src/archive/ imports nothing from memory/ or openviking/ (the archive is files on disk, not memory)", () => {
    expect(sources.length).toBeGreaterThan(3);
    const offenders = sources
      .filter(([, text]) => /from\s+["'][^"']*\/(memory|openviking)\//.test(text))
      .map(([f]) => f);
    expect(offenders).toEqual([]);
  });

  describe("wire.ts: the archiver is actually connected", () => {
    const wire = readFileSync(join(import.meta.dirname, "..", "src", "wire.ts"), "utf8");
    const daemon = readFileSync(join(import.meta.dirname, "..", "src", "daemon.ts"), "utf8");

    it("built with the daemon's store, its reconcile gate, its load watch, births and the worker leases — then started", () => {
      const built = /archiver = new Archiver\(\{([\s\S]*?)\}\);\s*archiver\.start\(\);/.exec(wire);
      expect(built).not.toBeNull();
      const args = built![1]!;
      expect(args).toMatch(/store: d\.store,/);
      expect(args).toMatch(/cfg: cfg\.archive,/);
      expect(args).toMatch(/firstHealthyReconcileAt: \(\) => d\.firstHealthyReconcileAt\(\),/);
      expect(args).toMatch(/load: \(\) => d\.load\.status\(\),/);
      expect(args).toMatch(/starvedRatio: eventLoopPolicy\(cfg\.daemon\)\.starvedRatio,/);
      // Liveness is the workers' leases, never a tmux listing (which folds
      // every failure into "none alive").
      expect(args).toMatch(/liveSessions: async \(\) => workerLive\.liveSessions\(\),/);
      expect(args).not.toMatch(/tmux/);
      expect(args).toMatch(/birthInFlight: \(pr\) => workerWorld\.host\.birthInFlight\(pr\),/);
      expect(wire.match(/new Archiver\(/g)).toHaveLength(1);
    });

    it("stopped in onStop — which the daemon runs before it closes the store", () => {
      const onStop = /async onStop\(reason = "shutdown"\) \{([\s\S]*?)\n {4}\},/.exec(wire);
      expect(onStop).not.toBeNull();
      expect(onStop![1]).toMatch(/archiver\?\.stop\(\);/);
      const runsOnStop = daemon.indexOf("deps.onStop!(reason)");
      const closesStore = daemon.indexOf("store.close();", runsOnStop);
      expect(runsOnStop).toBeGreaterThan(0);
      expect(closesStore).toBeGreaterThan(runsOnStop);
    });

    it("status.json gets the archiver's cached status — pending (never 0) before it exists", () => {
      expect(wire).toMatch(
        /archiveStatus: \(\) => \(archiver \? archiver\.status\(\) : pendingArchiveStatus\(cfg\.archive\.mode\)\),/,
      );
    });
  });

  it("src/archive/ never spawns pi, injects, wakes or kills a session (root rule 9)", () => {
    const offenders = sources
      .filter(([, text]) =>
        /["'`]pi["'`]\s*,|piBin|--no-session|\.inject\(|killSession|child_process/.test(text),
      )
      .map(([f]) => f);
    expect(offenders).toEqual([]);
  });
});

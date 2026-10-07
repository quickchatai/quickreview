// The closed-PR ARCHIVER (docs/archiving.md §10) — daemon
// bookkeeping on its own timer. It never spawns pi, injects, wakes or kills a
// session, and makes no GitHub call (root rule 9; it is not a session kind).
//
// The shape is the CaseWriter's (src/cases.ts): an injected `schedule` seam
// that re-arms AFTER each tick finishes (unref'd), a coalesced tick (a call
// while one runs joins it) and a `stopped` flag — plus a STRICT mutex, never
// SingleFlight: SingleFlight abandons an overdue pass and starts a second
// beside it, and two archivers on one PR's files is exactly the hazard.
//
//   - Start: never on the boot pass. No tick does any work before the
//     daemon's first HEALTHY reconcile plus `[archive] start_delay_min`.
//   - Holds: nothing is started while draining, while the event loop reads
//     `stalled`, while the container is CPU-starved (throttled in at least
//     `[daemon] event_loop_starved_throttle_ratio` of its periods), or while
//     either mount's free space is below `disk_headroom_gb` — or UNKNOWN (a
//     failed statfs is a hold, never a guess). An unknown load reading is not
//     a hold.
//   - Mode `off` arms no timer at all.
//
// THIS BUILD (S1) MOVES NOTHING in any mode: a tick computes the plan
// (src/archive/plan.ts) — what a pass would move — and reports it through
// status.json `archive`; `on` plans exactly as `plan` does until the movers
// land. A plan tick writes no file, no directory and no row.
import { statfs as fsStatfs } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ArchiveConfig } from "../config.js";
import type { DaemonLoadStatus } from "../eventloop.js";
import { DEFAULT_EVENT_LOOP_STARVED_THROTTLE_RATIO } from "../eventloop.js";
import type { StateStore } from "../state.js";
import { computePlan, type ArchivePlan, type PlanMemo } from "./plan.js";
import {
  pendingArchiveStatus,
  type ArchiveDisk,
  type ArchiveHoldReason,
  type ArchiveState,
  type ArchiveStatus,
  type ArchiveTotals,
} from "./status.js";

const MIN_MS = 60_000;
const GB = 1024 ** 3;

/** A plan is recomputed at most this often — the inventory is a few thousand
 * async stats, and in plan mode nothing changes it but time. */
export const PLAN_REFRESH_MS = 15 * MIN_MS;

/** status()'s database figures (totals, restores, free pages) are re-read at
 * most this often; the heartbeat asks every 30 s. */
export const STATUS_DB_TTL_MS = MIN_MS;

/** Every `[archive]` knob, in the units the archiver works in. */
export interface ArchivePolicy {
  mode: ArchiveConfig["mode"];
  afterDays: number;
  eventsAfterDays: number;
  intervalMs: number;
  startDelayMs: number;
  tickBudgetMs: number;
  maxPrsPerTick: number;
  maxBytesPerS: number;
  diskHeadroomBytes: number;
  dbBatchRows: number;
  gzipLevel: number;
}

export function archivePolicy(c: ArchiveConfig): ArchivePolicy {
  return {
    mode: c.mode,
    afterDays: c.after_days,
    eventsAfterDays: c.events_after_days,
    intervalMs: c.interval_s * 1000,
    startDelayMs: c.start_delay_min * MIN_MS,
    tickBudgetMs: c.tick_budget_s * 1000,
    maxPrsPerTick: c.max_prs_per_tick,
    maxBytesPerS: Math.round(c.max_mb_per_s * 1024 * 1024),
    diskHeadroomBytes: Math.round(c.disk_headroom_gb * GB),
    dbBatchRows: c.db_batch_rows,
    gzipLevel: c.gzip_level,
  };
}

/** A strict mutex: holders run one at a time, in arrival order. */
export class StrictMutex {
  private tail: Promise<void> = Promise.resolve();
  private holders = 0;

  async acquire(): Promise<() => void> {
    let release!: () => void;
    const turn = new Promise<void>((r) => (release = r));
    const prev = this.tail;
    this.tail = prev.then(() => turn);
    await prev;
    this.holders += 1;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.holders -= 1;
      release();
    };
  }

  held(): boolean {
    return this.holders > 0;
  }
}

/** What `statfs` reports that the guard reads. */
export interface StatfsLike {
  bavail: number | bigint;
  bsize: number | bigint;
}

/** Free bytes on the mount `path` is (or will be) on: the nearest existing
 * ancestor answers for a directory not created yet. Throws when statfs fails
 * for any reason but a missing path. */
export async function freeBytes(
  path: string,
  statfs: (p: string) => Promise<StatfsLike>,
): Promise<number> {
  let p = resolve(path);
  for (;;) {
    try {
      const s = await statfs(p);
      return Number(s.bavail) * Number(s.bsize);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      const up = dirname(p);
      if (up === p) throw err;
      p = up;
    }
  }
}

/**
 * The load half of the holds — synchronous, from what the daemon already
 * measured. Draining first, then a stalled loop, then CPU starvation; an
 * unknown reading (no sample yet, no cgroup figures) is NOT a hold.
 */
export function loadHold(input: {
  draining: boolean;
  load: DaemonLoadStatus | undefined;
  starvedRatio: number;
}): ArchiveHoldReason | null {
  if (input.draining) return "draining";
  const l = input.load;
  if (l?.event_loop?.state === "stalled") return "loop_stalled";
  if (l?.cpu?.state === "measured" && l.cpu.throttled_ratio >= input.starvedRatio)
    return "cpu_starved";
  return null;
}

export interface ArchiverDeps {
  store: StateStore;
  cfg: ArchiveConfig;
  /** The sandbox root. */
  root: string;
  /** `<root>/<[pi] session_dir>`. */
  sessionsRoot: string;
  /** When the daemon's first healthy reconcile pass completed; null before. */
  firstHealthyReconcileAt: () => Date | null;
  /** The daemon's own load reading (status.json `daemon`); undefined = not
   * measured. */
  load?: () => DaemonLoadStatus | undefined;
  starvedRatio?: number;
  /** Live tmux session names; null = tmux could not be asked. Default: none
   * answer — every candidate holds `tmux_unknown`. */
  liveSessions?: () => Promise<readonly string[] | null>;
  /** The daemon's in-flight session births. */
  birthInFlight?: (pr: number) => boolean;
  statfs?: (path: string) => Promise<StatfsLike>;
  /** Seam: the plan computation (default: src/archive/plan.ts). */
  plan?: (opts: { signal: AbortSignal; memo: PlanMemo }) => Promise<ArchivePlan>;
  now?: () => Date;
  log?: (msg: string, extra?: unknown) => void;
  schedule?: (fn: () => void, ms: number) => () => void;
}

/** One tick's outcome. */
export interface ArchiveTick {
  state: ArchiveState;
  held_reason: ArchiveHoldReason | null;
  /** Whether this tick computed a plan (inventory work happened). */
  planned: boolean;
}

const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return () => clearTimeout(t);
};

export class Archiver {
  private readonly policy: ArchivePolicy;
  private readonly now: () => Date;
  private readonly log: (msg: string, extra?: unknown) => void;
  private readonly schedule: (fn: () => void, ms: number) => () => void;
  private readonly mutex = new StrictMutex();
  private readonly memo: PlanMemo = {};
  private cancel: (() => void) | null = null;
  private started = false;
  private stopped = false;
  private running: Promise<ArchiveTick> | null = null;
  private abort = new AbortController();

  private state: ArchiveState = "unknown";
  private heldReason: ArchiveHoldReason | null = null;
  private heldUntil: string | null = null;
  private runningSince: string | null = null;
  private lastTickAt: string | null = null;
  private lastSuccessAt: string | null = null;
  private lastError: string | null = null;
  private plan: ArchivePlan | null = null;
  private disk: ArchiveDisk | null = null;
  private maxSyncSpanMs: number | null = null;
  private dbCache: {
    at: number;
    totals: ArchiveTotals | null;
    restores: ArchiveStatus["restores"];
    freelist: number | null;
  } | null = null;

  constructor(private readonly deps: ArchiverDeps) {
    this.policy = archivePolicy(deps.cfg);
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? (() => {});
    this.schedule = deps.schedule ?? defaultSchedule;
  }

  /** Arm the timer — none at all under mode `off`. */
  start(): void {
    if (this.stopped || this.started) return;
    this.started = true;
    if (this.policy.mode === "off") {
      this.state = "off";
      this.log('archive: [archive] mode = "off" — no timer armed');
      return;
    }
    if (this.policy.mode === "on")
      this.log("archive: mode on — this build (S1) moves nothing yet; it plans only");
    const loop = (): void => {
      if (this.stopped) return;
      void this.tick().finally(() => {
        if (!this.stopped) this.cancel = this.schedule(loop, this.policy.intervalMs);
      });
    };
    this.cancel = this.schedule(loop, this.policy.intervalMs);
  }

  /** Disarm, and cut any plan in flight. No re-arm after this. */
  stop(): void {
    this.stopped = true;
    this.cancel?.();
    this.cancel = null;
    this.abort.abort();
  }

  /** One tick. Coalesced (a call while one runs joins it); never rejects. */
  tick(): Promise<ArchiveTick> {
    if (this.running) return this.running;
    this.running = this.runTick()
      .catch((err): ArchiveTick => {
        if (this.stopped && this.abort.signal.aborted) {
          // Cut by stop(): not a failure — the next start plans afresh.
          this.state = this.plan ? "plan" : "unknown";
          return { state: this.state, held_reason: null, planned: false };
        }
        this.state = "failed";
        this.lastError = err instanceof Error ? err.message : String(err);
        this.log("archive: tick failed", err);
        return { state: "failed", held_reason: null, planned: false };
      })
      .finally(() => {
        this.running = null;
        this.runningSince = null;
      });
    return this.running;
  }

  /** The latest plan (null before the first completes). */
  lastPlan(): ArchivePlan | null {
    return this.plan;
  }

  private hold(reason: ArchiveHoldReason, until: string | null = null): ArchiveTick {
    this.state = "held";
    this.heldReason = reason;
    this.heldUntil = until;
    return { state: "held", held_reason: reason, planned: false };
  }

  private async runTick(): Promise<ArchiveTick> {
    const release = await this.mutex.acquire();
    try {
      const at = this.now();
      this.lastTickAt = at.toISOString();
      if (this.policy.mode === "off") {
        this.state = "off";
        return { state: "off", held_reason: null, planned: false };
      }
      // Never on the boot pass: the first healthy reconcile, then the delay.
      const healthy = this.deps.firstHealthyReconcileAt();
      if (!healthy) return this.hold("awaiting_reconcile");
      const opens = healthy.getTime() + this.policy.startDelayMs;
      if (at.getTime() < opens) return this.hold("start_delay", new Date(opens).toISOString());
      // The load holds — synchronous, nothing touched.
      let load: DaemonLoadStatus | undefined;
      try {
        load = this.deps.load?.();
      } catch {
        load = undefined;
      }
      const loadReason = loadHold({
        draining: this.deps.store.drainState().draining,
        load,
        starvedRatio: this.deps.starvedRatio ?? DEFAULT_EVENT_LOOP_STARVED_THROTTLE_RATIO,
      });
      if (loadReason) return this.hold(loadReason);
      // The disk: statfs on both mounts. Unknown holds, never a guess.
      const diskReason = await this.checkDisk();
      if (diskReason) return this.hold(diskReason);
      this.heldReason = null;
      this.heldUntil = null;
      // The plan — recomputed at most every PLAN_REFRESH_MS.
      let planned = false;
      if (!this.plan || at.getTime() - Date.parse(this.plan.computed_at) >= PLAN_REFRESH_MS) {
        this.state = "running";
        this.runningSince = at.toISOString();
        const plan = await this.computePlan();
        this.plan = plan;
        this.maxSyncSpanMs = Math.max(this.maxSyncSpanMs ?? 0, plan.max_sync_span_ms);
        this.dbCache = null;
        planned = true;
        this.log(
          `archive: plan — ${plan.backlog.prs} PR(s), ${plan.backlog.bytes} bytes, ` +
            `${plan.backlog.event_rows} event row(s), ${plan.backlog.delivery_rows} delivery row(s); ` +
            `${plan.held.length} held, ${plan.orphans.length} orphan dir(s); took ${plan.took_ms} ms ` +
            `(longest sync span ${plan.max_sync_span_ms} ms); nothing moved`,
        );
      }
      // THIS BUILD MOVES NOTHING: `on` plans exactly as `plan` does.
      this.state = "plan";
      this.lastError = null;
      this.lastSuccessAt = at.toISOString();
      return { state: "plan", held_reason: null, planned };
    } finally {
      release();
    }
  }

  private computePlan(): Promise<ArchivePlan> {
    const signal = this.abort.signal;
    if (this.deps.plan) return this.deps.plan({ signal, memo: this.memo });
    return computePlan({
      store: this.deps.store,
      root: this.deps.root,
      sessionsRoot: this.deps.sessionsRoot,
      now: this.now,
      afterDays: this.policy.afterDays,
      eventsAfterDays: this.policy.eventsAfterDays,
      liveSessions: this.deps.liveSessions ?? (async () => null),
      ...(this.deps.birthInFlight ? { birthInFlight: this.deps.birthInFlight } : {}),
      memo: this.memo,
      signal,
    });
  }

  /** Free space on both mounts against the headroom; records the reading. */
  private async checkDisk(): Promise<ArchiveHoldReason | null> {
    const statfs = this.deps.statfs ?? ((p: string) => fsStatfs(p));
    const headroom = this.policy.diskHeadroomBytes;
    let archiveFree: number;
    let stateFree: number;
    try {
      [archiveFree, stateFree] = await Promise.all([
        freeBytes(join(this.deps.root, "archive"), statfs),
        freeBytes(join(this.deps.root, "state"), statfs),
      ]);
    } catch (err) {
      this.disk = null;
      this.log("archive: statfs failed — disk UNKNOWN, holding", err);
      return "disk_unknown";
    }
    this.disk = { archive_free: archiveFree, state_free: stateFree, headroom };
    return archiveFree < headroom || stateFree < headroom ? "disk_low" : null;
  }

  /** The database figures, re-read at most every STATUS_DB_TTL_MS; each is
   * null when it could not be read — never 0. */
  private dbFigures(): NonNullable<Archiver["dbCache"]> {
    const nowMs = this.now().getTime();
    if (this.dbCache && nowMs - this.dbCache.at < STATUS_DB_TTL_MS) return this.dbCache;
    const db = this.deps.store.db;
    let totals: ArchiveTotals | null = null;
    let restores: ArchiveStatus["restores"] = null;
    let freelist: number | null = null;
    try {
      const prs = db
        .prepare(
          `SELECT COUNT(*) AS prs, COALESCE(SUM(transcript_files + state_files), 0) AS files,
                  COALESCE(SUM(bytes_in), 0) AS bytes_in, COALESCE(SUM(bytes_out), 0) AS bytes_out
             FROM archive_prs WHERE archived_at IS NOT NULL`,
        )
        .get() as { prs: number; files: number; bytes_in: number; bytes_out: number };
      const events = db
        .prepare("SELECT COALESCE(SUM(n), 0) AS n FROM archived_event_counts")
        .get() as { n: number };
      const mark = (name: string): number => {
        const r = db.prepare("SELECT value FROM archive_marks WHERE name = ?").get(name) as
          { value: unknown } | undefined;
        const n = Number(r?.value ?? 0);
        return Number.isFinite(n) ? n : 0;
      };
      totals = {
        ...prs,
        event_rows: events.n,
        delivery_rows: mark("deliveries.archived_rows"),
        duplicates_removed: mark("duplicates.removed"),
      };
      restores = db
        .prepare(
          `SELECT COALESCE(SUM(CASE WHEN a.state = 'restoring'
                                     OR (a.state IN ('archiving', 'archived') AND p.state IS NOT NULL AND p.state != 'closed')
                                    THEN 1 ELSE 0 END), 0) AS pending,
                  COALESCE(SUM(CASE WHEN a.state = 'restored' THEN 1 ELSE 0 END), 0) AS done,
                  COALESCE(SUM(CASE WHEN a.state = 'restore_failed' THEN 1 ELSE 0 END), 0) AS failed
             FROM archive_prs a LEFT JOIN pr_state p ON p.number = a.pr`,
        )
        .get() as { pending: number; done: number; failed: number };
    } catch (err) {
      this.log("archive: could not read the archive ledger", err);
    }
    try {
      const n = db.pragma("freelist_count", { simple: true });
      freelist = typeof n === "number" ? n : null;
    } catch {
      freelist = null;
    }
    this.dbCache = { at: nowMs, totals, restores, freelist };
    return this.dbCache;
  }

  /** status.json `archive` — synchronous, from what the last tick measured. */
  status(): ArchiveStatus {
    const base = pendingArchiveStatus(this.policy.mode);
    const db = this.dbFigures();
    const plan = this.plan;
    return {
      ...base,
      state: this.state,
      held_reason: this.state === "held" ? this.heldReason : null,
      held_until: this.state === "held" ? this.heldUntil : null,
      running_since: this.runningSince,
      last_tick_at: this.lastTickAt,
      last_success_at: this.lastSuccessAt,
      last_error: this.lastError,
      plan_at: plan?.computed_at ?? null,
      backlog: plan ? { ...plan.backlog } : null,
      totals: db.totals,
      disk: this.disk ? { ...this.disk } : null,
      // Nothing is verified in a build that moves nothing — a true zero.
      verify_failures_24h: 0,
      restores: db.restores,
      held_prs: plan
        ? {
            count: plan.held.length,
            first: plan.held.slice(0, 20).map((h) => ({ pr: h.pr, reason: h.reason })),
          }
        : null,
      orphans: plan ? { count: plan.orphans.length, first: plan.orphans.slice(0, 20) } : null,
      freelist_pages: db.freelist,
      max_sync_span_ms: this.maxSyncSpanMs,
    };
  }
}

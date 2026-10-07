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
// Every tick computes the PLAN (src/archive/plan.ts) — what a pass would move
// — and reports it through status.json `archive`. A `plan` tick writes no
// file, no directory and no row. In mode `on` (S2) the tick first
// runs the DB PHASE (src/archive/dbmove.ts): the reader-less event rows and
// the old webhook deliveries move into the month's archive database under
// `archive/db/` (≤ 2 s of synchronous time a tick), and after the plan it
// SEALS a month whose rows can no longer arrive (src/archive/seal.ts). The
// holds are re-read after the DB phase and again before sealing (a hold that
// came up mid-tick ends the tick `held`), and no seal starts once the tick
// budget is spent. The per-PR files are not moved by this build in any mode:
// they are planned.
//
// A refusal that needs a person (a row read back different, a month whose
// counts or gzip do not verify, a listed file gone, a `.gz` already in place)
// is the quiet anomaly `archive_verify_failed` — raised once per incident and
// again only after `ANOMALY_REPEAT_MS`, so a persistent one is a few rows a
// day, never one a tick.
import { statfs as fsStatfs } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ArchiveConfig } from "../config.js";
import type { DaemonLoadStatus } from "../eventloop.js";
import { DEFAULT_EVENT_LOOP_STARVED_THROTTLE_RATIO } from "../eventloop.js";
import type { StateStore } from "../state.js";
import { ArchiveDb, ManifestUnreadable, archiveDbDir } from "./archivedb.js";
import { DbMover, type DbMoveResult } from "./dbmove.js";
import { computePlan, type ArchivePlan, type PlanMemo } from "./plan.js";
import { SEAL_PROBLEMS, recoverSeals, sealDue, type SealResult } from "./seal.js";
import {
  pendingArchiveStatus,
  type ArchiveDbStatus,
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

/** One incident raises `archive_verify_failed` once, and again only this long
 * after — the memory wakes' 6 h. */
export const ANOMALY_REPEAT_MS = 6 * 60 * MIN_MS;

/** `verify_failures_24h`: the daemon-wide anomalies (pr NULL — the archiver's
 * are), newest first down the (kind, pr, id) index, read only back to 24 h
 * ago — never the whole anomaly history. */
export const VERIFY_FAILURES_SQL =
  "SELECT ts, json_extract(payload, '$.kind') AS k FROM events WHERE kind = 'anomaly' AND pr IS NULL ORDER BY id DESC";

/** Past this many rows inside 24 h the count is unknown (null), never a
 * guess. */
export const VERIFY_FAILURES_SCAN_CAP = 20_000;

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
  /** The DB mover's pause between batches (default: a real 100 ms timer). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** The DB mover's span clock (default `performance.now`). */
  clock?: () => number;
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
  /** The archive databases — opened lazily, only in mode `on`. */
  private adb: ArchiveDb | null = null;
  private mover: DbMover | null = null;
  private sealsRecovered = false;
  private db: ArchiveDbStatus | null = null;
  /** When each incident's anomaly was last raised (key → ms). */
  private readonly raised = new Map<string, number>();
  /** Rows moved since the plan last counted them, so the backlog status
   * shows falls between plans. */
  private movedSincePlan = { events: 0, deliveries: 0 };
  private dbCache: {
    at: number;
    totals: ArchiveTotals | null;
    restores: ArchiveStatus["restores"];
    freelist: number | null;
    verifyFailures: number | null;
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
      this.log(
        "archive: mode on — event and delivery rows move to archive/db; the per-PR files are planned only (this build does not move them)",
      );
    const loop = (): void => {
      if (this.stopped) return;
      void this.tick().finally(() => {
        if (!this.stopped) this.cancel = this.schedule(loop, this.policy.intervalMs);
      });
    };
    this.cancel = this.schedule(loop, this.policy.intervalMs);
  }

  /** Disarm, and cut any plan or batch in flight (a batch stops before its
   * live delete; the rows stay in both places and the next start converges).
   * No re-arm after this. The archive connections close now, or as the tick
   * in flight unwinds. */
  stop(): void {
    this.stopped = true;
    this.cancel?.();
    this.cancel = null;
    this.abort.abort();
    if (!this.running) this.closeDb();
  }

  private closeDb(): void {
    this.adb?.close();
    this.adb = null;
    this.mover = null;
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
        if (this.stopped) this.closeDb();
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
      const on = this.policy.mode === "on";
      // The DB phase (mode on only) runs before everything else that moves.
      let failure: string | null = null;
      if (on) {
        this.state = "running";
        this.runningSince = at.toISOString();
        failure = await this.dbPhase();
        // A hold that came up during it (the mover stops on one) ends the tick.
        const midway = failure === null ? this.loadReason() : null;
        if (midway) return this.hold(midway);
      }
      // The plan — recomputed at most every PLAN_REFRESH_MS.
      let planned = false;
      if (!this.plan || at.getTime() - Date.parse(this.plan.computed_at) >= PLAN_REFRESH_MS) {
        this.state = "running";
        this.runningSince ??= at.toISOString();
        const plan = await this.computePlan();
        this.plan = plan;
        this.movedSincePlan = { events: 0, deliveries: 0 };
        this.maxSyncSpanMs = Math.max(this.maxSyncSpanMs ?? 0, plan.max_sync_span_ms);
        this.dbCache = null;
        planned = true;
        this.log(
          `archive: plan — ${plan.backlog.prs} PR(s), ${plan.backlog.bytes} bytes, ` +
            `${plan.backlog.event_rows} event row(s), ${plan.backlog.delivery_rows} delivery row(s); ` +
            `${plan.held.length} held, ${plan.orphans.length} orphan dir(s); took ${plan.took_ms} ms ` +
            `(longest sync span ${plan.max_sync_span_ms} ms)${on ? "" : "; nothing moved"}`,
        );
      }
      // Sealing comes last (§10), and only after a DB phase that did not fail.
      // It starts nothing under a hold (re-read now, the disk included) or once
      // the tick budget is spent.
      if (on && failure === null) {
        const before = this.loadReason() ?? (await this.checkDisk());
        if (before) return this.hold(before);
        if (this.now().getTime() - at.getTime() >= this.policy.tickBudgetMs)
          this.log("archive: sealing waits for the next tick — the tick budget is spent");
        else failure = await this.sealPhase();
      }
      if (failure !== null) {
        this.state = "failed";
        this.lastError = failure;
        return { state: "failed", held_reason: null, planned };
      }
      this.state = on ? "idle" : "plan";
      this.lastError = null;
      this.lastSuccessAt = at.toISOString();
      return { state: this.state, held_reason: null, planned };
    } finally {
      release();
    }
  }

  /** The archive databases, opened on first use (mode `on` only). */
  private async archiveDb(): Promise<ArchiveDb> {
    if (this.adb) return this.adb;
    const adb = new ArchiveDb(archiveDbDir(this.deps.root), {
      now: this.now,
      log: this.log,
    });
    await adb.open();
    this.adb = adb;
    return adb;
  }

  /** The load half of the holds, as it reads now. */
  private loadReason(): ArchiveHoldReason | null {
    let load: DaemonLoadStatus | undefined;
    try {
      load = this.deps.load?.();
    } catch {
      load = undefined;
    }
    return loadHold({
      draining: this.deps.store.drainState().draining,
      load,
      starvedRatio: this.deps.starvedRatio ?? DEFAULT_EVENT_LOOP_STARVED_THROTTLE_RATIO,
    });
  }

  /** The hold, re-read before every batch and every seal. */
  private batchHold(): string | null {
    if (this.stopped) return "stopping";
    return this.loadReason();
  }

  /** The quiet `archive_verify_failed` anomaly, once per incident (`key`) and
   * again only after ANOMALY_REPEAT_MS; a repeat inside it is logged only. */
  private raiseQuiet(key: string, detail: string): void {
    const nowMs = this.now().getTime();
    const last = this.raised.get(key);
    if (last !== undefined && nowMs - last < ANOMALY_REPEAT_MS) {
      this.log(`archive: ${detail} (archive_verify_failed already raised for ${key})`);
      return;
    }
    this.raised.set(key, nowMs);
    this.deps.store.logAnomaly("archive_verify_failed", null, null, detail);
    this.dbCache = null;
  }

  /**
   * Move the reader-less event rows and the old deliveries (§9.2). A batch a
   * lock or a check refused deletes nothing and is REPORTED (status `db`,
   * the log); only an unexpected failure fails the tick. Returns the failure,
   * or null.
   */
  private async dbPhase(): Promise<string | null> {
    const startedAt = this.now().toISOString();
    let adb: ArchiveDb;
    try {
      adb = await this.archiveDb();
      if (!this.sealsRecovered) {
        const rec = await recoverSeals({
          adb,
          maxBytesPerS: this.policy.maxBytesPerS,
          signal: this.abort.signal,
          now: this.now,
          log: this.log,
        });
        this.sealsRecovered = true;
        for (const p of rec.problems)
          this.raiseQuiet(`${p.code}:${p.file}`, `archive seal recovery: ${p.detail}`);
      }
    } catch (err) {
      if (this.abort.signal.aborted) throw err;
      const why =
        err instanceof ManifestUnreadable
          ? `archive db: ${err.message} — nothing is moved until it is readable`
          : `archive db: ${(err as Error).message}`;
      this.log(`archive: ${why}`, err);
      return why;
    }
    this.mover ??= new DbMover({
      store: this.deps.store,
      adb,
      now: this.now,
      eventsAfterDays: this.policy.eventsAfterDays,
      afterDays: this.policy.afterDays,
      batchRows: this.policy.dbBatchRows,
      wallBudgetMs: this.policy.tickBudgetMs,
      signal: this.abort.signal,
      hold: () => this.batchHold(),
      ...(this.deps.sleep ? { sleep: this.deps.sleep } : {}),
      ...(this.deps.clock ? { clock: this.deps.clock } : {}),
      log: this.log,
    });
    const r = await this.mover.run();
    // Stopped: the daemon may close the store right after stop(), so nothing
    // is written; the rows of the cut batch are in both places and converge.
    if (r.outcome === "aborted" || this.abort.signal.aborted) throw new Error("stopped");
    this.recordDb(startedAt, adb, r);
    if (r.outcome === "failed") return `archive db: ${r.error ?? "the mover failed"}`;
    return null;
  }

  private recordDb(at: string, adb: ArchiveDb, r: DbMoveResult): void {
    const counts = adb.counts();
    this.db = {
      last_run_at: at,
      outcome: r.outcome,
      skipped_reason: r.skipped_reason,
      events_moved: r.events.moved,
      deliveries_moved: r.deliveries.moved,
      batch_rows: r.batch_rows,
      sync_ms: r.sync_ms,
      months_open: counts.open,
      months_sealed: counts.sealed,
    };
    this.maxSyncSpanMs = Math.max(this.maxSyncSpanMs ?? 0, r.max_span_ms);
    this.movedSincePlan.events += r.events.moved;
    this.movedSincePlan.deliveries += r.deliveries.moved;
    if (r.events.moved + r.deliveries.moved > 0) this.dbCache = null;
    const undatable = r.events.undatable + r.deliveries.undatable;
    if (r.outcome === "skipped")
      this.log(
        `archive: db batch SKIPPED (${r.skipped_reason}) — nothing deleted; the next tick retries: ${r.error}`,
      );
    for (const sk of r.skips)
      if (sk.reason === "verify_mismatch")
        this.raiseQuiet(
          `verify_mismatch:${sk.file ?? "?"}:${sk.table}`,
          `archive db: ${sk.table} rows read back from the archive absent or different; nothing deleted (${sk.error})`,
        );
    if (r.events.moved + r.deliveries.moved > 0 || undatable > 0)
      this.deps.store.logEvent("archive_pass", null, {
        phase: "db",
        outcome: r.outcome,
        events_moved: r.events.moved,
        deliveries_moved: r.deliveries.moved,
        undatable_kept: undatable,
        sync_ms: r.sync_ms,
        max_span_ms: r.max_span_ms,
        batch_rows: r.batch_rows,
      });
    this.log(
      `archive: db — ${r.events.moved} event / ${r.deliveries.moved} delivery row(s) moved ` +
        `(${r.outcome}${r.skipped_reason ? `: ${r.skipped_reason}` : ""}); ` +
        `${r.sync_ms} ms synchronous, longest ${r.max_span_ms} ms; next batch ${r.batch_rows} rows` +
        (undatable > 0 ? `; ${undatable} undatable row(s) kept live` : ""),
    );
  }

  /** Seal the months whose rows can no longer arrive (§9.5). A seal the rule
   * or a check refuses is reported and retried later; only an unexpected
   * failure fails the tick. */
  private async sealPhase(): Promise<string | null> {
    const adb = this.adb;
    if (!adb) return null;
    let results: SealResult[];
    try {
      results = await sealDue({
        store: this.deps.store,
        adb,
        now: this.now,
        eventsAfterDays: this.policy.eventsAfterDays,
        afterDays: this.policy.afterDays,
        gzipLevel: this.policy.gzipLevel,
        maxBytesPerS: this.policy.maxBytesPerS,
        signal: this.abort.signal,
        hold: () => this.batchHold(),
        log: this.log,
      });
    } catch (err) {
      if (this.abort.signal.aborted) throw err;
      // A seal that failed partway (its .gz placed, the manifest not written)
      // is what recovery settles: run it again before the next tick's work.
      this.sealsRecovered = false;
      this.log("archive: sealing failed", err);
      return `archive seal: ${(err as Error).message}`;
    }
    if (this.abort.signal.aborted) throw new Error("stopped");
    for (const r of results) {
      if (r.outcome === "sealed") {
        this.deps.store.logEvent("archive_month_sealed", null, {
          file: r.file,
          gz_file: r.gz_file,
          tables: r.tables,
        });
        continue;
      }
      this.log(`archive: ${r.file} not sealed (${r.outcome}): ${r.detail ?? ""}`);
      if (SEAL_PROBLEMS.has(r.outcome))
        this.raiseQuiet(
          `${r.outcome}:${r.file}`,
          `archive seal ${r.file}: ${r.outcome} — ${r.detail ?? ""}; nothing is removed`,
        );
    }
    if (results.length > 0) this.dbCache = null;
    const counts = adb.counts();
    if (this.db) this.db = { ...this.db, months_open: counts.open, months_sealed: counts.sealed };
    return null;
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
    let verifyFailures: number | null = null;
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
      // The quiet `archive_verify_failed` anomalies of the last 24 h: newest
      // first, stopping at the first row older than that.
      const since = new Date(nowMs - 86_400_000).toISOString();
      let n = 0;
      let scanned = 0;
      let complete = true;
      for (const row of db.prepare(VERIFY_FAILURES_SQL).iterate() as Iterable<{
        ts: unknown;
        k: unknown;
      }>) {
        if (typeof row.ts === "string" && row.ts < since) break;
        if (++scanned > VERIFY_FAILURES_SCAN_CAP) {
          complete = false;
          break;
        }
        if (row.k === "archive_verify_failed") n += 1;
      }
      verifyFailures = complete ? n : null;
    } catch {
      verifyFailures = null;
    }
    try {
      const n = db.pragma("freelist_count", { simple: true });
      freelist = typeof n === "number" ? n : null;
    } catch {
      freelist = null;
    }
    this.dbCache = { at: nowMs, totals, restores, freelist, verifyFailures };
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
      backlog: plan
        ? {
            ...plan.backlog,
            event_rows: Math.max(0, plan.backlog.event_rows - this.movedSincePlan.events),
            delivery_rows: Math.max(0, plan.backlog.delivery_rows - this.movedSincePlan.deliveries),
          }
        : null,
      totals: db.totals,
      disk: this.disk ? { ...this.disk } : null,
      // The quiet `archive_verify_failed` anomalies of the last 24 h (null
      // when they could not be counted — never a guessed 0).
      verify_failures_24h: db.verifyFailures,
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
      db: this.db ? { ...this.db } : null,
    };
  }
}

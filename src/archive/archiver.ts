// The closed-PR archiver (docs/archiving.md §10) — daemon
// bookkeeping on its own timer. It never spawns pi, injects, wakes or kills a
// session, and makes no GitHub call (root rule 9; it is not a session kind).
//
// The shape is the CaseWriter's (src/cases.ts): an injected `schedule` seam
// that re-arms AFTER each tick finishes (unref'd), a coalesced tick (a call
// while one runs joins it) and a `stopped` flag — plus a STRICT mutex, never
// SingleFlight: SingleFlight abandons an overdue pass and starts a second
// beside it, and two archivers on one PR's files is exactly the hazard. A
// restore takes the mutex WITH PRIORITY: a running pass checks between files,
// batches and phases and yields to it.
//
//   - Start: never on the boot pass. No tick does any work before the
//     daemon's first HEALTHY reconcile plus `[archive] start_delay_min`.
//   - Holds: nothing is started while draining, while the event loop reads
//     `stalled`, while the container is CPU-starved (throttled in at least
//     `[daemon] event_loop_starved_throttle_ratio` of its periods), or while
//     either mount's free space is below `disk_headroom_gb` — or UNKNOWN (a
//     failed statfs is a hold, never a guess). An unknown load reading is not
//     a hold, but the file phase then runs at its minimum: one PR, half the
//     rate.
//   - Mode `off` arms no timer at all.
//
// Every tick computes the PLAN (src/archive/plan.ts) — what a pass would move
// — and reports it through status.json `archive`. A `plan` tick writes no
// file, no directory and no row. In mode `on` a tick, in order:
//
//   1. once per daemon start, CRASH RECOVERY (§7.6): stray `.partial` files
//      in the archive dirs of PRs left `archiving`/`restoring`, and stray
//      `.restore-partial` files at their restore targets, are deleted;
//   2. RESTORES (§8.3) of every PR the registry no longer calls closed whose
//      row is not `restored` — never held by a drain;
//   3. the holds;
//   4. the DB PHASE (src/archive/dbmove.ts): the reader-less event rows
//      and old webhook deliveries into `archive/db/`;
//   5. the plan;
//   6. the FILE PHASE: the plan's eligible PRs, oldest close first, each
//      through `prarchive.ts` — at most `max_prs_per_tick`, no new file after
//      `tick_budget_s`, the disk checked before every file (§7.7);
//   7. the STORES that belong to no PR: the overseer's non-current
//      transcripts (`overseer.ts`) and pi's global session store
//      (`piglobal.ts`), under the same budget, holds and disk checks;
//   8. SEALING finished months (src/archive/seal.ts).
//
// The operator's two verbs (`archive-run` and `archive-restore`, valid
// only from the root-sealed `commands/operator/`) reach `operatorRun` — one
// immediate tick, a fresh plan, every hold still binding — and
// `operatorRestore` — one PR's archive back to its live paths, the mutex
// taken WITH PRIORITY so a running pass yields at its next file boundary.
// Each answers within OPERATOR_WAIT_MS (the operator channel is served one
// command at a time); a tick or restore still running then says so and goes
// on. Before the daemon's first healthy reconcile each answers at once — the
// run with its hold, the restore going on in the background — because the
// operator watcher's startup sweep (awaited by the daemon's start) serves a
// file left while the daemon was down, and a verb must never hold the boot.
//
// A refusal that needs a person (a copy or a row read back different, a
// manifest that cannot be read, a month whose counts or gzip do not verify)
// is the quiet anomaly `archive_verify_failed` — raised once per incident and
// again only after `ANOMALY_REPEAT_MS`. Two are WAKES (src/anomalies.ts):
// `archive_disk_low` (free space below the headroom, once per incident and
// every 6 h) and `archive_restore_failed` (a reopened PR's archive did not
// come back; its session is born anyway, and the receipt guard keeps the
// archived window unknown).
import { statfs as fsStatfs } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type { ArchiveConfig } from "../config.js";
import type { FileOutcome } from "../improvements.js";
import type { DaemonLoadStatus } from "../eventloop.js";
import { DEFAULT_EVENT_LOOP_STARVED_THROTTLE_RATIO } from "../eventloop.js";
import type { StateStore } from "../state.js";
import { yieldToLoop } from "../yieldloop.js";
import { ArchiveDb, ManifestUnreadable, archiveDbDir } from "./archivedb.js";
import { DbMover, type DbMoveResult } from "./dbmove.js";
import type { OutsideFacts } from "./eligibility.js";
import { removeRestorePartial, sweepPartials, type StepFn } from "./gzfile.js";
import {
  LIVE_SESSIONS_DEADLINE_MS,
  askLiveSessions,
  computePlan,
  type ArchivePlan,
  type PlanMemo,
} from "./plan.js";
import { OVERSEER_STORE, archiveOverseer } from "./overseer.js";
import { archivePiGlobal } from "./piglobal.js";
import { archivePr, type PrPassResult } from "./prarchive.js";
import { SpanMeter, injectDirOf, listLiveTree, topLevelInjectFiles } from "./prfiles.js";
import {
  RESTORE_RETRY_MS,
  RESTORE_WAIT_MS,
  restorePr,
  restoreTargets,
  type RestoreResult,
} from "./restore.js";
import { archiveRow, bumpMark, inFlightRows, reopenedRows } from "./rows.js";
import { SEAL_PROBLEMS, recoverSeals, sealDue, type SealResult } from "./seal.js";
import {
  OPERATOR_WAIT_MS,
  pendingArchiveStatus,
  type ArchiveDbStatus,
  type ArchiveDisk,
  type ArchiveFilesStatus,
  type ArchiveHoldReason,
  type ArchiveState,
  type ArchiveStatus,
  type ArchiveStoreStatus,
  type ArchiveTotals,
} from "./status.js";
import { emptyStoreResult, type StorePassResult } from "./storepass.js";

export { OPERATOR_WAIT_MS };

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

/**
 * A strict mutex: holders run one at a time — in arrival order, except that a
 * PRIORITY waiter (a restore) is served before every ordinary one. The holder
 * is never interrupted; it asks `priorityWaiting()` at its own boundaries and
 * releases early.
 */
export class StrictMutex {
  private locked = false;
  private readonly waiters: Array<{ grant: () => void; priority: boolean }> = [];

  acquire(priority = false): Promise<() => void> {
    return new Promise((resolve) => {
      const grant = (): void => {
        this.locked = true;
        let done = false;
        resolve(() => {
          if (done) return;
          done = true;
          this.handOn();
        });
      };
      if (!this.locked) {
        grant();
        return;
      }
      const waiter = { grant, priority };
      if (priority) {
        // After the priority waiters already queued, before every ordinary one.
        const at = this.waiters.findIndex((w) => !w.priority);
        if (at === -1) this.waiters.push(waiter);
        else this.waiters.splice(at, 0, waiter);
      } else this.waiters.push(waiter);
    });
  }

  private handOn(): void {
    const next = this.waiters.shift();
    if (next) next.grant();
    else this.locked = false;
  }

  held(): boolean {
    return this.locked;
  }

  /** Is a priority waiter (a restore) queued behind the holder? */
  priorityWaiting(): boolean {
    return this.waiters.some((w) => w.priority);
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
  /** The daemon's in-flight session births. Absent = not observable: the
   * file phase then moves nothing (`births_unknown`), never a guess. */
  birthInFlight?: (pr: number) => boolean;
  statfs?: (path: string) => Promise<StatfsLike>;
  /** When the overseer session was born (its birth record); null = unknown —
   * the overseer store then moves nothing. Absent = no overseer pass. */
  overseerBornAt?: () => Date | null;
  /** pi's global session store (`~/.pi/agent/sessions`). Absent = no
   * pi-global pass. */
  piGlobalDir?: string;
  /** How long `beforeBirth` waits for a restore (default RESTORE_WAIT_MS). */
  restoreWaitMs?: number;
  /** How long an operator verb waits before answering (default
   * OPERATOR_WAIT_MS). */
  operatorWaitMs?: number;
  /** Crash-injection seam (tests): every file-protocol step. */
  step?: StepFn;
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
  /** The disk reason that stopped this tick's DB phase between batches. */
  private dbRoomHold: "disk_low" | "disk_unknown" | null = null;
  /** The stores whose manifest a pass has settled since this start (a crash's
   * unstamped removals are stamped once, even with nothing to move). */
  private readonly storesSettled = new Set<"overseer" | "pi_global">();
  /** The disk reason a month's gzip found no room under this tick. */
  private sealRoomHold: "disk_low" | "disk_unknown" | null = null;
  private sealsRecovered = false;
  private db: ArchiveDbStatus | null = null;
  /** When each incident's anomaly was last raised (key → ms). */
  private readonly raised = new Map<string, number>();
  /** Rows moved since the plan last counted them, so the backlog status
   * shows falls between plans. */
  private movedSincePlan = { events: 0, deliveries: 0 };
  /** The last per-tick line's SHAPE for each phase (outcome + hold reason,
   * never the timings). An idle tick at the same shape logs nothing, so a
   * caught-up archiver does not write a line a minute forever; work done, or a
   * changed outcome or hold, always logs. */
  private lastTickLine = new Map<string, string>();
  /** The file phase's last run. */
  private files: ArchiveFilesStatus | null = null;
  /** Crash recovery (§7.6) has run once this start. */
  private filesRecovered = false;
  /** PRs whose crash recovery failed (an unreadable archive or live dir), by
   * why: retried every tick, and their archive pass held meanwhile — one
   * unreadable dir never stops the restores or another PR's work. */
  private readonly recoveryOwed = new Map<number, string>();
  /** Plan candidates this plan's file phase is done with (archived, held, or
   * failed to verify — the next plan offers them again). */
  private doneSincePlan = new Set<number>();
  /** What the file phase archived since the plan counted it. */
  private filesSincePlan = { prs: 0, bytes: 0 };
  /** Why a planned PR was not archived when its pass ran (its fresh
   * eligibility, an unreadable manifest, …). */
  private readonly fileHeld = new Map<number, string>();
  /** Restores started by a birth, by PR: shared by every caller, each waiting
   * until the flight's own deadline. */
  private readonly restoring = new Map<
    number,
    { promise: Promise<RestoreResult | null>; deadline: number }
  >();
  /** When each PR's last restore attempt ran (ms) — a failed one is retried
   * only after RESTORE_RETRY_MS. */
  private readonly restoreAttempted = new Map<number, number>();
  /** The disk-low incident: since when, when its wake last fired, and the
   * archive-mount free space it needs to be over (the headroom plus the
   * largest file that did not fit in it). */
  private diskIncident: { since: number; raisedAt: number; need: number } | null = null;
  private birthsUnknownLogged = false;
  /** The stores' last passes. */
  private readonly stores: {
    overseer: ArchiveStoreStatus | null;
    pi_global: ArchiveStoreStatus | null;
  } = { overseer: null, pi_global: null };
  /** The next tick recomputes the plan whatever its age (an operator's run). */
  private forcePlan = false;
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
        "archive: mode on — reopened PRs are restored, event and delivery rows move to archive/db, closed PRs' files to archive/pr-<n>/",
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
    // The daemon connection's automatic checkpoint back now, synchronously:
    // the daemon may close the store right after this returns.
    this.mover?.release();
    if (!this.running) this.closeDb();
  }

  private closeDb(): void {
    this.mover?.release();
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

  /** End the tick held. `planned` says whether this tick computed a plan
   * before the hold came up. */
  private hold(
    reason: ArchiveHoldReason,
    opts: { until?: string | null; planned?: boolean } = {},
  ): ArchiveTick {
    this.state = "held";
    this.heldReason = reason;
    this.heldUntil = opts.until ?? null;
    return { state: "held", held_reason: reason, planned: opts.planned ?? false };
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
      if (at.getTime() < opens)
        return this.hold("start_delay", { until: new Date(opens).toISOString() });
      const on = this.policy.mode === "on";
      // Mode on: crash recovery (once per start), then the restores of reopened
      // PRs — before the tick's holds, because a drain never holds a restore
      // (a stalled loop or a starved CPU does: `tickRestores` checks those).
      if (on) {
        this.state = "running";
        this.runningSince = at.toISOString();
        await this.recoverFiles();
        await this.tickRestores();
      }
      // The load holds — synchronous, nothing touched.
      const loadReason = this.loadReason();
      if (loadReason) return this.hold(loadReason);
      // The disk: statfs on both mounts. Unknown holds, never a guess.
      const diskReason = await this.checkDisk();
      if (diskReason) return this.hold(diskReason);
      this.heldReason = null;
      this.heldUntil = null;
      // The DB phase (mode on only) runs before everything else that moves.
      let failure: string | null = null;
      if (on) {
        this.state = "running";
        this.runningSince ??= at.toISOString();
        failure = await this.dbPhase();
        // A hold that came up during it (the mover stops on one, the disk
        // included) ends the tick.
        const midway = failure === null ? (this.loadReason() ?? this.dbRoomHold) : null;
        if (midway) return this.hold(midway);
        if (this.mutex.priorityWaiting()) return this.yieldToRestore(at);
      }
      // The plan — recomputed at most every PLAN_REFRESH_MS.
      let planned = false;
      const force = this.forcePlan;
      this.forcePlan = false;
      if (
        force ||
        !this.plan ||
        at.getTime() - Date.parse(this.plan.computed_at) >= PLAN_REFRESH_MS
      ) {
        this.state = "running";
        this.runningSince ??= at.toISOString();
        const plan = await this.computePlan();
        this.plan = plan;
        this.movedSincePlan = { events: 0, deliveries: 0 };
        this.filesSincePlan = { prs: 0, bytes: 0 };
        this.doneSincePlan = new Set();
        this.fileHeld.clear();
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
      // The file phase (mode on): the eligible PRs' files into archive/pr-<n>/.
      if (on && failure === null) {
        if (this.mutex.priorityWaiting()) return this.yieldToRestore(at, planned);
        const files = await this.filePhase(at);
        if (files.failure) failure = files.failure;
        else if (files.hold) return this.hold(files.hold, { planned });
        if (this.mutex.priorityWaiting()) return this.yieldToRestore(at, planned);
        // The stores that belong to no PR: after the PRs (§10).
        if (failure === null) {
          const hold = await this.storesPhase(at);
          if (hold) return this.hold(hold, { planned });
          if (this.mutex.priorityWaiting()) return this.yieldToRestore(at, planned);
        }
      }
      // Sealing comes last (§10), and only after a DB phase that did not fail.
      // It starts nothing under a hold (re-read now, the disk included) or once
      // the tick budget is spent.
      if (on && failure === null) {
        const before = this.loadReason() ?? (await this.checkDisk());
        if (before) return this.hold(before, { planned });
        if (this.now().getTime() - at.getTime() >= this.policy.tickBudgetMs)
          this.log("archive: sealing waits for the next tick — the tick budget is spent");
        else {
          failure = await this.sealPhase();
          // No room for a month's gzip: a mount short of the headroom (or a
          // failed reading) holds the tick; one month too large for the
          // archive mount only waits, as one large PR file does.
          const room = failure === null ? this.sealRoomHold : null;
          if (room && !(room === "disk_low" && this.headroomHolds()))
            return this.hold(room, { planned });
        }
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

  /** A restore is waiting for the mutex: end this tick here (nothing is cut
   * mid-file; the next tick resumes). */
  private yieldToRestore(at: Date, planned = false): ArchiveTick {
    this.log("archive: yielding the rest of this tick to a restore");
    this.state = "idle";
    this.lastSuccessAt = at.toISOString();
    return { state: "idle", held_reason: null, planned };
  }

  // ---- the operator's verbs (§11) ------------------------------------------

  /** Is the strict mutex held right now (a tick, or a restore)? */
  busy(): boolean {
    return this.mutex.held();
  }

  /**
   * `archive-run` — one immediate tick, under the strict mutex, with a fresh
   * plan. Every hold still binds (the start delay, a drain, a stalled loop, a
   * starved CPU, the disk): the answer names the one that held it. A tick
   * already running is let finish first, so the tick this answers for began
   * after the request. Answers within OPERATOR_WAIT_MS; a tick still running
   * then says so (`done: false`) and goes on. Mode `off` refuses. Before the
   * daemon's first healthy reconcile it answers that hold at once.
   */
  async operatorRun(): Promise<FileOutcome> {
    if (this.stopped) return { ok: false, reason: "the archiver is stopping" };
    if (this.policy.mode === "off")
      return {
        ok: false,
        reason: '[archive] mode = "off" — nothing runs; set it to "plan" or "on" first',
      };
    // Before the daemon's first healthy reconcile no tick may do anything, so
    // the answer is that hold, given at once — never after queueing behind
    // the mutex (a boot restore may hold it). The operator watcher's startup
    // sweep, which the daemon's start awaits, serves a file left while the
    // daemon was down: an operator verb must never hold the boot.
    if (this.deps.firstHealthyReconcileAt() === null) {
      const s = this.status();
      return {
        ok: true,
        done: true,
        mode: this.policy.mode,
        state: "held",
        held_reason: "awaiting_reconcile",
        planned: false,
        note: "no tick runs before the daemon's first healthy reconcile",
        backlog: s.backlog,
        db: s.db,
        files: s.files,
        stores: s.stores,
      };
    }
    const run = (this.running ?? Promise.resolve()).then(() => {
      this.forcePlan = true;
      return this.tick();
    });
    const waited = await raceTimeout(run, this.deps.operatorWaitMs ?? OPERATOR_WAIT_MS);
    if (!waited.done)
      return {
        ok: true,
        done: false,
        state: "running",
        note: `the tick is still running after ${Math.round((this.deps.operatorWaitMs ?? OPERATOR_WAIT_MS) / 1000)} s and goes on — see \`qcr archive status\``,
      };
    const t = waited.value;
    const s = this.status();
    return {
      ok: t.state !== "failed",
      ...(t.state === "failed" ? { reason: this.lastError ?? "the tick failed" } : {}),
      done: true,
      mode: this.policy.mode,
      state: t.state,
      held_reason: t.held_reason,
      ...(t.state === "held" && s.held_until ? { held_until: s.held_until } : {}),
      planned: t.planned,
      backlog: s.backlog,
      db: s.db,
      files: s.files,
      stores: s.stores,
    };
  }

  /**
   * `archive-restore <pr>` — one PR's archive back to its live paths (the
   * repair verb, §11): its transcripts and session-command payloads, verified,
   * at their original mtimes, never over a live file. In any mode, on a
   * closed PR too (it becomes eligible again `after_days` after the restore),
   * and a failed restore is retried at once (the 6 h retry spacing binds
   * births and ticks, not the operator). The mutex is taken WITH PRIORITY: a
   * running pass yields at its next file boundary. A restore a birth already
   * started is joined, never run twice. Answers within OPERATOR_WAIT_MS; one
   * still running then says so (`done: false`) and goes on. Before the
   * daemon's first healthy reconcile it answers at once (`done: false`) and
   * the restore goes on in the background.
   */
  async operatorRestore(pr: number): Promise<FileOutcome> {
    if (this.stopped) return { ok: false, reason: "the archiver is stopping" };
    let row: ReturnType<typeof archiveRow>;
    try {
      row = archiveRow(this.deps.store, pr);
    } catch (err) {
      return {
        ok: false,
        reason: `pr-${pr}'s archive row could not be read: ${(err as Error).message}`,
      };
    }
    if (!row)
      return {
        ok: true,
        done: true,
        outcome: "none",
        note: `pr-${pr} has no archive row — nothing of it was archived`,
      };
    if (row.state === "restored" && !this.restoring.has(pr))
      return {
        ok: true,
        done: true,
        outcome: "none",
        note: `pr-${pr} is restored already (at ${row.restored_at ?? "an unrecorded time"})`,
      };
    const flight = this.restoring.get(pr) ?? this.startRestore(pr, "operator");
    // Served before the daemon's first healthy reconcile — a file the
    // operator left while the daemon was down, met by the operator watcher's
    // startup sweep, which the daemon's start awaits: the restore goes on in
    // the background and the answer comes at once, so it never holds the
    // boot (or the first reconcile) behind it. Its outcome is the row's, the
    // events' and `qcr archive status`'s.
    if (this.deps.firstHealthyReconcileAt() === null)
      return {
        ok: true,
        done: false,
        outcome: "restoring",
        note: "served while the daemon starts (before its first healthy reconcile): the restore goes on in the background — see `qcr archive status`",
      };
    const waited = await raceTimeout(flight.promise, this.deps.operatorWaitMs ?? OPERATOR_WAIT_MS);
    if (!waited.done)
      return {
        ok: true,
        done: false,
        outcome: "restoring",
        note: `the restore is still running after ${Math.round((this.deps.operatorWaitMs ?? OPERATOR_WAIT_MS) / 1000)} s and goes on — see \`qcr archive status\``,
      };
    const r = waited.value;
    if (r === null) {
      // Joined nothing that ran (stopping, or restored meanwhile): the row
      // says what is so.
      const now = archiveRow(this.deps.store, pr);
      return now?.state === "restored"
        ? { ok: true, done: true, outcome: "restored", note: "restored (by another caller)" }
        : { ok: false, reason: `the restore did not run (row ${now?.state ?? "gone"})` };
    }
    if (r.outcome === "failed")
      return {
        ok: false,
        reason: r.error ?? "the restore failed",
        done: true,
        outcome: "failed",
        restored: r.restored,
        present: r.present,
      };
    return {
      ok: true,
      done: true,
      outcome: r.outcome,
      restored: r.restored,
      present: r.present,
      live_differs: r.liveDiffers,
    };
  }

  // ---- restores (§8.2–§8.4) ------------------------------------------------

  /**
   * Awaited by the session manager before a PR session is born (§8.3). With
   * no archive row, or a `restored` one, it returns at once (a synchronous
   * read). Otherwise it starts the PR's restore (or joins the one running)
   * and waits for it — at most `restoreWaitMs` from when that restore began.
   * It never throws and never refuses a birth: a failed or slow restore lets
   * the birth go ahead, and the receipt guard keeps the archived window
   * unknown meanwhile. Mode `on` only (file work); a restore failed within
   * RESTORE_RETRY_MS is not retried by a birth.
   */
  async beforeBirth(pr: number): Promise<void> {
    if (this.stopped || this.policy.mode !== "on") return;
    let flight = this.restoring.get(pr);
    if (!flight) {
      let row: ReturnType<typeof archiveRow>;
      try {
        row = archiveRow(this.deps.store, pr);
        if (!row || row.state === "restored") return;
        if (this.deps.store.getPr(pr)?.state === "closed") return;
      } catch (err) {
        this.log(`archive: beforeBirth could not read pr-${pr}'s archive row`, err);
        return;
      }
      if (row.state === "restore_failed" && !this.restoreRetryDue(pr)) return;
      flight = this.startRestore(pr);
    }
    await waitAtMost(flight.promise, flight.deadline - performance.now());
  }

  private restoreRetryDue(pr: number): boolean {
    const last = this.restoreAttempted.get(pr);
    return last === undefined || this.now().getTime() - last >= RESTORE_RETRY_MS;
  }

  /** The load holds a tick's restores obey: every one but the drain (§10). */
  private restoreLoadHold(): ArchiveHoldReason | null {
    let load: DaemonLoadStatus | undefined;
    try {
      load = this.deps.load?.();
    } catch {
      load = undefined;
    }
    return loadHold({
      draining: false,
      load,
      starvedRatio: this.deps.starvedRatio ?? DEFAULT_EVENT_LOOP_STARVED_THROTTLE_RATIO,
    });
  }

  /** Room for a restored file of `bytes` on the LIVE (state) mount, plus the
   * headroom (§7.7): null = room; `disk_low`, or `disk_unknown` when statfs
   * failed — never a guess. */
  private async liveRoomFor(bytes: number): Promise<"disk_low" | "disk_unknown" | null> {
    const statfs = this.deps.statfs ?? ((p: string) => fsStatfs(p));
    let free: number;
    try {
      free = await freeBytes(join(this.deps.root, "state"), statfs);
    } catch (err) {
      this.log(
        "archive: statfs of the live mount failed before a restored file — disk UNKNOWN",
        err,
      );
      return "disk_unknown";
    }
    return free >= bytes + this.policy.diskHeadroomBytes ? null : "disk_low";
  }

  /** A restore outside a tick: the mutex taken WITH PRIORITY (a running pass
   * yields to it at its next file boundary). */
  private startRestore(
    pr: number,
    trigger: "reopen" | "operator" = "reopen",
  ): { promise: Promise<RestoreResult | null>; deadline: number } {
    const promise = (async (): Promise<RestoreResult | null> => {
      const release = await this.mutex.acquire(true);
      try {
        if (this.stopped) return null;
        const row = archiveRow(this.deps.store, pr);
        if (!row || row.state === "restored") return null;
        return await this.restoreOne(pr, trigger);
      } catch (err) {
        if (!this.abort.signal.aborted) this.log(`archive: pr-${pr} restore threw`, err);
        return null;
      } finally {
        release();
      }
    })();
    const flight = {
      promise,
      deadline: performance.now() + (this.deps.restoreWaitMs ?? RESTORE_WAIT_MS),
    };
    this.restoring.set(pr, flight);
    void promise.finally(() => {
      if (this.restoring.get(pr) === flight) this.restoring.delete(pr);
    });
    return flight;
  }

  /** One restore; the mutex is held by the caller. */
  private async restoreOne(pr: number, trigger: "reopen" | "operator"): Promise<RestoreResult> {
    this.restoreAttempted.set(pr, this.now().getTime());
    const r = await restorePr(
      {
        store: this.deps.store,
        root: this.deps.root,
        sessionsRoot: this.deps.sessionsRoot,
        now: this.now,
        bytesPerS: this.policy.maxBytesPerS,
        signal: this.abort.signal,
        log: this.log,
        roomFor: (bytes) => this.liveRoomFor(bytes),
        ...(this.deps.step ? { step: this.deps.step } : {}),
      },
      pr,
      trigger,
    );
    this.dbCache = null;
    if (r.outcome === "restored") {
      this.raised.delete(`restore:${pr}`);
      this.deps.store.logEvent("archive_pr_restored", pr, {
        trigger,
        restored: r.restored,
        present: r.present,
        live_differs: r.liveDiffers,
      });
    } else if (r.outcome === "failed")
      this.raiseWake(
        "archive_restore_failed",
        pr,
        `restore:${pr}`,
        trigger === "operator"
          ? `The operator's restore of PR #${pr}'s archive failed: ${r.error ?? "unknown"}. ` +
              "Nothing archived was lost; receipts of its archived wakes read UNKNOWN (never absent) until a restore succeeds."
          : `PR #${pr} was reopened but its archived files could not be restored: ${r.error ?? "unknown"}. ` +
              "Its session is born anyway; receipts of its pre-close wakes read UNKNOWN (never absent) until a restore succeeds.",
      );
    return r;
  }

  /** The tick's restores, first and before any other work: every PR the
   * registry no longer calls closed whose row is not `restored`. */
  private async tickRestores(): Promise<void> {
    let rows: ReturnType<typeof reopenedRows>;
    try {
      rows = reopenedRows(this.deps.store);
    } catch (err) {
      this.log("archive: could not list the PRs to restore", err);
      return;
    }
    for (const row of rows) {
      if (this.stopped) return;
      if (row.state === "restore_failed" && !this.restoreRetryDue(row.pr)) continue;
      // A drain never holds a restore (§10); a stalled loop or a starved CPU
      // does — the tick's restores wait for the next tick (a birth's own
      // restore is not held: the birth is waiting on it).
      const load = this.restoreLoadHold();
      if (load) {
        this.log(`archive: the restores wait for the next tick — ${load}`);
        return;
      }
      try {
        await this.restoreOne(row.pr, "reopen");
      } catch (err) {
        if (this.abort.signal.aborted) throw err;
        this.log(`archive: pr-${row.pr} restore threw`, err);
      }
    }
  }

  /** Crash recovery (§7.6), once per daemon start before any file work: the
   * stray temporaries of PRs a crash left `archiving` or `restoring` (or a
   * restore left `restore_failed`). The archive gzips with no entry are
   * settled by the PR's next pass. A PR whose dirs cannot be read is that
   * PR's problem alone: the quiet anomaly, its pass held (`recovery_failed`)
   * and its recovery retried every tick — the restores, the other PRs and
   * every later phase go on. */
  private async recoverFiles(): Promise<void> {
    if (this.filesRecovered && this.recoveryOwed.size === 0) return;
    let rows: ReturnType<typeof inFlightRows>;
    try {
      rows = inFlightRows(this.deps.store);
    } catch (err) {
      this.log(
        "archive: crash recovery could not list the rows in flight — retried next tick",
        err,
      );
      return;
    }
    for (const pr of [...this.recoveryOwed.keys()])
      if (!rows.some((r) => r.pr === pr)) this.recoveryOwed.delete(pr);
    const todo = this.filesRecovered ? rows.filter((r) => this.recoveryOwed.has(r.pr)) : rows;
    let removed = 0;
    for (const row of todo) {
      this.abort.signal.throwIfAborted();
      try {
        removed += await sweepPartials(join(this.deps.root, "archive", `pr-${row.pr}`));
        for (const t of await restoreTargets(this.deps.root, this.deps.sessionsRoot, row.pr))
          if (await removeRestorePartial(t)) removed += 1;
        this.recoveryOwed.delete(row.pr);
      } catch (err) {
        if (this.abort.signal.aborted) throw err;
        const why = err instanceof Error ? err.message : String(err);
        this.recoveryOwed.set(row.pr, why);
        this.raiseQuiet(
          `recovery:${row.pr}`,
          `archive crash recovery: pr-${row.pr}: ${why} — its temporaries are left as found and its archive pass is held until recovery succeeds`,
        );
      }
      await yieldToLoop();
    }
    this.filesRecovered = true;
    if (removed > 0) this.log(`archive: crash recovery removed ${removed} stray temporary file(s)`);
  }

  // ---- the file phase (§7) ---------------------------------------------------

  /** Why no new file may start now: stopping, a restore waiting, the tick
   * budget spent, or a hold. */
  private fileStop(at: Date): string | null {
    if (this.stopped) return "stopping";
    if (this.mutex.priorityWaiting()) return "restore_pending";
    if (this.now().getTime() - at.getTime() >= this.policy.tickBudgetMs) return "budget";
    return this.loadReason();
  }

  /** The eligibility facts outside the database, asked fresh for one PR. */
  private async outsideFacts(pr: number): Promise<OutsideFacts> {
    const names = await askLiveSessions(
      this.deps.liveSessions ?? (async () => null),
      LIVE_SESSIONS_DEADLINE_MS,
      this.abort.signal,
    );
    let injectFiles: string[] | null;
    try {
      injectFiles = await topLevelInjectFiles(injectDirOf(this.deps.root, pr));
    } catch {
      injectFiles = null;
    }
    return {
      tmuxAlive: names === null ? null : names.includes(`pr-${pr}`),
      birthInFlight: false,
      injectFiles,
    };
  }

  /** Room for one file of `bytes` (§7.7): the archive mount needs the file
   * plus the headroom, the state mount the headroom. */
  private async diskFor(bytes: number): Promise<"disk_low" | "disk_unknown" | null> {
    return this.checkDisk(bytes);
  }

  /** Does the last disk reading have the headroom itself on both mounts (so
   * a `disk_low` it gave was one file too large, not a low disk)? */
  private headroomHolds(): boolean {
    const d = this.disk;
    return d !== null && d.archive_free >= d.headroom && d.state_free >= d.headroom;
  }

  /**
   * The plan's eligible PRs, oldest close first. Returns a failure (the live
   * tree could not be listed), or the hold that stopped it, or neither.
   */
  private async filePhase(
    at: Date,
  ): Promise<{ failure: string | null; hold: ArchiveHoldReason | null }> {
    const startedAt = this.now().toISOString();
    const birthInFlight = this.deps.birthInFlight;
    const blank = (outcome: string, held: string | null): ArchiveFilesStatus => ({
      last_run_at: startedAt,
      outcome,
      held_reason: held,
      prs_started: 0,
      prs_archived: 0,
      prs_partial: 0,
      prs_held: 0,
      transcripts: 0,
      state_files: 0,
      bytes_in: 0,
      bytes_out: 0,
      removed: 0,
      duplicates_removed: 0,
      verify_failures: 0,
    });
    if (!birthInFlight) {
      if (!this.birthsUnknownLogged)
        this.log("archive: session births are not observable here — no per-PR file is moved");
      this.birthsUnknownLogged = true;
      this.files = blank("held", "births_unknown");
      return { failure: null, hold: null };
    }
    const plan = this.plan;
    const queue = plan
      ? [...plan.candidates.map((c) => c.pr), ...plan.empty].filter(
          (pr) => !this.doneSincePlan.has(pr),
        )
      : [];
    if (queue.length === 0) {
      this.files = blank("none", null);
      return { failure: null, hold: null };
    }
    // An UNKNOWN load reading runs at the minimum: one PR, half the rate.
    const { maxPrs, bytesPerS } = this.fileRate();
    const meter = new SpanMeter();
    let listing: Awaited<ReturnType<typeof listLiveTree>>;
    try {
      listing = await listLiveTree(this.deps.root, this.deps.sessionsRoot, meter);
    } catch (err) {
      if (this.abort.signal.aborted) throw err;
      this.files = blank("failed", null);
      return {
        failure: `archive files: the live tree could not be listed: ${(err as Error).message}`,
        hold: null,
      };
    }
    const run = blank("done", null);
    let hold: ArchiveHoldReason | null = null;
    for (const pr of queue) {
      const owed = this.recoveryOwed.get(pr);
      if (owed !== undefined) {
        // Its crash recovery failed: nothing of it moves until that succeeds.
        this.fileHeld.set(pr, "recovery_failed");
        this.doneSincePlan.add(pr);
        continue;
      }
      const stop = this.fileStop(at);
      if (stop) {
        run.outcome =
          stop === "budget" ? "budget" : stop === "restore_pending" ? "yielded" : "held";
        run.held_reason = stop;
        if (isHoldReason(stop)) hold = stop;
        break;
      }
      if (run.prs_started >= maxPrs) break;
      run.prs_started += 1;
      let r: PrPassResult;
      try {
        r = await archivePr(
          {
            store: this.deps.store,
            root: this.deps.root,
            sessionsRoot: this.deps.sessionsRoot,
            listing,
            now: this.now,
            afterDays: this.policy.afterDays,
            level: this.policy.gzipLevel,
            bytesPerS,
            signal: this.abort.signal,
            outside: (n) => this.outsideFacts(n),
            birthInFlight,
            diskFor: (bytes) => this.diskFor(bytes),
            stopReason: () => this.fileStop(at),
            verifyFailed: (key, detail) => this.raiseQuiet(key, detail),
            log: this.log,
            meter,
            ...(this.deps.step ? { step: this.deps.step } : {}),
          },
          pr,
        );
      } catch (err) {
        if (this.abort.signal.aborted) throw err;
        // One PR's I/O failure is that PR's: its row stays `archiving` (the
        // guard armed) and the next plan offers it again.
        this.log(`archive: pr-${pr} pass failed`, err);
        this.fileHeld.set(pr, "error");
        this.doneSincePlan.add(pr);
        run.prs_held += 1;
        continue;
      }
      run.transcripts += r.transcripts;
      run.state_files += r.stateFiles;
      run.bytes_in += r.bytesIn;
      run.bytes_out += r.bytesOut;
      run.removed += r.removed;
      run.duplicates_removed += r.duplicatesRemoved;
      run.verify_failures += r.verifyFailures;
      if (r.outcome === "archived") {
        run.prs_archived += 1;
        this.doneSincePlan.add(pr);
        this.fileHeld.delete(pr);
        const plannedPr = plan?.candidates.find((c) => c.pr === pr);
        this.filesSincePlan.prs += 1;
        this.filesSincePlan.bytes += plannedPr?.bytes ?? 0;
        if (r.removed + r.duplicatesRemoved + r.transcripts + r.stateFiles > 0)
          this.deps.store.logEvent("archive_pr_archived", pr, {
            transcripts: r.transcripts,
            reused: r.reused,
            state_files: r.stateFiles,
            bytes_in: r.bytesIn,
            bytes_out: r.bytesOut,
            removed: r.removed,
            duplicates_removed: r.duplicatesRemoved,
            stale_inject: r.staleInjects,
          });
      } else if (r.outcome === "held") {
        run.prs_held += 1;
        this.fileHeld.set(pr, r.reason ?? "held");
        this.doneSincePlan.add(pr);
      } else if (r.reason === "disk_low" && this.headroomHolds()) {
        // The mounts have their headroom, just not room for THIS PR's next
        // file: that PR waits (held disk_low, the wake raised once for the
        // incident) and the phase goes on to the next PR — one large file
        // never stops every other PR's smaller ones.
        run.prs_partial += 1;
        this.fileHeld.set(pr, "disk_low");
        this.doneSincePlan.add(pr);
      } else {
        run.prs_partial += 1;
        // Stopped by the tick (budget, a hold, a restore): resumed next tick.
        // Stopped by the PR itself (a verify failure, a changed source): the
        // next plan offers it again.
        if (
          !["budget", "stopping", "restore_pending"].includes(r.reason ?? "") &&
          !isHoldReason(r.reason ?? "")
        ) {
          this.fileHeld.set(pr, r.reason ?? "incomplete");
          this.doneSincePlan.add(pr);
        }
        if (r.reason && isHoldReason(r.reason)) {
          hold = r.reason;
          run.outcome = "held";
          run.held_reason = r.reason;
          break;
        }
      }
      await yieldToLoop();
    }
    this.maxSyncSpanMs = Math.max(this.maxSyncSpanMs ?? 0, Math.round(meter.max * 10) / 10);
    this.files = run;
    if (run.prs_started > 0) this.dbCache = null;
    if (run.removed + run.transcripts + run.state_files + run.duplicates_removed > 0)
      this.deps.store.logEvent("archive_pass", null, {
        phase: "files",
        outcome: run.outcome,
        prs_archived: run.prs_archived,
        prs_partial: run.prs_partial,
        prs_held: run.prs_held,
        transcripts: run.transcripts,
        state_files: run.state_files,
        bytes_in: run.bytes_in,
        bytes_out: run.bytes_out,
        removed: run.removed,
        duplicates_removed: run.duplicates_removed,
        verify_failures: run.verify_failures,
      });
    this.logTickLine(
      "files",
      `${run.outcome}:${run.held_reason ?? ""}:${run.prs_held}:${run.prs_partial}`,
      run.prs_archived + run.transcripts + run.state_files + run.removed + run.verify_failures > 0,
      `archive: files — ${run.prs_archived} PR(s) archived, ${run.prs_partial} partial, ${run.prs_held} held; ` +
        `${run.transcripts} transcript(s), ${run.state_files} state file(s), ${run.removed} removed` +
        (run.duplicates_removed ? `, ${run.duplicates_removed} legacy duplicate(s) removed` : "") +
        (run.verify_failures ? `, ${run.verify_failures} VERIFY FAILURE(S)` : "") +
        ` (${run.outcome}${run.held_reason ? `: ${run.held_reason}` : ""})`,
    );
    return { failure: null, hold };
  }

  /** Log a per-tick line only when work was done or its shape changed. */
  private logTickLine(phase: string, shape: string, worked: boolean, line: string): void {
    if (!worked && this.lastTickLine.get(phase) === shape) return;
    this.lastTickLine.set(phase, shape);
    this.log(line);
  }

  /** The rate the file work runs at: an UNKNOWN load reading runs at the
   * minimum — one PR, half the MB/s (§10). */
  private fileRate(): { maxPrs: number; bytesPerS: number } {
    let load: DaemonLoadStatus | undefined;
    try {
      load = this.deps.load?.();
    } catch {
      load = undefined;
    }
    const unknown = !load || load.event_loop?.state !== "ok" || load.cpu?.state !== "measured";
    return unknown
      ? { maxPrs: 1, bytesPerS: Math.max(1, Math.floor(this.policy.maxBytesPerS / 2)) }
      : { maxPrs: this.policy.maxPrsPerTick, bytesPerS: this.policy.maxBytesPerS };
  }

  /**
   * The stores that belong to no PR (§5): the overseer's non-current
   * transcripts, then pi's global store — each only when wired, under the
   * tick's budget, holds and disk checks. Returns the hold that stopped it,
   * or null. One store's I/O failure is that store's (`failed`, retried next
   * tick); it never fails the tick.
   */
  private async storesPhase(at: Date): Promise<ArchiveHoldReason | null> {
    const passes: Array<{
      key: "overseer" | "pi_global";
      run: (common: StoreCommon) => Promise<StorePassResult>;
    }> = [];
    const bornAt = this.deps.overseerBornAt;
    if (bornAt)
      passes.push({
        key: "overseer",
        run: (common) =>
          archiveOverseer({
            ...common,
            root: this.deps.root,
            sessionsRoot: this.deps.sessionsRoot,
            bornAt,
          }),
      });
    const piGlobalDir = this.deps.piGlobalDir;
    if (piGlobalDir)
      passes.push({
        key: "pi_global",
        run: (common) =>
          archivePiGlobal({ ...common, root: this.deps.root, storeDir: piGlobalDir }),
      });
    const meter = new SpanMeter();
    const fold = (): void => {
      if (meter.max > 0)
        this.maxSyncSpanMs = Math.max(this.maxSyncSpanMs ?? 0, Math.round(meter.max * 10) / 10);
    };
    for (const p of passes) {
      const stop = this.fileStop(at);
      if (stop) {
        fold();
        return isHoldReason(stop) ? stop : null;
      }
      const startedAt = this.now().toISOString();
      const common: StoreCommon = {
        now: this.now,
        level: this.policy.gzipLevel,
        bytesPerS: this.fileRate().bytesPerS,
        signal: this.abort.signal,
        diskFor: (bytes) => this.diskFor(bytes),
        stopReason: () => this.fileStop(at),
        verifyFailed: (key, detail) => this.raiseQuiet(key, detail),
        log: this.log,
        // Every synchronous span over the store's manifest (its shards'
        // parses, the index, each write's copy, check and stringify).
        meter,
        settle: !this.storesSettled.has(p.key),
        ...(this.deps.step ? { step: this.deps.step } : {}),
      };
      let r: StorePassResult;
      try {
        r = await p.run(common);
      } catch (err) {
        if (this.abort.signal.aborted) throw err;
        this.log(`archive: the ${p.key} store's pass failed`, err);
        r = emptyStoreResult("failed", (err as Error).message);
      }
      if (r.outcome !== "held" && r.outcome !== "failed") this.storesSettled.add(p.key);
      if (r.duplicatesRemoved > 0)
        bumpMark(this.deps.store, "duplicates.removed", r.duplicatesRemoved);
      this.stores[p.key] = {
        last_run_at: startedAt,
        outcome: r.outcome,
        reason: r.reason,
        archived: r.archived,
        bytes_in: r.bytesIn,
        bytes_out: r.bytesOut,
        removed: r.removed,
        duplicates_removed: r.duplicatesRemoved,
        verify_failures: r.verifyFailures,
        kept_live: r.keptLive,
      };
      if (r.archived + r.removed + r.duplicatesRemoved > 0) {
        this.dbCache = null;
        this.deps.store.logEvent("archive_pass", null, {
          phase: p.key === "overseer" ? OVERSEER_STORE : "pi-global",
          outcome: r.outcome,
          archived: r.archived,
          bytes_in: r.bytesIn,
          bytes_out: r.bytesOut,
          removed: r.removed,
          duplicates_removed: r.duplicatesRemoved,
          verify_failures: r.verifyFailures,
        });
      }
      if (r.outcome !== "none")
        this.logTickLine(
          `store:${p.key}`,
          `${r.outcome}:${this.stores[p.key]?.reason ?? ""}`,
          r.archived + r.removed + r.duplicatesRemoved + r.verifyFailures > 0,
          `archive: ${storePhraseOf(p.key, this.stores[p.key])}`,
        );
      // A hold ends the tick — except one file too large for the archive
      // mount while both mounts keep their headroom: that store waits (its
      // status says disk_low, the wake was raised once for the incident) and
      // the next store goes on, as one large PR file never stops the others.
      if (
        r.reason &&
        isHoldReason(r.reason) &&
        !(r.reason === "disk_low" && this.headroomHolds())
      ) {
        fold();
        return r.reason;
      }
      await yieldToLoop();
    }
    fold();
    return null;
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
    if (this.mutex.priorityWaiting()) return "restore_pending";
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
    this.dbRoomHold = null;
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
      room: async () => (this.dbRoomHold = await this.checkDisk()),
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
        r.skipped_reason === "checkpoint_failed"
          ? `archive: db run STOPPED (checkpoint_failed) after its last batch — the rows it moved stay moved, the live automatic checkpoint is back on; the next tick retries: ${r.error}`
          : `archive: db batch SKIPPED (${r.skipped_reason}) — nothing deleted; the next tick retries: ${r.error}`,
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
        live_checkpoints: r.live_checkpoints,
        live_checkpoint_max_ms: r.live_checkpoint_max_ms,
      });
    this.logTickLine(
      "db",
      `${r.outcome}:${r.skipped_reason ?? ""}`,
      r.events.moved + r.deliveries.moved + undatable + r.live_checkpoints > 0,
      `archive: db — ${r.events.moved} event / ${r.deliveries.moved} delivery row(s) moved ` +
        `(${r.outcome}${r.skipped_reason ? `: ${r.skipped_reason}` : ""}); ` +
        `${r.sync_ms} ms synchronous, longest ${r.max_span_ms} ms; next batch ${r.batch_rows} rows` +
        (r.live_checkpoints > 0
          ? `; ${r.live_checkpoints} live checkpoint(s) off the loop, longest ${r.live_checkpoint_max_ms} ms`
          : "") +
        (undatable > 0 ? `; ${undatable} undatable row(s) kept live` : ""),
    );
  }

  /** Seal the months whose rows can no longer arrive (§9.5). A seal the rule
   * or a check refuses is reported and retried later; only an unexpected
   * failure fails the tick. */
  private async sealPhase(): Promise<string | null> {
    this.sealRoomHold = null;
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
        roomFor: async (bytes) => (this.sealRoomHold = await this.checkDisk(bytes)),
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
      const line = `archive: ${r.file} not sealed (${r.outcome}): ${r.detail ?? ""}`;
      // A month waiting for room says so once, not every tick.
      if (r.outcome === "held") this.logTickLine(`seal:${r.file}`, line, false, line);
      else this.log(line);
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
      ...(this.deps.overseerBornAt ? { overseerBornAt: this.deps.overseerBornAt } : {}),
      ...(this.deps.piGlobalDir ? { piGlobalDir: this.deps.piGlobalDir } : {}),
      memo: this.memo,
      signal,
    });
  }

  /**
   * Free space on both mounts against the headroom — plus, for a file about
   * to be archived, its size on the archive mount (§7.7); records the
   * reading. A failed statfs is UNKNOWN (a hold, never a guess). In mode `on`
   * a low reading is the `archive_disk_low` wake, once per incident (the
   * incident ends at the first reading with room for what raised it) and
   * again every ANOMALY_REPEAT_MS while it lasts.
   */
  private async checkDisk(fileBytes = 0): Promise<"disk_low" | "disk_unknown" | null> {
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
    const low = archiveFree < fileBytes + headroom || stateFree < headroom;
    if (this.policy.mode === "on")
      this.noteDisk(low, { archiveFree, stateFree, headroom, fileBytes });
    return low ? "disk_low" : null;
  }

  private noteDisk(
    low: boolean,
    r: { archiveFree: number; stateFree: number; headroom: number; fileBytes: number },
  ): void {
    const nowMs = this.now().getTime();
    const need = r.fileBytes + r.headroom;
    if (!low) {
      // An incident ends only at a reading with room for what raised it. A
      // reading that tested less — the tick's headroom-only check, or a
      // smaller file — says nothing about the file that did not fit, and
      // ending the incident on it would re-raise the wake every tick.
      if (this.diskIncident && r.archiveFree >= this.diskIncident.need) {
        this.log("archive: free disk is back above the headroom");
        this.diskIncident = null;
      }
      return;
    }
    if (this.diskIncident) {
      this.diskIncident.need = Math.max(this.diskIncident.need, need);
      if (nowMs - this.diskIncident.raisedAt < ANOMALY_REPEAT_MS) return;
    }
    this.diskIncident = {
      since: this.diskIncident?.since ?? nowMs,
      raisedAt: nowMs,
      need: Math.max(this.diskIncident?.need ?? 0, need),
    };
    const detail =
      `archive held: free disk below the headroom — archive mount ${r.archiveFree} B free` +
      (r.fileBytes > 0 ? ` (a ${r.fileBytes} B file needs ${r.fileBytes + r.headroom})` : "") +
      `, state mount ${r.stateFree} B free, headroom ${r.headroom} B. No file is started until there is room.`;
    try {
      this.deps.store.logAnomaly("archive_disk_low", null, null, detail);
    } catch (err) {
      this.log("archive: could not raise archive_disk_low", err);
    }
  }

  /** A WAKE kind, once per incident (`key`) and again only after
   * ANOMALY_REPEAT_MS. */
  private raiseWake(kind: string, pr: number | null, key: string, detail: string): void {
    const nowMs = this.now().getTime();
    const last = this.raised.get(key);
    if (last !== undefined && nowMs - last < ANOMALY_REPEAT_MS) {
      this.log(`archive: ${detail} (${kind} already raised for ${key})`);
      return;
    }
    this.raised.set(key, nowMs);
    try {
      this.deps.store.logAnomaly(kind, pr, null, detail);
    } catch (err) {
      this.log(`archive: could not raise ${kind}`, err);
    }
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
            prs: Math.max(0, plan.backlog.prs - this.filesSincePlan.prs),
            bytes: Math.max(0, plan.backlog.bytes - this.filesSincePlan.bytes),
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
      held_prs: plan ? this.heldPrs(plan) : null,
      orphans: plan ? { count: plan.orphans.length, first: plan.orphans.slice(0, 20) } : null,
      freelist_pages: db.freelist,
      max_sync_span_ms: this.maxSyncSpanMs,
      db: this.db ? { ...this.db } : null,
      files: this.files ? { ...this.files } : null,
      stores: {
        overseer: this.stores.overseer ? { ...this.stores.overseer } : null,
        pi_global: this.stores.pi_global ? { ...this.stores.pi_global } : null,
      },
    };
  }

  /** The plan's held PRs, and the planned ones whose own pass was held. */
  private heldPrs(plan: ArchivePlan): NonNullable<ArchiveStatus["held_prs"]> {
    const all = new Map<number, string>(plan.held.map((h) => [h.pr, h.reason]));
    for (const [pr, reason] of this.fileHeld) all.set(pr, reason);
    const list = [...all].sort((a, b) => a[0] - b[0]);
    return { count: list.length, first: list.slice(0, 20).map(([pr, reason]) => ({ pr, reason })) };
  }
}

/** What every store pass is handed by the archiver. */
type StoreCommon = Omit<import("./storepass.js").StorePassDeps, "dir" | "subject" | "liveOf">;

/** A store's last pass, for the log. */
function storePhraseOf(key: "overseer" | "pi_global", st: ArchiveStoreStatus | null): string {
  if (!st) return `${key}: not run`;
  return (
    `${key === "overseer" ? "overseer store" : "pi-global store"} — ${st.archived} archived, ${st.removed} removed` +
    (st.duplicates_removed ? `, ${st.duplicates_removed} legacy duplicate(s) removed` : "") +
    (st.verify_failures ? `, ${st.verify_failures} VERIFY FAILURE(S)` : "") +
    `, ${st.kept_live} kept live (${st.outcome}${st.reason ? `: ${st.reason}` : ""})`
  );
}

const HOLD_REASONS: ReadonlySet<string> = new Set([
  "draining",
  "loop_stalled",
  "cpu_starved",
  "disk_low",
  "disk_unknown",
]);
const isHoldReason = (r: string): r is ArchiveHoldReason => HOLD_REASONS.has(r);

/** Wait for `p`, but never longer than `ms` (a real, unref'd timer). */
async function waitAtMost(p: Promise<unknown>, ms: number): Promise<void> {
  if (!(ms > 0)) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    p.then(
      () => undefined,
      () => undefined,
    ),
    new Promise<void>((resolveWait) => {
      timer = setTimeout(resolveWait, ms);
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
}

/** Wait for `p`, but never longer than `ms`: its value, or `done: false`. */
async function raceTimeout<T>(
  p: Promise<T>,
  ms: number,
): Promise<{ done: true; value: T } | { done: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p.then((value) => ({ done: true as const, value })),
      new Promise<{ done: false }>((resolveWait) => {
        timer = setTimeout(() => resolveWait({ done: false }), Math.max(0, ms));
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

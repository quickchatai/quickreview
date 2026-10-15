// The DB MOVER (docs/archiving.md §9.1–§9.4): the reader-less event
// kinds older than `events_after_days` and the webhook deliveries older than
// `after_days` leave the live state.db for the month's archive database.
// Nothing is deleted that is not first proven present, byte for byte, in the
// archive — and made durable there.
//
// It walks ROWID WINDOWS from a watermark (`archive_marks`): never a
// kind-filtered batch (the index is (kind, pr, id), so one costs ~250 ms
// whatever its size) and never a `MAX(id) WHERE ts < …` cut-off (a full scan).
// Each window — 100..2000 rows, starting at `db_batch_rows` and adapted so
// every synchronous call stays ≤ `SPAN_TARGET_MS` — is one batch:
//
//   1. live SELECT of the window; the archivable rows older than the cut-off
//      are grouped by their UTC month;
//   2. per month, on the archiver's own connection: BEGIN IMMEDIATE; INSERT OR
//      IGNORE; COMMIT (busy_timeout 0 — a held lock fails the batch at once);
//   3. `await` an fsync of that file's `-wal` (the durability barrier, on the
//      threadpool);
//   4. every row read back from the archive and compared with the live row,
//      column by column — any absent or different row stops the batch with
//      nothing deleted;
//   5. live BEGIN IMMEDIATE: DELETE exactly those ids (a count that differs
//      rolls it back), upsert `archived_event_counts` (events) or the archived
//      count (deliveries), add to the file's running totals, advance the
//      watermark; COMMIT;
//   6. a PASSIVE checkpoint past 16 MB of WAL, then an awaited fsync of the
//      file; the LIVE database's checkpoint, on its worker (below);
//      `yieldToLoop()`; a 100 ms pause, which that checkpoint runs inside.
//
// The live state.db's own WAL checkpoint never runs on the loop while the
// mover deletes. Before its first live delete a run turns the daemon
// connection's `wal_autocheckpoint` off (restored when the run ends, and by
// `release()` from the archiver's stop()), and after every batch that deleted
// it awaits a PASSIVE checkpoint on a worker thread with its own connection
// under `synchronous = NORMAL` (`livecheckpoint.ts`): the WAL synced before
// any page is copied, the database file synced before the WAL may restart —
// SQLite's own protocol, off the loop. Left on, the automatic checkpoint
// fsyncs the whole database file inside a commit every ~4 MB of WAL — tens of
// milliseconds on the loop, a cost no batch size bounds. A checkpointer
// that cannot start or fails stops the run (`checkpoint_unavailable`,
// `checkpoint_failed`) with the setting restored — never a run that deletes
// with the WAL unbounded or the checkpoint back on the loop. An in-memory
// store has no WAL and none of this.
//
// A crash anywhere leaves a row in both places, never in neither: the re-run's
// INSERT OR IGNORE and id-exact delete converge. A refusal confined to one
// table's rows (its month file locked, a row read back different, a delete
// that did not match) skips THAT table and lets the other one run; a locked
// state.db or a failed fsync stops the run. A live column the archive file
// lacks (a later migration) is added to it before the batch, never a wedge.
// The scan stops after the first window that holds a row younger than the
// cut-off (§9.2); the watermark never passes such a row, so it is read again
// once it has aged. An undatable row is passed over and kept live (never
// archived on a guess, never a wedge). A delivery that holds the table's
// highest rowid is never moved: without AUTOINCREMENT SQLite would hand its
// rowid to the next delivery, which the watermark would then skip.
//
// At most `DB_SYNC_BUDGET_MS` of synchronous time per run, measured; the run
// also stops at the wall budget, on a hold, and on the archiver's stop().
// VACUUM is never run — deleted pages go to the freelist and are reused.
import type Database from "better-sqlite3";
import { performance } from "node:perf_hooks";
import type { StateStore } from "../state.js";
import { yieldToLoop } from "../yieldloop.js";
import {
  CHECKPOINT_WAL_BYTES,
  dayOf,
  isBusy,
  monthOf,
  quoteIdent as q,
  tsMs,
  type ArchiveConn,
  type ArchiveDb,
} from "./archivedb.js";
import { ARCHIVE_EVENT_KINDS } from "./kinds.js";
import { workerCheckpointer, type LiveCheckpointer } from "./livecheckpoint.js";
import { bumpMark } from "./rows.js";

const DAY_MS = 86_400_000;

/** Every synchronous call is kept at or under this (§9.2). */
export const SPAN_TARGET_MS = 25;
export const MIN_BATCH_ROWS = 100;
export const MAX_BATCH_ROWS = 2000;
/** Synchronous time a run may spend, in total (§9.2, §10). */
export const DB_SYNC_BUDGET_MS = 2000;
/** The pause after every batch. */
export const BATCH_PAUSE_MS = 100;

/** How a row's timestamp reads against a cut-off. */
export type RowAge = "old" | "young" | "undatable";

export function rowAge(ts: unknown, cutoffMs: number): RowAge {
  const t = tsMs(ts);
  if (t === null) return "undatable";
  return t < cutoffMs ? "old" : "young";
}

/**
 * What the mover does with one row — the rule the planner counts by too, so
 * its backlog is what the mover will move. `young` (younger than the cut-off,
 * or the table's highest rowid with `keepNewest`) ends the scan after its
 * window; `undatable` is passed over and kept live; `kept` is an event of a
 * kind with readers; `move` is an old row of an archivable kind.
 */
export function classifyRow(row: {
  rowid: number;
  /** The table's highest rowid when it never moves, else +Infinity. */
  newest: number;
  ts: unknown;
  cutoffMs: number;
  /** Filtered by kind (events): only `ARCHIVE_EVENT_KINDS` move. */
  byKind: boolean;
  kind: unknown;
}): RowAge | "kept" | "move" {
  const age = row.rowid >= row.newest ? "young" : rowAge(row.ts, row.cutoffMs);
  if (age !== "old") return age;
  if (row.byKind && !ARCHIVE_EVENT_KINDS.has(row.kind as string)) return "kept";
  return "move";
}

/** A mover watermark from `archive_marks`: every rowid ≤ it was examined (0
 * when absent or not a positive number). The mover resumes after it and the
 * planner counts from it. */
export function readWatermark(store: StateStore, name: string): number {
  const row = store.db.prepare("SELECT value FROM archive_marks WHERE name = ?").get(name) as
    { value: unknown } | undefined;
  const n = Number(row?.value ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** One table the mover empties of old rows. */
export interface MoveTable {
  table: "events" | "deliveries";
  tsCol: string;
  /** events: only `ARCHIVE_EVENT_KINDS` move. */
  kindCol: string | null;
  /** The watermark: every row with a rowid ≤ it has been examined. */
  mark: string;
  /** The cut-off the last run that reached every older row ran at. */
  caughtUpMark: string;
  /** A running count of rows moved, for tables without a rollup. */
  countMark: string | null;
  /** events: `archived_event_counts` per (kind, UTC day). */
  rollup: boolean;
  /** No AUTOINCREMENT: the row holding the highest rowid never moves. */
  keepNewest: boolean;
}

export const EVENTS_TABLE: MoveTable = {
  table: "events",
  tsCol: "ts",
  kindCol: "kind",
  mark: "events.last_id",
  caughtUpMark: "events.caught_up_to",
  countMark: null,
  rollup: true,
  keepNewest: false,
};

export const DELIVERIES_TABLE: MoveTable = {
  table: "deliveries",
  tsCol: "received_at",
  kindCol: null,
  mark: "deliveries.last_rowid",
  caughtUpMark: "deliveries.caught_up_to",
  countMark: "deliveries.archived_rows",
  rollup: false,
  keepNewest: true,
};

export const MOVE_TABLES: readonly MoveTable[] = [EVENTS_TABLE, DELIVERIES_TABLE];

/** The live mark that keeps a file's running total of rows moved into it —
 * the count sealing checks the file against. */
export const fileRowsMark = (file: string, table: string): string => `db.${file}.${table}.rows`;

/** Where a crash may be injected (tests): each throws, as a crash would. */
export type FaultPoint =
  | "after_archive_commit"
  | "after_fsync"
  | "after_verify"
  | "after_live_delete"
  | "before_watermark"
  | "after_live_commit";

/** Why a run stopped. */
export type MoveOutcome =
  | "caught_up" // every row older than the cut-off examined
  | "budget" // the synchronous or the wall budget ran out
  | "held" // a hold came up between batches
  | "aborted" // the archiver stopped
  | "skipped" // a lock or a check made a batch fail fast — that batch deleted nothing (earlier batches' moves stand)
  | "failed"; // something unexpected — nothing deleted past the last commit

export type SkipReason =
  | "archive_busy" // the month's file is locked (an analyst has it open)
  | "live_busy" // state.db's write lock was not had inside its busy timeout
  | "verify_mismatch" // a row read back from the archive differs, or is absent
  | "live_changed" // the live delete did not remove exactly the rows copied
  | "wal_sync_failed" // the archive's fsync failed
  | "checkpoint_unavailable" // the live checkpoint's worker could not start
  | "checkpoint_failed"; // a live checkpoint failed or timed out

/** Refusals confined to one table's rows: the other table still runs. */
const CONFINED: ReadonlySet<SkipReason> = new Set([
  "archive_busy",
  "verify_mismatch",
  "live_changed",
]);

/** One table's batch that a lock or a check refused (nothing deleted). */
export interface MoveSkip {
  table: "events" | "deliveries";
  reason: SkipReason;
  /** The archive file the refusal concerns, when it concerns one. */
  file: string | null;
  error: string;
}

export interface TableMove {
  moved: number;
  examined: number;
  batches: number;
  caught_up: boolean;
  /** Rows passed over because their timestamp cannot be read: kept live. */
  undatable: number;
}

export interface BatchReport {
  table: string;
  rows: number;
  moved: number;
  /** The longest synchronous call of the batch, ms. */
  max_span_ms: number;
  /** The batch size the NEXT batch will use. */
  next_batch_rows: number;
}

export interface DbMoveResult {
  outcome: MoveOutcome;
  /** The first skip's reason (every skip is in `skips`). */
  skipped_reason: SkipReason | null;
  error: string | null;
  /** Every table batch refused this run, in order. */
  skips: MoveSkip[];
  events: TableMove;
  deliveries: TableMove;
  /** Synchronous time spent, in total. */
  sync_ms: number;
  max_span_ms: number;
  batch_rows: number;
  /** Rows the verify found absent or different (a verify failure). */
  verify_mismatches: number;
  /** The live database's checkpoints this run ran on their worker, and the
   * longest (the worker's time — never a synchronous span of the loop). */
  live_checkpoints: number;
  live_checkpoint_max_ms: number;
}

export interface DbMoverDeps {
  store: StateStore;
  adb: ArchiveDb;
  now: () => Date;
  eventsAfterDays: number;
  afterDays: number;
  /** The starting batch size (`[archive] db_batch_rows`). */
  batchRows: number;
  syncBudgetMs?: number;
  /** No batch is started once this much wall time has passed. */
  wallBudgetMs?: number;
  /** The span clock (default `performance.now`) — a seam for tests. */
  clock?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  /** Re-checked before every batch: a reason stops the run (`held`). */
  hold?: () => string | null;
  /** The disk, re-read (awaited) before every batch: a reason — no room, or
   * a reading that failed — stops the run (`held`) like `hold`. */
  room?: () => Promise<string | null>;
  /** Past this much archive WAL a PASSIVE checkpoint runs (default
   * `CHECKPOINT_WAL_BYTES`) — a seam for tests. */
  checkpointWalBytes?: number;
  /** The live database's checkpointer, off the loop. Default: a worker thread
   * over `store.path` when the store is a WAL file, none for an in-memory
   * store. `null` = none (the daemon connection's own automatic checkpoint
   * stays on) — a seam for tests. */
  liveCheckpointer?: (() => LiveCheckpointer) | null;
  /** Tests: a crash at a point. */
  fault?: (point: FaultPoint, table: string) => void;
  onBatch?: (b: BatchReport) => void;
  log?: (msg: string, extra?: unknown) => void;
}

/** An abortable, unref'd pause. */
export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    t.unref?.();
    const onAbort = (): void => {
      clearTimeout(t);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** A table's columns and, when it has one, its INTEGER PRIMARY KEY (the
 * rowid's alias). */
interface Shape {
  cols: string[];
  alias: string | null;
}

function shapeOf(db: Database.Database, table: string): Shape {
  const info = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
    type: string;
    pk: number;
  }>;
  const pks = info.filter((c) => c.pk > 0);
  const alias = pks.length === 1 && pks[0]!.type.toUpperCase() === "INTEGER" ? pks[0]!.name : null;
  return { cols: info.map((c) => c.name), alias };
}

/** SQLite values compared as they came back from the same schema. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Buffer.isBuffer(a) && Buffer.isBuffer(b)) return a.equals(b);
  if (typeof a === "number" && typeof b === "number") return Number.isNaN(a) && Number.isNaN(b);
  return false;
}

class Stop extends Error {
  constructor(
    readonly outcome: MoveOutcome,
    readonly reason: SkipReason | null,
    message: string,
    readonly file: string | null = null,
  ) {
    super(message);
  }
}

const emptyMove = (): TableMove => ({
  moved: 0,
  examined: 0,
  batches: 0,
  caught_up: false,
  undatable: 0,
});

/**
 * The mover. One instance lives as long as the archiver, so the adapted batch
 * size carries over from run to run.
 */
export class DbMover {
  batchRows: number;
  private readonly clock: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** While a run deletes: the live checkpointer and the daemon connection's
   * `wal_autocheckpoint` to put back. */
  private armed: { checkpointer: LiveCheckpointer; autocheckpoint: number } | null = null;

  constructor(private readonly deps: DbMoverDeps) {
    this.batchRows = clampBatch(deps.batchRows);
    this.clock = deps.clock ?? (() => performance.now());
    this.sleep = deps.sleep ?? defaultSleep;
  }

  /**
   * Put the daemon connection's automatic checkpoint back and close the live
   * checkpointer. Synchronous and idempotent: the end of every run, and the
   * archiver's stop() — the daemon may close the store right after it.
   */
  release(): void {
    const a = this.armed;
    if (!a) return;
    this.armed = null;
    try {
      if (this.deps.store.db.open)
        this.deps.store.db.pragma(`wal_autocheckpoint = ${a.autocheckpoint}`);
    } catch (err) {
      this.deps.log?.("archive: could not restore the live wal_autocheckpoint", err);
    }
    void a.checkpointer.close().catch(() => {});
  }

  /** The live checkpointer this store gets: none for a database without a
   * WAL (an in-memory store), the worker for a WAL file. */
  private liveFactory(): (() => LiveCheckpointer) | null {
    if (this.deps.liveCheckpointer !== undefined) return this.deps.liveCheckpointer;
    const { store } = this.deps;
    if (store.path === ":memory:" || store.path === "") return null;
    try {
      if (store.db.pragma("journal_mode", { simple: true }) !== "wal") return null;
    } catch {
      return null;
    }
    return () => workerCheckpointer(store.path);
  }

  /**
   * Before a run's first live delete: the checkpointer up, then the daemon
   * connection's automatic checkpoint off (§9.3, Build notes). A checkpointer
   * that cannot start stops the run before anything is deleted.
   */
  private async armLive(): Promise<void> {
    if (this.armed) return;
    const factory = this.liveFactory();
    if (!factory) return;
    const checkpointer = factory();
    try {
      await checkpointer.ready();
    } catch (err) {
      void checkpointer.close().catch(() => {});
      this.checkAborted();
      throw new Stop(
        "skipped",
        "checkpoint_unavailable",
        `the live checkpoint could not run off the loop (${(err as Error).message}) — nothing deleted`,
      );
    }
    if (this.deps.signal?.aborted) {
      void checkpointer.close().catch(() => {});
      throw new Stop("aborted", null, "stopped");
    }
    const live = this.deps.store.db;
    const was = Number(live.pragma("wal_autocheckpoint", { simple: true }));
    live.pragma("wal_autocheckpoint = 0");
    this.armed = { checkpointer, autocheckpoint: Number.isFinite(was) ? was : 1000 };
  }

  /** The live checkpoint after a batch, on its worker; never rejects (the
   * error, or null). */
  private checkpointLive(result: DbMoveResult): Promise<string | null> {
    const a = this.armed;
    if (!a) return Promise.resolve(null);
    return a.checkpointer.checkpoint().then(
      (r) => {
        result.live_checkpoints += 1;
        result.live_checkpoint_max_ms = Math.max(result.live_checkpoint_max_ms, r.ms);
        return null;
      },
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );
  }

  /** A failed live checkpoint stops the run (the setting is restored as it
   * unwinds) — never another delete with nothing checkpointing the WAL. */
  private liveCheckpointed(error: string | null): void {
    this.checkAborted();
    if (error !== null) throw new Stop("skipped", "checkpoint_failed", error);
  }

  /** One run: events, then deliveries, inside one budget. Never rejects. */
  async run(): Promise<DbMoveResult> {
    const started = this.clock();
    const result: DbMoveResult = {
      outcome: "caught_up",
      skipped_reason: null,
      error: null,
      skips: [],
      events: emptyMove(),
      deliveries: emptyMove(),
      sync_ms: 0,
      max_span_ms: 0,
      batch_rows: this.batchRows,
      verify_mismatches: 0,
      live_checkpoints: 0,
      live_checkpoint_max_ms: 0,
    };
    let batchMax = 0;
    const meter = {
      measure: <T>(fn: () => T): T => {
        const t0 = this.clock();
        try {
          return fn();
        } finally {
          const d = this.clock() - t0;
          result.sync_ms += d;
          if (d > result.max_span_ms) result.max_span_ms = d;
          batchMax = Math.max(batchMax, d);
        }
      },
    };
    const skip = (spec: MoveTable, err: Stop): void => {
      result.skips.push({
        table: spec.table,
        reason: err.reason!,
        file: err.file,
        error: err.message,
      });
    };
    let at: MoveTable | null = null;
    try {
      for (const spec of MOVE_TABLES) {
        at = spec;
        const into = spec.table === "events" ? result.events : result.deliveries;
        try {
          await this.moveTable(spec, into, result, meter, started, () => {
            const m = batchMax;
            batchMax = 0;
            return m;
          });
        } catch (err) {
          // Confined to this table's rows: record it, and the next table runs.
          if (
            err instanceof Stop &&
            err.outcome === "skipped" &&
            err.reason &&
            CONFINED.has(err.reason)
          ) {
            skip(spec, err);
            continue;
          }
          throw err;
        }
      }
      result.outcome = result.skips.length > 0 ? "skipped" : "caught_up";
    } catch (err) {
      if (err instanceof Stop) {
        if (err.outcome === "skipped" && err.reason && at) skip(at, err);
        result.outcome =
          err.outcome === "failed" || err.outcome === "aborted" || result.skips.length === 0
            ? err.outcome
            : "skipped";
        if (err.outcome === "failed") result.error = err.message;
      } else {
        result.outcome = "failed";
        result.error = err instanceof Error ? err.message : String(err);
      }
    } finally {
      this.release();
    }
    if (result.skips.length > 0) {
      result.skipped_reason = result.skips[0]!.reason;
      if (result.outcome !== "failed") result.error = result.skips.map((x) => x.error).join("; ");
    }
    result.batch_rows = this.batchRows;
    result.sync_ms = Math.round(result.sync_ms * 10) / 10;
    result.max_span_ms = Math.round(result.max_span_ms * 10) / 10;
    result.live_checkpoint_max_ms = Math.round(result.live_checkpoint_max_ms * 10) / 10;
    return result;
  }

  private checkStop(result: DbMoveResult, started: number): void {
    if (this.deps.signal?.aborted) throw new Stop("aborted", null, "stopped");
    const held = this.deps.hold?.() ?? null;
    if (held) throw new Stop("held", null, held);
    if (result.sync_ms >= (this.deps.syncBudgetMs ?? DB_SYNC_BUDGET_MS))
      throw new Stop("budget", null, "synchronous budget spent");
    if (this.deps.wallBudgetMs !== undefined && this.clock() - started >= this.deps.wallBudgetMs)
      throw new Stop("budget", null, "wall budget spent");
  }

  private async moveTable(
    spec: MoveTable,
    into: TableMove,
    result: DbMoveResult,
    meter: { measure: <T>(fn: () => T) => T },
    started: number,
    takeBatchMax: () => number,
  ): Promise<void> {
    const live = this.deps.store.db;
    const days = spec.table === "events" ? this.deps.eventsAfterDays : this.deps.afterDays;
    const cutoffMs = this.deps.now().getTime() - days * DAY_MS;
    const cutoffIso = new Date(cutoffMs).toISOString();
    // Read every run (one PRAGMA): a shape cached across runs would outlive a
    // migration and leave a new column's values out of the copy.
    const shape = shapeOf(live, spec.table);
    const sel = `SELECT rowid, ${shape.cols.map(q).join(", ")} FROM ${spec.table} WHERE rowid > ? ORDER BY rowid LIMIT ?`;
    const select = live.prepare(sel).raw(true);
    const tsIdx = shape.cols.indexOf(spec.tsCol) + 1;
    const kindIdx = spec.kindCol ? shape.cols.indexOf(spec.kindCol) + 1 : -1;
    if (tsIdx <= 0 || (spec.kindCol && kindIdx <= 0))
      throw new Stop("failed", null, `${spec.table} has no ${spec.tsCol}/${spec.kindCol} column`);
    // The WATERMARK is the settled prefix: every row with a rowid ≤ it was
    // examined and is older than the cut-off (or undatable), so it is never
    // read again. The CURSOR is where the scan stands; it runs ahead of the
    // watermark past a young row inside a window, whose old rows still move.
    let persisted = readWatermark(this.deps.store, spec.mark);
    let watermark = persisted;
    let cursor = watermark;
    let prefixOpen = true;
    const newest = spec.keepNewest
      ? meter.measure(
          () =>
            (
              live.prepare(`SELECT MAX(rowid) AS m FROM ${spec.table}`).get() as {
                m: number | null;
              }
            ).m ?? 0,
        )
      : Number.POSITIVE_INFINITY;
    const persist = (caughtUp: boolean): void => {
      if (watermark === persisted && !caughtUp) return;
      meter.measure(() =>
        live
          .transaction(() => {
            if (watermark !== persisted) this.setMark(spec.mark, watermark);
            if (caughtUp) this.setMark(spec.caughtUpMark, cutoffIso);
          })
          .immediate(),
      );
      persisted = watermark;
    };

    for (;;) {
      try {
        this.checkStop(result, started);
        const noRoom = (await this.deps.room?.()) ?? null;
        if (noRoom) throw new Stop("held", null, noRoom);
        this.checkAborted();
      } catch (err) {
        // A budget or a hold keeps what the scan settled; a stop writes nothing.
        if (err instanceof Stop && err.outcome !== "aborted") this.persistQuietly(persist);
        throw err;
      }
      takeBatchMax();
      const rows = meter.measure(() => select.all(cursor, this.batchRows) as unknown[][]);
      // ---- classify the window ------------------------------------------------
      // The scan stops after the first window holding a row younger than the
      // cut-off (§9.2) — or the table's highest rowid, with `keepNewest`. Old
      // rows of an archivable kind move wherever they sit in the window; an
      // undatable row is passed over and kept live.
      let sawYoung = false;
      const moves: unknown[][] = [];
      for (const row of rows) {
        const rowid = row[0] as number;
        const what = classifyRow({
          rowid,
          newest,
          ts: row[tsIdx],
          cutoffMs,
          byKind: kindIdx > 0,
          kind: kindIdx > 0 ? row[kindIdx] : null,
        });
        if (what === "young") {
          sawYoung = true;
          prefixOpen = false;
          continue;
        }
        if (prefixOpen) watermark = rowid;
        if (what === "undatable") into.undatable += 1;
        else if (what === "move") moves.push(row);
      }
      into.examined += rows.length;
      if (rows.length > 0) cursor = rows[rows.length - 1]![0] as number;
      const stop = sawYoung || rows.length < this.batchRows;
      if (moves.length === 0) {
        if (stop) {
          this.persistOrSkip(persist, true);
          into.caught_up = true;
          return;
        }
        this.adapt(takeBatchMax());
        await yieldToLoop();
        continue;
      }

      // ---- 2–4: into the archive, durable, read back ---------------------------
      const byMonth = new Map<string, unknown[][]>();
      for (const row of moves) {
        const month = monthOf(row[tsIdx])!; // an old row is always datable
        const g = byMonth.get(month);
        if (g) g.push(row);
        else byMonth.set(month, [row]);
      }
      const byFile = new Map<string, { conn: ArchiveConn; rows: unknown[][] }>();
      for (const [month, group] of byMonth) {
        const conn = await this.target(month);
        byFile.set(conn.file, { conn, rows: group });
      }
      for (const { conn, rows: group } of byFile.values()) {
        this.checkAborted();
        meter.measure(() => this.insert(conn, spec.table, shape, group));
        this.deps.fault?.("after_archive_commit", spec.table);
        try {
          await conn.syncWal();
        } catch (err) {
          throw new Stop(
            "skipped",
            "wal_sync_failed",
            `${conn.file}: fsync of the WAL failed: ${(err as Error).message}`,
            conn.file,
          );
        }
        this.deps.fault?.("after_fsync", spec.table);
        this.checkAborted();
        const bad = meter.measure(() => this.verify(conn, spec.table, shape, group));
        if (bad > 0) {
          result.verify_mismatches += bad;
          throw new Stop(
            "skipped",
            "verify_mismatch",
            `${conn.file}: ${bad} of ${group.length} ${spec.table} row(s) read back absent or different — nothing deleted`,
            conn.file,
          );
        }
      }
      this.deps.fault?.("after_verify", spec.table);

      // ---- 5: the live delete, the rollup, the watermark — one transaction -----
      // The live checkpoint off the loop first (once per run).
      await this.armLive();
      this.checkAborted();
      const ids = JSON.stringify(moves.map((r) => r[0]));
      try {
        meter.measure(() =>
          live
            .transaction(() => {
              const info = live
                .prepare(
                  `DELETE FROM ${spec.table} WHERE rowid IN (SELECT value FROM json_each(?))`,
                )
                .run(ids);
              if (info.changes !== moves.length)
                throw new Stop(
                  "skipped",
                  "live_changed",
                  `${spec.table}: the delete removed ${info.changes} row(s), not the ${moves.length} copied — rolled back`,
                );
              this.deps.fault?.("after_live_delete", spec.table);
              if (spec.rollup) this.rollup(moves, tsIdx, kindIdx);
              if (spec.countMark) bumpMark(this.deps.store, spec.countMark, moves.length);
              for (const { conn, rows: group } of byFile.values())
                bumpMark(this.deps.store, fileRowsMark(conn.file, spec.table), group.length);
              this.deps.fault?.("before_watermark", spec.table);
              if (watermark !== persisted) this.setMark(spec.mark, watermark);
              if (stop) this.setMark(spec.caughtUpMark, cutoffIso);
            })
            .immediate(),
        );
      } catch (err) {
        if (err instanceof Stop) throw err;
        if (isBusy(err))
          throw new Stop("skipped", "live_busy", `state.db is locked: ${(err as Error).message}`);
        throw err;
      }
      persisted = watermark;
      this.deps.fault?.("after_live_commit", spec.table);
      into.moved += moves.length;
      into.batches += 1;

      // ---- 6: checkpoints; adapt; yield; pause --------------------------------
      // The live database's on its worker, from now — it runs while the
      // archive's is checked and inside the pause.
      const liveCk = this.checkpointLive(result);
      for (const { conn } of byFile.values()) await this.maybeCheckpoint(conn, meter);
      const worst = takeBatchMax();
      this.adapt(worst);
      this.deps.onBatch?.({
        table: spec.table,
        rows: rows.length,
        moved: moves.length,
        max_span_ms: worst,
        next_batch_rows: this.batchRows,
      });
      if (stop) {
        into.caught_up = true;
        this.liveCheckpointed(await liveCk);
        return;
      }
      await yieldToLoop();
      const [ckError] = await Promise.all([liveCk, this.sleep(BATCH_PAUSE_MS, this.deps.signal)]);
      this.liveCheckpointed(ckError);
    }
  }

  /** Persist the settled watermark on the way out of a budget or a hold; a
   * lock that refuses it only costs re-reading those rows next time. */
  private persistQuietly(persist: (caughtUp: boolean) => void): void {
    try {
      persist(false);
    } catch (err) {
      this.deps.log?.("archive: could not record the mover's watermark (re-read next run)", err);
    }
  }

  /** Persist at the end of the scan; a lock is a skip, never a throw. */
  private persistOrSkip(persist: (caughtUp: boolean) => void, caughtUp: boolean): void {
    try {
      persist(caughtUp);
    } catch (err) {
      if (isBusy(err))
        throw new Stop("skipped", "live_busy", `state.db is locked: ${(err as Error).message}`);
      throw err;
    }
  }

  private checkAborted(): void {
    if (this.deps.signal?.aborted) throw new Stop("aborted", null, "stopped");
  }

  private async target(month: string): Promise<ArchiveConn> {
    try {
      return await this.deps.adb.target(month);
    } catch (err) {
      if (isBusy(err))
        throw new Stop(
          "skipped",
          "archive_busy",
          `archive month ${month} is locked: ${(err as Error).message}`,
        );
      throw err;
    }
  }

  /** BEGIN IMMEDIATE; the table from the live DDL (and any column the live
   * table gained since); INSERT OR IGNORE; COMMIT. */
  private insert(conn: ArchiveConn, table: string, shape: Shape, rows: unknown[][]): void {
    const cols = shape.alias ? shape.cols : ["rowid", ...shape.cols];
    const sql = `INSERT OR IGNORE INTO ${table} (${cols.map((c) => (c === "rowid" ? c : q(c))).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`;
    try {
      conn.db
        .transaction(() => {
          conn.ensureTable(table, this.deps.store.db, shape.cols);
          const stmt = conn.db.prepare(sql);
          for (const row of rows) stmt.run(...(shape.alias ? row.slice(1) : row));
        })
        .immediate();
    } catch (err) {
      // A rolled-back CREATE TABLE must not stay remembered as made.
      conn.refreshTables();
      if (isBusy(err))
        throw new Stop(
          "skipped",
          "archive_busy",
          `${conn.file} is locked by another connection: ${(err as Error).message}`,
          conn.file,
        );
      throw err;
    }
  }

  /** Read every row back by rowid; the count of rows absent or different. */
  private verify(conn: ArchiveConn, table: string, shape: Shape, rows: unknown[][]): number {
    const got = conn.db
      .prepare(
        `SELECT rowid, ${shape.cols.map(q).join(", ")} FROM ${table} WHERE rowid IN (SELECT value FROM json_each(?))`,
      )
      .raw(true)
      .all(JSON.stringify(rows.map((r) => r[0]))) as unknown[][];
    const byId = new Map(got.map((r) => [r[0] as number, r]));
    let bad = 0;
    for (const want of rows) {
      const have = byId.get(want[0] as number);
      if (!have || have.length !== want.length || !want.every((v, i) => sameValue(v, have[i])))
        bad += 1;
    }
    return bad;
  }

  private rollup(rows: unknown[][], tsIdx: number, kindIdx: number): void {
    const counts = new Map<string, number>();
    for (const r of rows) {
      const key = `${r[kindIdx] as string}\u0000${dayOf(r[tsIdx])!}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const up = this.deps.store.db.prepare(
      `INSERT INTO archived_event_counts (kind, day, n) VALUES (?, ?, ?)
         ON CONFLICT(kind, day) DO UPDATE SET n = n + excluded.n`,
    );
    for (const [key, n] of counts) {
      const [kind, day] = key.split("\u0000") as [string, string];
      up.run(kind, day, n);
    }
  }

  private setMark(name: string, value: number | string): void {
    this.deps.store.db
      .prepare(
        `INSERT INTO archive_marks (name, value) VALUES (?, ?)
           ON CONFLICT(name) DO UPDATE SET value = excluded.value`,
      )
      .run(name, value);
  }

  /** Past `CHECKPOINT_WAL_BYTES`: PASSIVE checkpoint (a page copy, measured),
   * then an fsync of the database file before the WAL may restart. */
  private async maybeCheckpoint(
    conn: ArchiveConn,
    meter: { measure: <T>(fn: () => T) => T },
  ): Promise<void> {
    if ((await conn.walBytes()) < (this.deps.checkpointWalBytes ?? CHECKPOINT_WAL_BYTES)) return;
    meter.measure(() => conn.db.pragma("wal_checkpoint(PASSIVE)"));
    await conn.syncDb();
  }

  /** Halve past the target; grow by half when well under it. */
  private adapt(worstMs: number): void {
    if (worstMs > SPAN_TARGET_MS) this.batchRows = clampBatch(Math.floor(this.batchRows / 2));
    else if (worstMs < SPAN_TARGET_MS / 2)
      this.batchRows = clampBatch(Math.ceil(this.batchRows * 1.5));
  }
}

export const clampBatch = (n: number): number =>
  Math.min(MAX_BATCH_ROWS, Math.max(MIN_BATCH_ROWS, Math.round(n)));

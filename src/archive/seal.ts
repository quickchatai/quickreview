// SEALING an archive month (docs/archiving.md §9.5): a month's
// database stops taking rows and becomes one gzip file, verified before the
// SQLite file is removed.
//
// A month M is sealed only once BOTH cut-offs (events and deliveries) are
// past the end of M plus a day, BOTH movers have caught up to a cut-off past
// that edge (every older row examined), and both watermarks have reached the
// highest id the file holds. The day of margin is for a clock step: a row of
// M arriving after that is only possible if the clock jumped back by more
// than a day, and it then goes to `state-M-<k>.sqlite`, never into the gzip.
//
//   1. Row counts: every table counted in rowid windows (bounded synchronous
//      spans with a real turn between them) and checked against the running
//      totals the live delete transaction kept (`db.<file>.<table>.rows`).
//      A difference refuses the seal and counts as a verify failure.
//   2. `wal_checkpoint(TRUNCATE)` — small, because PASSIVE checkpoints ran all
//      along; an analyst holding the file makes it busy, and the seal waits
//      for a later tick.
//   3. Close the connection. The `-wal` must be gone or empty, and the file's
//      identity (dev, ino, size, mtime) is taken.
//   4. Stream it through the rate cap, a sha256 tap and gzip into
//      `<file>.gz.partial`; fsync.
//   5. Stream-decompress the partial: length and sha256 must equal the file's.
//      A mismatch deletes the partial and keeps the file.
//   6. The identity again (a change means the bytes hashed may not be the
//      bytes on disk: discard, keep the file).
//   7. Move to `<file>.gz` WITHOUT replacing anything there (a `.gz` already
//      in place is a conflict for a person, never overwritten), fsync the
//      directory, record the file in `archive/db/manifest.json` (rows, first
//      and last id and ts per table, sha256, sizes, sealed_at), and only THEN
//      unlink the SQLite file.
//
// Before any of it: the file must be on disk (a listed file that vanished is
// `missing` — held and reported, never recreated empty), and no `.gz` of it
// may exist yet. The row counts are checked against EVERY running total the
// live database keeps for the file, so a table the file should hold but does
// not is a mismatch, never a pass. The hold is re-read before each file.
//
// There is no `integrity_check` in the daemon: it is O(database) and
// synchronous. It is an offline step in the runbook.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { StateStore } from "../state.js";
import { yieldToLoop } from "../yieldloop.js";
import {
  existsOnDisk,
  isBusy,
  sealEdgeMs,
  type ArchiveDb,
  type DbFileEntry,
  type DbFileTable,
} from "./archivedb.js";
import { DELIVERIES_TABLE, EVENTS_TABLE, fileRowsMark, MOVE_TABLES } from "./dbmove.js";
import {
  PARTIAL_SUFFIX,
  fileDigest,
  fsyncDir,
  gunzipDigest,
  gzipFile,
  identityOf,
  renameNoReplace,
  sameIdentity,
  unlinkIfPresent,
} from "./fsutil.js";
import { identityOrNull } from "./gzfile.js";

const DAY_MS = 86_400_000;

/** Rows a counting window covers: a narrow scan, a few ms. */
export const SEAL_COUNT_WINDOW = 5_000;

export type SealOutcome =
  | "sealed"
  | "not_due" // a condition of the rule does not hold yet
  | "busy" // an analyst has the file: TRUNCATE could not run
  | "count_mismatch" // the file's rows differ from the running totals
  | "attached" // another connection keeps a non-empty WAL
  | "verify_failed" // the gzip round trip did not reproduce the file
  | "changed" // the file changed while it was being compressed
  | "missing" // the manifest lists it open, but it is not on disk: held, never recreated
  | "conflict" // a `.gz` of it is already on disk: nothing is replaced
  | "held"; // no room on the archive mount for its gzip (or the disk unread): it waits

/** The outcomes that need a person (the archiver raises the quiet
 * `archive_verify_failed` anomaly for each, once per incident). */
export const SEAL_PROBLEMS: ReadonlySet<SealOutcome> = new Set([
  "count_mismatch",
  "verify_failed",
  "missing",
  "conflict",
]);

export interface SealResult {
  file: string;
  outcome: SealOutcome;
  detail?: string;
  gz_file?: string;
  tables?: Record<string, DbFileTable>;
}

export interface SealDeps {
  store: StateStore;
  adb: ArchiveDb;
  now: () => Date;
  eventsAfterDays: number;
  afterDays: number;
  gzipLevel: number;
  maxBytesPerS: number;
  signal?: AbortSignal;
  clock?: () => number;
  /** Re-read before each file: a reason starts nothing more (§10). */
  hold?: () => string | null;
  /** Room for a gzip of `bytes` on the archive mount, the headroom kept
   * (§7.7): a reason starts no gzip — the file is `held` and sealing stops. */
  roomFor?: (bytes: number) => Promise<string | null>;
  /** Tests: runs after the gzip partial is written, before it is verified. */
  beforeVerify?: (partial: string) => Promise<void>;
  log?: (msg: string, extra?: unknown) => void;
}

function readMark(store: StateStore, name: string): unknown {
  const row = store.db.prepare("SELECT value FROM archive_marks WHERE name = ?").get(name) as
    { value: unknown } | undefined;
  return row?.value;
}

const markNumber = (store: StateStore, name: string): number => {
  const n = Number(readMark(store, name) ?? 0);
  return Number.isFinite(n) ? n : 0;
};

const markTime = (store: StateStore, name: string): number | null => {
  const v = readMark(store, name);
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

/**
 * The sealing rule for one open file — pure over what it is handed: why the
 * file may not be sealed yet, or null when it may.
 */
export function sealBlocker(input: {
  month: string;
  nowMs: number;
  eventsAfterDays: number;
  afterDays: number;
  /** The cut-off each mover last caught up to (null = never). */
  caughtUp: { events: number | null; deliveries: number | null };
  watermarks: { events: number; deliveries: number };
  /** The highest rowid the file holds per table (absent = no such table). */
  fileMaxIds: { events?: number | null; deliveries?: number | null };
}): string | null {
  const edge = sealEdgeMs(input.month);
  const eventsCut = input.nowMs - input.eventsAfterDays * DAY_MS;
  const deliveriesCut = input.nowMs - input.afterDays * DAY_MS;
  if (!(eventsCut > edge)) return "the events cut-off has not passed the month's end plus a day";
  if (!(deliveriesCut > edge))
    return "the deliveries cut-off has not passed the month's end plus a day";
  if (input.caughtUp.events === null || !(input.caughtUp.events > edge))
    return "the events mover has not caught up past the month's end plus a day";
  if (input.caughtUp.deliveries === null || !(input.caughtUp.deliveries > edge))
    return "the deliveries mover has not caught up past the month's end plus a day";
  const ev = input.fileMaxIds.events;
  if (ev !== undefined && ev !== null && input.watermarks.events < ev)
    return "the events watermark is below the file's last id";
  const dv = input.fileMaxIds.deliveries;
  if (dv !== undefined && dv !== null && input.watermarks.deliveries < dv)
    return "the deliveries watermark is below the file's last id";
  return null;
}

/** Count a table in the file in rowid windows, with a real turn between. */
async function countTable(
  db: import("better-sqlite3").Database,
  table: string,
  tsCol: string | null,
  measure: <T>(fn: () => T) => T,
  signal?: AbortSignal,
): Promise<DbFileTable> {
  const out: DbFileTable = {
    rows: 0,
    first_id: null,
    last_id: null,
    first_ts: null,
    last_ts: null,
  };
  const ts = tsCol ? `"${tsCol}"` : "NULL";
  const stmt = db.prepare(
    `SELECT COUNT(*) AS n, MIN(r) AS lo, MAX(r) AS hi, MIN(t) AS tlo, MAX(t) AS thi
       FROM (SELECT rowid AS r, ${ts} AS t FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT ?)`,
  );
  let from = Number.MIN_SAFE_INTEGER;
  for (;;) {
    signal?.throwIfAborted();
    const w = measure(
      () =>
        stmt.get(from, SEAL_COUNT_WINDOW) as {
          n: number;
          lo: number | null;
          hi: number | null;
          tlo: string | null;
          thi: string | null;
        },
    );
    if (w.n === 0) break;
    out.rows += w.n;
    out.first_id ??= w.lo;
    out.last_id = w.hi;
    if (w.tlo !== null && (out.first_ts === null || w.tlo < out.first_ts)) out.first_ts = w.tlo;
    if (w.thi !== null && (out.last_ts === null || w.thi > out.last_ts)) out.last_ts = w.thi;
    from = w.hi!;
    if (w.n < SEAL_COUNT_WINDOW) break;
    await yieldToLoop();
  }
  return out;
}

function blockerInput(deps: SealDeps, entry: DbFileEntry) {
  return {
    month: entry.month,
    nowMs: deps.now().getTime(),
    eventsAfterDays: deps.eventsAfterDays,
    afterDays: deps.afterDays,
    caughtUp: {
      events: markTime(deps.store, EVENTS_TABLE.caughtUpMark),
      deliveries: markTime(deps.store, DELIVERIES_TABLE.caughtUpMark),
    },
    watermarks: {
      events: markNumber(deps.store, EVENTS_TABLE.mark),
      deliveries: markNumber(deps.store, DELIVERIES_TABLE.mark),
    },
  };
}

/** The conditions that need no file: the cut-offs and the movers' frontiers. */
export function timeSealBlocker(deps: SealDeps, entry: DbFileEntry): string | null {
  return sealBlocker({ ...blockerInput(deps, entry), fileMaxIds: {} });
}

/** Why one open file may not be sealed now (null = it may). The time
 * conditions are checked first, so a month that cannot be due is never
 * opened. The file must exist (the connection never creates it). */
export function fileSealBlocker(deps: SealDeps, entry: DbFileEntry): string | null {
  const base = blockerInput(deps, entry);
  const early = sealBlocker({ ...base, fileMaxIds: {} });
  if (early) return early;
  const conn = deps.adb.connection(entry.file);
  const maxId = (table: string): number | null | undefined =>
    conn.hasTable(table)
      ? ((conn.db.prepare(`SELECT MAX(rowid) AS m FROM ${table}`).get() as { m: number | null })
          .m ?? null)
      : undefined;
  return sealBlocker({
    ...base,
    fileMaxIds: { events: maxId("events"), deliveries: maxId("deliveries") },
  });
}

/**
 * Seal one open file whose month the rule allows. Never deletes the SQLite
 * file unless its gzip decompressed to the same bytes (length and sha256) and
 * the file did not change meanwhile.
 */
export async function sealFile(deps: SealDeps, entry: DbFileEntry): Promise<SealResult> {
  const clock = deps.clock ?? (() => performance.now());
  let maxSpan = 0;
  const measure = <T>(fn: () => T): T => {
    const t0 = clock();
    try {
      return fn();
    } finally {
      maxSpan = Math.max(maxSpan, clock() - t0);
    }
  };
  const early = measure(() => timeSealBlocker(deps, entry));
  if (early) return { file: entry.file, outcome: "not_due", detail: early };
  const path = join(deps.adb.dir, entry.file);
  const gzPath = `${path}.gz`;
  // ---- 0. the file is there, and no gzip of it is --------------------------------
  if (!(await existsOnDisk(path)))
    return {
      file: entry.file,
      outcome: "missing",
      detail: `${entry.file} is listed open but is not on disk — held; it is never recreated`,
    };
  if (await existsOnDisk(gzPath))
    return {
      file: entry.file,
      outcome: "conflict",
      detail: `${entry.file}.gz is already on disk beside an open entry — nothing is replaced; crash recovery settles it at the next start`,
    };
  const blocker = measure(() => fileSealBlocker(deps, entry));
  if (blocker) return { file: entry.file, outcome: "not_due", detail: blocker };
  const conn = deps.adb.connection(entry.file);

  // ---- 1. counts against the running totals ----------------------------------
  // Every table the file holds AND every table the live totals say it should:
  // a total with no table behind it is a mismatch, never a pass.
  const tsOf = new Map(MOVE_TABLES.map((t) => [t.table as string, t.tsCol]));
  const tables: Record<string, DbFileTable> = {};
  const names = [...new Set([...conn.tableNames(), ...MOVE_TABLES.map((t) => t.table)])].sort();
  for (const t of names) {
    const expected = markNumber(deps.store, fileRowsMark(entry.file, t));
    if (!conn.hasTable(t)) {
      if (expected !== 0)
        return {
          file: entry.file,
          outcome: "count_mismatch",
          detail: `${t}: the file has no such table, the live running total says ${expected}`,
        };
      continue;
    }
    const counted = await countTable(conn.db, t, tsOf.get(t) ?? null, measure, deps.signal);
    tables[t] = counted;
    if (counted.rows !== expected)
      return {
        file: entry.file,
        outcome: "count_mismatch",
        detail: `${t}: the file holds ${counted.rows} row(s), the live running total says ${expected}`,
      };
  }

  // ---- 2–3. checkpoint, sync, TRUNCATE, close, the file's identity ------------
  // The pages go into the file first (PASSIVE) and are made durable (an
  // awaited fsync) BEFORE the TRUNCATE empties the WAL: under synchronous=OFF
  // the TRUNCATE itself syncs nothing, so truncating unsynced pages could lose
  // rows whose live copies are gone.
  type Ck = Array<{ busy: number; log: number; checkpointed: number }>;
  const checkpoint = (mode: "PASSIVE" | "TRUNCATE"): Ck | null => {
    try {
      return measure(() => conn.db.pragma(`wal_checkpoint(${mode})`)) as Ck;
    } catch (err) {
      if (isBusy(err)) return null;
      throw err;
    }
  };
  const passive = checkpoint("PASSIVE");
  if (!passive || passive[0]?.busy || (passive[0] && passive[0].checkpointed < passive[0].log))
    return { file: entry.file, outcome: "busy", detail: "the WAL could not be checkpointed whole" };
  await conn.syncDb();
  const ck = checkpoint("TRUNCATE");
  if (!ck || ck[0]?.busy)
    return { file: entry.file, outcome: "busy", detail: "TRUNCATE checkpoint busy" };
  deps.adb.closeFile(entry.file);
  const wal = await identityOrNull(`${path}-wal`);
  if (wal && wal.size > 0)
    return {
      file: entry.file,
      outcome: "attached",
      detail: "another connection keeps a non-empty WAL",
    };
  const before = await identityOf(path);
  const noRoom = (await deps.roomFor?.(before?.size ?? 0)) ?? null;
  if (noRoom) return { file: entry.file, outcome: "held", detail: noRoom };

  // ---- 4–6. gzip, verify the round trip, identity again ------------------------
  const partial = `${gzPath}${PARTIAL_SUFFIX}`;
  const rate = { bytesPerS: deps.maxBytesPerS, signal: deps.signal };
  let gz;
  try {
    gz = await gzipFile(path, partial, { level: deps.gzipLevel, ...rate });
  } catch (err) {
    await unlinkIfPresent(partial).catch(() => false);
    throw err;
  }
  await deps.beforeVerify?.(partial);
  // Any failure to decompress is a failed round trip, never a pass.
  const back = await gunzipDigest(partial, rate).catch((err: unknown) => {
    if (deps.signal?.aborted) throw err;
    return err instanceof Error ? err : new Error(String(err));
  });
  if (back instanceof Error || back.bytes !== gz.bytes || back.sha256 !== gz.sha256) {
    await unlinkIfPresent(partial);
    return {
      file: entry.file,
      outcome: "verify_failed",
      detail:
        back instanceof Error
          ? `the gzip did not decompress: ${back.message}`
          : `the gzip decompressed to ${back.bytes} byte(s) / ${back.sha256.slice(0, 12)}, the file is ${gz.bytes} / ${gz.sha256.slice(0, 12)}`,
    };
  }
  const after = await identityOf(path);
  if (!sameIdentity(before, after) || gz.bytes !== before?.size) {
    await unlinkIfPresent(partial);
    return { file: entry.file, outcome: "changed", detail: "the file changed while it was sealed" };
  }

  // ---- 7. place (never over an existing .gz), record, and only then unlink ----
  if ((await renameNoReplace(partial, gzPath)) === "exists") {
    await unlinkIfPresent(partial);
    return {
      file: entry.file,
      outcome: "conflict",
      detail: `${entry.file}.gz appeared while the month was sealed — nothing is replaced`,
    };
  }
  await fsyncDir(deps.adb.dir);
  const gzFile = `${entry.file}.gz`;
  await deps.adb.updateEntry(
    entry.file,
    sealedPatch(tables, gz.bytes, gz.sha256, gzFile, gz.gzBytes, deps.now()),
  );
  await removeSqliteFiles(deps.adb.dir, path);
  deps.log?.(
    `archive: sealed ${entry.file} → ${gzFile} (${gz.bytes} → ${gz.gzBytes} bytes; ` +
      Object.entries(tables)
        .map(([t, v]) => `${t} ${v.rows}`)
        .join(", ") +
      `; longest synchronous span ${Math.round(maxSpan * 10) / 10} ms)`,
  );
  return { file: entry.file, outcome: "sealed", gz_file: gzFile, tables };
}

/** The manifest patch that records a file sealed — by a seal, or by the
 * recovery that finishes one a crash cut short. */
function sealedPatch(
  tables: Record<string, DbFileTable>,
  bytes: number,
  sha256: string,
  gzFile: string,
  gzBytes: number,
  at: Date,
) {
  return {
    state: "sealed" as const,
    tables,
    bytes,
    sha256,
    gz_file: gzFile,
    gz_bytes: gzBytes,
    sealed_at: at.toISOString(),
  };
}

/** A sealed file's SQLite file and sidecars go once its `.gz` is verified
 * and recorded — then the directory, durably. */
async function removeSqliteFiles(dir: string, path: string): Promise<void> {
  await unlinkIfPresent(path);
  await unlinkIfPresent(`${path}-wal`);
  await unlinkIfPresent(`${path}-shm`);
  await fsyncDir(dir);
}

/**
 * Seal what is due: every open file the rule allows, oldest month first, at
 * most `max` per call. Files the rule does not allow yet are left alone, and
 * a hold (re-read before each file) starts nothing more.
 */
export async function sealDue(deps: SealDeps, max = 1): Promise<SealResult[]> {
  const out: SealResult[] = [];
  const open = deps.adb
    .files()
    .filter((f) => f.state === "open")
    .sort((a, b) => a.month.localeCompare(b.month) || a.seq - b.seq);
  for (const entry of open) {
    if (out.filter((r) => r.outcome === "sealed").length >= max) break;
    deps.signal?.throwIfAborted();
    if (deps.hold?.()) break;
    const r = await sealFile(deps, entry);
    if (r.outcome !== "not_due") out.push(r);
    if (r.outcome === "held") break;
    await yieldToLoop();
  }
  return out;
}

/** What sealing recovery found. */
export interface SealRecovery {
  notes: string[];
  /** States left as found because nothing proves them safe to touch — each
   * one for a person (the archiver raises the quiet anomaly once per
   * incident). `code` names the state, so a repeat is the same incident. */
  problems: Array<{ file: string; code: string; detail: string }>;
}

/**
 * Crash recovery for sealing, run once per daemon start before new work (and
 * again after a seal that failed partway):
 *   - a stray `*.gz.partial` is deleted (the SQLite file it came from is still
 *     there — nothing is unlinked before the gzip is in place);
 *   - a `.sqlite.gz` whose manifest entry is still open is re-verified
 *     against the SQLite file beside it — equal: recorded sealed and the
 *     SQLite file removed; different: the `.gz` is removed (the open file
 *     holds every row it does, and more) and the month is sealed afresh
 *     later. Without the SQLite file beside it, it is left as found and
 *     reported;
 *   - a SEALED entry whose `.sqlite` (or `-wal`, `-shm`) is still on disk — a
 *     crash after the manifest recorded the seal, before the unlink — has
 *     them removed only once its `.gz` decompresses to the recorded length
 *     and sha256, the `.sqlite` hashes to them too and the `-wal` is empty;
 *     anything else is left as found and reported.
 * Every unlink is of a verified duplicate, under an unchanged identity.
 */
export async function recoverSeals(
  deps: Pick<SealDeps, "adb" | "maxBytesPerS" | "signal" | "now" | "log">,
): Promise<SealRecovery> {
  const notes: string[] = [];
  const problems: SealRecovery["problems"] = [];
  const note = (s: string): void => {
    notes.push(s);
    deps.log?.(`archive: ${s}`);
  };
  const problem = (file: string, code: string, s: string): void => {
    problems.push({ file, code, detail: s });
    note(s);
  };
  const dir = deps.adb.dir;
  const names = await readdir(dir);
  for (const name of names) {
    if (name.endsWith(`.sqlite.gz${PARTIAL_SUFFIX}`)) {
      await unlinkIfPresent(join(dir, name));
      note(`deleted the stray ${name}`);
    }
  }
  const rate = { bytesPerS: deps.maxBytesPerS, signal: deps.signal };
  for (const entry of deps.adb.files()) {
    const path = join(dir, entry.file);
    if (entry.state === "sealed") {
      const leftovers = [entry.file, `${entry.file}-wal`, `${entry.file}-shm`].filter((n) =>
        names.includes(n),
      );
      if (leftovers.length === 0) continue;
      const kept = `${leftovers.join(", ")} left as found`;
      const gzName = entry.gz_file ?? `${entry.file}.gz`;
      // A stop is never a verdict on the .gz; a read error is named.
      let gzBack: { bytes: number; sha256: string } | null = null;
      let why = names.includes(gzName) ? "" : " (it is missing)";
      if (!why)
        try {
          gzBack = await gunzipDigest(join(dir, gzName), rate);
        } catch (err) {
          if (deps.signal?.aborted) throw err;
          why = ` (${err instanceof Error ? err.message : String(err)})`;
        }
      if (!gzBack || gzBack.bytes !== entry.bytes || gzBack.sha256 !== entry.sha256) {
        problem(
          entry.file,
          "sealed_gz_unverified",
          `${entry.file} is recorded sealed, but ${gzName} does not reproduce the recorded bytes${why} — ${kept}`,
        );
        continue;
      }
      const wal = await identityOrNull(`${path}-wal`);
      if (wal && wal.size > 0) {
        problem(
          entry.file,
          "sealed_wal_nonempty",
          `${entry.file} is recorded sealed, but its -wal holds ${wal.size} byte(s) — ${kept}`,
        );
        continue;
      }
      const before = await identityOrNull(path);
      if (before) {
        const file = await fileDigest(path, rate);
        const after = await identityOrNull(path);
        if (
          file.bytes !== entry.bytes ||
          file.sha256 !== entry.sha256 ||
          !sameIdentity(before, after)
        ) {
          problem(
            entry.file,
            "sealed_file_differs",
            `${entry.file} is recorded sealed, but the SQLite file beside its .gz is not the sealed bytes — ${kept}`,
          );
          continue;
        }
      }
      deps.adb.closeFile(entry.file);
      await removeSqliteFiles(dir, path);
      note(`removed ${leftovers.join(", ")}: verified duplicates of the sealed ${gzName}`);
      continue;
    }
    const gzName = `${entry.file}.gz`;
    if (!names.includes(gzName)) continue;
    const gzPath = join(dir, gzName);
    if (!names.includes(entry.file)) {
      problem(
        entry.file,
        "gz_without_file",
        `${gzName} has no ${entry.file} beside it and an open manifest entry — left as found`,
      );
      continue;
    }
    deps.adb.closeFile(entry.file);
    const before = await identityOrNull(path);
    const [file, back] = await Promise.all([
      fileDigest(path, rate),
      // A gzip that does not decompress is a crash's leftover (null); one
      // that cannot be READ is not known to be anything (the error).
      gunzipDigest(gzPath, rate).catch((err: NodeJS.ErrnoException) => {
        if (deps.signal?.aborted) throw err;
        return typeof err.code === "string" && err.code.startsWith("Z_") ? null : err;
      }),
    ]);
    if (back instanceof Error) {
      problem(
        entry.file,
        "gz_unreadable",
        `${gzName} could not be read (${back.message}) — left as found`,
      );
      continue;
    }
    if (back && back.bytes === file.bytes && back.sha256 === file.sha256) {
      const gz = await identityOf(gzPath);
      // The counts a normal seal records, read from the file before it goes.
      const conn = deps.adb.connection(entry.file);
      const tsOf = new Map(MOVE_TABLES.map((t) => [t.table as string, t.tsCol]));
      const tables: Record<string, DbFileTable> = {};
      for (const t of conn.tableNames())
        tables[t] = await countTable(conn.db, t, tsOf.get(t) ?? null, (fn) => fn(), deps.signal);
      deps.adb.closeFile(entry.file);
      const after = await identityOrNull(path);
      if (!sameIdentity(before, after)) {
        problem(
          entry.file,
          "changed_in_recovery",
          `${entry.file} changed while its ${gzName} was verified — left as found`,
        );
        continue;
      }
      await deps.adb.updateEntry(
        entry.file,
        sealedPatch(tables, file.bytes, file.sha256, gzName, gz?.size ?? 0, deps.now()),
      );
      await removeSqliteFiles(dir, path);
      note(`finished sealing ${entry.file} (verified ${gzName})`);
    } else {
      await unlinkIfPresent(gzPath);
      await fsyncDir(dir);
      note(`removed ${gzName}: it does not reproduce ${entry.file}; the month seals afresh`);
    }
  }
  return { notes, problems };
}

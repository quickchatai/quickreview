// The archive DATABASES (docs/archiving.md §6, §9.3): one SQLite
// file per UTC month under `<root>/archive/db/`, opened by the archiver's OWN
// connections only — never `ATTACH`ed to the live one (cross-database commits
// are not atomic in WAL, and it would widen who can read the archive).
//
//   - Same schema: each table is created from the live table's own DDL, read
//     from the live `sqlite_master`, and rows keep their original ids.
//   - The connection: `journal_mode=WAL`, `synchronous=OFF`,
//     `wal_autocheckpoint=0`, `busy_timeout=0`, `journal_size_limit=0`. A
//     commit never fsyncs on the loop — the mover awaits an fsync of the
//     `-wal` file through `fs.promises` (the threadpool) before it deletes
//     anything live, which is the durability barrier. Checkpoints are
//     explicit: past `CHECKPOINT_WAL_BYTES` the mover runs
//     `wal_checkpoint(PASSIVE)` (a page copy, no fsync) and awaits an fsync of
//     the database file before the next write may restart the WAL — and that
//     restart truncates the `-wal` (journal_size_limit 0; SQLite otherwise
//     keeps the file at its high-water size, which would read as "past 16 MB"
//     on every later batch). And no lock is ever waited on: an analyst who
//     holds an unsealed month makes a batch fail fast (SQLITE_BUSY), never
//     block the daemon.
//   - A listed file is only ever OPENED (`fileMustExist`), never created: one
//     that vanished is reported and held, never recreated empty (an empty file
//     would seal — and its `.gz` would replace the month's real one). Only
//     `target()` creates a file, at a name nothing on disk has used.
//   - `manifest.json` lists every file (open or sealed). Rows of a month whose
//     file is sealed (only possible after a clock step) go to
//     `state-YYYY-MM-<k>.sqlite`. A `.sqlite.gz` the manifest does not list
//     means the manifest lost a sealed month: which months are sealed is then
//     unknown, and nothing is written until a person looks.
import Database from "better-sqlite3";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PARTIAL_SUFFIX, fsyncDir, fsyncFile, unlinkIfPresent, writeJsonAtomic } from "./fsutil.js";

/** The directory under `<root>/archive/`. */
export const ARCHIVE_DB_DIR = "db";
export const DB_MANIFEST = "manifest.json";

/** Past this much WAL, the mover checkpoints (PASSIVE) and fsyncs the file. */
export const CHECKPOINT_WAL_BYTES = 16 * 1024 * 1024;

const DAY_MS = 86_400_000;
/** A month file's name: `state-YYYY-MM.sqlite`, or `state-YYYY-MM-<seq>.sqlite`
 * (groups: the month, the seq when written). `monthFile` writes it. */
const FILE_NAME = String.raw`state-(\d{4}-\d{2})(?:-(\d+))?\.sqlite`;
const FILE_RE = new RegExp(`^${FILE_NAME}$`);
/** Every name a month file leaves on disk: the database, its WAL and shared
 * memory, its sealed gzip and a gzip in progress. A new file takes a seq none
 * of these has used. */
const ANY_FILE_RE = new RegExp(`^${FILE_NAME}(?:-wal|-shm|\\.gz|\\.gz\\.partial)?$`);
/** A sealed gzip (group 1: the database file it seals). */
const GZ_RE = new RegExp(`^(${FILE_NAME})\\.gz$`);

/** The seq a name's match carries: written, else 1. */
const seqOf = (m: RegExpExecArray): number => (m[2] ? Number(m[2]) : 1);

/** `<root>/archive/db`. */
export const archiveDbDir = (root: string): string => join(root, "archive", ARCHIVE_DB_DIR);

/** A row timestamp in ms; null when it cannot be dated (not a string, or no
 * date `Date.parse` reads). The one admission rule the mover, its rollup and
 * the planner share. */
export function tsMs(ts: unknown): number | null {
  if (typeof ts !== "string") return null;
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t : null;
}

/** The UTC month (`YYYY-MM`) of a timestamp; null when it cannot be dated. */
export function monthOf(ts: unknown): string | null {
  const t = tsMs(ts);
  return t === null ? null : new Date(t).toISOString().slice(0, 7);
}

/** The UTC day (`YYYY-MM-DD`) of a timestamp; null when it cannot be dated. */
export function dayOf(ts: unknown): string | null {
  const t = tsMs(ts);
  return t === null ? null : new Date(t).toISOString().slice(0, 10);
}

/** The first instant AFTER a month (UTC), in ms. */
export function monthEndMs(month: string): number {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return Date.UTC(y, m, 1); // `m` is 1-based, so this is the next month's first day
}

/** A month's file name: `state-YYYY-MM.sqlite`, then `-2`, `-3`, … */
export const monthFile = (month: string, seq: number): string =>
  seq <= 1 ? `state-${month}.sqlite` : `state-${month}-${seq}.sqlite`;

/** What sealing recorded of one table in one file. */
export interface DbFileTable {
  rows: number;
  first_id: number | null;
  last_id: number | null;
  first_ts: string | null;
  last_ts: string | null;
}

/** One archive database file. */
export interface DbFileEntry {
  file: string;
  month: string;
  seq: number;
  state: "open" | "sealed";
  created_at: string;
  /** Filled at sealing, from the file itself. */
  tables?: Record<string, DbFileTable>;
  bytes?: number;
  sha256?: string;
  gz_file?: string;
  gz_bytes?: number;
  sealed_at?: string;
}

export interface DbManifest {
  format: 1;
  files: DbFileEntry[];
}

/** The manifest exists but cannot be read whole — or a sealed gzip on disk is
 * missing from it: which months are sealed is UNKNOWN, so nothing is written
 * to the archive until a person looks. */
export class ManifestUnreadable extends Error {}

/** A file the manifest lists as open is not on disk. It is never recreated:
 * the rows its running totals count are somewhere a person must look. */
export class ArchiveFileMissing extends Error {}

/** A SQLite identifier, double-quoted (an embedded `"` doubled). */
export const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Read `archive/db/manifest.json`: absent = empty; unreadable throws. */
export async function readDbManifest(dir: string): Promise<DbManifest> {
  let text: string;
  try {
    text = await readFile(join(dir, DB_MANIFEST), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { format: 1, files: [] };
    throw new ManifestUnreadable(`archive/db/${DB_MANIFEST}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ManifestUnreadable(
      `archive/db/${DB_MANIFEST} is not JSON: ${(err as Error).message}`,
    );
  }
  if (!isObj(parsed) || parsed.format !== 1 || !Array.isArray(parsed.files))
    throw new ManifestUnreadable(`archive/db/${DB_MANIFEST} has no format-1 file list`);
  const files: DbFileEntry[] = [];
  for (const f of parsed.files as unknown[]) {
    if (
      !isObj(f) ||
      typeof f.file !== "string" ||
      !FILE_RE.test(f.file) ||
      typeof f.month !== "string" ||
      typeof f.seq !== "number" ||
      !Number.isInteger(f.seq) ||
      f.seq < 1 ||
      (f.state !== "open" && f.state !== "sealed")
    )
      throw new ManifestUnreadable(`archive/db/${DB_MANIFEST} has an unreadable file entry`);
    files.push(f as unknown as DbFileEntry);
  }
  return { format: 1, files };
}

/** Is `err` SQLite saying a lock is held (and, at busy_timeout 0, refusing to
 * wait)? */
export function isBusy(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  return (
    typeof code === "string" && (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED"))
  );
}

/** The live DDL of a table, as `sqlite_master` holds it. */
export function liveDdl(live: Database.Database, table: string): string {
  const row = live
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { sql: string | null } | undefined;
  if (!row?.sql) throw new Error(`no live table ${table}`);
  return row.sql;
}

interface LiveColumn {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
}

/** One archive database file, on the archiver's own connection. */
export class ArchiveConn {
  readonly db: Database.Database;
  private readonly tables = new Set<string>();
  /** The columns each table holds in this file (read once, kept current). */
  private readonly cols = new Map<string, Set<string>>();
  /** Whether the directory has been fsynced since this connection's WAL
   * first synced — a new `-wal` file's directory entry must be durable too. */
  private walDirSynced = false;

  /**
   * Open `path`. Only `create: true` (ArchiveDb.target, for a name nothing on
   * disk has used) may make the file; every other open requires it to exist
   * (SQLITE_CANTOPEN otherwise), so a listed file that vanished is never
   * silently recreated empty.
   */
  constructor(
    readonly path: string,
    readonly file: string,
    opts: { create: boolean } = { create: false },
  ) {
    // timeout 0: better-sqlite3's default is to wait 5 s on a lock.
    this.db = new Database(path, { timeout: 0, fileMustExist: !opts.create });
    try {
      this.db.pragma("busy_timeout = 0");
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = OFF");
      this.db.pragma("wal_autocheckpoint = 0");
      // A WAL reset (the first write after a complete checkpoint) truncates
      // the file, so its size measures what was written since — the 16 MB
      // checkpoint trigger reads it.
      this.db.pragma("journal_size_limit = 0");
    } catch (err) {
      this.db.close();
      throw err;
    }
    this.refreshTables();
  }

  /** Re-read which tables the file holds (after a rolled-back CREATE). */
  refreshTables(): void {
    this.tables.clear();
    this.cols.clear();
    if (!this.db.open) return;
    for (const r of this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>)
      this.tables.add(r.name);
  }

  hasTable(table: string): boolean {
    return this.tables.has(table);
  }

  /** The tables this file holds (sqlite's own excluded). */
  tableNames(): string[] {
    return [...this.tables].filter((t) => !t.startsWith("sqlite_")).sort();
  }

  /**
   * Make `table` ready to take rows of the live shape `liveCols`: created
   * from the live DDL when the file lacks it; otherwise every live column the
   * file does not hold yet (a migration since the file was made) is added
   * with its live definition (type, NOT NULL, default) — so a schema change
   * can neither wedge an open month nor drop a new column's values. A column
   * the live table dropped stays in the file (the mover names only live
   * columns). Synchronous and small; run inside the batch's archive
   * transaction (a rolled-back ALTER is forgotten by `refreshTables`).
   */
  ensureTable(table: string, live: Database.Database, liveCols: readonly string[]): void {
    if (!this.tables.has(table)) {
      this.db.exec(liveDdl(live, table));
      this.tables.add(table);
    }
    let have = this.cols.get(table);
    if (!have) {
      have = new Set(
        (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
          (c) => c.name,
        ),
      );
      this.cols.set(table, have);
    }
    const missing = liveCols.filter((c) => !have.has(c));
    if (missing.length === 0) return;
    const defs = new Map(
      (live.prepare(`PRAGMA table_info(${table})`).all() as LiveColumn[]).map((c) => [c.name, c]),
    );
    for (const name of missing) {
      const c = defs.get(name);
      if (!c) throw new Error(`archive db: the live ${table} has no column ${name}`);
      this.db.exec(
        `ALTER TABLE ${table} ADD COLUMN ${quoteIdent(c.name)}` +
          (c.type ? ` ${c.type}` : "") +
          (c.notnull ? " NOT NULL" : "") +
          (c.dflt_value !== null ? ` DEFAULT ${c.dflt_value}` : ""),
      );
      have.add(name);
    }
  }

  /** The durability barrier: fsync the `-wal` file on the threadpool (and,
   * the first time, its directory, so a newly created WAL's entry survives an
   * OS crash too). */
  async syncWal(): Promise<void> {
    await fsyncFile(`${this.path}-wal`);
    if (!this.walDirSynced) {
      await fsyncDir(dirname(this.path));
      this.walDirSynced = true;
    }
  }

  syncDb(): Promise<void> {
    return fsyncFile(this.path);
  }

  /** The WAL's size on disk; 0 when there is none. */
  async walBytes(): Promise<number> {
    try {
      return (await stat(`${this.path}-wal`)).size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw err;
    }
  }

  /**
   * Close. SQLite checkpoints the WAL into the file on the last close and
   * then deletes the WAL — and under `synchronous=OFF` that checkpoint does
   * not fsync the file, so an OS crash right after could lose rows whose live
   * copies are gone. NORMAL for the close makes that checkpoint sync the file
   * before the WAL goes. (It runs on the loop, once: at shutdown, or after a
   * seal has already synced everything.)
   */
  close(): void {
    if (!this.db.open) return;
    try {
      this.db.pragma("synchronous = NORMAL");
    } catch {
      /* closing anyway */
    }
    this.db.close();
  }
}

/**
 * The archive database directory: its manifest, and the archiver's open
 * connections. Built lazily, only in mode `on` — plan mode creates nothing.
 */
export class ArchiveDb {
  private manifest: DbManifest | null = null;
  private readonly conns = new Map<string, ArchiveConn>();
  /** Every manifest change runs on this chain, one at a time: the next file
   * list is computed from the current one INSIDE the chain and swapped in
   * only once it is on disk — a failed write leaves memory as the disk is. */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    readonly dir: string,
    private readonly opts: {
      now: () => Date;
      log?: (msg: string, extra?: unknown) => void;
    },
  ) {}

  /** Create the directory, read the manifest, delete stray `.partial`
   * manifest writes, and adopt any `state-*.sqlite` the manifest does not
   * list (a crash after a file's creation, before its entry was written). A
   * `.sqlite.gz` of a listed file that is still open is left for seal
   * recovery. Throws `ManifestUnreadable` when the manifest cannot be read,
   * or does not list a `.sqlite.gz` on disk (an absent manifest beside one
   * included): a sealed month the manifest lost is unknown, never "no files".
   * An absent manifest with no gzip beside it is a fresh directory. */
  async open(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const manifest = await readDbManifest(this.dir);
    const listed = new Set(manifest.files.map((f) => f.file));
    const names = (await readdir(this.dir)).sort();
    for (const name of names) {
      const gz = GZ_RE.exec(name);
      if (gz && !listed.has(gz[1]!))
        throw new ManifestUnreadable(
          `archive/db/${name} is on disk but ${DB_MANIFEST} does not list ${gz[1]} — which months are sealed is unknown`,
        );
    }
    const adopt: DbFileEntry[] = [];
    for (const name of names) {
      if (name === `${DB_MANIFEST}${PARTIAL_SUFFIX}`) {
        await unlinkIfPresent(join(this.dir, name));
        continue;
      }
      const m = FILE_RE.exec(name);
      if (!m || listed.has(name)) continue;
      adopt.push({
        file: name,
        month: m[1]!,
        seq: seqOf(m),
        state: "open",
        created_at: this.opts.now().toISOString(),
      });
      this.opts.log?.(`archive: adopted ${name}, a database the manifest did not list`);
    }
    this.manifest = manifest;
    if (adopt.length > 0) await this.mutate((files) => [...files, ...adopt]);
  }

  get opened(): boolean {
    return this.manifest !== null;
  }

  /** Every file the manifest lists (a copy). */
  files(): DbFileEntry[] {
    return (this.manifest?.files ?? []).map((f) => ({ ...f }));
  }

  entry(file: string): DbFileEntry | undefined {
    return this.manifest?.files.find((f) => f.file === file);
  }

  /**
   * Change the file list and persist it, one change at a time: `fn` sees the
   * list as it stands (a copy), and what it returns replaces the list in
   * memory only after it is on disk.
   */
  private mutate(fn: (files: DbFileEntry[]) => DbFileEntry[]): Promise<void> {
    if (!this.manifest) return Promise.reject(new Error("archive db: not opened"));
    const next = this.writeChain.then(async () => {
      const m = this.manifest!;
      const files = fn(m.files.map((f) => ({ ...f })));
      await writeJsonAtomic(join(this.dir, DB_MANIFEST), { format: 1, files });
      m.files = files;
    });
    this.writeChain = next.catch(() => {});
    return next;
  }

  /** Update one entry and persist; memory changes only once the disk has. */
  async updateEntry(file: string, patch: Partial<DbFileEntry>): Promise<void> {
    if (!this.manifest?.files.some((f) => f.file === file))
      throw new Error(`archive db: no manifest entry for ${file}`);
    await this.mutate((files) => files.map((f) => (f.file === file ? { ...f, ...patch } : f)));
  }

  /** The open connection to a listed file, opening it when needed. It must
   * exist: a missing file throws (SQLITE_CANTOPEN), it is never created here. */
  connection(file: string): ArchiveConn {
    const have = this.conns.get(file);
    if (have && have.db.open) return have;
    const conn = new ArchiveConn(join(this.dir, file), file);
    this.conns.set(file, conn);
    return conn;
  }

  /**
   * The connection rows of `month` go to: the month's first file that is not
   * sealed — which must be on disk (`ArchiveFileMissing` otherwise, never a
   * recreation) — or, when there is none, a NEW file at a seq no name on disk
   * or in the manifest has used, its database file, its directory entry and
   * its manifest entry all made durable before a row goes in.
   */
  async target(month: string): Promise<ArchiveConn> {
    const m = this.manifest;
    if (!m) throw new Error("archive db: not opened");
    const ofMonth = m.files.filter((f) => f.month === month);
    const open = ofMonth.filter((f) => f.state === "open").sort((a, b) => a.seq - b.seq)[0];
    if (open) {
      const have = this.conns.get(open.file);
      if (have && have.db.open) return have;
      if (!(await existsOnDisk(join(this.dir, open.file))))
        throw new ArchiveFileMissing(
          `archive/db/${open.file} is listed open in ${DB_MANIFEST} but is not on disk — its month is held; it is never recreated`,
        );
      return this.connection(open.file);
    }
    let seq = ofMonth.reduce((n, f) => Math.max(n, f.seq), 0);
    for (const name of await readdir(this.dir)) {
      const x = ANY_FILE_RE.exec(name);
      if (x && x[1] === month) seq = Math.max(seq, seqOf(x));
    }
    seq += 1;
    const file = monthFile(month, seq);
    const conn = new ArchiveConn(join(this.dir, file), file, { create: true });
    this.conns.set(file, conn);
    await conn.syncDb();
    await fsyncDir(this.dir);
    await this.mutate((files) => [
      ...files,
      { file, month, seq, state: "open", created_at: this.opts.now().toISOString() },
    ]);
    return conn;
  }

  /** Close one file's connection (sealing closes it first). */
  closeFile(file: string): void {
    const c = this.conns.get(file);
    if (c) c.close();
    this.conns.delete(file);
  }

  /** Close every connection. */
  close(): void {
    for (const c of this.conns.values()) c.close();
    this.conns.clear();
  }

  /** Open months and sealed files, for status. */
  counts(): { open: number; sealed: number } {
    const files = this.manifest?.files ?? [];
    return {
      open: files.filter((f) => f.state === "open").length,
      sealed: files.filter((f) => f.state === "sealed").length,
    };
  }
}

/** One day past a month's end — the margin the sealing rule keeps for a clock
 * step. */
export const sealEdgeMs = (month: string): number => monthEndMs(month) + DAY_MS;

/** Whether `path` exists (any type). Errors other than a missing path throw. */
export async function existsOnDisk(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

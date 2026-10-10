// Archive DB-mover test helpers: seed `events` and `deliveries` rows at chosen
// times, build the archiver's DB side over a temp `archive/db/`, and read an
// archive month back through its own better-sqlite3 connection.
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArchiveDb } from "../../src/archive/archivedb.js";
import { DbMover, type DbMoverDeps } from "../../src/archive/dbmove.js";
import { StateStore } from "../../src/state.js";

export const DAY = 86_400_000;
/** "Now" in every DB-mover test: 2026-10-21 12:00 UTC. The events cut-off (35 d)
 * is 2026-09-16 12:00, the deliveries cut-off (14 d) 2026-10-07 12:00. */
export const T0 = Date.parse("2026-10-21T12:00:00.000Z");
export const iso = (ms: number): string => new Date(ms).toISOString();

export interface Rig {
  root: string;
  dir: string;
  store: StateStore;
  adb: ArchiveDb;
  /** Every ArchiveDb this rig opened (a restart opens another). */
  opened: ArchiveDb[];
  mover: (over?: Partial<DbMoverDeps>) => DbMover;
  /** A fresh ArchiveDb over the same directory, as a restart would make. */
  reopen: () => Promise<ArchiveDb>;
  close: () => void;
}

export async function rig(): Promise<Rig> {
  const root = mkdtempSync(join(tmpdir(), "qcr-archive-db-"));
  const dir = join(root, "archive", "db");
  const store = new StateStore(":memory:", () => new Date(T0));
  const opened: ArchiveDb[] = [];
  const open = async (): Promise<ArchiveDb> => {
    const adb = new ArchiveDb(dir, { now: () => new Date(T0) });
    await adb.open();
    opened.push(adb);
    return adb;
  };
  const r: Rig = {
    root,
    dir,
    store,
    adb: await open(),
    opened,
    mover: (over = {}) =>
      new DbMover({
        store,
        adb: r.adb,
        now: () => new Date(T0),
        eventsAfterDays: 35,
        afterDays: 14,
        batchRows: 500,
        sleep: async () => {},
        ...over,
      }),
    reopen: async () => {
      r.adb = await open();
      return r.adb;
    },
    close: () => {
      for (const a of opened) a.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
  return r;
}

/** Insert events directly (bulk, one transaction): `[ts, kind, pr, payload]`. */
export function seedEvents(
  store: StateStore,
  rows: Array<[ts: string, kind: string, pr?: number | null, payload?: unknown]>,
): void {
  const ins = store.db.prepare("INSERT INTO events (ts, kind, pr, payload) VALUES (?, ?, ?, ?)");
  store.db.transaction(() => {
    for (const [ts, kind, pr, payload] of rows)
      ins.run(ts, kind, pr ?? null, payload === undefined ? null : JSON.stringify(payload));
  })();
}

export function seedDeliveries(
  store: StateStore,
  rows: Array<[guid: string, receivedAt: string]>,
): void {
  const ins = store.db.prepare(
    "INSERT INTO deliveries (guid, event, action, received_at) VALUES (?, 'pull_request', 'opened', ?)",
  );
  store.db.transaction(() => {
    for (const [guid, at] of rows) ins.run(guid, at);
  })();
}

export type Row = Record<string, unknown>;

export function liveEvents(store: StateStore): Row[] {
  return store.db
    .prepare("SELECT id, ts, kind, pr, payload FROM events ORDER BY id")
    .all() as Row[];
}

export function liveDeliveries(store: StateStore): Row[] {
  return store.db
    .prepare("SELECT rowid AS rid, guid, event, action, received_at FROM deliveries ORDER BY rowid")
    .all() as Row[];
}

/** Read one table of an archive file through a separate connection. */
export function archived(path: string, table: "events" | "deliveries"): Row[] {
  const db = new Database(path, { timeout: 0 });
  try {
    const has = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table);
    if (!has) return [];
    return (
      table === "events"
        ? db.prepare("SELECT id, ts, kind, pr, payload FROM events ORDER BY id").all()
        : db
            .prepare(
              "SELECT rowid AS rid, guid, event, action, received_at FROM deliveries ORDER BY rowid",
            )
            .all()
    ) as Row[];
  } finally {
    db.close();
  }
}

/** A table's DDL as `sqlite_master` holds it. */
export function ddl(db: Database.Database, table: string): string | undefined {
  return (
    db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as
      { sql: string } | undefined
  )?.sql;
}

export function mark(store: StateStore, name: string): unknown {
  return (
    store.db.prepare("SELECT value FROM archive_marks WHERE name = ?").get(name) as
      { value: unknown } | undefined
  )?.value;
}

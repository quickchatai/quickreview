// the LIVE state.db's WAL checkpoint, off the loop (the 2026-10-08
// rehearsal on real data: the daemon connection's automatic checkpoint fired
// inside one delete commit in every 8–11 batches and fsynced the 466 MB file
// on the loop — 35–93 ms commits, a cost per ~4 MB of WAL no batch size
// bounds). While a run deletes, the daemon connection's `wal_autocheckpoint`
// is off and every deleting batch is followed by a PASSIVE checkpoint on a
// worker thread with its own connection; the setting comes back when the run
// ends, when the checkpointer fails, and on stop().
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArchiveDb } from "../src/archive/archivedb.js";
import { DbMover, type DbMoverDeps } from "../src/archive/dbmove.js";
import {
  workerCheckpointer,
  type LiveCheckpointResult,
  type LiveCheckpointer,
} from "../src/archive/livecheckpoint.js";
import { StateStore } from "../src/state.js";
import { DAY, T0, iso, liveEvents, seedEvents } from "./helpers/archive-rows.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const OLD = T0 - 40 * DAY;

interface FileRig {
  root: string;
  dbPath: string;
  store: StateStore;
  adb: ArchiveDb;
  mover: (over?: Partial<DbMoverDeps>) => DbMover;
}

const rigs: Array<() => void> = [];
afterEach(() => {
  for (const close of rigs.splice(0)) close();
});

/** A FILE-backed live store (WAL, as the daemon's is) and a temp archive/db. */
async function fileRig(): Promise<FileRig> {
  const root = mkdtempSync(join(tmpdir(), "qcr-archive-liveck-"));
  const dbPath = join(root, "state", "state.db");
  const store = new StateStore(dbPath, () => new Date(T0));
  const adb = new ArchiveDb(join(root, "archive", "db"), { now: () => new Date(T0) });
  await adb.open();
  rigs.push(() => {
    adb.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    dbPath,
    store,
    adb,
    mover: (over = {}) =>
      new DbMover({
        store,
        adb,
        now: () => new Date(T0),
        eventsAfterDays: 35,
        afterDays: 14,
        batchRows: 500,
        sleep: async () => {},
        ...over,
      }),
  };
}

const seedOld = (store: StateStore, n: number): void =>
  seedEvents(
    store,
    Array.from(
      { length: n },
      (_, i) =>
        [iso(OLD + i * 1000), "webhook_event", null, { pad: "x".repeat(200) }] as [
          string,
          string,
          null,
          unknown,
        ],
    ),
  );

const autockpt = (store: StateStore): number =>
  Number(store.db.pragma("wal_autocheckpoint", { simple: true }));

/** A checkpointer the test drives; it records the daemon connection's
 * automatic-checkpoint setting at every call. */
function fakeCheckpointer(
  store: StateStore,
  behaviour: {
    ready?: () => Promise<void>;
    checkpoint?: (n: number) => Promise<LiveCheckpointResult>;
  } = {},
) {
  const calls = { made: 0, checkpoints: 0, closed: 0, settingAtCheckpoint: [] as number[] };
  const factory = (): LiveCheckpointer => {
    calls.made += 1;
    return {
      ready: behaviour.ready ?? (async () => {}),
      checkpoint: async () => {
        calls.checkpoints += 1;
        calls.settingAtCheckpoint.push(autockpt(store));
        return behaviour.checkpoint
          ? behaviour.checkpoint(calls.checkpoints)
          : { busy: 0, log: 10, checkpointed: 10, ms: 1 };
      },
      close: async () => {
        calls.closed += 1;
      },
    };
  };
  return { calls, factory };
}

const sha = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

describe("the live database's checkpoint never runs on the loop while the mover deletes", () => {
  it("every delete commits with the daemon connection's automatic checkpoint OFF; one off-loop checkpoint per deleting batch; the setting comes back", async () => {
    const r = await fileRig();
    seedOld(r.store, 1600);
    expect(autockpt(r.store)).toBe(1000);
    const { calls, factory } = fakeCheckpointer(r.store);
    const during: number[] = [];
    const res = await r
      .mover({ liveCheckpointer: factory, onBatch: () => during.push(autockpt(r.store)) })
      .run();
    expect(res).toMatchObject({ outcome: "caught_up", events: { moved: 1600 } });
    expect(res.events.batches).toBeGreaterThan(1);
    // Off for every batch (each batch's delete committed before onBatch).
    expect(during).toEqual(Array(res.events.batches).fill(0));
    expect(calls.settingAtCheckpoint).toEqual(Array(res.events.batches).fill(0));
    // One checkpoint after every batch that deleted, one checkpointer a run.
    expect(calls.checkpoints).toBe(res.events.batches);
    expect(res.live_checkpoints).toBe(res.events.batches);
    expect(calls.made).toBe(1);
    // Back on, and the checkpointer closed, once the run ends.
    expect(autockpt(r.store)).toBe(1000);
    expect(calls.closed).toBe(1);
  });

  it("a run that deletes nothing starts no checkpointer and leaves the setting alone", async () => {
    const r = await fileRig();
    seedEvents(r.store, [[iso(T0 - DAY), "webhook_event", null, null]]);
    const { calls, factory } = fakeCheckpointer(r.store);
    const res = await r.mover({ liveCheckpointer: factory }).run();
    expect(res).toMatchObject({ outcome: "caught_up", events: { moved: 0 }, live_checkpoints: 0 });
    expect(calls.made).toBe(0);
    expect(autockpt(r.store)).toBe(1000);
  });

  it("a checkpointer that cannot start stops the run before anything live is deleted; the setting untouched", async () => {
    const r = await fileRig();
    seedOld(r.store, 700);
    const before = liveEvents(r.store);
    const { calls, factory } = fakeCheckpointer(r.store, {
      ready: () => Promise.reject(new Error("no worker here")),
    });
    const res = await r.mover({ liveCheckpointer: factory }).run();
    expect(res).toMatchObject({
      outcome: "skipped",
      skipped_reason: "checkpoint_unavailable",
      events: { moved: 0 },
    });
    expect(res.error).toMatch(/no worker here/);
    expect(liveEvents(r.store)).toEqual(before);
    expect(autockpt(r.store)).toBe(1000);
    expect(calls.closed).toBe(1);
  });

  it("a checkpoint that fails stops the run after its batch — never another delete with nothing checkpointing — and the setting comes back", async () => {
    const r = await fileRig();
    seedOld(r.store, 1600);
    const { calls, factory } = fakeCheckpointer(r.store, {
      checkpoint: () => Promise.reject(new Error("disk said no")),
    });
    const res = await r.mover({ liveCheckpointer: factory }).run();
    expect(res).toMatchObject({
      outcome: "skipped",
      skipped_reason: "checkpoint_failed",
      events: { moved: 500, batches: 1 },
      live_checkpoints: 0,
    });
    expect(res.error).toMatch(/disk said no/);
    expect(liveEvents(r.store)).toHaveLength(1100);
    expect(calls.checkpoints).toBe(1);
    expect(autockpt(r.store)).toBe(1000);
    expect(calls.closed).toBe(1);
  });

  it("release() (the archiver's stop) puts the setting back at once, mid-checkpoint; the run then ends aborted", async () => {
    const r = await fileRig();
    seedOld(r.store, 1600);
    let entered!: () => void;
    const inCheckpoint = new Promise<void>((res) => (entered = res));
    let fail!: (e: Error) => void;
    const factory = (): LiveCheckpointer => ({
      ready: async () => {},
      checkpoint: () => {
        entered();
        return new Promise<LiveCheckpointResult>((_res, rej) => (fail = rej));
      },
      close: async () => fail?.(new Error("closed")),
    });
    const ac = new AbortController();
    const mover = r.mover({ liveCheckpointer: factory, signal: ac.signal });
    const run = mover.run();
    await inCheckpoint;
    expect(autockpt(r.store)).toBe(0);
    ac.abort();
    mover.release();
    expect(autockpt(r.store)).toBe(1000);
    const res = await run;
    expect(res.outcome).toBe("aborted");
    expect(autockpt(r.store)).toBe(1000);
  });

  it("an in-memory store (no WAL) gets no checkpointer at all", async () => {
    const store = new StateStore(":memory:", () => new Date(T0));
    const root = mkdtempSync(join(tmpdir(), "qcr-archive-liveck-mem-"));
    const adb = new ArchiveDb(join(root, "archive", "db"), { now: () => new Date(T0) });
    await adb.open();
    rigs.push(() => {
      adb.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    });
    seedOld(store, 600);
    const res = await new DbMover({
      store,
      adb,
      now: () => new Date(T0),
      eventsAfterDays: 35,
      afterDays: 14,
      batchRows: 500,
      sleep: async () => {},
    }).run();
    expect(res).toMatchObject({
      outcome: "caught_up",
      events: { moved: 600 },
      live_checkpoints: 0,
    });
  });
});

describe("the real checkpointer: a worker thread with its own connection", () => {
  it(
    "by default a WAL store's deletes are checkpointed into the database file by the worker; without it they stay in the WAL",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const prime = async (): Promise<FileRig> => {
        const r = await fileRig();
        seedOld(r.store, 1200);
        // Start from an empty WAL: everything seeded is in the file.
        r.store.db.pragma("wal_checkpoint(TRUNCATE)");
        return r;
      };
      /** The events the database FILE alone holds (no WAL beside the copy). */
      const inFile = (r: FileRig): number => {
        const copy = join(r.root, `file-only-${Math.random().toString(36).slice(2)}.db`);
        copyFileSync(r.dbPath, copy);
        const db = new Database(copy);
        try {
          return (db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
        } finally {
          db.close();
        }
      };
      // Control: no checkpointer, the automatic one left on — the deletes
      // (well under 1000 pages) stay in the WAL, the file is untouched.
      const control = await prime();
      const fileBefore = sha(control.dbPath);
      const c = await control.mover({ liveCheckpointer: null }).run();
      expect(c).toMatchObject({
        outcome: "caught_up",
        events: { moved: 1200 },
        live_checkpoints: 0,
      });
      expect(sha(control.dbPath)).toBe(fileBefore);
      expect(inFile(control)).toBe(1200);

      // Default: the worker copies every deleting batch's pages into the file.
      const r = await prime();
      const res = await r.mover().run();
      expect(res).toMatchObject({ outcome: "caught_up", events: { moved: 1200 } });
      expect(res.live_checkpoints).toBe(res.events.batches);
      expect(inFile(r)).toBe(0);
      expect(autockpt(r.store)).toBe(1000);
    },
  );

  it(
    "a checkpointer over a database without a WAL refuses to start; one over a missing file too",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const root = mkdtempSync(join(tmpdir(), "qcr-archive-liveck-nowal-"));
      rigs.push(() => rmSync(root, { recursive: true, force: true }));
      const path = join(root, "rollback.db");
      const db = new Database(path);
      db.exec("CREATE TABLE t (x)");
      db.close();
      const a = workerCheckpointer(path);
      await expect(a.ready()).rejects.toThrow(/not a WAL database/);
      await expect(a.checkpoint()).rejects.toThrow();
      await a.close();
      const b = workerCheckpointer(join(root, "absent.db"));
      await expect(b.ready()).rejects.toThrow(/could not open/);
      await b.close();
    },
  );

  it(
    "close() rejects a checkpoint still waiting; a closed checkpointer refuses more",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const r = await fileRig();
      const ck = workerCheckpointer(r.dbPath);
      await ck.ready();
      const first = await ck.checkpoint();
      expect(first).toMatchObject({ busy: 0 });
      await ck.close();
      await expect(ck.checkpoint()).rejects.toThrow(/closed/);
    },
  );
});

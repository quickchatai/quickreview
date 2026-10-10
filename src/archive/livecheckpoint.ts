// The live state.db's WAL checkpoint, off the event loop (docs/archiving.md
// §9.3, Build notes).
//
// The daemon's connection checkpoints automatically (`wal_autocheckpoint`,
// 1000 pages) inside whichever commit crosses the threshold, and under
// `synchronous = NORMAL` that checkpoint fsyncs the WAL and then the database
// file — on the loop. The mover's delete batches write WAL fast enough to put
// one such checkpoint inside every 8–11 batches: 35–93 ms commits on local
// NVMe, a cost per ~4 MB of WAL that no batch size can bound (invariant 6).
//
// So, for the length of a DB phase that deletes, the mover turns the daemon
// connection's automatic checkpoint off and runs the checkpoint itself, here:
// ONE worker thread holding its own connection to state.db, which runs
// `PRAGMA wal_checkpoint(PASSIVE)` under `synchronous = NORMAL`. That is
// SQLite's own protocol, unchanged — the WAL synced before any page is copied,
// the database file synced before the WAL may restart — only on another
// thread. PASSIVE never waits on a reader or a writer, and the daemon's
// connection keeps reading and committing while it runs.
//
// The worker is a script evaluated from this string (CommonJS, so it needs no
// file of its own under `dist/` and no TypeScript loader under a test runner)
// and loads better-sqlite3 by the absolute path this module resolves. It
// never writes a row: it opens, checkpoints when asked, and closes.
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";

/** What one checkpoint reported: SQLite's (busy, log, checkpointed) — the
 * WAL's frames and how many of them are now in the database file — and the
 * worker's own time for it. */
export interface LiveCheckpointResult {
  busy: number;
  log: number;
  checkpointed: number;
  ms: number;
}

/** The checkpoint of one live database, somewhere other than the loop. */
export interface LiveCheckpointer {
  /** Resolves once the checkpointer can run; rejects when it cannot. */
  ready(): Promise<void>;
  /** One PASSIVE checkpoint. Rejects when it failed or the checkpointer is
   * gone. */
  checkpoint(): Promise<LiveCheckpointResult>;
  /** Stop. Pending checkpoints reject; never throws. */
  close(): Promise<void>;
}

/** How long a worker may take to open, or to answer one checkpoint, before
 * it is given up on (a hung disk must not hold the archiver's mutex). */
export const LIVE_CHECKPOINT_TIMEOUT_MS = 30_000;

/** The worker: CommonJS, evaluated. Kept free of anything but the driver. */
const WORKER_SOURCE = `
"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const { performance } = require("node:perf_hooks");
let db = null;
const msg = (err) => String((err && err.message) || err);
try {
  const Database = require(workerData.driver);
  db = new Database(workerData.path, { fileMustExist: true, timeout: workerData.busyMs });
  db.pragma("synchronous = NORMAL");
  db.pragma("wal_autocheckpoint = 0");
  if (db.pragma("journal_mode", { simple: true }) !== "wal") throw new Error("not a WAL database");
  parentPort.postMessage({ id: 0, ok: true });
} catch (err) {
  parentPort.postMessage({ id: 0, ok: false, error: msg(err) });
}
parentPort.on("message", (m) => {
  if (m.op === "close") {
    try { if (db) db.close(); } catch (err) { /* closing anyway */ }
    db = null;
    parentPort.close();
    return;
  }
  if (!db) {
    parentPort.postMessage({ id: m.id, ok: false, error: "the checkpoint connection is not open" });
    return;
  }
  const t0 = performance.now();
  try {
    const r = db.pragma("wal_checkpoint(PASSIVE)")[0];
    parentPort.postMessage({ id: m.id, ok: true, busy: r.busy, log: r.log, checkpointed: r.checkpointed, ms: performance.now() - t0 });
  } catch (err) {
    parentPort.postMessage({ id: m.id, ok: false, error: msg(err) });
  }
});
`;

interface Reply {
  id: number;
  ok: boolean;
  error?: string;
  busy?: number;
  log?: number;
  checkpointed?: number;
  ms?: number;
}

/** The better-sqlite3 entry point this daemon loads, by absolute path (the
 * worker's own `require` would resolve from the process's cwd). */
const driverPath = (): string => createRequire(import.meta.url).resolve("better-sqlite3");

/**
 * A checkpointer on a worker thread with its own connection to `path`. The
 * worker is unref'd: it never keeps the process alive.
 */
export function workerCheckpointer(
  path: string,
  opts: { timeoutMs?: number; busyMs?: number } = {},
): LiveCheckpointer {
  const timeoutMs = opts.timeoutMs ?? LIVE_CHECKPOINT_TIMEOUT_MS;
  const pending = new Map<number, { resolve: (r: Reply) => void; reject: (e: Error) => void }>();
  let nextId = 1;
  let dead: Error | null = null;
  let worker: Worker;
  const failAll = (err: Error): void => {
    dead ??= err;
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };
  try {
    worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { driver: driverPath(), path, busyMs: opts.busyMs ?? 2000 },
    });
  } catch (err) {
    const e = new Error(`the checkpoint worker could not start: ${(err as Error).message}`);
    return {
      ready: () => Promise.reject(e),
      checkpoint: () => Promise.reject(e),
      close: () => Promise.resolve(),
    };
  }
  worker.unref();
  worker.on("message", (m: Reply) => {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    p.resolve(m);
  });
  worker.on("error", (err) => failAll(new Error(`the checkpoint worker failed: ${err.message}`)));
  worker.on("exit", (code) => failAll(new Error(`the checkpoint worker exited (${code})`)));

  /** Wait for reply `id`, bounded; a timeout gives the worker up. */
  const await_ = (id: number, what: string): Promise<Reply> =>
    new Promise<Reply>((resolve, reject) => {
      if (dead) return reject(dead);
      const timer = setTimeout(() => {
        pending.delete(id);
        const err = new Error(`the checkpoint worker did not ${what} within ${timeoutMs} ms`);
        failAll(err);
        void worker.terminate().catch(() => {});
        reject(err);
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });

  const opened = await_(0, "open its connection").then((r) => {
    if (!r.ok) {
      const err = new Error(`the checkpoint worker could not open ${path}: ${r.error}`);
      failAll(err);
      void worker.terminate().catch(() => {});
      throw err;
    }
  });
  // Never an unhandled rejection: a caller that never asks still closes.
  opened.catch(() => {});

  return {
    ready: () => opened,
    async checkpoint(): Promise<LiveCheckpointResult> {
      await opened;
      if (dead) throw dead;
      const id = nextId++;
      const reply = await_(id, "finish a checkpoint");
      worker.postMessage({ id, op: "checkpoint" });
      const r = await reply;
      if (!r.ok) throw new Error(`the live checkpoint failed: ${r.error}`);
      return {
        busy: r.busy ?? 0,
        log: r.log ?? 0,
        checkpointed: r.checkpointed ?? 0,
        ms: r.ms ?? 0,
      };
    },
    async close(): Promise<void> {
      if (dead) return;
      failAll(new Error("the checkpoint worker was closed"));
      try {
        worker.postMessage({ op: "close" });
      } catch {
        /* gone already */
      }
      // A graceful close lets the connection shut; terminate is the belt.
      const t = setTimeout(() => void worker.terminate().catch(() => {}), 5_000);
      t.unref?.();
      worker.once("exit", () => clearTimeout(t));
    },
  };
}

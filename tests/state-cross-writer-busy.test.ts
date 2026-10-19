// A second WAL writer (the inject bridge's SessionCommandLedger in a pi
// process, an operator `qcr` CLI opening StateStore) holding state.db's write
// lock for a few hundred milliseconds must make the daemon WAIT inside its
// busy_timeout, never throw SQLITE_BUSY. A deferred transaction that reads
// before it writes cannot wait: SQLite does not invoke the busy handler when a
// read transaction upgrades to a write, so it fails at once. Such
// transactions run as BEGIN IMMEDIATE.
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../src/state.js";

const HOLD_MS = 300;

const HOLDER = `
const { parentPort, workerData } = require("node:worker_threads");
const Database = require(workerData.driver);
const db = new Database(workerData.path, { fileMustExist: true });
db.exec("BEGIN IMMEDIATE");
db.prepare("INSERT INTO events (ts, kind, pr, payload) VALUES (?, 'holder', NULL, NULL)").run(new Date().toISOString());
parentPort.postMessage("locked");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, workerData.holdMs);
db.exec("COMMIT");
db.close();
parentPort.postMessage("released");
`;

/** Another connection takes the write lock and keeps it for `holdMs`. */
async function holdWriteLock(path: string, holdMs: number): Promise<Worker> {
  const driver = createRequire(import.meta.url).resolve("better-sqlite3");
  const worker = new Worker(HOLDER, { eval: true, workerData: { driver, path, holdMs } });
  await new Promise<void>((resolve, reject) => {
    worker.once("error", reject);
    worker.once("message", (m) => (m === "locked" ? resolve() : reject(new Error(String(m)))));
  });
  return worker;
}

const done = (w: Worker): Promise<void> => new Promise((r) => w.once("exit", () => r()));

describe("state.db: a second writer holding the lock briefly", () => {
  let dir: string;
  let store: StateStore;
  afterEach(() => {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("acceptWebhookDelivery waits for the lock instead of throwing SQLITE_BUSY", async () => {
    dir = mkdtempSync(join(tmpdir(), "qcr-busy-"));
    const path = join(dir, "state.db");
    store = new StateStore(path);
    const worker = await holdWriteLock(path, HOLD_MS);
    const t0 = performance.now();
    const accepted = store.acceptWebhookDelivery("guid-1", "issue_comment", "created", "{}");
    const waited = performance.now() - t0;
    await done(worker);
    expect(accepted).toBe(true);
    expect(waited).toBeGreaterThanOrEqual(HOLD_MS - 50);
    expect(store.webhookInbox("guid-1")?.event).toBe("issue_comment");
    // The duplicate path still answers false, also through the lock.
    const again = await holdWriteLock(path, 100);
    expect(store.acceptWebhookDelivery("guid-1", "issue_comment", "created", "{}")).toBe(false);
    await done(again);
  });

  it("the other read-then-write transactions seen failing live wait too", async () => {
    dir = mkdtempSync(join(tmpdir(), "qcr-busy-"));
    const path = join(dir, "state.db");
    store = new StateStore(path);
    store.acceptWebhookDelivery("guid-2", "issue_comment", "created", "{}");
    let worker = await holdWriteLock(path, HOLD_MS);
    expect(store.webhookLocalOnce("guid-2", () => 7)).toBe(7);
    await done(worker);
    worker = await holdWriteLock(path, HOLD_MS);
    expect(() => store.observeTriggerLevel(1, "label", true)).not.toThrow();
    await done(worker);
  });
});

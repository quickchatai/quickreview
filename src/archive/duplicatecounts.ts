import { join } from "node:path";
import { lstat } from "node:fs/promises";
// A duplicate's unlink and the live SQLite counter cannot share a transaction.
// Persist its identity first; settle the receipt and counter together once the
// source is confirmed gone. A changed source cancels that removal attempt.
import { createHash } from "node:crypto";
import type { StateStore } from "../state.js";
import { identityOrNull } from "./gzfile.js";
import { sameIdentity, type FileIdentity } from "./fsutil.js";
import { bumpMark } from "./rows.js";

interface Pending {
  path: string;
  identity: FileIdentity;
}
const NAMESPACE = "duplicate.unlink.";
const PR_OF_KEY = new RegExp(`^${NAMESPACE.replaceAll(".", "\\.")}([1-9][0-9]*)\\.`);
const prefix = (pr: number): string => `${NAMESPACE}${pr}.`;

export function prepareDuplicateCount(store: StateStore, pr: number, value: Pending): string {
  const key = prefix(pr) + createHash("sha256").update(JSON.stringify(value)).digest("hex");
  store.db
    .prepare("INSERT OR IGNORE INTO archive_marks (name,value) VALUES (?,?)")
    .run(key, JSON.stringify(value));
  return key;
}

export function finishDuplicateCount(store: StateStore, key: string, removed: boolean): void {
  store.db.transaction(() => {
    const deleted = store.db.prepare("DELETE FROM archive_marks WHERE name=?").run(key).changes;
    if (deleted && removed) bumpMark(store, "duplicates.removed", 1);
  })();
}

export async function recoverDuplicateCounts(
  store: StateStore,
  pr: number,
  legacyPath: string,
): Promise<number> {
  const pending = store.db
    .prepare("SELECT name,value FROM archive_marks WHERE name GLOB ?")
    .all(`${prefix(pr)}*`) as Array<{ name: string; value: string }>;
  let recovered = 0;
  for (const row of pending) {
    const value = JSON.parse(row.value) as Pending;
    if (
      value.path !== legacyPath ||
      !value.identity ||
      ![value.identity.dev, value.identity.ino, value.identity.size, value.identity.mtimeMs].every(
        Number.isFinite,
      )
    )
      throw new Error("unreadable duplicate removal receipt");
    const current = await identityOrNull(value.path);
    if (current === null) {
      // A nonregular replacement is changed, not absent.
      try {
        await lstat(value.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        finishDuplicateCount(store, row.name, true);
        recovered++;
        continue;
      }
      finishDuplicateCount(store, row.name, false);
    } else if (!sameIdentity(value.identity, current)) finishDuplicateCount(store, row.name, false);
  }
  return recovered;
}

/** Pending unlink accounting survives a reopen as well as a stopped PR pass. */
export async function recoverAllDuplicateCounts(
  store: StateStore,
  root: string,
  failed: (pr: number, error: unknown) => void,
): Promise<number> {
  const rows = store.db
    .prepare("SELECT name FROM archive_marks WHERE name GLOB ?")
    .all(`${NAMESPACE}*`) as Array<{ name: string }>;
  const prs = new Set<number>();
  for (const row of rows) {
    const match = PR_OF_KEY.exec(row.name);
    if (match && Number.isSafeInteger(Number(match[1]))) prs.add(Number(match[1]));
  }
  let recovered = 0;
  for (const pr of prs) {
    try {
      recovered += await recoverDuplicateCounts(
        store,
        pr,
        join(root, "archive", `pr-${pr}`, "session.jsonl"),
      );
    } catch (error) {
      failed(pr, error);
    }
  }
  return recovered;
}

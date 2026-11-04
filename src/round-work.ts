import type { StateStore } from "./state.js";

export type RoundWorkKind = "tail" | "escalations" | "findings_hook";
export interface RoundWork {
  key: string;
  kind: RoundWorkKind;
  pr: number;
  round_no: number;
  payload: string;
  due_at: string;
}

/** Publish inside the same transaction as the fact consuming its replay. */
export function enqueueRoundWork(
  store: StateStore,
  work: Omit<RoundWork, "payload"> & { payload: unknown },
): void {
  store.db
    .prepare(
      `INSERT OR IGNORE INTO round_work (key, kind, pr, round_no, payload, due_at)
    VALUES (@key, @kind, @pr, @round_no, @payload, @due_at)`,
    )
    .run({ ...work, payload: JSON.stringify(work.payload) });
}

export function pendingRoundWork(store: StateStore, kind: RoundWorkKind, at: string): RoundWork[] {
  return store.db
    .prepare(
      `SELECT key, kind, pr, round_no, payload, due_at FROM round_work
    WHERE kind=? AND completed_at IS NULL AND due_at<=? ORDER BY due_at, key`,
    )
    .all(kind, at) as RoundWork[];
}

export function finishRoundWork(store: StateStore, key: string, at: string): void {
  // Retain the once receipt, release the potentially large verdict payload.
  store.db
    .prepare(
      "UPDATE round_work SET completed_at=?, payload='null' WHERE key=? AND completed_at IS NULL",
    )
    .run(at, key);
}

/** Owed again later: the item stays pending, due at `at`. */
export function deferRoundWork(store: StateStore, key: string, at: string): void {
  store.db
    .prepare("UPDATE round_work SET due_at=? WHERE key=? AND completed_at IS NULL")
    .run(at, key);
}

/** Whether a later round of the PR has work of this kind of its own (owed or
 * done): that round's work answers this one's. */
export function laterRoundWork(
  store: StateStore,
  kind: RoundWorkKind,
  pr: number,
  roundNo: number,
): boolean {
  return (
    store.db
      .prepare("SELECT 1 FROM round_work WHERE kind=? AND pr=? AND round_no>? LIMIT 1")
      .get(kind, pr, roundNo) !== undefined
  );
}

// The live ledger of per-PR archiving (docs/archiving.md §8.1):
// `archive_prs`, one row per PR the archiver has started on. Its writes, in
// one place:
//
//   - `armArchiveRow` — committed BEFORE the first byte of a PR leaves, with
//     `max_mtime_ms` (the newest original mtime among the transcripts it is
//     about to move, never lowered): from that commit on the receipt guard
//     (`StateStore.archiveScope`, read by `sessions.wakeReceiptPresent`) reads
//     an archived receipt as UNKNOWN, never as absent;
//   - `finishArchiveRow` — the pass's tallies, and `archived` once nothing of
//     the PR is left live;
//   - `setRestoreState` — `restoring`, `restored`, `restore_failed`.
//
// Each is one short synchronous statement.
import type { StateStore } from "../state.js";

export type ArchiveRowState =
  "archiving" | "archived" | "restoring" | "restored" | "restore_failed";

export interface ArchiveRow {
  pr: number;
  state: ArchiveRowState;
  passes: number;
  started_at: string | null;
  archived_at: string | null;
  restored_at: string | null;
  transcript_files: number;
  state_files: number;
  bytes_in: number;
  bytes_out: number;
  max_mtime_ms: number | null;
  last_error: string | null;
  updated_at: string;
}

export function archiveRow(store: StateStore, pr: number): ArchiveRow | null {
  return (
    (store.db.prepare("SELECT * FROM archive_prs WHERE pr = ?").get(pr) as
      ArchiveRow | undefined) ?? null
  );
}

/** Arm the guard: `archiving`, one more pass, `max_mtime_ms` raised to cover
 * `maxMtimeMs` (never lowered — earlier passes' files are archived too). */
export function armArchiveRow(
  store: StateStore,
  pr: number,
  input: { at: string; maxMtimeMs: number | null },
): void {
  store.db
    .prepare(
      `INSERT INTO archive_prs (pr, state, passes, started_at, max_mtime_ms, updated_at)
       VALUES (@pr, 'archiving', 1, @at, @m, @at)
       ON CONFLICT(pr) DO UPDATE SET
         state = 'archiving',
         passes = passes + 1,
         started_at = @at,
         max_mtime_ms = CASE
           WHEN @m IS NULL THEN max_mtime_ms
           WHEN max_mtime_ms IS NULL OR max_mtime_ms < @m THEN @m
           ELSE max_mtime_ms END,
         last_error = NULL,
         updated_at = @at`,
    )
    .run({ pr, at: input.at, m: input.maxMtimeMs });
}

/** A pass's tallies; `archived` when nothing of the PR is left to move. */
export function finishArchiveRow(
  store: StateStore,
  pr: number,
  input: {
    at: string;
    complete: boolean;
    transcriptFiles: number;
    stateFiles: number;
    bytesIn: number;
    bytesOut: number;
    error: string | null;
  },
): void {
  store.db
    .prepare(
      `UPDATE archive_prs SET
         state = CASE WHEN @complete THEN 'archived' ELSE state END,
         archived_at = CASE WHEN @complete THEN @at ELSE archived_at END,
         transcript_files = transcript_files + @tf,
         state_files = state_files + @sf,
         bytes_in = bytes_in + @bi,
         bytes_out = bytes_out + @bo,
         last_error = @error,
         updated_at = @at
       WHERE pr = @pr`,
    )
    .run({
      pr,
      at: input.at,
      complete: input.complete ? 1 : 0,
      tf: input.transcriptFiles,
      sf: input.stateFiles,
      bi: input.bytesIn,
      bo: input.bytesOut,
      error: input.error,
    });
}

export function setRestoreState(
  store: StateStore,
  pr: number,
  state: "restoring" | "restored" | "restore_failed",
  input: { at: string; error?: string | null },
): void {
  store.db
    .prepare(
      `UPDATE archive_prs SET
         state = @state,
         restored_at = CASE WHEN @state = 'restored' THEN @at ELSE restored_at END,
         last_error = @error,
         updated_at = @at
       WHERE pr = @pr`,
    )
    .run({ pr, state, at: input.at, error: input.error ?? null });
}

/** Rows that may have left temporaries behind (§7.6): a crash mid-archive
 * (`archiving`) or mid-restore (`restoring`), or a restore that failed
 * (`restore_failed` — its own clean-up removes its `.restore-partial`, and
 * this is the belt for one that could not). */
export function inFlightRows(store: StateStore): ArchiveRow[] {
  return store.db
    .prepare(
      "SELECT * FROM archive_prs WHERE state IN ('archiving', 'restoring', 'restore_failed') ORDER BY pr",
    )
    .all() as ArchiveRow[];
}

/** Rows whose PR is no longer closed and that are not restored yet (§8.3):
 * the tick restores these first. A row whose restore failed is listed too;
 * the archiver decides when it is retried. */
export function reopenedRows(store: StateStore): ArchiveRow[] {
  return store.db
    .prepare(
      `SELECT a.* FROM archive_prs a JOIN pr_state p ON p.number = a.pr
        WHERE p.state != 'closed' AND a.state != 'restored'
        ORDER BY a.pr`,
    )
    .all() as ArchiveRow[];
}

/** Add `n` to an archive mark (a running total, e.g. `duplicates.removed`). */
export function bumpMark(store: StateStore, name: string, n: number): void {
  if (n <= 0) return;
  store.db
    .prepare(
      `INSERT INTO archive_marks (name, value) VALUES (?, ?)
       ON CONFLICT(name) DO UPDATE SET value = CAST(value AS INTEGER) + excluded.value`,
    )
    .run(name, n);
}

// RESTORE (docs/archiving.md §8.2–§8.4): a reopened PR's archived
// transcripts and session-command payloads back to their original paths and
// mtimes, so the wake-receipt check (`sessions.wakeReceiptPresent`) answers
// truthfully again.
//
//   - What goes back: every PR transcript, and every session-command payload,
//     whose latest manifest record is an archive record and whose live path
//     is EMPTY. Decided by absence, not by the `source_removed_at` stamp: a
//     crash between an unlink and its stamp must not leave a removed file
//     un-restored. Nothing else returns to a live path (analysis reads the
//     archive); the legacy session-at-close copies and the ledger snapshot
//     never do.
//   - How: `<path>.restore-partial` (a name that does not end in `.jsonl`, so
//     neither the receipt scan nor authwatch sees it), the sha256 verified
//     against the manifest, `utimes` to the original mtime, renamed into place
//     without replacing anything, the directory fsynced.
//   - Idempotent: a file already present with the recorded bytes is left
//     alone — and its identity recorded (`present`), so a file an earlier,
//     interrupted pass put back is known to a later re-archive; one present
//     with OTHER bytes (the live file is newer) is left alone too and named
//     in the restore entry — never overwritten.
//   - It ends `restored` (`restored_at`, and a `restore` manifest entry
//     carrying each restored file's new identity, so a re-archive after a
//     re-close REUSES the archived copy instead of compressing it again), or
//     `restore_failed` with the error: the guard then stays armed (an archived
//     receipt reads unknown, never absent) and the caller raises
//     `archive_restore_failed`.
//
// The restore holds the archiver's mutex (taken with priority, `archiver.ts`)
// and never starts a session — it runs BEFORE one is born.
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import type { StateStore } from "../state.js";
import { yieldToLoop } from "../yieldloop.js";
import {
  archiveStamp,
  bundlePassOf,
  freshPassId,
  identityFields,
  sameRecorded,
} from "./archivewrite.js";
import { readBundleRecords } from "./bundle.js";
import { sameIdentity } from "./fsutil.js";
import {
  fileDigestWithPrefix,
  identityOrNull,
  restoreFromBytes,
  restoreFromGzip,
  type StepFn,
} from "./gzfile.js";
import {
  ManifestUnreadable,
  cloneManifest,
  emptyManifest,
  readManifest,
  readManifestIfPresent,
  settledIndex,
  writeManifest,
  type Manifest,
  type RestoredFile,
  type SettledRecord,
} from "./manifest.js";
import { archiveRow, setRestoreState } from "./rows.js";

/** How long a session birth waits for its PR's restore (§8.3). */
export const RESTORE_WAIT_MS = 120_000;

/** A failed restore is retried at most this often (by a birth or a tick). */
export const RESTORE_RETRY_MS = 6 * 60 * 60_000;

export interface RestoreDeps {
  store: StateStore;
  root: string;
  sessionsRoot: string;
  now: () => Date;
  bytesPerS: number;
  signal?: AbortSignal;
  log: (msg: string, extra?: unknown) => void;
  /** Room on the LIVE (state) mount for a file of `bytes` plus the headroom
   * (§7.7): null = room; otherwise why not (`disk_low`, `disk_unknown`). A
   * refusal stops the restore as a failure — nothing is written onto a mount
   * short of its headroom. Absent = not checked (a direct test call). */
  roomFor?: (bytes: number) => Promise<string | null>;
  step?: StepFn;
}

export interface RestoreResult {
  pr: number;
  /** `none` — no archive row, or already restored. */
  outcome: "restored" | "failed" | "none";
  restored: number;
  present: number;
  liveDiffers: string[];
  error: string | null;
}

/** Is this record one restore puts back? A PR transcript (never a legacy
 * copy) or a session-command payload. */
function restorable(r: SettledRecord, sessionsRel: string): boolean {
  if (r.via !== "archive") return false;
  if (r.kind === "transcript")
    return !r.legacy && r.source.startsWith(`${sessionsRel}/`) && r.source.endsWith(".jsonl");
  return r.class === "session_commands";
}

/** A bundle's name (`state-<pass>.jsonl.gz`), as opposed to a file's gzip. */
const isBundle = (archive: string): boolean => bundlePassOf(archive) !== null;

/** Restore one PR (§8.2). Never throws for a failure it can name — the row
 * says `restore_failed` and the result carries the error. */
export async function restorePr(
  deps: RestoreDeps,
  pr: number,
  trigger: "reopen" | "operator",
): Promise<RestoreResult> {
  const { store, root } = deps;
  const out: RestoreResult = {
    pr,
    outcome: "none",
    restored: 0,
    present: 0,
    liveDiffers: [],
    error: null,
  };
  const row = archiveRow(store, pr);
  if (!row || row.state === "restored") return out;
  const at = (): string => deps.now().toISOString();
  setRestoreState(store, pr, "restoring", { at: at(), error: row.last_error });
  const dir = join(root, "archive", `pr-${pr}`);
  const fail = (error: string): RestoreResult => {
    setRestoreState(store, pr, "restore_failed", { at: at(), error });
    deps.log(`archive: pr-${pr} restore FAILED — ${error}`);
    return { ...out, outcome: "failed", error };
  };
  let manifest: Manifest;
  try {
    const found = await readManifestIfPresent(dir);
    if (found === null) {
      // No manifest. Only a row that never moved a byte may read that as
      // "nothing to put back": a manifest is written before any source is
      // unlinked, so one that is missing beside archived files (or behind a
      // row that counted some) is a LOST record, and a restore that called
      // itself done would disarm the receipt guard over receipts it never
      // brought back.
      const lost = row.transcript_files + row.state_files > 0 || (await holdsArchiveFiles(dir));
      if (lost)
        return fail(
          `${join(dir, "manifest.json")} is missing, but this PR's archive holds files — what was moved is unknown`,
        );
      manifest = emptyManifest(`pr-${pr}`);
    } else manifest = found;
  } catch (err) {
    if (err instanceof ManifestUnreadable) return fail(err.message);
    throw err;
  }
  const sessionsRel = relative(root, join(deps.sessionsRoot, `pr-${pr}`));
  const want = [...settledIndex(manifest).values()].filter((r) => restorable(r, sessionsRel));
  const restored: RestoredFile[] = [];
  const failed: Array<{ source: string; error: string }> = [];
  // Bundles are read once each, for the records wanted from them.
  const fromBundles = new Map<string, Set<string>>();
  for (const r of want)
    if (isBundle(r.archive))
      (fromBundles.get(r.archive) ?? fromBundles.set(r.archive, new Set()).get(r.archive)!).add(
        r.source,
      );
  const bundleData = new Map<string, Map<string, Buffer>>();
  let diskStop: string | null = null;
  for (const r of want) {
    deps.signal?.throwIfAborted();
    await yieldToLoop();
    const target = join(root, r.source);
    try {
      const live = await identityOrNull(target);
      if (live) {
        // Present: left alone — the recorded bytes (idempotent), or other ones.
        const d = await fileDigestWithPrefix(target, {
          bytesPerS: deps.bytesPerS,
          ...(deps.signal ? { signal: deps.signal } : {}),
        });
        const after = await identityOrNull(target);
        const steady = sameIdentity(live, after);
        if (steady && d.bytes === r.bytes && d.sha256 === r.sha256) {
          out.present += 1;
          // Its identity is recorded unless it is the one the archive record
          // already holds (a source that was never unlinked). A file an
          // earlier restore pass put back — one that died before its entry
          // was written — has a NEW inode: unrecorded, a re-archive after a
          // re-close would not know it and would compress the same bytes
          // again under `.v2`, instead of reusing the archived copy.
          if (!sameRecorded(r, live))
            restored.push({
              source: r.source,
              archive: r.archive,
              sha256: r.sha256,
              ...identityFields(live),
              present: true,
            });
        } else out.liveDiffers.push(r.source);
        continue;
      }
      // Room on the live mount first (§7.7, §8.4): short of it, nothing more
      // is written and the restore is a failure (the guard stays armed).
      const room = deps.roomFor ? await deps.roomFor(r.bytes) : null;
      if (room !== null) {
        diskStop = room;
        failed.push({ source: r.source, error: `${room} — not written` });
        break;
      }
      const expect = { bytes: r.bytes, sha256: r.sha256, mtime_ms: r.mtime_ms };
      const stepOpt = deps.step ? { step: deps.step } : {};
      let result;
      if (fromBundles.has(r.archive)) {
        let records = bundleData.get(r.archive);
        if (!records) {
          const read = await readBundleRecords(join(dir, r.archive), fromBundles.get(r.archive)!, {
            bytesPerS: deps.bytesPerS,
            ...(deps.signal ? { signal: deps.signal } : {}),
          });
          records = new Map([...read].map(([k, v]) => [k, v.data]));
          bundleData.set(r.archive, records);
        }
        const data = records.get(r.source);
        if (!data) throw new Error(`${r.archive} holds no record for ${r.source}`);
        result = await restoreFromBytes(data, target, expect, stepOpt);
      } else
        result = await restoreFromGzip(join(dir, r.archive), target, expect, {
          bytesPerS: deps.bytesPerS,
          ...(deps.signal ? { signal: deps.signal } : {}),
          ...stepOpt,
        });
      if (result.kind === "mismatch") throw new Error(result.detail);
      if (result.kind === "exists") {
        out.liveDiffers.push(r.source);
        continue;
      }
      restored.push({
        source: r.source,
        archive: r.archive,
        sha256: r.sha256,
        ...identityFields(result.identity),
      });
      out.restored += 1;
    } catch (err) {
      if (deps.signal?.aborted) throw err;
      failed.push({ source: r.source, error: (err as Error).message });
      continue;
    }
    // Outside the per-file catch: a test's crash here is a crash.
    await deps.step?.("restored_file", { pr, source: r.source });
  }
  // The record: one restore entry (the new identities — of the files put
  // back now, and of those found already back — let a re-archive reuse the
  // archived copies), whether or not everything came back.
  if (restored.length > 0 || failed.length > 0 || out.liveDiffers.length > 0) {
    const next = cloneManifest(manifest);
    const id = `restore-${archiveStamp(deps.now())}`;
    const passId = freshPassId(id, (cand) => next.passes.some((p) => p.id === cand));
    next.passes.push({ id: passId, kind: "restore", started_at: at(), finished_at: at(), trigger });
    next.entries.push({
      pass: passId,
      kind: "restore",
      trigger,
      at: at(),
      files: out.restored,
      restored,
      ...(out.liveDiffers.length > 0 ? { live_differs: out.liveDiffers } : {}),
      ...(failed.length > 0 ? { failed } : {}),
    });
    try {
      await writeManifest(dir, manifest, next);
    } catch (err) {
      return fail(`the restore manifest entry could not be written: ${(err as Error).message}`);
    }
  }
  if (failed.length > 0)
    return fail(
      `${diskStop ? `the restore stopped (${diskStop} on the live mount); ` : ""}${failed.length} file(s) not restored: ${failed
        .slice(0, 3)
        .map((f) => `${f.source} (${f.error})`)
        .join("; ")}`,
    );
  setRestoreState(store, pr, "restored", { at: at(), error: null });
  out.outcome = "restored";
  deps.log(
    `archive: pr-${pr} restored (${trigger}) — ${out.restored} file(s) back, ${out.present} already present` +
      (out.liveDiffers.length > 0
        ? `, ${out.liveDiffers.length} differing live file(s) left as found`
        : ""),
  );
  return out;
}

/** The paths a crash mid-restore can leave a `.restore-partial` at: every
 * restorable source of the PR's manifest (read-only; [] when unreadable). */
export async function restoreTargets(
  root: string,
  sessionsRoot: string,
  pr: number,
): Promise<string[]> {
  try {
    const m = await readManifest(join(root, "archive", `pr-${pr}`), `pr-${pr}`);
    const sessionsRel = relative(root, join(sessionsRoot, `pr-${pr}`));
    return [...settledIndex(m).values()]
      .filter((r) => restorable({ ...r, via: "archive" }, sessionsRel))
      .map((r) => join(root, r.source));
  } catch {
    return [];
  }
}

/** Does the PR's archive dir hold any archive file — a transcript or state
 * gzip, or a bundle? (An unreadable dir counts as holding some: unknown is
 * never "nothing".) */
export async function holdsArchiveFiles(dir: string): Promise<boolean> {
  const any = async (d: string, depth: number): Promise<boolean> => {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch (err) {
      return (err as NodeJS.ErrnoException).code !== "ENOENT";
    }
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith(".gz")) return true;
      if (e.isDirectory() && depth > 0 && (await any(join(d, e.name), depth - 1))) return true;
    }
    return false;
  };
  return any(dir, 8);
}

// Retention and a disk cap for the per-round worker trees:
//
//   state/live/<pr-n>/r<k>/     the round's LiveEvent logs (main + one per lens)
//   state/lens/<pr-n>/r<k>/     the lens passes' session JSONLs and their ledger
//
// A closed PR's pass archives both (`prfiles.ts`, OWN_GZIP_CLASSES) and removes
// each source once its copy verifies. This sweep is the other half, for the
// files that outlive that pass (a round a restored or reopened PR wrote after
// its archive, a leftover of an interrupted unlink): a round that has been quiet for
// `live_retention_days` loses a file ONLY when the PR's manifest records exactly
// that file (device, inode, length, mtime) and its archive gzip is on disk —
// the test the archiver itself applies before an unlink. Everything else is
// counted and kept: an open PR's round logs are archived with the PR, never
// before, so nothing here can delete unarchived data.
//
// The cap is a measurement, not a deletion rule. `state/live/` plus `state/lens/`
// past `live_cap_gb` is an alert (the archiver raises `archive_live_cap`), and
// the files stay: a person decides what an over-cap tree is worth.
import { rmdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { yieldToLoop } from "@quickchatai/pi-quickreview/src/yieldloop.js";
import { heldAsRecorded } from "./archivewrite.js";
import { unlinkIfIdentity } from "./gzfile.js";
import { identityOf, type FileIdentity } from "./fsutil.js";
import { ManifestUnreadable, readManifestIfPresent, settledIndex } from "./manifest.js";
import { LIVE_TREES, PR_DIR, listDir, walkFiles } from "./prfiles.js";

/** What one pass over the two trees found and did. */
export interface LiveSweepResult {
  /** When the pass ran (ISO). */
  at: string;
  /** Bytes and files under both trees, before the pass removed anything. */
  bytes: number;
  files: number;
  /** Bytes left under both trees after the pass. */
  bytes_after: number;
  /** Quiet past the retention and archived verified: removed (0 when the pass
   * only measured). */
  removed_files: number;
  removed_bytes: number;
  /** Quiet past the retention but with no verified archive copy: kept. */
  unarchived_files: number;
  unarchived_bytes: number;
  /** PRs whose manifest could not be read: their files were kept untouched. */
  manifest_unreadable: number[];
  /** Why each of those manifests could not be read, by PR number. */
  manifest_errors: Record<string, string>;
}

export interface LiveSweepOptions {
  root: string;
  now: Date;
  retentionMs: number;
  /** Remove what retention allows (mode `on`); false only measures. */
  remove: boolean;
  signal?: AbortSignal;
}

interface Found {
  path: string;
  /** Under the PR's dir: the round dir's name, or the file's own name. */
  group: string;
  id: FileIdentity;
}

/** The files of one `pr-<n>` dir, with their identities. */
async function filesOf(prDir: string, signal?: AbortSignal): Promise<Found[]> {
  const paths: string[] = [];
  await walkFiles(prDir, paths, signal);
  const out: Found[] = [];
  for (const path of paths) {
    signal?.throwIfAborted();
    const id = await identityOf(path);
    if (id) out.push({ path, group: relative(prDir, path).split("/")[0]!, id });
    await yieldToLoop();
  }
  return out;
}

/** Remove `dirs` that are empty, deepest first; a dir with anything left is kept. */
async function pruneEmpty(dirs: readonly string[]): Promise<void> {
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
    try {
      await rmdir(d);
    } catch {
      // not empty, or already gone
    }
  }
}

/**
 * Measure `state/live/` and `state/lens/`, and (with `remove`) apply the
 * retention. Throws only on a listing that could not be read — never reads an
 * unreadable manifest as "nothing archived".
 */
export async function sweepLiveTrees(o: LiveSweepOptions): Promise<LiveSweepResult> {
  const res: LiveSweepResult = {
    at: o.now.toISOString(),
    bytes: 0,
    files: 0,
    bytes_after: 0,
    removed_files: 0,
    removed_bytes: 0,
    unarchived_files: 0,
    unarchived_bytes: 0,
    manifest_unreadable: [],
    manifest_errors: {},
  };
  const unreadable = new Set<number>();
  for (const [, tree] of LIVE_TREES) {
    const treeDir = join(o.root, "state", tree);
    for (const e of await listDir(treeDir)) {
      o.signal?.throwIfAborted();
      if (!e.isDirectory()) continue;
      const prDir = join(treeDir, e.name);
      const found = await filesOf(prDir, o.signal);
      for (const f of found) {
        res.bytes += f.id.size;
        res.files += 1;
      }
      const pr = PR_DIR.exec(e.name);
      // A round is as old as its newest write, so one round goes whole or stays whole.
      const newest = new Map<string, number>();
      for (const f of found) newest.set(f.group, Math.max(newest.get(f.group) ?? 0, f.id.mtimeMs));
      const expired = found.filter((f) => o.now.getTime() - newest.get(f.group)! >= o.retentionMs);
      // Not a bot PR's dir (a review run's key): measured, never swept.
      if (expired.length === 0) continue;
      const archiveDir = pr ? join(o.root, "archive", `pr-${pr[1]}`) : null;
      let held: ReturnType<typeof settledIndex> | null = null;
      if (archiveDir) {
        try {
          const m = await readManifestIfPresent(archiveDir);
          held = m ? settledIndex(m) : null;
        } catch (err) {
          if (!(err instanceof ManifestUnreadable)) throw err;
          unreadable.add(Number(pr![1]));
          res.manifest_errors[pr![1]!] = err.message;
        }
      }
      for (const f of expired) {
        o.signal?.throwIfAborted();
        const rec = held?.get(relative(o.root, f.path));
        const archived =
          archiveDir !== null &&
          rec?.via === "archive" &&
          (await heldAsRecorded(archiveDir, rec, f.id));
        if (!archived) {
          res.unarchived_files += 1;
          res.unarchived_bytes += f.id.size;
        } else if (o.remove) {
          // The identity is read again at the unlink: a file written to since the
          // inventory is no longer the bytes the archive holds.
          const out = await unlinkIfIdentity(f.path, {
            dev: rec.dev,
            ino: rec.ino,
            bytes: rec.bytes,
            mtime_ms: rec.mtime_ms,
          });
          if (out === "removed") {
            res.removed_files += 1;
            res.removed_bytes += f.id.size;
          }
        }
        await yieldToLoop();
      }
      if (res.removed_files > 0) {
        const dirs: string[] = [];
        await walkFiles(prDir, [], o.signal, dirs);
        await pruneEmpty([...dirs, prDir]);
      }
    }
  }
  res.bytes_after = res.bytes - res.removed_bytes;
  res.manifest_unreadable = [...unreadable].sort((a, b) => a - b);
  return res;
}

/** Is the trees' size past the cap? A cap of 0 is "off". */
export const overLiveCap = (bytes: number, capBytes: number): boolean =>
  capBytes > 0 && bytes > capBytes;

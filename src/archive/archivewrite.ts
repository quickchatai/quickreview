// What every archive writer shares about ONE archived file (docs/archiving.md
// §7.6): the PR pass (`prarchive.ts`), the store passes (`storepass.ts`) and
// the restore (`restore.ts`) name, record and recognise archive files by one
// set of rules, so a change to a rule reaches every writer at once.
//
//   - the pass stamp and the identity fields a manifest entry records;
//   - whether a manifest record holds exactly a live identity;
//   - the archive name for a source (its base name, else the first `.v<k>`
//     no entry references) and a pass's bundle name;
//   - placing one file: an orphan gzip a crash left at the name is adopted,
//     kept under its own entry, removed as a proven duplicate or redone
//     (`placeArchive`) — the per-file protocol (`gzfile.ts`) after that.
import { lstat, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  fsyncDir,
  sameRecordedIdentity,
  unlinkIfPresent,
  PARTIAL_SUFFIX,
  type FileIdentity,
} from "./fsutil.js";
import { adoptOrphan, archiveFile, type ArchiveFileOk, type ArchiveFileOpts } from "./gzfile.js";
import type { ManifestEntry, SettledRecord } from "./manifest.js";

/** A pass's (or a restore's) stamp: the ISO time without separators or
 * milliseconds, e.g. `20261015T120000Z`. */
export const archiveStamp = (d: Date): string =>
  d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

/** A live file's identity as a manifest entry records it. */
export const identityFields = (
  id: FileIdentity,
): { bytes: number; mtime_ms: number; dev: number; ino: number } => ({
  bytes: id.size,
  mtime_ms: id.mtimeMs,
  dev: id.dev,
  ino: id.ino,
});

/** A session record's `meta.json` (`archive/pr-<n>/`, or an overseer
 * rotation's `archive/overseer/<date>/`): the live transcript it named, and
 * when it was archived — each null when the file or the field cannot be read. */
export async function readSessionMeta(
  dir: string,
): Promise<{ session_file: string | null; archived_at: string | null }> {
  try {
    const m = JSON.parse(await readFile(join(dir, "meta.json"), "utf8")) as Record<string, unknown>;
    return {
      session_file: typeof m.session_file === "string" ? m.session_file : null,
      archived_at: typeof m.archived_at === "string" ? m.archived_at : null,
    };
  } catch {
    return { session_file: null, archived_at: null };
  }
}

/** The archive name a legacy session-at-close copy is kept under (§7.5):
 * stamped with its record's `archived_at`, else the copy's own mtime. */
export function legacyArchiveName(archivedAt: string | null, mtimeMs: number): string {
  const at = Date.parse(archivedAt ?? "");
  return `transcripts/session-at-close-${archiveStamp(new Date(Number.isFinite(at) ? at : mtimeMs))}.jsonl.gz`;
}

/** Is a legacy copy (its digest `mine`) the transcript it names (`src`, with
 * the sha256 of its first `mine.bytes` bytes) — whole, or a byte-prefix? */
export function legacyMatch(
  mine: { bytes: number; sha256: string },
  src: { bytes: number; sha256: string; prefixSha256: string | null },
): "exact" | "prefix" | null {
  if (mine.bytes === src.bytes && mine.sha256 === src.sha256) return "exact";
  if (mine.bytes < src.bytes && mine.sha256 === src.prefixSha256) return "prefix";
  return null;
}

/** Does the manifest record hold exactly this live identity (a source
 * archived already with these bytes — unlink only)? */
export const sameRecorded = (
  rec: Pick<SettledRecord, "dev" | "ino" | "bytes" | "mtime_ms"> | undefined,
  id: FileIdentity | null,
): boolean => sameRecordedIdentity(rec, id);

/** Is `rel` (relative to `dir`) an existing regular file? Its size, or null. */
export async function archiveFileSize(dir: string, rel: string): Promise<number | null> {
  try {
    const st = await lstat(join(dir, rel));
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

/** Does some transcript or file entry already hold these exact bytes (sha256
 * and length) in an archive file on disk under `dir`? An orphan gzip holding
 * them is then a proven duplicate. */
export async function bytesHeld(
  entries: Iterable<ManifestEntry>,
  dir: string,
  sha256: string,
  bytes: number,
): Promise<boolean> {
  for (const e of entries)
    if (
      (e.kind === "transcript" || e.kind === "file") &&
      e.sha256 === sha256 &&
      e.bytes === bytes &&
      (await archiveFileSize(dir, e.archive)) !== null
    )
      return true;
  return false;
}

/** The archive name for a base name: itself while no entry references it,
 * else the first `.v<k>` no entry references (§7.6). */
export function versionedName(base: string, refs: ReadonlySet<string>): string {
  if (!refs.has(base)) return base;
  for (let k = 2; ; k++) {
    const cand = base.replace(/\.gz$/, `.v${k}.gz`);
    if (!refs.has(cand)) return cand;
  }
}

const BUNDLE_RE = /^state-(.+)\.jsonl\.gz$/;

/** A pass's bundle of small files: `state-<pass>.jsonl.gz`. */
export const bundleName = (passId: string): string => `state-${passId}.jsonl.gz`;

/** The pass a bundle name carries (`withPartial`: a `.partial` of one counts
 * too), else null — the name is no bundle's. */
export function bundlePassOf(name: string, withPartial = false): string | null {
  const bare =
    withPartial && name.endsWith(PARTIAL_SUFFIX) ? name.slice(0, -PARTIAL_SUFFIX.length) : name;
  return BUNDLE_RE.exec(bare)?.[1] ?? null;
}

/** The facts an entry for one archived gzip records. */
export interface Packed {
  bytes: number;
  mtime_ms: number;
  dev: number | null;
  ino: number | null;
  sha256: string;
  gz_bytes: number;
  adopted?: true;
}

export type PlaceResult =
  | { kind: "ok"; ok: ArchiveFileOk; dest: string }
  | { kind: "verify_failed"; detail: string }
  | { kind: "changed" };

/**
 * One file through the protocol, under the name `versionedName` gives — or
 * adoption of the orphan gzip already at that name. An orphan that
 * decompresses cleanly to OTHER bytes (an earlier version of the source) is
 * kept under its own entry (`keep`, `adopted`, identity null — unless an
 * entry already holds those bytes, when it is a proven duplicate and
 * removed) and the live file goes to the next name; one that does not
 * decompress is removed and redone. A source that changes while it is read
 * is left as found (`changed`), and so is its orphan.
 */
export async function placeArchive(a: {
  /** The live source. */
  path: string;
  /** The writer's archive dir; `base` and every name are relative to it. */
  dir: string;
  base: string;
  /** The source, as the log names it. */
  source: string;
  /** Who writes, as the log names it (`pr-12`, `overseer`). */
  who: string;
  opts: ArchiveFileOpts;
  /** Every archive name an entry references now (re-read after `keep`). */
  refs: () => ReadonlySet<string>;
  /** Bytes some entry already holds in an archive file on disk. */
  heldAlready: (sha256: string, bytes: number) => Promise<boolean>;
  /** Append the entry for an orphan kept as an earlier version, durably. */
  keep: (dest: string, p: Packed) => Promise<void>;
  log: (msg: string) => void;
}): Promise<PlaceResult> {
  const { dir, who } = a;
  let dest = versionedName(a.base, a.refs());
  while ((await archiveFileSize(dir, dest)) !== null && !a.refs().has(dest)) {
    const o = await adoptOrphan(a.path, join(dir, dest), a.opts);
    if (o.kind === "ok") {
      a.log(`archive: ${who} — adopted the orphan gzip ${dest} (no recompress)`);
      return { kind: "ok", ok: o, dest };
    }
    if (o.kind === "changed") {
      a.log(`archive: ${who} — ${o.detail}; left live for the next pass`);
      return { kind: "changed" };
    }
    if (o.kind === "corrupt") {
      a.log(`archive: ${who} — ${o.detail}: removed, the file is archived again`);
      break;
    }
    if (await a.heldAlready(o.sha256, o.bytes)) {
      await unlinkIfPresent(join(dir, dest));
      await fsyncDir(dirname(join(dir, dest)));
      a.log(`archive: ${who} — the orphan gzip ${dest} duplicates an entry: removed`);
      break;
    }
    await a.keep(dest, {
      bytes: o.bytes,
      mtime_ms: o.mtimeMs,
      dev: null,
      ino: null,
      sha256: o.sha256,
      gz_bytes: o.gzBytes,
      adopted: true,
    });
    a.log(
      `archive: ${who} — the orphan gzip ${dest} holds an earlier version of ${a.source}: kept under its own entry`,
    );
    dest = versionedName(a.base, a.refs());
  }
  const r = await archiveFile(a.path, join(dir, dest), a.opts);
  if (r.kind === "verify_failed") return { kind: "verify_failed", detail: r.detail };
  if (r.kind === "changed") {
    a.log(`archive: ${who} — ${r.detail}; left live for the next pass`);
    return { kind: "changed" };
  }
  return { kind: "ok", ok: r, dest };
}

/** The stops an unlink obeys, out of a pass's `stopReason`: the archiver
 * stopping, or a restore waiting for the mutex — it is served at the next
 * file boundary, and an unlink is one. A spent budget or a load hold does not
 * stop them: each is one cheap step over a copy already verified. */
export function unlinkStopOf(reason: string | null): string | null {
  return reason === "stopping" || reason === "restore_pending" ? reason : null;
}

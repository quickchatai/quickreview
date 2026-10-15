// The per-PR archive MANIFEST (docs/archiving.md §6): plain JSON at
// `archive/pr-<n>/manifest.json`, readable with `jq`, and APPEND-ONLY.
//
// The writer only ever appends passes and entries. An existing entry is never
// removed, reordered or changed; the one thing a later write may do to one is
// ADD a stamp it did not have yet (`STAMP_FIELDS`: when its sources were
// removed, which bundle sources were kept, when a pass finished). Every write
// is checked against the manifest it replaces (`assertAppendOnly`) and goes
// through tmp + fsync + rename + directory fsync, so a crash leaves the old
// manifest or the new one, never a torn one.
//
// A manifest that cannot be read is never overwritten: the pass that met it
// stops (the PR is held), because rewriting it would drop the record of
// whatever it held.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonAtomic } from "./fsutil.js";

export const MANIFEST_FORMAT = 1;
export const MANIFEST_FILE = "manifest.json";

export interface ManifestPass {
  id: string;
  kind: "archive" | "restore";
  started_at: string | null;
  finished_at?: string;
  /** For an archive pass: the close the window counted from. */
  closed_at?: string | null;
  /** For a restore: what asked for it. */
  trigger?: string;
  /** A pass whose record was rebuilt by crash recovery. */
  recovered_at?: string;
}

/** A file's identity as recorded: a change in any of these means the bytes
 * on disk may not be the bytes the entry describes. */
export interface IdentityFields {
  bytes: number;
  mtime_ms: number;
  dev: number;
  ino: number;
}

/** One file archived as its own gzip: a pi transcript (`transcript`), or a
 * state file too large for a bundle record (`file`). `dev`/`ino` are null
 * only for an ADOPTED orphan gzip that holds an earlier version of its
 * source (it decompressed cleanly, but not to the live bytes): kept, never
 * read as the live file's copy. */
export interface FileEntry extends Omit<IdentityFields, "dev" | "ino"> {
  dev: number | null;
  ino: number | null;
  pass: string;
  kind: "transcript" | "file";
  /** The live path, relative to the sandbox root. */
  source: string;
  /** The gzip, relative to the PR's archive dir. */
  archive: string;
  sha256: string;
  gz_bytes: number;
  verified_at: string;
  /** For `file`: the §7.2 class. */
  class?: string;
  /** A re-archive of bytes an earlier entry already holds (after a restore):
   * no recompress, the archive is that entry's. */
  reused?: true;
  /** The legacy `archive/pr-<n>/session.jsonl` copy, kept as a gzip because
   * it matched no transcript (§7.5) — never restored to a live path. */
  legacy?: true;
  /** A gzip found on disk with no entry (a crash between its rename and its
   * entry) whose bytes are not the live source's any more: an earlier
   * version, kept under its own entry (identity null) — never deleted. */
  adopted?: true;
  source_removed_at?: string;
}

/** One small file inside a bundle. `dev`/`ino` are null for a record of an
 * adopted orphan bundle whose live source no longer matched. */
export interface BundleFile {
  path: string;
  bytes: number;
  mtime_ms: number;
  dev: number | null;
  ino: number | null;
  sha256: string;
  class: string;
  /** Snapshotted only: the live file is kept (the PR's ledger). */
  snapshot?: true;
  session_command?: BundleCommand;
}

export interface BundleCommand {
  id: string;
  kind: string;
  round_no: number | null;
  status: string;
  /** Whether the bytes hash to the row's `payload_sha256`. */
  payload_sha256_ok: boolean;
}

export interface BundleEntry {
  pass: string;
  kind: "bundle";
  archive: string;
  records: number;
  bytes: number;
  gz_bytes: number;
  verified_at: string;
  files: BundleFile[];
  /** A bundle found on disk with no entry (a crash between its rename and
   * this write) and adopted after its records were verified. */
  adopted?: true;
  sources_removed_at?: string;
  /** Sources not removed (their identity changed, or the pass stopped). */
  kept?: string[];
}

/** A small file whose bytes an earlier bundle already holds (it was restored,
 * then archived again unchanged): no new record, the archive is that bundle. */
export interface ReusedEntry extends IdentityFields {
  pass: string;
  kind: "reused";
  source: string;
  archive: string;
  sha256: string;
  class: string;
  verified_at: string;
  session_command?: BundleCommand;
  source_removed_at?: string;
}

/** Sources of an EARLIER bundle removed by a later pass (its own entry was
 * already stamped — a crash between the unlinks, or a pass that stopped). */
export interface SourcesRemovedEntry {
  pass: string;
  kind: "sources_removed";
  archive: string;
  paths: string[];
  removed_at: string;
}

export interface DuplicateEntry {
  pass: string;
  kind: "duplicate_removed";
  /** Relative to the PR's archive dir. */
  path: string;
  bytes: number;
  sha256: string;
  duplicate_of: string;
  match: "exact" | "prefix";
  removed_at: string;
}

export interface RestoredFile extends IdentityFields {
  source: string;
  archive: string;
  sha256: string;
  /** Already present with the recorded bytes: left alone. */
  present?: true;
}

export interface RestoreEntry {
  pass: string;
  kind: "restore";
  trigger: string;
  at: string;
  files: number;
  restored: RestoredFile[];
  /** Present with different bytes (the live file is newer): left alone. */
  live_differs?: string[];
  failed?: Array<{ source: string; error: string }>;
}

export type ManifestEntry =
  FileEntry | BundleEntry | ReusedEntry | SourcesRemovedEntry | DuplicateEntry | RestoreEntry;

export interface Manifest {
  format: number;
  subject: string;
  passes: ManifestPass[];
  entries: ManifestEntry[];
}

/** The fields a later write may ADD to an existing entry or pass — never
 * change, never remove. */
export const STAMP_FIELDS: ReadonlySet<string> = new Set([
  "source_removed_at",
  "sources_removed_at",
  "kept",
  "finished_at",
]);

export class ManifestUnreadable extends Error {}

export function emptyManifest(subject: string): Manifest {
  return { format: MANIFEST_FORMAT, subject, passes: [], entries: [] };
}

export const manifestPath = (dir: string): string => join(dir, MANIFEST_FILE);

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The manifest in `dir`: an empty one when there is none; ManifestUnreadable
 * when there is one that is not this format — never read as empty.
 */
export async function readManifest(dir: string, subject: string): Promise<Manifest> {
  return (await readManifestIfPresent(dir)) ?? emptyManifest(subject);
}

/** The manifest in `dir`, or null when there is none (ENOENT) — for a reader
 * that must tell "no manifest" from "an empty one" (a restore: a missing
 * manifest beside archived files is a lost record, never "nothing moved"). */
export async function readManifestIfPresent(dir: string): Promise<Manifest | null> {
  let text: string;
  try {
    text = await readFile(manifestPath(dir), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ManifestUnreadable(`${manifestPath(dir)}: ${(err as Error).message}`);
  }
  return parseManifestText(text, manifestPath(dir));
}

/** A manifest's text parsed and checked (`where` names it in an error);
 * ManifestUnreadable when it is not this format — never read as empty. */
export function parseManifestText(text: string, where: string): Manifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ManifestUnreadable(`${where}: ${(err as Error).message}`);
  }
  if (
    !isObj(parsed) ||
    parsed.format !== MANIFEST_FORMAT ||
    !Array.isArray(parsed.passes) ||
    !Array.isArray(parsed.entries) ||
    !parsed.entries.every((e) => isObj(e) && typeof e.kind === "string")
  )
    throw new ManifestUnreadable(`${where}: not a format-${MANIFEST_FORMAT} manifest`);
  return parsed as unknown as Manifest;
}

/** A manifest in brief (`qcr why`): what it holds and what left
 * the live tree. Pure. */
export interface ManifestSummary {
  passes: number;
  /** Transcript gzips (legacy session-at-close copies included). */
  transcripts: number;
  /** State files too large for a bundle, each its own gzip. */
  files: number;
  bundles: number;
  /** Records across the bundles. */
  records: number;
  /** Original bytes of the archived files, and their compressed size. */
  bytes: number;
  gz_bytes: number;
  /** Live sources the manifest says were removed after their copy verified. */
  sources_removed: number;
  duplicates_removed: number;
  restores: number;
  /** When the newest pass started (null when none says). */
  last_pass_at: string | null;
}

export function summarizeManifest(m: Manifest): ManifestSummary {
  const out: ManifestSummary = {
    passes: m.passes.length,
    transcripts: 0,
    files: 0,
    bundles: 0,
    records: 0,
    bytes: 0,
    gz_bytes: 0,
    sources_removed: 0,
    duplicates_removed: 0,
    restores: 0,
    last_pass_at: null,
  };
  for (const p of m.passes)
    if (p.started_at && (out.last_pass_at === null || p.started_at > out.last_pass_at))
      out.last_pass_at = p.started_at;
  for (const e of m.entries) {
    switch (e.kind) {
      case "transcript":
      case "file":
        if (e.reused) break;
        if (e.kind === "transcript") out.transcripts += 1;
        else out.files += 1;
        out.bytes += e.bytes;
        out.gz_bytes += e.gz_bytes;
        if (e.source_removed_at !== undefined) out.sources_removed += 1;
        break;
      case "bundle": {
        out.bundles += 1;
        out.records += e.records;
        out.bytes += e.bytes;
        out.gz_bytes += e.gz_bytes;
        out.sources_removed += stampedBundleSources(e).size;
        break;
      }
      case "sources_removed":
        out.sources_removed += e.paths.length;
        break;
      case "duplicate_removed":
        out.duplicates_removed += 1;
        break;
      case "restore":
        out.restores += 1;
        break;
      case "reused":
        break;
    }
  }
  return out;
}

/** What `archive_prs` counts for a PR (and status.json `archive.totals`
 * sums): the files its archive holds and their bytes, original and
 * compressed. */
export interface RowTallies {
  /** PR transcripts (an earlier version kept under its own entry included;
   * the legacy session-at-close copy and a `reused` entry not). */
  transcriptFiles: number;
  /** State files: each bundle's live records (never a ledger snapshot) and
   * each state file too large for a bundle. */
  stateFiles: number;
  /** Every archived file's original bytes (bundles whole, the legacy copy
   * included), and their compressed size. */
  bytesIn: number;
  bytesOut: number;
}

/** The counts a PR's manifest holds — derived, so a pass that completes after
 * one a crash or a throw cut short counts everything the archive holds. A
 * `reused` entry (bytes another entry already holds) counts nothing. Pure. */
export function rowTallies(m: Manifest): RowTallies {
  const out: RowTallies = { transcriptFiles: 0, stateFiles: 0, bytesIn: 0, bytesOut: 0 };
  for (const e of m.entries) {
    if (e.kind === "transcript" || e.kind === "file") {
      if (e.reused) continue;
      if (e.kind === "file") out.stateFiles += 1;
      else if (!e.legacy) out.transcriptFiles += 1;
      out.bytesIn += e.bytes;
      out.bytesOut += e.gz_bytes;
    } else if (e.kind === "bundle") {
      out.stateFiles += e.files.filter((f) => !f.snapshot).length;
      out.bytesIn += e.bytes;
      out.bytesOut += e.gz_bytes;
    }
  }
  return out;
}

/** A deep copy, so a caller's working copy never aliases the one on disk. */
export const cloneManifest = (m: Manifest): Manifest => JSON.parse(JSON.stringify(m)) as Manifest;

function sameExceptStamps(before: unknown, after: unknown, where: string): void {
  if (!isObj(before) || !isObj(after)) throw new Error(`manifest: ${where} is not an object`);
  for (const [k, v] of Object.entries(before)) {
    if (!(k in after)) throw new Error(`manifest: ${where}.${k} was removed`);
    if (JSON.stringify(after[k]) !== JSON.stringify(v))
      throw new Error(`manifest: ${where}.${k} was changed`);
  }
  for (const k of Object.keys(after))
    if (!(k in before) && !STAMP_FIELDS.has(k))
      throw new Error(
        `manifest: ${where}.${k} was added (only ${[...STAMP_FIELDS].join(", ")} may be)`,
      );
}

/** Throws unless `next` only appends to `prev` (and adds stamps). */
export function assertAppendOnly(prev: Manifest, next: Manifest): void {
  if (next.format !== prev.format || next.subject !== prev.subject)
    throw new Error("manifest: format or subject changed");
  if (next.passes.length < prev.passes.length || next.entries.length < prev.entries.length)
    throw new Error("manifest: a pass or an entry was dropped");
  prev.passes.forEach((p, i) => sameExceptStamps(p, next.passes[i], `passes[${i}]`));
  prev.entries.forEach((e, i) => sameExceptStamps(e, next.entries[i], `entries[${i}]`));
}

/**
 * Write `next` over `prev` (the manifest as last read or written) after
 * checking it only appends; tmp + fsync + rename + dir fsync.
 */
export async function writeManifest(dir: string, prev: Manifest, next: Manifest): Promise<void> {
  assertAppendOnly(prev, next);
  await writeJsonAtomic(manifestPath(dir), next);
}

/** The latest archived copy of one live path, as the manifest records it. */
export interface SettledRecord {
  source: string;
  /** What kind of record: an archive entry, or a restore (the file is live
   * again, with the identity the restore recorded). */
  via: "archive" | "restore";
  kind: "transcript" | "file" | "bundle" | "reused";
  /** The archive file, relative to the PR's archive dir. */
  archive: string;
  sha256: string;
  bytes: number;
  mtime_ms: number;
  dev: number | null;
  ino: number | null;
  /** For a bundle record: its class. */
  class?: string;
  legacy?: boolean;
  /** The entry the record came from (its index in `entries`). */
  entry: number;
  /** Whether that entry says the source was removed. */
  removed: boolean;
}

/** For each live path the manifest knows, its LATEST record — archive
 * entries and restores, in manifest order. */
export function settledIndex(m: Manifest): Map<string, SettledRecord> {
  const out = new Map<string, SettledRecord>();
  indexEntries(out, m.entries);
  return out;
}

/** Apply `entries` to an index, in order — what `settledIndex` does for one
 * manifest, for a store whose entries span several shards (`base` is the
 * index of the first, counted across the shards before it). */
export function indexEntries(
  out: Map<string, SettledRecord>,
  entries: readonly ManifestEntry[],
  base = 0,
): void {
  entries.forEach((e, at) => {
    const i = base + at;
    if (e.kind === "transcript" || e.kind === "file" || e.kind === "reused") {
      out.set(e.source, {
        source: e.source,
        via: "archive",
        kind: e.kind,
        archive: e.archive,
        sha256: e.sha256,
        bytes: e.bytes,
        mtime_ms: e.mtime_ms,
        dev: e.dev,
        ino: e.ino,
        ...(e.kind === "file" || e.kind === "reused" ? { class: e.class } : {}),
        ...(e.kind === "transcript" && e.legacy ? { legacy: true } : {}),
        entry: i,
        removed: e.source_removed_at !== undefined,
      });
    } else if (e.kind === "bundle") {
      const stamped = stampedBundleSources(e);
      for (const f of e.files)
        out.set(f.path, {
          source: f.path,
          via: "archive",
          kind: "bundle",
          archive: e.archive,
          sha256: f.sha256,
          bytes: f.bytes,
          mtime_ms: f.mtime_ms,
          dev: f.dev,
          ino: f.ino,
          class: f.class,
          entry: i,
          removed: stamped.has(f.path),
        });
    } else if (e.kind === "sources_removed") {
      for (const p of e.paths) {
        const r = out.get(p);
        if (r && r.via === "archive" && r.archive === e.archive) r.removed = true;
      }
    } else if (e.kind === "restore") {
      for (const r of e.restored) {
        const prior = out.get(r.source);
        out.set(r.source, {
          source: r.source,
          via: "restore",
          kind: prior?.kind ?? "transcript",
          archive: r.archive,
          sha256: r.sha256,
          bytes: r.bytes,
          mtime_ms: r.mtime_ms,
          dev: r.dev,
          ino: r.ino,
          ...(prior?.class !== undefined ? { class: prior.class } : {}),
          entry: i,
          removed: false,
        });
      }
    }
  });
}

/** The sources a bundle entry's own removal stamp records as gone: none
 * until it is stamped, then every record but a snapshot (a copy of a file
 * that stays live) and the paths it `kept`. A later `sources_removed` entry
 * adds to them. */
export function stampedBundleSources(e: BundleEntry): Set<string> {
  if (e.sources_removed_at === undefined) return new Set();
  const kept = new Set(e.kept ?? []);
  return new Set(e.files.filter((f) => !f.snapshot && !kept.has(f.path)).map((f) => f.path));
}

/** The archive file an entry placed (relative to the dir); null for an entry
 * that places none (a reuse, a removal, a restore). */
export function placedArchive(e: ManifestEntry): string | null {
  return e.kind === "transcript" || e.kind === "file" || e.kind === "bundle" ? e.archive : null;
}

/** Every archive file name the manifest references (relative to the dir). */
export function referencedArchives(m: Manifest): Set<string> {
  const out = new Set<string>();
  for (const e of m.entries) {
    const a = placedArchive(e);
    if (a !== null) out.add(a);
  }
  return out;
}

/** The text a manifest is written as (what `writeManifest` writes). */
export const manifestText = (m: Manifest): string => `${JSON.stringify(m, null, 1)}\n`;

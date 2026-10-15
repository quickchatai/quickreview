// One STORE's archive writer (docs/archiving.md §5, §7.3): the
// files that belong to no PR — the overseer's non-current transcripts
// (`overseer.ts`) and pi's global session store (`piglobal.ts`) — go through
// the SAME per-file protocol as a PR's (`gzfile.ts`), into one archive dir
// with its own append-only manifest (`manifest.ts`), SHARDED — a write
// rewrites one shard of at most STORE_SHARD_ENTRIES entries, never the
// store's whole history.
//
//   - Each file: stop check, identity re-read, disk check, then `archiveFile`
//     (sha256 + gzip into `.partial`, fsync, gunzip-verify, re-lstat, utimes,
//     rename, dir fsync), then its manifest entry — durable before the next.
//   - A file the manifest already holds with the SAME identity (a crash
//     between its entry and its unlink) is never read again: unlink only.
//   - An orphan gzip at the name (a crash between its rename and its entry)
//     is adopted when it decompresses to the live bytes, kept under its own
//     entry when it decompresses to other bytes (an earlier version), and
//     redone only when it does not decompress at all — the PR pass's rule.
//   - Unlinks come last, each only while the caller's re-check still allows
//     it and the file's identity is the one hashed; then the stamps. A
//     restore waiting for the mutex stops them (an unlink is a file
//     boundary); a spent budget or a load hold does not.
//
// Nothing here spawns, injects, wakes or kills a session (rule 9), and
// nothing reads or writes memory.
import { lstat, mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { yieldToLoop } from "../yieldloop.js";
import { fsyncDir, unlinkIfPresent, writeTextAtomic, type FileIdentity } from "./fsutil.js";
import {
  adoptOrphan,
  archiveFile,
  identityOrNull,
  sweepPartials,
  unlinkIfIdentity,
  type ArchiveFileOk,
  type StepFn,
} from "./gzfile.js";
import {
  MANIFEST_FILE,
  ManifestUnreadable,
  assertAppendOnly,
  cloneManifest,
  emptyManifest,
  indexEntries,
  manifestText,
  parseManifestText,
  placedArchive,
  type DuplicateEntry,
  type FileEntry,
  type Manifest,
  type ManifestEntry,
  type SettledRecord,
} from "./manifest.js";
import { SpanMeter } from "./prfiles.js";

export interface StorePassDeps {
  /** The store's archive dir (`archive/overseer`, `archive/pi-global`). */
  dir: string;
  /** The manifest's subject (`overseer`, `pi-global`). */
  subject: string;
  now: () => Date;
  level: number;
  bytesPerS: number;
  signal: AbortSignal;
  /** Free space for one file of `bytes` on both mounts: null = room. */
  diskFor: (bytes: number) => Promise<"disk_low" | "disk_unknown" | null>;
  /** Why no new file may start now; null = go on. */
  stopReason: () => string | null;
  /** The quiet `archive_verify_failed` anomaly, once per incident. */
  verifyFailed: (key: string, detail: string) => void;
  log: (msg: string, extra?: unknown) => void;
  /** The live path a manifest `source` names (the overseer's sources are
   * relative to the sandbox root, pi-global's to its store). */
  liveOf: (source: string) => string;
  /** Measures every synchronous span the pass makes over its manifest (the
   * archiver folds it into `max_sync_span_ms`). */
  meter?: SpanMeter;
  step?: StepFn;
  /** With nothing to move, still open the manifest and stamp the removals a
   * crash left unstamped (`settleStore`) — the archiver asks once per start. */
  settle?: boolean;
}

/** One live file a store pass archives. */
export interface StoreFile {
  /** Absolute live path. */
  path: string;
  /** The manifest's `source` for it. */
  source: string;
  /** Its archive name, relative to the store's archive dir, ending `.gz`
   * (a `.v<k>` is inserted when an entry already holds that name). */
  archive: string;
  identity: FileIdentity;
}

/** What one store pass did (status.json `archive.stores`). */
export interface StorePassResult {
  /** `done` — every candidate archived and removed; `partial` — the pass
   * stopped (budget, hold, restore, a changed source, a verify failure);
   * `held` — nothing was started (`reason`); `none` — nothing to move;
   * `failed` — an I/O failure (`reason`; the next pass resumes). */
  outcome: "done" | "partial" | "held" | "none" | "failed";
  reason: string | null;
  archived: number;
  bytesIn: number;
  bytesOut: number;
  removed: number;
  duplicatesRemoved: number;
  verifyFailures: number;
  /** Files deliberately kept live (the overseer's current one, pi files
   * younger than a day). */
  keptLive: number;
}

/** A store as the plan measures it (§13): what is there, and what a
 * pass would move — `null` when that cannot be said (the overseer's birth
 * unknown, as in a CLI). Read-only: listings and lstats, nothing opened. */
export type StoreTally =
  | {
      state: "measured";
      files: number;
      bytes: number;
      movable_files: number | null;
      movable_bytes: number | null;
      /** The overseer's legacy rotation copies (0 for pi-global). */
      legacy_copies: number;
      legacy_bytes: number;
    }
  | { state: "unreadable"; error: string };

export const emptyStoreResult = (
  outcome: StorePassResult["outcome"],
  reason: string | null = null,
): StorePassResult => ({
  outcome,
  reason,
  archived: 0,
  bytesIn: 0,
  bytesOut: 0,
  removed: 0,
  duplicatesRemoved: 0,
  verifyFailures: 0,
  keptLive: 0,
});

const stampOf = (d: Date): string =>
  d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

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

const toFields = (id: FileIdentity) => ({
  bytes: id.size,
  mtime_ms: id.mtimeMs,
  dev: id.dev,
  ino: id.ino,
});

const sameIdentity = (a: FileIdentity, b: FileIdentity | null): boolean =>
  b !== null && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;

/** A source the manifest's latest record holds with exactly this identity. */
const sameRecorded = (rec: SettledRecord | undefined, id: FileIdentity | null): boolean =>
  rec !== undefined &&
  id !== null &&
  rec.dev === id.dev &&
  rec.ino === id.ino &&
  rec.bytes === id.size &&
  rec.mtime_ms === id.mtimeMs;

/** Is `rel` (relative to `dir`) an existing regular file? Its size, or null. */
export async function archiveFileSize(dir: string, rel: string): Promise<number | null> {
  try {
    const st = await lstat(join(dir, rel));
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

/** A pass with nothing to move: when `deps.settle` asks, the manifest is
 * opened and every entry whose source is gone stamped (a crash between the
 * last unlink and its stamp leaves one, and no later pass may come). Returns
 * the pass's result: `none`, or `held` when the manifest cannot be read. */
export async function settleStore(deps: StorePassDeps): Promise<StorePassResult> {
  if (!deps.settle) return emptyStoreResult("none");
  const writer = await StoreWriter.open(deps);
  if (!writer) return emptyStoreResult("held", "manifest_unreadable");
  await writer.finish(new Set(), []);
  return emptyStoreResult("none");
}

/** The stops an unlink obeys, out of the pass's `stopReason`: the archiver
 * stopping, or a restore waiting for the mutex — it is served at the next
 * file boundary, and an unlink is one. A spent budget or a load hold does not
 * stop them: each is one cheap step over a copy already verified. */
export function unlinkStopOf(reason: string | null): string | null {
  return reason === "stopping" || reason === "restore_pending" ? reason : null;
}

/** A pending unlink: the live path and the identity hashed. */
export interface StoreUnlink {
  path: string;
  source: string;
  identity: { dev: number | null; ino: number | null; bytes: number; mtime_ms: number };
}

/**
 * A store's manifest is SHARDED: `manifest.json` holds its first
 * STORE_SHARD_ENTRIES entries, `manifest-2.json` the next, and so on — each
 * shard a format-1 manifest of its own, append-only, written whole by tmp +
 * fsync + rename + directory fsync. A store only grows (the size of pi's
 * global store is unmeasured), and a JSON file is rewritten whole on every
 * append, so a write rewrites only the shard it touches: its synchronous
 * work — the copy, the append-only check, the stringify — is bounded by one
 * shard, never by the store's history. A PR's manifest is not sharded: it
 * holds one PR.
 */
export const STORE_SHARD_ENTRIES = 500;

/** The file name of a store manifest's `k`-th shard (1-based). */
export const shardName = (k: number): string => (k === 1 ? MANIFEST_FILE : `manifest-${k}.json`);

const SHARD_RE = /^manifest(?:-([1-9]\d*))?\.json$/;

interface Shard {
  name: string;
  m: Manifest;
}

/**
 * Every shard of the store manifest in `dir`, in order; none when there is
 * none. ManifestUnreadable when one cannot be read or parsed, or when a shard
 * in the run is missing (`manifest-3.json` beside no `manifest-2.json`) — a
 * store's record is never read as fewer entries than it has. `measure` wraps
 * each synchronous parse.
 */
export async function readStoreShards(
  dir: string,
  measure: <T>(fn: () => T) => T = (fn) => fn(),
): Promise<Shard[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new ManifestUnreadable(`${dir}: ${(err as Error).message}`);
  }
  const ks: number[] = [];
  for (const n of names) {
    const m = SHARD_RE.exec(n);
    if (!m || m[1] === "1") continue; // `manifest-1.json` is no shard's name
    ks.push(m[1] ? Number(m[1]) : 1);
  }
  ks.sort((a, b) => a - b);
  for (let i = 0; i < ks.length; i++)
    if (ks[i] !== i + 1)
      throw new ManifestUnreadable(
        `${join(dir, shardName(i + 1))} is missing beside ${shardName(ks.at(-1)!)} — the store's record is incomplete`,
      );
  const out: Shard[] = [];
  for (const k of ks) {
    const path = join(dir, shardName(k));
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (err) {
      throw new ManifestUnreadable(`${path}: ${(err as Error).message}`);
    }
    out.push({ name: shardName(k), m: measure(() => parseManifestText(text, path)) });
  }
  return out;
}

const fileish = (e: ManifestEntry): e is FileEntry => e.kind === "transcript" || e.kind === "file";

/**
 * The manifest of one store and the appends a pass makes to it. Opened once
 * per pass; every append is durable before the pass goes on.
 */
export class StoreWriter {
  private readonly shards: Shard[];
  /** The latest record per source, across every shard. */
  private readonly index = new Map<string, SettledRecord>();
  /** Every archive name an entry references, across every shard. */
  private readonly refs = new Set<string>();
  /** Entries across every shard (the next entry's index). */
  private total = 0;
  /** The shards this pass wrote to. */
  private readonly touched = new Set<number>();
  private readonly meter: SpanMeter;
  readonly passId: string;
  readonly result: StorePassResult = emptyStoreResult("done");

  private constructor(
    private readonly deps: StorePassDeps,
    shards: Shard[],
    private readonly startedAt: string,
    meter: SpanMeter,
  ) {
    this.shards = shards;
    this.meter = meter;
    const base = stampOf(deps.now());
    const taken = new Set(shards.flatMap((s) => s.m.passes.map((p) => p.id)));
    let id = base;
    for (let k = 2; taken.has(id); k++) id = `${base}-${k}`;
    this.passId = id;
  }

  /** Open the store's manifest (after sweeping stray `.partial`s — only the
   * archiver writes this dir, under its strict mutex). An unreadable
   * manifest is never overwritten: null, and the caller holds the store. */
  static async open(deps: StorePassDeps): Promise<StoreWriter | null> {
    await sweepPartials(deps.dir);
    const meter = deps.meter ?? new SpanMeter();
    let shards: Shard[];
    try {
      shards = await readStoreShards(deps.dir, (fn) => meter.measure(fn));
    } catch (err) {
      if (!(err instanceof ManifestUnreadable)) throw err;
      deps.verifyFailed(
        `manifest:${deps.subject}`,
        `archive ${deps.subject}: ${err.message} — the store is held and its manifest left as found`,
      );
      return null;
    }
    const w = new StoreWriter(deps, shards, deps.now().toISOString(), meter);
    // The index, one shard at a time with a yield between: a large store is
    // never indexed in one synchronous span.
    for (const s of shards) {
      meter.measure(() => w.absorb(s.m.entries));
      await yieldToLoop();
    }
    return w;
  }

  private absorb(entries: readonly ManifestEntry[]): void {
    indexEntries(this.index, entries, this.total);
    for (const e of entries) {
      const a = placedArchive(e);
      if (a !== null) this.refs.add(a);
    }
    this.total += entries.length;
  }

  /** The latest record per source. */
  records(): ReadonlyMap<string, SettledRecord> {
    return this.index;
  }

  /** Every entry, across the shards, in order. */
  private *entries(): Generator<ManifestEntry> {
    for (const s of this.shards) yield* s.m.entries;
  }

  /**
   * Rewrite shard `k`: this pass's record added to it when missing, then
   * `mutate`; append-only, durable before the pass goes on. The copy, the
   * check and the stringify are one measured span, bounded by the shard.
   */
  private async rewrite(k: number, mutate: (m: Manifest) => void): Promise<void> {
    const shard = this.shards[k]!;
    const { next, text } = this.meter.measure(() => {
      const next = cloneManifest(shard.m);
      if (!next.passes.some((p) => p.id === this.passId))
        next.passes.push({ id: this.passId, kind: "archive", started_at: this.startedAt });
      mutate(next);
      assertAppendOnly(shard.m, next);
      return { next, text: manifestText(next) };
    });
    await mkdir(this.deps.dir, { recursive: true });
    await writeTextAtomic(join(this.deps.dir, shard.name), text);
    shard.m = next;
    this.touched.add(k);
  }

  /** Append entries — to the last shard while it has room, else to a new
   * one — durable before the pass goes on. */
  async append(...entries: ManifestEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const last = this.shards.at(-1);
    if (!last || last.m.entries.length >= STORE_SHARD_ENTRIES)
      this.shards.push({
        name: shardName(this.shards.length + 1),
        m: emptyManifest(this.deps.subject),
      });
    await this.rewrite(this.shards.length - 1, (next) => {
      next.entries.push(...entries);
    });
    this.meter.measure(() => this.absorb(entries));
  }

  /** The archive name for a base name: itself while no entry references it,
   * else the first `.v<k>` no entry references (§7.6). */
  private destFor(base: string): string {
    if (!this.refs.has(base)) return base;
    for (let k = 2; ; k++) {
      const cand = base.replace(/\.gz$/, `.v${k}.gz`);
      if (!this.refs.has(cand)) return cand;
    }
  }

  /** Bytes an entry of this manifest already holds in an archive on disk. */
  private async heldAlready(sha256: string, bytes: number): Promise<boolean> {
    for (const e of this.entries())
      if (
        fileish(e) &&
        e.sha256 === sha256 &&
        e.bytes === bytes &&
        (await archiveFileSize(this.deps.dir, e.archive)) !== null
      )
        return true;
    return false;
  }

  /** Is `f` archived already with exactly its identity (unlink only)? */
  async alreadyHeld(f: StoreFile): Promise<SettledRecord | null> {
    const rec = this.index.get(f.source);
    if (
      sameRecorded(rec, f.identity) &&
      (await archiveFileSize(this.deps.dir, rec!.archive)) !== null
    )
      return rec!;
    return null;
  }

  /**
   * One file through the protocol (or adoption of the orphan gzip already at
   * its name). `entryOf` builds the entry for the name used. Returns the
   * placed archive, or why not.
   */
  async archiveOne(
    f: StoreFile,
    entryOf: (archive: string, p: Packed) => FileEntry,
    prefixBytes?: number,
  ): Promise<{ ok: ArchiveFileOk; dest: string } | "verify_failed" | "changed"> {
    const { deps } = this;
    const opts = {
      level: deps.level,
      bytesPerS: deps.bytesPerS,
      signal: deps.signal,
      identity: f.identity,
      ...(prefixBytes !== undefined ? { prefixBytes } : {}),
      ...(deps.step ? { step: deps.step } : {}),
    };
    let dest = this.destFor(f.archive);
    while ((await archiveFileSize(deps.dir, dest)) !== null && !this.refs.has(dest)) {
      const o = await adoptOrphan(f.path, join(deps.dir, dest), opts);
      if (o.kind === "ok") {
        deps.log(`archive: ${deps.subject} — adopted the orphan gzip ${dest} (no recompress)`);
        return { ok: o, dest };
      }
      if (o.kind === "changed") {
        deps.log(`archive: ${deps.subject} — ${o.detail}; the store stops for this pass`);
        return "changed";
      }
      if (o.kind === "corrupt") {
        deps.log(`archive: ${deps.subject} — ${o.detail}: removed, the file is archived again`);
        break;
      }
      if (await this.heldAlready(o.sha256, o.bytes)) {
        await unlinkIfPresent(join(deps.dir, dest));
        await fsyncDir(dirname(join(deps.dir, dest)));
        deps.log(`archive: ${deps.subject} — the orphan gzip ${dest} duplicates an entry: removed`);
        break;
      }
      const kept: Packed = {
        bytes: o.bytes,
        mtime_ms: o.mtimeMs,
        dev: null,
        ino: null,
        sha256: o.sha256,
        gz_bytes: o.gzBytes,
        adopted: true,
      };
      await this.append(entryOf(dest, kept));
      deps.log(
        `archive: ${deps.subject} — the orphan gzip ${dest} holds an earlier version of ${f.source}: kept under its own entry`,
      );
      dest = this.destFor(f.archive);
    }
    const r = await archiveFile(f.path, join(deps.dir, dest), opts);
    if (r.kind === "verify_failed") {
      this.result.verifyFailures += 1;
      deps.verifyFailed(
        `file:${deps.subject}:${f.source}`,
        `archive ${deps.subject}: ${r.detail} — the source is kept`,
      );
      return "verify_failed";
    }
    if (r.kind === "changed") {
      deps.log(`archive: ${deps.subject} — ${r.detail}; the store stops for this pass`);
      return "changed";
    }
    return { ok: r, dest };
  }

  /** A transcript entry of this pass for `f`. */
  transcriptEntry(f: StoreFile, extra: Partial<FileEntry> = {}) {
    return (archive: string, p: Packed): FileEntry => ({
      pass: this.passId,
      kind: "transcript",
      source: f.source,
      archive,
      ...p,
      verified_at: this.deps.now().toISOString(),
      ...extra,
    });
  }

  /**
   * Archive `files` in order: each through the protocol (or recognised as
   * held already), its entry appended. Returns the unlinks the caller may
   * make, and why the loop stopped (null = it went through every file).
   */
  async archiveAll(files: readonly StoreFile[]): Promise<{
    unlinks: StoreUnlink[];
    stop: string | null;
    incomplete: boolean;
  }> {
    const unlinks: StoreUnlink[] = [];
    let stop: string | null = null;
    let incomplete = false;
    for (const f of files) {
      stop = this.deps.stopReason();
      if (stop) break;
      if (!sameIdentity(f.identity, await identityOrNull(f.path))) {
        // Moved since it was listed: left live, the next pass reads it again.
        incomplete = true;
        continue;
      }
      if (await this.alreadyHeld(f)) {
        unlinks.push({ path: f.path, source: f.source, identity: toFields(f.identity) });
        continue;
      }
      const disk = await this.deps.diskFor(f.identity.size);
      if (disk) {
        stop = disk;
        break;
      }
      const entryOf = this.transcriptEntry(f);
      const out = await this.archiveOne(f, entryOf);
      if (out === "verify_failed" || out === "changed") {
        incomplete = true;
        continue;
      }
      unlinks.push(await this.recordArchived(f, entryOf, out));
    }
    return { unlinks, stop, incomplete };
  }

  /** A file `archiveOne` placed: its entry appended (durable), the pass's
   * counts updated; returns the unlink the caller may make. */
  async recordArchived(
    f: StoreFile,
    entryOf: (archive: string, p: Packed) => FileEntry,
    out: { ok: ArchiveFileOk; dest: string },
  ): Promise<StoreUnlink> {
    await this.append(
      entryOf(out.dest, {
        ...toFields(f.identity),
        sha256: out.ok.sha256,
        gz_bytes: out.ok.gzBytes,
      }),
    );
    await this.deps.step?.("manifest_appended", { store: this.deps.subject, source: f.source });
    this.result.archived += 1;
    this.result.bytesIn += out.ok.bytes;
    this.result.bytesOut += out.ok.gzBytes;
    await yieldToLoop();
    return { path: f.path, source: f.source, identity: toFields(f.identity) };
  }

  /**
   * The unlinks, each only while `allowed()` still says go and the file's
   * identity is the one hashed; returns the sources removed (a source already
   * gone counts — its entry verified). `allowed` returning a reason stops
   * every unlink after it.
   */
  async unlinkAll(
    unlinks: readonly StoreUnlink[],
    allowed: () => string | null,
  ): Promise<{ removed: Set<string>; stop: string | null }> {
    const removed = new Set<string>();
    for (const u of unlinks) {
      const why = allowed();
      if (why) return { removed, stop: why };
      const r = await unlinkIfIdentity(u.path, u.identity);
      if (r === "changed") continue;
      removed.add(u.source);
      if (r === "removed") {
        this.result.removed += 1;
        await this.deps.step?.("unlinked", { store: this.deps.subject, path: u.path });
      }
    }
    return { removed, stop: null };
  }

  /** Remove one proven duplicate (the legacy copy), only while its identity
   * is the one compared. */
  async removeDuplicate(path: string, id: FileIdentity): Promise<boolean> {
    const r = await unlinkIfIdentity(path, toFields(id));
    if (r === "removed") this.result.duplicatesRemoved += 1;
    return r === "removed";
  }

  /** Stamp what left (and every earlier entry whose source is gone — a crash
   * between an unlink and its stamp), append the duplicate removals, finish
   * the pass. Only the shards that change are rewritten. */
  async finish(
    removed: ReadonlySet<string>,
    duplicates: ReadonlyArray<Omit<DuplicateEntry, "pass" | "removed_at">>,
  ): Promise<void> {
    const at = this.deps.now().toISOString();
    const gone = new Set(removed);
    for (const s of this.shards) {
      for (const e of s.m.entries)
        if (
          fileish(e) &&
          e.source_removed_at === undefined &&
          !gone.has(e.source) &&
          (await identityOrNull(this.deps.liveOf(e.source))) === null
        )
          gone.add(e.source);
      await yieldToLoop();
    }
    await this.append(...duplicates.map((d) => ({ ...d, pass: this.passId, removed_at: at })));
    const unstamped = (e: ManifestEntry): boolean =>
      fileish(e) && e.source_removed_at === undefined && gone.has(e.source);
    for (let k = 0; k < this.shards.length; k++) {
      const s = this.shards[k]!;
      const stamps = s.m.entries.some(unstamped);
      const open =
        this.touched.has(k) &&
        s.m.passes.some((p) => p.id === this.passId && p.finished_at === undefined);
      if (!stamps && !open) continue;
      await this.rewrite(k, (next) => {
        for (const e of next.entries) if (unstamped(e)) (e as FileEntry).source_removed_at = at;
        const pass = next.passes.find((p) => p.id === this.passId);
        if (pass && pass.finished_at === undefined) pass.finished_at = at;
      });
    }
  }
}

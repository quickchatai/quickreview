// The PER-FILE PROTOCOL (docs/archiving.md §7.3) — how one live file
// becomes a verified gzip in the archive, and how one gzip goes back (§8.2).
//
// Archiving, in order — every step async, streamed in 1 MiB chunks through
// the token-bucket rate cap, compression on node:zlib's threadpool:
//
//   1. the caller `lstat`s the source and hands its identity in;
//   2. stream it through sha256 (and, when asked, a sha256 of its first N
//      bytes — the legacy-copy prefix check, §7.5) and gzip into
//      `<dest>.partial`, then fsync;
//   3. stream `<dest>.partial` back through gunzip and sha256: the length and
//      hash must equal step 2's, or the partial is deleted, the source kept,
//      and the caller counts a verify failure;
//   4. `lstat` the source again: a changed identity discards the partial
//      (the caller aborts the PR for this pass; the next archives the new
//      bytes under a new entry);
//   5. `utimes` the partial to the source's mtime, rename it to `<dest>`
//      (same directory), fsync the directory.
//
// The caller appends the manifest entry (step 6). A crash leaves at worst a
// `.partial` (deleted at the next start) or a placed `.gz` with no entry
// (re-verified against its source and adopted; kept under its own entry when
// it decompresses to an earlier version; redone only when it does not
// decompress at all — `adoptOrphan`).
// No temporary name ends in `.jsonl`, so neither the receipt scan nor
// authwatch ever reads a half-written file.
import { createHash, type Hash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readdir, rename, unlink, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Transform, Writable, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import {
  CHUNK_BYTES,
  HashTap,
  PARTIAL_SUFFIX,
  RateLimit,
  fsyncDir,
  fsyncFile,
  gunzipDigest,
  identityOf,
  partialOf,
  renameNoReplace,
  sameIdentity,
  unlinkIfPresent,
  type FileIdentity,
} from "./fsutil.js";

/** The suffix a file being RESTORED carries in its live directory. It does
 * not end in `.jsonl`, so the receipt scan and authwatch never read it. It
 * sits only in LIVE directories, which the archive-dir stray sweep never
 * walks; crash recovery removes it by name (`removeRestorePartial`). */
export const RESTORE_PARTIAL_SUFFIX = ".restore-partial";
export const restorePartialOf = (path: string): string => `${path}${RESTORE_PARTIAL_SUFFIX}`;

/** A step the protocol announces (a test seam for crash injection). */
export type StepFn = (name: string, info: Record<string, unknown>) => void | Promise<void>;

/** A pass-through that hashes the first `limit` bytes it sees. */
class PrefixTap extends Transform {
  private readonly hash: Hash = createHash("sha256");
  private seen = 0;
  constructor(private readonly limit: number) {
    super();
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    if (this.seen < this.limit) {
      const take = Math.min(chunk.length, this.limit - this.seen);
      this.hash.update(take === chunk.length ? chunk : chunk.subarray(0, take));
      this.seen += take;
    }
    cb(null, chunk);
  }
  /** The prefix's sha256, or null when fewer than `limit` bytes passed. */
  digest(): string | null {
    return this.seen === this.limit ? this.hash.digest("hex") : null;
  }
}

export interface ArchiveFileOk {
  kind: "ok";
  bytes: number;
  sha256: string;
  gzBytes: number;
  /** sha256 of the first `prefixBytes` bytes (null when the file is shorter
   * or none was asked for). */
  prefixSha256: string | null;
  identity: FileIdentity;
}

export type ArchiveFileResult =
  ArchiveFileOk | { kind: "verify_failed"; detail: string } | { kind: "changed"; detail: string };

export interface ArchiveFileOpts {
  level: number;
  bytesPerS: number;
  signal?: AbortSignal;
  /** The source's identity, `lstat`ed by the caller (step 1). */
  identity: FileIdentity;
  /** Also hash this many leading bytes (§7.5). */
  prefixBytes?: number;
  step?: StepFn;
}

/** Archive `src` as the gzip `dest` (steps 2–5 above). */
export async function archiveFile(
  src: string,
  dest: string,
  opts: ArchiveFileOpts,
): Promise<ArchiveFileResult> {
  const partial = partialOf(dest);
  await mkdir(dirname(dest), { recursive: true });
  const tap = new HashTap();
  const prefix = opts.prefixBytes !== undefined ? new PrefixTap(opts.prefixBytes) : null;
  const stages: NodeJS.ReadWriteStream[] = [new RateLimit(opts.bytesPerS, opts.signal), tap];
  if (prefix) stages.push(prefix);
  await pipeline(
    createReadStream(src, { highWaterMark: CHUNK_BYTES }),
    ...(stages as [Transform, ...Transform[]]),
    createGzip({ level: opts.level }),
    createWriteStream(partial),
    { signal: opts.signal },
  );
  await fsyncFile(partial);
  const bytes = tap.bytes;
  const sha256 = tap.digest();
  await opts.step?.("partial_written", { src, dest, partial });
  // Step 3: the partial decompresses to exactly what was read. A gzip that
  // does not even decompress (a corrupt byte trips its CRC) is the same
  // verdict, never an I/O failure.
  let back: { bytes: number; sha256: string } | Error;
  try {
    back = await gunzipDigest(partial, { bytesPerS: opts.bytesPerS, signal: opts.signal });
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    back = err as Error;
  }
  if (back instanceof Error || back.bytes !== bytes || back.sha256 !== sha256) {
    await unlinkIfPresent(partial);
    return {
      kind: "verify_failed",
      detail:
        back instanceof Error
          ? `${partial} does not decompress (${back.message})`
          : `${partial} decompressed to ${back.bytes} bytes / ${back.sha256.slice(0, 12)}…, the source read ${bytes} / ${sha256.slice(0, 12)}…`,
    };
  }
  // Step 4: the source is still the file that was hashed.
  const now = await identityOrNull(src);
  if (!sameIdentity(opts.identity, now) || bytes !== opts.identity.size) {
    await unlinkIfPresent(partial);
    return {
      kind: "changed",
      detail: `${src} changed while it was archived (${describe(opts.identity)} → ${describe(now)}, ${bytes} bytes read)`,
    };
  }
  // Step 5: the original mtime, then into place, durably.
  const mtime = opts.identity.mtimeMs / 1000;
  await utimes(partial, mtime, mtime);
  await rename(partial, dest);
  await fsyncDir(dirname(dest));
  await opts.step?.("renamed", { src, dest });
  const gz = await lstat(dest);
  return {
    kind: "ok",
    bytes,
    sha256,
    gzBytes: gz.size,
    prefixSha256: prefix?.digest() ?? null,
    identity: opts.identity,
  };
}

const describe = (id: FileIdentity | null): string =>
  id ? `dev ${id.dev} ino ${id.ino} ${id.size} B mtime ${id.mtimeMs}` : "gone";

/** `identityOf`, with a missing file as null. */
export async function identityOrNull(path: string): Promise<FileIdentity | null> {
  try {
    return await identityOf(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Stream a plain file's length, sha256 and (optionally) its prefix's. */
export async function fileDigestWithPrefix(
  path: string,
  opts: { bytesPerS: number; signal?: AbortSignal; prefixBytes?: number; gz?: boolean },
): Promise<{ bytes: number; sha256: string; prefixSha256: string | null }> {
  const tap = new HashTap();
  const prefix = opts.prefixBytes !== undefined ? new PrefixTap(opts.prefixBytes) : null;
  const stages: Transform[] = [new RateLimit(opts.bytesPerS, opts.signal)];
  if (opts.gz) stages.push(createGunzip());
  stages.push(tap);
  if (prefix) stages.push(prefix);
  const sink = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
  await pipeline(
    createReadStream(path, { highWaterMark: CHUNK_BYTES }),
    ...(stages as [Transform, ...Transform[]]),
    sink,
    { signal: opts.signal },
  );
  return { bytes: tap.bytes, sha256: tap.digest(), prefixSha256: prefix?.digest() ?? null };
}

/** Is `err` zlib refusing the stream (a `Z_*` code: bad header, bad data, a
 * truncated end) — as opposed to the file not being readable? */
function isZlibError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.startsWith("Z_");
}

/** What an orphan gzip turned out to be (`adoptOrphan`). */
export type OrphanResult =
  /** It decompresses to exactly the live source's bytes: adopted as is. */
  | ArchiveFileOk
  /** It decompresses cleanly to OTHER bytes — an earlier version of the
   * source, verified before it was placed. Left in place for the caller to
   * keep under its own entry (or remove as a proven duplicate). */
  | { kind: "stale"; bytes: number; sha256: string; gzBytes: number; mtimeMs: number }
  /** zlib refuses its bytes: removed (nothing readable is lost). */
  | { kind: "corrupt"; detail: string }
  /** The source changed while it was read: nothing decided, left as found. */
  | { kind: "changed"; detail: string };

/**
 * A placed `.gz` with no manifest entry — a crash between the rename and the
 * entry (§7.6). Re-verified against its source: when the gzip decompresses to
 * exactly the source's bytes and the source did not change meanwhile, it is
 * adopted (the caller writes the entry, nothing is recompressed). A gzip that
 * decompresses cleanly to OTHER bytes is never deleted here: it was verified
 * against its source before its rename, so it holds an earlier version of
 * that source that may exist nowhere else (`stale`). Only one zlib refuses
 * is removed, for the caller to redo; one that cannot be READ (a permission
 * or I/O error) is left as found and the error thrown.
 */
export async function adoptOrphan(
  src: string,
  gz: string,
  opts: { identity: FileIdentity; bytesPerS: number; signal?: AbortSignal; prefixBytes?: number },
): Promise<OrphanResult> {
  const [live, packed] = await Promise.all([
    fileDigestWithPrefix(src, {
      bytesPerS: opts.bytesPerS,
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.prefixBytes !== undefined ? { prefixBytes: opts.prefixBytes } : {}),
    }),
    gunzipDigest(gz, { bytesPerS: opts.bytesPerS, signal: opts.signal }).catch((err: Error) => {
      if (opts.signal?.aborted) throw err;
      // Only zlib saying the bytes do not decompress proves corruption; a
      // read that failed (EACCES, EIO) proves nothing, and the gzip may hold
      // the only copy of an earlier version: it stays, the pass fails.
      if (!isZlibError(err)) throw err;
      return err;
    }),
  ]);
  if (packed instanceof Error) {
    await unlinkIfPresent(gz);
    await fsyncDir(dirname(gz));
    return { kind: "corrupt", detail: `${gz} does not decompress (${packed.message})` };
  }
  const now = await identityOrNull(src);
  if (!sameIdentity(opts.identity, now) || live.bytes !== opts.identity.size)
    return {
      kind: "changed",
      detail: `${src} changed while its orphan gzip was checked (${describe(opts.identity)} → ${describe(now)})`,
    };
  const st = await lstat(gz);
  if (packed.bytes === live.bytes && packed.sha256 === live.sha256)
    return {
      kind: "ok",
      bytes: live.bytes,
      sha256: live.sha256,
      gzBytes: st.size,
      prefixSha256: live.prefixSha256,
      identity: opts.identity,
    };
  return {
    kind: "stale",
    bytes: packed.bytes,
    sha256: packed.sha256,
    gzBytes: st.size,
    mtimeMs: st.mtimeMs,
  };
}

export type RestoreFileResult =
  | { kind: "restored"; identity: FileIdentity }
  | { kind: "mismatch"; detail: string }
  | { kind: "exists" };

/** Run `fn`; if it throws, remove `partial` first (a failed restore leaves no
 * `.restore-partial` behind in a LIVE directory), then rethrow. */
async function cleaningPartial<T>(partial: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    await unlinkIfPresent(partial).catch(() => false);
    throw err;
  }
}

/**
 * Put `bytes`/`sha256` back at `target` from the gzip `gz` (§8.2):
 * `<target>.restore-partial`, sha verified, fsync, `utimes` to the original
 * mtime, renamed into place WITHOUT replacing anything that appeared there,
 * the directory fsynced. The caller decided `target` was absent. A failure
 * removes the partial before it is reported; only a crash (or `step`) can
 * leave one, and crash recovery sweeps those.
 */
export async function restoreFromGzip(
  gz: string,
  target: string,
  expect: { bytes: number; sha256: string; mtime_ms: number },
  opts: { bytesPerS: number; signal?: AbortSignal; step?: StepFn },
): Promise<RestoreFileResult> {
  const partial = restorePartialOf(target);
  await mkdir(dirname(target), { recursive: true });
  const tap = new HashTap();
  await cleaningPartial(partial, () =>
    pipeline(
      createReadStream(gz, { highWaterMark: CHUNK_BYTES }),
      new RateLimit(opts.bytesPerS, opts.signal),
      createGunzip(),
      tap,
      createWriteStream(partial),
      { signal: opts.signal },
    ),
  );
  // Outside the clean-up: a test's crash here leaves the partial, as a real
  // crash would.
  await opts.step?.("restore_partial_written", { target, partial });
  return placeRestored(partial, target, { bytes: tap.bytes, sha256: tap.digest() }, expect);
}

/** The same, from bytes already read out of a bundle (and verified there). */
export async function restoreFromBytes(
  data: Buffer,
  target: string,
  expect: { bytes: number; sha256: string; mtime_ms: number },
  opts: { step?: StepFn } = {},
): Promise<RestoreFileResult> {
  const partial = restorePartialOf(target);
  await mkdir(dirname(target), { recursive: true });
  await cleaningPartial(partial, () => writeFile(partial, data));
  const sha256 = createHash("sha256").update(data).digest("hex");
  await opts.step?.("restore_partial_written", { target, partial });
  return placeRestored(partial, target, { bytes: data.length, sha256 }, expect);
}

function placeRestored(
  partial: string,
  target: string,
  got: { bytes: number; sha256: string },
  expect: { bytes: number; sha256: string; mtime_ms: number },
): Promise<RestoreFileResult> {
  return cleaningPartial(partial, async () => {
    if (got.bytes !== expect.bytes || got.sha256 !== expect.sha256) {
      await unlinkIfPresent(partial);
      return {
        kind: "mismatch",
        detail: `${target}: the archive gave ${got.bytes} bytes / ${got.sha256.slice(0, 12)}…, the manifest records ${expect.bytes} / ${expect.sha256.slice(0, 12)}…`,
      };
    }
    await fsyncFile(partial);
    const mtime = expect.mtime_ms / 1000;
    await utimes(partial, mtime, mtime);
    if ((await renameNoReplace(partial, target)) === "exists") {
      await unlinkIfPresent(partial);
      return { kind: "exists" };
    }
    await fsyncDir(dirname(target));
    const identity = await identityOf(target);
    if (!identity) throw new Error(`${target} is not a regular file after its restore`);
    return { kind: "restored", identity };
  });
}

/** Remove a stray `.restore-partial` (a crash mid-restore). */
export async function removeRestorePartial(target: string): Promise<boolean> {
  return unlinkIfPresent(restorePartialOf(target));
}

/** Unlink `path` only if it still has `identity` (the re-`lstat` before every
 * unlink, §7.3). Returns what happened. */
export async function unlinkIfIdentity(
  path: string,
  identity: { dev: number | null; ino: number | null; bytes: number; mtime_ms: number },
): Promise<"removed" | "gone" | "changed"> {
  const now = await identityOrNull(path);
  if (!now) return "gone";
  if (
    identity.dev === null ||
    identity.ino === null ||
    now.dev !== identity.dev ||
    now.ino !== identity.ino ||
    now.size !== identity.bytes ||
    now.mtimeMs !== identity.mtime_ms
  )
    return "changed";
  try {
    await unlink(path);
    return "removed";
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "gone";
    throw err;
  }
}

/** Delete every stray `*.partial` under an ARCHIVE dir (recursive; a missing
 * dir is nothing to do). Only archive dirs hold them, and only the archiver,
 * under its strict mutex, writes there — so one found outside a step in
 * flight is a leftover (§7.6). */
export async function sweepPartials(dir: string): Promise<number> {
  let n = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) n += await sweepPartials(p);
    else if (e.isFile() && e.name.endsWith(PARTIAL_SUFFIX)) {
      if (await unlinkIfPresent(p)) n += 1;
    }
  }
  return n;
}

// The archiver's file primitives (docs/archiving.md §6, §9.3, §9.5):
// every one async — file I/O and fsync through `fs.promises` (the libuv
// threadpool), gzip on node:zlib's async streams (also the threadpool), a
// token-bucket rate cap, and the atomic tmp + fsync + rename +
// directory-fsync write the manifests use. Hashing runs on the event loop's
// thread, one stream chunk at a time.
//
// A temporary name always ends in `.partial` (never `.jsonl`), so crash
// recovery can delete strays by suffix and neither the receipt scan nor
// authwatch ever reads a half-written file.
import { createHash, type Hash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { link, lstat, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Transform, Writable, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";

/** The suffix every in-progress archive file carries. */
export const PARTIAL_SUFFIX = ".partial";

/** Read chunks of 1 MiB (§7.3). */
export const CHUNK_BYTES = 1024 * 1024;

/** fsync one file (its data and metadata) on the threadpool. */
export async function fsyncFile(path: string): Promise<void> {
  const fh = await open(path, "r");
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/** fsync a directory, so a rename or a new entry in it is durable. */
export async function fsyncDir(dir: string): Promise<void> {
  const fh = await open(dir, "r");
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/** Unlink `path`; a missing file is not an error. */
export async function unlinkIfPresent(path: string): Promise<boolean> {
  try {
    await unlink(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Write JSON atomically: `<path>.partial`, fsync, rename over `<path>`, fsync
 * the directory. A crash leaves either the old file or the new one, never a
 * torn one (and at worst a stray `.partial` that recovery deletes).
 */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeTextAtomic(path, `${JSON.stringify(value, null, 1)}\n`);
}

/** The same for text already serialised (a caller that measures its own
 * synchronous stringify). */
export async function writeTextAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}${PARTIAL_SUFFIX}`;
  const fh = await open(tmp, "w");
  try {
    await fh.writeFile(text, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, path);
  await fsyncDir(dirname(path));
}

/** Codes for a filesystem that cannot make a hard link. */
const NO_LINK = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"]);

/**
 * Move `from` to `to` WITHOUT replacing anything already at `to`: a hard link
 * (which fails on EEXIST), then the old name unlinked. Returns "exists" — with
 * `from` left in place — when `to` is taken. On a filesystem without hard
 * links it checks, then renames (the archiver is the only writer in its
 * directory, under its strict mutex). A crash between the link and the unlink
 * leaves both names on one inode, which recovery's stray-partial sweep tidies.
 */
export async function renameNoReplace(from: string, to: string): Promise<"placed" | "exists"> {
  try {
    await link(from, to);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "";
    if (code === "EEXIST") return "exists";
    if (!NO_LINK.has(code)) throw err;
    try {
      await lstat(to);
      return "exists";
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    await rename(from, to);
    return "placed";
  }
  await unlink(from);
  return "placed";
}

/** A file's identity: a change in any of these between the hash and the
 * unlink means the bytes hashed may not be the bytes on disk. */
export interface FileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

/** `lstat` as an identity; null when the path is not a regular file. */
export async function identityOf(path: string): Promise<FileIdentity | null> {
  const st = await lstat(path);
  if (!st.isFile()) return null;
  return { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs };
}

export const sameIdentity = (a: FileIdentity | null, b: FileIdentity | null): boolean =>
  a !== null &&
  b !== null &&
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs;

/** A pass-through that hashes and counts what flows by. */
export class HashTap extends Transform {
  private readonly hash: Hash = createHash("sha256");
  bytes = 0;
  private digestHex: string | null = null;

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.hash.update(chunk);
    this.bytes += chunk.length;
    cb(null, chunk);
  }

  /** The sha256 of everything that passed (valid once the stream ended). */
  digest(): string {
    this.digestHex ??= this.hash.digest("hex");
    return this.digestHex;
  }
}

/**
 * A token-bucket rate cap on a stream's throughput: a chunk is passed on no
 * earlier than its share of `bytesPerS` allows. The wait is a timer, so the
 * loop runs other work meanwhile; an abort ends the wait at once.
 */
export class RateLimit extends Transform {
  private sent = 0;
  private readonly started: number;

  constructor(
    private readonly bytesPerS: number,
    private readonly signal?: AbortSignal,
    private readonly clock: () => number = () => Date.now(),
  ) {
    super();
    this.started = clock();
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.sent += chunk.length;
    const due = this.started + (this.sent / this.bytesPerS) * 1000;
    const wait = due - this.clock();
    if (!(wait > 0) || !Number.isFinite(this.bytesPerS) || this.bytesPerS <= 0) {
      cb(null, chunk);
      return;
    }
    if (this.signal?.aborted) {
      cb(this.signal.reason instanceof Error ? this.signal.reason : new Error("aborted"));
      return;
    }
    const t = setTimeout(() => {
      this.signal?.removeEventListener("abort", onAbort);
      cb(null, chunk);
    }, wait);
    const onAbort = (): void => {
      clearTimeout(t);
      cb(this.signal!.reason instanceof Error ? this.signal!.reason : new Error("aborted"));
    };
    this.signal?.addEventListener("abort", onAbort, { once: true });
  }
}

/** A sink that drops what it is handed (the verify read needs only the tap). */
const discard = (): Writable =>
  new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });

export interface GzipResult {
  /** The source's length and sha256, as read. */
  bytes: number;
  sha256: string;
  /** The gzip file's length. */
  gzBytes: number;
}

/**
 * Stream `src` through the rate cap, a sha256 tap and gzip into `dest`, then
 * fsync `dest`. Every byte is read and compressed on the threadpool in 1 MiB
 * chunks; the signal destroys the streams (the partial is the caller's to
 * remove).
 */
export async function gzipFile(
  src: string,
  dest: string,
  opts: { level: number; bytesPerS: number; signal?: AbortSignal },
): Promise<GzipResult> {
  const tap = new HashTap();
  await pipeline(
    createReadStream(src, { highWaterMark: CHUNK_BYTES }),
    new RateLimit(opts.bytesPerS, opts.signal),
    tap,
    createGzip({ level: opts.level }),
    createWriteStream(dest),
    { signal: opts.signal },
  );
  await fsyncFile(dest);
  const gz = await identityOf(dest);
  return { bytes: tap.bytes, sha256: tap.digest(), gzBytes: gz?.size ?? 0 };
}

/** Stream-decompress `gz` and report the length and sha256 of what came out. */
export async function gunzipDigest(
  gz: string,
  opts: { bytesPerS: number; signal?: AbortSignal },
): Promise<{ bytes: number; sha256: string }> {
  const tap = new HashTap();
  await pipeline(
    createReadStream(gz, { highWaterMark: CHUNK_BYTES }),
    new RateLimit(opts.bytesPerS, opts.signal),
    createGunzip(),
    tap,
    discard(),
    { signal: opts.signal },
  );
  return { bytes: tap.bytes, sha256: tap.digest() };
}

/** Stream a plain file's length and sha256. */
export async function fileDigest(
  path: string,
  opts: { bytesPerS: number; signal?: AbortSignal },
): Promise<{ bytes: number; sha256: string }> {
  const tap = new HashTap();
  await pipeline(
    createReadStream(path, { highWaterMark: CHUNK_BYTES }),
    new RateLimit(opts.bytesPerS, opts.signal),
    tap,
    discard(),
    { signal: opts.signal },
  );
  return { bytes: tap.bytes, sha256: tap.digest() };
}

/** `<dir>/<name>` → `<dir>/<name>.partial`. */
export const partialOf = (path: string): string =>
  join(dirname(path), `${basename(path)}${PARTIAL_SUFFIX}`);

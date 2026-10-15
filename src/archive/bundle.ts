// The per-pass BUNDLE (docs/archiving.md §6, §7.3): one gzip of one
// JSON record per small state file, `archive/pr-<n>/state-<pass>.jsonl.gz`.
//
//   {"path":"state/round-prompts/pr-5406-round-2.md","bytes":12345,
//    "mtime_ms":…,"sha256":"…","enc":"utf8","content":"…","class":"round_prompts"}
//
// `enc` is `utf8`, or `base64` for bytes that are not valid UTF-8. A record
// whose bytes equal an EARLIER record in the same bundle carries
// `"same_as":"<path>"` instead of `content` — round prompts and their round
// command payloads are usually byte-identical, so the bytes are stored once.
// `session_command` rides a payload's record (its row's id, kind, round and
// status). A `snapshot` record is a copy of a file that stays live (the PR's
// ledger).
//
// Written like a transcript: the records stream through the rate cap and gzip
// into `<dest>.partial`, fsync; then VERIFIED — the partial is decompressed,
// every line re-parsed, and each record's bytes re-hashed against the sha256
// the source read gave — and only then renamed into place and the directory
// fsynced. Sources are read one at a time with a real event-loop turn between
// them; a record is at most `BUNDLE_RECORD_MAX_BYTES`, so no JSON
// stringify/parse is a long synchronous span (a bigger file is archived as
// its own gzip, kind `file`).
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import { createGunzip, createGzip } from "node:zlib";
import { yieldToLoop } from "../yieldloop.js";
import {
  CHUNK_BYTES,
  RateLimit,
  fsyncDir,
  fsyncFile,
  partialOf,
  renameNoReplace,
  unlinkIfPresent,
  type FileIdentity,
} from "./fsutil.js";
import type { StepFn } from "./gzfile.js";
import type { BundleCommand, BundleFile } from "./manifest.js";
import type { PayloadCommand, SmallClass } from "./prfiles.js";

/** The largest file a bundle carries as a record; a bigger one is archived as
 * its own gzip (so no record's JSON is a long synchronous span). */
export const BUNDLE_RECORD_MAX_BYTES = 1024 * 1024;

export interface BundleSource {
  /** Absolute live path. */
  path: string;
  /** The inventory's class; `ledger` for the snapshot of the PR's ledger. */
  cls: SmallClass | "ledger";
  identity: FileIdentity;
  snapshot?: boolean;
  command?: PayloadCommand;
}

/** One record as it sits in the bundle. */
export interface BundleRecord {
  path: string;
  bytes: number;
  mtime_ms: number;
  sha256: string;
  class: string;
  enc?: "utf8" | "base64";
  content?: string;
  same_as?: string;
  snapshot?: true;
  session_command?: BundleCommand;
}

export type WriteBundleResult =
  | {
      kind: "ok";
      records: number;
      bytes: number;
      gzBytes: number;
      files: BundleFile[];
      /** Sources gone when read, or whose length no longer matched the
       * identity listed (they changed under us): left out, kept live, picked
       * up next pass. A same-length rewrite is not caught here — the identity
       * re-check before each unlink keeps that source live. */
      skipped: string[];
    }
  | { kind: "verify_failed"; detail: string }
  | { kind: "empty"; skipped: string[] };

// `ignoreBOM` keeps a leading byte-order mark in the text, so the record's
// content re-encodes to exactly the bytes its length and sha256 were taken of.
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** The bytes as a record encodes them. */
function encode(buf: Buffer): { enc: "utf8" | "base64"; content: string } {
  try {
    return { enc: "utf8", content: UTF8.decode(buf) };
  } catch {
    return { enc: "base64", content: buf.toString("base64") };
  }
}

/** A record's bytes back (for a `same_as` record, the caller resolves). */
export function decodeRecord(r: BundleRecord): Buffer | null {
  if (r.content === undefined) return null;
  return r.enc === "base64" ? Buffer.from(r.content, "base64") : Buffer.from(r.content, "utf8");
}

/**
 * Write the bundle `dest` from `sources` (absolute paths, each record named
 * by its path relative to `root`), then verify it, then place it. Returns what it holds; a verify failure deletes
 * the partial and leaves every source in place.
 */
export async function writeBundle(
  dest: string,
  root: string,
  sources: readonly BundleSource[],
  opts: { level: number; bytesPerS: number; signal?: AbortSignal; step?: StepFn },
): Promise<WriteBundleResult> {
  const partial = partialOf(dest);
  const files: BundleFile[] = [];
  const skipped: string[] = [];
  const shaOf = new Map<string, string>(); // record path → sha256
  const firstBySha = new Map<string, string>(); // sha256 → first record path
  let bytes = 0;
  async function* lines(): AsyncGenerator<string> {
    for (const s of sources) {
      opts.signal?.throwIfAborted();
      await yieldToLoop();
      let buf: Buffer;
      try {
        buf = await readFile(s.path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          skipped.push(s.path);
          continue;
        }
        throw err;
      }
      if (buf.length !== s.identity.size) {
        skipped.push(s.path);
        continue;
      }
      const rel = relative(root, s.path);
      const sha256 = createHash("sha256").update(buf).digest("hex");
      const command: BundleCommand | undefined = s.command
        ? {
            id: s.command.id,
            kind: s.command.kind,
            round_no: s.command.round_no,
            status: s.command.status,
            payload_sha256_ok: s.command.payload_sha256 === sha256,
          }
        : undefined;
      // What the record and the manifest's entry both say of the source.
      const facts = {
        path: rel,
        bytes: buf.length,
        mtime_ms: s.identity.mtimeMs,
        sha256,
        class: s.cls,
        ...(s.snapshot ? { snapshot: true as const } : {}),
        ...(command ? { session_command: command } : {}),
      };
      const record: BundleRecord = { ...facts };
      const twin = firstBySha.get(sha256);
      if (twin !== undefined) record.same_as = twin;
      else {
        Object.assign(record, encode(buf));
        firstBySha.set(sha256, rel);
      }
      shaOf.set(rel, sha256);
      bytes += buf.length;
      files.push({ ...facts, dev: s.identity.dev, ino: s.identity.ino });
      yield `${JSON.stringify(record)}\n`;
    }
  }
  // The PR's archive dir may not exist yet (a pass with no transcript).
  await mkdir(dirname(dest), { recursive: true });
  await pipeline(
    Readable.from(lines()),
    new RateLimit(opts.bytesPerS, opts.signal),
    createGzip({ level: opts.level }),
    createWriteStream(partial),
    { signal: opts.signal },
  );
  if (files.length === 0) {
    await unlinkIfPresent(partial);
    return { kind: "empty", skipped };
  }
  await fsyncFile(partial);
  await opts.step?.("partial_written", { dest, partial });
  const check = await verifyBundle(partial, shaOf, opts);
  if (check !== null) {
    await unlinkIfPresent(partial);
    return { kind: "verify_failed", detail: check };
  }
  if ((await renameNoReplace(partial, dest)) === "exists") {
    await unlinkIfPresent(partial);
    throw new Error(`${dest} already exists — a bundle name is never reused`);
  }
  await fsyncDir(dirname(dest));
  await opts.step?.("renamed", { dest });
  const gz = await lstat(dest);
  return { kind: "ok", records: files.length, bytes, gzBytes: gz.size, files, skipped };
}

/** Stream a bundle's lines (gunzip, rate-capped), parsing each, one real
 * event-loop turn per chunk. */
async function eachRecord(
  gz: string,
  opts: { bytesPerS: number; signal?: AbortSignal },
  fn: (r: BundleRecord) => void,
): Promise<void> {
  const decoder = new StringDecoder("utf8");
  let carry = "";
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      try {
        const text = carry + decoder.write(chunk);
        const parts = text.split("\n");
        carry = parts.pop() ?? "";
        for (const line of parts) if (line.length > 0) fn(JSON.parse(line) as BundleRecord);
        setImmediate(cb);
      } catch (err) {
        cb(err as Error);
      }
    },
    final(cb) {
      try {
        const rest = carry + decoder.end();
        if (rest.trim().length > 0) fn(JSON.parse(rest) as BundleRecord);
        cb();
      } catch (err) {
        cb(err as Error);
      }
    },
  });
  await pipeline(
    createReadStream(gz, { highWaterMark: CHUNK_BYTES }),
    new RateLimit(opts.bytesPerS, opts.signal),
    createGunzip(),
    sink,
    { signal: opts.signal },
  );
}

/**
 * Decompress a bundle, re-parse every line and re-hash every record's bytes
 * (a `same_as` record against the record it names). With `expected`, each
 * record's sha256 must also be the one its source read gave, and every
 * expected path must be there. Returns null when it verifies, else why; an
 * abort throws.
 */
export async function verifyBundle(
  gz: string,
  expected: ReadonlyMap<string, string> | null,
  opts: { bytesPerS: number; signal?: AbortSignal },
): Promise<string | null> {
  const seen = new Map<string, string>();
  let problem: string | null = null;
  try {
    await eachRecord(gz, opts, (r) => {
      if (problem) return;
      const why = recordProblem(r, seen);
      if (why) {
        problem = why;
        return;
      }
      seen.set(r.path, r.sha256);
      if (expected && expected.get(r.path) !== r.sha256)
        problem = `${r.path}: the bundle holds ${r.sha256.slice(0, 12)}…, the source read ${expected.get(r.path)?.slice(0, 12) ?? "nothing"}`;
    });
  } catch (err) {
    // A stop is not a verdict on the bundle: it propagates, as in the
    // per-file protocol.
    if (opts.signal?.aborted) throw err;
    return `${gz}: ${(err as Error).message}`;
  }
  if (problem) return problem;
  if (expected)
    for (const path of expected.keys())
      if (!seen.has(path)) return `${path}: missing from the bundle`;
  return null;
}

function recordProblem(r: BundleRecord, seen: ReadonlyMap<string, string>): string | null {
  if (typeof r.path !== "string" || typeof r.sha256 !== "string" || typeof r.bytes !== "number")
    return "a record is not a bundle record";
  if (r.same_as !== undefined) {
    const twin = seen.get(r.same_as);
    if (twin === undefined) return `${r.path}: same_as ${r.same_as}, which no earlier record is`;
    if (twin !== r.sha256) return `${r.path}: same_as ${r.same_as}, whose bytes differ`;
    return null;
  }
  const buf = decodeRecord(r);
  if (!buf) return `${r.path}: no content`;
  if (buf.length !== r.bytes) return `${r.path}: ${buf.length} bytes, the record says ${r.bytes}`;
  const sha = createHash("sha256").update(buf).digest("hex");
  if (sha !== r.sha256)
    return `${r.path}: content hashes to ${sha.slice(0, 12)}…, the record says ${r.sha256.slice(0, 12)}…`;
  return null;
}

/**
 * The verified bytes of the records `want` names (every record when null),
 * with `same_as` resolved. Throws when the bundle does not verify.
 */
export async function readBundleRecords(
  gz: string,
  want: ReadonlySet<string> | null,
  opts: { bytesPerS: number; signal?: AbortSignal },
): Promise<Map<string, { record: BundleRecord; data: Buffer }>> {
  const seen = new Map<string, string>();
  const bySha = new Map<string, Buffer>();
  const out = new Map<string, { record: BundleRecord; data: Buffer }>();
  await eachRecord(gz, opts, (r) => {
    const why = recordProblem(r, seen);
    if (why) throw new Error(`${gz}: ${why}`);
    seen.set(r.path, r.sha256);
    let data: Buffer | null = null;
    if (r.same_as === undefined) {
      data = decodeRecord(r)!;
      // Kept only while a later record may name it, or the caller wants it.
      bySha.set(r.sha256, data);
    } else data = bySha.get(r.sha256) ?? null;
    if (want === null || want.has(r.path)) {
      if (!data) throw new Error(`${gz}: ${r.path} could not be resolved`);
      out.set(r.path, { record: r, data });
    }
  });
  return out;
}

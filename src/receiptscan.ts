// The receipt scan, read without blocking the event loop.
//
// A receipt is a fact: the daemon stamps a token into a wake, and pi writes the
// user message it ACCEPTED — token included — into the session JSONL. Present
// = delivered, absent = never arrived, unreadable = unknown. This module only
// decides how the bytes are read.
//
// Reconcile asks once per recheck claim, and many claims are re-proven every
// pass, so reading each in-scope JSONL whole for every query decodes gigabytes
// of transcripts in one synchronous span and blocks the loop for minutes.
//
// This index reads each byte of a session file AT MOST ONCE per daemon
// lifetime:
//
//   - The receipt tokens all share one shape, `<!-- qcr-… -->` (round,
//     recheck and session-command markers alike). A file is scanned once for
//     EVERY such token, and the set of tokens found is kept with the offset the
//     scan reached. A later query for any token is a set lookup; a file that
//     grew is scanned only from where the last scan stopped. A file that
//     shrank, was replaced (dev/ino), or whose last ≤ 511 bytes before the old
//     end changed (the tail check) is rescanned from 0.
//   - That rests on one assumption: a session file is APPEND-ONLY — pi
//     writes its session JSONL by appending entries, and nothing rewrites one
//     in place (VERIFY-ON-PIN: pi 1.0.0's session manager
//     was not at hand to check). The checks above catch the rewrites that
//     break it visibly — shorter, replaced, or changed just before the old
//     end — and nothing more. A file whose dev, ino, size and mtime are all
//     unchanged is trusted without a read; one rewritten in place to at least
//     its old length whose tail window still matches is trusted as an append,
//     its earlier bytes never re-read — a token removed there still reads
//     present, one added there reads ABSENT. Re-reading the whole file to rule
//     that out is exactly the cost this index exists to remove.
//   - Bytes are searched raw (`Buffer.indexOf` on the ASCII prefix), never
//     decoded: the tokens are deliberately plain ASCII, so they survive JSON
//     string encoding byte for byte, a byte match is exactly a substring
//     match on the decoded text (no per-line parsing, no partial-write
//     hazard), and it is ~4x cheaper than a utf8 decode.
//   - Reads are async, in chunks of RECEIPT_CHUNK_BYTES with a real
//     event-loop turn between them, so no file — however large — is one
//     synchronous span.
//   - Concurrent queries for one file share one scan.
//
// A query marker that is not of the token shape (none in production) falls
// back to a streamed search of its own, chunked the same way and not cached.
//
// The scope rule: a file counts for a query only if its mtime is at or after
// `sinceMs - RECEIPT_SCOPE_SLACK_MS`, and only `.jsonl` files under the
// session dir are read. A readdir or stat failure anywhere, or a failed read of an in-scope file, makes an absent marker
// UNKNOWN.

import { open, readdir, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { join } from "node:path";

/** The shape every receipt token has (`roundPromptMarker`,
 * `recheckPromptMarker`, `sessionCommandMarker`). */
export const RECEIPT_TOKEN_PREFIX = "<!-- qcr-";
export const RECEIPT_TOKEN_SUFFIX = " -->";
/** A token longer than this is not indexed (the real ones are ~60-130 bytes). */
export const RECEIPT_TOKEN_MAX_BYTES = 512;
/** One synchronous search step: ~0.5 ms of `indexOf` on this PC. */
export const RECEIPT_CHUNK_BYTES = 1 << 20;
/** Files whose token sets are kept; the oldest-touched is dropped past it. */
export const RECEIPT_INDEX_MAX_FILES = 4096;
/** The scope slack: coarse mtimes and small clock skew. */
export const RECEIPT_SCOPE_SLACK_MS = 60_000;

const PREFIX = Buffer.from(RECEIPT_TOKEN_PREFIX, "latin1");
const SUFFIX = Buffer.from(RECEIPT_TOKEN_SUFFIX, "latin1");
const OVERLAP = RECEIPT_TOKEN_MAX_BYTES - 1;

/** The answer for one query. `unreadable` says an I/O failure made an absent
 * marker unknown — the caller logs it (it is the durable trace of a scan that
 * can never conclude). */
export interface ReceiptAnswer {
  answer: boolean | null;
  unreadable: boolean;
}

export interface ReceiptIndexStats {
  /** Bytes read from disk since the index was made. */
  bytes_read: number;
  /** Files scanned from offset 0 (first sight, or a rewrite). */
  full_scans: number;
  /** Files scanned from where the last scan stopped. */
  incremental_scans: number;
  /** Queries answered without reading a byte of a file. */
  hits: number;
  /** Files currently indexed. */
  files: number;
}

interface FileEntry {
  dev: number;
  ino: number;
  mtimeMs: number;
  /** Bytes [0, scanned) have been searched. */
  scanned: number;
  /** The last ≤ OVERLAP bytes before `scanned` — re-read and compared before
   * an incremental scan, so a rewrite that changes them is rescanned from 0.
   * Bytes before this window are not compared (the append-only assumption in
   * the header). */
  tail: Buffer;
  /** Every receipt token found in [0, scanned). */
  tokens: Set<string>;
}

/** Can `marker` be answered from the token index? Only when finding it as a
 * token is exactly a substring test: the token prefix, the suffix only
 * at its end (so the first suffix after the prefix is its own), ASCII, and
 * short enough to be indexed. */
export function indexableMarker(marker: string): boolean {
  if (marker.length > RECEIPT_TOKEN_MAX_BYTES) return false;
  if (!marker.startsWith(RECEIPT_TOKEN_PREFIX)) return false;
  if (marker.indexOf(RECEIPT_TOKEN_SUFFIX) !== marker.length - RECEIPT_TOKEN_SUFFIX.length)
    return false;
  if (marker.length < RECEIPT_TOKEN_PREFIX.length + RECEIPT_TOKEN_SUFFIX.length) return false;
  for (let i = 0; i < marker.length; i++) if (marker.charCodeAt(i) > 0x7e) return false;
  return true;
}

/** Every receipt token in `window`. A token cut off by the end of the window
 * is found again in the next one (the caller carries OVERLAP bytes over). */
function collectTokens(window: Buffer, into: Set<string>): void {
  let at = window.indexOf(PREFIX, 0);
  while (at !== -1) {
    // The suffix is looked for only inside the token's own bound, so a stray
    // prefix with no suffix costs RECEIPT_TOKEN_MAX_BYTES, never the window.
    const from = at + PREFIX.length;
    const rel = window
      .subarray(from, Math.min(window.length, at + RECEIPT_TOKEN_MAX_BYTES))
      .indexOf(SUFFIX);
    if (rel !== -1) into.add(window.toString("latin1", at, from + rel + SUFFIX.length));
    at = window.indexOf(PREFIX, at + 1);
  }
}

export class ReceiptIndex {
  private readonly files = new Map<string, FileEntry>();
  private readonly inflight = new Map<string, Promise<FileEntry>>();
  private readonly chunkBytes: number;
  private readonly maxFiles: number;
  private readonly counters = { bytes_read: 0, full_scans: 0, incremental_scans: 0, hits: 0 };

  constructor(opts: { chunkBytes?: number; maxFiles?: number } = {}) {
    // Never smaller than the overlap: a window must be able to hold a token.
    this.chunkBytes = Math.max(opts.chunkBytes ?? RECEIPT_CHUNK_BYTES, RECEIPT_TOKEN_MAX_BYTES);
    this.maxFiles = Math.max(1, opts.maxFiles ?? RECEIPT_INDEX_MAX_FILES);
  }

  stats(): ReceiptIndexStats {
    return { ...this.counters, files: this.files.size };
  }

  /**
   * Did a wake carrying `marker` reach the session whose JSONL lives under
   * `root`? true = present in an in-scope file; false = in-scope files were
   * read and none holds it; null = cannot tell (no session dir, nothing in
   * scope, or an I/O failure — `unreadable` then says so).
   */
  async present(root: string, marker: string, sinceMs: number): Promise<ReceiptAnswer> {
    try {
      // `existsSync` semantics: any failure to stat the root is "no session".
      await stat(root);
    } catch {
      return { answer: null, unreadable: false };
    }
    // A file is in scope if it could contain a write made after the wake. The
    // slack absorbs coarse mtimes and small clock differences; being generous
    // costs a few extra reads, being tight would report a delivered wake as
    // lost.
    const floor = sinceMs - RECEIPT_SCOPE_SLACK_MS;
    const indexed = indexableMarker(marker);
    // An I/O failure anywhere in the scan makes an absent marker UNKNOWN, and
    // unknown is never read as loss: a `false` here, once redelivery is spent,
    // kills a live conversation. A failed read never aborts the scan — the
    // marker may still be in the next file.
    let unreadable = false;
    let sawCandidate = false;
    const walk = async (dir: string): Promise<boolean> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        unreadable = true;
        return false;
      }
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          if (await walk(full)) return true;
          continue;
        }
        if (!e.name.endsWith(".jsonl")) continue;
        let st: Stats;
        try {
          st = await stat(full);
        } catch {
          // Cannot even tell whether this file is in scope.
          unreadable = true;
          continue;
        }
        if (st.mtimeMs < floor) continue;
        let found: boolean;
        try {
          // A directory or a FIFO named `.jsonl` cannot be read as a file —
          // unknown, never absence (and never a read that blocks forever).
          if (!st.isFile()) throw new Error(`not a regular file: ${full}`);
          found = indexed
            ? (await this.tokensOf(full, st)).has(marker)
            : await this.streamContains(full, st, marker);
        } catch {
          // An unreadable file is not evidence of absence.
          unreadable = true;
          continue;
        }
        if (found) return true;
        sawCandidate = true;
      }
      return false;
    };
    if (await walk(root)) return { answer: true, unreadable };
    if (unreadable) return { answer: null, unreadable: true };
    return { answer: sawCandidate ? false : null, unreadable: false };
  }

  /** The token set of `path`, brought up to date with the file as `st` saw it. */
  private async tokensOf(path: string, st: Stats): Promise<Set<string>> {
    for (;;) {
      const running = this.inflight.get(path);
      if (!running) break;
      try {
        await running;
      } catch {
        /* the scan that failed is its own caller's answer */
      }
    }
    const cached = this.files.get(path);
    // Unchanged identity, size and mtime: trusted as unchanged, no byte read.
    if (
      cached &&
      cached.dev === st.dev &&
      cached.ino === st.ino &&
      cached.mtimeMs === st.mtimeMs &&
      cached.scanned === st.size
    ) {
      this.counters.hits++;
      this.touch(path, cached);
      return cached.tokens;
    }
    const scan = this.scan(path, st, cached);
    this.inflight.set(path, scan);
    try {
      const entry = await scan;
      this.touch(path, entry);
      return entry.tokens;
    } catch (err) {
      this.files.delete(path);
      throw err;
    } finally {
      this.inflight.delete(path);
    }
  }

  private touch(path: string, entry: FileEntry): void {
    this.files.delete(path);
    this.files.set(path, entry);
    while (this.files.size > this.maxFiles) {
      const oldest = this.files.keys().next().value;
      if (oldest === undefined) break;
      this.files.delete(oldest);
    }
  }

  private async scan(path: string, st: Stats, cached: FileEntry | undefined): Promise<FileEntry> {
    const fh = await open(path, "r");
    try {
      const buf = Buffer.allocUnsafe(OVERLAP + this.chunkBytes);
      let tokens = new Set<string>();
      let pos = 0;
      let have = 0;
      if (cached && cached.dev === st.dev && cached.ino === st.ino && st.size >= cached.scanned) {
        // Append-only growth: verify the window of bytes just before the old
        // end is the one the last scan saw, then continue from there with it as
        // the carry. Bytes before the window are trusted, not re-read.
        const tailLen = cached.tail.length;
        const { bytesRead } = await fh.read(buf, 0, tailLen, cached.scanned - tailLen);
        this.counters.bytes_read += bytesRead;
        if (bytesRead === tailLen && buf.compare(cached.tail, 0, tailLen, 0, tailLen) === 0) {
          tokens = new Set(cached.tokens);
          pos = cached.scanned;
          have = tailLen;
          this.counters.incremental_scans++;
        } else {
          this.counters.full_scans++;
        }
      } else {
        this.counters.full_scans++;
      }
      const end = st.size;
      while (pos < end) {
        const want = Math.min(this.chunkBytes, end - pos);
        const { bytesRead } = await fh.read(buf, have, want, pos);
        if (bytesRead === 0) break; // truncated under us — what was read stands
        pos += bytesRead;
        this.counters.bytes_read += bytesRead;
        const len = have + bytesRead;
        collectTokens(buf.subarray(0, len), tokens);
        const keep = Math.min(OVERLAP, len);
        buf.copy(buf, 0, len - keep, len);
        have = keep;
      }
      return {
        dev: st.dev,
        ino: st.ino,
        mtimeMs: st.mtimeMs,
        scanned: pos,
        tail: Buffer.from(buf.subarray(0, have)),
        tokens,
      };
    } finally {
      await fh.close();
    }
  }

  /** The uncached path for a marker that is not of the token shape. */
  private async streamContains(path: string, st: Stats, marker: string): Promise<boolean> {
    const needle = Buffer.from(marker, "utf8");
    if (needle.length === 0) return true;
    const overlap = needle.length - 1;
    const fh = await open(path, "r");
    try {
      const chunk = Math.max(this.chunkBytes, needle.length);
      const buf = Buffer.allocUnsafe(overlap + chunk);
      let pos = 0;
      let have = 0;
      while (pos < st.size) {
        const { bytesRead } = await fh.read(buf, have, Math.min(chunk, st.size - pos), pos);
        if (bytesRead === 0) break;
        pos += bytesRead;
        this.counters.bytes_read += bytesRead;
        const len = have + bytesRead;
        if (buf.subarray(0, len).indexOf(needle) !== -1) return true;
        const keep = Math.min(overlap, len);
        buf.copy(buf, 0, len - keep, len);
        have = keep;
      }
      return false;
    } finally {
      await fh.close();
    }
  }
}

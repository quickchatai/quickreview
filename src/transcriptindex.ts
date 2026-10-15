// Round transcripts, read off the event loop.
//
// At every round end — the verdict, and the overdue, malformed, posting-receipt
// and self-requeue paths — the daemon measures the round from the pi session
// JSONLs: its token usage and spend and the post-hoc exec-policy audit. A PR's
// session dir can hold tens of megabytes across several files and grows by a
// file at every session rebirth, so reading it synchronously stalls the
// daemon's event loop for seconds.
//
// This index reads each byte of a transcript AT MOST ONCE per daemon lifetime
// (beyond the ≤ 1 KiB head and tail probes below), and never in one
// synchronous span:
//
//   - Reads are async, in chunks of TRANSCRIPT_CHUNK_BYTES. A chunk's complete
//     lines are parsed, then a real event-loop turn is taken (`yieldToLoop`)
//     before the next read, so no file — however large — is one synchronous
//     span. The unit of parsing is a LINE: a single line longer than a chunk is
//     parsed in one piece when its newline arrives (JSON.parse cannot be
//     split), which pi's truncated tool output makes rare.
//   - Each line is parsed ONCE into what it contributes to both consumers
//     (`parseTranscriptLine`, usage.ts): its usage, attributed to the model in
//     effect, and its classified audit items, each with the line's timestamp.
//     Lines that contribute nothing are not kept.
//   - The contributions are kept with the offset the scan reached, the model in
//     effect there, and the first and last bytes before it (the HEAD and the
//     TAIL). A file that grew is read only from that offset, and only once
//     both are found unchanged on disk; a file that shrank, was replaced, or
//     whose head or tail changed is read again from 0. dev/ino alone is not a
//     file's identity: an unlinked file's inode number is handed to the next
//     file created, at the same path as often as not. The head is what tells
//     a new file from the old one — pi's session header, its first line,
//     carries the session's own id. Bytes between head and tail are trusted,
//     not re-read: that rests on pi writing its session JSONL append-only —
//     pi 1.0.0's SessionManager `_persist` is `appendFileSync` of one entry
//     per line; it rewrites a file only to migrate or branch one it LOADED,
//     which a session spawned without `--continue` never does (the same
//     assumption as `receiptscan.ts`).
//   - A file whose size and mtime have not moved is answered from what was
//     kept without a byte read — but only once its mtime is older, by
//     TRANSCRIPT_RACY_MS, than the moment its bytes were last confirmed. A
//     write inside one timestamp tick of that moment can leave size and mtime
//     exactly as they were (a same-size rewrite, or a new file on the old
//     inode); such a "racily clean" file has its head and tail re-read and
//     compared before it is trusted, and is read again from 0 on a mismatch.
//   - Bytes after the last newline (a line pi is still writing, or a last line
//     with no newline) are parsed for the query that read them but never
//     committed: the next scan reads them again from the committed offset.
//   - A session-dir file whose mtime is older than the round's start (less
//     TRANSCRIPT_SCOPE_SLACK_MS) is not read at all. pi stamps every entry
//     `new Date().toISOString()` when it creates it and appends it afterwards,
//     so every line's timestamp is at or before its file's mtime: such a file
//     cannot hold a line inside the window. The slack covers coarse mtimes.
//   - Concurrent queries for one file share one scan.
//
// What counts: session-dir lines whose timestamp is inside [startedAt,
// finishedAt] (inclusive), and global-store files counted whole when their
// mtime is inside the window — files in a fixed order (session files by name,
// then the store in its walk order), records in file order, so the
// floating-point cost sum is deterministic.
//
// An in-scope file that cannot be read (or listed) makes the usage UNKNOWN
// (`usage: null`), never a silent partial sum — an undercount posing as a
// measurement — and the audit INCOMPLETE (every violation found in what was
// read is still reported). ABSENT is not unreadable, and is "nothing there":
// a missing session dir or
// global store, a listed file gone by the time it is stat'ed or opened
// (ENOENT/ENOTDIR — the daemon's own pi-global archiver unlinks store files a
// day old while this walk awaits, and a dangling link is the same), and a
// `.jsonl` that is not a regular file (a directory, a FIFO: no transcript, and
// a FIFO would block the read forever).

import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  addLineUsage,
  emptyRoundUsage,
  parseTranscriptLine,
  parseTs,
  UNKNOWN_MODEL,
  type ExecViolation,
  type ExecViolationKind,
  type LineContribution,
  type RoundUsage,
} from "./usage.js";
import { yieldToLoop } from "./yieldloop.js";

/** One synchronous parse step: a chunk's complete lines. */
export const TRANSCRIPT_CHUNK_BYTES = 1 << 20;
/** How far before the round's start a session file's mtime may sit and still
 * be read — coarse mtimes; being generous costs a read, never an answer. */
export const TRANSCRIPT_SCOPE_SLACK_MS = 60_000;
/** Files whose contributions are kept; the oldest-touched goes past it. */
export const TRANSCRIPT_INDEX_MAX_FILES = 1024;
/** Contributions kept across all files; the oldest-touched files go past it. */
export const TRANSCRIPT_INDEX_MAX_RECORDS = 1_000_000;
/** How far a file's mtime must sit before the moment its bytes were last
 * confirmed for an unmoved size and mtime to be trusted without a read — more
 * than any timestamp tick a transcript's filesystem keeps (FAT's is 2 s;
 * Linux's coarse clock a few ms). */
export const TRANSCRIPT_RACY_MS = 2_000;
/** Bytes before the committed offset re-read and compared before a resume. */
const TAIL_BYTES = 512;
/** Bytes from the start of the file re-read and compared before a resume. */
const HEAD_BYTES = 512;
/** The global store's walk depth. */
const GLOBAL_STORE_DEPTH = 6;
const NEWLINE = 0x0a;
const NEWLINE_BUF = Buffer.from([NEWLINE]);
const EMPTY = Buffer.alloc(0);

export interface TranscriptStat {
  mtimeMs: number;
  size: number;
  dev: number;
  ino: number;
  isFile(): boolean;
  isDirectory(): boolean;
}

export interface TranscriptHandle {
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

/** The filesystem seam: node's own `fs/promises` in production. `stat`
 * follows symlinks. */
export interface TranscriptFs {
  readdir(dir: string): Promise<string[]>;
  stat(path: string): Promise<TranscriptStat>;
  open(path: string): Promise<TranscriptHandle>;
}

export const nodeTranscriptFs: TranscriptFs = {
  readdir: (dir) => readdir(dir),
  stat: (path) => stat(path),
  open: (path) => open(path, "r"),
};

export interface TranscriptMeasureOpts {
  /** The PR's pi session dir: its top-level `*.jsonl`, line-window filtered. */
  sessionDir: string;
  /** pi HOME global store (pass transcripts): whole files matched by mtime.
   * Optional; when given, an unreadable part of it makes the usage unknown,
   * as one of the session dir does. */
  globalStoreDir?: string | undefined;
  /** ISO round window, inclusive on both ends. */
  startedAt: string;
  finishedAt: string;
}

export interface UnreadableTranscript {
  path: string;
  reason: string;
}

export interface TranscriptMeasure {
  /** The round's usage; NULL = UNKNOWN — an in-scope transcript could not be
   * read, so any sum would be an undercount posing as a measurement. */
  usage: RoundUsage | null;
  /** Every policy-forbidden action in what WAS read, classified, deduplicated
   * in first-seen order. Complete only when `unreadable` is empty. */
  violations: ExecViolation[];
  /** What could not be read, and why. Empty ⇒ both measures are complete. */
  unreadable: UnreadableTranscript[];
}

export interface TranscriptIndexStats {
  /** Bytes read from disk since the index was made. */
  bytes_read: number;
  /** Files read from offset 0 (first sight, or a rewrite). */
  full_scans: number;
  /** Files read from where the last scan stopped. */
  incremental_scans: number;
  /** Queries answered from a file's kept contributions, no line re-read (a
   * racily clean file's head and tail are probed first). */
  hits: number;
  /** Chunks parsed — each followed by an event-loop turn. */
  chunks: number;
  /** Session files not read because their mtime predates the round. */
  skipped_by_mtime: number;
  /** Files currently kept. */
  files: number;
  /** Contributions currently kept. */
  records: number;
}

interface FileEntry {
  dev: number;
  ino: number;
  mtimeMs: number;
  /** The clock when this file's bytes were last confirmed (read, or probed):
   * an unmoved stat is trusted only once `mtimeMs` is older than this by the
   * racy window. */
  verifiedAtMs: number;
  /** Bytes [0, scanned) have been read. */
  scanned: number;
  /** Bytes [0, committed) end with a newline and are parsed into `records`. */
  committed: number;
  /** The first ≤ HEAD_BYTES bytes of [0, committed). */
  head: Buffer;
  /** The last ≤ TAIL_BYTES bytes before `committed`. */
  tail: Buffer;
  /** The model attribution in effect at `committed`. */
  model: string;
  /** Contributions of the committed lines, in file order. Append-only: a
   * resumed scan extends this same array, so a view keeps its own length. */
  records: LineContribution[];
  /** Contributions of the bytes after `committed` as last read (at most one
   * line). Replaced, never mutated. */
  pending: LineContribution[];
  /** records + pending at the time this entry was made. */
  count: number;
}

/** A stable read of one file's contributions. */
interface FileView {
  records: LineContribution[];
  n: number;
  pending: LineContribution[];
}

interface Part {
  view: FileView;
  /** Global-store file: every line counts. Otherwise the line window. */
  whole: boolean;
}

function sameInode(entry: FileEntry, st: TranscriptStat): boolean {
  return entry.dev === st.dev && entry.ino === st.ino;
}

/** Neither grown past what was read nor touched since, by `st`'s account. */
function unmoved(entry: FileEntry, st: TranscriptStat): boolean {
  return entry.scanned >= st.size && entry.mtimeMs >= st.mtimeMs;
}

function errnoCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/** Nothing there to read. A code-less error is NOT absence: unknown. */
function isMissing(err: unknown): boolean {
  const code = errnoCode(err);
  return code === "ENOENT" || code === "ENOTDIR";
}

/** A listed `*.jsonl` as its stat finds it. */
type Listed =
  | { kind: "file"; st: TranscriptStat }
  | { kind: "absent" }
  | { kind: "unreadable"; reason: string };

function reasonOf(err: unknown): string {
  const code = errnoCode(err);
  const message = err instanceof Error ? err.message : String(err);
  return code !== undefined && !message.startsWith(code) ? `${code}: ${message}` : message;
}

/** The last `n` bytes of the concatenation of `parts`, as a fresh copy. */
function lastBytes(parts: readonly Buffer[], n: number): Buffer {
  const out: Buffer[] = [];
  let need = n;
  for (let i = parts.length - 1; i >= 0 && need > 0; i--) {
    const p = parts[i]!;
    if (p.length <= need) {
      out.unshift(p);
      need -= p.length;
    } else {
      out.unshift(p.subarray(p.length - need));
      need = 0;
    }
  }
  return Buffer.concat(out); // always a copy: never a view into a read buffer
}

/** `head` extended from the concatenation of `parts` to at most `n` bytes,
 * as a fresh copy; `head` itself when it is already full. */
function firstBytes(head: Buffer, parts: readonly Buffer[], n: number): Buffer {
  if (head.length >= n) return head;
  const out: Buffer[] = [head];
  let need = n - head.length;
  for (const p of parts) {
    if (need <= 0) break;
    out.push(p.length <= need ? p : p.subarray(0, need));
    need -= Math.min(p.length, need);
  }
  return Buffer.concat(out); // always a copy: never a view into a read buffer
}

/** Parse every line of `text` into `into`; returns the model after them. */
function parseLines(text: string, model: string, into: LineContribution[]): string {
  let m = model;
  for (const line of text.split("\n")) {
    const parsed = parseTranscriptLine(line, m);
    m = parsed.model;
    if (parsed.contribution !== null) into.push(parsed.contribution);
  }
  return m;
}

export class TranscriptIndex {
  private readonly files = new Map<string, FileEntry>();
  private readonly inflight = new Map<string, Promise<FileEntry>>();
  private readonly fs: TranscriptFs;
  private readonly chunkBytes: number;
  private readonly maxFiles: number;
  private readonly maxRecords: number;
  private readonly slackMs: number;
  private readonly racyMs: number;
  private readonly now: () => number;
  private recordsKept = 0;
  private readonly counters = {
    bytes_read: 0,
    full_scans: 0,
    incremental_scans: 0,
    hits: 0,
    chunks: 0,
    skipped_by_mtime: 0,
  };

  constructor(
    opts: {
      fs?: TranscriptFs;
      chunkBytes?: number;
      maxFiles?: number;
      maxRecords?: number;
      scopeSlackMs?: number;
      racyMs?: number;
      now?: () => number;
    } = {},
  ) {
    this.fs = opts.fs ?? nodeTranscriptFs;
    this.chunkBytes = Math.max(1, opts.chunkBytes ?? TRANSCRIPT_CHUNK_BYTES);
    this.maxFiles = Math.max(1, opts.maxFiles ?? TRANSCRIPT_INDEX_MAX_FILES);
    this.maxRecords = Math.max(1, opts.maxRecords ?? TRANSCRIPT_INDEX_MAX_RECORDS);
    this.slackMs = Math.max(0, opts.scopeSlackMs ?? TRANSCRIPT_SCOPE_SLACK_MS);
    this.racyMs = Math.max(0, opts.racyMs ?? TRANSCRIPT_RACY_MS);
    this.now = opts.now ?? Date.now;
  }

  stats(): TranscriptIndexStats {
    return { ...this.counters, files: this.files.size, records: this.recordsKept };
  }

  /**
   * The round's usage and exec-policy audit over [startedAt, finishedAt].
   * Total: it never throws — anything that could not be read is reported in
   * `unreadable` and makes the usage unknown.
   */
  async measure(opts: TranscriptMeasureOpts): Promise<TranscriptMeasure> {
    const usage = emptyRoundUsage();
    const start = parseTs(opts.startedAt);
    const end = parseTs(opts.finishedAt);
    // An unparseable window measures nothing.
    if (start === null || end === null) return { usage, violations: [], unreadable: [] };
    const unreadable: UnreadableTranscript[] = [];
    try {
      const parts: Part[] = [];
      await this.sessionParts(opts.sessionDir, start, parts, unreadable);
      if (opts.globalStoreDir)
        await this.globalParts(
          opts.globalStoreDir,
          GLOBAL_STORE_DEPTH,
          start,
          end,
          parts,
          unreadable,
          usage,
        );
      const seen = new Map<string, ExecViolationKind>();
      for (const part of parts) {
        this.fold(part, start, end, usage, seen);
        await yieldToLoop();
      }
      return {
        usage: unreadable.length > 0 ? null : usage,
        violations: [...seen].map(([command, kind]) => ({ command, kind })),
        unreadable,
      };
    } catch (err) {
      // Belt: every read above is already caught where it happens.
      unreadable.push({ path: opts.sessionDir, reason: reasonOf(err) });
      return { usage: null, violations: [], unreadable };
    }
  }

  /** The session dir's top-level `*.jsonl`, by name, minus those whose mtime
   * predates the round. */
  private async sessionParts(
    dir: string,
    start: number,
    parts: Part[],
    unreadable: UnreadableTranscript[],
  ): Promise<void> {
    let names: string[];
    try {
      names = await this.fs.readdir(dir);
    } catch (err) {
      // No session dir is no transcript — zero. Anything else
      // means transcripts we cannot see.
      if (!isMissing(err)) unreadable.push({ path: dir, reason: reasonOf(err) });
      return;
    }
    for (const name of names.filter((n) => n.endsWith(".jsonl")).sort()) {
      const path = join(dir, name);
      const listed = await this.statListed(path);
      if (listed.kind === "absent") continue;
      if (listed.kind === "unreadable") {
        unreadable.push({ path, reason: listed.reason });
        continue;
      }
      if (listed.st.mtimeMs < start - this.slackMs) {
        this.counters.skipped_by_mtime++;
        continue;
      }
      const view = await this.readListed(path, listed.st, unreadable);
      if (view) parts.push({ view, whole: false });
    }
  }

  /** Stat a listed `*.jsonl`. Gone since the listing, or not a regular file,
   * is ABSENT; any other failure is unreadable. */
  private async statListed(path: string): Promise<Listed> {
    let st: TranscriptStat;
    try {
      st = await this.fs.stat(path);
    } catch (err) {
      return isMissing(err) ? { kind: "absent" } : { kind: "unreadable", reason: reasonOf(err) };
    }
    return st.isFile() ? { kind: "file", st } : { kind: "absent" };
  }

  /** Read a listed file's contributions; a file gone before its open is
   * absent (undefined), any other failure unreadable (undefined, recorded). */
  private async readListed(
    path: string,
    st: TranscriptStat,
    unreadable: UnreadableTranscript[],
  ): Promise<FileView | undefined> {
    try {
      return await this.viewOf(path, st);
    } catch (err) {
      if (!isMissing(err)) unreadable.push({ path, reason: reasonOf(err) });
      return undefined;
    }
  }

  /** The global store, walked depth-first in listing order; a `*.jsonl`
   * whose mtime is inside the window counts whole. */
  private async globalParts(
    dir: string,
    depth: number,
    start: number,
    end: number,
    parts: Part[],
    unreadable: UnreadableTranscript[],
    usage: RoundUsage,
  ): Promise<void> {
    if (depth < 0) return;
    let names: string[];
    try {
      names = await this.fs.readdir(dir);
    } catch (err) {
      if (!isMissing(err)) unreadable.push({ path: dir, reason: reasonOf(err) });
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      if (name.endsWith(".jsonl")) {
        const listed = await this.statListed(path);
        if (listed.kind === "absent") continue;
        if (listed.kind === "unreadable") {
          unreadable.push({ path, reason: listed.reason });
          continue;
        }
        if (listed.st.mtimeMs < start || listed.st.mtimeMs > end) continue;
        const view = await this.readListed(path, listed.st, unreadable);
        if (view) {
          parts.push({ view, whole: true });
          usage.passes_included = true;
        }
        continue;
      }
      // Any other name is followed, while the walk may go deeper, only when it
      // is a directory. Gone is nothing to follow; any other stat failure is a
      // subtree that may hold this round's transcripts — unreadable, as an
      // unlistable one is.
      if (depth === 0) continue;
      let st: TranscriptStat;
      try {
        st = await this.fs.stat(path);
      } catch (err) {
        if (!isMissing(err)) unreadable.push({ path, reason: reasonOf(err) });
        continue;
      }
      if (st.isDirectory())
        await this.globalParts(path, depth - 1, start, end, parts, unreadable, usage);
    }
  }

  /** Add one file's contributions to the round, in file order. */
  private fold(
    part: Part,
    start: number,
    end: number,
    usage: RoundUsage,
    seen: Map<string, ExecViolationKind>,
  ): void {
    const visit = (c: LineContribution): void => {
      if (!part.whole && (c.ts === null || c.ts < start || c.ts > end)) return;
      if (c.usage !== undefined) addLineUsage(usage, c.usage);
      if (c.childUsage !== undefined) {
        for (const u of c.childUsage) addLineUsage(usage, u);
        usage.children_included = true;
      }
      if (c.audit !== undefined)
        for (const v of c.audit) if (!seen.has(v.command)) seen.set(v.command, v.kind);
    };
    const { records, n, pending } = part.view;
    for (let i = 0; i < n; i++) visit(records[i]!);
    for (const c of pending) visit(c);
  }

  /** `path`'s contributions, brought up to date with the file as `st` saw it.
   * `st` is a regular file's (`statListed`). */
  private async viewOf(path: string, st: TranscriptStat): Promise<FileView> {
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
    // The same file, already read at least as far as `st` reaches, and its
    // mtime clear of the racy window: no byte read. (A scan this query waited
    // on may have seen MORE than `st` — lines appended since, which a later
    // read would also have seen.) A racily clean one is probed by `scan`.
    if (cached && sameInode(cached, st) && unmoved(cached, st) && !this.racy(cached)) {
      this.counters.hits++;
      this.touch(path, cached);
      return { records: cached.records, n: cached.records.length, pending: cached.pending };
    }
    const scan = this.scan(path, st, cached);
    this.inflight.set(path, scan);
    try {
      const entry = await scan;
      this.keep(path, entry);
      return { records: entry.records, n: entry.records.length, pending: entry.pending };
    } catch (err) {
      this.drop(path);
      throw err;
    } finally {
      this.inflight.delete(path);
    }
  }

  /** Written within the racy window of its last confirmation: an unmoved
   * size and mtime do not prove it unchanged. */
  private racy(entry: FileEntry): boolean {
    return entry.mtimeMs >= entry.verifiedAtMs - this.racyMs;
  }

  /** Whether the kept head and tail are still on disk where they were read. */
  private async probe(fh: TranscriptHandle, entry: FileEntry): Promise<boolean> {
    const probes: [Buffer, number][] = [
      [entry.tail, entry.committed - entry.tail.length],
      [entry.head, 0],
    ];
    for (const [want, at] of probes) {
      if (want.length === 0) continue;
      const got = Buffer.allocUnsafe(want.length);
      const { bytesRead } = await fh.read(got, 0, want.length, at);
      this.counters.bytes_read += bytesRead;
      if (bytesRead !== want.length || !got.equals(want)) return false;
    }
    return true;
  }

  private keep(path: string, entry: FileEntry): void {
    this.drop(path);
    this.files.set(path, entry);
    this.recordsKept += entry.count;
    this.evict(path);
  }

  private drop(path: string): void {
    const old = this.files.get(path);
    if (old === undefined) return;
    this.files.delete(path);
    this.recordsKept -= old.count;
  }

  private touch(path: string, entry: FileEntry): void {
    this.files.delete(path);
    this.files.set(path, entry);
  }

  /** Oldest-touched first, never the entry just kept. */
  private evict(keepPath: string): void {
    while (this.files.size > this.maxFiles || this.recordsKept > this.maxRecords) {
      const oldest = this.files.keys().next().value;
      if (oldest === undefined || oldest === keepPath) break;
      this.drop(oldest);
    }
  }

  private async scan(
    path: string,
    st: TranscriptStat,
    cached: FileEntry | undefined,
  ): Promise<FileEntry> {
    const readAt = this.now();
    const fh = await this.fs.open(path);
    try {
      // The same file as the one kept: the bytes at its start and just before
      // the old offset are still the ones the last scan saw. Bytes between
      // them are trusted, not re-read (the header's assumption).
      const intact =
        cached !== undefined &&
        sameInode(cached, st) &&
        cached.tail.length > 0 &&
        (await this.probe(fh, cached));
      if (intact && unmoved(cached, st)) {
        // Racily clean, and confirmed: nothing to read.
        cached.verifiedAtMs = readAt;
        this.counters.hits++;
        return cached;
      }
      let records: LineContribution[] = [];
      let model = UNKNOWN_MODEL;
      let pos = 0;
      let head: Buffer = EMPTY;
      let tail: Buffer = EMPTY;
      let resumed = false;
      if (intact && st.size >= cached.committed) {
        // Append-only growth: read on from the old offset.
        records = cached.records;
        model = cached.model;
        pos = cached.committed;
        head = cached.head;
        tail = cached.tail;
        resumed = true;
      }
      if (resumed) this.counters.incremental_scans++;
      else this.counters.full_scans++;

      let committed = pos;
      const buf = Buffer.allocUnsafe(this.chunkBytes);
      // Bytes read after the last newline so far (a line not yet complete).
      let carry: Buffer[] = [];
      let carryLen = 0;
      while (pos < st.size) {
        const want = Math.min(this.chunkBytes, st.size - pos);
        const { bytesRead } = await fh.read(buf, 0, want, pos);
        if (bytesRead === 0) break; // truncated under us — what was read stands
        pos += bytesRead;
        this.counters.bytes_read += bytesRead;
        const chunk = buf.subarray(0, bytesRead);
        const nl = chunk.lastIndexOf(NEWLINE);
        if (nl === -1) {
          carry.push(Buffer.from(chunk)); // `buf` is reused by the next read
          carryLen += bytesRead;
        } else {
          // Every line that ends in this chunk, decoded and parsed now. A
          // newline byte never sits inside a multi-byte UTF-8 sequence, so a
          // split here decodes exactly as the whole file did.
          const upToNl = chunk.subarray(0, nl);
          const segment = carryLen > 0 ? Buffer.concat([...carry, upToNl]) : upToNl;
          model = parseLines(segment.toString("utf8"), model, records);
          head = firstBytes(head, [segment, NEWLINE_BUF], HEAD_BYTES);
          tail = lastBytes([tail, segment, NEWLINE_BUF], TAIL_BYTES);
          committed = pos - (bytesRead - nl - 1);
          carry = nl + 1 < bytesRead ? [Buffer.from(chunk.subarray(nl + 1))] : [];
          carryLen = bytesRead - nl - 1;
        }
        this.counters.chunks++;
        await yieldToLoop();
      }
      // The bytes after the last newline: this query's answer, never kept as
      // committed — the next scan reads them again.
      const pending: LineContribution[] = [];
      if (carryLen > 0) parseLines(Buffer.concat(carry).toString("utf8"), model, pending);
      return {
        dev: st.dev,
        ino: st.ino,
        mtimeMs: st.mtimeMs,
        verifiedAtMs: readAt,
        scanned: pos,
        committed,
        head,
        tail,
        model,
        records,
        pending,
        count: records.length + pending.length,
      };
    } finally {
      await fh.close();
    }
  }
}

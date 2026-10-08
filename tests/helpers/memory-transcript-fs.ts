// An in-memory `TranscriptFs` (H2) for the transcript index's tests:
// a flat path → content map with directories implied by prefixes, mutable
// between calls (append, replace, chmod-like failures), and a log of every
// open and read so a test can say what was — and was not — read.
import type { TranscriptFs, TranscriptHandle, TranscriptStat } from "../../src/transcriptindex.js";

interface MemFile {
  bytes: Buffer;
  mtimeMs: number;
  ino: number;
  /** An errno code every open of this file fails with. */
  openError?: string;
  /** An errno code every read of this file fails with. */
  readError?: string;
}

export interface ReadRecord {
  path: string;
  position: number;
  length: number;
}

function errno(code: string, path: string): Error {
  return Object.assign(new Error(`${code}: ${path}`), { code });
}

export class MemoryTranscriptFs implements TranscriptFs {
  private readonly files = new Map<string, MemFile>();
  private nextIno = 1;
  /** Every path opened, in order. */
  readonly opened: string[] = [];
  /** Every read, in order. */
  readonly reads: ReadRecord[] = [];
  /** Directories whose listing fails with this errno code. */
  readonly listErrors = new Map<string, string>();
  /** Paths whose stat never answers (a hung filesystem). */
  readonly hangingStats = new Set<string>();
  /** Paths whose stat fails with this errno code. */
  readonly statErrors = new Map<string, string>();
  /** Runs after every listing, before it is returned — e.g. to unlink a file
   * the listing names, as the pi-global archiver may while a walk awaits. */
  afterReaddir?: (dir: string) => void;
  /** Runs after every successful stat — e.g. to unlink the file before its
   * open. */
  afterStat?: (path: string) => void;
  /** Awaited at the start of every stat — a test's gate on a round end's
   * reads. */
  beforeStat?: (path: string) => Promise<void> | void;

  constructor(
    files: Record<string, string> = {},
    mtimes: Record<string, number> = {},
    defaultMtimeMs = 0,
  ) {
    for (const [path, content] of Object.entries(files))
      this.write(path, content, mtimes[path] ?? defaultMtimeMs);
  }

  /** Create or REPLACE a file (a new inode). */
  write(path: string, content: string | Buffer, mtimeMs: number): void {
    this.files.set(path, {
      bytes: Buffer.isBuffer(content) ? Buffer.from(content) : Buffer.from(content, "utf8"),
      mtimeMs,
      ino: this.nextIno++,
    });
  }

  /** Append to a file in place (same inode), as pi's appendFileSync does. */
  append(path: string, content: string, mtimeMs: number): void {
    const f = this.files.get(path);
    if (!f) throw new Error(`no such file ${path}`);
    f.bytes = Buffer.concat([f.bytes, Buffer.from(content, "utf8")]);
    f.mtimeMs = mtimeMs;
  }

  /** Unlink a file (its path stops resolving; an open handle keeps reading). */
  remove(path: string): void {
    this.files.delete(path);
  }

  setMtime(path: string, mtimeMs: number): void {
    const f = this.files.get(path);
    if (f) f.mtimeMs = mtimeMs;
  }

  failOpen(path: string, code: string): void {
    const f = this.files.get(path);
    if (f) f.openError = code;
  }

  failRead(path: string, code: string): void {
    const f = this.files.get(path);
    if (f) f.readError = code;
  }

  bytesOf(path: string): Buffer {
    return this.files.get(path)?.bytes ?? Buffer.alloc(0);
  }

  private isDir(path: string): boolean {
    const prefix = `${path}/`;
    for (const k of this.files.keys()) if (k.startsWith(prefix)) return true;
    return false;
  }

  async readdir(dir: string): Promise<string[]> {
    await Promise.resolve();
    const code = this.listErrors.get(dir);
    if (code) throw errno(code, dir);
    if (this.files.has(dir)) throw errno("ENOTDIR", dir);
    const prefix = `${dir}/`;
    const names = new Set<string>();
    for (const k of this.files.keys())
      if (k.startsWith(prefix)) names.add(k.slice(prefix.length).split("/")[0]!);
    if (names.size === 0) throw errno("ENOENT", dir);
    // libuv's scandir order — what node's readdir returns.
    const listing = [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    this.afterReaddir?.(dir);
    return listing;
  }

  async stat(path: string): Promise<TranscriptStat> {
    if (this.hangingStats.has(path)) return new Promise<TranscriptStat>(() => undefined);
    await this.beforeStat?.(path);
    await Promise.resolve();
    const code = this.statErrors.get(path);
    if (code) throw errno(code, path);
    const st = this.statNow(path);
    this.afterStat?.(path);
    return st;
  }

  private statNow(path: string): TranscriptStat {
    const f = this.files.get(path);
    if (f)
      return {
        mtimeMs: f.mtimeMs,
        size: f.bytes.length,
        dev: 1,
        ino: f.ino,
        isFile: () => true,
        isDirectory: () => false,
      };
    if (this.isDir(path))
      return {
        mtimeMs: 0,
        size: 4096,
        dev: 1,
        ino: 0,
        isFile: () => false,
        isDirectory: () => true,
      };
    throw errno("ENOENT", path);
  }

  async open(path: string): Promise<TranscriptHandle> {
    await Promise.resolve();
    this.opened.push(path);
    const f = this.files.get(path);
    if (!f) throw errno(this.isDir(path) ? "EISDIR" : "ENOENT", path);
    if (f.openError) throw errno(f.openError, path);
    return {
      read: async (buffer, offset, length, position) => {
        await Promise.resolve();
        this.reads.push({ path, position, length });
        if (f.readError) throw errno(f.readError, path);
        const end = Math.min(f.bytes.length, position + length);
        const n = Math.max(0, end - position);
        f.bytes.copy(buffer, offset, position, position + n);
        return { bytesRead: n };
      },
      close: async () => undefined,
    };
  }
}

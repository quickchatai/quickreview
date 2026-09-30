// Passive pi auth-failure detection (the owner, 2026-08-19): NO smoke calls —
// watch the session JSONLs pi already writes and raise when sessions start
// failing with token-expired API errors. Live signature (15:0xZ outage):
//   "errorMessage":"Provided authentication token is expired."
// The scanner tail-reads recently-modified *.jsonl under the pi sessions dir
// (one nesting level: pi groups sessions by cwd) — cheap enough for a 60s
// tick, and entirely observational: it never talks to any API.
// Only a record's own `errorMessage` FIELD is tested — never the raw line:
// reviewer sessions store tool results verbatim (diffs, file reads, CI logs),
// and a PR touching OAuth code puts "invalid_grant" in them as plain text.
import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const PI_AUTH_ERROR_RE = /authentication token is expired|invalid_grant|401 unauthorized/i;

/** True when a JSONL line is a record carrying an auth-failure `errorMessage`
 * field — at any depth, since a subagent's failed message arrives nested in
 * its tool result. Text inside string values (tool output, quoted JSON) never
 * matches: it is data, not a key. Non-JSON lines never match. */
export function lineHasAuthError(line: string): boolean {
  if (!line.includes("errorMessage")) return false;
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return false;
  }
  const visit = (x: unknown, depth: number): boolean => {
    if (depth > 12 || typeof x !== "object" || x === null) return false;
    if (Array.isArray(x)) return x.some((y) => visit(y, depth + 1));
    const r = x as Record<string, unknown>;
    const msg = r["errorMessage"];
    if (typeof msg === "string" && PI_AUTH_ERROR_RE.test(msg)) return true;
    return Object.values(r).some((v) => visit(v, depth + 1));
  };
  return visit(record, 0);
}

/** Only the tail is read: session JSONLs grow large, and a live auth failure
 * is by definition near the end of the file. */
export const AUTH_TAIL_BYTES = 128 * 1024;

export interface AuthScanHit {
  file: string;
  mtimeMs: number;
}

/** The complete lines of `path` not yet scanned: from `from` (clamped into the
 * last `bytes`) up to the last newline. Returns the text and the offset the
 * NEXT read starts at — just past that newline, so a line still being written
 * is read whole, exactly once, next time rather than split or counted twice. */
function readFrom(path: string, from: number, bytes: number): { text: string; next: number } {
  const fd = openSync(path, "r");
  try {
    const size = statSync(path).size;
    // A file that shrank was rewritten: its old offset means nothing.
    const start = Math.max(from > size ? 0 : from, size - bytes, 0);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    // Only COMPLETE lines are tested: a trailing partial line is left for the
    // next scan, so testing it now too would count the same error twice.
    const lastNl = buf.lastIndexOf(0x0a);
    if (lastNl < 0) return { text: "", next: start };
    return { text: buf.subarray(0, lastNl + 1).toString("utf8"), next: start + lastNl + 1 };
  } finally {
    closeSync(fd);
  }
}

/** Scan *.jsonl files modified at/after `sinceMs` (dir + one sublevel) for
 * auth-error signatures. Unreadable files are skipped — observation must
 * never throw into the daemon tick.
 *
 * `seen` (path → byte offset, updated in place) makes the scan read only what
 * was APPENDED since the last scan: without it an old error still inside the
 * tail matched again on every healthy write after a re-login, and the flag
 * never cleared. A file not in `seen` is read tail-only, as before. */
export function scanPiAuthErrors(
  sessionsDir: string,
  sinceMs: number,
  seen?: Map<string, number>,
): AuthScanHit[] {
  const hits: AuthScanHit[] = [];
  const visit = (dir: string, depth: number): void => {
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (depth < 1) visit(path, depth + 1);
        continue;
      }
      if (!name.endsWith(".jsonl") || st.mtimeMs < sinceMs) continue;
      try {
        const { text, next } = readFrom(path, seen?.get(path) ?? 0, AUTH_TAIL_BYTES);
        seen?.set(path, next);
        if (text.split("\n").some(lineHasAuthError)) hits.push({ file: path, mtimeMs: st.mtimeMs });
      } catch {
        // skip
      }
    }
  };
  visit(sessionsDir, 0);
  return hits;
}

/** How long a detection keeps the status flag up with no fresh errors. */
export const AUTH_FLAG_FRESH_MS = 30 * 60 * 1000;

export interface PiAuthStatus {
  last_at: string;
  hits: number;
}

/**
 * Stateful watcher for the daemon tick. Each scan covers files modified since
 * the previous scan (first scan looks 10 minutes back). `status()` reports
 * the flag while the last detection is fresh (< AUTH_FLAG_FRESH_MS) — the
 * flag clears itself once the errors stop.
 */
export class PiAuthWatch {
  private sinceMs: number;
  private lastErrorAt: number | null = null;
  private totalHits = 0;
  /** Per-file offset already scanned — a match is a NEW error line, never an
   * old one the tail still holds. */
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly sessionsDir: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.sinceMs = this.now().getTime() - 10 * 60 * 1000;
  }

  /** Returns the NEW hits found this scan (empty array when quiet). */
  scan(): AuthScanHit[] {
    const started = this.now().getTime();
    const hits = scanPiAuthErrors(this.sessionsDir, this.sinceMs, this.seen);
    // Next scan starts at this scan's start, minus a minute of overlap so a
    // write racing the scan is never missed; the per-file offsets keep the
    // overlap from re-reading (and re-counting) bytes already scanned.
    this.sinceMs = started - 60 * 1000;
    if (hits.length > 0) {
      this.lastErrorAt = started;
      this.totalHits += hits.length;
    }
    return hits;
  }

  status(): PiAuthStatus | undefined {
    if (this.lastErrorAt === null) return undefined;
    if (this.now().getTime() - this.lastErrorAt > AUTH_FLAG_FRESH_MS) return undefined;
    return { last_at: new Date(this.lastErrorAt).toISOString(), hits: this.totalHits };
  }
}

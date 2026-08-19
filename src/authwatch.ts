// Passive pi auth-failure detection (the owner, 2026-08-19): NO smoke calls —
// watch the session JSONLs pi already writes and raise when sessions start
// failing with token-expired API errors. Live signature (15:0xZ outage):
//   "errorMessage":"Provided authentication token is expired."
// The scanner tail-reads recently-modified *.jsonl under the pi sessions dir
// (one nesting level: pi groups sessions by cwd) — cheap enough for a 60s
// tick, and entirely observational: it never talks to any API.
import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const PI_AUTH_ERROR_RE = /authentication token is expired|invalid_grant|401 unauthorized/i;

/** Only the tail is read: session JSONLs grow large, and a live auth failure
 * is by definition near the end of the file. */
export const AUTH_TAIL_BYTES = 128 * 1024;

export interface AuthScanHit {
  file: string;
  mtimeMs: number;
}

function tailOf(path: string, bytes: number): string {
  const fd = openSync(path, "r");
  try {
    const size = statSync(path).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** Scan *.jsonl files modified at/after `sinceMs` (dir + one sublevel) for
 * auth-error signatures. Unreadable files are skipped — observation must
 * never throw into the daemon tick. */
export function scanPiAuthErrors(sessionsDir: string, sinceMs: number): AuthScanHit[] {
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
        if (PI_AUTH_ERROR_RE.test(tailOf(path, AUTH_TAIL_BYTES))) hits.push({ file: path, mtimeMs: st.mtimeMs });
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

  constructor(
    private readonly sessionsDir: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.sinceMs = this.now().getTime() - 10 * 60 * 1000;
  }

  /** Returns the NEW hits found this scan (empty array when quiet). */
  scan(): AuthScanHit[] {
    const started = this.now().getTime();
    const hits = scanPiAuthErrors(this.sessionsDir, this.sinceMs);
    // Next scan starts at this scan's start, minus a minute of overlap so a
    // write racing the scan is never missed; the anomaly wake dedup absorbs
    // the duplicate detection.
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

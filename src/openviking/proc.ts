// RSS + CPU sampling for the supervised OpenViking process.
//
// CPU is the cost to watch, not RAM: the spike measured 397 MiB idle / 456 MiB
// warm against an 8 GiB container, but ~1.63 core-seconds per ~500 B write on
// a 2-core quota. So the heartbeat carries both, and CPU is a RATE — which
// needs two samples, hence the small stateful sampler rather than a pure read.
//
// Monitoring only. The owner ratified this WITHOUT an RSS watchdog and without
// auto-restart on a memory budget; do not add one under another name.
import { readFileSync } from "node:fs";
import type { ProcSample } from "./types.js";

/** Linux USER_HZ. Fixed at 100 on every architecture Docker runs here. */
const TICKS_PER_SEC = 100;
/** Page size behind `/proc/<pid>/stat` field 24 (rss, in pages). */
const PAGE_BYTES = 4096;

export interface ProcStat {
  utimeTicks: number;
  stimeTicks: number;
  rssPages: number;
}

/**
 * Parse `/proc/<pid>/stat`.
 *
 * Field 2 (`comm`) is the executable name in parentheses and MAY CONTAIN
 * SPACES AND PARENTHESES, which is why this splits after the LAST `)` instead
 * of tokenising the whole line — the classic way this parse goes wrong.
 * Fields are 1-based per proc(5): 14 utime, 15 stime, 24 rss (pages).
 */
export function parseProcStat(raw: string): ProcStat | undefined {
  const close = raw.lastIndexOf(")");
  if (close < 0) return undefined;
  // After the closing paren comes " S 4 5 …": rest[0] is field 3 (state).
  const rest = raw.slice(close + 1).trim().split(/\s+/);
  const field = (n: number): number => Number(rest[n - 3]);
  const utimeTicks = field(14);
  const stimeTicks = field(15);
  const rssPages = field(24);
  if (![utimeTicks, stimeTicks, rssPages].every((n) => Number.isFinite(n))) return undefined;
  return { utimeTicks, stimeTicks, rssPages };
}

export interface ProcSamplerDeps {
  /** Test seam. Default reads `/proc/<pid>/stat`; anything unreadable (a dead
   * pid, a non-Linux dev box) yields undefined, never a throw. */
  readStat?: (pid: number) => string | undefined;
  now?: () => number;
}

/**
 * Stateful `/proc` sampler: RSS straight off the read, CPU as a delta against
 * the previous sample of the SAME pid. A pid change (i.e. a restart) resets the
 * baseline, so a fresh child never inherits the dead one's tick counter.
 */
export class ProcSampler {
  private readonly readStat: (pid: number) => string | undefined;
  private readonly now: () => number;
  private prev: { pid: number; ticks: number; at: number } | null = null;

  constructor(deps: ProcSamplerDeps = {}) {
    this.readStat =
      deps.readStat ??
      ((pid: number): string | undefined => {
        try {
          return readFileSync(`/proc/${pid}/stat`, "utf8");
        } catch {
          return undefined;
        }
      });
    this.now = deps.now ?? (() => Date.now());
  }

  /** Never throws; undefined simply means "no numbers this tick". */
  sample(pid: number): ProcSample | undefined {
    let stat: ProcStat | undefined;
    try {
      const raw = this.readStat(pid);
      stat = raw ? parseProcStat(raw) : undefined;
    } catch {
      stat = undefined;
    }
    if (!stat) {
      this.prev = null;
      return undefined;
    }
    const at = this.now();
    const ticks = stat.utimeTicks + stat.stimeTicks;
    const prev = this.prev;
    this.prev = { pid, ticks, at };

    const out: ProcSample = { rss_bytes: stat.rssPages * PAGE_BYTES };
    if (prev && prev.pid === pid && at > prev.at) {
      const coreSeconds = (ticks - prev.ticks) / TICKS_PER_SEC;
      const wallSeconds = (at - prev.at) / 1000;
      // Counters are monotonic; a negative delta means the pid was recycled.
      if (coreSeconds >= 0) out.cpu_pct = Math.round((coreSeconds / wallSeconds) * 1000) / 10;
    }
    return out;
  }

  /** Drop the baseline (called on every respawn). */
  reset(): void {
    this.prev = null;
  }
}

// The heartbeat of a detached review run: a small file its driver rewrites on
// a timer, which an OUTSIDE process (the watchdog in reviewdetach.ts) reads.
//
// An in-process deadline cannot cover a frozen event loop: a synchronous loop
// stops every timer, the budget's included, and the signal handlers with them.
// What the driver cannot say for itself, a file that stops advancing says for
// it. The beat also names the latest deadline of the turns in flight and the
// process groups of the pi children, so the watchdog can reach the children
// the driver's own group does not hold.
import { renameSync, readFileSync, writeFileSync } from "node:fs";

export const HEARTBEAT_FILE = "heartbeat.json";

export interface Beat {
  /** Counts up with every write. */
  seq: number;
  /** When it was written (ms since the epoch). */
  at: number;
  pid: number;
  /** The latest deadline of a turn in flight; null while none runs. */
  deadline_at: number | null;
  /** Process groups the driver had running when it wrote this. */
  pgids: number[];
}

const deadlines = new Set<{ at: number }>();
/** Writes a beat now: set while a heartbeat runs. */
let beatNow: (() => void) | null = null;

/** A turn in flight ends at `at`: the beat carries it until the returned
 * release is called. Cheap and inert when no heartbeat is running. The beat is
 * rewritten at once: a driver that freezes in the turn's first moments (a
 * synchronous loop on the SDK runtime stops the timer too) would otherwise leave
 * a last beat without the deadline, and the watchdog would never act. */
export function trackDeadline(at: number): () => void {
  const entry = { at };
  deadlines.add(entry);
  beatNow?.();
  return () => {
    deadlines.delete(entry);
  };
}

function latestDeadline(): number | null {
  let max: number | null = null;
  for (const d of deadlines) if (max === null || d.at > max) max = d.at;
  return max;
}

/** Read a beat; null when the file is missing or is not one. */
export function readBeat(path: string): Beat | null {
  try {
    const b = JSON.parse(readFileSync(path, "utf8")) as Partial<Beat>;
    if (typeof b.at !== "number" || typeof b.seq !== "number") return null;
    return {
      seq: b.seq,
      at: b.at,
      pid: typeof b.pid === "number" ? b.pid : 0,
      deadline_at: typeof b.deadline_at === "number" ? b.deadline_at : null,
      pgids: Array.isArray(b.pgids) ? b.pgids.filter((p): p is number => Number.isInteger(p)) : [],
    };
  } catch {
    return null;
  }
}

/** Write a beat now and every `intervalMs` after; returns the stop. The timer
 * never holds the process open. A write that fails is skipped: a heartbeat that
 * cannot be written reads as a stopped one, which is what it is. */
export function startHeartbeat(
  path: string,
  o: {
    intervalMs?: number;
    now?: () => number;
    pgids?: () => readonly number[];
  } = {},
): () => void {
  const now = o.now ?? Date.now;
  let seq = 0;
  const beat = (): void => {
    const b: Beat = {
      seq: ++seq,
      at: now(),
      pid: process.pid,
      deadline_at: latestDeadline(),
      pgids: [...(o.pgids?.() ?? [])],
    };
    try {
      // renamed into place: the watchdog never reads half a beat
      writeFileSync(`${path}.tmp`, JSON.stringify(b));
      renameSync(`${path}.tmp`, path);
    } catch {
      // see above
    }
  };
  beat();
  beatNow = beat;
  const timer = setInterval(beat, o.intervalMs ?? 2_000);
  timer.unref();
  return () => {
    clearInterval(timer);
    if (beatNow === beat) beatNow = null;
  };
}

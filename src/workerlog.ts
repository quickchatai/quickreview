// A worker's log file (P8.5b): `<logDir>/<command id>.log` (state/workers/), where
// the worker's stdout and stderr go. One file per command, appended across the
// worker generations of a requeued round, so it is rotated by size at the next
// spawn and the directory is pruned by age and count: a crash loop cannot fill
// the disk with the very output that explains it.
import { readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export interface WorkerLogLimits {
  /** A command's log at or over this size moves to `.1` before the next spawn. */
  maxBytes: number;
  /** Older generations kept beside the live file (`.1` ... `.N`). */
  keepRotated: number;
  /** Files untouched this long are removed. */
  maxAgeMs: number;
  /** At most this many log files stay in the directory, newest first. */
  maxFiles: number;
}

export const DEFAULT_WORKER_LOG_LIMITS: WorkerLogLimits = {
  maxBytes: 1024 * 1024,
  keepRotated: 2,
  maxAgeMs: 14 * 24 * 60 * 60_000,
  maxFiles: 200,
};

export const workerLogPath = (logDir: string, commandId: string): string =>
  join(logDir, `${commandId}.log`);

const LOG_NAME = /\.log(\.\d+)?$/;

/** Rotate `commandId`'s log if it is large, then prune the directory. Never
 * throws: a log that cannot be tidied must not stop a worker from starting. */
export function rotateWorkerLogs(
  logDir: string,
  commandId: string,
  now: number,
  limits: WorkerLogLimits = DEFAULT_WORKER_LOG_LIMITS,
): void {
  try {
    const live = workerLogPath(logDir, commandId);
    let size = 0;
    try {
      size = statSync(live).size;
    } catch {
      /* no log yet */
    }
    if (size >= limits.maxBytes) {
      for (let n = limits.keepRotated; n >= 1; n--) {
        const from = n === 1 ? live : `${live}.${n - 1}`;
        const to = `${live}.${n}`;
        try {
          if (n === limits.keepRotated) rmSync(to, { force: true });
          renameSync(from, to);
        } catch {
          /* a missing generation */
        }
      }
    }
    const files = readdirSync(logDir)
      .filter((f) => LOG_NAME.test(f))
      .map((f) => {
        try {
          return { f, mtime: statSync(join(logDir, f)).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((x): x is { f: string; mtime: number } => x !== null)
      .sort((a, b) => b.mtime - a.mtime);
    files.forEach(({ f, mtime }, i) => {
      if (f.startsWith(`${commandId}.log`)) return; // this command's own files stay
      if (i >= limits.maxFiles || now - mtime > limits.maxAgeMs) rmSync(join(logDir, f), { force: true });
    });
  } catch {
    /* best effort */
  }
}

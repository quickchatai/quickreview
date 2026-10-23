// One temp root per test file, with TMPDIR pointed at it, so `os.tmpdir()`
// — and `mktemp` in any script the file spawns — lands inside it, and the
// whole root goes when the file finishes. Installed for every file by
// tests/helpers/install-env.ts. Tests still clean up after themselves where
// they can; this is the backstop that makes a forgotten rmSync cost nothing
// rather than a dir left behind in /tmp.
//
// Removal is the caller's afterAll, never a process 'exit' hook: those never
// fire in a vitest worker.
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export interface TempRoot {
  readonly root: string;
  /** Remove the root and restore TMPDIR as it was. Idempotent. */
  close(): void;
}

export function openTempRoot(realTmp: string, prefix: string): TempRoot {
  // The owner's pid rides in the name so a later run can tell a root whose
  // process was killed (no afterAll ran) from one still in use.
  const root = mkdtempSync(join(realTmp, `${prefix}${process.pid}-`));
  const had = "TMPDIR" in process.env;
  const prev = process.env.TMPDIR;
  process.env.TMPDIR = root;
  let open = true;
  return {
    root,
    close() {
      if (!open) return;
      open = false;
      if (process.env.TMPDIR === root) {
        if (had) process.env.TMPDIR = prev;
        else delete process.env.TMPDIR;
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const LEGACY_MAX_AGE_MS = 6 * 3_600_000;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Remove roots a killed worker left behind: `<prefix><pid>-…` whose pid is
 * gone, and pid-less roots of the older naming once they are hours old. A
 * live pid (any other file's worker) is never touched. Total: a failure to
 * list or remove one entry leaves it for the next run. */
export function sweepStaleRoots(realTmp: string, prefix: string, now = Date.now()): string[] {
  const removed: string[] = [];
  let names: string[];
  try {
    names = readdirSync(realTmp);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const m = /^(\d+)-/.exec(name.slice(prefix.length));
    const path = join(realTmp, name);
    try {
      const stale = m
        ? Number(m[1]) !== process.pid && !alive(Number(m[1]))
        : now - statSync(path).mtimeMs > LEGACY_MAX_AGE_MS;
      if (!stale) continue;
      rmSync(path, { recursive: true, force: true });
      removed.push(path);
    } catch {
      /* left for the next run */
    }
  }
  return removed;
}

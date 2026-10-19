// The single-instance lock: an exclusive flock on a SEPARATE lock file
// (`pihome/agent/auth.json.lock`), held for the refresher's whole life.
//
// Why not a lock on auth.json: every refresh replaces auth.json by rename
// (atomic.ts), so a lock on it stays on the old inode, a second refresher could
// then lock the new file and run beside the first, and the two would rotate the
// refresh token under each other. The lock file is created once and never
// renamed or replaced, so its lock survives every refresh.
//
// Node has no flock. The lock is held by a helper process: `flock -n <file> sh
// -c 'echo locked; exec cat'`. `cat` blocks on a pipe from this process, so the
// lock lasts exactly as long as the pipe's write end does: release() closes it,
// and a refresher that is killed in any way closes it too (the kernel closes its
// descriptors), so a crash can never leave the lock held by an orphan.
import { spawn } from "node:child_process";
import { chmodSync, chownSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";

/** flock's exit status when the lock is held by someone else (-E). */
export const LOCK_HELD_EXIT = 75;

/** Another refresher holds the lock. */
export class LoginLockHeld extends Error {
  // A plain field, not a parameter property: tests also run this file as a
  // separate process under node's type stripping, which has no such syntax.
  readonly path: string;
  constructor(path: string) {
    super(`another login refresher holds ${path}`);
    this.name = "LoginLockHeld";
    this.path = path;
  }
}

export interface LoginLock {
  readonly path: string;
  /** Resolves with a reason if the holder ends without a release() (the lock is then gone). */
  readonly lost: Promise<string | undefined>;
  /** Drop the lock (and nothing else). Idempotent. */
  release(): Promise<void>;
}

/** Create the lock file if it is missing, never replacing an existing one. */
function ensureLockFile(path: string, gid: number | undefined): void {
  mkdirSync(dirname(path), { recursive: true });
  // "a": create, never truncate; an existing file keeps its inode.
  closeSync(openSync(path, "a", 0o660));
  try {
    chmodSync(path, 0o660);
    if (gid !== undefined) chownSync(path, -1, gid);
  } catch {
    /* not ours to change: the lock does not need it */
  }
}

/**
 * Take the exclusive lock, without waiting. Throws `LoginLockHeld` when
 * another process holds it.
 */
export function acquireLoginLock(
  path: string,
  o: { flockBin?: string; gid?: number | undefined } = {},
): Promise<LoginLock> {
  ensureLockFile(path, o.gid);
  return new Promise<LoginLock>((resolve, reject) => {
    const child = spawn(
      o.flockBin ?? "flock",
      ["-n", "-E", String(LOCK_HELD_EXIT), path, "sh", "-c", "echo locked; exec cat"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let settled = false;
    let stderr = "";
    const done = new Promise<void>((r) => child.once("exit", () => r()));
    child.stderr.on("data", (c: unknown) => {
      stderr += String(c);
    });
    child.stdout.once("data", () => {
      if (settled) return;
      settled = true;
      let released = false;
      resolve({
        path,
        lost: done.then(() => (released ? undefined : "the lock holder exited")),
        release: async () => {
          if (!released) {
            released = true;
            child.stdin.end();
          }
          await done;
        },
      });
    });
    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      reject(new Error(`could not run flock: ${err.message}`));
    });
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      if (code === LOCK_HELD_EXIT) reject(new LoginLockHeld(path));
      else reject(new Error(`flock exited ${code}: ${stderr.trim() || "no output"}`));
    });
  });
}

// The single-instance lock: an exclusive flock on a SEPARATE lock file
// (`pihome/agent/loginrefresh.lock`), held for the refresher's whole life.
//
// Why not `auth.json.lock`: that path is pi's. pi guards auth.json with
// proper-lockfile, whose lock is a DIRECTORY `<file>.lock` (mkdir; a stale one
// is rmdir'd). A plain file at that path makes every pi CLI fail at startup
// (`ENOTDIR: not a directory, rmdir '…/auth.json.lock'`), so this lock is named
// for this process and never `<anything pi locks>.lock`. Earlier builds did use
// `auth.json.lock`; `removeLegacyLockFile` clears what they left behind.
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
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  chownSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  unlinkSync,
} from "node:fs";
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

/** What `removeLegacyLockFile` found at the old lock path. */
export type LegacyLockOutcome = "absent" | "not-a-file" | "removed" | "unremovable";

/**
 * Remove the plain lock FILE an earlier refresher left at `path` (the old
 * `auth.json.lock`, which is pi's proper-lockfile path and breaks every pi CLI
 * while it is a file). Only a regular file is removed: a directory there is
 * pi's own live lock and a symlink is not ours, so both are left alone. Throws
 * `LoginLockHeld` when a refresher of an earlier build still holds a flock on
 * it (the two would otherwise run side by side on different lock files).
 */
export function removeLegacyLockFile(
  path: string,
  o: { flockBin?: string } = {},
): LegacyLockOutcome {
  let isFile: boolean;
  try {
    isFile = lstatSync(path).isFile();
  } catch {
    return "absent";
  }
  if (!isFile) return "not-a-file";
  const probe = spawnSync(
    o.flockBin ?? "flock",
    ["-n", "-E", String(LOCK_HELD_EXIT), path, "true"],
    { stdio: "ignore" },
  );
  if (probe.status === LOCK_HELD_EXIT) throw new LoginLockHeld(path);
  try {
    unlinkSync(path);
    return "removed";
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unremovable";
  }
}

/**
 * Does a refresher hold the lock at `path` now? true or false; null when it
 * cannot be told (no flock on this machine, or flock failed). A probe, never a
 * holder: no lock file is created where there is none (none: nobody holds it).
 */
export function loginLockHeld(path: string, o: { flockBin?: string } = {}): boolean | null {
  if (!existsSync(path)) return false;
  const probe = spawnSync(
    o.flockBin ?? "flock",
    ["-n", "-E", String(LOCK_HELD_EXIT), path, "true"],
    { stdio: "ignore" },
  );
  if (probe.error) return null;
  if (probe.status === LOCK_HELD_EXIT) return true;
  return probe.status === 0 ? false : null;
}

// The one way the login file is replaced: a tmp file in the SAME directory,
// fsync, rename over the target. Node builtins only and no runtime TypeScript
// features, so a test can also run this very file as a separate process
// (node's type stripping) and race a reader against it.
//
// A reader therefore sees the old file or the new one, whole, never a prefix.
// The target's inode changes on every write, which is why the single-instance
// lock is NOT on the target (lock.ts).
import {
  chmodSync,
  chownSync,
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join, basename } from "node:path";

/** The mode every file in the login volume gets (entrypoint.sh share_login). */
export const LOGIN_FILE_MODE = 0o660;

export interface AtomicWriteOptions {
  /** The group to give the new file; default: the target's current group. */
  gid?: number | undefined;
}

/**
 * Replace `target` with `text`: 0660, the login group. The chown is best
 * effort (a uid outside the group cannot give a file to it); the mode is not.
 */
export function writeFileAtomic(target: string, text: string, o: AtomicWriteOptions = {}): void {
  let gid = o.gid;
  if (gid === undefined) {
    try {
      gid = statSync(target).gid;
    } catch {
      /* first write: the directory's group applies */
    }
  }
  const tmp = join(dirname(target), `.${basename(target)}.${process.pid}.tmp`);
  const fd = openSync(tmp, "w", LOGIN_FILE_MODE);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing to remove */
    }
    throw err;
  }
  closeSync(fd);
  try {
    chmodSync(tmp, LOGIN_FILE_MODE);
    if (gid !== undefined) {
      try {
        chownSync(tmp, -1, gid);
      } catch {
        /* not in that group: keep the creator's */
      }
    }
    renameSync(tmp, target);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* already gone */
    }
    throw err;
  }
}

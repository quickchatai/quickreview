// Dependency-free process exclusion for bootstrap journals. A prepared,
// nonempty owner directory is published atomically, so another owner can
// never mistake a newly acquired lease for the empty directory it reclaimed.
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fdatasyncSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const OWNER = "owner.json";
/** @typedef {{ok:true,release:()=>void}|{ok:false,detail:string}} DirectoryLease */

function processStart(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return (
      stat
        .slice(stat.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/)[19] ?? null
    );
  } catch {
    return null;
  }
}

function pinnedDirectory(fd) {
  const held = fstatSync(fd);
  for (const prefix of ["/proc/self/fd", "/dev/fd"]) {
    const path = `${prefix}/${fd}`;
    try {
      const actual = statSync(path);
      if (actual.isDirectory() && actual.dev === held.dev && actual.ino === held.ino) return path;
    } catch {
      /* Try the other descriptor filesystem; never fall back to a mutable pathname. */
    }
  }
  throw new Error("this host cannot pin a lock directory by its descriptor");
}

function ownerAlive(owner) {
  if (
    !owner ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0 ||
    typeof owner.token !== "string" ||
    !owner.token
  )
    throw new Error("lock owner record is unreadable");
  const actualStart = processStart(owner.pid);
  if (typeof owner.start === "string" && actualStart !== null && owner.start !== actualStart)
    return false;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (err) {
    if (err?.code === "ESRCH") return false;
    // Permission errors and unavailable process identity are not proof of death.
    return true;
  }
}

function removeEmpty(path) {
  try {
    rmdirSync(path);
  } catch (err) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(err?.code)) throw err;
  }
}

function reclaimDead(path) {
  let fd;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
    );
    const pinned = pinnedDirectory(fd);
    const ownerPath = join(pinned, OWNER);
    let owner;
    try {
      if (statSync(ownerPath).size > 4096) throw new Error("lock owner record is oversized");
      owner = JSON.parse(readFileSync(ownerPath, "utf8"));
    } catch (err) {
      if (err?.code === "ENOENT" && readdirSync(pinned).length === 0) return true;
      throw err;
    }
    if (ownerAlive(owner)) return false;
    // The FD names the OLD inode even if another reclaimer replaced the
    // canonical pathname. Never unlink an owner through that mutable name.
    try {
      unlinkSync(ownerPath);
    } catch (err) {
      if (err?.code !== "ENOENT") throw err;
    }
    // A replacement is nonempty from the moment it becomes visible, so this
    // either removes the old empty directory or refuses the new live one.
    removeEmpty(path);
    return true;
  } catch (err) {
    if (err?.code === "ENOENT") return true;
    throw err;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Immediate refusal under contention; no sleeps, stale timeouts or blind
 * stale-owner unlink. Release belongs in finally, including async callers.
 * @returns {DirectoryLease}
 */
export function tryDirectoryLock(home, name = "reembed") {
  if (!/^[a-z0-9-]+$/.test(name)) return { ok: false, detail: "lock busy: invalid lock name" };
  const path = join(home, `.qcr-${name}.lock`);
  const prepared = `${path}-${process.pid}-${randomUUID()}.ready`;
  let fd;
  let published = false;
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    mkdirSync(prepared, { mode: 0o700 });
    const ownerFd = openSync(join(prepared, OWNER), "wx", 0o600);
    try {
      writeFileSync(
        ownerFd,
        JSON.stringify({ pid: process.pid, start: processStart(process.pid), token: randomUUID() }),
      );
      fdatasyncSync(ownerFd);
    } finally {
      closeSync(ownerFd);
    }
    fd = openSync(prepared, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
    const pinned = pinnedDirectory(fd);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        renameSync(prepared, path);
        published = true;
      } catch (err) {
        if (!["ENOTEMPTY", "EEXIST"].includes(err?.code)) throw err;
        if (!reclaimDead(path))
          return { ok: false, detail: "lock busy: another process owns this journal" };
        continue;
      }
      let released = false;
      const heldFd = fd;
      return {
        ok: true,
        release() {
          if (released) return;
          released = true;
          try {
            try {
              unlinkSync(join(pinned, OWNER));
            } catch (err) {
              if (err?.code !== "ENOENT") throw err;
            }
            removeEmpty(path);
          } finally {
            closeSync(heldFd);
          }
        },
      };
    }
    return { ok: false, detail: "lock busy: another process won the journal lease" };
  } catch (err) {
    return { ok: false, detail: `lock busy: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    if (!published) {
      if (fd !== undefined) closeSync(fd);
      try {
        unlinkSync(join(prepared, OWNER));
      } catch {
        /* Only our unpublished unique candidate. */
      }
      try {
        rmdirSync(prepared);
      } catch {
        /* A refused lease never removes the canonical lock. */
      }
    }
  }
}

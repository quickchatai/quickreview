// The checklist lock: one writer of the setup checklist at a time.
//
// The checklist (state/onboarding/checklist.json) is read whole when an
// engine is built and written whole after every step, so two processes that
// each hold an engine would overwrite each other's steps and choices. Two
// kinds of process hold one on the same machine: the home, whose switches run
// steps, and a host's verbs (src/host/), whose long work goes on in a
// detached process after the verb has answered. Both take this lock around
// the whole life of their engine, and neither waits for it: a holder that
// finds it taken says who holds it and does nothing.
//
// The lock is a file beside the checklist, created whole (a hard link of a
// file already written, so a reader never sees half a record) and holding who
// took it, as which process, and when:
//
//   holder   what took it: the home, or a host verb's kind
//   pid      the process that holds it now
//   token    the taker's own secret, which a hand-over keeps
//
// A lock whose process is gone is stale and is taken over. A verb that starts
// a detached walk takes the lock itself, starts the walk, and hands the lock
// to it (`handTo`): the record is rewritten with the walk's pid, and the walk
// adopts it by the token it was started with (`adoptChecklistLock`). There is
// no moment between the two when the lock names a dead process.
//
// A machine where the lock file cannot be created at all (a read-only state
// directory) gets no exclusion and is told so (`exclusive: false`): the step
// that then tries to write the checklist is what reports the directory.
import {
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

/** What can hold the lock: the home's switches, or one kind of host verb. */
export const LOCK_HOLDERS = ["home", "setup", "go_live", "proof"] as const;
export type LockHolder = (typeof LOCK_HOLDERS)[number];

export interface LockRecord {
  holder: LockHolder;
  pid: number;
  token: string;
  acquired_at: string;
}

export interface LockOptions {
  /** The taking process; default: this one. */
  pid?: number;
  now?: () => Date;
  /** Does process `pid` exist? Default: signal 0. */
  alive?: (pid: number) => boolean;
}

export interface HeldLock {
  readonly record: LockRecord;
  /** False where no lock file could be created: nothing is excluded. */
  readonly exclusive: boolean;
  /** Give the lock up. A lock handed to another process is left to it. */
  release(): void;
  /** Hand the lock to process `pid`, which adopts it by the record's token.
   * False when the record could not be rewritten: the lock is still this
   * process's. */
  handTo(pid: number): boolean;
}

export type LockAttempt = { ok: true; lock: HeldLock } | { ok: false; held: LockRecord };

export function checklistLockPath(stateDir: string): string {
  return join(stateDir, "onboarding", "checklist.lock");
}

/** Does process `pid` exist? One it may not signal still does. */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException | null)?.code === "EPERM";
  }
}

/** A lock file younger than this that does not read as a record is one being
 * written, not a stale one. */
const UNREADABLE_GRACE_MS = 5_000;
/** A take-over guard older than this was left by a process that died in it. */
const GUARD_STALE_MS = 10_000;

const isHolder = (v: unknown): v is LockHolder =>
  typeof v === "string" && (LOCK_HOLDERS as readonly string[]).includes(v);

function parseRecord(text: string): LockRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!isHolder(r["holder"])) return null;
  if (typeof r["pid"] !== "number" || !Number.isInteger(r["pid"]) || r["pid"] <= 0) return null;
  if (typeof r["token"] !== "string" || r["token"] === "") return null;
  return {
    holder: r["holder"],
    pid: r["pid"],
    token: r["token"],
    acquired_at: typeof r["acquired_at"] === "string" ? r["acquired_at"] : "",
  };
}

interface Seen {
  text: string;
  record: LockRecord | null;
  ageMs: number;
}

/** The lock file as it is now; null when there is none. */
function look(path: string, now: number): Seen | null {
  try {
    const text = readFileSync(path, "utf8");
    return { text, record: parseRecord(text), ageMs: now - statSync(path).mtimeMs };
  } catch {
    return null;
  }
}

const render = (record: LockRecord): string => `${JSON.stringify(record)}\n`;

const drop = (path: string): void => {
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
};

/** Create the lock file whole, or fail with EEXIST when there is one. */
function create(path: string, record: LockRecord): void {
  const tmp = `${path}.${record.pid}.${record.token.slice(0, 8)}.tmp`;
  writeFileSync(tmp, render(record), { mode: 0o600 });
  try {
    linkSync(tmp, path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === "EEXIST") throw err;
    // a filesystem with no hard links: an exclusive create, then the record
    writeFileSync(path, render(record), { flag: "wx", mode: 0o600 });
  } finally {
    drop(tmp);
  }
}

/** Remove a stale lock, when it is still the one that was seen. One process
 * at a time: the guard file is created exclusively around the look and the
 * removal. */
function clearStale(path: string, seenText: string, pid: number, now: number): void {
  const guard = `${path}.takeover`;
  try {
    writeFileSync(guard, `${pid}\n`, { flag: "wx", mode: 0o600 });
  } catch {
    // another process is taking over; a guard left by one that died is cleared
    try {
      if (now - statSync(guard).mtimeMs > GUARD_STALE_MS) drop(guard);
    } catch {
      // gone already
    }
    return;
  }
  try {
    if (look(path, now)?.text === seenText) drop(path);
  } finally {
    drop(guard);
  }
}

/** A lock file nobody's record could be read from: said as held by a host's
 * setup, the holder whose words send the person nowhere. */
const unreadableHolder = (now: Date): LockRecord => ({
  holder: "setup",
  pid: 0,
  token: "",
  acquired_at: now.toISOString(),
});

function handle(path: string, record: LockRecord, exclusive: boolean): HeldLock {
  let mine = exclusive;
  return {
    record,
    exclusive,
    release: () => {
      if (!mine) return;
      mine = false;
      const now = look(path, Date.now())?.record ?? null;
      if (now !== null && now.token === record.token && now.pid === record.pid) drop(path);
    },
    handTo: (pid) => {
      if (!mine) return false;
      const tmp = `${path}.${record.pid}.hand.tmp`;
      try {
        writeFileSync(tmp, render({ ...record, pid }), { mode: 0o600 });
        renameSync(tmp, path);
      } catch {
        drop(tmp);
        return false;
      }
      mine = false;
      return true;
    },
  };
}

/**
 * Take the checklist lock of the install whose state is `stateDir`, as
 * `holder`. Never waits: a lock a living process holds is answered with its
 * record.
 */
export function acquireChecklistLock(
  stateDir: string,
  holder: LockHolder,
  o: LockOptions = {},
): LockAttempt {
  const path = checklistLockPath(stateDir);
  const alive = o.alive ?? processAlive;
  const at = (o.now ?? (() => new Date()))();
  const record: LockRecord = {
    holder,
    pid: o.pid ?? process.pid,
    token: randomBytes(16).toString("hex"),
    acquired_at: at.toISOString(),
  };
  let last: LockRecord | null = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      mkdirSync(dirname(path), { recursive: true });
      create(path, record);
      return { ok: true, lock: handle(path, record, true) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException | null)?.code !== "EEXIST")
        return { ok: true, lock: handle(path, record, false) };
    }
    const seen = look(path, at.getTime());
    if (seen === null) continue; // released in between: try again
    if (seen.record !== null && alive(seen.record.pid)) return { ok: false, held: seen.record };
    if (seen.record === null && seen.ageMs < UNREADABLE_GRACE_MS)
      return { ok: false, held: unreadableHolder(at) };
    last = seen.record;
    clearStale(path, seen.text, record.pid, at.getTime());
  }
  return { ok: false, held: last ?? unreadableHolder(at) };
}

/**
 * The lock a verb handed to this process: the record names this pid and
 * carries `token`. Null while it does not (the hand-over has not landed yet,
 * or the lock went to someone else).
 */
export function adoptChecklistLock(
  stateDir: string,
  token: string,
  o: Pick<LockOptions, "pid"> = {},
): HeldLock | null {
  const path = checklistLockPath(stateDir);
  const record = look(path, Date.now())?.record ?? null;
  if (record === null || token === "" || record.token !== token) return null;
  if (record.pid !== (o.pid ?? process.pid)) return null;
  return handle(path, record, true);
}

/** Who holds the lock now, when a living process does; else null. */
export function checklistLockHolder(
  stateDir: string,
  o: Pick<LockOptions, "alive"> = {},
): LockRecord | null {
  const record = look(checklistLockPath(stateDir), Date.now())?.record ?? null;
  return record !== null && (o.alive ?? processAlive)(record.pid) ? record : null;
}

/** Run `run` holding the lock; `busy` answers when it is taken. */
export async function withChecklistLock<T>(
  stateDir: string,
  holder: LockHolder,
  run: () => Promise<T>,
  busy: (held: LockRecord) => T | Promise<T>,
  o: LockOptions = {},
): Promise<T> {
  const got = acquireChecklistLock(stateDir, holder, o);
  if (!got.ok) return busy(got.held);
  try {
    return await run();
  } finally {
    got.lock.release();
  }
}

/** What holds the lock, as the person at the home reads it. */
export function lockHolderWords(held: Pick<LockRecord, "holder">): string {
  switch (held.holder) {
    case "setup":
      return "your host is setting the reviewer up right now";
    case "go_live":
      return "your host is taking the reviewer live right now";
    case "proof":
      return "your host is reading a practice review right now";
    case "home":
      return "another step of the home is changing the setup right now";
  }
}

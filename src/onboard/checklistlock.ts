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
//   holder      what took it: the home, or a host verb's kind
//   pid         the process that holds it now
//   token       the taker's own secret, which a hand-over keeps
//   boot_id     the boot of the machine it was taken in
//   start_time  when the holding process started, as the kernel counts it
//
// A lock whose process is gone is stale and is taken over. A pid alone does
// not say that: a machine that was stopped or restarted while a walk held the
// lock comes back with the file on disk, and the pid it names soon belongs to
// some other process. So a record is a living holder's only when its pid
// exists, the machine has not booted since (`boot_id`), and the process under
// that pid is the one that took the lock (`start_time`). Both are read from
// /proc; where they cannot be read (another system, a hidden /proc) the
// record carries neither, a reader that cannot read them compares neither,
// and the pid alone decides, as it did before either was recorded.
//
// A verb that starts a detached walk takes the lock itself, starts the walk,
// and hands the lock to it (`handTo`): the record is rewritten with the
// walk's pid and start time, and the walk adopts it by the token it was
// started with (`adoptChecklistLock`). There is no moment between the two
// when the lock names a dead process.
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

/** What can hold the lock: the home's switches, or one kind of host verb.
 * `trigger` is a host's `set-trigger`, for the moment it hands its choice to
 * the running daemon: never beside a walk that may be restarting it. */
export const LOCK_HOLDERS = ["home", "setup", "go_live", "proof", "trigger"] as const;
export type LockHolder = (typeof LOCK_HOLDERS)[number];

export interface LockRecord {
  holder: LockHolder;
  pid: number;
  token: string;
  acquired_at: string;
  /** The machine's boot when the lock was taken; absent where it could not
   * be read. */
  boot_id?: string;
  /** When process `pid` started, in the kernel's own count; absent where it
   * could not be read. */
  start_time?: string;
}

/**
 * What the machine says of a process. The three are one view of one machine:
 * a caller that hands its own `alive` and neither of the others gets neither
 * (no boot id, no start time), never this machine's /proc beside another
 * world's pids.
 */
export interface ProcessFacts {
  /** Does process `pid` exist? Default: signal 0. */
  alive?: (pid: number) => boolean;
  /** This boot of the machine; null where it cannot be read. Default:
   * /proc/sys/kernel/random/boot_id. */
  bootId?: () => string | null;
  /** When process `pid` started; null where it cannot be read. Default:
   * field 22 of /proc/<pid>/stat. */
  startTime?: (pid: number) => string | null;
}

export interface LockOptions extends ProcessFacts {
  /** The taking process; default: this one. */
  pid?: number;
  now?: () => Date;
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

/** This boot of the machine, as the kernel names it; null where /proc does
 * not say. */
export function machineBootId(read: (path: string) => string = readUtf8): string | null {
  try {
    const id = read("/proc/sys/kernel/random/boot_id").trim();
    return id === "" ? null : id;
  } catch {
    return null;
  }
}

/** When process `pid` started: field 22 of its /proc stat line, clock ticks
 * since the boot. Null where /proc does not say. The process's name, the
 * second field, may hold spaces and brackets, so the fields are counted from
 * the last closing bracket. */
export function processStartTime(
  pid: number,
  read: (path: string) => string = readUtf8,
): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const stat = read(`/proc/${pid}/stat`);
    const rest = stat.slice(stat.lastIndexOf(")") + 1).trim();
    // `rest` begins at field 3 (the state)
    const ticks = rest.split(/\s+/)[19];
    return ticks !== undefined && /^[0-9]+$/.test(ticks) ? ticks : null;
  } catch {
    return null;
  }
}

function readUtf8(path: string): string {
  return readFileSync(path, "utf8");
}

type Facts = Required<ProcessFacts>;

/** The facts a lock is judged by: the caller's, or this machine's own. */
function factsOf(o: ProcessFacts): Facts {
  const own = o.alive === undefined;
  return {
    alive: o.alive ?? processAlive,
    bootId: o.bootId ?? (own ? () => machineBootId() : () => null),
    startTime: o.startTime ?? (own ? (pid) => processStartTime(pid) : () => null),
  };
}

/**
 * Is `record` held by a living process: the one that took it, in this boot?
 * A boot id or a start time is compared only when the record carries it and
 * the machine can say its own; a difference in either is a stale lock.
 */
function heldByLiving(record: LockRecord, facts: Facts): boolean {
  if (!facts.alive(record.pid)) return false;
  if (record.boot_id !== undefined) {
    const boot = facts.bootId();
    if (boot !== null && boot !== record.boot_id) return false;
  }
  if (record.start_time !== undefined) {
    const started = facts.startTime(record.pid);
    if (started !== null && started !== record.start_time) return false;
  }
  return true;
}

/** `record` with what the machine says of process `pid` now: this boot, and
 * when that process started. A fact that cannot be read is left out. */
function stamped(record: LockRecord, pid: number, facts: Facts): LockRecord {
  const { boot_id: _boot, start_time: _start, ...rest } = record;
  const boot = facts.bootId();
  const started = facts.startTime(pid);
  return {
    ...rest,
    pid,
    ...(boot !== null ? { boot_id: boot } : {}),
    ...(started !== null ? { start_time: started } : {}),
  };
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
  const bootId = r["boot_id"];
  const startTime = r["start_time"];
  return {
    holder: r["holder"],
    pid: r["pid"],
    token: r["token"],
    acquired_at: typeof r["acquired_at"] === "string" ? r["acquired_at"] : "",
    ...(typeof bootId === "string" && bootId !== "" ? { boot_id: bootId } : {}),
    ...(typeof startTime === "string" && startTime !== "" ? { start_time: startTime } : {}),
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

function handle(path: string, record: LockRecord, exclusive: boolean, facts: Facts): HeldLock {
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
        // the new holder's own start time, in this boot
        writeFileSync(tmp, render(stamped(record, pid, facts)), { mode: 0o600 });
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
  const facts = factsOf(o);
  const at = (o.now ?? (() => new Date()))();
  const pid = o.pid ?? process.pid;
  const record: LockRecord = stamped(
    {
      holder,
      pid,
      token: randomBytes(16).toString("hex"),
      acquired_at: at.toISOString(),
    },
    pid,
    facts,
  );
  let last: LockRecord | null = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      mkdirSync(dirname(path), { recursive: true });
      create(path, record);
      return { ok: true, lock: handle(path, record, true, facts) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException | null)?.code !== "EEXIST")
        return { ok: true, lock: handle(path, record, false, facts) };
    }
    const seen = look(path, at.getTime());
    if (seen === null) continue; // released in between: try again
    if (seen.record !== null && heldByLiving(seen.record, facts))
      return { ok: false, held: seen.record };
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
 * or the lock went to someone else), and for a record of another boot or of
 * another process under this pid: that one is stale, and nobody's to adopt.
 */
export function adoptChecklistLock(
  stateDir: string,
  token: string,
  o: Pick<LockOptions, "pid" | "bootId" | "startTime"> = {},
): HeldLock | null {
  const path = checklistLockPath(stateDir);
  const record = look(path, Date.now())?.record ?? null;
  if (record === null || token === "" || record.token !== token) return null;
  const pid = o.pid ?? process.pid;
  if (record.pid !== pid) return null;
  // the adopter is this process: it lives, and only its boot and start are asked
  const own = o.pid === undefined && o.bootId === undefined && o.startTime === undefined;
  const facts: Facts = {
    alive: () => true,
    bootId: o.bootId ?? (own ? () => machineBootId() : () => null),
    startTime: o.startTime ?? (own ? (p) => processStartTime(p) : () => null),
  };
  if (!heldByLiving(record, facts)) return null;
  return handle(path, record, true, facts);
}

/** Who holds the lock now, when a living process does (the one that took it,
 * in this boot); else null. */
export function checklistLockHolder(stateDir: string, o: ProcessFacts = {}): LockRecord | null {
  const record = look(checklistLockPath(stateDir), Date.now())?.record ?? null;
  return record !== null && heldByLiving(record, factsOf(o)) ? record : null;
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
    case "trigger":
      return "your host is changing which pull requests are reviewed right now";
    case "home":
      return "another step of the home is changing the setup right now";
  }
}

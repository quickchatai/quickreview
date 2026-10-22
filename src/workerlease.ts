// The worker lease (P8.5, D23): one small file per session that names the worker
// process the WorkerSupervisor started, so a daemon that comes back after a
// crash can find the group it must kill, and can tell that group from a
// stranger.
//
// Pids and pgids repeat. A recreated container starts counting again, a long-
// lived one wraps, and a lease is read after the process it names may be long
// gone. So a lease records what a pid alone cannot: the process's START TIME
// (field 22 of /proc/<pid>/stat, in clock ticks since boot) and a boot/container
// id. A group is signalled only when the leader still has that start time in
// that boot and container; any other answer is "not ours", and nothing is
// signalled.
//
// The file is fenced by an owner token: only the spawn that created a lease may
// update or remove it, and a second create for the same session is refused. The
// supervisor is the only writer.
//
// Neutral by design: node builtins and src/ipc/capability.ts only, so the
// daemon can import it without reaching src/engine/ (tests/fences-engine.test.ts).
import { randomBytes } from "node:crypto";
import {
  closeSync,
  linkSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { ensurePrivateDir } from "./ipc/capability.js";

/** `<state>/run/workers`: 0700, beside the socket and the capability files. */
export function leaseDirOf(runDir: string): string {
  return join(runDir, "workers");
}

export interface WorkerLease {
  v: 1;
  /** Fences the file: only the spawn that holds it may update or remove it. It is
   * also the `owner_token` of the session_commands row, so one token ties the
   * row, the lease and the process together. */
  owner_token: string;
  command_id: string;
  session: string;
  pr: number;
  /** The session's generation: the command's attempt at the claim. */
  generation: number;
  /** Null from the moment the lease is taken until the process exists. */
  pid: number | null;
  pgid: number | null;
  /** The leader's start time, in clock ticks since boot (a string: it is an
   * unsigned 64-bit number). Null with the pid. */
  start_time: string | null;
  /** `<boot_id>/<container id>` of the daemon that wrote it. */
  boot_id: string;
  /** What was started, for a human reading the file: no secret, no capability. */
  command: string;
  created_at: string;
}

const SESSION_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/** A leader's identity as /proc reports it. */
export interface ProcIdentity {
  start: string;
  pgid: number;
}

/** What the lease logic reads of the machine: a seam, so a test can say "another
 * container" without one. */
export interface ProcView {
  /** Undefined when no such process exists, or only a zombie does. */
  identity(pid: number): ProcIdentity | undefined;
  /** The live processes of a group, with their start times. */
  members(pgid: number): Array<{ pid: number; start: string }>;
  bootId(): string;
}

/** `/proc/<pid>/stat` after its closing paren: field 3 is `rest[0]`, so field n
 * is `rest[n - 3]`. The command name (field 2) may hold spaces and parens, which
 * is why the split is after the LAST `)`. */
export function parseStat(raw: string): { state: string; pgid: number; start: string } | undefined {
  const close = raw.lastIndexOf(")");
  if (close < 0) return undefined;
  const rest = raw
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const pgid = Number(rest[2]);
  const start = rest[19];
  if (!rest[0] || !Number.isInteger(pgid) || start === undefined || !/^\d+$/.test(start))
    return undefined;
  return { state: rest[0], pgid, start };
}

function readStat(pid: number): ReturnType<typeof parseStat> {
  try {
    return parseStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return undefined;
  }
}

let cachedBootId: string | undefined;

/** The kernel's boot id plus the id of the container this process runs in. The
 * boot id alone is the HOST's, and survives a container being recreated; the
 * container id is what changes then. */
export function bootContainerId(): string {
  if (cachedBootId !== undefined) return cachedBootId;
  let boot = "unknown";
  try {
    boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    /* not Linux */
  }
  cachedBootId = `${boot}/${containerId()}`;
  return cachedBootId;
}

function containerId(): string {
  for (const file of ["/proc/self/mountinfo", "/proc/self/cgroup"]) {
    try {
      const m = /[/-]([0-9a-f]{64})(?:[/.]|$)/.exec(readFileSync(file, "utf8"));
      if (m) return m[1]!.slice(0, 12);
    } catch {
      /* try the next */
    }
  }
  // Docker names the container's hostname after its id; a bare host has its own.
  return hostname();
}

export const realProc: ProcView = {
  identity(pid) {
    const s = readStat(pid);
    return s === undefined || s.state === "Z" || s.state === "X"
      ? undefined
      : { start: s.start, pgid: s.pgid };
  },
  members(pgid) {
    const out: Array<{ pid: number; start: string }> = [];
    let names: string[];
    try {
      names = readdirSync("/proc");
    } catch {
      return out;
    }
    for (const name of names) {
      if (!/^\d+$/.test(name)) continue;
      const s = readStat(Number(name));
      if (s !== undefined && s.pgid === pgid && s.state !== "Z" && s.state !== "X")
        out.push({ pid: Number(name), start: s.start });
    }
    return out;
  },
  bootId: bootContainerId,
};

/** Unsigned clock-tick counts compared as numbers; they fit a double for centuries. */
const ticks = (s: string): number => Number(s);

export type LeaseVerdict =
  /** The leader is ours and alive: signal the group. */
  | { kind: "group"; pgid: number }
  /** The leader is gone but members of its group are not: signal each. */
  | { kind: "members"; pids: number[] }
  /** Nothing of this lease is running. */
  | { kind: "dead" }
  /** The pid (or the whole lease) belongs to someone else now: signal nothing. */
  | { kind: "foreign"; why: string }
  /** The lease was taken but no process was ever recorded. */
  | { kind: "unstarted" };

/** What a lease still names. The ONLY place that decides whether a signal may
 * be sent, so every kill goes through it. */
export function judgeLease(lease: WorkerLease, proc: ProcView = realProc): LeaseVerdict {
  if (lease.boot_id !== proc.bootId())
    return { kind: "foreign", why: "the lease was written in another boot or container" };
  if (lease.pid === null || lease.pgid === null || lease.start_time === null)
    return { kind: "unstarted" };
  const leader = proc.identity(lease.pid);
  if (leader === undefined) {
    // The leader is gone; its tool children may not be. They are told apart from
    // a stranger that took the pgid number by their start time: none can predate
    // the leader that made the group.
    const pids = proc
      .members(lease.pgid)
      .filter((m) => ticks(m.start) >= ticks(lease.start_time!))
      .map((m) => m.pid);
    return pids.length > 0 ? { kind: "members", pids } : { kind: "dead" };
  }
  if (leader.start !== lease.start_time)
    return { kind: "foreign", why: `pid ${lease.pid} now belongs to another process` };
  if (leader.pgid !== lease.pgid)
    return {
      kind: "foreign",
      why: `pid ${lease.pid} is no longer the leader of group ${lease.pgid}`,
    };
  return { kind: "group", pgid: lease.pgid };
}

export class LeaseHeld extends Error {
  constructor(session: string) {
    super(`a worker lease for ${session} already exists`);
    this.name = "LeaseHeld";
  }
}

export class WorkerLeases {
  /** `searchable`: the dir is also the way a pane's pi, run as the tool uid,
   * reaches what was shared with it (run/takeover, run/debug), so the group may
   * pass through it (0710); a lease file in it stays the owner's alone. */
  constructor(
    readonly dir: string,
    o: { searchable?: boolean } = {},
  ) {
    ensurePrivateDir(dir, o);
  }

  private path(session: string): string {
    if (!SESSION_RE.test(session))
      throw new Error(`not a session name: ${JSON.stringify(session)}`);
    return join(this.dir, `${session}.lease.json`);
  }

  /** A fresh owner token for a spawn. */
  static newToken(): string {
    return randomBytes(16).toString("hex");
  }

  /** The lease, undefined when there is none; null when the file is not a lease
   * (a crash mid-write, or someone's edit): the caller removes it. */
  read(session: string): WorkerLease | null | undefined {
    const file = this.path(session);
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      return null;
    }
    return parseLease(text, session);
  }

  /** Every lease file, with the session it names; an unreadable one reads null. */
  list(): Array<{ session: string; lease: WorkerLease | null }> {
    const out: Array<{ session: string; lease: WorkerLease | null }> = [];
    for (const name of readdirSync(this.dir)) {
      const m = /^(.+)\.lease\.json$/.exec(name);
      if (!m || !SESSION_RE.test(m[1]!)) continue;
      const lease = this.read(m[1]!);
      if (lease !== undefined) out.push({ session: m[1]!, lease });
    }
    return out;
  }

  /** Take the session's lease, or throw `LeaseHeld`. Published with link(2), so
   * the file is whole the moment it exists and only one creator wins. */
  create(lease: WorkerLease): void {
    const final = this.path(lease.session);
    const tmp = `${final}.${randomBytes(6).toString("hex")}.tmp`;
    this.writeFile(tmp, lease);
    try {
      linkSync(tmp, final);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new LeaseHeld(lease.session);
      throw e;
    } finally {
      unlinkSync(tmp);
    }
  }

  /** Update the lease the token owns. False when the file is gone or another
   * spawn holds it: a stale supervisor step cannot touch a newer lease. */
  update(session: string, token: string, patch: Partial<WorkerLease>): boolean {
    const current = this.read(session);
    if (!current || current.owner_token !== token) return false;
    const tmp = `${this.path(session)}.${randomBytes(6).toString("hex")}.tmp`;
    this.writeFile(tmp, { ...current, ...patch, owner_token: token, session });
    renameSync(tmp, this.path(session));
    return true;
  }

  /** Remove the lease the token owns. False when it is not that spawn's. */
  remove(session: string, token: string): boolean {
    const current = this.read(session);
    if (!current || current.owner_token !== token) return false;
    this.forget(session);
    return true;
  }

  /** Remove whatever lease the session has: the boot's, after it has dealt with
   * the process the lease named. */
  forget(session: string): void {
    try {
      unlinkSync(this.path(session));
    } catch {
      /* already gone */
    }
  }

  private writeFile(path: string, lease: WorkerLease): void {
    const fd = openSync(path, "wx", 0o600);
    try {
      writeSync(fd, `${JSON.stringify(lease)}\n`);
    } finally {
      closeSync(fd);
    }
  }
}

function parseLease(text: string, session: string): WorkerLease | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const str = (k: string): string | null => (typeof o[k] === "string" && o[k] !== "" ? o[k] : null);
  const int = (k: string): number | null =>
    typeof o[k] === "number" && Number.isSafeInteger(o[k]) ? o[k] : null;
  const token = str("owner_token");
  const commandId = str("command_id");
  const boot = str("boot_id");
  const pr = int("pr");
  const generation = int("generation");
  const start = o["start_time"];
  if (
    o["v"] !== 1 ||
    token === null ||
    commandId === null ||
    boot === null ||
    pr === null ||
    generation === null ||
    o["session"] !== session ||
    (start !== null && (typeof start !== "string" || !/^\d+$/.test(start)))
  )
    return null;
  return {
    v: 1,
    owner_token: token,
    command_id: commandId,
    session,
    pr,
    generation,
    pid: int("pid"),
    pgid: int("pgid"),
    start_time: start ?? null,
    boot_id: boot,
    command: typeof o["command"] === "string" ? o["command"] : "",
    created_at: typeof o["created_at"] === "string" ? o["created_at"] : "",
  };
}

/** Signals a group (`-pgid`) or one pid; ESRCH is not an error, EPERM is
 * reported (a tool-uid process the run uid may not signal). */
export type SignalFn = (target: number, signal: NodeJS.Signals) => "sent" | "gone" | "denied";

export const sendSignal: SignalFn = (target, signal) => {
  try {
    process.kill(target, signal);
    return "sent";
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "denied";
  }
};

export interface KillOptions {
  proc?: ProcView;
  signal?: SignalFn;
  /** How long a TERM gets before the KILL. */
  graceMs: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface KillOutcome {
  verdict: LeaseVerdict["kind"];
  /** Signals that were refused (EPERM), by target: reported, never fatal. */
  denied: number[];
  /** Whether a KILL was needed after the TERM's grace. */
  killed: boolean;
  /** Whether something the lease named was still running when this gave up. */
  survivors: boolean;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Stop what a lease names: TERM, wait out the grace, KILL. The lease is judged
 * again before the KILL, so a pid that was reused during the grace is not shot.
 * A `foreign`, `dead` or `unstarted` lease sends nothing.
 */
export async function killLease(lease: WorkerLease, o: KillOptions): Promise<KillOutcome> {
  const proc = o.proc ?? realProc;
  const signal = o.signal ?? sendSignal;
  const sleep = o.sleep ?? defaultSleep;
  const now = o.now ?? Date.now;
  const denied = new Set<number>();
  const fire = (v: LeaseVerdict, sig: NodeJS.Signals): void => {
    const targets = v.kind === "group" ? [-v.pgid] : v.kind === "members" ? v.pids : [];
    for (const t of targets) if (signal(t, sig) === "denied") denied.add(Math.abs(t));
  };
  const first = judgeLease(lease, proc);
  if (first.kind !== "group" && first.kind !== "members")
    return { verdict: first.kind, denied: [], killed: false, survivors: false };
  fire(first, "SIGTERM");
  const until = now() + o.graceMs;
  let v: LeaseVerdict = judgeLease(lease, proc);
  while ((v.kind === "group" || v.kind === "members") && now() < until) {
    await sleep(o.pollMs ?? 50);
    v = judgeLease(lease, proc);
  }
  let killed = false;
  if (v.kind === "group" || v.kind === "members") {
    fire(v, "SIGKILL");
    killed = true;
    // KILL is not instant for a process in uninterruptible sleep; look once more.
    await sleep(o.pollMs ?? 50);
    v = judgeLease(lease, proc);
  }
  return {
    verdict: first.kind,
    denied: [...denied],
    killed,
    survivors: v.kind === "group" || v.kind === "members",
  };
}

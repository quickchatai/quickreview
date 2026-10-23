// Per-command capabilities and how they reach a process.
//
// A capability is 128 random bits minted for ONE command. The daemon never puts
// it in argv or env. It writes it into a 0600 file that it unlinks at once,
// keeps the descriptor, and hands the host that descriptor as an inherited fd;
// env carries only the fd NUMBER. Every reader takes the secret with pread at
// offset 0, which does not consume it, so the host and each post shim (children
// of the model's bash, which inherit the fd) can all read it, round after round.
//
// tmux does not pass fds to a pane, so a takeover or debug pi gets a LAUNCH
// FILE instead (`LaunchFiles`): the launcher in the pane opens it, unlinks it
// and execs pi with the fd. An unclaimed launch file is deleted after 30 s and
// its capability revoked.
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { CAPABILITY_RE, IpcError } from "./protocol.js";

/** The socket's directory under the daemon's state dir: 0700, daemon uid. */
export function runDirOf(stateDir: string): string {
  return join(stateDir, "run");
}
export function socketPathOf(stateDir: string): string {
  return join(runDirOf(stateDir), "qcr.sock");
}
export function capsDirOf(stateDir: string): string {
  return join(runDirOf(stateDir), "caps");
}

/** Make `dir` (and parents) and force it to 0700 owned by this uid. A dir that
 * belongs to someone else is an error: the daemon's secrets live under it.
 * `searchable` makes it 0710 instead: the group may pass through it to a name it
 * already knows (the socket, for the tool uid's post and read shims),
 * never list it or create anything in it. */
/** Whether the model's tools run as another uid of this process's group (the
 * entrypoint named one): the dirs a pane's pi must pass through to reach what
 * was shared with it are then searchable by the group (0710), never listable. */
export function toolUidSplit(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^[1-9][0-9]*$/.test(env["QCR_TOOL_UID"] ?? "");
}

export function ensurePrivateDir(dir: string, o: { searchable?: boolean } = {}): void {
  const mode = o.searchable === true ? 0o710 : 0o700;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = statSync(dir);
  if (typeof process.getuid === "function" && st.uid !== process.getuid())
    throw new Error(`${dir} is not owned by this user`);
  if ((st.mode & 0o777) !== mode) chmodSync(dir, mode);
}

/** Linux's O_TMPFILE is `__O_TMPFILE | O_DIRECTORY` with `__O_TMPFILE` = 020000000
 * on every architecture we run on; node does not export it. */
const O_TMPFILE = process.platform === "linux" ? 0o20000000 | constants.O_DIRECTORY : 0;

/** A new capability: 128 random bits as 32 hex characters. */
export function mintCapability(): string {
  return randomBytes(16).toString("hex");
}

/**
 * The daemon-side table of live capabilities, one per command. Verification is
 * constant-time. Revoking drops the entry and tells the listeners (the server
 * closes that command's connections).
 */
export class CapabilityStore {
  private readonly caps = new Map<string, string>();
  private readonly revokeListeners = new Set<(commandId: string) => void>();

  /** Mint (or replace) the command's capability. */
  mint(commandId: string): string {
    const cap = mintCapability();
    this.caps.set(commandId, cap);
    return cap;
  }

  get(commandId: string): string | undefined {
    return this.caps.get(commandId);
  }

  verify(commandId: string, presented: string): boolean {
    const live = this.caps.get(commandId);
    if (live === undefined || !CAPABILITY_RE.test(presented)) return false;
    return timingSafeEqual(Buffer.from(live), Buffer.from(presented));
  }

  revoke(commandId: string): void {
    if (!this.caps.delete(commandId)) return;
    for (const fn of this.revokeListeners) fn(commandId);
  }

  onRevoke(fn: (commandId: string) => void): () => void {
    this.revokeListeners.add(fn);
    return () => this.revokeListeners.delete(fn);
  }

  size(): number {
    return this.caps.size;
  }
}

/**
 * The handoff: a descriptor on a 0600 file that has no name. O_TMPFILE where the
 * kernel and filesystem give it; otherwise a file created exclusively and
 * unlinked in the same breath. The caller keeps the fd, passes it to the host
 * as an inherited stdio entry and closes it when the command ends.
 */
export function createCapabilityFd(runDir: string, capability: string): number {
  if (!CAPABILITY_RE.test(capability)) throw new Error("not a capability");
  ensurePrivateDir(runDir);
  let fd = -1;
  if (O_TMPFILE !== 0) {
    try {
      fd = openSync(runDir, O_TMPFILE | constants.O_RDWR, 0o600);
    } catch {
      fd = -1; // no O_TMPFILE here (old kernel, odd filesystem): fall back
    }
  }
  if (fd < 0) {
    const name = join(runDir, `.cap-${process.pid}-${randomBytes(6).toString("hex")}`);
    fd = openSync(name, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL, 0o600);
    unlinkSync(name);
  }
  try {
    writeSync(fd, capability, 0);
  } catch (e) {
    closeSync(fd);
    throw e;
  }
  return fd;
}

/** Read the capability from an inherited fd with pread at offset 0: the offset
 * is never moved, so every reader sees the secret, every time. */
export function readCapabilityFd(fd: number): string {
  const buf = Buffer.alloc(64);
  const n = readSync(fd, buf, 0, buf.length, 0);
  const cap = buf.subarray(0, n).toString("utf8").trim();
  if (!CAPABILITY_RE.test(cap)) throw new IpcError("unauthorized", "the fd holds no capability");
  return cap;
}

/** The fd's index in the child. 0-2 are stdio. */
export const CAP_FD_INDEX = 3;

/** A spawn `stdio` array: the caller's three standard streams plus the
 * capability fd at `CAP_FD_INDEX`. */
export function stdioWithCapability(
  std: readonly [unknown, unknown, unknown],
  capFd: number,
): Array<unknown> {
  return [std[0], std[1], std[2], capFd];
}

export interface IpcEnvInput {
  socketPath: string;
  commandId: string;
  generation: number;
  /** The fd NUMBER in the child, not the secret. */
  capFdIndex?: number;
}

/** The env a host and its shims read: the socket, which command, which
 * generation, and the fd number. No secret. */
export function ipcEnv(input: IpcEnvInput): Record<string, string> {
  return {
    QCR_IPC_SOCKET: input.socketPath,
    QCR_IPC_COMMAND_ID: input.commandId,
    QCR_IPC_GENERATION: String(input.generation),
    QCR_IPC_CAP_FD: String(input.capFdIndex ?? CAP_FD_INDEX),
  };
}

export interface LaunchFile {
  path: string;
  commandId: string;
}

export interface LaunchFilesOptions {
  /** `<state>/run/caps` */
  capsDir: string;
  store: CapabilityStore;
  /** Unclaimed files are deleted and their capability revoked after this. */
  ttlMs?: number;
  now?: () => number;
}

/** How long a launch file may sit unclaimed. */
export const LAUNCH_FILE_TTL_MS = 30_000;

/**
 * Launch files for panes that cannot inherit an fd (tmux). The daemon creates
 * the file; the launcher in the pane claims it (`claimLaunchFile`), which
 * unlinks it. One that is still on disk at its deadline was never claimed, so
 * it is removed and the command's capability revoked.
 */
export class LaunchFiles {
  private readonly pending = new Map<
    string,
    { commandId: string; deadline: number; timer: NodeJS.Timeout }
  >();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(private readonly opts: LaunchFilesOptions) {
    this.ttlMs = opts.ttlMs ?? LAUNCH_FILE_TTL_MS;
    this.now = opts.now ?? (() => Date.now());
    ensurePrivateDir(opts.capsDir);
    this.purge();
  }

  /** Delete whatever a previous daemon left behind: its workers died with it. */
  purge(): void {
    for (const name of readdirSync(this.opts.capsDir)) {
      try {
        unlinkSync(join(this.opts.capsDir, name));
      } catch {
        /* already gone */
      }
    }
  }

  create(commandId: string): LaunchFile {
    const cap = this.opts.store.get(commandId);
    if (cap === undefined) throw new Error(`no capability minted for ${commandId}`);
    const path = join(this.opts.capsDir, `${randomBytes(12).toString("hex")}.cap`);
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      writeSync(fd, cap);
    } finally {
      closeSync(fd);
    }
    const timer = setTimeout(() => this.sweep(), this.ttlMs + 1);
    timer.unref();
    this.pending.set(path, { commandId, deadline: this.now() + this.ttlMs, timer });
    return { path, commandId };
  }

  /** Forget the claimed, remove and revoke the expired. Returns the command ids
   * revoked. Runs from the deadline timer and may be called directly. */
  sweep(): string[] {
    const revoked: string[] = [];
    for (const [path, entry] of this.pending) {
      if (!existsFile(path)) {
        clearTimeout(entry.timer);
        this.pending.delete(path);
        continue; // claimed: the launcher unlinked it
      }
      if (this.now() < entry.deadline) continue;
      try {
        unlinkSync(path);
      } catch {
        /* claimed in the meantime */
      }
      clearTimeout(entry.timer);
      this.pending.delete(path);
      this.opts.store.revoke(entry.commandId);
      revoked.push(entry.commandId);
    }
    return revoked;
  }

  /** Remove the unclaimed launch files of `commandId`, if any: its host is being
   * stopped. The capability is the caller's to revoke. A claimed file is already
   * gone. */
  cancel(commandId: string): number {
    let n = 0;
    for (const [path, entry] of this.pending) {
      if (entry.commandId !== commandId) continue;
      try {
        unlinkSync(path);
      } catch {
        /* claimed in the meantime */
      }
      clearTimeout(entry.timer);
      this.pending.delete(path);
      n++;
    }
    return n;
  }

  /** Files created and neither claimed nor expired yet. */
  outstanding(): number {
    return this.pending.size;
  }

  dispose(): void {
    for (const e of this.pending.values()) clearTimeout(e.timer);
    this.pending.clear();
  }
}

function existsFile(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The launcher's half: open the launch file, check it is ours and private,
 * unlink it, and return the open fd. The unlink is the claim: of two openers
 * only one unlinks, and the other is refused.
 */
export function claimLaunchFile(path: string): number {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || (st.mode & 0o077) !== 0)
      throw new IpcError("unauthorized", "the launch file is not a private regular file");
    if (typeof process.getuid === "function" && st.uid !== process.getuid())
      throw new IpcError("unauthorized", "the launch file belongs to another user");
    unlinkSync(path);
    readCapabilityFd(fd);
    return fd;
  } catch (e) {
    closeSync(fd);
    throw e;
  }
}

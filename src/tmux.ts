// Process-exec primitive + a thin tmux wrapper (spec §9: tmux lives inside the
// container; the local build targets the same commands). Every session-manager
// command — git, tmux, pi — goes through the injectable ExecFn so tests can record
// invocations instead of spawning anything.
import { spawn } from "node:child_process";

export interface ExecOpts {
  cwd?: string;
  /** Fully-constructed environment. Callers pass an explicit env — never a
   * spread of process.env — so no personal credential can leak into a
   * session. */
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type ExecFn = (cmd: string, args: string[], opts?: ExecOpts) => Promise<ExecResult>;

export class ExecError extends Error {
  constructor(
    readonly cmd: string,
    readonly args: string[],
    readonly result: ExecResult,
  ) {
    super(
      `${cmd} ${args.join(" ")} exited ${result.code}: ${result.stderr.trim() || result.stdout.trim()}`,
    );
    this.name = "ExecError";
  }
}

/** Default ExecFn: spawn, capture, never inherit a shell. */
export const nodeExec: ExecFn = (cmd, args, opts = {}) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs) timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs);
    child.stdout?.on("data", (d) => (stdout += String(d)));
    child.stderr?.on("data", (d) => (stderr += String(d)));
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolvePromise({ code: code ?? -1, stdout, stderr });
    });
    if (opts.input !== undefined) {
      child.stdin?.write(opts.input);
      child.stdin?.end();
    }
  });

/** Run and throw on a non-zero exit. */
export async function runOrThrow(
  exec: ExecFn,
  cmd: string,
  args: string[],
  opts?: ExecOpts,
): Promise<ExecResult> {
  const res = await exec(cmd, args, opts);
  if (res.code !== 0) throw new ExecError(cmd, args, res);
  return res;
}

/** `Tmux.listSessionsKnown`'s default bound: a tmux that has not answered by
 * then is killed and read as "could not ask" (null). */
export const LIST_SESSIONS_TIMEOUT_MS = 10_000;

/**
 * Does tmux's stderr say "no server running"? Exactly two answers do:
 * `no server running on <sock>` (a stale socket, ECONNREFUSED) and
 * `error connecting to <sock> (No such file or directory)` (no socket at all).
 * tmux prints the same `error connecting to` prefix for EVERY other connect
 * errno — Permission denied, EAGAIN — and those are "could not ask", never
 * "none alive".
 */
export function isNoTmuxServer(stderr: string): boolean {
  return /no server running|error connecting to .*\(No such file or directory\)/i.test(stderr);
}

/** A successful listing's session names, one per non-blank line. */
function sessionNames(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

export interface TmuxOptions {
  exec?: ExecFn;
  /** Binary name — overridable for the container wrapper. */
  bin?: string;
}

/**
 * Minimal tmux surface used by the session manager. Deliberately tiny: list,
 * has, new, kill, send. Nothing here ever kills a session it did not name.
 */
export class Tmux {
  private readonly exec: ExecFn;
  readonly bin: string;

  constructor(opts: TmuxOptions = {}) {
    this.exec = opts.exec ?? nodeExec;
    this.bin = opts.bin ?? "tmux";
  }

  /** Session names, empty when no tmux server is running. */
  async listSessions(): Promise<string[]> {
    const res = await this.exec(this.bin, ["list-sessions", "-F", "#{session_name}"]);
    if (res.code !== 0) return []; // "no server running on ..." is not an error here
    return sessionNames(res.stdout);
  }

  /**
   * Session names — or null when tmux could not be asked: its binary would
   * not start, it did not answer inside `timeoutMs` (killed), or it failed for
   * any reason but having no server. `listSessions` folds every failure into
   * []; a caller that must never read "could not ask" as "none alive" — the
   * archiver's eligibility — reads this one.
   *
   * Only `isNoTmuxServer`'s two answers mean "no server, so no sessions"
   * (the `rollover.ts` kill reads the same two).
   */
  async listSessionsKnown(timeoutMs = LIST_SESSIONS_TIMEOUT_MS): Promise<string[] | null> {
    let res: ExecResult;
    try {
      res = await this.exec(this.bin, ["list-sessions", "-F", "#{session_name}"], { timeoutMs });
    } catch {
      return null;
    }
    // A negative code is a kill (the timeout) or no exit status at all.
    if (res.code < 0) return null;
    if (res.code !== 0) return isNoTmuxServer(res.stderr) ? [] : null;
    return sessionNames(res.stdout);
  }

  /** Does tmux have `name`? Every failed probe — absent, no server, or one
   * that could not ask (a socket it may not open) — reads as false; a caller
   * that must not read "could not ask" as "gone" reads `listSessionsKnown`. */
  async hasSession(name: string): Promise<boolean> {
    const res = await this.exec(this.bin, ["has-session", "-t", `=${name}`]);
    return res.code === 0;
  }

  /**
   * Detached session running `command` (argv form — no shell interpolation of
   * caller data; tmux itself joins the argv).
   */
  async newSession(
    name: string,
    command: string[],
    opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
  ): Promise<void> {
    const args = ["new-session", "-d", "-s", name];
    if (opts.cwd) args.push("-c", opts.cwd);
    args.push(...command);
    await runOrThrow(this.exec, this.bin, args, { env: opts.env, cwd: opts.cwd });
  }

  /** The pid of the session's active pane (the leader of its process group), or
   * undefined when there is no such session. */
  async panePid(name: string): Promise<number | undefined> {
    const res = await this.exec(this.bin, ["list-panes", "-t", `=${name}:`, "-F", "#{pane_pid}"]);
    if (res.code !== 0) return undefined;
    const pid = Number(res.stdout.split("\n")[0]?.trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  }

  /** When the session last had client or pane activity, in epoch milliseconds;
   * undefined when tmux does not say. */
  async lastActivityMs(name: string): Promise<number | undefined> {
    const res = await this.exec(this.bin, [
      "display-message",
      "-p",
      "-t",
      `=${name}:`,
      "#{session_activity}",
    ]);
    if (res.code !== 0) return undefined;
    const seconds = Number(res.stdout.trim());
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
  }

  async killSession(name: string): Promise<void> {
    await this.exec(this.bin, ["kill-session", "-t", `=${name}`]);
  }

  /** Literal text into the session's active pane; `enter` appends Enter.
   * Target is `=name:` — tmux 3.5 rejects a bare `=name` as a PANE target
   * ("can't find pane"), while the trailing colon keeps exact-match session
   * semantics and resolves to the active window's active pane. */
  async send(name: string, text: string, enter = true): Promise<void> {
    await runOrThrow(this.exec, this.bin, ["send-keys", "-t", `=${name}:`, "-l", text]);
    if (enter) await runOrThrow(this.exec, this.bin, ["send-keys", "-t", `=${name}:`, "Enter"]);
  }
}

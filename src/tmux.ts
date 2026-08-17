// Process-exec primitive + a thin tmux wrapper (spec §9: tmux lives inside the
// container; the local build targets the same commands). Every command in B3
// — git, tmux, pi — goes through the injectable ExecFn so tests can record
// invocations instead of spawning anything.
import { spawn } from "node:child_process";

export interface ExecOpts {
  cwd?: string;
  /** Fully-constructed environment. Callers pass an explicit env — never a
   * spread of process.env — so no personal credential can leak into a
   * session (B3 hard rule). */
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
    super(`${cmd} ${args.join(" ")} exited ${result.code}: ${result.stderr.trim() || result.stdout.trim()}`);
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
    return res.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  }

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

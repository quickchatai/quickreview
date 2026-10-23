// The process-exec primitive every git, tmux and pi command goes through: an
// injectable ExecFn, so tests can record invocations instead of spawning
// anything. A leaf with no repo imports, so the review core (the delta reader,
// src/prdelta.ts) and the CLI use it without reaching src/tmux.ts.
import { spawn } from "node:child_process";

export interface ExecOpts {
  cwd?: string;
  /** Fully-constructed environment. Callers pass an explicit env — never a
   * spread of process.env — so no personal credential can leak into a
   * session. */
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
  /** Stops the command: the child is killed and the call rejects with the
   * signal's AbortError. */
  signal?: AbortSignal;
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
      ...(opts.signal ? { signal: opts.signal, killSignal: "SIGKILL" as const } : {}),
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

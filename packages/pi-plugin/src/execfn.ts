// The process-exec primitive every git, tmux and pi command goes through: an
// injectable ExecFn, so tests can record invocations instead of spawning
// anything. A leaf with no repo imports, so the review core (the delta reader,
// packages/pi-plugin/src/prdelta.ts) and the CLI use it without reaching src/tmux.ts.
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
  /** Start the child as the leader of its own process group, so the
   * timeout kills every process it started with it (a transport or
   * credential helper the child spawned), not the child alone. Off by
   * default: a child in its own group also leaves the terminal's, so an
   * interactive Ctrl-C no longer reaches it. */
  ownProcessGroup?: boolean;
}

/**
 * How long a timed-out command may take to report its exit before the call
 * settles without it. Node reports `close` only once every holder of the
 * child's output pipes is gone, and a descendant that escaped the kill can
 * hold them for ever: the timeout bounds the caller, not just the child.
 */
export const EXEC_SETTLE_GRACE_MS = 2_000;

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
      ...(opts.ownProcessGroup ? { detached: true } : {}),
    });
    let stdout = "";
    let stderr = "";
    let timer: NodeJS.Timeout | undefined;
    let grace: NodeJS.Timeout | undefined;
    let settled = false;
    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (grace) clearTimeout(grace);
      finish();
    };
    const kill = (): void => {
      // The negative pid names the child's whole process group.
      if (opts.ownProcessGroup && child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch {
          // The group is gone already; the child alone is still signalled.
        }
      }
      child.kill("SIGKILL");
    };
    if (opts.timeoutMs) {
      const timeoutMs = opts.timeoutMs;
      timer = setTimeout(() => {
        kill();
        grace = setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          settle(() =>
            resolvePromise({
              code: -1,
              stdout,
              stderr: `${stderr}${stderr && !stderr.endsWith("\n") ? "\n" : ""}${cmd}: killed after ${timeoutMs} ms; its output was still held open`,
            }),
          );
        }, EXEC_SETTLE_GRACE_MS);
      }, timeoutMs);
    }
    child.stdout?.on("data", (d) => (stdout += String(d)));
    child.stderr?.on("data", (d) => (stderr += String(d)));
    child.on("error", (err) => settle(() => reject(err)));
    child.on("close", (code) => settle(() => resolvePromise({ code: code ?? -1, stdout, stderr })));
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

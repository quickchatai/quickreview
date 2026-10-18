// A small subprocess helper for the AACR-Bench harness. Deliberately separate
// from the daemon's tmux/exec plumbing: the harness runs in its own sandbox
// image and must never share a code path that could reach a live session.

import { spawn } from "node:child_process";

/** pipeline.py `apply_defaults`: `--timeout-minutes` None → 30 — the review
 * budget the harness gives every reviewer it runs, which the arms run in the
 * shape of. */
export const HARNESS_TIMEOUT_MIN = 30;

/** Git without any system or global config and never prompting: every
 * environment the bench hands a reviewer or a git call carries it. */
export const GIT_ISOLATION_ENV = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
} as const;

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Cap on captured stdout; git diffs of a big PR must not exhaust memory. */
  maxBytes?: number;
}

/** Run a command to completion with argv (never a shell), capture its output. */
export function run(bin: string, args: string[], o: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    const processGroup = process.platform !== "win32" && Boolean(o.timeoutMs);
    const child = spawn(bin, args, {
      cwd: o.cwd,
      env: o.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: processGroup,
    });
    const max = o.maxBytes ?? 64 * 1024 * 1024;
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let timedOut = false;
    child.stdout.on("data", (b: Buffer) => {
      if (outBytes < max) out.push(b);
      outBytes += b.length;
    });
    child.stderr.on("data", (b: Buffer) => {
      if (err.length < 4096) err.push(b);
    });
    const timer = o.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          if (processGroup && child.pid !== undefined) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
          } else child.kill("SIGKILL");
        }, o.timeoutMs)
      : null;
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      resolve({ code: 127, stdout: "", stderr: String(e), timedOut });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        timedOut,
      });
    });
  });
}

/** `run`, but a non-zero exit throws with the command and its stderr. */
export async function must(bin: string, args: string[], o: ExecOptions = {}): Promise<string> {
  const r = await run(bin, args, o);
  if (r.code !== 0) {
    throw new Error(
      `${bin} ${args.join(" ")} failed (${r.timedOut ? "timeout" : `exit ${r.code}`}): ${r.stderr.trim().slice(0, 600)}`,
    );
  }
  return r.stdout;
}

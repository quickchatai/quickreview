// Remote access layer for qcr tui — every VM touch goes through here, and
// every command it can produce is read-only against the box except the two
// user-initiated writes (attach keystrokes ride a pty in attach.ts; inject
// files in msg.ts). Command construction is pure so tests can assert the
// exact argv; execution is one injectable runner.
import { spawn } from "node:child_process";
import type { TuiConfig } from "../config.js";

export interface RemoteResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

/** Runs `ssh <host> <argv…>`. Injectable — tests never spawn. */
export type SshRunner = (host: string, argv: string[], opts?: { stdin?: string; timeoutMs?: number }) => Promise<RemoteResult>;

function dockerPrefix(cfg: TuiConfig): string[] {
  return [...(cfg.sudo_docker ? ["sudo"] : []), "docker", "exec"];
}

/** `cat status.json` on the host — the state volume is host-mounted, no docker. */
export function statusArgv(cfg: TuiConfig): string[] {
  return ["cat", `${cfg.remote_state_dir}/status.json`];
}

/** In-container `qcr why <n> --json`. */
export function whyArgv(cfg: TuiConfig, pr: number): string[] {
  return [...dockerPrefix(cfg), cfg.container, "node", "dist/src/cli.js", "why", String(pr), "--json"];
}

/** In-container `qcr events --tail <k> --json`. */
export function eventsArgv(cfg: TuiConfig, tail: number): string[] {
  return [...dockerPrefix(cfg), cfg.container, "node", "dist/src/cli.js", "events", "--tail", String(tail), "--json"];
}

/** In-container `qcr today --json` (digest tab's spend/rounds source). */
export function todayArgv(cfg: TuiConfig): string[] {
  return [...dockerPrefix(cfg), cfg.container, "node", "dist/src/cli.js", "today", "--json"];
}

/** In-container `qcr metrics --json` (the metrics tab's aggregate source). */
export function metricsArgv(cfg: TuiConfig): string[] {
  return [...dockerPrefix(cfg), cfg.container, "node", "dist/src/cli.js", "metrics", "--json"];
}

/** In-container `qcr metrics --pr <n> --json` (the per-PR timeline). */
export function metricsPrArgv(cfg: TuiConfig, pr: number): string[] {
  return [...dockerPrefix(cfg), cfg.container, "node", "dist/src/cli.js", "metrics", "--pr", String(pr), "--json"];
}

/** Non-interactive snapshot of a live pi session for the board's mirror pane:
 * `-e` keeps the pane's colors, `-p` writes to stdout, `-J` joins wrapped
 * lines. Read-only — the mirror never writes a keystroke (that is attach). */
export function captureArgv(cfg: TuiConfig, session: string): string[] {
  return [...dockerPrefix(cfg), cfg.container, "tmux", "capture-pane", "-e", "-p", "-J", "-t", session];
}

/** The interactive attach argv — the whole remote command after `ssh`. */
export function attachArgv(cfg: TuiConfig, session: string): string[] {
  return ["-tt", cfg.ssh_host, ...dockerPrefix(cfg), "-it", cfg.container, "tmux", "attach", "-t", session];
}

export const realSshRunner: SshRunner = (host, argv, opts) =>
  new Promise((resolvePromise) => {
    const child = spawn("ssh", ["-o", "BatchMode=yes", host, ...argv], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (ok: boolean, code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ ok, stdout, stderr, code });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle(false, null);
    }, opts?.timeoutMs ?? 15_000);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", () => settle(false, null));
    child.on("close", (code) => settle(code === 0, code));
    if (opts?.stdin !== undefined) child.stdin.end(opts.stdin);
    else child.stdin.end();
  });

// VM ssh bootstrap — the GCP metadata key (~/.ssh/google_compute_engine)
// is passphrase-protected, and every TUI ssh runs BatchMode (fail-fast, no
// prompts). The passphrase therefore gets entered exactly once, here, on the
// operator's real terminal: `ssh <host> true` births the ControlMaster socket
// the ssh config then shares for 4h (ControlPersist), and every poll/digest
// ssh rides it.
//
// This is only reached from the board (key s), never from the startup path:
// nothing external may gate the first frame, so startup runs the
// non-interactive triage in `sshtriage.ts` instead and reports the cause and
// the exact remedy; pressing `s` is the operator asking for this prompt.
import { spawnSync } from "node:child_process";
import type { TuiConfig } from "../config.js";
import { NO_SSH_HOST_STDERR, transportOf } from "./remote.js";

export function masterCheckArgv(cfg: TuiConfig): string[] {
  return ["-O", "check", cfg.ssh_host];
}

export function masterConnectArgv(cfg: TuiConfig): string[] {
  return ["-o", "ConnectTimeout=15", cfg.ssh_host, "true"];
}

export interface ConnectResult {
  /** `"local"`: `[tui] target = "local"` — there is no master to
   * establish and no ssh process is ever spawned; the call is a silent no-op. */
  kind: "alive" | "connected" | "failed" | "local";
  detail?: string;
}

/** Synchronous ssh — interactive runs inherit the terminal so OpenSSH's own
 * passphrase prompt appears natively. Injectable; tests never spawn. */
export type SyncSsh = (
  argv: string[],
  interactive: boolean,
) => { status: number | null; stderr: string };

export const realSyncSsh: SyncSsh = (argv, interactive) => {
  const r = interactive
    ? spawnSync("ssh", argv, { stdio: "inherit" })
    : spawnSync("ssh", argv, { stdio: ["ignore", "ignore", "pipe"], timeout: 10_000 });
  return { status: r.status, stderr: String(r.stderr ?? "") };
};

export function ensureSshMaster(
  cfg: TuiConfig,
  ssh: SyncSsh = realSyncSsh,
  say: (line: string) => void = console.log,
): ConnectResult {
  // The laptop topology has no ssh anywhere. Guarded here (not only
  // at the call sites) so the board's `s` reconnect hook and any future caller
  // inherit the guarantee: in local mode this function spawns nothing.
  if (transportOf(cfg) === "local") return { kind: "local" };
  // No host, nothing to connect to: `ssh "" true` only ever fails on name
  // resolution, and the passphrase prompt it promises would never come.
  if (cfg.ssh_host.trim() === "") {
    say(NO_SSH_HOST_STDERR);
    return { kind: "failed", detail: NO_SSH_HOST_STDERR };
  }
  if (ssh(masterCheckArgv(cfg), false).status === 0) return { kind: "alive" };
  say(
    `connecting to ${cfg.ssh_host} — enter the GCP key passphrase if asked (once; the connection is shared for 4h)`,
  );
  const r = ssh(masterConnectArgv(cfg), true);
  if (r.status === 0) {
    say(`connected — ssh master to ${cfg.ssh_host} established`);
    return { kind: "connected" };
  }
  const detail = r.stderr.trim() || `ssh exit ${String(r.status)}`;
  say(
    `ssh to ${cfg.ssh_host} failed: ${detail} — the board will show unreachable (press s to retry)`,
  );
  return { kind: "failed", detail };
}

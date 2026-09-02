// Unwedge (#5362) — the operator's one-key recovery for a PR whose round is
// stuck, driven from the board instead of from the overseer's pane.
//
// WHY THIS IS A WRITE CHANNEL AT ALL. The board is otherwise read-only over
// ssh, and that property is worth keeping; this is a deliberate, narrow
// exception ratified by the owner on 2026-08-21 after #5362 sat wedged for its
// full 75-minute deadline with no way to clear it. The lever that was supposed
// to exist — `rerun-round` — did not work (it never cancelled the round row,
// so the pump skipped the PR), and the only way to reach it was to type into
// the overseer's pi and hope. An unwedge lever that depends on an LLM turn
// fails exactly when things are already stuck.
//
// WHAT IT IS NOT. It writes ONE validated command file into the daemon's
// existing `commands/` dir and then reads the result the daemon writes back.
// It does not touch GitHub, does not go near the MutationGate, and cannot
// invent a command: the payload is built here from a fixed shape, and
// `src/commands.ts` re-validates it against the same strict schema and the
// same tier gate every other writer faces. In particular it inherits the
// `local`-dir BELT — a command dropped while a non-owner Slack turn is live
// is refused — so the TUI cannot be used to slip past the tier table.
//
// Two commands, both already in the whitelist:
//   `rerun-round`     — cancel the running round and re-queue (the default).
//   `restart-session` — the same, plus kill the tmux session first, for a
//                       session that is genuinely wedged rather than idle.
import type { TuiConfig } from "../config.js";
import type { App } from "./app.js";
import type { SshRunner } from "./remote.js";

/** The commands this channel may produce. Deliberately a closed set: the
 * daemon's whitelist is the authority, and this is the narrower subset that
 * makes sense as a keystroke on a stuck PR. */
export type UnwedgeCommand = "rerun-round" | "restart-session";

/** The daemon's command root: results land in `<root>/results/`. */
export function commandDirFor(cfg: TuiConfig): string {
  return `${cfg.remote_sandbox_root}/commands`;
}

/**
 * The OPERATOR's command directory. Everything this module and
 * `qcr drain` write goes here, and it is what makes an operator-issued lever
 * structurally different from a session-issued one: the directory is created
 * and written as ROOT (`docker exec -u 0`), mode 0755, and the daemon — which
 * runs as the same uid every pi session runs as — can read it but not write
 * into it. A session therefore cannot put a file here, and the daemon treats
 * a file here as the operator's only when that seal holds (`operatorSealVerdict`
 * in `src/commands.ts`). The overseer's own commands keep landing in the
 * daemon-owned `commands/` beside it, where every drain and pause is bounded.
 */
export function operatorCommandDirFor(cfg: TuiConfig): string {
  return `${commandDirFor(cfg)}/operator`;
}

export function commandFileName(now: Date, seq: number): string {
  const ts = now.toISOString().replace(/[:.]/g, "-");
  return `${ts}-tui-${String(seq).padStart(4, "0")}.json`;
}

/**
 * The in-container shell that writes one operator command file as root.
 * Refuses when the daemon's `commands/` root does not exist yet (creating it
 * as root would leave the daemon unable to write its own results, and a
 * daemon that has never booted cannot answer anyway) and when the operator
 * directory is a SYMLINK: `commands/` itself is the daemon's, so a session
 * could plant `operator` there ahead of the operator, and a root `chown` that
 * followed the link would hand root a directory the daemon needs. The check
 * runs AFTER `mkdir -p` (which passes silently over a link to a directory),
 * so nothing sits between it and the chown, and the chown itself is `-h` —
 * it never dereferences, so a link swapped in after the check is still not
 * followed. A real directory a session pre-made is simply taken over —
 * `chown 0:0` + `0755` is what makes it the operator's, whoever created it —
 * and the file's own mode is set explicitly rather than left to the exec's
 * umask, because the daemon's seal check (`operatorSealVerdict`) reads both;
 * that check also `lstat`s the directory, so a link the script did not catch
 * is still no seal on the daemon's side.
 */
export function operatorCommandWriteScript(cfg: TuiConfig, name: string): string {
  const root = commandDirFor(cfg);
  const dir = operatorCommandDirFor(cfg);
  const tmp = `${dir}/.${name}.tmp`;
  return (
    `[ -d '${root}' ] || { echo 'daemon commands dir ${root} missing - is the daemon running?' >&2; exit 1; }; ` +
    `mkdir -p '${dir}' || exit 1; ` +
    `[ ! -L '${dir}' ] || { echo '${dir} is a symlink - refusing to write the operator command' >&2; exit 1; }; ` +
    `chown -h 0:0 '${dir}' && chmod 0755 '${dir}' || exit 1; ` +
    `find '${dir}' -maxdepth 1 -name '*.json' -mmin +1440 -delete 2>/dev/null; ` +
    `cat > '${tmp}' && chmod 0644 '${tmp}' && mv '${tmp}' '${dir}/${name}'`
  );
}

/** argv for the atomic command write. The payload rides STDIN, never the
 * command line: nothing about the request can be shell-interpreted, and the
 * tmp+mv means the watcher never sees a half-written file (its own writes use
 * the same idiom). `-u 0` is the operator seal — see `operatorCommandDirFor`. */
export function commandWriteArgv(cfg: TuiConfig, name: string): string[] {
  return [
    ...(cfg.sudo_docker ? ["sudo"] : []),
    "docker",
    "exec",
    "-i",
    "-u",
    "0",
    cfg.container,
    "sh",
    "-c",
    operatorCommandWriteScript(cfg, name),
  ];
}

/** argv reading the daemon's result file for a command, or `pending`. */
export function commandResultArgv(cfg: TuiConfig, name: string): string[] {
  const dir = commandDirFor(cfg);
  const base = name.replace(/\.json$/, "");
  return [
    ...(cfg.sudo_docker ? ["sudo"] : []),
    "docker",
    "exec",
    cfg.container,
    "sh",
    "-c",
    `if [ -f '${dir}/results/${base}.result.json' ]; then cat '${dir}/results/${base}.result.json'; else echo pending; fi`,
  ];
}

/** The command payload. Built here rather than accepted from a caller, so a
 * malformed or unexpected command cannot be produced by this module at all. */
export function commandPayload(command: UnwedgeCommand, pr: number): string {
  return `${JSON.stringify({ command, pr }, null, 2)}\n`;
}

export type UnwedgeState = "pending" | "done" | "failed";

export interface UnwedgeSender {
  send(command: UnwedgeCommand, pr: number, onState: (state: UnwedgeState, label: string) => void): Promise<void>;
}

export class CommandFileSender implements UnwedgeSender {
  private seq = 0;

  constructor(
    private readonly cfg: TuiConfig,
    private readonly ssh: SshRunner,
    private readonly now: () => Date = () => new Date(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  async send(
    command: UnwedgeCommand,
    pr: number,
    onState: (state: UnwedgeState, label: string) => void,
  ): Promise<void> {
    if (!Number.isInteger(pr) || pr <= 0) {
      onState("failed", `✖ ${command} refused (bad PR number)`);
      return;
    }
    const name = commandFileName(this.now(), this.seq++);
    onState("pending", `→ ${command} #${pr} pending…`);
    const write = await this.ssh(this.cfg.ssh_host, commandWriteArgv(this.cfg, name), {
      stdin: commandPayload(command, pr),
    });
    if (!write.ok) {
      onState("failed", `✖ ${command} #${pr} failed (write failed)`);
      return;
    }
    // Read the daemon's own verdict on the request rather than assuming the
    // write was the outcome. A refusal (tier belt, unknown PR) is a real
    // answer and the operator must see it, not a silent success.
    const deadline = this.now().getTime() + this.cfg.msg_timeout_s * 1000;
    while (this.now().getTime() < deadline) {
      await this.sleep(2000);
      const probe = await this.ssh(this.cfg.ssh_host, commandResultArgv(this.cfg, name));
      if (!probe.ok) continue;
      const body = probe.stdout.trim();
      if (body === "pending" || body === "") continue;
      let result: { ok?: unknown; reason?: unknown; cancelled_rounds?: unknown };
      try {
        result = JSON.parse(body) as typeof result;
      } catch {
        onState("failed", `✖ ${command} #${pr} failed (unreadable result)`);
        return;
      }
      if (result.ok === true) {
        const cancelled = Array.isArray(result.cancelled_rounds) ? result.cancelled_rounds.length : 0;
        onState("done", `✓ ${command} #${pr}${cancelled > 0 ? ` — ${cancelled} round(s) cancelled` : ""}`);
        return;
      }
      onState("failed", `✖ ${command} #${pr} refused (${String(result.reason ?? "no reason given")})`);
      return;
    }
    onState("failed", `✖ ${command} #${pr} — no result (daemon down?)`);
  }
}

/** Bind the board's `u` key to the command channel. Same shape as
 * `installMessageHooks`: the sender is injectable so tests never spawn ssh. */
export function installUnwedgeHooks(app: App, sender?: UnwedgeSender): void {
  const s = sender ?? new CommandFileSender(app.cfg, app.ssh);
  app.hooks.unwedge = (pr, theApp) => {
    void s.send("rerun-round", pr, (_state, label) => theApp.notice(label));
  };
}

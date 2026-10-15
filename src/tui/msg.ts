// Quick-message — deliver a typed message to a session via the
// daemon's inject bridge: write `inject/<session>/<name>.md` inside the
// container (atomic tmp+mv, matching the daemon's own writes), then poll for
// the bridge's `.done/<name>` archive as the delivery confirmation. Never
// tmux send-keys, never GitHub, content verbatim — and never silent:
// pending → ✓ delivered / ✖ undelivered in the events strip.
import type { TuiConfig } from "../config.js";
import type { App } from "./app.js";
import type { SshRunner } from "./remote.js";

/** The only session names the TUI will ever build a remote path from. */
export function isValidSessionName(name: string): boolean {
  return name === "overseer" || name === "main" || /^pr-\d+$/.test(name);
}

export function injectDirFor(cfg: TuiConfig, session: string): string {
  return `${cfg.remote_sandbox_root}/inject/${session}`;
}

export function injectFileName(now: Date, seq: number): string {
  const ts = now.toISOString().replace(/[:.]/g, "-");
  return `${ts}-tui-${String(seq).padStart(4, "0")}.md`;
}

/** argv for the atomic inject write; the message rides stdin verbatim —
 * nothing from the text ever lands in the shell command line. */
export function injectWriteArgv(cfg: TuiConfig, session: string, name: string): string[] {
  const dir = injectDirFor(cfg, session);
  return [
    ...(cfg.sudo_docker ? ["sudo"] : []),
    "docker",
    "exec",
    "-i",
    cfg.container,
    "sh",
    "-c",
    `mkdir -p '${dir}' && cat > '${dir}/.${name}.tmp' && mv '${dir}/.${name}.tmp' '${dir}/${name}'`,
  ];
}

/** argv probing whether the inject bridge consumed the file. */
export function injectProbeArgv(cfg: TuiConfig, session: string, name: string): string[] {
  const dir = injectDirFor(cfg, session);
  return [
    ...(cfg.sudo_docker ? ["sudo"] : []),
    "docker",
    "exec",
    cfg.container,
    "sh",
    "-c",
    `if [ -f '${dir}/.done/${name}' ]; then echo consumed; elif [ -f '${dir}/${name}' ]; then echo pending; else echo missing; fi`,
  ];
}

export type DeliveryState = "pending" | "delivered" | "undelivered";

export interface MessageSender {
  send(
    session: string,
    text: string,
    onState: (state: DeliveryState, label: string) => void,
  ): Promise<void>;
}

export class InjectSender implements MessageSender {
  private seq = 0;

  constructor(
    private readonly cfg: TuiConfig,
    private readonly ssh: SshRunner,
    private readonly now: () => Date = () => new Date(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {}

  async send(
    session: string,
    text: string,
    onState: (state: DeliveryState, label: string) => void,
  ): Promise<void> {
    if (!isValidSessionName(session)) {
      onState("undelivered", `✖ msg ${session} undelivered (bad session name)`);
      return;
    }
    const name = injectFileName(this.now(), this.seq++);
    onState("pending", `→ msg ${session} pending…`);
    const write = await this.ssh(this.cfg.ssh_host, injectWriteArgv(this.cfg, session, name), {
      stdin: text,
    });
    if (!write.ok) {
      onState("undelivered", `✖ msg ${session} undelivered (write failed)`);
      return;
    }
    const deadline = this.now().getTime() + this.cfg.msg_timeout_s * 1000;
    while (this.now().getTime() < deadline) {
      await this.sleep(2000);
      const probe = await this.ssh(this.cfg.ssh_host, injectProbeArgv(this.cfg, session, name));
      if (probe.ok && probe.stdout.trim() === "consumed") {
        onState("delivered", `✓ msg ${session} delivered`);
        return;
      }
      if (probe.ok && probe.stdout.trim() === "missing") {
        // Neither pending nor archived: a vanished file is never read as
        // delivered; keep waiting for .done until the timeout.
      }
    }
    onState("undelivered", `✖ msg ${session} undelivered (session down?)`);
  }
}

/** How a sent quick-message ended: the sender's last word on it. */
export interface MessageOutcome {
  delivered: boolean;
  label: string;
}

export function installMessageHooks(app: App, sender?: MessageSender): void {
  const s = sender ?? new InjectSender(app.cfg, app.ssh);
  app.hooks.message = (session, theApp) => theApp.openMessageBox(session);
  app.hooks.sendMessage = async (session, text, theApp) => {
    let last: MessageOutcome = { delivered: false, label: `✖ msg ${session} undelivered` };
    try {
      await s.send(session, text, (state, label) => {
        theApp.notice(label);
        if (state !== "pending") last = { delivered: state === "delivered", label };
      });
    } catch (err) {
      last = {
        delivered: false,
        label: `✖ msg ${session} undelivered (${err instanceof Error ? err.message : String(err)})`,
      };
      theApp.notice(last.label);
    }
    return last;
  };
}

/**
 * A quick-message sent on the companion's behalf (the action channel's
 * `msg_session` / `overseer_inject`): resolves with the delivered label once
 * the inject bridge consumed it, REJECTS with the undelivered one — so the
 * action's result file says what became of the message, never just that it
 * was handed to the sender.
 */
export async function deliverMessage(app: App, session: string, text: string): Promise<string> {
  const send = app.hooks.sendMessage;
  if (!send) throw new Error(`✖ msg ${session} undelivered (sender not wired)`);
  const outcome = await send(session, text, app);
  if (!outcome) throw new Error(`msg ${session} sent, delivery unconfirmed`);
  if (!outcome.delivered) throw new Error(outcome.label);
  return outcome.label;
}

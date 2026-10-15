// Quick-message — deliver a typed message to a session via the
// daemon's inject bridge: write `inject/<session>/<name>.md` inside the
// container (atomic tmp+mv, matching the daemon's own writes), then poll for
// the bridge's `.done/<name>` archive as the delivery confirmation. Never
// tmux send-keys, never GitHub, content verbatim — and never silent:
// pending → ✓ delivered / ⧗ queued / ? unconfirmed / ✖ undelivered in the
// events strip. The bridge consumes nothing while its session is busy, so a
// file still pending at the timeout is QUEUED (it will be delivered when the
// session is idle), never read as lost.
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

/**
 * `undelivered` is a definite non-delivery (bad session name, the write
 * failed). `queued`: the file was still pending at the timeout. `unconfirmed`:
 * at the timeout no probe saw the file pending or consumed.
 */
export type DeliveryState = "pending" | "delivered" | "queued" | "unconfirmed" | "undelivered";

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
    let lastSeen: string | undefined;
    while (this.now().getTime() < deadline) {
      await this.sleep(2000);
      const probe = await this.ssh(this.cfg.ssh_host, injectProbeArgv(this.cfg, session, name));
      // A failed probe or a vanished file ("missing") is never read as
      // delivered; keep waiting for .done until the timeout.
      lastSeen = probe.ok ? probe.stdout.trim() : undefined;
      if (lastSeen === "consumed") {
        onState("delivered", `✓ msg ${session} delivered`);
        return;
      }
    }
    if (lastSeen === "pending") {
      onState(
        "queued",
        `⧗ msg ${session} queued — will deliver when the session is idle; do not re-send`,
      );
      return;
    }
    onState(
      "unconfirmed",
      `? msg ${session} unconfirmed — not seen pending or consumed; check the session before re-sending`,
    );
  }
}

/** How a sent quick-message ended: the sender's last word on it. */
export interface MessageOutcome {
  state: Exclude<DeliveryState, "pending">;
  label: string;
}

export function installMessageHooks(app: App, sender?: MessageSender): void {
  const s = sender ?? new InjectSender(app.cfg, app.ssh);
  app.hooks.message = (session, theApp) => theApp.openMessageBox(session);
  app.hooks.sendMessage = async (session, text, theApp) => {
    let last: MessageOutcome = {
      state: "unconfirmed",
      label: `? msg ${session} unconfirmed (the sender gave no outcome)`,
    };
    try {
      await s.send(session, text, (state, label) => {
        theApp.notice(label);
        if (state !== "pending") last = { state, label };
      });
    } catch (err) {
      last = {
        state: "undelivered",
        label: `✖ msg ${session} undelivered (${err instanceof Error ? err.message : String(err)})`,
      };
      theApp.notice(last.label);
    }
    return last;
  };
}

/**
 * A quick-message sent on the companion's behalf (the action channel's
 * `msg_session` / `overseer_inject`): REJECTS only on a definite
 * non-delivery (a bad session name, a failed write, no sender wired, a
 * sender that threw) and otherwise resolves with the sender's label —
 * delivered, queued behind a busy session, or unconfirmed — so the action's
 * result file says what became of the message, and a message still queued
 * is never reported as a failure to be re-sent.
 */
export async function deliverMessage(app: App, session: string, text: string): Promise<string> {
  const send = app.hooks.sendMessage;
  if (!send) throw new Error(`✖ msg ${session} undelivered (sender not wired)`);
  const outcome = await send(session, text, app);
  if (!outcome) return `? msg ${session} sent, delivery unconfirmed`;
  if (outcome.state === "undelivered") throw new Error(outcome.label);
  return outcome.label;
}

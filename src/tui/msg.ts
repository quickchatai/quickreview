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
import { LiveControlSender, type ControlOutcome, type ControlSender } from "./livecontrol.js";
import { shellQuote, type SshRunner } from "./remote.js";
import { resultReason } from "./unwedge.js";
import { remoteSandboxRoot, resolveLayout } from "./layout.js";

/** The only session names the TUI will ever build a remote path from. */
export function isValidSessionName(name: string): boolean {
  return name === "overseer" || name === "main" || /^pr-\d+$/.test(name);
}

export function injectDirFor(cfg: TuiConfig, session: string): string {
  return `${remoteSandboxRoot(cfg)}/inject/${session}`;
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
    `mkdir -p ${shellQuote(dir)} && cat > ${shellQuote(`${dir}/.${name}.tmp`)} && mv ${shellQuote(`${dir}/.${name}.tmp`)} ${shellQuote(`${dir}/${name}`)}`,
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
    `if [ -f ${shellQuote(`${dir}/.done/${name}`)} ]; then echo consumed; elif [ -f ${shellQuote(`${dir}/${name}`)} ]; then echo pending; else echo missing; fi`,
  ];
}

/**
 * `undelivered` is a definite non-delivery (bad session name, the write
 * failed before publication). A lost transport acknowledgement is probed,
 * never taken as proof of non-delivery. `queued`: the file was still pending at the timeout. `unconfirmed`:
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
    await resolveLayout(this.cfg, this.ssh);
    if (!isValidSessionName(session)) {
      onState("undelivered", `✖ msg ${session} undelivered (bad session name)`);
      return;
    }
    const name = injectFileName(this.now(), this.seq++);
    onState("pending", `→ msg ${session} pending…`);
    const write = await this.ssh(this.cfg.ssh_host, injectWriteArgv(this.cfg, session, name), {
      stdin: text,
    });
    if (!write.ok && write.code !== null && write.code !== 255) {
      const why = resultReason(write.stderr, `exit ${write.code}`).slice(0, 160);
      onState("undelivered", `✖ msg ${session} undelivered (write failed: ${why})`);
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

/**
 * Where a message to a PR goes, by the PR's `runtime` in status.json. The route
 * is the PR's, never the operator's choice:
 *
 *   worker, answer, idle   the operator control route (`message`), which the
 *                          daemon hands to the PR's host;
 *   debug, takeover        none: the PR's pane is a pi terminal, so the message
 *                          is typed into pi, and the operator is told to focus it;
 *   absent, tmux (or any   today's tmux inject path, until the cutover deletes
 *   runtime not known)     it (P9.6), so the owner's hot-reloading TUI keeps
 *                          messaging the legacy VM.
 */
export type MessageRoute = "control" | "terminal" | "tmux";

export function messageRoute(runtime: string | undefined): MessageRoute {
  switch (runtime) {
    case "worker":
    case "answer":
    case "idle":
      return "control";
    case "debug":
    case "takeover":
      return "terminal";
    default:
      return "tmux";
  }
}

/** A control outcome as the quick-message strip words it. */
function deliveryOf(outcome: ControlOutcome): MessageOutcome {
  const label = outcome.label;
  switch (outcome.state) {
    case "handled":
      return { state: "delivered", label };
    case "queued":
      return { state: "queued", label };
    case "refused":
    case "failed":
      return { state: "undelivered", label };
    default:
      return { state: "unconfirmed", label };
  }
}

export function installMessageHooks(
  app: App,
  sender?: MessageSender,
  control?: ControlSender,
): void {
  const s = sender ?? new InjectSender(app.cfg, app.ssh);
  const c = control ?? new LiveControlSender(app.cfg, app.ssh);
  app.hooks.message = (session, theApp) => theApp.openMessageBox(session);
  app.hooks.sendMessage = async (session, text, theApp) => {
    let last: MessageOutcome = {
      state: "unconfirmed",
      label: `? msg ${session} unconfirmed (the sender gave no outcome)`,
    };
    const pr = /^pr-(\d+)$/.exec(session)?.[1];
    const route = pr === undefined ? "tmux" : messageRoute(theApp.runtimeOf(Number(pr)));
    if (route === "terminal") {
      last = {
        state: "undelivered",
        label: `✖ msg ${session} not sent: #${pr} runs inside pi (${theApp.runtimeOf(Number(pr))}) — focus its pane (⏎) and type in pi`,
      };
      theApp.notice(last.label);
      return last;
    }
    try {
      if (route === "control") {
        const outcome = await c.send({ kind: "message", pr: Number(pr), text }, (state, label) => {
          if (state === "pending") theApp.notice(label);
        });
        last = deliveryOf(outcome);
        theApp.notice(last.label);
        return last;
      }
      await s.send(session, text, (state, label) => {
        theApp.notice(label);
        if (state !== "pending") last = { state, label };
      });
    } catch (err) {
      // A transport can throw after the write, or even after its receipt.
      // Keep a known terminal outcome; otherwise delivery is unknown and a
      // failed action result must not invite a duplicate resend.
      if (last.state === "unconfirmed")
        last = {
          state: "unconfirmed",
          label: `? msg ${session} unconfirmed (${err instanceof Error ? err.message : String(err)}) — check the session; do not re-send`,
        };
      theApp.notice(last.label);
    }
    return last;
  };
}

/**
 * A quick-message sent on the companion's behalf (the action channel's
 * `msg_session`): REJECTS only on a definite
 * non-delivery (a bad session name, a refused write, no sender wired)
 * and otherwise resolves with the sender's label —
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

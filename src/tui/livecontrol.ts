// The operator control route: the viewer's input line, the quick-message box
// and (through the same sender) the companion's actions reach a PR's running or
// idle session by writing ONE operator command file and reading back the
// daemon's verdict, exactly as `unwedge.ts` does for `u`.
//
// The write is `operatorCommandWriteScript` — root, into the sealed
// `commands/operator/` directory — so the daemon serves the file as the
// operator's and a session cannot put a file there. The kinds are the
// `CONTROL_COMMANDS` of `src/commands.ts`, which validates the file against the
// same strict schema and refuses a session's or an unsealed file. Nothing here
// touches GitHub or the gate; a `message` carries `may_post` only when the
// operator marked it, and what that allows is the daemon's and the gate's.
//
// The verdict is an ack, not a delivery receipt: the daemon forwards the
// command to the PR's host over IPC and writes `ok` with `ack: "queued"` (the
// host has it, it acts when its turn allows) or `ack: "handled"` (it acted), or
// `ok: false` with a reason. No result by the deadline is `unacked`, and the
// operator is told so rather than shown a success.
import { randomUUID } from "node:crypto";
import type { ControlCommandName } from "../commands.js";
import type { TuiConfig } from "../config.js";
import type { App } from "./app.js";
import type { SshRunner } from "./remote.js";
import { commandFileName, commandResultArgv, commandWriteArgv, resultReason } from "./unwedge.js";

/** What a control asks for. `text` is the steer, follow-up or message body;
 * `may_post` rides a `message` only. */
export interface ControlRequest {
  kind: ControlCommandName;
  pr: number;
  text?: string;
  may_post?: boolean;
}

/** argv writing one control file as root: the operator write, spelled once
 * more under the name this route's tests and callers use. The payload rides
 * stdin; `name` is a `commandFileName`. */
export function liveControlArgv(cfg: TuiConfig, name: string): string[] {
  return commandWriteArgv(cfg, name);
}

const TEXT_KINDS: readonly ControlCommandName[] = ["steer", "follow-up", "message"];

/** The command payload, built from the request's fixed shape — never from a
 * caller's JSON — so a malformed control cannot be produced here. */
export function controlPayload(req: ControlRequest): string {
  const body: Record<string, unknown> = { command: req.kind, pr: req.pr };
  if (TEXT_KINDS.includes(req.kind)) body["text"] = req.text ?? "";
  if (req.kind === "message" && req.may_post === true) body["may_post"] = true;
  return `${JSON.stringify(body, null, 2)}\n`;
}

/** How a control ended, for the viewer's notice line. `queued`: the host has
 * it. `handled`: the host acted. `refused`: the daemon said no. `failed`: it
 * never got there. `unacked`: no answer in time. */
export type ControlState = "pending" | "queued" | "handled" | "refused" | "failed" | "unacked";

export interface ControlOutcome {
  state: Exclude<ControlState, "pending">;
  label: string;
}

export interface ControlSender {
  send(
    req: ControlRequest,
    onState: (state: ControlState, label: string) => void,
  ): Promise<ControlOutcome>;
}

/** How often the result file is read: a steer is typed live, so this is far
 * quicker than the unwedge channel's 2 s. */
const POLL_MS = 500;

export class LiveControlSender implements ControlSender {
  private seq = 0;
  private readonly clientId = `control-${randomUUID().slice(0, 8)}`;

  constructor(
    private readonly cfg: TuiConfig,
    private readonly ssh: SshRunner,
    private readonly now: () => Date = () => new Date(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {}

  async send(
    req: ControlRequest,
    onState: (state: ControlState, label: string) => void,
  ): Promise<ControlOutcome> {
    const what = `${req.kind} #${req.pr}`;
    const say = (state: ControlOutcome["state"], label: string): ControlOutcome => {
      onState(state, label);
      return { state, label };
    };
    if (!Number.isInteger(req.pr) || req.pr <= 0)
      return say("failed", `✖ ${what} refused (bad PR number)`);
    if (TEXT_KINDS.includes(req.kind) && (req.text ?? "").trim() === "")
      return say("failed", `✖ ${what} refused (nothing to send)`);
    const name = commandFileName(this.now(), this.seq++, this.clientId);
    onState("pending", `→ ${what} pending…`);
    const write = await this.ssh(this.cfg.ssh_host, liveControlArgv(this.cfg, name), {
      stdin: controlPayload(req),
    });
    if (!write.ok) {
      const why = write.stderr.trim().split("\n").at(-1) ?? "";
      return say(
        "failed",
        `✖ ${what} failed (write failed: ${resultReason(why, `exit ${write.code ?? "?"}`)})`,
      );
    }
    const deadline = this.now().getTime() + this.cfg.msg_timeout_s * 1000;
    let unreadable = false;
    while (this.now().getTime() < deadline) {
      await this.sleep(POLL_MS);
      const probe = await this.ssh(this.cfg.ssh_host, commandResultArgv(this.cfg, name));
      if (!probe.ok) continue;
      const body = probe.stdout.trim();
      if (body === "pending" || body === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        unreadable = true; // the daemon writes in place: a read can land mid-write
        continue;
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        unreadable = true;
        continue;
      }
      unreadable = false;
      const result = parsed as { ok?: unknown; reason?: unknown; ack?: unknown };
      if (result.ok === true)
        return result.ack === "queued"
          ? say("queued", `⧗ ${what} queued — the session has it`)
          : say("handled", `✓ ${what} delivered`);
      return say(
        "refused",
        `✖ ${what} refused (${resultReason(result.reason, "no reason given")})`,
      );
    }
    return say(
      "unacked",
      unreadable
        ? `? ${what} unconfirmed (unreadable result) — check the session before re-sending`
        : `? ${what} unconfirmed — no answer from the daemon; check the session before re-sending`,
    );
  }
}

/** Bind the viewer's input line to the control route. Same shape as
 * `installUnwedgeHooks`: the sender is injectable so tests never spawn ssh. */
export function installLiveControlHooks(app: App, sender?: ControlSender): void {
  const s = sender ?? new LiveControlSender(app.cfg, app.ssh);
  app.hooks.liveControl = async (req, theApp) => {
    let last: ControlOutcome = {
      state: "unacked",
      label: `? ${req.kind} #${req.pr} unconfirmed (the sender gave no outcome)`,
    };
    try {
      last = await s.send(req, (_state, label) => theApp.notice(label));
    } catch (err) {
      last = {
        state: "unacked",
        label: `? ${req.kind} #${req.pr} unconfirmed (${err instanceof Error ? err.message : String(err)}) — check the session; do not re-send`,
      };
      theApp.notice(last.label);
    }
    return last;
  };
}

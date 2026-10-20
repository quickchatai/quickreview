// The operator's lesson kill switch client — `qcr lessons
// off|on|suppress|unsuppress`.
//
// The same narrow channel as the board's `u` and the deploy drain
// (src/tui/unwedge.ts, src/tui/deploy-drain.ts): one command file written as
// root into the root-sealed `commands/operator/` (`docker exec -u 0`, payload
// on stdin, tmp+mv), then the daemon's own result file read back as the
// receipt. The four commands validate only from that sealed directory
// (src/commands.ts `OPERATOR_COMMANDS`): a file the daemon finds unsealed is
// served as a session's and refused, and the result says so — this client
// never infers acceptance from a successful write.
import { randomUUID } from "node:crypto";
import { validateCommand, type Command } from "../commands.js";
import type { TuiConfig } from "../config.js";
import type { SshRunner } from "./remote.js";
import { commandResultArgv, commandWriteArgv, resultReason } from "./unwedge.js";
import { resolveLayout } from "./layout.js";

/** The kill switch's four payloads, read from the daemon's own `Command`. */
export type LessonSwitchCommand = Extract<
  Command,
  { command: "lessons-off" | "lessons-on" | "suppress-lesson" | "unsuppress-lesson" }
>;

export interface LessonSwitchOutcome {
  ok: boolean;
  reason?: string;
  changed?: boolean;
  lessons_off?: boolean;
  suppressed?: number;
  /** Who the daemon decided the writer was. `session` means the operator
   * directory was not sealed and the command was refused. */
  issuer?: "operator" | "session";
}

/** The exact daemon-validated payload; throws on a command the daemon's own
 * validator would refuse from the operator channel. */
export function lessonSwitchPayload(cmd: LessonSwitchCommand): string {
  const v = validateCommand(cmd, { issuer: "operator" });
  if (!v.ok) throw new Error(v.reason);
  return `${JSON.stringify(cmd, null, 2)}\n`;
}

export function lessonSwitchFileName(now: Date, clientId: string, seq: number): string {
  const ts = now.toISOString().replace(/[:.]/g, "-");
  return `${ts}-cli-lessons-${clientId}-${String(seq).padStart(4, "0")}.json`;
}

/** `experiences/x.md` → the reviewer's full URI; a full URI as given. */
export function lessonUriOf(idOrUri: string, user: string): string {
  const t = idOrUri.trim();
  if (t.startsWith("viking://")) return t;
  return `viking://user/${user}/memories/${t.replace(/^\/+/, "")}`;
}

export class LessonSwitchSender {
  private seq = 0;
  private readonly clientId = randomUUID().slice(0, 12);

  constructor(
    private readonly cfg: TuiConfig,
    private readonly ssh: SshRunner,
    private readonly now: () => Date = () => new Date(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  async send(cmd: LessonSwitchCommand): Promise<LessonSwitchOutcome> {
    await resolveLayout(this.cfg, this.ssh);
    let payload: string;
    try {
      payload = lessonSwitchPayload(cmd);
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
    const name = lessonSwitchFileName(this.now(), this.clientId, this.seq++);
    const write = await this.ssh(this.cfg.ssh_host, commandWriteArgv(this.cfg, name), {
      stdin: payload,
    });
    if (!write.ok)
      return {
        ok: false,
        reason: `command write failed (${write.stderr.trim() || `exit ${write.code}`})`,
      };
    const deadline = this.now().getTime() + this.cfg.msg_timeout_s * 1000;
    while (this.now().getTime() < deadline) {
      await this.sleep(2000);
      const probe = await this.ssh(this.cfg.ssh_host, commandResultArgv(this.cfg, name));
      if (!probe.ok) continue;
      const body = probe.stdout.trim();
      if (body === "" || body === "pending") continue;
      let v: Record<string, unknown>;
      try {
        v = JSON.parse(body) as Record<string, unknown>;
      } catch {
        // A concurrent reader can see the daemon still writing its receipt.
        continue;
      }
      const issuer =
        v["issuer"] === "operator" || v["issuer"] === "session" ? v["issuer"] : undefined;
      if (v["ok"] !== true)
        return {
          ok: false,
          reason: resultReason(v["reason"], "no reason given"),
          ...(issuer ? { issuer } : {}),
        };
      return {
        ok: true,
        ...(typeof v["changed"] === "boolean" ? { changed: v["changed"] } : {}),
        ...(typeof v["lessons_off"] === "boolean" ? { lessons_off: v["lessons_off"] } : {}),
        ...(typeof v["suppressed"] === "number" ? { suppressed: v["suppressed"] } : {}),
        ...(issuer ? { issuer } : {}),
      };
    }
    return { ok: false, reason: "no result before timeout (daemon down?)" };
  }
}

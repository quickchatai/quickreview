// The operator's per-PR dispatch lever client — `qcr pause-pr` / `qcr resume-pr`.
//
// The same narrow channel as the deploy drain and the lesson kill switch
// (src/tui/deploy-drain.ts, src/tui/lessonswitch.ts): one command file written
// as root into the root-sealed `commands/operator/` (`docker exec -u 0`,
// payload on stdin, tmp+mv), then the daemon's own result file read back as the
// receipt. From that sealed directory a pause is the OPERATOR's: it carries no
// expiry and stands until resumed (src/levers.ts), and no session can lift it.
// A file the daemon finds unsealed is served as a session's, which bounds the
// pause; the result's `issuer` says so and this client reports it — it never
// infers acceptance from a successful write.
//
// The cutover wizard (scripts/cutover.sh stage 9) is the first caller: it
// pauses every tracked PR but one before it lifts the drain, so the board's
// first worker round is one PR's, and resumes exactly those PRs afterwards.
import { randomUUID } from "node:crypto";
import { validateCommand, type Command } from "../commands.js";
import type { TuiConfig } from "../config.js";
import type { SshRunner } from "./remote.js";
import { commandResultArgv, commandWriteArgv, resultReason } from "./unwedge.js";
import { resolveLayout } from "./layout.js";

/** The two payloads, read from the daemon's own `Command`. */
export type PrLeverCommand = Extract<Command, { command: "pause-pr" | "resume-pr" }>;

export interface PrLeverOutcome {
  ok: boolean;
  reason?: string;
  /** Who the daemon decided the writer was. `session` means the operator
   * directory was not sealed: a pause was bounded like a session's. */
  issuer?: "operator" | "session";
  /** The pause's ledger outcome (`unchanged` when it already stood). */
  outcome?: string;
  /** When a bounded pause lapses; absent for the operator's until-resumed one. */
  expires_at?: string;
}

/** The exact daemon-validated payload; throws on a command the daemon's own
 * validator would refuse from the operator channel. */
export function prLeverPayload(cmd: PrLeverCommand): string {
  const v = validateCommand(cmd, { issuer: "operator" });
  if (!v.ok) throw new Error(v.reason);
  return `${JSON.stringify(cmd, null, 2)}\n`;
}

export function prLeverFileName(now: Date, clientId: string, seq: number): string {
  const ts = now.toISOString().replace(/[:.]/g, "-");
  return `${ts}-cli-prlever-${clientId}-${String(seq).padStart(4, "0")}.json`;
}

export class PrLeverSender {
  private seq = 0;
  private readonly clientId = randomUUID().slice(0, 12);

  constructor(
    private readonly cfg: TuiConfig,
    private readonly ssh: SshRunner,
    private readonly now: () => Date = () => new Date(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  async send(cmd: PrLeverCommand): Promise<PrLeverOutcome> {
    await resolveLayout(this.cfg, this.ssh);
    let payload: string;
    try {
      payload = prLeverPayload(cmd);
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
    const name = prLeverFileName(this.now(), this.clientId, this.seq++);
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
      if (typeof v !== "object" || v === null || Array.isArray(v)) continue;
      const issuer =
        v["issuer"] === "operator" || v["issuer"] === "session" ? v["issuer"] : undefined;
      if (v["ok"] !== true)
        return {
          ok: false,
          reason: resultReason(v["reason"], "no reason given"),
          ...(issuer ? { issuer } : {}),
        };
      // Untrusted like the reason: the result sits in a session-writable dir.
      const outcome = typeof v["outcome"] === "string" ? resultReason(v["outcome"], "") : "";
      const expires = typeof v["expires_at"] === "string" ? resultReason(v["expires_at"], "") : "";
      return {
        ok: true,
        ...(issuer ? { issuer } : {}),
        ...(outcome ? { outcome } : {}),
        ...(expires ? { expires_at: expires } : {}),
      };
    }
    return { ok: false, reason: "no result before timeout (daemon down?)" };
  }
}

/** What the CLI prints for a lever's answer, and its exit code. A pause that
 * came back bounded (the directory unsealed) is a failure: the operator asked
 * for a pause that stands until resumed, and a lapsing one would let the PR's
 * rounds start on their own. */
export function renderPrLever(
  cmd: PrLeverCommand,
  out: PrLeverOutcome,
): { lines: string[]; code: number } {
  const pr = `#${cmd.pr}`;
  if (!out.ok) {
    const lines = [`✖ ${cmd.command} ${pr} refused: ${out.reason ?? "no reason given"}`];
    if (out.issuer === "session")
      lines.push(
        "  the daemon found commands/operator/ UNSEALED (writable by its own uid), so it served the file as a session's — check the directory is root-owned 0755 in the container",
      );
    return { lines, code: 1 };
  }
  if (cmd.command === "resume-pr") return { lines: [`✓ ${pr} resumed`], code: 0 };
  if (out.issuer !== "operator") {
    return {
      lines: [
        `✖ ${pr} paused, but NOT as the operator's: the daemon bounded it like a session's — lapses ${out.expires_at ?? "(unknown)"}`,
        "  check commands/operator/ is root-owned 0755 in the container (not a symlink), then pause again",
      ],
      code: 1,
    };
  }
  return {
    lines: [
      `✓ ${pr} ${out.outcome === "unchanged" ? "already paused" : "paused"} by the operator until resumed (qcr resume-pr ${cmd.pr})`,
    ],
    code: 0,
  };
}

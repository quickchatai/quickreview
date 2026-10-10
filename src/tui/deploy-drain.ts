// Deploy-tab drain command client. This is the same narrow, validated
// command-file channel as the board's `u` recovery action: one atomic write,
// then the daemon's result is the receipt. It does not infer acceptance from a
// successful ssh write and it cannot produce any command except drain on/off.
import { randomUUID } from "node:crypto";
import type { TuiConfig } from "../config.js";
import { commandResultArgv, commandWriteArgv, resultReason } from "./unwedge.js";
import type { SshRunner } from "./remote.js";

export interface DrainCommandOutcome {
  ok: boolean;
  reason?: string;
  draining?: boolean;
  running_rounds?: number;
  dropped_deliveries?: number;
  /** Who the daemon recorded as holding the drain. `session` from
   * an operator client means the operator channel was not sealed (the
   * directory was writable by the daemon's uid) and the drain was bounded
   * like a session's — the caller must say so, never read it as the deploy
   * drain it asked for. */
  issuer?: "operator" | "session";
  /** When a bounded drain lapses; absent for the operator's until-lifted hold. */
  expires_at?: string;
}

export interface DeployDrainSender {
  set(on: boolean): Promise<DrainCommandOutcome>;
}

/** Exact daemon-whitelisted shape. */
export function drainPayload(on: boolean): string {
  return `${JSON.stringify({ command: "drain", on }, null, 2)}\n`;
}

export function drainCommandFileName(now: Date, clientId: string, seq: number): string {
  const ts = now.toISOString().replace(/[:.]/g, "-");
  return `${ts}-tui-deploy-drain-${clientId}-${String(seq).padStart(4, "0")}.json`;
}

export class CommandDrainSender implements DeployDrainSender {
  private seq = 0;
  private readonly clientId = randomUUID().slice(0, 12);

  constructor(
    private readonly cfg: TuiConfig,
    private readonly ssh: SshRunner,
    private readonly now: () => Date = () => new Date(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  async set(on: boolean): Promise<DrainCommandOutcome> {
    const name = drainCommandFileName(this.now(), this.clientId, this.seq++);
    const write = await this.ssh(this.cfg.ssh_host, commandWriteArgv(this.cfg, name), {
      stdin: drainPayload(on),
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
      let value: {
        ok?: unknown;
        reason?: unknown;
        draining?: unknown;
        running_rounds?: unknown;
        dropped_deliveries?: unknown;
        issuer?: unknown;
        expires_at?: unknown;
      };
      try {
        value = JSON.parse(body) as typeof value;
      } catch {
        return { ok: false, reason: "unreadable daemon result" };
      }
      if (value.ok !== true)
        return { ok: false, reason: resultReason(value.reason, "no reason given") };
      if (value.draining !== on)
        return { ok: false, reason: `daemon result did not confirm drain ${on ? "on" : "off"}` };
      if (on) {
        if (
          typeof value.running_rounds !== "number" ||
          !Number.isInteger(value.running_rounds) ||
          value.running_rounds < 0
        ) {
          return { ok: false, reason: "daemon result omitted running_rounds" };
        }
        return {
          ok: true,
          draining: true,
          running_rounds: value.running_rounds,
          ...(value.issuer === "operator" || value.issuer === "session"
            ? { issuer: value.issuer }
            : {}),
          ...(typeof value.expires_at === "string" ? { expires_at: value.expires_at } : {}),
        };
      }
      const dropped =
        typeof value.dropped_deliveries === "number" && Number.isInteger(value.dropped_deliveries)
          ? value.dropped_deliveries
          : 0;
      return { ok: true, draining: false, dropped_deliveries: dropped };
    }
    return { ok: false, reason: "no result before timeout (daemon down?)" };
  }
}

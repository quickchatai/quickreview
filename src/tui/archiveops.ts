// The operator's archive verbs client — `qcr archive run` and
// `qcr archive restore <pr>`.
//
// The same channel as the lesson kill switch (src/tui/lessonswitch.ts): ONE
// command file written AS ROOT into the root-sealed `commands/operator/`
// (`docker exec -u 0`, payload on stdin, tmp+mv), then the daemon's own result
// file read back as the receipt. The two commands validate ONLY from that
// sealed directory (src/commands.ts `OPERATOR_COMMANDS`): a file the daemon
// finds unsealed is served as a session's and refused, and the result says
// so — this client never infers anything from a successful write.
//
// The daemon answers within OPERATOR_WAIT_MS (a tick or a restore still
// running then says `done: false` and goes on), so the client waits that
// long plus the usual message timeout.
import { randomUUID } from "node:crypto";
import { validateCommand } from "../commands.js";
import type { TuiConfig } from "../config.js";
import {
  OPERATOR_WAIT_MS,
  backlogPhrase,
  dbPhrase,
  filesPhrase,
  readArchiveRunFigures,
  storePhrase,
  type ArchiveStatus,
} from "../archive/status.js";
import type { SshRunner } from "./remote.js";
import { commandResultArgv, commandWriteArgv, resultReason } from "./unwedge.js";

export type ArchiveOpCommand =
  { command: "archive-run" } | { command: "archive-restore"; pr: number };

export interface ArchiveOpOutcome {
  ok: boolean;
  reason?: string;
  /** Who the daemon decided the writer was. `session` means the operator
   * directory was NOT sealed and the command was refused. */
  issuer?: "operator" | "session";
  /** The daemon's result file, as it wrote it (the verb's own fields). */
  result?: Record<string, unknown>;
}

/** The exact daemon-validated payload; throws on a command the daemon's own
 * validator would refuse from the operator channel. */
export function archiveOpPayload(cmd: ArchiveOpCommand): string {
  const v = validateCommand(cmd, { issuer: "operator" });
  if (!v.ok) throw new Error(v.reason);
  return `${JSON.stringify(cmd, null, 2)}\n`;
}

export function archiveOpFileName(now: Date, clientId: string, seq: number): string {
  const ts = now.toISOString().replace(/[:.]/g, "-");
  return `${ts}-cli-archive-${clientId}-${String(seq).padStart(4, "0")}.json`;
}

/** How long the client waits for the daemon's answer. */
export function archiveOpTimeoutMs(cfg: Pick<TuiConfig, "msg_timeout_s">): number {
  return OPERATOR_WAIT_MS + cfg.msg_timeout_s * 1000;
}

export class ArchiveOpSender {
  private seq = 0;
  private readonly clientId = randomUUID().slice(0, 12);

  constructor(
    private readonly cfg: TuiConfig,
    private readonly ssh: SshRunner,
    private readonly now: () => Date = () => new Date(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  async send(cmd: ArchiveOpCommand): Promise<ArchiveOpOutcome> {
    let payload: string;
    try {
      payload = archiveOpPayload(cmd);
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
    const name = archiveOpFileName(this.now(), this.clientId, this.seq++);
    const write = await this.ssh(this.cfg.ssh_host, commandWriteArgv(this.cfg, name), {
      stdin: payload,
    });
    if (!write.ok)
      return {
        ok: false,
        reason: `command write failed (${write.stderr.trim() || `exit ${write.code}`})`,
      };
    const deadline = this.now().getTime() + archiveOpTimeoutMs(this.cfg);
    while (this.now().getTime() < deadline) {
      await this.sleep(2000);
      const probe = await this.ssh(this.cfg.ssh_host, commandResultArgv(this.cfg, name));
      if (!probe.ok) continue;
      const body = probe.stdout.trim();
      if (body === "" || body === "pending") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return { ok: false, reason: "unreadable daemon result" };
      }
      // Valid JSON is not yet a receipt: anything but an object is unreadable.
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
        return { ok: false, reason: "unreadable daemon result" };
      const v = parsed as Record<string, unknown>;
      const issuer =
        v["issuer"] === "operator" || v["issuer"] === "session" ? v["issuer"] : undefined;
      if (v["ok"] !== true)
        return {
          ok: false,
          reason: resultReason(v["reason"], "no reason given"),
          ...(issuer ? { issuer } : {}),
          result: v,
        };
      return { ok: true, ...(issuer ? { issuer } : {}), result: v };
    }
    return {
      ok: false,
      reason: "no result before timeout (daemon down, or the operator channel busy?)",
    };
  }
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** One line of untrusted text (the result file sits in a dir sessions can
 * write): no control bytes, one line. */
const safe = (v: unknown, fallback: string): string => resultReason(v, fallback);

/** A line for the operator's terminal: the daemon's strings sit in a dir the
 * sessions can write, so no control byte reaches the terminal. */
const clean = (line: string): string => line.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ");

/** What `qcr archive run|restore` prints for the daemon's answer. */
export function renderArchiveOp(cmd: ArchiveOpCommand, out: ArchiveOpOutcome): string[] {
  const lines: string[] = [];
  const r = out.result ?? {};
  if (!out.ok) {
    lines.push(`✖ refused: ${out.reason ?? "no reason given"}`);
    if (out.issuer === "session")
      lines.push(
        "  the daemon found commands/operator/ UNSEALED (writable by its own uid), so it served the file as a session's — check the directory is root-owned 0755 in the container",
      );
    return lines;
  }
  if (r["done"] === false) {
    lines.push(`… ${safe(r["note"], "still running — see `qcr archive status`")}`);
    return lines;
  }
  if (cmd.command === "archive-run") {
    const state = str(r["state"]) ?? "unknown";
    const held = str(r["held_reason"]);
    const until = str(r["held_until"]);
    lines.push(
      `✓ tick ran (mode ${safe(r["mode"], "?")}) — ${state === "held" ? `HELD (${safe(held, "reason unknown")})${until ? ` until ${safe(until, "?")}` : ""}` : state}` +
        `${r["planned"] === true ? "; plan recomputed" : ""}`,
    );
    const figures = readArchiveRunFigures(r);
    if (!figures) {
      lines.push("  the daemon's figures could not be read whole — see `qcr archive status`");
      return lines.map(clean);
    }
    const view = { ...figures, plan_at: null } as ArchiveStatus;
    lines.push(`  ${backlogPhrase(view)}`);
    const db = dbPhrase(view);
    if (db) lines.push(`  ${db}`);
    const files = filesPhrase(view);
    if (files) lines.push(`  ${files}`);
    for (const [label, st] of [
      ["overseer store", figures.stores?.overseer ?? null],
      ["pi-global store", figures.stores?.pi_global ?? null],
    ] as const) {
      const line = storePhrase(label, st);
      if (line) lines.push(`  ${line}`);
    }
    return lines.map(clean);
  }
  const outcome = str(r["outcome"]);
  if (outcome === "none") {
    lines.push(`• nothing restored: ${safe(r["note"], "no archive to restore")}`);
    return lines;
  }
  const restored = num(r["restored"]);
  const present = num(r["present"]);
  const differs = Array.isArray(r["live_differs"]) ? r["live_differs"].length : 0;
  lines.push(
    `✓ pr-${cmd.command === "archive-restore" ? cmd.pr : "?"} restored — ${restored ?? "?"} file(s) back, ${present ?? "?"} already present` +
      (differs > 0 ? `, ${differs} left as the newer live file` : ""),
  );
  return lines;
}

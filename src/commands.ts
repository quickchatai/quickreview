// The overseer's action space: command files in commands/*.json, validated
// against a closed whitelist and executed by the daemon. There is deliberately
// no generic escape hatch — anything not on the whitelist is rejected, logged
// loudly, and answered with a result file the overseer can read.
//
// Envelope: {"command": "<name>", ...payload}. Schemas are hand-rolled and
// STRICT — unknown fields are a rejection, not a warning.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { basename, join } from "node:path";
import type { StateStore } from "./state.js";
import type { FileOutcome, ImprovementPayload, IssuePayload } from "./improvements.js";
import { SLUG_RE } from "./improvements.js";
import type { OriginRecord } from "./slack/origin.js";
import { SLACK_TS_RE } from "./slack/reply.js";

export type CommandName =
  | "rerun-round"
  | "restart-session"
  | "mark-escalation-worthy"
  | "pause-pr"
  | "resume-pr"
  | "flag-owner-legacy"
  | "file-improvement-pr"
  | "file-issue"
  | "slack_reply";

export const COMMAND_WHITELIST: readonly CommandName[] = [
  "rerun-round",
  "restart-session",
  "mark-escalation-worthy",
  "pause-pr",
  "resume-pr",
  "flag-owner-legacy",
  "file-improvement-pr",
  "file-issue",
  "slack_reply",
] as const;

export type Command =
  | { command: "rerun-round"; pr: number }
  | { command: "restart-session"; pr: number | "overseer" }
  | { command: "mark-escalation-worthy"; pr: number; reason: string }
  | { command: "pause-pr"; pr: number; reason: string }
  | { command: "resume-pr"; pr: number }
  | { command: "flag-owner-legacy"; message: string }
  | ({ command: "file-improvement-pr" } & ImprovementPayload)
  | ({ command: "file-issue" } & IssuePayload)
  | { command: "slack_reply"; thread: string; text: string };

/** Context a command file carries with it (its own name, for idempotence). */
export interface CommandContext {
  /** Basename of the command file, "" for a direct executeCommand call. */
  file: string;
}

/** Handlers the daemon wires; each may reject by returning {ok:false, reason}. */
export interface CommandDeps {
  rerunRound(pr: number): Promise<FileOutcome | void> | FileOutcome | void;
  restartSession(target: number | "overseer"): Promise<FileOutcome | void> | FileOutcome | void;
  markEscalationWorthy(pr: number, reason: string): Promise<FileOutcome | void> | FileOutcome | void;
  pausePr(pr: number, reason: string): Promise<FileOutcome | void> | FileOutcome | void;
  resumePr(pr: number): Promise<FileOutcome | void> | FileOutcome | void;
  flagOwnerLegacy(message: string): Promise<FileOutcome | void> | FileOutcome | void;
  fileImprovementPr(payload: ImprovementPayload): Promise<FileOutcome | void> | FileOutcome | void;
  fileIssue(payload: IssuePayload): Promise<FileOutcome | void> | FileOutcome | void;
  /** Optional: absent when Slack is disabled, in which case `slack_reply` is
   * rejected with a reason instead of silently succeeding. */
  slackReply?(
    payload: { thread: string; text: string; file: string },
  ): Promise<FileOutcome | void> | FileOutcome | void;
}

export type ValidationResult = { ok: true; command: Command } | { ok: false; reason: string };

// ---- hand-rolled schema validation ----------------------------------------

function fieldError(obj: Record<string, unknown>, allowed: string[]): string | null {
  const unknown = Object.keys(obj).filter((k) => k !== "command" && !allowed.includes(k));
  return unknown.length > 0 ? `unknown field(s): ${unknown.join(", ")}` : null;
}

function isPrNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/** Validate a parsed command file against the whitelist + per-command schema. */
export function validateCommand(raw: unknown): ValidationResult {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "command file must be a JSON object" };
  }
  const obj = raw as Record<string, unknown>;
  const name = obj["command"];
  if (typeof name !== "string") return { ok: false, reason: "missing 'command' field" };
  if (!(COMMAND_WHITELIST as readonly string[]).includes(name)) {
    return { ok: false, reason: `command '${name}' is not whitelisted (allowed: ${COMMAND_WHITELIST.join(", ")})` };
  }

  switch (name as CommandName) {
    case "rerun-round": {
      const err = fieldError(obj, ["pr"]);
      if (err) return { ok: false, reason: err };
      if (!isPrNumber(obj["pr"])) return { ok: false, reason: "'pr' must be a positive integer" };
      return { ok: true, command: { command: "rerun-round", pr: obj["pr"] } };
    }
    case "restart-session": {
      const err = fieldError(obj, ["pr"]);
      if (err) return { ok: false, reason: err };
      const pr = obj["pr"];
      if (!isPrNumber(pr) && pr !== "overseer") {
        return { ok: false, reason: "'pr' must be a positive integer or the string \"overseer\"" };
      }
      return { ok: true, command: { command: "restart-session", pr: pr as number | "overseer" } };
    }
    case "mark-escalation-worthy": {
      const err = fieldError(obj, ["pr", "reason"]);
      if (err) return { ok: false, reason: err };
      if (!isPrNumber(obj["pr"])) return { ok: false, reason: "'pr' must be a positive integer" };
      if (!isNonEmptyString(obj["reason"])) return { ok: false, reason: "'reason' must be a non-empty string" };
      return { ok: true, command: { command: "mark-escalation-worthy", pr: obj["pr"], reason: obj["reason"] } };
    }
    case "pause-pr": {
      const err = fieldError(obj, ["pr", "reason"]);
      if (err) return { ok: false, reason: err };
      if (!isPrNumber(obj["pr"])) return { ok: false, reason: "'pr' must be a positive integer" };
      if (!isNonEmptyString(obj["reason"])) return { ok: false, reason: "'reason' must be a non-empty string" };
      return { ok: true, command: { command: "pause-pr", pr: obj["pr"], reason: obj["reason"] } };
    }
    case "resume-pr": {
      const err = fieldError(obj, ["pr"]);
      if (err) return { ok: false, reason: err };
      if (!isPrNumber(obj["pr"])) return { ok: false, reason: "'pr' must be a positive integer" };
      return { ok: true, command: { command: "resume-pr", pr: obj["pr"] } };
    }
    case "flag-owner-legacy": {
      const err = fieldError(obj, ["message"]);
      if (err) return { ok: false, reason: err };
      if (!isNonEmptyString(obj["message"])) return { ok: false, reason: "'message' must be a non-empty string" };
      return { ok: true, command: { command: "flag-owner-legacy", message: obj["message"] } };
    }
    case "file-improvement-pr": {
      const err = fieldError(obj, ["branch", "title", "body", "slug"]);
      if (err) return { ok: false, reason: err };
      for (const f of ["branch", "title", "body", "slug"]) {
        if (!isNonEmptyString(obj[f])) return { ok: false, reason: `'${f}' must be a non-empty string` };
      }
      const slug = obj["slug"] as string;
      if (!SLUG_RE.test(slug)) {
        return { ok: false, reason: `'slug' must match ${SLUG_RE.source} (it becomes bot/improve-<slug>)` };
      }
      return {
        ok: true,
        command: {
          command: "file-improvement-pr",
          branch: obj["branch"] as string,
          title: obj["title"] as string,
          body: obj["body"] as string,
          slug,
        },
      };
    }
    case "file-issue": {
      const err = fieldError(obj, ["title", "body"]);
      if (err) return { ok: false, reason: err };
      for (const f of ["title", "body"]) {
        if (!isNonEmptyString(obj[f])) return { ok: false, reason: `'${f}' must be a non-empty string` };
      }
      return { ok: true, command: { command: "file-issue", title: obj["title"] as string, body: obj["body"] as string } };
    }
    case "slack_reply": {
      const err = fieldError(obj, ["thread", "text"]);
      if (err) return { ok: false, reason: err };
      // No `channel` field, by construction: the daemon binds every reply to
      // cfg.slack.channel, so posting in the wrong place is unrepresentable.
      if (!isNonEmptyString(obj["thread"]) || !SLACK_TS_RE.test(obj["thread"])) {
        return { ok: false, reason: "'thread' must be a Slack message ts like \"1712345678.123456\"" };
      }
      if (!isNonEmptyString(obj["text"])) return { ok: false, reason: "'text' must be a non-empty string" };
      return { ok: true, command: { command: "slack_reply", thread: obj["thread"], text: obj["text"] as string } };
    }
  }
}

// ---- tier enforcement (S3) ----------------------------------------

/**
 * Commands a Slack turn may run, by tier. The table is data on purpose: adding
 * a command without deciding its tier is then impossible to do by accident.
 *
 * `own` = allowed for tier `author` only when the target PR is in the origin's
 * `authorized_prs` (recomputed by the router from `pr_state.author`, NEVER read
 * out of the inject body).
 *
 * Nothing here can reach the dry_run flag, a deploy, an approval or anything
 * review-dismissing: those are not commands at all, and this feature adds no
 * GitHub mutation — every write still goes through the MutationGate.
 */
const TIER_TABLE: Record<CommandName, { anyone: boolean; author: "own" | boolean; owner_legacy: boolean }> = {
  "rerun-round": { anyone: false, author: "own", owner_legacy: true },
  "mark-escalation-worthy": { anyone: false, author: "own", owner_legacy: true },
  "pause-pr": { anyone: false, author: "own", owner_legacy: true },
  "resume-pr": { anyone: false, author: "own", owner_legacy: true },
  // The safety valve: anyone may always reach a human.
  "flag-owner-legacy": { anyone: true, author: true, owner_legacy: true },
  "restart-session": { anyone: false, author: false, owner_legacy: true },
  // improvements.ts caps still apply ON TOP — a tier never lifts a cap.
  "file-improvement-pr": { anyone: false, author: false, owner_legacy: true },
  "file-issue": { anyone: false, author: false, owner_legacy: true },
  // Not user-tiered: gated by channel binding, thread, caps, cooldown, length.
  slack_reply: { anyone: true, author: true, owner_legacy: true },
};

/** Target PR of a command, when it has one. */
function targetPr(command: Command): number | null {
  if (command.command === "restart-session") return typeof command.pr === "number" ? command.pr : null;
  return "pr" in command && typeof command.pr === "number" ? command.pr : null;
}

export type AuthorizationResult = { ok: true } | { ok: false; reason: string };

/**
 * May this command run on behalf of `origin`?
 *
 * `origin === null` means "no Slack turn is live" — the command came from the
 * daemon itself (EOD sweep, anomaly wake) or from the owner at the tmux pane, and
 * keeps today's full autonomy (tier M). A caller that must fail closed (the
 * Slack command directory) checks for a missing origin BEFORE calling this.
 *
 * Every rejection reason starts with `tier: ` so the overseer — and the
 * `command_rejected` event stream — can tell a rights refusal from a cap.
 */
export function authorizeCommand(command: Command, origin: OriginRecord | null): AuthorizationResult {
  if (origin === null) return { ok: true };
  const row = TIER_TABLE[command.command];
  const pr = targetPr(command);
  switch (origin.tier) {
    case "owner_legacy":
      return row.owner_legacy ? { ok: true } : { ok: false, reason: `tier: '${command.command}' is not available` };
    case "author": {
      if (row.author === true) return { ok: true };
      if (row.author === false) {
        return { ok: false, reason: `tier: '${command.command}' requires tier owner_legacy (this turn is tier author)` };
      }
      if (pr === null) return { ok: false, reason: `tier: '${command.command}' needs a PR number to check ownership` };
      if (origin.authorized_prs.includes(pr)) return { ok: true };
      return {
        ok: false,
        reason: `tier: PR #${pr} is not authored by this Slack user (authorized: ${
          origin.authorized_prs.length ? origin.authorized_prs.join(", ") : "none"
        })`,
      };
    }
    default:
      // `anyone` and `ignored` alike: read-only plus the two ungated commands.
      return row.anyone
        ? { ok: true }
        : { ok: false, reason: `tier: '${command.command}' is not available at tier ${origin.tier}` };
  }
}

function normalize(outcome: FileOutcome | void): FileOutcome {
  return outcome === undefined || outcome === null ? { ok: true } : outcome;
}

/** Dispatch a validated command to the injected handlers. */
export async function executeCommand(
  command: Command,
  deps: CommandDeps,
  ctx: CommandContext = { file: "" },
): Promise<FileOutcome> {
  switch (command.command) {
    case "rerun-round":
      return normalize(await deps.rerunRound(command.pr));
    case "restart-session":
      return normalize(await deps.restartSession(command.pr));
    case "mark-escalation-worthy":
      return normalize(await deps.markEscalationWorthy(command.pr, command.reason));
    case "pause-pr":
      return normalize(await deps.pausePr(command.pr, command.reason));
    case "resume-pr":
      return normalize(await deps.resumePr(command.pr));
    case "flag-owner-legacy":
      return normalize(await deps.flagOwnerLegacy(command.message));
    case "file-improvement-pr":
      return normalize(
        await deps.fileImprovementPr({
          branch: command.branch,
          title: command.title,
          body: command.body,
          slug: command.slug,
        }),
      );
    case "file-issue":
      return normalize(await deps.fileIssue({ title: command.title, body: command.body }));
    case "slack_reply": {
      if (!deps.slackReply) return { ok: false, reason: "slack_reply is not wired (Slack is disabled)" };
      return normalize(await deps.slackReply({ thread: command.thread, text: command.text, file: ctx.file }));
    }
  }
}

// ---- the watcher -----------------------------------------------------------

/**
 * Which command directory this watcher serves, and how to find the live Slack
 * origin (ratified D5(c) — TWO directories, one gate).
 *
 *   `local`  — the legacy `commands/` dir. Behaves exactly as it always has, so
 *              EOD sweeps, anomaly wakes and the owner at the tmux pane lose no
 *              autonomy. The one BELT: while a Slack turn from a non-owner
 *              user is live, this dir refuses — the overseer wrote to the wrong
 *              place mid-turn, and a tier-checked command must not slip past by
 *              choosing a filename.
 *   `slack`  — the tier-checked `commands/slack/` dir. No live origin ⇒ DENY.
 *
 * Omit the gate entirely and the watcher behaves as it did before.
 */
export interface CommandTierGate {
  dir: "local" | "slack";
  /** Most recent unexpired origin, or null when no Slack turn is live. */
  currentOrigin(): OriginRecord | null;
}

export interface CommandWatcherOptions {
  /** commands/ directory. Results land in <dir>/results, handled files in <dir>/processed. */
  dir: string;
  /** Tier enforcement for this directory. Absent ⇒ legacy behaviour. */
  tier?: CommandTierGate;
  deps: CommandDeps;
  store: StateStore;
  now?: () => Date;
  /** Partial-write tolerance: re-read a file that fails to parse. */
  parseAttempts?: number;
  parseRetryMs?: number;
  log?: (line: string) => void;
}

export interface CommandResultFile extends FileOutcome {
  command: string | null;
  file: string;
  handled_at: string;
}

export class CommandWatcher {
  private readonly dir: string;
  private readonly resultsDir: string;
  private readonly processedDir: string;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  private watcher: FSWatcher | null = null;
  private readonly inFlight = new Set<string>();
  /** Serialises handling so two file events can't race the same caps. */
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly opts: CommandWatcherOptions) {
    this.dir = opts.dir;
    this.resultsDir = join(opts.dir, "results");
    this.processedDir = join(opts.dir, "processed");
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? ((line) => console.error(line));
  }

  private ensureDirs(): void {
    mkdirSync(this.dir, { recursive: true });
    mkdirSync(this.resultsDir, { recursive: true });
    mkdirSync(this.processedDir, { recursive: true });
  }

  /** Startup sweep + fs.watch. Returns once the initial sweep has completed. */
  async start(): Promise<void> {
    this.ensureDirs();
    await this.sweep();
    this.watcher = watch(this.dir, (_event, filename) => {
      if (!filename) {
        void this.enqueueSweep();
        return;
      }
      const name = filename.toString();
      if (!name.endsWith(".json")) return;
      void this.enqueue(join(this.dir, name));
    });
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  /** Handle every pending commands/*.json once. */
  async sweep(): Promise<void> {
    this.ensureDirs();
    const names = readdirSync(this.dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".json"))
      .map((e) => e.name)
      .sort();
    for (const name of names) await this.handleFile(join(this.dir, name));
  }

  private enqueueSweep(): Promise<void> {
    this.queue = this.queue.then(() => this.sweep()).catch((err) => this.log(`[commands] sweep failed: ${String(err)}`));
    return this.queue;
  }

  private enqueue(path: string): Promise<void> {
    this.queue = this.queue
      .then(async () => {
        await this.handleFile(path);
      })
      .catch((err) => this.log(`[commands] ${path}: ${String(err)}`));
    return this.queue;
  }

  private async readCommandFile(path: string): Promise<{ ok: true; value: unknown } | { ok: false; reason: string }> {
    const attempts = this.opts.parseAttempts ?? 3;
    const delay = this.opts.parseRetryMs ?? 40;
    let lastError = "unreadable";
    for (let i = 0; i < attempts; i++) {
      if (!existsSync(path)) return { ok: false, reason: "file disappeared" };
      try {
        const text = readFileSync(path, "utf8");
        if (text.trim().length === 0) {
          lastError = "empty file";
        } else {
          return { ok: true, value: JSON.parse(text) as unknown };
        }
      } catch (err) {
        // A partially-written file is expected transiently — retry before rejecting.
        lastError = (err as Error).message;
      }
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, delay));
    }
    return { ok: false, reason: `malformed JSON: ${lastError}` };
  }

  /** Validate + execute one command file, writing its result file. */
  async handleFile(path: string): Promise<CommandResultFile | null> {
    const name = basename(path, ".json");
    if (this.inFlight.has(path)) return null;
    if (!existsSync(path)) return null;
    this.inFlight.add(path);
    try {
      this.ensureDirs();
      const read = await this.readCommandFile(path);
      if (!read.ok) {
        if (read.reason === "file disappeared") return null;
        return this.finish(path, name, null, { ok: false, reason: read.reason }, true);
      }
      const validation = validateCommand(read.value);
      if (!validation.ok) {
        const attempted = (read.value as { command?: unknown } | null)?.command;
        return this.finish(
          path,
          name,
          typeof attempted === "string" ? attempted : null,
          { ok: false, reason: validation.reason },
          true,
        );
      }
      const denial = this.tierCheck(validation.command);
      if (denial) return this.finish(path, name, validation.command.command, { ok: false, reason: denial }, true);
      let outcome: FileOutcome;
      try {
        outcome = await executeCommand(validation.command, this.opts.deps, { file: name });
      } catch (err) {
        outcome = { ok: false, reason: `handler threw: ${(err as Error).message}` };
      }
      return this.finish(path, name, validation.command.command, outcome, !outcome.ok);
    } finally {
      this.inFlight.delete(path);
    }
  }

  /** Rights check between validation and execution. Returns a reason to deny. */
  private tierCheck(command: Command): string | null {
    const gate = this.opts.tier;
    if (!gate) return null;
    let origin: OriginRecord | null = null;
    try {
      origin = gate.currentOrigin();
    } catch (err) {
      // A gate that cannot answer denies — never fails open.
      return `tier: origin lookup failed (${(err as Error).message})`;
    }
    if (gate.dir === "slack") {
      if (!origin) {
        return "tier: no live Slack origin for this turn — a tier-checked command needs one (fail closed)";
      }
      const auth = authorizeCommand(command, origin);
      return auth.ok ? null : auth.reason;
    }
    // Legacy dir: only the belt applies.
    if (origin && origin.tier !== "owner_legacy") {
      return (
        `tier: a Slack turn from ${origin.slack_user} (tier ${origin.tier}) is live — ` +
        `write '${command.command}' to commands/slack/ so it can be tier-checked`
      );
    }
    return null;
  }

  private finish(
    path: string,
    name: string,
    command: string | null,
    outcome: FileOutcome,
    loud: boolean,
  ): CommandResultFile {
    const result: CommandResultFile = {
      ...outcome,
      command,
      file: basename(path),
      handled_at: this.now().toISOString(),
    };
    writeFileSync(join(this.resultsDir, `${name}.result.json`), JSON.stringify(result, null, 2));
    if (outcome.ok) {
      this.opts.store.logEvent("command_executed", null, { command, file: result.file });
    } else {
      this.opts.store.logEvent("command_rejected", null, { command, file: result.file, reason: outcome.reason });
    }
    if (loud) this.log(`[commands] REJECTED ${result.file} (${command ?? "?"}): ${outcome.reason ?? "unknown reason"}`);
    // Archive the handled file so a daemon restart cannot re-execute it.
    try {
      renameSync(path, join(this.processedDir, `${name}.json`));
    } catch {
      /* best effort — a vanished file is fine */
    }
    return result;
  }
}

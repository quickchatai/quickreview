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
import { BRANCH_MAX, BRANCH_RE, isBranchName, SLUG_RE } from "./improvements.js";
import type { OriginRecord } from "./slack/origin.js";
import { SLACK_TS_RE } from "./slack/reply.js";

export type CommandName =
  | "rerun-round"
  | "restart-session"
  | "resolve-terminal-failure"
  | "pause-pr"
  | "resume-pr"
  | "flag-owner"
  | "file-improvement-pr"
  | "file-issue"
  | "slack_reply"
  | "drain"
  | "retry-thread-decision";

export const COMMAND_WHITELIST: readonly CommandName[] = [
  "rerun-round",
  "restart-session",
  "resolve-terminal-failure",
  "pause-pr",
  "resume-pr",
  "flag-owner",
  "file-improvement-pr",
  "file-issue",
  "slack_reply",
  "drain",
  "retry-thread-decision",
] as const;

/**
 * Retired command spellings, folded to their current name at validate time
 * — the codebase's ESCALATE→NEEDS_HUMAN pattern: ACCEPTED on input
 * (frozen prompts and live overseers still emit them, until the
 * reseed and beyond), never emitted by us — the parsed `Command`, the result
 * file and the event ledger all carry the current name. Pinned by
 * tests/legacy-acceptance.test.ts; an entry here is a permanent belt, not a
 * cleanup candidate.
 */
const LEGACY_COMMAND_NAMES: Readonly<Record<string, CommandName>> = {
  "flag-owner-legacy": "flag-owner",
};

export interface TerminalFailurePayload {
  pr: number;
  incident_id: string;
  command_id: string;
  head_sha: string;
}

export type Command =
  | { command: "rerun-round"; pr: number }
  | { command: "restart-session"; pr: number | "overseer" }
  | ({ command: "resolve-terminal-failure" } & TerminalFailurePayload)
  | { command: "pause-pr"; pr: number; reason: string }
  | { command: "resume-pr"; pr: number }
  | { command: "flag-owner"; message: string }
  | ({ command: "file-improvement-pr" } & ImprovementPayload)
  | ({ command: "file-issue" } & IssuePayload)
  | { command: "slack_reply"; thread: string; text: string }
  /** Deploy-window drain (2026-08-25): the valve the TUI unwedge precedent
   * carries — a hard webhook stop + dispatch/recheck/ping-pong/EOD hold while
   * in-flight rounds finish naturally. */
  | { command: "drain"; on: boolean }
  | { command: "retry-thread-decision"; comment_id: number };

/** Context a command file carries with it (its own name, for idempotence). */
export interface CommandContext {
  /** Basename of the command file, "" for a direct executeCommand call. */
  file: string;
}

/** Handlers the daemon wires; each may reject by returning {ok:false, reason}. */
export interface CommandDeps {
  rerunRound(pr: number): Promise<FileOutcome | void> | FileOutcome | void;
  restartSession(target: number | "overseer"): Promise<FileOutcome | void> | FileOutcome | void;
  resolveTerminalFailure(payload: TerminalFailurePayload): Promise<FileOutcome | void> | FileOutcome | void;
  pausePr(pr: number, reason: string): Promise<FileOutcome | void> | FileOutcome | void;
  resumePr(pr: number): Promise<FileOutcome | void> | FileOutcome | void;
  flagOwner(message: string): Promise<FileOutcome | void> | FileOutcome | void;
  fileImprovementPr(payload: ImprovementPayload): Promise<FileOutcome | void> | FileOutcome | void;
  fileIssue(payload: IssuePayload): Promise<FileOutcome | void> | FileOutcome | void;
  /** Deploy-window drain valve. Optional like `slackReply`: a daemon wired
   * without it rejects the command with a reason instead of pretending. */
  drain?(on: boolean): Promise<FileOutcome | void> | FileOutcome | void;
  retryThreadDecision?(commentId: number): Promise<FileOutcome | void> | FileOutcome | void;
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

function isGitHubId(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
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
  // Legacy-name fold FIRST: an aliased spelling validates against — and parses
  // into — its current name, so downstream (tier table, dispatch, result
  // files) never sees the retired spelling.
  const canonical = LEGACY_COMMAND_NAMES[name] ?? name;
  if (!(COMMAND_WHITELIST as readonly string[]).includes(canonical)) {
    // Retired commands get their own reason. `prompts/overseer-system.md` is
    // frozen seeded content (CLAUDE.md rule 6) and still advertises
    // mark-escalation-worthy, so the overseer will keep emitting it until
    // The owner ratifies a reseed — it should learn why, not just "unknown".
    if (name === "mark-escalation-worthy") {
      return {
        ok: false,
        reason:
          "command 'mark-escalation-worthy' was RETIRED on 2026-08-18: escalation-worthiness no longer exists. " +
          "A PR only stops for a person when a round returns NEEDS_HUMAN. Use pause-pr to hold one, or flag-owner " +
          "(formerly flag-owner-legacy — the old name is still accepted) to raise it.",
      };
    }
    return { ok: false, reason: `command '${name}' is not whitelisted (allowed: ${COMMAND_WHITELIST.join(", ")})` };
  }

  switch (canonical as CommandName) {
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
    case "resolve-terminal-failure": {
      const err = fieldError(obj, ["pr", "incident_id", "command_id", "head_sha"]);
      if (err) return { ok: false, reason: err };
      if (!isPrNumber(obj["pr"])) return { ok: false, reason: "'pr' must be a positive integer" };
      for (const field of ["incident_id", "command_id"]) {
        if (!isNonEmptyString(obj[field])) return { ok: false, reason: `'${field}' must be a non-empty string` };
      }
      // An authoritative GitHub 404 can legitimately correspond to a legacy
      // synthetic debt whose stored head is the empty string. Closed PRs are
      // still forced to a non-empty exact match by resolveTerminalFailure().
      if (typeof obj["head_sha"] !== "string") return { ok: false, reason: "'head_sha' must be a string" };
      if (obj["incident_id"] !== `review-failure:${obj["command_id"] as string}`) {
        return { ok: false, reason: "'incident_id' must exactly equal review-failure:<command_id>" };
      }
      return {
        ok: true,
        command: {
          command: "resolve-terminal-failure",
          pr: obj["pr"],
          incident_id: obj["incident_id"] as string,
          command_id: obj["command_id"] as string,
          head_sha: obj["head_sha"] as string,
        },
      };
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
    case "flag-owner": {
      const err = fieldError(obj, ["message"]);
      if (err) return { ok: false, reason: err };
      if (!isNonEmptyString(obj["message"])) return { ok: false, reason: "'message' must be a non-empty string" };
      return { ok: true, command: { command: "flag-owner", message: obj["message"] } };
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
      // The session writes `branch` and the daemon hands it to git: only a
      // plain local branch name passes — never an option (`--quiet`), a force
      // refspec (`+wip/x`), a refspec (`a:b`) or a revision expression (`a..b`).
      const branch = obj["branch"] as string;
      if (!isBranchName(branch)) {
        return { ok: false, reason: `'branch' must be a plain local branch name matching ${BRANCH_RE.source} (at most ${BRANCH_MAX} chars)` };
      }
      return {
        ok: true,
        command: {
          command: "file-improvement-pr",
          branch,
          title: obj["title"] as string,
          body: obj["body"] as string,
          slug,
        },
      };
    }
    case "file-issue": {
      // `pr` is OPTIONAL provenance — the PR a deferral's ticket was
      // filed from. The review session files the ticket ITSELF, in the round
      // that deferred; `pr` attributes the filing — and a cap refusal, which
      // then leaves a `deferral_ticket_refused` anomaly — to that PR, so the
      // refusal is visible where the deferral happened. It grants no rights
      // and lifts no cap. Absent, the command behaves exactly as it always has.
      const err = fieldError(obj, ["title", "body", "pr"]);
      if (err) return { ok: false, reason: err };
      for (const f of ["title", "body"]) {
        if (!isNonEmptyString(obj[f])) return { ok: false, reason: `'${f}' must be a non-empty string` };
      }
      if (obj["pr"] !== undefined && !isPrNumber(obj["pr"])) {
        return { ok: false, reason: "'pr' must be a positive integer when present" };
      }
      return {
        ok: true,
        command: {
          command: "file-issue",
          title: obj["title"] as string,
          body: obj["body"] as string,
          ...(obj["pr"] === undefined ? {} : { pr: obj["pr"] as number }),
        },
      };
    }
    case "drain": {
      const err = fieldError(obj, ["on"]);
      if (err) return { ok: false, reason: err };
      if (typeof obj["on"] !== "boolean") {
        return { ok: false, reason: "'on' must be a boolean (true = engage the drain, false = lift it)" };
      }
      return { ok: true, command: { command: "drain", on: obj["on"] } };
    }
    case "retry-thread-decision": {
      const err = fieldError(obj, ["comment_id"]);
      if (err) return { ok: false, reason: err };
      if (!isGitHubId(obj["comment_id"])) return { ok: false, reason: "'comment_id' must be a positive safe integer" };
      return { ok: true, command: { command: "retry-thread-decision", comment_id: obj["comment_id"] } };
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
 * `owner` carries exactly the rights the retired `owner_legacy` tier had (
 * renamed the column; legacy persisted records fold to it on read). `system`
 * is the daemon's own unattended turns (`OriginStore.writeLocal`): it is
 * `true` on every row because a daemon turn with NO origin record already runs
 * unrestricted — `authorizeCommand(_, null)` ⇒ ok, and that null-origin rule
 * is unchanged. The column is the stamped, auditable form of that same
 * standing authority; it never widens anything, and a Slack turn can never
 * reach it (`computeTier` never returns `system`).
 *
 * Nothing here can reach the dry_run flag, a deploy, an approval or anything
 * review-dismissing: those are not commands at all, and this feature adds no
 * GitHub mutation — every write still goes through the MutationGate.
 */
const TIER_TABLE: Record<CommandName, { anyone: boolean; author: "own" | boolean; owner: boolean; system: boolean }> = {
  "rerun-round": { anyone: false, author: "own", owner: true, system: true },
  "pause-pr": { anyone: false, author: "own", owner: true, system: true },
  "resume-pr": { anyone: false, author: "own", owner: true, system: true },
  // The safety valve: anyone may always reach a human.
  "flag-owner": { anyone: true, author: true, owner: true, system: true },
  "restart-session": { anyone: false, author: false, owner: true, system: true },
  // Terminal debt cleanup is destructive and never author-reachable. Its
  // handler additionally requires exact identity + authoritative terminality.
  "resolve-terminal-failure": { anyone: false, author: false, owner: true, system: true },
  // improvements.ts caps still apply ON TOP — a tier never lifts a cap.
  "file-improvement-pr": { anyone: false, author: false, owner: true, system: true },
  // (corrected by the owner): the review SESSION files a deferral's
  // ticket itself, in the round that deferred — there is no author
  // confirmation step. The session's command files land in the legacy
  // `commands/` dir with no Slack origin, which already runs at full
  // (system-column) autonomy, so the deferral path needs no widening here at
  // all. The brief `author: "own"` widening (built for the retired
  // confirm-then-file design) is reverted: on Slack, `file-issue` is the
  // owner's alone again. The day cap, the dedup and the gate all still apply
  // downstream — a tier never lifts a cap.
  "file-issue": { anyone: false, author: false, owner: true, system: true },
  // Not user-tiered: gated by channel binding, thread, caps, cooldown, length.
  slack_reply: { anyone: true, author: true, owner: true, system: true },
  // Deploy-window drain: an OPERATOR lever (same standing as restart-session)
  // — it stops the whole board, so it is never author-reachable.
  drain: { anyone: false, author: false, owner: true, system: true },
  "retry-thread-decision": { anyone: false, author: false, owner: true, system: true },
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
 * daemon itself (EOD sweep, anomaly wake) or from the owner at the tmux pane,
 * and keeps today's full autonomy (the same rights the `system` tier stamps
 * explicitly). A caller that must fail closed (the Slack command directory)
 * checks for a missing origin BEFORE calling this.
 *
 * Every rejection reason starts with `tier: ` so the overseer — and the
 * `command_rejected` event stream — can tell a rights refusal from a cap.
 */
export function authorizeCommand(command: Command, origin: OriginRecord | null): AuthorizationResult {
  if (origin === null) return { ok: true };
  const row = TIER_TABLE[command.command];
  const pr = targetPr(command);
  switch (origin.tier) {
    case "owner":
      return row.owner ? { ok: true } : { ok: false, reason: `tier: '${command.command}' is not available` };
    case "system":
      return row.system ? { ok: true } : { ok: false, reason: `tier: '${command.command}' is not available` };
    case "author": {
      if (row.author === true) return { ok: true };
      if (row.author === false) {
        return { ok: false, reason: `tier: '${command.command}' requires tier owner (this turn is tier author)` };
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
    case "resolve-terminal-failure":
      return normalize(await deps.resolveTerminalFailure({
        pr: command.pr,
        incident_id: command.incident_id,
        command_id: command.command_id,
        head_sha: command.head_sha,
      }));
    case "pause-pr":
      return normalize(await deps.pausePr(command.pr, command.reason));
    case "resume-pr":
      return normalize(await deps.resumePr(command.pr));
    case "flag-owner":
      return normalize(await deps.flagOwner(command.message));
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
      return normalize(
        await deps.fileIssue({
          title: command.title,
          body: command.body,
          ...(command.pr === undefined ? {} : { pr: command.pr }),
        }),
      );
    case "slack_reply": {
      if (!deps.slackReply) return { ok: false, reason: "slack_reply is not wired (Slack is disabled)" };
      return normalize(await deps.slackReply({ thread: command.thread, text: command.text, file: ctx.file }));
    }
    case "drain": {
      if (!deps.drain) return { ok: false, reason: "drain is not wired on this daemon" };
      return normalize(await deps.drain(command.on));
    }
    case "retry-thread-decision": {
      if (!deps.retryThreadDecision) return { ok: false, reason: "retry-thread-decision is not wired on this daemon" };
      return normalize(await deps.retryThreadDecision(command.comment_id));
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
 *              autonomy. The one BELT: when the turn being served was CAUSED by
 *              a non-owner Slack message, this dir refuses — the overseer
 *              wrote to the wrong place mid-turn, and a tier-checked command
 *              must not slip past by choosing a filename.
 *   `slack`  — the tier-checked `commands/slack/` dir. No live origin ⇒ DENY.
 *
 * Omit the gate entirely and the watcher behaves as it did before.
 */
export interface CommandTierGate {
  dir: "local" | "slack";
  /**
   * What this gate reads, and it differs by dir — both directions fail closed:
   *
   *   `slack` — the most recent UNEXPIRED origin (`OriginStore.latest()`).
   *             Null ⇒ deny: rights need a live turn.
   *   `local` — the most recent origin REGARDLESS OF AGE
   *             (`OriginStore.latestAny()`). Expiry is not an escalation: a
   *             Slack turn that simply ran long must not gain owner rights
   *             here, and only a daemon wake (a `local` record) clears the
   *             belt.
   */
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
    // Legacy dir: only the belt applies. It fires on CAUSE, not on recency —
    // a daemon-caused turn (`source: "local"`) always passes, and a Slack-caused
    // one from a non-owner user always refuses, however old the record is.
    // (`parseOriginRecord` folds the retired "owner_legacy" spelling to "owner", so
    // this comparison only ever sees the current vocabulary; a Slack origin can
    // never be "system" — only `writeLocal` stamps that, with source "local".)
    if (origin && origin.source === "slack" && origin.tier !== "owner") {
      return (
        `tier: this turn was caused by a Slack message from ${origin.slack_user} (tier ${origin.tier}) — ` +
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

// The overseer's action space: command files in commands/*.json, validated
// against a closed whitelist and executed by the daemon. There is deliberately
// no generic escape hatch — anything not on the whitelist is rejected, logged
// loudly, and answered with a result file the overseer can read.
//
// Envelope: {"command": "<name>", ...payload}. Schemas are hand-rolled and
// STRICT — unknown fields are a rejection, not a warning.
//
// Two issuers, decided by directory. The same vocabulary is served
// from the daemon-owned `commands/` (and `commands/slack/`), where every
// writer is a pi SESSION, and from `commands/operator/`, which the operator's
// tools (`qcr drain`, the board's `u`, the deploy tab) create and write as
// ROOT so that the daemon's uid — the uid every session runs as — cannot write
// into it. Nothing in a command file says who wrote it; the watcher stamps
// the issuer from the directory and the seal, and the lever handlers
// (`src/levers.ts`) bound a session's `drain`/`pause-pr` and never an
// operator's. A file in the operator directory without the seal is served as
// a session's, loudly.
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { StateStore } from "./state.js";
import type { FileOutcome, ImprovementPayload, IssuePayload } from "./improvements.js";
import { BRANCH_MAX, BRANCH_RE, isBranchName, SLUG_RE } from "./improvements.js";
import type { LeverIssuer } from "./levers.js";
import type { LessonSwitchChange } from "./lessonledger.js";
import { validateReceipt, type CurationReceipt } from "./learner/receipt.js";
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
  | "retry-thread-decision"
  | "eod-curation-receipt";

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
  "eod-curation-receipt",
] as const;

/**
 * The operator's commands: the lesson kill switch and the archiver's two
 * verbs (`archive-run`, one immediate bounded archiver tick, and
 * `archive-restore`, one PR's archive back to its live paths, both run under
 * the archiver's strict mutex). They are not in `COMMAND_WHITELIST` — the
 * vocabulary a session (the overseer, the EOD curator, a Slack turn) may
 * write — and they validate only for a file the watcher found in the
 * root-sealed `commands/operator/` directory (`operatorSealVerdict`). A
 * session's command file cannot spell them: in the session directories, and
 * in an UNSEALED operator directory (served as a session's), they are refused
 * at validation, and `executeCommand` refuses
 * them again for any issuer but the operator. The kill switch's state lives
 * in state.db (src/lessonledger.ts), never as a memory tag anyone holding a
 * key could write.
 */
export type OperatorCommandName =
  | "lessons-off"
  | "lessons-on"
  | "suppress-lesson"
  | "unsuppress-lesson"
  | "archive-run"
  | "archive-restore";

export const OPERATOR_COMMANDS: readonly OperatorCommandName[] = [
  "lessons-off",
  "lessons-on",
  "suppress-lesson",
  "unsuppress-lesson",
  "archive-run",
  "archive-restore",
] as const;

/** A lesson the operator names: the full memory URI of one entry
 * (`viking://user/<user>/memories/<area>/<file>.md`) — `qcr lessons
 * suppress` expands a bare `experiences/<file>.md` to it. */
export const LESSON_URI_RE =
  /^viking:\/\/user\/[A-Za-z0-9_-]{1,64}\/memories\/(?:[a-z][a-z0-9_-]*\/){1,2}[A-Za-z0-9._-]{1,200}\.md$/;

function isOperatorCommand(name: string): name is OperatorCommandName {
  return (OPERATOR_COMMANDS as readonly string[]).includes(name);
}

/**
 * Retired command spellings, folded to their current name at validate time —
 * the codebase's ESCALATE→NEEDS_HUMAN pattern: accepted on input (sessions on
 * older prompts may still emit them), never emitted by us — the parsed
 * `Command`, the result file and the event ledger all carry the current name.
 * Pinned by tests/legacy-acceptance.test.ts; an entry here is a permanent
 * belt, not a cleanup candidate.
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
  /** `for_min`: how long the hold is asked for. Optional — a
   * session that omits it gets the largest bounded grant the cap and the
   * day's budget allow, never "until resumed"; an operator's omission IS
   * "until resumed". Which of the two applies comes from the channel. */
  | { command: "pause-pr"; pr: number; reason: string; for_min?: number }
  | { command: "resume-pr"; pr: number }
  | { command: "flag-owner"; message: string }
  | ({ command: "file-improvement-pr" } & ImprovementPayload)
  | ({ command: "file-issue" } & IssuePayload)
  | { command: "slack_reply"; thread: string; text: string }
  /** Deploy-window drain: a hard webhook stop + dispatch/recheck/ping-pong/EOD
   * hold while in-flight rounds finish naturally. `for_min` as on `pause-pr`;
   * only meaningful with `on: true`. */
  | { command: "drain"; on: boolean; for_min?: number }
  | { command: "retry-thread-decision"; comment_id: number }
  /** The EOD curator's answer to the day's outcomes packet — per
   * candidate, adopted / declined (with a reason) / refused (the write
   * failed). Schema in src/learner/receipt.ts. */
  | ({ command: "eod-curation-receipt" } & CurationReceipt)
  /** The operator's lesson kill switch (`OPERATOR_COMMANDS`):
   * never valid in a session's file. */
  | { command: "lessons-off" }
  | { command: "lessons-on" }
  | { command: "suppress-lesson"; uri: string }
  | { command: "unsuppress-lesson"; uri: string }
  /** The operator's archive verbs (`OPERATOR_COMMANDS`): never
   * valid in a session's file. */
  | { command: "archive-run" }
  | { command: "archive-restore"; pr: number };

/** Who a command directory's writer is. Decided by which directory a file
 * arrived in and whether the operator seal held — never by a field in the
 * file. `session` is the default everywhere: it is the bounded side. */
export type CommandIssuer = LeverIssuer;

/** Context a command file carries with it (its own name, for idempotence,
 * and the issuer the watcher stamped from the channel). */
export interface CommandContext {
  /** Basename of the command file, "" for a direct executeCommand call. */
  file: string;
  issuer: CommandIssuer;
}

/** Handlers the daemon wires; each may reject by returning {ok:false, reason}. */
export interface CommandDeps {
  rerunRound(pr: number): Promise<FileOutcome | void> | FileOutcome | void;
  restartSession(target: number | "overseer"): Promise<FileOutcome | void> | FileOutcome | void;
  resolveTerminalFailure(
    payload: TerminalFailurePayload,
  ): Promise<FileOutcome | void> | FileOutcome | void;
  /** The two bounded levers receive the issuer the watcher stamped
   * from the channel, plus the optional asked-for duration. */
  pausePr(
    pr: number,
    reason: string,
    issuer: CommandIssuer,
    forMin: number | undefined,
  ): Promise<FileOutcome | void> | FileOutcome | void;
  resumePr(pr: number, issuer: CommandIssuer): Promise<FileOutcome | void> | FileOutcome | void;
  flagOwner(message: string): Promise<FileOutcome | void> | FileOutcome | void;
  fileImprovementPr(payload: ImprovementPayload): Promise<FileOutcome | void> | FileOutcome | void;
  fileIssue(payload: IssuePayload): Promise<FileOutcome | void> | FileOutcome | void;
  /** Deploy-window drain valve. Optional like `slackReply`: a daemon wired
   * without it rejects the command with a reason instead of pretending. */
  drain?(
    on: boolean,
    issuer: CommandIssuer,
    forMin: number | undefined,
  ): Promise<FileOutcome | void> | FileOutcome | void;
  retryThreadDecision?(commentId: number): Promise<FileOutcome | void> | FileOutcome | void;
  /** The learner's receipt handler. Optional like `drain`: a
   * daemon wired without the learner rejects the command with a reason. */
  curationReceipt?(receipt: CurationReceipt): Promise<FileOutcome | void> | FileOutcome | void;
  /** The operator's lesson kill switch (state.db). Reached only for an
   * operator-issued command; optional like `drain`. */
  lessonSwitch?(
    change: LessonSwitchChange,
    file: string,
  ): Promise<FileOutcome | void> | FileOutcome | void;
  /** The operator's archive verbs — one immediate bounded tick of the
   * archiver, and the restore of one PR's archive to its live paths. Reached
   * only for an operator-issued command; optional like `drain`. */
  archiveRun?(file: string): Promise<FileOutcome | void> | FileOutcome | void;
  archiveRestore?(pr: number, file: string): Promise<FileOutcome | void> | FileOutcome | void;
  /** Optional: absent when Slack is disabled, in which case `slack_reply` is
   * rejected with a reason instead of silently succeeding. */
  slackReply?(payload: {
    thread: string;
    text: string;
    file: string;
  }): Promise<FileOutcome | void> | FileOutcome | void;
}

export type ValidationResult = { ok: true; command: Command } | { ok: false; reason: string };

// ---- hand-rolled schema validation ----

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

/** The optional `for_min` of a lever command: absent, or a positive integer.
 * The CAP is not checked here — the validator does not know the channel; the
 * lever handler applies it with the issuer in hand. */
function forMinField(
  obj: Record<string, unknown>,
): { ok: true; value: number | undefined } | { ok: false; reason: string } {
  const v = obj["for_min"];
  if (v === undefined) return { ok: true, value: undefined };
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
    return {
      ok: false,
      reason: "'for_min' must be a positive integer number of minutes when present",
    };
  }
  return { ok: true, value: v };
}

/** Where a command file came from, as far as validation needs to know: the
 * operator's commands (`OPERATOR_COMMANDS`) validate only from the sealed
 * operator channel. The default is the bounded side. */
export interface ValidateOptions {
  issuer?: CommandIssuer;
}

/** Validate a parsed command file against the whitelist + per-command schema. */
export function validateCommand(raw: unknown, opts: ValidateOptions = {}): ValidationResult {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "command file must be a JSON object" };
  }
  const obj = raw as Record<string, unknown>;
  const name = obj["command"];
  if (typeof name !== "string") return { ok: false, reason: "missing 'command' field" };
  if (isOperatorCommand(name)) {
    if (opts.issuer !== "operator")
      return {
        ok: false,
        reason:
          `command '${name}' is the OPERATOR's alone: it is accepted only from the root-sealed commands/operator/ ` +
          "channel (`qcr lessons off|on|suppress|unsuppress`, `qcr archive run|restore`), never from a session's command file",
      };
    return validateOperatorCommand(name, obj);
  }
  // Legacy-name fold FIRST: an aliased spelling validates against — and parses
  // into — its current name, so downstream (tier table, dispatch, result
  // files) never sees the retired spelling.
  const canonical = LEGACY_COMMAND_NAMES[name] ?? name;
  if (!(COMMAND_WHITELIST as readonly string[]).includes(canonical)) {
    // A retired command gets its own reason: a session spawned on an older
    // prompt can still emit it and should learn why, not just "unknown". The
    // hint is read by a model, so it must not describe a NEEDS_HUMAN park
    // either — no such park exists.
    if (name === "mark-escalation-worthy") {
      return {
        ok: false,
        reason:
          "command 'mark-escalation-worthy' was RETIRED on 2026-08-18: escalation-worthiness no longer exists, " +
          "and the review is never handed to a person — every round decides APPROVE or REQUEST_CHANGES on the merits. " +
          "Use pause-pr to hold one, or flag-owner (formerly flag-owner-legacy — the old name is still accepted) to raise it.",
      };
    }
    return {
      ok: false,
      reason: `command '${name}' is not whitelisted (allowed: ${COMMAND_WHITELIST.join(", ")})`,
    };
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
      return { ok: true, command: { command: "restart-session", pr: pr } };
    }
    case "resolve-terminal-failure": {
      const err = fieldError(obj, ["pr", "incident_id", "command_id", "head_sha"]);
      if (err) return { ok: false, reason: err };
      if (!isPrNumber(obj["pr"])) return { ok: false, reason: "'pr' must be a positive integer" };
      for (const field of ["incident_id", "command_id"]) {
        if (!isNonEmptyString(obj[field]))
          return { ok: false, reason: `'${field}' must be a non-empty string` };
      }
      // An authoritative GitHub 404 can legitimately correspond to a legacy
      // synthetic debt whose stored head is the empty string. Closed PRs are
      // still forced to a non-empty exact match by resolveTerminalFailure().
      if (typeof obj["head_sha"] !== "string")
        return { ok: false, reason: "'head_sha' must be a string" };
      if (obj["incident_id"] !== `review-failure:${obj["command_id"] as string}`) {
        return {
          ok: false,
          reason: "'incident_id' must exactly equal review-failure:<command_id>",
        };
      }
      return {
        ok: true,
        command: {
          command: "resolve-terminal-failure",
          pr: obj["pr"],
          incident_id: obj["incident_id"],
          command_id: obj["command_id"] as string,
          head_sha: obj["head_sha"],
        },
      };
    }
    case "pause-pr": {
      const err = fieldError(obj, ["pr", "reason", "for_min"]);
      if (err) return { ok: false, reason: err };
      if (!isPrNumber(obj["pr"])) return { ok: false, reason: "'pr' must be a positive integer" };
      if (!isNonEmptyString(obj["reason"]))
        return { ok: false, reason: "'reason' must be a non-empty string" };
      const forMin = forMinField(obj);
      if (!forMin.ok) return forMin;
      return {
        ok: true,
        command: {
          command: "pause-pr",
          pr: obj["pr"],
          reason: obj["reason"],
          ...(forMin.value === undefined ? {} : { for_min: forMin.value }),
        },
      };
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
      if (!isNonEmptyString(obj["message"]))
        return { ok: false, reason: "'message' must be a non-empty string" };
      return { ok: true, command: { command: "flag-owner", message: obj["message"] } };
    }
    case "file-improvement-pr": {
      const err = fieldError(obj, ["branch", "title", "body", "slug"]);
      if (err) return { ok: false, reason: err };
      for (const f of ["branch", "title", "body", "slug"]) {
        if (!isNonEmptyString(obj[f]))
          return { ok: false, reason: `'${f}' must be a non-empty string` };
      }
      const slug = obj["slug"] as string;
      if (!SLUG_RE.test(slug)) {
        return {
          ok: false,
          reason: `'slug' must match ${SLUG_RE.source} (it becomes bot/improve-<slug>)`,
        };
      }
      // The session writes `branch` and the daemon hands it to git: only a
      // plain local branch name passes — never an option (`--quiet`), a force
      // refspec (`+wip/x`), a refspec (`a:b`) or a revision expression (`a..b`).
      const branch = obj["branch"] as string;
      if (!isBranchName(branch)) {
        return {
          ok: false,
          reason: `'branch' must be a plain local branch name matching ${BRANCH_RE.source} (at most ${BRANCH_MAX} chars)`,
        };
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
      // `pr` is optional provenance — the PR a deferral's ticket was filed
      // from. The review session files the ticket itself, in the round that
      // deferred; `pr` attributes the filing — and a cap refusal, which then
      // leaves a `deferral_ticket_refused` anomaly — to that PR, so the refusal
      // is visible where the deferral happened. It grants no rights and lifts
      // no cap.
      const err = fieldError(obj, ["title", "body", "pr"]);
      if (err) return { ok: false, reason: err };
      for (const f of ["title", "body"]) {
        if (!isNonEmptyString(obj[f]))
          return { ok: false, reason: `'${f}' must be a non-empty string` };
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
          ...(obj["pr"] === undefined ? {} : { pr: obj["pr"] }),
        },
      };
    }
    case "drain": {
      const err = fieldError(obj, ["on", "for_min"]);
      if (err) return { ok: false, reason: err };
      if (typeof obj["on"] !== "boolean") {
        return {
          ok: false,
          reason: "'on' must be a boolean (true = engage the drain, false = lift it)",
        };
      }
      const forMin = forMinField(obj);
      if (!forMin.ok) return forMin;
      if (forMin.value !== undefined && !obj["on"])
        return { ok: false, reason: "'for_min' only applies with on = true" };
      return {
        ok: true,
        command: {
          command: "drain",
          on: obj["on"],
          ...(forMin.value === undefined ? {} : { for_min: forMin.value }),
        },
      };
    }
    case "retry-thread-decision": {
      const err = fieldError(obj, ["comment_id"]);
      if (err) return { ok: false, reason: err };
      if (!isGitHubId(obj["comment_id"]))
        return { ok: false, reason: "'comment_id' must be a positive safe integer" };
      return {
        ok: true,
        command: { command: "retry-thread-decision", comment_id: obj["comment_id"] },
      };
    }
    case "eod-curation-receipt": {
      const res = validateReceipt(obj);
      if (!res.ok) return res;
      return { ok: true, command: { command: "eod-curation-receipt", ...res.receipt } };
    }
    case "slack_reply": {
      const err = fieldError(obj, ["thread", "text"]);
      if (err) return { ok: false, reason: err };
      // No `channel` field, by construction: the daemon binds every reply to
      // cfg.slack.channel, so posting in the wrong place is unrepresentable.
      if (!isNonEmptyString(obj["thread"]) || !SLACK_TS_RE.test(obj["thread"])) {
        return {
          ok: false,
          reason: "'thread' must be a Slack message ts like \"1712345678.123456\"",
        };
      }
      if (!isNonEmptyString(obj["text"]))
        return { ok: false, reason: "'text' must be a non-empty string" };
      return {
        ok: true,
        command: { command: "slack_reply", thread: obj["thread"], text: obj["text"] },
      };
    }
  }
}

/** The operator commands' strict schemas (the issuer was checked first). */
function validateOperatorCommand(
  name: OperatorCommandName,
  obj: Record<string, unknown>,
): ValidationResult {
  switch (name) {
    case "lessons-off":
    case "lessons-on": {
      const err = fieldError(obj, []);
      if (err) return { ok: false, reason: err };
      return { ok: true, command: { command: name } };
    }
    case "suppress-lesson":
    case "unsuppress-lesson": {
      const err = fieldError(obj, ["uri"]);
      if (err) return { ok: false, reason: err };
      const uri = obj["uri"];
      if (typeof uri !== "string" || !LESSON_URI_RE.test(uri) || uri.includes(".."))
        return {
          ok: false,
          reason:
            "'uri' must be one memory entry's full URI (viking://user/<user>/memories/<area>/<file>.md)",
        };
      return { ok: true, command: { command: name, uri } };
    }
    case "archive-run": {
      const err = fieldError(obj, []);
      if (err) return { ok: false, reason: err };
      return { ok: true, command: { command: "archive-run" } };
    }
    case "archive-restore": {
      const err = fieldError(obj, ["pr"]);
      if (err) return { ok: false, reason: err };
      if (!isPrNumber(obj["pr"])) return { ok: false, reason: "'pr' must be a positive integer" };
      return { ok: true, command: { command: "archive-restore", pr: obj["pr"] } };
    }
  }
}

// ---- tier enforcement ----

/**
 * Commands a Slack turn may run, by tier. The table is data on purpose: adding
 * a command without deciding its tier is then impossible to do by accident.
 *
 * `own` = allowed for tier `author` only when the target PR is in the origin's
 * `authorized_prs` (recomputed by the router from `pr_state.author`, NEVER read
 * out of the inject body).
 *
 * `owner` is the owner's tier (legacy persisted records with the retired tier
 * spelling fold to it on read). `system` is the daemon's own unattended
 * turns (`OriginStore.writeLocal`): it is `true` on every row because a
 * daemon turn with NO origin record already runs unrestricted —
 * `authorizeCommand(_, null)` ⇒ ok, and that null-origin rule is unchanged.
 * The column is the stamped, auditable form of that same
 * standing authority; it never widens anything, and a Slack turn can never
 * reach it (`computeTier` never returns `system`).
 *
 * Nothing here can reach the dry_run flag, a deploy, an approval or anything
 * review-dismissing: those are not commands at all, and this feature adds no
 * GitHub mutation — every write still goes through the MutationGate.
 */
const TIER_TABLE: Record<
  CommandName,
  { anyone: boolean; author: "own" | boolean; owner: boolean; system: boolean }
> = {
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
  // The review session files a deferral's ticket itself, in the round that
  // deferred — there is no author confirmation step. Its command files land
  // in the `commands/` dir with no Slack origin, which already runs at full
  // (system-column) autonomy, so the deferral path needs no widening here. On
  // Slack, `file-issue` is the owner's alone. The day cap, the dedup and the
  // gate all still apply downstream — a tier never lifts a cap.
  "file-issue": { anyone: false, author: false, owner: true, system: true },
  // Not user-tiered: gated by channel binding, thread, caps, cooldown, length.
  slack_reply: { anyone: true, author: true, owner: true, system: true },
  // Deploy-window drain: an operator lever (same standing as restart-session)
  // — it stops the whole board, so it is never author-reachable.
  drain: { anyone: false, author: false, owner: true, system: true },
  "retry-thread-decision": { anyone: false, author: false, owner: true, system: true },
  // The EOD curator's receipt — a daemon (system) turn's, or the
  // owner's; never a Slack author's or anyone's.
  "eod-curation-receipt": { anyone: false, author: false, owner: true, system: true },
};

/** Target PR of a command, when it has one. */
function targetPr(command: Command): number | null {
  if (command.command === "restart-session")
    return typeof command.pr === "number" ? command.pr : null;
  return "pr" in command && typeof command.pr === "number" ? command.pr : null;
}

export type AuthorizationResult = { ok: true } | { ok: false; reason: string };

/**
 * May this command run on behalf of `origin`?
 *
 * `origin === null` means "no Slack turn is live" — the command came from the
 * daemon itself (EOD sweep, anomaly wake) or from the owner at the tmux pane,
 * and keeps full autonomy (the same rights the `system` tier stamps
 * explicitly). A caller that must fail closed (the Slack command directory)
 * checks for a missing origin BEFORE calling this.
 *
 * Every rejection reason starts with `tier: ` so the overseer — and the
 * `command_rejected` event stream — can tell a rights refusal from a cap.
 */
export function authorizeCommand(
  command: Command,
  origin: OriginRecord | null,
): AuthorizationResult {
  if (isOperatorCommand(command.command))
    return {
      ok: false,
      reason: `tier: '${command.command}' is the operator's alone (commands/operator/), never a Slack turn's`,
    };
  if (origin === null) return { ok: true };
  const row = TIER_TABLE[command.command];
  const pr = targetPr(command);
  switch (origin.tier) {
    case "owner":
      return row.owner
        ? { ok: true }
        : { ok: false, reason: `tier: '${command.command}' is not available` };
    case "system":
      return row.system
        ? { ok: true }
        : { ok: false, reason: `tier: '${command.command}' is not available` };
    case "author": {
      if (row.author === true) return { ok: true };
      if (row.author === false) {
        return {
          ok: false,
          reason: `tier: '${command.command}' requires tier owner (this turn is tier author)`,
        };
      }
      if (pr === null)
        return {
          ok: false,
          reason: `tier: '${command.command}' needs a PR number to check ownership`,
        };
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
        : {
            ok: false,
            reason: `tier: '${command.command}' is not available at tier ${origin.tier}`,
          };
  }
}

function normalize(outcome: FileOutcome | void): FileOutcome {
  return outcome === undefined || outcome === null ? { ok: true } : outcome;
}

/** Dispatch a validated command to the injected handlers. */
export async function executeCommand(
  command: Command,
  deps: CommandDeps,
  // A direct call with no context is a SESSION's: the bounded side is the
  // default, and only the operator watcher ever stamps the other one.
  ctx: CommandContext = { file: "", issuer: "session" },
): Promise<FileOutcome> {
  switch (command.command) {
    case "rerun-round":
      return normalize(await deps.rerunRound(command.pr));
    case "restart-session":
      return normalize(await deps.restartSession(command.pr));
    case "resolve-terminal-failure":
      return normalize(
        await deps.resolveTerminalFailure({
          pr: command.pr,
          incident_id: command.incident_id,
          command_id: command.command_id,
          head_sha: command.head_sha,
        }),
      );
    case "pause-pr":
      return normalize(await deps.pausePr(command.pr, command.reason, ctx.issuer, command.for_min));
    case "resume-pr":
      return normalize(await deps.resumePr(command.pr, ctx.issuer));
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
      if (!deps.slackReply)
        return { ok: false, reason: "slack_reply is not wired (Slack is disabled)" };
      return normalize(
        await deps.slackReply({ thread: command.thread, text: command.text, file: ctx.file }),
      );
    }
    case "drain": {
      if (!deps.drain) return { ok: false, reason: "drain is not wired on this daemon" };
      return normalize(await deps.drain(command.on, ctx.issuer, command.for_min));
    }
    case "retry-thread-decision": {
      if (!deps.retryThreadDecision)
        return { ok: false, reason: "retry-thread-decision is not wired on this daemon" };
      return normalize(await deps.retryThreadDecision(command.comment_id));
    }
    case "eod-curation-receipt": {
      if (!deps.curationReceipt)
        return {
          ok: false,
          reason: "eod-curation-receipt is not wired on this daemon (no learner)",
        };
      return normalize(
        await deps.curationReceipt({ day: command.day, decisions: command.decisions }),
      );
    }
    case "lessons-off":
    case "lessons-on":
    case "suppress-lesson":
    case "unsuppress-lesson": {
      // The belt behind validation's brace: whoever reached this function,
      // only an operator-stamped context may flip the kill switch.
      if (ctx.issuer !== "operator")
        return {
          ok: false,
          reason: `'${command.command}' is the operator's alone — refused for issuer '${ctx.issuer}'`,
        };
      if (!deps.lessonSwitch)
        return { ok: false, reason: `${command.command} is not wired on this daemon` };
      const change: LessonSwitchChange =
        command.command === "lessons-off"
          ? { action: "off" }
          : command.command === "lessons-on"
            ? { action: "on" }
            : command.command === "suppress-lesson"
              ? { action: "suppress", uri: command.uri }
              : { action: "unsuppress", uri: command.uri };
      return normalize(await deps.lessonSwitch(change, ctx.file));
    }
    case "archive-run":
    case "archive-restore": {
      // The belt behind validation's brace, as for the kill switch.
      if (ctx.issuer !== "operator")
        return {
          ok: false,
          reason: `'${command.command}' is the operator's alone — refused for issuer '${ctx.issuer}'`,
        };
      if (command.command === "archive-run") {
        if (!deps.archiveRun)
          return { ok: false, reason: "archive-run is not wired on this daemon" };
        return normalize(await deps.archiveRun(ctx.file));
      }
      if (!deps.archiveRestore)
        return { ok: false, reason: "archive-restore is not wired on this daemon" };
      return normalize(await deps.archiveRestore(command.pr, ctx.file));
    }
  }
}

// ---- the watcher ----

/**
 * Which command directory this watcher serves, and how to find the live Slack
 * origin — two directories, one gate.
 *
 *   `local`  — the `commands/` dir. Untiered, so EOD sweeps, anomaly wakes and
 *              the owner at the tmux pane keep full autonomy. The one BELT:
 *              when the turn being served was CAUSED by a non-owner Slack
 *              message, this dir refuses — the overseer
 *              wrote to the wrong place mid-turn, and a tier-checked command
 *              must not slip past by choosing a filename.
 *   `slack`  — the tier-checked `commands/slack/` dir. No live origin ⇒ DENY.
 *
 * Omit the gate entirely and the directory is served with no tier check.
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

// ---- the operator seal ----

/** What a path IS, as `lstat` sees it — a symlink is reported as itself,
 * never as what it points at. */
export type PathKind = "dir" | "file" | "symlink" | "other";

export interface PathIdentity {
  uid: number;
  gid: number;
  /** Permission bits only (`& 0o7777`). */
  mode: number;
  kind: PathKind;
}

/** What the watcher can learn about a path's owner, mode and kind. Injected
 * so the sealed case — a ROOT-owned directory — is testable by a process that
 * is not root; the real one is `processOperatorSeal()`. */
export interface OperatorSeal {
  /** The daemon's effective uid — the uid every pi session runs as too. */
  euid: number;
  /** The daemon's supplementary groups (for the group-write bit). */
  gids: readonly number[];
  /** `null` when the path does not exist. */
  stat(path: string): PathIdentity | null;
}

export function processOperatorSeal(): OperatorSeal {
  return {
    euid: process.geteuid?.() ?? -1,
    gids: process.getgroups?.() ?? [],
    stat(path) {
      try {
        // lstat, not stat: the seal is a claim about the path the operator's
        // tools wrote, and a symlink planted at that path must show as one.
        const s = lstatSync(path);
        const kind: PathKind = s.isSymbolicLink()
          ? "symlink"
          : s.isDirectory()
            ? "dir"
            : s.isFile()
              ? "file"
              : "other";
        return { uid: s.uid, gid: s.gid, mode: s.mode & 0o7777, kind };
      } catch {
        return null;
      }
    },
  };
}

/** Could a process with `seal`'s identity write this path? */
function writableBy(seal: OperatorSeal, s: PathIdentity): boolean {
  if (s.uid === seal.euid) return true;
  if ((s.mode & 0o002) !== 0) return true;
  return seal.gids.includes(s.gid) && (s.mode & 0o020) !== 0;
}

export type SealVerdict = { sealed: true } | { sealed: false; reason: string };

/**
 * Is `file` in `dir` the OPERATOR's? It is exactly when the directory is a
 * real directory and the file a real file, and neither could have been
 * written by the daemon's own identity — the identity every session shares.
 * Anything else (a symlink standing in for the directory — the parent
 * `commands/` is the daemon's, so a session can plant one — the directory
 * made by the daemon's uid, a group- or world-writable mode, a file the
 * daemon could edit) is not a seal, and the verdict says which.
 */
export function operatorSealVerdict(seal: OperatorSeal, dir: string, file: string): SealVerdict {
  const d = seal.stat(dir);
  if (!d) return { sealed: false, reason: "operator directory missing" };
  if (d.kind !== "dir")
    return { sealed: false, reason: `operator directory is a ${d.kind}, not a directory` };
  if (writableBy(seal, d))
    return {
      sealed: false,
      reason: `operator directory is writable by uid ${seal.euid} (owner ${d.uid}, mode ${d.mode.toString(8)})`,
    };
  const f = seal.stat(file);
  if (!f) return { sealed: false, reason: "command file vanished" };
  if (f.kind !== "file")
    return { sealed: false, reason: `command file is a ${f.kind}, not a regular file` };
  if (writableBy(seal, f))
    return {
      sealed: false,
      reason: `command file is writable by uid ${seal.euid} (owner ${f.uid}, mode ${f.mode.toString(8)})`,
    };
  return { sealed: true };
}

/**
 * The identity of one version of an operator command file — the key the
 * handled-ledger is written under. The operator's directory is not the
 * daemon's to archive from, so "handled" has to be remembered; remembering the
 * name alone would make every re-used name a one-shot, silently ignoring a
 * second write under the same name. Inode + mtime + size change on every
 * rewrite that matters — the operator's tools land files by tmp+mv, a new
 * inode each time — and stay put across the sweeps that re-see an unchanged
 * file. `null` when the file is gone.
 */
export function operatorCommandVersion(path: string): string | null {
  try {
    return commandVersionOf(path, statSync(path, { bigint: true }));
  } catch {
    return null;
  }
}

function commandVersionOf(path: string, s: { ino: bigint; mtimeNs: bigint; size: bigint }): string {
  return `${basename(path)}:${s.ino}:${s.mtimeNs}:${s.size}`;
}

/** `dev:ino` of the object AT `path` (a symlink as itself), `null` when absent. */
function fileIdentityAt(path: string): string | null {
  try {
    const s = lstatSync(path, { bigint: true });
    return `${s.dev}:${s.ino}`;
  } catch {
    return null;
  }
}

/** The inode at `path` — what `fs.watch` binds to — or `null` when nothing is there. */
function inodeAt(path: string): bigint | null {
  try {
    return statSync(path, { bigint: true }).ino;
  } catch {
    return null;
  }
}

export interface CommandWatcherOptions {
  /** The directory served. Session dirs: results land in <dir>/results and
   * handled files move to <dir>/processed. */
  dir: string;
  /** Tier enforcement for this directory. Absent ⇒ no tier check. */
  tier?: CommandTierGate;
  /**
   * Serve `dir` as the operator's directory. The watcher then never
   * creates it (a daemon-made directory would carry the daemon's uid and be
   * no seal), never renames out of it (it cannot), records handled files in
   * the store instead, stamps `issuer: "operator"` only on files the seal
   * vouches for, and writes results beside the session dir's — into
   * `<parent>/results` — so the operator's clients read them from one place.
   */
  operator?: OperatorSeal;
  deps: CommandDeps;
  store: StateStore;
  now?: () => Date;
  /** Partial-write tolerance: re-read a file that fails to parse. */
  parseAttempts?: number;
  parseRetryMs?: number;
  /** Operator dir only: re-sweep (and attach to a directory that appeared
   * after start) this often. 0 disables the timer. Default 15 s. */
  sweepIntervalMs?: number;
  log?: (line: string) => void;
}

export interface CommandResultFile extends FileOutcome {
  command: string | null;
  file: string;
  handled_at: string;
  /** Who the watcher decided the writer was. */
  issuer: CommandIssuer;
}

export class CommandWatcher {
  private readonly dir: string;
  private readonly resultsDir: string;
  private readonly processedDir: string;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  private watcher: FSWatcher | null = null;
  /** The inode `watcher` is bound to — `fs.watch` follows the inode, not the path. */
  private watchedIno: bigint | null = null;
  private parentWatcher: FSWatcher | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private readonly inFlight = new Set<string>();
  /** Serialises handling so two file events can't race the same caps. */
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly opts: CommandWatcherOptions) {
    this.dir = opts.dir;
    const resultsRoot = opts.operator ? dirname(opts.dir) : opts.dir;
    this.resultsDir = join(resultsRoot, "results");
    this.processedDir = join(opts.dir, "processed");
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? ((line) => console.error(line));
  }

  private ensureDirs(): void {
    mkdirSync(this.resultsDir, { recursive: true });
    if (this.opts.operator) return; // never ours to create — see `operator`
    mkdirSync(this.dir, { recursive: true });
    mkdirSync(this.processedDir, { recursive: true });
  }

  /** Startup sweep + fs.watch. Returns once the initial sweep has completed.
   * The operator directory may not exist yet (the operator's first write
   * creates it): then the parent is watched for it to appear, and the sweep
   * timer re-tries the attach as a belt. */
  async start(): Promise<void> {
    this.ensureDirs();
    // Watch FIRST, then sweep on the same queue the watch feeds: the sweep
    // snapshots the directory and then awaits each handler, so a file a live
    // session writes after the snapshot must already have a watcher to see
    // it — a session dir has no periodic sweep, so a file missed here would
    // wait for a restart. A file seen by both is handled once: the second
    // visit finds it archived.
    if (!this.opts.operator) this.attachDirWatch();
    const initial = this.queue.then(() => this.sweep());
    this.queue = initial.catch((err) => this.log(`[commands] sweep failed: ${String(err)}`));
    await initial;
    const interval = this.opts.sweepIntervalMs ?? 15_000;
    if (this.opts.operator && interval > 0) {
      this.sweepTimer = setInterval(() => void this.enqueueSweep(), interval);
      this.sweepTimer.unref?.();
    }
  }

  /** Watch the served directory when it exists. True once watching. */
  private attachDirWatch(): boolean {
    if (this.watcher) return true;
    const ino = inodeAt(this.dir);
    if (ino === null) return false;
    this.watcher = watch(this.dir, (_event, filename) => {
      if (!filename) {
        void this.enqueueSweep();
        return;
      }
      const name = filename.toString();
      if (!name.endsWith(".json")) return;
      void this.enqueue(join(this.dir, name));
    });
    this.watchedIno = ino;
    this.parentWatcher?.close();
    this.parentWatcher = null;
    return true;
  }

  private detachDirWatch(): void {
    this.watcher?.close();
    this.watcher = null;
    this.watchedIno = null;
  }

  /**
   * Operator dir only: keep the watch on whatever directory is AT the path
   * now. `fs.watch` binds to an inode, and the parent `commands/` is the
   * daemon's — so a session can rename the sealed directory away and put
   * another in its place, and a watcher left on the old inode would see none
   * of the new one's files. Every sweep re-checks; a directory that is gone
   * or replaced drops the old watch, a present one is attached, and an absent
   * one leaves the parent watched for it to appear.
   */
  private syncDirWatch(): void {
    if (this.watcher && inodeAt(this.dir) !== this.watchedIno) this.detachDirWatch();
    if (!this.attachDirWatch() && !this.parentWatcher) {
      this.parentWatcher = watch(dirname(this.dir), (_event, filename) => {
        if (filename?.toString() === basename(this.dir)) void this.enqueueSweep();
      });
    }
  }

  stop(): void {
    this.detachDirWatch();
    this.parentWatcher?.close();
    this.parentWatcher = null;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  /** Handle every pending <dir>/*.json once. */
  async sweep(): Promise<void> {
    this.ensureDirs();
    if (this.opts.operator) this.syncDirWatch();
    if (!existsSync(this.dir)) return;
    const names = readdirSync(this.dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".json"))
      .map((e) => e.name)
      .sort();
    for (const name of names) await this.handleFile(join(this.dir, name));
  }

  private enqueueSweep(): Promise<void> {
    this.queue = this.queue
      .then(() => this.sweep())
      .catch((err) => this.log(`[commands] sweep failed: ${String(err)}`));
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

  /**
   * Read and parse one command file. `identity` names the file object the
   * parsed bytes came from (`dev:ino` of the open descriptor) so the operator
   * seal can be checked against THOSE bytes rather than against whatever
   * stands at the path a moment earlier or later (the parent `commands/` is
   * the daemon's, so a session can swap the directory between two syscalls).
   * `version` is the handled-ledger key of those same bytes
   * (`operatorCommandVersion`'s), so a file replaced during a parse retry is
   * recorded as the version that ran, not the one first seen. A failed read
   * still names the version it last opened, when it opened one. The
   * operator directory is opened without following a symlink.
   */
  private async readCommandFile(
    path: string,
  ): Promise<
    | { ok: true; value: unknown; identity: string; version: string }
    | { ok: false; reason: string; version: string | null }
  > {
    const attempts = this.opts.parseAttempts ?? 3;
    const delay = this.opts.parseRetryMs ?? 40;
    const flags = this.opts.operator
      ? fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW
      : fsConstants.O_RDONLY;
    let lastError = "unreadable";
    let lastVersion: string | null = null;
    for (let i = 0; i < attempts; i++) {
      if (!existsSync(path)) return { ok: false, reason: "file disappeared", version: null };
      try {
        const fd = openSync(path, flags);
        let text: string;
        let identity: string;
        let version: string;
        try {
          const st = fstatSync(fd, { bigint: true });
          identity = `${st.dev}:${st.ino}`;
          version = commandVersionOf(path, st);
          lastVersion = version;
          text = readFileSync(fd, "utf8");
        } finally {
          closeSync(fd);
        }
        if (text.trim().length === 0) {
          lastError = "empty file";
        } else {
          return { ok: true, value: JSON.parse(text) as unknown, identity, version };
        }
      } catch (err) {
        // A partially-written file is expected transiently — retry before rejecting.
        lastError = (err as Error).message;
      }
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, delay));
    }
    return { ok: false, reason: `malformed JSON: ${lastError}`, version: lastVersion };
  }

  /**
   * Who wrote this file, as far as the daemon can PROVE it. A session
   * directory's writer is a session. The operator directory's writer is the
   * operator only when the seal holds; a file there without it is served as a
   * session's — loudly, with the reason in the ledger — so an unsealed channel
   * degrades to the bounded side and never to the unbounded one.
   */
  private issuerFor(path: string, readIdentity: string | null): CommandIssuer {
    const seal = this.opts.operator;
    if (!seal) return "session";
    // Checked AFTER the read, and then bound to it: the file at the path must
    // still be the very object whose bytes were parsed. Otherwise a directory
    // swapped in for the read and swapped back for the seal check would lend
    // its bytes the operator's authority.
    let verdict = operatorSealVerdict(seal, this.dir, path);
    if (verdict.sealed && readIdentity !== null && fileIdentityAt(path) !== readIdentity)
      verdict = { sealed: false, reason: "command file replaced while it was read" };
    if (verdict.sealed) return "operator";
    this.opts.store.logEvent("operator_channel_unsealed", null, {
      file: basename(path),
      reason: verdict.reason,
    });
    this.log(
      `[commands] ${basename(path)}: operator channel NOT sealed (${verdict.reason}) — served as a session's command`,
    );
    return "session";
  }

  /** Validate + execute one command file, writing its result file. */
  async handleFile(path: string): Promise<CommandResultFile | null> {
    const name = basename(path, ".json");
    if (this.inFlight.has(path)) return null;
    if (!existsSync(path)) return null;
    // An operator file cannot be archived away (the directory is not ours to
    // write), so the store remembers what was handled across restarts — by
    // file VERSION, so a name written again with new content is a new command
    // and an unchanged file re-seen by the sweep is not.
    const seen = this.opts.operator ? operatorCommandVersion(path) : null;
    if (this.opts.operator) {
      if (seen === null) return null;
      if (this.opts.store.operatorCommandHandled(seen)) return null;
    }
    this.inFlight.add(path);
    try {
      this.ensureDirs();
      const read = await this.readCommandFile(path);
      if (!read.ok && read.reason === "file disappeared") return null;
      // The ledger records the version whose bytes were parsed — a file
      // replaced during a parse retry is that new version.
      const version = this.opts.operator ? (read.version ?? seen) : null;
      if (version !== null && version !== seen && this.opts.store.operatorCommandHandled(version))
        return null;
      const issuer = this.issuerFor(path, read.ok ? read.identity : null);
      if (!read.ok) {
        return this.finish(
          path,
          name,
          version,
          read.version,
          null,
          issuer,
          { ok: false, reason: read.reason },
          true,
        );
      }
      const validation = validateCommand(read.value, { issuer });
      if (!validation.ok) {
        const attempted = (read.value as { command?: unknown } | null)?.command;
        return this.finish(
          path,
          name,
          version,
          read.version,
          typeof attempted === "string" ? attempted : null,
          issuer,
          { ok: false, reason: validation.reason },
          true,
        );
      }
      // The Slack belt stops a SESSION mis-filing; a sealed operator file is
      // the human at the terminal and never rides a Slack turn. An UNSEALED
      // operator file is a session's and gets the belt like any other.
      const denial = issuer === "operator" ? null : this.tierCheck(validation.command);
      if (denial)
        return this.finish(
          path,
          name,
          version,
          read.version,
          validation.command.command,
          issuer,
          { ok: false, reason: denial },
          true,
        );
      let outcome: FileOutcome;
      try {
        outcome = await executeCommand(validation.command, this.opts.deps, { file: name, issuer });
      } catch (err) {
        outcome = { ok: false, reason: `handler threw: ${(err as Error).message}` };
      }
      return this.finish(
        path,
        name,
        version,
        read.version,
        validation.command.command,
        issuer,
        outcome,
        !outcome.ok,
      );
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
    // Local dir: only the belt applies. It fires on CAUSE, not on recency —
    // a daemon-caused turn (`source: "local"`) always passes, and a Slack-caused
    // one from a non-owner user always refuses, however old the record is.
    // (`parseOriginRecord` folds the retired tier spelling to "owner", so this
    // comparison only ever sees the current vocabulary; a Slack origin can
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
    /** The operator file's version key (`operatorCommandVersion`); null for a session dir. */
    version: string | null,
    /** The version (`operatorCommandVersion`'s key) of the bytes that were
     * read; null when no file was opened. */
    readVersion: string | null,
    command: string | null,
    issuer: CommandIssuer,
    outcome: FileOutcome,
    loud: boolean,
  ): CommandResultFile {
    const result: CommandResultFile = {
      ...outcome,
      command,
      file: basename(path),
      handled_at: this.now().toISOString(),
      issuer,
    };
    writeFileSync(join(this.resultsDir, `${name}.result.json`), JSON.stringify(result, null, 2));
    if (outcome.ok) {
      this.opts.store.logEvent("command_executed", null, { command, file: result.file, issuer });
    } else {
      this.opts.store.logEvent("command_rejected", null, {
        command,
        file: result.file,
        issuer,
        reason: outcome.reason,
      });
    }
    if (loud)
      this.log(
        `[commands] REJECTED ${result.file} (${command ?? "?"}): ${outcome.reason ?? "unknown reason"}`,
      );
    // Make sure a daemon restart cannot re-execute the file: session dirs
    // archive it into processed/; the operator dir is not writable by the
    // daemon, so the store keeps the ledger instead, keyed by this version.
    if (version !== null) {
      this.opts.store.markOperatorCommandHandled(version, result.file);
    } else {
      const atPath = operatorCommandVersion(path);
      if (readVersion !== null && atPath !== null && atPath !== readVersion) {
        // A newer command took this name while this one ran. It is not the
        // file this result describes, so it is not archived under it: it is
        // queued to run next (the watch event it raised found this one in
        // flight, and a session dir has no periodic sweep to find it later).
        this.log(`[commands] ${result.file} was replaced while it ran — running the new one next`);
        void this.enqueue(path);
      } else {
        try {
          renameSync(path, join(this.processedDir, `${name}.json`));
        } catch {
          /* best effort — a vanished file is fine */
        }
      }
    }
    return result;
  }
}

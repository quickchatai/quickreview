// The daemon's post ops on the worker socket (P7.2): `post.review`,
// `post.approval` and `post.reply`.
//
// A host (a round worker, an answer worker, a debug pi) and the post shims it
// runs hold no GitHub credential. A shim sends the daemon the PATH of the
// result file the host wrote inside the PR's own directory; the daemon
// validates the path, reads the file and assembles the review ITSELF. It then
// posts through the one `MutationGate` with the App minter (the adapter), under
// the round's receipt and outbox job (`PostingJournal`), exactly as the shell
// route does for a session. A host can only point at a file: it cannot hand the
// daemon a payload, so there is nothing for the daemon to detect as "not
// assembled by the shim".
//
// The checks the socket server already made (live capability, active command,
// current generation, the PR it names) are not repeated here. What this adds:
//   - a PR under a TAKEOVER lease can post nothing;
//   - an ANSWER worker posts only when the operator's message carried `may_post`
//     (P8.17); a debug-round lease may post (D38);
//   - the body names the command's own PR (`requirePr`) and, for a keyed round,
//     the command's own round and head;
//   - a result file must be a plain file inside one of that PR's directories.
//
// The posting guards (merged/closed, head drift, no new evidence, the human
// approval downgrade) are installed on the gate and bind here as on any route.
// The two the shell route enforces BEFORE the gate (a required pass that failed
// and never completed; an APPROVE over red CI, which the shell route REFUSES
// where the gate would soften it) are enforced here before the gate too, so the
// IPC path posts what the shell path posts.
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, sep } from "node:path";
import { ciBlocksApproval, classifyCi } from "./cigate.js";
import type { Config, GuardsConfig } from "./config.js";
import type { GateResult } from "./gate.js";
import { GitHubRequestError, type GitHubAdapter } from "./github.js";
import { IpcError } from "./ipc/protocol.js";
import type { OpHandler, RequestContext } from "./ipc/server.js";
import type { IpcServer } from "./ipc/server.js";
import {
  JournalError,
  type JobPayload,
  type PostingJournal,
  type ReviewEvent,
} from "./posting-journal.js";
import { postingMarker, roundPostingKey } from "./posting-receipt.js";
import {
  approvalActions,
  submitReview,
  type AssembledReview,
  type InlineComment,
  type ReviewPayload,
} from "./posting.js";
import { describeGap, parsePlan, readRoundProgress, requiredPassGap } from "./requiredpasses.js";
import { snapshotMark } from "./standing-review.js";
import type { StateStore } from "./state.js";

/** The most a result file may hold. A review body is far below this. */
export const MAX_RESULT_FILE_BYTES = 1024 * 1024;

/** The slice of the daemon's adapter the ops use. `gate` is the one gate the
 * adapter posts through; its dry-run state decides the receipt's mode. */
export type PostAdapter = Pick<
  GitHubAdapter,
  | "getPr"
  | "listChecks"
  | "listReviewsFull"
  | "createReview"
  | "removeLabel"
  | "deleteTeamReviewRequest"
  | "createReviewCommentReply"
> & { readonly gate: Pick<GitHubAdapter["gate"], "isDryRun"> };

export type PostStore = Pick<
  StateStore,
  "registerBotComment" | "logEvent" | "reviewedHead" | "roundsFor"
>;

/** A directory a PR's result files may live in. With `prefix`, only files whose
 * name starts with it (`pr-<n>-`): a shared dir holds every PR's files. */
export interface ResultDir {
  dir: string;
  prefix?: string;
}

/** The round a command is posting for, when it has one. */
export interface PostRound {
  round_no: number;
  /** The head the round reviewed: what its posting key names. */
  head_sha: string;
}

export interface PostOpsDeps {
  /** The sandbox root: `state/`, `verdict/` and the round-progress dir live under it. */
  root: string;
  adapter: PostAdapter;
  store: PostStore;
  journal: PostingJournal;
  cfg: {
    github: Pick<Config["github"], "repo" | "trigger_label">;
    guards: GuardsConfig;
  };
  /** The bot's review identities, to find a review by its marker. */
  botLogins: readonly string[];
  /** The round this command posts for, or null for a command with no round (an
   * answer worker). A null round posts without a receipt, as an unkeyed shell
   * round does. */
  roundOf(commandId: string, pr: number): PostRound | null;
  /** Where this PR's result files may live. Default: `<root>/state` and
   * `<root>/verdict` (only `pr-<n>-*` files) and the command's own dir
   * `<root>/state/commands/<command id>/` (the worker's, P8.3). */
  resultDirs?(pr: number, commandId: string): ResultDir[];
  log?: (msg: string, extra?: unknown) => void;
}

/** What a post op answers with. The shim prints `lines` and exits 0. */
export interface PostOutcome {
  status: "posted" | "dryrun" | "deferred" | "already_confirmed";
  lines: string[];
  review_url?: string;
  review_id?: number;
  dryrun_file?: string;
}

/** The `roundOf` of a daemon that hosts workers (P8.7): the round a command
 * posts for is its own session_commands row's. Only a `round` command has one;
 * an answer worker, a takeover or a debug command posts unkeyed. `headOf` is the
 * head the round reviewed (the order's `head_sha`, which its posting key names).
 * A round whose head is unknown is refused, never posted unkeyed: a keyed round
 * that lost its receipt would post twice. */
export function commandRoundOf(
  store: Pick<StateStore, "getSessionCommand">,
  headOf: (pr: number, roundNo: number) => string | undefined,
): PostOpsDeps["roundOf"] {
  return (commandId, pr) => {
    const row = store.getSessionCommand(commandId);
    if (!row || row.pr !== pr || row.kind !== "round" || row.round_no === null) return null;
    const head = headOf(pr, row.round_no);
    if (!head)
      throw new IpcError(
        "blocked",
        `the head round ${row.round_no} reviewed is unknown: nothing was posted`,
      );
    return { round_no: row.round_no, head_sha: head };
  };
}

export function defaultResultDirs(root: string, pr: number, commandId: string): ResultDir[] {
  const prefix = `pr-${pr}-`;
  const dirs: ResultDir[] = [
    { dir: join(root, "state"), prefix },
    { dir: join(root, "verdict"), prefix },
  ];
  // Command ids allow dots; a dot-only id would name `..`.
  if (!/^\.+$/.test(commandId)) dirs.push({ dir: join(root, "state", "commands", commandId) });
  return dirs;
}

/** A review body as post-review.sh reads it: Python text mode turns CRLF and a lone CR into LF. */
export const reviewBodyText = (text: string): string => text.replace(/\r\n?/g, "\n");

/** An approval body as approve-pr.sh reads it: `$(cat file)` strips every trailing newline. */
export const approvalBodyText = (text: string): string => text.replace(/\n+$/, "");

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

function bodyOf(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) throw new IpcError("bad_request", "the request body must be an object");
  return body;
}

/** The checks every post op runs first, in this order. */
function authorize(ctx: RequestContext, body: unknown): Record<string, unknown> {
  const b = bodyOf(body);
  ctx.requirePr(b.pr);
  if (ctx.lease === "takeover")
    throw new IpcError("lease_takeover", "the PR is under a takeover lease: nothing may be posted");
  if (ctx.answer && !ctx.mayPost)
    throw new IpcError(
      "may_post_required",
      "this answer worker's message did not carry may_post: nothing may be posted",
    );
  return b;
}

/** Read a result file the host named. It must be a plain (not symlinked) file,
 * inside one of the PR's directories, and small. */
export function readResultFile(deps: PostOpsDeps, ctx: RequestContext, raw: unknown): string {
  if (typeof raw !== "string" || raw === "" || raw.length > 4096 || raw.includes("\0"))
    throw new IpcError("bad_request", "a result file path must be a non-empty string");
  if (!isAbsolute(raw)) throw new IpcError("bad_path", "a result file path must be absolute");
  const dirs = (deps.resultDirs ?? ((pr, id) => defaultResultDirs(deps.root, pr, id)))(
    ctx.pr,
    ctx.commandId,
  );
  let real: string;
  try {
    if (lstatSync(raw).isSymbolicLink())
      throw new IpcError("bad_path", "a result file may not be a symbolic link");
    real = realpathSync(raw);
  } catch (e) {
    if (e instanceof IpcError) throw e;
    throw new IpcError("bad_path", "the result file cannot be read");
  }
  const base = real.slice(real.lastIndexOf(sep) + 1);
  const inside = dirs.some((d) => {
    let dir: string;
    try {
      dir = realpathSync(d.dir);
    } catch {
      return false; // that dir does not exist here
    }
    return real.startsWith(dir + sep) && (d.prefix === undefined || base.startsWith(d.prefix));
  });
  if (!inside)
    throw new IpcError("bad_path", "the result file is outside this PR's own directories");
  let fd = -1;
  try {
    fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = fstatSync(fd);
    if (!st.isFile()) throw new IpcError("bad_path", "the result file is not a plain file");
    if (st.size > MAX_RESULT_FILE_BYTES)
      throw new IpcError("bad_path", `the result file is over ${MAX_RESULT_FILE_BYTES} bytes`);
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < buf.length) {
      const n = readSync(fd, buf, off, buf.length - off, off);
      if (n === 0) break;
      off += n;
    }
    return buf.subarray(0, off).toString("utf8");
  } catch (e) {
    if (e instanceof IpcError) throw e;
    throw new IpcError("bad_path", "the result file cannot be read");
  } finally {
    if (fd >= 0) closeSync(fd);
  }
}

/** The inline comments file, validated as the shell route's payload builder does. */
export function parseComments(text: string): InlineComment[] {
  let list: unknown;
  try {
    list = JSON.parse(text);
  } catch {
    throw new IpcError("bad_request", "comments file must be a JSON array");
  }
  if (!Array.isArray(list)) throw new IpcError("bad_request", "comments file must be a JSON array");
  const sides = ["RIGHT", "LEFT"];
  return list.map((c: unknown, i): InlineComment => {
    const x = c as Record<string, unknown> | null;
    if (
      !isRecord(x) ||
      typeof x.path !== "string" ||
      !Number.isInteger(x.line) ||
      (x.line as number) < 1 ||
      typeof x.body !== "string"
    )
      throw new IpcError("bad_request", `comment ${i}: need path(str), line(int>0), body(str)`);
    if ("side" in x && !sides.includes(x.side as string))
      throw new IpcError("bad_request", `comment ${i}: side must be RIGHT or LEFT`);
    if (
      "start_line" in x &&
      (!Number.isInteger(x.start_line) ||
        (x.start_line as number) < 1 ||
        (x.start_line as number) > (x.line as number))
    )
      throw new IpcError("bad_request", "invalid multiline anchor");
    if ("start_side" in x && (!("start_line" in x) || !sides.includes(x.start_side as string)))
      throw new IpcError("bad_request", "invalid multiline side");
    const keep: Record<string, unknown> = {};
    for (const k of ["path", "line", "side", "start_line", "start_side", "body"])
      if (k in x) keep[k] = x[k];
    return keep as unknown as InlineComment;
  });
}

interface Keyed {
  round: number;
  head: string;
  key: string;
}

/** The round's posting identity, or null for a command with no round. A request
 * may restate the round, head and key (the shim passes its env); each must be
 * the command's own. */
function keyedRound(
  deps: PostOpsDeps,
  ctx: RequestContext,
  b: Record<string, unknown>,
): Keyed | null {
  const rd = deps.roundOf(ctx.commandId, ctx.pr);
  const claims = [b.round_no, b.expected_head, b.posting_key];
  if (rd === null) {
    if (claims.some((c) => c !== undefined))
      throw new IpcError("bad_request", "this command has no posting round to key a post by");
    return null;
  }
  const head = rd.head_sha.toLowerCase();
  const key = roundPostingKey(ctx.pr, rd.round_no, head);
  if (b.round_no !== undefined && b.round_no !== rd.round_no)
    throw new IpcError("bad_request", "round_no is not this command's round");
  if (
    b.expected_head !== undefined &&
    (typeof b.expected_head !== "string" || b.expected_head.toLowerCase() !== head)
  )
    throw new IpcError("bad_request", "expected_head is not the head this round reviewed");
  if (b.posting_key !== undefined && b.posting_key !== key)
    throw new IpcError("bad_request", `posting_key mismatch (expected ${key})`);
  return { round: rd.round_no, head, key };
}

/** Whether `err` says GitHub never answered, or answered 5xx: the post may or
 * may not have landed. A 4xx, or the gate's own refusal, is a plain failure. */
function unanswered(err: unknown): boolean {
  if (err instanceof GitHubRequestError) return err.status >= 500;
  if (!(err instanceof Error)) return false;
  if (err.message.startsWith("gate:")) return false;
  return (
    err.name === "TimeoutError" ||
    err.name === "AbortError" ||
    (err instanceof TypeError && /fetch failed/i.test(err.message))
  );
}

/** Never let a refusal reach the wire with a path or a token in it. */
function describeFailure(err: unknown): string {
  if (err instanceof GitHubRequestError)
    return `GitHub answered ${err.status} (${err.method} ${err.path})`;
  return err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
}

class PostOps {
  constructor(private readonly d: PostOpsDeps) {}

  private log(msg: string, extra?: unknown): void {
    this.d.log?.(msg, extra);
  }

  private audit(ctx: RequestContext, op: string, outcome: string): void {
    this.d.store.logEvent("ipc_post", ctx.pr, {
      op,
      command_id: ctx.commandId,
      lease: ctx.lease,
      outcome,
    });
  }

  /** A required pass that failed and never completed: post NOTHING (the same
   * rule scripts/required-passes.py enforces on the shell route). */
  private requireWholeRound(pr: number, round: number): void {
    const row = this.d.store.roundsFor(pr).find((r) => r.round_no === round);
    if (!row) return;
    const gap = requiredPassGap(
      parsePlan(row.pass_plan),
      readRoundProgress(this.d.root, pr),
      round,
      parsePlan(row.sweep_plan),
    );
    if (gap.state === "missing")
      throw new IpcError(
        "blocked",
        `required pass missing for #${pr} round ${round} — ${describeGap(gap.missing)}. Nothing was posted and nothing may be: do not retry or post another way; commit your verdict file as decided and stop — the daemon requeues the round.`,
      );
  }

  /** The head the review is about: the round's, else the caller's, else live. */
  private async commitHead(
    pr: number,
    keyed: Keyed | null,
    b: Record<string, unknown>,
  ): Promise<string> {
    if (keyed) return keyed.head;
    if (typeof b.expected_head === "string" && b.expected_head !== "")
      return b.expected_head.toLowerCase();
    try {
      return (await this.d.adapter.getPr(pr)).head_sha.toLowerCase();
    } catch {
      throw new IpcError("blocked", "pr-unreadable: the PR's head could not be read");
    }
  }

  // ---- post.review ----------------------------------------------------------

  async review(ctx: RequestContext, body: unknown): Promise<PostOutcome> {
    const b = authorize(ctx, body);
    const event = b.event;
    if (event === "APPROVE")
      throw new IpcError("bad_request", "APPROVE is not allowed here — use post.approval");
    if (event !== "REQUEST_CHANGES" && event !== "COMMENT")
      throw new IpcError("bad_request", "event must be REQUEST_CHANGES or COMMENT");
    const text = reviewBodyText(readResultFile(this.d, ctx, b.body_file));
    const comments =
      b.comments_file === undefined
        ? undefined
        : parseComments(readResultFile(this.d, ctx, b.comments_file));
    const keyed = keyedRound(this.d, ctx, b);
    const head = await this.commitHead(ctx.pr, keyed, b);
    const out = await this.postReview(ctx, "post.review", { keyed, head, event, text, comments });
    return out;
  }

  // ---- post.approval --------------------------------------------------------

  async approval(ctx: RequestContext, body: unknown): Promise<PostOutcome> {
    const b = authorize(ctx, body);
    const text =
      b.body_file === undefined
        ? "Automated review: approved."
        : approvalBodyText(readResultFile(this.d, ctx, b.body_file));
    const comments =
      b.comments_file === undefined
        ? undefined
        : parseComments(readResultFile(this.d, ctx, b.comments_file));
    const keyed = keyedRound(this.d, ctx, b);
    const head = await this.commitHead(ctx.pr, keyed, b);
    const out = await this.postReview(ctx, "post.approval", {
      keyed,
      head,
      event: "APPROVE",
      text,
      comments,
    });
    // Posted, recorded, or already confirmed: now consume BOTH wake triggers, in
    // approve-pr.sh's order. A deferred approval stops here: dispatch already
    // consumed them, and the daemon delivers the approval itself.
    if (out.status === "deferred") return out;
    const steps = approvalActions({
      pr: ctx.pr,
      payload: { commit_id: head, event: "APPROVE", body: text, comments: comments ?? [] },
      trigger_label: this.d.cfg.github.trigger_label,
    }).slice(1);
    for (const step of steps) {
      let res: GateResult;
      try {
        res = await step.run(this.d.adapter);
      } catch (e) {
        throw new IpcError(
          "post_failed",
          `the approval is recorded but "${step.describe}" failed: ${describeFailure(e)}`,
        );
      }
      if (res.blocked)
        throw new IpcError("blocked", `${res.blocked}: "${step.describe}" was refused`);
      out.lines.push(
        res.dryRunFile
          ? `dry-run: ${step.describe} -> ${res.dryRunFile} — nothing was sent`
          : `${step.describe}: done`,
      );
    }
    return out;
  }

  // ---- the shared review post ----------------------------------------------

  private async postReview(
    ctx: RequestContext,
    op: "post.review" | "post.approval",
    r: {
      keyed: Keyed | null;
      head: string;
      event: ReviewEvent;
      text: string;
      comments: InlineComment[] | undefined;
    },
  ): Promise<PostOutcome> {
    const { keyed, head, event } = r;
    const jobPayload: JobPayload = {
      commit_id: head,
      event,
      body: keyed ? `${r.text}\n\n${postingMarker(keyed.key)}` : r.text,
      ...(r.comments ? { comments: r.comments } : {}),
    };
    // The approval's red-CI refusal runs before anything is queued or sent.
    const refuseRedCi = async (): Promise<void> => {
      if (event !== "APPROVE" || !this.d.cfg.guards.block_approve_on_red_ci) return;
      let blocked: boolean;
      try {
        blocked = ciBlocksApproval(classifyCi(await this.d.adapter.listChecks(head)), {
          noChecksIsRed: this.d.cfg.guards.no_checks_is_red,
        });
      } catch {
        throw new IpcError("blocked", "pr-unreadable: the checks at this head could not be read");
      }
      if (blocked)
        throw new IpcError(
          "blocked",
          "ci-not-green: no green CI at this head, so no approval — post the COMMENT through post.review instead",
        );
    };
    const submit = (): Promise<PostOutcome> => this.submit(ctx, op, r, jobPayload);

    if (keyed === null) {
      await refuseRedCi();
      return submit();
    }
    const j = this.d.journal;
    const dry = this.d.adapter.gate.isDryRun;
    return j.locked(ctx.pr, keyed.round, keyed.key, async () => {
      const slot = j.check(ctx.pr, keyed.round, keyed.key);
      switch (slot) {
        case "confirmed":
          return alreadyConfirmed(keyed.key);
        case "dryrun":
          if (dry) return alreadyConfirmed(keyed.key);
          j.archiveDryrun(ctx.pr, keyed.round);
          break;
        case "prepared":
          throw new IpcError(
            "blocked",
            `posting outcome is still unknown for ${keyed.key} — refusing a duplicate POST; let the daemon reconcile the marker`,
          );
        case "deferred":
          return {
            status: "deferred",
            lines: [
              `posting for ${keyed.key} is deferred to the daemon (GitHub did not answer an earlier attempt); it delivers this ${event === "APPROVE" ? "approval" : "review"} itself — nothing to do, finish the round normally`,
            ],
          };
        case "skipped":
          throw new IpcError(
            "blocked",
            `posting for ${keyed.key} was already refused: #${ctx.pr} head ${head.slice(0, 7)} was already reviewed with no author reply since (guard 2). Nothing was posted for this round and nothing will be — record that in the verdict and stop.`,
          );
        case "none":
          break;
        default:
          throw new IpcError("blocked", `invalid or mismatched posting receipt for ${keyed.key}`);
      }
      this.requireWholeRound(ctx.pr, keyed.round);
      j.enqueue({
        key: keyed.key,
        pr: ctx.pr,
        round: keyed.round,
        head,
        event,
        mode: dry ? "dryrun" : "live",
        payload: jobPayload,
      });
      try {
        await refuseRedCi();
      } catch (e) {
        // The refused approval must not stay queued: the session answers with a
        // COMMENT under the same key, and the outbox must never deliver this.
        this.tryJournal("withdraw the queued approval", () =>
          j.withdraw(ctx.pr, keyed.round, keyed.key),
        );
        throw e;
      }
      j.prepare({
        key: keyed.key,
        pr: ctx.pr,
        round: keyed.round,
        head,
        intended: event,
        payload: jobPayload,
      });
      return submit();
    });
  }

  /** The gated POST and what follows it. Runs under the round's lock when keyed. */
  private async submit(
    ctx: RequestContext,
    op: string,
    r: {
      keyed: Keyed | null;
      head: string;
      event: ReviewEvent;
      text: string;
      comments?: InlineComment[];
    },
    jobPayload: JobPayload,
  ): Promise<PostOutcome> {
    const { keyed, event } = r;
    const j = this.d.journal;
    const review: AssembledReview = {
      pr: ctx.pr,
      payload: jobPayload as unknown as ReviewPayload,
      overflow: [],
      tags: new Map(),
      ungrammatical: [],
      withheld: [],
    };
    const ident = keyed ? { key: keyed.key, pr: ctx.pr, round: keyed.round, head: r.head } : null;
    let sub;
    try {
      sub = await submitReview(
        { adapter: this.d.adapter, store: this.d.store },
        review,
        keyed?.round ?? null,
      );
    } catch (err) {
      if (ident && unanswered(err)) return this.handoff(ctx, ident, event, jobPayload, err);
      this.audit(ctx, op, "failed");
      throw new IpcError("post_failed", describeFailure(err));
    }
    const res = sub.result;
    if (res.blocked) {
      if (ident) {
        // The gate proved nothing executed: the round may post again.
        this.tryJournal("clear the prepared receipt", () =>
          j.clearPrepared(ident.pr, ident.round, ident.key),
        );
        if (res.blocked === "no-new-evidence" && event !== "APPROVE") {
          const mark = this.d.store.reviewedHead(ctx.pr);
          const wrote =
            mark !== undefined &&
            this.tryJournal("record the guarded no-op", () =>
              j.skip({
                ...ident,
                intended: event,
                mode: this.d.adapter.gate.isDryRun ? "dryrun" : "live",
                mark: snapshotMark(mark),
              }),
            );
          if (wrote) this.log(`post: recorded guarded no-op (no-new-evidence) for ${ident.key}`);
        }
      }
      this.audit(ctx, op, `blocked:${res.blocked}`);
      throw new IpcError("blocked", `${res.blocked}: nothing was posted`);
    }
    if (res.dryRunFile !== undefined) {
      if (ident) {
        const actual = actualEventOf(res.dryRunFile) ?? event;
        j.dryrun({ ...ident, intended: event, actual, payload: jobPayload });
      }
      this.audit(ctx, op, "dryrun");
      return {
        status: "dryrun",
        dryrun_file: res.dryRunFile,
        lines: [
          `dry-run: post ${event} review on #${ctx.pr} -> ${res.dryRunFile} — nothing was sent`,
        ],
      };
    }
    const response = res.response as { id?: number; html_url?: string } | undefined;
    if (ident) {
      try {
        j.confirm({ ...ident, intended: event, payload: jobPayload, response });
      } catch (e) {
        // The review IS on GitHub. Leave the receipt `prepared`: the verdict
        // watcher and the outbox reconcile it from the marker.
        this.audit(ctx, op, "posted-unconfirmed");
        throw new IpcError(
          "post_failed",
          `the review was posted but its receipt could not be confirmed (${describeFailure(e)}); the daemon reconciles it`,
        );
      }
    }
    this.audit(ctx, op, "posted");
    return {
      status: "posted",
      ...(response?.html_url ? { review_url: response.html_url } : {}),
      ...(typeof response?.id === "number" ? { review_id: response.id } : {}),
      lines: [`POST /pulls/${ctx.pr}/reviews -> ${event} review posted on #${ctx.pr}`],
    };
  }

  /** GitHub answered 5xx, or not at all. Ask it whether the review landed; if
   * so confirm from it, otherwise hand the exact payload to the outbox. */
  private async handoff(
    ctx: RequestContext,
    ident: { key: string; pr: number; round: number; head: string },
    event: ReviewEvent,
    jobPayload: JobPayload,
    cause: unknown,
  ): Promise<PostOutcome> {
    const j = this.d.journal;
    const why = describeFailure(cause);
    let marker:
      "none" | "unreadable" | "multiple" | { id: number; commit_id: string; state: string };
    try {
      const found = (await this.d.adapter.listReviewsFull(ctx.pr)).filter(
        (rv) =>
          this.d.botLogins.includes(rv.user) &&
          rv.commit_id.toLowerCase() === ident.head &&
          rv.body.includes(postingMarker(ident.key)),
      );
      marker = found.length > 1 ? "multiple" : (found[0] ?? "none");
    } catch {
      marker = "unreadable";
    }
    if (marker === "multiple")
      throw new IpcError(
        "post_failed",
        `${why} and more than one bot review carries ${ident.key} — refusing to guess; the daemon reconciles this loud`,
      );
    if (marker === "none" || marker === "unreadable") {
      j.defer({
        ...ident,
        intended: event,
        payload: jobPayload,
        reason: `${why}; marker read: ${marker}`,
      });
      this.audit(ctx, "post", "deferred");
      return {
        status: "deferred",
        lines: [
          `posting deferred: ${why} and the review is not on GitHub (marker read: ${marker}).`,
          "The daemon now owns its delivery: it retries this exact review through the gate on its schedule and confirms it from GitHub before every attempt.",
          "Do NOT post again for this round — finish the round normally (verdict file, ledger).",
        ],
      };
    }
    j.confirm({ ...ident, intended: event, payload: jobPayload, response: marker });
    this.audit(ctx, "post", "posted-from-marker");
    return {
      status: "posted",
      review_id: marker.id,
      lines: [`${why}, but the review landed (marker found) — receipt confirmed from GitHub`],
    };
  }

  /** A journal write that must not turn a refusal into a different failure. */
  private tryJournal<T>(what: string, fn: () => T): T | false {
    try {
      return fn();
    } catch (e) {
      this.log(`post: could not ${what}: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  // ---- post.reply -----------------------------------------------------------

  async reply(ctx: RequestContext, body: unknown): Promise<PostOutcome> {
    const b = authorize(ctx, body);
    const id =
      typeof b.comment_id === "string" && /^\d+$/.test(b.comment_id)
        ? Number(b.comment_id)
        : b.comment_id;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1)
      throw new IpcError(
        "bad_request",
        "comment_id must be the numeric databaseId of a review comment",
      );
    const text = readResultFile(this.d, ctx, b.body_file);
    let res: GateResult;
    try {
      res = await this.d.adapter.createReviewCommentReply(ctx.pr, id, text);
    } catch (err) {
      this.audit(ctx, "post.reply", "failed");
      throw new IpcError("post_failed", describeFailure(err));
    }
    if (res.blocked) {
      this.audit(ctx, "post.reply", `blocked:${res.blocked}`);
      throw new IpcError("blocked", `${res.blocked}: nothing was posted`);
    }
    if (res.dryRunFile !== undefined) {
      this.audit(ctx, "post.reply", "dryrun");
      return {
        status: "dryrun",
        dryrun_file: res.dryRunFile,
        lines: [
          `dry-run: reply to review comment ${id} on #${ctx.pr} -> ${res.dryRunFile} — nothing was sent`,
        ],
      };
    }
    const posted = res.response as { html_url?: string; id?: number } | undefined;
    const url = posted?.html_url;
    // The reply is the daemon's own gated comment: registered, so the reconcile's
    // ungated-review audit accounts for the review GitHub files it under.
    if (res.executed && typeof posted?.id === "number")
      this.d.store.registerBotComment(posted.id, ctx.pr, "review_comment");
    this.audit(ctx, "post.reply", "posted");
    return {
      status: "posted",
      ...(url ? { review_url: url } : {}),
      lines: [`replied to review comment ${id} on #${ctx.pr}`],
    };
  }
}

function alreadyConfirmed(key: string): PostOutcome {
  return {
    status: "already_confirmed",
    lines: [`posting receipt already recorded for ${key} — skipping duplicate`],
  };
}

/** The event the gate's dry-run record carries (guards 1 and 4 may have
 * softened it), or undefined when the record cannot be read. */
function actualEventOf(file: string): ReviewEvent | undefined {
  try {
    const rec = JSON.parse(readFileSync(file, "utf8")) as { body?: { event?: unknown } };
    const e = rec.body?.event;
    return e === "APPROVE" || e === "REQUEST_CHANGES" || e === "COMMENT" ? e : undefined;
  } catch {
    return undefined;
  }
}

/** Turn a journal refusal into the typed wire error, whatever else goes wrong. */
function wrap(
  fn: (ctx: RequestContext, body: unknown) => Promise<PostOutcome>,
): OpHandler["handle"] {
  return async (ctx, body) => {
    try {
      return await fn(ctx, body);
    } catch (e) {
      if (e instanceof JournalError) throw new IpcError("blocked", e.message);
      throw e;
    }
  };
}

/** The three ops, for a server to register. A worker and a post shim may call
 * them; the server has already authenticated the command. */
export function postOps(
  deps: PostOpsDeps,
): Record<"post.review" | "post.approval" | "post.reply", OpHandler> {
  const ops = new PostOps(deps);
  const roles = ["worker", "shim"] as const;
  return {
    "post.review": { roles, handle: wrap((c, b) => ops.review(c, b)) },
    "post.approval": { roles, handle: wrap((c, b) => ops.approval(c, b)) },
    "post.reply": { roles, handle: wrap((c, b) => ops.reply(c, b)) },
  };
}

export function registerPostOps(server: IpcServer, deps: PostOpsDeps): void {
  for (const [op, handler] of Object.entries(postOps(deps))) server.register(op, handler);
}

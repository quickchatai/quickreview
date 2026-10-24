// GitHub App webhook receiver.
//
// Contract: verify `X-Hub-Signature-256` in constant time over the RAW body,
// dedupe on `X-GitHub-Delivery`, persist the event, answer 200 within GitHub's
// 10s budget, then interpret asynchronously. GitHub never retries a failed
// delivery — the reconcile poll (reconcile.ts) is the correctness backbone;
// this path is only the fast one.
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { captureFromEvent, recordCapturedComment } from "./capture.js";
import { reviewTeamSlug, type Config } from "./config.js";
import { botAccountLogin } from "@quickchatai/pi-quickreview/src/identity.js";
import { interpretReviewEvent, isFeedbackBody, ledgerFeedbackSignal } from "./feedback.js";
import { applyEvent as applyEventFor, mergedOverBlock } from "./statemachine.js";
import type { StateStore, StatusSnapshot } from "./state.js";
import { blockedPrAuthor } from "./pr-conversation.js";

// ---- signature -----------------------------------------------------------

/** Constant-time `sha256=<hex>` check over the raw bytes. False on a missing
 * header, a wrong prefix, or a length mismatch (timingSafeEqual throws on
 * unequal lengths — we must not let that leak as a 500). */
export function verifySignature(raw: Buffer, header: string | undefined, secret: string): boolean {
  // An empty secret signs nothing: anyone can compute that HMAC.
  if (secret === "") return false;
  if (!header || !header.startsWith("sha256=")) return false;
  const expected = Buffer.from(signBody(raw, secret), "utf8");
  const given = Buffer.from(header, "utf8");
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}

export function signBody(raw: Buffer | string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
}

// ---- interpretation ------------------------------------------------------

export interface EventPrMeta {
  number: number;
  title: string;
  author: string;
  head_sha: string;
}

export type Interpretation =
  | { kind: "trigger"; pr: number; source: "label" | "team_request"; meta: EventPrMeta }
  | { kind: "synchronize"; pr: number; meta: EventPrMeta }
  | { kind: "closed"; pr: number; merged: boolean; meta: EventPrMeta }
  | {
      kind: "author_reply";
      pr: number;
      comment_id: number;
      in_reply_to_id: number | null;
      body: string;
      author: string;
      /** The file the replied thread sits on (the review comment's `path`),
       * when GitHub sent one — the repo facts' touched path.
       * Never part of the wake's own text. */
      path?: string;
    }
  | {
      kind: "author_pr_comment";
      pr: number;
      comment_id: number;
      body: string;
      author: string;
      created_at: string | null;
    }
  | {
      kind: "bot_comment";
      pr: number;
      comment_id: number;
      scope: "review_comment" | "issue_comment";
    }
  /** The [feedback] tuning loop — meta-signal about the review itself,
   * deliberately diverted before author_reply so it never reaches
   * ping-pong, never wakes the PR session, and never stamps the new-evidence
   * mark (`noteAuthorReply`) that would unlock a re-review. */
  | {
      kind: "feedback_comment";
      pr: number;
      comment_id: number;
      in_reply_to_id: number | null;
      author: string;
      body: string;
      scope: "review_comment" | "issue_comment" | "review";
    }
  /** A human set the bot's review aside on GitHub — it blocked them enough
   * to remove (behavioral signal; interpreted in feedback.ts). */
  | { kind: "review_set_aside"; pr: number; review_id: number; by: string }
  /** A human deleted one of the bot's comments — the bluntest noise verdict. */
  | {
      kind: "bot_comment_deleted";
      pr: number;
      comment_id: number;
      scope?: "review_comment" | "issue_comment";
    }
  /** A human took the bot off the PR (trigger label removed / team review
   * request withdrawn) before the review completed. */
  | { kind: "trigger_withdrawn"; pr: number; by: string }
  /** CI finished at a head (check_suite / workflow_run). Never a transition
   * here; its consumers are the post-approval delta recheck and the
   * withheld-approval retry, which re-queues a PR whose approval red CI held
   * back once CI at its head is green (`cigate.ts`). A suite can
   * hang off more than one PR (shared head), so `prs` is the honest list and
   * `pr` is its first entry, for the event log. */
  | { kind: "ci_completed"; pr: number; prs: number[]; head_sha: string; conclusion: string | null }
  /** A branch moved (`push`). Fanned out to the PRs that target it, again only
   * for the recheck — nothing here queues a review. */
  | { kind: "base_advanced"; branch: string; before: string; after: string }
  | { kind: "ignored"; reason: string; pr?: number };

export interface InterpretDeps {
  botLogin: string;
  triggerLabel: string;
  /** `org/team` as configured. */
  reviewTeam: string;
  /** Bot-comment registry lookup. Returning the PR number prevents a comment
   * id from ever waking a different PR session. */
  botCommentPr: (id: number) => number | undefined;
  /** Known PR author, only while a substantive bot blocking review stands. */
  blockedPrAuthor?: (pr: number) => string | undefined;
}

function prMeta(pr: any): EventPrMeta {
  return {
    number: pr?.number ?? 0,
    title: pr?.title ?? "",
    author: pr?.user?.login ?? "",
    head_sha: pr?.head?.sha ?? "",
  };
}

function isBotUser(user: any, botLogin: string): boolean {
  return user?.type === "Bot" || user?.login === botLogin;
}

/** A deleted comment on either comment route: a human deleting one of the
 * bot's comments is the bluntest noise verdict (the bot never deletes its own —
 * it has no deletion path at all); another bot tidying up is mechanics. */
function commentDeletion(
  comment: any,
  payload: any,
  pr: number,
  botLogin: string,
  scope: "review_comment" | "issue_comment",
): Interpretation {
  if (comment?.user?.login === botLogin && !isBotUser(payload?.sender, botLogin))
    return { kind: "bot_comment_deleted", pr, comment_id: comment.id, scope };
  return { kind: "ignored", reason: "non-signal comment deletion", pr };
}

/** What both comment routes decide before their own routing: the bot's own
 * comment echoing back (registry backfill, never a reply — loop risk),
 * another bot's comment, a bot sender. Null when a human wrote it. */
function nonHumanComment(
  comment: any,
  payload: any,
  pr: number,
  scope: "review_comment" | "issue_comment",
  botLogin: string,
): Interpretation | null {
  if (comment.user?.login === botLogin)
    return { kind: "bot_comment", pr, comment_id: comment.id, scope };
  if (comment.user?.type === "Bot") return { kind: "ignored", reason: "other-bot comment", pr };
  if (payload?.sender?.login === botLogin)
    return { kind: "ignored", reason: "sender is the bot", pr };
  return null;
}

/** Pure event interpreter — the whole receiver's decision logic, testable
 * without HTTP. */
export function interpretEvent(
  event: string,
  action: string | null,
  payload: any,
  deps: InterpretDeps,
): Interpretation {
  switch (event) {
    case "pull_request":
      return interpretPullRequest(action, payload, deps);
    case "pull_request_review_comment":
      return interpretReviewComment(action, payload, deps);
    case "issue_comment":
      return interpretIssueComment(action, payload, deps);
    case "pull_request_review":
      // Interpreted in feedback.ts — the vocabulary GitHub uses for
      // this event is exactly what the no-review-retraction structural guard
      // greps this module for, and feedback.ts can hold no mutation path.
      return interpretReviewEvent(action, payload, { botLogin: deps.botLogin });
    case "check_suite":
      return interpretCiCompletion(action, payload?.check_suite);
    case "workflow_run":
      return interpretCiCompletion(action, payload?.workflow_run);
    case "push":
      return interpretPush(payload);
    default:
      return { kind: "ignored", reason: `unhandled event: ${event}` };
  }
}

function interpretPullRequest(
  action: string | null,
  payload: any,
  deps: InterpretDeps,
): Interpretation {
  const pr = payload?.pull_request;
  if (!pr) return { kind: "ignored", reason: "pull_request payload without pull_request" };
  const meta = prMeta(pr);
  // Bot-authored PRs never enter the queue: the app cannot review
  // its own improvement PRs.
  if (isBotUser(pr.user, deps.botLogin))
    return { kind: "ignored", reason: "bot-authored PR", pr: meta.number };

  switch (action) {
    case "labeled": {
      const name = payload?.label?.name;
      if (name !== deps.triggerLabel)
        return { kind: "ignored", reason: `non-trigger label: ${name}`, pr: meta.number };
      return { kind: "trigger", pr: meta.number, source: "label", meta };
    }
    case "review_requested": {
      const team = payload?.requested_team;
      if (!team) return { kind: "ignored", reason: "individual review request", pr: meta.number };
      const slug: string = team.slug ?? "";
      if (slug !== reviewTeamSlug(deps.reviewTeam))
        return { kind: "ignored", reason: `other team requested: ${slug}`, pr: meta.number };
      return { kind: "trigger", pr: meta.number, source: "team_request", meta };
    }
    case "synchronize":
      return { kind: "synchronize", pr: meta.number, meta };
    case "closed":
      return { kind: "closed", pr: meta.number, merged: Boolean(pr.merged), meta };
    // A human removing the trigger is "take the bot off this PR" —
    // a behavioral feedback signal. The daemon consumes triggers itself
    // (label removal / team-request deletion through the gate), so a bot
    // sender is mechanics, never feedback.
    case "unlabeled": {
      const name = payload?.label?.name;
      if (name !== deps.triggerLabel)
        return { kind: "ignored", reason: `non-trigger label removed: ${name}`, pr: meta.number };
      if (isBotUser(payload?.sender, deps.botLogin))
        return { kind: "ignored", reason: "trigger consumed by the bot", pr: meta.number };
      return { kind: "trigger_withdrawn", pr: meta.number, by: payload?.sender?.login ?? "" };
    }
    case "review_request_removed": {
      const team = payload?.requested_team;
      if (!team)
        return { kind: "ignored", reason: "individual review request removed", pr: meta.number };
      const slug: string = team.slug ?? "";
      if (slug !== reviewTeamSlug(deps.reviewTeam))
        return { kind: "ignored", reason: `other team request removed: ${slug}`, pr: meta.number };
      if (isBotUser(payload?.sender, deps.botLogin))
        return { kind: "ignored", reason: "trigger consumed by the bot", pr: meta.number };
      return { kind: "trigger_withdrawn", pr: meta.number, by: payload?.sender?.login ?? "" };
    }
    default:
      return {
        kind: "ignored",
        reason: `unhandled pull_request action: ${action}`,
        pr: meta.number,
      };
  }
}

function interpretReviewComment(
  action: string | null,
  payload: any,
  deps: InterpretDeps,
): Interpretation {
  const comment = payload?.comment;
  const pr: number = payload?.pull_request?.number ?? 0;
  if (action === "deleted")
    return commentDeletion(comment, payload, pr, deps.botLogin, "review_comment");
  if (action !== "created")
    return { kind: "ignored", reason: `unhandled review-comment action: ${action}` };
  if (!comment) return { kind: "ignored", reason: "review comment payload without comment" };

  const nonHuman = nonHumanComment(comment, payload, pr, "review_comment", deps.botLogin);
  if (nonHuman) return nonHuman;

  const inReplyTo: number | null =
    typeof comment.in_reply_to_id === "number" ? comment.in_reply_to_id : null;
  // [feedback]-prefixed comments divert here, before the
  // author_reply interpretation — they are meta-signal about the review
  // itself and must never enter ping-pong or count as new author evidence.
  if (isFeedbackBody(comment.body))
    return {
      kind: "feedback_comment",
      pr,
      comment_id: comment.id,
      in_reply_to_id: inReplyTo,
      author: comment.user?.login ?? "",
      body: comment.body ?? "",
      scope: "review_comment",
    };
  if (inReplyTo !== null && deps.botCommentPr(inReplyTo) === pr)
    return {
      kind: "author_reply",
      pr,
      comment_id: comment.id,
      in_reply_to_id: inReplyTo,
      body: comment.body ?? "",
      author: comment.user?.login ?? "",
      ...(typeof comment.path === "string" && comment.path !== "" ? { path: comment.path } : {}),
    };
  return { kind: "ignored", reason: "not a reply in this PR's bot thread", pr };
}

/** check_suite/workflow_run `completed` — the two events that carry both a head
 * sha and the PRs it belongs to. Everything else about CI is ignored. */
function interpretCiCompletion(action: string | null, run: any): Interpretation {
  if (action !== "completed") return { kind: "ignored", reason: `unhandled CI action: ${action}` };
  if (!run) return { kind: "ignored", reason: "CI payload without a run" };
  const prs: number[] = (run.pull_requests ?? [])
    .map((p: any) => Number(p?.number ?? 0))
    .filter((n: number) => Number.isInteger(n) && n > 0);
  if (prs.length === 0) return { kind: "ignored", reason: "CI completion not attached to a PR" };
  return {
    kind: "ci_completed",
    pr: prs[0] as number,
    prs,
    head_sha: typeof run.head_sha === "string" ? run.head_sha : "",
    conclusion: typeof run.conclusion === "string" ? run.conclusion : null,
  };
}

const ZERO_SHA = "0000000000000000000000000000000000000000";

/** A branch push. Only branch tips matter (tags and branch deletions do not),
 * and the daemon decides which PRs — if any — target this branch. */
function interpretPush(payload: any): Interpretation {
  const ref: string = typeof payload?.ref === "string" ? payload.ref : "";
  if (!ref.startsWith("refs/heads/"))
    return { kind: "ignored", reason: `push to a non-branch ref: ${ref}` };
  const before: string = typeof payload?.before === "string" ? payload.before : "";
  const after: string = typeof payload?.after === "string" ? payload.after : "";
  if (!before || !after || after === ZERO_SHA || before === ZERO_SHA)
    return { kind: "ignored", reason: "branch created or deleted" };
  if (payload?.deleted === true) return { kind: "ignored", reason: "branch deleted" };
  return { kind: "base_advanced", branch: ref.slice("refs/heads/".length), before, after };
}

function interpretIssueComment(
  action: string | null,
  payload: any,
  deps: InterpretDeps,
): Interpretation {
  const issue = payload?.issue;
  // The discriminator: an "issue" is a PR iff it carries `pull_request`.
  if (!issue?.pull_request) return { kind: "ignored", reason: "issue comment on a non-PR issue" };
  const comment = payload?.comment;
  const pr: number = issue.number ?? 0;
  if (!comment) return { kind: "ignored", reason: "issue comment payload without comment", pr };
  if (action === "deleted")
    return commentDeletion(comment, payload, pr, deps.botLogin, "issue_comment");
  if (action !== "created")
    return { kind: "ignored", reason: `unhandled issue-comment action: ${action}`, pr };

  const nonHuman = nonHumanComment(comment, payload, pr, "issue_comment", deps.botLogin);
  if (nonHuman) return nonHuman;

  // The one exception to the rule below — a [feedback]-prefixed
  // top-level comment is captured for the tuning loop (and still never
  // routed anywhere near the round).
  if (isFeedbackBody(comment.body))
    return {
      kind: "feedback_comment",
      pr,
      comment_id: comment.id,
      in_reply_to_id: null,
      author: comment.user?.login ?? "",
      body: comment.body ?? "",
      scope: "issue_comment",
    };

  const author = deps.blockedPrAuthor?.(pr);
  if (
    author &&
    comment.user?.login?.toLowerCase() === author.toLowerCase() &&
    typeof comment.body === "string" &&
    comment.body.trim() &&
    Number.isSafeInteger(comment.id) &&
    comment.id > 0
  )
    return {
      kind: "author_pr_comment",
      pr,
      comment_id: comment.id,
      body: comment.body,
      author,
      created_at: typeof comment.created_at === "string" ? comment.created_at : null,
    };

  // Ordinary chatter remains silent. A blocked author's PR-level response is
  // a separate conversation obligation, never an automatic review trigger.
  return { kind: "ignored", reason: "top-level PR comment is outside bot review threads", pr };
}

// ---- server --------------------------------------------------------------

export interface WebhookDeps {
  cfg: Config;
  store: StateStore;
  secret: string;
  /** Called after the 200 is sent. Must never throw into the socket. */
  onInterpretation: (
    i: Interpretation,
    ctx: { event: string; action: string | null; guid: string },
  ) => void | Promise<void>;
  log?: (msg: string, extra?: unknown) => void;
  path?: string;
  /** Process liveness stays HTTP-200; the body separately exposes a failed
   * review pipeline so orchestrators do not restart a live reconciler. */
  pipelineHealth?: () => StatusSnapshot["pipeline"];
  /** Clock for the rejection-row throttle; tests inject one. */
  now?: () => number;
  /** PR-scoped readback for an inline reply whose root registration lagged. */
  listReviewCommentsFull?: (pr: number) => Promise<ReadonlyArray<{ id: number; user: string }>>;
}

export interface WebhookHandleResult {
  status: number;
  reason: string;
  interpretation?: Interpretation;
  /** The delivery's `action`, as parsed — handed to `onInterpretation`. */
  action?: string | null;
}

const MAX_BODY = 10 * 1024 * 1024;

// Bad-signature rejections are logged before any dedupe on a public endpoint,
// so an unauthenticated sender controls their rate and (via the headers)
// their size. Each row's header values are capped, and at most
// REJECTION_ROWS_PER_WINDOW rows are written per window; the rest are counted
// and the next window's first row carries that count as `suppressed_before`,
// so the audit trail stays honest without growing with the flood.
const REJECTION_WINDOW_MS = 60_000;
const REJECTION_ROWS_PER_WINDOW = 10;
const REJECTION_HEADER_CAP = 128;
const rejectionThrottle = new WeakMap<
  StateStore,
  { windowStart: number; written: number; suppressed: number }
>();

function capHeader(v: string | undefined): string | null {
  if (v === undefined) return null;
  return v.length > REJECTION_HEADER_CAP ? `${v.slice(0, REJECTION_HEADER_CAP)}…` : v;
}

function logRejection(
  deps: WebhookDeps,
  log: (msg: string, extra?: unknown) => void,
  headers: { guid?: string; event?: string },
): void {
  const now = (deps.now ?? Date.now)();
  let t = rejectionThrottle.get(deps.store);
  if (!t) {
    t = { windowStart: now, written: 0, suppressed: 0 };
    rejectionThrottle.set(deps.store, t);
  }
  if (now - t.windowStart >= REJECTION_WINDOW_MS) {
    t.windowStart = now;
    t.written = 0;
  }
  if (t.written >= REJECTION_ROWS_PER_WINDOW) {
    t.suppressed++;
    return;
  }
  t.written++;
  const guid = capHeader(headers.guid);
  const event = capHeader(headers.event);
  const suppressed = t.suppressed;
  t.suppressed = 0;
  log("webhook: signature rejected", { guid, event, suppressed_before: suppressed });
  deps.store.logEvent("webhook_rejected", null, {
    guid,
    event,
    reason: "bad-signature",
    ...(suppressed > 0 ? { suppressed_before: suppressed } : {}),
  });
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY) throw new Error("payload too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/** Verify and durably accept before answering. Preparation may be retried from
 * the inbox; callbacks run through the recovery pump after the response. */
export function handleDelivery(
  deps: WebhookDeps,
  headers: { signature?: string; guid?: string; event?: string },
  raw: Buffer,
): WebhookHandleResult {
  const log = deps.log ?? (() => {});
  // The polling shape (and so `[github] auth = "user"`) takes no webhooks:
  // the daemon hands no secret, and every delivery is refused unread. The
  // reconcile poll is that install's only trigger.
  if (deps.secret === "") return { status: 404, reason: "webhooks-disabled" };
  if (!verifySignature(raw, headers.signature, deps.secret)) {
    logRejection(deps, log, headers);
    return { status: 403, reason: "bad-signature" };
  }
  const guid = headers.guid;
  const event = headers.event;
  if (!guid || !event) return { status: 400, reason: "missing-headers" };

  // Deploy-window drain: while draining, every authentic delivery is
  // answered 200 and dropped — not interpreted, not recorded. GitHub never
  // auto-retries either way, and the reconcile poll is the recovery path once
  // the drain lifts for what it re-derives: triggers, heads, closes and the
  // comment record. It does not answer: an inline reply in a bot thread that
  // arrived during the drain is captured but never routed to ping-pong — only
  // a redelivery from GitHub serves it. Counted so the lift log line can say
  // how many deliveries were dropped. GET /health is untouched (it never
  // reaches this function).
  const drain = deps.store.drainState();
  if (drain.draining) {
    const dropped = deps.store.countDrainedDelivery();
    log("webhook: draining — delivery dropped", { guid, event, dropped });
    return { status: 200, reason: "draining" };
  }

  let payload: any;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    return { status: 400, reason: "bad-json" };
  }
  const action: string | null = typeof payload?.action === "string" ? payload.action : null;

  // Foreign repositories remain deduplicated, but never enter our work inbox.
  if (foreignRepository(deps, payload)) {
    if (!deps.store.recordDelivery(guid, event, action))
      return { status: 200, reason: "duplicate" };
    deps.store.logEvent("webhook_event", null, {
      guid,
      event,
      action,
      interpretation: "ignored",
      reason: "foreign-repository",
      repository: payload.repository.full_name,
    });
    return { status: 200, reason: "foreign-repository" };
  }
  if (!deps.store.acceptWebhookDelivery(guid, event, action, JSON.stringify(payload))) {
    log("webhook: duplicate delivery", { guid, event, action });
    return { status: 200, reason: "duplicate" };
  }
  const interpretation = prepareAcceptedWebhook(deps, guid);
  return { status: 200, reason: interpretation.kind, interpretation, action };
}

function foreignRepository(deps: WebhookDeps, payload: any): boolean {
  const repo: unknown = payload?.repository?.full_name;
  return typeof repo === "string" && repo.toLowerCase() !== deps.cfg.github.repo.toLowerCase();
}

/** Preparation is replayable from the already-durable accepted payload. */
function prepareAcceptedWebhook(deps: WebhookDeps, guid: string): Interpretation {
  return deps.store.db.transaction(() => {
    const row = deps.store.webhookInbox(guid);
    if (!row) throw new Error("accepted webhook payload unavailable");
    if (row.interpretation !== null) return JSON.parse(row.interpretation) as Interpretation;
    const payload = JSON.parse(row.payload);
    const interpretation: Interpretation = foreignRepository(deps, payload)
      ? { kind: "ignored", reason: "foreign-repository" }
      : interpretEvent(row.event, row.action, payload, {
          botLogin: deps.cfg.github.bot_login,
          triggerLabel: deps.cfg.github.trigger_label,
          reviewTeam: deps.cfg.github.review_team,
          botCommentPr: (id) => deps.store.botCommentPr(id, "review_comment"),
          blockedPrAuthor: (pr) => blockedPrAuthor(deps.store, pr),
        });
    // Capture is a side copy: its persistence must never divert routing.
    if (!foreignRepository(deps, payload)) {
      try {
        captureComment(deps, row.event, row.action, payload);
      } catch (error) {
        deps.log?.("webhook: comment capture failed", error);
        deps.store.logEvent("comment_capture_failed", null, {
          guid,
          event: row.event,
          error: String(error),
        });
      }
    }
    deps.store.logEvent("webhook_event", interpretationPr(interpretation), {
      guid,
      event: row.event,
      action: row.action,
      interpretation: interpretation.kind,
      ...(interpretation.kind === "ignored" ? { reason: interpretation.reason } : {}),
    });
    deps.store.prepareWebhookInbox(guid, JSON.stringify(interpretation));
    return interpretation;
  })();
}

const webhookPumps = new WeakMap<StateStore, Promise<void>>();

/** Fulfill accepted work independently of another delivery or process lifetime. */
export function resumeWebhookDeliveries(
  deps: WebhookDeps,
  stopping: () => boolean = () => false,
): Promise<void> {
  const active = webhookPumps.get(deps.store);
  if (active) return active;
  // Register before the first synchronous read, including a callback that re-enters.
  const work = Promise.resolve().then(async () => {
    if (stopping() || deps.store.drainState().draining) return;
    const clock = deps.now ?? Date.now;
    for (const row of deps.store.readyWebhookInbox(new Date(clock()).toISOString())) {
      if (stopping() || deps.store.drainState().draining) break;
      try {
        const payload = JSON.parse(row.payload);
        if (foreignRepository(deps, payload)) {
          deps.store.completeWebhookDelivery(row.guid);
          continue;
        }
        let interpretation = prepareAcceptedWebhook(deps, row.guid);
        if (
          interpretation.kind === "ignored" &&
          interpretation.reason === "not a reply in this PR's bot thread"
        ) {
          const root: unknown = payload?.comment?.in_reply_to_id;
          const pr = interpretation.pr;
          if (
            pr !== undefined &&
            typeof root === "number" &&
            Number.isSafeInteger(root) &&
            root > 0
          ) {
            const known = deps.store.botCommentPr(root, "review_comment");
            if (known === undefined) {
              if (!deps.listReviewCommentsFull) throw new Error("inline root read unavailable");
              const comments = await deps.listReviewCommentsFull(pr);
              if (stopping() || deps.store.drainState().draining) return;
              const found = comments.find((comment) => comment.id === root);
              if (!found) throw new Error("inline root evidence missing");
              if (found.user.toLowerCase() !== deps.cfg.github.bot_login.toLowerCase()) {
                deps.store.completeWebhookDelivery(row.guid);
                continue;
              }
              deps.store.registerBotComment(root, pr, "review_comment");
            }
            interpretation = interpretEvent(row.event, row.action, payload, {
              botLogin: deps.cfg.github.bot_login,
              triggerLabel: deps.cfg.github.trigger_label,
              reviewTeam: deps.cfg.github.review_team,
              botCommentPr: (id) => deps.store.botCommentPr(id, "review_comment"),
              blockedPrAuthor: (number) => blockedPrAuthor(deps.store, number),
            });
            deps.store.prepareWebhookInbox(row.guid, JSON.stringify(interpretation));
          }
        }
        if (stopping() || deps.store.drainState().draining) break;
        await deps.onInterpretation(interpretation, {
          event: row.event,
          action: row.action,
          guid: row.guid,
        });
        if (stopping() || deps.store.drainState().draining) break;
        deps.store.completeWebhookDelivery(row.guid);
      } catch (error) {
        deps.store.deferWebhookDelivery(row.guid, String(error), clock());
        deps.log?.("webhook: accepted work remains pending", {
          guid: row.guid,
          error: String(error),
        });
      }
    }
  });
  webhookPumps.set(deps.store, work);
  const clear = (): void => {
    if (webhookPumps.get(deps.store) === work) webhookPumps.delete(deps.store);
  };
  void work.then(clear, clear);
  return work;
}

/** Capture every human comment on a tracked PR. Returns nothing —
 * no caller may branch on it, which is the point: the record is a copy, not a
 * routing input. */
function captureComment(
  deps: WebhookDeps,
  event: string,
  action: string | null,
  payload: any,
): void {
  const outcome = captureFromEvent(event, action, payload, {
    botLogin: deps.cfg.github.bot_login,
    isTrackedPr: (pr) => deps.store.getPr(pr) !== undefined,
  });
  if (!("captured" in outcome)) return;
  recordCapturedComment(deps.store, outcome.captured, "webhook");
}

/** The PR an interpretation is about, when it is about one. */
function interpretationPr(i: Interpretation): number | null {
  if (i.kind === "base_advanced") return null;
  if (i.kind === "ignored") return i.pr ?? null;
  return i.pr;
}

/** The route the receiver listens on, and the one the webhook healer reads back, unless configured. */
export const DEFAULT_WEBHOOK_PATH = "/webhook";

export function createWebhookServer(deps: WebhookDeps): Server {
  const path = deps.path ?? DEFAULT_WEBHOOK_PATH;
  const log = deps.log ?? (() => {});
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const kick = (): void => {
    if (stopped) return;
    void resumeWebhookDeliveries(deps, () => stopped).catch((error) =>
      log("webhook: inbox unavailable", error),
    );
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      if (req.method === "GET" && req.url === "/health") {
        const pipeline = deps.pipelineHealth?.();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(pipeline ? { ok: true, process: "alive", pipeline } : { ok: true }));
        return;
      }
      if (req.method !== "POST" || (req.url ?? "").split("?")[0] !== path) {
        res.writeHead(404).end();
        return;
      }
      let raw: Buffer;
      try {
        raw = await readBody(req);
      } catch (err) {
        res.writeHead(413).end();
        log("webhook: body read failed", err);
        return;
      }
      const headers = {
        signature: req.headers["x-hub-signature-256"] as string | undefined,
        guid: req.headers["x-github-delivery"] as string | undefined,
        event: req.headers["x-github-event"] as string | undefined,
      };
      let result: WebhookHandleResult;
      try {
        result = handleDelivery(deps, headers, raw);
      } catch (err) {
        log("webhook: handler failed", err);
        res.writeHead(500).end();
        return;
      }
      // 200 first, interpret after — GitHub fails the delivery past 10s.
      res.writeHead(result.status, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: result.status < 400, reason: result.reason }));
      setImmediate(kick);
    })();
  });
  server.once("listening", () => {
    kick();
    timer = setInterval(kick, 5000);
    timer.unref?.();
  });
  server.once("close", () => {
    stopped = true;
    if (timer !== undefined) clearInterval(timer);
  });
  return server;
}

/** Apply an interpretation to the store via the state machine. The daemon
 * wires this as `onInterpretation`; kept separate so it is testable. */
export async function applyInterpretation(
  deps: {
    cfg: Config;
    store: StateStore;
    deliveryGuid?: string;
    onPrTouched?: (pr: number) => void | Promise<void>;
    onAuthorReply?: (i: Extract<Interpretation, { kind: "author_reply" }>) => void | Promise<void>;
    onAuthorPrComment?: (
      i: Extract<Interpretation, { kind: "author_pr_comment" }>,
    ) => void | Promise<void>;
    onClosed?: (pr: number) => void | Promise<void>;
    /** Post-approval recheck triggers — none touches lifecycle. */
    onSynchronize?: (i: Extract<Interpretation, { kind: "synchronize" }>) => void | Promise<void>;
    onCiCompleted?: (i: Extract<Interpretation, { kind: "ci_completed" }>) => void | Promise<void>;
    onBaseAdvanced?: (
      i: Extract<Interpretation, { kind: "base_advanced" }>,
    ) => void | Promise<void>;
    /** The [feedback] tuning loop — explicit comments and
     * behavioral signals, incl. the merged-over-block signal derived in the
     * `closed` case below. Never touches lifecycle. */
    onFeedbackSignal?: (
      e:
        | Extract<
            Interpretation,
            {
              kind:
                | "feedback_comment"
                | "review_set_aside"
                | "bot_comment_deleted"
                | "trigger_withdrawn";
            }
          >
        | { kind: "merged_over_block"; pr: number },
    ) => void | Promise<void>;
  },
  i: Interpretation,
): Promise<void> {
  const { store, cfg } = deps;
  // The bot ACCOUNT for PR authorship. Person mode has none; no webhook
  // arrives there, but the state machine reads one rule everywhere.
  const opts = { botLogin: botAccountLogin(cfg.github) };
  const local = <T>(run: () => T): T => store.webhookLocalOnce(deps.deliveryGuid, run);
  switch (i.kind) {
    case "trigger":
      local(() => {
        applyEventFor(
          store,
          i.pr,
          { type: "trigger", source: i.source === "label" ? "label" : "team_request" },
          i.meta,
          opts,
        );
      });
      await deps.onPrTouched?.(i.pr);
      return;
    case "synchronize":
      // A PR nobody triggered is not tracked: a push to it adopts nothing
      // (the reconcile poll's head refresh skips unknown PRs the same way).
      if (!store.getPr(i.pr)) return;
      // The refreshed head and its author-response fact commit together.
      local(() => {
        const before = store.getPr(i.pr);
        // A closed PR's row is the close's authoritative snapshot; a push that was
        // still in flight when it closed is history, not the head.
        if (before?.state === "closed") return;
        const result = applyEventFor(store, i.pr, { type: "synchronize" }, i.meta, opts);
        if (!result.skipped && before && i.meta.head_sha && before.head_sha !== i.meta.head_sha)
          store.logEvent("head_push", i.pr, { head_sha: i.meta.head_sha, source: "webhook" });
      });
      // Still not a review trigger. It is the post-approval delta recheck's
      // core trigger, which the daemon decides on separately.
      await deps.onSynchronize?.(i);
      return;
    case "closed": {
      // A close already observed by reconcile still owes idempotent cleanup,
      // but cannot publish another lifecycle fact or erase its prior evidence.
      if (!store.getPr(i.pr)) return;
      const overBlock = local(() => {
        const priorState = store.getPr(i.pr)?.state;
        if (priorState === "closed") {
          // Legacy interrupted closes can still owe local cleanup. Preserve
          // authoritative metadata while replaying that idempotent work.
          applyEventFor(store, i.pr, { type: "closed" }, {}, opts);
          return false;
        }
        const result = applyEventFor(store, i.pr, { type: "closed" }, i.meta, opts);
        if (result.skipped) return false;
        store.logEvent("pr_closed", i.pr, { merged: i.merged, source: "webhook" });
        const over = mergedOverBlock(i.merged, priorState);
        if (over)
          ledgerFeedbackSignal(
            store,
            { kind: "merged_over_block", pr: i.pr },
            {
              timezone: cfg.ops.timezone,
              memoryEnabled: cfg.openviking.enabled,
            },
          );
        return over;
      });
      if (overBlock) await deps.onFeedbackSignal?.({ kind: "merged_over_block", pr: i.pr });
      await deps.onClosed?.(i.pr);
      return;
    }
    case "author_pr_comment":
      await deps.onAuthorPrComment?.(i);
      return;
    case "author_reply": {
      const replyOwed = local(() => {
        if (store.getPr(i.pr)?.state === "closed") {
          store.logEvent("author_reply_ignored_closed", i.pr, { comment_id: i.comment_id });
          return false;
        }
        applyEventFor(store, i.pr, { type: "author_reply" }, {}, opts);
        store.noteAuthorReply(i.pr);
        return true;
      });
      if (!replyOwed) return;
      await deps.onAuthorReply?.(i);
      return;
    }
    case "bot_comment":
      local(() => store.registerBotComment(i.comment_id, i.pr, i.scope));
      return;
    // Pure tuning-loop signals — no state-machine event, no session
    // wake, no reviewed_heads mark. The engine (wired by the daemon) owns
    // dedupe, the memory entry, and the same-day addendum rebuild.
    case "feedback_comment":
    case "review_set_aside":
    case "bot_comment_deleted":
      await deps.onFeedbackSignal?.(i);
      return;
    case "trigger_withdrawn": {
      // Only a withdrawal with a review actually pending is "someone took
      // the bot off the PR" — a human tidying a stale label after the review
      // completed (e.g. a dry-run trigger the gate never really consumed) is
      // not a negative signal.
      const withdrawn = local(() => {
        const state = store.getPr(i.pr)?.state;
        if (state === "queued" || state === "reviewing") return true;
        store.logEvent("trigger_withdrawn_ignored", i.pr, { state: state ?? null, by: i.by });
        return false;
      });
      if (withdrawn) await deps.onFeedbackSignal?.(i);
      return;
    }
    case "ci_completed":
      // Recorded, never a transition here. CI is evidence for the recheck,
      // and the withheld-approval retry behind `onCiCompleted` may re-queue a
      // PR whose approval red CI held back (`cigate.ts`).
      local(() => {
        for (const pr of i.prs)
          store.logEvent("ci_completed", pr, { head_sha: i.head_sha, conclusion: i.conclusion });
      });
      await deps.onCiCompleted?.(i);
      return;
    case "base_advanced":
      local(() =>
        store.logEvent("base_advanced", null, {
          branch: i.branch,
          before: i.before,
          after: i.after,
        }),
      );
      await deps.onBaseAdvanced?.(i);
      return;
    case "ignored":
      return;
  }
}

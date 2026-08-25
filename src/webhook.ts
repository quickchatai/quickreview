// GitHub App webhook receiver (spec §3, §3).
//
// Contract: verify `X-Hub-Signature-256` in constant time over the RAW body,
// dedupe on `X-GitHub-Delivery`, persist the event, answer 200 within GitHub's
// 10s budget, then interpret asynchronously. GitHub never retries a failed
// delivery — the reconcile poll (reconcile.ts) is the correctness backbone;
// this path is only the fast one.
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { captureFromEvent } from "./capture.js";
import type { Config } from "./config.js";
import { interpretReviewEvent, isFeedbackBody } from "./feedback.js";
import { applyEvent as applyEventFor } from "./statemachine.js";
import type { StateStore } from "./state.js";

// ---- signature -----------------------------------------------------------

/** Constant-time `sha256=<hex>` check over the raw bytes. False on a missing
 * header, a wrong prefix, or a length mismatch (timingSafeEqual throws on
 * unequal lengths — we must not let that leak as a 500). */
export function verifySignature(raw: Buffer, header: string | undefined, secret: string): boolean {
  if (!header || !header.startsWith("sha256=")) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`, "utf8");
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
      via: "thread_reply";
      scope: "review_comment";
    }
  | { kind: "bot_comment"; pr: number; comment_id: number; scope: "review_comment" | "issue_comment" }
  /** The [feedback] tuning loop — META-signal about the review
   * itself, deliberately diverted BEFORE author_reply so it never reaches
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
  | { kind: "bot_comment_deleted"; pr: number; comment_id: number }
  /** A human took the bot off the PR (trigger label removed / team review
   * request withdrawn) before the review completed. */
  | { kind: "trigger_withdrawn"; pr: number; by: string }
  /** CI finished at a head (check_suite / workflow_run). No lifecycle meaning:
   * the only consumer is the post-approval delta recheck. A suite can
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
}

/** `example-review[bot]` is @-mentioned as `@example-review`. */
export function mentionsBot(body: string, botLogin: string): boolean {
  const handle = botLogin.replace(/\[bot\]$/, "");
  if (!handle) return false;
  const esc = handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`@${esc}(\\[bot\\])?\\b`, "i").test(body);
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

/** Pure event interpreter — the whole receiver's decision logic, testable
 * without HTTP. */
export function interpretEvent(event: string, action: string | null, payload: any, deps: InterpretDeps): Interpretation {
  switch (event) {
    case "pull_request":
      return interpretPullRequest(action, payload, deps);
    case "pull_request_review_comment":
      return interpretReviewComment(action, payload, deps);
    case "issue_comment":
      return interpretIssueComment(action, payload, deps);
    case "pull_request_review":
      // interpreted in feedback.ts — the vocabulary GitHub uses for
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

function interpretPullRequest(action: string | null, payload: any, deps: InterpretDeps): Interpretation {
  const pr = payload?.pull_request;
  if (!pr) return { kind: "ignored", reason: "pull_request payload without pull_request" };
  const meta = prMeta(pr);
  // Bot-authored PRs never enter the queue (spec §3): the app cannot review
  // its own improvement PRs.
  if (isBotUser(pr.user, deps.botLogin)) return { kind: "ignored", reason: "bot-authored PR", pr: meta.number };

  switch (action) {
    case "labeled": {
      const name = payload?.label?.name;
      if (name !== deps.triggerLabel) return { kind: "ignored", reason: `non-trigger label: ${name}`, pr: meta.number };
      return { kind: "trigger", pr: meta.number, source: "label", meta };
    }
    case "review_requested": {
      const team = payload?.requested_team;
      if (!team) return { kind: "ignored", reason: "individual review request", pr: meta.number };
      const slug: string = team.slug ?? "";
      const wantSlug = deps.reviewTeam.split("/")[1] ?? deps.reviewTeam;
      if (slug !== wantSlug) return { kind: "ignored", reason: `other team requested: ${slug}`, pr: meta.number };
      return { kind: "trigger", pr: meta.number, source: "team_request", meta };
    }
    case "synchronize":
      return { kind: "synchronize", pr: meta.number, meta };
    case "closed":
      return { kind: "closed", pr: meta.number, merged: Boolean(pr.merged), meta };
    // a HUMAN removing the trigger is "take the bot off this PR" —
    // a behavioral feedback signal. The daemon consumes triggers itself
    // (label removal / team-request deletion through the gate), so a bot
    // sender is mechanics, never feedback.
    case "unlabeled": {
      const name = payload?.label?.name;
      if (name !== deps.triggerLabel) return { kind: "ignored", reason: `non-trigger label removed: ${name}`, pr: meta.number };
      if (isBotUser(payload?.sender, deps.botLogin))
        return { kind: "ignored", reason: "trigger consumed by the bot", pr: meta.number };
      return { kind: "trigger_withdrawn", pr: meta.number, by: payload?.sender?.login ?? "" };
    }
    case "review_request_removed": {
      const team = payload?.requested_team;
      if (!team) return { kind: "ignored", reason: "individual review request removed", pr: meta.number };
      const slug: string = team.slug ?? "";
      const wantSlug = deps.reviewTeam.split("/")[1] ?? deps.reviewTeam;
      if (slug !== wantSlug) return { kind: "ignored", reason: `other team request removed: ${slug}`, pr: meta.number };
      if (isBotUser(payload?.sender, deps.botLogin))
        return { kind: "ignored", reason: "trigger consumed by the bot", pr: meta.number };
      return { kind: "trigger_withdrawn", pr: meta.number, by: payload?.sender?.login ?? "" };
    }
    default:
      return { kind: "ignored", reason: `unhandled pull_request action: ${action}`, pr: meta.number };
  }
}

function interpretReviewComment(action: string | null, payload: any, deps: InterpretDeps): Interpretation {
  const comment = payload?.comment;
  const pr: number = payload?.pull_request?.number ?? 0;
  // a HUMAN deleting one of the bot's comments is a behavioral
  // feedback signal (the bot never deletes its own comments — it has no
  // deletion path at all).
  if (action === "deleted") {
    // Only a HUMAN deleting our comment is a signal — another bot (merge
    // queue, housekeeping app) tidying up is mechanics.
    if (comment?.user?.login === deps.botLogin && !isBotUser(payload?.sender, deps.botLogin))
      return { kind: "bot_comment_deleted", pr, comment_id: comment.id };
    return { kind: "ignored", reason: "non-signal comment deletion", pr };
  }
  if (action !== "created") return { kind: "ignored", reason: `unhandled review-comment action: ${action}` };
  if (!comment) return { kind: "ignored", reason: "review comment payload without comment" };

  // The bot's own comments echo back as deliveries: registry backfill, never a
  // reply (loop risk — §3.2).
  if (comment.user?.login === deps.botLogin)
    return { kind: "bot_comment", pr, comment_id: comment.id, scope: "review_comment" };
  if (comment.user?.type === "Bot") return { kind: "ignored", reason: "other-bot comment", pr };
  if (payload?.sender?.login === deps.botLogin) return { kind: "ignored", reason: "sender is the bot", pr };

  const inReplyTo: number | null = typeof comment.in_reply_to_id === "number" ? comment.in_reply_to_id : null;
  // [feedback]-prefixed comments divert HERE, before the
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
      via: "thread_reply",
      scope: "review_comment",
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
  if (!ref.startsWith("refs/heads/")) return { kind: "ignored", reason: `push to a non-branch ref: ${ref}` };
  const before: string = typeof payload?.before === "string" ? payload.before : "";
  const after: string = typeof payload?.after === "string" ? payload.after : "";
  if (!before || !after || after === ZERO_SHA || before === ZERO_SHA)
    return { kind: "ignored", reason: "branch created or deleted" };
  if (payload?.deleted === true) return { kind: "ignored", reason: "branch deleted" };
  return { kind: "base_advanced", branch: ref.slice("refs/heads/".length), before, after };
}

function interpretIssueComment(action: string | null, payload: any, deps: InterpretDeps): Interpretation {
  const issue = payload?.issue;
  // The discriminator: an "issue" is a PR iff it carries `pull_request`.
  if (!issue?.pull_request) return { kind: "ignored", reason: "issue comment on a non-PR issue" };
  const comment = payload?.comment;
  const pr: number = issue.number ?? 0;
  if (!comment) return { kind: "ignored", reason: "issue comment payload without comment", pr };
  // symmetric with the inline route — a human deleting the bot's
  // top-level comment is the same bluntest-possible noise verdict.
  if (action === "deleted") {
    if (comment.user?.login === deps.botLogin && !isBotUser(payload?.sender, deps.botLogin))
      return { kind: "bot_comment_deleted", pr, comment_id: comment.id };
    return { kind: "ignored", reason: "non-signal comment deletion", pr };
  }
  if (action !== "created") return { kind: "ignored", reason: `unhandled issue-comment action: ${action}`, pr };

  if (comment.user?.login === deps.botLogin)
    return { kind: "bot_comment", pr, comment_id: comment.id, scope: "issue_comment" };
  if (comment.user?.type === "Bot") return { kind: "ignored", reason: "other-bot comment", pr };
  if (payload?.sender?.login === deps.botLogin) return { kind: "ignored", reason: "sender is the bot", pr };

  // the one exception to the rule below — a [feedback]-prefixed
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

  // Top-level PR conversation comments are deliberately never automatic.
  // Automatic ping-pong is bounded to a reply in one of this PR's bot-owned
  // inline review threads.
  return { kind: "ignored", reason: "top-level PR comment is outside bot review threads", pr };
}


// ---- server --------------------------------------------------------------

export interface WebhookDeps {
  cfg: Config;
  store: StateStore;
  secret: string;
  /** Called after the 200 is sent. Must never throw into the socket. */
  onInterpretation: (i: Interpretation, ctx: { event: string; action: string | null; guid: string }) => void | Promise<void>;
  log?: (msg: string, extra?: unknown) => void;
  path?: string;
}

export interface WebhookHandleResult {
  status: number;
  reason: string;
  interpretation?: Interpretation;
}

const MAX_BODY = 10 * 1024 * 1024;

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

/** Verify + dedupe + persist. Returns the HTTP status to answer with; the
 * interpretation (when any) is handed to `onInterpretation` by the caller so
 * the response can go out first. Exported for tests. */
export function handleDelivery(
  deps: WebhookDeps,
  headers: { signature?: string; guid?: string; event?: string },
  raw: Buffer,
): WebhookHandleResult {
  const log = deps.log ?? (() => {});
  if (!verifySignature(raw, headers.signature, deps.secret)) {
    log("webhook: signature rejected", { guid: headers.guid, event: headers.event });
    deps.store.logEvent("webhook_rejected", null, { guid: headers.guid ?? null, event: headers.event ?? null, reason: "bad-signature" });
    return { status: 403, reason: "bad-signature" };
  }
  const guid = headers.guid;
  const event = headers.event;
  if (!guid || !event) return { status: 400, reason: "missing-headers" };

  let payload: any;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    return { status: 400, reason: "bad-json" };
  }
  const action: string | null = typeof payload?.action === "string" ? payload.action : null;

  // Redelivery reuses the guid — dedupe on it (§3.4).
  if (!deps.store.recordDelivery(guid, event, action)) {
    log("webhook: duplicate delivery", { guid, event, action });
    return { status: 200, reason: "duplicate" };
  }

  const interpretation = interpretEvent(event, action, payload, {
    botLogin: deps.cfg.github.bot_login,
    triggerLabel: deps.cfg.github.trigger_label,
    reviewTeam: deps.cfg.github.review_team,
    botCommentPr: (id) => deps.store.botCommentPr(id),
  });
  // the capture SIDE RECORD, taken beside the interpretation and
  // never instead of it. `interpretation` above is already decided and is not
  // read here — capture cannot divert a comment, cannot suppress one, and
  // cannot classify one. It also must not be able to break the receiver: a
  // capture failure is logged and the delivery proceeds exactly as before.
  try {
    captureComment(deps, event, action, payload);
  } catch (err) {
    log("webhook: comment capture failed", err);
    deps.store.logEvent("comment_capture_failed", null, { guid, event, error: String(err) });
  }
  deps.store.logEvent("webhook_event", interpretationPr(interpretation), {
    guid,
    event,
    action,
    interpretation: interpretation.kind,
    ...(interpretation.kind === "ignored" ? { reason: interpretation.reason } : {}),
  });
  return { status: 200, reason: interpretation.kind, interpretation };
}

/** Capture every human comment on a tracked PR. Returns nothing —
 * no caller may branch on it, which is the point: the record is a copy, not a
 * routing input. */
function captureComment(deps: WebhookDeps, event: string, action: string | null, payload: any): void {
  const outcome = captureFromEvent(event, action, payload, {
    botLogin: deps.cfg.github.bot_login,
    isTrackedPr: (pr) => deps.store.getPr(pr) !== undefined,
  });
  if (!("captured" in outcome)) return;
  const c = outcome.captured;
  if (deps.store.recordPrComment({ ...c, captured_via: "webhook" }))
    deps.store.logEvent("comment_captured", c.pr, {
      source: c.source,
      comment_id: c.comment_id,
      author: c.author,
      tagged: c.tagged,
      via: "webhook",
    });
}

/** The PR an interpretation is about, when it is about one. */
function interpretationPr(i: Interpretation): number | null {
  if (i.kind === "base_advanced") return null;
  if (i.kind === "ignored") return i.pr ?? null;
  return i.pr;
}

export function createWebhookServer(deps: WebhookDeps): Server {
  const path = deps.path ?? "/webhook";
  const log = deps.log ?? (() => {});
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
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
      const interpretation = result.interpretation;
      if (!interpretation) return;
      setImmediate(() => {
        void (async () => {
          try {
            await deps.onInterpretation(interpretation, {
              event: headers.event ?? "",
              action: null,
              guid: headers.guid ?? "",
            });
          } catch (err) {
            log("webhook: interpretation handler failed", err);
          }
        })();
      });
    })();
  });
}

/** Apply an interpretation to the store via the state machine. The daemon
 * wires this as `onInterpretation`; kept separate so it is testable. */
export async function applyInterpretation(
  deps: {
    cfg: Config;
    store: StateStore;
    onPrTouched?: (pr: number) => void | Promise<void>;
    onAuthorReply?: (i: Extract<Interpretation, { kind: "author_reply" }>) => void | Promise<void>;
    onClosed?: (pr: number) => void | Promise<void>;
    /** Post-approval recheck triggers — none touches lifecycle. */
    onSynchronize?: (i: Extract<Interpretation, { kind: "synchronize" }>) => void | Promise<void>;
    onCiCompleted?: (i: Extract<Interpretation, { kind: "ci_completed" }>) => void | Promise<void>;
    onBaseAdvanced?: (i: Extract<Interpretation, { kind: "base_advanced" }>) => void | Promise<void>;
    /** The [feedback] tuning loop — explicit comments and
     * behavioral signals, incl. the merged-over-block signal derived in the
     * `closed` case below. Never touches lifecycle. */
    onFeedbackSignal?: (
      e:
        | Extract<Interpretation, { kind: "feedback_comment" | "review_set_aside" | "bot_comment_deleted" | "trigger_withdrawn" }>
        | { kind: "merged_over_block"; pr: number },
    ) => void | Promise<void>;
  },
  i: Interpretation,
): Promise<void> {
  const { store, cfg } = deps;
  const opts = { botLogin: cfg.github.bot_login };
  switch (i.kind) {
    case "trigger":
      applyEventFor(store, i.pr, { type: "trigger", source: i.source === "label" ? "label" : "team_request" }, i.meta, opts);
      await deps.onPrTouched?.(i.pr);
      return;
    case "synchronize":
      // Metadata refresh only: pushes never start or pump a review.
      applyEventFor(store, i.pr, { type: "synchronize" }, i.meta, opts);
      // The author-response metric needs the push instant; no transition is
      // logged for a synchronize (the state does not change), so log it here.
      store.logEvent("head_push", i.pr, { head_sha: i.meta.head_sha ?? null, source: "webhook" });
      // Still not a review trigger. It is the post-approval delta recheck's
      // core trigger, which the daemon decides on separately.
      await deps.onSynchronize?.(i);
      return;
    case "closed": {
      // capture the pre-close state — after applyEventFor it is
      // gone. awaiting_author means a REQUEST_CHANGES stood at close.
      const priorState = store.getPr(i.pr)?.state;
      applyEventFor(store, i.pr, { type: "closed" }, i.meta, opts);
      store.logEvent("pr_closed", i.pr, { merged: i.merged, source: "webhook" });
      if (i.merged && priorState === "awaiting_author") await deps.onFeedbackSignal?.({ kind: "merged_over_block", pr: i.pr });
      await deps.onClosed?.(i.pr);
      return;
    }
    case "author_reply":
      applyEventFor(store, i.pr, { type: "author_reply" }, {}, opts);
      // New evidence at the current head (guard 2): a reply is the one
      // thing other than a push that makes re-reviewing the same head useful.
      store.noteAuthorReply(i.pr);
      await deps.onAuthorReply?.(i);
      return;
    case "bot_comment":
      store.registerBotComment(i.comment_id, i.pr, i.scope);
      return;
    // pure tuning-loop signals — no state-machine event, no session
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
      const state = store.getPr(i.pr)?.state;
      if (state === "queued" || state === "reviewing") await deps.onFeedbackSignal?.(i);
      else store.logEvent("trigger_withdrawn_ignored", i.pr, { state: state ?? null, by: i.by });
      return;
    }
    case "ci_completed":
      // Recorded, never a transition: CI is evidence for the recheck, not a
      // trigger for a round.
      for (const pr of i.prs) store.logEvent("ci_completed", pr, { head_sha: i.head_sha, conclusion: i.conclusion });
      await deps.onCiCompleted?.(i);
      return;
    case "base_advanced":
      store.logEvent("base_advanced", null, { branch: i.branch, before: i.before, after: i.after });
      await deps.onBaseAdvanced?.(i);
      return;
    case "ignored":
      return;
  }
}

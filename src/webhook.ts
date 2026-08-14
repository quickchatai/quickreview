// GitHub App webhook receiver (spec §3, §3).
//
// Contract: verify `X-Hub-Signature-256` in constant time over the RAW body,
// dedupe on `X-GitHub-Delivery`, persist the event, answer 200 within GitHub's
// 10s budget, then interpret asynchronously. GitHub never retries a failed
// delivery — the reconcile poll (reconcile.ts) is the correctness backbone;
// this path is only the fast one.
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Config } from "./config.js";
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
    default:
      return { kind: "ignored", reason: `unhandled pull_request action: ${action}`, pr: meta.number };
  }
}

function interpretReviewComment(action: string | null, payload: any, deps: InterpretDeps): Interpretation {
  if (action !== "created") return { kind: "ignored", reason: `unhandled review-comment action: ${action}` };
  const comment = payload?.comment;
  const pr: number = payload?.pull_request?.number ?? 0;
  if (!comment) return { kind: "ignored", reason: "review comment payload without comment" };

  // The bot's own comments echo back as deliveries: registry backfill, never a
  // reply (loop risk — §3.2).
  if (comment.user?.login === deps.botLogin)
    return { kind: "bot_comment", pr, comment_id: comment.id, scope: "review_comment" };
  if (comment.user?.type === "Bot") return { kind: "ignored", reason: "other-bot comment", pr };
  if (payload?.sender?.login === deps.botLogin) return { kind: "ignored", reason: "sender is the bot", pr };

  const inReplyTo: number | null = typeof comment.in_reply_to_id === "number" ? comment.in_reply_to_id : null;
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

function interpretIssueComment(action: string | null, payload: any, deps: InterpretDeps): Interpretation {
  if (action !== "created") return { kind: "ignored", reason: `unhandled issue-comment action: ${action}` };
  const issue = payload?.issue;
  // The discriminator: an "issue" is a PR iff it carries `pull_request`.
  if (!issue?.pull_request) return { kind: "ignored", reason: "issue comment on a non-PR issue" };
  const comment = payload?.comment;
  const pr: number = issue.number ?? 0;
  if (!comment) return { kind: "ignored", reason: "issue comment payload without comment", pr };

  if (comment.user?.login === deps.botLogin)
    return { kind: "bot_comment", pr, comment_id: comment.id, scope: "issue_comment" };
  if (comment.user?.type === "Bot") return { kind: "ignored", reason: "other-bot comment", pr };
  if (payload?.sender?.login === deps.botLogin) return { kind: "ignored", reason: "sender is the bot", pr };

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
  deps.store.logEvent("webhook_event", interpretation.kind === "ignored" ? (interpretation.pr ?? null) : interpretation.pr, {
    guid,
    event,
    action,
    interpretation: interpretation.kind,
    ...(interpretation.kind === "ignored" ? { reason: interpretation.reason } : {}),
  });
  return { status: 200, reason: interpretation.kind, interpretation };
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
      return;
    case "closed":
      applyEventFor(store, i.pr, { type: "closed" }, i.meta, opts);
      store.logEvent("pr_closed", i.pr, { merged: i.merged, source: "webhook" });
      await deps.onClosed?.(i.pr);
      return;
    case "author_reply":
      applyEventFor(store, i.pr, { type: "author_reply" }, {}, opts);
      await deps.onAuthorReply?.(i);
      return;
    case "bot_comment":
      store.registerBotComment(i.comment_id, i.pr, i.scope);
      return;
    case "ignored":
      return;
  }
}

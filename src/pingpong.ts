// The ping-pong path: an author replies in one of the bot's threads, the
// daemon wakes the PR session with thread context, the session posts exactly
// one reply through the gate.
//
// Reply discipline (spec §4, conversation-system.md): one reply per author
// message; ≤3 exchanges per finding, then concede-or-hold; replies never change
// a posted verdict; no new findings in ping-pong. The mechanical halves — "one
// reply per message" and the exchange cap — are enforced here in SQLite; the
// judgment halves are prompt-side, restated in every wake message.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { GitHubAdapter } from "./github.js";
import type { GateResult } from "./gate.js";
import type { StateStore } from "./state.js";

/** Ported: three exchanges per finding, then concede or hold. */
export const MAX_EXCHANGES_PER_FINDING = 3;

/** An author reply, as interpreted by the webhook/reconcile layer (B2). */
export interface AuthorReplyEvent {
  pr: number;
  comment_id: number;
  /** The bot comment this reply hangs off — the thread root. */
  in_reply_to_id: number;
  body: string;
  author: string;
  path?: string;
}

export interface ThreadContext {
  /** The bot's original finding text in this thread, if known. */
  finding?: string;
  /** Ledger id of the finding (F1, F2, …). */
  finding_id?: string;
  head_sha?: string;
  worktree?: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pingpong_threads (
  thread_id INTEGER PRIMARY KEY,
  pr INTEGER NOT NULL,
  exchanges INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pingpong_handled (
  comment_id INTEGER PRIMARY KEY,
  thread_id INTEGER NOT NULL,
  pr INTEGER NOT NULL,
  handled_at TEXT NOT NULL
);
`;

export function threadIdOf(event: Pick<AuthorReplyEvent, "comment_id" | "in_reply_to_id">): number {
  return event.in_reply_to_id || event.comment_id;
}

export interface ReplyDiscipline {
  allowed: boolean;
  exchanges: number;
  /** True when this reply is the last one allowed — it must concede or hold. */
  final: boolean;
  reason?: "exchange-cap-reached";
}

/**
 * Exchange bookkeeping for ping-pong, in the same SQLite file as the rest of
 * the state (own tables, created on construction).
 */
export class PingPongLedger {
  constructor(private readonly db: Database.Database, private readonly now: () => Date = () => new Date()) {
    this.db.exec(SCHEMA);
  }

  private ts(): string {
    return this.now().toISOString();
  }

  exchanges(threadId: number): number {
    const row = this.db.prepare("SELECT exchanges FROM pingpong_threads WHERE thread_id = ?").get(threadId) as
      | { exchanges: number }
      | undefined;
    return row?.exchanges ?? 0;
  }

  /**
   * Claim an author message for exactly one reply. Returns false when this
   * comment id was already handled (duplicate delivery or reconcile replay).
   */
  claimAuthorMessage(event: AuthorReplyEvent): boolean {
    const info = this.db
      .prepare("INSERT OR IGNORE INTO pingpong_handled (comment_id, thread_id, pr, handled_at) VALUES (?, ?, ?, ?)")
      .run(event.comment_id, threadIdOf(event), event.pr, this.ts());
    return info.changes === 1;
  }

  /** Whether a reply may be posted in this thread, and whether it is the last. */
  discipline(threadId: number): ReplyDiscipline {
    const exchanges = this.exchanges(threadId);
    if (exchanges >= MAX_EXCHANGES_PER_FINDING) {
      return { allowed: false, exchanges, final: true, reason: "exchange-cap-reached" };
    }
    return { allowed: true, exchanges, final: exchanges === MAX_EXCHANGES_PER_FINDING - 1 };
  }

  /** Count a posted reply. Returns the new exchange count. */
  recordExchange(threadId: number, pr: number): number {
    this.db
      .prepare(
        `INSERT INTO pingpong_threads (thread_id, pr, exchanges, updated_at) VALUES (?, ?, 1, ?)
         ON CONFLICT(thread_id) DO UPDATE SET exchanges = exchanges + 1, updated_at = excluded.updated_at`,
      )
      .run(threadId, pr, this.ts());
    return this.exchanges(threadId);
  }
}

// ---- the wake message ----------------------------------------------------

/**
 * The inject payload that wakes the PR session for one author reply. The
 * daemon writes it through the session hooks (`inject(pr, message)`); the
 * discipline rules are restated every time because a compacted session may no
 * longer hold them verbatim.
 */
export function buildWakeMessage(
  event: AuthorReplyEvent,
  ctx: ThreadContext,
  discipline: ReplyDiscipline,
): string {
  const quoted = event.body
    .trim()
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
  const lines: string[] = [
    `# Author reply — PR #${event.pr}`,
    "",
    `**Thread**: \`${threadIdOf(event)}\`${ctx.finding_id ? ` (ledger ${ctx.finding_id})` : ""}` +
      `${event.path ? ` · \`${event.path}\`` : ""}`,
    `**From**: @${event.author} (comment \`${event.comment_id}\`)`,
    ...(ctx.head_sha ? [`**Head**: \`${ctx.head_sha}\`${ctx.worktree ? ` · worktree \`${ctx.worktree}\`` : ""}`] : []),
    `**Exchanges so far in this thread**: ${discipline.exchanges}/${MAX_EXCHANGES_PER_FINDING}`,
    "",
  ];
  if (ctx.finding) {
    lines.push("## Your finding in this thread", "", ctx.finding.trim(), "");
  }
  lines.push("## Their message", "", quoted, "", "## What to do");
  if (!discipline.allowed) {
    lines.push(
      "",
      `The ${MAX_EXCHANGES_PER_FINDING}-exchange cap for this finding is reached. **Do not reply again.**`,
      "Mark the finding `conceded` or `held` in the ledger and stop; a re-trigger or",
      "staleness round is the only way this finding moves.",
    );
  } else {
    lines.push(
      "",
      "- Post **one** reply to this message — brief, concrete, code-anchored.",
      "- Verify their claim mechanically at the current head; a claim is never a fact.",
      "- **Concede** (mark `conceded` in the ledger — settled next round) or **hold**",
      '  ("keeping this open for the next review round — re-add the `AI review requested`',
      '  label (or re-request the `review` team) when ready").',
      "- **Never change a posted verdict** — only a round can.",
      "- **No new findings**: record new observations in the ledger as `deferred`.",
      "- If they ask for a human, write the wake-response file with `human_requested: true`",
      "  and tell them the owner will be requested.",
    );
    if (discipline.final) {
      lines.push(
        "",
        `This is exchange ${discipline.exchanges + 1}/${MAX_EXCHANGES_PER_FINDING} — the **last** one on this`,
        "finding. Concede or hold in this reply; do not open another loop.",
      );
    }
  }
  return lines.join("\n");
}

// ---- posting a reply -----------------------------------------------------

export interface ReplyDeps {
  adapter: Pick<GitHubAdapter, "createReviewCommentReply">;
  store: Pick<StateStore, "registerBotComment" | "logEvent">;
  ledger: PingPongLedger;
}

export interface ReplyResult {
  posted: boolean;
  result?: GateResult;
  exchanges: number;
  registered?: number;
  reason?: ReplyDiscipline["reason"];
}

/** Post one thread reply through the gate and register the posted comment id. */
export async function postReply(
  deps: ReplyDeps,
  input: { pr: number; thread_id: number; body: string },
): Promise<ReplyResult> {
  const discipline = deps.ledger.discipline(input.thread_id);
  if (!discipline.allowed) {
    deps.store.logEvent("pingpong_reply_suppressed", input.pr, { thread_id: input.thread_id, reason: discipline.reason });
    return { posted: false, exchanges: discipline.exchanges, ...(discipline.reason ? { reason: discipline.reason } : {}) };
  }
  const result = await deps.adapter.createReviewCommentReply(input.pr, input.thread_id, input.body);
  const exchanges = deps.ledger.recordExchange(input.thread_id, input.pr);
  let registered: number | undefined;
  if (result.executed) {
    const res = result.response as { id?: number } | undefined;
    if (typeof res?.id === "number") {
      deps.store.registerBotComment(res.id, input.pr, "review_comment");
      registered = res.id;
    }
    deps.store.logEvent("pingpong_reply_posted", input.pr, { thread_id: input.thread_id, exchanges });
  } else {
    deps.store.logEvent("pingpong_reply_intent", input.pr, {
      thread_id: input.thread_id,
      exchanges,
      dryrun_file: result.dryRunFile ?? null,
    });
  }
  return { posted: true, result, exchanges, ...(registered !== undefined ? { registered } : {}) };
}

// ---- the human_requested wake response -----------------------------------

export interface WakeResponse {
  pr: number;
  human_requested: boolean;
  reason?: string;
  thread_id?: number;
  written_at: string;
}

/**
 * Where the session drops a wake response for the daemon. It lives beside the
 * verdict files (the daemon already watches `verdict/`), named so it can never
 * be mistaken for a round verdict.
 */
export function wakeResponsePath(root: string, pr: number, ts = new Date().toISOString()): string {
  return join(root, "verdict", `pr-${pr}-wake-${ts.replace(/[:.]/g, "-")}.json`);
}

export function writeWakeResponse(
  root: string,
  response: Omit<WakeResponse, "written_at"> & { written_at?: string },
): string {
  const written_at = response.written_at ?? new Date().toISOString();
  const path = wakeResponsePath(root, response.pr, written_at);
  mkdirSync(join(root, "verdict"), { recursive: true });
  writeFileSync(path, JSON.stringify({ ...response, written_at }, null, 2));
  return path;
}

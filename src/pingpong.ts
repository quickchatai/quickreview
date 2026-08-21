// The ping-pong path: an author replies in one of the bot's threads, the
// daemon wakes the PR session with thread context, the session posts exactly
// one reply through the gate.
//
// Reply discipline (spec §4, conversation-system.md): one reply per author
// message; ≤3 exchanges per finding, then concede-or-hold; replies never change
// a posted verdict; no new findings in ping-pong. The mechanical halves — "one
// reply per message" and the exchange cap — are enforced here in SQLite; the
// judgment halves are prompt-side, restated in every wake message.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, watch, writeFileSync, type FSWatcher } from "node:fs";
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
CREATE TABLE IF NOT EXISTS pingpong_decisions (
  comment_id INTEGER PRIMARY KEY,
  reply_posted INTEGER NOT NULL DEFAULT 0,
  thread_resolved INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
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
    // Additive: cap hits per thread (ping-pong depth metric).
    try {
      this.db.exec("ALTER TABLE pingpong_threads ADD COLUMN cap_hits INTEGER NOT NULL DEFAULT 0");
    } catch {
      /* column already present */
    }
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

  hasClaim(pr: number, threadId: number, commentId: number): boolean {
    return this.db
      .prepare("SELECT 1 FROM pingpong_handled WHERE comment_id = ? AND thread_id = ? AND pr = ?")
      .get(commentId, threadId, pr) !== undefined;
  }

  decisionProgress(commentId: number): { reply_posted: boolean; thread_resolved: boolean } {
    const row = this.db
      .prepare("SELECT reply_posted, thread_resolved FROM pingpong_decisions WHERE comment_id = ?")
      .get(commentId) as { reply_posted: number; thread_resolved: number } | undefined;
    return { reply_posted: row?.reply_posted === 1, thread_resolved: row?.thread_resolved === 1 };
  }

  markDecisionStep(commentId: number, step: "reply_posted" | "thread_resolved"): void {
    this.db.prepare(
      `INSERT INTO pingpong_decisions (comment_id, reply_posted, thread_resolved, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(comment_id) DO UPDATE SET ${step} = 1, updated_at = excluded.updated_at`,
    ).run(commentId, step === "reply_posted" ? 1 : 0, step === "thread_resolved" ? 1 : 0, this.ts());
  }

  /** Whether a reply may be posted in this thread, and whether it is the last. */
  discipline(threadId: number): ReplyDiscipline {
    const exchanges = this.exchanges(threadId);
    if (exchanges >= MAX_EXCHANGES_PER_FINDING) {
      return { allowed: false, exchanges, final: true, reason: "exchange-cap-reached" };
    }
    return { allowed: true, exchanges, final: exchanges === MAX_EXCHANGES_PER_FINDING - 1 };
  }

  /** Record that the exchange cap blocked a reply in this thread. The row is
   * created if the cap was reached without any reply ever being counted here
   * (defensive — the counter is the same row `recordExchange` maintains). */
  recordCapHit(threadId: number, pr: number): number {
    this.db
      .prepare(
        `INSERT INTO pingpong_threads (thread_id, pr, exchanges, cap_hits, updated_at) VALUES (?, ?, 0, 1, ?)
         ON CONFLICT(thread_id) DO UPDATE SET cap_hits = cap_hits + 1, updated_at = excluded.updated_at`,
      )
      .run(threadId, pr, this.ts());
    return this.capHits(threadId);
  }

  capHits(threadId: number): number {
    const row = this.db.prepare("SELECT cap_hits FROM pingpong_threads WHERE thread_id = ?").get(threadId) as
      | { cap_hits: number }
      | undefined;
    return row?.cap_hits ?? 0;
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
      "Inspect the current code and rationale anyway. Write the structured response file",
      `\`verdict/pr-${event.pr}-thread-${threadIdOf(event)}-comment-${event.comment_id}.json\` with`,
      `{"pr":${event.pr},"thread_id":${threadIdOf(event)},"comment_id":${event.comment_id},` +
        '"resolution":"resolve|keep_open","reply":"","reason":"why","human_requested":false}.',
      "The daemon may resolve a satisfied thread, but it will not post a fourth reply.",
      "Mark the finding `conceded` or `held` in the ledger; only an explicit",
      "review re-request can start another round.",
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
      "- Decide whether the finding is now satisfied: inspect the current code and",
      "  accept a sound author rationale. Never treat either as satisfied without checking.",
      `- Write exactly one response file at \`verdict/pr-${event.pr}-thread-${threadIdOf(event)}-comment-${event.comment_id}.json\``,
      "  atomically, with this shape:",
      `  {\"pr\":${event.pr},\"thread_id\":${threadIdOf(event)},\"comment_id\":${event.comment_id},` +
        '"resolution":"resolve|keep_open","reply":"brief reply","reason":"why",' +
        '"human_requested":false}.',
      "  Use `resolve` only when the code addresses the finding or the rationale is satisfactory.",
      "  The daemon posts the reply and, for `resolve`, resolves this bot-owned thread.",
      "- If they ask for a human, set `human_requested: true` in that response file",
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
    const capHits = deps.ledger.recordCapHit(input.thread_id, input.pr);
    deps.store.logEvent("pingpong_reply_suppressed", input.pr, {
      thread_id: input.thread_id,
      reason: discipline.reason,
      cap_hits: capHits,
    });
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

// ---- structured thread decisions -----------------------------------------

export const THREAD_DECISION_RE = /^pr-(\d+)-thread-(\d+)-comment-(\d+)\.json$/;

export interface ThreadDecision {
  pr: number;
  thread_id: number;
  comment_id: number;
  resolution: "resolve" | "keep_open";
  reply: string;
  reason?: string;
  human_requested?: boolean;
}

export function validateThreadDecision(raw: unknown): { ok: true; value: ThreadDecision } | { ok: false; error: string } {
  if (typeof raw !== "object" || raw === null) return { ok: false, error: "not an object" };
  const v = raw as Record<string, unknown>;
  for (const key of ["pr", "thread_id", "comment_id"] as const) {
    if (typeof v[key] === "string" && /^\d+$/.test(v[key])) v[key] = Number(v[key]);
    if (!Number.isInteger(v[key])) return { ok: false, error: `${key} must be an integer` };
  }
  if (v.resolution !== "resolve" && v.resolution !== "keep_open") return { ok: false, error: "bad resolution" };
  if (typeof v.reply !== "string") return { ok: false, error: "reply must be a string" };
  if (v.reason !== undefined && typeof v.reason !== "string") return { ok: false, error: "reason must be a string" };
  if (v.human_requested !== undefined && typeof v.human_requested !== "boolean") return { ok: false, error: "human_requested must be boolean" };
  return { ok: true, value: v as unknown as ThreadDecision };
}

export interface ThreadDecisionDeps extends ReplyDeps {
  adapter: Pick<GitHubAdapter, "createReviewCommentReply" | "resolveOwnReviewThread">;
  verdictDir: string;
  onHumanRequested?: (decision: ThreadDecision) => void | Promise<void>;
  now?: () => Date;
  log?: (message: string, extra?: unknown) => void;
  /** A session writes JSON in place, so fs.watch can fire before its final
   * byte. An unchanged invalid body is only condemned after this delay. */
  malformedSettleMs?: number;
}

/** Reliable session→daemon handoff for ping-pong judgments. Session output is
 * treated as untrusted: ids must match a claimed author message, and the
 * adapter independently verifies bot ownership before resolving a thread. */
export class ThreadDecisionWatcher {
  private watcher: FSWatcher | null = null;
  private readonly inFlight = new Set<string>();
  private readonly invalidReads = new Map<string, string>();
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();
  private readonly processedDir: string;

  constructor(private readonly deps: ThreadDecisionDeps) {
    this.processedDir = join(deps.verdictDir, "processed");
  }

  start(): void {
    mkdirSync(this.deps.verdictDir, { recursive: true });
    void this.sweep();
    this.watcher = watch(this.deps.verdictDir, (_event, filename) => {
      const name = filename ? String(filename) : "";
      if (THREAD_DECISION_RE.test(name)) void this.handleFile(name);
    });
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
  }

  async sweep(): Promise<string[]> {
    if (!existsSync(this.deps.verdictDir)) return [];
    const done: string[] = [];
    for (const name of readdirSync(this.deps.verdictDir).sort()) {
      if (THREAD_DECISION_RE.test(name) && await this.handleFile(name)) done.push(name);
    }
    return done;
  }

  private retryAfterSettle(name: string): void {
    if (this.retryTimers.has(name)) return;
    const timer = setTimeout(() => {
      this.retryTimers.delete(name);
      void this.handleFile(name);
    }, this.deps.malformedSettleMs ?? 250);
    this.retryTimers.set(name, timer);
  }

  private clearInvalid(name: string): void {
    this.invalidReads.delete(name);
    const timer = this.retryTimers.get(name);
    if (timer) clearTimeout(timer);
    this.retryTimers.delete(name);
  }

  private archive(name: string): void {
    this.clearInvalid(name);
    mkdirSync(this.processedDir, { recursive: true });
    const ts = (this.deps.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, "-");
    try {
      renameSync(join(this.deps.verdictDir, name), join(this.processedDir, `${ts}-${name}`));
    } catch (err) {
      this.deps.log?.(`pingpong: could not archive ${name}`, err);
    }
  }

  async handleFile(name: string): Promise<boolean> {
    const match = THREAD_DECISION_RE.exec(name);
    if (!match || this.inFlight.has(name)) return false;
    this.inFlight.add(name);
    try {
      const path = join(this.deps.verdictDir, name);
      if (!existsSync(path)) return false;
      const body = readFileSync(path, "utf8");
      let decoded: unknown;
      try {
        decoded = JSON.parse(body);
      } catch (err) {
        // fs.watch commonly reports creation before a writer has flushed the
        // body. One invalid read is provisional; only an unchanged second read
        // after the settle window is a genuinely malformed decision.
        if (this.invalidReads.get(name) !== body) {
          this.invalidReads.set(name, body);
          this.retryAfterSettle(name);
          return false;
        }
        const error = `unparseable: ${String(err)}`;
        this.deps.store.logEvent("pingpong_decision_malformed", Number(match[1]), { file: name, error });
        this.archive(name);
        return true;
      }
      const parsed = validateThreadDecision(decoded);
      if (!parsed.ok) {
        if (this.invalidReads.get(name) !== body) {
          this.invalidReads.set(name, body);
          this.retryAfterSettle(name);
          return false;
        }
        this.deps.store.logEvent("pingpong_decision_malformed", Number(match[1]), { file: name, error: parsed.error });
        this.archive(name);
        return true;
      }
      this.clearInvalid(name);
      const d = parsed.value;
      if (d.pr !== Number(match[1]) || d.thread_id !== Number(match[2]) || d.comment_id !== Number(match[3]) ||
          !this.deps.ledger.hasClaim(d.pr, d.thread_id, d.comment_id)) {
        this.deps.store.logEvent("pingpong_decision_rejected", d.pr, { file: name, reason: "ids do not match a claimed author message" });
        this.archive(name);
        return true;
      }

      const progress = this.deps.ledger.decisionProgress(d.comment_id);
      if (!progress.reply_posted) {
        if (d.reply.trim()) await postReply(this.deps, { pr: d.pr, thread_id: d.thread_id, body: d.reply.trim() });
        this.deps.ledger.markDecisionStep(d.comment_id, "reply_posted");
      }
      if (d.resolution === "resolve" && !progress.thread_resolved) {
        const resolution = await this.deps.adapter.resolveOwnReviewThread(d.pr, d.thread_id);
        this.deps.ledger.markDecisionStep(d.comment_id, "thread_resolved");
        this.deps.store.logEvent("pingpong_thread_resolved", d.pr, {
          thread_id: d.thread_id,
          comment_id: d.comment_id,
          reason: d.reason ?? null,
          skipped: resolution.skipped,
        });
      }
      if (d.human_requested) await this.deps.onHumanRequested?.(d);
      this.deps.store.logEvent("pingpong_decision_applied", d.pr, {
        thread_id: d.thread_id,
        comment_id: d.comment_id,
        resolution: d.resolution,
        human_requested: d.human_requested ?? false,
      });
      this.archive(name);
      return true;
    } catch (err) {
      this.deps.log?.(`pingpong: ${name} failed`, err);
      this.deps.store.logEvent("pingpong_decision_failed", Number(match[1]), { file: name, error: String(err) });
      return false;
    } finally {
      this.inFlight.delete(name);
    }
  }
}

// ---- legacy human_requested wake response --------------------------------

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

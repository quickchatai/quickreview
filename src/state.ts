// SQLite state store (state/state.db) + the atomic status.json snapshot.
// Tables: pr_state, rounds, bot_comments (registry), deliveries
// (webhook dedupe), events (append log).
import Database from "better-sqlite3";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type PrLifecycleState =
  | "tracked"
  | "queued"
  | "reviewing"
  | "awaiting_author"
  | "awaiting_human"
  | "closed";

export interface PrStateRow {
  number: number;
  state: PrLifecycleState;
  head_sha: string;
  title: string;
  author: string;
  trigger_ts: string | null;
  stale_recheck: number;
  migration_gate: number;
  /** Overseer pause-pr: no dispatch/re-trigger until resumed (or closed). */
  paused: number;
  updated_at: string;
}

export interface RoundRow {
  id: number;
  pr: number;
  round_no: number;
  round_type: string;
  lenses: string;
  verdict: string | null;
  spend_usd: number | null;
  duration_s: number | null;
  /** Session-written 3-4 sentence round summary (verdict file `summary`). */
  summary: string | null;
  started_at: string;
  deadline_at: string;
  finished_at: string | null;
  status: string;
  // ---- metrics / backfill columns (additive, nullable) ----
  /** Diffstat of the head this round reviewed (summed over the files API). */
  additions: number | null;
  deletions: number | null;
  changed_files: number | null;
  /** 1 for rows imported from GitHub history — never live behaviour. */
  backfilled: number;
  /** GitHub review databaseId — the backfill idempotence key. */
  gh_review_id: number | null;
  gh_commit_id: string | null;
  /** The trigger instant this round answered, copied off pr_state at start so
   * time-to-first-verdict survives the `trigger_ts = null` reset at dispatch. */
  trigger_ts: string | null;
  // ---- measured usage (from pi session JSONLs, not self-reported) --
  tokens_in: number | null;
  /** Output tokens including reasoning tokens. */
  tokens_out: number | null;
  tokens_cache_read: number | null;
  /** Daemon-side USD estimate (config pricing); null when a model is unpriced. */
  est_usd: number | null;
}

/** PR lifecycle facts for PRs the daemon never tracked (M2 backfill fills it).
 * Deliberately a separate table: no live query reads it, so importing hundreds
 * of historical PRs cannot leak into the board, status.json or dispatch. */
export interface BackfillPrMetaRow {
  pr: number;
  title: string;
  author: string;
  created_at: string;
  merged_at: string | null;
  closed_at: string | null;
  merged: number;
  imported_at: string;
}

// ---- Slack concierge rows ---------------------------------------
// Slack `ts` values are TEXT ALWAYS ("1755431234.001900"): they are opaque
// message ids whose precision a float would destroy.

/** Who a Slack message came from, in rights terms (resolved by the router). */
export type SlackTier = "anyone" | "author" | "owner_legacy" | "ignored";

/** What the router did with a Slack message. Everything that is not
 * `injected` names the reason it never reached a session. */
export type SlackDisposition =
  | "injected"
  | "dropped_echo"
  | "dropped_stale"
  | "dropped_cap"
  | "dropped_subtype"
  | "dropped_dupe"
  | "dropped_channel";

/** What the daemon posts into Slack. `kind` drives the caps in slack/policy. */
export type SlackPostKind = "reply" | "pickup" | "verdict" | "announce";

/** One PR ⇄ one Slack thread (the root message the daemon opened for it). */
export interface SlackThreadRow {
  pr: number;
  channel: string;
  root_ts: string;
  created_at: string;
  last_post_at: string | null;
  post_count: number;
}

export interface SlackEventRow {
  event_id: string;
  channel: string;
  ts: string;
  thread_ts: string | null;
  slack_user: string | null;
  tier: SlackTier;
  disposition: SlackDisposition;
  received_at: string;
  injected_at: string | null;
}

export interface SlackPostRow {
  id: number;
  idem_key: string;
  kind: SlackPostKind;
  pr: number | null;
  thread_ts: string | null;
  ts: string | null;
  chars: number;
  posted_at: string;
  ok: number;
  error: string | null;
}

export interface SlackCooldownRow {
  key: string;
  last_fired_at: string;
  warsaw_day: string;
  fire_count: number;
  /** Repeats swallowed inside the cooldown window (AlertPolicy fold counter). */
  fold_count: number;
  /** 1 once the one-per-Warsaw-day escalation bypass has been spent. */
  bypassed: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pr_state (
  number INTEGER PRIMARY KEY,
  state TEXT NOT NULL,
  head_sha TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  trigger_ts TEXT,
  stale_recheck INTEGER NOT NULL DEFAULT 0,
  -- LEGACY (escalation scrapped 2026-08-18): no longer read or written. Kept
  -- in the DDL so live databases, which cannot drop it without a table
  -- rebuild, keep satisfying its NOT NULL via the default.
  escalation_worthy INTEGER NOT NULL DEFAULT 0,
  migration_gate INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pr INTEGER NOT NULL,
  round_no INTEGER NOT NULL,
  round_type TEXT NOT NULL,
  lenses TEXT NOT NULL,
  verdict TEXT,
  spend_usd REAL,
  duration_s REAL,
  started_at TEXT NOT NULL,
  deadline_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running'
);
CREATE TABLE IF NOT EXISTS bot_comments (
  comment_id INTEGER PRIMARY KEY,
  pr INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'review_comment',
  posted_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS backfill_pr_meta (
  pr INTEGER PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  merged_at TEXT,
  closed_at TEXT,
  merged INTEGER NOT NULL DEFAULT 0,
  imported_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS deliveries (
  guid TEXT PRIMARY KEY,
  event TEXT NOT NULL,
  action TEXT,
  received_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  pr INTEGER,
  payload TEXT
);
-- Wakes held while their PR's round was in flight (single-shepherd invariant
-- S4: the PR's ONE main pi is never given two instructions at once). Flushed
-- in insertion order once the round ends.
CREATE TABLE IF NOT EXISTS pending_wakes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  pr         INTEGER NOT NULL,
  payload    TEXT NOT NULL,
  reason     TEXT NOT NULL,
  held_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pending_wakes_pr ON pending_wakes(pr, id);
CREATE TABLE IF NOT EXISTS filed_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,           -- 'improvement_pr' | 'issue'
  title TEXT NOT NULL,
  ref TEXT,
  filed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS slack_threads (
  pr           INTEGER PRIMARY KEY,
  channel      TEXT NOT NULL,
  root_ts      TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_post_at TEXT,
  post_count   INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS slack_threads_root ON slack_threads(channel, root_ts);
CREATE TABLE IF NOT EXISTS slack_events (
  event_id     TEXT PRIMARY KEY,
  channel      TEXT NOT NULL,
  ts           TEXT NOT NULL,
  thread_ts    TEXT,
  slack_user   TEXT,
  tier         TEXT NOT NULL,
  disposition  TEXT NOT NULL,
  received_at  TEXT NOT NULL,
  injected_at  TEXT
);
CREATE TABLE IF NOT EXISTS slack_posts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  idem_key   TEXT NOT NULL UNIQUE,
  kind       TEXT NOT NULL,
  pr         INTEGER,
  thread_ts  TEXT,
  ts         TEXT,
  chars      INTEGER NOT NULL DEFAULT 0,
  posted_at  TEXT NOT NULL,
  ok         INTEGER NOT NULL DEFAULT 1,
  error      TEXT
);
CREATE INDEX IF NOT EXISTS slack_posts_day ON slack_posts(posted_at);
CREATE TABLE IF NOT EXISTS slack_cooldowns (
  key           TEXT PRIMARY KEY,
  last_fired_at TEXT NOT NULL,
  warsaw_day    TEXT NOT NULL,
  fire_count    INTEGER NOT NULL DEFAULT 1,
  fold_count    INTEGER NOT NULL DEFAULT 0,
  bypassed      INTEGER NOT NULL DEFAULT 0
);
`;

/** A wake held while its PR's round was in flight (single-shepherd S4). */
export interface PendingWakeRow {
  id: number;
  pr: number;
  payload: string;
  reason: string;
  held_at: string;
}

/** Per-PR ceiling on held wakes. A PR whose author writes more than this while
 * one round runs loses the oldest holds — logged, never silent. */
export const MAX_HELD_WAKES = 5;

/** Optional per-round facts recorded at (or just after) round start. */
export interface RoundStartMeta {
  additions?: number | null;
  deletions?: number | null;
  changed_files?: number | null;
  trigger_ts?: string | null;
}

export class StateStore {
  readonly db: Database.Database;

  constructor(path: string, private readonly now: () => Date = () => new Date()) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
    // Additive migration for stores created before pause-pr existed.
    try {
      this.db.exec("ALTER TABLE pr_state ADD COLUMN paused INTEGER NOT NULL DEFAULT 0");
    } catch {
      /* column already present */
    }
    try {
      this.db.exec("ALTER TABLE rounds ADD COLUMN summary TEXT");
    } catch {
      /* column already present */
    }
    // Metrics + backfill columns. Each ALTER is independent so a
    // partially-migrated store converges; re-running is a no-op.
    for (const ddl of [
      "ALTER TABLE rounds ADD COLUMN additions INTEGER",
      "ALTER TABLE rounds ADD COLUMN deletions INTEGER",
      "ALTER TABLE rounds ADD COLUMN changed_files INTEGER",
      "ALTER TABLE rounds ADD COLUMN backfilled INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE rounds ADD COLUMN gh_review_id INTEGER",
      "ALTER TABLE rounds ADD COLUMN gh_commit_id TEXT",
      "ALTER TABLE rounds ADD COLUMN trigger_ts TEXT",
      "ALTER TABLE bot_comments ADD COLUMN round_no INTEGER",
      // Measured usage — nullable, additive.
      "ALTER TABLE rounds ADD COLUMN tokens_in INTEGER",
      "ALTER TABLE rounds ADD COLUMN tokens_out INTEGER",
      "ALTER TABLE rounds ADD COLUMN tokens_cache_read INTEGER",
      "ALTER TABLE rounds ADD COLUMN est_usd REAL",
      // Slack concierge — cooldown fold/bypass memory, additive so a
      // store created by an earlier slice converges.
      "ALTER TABLE slack_cooldowns ADD COLUMN fold_count INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE slack_cooldowns ADD COLUMN bypassed INTEGER NOT NULL DEFAULT 0",
    ]) {
      try {
        this.db.exec(ddl);
      } catch {
        /* column already present */
      }
    }
  }

  close(): void {
    this.db.close();
  }

  private ts(): string {
    return this.now().toISOString();
  }

  // ---- pr_state ----------------------------------------------------------

  getPr(n: number): PrStateRow | undefined {
    return this.db.prepare("SELECT * FROM pr_state WHERE number = ?").get(n) as PrStateRow | undefined;
  }

  allPrs(): PrStateRow[] {
    return this.db.prepare("SELECT * FROM pr_state ORDER BY number").all() as PrStateRow[];
  }

  /** `paused` is deliberately not part of the upsert: it is owned by
   * setPaused() so state transitions can never clobber an overseer pause. */
  upsertPr(row: Omit<PrStateRow, "updated_at" | "paused"> & { paused?: number }): void {
    this.db
      .prepare(
        `INSERT INTO pr_state (number, state, head_sha, title, author, trigger_ts, stale_recheck, migration_gate, updated_at)
         VALUES (@number, @state, @head_sha, @title, @author, @trigger_ts, @stale_recheck, @migration_gate, @updated_at)
         ON CONFLICT(number) DO UPDATE SET
           state=@state, head_sha=@head_sha, title=@title, author=@author, trigger_ts=@trigger_ts,
           stale_recheck=@stale_recheck, migration_gate=@migration_gate, updated_at=@updated_at`,
      )
      .run((({ paused: _paused, ...cols }) => ({ ...cols, updated_at: this.ts() }))(row));
  }

  setPaused(n: number, paused: boolean): void {
    this.db.prepare("UPDATE pr_state SET paused = ?, updated_at = ? WHERE number = ?").run(paused ? 1 : 0, this.ts(), n);
  }

  setPrState(n: number, state: PrLifecycleState): void {
    this.db.prepare("UPDATE pr_state SET state = ?, updated_at = ? WHERE number = ?").run(state, this.ts(), n);
  }

  // ---- rounds ------------------------------------------------------------

  startRound(
    pr: number,
    roundType: string,
    lenses: string[],
    deadlineMin: number,
    meta: RoundStartMeta = {},
  ): number {
    const started = this.now();
    const deadline = new Date(started.getTime() + deadlineMin * 60_000);
    const nextNo = ((this.db.prepare("SELECT MAX(round_no) AS m FROM rounds WHERE pr = ?").get(pr) as { m: number | null }).m ?? 0) + 1;
    const info = this.db
      .prepare(
        `INSERT INTO rounds (pr, round_no, round_type, lenses, started_at, deadline_at, status,
                             additions, deletions, changed_files, trigger_ts)
         VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)`,
      )
      .run(
        pr,
        nextNo,
        roundType,
        lenses.join(","),
        started.toISOString(),
        deadline.toISOString(),
        meta.additions ?? null,
        meta.deletions ?? null,
        meta.changed_files ?? null,
        meta.trigger_ts ?? null,
      );
    return Number(info.lastInsertRowid);
  }

  /** Diffstat/trigger stamp for a round that already exists (late arrival). */
  setRoundMeta(id: number, meta: RoundStartMeta): void {
    const sets: string[] = [];
    const args: Array<number | string | null> = [];
    for (const key of ["additions", "deletions", "changed_files", "trigger_ts"] as const) {
      if (meta[key] !== undefined) {
        sets.push(`${key} = ?`);
        args.push(meta[key] as number | string | null);
      }
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE rounds SET ${sets.join(", ")} WHERE id = ?`).run(...args, id);
  }

  /** Rounds the daemon actually ran for a PR — backfilled history excluded.
   * Dispatch's first-review-vs-re-review choice keys on this (§2.1). */
  priorRoundCount(pr: number): number {
    return (
      this.db.prepare("SELECT COUNT(*) AS c FROM rounds WHERE pr = ? AND backfilled = 0").get(pr) as { c: number }
    ).c;
  }

  roundsFor(pr: number): RoundRow[] {
    return this.db.prepare("SELECT * FROM rounds WHERE pr = ? ORDER BY round_no").all(pr) as RoundRow[];
  }

  allRounds(): RoundRow[] {
    return this.db.prepare("SELECT * FROM rounds ORDER BY started_at, id").all() as RoundRow[];
  }

  finishRound(id: number, verdict: string, spendUsd: number | null, summary: string | null = null): void {
    const row = this.db.prepare("SELECT started_at FROM rounds WHERE id = ?").get(id) as { started_at: string } | undefined;
    const duration = row ? (this.now().getTime() - Date.parse(row.started_at)) / 1000 : null;
    this.db
      .prepare("UPDATE rounds SET verdict = ?, spend_usd = ?, duration_s = ?, finished_at = ?, summary = ?, status = 'done' WHERE id = ?")
      .run(verdict, spendUsd, duration, this.ts(), summary, id);
  }

  /** Measured usage for a round (pi session JSONLs). Overwrites —
   * a re-measured round keeps only the latest figures. */
  recordRoundUsage(
    id: number,
    usage: { tokens_in: number; tokens_out: number; tokens_cache_read?: number | null; est_usd: number | null },
  ): void {
    this.db
      .prepare("UPDATE rounds SET tokens_in = ?, tokens_out = ?, tokens_cache_read = ?, est_usd = ? WHERE id = ?")
      .run(usage.tokens_in, usage.tokens_out, usage.tokens_cache_read ?? null, usage.est_usd, id);
  }

  /** A dispatch attempt creates its round row before handing the order to the
   * session hook. If that handoff fails, remove the provisional row so it
   * cannot consume capacity or inflate the round number on retry. */
  discardRunningRound(id: number): void {
    this.db.prepare("DELETE FROM rounds WHERE id = ? AND status = 'running'").run(id);
  }

  markRoundOverdue(id: number): void {
    this.db.prepare("UPDATE rounds SET status = 'overdue' WHERE id = ?").run(id);
  }

  /** Administrative close of a round that will never produce a verdict —
   * superseded by a newer round, or orphaned when its tmux session died.
   * Unlike overdue it carries no anomaly semantics and touches no PR state. */
  markRoundCancelled(id: number, reason: string): void {
    this.db
      .prepare("UPDATE rounds SET status = 'cancelled', summary = ?, finished_at = ? WHERE id = ? AND status = 'running'")
      .run(reason, this.ts(), id);
  }

  /** True when a newer round exists for the PR (any status) — the given round
   * is historical and must not drive deadline/overdue side effects. */
  hasLaterRound(pr: number, roundNo: number): boolean {
    const row = this.db
      .prepare("SELECT COUNT(*) AS c FROM rounds WHERE pr = ? AND round_no > ?")
      .get(pr, roundNo) as { c: number };
    return row.c > 0;
  }

  runningRounds(): RoundRow[] {
    return this.db.prepare("SELECT * FROM rounds WHERE status = 'running' ORDER BY started_at").all() as RoundRow[];
  }

  /** True while this PR has a round in flight — the S4 test before any wake. */
  hasRunningRound(pr: number): boolean {
    const row = this.db.prepare("SELECT COUNT(*) AS c FROM rounds WHERE pr = ? AND status = 'running'").get(pr) as { c: number };
    return row.c > 0;
  }

  // ---- held wakes (single-shepherd S4) -----------------------------------

  /** Hold a rendered wake until this PR's round ends. Returns the ids dropped
   * to stay under `cap` (oldest first) so the caller can log them — a silently
   * dropped author reply is worse than a late one. */
  holdWake(pr: number, payload: string, reason: string, cap = MAX_HELD_WAKES): number[] {
    this.db
      .prepare("INSERT INTO pending_wakes (pr, payload, reason, held_at) VALUES (?, ?, ?, ?)")
      .run(pr, payload, reason, this.now().toISOString());
    const overflow = this.db
      .prepare("SELECT id FROM pending_wakes WHERE pr = ? ORDER BY id DESC LIMIT -1 OFFSET ?")
      .all(pr, cap) as Array<{ id: number }>;
    for (const row of overflow) this.db.prepare("DELETE FROM pending_wakes WHERE id = ?").run(row.id);
    return overflow.map((r) => r.id);
  }

  heldWakes(pr: number): PendingWakeRow[] {
    return this.db.prepare("SELECT * FROM pending_wakes WHERE pr = ? ORDER BY id").all(pr) as PendingWakeRow[];
  }

  /** Take every held wake for a PR, oldest first, removing them atomically so
   * a concurrent flush cannot deliver the same wake twice. */
  takeHeldWakes(pr: number): PendingWakeRow[] {
    const take = this.db.transaction((n: number): PendingWakeRow[] => {
      const rows = this.db.prepare("SELECT * FROM pending_wakes WHERE pr = ? ORDER BY id").all(n) as PendingWakeRow[];
      if (rows.length > 0) this.db.prepare("DELETE FROM pending_wakes WHERE pr = ?").run(n);
      return rows;
    });
    return take(pr);
  }

  roundsOn(dateIso: string): RoundRow[] {
    return this.db.prepare("SELECT * FROM rounds WHERE started_at LIKE ? ORDER BY started_at").all(`${dateIso}%`) as RoundRow[];
  }

  /** Daemon-measured est_usd preferred; self-reported spend_usd only as the
   * fallback for historical rows recorded before usage measurement existed. */
  totalSpend(): number {
    return (this.db.prepare("SELECT COALESCE(SUM(COALESCE(est_usd, spend_usd)), 0) AS s FROM rounds").get() as { s: number }).s;
  }

  // ---- backfilled rounds (M2 importer writes; nothing live reads them) ----

  /** Every GitHub review id already imported — the idempotence key set. */
  importedReviewIds(): Set<number> {
    const rows = this.db.prepare("SELECT gh_review_id AS id FROM rounds WHERE gh_review_id IS NOT NULL").all() as Array<{ id: number }>;
    return new Set(rows.map((r) => r.id));
  }

  /** Lowest round_no on a PR (null when it has no rounds) — the importer
   * numbers historical rounds *below* it so live numbering is never disturbed. */
  minRoundNo(pr: number): number | null {
    return (this.db.prepare("SELECT MIN(round_no) AS m FROM rounds WHERE pr = ?").get(pr) as { m: number | null }).m;
  }

  /** Start of the daemon era: the oldest natively-run round. Reviews submitted
   * at or after it are already recorded, so the importer stops there. */
  daemonEpoch(): string | null {
    return (
      this.db.prepare("SELECT MIN(started_at) AS m FROM rounds WHERE backfilled = 0").get() as { m: string | null }
    ).m;
  }

  /** Insert one imported historical round. Returns false when the review was
   * already imported (INSERT ... WHERE NOT EXISTS on gh_review_id). */
  insertBackfilledRound(row: {
    pr: number;
    round_no: number;
    verdict: string | null;
    started_at: string;
    finished_at: string;
    gh_review_id: number;
    gh_commit_id: string | null;
    trigger_ts: string | null;
    summary?: string | null;
  }): boolean {
    const info = this.db
      .prepare(
        `INSERT INTO rounds (pr, round_no, round_type, lenses, verdict, spend_usd, duration_s, summary,
                             started_at, deadline_at, finished_at, status, backfilled,
                             gh_review_id, gh_commit_id, trigger_ts)
         SELECT @pr, @round_no, 'backfill', '', @verdict, NULL, NULL, @summary,
                @started_at, @finished_at, @finished_at, 'done', 1,
                @gh_review_id, @gh_commit_id, @trigger_ts
         WHERE NOT EXISTS (SELECT 1 FROM rounds WHERE gh_review_id = @gh_review_id)`,
      )
      .run({ ...row, summary: row.summary ?? null });
    return info.changes === 1;
  }

  // ---- backfill PR metadata (M2 writes, metrics reads) -------------------

  upsertBackfillPrMeta(row: Omit<BackfillPrMetaRow, "imported_at"> & { imported_at?: string }): void {
    this.db
      .prepare(
        `INSERT INTO backfill_pr_meta (pr, title, author, created_at, merged_at, closed_at, merged, imported_at)
         VALUES (@pr, @title, @author, @created_at, @merged_at, @closed_at, @merged, @imported_at)
         ON CONFLICT(pr) DO UPDATE SET
           title=@title, author=@author, created_at=@created_at, merged_at=@merged_at,
           closed_at=@closed_at, merged=@merged, imported_at=@imported_at`,
      )
      .run({ ...row, imported_at: row.imported_at ?? this.ts() });
  }

  backfillPrMeta(pr: number): BackfillPrMetaRow | undefined {
    return this.db.prepare("SELECT * FROM backfill_pr_meta WHERE pr = ?").get(pr) as BackfillPrMetaRow | undefined;
  }

  allBackfillPrMeta(): BackfillPrMetaRow[] {
    return this.db.prepare("SELECT * FROM backfill_pr_meta ORDER BY pr").all() as BackfillPrMetaRow[];
  }

  // ---- bot-comment registry ---------------------------------------------

  /** `roundNo` links the comment to the round that produced it (review-depth
   * metric). When omitted it defaults to the PR's latest daemon-run round —
   * the only defensible attribution for comments discovered after the fact. */
  registerBotComment(commentId: number, pr: number, kind = "review_comment", roundNo?: number | null): void {
    const linked =
      roundNo ??
      (
        this.db
          .prepare("SELECT round_no FROM rounds WHERE pr = ? AND backfilled = 0 ORDER BY id DESC LIMIT 1")
          .get(pr) as { round_no: number } | undefined
      )?.round_no ??
      null;
    this.db
      .prepare("INSERT OR IGNORE INTO bot_comments (comment_id, pr, kind, posted_at, round_no) VALUES (?, ?, ?, ?, ?)")
      .run(commentId, pr, kind, this.ts(), linked);
  }

  botCommentPr(commentId: number): number | undefined {
    const row = this.db.prepare("SELECT pr FROM bot_comments WHERE comment_id = ?").get(commentId) as { pr: number } | undefined;
    return row?.pr;
  }

  isBotComment(commentId: number): boolean {
    return this.botCommentPr(commentId) !== undefined;
  }

  // ---- webhook delivery dedupe ------------------------------------------

  /** Returns false when the guid was already seen (duplicate delivery). */
  recordDelivery(guid: string, event: string, action: string | null): boolean {
    const info = this.db
      .prepare("INSERT OR IGNORE INTO deliveries (guid, event, action, received_at) VALUES (?, ?, ?, ?)")
      .run(guid, event, action, this.ts());
    return info.changes === 1;
  }

  // ---- event log ---------------------------------------------------------

  logEvent(kind: string, pr: number | null, payload?: unknown): void {
    this.db
      .prepare("INSERT INTO events (ts, kind, pr, payload) VALUES (?, ?, ?, ?)")
      .run(this.ts(), kind, pr, payload === undefined ? null : JSON.stringify(payload));
  }

  /** Head sha of the last applied verdict for a PR (from the event log). */
  lastVerdictHead(pr: number): string | undefined {
    const row = this.db
      .prepare("SELECT payload FROM events WHERE kind = 'verdict_applied' AND pr = ? ORDER BY id DESC LIMIT 1")
      .get(pr) as { payload: string | null } | undefined;
    if (!row?.payload) return undefined;
    try {
      const head = (JSON.parse(row.payload) as { head_sha?: unknown }).head_sha;
      return typeof head === "string" && head.length > 0 ? head : undefined;
    } catch {
      return undefined;
    }
  }

  eventsOn(dateIso: string): Array<{ ts: string; kind: string; pr: number | null; payload: string | null }> {
    return this.db.prepare("SELECT ts, kind, pr, payload FROM events WHERE ts LIKE ? ORDER BY id").all(`${dateIso}%`) as any;
  }

  /** Newest-last tail of the event log — the TUI events strip. */
  recentEvents(limit: number): Array<{ ts: string; kind: string; pr: number | null; payload: string | null }> {
    return this.db
      .prepare("SELECT ts, kind, pr, payload FROM (SELECT id, ts, kind, pr, payload FROM events ORDER BY id DESC LIMIT ?) ORDER BY id")
      .all(limit) as any;
  }

  // ---- filed items (improvement PRs / issues, cap accounting) -----------

  recordFiledItem(kind: "improvement_pr" | "issue", title: string, ref: string | null): void {
    this.db.prepare("INSERT INTO filed_items (kind, title, ref, filed_at) VALUES (?, ?, ?, ?)").run(kind, title, ref, this.ts());
  }

  filedSince(kind: "improvement_pr" | "issue", sinceIso: string): number {
    return (
      this.db.prepare("SELECT COUNT(*) AS c FROM filed_items WHERE kind = ? AND filed_at >= ?").get(kind, sinceIso) as { c: number }
    ).c;
  }

  // ---- Slack: PR ⇄ thread map -------------------------------------------

  /** Bind a PR to its Slack thread root. Re-binding the same PR (a rebuilt
   * thread) overwrites channel/root_ts and resets the per-thread counters. */
  upsertSlackThread(row: { pr: number; channel: string; root_ts: string }): void {
    this.db
      .prepare(
        `INSERT INTO slack_threads (pr, channel, root_ts, created_at, last_post_at, post_count)
         VALUES (@pr, @channel, @root_ts, @created_at, NULL, 0)
         ON CONFLICT(pr) DO UPDATE SET channel=@channel, root_ts=@root_ts`,
      )
      .run({ ...row, created_at: this.ts() });
  }

  slackThreadForPr(pr: number): SlackThreadRow | undefined {
    return this.db.prepare("SELECT * FROM slack_threads WHERE pr = ?").get(pr) as SlackThreadRow | undefined;
  }

  /** The reverse lookup the router needs: an inbound reply carries a
   * thread_ts, and that is the only thing tying it to a PR. */
  slackThreadByRoot(channel: string, rootTs: string): SlackThreadRow | undefined {
    return this.db.prepare("SELECT * FROM slack_threads WHERE channel = ? AND root_ts = ?").get(channel, rootTs) as
      | SlackThreadRow
      | undefined;
  }

  allSlackThreads(): SlackThreadRow[] {
    return this.db.prepare("SELECT * FROM slack_threads ORDER BY pr").all() as SlackThreadRow[];
  }

  /** Stamp a successful post against the PR's thread (counter + last time). */
  touchSlackThread(pr: number): void {
    this.db.prepare("UPDATE slack_threads SET post_count = post_count + 1, last_post_at = ? WHERE pr = ?").run(this.ts(), pr);
  }

  // ---- Slack: inbound event ledger (dedupe + turn accounting) ------------

  /** Returns false when `event_id` was already recorded — Slack redelivers on
   * every missed ack, exactly like a webhook X-GitHub-Delivery replay. */
  recordSlackEvent(row: {
    event_id: string;
    channel: string;
    ts: string;
    thread_ts?: string | null;
    slack_user?: string | null;
    tier: SlackTier;
    disposition: SlackDisposition;
    injected_at?: string | null;
  }): boolean {
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO slack_events
           (event_id, channel, ts, thread_ts, slack_user, tier, disposition, received_at, injected_at)
         VALUES (@event_id, @channel, @ts, @thread_ts, @slack_user, @tier, @disposition, @received_at, @injected_at)`,
      )
      .run({
        ...row,
        thread_ts: row.thread_ts ?? null,
        slack_user: row.slack_user ?? null,
        injected_at: row.injected_at ?? null,
        received_at: this.ts(),
      });
    return info.changes === 1;
  }

  /** The row is written the moment the event lands; the disposition is settled
   * once the router has decided (and stamps injected_at when it injected). */
  setSlackEventDisposition(eventId: string, disposition: SlackDisposition, injected = disposition === "injected"): void {
    this.db
      .prepare("UPDATE slack_events SET disposition = ?, injected_at = ? WHERE event_id = ?")
      .run(disposition, injected ? this.ts() : null, eventId);
  }

  slackEvent(eventId: string): SlackEventRow | undefined {
    return this.db.prepare("SELECT * FROM slack_events WHERE event_id = ?").get(eventId) as SlackEventRow | undefined;
  }

  /** Injected turns inside a half-open [since, until) window; `slackUser`
   * narrows it to one person. Windows are ISO instants — the Warsaw-day
   * boundaries are computed by slack/policy from the eod.ts zone helpers,
   * never re-derived here (mirrors filedSince/improvementRateReason). */
  slackTurnsBetween(sinceIso: string, untilIso: string, slackUser?: string | null): number {
    const sql =
      "SELECT COUNT(*) AS c FROM slack_events WHERE disposition = 'injected' AND received_at >= ? AND received_at < ?" +
      (slackUser ? " AND slack_user = ?" : "");
    const args: Array<string> = slackUser ? [sinceIso, untilIso, slackUser] : [sinceIso, untilIso];
    return (this.db.prepare(sql).get(...args) as { c: number }).c;
  }

  // ---- Slack: outbound post ledger (idempotence + caps) ------------------

  /**
   * The idempotence guarantee: `idem_key` is UNIQUE, so a retried post is
   * rejected here rather than duplicated in the channel. Returns false when
   * the key was already spent — the caller must then NOT post.
   */
  recordSlackPost(row: {
    idem_key: string;
    kind: SlackPostKind;
    pr?: number | null;
    thread_ts?: string | null;
    ts?: string | null;
    chars?: number;
    ok?: boolean;
    error?: string | null;
  }): boolean {
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO slack_posts (idem_key, kind, pr, thread_ts, ts, chars, posted_at, ok, error)
         VALUES (@idem_key, @kind, @pr, @thread_ts, @ts, @chars, @posted_at, @ok, @error)`,
      )
      .run({
        idem_key: row.idem_key,
        kind: row.kind,
        pr: row.pr ?? null,
        thread_ts: row.thread_ts ?? null,
        ts: row.ts ?? null,
        chars: row.chars ?? 0,
        posted_at: this.ts(),
        ok: row.ok === false ? 0 : 1,
        error: row.error ?? null,
      });
    return info.changes === 1;
  }

  /** Fill in the Slack-assigned message ts (and outcome) after the API call. */
  settleSlackPost(idemKey: string, result: { ts?: string | null; ok: boolean; error?: string | null }): void {
    this.db
      .prepare("UPDATE slack_posts SET ts = ?, ok = ?, error = ? WHERE idem_key = ?")
      .run(result.ts ?? null, result.ok ? 1 : 0, result.error ?? null, idemKey);
  }

  slackPost(idemKey: string): SlackPostRow | undefined {
    return this.db.prepare("SELECT * FROM slack_posts WHERE idem_key = ?").get(idemKey) as SlackPostRow | undefined;
  }

  /** Successful posts in [since, until), optionally of one kind. */
  slackPostsBetween(sinceIso: string, untilIso: string, kind?: SlackPostKind): number {
    const sql =
      "SELECT COUNT(*) AS c FROM slack_posts WHERE ok = 1 AND posted_at >= ? AND posted_at < ?" + (kind ? " AND kind = ?" : "");
    const args: Array<string> = kind ? [sinceIso, untilIso, kind] : [sinceIso, untilIso];
    return (this.db.prepare(sql).get(...args) as { c: number }).c;
  }

  /** Successful posts into one thread in [since, until) — the per-thread cap. */
  slackThreadPostsBetween(threadTs: string, sinceIso: string, untilIso: string): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) AS c FROM slack_posts WHERE ok = 1 AND thread_ts = ? AND posted_at >= ? AND posted_at < ?")
        .get(threadTs, sinceIso, untilIso) as { c: number }
    ).c;
  }

  /** Announcements posted since an instant — the per-hour limiter's window is
   * rolling, not calendar-aligned. */
  slackPostsSince(sinceIso: string, kind?: SlackPostKind): number {
    const sql = "SELECT COUNT(*) AS c FROM slack_posts WHERE ok = 1 AND posted_at >= ?" + (kind ? " AND kind = ?" : "");
    const args: Array<string> = kind ? [sinceIso, kind] : [sinceIso];
    return (this.db.prepare(sql).get(...args) as { c: number }).c;
  }

  // ---- Slack: announcement cooldowns ------------------------------------

  slackCooldown(key: string): SlackCooldownRow | undefined {
    return this.db.prepare("SELECT * FROM slack_cooldowns WHERE key = ?").get(key) as SlackCooldownRow | undefined;
  }

  /** Record a fire. A fire in a new Warsaw day resets the fold counter and the
   * daily bypass; `bypass` marks the one escalation allowed per day. */
  recordSlackCooldownFire(key: string, warsawDay: string, bypass = false): void {
    const prev = this.slackCooldown(key);
    const sameDay = prev?.warsaw_day === warsawDay;
    this.db
      .prepare(
        `INSERT INTO slack_cooldowns (key, last_fired_at, warsaw_day, fire_count, fold_count, bypassed)
         VALUES (@key, @last_fired_at, @warsaw_day, @fire_count, 0, @bypassed)
         ON CONFLICT(key) DO UPDATE SET
           last_fired_at=@last_fired_at, warsaw_day=@warsaw_day, fire_count=@fire_count, fold_count=0, bypassed=@bypassed`,
      )
      .run({
        key,
        last_fired_at: this.ts(),
        warsaw_day: warsawDay,
        fire_count: sameDay ? prev!.fire_count + 1 : 1,
        bypassed: (sameDay && prev!.bypassed === 1) || bypass ? 1 : 0,
      });
  }

  /** A repeat swallowed inside the cooldown window; returns the new fold count. */
  foldSlackCooldown(key: string): number {
    this.db.prepare("UPDATE slack_cooldowns SET fold_count = fold_count + 1 WHERE key = ?").run(key);
    return this.slackCooldown(key)?.fold_count ?? 0;
  }
}

// ---- status.json ---------------------------------------------------------

export interface StatusSnapshot {
  written_at: string;
  dry_run: boolean;
  prs: Array<
    Pick<PrStateRow, "number" | "state" | "title" | "head_sha" | "stale_recheck"> &
      Partial<Pick<PrStateRow, "trigger_ts" | "updated_at" | "author" | "paused">> & {
        rounds?: number;
        last_verdict?: string | null;
      }
  >;
  running_rounds: number;
  /** Absent in snapshots written before the TUI additions — readers default. */
  max_concurrent_rounds?: number;
  total_spend_usd: number;
  today_spend_usd?: number;
  digest_headline?: string;
  heartbeat: string;
}

/** Write status.json atomically (temp + rename) — readers may hit it mid-write. */
export function writeStatusJson(stateDir: string, snapshot: StatusSnapshot): void {
  mkdirSync(stateDir, { recursive: true });
  const target = join(stateDir, "status.json");
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
  renameSync(tmp, target);
}

export function buildStatusSnapshot(
  store: StateStore,
  dryRun: boolean,
  digestHeadline?: string,
  now: () => Date = () => new Date(),
  maxConcurrentRounds?: number,
): StatusSnapshot {
  const today = now().toISOString().slice(0, 10);
  const roundStats = store.db
    .prepare("SELECT pr, COUNT(*) AS c, (SELECT verdict FROM rounds r2 WHERE r2.pr = rounds.pr AND verdict IS NOT NULL ORDER BY round_no DESC LIMIT 1) AS v FROM rounds GROUP BY pr")
    .all() as Array<{ pr: number; c: number; v: string | null }>;
  const byPr = new Map(roundStats.map((r) => [r.pr, r]));
  return {
    written_at: now().toISOString(),
    dry_run: dryRun,
    prs: store.allPrs().map((p) => ({
      rounds: byPr.get(p.number)?.c ?? 0,
      last_verdict: byPr.get(p.number)?.v ?? null,
      number: p.number,
      state: p.state,
      title: p.title,
      head_sha: p.head_sha,
      stale_recheck: p.stale_recheck,
      trigger_ts: p.trigger_ts,
      updated_at: p.updated_at,
      author: p.author,
      paused: p.paused,
    })),
    running_rounds: store.runningRounds().length,
    ...(maxConcurrentRounds !== undefined ? { max_concurrent_rounds: maxConcurrentRounds } : {}),
    total_spend_usd: store.totalSpend(),
    today_spend_usd: store.roundsOn(today).reduce((n, r) => n + (r.est_usd ?? r.spend_usd ?? 0), 0),
    ...(digestHeadline ? { digest_headline: digestHeadline } : {}),
    heartbeat: now().toISOString(),
  };
}

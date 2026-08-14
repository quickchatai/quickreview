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
  escalation_worthy: number;
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

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pr_state (
  number INTEGER PRIMARY KEY,
  state TEXT NOT NULL,
  head_sha TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  trigger_ts TEXT,
  stale_recheck INTEGER NOT NULL DEFAULT 0,
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
CREATE TABLE IF NOT EXISTS filed_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,           -- 'improvement_pr' | 'issue'
  title TEXT NOT NULL,
  ref TEXT,
  filed_at TEXT NOT NULL
);
`;

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
        `INSERT INTO pr_state (number, state, head_sha, title, author, trigger_ts, stale_recheck, escalation_worthy, migration_gate, updated_at)
         VALUES (@number, @state, @head_sha, @title, @author, @trigger_ts, @stale_recheck, @escalation_worthy, @migration_gate, @updated_at)
         ON CONFLICT(number) DO UPDATE SET
           state=@state, head_sha=@head_sha, title=@title, author=@author, trigger_ts=@trigger_ts,
           stale_recheck=@stale_recheck, escalation_worthy=@escalation_worthy, migration_gate=@migration_gate, updated_at=@updated_at`,
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

  /** A dispatch attempt creates its round row before handing the order to the
   * session hook. If that handoff fails, remove the provisional row so it
   * cannot consume capacity or inflate the round number on retry. */
  discardRunningRound(id: number): void {
    this.db.prepare("DELETE FROM rounds WHERE id = ? AND status = 'running'").run(id);
  }

  markRoundOverdue(id: number): void {
    this.db.prepare("UPDATE rounds SET status = 'overdue' WHERE id = ?").run(id);
  }

  runningRounds(): RoundRow[] {
    return this.db.prepare("SELECT * FROM rounds WHERE status = 'running' ORDER BY started_at").all() as RoundRow[];
  }

  roundsOn(dateIso: string): RoundRow[] {
    return this.db.prepare("SELECT * FROM rounds WHERE started_at LIKE ? ORDER BY started_at").all(`${dateIso}%`) as RoundRow[];
  }

  totalSpend(): number {
    return (this.db.prepare("SELECT COALESCE(SUM(spend_usd), 0) AS s FROM rounds").get() as { s: number }).s;
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
}

// ---- status.json ---------------------------------------------------------

export interface StatusSnapshot {
  written_at: string;
  dry_run: boolean;
  prs: Array<
    Pick<PrStateRow, "number" | "state" | "title" | "head_sha" | "stale_recheck"> &
      Partial<Pick<PrStateRow, "escalation_worthy" | "trigger_ts" | "updated_at" | "author" | "paused">> & {
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
      escalation_worthy: p.escalation_worthy,
      trigger_ts: p.trigger_ts,
      updated_at: p.updated_at,
      author: p.author,
      paused: p.paused,
    })),
    running_rounds: store.runningRounds().length,
    ...(maxConcurrentRounds !== undefined ? { max_concurrent_rounds: maxConcurrentRounds } : {}),
    total_spend_usd: store.totalSpend(),
    today_spend_usd: store.roundsOn(today).reduce((n, r) => n + (r.spend_usd ?? 0), 0),
    ...(digestHeadline ? { digest_headline: digestHeadline } : {}),
    heartbeat: now().toISOString(),
  };
}

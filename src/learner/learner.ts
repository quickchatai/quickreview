// The learner: candidates in, curated lessons out, and a person told when the
// curation did not happen.
//
// The loop, daemon-side and deterministic up to the curator's own judgement:
//
//   1. MINE (src/learner/miner.ts) — at EOD − `lessons_mine_lead_min`, and on
//      the operator's word (`qcr lessons mine`): every human outcome becomes a
//      row of `lesson_candidates`, deduplicated by a deterministic ref, with a
//      class. The first mine also turns the digests' lost "Learnings" into
//      candidates (`source = digest-backfill`), and a post-approval recheck's
//      APPROVE → REQUEST_CHANGES reversal is one too (`source = recheck`): the
//      reviewer's own conclusion, labelled so, offered after every other
//      source.
//   2. PACKET (src/learner/packet.ts) — at the day's EOD fire: candidates
//      first offered more than `lessons_expiry_ops_days` ago are expired
//      (recorded on the row, in an event, and in the packet's own list — never
//      silent); up to `lessons_packet_new_max` queued ones are offered for the first
//      time; every undecided offered candidate is carried forward. Clustered
//      by class with the 90-day recurrence, the fixed / left-open counterweight
//      and the lessons already covering the class. Written to
//      `state/eod/<day>/outcomes.{json,md}`; the sweep prompt points at it
//      (`prepareEod` → wire.ts's `dayContext`).
//   3. RECEIPT — the curator answers with the whitelisted command
//      `eod-curation-receipt` (src/learner/receipt.ts): per candidate,
//      adopted / declined with a reason / refused (the write failed).
//   4. VERIFY — an adoption counts only when a lesson in `experiences/`
//      carries a typed header whose evidence cites the candidate
//      (`cand:c<id>`, src/memory/lessons.ts). Checked against memory while it
//      reads healthy; a claimed lesson memory does not hold, or a refused
//      write, wakes `eod_lessons_not_persisted` and puts the candidate back
//      in the packet. No receipt `lessons_receipt_wait_min` after the sweep
//      was delivered wakes `eod_curation_missing`. Both are wake kinds and
//      ride status.json `memory.curation` — the board banner, the desktop
//      notification and `qcr status`.
//
// Also measured: the look-for : don't-raise balance of the lessons in force
// (`lessonBalance`), the learner's health metric.
//
// Nothing here writes memory or GitHub, and nothing here is on the round
// path. Its tables live on the state database beside the outcome capture's.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { localWallClockToInstant, zoneDateString, zonedParts, parseHHMM } from "../eod.js";
import type { FileOutcome } from "../improvements.js";
import { EXPERIENCES_AREA, areaOfId } from "../memory/layout.js";
import {
  coveringLessons,
  lessonBalance,
  parseLesson,
  type IndexedLesson,
} from "../memory/lessons.js";
import type { StateStore } from "../state.js";
import {
  findingClass,
  lensIdsOf,
  mineDigestBackfill,
  mineFates,
  mineFeedback,
  mineHumanRecall,
  minePostMerge,
  mineRecheckFlips,
  mineTaggedComments,
  RECALL_SCAN_LIMITS,
  reviewFateCandidates,
  type CandidateDraft,
  type CandidateKind,
  type CandidateSource,
  type Polarity,
  type RecallGit,
} from "./miner.js";
import {
  addDays,
  dayDiff,
  majorityPolarity,
  packetPointer,
  packetRelDir,
  renderCurationSection,
  renderPacketMarkdown,
  type ExpiredCandidate,
  type OutcomesPacket,
  type PacketCandidate,
  type PacketCluster,
} from "./packet.js";
import { candidateLabel, type CurationReceipt } from "./receipt.js";
import type { CurationStatus, UnresolvedCuration } from "./status.js";

export { curationPhrase, type CurationStatus } from "./status.js";

export const LEARNER_WAKE = Object.freeze({
  missing: "eod_curation_missing",
  notPersisted: "eod_lessons_not_persisted",
} as const);

export interface LearnerConfig {
  /** Mine this many minutes before the EOD sweep. */
  lessons_mine_lead_min: number;
  /** How far back a mine reads human outcomes. */
  lessons_mine_days: number;
  /** No receipt this long after the sweep was delivered wakes
   * `eod_curation_missing`. */
  lessons_receipt_wait_min: number;
  /** An offered candidate undecided this many ops days expires (recorded). */
  lessons_expiry_ops_days: number;
  /** At most this many candidates are offered for the first time per packet;
   * the rest wait (queued) for a later one. Carried candidates are never
   * capped. */
  lessons_packet_new_max: number;
  /** A bot-approved merged PR's later commits are read for this long. */
  lessons_recall_window_days: number;
  /** The window a cluster's recurrence and counterweight are counted over. */
  lessons_recurrence_days: number;
  /** The digests whose "Learnings" never reached memory (inclusive). */
  lessons_digest_backfill_from: string;
  lessons_digest_backfill_to: string;
}

export const LEARNER_DEFAULTS: LearnerConfig = Object.freeze({
  lessons_mine_lead_min: 15,
  lessons_mine_days: 45,
  lessons_receipt_wait_min: 180,
  lessons_expiry_ops_days: 7,
  lessons_packet_new_max: 40,
  lessons_recall_window_days: 14,
  lessons_recurrence_days: 90,
  lessons_digest_backfill_from: "2026-08-31",
  lessons_digest_backfill_to: "2026-10-02",
});

/** The `[memory] lessons_*` knobs (src/config.ts) as the learner takes them,
 * with floors — a mistyped 0 must not expire every candidate at once or wake
 * the moment the sweep is delivered. One mapping, for wire.ts and the CLI. */
export function learnerKnobsOf(m: LearnerConfig): Partial<LearnerConfig> {
  return {
    lessons_mine_lead_min: Math.max(0, m.lessons_mine_lead_min),
    lessons_mine_days: Math.max(1, m.lessons_mine_days),
    lessons_receipt_wait_min: Math.max(1, m.lessons_receipt_wait_min),
    lessons_expiry_ops_days: Math.max(1, m.lessons_expiry_ops_days),
    lessons_packet_new_max: Math.max(0, m.lessons_packet_new_max),
    lessons_recall_window_days: Math.max(1, m.lessons_recall_window_days),
    lessons_recurrence_days: Math.max(1, m.lessons_recurrence_days),
    lessons_digest_backfill_from: m.lessons_digest_backfill_from,
    lessons_digest_backfill_to: m.lessons_digest_backfill_to,
  };
}

/** Where the learner reads the lessons in force: the store's sweep (the
 * daemon's OpenViking store). Ids are `<area>/<file>`. */
export interface LessonSource {
  sweep(): Promise<{
    entries: ReadonlyArray<{ id: string; text: string }>;
    unread: readonly string[];
  }>;
}

export interface LearnerDeps {
  store: StateStore;
  /** The sandbox root: `state/eod/<day>/` is written under it and
   * `digest/<date>.md` read from it. */
  root: string;
  /** The EOD sweep's wall clock (`[eod] time` / `timezone`) — packets are
   * named by its date, and the mine runs `lessons_mine_lead_min` before it. */
  eodTime: string;
  timeZone: string;
  botLogin: string;
  /** `[github] base_branch` — the base of a PR no round recorded one for. */
  baseBranch: string;
  config?: Partial<LearnerConfig>;
  /** Post-merge recall (the base clone). Absent ⇒ that source is skipped. */
  git?: RecallGit;
  /** The lessons in force. Absent (memory switched off) ⇒ coverage and the
   * balance read unknown and no adoption is ever verified. */
  lessons?: LessonSource;
  /** Memory health: verification and coverage read memory only while true. */
  healthy?: () => boolean;
  /** Raise a wake anomaly (wire.ts: `store.logAnomaly(kind, null, null,
   * detail, message)`). */
  wake?: (kind: string, detail: string, message: string) => void;
  now?: () => Date;
  log?: (msg: string, extra?: unknown) => void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS lesson_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- the dedup key: one human outcome is one candidate, whichever mine saw it
  ref TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  polarity TEXT NOT NULL,
  class TEXT NOT NULL,
  lens_ids TEXT NOT NULL DEFAULT '[]',
  pr INTEGER,
  round_no INTEGER,
  finding_key TEXT,
  path TEXT,
  line INTEGER,
  summary TEXT NOT NULL,
  quote TEXT,
  evidence TEXT NOT NULL DEFAULT '[]',
  occurred_at TEXT NOT NULL,
  mined_at TEXT NOT NULL,
  -- the ops day it first rode a packet; NULL = queued, never offered
  offered_day TEXT,
  last_offered_day TEXT,
  offers INTEGER NOT NULL DEFAULT 0,
  -- the ops day a refused write or an unfound adoption re-opened it: its
  -- expiry clock restarts there (NULL = it runs from offered_day)
  reopened_day TEXT,
  -- open | adopting (the receipt said adopted; memory not checked yet) |
  -- adopted (a lesson header cites it) | declined | expired |
  -- withdrawn (its human outcome changed since it was mined — never deleted)
  status TEXT NOT NULL DEFAULT 'open',
  decided_at TEXT,
  decided_day TEXT,
  reason TEXT,
  lesson_ids TEXT,
  claimed_lesson TEXT,
  receipt_day TEXT,
  receipt_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS lesson_candidates_status ON lesson_candidates (status, offered_day);
CREATE INDEX IF NOT EXISTS lesson_candidates_class ON lesson_candidates (class, occurred_at);
CREATE TABLE IF NOT EXISTS eod_curations (
  day TEXT PRIMARY KEY,
  packet_at TEXT,
  offered TEXT NOT NULL DEFAULT '[]',
  new_today TEXT NOT NULL DEFAULT '[]',
  expired TEXT NOT NULL DEFAULT '[]',
  fired_at TEXT,
  receipt_at TEXT,
  receipt TEXT,
  missing_woken_at TEXT,
  -- [{id, why}] adoptions memory does not hold and refused writes
  not_persisted TEXT NOT NULL DEFAULT '[]',
  -- when the list last went from empty to non-empty (the incident's start)
  not_persisted_since TEXT,
  -- the not_persisted items (id + why) a wake has already named
  not_persisted_woken TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS learner_marks (
  key TEXT PRIMARY KEY,
  value TEXT,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS learner_recall_scans (
  pr INTEGER PRIMARY KEY,
  merged_at TEXT NOT NULL,
  base_ref TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_scan_at TEXT,
  merge_commit TEXT,
  touches INTEGER,
  done INTEGER NOT NULL DEFAULT 0,
  outcome TEXT
);
`;

export type CandidateStatus =
  "open" | "adopting" | "adopted" | "declined" | "expired" | "withdrawn";

/** A candidate in one of these is decided: it leaves the not-persisted lists
 * and is never re-opened by a refused write. */
const SETTLED_STATUSES = ["adopted", "declined", "expired", "withdrawn"] as const;
const SETTLED_SQL = SETTLED_STATUSES.map((s) => `'${s}'`).join(", ");

export interface CandidateRow {
  id: number;
  ref: string;
  source: CandidateSource;
  kind: CandidateKind;
  polarity: Polarity;
  class: string;
  lens_ids: string;
  pr: number | null;
  round_no: number | null;
  finding_key: string | null;
  path: string | null;
  line: number | null;
  summary: string;
  quote: string | null;
  evidence: string;
  occurred_at: string;
  mined_at: string;
  offered_day: string | null;
  last_offered_day: string | null;
  offers: number;
  reopened_day: string | null;
  status: CandidateStatus;
  decided_at: string | null;
  decided_day: string | null;
  reason: string | null;
  lesson_ids: string | null;
  claimed_lesson: string | null;
  receipt_day: string | null;
  receipt_at: string | null;
  updated_at: string;
}

interface CurationRow {
  day: string;
  packet_at: string | null;
  offered: string;
  new_today: string;
  expired: string;
  fired_at: string | null;
  receipt_at: string | null;
  receipt: string | null;
  missing_woken_at: string | null;
  not_persisted: string;
  not_persisted_since: string | null;
  not_persisted_woken: string;
  updated_at: string;
}

export interface MineReport {
  /** New candidate rows. */
  added: number;
  /** Drafts per source (new or already known). */
  seen: Partial<Record<CandidateSource, number>>;
  added_by_source: Partial<Record<CandidateSource, number>>;
  recall: { scanned: number; unknown: number } | null;
  digest: { files: number; absent: number; unreadable: number; added: number } | null;
  /** Undecided fate candidates re-read against the outcome capture as it
   * stands: revised in place, withdrawn (their fate is no longer a
   * candidate's, or their chain's root changed), and withdrawn ones
   * reinstated. */
  fates: { revised: number; withdrawn: number; reinstated: number };
  /** Undecided feedback / tagged-comment candidates whose finding link (and
   * so class, lens and anchor) the outcome capture made or moved since they
   * were minted. */
  relinked: number;
  errors: string[];
}

const DAY_MS = 86_400_000;
/** A lesson written moments before its receipt may not be listed yet. */
const VERIFY_GRACE_MS = 10 * 60_000;
/** How long `prepareEod` waits for a mine it had to start itself. */
const PREPARE_MINE_BUDGET_MS = 60_000;
/** How long a lesson read for the packet may take. */
const LESSON_READ_BUDGET_MS = 20_000;
/** With no adoption waiting, the lessons in force are re-read this often. */
const LESSON_REFRESH_MS = 30 * 60_000;
/** How many curation days back the status looks for an unresolved failure. */
const UNRESOLVED_SCAN_DAYS = 30;

function json<T>(raw: string | null | undefined, fallback: T): T {
  try {
    const v = JSON.parse(raw ?? "") as unknown;
    return (v ?? fallback) as T;
  } catch {
    return fallback;
  }
}

/** `p`, or "timeout" once `ms` passed. A rejection reads as "timeout" too —
 * the caller's fallback is the same — but its cause goes to `onReject`, so a
 * failure is never mistaken for a slow answer in the log. */
function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  onReject: (err: unknown) => void,
): Promise<T | "timeout"> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve("timeout"), ms);
    t.unref?.();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (err: unknown) => {
        clearTimeout(t);
        onReject(err);
        resolve("timeout");
      },
    );
  });
}

/** The ops day a candidate's expiry clock runs from: the day it was
 * re-opened, else its first offer. */
function clockDay(c: Pick<CandidateRow, "offered_day" | "reopened_day">): string {
  return c.reopened_day ?? c.offered_day ?? "";
}

function writeAtomic(path: string, body: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, body);
  renameSync(tmp, path);
}

export class Learner {
  private readonly store: StateStore;
  private readonly cfg: LearnerConfig;
  private readonly now: () => Date;
  private readonly log: (msg: string, extra?: unknown) => void;
  private mining: Promise<MineReport> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  /** The last complete read of the lessons in force. */
  private lessonsRead: { lessons: IndexedLesson[]; complete: boolean; at: string } | null = null;

  constructor(private readonly deps: LearnerDeps) {
    this.store = deps.store;
    this.cfg = { ...LEARNER_DEFAULTS, ...(deps.config ?? {}) };
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? (() => {});
    this.store.db.exec(SCHEMA);
  }

  private ts(): string {
    return this.now().toISOString();
  }

  /** The EOD date `now` falls on, in the EOD timezone. */
  private today(): string {
    return zoneDateString(this.now(), this.deps.timeZone);
  }

  private mark(key: string): string | null {
    const row = this.store.db.prepare("SELECT value FROM learner_marks WHERE key = ?").get(key) as
      { value: string | null } | undefined;
    return row ? (row.value ?? "") : null;
  }

  private setMark(key: string, value: string): void {
    this.store.db
      .prepare(
        "INSERT INTO learner_marks (key, value, at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, at = excluded.at",
      )
      .run(key, value, this.ts());
  }

  // ---- 1. mine ---------------------------------------------------------------

  /** Insert drafts; returns how many were new per source. */
  private insert(drafts: readonly CandidateDraft[]): Partial<Record<CandidateSource, number>> {
    const at = this.ts();
    const stmt = this.store.db.prepare(
      `INSERT OR IGNORE INTO lesson_candidates
         (ref, source, kind, polarity, class, lens_ids, pr, round_no, finding_key, path, line,
          summary, quote, evidence, occurred_at, mined_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const added: Partial<Record<CandidateSource, number>> = {};
    this.store.db.transaction(() => {
      for (const d of drafts) {
        const r = stmt.run(
          d.ref,
          d.source,
          d.kind,
          d.polarity,
          d.class,
          JSON.stringify(d.lens_ids),
          d.pr,
          d.round_no,
          d.finding_key,
          d.path,
          d.line,
          d.summary,
          d.quote,
          JSON.stringify(d.evidence),
          d.occurred_at,
          at,
          at,
        );
        if (r.changes > 0) added[d.source] = (added[d.source] ?? 0) + 1;
      }
    })();
    return added;
  }

  /**
   * Mine every source once (single-flight: a mine already running is joined,
   * never doubled). A source that throws is reported in `errors`; the others
   * still land.
   */
  mine(): Promise<MineReport> {
    if (this.mining) return this.mining;
    this.mining = this.mineOnce().finally(() => {
      this.mining = null;
    });
    return this.mining;
  }

  private async mineOnce(): Promise<MineReport> {
    const now = this.now();
    const since = new Date(now.getTime() - this.cfg.lessons_mine_days * DAY_MS).toISOString();
    const report: MineReport = {
      added: 0,
      seen: {},
      added_by_source: {},
      recall: null,
      digest: null,
      fates: { revised: 0, withdrawn: 0, reinstated: 0 },
      relinked: 0,
      errors: [],
    };
    const drafts: CandidateDraft[] = [];
    const run = (name: string, fn: () => CandidateDraft[]): void => {
      try {
        drafts.push(...fn());
      } catch (err) {
        report.errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    run("fates", () => mineFates(this.store, since));
    // The ledger before the tagged comments: a [feedback] comment the ledger
    // holds is a `feedback_comment`; only a drained one is a `tagged_comment`.
    run("feedback", () => mineFeedback(this.store, since));
    run("tagged comments", () => mineTaggedComments(this.store, since));
    run("human recall", () => mineHumanRecall(this.store, since, this.deps.botLogin));
    // The recheck's own APPROVE → REQUEST_CHANGES reversals — the reviewer's
    // conclusion, so a candidate only, gated on a standing APPROVE and one per
    // (PR, head) (miner.ts header).
    run("recheck reversals", () => mineRecheckFlips(this.store, since));
    if (this.deps.git) {
      try {
        const r = await minePostMerge(this.store, {
          sinceIso: since,
          now,
          windowDays: this.cfg.lessons_recall_window_days,
          baseBranch: this.deps.baseBranch,
          git: this.deps.git,
          log: this.log,
          maxPrs: RECALL_SCAN_LIMITS.prsPerMine,
        });
        drafts.push(...r.drafts);
        report.recall = { scanned: r.scanned, unknown: r.unknown };
      } catch (err) {
        report.errors.push(`post-merge: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    for (const d of drafts) report.seen[d.source] = (report.seen[d.source] ?? 0) + 1;
    report.added_by_source = this.insert(drafts);
    try {
      report.relinked = this.relink(drafts);
    } catch (err) {
      report.errors.push(`relink: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      report.fates = this.reviseFates(since);
    } catch (err) {
      report.errors.push(`fate revision: ${err instanceof Error ? err.message : String(err)}`);
    }
    // The lost digest learnings — once, until every digest of the range was
    // read (a file that could not be read keeps it owed).
    const digestKey = `digest-backfill:${this.cfg.lessons_digest_backfill_from}..${this.cfg.lessons_digest_backfill_to}`;
    if (this.mark(digestKey) === null) {
      try {
        const d = mineDigestBackfill({
          dir: join(this.deps.root, "digest"),
          from: this.cfg.lessons_digest_backfill_from,
          to: this.cfg.lessons_digest_backfill_to,
        });
        const added = this.insert(d.drafts)["digest-backfill"] ?? 0;
        report.digest = { files: d.files, absent: d.absent, unreadable: d.unreadable, added };
        report.added_by_source["digest-backfill"] = added;
        report.seen["digest-backfill"] = d.drafts.length;
        if (d.unreadable === 0) this.setMark(digestKey, JSON.stringify(report.digest));
      } catch (err) {
        report.errors.push(`digest backfill: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    report.added = Object.values(report.added_by_source).reduce((n, v) => n + (v ?? 0), 0);
    this.store.logEvent("lessons_mined", null, report);
    return report;
  }

  /**
   * An undecided `[feedback]` reply, tagged comment or deleted bot comment
   * takes its class, lens and anchor from the outcome capture's link of the
   * bot comment it answered — a link the reconcile sweep or the case backfill
   * may make only after the candidate was mined, and `INSERT OR IGNORE` never
   * revisits a row, so it would stay `feedback.general` with no lens for good.
   * Every mine re-derives them from today's drafts, as `reviseFates` does for
   * fates. Decided candidates are history. A ref two routes both drafted
   * takes its FIRST draft, as the insert does: the ledger's before the
   * tagged comment's.
   */
  private relink(drafts: readonly CandidateDraft[]): number {
    const stmt = this.store.db.prepare(
      `UPDATE lesson_candidates SET class = ?, lens_ids = ?, round_no = ?, finding_key = ?, path = ?,
         line = ?, summary = ?, evidence = ?, updated_at = ?
       WHERE ref = ? AND status = 'open' AND source IN ('feedback', 'tagged-comment')
         AND (class IS NOT ? OR lens_ids IS NOT ? OR round_no IS NOT ? OR finding_key IS NOT ?
              OR path IS NOT ? OR line IS NOT ? OR summary IS NOT ?)`,
    );
    const at = this.ts();
    let n = 0;
    const seen = new Set<string>();
    this.store.db.transaction(() => {
      for (const d of drafts) {
        if (d.source !== "feedback" && d.source !== "tagged-comment") continue;
        if (seen.has(d.ref)) continue;
        seen.add(d.ref);
        const lens = JSON.stringify(d.lens_ids);
        n += stmt.run(
          d.class,
          lens,
          d.round_no,
          d.finding_key,
          d.path,
          d.line,
          d.summary,
          JSON.stringify(d.evidence),
          at,
          d.ref,
          d.class,
          lens,
          d.round_no,
          d.finding_key,
          d.path,
          d.line,
          d.summary,
        ).changes;
      }
    })();
    return n;
  }

  /**
   * Post-merge recall between mines (`RECALL_SCAN_LIMITS.prsPerTick` PRs and
   * `budgetMs` a tick): the day's mine alone reads too few merged PRs to keep
   * up with the merge rate or drain a backlog. Git only, read-only; what it
   * finds is inserted at once and offered by the next packet. Never throws.
   */
  private async recallStep(): Promise<void> {
    if (!this.deps.git) return;
    const now = this.now();
    const since = new Date(now.getTime() - this.cfg.lessons_mine_days * DAY_MS).toISOString();
    try {
      const r = await minePostMerge(this.store, {
        sinceIso: since,
        now,
        windowDays: this.cfg.lessons_recall_window_days,
        baseBranch: this.deps.baseBranch,
        git: this.deps.git,
        log: this.log,
        maxPrs: RECALL_SCAN_LIMITS.prsPerTick,
        budgetMs: RECALL_SCAN_LIMITS.budgetMs,
      });
      const added = this.insert(r.drafts).recall ?? 0;
      if (r.scanned > 0 || added > 0)
        this.log(
          `learner: post-merge recall read ${r.scanned} merged PR(s), ${added} new candidate(s)${r.unknown ? `, ${r.unknown} unknown` : ""}`,
        );
    } catch (err) {
      this.log("learner: post-merge recall failed", err);
    }
  }

  /**
   * Re-read the undecided fate candidates against the outcome capture's
   * outcomes as they stand (`reviewFateCandidates`): the capture re-decides a
   * fate on every pass and may join a posting to an earlier chain later, so a
   * candidate minted once is never trusted as written. One whose chain still
   * holds a candidate fate is revised in place (its kind, polarity and summary
   * follow the fate); one that no longer does is withdrawn — recorded on the
   * row, in an event and in the mine's report, never deleted; and a withdrawn
   * one whose chain holds a candidate fate again is reinstated (its ref is
   * the same, so the mine's insert could not bring it back). Queued and
   * offered candidates alike; a
   * decided one is history and is left as it is.
   */
  private reviseFates(sinceIso: string): MineReport["fates"] {
    const db = this.store.db;
    const rows = this.candidates(
      "source = 'fate' AND (status = 'open' OR (status = 'withdrawn' AND decided_at >= ?)) ORDER BY id",
      sinceIso,
    );
    const out = { revised: 0, withdrawn: 0, reinstated: 0 };
    if (rows.length === 0) return out;
    const reviews = reviewFateCandidates(this.store, rows);
    const at = this.ts();
    const day = this.today();
    const changes: Array<{ id: number; change: string; why?: string }> = [];
    const refresh = (c: CandidateRow, d: CandidateDraft) => [
      d.kind,
      d.polarity,
      d.class,
      JSON.stringify(d.lens_ids),
      d.summary,
      d.quote,
      JSON.stringify(d.evidence),
      // The event's time moves only with its fate: a recurrence window
      // counts the human outcome, not the capture's re-reading of it.
      d.kind !== c.kind ? d.occurred_at : c.occurred_at,
    ];
    db.transaction(() => {
      for (const c of rows) {
        const r = reviews.get(c.id);
        if (!r) continue;
        if (r.kind === "gone") {
          if (c.status !== "open") continue;
          db.prepare(
            `UPDATE lesson_candidates SET status = 'withdrawn', decided_at = ?, decided_day = ?, reason = ?, updated_at = ?
              WHERE id = ? AND status = 'open'`,
          ).run(at, day, `withdrawn: ${r.why}`, at, c.id);
          out.withdrawn += 1;
          changes.push({ id: c.id, change: "withdrawn", why: r.why });
          continue;
        }
        const d = r.draft;
        if (c.status === "withdrawn") {
          db.prepare(
            `UPDATE lesson_candidates SET status = 'open', decided_at = NULL, decided_day = NULL, reason = ?,
               reopened_day = CASE WHEN offered_day IS NULL THEN NULL ELSE ? END,
               kind = ?, polarity = ?, class = ?, lens_ids = ?, summary = ?, quote = ?, evidence = ?,
               occurred_at = ?, updated_at = ?
             WHERE id = ? AND status = 'withdrawn'`,
          ).run(`reinstated: its fate is ${d.kind} again`, day, ...refresh(c, d), at, c.id);
          out.reinstated += 1;
          changes.push({ id: c.id, change: "reinstated" });
          continue;
        }
        if (
          d.kind === c.kind &&
          d.polarity === c.polarity &&
          d.class === c.class &&
          d.summary === c.summary &&
          d.quote === c.quote
        )
          continue;
        db.prepare(
          `UPDATE lesson_candidates SET kind = ?, polarity = ?, class = ?, lens_ids = ?, summary = ?, quote = ?,
             evidence = ?, occurred_at = ?, updated_at = ?
           WHERE id = ? AND status = 'open'`,
        ).run(...refresh(c, d), at, c.id);
        out.revised += 1;
        changes.push({ id: c.id, change: d.kind !== c.kind ? `${c.kind} → ${d.kind}` : "revised" });
      }
    })();
    if (changes.length > 0) this.store.logEvent("lesson_candidates_revised", null, { changes });
    return out;
  }

  // ---- 2. the packet ---------------------------------------------------------

  private candidates(where: string, ...args: unknown[]): CandidateRow[] {
    return this.store.db
      .prepare(`SELECT * FROM lesson_candidates WHERE ${where}`)
      .all(...args) as CandidateRow[];
  }

  /** Read the lessons in force (experiences/), bounded; null when memory is
   * off, unhealthy or does not answer in time. Remembers a complete read. */
  private async readLessons(): Promise<{ lessons: IndexedLesson[]; complete: boolean } | null> {
    if (!this.deps.lessons) return null;
    if (this.deps.healthy && !this.deps.healthy()) return null;
    const res = await withTimeout(this.deps.lessons.sweep(), LESSON_READ_BUDGET_MS, (err) =>
      this.log("learner: the lessons read failed", err),
    );
    if (res === "timeout") return null;
    const lessons: IndexedLesson[] = [];
    for (const e of res.entries) {
      if (areaOfId(e.id) !== EXPERIENCES_AREA) continue;
      const p = parseLesson(e.text);
      if (p) lessons.push({ ...p, id: e.id });
    }
    // Newest first (ids carry their stamp), so a coverage list leads with the
    // freshest lesson.
    lessons.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    const complete = res.unread.length === 0;
    if (complete) this.lessonsRead = { lessons, complete, at: this.ts() };
    return { lessons, complete };
  }

  /** Per class, the candidates whose event fell in the window, whatever
   * became of them — offered, queued, decided or expired — except the
   * withdrawn (minted from an outcome that has since changed). */
  private recurrence(sinceIso: string): Map<string, number> {
    return new Map(
      (
        this.store.db
          .prepare(
            "SELECT class, COUNT(*) AS n FROM lesson_candidates WHERE occurred_at >= ? AND status <> 'withdrawn' GROUP BY class",
          )
          .all(sinceIso) as Array<{ class: string; n: number }>
      ).map((r) => [r.class, r.n]),
    );
  }

  /** Per class, the posted findings humans fixed and left open in the
   * window — the counterweight a cluster shows. */
  private counterweights(sinceIso: string): Map<string, { fixed: number; ignored: number }> {
    const out = new Map<string, { fixed: number; ignored: number }>();
    const has = this.store.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'finding_outcomes'")
      .get();
    if (!has) return out;
    const rows = this.store.db
      .prepare(
        `SELECT o.fate, f.lens_ids, f.lens, f.kind FROM finding_outcomes o
           JOIN round_findings f ON f.pr = o.pr AND f.round_no = o.round_no AND f.finding_key = o.finding_key
          WHERE o.fate IN ('fixed', 'open_at_close') AND o.carried_to IS NULL
            AND COALESCE(o.decided_at, o.fate_changed_at) >= ?`,
      )
      .all(sinceIso) as Array<{
      fate: string;
      lens_ids: string | null;
      lens: string;
      kind: string | null;
    }>;
    for (const r of rows) {
      // The same class rule the miner applies to a candidate's finding.
      const cls = findingClass(lensIdsOf(r.lens_ids, r.lens), r.kind);
      const c = out.get(cls) ?? { fixed: 0, ignored: 0 };
      if (r.fate === "fixed") c.fixed += 1;
      else c.ignored += 1;
      out.set(cls, c);
    }
    return out;
  }

  /**
   * Build and write the packet for EOD day `day`: expire, offer, carry,
   * cluster. Idempotent per day — a second build (a retried fire) offers no
   * more than the day's cap and expires nothing twice.
   */
  async buildPacket(day: string): Promise<OutcomesPacket> {
    const at = this.ts();
    const db = this.store.db;
    // Expire: offered, undecided, past the window — counted from its first
    // offer, or from the day a refused write or an unfound adoption re-opened
    // it (that candidate was promised the next packet, and gets a full window).
    const expired: ExpiredCandidate[] = [];
    for (const c of this.candidates("status = 'open' AND offered_day IS NOT NULL")) {
      if (dayDiff(clockDay(c), day) < this.cfg.lessons_expiry_ops_days) continue;
      db.prepare(
        `UPDATE lesson_candidates SET status = 'expired', decided_at = ?, decided_day = ?, reason = ?, updated_at = ?
          WHERE id = ? AND status = 'open'`,
      ).run(
        at,
        day,
        c.reopened_day
          ? `undecided ${this.cfg.lessons_expiry_ops_days} ops days after it was re-opened (${c.reopened_day}; first offered ${c.offered_day})`
          : `undecided ${this.cfg.lessons_expiry_ops_days} ops days after it was first offered (${c.offered_day})`,
        at,
        c.id,
      );
      expired.push({
        id: c.id,
        label: candidateLabel(c.id),
        class: c.class,
        summary: c.summary,
        offered_day: c.offered_day!,
      });
    }
    const newlyExpired = expired.length;
    // Candidates expired by an earlier build of the same day stay listed —
    // the ones its record lists, and the ones its expiry committed before
    // that build was cut short (the rows say so: expired on this day).
    const prior = this.curation(day);
    const priorExpired = prior ? json<number[]>(prior.expired, []) : [];
    const expiredOnDay = this.candidates("status = 'expired' AND decided_day = ? ORDER BY id", day);
    for (const id of [...priorExpired, ...expiredOnDay.map((c) => c.id)]) {
      if (expired.some((e) => e.id === id)) continue;
      const c = this.candidates("id = ?", id)[0];
      if (c)
        expired.push({
          id: c.id,
          label: candidateLabel(c.id),
          class: c.class,
          summary: c.summary,
          offered_day: c.offered_day ?? day,
        });
    }
    if (newlyExpired > 0)
      this.store.logEvent("lesson_candidates_expired", null, {
        day,
        ids: expired.map((e) => e.id),
        after_ops_days: this.cfg.lessons_expiry_ops_days,
      });
    // Offer: queued candidates, look-for first, up to the day's cap — the
    // reviewer's own recheck reversals after every other source, so its own
    // conclusions never crowd a person's outcome out of the packet.
    const offeredToday = (
      db.prepare("SELECT COUNT(*) AS n FROM lesson_candidates WHERE offered_day = ?").get(day) as {
        n: number;
      }
    ).n;
    const slots = Math.max(0, this.cfg.lessons_packet_new_max - offeredToday);
    if (slots > 0) {
      const fresh = db
        .prepare(
          `SELECT id FROM lesson_candidates WHERE status = 'open' AND offered_day IS NULL
            ORDER BY CASE source WHEN 'recheck' THEN 1 ELSE 0 END,
                     CASE polarity WHEN 'look-for' THEN 0 ELSE 1 END,
                     CASE source WHEN 'recall' THEN 0 WHEN 'fate' THEN 1 WHEN 'feedback' THEN 2
                                 WHEN 'tagged-comment' THEN 2 ELSE 3 END,
                     occurred_at DESC, id
            LIMIT ?`,
        )
        .all(slots) as Array<{ id: number }>;
      const offer = db.prepare(
        "UPDATE lesson_candidates SET offered_day = ?, updated_at = ? WHERE id = ? AND offered_day IS NULL",
      );
      db.transaction(() => {
        for (const f of fresh) offer.run(day, at, f.id);
      })();
    }
    // Carry: every offered candidate still undecided rides today's packet.
    db.prepare(
      `UPDATE lesson_candidates SET offers = offers + 1, last_offered_day = ?, updated_at = ?
        WHERE status = 'open' AND offered_day IS NOT NULL AND (last_offered_day IS NULL OR last_offered_day <> ?)`,
    ).run(day, at, day);
    const offered = this.candidates(
      "status = 'open' AND offered_day IS NOT NULL ORDER BY class, occurred_at DESC, id",
    );
    const queued = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM lesson_candidates WHERE status = 'open' AND offered_day IS NULL",
        )
        .get() as { n: number }
    ).n;

    // Cluster, with recurrence, the counterweight and coverage.
    const since = new Date(
      this.now().getTime() - this.cfg.lessons_recurrence_days * DAY_MS,
    ).toISOString();
    const recurrence = this.recurrence(since);
    const weights = this.counterweights(since);
    const read = await this.readLessons();
    const byClass = new Map<string, CandidateRow[]>();
    for (const c of offered) byClass.set(c.class, [...(byClass.get(c.class) ?? []), c]);
    const toPacket = (c: CandidateRow): PacketCandidate => ({
      id: c.id,
      label: candidateLabel(c.id),
      kind: c.kind,
      source: c.source,
      polarity: c.polarity,
      class: c.class,
      lens_ids: json<string[]>(c.lens_ids, []),
      pr: c.pr,
      path: c.path,
      line: c.line,
      summary: c.summary,
      quote: c.quote,
      evidence: json<string[]>(c.evidence, []),
      occurred_at: c.occurred_at,
      offered_day: c.offered_day!,
      expires_after: addDays(clockDay(c), this.cfg.lessons_expiry_ops_days - 1),
      new: c.offered_day === day,
    });
    // A partial read proves nothing absent: the lessons it found do cover the
    // class, but "none found" is unknown, and a balance over part of memory
    // is no balance at all.
    const coverage = (cls: string, lensIds: readonly string[]): string[] | null => {
      if (!read) return null;
      const found = coveringLessons(read.lessons, cls, lensIds);
      return read.complete || found.length > 0 ? found : null;
    };
    const clusters: PacketCluster[] = [...byClass.entries()].map(([cls, rows]) => {
      const lensIds = [...new Set(rows.flatMap((r) => json<string[]>(r.lens_ids, [])))];
      const w = weights.get(cls) ?? { fixed: 0, ignored: 0 };
      return {
        class: cls,
        polarity: majorityPolarity(rows),
        recurrence: recurrence.get(cls) ?? rows.length,
        fixed: w.fixed,
        ignored: w.ignored,
        covering: coverage(cls, lensIds),
        candidates: rows.map(toPacket),
      };
    });
    // The reviewer's own recheck reversals after every other cluster —
    // the same demotion as the first offer, because a busy reversal class
    // would otherwise lead the packet on recurrence alone; then misses first,
    // then the busiest classes.
    const reviewerOnly = (c: PacketCluster): boolean =>
      c.candidates.every((x) => x.source === "recheck");
    clusters.sort(
      (a, b) =>
        Number(reviewerOnly(a)) - Number(reviewerOnly(b)) ||
        Number(b.polarity === "look-for") - Number(a.polarity === "look-for") ||
        b.recurrence - a.recurrence ||
        a.class.localeCompare(b.class),
    );
    const fresh = offered.filter((c) => c.offered_day === day).length;
    const packet: OutcomesPacket = {
      day,
      generated_at: at,
      expiry_ops_days: this.cfg.lessons_expiry_ops_days,
      recurrence_days: this.cfg.lessons_recurrence_days,
      offered: offered.length,
      new: fresh,
      carried: offered.length - fresh,
      queued,
      expired,
      balance: read?.complete ? lessonBalance(read.lessons) : null,
      lessons_read: !this.deps.lessons
        ? "off"
        : read === null
          ? "unreadable"
          : read.complete
            ? "ok"
            : "partial",
      clusters,
    };
    const dir = join(this.deps.root, packetRelDir(day));
    mkdirSync(dir, { recursive: true });
    writeAtomic(join(dir, "outcomes.json"), `${JSON.stringify(packet, null, 2)}\n`);
    writeAtomic(join(dir, "outcomes.md"), renderPacketMarkdown(packet));
    db.prepare(
      `INSERT INTO eod_curations (day, packet_at, offered, new_today, expired, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(day) DO UPDATE SET packet_at = excluded.packet_at, offered = excluded.offered,
         new_today = excluded.new_today, expired = excluded.expired, updated_at = excluded.updated_at`,
    ).run(
      day,
      at,
      JSON.stringify(offered.map((c) => c.id)),
      JSON.stringify(offered.filter((c) => c.offered_day === day).map((c) => c.id)),
      JSON.stringify(expired.map((e) => e.id)),
      at,
    );
    this.store.logEvent("eod_packet_written", null, {
      day,
      offered: packet.offered,
      new: packet.new,
      carried: packet.carried,
      queued,
      expired: expired.length,
      lessons_read: packet.lessons_read,
    });
    return packet;
  }

  /**
   * The EOD sweep's day context (wire.ts → `dayContext`): mine first when the
   * day's mine has not run (bounded — a slow git read never holds the sweep),
   * then build the packet. `lines` is the pointer the digest carries;
   * `curation` the instructions the prompt renders after the seed.
   */
  async prepareEod(
    day: string,
  ): Promise<{ lines: string; curation: string; packet: OutcomesPacket }> {
    if (this.mark(`mined:${day}`) === null) {
      const r = await withTimeout(this.mine(), PREPARE_MINE_BUDGET_MS, (err) =>
        this.log("learner: the EOD mine failed", err),
      );
      if (r !== "timeout") this.setMark(`mined:${day}`, this.ts());
    }
    const packet = await this.buildPacket(day);
    return { lines: packetPointer(packet), curation: renderCurationSection(packet), packet };
  }

  /** The sweep for `day` reached the overseer (`EodTimerDeps.onFire`): the
   * receipt is owed from now. */
  eodFired(day: string): void {
    const at = this.ts();
    this.store.db
      .prepare(
        `INSERT INTO eod_curations (day, fired_at, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(day) DO UPDATE SET fired_at = excluded.fired_at, updated_at = excluded.updated_at`,
      )
      .run(day, at, at);
  }

  private curation(day: string): CurationRow | undefined {
    return this.store.db.prepare("SELECT * FROM eod_curations WHERE day = ?").get(day) as
      CurationRow | undefined;
  }

  // ---- 3. the receipt -----------------------------------------------------------

  /**
   * Apply a validated `eod-curation-receipt`. All or nothing: a day with no
   * packet, a candidate id the learner never minted, or one that day's packet
   * did not offer, refuses the whole receipt (the curator fixes it and writes
   * it again) — a receipt decides what its packet put in front of the
   * curator, never a queued candidate nobody showed it. `adopted` waits for
   * memory to show the lesson (`adopting`);
   * `declined` is final; `refused` keeps the candidate open and wakes
   * `eod_lessons_not_persisted` at once. A candidate already settled since
   * the packet — adopted (memory showed its lesson), withdrawn or expired —
   * keeps its status whatever the receipt says: memory's evidence and the
   * learner's own record outrank a later claim (only `refused` re-opens an
   * expired one, with a fresh clock).
   */
  applyReceipt(receipt: CurationReceipt): FileOutcome {
    const row = this.curation(receipt.day);
    if (!row?.packet_at)
      return { ok: false, reason: `no outcomes packet was written for ${receipt.day}` };
    const ids = receipt.decisions.flatMap((d) => d.candidates);
    const offered = new Set(json<number[]>(row.offered, []));
    const known = new Set(
      ids.length === 0
        ? []
        : (
            this.store.db
              .prepare(
                `SELECT id FROM lesson_candidates WHERE id IN (${ids.map(() => "?").join(",")})`,
              )
              .all(...ids) as Array<{ id: number }>
          ).map((r) => r.id),
    );
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length > 0)
      return {
        ok: false,
        reason: `unknown candidate id(s): ${unknown.map(candidateLabel).join(", ")} — nothing was recorded; send the receipt again without them`,
      };
    const notOffered = ids.filter((id) => !offered.has(id));
    if (notOffered.length > 0)
      return {
        ok: false,
        reason: `candidate id(s) the ${receipt.day} packet did not offer: ${notOffered.map(candidateLabel).join(", ")} — nothing was recorded; decide only what that packet offered`,
      };
    const at = this.ts();
    const today = this.today();
    const db = this.store.db;
    const counts = { adopted: 0, declined: 0, refused: 0 };
    const refused: Array<{ id: number; why: string }> = [];
    db.transaction(() => {
      for (const d of receipt.decisions) {
        for (const id of d.candidates) {
          if (d.decision === "adopted") {
            // An adoption memory already showed stands; an undecided one
            // waits for the lesson to be found; a settled one is left alone.
            db.prepare(
              `UPDATE lesson_candidates SET status = CASE WHEN status IN ('open', 'adopting') THEN 'adopting' ELSE status END,
                 receipt_day = ?, receipt_at = ?, claimed_lesson = ?, reason = COALESCE(?, reason), updated_at = ?
               WHERE id = ?`,
            ).run(receipt.day, at, d.lesson ?? null, d.reason ?? null, at, id);
            counts.adopted += 1;
          } else if (d.decision === "declined") {
            // Only an undecided candidate is declined: a declination never
            // overwrites a memory-verified adoption, a withdrawal or an expiry.
            db.prepare(
              `UPDATE lesson_candidates SET status = 'declined', decided_at = ?, decided_day = ?, reason = ?,
                 receipt_day = ?, receipt_at = ?, updated_at = ? WHERE id = ? AND status IN ('open', 'adopting')`,
            ).run(at, receipt.day, d.reason ?? null, receipt.day, at, at, id);
            db.prepare(
              "UPDATE lesson_candidates SET receipt_day = ?, receipt_at = ?, updated_at = ? WHERE id = ? AND status NOT IN ('open', 'adopting', 'declined')",
            ).run(receipt.day, at, at, id);
            counts.declined += 1;
          } else {
            // A refused write puts the candidate back in the packet with a
            // fresh expiry clock (it was promised the next packet); one
            // already adopted, declined or withdrawn stays as it is.
            const before = (
              db.prepare("SELECT status FROM lesson_candidates WHERE id = ?").get(id) as {
                status: CandidateStatus;
              }
            ).status;
            const keep =
              (SETTLED_STATUSES as readonly string[]).includes(before) && before !== "expired";
            if (keep)
              db.prepare(
                "UPDATE lesson_candidates SET receipt_day = ?, receipt_at = ?, updated_at = ? WHERE id = ?",
              ).run(receipt.day, at, at, id);
            else
              db.prepare(
                `UPDATE lesson_candidates SET status = 'open', reopened_day = ?, decided_at = NULL, decided_day = NULL,
                   reason = ?, receipt_day = ?, receipt_at = ?, updated_at = ? WHERE id = ?`,
              ).run(today, `write refused: ${d.reason ?? ""}`, receipt.day, at, at, id);
            counts.refused += 1;
            if (!keep)
              refused.push({
                id,
                why: `the curator reported the write refused: ${d.reason ?? "no reason"}`,
              });
          }
        }
      }
      db.prepare(
        "UPDATE eod_curations SET receipt_at = ?, receipt = ?, updated_at = ? WHERE day = ?",
      ).run(
        at,
        JSON.stringify({ ...counts, decisions: receipt.decisions.length }),
        at,
        receipt.day,
      );
    })();
    this.store.logEvent("eod_curation_receipt", null, { day: receipt.day, ...counts });
    if (refused.length > 0) this.notPersisted(receipt.day, refused);
    return { ok: true, day: receipt.day, ...counts };
  }

  /** Record adoptions memory does not hold / writes refused, and wake when
   * the list names something no earlier wake named. */
  private notPersisted(day: string, items: Array<{ id: number; why: string }>): void {
    const row = this.curation(day);
    const prev = json<Array<{ id: number; why: string }>>(row?.not_persisted, []);
    const merged = [...prev];
    for (const i of items)
      if (!merged.some((m) => m.id === i.id && m.why === i.why)) merged.push(i);
    const woken = new Set(json<string[]>(row?.not_persisted_woken, []));
    const key = (m: { id: number; why: string }) => `${m.id}:${m.why}`;
    const fresh = merged.filter((m) => !woken.has(key(m)));
    const at = this.ts();
    // The incident starts when the day's list goes from empty to non-empty.
    const since = prev.length > 0 && row?.not_persisted_since ? row.not_persisted_since : at;
    this.store.db
      .prepare(
        `INSERT INTO eod_curations (day, not_persisted, not_persisted_since, not_persisted_woken, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(day) DO UPDATE SET not_persisted = excluded.not_persisted,
           not_persisted_since = excluded.not_persisted_since,
           not_persisted_woken = excluded.not_persisted_woken, updated_at = excluded.updated_at`,
      )
      .run(day, JSON.stringify(merged), since, JSON.stringify([...woken, ...fresh.map(key)]), at);
    if (fresh.length === 0) return;
    const labels = merged.map((m) => candidateLabel(m.id)).join(", ");
    this.deps.wake?.(
      LEARNER_WAKE.notPersisted,
      `EOD ${day}: ${merged.length} lesson(s) not persisted (${labels})`,
      [
        `EOD LESSONS NOT PERSISTED — the curation of ${day} did not land ${merged.length} lesson(s) in reviewer memory: ${labels}.`,
        ...merged.slice(0, 8).map((m) => `- ${candidateLabel(m.id)}: ${m.why.slice(0, 200)}`),
        "The candidates are open again and ride the next outcomes packet. Check memory health (`qcr status`) and the overseer's viking_write answers; a lesson counts only once its typed header cites the candidate (`cand:c<id>`).",
      ].join("\n"),
    );
  }

  // ---- 4. the tick: mine on time, verify, and wake when the receipt is late ----

  /** When today's mine is due: `lessons_mine_lead_min` before the EOD time. */
  private mineDueAt(): number {
    const p = zonedParts(this.now(), this.deps.timeZone);
    const { hour, minute } = parseHHMM(this.deps.eodTime);
    const fire = localWallClockToInstant(p.year, p.month, p.day, hour, minute, this.deps.timeZone);
    return fire.getTime() - this.cfg.lessons_mine_lead_min * 60_000;
  }

  /** One pass: the day's mine when due, the missing-receipt check, and the
   * verification of adoptions against memory. Never throws. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const day = this.today();
      if (this.now().getTime() >= this.mineDueAt() && this.mark(`mined:${day}`) === null) {
        try {
          const r = await this.mine();
          this.setMark(`mined:${day}`, this.ts());
          this.log(
            `learner: mined ${r.added} new lesson candidate(s) for ${day}${r.errors.length ? ` (${r.errors.length} source error(s))` : ""}`,
          );
        } catch (err) {
          this.log("learner: mine failed", err);
        }
      }
      await this.recallStep();
      try {
        this.checkMissing();
      } catch (err) {
        this.log("learner: receipt check failed", err);
      }
      try {
        await this.verify();
      } catch (err) {
        this.log("learner: verification failed", err);
      }
    } finally {
      this.ticking = false;
    }
  }

  /** Wake `eod_curation_missing` once per day whose delivered sweep offered
   * candidates and drew no receipt within the wait. */
  checkMissing(): void {
    const now = this.now().getTime();
    const waitMs = this.cfg.lessons_receipt_wait_min * 60_000;
    const rows = this.store.db
      .prepare(
        `SELECT * FROM eod_curations WHERE fired_at IS NOT NULL AND receipt_at IS NULL
           AND missing_woken_at IS NULL ORDER BY day DESC LIMIT 7`,
      )
      .all() as CurationRow[];
    for (const r of rows) {
      const offered = json<number[]>(r.offered, []);
      if (offered.length === 0) continue;
      const fired = Date.parse(r.fired_at!);
      if (!Number.isFinite(fired) || now - fired < waitMs) continue;
      const at = this.ts();
      this.store.db
        .prepare("UPDATE eod_curations SET missing_woken_at = ?, updated_at = ? WHERE day = ?")
        .run(at, at, r.day);
      this.deps.wake?.(
        LEARNER_WAKE.missing,
        `EOD ${r.day}: no curation receipt ${this.cfg.lessons_receipt_wait_min} min after the sweep`,
        [
          `EOD CURATION MISSING — the EOD sweep for ${r.day} was delivered at ${r.fired_at}, its outcomes packet offered ${offered.length} candidate(s) (\`${packetRelDir(r.day)}/outcomes.md\`), and no \`eod-curation-receipt\` arrived within ${this.cfg.lessons_receipt_wait_min} minutes.`,
          "Nothing says the day's outcomes were curated. The candidates stay open and ride the next packet; undecided, they expire (recorded). Check the overseer session, then curate the packet and write the receipt.",
        ].join("\n"),
      );
    }
  }

  /**
   * Check adoptions against memory (only while it reads healthy): a lesson
   * in `experiences/` whose typed header cites a candidate adopts it — with or
   * without a receipt. An `adopting` candidate whose receipt is older than the
   * grace, with memory read in full and no lesson citing it, was not
   * persisted: it goes back to open and wakes. A partial read proves nothing
   * absent.
   */
  async verify(): Promise<void> {
    try {
      await this.verifyAgainstMemory();
    } finally {
      // State.db only: a decided candidate leaves the lists even while memory
      // cannot be read.
      this.pruneNotPersisted();
    }
  }

  private async verifyAgainstMemory(): Promise<void> {
    const waiting = (
      this.store.db
        .prepare(
          "SELECT COUNT(*) AS n FROM lesson_candidates WHERE status = 'adopting' OR (status = 'open' AND offered_day IS NOT NULL)",
        )
        .get() as { n: number }
    ).n;
    // Memory is read every tick while an adoption waits to be checked or an
    // offered candidate may be adopted by a lesson written without a receipt
    // (the store's sweep is incremental: an unchanged file is not re-read),
    // and otherwise every `LESSON_REFRESH_MS`, for the balance metric.
    const last = this.lessonsRead ? Date.parse(this.lessonsRead.at) : NaN;
    if (waiting === 0 && Number.isFinite(last) && this.now().getTime() - last < LESSON_REFRESH_MS)
      return;
    const pending = this.candidates("status IN ('open', 'adopting')");
    const read = await this.readLessons();
    if (!read) return;
    const cited = new Map<number, string[]>();
    for (const l of read.lessons)
      for (const id of l.candidates) cited.set(id, [...(cited.get(id) ?? []), l.id]);
    const at = this.ts();
    const db = this.store.db;
    const missingByDay = new Map<string, Array<{ id: number; why: string }>>();
    // `pending` was read before the memory read awaited: a receipt applied
    // meanwhile may have settled a candidate or re-dated its adoption, so
    // every write below holds only against the state it was decided from.
    for (const c of pending) {
      const lessons = cited.get(c.id);
      if (lessons) {
        db.prepare(
          `UPDATE lesson_candidates SET status = 'adopted', lesson_ids = ?, decided_at = COALESCE(decided_at, ?),
             decided_day = COALESCE(decided_day, receipt_day, ?), updated_at = ?
           WHERE id = ? AND status IN ('open', 'adopting')`,
        ).run(JSON.stringify(lessons), at, this.today(), at, c.id);
        continue;
      }
      if (c.status !== "adopting" || !read.complete) continue;
      const receiptAt = Date.parse(c.receipt_at ?? "");
      if (!Number.isFinite(receiptAt) || this.now().getTime() - receiptAt < VERIFY_GRACE_MS)
        continue;
      // Back to the packet, with a fresh expiry clock: the wake promised the
      // next packet, and a candidate first offered days ago must not expire
      // at it.
      const reopened = db
        .prepare(
          `UPDATE lesson_candidates SET status = 'open', reopened_day = ?, reason = ?, updated_at = ?
           WHERE id = ? AND status = 'adopting' AND receipt_at IS ?`,
        )
        .run(
          this.today(),
          `the receipt of ${c.receipt_day} said adopted, but no lesson in experiences/ cites cand:${candidateLabel(c.id)}`,
          at,
          c.id,
          c.receipt_at,
        );
      if (reopened.changes === 0) continue;
      const day = c.receipt_day ?? this.today();
      missingByDay.set(day, [
        ...(missingByDay.get(day) ?? []),
        {
          id: c.id,
          why: `adopted${c.claimed_lesson ? ` as ${c.claimed_lesson}` : ""}, but no lesson in experiences/ cites cand:${candidateLabel(c.id)}`,
        },
      ]);
    }
    for (const [day, items] of missingByDay) this.notPersisted(day, items);
  }

  /** A candidate decided since leaves the not-persisted lists it was on: the
   * lesson landed after all (adopted — a retry, the next day's curation), or
   * the curator declined it, or it expired (recorded) or was withdrawn. What
   * stays on a list is still a lesson nobody has made good. */
  private pruneNotPersisted(): void {
    const db = this.store.db;
    const settled = new Set(
      (
        db
          .prepare(`SELECT id FROM lesson_candidates WHERE status IN (${SETTLED_SQL})`)
          .all() as Array<{ id: number }>
      ).map((r) => r.id),
    );
    const at = this.ts();
    for (const row of db
      .prepare("SELECT day, not_persisted FROM eod_curations WHERE not_persisted <> '[]'")
      .all() as Array<{ day: string; not_persisted: string }>) {
      const list = json<Array<{ id: number; why: string }>>(row.not_persisted, []);
      const kept = list.filter((m) => !settled.has(m.id));
      if (kept.length !== list.length)
        db.prepare(
          `UPDATE eod_curations SET not_persisted = ?,
             not_persisted_since = CASE WHEN ? = 0 THEN NULL ELSE not_persisted_since END, updated_at = ?
           WHERE day = ?`,
        ).run(JSON.stringify(kept), kept.length, at, row.day);
    }
  }

  start(intervalMs = 300_000): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), Math.max(10_000, intervalMs));
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ---- reading back ------------------------------------------------------------

  /**
   * Every curation failure not made good since, newest first, over the last
   * `UNRESOLVED_SCAN_DAYS` curation days: a `missing` day (the sweep
   * delivered, candidates offered, no receipt within the wait) until it or a
   * later day is receipted — its candidates rode the later packet, so that
   * receipt decided them or carried them on — and a `not_persisted` day until
   * every candidate on its list is decided (`pruneNotPersisted`). The next
   * day's packet does not resolve either: a failure stays in front of a
   * person until something made it good.
   */
  private unresolved(): UnresolvedCuration[] {
    const db = this.store.db;
    const rows = db
      .prepare("SELECT * FROM eod_curations ORDER BY day DESC LIMIT ?")
      .all(UNRESOLVED_SCAN_DAYS) as CurationRow[];
    const lists = new Map(
      rows.map((r) => [r.day, json<Array<{ id: number; why: string }>>(r.not_persisted, [])]),
    );
    const ids = [...new Set([...lists.values()].flatMap((l) => l.map((m) => m.id)))];
    const settled = new Set(
      ids.length === 0
        ? []
        : (
            db
              .prepare(
                `SELECT id FROM lesson_candidates WHERE status IN (${SETTLED_SQL}) AND id IN (${ids.map(() => "?").join(",")})`,
              )
              .all(...ids) as Array<{ id: number }>
          ).map((r) => r.id),
    );
    const now = this.now().getTime();
    const waitMs = this.cfg.lessons_receipt_wait_min * 60_000;
    const out: UnresolvedCuration[] = [];
    let laterReceipt = false;
    for (const r of rows) {
      const open = new Set(
        (lists.get(r.day) ?? []).filter((m) => !settled.has(m.id)).map((m) => m.id),
      );
      if (open.size > 0)
        out.push({
          day: r.day,
          state: "not_persisted",
          count: open.size,
          since: r.not_persisted_since ?? r.updated_at,
        });
      const offered = json<number[]>(r.offered, []);
      const fired = Date.parse(r.fired_at ?? "");
      if (
        !laterReceipt &&
        r.receipt_at === null &&
        offered.length > 0 &&
        Number.isFinite(fired) &&
        (r.missing_woken_at !== null || now - fired >= waitMs)
      )
        out.push({
          day: r.day,
          state: "missing",
          count: offered.length,
          since: r.missing_woken_at ?? new Date(fired + waitMs).toISOString(),
        });
      if (r.receipt_at !== null) laterReceipt = true;
    }
    return out;
  }

  /** The curation for status.json: the newest unresolved failure when there
   * is one (a missed day stays reported after the next packet is written),
   * else the latest day's. */
  status(): CurationStatus {
    const db = this.store.db;
    const count = (where: string, ...args: unknown[]): number =>
      (
        db.prepare(`SELECT COUNT(*) AS n FROM lesson_candidates WHERE ${where}`).get(...args) as {
          n: number;
        }
      ).n;
    const open = count("status = 'open' AND offered_day IS NOT NULL");
    const queued = count("status = 'open' AND offered_day IS NULL");
    const balance = this.lessonsRead
      ? { ...lessonBalance(this.lessonsRead.lessons), as_of: this.lessonsRead.at }
      : null;
    const unresolved = this.unresolved();
    const head = unresolved[0];
    const incident = unresolved[unresolved.length - 1] ?? null;
    const row = head
      ? this.curation(head.day)
      : (db
          .prepare(
            "SELECT * FROM eod_curations WHERE packet_at IS NOT NULL ORDER BY day DESC LIMIT 1",
          )
          .get() as CurationRow | undefined);
    if (!row)
      return {
        day: null,
        state: "no_packet",
        offered: 0,
        adopted: 0,
        declined: 0,
        verifying: 0,
        not_persisted: 0,
        expired_today: 0,
        open,
        queued,
        receipt_at: null,
        balance,
        unresolved,
        incident,
      };
    const offered = json<number[]>(row.offered, []);
    let state: CurationStatus["state"];
    if (head) state = head.state;
    else if (row.receipt_at !== null) state = "received";
    else if (row.fired_at === null) state = "packet_ready";
    else if (offered.length === 0) state = "nothing";
    else state = "awaiting";
    return {
      day: row.day,
      state,
      offered: offered.length,
      adopted: count("receipt_day = ? AND status = 'adopted'", row.day),
      declined: count("receipt_day = ? AND status = 'declined'", row.day),
      verifying: count("receipt_day = ? AND status = 'adopting'", row.day),
      not_persisted:
        unresolved.find((u) => u.day === row.day && u.state === "not_persisted")?.count ?? 0,
      expired_today: json<unknown[]>(row.expired, []).length,
      open,
      queued,
      receipt_at: row.receipt_at,
      balance,
      unresolved,
      incident,
    };
  }

  /** Undecided candidates per class, busiest first — `qcr lessons`. */
  clusters(): Array<{
    class: string;
    polarity: Polarity;
    open: number;
    queued: number;
    recurrence: number;
  }> {
    const since = new Date(
      this.now().getTime() - this.cfg.lessons_recurrence_days * DAY_MS,
    ).toISOString();
    const rows = this.candidates("status = 'open' ORDER BY class, id");
    const out = new Map<string, { rows: CandidateRow[]; queued: number }>();
    for (const r of rows) {
      const e = out.get(r.class) ?? { rows: [], queued: 0 };
      e.rows.push(r);
      if (r.offered_day === null) e.queued += 1;
      out.set(r.class, e);
    }
    const recurrence = this.recurrence(since);
    return [...out.entries()]
      .map(([cls, e]) => ({
        class: cls,
        polarity: majorityPolarity(e.rows),
        open: e.rows.length - e.queued,
        queued: e.queued,
        recurrence: recurrence.get(cls) ?? e.rows.length,
      }))
      .sort((a, b) => b.open + b.queued - (a.open + a.queued) || a.class.localeCompare(b.class));
  }

  /** One candidate row (tests, `qcr lessons`). */
  candidate(id: number): CandidateRow | undefined {
    return this.candidates("id = ?", id)[0];
  }

  /** Every candidate row, oldest first (tests). */
  allCandidates(): CandidateRow[] {
    return this.candidates("1 = 1 ORDER BY id");
  }
}

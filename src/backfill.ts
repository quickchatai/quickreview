// The one-shot pre-daemon history importer (M2 /).
//
// READ-ONLY against GitHub: two issue searches to enumerate the PR set, then
// one GraphQL query per PR (reviews by the bot identity + the timeline items
// triggers are reconstructed from). Nothing here mutates GitHub, so the
// MutationGate is deliberately not involved — see §4.
//
// What lands in sqlite (§2): one `rounds` row per historical bot
// review with `backfilled = 1` / `round_type = 'backfill'`, plus one
// `backfill_pr_meta` row per PR. No `pr_state` rows (they would flood the board
// and status.json) and no `events` rows (they would bury the TUI event strip
// and collide with `verdict_applied` semantics).
//
// Two rules keep the import from disturbing live behaviour:
//   * epoch cut — reviews submitted at/after the oldest natively-run round are
//     already recorded by the daemon, so they are skipped;
//   * round numbering — historical rounds are numbered *below* the PR's lowest
//     existing round_no, so MAX(round_no) and running-round lookups are inert.
import type { Config } from "./config.js";
import type { PrReviewHistory, PrTimelineRecord, SearchIssueItem } from "./github.js";
import type { StateStore } from "./state.js";

/** The read-only slice of GitHubAdapter the importer needs (test seam). */
export interface BackfillSource {
  searchIssuesPaged(q: string, maxPages?: number): Promise<SearchIssueItem[]>;
  prReviewHistory(n: number, author: string): Promise<PrReviewHistory | null>;
}

export interface BackfillOptions {
  /** Compute and report the import without writing a single row. */
  dryRun?: boolean;
  /** Cap the number of PRs fetched (smoke runs); unset = the whole set. */
  limit?: number;
  /** Progress sink — the CLI points it at stderr. */
  log?: (line: string) => void;
  now?: () => Date;
}

export interface BackfillStats {
  prs_enumerated: number;
  prs_scanned: number;
  reviews_seen: number;
  reviews_imported: number;
  skipped_epoch: number;
  skipped_existing: number;
  skipped_state: number;
  meta_rows: number;
  prs_missing: number;
  epoch: string | null;
  dry_run: boolean;
}

/** GitHub review state -> the daemon's verdict vocabulary. States absent from
 * this table (DISMISSED, PENDING) are not verdicts and are never imported. */
export const VERDICT_BY_REVIEW_STATE: Record<string, string> = {
  APPROVED: "APPROVE",
  CHANGES_REQUESTED: "REQUEST_CHANGES",
  COMMENTED: "COMMENT",
};

export function verdictForReviewState(state: string): string | null {
  return VERDICT_BY_REVIEW_STATE[state.toUpperCase()] ?? null;
}

const SUMMARY_LIMIT = 800;

// ---- enumeration -----------------------------------------------------------

export function enumerationQueries(cfg: Config): string[] {
  const repo = cfg.github.repo;
  return [
    `repo:${repo} is:pr label:"${cfg.backfill.reviewed_label}"`,
    `repo:${repo} is:pr reviewed-by:${cfg.backfill.bot_login}`,
  ];
}

/** Union of the two searches, ascending by PR number (oldest history first). */
export async function enumeratePrs(source: BackfillSource, cfg: Config): Promise<number[]> {
  const numbers = new Set<number>();
  for (const q of enumerationQueries(cfg)) {
    for (const item of await source.searchIssuesPaged(q, cfg.backfill.max_search_pages)) {
      if (Number.isInteger(item.number)) numbers.add(item.number);
    }
  }
  return [...numbers].sort((a, b) => a - b);
}

// ---- trigger reconstruction ------------------------------------------------

/** Timeline instants that can have caused a review, newest-relevant-wins.
 * Tier 1 = a human asking (trigger label / team review request); tier 2 = the
 * bot's own "in progress" label, i.e. the dispatch moment. Force pushes are
 * fetched for completeness but are never triggers — a push re-triggers only
 * through the daemon's own staleness logic, which left no GitHub trace. */
interface TriggerCandidate {
  ts: string;
  tier: 1 | 2;
}

export function triggerCandidates(timeline: PrTimelineRecord[], cfg: Config): TriggerCandidate[] {
  const out: TriggerCandidate[] = [];
  for (const item of timeline) {
    if (item.type === "LabeledEvent") {
      if (item.label === cfg.backfill.trigger_label) out.push({ ts: item.created_at, tier: 1 });
      else if (
        item.label === cfg.backfill.in_progress_label &&
        (item.actor === cfg.backfill.bot_actor || item.actor === cfg.backfill.bot_login)
      ) {
        out.push({ ts: item.created_at, tier: 2 });
      }
    } else if (
      item.type === "ReviewRequestedEvent" &&
      item.requested_team === cfg.backfill.review_team_slug
    ) {
      out.push({ ts: item.created_at, tier: 1 });
    }
  }
  return out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}

/** The trigger a review answered: the latest candidate strictly before it and
 * strictly after the previous bot review on the same PR. Tier 1 wins outright;
 * tier 2 (the dispatch label) is only consulted when no human ask is in range.
 * Null when nothing qualifies — metrics can then tell "unknown" from
 * "reconstructed". */
export function triggerForReview(
  candidates: TriggerCandidate[],
  submittedAt: string,
  previousSubmittedAt: string | null,
): string | null {
  const inRange = candidates.filter(
    (c) => c.ts < submittedAt && (previousSubmittedAt === null || c.ts > previousSubmittedAt),
  );
  for (const tier of [1, 2] as const) {
    const hit = inRange.filter((c) => c.tier === tier).pop();
    if (hit) return hit.ts;
  }
  return null;
}

// ---- the import ------------------------------------------------------------

/** What one review would become — computed before any write so --dry-run and
 * the live run agree by construction. */
export interface PlannedRound {
  pr: number;
  round_no: number;
  verdict: string;
  started_at: string;
  finished_at: string;
  gh_review_id: number;
  gh_commit_id: string | null;
  trigger_ts: string | null;
  summary: string | null;
}

export interface PlannedPr {
  meta: {
    pr: number;
    title: string;
    author: string;
    created_at: string;
    merged_at: string | null;
    closed_at: string | null;
    merged: number;
  };
  rounds: PlannedRound[];
  skipped_epoch: number;
  skipped_existing: number;
  skipped_state: number;
  reviews_seen: number;
}

/** Pure planning step: history + the store's current facts -> rows to insert. */
export function planPr(
  history: PrReviewHistory,
  cfg: Config,
  ctx: { epoch: string | null; imported: Set<number>; minRoundNo: number | null },
): PlannedPr {
  const plan: PlannedPr = {
    meta: {
      pr: history.number,
      title: history.title,
      author: history.author,
      created_at: history.created_at,
      merged_at: history.merged_at,
      closed_at: history.closed_at,
      merged: history.merged ? 1 : 0,
    },
    rounds: [],
    skipped_epoch: 0,
    skipped_existing: 0,
    skipped_state: 0,
    reviews_seen: 0,
  };

  const candidates = triggerCandidates(history.timeline, cfg);
  const reviews = history.reviews
    .filter((r) => r.submitted_at !== null && r.database_id > 0)
    .sort((a, b) =>
      a.submitted_at! < b.submitted_at! ? -1 : a.submitted_at! > b.submitted_at! ? 1 : 0,
    );

  interface Accepted {
    review: (typeof reviews)[number];
    verdict: string;
    trigger: string | null;
  }
  const accepted: Accepted[] = [];
  let previous: string | null = null;
  for (const review of reviews) {
    plan.reviews_seen++;
    const submittedAt = review.submitted_at!;
    const trigger = triggerForReview(candidates, submittedAt, previous);
    previous = submittedAt;
    if (ctx.epoch !== null && submittedAt >= ctx.epoch) {
      plan.skipped_epoch++;
      continue;
    }
    const verdict = verdictForReviewState(review.state);
    if (verdict === null) {
      plan.skipped_state++;
      continue;
    }
    if (ctx.imported.has(review.database_id)) {
      plan.skipped_existing++;
      continue;
    }
    accepted.push({ review, verdict, trigger });
  }

  // Numbering: 1..N on a PR the daemon never touched, otherwise descending
  // below the PR's lowest existing round so live numbering stays untouched.
  const base = ctx.minRoundNo === null ? 1 : ctx.minRoundNo - accepted.length;
  accepted.forEach(({ review, verdict, trigger }, i) => {
    const submittedAt = review.submitted_at!;
    plan.rounds.push({
      pr: history.number,
      round_no: base + i,
      verdict,
      started_at: trigger ?? submittedAt,
      finished_at: submittedAt,
      gh_review_id: review.database_id,
      gh_commit_id: review.commit_oid,
      trigger_ts: trigger,
      summary: review.body ? review.body.slice(0, SUMMARY_LIMIT) : null,
    });
  });
  return plan;
}

/** Run `workers` fetches at a time over `items`, preserving input order. */
async function mapPool<T, R>(
  items: T[],
  workers: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(workers, items.length)) }, worker));
  return out;
}

export async function runBackfill(
  store: StateStore,
  source: BackfillSource,
  cfg: Config,
  opts: BackfillOptions = {},
): Promise<BackfillStats> {
  const log = opts.log ?? ((): void => {});
  const dryRun = opts.dryRun === true;
  const epoch = store.daemonEpoch();
  const imported = store.importedReviewIds();

  log(
    `backfill: ${dryRun ? "PLAN (no writes)" : "IMPORT"} · epoch ${epoch ?? "(none — no daemon rounds yet)"}`,
  );
  let prs = await enumeratePrs(source, cfg);
  const enumerated = prs.length;
  if (opts.limit !== undefined && opts.limit >= 0) prs = prs.slice(0, opts.limit);
  log(
    `backfill: ${enumerated} PRs enumerated${prs.length !== enumerated ? ` · ${prs.length} after --limit` : ""}`,
  );

  const stats: BackfillStats = {
    prs_enumerated: enumerated,
    prs_scanned: 0,
    reviews_seen: 0,
    reviews_imported: 0,
    skipped_epoch: 0,
    skipped_existing: 0,
    skipped_state: 0,
    meta_rows: 0,
    prs_missing: 0,
    epoch,
    dry_run: dryRun,
  };

  const histories = await mapPool(prs, cfg.backfill.concurrency, async (n) => {
    const history = await source.prReviewHistory(n, cfg.backfill.bot_login);
    return { n, history };
  });

  for (const { n, history } of histories) {
    if (!history) {
      stats.prs_missing++;
      continue;
    }
    stats.prs_scanned++;
    const plan = planPr(history, cfg, { epoch, imported, minRoundNo: store.minRoundNo(n) });
    stats.reviews_seen += plan.reviews_seen;
    stats.skipped_epoch += plan.skipped_epoch;
    stats.skipped_existing += plan.skipped_existing;
    stats.skipped_state += plan.skipped_state;

    if (plan.meta.created_at) {
      if (!dryRun) store.upsertBackfillPrMeta(plan.meta);
      stats.meta_rows++;
    }
    if (dryRun) {
      for (const r of plan.rounds) {
        stats.reviews_imported++;
        log(
          `  would import #${r.pr} round ${r.round_no} ${r.verdict} @ ${r.finished_at} (trigger ${r.trigger_ts ?? "—"})`,
        );
      }
      continue;
    }
    for (const r of plan.rounds) {
      const inserted = store.insertBackfilledRound(r);
      if (inserted) {
        stats.reviews_imported++;
        imported.add(r.gh_review_id);
      } else {
        stats.skipped_existing++;
      }
    }
    if (plan.rounds.length > 0) log(`  #${plan.meta.pr}: +${plan.rounds.length} rounds`);
  }

  log(
    `backfill done: ${stats.prs_scanned} PRs scanned · ${stats.reviews_imported} reviews ${dryRun ? "planned" : "imported"} · ` +
      `${stats.skipped_epoch} skipped (daemon era) · ${stats.skipped_existing} skipped (already imported) · ` +
      `${stats.skipped_state} skipped (non-verdict state) · ${stats.meta_rows} PR meta rows`,
  );
  return stats;
}

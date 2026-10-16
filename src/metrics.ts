// The metrics engine: pure aggregation over the daemon's sqlite —
// no GitHub calls, no mutations, no gate. `qcr metrics [--pr N] --json` and the
// TUI metrics tab both render exactly the payloads below.
//
// Backfilled rounds (rounds.backfilled = 1, imported from GitHub history)
// carry timestamps and verdicts but never spend, duration or a deadline. They
// are therefore included in time-to-first-verdict, verdict mix, rounds-until-
// resolution and size, and excluded from spend, duration, overruns and
// time-to-first-verdict's queue and review legs (an imported round's start is
// its reconstructed trigger, or its verdict when none was found, so neither
// leg was measured) — every `n` reflects actual data points rather than
// padded zeroes.
//
// Ops-day bucketing goes through eod.ts's Intl helpers (DST-correct; never
// manual offsets).
import { zoneDateString } from "./eod.js";
import {
  cancelCauseLabel,
  tableExists,
  snapshotHeartbeat,
  roundUsage,
  cancellationTotals,
  tallyCancellations,
  type RoundRow,
  type StateStore,
} from "./state.js";

// ---- the payload contract (do not rename or reshape) ----------------------

export interface Dist {
  median: number | null;
  p90: number | null;
  n: number;
  histogram: { label: string; count: number }[]; // fixed buckets, zero-count buckets included
}

export interface MetricsWindow {
  header: {
    prs_triggered: number;
    prs_reviewed: number;
    approvals: number;
    request_changes: number;
    rounds: number;
    spend_usd: number;
    overruns: number; // finished_at > deadline_at
  };
  // First verdict latency; queue/review medians separately cover all measured live rounds.
  ttfv: Dist & { queue_median_s: number | null; review_median_s: number | null };
  time_in_state: { state: string; median_s: number | null; total_s: number }[];
  verdict_mix: { verdict: string; count: number }[];
  spend: {
    per_pr_median: number | null;
    per_pr_p90: number | null;
    by_round_type: Record<string, number>; // usd totals
    by_lens: Record<string, number>; // usd totals
  };
  rounds_until_resolution: Dist; // unit = rounds per PR reaching terminal/approved
  duration: Dist & { overrun_rate: number | null }; // round duration seconds
  author_response: Dist; // verdict posted -> next head push, seconds
  review_depth: Dist; // bot comments per round (gap metric; fills as recorded)
  size: { bucket: string; prs: number; median_ttfv_s: number | null }[]; // XS<10, S<50, M<200, L<600, XL (added+deleted lines)
  pingpong: Dist & { cap_hits: number }; // exchanges per thread; cap = 3
  /** Every event kind the daemon logged in this window, busiest first, cap 12. */
  events_by_kind: { kind: string; count: number }[];
  /**
   * The `all` window only: how many of the rows counted in
   * `events_by_kind` were moved out of the live table into the archive
   * databases — counted from the `archived_event_counts` rollup, so the
   * all-time tally stays continuous and is labelled "(incl. N archived)".
   * Absent on d7/d30, which never see an archived row (`events_after_days` is
   * at least 31), and from an older daemon.
   */
  events_archived?: number;
  /**
   * Cancelled rounds, grouped by cause. `loud` is the subset a human should
   * act on (a round that stopped dead); the boot-time orphan sweep is counted here and nowhere alarmed.
   */
  cancellations: {
    total: number;
    loud: number;
    by_cause: { cause: string; label: string; count: number; loud: boolean }[];
  };
}

export const EVENT_KIND_CAP = 12;

export interface DailyRow {
  day: string; // YYYY-MM-DD in the ops timezone (MetricsOptions.timeZone)
  rounds: number;
  prs: number;
  spend_usd: number;
  approvals: number;
  request_changes: number;
}

/** The operational half of the payload: how the daemon itself is doing, and
 * which commit it is running. Everything here is read from files beside the
 * sqlite (status.json, BUILD_SHA) — `computeMetrics` fills the sqlite-derivable
 * bits and leaves the rest at their empty values; the CLI decorates. */
export interface OpsInfo {
  /** status.json heartbeat (ISO) — null when there is no snapshot yet. */
  heartbeat: string | null;
  /** status.json's mode — null when no snapshot says, never a guess. */
  dry_run: boolean | null;
  /** sqlite's count of running rounds, then status.json's when it has one. */
  running_rounds: number;
  /** status.json's concurrency cap — null when no snapshot says. */
  max_concurrent_rounds: number | null;
  /** The BUILD_SHA marker deploy.sh drops in the sandbox root; null if absent. */
  build: { sha: string; at: string; mode: string } | null;
}

export interface MetricsPayload {
  generated_at: string;
  windows: { d7: MetricsWindow; d30: MetricsWindow; all: MetricsWindow };
  daily: DailyRow[]; // last 30 ops days, oldest first, gap days present with zeros
  backfill: { rounds: number; prs: number; oldest: string | null };
  ops: OpsInfo;
}

// Per-PR drill-down: `qcr metrics --pr N --json`
export interface TimelinePayload {
  pr: number;
  known: boolean;
  title?: string;
  author?: string;
  // ordered ascending by ts: trigger, state transitions, round start/finish
  // (verdict+spend in detail), head pushes, close/merge
  items: { ts: string; kind: string; label: string; detail?: string | null }[];
  backfilled_rounds: {
    round_no: number;
    submitted_at: string;
    verdict: string | null;
    trigger_ts: string | null;
  }[];
}

// ---- statistics ------------------------------------------------------------

/** A histogram bucket: a value lands in the first bucket whose `max` it does
 * not exceed — or, for a `strict` bucket, stays below. */
export interface Bucket {
  label: string;
  max: number;
  strict?: boolean;
}

/** Strict upper bounds, as the "<" labels say: exactly 60 s is not "<1m". */
export const TIME_BUCKETS: Bucket[] = [
  { label: "<1m", max: 60, strict: true },
  { label: "<5m", max: 300, strict: true },
  { label: "<15m", max: 900, strict: true },
  { label: "<1h", max: 3600, strict: true },
  { label: "<4h", max: 14_400, strict: true },
  { label: "<1d", max: 86_400, strict: true },
  { label: ">=1d", max: Number.POSITIVE_INFINITY },
];

/** 1,2,3,4,5+ — the count-shaped histograms (rounds, ping-pong exchanges). */
export const COUNT_BUCKETS: Bucket[] = [
  { label: "1", max: 1 },
  { label: "2", max: 2 },
  { label: "3", max: 3 },
  { label: "4", max: 4 },
  { label: "5+", max: Number.POSITIVE_INFINITY },
];

/** 0,1,2,3,4,5+ — review depth. Its sample is the rounds with linked bot
 * comments (a gap metric that fills as comments are recorded), so the "0"
 * bucket stays empty until a round can be known to have posted none. */
export const DEPTH_BUCKETS: Bucket[] = [{ label: "0", max: 0 }, ...COUNT_BUCKETS];

/** Nearest-rank percentile (p in 0..1) over an unsorted numeric sample. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] ?? null;
}

export function median(values: number[]): number | null {
  return percentile(values, 0.5);
}

export function histogram(values: number[], buckets: Bucket[]): Dist["histogram"] {
  const out = buckets.map((b) => ({ label: b.label, count: 0 }));
  for (const v of values) {
    const idx = buckets.findIndex((b) => (b.strict ? v < b.max : v <= b.max));
    const target = out[idx === -1 ? out.length - 1 : idx];
    if (target) target.count++;
  }
  return out;
}

export function dist(values: number[], buckets: Bucket[] = TIME_BUCKETS): Dist {
  return {
    median: median(values),
    p90: percentile(values, 0.9),
    n: values.length,
    histogram: histogram(values, buckets),
  };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

function seconds(fromIso: string, toIso: string): number {
  return (Date.parse(toIso) - Date.parse(fromIso)) / 1000;
}

// ---- raw reads -------------------------------------------------------------

interface EventRow {
  id: number;
  ts: string;
  kind: string;
  pr: number | null;
  payload: string | null;
}

export interface ParsedEvent extends EventRow {
  data: Record<string, unknown>;
}

const METRIC_EVENT_KINDS = ["pr_transition", "verdict_applied", "head_push", "pr_closed"] as const;

function readEvents(store: StateStore): ParsedEvent[] {
  const rows = store.db
    .prepare(
      `SELECT id, ts, kind, pr, payload FROM events
        WHERE kind IN (${METRIC_EVENT_KINDS.map(() => "?").join(",")}) ORDER BY id`,
    )
    .all(...METRIC_EVENT_KINDS) as EventRow[];
  return rows.map((r) => {
    let data: Record<string, unknown> = {};
    if (r.payload) {
      try {
        const parsed: unknown = JSON.parse(r.payload);
        if (parsed && typeof parsed === "object") data = parsed as Record<string, unknown>;
      } catch {
        /* unparseable payloads are treated as empty */
      }
    }
    return { ...r, data };
  });
}

/** Every event, kind + timestamp only — the aggregate "what happened" list is
 * deliberately not restricted to METRIC_EVENT_KINDS: an operator wants to see
 * anomalies, injects and command traffic too. */
function readEventKinds(store: StateStore): Array<{ ts: string; kind: string }> {
  return store.db.prepare("SELECT ts, kind FROM events ORDER BY id").all() as Array<{
    ts: string;
    kind: string;
  }>;
}

/** Event rows the archiver moved out of the live table, per kind — the
 * rollup its delete transaction keeps. [] on a store without it. */
function readArchivedEventCounts(store: StateStore): Array<{ kind: string; n: number }> {
  if (!tableExists(store, "archived_event_counts")) return [];
  return store.db
    .prepare("SELECT kind, SUM(n) AS n FROM archived_event_counts GROUP BY kind ORDER BY kind")
    .all() as Array<{ kind: string; n: number }>;
}

interface ThreadRow {
  thread_id: number;
  pr: number;
  exchanges: number;
  cap_hits: number;
  updated_at: string;
}

function readThreads(store: StateStore): ThreadRow[] {
  if (!tableExists(store, "pingpong_threads")) return [];
  const hasCapHits =
    (
      store.db
        .prepare(
          "SELECT COUNT(*) AS c FROM pragma_table_info('pingpong_threads') WHERE name = 'cap_hits'",
        )
        .get() as { c: number }
    ).c > 0;
  const col = hasCapHits ? "cap_hits" : "0 AS cap_hits";
  return store.db
    .prepare(`SELECT thread_id, pr, exchanges, ${col}, updated_at FROM pingpong_threads`)
    .all() as ThreadRow[];
}

interface CommentRow {
  pr: number;
  round_no: number | null;
  posted_at: string;
}

// ---- per-round derived facts ----------------------------------------------

/** The instant a round is anchored to for windowing: when it landed. */
function roundAnchor(r: RoundRow): string {
  return r.finished_at ?? r.started_at;
}

function isBackfilled(r: RoundRow): boolean {
  return r.backfilled === 1;
}

function deliveredReview(r: RoundRow): boolean {
  return !!r.finished_at && r.status === "done";
}

/** Time-to-first-verdict per PR: trigger (or, absent a recorded trigger, the
 * round start) -> the first finished round. An imported round with no
 * reconstructed trigger has no measured start (its start IS its verdict), so
 * its PR has no sample rather than a fabricated zero. The first round is picked from
 * the PR's whole history and only then windowed on its own landing: picking
 * it from the windowed rounds would report a later round as the "first".
 * Only a `done` round delivered a verdict: a cancelled, overdue or expired
 * round also carries a `finished_at`, but that is when it died, not when the
 * PR got its answer. */
function ttfvByPr(allRounds: RoundRow[], since: string | null): Map<number, number> {
  const first = new Map<number, RoundRow>();
  for (const r of allRounds) {
    if (!deliveredReview(r)) continue;
    const seen = first.get(r.pr);
    if (!seen || r.round_no < seen.round_no) first.set(r.pr, r);
  }
  const out = new Map<number, number>();
  for (const [pr, r] of first) {
    if (!within(roundAnchor(r), since)) continue;
    const start = isBackfilled(r) ? r.trigger_ts : (r.trigger_ts ?? r.started_at);
    if (start === null) continue;
    const value = seconds(start, r.finished_at!);
    if (Number.isFinite(value) && value >= 0) out.set(pr, value);
  }
  return out;
}

const SIZE_BUCKETS: Array<{ bucket: string; max: number }> = [
  { bucket: "XS", max: 10 },
  { bucket: "S", max: 50 },
  { bucket: "M", max: 200 },
  { bucket: "L", max: 600 },
  { bucket: "XL", max: Number.POSITIVE_INFINITY },
];

function sizeBucket(lines: number): string {
  return (SIZE_BUCKETS.find((b) => lines < b.max) ?? SIZE_BUCKETS[SIZE_BUCKETS.length - 1]!).bucket;
}

// ---- time in state ---------------------------------------------------------

export interface StateInterval {
  pr: number;
  state: string;
  start: string;
  seconds: number;
}

/** Dwell intervals per PR, derived from the `pr_transition` event log.
 * Consecutive events landing on the same state are coalesced (a trigger that
 * does not change the state still logs a transition). The last state of a PR
 * runs open-ended up to `now`, except `closed`, which is terminal. */
export function stateIntervals(events: ParsedEvent[], nowIso: string): StateInterval[] {
  const byPr = new Map<number, Array<{ ts: string; to: string }>>();
  for (const e of events) {
    if (e.kind !== "pr_transition" || e.pr === null) continue;
    const to = typeof e.data.to === "string" ? e.data.to : null;
    if (!to) continue;
    const list = byPr.get(e.pr) ?? [];
    if (list.length === 0 || list[list.length - 1]!.to !== to) list.push({ ts: e.ts, to });
    byPr.set(e.pr, list);
  }
  const out: StateInterval[] = [];
  for (const [pr, list] of byPr) {
    for (let i = 0; i < list.length; i++) {
      const cur = list[i]!;
      const endIso = i + 1 < list.length ? list[i + 1]!.ts : cur.to === "closed" ? null : nowIso;
      if (!endIso) continue;
      const secs = seconds(cur.ts, endIso);
      if (Number.isFinite(secs) && secs >= 0)
        out.push({ pr, state: cur.to, start: cur.ts, seconds: secs });
    }
  }
  return out;
}

// ---- the window aggregation -----------------------------------------------

export interface WindowInput {
  rounds: RoundRow[];
  events: ParsedEvent[];
  comments: CommentRow[];
  threads: ThreadRow[];
  intervals: StateInterval[];
  resolvedPrs: Map<number, number>; // pr -> rounds until resolution
  /** Every event kind/ts (all kinds, not just the metric ones). */
  allEvents?: Array<{ ts: string; kind: string }>;
  /** Event rows moved to the archive, per kind — added into
   * the `all` window only. */
  archivedEvents?: Array<{ kind: string; n: number }>;
  /** Inclusive lower bound (ISO) or null for the "all" window. */
  since: string | null;
  nowIso: string;
}

const within = (ts: string | null | undefined, since: string | null): boolean =>
  ts !== null && ts !== undefined && (since === null || ts >= since);

export function computeWindow(input: WindowInput): MetricsWindow {
  const { since } = input;
  const rounds = input.rounds.filter((r) => within(roundAnchor(r), since));
  const live = rounds.filter((r) => !isBackfilled(r));
  // Duration and overrun read `finished_at`, and an expired round's is the
  // expiry sweep's clock rather than a real end — including them would report
  // day-long "rounds". They stay in the spend and count populations above
  // (expiry is bookkeeping, not a refund) and out of this one.
  const finishedLive = live.filter((r) => r.finished_at !== null && r.status !== "expired");

  const triggeredPrs = new Set<number>();
  for (const e of input.events) {
    if (e.kind !== "pr_transition" || e.pr === null) continue;
    if (e.data.event !== "trigger") continue;
    if (within(e.ts, since)) triggeredPrs.add(e.pr);
  }

  const overruns = finishedLive.filter((r) => r.finished_at! > r.deadline_at).length;

  // ---- ttfv (backfilled rounds included — they carry real timestamps) ----
  const ttfv = ttfvByPr(input.rounds, since);
  // Queue and review medians cover every measured live round, not just the
  // first verdict per PR. A backfilled round's
  // `started_at` is reconstructed, not when its review began.
  const queue: number[] = [];
  const review: number[] = [];
  for (const r of live) {
    if (r.trigger_ts) {
      const q = seconds(r.trigger_ts, r.started_at);
      if (Number.isFinite(q) && q >= 0) queue.push(q);
    }
  }
  for (const r of finishedLive) {
    const v = seconds(r.started_at, r.finished_at!);
    if (Number.isFinite(v) && v >= 0) review.push(v);
  }

  // ---- time in state ----
  // Every interval that overlaps the window counts, including one entered
  // before it (a PR stuck for longer than the window is the case this card
  // exists for): `median_s` is over the whole dwell of each such interval,
  // `total_s` over the part of it inside the window.
  const byState = new Map<string, { dwell: number[]; inside: number }>();
  const sinceMs = since === null ? null : Date.parse(since);
  for (const iv of input.intervals) {
    const startMs = Date.parse(iv.start);
    const endMs = startMs + iv.seconds * 1000;
    if (!Number.isFinite(startMs)) continue;
    if (sinceMs !== null && startMs < sinceMs && endMs <= sinceMs) continue;
    const inside = sinceMs === null ? iv.seconds : (endMs - Math.max(startMs, sinceMs)) / 1000;
    const acc = byState.get(iv.state) ?? { dwell: [], inside: 0 };
    acc.dwell.push(iv.seconds);
    acc.inside += inside;
    byState.set(iv.state, acc);
  }
  const timeInState = [...byState.entries()]
    .map(([state, acc]) => ({
      state,
      median_s: median(acc.dwell),
      total_s: round2(acc.inside),
    }))
    .sort((a, b) => b.total_s - a.total_s);

  // ---- verdict mix (backfilled included) ----
  const verdicts = new Map<string, number>();
  for (const r of rounds)
    if (r.verdict) verdicts.set(r.verdict, (verdicts.get(r.verdict) ?? 0) + 1);
  const verdictMix = [...verdicts.entries()]
    .map(([verdict, count]) => ({ verdict, count }))
    .sort((a, b) => b.count - a.count || a.verdict.localeCompare(b.verdict));

  // ---- spend (live rounds only — backfilled rows have no cost) ----
  const perPr = new Map<number, number>();
  const byRoundType: Record<string, number> = {};
  const byLens: Record<string, number> = {};
  for (const r of live) {
    if (r.est_usd === null) continue;
    const spend = r.est_usd;
    perPr.set(r.pr, (perPr.get(r.pr) ?? 0) + spend);
    // Accumulated at full precision and rounded once below, like `perPr` —
    // rounding every step drifts a bucket off the header's total.
    byRoundType[r.round_type] = (byRoundType[r.round_type] ?? 0) + spend;
    for (const lens of r.lenses
      .split(",")
      .map((l) => l.trim())
      .filter(Boolean)) {
      // A round's cost is not divisible across its lenses — each lens is
      // credited with the full cost of the rounds it took part in.
      byLens[lens] = (byLens[lens] ?? 0) + spend;
    }
  }
  for (const k of Object.keys(byRoundType)) byRoundType[k] = round2(byRoundType[k]!);
  for (const k of Object.keys(byLens)) byLens[k] = round2(byLens[k]!);
  const perPrValues = [...perPr.values()].map(round2);
  const spendTotal = round2(roundUsage(live).spend_usd);

  // ---- rounds until resolution (PRs with activity in the window) ----
  const prsInWindow = new Set(rounds.map((r) => r.pr));
  const resolution: number[] = [];
  for (const pr of prsInWindow) {
    const n = input.resolvedPrs.get(pr);
    if (n !== undefined) resolution.push(n);
  }

  // ---- duration / overrun ----
  const durations = finishedLive
    .map((r) => r.duration_s ?? seconds(r.started_at, r.finished_at!))
    .filter((v) => Number.isFinite(v) && v >= 0);

  // ---- author response: verdict landed -> next head push ----
  const pushesByPr = new Map<number, string[]>();
  for (const e of input.events) {
    if (e.kind !== "head_push" || e.pr === null) continue;
    const list = pushesByPr.get(e.pr) ?? [];
    list.push(e.ts);
    pushesByPr.set(e.pr, list);
  }
  const responses: number[] = [];
  for (const e of input.events) {
    if (e.kind !== "verdict_applied" || e.pr === null || !within(e.ts, since)) continue;
    const next = (pushesByPr.get(e.pr) ?? []).find((ts) => ts > e.ts);
    if (!next) continue;
    const secs = seconds(e.ts, next);
    if (Number.isFinite(secs) && secs >= 0) responses.push(secs);
  }

  // ---- review depth: bot comments per round ----
  const perRoundComments = new Map<string, number>();
  for (const c of input.comments) {
    if (c.round_no === null || !within(c.posted_at, since)) continue;
    const key = `${c.pr}#${c.round_no}`;
    perRoundComments.set(key, (perRoundComments.get(key) ?? 0) + 1);
  }
  const depthValues = [...perRoundComments.values()];

  // ---- size distribution ----
  const linesByPr = new Map<number, number>();
  for (const r of rounds) {
    if (r.additions === null && r.deletions === null) continue;
    const lines = (r.additions ?? 0) + (r.deletions ?? 0);
    linesByPr.set(r.pr, Math.max(linesByPr.get(r.pr) ?? 0, lines));
  }
  const size = SIZE_BUCKETS.map(({ bucket }) => {
    const prs = [...linesByPr.entries()]
      .filter(([, lines]) => sizeBucket(lines) === bucket)
      .map(([pr]) => pr);
    const ttfvs = prs.map((pr) => ttfv.get(pr)).filter((v): v is number => v !== undefined);
    return { bucket, prs: prs.length, median_ttfv_s: median(ttfvs) };
  });

  // ---- ping-pong depth ----
  const threads = input.threads.filter((t) => within(t.updated_at, since));
  const pingpong = {
    ...dist(
      threads.filter((t) => t.exchanges > 0).map((t) => t.exchanges),
      COUNT_BUCKETS,
    ),
    cap_hits: threads.reduce((n, t) => n + (t.cap_hits ?? 0), 0),
  };

  // ---- aggregate event traffic (every kind, busiest first) ----
  const kinds = new Map<string, number>();
  for (const e of input.allEvents ?? []) {
    if (!within(e.ts, since)) continue;
    kinds.set(e.kind, (kinds.get(e.kind) ?? 0) + 1);
  }
  // The archived rows count in the all-time window only: every one is older
  // than `events_after_days` (≥ 31), so d7 and d30 are exact without them.
  let eventsArchived: number | undefined;
  if (since === null && input.archivedEvents) {
    eventsArchived = 0;
    for (const a of input.archivedEvents) {
      kinds.set(a.kind, (kinds.get(a.kind) ?? 0) + a.n);
      eventsArchived += a.n;
    }
  }
  const eventsByKind = [...kinds.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind))
    .slice(0, EVENT_KIND_CAP);

  // ---- cancellations by cause ----
  // Loud first: the surface renders in order and never has to know policy.
  const byCause = tallyCancellations(live).map((t) => ({
    cause: t.cause,
    label: cancelCauseLabel(t.cause),
    count: t.count,
    loud: t.loud,
  }));
  const cancellations = {
    ...cancellationTotals(byCause),
    by_cause: byCause,
  };

  return {
    header: {
      prs_triggered: triggeredPrs.size,
      // Only a `done` round delivered a review: cancelled, overdue and expired
      // rounds carry a `finished_at` too, but that is when they died.
      prs_reviewed: new Set(rounds.filter(deliveredReview).map((r) => r.pr)).size,
      approvals: rounds.filter((r) => r.verdict === "APPROVE").length,
      request_changes: rounds.filter((r) => r.verdict === "REQUEST_CHANGES").length,
      rounds: rounds.length,
      spend_usd: spendTotal,
      overruns,
    },
    ttfv: {
      ...dist([...ttfv.values()]),
      queue_median_s: median(queue),
      review_median_s: median(review),
    },
    time_in_state: timeInState,
    verdict_mix: verdictMix,
    spend: {
      per_pr_median: perPrValues.length ? round2(median(perPrValues)!) : null,
      per_pr_p90: perPrValues.length ? round2(percentile(perPrValues, 0.9)!) : null,
      by_round_type: byRoundType,
      by_lens: byLens,
    },
    rounds_until_resolution: dist(resolution, COUNT_BUCKETS),
    duration: {
      ...dist(durations),
      overrun_rate: finishedLive.length ? overruns / finishedLive.length : null,
    },
    author_response: dist(responses),
    review_depth: dist(depthValues, DEPTH_BUCKETS),
    size,
    pingpong,
    events_by_kind: eventsByKind,
    ...(eventsArchived !== undefined ? { events_archived: eventsArchived } : {}),
    cancellations,
  };
}

// ---- daily rows ------------------------------------------------------------

export function dailyRows(rounds: RoundRow[], now: Date, timeZone: string, days = 30): DailyRow[] {
  // Step calendar dates back from today's zone date: fixed 24h offsets from
  // `now` skip or repeat a day around a DST transition.
  const today = new Date(`${zoneDateString(now, timeZone)}T00:00:00.000Z`);
  const wanted: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    wanted.push(d.toISOString().slice(0, 10));
  }
  const byDay = new Map<string, DailyRow & { prSet: Set<number> }>();
  for (const day of wanted) {
    byDay.set(day, {
      day,
      rounds: 0,
      prs: 0,
      spend_usd: 0,
      approvals: 0,
      request_changes: 0,
      prSet: new Set(),
    });
  }
  for (const r of rounds) {
    const day = zoneDateString(new Date(roundAnchor(r)), timeZone);
    const row = byDay.get(day);
    if (!row) continue;
    row.rounds++;
    row.prSet.add(r.pr);
    row.spend_usd += r.est_usd ?? 0;
    if (r.verdict === "APPROVE") row.approvals++;
    if (r.verdict === "REQUEST_CHANGES") row.request_changes++;
  }
  return wanted.map((day) => {
    const row = byDay.get(day)!;
    return {
      day,
      rounds: row.rounds,
      prs: row.prSet.size,
      spend_usd: round2(row.spend_usd),
      approvals: row.approvals,
      request_changes: row.request_changes,
    };
  });
}

// ---- resolution ------------------------------------------------------------

/** Rounds spent per PR that reached a resolution: the first APPROVE round
 * (rounds up to and including it), or every round of a PR GitHub closed.
 * A PR known only from imported history has no live row and no events; its
 * closure is the import's `backfill_pr_meta` record. */
export function resolutionByPr(
  store: StateStore,
  rounds: RoundRow[],
  events: ParsedEvent[],
): Map<number, number> {
  const closed = new Set<number>();
  for (const e of events) if (e.kind === "pr_closed" && e.pr !== null) closed.add(e.pr);
  const tracked = new Set<number>();
  for (const p of store.allPrs()) {
    tracked.add(p.number);
    if (p.state === "closed") closed.add(p.number);
  }
  for (const m of store.allBackfillPrMeta())
    if (!tracked.has(m.pr) && (m.closed_at !== null || m.merged_at !== null)) closed.add(m.pr);

  const byPr = new Map<number, RoundRow[]>();
  for (const r of rounds) byPr.set(r.pr, [...(byPr.get(r.pr) ?? []), r]);

  const out = new Map<number, number>();
  for (const [pr, list] of byPr) {
    const ordered = [...list].sort((a, b) => a.round_no - b.round_no);
    const approveIdx = ordered.findIndex((r) => r.verdict === "APPROVE");
    if (approveIdx >= 0) out.set(pr, approveIdx + 1);
    else if (closed.has(pr) && ordered.length > 0) out.set(pr, ordered.length);
  }
  return out;
}

// ---- the payloads ----------------------------------------------------------

export interface MetricsOptions {
  now?: () => Date;
  timeZone?: string;
}

export function computeMetrics(store: StateStore, opts: MetricsOptions = {}): MetricsPayload {
  const now = (opts.now ?? (() => new Date()))();
  // Callers with a config pass cfg.ops.timezone; UTC only covers
  // the caller that genuinely has no config to read.
  const timeZone = opts.timeZone ?? "UTC";
  const nowIso = now.toISOString();

  // Expired zombie rounds are kept here — dropping them would erase the
  // tokens they really burned. `computeWindow` excludes them from the one
  // population they genuinely distort: duration/overrun, whose `finished_at`
  // is the expiry sweep's clock rather than a real end.
  const rounds = store.allRounds();
  const events = readEvents(store);
  // The live tally and the archived rollup in one read transaction: the
  // archiver (another process, for `qcr metrics`) deletes rows and adds them
  // to the rollup in one commit, and two separate snapshots on either side of
  // it would count the moved rows twice.
  const { allEvents, archivedEvents } = store.db.transaction(() => ({
    allEvents: readEventKinds(store),
    archivedEvents: readArchivedEventCounts(store),
  }))();
  const comments = store.db
    .prepare("SELECT pr, round_no, posted_at FROM bot_comments")
    .all() as CommentRow[];
  const threads = readThreads(store);
  const intervals = stateIntervals(events, nowIso);
  const resolvedPrs = resolutionByPr(store, rounds, events);

  const base = {
    rounds,
    events,
    allEvents,
    archivedEvents,
    comments,
    threads,
    intervals,
    resolvedPrs,
    nowIso,
  };
  const iso = (daysAgo: number): string =>
    new Date(now.getTime() - daysAgo * 86_400_000).toISOString();

  const backfilled = rounds.filter(isBackfilled);
  const oldest = [...backfilled].map((r) => r.started_at).sort()[0] ?? null;

  return {
    generated_at: nowIso,
    windows: {
      d7: computeWindow({ ...base, since: iso(7) }),
      d30: computeWindow({ ...base, since: iso(30) }),
      all: computeWindow({ ...base, since: null }),
    },
    daily: dailyRows(rounds, now, timeZone),
    backfill: {
      rounds: backfilled.length,
      prs: new Set(backfilled.map((r) => r.pr)).size,
      oldest,
    },
    // Everything sqlite knows about the daemon's operation; the file-derived
    // half (heartbeat, dry-run, build marker) is decorated by `readOps`.
    ops: { ...emptyOps(), running_rounds: store.runningRounds().length },
  };
}

// ---- ops: the file-derived half -------------------------------------------

export function emptyOps(): OpsInfo {
  return {
    heartbeat: null,
    dry_run: null,
    running_rounds: 0,
    max_concurrent_rounds: null,
    build: null,
  };
}

/**
 * Read the operational facts that do not live in sqlite: the daemon's
 * `status.json` snapshot and the `BUILD_SHA` marker deploy.sh rsyncs into the
 * sandbox root. Both are optional — a missing/corrupt file degrades to the
 * empty value for its fields and never throws (a metrics read must not be able
 * to fail because the daemon has not written a snapshot yet). Parsing of the
 * marker is deploytab's `parseBuildSha`, injected so this module stays free of
 * the TUI.
 */
export function readOps(
  paths: { statusPath: string; buildShaPath: string },
  io: {
    readFile: (path: string) => string;
    parseBuildSha: (text: string) => { sha: string; at?: string; mode?: string } | undefined;
  },
  base: OpsInfo = emptyOps(),
): OpsInfo {
  const ops: OpsInfo = { ...base };
  try {
    const snap = JSON.parse(io.readFile(paths.statusPath)) as Partial<{
      heartbeat: string;
      written_at: string;
      dry_run: boolean;
      running_rounds: number;
      max_concurrent_rounds: number;
    }>;
    ops.heartbeat = snapshotHeartbeat(snap);
    if (typeof snap.dry_run === "boolean") ops.dry_run = snap.dry_run;
    if (typeof snap.running_rounds === "number") ops.running_rounds = snap.running_rounds;
    if (typeof snap.max_concurrent_rounds === "number")
      ops.max_concurrent_rounds = snap.max_concurrent_rounds;
  } catch {
    /* no snapshot (or an unreadable one) — the unknowns stand */
  }
  try {
    const marker = io.parseBuildSha(io.readFile(paths.buildShaPath));
    if (marker) ops.build = { sha: marker.sha, at: marker.at ?? "", mode: marker.mode ?? "" };
  } catch {
    /* no BUILD_SHA yet — `build` stays null and the TUI says "unknown" */
  }
  return ops;
}

export function computeTimeline(store: StateStore, pr: number): TimelinePayload {
  const rounds = store.roundsFor(pr);
  const row = store.getPr(pr);
  const meta = store.backfillPrMeta(pr);
  const events = readEvents(store).filter((e) => e.pr === pr);

  const items: TimelinePayload["items"] = [];
  const push = (ts: string, kind: string, label: string, detail?: string | null): void => {
    items.push({ ts, kind, label, ...(detail !== undefined ? { detail } : {}) });
  };

  for (const e of events) {
    switch (e.kind) {
      case "pr_transition": {
        const from = typeof e.data.from === "string" ? e.data.from : "—";
        const to = typeof e.data.to === "string" ? e.data.to : "?";
        const what = typeof e.data.event === "string" ? e.data.event : "";
        if (what === "trigger")
          push(
            e.ts,
            "trigger",
            "triggered",
            typeof e.data.reason === "string" ? e.data.reason : null,
          );
        if (from !== to) push(e.ts, "transition", `${from} -> ${to}`, what || null);
        break;
      }
      case "head_push":
        push(
          e.ts,
          "head_push",
          "author pushed",
          typeof e.data.head_sha === "string" ? e.data.head_sha.slice(0, 10) : null,
        );
        break;
      case "pr_closed":
        push(e.ts, "close", e.data.merged ? "merged" : "closed", null);
        break;
      default:
        break;
    }
  }

  for (const r of rounds) {
    if (isBackfilled(r)) {
      push(
        r.finished_at ?? r.started_at,
        "backfilled_round",
        `round ${r.round_no} (backfill) ${r.verdict ?? "—"}`,
        null,
      );
      continue;
    }
    push(
      r.started_at,
      "round_start",
      `round ${r.round_no} start (${r.round_type})`,
      r.lenses || null,
    );
    if (r.finished_at) {
      const bits = [
        r.verdict ?? r.status,
        r.est_usd !== null ? `$${r.est_usd.toFixed(2)}` : null,
        r.duration_s !== null ? `${Math.round(r.duration_s)}s` : null,
      ].filter(Boolean);
      push(
        r.finished_at,
        "round_finish",
        `round ${r.round_no} ${r.verdict ?? r.status}`,
        bits.join(" · "),
      );
    }
  }

  items.sort((a, b) => (a.ts === b.ts ? 0 : a.ts < b.ts ? -1 : 1));

  const payload: TimelinePayload = {
    pr,
    known: row !== undefined || rounds.length > 0 || meta !== undefined,
    items,
    backfilled_rounds: rounds.filter(isBackfilled).map((r) => ({
      round_no: r.round_no,
      submitted_at: r.finished_at ?? r.started_at,
      verdict: r.verdict ?? null,
      trigger_ts: r.trigger_ts ?? null,
    })),
  };
  const title = row?.title ?? meta?.title;
  const author = row?.author ?? meta?.author;
  if (title) payload.title = title;
  if (author) payload.author = author;
  return payload;
}

// ---- human-readable rendering (the non-json CLI fallback) -----------------

const fmtSecs = (s: number | null): string =>
  s === null
    ? "—"
    : s >= 3600
      ? `${(s / 3600).toFixed(1)}h`
      : s >= 60
        ? `${(s / 60).toFixed(1)}m`
        : `${Math.round(s)}s`;

/**
 * One plain-text line for the cancellation split — shared wording
 * between `qcr metrics` and `qcr today`, loud causes first and flagged, benign
 * ones present but unmarked. An empty window says so rather than printing an
 * ambiguous zero.
 */
export function cancellationLine(win: MetricsWindow, label = "cancelled (7d)"): string {
  return cancellationSummaryLine(label, win.cancellations?.by_cause ?? []);
}

/** The cancellation line's wording over any cause tallies, in the order
 * given; a tally without its own label takes `cancelCauseLabel`'s. */
export function cancellationSummaryLine(
  label: string,
  tallies: ReadonlyArray<{ cause: string; count: number; loud: boolean; label?: string }>,
): string {
  if (tallies.length === 0) return `${label}: none`;
  const { total, loud } = cancellationTotals(tallies);
  const parts = tallies.map(
    (t) => `${t.label ?? cancelCauseLabel(t.cause)} ${t.count}${t.loud ? " ⚑" : ""}`,
  );
  return `${label}: ${total} — ${parts.join(", ")}${loud > 0 ? `  (${loud} needing a look)` : ""}`;
}

export function renderMetrics(payload: MetricsPayload): string {
  const lines: string[] = [];
  const w = payload.windows.d7;
  lines.push(`quickreview metrics — generated ${payload.generated_at}`);
  const ops = payload.ops;
  lines.push(
    // Without a snapshot the mode is unknown — never guess "LIVE".
    `daemon: ${ops.heartbeat === null || ops.dry_run === null ? "mode unknown" : ops.dry_run ? "DRY-RUN" : "LIVE"} · heartbeat ${ops.heartbeat ?? "—"} · ` +
      `rounds ${ops.running_rounds}/${ops.max_concurrent_rounds ?? "?"} · ` +
      `build ${ops.build ? `${ops.build.sha}${ops.build.at ? ` (${ops.build.at}${ops.build.mode ? `, ${ops.build.mode}` : ""})` : ""}` : "unknown"}`,
  );
  lines.push("");
  lines.push("window   PRs  rounds  appr  rc   spend    overruns");
  for (const [name, win] of [
    ["7d", payload.windows.d7],
    ["30d", payload.windows.d30],
    ["all", payload.windows.all],
  ] as const) {
    lines.push(
      `${name.padEnd(8)} ${String(win.header.prs_reviewed).padEnd(4)} ${String(win.header.rounds).padEnd(7)} ` +
        `${String(win.header.approvals).padEnd(5)} ${String(win.header.request_changes).padEnd(4)} ` +
        `$${win.header.spend_usd.toFixed(2).padEnd(7)} ${win.header.overruns}`,
    );
  }
  lines.push("");
  lines.push(
    `ttfv (7d): median ${fmtSecs(w.ttfv.median)} p90 ${fmtSecs(w.ttfv.p90)} ` +
      `(all live rounds: queue ${fmtSecs(w.ttfv.queue_median_s)}, review ${fmtSecs(w.ttfv.review_median_s)}) n=${w.ttfv.n}`,
  );
  lines.push(
    `duration (7d): median ${fmtSecs(w.duration.median)} p90 ${fmtSecs(w.duration.p90)} ` +
      `overrun-rate ${w.duration.overrun_rate === null ? "—" : `${Math.round(w.duration.overrun_rate * 100)}%`}`,
  );
  lines.push(
    `rounds until resolution (7d): median ${w.rounds_until_resolution.median ?? "—"} n=${w.rounds_until_resolution.n}`,
  );
  lines.push(
    `verdict mix (7d): ${w.verdict_mix.map((v) => `${v.verdict} ${v.count}`).join("  ") || "—"}`,
  );
  lines.push(
    `events (7d): ${w.events_by_kind.map((e) => `${e.kind} ${e.count}`).join("  ") || "—"}`,
  );
  const archived = payload.windows.all.events_archived;
  if (archived)
    lines.push(
      `events (all): ${payload.windows.all.events_by_kind.map((e) => `${e.kind} ${e.count}`).join("  ") || "—"} ` +
        `(incl. ${archived} archived)`,
    );
  lines.push(cancellationLine(w));
  lines.push("");
  lines.push("day          rounds  PRs  spend   appr  rc");
  for (const d of payload.daily.slice(-14)) {
    lines.push(
      `${d.day}   ${String(d.rounds).padEnd(7)} ${String(d.prs).padEnd(4)} $${d.spend_usd.toFixed(2).padEnd(6)} ` +
        `${String(d.approvals).padEnd(5)} ${d.request_changes}`,
    );
  }
  if (payload.backfill.rounds > 0) {
    lines.push("");
    lines.push(
      `backfill: ${payload.backfill.rounds} rounds across ${payload.backfill.prs} PRs, oldest ${payload.backfill.oldest}`,
    );
  }
  return lines.join("\n");
}

export function renderTimeline(payload: TimelinePayload): string {
  if (!payload.known) return `nothing known about #${payload.pr}`;
  const lines = [
    `#${payload.pr}${payload.title ? ` — ${payload.title}` : ""}${payload.author ? ` (@${payload.author})` : ""}`,
    "",
  ];
  for (const item of payload.items) {
    lines.push(
      `${item.ts}  ${item.kind.padEnd(16)} ${item.label}${item.detail ? ` — ${item.detail}` : ""}`,
    );
  }
  return lines.join("\n");
}

// The metrics engine: pure aggregation over the daemon's sqlite —
// no GitHub calls, no mutations, no gate. `qcr metrics [--pr N] --json` and the
// TUI metrics tab both render exactly the payloads below.
//
// Backfilled rounds (rounds.backfilled = 1, imported from GitHub history by M2)
// carry timestamps and verdicts but never spend, duration or a deadline. They
// are therefore INCLUDED in time-to-first-verdict, verdict mix, rounds-until-
// resolution and size, and EXCLUDED from spend, duration and overruns — every
// `n` reflects actual data points rather than padded zeroes.
//
// Warsaw-day bucketing goes through eod.ts's Intl helpers (DST-correct; never
// manual offsets).
import { zoneDateString } from "./eod.js";
import type { RoundRow, StateStore } from "./state.js";

// ---- the M1<->M3 contract (verbatim; do not rename or reshape) ------------

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
    overruns: number;      // finished_at > deadline_at
    awaiting_you: number;  // current awaiting_human count (same in all windows)
  };
  // time-to-first-verdict: trigger_ts -> first round finished_at, seconds
  ttfv: Dist & { queue_median_s: number | null; review_median_s: number | null };
  time_in_state: { state: string; median_s: number | null; total_s: number }[];
  verdict_mix: { verdict: string; count: number }[];
  spend: {
    per_pr_median: number | null;
    per_pr_p90: number | null;
    by_round_type: Record<string, number>; // usd totals
    by_lens: Record<string, number>;       // usd totals
  };
  rounds_until_resolution: Dist; // unit = rounds per PR reaching terminal/approved
  duration: Dist & { overrun_rate: number | null }; // round duration seconds
  author_response: Dist; // verdict posted -> next head push, seconds
  review_depth: Dist;    // bot comments per round (gap metric; fills as recorded)
  size: { bucket: string; prs: number; median_ttfv_s: number | null }[]; // XS<10, S<50, M<200, L<600, XL (added+deleted lines)
  pingpong: Dist & { cap_hits: number }; // exchanges per thread; cap = 3
  /** Every event kind the daemon logged in this window, busiest first, cap 12. */
  events_by_kind: { kind: string; count: number }[];
}

export const EVENT_KIND_CAP = 12;

export interface DailyRow {
  day: string; // YYYY-MM-DD, Europe/Warsaw
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
  dry_run: boolean;
  running_rounds: number;
  max_concurrent_rounds: number;
  /** The BUILD_SHA marker deploy.sh drops in the sandbox root; null if absent. */
  build: { sha: string; at: string; mode: string } | null;
}

export interface MetricsPayload {
  generated_at: string;
  windows: { d7: MetricsWindow; d30: MetricsWindow; all: MetricsWindow };
  daily: DailyRow[]; // last 30 Warsaw days, oldest first, gap days present with zeros
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

export const TIME_BUCKETS: Array<{ label: string; max: number }> = [
  { label: "<1m", max: 60 },
  { label: "<5m", max: 300 },
  { label: "<15m", max: 900 },
  { label: "<1h", max: 3600 },
  { label: "<4h", max: 14_400 },
  { label: "<1d", max: 86_400 },
  { label: ">=1d", max: Number.POSITIVE_INFINITY },
];

/** 1,2,3,4,5+ — the count-shaped histograms (rounds, ping-pong exchanges). */
export const COUNT_BUCKETS: Array<{ label: string; max: number }> = [
  { label: "1", max: 1 },
  { label: "2", max: 2 },
  { label: "3", max: 3 },
  { label: "4", max: 4 },
  { label: "5+", max: Number.POSITIVE_INFINITY },
];

/** 0,1,2,3,4,5+ — review depth, where "no comments" is a real observation. */
export const DEPTH_BUCKETS: Array<{ label: string; max: number }> = [
  { label: "0", max: 0 },
  ...COUNT_BUCKETS,
];

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

export function histogram(values: number[], buckets: Array<{ label: string; max: number }>): Dist["histogram"] {
  const out = buckets.map((b) => ({ label: b.label, count: 0 }));
  for (const v of values) {
    const idx = buckets.findIndex((b) => v <= b.max);
    const target = out[idx === -1 ? out.length - 1 : idx];
    if (target) target.count++;
  }
  return out;
}

export function dist(values: number[], buckets: Array<{ label: string; max: number }> = TIME_BUCKETS): Dist {
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
 * deliberately NOT restricted to METRIC_EVENT_KINDS: an operator wants to see
 * anomalies, injects and command traffic too. */
function readEventKinds(store: StateStore): Array<{ ts: string; kind: string }> {
  return store.db.prepare("SELECT ts, kind FROM events ORDER BY id").all() as Array<{ ts: string; kind: string }>;
}

function tableExists(store: StateStore, name: string): boolean {
  return store.db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
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
        .prepare("SELECT COUNT(*) AS c FROM pragma_table_info('pingpong_threads') WHERE name = 'cap_hits'")
        .get() as { c: number }
    ).c > 0;
  const col = hasCapHits ? "cap_hits" : "0 AS cap_hits";
  return store.db.prepare(`SELECT thread_id, pr, exchanges, ${col}, updated_at FROM pingpong_threads`).all() as ThreadRow[];
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

/** Time-to-first-verdict per PR: trigger (or, absent a recorded trigger, the
 * round start) -> the first finished round. */
function ttfvByPr(rounds: RoundRow[]): Map<number, number> {
  const first = new Map<number, RoundRow>();
  for (const r of rounds) {
    if (!r.finished_at) continue;
    const seen = first.get(r.pr);
    if (!seen || r.round_no < seen.round_no) first.set(r.pr, r);
  }
  const out = new Map<number, number>();
  for (const [pr, r] of first) {
    const value = seconds(r.trigger_ts ?? r.started_at, r.finished_at!);
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
      if (Number.isFinite(secs) && secs >= 0) out.push({ pr, state: cur.to, start: cur.ts, seconds: secs });
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
  awaitingYou: number;
  resolvedPrs: Map<number, number>; // pr -> rounds until resolution
  /** Every event kind/ts (all kinds, not just the metric ones). */
  allEvents?: Array<{ ts: string; kind: string }>;
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
  const finishedLive = live.filter((r) => r.finished_at !== null);

  const triggeredPrs = new Set<number>();
  for (const e of input.events) {
    if (e.kind !== "pr_transition" || e.pr === null) continue;
    if (e.data.event !== "trigger") continue;
    if (within(e.ts, since)) triggeredPrs.add(e.pr);
  }

  const overruns = finishedLive.filter((r) => r.finished_at! > r.deadline_at).length;

  // ---- ttfv (backfilled rounds included — they carry real timestamps) ----
  const ttfv = ttfvByPr(rounds);
  const queue: number[] = [];
  const review: number[] = [];
  for (const r of rounds) {
    if (r.trigger_ts) {
      const q = seconds(r.trigger_ts, r.started_at);
      if (Number.isFinite(q) && q >= 0) queue.push(q);
    }
    if (r.finished_at) {
      const v = seconds(r.started_at, r.finished_at);
      if (Number.isFinite(v) && v >= 0) review.push(v);
    }
  }

  // ---- time in state ----
  const byState = new Map<string, number[]>();
  for (const iv of input.intervals) {
    if (!within(iv.start, since)) continue;
    const list = byState.get(iv.state) ?? [];
    list.push(iv.seconds);
    byState.set(iv.state, list);
  }
  const timeInState = [...byState.entries()]
    .map(([state, values]) => ({
      state,
      median_s: median(values),
      total_s: round2(values.reduce((n, v) => n + v, 0)),
    }))
    .sort((a, b) => b.total_s - a.total_s);

  // ---- verdict mix (backfilled included) ----
  const verdicts = new Map<string, number>();
  for (const r of rounds) if (r.verdict) verdicts.set(r.verdict, (verdicts.get(r.verdict) ?? 0) + 1);
  const verdictMix = [...verdicts.entries()]
    .map(([verdict, count]) => ({ verdict, count }))
    .sort((a, b) => b.count - a.count || a.verdict.localeCompare(b.verdict));

  // ---- spend (live rounds only — backfilled rows have no cost) ----
  const perPr = new Map<number, number>();
  const byRoundType: Record<string, number> = {};
  const byLens: Record<string, number> = {};
  for (const r of live) {
    const spend = r.est_usd ?? 0;
    if (spend === 0) continue;
    perPr.set(r.pr, (perPr.get(r.pr) ?? 0) + spend);
    byRoundType[r.round_type] = round2((byRoundType[r.round_type] ?? 0) + spend);
    for (const lens of r.lenses.split(",").map((l) => l.trim()).filter(Boolean)) {
      // A round's cost is not divisible across its lenses — each lens is
      // credited with the full cost of the rounds it took part in.
      byLens[lens] = round2((byLens[lens] ?? 0) + spend);
    }
  }
  const perPrValues = [...perPr.values()].map(round2);
  const spendTotal = round2(live.reduce((n, r) => n + (r.est_usd ?? 0), 0));

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
    const prs = [...linesByPr.entries()].filter(([, lines]) => sizeBucket(lines) === bucket).map(([pr]) => pr);
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
  const eventsByKind = [...kinds.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind))
    .slice(0, EVENT_KIND_CAP);

  return {
    header: {
      prs_triggered: triggeredPrs.size,
      prs_reviewed: new Set(rounds.filter((r) => r.finished_at).map((r) => r.pr)).size,
      approvals: rounds.filter((r) => r.verdict === "APPROVE").length,
      request_changes: rounds.filter((r) => r.verdict === "REQUEST_CHANGES").length,
      rounds: rounds.length,
      spend_usd: spendTotal,
      overruns,
      awaiting_you: input.awaitingYou,
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
    duration: { ...dist(durations), overrun_rate: finishedLive.length ? overruns / finishedLive.length : null },
    author_response: dist(responses),
    review_depth: dist(depthValues, DEPTH_BUCKETS),
    size,
    pingpong,
    events_by_kind: eventsByKind,
  };
}

// ---- daily rows ------------------------------------------------------------

export function dailyRows(rounds: RoundRow[], now: Date, timeZone: string, days = 30): DailyRow[] {
  const wanted: string[] = [];
  for (let i = days - 1; i >= 0; i--) wanted.push(zoneDateString(new Date(now.getTime() - i * 86_400_000), timeZone));
  const byDay = new Map<string, DailyRow & { prSet: Set<number> }>();
  for (const day of wanted) {
    byDay.set(day, { day, rounds: 0, prs: 0, spend_usd: 0, approvals: 0, request_changes: 0, prSet: new Set() });
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
 * (rounds up to and including it), or every round of a PR GitHub closed. */
export function resolutionByPr(store: StateStore, rounds: RoundRow[], events: ParsedEvent[]): Map<number, number> {
  const closed = new Set<number>();
  for (const e of events) if (e.kind === "pr_closed" && e.pr !== null) closed.add(e.pr);
  for (const p of store.allPrs()) if (p.state === "closed") closed.add(p.number);

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
  const timeZone = opts.timeZone ?? "Europe/Warsaw";
  const nowIso = now.toISOString();

  // Expired zombie rounds are excluded from every aggregate window;
  // the per-PR timeline (computeTimeline) still shows them as history.
  const rounds = store.allRounds().filter((r) => r.status !== "expired");
  const events = readEvents(store);
  const allEvents = readEventKinds(store);
  const comments = store.db.prepare("SELECT pr, round_no, posted_at FROM bot_comments").all() as CommentRow[];
  const threads = readThreads(store);
  const intervals = stateIntervals(events, nowIso);
  const awaitingYou = store.allPrs().filter((p) => p.state === "awaiting_human").length;
  const resolvedPrs = resolutionByPr(store, rounds, events);

  const base = { rounds, events, allEvents, comments, threads, intervals, awaitingYou, resolvedPrs, nowIso };
  const iso = (daysAgo: number): string => new Date(now.getTime() - daysAgo * 86_400_000).toISOString();

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
  return { heartbeat: null, dry_run: false, running_rounds: 0, max_concurrent_rounds: 0, build: null };
}

/**
 * Read the operational facts that do not live in sqlite: the daemon's
 * `status.json` snapshot and the `BUILD_SHA` marker deploy.sh rsyncs into the
 * sandbox root. Both are optional — a missing/corrupt file degrades to the
 * empty value for its fields and NEVER throws (a metrics read must not be able
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
    ops.heartbeat = typeof snap.heartbeat === "string" ? snap.heartbeat : typeof snap.written_at === "string" ? snap.written_at : null;
    if (typeof snap.dry_run === "boolean") ops.dry_run = snap.dry_run;
    if (typeof snap.running_rounds === "number") ops.running_rounds = snap.running_rounds;
    if (typeof snap.max_concurrent_rounds === "number") ops.max_concurrent_rounds = snap.max_concurrent_rounds;
  } catch {
    /* no snapshot (or an unreadable one) — the nulls/zeros stand */
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
        if (what === "trigger") push(e.ts, "trigger", "triggered", typeof e.data.reason === "string" ? e.data.reason : null);
        if (from !== to) push(e.ts, "transition", `${from} -> ${to}`, what || null);
        break;
      }
      case "head_push":
        push(e.ts, "head_push", "author pushed", typeof e.data.head_sha === "string" ? e.data.head_sha.slice(0, 10) : null);
        break;
      case "pr_closed":
        push(e.ts, "close", e.data.merged ? "merged" : "closed", null);
        break;
      default:
        break;
    }
  }

  for (const r of rounds) {
    if (r.backfilled === 1) {
      push(r.finished_at ?? r.started_at, "backfilled_round", `round ${r.round_no} (backfill) ${r.verdict ?? "—"}`, null);
      continue;
    }
    push(r.started_at, "round_start", `round ${r.round_no} start (${r.round_type})`, r.lenses || null);
    if (r.finished_at) {
      const bits = [
        r.verdict ?? r.status,
        r.est_usd !== null ? `$${r.est_usd.toFixed(2)}` : null,
        r.duration_s !== null ? `${Math.round(r.duration_s)}s` : null,
      ].filter(Boolean);
      push(r.finished_at, "round_finish", `round ${r.round_no} ${r.verdict ?? r.status}`, bits.join(" · "));
    }
  }

  items.sort((a, b) => (a.ts === b.ts ? 0 : a.ts < b.ts ? -1 : 1));

  const payload: TimelinePayload = {
    pr,
    known: row !== undefined || rounds.length > 0 || meta !== undefined,
    items,
    backfilled_rounds: rounds
      .filter((r) => r.backfilled === 1)
      .map((r) => ({
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
  s === null ? "—" : s >= 3600 ? `${(s / 3600).toFixed(1)}h` : s >= 60 ? `${(s / 60).toFixed(1)}m` : `${Math.round(s)}s`;

export function renderMetrics(payload: MetricsPayload): string {
  const lines: string[] = [];
  const w = payload.windows.d7;
  lines.push(`quickreview metrics — generated ${payload.generated_at}`);
  const ops = payload.ops;
  lines.push(
    // Without a snapshot the mode is unknown — never guess "LIVE".
    `daemon: ${ops.heartbeat === null ? "mode unknown" : ops.dry_run ? "DRY-RUN" : "LIVE"} · heartbeat ${ops.heartbeat ?? "—"} · ` +
      `rounds ${ops.running_rounds}/${ops.max_concurrent_rounds} · ` +
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
  lines.push(`awaiting you: ${w.header.awaiting_you}`);
  lines.push(
    `ttfv (7d): median ${fmtSecs(w.ttfv.median)} p90 ${fmtSecs(w.ttfv.p90)} ` +
      `(queue ${fmtSecs(w.ttfv.queue_median_s)}, review ${fmtSecs(w.ttfv.review_median_s)}) n=${w.ttfv.n}`,
  );
  lines.push(
    `duration (7d): median ${fmtSecs(w.duration.median)} p90 ${fmtSecs(w.duration.p90)} ` +
      `overrun-rate ${w.duration.overrun_rate === null ? "—" : `${Math.round(w.duration.overrun_rate * 100)}%`}`,
  );
  lines.push(`rounds until resolution (7d): median ${w.rounds_until_resolution.median ?? "—"} n=${w.rounds_until_resolution.n}`);
  lines.push(`verdict mix (7d): ${w.verdict_mix.map((v) => `${v.verdict} ${v.count}`).join("  ") || "—"}`);
  lines.push(`events (7d): ${w.events_by_kind.map((e) => `${e.kind} ${e.count}`).join("  ") || "—"}`);
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
    lines.push(`backfill: ${payload.backfill.rounds} rounds across ${payload.backfill.prs} PRs, oldest ${payload.backfill.oldest}`);
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
    lines.push(`${item.ts}  ${item.kind.padEnd(16)} ${item.label}${item.detail ? ` — ${item.detail}` : ""}`);
  }
  return lines.join("\n");
}

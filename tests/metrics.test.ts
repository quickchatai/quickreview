import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../src/state.js";
import { PingPongLedger } from "../src/pingpong.js";
import { parseBuildSha } from "../src/tui/deploytab.js";
import {
  COUNT_BUCKETS,
  EVENT_KIND_CAP,
  computeMetrics,
  computeTimeline,
  dist,
  emptyOps,
  readOps,
  histogram,
  percentile,
  renderMetrics,
  renderTimeline,
} from "../src/metrics.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const NOW = new Date("2026-08-14T12:00:00.000Z");
const now = () => NOW;

let store: StateStore;

beforeEach(() => {
  store = new StateStore(":memory:", now);
  seed(store);
});
afterEach(() => store.close());

// ---- seeding ---------------------------------------------------------------

interface RoundSeed {
  pr: number;
  round_no: number;
  round_type?: string;
  lenses?: string;
  verdict?: string | null;
  /** Seed spend — lands in est_usd, the one spend field. */
  spend_usd?: number | null;
  duration_s?: number | null;
  started_at: string;
  deadline_at?: string;
  finished_at?: string | null;
  status?: string;
  additions?: number | null;
  deletions?: number | null;
  changed_files?: number | null;
  backfilled?: number;
  trigger_ts?: string | null;
}

function insertRound(s: StateStore, r: RoundSeed): void {
  s.db
    .prepare(
      `INSERT INTO rounds (pr, round_no, round_type, lenses, verdict, est_usd, duration_s, started_at,
                           deadline_at, finished_at, status, additions, deletions, changed_files, backfilled, trigger_ts)
       VALUES (@pr, @round_no, @round_type, @lenses, @verdict, @spend_usd, @duration_s, @started_at,
               @deadline_at, @finished_at, @status, @additions, @deletions, @changed_files, @backfilled, @trigger_ts)`,
    )
    .run({
      round_type: "first",
      lenses: "pass-baseline,pass-validate",
      verdict: null,
      spend_usd: null,
      duration_s: null,
      deadline_at: r.finished_at ?? r.started_at,
      finished_at: null,
      status: "done",
      additions: null,
      deletions: null,
      changed_files: null,
      backfilled: 0,
      trigger_ts: null,
      ...r,
    });
}

function insertEvent(
  s: StateStore,
  ts: string,
  kind: string,
  pr: number | null,
  payload: unknown,
): void {
  s.db
    .prepare("INSERT INTO events (ts, kind, pr, payload) VALUES (?, ?, ?, ?)")
    .run(ts, kind, pr, JSON.stringify(payload));
}

function insertComment(
  s: StateStore,
  id: number,
  pr: number,
  roundNo: number,
  postedAt: string,
): void {
  s.db
    .prepare(
      "INSERT INTO bot_comments (comment_id, pr, kind, posted_at, round_no) VALUES (?, ?, 'review_comment', ?, ?)",
    )
    .run(id, pr, postedAt, roundNo);
}

/** A small but realistic history: one PR reviewed twice to an approval, one
 * escalated + overdue PR, and one PR that exists only as imported history. */
function seed(s: StateStore): void {
  s.upsertPr({
    number: 100,
    state: "tracked",
    head_sha: "aaa1",
    title: "PR 100",
    author: "alice",
    trigger_ts: null,
    stale_recheck: 0,
    migration_gate: 0,
  });
  s.upsertPr({
    number: 101,
    state: "tracked",
    head_sha: "bbb1",
    title: "PR 101",
    author: "bob",
    trigger_ts: null,
    stale_recheck: 0,
    migration_gate: 0,
  });

  // PR 100 — two daemon rounds ending in an approval.
  insertRound(s, {
    pr: 100,
    round_no: 1,
    round_type: "first",
    verdict: "REQUEST_CHANGES",
    spend_usd: 1.5,
    duration_s: 900,
    started_at: "2026-08-14T09:05:00.000Z",
    deadline_at: "2026-08-14T09:50:00.000Z",
    finished_at: "2026-08-14T09:20:00.000Z",
    additions: 30,
    deletions: 10,
    changed_files: 3,
    trigger_ts: "2026-08-14T09:00:00.000Z",
  });
  insertRound(s, {
    pr: 100,
    round_no: 2,
    round_type: "re-review",
    lenses: "pass-baseline,pass-validate",
    verdict: "APPROVE",
    spend_usd: 2,
    duration_s: 1800,
    started_at: "2026-08-14T10:05:00.000Z",
    deadline_at: "2026-08-14T10:50:00.000Z",
    finished_at: "2026-08-14T10:35:00.000Z",
    additions: 30,
    deletions: 10,
    changed_files: 3,
    trigger_ts: "2026-08-14T10:00:00.000Z",
  });
  // PR 101 — one escalated round that blew its deadline (an overrun).
  insertRound(s, {
    pr: 101,
    round_no: 1,
    round_type: "first",
    lenses: "pass-security,pass-validate",
    verdict: "ESCALATE",
    spend_usd: 0.5,
    duration_s: 2700,
    started_at: "2026-08-14T11:00:00.000Z",
    deadline_at: "2026-08-14T11:30:00.000Z",
    finished_at: "2026-08-14T11:45:00.000Z",
    additions: 500,
    deletions: 200,
    changed_files: 21,
    trigger_ts: "2026-08-14T10:50:00.000Z",
  });
  // PR 200 — imported laptop-era history: verdict + timestamps, no spend/duration.
  insertRound(s, {
    pr: 200,
    round_no: 0,
    round_type: "backfill",
    lenses: "",
    verdict: "APPROVE",
    started_at: "2026-08-01T09:00:00.000Z",
    deadline_at: "2026-08-01T10:00:00.000Z",
    finished_at: "2026-08-01T10:00:00.000Z",
    backfilled: 1,
    trigger_ts: "2026-08-01T09:00:00.000Z",
  });
  s.upsertBackfillPrMeta({
    pr: 200,
    title: "old PR",
    author: "carol",
    created_at: "2026-07-30T08:00:00.000Z",
    merged_at: "2026-08-02T08:00:00.000Z",
    closed_at: "2026-08-02T08:00:00.000Z",
    merged: 1,
  });

  const t = (ts: string, from: string | null, to: string, event: string): void =>
    insertEvent(s, ts, "pr_transition", 100, { from, to, event, reason: null });
  t("2026-08-14T09:00:00.000Z", "tracked", "queued", "trigger");
  t("2026-08-14T09:05:00.000Z", "queued", "reviewing", "dispatched");
  t("2026-08-14T09:20:00.000Z", "reviewing", "awaiting_author", "verdict");
  t("2026-08-14T10:05:00.000Z", "awaiting_author", "reviewing", "dispatched");
  t("2026-08-14T10:35:00.000Z", "reviewing", "tracked", "verdict");
  insertEvent(s, "2026-08-14T10:50:00.000Z", "pr_transition", 101, {
    from: "tracked",
    to: "queued",
    event: "trigger",
  });
  insertEvent(s, "2026-08-14T11:45:00.000Z", "pr_transition", 101, {
    from: "reviewing",
    to: "awaiting_human",
    event: "verdict",
  });

  insertEvent(s, "2026-08-14T09:20:00.000Z", "verdict_applied", 100, {
    verdict: "REQUEST_CHANGES",
    head_sha: "aaa0",
  });
  insertEvent(s, "2026-08-14T09:50:00.000Z", "head_push", 100, {
    head_sha: "aaa1",
    source: "webhook",
  });
  insertEvent(s, "2026-08-14T10:35:00.000Z", "verdict_applied", 100, {
    verdict: "APPROVE",
    head_sha: "aaa1",
  });

  insertComment(s, 9001, 100, 1, "2026-08-14T09:20:00.000Z");
  insertComment(s, 9002, 100, 1, "2026-08-14T09:20:00.000Z");
  insertComment(s, 9003, 100, 1, "2026-08-14T09:20:00.000Z");
  insertComment(s, 9004, 100, 2, "2026-08-14T10:35:00.000Z");

  const ledger = new PingPongLedger(s.db, now);
  ledger.recordExchange(555, 100);
  ledger.recordExchange(555, 100);
  ledger.recordExchange(555, 100);
  ledger.recordCapHit(555, 100);
}

// ---- statistics ------------------------------------------------------------

describe("statistics", () => {
  it("takes nearest-rank percentiles", { timeout: HEAVY_TIMEOUT_MS }, () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([5], 0.9)).toBe(5);
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2); // ceil(0.5*4) = 2nd value
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
  });

  it("keeps zero-count buckets in histograms", () => {
    const h = histogram(
      [30, 30, 100_000],
      [
        { label: "<1m", max: 60 },
        { label: "<5m", max: 300 },
        { label: ">=5m", max: Number.POSITIVE_INFINITY },
      ],
    );
    expect(h).toEqual([
      { label: "<1m", count: 2 },
      { label: "<5m", count: 0 },
      { label: ">=5m", count: 1 },
    ]);
    expect(dist([]).n).toBe(0);
    expect(dist([]).median).toBeNull();
  });

  it("puts an exact time boundary in the bucket its '<' label admits", () => {
    const h = dist([59, 60, 86_400]).histogram;
    expect(h.find((b) => b.label === "<1m")!.count).toBe(1);
    expect(h.find((b) => b.label === "<5m")!.count).toBe(1);
    expect(h.find((b) => b.label === ">=1d")!.count).toBe(1);
    // count buckets stay inclusive: 1 round is the "1" bucket
    expect(dist([1], COUNT_BUCKETS).histogram[0]).toEqual({ label: "1", count: 1 });
  });
});

// ---- the payload -----------------------------------------------------------

describe("computeMetrics", () => {
  it("summarises the window header, counting backfilled verdicts but not their (absent) cost", () => {
    const m = computeMetrics(store, { now });
    expect(m.generated_at).toBe(NOW.toISOString());

    expect(m.windows.d7.header).toEqual({
      prs_triggered: 2,
      prs_reviewed: 2,
      approvals: 1,
      request_changes: 1,
      rounds: 3,
      spend_usd: 4,
      overruns: 1,
    });
    // The backfilled round joins the 30-day/all windows: one more round, one
    // more APPROVE, no extra dollar.
    expect(m.windows.d30.header).toMatchObject({
      rounds: 4,
      approvals: 2,
      spend_usd: 4,
      overruns: 1,
    });
    expect(m.windows.all.header).toMatchObject({ rounds: 4, approvals: 2, spend_usd: 4 });
  });

  it("splits time-to-first-verdict into queue and review halves", () => {
    const m = computeMetrics(store, { now });
    const ttfv = m.windows.d7.ttfv;
    // #100: 09:00 -> 09:20 = 1200s; #101: 10:50 -> 11:45 = 3300s
    expect(ttfv.n).toBe(2);
    expect(ttfv.median).toBe(1200);
    expect(ttfv.p90).toBe(3300);
    expect(ttfv.queue_median_s).toBe(300);
    expect(ttfv.review_median_s).toBe(1800); // [900, 1800, 2700], nearest-rank
    expect(ttfv.histogram.find((b) => b.label === "<1h")!.count).toBe(2);

    // The backfilled round carries real timestamps, so it counts in ttfv.
    expect(m.windows.all.ttfv.n).toBe(3);
    expect(m.windows.all.ttfv.median).toBe(3300);
  });

  it("derives time-in-state dwell from the transition log, running the open state up to now", () => {
    const byState = new Map(
      computeMetrics(store, { now }).windows.d7.time_in_state.map((r) => [r.state, r]),
    );
    expect(byState.get("queued")!.total_s).toBe(3600); // #100 300s + #101 3300s
    expect(byState.get("queued")!.median_s).toBe(300);
    expect(byState.get("awaiting_author")!.total_s).toBe(2700);
    expect(byState.get("reviewing")!.total_s).toBe(900 + 1800);
    expect(byState.get("reviewing")!.median_s).toBe(900);
    expect(byState.get("tracked")!.total_s).toBe(5100); // 10:35 -> 12:00, still open
    expect(byState.get("awaiting_human")!.total_s).toBe(900); // 11:45 -> 12:00
  });

  it("reports verdict mix, spend attribution and rounds until resolution", () => {
    const w = computeMetrics(store, { now }).windows.d7;
    expect(w.verdict_mix).toEqual([
      { verdict: "APPROVE", count: 1 },
      { verdict: "ESCALATE", count: 1 },
      { verdict: "REQUEST_CHANGES", count: 1 },
    ]);
    expect(w.spend.by_round_type).toEqual({ first: 2, "re-review": 2 });
    expect(w.spend.by_lens).toEqual({
      "pass-baseline": 3.5,
      "pass-validate": 4,
      "pass-security": 0.5,
    });
    expect(w.spend.per_pr_median).toBe(0.5);
    expect(w.spend.per_pr_p90).toBe(3.5);
    // #100 approved on its 2nd round; #101 is still open, so it does not count.
    expect(w.rounds_until_resolution.n).toBe(1);
    expect(w.rounds_until_resolution.median).toBe(2);
    expect(w.rounds_until_resolution.histogram.map((b) => b.label)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5+",
    ]);
  });

  it("keeps the queue and review legs free of backfilled rows", () => {
    // Imported rounds start at their reconstructed trigger: queue 0 s, review
    // = the whole trigger-to-verdict interval. Neither leg was measured.
    for (const pr of [300, 301])
      insertRound(store, {
        pr,
        round_no: 0,
        round_type: "backfill",
        lenses: "",
        verdict: "APPROVE",
        started_at: "2026-08-02T09:00:00.000Z",
        finished_at: "2026-08-02T10:00:00.000Z",
        backfilled: 1,
        trigger_ts: "2026-08-02T09:00:00.000Z",
      });
    const all = computeMetrics(store, { now }).windows.all.ttfv;
    expect(all.queue_median_s).toBe(300); // live [300, 300, 600]
    expect(all.review_median_s).toBe(1800); // live [900, 1800, 2700]
    expect(all.n).toBe(5); // the imported rounds still count in ttfv itself
  });

  it("counts a time-in-state interval entered before the window", () => {
    // #102 has been awaiting its author for 8 days; #103 left review before
    // the 7-day window opened.
    const at = (daysAgo: number): string =>
      new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString();
    insertEvent(store, at(8), "pr_transition", 102, { to: "awaiting_author", event: "verdict" });
    insertEvent(store, at(10), "pr_transition", 103, { to: "reviewing", event: "dispatched" });
    insertEvent(store, at(9), "pr_transition", 103, { to: "closed", event: "closed" });
    const byState = new Map(
      computeMetrics(store, { now }).windows.d7.time_in_state.map((r) => [r.state, r]),
    );
    // inside the window: #100's 2700 s plus the 7 days #102 spent in it
    expect(byState.get("awaiting_author")!.total_s).toBe(2700 + 7 * 86_400);
    // the median is over whole dwells: [2700, 8 days], nearest rank
    expect(byState.get("awaiting_author")!.median_s).toBe(2700);
    // #103's review ended before the window: reviewing is #100's alone
    expect(byState.get("reviewing")!.total_s).toBe(900 + 1800);
  });

  it("resolves an imported closed PR that never got an approval", () => {
    insertRound(store, {
      pr: 300,
      round_no: 0,
      round_type: "backfill",
      lenses: "",
      verdict: "REQUEST_CHANGES",
      started_at: "2026-08-03T09:00:00.000Z",
      finished_at: "2026-08-03T10:00:00.000Z",
      backfilled: 1,
    });
    store.upsertBackfillPrMeta({
      pr: 300,
      title: "closed unapproved",
      author: "dan",
      created_at: "2026-08-03T08:00:00.000Z",
      merged_at: null,
      closed_at: "2026-08-04T08:00:00.000Z",
      merged: 0,
    });
    // #100 (2 rounds), #200 (approved import, 1), #300 (closed import, 1)
    expect(computeMetrics(store, { now }).windows.all.rounds_until_resolution.n).toBe(3);
  });

  it("keeps duration, overruns and spend free of backfilled rows", () => {
    const m = computeMetrics(store, { now });
    expect(m.windows.all.duration.n).toBe(3); // the backfilled round has no duration
    expect(m.windows.all.duration.median).toBe(1800);
    expect(m.windows.all.duration.overrun_rate).toBeCloseTo(1 / 3);
    expect(m.windows.all.spend.by_round_type.backfill).toBeUndefined();
  });

  it("measures author response, review depth, size buckets and ping-pong depth", () => {
    const w = computeMetrics(store, { now }).windows.all;
    expect(w.author_response.n).toBe(1); // only the first verdict was followed by a push
    expect(w.author_response.median).toBe(1800);

    expect(w.review_depth.n).toBe(2); // two rounds carry linked comments
    expect(w.review_depth.median).toBe(1);
    expect(w.review_depth.p90).toBe(3);

    const size = new Map(w.size.map((r) => [r.bucket, r]));
    expect(size.get("S")).toEqual({ bucket: "S", prs: 1, median_ttfv_s: 1200 });
    expect(size.get("XL")).toEqual({ bucket: "XL", prs: 1, median_ttfv_s: 3300 });
    expect(size.get("XS")!.prs).toBe(0); // the backfilled PR has no diffstat

    expect(w.pingpong.n).toBe(1);
    expect(w.pingpong.median).toBe(3);
    expect(w.pingpong.cap_hits).toBe(1);
  });

  it("emits 30 contiguous Warsaw days, gaps zero-filled, oldest first", () => {
    const m = computeMetrics(store, { now });
    expect(m.daily).toHaveLength(30);
    expect(m.daily[0]!.day).toBe("2026-07-16");
    expect(m.daily[29]!.day).toBe("2026-08-14");
    expect(m.daily[29]).toEqual({
      day: "2026-08-14",
      rounds: 3,
      prs: 2,
      spend_usd: 4,
      approvals: 1,
      request_changes: 1,
    });
    const backfillDay = m.daily.find((d) => d.day === "2026-08-01")!;
    expect(backfillDay).toEqual({
      day: "2026-08-01",
      rounds: 1,
      prs: 1,
      spend_usd: 0,
      approvals: 1,
      request_changes: 0,
    });
    expect(m.daily.find((d) => d.day === "2026-08-05")).toEqual({
      day: "2026-08-05",
      rounds: 0,
      prs: 0,
      spend_usd: 0,
      approvals: 0,
      request_changes: 0,
    });
  });

  it("reports the backfill footprint", () => {
    expect(computeMetrics(store, { now }).backfill).toEqual({
      rounds: 1,
      prs: 1,
      oldest: "2026-08-01T09:00:00.000Z",
    });
  });

  it("buckets ops days by the configured zone's local date, not UTC (zone from opts)", () => {
    // 23:30Z on 2026-08-13 is already 2026-08-14 in Warsaw (CEST, UTC+2).
    insertRound(store, {
      pr: 300,
      round_no: 1,
      verdict: "APPROVE",
      spend_usd: 1,
      started_at: "2026-08-13T23:30:00.000Z",
      finished_at: "2026-08-13T23:40:00.000Z",
    });
    const m = computeMetrics(store, { now, timeZone: "Europe/Warsaw" });
    expect(m.daily.find((d) => d.day === "2026-08-14")!.rounds).toBe(4);
    expect(m.daily.find((d) => d.day === "2026-08-13")!.rounds).toBe(0);
  });

  it("renders a human-readable table", () => {
    const text = renderMetrics(computeMetrics(store, { now }));
    expect(text).toContain("quickreview metrics");
    expect(text).toContain("2026-08-14");
    expect(text).toContain("backfill: 1 rounds across 1 PRs");
  });

  it("is empty-store safe", () => {
    const empty = new StateStore(":memory:", now);
    try {
      const m = computeMetrics(empty, { now });
      expect(m.windows.all.header.rounds).toBe(0);
      expect(m.windows.all.ttfv.median).toBeNull();
      expect(m.windows.all.duration.overrun_rate).toBeNull();
      expect(m.windows.all.pingpong.cap_hits).toBe(0); // no pingpong tables yet
      expect(m.daily).toHaveLength(30);
      expect(m.backfill).toEqual({ rounds: 0, prs: 0, oldest: null });
    } finally {
      empty.close();
    }
  });

  it.each(["cancelled", "overdue", "expired"])(
    "time-to-first-verdict skips a first round that ended %s without a verdict",
    (status) => {
      const s = new StateStore(":memory:", now);
      try {
        // Round 1 died five minutes in; round 2 delivered the verdict at 45m.
        insertRound(s, {
          pr: 310,
          round_no: 1,
          trigger_ts: "2026-08-14T09:00:00.000Z",
          started_at: "2026-08-14T09:01:00.000Z",
          finished_at: "2026-08-14T09:05:00.000Z",
          status,
        });
        insertRound(s, {
          pr: 310,
          round_no: 2,
          trigger_ts: "2026-08-14T09:00:00.000Z",
          started_at: "2026-08-14T09:06:00.000Z",
          finished_at: "2026-08-14T09:45:00.000Z",
          verdict: "APPROVE",
        });
        const m = computeMetrics(s, { now });
        expect(m.windows.all.ttfv.n).toBe(1);
        expect(m.windows.all.ttfv.median).toBe(2700);
      } finally {
        s.close();
      }
    },
  );

  it.each(["cancelled", "overdue", "expired"])(
    "a PR whose only round ended %s is not counted as reviewed",
    (status) => {
      const s = new StateStore(":memory:", now);
      try {
        insertRound(s, {
          pr: 320,
          round_no: 1,
          trigger_ts: "2026-08-14T09:00:00.000Z",
          started_at: "2026-08-14T09:01:00.000Z",
          finished_at: "2026-08-14T09:05:00.000Z",
          status,
        });
        insertRound(s, {
          pr: 321,
          round_no: 1,
          trigger_ts: "2026-08-14T09:00:00.000Z",
          started_at: "2026-08-14T09:06:00.000Z",
          finished_at: "2026-08-14T09:45:00.000Z",
          verdict: "APPROVE",
        });
        const header = computeMetrics(s, { now }).windows.all.header;
        expect(header.rounds).toBe(2);
        expect(header.prs_reviewed).toBe(1);
      } finally {
        s.close();
      }
    },
  );

  it("time-to-first-verdict is the PR's FIRST round across all history, not the first inside the window", () => {
    const s = new StateStore(":memory:", now);
    try {
      // Round 1 landed 20 days ago; round 3 lands today.
      insertRound(s, {
        pr: 300,
        round_no: 1,
        trigger_ts: "2026-07-25T09:00:00.000Z",
        started_at: "2026-07-25T09:00:00.000Z",
        finished_at: "2026-07-25T09:10:00.000Z",
        additions: 5,
        deletions: 0,
      });
      insertRound(s, {
        pr: 300,
        round_no: 3,
        trigger_ts: "2026-08-14T09:00:00.000Z",
        started_at: "2026-08-14T09:00:00.000Z",
        finished_at: "2026-08-14T10:00:00.000Z",
        additions: 5,
        deletions: 0,
      });
      const m = computeMetrics(s, { now });
      // The first verdict was outside the 7-day window: no sample there.
      expect(m.windows.d7.ttfv.n).toBe(0);
      expect(m.windows.d7.size.find((b) => b.bucket === "XS")!.median_ttfv_s).toBeNull();
      // Across all history it is round 1's ten minutes, not round 3's hour.
      expect(m.windows.all.ttfv.n).toBe(1);
      expect(m.windows.all.ttfv.median).toBe(600);
    } finally {
      s.close();
    }
  });

  it.each([
    ["spring forward", "2026-03-29T22:30:00.000Z", ["2026-03-28", "2026-03-29", "2026-03-30"]],
    ["fall back", "2026-10-25T22:30:00.000Z", ["2026-10-23", "2026-10-24", "2026-10-25"]],
  ])("daily rows are consecutive calendar days across a DST %s", (_label, at, tail) => {
    const s = new StateStore(":memory:", now);
    try {
      const m = computeMetrics(s, { now: () => new Date(at), timeZone: "Europe/Warsaw" });
      const days = m.daily.map((d) => d.day);
      expect(days).toHaveLength(30);
      expect(new Set(days).size).toBe(30);
      expect(days.slice(-3)).toEqual(tail);
    } finally {
      s.close();
    }
  });
});

// ---- the per-PR timeline ---------------------------------------------------

describe("computeTimeline", () => {
  it("orders every recorded moment ascending", () => {
    const tl = computeTimeline(store, 100);
    expect(tl.known).toBe(true);
    expect(tl.title).toBe("PR 100");
    expect(tl.author).toBe("alice");
    const ts = tl.items.map((i) => i.ts);
    expect([...ts].sort()).toEqual(ts);
    expect(tl.items.filter((i) => i.kind === "round_start")).toHaveLength(2);
    expect(tl.items.filter((i) => i.kind === "round_finish")).toHaveLength(2);
    expect(tl.items.some((i) => i.kind === "trigger")).toBe(true);
    expect(tl.items.some((i) => i.kind === "head_push")).toBe(true);
    const finish = tl.items.find((i) => i.kind === "round_finish")!;
    expect(finish.label).toContain("REQUEST_CHANGES");
    expect(finish.detail).toContain("$1.50");
    expect(tl.backfilled_rounds).toEqual([]);
  });

  it("surfaces imported history for a PR the daemon never tracked", () => {
    const tl = computeTimeline(store, 200);
    expect(tl.known).toBe(true);
    expect(tl.title).toBe("old PR");
    expect(tl.author).toBe("carol");
    expect(tl.backfilled_rounds).toEqual([
      {
        round_no: 0,
        submitted_at: "2026-08-01T10:00:00.000Z",
        verdict: "APPROVE",
        trigger_ts: "2026-08-01T09:00:00.000Z",
      },
    ]);
    expect(tl.items.every((i) => i.kind !== "round_start")).toBe(true);
  });

  it("says so when nothing is known", () => {
    const tl = computeTimeline(store, 999);
    expect(tl.known).toBe(false);
    expect(tl.items).toEqual([]);
    expect(renderTimeline(tl)).toBe("nothing known about #999");
  });
});

// ---- schema ----------------------------------------------------------------

describe("schema migrations", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qcr-metrics-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it(
    "adds the metrics columns once and re-opens idempotently",
    { timeout: HEAVY_TIMEOUT_MS },
    () => {
      const path = join(dir, "state.db");
      for (let i = 0; i < 3; i++) {
        const s = new StateStore(path, now);
        const cols = (
          s.db.prepare("PRAGMA table_info(rounds)").all() as Array<{ name: string }>
        ).map((c) => c.name);
        for (const c of [
          "additions",
          "deletions",
          "changed_files",
          "backfilled",
          "gh_review_id",
          "gh_commit_id",
          "trigger_ts",
        ]) {
          expect(cols.filter((x) => x === c)).toHaveLength(1);
        }
        const commentCols = (
          s.db.prepare("PRAGMA table_info(bot_comments)").all() as Array<{ name: string }>
        ).map((c) => c.name);
        expect(commentCols.filter((x) => x === "round_no")).toHaveLength(1);
        expect(s.allBackfillPrMeta()).toEqual([]);
        s.close();
      }
    },
  );

  it("migrates a pre-existing store that has none of the new columns", () => {
    const path = join(dir, "legacy.db");
    const legacy = new StateStore(path, now);
    // Simulate the old shape by dropping the columns via a rebuild.
    legacy.db.exec("DROP TABLE rounds");
    legacy.db.exec(
      `CREATE TABLE rounds (id INTEGER PRIMARY KEY AUTOINCREMENT, pr INTEGER NOT NULL, round_no INTEGER NOT NULL,
        round_type TEXT NOT NULL, lenses TEXT NOT NULL, verdict TEXT, spend_usd REAL, duration_s REAL,
        started_at TEXT NOT NULL, deadline_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL DEFAULT 'running')`,
    );
    legacy.db
      .prepare(
        `INSERT INTO rounds (pr, round_no, round_type, lenses, verdict, started_at, deadline_at, status)
         VALUES (7, 1, 'first', 'pass-baseline', 'APPROVE', '2026-08-14T09:00:00.000Z', '2026-08-14T09:45:00.000Z', 'done')`,
      )
      .run();
    legacy.close();

    const migrated = new StateStore(path, now);
    try {
      const row = migrated.roundsFor(7)[0]!;
      expect(row.backfilled).toBe(0);
      expect(row.additions).toBeNull();
      expect(row.trigger_ts).toBeNull();
      expect(migrated.priorRoundCount(7)).toBe(1);
    } finally {
      migrated.close();
    }
  });

  it("defaults a registered bot comment to the PR's latest daemon-run round", () => {
    store.registerBotComment(7777, 100);
    const row = store.db
      .prepare("SELECT round_no FROM bot_comments WHERE comment_id = 7777")
      .get() as { round_no: number };
    expect(row.round_no).toBe(2);
    // An explicit round wins, and an unknown PR simply records no link.
    store.registerBotComment(7778, 100, "review", 1);
    store.registerBotComment(7779, 4242);
    expect(
      (store.db.prepare("SELECT round_no FROM bot_comments WHERE comment_id = 7778").get() as any)
        .round_no,
    ).toBe(1);
    expect(
      (store.db.prepare("SELECT round_no FROM bot_comments WHERE comment_id = 7779").get() as any)
        .round_no,
    ).toBeNull();
  });
});

// ---- the operational half ---------------------------------------------------

describe("events_by_kind", () => {
  it("counts EVERY event kind in the window, busiest first", () => {
    insertEvent(store, "2026-08-14T11:00:00.000Z", "overseer_anomaly", null, {
      what: "malformed verdict",
    });
    const w = computeMetrics(store, { now }).windows.d7;
    expect(w.events_by_kind).toEqual([
      { kind: "pr_transition", count: 7 },
      { kind: "verdict_applied", count: 2 },
      { kind: "head_push", count: 1 },
      { kind: "overseer_anomaly", count: 1 },
    ]);
    // counts descend; ties fall back to the kind name
    const counts = w.events_by_kind.map((e) => e.count);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
  });

  it("respects the window boundaries", () => {
    insertEvent(store, "2026-07-01T09:00:00.000Z", "ancient_kind", null, {});
    insertEvent(store, "2026-08-10T09:00:00.000Z", "recent_kind", null, {});
    const m = computeMetrics(store, { now });
    const kinds = (k: "d7" | "d30" | "all") => m.windows[k].events_by_kind.map((e) => e.kind);
    expect(kinds("d7")).toContain("recent_kind");
    expect(kinds("d7")).not.toContain("ancient_kind");
    expect(kinds("d30")).not.toContain("ancient_kind"); // 2026-07-01 is >30d back
    expect(kinds("all")).toContain("ancient_kind");
  });

  it("caps the list at 12 kinds, keeping the busiest", () => {
    for (let i = 0; i < 15; i++) {
      for (let n = 0; n <= i; n++)
        insertEvent(store, "2026-08-14T11:30:00.000Z", `k${String(i).padStart(2, "0")}`, null, {});
    }
    const w = computeMetrics(store, { now }).windows.d7;
    expect(EVENT_KIND_CAP).toBe(12);
    expect(w.events_by_kind).toHaveLength(12);
    expect(w.events_by_kind[0]).toEqual({ kind: "k14", count: 15 });
    expect(w.events_by_kind.map((e) => e.kind)).not.toContain("k00"); // 1 event — squeezed out
  });

  it("is an empty list when nothing happened in the window", () => {
    const empty = new StateStore(":memory:", now);
    try {
      expect(computeMetrics(empty, { now }).windows.all.events_by_kind).toEqual([]);
    } finally {
      empty.close();
    }
  });
});

describe("ops", () => {
  it("computeMetrics fills only what sqlite knows and never invents a build", () => {
    const ops = computeMetrics(store, { now }).ops;
    expect(ops).toEqual({
      heartbeat: null,
      dry_run: null,
      running_rounds: 0,
      max_concurrent_rounds: null,
      build: null,
    });
    expect(emptyOps()).toEqual(ops);
  });

  it("an unread mode or concurrency cap is unknown, never LIVE or a zero cap", () => {
    const text = renderMetrics(computeMetrics(store, { now }));
    expect(text).toContain("mode unknown");
    expect(text).toContain("rounds 0/?");
    // a snapshot with a heartbeat but no mode still claims no mode
    const noMode = {
      readFile: () => JSON.stringify({ heartbeat: "2026-08-14T11:59:30Z" }),
      parseBuildSha,
    };
    const ops = readOps({ statusPath: "/s", buildShaPath: "/b" }, noMode);
    expect(ops.dry_run).toBeNull();
    expect(renderMetrics({ ...computeMetrics(store, { now }), ops })).toContain("mode unknown");
  });

  it("readOps decorates from status.json and the BUILD_SHA marker", () => {
    const files: Record<string, string> = {
      "/s/status.json": JSON.stringify({
        written_at: "2026-08-14T11:59:00Z",
        heartbeat: "2026-08-14T11:59:30Z",
        dry_run: false,
        running_rounds: 2,
        max_concurrent_rounds: 3,
      }),
      "/r/BUILD_SHA": "abc1234 2026-08-13T12:00:00Z sync\n",
    };
    const io = {
      readFile: (p: string) => {
        const v = files[p];
        if (v === undefined) throw new Error(`ENOENT: ${p}`);
        return v;
      },
      parseBuildSha,
    };
    expect(readOps({ statusPath: "/s/status.json", buildShaPath: "/r/BUILD_SHA" }, io)).toEqual({
      heartbeat: "2026-08-14T11:59:30Z",
      dry_run: false,
      running_rounds: 2,
      max_concurrent_rounds: 3,
      build: { sha: "abc1234", at: "2026-08-13T12:00:00Z", mode: "sync" },
    });
  });

  it("degrades to nulls/zeros — a missing or corrupt file is never a throw", () => {
    const throwing = {
      readFile: (p: string): string => {
        throw new Error(`ENOENT: ${p}`);
      },
      parseBuildSha,
    };
    expect(readOps({ statusPath: "/nope", buildShaPath: "/nope" }, throwing)).toEqual(emptyOps());
    // ...and the sqlite-derived base survives the missing files
    const base = { ...emptyOps(), running_rounds: 4 };
    expect(
      readOps({ statusPath: "/nope", buildShaPath: "/nope" }, throwing, base).running_rounds,
    ).toBe(4);

    const junk = { readFile: () => "not json at all", parseBuildSha };
    expect(readOps({ statusPath: "/s", buildShaPath: "/b" }, junk)).toEqual(emptyOps());

    // a snapshot without a heartbeat field falls back to written_at; a marker
    // without a timestamp still yields the sha
    const partial = {
      readFile: (p: string) =>
        p === "/s"
          ? JSON.stringify({ written_at: "2026-08-14T11:00:00Z", dry_run: true })
          : "abc1234\n",
      parseBuildSha,
    };
    expect(readOps({ statusPath: "/s", buildShaPath: "/b" }, partial)).toEqual({
      heartbeat: "2026-08-14T11:00:00Z",
      dry_run: true,
      running_rounds: 0,
      max_concurrent_rounds: null,
      build: { sha: "abc1234", at: "", mode: "" },
    });
  });

  // ---- cancellations ---------------------------------------------------------

  describe("cancellations by cause", () => {
    const cancel = (
      pr: number,
      roundNo: number,
      cause: string,
      startedAt = "2026-08-14T08:00:00.000Z",
    ): void => {
      insertRound(store, {
        pr,
        round_no: roundNo,
        started_at: startedAt,
        finished_at: startedAt,
        status: "cancelled",
      });
      store.db
        .prepare("UPDATE rounds SET cancel_cause = ? WHERE pr = ? AND round_no = ?")
        .run(cause, pr, roundNo);
    };

    it("an empty window says none, rather than nothing at all", () => {
      const c = computeMetrics(store, { now }).windows.d7.cancellations;
      expect(c).toEqual({ total: 0, loud: 0, by_cause: [] });
      expect(renderMetrics(computeMetrics(store, { now }))).toContain("cancelled (7d): none");
    });

    it("groups by cause with the loud one first, whatever the volumes", () => {
      cancel(300, 1, "orphan_sweep");
      cancel(301, 1, "orphan_sweep");
      cancel(302, 1, "orphan_sweep");
      cancel(303, 1, "deadline_overrun");
      cancel(304, 1, "superseded");

      const c = computeMetrics(store, { now }).windows.d7.cancellations;
      expect(c.total).toBe(5);
      // Only the round that stopped dead counts as needing a look — the boot
      // orphan sweep is a redeploy artefact and is counted, never flagged.
      expect(c.loud).toBe(1);
      expect(c.by_cause).toEqual([
        { cause: "deadline_overrun", label: "stopped dead", count: 1, loud: true },
        { cause: "orphan_sweep", label: "orphan sweep (redeploy)", count: 3, loud: false },
        { cause: "superseded", label: "superseded", count: 1, loud: false },
      ]);
    });

    it("renders one line naming every cause and flagging only the loud one", () => {
      cancel(300, 1, "orphan_sweep");
      cancel(303, 1, "deadline_overrun");
      const text = renderMetrics(computeMetrics(store, { now }));
      expect(text).toContain(
        "cancelled (7d): 2 — stopped dead 1 ⚑, orphan sweep (redeploy) 1  (1 needing a look)",
      );
    });

    it("an unclassified cancellation is reported as unclassified, not folded in", () => {
      insertRound(store, {
        pr: 305,
        round_no: 1,
        started_at: "2026-08-14T08:00:00.000Z",
        finished_at: "2026-08-14T08:10:00.000Z",
        status: "cancelled",
      });
      const c = computeMetrics(store, { now }).windows.d7.cancellations;
      expect(c.by_cause).toEqual([
        { cause: "unknown", label: "unclassified", count: 1, loud: false },
      ]);
    });
  });

  describe("expired rounds in the aggregates", () => {
    beforeEach(() => {
      // A round that ran, burned $4, blew its deadline and was later buried by
      // the zombie sweep — with a `finished_at` stamped by that sweep, hours
      // after anything really happened.
      insertRound(store, {
        pr: 400,
        round_no: 1,
        spend_usd: 4,
        started_at: "2026-08-14T08:00:00.000Z",
        deadline_at: "2026-08-14T08:45:00.000Z",
        finished_at: "2026-08-14T20:00:00.000Z",
        status: "expired",
      });
    });

    it("counts their SPEND — expiry is bookkeeping, not a refund", () => {
      const w = computeMetrics(store, { now }).windows.d7;
      // 1.5 + 2 + 0.5 from the seed, plus the expired round's 4.
      expect(w.header.spend_usd).toBeCloseTo(8, 6);
      expect(store.totalSpend()).toBeCloseTo(8, 6);
    });

    it("keeps them OUT of duration and overrun — that finished_at is a sweep's clock", () => {
      const before = computeMetrics(store, { now }).windows.d7;
      store.db.prepare("DELETE FROM rounds WHERE pr = 400").run();
      const after = computeMetrics(store, { now }).windows.d7;
      expect(before.duration.n).toBe(after.duration.n);
      expect(before.header.overruns).toBe(after.header.overruns);
    });

    it("keeps them OUT of the review leg of time-to-first-verdict too", () => {
      // One real 10-minute round beside two expired ones whose finished_at is
      // the sweep's clock: the review leg must read only the real one.
      store.db.prepare("DELETE FROM rounds WHERE pr <> 400").run();
      insertRound(store, {
        pr: 400,
        round_no: 2,
        spend_usd: 1,
        started_at: "2026-08-14T09:00:00.000Z",
        deadline_at: "2026-08-14T09:45:00.000Z",
        finished_at: "2026-08-14T20:00:00.000Z",
        status: "expired",
      });
      insertRound(store, {
        pr: 401,
        round_no: 1,
        started_at: "2026-08-14T10:00:00.000Z",
        finished_at: "2026-08-14T10:10:00.000Z",
      });
      expect(computeMetrics(store, { now }).windows.d7.ttfv.review_median_s).toBe(600);
    });
  });

  it("attributes spend at full precision, rounding only the reported bucket", () => {
    // Fractional-cent costs are what production stores (pi's usage.cost.total).
    // Rounding every accumulation step drifts the buckets away from the header.
    store.db.prepare("DELETE FROM rounds").run();
    for (const round_no of [1, 2])
      insertRound(store, {
        pr: 500,
        round_no,
        lenses: "pass-baseline",
        spend_usd: 0.077,
        started_at: "2026-08-14T08:00:00.000Z",
        finished_at: "2026-08-14T08:10:00.000Z",
      });
    const w = computeMetrics(store, { now }).windows.d7;
    expect(w.header.spend_usd).toBe(0.15);
    expect(w.spend.by_round_type).toEqual({ first: 0.15 });
    expect(w.spend.by_lens).toEqual({ "pass-baseline": 0.15 });
  });

  it("renderMetrics surfaces the daemon line and the window's event traffic", () => {
    const payload = computeMetrics(store, { now });
    payload.ops = {
      heartbeat: "2026-08-14T11:59:30Z",
      dry_run: false,
      running_rounds: 1,
      max_concurrent_rounds: 3,
      build: { sha: "abc1234", at: "2026-08-13T12:00:00Z", mode: "sync" },
    };
    const text = renderMetrics(payload);
    expect(text).toContain("daemon: LIVE");
    expect(text).toContain("rounds 1/3");
    expect(text).toContain("build abc1234 (2026-08-13T12:00:00Z, sync)");
    expect(text).toContain("events (7d): pr_transition 7");
  });
});

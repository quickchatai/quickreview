import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore, buildStatusSnapshot, writeStatusJson, type StatusSnapshot } from "../src/state.js";

const T0 = new Date("2026-08-13T09:00:00.000Z");
let clock = T0;
const now = () => clock;

let store: StateStore;

beforeEach(() => {
  clock = T0;
  store = new StateStore(":memory:", now);
});
afterEach(() => {
  store.close();
});

const prRow = (number: number, over: Partial<Parameters<StateStore["upsertPr"]>[0]> = {}) => ({
  number,
  state: "tracked" as const,
  head_sha: "abc1234567",
  title: `PR ${number}`,
  author: "alice",
  trigger_ts: null,
  stale_recheck: 0,
  migration_gate: 0,
  ...over,
});

describe("pr_state", () => {
  it("inserts, updates in place, and stamps updated_at", () => {
    store.upsertPr(prRow(10));
    expect(store.getPr(10)).toMatchObject({ number: 10, state: "tracked", title: "PR 10", updated_at: T0.toISOString() });

    clock = new Date(T0.getTime() + 60_000);
    store.upsertPr(prRow(10, { state: "queued", head_sha: "def", title: "renamed" }));

    const row = store.getPr(10)!;
    expect(row).toMatchObject({ state: "queued", head_sha: "def", title: "renamed" });
    expect(row.updated_at).toBe(clock.toISOString());
    expect(store.allPrs()).toHaveLength(1);
  });

  it("orders allPrs by number and returns undefined for unknown PRs", () => {
    store.upsertPr(prRow(30));
    store.upsertPr(prRow(4));
    expect(store.allPrs().map((p) => p.number)).toEqual([4, 30]);
    expect(store.getPr(999)).toBeUndefined();
  });

  it("setPrState transitions an existing row", () => {
    store.upsertPr(prRow(10));
    store.setPrState(10, "awaiting_human");
    expect(store.getPr(10)!.state).toBe("awaiting_human");
  });
});

describe("rounds", () => {
  it("numbers rounds per PR and computes the deadline from the cap", () => {
    const a = store.startRound(7, "initial", ["pass-baseline", "pass-ui"], 45);
    const b = store.startRound(7, "reply", ["pass-baseline"], 45);
    const other = store.startRound(8, "initial", [], 45);

    const rows = store.runningRounds();
    expect(rows).toHaveLength(3);
    const r1 = rows.find((r) => r.id === a)!;
    expect(r1).toMatchObject({ pr: 7, round_no: 1, round_type: "initial", lenses: "pass-baseline,pass-ui", status: "running" });
    expect(rows.find((r) => r.id === b)!.round_no).toBe(2);
    expect(rows.find((r) => r.id === other)!.round_no).toBe(1);
    expect(Date.parse(r1.deadline_at) - Date.parse(r1.started_at)).toBe(45 * 60_000);
  });

  // which tier held the veto, so a later audit can attribute kills.
  it("records the validator's tier at start, and lets a late stamp fill it in", () => {
    const id = store.startRound(7, "initial", ["pass-baseline"], 45, { validate_tier: "sol-high" });
    expect(store.roundsFor(7)[0]!.validate_tier).toBe("sol-high");

    const bare = store.startRound(8, "initial", [], 45);
    expect(store.roundsFor(8)[0]!.validate_tier).toBeNull();
    store.setRoundMeta(bare, { validate_tier: "sol-med" });
    expect(store.roundsFor(8)[0]!.validate_tier).toBe("sol-med");
    expect(id).not.toBe(bare);
  });

  it("finishRound records verdict, spend and wall-clock duration", () => {
    const id = store.startRound(7, "initial", [], 45);
    clock = new Date(T0.getTime() + 12 * 60_000 + 30_000);
    store.finishRound(id, "REQUEST_CHANGES", 1.25, "Short round summary for the TUI.");

    const row = store.db.prepare("SELECT * FROM rounds WHERE id = ?").get(id) as any;
    expect(row).toMatchObject({ verdict: "REQUEST_CHANGES", est_usd: 1.25, status: "done", summary: "Short round summary for the TUI." });
    expect(row.duration_s).toBe(750);
    expect(row.finished_at).toBe(clock.toISOString());
    expect(store.runningRounds()).toHaveLength(0);
  });

  it("marks overdue rounds and sums spend", () => {
    const a = store.startRound(7, "initial", [], 45);
    const b = store.startRound(8, "initial", [], 45);
    store.finishRound(a, "APPROVE", 0.5);
    store.finishRound(b, "APPROVE", 0.25);
    expect(store.totalSpend()).toBeCloseTo(0.75, 6);

    const c = store.startRound(9, "initial", [], 45);
    store.markRoundOverdue(c);
    expect(store.runningRounds()).toHaveLength(0);
    expect(store.totalSpend()).toBeCloseTo(0.75, 6); // an overdue round adds no spend
  });

  it("recordRoundUsage stores measured tokens and estimate (nullable, overwritable)", () => {
    const id = store.startRound(7, "initial", [], 45);
    expect(store.roundsFor(7)[0]).toMatchObject({ tokens_in: null, tokens_out: null, est_usd: null });

    store.recordRoundUsage(id, { tokens_in: 120_000, tokens_out: 8_000, est_usd: null });
    expect(store.roundsFor(7)[0]).toMatchObject({ tokens_in: 120_000, tokens_out: 8_000, est_usd: null });

    store.recordRoundUsage(id, { tokens_in: 130_000, tokens_out: 9_000, tokens_cache_read: 400_000, est_usd: 0.42 });
    expect(store.roundsFor(7)[0]).toMatchObject({ tokens_in: 130_000, tokens_out: 9_000, tokens_cache_read: 400_000, est_usd: 0.42 });
  });

  it("totalSpend sums est_usd — the ONE spend field; measurement supersedes the finish figure", () => {
    const a = store.startRound(7, "initial", [], 45);
    const b = store.startRound(8, "initial", [], 45);
    store.finishRound(a, "APPROVE", 1.25); // finish-time estimate only
    store.finishRound(b, "APPROVE", 1.25); // estimate superseded by measurement
    store.recordRoundUsage(b, { tokens_in: 1000, tokens_out: 100, est_usd: 0.1 });
    expect(store.totalSpend()).toBeCloseTo(1.25 + 0.1, 6);
  });

  // executed-pass telemetry, stored beside (never instead of) the plan.
  it("records executed passes per round, distinct from planned lenses; null/unparseable read as unknown", () => {
    const id = store.startRound(7, "initial", ["pass-baseline", "pass-validate"], 45);
    expect(store.executedPasses(id)).toBeNull(); // unknown until the verdict reports

    store.recordExecutedPasses(id, [{ name: "pass-baseline", tier: "sol-med", findings: 2 }]);
    expect(store.executedPasses(id)).toEqual([{ name: "pass-baseline", tier: "sol-med", findings: 2 }]);
    expect(store.roundsFor(7)[0]!.lenses).toBe("pass-baseline,pass-validate"); // the plan is untouched

    store.recordExecutedPasses(id, []); // a solo round: [] ≠ unknown
    expect(store.executedPasses(id)).toEqual([]);

    store.db.prepare("UPDATE rounds SET executed_passes = ? WHERE id = ?").run("{not json", id);
    expect(store.executedPasses(id)).toBeNull(); // unparseable degrades to unknown
  });

  it("migrates a pre-telemetry store in place (executed_passes ALTER is additive and idempotent)", () => {
    const dir = mkdtempSync(join(tmpdir(), "qcr-state-"));
    try {
      const path = join(dir, "state.db");
      const first = new StateStore(path, now);
      const id = first.startRound(7, "initial", ["pass-baseline"], 45);
      first.close();
      const second = new StateStore(path, now); // boots on an existing DB, re-running ALTERs
      expect(second.executedPasses(id)).toBeNull();
      second.recordExecutedPasses(id, [{ name: "pass-baseline" }]);
      expect(second.executedPasses(id)).toEqual([{ name: "pass-baseline" }]);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("migrates a pre-usage store in place (idempotent ALTERs)", () => {
    const dir = mkdtempSync(join(tmpdir(), "qcr-state-"));
    try {
      const path = join(dir, "state.db");
      const first = new StateStore(path, now);
      const id = first.startRound(7, "initial", [], 45);
      first.close();
      const second = new StateStore(path, now); // re-running the ALTERs is a no-op
      second.recordRoundUsage(id, { tokens_in: 5, tokens_out: 6, est_usd: 0.01 });
      expect(second.roundsFor(7)[0]).toMatchObject({ tokens_in: 5, tokens_out: 6, est_usd: 0.01 });
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("roundsOn filters by ISO date prefix", () => {
    store.startRound(7, "initial", [], 45);
    clock = new Date("2026-08-14T09:00:00.000Z");
    store.startRound(8, "initial", [], 45);
    expect(store.roundsOn("2026-08-13").map((r) => r.pr)).toEqual([7]);
    expect(store.roundsOn("2026-08-14").map((r) => r.pr)).toEqual([8]);
    expect(store.roundsOn("2026-08-15")).toEqual([]);
  });
});

describe("zombie-round expiry + spend fold", () => {
  /** Seed an overdue round with explicit timestamps via raw SQL. */
  function seedOverdue(s: StateStore, pr: number, roundNo: number, startedAt: string, over: Record<string, unknown> = {}): number {
    const info = s.db
      .prepare(
        `INSERT INTO rounds (pr, round_no, round_type, lenses, started_at, deadline_at, status)
         VALUES (@pr, @round_no, 'first', '', @started_at, @deadline_at, 'overdue')`,
      )
      .run({ pr, round_no: roundNo, started_at: startedAt, deadline_at: startedAt, ...over });
    return Number(info.lastInsertRowid);
  }

  it("boot one-shot expires pre-2026-08-15 overdue rounds whose PR verdicted or closed since", () => {
    const dir = mkdtempSync(join(tmpdir(), "qcr-state-"));
    try {
      const path = join(dir, "state.db");
      const first = new StateStore(path, now);
      // Shakeout zombie: PR 5300 verdicted on a later round.
      seedOverdue(first, 5300, 1, "2026-08-13T20:00:00.000Z");
      const done = first.startRound(5300, "re-review", [], 45);
      first.finishRound(done, "APPROVE", null);
      // Shakeout zombie on a PR the daemon knows as closed.
      first.upsertPr(prRow(5301, { state: "closed" }));
      seedOverdue(first, 5301, 1, "2026-08-14T05:00:00.000Z");
      // NOT ours to bury: overdue, but the PR is open and nothing decided
      // since — a rerun could still service it.
      first.upsertPr(prRow(5302));
      seedOverdue(first, 5302, 1, "2026-08-13T22:00:00.000Z");
      // NOT ours either: overdue but after the shakeout cutoff.
      seedOverdue(first, 5303, 1, "2026-08-16T10:00:00.000Z");
      const dn = first.startRound(5303, "re-review", [], 45);
      first.finishRound(dn, "APPROVE", null);
      first.close();

      const second = new StateStore(path, now); // the migration runs at boot
      const status = (pr: number) => second.roundsFor(pr).map((r) => r.status);
      expect(status(5300)).toEqual(["expired", "done"]);
      expect(status(5301)).toEqual(["expired"]);
      expect(status(5302)).toEqual(["overdue"]);
      expect(status(5303)).toEqual(["overdue", "done"]);
      const events = second.eventsOn("2026-08-13").filter((e) => e.kind === "rounds_expired");
      expect(events).toHaveLength(1);
      expect(JSON.parse(events[0]!.payload!)).toMatchObject({ count: 2, one_shot: true });

      // Idempotent: a third boot expires nothing further.
      second.close();
      const third = new StateStore(path, now);
      expect(third.eventsOn("2026-08-13").filter((e) => e.kind === "rounds_expired")).toHaveLength(1);
      third.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recurring expiry honours the horizon and the verdicted/closed guard", () => {
    // Overdue since T0; PR verdicted on a later round.
    seedOverdue(store, 20, 1, T0.toISOString());
    const done = store.startRound(20, "re-review", [], 45);
    store.finishRound(done, "APPROVE", null);
    // Overdue since T0 but open + undecided: never expired by this sweep.
    store.upsertPr(prRow(21));
    seedOverdue(store, 21, 1, T0.toISOString());

    clock = new Date(T0.getTime() + 12 * 3_600_000);
    expect(store.expireOverdueRounds(24)).toEqual([]); // inside the horizon

    clock = new Date(T0.getTime() + 25 * 3_600_000);
    const expired = store.expireOverdueRounds(24);
    expect(expired).toHaveLength(1);
    expect(store.roundsFor(20).map((r) => r.status)).toEqual(["expired", "done"]);
    expect(store.roundsFor(21).map((r) => r.status)).toEqual(["overdue"]);
    expect(store.expireOverdueRounds(24)).toEqual([]); // idempotent
  });

  // reverses half of the rule: an expired round is still
  // dropped from the round COUNTS (an abandoned row is not a review), but its
  // spend is real money and is counted. Excluding it did not remove noise —
  // it erased cost the reviewer actually incurred (finding 1).
  it("expired rounds keep their spend but not their place in the counts", () => {
    store.upsertPr(prRow(30, { state: "closed" }));
    const zombie = seedOverdue(store, 30, 1, T0.toISOString());
    store.db.prepare("UPDATE rounds SET est_usd = 9.99 WHERE id = ?").run(zombie);
    const live = store.startRound(30, "re-review", [], 45);
    store.finishRound(live, "APPROVE", 0.5);
    clock = new Date(T0.getTime() + 25 * 3_600_000);
    store.expireOverdueRounds(24);

    expect(store.totalSpend()).toBeCloseTo(10.49, 6);
    const snap = buildStatusSnapshot(store, true, undefined, now);
    expect(snap.prs.find((p) => p.number === 30)?.rounds).toBe(1);

    // today_spend_usd follows the same rule: rewind to the rounds'
    // calendar day and the expired round's 9.99 is in the day's spend too.
    clock = new Date("2026-08-13T23:00:00.000Z");
    const sameDay = buildStatusSnapshot(store, true, undefined, now);
    expect(sameDay.today_spend_usd).toBeCloseTo(10.49, 6);
  });

  it("boot folds legacy spend_usd into est_usd — the ONE spend field", () => {
    const dir = mkdtempSync(join(tmpdir(), "qcr-state-"));
    try {
      const path = join(dir, "state.db");
      const first = new StateStore(path, now);
      // A pre-measurement row as the old daemon wrote it: spend_usd only.
      first.db
        .prepare(
          `INSERT INTO rounds (pr, round_no, round_type, lenses, verdict, spend_usd, started_at, deadline_at, finished_at, status)
           VALUES (7, 1, 'first', '', 'APPROVE', 1.75, '2026-08-13T10:00:00.000Z', '2026-08-13T11:00:00.000Z', '2026-08-13T10:30:00.000Z', 'done')`,
        )
        .run();
      // A measured row: est_usd wins, the stale self-report is NOT folded over it.
      first.db
        .prepare(
          `INSERT INTO rounds (pr, round_no, round_type, lenses, verdict, spend_usd, est_usd, started_at, deadline_at, finished_at, status)
           VALUES (8, 1, 'first', '', 'APPROVE', 5.0, 0.25, '2026-08-13T10:00:00.000Z', '2026-08-13T11:00:00.000Z', '2026-08-13T10:30:00.000Z', 'done')`,
        )
        .run();
      first.close();
      const second = new StateStore(path, now);
      expect(second.roundsFor(7)[0]!.est_usd).toBeCloseTo(1.75, 6);
      expect(second.roundsFor(8)[0]!.est_usd).toBeCloseTo(0.25, 6);
      expect(second.totalSpend()).toBeCloseTo(2.0, 6);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("anomaly records", () => {
  it("logAnomaly writes a queryable 'anomaly' event; anomalies() reads it back", () => {
    store.logAnomaly("malformed", 100, 2, "malformed verdict file pr-100-round-2.json: bad verdict");
    store.logAnomaly("migration_precheck_degraded", 101, 1, "no base facts");
    store.logAnomaly("slack_connections", null, null, "2 connections outside a deploy window");

    const rows = store.anomalies();
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ kind: "malformed", pr: 100, round_no: 2 });
    expect(rows[0]!.detail).toContain("pr-100-round-2.json");
    expect(rows[1]).toMatchObject({ kind: "migration_precheck_degraded", pr: 101, round_no: 1, detail: "no base facts" });
    expect(rows[2]).toMatchObject({ kind: "slack_connections", pr: null, round_no: null });
    // The rows live in the ordinary event log too — same table, kind='anomaly'.
    expect(store.eventsOn("2026-08-13").filter((e) => e.kind === "anomaly")).toHaveLength(3);
  });

  it("caps and orders: newest-last window of `limit`", () => {
    for (let i = 0; i < 5; i++) store.logAnomaly("overdue", i, 1, `round ${i}`);
    const rows = store.anomalies(2);
    expect(rows.map((r) => r.pr)).toEqual([3, 4]);
  });
});

describe("bot-comment registry", () => {
  it("registers ids idempotently and answers membership", () => {
    store.registerBotComment(9001, 7);
    store.registerBotComment(9001, 7); // duplicate insert must not throw
    expect(store.isBotComment(9001)).toBe(true);
    expect(store.isBotComment(9002)).toBe(false);
    expect((store.db.prepare("SELECT COUNT(*) c FROM bot_comments").get() as any).c).toBe(1);
  });
});

describe("webhook delivery dedupe", () => {
  it("returns true the first time and false for a repeated guid", () => {
    expect(store.recordDelivery("guid-1", "pull_request", "labeled")).toBe(true);
    expect(store.recordDelivery("guid-1", "pull_request", "labeled")).toBe(false);
    expect(store.recordDelivery("guid-2", "issue_comment", null)).toBe(true);
  });
});

describe("event log", () => {
  it("appends events in order and filters by day", () => {
    store.logEvent("trigger_seen", 7, { label: "AI review requested" });
    store.logEvent("round_started", 7);
    clock = new Date("2026-08-14T09:00:00.000Z");
    store.logEvent("round_finished", 7, { verdict: "APPROVE" });

    const day1 = store.eventsOn("2026-08-13");
    expect(day1.map((e) => e.kind)).toEqual(["trigger_seen", "round_started"]);
    expect(JSON.parse(day1[0]!.payload!)).toEqual({ label: "AI review requested" });
    expect(day1[1]!.payload).toBeNull();
    expect(store.eventsOn("2026-08-14").map((e) => e.kind)).toEqual(["round_finished"]);
  });
});

describe("filed items (cap accounting)", () => {
  it("counts per kind since a cutoff", () => {
    clock = new Date("2026-08-12T09:00:00.000Z");
    store.recordFiledItem("issue", "old issue", "#1");
    clock = new Date("2026-08-13T09:00:00.000Z");
    store.recordFiledItem("issue", "today issue", "#2");
    store.recordFiledItem("improvement_pr", "prompt tweak", "#3");

    expect(store.filedSince("issue", "2026-08-13T00:00:00.000Z")).toBe(1);
    expect(store.filedSince("issue", "2026-08-01T00:00:00.000Z")).toBe(2);
    expect(store.filedSince("improvement_pr", "2026-08-13T00:00:00.000Z")).toBe(1);
    expect(store.filedSince("improvement_pr", "2026-08-14T00:00:00.000Z")).toBe(0);
  });
});

describe("status.json", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qcr-state-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("builds a snapshot from the store", () => {
    store.upsertPr(prRow(7, { state: "reviewing", stale_recheck: 1 }));
    const id = store.startRound(7, "initial", [], 45);
    store.finishRound(id, "APPROVE", 2);
    store.startRound(8, "initial", [], 45);

    const snap = buildStatusSnapshot(store, true, "3 approved, 1 escalated", now);
    expect(snap).toMatchObject({
      dry_run: true,
      running_rounds: 1,
      total_spend_usd: 2,
      digest_headline: "3 approved, 1 escalated",
      written_at: T0.toISOString(),
      heartbeat: T0.toISOString(),
    });
    expect(snap.prs).toEqual([
      {
        number: 7,
        state: "reviewing",
        title: "PR 7",
        head_sha: "abc1234567",
        stale_recheck: 1,
        trigger_ts: null,
        updated_at: expect.any(String),
        author: "alice",
        paused: 0,
        rounds: 1,
        last_verdict: "APPROVE",
      },
    ]);

    const noHeadline = buildStatusSnapshot(store, false, undefined, now);
    expect("digest_headline" in noHeadline).toBe(false);
    expect(noHeadline.dry_run).toBe(false);
  });

  it("writes atomically — temp file gone, target parses, dir created", () => {
    const target = join(dir, "nested");
    const snap = buildStatusSnapshot(store, true, undefined, now);
    writeStatusJson(target, snap);

    const files = readdirSync(target);
    expect(files).toEqual(["status.json"]);
    expect(existsSync(join(target, "status.json.tmp"))).toBe(false);
    expect(JSON.parse(readFileSync(join(target, "status.json"), "utf8"))).toEqual(snap);
  });

  it("replaces a previous snapshot in place", () => {
    writeStatusJson(dir, buildStatusSnapshot(store, true, "first", now));
    store.upsertPr(prRow(11));
    writeStatusJson(dir, buildStatusSnapshot(store, true, "second", now));

    const read = JSON.parse(readFileSync(join(dir, "status.json"), "utf8")) as StatusSnapshot;
    expect(read.digest_headline).toBe("second");
    expect(read.prs.map((p) => p.number)).toEqual([11]);
    expect(readdirSync(dir)).toEqual(["status.json"]);
  });
});

// ---------------------------------------------------------------------------
// cancellation is visible, GROUPED BY CAUSE.
//
// measured 55 cancelled rounds since the 2026-08-14 cutover that
// nothing anywhere read back, against 5 `overdue` rounds that each raised an
// alarm: the loud signal was the rare one. The fix is not "alarm on
// cancellation" — 70% of that volume is the boot orphan sweep, which a clean
// redeploy causes by construction — it is to record WHY, and to separate the
// benign from the real.
// ---------------------------------------------------------------------------

describe("cancellation causes", () => {
  const startCancelled = (pr: number, cause: Parameters<StateStore["markRoundCancelled"]>[2], reason = "because"): number => {
    const id = store.startRound(pr, "re-review", [], 45);
    store.markRoundCancelled(id, reason, cause);
    return id;
  };

  it("records the cause beside the prose, and only for cancelled rounds", () => {
    startCancelled(1, "orphan_sweep", "orphaned — tmux session lost across a restart");
    const done = store.startRound(2, "first", [], 45);
    store.finishRound(done, "APPROVE", null);

    const cancelled = store.roundsFor(1)[0]!;
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancel_cause).toBe("orphan_sweep");
    expect(cancelled.summary).toBe("orphaned — tmux session lost across a restart");
    expect(store.roundsFor(2)[0]!.cancel_cause).toBeNull();
  });

  it("a caller that declares nothing lands in `unknown` — never silently benign", () => {
    const id = store.startRound(3, "first", [], 45);
    store.markRoundCancelled(id, "some new path nobody classified");
    expect(store.roundsFor(3)[0]!.cancel_cause).toBe("unknown");
    expect(store.cancellationsByCause()).toEqual([{ cause: "unknown", count: 1, loud: false }]);
  });

  it("groups by cause, loud first — the query the diagnosis had to grep prose for", () => {
    startCancelled(10, "orphan_sweep");
    startCancelled(11, "orphan_sweep");
    startCancelled(12, "orphan_sweep");
    startCancelled(13, "deadline_overrun");
    startCancelled(14, "superseded");

    expect(store.cancellationsByCause()).toEqual([
      // The ONE loud cause sorts first even though it is the rarest — that
      // ordering is the inversion found, undone.
      { cause: "deadline_overrun", count: 1, loud: true },
      { cause: "orphan_sweep", count: 3, loud: false },
      { cause: "superseded", count: 1, loud: false },
    ]);
    expect(store.loudCancellations().map((r) => r.pr)).toEqual([13]);
  });

  it("the redeploy orphan sweep is NEVER loud, however much of the volume it is", () => {
    for (let i = 0; i < 40; i++) startCancelled(100 + i, "orphan_sweep");
    expect(store.cancellationsByCause()).toEqual([{ cause: "orphan_sweep", count: 40, loud: false }]);
    expect(store.loudCancellations()).toEqual([]);
  });

  it("honours the `since` bound", () => {
    startCancelled(20, "deadline_overrun");
    clock = new Date(T0.getTime() + 86_400_000);
    startCancelled(21, "deadline_overrun");

    expect(store.cancellationsByCause(clock.toISOString())).toEqual([{ cause: "deadline_overrun", count: 1, loud: true }]);
    expect(store.loudCancellations(clock.toISOString()).map((r) => r.pr)).toEqual([21]);
  });

  it("classifies the historical prose exactly once, at boot", () => {
    const dir = mkdtempSync(join(tmpdir(), "qcr-state-"));
    try {
      const path = join(dir, "state.db");
      const first = new StateStore(path, now);
      // Legacy rows: the prose each call site used to write, and nothing
      // else. Inserted straight so the column is genuinely NULL.
      const legacy = [
        ["orphaned — tmux session lost across a restart", "orphan_sweep"],
        ["superseded — round 2 outlived by a newer round", "superseded"],
        ["cancelled by rerun-round", "operator"],
        ["self-requeue 1/2 — round 3 passed its deadline (…) with no verdict and its session is dead", "deadline_overrun"],
        ["self-requeue 1/2 — round 4's prompt … was dropped in delivery; redispatching", "lost_prompt"],
        ["self-requeue 1/2 — round 5 ended head_moved (guard 5)", "head_moved"],
        ["self-requeue 1/2 — round 6 verdicted NEEDS_HUMAN without executing any passes", "incomplete_round"],
        ["something nobody ever wrote", "unknown"],
      ] as const;
      legacy.forEach(([summary], i) => {
        first.db
          .prepare(
            `INSERT INTO rounds (pr, round_no, round_type, lenses, summary, started_at, deadline_at, status)
             VALUES (@pr, 1, 'first', '', @summary, '2026-08-16T10:00:00.000Z', '2026-08-16T11:00:00.000Z', 'cancelled')`,
          )
          .run({ pr: 900 + i, summary });
      });
      first.close();

      const second = new StateStore(path, now);
      legacy.forEach(([, cause], i) => {
        expect(second.roundsFor(900 + i)[0]!.cancel_cause).toBe(cause);
      });
      expect(second.eventsOn("2026-08-13").filter((e) => e.kind === "cancel_causes_backfilled")).toHaveLength(1);
      second.close();

      // Idempotent: a second boot finds nothing left to classify.
      const third = new StateStore(path, now);
      expect(third.eventsOn("2026-08-13").filter((e) => e.kind === "cancel_causes_backfilled")).toHaveLength(1);
      third.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("stranded rounds", () => {
  const seedStranded = (pr: number, deadlineAt: string): void => {
    store.db
      .prepare(
        `INSERT INTO rounds (pr, round_no, round_type, lenses, est_usd, started_at, deadline_at, status)
         VALUES (@pr, 2, 'first', '', 1.25, @deadline_at, @deadline_at, 'overdue')`,
      )
      .run({ pr, deadline_at: deadlineAt });
  };

  it("finds the round the zombie sweep deliberately refuses to bury", () => {
    // The live case: pr 4662 round 2, overdue since the cutover, PR still open
    // and undecided — so `expireOverdueRounds` skips it forever.
    store.upsertPr(prRow(4662));
    seedStranded(4662, "2026-08-14T12:00:00.000Z");
    clock = new Date("2026-08-24T12:00:00.000Z");

    expect(store.expireOverdueRounds(24)).toEqual([]);
    expect(store.strandedOverdueRounds().map((r) => r.pr)).toEqual([4662]);
  });

  it("does not touch a round that is merely late", () => {
    store.upsertPr(prRow(4663));
    seedStranded(4663, "2026-08-24T06:00:00.000Z");
    clock = new Date("2026-08-24T12:00:00.000Z");
    expect(store.strandedOverdueRounds()).toEqual([]);
    expect(store.expireStrandedRounds()).toEqual([]);
  });

  it("terminalizes it, logs it, and keeps its spend", () => {
    store.upsertPr(prRow(4662));
    seedStranded(4662, "2026-08-14T12:00:00.000Z");
    clock = new Date("2026-08-24T12:00:00.000Z");

    const closed = store.expireStrandedRounds();
    expect(closed.map((r) => ({ pr: r.pr, round_no: r.round_no }))).toEqual([{ pr: 4662, round_no: 2 }]);
    expect(store.roundsFor(4662)[0]).toMatchObject({ status: "expired", finished_at: clock.toISOString() });
    expect(store.eventsOn("2026-08-24").filter((e) => e.kind === "rounds_stranded")).toHaveLength(1);
    // Burying the row must not erase what it cost (finding 1).
    expect(store.totalSpend()).toBeCloseTo(1.25, 6);
    // And it reports once: it is no longer overdue.
    expect(store.expireStrandedRounds()).toEqual([]);
  });
});

describe("priorRoundCount semantics (finding 3)", () => {
  it('counts VERDICTED rounds only — "first" really means "never successfully reviewed"', () => {
    store.upsertPr(prRow(50));
    const one = store.startRound(50, "first", [], 45);
    store.markRoundCancelled(one, "orphaned — tmux session lost across a restart", "orphan_sweep");
    // A failed round must not age the PR (ratified, §2.1 / #5313) — so
    // the SECOND round is still typed "first" and the nit cap stays off.
    expect(store.priorRoundCount(50)).toBe(0);

    const two = store.startRound(50, "first", [], 45);
    expect(store.roundsFor(50).map((r) => r.round_no)).toEqual([1, 2]);
    store.finishRound(two, "APPROVE", null);
    // Only now does the PR age. `round_no` is the ordinal; priorRoundCount is not.
    expect(store.priorRoundCount(50)).toBe(1);
  });
});

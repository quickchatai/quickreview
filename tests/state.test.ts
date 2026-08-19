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

  it("expired rounds are excluded from every aggregate (spend, snapshot counts)", () => {
    store.upsertPr(prRow(30, { state: "closed" }));
    const zombie = seedOverdue(store, 30, 1, T0.toISOString());
    store.db.prepare("UPDATE rounds SET est_usd = 9.99 WHERE id = ?").run(zombie);
    const live = store.startRound(30, "re-review", [], 45);
    store.finishRound(live, "APPROVE", 0.5);
    clock = new Date(T0.getTime() + 25 * 3_600_000);
    store.expireOverdueRounds(24);

    expect(store.totalSpend()).toBeCloseTo(0.5, 6);
    const snap = buildStatusSnapshot(store, true, undefined, now);
    expect(snap.prs.find((p) => p.number === 30)?.rounds).toBe(1);
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

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
  escalation_worthy: 0,
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

  it("finishRound records verdict, spend and wall-clock duration", () => {
    const id = store.startRound(7, "initial", [], 45);
    clock = new Date(T0.getTime() + 12 * 60_000 + 30_000);
    store.finishRound(id, "REQUEST_CHANGES", 1.25);

    const row = store.db.prepare("SELECT * FROM rounds WHERE id = ?").get(id) as any;
    expect(row).toMatchObject({ verdict: "REQUEST_CHANGES", spend_usd: 1.25, status: "done" });
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

  it("roundsOn filters by ISO date prefix", () => {
    store.startRound(7, "initial", [], 45);
    clock = new Date("2026-08-14T09:00:00.000Z");
    store.startRound(8, "initial", [], 45);
    expect(store.roundsOn("2026-08-13").map((r) => r.pr)).toEqual([7]);
    expect(store.roundsOn("2026-08-14").map((r) => r.pr)).toEqual([8]);
    expect(store.roundsOn("2026-08-15")).toEqual([]);
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
        escalation_worthy: 0,
        trigger_ts: null,
        updated_at: expect.any(String),
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

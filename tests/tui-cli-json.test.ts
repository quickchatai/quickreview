// The daemon-side read-only additions rides on: `why --json`,
// `today --json`, `events --tail`, and the enriched status snapshot.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { whyJson, todayJson } from "../src/cli.js";
import { StateStore, buildStatusSnapshot } from "../src/state.js";

let store: StateStore;
let tmp: string;

beforeEach(() => {
  store = new StateStore(":memory:");
  tmp = mkdtempSync(join(tmpdir(), "qcr-tui-"));
});

afterEach(() => {
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});

const seedPr = (n: number) =>
  store.upsertPr({
    number: n,
    state: "reviewing",
    head_sha: "a2e380ff1122",
    title: "fix(crm): retry send_message",
    author: "someone",
    trigger_ts: "2026-08-13T14:02:00Z",
    stale_recheck: 0,
    migration_gate: 0,
  });

describe("whyJson", () => {
  it("reports an unknown PR honestly", () => {
    const payload = whyJson(store, 42, join(tmp, "none"));
    expect(payload.known).toBe(false);
    expect(payload.rounds).toEqual([]);
    expect(payload.spend_usd).toBe(0);
  });

  it("assembles header facts, rounds, spend and thread counts", () => {
    seedPr(5012);
    const r1 = store.startRound(5012, "initial", ["pass-baseline"], 45);
    store.finishRound(r1, "REQUEST_CHANGES", 0.8);
    store.startRound(5012, "rework", ["pass-validate"], 45);
    store.registerBotComment(1001, 5012);
    store.registerBotComment(1002, 5012);
    const payload = whyJson(store, 5012, join(tmp, "none"));
    expect(payload.known).toBe(true);
    expect(payload.state).toBe("reviewing");
    expect(payload).not.toHaveProperty("escalation_worthy"); // scrapped 2026-08-18
    expect(payload.stale_recheck).toBe(false);
    expect(payload.trigger_ts).toBe("2026-08-13T14:02:00Z");
    expect(payload.spend_usd).toBeCloseTo(0.8);
    expect(payload.rounds.map((r) => [r.round_no, r.verdict, r.status])).toEqual([
      [1, "REQUEST_CHANGES", "done"],
      [2, null, "running"],
    ]);
    expect(payload.threads).toEqual({ open: 2, total: 2 });
    expect(payload.ledger).toBeUndefined();
  });

  it("includes the archived ledger when present", () => {
    seedPr(7);
    const archive = join(tmp, "pr-7");
    mkdirSync(archive, { recursive: true });
    writeFileSync(join(archive, "ledger.md"), "F1 [P1/0.9][delivery] tasks.py:88 open\n");
    const payload = whyJson(store, 7, archive);
    expect(payload.ledger).toContain("tasks.py:88");
    expect(payload.archive).toContain("ledger.md");
  });

  it("round-trips through JSON (the TUI's transport)", () => {
    seedPr(9);
    const payload = JSON.parse(JSON.stringify(whyJson(store, 9, join(tmp, "none"))));
    expect(payload.pr).toBe(9);
    expect(payload.title).toBe("fix(crm): retry send_message");
  });
});

describe("todayJson", () => {
  it("collects today's rounds, spend and events", () => {
    seedPr(5012);
    const r = store.startRound(5012, "initial", ["pass-baseline"], 45);
    store.finishRound(r, "APPROVE", 1.25);
    store.logEvent("verdict_applied", 5012, { verdict: "APPROVE" });
    const today = new Date().toISOString().slice(0, 10);
    const payload = todayJson(store, today);
    expect(payload.date).toBe(today);
    expect(payload.rounds).toHaveLength(1);
    expect(payload.spend_usd).toBeCloseTo(1.25);
    expect(payload.events).toHaveLength(1);
  });
});

describe("recentEvents", () => {
  it("tails newest-last with the limit applied", () => {
    for (let i = 0; i < 5; i++) store.logEvent(`e${i}`, null);
    const tail = store.recentEvents(3);
    expect(tail.map((e) => e.kind)).toEqual(["e2", "e3", "e4"]);
  });
});

describe("buildStatusSnapshot enrichment", () => {
  it("carries the rounds cap, today spend and per-PR TUI fields", () => {
    seedPr(5012);
    const r = store.startRound(5012, "initial", ["pass-baseline"], 45);
    store.finishRound(r, "REQUEST_CHANGES", 2.5);
    const snap = buildStatusSnapshot(store, true, undefined, () => new Date(), 12);
    expect(snap.max_concurrent_rounds).toBe(12);
    expect(snap.today_spend_usd).toBeCloseTo(2.5);
    const pr = snap.prs[0]!;
    expect(pr).not.toHaveProperty("escalation_worthy"); // scrapped 2026-08-18
    expect(pr.trigger_ts).toBe("2026-08-13T14:02:00Z");
    expect(typeof pr.updated_at).toBe("string");
  });
});

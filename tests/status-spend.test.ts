// status.json's spend: today's (`today_spend_usd`) and, beside it, the
// month's so far (`month_spend_usd`), both over the rounds started in the
// snapshot's UTC day and month. The home's spend line (src/home/spend.ts)
// reads auto-review's recorded costs from these two; a snapshot from an
// older daemon has no month, and the home then says unknown.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateStore, buildStatusSnapshot } from "../src/state.js";

let clock = new Date("2026-10-27T09:00:00.000Z");
const now = (): Date => clock;
let store: StateStore;

beforeEach(() => {
  store = new StateStore(":memory:", now);
});
afterEach(() => {
  store.close();
});

/** A finished round of PR `pr`, started at `at`, that cost `usd`. */
function round(pr: number, at: string, usd: number): void {
  clock = new Date(at);
  const id = store.startRound(pr, "first", [], 45);
  store.finishRound(id, "COMMENT", usd);
}

describe("the snapshot's spend", () => {
  // MUTATION: compute month_spend_usd from roundsOn(today) — the month's
  // earlier days drop out and this fails.
  it("sums today's rounds, and this month's from its first day, last month's never", () => {
    round(1, "2026-09-30T23:30:00.000Z", 5); // last month
    round(2, "2026-10-01T00:10:00.000Z", 1.25); // the month's first day
    round(3, "2026-10-26T18:00:00.000Z", 0.5); // yesterday
    round(4, "2026-10-27T08:00:00.000Z", 0.75); // today
    clock = new Date("2026-10-27T12:00:00.000Z");
    const snap = buildStatusSnapshot(store, true, undefined, now);
    expect(snap.today_spend_usd).toBeCloseTo(0.75, 6);
    expect(snap.month_spend_usd).toBeCloseTo(2.5, 6);
  });

  it("a month with no rounds yet spends nothing, said as a zero the daemon measured", () => {
    round(1, "2026-10-31T10:00:00.000Z", 3);
    clock = new Date("2026-11-01T00:05:00.000Z");
    const snap = buildStatusSnapshot(store, true, undefined, now);
    expect(snap.month_spend_usd).toBe(0);
    expect(snap.today_spend_usd).toBe(0);
  });
});

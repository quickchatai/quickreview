// status.json's spend: today's (`today_spend_usd`) and, beside it, the
// month's so far (`month_spend_usd`), both over the rounds started in the
// snapshot's UTC day and month. The home's spend line (src/home/spend.ts)
// reads auto-review's recorded costs from these two; a snapshot from an
// older daemon has no month, and the home then says unknown.
//
// Beside each sum the snapshot counts the rounds it could not price
// (`*_unknown_spend_rounds`): tokens recorded and no dollars, which is what a
// round on a model pi has no price for leaves. Fence 7: such a round is never
// a zero in the sum, on the snapshot or on a surface that reads it, and a
// snapshot with no count (an older daemon's) is read as unknown, not as none.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spendText } from "@quickchatai/pi-quickreview/src/pricing.js";
import { renderStatus } from "../src/cli.js";
import { snapshotSpend } from "../src/home/spend.js";
import { StateStore, buildStatusSnapshot, type StatusSnapshot } from "../src/state.js";

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

/** A measured round of PR `pr`, started at `at`, with tokens and no price. */
function unpricedRound(pr: number, at: string): void {
  clock = new Date(at);
  const id = store.startRound(pr, "first", [], 45);
  store.recordRoundUsage(id, { tokens_in: 4000, tokens_out: 400, est_usd: null });
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

  // MUTATION: restore `r.est_usd ?? 0` without the count in roundUsage - the
  // counts are absent (or 0) and this fails.
  it("counts the rounds with tokens and no price beside each sum, by day, month and all time", () => {
    unpricedRound(1, "2026-09-30T23:30:00.000Z"); // last month
    unpricedRound(2, "2026-10-01T00:10:00.000Z"); // the month's first day
    round(3, "2026-10-26T18:00:00.000Z", 0.5); // yesterday, priced
    unpricedRound(4, "2026-10-27T08:00:00.000Z"); // today
    round(5, "2026-10-27T08:30:00.000Z", 0.75); // today, priced
    clock = new Date("2026-10-27T12:00:00.000Z");
    const snap = buildStatusSnapshot(store, true, undefined, now);
    expect(snap.today_spend_usd).toBeCloseTo(0.75, 6);
    expect(snap.today_unknown_spend_rounds).toBe(1);
    expect(snap.month_spend_usd).toBeCloseTo(1.25, 6);
    expect(snap.month_unknown_spend_rounds).toBe(2);
    expect(snap.total_spend_usd).toBeCloseTo(1.25, 6);
    expect(snap.total_unknown_spend_rounds).toBe(3);
    // The word on the surface is "unknown", beside the sum.
    expect(renderStatus(snap)).toContain("total spend: $1.25 + 3 rounds unknown");
  });

  it("a day whose every round is unpriced reads unknown, never $0.00", () => {
    unpricedRound(1, "2026-10-27T08:00:00.000Z");
    clock = new Date("2026-10-27T12:00:00.000Z");
    const snap = buildStatusSnapshot(store, true, undefined, now);
    expect(snap.today_spend_usd).toBe(0);
    expect(snap.today_unknown_spend_rounds).toBe(1);
    expect(spendText(snap.today_spend_usd!, snap.today_unknown_spend_rounds)).toBe(
      "unknown (1 round)",
    );
    expect(renderStatus(snap)).toContain("total spend: unknown (1 round)");
    expect(renderStatus(snap)).not.toContain("total spend: $");
  });

  it("a snapshot with every round priced counts none, a zero the daemon measured", () => {
    round(1, "2026-10-27T08:00:00.000Z", 3);
    clock = new Date("2026-10-27T12:00:00.000Z");
    const snap = buildStatusSnapshot(store, true, undefined, now);
    expect(snap.total_unknown_spend_rounds).toBe(0);
    expect(snap.today_unknown_spend_rounds).toBe(0);
    expect(snap.month_unknown_spend_rounds).toBe(0);
    expect(renderStatus(snap)).toMatch(/total spend: \$3\.00(\n|$)/);
  });

  // Invariant 9, second half: the count's absence is not a zero.
  // MUTATION: read a missing month_unknown_spend_rounds as 0 in snapshotSpend -
  // the home's count is 0 here, not null, and this fails.
  it("a snapshot from an older daemon, with no counts, is read as an unknown count: the sum is said as it is", () => {
    round(1, "2026-10-27T08:00:00.000Z", 3);
    clock = new Date("2026-10-27T12:00:00.000Z");
    const full = buildStatusSnapshot(store, true, undefined, now);
    const older: StatusSnapshot = { ...full };
    delete older.total_unknown_spend_rounds;
    delete older.today_unknown_spend_rounds;
    delete older.month_unknown_spend_rounds;
    expect(renderStatus(older)).toContain("total spend: $3.00");
    const read = snapshotSpend(JSON.stringify(older), clock.getTime());
    expect(read).toEqual({
      kind: "known",
      value: { today: 3, month: 3, todayUnknown: null, monthUnknown: null },
    });
    // The same snapshot with its counts is a measured none.
    expect(snapshotSpend(JSON.stringify(full), clock.getTime())).toEqual({
      kind: "known",
      value: { today: 3, month: 3, todayUnknown: 0, monthUnknown: 0 },
    });
  });
});

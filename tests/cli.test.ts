import { describe, expect, it } from "vitest";
import { cancellationsOn, renderStatus, todayCancellationLine, todayJson, whyJson } from "../src/cli.js";
import { StateStore, type StatusSnapshot } from "../src/state.js";

const snapshot: StatusSnapshot = {
  written_at: "2026-08-13T17:04:00.000Z",
  dry_run: true,
  prs: [
    { number: 1421, state: "reviewing", title: "Add rate limiting to the widget API", head_sha: "0f1e2d3c4b5a6978", stale_recheck: 0 },
    { number: 88, state: "awaiting_author", title: "Bump ansible role", head_sha: "aaaabbbbccccdddd", stale_recheck: 1 },
  ],
  running_rounds: 2,
  total_spend_usd: 3.5,
  digest_headline: "2 approved · 1 escalated",
  heartbeat: "2026-08-13T17:04:00.000Z",
};

describe("renderStatus", () => {
  it("renders the dry-run banner, digest, totals and one row per PR", () => {
    const out = renderStatus(snapshot);
    const lines = out.split("\n");

    expect(lines[0]).toBe("quickreview — DRY-RUN — snapshot 2026-08-13T17:04:00.000Z");
    expect(lines[1]).toBe("digest: 2 approved · 1 escalated");
    expect(lines[2]).toBe("rounds running: 2   total spend: $3.50");
    expect(lines[4]).toMatch(/^PR\s+state\s+stale\s+head\s+title$/);

    const rows = lines.slice(5);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("#1421");
    expect(rows[0]).toContain("reviewing");
    expect(rows[0]).toContain("0f1e2d3c4b"); // head truncated to 10 chars
    expect(rows[0]).not.toContain("0f1e2d3c4b5");
    expect(rows[0]).toContain("Add rate limiting to the widget API");
    expect(rows[0]).toMatch(/\s-\s/); // stale column shows "-" when not stale
    expect(rows[1]).toContain("#88");
    expect(rows[1]).toContain("yes"); // stale_recheck = 1
  });

  it("says LIVE when dry-run is off and omits the digest line when absent", () => {
    const out = renderStatus({ ...snapshot, dry_run: false, digest_headline: undefined });
    const lines = out.split("\n");
    expect(lines[0]).toContain("LIVE");
    expect(out).not.toContain("digest:");
    expect(lines[1]).toBe("rounds running: 2   total spend: $3.50");
  });

  it("handles an empty fleet of PRs", () => {
    const out = renderStatus({ ...snapshot, prs: [], running_rounds: 0, total_spend_usd: 0, digest_headline: undefined });
    expect(out).toContain("no tracked PRs");
    expect(out).toContain("total spend: $0.00");
    expect(out).not.toContain("PR     state");
  });

  it("truncates long titles to 60 characters", () => {
    const long = "x".repeat(120);
    const out = renderStatus({ ...snapshot, prs: [{ ...snapshot.prs[0]!, title: long }] });
    expect(out).toContain("x".repeat(60));
    expect(out).not.toContain("x".repeat(61));
  });
});

describe("usage-aware spend reporting", () => {
  function seededStore(): StateStore {
    const store = new StateStore(":memory:");
    const a = store.startRound(7, "initial", [], 45);
    const b = store.startRound(7, "re_review", [], 45);
    store.finishRound(a, "REQUEST_CHANGES", 1.25); // legacy: self-reported only
    store.finishRound(b, "APPROVE", 1.25); // measured figures supersede the fiction
    store.recordRoundUsage(b, { tokens_in: 120_000, tokens_out: 8_000, est_usd: 0.31 });
    return store;
  }

  it("whyJson sums est_usd — the ONE spend field — and exposes tokens per round", () => {
    const store = seededStore();
    try {
      const payload = whyJson(store, 7, "/nonexistent-archive");
      expect(payload.spend_usd).toBeCloseTo(1.25 + 0.31, 6);
      // finishRound's figure lands in est_usd; the retired spend_usd column stays null.
      expect(payload.rounds[0]).toMatchObject({ est_usd: 1.25, tokens_in: null, tokens_out: null, spend_usd: null });
      expect(payload.rounds[1]).toMatchObject({ est_usd: 0.31, tokens_in: 120_000, tokens_out: 8_000 });
    } finally {
      store.close();
    }
  });

  it("whyJson exposes the running round plan, timing and executed-pass telemetry", () => {
    const store = new StateStore(":memory:");
    try {
      const id = store.startRound(5408, "re-review", ["pass-baseline", "pass-validate"], 75, { validate_tier: "sol-high" });
      store.db.prepare("UPDATE rounds SET executed_passes = ? WHERE id = ?").run(
        JSON.stringify([{ name: "pass-baseline", status: "completed" }]),
        id,
      );
      const round = whyJson(store, 5408, "/nonexistent-archive").rounds[0]!;
      expect(round.deadline_at).toMatch(/Z$/);
      expect(round.validate_tier).toBe("sol-high");
      expect(round.executed_passes).toEqual([{ name: "pass-baseline", status: "completed" }]);
    } finally {
      store.close();
    }
  });

  it("todayJson sums est-preferred spend and tokens", () => {
    const store = seededStore();
    try {
      const today = new Date().toISOString().slice(0, 10);
      const payload = todayJson(store, today);
      expect(payload.spend_usd).toBeCloseTo(1.56, 6);
      expect(payload.tokens_in).toBe(120_000);
      expect(payload.tokens_out).toBe(8_000);
    } finally {
      store.close();
    }
  });

  it("counts an expired round's spend (finding 1)", () => {
    const store = seededStore();
    try {
      const zombie = store.startRound(9, "first", [], 45);
      store.db.prepare("UPDATE rounds SET status = 'expired', est_usd = 2.0 WHERE id = ?").run(zombie);
      const today = new Date().toISOString().slice(0, 10);
      expect(todayJson(store, today).spend_usd).toBeCloseTo(3.56, 6);
      expect(whyJson(store, 9, "/nonexistent-archive").spend_usd).toBeCloseTo(2.0, 6);
    } finally {
      store.close();
    }
  });
});

describe("cancellation reporting", () => {
  it("`qcr today` reports the split by cause, loud first, and never stays silent", () => {
    const store = new StateStore(":memory:");
    try {
      const today = new Date().toISOString().slice(0, 10);
      expect(todayCancellationLine(cancellationsOn(store, today))).toBe("cancelled: none");

      for (const pr of [1, 2]) store.markRoundCancelled(store.startRound(pr, "first", [], 45), "x", "orphan_sweep");
      store.markRoundCancelled(store.startRound(3, "re-review", [], 45), "y", "deadline_overrun");

      expect(cancellationsOn(store, today)).toEqual([
        { cause: "deadline_overrun", count: 1, loud: true },
        { cause: "orphan_sweep", count: 2, loud: false },
      ]);
      expect(todayCancellationLine(cancellationsOn(store, today))).toBe(
        "cancelled: 3 — stopped dead 1 ⚑, orphan sweep (redeploy) 2  (1 needing a look)",
      );
      expect(todayJson(store, today).cancellations).toHaveLength(2);
    } finally {
      store.close();
    }
  });

  it("whyJson carries the cause per round — null on everything not cancelled", () => {
    const store = new StateStore(":memory:");
    try {
      store.markRoundCancelled(store.startRound(5, "first", [], 45), "x", "deadline_overrun");
      const done = store.startRound(5, "re-review", [], 45);
      store.finishRound(done, "APPROVE", null);
      const payload = whyJson(store, 5, "/nonexistent-archive");
      expect(payload.rounds.map((r) => r.cancel_cause)).toEqual(["deadline_overrun", null]);
    } finally {
      store.close();
    }
  });
});

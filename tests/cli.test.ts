import { describe, expect, it } from "vitest";
import { renderStatus } from "../src/cli.js";
import type { StatusSnapshot } from "../src/state.js";

const snapshot: StatusSnapshot = {
  written_at: "2026-08-13T17:04:00.000Z",
  dry_run: true,
  prs: [
    { number: 1421, state: "reviewing", title: "Add rate limiting to the widget API", head_sha: "0f1e2d3c4b5a6978", stale_recheck: 0 },
    { number: 88, state: "awaiting_human", title: "Bump ansible role", head_sha: "aaaabbbbccccdddd", stale_recheck: 1 },
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

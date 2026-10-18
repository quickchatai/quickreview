import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  digestHeadline,
  cancellationSummaryLine,
  digestWritten,
  latestDigestFile,
  latestDigestHeadline,
  writeDigest,
} from "../src/digest.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

describe("digestHeadline", () => {
  it("skips headings and blank lines", () => {
    const content =
      "# Review sandbox — 2026-08-13\n\n## Reviews\n\nQuiet day: 2 rounds, 1 approve, no blockers.\n";
    expect(digestHeadline(content)).toBe("Quiet day: 2 rounds, 1 approve, no blockers.");
  });

  it("truncates at 200 chars", () => {
    const long = "x".repeat(260);
    expect(digestHeadline(`# h\n${long}`)).toHaveLength(200);
  });

  it("returns undefined when there is no prose", () => {
    expect(digestHeadline("# only\n## headings\n\n")).toBeUndefined();
    expect(digestHeadline("")).toBeUndefined();
  });
});

describe("writeDigest / latestDigestHeadline", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qcr-digest-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes digest/<date>.md and reads back the newest headline", () => {
    const path = writeDigest("2026-08-12", "# d\n\nolder day headline", dir);
    expect(path).toBe(join(dir, "2026-08-12.md"));
    expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);
    writeDigest("2026-08-13", "# d\n\n3 PRs reviewed, 1 escalated to the owner.", dir);
    writeDigest("2026-08-11", "# d\n\noldest", dir);
    expect(latestDigestFile(dir)).toBe(join(dir, "2026-08-13.md"));
    expect(latestDigestHeadline(dir)).toBe("3 PRs reviewed, 1 escalated to the owner.");
  });

  it("digestWritten answers for exactly the file writeDigest writes (the EOD pin-watch's early close)", () => {
    expect(digestWritten("2026-08-12", dir)).toBe(false);
    writeDigest("2026-08-12", "# d\n\nheadline", dir);
    expect(digestWritten("2026-08-12", dir)).toBe(true);
    expect(digestWritten("2026-08-13", dir)).toBe(false);
  });

  it("renders a directory read failure as unavailable", () => {
    const path = join(dir, "not-a-directory");
    writeFileSync(path, "fixture");
    expect(latestDigestHeadline(path)).toBeUndefined();
  });

  it("ignores non-digest files and an empty/missing dir", () => {
    expect(latestDigestHeadline(dir)).toBeUndefined();
    expect(latestDigestHeadline(join(dir, "nope"))).toBeUndefined();
    writeFileSync(join(dir, "README.md"), "not a digest");
    expect(latestDigestFile(dir)).toBeUndefined();
  });
});

describe("dailyUsage / usageSummaryLine", () => {
  it(
    "aggregates the day's rounds, preferring est_usd over legacy spend_usd",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const { StateStore } = await import("../src/state.js");
      const { dailyUsage, usageSummaryLine } = await import("../src/digest.js");
      const store = new StateStore(":memory:");
      try {
        const a = store.startRound(7, "initial", [], 45);
        const b = store.startRound(8, "initial", [], 45);
        store.finishRound(a, "APPROVE", 2.0); // pre-measurement row: fallback
        store.finishRound(b, "APPROVE", 2.0);
        store.recordRoundUsage(b, { tokens_in: 100_000, tokens_out: 5_000, est_usd: 0.25 });
        const today = new Date().toISOString().slice(0, 10);
        const usage = dailyUsage(store, today);
        expect(usage).toMatchObject({ rounds: 2, tokens_in: 100_000, tokens_out: 5_000 });
        expect(usage.est_usd).toBeCloseTo(2.25, 6);
        expect(usageSummaryLine(usage)).toBe(
          "usage: 2 rounds — 100000 in / 5000 out tokens — est $2.25",
        );
      } finally {
        store.close();
      }
    },
  );

  it("counts expired rounds' spend (expiry is not a refund)", async () => {
    const { StateStore } = await import("../src/state.js");
    const { dailyUsage } = await import("../src/digest.js");
    const store = new StateStore(":memory:");
    try {
      const a = store.startRound(7, "initial", [], 45);
      store.finishRound(a, "APPROVE", 1.0);
      const zombie = store.startRound(8, "initial", [], 45);
      store.db
        .prepare("UPDATE rounds SET status = 'expired', est_usd = 3.0 WHERE id = ?")
        .run(zombie);
      const usage = dailyUsage(store, new Date().toISOString().slice(0, 10));
      expect(usage.est_usd).toBeCloseTo(4.0, 6);
    } finally {
      store.close();
    }
  });
});

describe("dailyCancellations / cancellationSummaryLine", () => {
  const openStore = async () => {
    const { StateStore } = await import("../src/state.js");
    return new StateStore(":memory:");
  };

  it("a quiet day says so — the answer that used to be missing entirely", async () => {
    const { dailyCancellations, cancellationSummaryLine } = await import("../src/digest.js");
    const store = await openStore();
    try {
      const today = new Date().toISOString().slice(0, 10);
      const c = dailyCancellations(store, today);
      expect(c).toMatchObject({ total: 0, loud: 0, by_cause: [] });
      expect(cancellationSummaryLine(c)).toBe("cancelled: none");
    } finally {
      store.close();
    }
  });

  it("groups the day by cause and marks only the round that stopped dead", async () => {
    const { dailyCancellations, cancellationSummaryLine } = await import("../src/digest.js");
    const store = await openStore();
    try {
      for (const pr of [1, 2, 3])
        store.markRoundCancelled(store.startRound(pr, "first", [], 45), "x", "orphan_sweep");
      store.markRoundCancelled(store.startRound(4, "re-review", [], 45), "y", "deadline_overrun");

      const c = dailyCancellations(store, new Date().toISOString().slice(0, 10));
      expect(c.total).toBe(4);
      expect(c.loud).toBe(1);
      expect(cancellationSummaryLine(c)).toBe(
        "cancelled: 4 rounds — stopped dead 1 ⚑, orphan sweep (redeploy) 3 " +
          "(1 stopped dead — worth a look; the orphan sweep is a redeploy artefact and is not)",
      );
    } finally {
      store.close();
    }
  });

  it("a day of pure redeploy churn carries no flag at all", async () => {
    const { dailyCancellations, cancellationSummaryLine } = await import("../src/digest.js");
    const store = await openStore();
    try {
      for (let pr = 1; pr <= 12; pr++)
        store.markRoundCancelled(store.startRound(pr, "first", [], 45), "x", "orphan_sweep");
      const c = dailyCancellations(store, new Date().toISOString().slice(0, 10));
      expect(c.loud).toBe(0);
      expect(cancellationSummaryLine(c)).toBe("cancelled: 12 rounds — orphan sweep (redeploy) 12");
    } finally {
      store.close();
    }
  });

  // The summary line reaches the digest through the EOD sweep prompt (eod.ts
  // renderEodPrompt dayContext, wired in wire.ts): the digest is written by
  // the sweep session, so the prompt is the only render the daemon owns.
  it("eodDigestContext is the day's cancellation line, 'none' included", async () => {
    const { eodDigestContext } = await import("../src/digest.js");
    const store = await openStore();
    try {
      const today = new Date().toISOString().slice(0, 10);
      expect(eodDigestContext(store, today)).toBe("cancelled: none");
      store.markRoundCancelled(store.startRound(1, "first", [], 45), "x", "orphan_sweep");
      store.markRoundCancelled(store.startRound(2, "first", [], 45), "y", "deadline_overrun");
      expect(eodDigestContext(store, today)).toBe(
        "cancelled: 2 rounds — stopped dead 1 ⚑, orphan sweep (redeploy) 1 " +
          "(1 stopped dead — worth a look; the orphan sweep is a redeploy artefact and is not)",
      );
    } finally {
      store.close();
    }
  });

  it("the EOD line counts the ZONE-LOCAL day the timer names, not its UTC prefix", async () => {
    const { eodDigestContext } = await import("../src/digest.js");
    const { StateStore } = await import("../src/state.js");
    let clock = new Date("2026-08-13T22:30:00.000Z"); // 00:30 on Aug 14 in Warsaw
    const store = new StateStore(":memory:", () => clock);
    try {
      store.markRoundCancelled(store.startRound(1, "first", [], 45), "x", "deadline_overrun");
      clock = new Date("2026-08-14T22:30:00.000Z"); // 00:30 on Aug 15 in Warsaw
      store.markRoundCancelled(store.startRound(2, "first", [], 45), "y", "orphan_sweep");
      expect(eodDigestContext(store, "2026-08-14", "Europe/Warsaw")).toBe(
        "cancelled: 1 round — stopped dead 1 ⚑ " +
          "(1 stopped dead — worth a look; the orphan sweep is a redeploy artefact and is not)",
      );
    } finally {
      store.close();
    }
  });

  it("renderEodPrompt appends the day context so the sweep carries it into the digest", async () => {
    const { renderEodPrompt } = await import("../src/eod.js");
    const bare = renderEodPrompt("sweep {{date}}", "2026-08-21");
    expect(bare).toBe("sweep 2026-08-21");
    expect(renderEodPrompt("sweep {{date}}", "2026-08-21", "  ")).toBe(bare);
    const withContext = renderEodPrompt("sweep {{date}}\n", "2026-08-21", "cancelled: none");
    expect(withContext).toContain("## Daemon-measured context for 2026-08-21");
    expect(withContext).toContain("cancelled: none");
    expect(withContext.startsWith("sweep 2026-08-21\n")).toBe(true);
  });
});

it("does not relabel a lost-prompt cancellation as a stopped-dead round", () => {
  const line = cancellationSummaryLine({
    date: "2026-10-07",
    total: 1,
    loud: 1,
    by_cause: [{ cause: "lost_prompt", count: 1, loud: true }],
  });
  expect(line).not.toContain("1 stopped dead");
});

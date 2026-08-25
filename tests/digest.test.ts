import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createRubricBranch,
  digestHeadline,
  latestDigestFile,
  latestDigestHeadline,
  pendingProposals,
  rubricBranchName,
  writeDigest,
} from "../src/digest.js";
import type { Run } from "../src/improvements.js";

describe("digestHeadline", () => {
  it("skips headings and blank lines", () => {
    const content = "# Review sandbox — 2026-08-13\n\n## Reviews\n\nQuiet day: 2 rounds, 1 approve, no blockers.\n";
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

  it("ignores non-digest files and an empty/missing dir", () => {
    expect(latestDigestHeadline(dir)).toBeUndefined();
    expect(latestDigestHeadline(join(dir, "nope"))).toBeUndefined();
    writeFileSync(join(dir, "README.md"), "not a digest");
    expect(latestDigestFile(dir)).toBeUndefined();
  });
});

describe("rubric proposals (local branches only)", () => {
  it("builds the branch name and creates it locally", async () => {
    expect(rubricBranchName("pass-security", "SSRF checks", "2026-08-13")).toBe("rubric/pass-security-ssrf-checks-2026-08-13");
    const calls: string[][] = [];
    const run: Run = async (args) => {
      calls.push(args);
      return "";
    };
    const branch = await createRubricBranch(run, "pass-security", "ssrf", "2026-08-13");
    expect(branch).toBe("rubric/pass-security-ssrf-2026-08-13");
    expect(calls).toEqual([["branch", "rubric/pass-security-ssrf-2026-08-13"]]);
    // never pushed, never remote
    expect(calls.flat()).not.toContain("push");
  });

  it("lists pending proposals with PROPOSAL.md presence", async () => {
    const run: Run = async (args) => {
      if (args[0] === "branch") return "master\nrubric/pass-ui-a11y-2026-08-10\nrubric/pass-security-ssrf-2026-08-13\n";
      if (args[0] === "ls-tree") {
        return args[2] === "rubric/pass-ui-a11y-2026-08-10" ? "PROPOSAL.md\n" : "";
      }
      throw new Error(`unexpected git ${args.join(" ")}`);
    };
    expect(await pendingProposals(run)).toEqual([
      { branch: "rubric/pass-ui-a11y-2026-08-10", hasProposal: true },
      { branch: "rubric/pass-security-ssrf-2026-08-13", hasProposal: false },
    ]);
  });

  it("treats an ls-tree failure as no PROPOSAL.md", async () => {
    const run: Run = async (args) => {
      if (args[0] === "branch") return "rubric/x-y-2026-01-01";
      throw new Error("bad object");
    };
    expect(await pendingProposals(run)).toEqual([{ branch: "rubric/x-y-2026-01-01", hasProposal: false }]);
  });
});

describe("dailyUsage / usageSummaryLine", () => {
  it("aggregates the day's rounds, preferring est_usd over legacy spend_usd", async () => {
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
      expect(usageSummaryLine(usage)).toBe("usage: 2 rounds — 100000 in / 5000 out tokens — est $2.25");
    } finally {
      store.close();
    }
  });

  it("counts expired rounds' spend (finding 1 — expiry is not a refund)", async () => {
    const { StateStore } = await import("../src/state.js");
    const { dailyUsage } = await import("../src/digest.js");
    const store = new StateStore(":memory:");
    try {
      const a = store.startRound(7, "initial", [], 45);
      store.finishRound(a, "APPROVE", 1.0);
      const zombie = store.startRound(8, "initial", [], 45);
      store.db.prepare("UPDATE rounds SET status = 'expired', est_usd = 3.0 WHERE id = ?").run(zombie);
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
      for (const pr of [1, 2, 3]) store.markRoundCancelled(store.startRound(pr, "first", [], 45), "x", "orphan_sweep");
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
      for (let pr = 1; pr <= 12; pr++) store.markRoundCancelled(store.startRound(pr, "first", [], 45), "x", "orphan_sweep");
      const c = dailyCancellations(store, new Date().toISOString().slice(0, 10));
      expect(c.loud).toBe(0);
      expect(cancellationSummaryLine(c)).toBe("cancelled: 12 rounds — orphan sweep (redeploy) 12");
    } finally {
      store.close();
    }
  });

  // The wiring half: the helpers above were dead code until the
  // summary line rode the EOD sweep prompt (eod.ts renderEodPrompt dayContext,
  // wired in wire.ts) — the digest is written by the sweep session, so the
  // prompt is the only render the daemon owns.
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

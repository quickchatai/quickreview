import { expect, it } from "vitest";
import { panelFindings } from "../src/bench/pireview.js";
import { parseFindingsRecord } from "../src/bench/whatif.js";
import { parseClaudeProse } from "../src/bench/claudeprose.js";
import { policeBenchOutput } from "../src/bench/benchposting.js";
import { DEFAULT_POSTING_POLICY } from "@quickchatai/pi-quickreview/src/postingpolicy.js";
it("panel fallback borrows a complete path and location pair", () => {
  const findings = panelFindings({
    verdict: "APPROVE",
    status: "ok",
    findings: [],
    sourceFindings: [
      {
        id: "lead",
        reviewerId: "r1",
        finding: { summary: "Lead", actionable: true, path: "a.ts" },
      },
      {
        id: "anchor",
        reviewerId: "r2",
        finding: {
          summary: "Anchor",
          actionable: false,
          path: "b.ts",
          location: { startLine: 30 },
        },
      },
    ],
    confirmedClusters: [
      { id: "c", summary: "Merged", confirmed: true, sourceFindingIds: ["lead", "anchor"] },
    ],
  });
  expect(findings[0]).toMatchObject({ path: "b.ts", location: { startLine: 30 } });
});
it("panel fallback never attaches an unpathed borrowed location to the canonical file", () => {
  const findings = panelFindings({
    verdict: "APPROVE",
    status: "ok",
    findings: [],
    sourceFindings: [
      {
        id: "lead",
        reviewerId: "r1",
        finding: { summary: "Lead", actionable: true, path: "a.ts" },
      },
      {
        id: "anchor",
        reviewerId: "r2",
        finding: { summary: "Anchor", actionable: false, location: { startLine: 30 } },
      },
    ],
    confirmedClusters: [
      { id: "c", summary: "Merged", confirmed: true, sourceFindingIds: ["lead", "anchor"] },
    ],
  });
  // No source or cluster establishes a file for line 30. It cannot become a.ts:30.
  expect(findings[0]?.path === "a.ts" && findings[0]?.location?.startLine === 30).toBe(false);
});
it("record linking accepts canonical composite and group-qualified lens spellings", () => {
  const rows = parseFindingsRecord([
    {
      id: "f",
      lens: "baseline and sweep:G1 | pass-ui (2 lenses)",
      path: "a.ts",
      line: 1,
      disposition: "killed",
    },
  ]);
  expect(rows[0]?.lenses).toEqual(["pass-baseline", "pass-sweep", "pass-ui"]);
});
it("line-only prose locations refuse zero just like explicit locations", () => {
  const parsed = parseClaudeProse(
    "Findings in `a.ts`:\n\n1. **Line 0 — invalid anchor**\n2. **Line 3 — valid anchor**",
    ["a.ts"],
  );
  expect(parsed.findings.map((f) => f.start_line)).toEqual([3]);
});
it("handwritten verdict totals count a repeated root cause once", () => {
  const record = {
    findings: [
      {
        id: "root",
        disposition: "posted",
        title: "Root cause",
        path: "a.ts",
        line: 1,
        inline: false,
        posted_as: "nit",
        severity: "nit",
        reason: "First site.",
      },
      {
        id: "follow",
        same_as: "root",
        disposition: "posted",
        title: "Second site",
        path: "a.ts",
        line: 2,
        inline: false,
        posted_as: "nit",
        severity: "nit",
        reason: "Second site.",
      },
    ],
  };
  const output = policeBenchOutput({
    comments: [],
    reviewMd: "",
    record,
    outcome: { verdict: "APPROVE", summary: "Review" },
    policy: { ...DEFAULT_POSTING_POLICY, body: "verdict", repeat_sites: true },
  });
  expect(output.reviewMd.split("\n")[0]).toContain("1 nit");
  expect(output.reviewMd.split("\n")[0]).not.toContain("2 nits");
});

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

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdCompare } from "../src/cliops.js";

const fixture = vi.hoisted(() => ({ root: "" }));
vi.mock("../src/config.js", async (original) => ({
  ...(await original<typeof import("../src/config.js")>()),
  sandboxRoot: () => fixture.root,
  loadConfig: () => ({ github: { bot_login: "review-bot" } }),
}));
vi.mock("../src/wire.js", () => ({
  buildParts: () => ({
    adapter: {
      listReviewsFull: async () => [],
      listReviewCommentsFull: async () => [],
      listPrFiles: async () => [],
    },
  }),
}));

afterEach(() => {
  vi.restoreAllMocks();
  if (fixture.root) rmSync(fixture.root, { recursive: true, force: true });
});

describe("cmdCompare collection", () => {
  it("fails on unattributable malformed evidence while excluding other PRs", async () => {
    fixture.root = mkdtempSync(join(tmpdir(), "qcr-cliops-compare-"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    const dir = join(fixture.root, "state", "dryrun");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "review.json"),
      JSON.stringify({
        kind: "create_review",
        method: "POST",
        path: "/repos/test/repo/pulls/501/reviews",
        pr: 501,
        body: { event: "APPROVE", body: "Looks good", comments: [] },
      }),
    );
    writeFileSync(
      join(dir, "other.json"),
      JSON.stringify({ kind: "forbidden", method: "POST", path: "?", pr: 502 }),
    );
    expect(await cmdCompare([501])).toBe(0);

    writeFileSync(join(dir, "partial.json"), '{"kind":');
    expect(await cmdCompare([501])).toBe(1);
    const report = readFileSync(join(fixture.root, "reports", "501-compare.md"), "utf8");
    expect(report).toContain("unparseable");
    expect(report).toContain("partial.json");
    expect(report).not.toContain("forbidden");
  });
});

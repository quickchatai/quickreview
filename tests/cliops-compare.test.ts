import { renderMigrationCollisionComment } from "../src/migrations.js";
import { ESCALATION_TAG } from "../src/escalation.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdCompare } from "../src/cliops.js";

const fixture = vi.hoisted(() => ({
  root: "",
  reviews: [] as Array<{
    id: number;
    user: string;
    body: string;
    state: string;
    commit_id: string;
  }>,
  comments: [] as Array<{
    pull_request_review_id: number;
    path: string;
    line: number;
    body: string;
  }>,
}));
vi.mock("../src/config.js", async (original) => ({
  ...(await original<typeof import("../src/config.js")>()),
  sandboxRoot: () => fixture.root,
  loadConfig: () => ({ github: { bot_login: "review-bot" } }),
}));
vi.mock("../src/wire.js", () => ({
  buildParts: () => ({
    adapter: {
      listReviewsFull: async () => fixture.reviews,
      listReviewCommentsFull: async () => fixture.comments,
      listPrFiles: async () => [],
    },
  }),
}));

afterEach(() => {
  vi.restoreAllMocks();
  fixture.reviews = [];
  fixture.comments = [];
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

it.each(["migration", "escalation", "ordinary"])(
  "retains the substantive review when the latest bot COMMENT is mechanical (%s)",
  async (kind) => {
    fixture.root = mkdtempSync(join(tmpdir(), "qcr-compare-baseline-"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    fixture.reviews = [
      {
        id: 1,
        user: "review-bot",
        body: "Substantive review",
        state: "CHANGES_REQUESTED",
        commit_id: "abc",
      },
      {
        id: 2,
        user: "review-bot",
        body:
          kind === "migration"
            ? renderMigrationCollisionComment({ collisions: [], base_ref: "main", base_sha: "abc" })
            : kind === "escalation"
              ? `${ESCALATION_TAG} @someone — one specific thing, not a review of this pull request.`
              : "Ordinary substantive COMMENT",
        state: "COMMENTED",
        commit_id: "abc",
      },
    ];
    fixture.comments = [
      {
        pull_request_review_id: 1,
        path: "actual-blocker.ts",
        line: 1,
        body: "blocker: the implementation always drops requests",
      },
    ];
    if (kind === "ordinary")
      fixture.comments.push({
        pull_request_review_id: 2,
        path: "new-blocker.ts",
        line: 1,
        body: "blocker: the new version always drops requests",
      });
    const directory = join(fixture.root, "state/dryrun");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "review.json"),
      JSON.stringify({
        kind: "create_review",
        method: "POST",
        path: "/repos/test/repo/pulls/501/reviews",
        pr: 501,
        body: { event: "APPROVE", body: "Looks good", comments: [] },
      }),
    );
    expect(await cmdCompare([501])).toBe(1);
    expect(readFileSync(join(fixture.root, "reports/501-compare.md"), "utf8")).toContain(
      kind === "ordinary" ? "new-blocker.ts" : "actual-blocker.ts",
    );
  },
);

// The external benchmarks' scorers read a third-party bench arm's run
// (PR-Agent, OpenCode, …) as well as QuickReview's: martian_ingest.py --arm
// builds the record Martian's step 1 would have collected from the arm's
// review as the AACR defect judge reads it, under the arm's own tool name;
// qodo_judge.py --run-tool scores the run under that name.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = join(ROOT, "bench", "aacr", "ext");

let t: string;
beforeEach(() => {
  t = mkdtempSync(join(tmpdir(), "qcr-extarms-"));
});
afterEach(() => rmSync(t, { recursive: true, force: true }));

const URL_A = "https://github.com/o/r/pull/1";
const URL_B = "https://github.com/o/r/pull/2";

function writeArmCase(runDir: string, id: string, status: string, comments: unknown[], body: string | null) {
  mkdirSync(join(runDir, "cases", id), { recursive: true });
  mkdirSync(join(runDir, "results", "all"), { recursive: true });
  writeFileSync(join(runDir, "cases", id, "case-summary.json"), JSON.stringify({ instance_id: id, status }));
  writeFileSync(
    join(runDir, "results", "all", `${id}.json`),
    JSON.stringify({ instance_id: id, reviewer: "pragent", started_at: "2026-10-04T10:00:00Z", review: { comments } }),
  );
  if (body !== null) writeFileSync(join(runDir, "cases", id, "review.md"), body);
}

async function ingest(runDir: string, arm: string | null) {
  const set = join(t, "set.json");
  writeFileSync(
    set,
    JSON.stringify({
      cases: [
        { instance_id: "o__r-1@aaa", pr_url: URL_A },
        { instance_id: "o__r-2@bbb", pr_url: URL_B },
      ],
    }),
  );
  const pub = join(t, "published.json");
  const golden = { golden_comments: [{ comment: "x", severity: "High" }] };
  writeFileSync(
    pub,
    JSON.stringify({
      [URL_A]: { ...golden, reviews: [{ tool: "cubic-v2", review_comments: [] }] },
      [URL_B]: { ...golden, reviews: [{ tool: "cubic-v2", review_comments: [] }] },
    }),
  );
  const out = join(t, "work", "results", "benchmark_data.json");
  await run("python3", [
    join(EXT, "martian_ingest.py"), "--run", runDir, "--set", set, "--published", pub, "--out", out,
    ...(arm ? ["--arm", arm] : []),
  ]);
  return JSON.parse(readFileSync(out, "utf8")) as Record<string, { reviews: Array<{ tool: string; review_comments: Array<Record<string, unknown>> }> }>;
}

describe("martian_ingest.py --arm (a third-party bench arm)", () => {
  it("pragent: located findings as inline comments (first 30), then review.md as one body item, under pr-agent", async () => {
    const runDir = join(t, "run");
    const many = Array.from({ length: 33 }, (_, i) => ({ path: "a.py", start_line: i + 1, end_line: i + 2, content: `finding ${i}` }));
    writeArmCase(runDir, "o__r-1@aaa", "ok", [{ path: "a.py", start_line: 3, end_line: 3, content: "  " }, ...many], "## PR Reviewer Guide\nbody");
    writeArmCase(runDir, "o__r-2@bbb", "failed", many, "never posted");
    const d = await ingest(runDir, "pragent");
    const a = d[URL_A]!.reviews;
    expect(a.map((r) => r.tool)).toEqual(["pr-agent"]);
    const items = a[0]!.review_comments;
    expect(items).toHaveLength(31);
    expect(items[0]).toMatchObject({ path: "a.py", line: 2, body: "finding 0" });
    expect(items[29]!.body).toBe("finding 29");
    expect(items[30]).toMatchObject({ path: null, line: null, body: "## PR Reviewer Guide\nbody" });
    // A case that did not finish posted nothing.
    expect(d[URL_B]!.reviews[0]).toMatchObject({ tool: "pr-agent", review_comments: [] });
  });

  it("opencode: no review.md → inline comments only", async () => {
    const runDir = join(t, "run");
    writeArmCase(runDir, "o__r-1@aaa", "ok", [{ path: "b.ts", start_line: 7, end_line: null, content: "bug" }], null);
    writeArmCase(runDir, "o__r-2@bbb", "ok", [], null);
    const d = await ingest(runDir, "opencode");
    expect(d[URL_A]!.reviews[0]).toMatchObject({ tool: "opencode", review_comments: [{ path: "b.ts", line: 7, body: "bug" }] });
    expect(d[URL_B]!.reviews[0]!.review_comments).toEqual([]);
  });

  it("no --arm reads QuickReview's own case files, as before", async () => {
    const runDir = join(t, "run");
    for (const id of ["o__r-1@aaa", "o__r-2@bbb"]) {
      mkdirSync(join(runDir, "cases", id), { recursive: true });
      writeFileSync(join(runDir, "cases", id, "case-summary.json"), JSON.stringify({ status: "ok" }));
      writeFileSync(join(runDir, "cases", id, "outcome.json"), JSON.stringify({ finished_at: "t", verdict: "COMMENT" }));
      writeFileSync(join(runDir, "cases", id, "comments.json"), JSON.stringify([{ path: "c.go", line: 4, body: "[nit] x" }]));
      writeFileSync(join(runDir, "cases", id, "review.md"), "summary");
    }
    const d = await ingest(runDir, null);
    expect(d[URL_A]!.reviews[0]).toMatchObject({
      tool: "quickreview",
      review_comments: [{ path: "c.go", line: 4, body: "[nit] x" }, { path: null, line: null, body: "summary" }],
    });
  });
});

describe("qodo_judge.py reads a third-party arm's run", () => {
  it("ours() takes the arm's results/all review.comments view", async () => {
    const runDir = join(t, "run");
    writeArmCase(runDir, "o__r-1@aaa", "ok", [
      { path: "a.py", start_line: 5, end_line: 9, content: "race" },
      { path: null, start_line: null, end_line: null, content: "no location" },
    ], "body is not judged");
    const { stdout } = await run("python3", [
      "-c",
      "import sys, json; from pathlib import Path; sys.path.insert(0, sys.argv[1]); import qodo_judge as q; print(json.dumps(q.ours(Path(sys.argv[2]), 'o__r-1@aaa')))",
      EXT, runDir,
    ]);
    expect(JSON.parse(stdout)).toEqual([{ path: "a.py", start: 5, end: 9, body: "race" }]);
  });

  it("--run-tool refuses a published vendor's name", async () => {
    const err = await run("python3", [
      join(EXT, "qodo_judge.py"), "--set", "/dev/null", "--gt", "/dev/null", "--tools", "/dev/null",
      "--run", t, "--run-tool", "codex", "--endpoint", "http://127.0.0.1:9", "--out", join(t, "w"),
    ]).catch((e: { stderr: string }) => e);
    expect(String((err as { stderr: string }).stderr)).toMatch(/published vendor's name/);
  });
});

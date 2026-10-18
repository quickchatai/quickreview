import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BenchCase, CaseSet } from "../src/bench/aacr.js";
import { claudeRebuildRun } from "../src/bench/claudecode.js";
import { judgeCase, roundFile } from "../src/bench/defectjudge.js";
import { writeWhatifRun } from "../src/bench/whatifrun.js";
import { recordUnprefetched, writeResults } from "../src/bench/runner.js";

const fault = vi.hoisted(() => ({ destination: "" }));
vi.mock("node:fs", async (original) => {
  const real = await original<typeof import("node:fs")>();
  return {
    ...real,
    writeFileSync: (...args: Parameters<typeof real.writeFileSync>) => {
      if (String(args[0]) === fault.destination) {
        real.writeFileSync(args[0], "{");
        throw new Error("publication interrupted");
      }
      return real.writeFileSync(...args);
    },
    renameSync: (...args: Parameters<typeof real.renameSync>) => {
      if (String(args[1]) === fault.destination) throw new Error("publication interrupted");
      return real.renameSync(...args);
    },
  };
});

const c: BenchCase = {
  instance_id: "o__r@1234567",
  repo: "o/r",
  pr: 1,
  pr_url: "https://github.com/o/r/pull/1",
  base_commit: "a",
  head_commit: "b",
  language: "TypeScript",
  pr_category: "bug",
  change_line_count: 1,
  references: 1,
};
const set: CaseSet = {
  name: "t",
  dataset: { source: "s", commit: "c", file: "f", sha256: "s" },
  rule: "",
  references: 1,
  cases: [c],
  backups: [],
};
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bench-publication-"));
});
afterEach(() => {
  fault.destination = "";
  rmSync(dir, { recursive: true, force: true });
});

function completed() {
  const summary = recordUnprefetched(dir, c, "no store", {} as never);
  summary.status = "ok";
  writeResults(dir, c, [], summary);
  return summary;
}

it("a byte-identical results rebuild never opens its completed result for writing", () => {
  const summary = completed();
  fault.destination = join(dir, "results/all", `${c.instance_id}.json`);
  expect(() => writeResults(dir, c, [], summary)).not.toThrow();
});

it("an interrupted changed-result publication keeps the old result and invalidates old metrics", () => {
  const summary = completed();
  const file = join(dir, "results/all", `${c.instance_id}.json`);
  const before = readFileSync(file, "utf8");
  const metrics = join(dir, "results/all/metrics_ocr_round_1.json");
  writeFileSync(metrics, "{}");
  fault.destination = file;
  expect(() =>
    writeResults(
      dir,
      c,
      [{ path: "a.ts", line: 1, side: "RIGHT", tag: "blocker", body: "[blocker] Failure" }],
      summary,
    ),
  ).toThrow("publication interrupted");
  expect(readFileSync(file, "utf8")).toBe(before);
  expect(existsSync(metrics)).toBe(false);
});

it("an interrupted Claude view rebuild preserves the paid harness payload", async () => {
  const file = join(dir, "results/all", `${c.instance_id}.json`);
  mkdirSync(join(dir, "results/all"), { recursive: true });
  const original = JSON.stringify({
    review_output: "I found one bug.\n\n- src/a.ts:12 — Null dereference.",
    review_output_source: "stdout_fallback",
    token_usage: { input_tokens: 123 },
  });
  writeFileSync(file, original);
  fault.destination = file;
  await expect(claudeRebuildRun({ set, outDir: dir, log: () => {} })).rejects.toThrow(
    "publication interrupted",
  );
  expect(readFileSync(file, "utf8")).toBe(original);
});

it("resumes an unreadable judgement checkpoint as unproven work", async () => {
  writeFileSync(roundFile(dir, c.instance_id, 1), "{");
  const rows = await judgeCase({
    pr: { instance_id: c.instance_id, repo: c.repo, title: "T", merge_base: "a", head: "b" },
    defects: [],
    review: { verdict: "APPROVE", body: null, comments: [] },
    rounds: 1,
    outDir: dir,
    defectSetVersion: "v1",
    pi: { root: dir, cwd: dir, model: "m", env: {}, timeoutMs: 1000 },
    resume: true,
    log: () => {},
  });
  expect(rows).toHaveLength(1);
  expect(rows[0]?.error).toBeUndefined();
  expect(JSON.parse(readFileSync(roundFile(dir, c.instance_id, 1), "utf8")).model).toBe("m");
});

it("a byte-identical what-if rebuild keeps the existing completed variant untouched", () => {
  const source = join(dir, "source/results/all");
  mkdirSync(source, { recursive: true });
  writeFileSync(
    join(source, `${c.instance_id}.json`),
    JSON.stringify({ review: { comments: [] } }),
  );
  writeWhatifRun(dir, [c]);
  fault.destination = join(dir, "results/posted", `${c.instance_id}.json`);
  expect(() => writeWhatifRun(dir, [c])).not.toThrow();
});
it("an interrupted changed what-if variant retains its old complete bytes", () => {
  const source = join(dir, "source/results/all");
  mkdirSync(source, { recursive: true });
  const input = join(source, `${c.instance_id}.json`);
  writeFileSync(input, JSON.stringify({ review: { comments: [] } }));
  writeWhatifRun(dir, [c]);
  const file = join(dir, "results/posted", `${c.instance_id}.json`);
  const before = readFileSync(file, "utf8");
  const metrics = join(dir, "results/posted/metrics_ocr_round_1.json");
  writeFileSync(metrics, "{}");
  writeFileSync(
    input,
    JSON.stringify({
      review: { comments: [{ path: "a.ts", start_line: 1, end_line: 1, content: "New finding" }] },
    }),
  );
  fault.destination = file;
  expect(() => writeWhatifRun(dir, [c])).toThrow("publication interrupted");
  expect(readFileSync(file, "utf8")).toBe(before);
  expect(existsSync(metrics)).toBe(false);
});

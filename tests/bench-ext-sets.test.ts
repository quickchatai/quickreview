// External-benchmark case sets (bench/aacr/EXTERNAL-BENCHMARKS.md): the
// dataset-pin REGISTRY that lets parseCaseSet accept them without loosening
// the AACR-Bench v1.0 pin, the new case fields' validation, and the committed
// sets themselves — including that the SWE-PRBench set's synthetic commit ids
// are exactly what src/bench/aacr.ts leakproofCommitText hashes to (the set
// builder is Python; prefetch is this code; they must agree byte for byte).

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AACR_V1,
  DATASET_PINS,
  datasetPin,
  leakproofCommitText,
  parseCaseSet,
} from "../src/bench/aacr.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const set = (name: string) =>
  JSON.parse(readFileSync(join(ROOT, "bench", "aacr", "sets", `${name}.json`), "utf8"));
const commitId = (text: string): string =>
  createHash("sha1")
    .update(`commit ${Buffer.byteLength(text)}\0${text}`)
    .digest("hex");

describe("dataset pin registry", () => {
  it("keeps AACR-Bench v1.0 and adds exactly the three external pins and the self-review pin", () => {
    expect(DATASET_PINS.map((p) => p.id)).toEqual([
      "aacr-v1",
      "martian-offline-e616e84",
      "swe-prbench-b87f579",
      "self-review-local",
      "qodo-pr-review-bench-a73957c",
    ]);
    // The self-review pin denominates nothing: no references, never scored.
    expect(DATASET_PINS.find((p) => p.id === "self-review-local")!.denomination).toMatch(
      /never scored/,
    );
    expect(datasetPin({ commit: AACR_V1.commit, sha256: AACR_V1.sha256 })?.id).toBe("aacr-v1");
    expect(parseCaseSet(set("smoke10")).pin).toBe("aacr-v1");
  });

  it("matches commit AND sha256 — one of them is not enough", () => {
    const m = DATASET_PINS[1]!;
    expect(datasetPin({ commit: m.commit, sha256: AACR_V1.sha256 })).toBeNull();
    expect(datasetPin({ commit: AACR_V1.commit, sha256: m.sha256 })).toBeNull();
    const moved = set("martian-smoke10");
    moved.dataset.sha256 = "0".repeat(64);
    expect(() => parseCaseSet(moved)).toThrow(/registered dataset pin/);
  });
});

describe("external case fields", () => {
  const base = () => set("martian-smoke10");

  it("a fork case's id carries its PR number (two Martian PRs share one head)", () => {
    const s = base();
    const c = s.cases[0];
    expect(c.instance_id).toBe(`${c.repo.replace("/", "__")}-${c.pr}@${c.head_commit.slice(0, 7)}`);
    s.cases[0] = { ...c, instance_id: `${c.repo.replace("/", "__")}@${c.head_commit.slice(0, 7)}` };
    expect(() => parseCaseSet(s)).toThrow(/does not match/);
  });

  it("validates fetch_repo, fetch_pr, the PR text and the expected merge-base as shapes", () => {
    const c0 = base().cases[0];
    const bad = (patch: Record<string, unknown>) => ({ ...base(), cases: [{ ...c0, ...patch }] });
    expect(() => parseCaseSet(bad({ fetch_repo: "../../etc" }))).toThrow(/bad fetch_repo/);
    expect(() => parseCaseSet(bad({ fetch_pr: 0 }))).toThrow(/fetch_pr/);
    expect(() => parseCaseSet(bad({ title: 7 }))).toThrow(/title/);
    expect(() => parseCaseSet(bad({ expect_merge_base: "HEAD" }))).toThrow(/expect_merge_base/);
    expect(parseCaseSet(bad({ body: null })).cases[0]!.body).toBeNull();
  });

  it("a leak-proof case needs four 40-hex shas and fetches from its own repo", () => {
    const s = set("sweprbench-smoke10");
    const c0 = s.cases[0];
    const bad = (patch: Record<string, unknown>) => ({ ...s, cases: [{ ...c0, ...patch }] });
    expect(() => parseCaseSet(bad({ leakproof: { ...c0.leakproof, head_tree: "nope" } }))).toThrow(
      /leakproof/,
    );
    // A fork id is required once fetch_repo is present, and the combination is refused anyway.
    const forked = {
      ...c0,
      fetch_repo: "a/b",
      instance_id: `${c0.repo.replace("/", "__")}-${c0.pr}@${c0.head_commit.slice(0, 7)}`,
    };
    expect(() => parseCaseSet({ ...s, cases: [forked] })).toThrow(/own repo/);
  });
});

describe("the committed external sets", () => {
  it("martian50 and martian-smoke10: every PR, the 173 golden comments, 2 per project in the smoke", () => {
    const all = parseCaseSet(set("martian50"));
    expect(all.pin).toBe("martian-offline-e616e84");
    expect(all.cases).toHaveLength(50);
    expect(all.references).toBe(173);
    const smoke = parseCaseSet(set("martian-smoke10"));
    expect(smoke.cases).toHaveLength(10);
    const raw = set("martian-smoke10").cases as Array<{ martian: { project: string } }>;
    const perProject = new Map<string, number>();
    for (const c of raw)
      perProject.set(c.martian.project, (perProject.get(c.martian.project) ?? 0) + 1);
    expect([...perProject.values()]).toEqual([2, 2, 2, 2, 2]);
    for (const c of smoke.cases) {
      expect(c.fetch_repo).toMatch(/^code-review-benchmark\//);
      expect(c.fetch_pr).toBe(1);
      expect(c.expect_merge_base).toMatch(/^[0-9a-f]{40}$/);
      expect(all.cases.some((a) => a.instance_id === c.instance_id)).toBe(true);
    }
    // The decision asked for at least one PR whose base moved past its merge-base.
    expect(smoke.cases.some((c) => c.expect_merge_base !== c.base_commit)).toBe(true);
  });

  it("sweprbench-smoke10: the ten decided PRs, leak-proof, synthetic ids that recompute", () => {
    const raw = set("sweprbench-smoke10");
    const s = parseCaseSet(raw);
    expect(s.pin).toBe("swe-prbench-b87f579");
    expect(raw.cases.map((c: { task_id: string }) => c.task_id).sort()).toEqual(
      [
        "coreos-assembler__4386",
        "stylelint__8953",
        "vitest__9152",
        "nessie__11676",
        "mycli__1517",
        "falcon__2572",
        "pip__13482",
        "pipecat__3328",
        "espnet__6356",
        "litgpt__2188",
      ].sort(),
    );
    for (const c of s.cases) {
      const lp = c.leakproof!;
      const b = commitId(leakproofCommitText(lp.base_tree, null));
      expect(c.base_commit).toBe(b);
      expect(c.head_commit).toBe(commitId(leakproofCommitText(lp.head_tree, b)));
      // The PR text rides the set: prefetch never asks the API for these.
      expect(typeof c.title).toBe("string");
    }
  });

  it("qodo-smoke10: one PR per repository, leak-proof, synthetic ids that recompute, no benchmark header in the PR text", () => {
    const raw = set("qodo-smoke10");
    const s = parseCaseSet(raw);
    expect(s.pin).toBe("qodo-pr-review-bench-a73957c");
    expect(s.cases).toHaveLength(10);
    const repos = new Set(raw.cases.map((c: { repo: string }) => c.repo));
    expect(repos.size).toBe(8);
    for (const c of s.cases) {
      const lp = c.leakproof!;
      const b = commitId(leakproofCommitText(lp.base_tree, null));
      expect(c.base_commit).toBe(b);
      expect(c.head_commit).toBe(commitId(leakproofCommitText(lp.head_tree, b)));
      expect(c.body ?? "").not.toMatch(/Code Review Bench|Original PR URL/);
    }
    const all = set("qodo-pr100");
    expect(parseCaseSet(all).cases).toHaveLength(100);
    expect(all.references).toBe(580);
  });
});

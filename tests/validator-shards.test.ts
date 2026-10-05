// `[review] validator_shards` (bench/aacr/PERF.md §6 proposal 4): above 1 the
// round's candidates are split by file over that many pass-validate children
// launched in one call, and merged by the session — which owns the two duties
// no group can see from inside (a duplicate across groups, the posting budget).
// One shard (the default) or no validator row renders nothing.
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { renderValidatorShardNote } from "../src/templates.js";
import type { PassPlanEntry } from "../src/types.js";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VALIDATE: PassPlanEntry = {
  lens: "pass-validate",
  agent: "pass-validate--sol-high",
  tier: "sol-high",
  raisable_to: [],
};
const BASE: PassPlanEntry = {
  lens: "pass-baseline",
  agent: "pass-baseline--sol-med",
  tier: "sol-med",
  raisable_to: [],
};

describe("renderValidatorShardNote", () => {
  it("renders nothing with one validator, by default, or with no validator row", () => {
    expect(renderValidatorShardNote({ pass_plan: [BASE, VALIDATE] })).toBe("");
    expect(renderValidatorShardNote({ pass_plan: [BASE, VALIDATE], validator_shards: 1 })).toBe("");
    expect(renderValidatorShardNote({ pass_plan: [BASE], validator_shards: 2 })).toBe("");
  });

  it("asks for N groups by file in one call, and puts the cross-group duties at the merge", () => {
    const note = renderValidatorShardNote({ pass_plan: [BASE, VALIDATE], validator_shards: 2 });
    expect(note).toContain("2 parallel groups");
    expect(note).toContain("by FILE");
    expect(note).toContain("ONE `subagent` call");
    expect(note).toContain("WHOLE SETTLED");
    expect(note).toContain("`killed` / `duplicate`");
    expect(note).toContain("posting budget");
    expect(note).toContain("ONE `pass-validate` entry");
  });
});

describe("[review] validator_shards parsing", () => {
  function withReview(extra: string): string {
    const dir = mkdtempSync(join(tmpdir(), "qcr-shards-"));
    const src = readFileSync(join(ROOT, "tests", "fixtures", "config.toml"), "utf8");
    const file = join(dir, "config.toml");
    writeFileSync(file, src.replace(/^\[review\]\n/m, `[review]\n${extra}\n`));
    return file;
  }
  it("defaults to 1 and accepts 1-4", () => {
    const f = withReview("validator_shards = 3");
    try {
      expect(loadConfig(f).review.validator_shards).toBe(3);
    } finally {
      rmSync(dirname(f), { recursive: true, force: true });
    }
  });
  it("refuses 0, 5 and a fraction", () => {
    for (const v of ["0", "5", "1.5"]) {
      const f = withReview(`validator_shards = ${v}`);
      try {
        expect(() => loadConfig(f)).toThrow(/validator_shards must be an integer 1-4/);
      } finally {
        rmSync(dirname(f), { recursive: true, force: true });
      }
    }
  });
});

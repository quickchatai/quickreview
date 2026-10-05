// `[review] dedup_merge` wiring (docs/duplicate-merge.md): the knob, the
// round-order note, the validator rule, and the `cluster_findings` tool on
// the argv of BOTH routes. With the knob off nothing changes.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseConfig, REVIEW_DEFAULTS } from "../src/config.js";
import { configAddenda } from "../src/include.js";
import { renderDedupNote } from "../src/templates.js";
import { CLUSTER_TOOL, readCandidates } from "../extensions/finding-clusters.js";

const root = resolve(process.cwd());

describe("the knob", () => {
  it("defaults on and parses", () => {
    expect(REVIEW_DEFAULTS.dedup_merge).toBe(true);
    const fixture = readFileSync(join(root, "tests/fixtures/config.toml"), "utf8");
    expect(parseConfig(fixture).review.dedup_merge).toBe(true);
    expect(
      parseConfig(fixture.replace("[review]", "[review]\ndedup_merge = false")).review.dedup_merge,
    ).toBe(false);
    expect(() => parseConfig(fixture.replace("[review]", '[review]\ndedup_merge = "yes"'))).toThrow(
      /dedup_merge must be true or false/,
    );
  });
});

describe("the round order note", () => {
  it("renders only when the order carries the flag", () => {
    expect(renderDedupNote({})).toBe("");
    expect(renderDedupNote({ dedup_merge: false })).toBe("");
    const note = renderDedupNote({ dedup_merge: true });
    expect(note).toContain("`cluster_findings` tool ONCE");
    expect(note).toContain("`CANDIDATE GROUPS`");
    expect(note).toContain("supersedes step 3's one-row-per-site rule");
    expect(note).toContain("`merged_into`");
  });
  it("every round template carries the placeholder on the validator line", () => {
    for (const t of ["round-first.md", "round-re-review.md", "round-staleness.md"])
      expect(readFileSync(join(root, "prompts", t), "utf8")).toContain(
        "{{validator_note}}{{validator_shard_note}}{{dedup_note}}",
      );
  });
});

describe("the validator rule", () => {
  it("is composed only when the knob is on, onto pass-validate, PR builds only", () => {
    expect(configAddenda({}).some((a) => a.id === "dedup-group-validate")).toBe(false);
    expect(configAddenda({ dedup_merge: false }).some((a) => a.id === "dedup-group-validate")).toBe(
      false,
    );
    const a = configAddenda({ dedup_merge: true }).find((x) => x.id === "dedup-group-validate")!;
    expect(a.scope).toEqual(["pass-validate"]);
    expect(a.mode).toBe("pr");
    expect(a.text).toMatch(/One root cause → ONE surviving finding/);
    expect(a.text).toMatch(/every lens that raised it/);
    expect(a.text).toMatch(
      /never merge two findings because they share a file, a line range or a word/,
    );
  });
});

describe("cluster_findings on both routes", () => {
  it("the daemon's PR sessions load it (sessions.ts extensionPaths)", () => {
    expect(readFileSync(join(root, "src/sessions.ts"), "utf8")).toMatch(
      /join\(this\.root, "extensions", "finding-clusters\.ts"\)/,
    );
  });
  it("the bench session loads it (runner.ts argv)", () => {
    expect(readFileSync(join(root, "src/bench/runner.ts"), "utf8")).toMatch(
      /"--extension",\s*join\(o\.root, "extensions", "finding-clusters\.ts"\)/,
    );
  });
  it("answers groups for the validator, and reports malformed input instead of throwing", async () => {
    const res = await CLUSTER_TOOL.execute("t1", {
      candidates: [
        {
          id: "A",
          path: "a.ts",
          line: 1,
          title: "`foo` breaks",
          lens: "pass-baseline",
          severity: "P1",
        },
        {
          id: "B",
          path: "a.ts",
          line: 4,
          title: "`foo` again",
          lens: "pass-sweep",
          severity: "P3",
        },
        { id: "C", path: "b.ts", line: 90, title: "unrelated" },
      ],
    });
    const t = res.content[0]!.text;
    expect(t).toContain("3 candidate(s) → 1 group(s), 1 alone.");
    expect(t).toContain("CANDIDATE GROUPS");
    expect(t).toContain("**G1**");
    expect(readCandidates("not json").problems[0]).toMatch(/not valid JSON/);
    expect(readCandidates({}).problems).toContain("candidates must be an array");
  });
});

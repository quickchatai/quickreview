// `[review] coverage_check` (src/coverage.ts):
// a changed non-test source file no lens raised a finding on gets a targeted
// pass-sweep row (at most two, packed by line budget), each saying why, so a
// changed file no lens produced anything on still gets read. With the knob
// off, or every file addressed, nothing changes.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseConfig, REVIEW_DEFAULTS } from "../src/config.js";
import {
  coverageEligible,
  coverageGaps,
  coverageReason,
  COVERAGE_MAX_GROUPS,
} from "../src/coverage.js";
import { renderCoverageNote } from "../src/templates.js";
import { COVERAGE_TOOL, readCoverageArgs } from "../extensions/finding-clusters.js";

const root = resolve(process.cwd());
const f = (filename: string, additions = 10, status = "modified", deletions = 0) => ({
  filename,
  additions,
  deletions,
  status,
});

describe("eligible files", () => {
  it("keeps changed source code; drops tests, docs, locks, vendored, generated, removed and deletion-only files", () => {
    const got = coverageEligible([
      f("src/app/Server.java", 30, "modified", 5),
      f("src/test/java/app/ServerTest.java"),
      f("tests/test_x.py"),
      f("README.md"),
      f("package-lock.json"),
      f("vendor/lib/a.go"),
      f("dist/bundle.js"),
      f("src/gone.ts", 0, "removed", 40),
      f("src/only_deleted.ts", 0, "modified", 12),
      f("pom.xml"),
      f("lib/util.rs", 4),
    ]);
    expect(got).toEqual([
      { path: "src/app/Server.java", lines: 35 },
      { path: "lib/util.rs", lines: 4 },
    ]);
  });
});

describe("coverageGaps", () => {
  const el = [
    { path: "a/One.java", lines: 200 },
    { path: "a/Two.java", lines: 250 },
    { path: "a/Three.java", lines: 400 },
    { path: "a/Four.java", lines: 900 },
    { path: "a/Five.java", lines: 10 },
  ];
  it("is empty when every eligible file was addressed (suffix paths count)", () => {
    const g = coverageGaps(el, [
      "a/One.java",
      "Two.java",
      "./a/Three.java",
      "a/Four.java",
      "a/Five.java",
    ]);
    expect(g).toEqual({ uncovered: [], groups: [], unchecked: [] });
  });
  it("a path that is itself eligible covers only itself, never a shorter eligible path it ends with", () => {
    const pair = [
      { path: "utils.ts", lines: 10 },
      { path: "src/utils.ts", lines: 10 },
    ];
    // A sweep focused on src/utils.ts did not read the root utils.ts.
    expect(coverageGaps(pair, [], undefined, undefined, ["src/utils.ts"]).uncovered).toEqual([
      "utils.ts",
    ]);
    // A prefixed path (a worktree's) names the longest eligible path it ends with.
    expect(coverageGaps(pair, ["/wt/pr-1/src/utils.ts"]).uncovered).toEqual(["utils.ts"]);
    // A name that is an eligible path is that path, even where it is another's tail.
    expect(coverageGaps(pair, ["utils.ts"]).uncovered).toEqual(["src/utils.ts"]);
    expect(coverageGaps(pair, ["/wt/pr-1/utils.ts"]).uncovered).toEqual(["src/utils.ts"]);
    // A tail no eligible path equals still names every eligible path ending with it.
    const twins = [
      { path: "a/x.ts", lines: 1 },
      { path: "b/x.ts", lines: 1 },
    ];
    expect(coverageGaps(twins, ["x.ts"]).uncovered).toEqual([]);
  });
  it("packs the unaddressed files by line budget into at most two rows and lists the rest", () => {
    const g = coverageGaps(el, ["a/One.java"]);
    expect(g.uncovered).toEqual(["a/Two.java", "a/Three.java", "a/Four.java", "a/Five.java"]);
    expect(g.groups).toEqual([["a/Two.java"], ["a/Three.java"]]);
    expect(g.groups.length).toBe(COVERAGE_MAX_GROUPS);
    expect(g.unchecked).toEqual(["a/Four.java", "a/Five.java"]);
  });
  it("a file over the budget gets a row of its own; small files share", () => {
    const g = coverageGaps(
      [
        { path: "x/Big.kt", lines: 900 },
        { path: "x/a.kt", lines: 5 },
        { path: "x/b.kt", lines: 5 },
      ],
      [],
    );
    expect(g.groups).toEqual([["x/Big.kt"], ["x/a.kt", "x/b.kt"]]);
  });
  it("a file a returned sweep row had in focus counts as read, NONE included", () => {
    // Swept: One and Two (a planned sweep row that answered NONE), Three by a
    // repo-relative tail. Four was past the sweep cap; Five's row failed, so
    // the session left it out of `swept`.
    const g = coverageGaps(el, [], undefined, undefined, [
      "a/One.java",
      "a/Two.java",
      "Three.java",
    ]);
    expect(g.uncovered).toEqual(["a/Four.java", "a/Five.java"]);
    expect(g.groups).toEqual([["a/Four.java"], ["a/Five.java"]]);
    // Addressed and swept union; nothing left, nothing to launch.
    expect(
      coverageGaps(el, ["a/Four.java"], undefined, undefined, [
        "a/One.java",
        "a/Two.java",
        "a/Three.java",
        "a/Five.java",
      ]),
    ).toEqual({ uncovered: [], groups: [], unchecked: [] });
    // No sweep list: the same as an empty one.
    expect(coverageGaps(el, ["a/One.java"])).toEqual(
      coverageGaps(el, ["a/One.java"], undefined, undefined, []),
    );
  });
  it("says why", () => {
    expect(coverageReason(["a.ts", "b.ts"])).toBe("coverage: no lens addressed a.ts, b.ts");
  });
});

describe("the knob and the note", () => {
  it("defaults on and parses", () => {
    expect(REVIEW_DEFAULTS.coverage_check).toBe(true);
    const fixture = readFileSync(join(root, "tests/fixtures/config.toml"), "utf8");
    expect(parseConfig(fixture).review.coverage_check).toBe(true);
    expect(
      parseConfig(fixture.replace("[review]", "[review]\ncoverage_check = false")).review
        .coverage_check,
    ).toBe(false);
    expect(() =>
      parseConfig(fixture.replace("[review]", '[review]\ncoverage_check = "yes"')),
    ).toThrow(/coverage_check must be true or false/);
  });
  it("renders nothing without coverage files (byte-identical order), the instruction with them", () => {
    expect(renderCoverageNote({})).toBe("");
    expect(renderCoverageNote({ coverage_files: [] })).toBe("");
    const note = renderCoverageNote({ coverage_files: [{ path: "a/B.java", lines: 12 }] });
    expect(note).toContain("`coverage_gaps`");
    expect(note).toContain("COVERAGE <files>");
    expect(note).toContain('[{"path":"a/B.java","lines":12}]');
    expect(note).toContain("At most two such rows");
    // A returned sweep row's focus counts, NONE included; a failed
    // row's does not; other NONE lenses still address nothing.
    expect(note).toContain("`swept` =");
    expect(note).toContain("`pass-sweep` row that RETURNED — NONE\nincluded");
    expect(note).toContain("row does not count: it skips pure additions");
    expect(note).toContain("A row that failed, errored or was cut short sweeps nothing");
    expect(note).not.toContain("a lens that only\nanswered NONE addresses nothing");
  });
  it("sits at the end of step 2 in every round template", () => {
    for (const t of ["round-first.md", "round-re-review.md", "round-staleness.md"]) {
      expect(readFileSync(join(root, "prompts", t), "utf8")).toContain(
        "{{intent_note}}{{coverage_note}}\n\n## 3. Merge",
      );
    }
  });
});

describe("coverage_gaps on both routes", () => {
  it("rides the finding-clusters extension both routes load", () => {
    const ext = readFileSync(join(root, "extensions/finding-clusters.ts"), "utf8");
    expect(ext).toContain("pi.registerTool(COVERAGE_TOOL)");
    expect(readFileSync(join(root, "src/sessions.ts"), "utf8")).toMatch(/"finding-clusters\.ts"/);
    expect(readFileSync(join(root, "src/bench/runner.ts"), "utf8")).toMatch(
      /"finding-clusters\.ts"/,
    );
  });
  it("answers rows with reasons, and reports malformed input instead of throwing", async () => {
    const res = await COVERAGE_TOOL.execute("t1", {
      eligible: [
        { path: "q/Dist.java", lines: 40 },
        { path: "q/Other.java", lines: 8 },
      ],
      addressed: ["q/Other.java"],
    });
    const t = res.content[0]!.text;
    expect(t).toContain('ROW 1: focus ["q/Dist.java"]');
    expect(t).toContain("reason: coverage: no lens addressed q/Dist.java");
    const all = await COVERAGE_TOOL.execute("t2", {
      eligible: [{ path: "q/Dist.java", lines: 40 }],
      addressed: ["q/Dist.java"],
    });
    expect(all.content[0]!.text).toContain("no coverage row");
    // `swept` (a returned sweep row's focus) closes the gap too.
    const swept = await COVERAGE_TOOL.execute("t3", {
      eligible: [
        { path: "q/Dist.java", lines: 40 },
        { path: "q/Other.java", lines: 8 },
      ],
      addressed: [],
      swept: ["q/Dist.java"],
    });
    expect(swept.content[0]!.text).toContain('ROW 1: focus ["q/Other.java"]');
    expect(swept.content[0]!.text).not.toContain('q/Dist.java"]');
    expect(readCoverageArgs({ eligible: [], addressed: [] }).swept).toEqual([]);
    expect(readCoverageArgs({ eligible: [], addressed: [], swept: '["a.ts"]' }).swept).toEqual([
      "a.ts",
    ]);
    expect(readCoverageArgs({ eligible: [], addressed: [], swept: 3 }).problems).toEqual([
      "swept must be an array",
    ]);
    expect(readCoverageArgs({ eligible: "nope", addressed: [] }).problems).toContain(
      "eligible is not valid JSON",
    );
    expect(readCoverageArgs({ eligible: {}, addressed: {} }).problems).toEqual([
      "eligible must be an array",
      "addressed must be an array",
    ]);
  });
});

// tests/baseline-split.test.ts — pass-baseline split by file group on a very
// large change (`[review] baseline_split_lines`,
// heuristics.ts `baselineGroups`, dispatch.ts `buildPassPlan`).
//
// What is pinned: at or under the threshold (and at 0) the plan is
// byte-identical to the unsplit plan; over it pass-baseline is 2–3 rows of the
// same agent, each STARTING from one group of the change's files — every file
// the PR keeps in exactly one group — with the whole PR as its charter; the
// rows launch first; the plan table and each row's task say a focus here is a
// starting point, never a bound; and a prior finding that falls to
// pass-baseline goes to exactly one row.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig, type Config } from "../src/config.js";
import { buildPassPlan, buildRoundOrder } from "../src/dispatch.js";
import { NONE_ECOSYSTEM } from "../src/ecosystem.js";
import type { PrFileEntry } from "../src/github.js";
import {
  BASELINE_SPLIT_MAX_ROWS,
  baselineGroups,
  baselineSplitLines,
  isSplitBaselineRow,
} from "../src/heuristics.js";
import { renderPassTask } from "../src/passtasks.js";
import type { PrStateRow } from "../src/state.js";
import { renderPassPlan } from "../src/templates.js";

const sandbox = resolve(import.meta.dirname, "..");
const fixture: Config = parseConfig(
  readFileSync(resolve(sandbox, "tests/fixtures/config.toml"), "utf8"),
);

function cfgAt(n?: number): Config {
  const cfg = structuredClone(fixture);
  if (n !== undefined) cfg.review.baseline_split_lines = n;
  return cfg;
}

function file(
  filename: string,
  additions: number,
  deletions = 0,
  status = "modified",
): PrFileEntry {
  return {
    filename,
    status,
    additions,
    deletions,
    changes: additions + deletions,
    patch: "@@ -1 +1 @@\n-a\n+b\n",
  } as unknown as PrFileEntry;
}

const SMALL: PrFileEntry[] = [
  file("src/orders/api.py", 400, 30),
  file("src/web/App.tsx", 90, 10),
  file("tests/test_orders.py", 30),
];

// 2,600 changed lines a reader reads (the lockfile weighs nothing, the
// README half): over the 2000 default, under 2 × 2000 ⇒ two rows.
const LARGE: PrFileEntry[] = [
  file("backend/api/router.py", 700, 100),
  file("backend/api/views.py", 400, 50),
  file("backend/models.py", 300, 0),
  file("frontend/App.tsx", 500, 50),
  file("frontend/package-lock.json", 4000, 2000),
  file("frontend/store.ts", 300, 0),
  file("README.md", 200, 0),
  file("backend/old.py", 0, 900, "removed"),
];

describe("baselineGroups", () => {
  it("never splits at or under the threshold, at 0, or when one file is nearly the whole change", () => {
    expect(baselineGroups(SMALL, 0)).toEqual([]);
    expect(baselineGroups(SMALL, 2000)).toEqual([]);
    expect(baselineGroups(LARGE, 0)).toEqual([]);
    const lines = baselineSplitLines(LARGE);
    expect(baselineGroups(LARGE, lines)).toEqual([]);
    expect(baselineGroups([file("a.py", 5000), file("b.py", 10)], 2000)).toEqual([]);
  });

  it("measures the change the way the sweep sizes it: prose half, lockfiles nothing", () => {
    expect(baselineSplitLines(LARGE)).toBe(800 + 450 + 300 + 550 + 0 + 300 + 100 + 900);
  });

  it("cuts every file the PR keeps into exactly one group, in diff order, balanced by lines", () => {
    const groups = baselineGroups(LARGE, 2000);
    expect(groups.length).toBe(2);
    const kept = LARGE.filter((f) => f.status !== "removed").map((f) => f.filename);
    expect(groups.flat()).toEqual(kept);
    expect(groups.flat()).not.toContain("backend/old.py");
    const weight = (g: string[]) => baselineSplitLines(LARGE.filter((f) => g.includes(f.filename)));
    for (const g of groups) expect(weight(g)).toBeGreaterThan(0);
  });

  it(`never makes more than ${BASELINE_SPLIT_MAX_ROWS} rows, however large the change`, () => {
    const huge = Array.from({ length: 20 }, (_, i) =>
      file(`m${String(i).padStart(2, "0")}.py`, 1000),
    );
    const groups = baselineGroups(huge, 2000);
    expect(groups.length).toBe(BASELINE_SPLIT_MAX_ROWS);
    expect(groups.flat()).toEqual(huge.map((f) => f.filename));
    expect(groups.map((g) => g.length)).toEqual([7, 6, 7]);
  });

  it("a group under a quarter of its share is no row: it joins its neighbour", () => {
    // 4,400 lines ⇒ three shares of ~1,467; the lockfile alone would be one.
    expect(
      baselineGroups([file("a.py", 1500), file("yarn.lock", 900), file("b.py", 2900)], 2000),
    ).toEqual([["a.py", "yarn.lock"], ["b.py"]]);
    // 4,500 ⇒ shares of 1,500; a leading weightless group joins the next.
    expect(
      baselineGroups([file("yarn.lock", 900), file("a.py", 3000), file("b.py", 1500)], 2000),
    ).toEqual([["yarn.lock", "a.py"], ["b.py"]]);
    // A 100-line group beside a 4,100-line file is crumbs, not a reading.
    expect(
      baselineGroups([file("a.py", 100), file("b.py", 4100), file("c.py", 1500)], 2000),
    ).toEqual([["a.py", "b.py"], ["c.py"]]);
  });
});

describe("buildPassPlan with baseline_split_lines", () => {
  it("defaults to 2000 and refuses a value that is not a whole number >= 0", () => {
    expect(fixture.review.baseline_split_lines).toBe(2000);
    const toml = readFileSync(resolve(sandbox, "tests/fixtures/config.toml"), "utf8");
    const withKey = (v: string) =>
      toml.includes("[review]")
        ? toml.replace("[review]", `[review]\nbaseline_split_lines = ${v}`)
        : `${toml}\n[review]\nbaseline_split_lines = ${v}\n`;
    expect(parseConfig(withKey("0")).review.baseline_split_lines).toBe(0);
    expect(() => parseConfig(withKey("-1"))).toThrow(/baseline_split_lines/);
    expect(() => parseConfig(withKey("1.5"))).toThrow(/baseline_split_lines/);
  });

  it("at or under the threshold the plan is byte-identical to the unsplit plan", () => {
    const off = buildPassPlan(cfgAt(0), SMALL, undefined, NONE_ECOSYSTEM);
    const on = buildPassPlan(cfgAt(), SMALL, undefined, NONE_ECOSYSTEM);
    expect(JSON.stringify(on)).toBe(JSON.stringify(off));
    expect(on.pass_plan.filter((p) => p.lens === "pass-baseline")).toHaveLength(1);
    expect(on.pass_plan.some(isSplitBaselineRow)).toBe(false);
    expect(renderPassPlan(on.pass_plan)).toBe(renderPassPlan(off.pass_plan));
    // A large change with the knob at 0 is one row too.
    const large0 = buildPassPlan(cfgAt(0), LARGE, undefined, NONE_ECOSYSTEM);
    expect(large0.pass_plan.filter((p) => p.lens === "pass-baseline")).toHaveLength(1);
  });

  it("over the threshold: one baseline row per group, same agent, launched first; nothing else moves", () => {
    const off = buildPassPlan(cfgAt(0), LARGE, undefined, NONE_ECOSYSTEM);
    const on = buildPassPlan(cfgAt(), LARGE, undefined, NONE_ECOSYSTEM);
    const one = off.pass_plan.find((p) => p.lens === "pass-baseline")!;
    const rows = on.pass_plan.filter((p) => p.lens === "pass-baseline");
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.agent).toBe(one.agent);
      expect(r.tier).toBe(one.tier);
      expect(r.raisable_to).toEqual(one.raisable_to);
      expect(r.why).toMatch(/^pass-baseline split \d of 2: .*its charter stays whole$/);
      expect(isSplitBaselineRow(r)).toBe(true);
    }
    // Every file the PR keeps starts exactly one baseline row.
    expect(rows.flatMap((r) => r.focus!).sort()).toEqual(
      LARGE.filter((f) => f.status !== "removed")
        .map((f) => f.filename)
        .sort(),
    );
    // The baseline rows lead the launch order; the validator stays last.
    expect(on.pass_plan.slice(0, 2).every((p) => p.lens === "pass-baseline")).toBe(true);
    expect(on.pass_plan.at(-1)!.lens).toBe("pass-validate");
    // Every other row, and the addable list, are the unsplit plan's.
    expect(on.pass_plan.filter((p) => p.lens !== "pass-baseline")).toEqual(
      off.pass_plan.filter((p) => p.lens !== "pass-baseline"),
    );
    expect(on.addable_lenses).toEqual(off.addable_lenses);
    expect(on.sweep_unswept).toEqual(off.sweep_unswept);
  });

  it("a profile that switched pass-baseline off gets no rows back", () => {
    const cfg = cfgAt();
    cfg.lenses = { ...(cfg.lenses ?? {}), "pass-baseline": { enabled: false } };
    const plan = buildPassPlan(cfg, LARGE, undefined, NONE_ECOSYSTEM);
    expect(plan.pass_plan.some((p) => p.lens === "pass-baseline")).toBe(false);
  });
});

describe("what the session and each row are told", () => {
  const plan = buildPassPlan(cfgAt(), LARGE, undefined, NONE_ECOSYSTEM).pass_plan;

  it("the plan table: a starting point, never a bound, and one row per prior finding", () => {
    const text = renderPassPlan(plan);
    const baselineLines = text.split("\n").filter((l) => l.startsWith("| pass-baseline |"));
    expect(baselineLines).toHaveLength(2);
    for (const l of baselineLines) {
      expect(l).toContain("starts at: ");
      expect(l).toContain("its charter stays whole");
      expect(l).not.toContain("files: ");
    }
    expect(text).toContain("**pass-baseline is split into 2 rows**");
    expect(text).toContain("goes to exactly ONE of these rows");
    expect(text).toContain(
      "the row whose files hold the finding's path, else the first pass-baseline row",
    );
    // Sweep rows keep their exact-files cell.
    expect(text).toMatch(/\| pass-sweep \|.*\| files: /);
  });

  it("each baseline task says where it starts and that the whole PR is still its own", () => {
    const order = buildRoundOrder({
      cfg: cfgAt(),
      row: { number: 9, title: "Big change", head_sha: "abc" } as unknown as PrStateRow,
      files: LARGE,
      roundId: 1,
      roundNo: 1,
      roundType: "first",
      worktree: "/wt",
      settledDigest: "",
      issuedAt: "2026-10-09T00:00:00Z",
      ecosystem: NONE_ECOSYSTEM,
      prBody: "",
    });
    const rows = order.pass_plan.filter((p) => p.lens === "pass-baseline");
    expect(rows).toHaveLength(2);
    expect(order.lenses.filter((l) => l === "pass-baseline")).toHaveLength(1);
    for (const r of rows) {
      const task = renderPassTask(order, r, "");
      expect(task).toContain("**Where you start**");
      expect(task).toContain("The whole PR is still yours");
      expect(task).not.toContain("this pass covers exactly these changed files");
      for (const f of r.focus!) expect(task).toContain(`/wt/${f}`);
    }
    // A sweep row's task is unchanged: exactly its files.
    const sweep = order.pass_plan.find((p) => p.lens === "pass-sweep")!;
    expect(renderPassTask(order, sweep, "")).toContain(
      "this pass covers exactly these changed files",
    );
  });
});

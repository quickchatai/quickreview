// The main session sizes a follow-up round: a fixed line threshold is
// arbitrary, so the model decides whether the whole sweep is needed.
// Under `[review] follow_up_extent = "session"` every follow-up
// round plans the lean core and offers the full plan's sweep rows and
// quality/style lenses as OPTIONAL rows; an owed pre-approval sweep is the
// session's call, recorded `skipped` with a reason. `"rules"` keeps the fixed
// rules. These tests pin the plan split, the launch of optional rows, the
// rendered decision notes and how a skip is recorded.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { planLaunch } from "../extensions/subagents.js";
import { parseConfig, type Config } from "../src/config.js";
import {
  buildPassPlan,
  LEAN_ADDABLE_PASSES,
  optionalOrderOf,
  planFollowUp,
} from "../src/dispatch.js";
import { DJANGO_ECOSYSTEM } from "../src/ecosystem.js";
import type { PrFileEntry } from "../src/github.js";
import { SWEEP_PASS } from "../src/heuristics.js";
import { sweepStatusOf } from "../src/sweepstatus.js";
import {
  renderExtentNote,
  renderExtentVerdictNote,
  renderSweepDecisionNote,
} from "../src/templates.js";
import type { PassPlanEntry, RoundOrder } from "../src/types.js";
import { normalizeExtentClaim, normalizeSweepClaim, validateVerdict } from "../src/verdicts.js";
import type { PrOwnedDeltaFile } from "../src/worktrees.js";

const baseCfg: Config = parseConfig(
  readFileSync(resolve(process.cwd(), "tests/fixtures/config.toml"), "utf8"),
);
const withExtent = (extent: "session" | "rules"): Config => ({
  ...baseCfg,
  review: { ...baseCfg.review, follow_up_extent: extent },
});

const prFile = (filename: string, additions: number): PrFileEntry => ({
  filename,
  additions,
  deletions: 0,
  status: "modified",
  patch: `@@ -1 +1,${additions} @@\n${"+x = 1\n".repeat(additions)}`,
});
const deltaFile = (path: string, additions: number): PrOwnedDeltaFile => ({
  path,
  status: "modified",
  additions,
  deletions: 0,
  ranges: [[1, additions]],
  whole_file: false,
  patch: `@@ -1,0 +1,${additions} @@\n${"+y = 2\n".repeat(additions)}`,
});

/** A PR of 12 source files and a fix push touching 6 of them. */
function plan(cfg: Config, linesPerFile: number) {
  const files = Array.from({ length: 12 }, (_, i) => prFile(`app/m${i}.py`, 200));
  const dfiles = files.slice(0, 6).map((f) => deltaFile(f.filename, linesPerFile));
  const fullPlan = buildPassPlan(cfg, files, undefined, DJANGO_ECOSYSTEM);
  const r = planFollowUp(cfg, undefined, {
    delta: {
      ok: true,
      tree: "t".repeat(40),
      files: dfiles,
      lines: dfiles.reduce((n, f) => n + f.additions, 0),
      conflicted: [],
    },
    fromSha: "a".repeat(40),
    files,
    fullPlan,
    ecosystem: DJANGO_ECOSYSTEM,
    styleGuide: [],
    ciLinters: [],
    sweepOwed: () => true,
  });
  if (r.kind !== "delta") throw new Error(`expected a delta plan, got ${r.reason}`);
  return r.decision;
}

describe("the plan: a lean core and optional rows", () => {
  it('"session" (the default): the core always, the rest optional — whatever the delta size', () => {
    expect(baseCfg.review.follow_up_extent).toBe("session");
    for (const lines of [3, 60]) {
      const d = plan(baseCfg, lines); // 18 and 360 changed lines
      expect(d.plan.pass_plan.some((p) => p.lens === SWEEP_PASS)).toBe(false);
      expect(d.plan.pass_plan.some((p) => p.lens === "pass-baseline")).toBe(true);
      expect(d.plan.pass_plan.at(-1)!.lens).toBe("pass-validate");
      const optional = d.optionalPlan ?? [];
      expect(optional.length).toBeGreaterThan(0);
      for (const p of optional)
        expect(p.lens === SWEEP_PASS || LEAN_ADDABLE_PASSES.includes(p.lens), p.lens).toBe(true);
      // An optional lens is never also on the add list.
      for (const p of optional) expect(d.plan.addable_lenses).not.toContain(p.lens);
    }
  });

  it('"rules": the 150-line rule, no optional rows', () => {
    const small = plan(withExtent("rules"), 3);
    expect(small.optionalPlan).toBeUndefined();
    expect(small.plan.pass_plan.some((p) => p.lens === SWEEP_PASS)).toBe(false);
    const big = plan(withExtent("rules"), 60);
    expect(big.optionalPlan).toBeUndefined();
    expect(big.plan.pass_plan.some((p) => p.lens === SWEEP_PASS)).toBe(true);
  });

  it("the optional rows' order keeps the change as their scope and carries no prior findings", () => {
    const rows: PassPlanEntry[] = [
      {
        lens: SWEEP_PASS,
        agent: "pass-sweep--sol-high",
        tier: "sol-high",
        raisable_to: [],
        focus: ["a.py"],
      },
    ];
    const order = {
      scope: "delta",
      pass_plan: [],
      lenses: [],
      prior_assignments: [{ row: 0, priors: [] }],
      optional_plan: rows,
    } as unknown as RoundOrder;
    const o = optionalOrderOf(order, rows);
    expect(o.scope).toBe("delta");
    expect(o.pass_plan).toBe(rows);
    expect(o.lenses).toEqual([SWEEP_PASS]);
    expect(o.prior_assignments).toBeUndefined();
    expect(o.optional_plan).toBeUndefined();
  });

  it("refuses an unknown setting", () => {
    const text = readFileSync(resolve(process.cwd(), "tests/fixtures/config.toml"), "utf8");
    expect(() =>
      parseConfig(text.replace("[review]\n", '[review]\nfollow_up_extent = "model"\n')),
    ).toThrow(/follow_up_extent/);
  });
});

describe("the session's decision notes", () => {
  const rows: PassPlanEntry[] = [
    {
      lens: SWEEP_PASS,
      agent: "pass-sweep--sol-high",
      tier: "sol-high",
      raisable_to: [],
      focus: ["a.py", "b.py"],
    },
    {
      lens: "pass-duplication",
      agent: "pass-duplication--sol-med",
      tier: "sol-med",
      raisable_to: [],
      why: "new code",
    },
  ];
  const base = {
    follow_up_extent: "session" as const,
    worktree: "/w",
    optional_plan: rows,
    optional_task_files: [
      {
        row: 0,
        agent: "pass-sweep--sol-high",
        path: "/s/p/tasks-optional/01-pass-sweep--sol-high.md",
      },
      {
        row: 1,
        agent: "pass-duplication--sol-med",
        path: "/s/p/tasks-optional/02-pass-duplication--sol-med.md",
      },
    ],
    sweep_plan: rows,
  };

  it("step 2 offers the optional rows with the rule and the launch", () => {
    const note = renderExtentNote(base);
    expect(note).toContain("OPTIONAL ROWS — your decision this round");
    expect(note).toContain("**a targeted fix**");
    expect(note).toContain("**in doubt**, run them");
    expect(note).toContain("`/s/p/tasks-optional`");
    expect(note).toContain("`optional:<row>`");
    expect(note).toContain("| optional:1 | `pass-sweep--sol-high` | `a.py`, `b.py` |");
    expect(note).toContain("| optional:2 | `pass-duplication--sol-med` | new code |");
  });

  // Focus paths and reasons are DATA in a table cell: a pipe, a backtick or a
  // newline cannot split the row or open a line of prompt.
  // MUTATION: render a focus path as a bare one-backtick span — red.
  it("keeps author-controlled focus paths and reasons inside their cell", () => {
    const note = renderExtentNote({
      ...base,
      optional_plan: [
        { ...rows[0]!, focus: ["src/a|b.py", "c`d.py"] },
        { ...rows[1]!, why: "x|y\nz" },
      ],
    });
    expect(note).toContain(
      "| optional:1 | `pass-sweep--sol-high` | `src/a\\|b.py`, `` c`d.py `` |",
    );
    expect(note).toContain("| optional:2 | `pass-duplication--sol-med` | x\\|y\\u000az |");
  });

  it("step 4b makes the owed sweep the session's call; step 7 names the fields", () => {
    expect(renderSweepDecisionNote(base)).toContain("whether the full sweep runs is your decision");
    expect(renderSweepDecisionNote(base)).toContain("or when in doubt");
    const v = renderExtentVerdictNote(base);
    expect(v).toContain("`extent`");
    expect(v).toContain('`sweep` may also be `"skipped"`');
  });

  it("render nothing under the rules, or with nothing to decide", () => {
    const rules = { ...base, follow_up_extent: undefined };
    expect(renderExtentNote(rules)).toBe("");
    expect(renderSweepDecisionNote(rules)).toBe("");
    expect(renderExtentVerdictNote(rules)).toBe("");
    expect(renderExtentNote({ ...base, optional_plan: [] })).toBe("");
    expect(renderSweepDecisionNote({ ...base, sweep_plan: [] })).toBe("");
    expect(renderExtentVerdictNote({ ...base, optional_plan: [], sweep_plan: [] })).toBe("");
  });
});

describe("a skipped sweep and the extent are recorded, never an anomaly", () => {
  it("parses `skipped`, the extent, and the reasons", () => {
    expect(normalizeSweepClaim("Skipped")).toBe("skipped");
    expect(normalizeExtentClaim("PARTIAL")).toBe("partial");
    expect(normalizeExtentClaim("some")).toBeNull();
    const v = validateVerdict({
      pr: 7,
      round_no: 3,
      verdict: "APPROVE",
      head_sha: "h",
      finished_at: "2026-10-09T00:00:00Z",
      sweep: "skipped",
      sweep_reason: "a two-line fix of the one open finding",
      extent: "skipped",
      extent_reason: "targeted fix",
    });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.verdict!.sweep).toBe("skipped");
      expect(v.verdict!.extent).toBe("skipped");
      expect(v.verdict!.sweep_reason).toContain("two-line fix");
    }
  });

  it("an owed sweep the session skipped is `skipped`, not unknown — and never a full look", () => {
    expect(
      sweepStatusOf({
        owed: true,
        claim: "skipped",
        sweepPasses: 0,
        receiptSettled: false,
        verdict: "APPROVE",
      }),
    ).toEqual({ status: "skipped" });
    // A claim the telemetry contradicts stays unknown.
    expect(
      sweepStatusOf({
        owed: true,
        claim: "skipped",
        sweepPasses: 3,
        receiptSettled: false,
        verdict: "APPROVE",
      }).status,
    ).toBe("unknown");
    // An approval with no claim at all is still unknown (the anomaly's case).
    expect(
      sweepStatusOf({
        owed: true,
        claim: null,
        sweepPasses: 0,
        receiptSettled: false,
        verdict: "APPROVE",
      }).status,
    ).toBe("unknown");
  });
});

describe("launch_plan launches optional rows from their own directory", () => {
  it("plan rows first, then the optional ones; `optional:<row>` skips one", () => {
    const root = mkdtempSync(join(tmpdir(), "qcr-extent-"));
    try {
      const passes = join(root, "state", "pr-7-round-3-passes");
      const put = (dir: string, f: string) => {
        mkdirSync(join(passes, dir), { recursive: true });
        writeFileSync(join(passes, dir, f), `# ${f}\n`);
      };
      put("tasks", "01-pass-baseline--sol-high.md");
      put("tasks-optional", "01-pass-sweep--sol-high.md");
      put("tasks-optional", "02-pass-duplication--sol-med.md");
      const r = planLaunch(
        {
          dirs: [join(passes, "tasks-optional"), join(passes, "tasks")],
          skip: ["optional:2"],
        },
        { QCR_SANDBOX_ROOT: root, QCR_PR: "7" },
      );
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.units.map((u) => `${u.phase}:${u.agent}`)).toEqual([
          "plan:pass-baseline--sol-high",
          "optional:pass-sweep--sol-high",
        ]);
        expect(r.skipped.map((u) => u.agent)).toEqual(["pass-duplication--sol-med"]);
      }
      // Another PR's optional dir is refused.
      const other = planLaunch(
        { dirs: [join(passes, "tasks-optional")] },
        { QCR_SANDBOX_ROOT: root, QCR_PR: "8" },
      );
      expect(other.ok).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

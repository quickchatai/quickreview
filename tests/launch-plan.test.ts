// `planLaunch` (packages/pi-plugin/src/engine/lens/launch-plan.ts), the one-turn discovery launch
// made structural: which discovery task files a launch covers. These tests pin
// every discovery row in order, the validator never, the path confinement
// (sanctioned task dirs only, symlinks resolved), the per-row extra text and
// skip, and that a bad dir is an error RESULT — never a throw, never a launch.
// (The tool around it is the engine's `lens_wave`; tests/lens-tool.test.ts.)
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LAUNCH_PLAN_DIRS_ENV,
  planLaunch,
  taskPointer,
} from "@quickchatai/pi-quickreview/src/engine/lens/launch-plan.js";

let root: string;
let passes: string;
let tasks: string;
let sweep: string;

function write(dir: string, file: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), `# task ${file}\n`);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "qcr-launch-plan-"));
  passes = join(root, "state", "pr-5894-round-2-passes");
  tasks = join(passes, "tasks");
  sweep = join(passes, "tasks-sweep");
  write(tasks, "01-pass-baseline--sol-high.md");
  write(tasks, "02-pass-data-safety--sol-high.md");
  write(tasks, "03-pass-sweep--sol-med.md");
  write(tasks, "04-pass-sweep--sol-med.md");
  write(tasks, "05-pass-validate--sol-med.md"); // never written by dispatch; a belt
  writeFileSync(join(tasks, "notes.txt"), "not a task");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("planLaunch", () => {
  const plan = (params: Record<string, unknown>, env?: Record<string, string>) =>
    planLaunch(params, env ?? { QCR_SANDBOX_ROOT: root });
  const units = (params: Record<string, unknown>) => {
    const p = plan(params);
    if (!p.ok) throw new Error(p.error);
    return p.units;
  };

  it("covers every discovery row, in row order, with the template pointer", () => {
    const u = units({ dirs: [tasks] });
    expect(u.map((x) => x.agent)).toEqual([
      "pass-baseline--sol-high",
      "pass-data-safety--sol-high",
      "pass-sweep--sol-med",
      "pass-sweep--sol-med",
    ]);
    expect(u[0]!.task).toBe(taskPointer(join(tasks, "01-pass-baseline--sol-high.md")));
    expect(u[0]!.task).toBe(
      `Task file: ${join(tasks, "01-pass-baseline--sol-high.md")}. Read it first; it is your complete task.`,
    );
  });

  it("never covers the validator", () => {
    expect(units({ dirs: [tasks] }).some((x) => x.agent.startsWith("pass-validate"))).toBe(false);
  });

  it("takes the round's pass dir as its tasks dir", () => {
    expect(units({ dirs: [passes] })).toHaveLength(4);
  });

  it("given both of a round's dirs, covers them in one plan: plan rows first, then the sweep's", () => {
    write(sweep, "01-pass-baseline--sol-high.md");
    write(sweep, "02-pass-security--sol-high.md");
    const u = units({
      dirs: [sweep, tasks],
      extra: { "sweep:*": "Do not re-raise: X at a.py:3." },
    });
    expect(u).toHaveLength(6);
    expect(u[4]!.task).toBe(
      `${taskPointer(join(sweep, "01-pass-baseline--sol-high.md"))}\n\nDo not re-raise: X at a.py:3.`,
    );
    expect(u[0]!.task).toBe(taskPointer(join(tasks, "01-pass-baseline--sol-high.md")));
  });

  it("covers a late sweep dir alone", () => {
    write(sweep, "01-pass-baseline--sol-high.md");
    const p = plan({ dirs: [sweep] });
    expect(p.ok && p.units.map((u) => [u.phase, u.row])).toEqual([["sweep", 1]]);
  });

  it("appends extra text keyed by row, file or agent — after the pointer", () => {
    const t = units({
      dirs: [tasks],
      extra: {
        "2": "Verify first: F1 migrations/0042.py:10 (round 1).",
        "pass-sweep--sol-med": "Also look at the retry loop.",
        "01-pass-baseline--sol-high.md": "Site: api/views.py:88.",
      },
    });
    expect(t[1]!.task).toBe(
      `${taskPointer(join(tasks, "02-pass-data-safety--sol-high.md"))}\n\nVerify first: F1 migrations/0042.py:10 (round 1).`,
    );
    expect(t[2]!.task.endsWith("Also look at the retry loop.")).toBe(true);
    expect(t[3]!.task.endsWith("Also look at the retry loop.")).toBe(true);
    expect(t[0]!.task.endsWith("Site: api/views.py:88.")).toBe(true);
  });

  it("skips a raised row (launched by hand at the higher tier) and reports it", () => {
    const p = plan({ dirs: [tasks], skip: ["2"] });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.units.map((t) => t.agent)).not.toContain("pass-data-safety--sol-high");
    expect(p.units).toHaveLength(3);
    expect(p.skipped.map((u) => [u.phase, u.row, u.agent])).toEqual([
      ["plan", 2, "pass-data-safety--sol-high"],
    ]);
  });

  it("refuses a key that answers to no row, planning nothing", () => {
    for (const params of [
      { dirs: [tasks], extra: { "7": "x" } },
      { dirs: [tasks], skip: ["pass-nope--sol-med"] },
      { dirs: [tasks], skip: ["*"] },
    ])
      expect(plan(params).ok, JSON.stringify(params)).toBe(false);
  });

  describe("path confinement", () => {
    const refused = (params: Record<string, unknown>, env?: Record<string, string>): string => {
      const p = plan(params, env);
      expect(p.ok).toBe(false);
      return p.ok ? "" : p.error;
    };

    it("an absent dir is an error result, not a throw", () => {
      const text = refused({ dirs: [join(passes, "..", "pr-1-round-1-passes", "tasks")] });
      expect(text).toContain("no such directory");
    });

    it("refuses a dir outside the round's task dirs", () => {
      const elsewhere = join(root, "elsewhere", "tasks");
      write(elsewhere, "01-pass-baseline--sol-high.md");
      refused({ dirs: [elsewhere] });
      refused({ dirs: [join(root, "state")] });
      // A task dir of another sandbox root is not this session's.
      const other = mkdtempSync(join(tmpdir(), "qcr-launch-plan-other-"));
      try {
        const foreign = join(other, "state", "pr-1-round-1-passes", "tasks");
        write(foreign, "01-pass-baseline--sol-high.md");
        refused({ dirs: [foreign] });
      } finally {
        rmSync(other, { recursive: true, force: true });
      }
    });

    it("resolves symlinks before judging a path", () => {
      const outside = join(root, "outside");
      write(outside, "01-pass-baseline--sol-high.md");
      // A sanctioned-LOOKING path that is a symlink to elsewhere is refused…
      const fake = join(root, "state", "pr-9-round-1-passes");
      mkdirSync(fake, { recursive: true });
      symlinkSync(outside, join(fake, "tasks"));
      refused({ dirs: [join(fake, "tasks")] });
      refused({ dirs: [fake] });
      // …and a symlinked task FILE inside a real task dir is never followed.
      symlinkSync(
        join(outside, "01-pass-baseline--sol-high.md"),
        join(tasks, "09-pass-evil--sol-med.md"),
      );
      const plan = planLaunch({ dirs: [tasks] }, { QCR_SANDBOX_ROOT: root });
      expect(plan.ok && plan.units.map((u) => u.agent)).not.toContain("pass-evil--sol-med");
    });

    it("accepts a round whose state dir is a symlink, as on the VM (state → the state volume)", () => {
      const vm = mkdtempSync(join(tmpdir(), "qcr-launch-plan-vm-"));
      try {
        const volume = join(vm, "state-volume");
        const sandbox = join(vm, "sandbox");
        const vmTasks = join(volume, "pr-5-round-2-passes", "tasks");
        write(vmTasks, "01-pass-baseline--sol-high.md");
        mkdirSync(sandbox, { recursive: true });
        symlinkSync(volume, join(sandbox, "state"));
        for (const dirs of [
          [join(sandbox, "state", "pr-5-round-2-passes", "tasks")],
          ["state/pr-5-round-2-passes"],
        ]) {
          const plan = planLaunch({ dirs }, { QCR_SANDBOX_ROOT: sandbox });
          expect(plan.ok && plan.units.map((u) => u.agent)).toEqual(["pass-baseline--sol-high"]);
        }
      } finally {
        rmSync(vm, { recursive: true, force: true });
      }
    });

    it("a PR session launches only its own PR's rounds", () => {
      expect(planLaunch({ dirs: [tasks] }, { QCR_SANDBOX_ROOT: root, QCR_PR: "1" }).ok).toBe(false);
      const own = /pr-(\d+)-round-/.exec(tasks)![1]!;
      expect(planLaunch({ dirs: [tasks] }, { QCR_SANDBOX_ROOT: root, QCR_PR: own }).ok).toBe(true);
    });

    it("refuses two dirs of different rounds, or two plan dirs", () => {
      const other = join(root, "state", "pr-5894-round-3-passes", "tasks-sweep");
      write(other, "01-pass-baseline--sol-high.md");
      refused({ dirs: [tasks, other] });
      const otherPlan = join(root, "state", "pr-5894-round-3-passes", "tasks");
      write(otherPlan, "01-pass-baseline--sol-high.md");
      refused({ dirs: [tasks, otherPlan] });
      refused({ dirs: [tasks, sweep, tasks] });
    });

    it("refuses a dir with no discovery task files, and missing dirs", () => {
      const empty = join(root, "state", "pr-2-round-1-passes", "tasks");
      mkdirSync(empty, { recursive: true });
      write(empty, "01-pass-validate--sol-med.md");
      expect(refused({ dirs: [empty] })).toContain("no discovery task files");
      refused({});
      refused({ dirs: [] });
    });

    it("accepts the bench's case dirs only when the environment names them exactly", () => {
      const caseTasks = join(root, "out", "cases", "c1", "tasks");
      write(caseTasks, "01-pass-baseline--sol-high.md");
      refused({ dirs: [caseTasks] });
      const plan = planLaunch(
        { dirs: [caseTasks] },
        { QCR_SANDBOX_ROOT: root, [LAUNCH_PLAN_DIRS_ENV]: caseTasks },
      );
      expect(plan.ok && plan.units.map((u) => u.agent)).toEqual(["pass-baseline--sol-high"]);
    });
  });
});

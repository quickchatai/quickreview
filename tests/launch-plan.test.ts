// `launch_plan`, the one-turn discovery launch made structural.
//
// Left to itself the main session may launch lenses one per turn, or launch
// pass-baseline alone and wait. `launch_plan` (in the subagents glue)
// launches every discovery task file of the round in one
// call through the subagent tool's own wrapped execute. These tests pin, over
// a fake native execute: every discovery row in one execute call, the
// validator never, the path confinement (sanctioned task dirs only, symlinks
// resolved), the per-row extra text, and that a bad dir is an error RESULT —
// never a throw, never a launch.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LAUNCH_PLAN_DIRS_ENV,
  LAUNCH_PLAN_TOOL,
  WIDE_FANOUT_ENV,
  WeightedSemaphore,
  launchPlanDefinition,
  launchPlanExecute,
  planLaunch,
  taskPointer,
  wrapExecute,
} from "../extensions/subagents.js";

type Task = { agent: string; task: string };
type Call = { tasks: Task[]; params: Record<string, unknown> };

let root: string;
let passes: string;
let tasks: string;
let sweep: string;

function write(dir: string, file: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), `# task ${file}\n`);
}

/** A fake native subagent execute: records each call, answers the parallel
 * result shape (one result per task, in order). */
function fakeNative(calls: Call[]) {
  return (async (_id: string, params: Record<string, unknown>) => {
    const t = (params.tasks as Task[]) ?? [];
    calls.push({ tasks: t, params });
    return {
      content: [{ type: "text", text: t.map((x) => `${x.agent}: NONE`).join("\n") }],
      details: {
        mode: "parallel",
        results: t.map((x) => ({ agent: x.agent, task: x.task, exitCode: 0 })),
      },
    };
  }) as unknown as Parameters<typeof wrapExecute>[0];
}

function tool(calls: Call[], env: Record<string, string | undefined>, permits = 8) {
  const wrapped = wrapExecute(fakeNative(calls), new WeightedSemaphore(permits), env);
  return launchPlanExecute(wrapped, env);
}

type Result = {
  content: Array<{ text: string }>;
  details: Record<string, unknown> & { results?: Array<{ agent: string }> };
  isError?: boolean;
};

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

describe("launch_plan", () => {
  it("launches every discovery row in ONE native call, in row order, with the template pointer", async () => {
    const calls: Call[] = [];
    const env = { QCR_SANDBOX_ROOT: root };
    const r = (await tool(calls, env)("id", { dirs: [tasks] })) as unknown as Result;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.tasks.map((t) => t.agent)).toEqual([
      "pass-baseline--sol-high",
      "pass-data-safety--sol-high",
      "pass-sweep--sol-med",
      "pass-sweep--sol-med",
    ]);
    expect(calls[0]!.tasks[0]!.task).toBe(
      taskPointer(join(tasks, "01-pass-baseline--sol-high.md")),
    );
    expect(calls[0]!.tasks[0]!.task).toBe(
      `Task file: ${join(tasks, "01-pass-baseline--sol-high.md")}. Read it first; it is your complete task.`,
    );
    // The same rendered result the subagent tool returns.
    expect(r.isError).toBeUndefined();
    expect(r.content[0]!.text).toContain("pass-baseline--sol-high: NONE");
    expect(r.details.results).toHaveLength(4);
  });

  it("never launches the validator", async () => {
    const calls: Call[] = [];
    await tool(calls, { QCR_SANDBOX_ROOT: root })("id", { dirs: [tasks] });
    expect(calls.flatMap((c) => c.tasks).some((t) => t.agent.startsWith("pass-validate"))).toBe(
      false,
    );
  });

  it("stays ONE logical launch under the wide fan-out (chunks run concurrently, all rows once)", async () => {
    for (let i = 6; i <= 14; i++)
      write(tasks, `${String(i).padStart(2, "0")}-pass-x${i}--sol-med.md`);
    const calls: Call[] = [];
    const env = { QCR_SANDBOX_ROOT: root, [WIDE_FANOUT_ENV]: "1" };
    const r = (await tool(calls, env)("id", { dirs: [tasks] })) as unknown as Result;
    expect(calls.flatMap((c) => c.tasks)).toHaveLength(13);
    expect(r.details.results).toHaveLength(13);
  });

  it("takes the round's pass dir as its tasks dir", async () => {
    const calls: Call[] = [];
    await tool(calls, { QCR_SANDBOX_ROOT: root })("id", { dirs: [passes] });
    expect(calls[0]!.tasks).toHaveLength(4);
  });

  it("given both of a round's dirs, launches them in one call: plan rows first, then the sweep's", async () => {
    write(sweep, "01-pass-baseline--sol-high.md");
    write(sweep, "02-pass-security--sol-high.md");
    const calls: Call[] = [];
    await tool(calls, { QCR_SANDBOX_ROOT: root })("id", {
      dirs: [sweep, tasks],
      extra: { "sweep:*": "Do not re-raise: X at a.py:3." },
    });
    expect(calls).toHaveLength(1);
    const t = calls[0]!.tasks;
    expect(t).toHaveLength(6);
    expect(t[4]!.task).toBe(
      `${taskPointer(join(sweep, "01-pass-baseline--sol-high.md"))}\n\nDo not re-raise: X at a.py:3.`,
    );
    expect(t[0]!.task).toBe(taskPointer(join(tasks, "01-pass-baseline--sol-high.md")));
  });

  it("launches a late sweep dir alone", async () => {
    write(sweep, "01-pass-baseline--sol-high.md");
    const plan = planLaunch({ dirs: [sweep] }, { QCR_SANDBOX_ROOT: root });
    expect(plan.ok && plan.units.map((u) => [u.phase, u.row])).toEqual([["sweep", 1]]);
  });

  it("appends extra text keyed by row, file or agent — after the pointer", async () => {
    const calls: Call[] = [];
    await tool(calls, { QCR_SANDBOX_ROOT: root })("id", {
      dirs: [tasks],
      extra: {
        "2": "Verify first: F1 migrations/0042.py:10 (round 1).",
        "pass-sweep--sol-med": "Also look at the retry loop.",
        "01-pass-baseline--sol-high.md": "Site: api/views.py:88.",
      },
    });
    const t = calls[0]!.tasks;
    expect(t[1]!.task).toBe(
      `${taskPointer(join(tasks, "02-pass-data-safety--sol-high.md"))}\n\nVerify first: F1 migrations/0042.py:10 (round 1).`,
    );
    expect(t[2]!.task.endsWith("Also look at the retry loop.")).toBe(true);
    expect(t[3]!.task.endsWith("Also look at the retry loop.")).toBe(true);
    expect(t[0]!.task.endsWith("Site: api/views.py:88.")).toBe(true);
  });

  it("skips a raised row (launched by hand at the higher tier) and reports it", async () => {
    const calls: Call[] = [];
    const r = (await tool(calls, { QCR_SANDBOX_ROOT: root })("id", {
      dirs: [tasks],
      skip: ["2"],
    })) as unknown as Result;
    expect(calls[0]!.tasks.map((t) => t.agent)).not.toContain("pass-data-safety--sol-high");
    expect(calls[0]!.tasks).toHaveLength(3);
    expect(r.details.launch_plan).toMatchObject({
      skipped: [{ phase: "plan", row: 2, agent: "pass-data-safety--sol-high" }],
    });
  });

  it("refuses a key that answers to no row, launching nothing", async () => {
    const calls: Call[] = [];
    const t = tool(calls, { QCR_SANDBOX_ROOT: root });
    for (const params of [
      { dirs: [tasks], extra: { "7": "x" } },
      { dirs: [tasks], skip: ["pass-nope--sol-med"] },
      { dirs: [tasks], skip: ["*"] },
    ]) {
      const r = (await t("id", params)) as unknown as Result;
      expect(r.isError, JSON.stringify(params)).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });

  describe("path confinement", () => {
    const refused = async (params: Record<string, unknown>, env?: Record<string, string>) => {
      const calls: Call[] = [];
      const r = (await tool(calls, env ?? { QCR_SANDBOX_ROOT: root })(
        "id",
        params,
      )) as unknown as Result;
      expect(calls).toHaveLength(0);
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(/^launch_plan: .*Nothing was launched/s);
      return r.content[0]!.text;
    };

    it("an absent dir is an error result, not a throw", async () => {
      const text = await refused({ dirs: [join(passes, "..", "pr-1-round-1-passes", "tasks")] });
      expect(text).toContain("no such directory");
    });

    it("refuses a dir outside the round's task dirs", async () => {
      const elsewhere = join(root, "elsewhere", "tasks");
      write(elsewhere, "01-pass-baseline--sol-high.md");
      await refused({ dirs: [elsewhere] });
      await refused({ dirs: [join(root, "state")] });
      // A task dir of another sandbox root is not this session's.
      const other = mkdtempSync(join(tmpdir(), "qcr-launch-plan-other-"));
      try {
        const foreign = join(other, "state", "pr-1-round-1-passes", "tasks");
        write(foreign, "01-pass-baseline--sol-high.md");
        await refused({ dirs: [foreign] });
      } finally {
        rmSync(other, { recursive: true, force: true });
      }
    });

    it("resolves symlinks before judging a path", async () => {
      const outside = join(root, "outside");
      write(outside, "01-pass-baseline--sol-high.md");
      // A sanctioned-LOOKING path that is a symlink to elsewhere is refused…
      const fake = join(root, "state", "pr-9-round-1-passes");
      mkdirSync(fake, { recursive: true });
      symlinkSync(outside, join(fake, "tasks"));
      await refused({ dirs: [join(fake, "tasks")] });
      await refused({ dirs: [fake] });
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

    it("refuses two dirs of different rounds, or two plan dirs", async () => {
      const other = join(root, "state", "pr-5894-round-3-passes", "tasks-sweep");
      write(other, "01-pass-baseline--sol-high.md");
      await refused({ dirs: [tasks, other] });
      const otherPlan = join(root, "state", "pr-5894-round-3-passes", "tasks");
      write(otherPlan, "01-pass-baseline--sol-high.md");
      await refused({ dirs: [tasks, otherPlan] });
      await refused({ dirs: [tasks, sweep, tasks] });
    });

    it("refuses a dir with no discovery task files, and missing dirs", async () => {
      const empty = join(root, "state", "pr-2-round-1-passes", "tasks");
      mkdirSync(empty, { recursive: true });
      write(empty, "01-pass-validate--sol-med.md");
      expect(await refused({ dirs: [empty] })).toContain("no discovery task files");
      await refused({});
      await refused({ dirs: [] });
    });

    it("accepts the bench's case dirs only when the environment names them exactly", async () => {
      const caseTasks = join(root, "out", "cases", "c1", "tasks");
      write(caseTasks, "01-pass-baseline--sol-high.md");
      await refused({ dirs: [caseTasks] });
      const plan = planLaunch(
        { dirs: [caseTasks] },
        { QCR_SANDBOX_ROOT: root, [LAUNCH_PLAN_DIRS_ENV]: caseTasks },
      );
      expect(plan.ok && plan.units.map((u) => u.agent)).toEqual(["pass-baseline--sol-high"]);
    });
  });

  it("is registered as a tool definition over the wrapped execute", () => {
    const def = launchPlanDefinition(wrapExecute(fakeNative([]), new WeightedSemaphore(4), {}), {});
    expect(def.name).toBe(LAUNCH_PLAN_TOOL);
    expect(def.name).toBe("launch_plan");
    expect((def.parameters as { required: string[] }).required).toEqual(["dirs"]);
    // No cwd and no agent parameter: the units are the dir's files.
    const props = Object.keys((def.parameters as { properties: object }).properties);
    expect(props.sort()).toEqual(["dirs", "extra", "skip"]);
  });
});

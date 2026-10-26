// Switch-on's steps (src/home/switchon.ts): the wizard's own step modules on
// the plugin's step registry, run in the stated order with silent defaults,
// and the person's one confirm reaching the go-live step and nothing else —
// so `dry_run` moves only through goLiveStep (invariant 6).
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SetupChecklist,
  StepRegistry,
  type ChecklistAdapters,
  type SetupStep,
} from "@quickchatai/pi-quickreview/src/setupchecklist.js";
import {
  DAEMON_START_STEP_ID,
  MACHINE_CHECKS_STEP_ID,
  SWITCH_ON_ORDER,
  daemonStartStep,
  freeGbFromDf,
  machineChecksStep,
  runGoLive,
  runSwitchOn,
  switchOnInput,
  switchOnRegistry,
} from "../src/home/switchon.js";
import type { OnboardAdapters, ProcessResult } from "../src/onboard/engine.js";
import { BROUGHT_UP_CHOICE_KEY } from "../src/onboard/steps/bringup.js";
import { GO_LIVE_CONFIRMATION, GO_LIVE_STEP_ID, goLiveStep } from "../src/onboard/steps/golive.js";

const CLOCK = (): Date => new Date("2026-10-26T12:00:00Z");

interface Ran {
  id: string;
  input: Record<string, unknown>;
}

/** Steps with switch-on's ids that record what they were handed. */
function fakeSteps(
  ran: Ran[],
  o: { fail?: string; refuseGoLive?: boolean; disabled?: string[] } = {},
): SetupStep<ChecklistAdapters>[] {
  return SWITCH_ON_ORDER.map((id, i) => ({
    id,
    title: `step ${id}`,
    explain: "",
    order: (i + 1) * 10,
    ...(o.disabled?.includes(id) ? { enabled: () => false } : {}),
    run: async (ctx) => {
      ran.push({ id, input: { ...ctx.input } });
      if (id === o.fail)
        return { ok: false, checks: [{ name: id, ok: false, detail: "it broke" }] };
      if (id === GO_LIVE_STEP_ID && o.refuseGoLive)
        return {
          ok: false,
          checks: [{ name: "proof", ok: false, detail: "there is no completed proof round" }],
        };
      return { ok: true, checks: [{ name: id, ok: true, detail: `${id} ok` }] };
    },
    verify: async () => ({ ok: true, checks: [] }),
  }));
}

function checklistOver(steps: SetupStep<ChecklistAdapters>[]): SetupChecklist<ChecklistAdapters> {
  return new SetupChecklist(new StepRegistry(steps), { clock: CLOCK }, { file: null });
}

const stopped = async () => ({ ok: true as const, detail: "memory stopped" });

describe("switch-on's registry", () => {
  // MUTATION: register the go-live before bring-up, or drop the machine checks — this fails.
  it("is the wizard's steps in the stated order, machine checks first and the go-live last", () => {
    expect(
      switchOnRegistry()
        .steps()
        .map((s) => s.id),
    ).toEqual([...SWITCH_ON_ORDER]);
    expect(SWITCH_ON_ORDER[0]).toBe(MACHINE_CHECKS_STEP_ID);
    expect(SWITCH_ON_ORDER[SWITCH_ON_ORDER.length - 1]).toBe(GO_LIVE_STEP_ID);
  });

  it("its go-live is the wizard's own goLiveStep, not a copy", () => {
    const go = switchOnRegistry()
      .steps()
      .find((s) => s.id === GO_LIVE_STEP_ID)!;
    const wizard = goLiveStep();
    expect(go.title).toBe(wizard.title);
    expect(go.explain).toBe(wizard.explain);
    expect(go.order).toBe(wizard.order);
  });
});

describe("the one confirm reaches the go-live step and nothing else", () => {
  // MUTATION: hand { confirm: GO_LIVE_CONFIRMATION } to any other step in switchOnInput — this fails.
  it("no step but go_live is ever handed the confirm, and go_live only on the person's yes", () => {
    for (const id of SWITCH_ON_ORDER) {
      const input = switchOnInput(id, { answers: { memory: true, confirmed: true }, repo: "a/b" });
      if (id === GO_LIVE_STEP_ID)
        expect(input).toEqual({ decision: "go_live", confirm: GO_LIVE_CONFIRMATION });
      else expect(JSON.stringify(input)).not.toContain(GO_LIVE_CONFIRMATION);
    }
    expect(
      switchOnInput(GO_LIVE_STEP_ID, { answers: { memory: null, confirmed: false }, repo: null }),
    ).toEqual({});
  });

  it("refuses to run at all without the confirm", async () => {
    const ran: Ran[] = [];
    await expect(
      runSwitchOn({
        checklist: checklistOver(fakeSteps(ran)),
        answers: { memory: null, confirmed: false as unknown as true },
        repo: null,
        dryRun: () => true,
        stopMemory: stopped,
      }),
    ).rejects.toThrow(/confirm/);
    expect(ran).toEqual([]);
  });
});

describe("the home writes no config of its own", () => {
  // MUTATION: call flipDryRunToFalse, or patchToml with key "dry_run", from
  // any file under src/home/ — this fails.
  it("no module of the home builds a dry_run edit or patches config.toml", () => {
    const dir = join(process.cwd(), "src", "home");
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    expect(files).toContain("switchon.ts");
    for (const f of files) {
      const text = readFileSync(join(dir, f), "utf8");
      expect(text, `${f} must not edit dry_run`).not.toMatch(/key:\s*"dry_run"/);
      expect(text, `${f} must not flip dry_run itself`).not.toMatch(/flipDryRunToFalse\s*\(/);
      expect(text, `${f} must not patch config.toml`).not.toMatch(/patchToml\s*\(/);
    }
  });
});

describe("running switch-on", () => {
  it("runs every step after the machine checks in order, with the silent defaults", async () => {
    const ran: Ran[] = [];
    const out = await runSwitchOn({
      checklist: checklistOver(fakeSteps(ran)),
      answers: { memory: false, confirmed: true },
      repo: "acme/widgets",
      dryRun: () => true,
      stopMemory: stopped,
    });
    expect(ran.map((r) => r.id)).toEqual(SWITCH_ON_ORDER.slice(1));
    const input = (id: string) => ran.find((r) => r.id === id)!.input;
    expect(input("topology")).toEqual({ choice: "local" });
    expect(input("github_account")).toEqual({ github_auth: "user", repo: "acme/widgets" });
    expect(input("escalation")).toEqual({ enable: "no" });
    expect(input("embeddings")).toEqual({});
    expect(input("ingress")).toEqual({ choice: "polling" });
    expect(input("memory")).toEqual({ choice: "declined" });
    expect(input(GO_LIVE_STEP_ID)).toEqual({ decision: "go_live", confirm: GO_LIVE_CONFIRMATION });
    expect(out).toMatchObject({ ok: true, live: true });
    expect(out.steps).toContain("memory: kept off");
  });

  it("stops at the first step that fails, and never reaches the go-live", async () => {
    const ran: Ran[] = [];
    const out = await runSwitchOn({
      checklist: checklistOver(fakeSteps(ran, { fail: "bringup" })),
      answers: { memory: null, confirmed: true },
      repo: null,
      dryRun: () => true,
      stopMemory: stopped,
    });
    expect(ran.map((r) => r.id)).not.toContain(GO_LIVE_STEP_ID);
    expect(ran[ran.length - 1]!.id).toBe("bringup");
    expect(out).toMatchObject({
      ok: false,
      live: false,
      detail: "step bringup: bringup: it broke",
    });
  });

  it("an already-live config skips the go-live: nothing to move", async () => {
    const ran: Ran[] = [];
    const out = await runSwitchOn({
      checklist: checklistOver(fakeSteps(ran)),
      answers: { memory: null, confirmed: true },
      repo: null,
      dryRun: () => false,
      stopMemory: stopped,
    });
    expect(ran.map((r) => r.id)).not.toContain(GO_LIVE_STEP_ID);
    expect(out).toMatchObject({ ok: true, live: true });
  });

  it("a refused go-live leaves auto-review on in dry-run, and says why", async () => {
    const ran: Ran[] = [];
    const out = await runSwitchOn({
      checklist: checklistOver(fakeSteps(ran, { refuseGoLive: true })),
      answers: { memory: null, confirmed: true },
      repo: null,
      dryRun: () => true,
      stopMemory: stopped,
    });
    expect(out.ok).toBe(true);
    expect(out.live).toBe(false);
    expect(out.detail).toMatch(/on in dry-run.*no completed proof round/);
  });

  it("a second switch-on is quick: done steps keep their answers, the daemon start runs again", async () => {
    const ran: Ran[] = [];
    const checklist = checklistOver(fakeSteps(ran));
    const run = () =>
      runSwitchOn({
        checklist,
        answers: { memory: null, confirmed: true },
        repo: null,
        dryRun: () => false,
        stopMemory: stopped,
      });
    await run();
    ran.length = 0;
    const again = await run();
    expect(ran.map((r) => r.id)).toEqual([DAEMON_START_STEP_ID]);
    expect(again.steps).toContain("bringup: already done");
  });

  it("a memory yes runs the memory step again over an earlier no", async () => {
    const ran: Ran[] = [];
    const checklist = checklistOver(fakeSteps(ran));
    const base = { checklist, repo: null, dryRun: () => false, stopMemory: stopped };
    await runSwitchOn({ ...base, answers: { memory: false, confirmed: true } });
    ran.length = 0;
    await runSwitchOn({ ...base, answers: { memory: true, confirmed: true } });
    expect(ran.map((r) => r.id)).toEqual(["memory", DAEMON_START_STEP_ID]);
    expect(ran[0]!.input).toEqual({ choice: "configure" });
  });

  it("skips a step the recorded route disables", async () => {
    const ran: Ran[] = [];
    const out = await runSwitchOn({
      checklist: checklistOver(fakeSteps(ran, { disabled: ["github_account"] })),
      answers: { memory: null, confirmed: true },
      repo: null,
      dryRun: () => false,
      stopMemory: stopped,
    });
    expect(ran.map((r) => r.id)).not.toContain("github_account");
    expect(out.steps).toContain("github_account: not on this route");
  });

  it("go-live from dry-run alone hands the go-live step the confirm", async () => {
    const ran: Ran[] = [];
    const r = await runGoLive(checklistOver(fakeSteps(ran)), { confirmed: true });
    expect(r.ok).toBe(true);
    expect(ran).toEqual([
      { id: GO_LIVE_STEP_ID, input: { decision: "go_live", confirm: GO_LIVE_CONFIRMATION } },
    ]);
  });
});

// ---- the two steps of its own, over a fake machine --------------------------

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function adaptersOver(
  answer: (args: string[]) => ProcessResult,
  calls: string[][],
): OnboardAdapters {
  const root = mkdtempSync(join(tmpdir(), "qcr-switchon-"));
  dirs.push(root);
  return {
    fetch: (() => Promise.reject(new Error("no network"))) as unknown as typeof fetch,
    runner: {
      run: async (cmd, args) => {
        calls.push([cmd, ...args]);
        return answer(args);
      },
    },
    clock: CLOCK,
    host: { nodeVersion: "v26.1.0", uid: 1000 },
    paths: { stateDir: join(root, "state"), configPath: join(root, "config.toml") },
  };
}

const ok = (stdout = ""): ProcessResult => ({ code: 0, stdout, stderr: "" });
const DF =
  "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 100000000 50000000 ";

describe("the machine checks: Docker, disk, ports", () => {
  const answer =
    (freeKb: number, daemonUp = false) =>
    (args: string[]): ProcessResult =>
      args[0] === "info"
        ? ok("/var/lib/docker\n")
        : args[0] === "-Pk"
          ? ok(`${DF}${freeKb} 50% /\n`)
          : args.includes("ps")
            ? ok(daemonUp ? JSON.stringify({ Service: "daemon", State: "running" }) : "")
            : ok("Docker version 27.0.0\n");

  const run = async (o: { freeKb: number; portFree: boolean | null; daemonUp?: boolean }) => {
    const calls: string[][] = [];
    const checklist = new SetupChecklist(
      new StepRegistry([machineChecksStep({ portFree: async () => o.portFree })]),
      adaptersOver(answer(o.freeKb, o.daemonUp), calls),
      { file: null },
    );
    return { r: await checklist.runStep(MACHINE_CHECKS_STEP_ID), calls };
  };

  it("passes on a machine with Docker, room and a free port", async () => {
    const { r } = await run({ freeKb: 41 * 1024 * 1024, portFree: true });
    expect(r.ok).toBe(true);
    expect(r.checks.map((c) => c.name)).toEqual(
      expect.arrayContaining(["docker", "compose", "disk", "ports"]),
    );
    expect(r.checks.find((c) => c.name === "disk")!.detail).toBe("41 GB free");
  });

  it("fails on too little disk, or a port another program holds", async () => {
    expect((await run({ freeKb: 2 * 1024 * 1024, portFree: true })).r.failures.join()).toMatch(
      /disk: only 2\.0 GB free/,
    );
    expect((await run({ freeKb: 41 * 1024 * 1024, portFree: false })).r.failures.join()).toMatch(
      /ports: port 8787 is in use by another program/,
    );
  });

  it("a port its own daemon holds is fine; an unmeasurable one is said as unknown", async () => {
    const own = await run({ freeKb: 41 * 1024 * 1024, portFree: false, daemonUp: true });
    expect(own.r.ok).toBe(true);
    const unsure = await run({ freeKb: 41 * 1024 * 1024, portFree: null });
    expect(unsure.r.checks.find((c) => c.name === "ports")!.detail).toMatch(/unknown/);
  });

  it("reads df's available column", () => {
    expect(freeGbFromDf(`${DF}${10 * 1024 * 1024} 50% /\n`)).toBe(10);
    expect(freeGbFromDf("garbage")).toBeNull();
  });
});

describe("the daemon start", () => {
  const checklistWith = (calls: string[][], up: boolean, broughtUp: boolean) => {
    const c = new SetupChecklist(
      new StepRegistry([daemonStartStep()]),
      adaptersOver(
        (args) =>
          args.includes("ps")
            ? ok(up ? JSON.stringify({ Service: "daemon", State: "running" }) : "")
            : ok(),
        calls,
      ),
      { file: null },
    );
    if (broughtUp)
      (c.choices() as Record<string, unknown>)[BROUGHT_UP_CHOICE_KEY] = "2026-10-01T00:00:00Z";
    return c;
  };

  it("starts the stopped daemon of a stack brought up before, keeping its data", async () => {
    const calls: string[][] = [];
    const r = await checklistWith(calls, false, true).runStep(DAEMON_START_STEP_ID);
    expect(r.ok).toBe(true);
    expect(calls).toContainEqual(expect.arrayContaining(["docker", "compose", "start", "daemon"]));
    expect(calls.some((c) => c.includes("down") || c.includes("rm"))).toBe(false);
  });

  it("before the first bring-up there is nothing to start", async () => {
    const calls: string[][] = [];
    const r = await checklistWith(calls, false, false).runStep(DAEMON_START_STEP_ID);
    expect(r.ok).toBe(true);
    expect(calls).toEqual([]);
  });
});

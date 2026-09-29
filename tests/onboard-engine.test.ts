// OnboardingEngine — the checklist state machine behind the wizard.
// Everything faked: no network, no docker, no pi. The interesting properties:
// resume RE-VERIFIES claimed state instead of trusting the file, persistence
// is tmp+rename atomic, finish refuses while red, and the first-run
// marker is written exactly once.
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  OnboardingEngine,
  checklistComplete,
  checklistPath,
  firstRunMarkerPath,
  readChecklist,
  type ChecklistFile,
  type OnboardAdapters,
  type OnboardingStep,
} from "../src/onboard/engine.js";
import {
  PREFLIGHT_STEP_ID,
  UID_CHOICE_KEY,
  parseNodeMajor,
  preflightStep,
} from "../src/onboard/steps/preflight.js";

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "qcr-onboard-"));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

interface FakeHost {
  nodeVersion?: string;
  uid?: number | null;
  dockerOk?: boolean;
  composeOk?: boolean;
}

function fakeAdapters(host: FakeHost = {}, calls: string[] = []): OnboardAdapters {
  const dockerOk = host.dockerOk ?? true;
  const composeOk = host.composeOk ?? true;
  return {
    fetch: (() => {
      throw new Error("no network in tests");
    }) as unknown as typeof fetch,
    runner: {
      run: async (cmd, args) => {
        calls.push([cmd, ...args].join(" "));
        if (cmd !== "docker") return { code: 127, stdout: "", stderr: `${cmd}: not found` };
        if (args[0] === "--version") {
          return dockerOk
            ? { code: 0, stdout: "Docker version 27.0.0, build abc\n", stderr: "" }
            : { code: 127, stdout: "", stderr: "docker: command not found" };
        }
        if (args[0] === "compose") {
          return composeOk
            ? { code: 0, stdout: "Docker Compose version v2.29.0\n", stderr: "" }
            : { code: 1, stdout: "", stderr: "unknown command: compose" };
        }
        return { code: 1, stdout: "", stderr: "unexpected docker args" };
      },
    },
    clock: () => new Date("2026-08-30T12:00:00Z"),
    host: {
      nodeVersion: host.nodeVersion ?? "v22.5.1",
      uid: host.uid === undefined ? 1000 : host.uid,
    },
    paths: { stateDir, configPath: join(dirname(stateDir), "config.toml") },
  };
}

function engine(host: FakeHost = {}, calls: string[] = []): OnboardingEngine {
  return new OnboardingEngine([preflightStep()], fakeAdapters(host, calls));
}

describe("parseNodeMajor", () => {
  it("parses v-prefixed and bare versions; rejects garbage", () => {
    expect(parseNodeMajor("v22.5.1")).toBe(22);
    expect(parseNodeMajor("23.0.0")).toBe(23);
    expect(parseNodeMajor("nonsense")).toBeNull();
  });
});

describe("preflight step lifecycle", () => {
  it("green run marks the step done, captures the uid as a choice, and persists", async () => {
    const e = engine();
    const result = await e.runStep(PREFLIGHT_STEP_ID);
    expect(result.ok).toBe(true);
    expect(result.checks.map((c) => c.name)).toEqual(["node", "docker", "compose", "uid"]);
    expect(e.choices()[UID_CHOICE_KEY]).toBe(1000);

    const file = readChecklist(stateDir);
    expect(file?.steps[PREFLIGHT_STEP_ID]?.status).toBe("done");
    expect(file?.steps[PREFLIGHT_STEP_ID]?.data).toEqual({ uid: 1000 });
    expect(file?.choices[UID_CHOICE_KEY]).toBe(1000);
  });

  it("old Node fails the run with a plain failure; the step stays pending", async () => {
    const e = engine({ nodeVersion: "v20.11.0" });
    const result = await e.runStep(PREFLIGHT_STEP_ID);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/Node >= 22/);
    expect(readChecklist(stateDir)?.steps[PREFLIGHT_STEP_ID]?.status).toBe("pending");
  });

  it("missing docker / compose / uid each fail with their own check line", async () => {
    const noDocker = await engine({ dockerOk: false }).runStep(PREFLIGHT_STEP_ID);
    expect(noDocker.failures.some((f) => f.startsWith("docker:"))).toBe(true);

    const noCompose = await engine({ composeOk: false }).runStep(PREFLIGHT_STEP_ID);
    expect(noCompose.failures.some((f) => f.startsWith("compose:"))).toBe(true);

    const noUid = await engine({ uid: null }).runStep(PREFLIGHT_STEP_ID);
    expect(noUid.failures.some((f) => f.startsWith("uid:"))).toBe(true);
    // A failed run must not half-record the uid choice.
    expect(readChecklist(stateDir)?.choices[UID_CHOICE_KEY]).toBeUndefined();
  });

  it("unknown and throwing steps are refusals, never throws", async () => {
    const e = engine();
    const unknown = await e.runStep("no-such-step");
    expect(unknown.ok).toBe(false);
    expect(unknown.failures[0]).toMatch(/unknown step/);

    const thrower: OnboardingStep = {
      id: "boom",
      title: "Boom",
      explain: "x",
      order: 5,
      run: async () => {
        throw new Error("kapow");
      },
      verify: async () => {
        throw new Error("kapow");
      },
    };
    const e2 = new OnboardingEngine([thrower], fakeAdapters());
    const result = await e2.runStep("boom");
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/kapow/);
  });
});

describe("persistence", () => {
  it("writes are atomic: only checklist.json remains, valid JSON, no tmp files", async () => {
    const e = engine();
    await e.runStep(PREFLIGHT_STEP_ID);
    const dir = dirname(checklistPath(stateDir));
    expect(readdirSync(dir)).toEqual(["checklist.json"]);
    const parsed = JSON.parse(readFileSync(checklistPath(stateDir), "utf8")) as ChecklistFile;
    expect(parsed.version).toBe(1);
  });

  it("a corrupt checklist file degrades to fresh — never a crash", async () => {
    mkdirSync(dirname(checklistPath(stateDir)), { recursive: true });
    writeFileSync(checklistPath(stateDir), "{ not json");
    const e = engine();
    expect(e.list()[0]?.status).toBe("pending");
    const result = await e.runStep(PREFLIGHT_STEP_ID);
    expect(result.ok).toBe(true);
    expect(readChecklist(stateDir)?.steps[PREFLIGHT_STEP_ID]?.status).toBe("done");
  });
});

describe("kill / resume re-verification", () => {
  it("a new engine over the same state dir re-verifies a claimed-done step; reality changed ⇒ demoted", async () => {
    await engine().runStep(PREFLIGHT_STEP_ID);
    // Docker vanished between sessions — the file still claims done.
    const resumed = engine({ dockerOk: false });
    const report = await resumed.reconcile();
    expect(report.demoted).toHaveLength(1);
    expect(report.demoted[0]?.id).toBe(PREFLIGHT_STEP_ID);
    expect(report.demoted[0]?.failures.join(" ")).toMatch(/docker/);
    const rec = readChecklist(stateDir)?.steps[PREFLIGHT_STEP_ID];
    expect(rec?.status).toBe("pending");
    expect(rec?.note).toMatch(/re-verification failed/);
  });

  it("a recorded uid that no longer matches the current user fails re-verification", async () => {
    await engine({ uid: 1000 }).runStep(PREFLIGHT_STEP_ID);
    const report = await engine({ uid: 1001 }).reconcile();
    expect(report.demoted[0]?.failures.join(" ")).toMatch(/uid 1000 no longer matches/);
  });

  it("a fully-done checklist re-runs as verify-only: nothing demoted, verified_at stamped, status intact", async () => {
    await engine().runStep(PREFLIGHT_STEP_ID);
    const resumed = engine();
    const report = await resumed.reconcile();
    expect(report.verified).toEqual([PREFLIGHT_STEP_ID]);
    expect(report.demoted).toEqual([]);
    const rec = readChecklist(stateDir)?.steps[PREFLIGHT_STEP_ID];
    expect(rec?.status).toBe("done");
    expect(rec?.verified_at).toBe("2026-08-30T12:00:00.000Z");
  });

  it("hand-edited claims are not trusted: a done mark with no recorded uid is demoted", async () => {
    // Simulate a checklist that CLAIMS preflight done but was never run.
    mkdirSync(dirname(checklistPath(stateDir)), { recursive: true });
    const forged: ChecklistFile = {
      version: 1,
      created_at: "2026-08-30T00:00:00Z",
      updated_at: "2026-08-30T00:00:00Z",
      completed_at: null,
      choices: {},
      steps: {
        [PREFLIGHT_STEP_ID]: {
          status: "done",
          completed_at: "2026-08-30T00:00:00Z",
          verified_at: null,
          note: null,
          data: {},
        },
      },
    };
    writeFileSync(checklistPath(stateDir), JSON.stringify(forged));
    const report = await engine().reconcile();
    expect(report.demoted[0]?.failures.join(" ")).toMatch(/no uid recorded/);
  });
});

describe("finish", () => {
  it("refuses while any check is red and writes no marker", async () => {
    const e = engine({ dockerOk: false });
    const result = await e.finish();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.results[0]?.failures.join(" ")).toMatch(/docker/);
    expect(existsSync(firstRunMarkerPath(stateDir))).toBe(false);
    expect(checklistComplete(stateDir)).toBe(false);
  });

  it("green: marks the checklist complete and writes the first-run marker with the exact shape", async () => {
    const e = engine();
    await e.runStep(PREFLIGHT_STEP_ID);
    const result = await e.finish();
    expect(result.ok).toBe(true);
    expect(checklistComplete(stateDir)).toBe(true);
    // The contract path consumes — keep it stable.
    const markerPath = join(stateDir, "companion", "first-run.json");
    expect(firstRunMarkerPath(stateDir)).toBe(markerPath);
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as { completed_at: string };
    expect(Object.keys(marker)).toEqual(["completed_at"]);
    expect(marker.completed_at).toBe("2026-08-30T12:00:00.000Z");
  });

  it("the marker is written once — a second finish leaves it byte-identical", async () => {
    const e = engine();
    await e.runStep(PREFLIGHT_STEP_ID);
    const first = await e.finish();
    expect(first.ok && first.marker_written).toBe(true);
    const bytes = readFileSync(firstRunMarkerPath(stateDir), "utf8");

    // Later re-run (diagnostic mode) with a later clock: marker untouched.
    const later = fakeAdapters();
    later.clock = () => new Date("2026-09-01T09:00:00Z");
    const e2 = new OnboardingEngine([preflightStep()], later);
    const second = await e2.finish();
    expect(second.ok && !second.marker_written).toBe(true);
    expect(readFileSync(firstRunMarkerPath(stateDir), "utf8")).toBe(bytes);
    // completed_at never moves either.
    expect(readChecklist(stateDir)?.completed_at).toBe("2026-08-30T12:00:00.000Z");
  });

  it("a completed checklist that no longer verifies stops claiming completion — the history does not move", async () => {
    const e = engine();
    await e.runStep(PREFLIGHT_STEP_ID);
    expect((await e.finish()).ok).toBe(true);
    const markerBytes = readFileSync(firstRunMarkerPath(stateDir), "utf8");

    // Later: docker broke. `qcr onboard` again reconciles and demotes; the
    // operator quits pi without a green finish. The handoff must not read
    // "verified complete".
    const resumed = engine({ dockerOk: false });
    const report = await resumed.reconcile();
    expect(report.demoted.map((d) => d.id)).toEqual([PREFLIGHT_STEP_ID]);
    expect(checklistComplete(stateDir)).toBe(false);
    expect(resumed.isComplete()).toBe(false);
    // The historical completion and the first-run marker stay put.
    expect(readChecklist(stateDir)?.completed_at).toBe("2026-08-30T12:00:00.000Z");
    expect(readFileSync(firstRunMarkerPath(stateDir), "utf8")).toBe(markerBytes);

    // Fixed and re-finished: complete again, same history.
    const fixed = engine();
    await fixed.runStep(PREFLIGHT_STEP_ID);
    expect((await fixed.finish()).ok).toBe(true);
    expect(checklistComplete(stateDir)).toBe(true);
    expect(readChecklist(stateDir)?.completed_at).toBe("2026-08-30T12:00:00.000Z");
  });

  it("a failed run or a refused finish on a completed checklist also withdraws the claim", async () => {
    const e = engine();
    await e.runStep(PREFLIGHT_STEP_ID);
    expect((await e.finish()).ok).toBe(true);
    expect((await engine({ dockerOk: false }).runStep(PREFLIGHT_STEP_ID)).ok).toBe(false);
    expect(checklistComplete(stateDir)).toBe(false);

    const again = engine();
    await again.runStep(PREFLIGHT_STEP_ID);
    expect((await again.finish()).ok).toBe(true);
    expect(checklistComplete(stateDir)).toBe(true);
    expect((await engine({ dockerOk: false }).finish()).ok).toBe(false);
    expect(checklistComplete(stateDir)).toBe(false);
  });

  it("a step newly enabled on a completed checklist withdraws the claim at reconcile", async () => {
    const vmOnly: OnboardingStep = {
      id: "vm_only",
      title: "VM only",
      explain: "x",
      order: 20,
      enabled: (choices) => choices.topology === "vm",
      run: async () => ({ ok: true, checks: [] }),
      verify: async () => ({ ok: false, checks: [{ name: "vm", ok: false, detail: "nope" }] }),
    };
    const flip: OnboardingStep = {
      id: "flip",
      title: "flip",
      explain: "x",
      order: 30,
      run: async (ctx) => {
        ctx.recordChoice("topology", "vm");
        return { ok: true, checks: [] };
      },
      verify: async () => ({ ok: true, checks: [] }),
    };
    const e = new OnboardingEngine([preflightStep(), vmOnly], fakeAdapters());
    await e.runStep(PREFLIGHT_STEP_ID);
    expect((await e.finish()).ok).toBe(true);
    const e2 = new OnboardingEngine([preflightStep(), vmOnly, flip], fakeAdapters());
    await e2.runStep("flip");
    await e2.reconcile();
    expect(checklistComplete(stateDir)).toBe(false);
  });

  it("verifyAll promotes a step whose outcome exists in reality but was never marked", async () => {
    // preflight cannot pass verify without a recorded uid, so use a synthetic
    // step to pin the promotion rule the later idempotent steps rely on.
    const green: OnboardingStep = {
      id: "already_true",
      title: "Already true",
      explain: "x",
      order: 1,
      run: async () => ({ ok: true, checks: [{ name: "a", ok: true, detail: "ran" }] }),
      verify: async () => ({ ok: true, checks: [{ name: "a", ok: true, detail: "holds" }] }),
    };
    const e = new OnboardingEngine([green], fakeAdapters());
    const all = await e.verifyAll();
    expect(all.ok).toBe(true);
    const rec = readChecklist(stateDir)?.steps.already_true;
    expect(rec?.status).toBe("done");
    expect(rec?.note).toMatch(/verified green without a recorded run/);
  });
});

describe("step gating", () => {
  it("a step disabled by recorded choices is skipped by reconcile/verifyAll and refuses to run", async () => {
    const vmOnly: OnboardingStep = {
      id: "vm_only",
      title: "VM only",
      explain: "x",
      order: 20,
      enabled: (choices) => choices.topology === "vm",
      run: async () => ({ ok: true, checks: [] }),
      verify: async () => ({ ok: false, checks: [{ name: "vm", ok: false, detail: "nope" }] }),
    };
    const e = new OnboardingEngine([preflightStep(), vmOnly], fakeAdapters());
    await e.runStep(PREFLIGHT_STEP_ID);
    const refused = await e.runStep("vm_only");
    expect(refused.ok).toBe(false);
    expect(refused.failures[0]).toMatch(/disabled/);
    // Its red verify must not block finish while disabled.
    const finish = await e.finish();
    expect(finish.ok).toBe(true);
    expect(e.list().find((l) => l.id === "vm_only")?.status).toBe("disabled");
  });
});

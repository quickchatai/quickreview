// The setup checklist (packages/pi-plugin/src/setupchecklist.ts): the step
// registry and the engine's detect, the parts the onboarding wizard's suites
// (tests/onboard-*.test.ts) do not reach. A step's detect marks it done with
// what it found and the step never runs; one that is not true yet stays
// pending with why; the registry refuses an id two steps would share. The
// plugin's own steps and the app-step seam are in tests/pi-plugin.test.ts.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SetupChecklist,
  StepRegistry,
  readChecklistFile,
  type Detection,
  type SetupStep,
} from "@quickchatai/pi-quickreview/src/setupchecklist.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-setup-checklist-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const adapters = { clock: () => new Date("2026-10-26T12:00:00Z") };

/** A step whose detect answers `detection` (or throws), counting its runs;
 * its verify holds while `real.ok`. */
function step(
  id: string,
  order: number,
  detection: Detection | "throw" | null,
  real = { ok: true },
): SetupStep & { runs: number } {
  const s = {
    id,
    title: id,
    explain: `the ${id} step`,
    order,
    runs: 0,
    run: async () => {
      s.runs++;
      return { ok: true, checks: [{ name: id, ok: true, detail: "ran" }] };
    },
    verify: async () => ({
      ok: real.ok,
      checks: [{ name: id, ok: real.ok, detail: real.ok ? "holds" : "gone" }],
    }),
    ...(detection === null
      ? {}
      : {
          detect: async (): Promise<Detection> => {
            if (detection === "throw") throw new Error("no answer");
            return detection;
          },
        }),
  };
  return s;
}

describe("the step registry", () => {
  // MUTATION: drop the duplicate check in register() — this fails.
  it("refuses a second step under one id, and an id that is not tool-name-safe", () => {
    const registry = new StepRegistry([step("gh_login", 1, null)]);
    expect(() => registry.register(step("gh_login", 2, null))).toThrow(/registered twice/);
    expect(() => registry.register(step("Repo-Pick", 3, null))).toThrow(/not \[a-z\]/);
  });

  it("orders steps by `order` wherever they were registered, ties in registration order", () => {
    const registry = new StepRegistry([step("a", 2, null), step("b", 1, null)]);
    registry.register(step("c", 1.5, null), step("d", 2, null));
    expect(registry.steps().map((s) => s.id)).toEqual(["b", "c", "a", "d"]);
  });
});

describe("detect", () => {
  // MUTATION: run a detected step anyway, or leave it pending — this fails.
  it("marks an already-true step done with what it found, and never runs it", async () => {
    const found = step("gh", 1, { found: "@user · via gh" });
    const checklist = new SetupChecklist([found], adapters, { file: null });
    const report = await checklist.detect();
    expect(report.results).toEqual([{ id: "gh", found: "@user · via gh" }]);
    expect(found.runs).toBe(0);
    expect(checklist.list()[0]).toMatchObject({
      id: "gh",
      status: "done",
      found: "@user · via gh",
      note: null,
    });
  });

  it("leaves a step that is not true yet pending with why, and a throwing detect is a why", async () => {
    const checklist = new SetupChecklist(
      [step("gh", 1, { missing: "run gh auth login" }), step("repo", 2, "throw")],
      adapters,
      { file: null },
    );
    await checklist.detect();
    const [gh, repo] = checklist.list();
    expect(gh).toMatchObject({ status: "pending", note: "run gh auth login" });
    expect(gh).not.toHaveProperty("found");
    expect(repo!.status).toBe("pending");
    expect(repo!.note).toMatch(/detect threw: .*no answer/);
  });

  it("asks neither a step without detect nor one already done nor a disabled one", async () => {
    const plain = step("plain", 1, null);
    const gated = { ...step("gated", 2, { found: "x" }), enabled: () => false };
    const done = step("done_once", 3, { missing: "would demote" });
    const checklist = new SetupChecklist([plain, gated, done], adapters, { file: null });
    await checklist.runStep("done_once");
    const report = await checklist.detect();
    expect(report.results).toEqual([]);
    expect(checklist.list().map((l) => [l.id, l.status])).toEqual([
      ["plain", "pending"],
      ["gated", "disabled"],
      ["done_once", "done"],
    ]);
  });

  it("records what it found in the checklist file, and a resume re-verifies it like any done step", async () => {
    const file = join(dir, "checklist.json");
    const real = { ok: true };
    await new SetupChecklist([step("gh", 1, { found: "@user · via gh" }, real)], adapters, {
      file,
    }).detect();
    expect(readChecklistFile(file)!.steps["gh"]).toMatchObject({
      status: "done",
      found: "@user · via gh",
    });
    real.ok = false;
    const resumed = new SetupChecklist(
      [step("gh", 1, { found: "@user · via gh" }, real)],
      adapters,
      {
        file,
      },
    );
    expect((await resumed.reconcile()).demoted.map((d) => d.id)).toEqual(["gh"]);
  });

  it("drops what was found once the step runs", async () => {
    const checklist = new SetupChecklist([step("gh", 1, { found: "@user · via gh" })], adapters, {
      file: null,
    });
    await checklist.detect();
    await checklist.runStep("gh");
    expect(checklist.list()[0]).toMatchObject({ status: "done" });
    expect(checklist.list()[0]).not.toHaveProperty("found");
  });
});

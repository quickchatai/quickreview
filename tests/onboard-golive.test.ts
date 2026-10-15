// The go-live offer, and root rule 1 made structural.
//
// `dry_run` is the owner's flag alone. This step may move it in exactly one
// place, on an explicit confirmation, after a proof round the daemon's own
// state store still agrees happened. Everything below exists to make that
// sentence a property of the code rather than a promise in a comment — and the
// decline path is tested as a first-class outcome, not as a failure.
//
// Everything faked: a fake ProcessRunner for `docker compose ps` and the
// in-container `qcr why --json`, a fake StreamRunner for the restart, a temp
// root. No docker, no network, no clock waiting.
import { readdirSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  OnboardingEngine,
  type OnboardAdapters,
  type ProcessResult,
} from "../src/onboard/engine.js";
import type { StreamRunner } from "../src/onboard/steps/compose.js";
import {
  GO_LIVE_CHOICE_KEY,
  GO_LIVE_CONFIRMATION,
  GO_LIVE_EXPLANATION,
  GO_LIVE_STEP_ID,
  GoLiveRefused,
  SETUP_RECOMMENDATION,
  flipDryRunToFalse,
  goLiveStep,
  isGoLiveConfirmation,
} from "../src/onboard/steps/golive.js";
import { PROOF_CHOICE_KEY } from "../src/onboard/steps/proof.js";
import type { ProofRecord } from "../src/onboard/steps/proof.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exampleConfig = readFileSync(join(repoRoot, "config.example.toml"), "utf8");

const PROOF: ProofRecord = {
  pr: 17,
  round_no: 1,
  verdict: "REQUEST_CHANGES",
  completed_at: "2026-08-30T11:59:00Z",
  review_shown: true,
};

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "qcr-golive-"));
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(root, "config.toml"), exampleConfig);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function seedChoices(choices: Record<string, unknown>): void {
  mkdirSync(join(root, "state", "onboarding"), { recursive: true });
  writeFileSync(
    join(root, "state", "onboarding", "checklist.json"),
    JSON.stringify({
      version: 1,
      created_at: "2026-08-30T10:00:00Z",
      updated_at: "2026-08-30T10:00:00Z",
      completed_at: null,
      choices,
      steps: {},
    }),
  );
}

const configText = (): string => readFileSync(join(root, "config.toml"), "utf8");
const dryRunOnDisk = (): boolean => loadConfig(join(root, "config.toml")).dry_run;

interface Harness {
  engine: OnboardingEngine;
  restarts: string[][];
  adapters: OnboardAdapters;
}

function harness(
  o: {
    rounds?: Array<{ round_no: number; status: string; verdict: string | null }>;
    whyCode?: number;
    daemonRunning?: boolean;
    /** `docker compose ps` fails — the daemon's state is unknown. */
    psFails?: boolean;
    /** Exit code of the restart. */
    restartCode?: number;
  } = {},
): Harness {
  const restarts: string[][] = [];
  const runner = {
    run: async (_cmd: string, args: string[]): Promise<ProcessResult> => {
      if (args.includes("ps")) {
        if (o.psFails) return { code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" };
        const rows = (o.daemonRunning ?? true) ? [{ Service: "daemon", State: "running" }] : [];
        return { code: 0, stdout: JSON.stringify(rows), stderr: "" };
      }
      if (args.includes("why")) {
        if (o.whyCode) return { code: o.whyCode, stdout: "", stderr: "Error: no such container" };
        const rounds = o.rounds ?? [{ round_no: 1, status: "done", verdict: "REQUEST_CHANGES" }];
        return {
          code: 0,
          stdout: JSON.stringify({ pr: 17, known: true, state: "awaiting_author", rounds }),
          stderr: "",
        };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    },
  };
  const stream: StreamRunner = {
    run: async (cmd, args) => {
      restarts.push([cmd, ...args]);
      return o.restartCode
        ? { code: o.restartCode, stdout: "", stderr: "restart failed" }
        : { code: 0, stdout: "", stderr: "" };
    },
  };
  const adapters: OnboardAdapters = {
    fetch: (() => {
      throw new Error("no network in tests");
    }) as unknown as typeof fetch,
    runner,
    clock: () => new Date("2026-08-30T12:00:00Z"),
    host: { nodeVersion: "v22.5.1", uid: 1000 },
    paths: { stateDir: join(root, "state"), configPath: join(root, "config.toml") },
  };
  return { engine: new OnboardingEngine([goLiveStep({ stream })], adapters), restarts, adapters };
}

// ---- the guard itself --------------------------------------------------------

describe("flipDryRunToFalse — the ONE writer of the flag", () => {
  it("refuses without the explicit confirmation phrase", () => {
    for (const confirmation of [undefined, "", "yes", "y", "ok", "sure", true, 1]) {
      expect(() => flipDryRunToFalse(exampleConfig, { confirmation, proof: PROOF })).toThrow(
        GoLiveRefused,
      );
    }
  });

  it("refuses without a completed proof, however confidently it is confirmed", () => {
    expect(() =>
      flipDryRunToFalse(exampleConfig, { confirmation: GO_LIVE_CONFIRMATION, proof: null }),
    ).toThrow(/completed proof round/);
  });

  it("refuses to INVENT the flag in a config that has none", () => {
    const stripped = exampleConfig.replace(/^dry_run = true.*$/m, "");
    expect(() =>
      flipDryRunToFalse(stripped, { confirmation: GO_LIVE_CONFIRMATION, proof: PROOF }),
    ).toThrow(/no dry_run key/);
  });

  it(
    "flips exactly one key, and leaves the rest of the file alone",
    { timeout: HEAVY_TIMEOUT_MS },
    () => {
      const after = flipDryRunToFalse(exampleConfig, {
        confirmation: GO_LIVE_CONFIRMATION,
        proof: PROOF,
      });
      expect(after).toMatch(/^dry_run = false/m);
      expect(after.split("\n")).toHaveLength(exampleConfig.split("\n").length);
      // Everything else is byte-identical.
      const diff = after.split("\n").filter((line, i) => line !== exampleConfig.split("\n")[i]);
      expect(diff).toHaveLength(1);
    },
  );

  it("takes the phrase, and only the phrase (case and space forgiven)", () => {
    expect(isGoLiveConfirmation("GO LIVE")).toBe(true);
    expect(isGoLiveConfirmation("  go live ")).toBe(true);
    for (const no of ["yes", "go", "live", "GO-LIVE", "", null, 42])
      expect(isGoLiveConfirmation(no)).toBe(false);
  });
});

// ---- the proof gate ----------------------------------------------------------

describe("the flip is impossible without a completed proof", () => {
  it("with no proof recorded the flip is not even OFFERED, and nothing is written", async () => {
    const h = harness();
    const result = await h.engine.runStep(GO_LIVE_STEP_ID, {
      decision: "go_live",
      confirm: GO_LIVE_CONFIRMATION,
    });
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/no completed proof round/);
    expect(result.failures.join(" ")).toMatch(/proof_round step first/);
    expect(dryRunOnDisk()).toBe(true);
  });

  it("a FORGED checklist entry does not buy a flip — the state store is asked", async () => {
    seedChoices({ [PROOF_CHOICE_KEY]: { ...PROOF, round_no: 99 } });
    const h = harness({ rounds: [{ round_no: 1, status: "done", verdict: "APPROVE" }] });
    const result = await h.engine.runStep(GO_LIVE_STEP_ID, {
      decision: "go_live",
      confirm: GO_LIVE_CONFIRMATION,
    });
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/does not show #17 round 99 as a finished round/);
    expect(dryRunOnDisk()).toBe(true);
  });

  it("a proof that cannot be re-checked is refused, not assumed", async () => {
    seedChoices({ [PROOF_CHOICE_KEY]: PROOF });
    const h = harness({ whyCode: 1 });
    const result = await h.engine.runStep(GO_LIVE_STEP_ID, {
      decision: "go_live",
      confirm: GO_LIVE_CONFIRMATION,
    });
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(
      /never made on the strength of the checklist file alone/,
    );
    expect(dryRunOnDisk()).toBe(true);
  });
});

// ---- the offer, the confirmation, the two answers ----------------------------

describe("the offer", () => {
  beforeEach(() => seedChoices({ [PROOF_CHOICE_KEY]: PROOF }));

  it("with no decision it explains dry-run and going live, and changes nothing", async () => {
    const h = harness();
    const result = await h.engine.runStep(GO_LIVE_STEP_ID);
    expect(result.ok).toBe(false);
    const offer = result.checks[0]!.detail;
    expect(offer).toContain(GO_LIVE_EXPLANATION);
    expect(offer).toMatch(/You watched #17 reviewed \(round 1, verdict REQUEST_CHANGES\)/);
    expect(dryRunOnDisk()).toBe(true);
  });

  it("says what dry-run is, what live means, and that declining is normal", () => {
    expect(GO_LIVE_EXPLANATION).toMatch(/state\/dryrun\//);
    expect(GO_LIVE_EXPLANATION).toMatch(/dismisses anyone's review/);
    expect(GO_LIVE_EXPLANATION).toMatch(/Declining is a completely normal answer/);
  });

  it("a decision of go_live WITHOUT the confirmation changes nothing", async () => {
    const h = harness();
    for (const confirm of [undefined, "yes", "ok"]) {
      const result = await h.engine.runStep(GO_LIVE_STEP_ID, {
        decision: "go_live",
        ...(confirm === undefined ? {} : { confirm }),
      });
      expect(result.ok).toBe(false);
      expect(result.failures.join(" ")).toMatch(/needs the operator's own explicit words/);
      expect(dryRunOnDisk()).toBe(true);
    }
    expect(h.restarts).toEqual([]);
  });

  it("an empty tool call never flips — the default of every argument is 'do nothing'", async () => {
    const h = harness();
    await h.engine.runStep(GO_LIVE_STEP_ID, {});
    expect(dryRunOnDisk()).toBe(true);
    expect(h.engine.choices()[GO_LIVE_CHOICE_KEY]).toBeUndefined();
  });
});

describe("going live", () => {
  beforeEach(() => seedChoices({ [PROOF_CHOICE_KEY]: PROOF }));

  it("flips the flag, restarts the daemon, and reads it back", async () => {
    const h = harness();
    const result = await h.engine.runStep(GO_LIVE_STEP_ID, {
      decision: "go_live",
      confirm: GO_LIVE_CONFIRMATION,
    });
    expect(result.ok).toBe(true);
    expect(dryRunOnDisk()).toBe(false);
    expect(configText()).toMatch(/^dry_run = false/m);
    expect(h.restarts[0]).toEqual([
      "docker",
      "compose",
      "--project-directory",
      root,
      "restart",
      "daemon",
    ]);
    expect(h.engine.choices()[GO_LIVE_CHOICE_KEY]).toBe("live");
    expect(result.checks[0]!.detail).toMatch(/you ratified this, on the evidence of #17 round 1/);
    // The scratch probe never survives.
    expect(readdirSync(join(root, "state", "onboarding")).some((f) => f.includes("golive"))).toBe(
      false,
    );
  });

  it("verify then reports the live posture", async () => {
    const h = harness();
    await h.engine.runStep(GO_LIVE_STEP_ID, { decision: "go_live", confirm: GO_LIVE_CONFIRMATION });
    const all = await h.engine.verifyAll();
    expect(all.ok).toBe(true);
  });

  it("a recorded flip that did NOT stick is red at verify", async () => {
    seedChoices({ [PROOF_CHOICE_KEY]: PROOF, [GO_LIVE_CHOICE_KEY]: "live" });
    const h = harness();
    const all = await h.engine.verifyAll();
    expect(all.ok).toBe(false);
    expect(all.results[0]!.failures.join(" ")).toMatch(/the flip did not stick/);
  });
});

describe("declining is a first-class outcome", () => {
  beforeEach(() => seedChoices({ [PROOF_CHOICE_KEY]: PROOF }));

  it("stay_dry_run is GREEN, writes nothing, and reads as a finished installation", async () => {
    const h = harness();
    const result = await h.engine.runStep(GO_LIVE_STEP_ID, { decision: "stay_dry_run" });
    expect(result.ok).toBe(true);
    expect(dryRunOnDisk()).toBe(true);
    expect(h.restarts).toEqual([]);
    const detail = result.checks[0]!.detail;
    expect(detail).toMatch(/finished, fully working installation/);
    expect(detail).toMatch(/Flip whenever you want/);
    expect(detail).not.toMatch(/fail/i);
    expect(h.engine.choices()[GO_LIVE_CHOICE_KEY]).toBe("dry_run");
  });

  it("either answer ends by recommending setup next — a recommendation, never a start", async () => {
    expect(SETUP_RECOMMENDATION).toMatch(/qcr setup/);
    expect(SETUP_RECOMMENDATION).toMatch(/press I on the TUI board/);
    expect(SETUP_RECOMMENDATION).toMatch(/until you deploy/);
    const declined = await harness().engine.runStep(GO_LIVE_STEP_ID, { decision: "stay_dry_run" });
    expect(declined.checks.at(-1)).toEqual({
      name: "next",
      ok: true,
      detail: SETUP_RECOMMENDATION,
    });
    const live = await harness().engine.runStep(GO_LIVE_STEP_ID, {
      decision: "go_live",
      confirm: GO_LIVE_CONFIRMATION,
    });
    expect(live.ok).toBe(true);
    expect(live.checks.at(-1)).toEqual({ name: "next", ok: true, detail: SETUP_RECOMMENDATION });
  });

  it("the checklist can COMPLETE on a decline — a dry-run install finishes the wizard", async () => {
    const h = harness();
    await h.engine.runStep(GO_LIVE_STEP_ID, { decision: "stay_dry_run" });
    const finished = await h.engine.finish();
    expect(finished.ok).toBe(true);
    expect(dryRunOnDisk()).toBe(true);
  });

  it("and the decline can be changed later, by the same explicit act", async () => {
    const h = harness();
    await h.engine.runStep(GO_LIVE_STEP_ID, { decision: "stay_dry_run" });
    const second = harness();
    expect(
      (await second.engine.runStep(GO_LIVE_STEP_ID, { decision: "go_live", confirm: "go live" }))
        .ok,
    ).toBe(true);
    expect(dryRunOnDisk()).toBe(false);
  });

  it("a decline on a LIVE installation is refused, records nothing and never claims file-only reviews", async () => {
    writeFileSync(join(root, "config.toml"), exampleConfig.replace(/^dry_run = true/m, "dry_run = false"));
    seedChoices({ [PROOF_CHOICE_KEY]: PROOF, [GO_LIVE_CHOICE_KEY]: "live" });
    const h = harness();
    const before = configText();
    const result = await h.engine.runStep(GO_LIVE_STEP_ID, { decision: "stay_dry_run" });
    expect(result.ok).toBe(false);
    const detail = result.checks.map((c) => c.detail).join(" ");
    expect(detail).toMatch(/LIVE/);
    expect(detail).not.toMatch(/state\/dryrun/);
    expect(h.engine.choices()[GO_LIVE_CHOICE_KEY]).toBe("live");
    expect(configText()).toBe(before);
    expect(h.restarts).toEqual([]);
  });

  it("a recorded decline later hand-flipped to live verifies as LIVE, not as dry-run", async () => {
    writeFileSync(join(root, "config.toml"), exampleConfig.replace(/^dry_run = true/m, "dry_run = false"));
    const report = await goLiveStep().verify({
      adapters: harness().adapters,
      input: {},
      choices: { [PROOF_CHOICE_KEY]: PROOF, [GO_LIVE_CHOICE_KEY]: "dry_run" },
      data: {},
      recordChoice: () => undefined,
    });
    expect(report.ok).toBe(true);
    expect(report.checks[0]!.detail).toMatch(/^LIVE/);
    expect(report.checks[0]!.detail).toMatch(/posted to GitHub/);
  });

  it("a recorded decline over an unreadable config verifies UNKNOWN and red, never green", async () => {
    writeFileSync(join(root, "config.toml"), "this is = = not toml\n");
    const report = await goLiveStep().verify({
      adapters: harness().adapters,
      input: {},
      choices: { [PROOF_CHOICE_KEY]: PROOF, [GO_LIVE_CHOICE_KEY]: "dry_run" },
      data: {},
      recordChoice: () => undefined,
    });
    expect(report.ok).toBe(false);
    expect(report.checks[0]!.detail).toMatch(/unknown/);
    expect(report.checks[0]!.detail).not.toMatch(/finished installation/);
  });

  it("with no answer at all the step is red — the wizard wants a decision, not a default", async () => {
    const h = harness();
    const all = await h.engine.verifyAll();
    expect(all.ok).toBe(false);
    expect(all.results[0]!.failures.join(" ")).toMatch(
      /staying in dry-run is a complete, finished installation/,
    );
  });
});

// ---- the structural fence ----------------------------------------------------

describe("nothing else in this slice may write the flag", () => {
  const stepsDir = join(repoRoot, "src", "onboard", "steps");
  // Enumerated, never listed: a step file added later is fenced the day it
  // lands, without anyone remembering to add it here (rule 1).
  const slice = readdirSync(stepsDir).filter((f) => f.endsWith(".ts") && f !== "golive.ts");

  it("only golive.ts contains a dry_run WRITE", () => {
    for (const file of slice) {
      const text = readFileSync(join(stepsDir, file), "utf8");
      // Every config edit in the wizard is built as a {section, key, value}
      // record, so the edit-construction shape is the thing to fence. Prose
      // about dry_run — guidance, error text, teaching — is fine and expected;
      // matching on the words would only teach people to reword comments.
      expect(text, `${file} must not build a dry_run edit`).not.toMatch(/key:\s*"dry_run"/);
    }
    const golive = readFileSync(join(stepsDir, "golive.ts"), "utf8");
    expect(golive).toMatch(/key: "dry_run"/);
  });

  it("every step that patches config routes its edits through the dry_run refusal", () => {
    for (const file of slice) {
      const text = readFileSync(join(stepsDir, file), "utf8");
      if (!/\bpatchToml\s*\(/.test(text)) continue;
      expect(text, `${file} patches config.toml, so it must call assertNoDryRunEdit`).toMatch(
        /assertNoDryRunEdit\(/,
      );
    }
  });
});

describe("the restart that makes the flip real is never forgotten", () => {
  it("an unknown daemon state is not a stopped daemon — the restart stays owed", async () => {
    seedChoices({ [PROOF_CHOICE_KEY]: PROOF });
    // The proof re-check runs (exec answers), but the state probe cannot.
    const h = harness({ psFails: true });
    const result = await h.engine.runStep(GO_LIVE_STEP_ID, {
      decision: "go_live",
      confirm: GO_LIVE_CONFIRMATION,
    });
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/daemon-restart: could not tell whether the daemon is running/);
    expect(h.restarts).toEqual([]);
  });

  it("a failed restart after a recorded decline keeps verify red until a run pays it", async () => {
    seedChoices({ [PROOF_CHOICE_KEY]: PROOF, [GO_LIVE_CHOICE_KEY]: "dry_run" });
    const failing = harness({ restartCode: 1 });
    const flip = await failing.engine.runStep(GO_LIVE_STEP_ID, {
      decision: "go_live",
      confirm: GO_LIVE_CONFIRMATION,
    });
    expect(flip.ok).toBe(false);
    expect(dryRunOnDisk()).toBe(false);
    const red = await failing.engine.finish();
    expect(red.ok).toBe(false);
    if (!red.ok) expect(red.results[0]!.failures.join(" ")).toMatch(/restart .* did not complete/);

    const healthy = harness();
    const paid = await healthy.engine.runStep(GO_LIVE_STEP_ID, {
      decision: "go_live",
      confirm: GO_LIVE_CONFIRMATION,
    });
    expect(paid.ok).toBe(true);
    expect(healthy.restarts).toHaveLength(1);
    expect((await healthy.engine.finish()).ok).toBe(true);
  });

  it("a later decline pays off the owed restart, so a hand flip after it verifies live", async () => {
    seedChoices({ [PROOF_CHOICE_KEY]: PROOF });
    await harness({ restartCode: 1 }).engine.runStep(GO_LIVE_STEP_ID, {
      decision: "go_live",
      confirm: GO_LIVE_CONFIRMATION,
    });
    writeFileSync(join(root, "config.toml"), configText().replace(/^dry_run = false/m, "dry_run = true"));
    const declined = await harness().engine.runStep(GO_LIVE_STEP_ID, { decision: "stay_dry_run" });
    expect(declined.ok).toBe(true);
    writeFileSync(join(root, "config.toml"), configText().replace(/^dry_run = true/m, "dry_run = false"));
    expect((await harness().engine.verifyAll()).ok).toBe(true);
  });

  it("re-offering on a LIVE installation says it is live, not that dry_run is true", async () => {
    writeFileSync(join(root, "config.toml"), exampleConfig.replace(/^dry_run = true/m, "dry_run = false"));
    seedChoices({ [PROOF_CHOICE_KEY]: PROOF });
    const result = await harness().engine.runStep(GO_LIVE_STEP_ID, {});
    const offer = result.checks.map((c) => c.detail).join(" ");
    expect(offer).toMatch(/already LIVE/);
    expect(offer).not.toMatch(/Right now `dry_run = true`/);
  });

  it("names the escalation exception rather than promising never to nominate a reviewer", () => {
    expect(GO_LIVE_EXPLANATION).not.toMatch(/never nominates a human reviewer/);
    expect(GO_LIVE_EXPLANATION).toMatch(/nominates a human reviewer only/);
  });
});

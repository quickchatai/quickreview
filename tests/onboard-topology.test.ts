// the topology question: where the reviewer lives.
//
// The three properties worth pinning: both answers are offered as first-class
// (with the server route named as the recommendation), the recorded choice is
// the ONE place every later step reads, and switching topology is a guided,
// explicit act rather than a silent reconfiguration.
//
// Everything faked: temp dirs for the state root, a fake clock. This step
// touches no process, no network and no file except the checklist the engine
// writes for it.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OnboardingEngine, checklistPath, type OnboardAdapters } from "../src/onboard/engine.js";
import { CHOICE_KEYS } from "../src/onboard/steps/configfill.js";
import { defaultSteps } from "../src/onboard/steps/index.js";
import { SSH_PREFLIGHT_STEP_ID } from "../src/onboard/steps/ssh.js";
import {
  SSH_ALIAS_CHOICE_KEY,
  TOPOLOGY_CHOICE_KEY,
  TOPOLOGY_OPTIONS,
  TOPOLOGY_STEP_ID,
  TOPOLOGY_SWITCH_CONFIRMATION,
  topologyOf,
  topologyRecorded,
  topologyStep,
} from "../src/onboard/steps/topology.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "qcr-topology-"));
  mkdirSync(join(root, "state"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function adapters(): OnboardAdapters {
  return {
    fetch: (() => {
      throw new Error("no network in tests");
    }) as unknown as typeof fetch,
    runner: { run: async () => ({ code: 127, stdout: "", stderr: "no process in tests" }) },
    clock: () => new Date("2026-08-30T12:00:00Z"),
    host: { nodeVersion: "v22.5.1", uid: 1000 },
    paths: { stateDir: join(root, "state"), configPath: join(root, "config.toml") },
  };
}

function engine(): OnboardingEngine {
  return new OnboardingEngine([topologyStep()], adapters());
}

function recordedChoices(): Record<string, unknown> {
  return (
    JSON.parse(readFileSync(checklistPath(join(root, "state")), "utf8")) as {
      choices: Record<string, unknown>;
    }
  ).choices;
}

describe("the offer", () => {
  it("reads out both answers, with the server route named as the recommendation", async () => {
    const result = await engine().runStep(TOPOLOGY_STEP_ID);
    expect(result.ok).toBe(false);
    const offer = result.checks[0]!.detail;
    expect(offer).toMatch(/vm: /);
    expect(offer).toMatch(/local: /);
    expect(offer).toMatch(/RECOMMENDED/);
    expect(offer).toMatch(/asleep reviews nothing/);
    // Neither answer is presented as the advanced one.
    expect(offer).toMatch(/Neither answer is the advanced one/);
    // The laptop route keeps its own real case.
    expect(offer).toMatch(/nothing else to own/i);
  });

  it("the VM option states the trade honestly: you bring the box, and it uses the real deploy", () => {
    const vm = TOPOLOGY_OPTIONS.find((o) => o.id === "vm")!;
    expect(vm.tradeoffs.join(" ")).toMatch(/you bring the box/);
    expect(vm.tradeoffs.join(" ")).toMatch(/clean tree, version-pin coherence, disk space/);
    expect(vm.tradeoffs.join(" ")).toMatch(/named Cloudflare tunnel/);
  });
});

describe("recording the choice", () => {
  it('"local" is recorded and needs nothing else', async () => {
    const e = engine();
    const result = await e.runStep(TOPOLOGY_STEP_ID, { choice: "local" });
    expect(result.ok).toBe(true);
    expect(recordedChoices()[TOPOLOGY_CHOICE_KEY]).toBe("local");
    expect((await e.verifyAll()).ok).toBe(true);
  });

  it('"vm" without an ssh alias refuses and records nothing', async () => {
    const result = await engine().runStep(TOPOLOGY_STEP_ID, { choice: "vm" });
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/needs the ssh alias/);
    expect(recordedChoices()[TOPOLOGY_CHOICE_KEY]).toBeUndefined();
  });

  it('"vm" with an alias records both, in the one place later steps read', async () => {
    const result = await engine().runStep(TOPOLOGY_STEP_ID, {
      choice: "vm",
      ssh_host: "review-box",
    });
    expect(result.ok).toBe(true);
    const choices = recordedChoices();
    expect(choices[TOPOLOGY_CHOICE_KEY]).toBe("vm");
    expect(choices[SSH_ALIAS_CHOICE_KEY]).toBe("review-box");
    // The key IS the one config_fill and every step already read.
    expect(TOPOLOGY_CHOICE_KEY).toBe(CHOICE_KEYS.topology);
    expect(topologyOf(choices)).toBe("vm");
  });

  it("a URL or user@host is not an alias, and is refused rather than recorded", async () => {
    for (const bad of ["https://vm.example.com", "me@vm.example.com", "vm.example.com:2222"]) {
      const result = await engine().runStep(TOPOLOGY_STEP_ID, { choice: "vm", ssh_host: bad });
      expect(result.ok, bad).toBe(false);
      expect(result.failures.join(" ")).toMatch(/not an ssh alias/);
    }
  });

  it("an unrecorded topology defaults to local, but topologyRecorded can still tell unset from local", () => {
    expect(topologyOf({})).toBe("local");
    expect(topologyRecorded({})).toBeNull();
    expect(topologyRecorded({ [TOPOLOGY_CHOICE_KEY]: "local" })).toBe("local");
  });
});

describe("switching topology is explicit, never silent", () => {
  it("a different answer on a re-run refuses once and says what changes", async () => {
    const e = engine();
    await e.runStep(TOPOLOGY_STEP_ID, { choice: "local" });
    const result = await e.runStep(TOPOLOGY_STEP_ID, { choice: "vm", ssh_host: "review-box" });
    expect(result.ok).toBe(false);
    const said = result.failures.join(" ");
    expect(said).toMatch(/recorded "local" earlier and are now asking for "vm"/);
    expect(said).toMatch(/NOTHING IS TORN DOWN/);
    expect(said).toMatch(/everything you have already answered is kept/i);
    expect(said).toMatch(new RegExp(TOPOLOGY_SWITCH_CONFIRMATION));
    // Nothing moved.
    expect(recordedChoices()[TOPOLOGY_CHOICE_KEY]).toBe("local");
  });

  it("the confirmation phrase switches it, and says so", async () => {
    const e = engine();
    await e.runStep(TOPOLOGY_STEP_ID, { choice: "local" });
    const result = await e.runStep(TOPOLOGY_STEP_ID, {
      choice: "vm",
      ssh_host: "review-box",
      confirm: TOPOLOGY_SWITCH_CONFIRMATION,
    });
    expect(result.ok).toBe(true);
    expect(result.checks.find((c) => c.name === "switch")!.detail).toMatch(
      /switched from "local" to "vm"/,
    );
    expect(recordedChoices()[TOPOLOGY_CHOICE_KEY]).toBe("vm");
  });

  it("re-affirming the SAME topology is not a switch and needs no confirmation", async () => {
    const e = engine();
    await e.runStep(TOPOLOGY_STEP_ID, { choice: "vm", ssh_host: "review-box" });
    const again = await e.runStep(TOPOLOGY_STEP_ID, { choice: "vm" });
    expect(again.ok).toBe(true);
    expect(again.checks.some((c) => c.name === "switch")).toBe(false);
    expect(recordedChoices()[SSH_ALIAS_CHOICE_KEY]).toBe("review-box");
  });
});

describe("the recorded topology steers the whole checklist", () => {
  const idsWithStatus = (choices: Record<string, unknown>): Record<string, string> => {
    mkdirSync(join(root, "state", "onboarding"), { recursive: true });
    const e = new OnboardingEngine(defaultSteps(), {
      ...adapters(),
      paths: { stateDir: join(root, "state"), configPath: join(root, "config.toml") },
    });
    // Seed choices the way a completed topology step would have.
    (e as unknown as { checklist: { choices: Record<string, unknown> } }).checklist.choices =
      choices;
    return Object.fromEntries(e.list().map((l) => [l.id, l.status]));
  };

  it("the compose bring-up is skipped on the server route, and the ssh route's steps on the laptop", () => {
    const onVm = idsWithStatus({
      [TOPOLOGY_CHOICE_KEY]: "vm",
      [SSH_ALIAS_CHOICE_KEY]: "review-box",
    });
    expect(onVm.bringup).toBe("disabled");
    expect(onVm[SSH_PREFLIGHT_STEP_ID]).toBe("pending");
    expect(onVm.vm_inventory).toBe("pending");
    expect(onVm.vm_deploy).toBe("pending");

    const onLocal = idsWithStatus({ [TOPOLOGY_CHOICE_KEY]: "local" });
    expect(onLocal.bringup).toBe("pending");
    expect(onLocal[SSH_PREFLIGHT_STEP_ID]).toBe("disabled");
    expect(onLocal.vm_inventory).toBe("disabled");
    expect(onLocal.vm_deploy).toBe("disabled");
  });

  it("verification, the proof round and the flip belong to BOTH routes — one implementation, not a copy", () => {
    for (const topology of ["local", "vm"]) {
      const statuses = idsWithStatus({
        [TOPOLOGY_CHOICE_KEY]: topology,
        [SSH_ALIAS_CHOICE_KEY]: "review-box",
      });
      for (const id of [
        "memory",
        "memory_user_keys",
        "app_slug_reconcile",
        "verify_stack",
        "proof_round",
        "go_live",
      ]) {
        expect(statuses[id], `${id} on ${topology}`).not.toBe("disabled");
      }
    }
  });

  it("the topology question comes before LLM auth, and the ssh preflight before every deploy step", () => {
    const order = (id: string): number => defaultSteps().find((s) => s.id === id)!.order;
    expect(order(TOPOLOGY_STEP_ID)).toBeGreaterThan(order("preflight"));
    expect(order(TOPOLOGY_STEP_ID)).toBeLessThan(order("llm_auth"));
    expect(order(SSH_PREFLIGHT_STEP_ID)).toBeGreaterThan(order(TOPOLOGY_STEP_ID));
    for (const later of ["config_fill", "github_app", "memory", "vm_inventory", "vm_deploy"]) {
      expect(order(SSH_PREFLIGHT_STEP_ID), later).toBeLessThan(order(later));
    }
  });
});

describe("verify", () => {
  it("is red until a topology is recorded, and names the alias afterwards", async () => {
    const e = engine();
    expect((await e.verifyAll()).ok).toBe(false);
    await e.runStep(TOPOLOGY_STEP_ID, { choice: "vm", ssh_host: "review-box" });
    const after = await e.verifyAll();
    expect(after.ok).toBe(true);
  });
});

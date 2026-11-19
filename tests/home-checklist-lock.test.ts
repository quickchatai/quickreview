// The home's switches and the checklist lock (src/onboard/checklistlock.ts).
// Every switch of the home that runs a step writes the setup checklist, and
// so do a host's verbs (src/host/): each takes the one lock around its steps,
// and the home, finding it taken, says by what and runs nothing. Driven at
// the home's real adapters (auto-review, memory, Advanced) over a scratch
// stack with a fake Docker.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { composeAdvanced } from "../src/home/advanced.js";
import { composeAutoReview } from "../src/home/autoreview.js";
import { composeMemory } from "../src/home/memory.js";
import {
  acquireChecklistLock,
  checklistLockPath,
  type HeldLock,
  type LockHolder,
} from "../src/onboard/checklistlock.js";
import type { OnboardAdapters, ProcessResult } from "../src/onboard/engine.js";

const CONFIG = 'dry_run = true\n\n[github]\nrepo = "acme/widgets"\n';

let root: string;
let stateDir: string;
let calls: string[][];
let built: number;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "qcr-homelock-"));
  stateDir = join(root, "state");
  calls = [];
  built = 0;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const runner = {
  run: async (cmd: string, args: string[]): Promise<ProcessResult> => {
    calls.push([cmd, ...args]);
    return { code: 1, stdout: "", stderr: "no docker in this test" };
  },
};

/** The wizard's adapters over the scratch stack; counts how often a switch
 * asked for them. */
const stepAdapters = (): OnboardAdapters => {
  built += 1;
  return {
    fetch: (() => Promise.reject(new Error("no network"))) as unknown as typeof fetch,
    runner,
    clock: () => new Date("2026-11-19T12:00:00Z"),
    host: { nodeVersion: "v26.1.0", uid: 1000 },
    paths: { stateDir, configPath: join(root, "config.toml") },
  };
};

/** The lock, held by a living process that is not a switch of this home. */
function heldBy(holder: LockHolder): HeldLock {
  const got = acquireChecklistLock(stateDir, holder, { pid: process.pid });
  if (!got.ok) throw new Error("the lock was not free");
  return got.lock;
}

const autoReview = () =>
  composeAutoReview({
    root,
    configPath: () => join(root, "config.toml"),
    runner,
    stepAdapters,
    now: () => Date.parse("2026-11-19T12:00:00Z"),
    read: () => CONFIG,
    portFree: async () => true,
  }).control!;

describe("auto-review's switch", () => {
  // MUTATION: build the engine in control.machineChecks without the lock —
  // the step runs (Docker is asked) while a host's setup holds the
  // checklist, and this fails.
  it("runs no step while a host's setup holds the checklist, and says whose it is", async () => {
    heldBy("setup");
    const control = autoReview();
    const checks = await control.machineChecks();
    expect(checks.ok).toBe(false);
    expect(checks.detail).toMatch(
      /^your host is setting the reviewer up right now; try again when it has finished$/,
    );
    const on = await control.switchOn({ memory: null, confirmed: true });
    expect(on).toEqual({ ok: false, live: false, detail: checks.detail, steps: [] });
    expect(await control.proofRound(7)).toEqual({ ok: false, detail: checks.detail });
    expect(calls).toEqual([]);
    expect(existsSync(join(stateDir, "onboarding", "checklist.json"))).toBe(false);
  });

  // MUTATION: let control.goLive through while a host's go-live holds the
  // lock — two processes then run the go-live step at once, and this fails.
  it("does not go live while a host's go-live runs", async () => {
    heldBy("go_live");
    const out = await autoReview().goLive({ confirmed: true });
    expect(out.ok).toBe(false);
    expect(out.detail).toMatch(/your host is taking the reviewer live right now/);
    expect(calls).toEqual([]);
  });

  it("with the lock free it runs its step, and gives the lock back", async () => {
    const checks = await autoReview().machineChecks();
    // the step was reached: Docker was asked (and is not there in this test)
    expect(calls.length).toBeGreaterThan(0);
    expect(checks.ok).toBe(false);
    expect(checks.detail).not.toMatch(/right now/);
    expect(existsSync(checklistLockPath(stateDir))).toBe(false);
  });

  it("reading the recorded proof takes no lock", async () => {
    heldBy("setup");
    expect(await autoReview().proof()).toBeNull();
  });
});

describe("memory's switch", () => {
  // MUTATION: run memory's steps without the lock — this fails.
  it("runs no step while a host verb holds the checklist", async () => {
    heldBy("proof");
    const memory = composeMemory({
      root,
      runner,
      stepAdapters,
      repo: async () => "acme/widgets",
    });
    const out = await memory.control!.switchOn();
    expect(out.ok).toBe(false);
    expect(out.detail).toMatch(/your host is reading a practice review right now; try again/);
    expect(calls).toEqual([]);
  });
});

describe("Advanced's routes", () => {
  // MUTATION: drop `exclusive` from composeAdvanced — a route's steps then
  // run beside a host's walk, and this fails.
  it("run under the same lock: a taken one answers through `busy`, and the route does not run", async () => {
    const port = composeAdvanced({ root, env: {}, stepAdapters });
    expect(port.exclusive).toBeDefined();
    const lock = heldBy("setup");
    let ran = 0;
    const run = async (): Promise<string> => {
      ran += 1;
      return "ran";
    };
    expect(await port.exclusive!(run, (why) => `busy: ${why}`)).toMatch(
      /^busy: your host is setting the reviewer up right now; try again/,
    );
    expect(ran).toBe(0);
    lock.release();
    expect(await port.exclusive!(run, () => "busy")).toBe("ran");
    expect(existsSync(checklistLockPath(stateDir))).toBe(false);
    expect(built).toBeGreaterThan(0);
  });
});

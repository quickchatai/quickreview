// What triggers a review, as a host says it for its operator: `host setup
// --trigger label|all` records it in the config it writes
// (src/host/setup.ts), and `host set-trigger label|all` changes it later
// (src/host/trigger.ts) by sending it to the running daemon through the
// sealed operator channel, under the checklist lock, on installs a host
// manages and on no other. The config is never rewritten by it: the daemon
// keeps the choice (tests/trigger-choice.test.ts).
//
// Driven over the host rig: the config is a real file in a scratch directory,
// GitHub and Docker are fakes.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GITHUB_TRIGGERS } from "@quickchatai/pi-quickreview/src/reviewconfig.js";
import { configFacts } from "../src/boardexport.js";
import { validateCommand } from "../src/commands.js";
import { TRIGGER_WORDS } from "../src/host/outcomes.js";
import { hostSetup, parseSetupArgs } from "../src/host/setup.js";
import {
  SET_TRIGGER_USAGE,
  hostSetTrigger,
  parseTriggerArg,
  setTriggerWriteArgv,
} from "../src/host/trigger.js";
import { acquireChecklistLock } from "../src/onboard/checklistlock.js";
import { renderHostConfig, type HostConfigChoice } from "../src/onboard/steps/hostconfig.js";
import { triggerOfToml } from "../src/triggerchoice.js";
import {
  MARKER_ONLY,
  REPO,
  TEMPLATE,
  WALK_PID,
  hostWorld,
  setUpConfig,
  type HostWorld,
} from "./helpers/host-rig.js";

type Doc = Record<string, unknown>;
const doc = (text: string): Doc => parse(text) as Doc;
const githubOf = (text: string): Doc => (doc(text)["github"] ?? {}) as Doc;

describe("the shipped template", () => {
  it("documents the key, commented out: a config without it is label", () => {
    expect(TEMPLATE).toMatch(/^#trigger = "label"$/m);
    expect(githubOf(TEMPLATE)).not.toHaveProperty("trigger");
    expect(triggerOfToml(TEMPLATE)).toBe("label");
    // and it says what `all` costs, where the person who sets it reads
    expect(TEMPLATE).toMatch(/model usage on EVERY pull request/);
  });
});

// ---- host setup --trigger ----------------------------------------------------------

describe("host setup --trigger", () => {
  const ARGS = ["--repo", REPO, "--auth", "user"];
  const CHOICE: HostConfigChoice = {
    repo: REPO,
    baseBranch: "trunk",
    timezone: "Europe/Warsaw",
    auth: "user",
  };
  let w: HostWorld;
  beforeEach(() => {
    w = hostWorld();
  });
  afterEach(() => w.close());

  it("reads label or all, in either spelling, and refuses anything else as usage", async () => {
    expect(parseSetupArgs([...ARGS, "--trigger", "all"])).toEqual({
      repo: REPO,
      auth: "user",
      trigger: "all",
    });
    expect(parseSetupArgs(["--trigger=label", ...ARGS])).toEqual({
      repo: REPO,
      auth: "user",
      trigger: "label",
    });
    // left out, it is not in the answer: the config's own stays
    expect(parseSetupArgs(ARGS)).toEqual({ repo: REPO, auth: "user" });
    for (const [args, said] of [
      [[...ARGS, "--trigger", "every"], /--trigger "every" is neither label nor all/],
      [[...ARGS, "--trigger"], /--trigger names nothing/],
      [[...ARGS, "--trigger", "all", "--trigger", "label"], /--trigger is given twice/],
    ] as const)
      expect(parseSetupArgs(args), args.join(" ")).toMatch(said);

    const out = await hostSetup(w.ports, [...ARGS, "--trigger", "every"]);
    expect(out).toMatchObject({ state: "refused", reason: "usage" });
    expect(out.message).toMatch(/\[--trigger label\|all\]/);
    expect(w.config()).toBeNull();
    expect(w.launched).toEqual([]);
  });

  // MUTATION: drop the `trigger` edit from renderHostConfig's list, or the
  // `trigger: asked.trigger` hand-over in hostSetup — the config comes out
  // without the key, the reviewer picks up labelled pull requests only, and
  // this fails.
  it("records it in the config it writes, beside the marker and still in dry-run", async () => {
    expect(await hostSetup(w.ports, [...ARGS, "--trigger", "all"])).toEqual({ state: "started" });
    const text = w.config()!;
    expect(githubOf(text)).toMatchObject({
      token_source: "host",
      auth: "user",
      repo: REPO,
      trigger: "all",
    });
    expect(doc(text)["dry_run"]).toBe(true);
    // the template, line for line: the key was a line of it already
    expect(text.split("\n").length).toBe(TEMPLATE.split("\n").length);
    // what the export says, and what the daemon's own reader says
    expect(configFacts(text).trigger).toBe("all");
    expect(triggerOfToml(text)).toBe("all");
    expect(w.launched).toHaveLength(1);
  });

  it("left out, a new config states none (label), and --trigger label states it", async () => {
    expect(await hostSetup(w.ports, ARGS)).toEqual({ state: "started" });
    expect(githubOf(w.config()!)).not.toHaveProperty("trigger");
    expect(configFacts(w.config()!).trigger).toBe("label");

    const stated = renderHostConfig(null, TEMPLATE, { ...CHOICE, trigger: "label" });
    expect(stated.ok && githubOf(stated.text)["trigger"]).toBe("label");
  });

  // A second setup call (a retry) that names no trigger must not undo the
  // person's choice.
  it("left out on a config that is there, the config's own trigger stays", () => {
    const first = renderHostConfig(null, TEMPLATE, { ...CHOICE, trigger: "all" });
    if (!first.ok) throw new Error(first.why);
    const again = renderHostConfig(first.text, TEMPLATE, CHOICE);
    expect(again).toMatchObject({ ok: true, text: first.text });
    const changed = renderHostConfig(first.text, TEMPLATE, { ...CHOICE, trigger: "label" });
    expect(changed.ok && githubOf(changed.text)["trigger"]).toBe("label");
    expect(changed.ok && doc(changed.text)["dry_run"]).toBe(true);
  });
});

// ---- host set-trigger -------------------------------------------------------------

describe("host set-trigger", () => {
  let w: HostWorld;
  /** Every path the verb wrote. */
  let writes: string[];
  let ports: HostWorld["ports"];
  beforeEach(() => {
    w = hostWorld();
    writes = [];
    ports = {
      ...w.ports,
      write: (path, text) => {
        writes.push(path);
        w.ports.write(path, text);
      },
    };
  });
  afterEach(() => w.close());

  /** The set-trigger commands handed to the daemon, as written. */
  const sent = (): Record<string, unknown>[] =>
    w.daemon.payloads.filter((p) => p["command"] === "set-trigger");
  /** Nothing was asked of GitHub, and nothing was started or written. */
  const quiet = (): void => {
    expect(w.github).toEqual([]);
    expect(w.launched).toEqual([]);
    expect(w.ran).toEqual([]);
    expect(writes).toEqual([]);
  };
  /** The lock is free: the next taker gets it. */
  const lockFree = (): void => {
    const got = acquireChecklistLock(w.stateDir, "home", { pid: WALK_PID, alive: () => true });
    expect(got.ok).toBe(true);
    if (got.ok) got.lock.release();
  };

  it("takes one word, label or all", async () => {
    expect([...TRIGGER_WORDS]).toEqual([...GITHUB_TRIGGERS]);
    expect(parseTriggerArg(["all"])).toEqual({ trigger: "all" });
    expect(parseTriggerArg(["label"])).toEqual({ trigger: "label" });
    w.writeConfig(setUpConfig());
    const before = w.config();
    for (const args of [[], ["all", "label"], ["every"], ["--trigger", "all"], ["ALL"], [""]]) {
      const out = await hostSetTrigger(ports, args);
      expect(out, args.join(" ")).toMatchObject({ state: "refused", reason: "usage" });
      expect(out.message).toContain(SET_TRIGGER_USAGE);
    }
    expect(w.config()).toBe(before);
    expect(w.calls).toEqual([]);
    expect(sent()).toEqual([]);
    expect(existsSync(join(w.stateDir, "onboarding"))).toBe(false);
    quiet();
  });

  // MUTATION: drop the execAsRoot write from hostSetTrigger, or write the
  // config instead — the daemon is handed nothing (or the config moves), and
  // this fails.
  it("hands the choice to the running daemon on its sealed channel, and answers done with it; the config is not touched", async () => {
    w.writeConfig(setUpConfig());
    const before = w.config();
    expect(await hostSetTrigger(ports, ["all"])).toEqual({ state: "done", trigger: "all" });
    expect(sent()).toEqual([{ command: "set-trigger", trigger: "all" }]);
    expect(w.daemon.written).toEqual([expect.stringMatching(/-host-settrigger-all\.json$/)]);
    // written as root, into the operator's directory
    const write = w.calls.find((c) => c.includes("-u"));
    expect(write?.at(-1)).toContain("/opt/qcr/commands/operator");
    // what was written is what the daemon's validator takes, from that channel alone
    expect(validateCommand(sent()[0], { issuer: "operator" })).toEqual({
      ok: true,
      command: { command: "set-trigger", trigger: "all" },
    });
    expect(validateCommand(sent()[0], { issuer: "session" }).ok).toBe(false);
    expect(w.config()).toBe(before);
    quiet();
    lockFree();

    expect(await hostSetTrigger(ports, ["label"])).toEqual({ state: "done", trigger: "label" });
    expect(sent().map((p) => p["trigger"])).toEqual(["all", "label"]);
    expect(w.config()).toBe(before);
  });

  it("the command is built from the closed word alone", () => {
    expect(() => setTriggerWriteArgv("x.json", "every" as never)).toThrow(/not a trigger/);
    const [, , script] = setTriggerWriteArgv("x.json", "all");
    expect(script).toMatch(/^printf '%s\\n' '\{"command":"set-trigger","trigger":"all"\}' \| \(/);
  });

  // MUTATION: answer `done` before the daemon's receipt (drop the receipt
  // loop) — a choice the daemon never took reads as taken, and this fails.
  it("sent: the daemon has not answered yet; refused when it says no", async () => {
    w.writeConfig(setUpConfig());
    w.daemon.receipt = "pending";
    expect(await hostSetTrigger(ports, ["all"])).toEqual({ state: "sent", trigger: "all" });
    expect(sent()).toHaveLength(1);
    w.daemon.receipt = "refused";
    const out = await hostSetTrigger(ports, ["all"]);
    expect(out).toMatchObject({ state: "refused", reason: "trigger_refused" });
    expect(out.message).toMatch(/refused the trigger "all"/);
    quiet();
    lockFree();
  });

  it("needs a reviewer to tell: set up, running and reachable, or nothing is sent", async () => {
    // before setup: the choice goes with `host setup --trigger`
    w.writeConfig(MARKER_ONLY);
    expect(await hostSetTrigger(ports, ["all"])).toMatchObject({
      state: "refused",
      reason: "not_set_up",
    });
    w.writeConfig(setUpConfig());
    w.daemon.running = false;
    expect(await hostSetTrigger(ports, ["all"])).toMatchObject({
      state: "refused",
      reason: "reviewer_not_running",
    });
    w.daemon.running = true;
    w.daemon.psFails = true;
    expect(await hostSetTrigger(ports, ["all"])).toMatchObject({
      state: "refused",
      reason: "reviewer_unreachable",
    });
    w.daemon.psFails = false;
    w.daemon.writeFails = true;
    const out = await hostSetTrigger(ports, ["all"]);
    expect(out).toMatchObject({ state: "refused", reason: "reviewer_unreachable" });
    expect(out.message).toMatch(/could not be handed to the reviewer.*Nothing changed/);
    expect(sent()).toEqual([]);
    quiet();
    lockFree();
  });

  // The flag is the owner's: a host that changes the trigger moves nothing.
  it("leaves the config byte for byte as it stood, on a reviewer in practice mode and on a live one", async () => {
    for (const dryRun of [true, false]) {
      w.writeConfig(setUpConfig({ dryRun }));
      const before = w.config();
      expect(await hostSetTrigger(ports, ["all"])).toMatchObject({ state: "done" });
      expect(w.config()).toBe(before);
      expect(doc(w.config()!)["dry_run"]).toBe(dryRun);
    }
    quiet();
  });

  // MUTATION: drop `hostManagedRefusal` from hostSetTrigger — the verb hands a
  // choice to a daemon whose install keeps its own credential, and this fails.
  it("acts on a host-managed install only: any other is refused before anything is touched", async () => {
    // no config at all
    expect(await hostSetTrigger(ports, ["all"])).toMatchObject({
      state: "refused",
      reason: "not_host_managed",
    });
    expect(w.config()).toBeNull();
    // an install that keeps its own credential, in each posture
    for (const dryRun of [true, false]) {
      w.writeConfig(setUpConfig({ dryRun, hosted: false }));
      const before = w.config();
      const out = await hostSetTrigger(ports, ["all"]);
      expect(out).toMatchObject({ state: "refused", reason: "not_host_managed" });
      expect(out.message).toMatch(/Nothing changed/);
      expect(w.config()).toBe(before);
    }
    // a config that is not TOML carries no marker
    w.writeConfig("= not toml");
    expect(await hostSetTrigger(ports, ["all"])).toMatchObject({ reason: "not_host_managed" });
    // not even the lock was taken, and Docker was not asked
    expect(existsSync(join(w.stateDir, "onboarding"))).toBe(false);
    expect(w.calls).toEqual([]);
    expect(sent()).toEqual([]);
    quiet();
  });

  // The marker is asked twice: before the lock (so a refusal leaves no file
  // behind), and again under it.
  // MUTATION: drop the second check, on the text read under the lock — a
  // config that lost its marker between the two reads still has its daemon
  // told, and this fails.
  it("reads the marker again under the lock: a config that lost it in between is left alone", async () => {
    w.writeConfig(setUpConfig());
    const own = setUpConfig({ hosted: false });
    let reads = 0;
    const racing: HostWorld["ports"] = {
      ...ports,
      read: (path) => {
        const text = w.ports.read(path);
        // after the first look at the config, its owner takes it back
        if (path === w.configPath && ++reads === 1) w.writeConfig(own);
        return text;
      },
    };
    const out = await hostSetTrigger(racing, ["all"]);
    expect(out).toMatchObject({ state: "refused", reason: "not_host_managed" });
    expect(reads).toBe(2);
    expect(w.config()).toBe(own);
    expect(sent()).toEqual([]);
    lockFree();
  });

  // MUTATION: drop the checklist lock from hostSetTrigger — the choice is
  // sent while a walk that may be restarting the daemon runs, and this fails.
  it("is single-flight under the checklist lock: while anything holds it, busy and nothing is sent", async () => {
    w.writeConfig(setUpConfig());
    for (const holder of ["setup", "go_live", "proof", "home", "trigger"] as const) {
      const held = acquireChecklistLock(w.stateDir, holder, {
        pid: WALK_PID,
        alive: () => true,
      });
      expect(held.ok).toBe(true);
      expect(await hostSetTrigger(ports, ["all"]), holder).toEqual({ state: "busy", holder });
      if (held.ok) held.lock.release();
    }
    expect(sent()).toEqual([]);
    // free again: the same call goes through, and gives the lock back
    expect(await hostSetTrigger(ports, ["all"])).toEqual({ state: "done", trigger: "all" });
    lockFree();
  });
});

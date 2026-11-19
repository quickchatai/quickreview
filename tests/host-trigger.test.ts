// What triggers a review, as a host says it for its operator: `host setup
// --trigger label|all` records it (src/host/setup.ts), and `host set-trigger
// label|all` changes it later (src/host/trigger.ts) with one edit of the
// config (src/onboard/steps/triggerconfig.ts), under the checklist lock, on
// installs a host manages and on no other. Nothing is started or restarted:
// the running daemon follows the key by itself (tests/live-trigger.test.ts).
//
// Driven over the host rig: the config is a real file in a scratch directory,
// GitHub and Docker are fakes.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GITHUB_TRIGGERS } from "@quickchatai/pi-quickreview/src/reviewconfig.js";
import { configFacts } from "../src/boardexport.js";
import { TRIGGER_WORDS } from "../src/host/outcomes.js";
import { hostSetup, parseSetupArgs } from "../src/host/setup.js";
import { SET_TRIGGER_USAGE, hostSetTrigger, parseTriggerArg } from "../src/host/trigger.js";
import { liveTrigger, triggerOfToml } from "../src/livetrigger.js";
import { acquireChecklistLock } from "../src/onboard/checklistlock.js";
import { renderHostConfig, type HostConfigChoice } from "../src/onboard/steps/hostconfig.js";
import { renderTriggerConfig } from "../src/onboard/steps/triggerconfig.js";
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
/** The root `dry_run` line as written, comment and all. */
const dryRunLine = (text: string): string | undefined => /^dry_run\s*=.*$/m.exec(text)?.[0];
/** The lines two texts of the same length differ in, as the second has them. */
const changedLines = (a: string, b: string): string[] => {
  const before = a.split("\n");
  return b.split("\n").filter((line, i) => line !== before[i]);
};
/** `text` read as TOML, without the trigger. */
const withoutTrigger = (text: string): Doc => {
  const d = doc(text);
  const github = { ...((d["github"] ?? {}) as Doc) };
  delete github["trigger"];
  return { ...d, github };
};
const rendered = (existing: string, trigger: "label" | "all"): string => {
  const r = renderTriggerConfig(existing, trigger);
  if (!r.ok) throw new Error(r.why);
  return r.text;
};

// ---- the one edit ----------------------------------------------------------------

describe("the config text with the trigger in it", () => {
  it("the shipped template documents the key, commented out: a config without it is label", () => {
    expect(TEMPLATE).toMatch(/^#trigger = "label"$/m);
    expect(githubOf(TEMPLATE)).not.toHaveProperty("trigger");
    expect(triggerOfToml(TEMPLATE)).toBe("label");
    // and it says what `all` costs, where the person who sets it reads
    expect(TEMPLATE).toMatch(/model usage on EVERY pull request/);
  });

  // MUTATION: append the key at the end of the file instead of patching the
  // `[github]` table — a second line changes (or the key lands in another
  // table), and this fails.
  it("is that one line, in place: every other line is the config's own", () => {
    const before = setUpConfig();
    const after = rendered(before, "all");
    expect(after.split("\n").length).toBe(before.split("\n").length);
    expect(changedLines(before, after)).toEqual(['trigger = "all"']);
    expect(githubOf(after)["trigger"]).toBe("all");
    expect(withoutTrigger(after)).toEqual(withoutTrigger(before));
    expect(dryRunLine(after)).toBe(dryRunLine(before));

    // and back: the value alone is replaced
    const back = rendered(after, "label");
    expect(changedLines(after, back)).toEqual(['trigger = "label"']);
    expect(triggerOfToml(back)).toBe("label");
  });

  it("a config that holds only a host's marker gets the key in its own table", () => {
    const after = rendered(MARKER_ONLY, "all");
    expect(doc(after)).toEqual({ github: { token_source: "host", trigger: "all" } });
    expect(after.startsWith(MARKER_ONLY.trimEnd())).toBe(true);
  });

  it("a value's trailing comment survives, and a value that is neither is replaced", () => {
    const text = '[github]\ntoken_source = "host"\ntrigger = "every"   # mine\n';
    expect(rendered(text, "all")).toBe(
      '[github]\ntoken_source = "host"\ntrigger = "all"   # mine\n',
    );
  });

  // MUTATION: write the key whenever it is asked for — a call that changes
  // nothing rewrites the config, and this fails.
  it("a config that already says it is handed back as it is", () => {
    const stated = rendered(setUpConfig(), "all");
    expect(renderTriggerConfig(stated, "all")).toEqual({ ok: true, text: stated, changed: false });
    // left out is label: asking for label writes nothing
    const unstated = setUpConfig();
    expect(renderTriggerConfig(unstated, "label")).toEqual({
      ok: true,
      text: unstated,
      changed: false,
    });
    expect(renderTriggerConfig(MARKER_ONLY, "label")).toMatchObject({ changed: false });
    expect(renderTriggerConfig(unstated, "all")).toMatchObject({ ok: true, changed: true });
  });

  // MUTATION: build the edit list in renderTriggerConfig with a second key
  // (the flag, a cap) — the result no longer reads as "the config, and the
  // trigger", and this fails for every posture.
  it("never states another dry_run than the config had, whichever way it stood", () => {
    for (const dryRun of [true, false]) {
      const before = setUpConfig({ dryRun });
      for (const trigger of ["all", "label"] as const) {
        const after = rendered(rendered(before, "all"), trigger);
        expect(doc(after)["dry_run"], `${dryRun} ${trigger}`).toBe(dryRun);
        expect(dryRunLine(after)).toBe(dryRunLine(before));
        expect(withoutTrigger(after)).toEqual(withoutTrigger(before));
      }
    }
  });

  it("refuses a text it cannot read, in one line", () => {
    const bad = renderTriggerConfig("= not toml\nmore", "all");
    expect(bad).toMatchObject({ ok: false });
    expect(bad.ok === false && bad.why).toMatch(
      /^the config is not valid TOML .*nothing was written$/,
    );
    expect(bad.ok === false && bad.why).not.toContain("\n");
    expect(renderTriggerConfig('github = "a string"\n', "all")).toMatchObject({ ok: false });
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

  /** Nothing was asked of Docker or GitHub, and nothing was started. */
  const quiet = (): void => {
    expect(w.calls).toEqual([]);
    expect(w.github).toEqual([]);
    expect(w.launched).toEqual([]);
    expect(w.ran).toEqual([]);
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
    expect(writes).toEqual([]);
    expect(existsSync(join(w.stateDir, "onboarding"))).toBe(false);
    quiet();
  });

  // MUTATION: drop the `ports.write` from hostSetTrigger — the verb answers
  // `done` and the config still says label, and this fails.
  it("states the trigger in the config, and answers with it; nothing is started or restarted", async () => {
    w.writeConfig(setUpConfig());
    const before = w.config()!;
    expect(await hostSetTrigger(ports, ["all"])).toEqual({ state: "done", trigger: "all" });
    const after = w.config()!;
    expect(githubOf(after)["trigger"]).toBe("all");
    expect(changedLines(before, after)).toEqual(['trigger = "all"']);
    expect(writes).toEqual([w.configPath]);
    quiet();
    lockFree();

    // the export says it, and so does the reader the running daemon follows
    expect(configFacts(after).trigger).toBe("all");
    const follows = liveTrigger({ path: w.configPath, initial: "label" });
    expect(follows()).toBe("all");

    // and back
    expect(await hostSetTrigger(ports, ["label"])).toEqual({ state: "done", trigger: "label" });
    expect(configFacts(w.config()!).trigger).toBe("label");
    expect(follows()).toBe("label");
    expect(writes).toEqual([w.configPath, w.configPath]);
    quiet();
  });

  it("a call that changes nothing answers done and writes nothing", async () => {
    w.writeConfig(setUpConfig());
    expect(await hostSetTrigger(ports, ["label"])).toEqual({ state: "done", trigger: "label" });
    expect(await hostSetTrigger(ports, ["all"])).toEqual({ state: "done", trigger: "all" });
    expect(await hostSetTrigger(ports, ["all"])).toEqual({ state: "done", trigger: "all" });
    expect(writes).toEqual([w.configPath]);
    lockFree();
  });

  // The flag is the owner's: a host that changes the trigger moves nothing else.
  it("leaves dry_run as it stood, on a reviewer in practice mode and on a live one", async () => {
    for (const dryRun of [true, false]) {
      w.writeConfig(setUpConfig({ dryRun }));
      const before = w.config()!;
      expect(await hostSetTrigger(ports, ["all"])).toMatchObject({ state: "done" });
      expect(doc(w.config()!)["dry_run"]).toBe(dryRun);
      expect(dryRunLine(w.config()!)).toBe(dryRunLine(before));
      expect(withoutTrigger(w.config()!)).toEqual(withoutTrigger(before));
    }
  });

  // MUTATION: drop `hostManaged` from hostSetTrigger — the verb rewrites the
  // config of an install that keeps its own credential, and this fails.
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
    expect(writes).toEqual([]);
    // not even the lock was taken
    expect(existsSync(join(w.stateDir, "onboarding"))).toBe(false);
    quiet();
  });

  // The marker is asked twice: before the lock (so a refusal leaves no file
  // behind), and again on the very text the edit is made from.
  // MUTATION: drop the second check, on the text read under the lock — a
  // config that lost its marker between the two reads is rewritten; this fails.
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
    expect(writes).toEqual([]);
    lockFree();
  });

  // MUTATION: drop the checklist lock from hostSetTrigger — the config is
  // rewritten while a walk that writes the same file runs, and this fails.
  it("is single-flight under the checklist lock: while anything holds it, busy and nothing changes", async () => {
    w.writeConfig(setUpConfig());
    const before = w.config();
    for (const holder of ["setup", "go_live", "proof", "home", "trigger"] as const) {
      const held = acquireChecklistLock(w.stateDir, holder, {
        pid: WALK_PID,
        alive: () => true,
      });
      expect(held.ok).toBe(true);
      expect(await hostSetTrigger(ports, ["all"]), holder).toEqual({ state: "busy", holder });
      expect(w.config()).toBe(before);
      if (held.ok) held.lock.release();
    }
    expect(writes).toEqual([]);
    // free again: the same call goes through, and gives the lock back
    expect(await hostSetTrigger(ports, ["all"])).toEqual({ state: "done", trigger: "all" });
    lockFree();
  });

  it("a config it cannot write is a refusal in words, with the lock given back", async () => {
    w.writeConfig(setUpConfig());
    const before = w.config();
    const out = await hostSetTrigger(
      {
        ...w.ports,
        write: () => {
          throw new Error("EROFS: read-only file system");
        },
      },
      ["all"],
    );
    expect(out).toMatchObject({ state: "refused", reason: "config_unreadable" });
    expect(out.message).toMatch(/can't write .*EROFS.*Nothing changed/);
    expect(w.config()).toBe(before);
    lockFree();
  });

  // A host may write its marker before any setup: the choice made then is
  // kept by the setup that follows.
  it("before setup, on a config that holds only the marker: the setup that follows keeps the choice", async () => {
    w.writeConfig(MARKER_ONLY);
    expect(await hostSetTrigger(ports, ["all"])).toEqual({ state: "done", trigger: "all" });
    expect(doc(w.config()!)).toEqual({ github: { token_source: "host", trigger: "all" } });

    expect(await hostSetup(w.ports, ["--repo", REPO, "--auth", "user"])).toEqual({
      state: "started",
    });
    expect(githubOf(w.config()!)).toMatchObject({ repo: REPO, trigger: "all" });
    expect(doc(w.config()!)["dry_run"]).toBe(true);
  });
});

// The fences around the host verbs (src/host/), each structural and each
// named with the mutation that proves it bites (tests/fences.test.ts states
// the rules):
//
//   1. Nothing under the host-verb sources writes `dry_run`: they are walked
//      as the home's are (tests/home-switchon.test.ts), and the one config
//      writer they use (the setup's) is held to the flag by what it
//      returns. `set-trigger` writes no config at all.
//   2. The go-live path has exactly its allowed callers. The flag moves in
//      one function, that function has one caller (the go-live step), the
//      step is run with a confirm from one place (`runGoLive`), and
//      `runGoLive` is called from two: the home's switch and the host verb's
//      walk.
//   3. No agent session this system starts can reach a host verb: every verb
//      and both walks refuse under every marker a session sets, the markers
//      are the ones the session launchers set, and inside the daemon's
//      container every verb and both walks refuse for the place alone.
//   4. An attestation takes only a host-managed install live: without the
//      marker in the config as written, the verb refuses and its walk reaches
//      no step.
//   5. Every host verb refuses an install no host manages, before the lock:
//      on one, no proof record is written and the daemon is asked nothing.
//   6. No host verb writes to GitHub: nothing under src/host/ calls a label
//      writer or sends a write method.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOME_DEFAULTS } from "../src/config.js";
import { HOME_TOOLS_ENV } from "../src/home/adapters.js";
import { homeLaunch } from "../src/home/launch.js";
import { admit, hostManaged } from "../src/host/admit.js";
import { runHostVerb } from "../src/host/cli.js";
import { hostGoLive, walkGoLive } from "../src/host/golive.js";
import { HOST_VERBS, type HostVerb } from "../src/host/outcomes.js";
import { hostProofResult, hostProofStart, hostReviewNow } from "../src/host/proof.js";
import { readHostRecord } from "../src/host/record.js";
import { SESSION_ENV_MARKERS, sessionMarker } from "../src/host/session.js";
import { hostSetup } from "../src/host/setup.js";
import { walkSetup } from "../src/host/walk.js";
import { IMAGE_APP_ROOT, detectInstall } from "../src/installkind.js";
import { PI_SESSION_ENV, cmdPi, type NpmVerbDeps } from "../src/npmverbs.js";
import { acquireChecklistLock } from "../src/onboard/checklistlock.js";
import { CHOICE_KEYS } from "../src/onboard/choices.js";
import { GO_LIVE_STEP_ID } from "../src/onboard/steps/golive.js";
import { sourceFiles, stripComments } from "./helpers/engine-fences.js";
import {
  MARKER_ONLY,
  REPO,
  TEMPLATE,
  WALK_PID,
  finishedRound,
  hostWorld,
  setUpConfig,
  type HostWorld,
} from "./helpers/host-rig.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const ROOT = join(import.meta.dirname, "..");
const HOST_DIR = join(ROOT, "src", "host");

interface Source {
  file: string;
  code: string;
}
let scanned: Source[] | undefined;

/** Every source file, repo-relative, with its code (comments removed: a
 * fence reads what runs, never what is said about it). Read once. */
const sources = (): Source[] =>
  (scanned ??= sourceFiles(ROOT).map((f) => ({
    file: relative(ROOT, f).split("\\").join("/"),
    code: stripComments(readFileSync(f, "utf8")),
  })));

/** `code` without its import and re-export statements: a name in one of
 * those is not a use of it. */
const withoutImports = (code: string): string =>
  code.replace(
    /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?\{[^}]*\}\s*from\s*["'][^"']+["'];?/g,
    "",
  );

/** The files whose code matches `use`, repo-relative and sorted. */
const filesUsing = (use: RegExp): string[] =>
  sources()
    .filter((s) => use.test(withoutImports(s.code)))
    .map((s) => s.file)
    .sort();

describe("nothing under the host-verb sources writes the flag", () => {
  // MUTATION: call flipDryRunToFalse, or patchToml / setTomlKey with key
  // "dry_run", from any file under src/host/ — this fails.
  it("no module of the host verbs builds a dry_run edit or patches config.toml", () => {
    const files = readdirSync(HOST_DIR).filter((f) => f.endsWith(".ts"));
    for (const expected of ["cli.ts", "golive.ts", "proof.ts", "setup.ts", "trigger.ts", "walk.ts"])
      expect(files).toContain(expected);
    for (const f of files) {
      const text = readFileSync(join(HOST_DIR, f), "utf8");
      const code = stripComments(text);
      expect(text, `${f} must not edit dry_run`).not.toMatch(/key:\s*"dry_run"/);
      expect(text, `${f} must not flip dry_run itself`).not.toMatch(/flipDryRunToFalse\s*\(/);
      expect(text, `${f} must not patch config.toml`).not.toMatch(
        /\b(?:patchToml|patchTomlSection|setTomlKey)\s*\(/,
      );
      expect(code, `${f} must not write a dry_run assignment`).not.toMatch(
        /dry_run\s*=\s*(?:true|false)/,
      );
    }
  });

  // One verb writes the config: `setup`, the whole of it, once, and only the
  // text its pure renderer returned (outside src/host/, where nothing may
  // patch). `set-trigger` writes none: the config is on the round
  // fingerprint's policy surface, so its choice goes to the daemon's store.
  // MUTATION: write the config in src/host/trigger.ts (the old one-key edit),
  // or in src/host/setup.ts through anything but its renderer (a template
  // string, patchToml), or from any other module under src/host/ — this fails.
  it("a host verb writes the config in one place, the text its renderer returned", () => {
    const writers = readdirSync(HOST_DIR)
      .filter((f) => f.endsWith(".ts"))
      .filter((f) =>
        /ports\.write\s*\(/.test(stripComments(readFileSync(join(HOST_DIR, f), "utf8"))),
      )
      .sort();
    expect(writers).toEqual(["setup.ts"]);
    for (const [file, renderer] of [["setup.ts", "renderHostConfig"]] as const) {
      const code = stripComments(readFileSync(join(HOST_DIR, file), "utf8"));
      expect(code.match(/ports\.write\s*\([^)]*\)/g), file).toEqual([
        "ports.write(ports.configPath, rendered.text)",
      ]);
      expect(code, file).toMatch(new RegExp(`const rendered = ${renderer}\\(`));
    }
  });

  // The writer itself: tests/host-config.test.ts drives it over every posture
  // and holds the flag it returns to the flag it was given.
  it("that writer refuses a dry_run edit before it patches anything", () => {
    const code = stripComments(
      readFileSync(join(ROOT, "src", "onboard", "steps", "hostconfig.ts"), "utf8"),
    );
    expect(code).not.toMatch(/key:\s*"dry_run"/);
    expect(code).not.toMatch(/flipDryRunToFalse/);
    // every patchToml call sits behind assertNoDryRunEdit over its edits
    const patches = code.match(/patchToml\s*\(/g) ?? [];
    const asserts = code.match(/assertNoDryRunEdit\s*\(/g) ?? [];
    expect(patches).toHaveLength(2);
    expect(asserts).toHaveLength(2);
  });
});

describe("the go-live path has exactly its allowed callers", () => {
  // MUTATION: call runGoLive from a third module (a host verb's own file, a
  // CLI verb, the TUI) — this fails, naming the file.
  it(
    "runGoLive is called by the home's switch and the host's go-live walk, and by nothing else",
    {
      timeout: HEAVY_TIMEOUT_MS,
    },
    () => {
      // a call, never the declaration
      const calls = filesUsing(/(?<!function\s)\brunGoLive\s*(?:<[^>]*>)?\(/);
      expect(calls).toEqual(["src/home/autoreview.ts", "src/host/golive.ts"]);
    },
  );

  // MUTATION: hand a step the go-live confirm from a second place (build
  // `{ confirm: GO_LIVE_CONFIRMATION }` in src/host/ or in a CLI verb) — this fails.
  it(
    "the confirm is built in one place, and the step is run with it from one",
    {
      timeout: HEAVY_TIMEOUT_MS,
    },
    () => {
      const declared = "src/onboard/steps/golive.ts";
      expect(filesUsing(/\bGO_LIVE_CONFIRMATION\b/).filter((f) => f !== declared)).toEqual([
        "src/home/switchon.ts",
      ]);
      expect(filesUsing(/\.runStep\s*\(\s*GO_LIVE_STEP_ID\b/)).toEqual(["src/home/switchon.ts"]);
      // no literal spelling of the phrase either
      expect(filesUsing(/["'`]GO LIVE["'`]/).filter((f) => f !== declared)).toEqual([]);
    },
  );

  // MUTATION: call flipDryRunToFalse from anywhere but the go-live step, or
  // register a second go-live step — this fails.
  it(
    "the flag's one writer has one caller, and the step is registered where it always was",
    {
      timeout: HEAVY_TIMEOUT_MS,
    },
    () => {
      expect(filesUsing(/(?<!function\s)\bflipDryRunToFalse\s*\(/)).toEqual([
        "src/onboard/steps/golive.ts",
      ]);
      expect(filesUsing(/(?<!function\s)\bgoLiveStep\s*\(/)).toEqual([
        "src/home/switchon.ts",
        "src/onboard/steps/index.ts",
      ]);
    },
  );

  it("the scan sees the files it is about", { timeout: HEAVY_TIMEOUT_MS }, () => {
    const files = sources().map((s) => s.file);
    for (const f of ["src/host/golive.ts", "src/home/autoreview.ts", "extensions/home.ts"])
      expect(files).toContain(f);
    expect(existsSync(join(ROOT, "src", "host", "golive.ts"))).toBe(true);
  });
});

describe("no agent session can reach a host verb", () => {
  let w: HostWorld;
  beforeEach(() => {
    w = hostWorld();
    w.writeConfig(setUpConfig());
  });
  afterEach(() => w.close());

  const ARGS: Record<HostVerb, string[]> = {
    setup: ["--repo", "acme/widgets", "--auth", "user"],
    "review-now": ["7"],
    "proof-start": ["7"],
    "proof-result": ["7"],
    "go-live": [],
    "set-trigger": ["all"],
  };

  /** Nothing was asked of Docker or GitHub, and nothing was started. */
  const untouched = (): void => {
    expect(w.calls).toEqual([]);
    expect(w.github).toEqual([]);
    expect(w.launched).toEqual([]);
    expect(w.ran).toEqual([]);
    expect(existsSync(join(w.stateDir, "onboarding"))).toBe(false);
  };

  // MUTATION: drop the `admit` call from any one verb in src/host/ — this
  // fails for that verb under every marker.
  it("every verb refuses under every marker a session sets, before it touches anything", async () => {
    w.stdin = JSON.stringify({
      operator: { host: "a-host", id: "user-1" },
      confirmed_at: new Date(w.now).toISOString(),
      proof: { pr: 7, round_no: 1 },
    });
    for (const marker of SESSION_ENV_MARKERS) {
      w.env = { [marker]: marker === HOME_TOOLS_ENV ? "reviewer" : "pr-7" };
      for (const verb of HOST_VERBS) {
        const out = await runHostVerb(verb, w.ports, ARGS[verb]);
        expect(out, `${verb} under ${marker}`).toMatchObject({
          state: "refused",
          reason: "in_session",
        });
      }
    }
    untouched();
  });

  // MUTATION: drop the session check from walkSetup or walkGoLive — the walk
  // waits for a lock instead of refusing, and `slept` is no longer zero.
  it("neither detached walk runs from a session", async () => {
    let slept = 0;
    for (const marker of SESSION_ENV_MARKERS) {
      w.env = { [marker]: "x" };
      const ports = { ...w.walker(), sleep: async () => void (slept += 1) };
      expect(await walkSetup(ports, "any-token")).toBe(1);
      expect(await walkGoLive(ports, "any-token")).toBe(1);
    }
    expect(slept).toBe(0);
    untouched();
  });

  // MUTATION: drop the `inImage` refusal from admit — this fails.
  it("inside the daemon's container, where review sessions run, every verb refuses for the place alone", async () => {
    w.inImage = true;
    for (const verb of HOST_VERBS)
      expect(await runHostVerb(verb, w.ports, ARGS[verb]), verb).toMatchObject({
        state: "refused",
        reason: "not_on_host",
      });
    untouched();
    // the place is read off where the package sits, and the image's wrapper user
    expect(detectInstall(IMAGE_APP_ROOT, {}).kind).toBe("image");
    expect(detectInstall("/anywhere", { QCR_IMAGE_TOOL_UID: "1000" }).kind).toBe("image");
    const ports = stripComments(readFileSync(join(HOST_DIR, "ports.ts"), "utf8"));
    expect(ports).toMatch(/inImage:\s*detectInstall\(pkgRoot, env\)\.kind === "image"/);
  });

  // A walk with no lock handed to it runs nothing wherever it is, so "it ran
  // nothing" proves nothing about the place. A walk that refuses for the
  // place never looks for its lock (no sleep), and one that holds the very
  // lock its verb handed over still runs no step.
  // MUTATION: drop `|| ports.inImage` from walkSetup or from walkGoLive — the
  // walk waits for a lock (`slept` is no longer zero), and with the real
  // token it adopts the lock and runs its steps; this fails either way.
  it("inside the daemon's container neither detached walk runs, even with the lock its verb handed over", async () => {
    let slept = 0;
    const inside = (): ReturnType<HostWorld["walker"]> => ({
      ...w.walker(),
      inImage: true,
      sleep: async () => void (slept += 1),
    });
    // no lock at all: refused before it looks for one
    expect(await walkSetup(inside(), "any-token")).toBe(1);
    expect(await walkGoLive(inside(), "any-token")).toBe(1);
    expect(slept).toBe(0);
    untouched();

    // the setup verb's own hand-over, on the host
    expect(await hostSetup(w.ports, ARGS.setup)).toEqual({ state: "started" });
    const setupToken = w.launched.at(-1)!.token;
    expect(await walkSetup(inside(), setupToken)).toBe(1);
    expect(slept).toBe(0);
    expect(w.ran).toEqual([]);
    // the lock is still the walk's, unadopted: the same walk on the host takes it
    expect(readHostRecord(w.stateDir).setup).toMatchObject({ state: "running" });
    expect(await walkSetup(w.walker(), setupToken)).toBe(0);
    expect(w.ran.length).toBeGreaterThan(0);

    // and the go-live verb's
    w.ran.length = 0;
    expect(await hostProofStart(w.ports, ["7"])).toMatchObject({ state: "started" });
    const done = finishedRound(7, 1);
    w.daemon.rounds = [done.round];
    w.daemon.dryrun = done.records;
    expect(await hostProofResult(w.ports, ["7"])).toMatchObject({ state: "done" });
    w.stdin = JSON.stringify({
      operator: { host: "a-host", id: "user-1" },
      confirmed_at: new Date(w.now).toISOString(),
      proof: { pr: 7, round_no: 1 },
    });
    expect(await hostGoLive(w.ports, [])).toEqual({ state: "started" });
    const goLiveToken = w.launched.at(-1)!.token;
    expect(await walkGoLive(inside(), goLiveToken)).toBe(1);
    expect(slept).toBe(0);
    expect(w.ran).toEqual([]);
    expect(readHostRecord(w.stateDir).attestation).toBeUndefined();
    expect(await walkGoLive(w.walker(), goLiveToken)).toBe(0);
    expect(w.ran.map((r) => r.id)).toEqual([GO_LIVE_STEP_ID]);
  });

  it("outside a session, on the host, a verb is admitted", () => {
    expect(admit({ env: {}, inImage: false })).toBeNull();
    expect(admit({ env: { QCR_SESSION_NAME: "  " }, inImage: false })).toBeNull();
    expect(sessionMarker({ PATH: "/usr/bin", HOME: "/home/someone" })).toBeNull();
  });

  // MUTATION: rename the variable a session's environment is marked with
  // (QCR_SESSION_NAME in SessionManager.buildEnv, say) and leave the host's
  // list as it was — this fails, naming the builder.
  it("the markers are the ones the session builders set", () => {
    const sets = (file: string, name: string): boolean =>
      new RegExp(`\\b${name}\\s*[:=]`).test(stripComments(readFileSync(join(ROOT, file), "utf8")));
    // the daemon's review sessions
    expect(sets("src/sessions.ts", "QCR_SESSION_NAME")).toBe(true);
    // a one-shot round's session, with its pull request
    expect(sets("packages/pi-plugin/src/engine/round.ts", "QCR_SESSION_NAME")).toBe(true);
    expect(sets("packages/pi-plugin/src/engine/round.ts", "QCR_PR")).toBe(true);
    // the companion's
    expect(sets("src/tui/companion.ts", "QCR_SESSION_NAME")).toBe(true);
    expect(sets("src/tui/companion.ts", "QCR_SESSION")).toBe(true);
    for (const name of ["QCR_SESSION_NAME", "QCR_SESSION", "QCR_PR"])
      expect(SESSION_ENV_MARKERS).toContain(name);
    // the app's own pi (`qcr pi`): asked of the launch itself.
    // MUTATION: start pi in cmdPi with the caller's environment as it is —
    // a host verb run from that pi's shell is admitted, and this fails.
    expect(SESSION_ENV_MARKERS).toContain(PI_SESSION_ENV);
    const launches: Array<NodeJS.ProcessEnv | undefined> = [];
    const pi = (env: Record<string, string | undefined>): number => {
      const deps: NpmVerbDeps = {
        env,
        pkgRoot: "/pkg",
        piCli: () => "/pi/cli.js",
        pluginDir: () => "/plugin",
        run: (_cmd, _args, opts) => {
          launches.push(opts.env);
          return { status: 0 };
        },
        interactive: false,
        out: () => {},
        err: () => {},
        execPath: "/usr/bin/node",
        holdLogin: () => Promise.resolve({ ok: true, held: false, release: () => {} }),
      };
      return cmdPi([], deps);
    };
    expect(pi({ PATH: "/usr/bin" })).toBe(0);
    expect(sessionMarker(launches[0] ?? {})).toBe(PI_SESSION_ENV);
    // the caller's own environment goes with it, and a mark it carries is kept
    expect(launches[0]).toMatchObject({ PATH: "/usr/bin" });
    expect(pi({ [PI_SESSION_ENV]: "companion" })).toBe(0);
    expect(launches[1]?.[PI_SESSION_ENV]).toBe("companion");
    // the home's own pi: asked of the launch itself
    expect(SESSION_ENV_MARKERS).toContain(HOME_TOOLS_ENV);
    const home = homeLaunch({
      piCli: "/pi/cli.js",
      pluginDir: "/plugin",
      appRoot: "/app",
      stateHome: "/state",
      home: { ...HOME_DEFAULTS },
      env: {},
    });
    expect(sessionMarker(home.env)).toBe(HOME_TOOLS_ENV);
  });
});

describe("an attestation takes only a host-managed install live", () => {
  let w: HostWorld;
  beforeEach(() => {
    w = hostWorld();
    w.writeConfig(setUpConfig());
  });
  afterEach(() => w.close());

  /** A practice review of #7 that a host was shown, and the attestation of
   * an operator who confirmed it just now. */
  async function confirmed(): Promise<void> {
    expect(await hostProofStart(w.ports, ["7"])).toMatchObject({ state: "started" });
    const done = finishedRound(7, 1);
    w.daemon.rounds = [done.round];
    w.daemon.dryrun = done.records;
    expect(await hostProofResult(w.ports, ["7"])).toMatchObject({ state: "done" });
    w.stdin = JSON.stringify({
      operator: { host: "a-host", id: "user-1" },
      confirmed_at: new Date(w.now).toISOString(),
      proof: { pr: 7, round_no: 1 },
    });
  }

  /** Did anything reach the go-live step? */
  const wentLive = (): boolean => w.ran.some((r) => r.id === GO_LIVE_STEP_ID);

  // Everything a go-live asks for is in place, and a self-written attestation
  // is on standard input; only the marker is missing. The attestation is
  // unauthenticated by design, so the marker is the one thing that says this
  // install's owner delegated the confirm to a host.
  // MUTATION: drop the `hostManagedRefusal` check from hostGoLive — the verb answers
  // `started` on an unmarked config, its walk reaches the go-live step, and
  // this fails.
  it("without the marker the verb refuses and nothing goes live", async () => {
    await confirmed();
    const unmarkedConfigs = [setUpConfig({ hosted: false }), TEMPLATE, '[github]\nauth = "user"\n'];
    for (const unmarked of unmarkedConfigs) {
      w.writeConfig(unmarked);
      expect(hostManaged(w.ports)).toBe(false);
      expect(await hostGoLive(w.ports, []), unmarked.slice(0, 40)).toMatchObject({
        state: "refused",
        reason: "not_host_managed",
      });
      // had a walk been started, it would be run here
      for (const started of w.launched) await walkGoLive(w.walker(), started.token);
      expect(wentLive()).toBe(false);
    }
    expect(w.launched).toEqual([]);
    expect(readHostRecord(w.stateDir).attestation).toBeUndefined();
  });

  // MUTATION: drop the `hostManaged` check from walkGoLive — a walk admitted
  // under the marker and run after it is gone reaches the go-live step, and
  // this fails.
  it("without the marker a walk that was started reaches no step", async () => {
    await confirmed();
    expect(await hostGoLive(w.ports, [])).toEqual({ state: "started" });
    w.writeConfig(setUpConfig({ hosted: false }));
    expect(await walkGoLive(w.walker(), w.launched[0]!.token)).toBe(1);
    expect(wentLive()).toBe(false);
    expect(readHostRecord(w.stateDir).go_live).toMatchObject({
      state: "failed",
      problem: "attestation_rejected",
    });
  });

  // The control: the same call under the marker does go live, so the two
  // cases above fail for the marker and for nothing else.
  it("with the marker the same attestation goes live", async () => {
    await confirmed();
    expect(hostManaged(w.ports)).toBe(true);
    expect(await hostGoLive(w.ports, [])).toEqual({ state: "started" });
    expect(await walkGoLive(w.walker(), w.launched[0]!.token)).toBe(0);
    expect(wentLive()).toBe(true);
  });

  // The marker is read off the config as written, never through a loader: a
  // config holding nothing else is a host-managed install's.
  it("the marker is the key as written, whatever else the config holds or lacks", () => {
    const marked = (text: string | null): boolean => {
      if (text === null) return hostManaged({ ...w.ports, configPath: `${w.configPath}.none` });
      w.writeConfig(text);
      return hostManaged(w.ports);
    };
    expect(marked(MARKER_ONLY)).toBe(true);
    expect(marked(setUpConfig())).toBe(true);
    expect(marked('[github]\ntoken_source = "self"\n')).toBe(false);
    expect(marked(`# token_source = "host"\n[github]\nrepo = "${REPO}"\n`)).toBe(false);
    expect(marked('token_source = "host"\n')).toBe(false);
    expect(marked("[github\n")).toBe(false);
    expect(marked(null)).toBe(false);
  });
});

// Every host verb, the review and the two practice-review verbs included,
// acts on an install a host manages and on no other. On any other install
// the proof record is the owner's alone: it is written when they are shown a
// practice review at their own home, and a go-live there is confirmed in
// their own words.
describe("every host verb refuses an install no host manages", () => {
  let w: HostWorld;
  beforeEach(() => {
    w = hostWorld();
    w.writeConfig(setUpConfig());
  });
  afterEach(() => w.close());

  const proofChoice = (): unknown => w.checklist()?.choices[CHOICE_KEYS.proof];

  /** A practice round of #7 asked for under the marker and finished since. */
  async function finished(): Promise<void> {
    expect(await hostProofStart(w.ports, ["7"])).toMatchObject({ state: "started" });
    const done = finishedRound(7, 1);
    w.daemon.rounds = [done.round];
    w.daemon.dryrun = done.records;
  }

  // MUTATION: drop the `hostManagedRefusal` check from hostProofResult — on an
  // unmarked install the verb reads the finished round, the checklist gains
  // a proof record and host.json a `proof_shown`, and this fails.
  it("proof-result on an unmarked install records no proof and marks nothing shown", async () => {
    await finished();
    const unmarkedConfigs = [setUpConfig({ hosted: false }), TEMPLATE, '[github]\nauth = "user"\n'];
    for (const unmarked of unmarkedConfigs) {
      w.writeConfig(unmarked);
      expect(await hostProofResult(w.ports, ["7"]), unmarked.slice(0, 40)).toMatchObject({
        state: "refused",
        reason: "not_host_managed",
      });
    }
    expect(proofChoice()).toBeUndefined();
    expect(readHostRecord(w.stateDir).proof_shown).toBeUndefined();
  });

  // MUTATION: drop the `hostManagedRefusal` check from hostProofStart, or from
  // hostReviewNow — the verb writes a review-now command into the daemon's
  // channel on an unmarked install, and this fails.
  it("proof-start and review-now on an unmarked install ask the daemon nothing", async () => {
    w.writeConfig(setUpConfig({ hosted: false }));
    for (const [verb, run] of [
      ["proof-start", hostProofStart],
      ["review-now", hostReviewNow],
    ] as const)
      expect(await run(w.ports, ["7"]), verb).toMatchObject({
        state: "refused",
        reason: "not_host_managed",
      });
    expect(w.daemon.written).toEqual([]);
    expect(w.calls).toEqual([]);
    expect(readHostRecord(w.stateDir).proof_request).toBeUndefined();
  });

  // Asked before the lock: with another holder on it, an unmarked install is
  // still refused for what it is, never answered `busy`.
  // MUTATION: move the `hostManagedRefusal` check in hostProofStart below
  // acquireChecklistLock — the verb answers `busy`, and this fails.
  it("the refusal comes before the lock", async () => {
    w.writeConfig(setUpConfig({ hosted: false }));
    const held = acquireChecklistLock(w.stateDir, "home", { pid: WALK_PID, alive: () => true });
    expect(held.ok).toBe(true);
    try {
      for (const verb of ["proof-start", "proof-result", "review-now"] as const)
        expect(await runHostVerb(verb, w.ports, ["7"]), verb).toMatchObject({
          state: "refused",
          reason: "not_host_managed",
        });
    } finally {
      if (held.ok) held.lock.release();
    }
  });

  // A config that is there and cannot be read says nothing of the marker:
  // the verb says it could not read it, never that the install is not a
  // host's (invariant 9), and a missing one is not a host's.
  // MUTATION: make hostManagedRefusal (src/host/admit.ts) answer
  // `not_host_managed` for every read error — this fails.
  it("an unreadable config is config_unreadable, a missing one not_host_managed", async () => {
    const eio = {
      ...w.ports,
      read: () => {
        throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
      },
    };
    const none = { ...w.ports, configPath: `${w.configPath}.none` };
    for (const [verb, args] of [
      ["review-now", ["7"]],
      ["proof-start", ["7"]],
      ["proof-result", ["7"]],
      ["set-trigger", ["all"]],
      ["go-live", []],
    ] as const) {
      expect(await runHostVerb(verb, eio, args), verb).toMatchObject({
        state: "refused",
        reason: "config_unreadable",
      });
      expect(await runHostVerb(verb, none, args), verb).toMatchObject({
        state: "refused",
        reason: "not_host_managed",
      });
    }
    expect(w.daemon.written).toEqual([]);
  });

  // The control: under the marker the same finished round is recorded, so
  // the cases above fail for the marker and for nothing else.
  it("with the marker the same round is recorded and shown", async () => {
    await finished();
    expect(await hostProofResult(w.ports, ["7"])).toMatchObject({ state: "done" });
    expect(proofChoice()).toMatchObject({ pr: 7, round_no: 1 });
    expect(readHostRecord(w.stateDir).proof_shown).toMatchObject({ pr: 7, round_no: 1 });
  });
});

// No host verb writes to GitHub. The trigger label is the live daemon's to
// make sure of, through the gate (src/triggerlabel.ts); a host verb reads
// the repository and the token's own login, and writes nothing there.
describe("no host verb writes to GitHub", () => {
  // MUTATION: make sure of the trigger label from src/host/golive.ts again
  // (import the wizard's `ensureLabel` and call it) — this fails.
  it("nothing under src/host/ calls a label writer or sends a write method", () => {
    const offenders = readdirSync(HOST_DIR)
      .filter((f) => f.endsWith(".ts"))
      .flatMap((f) => {
        const code = stripComments(readFileSync(join(HOST_DIR, f), "utf8"));
        return [
          /\bensureLabel\b/,
          /\bcreateLabel\b/,
          /method:\s*["'`](?:POST|PATCH|PUT|DELETE)["'`]/,
        ]
          .filter((re) => re.test(code))
          .map((re) => `src/host/${f}: ${re.source}`);
      });
    expect(offenders).toEqual([]);
    // the walk is real: it read the go-live module
    expect(readdirSync(HOST_DIR)).toContain("golive.ts");
  });
});

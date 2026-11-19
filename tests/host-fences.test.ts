// The fences around the host verbs (src/host/), each structural and each
// named with the mutation that proves it bites (tests/fences.test.ts states
// the rules):
//
//   1. Nothing under the host-verb sources writes `dry_run`: they are walked
//      as the home's are (tests/home-switchon.test.ts), and the one config
//      writer they use is held to the flag by what it returns.
//   2. The go-live path has exactly its allowed callers. The flag moves in
//      one function, that function has one caller (the go-live step), the
//      step is run with a confirm from one place (`runGoLive`), and
//      `runGoLive` is called from two: the home's switch and the host verb's
//      walk.
//   3. No agent session can reach a host verb: every verb and both walks
//      refuse under every marker a session sets, the markers are the ones the
//      session builders set, and inside the daemon's container every verb
//      refuses for the place alone.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOME_DEFAULTS } from "../src/config.js";
import { HOME_TOOLS_ENV } from "../src/home/adapters.js";
import { homeLaunch } from "../src/home/launch.js";
import { admit } from "../src/host/admit.js";
import { runHostVerb } from "../src/host/cli.js";
import { walkGoLive } from "../src/host/golive.js";
import { HOST_VERBS, type HostVerb } from "../src/host/outcomes.js";
import { SESSION_ENV_MARKERS, sessionMarker } from "../src/host/session.js";
import { walkSetup } from "../src/host/walk.js";
import { IMAGE_APP_ROOT, detectInstall } from "../src/installkind.js";
import { sourceFiles, stripComments } from "./helpers/engine-fences.js";
import { hostWorld, setUpConfig, type HostWorld } from "./helpers/host-rig.js";
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
    for (const expected of ["cli.ts", "golive.ts", "proof.ts", "setup.ts", "walk.ts"])
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

  // MUTATION: write the config in src/host/setup.ts through anything but
  // renderHostConfig (a template string, patchToml) — this fails.
  it("the one config a host verb writes is the one renderHostConfig returned", () => {
    const writers = readdirSync(HOST_DIR)
      .filter((f) => f.endsWith(".ts"))
      .filter((f) =>
        /ports\.write\s*\(/.test(stripComments(readFileSync(join(HOST_DIR, f), "utf8"))),
      );
    expect(writers).toEqual(["setup.ts"]);
    const setup = stripComments(readFileSync(join(HOST_DIR, "setup.ts"), "utf8"));
    expect(setup.match(/ports\.write\s*\([^)]*\)/g)).toEqual([
      "ports.write(ports.configPath, rendered.text)",
    ]);
    expect(setup).toMatch(/const rendered = renderHostConfig\(/);
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
    expect(await walkSetup(w.walker(), "any-token")).toBe(1);
    expect(await walkGoLive(w.walker(), "any-token")).toBe(1);
    untouched();
    // the place is read off where the package sits, and the image's wrapper user
    expect(detectInstall(IMAGE_APP_ROOT, {}).kind).toBe("image");
    expect(detectInstall("/anywhere", { QCR_IMAGE_TOOL_UID: "1000" }).kind).toBe("image");
    const ports = stripComments(readFileSync(join(HOST_DIR, "ports.ts"), "utf8"));
    expect(ports).toMatch(/inImage:\s*detectInstall\(pkgRoot, env\)\.kind === "image"/);
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

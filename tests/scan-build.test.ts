// The scan agent build and the settings a scan runs with — asserted
// at the seams the spec names: what `buildAgents` writes for a PR build and
// for the scan build, and what `config.toml [scan]` and the profile's `[scan]`
// resolve to through the real profile loader.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { parseConfig, parseScanTable, SCAN_DEFAULTS, type Config } from "../src/config.js";
import { PiHost } from "@quickchatai/pi-quickreview/src/engine/pisdk.js";
import { sdkRuntime } from "@quickchatai/pi-quickreview/src/engine/sdkruntime.js";
import { agentThinking, sdkCaseRunner } from "@quickchatai/pi-quickreview/src/scan/scanleaves.js";
import { globMatcher, globProblem } from "@quickchatai/pi-quickreview/src/glob.js";
import {
  PASS_ADDENDA,
  SCAN_LEAF_TOOLS,
  SCAN_MODE_ANCHOR_ADDENDUM,
  VALIDATE_PASS,
  addendaForPass,
  buildAgents,
} from "@quickchatai/pi-quickreview/src/include.js";
import { configHome, homeProfileLookup, type InstallEnv } from "../src/install.js";
import {
  SCAN_MODEL_ENV,
  buildScanAgents,
  loadScanConfig,
  scanConfig,
  scanSettings,
} from "../src/setup/scanbuild.js";
import { ROUTABLE_FAUX_MODEL, routableFaux } from "./helpers/priced-faux.js";
import { useOfflineGuard } from "./pi-canary/harness.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

useOfflineGuard();

const sandbox = join(import.meta.dirname, "..");
const fixtureToml = readFileSync(resolve(sandbox, "tests/fixtures/config.toml"), "utf8");
const fixture: Config = parseConfig(fixtureToml);

let dir: string;
let env: InstallEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-scan-build-"));
  env = { HOME: join(dir, "home"), XDG_CONFIG_HOME: join(dir, "xdg-config") };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function built(out: string): Map<string, string> {
  return new Map(
    readdirSync(out).map((f) => [f.replace(/\.md$/, ""), readFileSync(join(out, f), "utf8")]),
  );
}

function prBuild(): Map<string, string> {
  const out = join(dir, "pr-agents");
  buildAgents(join(sandbox, "agents"), out, {
    root: sandbox,
    tiers: fixture.models.tiers,
    riskPasses: fixture.models.risk_passes,
    validateTier: fixture.models.validate_tier,
  });
  return built(out);
}

function scanBuild(cfg: Config = fixture): Map<string, string> {
  const out = join(dir, "scan-agents");
  buildScanAgents(sandbox, out, cfg, homeProfileLookup(env));
  return built(out);
}

/** A profile in the install's config home. */
function profile(name: string, toml: string): void {
  const p = join(configHome(env), "profiles", name);
  mkdirSync(join(p, "addenda"), { recursive: true });
  writeFileSync(join(p, "profile.toml"), toml);
}

/** The fixture config with `[review] profile = name` and extra TOML. */
function configWith(name: string, extra = ""): string {
  return `${fixtureToml.replace(/^profile = .*$/m, "")}\n${extra}`.replace(
    /^\[review\]$/m,
    `[review]\nprofile = "${name}"`,
  );
}

describe("the scan-mode anchor addendum rides only the scan build", () => {
  it("is a registry entry gated to scan mode — no PR build composes it", () => {
    const entry = PASS_ADDENDA.find((a) => a.id === "scan-mode-anchor");
    expect(entry).toMatchObject({ scope: "all", mode: "scan" });
    expect(addendaForPass("pass-baseline").map((a) => a.id)).not.toContain("scan-mode-anchor");
    expect(addendaForPass(VALIDATE_PASS).map((a) => a.id)).not.toContain("scan-mode-anchor");
    expect(
      addendaForPass("pass-baseline", PASS_ADDENDA, "django", "scan").map((a) => a.id),
    ).toContain("scan-mode-anchor");
    expect(addendaForPass(VALIDATE_PASS, PASS_ADDENDA, "none", "scan").map((a) => a.id)).toContain(
      "scan-mode-anchor",
    );
  });

  it("a PR build carries it nowhere and has no pass-scan", () => {
    const agents = prBuild();
    expect(agents.size).toBeGreaterThan(20);
    for (const [name, body] of agents) {
      expect(body, name).not.toContain("Scan mode — there is no pull request");
      expect(name.startsWith("pass-scan--"), name).toBe(false);
    }
  });

  it("the scan build carries it in EVERY variant (the validator included) and builds pass-scan", () => {
    const agents = scanBuild();
    for (const [name, body] of agents) expect(body, name).toContain(SCAN_MODE_ANCHOR_ADDENDUM);
    // Only the [scan] tier's variant: nothing runs pass-scan at another tier.
    expect([...agents.keys()].filter((n) => n.startsWith("pass-scan--")).sort()).toEqual([
      `pass-scan--${fixture.scan.tier}`,
    ]);
    expect(agents.has("pass-validate--deep")).toBe(true);
  });

  it("builds pass-scan at the [scan] tier alone; the deep lenses keep every tier for stage 2", () => {
    const cfg = scanConfig(
      sandbox,
      `${fixtureToml}\n[scan]\ntier = "light"\n`,
      homeProfileLookup(env),
    );
    const agents = scanBuild(cfg);
    expect([...agents.keys()].filter((n) => n.startsWith("pass-scan--"))).toEqual([
      "pass-scan--light",
    ]);
    for (const t of ["light", "standard", "deep"])
      expect(agents.has(`pass-baseline--${t}`), t).toBe(true);
  });

  it("pass-scan's built body pins the defect line, quotes it, and carries the reachability axis", () => {
    const body = scanBuild().get(`pass-scan--${fixture.scan.tier}`)!;
    // Anchoring is the scan-mode addendum's (every scan lens, stage 2 too)…
    expect(SCAN_MODE_ANCHOR_ADDENDUM).toContain("The anchor is the line where the defect happens");
    expect(SCAN_MODE_ANCHOR_ADDENDUM).toContain("`evidence` quotes that line's code verbatim");
    expect(body).toContain(SCAN_MODE_ANCHOR_ADDENDUM);
    // …reachability and confidence discipline the lens's own (agents/scan/pass-scan.md)…
    expect(body).toContain("Reachability is a claim you checked, not a default");
    expect(body).toContain("Calibrate confidence");
    // …and the field itself is the shared reachability addendum's, as in a PR lens.
    expect(body).toContain("## Reachability — the third axis on every finding");
  });

  it("gives every scan leaf exactly the read-only tools — no bash, no memory", () => {
    for (const [name, body] of scanBuild()) {
      const tools = /^tools: (.*)$/m.exec(body)?.[1];
      expect(tools, name).toBe(SCAN_LEAF_TOOLS.join(", "));
    }
    // …while a PR build keeps its own: bash behind the guard, and no memory
    // tool (no lens leaf loads the memory extension).
    expect(/^tools: (.*)$/m.exec(prBuild().get("pass-baseline--standard")!)?.[1]).toBe(
      "read, bash, grep",
    );
  });

  it("runs pass-scan at the [scan] effort on each tier's model, other lenses untouched", () => {
    const agents = scanBuild();
    expect(fixture.scan.tier).toBe("standard");
    expect(/^model: (.*)$/m.exec(agents.get("pass-scan--standard")!)?.[1]).toBe(
      fixture.models.tiers["standard"].replace(/:[a-z]+$/, "") + ":low",
    );
    expect(/^model: (.*)$/m.exec(agents.get("pass-baseline--standard")!)?.[1]).toBe(
      fixture.models.tiers["standard"],
    );
  });

  // The shipped config pins no model. The scan build then writes no model
  // line: a leaf runs on the scan's route, and the level each variant runs at
  // (its tier's, or `[scan] effort` for pass-scan) is its `thinking:` field.
  // MUTATION: write the spec into `model:` whatever it names (buildAgents) —
  // pass-scan gets `model: :low`, and this fails.
  it("with no model pinned: no variant carries a model line, and each carries its level", () => {
    const shipped = parseConfig(readFileSync(join(sandbox, "config.example.toml"), "utf8"));
    expect(Object.values(shipped.models.tiers)).toEqual([":medium", ":medium", ":high"]);
    const agents = scanBuild(shipped);
    expect(agents.size).toBeGreaterThan(10);
    const front = (name: string): string => {
      const text = agents.get(name)!;
      return text.slice(0, text.indexOf("\n---\n", 4));
    };
    for (const name of agents.keys()) expect(front(name), name).not.toMatch(/^model:/m);
    expect(shipped.scan.tier).toBe("standard");
    expect(shipped.scan.effort).toBe("low");
    expect(front("pass-scan--standard")).toMatch(/^thinking: low$/m);
    expect(front("pass-baseline--standard")).toMatch(/^thinking: medium$/m);
    expect(front("pass-baseline--deep")).toMatch(/^thinking: high$/m);
    expect(front(`${VALIDATE_PASS}--light`)).toMatch(/^thinking: medium$/m);
  });

  it("refuses an agent name found in two source directories", () => {
    const extra = join(dir, "extra");
    mkdirSync(extra);
    writeFileSync(join(extra, "pass-baseline.md"), "---\nname: pass-baseline\n---\nx\n");
    expect(() =>
      buildAgents(join(sandbox, "agents"), join(dir, "o"), {
        root: sandbox,
        extraSrcDirs: [extra],
      }),
    ).toThrow(/more than one source directory/);
  });
});

// What the unpinned build is for: the leaf runner (scanleaves.ts) takes a
// built file with no `model:` to the host's route, at the file's level.
describe("a scan leaf built with no model runs on the host's route", () => {
  const hosts: PiHost[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const h of hosts.splice(0)) h.dispose();
  });

  /** The shipped (unpinned) scan build, and a leaf runner over it on a host
   * whose only provider is a faux one. Its environment holds no key. */
  async function leafOn(routable: boolean) {
    const shipped = parseConfig(readFileSync(join(sandbox, "config.example.toml"), "utf8"));
    const agentsDir = join(dir, "scan-agents");
    buildScanAgents(sandbox, agentsDir, shipped, homeProfileLookup(env));
    const faux = routable ? routableFaux() : fauxProvider();
    const host = await PiHost.create({
      agentDir: join(dir, "host-agent"),
      authEnv: {},
      settings: { compaction: { enabled: false }, retry: { enabled: false } },
      configureModels: (r) => r.registerNativeProvider(faux.provider),
    });
    hosts.push(host);
    const asked: Array<{ model: unknown; thinkingLevel: unknown }> = [];
    const real = host.makeSession.bind(host);
    vi.spyOn(host, "makeSession").mockImplementation(async (spec) => {
      asked.push({ model: spec.model, thinkingLevel: spec.thinkingLevel });
      return real(spec);
    });
    const runner = sdkCaseRunner({
      agentsDir,
      cwd: dir,
      env: { PATH: process.env["PATH"], HOME: dir },
      home: dir,
      runtime: (extras) => sdkRuntime(host, { extras }),
    });
    const run = () =>
      runner.run(
        { id: "c1", unit: "u", agent: "pass-scan--standard", files: [], prompt: "Answer NONE." },
        new AbortController().signal,
      );
    return { host, faux, asked, run, agentsDir };
  }

  it("agentThinking reads a built file's level, and nothing from a file without one", () => {
    expect(agentThinking("---\nname: a\nthinking: low\n---\nbody\n")).toBe("low");
    expect(agentThinking('---\nname: a\nthinking: "high"\n---\nbody\n')).toBe("high");
    expect(agentThinking("---\nname: a\nmodel: prov/m:high\n---\nthinking: low\n")).toBeNull();
    expect(agentThinking("no frontmatter\nthinking: low\n")).toBeNull();
  });

  // MUTATION: restore the refusal of an agent with no model in sdkCaseRunner
  // (`names no model and none is set`) — the case never starts, and this fails.
  // MUTATION: drop `?? fileLevel` in sdkCaseRunner — the session is asked for
  // no level, and the thinkingLevel assertion fails.
  it(
    "the session is asked for no model and the file's level, and answers on the route's model",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const { host, faux, asked, run, agentsDir } = await leafOn(true);
      const file = readFileSync(join(agentsDir, "pass-scan--standard.md"), "utf8");
      expect(file.slice(0, file.indexOf("\n---\n", 4))).not.toMatch(/^model:/m);
      faux.setResponses([() => fauxAssistantMessage("NONE")]);
      const out = await run();
      expect(out).toMatchObject({ ok: true, output: "NONE" });
      expect(asked).toEqual([{ model: "", thinkingLevel: "low" }]);
      const routed = await host.route();
      expect(routed.ok && routed.route.spec).toBe(`faux/${ROUTABLE_FAUX_MODEL.id}`);
    },
  );

  it(
    "a host with no route fails the case with the reason, before any turn",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const { faux, run } = await leafOn(false);
      const out = await run();
      expect(out.ok).toBe(false);
      expect(!out.ok && out.reason).toMatch(/could not start the session: .*none of their models/);
      expect(!out.ok && out.reason).not.toMatch(/names no model and none is set/);
      expect(faux.state.callCount).toBe(0);
    },
  );
});

// The runtime's own half of the same rule (engine/sdkruntime.ts): a session
// spec with no model part runs on the host's route, and one that names no
// level either takes the level the route's pin named.
describe("a session spec with no model takes its level from the route's pin", () => {
  const hosts: PiHost[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const h of hosts.splice(0)) h.dispose();
  });

  /** What the host's session is asked for, for a spec whose model is `model`,
   * on a host whose route is pinned to `pin`. */
  async function askedFor(model: string, pin: string | null) {
    const faux = routableFaux();
    const host = await PiHost.create({
      agentDir: join(dir, `host-${hosts.length}`),
      authEnv: {},
      settings: { compaction: { enabled: false }, retry: { enabled: false } },
      configureModels: (r) => r.registerNativeProvider(faux.provider),
      ...(pin !== null ? { route: { pin: { text: pin, from: "flag" as const } } } : {}),
    });
    hosts.push(host);
    const asked: Array<{ model: unknown; thinkingLevel: unknown }> = [];
    const real = host.makeSession.bind(host);
    vi.spyOn(host, "makeSession").mockImplementation(async (spec) => {
      asked.push({ model: spec.model, thinkingLevel: spec.thinkingLevel });
      return real(spec);
    });
    const session = await sdkRuntime(host).create({
      cwd: dir,
      env: { PATH: process.env["PATH"], HOME: dir },
      model,
      tools: [],
      eventsFile: join(dir, `events-${hosts.length}.jsonl`),
      stderrFile: join(dir, `stderr-${hosts.length}.txt`),
      limits: { timeoutMs: 5_000 },
    });
    await session.dispose();
    return asked[0];
  }
  const ROUTED = `faux/${ROUTABLE_FAUX_MODEL.id}`;

  // MUTATION: drop the route's level in sdkRuntime's open (`thinking ?? null`)
  // — the first case asks for no level, and this fails.
  it(
    "the pin's level, unless the spec names one; a spec with a model is left alone",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      // No model, no level: the route's.
      expect(await askedFor("", `${ROUTED}:high`)).toEqual({ model: "", thinkingLevel: "high" });
      // The spec's own level wins over the pin's.
      expect(await askedFor(":low", `${ROUTED}:high`)).toEqual({ model: "", thinkingLevel: "low" });
      // A pin that names no level, and a host with no pin, give none.
      expect(await askedFor("", ROUTED)).toEqual({ model: "", thinkingLevel: undefined });
      expect(await askedFor("", null)).toEqual({ model: "", thinkingLevel: undefined });
      // A spec that names a model never reads the route's level.
      expect(await askedFor(ROUTED, `${ROUTED}:high`)).toEqual({
        model: ROUTED,
        thinkingLevel: undefined,
      });
    },
  );
});

describe("[scan] — config.toml defaults, the profile's overrides", () => {
  it("an absent [scan] is the shipped defaults: the skeptic ON (owner ruling), pass-scan at low", () => {
    expect(fixture.scan).toEqual(SCAN_DEFAULTS);
    expect(SCAN_DEFAULTS.validator).toBe(true);
    expect(SCAN_DEFAULTS.effort).toBe("low");
  });

  it("config.toml sets any key; bad values and unknown keys refuse to load", () => {
    const cfg = parseConfig(
      `${fixtureToml}\n[scan]\neffort = "medium"\nconcurrency = 3\nexclude = ["gen/"]\n`,
    );
    expect(cfg.scan).toEqual({
      ...SCAN_DEFAULTS,
      effort: "medium",
      concurrency: 3,
      exclude: ["gen/"],
    });
    expect(() => parseConfig(`${fixtureToml}\n[scan]\neffort = "max"\n`)).toThrow(
      /\[scan\] effort/,
    );
    // The effort vocabulary every effort knob shares: `med` is `medium`; empty is no effort.
    expect(parseConfig(`${fixtureToml}\n[scan]\neffort = "med"\n`).scan.effort).toBe("medium");
    expect(() => parseConfig(`${fixtureToml}\n[scan]\neffort = ""\n`)).toThrow(/\[scan\] effort/);
    expect(() => parseConfig(`${fixtureToml}\n[scan]\nconcurrency = 0\n`)).toThrow(
      /positive integer/,
    );
    expect(() => parseConfig(`${fixtureToml}\n[scan]\nexclude = ["/abs"]\n`)).toThrow(
      /repo-relative/,
    );
    expect(() => parseConfig(`${fixtureToml}\n[scan]\nturbo = true\n`)).toThrow(
      /unknown key "turbo"/,
    );
    // Stage 2's stand-in factor — at least 1 (never a discount on stage 1's rate).
    expect(
      parseConfig(`${fixtureToml}\n[scan]\nunmeasured_rate_factor = 2.5\n`).scan
        .unmeasured_rate_factor,
    ).toBe(2.5);
    expect(() => parseConfig(`${fixtureToml}\n[scan]\nunmeasured_rate_factor = 0.5\n`)).toThrow(
      /unmeasured_rate_factor must be a number of at least 1/,
    );
  });

  it("the profile's [scan] wins over config.toml, per key, along the extends chain", () => {
    profile("base", `[scan]\neffort = "medium"\nexclude = ["vendor/"]\n`);
    profile("repo", `extends = "base"\n[scan]\nvalidator = true\nexclude = ["gen/"]\n`);
    const cfg = scanConfig(
      sandbox,
      configWith("repo", `[scan]\neffort = "high"\nvalidator = false\nconcurrency = 2\n`),
      homeProfileLookup(env),
    );
    expect(cfg.scan).toEqual({
      ...SCAN_DEFAULTS,
      effort: "medium", // the base profile beats config.toml's "high"
      validator: true, // the child profile beats config.toml's false
      exclude: ["gen/"], // child-wins: replaced whole, never appended
      concurrency: 2, // config.toml's alone: a profile may not set it
    });
    expect(scanSettings(cfg).scan.validator).toBe(true);
  });

  it("a profile may not set the install's operating limits", () => {
    profile("repo", `[scan]\nconcurrency = 64\n`);
    expect(() => scanConfig(sandbox, configWith("repo"), homeProfileLookup(env))).toThrow(
      /unknown key "concurrency"/,
    );
    profile("repo", `[scan]\nunmeasured_rate_factor = 1\n`);
    expect(() => scanConfig(sandbox, configWith("repo"), homeProfileLookup(env))).toThrow(
      /unknown key "unmeasured_rate_factor"/,
    );
    expect(() => parseScanTable("x", { effort: "low" }, ["effort"])).not.toThrow();
  });

  it("the profile's effort reaches the built pass-scan", () => {
    profile("repo", `[scan]\neffort = "medium"\n`);
    const agents = scanBuild(scanConfig(sandbox, configWith("repo"), homeProfileLookup(env)));
    expect(/^model: (.*)$/m.exec(agents.get("pass-scan--standard")!)?.[1]).toMatch(/:medium$/);
  });
});

describe("loadScanConfig — the live config, or the shipped defaults on a fresh install", () => {
  /** The install env, as the process env loadScanConfig takes. */
  const live = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ ...env, ...extra });

  /** An asset root holding only the shipped defaults (and, asked, a stranded config). */
  function assetRoot(stranded = false): string {
    const root = join(dir, "root");
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, "config.example.toml"),
      readFileSync(join(sandbox, "config.example.toml")),
    );
    if (stranded) writeFileSync(join(root, "config.toml"), fixtureToml);
    return root;
  }

  // MUTATION: drop the shipped-defaults branch in loadScanConfig (read the
  // located path unconditionally) — the first case fails with ENOENT.
  it("an empty config home scans on config.example.toml, as `qcr review` does", () => {
    const root = assetRoot();
    const loaded = loadScanConfig(root, live());
    expect(loaded).toMatchObject({ ok: true });
    const shipped = parseConfig(readFileSync(join(root, "config.example.toml"), "utf8"));
    expect(loaded.ok && loaded.cfg.scan).toEqual(shipped.scan);
    expect(loaded.ok && loaded.cfg.models).toEqual(shipped.models);
  });

  it("the install's own config wins over the shipped defaults", () => {
    const root = assetRoot();
    mkdirSync(configHome(env), { recursive: true });
    writeFileSync(
      join(configHome(env), "config.toml"),
      `${fixtureToml}\n[scan]\neffort = "medium"\n`,
    );
    const loaded = loadScanConfig(root, live());
    expect(loaded.ok && loaded.cfg.scan.effort).toBe("medium");
  });

  // MUTATION: drop `located.source === "override"` from the refusal — this fails.
  it("a QCR_CONFIG naming a missing file still refuses: it named that file", () => {
    const root = assetRoot();
    const loaded = loadScanConfig(root, live({ QCR_CONFIG: join(dir, "nope.toml") }));
    expect(loaded).toEqual({
      ok: false,
      errors: [expect.stringMatching(/no config at .*nope\.toml \(named by QCR_CONFIG\)/)],
    });
  });

  it("a config stranded in the checkout refuses and names `qcr install migrate`", () => {
    const loaded = loadScanConfig(assetRoot(true), live());
    expect(loaded.ok).toBe(false);
    expect(!loaded.ok && loaded.errors[0]).toMatch(/qcr install migrate/);
  });

  it("no shipped defaults either, or an invalid config, still refuses", () => {
    const bare = join(dir, "bare");
    mkdirSync(bare);
    expect(loadScanConfig(bare, live()).ok).toBe(false);
    const root = assetRoot();
    mkdirSync(configHome(env), { recursive: true });
    writeFileSync(join(configHome(env), "config.toml"), `${fixtureToml}\n[scan]\nturbo = true\n`);
    const loaded = loadScanConfig(root, live());
    expect(!loaded.ok && loaded.errors[0]).toMatch(/invalid: .*unknown key "turbo"/);
  });
});

// `qcr scan --model` is the whole scan's model: the config the scan reads
// keeps no tier and no lens on a model of its own, so every built agent
// names none and runs on the scan's route.
describe("loadScanConfig under a scan's --model", () => {
  /** The fixture config (every tier pinned) as the install's own, with one
   * lens moved to a model and a level of its own. */
  function install(): string {
    const root = join(dir, "root");
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, "config.example.toml"),
      readFileSync(join(sandbox, "config.example.toml")),
    );
    mkdirSync(configHome(env), { recursive: true });
    writeFileSync(
      join(configHome(env), "config.toml"),
      `${fixtureToml}\n[models.pass_models]\n"pass-baseline" = "${fixture.models.tiers.light}"\n`,
    );
    return root;
  }

  it("with no --model the file's pins stand, and nothing is counted", () => {
    const loaded = loadScanConfig(install(), { ...env });
    expect(loaded.ok && loaded.cfg.models.tiers).toEqual(fixture.models.tiers);
    expect(loaded.ok && "replaced" in loaded).toBe(false);
    // An empty value is no --model.
    const blank = loadScanConfig(install(), { ...env, [SCAN_MODEL_ENV]: " " });
    expect(blank.ok && blank.cfg.models.tiers).toEqual(fixture.models.tiers);
  });

  // MUTATION: return `cfg` unstripped in loadScanConfig when SCAN_MODEL_ENV is
  // set — the tiers keep their models, and this fails.
  it("under --model every tier and lens keeps its level and loses its model", () => {
    const root = install();
    const loaded = loadScanConfig(root, { ...env, [SCAN_MODEL_ENV]: "some/model" });
    expect(loaded).toMatchObject({ ok: true, replaced: 4 });
    if (!loaded.ok) return;
    expect(loaded.cfg.models.tiers).toEqual({
      light: ":medium",
      standard: ":medium",
      deep: ":high",
    });
    expect(loaded.cfg.models.pass_models).toEqual({ "pass-baseline": ":medium" });
    // What the scan then builds names no model anywhere.
    const out = join(dir, "flag-agents");
    buildScanAgents(sandbox, out, loaded.cfg, homeProfileLookup(env));
    for (const [name, text] of built(out)) {
      const front = text.slice(0, text.indexOf("\n---\n", 4));
      expect(front, name).not.toMatch(/^model:/m);
      expect(front, name).toMatch(/^thinking:/m);
    }
  });
});

describe("exclude globs", () => {
  it("match gitignore-style: a bare name at any depth, an inner slash anchored", () => {
    const m = globMatcher(["generated/", "*.pb.go", "src/legacy/**", "docs/api"]);
    expect(m("a/generated/x.py")).toBe(true);
    expect(m("generated/x.py")).toBe(true);
    expect(m("svc/api.pb.go")).toBe(true);
    expect(m("src/legacy/a/b.ts")).toBe(true);
    expect(m("lib/src/legacy/a.ts")).toBe(false);
    expect(m("docs/api/index.md")).toBe(true);
    expect(m("x/docs/api/index.md")).toBe(false);
    expect(m("src/app.ts")).toBe(false);
  });

  it("refuse absolute and escaping patterns", () => {
    expect(globProblem("/etc")).toMatch(/repo-relative/);
    expect(globProblem("a/../b")).toMatch(/\.\./);
    expect(globProblem("")).not.toBeNull();
    expect(globProblem("ok/**")).toBeNull();
  });
});

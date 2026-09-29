// The scan agent build and the settings a scan runs with — asserted
// at the seams the spec names: what `buildAgents` writes for a PR build and
// for the scan build, and what `config.toml [scan]` and the profile's `[scan]`
// resolve to through the real profile loader.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig, parseScanTable, SCAN_DEFAULTS, type Config } from "../src/config.js";
import { globMatcher, globProblem } from "../src/glob.js";
import {
  PASS_ADDENDA,
  SCAN_LEAF_TOOLS,
  SCAN_MODE_ANCHOR_ADDENDUM,
  VALIDATE_PASS,
  addendaForPass,
  buildAgents,
} from "../src/include.js";
import { configHome, type InstallEnv } from "../src/install.js";
import { buildScanAgents, scanConfig, scanSettings } from "../src/setup/scanbuild.js";

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
  return new Map(readdirSync(out).map((f) => [f.replace(/\.md$/, ""), readFileSync(join(out, f), "utf8")]));
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
  buildScanAgents(sandbox, out, cfg, { env });
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
  return `${fixtureToml.replace(/^profile = .*$/m, "")}\n${extra}`.replace(/^\[review\]$/m, `[review]\nprofile = "${name}"`);
}

describe("the scan-mode anchor addendum rides only the scan build", () => {
  it("is a registry entry gated to scan mode — no PR build composes it", () => {
    const entry = PASS_ADDENDA.find((a) => a.id === "scan-mode-anchor");
    expect(entry).toMatchObject({ scope: "all", mode: "scan" });
    expect(addendaForPass("pass-baseline").map((a) => a.id)).not.toContain("scan-mode-anchor");
    expect(addendaForPass(VALIDATE_PASS).map((a) => a.id)).not.toContain("scan-mode-anchor");
    expect(addendaForPass("pass-baseline", PASS_ADDENDA, "django", "scan").map((a) => a.id)).toContain("scan-mode-anchor");
    expect(addendaForPass(VALIDATE_PASS, PASS_ADDENDA, "none", "scan").map((a) => a.id)).toContain("scan-mode-anchor");
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
    expect([...agents.keys()].filter((n) => n.startsWith("pass-scan--")).sort()).toEqual([
      "pass-scan--sol-high",
      "pass-scan--sol-med",
      "pass-scan--terra-med",
    ]);
    expect(agents.has("pass-validate--sol-high")).toBe(true);
  });

  it("gives every scan leaf exactly the read-only tools — no bash, no memory", () => {
    for (const [name, body] of scanBuild()) {
      const tools = /^tools: (.*)$/m.exec(body)?.[1];
      expect(tools, name).toBe(SCAN_LEAF_TOOLS.join(", "));
    }
    // …while a PR build keeps its own (bash behind the guard, the two memory reads).
    expect(/^tools: (.*)$/m.exec(prBuild().get("pass-baseline--sol-med")!)?.[1]).toContain("viking_search");
  });

  it("runs pass-scan at the [scan] effort on each tier's model, other lenses untouched", () => {
    const agents = scanBuild();
    expect(/^model: (.*)$/m.exec(agents.get("pass-scan--sol-med")!)?.[1]).toBe(
      fixture.models.tiers["sol-med"].replace(/:[a-z]+$/, "") + ":low",
    );
    expect(/^model: (.*)$/m.exec(agents.get("pass-baseline--sol-med")!)?.[1]).toBe(fixture.models.tiers["sol-med"]);
  });

  it("refuses an agent name found in two source directories", () => {
    const extra = join(dir, "extra");
    mkdirSync(extra);
    writeFileSync(join(extra, "pass-baseline.md"), "---\nname: pass-baseline\n---\nx\n");
    expect(() => buildAgents(join(sandbox, "agents"), join(dir, "o"), { root: sandbox, extraSrcDirs: [extra] })).toThrow(
      /more than one source directory/,
    );
  });
});

describe("[scan] — config.toml defaults, the profile's overrides", () => {
  it("an absent [scan] is the shipped defaults: validator off, pass-scan at low", () => {
    expect(fixture.scan).toEqual(SCAN_DEFAULTS);
    expect(SCAN_DEFAULTS.validator).toBe(false);
    expect(SCAN_DEFAULTS.effort).toBe("low");
  });

  it("config.toml sets any key; bad values and unknown keys refuse to load", () => {
    const cfg = parseConfig(`${fixtureToml}\n[scan]\neffort = "medium"\nconcurrency = 3\nexclude = ["gen/"]\n`);
    expect(cfg.scan).toEqual({ ...SCAN_DEFAULTS, effort: "medium", concurrency: 3, exclude: ["gen/"] });
    expect(() => parseConfig(`${fixtureToml}\n[scan]\neffort = "max"\n`)).toThrow(/\[scan\] effort/);
    expect(() => parseConfig(`${fixtureToml}\n[scan]\nconcurrency = 0\n`)).toThrow(/positive integer/);
    expect(() => parseConfig(`${fixtureToml}\n[scan]\nexclude = ["/abs"]\n`)).toThrow(/repo-relative/);
    expect(() => parseConfig(`${fixtureToml}\n[scan]\nturbo = true\n`)).toThrow(/unknown key "turbo"/);
  });

  it("the profile's [scan] wins over config.toml, per key, along the extends chain", () => {
    profile("base", `[scan]\neffort = "medium"\nexclude = ["vendor/"]\n`);
    profile("repo", `extends = "base"\n[scan]\nvalidator = true\nexclude = ["gen/"]\n`);
    const cfg = scanConfig(sandbox, configWith("repo", `[scan]\neffort = "high"\nvalidator = false\nconcurrency = 2\n`), { env });
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
    expect(() => scanConfig(sandbox, configWith("repo"), { env })).toThrow(/unknown key "concurrency"/);
    expect(() => parseScanTable("x", { effort: "low" }, ["effort"])).not.toThrow();
  });

  it("the profile's effort reaches the built pass-scan", () => {
    profile("repo", `[scan]\neffort = "medium"\n`);
    const agents = scanBuild(scanConfig(sandbox, configWith("repo"), { env }));
    expect(/^model: (.*)$/m.exec(agents.get("pass-scan--sol-med")!)?.[1]).toMatch(/:medium$/);
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

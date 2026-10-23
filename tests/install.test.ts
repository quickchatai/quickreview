// The install locator: temp XDG homes and QCR_CONFIG
// in, every config path out. Never the operator's own homes: every case hands
// the locator an explicit env.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertPathSegment,
  configHome,
  EXAMPLE_PROFILES,
  installName,
  legacySecretsDir,
  locateConfig,
  locateKeysFile,
  locateProfile,
  locateSecrets,
  migrateConfig,
  migrateProfiles,
  migrateReport,
  migrateSecrets,
  operatorHome,
  profileMigrateReport,
  profileSearchDirs,
  missingConfigMessage,
  repointComposeSecrets,
  secretsHome,
  secretsMigrateReport,
  stateHome,
  strandedCheckoutConfig,
  strandedCheckoutProfile,
  strandedCheckoutProfiles,
  strandedLegacySecrets,
  type InstallEnv,
} from "../src/install.js";
import { loadConfig, parseConfig } from "../src/config.js";
import { MissingConfigError } from "../src/missingconfig.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";
import { CORE_PACKAGE, EXTENSION_DIRS, SRC_DIRS } from "./helpers/source-trees.js";

const linkFault = vi.hoisted(() => ({ path: "" }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    symlinkSync: (...args: Parameters<typeof fs.symlinkSync>) => {
      if (
        linkFault.path &&
        (String(args[1]) === linkFault.path || String(args[1]).startsWith(`${linkFault.path}.`))
      ) {
        linkFault.path = "";
        throw new Error("link repair unavailable");
      }
      return fs.symlinkSync(...args);
    },
  };
});

let dir: string;
let root: string;
let env: InstallEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-install-"));
  root = join(dir, "checkout");
  mkdirSync(root);
  env = {
    HOME: join(dir, "home"),
    XDG_CONFIG_HOME: join(dir, "xdg-config"),
    XDG_STATE_HOME: join(dir, "xdg-state"),
  };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const put = (path: string, text = "dry_run = true\n"): string => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  return path;
};

describe("homes", () => {
  it("config and state homes sit under the XDG dirs, named by the install", () => {
    expect(configHome(env)).toBe(join(dir, "xdg-config", "qcr", "default"));
    expect(stateHome(env)).toBe(join(dir, "xdg-state", "qcr", "default"));
    const two = { ...env, QCR_INSTALL: "second" };
    expect(configHome(two)).toBe(join(dir, "xdg-config", "qcr", "second"));
    expect(stateHome(two)).toBe(join(dir, "xdg-state", "qcr", "second"));
  });

  it("falls back to $HOME/.config and $HOME/.local/state when XDG is unset or relative", () => {
    const bare = { HOME: env.HOME };
    expect(configHome(bare)).toBe(join(dir, "home", ".config", "qcr", "default"));
    expect(stateHome(bare)).toBe(join(dir, "home", ".local", "state", "qcr", "default"));
    const relative = { ...bare, XDG_CONFIG_HOME: "rel/cfg", XDG_STATE_HOME: "rel/st" };
    expect(configHome(relative)).toBe(configHome(bare));
    expect(stateHome(relative)).toBe(stateHome(bare));
  });

  it("QCR_CONFIG_HOME / QCR_STATE_HOME override the whole home, absolute only", () => {
    // The companion container sets these to its mounts; unset on a host.
    const o = { ...env, QCR_CONFIG_HOME: "/qcr-config", QCR_STATE_HOME: "/qcr-state/" };
    expect(configHome(o)).toBe("/qcr-config");
    expect(stateHome(o)).toBe("/qcr-state");
    const rel = { ...env, QCR_CONFIG_HOME: "rel/cfg", QCR_STATE_HOME: " " };
    expect(configHome(rel)).toBe(configHome(env));
    expect(stateHome(rel)).toBe(stateHome(env));
  });

  it("refuses an install name that could escape the qcr dir", () => {
    for (const bad of ["..", "../x", "a/b", ".hidden", "a..b", "", " /"]) {
      if (bad.trim() === "") {
        expect(installName({ QCR_INSTALL: bad })).toBe("default");
        continue;
      }
      expect(() => installName({ QCR_INSTALL: bad })).toThrow(/not a plain name/);
    }
    expect(() => assertPathSegment("profile", "../../etc")).toThrow(/profile/);
    expect(assertPathSegment("profile", "example-django")).toBe("example-django");
  });
});

describe("locateConfig", () => {
  it("QCR_CONFIG wins outright, even over a populated home, even when missing", () => {
    put(join(configHome(env), "config.toml"));
    put(join(root, "config.toml"));
    const target = join(dir, "elsewhere.toml");
    expect(locateConfig({ env: { ...env, QCR_CONFIG: target } })).toMatchObject({
      path: target,
      source: "override",
    });
  });

  it("the config home is the answer", () => {
    const home = put(join(configHome(env), "config.toml"));
    put(join(root, "config.toml"));
    expect(locateConfig({ env })).toEqual({
      path: home,
      source: "home",
      home: configHome(env),
    });
  });

  it("the checkout's config.toml is never the answer — not even with the home empty", () => {
    put(join(root, "config.toml"));
    expect(locateConfig({ env })).toEqual({
      path: join(configHome(env), "config.toml"),
      source: "home",
      home: configHome(env),
    });
  });

  it("with nothing anywhere, the answer is the home — where a new config belongs", () => {
    expect(locateConfig({ env })).toMatchObject({
      path: join(configHome(env), "config.toml"),
      source: "home",
    });
  });

  it("a stranded checkout config is only NAMED, so a missing config points at migrate", () => {
    expect(strandedCheckoutConfig({ root, env })).toBeNull();
    const stranded = put(join(root, "config.toml"));
    expect(strandedCheckoutConfig({ root, env })).toBe(stranded);
    // QCR_CONFIG naming that very file is the operator's choice, not a strand.
    expect(strandedCheckoutConfig({ root, env: { ...env, QCR_CONFIG: stranded } })).toBeNull();
    const msg = missingConfigMessage(locateConfig({ env }), stranded);
    expect(msg).toContain(join(configHome(env), "config.toml"));
    expect(msg).toContain(stranded);
    expect(msg).toContain("qcr install migrate");
    expect(missingConfigMessage(locateConfig({ env }), null)).not.toContain("migrate");
    const named = missingConfigMessage(
      locateConfig({ env: { ...env, QCR_CONFIG: "/x.toml" } }),
      null,
    );
    expect(named).toMatch(/\/x\.toml .*QCR_CONFIG/);
  });

  it("loadConfig() with no config in the home refuses — it never reads the checkout's", async () => {
    const { loadConfig: load, sandboxRoot } = await import("../src/config.js");
    const saved = { ...process.env };
    try {
      delete process.env.QCR_CONFIG;
      Object.assign(process.env, env);
      expect(() => load()).toThrow(
        new RegExp(`no config at ${join(configHome(env), "config.toml")}`),
      );
      // the class the `qcr` bin prints as one line (tests/qcrbin-fs-denied.test.ts)
      // MUTATION: throw a plain Error from loadConfig — this fails.
      expect(() => load()).toThrow(MissingConfigError);
      // The real checkout may strand one; either way the message is the locator's.
      const stranded = strandedCheckoutConfig({ root: sandboxRoot(), env });
      if (stranded) expect(() => load()).toThrow(/qcr install migrate/);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });

  it("loadConfig reads the file the locator names (explicit path unchanged)", () => {
    const fixture = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "fixtures", "config.toml"),
      "utf8",
    );
    const p = put(join(configHome(env), "config.toml"), fixture);
    expect(loadConfig(locateConfig({ env }).path).github.repo).toBe(loadConfig(p).github.repo);
  });
});

describe("migrateConfig", () => {
  it("moves the checkout config into the home, and a second run is a no-op", () => {
    put(join(root, "config.toml"), "x = 1\n");
    const first = migrateConfig({ root, env });
    const to = join(configHome(env), "config.toml");
    expect(first).toEqual({ kind: "moved", from: join(root, "config.toml"), to });
    expect(existsSync(join(root, "config.toml"))).toBe(false);
    expect(readFileSync(to, "utf8")).toBe("x = 1\n");
    expect(locateConfig({ env })).toMatchObject({ path: to, source: "home" });
    expect(migrateConfig({ root, env })).toEqual({ kind: "already", to });
    expect(readFileSync(to, "utf8")).toBe("x = 1\n");
  });

  it("an identical pair drops the checkout copy; a differing pair touches nothing", () => {
    const to = put(join(configHome(env), "config.toml"), "same\n");
    put(join(root, "config.toml"), "same\n");
    expect(migrateConfig({ root, env }).kind).toBe("deduplicated");
    expect(existsSync(join(root, "config.toml"))).toBe(false);

    put(join(root, "config.toml"), "different\n");
    expect(migrateConfig({ root, env }).kind).toBe("conflict");
    expect(readFileSync(join(root, "config.toml"), "utf8")).toBe("different\n");
    expect(readFileSync(to, "utf8")).toBe("same\n");
  });

  it("a config home that IS the checkout never deletes the live config (or its profiles)", () => {
    // onboard bring-up writes QCR_CONFIG_HOME=<root> for a config named inside
    // the checkout; migrate then sees from === to and must not unlink it.
    const home = { ...env, QCR_CONFIG_HOME: root };
    const cfg = put(join(root, "config.toml"), "live = 1\n");
    const prof = put(join(root, "profiles", "mine", "profile.toml"), "p = 1\n");
    const outcome = migrateConfig({ root, env: home });
    expect(outcome).toEqual({ kind: "already", to: cfg, inPlace: true });
    expect(readFileSync(cfg, "utf8")).toBe("live = 1\n");
    // the report never claims the checkout is empty: the live file is in it
    const said = migrateReport(outcome).lines.join("\n");
    expect(said).not.toMatch(/nothing in the checkout/);
    expect(said).toMatch(/stays/);
    expect(migrateProfiles({ root, env: home })).toEqual([]);
    expect(readFileSync(prof, "utf8")).toBe("p = 1\n");
  });

  it("a checkout config.toml that is a RELATIVE symlink lands readable in the home (selfscan)", () => {
    put(join(root, "operator.toml"), "linked = 1\n");
    symlinkSync("operator.toml", join(root, "config.toml"));
    const to = join(configHome(env), "config.toml");
    expect(migrateConfig({ root, env })).toMatchObject({ kind: "moved", to });
    expect(readFileSync(to, "utf8")).toBe("linked = 1\n");
    expect(existsSync(join(root, "config.toml"))).toBe(false);
  });

  it("nothing to move is reported, and QCR_CONFIG makes migrate refuse to guess", () => {
    expect(migrateConfig({ root, env }).kind).toBe("nothing");
    put(join(root, "config.toml"));
    expect(migrateConfig({ root, env: { ...env, QCR_CONFIG: "/x.toml" } })).toEqual({
      kind: "override",
      path: "/x.toml",
    });
    expect(existsSync(join(root, "config.toml"))).toBe(true);
  });
});

describe("qcr install", () => {
  it("migrate reports each outcome with an exit code: only a conflict fails", async () => {
    const { migrateReport } = await import("../src/install.js");
    const to = join(configHome(env), "config.toml");
    const from = join(root, "config.toml");
    const moved = migrateReport({ kind: "moved", from, to });
    expect(moved.code).toBe(0);
    expect(moved.lines.join("\n")).toContain(to);
    // deploy.sh release ships the config home from there.
    expect(moved.lines.join("\n")).toMatch(
      /deploy\.sh release ships the config home to the VM from there/,
    );
    expect(migrateReport({ kind: "already", to }).code).toBe(0);
    expect(migrateReport({ kind: "deduplicated", from, to }).code).toBe(0);
    expect(migrateReport({ kind: "nothing", to }).code).toBe(0);
    expect(migrateReport({ kind: "override", path: "/x.toml" }).code).toBe(0);
    const conflict = migrateReport({ kind: "conflict", from, to });
    expect(conflict.code).toBe(1);
    expect(conflict.lines.join("\n")).toMatch(/differ/);
  });

  it(
    "the CLI's migrate moves the checkout config and is idempotent",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const { cmdInstall } = await import("../src/cli.js");
      put(join(root, "config.toml"), "x = 1\n");
      const out: string[] = [];
      const log = (l: string) => out.push(l);
      expect(cmdInstall(["migrate"], { root, env, log })).toBe(0);
      const to = join(configHome(env), "config.toml");
      expect(readFileSync(to, "utf8")).toBe("x = 1\n");
      expect(existsSync(join(root, "config.toml"))).toBe(false);
      expect(cmdInstall(["migrate"], { root, env, log })).toBe(0);
      expect(out.join("\n")).toMatch(/already/);
      expect(readFileSync(to, "utf8")).toBe("x = 1\n");
    },
  );

  it("the CLI's where names both homes, and what the checkout still strands", async () => {
    const { cmdInstall } = await import("../src/cli.js");
    const out: string[] = [];
    expect(cmdInstall(["where"], { root, env, log: (l) => out.push(l) })).toBe(0);
    let text = out.join("\n");
    expect(text).toContain(configHome(env));
    expect(text).toContain(stateHome(env));
    expect(text).toMatch(/\(home, missing\)/);
    expect(text).not.toMatch(/stranded/);
    put(join(root, "config.toml"));
    out.length = 0;
    cmdInstall(["where"], { root, env, log: (l) => out.push(l) });
    text = out.join("\n");
    expect(text).toContain(`config      ${join(configHome(env), "config.toml")}  (home, missing)`);
    expect(text).toMatch(new RegExp(`stranded +${join(root, "config.toml")} — no longer read`));
    expect(() => cmdInstall(["bogus"], { root, env, log: () => {} })).toThrow(/usage: qcr install/);
  });
});

describe("no TypeScript reader builds the checkout config path itself", () => {
  // Every reader of the live config goes through the
  // locator. The one allowed spelling compares a located path against the
  // checkout's (to decide whether an accepted proposal is committed) — it
  // never reads it. The shell half is swept in tests/install-shell.test.ts.
  const ALLOWED = new Set(["src/tui/proposals.ts"]);
  const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
  const BUILDS = /(join|resolve)\([^()]*"config\.toml"\)|\$\{[A-Za-z_.]+\}\/config\.toml/;

  function* sources(rel: string): Generator<string> {
    for (const entry of readdirSync(join(repo, rel), { withFileTypes: true })) {
      const path = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== "vendor") yield* sources(path);
      } else if (/\.(ts|mjs)$/.test(entry.name)) yield path;
    }
  }

  it("src/, extensions/ (the app's and the core's) and deploy/ name config.toml only through the locator", () => {
    const offenders: string[] = [];
    for (const top of [...SRC_DIRS, ...EXTENSION_DIRS, "deploy"]) {
      for (const rel of sources(top)) {
        if (ALLOWED.has(rel)) continue;
        const text = readFileSync(join(repo, rel), "utf8");
        text.split("\n").forEach((line, i) => {
          if (BUILDS.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
        });
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ---- repo profiles ----------------------------------------------------------

/** A profile directory with one file, whose bytes tell the copies apart. */
const putProfile = (base: string, name: string, body = "x\n"): string => {
  const p = join(base, "profiles", name);
  put(join(p, "addenda", "10-rule.md"), body);
  return p;
};

describe("locateProfile", () => {
  it("the config home first, then profiles/ beside QCR_CONFIG, then the checkout's examples", () => {
    const example = putProfile(root, "minimal");
    expect(locateProfile({ root, profile: "minimal", env })).toEqual({
      name: "minimal",
      dir: example,
      source: "checkout",
    });
    putProfile(root, "house");
    // An install's own profile left in the checkout is never read.
    expect(locateProfile({ root, profile: "house", env })).toBeNull();
    const beside = join(dir, "mounted");
    const inOverride = putProfile(beside, "house");
    const withOverride = { ...env, QCR_CONFIG: join(beside, "config.toml") };
    expect(locateProfile({ root, profile: "house", env: withOverride })).toMatchObject({
      dir: inOverride,
      source: "override",
    });
    const inHome = putProfile(configHome(env), "house");
    for (const e of [env, withOverride]) {
      expect(locateProfile({ root, profile: "house", env: e })).toMatchObject({
        dir: inHome,
        source: "home",
      });
    }
    expect(locateProfile({ root, profile: "elsewhere", env })).toBeNull();
  });

  it("QCR_CONFIG naming the checkout's own config adds no extra place", () => {
    expect(
      profileSearchDirs({ root, env: { ...env, QCR_CONFIG: join(root, "config.toml") } }),
    ).toEqual([join(configHome(env), "profiles"), join(root, "profiles")]);
  });

  it("a FILE named like the profile does not shadow a directory further down", () => {
    put(join(configHome(env), "profiles", "minimal"));
    const inCheckout = putProfile(root, "minimal");
    expect(locateProfile({ root, profile: "minimal", env })?.dir).toBe(inCheckout);
  });

  it("profiles/ beside a QCR_CONFIG inside the checkout is the override place, not the checkout's", () => {
    // The bench image and a hand-run QCR_CONFIG: the directory is reached
    // first as "beside the named config", which the operator chose.
    const house = putProfile(root, "house");
    const e = { ...env, QCR_CONFIG: join(root, "config.toml") };
    expect(locateProfile({ root, profile: "house", env: e })).toMatchObject({
      dir: house,
      source: "override",
    });
    expect(strandedCheckoutProfile({ root, profile: "house", env: e })).toBeNull();
  });

  it("refuses a profile name that could escape profiles/", () => {
    putProfile(dir, "escape");
    for (const bad of ["..", "../escape", "a/b", ".hidden", "/etc", "x/../../escape"]) {
      expect(() => locateProfile({ root, profile: bad, env }), bad).toThrow(
        /profile .* not a plain name/,
      );
    }
  });

  it("names a stranded checkout profile — never an example, never one the home holds too", () => {
    const house = putProfile(root, "house");
    putProfile(root, "minimal");
    putProfile(root, "second");
    expect(strandedCheckoutProfile({ root, profile: "house", env })).toBe(house);
    expect(strandedCheckoutProfile({ root, profile: "minimal", env })).toBeNull();
    expect(strandedCheckoutProfile({ root, profile: "absent", env })).toBeNull();
    expect(strandedCheckoutProfiles({ root, env })).toEqual([
      house,
      join(root, "profiles", "second"),
    ]);
    expect(() => strandedCheckoutProfile({ root, profile: "../x", env })).toThrow(/plain name/);
  });
});

describe("migrateProfiles", () => {
  it("moves every non-example checkout profile into the home, idempotently; the examples stay", () => {
    putProfile(root, "house-pack", "qc\n");
    for (const example of EXAMPLE_PROFILES) putProfile(root, example);
    const first = migrateProfiles({ root, env });
    const to = join(configHome(env), "profiles", "house-pack");
    expect(first).toEqual([
      { kind: "moved", name: "house-pack", from: join(root, "profiles", "house-pack"), to },
    ]);
    expect(existsSync(join(root, "profiles", "house-pack"))).toBe(false);
    expect(readFileSync(join(to, "addenda", "10-rule.md"), "utf8")).toBe("qc\n");
    for (const example of EXAMPLE_PROFILES) {
      expect(existsSync(join(root, "profiles", example)), example).toBe(true);
    }
    expect(locateProfile({ root, profile: "house-pack", env })).toMatchObject({ source: "home" });
    expect(migrateProfiles({ root, env })).toEqual([]);
  });

  it("an identical home copy drops the checkout's; a differing one touches neither", () => {
    putProfile(root, "house", "same\n");
    putProfile(configHome(env), "house", "same\n");
    expect(migrateProfiles({ root, env }).map((o) => o.kind)).toEqual(["deduplicated"]);
    expect(existsSync(join(root, "profiles", "house"))).toBe(false);

    putProfile(root, "house", "different\n");
    expect(migrateProfiles({ root, env }).map((o) => o.kind)).toEqual(["conflict"]);
    expect(readFileSync(join(root, "profiles", "house", "addenda", "10-rule.md"), "utf8")).toBe(
      "different\n",
    );
    expect(
      readFileSync(join(configHome(env), "profiles", "house", "addenda", "10-rule.md"), "utf8"),
    ).toBe("same\n");
    // an extra file on one side is a difference too
    put(join(configHome(env), "profiles", "house", "README.md"));
    rmSync(join(root, "profiles", "house"), { recursive: true });
    putProfile(root, "house", "same\n");
    expect(migrateProfiles({ root, env }).map((o) => o.kind)).toEqual(["conflict"]);
  });

  it("a home profile that is a link to the checkout's is never 'deduplicated' away (selfscan)", () => {
    const from = putProfile(root, "house", "only copy\n");
    mkdirSync(join(configHome(env), "profiles"), { recursive: true });
    const to = join(configHome(env), "profiles", "house");
    symlinkSync(from, to);
    const [o] = migrateProfiles({ root, env });
    expect(o).toMatchObject({ kind: "aliased", name: "house", from, to });
    expect(readFileSync(join(from, "addenda", "10-rule.md"), "utf8")).toBe("only copy\n");
    expect(readFileSync(join(to, "addenda", "10-rule.md"), "utf8")).toBe("only copy\n");
    const report = profileMigrateReport([o!]);
    expect(report.code).toBe(0);
    expect(report.lines.join("\n")).toMatch(/link/);
  });

  it("a home profile whose FILES link into the checkout's is never 'deduplicated' away", () => {
    const from = putProfile(root, "house", "only copy\n");
    const to = join(configHome(env), "profiles", "house");
    mkdirSync(join(to, "addenda"), { recursive: true });
    symlinkSync(join(from, "addenda", "10-rule.md"), join(to, "addenda", "10-rule.md"));
    const [o] = migrateProfiles({ root, env });
    expect(o).toMatchObject({ kind: "aliased", name: "house", from, to });
    expect(readFileSync(join(from, "addenda", "10-rule.md"), "utf8")).toBe("only copy\n");
    expect(readFileSync(join(to, "addenda", "10-rule.md"), "utf8")).toBe("only copy\n");
  });

  it("a sibling link left dangling by an interrupted run still migrates on the re-run", () => {
    // the state a run stopped between moving house-real and re-pointing house
    put(join(configHome(env), "profiles", "house-real", "addenda", "10-rule.md"), "real\n");
    mkdirSync(join(root, "profiles"), { recursive: true });
    symlinkSync("house-real", join(root, "profiles", "house"));
    const out = migrateProfiles({ root, env });
    expect(out.map((o) => [o.kind, o.name])).toEqual([["moved", "house"]]);
    const home = join(configHome(env), "profiles");
    expect(readFileSync(join(home, "house", "addenda", "10-rule.md"), "utf8")).toBe("real\n");
    expect(lstatSync(join(root, "profiles", "house"), { throwIfNoEntry: false })).toBeUndefined();
    expect(locateProfile({ root, profile: "house", env })).toMatchObject({ source: "home" });
  });

  it("a run stopped after re-pointing a sibling link but before removing the checkout's converges on the re-run", () => {
    // the state a run stopped between symlinkSync(home/house) and unlinkSync(checkout/house)
    const home = join(configHome(env), "profiles");
    put(join(home, "house-real", "addenda", "10-rule.md"), "real\n");
    symlinkSync(join(home, "house-real"), join(home, "house"));
    mkdirSync(join(root, "profiles"), { recursive: true });
    symlinkSync("house-real", join(root, "profiles", "house"));
    const out = migrateProfiles({ root, env });
    expect(out.map((o) => [o.kind, o.name])).toEqual([["deduplicated", "house"]]);
    expect(lstatSync(join(root, "profiles", "house"), { throwIfNoEntry: false })).toBeUndefined();
    expect(readFileSync(join(home, "house", "addenda", "10-rule.md"), "utf8")).toBe("real\n");
    expect(migrateProfiles({ root, env })).toEqual([]);
  });

  it("a dangling checkout sibling link whose name the home holds as its own profile is a conflict, never a throw", () => {
    const home = join(configHome(env), "profiles");
    put(join(home, "house-real", "addenda", "10-rule.md"), "real\n");
    put(join(home, "house", "addenda", "10-rule.md"), "own\n");
    mkdirSync(join(root, "profiles"), { recursive: true });
    symlinkSync("house-real", join(root, "profiles", "house"));
    const out = migrateProfiles({ root, env });
    expect(out.map((o) => [o.kind, o.name])).toEqual([["conflict", "house"]]);
    expect(lstatSync(join(root, "profiles", "house")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(home, "house", "addenda", "10-rule.md"), "utf8")).toBe("own\n");
    expect(profileMigrateReport(out).code).toBe(1);
  });

  it("a checkout profile that is a symlink to an external pack migrates too (selfscan)", () => {
    const pack = join(dir, "packs", "house");
    put(join(pack, "addenda", "10-rule.md"), "pack\n");
    mkdirSync(join(root, "profiles"), { recursive: true });
    symlinkSync(join("..", "..", "packs", "house"), join(root, "profiles", "house"));
    expect(strandedCheckoutProfiles({ root, env })).toEqual([join(root, "profiles", "house")]);
    const to = join(configHome(env), "profiles", "house");
    expect(migrateProfiles({ root, env })).toEqual([
      { kind: "moved", name: "house", from: join(root, "profiles", "house"), to },
    ]);
    expect(readFileSync(join(to, "addenda", "10-rule.md"), "utf8")).toBe("pack\n");
    expect(readFileSync(join(pack, "addenda", "10-rule.md"), "utf8")).toBe("pack\n");
    expect(existsSync(join(root, "profiles", "house"))).toBe(false);
    expect(strandedCheckoutProfiles({ root, env })).toEqual([]);
  });

  it("a checkout profile linked to a SIBLING checkout profile follows it into the home (review)", () => {
    put(join(root, "profiles", "house-real", "addenda", "10-rule.md"), "real\n");
    symlinkSync("house-real", join(root, "profiles", "house"));
    const home = join(configHome(env), "profiles");
    const out = migrateProfiles({ root, env });
    expect(out.map((o) => [o.kind, o.name])).toEqual([
      ["moved", "house"],
      ["moved", "house-real"],
    ]);
    expect(readFileSync(join(home, "house", "addenda", "10-rule.md"), "utf8")).toBe("real\n");
    expect(readFileSync(join(home, "house-real", "addenda", "10-rule.md"), "utf8")).toBe("real\n");
  });

  it("links inside a moved profile keep their referents, inside it, in a moved sibling or left behind", () => {
    const from = join(root, "profiles");
    putProfile(root, "house", "own\n");
    put(join(from, "house", "shared", "rule.md"), "inner\n");
    putProfile(root, "other", "sib\n");
    put(join(root, "shared", "outside.md"), "outside\n");
    for (const example of EXAMPLE_PROFILES) putProfile(root, example);
    put(join(from, EXAMPLE_PROFILES[0]!, "profile.toml"), "base = 1\n");
    const links: [string, string, string][] = [
      // [link under house/, target as written, the bytes it must still read]
      ["addenda/abs-inner.md", join(from, "house", "shared", "rule.md"), "inner\n"],
      ["addenda/rel-inner.md", "../shared/rule.md", "inner\n"],
      ["addenda/rel-outside.md", "../../../shared/outside.md", "outside\n"],
      ["addenda/abs-sibling.md", join(from, "other", "addenda", "10-rule.md"), "sib\n"],
      ["addenda/rel-sibling.md", "../../other/addenda/10-rule.md", "sib\n"],
      ["profile.toml", `../${EXAMPLE_PROFILES[0]!}/profile.toml`, "base = 1\n"],
    ];
    for (const [at, target] of links) symlinkSync(target, join(from, "house", at));
    expect(migrateProfiles({ root, env }).map((o) => [o.kind, o.name])).toEqual([
      ["moved", "house"],
      ["moved", "other"],
    ]);
    const home = join(configHome(env), "profiles", "house");
    for (const [at, , bytes] of links) expect(readFileSync(join(home, at), "utf8"), at).toBe(bytes);
    // A link into a tree that moved points at the home's copy, never back into the checkout.
    expect(readlinkSync(join(home, "addenda", "abs-inner.md"))).toBe(
      join(home, "shared", "rule.md"),
    );
    expect(readlinkSync(join(home, "addenda", "rel-inner.md"))).toBe("../shared/rule.md");
    expect(realpathSync(join(home, "addenda", "abs-sibling.md"))).toBe(
      realpathSync(join(configHome(env), "profiles", "other", "addenda", "10-rule.md")),
    );
  });

  it.each(["relative", "absolute"] as const)(
    "a %s descendant link follows a sibling deduplicated against its home copy",
    (kind) => {
      putProfile(root, "house", "own\n");
      putProfile(root, "other", "shared\n");
      putProfile(configHome(env), "other", "shared\n");
      const from = join(root, "profiles");
      const at = join(from, "house", "addenda", "linked.md");
      symlinkSync(
        kind === "relative"
          ? "../../other/addenda/10-rule.md"
          : join(from, "other", "addenda", "10-rule.md"),
        at,
      );

      expect(migrateProfiles({ root, env }).map((o) => [o.kind, o.name])).toEqual([
        ["moved", "house"],
        ["deduplicated", "other"],
      ]);
      const home = join(configHome(env), "profiles");
      const migrated = join(home, "house", "addenda", "linked.md");
      expect(existsSync(join(from, "other"))).toBe(false);
      expect(readFileSync(migrated, "utf8")).toBe("shared\n");
      expect(realpathSync(migrated)).toBe(join(home, "other", "addenda", "10-rule.md"));
      expect(migrateProfiles({ root, env })).toEqual([]);
      expect(readFileSync(migrated, "utf8")).toBe("shared\n");
    },
  );

  it("recovers unfinished descendant link repairs after the profile already moved", () => {
    putProfile(root, "house", "own\n");
    putProfile(root, "other", "shared\n");
    symlinkSync(
      join(root, "profiles", "other", "addenda", "10-rule.md"),
      join(root, "profiles", "house", "addenda", "linked.md"),
    );
    const at = join(configHome(env), "profiles", "house", "addenda", "linked.md");
    linkFault.path = at;
    expect(() => migrateProfiles({ root, env })).toThrow("link repair unavailable");
    expect(existsSync(join(root, "profiles", "house"))).toBe(false);
    migrateProfiles({ root, env });
    expect(readFileSync(at, "utf8")).toBe("shared\n");
  });

  it("refuses a changed descendant directory during journal replay without writing through it", () => {
    putProfile(root, "house", "own\n");
    putProfile(root, "other", "shared\n");
    symlinkSync(
      join(root, "profiles", "other", "addenda", "10-rule.md"),
      join(root, "profiles", "house", "addenda", "linked.md"),
    );
    const migrated = join(configHome(env), "profiles", "house", "addenda");
    linkFault.path = join(migrated, "linked.md");
    expect(() => migrateProfiles({ root, env })).toThrow("link repair unavailable");
    const outside = join(dir, "outside");
    mkdirSync(outside);
    rmSync(migrated, { recursive: true });
    symlinkSync(outside, migrated);
    expect(() => migrateProfiles({ root, env })).toThrow(/changed.*migration|migration.*changed/);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("refuses an invalid repair plan before moving profiles or touching outside paths", () => {
    putProfile(root, "house");
    const home = join(configHome(env), "profiles");
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, ".qcr-profile-repair.json"),
      JSON.stringify({
        version: 1,
        from: join(root, "profiles"),
        to: home,
        links: [{ profile: "house", path: "../../outside", target: "/unrelated" }],
      }),
    );
    expect(() => migrateProfiles({ root, env })).toThrow("invalid profile repair journal");
    expect(existsSync(join(root, "profiles", "house"))).toBe(true);
    expect(existsSync(join(home, "house"))).toBe(false);
  });

  it("leaves directories that are not admissible profile names in the checkout", () => {
    putProfile(root, ".scratch");
    putProfile(root, "house");
    expect(migrateProfiles({ root, env }).map((row) => row.name)).toEqual(["house"]);
    expect(existsSync(join(root, "profiles", ".scratch"))).toBe(true);
    expect(existsSync(join(configHome(env), "profiles", ".scratch"))).toBe(false);
  });

  it("compares nested links before moving an earlier sibling referent", () => {
    putProfile(root, "a-shared", "shared\n");
    putProfile(root, "z-house", "own\n");
    putProfile(configHome(env), "a-shared", "shared\n");
    putProfile(configHome(env), "z-house", "own\n");
    symlinkSync(
      "../../a-shared/addenda/10-rule.md",
      join(root, "profiles", "z-house", "addenda", "linked.md"),
    );
    symlinkSync(
      "../../a-shared/addenda/10-rule.md",
      join(configHome(env), "profiles", "z-house", "addenda", "linked.md"),
    );
    expect(migrateProfiles({ root, env }).map((row) => row.kind)).toEqual([
      "deduplicated",
      "deduplicated",
    ]);
  });

  it("a duplicate whose home copy holds a plain file where the checkout had a link deduplicates without a throw", () => {
    putProfile(root, "house", "same\n");
    putProfile(configHome(env), "house", "same\n");
    const rule = join(root, "profiles", "house", "addenda", "10-rule.md");
    symlinkSync(rule, join(root, "profiles", "house", "addenda", "linked.md"));
    writeFileSync(join(configHome(env), "profiles", "house", "addenda", "linked.md"), "same\n");
    expect(migrateProfiles({ root, env }).map((o) => o.kind)).toEqual(["deduplicated"]);
    expect(migrateProfiles({ root, env })).toEqual([]);
  });

  it("a conflicted profile's link follows a sibling that moves into the home", () => {
    putProfile(root, "house", "own\n");
    putProfile(configHome(env), "house", "different\n");
    putProfile(root, "other", "shared\n");
    const at = join(root, "profiles", "house", "addenda", "linked.md");
    symlinkSync("../../other/addenda/10-rule.md", at);
    expect(migrateProfiles({ root, env }).map((o) => [o.kind, o.name])).toEqual([
      ["conflict", "house"],
      ["moved", "other"],
    ]);
    expect(readFileSync(at, "utf8")).toBe("shared\n");
  });

  it("repairs an aliased profile's links when its sibling moves", () => {
    putProfile(root, "house", "own\n");
    putProfile(root, "other", "shared\n");
    mkdirSync(join(configHome(env), "profiles"), { recursive: true });
    symlinkSync(join(root, "profiles", "house"), join(configHome(env), "profiles", "house"));
    symlinkSync(
      "../../other/addenda/10-rule.md",
      join(root, "profiles", "house", "addenda", "linked.md"),
    );
    expect(migrateProfiles({ root, env }).map((row) => row.kind)).toEqual(["aliased", "moved"]);
    expect(readFileSync(join(root, "profiles", "house", "addenda", "linked.md"), "utf8")).toBe(
      "shared\n",
    );
  });

  it("moves nothing while QCR_CONFIG names the config — compose mounts THAT file's dir, not the home", () => {
    putProfile(root, "house");
    const [o] = migrateProfiles({ root, env: { ...env, QCR_CONFIG: join(dir, "x.toml") } });
    expect(o).toMatchObject({ kind: "override", name: "house", path: join(dir, "x.toml") });
    expect(existsSync(join(root, "profiles", "house"))).toBe(true);
    expect(existsSync(join(configHome(env), "profiles", "house"))).toBe(false);
    const report = profileMigrateReport([o!]);
    expect(report.code).toBe(0);
    expect(report.lines.join("\n")).toMatch(/QCR_CONFIG names/);
  });

  it("reports each outcome; only a conflict fails", () => {
    expect(profileMigrateReport([]).code).toBe(0);
    const moved = profileMigrateReport([{ kind: "moved", name: "q", from: "/a", to: "/b" }]);
    expect(moved.code).toBe(0);
    expect(moved.lines.join("\n")).toMatch(
      /deploy\.sh release ships the config home's profiles\/ to the VM with the config\./,
    );
    expect(profileMigrateReport([{ kind: "conflict", name: "q", from: "/a", to: "/b" }]).code).toBe(
      1,
    );
  });
});

describe("qcr install migrate — profiles", () => {
  it("moves the config and the install's own profile together, and a re-run is a no-op", async () => {
    const { cmdInstall } = await import("../src/cli.js");
    put(join(root, "config.toml"), "x = 1\n");
    putProfile(root, "house-pack", "qc\n");
    putProfile(root, "minimal");
    const out: string[] = [];
    const log = (l: string) => out.push(l);
    // before the move the lookup reads nothing — the pack is stranded
    expect(locateProfile({ root, profile: "house-pack", env })).toBeNull();
    expect(cmdInstall(["migrate"], { root, env, log })).toBe(0);
    expect(existsSync(join(configHome(env), "config.toml"))).toBe(true);
    expect(locateProfile({ root, profile: "house-pack", env })?.source).toBe("home");
    expect(existsSync(join(root, "profiles", "minimal"))).toBe(true);
    expect(out.join("\n")).toMatch(/moved profile house-pack/);
    out.length = 0;
    expect(cmdInstall(["migrate"], { root, env, log })).toBe(0);
    expect(out.join("\n")).toMatch(/none in the checkout beyond the generic examples/);
  });

  it("a profile conflict fails the command even when the config moved", async () => {
    const { cmdInstall } = await import("../src/cli.js");
    put(join(root, "config.toml"));
    putProfile(root, "house", "a\n");
    putProfile(configHome(env), "house", "b\n");
    expect(cmdInstall(["migrate"], { root, env, log: () => {} })).toBe(1);
    expect(existsSync(join(configHome(env), "config.toml"))).toBe(true);
  });

  it("where names the profile search order", async () => {
    const { cmdInstall } = await import("../src/cli.js");
    const out: string[] = [];
    cmdInstall(["where"], { root, env, log: (l) => out.push(l) });
    expect(out.join("\n")).toContain(
      `${join(configHome(env), "profiles")} → ${join(root, "profiles")}  (the checkout: generic examples only)`,
    );
    putProfile(root, "house");
    out.length = 0;
    cmdInstall(["where"], { root, env, log: (l) => out.push(l) });
    expect(out.join("\n")).toMatch(/stranded +\S*profiles\/house — no longer read/);
  });
});

describe("the checkout's profiles/ holds the generic examples", () => {
  const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

  it("the tracked profiles/ is exactly the generic examples", () => {
    // A pack left there (the deployment's own, until `qcr install
    // migrate` moves it) is never read, and whatever it is called it must
    // never be committed: the repository is public.
    const tracked = execFileSync("git", ["ls-files", "-z", "profiles"], {
      cwd: repo,
      encoding: "utf8",
    })
      .split("\0")
      .filter((p) => p.length > 0);
    const dirs = [...new Set(tracked.map((p) => p.split("/")[1]!))].sort();
    expect(dirs).toEqual([...EXAMPLE_PROFILES].sort());
  });

  it(
    "no TypeScript module but the locator builds a profiles/ path",
    { timeout: HEAVY_TIMEOUT_MS },
    () => {
      const offenders: string[] = [];
      const walk = (rel: string): void => {
        for (const entry of readdirSync(join(repo, rel), { withFileTypes: true })) {
          const path = `${rel}/${entry.name}`;
          if (entry.isDirectory()) {
            if (entry.name !== "vendor") walk(path);
          } else if (/\.(ts|mjs)$/.test(entry.name) && path !== "src/install.ts") {
            readFileSync(join(repo, path), "utf8")
              .split("\n")
              .forEach((line, i) => {
                if (/(join|resolve)\([^()]*"profiles"/.test(line))
                  offenders.push(`${path}:${i + 1}: ${line.trim()}`);
              });
          }
        }
      };
      for (const top of [...SRC_DIRS, ...EXTENSION_DIRS]) walk(top);
      expect(offenders).toEqual([]);
    },
  );
});

// ---- secrets under the install's config home --------------------------------

describe("locateSecrets", () => {
  const secret = (dirPath: string, name = "app_id", text = "123\n"): string => {
    mkdirSync(dirPath, { recursive: true });
    writeFileSync(join(dirPath, name), text, { mode: 0o600 });
    return dirPath;
  };

  it("the secrets home is <config home>/secrets; the legacy dir is $HOME/.config/quickreview-bot", () => {
    expect(secretsHome(env)).toBe(join(configHome(env), "secrets"));
    expect(legacySecretsDir(env)).toBe(join(dir, "home", ".config", "quickreview-bot"));
  });

  it("a configured secrets_dir the operator chose is taken as given, ~ expanded", () => {
    secret(secretsHome(env));
    expect(locateSecrets({ configured: "~/keys", env })).toMatchObject({
      path: join(dir, "home", "keys"),
      source: "configured",
    });
    expect(locateSecrets({ configured: "/abs/keys", override: "/x", env }).path).toBe("/abs/keys");
  });

  it("empty or the legacy default spelling lets the locator decide — home first", () => {
    secret(legacySecretsDir(env));
    secret(secretsHome(env));
    for (const configured of [
      "",
      null,
      "~/.config/quickreview-bot",
      "~/.config/quickreview-bot/",
      legacySecretsDir(env),
    ]) {
      expect(locateSecrets({ configured, env })).toEqual({
        path: secretsHome(env),
        source: "home",
        home: secretsHome(env),
      });
    }
  });

  it("the old dir is never the answer — not even with the home missing", () => {
    secret(legacySecretsDir(env));
    for (const configured of ["", "~/.config/quickreview-bot", legacySecretsDir(env)]) {
      expect(locateSecrets({ configured, env })).toEqual({
        path: secretsHome(env),
        source: "home",
        home: secretsHome(env),
      });
    }
    // …it is only NAMED, while it still holds anything, so a missing
    // credential can point at migrate.
    expect(strandedLegacySecrets(env)).toBe(legacySecretsDir(env));
    rmSync(join(legacySecretsDir(env), "app_id"));
    expect(strandedLegacySecrets(env)).toBeNull();
    rmSync(legacySecretsDir(env), { recursive: true });
    expect(strandedLegacySecrets(env)).toBeNull();
  });

  it("a caller's override sits below a configured value and above the homes", () => {
    secret(secretsHome(env));
    expect(locateSecrets({ override: "~/over", env })).toMatchObject({
      path: join(dir, "home", "over"),
      source: "override",
    });
  });

  // config.toml names HOST paths, and a container sees its secrets only at
  // the mount — so inside one, the mount the entrypoint names is the answer,
  // whatever the (shared) config says. On a host the knob is never set.
  it("inside a container the secrets mount wins over a configured host path", () => {
    const inContainer = { ...env, QCR_SECRETS_MOUNT: "/opt/quickreview/secrets" };
    for (const configured of ["/srv/qcr-secrets", "~/keys", "", null]) {
      expect(locateSecrets({ configured, override: "/over", env: inContainer })).toMatchObject({
        path: "/opt/quickreview/secrets",
        source: "mount",
      });
    }
    // Only an absolute mount is honoured; a relative one names no mount.
    expect(
      locateSecrets({ configured: "/srv/x", env: { ...env, QCR_SECRETS_MOUNT: "rel/secrets" } })
        .path,
    ).toBe("/srv/x");
  });

  it("with nothing anywhere, the answer is the home — where new secrets belong", () => {
    expect(locateSecrets({ env })).toMatchObject({ path: secretsHome(env), source: "home" });
  });

  it("the config loader resolves [github] secrets_dir through the locator", () => {
    const fixture = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "fixtures", "config.toml"),
      "utf8",
    );
    const withDir = (value: string): string =>
      fixture.replace(/^secrets_dir = .*$/m, `secrets_dir = ${JSON.stringify(value)}`);
    const saved = { ...process.env };
    try {
      Object.assign(process.env, env);
      expect(parseConfig(withDir("")).github.secrets_dir).toBe(secretsHome(env));
      secret(legacySecretsDir(env));
      // The legacy spelling, with the legacy dir populated, still reads the home.
      expect(parseConfig(withDir("~/.config/quickreview-bot")).github.secrets_dir).toBe(
        secretsHome(env),
      );
      secret(secretsHome(env));
      expect(parseConfig(withDir("~/.config/quickreview-bot")).github.secrets_dir).toBe(
        secretsHome(env),
      );
      expect(parseConfig(withDir("/elsewhere")).github.secrets_dir).toBe("/elsewhere");
      // An absent key is the same as an empty one.
      expect(parseConfig(fixture.replace(/^secrets_dir = .*$/m, "")).github.secrets_dir).toBe(
        secretsHome(env),
      );
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });
});

describe("locateKeysFile", () => {
  const keys = (path: string): string => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "OPENVIKING_REVIEWER_KEY=x\n", { mode: 0o600 });
    return path;
  };

  it("lives in the operator home — outside the config home a container mounts", () => {
    const home = join(operatorHome(env), "openviking-keys.env");
    expect(operatorHome(env)).toBe(join(dir, "xdg-config", "qcr-operator", "default"));
    expect(home.startsWith(configHome(env) + "/")).toBe(false);
    expect(locateKeysFile({ env })).toEqual({ path: home, source: "home", home });
  });

  it("QCR_OPENVIKING_KEYS wins; the old copy is never read", () => {
    keys(join(legacySecretsDir(env), "openviking-keys.env"));
    expect(locateKeysFile({ env })).toMatchObject({
      path: join(operatorHome(env), "openviking-keys.env"),
      source: "home",
    });
    const home = keys(join(operatorHome(env), "openviking-keys.env"));
    expect(locateKeysFile({ env })).toMatchObject({ path: home, source: "home" });
    expect(locateKeysFile({ env: { ...env, QCR_OPENVIKING_KEYS: "/k.env" } })).toMatchObject({
      path: "/k.env",
      source: "override",
    });
  });
});

describe("migrateSecrets", () => {
  const legacy = (): string => legacySecretsDir(env);
  const put600 = (name: string, text: string, mode = 0o600): void => {
    mkdirSync(legacy(), { recursive: true });
    writeFileSync(join(legacy(), name), text);
    chmodSync(join(legacy(), name), mode);
  };
  const mode = (p: string): number => statSync(p).mode & 0o777;

  it("moves every secret into the home preserving 0600, the key file to the operator home", () => {
    put600("app_id", "123\n");
    put600("app.pem", "PEM\n");
    put600("openviking-keys.env", "OPENVIKING_REVIEWER_KEY=x\n");
    const m = migrateSecrets({ env });
    expect(m.kind).toBe("done");
    for (const name of ["app_id", "app.pem"]) {
      const to = join(secretsHome(env), name);
      expect(readFileSync(to, "utf8").length).toBeGreaterThan(0);
      expect(mode(to)).toBe(0o600);
    }
    const keysTo = join(operatorHome(env), "openviking-keys.env");
    expect(mode(keysTo)).toBe(0o600);
    expect(mode(secretsHome(env))).toBe(0o700);
    expect(mode(operatorHome(env))).toBe(0o700);
    expect(existsSync(legacy())).toBe(false);
    // Every reader follows: the locator now answers the homes.
    expect(locateSecrets({ configured: "~/.config/quickreview-bot", env }).source).toBe("home");
    expect(locateKeysFile({ env }).path).toBe(keysTo);
  });

  it("is idempotent, and never overwrites a differing secret", () => {
    put600("app_id", "123\n");
    migrateSecrets({ env });
    expect(migrateSecrets({ env }).kind).toBe("nothing");

    put600("app_id", "123\n"); // same bytes, but the dir cannot be emptied → kept
    put600("webhook_secret", "s3cret-old\n");
    mkdirSync(secretsHome(env), { recursive: true });
    writeFileSync(join(secretsHome(env), "webhook_secret"), "s3cret-new\n");
    const m = migrateSecrets({ env });
    if (m.kind !== "done") throw new Error(m.kind);
    expect(Object.fromEntries(m.files.map((f) => [f.name, f.outcome]))).toEqual({
      app_id: "skipped",
      webhook_secret: "conflict",
    });
    expect(m.held).toEqual(["webhook_secret"]);
    expect(readFileSync(join(secretsHome(env), "webhook_secret"), "utf8")).toBe("s3cret-new\n");
    expect(readFileSync(join(legacy(), "webhook_secret"), "utf8")).toBe("s3cret-old\n");
    expect(m.remaining).toEqual(["app_id", "webhook_secret"]);
    const report = secretsMigrateReport(m);
    expect(report.code).toBe(1);
    expect(report.lines.join("\n")).toMatch(/differ/);
    // Names only — never a value.
    expect(report.lines.join("\n")).not.toContain("s3cret");

    // Settled by hand (the legacy copy dropped): the re-run empties the dir.
    rmSync(join(legacy(), "webhook_secret"));
    const settled = migrateSecrets({ env });
    if (settled.kind !== "done") throw new Error(settled.kind);
    expect(settled.files.map((f) => f.outcome)).toEqual(["deduplicated"]);
    expect(existsSync(legacy())).toBe(false);
  });

  it("a conflict keeps the legacy dir whole: the other secrets are copied, never moved out of a mount", () => {
    put600("app.pem", "RUNNING-PEM\n");
    put600("app_id", "123\n");
    put600("webhook_secret", "s\n", 0o640);
    mkdirSync(secretsHome(env), { recursive: true });
    writeFileSync(join(secretsHome(env), "app.pem"), "OTHER-PEM\n");
    const m = migrateSecrets({ env });
    if (m.kind !== "done") throw new Error(m.kind);
    expect(Object.fromEntries(m.files.map((f) => [f.name, f.outcome]))).toEqual({
      "app.pem": "conflict",
      app_id: "copied",
      webhook_secret: "copied",
    });
    expect(m.held).toEqual(["app.pem"]);
    // The legacy dir still holds the complete, original set ...
    expect(readFileSync(join(legacy(), "app.pem"), "utf8")).toBe("RUNNING-PEM\n");
    expect(readFileSync(join(legacy(), "app_id"), "utf8")).toBe("123\n");
    expect(readFileSync(join(legacy(), "webhook_secret"), "utf8")).toBe("s\n");
    // ... the home gains copies with their modes, and keeps its own PEM.
    expect(readFileSync(join(secretsHome(env), "app.pem"), "utf8")).toBe("OTHER-PEM\n");
    expect(mode(join(secretsHome(env), "app_id"))).toBe(0o600);
    expect(mode(join(secretsHome(env), "webhook_secret"))).toBe(0o640);
    const report = secretsMigrateReport(m);
    expect(report.code).toBe(1);
    expect(report.lines.join("\n")).toMatch(/compose stack that mounts/);
    expect(report.lines.join("\n")).not.toMatch(/nothing reads them there/);

    // Idempotent: the re-run changes nothing on either side.
    const again = migrateSecrets({ env });
    if (again.kind !== "done") throw new Error(again.kind);
    expect(again.files.map((f) => f.outcome)).toEqual(["conflict", "skipped", "skipped"]);
    expect(readdirSync(legacy()).sort()).toEqual(["app.pem", "app_id", "webhook_secret"]);
  });

  it("a dir kept whole never copies through a dangling link in the home", () => {
    put600("app.pem", "RUNNING-PEM\n");
    put600("app_id", "123\n");
    mkdirSync(secretsHome(env), { recursive: true });
    writeFileSync(join(secretsHome(env), "app.pem"), "OTHER-PEM\n");
    symlinkSync(join(dir, "nowhere"), join(secretsHome(env), "app_id"));
    const m = migrateSecrets({ env });
    if (m.kind !== "done") throw new Error(m.kind);
    expect(m.files.find((f) => f.name === "app_id")).toMatchObject({ outcome: "skipped" });
    expect(existsSync(join(dir, "nowhere"))).toBe(false);
    expect(readFileSync(join(legacy(), "app_id"), "utf8")).toBe("123\n");
  });

  it("a dir kept whole gets back what an earlier run moved out, never over a file", () => {
    // The state an earlier migrate left: the conflicting PEM behind, the rest moved.
    put600("app.pem", "RUNNING-PEM\n");
    mkdirSync(secretsHome(env), { recursive: true });
    writeFileSync(join(secretsHome(env), "app.pem"), "OTHER-PEM\n");
    writeFileSync(join(secretsHome(env), "app_id"), "123\n", { mode: 0o600 });
    writeFileSync(join(secretsHome(env), "webhook_secret"), "s\n", { mode: 0o600 });
    const m = migrateSecrets({ env });
    if (m.kind !== "done") throw new Error(m.kind);
    expect(m.files.filter((f) => f.outcome === "restored").map((f) => f.name)).toEqual([
      "app_id",
      "webhook_secret",
    ]);
    expect(readFileSync(join(legacy(), "app.pem"), "utf8")).toBe("RUNNING-PEM\n");
    expect(readFileSync(join(legacy(), "app_id"), "utf8")).toBe("123\n");
    expect(mode(join(legacy(), "webhook_secret"))).toBe(0o600);
    expect(secretsMigrateReport(m).lines.join("\n")).toMatch(/back to/);
    // Nothing is restored twice.
    const again = migrateSecrets({ env });
    if (again.kind !== "done") throw new Error(again.kind);
    expect(again.files.some((f) => f.outcome === "restored")).toBe(false);
  });

  it("a non-file the home lacks keeps the dir whole too; one the home has does not", () => {
    put600("app_id", "123\n");
    mkdirSync(join(legacy(), "extra"));
    const m = migrateSecrets({ env });
    if (m.kind !== "done") throw new Error(m.kind);
    expect(m.held).toEqual(["extra"]);
    expect(m.files.find((f) => f.name === "app_id")?.outcome).toBe("copied");
    expect(existsSync(join(legacy(), "app_id"))).toBe(true);

    mkdirSync(join(secretsHome(env), "extra"));
    const next = migrateSecrets({ env });
    if (next.kind !== "done") throw new Error(next.kind);
    expect(next.held).toEqual([]);
    expect(next.files.find((f) => f.name === "app_id")?.outcome).toBe("deduplicated");
    expect(existsSync(join(legacy(), "app_id"))).toBe(false);
  });

  it("leaves a pinned key file, and a symlinked legacy dir, alone", () => {
    put600("openviking-keys.env", "K=1\n");
    const m = migrateSecrets({ env: { ...env, QCR_OPENVIKING_KEYS: "/pinned.env" } });
    if (m.kind !== "done") throw new Error(m.kind);
    expect(m.files[0]).toMatchObject({ name: "openviking-keys.env", outcome: "skipped" });
    expect(existsSync(join(legacy(), "openviking-keys.env"))).toBe(true);

    rmSync(legacy(), { recursive: true });
    const target = join(dir, "real-secrets");
    mkdirSync(target);
    writeFileSync(join(target, "app_id"), "1\n");
    symlinkSync(target, legacy());
    expect(migrateSecrets({ env }).kind).toBe("symlink");
    expect(lstatSync(legacy()).isSymbolicLink()).toBe(true);
    expect(existsSync(join(target, "app_id"))).toBe(true);
  });

  it("a secrets home that is a link to the legacy dir never deletes a credential (selfscan)", () => {
    put600("app.pem", "PEM\n");
    put600("webhook_secret", "s\n");
    mkdirSync(dirname(secretsHome(env)), { recursive: true });
    symlinkSync(legacy(), secretsHome(env));
    const m = migrateSecrets({ env });
    if (m.kind !== "done") throw new Error(m.kind);
    expect(m.files.map((f) => f.outcome)).toEqual(["skipped", "skipped"]);
    expect(readFileSync(join(secretsHome(env), "app.pem"), "utf8")).toBe("PEM\n");
    expect(readFileSync(join(legacy(), "webhook_secret"), "utf8")).toBe("s\n");
    expect(secretsMigrateReport(m).lines.join("\n")).toMatch(/same file/);
  });

  it("`qcr install migrate` moves config and secrets; `where` names both", async () => {
    const { cmdInstall } = await import("../src/cli.js");
    put(join(root, "config.toml"), "x = 1\n");
    put600("app.pem", "PEM\n");
    const out: string[] = [];
    const log = (l: string) => out.push(l);
    expect(cmdInstall(["migrate"], { root, env, log })).toBe(0);
    expect(mode(join(secretsHome(env), "app.pem"))).toBe(0o600);
    expect(out.join("\n")).toContain("secrets: moved app.pem");
    expect(out.join("\n")).not.toContain("PEM");
    out.length = 0;
    expect(cmdInstall(["where"], { root, env, log })).toBe(0);
    expect(out.join("\n")).toContain(`secrets     ${secretsHome(env)}  (home`);
    expect(out.join("\n")).toContain(join(operatorHome(env), "openviking-keys.env"));
  });
});

describe("migrate repoints the compose .env", () => {
  const legacy = (): string => legacySecretsDir(env);
  it("a QCR_SECRETS_DIR naming the legacy dir follows the move; nothing else changes", async () => {
    const { cmdInstall } = await import("../src/cli.js");
    mkdirSync(legacy(), { recursive: true });
    writeFileSync(join(legacy(), "app.pem"), "PEM\n", { mode: 0o600 });
    const envFile = join(root, ".env");
    mkdirSync(root, { recursive: true });
    writeFileSync(
      envFile,
      `COMPOSE_PROFILES=tunnel\nQCR_SECRETS_DIR=${legacy()}\nQCR_CONFIG_NAME=config.toml\n`,
      {
        mode: 0o600,
      },
    );
    const out: string[] = [];
    expect(cmdInstall(["migrate"], { root, env, log: (l) => out.push(l) })).toBe(0);
    expect(readFileSync(envFile, "utf8")).toBe(
      `COMPOSE_PROFILES=tunnel\nQCR_SECRETS_DIR=${secretsHome(env)}\nQCR_CONFIG_NAME=config.toml\n`,
    );
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
    expect(out.join("\n")).toMatch(/docker compose up -d/);
  });

  it("the ~ spelling is repointed too; a dir the operator chose is never touched", () => {
    mkdirSync(secretsHome(env), { recursive: true });
    const envFile = join(root, ".env");
    mkdirSync(root, { recursive: true });
    writeFileSync(envFile, "QCR_SECRETS_DIR=~/.config/quickreview-bot\n");
    expect(repointComposeSecrets({ root, env }).kind).toBe("repointed");
    expect(readFileSync(envFile, "utf8")).toBe(`QCR_SECRETS_DIR=${secretsHome(env)}\n`);
    writeFileSync(envFile, "QCR_SECRETS_DIR=/srv/my-secrets\n");
    expect(repointComposeSecrets({ root, env }).kind).toBe("none");
    expect(readFileSync(envFile, "utf8")).toBe("QCR_SECRETS_DIR=/srv/my-secrets\n");
  });

  it("leaves a working mount alone when the legacy dir still holds what the home lacks (selfscan)", async () => {
    const { cmdInstall } = await import("../src/cli.js");
    // A symlinked legacy dir: migrate moves nothing; the home exists but is empty.
    const target = join(dir, "real-secrets");
    mkdirSync(target);
    writeFileSync(join(target, "app.pem"), "PEM\n");
    mkdirSync(dirname(legacy()), { recursive: true });
    symlinkSync(target, legacy());
    mkdirSync(secretsHome(env), { recursive: true });
    const envFile = join(root, ".env");
    writeFileSync(envFile, `QCR_SECRETS_DIR=${legacy()}\n`);
    const out: string[] = [];
    cmdInstall(["migrate"], { root, env, log: (l) => out.push(l) });
    expect(readFileSync(envFile, "utf8")).toBe(`QCR_SECRETS_DIR=${legacy()}\n`);
    expect(repointComposeSecrets({ root, env })).toMatchObject({
      kind: "held",
      missing: ["app.pem"],
    });
    expect(out.join("\n")).toMatch(/app\.pem/);
    expect(out.join("\n")).not.toMatch(/docker compose up -d/);
  });

  it("holds the mount when migrate refused a conflict: the home's differing copy is not the working one (selfscan)", async () => {
    const { cmdInstall } = await import("../src/cli.js");
    mkdirSync(legacy(), { recursive: true });
    writeFileSync(join(legacy(), "app.pem"), "RUNNING-PEM\n", { mode: 0o600 });
    mkdirSync(secretsHome(env), { recursive: true });
    writeFileSync(join(secretsHome(env), "app.pem"), "OTHER-PEM\n", { mode: 0o600 });
    const envFile = join(root, ".env");
    mkdirSync(root, { recursive: true });
    writeFileSync(envFile, `QCR_SECRETS_DIR=${legacy()}\n`);
    const out: string[] = [];
    expect(cmdInstall(["migrate"], { root, env, log: (l) => out.push(l) })).toBe(1);
    expect(out.join("\n")).toMatch(/both exist and differ/);
    expect(readFileSync(envFile, "utf8")).toBe(`QCR_SECRETS_DIR=${legacy()}\n`);
    expect(repointComposeSecrets({ root, env })).toMatchObject({
      kind: "held",
      missing: [],
      differ: ["app.pem"],
    });
    expect(out.join("\n")).not.toMatch(/docker compose up -d/);
    expect(out.join("\n")).toMatch(/app\.pem/);
  });

  it("a partly conflicting migrate leaves the mount it holds complete, and converges once settled", async () => {
    const { cmdInstall } = await import("../src/cli.js");
    mkdirSync(legacy(), { recursive: true });
    for (const [name, text] of [
      ["app.pem", "RUNNING-PEM\n"],
      ["app_id", "123\n"],
      ["webhook_secret", "s\n"],
    ] as const)
      writeFileSync(join(legacy(), name), text, { mode: 0o600 });
    mkdirSync(secretsHome(env), { recursive: true });
    writeFileSync(join(secretsHome(env), "app.pem"), "OTHER-PEM\n", { mode: 0o600 });
    const envFile = join(root, ".env");
    mkdirSync(root, { recursive: true });
    writeFileSync(envFile, `QCR_SECRETS_DIR=${legacy()}\n`);
    for (let run = 0; run < 2; run++) {
      const out: string[] = [];
      expect(cmdInstall(["migrate"], { root, env, log: (l) => out.push(l) })).toBe(1);
      // The mount is held on the legacy dir — and it still holds every credential.
      expect(readFileSync(envFile, "utf8")).toBe(`QCR_SECRETS_DIR=${legacy()}\n`);
      expect(readdirSync(legacy()).sort()).toEqual(["app.pem", "app_id", "webhook_secret"]);
      expect(readFileSync(join(legacy(), "app.pem"), "utf8")).toBe("RUNNING-PEM\n");
      expect(out.join("\n")).not.toMatch(/docker compose up -d/);
    }
    // The operator keeps the running PEM: the re-run moves it all and re-points.
    rmSync(join(secretsHome(env), "app.pem"));
    const out: string[] = [];
    expect(cmdInstall(["migrate"], { root, env, log: (l) => out.push(l) })).toBe(0);
    expect(existsSync(legacy())).toBe(false);
    expect(readdirSync(secretsHome(env)).sort()).toEqual(["app.pem", "app_id", "webhook_secret"]);
    expect(readFileSync(join(secretsHome(env), "app.pem"), "utf8")).toBe("RUNNING-PEM\n");
    expect(readFileSync(envFile, "utf8")).toBe(`QCR_SECRETS_DIR=${secretsHome(env)}\n`);
  });

  it("leaves the line while the home does not exist yet (nothing was moved)", () => {
    const envFile = join(root, ".env");
    mkdirSync(root, { recursive: true });
    writeFileSync(envFile, `QCR_SECRETS_DIR=${legacy()}\n`);
    expect(repointComposeSecrets({ root, env }).kind).toBe("none");
  });
});

describe("nothing but migrate (and a not-found's hint) touches the old places", () => {
  // No fallback reads remain: the locator's old-place
  // helpers are called from exactly the modules that move or name what is
  // stranded — the locator itself (install.ts, homes.ts, and the core's
  // homes.ts it wraps), `qcr install`
  // (cli.ts), the loaders' not-found (config.ts, profiles.ts, homes.ts's
  // one-shot loader) and the companion column's missing-keys note — never
  // from a reader deciding where to read.
  const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
  const OLD_PLACE =
    /\b(legacySecretsDir|strandedLegacySecrets|strandedCheckoutConfig|strandedCheckoutProfiles?|migrate(Config|Profiles|Secrets)|repointComposeSecrets)\(/;
  const ALLOWED = new Set([
    "src/install.ts",
    "src/homes.ts",
    `${CORE_PACKAGE}/src/homes.ts`,
    "src/cli.ts",
    "src/config.ts",
    `${CORE_PACKAGE}/src/profiles.ts`,
    "src/tui/companion.ts",
  ]);
  it("src/ and extensions/ (the app's and the core's) call the old-place helpers only where they move or name a strand", () => {
    const offenders: string[] = [];
    const walk = (rel: string): void => {
      for (const entry of readdirSync(join(repo, rel), { withFileTypes: true })) {
        const path = `${rel}/${entry.name}`;
        if (entry.isDirectory()) {
          if (entry.name !== "vendor") walk(path);
        } else if (/\.(ts|mjs)$/.test(entry.name) && !ALLOWED.has(path)) {
          readFileSync(join(repo, path), "utf8")
            .split("\n")
            .forEach((line, i) => {
              if (OLD_PLACE.test(line)) offenders.push(`${path}:${i + 1}: ${line.trim()}`);
            });
        }
      }
    };
    for (const top of [...SRC_DIRS, ...EXTENSION_DIRS]) walk(top);
    expect(offenders).toEqual([]);
  });

  it("the locator's answers carry no old-place source any more", () => {
    // A type-level fact checked at runtime too: every source the locator can
    // return, over a machine where every old place is populated.
    put(join(root, "config.toml"));
    mkdirSync(join(root, "profiles", "house"), { recursive: true });
    mkdirSync(legacySecretsDir(env), { recursive: true });
    writeFileSync(join(legacySecretsDir(env), "openviking-keys.env"), "K=1\n");
    expect(locateConfig({ env }).source).toBe("home");
    expect(locateProfile({ root, profile: "house", env })).toBeNull();
    expect(locateSecrets({ env }).source).toBe("home");
    expect(locateKeysFile({ env }).source).toBe("home");
  });
});

describe("no reader builds the legacy secrets path itself", () => {
  // Every secrets reader resolves through the locator. Only the locator's
  // migrate half and its spelling check (the core's homes.ts, which
  // src/homes.ts wraps) and the shell mirror's spelling check name the legacy dir.
  const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
  const ALLOWED = new Set([
    "src/install.ts",
    "src/homes.ts",
    `${CORE_PACKAGE}/src/homes.ts`,
    "scripts/install-locator.sh",
  ]);
  const SPELLS = /quickreview-bot/;

  function* files(rel: string): Generator<string> {
    for (const entry of readdirSync(join(repo, rel), { withFileTypes: true })) {
      const path = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== "vendor" && entry.name !== "node_modules") yield* files(path);
      } else if (/\.(ts|mjs|sh|j2)$/.test(entry.name)) yield path;
    }
  }

  it("src/, extensions/ (the app's and the core's), scripts/, deploy/ and docker/ name it only in comments and prose", () => {
    const offenders: string[] = [];
    for (const top of [...SRC_DIRS, ...EXTENSION_DIRS, "scripts", "deploy", "docker"]) {
      for (const rel of files(top)) {
        if (ALLOWED.has(rel)) continue;
        readFileSync(join(repo, rel), "utf8")
          .split("\n")
          .forEach((line, i) => {
            const code = line.trim();
            if (/^(\/\/|\*|\/\*|#)/.test(code)) return; // a comment
            // Prose that names it AS the legacy dir is a pointer, not a read.
            if (SPELLS.test(code) && !/legacy/i.test(code))
              offenders.push(`${rel}:${i + 1}: ${code}`);
          });
      }
    }
    expect(offenders).toEqual([]);
  });
});

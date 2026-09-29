// the install locator (spec seam 1): temp XDG homes and QCR_CONFIG
// in, every config path out. Never the operator's own homes: every case hands
// the locator an explicit env.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
      expect(() => load()).toThrow(new RegExp(`no config at ${join(configHome(env), "config.toml")}`));
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
    expect(loadConfig(locateConfig({ env }).path).github.repo).toBe(
      loadConfig(p).github.repo,
    );
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
    expect(migrateConfig({ root, env: home })).toEqual({ kind: "already", to: cfg });
    expect(readFileSync(cfg, "utf8")).toBe("live = 1\n");
    expect(migrateProfiles({ root, env: home })).toEqual([]);
    expect(readFileSync(prof, "utf8")).toBe("p = 1\n");
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
    // deploy.sh sync|rebuild ships the config home from there.
    expect(moved.lines.join("\n")).toMatch(/deploy\.sh[\s\S]*/);
    expect(migrateReport({ kind: "already", to }).code).toBe(0);
    expect(migrateReport({ kind: "deduplicated", from, to }).code).toBe(0);
    expect(migrateReport({ kind: "nothing", to }).code).toBe(0);
    expect(migrateReport({ kind: "override", path: "/x.toml" }).code).toBe(0);
    const conflict = migrateReport({ kind: "conflict", from, to });
    expect(conflict.code).toBe(1);
    expect(conflict.lines.join("\n")).toMatch(/differ/);
  });

  it("the CLI's migrate moves the checkout config and is idempotent", async () => {
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
  });

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
  // acceptance: every reader of the live config goes through the
  // locator. The one allowed spelling COMPARES a located path against the
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

  it("src/, extensions/ and deploy/ name config.toml only through the locator", () => {
    const offenders: string[] = [];
    for (const top of ["src", "extensions", "deploy"]) {
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

// ---- repo profiles --------------------------------------------------

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
    // an install's own profile left in the checkout is never read.
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
    expect(moved.lines.join("\n")).toMatch(/deploy\.sh[\s\S]*/);
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

  it("every other directory there is a stranded install pack BOTH snapshots exclude", () => {
    // a pack left there (the deployment's own, until `qcr install
    // migrate` moves it) is never read, and whatever it is called it must
    // never ship — publicly or internally.
    const dirs = readdirSync(join(repo, "profiles"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    for (const manifest of ["publish-manifest.json", "publish-manifest.internal.json"]) {
      const excluded = (
        JSON.parse(readFileSync(join(repo, manifest), "utf8")) as { exclude: { path: string }[] }
      ).exclude.map((e) => e.path);
      for (const name of dirs) {
        if (EXAMPLE_PROFILES.includes(name)) continue;
        expect(excluded, `${manifest}: ${name}`).toContain(`profiles/${name}/`);
      }
    }
    for (const example of EXAMPLE_PROFILES) expect(dirs).toContain(example);
  });

  it("no TypeScript module but the locator builds a profiles/ path", () => {
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
    for (const top of ["src", "extensions"]) walk(top);
    expect(offenders).toEqual([]);
  });
});

// ----: secrets under the install's config home ----------------------

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
      // the old spelling, with the old dir populated, still reads the home.
      expect(parseConfig(withDir("~/.config/quickreview-bot")).github.secrets_dir).toBe(
        secretsHome(env),
      );
      secret(secretsHome(env));
      expect(parseConfig(withDir("~/.config/quickreview-bot")).github.secrets_dir).toBe(
        secretsHome(env),
      );
      expect(parseConfig(withDir("/elsewhere")).github.secrets_dir).toBe("/elsewhere");
      // An absent key is the same as an empty one.
      expect(
        parseConfig(fixture.replace(/^secrets_dir = .*$/m, "")).github.secrets_dir,
      ).toBe(secretsHome(env));
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

    put600("app_id", "123\n"); // same bytes → the legacy copy goes
    put600("webhook_secret", "s3cret-old\n");
    mkdirSync(secretsHome(env), { recursive: true });
    writeFileSync(join(secretsHome(env), "webhook_secret"), "s3cret-new\n");
    const m = migrateSecrets({ env });
    if (m.kind !== "done") throw new Error(m.kind);
    expect(Object.fromEntries(m.files.map((f) => [f.name, f.outcome]))).toEqual({
      app_id: "deduplicated",
      webhook_secret: "conflict",
    });
    expect(readFileSync(join(secretsHome(env), "webhook_secret"), "utf8")).toBe("s3cret-new\n");
    expect(readFileSync(join(legacy(), "webhook_secret"), "utf8")).toBe("s3cret-old\n");
    expect(m.remaining).toEqual(["webhook_secret"]);
    const report = secretsMigrateReport(m);
    expect(report.code).toBe(1);
    expect(report.lines.join("\n")).toMatch(/differ/);
    // Names only — never a value.
    expect(report.lines.join("\n")).not.toContain("s3cret");
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

describe("migrate repoints the compose .env (review)", () => {
  const legacy = (): string => legacySecretsDir(env);
  it("a QCR_SECRETS_DIR naming the legacy dir follows the move; nothing else changes", async () => {
    const { cmdInstall } = await import("../src/cli.js");
    mkdirSync(legacy(), { recursive: true });
    writeFileSync(join(legacy(), "app.pem"), "PEM\n", { mode: 0o600 });
    const envFile = join(root, ".env");
    mkdirSync(root, { recursive: true });
    writeFileSync(envFile, `COMPOSE_PROFILES=tunnel\nQCR_SECRETS_DIR=${legacy()}\nQCR_CONFIG_NAME=config.toml\n`, {
      mode: 0o600,
    });
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

  it("leaves the line while the home does not exist yet (nothing was moved)", () => {
    const envFile = join(root, ".env");
    mkdirSync(root, { recursive: true });
    writeFileSync(envFile, `QCR_SECRETS_DIR=${legacy()}\n`);
    expect(repointComposeSecrets({ root, env }).kind).toBe("none");
  });
});

describe("nothing but migrate (and a not-found's hint) touches the old places", () => {
  // Acceptance "no fallback reads remain (grep-clean)": the locator's old-place
  // helpers are called from exactly the modules that MOVE or NAME what is
  // stranded — `qcr install` (cli.ts), the loaders' not-found (config.ts,
  // profiles.ts) and the companion column's missing-keys note — never from a
  // reader deciding where to read.
  const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
  const OLD_PLACE = /\b(legacySecretsDir|strandedLegacySecrets|strandedCheckoutConfig|strandedCheckoutProfiles?|migrate(Config|Profiles|Secrets)|repointComposeSecrets)\(/;
  const ALLOWED = new Set([
    "src/install.ts",
    "src/cli.ts",
    "src/config.ts",
    "src/profiles.ts",
    "src/tui/companion.ts",
  ]);
  it("src/ and extensions/ call the old-place helpers only where they move or name a strand", () => {
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
    for (const top of ["src", "extensions"]) walk(top);
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
  // acceptance: every secrets reader resolves through the locator.
  // contracted the rest: only the locator's migrate half (and its
  // spelling check) and the shell mirror's spelling check name the old dir —
  // the entrypoints' compatibility link and the forward's fallback are gone.
  const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
  const ALLOWED = new Set(["src/install.ts", "scripts/install-locator.sh"]);
  const SPELLS = /quickreview-bot/;

  function* files(rel: string): Generator<string> {
    for (const entry of readdirSync(join(repo, rel), { withFileTypes: true })) {
      const path = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== "vendor" && entry.name !== "node_modules") yield* files(path);
      } else if (/\.(ts|mjs|sh|j2)$/.test(entry.name)) yield path;
    }
  }

  it("src/, extensions/, scripts/, deploy/ and docker/ name it only in comments and prose", () => {
    const offenders: string[] = [];
    for (const top of ["src", "extensions", "scripts", "deploy", "docker"]) {
      for (const rel of files(top)) {
        if (ALLOWED.has(rel)) continue;
        readFileSync(join(repo, rel), "utf8")
          .split("\n")
          .forEach((line, i) => {
            const code = line.trim();
            if (/^(\/\/|\*|\/\*|#)/.test(code)) return; // a comment
            // Prose that names it AS the legacy dir is a pointer, not a read.
            if (SPELLS.test(code) && !/legacy/i.test(code)) offenders.push(`${rel}:${i + 1}: ${code}`);
          });
      }
    }
    expect(offenders).toEqual([]);
  });
});

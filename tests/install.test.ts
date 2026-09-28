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
  repointComposeSecrets,
  resolveConfigPath,
  resolveProfile,
  resolveSecretsDir,
  secretsHome,
  secretsMigrateReport,
  stateHome,
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
    expect(locateConfig({ root, env: { ...env, QCR_CONFIG: target } })).toMatchObject({
      path: target,
      source: "override",
    });
  });

  it("the config home beats the checkout", () => {
    const home = put(join(configHome(env), "config.toml"));
    put(join(root, "config.toml"));
    expect(locateConfig({ root, env })).toEqual({
      path: home,
      source: "home",
      home: configHome(env),
    });
  });

  it("the checkout's config.toml is the legacy fallback when the home has none", () => {
    const legacy = put(join(root, "config.toml"));
    expect(locateConfig({ root, env })).toMatchObject({ path: legacy, source: "checkout" });
  });

  it("with nothing anywhere, the answer is the home — where a new config belongs", () => {
    expect(locateConfig({ root, env })).toMatchObject({
      path: join(configHome(env), "config.toml"),
      source: "home",
    });
  });

  it("logs the checkout fallback once per path, and never the home or the override", () => {
    const lines: string[] = [];
    const log = (l: string) => lines.push(l);
    resolveConfigPath({ root, env, log }); // nothing yet → home, silent
    put(join(root, "config.toml"));
    resolveConfigPath({ root, env, log });
    resolveConfigPath({ root, env, log });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/LEGACY checkout config/);
    expect(lines[0]).toContain("qcr install migrate");
    expect(lines[0]).toContain(configHome(env));
    resolveConfigPath({ root, env: { ...env, QCR_CONFIG: join(dir, "x.toml") }, log });
    expect(lines).toHaveLength(1);
  });

  it("loadConfig reads the file the locator names (explicit path unchanged)", () => {
    const fixture = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "fixtures", "config.toml"),
      "utf8",
    );
    const p = put(join(configHome(env), "config.toml"), fixture);
    expect(loadConfig(locateConfig({ root, env }).path).github.repo).toBe(
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
    expect(locateConfig({ root, env })).toMatchObject({ path: to, source: "home" });
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

  it("the CLI's where names both homes and the config's source", async () => {
    const { cmdInstall } = await import("../src/cli.js");
    put(join(root, "config.toml"));
    const out: string[] = [];
    expect(cmdInstall(["where"], { root, env, log: (l) => out.push(l) })).toBe(0);
    const text = out.join("\n");
    expect(text).toContain(configHome(env));
    expect(text).toContain(stateHome(env));
    expect(text).toMatch(/checkout/);
    expect(() => cmdInstall(["bogus"], { root, env, log: () => {} })).toThrow(/usage: qcr install/);
  });
});

describe("no TypeScript reader builds the checkout config path itself", () => {
  // acceptance: every reader of the live config goes through the
  // locator. The two allowed spellings COMPARE a located path against the
  // checkout's (to decide where a proposal applies / what compose mounts) —
  // neither reads it. The shell half is swept in tests/install-shell.test.ts.
  const ALLOWED = new Set(["src/onboard/steps/bringup.ts", "src/tui/proposals.ts"]);
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
  it("the config home first, then profiles/ beside QCR_CONFIG, then the checkout", () => {
    const inCheckout = putProfile(root, "house");
    expect(locateProfile({ root, profile: "house", env })).toEqual({
      name: "house",
      dir: inCheckout,
      source: "checkout",
    });
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
    put(join(configHome(env), "profiles", "house"));
    const inCheckout = putProfile(root, "house");
    expect(locateProfile({ root, profile: "house", env })?.dir).toBe(inCheckout);
  });

  it("refuses a profile name that could escape profiles/", () => {
    putProfile(dir, "escape");
    for (const bad of ["..", "../escape", "a/b", ".hidden", "/etc", "x/../../escape"]) {
      expect(() => locateProfile({ root, profile: bad, env }), bad).toThrow(
        /profile .* not a plain name/,
      );
    }
  });

  it("announces a legacy checkout profile once, never an example or a home profile", () => {
    const out: string[] = [];
    const log = (l: string) => out.push(l);
    putProfile(root, "house");
    putProfile(root, "minimal");
    resolveProfile({ root, profile: "house", env, log });
    resolveProfile({ root, profile: "house", env, log });
    resolveProfile({ root, profile: "minimal", env, log });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/LEGACY checkout profile .*house/);
    putProfile(configHome(env), "homed");
    resolveProfile({ root, profile: "homed", env, log });
    expect(out).toHaveLength(1);
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
    // before the move the old path is still what the lookup reads
    expect(locateProfile({ root, profile: "house-pack", env })?.source).toBe("checkout");
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
      `${join(configHome(env), "profiles")} → ${join(root, "profiles")}`,
    );
  });
});

describe("the checkout's profiles/ holds the generic examples", () => {
  const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

  it("every other directory there is a legacy install pack the public snapshot excludes", () => {
    // The one legacy pack (the deployment's own) waits there for `qcr install
    // migrate`; whatever it is called, it must never ship publicly.
    const excluded = (
      JSON.parse(readFileSync(join(repo, "publish-manifest.json"), "utf8")) as {
        exclude: { path: string }[];
      }
    ).exclude.map((e) => e.path);
    const dirs = readdirSync(join(repo, "profiles"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    for (const name of dirs) {
      if (EXAMPLE_PROFILES.includes(name)) continue;
      expect(excluded, name).toContain(`profiles/${name}/`);
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

  it("the legacy dir is the fallback while the home does not exist", () => {
    secret(legacySecretsDir(env));
    expect(locateSecrets({ configured: "~/.config/quickreview-bot", env })).toMatchObject({
      path: legacySecretsDir(env),
      source: "legacy",
    });
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

  it("logs the legacy fallback once per path, and never the home", () => {
    const lines: string[] = [];
    const log = (l: string) => lines.push(l);
    resolveSecretsDir({ env, log });
    secret(legacySecretsDir(env));
    resolveSecretsDir({ env, log });
    resolveSecretsDir({ env, log });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/LEGACY dir/);
    expect(lines[0]).toContain("qcr install migrate");
    expect(lines[0]).toContain(secretsHome(env));
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
      expect(parseConfig(withDir("~/.config/quickreview-bot")).github.secrets_dir).toBe(
        legacySecretsDir(env),
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

  it("QCR_OPENVIKING_KEYS wins; the legacy file is the fallback until the home has one", () => {
    const legacy = keys(join(legacySecretsDir(env), "openviking-keys.env"));
    expect(locateKeysFile({ env })).toMatchObject({ path: legacy, source: "legacy" });
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

describe("no reader builds the legacy secrets path itself", () => {
  // acceptance: every secrets reader resolves through the locator.
  // Only the locator (both halves), the forward's documented mirror of it, and
  // the entrypoints' in-container compatibility link spell the legacy dir.
  const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
  const ALLOWED = new Set([
    "src/install.ts",
    "scripts/install-locator.sh",
    "scripts/companion-memory-forward.mjs",
    "docker/daemon/entrypoint.sh",
    "deploy/ansible/templates/entrypoint.sh.j2",
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

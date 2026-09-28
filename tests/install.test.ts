// the install locator (spec seam 1): temp XDG homes and QCR_CONFIG
// in, every config path out. Never the operator's own homes: every case hands
// the locator an explicit env.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertPathSegment,
  configHome,
  installName,
  locateConfig,
  migrateConfig,
  resolveConfigPath,
  stateHome,
  type InstallEnv,
} from "../src/install.js";
import { loadConfig } from "../src/config.js";

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

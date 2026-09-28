// the install locator's shell mirror (`scripts/install-locator.sh`)
// against the reference (`src/install.ts`), case for case: the posting route,
// mint-token and deploy.sh read their config through the shell copy, so a
// drift between the two would have the scripts and the daemon read different
// files. The real shell function, sourced into a real bash, temp homes only.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configHome, locateConfig, stateHome, type InstallEnv } from "../src/install.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const locatorSh = join(repo, "scripts", "install-locator.sh");

let dir: string;
let root: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-install-sh-"));
  root = join(dir, "checkout");
  mkdirSync(root);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function shell(env: InstallEnv): { code: number; lines: string[]; stderr: string } {
  const r = spawnSync(
    "bash",
    [
      "-c",
      '. "$1"; set -e; qcr_locate_config "$2"; qcr_config_home; qcr_state_home',
      "locator",
      locatorSh,
      root,
    ],
    {
      encoding: "utf8",
      cwd: dir,
      // ONLY the locator's inputs (plus PATH): nothing from the runner's shell.
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env } as NodeJS.ProcessEnv,
    },
  );
  return { code: r.status ?? -1, lines: r.stdout.trim().split("\n"), stderr: r.stderr };
}

function reference(env: InstallEnv): string[] {
  return [locateConfig({ root, env }).path, configHome(env), stateHome(env)];
}

const put = (path: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "dry_run = true\n");
};

describe("install-locator.sh ≡ src/install.ts", () => {
  const cases: Array<[string, () => InstallEnv]> = [
    [
      "nothing anywhere → the config home",
      () => ({
        HOME: join(dir, "home"),
        XDG_CONFIG_HOME: join(dir, "xdg-config"),
        XDG_STATE_HOME: join(dir, "xdg-state"),
      }),
    ],
    [
      "checkout only → the legacy fallback",
      () => {
        put(join(root, "config.toml"));
        return { HOME: join(dir, "home"), XDG_CONFIG_HOME: join(dir, "xdg-config") };
      },
    ],
    [
      "home and checkout → the home",
      () => {
        put(join(root, "config.toml"));
        put(join(dir, "xdg-config", "qcr", "default", "config.toml"));
        return { HOME: join(dir, "home"), XDG_CONFIG_HOME: join(dir, "xdg-config") };
      },
    ],
    [
      "QCR_CONFIG → taken as given, even over a populated home",
      () => {
        put(join(dir, "xdg-config", "qcr", "default", "config.toml"));
        return {
          HOME: join(dir, "home"),
          XDG_CONFIG_HOME: join(dir, "xdg-config"),
          QCR_CONFIG: join(dir, "mine.toml"),
        };
      },
    ],
    [
      "a named install",
      () => {
        put(join(dir, "xdg-config", "qcr", "second", "config.toml"));
        return {
          HOME: join(dir, "home"),
          XDG_CONFIG_HOME: join(dir, "xdg-config"),
          QCR_INSTALL: "second",
        };
      },
    ],
    [
      "XDG unset → $HOME/.config and $HOME/.local/state",
      () => {
        put(join(dir, "home", ".config", "qcr", "default", "config.toml"));
        return { HOME: join(dir, "home") };
      },
    ],
    [
      "a RELATIVE XDG value is ignored (the XDG spec)",
      () => ({
        HOME: join(dir, "home"),
        XDG_CONFIG_HOME: "relative/cfg",
        XDG_STATE_HOME: "relative/state",
      }),
    ],
  ];

  for (const [name, arrange] of cases) {
    it(name, () => {
      const env = arrange();
      const sh = shell(env);
      expect(sh.code, sh.stderr).toBe(0);
      expect(sh.lines).toEqual(reference(env));
    });
  }

  it("both refuse an install name that could escape the qcr dir", () => {
    for (const bad of ["..", "../x", "a/b", ".hidden"]) {
      const env = { HOME: join(dir, "home"), QCR_INSTALL: bad };
      expect(() => reference(env)).toThrow(/not a plain name/);
      const sh = shell(env);
      expect(sh.code).not.toBe(0);
      expect(sh.stderr).toMatch(/not a plain name/);
    }
  });

  it("the legacy fallback is silent to a machine caller (stderr not a terminal)", () => {
    put(join(root, "config.toml"));
    const sh = shell({ HOME: join(dir, "home"), XDG_CONFIG_HOME: join(dir, "xdg-config") });
    expect(sh.lines[0]).toBe(join(root, "config.toml"));
    expect(sh.stderr).toBe("");
  });
});

describe("every script that reads the live config reads it through the locator", () => {
  // No reader builds the checkout path itself (acceptance): the old
  // `${QCR_CONFIG:-$ROOT/config.toml}` spelling is gone from every script, and
  // each one that reads a config sources the shell locator.
  const readers = [
    "approve-pr.sh",
    "deploy.sh",
    "mint-token.sh",
    "post-review.sh",
    "pr-checks.sh",
    "pr-context.sh",
    "pr-self.sh",
    "pr-threads.sh",
    "reply-thread.sh",
    "operator-box-setup.sh",
  ];
  for (const script of readers) {
    it(script, () => {
      const text = readFileSync(join(repo, "scripts", script), "utf8");
      expect(text).toContain("install-locator.sh");
      expect(text).toContain("qcr_locate_config");
      expect(text).not.toMatch(/QCR_CONFIG:-[^}]*config\.toml/);
    });
  }
});

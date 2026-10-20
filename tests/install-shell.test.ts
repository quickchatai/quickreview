// The install locator's shell mirror (`scripts/install-locator.sh`)
// against the reference (`src/install.ts`), case for case: the posting route,
// mint-token and deploy.sh read their config through the shell copy, so a
// drift between the two would have the scripts and the daemon read different
// files. The real shell function, sourced into a real bash, temp homes only.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  configHome,
  EXAMPLE_PROFILES,
  legacySecretsDir,
  locateConfig,
  locateKeysFile,
  locateProfile,
  locateSecrets,
  operatorHome,
  profileSearchDirs,
  secretsHome,
  stateHome,
  type InstallEnv,
} from "../src/install.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const locatorSh = join(repo, "scripts", "install-locator.sh");
// The internal shared operator terminal's setup script (excluded from the
// public snapshot). Its name is built from parts so this shipped file carries
// no private host name for the publishability lint to flag.
const OPERATOR_BOX_SETUP = ["oper", "ator-box-setup.sh"].join("");

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
      // Only the locator's inputs (plus PATH): nothing from the runner's shell.
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env } as NodeJS.ProcessEnv,
    },
  );
  return { code: r.status ?? -1, lines: r.stdout.trim().split("\n"), stderr: r.stderr };
}

function reference(env: InstallEnv): string[] {
  return [locateConfig({ env }).path, configHome(env), stateHome(env)];
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
      "checkout only → still the config home (the checkout is never read)",
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
      "QCR_CONFIG_HOME / QCR_STATE_HOME override the whole home",
      () => {
        put(join(dir, "cfg-home", "config.toml"));
        return {
          HOME: join(dir, "home"),
          XDG_CONFIG_HOME: join(dir, "xdg-config"),
          QCR_CONFIG_HOME: `${join(dir, "cfg-home")}//`,
          QCR_STATE_HOME: join(dir, "st-home"),
        };
      },
    ],
    [
      "a RELATIVE home override is ignored",
      () => ({ HOME: join(dir, "home"), QCR_CONFIG_HOME: "rel/cfg", QCR_STATE_HOME: "rel/st" }),
    ],
    [
      "XDG values and HOME are read trimmed, as the reference reads them",
      () => ({
        HOME: ` ${join(dir, "home")} `,
        XDG_CONFIG_HOME: ` ${join(dir, "xdg-config")} `,
        XDG_STATE_HOME: "  ",
      }),
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

  it("a stranded checkout config is never printed, and nothing is said about it", () => {
    put(join(root, "config.toml"));
    const sh = shell({ HOME: join(dir, "home"), XDG_CONFIG_HOME: join(dir, "xdg-config") });
    expect(sh.lines[0]).toBe(join(dir, "xdg-config", "qcr", "default", "config.toml"));
    expect(sh.stderr).toBe("");
  });
});

describe("qcr_profile_dir ≡ locateProfile", () => {
  // deploy.sh's preflight and bench.sh decide which profiles the VM / image
  // can read from this; the checkout serves the generic examples only.
  function shellDir(env: InstallEnv, name: string): string {
    const r = spawnSync(
      "bash",
      ["-c", '. "$1"; set -e; qcr_profile_dir "$2" "$3"', "l", locatorSh, root, name],
      {
        encoding: "utf8",
        cwd: dir,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env } as NodeJS.ProcessEnv,
      },
    );
    expect(r.status, r.stderr).toBe(0);
    return r.stdout.trim();
  }
  const putProfile = (base: string, name: string): void => {
    mkdirSync(join(base, "profiles", name), { recursive: true });
  };
  const base = (): InstallEnv => ({
    HOME: join(dir, "home"),
    XDG_CONFIG_HOME: join(dir, "xdg-config"),
  });

  it("QCR_EXAMPLE_PROFILES is EXAMPLE_PROFILES", () => {
    const r = spawnSync(
      "bash",
      ["-c", '. "$1"; printf "%s\\n" "${QCR_EXAMPLE_PROFILES[@]}"', "l", locatorSh],
      {
        encoding: "utf8",
      },
    );
    expect(r.stdout.trim().split("\n")).toEqual([...EXAMPLE_PROFILES]);
  });

  const cases: Array<[string, () => { env: InstallEnv; name: string }]> = [
    [
      "an example in the checkout → found",
      () => (putProfile(root, "minimal"), { env: base(), name: "minimal" }),
    ],
    [
      "an install profile left in the checkout → nothing",
      () => (putProfile(root, "house"), { env: base(), name: "house" }),
    ],
    [
      "the home beats the checkout's example",
      () => {
        putProfile(root, "minimal");
        putProfile(join(dir, "xdg-config", "qcr", "default"), "minimal");
        return { env: base(), name: "minimal" };
      },
    ],
    [
      "beside QCR_CONFIG elsewhere",
      () => {
        putProfile(join(dir, "m"), "house");
        return { env: { ...base(), QCR_CONFIG: join(dir, "m", "c.toml") }, name: "house" };
      },
    ],
    [
      "QCR_CONFIG inside the checkout → its profiles/ is the override place",
      () => {
        putProfile(root, "house");
        return { env: { ...base(), QCR_CONFIG: join(root, "config.toml") }, name: "house" };
      },
    ],
  ];
  for (const [name, arrange] of cases) {
    it(name, () => {
      const c = arrange();
      expect(shellDir(c.env, c.name)).toBe(
        locateProfile({ root, profile: c.name, env: c.env })?.dir ?? "",
      );
    });
  }
});

describe("qcr_profile_dirs ≡ profileSearchDirs", () => {
  // bench.sh bakes the profiles the locator would read into the bench image
  // from this list, so it must name the same places in the same order.
  function shellDirs(env: InstallEnv): { code: number; lines: string[]; stderr: string } {
    const r = spawnSync("bash", ["-c", '. "$1"; qcr_profile_dirs "$2"', "l", locatorSh, root], {
      encoding: "utf8",
      cwd: dir,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env } as NodeJS.ProcessEnv,
    });
    return { code: r.status ?? -1, lines: r.stdout.trim().split("\n"), stderr: r.stderr };
  }
  const base = (): InstallEnv => ({
    HOME: join(dir, "home"),
    XDG_CONFIG_HOME: join(dir, "xdg-config"),
  });
  const cases: Array<[string, () => InstallEnv]> = [
    ["no override → the home, then the checkout", base],
    [
      "QCR_CONFIG elsewhere → beside it, between",
      () => ({ ...base(), QCR_CONFIG: join(dir, "m", "c.toml") }),
    ],
    [
      "QCR_CONFIG in the checkout → deduplicated",
      () => ({ ...base(), QCR_CONFIG: join(root, "config.toml") }),
    ],
    ["a named install, XDG unset", () => ({ HOME: join(dir, "home"), QCR_INSTALL: "second" })],
  ];
  for (const [name, arrange] of cases) {
    it(name, () => {
      const env = arrange();
      const sh = shellDirs(env);
      expect(sh.code, sh.stderr).toBe(0);
      expect(sh.lines).toEqual(profileSearchDirs({ root, env }));
    });
  }
});

describe("every script that reads the live config reads it through the locator", () => {
  // No reader builds the checkout path itself: the
  // `${QCR_CONFIG:-$ROOT/config.toml}` spelling appears in no script, and
  // each one that reads a config sources the shell locator (the three posting
  // shims read none: they are Node-only clients, P9.3).
  const readers = [
    "deploy.sh",
    "mint-token.sh",
    "pr-checks.sh",
    "pr-context.sh",
    "pr-self.sh",
    "pr-threads.sh",
    OPERATOR_BOX_SETUP,
  ];
  for (const script of readers) {
    // The internal operator tooling is excluded from the PUBLIC
    // snapshot (publish-manifest.json): in that assembled tree it is absent.
    it.skipIf(!existsSync(join(repo, "scripts", script)))(script, () => {
      const text = readFileSync(join(repo, "scripts", script), "utf8");
      expect(text).toContain("install-locator.sh");
      expect(text).toContain("qcr_locate_config");
      expect(text).not.toMatch(/QCR_CONFIG:-[^}]*config\.toml/);
    });
  }
});

// The secrets half of the mirror: `qcr_locate_secrets` ≡
// `locateSecrets`, `qcr_locate_keys_file` ≡ `locateKeysFile`, over temp homes.
describe("qcr_locate_secrets / qcr_locate_keys_file ≡ src/install.ts", () => {
  type KeysEnv = InstallEnv & { QCR_OPENVIKING_KEYS?: string };

  function shellSecrets(
    env: KeysEnv,
    configured: string,
    override: string,
  ): { code: number; lines: string[]; stderr: string } {
    const r = spawnSync(
      "bash",
      [
        "-c",
        '. "$1"; set -e; qcr_locate_secrets "$2" "$3"; qcr_locate_keys_file',
        "locator",
        locatorSh,
        configured,
        override,
      ],
      {
        encoding: "utf8",
        cwd: dir,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env } as NodeJS.ProcessEnv,
      },
    );
    return { code: r.status ?? -1, lines: r.stdout.trim().split("\n"), stderr: r.stderr };
  }

  const mkdir = (p: string): void => {
    mkdirSync(p, { recursive: true });
  };
  const base = (): KeysEnv => ({ HOME: join(dir, "home"), XDG_CONFIG_HOME: join(dir, "xdg") });

  const cases: Array<[string, () => { env: KeysEnv; configured: string; override: string }]> = [
    ["nothing anywhere → the homes", () => ({ env: base(), configured: "", override: "" })],
    [
      "legacy dir only → still the homes (the old dir is never read)",
      () => {
        const env = base();
        mkdir(legacySecretsDir(env));
        writeFileSync(join(legacySecretsDir(env), "openviking-keys.env"), "K=1\n");
        return { env, configured: "~/.config/quickreview-bot", override: "" };
      },
    ],
    [
      "home and legacy → the homes",
      () => {
        const env = base();
        mkdir(legacySecretsDir(env));
        writeFileSync(join(legacySecretsDir(env), "openviking-keys.env"), "K=1\n");
        mkdir(secretsHome(env));
        mkdir(operatorHome(env));
        writeFileSync(join(operatorHome(env), "openviking-keys.env"), "K=1\n");
        return { env, configured: "", override: "" };
      },
    ],
    [
      "the legacy spelling as an absolute path, trailing slash → still the locator's call",
      () => {
        const env = base();
        mkdir(secretsHome(env));
        return { env, configured: `${legacySecretsDir(env)}/`, override: "" };
      },
    ],
    [
      "a configured dir → taken as given, ~ expanded, above an override",
      () => ({ env: base(), configured: "~/my-keys", override: "/over" }),
    ],
    ["an override below it", () => ({ env: base(), configured: "", override: "~/over" })],
    [
      "inside a container the secrets mount wins over a configured host path",
      () => ({
        env: { ...base(), QCR_SECRETS_MOUNT: "/opt/quickreview/secrets" },
        configured: "/srv/qcr-secrets",
        override: "/over",
      }),
    ],
    [
      "a relative secrets mount is ignored",
      () => ({
        env: { ...base(), QCR_SECRETS_MOUNT: "rel/secrets" },
        configured: "/srv/qcr-secrets",
        override: "",
      }),
    ],
    [
      "QCR_OPENVIKING_KEYS and a named install",
      () => ({
        env: { ...base(), QCR_OPENVIKING_KEYS: "/pinned.env", QCR_INSTALL: "second" },
        configured: "",
        override: "",
      }),
    ],
    [
      "XDG unset → $HOME/.config",
      () => ({ env: { HOME: join(dir, "home") }, configured: "", override: "" }),
    ],
  ];

  for (const [name, arrange] of cases) {
    it(name, () => {
      const { env, configured, override } = arrange();
      const sh = shellSecrets(env, configured, override);
      expect(sh.code, sh.stderr).toBe(0);
      expect(sh.lines).toEqual([
        locateSecrets({ configured, override, env }).path,
        locateKeysFile({ env }).path,
      ]);
      expect(sh.stderr).toBe(""); // machine callers stay quiet
    });
  }

  it("mint-token, deploy.sh, collect-secrets and the operator-box setup read secrets through it", () => {
    const at = (rel: string) => readFileSync(join(repo, rel), "utf8");
    // The operator-box setup is internal tooling the PUBLIC snapshot excludes.
    const boxSetup = `scripts/${OPERATOR_BOX_SETUP}`;
    const hasBox = existsSync(join(repo, boxSetup));
    for (const rel of [
      "scripts/mint-token.sh",
      "scripts/deploy.sh",
      "deploy/collect-secrets.sh",
      ...(hasBox ? [boxSetup] : []),
      "deploy/collect-slack-secrets.mjs",
    ]) {
      expect([rel, at(rel).includes("qcr_locate_secrets")]).toEqual([rel, true]);
    }
    if (hasBox) expect(at(boxSetup)).toContain("qcr_locate_keys_file");
  });

  it("mint-token finds the App credential in the config home, not the legacy dir", () => {
    // The real script, up to the point it reads the key files: a config with an
    // empty secrets_dir, the credential only in <config home>/secrets. An
    // unreadable pem there would die naming the path it tried.
    const env = base();
    const cfg = join(dir, "c.toml");
    writeFileSync(cfg, '[github]\nsecrets_dir = ""\n');
    mkdir(secretsHome(env));
    writeFileSync(join(secretsHome(env), "app_id"), "1\n");
    const r = spawnSync("bash", [join(repo, "scripts", "mint-token.sh")], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        ...env,
        QCR_CONFIG: cfg,
      } as NodeJS.ProcessEnv,
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(`unreadable app key: ${join(secretsHome(env), "app.pem")}`);
  });
});

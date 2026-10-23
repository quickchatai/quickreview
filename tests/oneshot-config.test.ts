// The one-shot review's config: the review sections parsed by the core
// (src/reviewconfig.ts) exactly as the whole-file parser parses them, and
// zero-config — with no config of the install's own, `qcr review` runs on the
// shipped defaults (config.example.toml) while the daemon still refuses to
// start. Every case hands the locator an explicit env of temp homes.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assetRoot } from "../src/assetroot.js";
import { loadConfig, parseConfig, sandboxRoot } from "../src/config.js";
import { contextFrom } from "../src/engine/context.js";
import {
  homeProfileLookup,
  loadOneShotConfig,
  locateSecrets,
  SHIPPED_CONFIG_FILE,
} from "../src/homes.js";
import { parseCoreConfig } from "../src/reviewconfig.js";

const ROOT = resolve(import.meta.dirname, "..");
const EXAMPLE = readFileSync(join(ROOT, SHIPPED_CONFIG_FILE), "utf8");

let dir: string;
let env: Record<string, string>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-oneshot-config-"));
  env = {
    HOME: dir,
    XDG_CONFIG_HOME: join(dir, "config"),
    XDG_STATE_HOME: join(dir, "state"),
  };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the core's review sections", () => {
  it("parse as the whole-file parser parses them", () => {
    const whole = parseConfig(EXAMPLE);
    const core = parseCoreConfig(EXAMPLE);
    for (const k of Object.keys(core) as (keyof typeof core)[]) {
      if (k === "github") continue;
      expect(core[k], k).toEqual(whole[k]);
    }
    // The secrets dir stays as written: the reader that needs it locates it.
    const { secrets_dir: _core, ...coreGithub } = core.github;
    const { secrets_dir: _whole, ...wholeGithub } = whole.github;
    expect(coreGithub).toEqual(wholeGithub);
  });

  it("need none of the app's sections", () => {
    const reviewOnly = EXAMPLE.split(/^(?=\[)/m)
      .filter((t) => !/^\[(server|daemon|eod|caps|slack|tui|companion|memory|openviking)\b/.test(t))
      .join("");
    expect(() => parseConfig(reviewOnly)).toThrow(/missing key/);
    expect(parseCoreConfig(reviewOnly)).toEqual(parseCoreConfig(EXAMPLE));
  });

  it("refuse what the whole-file parser refuses in them", () => {
    const bad = EXAMPLE.replace(/^\[review\]\n/m, '[review]\nnits = "loose"\n');
    expect(() => parseConfig(bad)).toThrow(/nits must be/);
    expect(() => parseCoreConfig(bad)).toThrow(/nits must be/);
  });

  it("say each deprecated key to the caller, and only when asked", () => {
    const old = EXAMPLE.replace(/^\[models\]\n/m, '[models]\noverseer = "x/y"\n');
    const heard: string[] = [];
    parseCoreConfig(old, { warn: (l) => heard.push(l) });
    expect(heard).toEqual([expect.stringMatching(/\[models\] overseer is deprecated/)]);
  });
});

describe("zero-config", () => {
  it("with no config of the install's own, the one-shot runs on the shipped defaults", () => {
    const loaded = loadOneShotConfig({ root: ROOT, env });
    expect(loaded.path).toBeNull();
    expect(loaded.toml).toBe(EXAMPLE);
    const expected = parseCoreConfig(EXAMPLE);
    expected.github.secrets_dir = locateSecrets({ configured: "", env }).path;
    expect(loaded.cfg).toEqual(expected);
    // A review context builds on them, with the examples as the only profiles.
    const { cfg } = contextFrom(
      ROOT,
      loaded,
      loaded.cfg.review.profile,
      "",
      homeProfileLookup(env),
    );
    expect(cfg.models.default).toBe(expected.models.default);
  });

  it("the install's own config wins over the defaults", () => {
    const home = join(env["XDG_CONFIG_HOME"]!, "qcr", "default");
    mkdirSync(home, { recursive: true });
    const own = EXAMPLE.replace(/^dry_run = true$/m, "dry_run = false");
    writeFileSync(join(home, "config.toml"), own);
    const loaded = loadOneShotConfig({ root: ROOT, env });
    expect(loaded.path).toBe(join(home, "config.toml"));
    expect(loaded.cfg.dry_run).toBe(false);
  });

  it("a QCR_CONFIG naming a missing file is still an error, not the defaults", () => {
    env["QCR_CONFIG"] = join(dir, "nowhere.toml");
    expect(() => loadOneShotConfig({ root: ROOT, env })).toThrow(/named by QCR_CONFIG/);
  });

  it("a config stranded in the checkout is named, not reviewed around", () => {
    const root = join(dir, "checkout");
    mkdirSync(root);
    copyFileSync(join(ROOT, SHIPPED_CONFIG_FILE), join(root, SHIPPED_CONFIG_FILE));
    writeFileSync(join(root, "config.toml"), EXAMPLE);
    expect(() => loadOneShotConfig({ root, env })).toThrow(/qcr install migrate/);
  });

  it("the daemon's loader still refuses to start without a config", () => {
    // The test setup points the locator at an empty config home.
    expect(() => loadConfig()).toThrow(/no config at/);
  });
});

describe("asset roots", () => {
  it("the core's data root is the package it ships in (today the checkout)", () => {
    expect(assetRoot()).toBe(ROOT);
    expect(sandboxRoot()).toBe(ROOT);
  });
});

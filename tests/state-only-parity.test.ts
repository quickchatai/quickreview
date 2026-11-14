// tests/state-only-parity.test.ts — a state-machine-only review reaches every
// route that resolves a config on its own, not only the daemon's
// `applyProfileOverlays`: the scan's config (`scanConfigOf`) keeps the family
// alone, and the shell render route (`renderConfig`) cuts posting to the
// `state` scope, each with no `[scan]` list or `[posting] scope` to lean on.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig, type Config } from "../src/config.js";
import { configHome, homeProfileLookup, type InstallEnv } from "../src/install.js";
import { renderConfig } from "../src/reviewrendercli.js";
import { STATE_FAMILY } from "@quickchatai/pi-quickreview/src/passes.js";
import { STATE_MACHINES_DEFAULTS } from "@quickchatai/pi-quickreview/src/reviewconfig.js";
import { scanConfigOf } from "@quickchatai/pi-quickreview/src/scan/scanagents.js";
import { stage2Lenses } from "@quickchatai/pi-quickreview/src/scan/stage2.js";

const root = join(import.meta.dirname, "..");
const fixture: Config = parseConfig(readFileSync(join(root, "tests/fixtures/config.toml"), "utf8"));

let dir: string;
let env: InstallEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-state-parity-"));
  env = { HOME: join(dir, "home"), XDG_CONFIG_HOME: join(dir, "xdg-config") };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const deepLenses = (cfg: Config): string[] => stage2Lenses(cfg.lenses, cfg.scan.lenses);

describe("a state-only scan", () => {
  // MUTATION: drop the `[state_machines]` overlay from `scanConfigOf` — this fails.
  it("config.toml's `only` under the default profile keeps the family alone", () => {
    const cfg = scanConfigOf(
      {
        ...fixture,
        review: { ...fixture.review, profile: "default" },
        state_machines: { ...STATE_MACHINES_DEFAULTS, only: true },
      },
      root,
      homeProfileLookup(env),
    );
    expect(cfg.scan.lenses).toEqual([]);
    const deep = deepLenses(cfg);
    expect(deep.length).toBeGreaterThan(0);
    for (const l of deep) expect(STATE_FAMILY, l).toContain(l);
  });

  it("a profile's `only` with no `[scan]` list keeps the family alone", () => {
    const home = join(configHome(env), "profiles", "smonly");
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "profile.toml"),
      'extends = "default"\n[state_machines]\nonly = true\n',
    );
    const cfg = scanConfigOf(
      { ...fixture, review: { ...fixture.review, profile: "smonly" } },
      root,
      homeProfileLookup(env),
    );
    expect(cfg.state_machines?.only).toBe(true);
    const deep = deepLenses(cfg);
    expect(deep.length).toBeGreaterThan(0);
    for (const l of deep) expect(STATE_FAMILY, l).toContain(l);
  });

  it("refuses a scan that is both security-only and state-only", () => {
    expect(() =>
      scanConfigOf(
        {
          ...fixture,
          review: { ...fixture.review, profile: "default" },
          security: { ...fixture.security, only: true },
          state_machines: { ...STATE_MACHINES_DEFAULTS, only: true },
        },
        root,
        homeProfileLookup(env),
      ),
    ).toThrow(/\[security\] only and \[state_machines\] only are both true/);
  });

  it("without `only` the scan keeps the general lenses", () => {
    const cfg = scanConfigOf(
      { ...fixture, review: { ...fixture.review, profile: "default" } },
      root,
      homeProfileLookup(env),
    );
    expect(deepLenses(cfg).some((l) => !STATE_FAMILY.includes(l))).toBe(true);
  });
});

describe("the render route's state scope", () => {
  // MUTATION: drop the `[state_machines]` read from `renderConfig` — this fails.
  it("the profile's `only` scopes posting to state", () => {
    const out = renderConfig("/sandbox", undefined, {
      config: () => fixture,
      profilePosting: () => ({}),
      profileSecurity: () => ({}),
      profileStateMachines: () => ({ only: true }),
    });
    expect(out.unread).toBeUndefined();
    expect(out.cfg.posting?.scope).toBe("state");
  });

  it("config.toml's `only` scopes posting to state", () => {
    const out = renderConfig("/sandbox", undefined, {
      config: () => ({
        ...fixture,
        state_machines: { ...STATE_MACHINES_DEFAULTS, only: true },
      }),
      profilePosting: () => ({}),
      profileSecurity: () => ({}),
      profileStateMachines: () => ({}),
    });
    expect(out.cfg.posting?.scope).toBe("state");
  });

  it("a scope the profile names wins, and no `only` adds no posting key", () => {
    const named = renderConfig("/sandbox", undefined, {
      config: () => fixture,
      profilePosting: () => ({ scope: "all" }),
      profileSecurity: () => ({}),
      profileStateMachines: () => ({ only: true }),
    });
    // `all` is the default policy, so no posting key is written.
    expect(named.cfg).not.toHaveProperty("posting");
    const plain = renderConfig("/sandbox", undefined, {
      config: () => ({ ...fixture, state_machines: { ...STATE_MACHINES_DEFAULTS, only: false } }),
      profilePosting: () => ({}),
      profileSecurity: () => ({}),
      profileStateMachines: () => ({}),
    });
    expect(plain.cfg).not.toHaveProperty("posting");
  });
});

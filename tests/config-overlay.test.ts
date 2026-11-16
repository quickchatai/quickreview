// tests/config-overlay.test.ts — a config.toml over the shipped defaults
// (packages/pi-plugin/src/shippedconfig.ts). A file that sets only some keys
// is config.example.toml with those keys changed: every table and key it
// leaves out takes the shipped value, on every surface that reads it (the
// one-shot review and the plugin through `loadOneShotConfig`, the daemon
// through `loadConfig`, the scan, and `qcr config check`). A key it sets is
// checked as written, and a file that does not load is one line naming the
// file and the key.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOSTED_EMBEDDING, loadConfig, parseConfig } from "../src/config.js";
import { checkConfigHome } from "../src/configcheck.js";
import { loadOneShotConfig, locateSecrets, SHIPPED_CONFIG_FILE } from "../src/homes.js";
import { homeProfileLookup } from "../src/install.js";
import { loadScanConfig } from "../src/setup/scanbuild.js";
import { ConfigError } from "@quickchatai/pi-quickreview/src/configerror.js";
import { contextFrom } from "@quickchatai/pi-quickreview/src/engine/context.js";
import { VALIDATE_PASS } from "@quickchatai/pi-quickreview/src/include.js";
import { STATE_FAMILY } from "@quickchatai/pi-quickreview/src/passes.js";
import { buildPassPlan } from "@quickchatai/pi-quickreview/src/planner.js";
import { loadProfileHeuristics } from "@quickchatai/pi-quickreview/src/profiles.js";
import { parseCoreConfig } from "@quickchatai/pi-quickreview/src/reviewconfig.js";
import {
  FILLED_TOGETHER,
  NEVER_FILLED,
  overShipped,
} from "@quickchatai/pi-quickreview/src/shippedconfig.js";
import type { PrFileEntry } from "@quickchatai/pi-quickreview/src/githubcore.js";

const ROOT = resolve(import.meta.dirname, "..");
const EXAMPLE = readFileSync(join(ROOT, SHIPPED_CONFIG_FILE), "utf8");
/** The config the e2e test of 1.5.0 wrote: one key. */
const PARTIAL = '[review]\nprofile = "state-machines"\n';
/** The shipped config with that one line changed. */
const FULL = EXAMPLE.replace(/^profile = ""$/m, 'profile = "state-machines"');

let dir: string;
let env: Record<string, string>;
let home: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-config-overlay-"));
  env = {
    HOME: dir,
    XDG_CONFIG_HOME: join(dir, "config"),
    XDG_STATE_HOME: join(dir, "state"),
  };
  home = join(env["XDG_CONFIG_HOME"]!, "qcr", "default");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Write the install's config.toml; its path. */
function own(toml: string): string {
  mkdirSync(home, { recursive: true });
  const path = join(home, "config.toml");
  writeFileSync(path, toml);
  return path;
}

/** The one-shot review's lens plan for a code change, as the preview plans
 * it: the loaded config, its profile resolved, the profile's heuristics. */
function plannedLenses(): string[] {
  const loaded = loadOneShotConfig({ root: ROOT, env });
  const profile = loaded.cfg.review.profile;
  const lookup = homeProfileLookup(env);
  const { cfg, ecosystem } = contextFrom(ROOT, loaded, profile, "", lookup);
  const change = {
    filename: "src/upload.ts",
    additions: 3,
    deletions: 0,
    changes: 3,
    status: "modified",
    patch:
      "@@ -1 +1,4 @@\n+export function up(x: unknown) {\n+  uploading = true;\n+  if (!x) return;\n+}\n",
  } as PrFileEntry;
  return buildPassPlan(
    cfg,
    [change],
    { title: "Upload", body: "" },
    ecosystem,
    loadProfileHeuristics(ROOT, profile, lookup),
  ).pass_plan.map((row) => row.lens);
}

describe("a config.toml that sets one key", () => {
  // MUTATION: return `written` from readConfigToml (shippedconfig.ts) without
  // the overlay — `config.toml: missing key 'github'` is thrown and this fails.
  it("is the shipped config with that key changed, in both parsers", () => {
    expect(parseCoreConfig(PARTIAL)).toEqual(parseCoreConfig(FULL));
    // The one difference: the full example writes `[scan] sandbox`, which a
    // partial file leaves unset (NEVER_FILLED, below).
    const { scan_sandbox: partialSandbox, ...partial } = parseConfig(PARTIAL);
    const { scan_sandbox: fullSandbox, ...full } = parseConfig(FULL);
    expect(partial).toEqual(full);
    expect({ ...partialSandbox, sandbox_set: true }).toEqual(fullSandbox);
  });

  it("plans the eight pass-sm-* lenses and the validator, as the full example does", () => {
    own(PARTIAL);
    const partial = plannedLenses();
    expect([...partial].sort()).toEqual([...STATE_FAMILY, VALIDATE_PASS].sort());
    expect(STATE_FAMILY).toHaveLength(8);
    own(FULL);
    expect(plannedLenses()).toEqual(partial);
  });

  it("loads the same on every surface that reads config.toml", () => {
    const path = own(PARTIAL);
    const expected = parseCoreConfig(FULL);
    expected.github.secrets_dir = locateSecrets({ configured: "", env }).path;
    // The one-shot review and the plugin.
    const loaded = loadOneShotConfig({ root: ROOT, env });
    expect(loaded.path).toBe(path);
    expect(loaded.cfg).toEqual(expected);
    // The daemon.
    expect(loadConfig(path).review.profile).toBe("state-machines");
    // The scan.
    const scan = loadScanConfig(ROOT, env);
    expect(scan.ok && scan.cfg.review.profile).toBe("state-machines");
    // `qcr config check`.
    expect(checkConfigHome({ home, root: ROOT })).toMatchObject({ ok: true, errors: [] });
  });
});

describe("an empty config.toml", () => {
  // MUTATION: in loadScanConfig (src/setup/scanbuild.ts) read the shipped
  // file's text when the install has no config — `[scan] sandbox` reads as
  // set there and unset here, and this fails.
  it("behaves like no config.toml", () => {
    const none = loadOneShotConfig({ root: ROOT, env });
    const noneScan = loadScanConfig(ROOT, env);
    own("");
    const empty = loadOneShotConfig({ root: ROOT, env });
    expect(empty.path).not.toBeNull();
    expect(empty.cfg).toEqual(none.cfg);
    expect(loadScanConfig(ROOT, env)).toEqual(noneScan);
    expect(parseCoreConfig("")).toEqual(parseCoreConfig(EXAMPLE));
  });
});

describe("a key the file sets", () => {
  it("is checked as written", () => {
    for (const parse of [parseConfig, parseCoreConfig])
      expect(() => parse('[review]\nnits = "loose"\n')).toThrow(/nits must be/);
  });

  // MUTATION: drop `throw configErrorAt(file, err)` from loadOneShotConfig
  // (packages/pi-plugin/src/homes.ts), rethrowing `err` — the refusal is no
  // ConfigError and names no file, and this fails.
  it("refuses an unknown tier in one line naming the file and the key", () => {
    const path = own('[models]\nvalidate_tier = "ultra"\n');
    const line = `${path} [models] validate_tier: unknown tier "ultra" (one of light, standard, deep)`;
    for (const load of [() => loadOneShotConfig({ root: ROOT, env }), () => loadConfig(path)]) {
      let thrown: unknown;
      try {
        load();
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ConfigError);
      expect((thrown as Error).message).toBe(line);
    }
    expect(checkConfigHome({ home, root: ROOT }).errors).toEqual([
      { where: path, message: expect.stringContaining("[models] validate_tier: unknown tier") },
    ]);
  });

  it("refuses a file that is no TOML in one line saying where", () => {
    const path = own('[review]\nprofile = "x\n');
    expect(() => loadOneShotConfig({ root: ROOT, env })).toThrow(
      new ConfigError(
        path,
        `${path}: Invalid TOML document: control characters are not allowed in strings (line 2, column 13)`,
      ),
    );
  });
});

describe("keys the shipped file does not fill", () => {
  // MUTATION: drop the embedder group from FILLED_TOGETHER — the shipped
  // local model and its 384 fill in under the hosted provider, and this fails.
  it("a hosted embedder that names no model runs the hosted model", () => {
    const ov = parseConfig('[openviking]\nembedding_provider = "openai"\n').openviking;
    expect(ov.embedding_model).toBe(HOSTED_EMBEDDING.model);
    expect(ov.embedding_dimension).toBe(HOSTED_EMBEDDING.dimension);
    // Unwritten, the group is the shipped local embedder.
    expect(parseConfig("").openviking.embedding_model).toBe(
      parseConfig(EXAMPLE).openviking.embedding_model,
    );
  });

  // MUTATION: drop the `[models] model` group (or a tier's) from
  // FILLED_TOGETHER — a shipped current spelling shadows the older one the
  // file writes, and this fails.
  it("an older spelling the file writes is never shadowed by a shipped current one", () => {
    const shipped = {
      models: {
        model: "prov/new",
        validate_tier: "deep",
        tiers: { deep: "prov/d", light: "prov/l" },
      },
    };
    const written = { models: { conversation: "prov/old", tiers: { "sol-high": "prov/h" } } };
    expect(overShipped(written, shipped)).toEqual({
      models: {
        conversation: "prov/old",
        validate_tier: "deep",
        tiers: { "sol-high": "prov/h", light: "prov/l" },
      },
    });
    for (const group of FILLED_TOGETHER) expect(group.length).toBeGreaterThan(1);
  });

  // MUTATION: empty NEVER_FILLED — an unset `[scan] sandbox` reads as the
  // shipped "docker", set, and this fails.
  it("an unset [scan] sandbox stays unset", () => {
    expect(NEVER_FILLED).toContain("scan.sandbox");
    expect(parseConfig("").scan_sandbox).toMatchObject({ sandbox: "docker", sandbox_set: false });
    expect(parseConfig('[scan]\nsandbox = "docker"\n').scan_sandbox.sandbox_set).toBe(true);
  });
});

describe("the overlay", () => {
  // MUTATION: in overShipped take a written table whole (no recursion) —
  // the shipped keys beside the written one go, and this fails.
  it("merges a table key by key, takes an array or a value whole, and changes neither side", () => {
    const shipped = {
      a: 1,
      t: { x: 1, y: [1, 2], inner: { p: 1, q: 2 } },
      arr: [1, 2, 3],
    };
    const written = { t: { y: [9], inner: { q: 5 } }, arr: [], z: true };
    const before = structuredClone({ shipped, written });
    expect(overShipped(written, shipped)).toEqual({
      a: 1,
      t: { x: 1, y: [9], inner: { p: 1, q: 5 } },
      arr: [],
      z: true,
    });
    expect({ shipped, written }).toEqual(before);
    // A per-cause override keeps the shipped causes beside it.
    const causes = parseConfig(
      '[slack.policy.causes]\n"round.overdue" = { enabled = false, cooldown_min = 5 }\n',
    ).slack.policy.causes;
    const shippedCauses = parseConfig(EXAMPLE).slack.policy.causes;
    expect(Object.keys(causes).sort()).toEqual(Object.keys(shippedCauses).sort());
    expect(causes["round.overdue"]).toMatchObject({ enabled: false, cooldown_min: 5 });
  });
});

// tests/profile-lens-tuning.test.ts — `[lenses.<pass>]` in profile.toml
//.
//
// Every case resolves a profile the way production does — wire.ts's
// `buildParts` overlays `loadProfileLensTuning` on the parsed config with
// `applyProfileTuning`, and `rebuildAgents` hands the build the per-variant
// model hook and the compiled addenda — and asserts on what that makes the
// PLAN (`buildPassPlan` / `buildRoundOrder`) and the BUILT AGENTS
// (`buildAgents`) do, never on the resolver's internals.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { applyReviewEffort, parseConfig, type Config } from "../src/config.js";
import { addTierOf, buildPassPlan, buildRoundOrder } from "../src/dispatch.js";
import { NONE_ECOSYSTEM } from "../src/ecosystem.js";
import { DOWNGRADE_WORDS } from "../src/findingsrecord.js";
import type { PrFileEntry } from "../src/github.js";
import { PASS_ADDENDA, buildAgents } from "../src/include.js";
import { configHome, type InstallEnv } from "../src/install.js";
import {
  applyProfileTuning,
  lensModelOverrides,
  lensTuningAddenda,
  PROFILE_CAP_WORD,
} from "../src/lenstuning.js";
import { loadProfileAddenda, loadProfileLensTuning } from "../src/profiles.js";
import { runFingerprint } from "../src/bench/runner.js";
import { buildParts } from "../src/wire.js";
import { renderAddableLenses } from "../src/templates.js";
import type { PrStateRow } from "../src/state.js";

const sandbox = join(import.meta.dirname, "..");
const fixture: Config = parseConfig(
  readFileSync(resolve(sandbox, "tests/fixtures/config.toml"), "utf8"),
);

let dir: string;
let env: InstallEnv;
const lookup = () => ({ env, log: () => {} });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-lens-tuning-"));
  env = { HOME: join(dir, "home"), XDG_CONFIG_HOME: join(dir, "xdg-config") };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Write a profile into the install's config home: `profile.toml` and an
 * empty addenda pack. */
function profile(name: string, toml: string): void {
  const p = join(configHome(env), "profiles", name);
  mkdirSync(join(p, "addenda"), { recursive: true });
  writeFileSync(join(p, "profile.toml"), toml);
}

/** The config a daemon selecting `name` reviews with — buildParts's overlay.
 * `base` stands in for config.toml (+ its preset). */
function tuned(name: string, base: Config = fixture): Config {
  const cfg = structuredClone(base);
  cfg.review.profile = name;
  return applyProfileTuning(cfg, loadProfileLensTuning(sandbox, name, lookup()));
}

/** Build the real agents/ seeds as wire.ts rebuildAgents does: name → bytes. */
function agents(cfg: Config): Map<string, string> {
  const out = mkdtempSync(join(tmpdir(), "qcr-lens-tuning-build-"));
  try {
    const files = new Map<string, string>();
    const built = buildAgents(join(sandbox, "agents"), out, {
      root: sandbox,
      tiers: cfg.models.tiers,
      riskPasses: cfg.models.risk_passes,
      validateTier: cfg.models.validate_tier,
      models: lensModelOverrides(cfg.models, cfg.lenses),
      addenda: [
        ...PASS_ADDENDA,
        ...loadProfileAddenda(sandbox, cfg.review.profile, lookup()),
        ...lensTuningAddenda(cfg.lenses),
      ],
    });
    for (const b of built) files.set(b.name, readFileSync(b.output, "utf8"));
    return files;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

const modelOf = (bytes: string | undefined): string | undefined =>
  /^model:\s*(.+)$/m.exec(bytes ?? "")?.[1];

const file = (filename: string, extra: Partial<PrFileEntry> = {}): PrFileEntry => ({
  filename,
  additions: 5,
  deletions: 0,
  status: "modified",
  ...extra,
});

/** A small code change: default tier terra-med, baseline planned. */
const SMALL = [file("app/views.py")];
/** A security-shaped change: pass-security (a risk pass) planned. */
const AUTH = [file("svc/auth/token.py", { patch: "+def check(t): return t\n" })];

const plan = (cfg: Config, files: PrFileEntry[]) =>
  buildPassPlan(cfg, files, undefined, NONE_ECOSYSTEM);
const row = (cfg: Config, files: PrFileEntry[], lens: string) =>
  plan(cfg, files).pass_plan.find((p) => p.lens === lens);
const lensesOf = (cfg: Config, files: PrFileEntry[]) =>
  plan(cfg, files).pass_plan.map((p) => p.lens);

// ---- untuned is unchanged -----------------------------------------------------

describe("an untuned profile changes nothing", () => {
  it("no [lenses] ⇒ the same plan and the same built bytes as no profile", () => {
    profile("plain", 'extends = "default"\n');
    const cfg = tuned("plain");
    expect(cfg.lenses).toEqual({});
    for (const files of [SMALL, AUTH]) expect(plan(cfg, files)).toEqual(plan(fixture, files));
    const a = agents(tuned(""));
    const b = agents(cfg);
    for (const [name, bytes] of a) expect(b.get(name), name).toBe(bytes);
  });
});

// ---- min_tier -------------------------------------------------------------------

describe("min_tier floors the plan", () => {
  it("in the lens's row and its raisable set", () => {
    expect(row(fixture, SMALL, "pass-baseline")).toMatchObject({
      tier: "terra-med",
      raisable_to: ["pass-baseline--sol-med", "pass-baseline--sol-high"],
    });
    profile("floor", '[lenses.pass-baseline]\nmin_tier = "sol-med"\n');
    expect(row(tuned("floor"), SMALL, "pass-baseline")).toEqual({
      lens: "pass-baseline",
      agent: "pass-baseline--sol-med",
      tier: "sol-med",
      raisable_to: ["pass-baseline--sol-high"],
    });
  });

  it("never lowers: a risk pass stays sol-high and pinned", () => {
    profile("low", '[lenses.pass-security]\nmin_tier = "terra-med"\n');
    expect(row(tuned("low"), AUTH, "pass-security")).toMatchObject({
      tier: "sol-high",
      raisable_to: [],
    });
  });

  it("raises the validator's floor, and a floored lens raises the validator", () => {
    const lowFloor = structuredClone(fixture);
    lowFloor.models.validate_tier = "terra-med";
    expect(row(lowFloor, SMALL, "pass-validate")?.tier).toBe("terra-med");
    profile("vfloor", '[lenses.pass-validate]\nmin_tier = "sol-med"\n');
    expect(row(tuned("vfloor", lowFloor), SMALL, "pass-validate")?.tier).toBe("sol-med");
    profile("lfloor", '[lenses.pass-baseline]\nmin_tier = "sol-high"\n');
    expect(row(tuned("lfloor", lowFloor), SMALL, "pass-validate")?.tier).toBe("sol-high");
  });

  it("in the sweep's rows — and a floored sweep raises the validator", () => {
    const swept = structuredClone(fixture);
    swept.review.sweep = true;
    swept.models.validate_tier = "terra-med";
    const sweepRows = (cfg: Config) =>
      plan(cfg, SMALL).pass_plan.filter((p) => p.lens === "pass-sweep");
    expect(sweepRows(swept).map((r) => r.tier)).toEqual(["terra-med"]);
    profile("sweep", '[lenses.pass-sweep]\nmin_tier = "sol-med"\n');
    const cfg = tuned("sweep", swept);
    expect(sweepRows(cfg)).toEqual([
      expect.objectContaining({
        agent: "pass-sweep--sol-med",
        tier: "sol-med",
        raisable_to: ["pass-sweep--sol-high"],
      }),
    ]);
    expect(row(cfg, SMALL, "pass-validate")?.tier).toBe("sol-med");
  });

  it("in the add rule: the addable lens is named with its floored variant", () => {
    expect(addTierOf(fixture, "pass-concurrency")).toBe("sol-med");
    expect(addTierOf(fixture, "pass-security")).toBe("sol-high");
    profile("add", '[lenses.pass-concurrency]\nmin_tier = "sol-high"\n');
    const cfg = tuned("add");
    expect(addTierOf(cfg, "pass-concurrency")).toBe("sol-high");
    const order = (c: Config) =>
      buildRoundOrder({
        cfg: c,
        row: { number: 7, title: "t", head_sha: "abc" } as unknown as PrStateRow,
        files: SMALL,
        roundId: 1,
        roundNo: 1,
        roundType: "first",
        worktree: "/wt",
        settledDigest: "",
        issuedAt: "2026-09-29T00:00:00Z",
        ecosystem: NONE_ECOSYSTEM,
      });
    expect(order(fixture).addable_tiers).toBeUndefined();
    const o = order(cfg);
    expect(o.addable_tiers).toEqual({ "pass-concurrency": "sol-high" });
    expect(renderAddableLenses(o.addable_lenses, o.addable_tiers)).toContain(
      "pass-concurrency (run `pass-concurrency--sol-high`)",
    );
    // The templates tell the session to honour a named variant.
    for (const t of ["round-first.md", "round-re-review.md", "round-staleness.md"]) {
      expect(readFileSync(join(sandbox, "prompts", t), "utf8")).toMatch(
        /or the list above names the variant to run/,
      );
    }
  });
});

// ---- effort -----------------------------------------------------------------------

describe("effort rewrites only that lens's built variants", () => {
  it("every variant of the tuned lens, and no other file", () => {
    profile("think", '[lenses.pass-ui]\neffort = "low"\n');
    const plainBuild = agents(tuned(""));
    const tunedBuild = agents(tuned("think"));
    for (const [name, bytes] of plainBuild) {
      if (name.startsWith("pass-ui--")) {
        expect(modelOf(tunedBuild.get(name)), name).toMatch(/:low$/);
        expect(modelOf(bytes), name).not.toMatch(/:low$/);
      } else {
        expect(tunedBuild.get(name), name).toBe(bytes);
      }
    }
  });

  it("high means the model's ceiling (effort_max), and it beats the global effort", () => {
    const globalLow = structuredClone(fixture);
    globalLow.models = applyReviewEffort({ ...globalLow.models, effort: "low" });
    profile("max", '[lenses.pass-security]\neffort = "high"\n');
    const built = agents(tuned("max", globalLow));
    expect(modelOf(built.get("pass-security--sol-high"))).toBe(
      `openai-codex/gpt-5.6-sol:${fixture.models.effort_max}`,
    );
    expect(modelOf(built.get("pass-baseline--sol-high"))).toBe("openai-codex/gpt-5.6-sol:low");
  });
});

// ---- enabled ----------------------------------------------------------------------

describe("enabled = false removes any lens", () => {
  it("the baseline and a risk pass: gone from the plan and from the addable list", () => {
    expect(lensesOf(fixture, AUTH)).toEqual(
      expect.arrayContaining(["pass-baseline", "pass-security"]),
    );
    profile(
      "off",
      "[lenses.pass-baseline]\nenabled = false\n\n[lenses.pass-security]\nenabled = false\n",
    );
    const cfg = tuned("off");
    const p = plan(cfg, AUTH);
    for (const lens of ["pass-baseline", "pass-security"]) {
      expect(p.pass_plan.map((r) => r.lens)).not.toContain(lens);
      expect(p.addable_lenses).not.toContain(lens);
    }
    expect(p.pass_plan.at(-1)?.lens).toBe("pass-validate");
  });

  it("an addable-only lens is no longer addable", () => {
    profile("noconc", "[lenses.pass-concurrency]\nenabled = false\n");
    expect(plan(fixture, SMALL).addable_lenses).toContain("pass-concurrency");
    expect(plan(tuned("noconc"), SMALL).addable_lenses).not.toContain("pass-concurrency");
  });

  it("beats a [review] lever that would plan it — and enabled = true beats one that would not", () => {
    const on = structuredClone(fixture);
    on.review.tests_lens = true;
    on.review.sweep = true;
    expect(lensesOf(on, SMALL)).toEqual(expect.arrayContaining(["pass-tests", "pass-sweep"]));
    profile(
      "levers-off",
      "[lenses.pass-tests]\nenabled = false\n[lenses.pass-sweep]\nenabled = false\n",
    );
    expect(lensesOf(tuned("levers-off", on), SMALL)).not.toContain("pass-tests");
    expect(lensesOf(tuned("levers-off", on), SMALL)).not.toContain("pass-sweep");

    const off = structuredClone(fixture);
    off.review.tests_lens = false;
    off.review.sweep = false;
    expect(lensesOf(off, SMALL)).not.toContain("pass-tests");
    profile(
      "levers-on",
      "[lenses.pass-tests]\nenabled = true\n[lenses.pass-sweep]\nenabled = true\n",
    );
    expect(lensesOf(tuned("levers-on", off), SMALL)).toEqual(
      expect.arrayContaining(["pass-tests", "pass-sweep"]),
    );
  });

  it("enabled = true never plans a lens the selector did not choose", () => {
    profile("force", "[lenses.pass-concurrency]\nenabled = true\n");
    expect(lensesOf(tuned("force"), SMALL)).not.toContain("pass-concurrency");
  });

  it("the validator cannot be switched off here", () => {
    profile("novalidate", "[lenses.pass-validate]\nenabled = false\n");
    expect(() => tuned("novalidate")).toThrow(/validator cannot be switched off/);
  });
});

// ---- emphasis -----------------------------------------------------------------------

describe("emphasis becomes that lens's addendum", () => {
  it("in every built variant of the lens, after the profile's pack, and nowhere else", () => {
    profile("say", '[lenses.pass-ui]\nemphasis = "EMPHASIS-MARK: accessibility is the product."\n');
    const cfg = tuned("say");
    expect(lensTuningAddenda(cfg.lenses)).toEqual([
      expect.objectContaining({ id: "lens-emphasis-pass-ui", scope: ["pass-ui"] }),
    ]);
    for (const [name, bytes] of agents(cfg)) {
      if (name.startsWith("pass-ui--")) expect(bytes, name).toContain("EMPHASIS-MARK");
      else expect(bytes, name).not.toContain("EMPHASIS-MARK");
    }
  });

  it("a pack may not claim the ids the tuning compiles to", () => {
    const p = join(configHome(env), "profiles", "squat");
    mkdirSync(join(p, "addenda"), { recursive: true });
    writeFileSync(
      join(p, "addenda", "10-x.md"),
      "---\nid: lens-emphasis-pass-ui\nscope: pass-ui\n---\n## x\n",
    );
    expect(() => loadProfileAddenda(sandbox, "squat", lookup())).toThrow(/reserved/);
  });
});

// ---- max_severity -------------------------------------------------------------------

describe("max_severity raises or lowers the lens's ceiling", () => {
  it("binds the lens and the validator, composed after every built-in cap", () => {
    profile(
      "ceil",
      '[lenses.pass-placement]\nmax_severity = "P1"\n[lenses.pass-ui]\nmax_severity = "P3"\n',
    );
    const built = agents(tuned("ceil"));
    const validator = built.get("pass-validate--sol-high") ?? "";
    // Raise: placement's built-in P2 cap is replaced by P1.
    const raise = validator.indexOf("Severity ceiling for `pass-placement`: `P1`");
    expect(raise).toBeGreaterThan(validator.indexOf("capped at P2 (sandbox rule)"));
    expect(validator).toContain("It REPLACES every other cap");
    // Lower: pass-ui (uncapped) is capped at P3 with the recorded word.
    expect(validator).toContain("Severity ceiling for `pass-ui`: `P3`");
    expect(validator).toContain(PROFILE_CAP_WORD);
    expect(DOWNGRADE_WORDS).toContain(PROFILE_CAP_WORD);
    // The lens itself is told; an untuned lens is not.
    expect(built.get("pass-placement--sol-med")).toContain("Severity ceiling for `pass-placement`");
    expect(built.get("pass-baseline--sol-med")).not.toContain("Severity ceiling");
  });

  it("P0 lifts the cap entirely", () => {
    profile("lift", '[lenses.pass-intent]\nmax_severity = "P0"\n');
    const [a] = lensTuningAddenda(tuned("lift").lenses);
    expect(a?.text).toMatch(/may carry any severity: judge each at its own severity/);
  });
});

// ---- the chain, precedence and refusals ----------------------------------------------

describe("resolution", () => {
  it("merges down the extends chain: per lens, per key, the child wins", () => {
    profile(
      "base",
      '[lenses.pass-ui]\nmin_tier = "sol-high"\neffort = "low"\n[lenses.pass-baseline]\nenabled = false\n',
    );
    profile("child", 'extends = "base"\n[lenses.pass-ui]\neffort = "medium"\n');
    expect(tuned("child").lenses).toEqual({
      "pass-ui": { min_tier: "sol-high", effort: "medium" },
      "pass-baseline": { enabled: false },
    });
  });

  it("the profile wins over config.toml and its preset", () => {
    // preset "max" sets every model at its ceiling and turns levers on.
    const maxPreset = parseConfig(
      readFileSync(resolve(sandbox, "tests/fixtures/config.toml"), "utf8").replace(
        /^\[review\]$/m,
        '[review]\npreset = "max"',
      ),
    );
    profile(
      "calm",
      '[lenses.pass-baseline]\neffort = "low"\n[lenses.pass-tests]\nenabled = false\n',
    );
    const cfg = tuned("calm", maxPreset);
    expect(modelOf(agents(cfg).get("pass-baseline--sol-high"))).toMatch(/:low$/);
    expect(lensesOf(maxPreset, SMALL)).toContain("pass-tests");
    expect(lensesOf(cfg, SMALL)).not.toContain("pass-tests");
  });

  it("refuses, loudly, what it cannot honour", () => {
    const refused: [string, RegExp][] = [
      ["[lenses.pass-nope]\nenabled = false\n", /\[lenses\.pass-nope\] is not a known lens/],
      ["[lenses.pass-ui]\nweight = 3\n", /unknown key "weight"/],
      ['[lenses.pass-ui]\nmin_tier = "gold"\n', /min_tier must be one of/],
      ['[lenses.pass-ui]\neffort = "xhigh"\n', /effort must be/],
      ['[lenses.pass-ui]\nmax_severity = "P9"\n', /max_severity must be one of/],
      ['[lenses.pass-validate]\nmax_severity = "P1"\n', /validator raises no findings/],
      ['[lenses.pass-ui]\nemphasis = " "\n', /emphasis must be a non-empty string/],
      ["[lenses.pass-ui]\nenabled = 1\n", /enabled must be true or false/],
      ['lenses = "all"\n', /\[lenses\] must be a table/],
    ];
    refused.forEach(([toml, re], i) => {
      profile(`bad${i}`, toml);
      expect(() => tuned(`bad${i}`), toml).toThrow(re);
    });
    // A broken base breaks the child that overrides it.
    profile("brokenbase", '[lenses.pass-ui]\neffort = "turbo"\n');
    profile("fixes", 'extends = "brokenbase"\n[lenses.pass-ui]\neffort = "low"\n');
    expect(() => tuned("fixes")).toThrow(/profile "brokenbase"/);
  });
});

// ---- the production seam -------------------------------------------------------

describe("the daemon's assembly overlays the tuning (wire.ts buildParts)", () => {
  it("parts.cfg carries the selected profile's resolved lenses", () => {
    profile("wired", '[lenses.pass-ui]\nenabled = false\n');
    const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
    process.env.HOME = env.HOME;
    process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME;
    try {
      const loaded = structuredClone(fixture);
      loaded.review.profile = "wired";
      const parts = buildParts(sandbox, loaded);
      expect(parts.cfg.lenses).toEqual({ "pass-ui": { enabled: false } });
      expect(lensesOf(parts.cfg, [file("web/src/App.tsx")])).not.toContain("pass-ui");
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

// ---- the bench fingerprint -------------------------------------------------------------

describe("the bench fingerprint records the resolved tuning", () => {
  it("present when tuned, absent (unchanged) when not", () => {
    expect(runFingerprint(tuned(""), "")).not.toHaveProperty("lenses");
    profile("fp", '[lenses.pass-ui]\nmin_tier = "sol-high"\nenabled = true\n');
    expect(runFingerprint(tuned("fp"), "fp").lenses).toEqual({
      "pass-ui": { min_tier: "sol-high", enabled: true },
    });
  });
});

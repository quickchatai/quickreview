// Per-lens cost knobs (2026-09-29): `[review] skip_lenses`,
// `[models.pass_tiers]`, `[review] validate_consequence_rule`, and the bench
// `--config` route that sets them. Every default reproduces the review as
// shipped — pinned first, below.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyConfigOverrides, runFingerprint } from "../src/bench/runner.js";
import {
  DEFAULT_PASS_TIERS,
  parseConfig,
  REVIEW_DEFAULTS,
  validateLensKnobs,
  type Config,
} from "../src/config.js";
import { buildPassPlan } from "../src/dispatch.js";
import { lensModelOverrides } from "../src/lenstuning.js";
import type { PrFileEntry } from "../src/github.js";
import {
  buildAgents,
  configAddenda,
  PASS_ADDENDA,
  passTierModels,
  VALIDATE_PASS,
} from "../src/include.js";
import { QUALITY_PASSES, SWEEP_PASS } from "../src/heuristics.js";

const ROOT = process.cwd();
const fixture = readFileSync(resolve(ROOT, "tests/fixtures/config.toml"), "utf8");
const baseCfg: Config = parseConfig(fixture);
const example: Config = parseConfig(readFileSync(resolve(ROOT, "config.example.toml"), "utf8"));

const withReview = (over: Partial<Config["review"]>): Config => {
  const cfg = structuredClone(baseCfg);
  cfg.review = { ...cfg.review, ...over };
  return cfg;
};
const withPins = (pins: Record<string, string>): Config => {
  const cfg = structuredClone(baseCfg);
  cfg.models.pass_tiers = pins as Config["models"]["pass_tiers"];
  return cfg;
};
const file = (filename: string, lines: number): PrFileEntry => ({
  filename,
  additions: lines,
  deletions: 0,
  status: "modified",
  patch: ["@@ -1,1 +1,2 @@", ...Array.from({ length: lines }, (_, i) => `+x${i}();`)].join("\n"),
});
/** A small diff (terra-med), with enough code for the quality lenses and a sweep. */
const SMALL = [file("src/a.ts", 40), file("src/b.ts", 30)];
/** A large diff (sol-med). */
const LARGE = [file("src/a.ts", 200), file("src/b.ts", 100)];

const tomlWith = (section: string, lines: string): string =>
  fixture.replace(new RegExp(`^\\[${section.replace(".", "\\.")}\\]\\n`, "m"), (h) => h + lines);

// ---- defaults are the shipped review ---------------------------------------

describe("defaults reproduce today's review", () => {
  it("every config parses to no skips, the shipped pins, no consequence rule", () => {
    // The shipped pins (owner decision 2026-10-03, src/config.ts DEFAULT_PASS_TIERS):
    // baseline, sweep and behaviour-delta at sol-high; nothing else pinned.
    for (const cfg of [baseCfg, example]) {
      expect(cfg.review.skip_lenses).toEqual([]);
      expect(cfg.review.validate_consequence_rule).toBe(false);
      expect(cfg.models.pass_tiers).toEqual({
        "pass-baseline": "sol-high",
        "pass-sweep": "sol-high",
        "pass-behaviour-delta": "sol-high",
      });
    }
    expect(REVIEW_DEFAULTS.skip_lenses).toEqual([]);
    expect(REVIEW_DEFAULTS.validate_consequence_rule).toBe(false);
  });

  it("the default plan is byte-identical to one built from a config without the new keys", () => {
    const legacy = structuredClone(baseCfg) as unknown as {
      review: Record<string, unknown>;
      models: Record<string, unknown>;
    };
    delete legacy.review.skip_lenses;
    delete legacy.review.validate_consequence_rule;
    // pass_tiers is not one of the legacy-absent keys any more: its default
    // carries the shipped pins (DEFAULT_PASS_TIERS), so a config without the
    // table still pins — exercised in the test below.
    for (const files of [SMALL, LARGE])
      expect(buildPassPlan(baseCfg, files)).toEqual(
        buildPassPlan(legacy as unknown as Config, files),
      );
  });

  it("the default config addenda and the default model map are unchanged", () => {
    // + the duplicate merge's validator rule, on by default since round 7 (docs/duplicate-merge.md)
    expect(configAddenda(baseCfg.review).map((a) => a.id)).toEqual([
      "validate-demote-not-kill",
      "dedup-group-validate",
    ]);
    // the shipped pins' variants carry the sol-high spec; no other lens is touched
    const pinned = passTierModels(baseCfg.models.pass_tiers, baseCfg.models.tiers);
    const expected: Record<string, string> = {};
    for (const lens of Object.keys(DEFAULT_PASS_TIERS))
      for (const t of ["terra-med", "sol-med", "sol-high"] as const)
        expected[`${lens}--${t}`] = baseCfg.models.tiers["sol-high"];
    expect(pinned).toEqual(expected);
  });

  it("a profile lowers a shipped pin's thinking with [lenses.<pass>] effort; other lenses untouched", () => {
    const cfg = structuredClone(baseCfg);
    cfg.lenses = { "pass-baseline": { effort: "medium" } };
    const models = passTierModels(
      cfg.models.pass_tiers,
      cfg.models.tiers,
      lensModelOverrides(cfg.models, cfg.lenses),
    );
    // the pinned tier's spec with the profile's thinking level, on every variant
    for (const t of ["terra-med", "sol-med", "sol-high"] as const)
      expect(models[`pass-baseline--${t}`]?.endsWith(":medium")).toBe(true);
    // the other shipped pins keep sol-high's spec
    expect(models["pass-sweep--terra-med"]).toBe(cfg.models.tiers["sol-high"]);
    expect(models["pass-behaviour-delta--terra-med"]).toBe(cfg.models.tiers["sol-high"]);
    // an unpinned lens gets no variant override at all
    expect(models["pass-tests--sol-med"]).toBeUndefined();
  });

  it("a config with no [models.pass_tiers] table still gets the shipped pins; an entry replaces one", () => {
    expect(parseConfig(fixture).models.pass_tiers).toEqual({ ...DEFAULT_PASS_TIERS });
    const lowered = parseConfig(fixture + `\n[models.pass_tiers]\n"pass-baseline" = "sol-med"\n`);
    expect(lowered.models.pass_tiers).toEqual({
      ...DEFAULT_PASS_TIERS,
      "pass-baseline": "sol-med",
    });
    const row = buildPassPlan(lowered, LARGE).pass_plan.find((p) => p.lens === "pass-baseline")!;
    expect(row.tier).toBe("sol-med");
  });
});

// ---- [review] skip_lenses --------------------------------------------------

describe("[review] skip_lenses", () => {
  const plan = (cfg: Config, files = SMALL) => buildPassPlan(cfg, files);

  it("drops the listed lenses from the plan and from the addable set", () => {
    const base = plan(baseCfg);
    expect(base.pass_plan.map((p) => p.lens)).toEqual(
      expect.arrayContaining(["pass-abstraction", "pass-duplication"]),
    );
    const cut = plan(withReview({ skip_lenses: ["pass-abstraction", "pass-duplication"] }));
    const lenses = cut.pass_plan.map((p) => p.lens);
    expect(lenses).not.toContain("pass-abstraction");
    expect(lenses).not.toContain("pass-duplication");
    expect(cut.addable_lenses).not.toContain("pass-abstraction");
    expect(cut.addable_lenses).not.toContain("pass-duplication");
    // everything else is exactly the base plan
    expect(cut.pass_plan).toEqual(
      base.pass_plan.filter((p) => p.lens !== "pass-abstraction" && p.lens !== "pass-duplication"),
    );
    for (const l of QUALITY_PASSES.filter(
      (q) => q !== "pass-abstraction" && q !== "pass-duplication",
    ))
      expect(lenses).toContain(l);
  });

  it("skips the sweep rows, the baseline and a risk pass alike; the validator always stays", () => {
    const cut = plan(withReview({ skip_lenses: [SWEEP_PASS, "pass-baseline", "pass-security"] }));
    const lenses = cut.pass_plan.map((p) => p.lens);
    expect(lenses).not.toContain(SWEEP_PASS);
    expect(lenses).not.toContain("pass-baseline");
    expect(cut.sweep_unswept).toEqual([]);
    expect(cut.addable_lenses).not.toContain("pass-security");
    expect(lenses[lenses.length - 1]).toBe(VALIDATE_PASS);
  });

  it("refuses pass-validate and unknown names at parse", () => {
    expect(() => parseConfig(tomlWith("review", `skip_lenses = ["pass-validate"]\n`))).toThrow(
      /pass-validate/,
    );
    expect(() => parseConfig(tomlWith("review", `skip_lenses = ["pass-abstracton"]\n`))).toThrow(
      /unknown pass "pass-abstracton"/,
    );
    expect(() => parseConfig(tomlWith("review", `skip_lenses = "pass-ui"\n`))).toThrow(/array/);
    const ok = parseConfig(tomlWith("review", `skip_lenses = ["pass-abstraction"]\n`));
    expect(ok.review.skip_lenses).toEqual(["pass-abstraction"]);
  });

  it("a hand-built config naming pass-validate still plans the validator", () => {
    const cut = plan(withReview({ skip_lenses: [VALIDATE_PASS] }));
    expect(cut.pass_plan.map((p) => p.lens)).toContain(VALIDATE_PASS);
  });
});

// ---- [models.pass_tiers] ---------------------------------------------------

describe("[models.pass_tiers]", () => {
  it("pins a lens's planned tier regardless of diff size, not raisable", () => {
    for (const files of [SMALL, LARGE]) {
      const { pass_plan } = buildPassPlan(withPins({ "pass-baseline": "sol-high" }), files);
      const baseline = pass_plan.find((p) => p.lens === "pass-baseline")!;
      expect(baseline).toMatchObject({
        agent: "pass-baseline--sol-high",
        tier: "sol-high",
        raisable_to: [],
      });
    }
    // a pin may lower too: a large diff's lens held at terra-med
    const low = buildPassPlan(withPins({ "pass-baseline": "terra-med" }), LARGE).pass_plan;
    expect(low.find((p) => p.lens === "pass-baseline")!.agent).toBe("pass-baseline--terra-med");
    // unpinned lenses keep the diff-size tier
    expect(low.find((p) => p.lens === "pass-tests")!.tier).toBe("sol-med");
  });

  it("pins every sweep row; the validator never follows it", () => {
    const cfg = withPins({ [SWEEP_PASS]: "sol-high" });
    cfg.models.validate_tier = "terra-med";
    const { pass_plan } = buildPassPlan(cfg, SMALL);
    const sweeps = pass_plan.filter((p) => p.lens === SWEEP_PASS);
    expect(sweeps.length).toBeGreaterThan(0);
    for (const s of sweeps)
      expect(s).toMatchObject({
        agent: `${SWEEP_PASS}--sol-high`,
        tier: "sol-high",
        raisable_to: [],
      });
    expect(pass_plan.find((p) => p.lens === VALIDATE_PASS)!.tier).toBe("terra-med");
  });

  it("the validator runs at its own tier whatever a lens is pinned to", () => {
    for (const pin of ["sol-high", "terra-med"]) {
      const cfg = withPins({ "pass-baseline": pin });
      cfg.models.validate_tier = "sol-med";
      cfg.models.risk_passes = [];
      const { pass_plan } = buildPassPlan(cfg, LARGE);
      expect(pass_plan.find((p) => p.lens === VALIDATE_PASS)!.tier).toBe("sol-med");
    }
  });

  it("a profile min_tier still floors a pin; a pin is never a way past the floor", () => {
    const cfg = withPins({ "pass-baseline": "terra-med" });
    cfg.lenses = { "pass-baseline": { min_tier: "sol-med" } };
    const row = buildPassPlan(cfg, SMALL).pass_plan.find((p) => p.lens === "pass-baseline")!;
    expect(row).toMatchObject({ tier: "sol-med", raisable_to: [] });
  });

  it("a profile-switched-off validator stays off; skip/pin knobs never bring it back", () => {
    const cfg = withPins({ "pass-baseline": "sol-high" });
    cfg.review.skip_lenses = ["pass-abstraction"];
    cfg.lenses = { [VALIDATE_PASS]: { enabled: false } };
    const { pass_plan, addable_lenses } = buildPassPlan(cfg, SMALL);
    expect(pass_plan.map((p) => p.lens)).not.toContain(VALIDATE_PASS);
    expect(addable_lenses).not.toContain(VALIDATE_PASS);
  });

  it("a pinned lens keeps the profile's effort, at its pinned tier", () => {
    const tiers = {
      "terra-med": "prov/m:low",
      "sol-med": "prov/m:medium",
      "sol-high": "prov/m:high",
    } as const;
    const overrides = {
      "pass-baseline--terra-med": "prov/m:minimal",
      "pass-baseline--sol-med": "prov/m:minimal-med",
      "pass-baseline--sol-high": "prov/m:minimal-high",
      "pass-ui--sol-med": "prov/m:x",
    };
    const models = passTierModels({ "pass-baseline": "sol-high" }, tiers, overrides);
    for (const t of ["terra-med", "sol-med", "sol-high"])
      expect(models[`pass-baseline--${t}`]).toBe("prov/m:minimal-high");
    expect(models["pass-ui--sol-med"]).toBe("prov/m:x");
    expect(passTierModels({}, tiers, overrides)).toEqual(overrides);
  });

  it("parses from config, and refuses unknown passes, unknown tiers, the validator and risk passes", () => {
    const ok = parseConfig(
      fixture + `\n[models.pass_tiers]\n"pass-sweep" = "sol-high"\n"pass-baseline" = "sol-high"\n`,
    );
    expect(ok.models.pass_tiers).toEqual({
      ...DEFAULT_PASS_TIERS,
      "pass-sweep": "sol-high",
      "pass-baseline": "sol-high",
    });
    const bad = (body: string) => () => parseConfig(fixture + `\n[models.pass_tiers]\n${body}\n`);
    expect(bad(`"pass-swep" = "sol-high"`)).toThrow(/unknown pass "pass-swep"/);
    expect(bad(`"pass-sweep" = "sol-max"`)).toThrow(/unknown tier/);
    expect(bad(`"pass-validate" = "sol-high"`)).toThrow(/validate_tier/);
    expect(bad(`"pass-security" = "terra-med"`)).toThrow(/risk pass/);
  });

  it("an explicit preset/effort still sets the pinned tier's spec (pins name tiers, not specs)", () => {
    const text = fixture + `\n[models.pass_tiers]\n"pass-sweep" = "sol-high"\n`;
    const low = applyConfigOverrides(parseConfig(text), "review.preset=low", text);
    expect(low.models.pass_tiers).toEqual({ ...DEFAULT_PASS_TIERS, "pass-sweep": "sol-high" });
    expect(passTierModels(low.models.pass_tiers, low.models.tiers)["pass-sweep--terra-med"]).toBe(
      low.models.tiers["sol-high"],
    );
    expect(low.models.tiers["sol-high"].endsWith(":low")).toBe(true);
  });

  describe("in the built agents", () => {
    let out: string;
    beforeEach(() => {
      out = mkdtempSync(join(tmpdir(), "lens-knobs-"));
    });
    afterEach(() => rmSync(out, { recursive: true, force: true }));

    it("every variant of a pinned pass carries the pinned tier's spec; others are untouched", () => {
      const tiers = {
        "terra-med": "prov/m:low",
        "sol-med": "prov/m:medium",
        "sol-high": "prov/m:high",
      } as const;
      const models = passTierModels({ "pass-sweep": "sol-high" }, tiers);
      const built = buildAgents(join(ROOT, "agents"), out, {
        root: ROOT,
        tiers: { ...tiers },
        models,
      });
      for (const b of built.filter((x) => x.pass === "pass-sweep")) {
        expect(b.thinking).toBe("high");
        expect(readFileSync(b.output, "utf8")).toMatch(/^model: prov\/m:high$/m);
      }
      const baseline = built.find((x) => x.name === "pass-baseline--terra-med")!;
      expect(baseline.thinking).toBe("low");
      // the variant set itself is unchanged
      const plain = buildAgents(join(ROOT, "agents"), out, { root: ROOT, tiers: { ...tiers } });
      expect(built.map((b) => b.name)).toEqual(plain.map((b) => b.name));
    });
  });
});

// ---- [review] validate_consequence_rule ------------------------------------

describe("[review] validate_consequence_rule", () => {
  it("adds one pass-validate addendum only when enabled", () => {
    expect(configAddenda({}).map((a) => a.id)).not.toContain("validate-consequence-rule");
    expect(configAddenda(baseCfg.review).map((a) => a.id)).not.toContain(
      "validate-consequence-rule",
    );
    const on = configAddenda({ ...baseCfg.review, validate_consequence_rule: true });
    const rule = on.find((a) => a.id === "validate-consequence-rule")!;
    expect(rule.scope).toEqual([VALIDATE_PASS]);
    expect(rule.text).toMatch(/\[question\]/);
    expect(rule.text).toMatch(/demoted to `nit`/);
    expect(rule.text).toMatch(/lint rule the repo's CI enables/);
    expect(rule.text).toMatch(/one fix removes both/);
    // not a registry member: never in a default build
    expect(PASS_ADDENDA.map((a) => a.id)).not.toContain("validate-consequence-rule");
  });

  describe("in the built agents", () => {
    let out: string;
    beforeEach(() => {
      out = mkdtempSync(join(tmpdir(), "lens-knobs-"));
    });
    afterEach(() => rmSync(out, { recursive: true, force: true }));
    const validatorBody = (review: Config["review"]): string => {
      const built = buildAgents(join(ROOT, "agents"), out, {
        root: ROOT,
        addenda: [...PASS_ADDENDA, ...configAddenda(review)],
      });
      return readFileSync(built.find((b) => b.pass === VALIDATE_PASS)!.output, "utf8");
    };
    const HEADING = "## A confirmed mechanism is judged by its consequence";

    it("composes onto pass-validate only, and only when switched on", () => {
      expect(validatorBody(baseCfg.review)).not.toContain(HEADING);
      const on = { ...baseCfg.review, validate_consequence_rule: true };
      expect(validatorBody(on)).toContain(HEADING);
      const built = buildAgents(join(ROOT, "agents"), out, {
        root: ROOT,
        addenda: [...PASS_ADDENDA, ...configAddenda(on)],
      });
      for (const b of built.filter((x) => x.pass !== VALIDATE_PASS))
        expect(readFileSync(b.output, "utf8")).not.toContain(HEADING);
    });
  });

  it("parses, and refuses a non-boolean", () => {
    expect(
      parseConfig(tomlWith("review", "validate_consequence_rule = true\n")).review
        .validate_consequence_rule,
    ).toBe(true);
    expect(() => parseConfig(tomlWith("review", `validate_consequence_rule = "yes"\n`))).toThrow(
      /validate_consequence_rule/,
    );
  });
});

// ---- bench --config ----------------------------------------------------------

describe("bench --config: arrays, open maps, typos", () => {
  it("arrays take |-separated items and empty means []", () => {
    const cfg = applyConfigOverrides(
      baseCfg,
      "review.skip_lenses=pass-abstraction|pass-duplication,models.risk_passes=pass-security",
    );
    expect(cfg.review.skip_lenses).toEqual(["pass-abstraction", "pass-duplication"]);
    expect(cfg.models.risk_passes).toEqual(["pass-security"]);
    expect(applyConfigOverrides(cfg, "review.skip_lenses=").review.skip_lenses).toEqual([]);
    expect(() => applyConfigOverrides(baseCfg, "review.skip_lenses=pass-ui||pass-ui")).toThrow(
      /empty item/,
    );
  });

  it("array values are re-validated like the config file", () => {
    expect(() => applyConfigOverrides(baseCfg, "review.skip_lenses=pass-validate")).toThrow(
      /pass-validate/,
    );
    expect(() => applyConfigOverrides(baseCfg, "review.skip_lenses=pass-nope")).toThrow(
      /unknown pass/,
    );
  });

  it("an open map takes new keys; the values are validated", () => {
    const cfg = applyConfigOverrides(
      baseCfg,
      "models.pass_tiers.pass-sweep=sol-high,models.pass_tiers.pass-baseline=sol-high",
    );
    expect(cfg.models.pass_tiers).toEqual({
      ...DEFAULT_PASS_TIERS,
      "pass-sweep": "sol-high",
      "pass-baseline": "sol-high",
    });
    expect(baseCfg.models.pass_tiers).toEqual({ ...DEFAULT_PASS_TIERS });
    expect(() => applyConfigOverrides(baseCfg, "models.pass_tiers.pass-sweep=sol-max")).toThrow(
      /unknown tier/,
    );
    expect(() => applyConfigOverrides(baseCfg, "models.pass_tiers.pass-swep=sol-high")).toThrow(
      /unknown pass/,
    );
    expect(() => applyConfigOverrides(baseCfg, "models.pass_tiers=x")).toThrow(/is a table/);
  });

  it("every other map keeps the typo rule", () => {
    expect(() => applyConfigOverrides(baseCfg, "models.tiers.sol-hihg=x/y:high")).toThrow(/no key/);
    expect(() => applyConfigOverrides(baseCfg, "review.skip_lense=pass-ui")).toThrow(/no key/);
    expect(() => applyConfigOverrides(baseCfg, "models.pricing.gpt=1")).toThrow(/no key/);
    expect(() => applyConfigOverrides(baseCfg, "review.sweep_max_groups=many")).toThrow(/number/);
  });

  it("the fingerprint records every new knob", () => {
    const def = runFingerprint(baseCfg, "p");
    expect(def.levers).toMatchObject({ skip_lenses: [], validate_consequence_rule: false });
    expect(def.pass_tiers).toEqual({ ...DEFAULT_PASS_TIERS });
    expect(def.risk_passes).toEqual(baseCfg.models.risk_passes);
    const arm = runFingerprint(
      applyConfigOverrides(
        baseCfg,
        "review.skip_lenses=pass-abstraction,review.validate_consequence_rule=true,models.pass_tiers.pass-sweep=sol-high",
      ),
      "p",
    );
    expect(arm.levers).toMatchObject({
      skip_lenses: ["pass-abstraction"],
      validate_consequence_rule: true,
    });
    expect(arm.pass_tiers).toEqual({ ...DEFAULT_PASS_TIERS, "pass-sweep": "sol-high" });
  });
});

describe("validateLensKnobs", () => {
  it("passes the shipped configs", () => {
    for (const cfg of [baseCfg, example]) expect(() => validateLensKnobs(cfg)).not.toThrow();
  });
});

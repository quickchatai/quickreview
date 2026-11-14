// Per-lens cost knobs: `[review] skip_lenses`,
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
import { lensModelOverrides } from "@quickchatai/pi-quickreview/src/lenstuning.js";
import type { PrFileEntry } from "../src/github.js";
import {
  buildAgents,
  configAddenda,
  PASS_ADDENDA,
  passTierModels,
  VALIDATE_PASS,
} from "@quickchatai/pi-quickreview/src/include.js";
import { QUALITY_PASSES, SWEEP_PASS } from "@quickchatai/pi-quickreview/src/heuristics.js";
import { SECURITY_FAMILY } from "@quickchatai/pi-quickreview/src/passes.js";

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
/** A small diff (light), with enough code for the quality lenses and a sweep. */
const SMALL = [file("src/a.ts", 40), file("src/b.ts", 30)];
/** A large diff (standard). */
const LARGE = [file("src/a.ts", 200), file("src/b.ts", 100)];

const tomlWith = (section: string, lines: string): string =>
  fixture.replace(new RegExp(`^\\[${section.replace(".", "\\.")}\\]\\n`, "m"), (h) => h + lines);

// ---- defaults are the shipped review ---------------------------------------

describe("defaults reproduce today's review", () => {
  it("every config parses to no skips, the shipped pins, no consequence rule", () => {
    // The shipped pins (src/config.ts DEFAULT_PASS_TIERS):
    // baseline, sweep, behaviour-delta and the eight state-machine lenses at
    // deep; nothing else pinned. Written out, so a pin added or dropped has
    // to be named here.
    // MUTATION: drop the STATE_FAMILY spread from DEFAULT_PASS_TIERS — this
    // fails.
    for (const cfg of [baseCfg, example]) {
      expect(cfg.review.skip_lenses).toEqual([]);
      expect(cfg.review.validate_consequence_rule).toBe(false);
      expect(cfg.models.pass_tiers).toEqual({
        "pass-baseline": "deep",
        "pass-sweep": "deep",
        "pass-behaviour-delta": "deep",
        "pass-sm-states": "deep",
        "pass-sm-transitions": "deep",
        "pass-sm-exhaustive": "deep",
        "pass-sm-stuck": "deep",
        "pass-sm-events": "deep",
        "pass-sm-derived": "deep",
        "pass-sm-lifecycle": "deep",
        "pass-sm-durable": "deep",
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
    // pass_tiers is not a legacy-absent key: its default
    // carries the shipped pins (DEFAULT_PASS_TIERS), so a config without the
    // table still pins — exercised in the test below.
    for (const files of [SMALL, LARGE])
      expect(buildPassPlan(baseCfg, files)).toEqual(
        buildPassPlan(legacy as unknown as Config, files),
      );
  });

  it("the default config addenda and the default model map are unchanged", () => {
    // + the duplicate merge's validator rule, on by default (docs/duplicate-merge.md)
    // + the validator's decision-table answer, on by default
    expect(configAddenda(baseCfg.review).map((a) => a.id)).toEqual([
      "validate-demote-not-kill",
      "dedup-group-validate",
      "validate-compact-output",
    ]);
    // the shipped pins' variants carry the deep spec; no other lens is touched
    const pinned = passTierModels(baseCfg.models.pass_tiers, baseCfg.models.tiers);
    const expected: Record<string, string> = {};
    for (const lens of Object.keys(DEFAULT_PASS_TIERS))
      for (const t of ["light", "standard", "deep"] as const)
        expected[`${lens}--${t}`] = baseCfg.models.tiers["deep"];
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
    for (const t of ["light", "standard", "deep"] as const)
      expect(models[`pass-baseline--${t}`]?.endsWith(":medium")).toBe(true);
    // the other shipped pins keep deep's spec
    expect(models["pass-sweep--light"]).toBe(cfg.models.tiers["deep"]);
    expect(models["pass-behaviour-delta--light"]).toBe(cfg.models.tiers["deep"]);
    // an unpinned lens gets no variant override at all
    expect(models["pass-tests--standard"]).toBeUndefined();
  });

  it("a config with no [models.pass_tiers] table still gets the shipped pins; an entry replaces one", () => {
    expect(parseConfig(fixture).models.pass_tiers).toEqual({ ...DEFAULT_PASS_TIERS });
    const lowered = parseConfig(fixture + `\n[models.pass_tiers]\n"pass-baseline" = "standard"\n`);
    expect(lowered.models.pass_tiers).toEqual({
      ...DEFAULT_PASS_TIERS,
      "pass-baseline": "standard",
    });
    const row = buildPassPlan(lowered, LARGE).pass_plan.find((p) => p.lens === "pass-baseline")!;
    expect(row.tier).toBe("standard");
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
      const { pass_plan } = buildPassPlan(withPins({ "pass-baseline": "deep" }), files);
      const baseline = pass_plan.find((p) => p.lens === "pass-baseline")!;
      expect(baseline).toMatchObject({
        agent: "pass-baseline--deep",
        tier: "deep",
        raisable_to: [],
      });
    }
    // a pin may lower too: a large diff's lens held at light
    const low = buildPassPlan(withPins({ "pass-baseline": "light" }), LARGE).pass_plan;
    expect(low.find((p) => p.lens === "pass-baseline")!.agent).toBe("pass-baseline--light");
    // unpinned lenses keep the diff-size tier
    expect(low.find((p) => p.lens === "pass-tests")!.tier).toBe("standard");
  });

  it("pins every sweep row; the validator never follows it", () => {
    const cfg = withPins({ [SWEEP_PASS]: "deep" });
    cfg.models.validate_tier = "light";
    const { pass_plan } = buildPassPlan(cfg, SMALL);
    const sweeps = pass_plan.filter((p) => p.lens === SWEEP_PASS);
    expect(sweeps.length).toBeGreaterThan(0);
    for (const s of sweeps)
      expect(s).toMatchObject({
        agent: `${SWEEP_PASS}--deep`,
        tier: "deep",
        raisable_to: [],
      });
    expect(pass_plan.find((p) => p.lens === VALIDATE_PASS)!.tier).toBe("light");
  });

  it("the validator runs at its own tier whatever a lens is pinned to", () => {
    for (const pin of ["deep", "light"]) {
      const cfg = withPins({ "pass-baseline": pin });
      cfg.models.validate_tier = "standard";
      cfg.models.risk_passes = [];
      const { pass_plan } = buildPassPlan(cfg, LARGE);
      expect(pass_plan.find((p) => p.lens === VALIDATE_PASS)!.tier).toBe("standard");
    }
  });

  it("a profile min_tier still floors a pin; a pin is never a way past the floor", () => {
    const cfg = withPins({ "pass-baseline": "light" });
    cfg.lenses = { "pass-baseline": { min_tier: "standard" } };
    const row = buildPassPlan(cfg, SMALL).pass_plan.find((p) => p.lens === "pass-baseline")!;
    expect(row).toMatchObject({ tier: "standard", raisable_to: [] });
  });

  it("a profile-switched-off validator stays off; skip/pin knobs never bring it back", () => {
    const cfg = withPins({ "pass-baseline": "deep" });
    cfg.review.skip_lenses = ["pass-abstraction"];
    cfg.lenses = { [VALIDATE_PASS]: { enabled: false } };
    const { pass_plan, addable_lenses } = buildPassPlan(cfg, SMALL);
    expect(pass_plan.map((p) => p.lens)).not.toContain(VALIDATE_PASS);
    expect(addable_lenses).not.toContain(VALIDATE_PASS);
  });

  it("a pinned lens keeps the profile's effort, at its pinned tier", () => {
    const tiers = {
      light: "prov/m:low",
      standard: "prov/m:medium",
      deep: "prov/m:high",
    } as const;
    const overrides = {
      "pass-baseline--light": "prov/m:minimal",
      "pass-baseline--standard": "prov/m:minimal-med",
      "pass-baseline--deep": "prov/m:minimal-high",
      "pass-ui--standard": "prov/m:x",
    };
    const models = passTierModels({ "pass-baseline": "deep" }, tiers, overrides);
    for (const t of ["light", "standard", "deep"])
      expect(models[`pass-baseline--${t}`]).toBe("prov/m:minimal-high");
    expect(models["pass-ui--standard"]).toBe("prov/m:x");
    expect(passTierModels({}, tiers, overrides)).toEqual(overrides);
  });

  it("a profile min_tier floors a pin in the build as the plan floors it", () => {
    const cfg = withPins({ "pass-baseline": "light" });
    cfg.lenses = { "pass-baseline": { min_tier: "deep" } };
    const files = Array.from({ length: 3 }, (_, i) => file(`src/m${i}.py`, 40));
    const row = buildPassPlan(cfg, files).pass_plan.find((p) => p.lens === "pass-baseline")!;
    expect(row.agent).toBe("pass-baseline--deep");
    const models = passTierModels(cfg.models.pass_tiers, cfg.models.tiers, {}, {}, [], cfg.lenses);
    // the variant the plan names runs at the tier the plan records
    expect(models[row.agent]).toBe(cfg.models.tiers["deep"]);
    for (const t of ["light", "standard", "deep"])
      expect(models[`pass-baseline--${t}`]).toBe(cfg.models.tiers["deep"]);
    // a floor below the pin changes nothing
    const low = passTierModels(cfg.models.pass_tiers, cfg.models.tiers, {}, {}, [], {
      "pass-baseline": { min_tier: "light" },
    });
    expect(low["pass-baseline--deep"]).toBe(cfg.models.tiers["light"]);
  });

  it("parses from config, and refuses unknown passes, unknown tiers, the validator and risk passes", () => {
    const ok = parseConfig(
      fixture + `\n[models.pass_tiers]\n"pass-sweep" = "deep"\n"pass-baseline" = "deep"\n`,
    );
    expect(ok.models.pass_tiers).toEqual({
      ...DEFAULT_PASS_TIERS,
      "pass-sweep": "deep",
      "pass-baseline": "deep",
    });
    const bad = (body: string) => () => parseConfig(fixture + `\n[models.pass_tiers]\n${body}\n`);
    expect(bad(`"pass-swep" = "deep"`)).toThrow(/unknown pass "pass-swep"/);
    expect(bad(`"pass-sweep" = "sol-max"`)).toThrow(/unknown tier/);
    expect(bad(`"pass-validate" = "deep"`)).toThrow(/validate_tier/);
    expect(bad(`"pass-security" = "light"`)).toThrow(/risk pass/);
  });

  it("an explicit preset/effort still sets the pinned tier's spec (pins name tiers, not specs)", () => {
    const text = fixture + `\n[models.pass_tiers]\n"pass-sweep" = "deep"\n`;
    const low = applyConfigOverrides(parseConfig(text), "review.preset=low", text);
    expect(low.models.pass_tiers).toEqual({ ...DEFAULT_PASS_TIERS, "pass-sweep": "deep" });
    expect(passTierModels(low.models.pass_tiers, low.models.tiers)["pass-sweep--light"]).toBe(
      low.models.tiers["deep"],
    );
    expect(low.models.tiers["deep"].endsWith(":low")).toBe(true);
  });

  describe("in the built agents", () => {
    let out: string;
    beforeEach(() => {
      out = mkdtempSync(join(tmpdir(), "lens-knobs-"));
    });
    afterEach(() => rmSync(out, { recursive: true, force: true }));

    it("every variant of a pinned pass carries the pinned tier's spec; others are untouched", () => {
      const tiers = {
        light: "prov/m:low",
        standard: "prov/m:medium",
        deep: "prov/m:high",
      } as const;
      const models = passTierModels({ "pass-sweep": "deep" }, tiers);
      const built = buildAgents(join(ROOT, "agents"), out, {
        root: ROOT,
        tiers: { ...tiers },
        models,
      });
      for (const b of built.filter((x) => x.pass === "pass-sweep")) {
        expect(b.thinking).toBe("high");
        expect(readFileSync(b.output, "utf8")).toMatch(/^model: prov\/m:high$/m);
      }
      const baseline = built.find((x) => x.name === "pass-baseline--light")!;
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
    // The security family joins any risk list: a family lens always runs at
    // the risk tier, so the lever cannot drop it.
    expect(cfg.models.risk_passes).toEqual(["pass-security", ...SECURITY_FAMILY]);
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
      "models.pass_tiers.pass-sweep=deep,models.pass_tiers.pass-baseline=deep",
    );
    expect(cfg.models.pass_tiers).toEqual({
      ...DEFAULT_PASS_TIERS,
      "pass-sweep": "deep",
      "pass-baseline": "deep",
    });
    expect(baseCfg.models.pass_tiers).toEqual({ ...DEFAULT_PASS_TIERS });
    expect(() => applyConfigOverrides(baseCfg, "models.pass_tiers.pass-sweep=sol-max")).toThrow(
      /unknown tier/,
    );
    expect(() => applyConfigOverrides(baseCfg, "models.pass_tiers.pass-swep=deep")).toThrow(
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
        "review.skip_lenses=pass-abstraction,review.validate_consequence_rule=true,models.pass_tiers.pass-sweep=deep",
      ),
      "p",
    );
    expect(arm.levers).toMatchObject({
      skip_lenses: ["pass-abstraction"],
      validate_consequence_rule: true,
    });
    expect(arm.pass_tiers).toEqual({ ...DEFAULT_PASS_TIERS, "pass-sweep": "deep" });
  });

  // MUTATION: drop the `security` spread from runFingerprint (src/bench/runner.ts)
  // — the security-only arm fingerprints like the default, and this fails.
  it("the fingerprint records [security] only when it moves the review", () => {
    expect(runFingerprint(baseCfg, "p")).not.toHaveProperty("security");
    const only = runFingerprint(applyConfigOverrides(baseCfg, "security.only=true"), "p");
    expect(only.security).toEqual({ triggers: "strong", only: true, fold: false });
    // Who may ask for a review is not a review setting.
    expect(
      runFingerprint(applyConfigOverrides(baseCfg, "security.command=false"), "p"),
    ).not.toHaveProperty("security");
  });
});

describe("validateLensKnobs", () => {
  it("passes the shipped configs", () => {
    for (const cfg of [baseCfg, example]) expect(() => validateLensKnobs(cfg)).not.toThrow();
  });

  describe("[models.pass_models]: a lens's model is a model spec", () => {
    const moved = (spec: unknown) => () => {
      const cfg = structuredClone(baseCfg);
      cfg.models.pass_models = { "pass-style": spec as string };
      validateLensKnobs(cfg);
    };
    const refusal = (spec: unknown) =>
      `config.toml [models.pass_models] pass-style must be "provider/model" with an optional ":<thinking level>" (got ${JSON.stringify(spec)})`;

    // MUTATION: put the pattern `/^[\w.-]+\/[\w.:-]+$/` back in
    // validateLensKnobs — pi's ids with a second slash or an @ are refused and
    // this fails.
    it("takes any id pi has, with or without a level", () => {
      for (const id of [
        "prov/small",
        "openrouter/moonshotai/kimi-k2.6",
        "fireworks/accounts/fireworks/models/kimi-k3",
        "cloudflare-workers-ai/@cf/meta/llama-4",
      ]) {
        expect(moved(id)).not.toThrow();
        expect(moved(`${id}:low`)).not.toThrow();
      }
    });

    it("refuses what names no provider's model, in the words every model key uses", () => {
      for (const spec of ["small", "small:low", "prov/", "/small", "", 7, null])
        expect(moved(spec)).toThrow(refusal(spec));
    });

    // What `stripPins` leaves of an override when a run names its one model:
    // the level stays, on the model the lens would have run on.
    // MUTATION: in passTierModels, write the override's own model part even
    // when it is empty (`const on = model`) — the lens leaves its tier's
    // model for `:low` and the pinned cases fail.
    it("takes a level with no model, and the lens stays on the model it had", () => {
      expect(moved(":low")).not.toThrow();
      const tiers = { light: "prov/a:medium", standard: "prov/b", deep: ":high" } as const;
      const level = { "pass-style": ":low" };
      // Each variant's own tier: its model, pinned or not, at the override's level.
      expect(passTierModels({}, tiers, {}, level)).toEqual({
        "pass-style--light": "prov/a:low",
        "pass-style--standard": "prov/b:low",
        "pass-style--deep": ":low",
      });
      // A pinned lens: the pinned tier's model on every variant.
      expect(passTierModels({ "pass-style": "light" }, tiers, {}, level)).toEqual({
        "pass-style--light": "prov/a:low",
        "pass-style--standard": "prov/a:low",
        "pass-style--deep": "prov/a:low",
      });
      // A profile's effort override: its model, at the level the config names.
      expect(
        passTierModels({}, tiers, { "pass-style--deep": "prov/c:xhigh" }, level)[
          "pass-style--deep"
        ],
      ).toBe("prov/c:low");
      // The shipped tiers pin: the lens keeps the deep tier's model.
      const deep = baseCfg.models.tiers["deep"];
      expect(deep).toMatch(/^[^:]+\/[^:]+:/);
      expect(passTierModels({}, baseCfg.models.tiers, {}, level)["pass-style--deep"]).toBe(
        deep.replace(/:[^:]+$/, ":low"),
      );
    });

    it("an override that names a model moves the lens as before", () => {
      const tiers = { light: "prov/a:medium", standard: "prov/b", deep: ":high" } as const;
      expect(passTierModels({}, tiers, {}, { "pass-style": "prov/small" })).toEqual({
        "pass-style--light": "prov/small:medium",
        "pass-style--standard": "prov/small",
        "pass-style--deep": "prov/small:high",
      });
      expect(passTierModels({}, tiers, {}, { "pass-style": "prov/small:low" })).toEqual({
        "pass-style--light": "prov/small:low",
        "pass-style--standard": "prov/small:low",
        "pass-style--deep": "prov/small:low",
      });
    });

    it("the same refusal reaches a --config lever", () => {
      expect(() => applyConfigOverrides(baseCfg, "models.pass_models.pass-style=small")).toThrow(
        refusal("small"),
      );
      expect(
        applyConfigOverrides(
          baseCfg,
          "models.pass_models.pass-style=openrouter/moonshotai/kimi-k2.6:low",
        ).models.pass_models,
      ).toEqual({ "pass-style": "openrouter/moonshotai/kimi-k2.6:low" });
    });
  });
});

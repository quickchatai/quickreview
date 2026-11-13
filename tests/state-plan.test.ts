// The state-machine family in the plan (packages/pi-plugin/src/planner.ts):
// which pass-sm-* rows a round plans and why, what a request and
// `plan = "always"` add (and never add), when the family is offered as
// addable, and what a state-machine-only review does to a follow-up. Every
// case asserts on what the planner hands its consumers — rows, reasons, the
// addable list — never on its internals.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig, type Config } from "../src/config.js";
import type { PrFileEntry } from "@quickchatai/pi-quickreview/src/githubcore.js";
import { DJANGO_ECOSYSTEM } from "@quickchatai/pi-quickreview/src/ecosystem.js";
import { VALIDATE_PASS } from "@quickchatai/pi-quickreview/src/include.js";
import type { LensTuning } from "@quickchatai/pi-quickreview/src/lenstuning.js";
import { SECURITY_FAMILY, STATE_FAMILY } from "@quickchatai/pi-quickreview/src/passes.js";
import {
  buildPassPlan,
  type PassPlan,
  type PlanSecurityInputs,
} from "@quickchatai/pi-quickreview/src/planner.js";
import { applyProfileStateMachines } from "@quickchatai/pi-quickreview/src/profiles.js";
import { STATE_MACHINES_DEFAULTS } from "@quickchatai/pi-quickreview/src/reviewconfig.js";
import type { StateRequest } from "@quickchatai/pi-quickreview/src/types.js";

const fixture: Config = parseConfig(
  readFileSync(resolve(process.cwd(), "tests/fixtures/config.toml"), "utf8"),
);

const tuned = (lenses: Record<string, LensTuning>, base: Config = fixture): Config => ({
  ...base,
  lenses: { ...base.lenses, ...lenses },
});
const withTriggers = (triggers: "off" | "strong" | "all", base: Config = fixture): Config => ({
  ...base,
  state_machines: { ...base.state_machines, triggers },
});
/** The fixture as a state-machine-only review resolves it. */
const stateOnly = (lenses: Record<string, LensTuning> = {}): Config =>
  applyProfileStateMachines(tuned(lenses), { only: true });

const changed = (filename: string, lines: string[], sign: "+" | "-" = "+"): PrFileEntry => ({
  filename,
  additions: sign === "+" ? lines.length : 0,
  deletions: sign === "-" ? lines.length : 0,
  status: "modified",
  patch: [
    `@@ -1,${lines.length + 1} +1,${lines.length + 1} @@`,
    " context",
    ...lines.map((l) => `${sign}${l}`),
  ].join("\n"),
});

/** A check of the current state taken away: a strong transitions trigger. */
const GUARD_GONE = changed("src/order.ts", ["  if (order.status !== 'pending') return;"], "-");
/** A state write: a weak transitions trigger. */
const WRITE = changed("src/order.ts", ["order.status = next;"]);
/** Code with no state in it. */
const PLAIN = changed("src/math.ts", ["export const add = (a: number, b: number) => a + b;"]);
const DOCS: PrFileEntry = { ...changed("README.md", ["words"]), filename: "README.md" };

const plan = (cfg: Config, files: PrFileEntry[], opts: PlanSecurityInputs = {}): PassPlan =>
  buildPassPlan(cfg, files, { title: "t", body: "" }, DJANGO_ECOSYSTEM, undefined, [], [], opts);
const family = (p: PassPlan): string[] =>
  p.pass_plan.map((r) => r.lens).filter((l) => STATE_FAMILY.includes(l));
const row = (p: PassPlan, lens: string) => p.pass_plan.find((r) => r.lens === lens);

const OPERATOR: StateRequest = { by: "", source: "operator" };

describe("the default profile", () => {
  it("ships with strong triggers, not only, and its own label", () => {
    expect(fixture.state_machines).toEqual(STATE_MACHINES_DEFAULTS);
  });

  // MUTATION: drop `...stateFamily` from the planner's lens union — this
  // fails (the triggered lens never reaches the plan).
  it("plans the lens a strong trigger fires, with the trigger as its reason", () => {
    const p = plan(fixture, [GUARD_GONE]);
    expect(family(p)).toEqual(["pass-sm-transitions"]);
    expect(row(p, "pass-sm-transitions")!.why).toContain("a check of the current state is removed");
    expect(row(p, "pass-sm-transitions")!.why).toContain("src/order.ts");
    // Not a required row: a family row that fails never requeues the round.
    expect(row(p, "pass-sm-transitions")!.required).toBeUndefined();
    // The rest of the plan is what it was.
    expect(p.pass_plan[0]!.lens).toBe("pass-baseline");
    expect(p.pass_plan.at(-1)!.lens).toBe(VALIDATE_PASS);
  });

  it("plans nothing for a weak signal or for plain code", () => {
    expect(family(plan(fixture, [WRITE]))).toEqual([]);
    expect(family(plan(fixture, [PLAIN]))).toEqual([]);
  });

  // MUTATION: pass a fixed "strong" to selectStateLenses instead of the
  // configured mode — the first and last expectations fail.
  it("`triggers` moves it: all plans the weak signal, off plans not even the strong one", () => {
    expect(family(plan(withTriggers("all"), [WRITE]))).toEqual(["pass-sm-transitions"]);
    expect(family(plan(withTriggers("off"), [GUARD_GONE]))).toEqual([]);
  });

  // A family row runs at deep on a small quiet diff, where the round's own
  // tier is light: the shipped pins hold it there.
  // MUTATION: drop the STATE_FAMILY spread from DEFAULT_PASS_TIERS
  // (reviewconfig.ts) — the row falls back to the round's light tier,
  // raisable, and this fails.
  it("runs a family row at deep, not raisable, where the round's own tier is light", () => {
    const unpinned: Config = { ...fixture, models: { ...fixture.models, pass_tiers: {} } };
    expect(row(plan(unpinned, [GUARD_GONE]), "pass-sm-transitions")!.tier, "control").toBe("light");
    const r = row(plan(fixture, [GUARD_GONE]), "pass-sm-transitions")!;
    expect(r.tier).toBe("deep");
    expect(r.agent).toBe("pass-sm-transitions--deep");
    expect(r.raisable_to).toEqual([]);
    // A pin, not a risk pass: a failed row never requeues the round.
    expect(r.required).toBeUndefined();
  });
});

describe("the family's tier", () => {
  /** The family rows not pinned at deep: off the tier, on another
   * variant, or with a tier to raise to. */
  const offDeep = (p: PassPlan): string[] =>
    p.pass_plan
      .filter((r) => STATE_FAMILY.includes(r.lens))
      .filter((r) => r.tier !== "deep" || r.agent !== `${r.lens}--deep` || r.raisable_to.length)
      .map((r) => r.lens);

  // MUTATION: drop the STATE_FAMILY spread from DEFAULT_PASS_TIERS — every
  // row of the request falls back to light, and this fails.
  it("is deep on every row a request plans", () => {
    const p = plan(fixture, [PLAIN], { stateRequest: OPERATOR });
    expect(family(p).sort()).toEqual([...STATE_FAMILY].sort());
    expect(offDeep(p)).toEqual([]);
  });

  // MUTATION: drop the STATE_FAMILY spread from DEFAULT_PASS_TIERS — the
  // `always` rows of a state-machine-only review fall back to light, and
  // this fails.
  it("is deep on every row a state-machine-only review plans, `always` rows included", () => {
    const cfg = withTriggers(
      "all",
      stateOnly({ "pass-sm-stuck": { plan: "always" }, "pass-sm-durable": { plan: "always" } }),
    );
    const p = plan(cfg, [PLAIN]);
    expect(family(p)).toEqual(expect.arrayContaining(["pass-sm-stuck", "pass-sm-durable"]));
    expect(offDeep(p)).toEqual([]);
  });

  // The pins are defaults, not a floor: a config entry lowers one lens, and
  // leaves the others at deep.
  // MUTATION: swap the spread in parseModels (reviewconfig.ts) to
  // `{ ...parsePassTiers(raw.pass_tiers), ...DEFAULT_PASS_TIERS }`, so the
  // default wins — this fails.
  it("a [models.pass_tiers] entry lowers one lens, and only that one", () => {
    const toml = readFileSync(resolve(process.cwd(), "tests/fixtures/config.toml"), "utf8");
    const lowered = parseConfig(`${toml}\n[models.pass_tiers]\n"pass-sm-stuck" = "standard"\n`);
    const p = plan(lowered, [PLAIN], { stateRequest: OPERATOR });
    const stuck = row(p, "pass-sm-stuck")!;
    expect(stuck.tier).toBe("standard");
    expect(stuck.agent).toBe("pass-sm-stuck--standard");
    expect(offDeep(p)).toEqual(["pass-sm-stuck"]);
  });
});

describe("a request", () => {
  // MUTATION: drop the `opts.stateRequest !== undefined` clause from the
  // family filter — this fails (a request plans only what triggered).
  it("plans the whole family on a change with no state signal, saying who asked", () => {
    const p = plan(fixture, [PLAIN], { stateRequest: { by: "maya-dev", source: "comment" } });
    expect(family(p).sort()).toEqual([...STATE_FAMILY].sort());
    expect(row(p, "pass-sm-stuck")!.why).toBe(
      "a state-machine review was requested by @maya-dev in a PR comment",
    );
    // On top of the plan, never in place of it.
    expect(row(p, "pass-baseline")).toBeDefined();
    // And it plans no security lens.
    expect(p.pass_plan.some((r) => SECURITY_FAMILY.includes(r.lens))).toBe(false);
  });

  it("names the role when the asker is not known, and keeps a trigger's reason where one fired", () => {
    const p = plan(fixture, [GUARD_GONE], { stateRequest: OPERATOR });
    expect(row(p, "pass-sm-stuck")!.why).toBe(
      "a state-machine review was requested as the operator",
    );
    expect(row(p, "pass-sm-transitions")!.why).toContain("a check of the current state is removed");
  });

  // A request is a selection like any other: the operator's off switches win.
  it("never plans a lens the profile switched off or the config skips", () => {
    const off = plan(tuned({ "pass-sm-events": { enabled: false } }), [PLAIN], {
      stateRequest: OPERATOR,
    });
    expect(family(off)).not.toContain("pass-sm-events");
    expect(off.addable_lenses).not.toContain("pass-sm-events");
    const skipped = plan(
      { ...fixture, review: { ...fixture.review, skip_lenses: ["pass-sm-derived"] } },
      [PLAIN],
      { stateRequest: OPERATOR },
    );
    expect(family(skipped)).not.toContain("pass-sm-derived");
  });
});

describe('plan = "always"', () => {
  it("plans a family lens on every change to code, and on no docs-only change", () => {
    const cfg = tuned({ "pass-sm-stuck": { plan: "always" } });
    expect(family(plan(cfg, [PLAIN]))).toEqual(["pass-sm-stuck"]);
    expect(row(plan(cfg, [PLAIN]), "pass-sm-stuck")!.why).toContain('plan = "always"');
    expect(family(plan(cfg, [DOCS]))).toEqual([]);
  });
});

describe("the addable list", () => {
  // MUTATION: drop the `stateRound ||` gate from addable_lenses — the first
  // expectation fails (every round is offered eight more lenses).
  it("offers the family only to a round already doing state-machine work", () => {
    const quiet = plan(fixture, [PLAIN]);
    for (const lens of STATE_FAMILY) expect(quiet.addable_lenses, lens).not.toContain(lens);
    const triggered = plan(fixture, [GUARD_GONE]);
    expect(triggered.addable_lenses).toContain("pass-sm-stuck");
    expect(triggered.addable_lenses).not.toContain("pass-sm-transitions");
  });

  it("a state-machine round is offered no security lens, and the reverse", () => {
    const p = plan(fixture, [GUARD_GONE]);
    for (const lens of SECURITY_FAMILY) expect(p.addable_lenses, lens).not.toContain(lens);
  });
});

describe("a state-machine-only review", () => {
  // MUTATION: make applyProfileStateMachines ignore `only` — baseline stays
  // in the plan and this fails.
  it("plans the family and the validator, and nothing else", () => {
    const cfg = withTriggers("all", stateOnly({ "pass-sm-stuck": { plan: "always" } }));
    const p = plan(cfg, [WRITE]);
    const lenses = p.pass_plan.map((r) => r.lens);
    expect(lenses.at(-1)).toBe(VALIDATE_PASS);
    for (const lens of lenses.slice(0, -1)) expect(STATE_FAMILY, lens).toContain(lens);
    expect(lenses).toContain("pass-sm-transitions");
    expect(lenses).toContain("pass-sm-stuck");
    // Nothing outside the family is addable either.
    for (const lens of p.addable_lenses) expect(STATE_FAMILY, lens).toContain(lens);
    expect(p.addable_lenses.length).toBeGreaterThan(0);
  });

  it("with nothing to read plans the validator alone", () => {
    const p = plan(stateOnly(), [DOCS]);
    expect(p.pass_plan.map((r) => r.lens)).toEqual([VALIDATE_PASS]);
  });
});


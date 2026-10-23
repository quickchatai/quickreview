// The validator tier, checked post-hoc against the passes that actually ran
// (`rounds.executed_passes`) as well as at plan time.
//
// The validator is optional (a profile may switch it off), it is not raised
// to match any lens, and its validity veto is a mark — the finding is kept as
// `doubted`, never posted, shown in the TUI — not a deletion. A lens hotter
// than the validator is therefore not a breach: the cheaper model can doubt
// the stronger one's finding but cannot make it vanish. What the fence pins:
//
//   1. PLAN time — the validator runs at its own tier (`validatorTier(cfg)`),
//      whatever the lenses run at, and it is last or absent;
//   2. POST-HOC — the validator that RAN never ran BELOW the tier the round
//      fixed (the session may raise nothing on a pinned row, and may never
//      lower one), and a round with no validator (null tier, no entry) is not
//      a violation.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig, type Config } from "../src/config.js";
import { buildPassPlan, validatorTier } from "../src/dispatch.js";
import type { PrFileEntry } from "../src/github.js";
import { StateStore } from "../src/state.js";
import {
  PASS_TIER_ORDER,
  type PassTier,
  type VerdictPassEntry,
} from "@quickchatai/pi-quickreview/src/types.js";

const tierIndex = (t: string | null | undefined): number => PASS_TIER_ORDER.indexOf(t as PassTier);

/**
 * The post-hoc property, as a pure function over one round's telemetry, so it
 * can be applied to a live database as easily as to the fixtures below.
 *
 * Returns the validator entries that ran BELOW the round's fixed tier.
 * Unknowns are not violations: a null tier on either side means the round
 * predates the field, had no validator, or the session reported none — and
 * unknown is never read as a breach, the same rule the receipt path follows.
 */
export function validatorBelowFloor(
  validateTier: string | null,
  executed: readonly VerdictPassEntry[] | null,
): VerdictPassEntry[] {
  if (validateTier === null || executed === null) return [];
  const floor = tierIndex(validateTier);
  if (floor < 0) return [];
  return executed.filter((p) => {
    if (p.name !== "pass-validate") return false;
    const t = tierIndex(p.tier);
    return t >= 0 && t < floor;
  });
}

const cfg: Config = parseConfig(
  readFileSync(resolve(process.cwd(), "tests/fixtures/config.toml"), "utf8"),
);
const file = (filename: string, additions: number): PrFileEntry => ({
  filename,
  additions,
  deletions: 0,
  status: "modified",
});

describe("[#22] the validator tier", () => {
  /**
   * MUTATION: fold the lens tiers into the validator's
   * (`lensTiers.reduce(higherTier, floor)`) — the risk and big-diff plans below
   * start running the validator at sol-high/sol-med and this fails.
   */
  it("plan time: the validator runs at its own tier, never raised by a hotter lens", () => {
    const low: Config = { ...cfg, models: { ...cfg.models, validate_tier: "terra-med" } };
    for (const files of [
      [file("README.md", 3)],
      [file("app/service.py", 400)],
      [file("auth/permissions.py", 10)],
    ]) {
      const { pass_plan } = buildPassPlan(low, files);
      const validate = pass_plan.at(-1)!;
      expect(validate.lens).toBe("pass-validate");
      expect(validate.tier).toBe("terra-med");
      expect(validate.tier).toBe(validatorTier(low));
      expect(validate.raisable_to).toEqual([]);
    }
    const risky = buildPassPlan(low, [file("auth/permissions.py", 10)]).pass_plan;
    expect(risky.some((p) => tierIndex(p.tier) > tierIndex("terra-med"))).toBe(true);
  });

  it("the property itself is sound — it catches a validator run below the floor", () => {
    const executed: VerdictPassEntry[] = [
      { name: "pass-baseline", tier: "sol-high" },
      { name: "pass-validate", tier: "terra-med" },
    ];
    expect(validatorBelowFloor("sol-med", executed).map((p) => p.name)).toEqual(["pass-validate"]);
    expect(validatorBelowFloor("terra-med", executed)).toEqual([]);
  });

  it("a lens hotter than the validator is NOT a breach any more", () => {
    expect(
      validatorBelowFloor("terra-med", [
        { name: "pass-security", tier: "sol-high" },
        { name: "pass-validate", tier: "terra-med" },
      ]),
    ).toEqual([]);
  });

  it("unknowns and a round with no validator are never breaches", () => {
    expect(validatorBelowFloor(null, [{ name: "pass-validate", tier: "terra-med" }])).toEqual([]);
    expect(validatorBelowFloor("sol-high", null)).toEqual([]);
    expect(validatorBelowFloor("sol-high", [{ name: "pass-validate", tier: null }])).toEqual([]);
    expect(validatorBelowFloor("sol-high", [{ name: "pass-validate", tier: "nonsense" }])).toEqual(
      [],
    );
    expect(validatorBelowFloor(null, [{ name: "pass-baseline", tier: "sol-high" }])).toEqual([]);
  });

  /**
   * The end-to-end shape, read off a real rounds table: the query an operator
   * would run against the live database.
   *
   * MUTATION: change `t < floor` to `t <= floor` — the at-the-floor round below
   * starts failing, the false-positive direction.
   */
  it("reads the property off a real rounds table", () => {
    const store = new StateStore(":memory:");
    store.upsertPr({
      number: 42,
      state: "reviewing",
      head_sha: "aa11",
      title: "t",
      author: "alice",
      trigger_ts: null,
      stale_recheck: 0,
      migration_gate: 0,
    });

    const round = (validate: string | null, executed: VerdictPassEntry[]): number => {
      const id = store.startRound(42, "first", ["pass-baseline"], 75, { validate_tier: validate });
      store.recordExecutedPasses(id, executed);
      return id;
    };

    const ok = round("sol-med", [
      { name: "pass-baseline", tier: "sol-high" },
      { name: "pass-validate", tier: "sol-med" },
    ]);
    const off = round(null, [{ name: "pass-baseline", tier: "sol-med" }]);
    const bad = round("sol-high", [
      { name: "pass-baseline", tier: "sol-med" },
      { name: "pass-validate", tier: "sol-med" },
    ]);

    const check = (id: number) => {
      const r = store.db
        .prepare("SELECT validate_tier, executed_passes FROM rounds WHERE id = ?")
        .get(id) as {
        validate_tier: string | null;
        executed_passes: string | null;
      };
      return validatorBelowFloor(
        r.validate_tier,
        r.executed_passes === null ? null : (JSON.parse(r.executed_passes) as VerdictPassEntry[]),
      );
    };

    expect(check(ok), "a hotter lens beside a validator at its floor is compliant").toEqual([]);
    expect(check(off), "a round the profile ran without a validator is compliant").toEqual([]);
    expect(
      check(bad).map((p) => p.name),
      "a validator run below the tier the round fixed is the violation",
    ).toEqual(["pass-validate"]);
    store.close();
  });
});

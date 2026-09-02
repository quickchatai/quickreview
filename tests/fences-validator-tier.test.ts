// audit assertion #22: the validator floor, checked POST-HOC against
// the passes that actually RAN.
//
// The ratified decision is "the validator is never cheaper than the findings it
// vetoes". `validatorTier` implements it at PLAN time, and `tests/dispatch.ts`
// pins that. The audit's note at MC-L34 is that plan time is not the whole
// story: a lens can be added mid-round through the add protocol, or raised, so
// the property that matters is about the passes the session ran — and nothing
// asserted it.
//
// The audit listed this under "would require new code first". It does not:
// `rounds.validate_tier` (the floor the round fixed) and
// `rounds.executed_passes` (telemetry — the passes the session
// reported running, each with its `tier`) have both existed, and
// `PASS_TIER_ORDER` is the comparison. So it is written here rather than
// declined — and it is written expecting to find something, which is the
// situation the recorded-divergence pattern exists for.
import { describe, expect, it } from "vitest";
import { StateStore } from "../src/state.js";
import { PASS_TIER_ORDER, type PassTier, type VerdictPassEntry } from "../src/types.js";

const tierIndex = (t: string | null | undefined): number => PASS_TIER_ORDER.indexOf(t as PassTier);

/**
 * The property, as a pure function over one round's telemetry, so it can be
 * applied to a live database as easily as to the fixtures below.
 *
 * Returns the passes that ran ABOVE the validator's floor. Unknowns are not
 * violations: a null tier on either side means the round predates the field or
 * the session reported none, and unknown is never read as a breach — the same
 * rule the receipt path follows.
 */
export function passesAboveValidator(
  validateTier: string | null,
  executed: readonly VerdictPassEntry[] | null,
): VerdictPassEntry[] {
  if (validateTier === null || executed === null) return [];
  const floor = tierIndex(validateTier);
  if (floor < 0) return [];
  return executed.filter((p) => {
    if (p.name === "pass-validate") return false;
    const t = tierIndex(p.tier);
    return t >= 0 && t > floor;
  });
}

describe("[#22] the validator floor holds against the passes that RAN", () => {
  it("the property itself is sound — it catches a raise above the floor", () => {
    const executed: VerdictPassEntry[] = [
      { name: "pass-baseline", tier: "sol-high" },
      { name: "pass-validate", tier: "sol-med" },
    ];
    expect(passesAboveValidator("sol-med", executed).map((p) => p.name)).toEqual(["pass-baseline"]);
    expect(passesAboveValidator("sol-high", executed)).toEqual([]);
  });

  it("unknowns are never breaches — a null tier on either side is not a violation", () => {
    expect(passesAboveValidator(null, [{ name: "pass-baseline", tier: "sol-high" }])).toEqual([]);
    expect(passesAboveValidator("terra-med", null)).toEqual([]);
    expect(passesAboveValidator("terra-med", [{ name: "pass-baseline", tier: null }])).toEqual([]);
    expect(passesAboveValidator("terra-med", [{ name: "pass-baseline", tier: "nonsense" }])).toEqual([]);
  });

  it("the validator's own entry never counts against its own floor", () => {
    expect(passesAboveValidator("terra-med", [{ name: "pass-validate", tier: "sol-high" }])).toEqual([]);
  });

  /**
   * The end-to-end shape: a round whose telemetry says a lens ran hotter than
   * the validator that vetoed it is a violation, and this is the query an
   * operator would run against the live database.
   *
   * MUTATION: change `> floor` to `>= floor` in `passesAboveValidator` — the
   * equal-tier round below starts failing, which is the false-positive
   * direction and exactly what the ratified decision does NOT say (the floor
   * is "never cheaper", not "always hotter").
   */
  it("reads the property off a real rounds table", () => {
    const store = new StateStore(":memory:");
    store.upsertPr({
      number: 42, state: "reviewing", head_sha: "aa11", title: "t", author: "alice",
      trigger_ts: null, stale_recheck: 0, migration_gate: 0,
    });

    const round = (validate: string, executed: VerdictPassEntry[]): number => {
      const id = store.startRound(42, "first", ["pass-baseline"], 75, { validate_tier: validate });
      store.recordExecutedPasses(id, executed);
      return id;
    };

    const ok = round("sol-med", [
      { name: "pass-baseline", tier: "sol-med" },
      { name: "pass-validate", tier: "sol-med" },
    ]);
    const bad = round("terra-med", [
      { name: "pass-baseline", tier: "sol-high" },
      { name: "pass-validate", tier: "terra-med" },
    ]);

    const check = (id: number) => {
      const r = store.db.prepare("SELECT validate_tier, executed_passes FROM rounds WHERE id = ?").get(id) as {
        validate_tier: string | null;
        executed_passes: string | null;
      };
      return passesAboveValidator(
        r.validate_tier,
        r.executed_passes === null ? null : (JSON.parse(r.executed_passes) as VerdictPassEntry[]),
      );
    };

    expect(check(ok), "a round whose lenses ran at the floor is compliant").toEqual([]);
    expect(check(bad).map((p) => p.name), "a lens hotter than the validator that vetoed it is the violation").toEqual([
      "pass-baseline",
    ]);
    store.close();
  });
});

// The round stage bounds a large plan gets: the configured bounds hold for a
// typical plan, and a plan above LARGE_PLAN_ROWS discovery rows earns a
// minute per row, capped. The follow-up sweep's allowance and the large-plan
// one do not stack, so the hard cap stays inside the round deadline.
import { describe, expect, it } from "vitest";
import {
  LARGE_PLAN_EXTRA_MAX_MIN,
  discoveryRowsOf,
  roundStageAllowanceMin,
  roundStageDeadlines,
} from "@quickchatai/pi-quickreview/src/round-stage-deadlines.js";

const BOUNDS = {
  first_pass_max_min: 5,
  passes_max_min: 35,
  running_max_min: 45,
  follow_up_sweep_extra_min: 20,
};
const T0 = Date.parse("2026-10-29T10:00:00.000Z");
const minutes = (at: number): number => (at - T0) / 60_000;
const stages = (rows: number, sweepOwed = false) => {
  const d = roundStageDeadlines(T0, BOUNDS, sweepOwed, rows);
  return [minutes(d.first_pass_start), minutes(d.passes_complete), minutes(d.running_hard_bound)];
};

describe("round stage deadlines scale with the plan", () => {
  // MUTATION: make largePlanExtraMin return 0 — this fails.
  it("a typical plan keeps the configured bounds; a large one earns a minute per row over 20, capped", () => {
    expect(stages(10)).toEqual([5, 35, 45]);
    expect(stages(20)).toEqual([5, 35, 45]);
    expect(stages(29)).toEqual([5, 44, 54]);
    expect(stages(35)).toEqual([5, 50, 60]);
    expect(stages(80)).toEqual([5, 35 + LARGE_PLAN_EXTRA_MAX_MIN, 45 + LARGE_PLAN_EXTRA_MAX_MIN]);
  });

  // MUTATION: sum the two allowances in roundStageAllowanceMin — this fails.
  it("the sweep allowance and the large-plan allowance do not stack", () => {
    expect(stages(10, true)).toEqual([5, 55, 65]);
    expect(stages(35, true)).toEqual([5, 55, 65]);
    expect(roundStageAllowanceMin({ sweepOwed: true, sweepExtraMin: 5, discoveryRows: 35 })).toBe(
      15,
    );
  });

  it("an unknown plan size changes nothing", () => {
    expect(minutes(roundStageDeadlines(T0, BOUNDS, false).passes_complete)).toBe(35);
  });

  it("discovery rows: the plan's rows without the validator, split rows counted, else the lens list", () => {
    const plan = JSON.stringify([
      { lens: "pass-baseline" },
      { lens: "pass-baseline" },
      { lens: "pass-tests" },
      { lens: "pass-validate" },
    ]);
    expect(discoveryRowsOf({ pass_plan: plan, lenses: "ignored" })).toBe(3);
    expect(
      discoveryRowsOf({ pass_plan: null, lenses: "pass-baseline,pass-tests,pass-validate" }),
    ).toBe(2);
    expect(discoveryRowsOf({ pass_plan: "{not json", lenses: "pass-baseline" })).toBe(1);
  });
});

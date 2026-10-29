/** A plan up to this many discovery rows runs inside the configured bounds:
 * measured live rounds of 20 rows or fewer finished in under 19 minutes. */
export const LARGE_PLAN_ROWS = 20;
/** Each discovery row past LARGE_PLAN_ROWS earns this much more passes and
 * running time: a 36-row plan took 27 minutes with nothing retried. */
export const LARGE_PLAN_MIN_PER_ROW = 1;
/** The most a large plan earns, so the hard cap (45 + 20) stays inside the
 * 75-minute round deadline. */
export const LARGE_PLAN_EXTRA_MAX_MIN = 20;

/** Extra passes and running minutes a plan of `discoveryRows` rows earns. */
export function largePlanExtraMin(discoveryRows: number): number {
  const over = Math.max(0, discoveryRows - LARGE_PLAN_ROWS);
  return Math.min(over * LARGE_PLAN_MIN_PER_ROW, LARGE_PLAN_EXTRA_MAX_MIN);
}

/** The minutes a round's passes and running bounds get over the configured
 * ones: the follow-up sweep's allowance or the large plan's, whichever is
 * larger. They do not stack: the hard cap stays inside the round deadline. */
export function roundStageAllowanceMin(o: {
  sweepOwed: boolean;
  sweepExtraMin: number;
  discoveryRows?: number;
}): number {
  return Math.max(
    o.sweepOwed ? o.sweepExtraMin : 0,
    o.discoveryRows === undefined ? 0 : largePlanExtraMin(o.discoveryRows),
  );
}

/** The discovery rows of a round's plan: its `pass_plan` rows (a split lens
 * counts once per row) without the validator, else its lens list. */
export function discoveryRowsOf(round: { pass_plan: string | null; lenses: string }): number {
  if (round.pass_plan) {
    try {
      const rows: unknown = JSON.parse(round.pass_plan);
      if (Array.isArray(rows))
        return rows.filter((row) => (row as { lens?: unknown } | null)?.lens !== "pass-validate")
          .length;
    } catch {
      // An unreadable plan falls back to the lens list.
    }
  }
  return round.lenses
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "" && name !== "pass-validate").length;
}

/** Start-derived round deadlines, shared by enforcement and status publication. */
export function roundStageDeadlines(
  started: number,
  bounds: {
    first_pass_max_min: number;
    passes_max_min: number;
    running_max_min: number;
    follow_up_sweep_extra_min?: number;
  },
  sweepOwed: boolean,
  discoveryRows?: number,
): {
  first_pass_start: number;
  passes_complete: number;
  running_hard_bound: number;
} {
  const extra = roundStageAllowanceMin({
    sweepOwed,
    sweepExtraMin: bounds.follow_up_sweep_extra_min ?? 0,
    ...(discoveryRows === undefined ? {} : { discoveryRows }),
  });
  return {
    first_pass_start: started + bounds.first_pass_max_min * 60_000,
    passes_complete: started + (bounds.passes_max_min + extra) * 60_000,
    running_hard_bound: started + (bounds.running_max_min + extra) * 60_000,
  };
}

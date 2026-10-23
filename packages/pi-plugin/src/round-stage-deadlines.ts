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
): {
  first_pass_start: number;
  passes_complete: number;
  running_hard_bound: number;
} {
  const extra = sweepOwed ? (bounds.follow_up_sweep_extra_min ?? 0) : 0;
  return {
    first_pass_start: started + bounds.first_pass_max_min * 60_000,
    passes_complete: started + (bounds.passes_max_min + extra) * 60_000,
    running_hard_bound: started + (bounds.running_max_min + extra) * 60_000,
  };
}

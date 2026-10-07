// The event kinds the archiver may move out of the live `events` table
// (docs/archiving.md §9.1): a CLOSED set of the eight reader-less,
// high-volume kinds. Every other kind stays live — the fact kinds the outcome
// capture, the learner and the per-PR gates re-read (`pr_closed`,
// `verdict_applied`, `head_push`, `anomaly`, …), the register kinds whose
// newest row is read, and `comment_sweep`.
//
// S1 (plan mode) only COUNTS these rows for the backlog; nothing moves. The
// mover (S2) adds the fence that holds this set against every events read
// site in src/ — a kind some code reads must never be in it.
export const ARCHIVE_EVENT_KINDS: ReadonlySet<string> = new Set([
  "pingpong_decision_failed",
  "webhook_event",
  "recheck_noop",
  "ci_completed",
  "wakes_stranded",
  "reconcile_pass",
  "base_advanced",
  "exec_policy_violation",
]);

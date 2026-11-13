// A head whose CI workflow ran twice and whose first run was cancelled by the
// workflow's own `concurrency` group — the shape that kept a withheld
// approval withheld forever. The cancelled run's
// change-detection job ran through a reusable workflow and reports as
// `pre_checks / detect_changes`; the newer run skipped that job, so it
// reports as plain `pre_checks`. No newer run carries the cancelled job's
// name, so latest-run-per-name alone keeps the cancelled husk and reads red.
//
// GitHub's own payload shapes, so both CI readers — the adapter's
// `listChecks` and `scripts/pr-checks.sh` — read it through their real
// parsers.

export const CI_WORKFLOW = 101;
export const LABELS_WORKFLOW = 102;
export const CANCELLED_RUN = 2001;
export const WINNING_RUN = 2002;
const CANCELLED_SUITE = 3001;
const WINNING_SUITE = 3002;
const LABELS_SUITE = 3003;

const cr = (
  id: number,
  name: string,
  conclusion: string,
  started_at: string,
  suite: number,
): Record<string, unknown> => ({
  id,
  name,
  status: "completed",
  conclusion,
  started_at,
  check_suite: { id: suite },
  html_url: `h${id}`,
});

/** The check-runs at the head. */
export function supersededCheckRuns(): Array<Record<string, unknown>> {
  return [
    cr(11, "pre_checks", "skipped", "2026-11-13T09:43:21Z", WINNING_SUITE),
    cr(12, "run_tests_branch", "skipped", "2026-11-13T09:43:21Z", WINNING_SUITE),
    cr(13, "all_checks", "success", "2026-11-13T09:43:23Z", WINNING_SUITE),
    cr(14, "check_migration_conflicts", "skipped", "2026-11-13T09:43:29Z", WINNING_SUITE),
    cr(21, "run_tests_branch", "skipped", "2026-11-13T09:43:13Z", CANCELLED_SUITE),
    cr(22, "all_checks", "failure", "2026-11-13T09:43:16Z", CANCELLED_SUITE),
    cr(23, "pre_checks / detect_changes", "cancelled", "2026-11-13T09:43:12Z", CANCELLED_SUITE),
    cr(24, "check_migration_conflicts", "cancelled", "2026-11-13T09:43:12Z", CANCELLED_SUITE),
    cr(31, "sync", "success", "2026-11-13T09:43:12Z", LABELS_SUITE),
  ];
}

/** The workflow runs at the head (`GET /actions/runs?head_sha=`). */
export function supersededWorkflowRuns(
  head: string,
  over: {
    winningStatus?: string;
    winningConclusion?: string | null;
    cancelledConclusion?: string;
  } = {},
): Array<Record<string, unknown>> {
  return [
    {
      id: WINNING_RUN,
      workflow_id: CI_WORKFLOW,
      event: "pull_request",
      head_sha: head,
      status: over.winningStatus ?? "completed",
      conclusion: over.winningConclusion === undefined ? "success" : over.winningConclusion,
      created_at: "2026-11-13T09:43:12Z",
      check_suite_id: WINNING_SUITE,
    },
    {
      id: CANCELLED_RUN,
      workflow_id: CI_WORKFLOW,
      event: "pull_request",
      head_sha: head,
      status: "completed",
      conclusion: over.cancelledConclusion ?? "cancelled",
      created_at: "2026-11-13T09:43:11Z",
      check_suite_id: CANCELLED_SUITE,
    },
    {
      id: 2000,
      workflow_id: LABELS_WORKFLOW,
      event: "pull_request_target",
      head_sha: head,
      status: "completed",
      conclusion: "success",
      created_at: "2026-11-13T09:43:10Z",
      check_suite_id: LABELS_SUITE,
    },
  ];
}

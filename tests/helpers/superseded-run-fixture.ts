// A head whose CI workflow ran twice and whose first run was cancelled by the
// workflow's own `concurrency` group — the shape that kept a withheld
// approval withheld forever. The cancelled run's change-detection job ran
// through a reusable workflow and reports as `pre_checks / detect_changes`;
// the newer run skipped that job, so it reports as plain `pre_checks`. No
// newer run carries the cancelled job's name, so latest-run-per-name alone
// keeps the cancelled husk and reads red.
//
// GitHub's own payload shapes, so both CI readers — the adapter's
// `listChecks` and `scripts/pr-checks.sh` — read it through their real
// parsers. `SUPERSESSION_CASES` is the one case table both are driven with
// (tests/cigate.test.ts and tests/pr-checks-why.test.ts), so the two
// evaluators of the `supersededSuites` rule cannot drift while their tests
// still pass.

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

/** The check-runs at the head. `winning: false` leaves the newer run's
 * check-runs out (a successor that created no job, or one not in the read). */
export function supersededCheckRuns(
  over: { winning?: boolean } = {},
): Array<Record<string, unknown>> {
  return [
    ...(over.winning === false
      ? []
      : [
          cr(11, "pre_checks", "skipped", "2026-11-13T09:43:21Z", WINNING_SUITE),
          cr(12, "run_tests_branch", "skipped", "2026-11-13T09:43:21Z", WINNING_SUITE),
          cr(13, "all_checks", "success", "2026-11-13T09:43:23Z", WINNING_SUITE),
          cr(14, "check_migration_conflicts", "skipped", "2026-11-13T09:43:29Z", WINNING_SUITE),
        ]),
    cr(21, "run_tests_branch", "skipped", "2026-11-13T09:43:13Z", CANCELLED_SUITE),
    cr(22, "all_checks", "failure", "2026-11-13T09:43:16Z", CANCELLED_SUITE),
    cr(23, "pre_checks / detect_changes", "cancelled", "2026-11-13T09:43:12Z", CANCELLED_SUITE),
    cr(24, "check_migration_conflicts", "cancelled", "2026-11-13T09:43:12Z", CANCELLED_SUITE),
    cr(31, "sync", "success", "2026-11-13T09:43:12Z", LABELS_SUITE),
  ];
}

export interface WorkflowRunOver {
  winningStatus?: string;
  winningConclusion?: string | null;
  winningEvent?: string;
  winningCreatedAt?: string;
  winningHead?: string;
  cancelledConclusion?: string;
  cancelledCreatedAt?: string;
}

/** The workflow runs at the head (`GET /actions/runs?head_sha=`). */
export function supersededWorkflowRuns(
  head: string,
  over: WorkflowRunOver = {},
): Array<Record<string, unknown>> {
  return [
    {
      id: WINNING_RUN,
      workflow_id: CI_WORKFLOW,
      event: over.winningEvent ?? "pull_request",
      head_sha: over.winningHead ?? head,
      status: over.winningStatus ?? "completed",
      conclusion: over.winningConclusion === undefined ? "success" : over.winningConclusion,
      created_at: over.winningCreatedAt ?? "2026-11-13T09:43:12Z",
      check_suite_id: WINNING_SUITE,
    },
    {
      id: CANCELLED_RUN,
      workflow_id: CI_WORKFLOW,
      event: "pull_request",
      head_sha: head,
      status: "completed",
      conclusion: over.cancelledConclusion ?? "cancelled",
      created_at: over.cancelledCreatedAt ?? "2026-11-13T09:43:11Z",
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

/** One supersession case, as both readers are driven with it. */
export interface SupersessionCase {
  name: string;
  /** The workflow runs; `null`: the endpoint answers 404, as without Actions. */
  runs: (head: string) => Array<Record<string, unknown>> | null;
  checkRuns: () => Array<Record<string, unknown>>;
  /** The `total_count` the runs endpoint advertises, when it is not the truth. */
  totalCount?: number;
  want: "green" | "red";
}

const T = "2026-11-13T09:43:12Z";

export const SUPERSESSION_CASES: readonly SupersessionCase[] = [
  {
    name: "a cancelled run replaced by a successful run of its workflow and event",
    runs: (h) => supersededWorkflowRuns(h),
    checkRuns: () => supersededCheckRuns(),
    want: "green",
  },
  {
    name: "the runs cannot be read (404): nothing is superseded",
    runs: () => null,
    checkRuns: () => supersededCheckRuns(),
    want: "red",
  },
  {
    name: "an inconsistent runs snapshot (total_count says more): nothing is superseded",
    runs: (h) => supersededWorkflowRuns(h),
    checkRuns: () => supersededCheckRuns(),
    totalCount: 5,
    want: "red",
  },
  {
    name: "the newer run still running",
    runs: (h) =>
      supersededWorkflowRuns(h, { winningStatus: "in_progress", winningConclusion: null }),
    checkRuns: () => supersededCheckRuns(),
    want: "red",
  },
  {
    name: "the newer run itself cancelled before creating any job",
    runs: (h) => supersededWorkflowRuns(h, { winningConclusion: "cancelled" }),
    checkRuns: () => supersededCheckRuns({ winning: false }),
    want: "red",
  },
  {
    name: "the newer run succeeded but none of its check-runs are in the read",
    runs: (h) => supersededWorkflowRuns(h),
    checkRuns: () => supersededCheckRuns({ winning: false }),
    want: "red",
  },
  {
    name: "the older run failed rather than being cancelled",
    runs: (h) => supersededWorkflowRuns(h, { cancelledConclusion: "failure" }),
    checkRuns: () => supersededCheckRuns(),
    want: "red",
  },
  {
    name: "the newer run was triggered by another event",
    runs: (h) => supersededWorkflowRuns(h, { winningEvent: "push" }),
    checkRuns: () => supersededCheckRuns(),
    want: "red",
  },
  {
    name: "the newer run belongs to another commit",
    runs: (h) => supersededWorkflowRuns(h, { winningHead: "1".repeat(40) }),
    checkRuns: () => supersededCheckRuns(),
    want: "red",
  },
  {
    name: "an equal created_at: the higher run id is the newer run",
    runs: (h) => supersededWorkflowRuns(h, { winningCreatedAt: T, cancelledCreatedAt: T }),
    checkRuns: () => supersededCheckRuns(),
    want: "green",
  },
  {
    name: "an equal created_at: the cancelled run is the newer one when its id is higher",
    runs: (h) =>
      supersededWorkflowRuns(h, { winningCreatedAt: T, cancelledCreatedAt: T }).map((r) =>
        r["id"] === CANCELLED_RUN ? { ...r, id: WINNING_RUN + 1 } : r,
      ),
    checkRuns: () => supersededCheckRuns(),
    want: "red",
  },
];

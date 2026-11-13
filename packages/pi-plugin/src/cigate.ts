// Red CI hard-gates APPROVE.
//
// The rule: no green CI at this head ⇒ APPROVE is unavailable, regardless of
// findings. Infra problems block as well — deliberately simpler and stricter
// than judging whether a failure is attributable to the PR, because a rule
// that is argued case by case in prose makes the verdict depend on which
// reviewer ran. The code is still reviewed and the findings still posted;
// only the verdict is gated.
//
// Where the rule lives:
//
//   round-*.md Decide step ─► the session withholds the approval itself and
//                             posts the full review as a COMMENT
//   guards.ts (guard 4)    ─► the gate rewrites an APPROVE review to COMMENT
//   this module            ─► the classifier both halves share
//   ciretry.ts             ─► the retry (the bot's half)
//
// The retry is what makes the gate safe: a PR whose approval is withheld needs
// something to notice when CI goes green, or an infra flake becomes a
// permanently stuck PR. `approval_withheld` (state.ts) is the mark, the
// `ci_completed` webhook is the trigger, and `retryWithheldApproval`
// (src/ciretry.ts) re-queues the PR so its session can decide again — at
// which point the approval is simply available.
//
// Nothing here triggers, re-runs or cancels CI: every call in this module is a
// GET, exactly as the no-exec policy requires (`gh pr checks` / `gh api` only).

/**
 * One check at a head, as GitHub's check-runs / statuses APIs report it.
 *
 * `source` says which of the two APIs it came from, and the adapter
 * (`github.ts listChecks`) is its ONLY writer. It is the carrier the
 * latest-run rule keys on: a check-run can supersede an older
 * check-run of its name; a commit status never supersedes anything and is
 * never superseded. Without the kind on the row, a status and a check-run of
 * one name are told apart only by whether `started_at` happens to be set —
 * and a check-run GitHub reports with a null start then reads as a status.
 */
export interface CheckSummary {
  name: string;
  /** `check_run` from the check-runs API; `status` from the combined status
   * endpoint (which already dedupes statuses per context). */
  source: "check_run" | "status";
  /** `queued` | `in_progress` | `completed` (statuses map onto these). */
  status: string;
  /** `success` | `failure` | `cancelled` | `timed_out` | `skipped` | … */
  conclusion: string | null;
  /** When the run started — the recency key for latest-run-per-name
   * among check-runs. Set on check-runs (nullable in GitHub's schema)
   * and never on commit statuses: the adapter does not carry a time for
   * them, and `latestRunPerName` does not collapse them at all. */
  started_at?: string | null;
  /** Set by the adapter on a check-run whose whole workflow run was
   * superseded (`supersededSuites`): the id of the newer run of the same
   * workflow that replaced it. Such a row is a husk, not evidence, and
   * `latestRunPerName` drops it. Never set on a commit status. */
  superseded_by_run?: number;
}

/**
 * One GitHub Actions workflow run at a head, as `GET /actions/runs?head_sha=`
 * reports it — the only source that says which check-runs belong to which
 * run of which workflow. The adapter is its only reader.
 */
export interface WorkflowRunSummary {
  id: number;
  workflow_id: number;
  /** The event that triggered the run (`pull_request`, `push`, …). */
  event: string;
  /** The check suite holding this run's check-runs. */
  check_suite_id: number | null;
  status: string;
  conclusion: string | null;
  created_at: string;
}

/**
 * The check suites whose check-runs are husks of a superseded workflow run,
 * mapped to the id of the run that superseded each.
 *
 * Why name-collapsing alone is not enough: a workflow cancelled by its own
 * `concurrency` group leaves its check-runs behind, and a job that the newer
 * run named differently (a reusable workflow's `caller / callee` job that the
 * newer run skipped, so it reports as plain `caller`) has no newer run of its
 * name to lose to. Counted, that one cancelled husk keeps the head red
 * forever, and no withheld approval can ever be given.
 *
 * The rule, exactly — conservative on every axis:
 *
 *  - Runs group by workflow AND triggering event: a `push` run and a
 *    `pull_request` run of one workflow are two checks, never one
 *    superseding the other.
 *  - Within a group the newest run (latest `created_at`, then the higher id)
 *    supersedes the others ONLY once it has completed with `success` AND its
 *    own check-runs are in the read (`presentSuites`). It must stand in for
 *    what it replaces: a newest run still queued or running is no evidence
 *    yet; one that was itself cancelled — while it waited on concurrency, it
 *    may create no job at all — or failed to start proves nothing, and a
 *    successful run with no check-run in the read leaves nothing to count in
 *    the husks' place. In each of those cases the older runs still count.
 *  - Only an older run that concluded `cancelled` is superseded. An older run
 *    that failed is a real failure at this head and keeps counting.
 *  - The newest run is never superseded, so a run cancelled by hand with no
 *    successor still counts — a cancellation is never blanket-ignored.
 *
 * `scripts/pr-checks.sh` applies the same rule; the case table in
 * `tests/helpers/superseded-run-fixture.ts` drives both.
 */
export function supersededSuites(
  runs: readonly WorkflowRunSummary[],
  presentSuites: ReadonlySet<number>,
): Map<number, number> {
  const newest = new Map<string, WorkflowRunSummary>();
  const key = (r: WorkflowRunSummary): string => `${r.workflow_id}\u0000${r.event}`;
  const newer = (a: WorkflowRunSummary, b: WorkflowRunSummary): boolean =>
    a.created_at > b.created_at || (a.created_at === b.created_at && a.id > b.id);
  for (const r of runs) {
    const prev = newest.get(key(r));
    if (!prev || newer(r, prev)) newest.set(key(r), r);
  }
  const out = new Map<number, number>();
  for (const r of runs) {
    const top = newest.get(key(r))!;
    if (top === r || r.check_suite_id === null) continue;
    if ((top.status ?? "").toLowerCase() !== "completed") continue;
    if ((top.conclusion ?? "").toLowerCase() !== "success") continue;
    if (top.check_suite_id === null || !presentSuites.has(top.check_suite_id)) continue;
    if ((r.status ?? "").toLowerCase() !== "completed") continue;
    if ((r.conclusion ?? "").toLowerCase() !== "cancelled") continue;
    out.set(r.check_suite_id, top.id);
  }
  return out;
}

/**
 * The four things CI can be at a head:
 *
 *  - `green`   every check completed and at least one really succeeded
 *  - `red`     something completed badly — failure, cancelled, timed out,
 *              action_required, stale. No special-casing: an infra
 *              cancellation blocks exactly like a failing test.
 *  - `pending` a check is still queued or running — not green *yet*
 *  - `none`    no check reported at this head at all
 */
export type CiState = "green" | "red" | "pending" | "none";

/** Conclusions that are neither a success nor a failure: a path-filtered job
 * skipped, an advisory check. They neither make CI green nor make it red. */
const INERT_CONCLUSIONS = new Set(["skipped", "neutral"]);

/** Not-yet-finished statuses. Anything else is treated as completed. */
const UNFINISHED = new Set(["queued", "in_progress", "waiting", "pending", "requested"]);

/**
 * Only the most recent run of each check name counts. GitHub auto-cancels
 * superseded workflow runs, leaving permanent `completed/cancelled` husks
 * beside the run that actually finished; counting every run would classify
 * such a head red forever and no withheld approval could ever release.
 *
 * The rule, exactly, keyed on `source`:
 *
 *  - Only CHECK-RUNS collapse. Among check-runs of one name that carry a
 *    `started_at`, the latest start wins; an equal start resolves to the
 *    later list position. A check-run WITHOUT a timestamp (null in GitHub's
 *    schema) never competes with a timestamped one in either direction — it
 *    stands beside that name's latest timestamped run and counts on its own;
 *    among untimestamped check-runs of one name the later list position wins.
 *    A missing timestamp is unknown, never "older than everything".
 *  - A COMMIT STATUS is never collapsed with anything — not with a check-run
 *    of its name, not with another status. The combined status endpoint
 *    already dedupes per context, and a status under the same context as a
 *    check-run is a second check, not a superseded run.
 *
 * Why the kind and not the timestamp decides: collapsing a status with a
 * same-named check-run lets one hide the other. A failing status could lose
 * to a passing check-run, or an untimestamped check-run (queued, or failed
 * with a null start) could lose to a passing status listed after it — either
 * way red or pending reads green. `scripts/pr-checks.sh` reads check-runs and commit statuses and applies
 * both clauses. Keep the two in step (`tests/fences-cigate.test.ts`).
 *
 * Before any of that, a check-run the adapter marked `superseded_by_run` is
 * dropped: it belongs to a whole workflow run a newer run of the same
 * workflow replaced (`supersededSuites` states when that holds).
 */
export function latestRunPerName(checks: readonly CheckSummary[]): CheckSummary[] {
  interface Kept {
    check: CheckSummary;
    idx: number;
  }
  const kept: Kept[] = [];
  const timedRuns = new Map<string, Kept & { at: string }>();
  const untimedRuns = new Map<string, Kept>();
  checks.forEach((check, idx) => {
    if (check.source === "check_run" && check.superseded_by_run !== undefined) return;
    if (check.source !== "check_run") {
      kept.push({ check, idx }); // a status is never collapsed, in either direction
      return;
    }
    const at = check.started_at || null; // "" carries no time either
    if (at === null) {
      untimedRuns.set(check.name, { check, idx });
      return;
    }
    const prev = timedRuns.get(check.name);
    if (!prev || at >= prev.at) timedRuns.set(check.name, { check, idx, at });
  });
  return [...kept, ...timedRuns.values(), ...untimedRuns.values()]
    .sort((x, y) => x.idx - y.idx)
    .map((e) => e.check);
}

/**
 * Classify the checks at one head. Pure — both the gate guard and the shell
 * mirror answer from this table, so "green" means the same thing on every
 * posting route.
 *
 * A suite whose every check is skipped or neutral is not green: it reports
 * `red`, because there is no evidence this PR's code passed anything.
 */
export function classifyCi(allChecks: readonly CheckSummary[]): CiState {
  const checks = latestRunPerName(allChecks);
  if (checks.length === 0) return "none";
  let pending = false;
  let succeeded = false;
  for (const c of checks) {
    const outcome = checkOutcome(c);
    if (outcome === "failed") return "red";
    if (outcome === "pending") pending = true;
    if (outcome === "success") succeeded = true;
  }
  if (pending) return "pending";
  return succeeded ? "green" : "red";
}

/**
 * One check's outcome — the per-check half of `classifyCi`, and the one
 * reading of a check anything else (the escalation's failing-check rule)
 * may use. `failed` is every finished conclusion that is neither a success
 * nor inert: failure, cancelled, timed_out, action_required, stale, …
 */
export function checkOutcome(c: CheckSummary): "pending" | "success" | "inert" | "failed" {
  const status = (c.status ?? "").toLowerCase();
  const conclusion = (c.conclusion ?? "").toLowerCase();
  if (UNFINISHED.has(status) || (status !== "completed" && conclusion === "")) return "pending";
  if (conclusion === "success") return "success";
  if (INERT_CONCLUSIONS.has(conclusion)) return "inert";
  return "failed";
}

/**
 * The counted checks that keep CI from green — every failed or still-pending
 * one, after the same supersession and latest-run rules `classifyCi` applies.
 * What an operator reads when an approval stays withheld: the precise check,
 * not just "red".
 */
export function ciBlockers(
  allChecks: readonly CheckSummary[],
): Array<{ name: string; outcome: "failed" | "pending"; conclusion: string | null }> {
  const out: Array<{ name: string; outcome: "failed" | "pending"; conclusion: string | null }> = [];
  for (const c of latestRunPerName(allChecks)) {
    const outcome = checkOutcome(c);
    if (outcome === "failed" || outcome === "pending")
      out.push({ name: c.name, outcome, conclusion: c.conclusion });
  }
  return out;
}

/**
 * Does this CI state make APPROVE unavailable?
 *
 * `none` blocks only when `noChecksIsRed` says so: in a repo that normally
 * runs CI, a head with zero check-runs — a conflicted PR, or CI that has not
 * started — carries no execution evidence, so approval waits for checks to
 * appear and pass. The flag is off by default so a repo with no CI at all is
 * never permanently wedged.
 */
export function ciBlocksApproval(state: CiState, opts: { noChecksIsRed?: boolean } = {}): boolean {
  if (state === "none") return opts.noChecksIsRed === true;
  return state === "red" || state === "pending";
}

/** Plain-words reason, for the note and the logs. */
export function ciStateReason(state: CiState): string {
  switch (state) {
    case "red":
      return "CI is not green at this head";
    case "pending":
      return "CI has not finished at this head";
    case "green":
      return "CI is green at this head";
    case "none":
      return "no CI reported at this head";
  }
}

/**
 * The paragraph a withheld review carries. It says the two things the author
 * needs — that the review is finished and found nothing blocking, and that the
 * approval is waiting on CI and on nothing else — so the work is never
 * invisible while CI is broken.
 */
export function withheldApprovalNote(state: CiState, headSha: string): string {
  return (
    `_**No blockers were found in this review.** Approval is withheld because ` +
    `${ciStateReason(state)} (\`${headSha.slice(0, 7)}\`) — nothing above asks you to change anything, ` +
    "and the failures may well be infrastructure or the base branch rather than this PR. " +
    "The approval is waiting on green CI alone, and is re-attempted automatically once CI is green at this head._"
  );
}

/** The review payload as it appears inside a `create_review` intent. */
export interface CiReviewBody {
  commit_id?: string;
  event?: string;
  body?: string;
  comments?: unknown[];
}

/**
 * APPROVE → COMMENT, findings untouched, with the withheld note appended.
 * Never REQUEST_CHANGES: there is nothing for the author to change on the
 * review's account, and the fault may be the base branch or infra.
 */
export function withholdApproval(
  body: CiReviewBody,
  state: CiState,
  headSha: string,
): CiReviewBody {
  return {
    ...body,
    event: "COMMENT",
    body: `${body.body ?? ""}\n\n${withheldApprovalNote(state, headSha)}`,
  };
}

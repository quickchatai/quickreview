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
//   scripts/guards.sh      ─► the same refusal on the sessions' own route
//   this module            ─► the classifier both halves share, and the retry
//
// The retry is what makes the gate safe: a PR whose approval is withheld needs
// something to notice when CI goes green, or an infra flake becomes a
// permanently stuck PR. `approval_withheld` (state.ts) is the mark, the
// `ci_completed` webhook is the trigger, and `retryWithheldApproval` below
// re-queues the PR so its session can decide again — at which point the
// approval is simply available.
//
// Nothing here triggers, re-runs or cancels CI: every call in this module is a
// GET, exactly as the no-exec policy requires (`gh pr checks` / `gh api` only).
import type { Config } from "./config.js";
import { applyEvent } from "./statemachine.js";
import type { StateStore } from "./state.js";

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
 * way red or pending reads green. `scripts/guards.sh` applies this same rule,
 * and `scripts/pr-checks.sh` reads check-runs and commit statuses and applies
 * both clauses. Keep the three in step (`tests/fences-cigate.test.ts`).
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
    const status = (c.status ?? "").toLowerCase();
    const conclusion = (c.conclusion ?? "").toLowerCase();
    if (UNFINISHED.has(status) || (status !== "completed" && conclusion === "")) {
      pending = true;
      continue;
    }
    if (conclusion === "success") {
      succeeded = true;
      continue;
    }
    if (INERT_CONCLUSIONS.has(conclusion)) continue;
    return "red"; // failure, cancelled, timed_out, action_required, stale, …
  }
  if (pending) return "pending";
  return succeeded ? "green" : "red";
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

// ---- the retry: CI went green, ask for the verdict again -------------------

/** Read-only adapter slice. A GET, so nothing here goes near the gate. */
export interface CiAdapter {
  /** Checks at a ref (`GET /commits/<ref>/check-runs` + combined status). */
  listChecks(ref: string): Promise<CheckSummary[]>;
}

export interface WithheldRetryDeps {
  cfg: Config;
  store: StateStore;
  /** Partial: a daemon wired without the checks read falls back to the
   * conclusion the webhook carried, exactly as the recheck does. */
  adapter: Partial<CiAdapter>;
  now?: () => Date;
  log?: (msg: string, extra?: unknown) => void;
}

/** Why a `ci_completed` did not re-queue anything. Every one of these leaves
 * the withheld mark standing — the next completion comes round again. */
export type RetryNoopReason =
  | "disabled"
  | "no-withheld-approval"
  | "head-moved"
  | "pr-not-open"
  | "ci-not-green"
  | "ci-unreadable";

export type WithheldRetryOutcome =
  | { action: "noop"; reason: RetryNoopReason; ci?: CiState }
  | { action: "requeued"; ci: CiState; head_sha: string };

export interface WithheldRetryRequest {
  pr: number;
  head_sha: string;
  /** The conclusion the webhook carried; used only when no checks read exists. */
  conclusion?: string | null;
}

/**
 * One `ci_completed` event against the withheld-approval mark. When the mark
 * stands at this head and CI is now green, the PR is re-queued: the ordinary
 * dispatch → round → verdict path then re-decides it, and the approval is
 * available this time. No review is posted from here and no verdict is
 * invented — the session still decides.
 */
export async function retryWithheldApproval(
  deps: WithheldRetryDeps,
  req: WithheldRetryRequest,
): Promise<WithheldRetryOutcome> {
  const { cfg, store } = deps;
  const log = deps.log ?? ((): void => {});
  const noop = (reason: RetryNoopReason, ci?: CiState): WithheldRetryOutcome => ({
    action: "noop",
    reason,
    ...(ci ? { ci } : {}),
  });

  if (!cfg.guards.block_approve_on_red_ci) return noop("disabled");

  const mark = store.approvalWithheld(req.pr);
  if (!mark) return noop("no-withheld-approval");
  // A moved head is not this path's business: a push re-reviews through its own
  // route, and the mark is replaced when the next review is withheld.
  if (req.head_sha && mark.head_sha !== req.head_sha) return noop("head-moved");

  const row = store.getPr(req.pr);
  if (!row || row.state === "closed") return noop("pr-not-open");

  let state: CiState;
  if (deps.adapter.listChecks) {
    try {
      state = classifyCi(await deps.adapter.listChecks(mark.head_sha));
    } catch (err) {
      // Unreadable CI is not evidence of anything. The mark stands and the next
      // completion (or the reconcile poll) tries again.
      log(`cigate: #${req.pr} checks read failed`, err);
      store.logEvent("approval_retry_ci_unreadable", req.pr, {
        head_sha: mark.head_sha,
        error: String(err),
      });
      return noop("ci-unreadable");
    }
  } else {
    state = (req.conclusion ?? "").toLowerCase() === "success" ? "green" : "red";
  }
  if (state !== "green") return noop("ci-not-green", state);

  applyEvent(
    store,
    req.pr,
    { type: "trigger", source: "reconcile" },
    {},
    {
      botLogin: cfg.github.bot_login,
      ...(deps.now ? { now: deps.now } : {}),
      reason: "ci-green:withheld-approval-retry",
    },
  );
  store.logEvent("approval_retry_queued", req.pr, {
    head_sha: mark.head_sha,
    withheld_at: mark.created_at,
  });
  log(
    `cigate: #${req.pr} CI green at ${mark.head_sha.slice(0, 7)} — re-queued for the withheld approval`,
  );
  return { action: "requeued", ci: state, head_sha: mark.head_sha };
}

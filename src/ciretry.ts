// The withheld-approval retry: CI went green, ask for the verdict again. The
// bot's half of the red-CI gate (packages/pi-plugin/src/cigate.ts says the rule and holds the
// classifier both halves share): a PR whose approval was withheld for red CI
// is re-queued when its CI turns green, so its session can decide again.
//
// Nothing here triggers, re-runs or cancels CI: the one CI call is a GET.
import { botAccountLogin } from "@quickchatai/pi-quickreview/src/identity.js";
import {
  classifyCi,
  type CheckSummary,
  type CiState,
} from "@quickchatai/pi-quickreview/src/cigate.js";
import type { Config } from "./config.js";
import { applyEvent } from "./statemachine.js";
import type { StateStore } from "./state.js";

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
  /** A round is already queued or running for the PR: it decides, and the
   * retry has nothing to requeue. */
  | "review-pending"
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
  // route (the recheck carries the mark to the new head when it upholds), and
  // the mark is replaced when the next review is withheld. Green CI at the
  // withheld head says nothing about the PR's current head, so the mark must
  // still describe the PR — the completion's head AND the row's.
  if (req.head_sha && mark.head_sha !== req.head_sha) return noop("head-moved");

  /** The PR as the retry may act on it, or why it may not. Asked before the
   * checks read and again after it: the read is asynchronous, and a push, a
   * close or a dispatch may land meanwhile. */
  const admissible = (): RetryNoopReason | null => {
    const row = store.getPr(req.pr);
    if (!row || row.state === "closed") return "pr-not-open";
    const current = store.approvalWithheld(req.pr);
    if (!current || current.head_sha !== mark.head_sha) return "head-moved";
    if (row.head_sha && row.head_sha !== mark.head_sha) return "head-moved";
    if (row.state === "queued" || row.state === "reviewing") return "review-pending";
    return null;
  };
  const before = admissible();
  if (before) return noop(before);

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
  const after = admissible();
  if (after) return noop(after, state);

  applyEvent(
    store,
    req.pr,
    { type: "trigger", source: "reconcile" },
    {},
    {
      botLogin: botAccountLogin(cfg.github),
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

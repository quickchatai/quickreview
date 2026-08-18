// Posting-time guards. Three refusals the predecessor system lacked,
// each with a documented incident, all of them at the one moment that matters:
// immediately before a review reaches GitHub.
//
//   1. Never re-block a head a human already approved. PR 5180 went
//      human-APPROVED and then took EIGHT bot CHANGES_REQUESTED reviews the
//      next day on the same head, each saying "no new findings". A non-author
//      human approval at the head under review downgrades the bot to a
//      COMMENT: it still reports everything it found, it just stops holding
//      the gate against a person who has already looked.
//   2. No-op when there is no new evidence. 16% of the old bot's reviews
//      (71/444) re-reviewed a commit it had already reviewed. The mark lives in
//      `reviewed_heads` (state.ts): same head AND no author reply since ⇒ post
//      nothing. The same mark is what the post-approval delta recheck reads.
//   3. Re-check merged/closed state immediately before posting. Four sampled
//      reviews landed at or after the merge — one approved 13 seconds after it.
//   4. No green CI at this head ⇒ APPROVE is unavailable. The old
//      bot improvised this rule eleven times, each approval arguing in prose
//      that the red run did not count. The review still posts — as a COMMENT
//      with the approval withheld and a plain note saying so — and the PR is
//      re-queued when CI goes green. The classifier lives in cigate.ts, which
//      the shell mirror answers from too.
//
// All three are installed on the ONE MutationGate (gate.ts `MutationGuard`),
// not on a call site, so no posting route in the daemon can reach GitHub
// around them. The sessions post through the shell instead
// (scripts/post-review.sh, approve-pr.sh, reply-thread.sh), which does not go
// through the gate — `scripts/guards.sh` is the mirror for that route and it
// carries ALL THREE, together with the reviewed-head stamp that the gate's
// after-step makes on its own route. The two halves are deliberately kept
// behaviourally identical: tests/guards.test.ts drives the real gate and
// tests/guards-shell.test.ts runs the real scripts, over the same cases.
// Guard coverage per shell route: post-review.sh 1+2+3 (it hard-rejects
// APPROVE, so guard 4 has nothing to say there), approve-pr.sh 3+4 — guards 1
// and 2 do not apply to it (an approval is not softened for a human approval,
// and gating it on evidence would strand the wake triggers this script
// clears), but guard 4 is exactly about approvals, so it does — and
// reply-thread.sh 3. On the shell route guard 4 REFUSES rather than softens:
// approve-pr.sh can only approve, so the session posts its COMMENT through
// post-review.sh instead, which is what the round template tells it to do.
//
// Nothing here dismisses, retracts or edits an existing review. A guard's only
// powers are to refuse a mutation and to soften an event from REQUEST_CHANGES
// to COMMENT.
import { ciBlocksApproval, classifyCi, withholdApproval, type CheckSummary, type CiState } from "./cigate.js";
import type { GuardsConfig } from "./config.js";
import type { GateResult, MutationGuard, MutationIntent } from "./gate.js";
import { isBotAuthor } from "./statemachine.js";
import type { ReviewedHeadRow, StateStore } from "./state.js";

/** Mutation kinds that put words on a PR — the ones the guards inspect. */
export const POSTING_KINDS: ReadonlySet<string> = new Set([
  "create_review",
  "create_review_comment_reply",
]);

/** The read-only slice of the adapter the guards need. Both calls are reads,
 * and a read is never gated. */
export interface GuardAdapter {
  getPr(n: number): Promise<{ state: "open" | "closed"; merged: boolean; head_sha: string; author: string }>;
  listReviews(n: number): Promise<Array<{ id: number; user: string; state: string; commit_id: string }>>;
  /** Checks at a head (guard 4). Optional: an adapter without it
   * cannot see CI, and a guard never blocks on what it cannot see. */
  listChecks?(ref: string): Promise<CheckSummary[]>;
}

/** The store slice: the reviewed-head mark, the withheld-approval mark, and
 * the event log. */
export type GuardStore = Pick<
  StateStore,
  "reviewedHead" | "recordReviewedHead" | "logEvent" | "recordApprovalWithheld" | "clearApprovalWithheld"
>;

export interface GuardDeps {
  store: GuardStore;
  adapter: GuardAdapter;
  botLogin: string;
  guards: GuardsConfig;
  log?: (msg: string, extra?: unknown) => void;
}

/** The review payload as it appears inside a `create_review` intent. */
interface ReviewBody {
  commit_id?: string;
  event?: string;
  body?: string;
  comments?: unknown[];
}

// ---- guard 1: a human already approved this head --------------------------

/**
 * The login of a non-author human whose APPROVED review stands at `head_sha`,
 * or null. "Stands" means it is that person's LATEST verdict-bearing review:
 * a later CHANGES_REQUESTED or DISMISSED by the same person retires it.
 * COMMENTED/PENDING reviews carry no verdict and are ignored.
 *
 * Reviews are read in submission order, which is the order the REST endpoint
 * returns them in.
 */
export function humanApprovalAtHead(
  reviews: Array<{ user: string; state: string; commit_id: string }>,
  opts: { head_sha: string; author: string; botLogin: string },
): string | null {
  if (!opts.head_sha) return null;
  const latest = new Map<string, { state: string; commit_id: string }>();
  for (const r of reviews) {
    const state = (r.state ?? "").toUpperCase();
    if (state !== "APPROVED" && state !== "CHANGES_REQUESTED" && state !== "DISMISSED") continue;
    if (!r.user) continue;
    latest.set(r.user, { state, commit_id: r.commit_id });
  }
  for (const [user, r] of latest) {
    if (r.state !== "APPROVED") continue;
    if (r.commit_id !== opts.head_sha) continue;
    if (user === opts.author) continue; // GitHub forbids it, but never trust that
    if (isBotAuthor(user, opts.botLogin)) continue;
    return user;
  }
  return null;
}

/** The note the downgraded review carries, so the softer event is never a
 * silent change of mind. */
export function downgradeNote(approver: string, headSha: string): string {
  return (
    `_Not blocking: **@${approver}** has already approved this head (\`${headSha.slice(0, 7)}\`). ` +
    "The findings above are reported for information only — this review does not request changes._"
  );
}

/** REQUEST_CHANGES → COMMENT, findings untouched, with the note appended. */
export function downgradeForHumanApproval(body: ReviewBody, approver: string, headSha: string): ReviewBody {
  return {
    ...body,
    event: "COMMENT",
    body: `${body.body ?? ""}\n\n${downgradeNote(approver, headSha)}`,
  };
}

// ---- guard 2: no new evidence ---------------------------------------------

/**
 * Is there anything new to review at `head_sha`? True unless the mark sits on
 * exactly this head and no author reply has landed since it was stamped.
 * An unknown head (empty string) is always "new": guessing would suppress a
 * real review.
 */
export function hasNewEvidence(mark: ReviewedHeadRow | undefined, headSha: string): boolean {
  if (!mark || !headSha) return true;
  if (mark.head_sha !== headSha) return true;
  // `>=`, not `>`: a reply stamped in the same millisecond as the review is
  // ambiguous, and the safe reading of an ambiguous reply is "new evidence".
  // Re-stamping the mark clears the reply, so this cannot loop.
  if (mark.last_author_reply_at && mark.last_author_reply_at >= mark.reviewed_at) return true;
  return false;
}

// ---- the guard installed on the gate --------------------------------------

/** Why a posting mutation was refused. Short tags — they land in the event log
 * and in `GateResult.blocked`. */
export type BlockReason = "pr-merged" | "pr-closed" | "pr-unreadable" | "no-new-evidence";

/**
 * Read the checks at a head for guard 4. Null means "cannot see CI" — no
 * adapter method, no head, or a failed read — and a guard never blocks on what
 * it cannot see: failing closed here would withhold every approval during a
 * GitHub outage, turning an outage into a pile of parked PRs. What it CAN see
 * it enforces without exception, infra failures included.
 */
async function readCi(
  deps: GuardDeps,
  pr: number,
  head: string,
  log: (msg: string, extra?: unknown) => void,
): Promise<CiState | null> {
  if (!deps.adapter.listChecks || !head) return null;
  try {
    return classifyCi(await deps.adapter.listChecks(head));
  } catch (err) {
    log(`guard: checks read failed on #${pr}`, err);
    deps.store.logEvent("approval_ci_unreadable", pr, { head_sha: head, error: String(err) });
    return null;
  }
}

export function makePostingGuard(deps: GuardDeps): MutationGuard {
  const log = deps.log ?? (() => {});

  const refuse = (intent: MutationIntent, pr: number, reason: BlockReason, extra: Record<string, unknown> = {}) => {
    log(`guard: refused ${intent.kind} on #${pr} — ${reason}`);
    deps.store.logEvent("posting_guard_blocked", pr, { kind: intent.kind, reason, ...extra });
    return { block: reason };
  };

  return {
    async before(intent: MutationIntent) {
      if (!POSTING_KINDS.has(intent.kind)) return {};
      const pr = intent.pr;
      if (!pr) return {}; // no PR to check against — nothing this guard can say
      const body = (intent.body ?? {}) as ReviewBody;

      // --- guard 3: is the PR still open, right now? ---
      let ref: Awaited<ReturnType<GuardAdapter["getPr"]>> | undefined;
      if (deps.guards.recheck_pr_state_before_post) {
        try {
          ref = await deps.adapter.getPr(pr);
        } catch (err) {
          // Fail closed: an unverifiable PR state is exactly the case the four
          // post-merge reviews came from. The session retries; reconcile
          // re-derives the truth.
          return refuse(intent, pr, "pr-unreadable", { error: String(err) });
        }
        if (ref.merged) return refuse(intent, pr, "pr-merged");
        if (ref.state === "closed") return refuse(intent, pr, "pr-closed");
      }

      if (intent.kind !== "create_review") return {};
      // The head the review is ABOUT: the payload's commit_id when it has one,
      // otherwise whatever the PR points at now.
      const head = body.commit_id || ref?.head_sha || "";

      // --- guard 2: has anything happened since the last review? ---
      if (deps.guards.skip_unchanged_head && !hasNewEvidence(deps.store.reviewedHead(pr), head)) {
        return refuse(intent, pr, "no-new-evidence", { head_sha: head });
      }

      // --- guard 1: a human approved this head; do not hold the gate ---
      if (deps.guards.downgrade_on_human_approval && (body.event ?? "").toUpperCase() === "REQUEST_CHANGES") {
        let approver: string | null = null;
        try {
          approver = humanApprovalAtHead(await deps.adapter.listReviews(pr), {
            head_sha: head,
            author: ref?.author ?? "",
            botLogin: deps.botLogin,
          });
        } catch (err) {
          // A failed read must not block a review — the worst case here is the
          // pre-guard behaviour, not a post-merge or duplicate review.
          log(`guard: review listing failed on #${pr}`, err);
        }
        if (approver) {
          log(`guard: #${pr} REQUEST_CHANGES → COMMENT (@${approver} approved ${head.slice(0, 7)})`);
          deps.store.logEvent("posting_guard_downgraded", pr, { approver, head_sha: head });
          return {
            intent: {
              ...intent,
              body: downgradeForHumanApproval(body, approver, head),
              note: `post COMMENT review on #${pr} (downgraded: @${approver} approved this head)`,
            },
          };
        }
      }

      // --- guard 4: no green CI at this head ⇒ no approval ---
      if (deps.guards.block_approve_on_red_ci && (body.event ?? "").toUpperCase() === "APPROVE") {
        const ci = await readCi(deps, pr, head, log);
        if (ci && ciBlocksApproval(ci)) {
          log(`guard: #${pr} APPROVE → COMMENT (CI ${ci} at ${head.slice(0, 7)})`);
          deps.store.logEvent("approval_withheld_red_ci", pr, { head_sha: head, ci_state: ci });
          // The promise this note makes to the author — "waiting on CI alone" —
          // is kept by the mark: the `ci_completed` trigger reads it and
          // re-queues the PR the moment CI goes green (cigate.ts).
          deps.store.recordApprovalWithheld(pr, { head_sha: head, ci_state: ci, reason: "red-ci" });
          return {
            intent: {
              ...intent,
              body: withholdApproval(body, ci, head),
              note: `post COMMENT review on #${pr} (approval withheld: CI ${ci} at this head)`,
            },
          };
        }
        // Green (or invisible) CI: no approval is being withheld here any more.
        if (ci === "green") deps.store.clearApprovalWithheld(pr);
      }
      return {};
    },

    after(intent: MutationIntent, result: GateResult) {
      // The mark is stamped only for a review that really reached GitHub. A
      // dry-run record posted nothing, so nothing has been reviewed.
      if (intent.kind !== "create_review" || !result.executed || !intent.pr) return;
      const body = (intent.body ?? {}) as ReviewBody;
      if (!body.commit_id) return;
      deps.store.recordReviewedHead(intent.pr, {
        head_sha: body.commit_id,
        posted_event: (body.event ?? "").toUpperCase() || null,
      });
    },
  };
}

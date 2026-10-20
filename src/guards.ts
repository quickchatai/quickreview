// Posting-time guards, all applied at the one moment that matters:
// immediately before a review reaches GitHub.
//
//   1. Never re-block a head a human already approved. A non-author human
//      approval at the head under review downgrades a REQUEST_CHANGES to a
//      COMMENT: the bot still reports everything it found, it just stops
//      holding the gate against a person who has already looked.
//   2. No-op when there is no new evidence. The mark lives in
//      `reviewed_heads` (state.ts): same head AND no author reply since ⇒ post
//      nothing. The same mark is what the post-approval delta recheck reads.
//   3. Re-check merged/closed state immediately before posting, so no review
//      lands at or after a merge.
//   5. The live head must be the head the round actually reviewed, so a push
//      landing between a round's validation and its posting step never gets
//      the stale review posted against it. On the gate route the intent's
//      commit_id is the reviewed head, so a mismatch with the guard-3 live
//      read refuses; a session's post carries QCR_EXPECTED_HEAD
//      (cited by its round prompt) as the intent's commit_id, and a post that
//      names none carries no expectation, so a session whose prompt does not
//      set it is never wedged.
//   4. No green CI at this head ⇒ APPROVE is unavailable. The review still
//      posts — as a COMMENT with the approval withheld and a plain note saying
//      so — and the PR is re-queued when CI goes green. The classifier lives
//      in cigate.ts.
//
// All of them are installed on the one MutationGate (gate.ts `MutationGuard`),
// not on a call site, so no posting route in the daemon can reach GitHub
// around them. The sessions post through scripts/post-review.sh,
// approve-pr.sh and reply-thread.sh, Node-only clients of the daemon's post
// endpoint (src/ipc/postshim.ts); the daemon builds the intent and hands it to
// the same gate, so these guards bind them too. The gate's after-step makes
// the reviewed-head stamp. tests/guards.test.ts drives the real gate over the
// cases.
// Guard 2 never gates an APPROVE. Guard 4 softens rather than refuses: an
// approval over red CI posts as a COMMENT with the approval withheld.
//
// Nothing here dismisses, retracts or edits an existing review. A guard's only
// powers are to refuse a mutation and to soften its event to COMMENT — a
// REQUEST_CHANGES a human's approval outranks (guard 1), an APPROVE red CI
// withholds (guard 4).
import {
  ciBlocksApproval,
  classifyCi,
  withholdApproval,
  type CheckSummary,
  type CiReviewBody,
  type CiState,
} from "./cigate.js";
import { standingReview } from "./standing-review.js";
import type { GuardsConfig } from "./config.js";
import type { GateResult, MutationGuard, MutationIntent } from "./gate.js";
import { isBotAuthor } from "./statemachine.js";
import type { ReviewedHeadRow, StateStore } from "./state.js";

/** Mutation kinds that put words on a PR — the ones the guards inspect. */
export const POSTING_KINDS: ReadonlySet<string> = new Set([
  "create_review",
  "create_review_comment_reply",
  "create_issue_comment",
]);

/** The read-only slice of the adapter the guards need. Both calls are reads,
 * and a read is never gated. */
export interface GuardAdapter {
  getPr(
    n: number,
  ): Promise<{ state: "open" | "closed"; merged: boolean; head_sha: string; author: string }>;
  listReviews(
    n: number,
  ): Promise<Array<{ id: number; user: string; state: string; commit_id: string }>>;
  /** Checks at a head (guard 4). Optional: an adapter without it
   * cannot see CI, and a guard never blocks on what it cannot see. */
  listChecks?(ref: string): Promise<CheckSummary[]>;
}

/** The store slice: the reviewed-head mark, the withheld-approval mark, and
 * the event log. */
export type GuardStore = Pick<
  StateStore,
  | "reviewedHead"
  | "recordReviewedHead"
  | "logEvent"
  | "recordApprovalWithheld"
  | "clearApprovalWithheld"
>;

export interface GuardDeps {
  store: GuardStore;
  adapter: GuardAdapter;
  botLogin: string;
  guards: GuardsConfig;
  log?: (msg: string, extra?: unknown) => void;
}

/** The review payload as it appears inside a `create_review` intent — the
 * one shape both softenings (guard 1 here, guard 4 in cigate.ts) rewrite. */
type ReviewBody = CiReviewBody;

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
export function downgradeForHumanApproval(
  body: ReviewBody,
  approver: string,
  headSha: string,
): ReviewBody {
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
  // A NEEDS_HUMAN/ESCALATE mark (legacy vocabulary) is an undecided review:
  // it must never suppress a re-run or a posting — a re-triggered PR with only
  // an undecided mark deserves a full round. Read through the one
  // standing-review interpretation, so this guard and dispatch's skip can
  // never disagree about what the mark says.
  if (standingReview(mark).kind === "undecided") return true;
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
export type BlockReason =
  "pr-merged" | "pr-closed" | "pr-unreadable" | "no-new-evidence" | "head-drift";

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

  const refuse = (
    intent: MutationIntent,
    pr: number,
    reason: BlockReason,
    extra: Record<string, unknown> = {},
  ) => {
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
          // Fail closed: an unverifiable PR state is exactly when a post-merge
          // review could land. The session retries; reconcile re-derives the
          // truth.
          return refuse(intent, pr, "pr-unreadable", { error: String(err) });
        }
        if (ref.merged) return refuse(intent, pr, "pr-merged");
        if (ref.state === "closed") return refuse(intent, pr, "pr-closed");
      }

      if (intent.kind !== "create_review") return {};
      // The head the review is ABOUT: the payload's commit_id when it has one,
      // otherwise whatever the PR points at now.
      const head = body.commit_id || ref?.head_sha || "";

      // --- guard 5: the head the review is about must still BE the head ---
      // A push landing between a round's validation and its posting step
      // would otherwise land the stale review against the new head. Fires
      // only where the data exists —
      // an intent without a commit_id carries no expectation, and without the
      // guard-3 read there is no live head to compare against. Shas compare
      // case-insensitively: git shas are hex, and an LLM-written
      // commit_id with drifted case must never fake a "moved" head.
      // A deferred session review the daemon delivers
      // (`intent.postingRetry`) posts at its ORIGINAL commit_id even when the
      // PR has moved on; admission pins the key to
      // that commit_id and marker.
      if (
        deps.guards.refuse_on_head_drift &&
        intent.postingRetry === undefined &&
        body.commit_id &&
        ref &&
        ref.head_sha.toLowerCase() !== body.commit_id.toLowerCase()
      ) {
        return refuse(intent, pr, "head-drift", {
          expected_head: body.commit_id,
          live_head: ref.head_sha,
        });
      }

      // --- guard 2: has anything happened since the last review? ---
      //
      // The escalation note is exempt, and only it. Guard 2 exists to stop the
      // bot re-reviewing a head it already reviewed. An escalation note is not
      // a review of the head: it carries no verdict, claims no head (see
      // `after` below), and by design lands right after the round's own review
      // — i.e. always at a head the mark has just been stamped on, so guard 2
      // would suppress every one of them. Its duplicate-suppression is strictly
      // narrower than guard 2's: the `escalations` ledger refuses the same
      // person + the same thing on the same PR forever, and `[escalation]
      // max_per_pr` caps the rest. Every other guard still binds it —
      // merged/closed (3) and head drift (5) both ran above, unconditionally.
      //
      // An APPROVE is exempt too, as a matter of design. Every approval reaching the gate is a
      // session's approve-pr.sh POST the daemon delivers, and the one that
      // meets an already-stamped head is the CI-green retry of a withheld
      // approval: its COMMENT stamped the head, and refusing the APPROVE here
      // would strand the approval that withholding promised.
      const mechanical = intent.reviewPurpose === "escalation";
      const approval = (body.event ?? "").toUpperCase() === "APPROVE";
      if (
        deps.guards.skip_unchanged_head &&
        !mechanical &&
        !approval &&
        !hasNewEvidence(deps.store.reviewedHead(pr), head)
      ) {
        return refuse(intent, pr, "no-new-evidence", { head_sha: head });
      }

      // --- guard 1: a human approved this head; do not hold the gate ---
      if (
        deps.guards.downgrade_on_human_approval &&
        (body.event ?? "").toUpperCase() === "REQUEST_CHANGES"
      ) {
        let approver: string | null = null;
        try {
          approver = humanApprovalAtHead(await deps.adapter.listReviews(pr), {
            head_sha: head,
            author: ref?.author ?? "",
            botLogin: deps.botLogin,
          });
        } catch (err) {
          // A failed read must not block a review — the worst case here is an
          // unsoftened review, not a post-merge or duplicate one.
          log(`guard: review listing failed on #${pr}`, err);
        }
        if (approver) {
          log(
            `guard: #${pr} REQUEST_CHANGES → COMMENT (@${approver} approved ${head.slice(0, 7)})`,
          );
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
        if (ci && ciBlocksApproval(ci, { noChecksIsRed: deps.guards.no_checks_is_red })) {
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
      // The mark is stamped only for a substantive review that really reached
      // GitHub. A mechanically-authored COMMENT — the migration pre-check,
      // the escalation note — is deterministic mechanics,
      // not the round's verdict; letting one claim the head makes guard 2
      // suppress the substantive review that follows. Keyed on the PRESENCE of
      // a `reviewPurpose` rather than on each spelling, so a future purpose
      // cannot claim a head by being forgotten here.
      if (intent.kind !== "create_review" || intent.reviewPurpose || !result.executed || !intent.pr)
        return;
      const body = (intent.body ?? {}) as ReviewBody;
      if (!body.commit_id) return;
      deps.store.recordReviewedHead(intent.pr, {
        head_sha: body.commit_id,
        posted_event: (body.event ?? "").toUpperCase() || null,
      });
    },
  };
}

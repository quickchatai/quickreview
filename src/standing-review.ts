// The ONE reading of a reviewed-head mark for lifecycle decisions.
//
// `reviewed_heads` is stamped in two steps by two writers. The shell posting
// route (scripts/guards.sh `guard_stamp_reviewed_head`) writes `head_sha` and
// `posted_event` the moment a review reaches GitHub; the verdict watcher then
// enriches the same row with `verdict` and `round_no` when it consumes the
// session's verdict file. A crash, an overdue round or a guard refusal between
// the two leaves a row that is fully substantive — a REQUEST_CHANGES review
// stands on GitHub — with a null `verdict`.
//
// PR #5409 round 18 (2026-09-01) is what happens when consumers disagree about
// that row. Posting guard 2 read it as "reviewed" (it keys on head + reply
// only) while dispatch read `verdict` alone, saw null, and allocated a full
// round whose review the guard then correctly refused. 29 minutes and $1.92 of
// healthy lens work, zero comments posted, and a FAILED_LOUD incident for an
// outcome that was never a failure.
//
// So: every lifecycle consumer — dispatch's no-new-evidence skip and system
// re-trigger classifier, the delta recheck's standing-approval test, the
// reconcile backstops, the anomaly return-state, and's exact-head
// retirement — reads the mark through `standingReview`/`standingVerdict`
// below and nowhere else. `tests/standing-review.test.ts` pins that
// structurally: a raw `.verdict` read on a mark outside this module fails.
//
// The rules, in order:
//   1. A decided `verdict` wins. Normalized, so the retired `ESCALATE`
//      spelling folds to NEEDS_HUMAN exactly as everywhere else.
//   2. NEEDS_HUMAN/ESCALATE is UNDECIDED: it never counts as a
//      standing verdict and never suppresses a re-run or a posting. The
//      carve-out `hasNewEvidence` has carried since 2026-08-19 is preserved
//      byte-for-byte in meaning.
//   3. With no decided verdict, `posted_event` APPROVE / REQUEST_CHANGES is
//      the same substantive review before enrichment — the shape
//      recovery already recognized and dispatch did not.
//   4. `posted_event` COMMENT alone proves that SOMETHING was posted and
//      nothing about what was decided: an approval withheld for red CI, a
//      REQUEST_CHANGES softened by guard 1, or a legacy mechanical comment
//      all look identical here. It is never guessed into a verdict.
import type { ReviewedHeadRow } from "./state.js";
import { normalizeVerdict } from "./types.js";

export type StandingDecidedVerdict = "APPROVE" | "REQUEST_CHANGES";

export type StandingReview =
  /** No mark: nothing has ever been reviewed on this PR. */
  | { kind: "none" }
  /** A legacy NEEDS_HUMAN/ESCALATE mark: reviewed, not decided. */
  | { kind: "undecided" }
  /** A substantive review stands; `source` says which field proved it. */
  | { kind: "decided"; verdict: StandingDecidedVerdict; source: "verdict" | "posted_event" }
  /** Something was posted (or a bare head stamp) but no verdict can be read
   * off the row without guessing. */
  | { kind: "unknown"; posted_event: string | null };

export function standingReview(mark: ReviewedHeadRow | undefined | null): StandingReview {
  if (!mark) return { kind: "none" };
  const decided = normalizeVerdict(mark.verdict);
  if (decided === "NEEDS_HUMAN") return { kind: "undecided" };
  if (decided === "APPROVE" || decided === "REQUEST_CHANGES") return { kind: "decided", verdict: decided, source: "verdict" };
  // Exact spelling, deliberately: both writers of `posted_event` (the gate's
  // after-step and guards.sh) stamp the upper-case GitHub event, so a
  // differently-cased value is a lookalike and is NOT proof (pinned by
  // tests/operator-recovery.test.ts).
  const posted = mark.posted_event;
  if (posted === "APPROVE" || posted === "REQUEST_CHANGES") return { kind: "decided", verdict: posted, source: "posted_event" };
  return { kind: "unknown", posted_event: mark.posted_event ?? null };
}

/** The decided standing verdict, or null when none stands (no mark, an
 * undecided legacy mark, or a COMMENT-only / bare mark). */
export function standingVerdict(mark: ReviewedHeadRow | undefined | null): StandingDecidedVerdict | null {
  const standing = standingReview(mark);
  return standing.kind === "decided" ? standing.verdict : null;
}

/** The lifecycle state a PR returns to when its standing review is all that
 * stands — the same table `transition` applies to a `verdict` event, so a
 * restore can never land somewhere a verdict could not. */
export function standingLifecycleState(verdict: StandingDecidedVerdict | null): "awaiting_author" | "tracked" {
  return verdict === "REQUEST_CHANGES" ? "awaiting_author" : "tracked";
}

/** The mark fields a durable event or receipt records so a later reader can
 * restore state from evidence rather than from session prose. */
export interface StandingMarkSnapshot {
  head_sha: string;
  reviewed_at: string;
  verdict: string | null;
  posted_event: string | null;
  round_no: number | null;
  last_author_reply_at: string | null;
}

export function snapshotMark(mark: ReviewedHeadRow): StandingMarkSnapshot {
  return {
    head_sha: mark.head_sha,
    reviewed_at: mark.reviewed_at,
    verdict: mark.verdict,
    posted_event: mark.posted_event,
    round_no: mark.round_no,
    last_author_reply_at: mark.last_author_reply_at,
  };
}

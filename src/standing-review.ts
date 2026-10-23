// The ONE reading of a reviewed-head mark for lifecycle decisions.
//
// `reviewed_heads` is stamped in two steps by two writers. The gate's
// after-step (src/guards.ts) writes `head_sha` and
// `posted_event` the moment a review reaches GitHub; the verdict watcher then
// enriches the same row with `verdict` and `round_no` when it consumes the
// session's verdict file. A crash, an overdue round or a guard refusal between
// the two leaves a row that is fully substantive — a REQUEST_CHANGES review
// stands on GitHub — with a null `verdict`.
//
// Consumers must not disagree about that row: posting guard 2 reads it as
// "reviewed" (it keys on head + reply only), so a reader that looked at
// `verdict` alone would allocate a full round whose review the guard then
// refuses — paid lens work, nothing posted, and a spurious failure.
//
// So every lifecycle consumer — dispatch's no-new-evidence skip and system
// re-trigger classifier, the delta recheck's standing-approval test, the
// reconcile backstops, the anomaly return-state, and the exact-head
// retirement — reads the mark through `standingReview`/`standingVerdict`
// below and nowhere else. `tests/standing-review.test.ts` pins that
// structurally: a raw `.verdict` read on a mark outside this module fails.
//
// The rules, in order:
//   1. A decided `verdict` wins. Normalized, so the legacy `ESCALATE`
//      spelling folds to NEEDS_HUMAN exactly as everywhere else.
//   2. NEEDS_HUMAN/ESCALATE is UNDECIDED: it never counts as a standing
//      verdict and never suppresses a re-run or a posting (the same carve-out
//      `hasNewEvidence` applies).
//   3. With no decided verdict, `posted_event` APPROVE / REQUEST_CHANGES is
//      the same substantive review before enrichment.
//   4. `posted_event` COMMENT alone proves that SOMETHING was posted and
//      nothing about what was decided: an approval withheld for red CI, a
//      REQUEST_CHANGES softened by guard 1, or a legacy mechanical comment
//      all look identical here. It is never guessed into a verdict.
import type { ReviewedHeadRow } from "./storerows.js";
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
  if (decided === "APPROVE" || decided === "REQUEST_CHANGES")
    return { kind: "decided", verdict: decided, source: "verdict" };
  // Exact spelling, deliberately: both writers of `posted_event` (the gate's
  // after-step, and the retired shell stamp on older rows) stamp the upper-case GitHub event, so a
  // differently-cased value is a lookalike and is NOT proof (pinned by
  // tests/operator-recovery.test.ts).
  const posted = mark.posted_event;
  if (posted === "APPROVE" || posted === "REQUEST_CHANGES")
    return { kind: "decided", verdict: posted, source: "posted_event" };
  return { kind: "unknown", posted_event: mark.posted_event ?? null };
}

/** The decided standing verdict, or null when none stands (no mark, an
 * undecided legacy mark, or a COMMENT-only / bare mark). */
export function standingVerdict(
  mark: ReviewedHeadRow | undefined | null,
): StandingDecidedVerdict | null {
  const standing = standingReview(mark);
  return standing.kind === "decided" ? standing.verdict : null;
}

/** The lifecycle state a verdict leaves a PR in: a REQUEST_CHANGES waits on
 * the author; anything else — an approval, a legacy NEEDS_HUMAN, nothing
 * decided — is tracked. The one table `transition` applies to a `verdict`
 * and a `round_overdue` event and a restore applies to the standing review,
 * so a restore can never land somewhere a verdict could not. */
export function standingLifecycleState(
  verdict: string | null | undefined,
): "awaiting_author" | "tracked" {
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

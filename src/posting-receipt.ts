import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReviewedHeadRow } from "./state.js";
import { snapshotMark, standingReview, type StandingMarkSnapshot } from "./standing-review.js";
import type { VerdictFile } from "./types.js";

export type PostingReceiptStatus = "prepared" | "confirmed" | "dryrun";

/** A receipt for a review the shell route ATTEMPTED to post:
 * `prepared` brackets the ambiguous transport window, `confirmed` carries
 * GitHub's returned identity, `dryrun` records the intent that was written to
 * `state/dryrun/` instead of sent. */
export interface PostingReceipt {
  version: 1;
  posting_key: string;
  marker: string;
  pr: number;
  round_no: number;
  head_sha: string;
  intended_event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  actual_event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  status: PostingReceiptStatus;
  payload_sha256: string;
  prepared_at: string;
  confirmed_at?: string;
  gh_review_id?: number;
  gh_commit_id?: string;
  gh_state?: string;
}

/**
 * The terminal record of a review the shell route was FORBIDDEN to post
 *: posting guard 2 found the head already reviewed with no author
 * reply since, and refused before any receipt was prepared. It proves that no
 * POST was attempted — it is written only by `scripts/post-review.sh`, only
 * before `prepare`, and `scripts/posting-receipt.py` refuses to write it over
 * any attempted-post status — and it carries the standing mark the guard read,
 * so settlement restores state from evidence rather than from session prose.
 *
 * Deliberately a separate shape rather than a fourth `PostingReceiptStatus`:
 * it has no `actual_event` (nothing was posted), no payload hash and no
 * GitHub identity, and every consumer that handles it must say so by name.
 */
export interface GuardedNoopReceipt {
  version: 1;
  posting_key: string;
  marker: string;
  pr: number;
  round_no: number;
  head_sha: string;
  status: "skipped";
  skip_reason: "no-new-evidence";
  /** The event the session asked for; recorded for the audit, never applied. */
  intended_event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  /** Which mode the refusing script ran in. Audit only: a guard-2 refusal is a
   * no-op in either mode, and the record is accepted in either. */
  mode: "live" | "dryrun";
  skipped_at: string;
  standing_mark: StandingMarkSnapshot;
}

/** Everything the round's receipt file can legitimately hold. */
export type PostingOutcome = PostingReceipt | GuardedNoopReceipt;

export function roundPostingKey(pr: number, roundNo: number, headSha: string): string {
  return `v1:${pr}:${roundNo}:${headSha.toLowerCase()}`;
}

export function postingMarker(key: string): string {
  return `<!-- qcr-post:${key} -->`;
}

export function postingReceiptPath(dir: string, pr: number, roundNo: number): string {
  return join(dir, `pr-${pr}-round-${roundNo}.json`);
}

function event(value: unknown): PostingReceipt["actual_event"] | undefined {
  return value === "APPROVE" || value === "REQUEST_CHANGES" || value === "COMMENT" ? value : undefined;
}

function isoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/** The identity fields every outcome shape shares, validated once. */
function identityOk(value: Partial<PostingReceipt | GuardedNoopReceipt>): boolean {
  return value.version === 1 && typeof value.posting_key === "string" &&
    value.marker === postingMarker(value.posting_key) &&
    typeof value.pr === "number" && Number.isInteger(value.pr) &&
    typeof value.round_no === "number" && Number.isInteger(value.round_no) &&
    typeof value.head_sha === "string" && value.head_sha.length > 0;
}

/**
 * Parse a guarded no-op record, failing closed on every lookalike. Beyond the
 * shared identity, the standing mark inside must itself SATISFY guard 2 —
 * same head as the record, a decided or at least posted review, no author
 * reply at or after it, not an undecided NEEDS_HUMAN — because a record whose
 * own evidence says the guard would have let the post through is not a
 * guard-2 refusal, whatever its status field claims.
 */
function parseGuardedNoop(value: Partial<GuardedNoopReceipt> & { standing_mark?: Partial<StandingMarkSnapshot> }): GuardedNoopReceipt | undefined {
  if (
    value.status !== "skipped" || value.skip_reason !== "no-new-evidence" ||
    !event(value.intended_event) ||
    (value.mode !== "live" && value.mode !== "dryrun") ||
    !isoDate(value.skipped_at) ||
    !value.standing_mark || typeof value.standing_mark !== "object"
  ) return undefined;
  const recorded = value.standing_mark;
  if (
    typeof recorded.head_sha !== "string" || recorded.head_sha.toLowerCase() !== value.head_sha!.toLowerCase() ||
    !isoDate(recorded.reviewed_at) ||
    !(recorded.verdict === null || typeof recorded.verdict === "string") ||
    !(recorded.posted_event === null || typeof recorded.posted_event === "string") ||
    !(recorded.round_no === null || (typeof recorded.round_no === "number" && Number.isInteger(recorded.round_no))) ||
    !(recorded.last_author_reply_at === null || isoDate(recorded.last_author_reply_at))
  ) return undefined;
  // The guard-2 condition, re-derived from the record's own evidence. `>=`
  // reads an ambiguous same-millisecond reply as new evidence, exactly as
  // guards.ts / guards.sh do.
  if (recorded.last_author_reply_at !== null && recorded.last_author_reply_at! >= recorded.reviewed_at!) return undefined;
  const asRow: ReviewedHeadRow = {
    pr: value.pr!,
    head_sha: recorded.head_sha,
    reviewed_at: recorded.reviewed_at!,
    verdict: recorded.verdict ?? null,
    posted_event: recorded.posted_event ?? null,
    round_no: recorded.round_no ?? null,
    last_author_reply_at: recorded.last_author_reply_at ?? null,
  };
  // Read through the one interpretation: an undecided mark would not have
  // been refused by guard 2, so a record claiming it was is a lookalike.
  if (standingReview(asRow).kind === "undecided") return undefined;
  return {
    version: 1,
    posting_key: value.posting_key!,
    marker: value.marker!,
    pr: value.pr!,
    round_no: value.round_no!,
    head_sha: value.head_sha!,
    status: "skipped",
    skip_reason: "no-new-evidence",
    intended_event: value.intended_event!,
    mode: value.mode,
    skipped_at: value.skipped_at,
    standing_mark: {
      head_sha: recorded.head_sha,
      reviewed_at: recorded.reviewed_at!,
      verdict: asRow.verdict,
      posted_event: asRow.posted_event,
      round_no: asRow.round_no,
      last_author_reply_at: asRow.last_author_reply_at,
    },
  };
}

export function parsePostingReceipt(raw: string): PostingOutcome | undefined {
  try {
    const value = JSON.parse(raw) as Partial<PostingReceipt>;
    if (!value || typeof value !== "object" || !identityOk(value)) return undefined;
    if ((value as { status?: unknown }).status === "skipped") return parseGuardedNoop(value as Partial<GuardedNoopReceipt>);
    if (
      !event(value.intended_event) || !event(value.actual_event) ||
      (value.status !== "prepared" && value.status !== "confirmed" && value.status !== "dryrun") ||
      typeof value.payload_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.payload_sha256) ||
      !isoDate(value.prepared_at)
    ) return undefined;
    if (value.status === "confirmed") {
      const expectedState = value.actual_event === "APPROVE"
        ? "APPROVED"
        : value.actual_event === "REQUEST_CHANGES"
          ? "CHANGES_REQUESTED"
          : "COMMENTED";
      if (
        typeof value.gh_review_id !== "number" || !Number.isInteger(value.gh_review_id) ||
        typeof value.gh_commit_id !== "string" || value.gh_commit_id.toLowerCase() !== value.head_sha!.toLowerCase() ||
        value.gh_state !== expectedState ||
        !isoDate(value.confirmed_at)
      ) return undefined;
    }
    return value as PostingReceipt;
  } catch {
    return undefined;
  }
}

export function receiptMatchesVerdict(receipt: PostingReceipt, verdict: VerdictFile): boolean {
  if (receipt.pr !== verdict.pr || receipt.round_no !== verdict.round_no || receipt.head_sha.toLowerCase() !== verdict.head_sha.toLowerCase()) return false;
  if (verdict.verdict === "REQUEST_CHANGES") return receipt.actual_event === "REQUEST_CHANGES" || receipt.actual_event === "COMMENT";
  if (verdict.verdict === "APPROVE") return verdict.approval_withheld === true ? receipt.actual_event === "COMMENT" : receipt.actual_event === "APPROVE";
  return receipt.actual_event === "COMMENT";
}

/**
 * Does the guarded no-op's recorded standing mark still describe the LIVE
 * mark? Every field but the author-reply memory must agree: the reply memory
 * is allowed to have moved forward (an author replying after the refusal is
 * new evidence for the NEXT interaction, not a contradiction of this one),
 * but a mark re-stamped at another head, at another time, or with another
 * event since the refusal means state changed under the record, and the
 * record is then no authority for restoring anything.
 */
export function guardedNoopMatchesMark(noop: GuardedNoopReceipt, mark: ReviewedHeadRow | undefined): boolean {
  if (!mark) return false;
  const live = snapshotMark(mark);
  const recorded = noop.standing_mark;
  return live.head_sha.toLowerCase() === recorded.head_sha.toLowerCase()
    && live.head_sha.toLowerCase() === noop.head_sha.toLowerCase()
    && live.reviewed_at === recorded.reviewed_at
    && live.verdict === recorded.verdict
    && live.posted_event === recorded.posted_event
    && live.round_no === recorded.round_no;
}

export function readPostingReceipt(dir: string, pr: number, roundNo: number): PostingOutcome | undefined {
  try {
    return parsePostingReceipt(readFileSync(postingReceiptPath(dir, pr, roundNo), "utf8"));
  } catch {
    return undefined;
  }
}

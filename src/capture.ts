// Human-comment capture.
//
// Every human comment on a PR this system tracks is kept as a durable local
// record. The reason it is not optional: the companion cannot read GitHub, and
// review prose has no local copy anywhere (`bot_comments` stores ids only) —
// so a comment not captured as it arrives is unrecoverable once the PR closes.
//
// THREE PROPERTIES, all load-bearing:
//
//  1. **Capture is a SIDE RECORD; routing does not change.** Nothing here is
//     part of webhook.ts's `Interpretation` union, and nothing here can alter
//     which kind an event interprets as. A `[feedback]`-prefixed comment still
//     diverts to the feedback sink before author_reply; an untagged reply in a
//     bot thread still reaches ping-pong; a top-level comment is still
//     `ignored` for routing purposes — and is recorded all the same.
//     Mistaking a genuine reply for feedback silently ignores the author,
//     which is worse than losing a signal; broad capture is what makes erring
//     toward the reply cost no evidence.
//
//  2. **Nothing classifies at capture time.** There is no heuristic here that
//     decides what "is" feedback. The `tagged` column records only the plain
//     fact that the body starts with `[feedback]` — the tag's privileges (read
//     first, and the ONLY thing that may soften the review the same day via
//     the tag-gated `feedback-day-validate` addendum) stay in feedback.ts.
//     The companion sorts the record later, with the whole episode in front
//     of it.
//
//  3. **Capture never writes to GitHub.** Reads are direct (adapter
//     convention); there is no mutation path in this module and none may be
//     added (CLAUDE.md rule 1).
import { isFeedbackBody } from "./feedback.js";
import type { IssueCommentFull, ReviewCommentFull, ReviewFull } from "./github.js";

/** Where a captured comment sat. `review` is a submitted review's own body. */
export type CommentSource = "review_comment" | "issue_comment" | "review";

/** One captured comment, engine-agnostic. `comment_id` is GitHub's stable id
 * (the review id when `source === "review"`) — the dedupe identity, never the
 * body text. */
export interface CapturedComment {
  pr: number;
  source: CommentSource;
  comment_id: number;
  in_reply_to_id: number | null;
  /** The conversation this comment belongs to: the thread root for an inline
   * comment, the review id for a review body, null for a top-level comment
   * (GitHub gives PR conversation comments no thread of their own). */
  thread_id: number | null;
  /** The submitted review an inline comment was posted under, when any. */
  review_id: number | null;
  author: string;
  /** GitHub's account type — recorded so a bot and a human can still be told
   * apart in the record itself, even though only humans are captured. */
  author_type: string;
  /** Body starts with `[feedback]`. A recorded FACT about the text, not a
   * classification of the comment. */
  tagged: boolean;
  path: string | null;
  line: number | null;
  body: string;
  /** GitHub's own timestamp when the payload carried one. */
  created_at: string | null;
  /** A submitted review's state (`approved` | `changes_requested` |
   * `commented`), lowercased — the learner's "a human asked for changes".
   * Null for comments, and when the payload carried none. A
   * recorded fact, like `tagged`: nothing routes on it. */
  review_state?: string | null;
}

export type CaptureOutcome = { captured: CapturedComment } | { skipped: string; pr?: number };

export interface CaptureDeps {
  botLogin: string;
  /** Capture is scoped to PRs this system tracks — "a reviewed PR". An
   * untracked PR's chatter is none of the reviewer's business and would drown
   * the record in repo-wide noise. */
  isTrackedPr: (pr: number) => boolean;
}

/** The bot's own identity is the configured `[github] bot_login`; GitHub types every app
 * account as `Bot`, and other apps (merge queue, housekeeping) are bots too.
 * All three tests are cheap and any one of them is disqualifying. */
export function isBotIdentity(
  login: string | null | undefined,
  type: string | null | undefined,
  botLogin: string,
): boolean {
  const name = login ?? "";
  return type === "Bot" || name === botLogin || /\[bot\]$/i.test(name);
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

// ---- the webhook side --------------------------------------------------------

/**
 * Capture decision for one delivery. PURE — it reads the raw payload and
 * returns a record or a reason, and it is deliberately NOT the interpreter:
 * webhook.ts calls both, side by side, and the interpretation is unaffected by
 * whatever this returns.
 */
export function captureFromEvent(
  event: string,
  action: string | null,
  payload: any,
  deps: CaptureDeps,
): CaptureOutcome {
  switch (event) {
    case "pull_request_review_comment":
      return captureReviewCommentEvent(action, payload, deps);
    case "issue_comment":
      return captureIssueCommentEvent(action, payload, deps);
    case "pull_request_review":
      return captureReviewEvent(action, payload, deps);
    default:
      return { skipped: `not a comment event: ${event}` };
  }
}

function admit(pr: number, user: any, body: string, deps: CaptureDeps): string | null {
  if (!Number.isInteger(pr) || pr <= 0) return "no PR number";
  if (isBotIdentity(user?.login, user?.type, deps.botLogin)) return "bot author";
  if (body.trim() === "") return "empty body";
  if (!deps.isTrackedPr(pr)) return "PR not tracked";
  return null;
}

function captureReviewCommentEvent(
  action: string | null,
  payload: any,
  deps: CaptureDeps,
): CaptureOutcome {
  if (action !== "created") return { skipped: `review-comment action: ${action}` };
  const c = payload?.comment;
  const pr: number = payload?.pull_request?.number ?? 0;
  if (!c) return { skipped: "review comment payload without comment", pr };
  const body = str(c.body);
  const no = admit(pr, c.user, body, deps);
  if (no) return { skipped: no, pr };
  const inReplyTo = num(c.in_reply_to_id);
  return {
    captured: {
      pr,
      source: "review_comment",
      comment_id: Number(c.id),
      in_reply_to_id: inReplyTo,
      thread_id: inReplyTo ?? Number(c.id),
      review_id: num(c.pull_request_review_id),
      author: str(c.user?.login),
      author_type: str(c.user?.type) || "User",
      tagged: isFeedbackBody(body),
      path: typeof c.path === "string" ? c.path : null,
      line: num(c.line) ?? num(c.original_line),
      body,
      created_at: typeof c.created_at === "string" ? c.created_at : null,
    },
  };
}

function captureIssueCommentEvent(
  action: string | null,
  payload: any,
  deps: CaptureDeps,
): CaptureOutcome {
  if (action !== "created") return { skipped: `issue-comment action: ${action}` };
  const issue = payload?.issue;
  // Same discriminator the interpreter uses: an "issue" is a PR iff it carries
  // `pull_request`.
  if (!issue?.pull_request) return { skipped: "issue comment on a non-PR issue" };
  const c = payload?.comment;
  const pr: number = issue.number ?? 0;
  if (!c) return { skipped: "issue comment payload without comment", pr };
  const body = str(c.body);
  const no = admit(pr, c.user, body, deps);
  if (no) return { skipped: no, pr };
  return {
    captured: {
      pr,
      source: "issue_comment",
      comment_id: Number(c.id),
      in_reply_to_id: null,
      thread_id: null,
      review_id: null,
      author: str(c.user?.login),
      author_type: str(c.user?.type) || "User",
      tagged: isFeedbackBody(body),
      path: null,
      line: null,
      body,
      created_at: typeof c.created_at === "string" ? c.created_at : null,
    },
  };
}

function captureReviewEvent(
  action: string | null,
  payload: any,
  deps: CaptureDeps,
): CaptureOutcome {
  if (action !== "submitted") return { skipped: `review action: ${action}` };
  const r = payload?.review;
  const pr: number = payload?.pull_request?.number ?? 0;
  if (!r) return { skipped: "review payload without review", pr };
  const body = str(r.body);
  const no = admit(pr, r.user, body, deps);
  if (no) return { skipped: no, pr };
  return {
    captured: {
      pr,
      source: "review",
      comment_id: Number(r.id),
      in_reply_to_id: null,
      thread_id: Number(r.id),
      review_id: Number(r.id),
      author: str(r.user?.login),
      author_type: str(r.user?.type) || "User",
      tagged: isFeedbackBody(body),
      path: null,
      line: null,
      body,
      created_at: typeof r.submitted_at === "string" ? r.submitted_at : null,
      review_state: reviewStateOf(r.state),
    },
  };
}

/** GitHub's review state, lowercased (`CHANGES_REQUESTED` on the REST list,
 * `changes_requested` on the webhook), or null. */
export function reviewStateOf(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim().toLowerCase() : null;
}

// ---- the sweep side ----------------------------------------------------------
//
// The same record, built from the REST list rows the reconcile sweep reads.
// Kept here so the webhook and the backstop can never disagree about what a
// captured comment is; the caller filters bots with `isBotIdentity`.

export function capturedFromReviewComment(pr: number, c: ReviewCommentFull): CapturedComment {
  return {
    pr,
    source: "review_comment",
    comment_id: c.id,
    in_reply_to_id: c.in_reply_to_id,
    thread_id: c.in_reply_to_id ?? c.id,
    review_id: c.pull_request_review_id,
    author: c.user,
    author_type: c.user_type ?? "User",
    tagged: isFeedbackBody(c.body),
    path: c.path || null,
    line: c.line,
    body: c.body,
    created_at: c.created_at ?? null,
  };
}

export function capturedFromIssueComment(pr: number, c: IssueCommentFull): CapturedComment {
  return {
    pr,
    source: "issue_comment",
    comment_id: c.id,
    in_reply_to_id: null,
    thread_id: null,
    review_id: null,
    author: c.user,
    author_type: c.user_type ?? "User",
    tagged: isFeedbackBody(c.body),
    path: null,
    line: null,
    body: c.body,
    created_at: c.created_at ?? null,
  };
}

export function capturedFromReview(pr: number, r: ReviewFull): CapturedComment {
  return {
    pr,
    source: "review",
    comment_id: r.id,
    in_reply_to_id: null,
    thread_id: r.id,
    review_id: r.id,
    author: r.user,
    author_type: r.user_type ?? "User",
    tagged: isFeedbackBody(r.body),
    path: null,
    line: null,
    body: r.body,
    created_at: r.submitted_at,
    review_state: reviewStateOf(r.state),
  };
}

/** A row is worth recording when a human wrote something. Shared by both
 * paths so "bot comments are not human comments" is decided once. */
export function isHumanCapture(c: CapturedComment, botLogin: string): boolean {
  if (isBotIdentity(c.author, c.author_type, botLogin)) return false;
  return c.body.trim() !== "";
}

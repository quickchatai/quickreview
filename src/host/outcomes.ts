// The host verbs' vocabulary: every word a `qcr --schema 3 host <verb>` call
// can answer with, and every word the board export's `setup` and `go_live`
// fields can carry. Closed sets, each mirrored by a schema file
// (schemas/host.v1.json, schemas/board.v1.json) and held to it by
// tests/host-contract.test.ts: a host maps these words to its own fixed text
// and never shows a guest's sentence, so a word it has not seen is a defect.
//
// A leaf: constants and types only, so the board export, the verbs and the
// tests read one declaration.
import { LOCK_HOLDERS, type LockHolder } from "../onboard/checklistlock.js";

/** The verbs of the `host` family. */
export const HOST_VERBS = [
  "setup",
  "review-now",
  "proof-start",
  "proof-result",
  "go-live",
  "set-trigger",
] as const;
export type HostVerb = (typeof HOST_VERBS)[number];

/**
 * What each verb can answer, in its `state`:
 *
 *   started      long work was started, detached; the board export's `setup`
 *                or `go_live` field follows it (setup, go-live), or the
 *                daemon took the practice round (proof-start)
 *   running      that same work is already under way: nothing new was started
 *   queued       the daemon queued the pull request (review-now)
 *   sent         the request is written and the daemon has not answered yet
 *                (review-now, proof-start; set-trigger, with `trigger`)
 *   done         the practice round finished: its review is in the payload
 *                (proof-result); or the reviewer was already live and
 *                nothing was run again or restarted (go-live); or the
 *                daemon took the trigger asked for, in `trigger`
 *                (set-trigger)
 *   not_started  no practice round was asked for on that pull request
 *   busy         something else holds the setup lock (`holder` says what)
 *   failed       the practice round did not produce a review (`reason`)
 *   refused      nothing was done (`reason`, and `message` in words)
 */
export const HOST_STATES = {
  setup: ["started", "running", "busy", "refused"],
  "review-now": ["queued", "sent", "refused"],
  "proof-start": ["started", "sent", "running", "busy", "refused"],
  "proof-result": ["running", "done", "failed", "not_started", "busy", "refused"],
  "go-live": ["started", "running", "done", "busy", "refused"],
  "set-trigger": ["done", "sent", "busy", "refused"],
} as const satisfies Record<HostVerb, readonly string[]>;

export type HostState<V extends HostVerb = HostVerb> = (typeof HOST_STATES)[V][number];

/** Why a verb refused, or why a practice round failed. */
export const HOST_REASONS = [
  // the call itself
  "usage",
  "in_session",
  "not_on_host",
  /** The install's config does not say a host manages it. */
  "not_host_managed",
  // setup
  "model_login_missing",
  "model_login_unreadable",
  "github_token_missing",
  "github_token_unreadable",
  "github_token_rejected",
  "github_unreachable",
  "repo_unreachable",
  "repo_mismatch",
  "auth_mismatch",
  /** The token file's token is not the App `--app-slug` names. */
  "identity_mismatch",
  "config_unreadable",
  "config_invalid",
  "launch_failed",
  // a review, a practice round
  "not_set_up",
  "already_live",
  "reviewer_not_running",
  "reviewer_unreachable",
  "review_refused",
  /** The daemon refused a host's choice of trigger. */
  "trigger_refused",
  "round_failed",
  "no_dry_run_record",
  "record_failed",
  // go-live
  "attestation_invalid",
  "proof_missing",
  "proof_mismatch",
  "proof_not_shown",
  "confirm_stale",
] as const;
export type HostReason = (typeof HOST_REASONS)[number];

/** What holds the setup lock when a verb answers `busy`. */
export const HOST_HOLDERS = LOCK_HOLDERS;
export type HostHolder = LockHolder;

/** The states of a long step a host started, as the board export says them. */
export const PROGRESS_STATES = ["running", "done", "failed"] as const;
export type ProgressState = (typeof PROGRESS_STATES)[number];

/** The steps a setup walk can be at, or stop at: switch-on's, without the two
 * that are never walked (the practice review and the go-live). */
export const SETUP_STEPS = [
  "machine_checks",
  "topology",
  "github_account",
  "escalation",
  "embeddings",
  "ingress",
  "memory",
  "login_share",
  "daemon_start",
  "bringup",
  "memory_user_keys",
  "verify_stack",
] as const;
export type SetupStepId = (typeof SETUP_STEPS)[number];

/** Why a setup walk failed. */
export const SETUP_PROBLEMS = [
  "docker_unavailable",
  "disk_low",
  "port_in_use",
  "machine_check_failed",
  "github_failed",
  "model_login_missing",
  "memory_failed",
  "start_failed",
  "verify_failed",
  "config_unreadable",
  "step_failed",
  /** The walk's process is gone and left no result. */
  "interrupted",
  "internal_error",
] as const;
export type SetupProblem = (typeof SETUP_PROBLEMS)[number];

/** Why a go-live walk failed. */
export const GO_LIVE_PROBLEMS = [
  /** The attestation on record no longer admits a go-live. */
  "attestation_rejected",
  /** The go-live step could not confirm the practice round with the daemon. */
  "proof_unverified",
  "config_failed",
  "restart_failed",
  "go_live_failed",
  "interrupted",
  "internal_error",
] as const;
export type GoLiveProblem = (typeof GO_LIVE_PROBLEMS)[number];

/**
 * Which pull requests the reviewer picks up by itself (`[github] trigger`,
 * packages/pi-plugin/src/reviewconfig.ts GITHUB_TRIGGERS, the same two): the
 * ones that carry the trigger label, or every one. What `set-trigger` takes
 * and answers with, and what the board export's `trigger` says.
 */
export const TRIGGER_WORDS = ["label", "all"] as const;
export type TriggerWord = (typeof TRIGGER_WORDS)[number];

// ---- the practice review's caps ----------------------------------------------

/** The review events GitHub takes: what a practice review would have been
 * sent as (src/boardfile.ts POSTED_EVENTS, the same three). */
export const REVIEW_EVENTS = ["APPROVE", "REQUEST_CHANGES", "COMMENT"] as const;
export type ReviewEvent = (typeof REVIEW_EVENTS)[number];

/** How many inline comments a practice review carries at most. */
export const PROOF_COMMENT_CAP = 50;
/** The longest review body printed, in characters. */
export const PROOF_BODY_CAP = 20_000;
/** The longest inline comment printed, in characters. */
export const PROOF_COMMENT_BODY_CAP = 4_000;
/** The longest file path printed, in characters. */
export const PROOF_PATH_CAP = 400;
/** The longest `message`, in characters. */
export const HOST_MESSAGE_CAP = 600;

// ---- the payloads -------------------------------------------------------------

/** The practice round a go-live is confirmed against. */
export interface HostProof {
  pr: number;
  round_no: number;
  verdict: string;
  completed_at: string;
}

/** One inline comment of the review as it would have been posted. */
export interface HostReviewComment {
  path: string;
  line: number;
  body: string;
  /** The body was cut at PROOF_COMMENT_BODY_CAP. */
  truncated?: true;
}

/** The review as it would have been posted. */
export interface HostReview {
  /** The review event GitHub would have been sent; absent when the record
   * names none of the three. */
  event?: ReviewEvent;
  body: string;
  /** The body was cut at PROOF_BODY_CAP. */
  body_truncated?: true;
  /** At most PROOF_COMMENT_CAP of them, in the review's order. */
  comments: HostReviewComment[];
  /** How many the review holds, the ones past the cap included. */
  comments_total: number;
}

/** What a host verb prints: one object, `schema_version` first. */
export interface HostPayload {
  schema_version: number;
  verb: HostVerb;
  state: HostState;
  reason?: HostReason;
  /** The refusal or failure in words, for a log; a host shows its own text. */
  message?: string;
  holder?: HostHolder;
  /** The trigger a set-trigger sent, with `done` (the daemon took it) or
   * `sent` (it has not answered yet). */
  trigger?: TriggerWord;
  /** The pull request the call named. */
  pr?: number;
  proof?: HostProof;
  review?: HostReview;
}

/** A verb's answer before it is stamped with the contract and the verb. */
export type HostAnswer = Omit<HostPayload, "schema_version" | "verb">;

export const refused = (reason: HostReason, message: string): HostAnswer => ({
  state: "refused",
  reason,
  message: message.slice(0, HOST_MESSAGE_CAP),
});

/**
 * The process exit code of an answer: 0 when the verb did what it was asked
 * (or says what is already under way), 2 for a call it could not read, 1 for
 * any other refusal or failure. The JSON object is printed either way.
 */
export function exitCodeOf(answer: Pick<HostAnswer, "state" | "reason">): number {
  if (answer.state !== "refused" && answer.state !== "failed") return 0;
  return answer.reason === "usage" ? 2 : 1;
}

// Durable delivery of finished session reviews. This is NOT a round retry:
// payloads survive sessions/restarts and every resend uses the guarded adapter.
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  ciBlocksApproval,
  classifyCi,
  type CheckSummary,
} from "@quickchatai/pi-quickreview/src/cigate.js";
import type { GateResult, MutationIntent } from "@quickchatai/pi-quickreview/src/gate.js";
import {
  classifyGitHubFailure,
  type GitHubFailure,
} from "@quickchatai/pi-quickreview/src/githubcore.js";
import { bodyOnlyPayload, isAnchorRejection, validationText } from "./diffplacement.js";
import { inlineCommentFault } from "./posting.js";
import type { PostingRetryRow } from "./state.js";
import {
  postingMarker,
  postingReceiptPath,
  readPostingReceipt,
  roundPostingKey,
  withheldApprovalPosted,
  type PostingReceipt,
} from "./posting-receipt.js";

export interface PostingJob {
  version: 1;
  posting_key: string;
  repo: string;
  mode: "live" | "dryrun";
  pr: number;
  round_no: number;
  head_sha: string;
  intended_event: PostingReceipt["intended_event"];
  payload: {
    commit_id: string;
    event: PostingReceipt["actual_event"];
    body: string;
    comments?: unknown[];
  };
  payload_sha256: string;
  status: "pending" | "done" | "failed";
  attempts: number;
  created_at: string;
  next_attempt_at: string;
  attempted_at?: string;
  negative_at?: string;
  last_error?: string;
  /** Set by `PostingJournal.defer` — the session's POST got a
   * 5xx or no answer and no review carried the marker. The first failure;
   * the daemon's retry schedule (state.db `posting_retries`) runs from it. */
  deferred_at?: string;
  /** How many of the counted attempts ended with NO POST sent. Deferred
   * retry: of the ledger's attempts (a failed marker read, a gate read that
   * could not read the PR or its CI, a rate-limit refusal); they do not use
   * up the POST attempts, and while they happen the retry window stretches
   * (see `DEFERRED_READ_WINDOW_FACTOR`). Ordinary delivery: of `attempts`,
   * those the gate or the CI pre-check held before any POST
   * (`pr-unreadable`), so an exhausted job never claims a POST it did not
   * send. A deferral starts the count afresh. */
  unposted_attempts?: number;
  /** Deferred retry only: GitHub asked for a wait (`Retry-After`, a
   * rate-limit reset) that ends here. No attempt — read or POST — runs
   * before it; the retry window's end still exhausts the job on time. */
  not_before?: string;
  /** The ordinary delivery's window ran out (`failed` with this set): the
   * terminal proof the verdict watcher's posting proof reads as `exhausted`,
   * loud on every path and never a requeue. A POST attempted earlier may
   * still have landed; only GitHub's marker says. */
  exhausted_at?: string;
}
/** A delivery's answer: the gate's, plus the wait GitHub asked for when a read
 * the delivery depends on was refused for now (`pr-unreadable`). */
export type DeliveryResult = GateResult & { retryAfterMs?: number };
export interface PostingDeliveryAdapter {
  createReview(pr: number, payload: PostingJob["payload"]): Promise<DeliveryResult>;
  /** The deferred-posting retry's POST — the adapter's createReview
   * through the ONE gate with `postingRetry` set, so guard 5 lets it post at
   * its original commit_id and every other guard (4's softening included)
   * applies as it does on any gated review. Absent ⇒ no deferred retry. */
  createDeferredReview?(
    pr: number,
    payload: PostingJob["payload"],
    postingKey: string,
  ): Promise<DeliveryResult>;
  listReviewsFull(pr: number): Promise<
    Array<{
      id: number;
      user: string;
      state: string;
      body: string;
      commit_id: string;
      submitted_at: string | null;
    }>
  >;
}

// Same fsync + rename protocol as the posting journal. File and directory sync
// are both required: a saved retry schedule must outlive a container restart.
export function writePostingFile(path: string, value: unknown): void {
  const temp = `${path}.tmp-${randomUUID()}`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
  const parent = openSync(join(path, ".."), "r");
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}
/** The replayable job file of one PR round, in the posting-receipts dir. */
export function jobPath(dir: string, pr: number, round: number): string {
  return join(dir, `pr-${pr}-round-${round}.outbox.json`);
}
export function readPostingJob(path: string): PostingJob | undefined {
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as PostingJob;
    if (
      j.version !== 1 ||
      !Number.isInteger(j.pr) ||
      j.pr < 1 ||
      !Number.isInteger(j.round_no) ||
      j.round_no < 1 ||
      typeof j.head_sha !== "string" ||
      j.posting_key !== roundPostingKey(j.pr, j.round_no, j.head_sha) ||
      typeof j.repo !== "string" ||
      !["live", "dryrun"].includes(j.mode) ||
      !["pending", "done", "failed"].includes(j.status) ||
      !Number.isInteger(j.attempts) ||
      j.attempts < 0 ||
      !Number.isFinite(Date.parse(j.next_attempt_at)) ||
      !Number.isFinite(Date.parse(j.created_at)) ||
      (j.attempted_at !== undefined && !Number.isFinite(Date.parse(j.attempted_at))) ||
      (j.negative_at !== undefined && !Number.isFinite(Date.parse(j.negative_at))) ||
      (j.deferred_at !== undefined && !Number.isFinite(Date.parse(j.deferred_at))) ||
      (j.not_before !== undefined && !Number.isFinite(Date.parse(j.not_before))) ||
      (j.exhausted_at !== undefined && !Number.isFinite(Date.parse(j.exhausted_at))) ||
      (j.unposted_attempts !== undefined &&
        (!Number.isInteger(j.unposted_attempts) || j.unposted_attempts < 0)) ||
      !["APPROVE", "REQUEST_CHANGES", "COMMENT"].includes(j.intended_event) ||
      !j.payload ||
      j.payload.commit_id !== j.head_sha ||
      !["APPROVE", "REQUEST_CHANGES", "COMMENT"].includes(j.payload.event) ||
      typeof j.payload.body !== "string" ||
      !j.payload.body.includes(postingMarker(j.posting_key)) ||
      (j.payload.comments !== undefined && !Array.isArray(j.payload.comments)) ||
      j.payload_sha256 !== createHash("sha256").update(JSON.stringify(j.payload)).digest("hex") ||
      (j.payload.event !== j.intended_event && j.payload.event !== "COMMENT")
    )
      return undefined;
    if (j.payload.comments?.some((raw) => inlineCommentFault(raw) !== null)) return undefined;
    return j;
  } catch {
    return undefined;
  }
}
/** The reviews by one of `botLogins` at `head` that carry `key`'s posting
 * marker: the one identity rule the immediate handoff and the outbox share. */
export function markedReviewsOf<T extends { user: string; commit_id: string; body: string }>(
  reviews: readonly T[],
  botLogins: readonly string[],
  head: string,
  key: string,
): T[] {
  return reviews.filter(
    (r) =>
      botLogins.includes(r.user) &&
      r.commit_id.toLowerCase() === head.toLowerCase() &&
      r.body.includes(postingMarker(key)),
  );
}
export function pendingPosting(dir: string, pr: number, round: number, key: string): boolean {
  const j = readPostingJob(jobPath(dir, pr, round));
  return j?.posting_key === key && j.status === "pending";
}
/** The outbox's own eligibility: the only jobs its tick ever processes. A
 * pending job outside it — a dry-run snapshot, another repo's — is never
 * delivered by this daemon. (The tick also never runs on a dry-run daemon.) */
export function outboxProcesses(job: PostingJob, repo: string): boolean {
  return job.status === "pending" && job.mode === "live" && job.repo === repo;
}
/** A pending job for this round and posting key that this daemon's outbox
 * will deliver — {@link pendingPosting} narrowed by {@link outboxProcesses}. */
export function deliverablePosting(
  dir: string,
  pr: number,
  round: number,
  key: string,
  repo: string,
): boolean {
  const j = readPostingJob(jobPath(dir, pr, round));
  return j?.posting_key === key && outboxProcesses(j, repo);
}
/**
 * The CI pre-check every daemon delivery of an APPROVE carries: the ordinary
 * outbox's replay and the deferred retry alike. The checks at the payload's
 * commit are read BEFORE the gate, and what the read saw decides:
 *  - it failed (after the adapter's own retries): `pr-unreadable` with no
 *    POST sent, GitHub's requested wait carried along, so the delivery is
 *    retried later and an APPROVE is never posted over CI nobody could read;
 *  - CI is not green (red, pending, or none where that counts as red): the
 *    APPROVE goes to the gate as asked, carrying the state this read saw
 *    (`approvalCiWithheld`), and guard 4 withholds the approval on it with no
 *    read of its own — so a red CI this read SAW is never lost to a second
 *    read that fails open, and every guard reads the approval as an approval
 *    (guard 2's unchanged-head exemption, guard 4's withheld mark). Never a
 *    block, so a red-CI approval cannot loop on a refusal; the outbox's
 *    confirmation and the verdict apply read the COMMENT as the withheld
 *    approval (`daemon_retry`, `approval_withheld`), as for any guard 4
 *    softening;
 *  - CI is green: the APPROVE goes to the gate as asked.
 */
export async function withApprovalCiPrecheck(
  o: {
    /** The adapter's checks read. */
    listChecks: (head: string) => Promise<readonly CheckSummary[]>;
    /** `[guards] block_approve_on_red_ci`: off ⇒ no pre-check, as guard 4. */
    enabled: boolean;
    /** `[guards] no_checks_is_red`, as guard 4 reads it. */
    noChecksIsRed?: boolean;
    log?: (msg: string) => void;
  },
  pr: number,
  payload: PostingJob["payload"],
  post: (
    payload: PostingJob["payload"],
    approvalCiWithheld?: MutationIntent["approvalCiWithheld"],
  ) => Promise<GateResult>,
): Promise<DeliveryResult> {
  if (payload.event !== "APPROVE" || !o.enabled) return post(payload);
  const at = payload.commit_id.slice(0, 7);
  let ci: ReturnType<typeof classifyCi>;
  try {
    ci = classifyCi(await o.listChecks(payload.commit_id));
  } catch (err) {
    const f = classifyGitHubFailure(err);
    o.log?.(
      `#${pr}: approval delivery held — the checks at ${at} could not be read (${f.kind}: ${f.detail}); nothing was posted`,
    );
    return {
      executed: false,
      blocked: "pr-unreadable",
      ...(f.retryAfterMs !== undefined ? { retryAfterMs: f.retryAfterMs } : {}),
    };
  }
  if (ci !== "green" && ciBlocksApproval(ci, { noChecksIsRed: o.noChecksIsRed === true })) {
    o.log?.(`#${pr}: approval delivery withheld — CI ${ci} at ${at}; guard 4 posts the COMMENT`);
    return post(payload, ci);
  }
  return post(payload);
}

/** The deferred retry's window stretches to this many times
 * `posting_retry_window_min` while its attempts end with no POST sent: a
 * GitHub that cannot be read is not a posting that failed. A hard ceiling. */
export const DEFERRED_READ_WINDOW_FACTOR = 3;
/** The least gap between two deferred attempts, so an attempt whose offset
 * already passed (a stretched window, a daemon that was down) is not retried
 * on every tick. */
const DEFERRED_MIN_GAP_MS = 60_000;

/** What the deferred-posting retry needs beyond the outbox. */
export interface DeferredPostingDeps {
  /** The durable schedule: state.db `posting_retries`. */
  ledger: PostingRetryLedger;
  /** Attempt offsets from the first failure, ms, strictly increasing. */
  offsetsMs: readonly number[];
  /** Every attempt lies inside this window from the first failure. */
  windowMs: number;
  /** The POST: the adapter's createReview through the ONE MutationGate with
   * `postingRetry` set (guard 5 exempt, every other guard binding). */
  deliver: (
    pr: number,
    payload: PostingJob["payload"],
    postingKey: string,
  ) => Promise<DeliveryResult>;
  /** Does the round still owe this posting — running, same posting key? A
   * new push does NOT end the debt: the review posts at its original
   * commit_id. An operator's `u` (round cancelled) does. */
  owed: (job: PostingJob) => boolean;
  /** The window is spent or delivery is impossible: the verdict watcher's
   * posting proof now reads `failed` and every path fails the round loud. */
  onExhausted: (job: PostingJob, detail: string) => void;
}
export interface PostingRetryLedger {
  adoptPostingRetry(input: {
    posting_key: string;
    pr: number;
    round_no: number;
    head_sha: string;
    first_failed_at: string;
    now: string;
  }): PostingRetryRow;
  postingRetry(postingKey: string): PostingRetryRow | undefined;
  beginPostingRetryAttempt(postingKey: string, expected: number, now: string): boolean;
  notePostingRetryError(postingKey: string, error: string, now: string): void;
  settlePostingRetry(
    postingKey: string,
    status: "confirmed" | "exhausted" | "abandoned",
    detail: string | null,
    now: string,
  ): boolean;
}

/** The event a submitted GitHub review state says was posted; undefined for
 * any other state (PENDING, DISMISSED), which says nothing. */
function postedEventOf(state: string): PostingReceipt["actual_event"] | undefined {
  const s = state.toUpperCase();
  return s === "APPROVED"
    ? "APPROVE"
    : s === "CHANGES_REQUESTED"
      ? "REQUEST_CHANGES"
      : s === "COMMENTED"
        ? "COMMENT"
        : undefined;
}

/** A POST response that names the review it created. */
type ReviewIdentity = { id: number; commit_id: string; state: string };
function reviewIdentityOf(response: unknown): ReviewIdentity | undefined {
  const r = response as Partial<ReviewIdentity> | undefined;
  return r && typeof r.commit_id === "string" && typeof r.state === "string"
    ? (r as ReviewIdentity)
    : undefined;
}

/** GitHub's requested wait, as a not-before time from `now`; undefined
 * when it asked for none. */
function notBeforeOf(f: Pick<GitHubFailure, "retryAfterMs">, now: number): string | undefined {
  return f.retryAfterMs !== undefined && f.retryAfterMs > 0
    ? new Date(now + f.retryAfterMs).toISOString()
    : undefined;
}

/** The exact published snapshot, allowing only confirmed approval softening. */
function receiptMatchesJob(
  receipt: ReturnType<typeof readPostingReceipt>,
  job: PostingJob,
): boolean {
  if (
    !receipt ||
    receipt.posting_key !== job.posting_key ||
    receipt.head_sha.toLowerCase() !== job.head_sha.toLowerCase()
  )
    return false;
  if (receipt.status === "skipped") return true; // terminal refusal, never a replay
  return (
    receipt.payload_sha256.toLowerCase() === job.payload_sha256 &&
    receipt.intended_event === job.intended_event &&
    (receipt.actual_event === job.payload.event ||
      (receipt.status === "confirmed" && receipt.actual_event === "COMMENT"))
  );
}

/** The deferred receipt of this job, when its receipt says `deferred`. */
function deferredReceipt(dir: string, j: PostingJob): PostingReceipt | undefined {
  const r = readPostingReceipt(dir, j.pr, j.round_no);
  return r && r.status === "deferred" && receiptMatchesJob(r, j) ? r : undefined;
}

/** After a POST whose outcome is unknown, how long before its absence is
 * read at all: an accepted POST can take this long to show. The one policy
 * for an uncertain POST, the review outbox's and the thread reply's
 * (postops.ts) alike. */
export const QUIET_WINDOW_MS = 120_000;
/** And the least time between the two reads that must both find it absent
 * before it may be posted again. */
export const NEGATIVE_GAP_MS = 30_000;

/**
 * Where an uncertain POST stands after a read just found its marker absent.
 * GitHub offers no idempotency token, so one negative read proves nothing:
 *  - `quiet`: still inside the quiet window, `until` it ends;
 *  - `first-negative`: past it, and this is the first negative read — the
 *    caller records `now` as it and reads again after `until`;
 *  - `gap`: the second read came too soon after the first, `until`;
 *  - `post`: two negative reads apart, past the quiet window: it may be
 *    posted again.
 * Persisting `negative_at` and scheduling the next read are the caller's.
 */
export function uncertainPostStep(
  attemptedAt: string,
  negativeAt: string | undefined,
  now: number,
): { step: "quiet" | "first-negative" | "gap"; until: number } | { step: "post" } {
  const quietEnds = Date.parse(attemptedAt) + QUIET_WINDOW_MS;
  if (now < quietEnds) return { step: "quiet", until: quietEnds };
  if (negativeAt === undefined) return { step: "first-negative", until: now + NEGATIVE_GAP_MS };
  const gapEnds = Date.parse(negativeAt) + NEGATIVE_GAP_MS;
  if (now < gapEnds) return { step: "gap", until: gapEnds };
  return { step: "post" };
}
export class PostingOutbox {
  private busy = false;
  constructor(
    private readonly deps: {
      dir: string;
      repo: string;
      dryRun: boolean;
      botLogins: string[];
      /** `[github] auth = "user"`: receipts say `person_mode`, and an APPROVE
       * delivered as a COMMENT is the person-mode rule, not a guard-4
       * softening (posting-receipt.ts). */
      personMode?: boolean;
      adapter: PostingDeliveryAdapter;
      current: (job: PostingJob) => boolean;
      now?: () => Date;
      log: (message: string, job: PostingJob) => void;
      /** The deferred-posting retry. Absent ⇒ a deferred job is
       * never touched (nothing posts it; the verdict watcher's stage limits
       * still see it as in flight and fail loud once its window is over). */
      deferred?: DeferredPostingDeps;
      /** The ordinary delivery's bound (`posting_retry_window_min`), from
       * the job's `created_at`: past it a job the marker read did not find
       * on GitHub is failed and `onDeliveryExpired` makes it loud, never
       * retried for ever. Absent ⇒ unbounded. */
      deliveryWindowMs?: number;
      onDeliveryExpired?: (job: PostingJob, detail: string) => void;
    },
  ) {}
  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }
  async tick(): Promise<void> {
    if (this.busy || this.deps.dryRun || !existsSync(this.deps.dir)) return;
    this.busy = true;
    try {
      // Serial, bounded work per tick; a large outage backlog must not hold
      // the daemon's other loops. The schedule is on disk, not in this object.
      let processed = 0;
      for (const name of readdirSync(this.deps.dir)) {
        if (!/^pr-\d+-round-\d+\.outbox\.json$/.test(name)) continue;
        const path = join(this.deps.dir, name),
          job = readPostingJob(path);
        if (
          job &&
          outboxProcesses(job, this.deps.repo) &&
          job.deferred_at &&
          !this.recoverDeferredHandoff(path, job)
        ) {
          this.deps.log("posting deferred handoff unconfirmed — ordinary replay withheld", job);
          continue;
        }
        if (job && outboxProcesses(job, this.deps.repo) && deferredReceipt(this.deps.dir, job)) {
          // A deferred job runs on its own bounded schedule and is
          // never touched by the open-ended path below.
          if (await this.deliverDeferred(path, job)) processed++;
          if (processed >= 8) break;
          continue;
        }
        if (
          !job ||
          !outboxProcesses(job, this.deps.repo) ||
          (Date.parse(job.next_attempt_at) > this.now().getTime() && !this.windowPassed(job))
        )
          continue;
        await this.deliver(path, job);
        if (++processed >= 8) break;
      }
    } finally {
      this.busy = false;
    }
  }
  /** Finish an interrupted job-first handoff under the posting lock: the
   * job says `deferred_at`, and the receipt beside it is still `prepared`
   * (`PostingJournal.defer`) or not written at all (`deferUnattempted`). */
  private recoverDeferredHandoff(path: string, job: PostingJob): boolean {
    const receiptPath = postingReceiptPath(this.deps.dir, job.pr, job.round_no);
    const current = readPostingReceipt(this.deps.dir, job.pr, job.round_no);
    if (receiptMatchesJob(current, job) && current?.status !== "prepared") return true;
    const lock = `${receiptPath}.lock`;
    if (!this.acquire(lock)) return false;
    try {
      const fresh = readPostingJob(path);
      const receipt = readPostingReceipt(this.deps.dir, job.pr, job.round_no);
      if (
        !fresh ||
        !outboxProcesses(fresh, this.deps.repo) ||
        !fresh.deferred_at ||
        fresh.posting_key !== job.posting_key
      )
        return false;
      if (!receipt && !existsSync(receiptPath)) {
        // The job was written and the process stopped before the receipt.
        // Write the deferred receipt the handoff owed: the retry reads
        // GitHub for the marker before every POST, so it is safe whether or
        // not an attempt ran, and only a job with no attempt on record says
        // `unattempted`.
        writePostingFile(receiptPath, {
          version: 1,
          posting_key: fresh.posting_key,
          marker: postingMarker(fresh.posting_key),
          pr: fresh.pr,
          round_no: fresh.round_no,
          head_sha: fresh.head_sha.toLowerCase(),
          intended_event: fresh.intended_event,
          actual_event: fresh.payload.event,
          status: "deferred",
          payload_sha256: fresh.payload_sha256,
          prepared_at: fresh.attempted_at ?? fresh.deferred_at,
          deferred_at: fresh.deferred_at,
          defer_reason: fresh.last_error ?? "recovered interrupted deferred handoff",
          ...(fresh.attempted_at === undefined ? { unattempted: true as const } : {}),
          ...(this.deps.personMode ? { person_mode: true as const } : {}),
        } satisfies PostingReceipt);
        this.deps.log(
          "posting deferred handoff recovered: the deferred receipt was missing",
          fresh,
        );
        return true;
      }
      if (!receiptMatchesJob(receipt, fresh) || !receipt) return false;
      if (receipt.status !== "prepared") return true;
      if (
        receipt.payload_sha256 !== fresh.payload_sha256 ||
        receipt.head_sha !== fresh.head_sha ||
        receipt.intended_event !== fresh.intended_event ||
        receipt.actual_event !== fresh.payload.event
      )
        return false;
      writePostingFile(receiptPath, {
        ...receipt,
        status: "deferred",
        deferred_at: fresh.deferred_at,
        defer_reason: fresh.last_error ?? "recovered interrupted deferred handoff",
      });
      return true;
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  }
  private schedule(path: string, j: PostingJob, error: string, minimumMs = 0): void {
    j.last_error = error;
    const backoff = Math.min(900_000, 30_000 * 2 ** Math.min(j.attempts, 5));
    j.next_attempt_at = new Date(this.now().getTime() + Math.max(minimumMs, backoff)).toISOString();
    writePostingFile(path, j);
    this.deps.log(`posting pending: ${error}`, j);
  }
  /**
   * GitHub refused the job's review because it could not place an inline
   * comment (a 422 that does not say which). A 422 landed nothing, so the
   * snapshot is rewritten with every comment in the body (the job, then the
   * receipt beside it, both before the next POST) and the caller posts that
   * once more. Any other failure, or a review with no comments: false.
   */
  private foldAfterAnchorRejection(path: string, j: PostingJob, error: unknown): boolean {
    const f = classifyGitHubFailure(error);
    if (f.kind !== "rejected" || f.status !== 422 || (j.payload.comments?.length ?? 0) === 0)
      return false;
    const validation = validationText(error);
    if (!isAnchorRejection(validation)) return false;
    const count = j.payload.comments!.length;
    j.payload = bodyOnlyPayload(j.payload, postingMarker(j.posting_key));
    j.payload_sha256 = createHash("sha256").update(JSON.stringify(j.payload)).digest("hex");
    writePostingFile(path, j);
    const receiptPath = postingReceiptPath(this.deps.dir, j.pr, j.round_no);
    const receipt = readPostingReceipt(this.deps.dir, j.pr, j.round_no);
    if (receipt?.posting_key === j.posting_key)
      writePostingFile(receiptPath, { ...receipt, payload_sha256: j.payload_sha256 });
    this.deps.log(
      `posting: GitHub could not place ${count} inline comment(s) (${validation}); posting again with them in the body`,
      j,
    );
    return true;
  }
  private fail(path: string, j: PostingJob, reason: string): void {
    j.status = "failed";
    j.last_error = reason;
    writePostingFile(path, j);
    this.deps.log(`posting failed: ${reason}`, j);
  }
  /** The ordinary delivery's bound: a job older than the window (from its
   * `created_at`) that the marker read did not find on GitHub is failed and
   * made loud. A `prepared` receipt beside it stays as it is, so a POST that
   * may have landed still reads as ambiguous, never as "not posted". */
  private deliveryExpired(path: string, j: PostingJob, last: string): boolean {
    const windowMs = this.deps.deliveryWindowMs;
    if (windowMs === undefined || !this.windowPassed(j)) return false;
    const detail = `not delivered within ${Math.round(windowMs / 60_000)} min of being queued; last: ${last}`;
    // The terminal proof: the verdict watcher reads `exhausted_at` as an
    // exhausted posting (loud, never a requeue). A `prepared` receipt beside
    // it is left as it is.
    j.exhausted_at = this.now().toISOString();
    this.fail(path, j, `posting retry exhausted: ${detail}`);
    this.deps.onDeliveryExpired?.(j, detail);
    return true;
  }
  /** Is the ordinary delivery's window over for this job? Decided apart from
   * when its next attempt is due: a wait GitHub asked for that runs past the
   * window never stretches it. */
  private windowPassed(j: PostingJob): boolean {
    const windowMs = this.deps.deliveryWindowMs;
    return windowMs !== undefined && this.now().getTime() - Date.parse(j.created_at) >= windowMs;
  }
  /** The bot's reviews at the job's head that carry its posting marker. */
  private markedReviews<T extends { user: string; commit_id: string; body: string }>(
    reviews: readonly T[],
    j: PostingJob,
  ): T[] {
    return markedReviewsOf(reviews, this.deps.botLogins, j.head_sha, j.posting_key);
  }
  private confirm(
    path: string,
    j: PostingJob,
    review: { id: number; commit_id: string; state: string; submitted_at?: string | null },
    deliveredBy?: "daemon_retry",
  ): boolean {
    const state = review.state.toUpperCase();
    const event = postedEventOf(state);
    if (
      !event ||
      (event !== j.intended_event && event !== "COMMENT") ||
      !Number.isInteger(review.id) ||
      review.id <= 0 ||
      review.commit_id.toLowerCase() !== j.head_sha.toLowerCase()
    ) {
      this.fail(path, j, "GitHub returned a contradictory review identity");
      return false;
    }
    writePostingFile(postingReceiptPath(this.deps.dir, j.pr, j.round_no), {
      version: 1,
      posting_key: j.posting_key,
      marker: postingMarker(j.posting_key),
      pr: j.pr,
      round_no: j.round_no,
      head_sha: j.head_sha,
      intended_event: j.intended_event,
      actual_event: event,
      status: "confirmed",
      payload_sha256: createHash("sha256").update(JSON.stringify(j.payload)).digest("hex"),
      prepared_at: j.created_at,
      confirmed_at: review.submitted_at ?? this.now().toISOString(),
      gh_review_id: review.id,
      gh_commit_id: review.commit_id,
      gh_state: state,
      // An APPROVE that GitHub holds as a COMMENT was withheld for CI on the
      // gate (posting-receipt.ts `withheldApprovalPosted`).
      ...(deliveredBy ||
      withheldApprovalPosted(j.intended_event, event, this.deps.personMode === true)
        ? { delivered_by: "daemon_retry" as const }
        : {}),
      ...(this.deps.personMode ? { person_mode: true as const } : {}),
    } satisfies PostingReceipt);
    j.status = "done";
    writePostingFile(path, j);
    this.deps.log("posting confirmed", j);
    return true;
  }

  /**
   * When the deferred retry's next attempt is due. Attempt k (the ledger's
   * count, every attempt) is due at first failure + offsets[k]. The POST
   * budget is the offsets' length, counted without the attempts that sent no
   * POST (`unposted_attempts`); once those happened the window stretches to
   * `DEFERRED_READ_WINDOW_FACTOR` × the window, and attempts past the last
   * offset run one offset gap apart until that ceiling. A spent POST budget
   * is due at the window's end, which exhausts it.
   */
  private deferredSchedule(
    d: DeferredPostingDeps,
    row: PostingRetryRow,
    unposted: number,
    notBefore?: string,
  ): { first: number; due: number; windowEnd: number; posts: number } {
    const first = Date.parse(row.first_failed_at);
    const windowEnd = first + d.windowMs * (unposted > 0 ? DEFERRED_READ_WINDOW_FACTOR : 1);
    const posts = Math.max(0, row.attempts - unposted);
    const n = d.offsetsMs.length;
    let due: number;
    if (posts >= n) due = windowEnd;
    else if (row.attempts < n) due = first + d.offsetsMs[row.attempts]!;
    else {
      const last = d.offsetsMs[n - 1]!;
      const step = Math.max(last - (d.offsetsMs[n - 2] ?? 0), DEFERRED_MIN_GAP_MS);
      due = first + last + (row.attempts - n + 1) * step;
    }
    // The least gap holds only an attempt whose time already passed when the
    // last one ran (a catch-up): a configured offset still in the future is
    // kept as it is, however close to the last attempt.
    if (row.last_attempt_at && due <= Date.parse(row.last_attempt_at))
      due = Date.parse(row.last_attempt_at) + DEFERRED_MIN_GAP_MS;
    // GitHub's own wait comes first; the window's end still bounds it.
    if (notBefore) due = Math.max(due, Date.parse(notBefore));
    return { first, due: Math.min(due, windowEnd), windowEnd, posts };
  }

  /**
   * One step of a deferred posting's bounded retry. Returns whether
   * it did GitHub work (the tick's per-pass bound counts those).
   *
   * The schedule is the state.db row, adopted from the receipt's
   * `deferred_at` (`deferredSchedule`), and every attempt (1) is counted
   * durably first, (2) reads GitHub for the marker and confirms without
   * POSTing when the review is there, (3) stops if the round no longer owes
   * the posting, (4) POSTs through the gate, whose guards bind as on any
   * review (guard 5 excepted, by the intent's `postingRetry`). An attempt that
   * sends no POST (the marker read failed, the delivery's own reads could not
   * read the PR or its CI, GitHub rate-limited the POST) does not use up a
   * POST attempt and stretches the window up to its ceiling. A POST failure
   * past the budget, a due time past the window, or a permanent rejection
   * exhausts it: the job is failed, the row `exhausted`, and the verdict
   * watcher's posting proof fails the round loud. The receipt stays
   * `deferred` throughout — only a confirmation rewrites it — so the session
   * is refused any second POST.
   */
  private async deliverDeferred(path: string, job: PostingJob): Promise<boolean> {
    const d = this.deps.deferred;
    if (!d) return false;
    const receipt = deferredReceipt(this.deps.dir, job)!;
    const iso = () => this.now().toISOString();
    let row = d.ledger.adoptPostingRetry({
      posting_key: job.posting_key,
      pr: job.pr,
      round_no: job.round_no,
      head_sha: job.head_sha,
      first_failed_at: receipt.deferred_at ?? job.deferred_at ?? job.created_at,
      now: iso(),
    });
    if (row.status !== "pending") {
      // A settled row with a job still pending: a crash between the two
      // writes. The row is the authority.
      if (row.status === "confirmed") return false; // the receipt write will follow from GitHub
      job.status = "failed";
      job.last_error = row.last_error ?? `deferred posting ${row.status}`;
      writePostingFile(path, job);
      return false;
    }
    const { due } = this.deferredSchedule(d, row, job.unposted_attempts ?? 0, job.not_before);
    const dueIso = new Date(due).toISOString();
    if (job.next_attempt_at !== dueIso) {
      job.next_attempt_at = dueIso; // the board's "next retry"
      writePostingFile(path, job);
    }
    if (this.now().getTime() < due) return false;
    const lock = `${postingReceiptPath(this.deps.dir, job.pr, job.round_no)}.lock`;
    if (!this.acquire(lock)) return false;
    try {
      const fresh = readPostingJob(path);
      if (!fresh || fresh.status !== "pending" || !deferredReceipt(this.deps.dir, fresh))
        return false;
      const j = fresh;
      const unposted = j.unposted_attempts ?? 0;
      const { windowEnd } = this.deferredSchedule(d, row, unposted);
      const ceiling = Date.parse(row.first_failed_at) + d.windowMs * DEFERRED_READ_WINDOW_FACTOR;
      const lastChance = this.now().getTime() >= windowEnd;
      if (!d.ledger.beginPostingRetryAttempt(j.posting_key, row.attempts, iso())) return false;
      row = d.ledger.postingRetry(j.posting_key) ?? row;
      j.attempts = row.attempts; // every outcome below persists and logs the ledger's count
      const exhaust = (detail: string): void => {
        if (!d.ledger.settlePostingRetry(j.posting_key, "exhausted", detail, iso())) return;
        this.fail(path, j, `deferred posting exhausted: ${detail}`);
        d.onExhausted(j, detail);
      };
      const reschedule = (detail: string, what: string): void => {
        d.ledger.notePostingRetryError(j.posting_key, detail, iso());
        j.last_error = detail;
        j.next_attempt_at = new Date(
          this.deferredSchedule(d, row, j.unposted_attempts ?? 0, j.not_before).due,
        ).toISOString();
        writePostingFile(path, j);
        this.deps.log(`deferred posting attempt ${row.attempts} ${what}: ${detail}`, j);
      };
      // A POST was sent (or may have been) and failed.
      const failed = (detail: string): void => {
        const posts = row.attempts - unposted;
        if (lastChance || posts >= d.offsetsMs.length) {
          exhaust(
            `${posts} POST attempt(s) inside ${Math.round((windowEnd - Date.parse(row.first_failed_at)) / 60_000)} min of the first failure; last: ${detail}`,
          );
          return;
        }
        reschedule(detail, "failed");
      };
      // Nothing was sent: the attempt is given back to the POST budget, and
      // a wait GitHub asked for is kept on the job across ticks and restarts.
      const unsent = (
        detail: string,
        retryAfter: Pick<GitHubFailure, "retryAfterMs"> = {},
      ): void => {
        j.unposted_attempts = unposted + 1;
        const notBefore = notBeforeOf(retryAfter, this.now().getTime());
        if (notBefore) j.not_before = notBefore;
        if (this.now().getTime() >= ceiling) {
          // Say how many POSTs were sent in all: a deferral made before any
          // attempt may exhaust without one.
          const posts = row.attempts - j.unposted_attempts;
          exhaust(
            `GitHub could not be read for ${Math.round((d.windowMs * DEFERRED_READ_WINDOW_FACTOR) / 60_000)} min after the first failure (no POST sent by this attempt; ${posts} POST attempt(s) in all); last: ${detail}`,
          );
          return;
        }
        reschedule(detail, "sent no POST");
      };
      // GitHub asked for a wait that outlasts the window: the window's end
      // exhausts the job without calling GitHub before that wait is over.
      // The verdict watcher's own marker read still finds a review that
      // landed earlier.
      if (lastChance && j.not_before && Date.parse(j.not_before) > this.now().getTime()) {
        exhaust(
          `the retry window ended while GitHub's requested wait (until ${j.not_before}) still held; no POST past the window`,
        );
        return true;
      }
      delete j.not_before;
      // (2) Never post twice: GitHub first, every attempt.
      let reviews: Awaited<ReturnType<PostingDeliveryAdapter["listReviewsFull"]>>;
      try {
        reviews = await this.deps.adapter.listReviewsFull(j.pr);
      } catch (error) {
        unsent(`marker read failed: ${String(error)}`, classifyGitHubFailure(error));
        return true;
      }
      const matches = this.markedReviews(reviews, j);
      if (matches.length > 1) {
        exhaust("multiple reviews carry this posting key");
        return true;
      }
      if (matches.length === 1) {
        // `daemon_retry` either way: an APPROVE found as a COMMENT can only
        // be an earlier attempt's withheld approval (guard 4's softening)
        // whose answer was lost.
        if (this.confirm(path, j, matches[0]!, "daemon_retry"))
          d.ledger.settlePostingRetry(j.posting_key, "confirmed", null, iso());
        else exhaust("GitHub holds a contradictory review for this posting key");
        return true;
      }
      // (3) The round must still owe it. An operator's `u` cancelled it.
      if (!d.owed(j)) {
        d.ledger.settlePostingRetry(
          j.posting_key,
          "abandoned",
          "round no longer owes this posting",
          iso(),
        );
        this.fail(path, j, "deferred posting abandoned: round no longer running");
        return true;
      }
      if (lastChance) {
        exhaust(
          "the retry window passed before the next attempt could run (no POST past the window)",
        );
        return true;
      }
      // (4) Through the ONE gate.
      try {
        let result: Awaited<ReturnType<typeof d.deliver>>;
        try {
          result = await d.deliver(j.pr, j.payload, j.posting_key);
        } catch (error) {
          if (!this.foldAfterAnchorRejection(path, j, error)) throw error;
          result = await d.deliver(j.pr, j.payload, j.posting_key);
        }
        if (result.blocked) {
          // `pr-unreadable`: the gate's PR read, or the approval's CI
          // pre-check, could not read GitHub. No POST was sent.
          if (result.blocked === "pr-unreadable")
            unsent(`posting guard: ${result.blocked}`, result);
          else exhaust(`posting guard refused at retry time: ${result.blocked}`);
          return true;
        }
        if (!result.executed) {
          exhaust("the gate did not execute the delivery (dry-run)");
          return true;
        }
        const response = reviewIdentityOf(result.response);
        if (!response) {
          // Executed but unreadable: the next attempt's marker read decides.
          failed("POST response lacks a review identity");
          return true;
        }
        if (this.confirm(path, j, response, "daemon_retry"))
          d.ledger.settlePostingRetry(j.posting_key, "confirmed", null, iso());
        else exhaust("GitHub returned a contradictory review identity");
      } catch (error) {
        const f = classifyGitHubFailure(error);
        if (f.kind === "rate_limited") unsent(`rate limited: ${String(error)}`, f);
        else if (f.kind === "rejected") exhaust(`GitHub rejected the review: ${String(error)}`);
        else failed(String(error));
      }
      return true;
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  }
  private owner(pid: number): string | undefined {
    try {
      return `${pid} ${readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ")[19]} ${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}`;
    } catch {
      return undefined;
    }
  }
  private acquire(lock: string): boolean {
    try {
      mkdirSync(lock);
    } catch {
      // Serialize stale-lock inspection/removal. PID + start time + boot id
      // distinguishes a dead owner from a reused PID after container restart.
      const reclaim = `${lock}.reclaim`;
      try {
        mkdirSync(reclaim);
      } catch {
        // A restart may interrupt even the very short reclamation critical
        // section. Only the singleton daemon reclaims these old mutexes.
        try {
          if (this.now().getTime() - statSync(reclaim).mtimeMs < 600_000) return false;
          const recorded = existsSync(join(reclaim, "pid"))
            ? readFileSync(join(reclaim, "pid"), "utf8").trim()
            : "";
          const pid = Number(recorded.split(" ")[0]);
          if (recorded && (!recorded.includes(" ") || this.owner(pid) === recorded)) return false;
          rmSync(reclaim, { recursive: true });
          mkdirSync(reclaim);
        } catch {
          return false;
        }
      }
      writeFileSync(join(reclaim, "pid"), this.owner(process.pid) ?? String(process.pid));
      try {
        const age = this.now().getTime() - statSync(lock).mtimeMs;
        const recorded = existsSync(join(lock, "pid"))
          ? readFileSync(join(lock, "pid"), "utf8").trim()
          : "";
        if (!recorded) {
          // Owner metadata is written before any network access. An aged,
          // ownerless directory can only be interrupted initialization.
          if (age < 600_000) return false;
          rmSync(lock, { recursive: true });
          mkdirSync(lock);
          writeFileSync(join(lock, "pid"), this.owner(process.pid) ?? String(process.pid));
          return true;
        }
        const pid = Number(recorded.split(" ")[0]);
        if (!Number.isInteger(pid) || pid <= 0 || age < QUIET_WINDOW_MS) return false;
        const liveOwner = this.owner(pid);
        if (recorded.includes(" ") && liveOwner === recorded) return false;
        if (!recorded.includes(" ")) {
          try {
            process.kill(pid, 0);
            return false;
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ESRCH") return false;
          }
        } else if (!liveOwner) {
          try {
            process.kill(pid, 0);
            return false;
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ESRCH") return false;
          }
        }
        rmSync(lock, { recursive: true });
        mkdirSync(lock);
      } catch {
        return false;
      } finally {
        rmSync(reclaim, { recursive: true, force: true });
      }
    }
    writeFileSync(join(lock, "pid"), this.owner(process.pid) ?? String(process.pid));
    return true;
  }
  private async deliver(path: string, j: PostingJob): Promise<void> {
    const lock = `${postingReceiptPath(this.deps.dir, j.pr, j.round_no)}.lock`;
    if (!this.acquire(lock)) return;
    try {
      // Another worker may have advanced the schedule before we acquired.
      const fresh = readPostingJob(path);
      if (!fresh || fresh.status !== "pending") return;
      if (Date.parse(fresh.next_attempt_at) > this.now().getTime()) {
        // Not due yet, but the window may be over: the bound holds without
        // calling GitHub before the wait it asked for has passed.
        this.deliveryExpired(path, fresh, fresh.last_error ?? "no attempt succeeded");
        return;
      }
      j = fresh;
      // Reread after lock: a concurrent shell may have completed meanwhile.
      const receipt = readPostingReceipt(this.deps.dir, j.pr, j.round_no);
      if (
        (existsSync(postingReceiptPath(this.deps.dir, j.pr, j.round_no)) && !receipt) ||
        (receipt && receipt.posting_key !== j.posting_key)
      ) {
        this.fail(path, j, "unreadable or mismatched posting receipt");
        return;
      }
      if (receipt?.posting_key === j.posting_key && receipt.status === "confirmed") {
        j.status = "done";
        writePostingFile(path, j);
        // A deferred delivery interrupted between its receipt and its ledger
        // write still has a pending retry row; the receipt is the authority.
        this.deps.deferred?.ledger.settlePostingRetry(
          j.posting_key,
          "confirmed",
          null,
          this.now().toISOString(),
        );
        return;
      }
      if (receipt?.status === "skipped" || receipt?.status === "dryrun") {
        this.fail(path, j, "posting receipt forbids live replay");
        return;
      }
      let reviews: Awaited<ReturnType<PostingDeliveryAdapter["listReviewsFull"]>>;
      try {
        reviews = await this.deps.adapter.listReviewsFull(j.pr);
      } catch (error) {
        if (this.deliveryExpired(path, j, `marker read failed: ${String(error)}`)) return;
        this.schedule(path, j, String(error), classifyGitHubFailure(error).retryAfterMs ?? 0);
        return;
      }
      const matches = this.markedReviews(reviews, j);
      if (matches.length > 1) {
        this.fail(path, j, "multiple reviews carry this posting key");
        return;
      }
      if (matches.length === 1) {
        this.confirm(path, j, matches[0]!);
        return;
      }
      if (this.deliveryExpired(path, j, j.last_error ?? "no attempt succeeded")) return;
      if (!this.deps.current(j)) {
        this.fail(path, j, "round superseded, head moved, or PR closed");
        return;
      }
      // A prepared shell receipt or our persisted attempt is ambiguous, not
      // proof of failure. Require a quiet transport window and TWO complete,
      // separated negative reads before retry. GitHub offers no idempotency
      // token: markers are reconciliation, not a server exactly-once promise.
      const attemptedAt =
        j.attempted_at ?? (receipt?.status === "prepared" ? receipt.prepared_at : undefined);
      if (attemptedAt) {
        const step = uncertainPostStep(attemptedAt, j.negative_at, this.now().getTime()).step;
        if (step === "quiet") {
          this.schedule(path, j, "waiting for prior transport to settle", QUIET_WINDOW_MS);
          return;
        }
        if (step === "first-negative") {
          j.negative_at = this.now().toISOString();
          this.schedule(path, j, "first complete negative marker reconcile", NEGATIVE_GAP_MS);
          return;
        }
        if (step === "gap") return;
      }
      j.attempts++;
      j.attempted_at = this.now().toISOString();
      delete j.negative_at;
      writePostingFile(path, j); // BEFORE the mutation, including crash window
      // The shell's replay guard must see this transport window too: a job
      // field alone would let a late session retry POST over our attempt.
      writePostingFile(postingReceiptPath(this.deps.dir, j.pr, j.round_no), {
        version: 1,
        posting_key: j.posting_key,
        marker: postingMarker(j.posting_key),
        pr: j.pr,
        round_no: j.round_no,
        head_sha: j.head_sha,
        intended_event: j.intended_event,
        actual_event: j.payload.event,
        status: "prepared",
        payload_sha256: j.payload_sha256,
        prepared_at: j.attempted_at,
        ...(this.deps.personMode ? { person_mode: true as const } : {}),
      } satisfies PostingReceipt);
      try {
        let result: DeliveryResult;
        try {
          result = await this.deps.adapter.createReview(j.pr, j.payload);
        } catch (error) {
          if (!this.foldAfterAnchorRejection(path, j, error)) throw error;
          result = await this.deps.adapter.createReview(j.pr, j.payload);
        }
        if (result.blocked) {
          delete j.attempted_at;
          rmSync(postingReceiptPath(this.deps.dir, j.pr, j.round_no)); // gate proved no POST executed
          j.unposted_attempts = (j.unposted_attempts ?? 0) + 1;
          // A read the delivery depends on (the PR, an approval's CI) could
          // not be read: retried, inside the delivery window.
          if (result.blocked === "pr-unreadable")
            this.schedule(path, j, result.blocked, result.retryAfterMs ?? 0);
          else this.fail(path, j, `posting guard: ${result.blocked}`);
          return;
        }
        if (!result.executed) {
          this.fail(path, j, "live delivery was not executed");
          return;
        }
        const response = reviewIdentityOf(result.response);
        if (!response) {
          this.schedule(path, j, "POST response lacks a review identity");
          return;
        }
        this.confirm(path, j, response);
      } catch (error) {
        const f = classifyGitHubFailure(error);
        // Explicit client rejection is not ambiguous acceptance. Rate-limit
        // responses retain delivery debt; permission/validation errors are loud.
        if (f.kind === "rate_limited") {
          delete j.attempted_at;
          rmSync(postingReceiptPath(this.deps.dir, j.pr, j.round_no)); // explicit rate-limit rejection
          this.schedule(path, j, String(error), f.retryAfterMs ?? 60_000);
        } else if (f.kind === "rejected") {
          this.fail(path, j, String(error));
        } else this.schedule(path, j, String(error));
      }
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  }
}

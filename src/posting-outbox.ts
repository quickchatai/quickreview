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
import type { GateResult } from "./gate.js";
import type { PostingRetryRow } from "./state.js";
import {
  postingMarker,
  postingReceiptPath,
  readPostingReceipt,
  roundPostingKey,
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
  /** Set by `posting-receipt.py defer` — the session's POST got a
   * 5xx or no answer and no review carried the marker. The first failure;
   * the daemon's retry schedule (state.db `posting_retries`) runs from it. */
  deferred_at?: string;
}
export interface PostingDeliveryAdapter {
  createReview(pr: number, payload: PostingJob["payload"]): Promise<GateResult>;
  /** The deferred-posting retry's POST — the adapter's createReview
   * through the ONE gate with `postingRetry` set, so guard 5 lets it post at
   * its original commit_id and every other guard (4's softening included)
   * applies as it does on any gated review. Absent ⇒ no deferred retry. */
  createDeferredReview?(
    pr: number,
    payload: PostingJob["payload"],
    postingKey: string,
  ): Promise<GateResult>;
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

// Same fsync + rename protocol as posting-receipt.py. File and directory sync
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
function jobPath(dir: string, pr: number, round: number): string {
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
    if (
      j.payload.comments?.some((raw) => {
        const c = raw as { path?: unknown; line?: unknown; side?: unknown; body?: unknown } | null;
        return (
          !c ||
          typeof c.path !== "string" ||
          typeof c.body !== "string" ||
          typeof c.line !== "number" ||
          !Number.isInteger(c.line) ||
          c.line < 1 ||
          (c.side !== undefined && c.side !== "RIGHT" && c.side !== "LEFT")
        );
      })
    )
      return undefined;
    return j;
  } catch {
    return undefined;
  }
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
  deliver: (pr: number, payload: PostingJob["payload"], postingKey: string) => Promise<GateResult>;
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

type HttpError = { status?: number; retryAfterMs?: number; message?: string };
/** GitHub's rate limiting: a 429, or a 403 that says it is one. */
function rateLimited(e: HttpError): boolean {
  return (
    e.status === 429 || (e.status === 403 && /rate limit|abuse|secondary/i.test(e.message ?? ""))
  );
}
/** An explicit client rejection: a 4xx that is neither a timeout nor rate
 * limiting. Retrying it would only be refused again. */
function permanentRejection(e: HttpError): boolean {
  return !!e.status && e.status >= 400 && e.status < 500 && e.status !== 408 && !rateLimited(e);
}

/** The exact published snapshot, allowing only confirmed approval softening. */
function receiptMatchesJob(receipt: ReturnType<typeof readPostingReceipt>, job: PostingJob): boolean {
  if (!receipt || receipt.posting_key !== job.posting_key ||
    receipt.head_sha.toLowerCase() !== job.head_sha.toLowerCase()) return false;
  if (receipt.status === "skipped") return true; // terminal refusal, never a replay
  return receipt.payload_sha256.toLowerCase() === job.payload_sha256 &&
    receipt.intended_event === job.intended_event &&
    (receipt.actual_event === job.payload.event ||
      (receipt.status === "confirmed" && receipt.actual_event === "COMMENT"));
}

/** The deferred receipt of this job, when its receipt says `deferred`. */
function deferredReceipt(dir: string, j: PostingJob): PostingReceipt | undefined {
  const r = readPostingReceipt(dir, j.pr, j.round_no);
  return r && r.status === "deferred" && receiptMatchesJob(r, j) ? r : undefined;
}

const QUIET_WINDOW_MS = 120_000;
const NEGATIVE_GAP_MS = 30_000;
export class PostingOutbox {
  private busy = false;
  constructor(
    private readonly deps: {
      dir: string;
      repo: string;
      dryRun: boolean;
      botLogins: string[];
      adapter: PostingDeliveryAdapter;
      current: (job: PostingJob) => boolean;
      now?: () => Date;
      log: (message: string, job: PostingJob) => void;
      /** The deferred-posting retry. Absent ⇒ a deferred job is
       * never touched (nothing posts it; the verdict watcher's stage limits
       * still see it as in flight and fail loud once its window is over). */
      deferred?: DeferredPostingDeps;
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
        if (job && outboxProcesses(job, this.deps.repo) && job.deferred_at &&
          !this.recoverDeferredHandoff(path, job)) {
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
          Date.parse(job.next_attempt_at) > this.now().getTime()
        )
          continue;
        await this.deliver(path, job);
        if (++processed >= 8) break;
      }
    } finally {
      this.busy = false;
    }
  }
  /** Finish the shell's job-first handoff under the existing posting lock. */
  private recoverDeferredHandoff(path: string, job: PostingJob): boolean {
    const receiptPath = postingReceiptPath(this.deps.dir, job.pr, job.round_no);
    const current = readPostingReceipt(this.deps.dir, job.pr, job.round_no);
    if (receiptMatchesJob(current, job) && current?.status !== "prepared") return true;
    const lock = `${receiptPath}.lock`;
    if (!this.acquire(lock)) return false;
    try {
      const fresh = readPostingJob(path);
      const receipt = readPostingReceipt(this.deps.dir, job.pr, job.round_no);
      if (!fresh || !outboxProcesses(fresh, this.deps.repo) || !fresh.deferred_at ||
        fresh.posting_key !== job.posting_key || !receiptMatchesJob(receipt, fresh) || !receipt) return false;
      if (receipt.status !== "prepared") return true;
      if (receipt.payload_sha256 !== fresh.payload_sha256 || receipt.head_sha !== fresh.head_sha ||
        receipt.intended_event !== fresh.intended_event || receipt.actual_event !== fresh.payload.event) return false;
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
  private fail(path: string, j: PostingJob, reason: string): void {
    j.status = "failed";
    j.last_error = reason;
    writePostingFile(path, j);
    this.deps.log(`posting failed: ${reason}`, j);
  }
  /** The bot's reviews at the job's head that carry its posting marker. */
  private markedReviews<T extends { user: string; commit_id: string; body: string }>(
    reviews: readonly T[],
    j: PostingJob,
  ): T[] {
    return reviews.filter(
      (r) =>
        this.deps.botLogins.includes(r.user) &&
        r.commit_id.toLowerCase() === j.head_sha.toLowerCase() &&
        r.body.includes(postingMarker(j.posting_key)),
    );
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
      // An APPROVE that GitHub holds as a COMMENT was softened by guard 4 on
      // the gate, which only the daemon's delivery passes through (the shell
      // route refuses a red-CI approval): the withheld-approval shape.
      ...(deliveredBy || (j.intended_event === "APPROVE" && event === "COMMENT")
        ? { delivered_by: "daemon_retry" as const }
        : {}),
    } satisfies PostingReceipt);
    j.status = "done";
    writePostingFile(path, j);
    this.deps.log("posting confirmed", j);
    return true;
  }

  /**
   * One step of a deferred posting's bounded retry. Returns whether
   * it did GitHub work (the tick's per-pass bound counts those).
   *
   * The schedule is the state.db row, adopted from the receipt's
   * `deferred_at`: attempt k is due at first failure + offsets[k], and every
   * attempt (1) is counted durably first, (2) reads GitHub for the marker
   * and confirms without POSTing when the review is there, (3) stops if the
   * round no longer owes the posting, (4) POSTs through the gate, whose
   * guards bind as on any review (guard 5 excepted, by the intent's
   * `postingRetry`). A failure after the last offset, a due time past the
   * window, or a permanent rejection exhausts it: the job is failed, the row
   * `exhausted`, and the verdict watcher's posting proof fails the round
   * loud. The receipt stays `deferred` throughout — only a confirmation
   * rewrites it — so the shell refuses any second POST from the session.
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
    const first = Date.parse(row.first_failed_at);
    const windowEnd = first + d.windowMs;
    const offset = d.offsetsMs[row.attempts];
    const due = offset === undefined ? windowEnd : first + offset;
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
      const lastChance = offset === undefined || this.now().getTime() >= windowEnd;
      if (!d.ledger.beginPostingRetryAttempt(j.posting_key, row.attempts, iso())) return false;
      row = d.ledger.postingRetry(j.posting_key) ?? row;
      j.attempts = row.attempts; // every outcome below persists and logs the ledger's count
      const exhaust = (detail: string): void => {
        if (!d.ledger.settlePostingRetry(j.posting_key, "exhausted", detail, iso())) return;
        this.fail(path, j, `deferred posting exhausted: ${detail}`);
        d.onExhausted(j, detail);
      };
      const failed = (detail: string): void => {
        if (lastChance || row.attempts >= d.offsetsMs.length) {
          exhaust(
            `${row.attempts} attempt(s) inside ${Math.round(d.windowMs / 60_000)} min of the first failure; last: ${detail}`,
          );
          return;
        }
        d.ledger.notePostingRetryError(j.posting_key, detail, iso());
        j.last_error = detail;
        const next = d.offsetsMs[row.attempts];
        j.next_attempt_at = new Date(first + (next ?? d.windowMs)).toISOString();
        writePostingFile(path, j);
        this.deps.log(`deferred posting attempt ${row.attempts} failed: ${detail}`, j);
      };
      // (2) Never post twice: GitHub first, every attempt.
      let reviews: Awaited<ReturnType<PostingDeliveryAdapter["listReviewsFull"]>>;
      try {
        reviews = await this.deps.adapter.listReviewsFull(j.pr);
      } catch (error) {
        failed(`marker read failed: ${String(error)}`);
        return true;
      }
      const matches = this.markedReviews(reviews, j);
      if (matches.length > 1) {
        exhaust("multiple reviews carry this posting key");
        return true;
      }
      if (matches.length === 1) {
        // `daemon_retry` either way: an APPROVE found as a COMMENT can only
        // be a gate softening of an earlier attempt whose answer was lost.
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
        const result = await d.deliver(j.pr, j.payload, j.posting_key);
        if (result.blocked) {
          if (result.blocked === "pr-unreadable") failed(`posting guard: ${result.blocked}`);
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
        if (permanentRejection(error as HttpError))
          exhaust(`GitHub rejected the review: ${String(error)}`);
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
      if (
        !fresh ||
        fresh.status !== "pending" ||
        Date.parse(fresh.next_attempt_at) > this.now().getTime()
      )
        return;
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
        this.schedule(path, j, String(error));
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
        if (this.now().getTime() - Date.parse(attemptedAt) < QUIET_WINDOW_MS) {
          this.schedule(path, j, "waiting for prior transport to settle", QUIET_WINDOW_MS);
          return;
        }
        if (!j.negative_at) {
          j.negative_at = this.now().toISOString();
          this.schedule(path, j, "first complete negative marker reconcile", NEGATIVE_GAP_MS);
          return;
        }
        if (this.now().getTime() - Date.parse(j.negative_at) < NEGATIVE_GAP_MS) return;
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
      } satisfies PostingReceipt);
      try {
        const result = await this.deps.adapter.createReview(j.pr, j.payload);
        if (result.blocked) {
          delete j.attempted_at;
          rmSync(postingReceiptPath(this.deps.dir, j.pr, j.round_no)); // gate proved no POST executed
          if (result.blocked === "pr-unreadable" || result.blocked === "ci-not-green")
            this.schedule(path, j, result.blocked);
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
        const e = error as HttpError;
        // Explicit client rejection is not ambiguous acceptance. Rate-limit
        // responses retain delivery debt; permission/validation errors are loud.
        if (rateLimited(e)) {
          delete j.attempted_at;
          rmSync(postingReceiptPath(this.deps.dir, j.pr, j.round_no)); // explicit rate-limit rejection
          this.schedule(path, j, String(error), e.retryAfterMs ?? 60_000);
        } else if (permanentRejection(e)) {
          this.fail(path, j, String(error));
        } else this.schedule(path, j, String(error));
      }
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  }
}

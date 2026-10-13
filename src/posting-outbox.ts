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
}
export interface PostingDeliveryAdapter {
  createReview(pr: number, payload: PostingJob["payload"]): Promise<GateResult>;
  listReviewsFull(
    pr: number,
  ): Promise<
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
          !job ||
          job.status !== "pending" ||
          job.mode !== "live" ||
          job.repo !== this.deps.repo ||
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
  private confirm(
    path: string,
    j: PostingJob,
    review: { id: number; commit_id: string; state: string; submitted_at?: string | null },
  ): void {
    const state = review.state.toUpperCase();
    const event =
      state === "APPROVED"
        ? "APPROVE"
        : state === "CHANGES_REQUESTED"
          ? "REQUEST_CHANGES"
          : state === "COMMENTED"
            ? "COMMENT"
            : undefined;
    if (
      !event ||
      (event !== j.intended_event && event !== "COMMENT") ||
      !Number.isInteger(review.id) ||
      review.id <= 0 ||
      review.commit_id.toLowerCase() !== j.head_sha.toLowerCase()
    ) {
      this.fail(path, j, "GitHub returned a contradictory review identity");
      return;
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
    } satisfies PostingReceipt);
    j.status = "done";
    writePostingFile(path, j);
    this.deps.log("posting confirmed", j);
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
      const matches = reviews.filter(
        (r) =>
          this.deps.botLogins.includes(r.user) &&
          r.commit_id.toLowerCase() === j.head_sha.toLowerCase() &&
          r.body.includes(postingMarker(j.posting_key)),
      );
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
        const response = result.response as
          { id: number; commit_id: string; state: string } | undefined;
        if (
          !response ||
          typeof response.commit_id !== "string" ||
          typeof response.state !== "string"
        ) {
          this.schedule(path, j, "POST response lacks a review identity");
          return;
        }
        this.confirm(path, j, response);
      } catch (error) {
        const e = error as { status?: number; retryAfterMs?: number; message?: string };
        // Explicit client rejection is not ambiguous acceptance. Rate-limit
        // responses retain delivery debt; permission/validation errors are loud.
        if (
          e.status === 429 ||
          (e.status === 403 && /rate limit|abuse|secondary/i.test(e.message ?? ""))
        ) {
          delete j.attempted_at;
          rmSync(postingReceiptPath(this.deps.dir, j.pr, j.round_no)); // explicit rate-limit rejection
          this.schedule(path, j, String(error), e.retryAfterMs ?? 60_000);
        } else if (e.status && e.status >= 400 && e.status < 500 && e.status !== 408) {
          this.fail(path, j, String(error));
        } else this.schedule(path, j, String(error));
      }
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  }
}

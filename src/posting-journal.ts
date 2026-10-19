// The posting journal: the daemon's own writer of a round's receipt and outbox
// job, the TypeScript twin of scripts/posting-receipt.py (P7.2).
//
// The shell route records a round's posting in two files under
// state/posting-receipts/: `pr-<n>-round-<k>.json` (the receipt, what the
// verdict watcher proves a round's posting from) and
// `pr-<n>-round-<k>.outbox.json` (the replayable job the outbox delivers if the
// session dies mid-post). A post that reaches the daemon over IPC must leave
// the SAME two files in the SAME shapes, because everything downstream
// (`readPostingReceipt`, `readPostingJob`, the verdict watcher, the outbox, the
// deferred retry) reads them and does not know which route wrote them.
//
// One hash: the receipt's and the job's `payload_sha256` are both the sha256 of
// `JSON.stringify(payload)` (the job reader's own check), so a receipt always
// matches its job.
//
// The lock is the shell's: a `<receipt>.lock` directory holding `pid`. One
// attempt owns a round's posting at a time, whichever route it came by.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { readPostingJob, writePostingFile, type PostingJob } from "./posting-outbox.js";
import {
  postingMarker,
  postingReceiptPath,
  type PostingReceipt,
  type PostingReceiptStatus,
} from "./posting-receipt.js";
import type { StandingMarkSnapshot } from "./standing-review.js";

export type ReviewEvent = PostingReceipt["intended_event"];

/** What `check` says about a round's receipt slot. */
export type ReceiptSlot = "none" | "mismatch" | "invalid" | PostingReceiptStatus | "skipped";

/** A refusal of the journal itself (a lock held, an identity mismatch, a record
 * that would overwrite an attempted post). Never a GitHub answer. */
export class JournalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JournalError";
  }
}

const EVENTS: readonly string[] = ["APPROVE", "REQUEST_CHANGES", "COMMENT"];
const ATTEMPTED: readonly string[] = ["prepared", "confirmed", "dryrun", "deferred"];
/** The state GitHub reports for each review event it accepted. */
const STATE_OF: Record<ReviewEvent, string> = {
  APPROVE: "APPROVED",
  REQUEST_CHANGES: "CHANGES_REQUESTED",
  COMMENT: "COMMENTED",
};
/** Same quiet window the outbox applies before it reclaims a dead owner's lock. */
const LOCK_QUIET_MS = 120_000;

export type JobPayload = PostingJob["payload"];

export const payloadHash = (payload: unknown): string =>
  createHash("sha256").update(JSON.stringify(payload)).digest("hex");

/** `<pid> <start time> <boot id>`, the owner record scripts/posting-receipt.py
 * writes: a reused pid after a container restart is not mistaken for the owner. */
export function ownerRecord(pid: number): string | undefined {
  try {
    const start = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ")[19];
    const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return `${pid} ${start} ${boot}`;
  } catch {
    return undefined;
  }
}

function readObject(path: string, what: string): Record<string, unknown> | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new JournalError(`existing ${what} unreadable: ${(e as Error).message}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    throw new JournalError(`existing ${what} invalid: ${(e as Error).message}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new JournalError(`existing ${what} must be a nonempty object`);
  return Object.keys(value).length === 0 ? undefined : (value as Record<string, unknown>);
}

export interface JournalOptions {
  /** `<state>/posting-receipts`, the dir the verdict watcher and the outbox read. */
  dir: string;
  repo: string;
  now?: () => Date;
}

export class PostingJournal {
  private readonly now: () => Date;
  constructor(private readonly o: JournalOptions) {
    this.now = o.now ?? (() => new Date());
  }

  receiptPath(pr: number, round: number): string {
    return postingReceiptPath(this.o.dir, pr, round);
  }
  jobPath(pr: number, round: number): string {
    return join(this.o.dir, `pr-${pr}-round-${round}.outbox.json`);
  }
  private iso(): string {
    return this.now().toISOString();
  }
  private write(path: string, value: unknown): void {
    mkdirSync(this.o.dir, { recursive: true });
    writePostingFile(path, value);
  }

  // ---- the lock ------------------------------------------------------------

  /** Run `fn` while this attempt owns the round's posting. A second attempt
   * (this route's or the shell's) is refused, not queued: the same rule the
   * shell's `mkdir` lock enforces. */
  async locked<T>(pr: number, round: number, key: string, fn: () => Promise<T>): Promise<T> {
    const lock = `${this.receiptPath(pr, round)}.lock`;
    mkdirSync(this.o.dir, { recursive: true });
    if (!this.acquire(lock)) throw new JournalError(`another posting attempt owns ${key}`);
    try {
      return await fn();
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  }

  private acquire(lock: string): boolean {
    const mine = ownerRecord(process.pid) ?? String(process.pid);
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, "pid"), mine);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    // Held. Only a dead owner's lock, quiet for the window, is taken over, and
    // the takeover is itself serialised so two reclaimers cannot both win.
    const reclaim = `${lock}.reclaim`;
    try {
      mkdirSync(reclaim);
    } catch {
      return false;
    }
    try {
      const recorded = existsSync(join(lock, "pid"))
        ? readFileSync(join(lock, "pid"), "utf8").trim()
        : "";
      const pid = Number(recorded.split(" ")[0]);
      const age = this.now().getTime() - statSync(lock).mtimeMs;
      if (age < LOCK_QUIET_MS) return false;
      if (recorded !== "" && Number.isInteger(pid) && pid > 0) {
        const live = ownerRecord(pid);
        if (recorded.includes(" ") ? live === recorded : live !== undefined) return false;
      }
      rmSync(lock, { recursive: true });
      mkdirSync(lock);
      writeFileSync(join(lock, "pid"), mine);
      return true;
    } catch {
      return false;
    } finally {
      rmSync(reclaim, { recursive: true, force: true });
    }
  }

  // ---- reading -------------------------------------------------------------

  /** What the round's receipt slot holds for this key. */
  check(pr: number, round: number, key: string): ReceiptSlot {
    const value = readObject(this.receiptPath(pr, round), "receipt");
    if (!value) return "none";
    if (value.posting_key !== key) return "mismatch";
    const status = value.status;
    return typeof status === "string" && status !== "" ? (status as ReceiptSlot) : "invalid";
  }

  // ---- the outbox snapshot -------------------------------------------------

  /** Snapshot the replayable input before the first GitHub read. Idempotent
   * for the same input; refuses a changed one. */
  enqueue(o: {
    key: string;
    pr: number;
    round: number;
    head: string;
    event: ReviewEvent;
    mode: "live" | "dryrun";
    payload: JobPayload;
  }): void {
    if (!EVENTS.includes(o.event)) throw new JournalError("invalid delivery intent");
    const hash = payloadHash(o.payload);
    const path = this.jobPath(o.pr, o.round);
    const existing = readObject(path, "delivery intent");
    if (existing) {
      if (
        existing.posting_key !== o.key ||
        existing.repo !== this.o.repo ||
        existing.mode !== o.mode
      )
        throw new JournalError("delivery identity mismatch");
      if (existing.source_sha256 !== hash)
        throw new JournalError("refusing to change queued review input");
      return;
    }
    if (existsSync(path))
      throw new JournalError("refusing to overwrite unreadable delivery intent");
    const now = this.iso();
    this.write(path, {
      version: 1,
      posting_key: o.key,
      repo: this.o.repo,
      mode: o.mode,
      pr: o.pr,
      round_no: o.round,
      head_sha: o.head.toLowerCase(),
      intended_event: o.event,
      payload: o.payload,
      payload_sha256: hash,
      source_sha256: hash,
      status: "pending",
      attempts: 0,
      created_at: now,
      next_attempt_at: now,
    });
  }

  /** Take back this round's snapshot after a guard refused it. Only while no
   * receipt exists: a receipt of any status records an attempted, recorded or
   * refused post, which this never erases. */
  withdraw(pr: number, round: number, key: string): void {
    if (existsSync(this.receiptPath(pr, round)))
      throw new JournalError(
        "refusing to withdraw — a posting was already attempted or recorded for this key",
      );
    const path = this.jobPath(pr, round);
    if (!existsSync(path)) return;
    const queued = readObject(path, "delivery snapshot");
    if (!queued || queued.posting_key !== key)
      throw new JournalError("refusing to withdraw an unreadable or mismatched delivery snapshot");
    if (queued.status !== "pending")
      throw new JournalError(`refusing to withdraw a ${String(queued.status)} delivery snapshot`);
    const stamp = this.now()
      .toISOString()
      .replace(/[-:.]/g, "")
      .replace(/(\d{3})Z$/, "$1000Z");
    renameSync(path, `${path}.withdrawn-${stamp}`);
  }

  // ---- the receipt ---------------------------------------------------------

  /** Record the attempt BEFORE the POST: `prepared` brackets the window in which
   * the outcome is unknown. Never turns an attempted receipt back. */
  prepare(o: {
    key: string;
    pr: number;
    round: number;
    head: string;
    intended: ReviewEvent;
    payload: JobPayload;
  }): void {
    const path = this.receiptPath(o.pr, o.round);
    const value = readObject(path, "receipt") ?? {};
    this.refuseForeign(value, o.key);
    if (ATTEMPTED.includes(String(value.status))) return; // never erase an ambiguous window
    this.write(
      path,
      this.fill(value, o, o.intended, o.payload, {
        status: "prepared",
      }),
    );
    this.touchJob(o, o.payload, "prepare");
  }

  /** Dry-run: the intent was written to state/dryrun/ instead of sent. */
  dryrun(o: {
    key: string;
    pr: number;
    round: number;
    head: string;
    intended: ReviewEvent;
    actual: ReviewEvent;
    payload: JobPayload;
  }): void {
    const path = this.receiptPath(o.pr, o.round);
    const value = readObject(path, "receipt") ?? {};
    this.refuseForeign(value, o.key);
    this.write(
      path,
      this.fill(value, o, o.actual, o.payload, { status: "dryrun", confirmed_at: this.iso() }),
    );
    this.touchJob(o, o.payload, "done");
  }

  /** GitHub answered with the review: `response` is its `{id, commit_id, state}`. */
  confirm(o: {
    key: string;
    pr: number;
    round: number;
    head: string;
    intended: ReviewEvent;
    payload: JobPayload;
    response: unknown;
  }): ReviewEvent {
    const r = (o.response ?? {}) as { id?: unknown; commit_id?: unknown; state?: unknown };
    if (typeof r.id !== "number" || !Number.isInteger(r.id) || typeof r.commit_id !== "string")
      throw new JournalError("GitHub response lacks returned id/commit_id");
    const state = typeof r.state === "string" ? r.state.toUpperCase() : "";
    const actual = (Object.keys(STATE_OF) as ReviewEvent[]).find((e) => STATE_OF[e] === state);
    // Guard 1 softens a REQUEST_CHANGES and guard 4 an APPROVE, both to a
    // COMMENT; nothing else may differ from what was asked for.
    if (
      !actual ||
      (actual !== o.intended && actual !== "COMMENT") ||
      r.commit_id.toLowerCase() !== o.head.toLowerCase()
    )
      throw new JournalError(`GitHub response mismatch (commit=${r.commit_id}, state=${state})`);
    const path = this.receiptPath(o.pr, o.round);
    const value = readObject(path, "receipt") ?? {};
    this.refuseForeign(value, o.key);
    this.write(
      path,
      this.fill(value, o, actual, o.payload, {
        status: "confirmed",
        confirmed_at: this.iso(),
        gh_review_id: r.id,
        gh_commit_id: r.commit_id.toLowerCase(),
        gh_state: state,
      }),
    );
    this.touchJob(o, o.payload, "done");
    return actual;
  }

  /** Hand an unanswered POST to the daemon's outbox: the job first, then the
   * receipt, so a deferred receipt always has its handoff on disk. */
  defer(o: {
    key: string;
    pr: number;
    round: number;
    head: string;
    intended: ReviewEvent;
    payload: JobPayload;
    reason: string;
  }): void {
    const path = this.receiptPath(o.pr, o.round);
    const value = readObject(path, "receipt");
    if (!value || value.posting_key !== o.key)
      throw new JournalError("no receipt for this posting key to defer");
    if (
      (typeof value.head_sha === "string" ? value.head_sha.toLowerCase() : "") !==
        o.head.toLowerCase() ||
      value.payload_sha256 !== payloadHash(o.payload)
    )
      throw new JournalError("deferral does not match the prepared attempt");
    if (value.status !== "prepared" && value.status !== "deferred")
      throw new JournalError(`refusing to defer a ${String(value.status)} receipt`);
    const jobPath = this.jobPath(o.pr, o.round);
    const queued = readObject(jobPath, "delivery snapshot");
    if (!queued || queued.posting_key !== o.key)
      throw new JournalError("no delivery snapshot for this posting key — cannot hand off");
    const first = (value.deferred_at as string | undefined) ?? this.iso();
    delete queued.negative_at;
    this.write(jobPath, {
      ...queued,
      payload: o.payload,
      payload_sha256: payloadHash(o.payload),
      status: "pending",
      deferred_at: first,
      next_attempt_at: first,
      last_error: o.reason,
    });
    this.write(path, {
      ...value,
      status: "deferred",
      deferred_at: first,
      defer_reason: o.reason,
      intended_event: o.intended,
      actual_event: o.payload.event,
    });
  }

  /** Record a guard-2 refusal as a terminal, identity-bound no-op. Written only
   * before any attempt, and only with a standing mark that itself justifies the
   * refusal; returns whether it was written. */
  skip(o: {
    key: string;
    pr: number;
    round: number;
    head: string;
    intended: ReviewEvent;
    mode: "live" | "dryrun";
    mark: StandingMarkSnapshot;
  }): boolean {
    const m = o.mark;
    if (
      m.head_sha.toLowerCase() !== o.head.toLowerCase() ||
      !m.reviewed_at ||
      (m.last_author_reply_at !== null && m.last_author_reply_at >= m.reviewed_at) ||
      ["NEEDS_HUMAN", "ESCALATE"].includes((m.verdict ?? "").trim().toUpperCase())
    )
      return false;
    const path = this.receiptPath(o.pr, o.round);
    const existing = readObject(path, "receipt");
    if (existing) {
      if (existing.posting_key !== o.key) throw new JournalError("existing receipt key mismatch");
      if (ATTEMPTED.includes(String(existing.status)))
        throw new JournalError("refusing to record a skip over an attempted post");
      if (existing.status === "skipped") return true; // idempotent replay
    }
    this.write(path, {
      version: 1,
      posting_key: o.key,
      marker: postingMarker(o.key),
      pr: o.pr,
      round_no: o.round,
      head_sha: o.head.toLowerCase(),
      status: "skipped",
      skip_reason: "no-new-evidence",
      intended_event: o.intended,
      mode: o.mode,
      skipped_at: this.iso(),
      standing_mark: {
        head_sha: m.head_sha,
        reviewed_at: m.reviewed_at,
        verdict: m.verdict,
        posted_event: m.posted_event,
        round_no: m.round_no,
        last_author_reply_at: m.last_author_reply_at,
      },
    });
    return true;
  }

  /** The gate proved nothing was posted: drop the `prepared` receipt so the
   * round may post again (what the outbox does when the gate blocks). */
  clearPrepared(pr: number, round: number, key: string): void {
    const path = this.receiptPath(pr, round);
    const value = readObject(path, "receipt");
    if (value?.posting_key === key && value.status === "prepared") rmSync(path);
    const job = readObject(this.jobPath(pr, round), "delivery snapshot");
    if (job?.posting_key === key && job.attempted_at !== undefined) {
      delete job.attempted_at;
      this.write(this.jobPath(pr, round), job);
    }
  }

  /** A dry-run receipt left by an earlier dry-run is set aside when the install
   * is live now, with its job, as the shell does. */
  archiveDryrun(pr: number, round: number): void {
    const stamp = this.now().toISOString().replace(/[-:.]/g, "").slice(0, 15) + "Z";
    const receipt = this.receiptPath(pr, round);
    renameSync(receipt, `${receipt}.dryrun-${stamp}`);
    const job = this.jobPath(pr, round);
    if (existsSync(job)) renameSync(job, `${job}.dryrun-${stamp}`);
  }

  // ---- shared shape --------------------------------------------------------

  private refuseForeign(value: Record<string, unknown>, key: string): void {
    if (Object.keys(value).length === 0) return;
    if (value.posting_key !== key) throw new JournalError("existing receipt key mismatch");
    if (value.status === "skipped")
      throw new JournalError(
        `${key} was refused (no new evidence); refusing to record an attempted post over it`,
      );
  }

  private fill(
    base: Record<string, unknown>,
    o: { key: string; pr: number; round: number; head: string; intended: ReviewEvent },
    actual: ReviewEvent,
    payload: JobPayload,
    extra: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      ...base,
      version: 1,
      posting_key: o.key,
      marker: postingMarker(o.key),
      pr: o.pr,
      round_no: o.round,
      head_sha: o.head.toLowerCase(),
      intended_event: o.intended,
      actual_event: actual,
      payload_sha256: payloadHash(payload),
      prepared_at: base.prepared_at ?? this.iso(),
      ...extra,
    };
  }

  /** The job beside the receipt follows the attempt (prepare stamps it, a
   * confirm or dry-run closes it). */
  private touchJob(
    o: { key: string; pr: number; round: number },
    payload: JobPayload,
    step: "prepare" | "done",
  ): void {
    const path = this.jobPath(o.pr, o.round);
    const job = readObject(path, "delivery snapshot");
    if (!job || job.posting_key !== o.key) return;
    job.payload = payload;
    job.payload_sha256 = payloadHash(payload);
    if (step === "prepare") {
      job.attempted_at = this.iso();
      delete job.negative_at;
    } else job.status = "done";
    this.write(path, job);
  }

  /** The job as the outbox would read it; for tests and the handler's own checks. */
  readJob(pr: number, round: number): PostingJob | undefined {
    return readPostingJob(this.jobPath(pr, round));
  }
}

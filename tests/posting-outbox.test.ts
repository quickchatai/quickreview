import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostingOutbox, pendingPosting, type PostingJob } from "../src/posting-outbox.js";
import {
  roundPostingKey,
  postingMarker,
  readPostingReceipt,
  retrySoftenedApproval,
} from "../src/posting-receipt.js";

let dir: string;
let clock: number;
const head = "a".repeat(40);
const key = roundPostingKey(12, 1, head);
let job: PostingJob;
let reviews: Array<{
  id: number;
  user: string;
  body: string;
  state: string;
  commit_id: string;
  submitted_at: string | null;
}>;
const createReview = vi.fn();
const listReviewsFull = vi.fn();
function save(): void {
  job.payload_sha256 = createHash("sha256").update(JSON.stringify(job.payload)).digest("hex");
  writeFileSync(join(dir, "pr-12-round-1.outbox.json"), JSON.stringify(job));
}
function worker(): PostingOutbox {
  return new PostingOutbox({
    dir,
    repo: "org/repo",
    dryRun: false,
    botLogins: ["review[bot]"],
    now: () => new Date(clock),
    adapter: { createReview, listReviewsFull },
    current: () => true,
    log: () => {},
  });
}
function advance(ms = 3_600_000): void {
  clock += ms;
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "posting-outbox-"));
  clock = Date.parse("2026-10-12T10:00:00Z");
  job = {
    version: 1,
    posting_key: key,
    repo: "org/repo",
    mode: "live",
    pr: 12,
    round_no: 1,
    head_sha: head,
    intended_event: "COMMENT",
    payload: { commit_id: head, event: "COMMENT", body: `Review\n\n${postingMarker(key)}` },
    payload_sha256: "",
    status: "pending",
    attempts: 0,
    next_attempt_at: new Date(clock).toISOString(),
    created_at: new Date(clock).toISOString(),
  };
  reviews = [];
  createReview.mockReset();
  listReviewsFull.mockReset();
  listReviewsFull.mockImplementation(async () => reviews);
  createReview.mockResolvedValue({
    executed: true,
    response: { id: 77, commit_id: head, state: "COMMENTED" },
  });
  save();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("durable review delivery", () => {
  it("retains a 503 obligation and posts after recovery without another review round", async () => {
    createReview.mockRejectedValueOnce(
      Object.assign(new Error("GitHub unavailable"), { status: 503 }),
    );
    await worker().tick();
    expect(pendingPosting(dir, 12, 1, key)).toBe(true);
    advance();
    await worker().tick(); // first negative reconcile after ambiguous failure
    advance();
    await worker().tick();
    expect(createReview).toHaveBeenCalledTimes(2);
    expect(readPostingReceipt(dir, 12, 1)?.status).toBe("confirmed");
  });
  it("reconciles an accepted POST whose response was lost, never reposting it", async () => {
    createReview.mockImplementationOnce(async () => {
      reviews.push({
        id: 77,
        user: "review[bot]",
        body: job.payload.body,
        commit_id: head,
        state: "COMMENTED",
        submitted_at: new Date(clock).toISOString(),
      });
      throw new Error("connection reset after acceptance");
    });
    await worker().tick();
    advance();
    await worker().tick();
    expect(createReview).toHaveBeenCalledTimes(1);
    expect(readPostingReceipt(dir, 12, 1)).toMatchObject({ status: "confirmed", gh_review_id: 77 });
  });
  it("an APPROVE the gate softened to a COMMENT confirms as a withheld approval", async () => {
    // CI turned red between the delivery's preflight and guard 4's own read.
    job.intended_event = "APPROVE";
    job.payload = { ...job.payload, event: "APPROVE" };
    save();
    await worker().tick();
    const receipt = readPostingReceipt(dir, 12, 1)!;
    expect(receipt).toMatchObject({
      status: "confirmed",
      intended_event: "APPROVE",
      actual_event: "COMMENT",
      delivered_by: "daemon_retry",
    });
    expect(retrySoftenedApproval(receipt)).toBe(true);
  });
  it("a delivered COMMENT that was asked for carries no delivery provenance", async () => {
    await worker().tick();
    expect(readPostingReceipt(dir, 12, 1)?.delivered_by).toBeUndefined();
  });
  it("survives restart and an unreadable GitHub longer than the round deadline", async () => {
    listReviewsFull.mockRejectedValue(new Error("offline"));
    for (let i = 0; i < 15; i++) {
      await worker().tick();
      advance();
    }
    expect(createReview).not.toHaveBeenCalled();
    expect(pendingPosting(dir, 12, 1, key)).toBe(true);
    listReviewsFull.mockResolvedValue([]);
    await worker().tick();
    expect(createReview).toHaveBeenCalledTimes(1);
  });
  it("honors rate-limit backoff rather than exhausting a retry cap", async () => {
    createReview.mockRejectedValueOnce(
      Object.assign(new Error("rate limit"), { status: 429, retryAfterMs: 600_000 }),
    );
    const w = worker();
    await w.tick();
    advance(300_000);
    await w.tick();
    expect(createReview).toHaveBeenCalledTimes(1);
    advance();
    await w.tick();
    expect(createReview).toHaveBeenCalledTimes(2);
  });
  it("does not race the shell poster or another worker", async () => {
    mkdirSync(join(dir, "pr-12-round-1.json.lock"));
    await worker().tick();
    expect(createReview).not.toHaveBeenCalled();
  });
  it("retains failures of posting-time reads without recording them as POST ambiguity", async () => {
    createReview.mockResolvedValueOnce({ executed: false, blocked: "pr-unreadable" });
    await worker().tick();
    advance();
    await worker().tick();
    expect(createReview).toHaveBeenCalledTimes(2);
  });
  it("never sends a stale or superseded job", async () => {
    await new PostingOutbox({
      dir,
      repo: "org/repo",
      dryRun: false,
      botLogins: ["review[bot]"],
      now: () => new Date(clock),
      adapter: { createReview, listReviewsFull },
      current: () => false,
      log: () => {},
    }).tick();
    expect(createReview).not.toHaveBeenCalled();
    expect(pendingPosting(dir, 12, 1, key)).toBe(false);
  });
  it("fails loud for permanent rejection, not endless silent retries", async () => {
    createReview.mockRejectedValueOnce(Object.assign(new Error("invalid review"), { status: 422 }));
    await worker().tick();
    advance();
    await worker().tick();
    expect(createReview).toHaveBeenCalledTimes(1);
    expect(pendingPosting(dir, 12, 1, key)).toBe(false);
  });
  it("does not deliver dry-run obligations after a live-mode flip", async () => {
    job.mode = "dryrun";
    save();
    await worker().tick();
    expect(createReview).not.toHaveBeenCalled();
  });
  it("reclaims a crashed owner and interrupted lock initialization", async () => {
    const lock = join(dir, "pr-12-round-1.json.lock");
    mkdirSync(lock);
    utimesSync(lock, new Date(clock - 900_000), new Date(clock - 900_000));
    await worker().tick();
    expect(createReview).toHaveBeenCalledTimes(1);
  });
  it("refuses a corrupted receipt rather than treating it as never sent", async () => {
    writeFileSync(join(dir, "pr-12-round-1.json"), "{broken");
    await worker().tick();
    expect(createReview).not.toHaveBeenCalled();
    expect(pendingPosting(dir, 12, 1, key)).toBe(false);
  });
  it("refuses changed payload bytes", async () => {
    job.payload.body += "tampered";
    writeFileSync(join(dir, "pr-12-round-1.outbox.json"), JSON.stringify(job));
    await worker().tick();
    expect(createReview).not.toHaveBeenCalled();
  });
  it("refuses contradictory marker identities", async () => {
    reviews = [1, 2].map((id) => ({
      id,
      user: "review[bot]",
      body: job.payload.body,
      commit_id: head,
      state: "COMMENTED",
      submitted_at: null,
    }));
    await worker().tick();
    expect(createReview).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(dir, "pr-12-round-1.outbox.json"), "utf8")).status).toBe(
      "failed",
    );
  });
});

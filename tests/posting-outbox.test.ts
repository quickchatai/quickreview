import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubRequestError } from "@quickchatai/pi-quickreview/src/githubcore.js";
import {
  PostingOutbox,
  pendingPosting,
  withApprovalCiPrecheck,
  type PostingJob,
} from "../src/posting-outbox.js";
import {
  roundPostingKey,
  postingMarker,
  readPostingReceipt,
  retrySoftenedApproval,
  type PostingReceipt,
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
function worker(personMode = false): PostingOutbox {
  return new PostingOutbox({
    dir,
    repo: "org/repo",
    dryRun: false,
    botLogins: ["review[bot]"],
    ...(personMode ? { personMode } : {}),
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
      new GitHubRequestError("GET", "/x", 503, "GitHub unavailable"),
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
    const receipt = readPostingReceipt(dir, 12, 1) as PostingReceipt;
    expect(receipt).toMatchObject({
      status: "confirmed",
      intended_event: "APPROVE",
      actual_event: "COMMENT",
      delivered_by: "daemon_retry",
    });
    expect(retrySoftenedApproval(receipt)).toBe(true);
  });
  it("person mode: an APPROVE delivered as a COMMENT is the rule, not a withheld approval", async () => {
    job.intended_event = "APPROVE";
    job.payload = { ...job.payload, event: "APPROVE" };
    save();
    await worker(true).tick();
    const receipt = readPostingReceipt(dir, 12, 1) as PostingReceipt;
    expect(receipt).toMatchObject({
      status: "confirmed",
      intended_event: "APPROVE",
      actual_event: "COMMENT",
      person_mode: true,
    });
    expect(receipt.delivered_by).toBeUndefined();
    expect(retrySoftenedApproval(receipt)).toBe(false);
  });
  it("a delivered COMMENT that was asked for carries no delivery provenance", async () => {
    await worker().tick();
    expect((readPostingReceipt(dir, 12, 1) as PostingReceipt).delivered_by).toBeUndefined();
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
      new GitHubRequestError("POST", "/x", 429, "rate limit", 600_000),
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
    createReview.mockRejectedValueOnce(new GitHubRequestError("POST", "/x", 422, "invalid review"));
    await worker().tick();
    advance();
    await worker().tick();
    expect(createReview).toHaveBeenCalledTimes(1);
    expect(pendingPosting(dir, 12, 1, key)).toBe(false);
  });
  // MUTATION: rethrow every error in postFolding — this fails
  // (one POST, the job failed loud).
  it("posts the comments in the body when GitHub cannot place an inline comment's line", async () => {
    job.payload.comments = [{ path: "a.py", line: 3, side: "RIGHT", body: "[blocker] x" }];
    save();
    createReview.mockRejectedValueOnce(
      new GitHubRequestError(
        "POST",
        "/x",
        422,
        JSON.stringify({ message: "x", errors: ["Line could not be resolved"] }),
      ),
    );
    await worker().tick();
    expect(createReview).toHaveBeenCalledTimes(2);
    const second = createReview.mock.calls[1]![1];
    expect(second.comments).toEqual([]);
    expect(second.body).toMatch(/^Review\n\n### Comments given here instead of inline/);
    expect(second.body).toContain("**`a.py:3`**\n\n[blocker] x");
    expect(second.body.endsWith(postingMarker(key))).toBe(true);
    expect(readPostingReceipt(dir, 12, 1)).toMatchObject({ status: "confirmed" });
    expect(pendingPosting(dir, 12, 1, key)).toBe(false);
  });
  it("a 422 about something else on a review with comments still fails loud", async () => {
    job.payload.comments = [{ path: "a.py", line: 3, side: "RIGHT", body: "[blocker] x" }];
    save();
    createReview.mockRejectedValueOnce(
      new GitHubRequestError("POST", "/x", 422, JSON.stringify({ errors: ["Body is too long"] })),
    );
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
  // MUTATION: return false at the top of deliveryExpired — this fails.
  it("is bounded by the delivery window from created_at, then fails loud, an ambiguous receipt kept", async () => {
    createReview.mockRejectedValue(new GitHubRequestError("GET", "/x", 503, "GitHub unavailable"));
    const expired = vi.fn();
    const bounded = () =>
      new PostingOutbox({
        dir,
        repo: "org/repo",
        dryRun: false,
        botLogins: ["review[bot]"],
        now: () => new Date(clock),
        adapter: { createReview, listReviewsFull },
        current: () => true,
        log: () => {},
        deliveryWindowMs: 60 * 60_000,
        onDeliveryExpired: expired,
      });
    const created = clock;
    for (let i = 0; i < 14; i++) {
      await bounded().tick();
      if (clock - created < 60 * 60_000) expect(expired).not.toHaveBeenCalled();
      advance(10 * 60_000);
    }
    expect(expired).toHaveBeenCalledTimes(1);
    expect(expired.mock.calls[0]![1]).toMatch(/not delivered within 60 min of being queued/);
    expect(pendingPosting(dir, 12, 1, key)).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, "pr-12-round-1.outbox.json"), "utf8")).status).toBe(
      "failed",
    );
    // A POST that may have landed stays ambiguous for the operator, never "not posted".
    expect(readPostingReceipt(dir, 12, 1)?.status).toBe("prepared");
    // The terminal proof the verdict watcher reads as `exhausted`.
    expect(jobFile().exhausted_at).toBe(new Date(created + 60 * 60_000).toISOString());
  });
  const jobFile = (): PostingJob =>
    JSON.parse(readFileSync(join(dir, "pr-12-round-1.outbox.json"), "utf8")) as PostingJob;
  const boundedWorker = (expired = vi.fn()) =>
    new PostingOutbox({
      dir,
      repo: "org/repo",
      dryRun: false,
      botLogins: ["review[bot]"],
      now: () => new Date(clock),
      adapter: { createReview, listReviewsFull },
      current: () => true,
      log: () => {},
      deliveryWindowMs: 60 * 60_000,
      onDeliveryExpired: expired,
    });
  // MUTATION: drop `&& !this.windowPassed(job)` from the tick's due check — this fails.
  it("expires at the window's end while GitHub's requested wait still holds, calling GitHub no sooner", async () => {
    const expired = vi.fn();
    advance(50 * 60_000);
    createReview.mockRejectedValueOnce(
      new GitHubRequestError("POST", "/x", 429, "rate limit", 60 * 60_000),
    );
    await boundedWorker(expired).tick();
    expect(createReview).toHaveBeenCalledTimes(1);
    expect(jobFile().next_attempt_at).toBe(new Date(clock + 60 * 60_000).toISOString());
    listReviewsFull.mockClear();
    advance(10 * 60_000); // minute 60: the window's end, the wait not over
    await boundedWorker(expired).tick();
    expect(expired).toHaveBeenCalledTimes(1);
    expect(jobFile()).toMatchObject({ status: "failed" });
    expect(jobFile().exhausted_at).toBeDefined();
    expect(listReviewsFull).not.toHaveBeenCalled();
    expect(createReview).toHaveBeenCalledTimes(1);
  });
  // MUTATION: drop the retryAfterMs from the marker-read failure's schedule — this fails.
  it("a marker read refused with a long Retry-After waits that long before the next read", async () => {
    listReviewsFull.mockRejectedValueOnce(
      new GitHubRequestError("GET", "/x", 429, "rate limit", 30 * 60_000),
    );
    await worker().tick();
    expect(jobFile().next_attempt_at).toBe(new Date(clock + 30 * 60_000).toISOString());
  });
  it("without a window the ordinary delivery keeps its debt", async () => {
    listReviewsFull.mockRejectedValue(new Error("offline"));
    for (let i = 0; i < 5; i++) {
      await worker().tick();
      advance();
    }
    expect(pendingPosting(dir, 12, 1, key)).toBe(true);
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

// The ordinary replay of an APPROVE carries the CI pre-check (wire.ts wires
// `withApprovalCiPrecheck` around the gated POST, as for the deferred retry).
describe("an ordinary APPROVE delivery and its CI pre-check", () => {
  const listChecks = vi.fn();
  const gatePost = vi.fn();
  beforeEach(() => {
    job.intended_event = "APPROVE";
    job.payload = { ...job.payload, event: "APPROVE" };
    save();
    listChecks.mockReset();
    gatePost.mockReset();
    // The gate answers as guard 4 does: an approval carrying a CI state that
    // is not green is withheld, as a COMMENT.
    gatePost.mockImplementation(async (p: PostingJob["payload"], ci?: string) => ({
      executed: true,
      response: {
        id: 78,
        commit_id: head,
        state: p.event === "APPROVE" && ci === undefined ? "APPROVED" : "COMMENTED",
      },
    }));
    createReview.mockImplementation((pr: number, payload: PostingJob["payload"]) =>
      withApprovalCiPrecheck({ listChecks, enabled: true }, pr, payload, gatePost),
    );
  });

  // The approval goes to the gate AS an approval (guard 2's exemption holds)
  // with the red state carried, so guard 4 withholds it with no read of its own.
  // MUTATION: post the payload without the carried state when the pre-check reads red — this fails.
  it("red CI the pre-check saw is carried to the gate, confirmed as a withheld approval", async () => {
    listChecks.mockResolvedValue([
      { name: "ci", source: "check_run", status: "completed", conclusion: "failure" },
    ]);
    await worker().tick();
    expect(gatePost).toHaveBeenCalledTimes(1);
    const [asked, carried] = gatePost.mock.calls[0]! as [PostingJob["payload"], string];
    expect(asked).toEqual(job.payload);
    expect(carried).toBe("red");
    const receipt = readPostingReceipt(dir, 12, 1) as PostingReceipt;
    expect(receipt).toMatchObject({
      status: "confirmed",
      intended_event: "APPROVE",
      actual_event: "COMMENT",
      delivered_by: "daemon_retry",
    });
    expect(retrySoftenedApproval(receipt)).toBe(true);
  });

  it("green CI posts the APPROVE as asked", async () => {
    listChecks.mockResolvedValue([
      { name: "ci", source: "check_run", status: "completed", conclusion: "success" },
    ]);
    await worker().tick();
    expect(gatePost.mock.calls[0]).toEqual([expect.objectContaining({ event: "APPROVE" })]);
    expect(readPostingReceipt(dir, 12, 1)).toMatchObject({ actual_event: "APPROVE" });
  });

  it("unreadable CI posts nothing and waits as long as GitHub asked", async () => {
    listChecks.mockRejectedValue(new GitHubRequestError("GET", "/x", 429, "rate limit", 900_000));
    await worker().tick();
    expect(gatePost).not.toHaveBeenCalled();
    expect(pendingPosting(dir, 12, 1, key)).toBe(true);
    const j = JSON.parse(readFileSync(join(dir, "pr-12-round-1.outbox.json"), "utf8"));
    expect(j.next_attempt_at).toBe(new Date(clock + 900_000).toISOString());
    // A delivery attempt, and not a POST one.
    // MUTATION: drop the unposted_attempts count on a held delivery — this fails.
    expect(j).toMatchObject({ attempts: 1, unposted_attempts: 1 });
  });
});

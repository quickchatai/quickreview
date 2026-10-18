// The deferred-posting retry: a session review POST GitHub answered 5xx (or not
// at all) and whose marker was not on GitHub is a `deferred` receipt beside an
// outbox job; the daemon retries it on a bounded schedule (state.db row),
// reading the marker before every attempt and posting through the gate.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostingOutbox, pendingPosting, type PostingJob } from "../src/posting-outbox.js";
import {
  parsePostingReceipt,
  postingMarker,
  postingReceiptPath,
  readPostingReceipt,
  roundPostingKey,
} from "../src/posting-receipt.js";
import { StateStore } from "../src/state.js";

const MIN = 60_000;
const head = "b".repeat(40);
const key = roundPostingKey(12, 1, head);
const t0 = Date.parse("2026-10-14T10:00:00Z");
let dir: string;
let clock: number;
let store: StateStore;
let reviews: Array<{
  id: number;
  user: string;
  body: string;
  state: string;
  commit_id: string;
  submitted_at: string | null;
}>;
let owed: boolean;
const createReview = vi.fn();
const deliver = vi.fn();
const listReviewsFull = vi.fn();
const onExhausted = vi.fn();

function writeDeferred(event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT" = "REQUEST_CHANGES"): void {
  const payload = { commit_id: head, event, body: `Review\n\n${postingMarker(key)}` };
  const sha = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  const job: PostingJob = {
    version: 1,
    posting_key: key,
    repo: "org/repo",
    mode: "live",
    pr: 12,
    round_no: 1,
    head_sha: head,
    intended_event: event,
    payload,
    payload_sha256: sha,
    status: "pending",
    attempts: 0,
    created_at: new Date(t0).toISOString(),
    next_attempt_at: new Date(t0).toISOString(),
    deferred_at: new Date(t0).toISOString(),
    last_error: "GitHub answered 502; marker read: none",
  };
  writeFileSync(join(dir, "pr-12-round-1.outbox.json"), JSON.stringify(job));
  writeFileSync(
    postingReceiptPath(dir, 12, 1),
    JSON.stringify({
      version: 1,
      posting_key: key,
      marker: postingMarker(key),
      pr: 12,
      round_no: 1,
      head_sha: head,
      intended_event: event,
      actual_event: event,
      status: "deferred",
      payload_sha256: sha,
      prepared_at: new Date(t0 - 1000).toISOString(),
      deferred_at: new Date(t0).toISOString(),
      defer_reason: "GitHub answered 502; marker read: none",
    }),
  );
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
    deferred: {
      ledger: store,
      offsetsMs: [4 * MIN, 12 * MIN, 36 * MIN],
      windowMs: 60 * MIN,
      deliver,
      owed: () => owed,
      onExhausted,
    },
  });
}
const at = (min: number) => {
  clock = t0 + min * MIN;
};
const jobFile = () => JSON.parse(readFileSync(join(dir, "pr-12-round-1.outbox.json"), "utf8"));
const unavailable = () => Object.assign(new Error("GitHub 502"), { status: 502 });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "posting-deferred-"));
  store = new StateStore(":memory:");
  clock = t0;
  reviews = [];
  owed = true;
  for (const f of [createReview, deliver, listReviewsFull, onExhausted]) f.mockReset();
  listReviewsFull.mockImplementation(async () => reviews);
  deliver.mockResolvedValue({
    executed: true,
    response: { id: 88, commit_id: head, state: "CHANGES_REQUESTED" },
  });
  writeDeferred();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("deferred review posting", () => {
  it("waits for the first offset, then posts through the gate route and confirms", async () => {
    at(3.9);
    await worker().tick();
    expect(listReviewsFull).not.toHaveBeenCalled();
    expect(pendingPosting(dir, 12, 1, key)).toBe(true);
    expect(store.postingRetry(key)).toMatchObject({ status: "pending", attempts: 0 });
    expect(jobFile().next_attempt_at).toBe(new Date(t0 + 4 * MIN).toISOString());
    at(4);
    await worker().tick();
    expect(listReviewsFull).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(12, jobFile().payload, key);
    expect(createReview).not.toHaveBeenCalled(); // never the open-ended route
    expect(readPostingReceipt(dir, 12, 1)).toMatchObject({
      status: "confirmed",
      gh_review_id: 88,
      delivered_by: "daemon_retry",
    });
    expect(store.postingRetry(key)).toMatchObject({ status: "confirmed", attempts: 1 });
    expect(jobFile()).toMatchObject({ status: "done", attempts: 1 }); // the ledger's count
    expect(pendingPosting(dir, 12, 1, key)).toBe(false);
  });

  it("confirms from a marker found before an attempt, without POSTing", async () => {
    reviews = [
      {
        id: 55,
        user: "review[bot]",
        body: `Review\n\n${postingMarker(key)}`,
        commit_id: head,
        state: "CHANGES_REQUESTED",
        submitted_at: new Date(t0).toISOString(),
      },
    ];
    at(4);
    await worker().tick();
    expect(deliver).not.toHaveBeenCalled();
    expect(readPostingReceipt(dir, 12, 1)).toMatchObject({ status: "confirmed", gh_review_id: 55 });
    expect(store.postingRetry(key)?.status).toBe("confirmed");
  });

  it("a guard refusal at retry time is the guard's outcome: nothing posted, debt over, loud", async () => {
    deliver.mockResolvedValueOnce({ executed: false, blocked: "pr-merged" });
    at(4);
    await worker().tick();
    expect(readPostingReceipt(dir, 12, 1)?.status).toBe("deferred");
    expect(store.postingRetry(key)?.status).toBe("exhausted");
    expect(onExhausted).toHaveBeenCalledWith(
      expect.objectContaining({ posting_key: key }),
      expect.stringContaining("pr-merged"),
    );
    expect(pendingPosting(dir, 12, 1, key)).toBe(false);
  });

  it("a guard softening (APPROVE → COMMENT on red CI) confirms as a withheld approval", async () => {
    writeDeferred("APPROVE");
    deliver.mockResolvedValueOnce({
      executed: true,
      response: { id: 89, commit_id: head, state: "COMMENTED" },
    });
    at(4);
    await worker().tick();
    expect(readPostingReceipt(dir, 12, 1)).toMatchObject({
      status: "confirmed",
      intended_event: "APPROVE",
      actual_event: "COMMENT",
      delivered_by: "daemon_retry",
    });
  });

  it("retries 3 times inside the hour, then exhausts loud", async () => {
    deliver.mockRejectedValue(unavailable());
    for (const [min, attempts] of [
      [4, 1],
      [11.9, 1],
      [12, 2],
      [35, 2],
      [36, 3],
    ] as const) {
      at(min);
      await worker().tick();
      expect(deliver).toHaveBeenCalledTimes(attempts);
    }
    expect(store.postingRetry(key)).toMatchObject({ status: "exhausted", attempts: 3 });
    expect(onExhausted).toHaveBeenCalledTimes(1);
    expect(jobFile()).toMatchObject({ status: "failed", attempts: 3 });
    at(59);
    await worker().tick();
    expect(deliver).toHaveBeenCalledTimes(3);
  });

  it("resumes the schedule after a restart (state.db row, fresh worker)", async () => {
    deliver.mockRejectedValueOnce(unavailable());
    at(4);
    await worker().tick();
    expect(store.postingRetry(key)).toMatchObject({ attempts: 1, status: "pending" });
    // A restart: a new worker over the same files and the same state.db.
    at(8);
    await worker().tick();
    expect(deliver).toHaveBeenCalledTimes(1);
    at(12);
    await worker().tick();
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(store.postingRetry(key)).toMatchObject({ attempts: 2, status: "confirmed" });
  });

  it("an attempt counted before a crash is never repeated", async () => {
    // A crash after the attempt was counted, before its outcome was written.
    store.adoptPostingRetry({
      posting_key: key,
      pr: 12,
      round_no: 1,
      head_sha: head,
      first_failed_at: new Date(t0).toISOString(),
      now: new Date(t0).toISOString(),
    });
    store.beginPostingRetryAttempt(key, 0, new Date(t0 + 4 * MIN).toISOString());
    at(5);
    await worker().tick();
    expect(deliver).not.toHaveBeenCalled();
    at(12);
    await worker().tick();
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("past the window (daemon down) it reads the marker once and never POSTs", async () => {
    at(75);
    await worker().tick();
    expect(listReviewsFull).toHaveBeenCalledTimes(1);
    expect(deliver).not.toHaveBeenCalled();
    expect(store.postingRetry(key)?.status).toBe("exhausted");
    expect(onExhausted).toHaveBeenCalledTimes(1);
  });

  it("a marker read that fails consumes the attempt and never POSTs", async () => {
    listReviewsFull.mockRejectedValueOnce(new Error("offline"));
    at(4);
    await worker().tick();
    expect(deliver).not.toHaveBeenCalled();
    expect(store.postingRetry(key)).toMatchObject({ attempts: 1, status: "pending" });
    expect(jobFile().next_attempt_at).toBe(new Date(t0 + 12 * MIN).toISOString());
  });

  it("a round that no longer owes the posting (operator u) is abandoned, never posted", async () => {
    owed = false;
    at(4);
    await worker().tick();
    expect(deliver).not.toHaveBeenCalled();
    expect(store.postingRetry(key)?.status).toBe("abandoned");
    expect(pendingPosting(dir, 12, 1, key)).toBe(false);
  });

  it("without the deferred wiring a deferred job is never posted by the open-ended route", async () => {
    at(30);
    await new PostingOutbox({
      dir,
      repo: "org/repo",
      dryRun: false,
      botLogins: ["review[bot]"],
      now: () => new Date(clock),
      adapter: { createReview, listReviewsFull },
      current: () => true,
      log: () => {},
    }).tick();
    expect(createReview).not.toHaveBeenCalled();
    expect(listReviewsFull).not.toHaveBeenCalled();
  });
});

describe("the deferred receipt shape", () => {
  it("parses only with its first-failure time", () => {
    const raw = JSON.parse(readFileSync(postingReceiptPath(dir, 12, 1), "utf8"));
    expect(parsePostingReceipt(JSON.stringify(raw))?.status).toBe("deferred");
    delete raw.deferred_at;
    expect(parsePostingReceipt(JSON.stringify(raw))).toBeUndefined();
  });
});

it("recovers the job-first interrupted deferral before ordinary delivery can adopt it", async () => {
  writeDeferred();
  const path = postingReceiptPath(dir, 12, 1);
  const receipt = JSON.parse(readFileSync(path, "utf8"));
  receipt.status = "prepared"; delete receipt.deferred_at; delete receipt.defer_reason;
  writeFileSync(path, JSON.stringify(receipt));
  await worker().tick();
  expect(readPostingReceipt(dir, 12, 1)?.status).toBe("deferred");
  expect(store.postingRetry(key)?.first_failed_at).toBe(new Date(t0).toISOString());
  expect(deliver).not.toHaveBeenCalled();
  at(4); await worker().tick();
  expect(deliver).toHaveBeenCalledTimes(1);
  expect(createReview).not.toHaveBeenCalled();
});

it.each(["missing", "prepared-mismatch", "deferred-mismatch", "deferred-event"])("withholds ordinary replay for an unproven deferred handoff (%s)", async (kind) => {
  writeDeferred();
  const path = postingReceiptPath(dir, 12, 1);
  if (kind === "missing") rmSync(path);
  else {
    const receipt = JSON.parse(readFileSync(path, "utf8"));
    receipt.status = kind === "prepared-mismatch" ? "prepared" : "deferred";
    if (kind === "deferred-event") receipt.actual_event = "COMMENT";
    else receipt.payload_sha256 = "c".repeat(64);
    writeFileSync(path, JSON.stringify(receipt));
  }
  for (const minute of [0, 4, 60]) { at(minute); await worker().tick(); }
  expect(createReview).not.toHaveBeenCalled();
  expect(deliver).not.toHaveBeenCalled();
  expect(store.postingRetry(key)).toBeUndefined();
});

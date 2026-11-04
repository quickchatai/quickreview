// The deferred-posting retry: a session review POST GitHub answered 5xx (or not
// at all) and whose marker was not on GitHub is a `deferred` receipt beside an
// outbox job; the daemon retries it on a bounded schedule (state.db row),
// reading the marker before every attempt and posting through the gate.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PostingOutbox,
  pendingPosting,
  withApprovalCiPrecheck,
  type PostingJob,
} from "../src/posting-outbox.js";
import {
  parsePostingReceipt,
  postingMarker,
  postingReceiptPath,
  readPostingReceipt,
  retrySoftenedApproval,
  roundPostingKey,
  type PostingReceipt,
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

  it("a confirmed receipt left beside a pending job and retry row settles both after a restart", async () => {
    store.adoptPostingRetry({
      posting_key: key,
      pr: 12,
      round_no: 1,
      head_sha: head,
      first_failed_at: new Date(t0).toISOString(),
      now: new Date(t0).toISOString(),
    });
    // A crash after the delivery's receipt was written, before its job and ledger row were.
    const receiptFile = postingReceiptPath(dir, 12, 1);
    const receipt = JSON.parse(readFileSync(receiptFile, "utf8"));
    writeFileSync(
      receiptFile,
      JSON.stringify({
        ...receipt,
        status: "confirmed",
        confirmed_at: new Date(t0 + 4 * MIN).toISOString(),
        gh_review_id: 90,
        gh_commit_id: head,
        gh_state: "CHANGES_REQUESTED",
      }),
    );
    at(5);
    await worker().tick();
    expect(jobFile().status).toBe("done");
    expect(store.postingRetry(key)?.status).toBe("confirmed");
    expect(deliver).not.toHaveBeenCalled();
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

  // MUTATION: call `failed` instead of `unsent` on the marker read — this fails.
  it("a marker read that fails moves to the next offset and uses no POST attempt", async () => {
    listReviewsFull.mockRejectedValueOnce(new Error("offline"));
    at(4);
    await worker().tick();
    expect(deliver).not.toHaveBeenCalled();
    expect(store.postingRetry(key)).toMatchObject({ attempts: 1, status: "pending" });
    expect(jobFile()).toMatchObject({ unposted_attempts: 1 });
    expect(jobFile().next_attempt_at).toBe(new Date(t0 + 12 * MIN).toISOString());
    // All three POST attempts are still there: 12, 36, and one past the offsets.
    deliver.mockRejectedValue(unavailable());
    for (const min of [12, 36]) {
      at(min);
      await worker().tick();
    }
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(store.postingRetry(key)?.status).toBe("pending");
    at(60);
    await worker().tick();
    expect(deliver).toHaveBeenCalledTimes(3);
    expect(store.postingRetry(key)?.status).toBe("exhausted");
    expect(onExhausted).toHaveBeenCalledTimes(1);
  });

  // MUTATION: set DEFERRED_READ_WINDOW_FACTOR to 1 — this fails (exhausted at
  // the first window instead of reading on).
  it("while only reads fail the window stretches to its ceiling, then exhausts loud with no POST", async () => {
    listReviewsFull.mockRejectedValue(new Error("offline"));
    for (let min = 4; min <= 200; min += 4) {
      at(min);
      await worker().tick();
      if (min < 180) expect(store.postingRetry(key)?.status, `at ${min} min`).toBe("pending");
    }
    expect(deliver).not.toHaveBeenCalled();
    expect(store.postingRetry(key)?.status).toBe("exhausted");
    expect(onExhausted).toHaveBeenCalledTimes(1);
    expect(onExhausted.mock.calls[0]![1]).toMatch(
      /could not be read for 180 min.*no POST sent by this attempt; 0 POST attempt\(s\) in all/,
    );
    expect(jobFile().status).toBe("failed");
  });

  it("a rate-limited POST sends nothing and uses no POST attempt", async () => {
    deliver.mockRejectedValueOnce(Object.assign(new Error("rate limit"), { status: 429 }));
    at(4);
    await worker().tick();
    expect(store.postingRetry(key)).toMatchObject({ attempts: 1, status: "pending" });
    expect(jobFile()).toMatchObject({ unposted_attempts: 1 });
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

// The deferred retry of an APPROVE carries the CI pre-check the session's own
// post made (wire.ts wires `withApprovalCiPrecheck` around the gated POST).
describe("a deferred APPROVE and its CI pre-check", () => {
  const listChecks = vi.fn();
  const post = vi.fn();
  beforeEach(() => {
    writeDeferred("APPROVE");
    listChecks.mockReset();
    post.mockReset();
    deliver.mockImplementation((pr: number, payload: PostingJob["payload"], postingKey: string) =>
      withApprovalCiPrecheck({ listChecks, enabled: true }, pr, payload, () =>
        post(pr, payload, postingKey),
      ),
    );
  });

  // MUTATION: drop the listChecks read in withApprovalCiPrecheck — this fails.
  it("unreadable CI makes no POST, moves to the next offset, and uses no POST attempt", async () => {
    listChecks.mockRejectedValueOnce(unavailable());
    at(4);
    await worker().tick();
    expect(listChecks).toHaveBeenCalledWith(head);
    expect(post).not.toHaveBeenCalled();
    expect(store.postingRetry(key)).toMatchObject({ attempts: 1, status: "pending" });
    expect(jobFile()).toMatchObject({ unposted_attempts: 1, status: "pending" });
    expect(jobFile().next_attempt_at).toBe(new Date(t0 + 12 * MIN).toISOString());
    // CI reads green at the next offset: the approval posts.
    listChecks.mockResolvedValue([{ name: "ci", status: "completed", conclusion: "success" }]);
    post.mockResolvedValue({
      executed: true,
      response: { id: 91, commit_id: head, state: "APPROVED" },
    });
    at(12);
    await worker().tick();
    expect(post).toHaveBeenCalledTimes(1);
    expect(readPostingReceipt(dir, 12, 1)).toMatchObject({
      status: "confirmed",
      actual_event: "APPROVE",
    });
  });

  it("red CI goes on to the gate, whose softened COMMENT confirms as a withheld approval", async () => {
    listChecks.mockResolvedValue([{ name: "ci", status: "completed", conclusion: "failure" }]);
    // Guard 4 on the gate softens the APPROVE; the gate's answer is the COMMENT.
    post.mockResolvedValue({
      executed: true,
      response: { id: 92, commit_id: head, state: "COMMENTED" },
    });
    at(4);
    await worker().tick();
    expect(post).toHaveBeenCalledWith(12, expect.objectContaining({ event: "APPROVE" }), key);
    const receipt = readPostingReceipt(dir, 12, 1) as PostingReceipt;
    expect(receipt).toMatchObject({
      status: "confirmed",
      intended_event: "APPROVE",
      actual_event: "COMMENT",
      delivered_by: "daemon_retry",
    });
    expect(retrySoftenedApproval(receipt)).toBe(true);
  });

  it("a COMMENT, or an install that does not block approvals on CI, reads no checks", async () => {
    const posted = { executed: true } as const;
    const send = vi.fn(async () => posted);
    const payload = { commit_id: head, event: "COMMENT" as const, body: "x" };
    await withApprovalCiPrecheck({ listChecks, enabled: true }, 12, payload, send);
    await withApprovalCiPrecheck(
      { listChecks, enabled: false },
      12,
      {
        ...payload,
        event: "APPROVE",
      },
      send,
    );
    expect(listChecks).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(2);
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
  receipt.status = "prepared";
  delete receipt.deferred_at;
  delete receipt.defer_reason;
  writeFileSync(path, JSON.stringify(receipt));
  await worker().tick();
  expect(readPostingReceipt(dir, 12, 1)?.status).toBe("deferred");
  expect(store.postingRetry(key)?.first_failed_at).toBe(new Date(t0).toISOString());
  expect(deliver).not.toHaveBeenCalled();
  at(4);
  await worker().tick();
  expect(deliver).toHaveBeenCalledTimes(1);
  expect(createReview).not.toHaveBeenCalled();
});

it.each(["missing", "prepared-mismatch", "deferred-mismatch", "deferred-event"])(
  "withholds ordinary replay for an unproven deferred handoff (%s)",
  async (kind) => {
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
    for (const minute of [0, 4, 60]) {
      at(minute);
      await worker().tick();
    }
    expect(createReview).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    expect(store.postingRetry(key)).toBeUndefined();
  },
);

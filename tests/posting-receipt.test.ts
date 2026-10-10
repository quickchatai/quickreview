import { describe, expect, it } from "vitest";
import {
  guardedNoopMatchesMark,
  parsePostingReceipt,
  postingMarker,
  receiptMatchesVerdict,
  roundPostingKey,
  type GuardedNoopReceipt,
  type PostingReceipt,
} from "../src/posting-receipt.js";
import type { ReviewedHeadRow } from "../src/state.js";

const HEAD = "AbC123";

describe("posting receipt identity", () => {
  it("is deterministic per PR round and normalized head", () => {
    const key = roundPostingKey(5408, 23, HEAD);
    expect(key).toBe("v1:5408:23:abc123");
    expect(postingMarker(key)).toBe("<!-- qcr-post:v1:5408:23:abc123 -->");
  });

  it("accepts a confirmed response only when id and commit match", () => {
    const key = roundPostingKey(5408, 23, HEAD);
    const receipt = parsePostingReceipt(
      JSON.stringify({
        version: 1,
        posting_key: key,
        marker: postingMarker(key),
        pr: 5408,
        round_no: 23,
        head_sha: "abc123",
        intended_event: "REQUEST_CHANGES",
        actual_event: "REQUEST_CHANGES",
        status: "confirmed",
        payload_sha256: "a".repeat(64),
        prepared_at: "2026-08-28T10:00:00Z",
        confirmed_at: "2026-08-28T10:00:01Z",
        gh_review_id: 123,
        gh_commit_id: "abc123",
        gh_state: "CHANGES_REQUESTED",
      }),
    );
    expect((receipt as PostingReceipt | undefined)?.gh_review_id).toBe(123);
    expect(
      receiptMatchesVerdict(receipt as PostingReceipt, {
        pr: 5408,
        round_no: 23,
        verdict: "REQUEST_CHANGES",
        head_sha: "abc123",
        finished_at: "2026-08-28T10:00:02Z",
      }),
    ).toBe(true);
    expect(
      parsePostingReceipt(JSON.stringify({ ...receipt, gh_commit_id: "wrong" })),
    ).toBeUndefined();
    expect(
      parsePostingReceipt(JSON.stringify({ ...receipt, gh_state: "COMMENTED" })),
    ).toBeUndefined();
  });

  it("models guard-softened and red-CI COMMENT outcomes without inventing approval", () => {
    const base = {
      version: 1 as const,
      posting_key: "v1:1:1:abc",
      marker: "<!-- qcr-post:v1:1:1:abc -->",
      pr: 1,
      round_no: 1,
      head_sha: "abc",
      intended_event: "APPROVE" as const,
      actual_event: "COMMENT" as const,
      status: "dryrun" as const,
      payload_sha256: "b".repeat(64),
      prepared_at: "2026-08-28T10:00:00Z",
    };
    expect(
      receiptMatchesVerdict(base, {
        pr: 1,
        round_no: 1,
        verdict: "APPROVE",
        approval_withheld: true,
        head_sha: "abc",
        finished_at: "x",
      }),
    ).toBe(true);
    expect(
      receiptMatchesVerdict(base, {
        pr: 1,
        round_no: 1,
        verdict: "APPROVE",
        head_sha: "abc",
        finished_at: "x",
      }),
    ).toBe(false);
  });
});

// ---- the guarded no-op record ------------------------------------------------

const NOOP_HEAD = "a746573675f8eae0f13e69ad83006190aa8436e4";
const NOOP_KEY = roundPostingKey(5409, 18, NOOP_HEAD);

/** The `skipped` record post-review.sh writes when guard 2 refuses a posting
 * (a real PR's round as the fixture). */
const noop = (
  over: Record<string, unknown> = {},
  mark: Record<string, unknown> = {},
): Record<string, unknown> => ({
  version: 1,
  posting_key: NOOP_KEY,
  marker: postingMarker(NOOP_KEY),
  pr: 5409,
  round_no: 18,
  head_sha: NOOP_HEAD,
  status: "skipped",
  skip_reason: "no-new-evidence",
  intended_event: "REQUEST_CHANGES",
  mode: "live",
  skipped_at: "2026-09-01T19:31:15.348Z",
  standing_mark: {
    head_sha: NOOP_HEAD,
    reviewed_at: "2026-09-01T10:41:34.773Z",
    verdict: null,
    posted_event: "REQUEST_CHANGES",
    round_no: null,
    last_author_reply_at: null,
    ...mark,
  },
  ...over,
});

const liveMark = (over: Partial<ReviewedHeadRow> = {}): ReviewedHeadRow => ({
  pr: 5409,
  head_sha: NOOP_HEAD,
  reviewed_at: "2026-09-01T10:41:34.773Z",
  verdict: null,
  posted_event: "REQUEST_CHANGES",
  round_no: null,
  last_author_reply_at: null,
  ...over,
});

describe("guarded no-op record", () => {
  it("parses the #5409 refusal exactly, as its own shape", () => {
    const parsed = parsePostingReceipt(JSON.stringify(noop()));
    expect(parsed?.status).toBe("skipped");
    const record = parsed as GuardedNoopReceipt;
    expect(record).toMatchObject({
      posting_key: NOOP_KEY,
      pr: 5409,
      round_no: 18,
      head_sha: NOOP_HEAD,
      skip_reason: "no-new-evidence",
      intended_event: "REQUEST_CHANGES",
      mode: "live",
      standing_mark: {
        head_sha: NOOP_HEAD,
        posted_event: "REQUEST_CHANGES",
        verdict: null,
        last_author_reply_at: null,
      },
    });
    expect(record).not.toHaveProperty("actual_event");
    expect(record).not.toHaveProperty("gh_review_id");
  });

  it("a reply strictly before the review is consistent with the refusal", () => {
    expect(
      parsePostingReceipt(
        JSON.stringify(noop({}, { last_author_reply_at: "2026-09-01T10:41:34.772Z" })),
      )?.status,
    ).toBe("skipped");
  });

  it.each<[string, Record<string, unknown>, Record<string, unknown>]>([
    ["another skip reason", { skip_reason: "head-drift" }, {}],
    ["a missing standing mark", { standing_mark: undefined }, {}],
    ["a standing mark at another head", {}, { head_sha: "0000000" }],
    [
      "an author reply at the review instant (ambiguous ⇒ new evidence)",
      {},
      { last_author_reply_at: "2026-09-01T10:41:34.773Z" },
    ],
    ["an author reply after the review", {}, { last_author_reply_at: "2026-09-01T11:00:00.000Z" }],
    ["an undecided NEEDS_HUMAN mark", {}, { verdict: "NEEDS_HUMAN" }],
    ["an undecided ESCALATE mark", {}, { verdict: "ESCALATE" }],
    ["a wrong marker", { marker: "<!-- qcr-post:v1:5409:18:other -->" }, {}],
    ["an unknown mode", { mode: "test" }, {}],
    ["an unparseable skipped_at", { skipped_at: "yesterday" }, {}],
    ["a non-integer round in the mark", {}, { round_no: "18" }],
    [
      "an attempted-post lookalike wearing the skipped status",
      {
        actual_event: "REQUEST_CHANGES",
        payload_sha256: "a".repeat(64),
        prepared_at: "2026-09-01T19:31:15.000Z",
        standing_mark: undefined,
      },
      {},
    ],
  ])("fails closed on %s", (_label, over, mark) => {
    expect(parsePostingReceipt(JSON.stringify(noop(over, mark)))).toBeUndefined();
  });

  it("matches the live mark field by field, tolerating only a later author reply", () => {
    const record = parsePostingReceipt(JSON.stringify(noop())) as GuardedNoopReceipt;
    expect(guardedNoopMatchesMark(record, liveMark())).toBe(true);
    // A reply that landed AFTER the refusal is new evidence for the next
    // interaction, not a contradiction of this one.
    expect(
      guardedNoopMatchesMark(
        record,
        liveMark({ last_author_reply_at: "2026-09-01T19:40:00.000Z" }),
      ),
    ).toBe(true);
    // A live reply at or after the review but at or before the refusal means
    // guard 2 would have answered "new evidence": the record did not read
    // the mark it claims to have read.
    expect(
      guardedNoopMatchesMark(
        record,
        liveMark({ last_author_reply_at: "2026-09-01T12:00:00.000Z" }),
      ),
    ).toBe(false);
    expect(
      guardedNoopMatchesMark(
        record,
        liveMark({ last_author_reply_at: "2026-09-01T19:31:15.348Z" }),
      ),
    ).toBe(false);
    expect(
      guardedNoopMatchesMark(
        record,
        liveMark({ last_author_reply_at: "2026-09-01T10:41:34.773Z" }),
      ),
    ).toBe(false);
    // A reply from BEFORE the review was already answered by it.
    expect(
      guardedNoopMatchesMark(
        record,
        liveMark({ last_author_reply_at: "2026-09-01T09:00:00.000Z" }),
      ),
    ).toBe(true);
    // A refusal cannot precede the review it claims to have refused on.
    const early = parsePostingReceipt(
      JSON.stringify(noop({ skipped_at: "2026-09-01T10:00:00.000Z" })),
    ) as GuardedNoopReceipt;
    expect(guardedNoopMatchesMark(early, liveMark())).toBe(false);
    expect(guardedNoopMatchesMark(record, undefined)).toBe(false);
    expect(guardedNoopMatchesMark(record, liveMark({ head_sha: "0000000" }))).toBe(false);
    expect(
      guardedNoopMatchesMark(record, liveMark({ reviewed_at: "2026-09-01T19:35:00.000Z" })),
    ).toBe(false);
    expect(
      guardedNoopMatchesMark(record, liveMark({ verdict: "REQUEST_CHANGES", round_no: 12 })),
    ).toBe(false);
    expect(guardedNoopMatchesMark(record, liveMark({ posted_event: "COMMENT" }))).toBe(false);
  });
});

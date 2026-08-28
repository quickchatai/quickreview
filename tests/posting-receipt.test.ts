import { describe, expect, it } from "vitest";
import { parsePostingReceipt, postingMarker, receiptMatchesVerdict, roundPostingKey } from "../src/posting-receipt.js";

const HEAD = "AbC123";

describe("posting receipt identity", () => {
  it("is deterministic per PR round and normalized head", () => {
    const key = roundPostingKey(5408, 23, HEAD);
    expect(key).toBe("v1:5408:23:abc123");
    expect(postingMarker(key)).toBe("<!-- qcr-post:v1:5408:23:abc123 -->");
  });

  it("accepts a confirmed response only when id and commit match", () => {
    const key = roundPostingKey(5408, 23, HEAD);
    const receipt = parsePostingReceipt(JSON.stringify({
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
    }));
    expect(receipt?.gh_review_id).toBe(123);
    expect(receiptMatchesVerdict(receipt!, {
      pr: 5408, round_no: 23, verdict: "REQUEST_CHANGES", head_sha: "abc123", finished_at: "2026-08-28T10:00:02Z",
    })).toBe(true);
    expect(parsePostingReceipt(JSON.stringify({ ...receipt, gh_commit_id: "wrong" }))).toBeUndefined();
    expect(parsePostingReceipt(JSON.stringify({ ...receipt, gh_state: "COMMENTED" }))).toBeUndefined();
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
    expect(receiptMatchesVerdict(base, { pr: 1, round_no: 1, verdict: "APPROVE", approval_withheld: true, head_sha: "abc", finished_at: "x" })).toBe(true);
    expect(receiptMatchesVerdict(base, { pr: 1, round_no: 1, verdict: "APPROVE", head_sha: "abc", finished_at: "x" })).toBe(false);
  });
});

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../src/state.js";
import type { GateResult } from "../src/gate.js";
import { flushHeldWakes } from "../src/wakes.js";
import { PrConversation } from "../src/pr-conversation.js";

describe("blocked author's PR conversation", () => {
  let store: StateStore;
  let dir: string;
  let time: Date;
  const inject = vi.fn(async (_pr: number, _message: string) => {});
  const post = vi.fn(async (_pr: number, _body: string): Promise<GateResult> => ({
    executed: true,
    response: { id: 999 },
  }));
  const list = vi.fn(
    async (_pr: number) => [] as Array<{ id: number; user: string; body: string }>,
  );
  let conversation: PrConversation;
  beforeEach(() => {
    vi.resetAllMocks();
    inject.mockResolvedValue(undefined);
    post.mockResolvedValue({ executed: true, response: { id: 999 } });
    list.mockResolvedValue([]);
    time = new Date("2026-10-02T12:00:00Z");
    store = new StateStore(":memory:", () => time);
    store.upsertPr({
      number: 77,
      state: "awaiting_author",
      title: "Audit",
      author: "alice",
      head_sha: "abc",
      trigger_ts: null,
      stale_recheck: 0,
      migration_gate: 0,
    });
    store.recordReviewedHead(77, { head_sha: "abc", verdict: "REQUEST_CHANGES", round_no: 4 });
    dir = mkdtempSync(join(tmpdir(), "pr-conversation-"));
    conversation = new PrConversation({
      store,
      verdictDir: dir,
      botLogin: "review[bot]",
      inject,
      adapter: { createIssueComment: post, listIssueComments: list },
      now: () => time,
    });
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const objection = {
    pr: 77,
    comment_id: 100,
    author: "alice",
    body: "Please reconsider this blocker.",
    created_at: "2026-10-02T12:00:00Z",
  };
  const answer = (id = 100, reply = "This is pre-existing debt; I concede this finding.") =>
    writeFileSync(
      join(dir, `pr-77-conversation-comment-${id}.json`),
      JSON.stringify({ pr: 77, comment_id: id, reply }),
    );
  const advance = (ms = 60_000) => {
    time = new Date(time.getTime() + ms);
  };

  it("delivers the objection once, posts a top-level answer, and preserves the standing verdict", async () => {
    expect(
      await conversation.accept({
        pr: 77,
        comment_id: 100,
        author: "alice",
        body: "This predates my PR. Please reconsider.",
        created_at: time.toISOString(),
      }),
    ).toBe(true);
    expect(inject).toHaveBeenCalledTimes(1);
    expect(inject.mock.calls[0]?.[1]).toContain("This predates my PR");
    expect(inject.mock.calls[0]?.[1]).toContain("pr-77-conversation-comment-100.json");
    expect(
      await conversation.accept({
        pr: 77,
        comment_id: 100,
        author: "alice",
        body: "This predates my PR. Please reconsider.",
        created_at: time.toISOString(),
      }),
    ).toBe(false);
    writeFileSync(
      join(dir, "pr-77-conversation-comment-100.json"),
      JSON.stringify({
        pr: 77,
        comment_id: 100,
        reply: "You are right: this predates the audit. I concede this finding.",
      }),
    );
    await conversation.sweep();
    expect(post).toHaveBeenCalledOnce();
    expect(post.mock.calls[0]?.[0]).toBe(77);
    expect(post.mock.calls[0]?.[1]).toContain("I concede this finding");
    await conversation.sweep();
    expect(post).toHaveBeenCalledOnce();
    expect(store.getPr(77)?.state).toBe("awaiting_author");
    expect(store.reviewedHead(77)?.verdict).toBe("REQUEST_CHANGES");
    expect(store.isBotComment(999)).toBe(true);
  });

  it.each([
    { author: "bob" },
    { author: "review[bot]" },
    { pr: 99 },
    { body: " " },
    { body: "[feedback] The review is noisy" },
    { comment_id: -1 },
    { created_at: null },
    { created_at: "invalid" },
    { created_at: "2026-09-01T00:00:00Z" },
  ])("refuses unrelated or invalid intake %j", async (patch) => {
    expect(await conversation.accept({ ...objection, ...patch })).toBe(false);
    expect(inject).not.toHaveBeenCalled();
    expect(store.reviewedHead(77)?.last_author_reply_at).toBeNull();
  });

  it.each(["APPROVE", "COMMENT", "NEEDS_HUMAN"])(
    "does not wake without a standing blocker (%s)",
    async (verdict) => {
      store.recordReviewedHead(77, { head_sha: "abc", verdict });
      expect(await conversation.accept(objection)).toBe(false);
      expect(inject).not.toHaveBeenCalled();
    },
  );

  it("fails closed for an unknown posting adapter", async () => {
    const missing = new PrConversation({
      store,
      verdictDir: dir,
      botLogin: "review[bot]",
      inject,
      adapter: {},
    });
    expect(await missing.accept(objection)).toBe(false);
  });

  it("accepts a shell-stamped blocking review and case-insensitive verified author", async () => {
    store.recordReviewedHead(77, { head_sha: "new", posted_event: "REQUEST_CHANGES" });
    expect(await conversation.accept({ ...objection, author: "ALICE" })).toBe(true);
  });

  it("holds while a round is running and delivers only after it finishes", async () => {
    const round = store.startRound(77, "first", ["pass-baseline"], 75);
    await conversation.accept(objection);
    expect(inject).not.toHaveBeenCalled();
    expect(store.heldWakes(77)).toHaveLength(1);
    advance(10 * 60_000);
    await conversation.sweep();
    expect(inject).not.toHaveBeenCalled();
    store.finishRound(round, "REQUEST_CHANGES", null);
    await flushHeldWakes({ store, inject }, 77);
    expect(inject).toHaveBeenCalledOnce();
  });

  it("holds a failed injection and does not lose the claimed objection to duplicate delivery", async () => {
    inject.mockRejectedValueOnce(new Error("session unavailable"));
    await conversation.accept(objection);
    expect(store.heldWakes(77)).toHaveLength(1);
    advance(6 * 60_000);
    await conversation.sweep();
    expect(inject).toHaveBeenCalledTimes(1);
    await flushHeldWakes({ store, inject }, 77);
    expect(inject).toHaveBeenCalledTimes(2);
    expect(store.heldWakes(77)).toHaveLength(0);
    expect(await conversation.accept(objection)).toBe(false);
  });

  it("retains and recovers an evicted wake rather than silently losing the objection", async () => {
    inject.mockRejectedValueOnce(new Error("session unavailable"));
    await conversation.accept(objection);
    for (let i = 0; i < 6; i++) store.holdWake(77, `later ${i}`, "other");
    advance(6 * 60_000);
    await conversation.sweep();
    expect(
      inject.mock.calls.some((c) => c[1].includes("pr-77-conversation-comment-100.json")),
    ).toBe(true);
    expect(conversation.context(77)).toContain("pending");
  });

  it("persists an obligation across daemon restart and carries it into an explicit review", async () => {
    await conversation.accept(objection);
    conversation = new PrConversation({
      store,
      verdictDir: dir,
      botLogin: "review[bot]",
      inject,
      adapter: { createIssueComment: post, listIssueComments: list },
      now: () => time,
    });
    expect(await conversation.accept(objection)).toBe(false);
    expect(conversation.context(77)).toContain("Please reconsider this blocker");
    answer();
    await conversation.sweep();
    expect(post).toHaveBeenCalledOnce();
    expect(conversation.context(77)).toContain("I concede this finding");
  });

  it("does not restamp new evidence on replay after another explicit review", async () => {
    await conversation.accept(objection);
    expect(store.reviewedHead(77)?.last_author_reply_at).not.toBeNull();
    store.recordReviewedHead(77, { head_sha: "abc", verdict: "REQUEST_CHANGES" });
    advance();
    expect(await conversation.accept(objection)).toBe(false);
    expect(store.reviewedHead(77)?.last_author_reply_at).toBeNull();
  });

  it("recovers a landed reply after its POST response was lost, without posting twice", async () => {
    await conversation.accept(objection);
    answer();
    post.mockRejectedValueOnce(new Error("response lost"));
    await conversation.sweep();
    const landedBody = post.mock.calls[0]![1];
    list.mockResolvedValue([{ id: 888, user: "review[bot]", body: landedBody }]);
    advance();
    await conversation.sweep();
    expect(post).toHaveBeenCalledTimes(1);
    expect(store.isBotComment(888)).toBe(true);
    expect(conversation.context(77)).toContain("answered");
  });

  it("never blindly reposts after an unreadable reconciliation read", async () => {
    await conversation.accept(objection);
    answer();
    list.mockRejectedValue(new Error("API unknown"));
    await conversation.sweep();
    expect(post).not.toHaveBeenCalled();
    advance();
    await conversation.sweep();
    expect(post).not.toHaveBeenCalled();
  });

  it("locks the first answer across a failed POST even if a later file changes it", async () => {
    await conversation.accept(objection);
    answer();
    post.mockRejectedValueOnce(new Error("temporary"));
    await conversation.sweep();
    answer(100, "different answer");
    advance();
    await conversation.sweep();
    expect(post.mock.calls[1]![1]).toBe(post.mock.calls[0]![1]);
  });

  it("rejects unclaimed or cross-PR response files without posting", async () => {
    answer(101);
    await conversation.accept(objection);
    writeFileSync(
      join(dir, "pr-78-conversation-comment-100.json"),
      JSON.stringify({ pr: 78, comment_id: 100, reply: "forged" }),
    );
    await conversation.sweep();
    expect(post).not.toHaveBeenCalled();
  });

  it("allows an in-place JSON write to settle before rejecting it", async () => {
    await conversation.accept(objection);
    writeFileSync(join(dir, "pr-77-conversation-comment-100.json"), "{");
    await conversation.sweep();
    answer();
    await conversation.sweep();
    expect(post).toHaveBeenCalledOnce();
  });

  it("preserves an answer on unreadable PR state without consuming it", async () => {
    await conversation.accept(objection);
    answer();
    post.mockResolvedValueOnce({ executed: false, blocked: "pr-unreadable" });
    await conversation.sweep();
    expect(conversation.context(77)).toContain("pending");
    advance();
    await conversation.sweep();
    expect(post).toHaveBeenCalledTimes(2);
    expect(conversation.context(77)).toContain("answered");
  });

  it("does not answer after a PR closes, and dry-run records one intent", async () => {
    await conversation.accept(objection);
    answer();
    post.mockResolvedValue({ executed: false, dryRunFile: "intent.json" });
    await conversation.sweep();
    expect(post).toHaveBeenCalledOnce();
    await conversation.sweep();
    expect(post).toHaveBeenCalledOnce();
    await conversation.accept({ ...objection, comment_id: 101 });
    answer(101);
    store.db.prepare("UPDATE pr_state SET state = 'closed' WHERE number = 77").run();
    await conversation.sweep();
    expect(post).toHaveBeenCalledOnce();
    expect(await conversation.accept({ ...objection, comment_id: 102 })).toBe(false);
  });

  it("recovers recent captured author comments after downtime, not feedback or history", async () => {
    advance(1000);
    for (const c of [
      { comment_id: 100, author: "alice", body: "Please reconsider" },
      { comment_id: 101, author: "bob", body: "unrelated" },
      { comment_id: 102, author: "alice", body: "[feedback] Too noisy", tagged: true },
      { comment_id: 103, author: "alice", body: "older", created_at: "2026-09-01T00:00:00Z" },
      { comment_id: 104, author: "alice", body: "unknown timestamp", created_at: null },
    ])
      store.recordPrComment({
        pr: 77,
        source: "issue_comment",
        created_at: time.toISOString(),
        ...c,
      });
    await conversation.sweep();
    expect(inject).toHaveBeenCalledOnce();
    await conversation.sweep();
    expect(inject).toHaveBeenCalledOnce();
  });

  it("pre-review chatter cannot starve the bounded recovery batch", async () => {
    for (let i = 0; i < 30; i++)
      store.recordPrComment({
        ...objection,
        comment_id: 200 + i,
        source: "issue_comment",
        created_at: "2026-10-02T11:30:00Z",
      });
    advance(1000);
    store.recordPrComment({
      ...objection,
      source: "issue_comment",
      created_at: time.toISOString(),
    });
    await conversation.sweep();
    expect(inject).toHaveBeenCalledOnce();
    expect(inject.mock.calls[0]?.[1]).toContain("comment 100");
  });

  it("recovers an objection missed before a later blocking review re-stamps the head", async () => {
    const first = store.startRound(77, "first", ["pass-baseline"], 75);
    store.finishRound(first, "REQUEST_CHANGES", null);
    advance(1000);
    store.recordPrComment({
      ...objection,
      source: "issue_comment",
      created_at: time.toISOString(),
    });
    advance(1000);
    store.recordReviewedHead(77, { head_sha: "abc", verdict: "REQUEST_CHANGES", round_no: 5 });
    await conversation.sweep();
    expect(inject).toHaveBeenCalledOnce();
  });

  it("accepts a late valid answer without reissuing work after delivery exhaustion", async () => {
    await conversation.accept(objection);
    for (let i = 0; i < 3; i++) {
      advance(6 * 60_000);
      await conversation.sweep();
    }
    expect(conversation.context(77)).toContain("failed");
    answer();
    await conversation.sweep();
    expect(post).toHaveBeenCalledOnce();
    expect(inject).toHaveBeenCalledTimes(3);
  });

  it("retains failed response work with an observable anomaly after finite retries", async () => {
    await conversation.accept(objection);
    answer();
    list.mockRejectedValue(new Error("API failure"));
    for (let i = 0; i < 3; i++) {
      advance(3 * 60_000);
      await conversation.sweep();
    }
    expect(conversation.context(77)).toContain("failed");
    expect(post).not.toHaveBeenCalled();
    expect(store.anomalies().some((e) => e.kind === "pr_conversation_failed")).toBe(true);
  });
});

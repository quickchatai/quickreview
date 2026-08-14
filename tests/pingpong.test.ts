import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildWakeMessage,
  MAX_EXCHANGES_PER_FINDING,
  PingPongLedger,
  postReply,
  ThreadDecisionWatcher,
  threadIdOf,
  wakeResponsePath,
  writeWakeResponse,
  type AuthorReplyEvent,
} from "../src/pingpong.js";

const event: AuthorReplyEvent = {
  pr: 77,
  comment_id: 5001,
  in_reply_to_id: 4000,
  body: "This is already handled upstream,\nsee the guard in helpers.py.",
  author: "some-dev",
  path: "app/x.py",
};

let db: Database.Database;
let ledger: PingPongLedger;

beforeEach(() => {
  db = new Database(":memory:");
  ledger = new PingPongLedger(db);
});
afterEach(() => db.close());

describe("thread identity", () => {
  it("uses the thread root, falling back to the comment itself", () => {
    expect(threadIdOf(event)).toBe(4000);
    expect(threadIdOf({ comment_id: 9, in_reply_to_id: 0 })).toBe(9);
  });
});

describe("one reply per author message", () => {
  it("claims a message exactly once", () => {
    expect(ledger.claimAuthorMessage(event)).toBe(true);
    expect(ledger.claimAuthorMessage(event)).toBe(false);
  });

  it("claims different messages in the same thread independently", () => {
    expect(ledger.claimAuthorMessage(event)).toBe(true);
    expect(ledger.claimAuthorMessage({ ...event, comment_id: 5002 })).toBe(true);
  });
});

describe("exchange cap", () => {
  it("allows three exchanges, marking the third as final", () => {
    expect(MAX_EXCHANGES_PER_FINDING).toBe(3);
    expect(ledger.discipline(4000)).toEqual({ allowed: true, exchanges: 0, final: false });
    ledger.recordExchange(4000, 77);
    expect(ledger.discipline(4000)).toEqual({ allowed: true, exchanges: 1, final: false });
    ledger.recordExchange(4000, 77);
    expect(ledger.discipline(4000)).toEqual({ allowed: true, exchanges: 2, final: true });
  });

  it("blocks the fourth exchange with the cap reason", () => {
    for (let i = 0; i < 3; i++) ledger.recordExchange(4000, 77);
    expect(ledger.discipline(4000)).toEqual({
      allowed: false,
      exchanges: 3,
      final: true,
      reason: "exchange-cap-reached",
    });
  });

  it("counts per thread, not per PR", () => {
    for (let i = 0; i < 3; i++) ledger.recordExchange(4000, 77);
    expect(ledger.discipline(4001).allowed).toBe(true);
  });

  it("persists across ledger instances on the same db", () => {
    ledger.recordExchange(4000, 77);
    expect(new PingPongLedger(db).exchanges(4000)).toBe(1);
  });
});

describe("buildWakeMessage", () => {
  it("carries thread context, the quoted message and the discipline rules", () => {
    const msg = buildWakeMessage(event, { finding_id: "F2", finding: "[blocker] missing await", head_sha: "abc123", worktree: "wt/pr-77" }, ledger.discipline(4000));

    expect(msg).toContain("# Author reply — PR #77");
    expect(msg).toContain("`4000`");
    expect(msg).toContain("ledger F2");
    expect(msg).toContain("app/x.py");
    expect(msg).toContain("@some-dev");
    expect(msg).toContain("abc123");
    expect(msg).toContain("Exchanges so far in this thread**: 0/3");
    expect(msg).toContain("[blocker] missing await");
    expect(msg).toContain("> This is already handled upstream,");
    expect(msg).toContain("> see the guard in helpers.py.");
    expect(msg).toContain("Post **one** reply");
    expect(msg).toContain("Never change a posted verdict");
    expect(msg).toContain("No new findings");
    expect(msg).toContain("human_requested");
  });

  it("warns that the reply is the last one when the cap is one away", () => {
    ledger.recordExchange(4000, 77);
    ledger.recordExchange(4000, 77);
    const msg = buildWakeMessage(event, {}, ledger.discipline(4000));
    expect(msg).toContain("exchange 3/3");
    expect(msg).toContain("Concede or hold in this reply");
  });

  it("tells the session not to reply at all once the cap is reached", () => {
    for (let i = 0; i < 3; i++) ledger.recordExchange(4000, 77);
    const msg = buildWakeMessage(event, {}, ledger.discipline(4000));
    expect(msg).toContain("**Do not reply again.**");
    expect(msg).not.toContain("Post **one** reply");
  });
});

describe("postReply", () => {
  function deps(createReviewCommentReply: (n: number, commentId: number, body: string) => Promise<never>) {
    return {
      adapter: { createReviewCommentReply },
      store: { registerBotComment: vi.fn(), logEvent: vi.fn() },
      ledger,
    };
  }

  it("posts through the gate, counts the exchange and registers the id", async () => {
    const fn = vi.fn().mockResolvedValue({ executed: true, response: { id: 6001 } });
    const d = deps(fn);
    const out = await postReply(d, { pr: 77, thread_id: 4000, body: "Holding this one." });

    expect(fn).toHaveBeenCalledWith(77, 4000, "Holding this one.");
    expect(out).toMatchObject({ posted: true, exchanges: 1, registered: 6001 });
    expect(d.store.registerBotComment).toHaveBeenCalledWith(6001, 77, "review_comment");
  });

  it("counts the exchange in dry-run too, without registering an id", async () => {
    const fn = vi.fn().mockResolvedValue({ executed: false, dryRunFile: "/tmp/r.json" });
    const d = deps(fn);
    const out = await postReply(d, { pr: 77, thread_id: 4000, body: "x" });

    expect(out.posted).toBe(true);
    expect(out.registered).toBeUndefined();
    expect(d.store.registerBotComment).not.toHaveBeenCalled();
    expect(d.store.logEvent).toHaveBeenCalledWith("pingpong_reply_intent", 77, expect.objectContaining({ thread_id: 4000 }));
  });

  it("suppresses the post once the exchange cap is reached", async () => {
    for (let i = 0; i < 3; i++) ledger.recordExchange(4000, 77);
    const fn = vi.fn();
    const d = deps(fn);
    const out = await postReply(d, { pr: 77, thread_id: 4000, body: "one more thing" });

    expect(fn).not.toHaveBeenCalled();
    expect(out).toEqual({ posted: false, exchanges: 3, reason: "exchange-cap-reached" });
    expect(d.store.logEvent).toHaveBeenCalledWith("pingpong_reply_suppressed", 77, expect.objectContaining({ reason: "exchange-cap-reached" }));
  });
});

describe("structured thread decision", () => {
  let root: string;
  beforeEach(() => (root = mkdtempSync(join(tmpdir(), "qcr-thread-decision-"))));
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const harness = () => {
    const createReviewCommentReply = vi.fn().mockResolvedValue({ executed: true, response: { id: 6001 } });
    const resolveOwnReviewThread = vi.fn().mockResolvedValue({ skipped: null, result: { executed: true } });
    const requestEscalationReview = vi.fn().mockResolvedValue({ skipped: null });
    const store = { registerBotComment: vi.fn(), logEvent: vi.fn() };
    const watcher = new ThreadDecisionWatcher({
      adapter: { createReviewCommentReply, resolveOwnReviewThread, requestEscalationReview },
      store,
      ledger,
      verdictDir: root,
    });
    return { watcher, createReviewCommentReply, resolveOwnReviewThread, store };
  };

  it("posts the checked response and resolves the claimed bot thread", async () => {
    ledger.claimAuthorMessage(event);
    const h = harness();
    const name = "pr-77-thread-4000-comment-5001.json";
    writeFileSync(join(root, name), JSON.stringify({
      pr: 77, thread_id: 4000, comment_id: 5001, resolution: "resolve",
      reply: "Agreed — the guard covers this case.", reason: "verified helpers.py guard",
    }));

    expect(await h.watcher.handleFile(name)).toBe(true);
    expect(h.createReviewCommentReply).toHaveBeenCalledWith(77, 4000, "Agreed — the guard covers this case.");
    expect(h.resolveOwnReviewThread).toHaveBeenCalledWith(77, 4000);
    expect(h.store.logEvent).toHaveBeenCalledWith("pingpong_thread_resolved", 77, expect.objectContaining({ thread_id: 4000 }));
  });

  it("does not duplicate the reply when thread resolution retries", async () => {
    ledger.claimAuthorMessage(event);
    const h = harness();
    h.resolveOwnReviewThread.mockRejectedValueOnce(new Error("graphql timeout")).mockResolvedValueOnce({ skipped: null });
    const name = "pr-77-thread-4000-comment-5001.json";
    writeFileSync(join(root, name), JSON.stringify({
      pr: 77, thread_id: 4000, comment_id: 5001, resolution: "resolve", reply: "That addresses it.",
    }));

    expect(await h.watcher.handleFile(name)).toBe(false);
    expect(await h.watcher.handleFile(name)).toBe(true);
    expect(h.createReviewCommentReply).toHaveBeenCalledTimes(1);
    expect(h.resolveOwnReviewThread).toHaveBeenCalledTimes(2);
  });

  it("rejects a session file that does not match a claimed author message", async () => {
    const h = harness();
    const name = "pr-77-thread-4000-comment-9999.json";
    writeFileSync(join(root, name), JSON.stringify({
      pr: 77, thread_id: 4000, comment_id: 9999, resolution: "resolve", reply: "done",
    }));
    expect(await h.watcher.handleFile(name)).toBe(true);
    expect(h.createReviewCommentReply).not.toHaveBeenCalled();
    expect(h.resolveOwnReviewThread).not.toHaveBeenCalled();
    expect(h.store.logEvent).toHaveBeenCalledWith("pingpong_decision_rejected", 77, expect.any(Object));
  });
});

describe("human_requested wake response", () => {
  let root: string;
  beforeEach(() => (root = mkdtempSync(join(tmpdir(), "qcr-wake-"))));
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("names the file so it cannot be read as a round verdict", () => {
    const path = wakeResponsePath(root, 77, "2026-08-13T18:00:00.000Z");
    expect(path).toBe(join(root, "verdict", "pr-77-wake-2026-08-13T18-00-00-000Z.json"));
    expect(path).not.toMatch(/round/);
  });

  it("writes the payload the daemon reads", () => {
    const path = writeWakeResponse(root, { pr: 77, human_requested: true, reason: "author asked for a human", thread_id: 4000 });
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      pr: 77,
      human_requested: true,
      reason: "author asked for a human",
      thread_id: 4000,
    });
  });
});

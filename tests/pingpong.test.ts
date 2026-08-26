import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildWakeMessage,
  classifyThreadDecisionError,
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

  it("waits through a partial in-place write instead of archiving it malformed", async () => {
    ledger.claimAuthorMessage(event);
    const h = harness();
    const name = "pr-77-thread-4000-comment-5001.json";
    const path = join(root, name);
    writeFileSync(path, '{"pr":77');

    expect(await h.watcher.handleFile(name)).toBe(false);
    expect(h.store.logEvent).not.toHaveBeenCalledWith("pingpong_decision_malformed", 77, expect.anything());
    writeFileSync(path, JSON.stringify({
      pr: 77, thread_id: 4000, comment_id: 5001, resolution: "resolve", reply: "Addressed.",
    }));
    expect(await h.watcher.handleFile(name)).toBe(true);
    expect(h.createReviewCommentReply).toHaveBeenCalledTimes(1);
    expect(h.resolveOwnReviewThread).toHaveBeenCalledTimes(1);
  });

  it("archives a genuinely malformed body after an unchanged settled read", async () => {
    const h = harness();
    const name = "pr-77-thread-4000-comment-5001.json";
    writeFileSync(join(root, name), '{"pr":77');

    expect(await h.watcher.handleFile(name)).toBe(false);
    expect(await h.watcher.handleFile(name)).toBe(true);
    expect(h.store.logEvent).toHaveBeenCalledWith(
      "pingpong_decision_malformed",
      77,
      expect.objectContaining({ file: name }),
    );
  });

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
    let now = new Date("2026-08-26T09:00:00Z");
    const createReviewCommentReply = vi.fn().mockResolvedValue({ executed: true, response: { id: 6001 } });
    const resolveOwnReviewThread = vi.fn().mockRejectedValueOnce(new Error("graphql timeout")).mockResolvedValueOnce({ skipped: null });
    const store = { registerBotComment: vi.fn(), logEvent: vi.fn(), logAnomaly: vi.fn() };
    const watcher = new ThreadDecisionWatcher({
      adapter: { createReviewCommentReply, resolveOwnReviewThread, requestEscalationReview: vi.fn() },
      store, ledger, verdictDir: root, now: () => now,
    });
    const name = "pr-77-thread-4000-comment-5001.json";
    writeFileSync(join(root, name), JSON.stringify({
      pr: 77, thread_id: 4000, comment_id: 5001, resolution: "resolve", reply: "That addresses it.",
    }));

    expect(await watcher.handleFile(name)).toBe(false);
    now = new Date("2026-08-26T09:00:31Z");
    expect(await watcher.handleFile(name)).toBe(true);
    expect(createReviewCommentReply).toHaveBeenCalledTimes(1);
    expect(resolveOwnReviewThread).toHaveBeenCalledTimes(2);
  });

  it("opens one global breaker on rate limit and preserves every later decision", async () => {
    let now = new Date("2026-08-26T09:00:00Z");
    const resolveOwnReviewThread = vi.fn().mockRejectedValue(new Error('graphql errors: [{"code":"graphql_rate_limit"}]'));
    const store = { registerBotComment: vi.fn(), logEvent: vi.fn(), logAnomaly: vi.fn() };
    const watcher = new ThreadDecisionWatcher({
      adapter: { createReviewCommentReply: vi.fn(), resolveOwnReviewThread, requestEscalationReview: vi.fn() },
      store, ledger, verdictDir: root, now: () => now,
    });
    for (let i = 0; i < 44; i++) {
      const comment = 6000 + i;
      ledger.claimAuthorMessage({ ...event, comment_id: comment });
      writeFileSync(join(root, `pr-77-thread-4000-comment-${comment}.json`), JSON.stringify({
        pr: 77, thread_id: 4000, comment_id: comment, resolution: "resolve", reply: "",
      }));
    }

    await watcher.sweep();
    await watcher.sweep();
    expect(resolveOwnReviewThread).toHaveBeenCalledTimes(1);
    expect(watcher.status()).toMatchObject({ breaker_state: "open", pending: 44, failed: 0 });
    now = new Date("2026-08-26T09:01:01Z");
    await watcher.sweep();
    expect(resolveOwnReviewThread).toHaveBeenCalledTimes(2);
  });

  it("closes a half-open global breaker when the probe fails for a non-rate reason", async () => {
    let now = new Date("2026-08-26T09:00:00Z");
    const resolveOwnReviewThread = vi.fn()
      .mockRejectedValueOnce(new Error('graphql errors: [{"code":"graphql_rate_limit"}]'))
      .mockRejectedValueOnce(new Error("refusing to resolve thread: root author is example-review"))
      .mockResolvedValue({ skipped: null });
    const store = { registerBotComment: vi.fn(), logEvent: vi.fn(), logAnomaly: vi.fn() };
    const watcher = new ThreadDecisionWatcher({
      adapter: { createReviewCommentReply: vi.fn(), resolveOwnReviewThread, requestEscalationReview: vi.fn() },
      store, ledger, verdictDir: root, now: () => now,
    });
    for (const comment of [6000, 6001, 6002]) {
      ledger.claimAuthorMessage({ ...event, comment_id: comment });
      writeFileSync(join(root, `pr-77-thread-4000-comment-${comment}.json`), JSON.stringify({
        pr: 77, thread_id: 4000, comment_id: comment, resolution: "resolve", reply: "",
      }));
    }

    await watcher.sweep();
    expect(watcher.status().breaker_state).toBe("open");
    now = new Date("2026-08-26T09:01:01Z");
    await watcher.sweep();

    expect(watcher.status().breaker_state).toBe("closed");
    expect(ledger.retry(6001)).toMatchObject({ attempts: 1, terminal: false });
    expect(store.logEvent).toHaveBeenCalledWith(
      "pingpong_breaker_closed", 77, expect.objectContaining({ reason: "non-rate probe failure" }),
    );
    now = new Date("2026-08-26T09:01:06Z");
    await watcher.sweep();
    expect(resolveOwnReviewThread).toHaveBeenCalledTimes(3);
    watcher.stop();
  });

  it("bounds non-rate retries and preserves an exhausted decision under failed", async () => {
    ledger.claimAuthorMessage(event);
    let now = new Date("2026-08-26T09:00:00Z");
    const resolveOwnReviewThread = vi.fn().mockRejectedValue(new Error("graphql timeout"));
    const store = { registerBotComment: vi.fn(), logEvent: vi.fn(), logAnomaly: vi.fn() };
    const watcher = new ThreadDecisionWatcher({
      adapter: { createReviewCommentReply: vi.fn(), resolveOwnReviewThread, requestEscalationReview: vi.fn() },
      store, ledger, verdictDir: root, now: () => now,
    });
    const name = "pr-77-thread-4000-comment-5001.json";
    writeFileSync(join(root, name), JSON.stringify({ pr: 77, thread_id: 4000, comment_id: 5001, resolution: "resolve", reply: "" }));

    expect(await watcher.handleFile(name)).toBe(false);
    now = new Date("2026-08-26T09:00:31Z");
    expect(await watcher.handleFile(name)).toBe(false);
    now = new Date("2026-08-26T09:02:32Z");
    expect(await watcher.handleFile(name)).toBe(false);

    expect(resolveOwnReviewThread).toHaveBeenCalledTimes(3);
    expect(watcher.status()).toMatchObject({ pending: 0, failed: 1 });
    expect(store.logAnomaly).toHaveBeenCalledWith(
      "pingpong_decision_retry_exhausted", 77, null, expect.stringContaining("comment 5001"), expect.any(String),
    );
    expect(watcher.retryFailed(5001)).toMatchObject({ ok: true, file: name });
    expect(watcher.status()).toMatchObject({ pending: 1, failed: 0 });
    watcher.stop();
  });

  it("pauses pending decisions during deployment drain", async () => {
    ledger.claimAuthorMessage(event);
    let draining = true;
    const h = harness();
    const watcher = new ThreadDecisionWatcher({
      adapter: { createReviewCommentReply: h.createReviewCommentReply, resolveOwnReviewThread: h.resolveOwnReviewThread, requestEscalationReview: vi.fn() },
      store: h.store, ledger, verdictDir: root, isDraining: () => draining,
    });
    const name = "pr-77-thread-4000-comment-5001.json";
    writeFileSync(join(root, name), JSON.stringify({ pr: 77, thread_id: 4000, comment_id: 5001, resolution: "resolve", reply: "" }));

    await watcher.sweep();
    expect(h.resolveOwnReviewThread).not.toHaveBeenCalled();
    draining = false;
    await watcher.sweep();
    expect(h.resolveOwnReviewThread).toHaveBeenCalledTimes(1);
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

describe("thread decision failure classification", () => {
  it.each([
    ["graphql → 429", "rate_limit"],
    ['graphql errors: [{"type":"RATE_LIMIT","code":"graphql_rate_limit"}]', "rate_limit"],
    ["github → 403: secondary rate limit", "rate_limit"],
    ["github → 403: forbidden", "non_rate"],
    ["comment 429 no longer exists", "non_rate"],
    ["graphql timeout", "non_rate"],
  ] as const)("classifies %s", (message, expected) => {
    expect(classifyThreadDecisionError(new Error(message))).toBe(expected);
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

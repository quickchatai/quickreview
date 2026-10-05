// Posting-time guards. Everything here runs against the real
// MutationGate with a fake executor and an in-memory store: the point of the
// design is that a guard cannot be reached around, so the tests drive the gate
// rather than the guard object.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseConfig, GUARDS_DEFAULTS, type Config } from "../src/config.js";
import { dispatchOnce, type DispatchAdapter } from "../src/dispatch.js";
import { MutationGate, type MutationIntent } from "../src/gate.js";
import {
  downgradeForHumanApproval,
  hasNewEvidence,
  humanApprovalAtHead,
  makePostingGuard,
  type GuardAdapter,
} from "../src/guards.js";
import type { GateResult } from "../src/gate.js";
import type { PrFileEntry } from "../src/github.js";
import { StateStore } from "../src/state.js";
import { applyEvent } from "../src/statemachine.js";
import { applyInterpretation } from "../src/webhook.js";
import type { RoundOrder, SessionHooks } from "../src/types.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const cfg: Config = parseConfig(
  readFileSync(resolve(process.cwd(), "tests/fixtures/config.toml"), "utf8"),
);
const BOT = cfg.github.bot_login;
const HEAD = "68b8040aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OLD = "1111111111111111111111111111111111111111";

let store: StateStore;
let dryrunDir: string;

beforeEach(() => {
  store = new StateStore(":memory:");
  dryrunDir = mkdtempSync(join(tmpdir(), "qcr-guards-"));
});
afterEach(() => {
  rmSync(dryrunDir, { recursive: true, force: true });
});

// ---- the fake read surface -------------------------------------------------

class FakeGuardAdapter implements GuardAdapter {
  pr = { state: "open" as "open" | "closed", merged: false, head_sha: HEAD, author: "alice" };
  reviews: Array<{ id: number; user: string; state: string; commit_id: string }> = [];
  failGetPr = false;
  getPrCalls = 0;

  async getPr(): Promise<{
    state: "open" | "closed";
    merged: boolean;
    head_sha: string;
    author: string;
  }> {
    this.getPrCalls++;
    if (this.failGetPr) throw new Error("GET /pulls/5180 → 502");
    return this.pr;
  }
  async listReviews(): Promise<
    Array<{ id: number; user: string; state: string; commit_id: string }>
  > {
    return this.reviews;
  }
}

interface Harness {
  gate: MutationGate;
  adapter: FakeGuardAdapter;
  executor: ReturnType<typeof vi.fn>;
}

function harness(over: Partial<Config["guards"]> = {}, dryRun = false): Harness {
  const adapter = new FakeGuardAdapter();
  const executor = vi.fn(async () => ({ id: 900, comments: [] }));
  const gate = new MutationGate(
    dryRun,
    dryrunDir,
    executor as unknown as (i: MutationIntent) => Promise<unknown>,
  );
  gate.setGuard(
    makePostingGuard({ store, adapter, botLogin: BOT, guards: { ...GUARDS_DEFAULTS, ...over } }),
  );
  return { gate, adapter, executor };
}

function reviewIntent(
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT" = "REQUEST_CHANGES",
  commitId = HEAD,
  body = "**Verdict: Changes requested** — 1 blocker.",
): MutationIntent {
  return {
    kind: "create_review",
    method: "POST",
    path: "/repos/o/r/pulls/5180/reviews",
    body: {
      commit_id: commitId,
      event,
      body,
      comments: [{ path: "a.py", line: 3, side: "RIGHT", body: "[blocker] x" }],
    },
    note: `post ${event} review on #5180`,
    pr: 5180,
  };
}

// ---- guard 1: a human already approved this head ---------------------------

describe("humanApprovalAtHead", () => {
  const at = (user: string, state: string, commit_id = HEAD) => ({ user, state, commit_id });

  it("finds a non-author human APPROVED at the head", () => {
    expect(
      humanApprovalAtHead([at("mhale", "APPROVED")], {
        head_sha: HEAD,
        author: "alice",
        botLogin: BOT,
      }),
    ).toBe("mhale");
  });

  it("ignores an approval of an older head", () => {
    expect(
      humanApprovalAtHead([at("mhale", "APPROVED", OLD)], {
        head_sha: HEAD,
        author: "alice",
        botLogin: BOT,
      }),
    ).toBeNull();
  });

  it("ignores the bot's own approval and any [bot] identity", () => {
    const reviews = [at(BOT, "APPROVED"), at("dependabot[bot]", "APPROVED")];
    expect(
      humanApprovalAtHead(reviews, { head_sha: HEAD, author: "alice", botLogin: BOT }),
    ).toBeNull();
  });

  it("ignores the PR author", () => {
    expect(
      humanApprovalAtHead([at("alice", "APPROVED")], {
        head_sha: HEAD,
        author: "alice",
        botLogin: BOT,
      }),
    ).toBeNull();
  });

  it("treats a later CHANGES_REQUESTED by the same person as retiring the approval", () => {
    const reviews = [at("mhale", "APPROVED"), at("mhale", "CHANGES_REQUESTED")];
    expect(
      humanApprovalAtHead(reviews, { head_sha: HEAD, author: "alice", botLogin: BOT }),
    ).toBeNull();
  });

  it("ignores COMMENTED reviews when deciding who still stands approved", () => {
    const reviews = [at("mhale", "APPROVED"), at("mhale", "COMMENTED")];
    expect(humanApprovalAtHead(reviews, { head_sha: HEAD, author: "alice", botLogin: BOT })).toBe(
      "mhale",
    );
  });
});

describe("guard 1 — a human approval at the head downgrades the bot to COMMENT", () => {
  it("posts COMMENT instead of REQUEST_CHANGES and keeps every finding", async () => {
    const { gate, adapter, executor } = harness();
    adapter.reviews = [{ id: 1, user: "mhale", state: "APPROVED", commit_id: HEAD }];

    const result = await gate.execute(reviewIntent("REQUEST_CHANGES"));

    expect(result.executed).toBe(true);
    expect(result.blocked).toBeUndefined();
    const sent = executor.mock.calls[0]![0] as MutationIntent;
    const body = sent.body as { event: string; body: string; comments: unknown[] };
    expect(body.event).toBe("COMMENT");
    expect(body.body).toContain("**Verdict: Changes requested**"); // findings survive
    expect(body.body).toContain("@mhale");
    expect(body.comments).toHaveLength(1); // inline findings survive
    expect(
      store.db
        .prepare("SELECT COUNT(*) AS c FROM events WHERE kind = 'posting_guard_downgraded'")
        .get(),
    ).toEqual({ c: 1 });
  });

  it("leaves REQUEST_CHANGES alone when the approval is on an older head", async () => {
    const { gate, adapter, executor } = harness();
    adapter.reviews = [{ id: 1, user: "mhale", state: "APPROVED", commit_id: OLD }];

    await gate.execute(reviewIntent("REQUEST_CHANGES"));

    expect((executor.mock.calls[0]![0] as MutationIntent).body).toMatchObject({
      event: "REQUEST_CHANGES",
    });
  });

  it("never touches an APPROVE or a COMMENT payload", async () => {
    const { gate, adapter, executor } = harness();
    adapter.reviews = [{ id: 1, user: "mhale", state: "APPROVED", commit_id: HEAD }];

    await gate.execute(reviewIntent("APPROVE"));

    expect((executor.mock.calls[0]![0] as MutationIntent).body).toMatchObject({ event: "APPROVE" });
  });

  it("downgradeForHumanApproval is pure: event swapped, body appended", () => {
    const out = downgradeForHumanApproval(
      { event: "REQUEST_CHANGES", body: "findings", commit_id: HEAD },
      "mhale",
      HEAD,
    );
    expect(out.event).toBe("COMMENT");
    expect(out.body?.startsWith("findings")).toBe(true);
    expect(out.body).toContain(HEAD.slice(0, 7));
    expect(out.commit_id).toBe(HEAD);
  });
});

// ---- guard 2: no new evidence ---------------------------------------------

describe("hasNewEvidence", () => {
  const mark = (over: Partial<ReturnType<StateStore["reviewedHead"]> & object> = {}) => ({
    pr: 1,
    head_sha: HEAD,
    reviewed_at: "2026-08-18T10:00:00.000Z",
    verdict: "REQUEST_CHANGES",
    posted_event: "REQUEST_CHANGES",
    round_no: 1,
    last_author_reply_at: null,
    ...over,
  });

  it("is true when there is no mark at all", () => {
    expect(hasNewEvidence(undefined, HEAD)).toBe(true);
  });

  it("is true on a new head, false on the reviewed one", () => {
    expect(hasNewEvidence(mark(), "deadbeef")).toBe(true);
    expect(hasNewEvidence(mark(), HEAD)).toBe(false);
  });

  it("is true again once an author reply lands after the review", () => {
    expect(hasNewEvidence(mark({ last_author_reply_at: "2026-08-18T11:00:00.000Z" }), HEAD)).toBe(
      true,
    );
    expect(hasNewEvidence(mark({ last_author_reply_at: "2026-08-18T09:00:00.000Z" }), HEAD)).toBe(
      false,
    );
  });

  it("is true when the head is unknown — never guess a skip", () => {
    expect(hasNewEvidence(mark(), "")).toBe(true);
  });
});

describe("guard 2 — the same head is never reviewed twice", () => {
  it("records the reviewed head after a review really posts", async () => {
    const { gate } = harness();
    await gate.execute(reviewIntent("REQUEST_CHANGES"));
    expect(store.reviewedHead(5180)).toMatchObject({
      head_sha: HEAD,
      posted_event: "REQUEST_CHANGES",
    });
  });

  it("blocks the second review of the same head and calls no executor", async () => {
    const { gate, executor } = harness();
    await gate.execute(reviewIntent("REQUEST_CHANGES"));
    executor.mockClear();

    const again = await gate.execute(reviewIntent("REQUEST_CHANGES"));

    expect(again.executed).toBe(false);
    expect(again.blocked).toBe("no-new-evidence");
    expect(executor).not.toHaveBeenCalled();
  });

  it("lets the review through again after an author reply", async () => {
    const { gate, executor } = harness();
    await gate.execute(reviewIntent("REQUEST_CHANGES"));
    store.noteAuthorReply(5180, "2099-01-01T00:00:00.000Z");
    executor.mockClear();

    expect((await gate.execute(reviewIntent("REQUEST_CHANGES"))).executed).toBe(true);
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it("lets the review through on a new head", async () => {
    const { gate, adapter } = harness();
    await gate.execute(reviewIntent("REQUEST_CHANGES"));
    adapter.pr = { ...adapter.pr, head_sha: "cafebabe" }; // the PR really moved
    expect((await gate.execute(reviewIntent("REQUEST_CHANGES", "cafebabe"))).executed).toBe(true);
  });

  it("records nothing in dry-run — nothing was posted, so nothing was reviewed", async () => {
    const { gate } = harness({}, true);
    const result = await gate.execute(reviewIntent("REQUEST_CHANGES"));
    expect(result.executed).toBe(false);
    expect(result.dryRunFile).toBeTruthy();
    expect(store.reviewedHead(5180)).toBeUndefined();
  });

  it("does not let a mechanical migration pre-check COMMENT mark the head reviewed", async () => {
    const { gate, executor } = harness();
    const intent: MutationIntent = {
      ...reviewIntent("COMMENT"),
      reviewPurpose: "migration_precheck",
    };

    expect((await gate.execute(intent)).executed).toBe(true);
    expect(executor).toHaveBeenCalledTimes(1); // still gated and posted
    expect(store.reviewedHead(5180)).toBeUndefined();
  });

  it("still marks an ordinary substantive COMMENT review", async () => {
    const { gate } = harness();

    expect((await gate.execute(reviewIntent("COMMENT"))).executed).toBe(true);
    expect(store.reviewedHead(5180)).toMatchObject({ head_sha: HEAD, posted_event: "COMMENT" });
  });

  it("is off when [guards] skip_unchanged_head = false", async () => {
    const { gate } = harness({ skip_unchanged_head: false });
    await gate.execute(reviewIntent("REQUEST_CHANGES"));
    expect((await gate.execute(reviewIntent("REQUEST_CHANGES"))).executed).toBe(true);
  });
});

describe("the reviewed-head mark (state)", () => {
  it("moving to a new head drops the old head's author-reply memory", () => {
    store.recordReviewedHead(7, { head_sha: OLD, verdict: "REQUEST_CHANGES" });
    store.noteAuthorReply(7, "2099-01-01T00:00:00.000Z");
    store.recordReviewedHead(7, { head_sha: HEAD, verdict: "APPROVE" });
    expect(store.reviewedHead(7)).toMatchObject({
      head_sha: HEAD,
      verdict: "APPROVE",
      last_author_reply_at: null,
    });
  });

  it("re-stamping the same head keeps fields it was not given", () => {
    store.recordReviewedHead(7, { head_sha: HEAD, verdict: "APPROVE", round_no: 2 });
    store.recordReviewedHead(7, { head_sha: HEAD, posted_event: "COMMENT" });
    expect(store.reviewedHead(7)).toMatchObject({
      verdict: "APPROVE",
      round_no: 2,
      posted_event: "COMMENT",
    });
  });

  it("noteAuthorReply only ever moves the stamp forward", () => {
    store.recordReviewedHead(7, { head_sha: HEAD });
    store.noteAuthorReply(7, "2026-08-18T12:00:00.000Z");
    store.noteAuthorReply(7, "2026-08-18T11:00:00.000Z");
    expect(store.reviewedHead(7)?.last_author_reply_at).toBe("2026-08-18T12:00:00.000Z");
  });

  it("repairs an existing migration-only mark but never a substantive mark", () => {
    store.recordReviewedHead(7, { head_sha: HEAD, posted_event: "COMMENT" });
    store.logEvent("migration_collision_comment", 7, {
      head_sha: HEAD,
      fingerprint: "fp",
      executed: true,
    });

    expect(store.repairMigrationPrecheckReviewedHead(7)).toBe(true);
    expect(store.reviewedHead(7)).toBeUndefined();
    expect(store.repairMigrationPrecheckReviewedHead(7)).toBe(false); // idempotent

    store.recordReviewedHead(8, {
      head_sha: HEAD,
      posted_event: "COMMENT",
      verdict: "REQUEST_CHANGES",
      round_no: 2,
    });
    store.logEvent("migration_collision_comment", 8, {
      head_sha: HEAD,
      fingerprint: "fp",
      executed: true,
    });
    expect(store.repairMigrationPrecheckReviewedHead(8)).toBe(false);
    expect(store.reviewedHead(8)).toMatchObject({ verdict: "REQUEST_CHANGES", round_no: 2 });
  });

  it("does not repair an unproven COMMENT mark", () => {
    store.recordReviewedHead(7, { head_sha: HEAD, posted_event: "COMMENT" });
    store.logEvent("migration_collision_comment", 7, {
      head_sha: HEAD,
      fingerprint: "fp",
      executed: false,
    });

    expect(store.repairMigrationPrecheckReviewedHead(7)).toBe(false);
    expect(store.reviewedHead(7)).toBeDefined();
  });

  it("an author reply on a webhook is recorded against the mark", async () => {
    store.upsertPr({
      number: 5180,
      state: "awaiting_author",
      head_sha: HEAD,
      title: "t",
      author: "alice",
      trigger_ts: null,
      stale_recheck: 0,
      migration_gate: 0,
    });
    store.recordReviewedHead(5180, { head_sha: HEAD, verdict: "REQUEST_CHANGES" });

    await applyInterpretation(
      { cfg, store },
      {
        kind: "author_reply",
        pr: 5180,
        comment_id: 11,
        in_reply_to_id: 10,
        author: "alice",
        body: "fixed",
        via: "thread_reply",
        scope: "review_comment",
      },
    );

    expect(store.reviewedHead(5180)?.last_author_reply_at).toBeTruthy();
    expect(hasNewEvidence(store.reviewedHead(5180), HEAD)).toBe(true);
  });
});

// ---- guard 3: merged / closed ---------------------------------------------

describe("guard 3 — merged or closed state is re-checked immediately before posting", () => {
  it("refuses to post onto a merged PR", async () => {
    const { gate, adapter, executor } = harness();
    adapter.pr = { ...adapter.pr, merged: true, state: "closed" };

    const result = await gate.execute(reviewIntent("APPROVE"));

    expect(result).toMatchObject({ executed: false, blocked: "pr-merged" });
    expect(executor).not.toHaveBeenCalled();
    expect(
      store.db
        .prepare("SELECT COUNT(*) AS c FROM events WHERE kind = 'posting_guard_blocked'")
        .get(),
    ).toEqual({ c: 1 });
  });

  it("refuses to post onto a closed-unmerged PR", async () => {
    const { gate, adapter } = harness();
    adapter.pr = { ...adapter.pr, state: "closed" };
    expect((await gate.execute(reviewIntent("COMMENT"))).blocked).toBe("pr-closed");
  });

  it("fails closed when the PR state cannot be read", async () => {
    const { gate, adapter, executor } = harness();
    adapter.failGetPr = true;
    expect((await gate.execute(reviewIntent("COMMENT"))).blocked).toBe("pr-unreadable");
    expect(executor).not.toHaveBeenCalled();
  });

  it.each(["open", "merged", "closed", "unreadable"])(
    "guards a PR conversation answer (%s) without requiring a new review",
    async (state) => {
      const { gate, adapter, executor } = harness();
      store.recordReviewedHead(5180, { head_sha: HEAD, verdict: "REQUEST_CHANGES" });
      if (state === "merged") adapter.pr = { ...adapter.pr, merged: true, state: "closed" };
      if (state === "closed") adapter.pr = { ...adapter.pr, state: "closed" };
      if (state === "unreadable") adapter.failGetPr = true;
      const result = await gate.execute({
        kind: "create_issue_comment",
        method: "POST",
        path: "/repos/o/r/issues/5180/comments",
        body: { body: "I reconsidered your objection" },
        note: "answer author",
        pr: 5180,
      });
      if (state === "open") {
        expect(result.executed).toBe(true);
        expect(executor).toHaveBeenCalledOnce();
        expect(store.reviewedHead(5180)?.verdict).toBe("REQUEST_CHANGES");
      } else {
        expect(result.blocked).toBe(
          state === "merged" ? "pr-merged" : state === "closed" ? "pr-closed" : "pr-unreadable",
        );
        expect(executor).not.toHaveBeenCalled();
      }
    },
  );

  it("guards the thread-reply route too, not just full reviews", async () => {
    const { gate, adapter, executor } = harness();
    adapter.pr = { ...adapter.pr, merged: true, state: "closed" };

    const result = await gate.execute({
      kind: "create_review_comment_reply",
      method: "POST",
      path: "/repos/o/r/pulls/5180/comments/42/replies",
      body: { body: "thanks" },
      note: "reply in thread 42 on #5180",
      pr: 5180,
    });

    expect(result.blocked).toBe("pr-merged");
    expect(executor).not.toHaveBeenCalled();
  });

  it("re-reads the PR for every posting mutation (no cached liveness)", async () => {
    const { gate, adapter } = harness();
    await gate.execute(reviewIntent("REQUEST_CHANGES", HEAD));
    adapter.pr = { ...adapter.pr, head_sha: "cafebabe" };
    await gate.execute(reviewIntent("REQUEST_CHANGES", "cafebabe"));
    expect(adapter.getPrCalls).toBe(2);
  });

  it("leaves non-posting mutations alone — label cleanup on a merged PR still runs", async () => {
    const { gate, adapter, executor } = harness();
    adapter.pr = { ...adapter.pr, merged: true, state: "closed" };

    const result = await gate.execute({
      kind: "remove_label",
      method: "DELETE",
      path: "/repos/o/r/issues/5180/labels/x",
      note: "remove label",
      pr: 5180,
    });

    expect(result.executed).toBe(true);
    expect(executor).toHaveBeenCalledTimes(1);
  });
});

// ---- guard 2, daemon half: the tick itself is a no-op ----------------------

class DispatchFake implements DispatchAdapter {
  calls: Array<{ fn: string; pr: number; arg?: string }> = [];
  async getPr(n: number): Promise<{ base_ref: string }> {
    this.calls.push({ fn: "getPr", pr: n });
    return { base_ref: "master" };
  }
  async listPrFiles(n: number): Promise<PrFileEntry[]> {
    this.calls.push({ fn: "listPrFiles", pr: n });
    return [{ filename: "app/x.py", additions: 1, deletions: 0, status: "modified" }];
  }
  async addLabel(n: number, label: string): Promise<GateResult> {
    this.calls.push({ fn: "addLabel", pr: n, arg: label });
    return { executed: true };
  }
  async removeLabel(n: number, label: string): Promise<GateResult> {
    this.calls.push({ fn: "removeLabel", pr: n, arg: label });
    return { executed: true };
  }
  async deleteTeamReviewRequest(n: number): Promise<GateResult> {
    this.calls.push({ fn: "deleteTeamReviewRequest", pr: n });
    return { executed: true };
  }
  async createReview(n: number, payload: { event: string }): Promise<GateResult> {
    this.calls.push({ fn: "createReview", pr: n, arg: payload.event });
    return { executed: true };
  }
}

function queued(pr: number, head: string): void {
  store.upsertPr({
    number: pr,
    state: "queued",
    head_sha: head,
    title: `PR ${pr}`,
    author: "alice",
    trigger_ts: "2026-08-18T10:00:00Z",
    stale_recheck: 0,
    migration_gate: 0,
  });
}

function hooks(): { hooks: SessionHooks; orders: RoundOrder[] } {
  const orders: RoundOrder[] = [];
  return {
    orders,
    hooks: {
      async dispatchRound(order) {
        orders.push(order);
      },
      async inject() {},
      async injectOverseer() {},
      async archiveAndClose() {},
    },
  };
}

describe("dispatch — a tick with no new evidence starts no round", () => {
  it(
    "consumes the triggers, restores the standing verdict, runs nothing",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queued(5180, HEAD);
      store.recordReviewedHead(5180, { head_sha: HEAD, verdict: "REQUEST_CHANGES", round_no: 1 });
      const adapter = new DispatchFake();
      const h = hooks();

      const orders = await dispatchOnce({ cfg, store, adapter, hooks: h.hooks });

      expect(orders).toEqual([]);
      expect(h.orders).toEqual([]);
      expect(store.roundsFor(5180)).toEqual([]);
      expect(store.getPr(5180)?.state).toBe("awaiting_author");
      const fns = adapter.calls.map((c) => `${c.fn}:${c.arg ?? ""}`);
      expect(fns).toContain(`removeLabel:${cfg.github.trigger_label}`);
      expect(fns).toContain("deleteTeamReviewRequest:");
      // the PR is not painted "in progress" — no round is in progress
      expect(fns).not.toContain(`addLabel:${cfg.github.in_progress_label}`);
      expect(
        store.db
          .prepare("SELECT COUNT(*) AS c FROM events WHERE kind = 'round_skipped_no_new_evidence'")
          .get(),
      ).toEqual({ c: 1 });
    },
  );

  it("dispatches normally once the head moves", { timeout: HEAVY_TIMEOUT_MS }, async () => {
    queued(5180, "cafebabe");
    store.recordReviewedHead(5180, { head_sha: HEAD, verdict: "REQUEST_CHANGES" });
    const h = hooks();

    const orders = await dispatchOnce({ cfg, store, adapter: new DispatchFake(), hooks: h.hooks });

    expect(orders).toHaveLength(1);
  });

  // ----: the mark is read through the ONE standing-review interpretation

  const skipEvent = (pr: number): Record<string, unknown> => {
    const rows = store.db
      .prepare("SELECT payload FROM events WHERE kind = 'round_skipped_no_new_evidence' AND pr = ?")
      .all(pr) as Array<{ payload: string }>;
    expect(rows).toHaveLength(1);
    return JSON.parse(rows[0]!.payload) as Record<string, unknown>;
  };

  it(
    "the #5409 partial mark — posted REQUEST_CHANGES, verdict null — is a standing REQUEST_CHANGES and starts no round",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queued(5409, HEAD);
      // Exactly the row the shell route leaves before the watcher enriches it.
      store.recordReviewedHead(5409, { head_sha: HEAD, posted_event: "REQUEST_CHANGES" });
      expect(store.reviewedHead(5409)).toMatchObject({
        verdict: null,
        posted_event: "REQUEST_CHANGES",
        round_no: null,
      });
      const adapter = new DispatchFake();
      const h = hooks();

      const orders = await dispatchOnce({ cfg, store, adapter, hooks: h.hooks });

      expect(orders).toEqual([]);
      expect(h.orders).toEqual([]);
      expect(store.roundsFor(5409)).toEqual([]);
      expect(store.getPr(5409)?.state).toBe("awaiting_author");
      const fns = adapter.calls.map((c) => `${c.fn}:${c.arg ?? ""}`);
      expect(fns).toContain(`removeLabel:${cfg.github.trigger_label}`);
      expect(fns).toContain("deleteTeamReviewRequest:");
      expect(fns).not.toContain(`addLabel:${cfg.github.in_progress_label}`);
      expect(skipEvent(5409)).toMatchObject({
        stage: "dispatch",
        head_sha: HEAD,
        standing_verdict: "REQUEST_CHANGES",
        standing_source: "posted_event",
        mark: { head_sha: HEAD, verdict: null, posted_event: "REQUEST_CHANGES", round_no: null },
      });
      // The mark itself is untouched: nothing was reviewed, nothing is re-stamped.
      expect(store.reviewedHead(5409)).toMatchObject({
        verdict: null,
        posted_event: "REQUEST_CHANGES",
        round_no: null,
      });
    },
  );

  it(
    "the exact #5409 reproduction — a fresh human review_requested on the partial mark — consumes the trigger and runs nothing",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      // The PR sits awaiting_author on a review posted by round 12; the mark
      // never got its verdict. Then GitHub delivers pull_request.review_requested.
      store.upsertPr({
        number: 5409,
        state: "awaiting_author",
        head_sha: HEAD,
        title: "PR 5409",
        author: "alice",
        trigger_ts: null,
        stale_recheck: 0,
        migration_gate: 0,
      });
      store.recordReviewedHead(5409, { head_sha: HEAD, posted_event: "REQUEST_CHANGES" });
      const requestedAt = new Date("2026-09-01T19:05:12.664Z");
      applyEvent(
        store,
        5409,
        { type: "trigger", source: "team_request" },
        { head_sha: HEAD },
        { botLogin: cfg.github.bot_login, now: () => requestedAt },
      );
      expect(store.getPr(5409)).toMatchObject({
        state: "queued",
        trigger_provenance: "human",
        trigger_ts: requestedAt.toISOString(),
      });
      const adapter = new DispatchFake();
      const h = hooks();

      const orders = await dispatchOnce({ cfg, store, adapter, hooks: h.hooks });

      // No round, no order (so no session command, no worktree, no pi), no spend.
      expect(orders).toEqual([]);
      expect(h.orders).toEqual([]);
      expect(store.roundsFor(5409)).toEqual([]);
      const fns = adapter.calls.map((c) => `${c.fn}:${c.arg ?? ""}`);
      expect(fns).not.toContain(`addLabel:${cfg.github.in_progress_label}`);
      expect(fns).toContain("deleteTeamReviewRequest:");
      // Human provenance is a scheduling signal, not evidence: guard 2's rule
      // decides, and the PR goes back to the state its standing review put it in.
      expect(store.getPr(5409)).toMatchObject({
        state: "awaiting_author",
        trigger_ts: null,
        trigger_provenance: null,
      });
      // The decision event captured the provenance BEFORE the transition cleared it.
      expect(skipEvent(5409)).toMatchObject({
        stage: "dispatch",
        trigger_provenance: "human",
        trigger_ts: requestedAt.toISOString(),
        standing_verdict: "REQUEST_CHANGES",
        standing_source: "posted_event",
      });
    },
  );

  it(
    "the symmetric partial APPROVE mark is a standing approval and restores tracked",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queued(5180, HEAD);
      store.recordReviewedHead(5180, { head_sha: HEAD, posted_event: "APPROVE" });
      const h = hooks();

      expect(
        await dispatchOnce({ cfg, store, adapter: new DispatchFake(), hooks: h.hooks }),
      ).toEqual([]);

      expect(h.orders).toEqual([]);
      expect(store.getPr(5180)?.state).toBe("tracked");
      expect(skipEvent(5180)).toMatchObject({
        standing_verdict: "APPROVE",
        standing_source: "posted_event",
      });
    },
  );

  it(
    "a null-verdict COMMENT mark is never guessed — no round (guard 2 would refuse it), no verdict, tracked with an anomaly",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queued(5180, HEAD);
      store.recordReviewedHead(5180, { head_sha: HEAD, posted_event: "COMMENT" });
      const adapter = new DispatchFake();
      const h = hooks();

      expect(await dispatchOnce({ cfg, store, adapter, hooks: h.hooks })).toEqual([]);

      expect(h.orders).toEqual([]);
      expect(store.roundsFor(5180)).toEqual([]);
      expect(store.getPr(5180)?.state).toBe("tracked");
      expect(adapter.calls.map((c) => `${c.fn}:${c.arg ?? ""}`)).not.toContain(
        `addLabel:${cfg.github.in_progress_label}`,
      );
      expect(skipEvent(5180)).toMatchObject({
        standing_verdict: null,
        standing_source: null,
        mark: { posted_event: "COMMENT", verdict: null },
      });
      expect(store.anomalies().map((a) => a.kind)).toContain("standing_review_unknown");
      expect(store.reviewedHead(5180)).toMatchObject({ verdict: null, posted_event: "COMMENT" });
    },
  );

  it(
    "a withheld approval at the same head is still its own new evidence, partial mark or not",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queued(5180, HEAD);
      store.recordReviewedHead(5180, { head_sha: HEAD, posted_event: "COMMENT" });
      store.recordApprovalWithheld(5180, { head_sha: HEAD, ci_state: "red", reason: "red-ci" });
      const h = hooks();

      expect(
        await dispatchOnce({ cfg, store, adapter: new DispatchFake(), hooks: h.hooks }),
      ).toHaveLength(1);
      expect(h.orders).toHaveLength(1);
    },
  );

  it(
    "an undecided legacy NEEDS_HUMAN mark beside a posted REQUEST_CHANGES still gets its round",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queued(5180, HEAD);
      store.recordReviewedHead(5180, {
        head_sha: HEAD,
        verdict: "NEEDS_HUMAN",
        posted_event: "REQUEST_CHANGES",
        round_no: 1,
      });
      const h = hooks();

      expect(
        await dispatchOnce({ cfg, store, adapter: new DispatchFake(), hooks: h.hooks }),
      ).toHaveLength(1);
    },
  );

  it(
    "dispatches after an author reply on the same head",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queued(5180, HEAD);
      store.recordReviewedHead(5180, { head_sha: HEAD, verdict: "REQUEST_CHANGES" });
      store.noteAuthorReply(5180, "2099-01-01T00:00:00.000Z");
      const h = hooks();

      expect(
        await dispatchOnce({ cfg, store, adapter: new DispatchFake(), hooks: h.hooks }),
      ).toHaveLength(1);
    },
  );
});

// ---- guard 5: head drift ---------------------------------

describe("guard 5 — the head the review is about must still be the live head", () => {
  it("refuses a review whose commit_id is no longer the PR's head", async () => {
    const { gate, adapter, executor } = harness();
    adapter.pr = { ...adapter.pr, head_sha: "cafebabe" }; // pushed after validation

    const result = await gate.execute(reviewIntent("REQUEST_CHANGES", HEAD));

    expect(result.executed).toBe(false);
    expect(result.blocked).toBe("head-drift");
    expect(executor).not.toHaveBeenCalled();
    // Nothing was posted, so nothing was stamped as reviewed.
    expect(store.reviewedHead(5180)).toBeUndefined();
  });

  it("logs the refusal with both shas", async () => {
    const { gate, adapter } = harness();
    adapter.pr = { ...adapter.pr, head_sha: "cafebabe" };
    await gate.execute(reviewIntent("APPROVE", HEAD));
    const rows = store.db
      .prepare("SELECT payload FROM events WHERE kind = 'posting_guard_blocked'")
      .all() as Array<{ payload: string }>;
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.payload)).toMatchObject({
      reason: "head-drift",
      expected_head: HEAD,
      live_head: "cafebabe",
    });
  });

  it("posts when the heads match", async () => {
    const { gate } = harness();
    expect((await gate.execute(reviewIntent("REQUEST_CHANGES", HEAD))).executed).toBe(true);
  });

  it("compares shas case-insensitively — matching the guards.sh twin's ${live,,} convention", async () => {
    const { gate, adapter } = harness();
    adapter.pr = { ...adapter.pr, head_sha: HEAD.toUpperCase() }; // same sha, drifted case
    expect((await gate.execute(reviewIntent("REQUEST_CHANGES", HEAD))).executed).toBe(true);
  });

  it("does not fire when the intent carries no commit_id — no expectation, no refusal", async () => {
    const { gate, adapter } = harness();
    adapter.pr = { ...adapter.pr, head_sha: "cafebabe" };
    const intent = reviewIntent("COMMENT");
    (intent.body as { commit_id?: string }).commit_id = undefined;
    expect((await gate.execute(intent)).executed).toBe(true);
  });

  it("is off when [guards] refuse_on_head_drift = false", async () => {
    const { gate, adapter } = harness({ refuse_on_head_drift: false });
    adapter.pr = { ...adapter.pr, head_sha: "cafebabe" };
    expect((await gate.execute(reviewIntent("REQUEST_CHANGES", HEAD))).executed).toBe(true);
  });
});

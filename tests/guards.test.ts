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
import {
  WORLD_HEAD,
  routes,
  seedMark,
  setGuardKnobs,
  setPr,
  type Blocked,
  type Outcome,
  type PostAction,
  type Route,
} from "./helpers/guards-parity.js";
import {
  exec as rigExec,
  root as rigRoot,
  useGuardsShellRig,
  type GuardsShellRig,
} from "./helpers/guards-shell-rig.js";
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

  // MUTATION: drop the APPROVE exemption — the CI-green retry of a withheld
  // approval, delivered by the daemon, is refused as no-new-evidence.
  it("never gates an APPROVE, exactly as approve-pr.sh: the withheld approval's retry posts at its stamped head", async () => {
    const { gate, executor } = harness();
    // The withheld round's COMMENT stamped this head.
    await gate.execute(reviewIntent("COMMENT"));
    expect(store.reviewedHead(5180)).toMatchObject({ head_sha: HEAD, posted_event: "COMMENT" });
    executor.mockClear();

    const key = `v1:5180:2:${HEAD}`;
    const result = await gate.execute({
      ...reviewIntent("APPROVE", HEAD, `Approved\n\n<!-- qcr-post:${key} -->`),
      postingRetry: key,
    });

    expect(result.executed).toBe(true);
    expect(executor).toHaveBeenCalledTimes(1);
    // A second REQUEST_CHANGES at the head is still refused.
    expect((await gate.execute(reviewIntent("REQUEST_CHANGES"))).blocked).toBe("no-new-evidence");
  });

  // The deferred retry's softening is the designed path (verdicts.ts
  // `retrySoftenedApproval`): CI went red again since the head was stamped,
  // so the retry posts the withheld COMMENT that says so and re-records the
  // withheld mark — CI going green retries again. Refusing it instead would
  // exhaust the deferred job and fail the round loud.
  it("a deferred APPROVE red CI softens at a stamped head posts its withheld COMMENT and keeps the retry promise", async () => {
    const { gate, adapter, executor } = harness();
    await gate.execute(reviewIntent("COMMENT"));
    executor.mockClear();
    (adapter as FakeGuardAdapter & { listChecks: GuardAdapter["listChecks"] }).listChecks =
      async () => [{ name: "ci", source: "check_run", status: "completed", conclusion: "failure" }];

    const key = `v1:5180:2:${HEAD}`;
    const result = await gate.execute({
      ...reviewIntent("APPROVE", HEAD, `Approved\n\n<!-- qcr-post:${key} -->`),
      postingRetry: key,
    });

    expect(result.executed).toBe(true);
    const sent = executor.mock.calls[0]![0] as MutationIntent;
    expect((sent.body as { event: string }).event).toBe("COMMENT");
    expect(store.approvalWithheld(5180)).toMatchObject({ head_sha: HEAD, ci_state: "red" });
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

  // ---- the mark is read through the one standing-review interpretation

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

// ---- guard 5: head drift ---------------------------------------------------

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

// ---- the deferred-delivery intent (postingRetry) ----------------------------

describe("postingRetry — a deferred session review delivered at its original head", () => {
  const key = `v1:5180:3:${HEAD}`;
  const retry = (over: Partial<MutationIntent> = {}, body?: string): MutationIntent => ({
    ...reviewIntent("REQUEST_CHANGES", HEAD, body ?? `Review\n\n<!-- qcr-post:${key} -->`),
    postingRetry: key,
    ...over,
  });

  it("posts at the original commit_id after a push — guard 5 alone is exempt", async () => {
    const { gate, adapter, executor } = harness();
    adapter.pr = { ...adapter.pr, head_sha: "cafebabe" };
    const result = await gate.execute(retry());
    expect(result.executed).toBe(true);
    expect(executor).toHaveBeenCalledTimes(1);
    // The same review without the key is refused, as ever.
    expect((await gate.execute(reviewIntent("REQUEST_CHANGES", HEAD))).blocked).toBe("head-drift");
  });

  it("every other guard still binds: merged/closed refuses it", async () => {
    const { gate, adapter, executor } = harness();
    adapter.pr = { ...adapter.pr, merged: true };
    expect((await gate.execute(retry())).blocked).toBe("pr-merged");
    expect(executor).not.toHaveBeenCalled();
  });

  it("a human approval at the head softens it to COMMENT, as on any review", async () => {
    const { gate, adapter, executor } = harness();
    adapter.reviews = [{ id: 1, user: "carol", state: "APPROVED", commit_id: HEAD }];
    expect((await gate.execute(retry())).executed).toBe(true);
    const sent = executor.mock.calls[0]![0] as MutationIntent;
    expect((sent.body as { event: string }).event).toBe("COMMENT");
  });

  it("dry-run suppresses it like anything else", async () => {
    const { gate, executor } = harness({}, true);
    const result = await gate.execute(retry());
    expect(result.executed).toBe(false);
    expect(result.dryRunFile).toBeTruthy();
    expect(executor).not.toHaveBeenCalled();
  });

  it.each([
    ["a body without the key's marker", retry({}, "Review without a marker")],
    ["a key naming another head", retry({ postingRetry: `v1:5180:3:${OLD}` })],
    ["a mechanical purpose", { ...retry(), reviewPurpose: "escalation" as const }],
    ["another kind", { ...retry(), kind: "create_issue_comment" as const }],
  ])("admission refuses %s", async (_label, intent) => {
    const { gate, executor } = harness();
    await expect(gate.execute(intent)).rejects.toThrow(/postingRetry|reviewPurpose/);
    expect(executor).not.toHaveBeenCalled();
  });
});

// ---- parity: the shell route and this gate answer the same cases ------------
//
// The sessions post through scripts/post-review.sh, approve-pr.sh and
// reply-thread.sh (scripts/guards.sh), the daemon through the gate above.
// Until the shell guards are deleted (P9.3) the shell stays the reference the
// Node guards must match, so every case here runs on BOTH routes against ONE
// world — the shell rig's loopback GitHub stub, state.db and config.toml, read
// by the real scripts on one side and by the real GitHubAdapter plus
// makePostingGuard on the other (tests/helpers/guards-parity.ts). Asserting
// each side in its own file would let them drift; here a case that one route
// answers differently fails by name, unless the case says so itself, in a
// `shell`/`node` override with the reason beside it.
//
// This block is the port of tests/guards-shell-*.test.ts, file by file:
//   guards-shell-post       guard 1 and guard 2 on post-review.sh        ported
//   guards-shell-parity     the guard-2 table and the reviewed-head stamp ported
//   guards-shell-closed     guard 3 on all three scripts                  ported
//   guards-shell-drift      guard 5 (the message wording stays shell-only) ported
//   guards-shell-cigate     guard 4 (the receipt withdrawal stays shell-only) ported
//   guards-shell-receipts, -noop, -deferred
//       the shell's posting-receipt.py / outbox / deferred-handoff plumbing,
//       its comments-file validation and its error wording. The Node route
//       has no counterpart to compare (the daemon's outbox is tested in
//       posting-outbox*.test.ts); P9.3 replaces them with the Node client's
//       own tests.
// The guards-shell files stay as they are until P9.3 deletes the scripts.

const RIG_MOVED = "5b71a80ffee0987654321fedcba09876543210ab";

interface Want {
  /** The review event sent, "REPLY" for a thread reply, null for nothing. */
  sent: string | null;
  blocked?: Blocked;
  bodyHas?: string[];
  bodyLacks?: string[];
  noteHas?: string;
  commitId?: string;
}

interface ParityCase {
  what: string;
  action: PostAction;
  /** The sha the session names as the head it reviewed; null = none named. */
  expectedHead?: string | null;
  world?: (s: GuardsShellRig) => void;
  want: Want;
  /** A route-specific answer, with the reason the routes differ. */
  shell?: Partial<Want>;
  node?: Partial<Want>;
  why?: string;
}

const RC: PostAction = { kind: "review", event: "REQUEST_CHANGES" };
const COMMENT: PostAction = { kind: "review", event: "COMMENT" };
const APPROVE: PostAction = { kind: "approve" };
const REPLY: PostAction = { kind: "reply" };

const rv = (user: string, state: string, commit_id = WORLD_HEAD, id = 1) => ({
  id,
  user: { login: user },
  state,
  commit_id,
});
const run1 = (name: string, conclusion: string, status = "completed", started_at?: string) => ({
  name,
  status,
  conclusion: conclusion === "" ? null : conclusion,
  ...(started_at !== undefined ? { started_at } : {}),
});

const guard1: ParityCase[] = [
  {
    what: "a human approval at the head softens REQUEST_CHANGES to COMMENT, findings intact",
    action: RC,
    world: (s) => (s.reviews = [rv("mhale", "APPROVED")]),
    want: {
      sent: "COMMENT",
      bodyHas: ["Automated review body.", "@mhale"],
      commitId: WORLD_HEAD,
      noteHas: "downgraded",
    },
  },
  {
    what: "an approval of an older head leaves REQUEST_CHANGES alone",
    action: RC,
    world: (s) => (s.reviews = [rv("mhale", "APPROVED", "0ldhead")]),
    want: { sent: "REQUEST_CHANGES" },
  },
  {
    what: "the bot's own approval and the PR author's are ignored",
    action: RC,
    world: (s) =>
      (s.reviews = [
        rv("example-review[bot]", "APPROVED", WORLD_HEAD, 1),
        rv("pr-author", "APPROVED", WORLD_HEAD, 2),
      ]),
    want: { sent: "REQUEST_CHANGES" },
  },
  {
    what: "any other [bot] identity's approval is ignored",
    action: RC,
    world: (s) => (s.reviews = [rv("dependabot[bot]", "APPROVED")]),
    want: { sent: "REQUEST_CHANGES" },
  },
  {
    what: "an approval the same human has since retired is ignored",
    action: RC,
    world: (s) =>
      (s.reviews = [
        rv("mhale", "APPROVED", WORLD_HEAD, 1),
        rv("mhale", "CHANGES_REQUESTED", WORLD_HEAD, 2),
      ]),
    want: { sent: "REQUEST_CHANGES" },
  },
  {
    what: "a later plain comment from the approver does not retire the approval",
    action: RC,
    world: (s) =>
      (s.reviews = [
        rv("mhale", "APPROVED", WORLD_HEAD, 1),
        rv("mhale", "COMMENTED", WORLD_HEAD, 2),
      ]),
    want: { sent: "COMMENT", bodyHas: ["@mhale"] },
  },
  {
    what: "sees a human approval past the first 100 reviews (selfscan 91382fae)",
    action: RC,
    world: (s) =>
      (s.reviews = [
        ...Array.from({ length: 120 }, (_, i) =>
          rv("example-review[bot]", "COMMENTED", "0ldhead", i + 1),
        ),
        rv("mhale", "APPROVED", WORLD_HEAD, 500),
      ]),
    want: { sent: "COMMENT", bodyHas: ["@mhale"] },
  },
  {
    what: "reads every page, with no page bound: the approval is on page 31",
    action: RC,
    world: (s) =>
      (s.reviews = [
        ...Array.from({ length: 3050 }, (_, i) =>
          rv("example-review[bot]", "COMMENTED", "0ldhead", i + 1),
        ),
        rv("mhale", "APPROVED", WORLD_HEAD, 5000),
      ]),
    want: { sent: "COMMENT", bodyHas: ["@mhale"] },
  },
  {
    what: "a COMMENT is never touched by a human approval",
    action: COMMENT,
    world: (s) => (s.reviews = [rv("mhale", "APPROVED")]),
    want: { sent: "COMMENT", bodyLacks: ["@mhale"] },
  },
  {
    what: "an APPROVE is never softened for a human approval",
    action: APPROVE,
    world: (s) => (s.reviews = [rv("mhale", "APPROVED")]),
    want: { sent: "APPROVE" },
  },
  {
    what: "downgrade_on_human_approval = false leaves REQUEST_CHANGES alone",
    action: RC,
    world: (s) => {
      s.reviews = [rv("mhale", "APPROVED")];
      setGuardKnobs(s, { downgrade_on_human_approval: false });
    },
    want: { sent: "REQUEST_CHANGES" },
  },
];

// The guard-2 table the shell's parity file pinned against hasNewEvidence,
// now answered by both posting routes.
const guard2Marks: Array<[string, Parameters<typeof seedMark>[1] | null, boolean]> = [
  [
    "same head, decided, no author reply",
    { head_sha: WORLD_HEAD, verdict: "REQUEST_CHANGES" },
    false,
  ],
  ["same head, APPROVE, no author reply", { head_sha: WORLD_HEAD, verdict: "APPROVE" }, false],
  [
    "same head, NEEDS_HUMAN — undecided is not reviewed",
    { head_sha: WORLD_HEAD, verdict: "NEEDS_HUMAN" },
    true,
  ],
  ["same head, legacy ESCALATE spelling", { head_sha: WORLD_HEAD, verdict: "ESCALATE" }, true],
  ["same head, undecided in lower case", { head_sha: WORLD_HEAD, verdict: "needs_human" }, true],
  ["a different head", { head_sha: "an0therhead", verdict: "REQUEST_CHANGES" }, true],
  [
    "same head with an author reply since",
    { head_sha: WORLD_HEAD, verdict: "REQUEST_CHANGES", reply_at: "2099-01-01T00:00:00.000Z" },
    true,
  ],
  ["same head, verdict column null (a legacy row)", { head_sha: WORLD_HEAD, verdict: null }, false],
  ["no mark at all", null, true],
];

const guard2: ParityCase[] = [
  ...guard2Marks.map(([what, mark, newEvidence]): ParityCase => ({
    what: `${what} → ${newEvidence ? "posts" : "refused"}`,
    action: COMMENT,
    world: (s) => mark && seedMark(s, mark),
    want: newEvidence ? { sent: "COMMENT" } : { sent: null, blocked: "no-new-evidence" },
  })),
  {
    what: "a REQUEST_CHANGES at an already-reviewed head is refused too",
    action: RC,
    world: (s) => seedMark(s, { head_sha: WORLD_HEAD, verdict: "REQUEST_CHANGES" }),
    want: { sent: null, blocked: "no-new-evidence" },
  },
  {
    what: "an APPROVE is never gated by guard 2 (the CI-green retry of a withheld approval)",
    action: APPROVE,
    world: (s) => seedMark(s, { head_sha: WORLD_HEAD, verdict: "REQUEST_CHANGES" }),
    want: { sent: "APPROVE" },
  },
  {
    what: "a thread reply is not a review of the head, so guard 2 has nothing to say",
    action: REPLY,
    world: (s) => seedMark(s, { head_sha: WORLD_HEAD, verdict: "REQUEST_CHANGES" }),
    want: { sent: "REPLY" },
  },
  {
    what: "skip_unchanged_head = false posts a second review of the same head",
    action: COMMENT,
    world: (s) => {
      seedMark(s, { head_sha: WORLD_HEAD, verdict: "REQUEST_CHANGES" });
      setGuardKnobs(s, { skip_unchanged_head: false });
    },
    want: { sent: "COMMENT" },
  },
];

const guard3: ParityCase[] = [
  ...(
    [
      ["post-review.sh / create_review", RC],
      ["approve-pr.sh / APPROVE", APPROVE],
      ["reply-thread.sh / thread reply", REPLY],
    ] as const
  ).flatMap(([route, action]): ParityCase[] => [
    {
      what: `${route} refuses a merged PR`,
      action,
      world: (s) => setPr(s, { state: "closed", merged: true }),
      want: { sent: null, blocked: "pr-merged" },
    },
    {
      what: `${route} refuses a closed PR`,
      action,
      world: (s) => setPr(s, { state: "closed", merged: false }),
      want: { sent: null, blocked: "pr-closed" },
    },
    {
      what: `${route} posts on an open PR`,
      action,
      want: {
        sent:
          action.kind === "reply"
            ? "REPLY"
            : action.kind === "approve"
              ? "APPROVE"
              : "REQUEST_CHANGES",
      },
    },
  ]),
  {
    what: "a PR whose state cannot be read",
    action: COMMENT,
    world: (s) => (s.pr = null), // the stub 404s
    want: { sent: null, blocked: "pr-unreadable" },
    shell: { sent: "COMMENT", blocked: undefined },
    why:
      "the gate fails closed in dry-run too; the script only fails closed in live mode and " +
      "continues in dry-run, where nothing is sent anyway",
  },
  {
    what: "recheck_pr_state_before_post = false posts onto a merged PR",
    action: COMMENT,
    world: (s) => {
      setPr(s, { state: "closed", merged: true });
      setGuardKnobs(s, { recheck_pr_state_before_post: false });
    },
    want: { sent: "COMMENT" },
  },
];

const guard5: ParityCase[] = [
  {
    what: "post-review posts when the expectation matches the live head",
    action: COMMENT,
    want: { sent: "COMMENT", commitId: WORLD_HEAD },
  },
  {
    what: "post-review refuses when the PR advanced past the reviewed head",
    action: RC,
    world: (s) => setPr(s, { head: { sha: RIG_MOVED } }),
    want: { sent: null, blocked: "head-drift" },
  },
  {
    what: "approve-pr refuses a moved head",
    action: APPROVE,
    world: (s) => setPr(s, { head: { sha: RIG_MOVED } }),
    want: { sent: null, blocked: "head-drift" },
  },
  {
    what: "approve-pr approves when the expectation matches",
    action: APPROVE,
    want: { sent: "APPROVE" },
  },
  {
    what: "no expectation named (an older prompt): proceeds, never wedges",
    action: COMMENT,
    expectedHead: null,
    want: { sent: "COMMENT" },
  },
  {
    what: "a case-only sha difference is not drift",
    action: COMMENT,
    expectedHead: WORLD_HEAD.toUpperCase(),
    want: { sent: "COMMENT" },
  },
  {
    what: "refuse_on_head_drift = false posts onto a moved head",
    action: COMMENT,
    world: (s) => {
      setPr(s, { head: { sha: RIG_MOVED } });
      setGuardKnobs(s, { refuse_on_head_drift: false });
    },
    want: { sent: "COMMENT" },
  },
  {
    what: "a thread reply is not a review of a head, so guard 5 has nothing to say",
    action: REPLY,
    world: (s) => setPr(s, { head: { sha: RIG_MOVED } }),
    want: { sent: "REPLY" },
  },
  {
    what: "recheck_pr_state_before_post = false on a moved head",
    action: COMMENT,
    world: (s) => {
      setPr(s, { head: { sha: RIG_MOVED } });
      setGuardKnobs(s, { recheck_pr_state_before_post: false });
    },
    want: { sent: null, blocked: "head-drift" },
    node: { sent: "COMMENT", blocked: undefined },
    why:
      "the script still reads the PR with guard 3 switched off and keeps checking the head; " +
      "the gate makes no read then, so guard 5 has no live head to compare with. The Node " +
      "answer is the owner-ruled behaviour (2026-10-19): the route keeps posting, and the " +
      "shell refusal is not carried over",
  },
];

// A failing check refuses the approval on the shell route and softens it to a
// COMMENT on the gate; the shell case follows the refusal with the COMMENT the
// round template prescribes (guards-parity.ts), so both end with the review
// posted as a COMMENT and no APPROVE sent.
const WITHHELD: Want = { sent: "COMMENT" };
const guard4: ParityCase[] = [
  {
    what: "a green suite lets the approval through",
    action: APPROVE,
    want: { sent: "APPROVE" },
  },
  {
    what: "a failing check withholds the approval",
    action: APPROVE,
    world: (s) => (s.checkRuns = [run1("unit", "success"), run1("e2e", "failure")]),
    want: WITHHELD,
    node: { bodyHas: ["Approval is withheld"] },
  },
  {
    what: "an infra cancellation is red too, with no special-casing",
    action: APPROVE,
    world: (s) => (s.checkRuns = [run1("unit", "cancelled")]),
    want: WITHHELD,
  },
  {
    what: "a check still running withholds the approval",
    action: APPROVE,
    world: (s) => (s.checkRuns = [run1("unit", "", "in_progress")]),
    want: WITHHELD,
  },
  {
    what: "a cancelled husk is ignored when a newer run of the same name succeeded",
    action: APPROVE,
    world: (s) =>
      (s.checkRuns = [
        run1("sync", "cancelled", "completed", "2026-08-19T08:00:00Z"),
        run1("sync", "cancelled", "completed", "2026-08-19T08:05:00Z"),
        run1("sync", "success", "completed", "2026-08-19T08:10:00Z"),
      ]),
    want: { sent: "APPROVE" },
  },
  {
    what: "the LATEST run of a name being cancelled still withholds",
    action: APPROVE,
    world: (s) =>
      (s.checkRuns = [
        run1("sync", "success", "completed", "2026-08-19T08:00:00Z"),
        run1("sync", "cancelled", "completed", "2026-08-19T08:10:00Z"),
      ]),
    want: WITHHELD,
  },
  ...(["failure", "error", "pending"] as const).map((state): ParityCase => ({
    what: `a ${state} commit status sharing a passing check-run's name withholds`,
    action: APPROVE,
    world: (s) => {
      s.checkRuns = [run1("ci", "success", "completed", "2026-09-01T10:00:00Z")];
      s.statuses = [{ context: "ci", state }];
    },
    want: WITHHELD,
  })),
  {
    what: "a queued run with a null started_at is pending, not green off the older run of its name",
    action: APPROVE,
    world: (s) =>
      (s.checkRuns = [
        run1("ci", "success", "completed", "2026-09-01T10:00:00Z"),
        run1("ci", "", "queued"),
      ]),
    want: WITHHELD,
  },
  ...(
    [
      ["queued", ""],
      ["completed", "failure"],
    ] as const
  ).map(([status, conclusion]): ParityCase => ({
    what: `an untimestamped ${status}/${conclusion || "none"} run is not masked by a passing status of its name`,
    action: APPROVE,
    world: (s) => {
      s.checkRuns = [run1("ci", conclusion, status)];
      s.statuses = [{ context: "ci", state: "success" }];
    },
    want: WITHHELD,
  })),
  {
    what: "a passing status beside a passing run of its name still approves",
    action: APPROVE,
    world: (s) => {
      s.checkRuns = [run1("ci", "success", "completed", "2026-09-01T10:00:00Z")];
      s.statuses = [{ context: "ci", state: "success" }];
    },
    want: { sent: "APPROVE" },
  },
  {
    what: "no_checks_is_red withholds an approval at a zero-checks head",
    action: APPROVE,
    world: (s) => {
      s.checkRuns = [];
      setGuardKnobs(s, { no_checks_is_red: true });
    },
    want: WITHHELD,
  },
  {
    what: "a zero-checks head approves while no_checks_is_red is off",
    action: APPROVE,
    world: (s) => (s.checkRuns = []),
    want: { sent: "APPROVE" },
  },
  {
    what: "block_approve_on_red_ci = false approves over red CI",
    action: APPROVE,
    world: (s) => {
      s.checkRuns = [run1("unit", "failure")];
      setGuardKnobs(s, { block_approve_on_red_ci: false });
    },
    want: { sent: "APPROVE" },
  },
  {
    what: "the withheld review posts as a COMMENT, which red CI never refuses",
    action: COMMENT,
    world: (s) => (s.checkRuns = [run1("unit", "failure")]),
    want: { sent: "COMMENT" },
  },
  {
    what: "a REQUEST_CHANGES is not a CI matter",
    action: RC,
    world: (s) => (s.checkRuns = [run1("unit", "failure")]),
    want: { sent: "REQUEST_CHANGES" },
  },
];

function expectOutcome(route: Route, got: Outcome, c: ParityCase): void {
  const want: Want = { ...c.want, ...(c[route.name] ?? {}) };
  const at = `${route.name} route`;
  expect(got.sent, `${at}: the event sent`).toBe(want.sent);
  expect(got.blocked, `${at}: the guard that refused`).toBe(want.blocked ?? null);
  for (const t of want.bodyHas ?? []) expect(got.body, `${at}: body`).toContain(t);
  for (const t of want.bodyLacks ?? []) expect(got.body, `${at}: body`).not.toContain(t);
  if (want.noteHas) expect(got.note, `${at}: note`).toContain(want.noteHas);
  if (want.commitId) expect(got.commitId, `${at}: commit_id`).toBe(want.commitId);
}

describe("parity — scripts/guards.sh and src/guards.ts answer the same cases", () => {
  const rig = useGuardsShellRig();

  const groups: Array<[string, ParityCase[]]> = [
    ["guard 1 (a human approval at this head)", guard1],
    ["guard 2 (no new evidence)", guard2],
    ["guard 3 (merged or closed)", guard3],
    ["guard 4 (red CI withholds an approval)", guard4],
    ["guard 5 (the head moved)", guard5],
  ];
  for (const [title, cases] of groups) {
    describe(title, () => {
      for (const c of cases) {
        it(c.what, async () => {
          const s = rig;
          setPr(s);
          c.world?.(s);
          const opts = c.expectedHead === undefined ? {} : { expectedHead: c.expectedHead };
          const outcomes: Outcome[] = [];
          for (const route of routes(s)) {
            const got = await route.post(c.action, opts);
            expectOutcome(route, got, c);
            outcomes.push(got);
          }
          // Where the case names no difference, the routes agree outright.
          if (!c.shell && !c.node) {
            const [shell, node] = outcomes as [Outcome, Outcome];
            expect({ sent: node.sent, blocked: node.blocked }).toEqual({
              sent: shell.sent,
              blocked: shell.blocked,
            });
          }
        });
      }
    });
  }

  describe("the reviewed-head stamp", () => {
    // The gate's after-step stamps the mark on its own route; the shell stamps it
    // itself, for the posting scripts. Same starting row, same posted review,
    // same row after (reviewed_at aside, which is the stamp's own clock).
    const stamps: Array<[string, Parameters<typeof seedMark>[1], string, string]> = [
      [
        "the same head keeps the verdict and round, clears the author reply",
        {
          head_sha: WORLD_HEAD,
          verdict: "REQUEST_CHANGES",
          round_no: 2,
          reply_at: "2099-01-01T00:00:00.000Z",
        },
        WORLD_HEAD,
        "COMMENT",
      ],
      [
        "a new head replaces the row wholesale",
        { head_sha: "0ldhead", verdict: "REQUEST_CHANGES", round_no: 1 },
        WORLD_HEAD,
        "REQUEST_CHANGES",
      ],
    ];

    it.each(stamps)("%s", async (_what, seed, head, event) => {
      const shellDb = rig.dbPath;
      const nodeDb = join(rig.dir, "node-state.db");
      seedMark(rig, seed, shellDb);
      seedMark(rig, seed, nodeDb);

      const script = [
        `ROOT=${JSON.stringify(rigRoot)}`,
        "API=http://127.0.0.1:1 CONFIG=/dev/null REPO=o/r PR=5180 LIVE=1",
        'die() { echo "$*" >&2; exit 1; }',
        "cfg() { :; }",
        `. ${JSON.stringify(join(rigRoot, "scripts", "guards.sh"))}`,
        `guard_stamp_reviewed_head ${JSON.stringify(head)} ${JSON.stringify(event)}`,
      ].join("\n");
      await rigExec("bash", ["-c", script], { env: { ...process.env, QCR_STATE_DB: shellDb } });

      const nodeStore = new StateStore(nodeDb);
      await makePostingGuard({
        store: nodeStore,
        adapter: new FakeGuardAdapter(),
        botLogin: BOT,
        guards: GUARDS_DEFAULTS,
      }).after?.({ ...reviewIntent(event as "COMMENT", head), pr: 5180 }, { executed: true });

      const shellStore = new StateStore(shellDb);
      const { reviewed_at: _a, ...shellRow } = shellStore.reviewedHead(5180)!;
      const { reviewed_at: _b, ...nodeRow } = nodeStore.reviewedHead(5180)!;
      shellStore.close();
      nodeStore.close();
      expect(nodeRow).toEqual(shellRow);
      expect(nodeRow).toMatchObject({
        head_sha: head,
        posted_event: event,
        last_author_reply_at: null,
      });
    });
  });
});

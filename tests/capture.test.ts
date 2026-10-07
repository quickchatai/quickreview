// Human-comment capture (deciding).
//
// The load-bearing test in this file is "routing is unchanged": capture is a
// SIDE RECORD, and the whole decision rests on it taking nothing away from the
// author-reply path.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  captureFromEvent,
  isBotIdentity,
  isHumanCapture,
  capturedFromReview,
  capturedFromReviewComment,
} from "../src/capture.js";
import { parseConfig, type Config } from "../src/config.js";
import type { IssueCommentFull, PrRef, ReviewCommentFull, ReviewFull } from "../src/github.js";
import {
  reconcileOnce,
  type ReconcileAdapter,
  type ReconcileSearchItem,
} from "../src/reconcile.js";
import { StateStore } from "../src/state.js";
import type { SessionHooks } from "../src/types.js";
import { handleDelivery, signBody } from "../src/webhook.js";

const cfg: Config = parseConfig(
  readFileSync(resolve(process.cwd(), "tests/fixtures/config.toml"), "utf8"),
);
const BOT = cfg.github.bot_login; // the fixture bot login
const SECRET = "it's a secret to everybody";
const PR = 4242;

function trackedStore(): StateStore {
  const store = new StateStore(":memory:");
  store.upsertPr({
    number: PR,
    state: "tracked",
    head_sha: "sha4242",
    title: "Add retry to the ingest worker",
    author: "alice",
    trigger_ts: null,
    stale_recheck: 0,
    migration_gate: 0,
  });
  return store;
}

// ---- payload fixtures (shapes per findings §3.1) -----------------

const prBody = () => ({
  number: PR,
  title: "Add retry to the ingest worker",
  user: { login: "alice", type: "User" },
  head: { sha: "sha4242" },
  merged: false,
});

const reviewComment = (over: Record<string, unknown> = {}) => ({
  action: "created",
  comment: {
    id: 900001,
    in_reply_to_id: 800001,
    pull_request_review_id: 70001,
    path: "workers/ingest.py",
    line: 42,
    created_at: "2026-08-25T09:00:00Z",
    body: "This is intentional — the retry is idempotent.",
    user: { login: "alice", type: "User" },
    ...over,
  },
  pull_request: prBody(),
  sender: { login: "alice", type: "User" },
});

const issueComment = (over: Record<string, unknown> = {}) => ({
  action: "created",
  issue: { number: PR, title: "t", pull_request: { url: "https://api.github.com/x" } },
  comment: {
    id: 910001,
    created_at: "2026-08-25T09:05:00Z",
    body: "Can we hold this until the migration lands?",
    user: { login: "alex", type: "User" },
    ...over,
  },
  sender: { login: "alex", type: "User" },
});

const reviewSubmitted = (over: Record<string, unknown> = {}) => ({
  action: "submitted",
  review: {
    id: 70009,
    body: "Two things below, otherwise good.",
    state: "commented",
    submitted_at: "2026-08-25T09:10:00Z",
    user: { login: "pmercier", type: "User" },
    ...over,
  },
  pull_request: prBody(),
  sender: { login: "pmercier", type: "User" },
});

function deliver(store: StateStore, payload: unknown, event: string, guid: string) {
  const raw = Buffer.from(JSON.stringify(payload));
  return handleDelivery(
    { cfg, store, secret: SECRET, onInterpretation: () => {} },
    { signature: signBody(raw, SECRET), guid, event },
    raw,
  );
}

// ---- THE invariant: routing is unchanged ---------------------------------

describe("capture never changes routing (§1)", () => {
  // One row per existing routing case: what the interpreter decided BEFORE
  // capture existed, and what it must still decide with capture in the path.
  const cases: Array<{
    what: string;
    event: string;
    payload: unknown;
    kind: string;
    captured: boolean;
  }> = [
    {
      what: "an untagged reply in a bot thread still goes to ping-pong",
      event: "pull_request_review_comment",
      payload: reviewComment(),
      kind: "author_reply",
      captured: true,
    },
    {
      what: "a [feedback] inline comment still diverts to the feedback sink",
      event: "pull_request_review_comment",
      payload: reviewComment({ body: "[feedback] this nit was noise" }),
      kind: "feedback_comment",
      captured: true,
    },
    {
      what: "an untagged inline comment outside a bot thread is still ignored for routing",
      event: "pull_request_review_comment",
      payload: reviewComment({ in_reply_to_id: null }),
      kind: "ignored",
      captured: true,
    },
    {
      what: "an untagged top-level comment is still ignored for routing",
      event: "issue_comment",
      payload: issueComment(),
      kind: "ignored",
      captured: true,
    },
    {
      what: "a [feedback] top-level comment still diverts",
      event: "issue_comment",
      payload: issueComment({ body: "[feedback] too many nits" }),
      kind: "feedback_comment",
      captured: true,
    },
    {
      what: "a human review body without the tag is still ignored for routing",
      event: "pull_request_review",
      payload: reviewSubmitted(),
      kind: "ignored",
      captured: true,
    },
    {
      what: "a [feedback] review body still diverts",
      event: "pull_request_review",
      payload: reviewSubmitted({ body: "[feedback] wrong call on the lock" }),
      kind: "feedback_comment",
      captured: true,
    },
    {
      what: "the bot's own inline comment is still registry backfill, and is not captured",
      event: "pull_request_review_comment",
      payload: reviewComment({ user: { login: BOT, type: "Bot" } }),
      kind: "bot_comment",
      captured: false,
    },
    {
      what: "another bot's comment is still ignored, and is not captured",
      event: "pull_request_review_comment",
      payload: reviewComment({ user: { login: "dependabot[bot]", type: "Bot" } }),
      kind: "ignored",
      captured: false,
    },
  ];

  for (const c of cases) {
    it(c.what, () => {
      const store = trackedStore();
      // The bot-thread registry is what makes an untagged reply an
      // author_reply; register it so the reply cases are real.
      store.registerBotComment(800001, PR, "review_comment");
      const res = deliver(store, c.payload, c.event, `g-${c.what}`);
      expect(res.interpretation?.kind).toBe(c.kind);
      expect(store.prComments(PR).length).toBe(c.captured ? 1 : 0);
      // Capture is never a feedback signal by itself: only the tagged path
      // writes those, and it writes them through the engine, not here.
      expect(store.db.prepare("SELECT COUNT(*) c FROM feedback_signals").get()).toMatchObject({
        c: 0,
      });
      store.close();
    });
  }

  it("does not stamp the new-evidence mark or touch lifecycle", () => {
    const store = trackedStore();
    deliver(store, issueComment(), "issue_comment", "g-no-mark");
    // handleDelivery captures; nothing else. The state machine only runs from
    // applyInterpretation, which this path never reaches.
    expect(store.prComments(PR)).toHaveLength(1);
    expect(store.getPr(PR)?.state).toBe("tracked");
    expect(store.db.prepare("SELECT COUNT(*) c FROM reviewed_heads").get()).toMatchObject({ c: 0 });
    store.close();
  });
});

// ---- what lands in the record --------------------------------------------

describe("captureFromEvent", () => {
  const deps = { botLogin: BOT, isTrackedPr: () => true };

  it("records the thread, the author and the tag fact for an inline comment", () => {
    const out = captureFromEvent("pull_request_review_comment", "created", reviewComment(), deps);
    expect(out).toMatchObject({
      captured: {
        pr: PR,
        source: "review_comment",
        comment_id: 900001,
        in_reply_to_id: 800001,
        thread_id: 800001,
        review_id: 70001,
        author: "alice",
        author_type: "User",
        tagged: false,
        path: "workers/ingest.py",
        line: 42,
        created_at: "2026-08-25T09:00:00Z",
      },
    });
  });

  it("roots a thread at the comment itself when it is not a reply", () => {
    const out = captureFromEvent(
      "pull_request_review_comment",
      "created",
      reviewComment({ in_reply_to_id: null }),
      deps,
    );
    expect(out).toMatchObject({ captured: { thread_id: 900001, in_reply_to_id: null } });
  });

  it("records the [feedback] tag as a fact, without classifying", () => {
    const out = captureFromEvent(
      "pull_request_review_comment",
      "created",
      reviewComment({ body: "[feedback] noisy" }),
      deps,
    );
    expect(out).toMatchObject({ captured: { tagged: true, body: "[feedback] noisy" } });
  });

  it("skips bots, empty bodies, non-PR issues, untracked PRs and non-created actions", () => {
    expect(
      captureFromEvent(
        "pull_request_review_comment",
        "created",
        reviewComment({ user: { login: BOT, type: "Bot" } }),
        deps,
      ),
    ).toMatchObject({ skipped: "bot author" });
    expect(
      captureFromEvent(
        "pull_request_review_comment",
        "created",
        reviewComment({ body: "   " }),
        deps,
      ),
    ).toMatchObject({ skipped: "empty body" });
    expect(
      captureFromEvent("pull_request_review_comment", "deleted", reviewComment(), deps),
    ).toMatchObject({ skipped: "review-comment action: deleted" });
    expect(
      captureFromEvent("pull_request_review", "dismissed", reviewSubmitted(), deps),
    ).toMatchObject({ skipped: "review action: dismissed" });
    expect(captureFromEvent("push", null, {}, deps)).toMatchObject({
      skipped: "not a comment event: push",
    });
    expect(
      captureFromEvent(
        "issue_comment",
        "created",
        {
          action: "created",
          issue: { number: 7 },
          comment: { id: 1, body: "hi", user: { login: "a", type: "User" } },
        },
        deps,
      ),
    ).toMatchObject({ skipped: "issue comment on a non-PR issue" });
    expect(
      captureFromEvent("pull_request_review_comment", "created", reviewComment(), {
        botLogin: BOT,
        isTrackedPr: () => false,
      }),
    ).toMatchObject({ skipped: "PR not tracked" });
  });

  it("knows every shape of bot identity, the bot's own login included", () => {
    expect(isBotIdentity(BOT, "Bot", BOT)).toBe(true);
    expect(isBotIdentity(BOT, "User", BOT)).toBe(true); // login alone is enough
    expect(isBotIdentity("mergequeue[bot]", "User", BOT)).toBe(true);
    expect(isBotIdentity("alice", "User", BOT)).toBe(false);
    expect(isHumanCapture(capturedFromReviewComment(PR, rc({ user: "alice" })), BOT)).toBe(true);
    expect(
      isHumanCapture(capturedFromReviewComment(PR, rc({ user: BOT, user_type: "Bot" })), BOT),
    ).toBe(false);
  });
});

// ---- store identity -------------------------------------------------------

// the learner reads a human REQUEST_CHANGES off the captured
// review's own state — recorded as a fact, routing untouched.
describe("a captured review keeps its state (S8)", () => {
  const deps = { botLogin: BOT, isTrackedPr: () => true };
  it("the webhook and the sweep record it lowercased; a comment has none", () => {
    const hook = captureFromEvent(
      "pull_request_review",
      "submitted",
      reviewSubmitted({ state: "changes_requested" }),
      deps,
    );
    expect(hook).toMatchObject({
      captured: { source: "review", review_state: "changes_requested" },
    });
    const swept = capturedFromReview(PR, {
      id: 1,
      user: "pmercier",
      user_type: "User",
      state: "CHANGES_REQUESTED",
      body: "no",
      commit_id: "c",
      submitted_at: "2026-08-25T09:10:00Z",
    });
    expect(swept.review_state).toBe("changes_requested");
    expect(capturedFromReviewComment(PR, rc({ user: "alice" })).review_state).toBeUndefined();
  });

  it("is stored; a review captured before the column gets it once, and a recorded state is never rewritten", () => {
    const store = new StateStore(":memory:");
    store.recordPrComment({ pr: PR, source: "review", comment_id: 9, body: "old" });
    expect(store.prComments(PR)[0]!.review_state).toBeNull();
    expect(
      store.recordPrComment({
        pr: PR,
        source: "review",
        comment_id: 9,
        body: "old",
        review_state: "CHANGES_REQUESTED",
      }),
    ).toBe(false);
    expect(store.prComments(PR)[0]!.review_state).toBe("changes_requested");
    store.recordPrComment({
      pr: PR,
      source: "review",
      comment_id: 9,
      body: "old",
      review_state: "approved",
    });
    expect(store.prComments(PR)[0]!.review_state).toBe("changes_requested");
    store.close();
  });
});

describe("pr_comments identity", () => {
  it("dedupes on (source, comment_id), never on body text", () => {
    const store = new StateStore(":memory:");
    const row = { pr: PR, source: "review_comment", comment_id: 5, body: "first" };
    expect(store.recordPrComment(row)).toBe(true);
    // Same comment, edited text — still one row.
    expect(store.recordPrComment({ ...row, body: "edited" })).toBe(false);
    // Same numeric id in a different id space is a different comment.
    expect(store.recordPrComment({ ...row, source: "review" })).toBe(true);
    expect(store.prComments(PR)).toHaveLength(2);
    expect(store.hasPrComment("review_comment", 5)).toBe(true);
    expect(store.hasPrComment("issue_comment", 5)).toBe(false);
    expect(store.prComments(PR)[0]).toMatchObject({
      body: "first",
      captured_via: "webhook",
      tagged: 0,
    });
    store.close();
  });
});

// ---- the reconcile sweep --------------------------------------------------

function ref(number: number, over: Partial<PrRef> = {}): PrRef {
  return {
    number,
    title: `PR ${number}`,
    author: "alice",
    head_sha: `sha${number}`,
    base_ref: "master",
    updated_at: "2026-08-25T09:00:00Z",
    state: "open",
    draft: false,
    merged: false,
    labels: [],
    ...over,
  };
}

function rc(over: Partial<ReviewCommentFull> = {}): ReviewCommentFull {
  return {
    id: 1,
    user: "alice",
    user_type: "User",
    body: "why not a set here?",
    path: "a.py",
    line: 3,
    pull_request_review_id: 11,
    in_reply_to_id: null,
    created_at: "2026-08-25T08:00:00Z",
    ...over,
  };
}

class SweepGitHub implements ReconcileAdapter {
  open: PrRef[] = [];
  inline = new Map<number, ReviewCommentFull[]>();
  top = new Map<number, IssueCommentFull[]>();
  reviews = new Map<number, ReviewFull[]>();
  swept: number[] = [];

  async searchLabelTriggered(): Promise<ReconcileSearchItem[]> {
    return [];
  }
  async searchTeamTriggered(): Promise<ReconcileSearchItem[]> {
    return [];
  }
  async listOpenPrs() {
    return this.open;
  }
  async getPr(n: number): Promise<PrRef> {
    const found = this.open.find((p) => p.number === n);
    if (!found) throw new Error(`no such PR ${n}`);
    return found;
  }
  async listBotReviewComments() {
    return [];
  }
  async getRequestedReviewers() {
    return { users: [], teams: [] };
  }
  async listReviewCommentsFull(n: number) {
    this.swept.push(n);
    return this.inline.get(n) ?? [];
  }
  async listIssueComments(n: number) {
    return this.top.get(n) ?? [];
  }
  async listReviewsFull(n: number) {
    return this.reviews.get(n) ?? [];
  }
}

const hooks = (): SessionHooks =>
  ({
    ensureSession: async () => {},
    sendRoundOrder: async () => {},
    archiveAndClose: async () => {},
  }) as unknown as SessionHooks;

describe("the reconcile capture sweep (§6)", () => {
  it("picks up a comment the webhook missed, and re-running captures nothing twice", async () => {
    const store = trackedStore();
    const gh = new SweepGitHub();
    gh.open = [ref(PR)];
    gh.inline.set(PR, [
      rc({ id: 501 }),
      rc({ id: 502, user: BOT, user_type: "Bot", body: "bot nit" }),
    ]);
    gh.top.set(PR, [
      {
        id: 601,
        user: "alex",
        user_type: "User",
        body: "holding for the migration",
        created_at: null,
      },
    ]);
    gh.reviews.set(PR, [
      {
        id: 701,
        user: "pmercier",
        user_type: "User",
        state: "commented",
        body: "[feedback] over-specific",
        commit_id: "c",
        submitted_at: null,
      },
      {
        id: 702,
        user: BOT,
        user_type: "Bot",
        state: "changes_requested",
        body: "the bot's own review",
        commit_id: "c",
        submitted_at: null,
      },
    ]);

    const first = await reconcileOnce({ cfg, store, adapter: gh, hooks: hooks() });
    expect(first.captured_comments).toBe(3);
    const rows = store.prComments(PR);
    expect(rows.map((r) => r.comment_id).sort()).toEqual([501, 601, 701]);
    expect(rows.every((r) => r.captured_via === "reconcile")).toBe(true);
    // The tag is recorded, and that is all it does here — the same-day
    // addendum stays on the webhook's tag-gated feedback path.
    expect(rows.find((r) => r.comment_id === 701)?.tagged).toBe(1);
    expect(store.db.prepare("SELECT COUNT(*) c FROM feedback_signals").get()).toMatchObject({
      c: 0,
    });

    const second = await reconcileOnce({ cfg, store, adapter: gh, hooks: hooks() });
    expect(second.captured_comments).toBe(0);
    expect(store.prComments(PR)).toHaveLength(3);
    store.close();
  });

  it("does not re-capture what the webhook already recorded", async () => {
    const store = trackedStore();
    store.registerBotComment(800001, PR, "review_comment");
    deliver(store, reviewComment(), "pull_request_review_comment", "g-sweep-overlap");
    expect(store.prComments(PR)).toHaveLength(1);

    const gh = new SweepGitHub();
    gh.open = [ref(PR)];
    gh.inline.set(PR, [rc({ id: 900001, body: "This is intentional — the retry is idempotent." })]);
    const report = await reconcileOnce({ cfg, store, adapter: gh, hooks: hooks() });
    expect(report.captured_comments).toBe(0);
    expect(store.prComments(PR)).toHaveLength(1);
    expect(store.prComments(PR)[0]?.captured_via).toBe("webhook");
    store.close();
  });

  it("is bounded: at most COMMENT_SWEEP_MAX_PRS PRs a pass, freshest first, long-closed PRs never", async () => {
    const store = new StateStore(":memory:");
    const gh = new SweepGitHub();
    for (let i = 1; i <= 30; i++) {
      // updated_at descends with i, so #1 is freshest and #30 oldest.
      store.db
        .prepare(
          "INSERT INTO pr_state (number, state, head_sha, title, author, updated_at) VALUES (?, 'tracked', '', '', 'alice', ?)",
        )
        .run(i, `2026-08-20T${String(Math.min(30 - i, 23)).padStart(2, "0")}:00:00Z`);
    }
    // #1 closed OUTSIDE the recent-close window (its row last moved days ago):
    // the sweep leaves it alone. A recent close is a different case, below.
    store.db.prepare("UPDATE pr_state SET state = 'closed' WHERE number = 1").run();
    await reconcileOnce({ cfg, store, adapter: gh, hooks: hooks() });
    expect(gh.swept).toHaveLength(25);
    expect(gh.swept).not.toContain(1); // closed long ago
    expect(gh.swept[0]).toBe(2); // freshest open PR first
    expect(gh.swept).not.toContain(30); // oldest, past the bound
    store.close();
  });

  it("captures the comment on a PR that closed while the daemon was down", async () => {
    // Adversarial finding (P1): the closed-sync step marks the PR closed
    // EARLIER IN THE SAME PASS, so a bare `state !== "closed"` filter skipped
    // exactly the PR whose comments this backstop exists to recover.
    const store = trackedStore();
    const gh = new SweepGitHub();
    gh.open = []; // GitHub no longer lists it open…
    gh.getPr = async () => ref(PR, { state: "closed", merged: false }); // …because it closed during the downtime
    gh.top.set(PR, [
      {
        id: 881,
        user: "alex",
        user_type: "User",
        body: "posted while the daemon was down",
        created_at: null,
      },
    ]);

    const report = await reconcileOnce({ cfg, store, adapter: gh, hooks: hooks() });
    expect(report.closed).toEqual([PR]);
    expect(report.captured_comments).toBe(1);
    expect(store.prComments(PR).map((r) => r.comment_id)).toEqual([881]);
    store.close();
  });

  it("skips the capture reads for a PR unchanged since its last clean sweep", async () => {
    // Adversarial finding (P2): three reads per PR for 25 PRs on EVERY
    // reconcile pass was ~900 standing requests an hour with nothing changing.
    // A ticking store clock keeps row timestamps strictly increasing, so two
    // fast passes can never collide on the same millisecond.
    let tick = 0;
    const store = new StateStore(":memory:", () => new Date(1756100000000 + tick++ * 1000));
    store.upsertPr({
      number: PR,
      state: "tracked",
      head_sha: "sha4242",
      title: "Add retry to the ingest worker",
      author: "alice",
      trigger_ts: null,
      stale_recheck: 0,
      migration_gate: 0,
    });
    const gh = new SweepGitHub();
    gh.open = [ref(PR)];
    gh.inline.set(PR, [rc({ id: 991 })]);

    const first = await reconcileOnce({ cfg, store, adapter: gh, hooks: hooks() });
    expect(first.captured_comments).toBe(1);
    const readsAfterFirst = gh.swept.length;
    expect(readsAfterFirst).toBeGreaterThan(0);

    // Nothing changed → zero capture reads, not merely zero new rows.
    const second = await reconcileOnce({ cfg, store, adapter: gh, hooks: hooks() });
    expect(second.captured_comments).toBe(0);
    expect(gh.swept.length).toBe(readsAfterFirst);

    // The PR moves (new head) → its row is rewritten → swept again.
    gh.open = [ref(PR, { head_sha: "sha-moved" })];
    gh.inline.set(PR, [rc({ id: 991 }), rc({ id: 992 })]);
    const third = await reconcileOnce({ cfg, store, adapter: gh, hooks: hooks() });
    expect(gh.swept.length).toBe(readsAfterFirst + 1);
    expect(third.captured_comments).toBe(1);
    store.close();
  });

  it("re-sweeps an otherwise unchanged PR when GitHub's own updated_at moved (a comment the webhook lost)", async () => {
    // Selfscan finding d02908a3: the watermark was the LOCAL row's updated_at,
    // which capturing a comment never moves — so a human comment posted while
    // the daemon was down, with no push or title change, was filtered out of
    // every later pass. GitHub's PR `updated_at` moves on a new comment.
    let tick = 0;
    const store = new StateStore(":memory:", () => new Date(1756100000000 + tick++ * 1000));
    store.upsertPr({
      number: PR,
      state: "tracked",
      head_sha: "sha4242",
      title: "Add retry to the ingest worker",
      author: "alice",
      trigger_ts: null,
      stale_recheck: 0,
      migration_gate: 0,
    });
    const gh = new SweepGitHub();
    gh.open = [ref(PR, { head_sha: "sha4242", title: "Add retry to the ingest worker" })];
    const first = await reconcileOnce({ cfg, store, adapter: gh, hooks: hooks() });
    expect(first.captured_comments).toBe(0);
    const reads = gh.swept.length;
    expect(reads).toBe(1);

    // Daemon down; a human comments. Same head, same title — only GitHub's
    // updated_at moves.
    gh.open = [
      ref(PR, {
        head_sha: "sha4242",
        title: "Add retry to the ingest worker",
        updated_at: "2026-08-25T10:30:00Z",
      }),
    ];
    gh.top.set(PR, [
      { id: 4401, user: "alex", user_type: "User", body: "posted while down", created_at: null },
    ]);
    const second = await reconcileOnce({ cfg, store, adapter: gh, hooks: hooks() });
    expect(gh.swept.length).toBe(reads + 1);
    expect(second.captured_comments).toBe(1);

    // And the gate still holds once that is swept: nothing moved → no reads.
    await reconcileOnce({ cfg, store, adapter: gh, hooks: hooks() });
    expect(gh.swept.length).toBe(reads + 1);
    store.close();
  });

  it("a failed open-PR list is not read as GitHub's updated_at moving", async () => {
    const store = new StateStore(":memory:");
    store.upsertPr({
      number: PR,
      state: "tracked",
      head_sha: "sha4242",
      title: "Add retry to the ingest worker",
      author: "alice",
      trigger_ts: null,
      stale_recheck: 0,
      migration_gate: 0,
    });
    const gh = new SweepGitHub();
    gh.open = [ref(PR, { head_sha: "sha4242", title: "Add retry to the ingest worker" })];
    await reconcileOnce({ cfg, store, adapter: gh, hooks: hooks() });
    expect(gh.swept.length).toBe(1);

    const listOk = gh.listOpenPrs.bind(gh);
    gh.listOpenPrs = async () => {
      throw new Error("502");
    };
    await reconcileOnce({ cfg, store, adapter: gh, hooks: hooks() });
    expect(gh.swept.length).toBe(1);

    gh.listOpenPrs = listOk;
    await reconcileOnce({ cfg, store, adapter: gh, hooks: hooks() });
    expect(gh.swept.length).toBe(1);
    store.close();
  });

  it("a failed read leaves no watermark, so the PR is retried next pass", async () => {
    const store = trackedStore();
    const gh = new SweepGitHub();
    gh.open = [ref(PR)];
    let down = true;
    gh.listIssueComments = async () => {
      if (down) throw new Error("502 from GitHub");
      return [];
    };
    gh.inline.set(PR, [rc({ id: 771 })]);

    const first = await reconcileOnce({ cfg, store, adapter: gh, hooks: hooks() });
    expect(first.captured_comments).toBe(0);
    down = false;
    const second = await reconcileOnce({ cfg, store, adapter: gh, hooks: hooks() });
    expect(second.captured_comments).toBe(1);
    store.close();
  });

  // ----: the exec boundary's outcome layer, WIRED ------------------
  // The pure audit is proven in tests/exec-boundary.test.ts. What matters here
  // is that the sweep actually runs it: a layer nobody calls is the failure
  // mode this whole ticket is about (a pin that silently does nothing).
  it("flags a bot review at the head that the daemon has no record of posting", async () => {
    const store = trackedStore();
    const gh = new SweepGitHub();
    gh.open = [ref(PR)];
    gh.reviews.set(PR, [
      // Posted by SOMETHING — the audit never asks what. No marker, no ledger
      // row, no reviewed_heads mark, at the PR's current head.
      {
        id: 801,
        user: BOT,
        user_type: "Bot",
        state: "APPROVED",
        body: "LGTM",
        commit_id: "sha4242",
        submitted_at: null,
      },
    ]);

    const report = await reconcileOnce({ cfg, store, adapter: gh, hooks: hooks() });
    expect(report.errors.some((e) => e.includes("ungated-review #4242"))).toBe(true);
    const ev = store.db
      .prepare("SELECT payload FROM events WHERE kind = 'ungated_review_detected'")
      .get() as { payload: string } | undefined;
    expect(ev, "the durable record").toBeTruthy();
    expect(JSON.parse(ev!.payload)).toMatchObject({
      head_sha: "sha4242",
      reviews: [{ review_id: 801, state: "APPROVED" }],
    });
    // An unaccounted APPROVE is human-attention grade: rule 1, the CI
    // hard-gate and every posting guard are bypassed at once.
    const anomaly = store.db.prepare("SELECT kind FROM events WHERE kind = 'anomaly'").all();
    expect(anomaly.length).toBeGreaterThan(0);
    store.close();
  });

  it("does not flag the review the daemon DID record — the sweep must not cry wolf", async () => {
    const store = trackedStore();
    const gh = new SweepGitHub();
    gh.open = [ref(PR)];
    gh.reviews.set(PR, [
      {
        id: 802,
        user: BOT,
        user_type: "Bot",
        state: "APPROVED",
        body: "LGTM",
        commit_id: "sha4242",
        submitted_at: null,
      },
    ]);
    store.recordReviewedHead(PR, { head_sha: "sha4242", posted_event: "APPROVE" });

    const report = await reconcileOnce({ cfg, store, adapter: gh, hooks: hooks() });
    expect(report.errors.filter((e) => e.includes("ungated-review"))).toEqual([]);
    expect(
      store.db
        .prepare("SELECT COUNT(*) c FROM events WHERE kind = 'ungated_review_detected'")
        .get(),
    ).toMatchObject({ c: 0 });
    store.close();
  });

  it("a posting marker counts only with a key the daemon issued for this PR (selfscan 6475bc58)", async () => {
    const store = trackedStore();
    const roundId = store.startRound(PR, "review", [], 75);
    store.stampPostingKey(roundId, `v1:${PR}:1:sha4242`);
    const gh = new SweepGitHub();
    gh.open = [ref(PR)];
    const approve = (id: number, body: string) => ({
      id,
      user: BOT,
      user_type: "Bot",
      state: "APPROVED",
      body,
      commit_id: "sha4242",
      submitted_at: null,
    });
    gh.reviews.set(PR, [
      approve(803, `LGTM\n\n<!-- qcr-post:v1:${PR}:1:sha4242 -->`), // the sanctioned route
      approve(804, "LGTM <!-- qcr-post:x -->"), // a forged marker
    ]);

    await reconcileOnce({ cfg, store, adapter: gh, hooks: hooks() });
    const ev = store.db
      .prepare("SELECT payload FROM events WHERE kind = 'ungated_review_detected'")
      .get() as { payload: string } | undefined;
    expect(ev).toBeTruthy();
    expect(JSON.parse(ev!.payload).reviews).toEqual([
      expect.objectContaining({ review_id: 804, state: "APPROVED" }),
    ]);
    store.close();
  });

  it("is skippable and survives an adapter that cannot read comments", async () => {
    const store = trackedStore();
    const gh = new SweepGitHub();
    gh.open = [ref(PR)];
    gh.inline.set(PR, [rc({ id: 999 })]);
    const off = await reconcileOnce({
      cfg,
      store,
      adapter: gh,
      hooks: hooks(),
      captureComments: false,
    });
    expect(off.captured_comments).toBe(0);
    expect(gh.swept).toHaveLength(0);

    // An adapter that cannot read comments at all (a stub-wired daemon): the
    // sweep must simply not exist, not error.
    const blind = new SweepGitHub();
    blind.open = gh.open;
    Object.defineProperty(blind, "listReviewCommentsFull", { value: undefined });
    const none = await reconcileOnce({
      cfg,
      store,
      adapter: blind as ReconcileAdapter,
      hooks: hooks(),
    });
    expect(none.captured_comments).toBe(0);
    expect(none.errors).toEqual([]);
    store.close();
  });

  it("contains a failing read to one PR", async () => {
    const store = trackedStore();
    const gh = new SweepGitHub();
    gh.open = [ref(PR)];
    gh.listIssueComments = async () => {
      throw new Error("502 from GitHub");
    };
    gh.inline.set(PR, [rc({ id: 777 })]);
    const report = await reconcileOnce({ cfg, store, adapter: gh, hooks: hooks() });
    expect(report.captured_comments).toBe(0);
    expect(report.errors.join(" ")).toContain("comment-capture #4242");
    store.close();
  });
});

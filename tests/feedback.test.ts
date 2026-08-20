// The [feedback] tuning loop: explicit [feedback] comments +
// behavioral signals, diverted OUT of the round path, deduped, written to
// reviewer memory through memedit, and composed into a same-day
// validator-only addendum.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseConfig, type Config } from "../src/config.js";
import {
  REVIEW_SET_ASIDE_STALE_WINDOW_MS,
  FeedbackEngine,
  feedbackDayAddendum,
  isFeedbackBody,
  memoryEntryFor,
  sanitizeFeedbackText,
  warsawDay,
  type FeedbackEvent,
} from "../src/feedback.js";
import { VALIDATE_PASS, buildAgents } from "../src/include.js";
import { StateStore, type FeedbackSignalRow } from "../src/state.js";
import { applyInterpretation, interpretEvent, type Interpretation } from "../src/webhook.js";

const cfg: Config = parseConfig(readFileSync(resolve(process.cwd(), "config.toml"), "utf8"));
const BOT = cfg.github.bot_login;

const deps = (botCommentPr: (id: number) => number | undefined = () => undefined) => ({
  botLogin: BOT,
  triggerLabel: cfg.github.trigger_label,
  reviewTeam: cfg.github.review_team,
  botCommentPr,
});

// ---- prefix + hygiene ------------------------------------------------------

describe("isFeedbackBody", () => {
  it("matches the tag at the start, case-insensitive, with leading whitespace", () => {
    expect(isFeedbackBody("[feedback] too specific")).toBe(true);
    expect(isFeedbackBody("  [Feedback] wrong")).toBe(true);
    expect(isFeedbackBody("[FEEDBACK]x")).toBe(true);
  });

  it("never matches mid-body mentions or absent bodies", () => {
    expect(isFeedbackBody("I left [feedback] on this")).toBe(false);
    expect(isFeedbackBody("feedback: nope")).toBe(false);
    expect(isFeedbackBody(null)).toBe(false);
    expect(isFeedbackBody(undefined)).toBe(false);
  });
});

describe("sanitizeFeedbackText", () => {
  it("strips the tag, flattens whitespace, drops backticks, caps length", () => {
    expect(sanitizeFeedbackText("[feedback]  this `rule`\nis   over-specific ")).toBe("this 'rule' is over-specific");
    const long = `[feedback] ${"x".repeat(400)}`;
    expect(sanitizeFeedbackText(long).length).toBeLessThanOrEqual(280);
    expect(sanitizeFeedbackText(long).endsWith("…")).toBe(true);
  });
});

describe("warsawDay", () => {
  it("returns the Warsaw calendar date (DST-correct via Intl)", () => {
    // 2026-08-19T23:30Z is already 2026-08-20 in Warsaw (UTC+2 in August).
    expect(warsawDay(new Date("2026-08-19T23:30:00Z"))).toBe("2026-08-20");
    expect(warsawDay(new Date("2026-08-19T12:00:00Z"))).toBe("2026-08-19");
  });
});

// ---- memory entries --------------------------------------------------------

describe("memoryEntryFor", () => {
  it("every kind yields one #feedback line with PR evidence and the day", () => {
    const events: FeedbackEvent[] = [
      {
        kind: "feedback_comment",
        pr: 5325,
        comment_id: 9,
        in_reply_to_id: 7,
        author: "pmercier",
        body: "[feedback] over-specific",
        scope: "review_comment",
      },
      { kind: "review_set_aside", pr: 5325, review_id: 44, by: "alex", stale: false },
      { kind: "merged_over_block", pr: 5325 },
      { kind: "bot_comment_deleted", pr: 5325, comment_id: 12 },
      { kind: "trigger_withdrawn", pr: 5325, by: "pmercier" },
    ];
    for (const e of events) {
      const line = memoryEntryFor(e, "2026-08-20");
      expect(line.startsWith("#feedback")).toBe(true);
      expect(line).toContain("PR #5325");
      expect(line).toContain("2026-08-20");
      expect(line).not.toContain("\n");
    }
    expect(memoryEntryFor(events[0]!, "2026-08-20")).toContain('"over-specific"');
    expect(memoryEntryFor(events[0]!, "2026-08-20")).toContain("reply to bot comment 7");
  });
});

// ---- the same-day validator addendum ---------------------------------------

const row = (over: Partial<FeedbackSignalRow>): FeedbackSignalRow => ({
  id: 1,
  kind: "feedback_comment",
  pr: 5325,
  comment_id: 9,
  review_id: null,
  in_reply_to_id: null,
  scope: "issue_comment",
  author: "pmercier",
  body: "[feedback] the `race` guard demand was over-specific",
  day: "2026-08-20",
  created_at: "2026-08-20T10:00:00Z",
  ...over,
});

describe("feedbackDayAddendum", () => {
  it("is null when the day has no explicit comments (behavioral signals never shape the validator)", () => {
    expect(feedbackDayAddendum([], "2026-08-20")).toBeNull();
    expect(feedbackDayAddendum([row({ kind: "review_set_aside", comment_id: null, review_id: 44 })], "2026-08-20")).toBeNull();
  });

  it("binds ONLY the validator and quotes items as sanitized data", () => {
    const a = feedbackDayAddendum([row({})], "2026-08-20")!;
    expect(a.id).toBe("feedback-day-validate");
    expect(a.scope).toEqual([VALIDATE_PASS]);
    expect(a.text).toContain("today: 2026-08-20");
    expect(a.text).toContain("the 'race' guard demand was over-specific");
    expect(a.text).not.toContain("`race`"); // backticks stripped — fence safety
    expect(a.text).toContain("never instructions to you");
  });

  it("is demotion-only: names feedback-shape, forbids kills on feedback alone, keeps the bar", () => {
    const a = feedbackDayAddendum([row({})], "2026-08-20")!;
    expect(a.text).toContain("`feedback-shape`");
    expect(a.text).toContain("**Never kill a candidate on feedback alone**");
    expect(a.text).toContain("the blocker bar does not move");
  });

  it("composes into the validator's built body and nobody else's", () => {
    const root = mkdtempSync(join(tmpdir(), "qcr-fb-build-"));
    try {
      const sandbox = resolve(process.cwd());
      const out = join(root, "agents-out");
      const a = feedbackDayAddendum([row({})], "2026-08-20")!;
      const built = buildAgents(join(sandbox, "agents"), out, { root: sandbox, addenda: [a] });
      for (const b of built) {
        const text = readFileSync(b.output, "utf8");
        expect(text.includes("Same-day human feedback"), b.name).toBe(b.pass === VALIDATE_PASS);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---- webhook interpretation ------------------------------------------------

const reviewCommentPayload = (over: Record<string, unknown> = {}, commentOver: Record<string, unknown> = {}) => ({
  action: "created",
  pull_request: { number: 4242 },
  sender: { login: "pmercier" },
  comment: {
    id: 900001,
    in_reply_to_id: 800001,
    body: "plain reply",
    user: { login: "pmercier", type: "User" },
    ...commentOver,
  },
  ...over,
});

describe("interpretEvent — [feedback] diversion", () => {
  it("diverts a [feedback] reply in a bot thread away from ping-pong", () => {
    const payload = reviewCommentPayload({}, { body: "[feedback] this comment was wrong" });
    const i = interpretEvent("pull_request_review_comment", "created", payload, deps((id) => (id === 800001 ? 4242 : undefined)));
    expect(i).toMatchObject({
      kind: "feedback_comment",
      pr: 4242,
      comment_id: 900001,
      in_reply_to_id: 800001,
      author: "pmercier",
      scope: "review_comment",
    });
  });

  it("captures a [feedback] reply even outside a bot thread", () => {
    const payload = reviewCommentPayload({}, { body: "[feedback] too much", in_reply_to_id: undefined });
    const i = interpretEvent("pull_request_review_comment", "created", payload, deps(() => undefined));
    expect(i).toMatchObject({ kind: "feedback_comment", in_reply_to_id: null });
  });

  it("leaves plain replies on the author_reply path", () => {
    const i = interpretEvent(
      "pull_request_review_comment",
      "created",
      reviewCommentPayload(),
      deps((id) => (id === 800001 ? 4242 : undefined)),
    );
    expect(i.kind).toBe("author_reply");
  });

  it("captures a [feedback] top-level comment and still ignores plain ones", () => {
    const issuePayload = (body: string) => ({
      action: "created",
      issue: { number: 4242, pull_request: {} },
      sender: { login: "pmercier" },
      comment: { id: 700001, body, user: { login: "pmercier", type: "User" } },
    });
    expect(interpretEvent("issue_comment", "created", issuePayload("[feedback] overall too strict"), deps())).toMatchObject({
      kind: "feedback_comment",
      scope: "issue_comment",
      in_reply_to_id: null,
    });
    expect(interpretEvent("issue_comment", "created", issuePayload("nice review"), deps())).toMatchObject({
      kind: "ignored",
      reason: "top-level PR comment is outside bot review threads",
    });
  });
});

describe("interpretEvent — behavioral signals", () => {
  const reviewPayload = (action: string, over: Record<string, unknown> = {}) => ({
    action,
    pull_request: { number: 4242 },
    sender: { login: "alex" },
    review: { id: 555, body: "", user: { login: BOT, type: "Bot" }, ...over },
  });

  it("a dismissal of the BOT's review is review_set_aside; of a human's, ignored", () => {
    expect(interpretEvent("pull_request_review", "dismissed", reviewPayload("dismissed"), deps())).toMatchObject({
      kind: "review_set_aside",
      pr: 4242,
      review_id: 555,
      by: "alex",
    });
    expect(
      interpretEvent("pull_request_review", "dismissed", reviewPayload("dismissed", { user: { login: "alice", type: "User" } }), deps())
        .kind,
    ).toBe("ignored");
  });

  it("a submitted human review with a [feedback] body is an explicit feedback comment", () => {
    const payload = reviewPayload("submitted", { user: { login: "pmercier", type: "User" }, body: "[feedback] verdict too harsh" });
    expect(interpretEvent("pull_request_review", "submitted", payload, deps())).toMatchObject({
      kind: "feedback_comment",
      scope: "review",
      comment_id: 555,
    });
    const plain = reviewPayload("submitted", { user: { login: "pmercier", type: "User" }, body: "lgtm" });
    expect(interpretEvent("pull_request_review", "submitted", plain, deps()).kind).toBe("ignored");
  });

  it("a HUMAN deleting a bot comment is bot_comment_deleted; anything else ignored", () => {
    const del = (commentUser: string, sender: string) => ({
      action: "deleted",
      pull_request: { number: 4242 },
      sender: { login: sender },
      comment: { id: 800001, body: "x", user: { login: commentUser, type: commentUser === BOT ? "Bot" : "User" } },
    });
    expect(interpretEvent("pull_request_review_comment", "deleted", del(BOT, "pmercier"), deps())).toMatchObject({
      kind: "bot_comment_deleted",
      pr: 4242,
      comment_id: 800001,
    });
    expect(interpretEvent("pull_request_review_comment", "deleted", del("alice", "alice"), deps()).kind).toBe("ignored");
    expect(interpretEvent("pull_request_review_comment", "deleted", del(BOT, BOT), deps()).kind).toBe("ignored");
  });

  it("a HUMAN withdrawing the trigger is trigger_withdrawn; the bot consuming it is not", () => {
    const unlabel = (sender: string, label = cfg.github.trigger_label) => ({
      action: "unlabeled",
      pull_request: { number: 4242, title: "t", user: { login: "alice", type: "User" }, head: { sha: "s" } },
      label: { name: label },
      sender: { login: sender, type: sender === BOT ? "Bot" : "User" },
    });
    expect(interpretEvent("pull_request", "unlabeled", unlabel("pmercier"), deps())).toMatchObject({
      kind: "trigger_withdrawn",
      pr: 4242,
      by: "pmercier",
    });
    expect(interpretEvent("pull_request", "unlabeled", unlabel(BOT), deps()).kind).toBe("ignored");
    expect(interpretEvent("pull_request", "unlabeled", unlabel("pmercier", "wip"), deps()).kind).toBe("ignored");
    const teamSlug = cfg.github.review_team.split("/")[1]!;
    const unrequest = {
      action: "review_request_removed",
      pull_request: { number: 4242, title: "t", user: { login: "alice", type: "User" }, head: { sha: "s" } },
      requested_team: { slug: teamSlug },
      sender: { login: "pmercier", type: "User" },
    };
    expect(interpretEvent("pull_request", "review_request_removed", unrequest, deps())).toMatchObject({
      kind: "trigger_withdrawn",
      by: "pmercier",
    });
  });
});

// ---- applyInterpretation routing -------------------------------------------

describe("applyInterpretation — feedback routing", () => {
  let store: StateStore;
  beforeEach(() => {
    store = new StateStore(":memory:");
  });
  afterEach(() => store.close());

  const prRow = (state: string) => ({
    number: 4242,
    state: state as never,
    head_sha: "s",
    title: "t",
    author: "alice",
    trigger_ts: "2026-08-20T10:00:00Z",
    stale_recheck: 0,
    migration_gate: 0,
  });

  it("routes a feedback comment to onFeedbackSignal and NEVER to ping-pong or the reply mark", async () => {
    const onFeedbackSignal = vi.fn();
    const onAuthorReply = vi.fn();
    const i: Interpretation = {
      kind: "feedback_comment",
      pr: 4242,
      comment_id: 1,
      in_reply_to_id: 2,
      author: "pmercier",
      body: "[feedback] x",
      scope: "review_comment",
    };
    store.upsertPr(prRow("awaiting_author"));
    store.recordReviewedHead(4242, { head_sha: "s", verdict: "REQUEST_CHANGES", posted_event: "REQUEST_CHANGES", round_no: 1 });
    await applyInterpretation({ cfg, store, onFeedbackSignal, onAuthorReply } as never, i);
    expect(onFeedbackSignal).toHaveBeenCalledWith(i);
    expect(onAuthorReply).not.toHaveBeenCalled();
    // The new-evidence mark did not move — a [feedback] must not unlock a re-review.
    expect(store.reviewedHead(4242)?.last_author_reply_at ?? null).toBeNull();
  });

  it("emits merged_over_block only for a MERGED close over a standing REQUEST_CHANGES", async () => {
    const calls: unknown[] = [];
    const onFeedbackSignal = (e: unknown) => void calls.push(e);
    const meta = { number: 4242, title: "t", author: "alice", head_sha: "s" };

    store.upsertPr(prRow("awaiting_author"));
    await applyInterpretation({ cfg, store, onFeedbackSignal } as never, { kind: "closed", pr: 4242, merged: true, meta });
    expect(calls).toEqual([{ kind: "merged_over_block", pr: 4242 }]);

    calls.length = 0;
    store.upsertPr(prRow("awaiting_author"));
    await applyInterpretation({ cfg, store, onFeedbackSignal } as never, { kind: "closed", pr: 4242, merged: false, meta });
    expect(calls).toEqual([]);

    store.upsertPr(prRow("reviewing"));
    await applyInterpretation({ cfg, store, onFeedbackSignal } as never, { kind: "closed", pr: 4242, merged: true, meta });
    expect(calls).toEqual([]);
  });
});

// ---- the store ledger -------------------------------------------------------

describe("StateStore.recordFeedbackSignal", () => {
  let store: StateStore;
  beforeEach(() => {
    store = new StateStore(":memory:");
  });
  afterEach(() => store.close());

  it("dedupes on the natural key per kind", () => {
    const sig = { kind: "feedback_comment", pr: 1, comment_id: 9, scope: "review_comment", day: "2026-08-20" };
    expect(store.recordFeedbackSignal(sig)).toBe(true);
    expect(store.recordFeedbackSignal(sig)).toBe(false);
    // Same numeric id under a different scope is a DIFFERENT surface (review
    // ids and comment ids are separate namespaces).
    expect(store.recordFeedbackSignal({ ...sig, scope: "review" })).toBe(true);
    expect(store.recordFeedbackSignal({ kind: "review_set_aside", pr: 1, review_id: 44, day: "2026-08-20" })).toBe(true);
    expect(store.recordFeedbackSignal({ kind: "review_set_aside", pr: 1, review_id: 44, day: "2026-08-21" })).toBe(false);
    expect(store.recordFeedbackSignal({ kind: "merged_over_block", pr: 1, day: "2026-08-20" })).toBe(true);
    expect(store.recordFeedbackSignal({ kind: "merged_over_block", pr: 1, day: "2026-08-21" })).toBe(false);
    expect(store.recordFeedbackSignal({ kind: "merged_over_block", pr: 2, day: "2026-08-20" })).toBe(true);
  });

  it("feedbackCommentsForDay returns only that day's explicit comments, oldest first", () => {
    store.recordFeedbackSignal({ kind: "feedback_comment", pr: 1, comment_id: 1, body: "a", day: "2026-08-20" });
    store.recordFeedbackSignal({ kind: "feedback_comment", pr: 1, comment_id: 2, body: "b", day: "2026-08-20" });
    store.recordFeedbackSignal({ kind: "feedback_comment", pr: 1, comment_id: 3, body: "c", day: "2026-08-19" });
    store.recordFeedbackSignal({ kind: "review_set_aside", pr: 1, review_id: 5, day: "2026-08-20" });
    expect(store.feedbackCommentsForDay("2026-08-20").map((r) => r.body)).toEqual(["a", "b"]);
  });

  it("lastEventAt reads the newest event of a kind for a PR", () => {
    expect(store.lastEventAt("head_push", 1)).toBeUndefined();
    store.logEvent("head_push", 1, {});
    expect(store.lastEventAt("head_push", 1)).toBeDefined();
    expect(store.lastEventAt("head_push", 2)).toBeUndefined();
  });
});

// ---- the engine -------------------------------------------------------------

describe("FeedbackEngine.ingest", () => {
  let store: StateStore;
  beforeEach(() => {
    store = new StateStore(":memory:");
  });
  afterEach(() => store.close());

  const comment: FeedbackEvent = {
    kind: "feedback_comment",
    pr: 5325,
    comment_id: 9,
    in_reply_to_id: 7,
    author: "pmercier",
    body: "[feedback] over-specific",
    scope: "review_comment",
  };

  it("records, writes one memory entry, and rebuilds agents for an explicit comment", async () => {
    const writeMemory = vi.fn().mockResolvedValue("ok");
    const rebuildAgents = vi.fn();
    const engine = new FeedbackEngine({ store, rebuildAgents, writeMemory });
    expect(await engine.ingest(comment)).toBe("recorded");
    expect(writeMemory).toHaveBeenCalledTimes(1);
    expect(String(writeMemory.mock.calls[0]![0]).startsWith("#feedback")).toBe(true);
    expect(rebuildAgents).toHaveBeenCalledTimes(1);
    expect(await engine.ingest(comment)).toBe("duplicate");
    expect(writeMemory).toHaveBeenCalledTimes(1);
    expect(rebuildAgents).toHaveBeenCalledTimes(1);
  });

  it("behavioral signals write memory but never rebuild agents", async () => {
    const writeMemory = vi.fn().mockResolvedValue("ok");
    const rebuildAgents = vi.fn();
    const engine = new FeedbackEngine({ store, rebuildAgents, writeMemory });
    expect(await engine.ingest({ kind: "bot_comment_deleted", pr: 1, comment_id: 3 })).toBe("recorded");
    expect(await engine.ingest({ kind: "trigger_withdrawn", pr: 1, by: "pmercier" })).toBe("recorded");
    expect(rebuildAgents).not.toHaveBeenCalled();
    expect(writeMemory).toHaveBeenCalledTimes(2);
  });

  it("skips a stale dismissal entirely (GitHub's stale-on-push auto-dismiss)", async () => {
    const writeMemory = vi.fn();
    const engine = new FeedbackEngine({ store, rebuildAgents: vi.fn(), writeMemory });
    expect(await engine.ingest({ kind: "review_set_aside", pr: 1, review_id: 4, by: "x", stale: true })).toBe(
      "skipped_stale",
    );
    expect(writeMemory).not.toHaveBeenCalled();
    expect(store.feedbackCommentsForDay(warsawDay())).toEqual([]);
    // A real dismissal ingests.
    expect(await engine.ingest({ kind: "review_set_aside", pr: 1, review_id: 4, by: "x", stale: false })).toBe(
      "recorded",
    );
  });

  it("a failed memory write never loses the ledgered signal", async () => {
    const writeMemory = vi.fn().mockRejectedValue(new Error("locked"));
    const rebuildAgents = vi.fn();
    const engine = new FeedbackEngine({ store, rebuildAgents, writeMemory });
    expect(await engine.ingest(comment)).toBe("recorded");
    expect(rebuildAgents).toHaveBeenCalledTimes(1);
    expect(store.feedbackCommentsForDay(warsawDay()).length).toBe(1);
  });

  it("stale window constant stays within sane bounds", () => {
    expect(REVIEW_SET_ASIDE_STALE_WINDOW_MS).toBeGreaterThanOrEqual(60_000);
    expect(REVIEW_SET_ASIDE_STALE_WINDOW_MS).toBeLessThanOrEqual(600_000);
  });
});

// ---- memedit `note` op (real subprocess, like guards-shell) -----------------

describe("memedit note op", () => {
  it("appends a pre-tagged entry verbatim and refuses untagged text", () => {
    const dir = mkdtempSync(join(tmpdir(), "qcr-memedit-note-"));
    const mem = join(dir, "MEMORY.md");
    try {
      writeFileSync(mem, "# Reviewer memory\n\nexisting preamble\n");
      const run = (input: string) =>
        spawnSync(process.execPath, [resolve(process.cwd(), "scripts", "memedit.mjs"), "note"], {
          input,
          env: { ...process.env, QCR_MEMORY_PATH: mem },
          encoding: "utf8",
        });
      const ok = run("#feedback human [feedback] on PR #1: \"too strict\" — 2026-08-20");
      expect(ok.status).toBe(0);
      expect(ok.stdout).toContain("ok: note");
      const text = readFileSync(mem, "utf8");
      expect(text).toContain("existing preamble");
      expect(text).toMatch(/<!-- \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[qcrd-[a-z0-9]+\] -->/);
      expect(text).toContain("#feedback human [feedback] on PR #1");
      expect(text).not.toContain("#manual #feedback"); // never re-tagged

      const refused = run("untagged prose");
      expect(refused.status).toBe(1);
      expect(refused.stdout).toContain("refused: note: text must open with a #tag");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

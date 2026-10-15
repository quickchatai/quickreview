// Outcome capture: every posted inline comment linked to its
// finding, every posted finding given a fate, the whole-review signals
// recorded per review, and canonical lens ids. The contract's acceptance
// criteria, one block each:
//   - the linker: exact marker, the render-off path + line (+ title) fallback,
//     an unmatched comment staying null — from the bot comments the reconcile
//     sweep already read, and from the state database alone;
//   - the fate table: a sha-cited fix, an argued refutation, a hold, a fix the
//     code proves, the latest evidence winning, open at close, unknown;
//   - a set-aside joined through `gh_review_id` and a merge over a block,
//     recorded per review and never smeared over the review's findings;
//   - canonical `lens_ids` from the live store's composite spellings;
//   - nothing here writes to GitHub, and the reconcile pass's health never
//     waits on it.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseConfig, type Config } from "../src/config.js";
import {
  OUTCOMES_USAGE,
  captureOutcomesWindow,
  parseOutcomesArgs,
  recordOnlyGate,
} from "../src/cli.js";
import { createDaemon, type DaemonAdapter } from "../src/daemon.js";
import { findingMarker } from "../src/findingkey.js";
import type { PrRef, ReviewCommentFull } from "../src/github.js";
import { canonicalLensIds } from "../src/lensids.js";
import {
  OUTCOME_RECAPTURE_MS,
  OutcomeCapture,
  citedSha,
  citedShas,
  concedesPoint,
  commentHead,
  decideFate,
  renderOutcomeSummary,
  type AnchorGit,
} from "../src/outcomes.js";
import { reconcileOnce, type ReconcileAdapter } from "../src/reconcile.js";
import { StateStore, type RoundFindingInput } from "../src/state.js";
import type { SessionHooks } from "../src/types.js";

const cfg: Config = parseConfig(
  readFileSync(resolve(process.cwd(), "tests/fixtures/config.toml"), "utf8"),
);
const BOT = cfg.github.bot_login;
const PR = 5100;
const H1 = "a1".repeat(20);
const H2 = "b2".repeat(20);
const H3 = "c3".repeat(20);

/** A controllable clock shared by the store and the capture. */
function harness(opts: { git?: AnchorGit; state?: "tracked" | "closed" } = {}) {
  let now = new Date("2026-10-01T10:00:00.000Z");
  const clock = () => now;
  const store = new StateStore(":memory:", clock);
  store.upsertPr({
    number: PR,
    state: opts.state ?? "tracked",
    head_sha: H1,
    title: "Retry the ingest worker",
    author: "alice",
    trigger_ts: null,
    stale_recheck: 0,
    migration_gate: 0,
  });
  const capture = new OutcomeCapture({
    store,
    botLogin: BOT,
    ...(opts.git ? { git: opts.git } : {}),
    now: clock,
  });
  return {
    store,
    capture,
    at: () => now.toISOString(),
    tick(min = 1) {
      now = new Date(now.getTime() + min * 60_000);
      return now.toISOString();
    },
    /** A push the webhook saw: the head moves and `head_push` is logged. */
    push(head: string): void {
      store.db.prepare("UPDATE pr_state SET head_sha = ? WHERE number = ?").run(head, PR);
      store.logEvent("head_push", PR, { head_sha: head, source: "webhook" });
    },
    /** One finished round with a posted review (id) and a parsed record. */
    round(
      head: string,
      findings: RoundFindingInput[],
      over: { review_id?: number | null; verdict?: string } = {},
    ): number {
      const id = store.startRound(PR, "first", ["pass-baseline"], 60);
      const no = store.roundsFor(PR).find((r) => r.id === id)!.round_no;
      store.db
        .prepare(
          "UPDATE rounds SET status='done', verdict=?, finished_at=?, gh_review_id=?, gh_commit_id=? WHERE id=?",
        )
        .run(
          over.verdict ?? "REQUEST_CHANGES",
          now.toISOString(),
          over.review_id === undefined ? 7000 + no : over.review_id,
          head,
          id,
        );
      now = new Date(now.getTime() + 60_000);
      store.recordRoundFindings({ pr: PR, round_id: id, round_no: no, head_sha: head }, findings);
      store.logEvent("findings_recorded", PR, { round_no: no, entries: findings.length });
      return no;
    },
  };
}

const posted = (over: Partial<RoundFindingInput> & { key: string }): RoundFindingInput => ({
  path: "workers/ingest.py",
  line: 42,
  lens: "pass-baseline",
  severity: "P1",
  disposition: "posted",
  posted_as: "blocker",
  title: "Retry loops forever",
  ...over,
});

function botComment(over: Partial<ReviewCommentFull> & { id: number }): ReviewCommentFull {
  return {
    user: BOT,
    user_type: "Bot",
    body: "[blocker] Retry loops forever\n\nbody",
    path: "workers/ingest.py",
    line: 42,
    original_line: 42,
    pull_request_review_id: 7001,
    in_reply_to_id: null,
    created_at: "2026-10-01T10:00:30.000Z",
    ...over,
  };
}

function humanReply(
  store: StateStore,
  over: { id: number; root: number; body: string; at: string; author?: string },
) {
  store.recordPrComment({
    pr: PR,
    source: "review_comment",
    comment_id: over.id,
    in_reply_to_id: over.root,
    thread_id: over.root,
    author: over.author ?? "alice",
    author_type: "User",
    path: "workers/ingest.py",
    line: 42,
    body: over.body,
    created_at: over.at,
  });
}

/** A fake git: `answers[path@from..to]` says whether the anchor was touched,
 * `fixes[sha]` whether a cited sha is a commit made after the review; anything
 * else is unknown. */
function fakeGit(
  answers: Record<string, boolean>,
  fixes: Record<string, boolean> = {},
): AnchorGit & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async anchorTouched(path, _line, from, to) {
      const k = `${path}@${from.slice(0, 2)}..${to.slice(0, 2)}`;
      asked.push(k);
      return k in answers ? answers[k]! : null;
    },
    async introducedBetween(sha, from, to) {
      asked.push(`${sha}@${from.slice(0, 2)}..${to.slice(0, 2)}`);
      return sha in fixes ? fixes[sha]! : null;
    },
  };
}

/** Resolve-then-decide, at ONE instant: the order and timing production logs
 * them in (`ThreadDecisionWatcher.handleFile`). */
function resolvedThread(
  store: StateStore,
  thread: number,
  reply: number,
  decision: { resolution?: string; outcome?: string | null; skipped?: string | null } = {},
) {
  if ((decision.resolution ?? "resolve") === "resolve")
    store.logEvent("pingpong_thread_resolved", PR, {
      thread_id: thread,
      comment_id: reply,
      reason: null,
      skipped: decision.skipped ?? null,
    });
  store.logEvent("pingpong_decision_applied", PR, {
    thread_id: thread,
    comment_id: reply,
    resolution: decision.resolution ?? "resolve",
    human_requested: false,
    outcome: decision.outcome ?? null,
  });
}

// ---------------------------------------------------------------------------

describe("canonical lens ids from the live store's spellings", () => {
  it.each([
    ["pass-baseline", ["pass-baseline"]],
    ["pass-baseline + pass-sweep (2 lenses)", ["pass-baseline", "pass-sweep"]],
    ["pass-baseline+pass-sweep (2 lenses)", ["pass-baseline", "pass-sweep"]],
    ["pass-baseline,pass-claims,pass-sweep", ["pass-baseline", "pass-claims", "pass-sweep"]],
    ["pass-baseline, pass-intent", ["pass-baseline", "pass-intent"]],
    ["pass-baseline/pass-ui", ["pass-baseline", "pass-ui"]],
    ["pass-style+pass-baseline", ["pass-style", "pass-baseline"]],
    [
      "pass-baseline+pass-intent+pass-claims+pass-rollout+pass-consistency+pass-sweep (6 lenses)",
      [
        "pass-baseline",
        "pass-intent",
        "pass-claims",
        "pass-rollout",
        "pass-consistency",
        "pass-sweep",
      ],
    ],
    ["baseline", ["pass-baseline"]],
    ["pass-sweep:G1", ["pass-sweep"]],
    ["pass-validate", ["pass-validate"]],
    ["pass-baseline, pass-baseline", ["pass-baseline"]],
    // no lens at all — never guessed onto one
    ["recheck", []],
    ["review-session", []],
    ["review session", []],
    ["", []],
  ])("%j → %j", (raw, ids) => {
    expect(canonicalLensIds(raw)).toEqual(ids);
  });
});

describe("round_findings keeps the title and the canonical lens ids", () => {
  it("records both, and the boot fills lens_ids for rows recorded before the column", () => {
    const dir = mkdtempSync(join(tmpdir(), "qcr-outcomes-"));
    try {
      const path = join(dir, "state.db");
      const store = new StateStore(path);
      store.recordRoundFindings({ pr: 1, round_id: null, round_no: 1, head_sha: "h" }, [
        {
          key: "F1",
          lens: "pass-baseline + pass-sweep (2 lenses)",
          disposition: "posted",
          title: "Retry loops forever",
        },
        { key: "F2", lens: "recheck", disposition: "posted" },
      ]);
      const rows = store.roundFindings(1);
      expect(rows.map((r) => [r.finding_key, r.title, r.lens_ids])).toEqual([
        ["F1", "Retry loops forever", '["pass-baseline","pass-sweep"]'],
        ["F2", null, "[]"],
      ]);
      // A row from before the column: lens_ids NULL until the next boot.
      store.db.prepare("UPDATE round_findings SET lens_ids = NULL").run();
      store.close();
      const reopened = new StateStore(path);
      expect(reopened.roundFindings(1).map((r) => r.lens_ids)).toEqual([
        '["pass-baseline","pass-sweep"]',
        "[]",
      ]);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------

describe("the linker", () => {
  it("links a marked comment exactly, whatever its path and line say", () => {
    const h = harness();
    const r = h.round(H1, [posted({ key: "F1" }), posted({ key: "F2", line: 50 })]);
    h.capture.observeBotComments(PR, [
      botComment({
        id: 900,
        // a marker wins over a path/line that would point elsewhere
        line: 50,
        original_line: 50,
        body: `[blocker] x\n\nbody\n\n${findingMarker(r, "F1")}`,
      }),
    ]);
    h.capture.linkComments(PR);
    expect(h.capture.commentsFor(PR)).toMatchObject([
      { comment_id: 900, round_no: r, finding_key: "F1", via: "marker", marker_key: "F1" },
    ]);
  });

  it("waits for a marked comment's record rather than guessing, then links it", () => {
    const h = harness();
    // Round 1 holds a posted finding at the very anchor the comment sits on —
    // a fallback would land there. The comment is round 2's, whose record is
    // not parsed yet, and its review id names no round.
    h.round(H1, [posted({ key: "F1" })]);
    h.capture.observeBotComments(PR, [
      botComment({
        id: 901,
        pull_request_review_id: null,
        body: `[blocker] t\n\n${findingMarker(2, "G1")}`,
      }),
    ]);
    h.capture.linkComments(PR);
    expect(h.capture.commentsFor(PR)[0]).toMatchObject({ finding_key: null, via: null });
    h.round(H2, [posted({ key: "G1" })]);
    h.capture.linkComments(PR);
    expect(h.capture.commentsFor(PR)[0]).toMatchObject({
      round_no: 2,
      finding_key: "G1",
      via: "marker",
    });
  });

  it("render off: links by path and line in the round its review id names", () => {
    const h = harness();
    h.round(H1, [posted({ key: "F1" })], { review_id: 7001 });
    h.round(H2, [posted({ key: "F1" })], { review_id: 7002 });
    h.capture.observeBotComments(PR, [botComment({ id: 902, pull_request_review_id: 7002 })]);
    h.capture.linkComments(PR);
    expect(h.capture.commentsFor(PR)[0]).toMatchObject({
      round_no: 2,
      finding_key: "F1",
      via: "path_line",
    });
  });

  it("matches the line the comment was POSTED on, not where the diff has moved it", () => {
    const h = harness();
    h.round(H1, [posted({ key: "F1" })]);
    // GitHub's `line` followed a push five lines down; original_line did not.
    h.capture.observeBotComments(PR, [botComment({ id: 903, line: 47, original_line: 42 })]);
    h.capture.linkComments(PR);
    expect(h.capture.commentsFor(PR)[0]).toMatchObject({ finding_key: "F1", via: "path_line" });
  });

  it("breaks a same-anchor tie by the title line, then by the tag", () => {
    const h = harness();
    h.round(H1, [
      posted({ key: "A", title: "Retry loops forever", posted_as: "blocker" }),
      posted({ key: "B", title: "Name the constant", posted_as: "nit" }),
      posted({ key: "C", title: null, posted_as: "question" }),
    ]);
    h.capture.observeBotComments(PR, [
      botComment({ id: 910, body: "**[nit]** Name the constant.\n\nbody" }),
      botComment({ id: 911, body: "[question] Is this reachable at all?\n\nbody" }),
    ]);
    h.capture.linkComments(PR);
    expect(h.capture.commentsFor(PR).map((c) => [c.comment_id, c.finding_key, c.via])).toEqual([
      [910, "B", "path_line_title"],
      [911, "C", "path_line_tag"],
    ]);
  });

  it("the tag tie-break reads past the [ask your human] prefix to the finding's own tag", () => {
    const h = harness();
    h.round(H1, [
      posted({ key: "A", title: null, posted_as: "blocker" }),
      posted({ key: "B", title: null, posted_as: "question" }),
    ]);
    h.capture.observeBotComments(PR, [
      botComment({ id: 912, body: "[ask your human] [question] Is EU data allowed?\n\nbody" }),
    ]);
    h.capture.linkComments(PR);
    expect(h.capture.commentsFor(PR)[0]).toMatchObject({
      finding_key: "B",
      via: "path_line_tag",
    });
  });

  it("with no review id and no registry entry, the comment's round is the first recorded after it", () => {
    const h = harness();
    h.round(H1, [posted({ key: "F1" })], { review_id: null });
    h.tick();
    const posted2 = new Date(Date.parse(h.at()) + 30_000).toISOString();
    h.round(H2, [posted({ key: "F2" })], { review_id: null }); // recorded after posted2
    h.capture.observeBotComments(PR, [
      botComment({ id: 913, pull_request_review_id: null, created_at: posted2 }),
    ]);
    h.capture.linkComments(PR);
    expect(h.capture.commentsFor(PR)[0]).toMatchObject({
      round_no: 2,
      finding_key: "F2",
      via: "path_line",
    });
  });

  it("a link guessed from a reply's drifted line is re-opened when the bot's own comment says where it was posted", async () => {
    const h = harness({ git: fakeGit({}, { "3f2a9c1": true }) });
    h.round(H1, [
      posted({ key: "F1", line: 10, title: "Retry loops" }),
      posted({ key: "F2", line: 16, title: "Timeout unbounded" }),
    ]);
    h.push(H2);
    h.store.registerBotComment(9001, PR, "review_comment", 1);
    // GitHub's CURRENT line on the reply has drifted onto F2's.
    h.store.recordPrComment({
      pr: PR,
      source: "review_comment",
      comment_id: 9002,
      in_reply_to_id: 9001,
      thread_id: 9001,
      author: "alice",
      author_type: "User",
      path: "workers/ingest.py",
      line: 16,
      body: "Fixed in 3f2a9c1",
      created_at: h.tick(2),
    });
    await h.capture.capturePr(PR);
    expect(h.capture.commentsFor(PR)[0]).toMatchObject({ source: "reply", finding_key: "F2" });
    // The bot's own comment: posted on line 10, F1's title.
    h.capture.observeBotComments(PR, [
      botComment({
        id: 9001,
        body: "[blocker] Retry loops\n\nbody",
        line: 16,
        original_line: 10,
      }),
    ]);
    await h.capture.capturePr(PR);
    expect(h.capture.commentsFor(PR)[0]).toMatchObject({
      source: "github",
      line: 10,
      finding_key: "F1",
      via: "path_line",
    });
    expect(h.capture.outcomesFor(PR).map((o) => [o.finding_key, o.fate, o.comment_id])).toEqual([
      ["F1", "fixed", 9001],
      ["F2", "unknown", null],
    ]);
  });

  it("unchanged facts leave a link alone; a marker link survives a re-read", () => {
    const h = harness();
    const r = h.round(H1, [posted({ key: "F1" })]);
    const marked = botComment({ id: 950, body: `[blocker] t\n\n${findingMarker(r, "F1")}` });
    h.capture.observeBotComments(PR, [marked]);
    h.capture.linkComments(PR);
    const before = h.capture.commentsFor(PR)[0]!;
    expect(h.capture.observeBotComments(PR, [marked])).toBe(0);
    // GitHub's review id arriving later is a fact change — a marker link stands.
    h.capture.observeBotComments(PR, [{ ...marked, pull_request_review_id: 7999 }]);
    expect(h.capture.commentsFor(PR)[0]).toMatchObject({
      finding_key: "F1",
      via: "marker",
      linked_at: before.linked_at,
    });
  });

  it("an unmatched comment stays null — no finding at its anchor, or a tie nothing breaks", () => {
    const h = harness();
    h.round(H1, [
      posted({ key: "A", title: null, posted_as: "blocker" }),
      posted({ key: "B", title: null, posted_as: "blocker" }),
      posted({ key: "Z", path: "other.py", line: 1 }),
    ]);
    h.capture.observeBotComments(PR, [
      botComment({ id: 920, body: "[blocker] Something\n\nbody" }), // two blockers, no titles
      botComment({ id: 921, path: "nowhere.py", line: 3, original_line: 3 }),
    ]);
    const counts = h.capture.linkComments(PR);
    expect(counts).toEqual({ linked: 0, unmatched: 2 });
    expect(h.capture.commentsFor(PR).every((c) => c.finding_key === null)).toBe(true);
  });

  it("a marker displaces a guessed link to the same finding — the guess goes back to unmatched", () => {
    const h = harness();
    const r = h.round(H1, [posted({ key: "F1" })]);
    h.capture.observeBotComments(PR, [botComment({ id: 940, body: "[blocker] t\n\nbody" })]);
    h.capture.linkComments(PR);
    expect(h.capture.commentsFor(PR)[0]).toMatchObject({ finding_key: "F1", via: "path_line" });
    h.capture.observeBotComments(PR, [
      botComment({
        id: 941,
        line: 7,
        original_line: 7,
        body: `[blocker] t\n\n${findingMarker(r, "F1")}`,
      }),
    ]);
    h.capture.linkComments(PR);
    expect(h.capture.commentsFor(PR).map((c) => [c.comment_id, c.finding_key, c.via])).toEqual([
      [940, null, null],
      [941, "F1", "marker"],
    ]);
  });

  it("keeps only the bot's own ROOT comments from a read", () => {
    const h = harness();
    h.round(H1, [posted({ key: "F1" })]);
    const n = h.capture.observeBotComments(PR, [
      botComment({ id: 930 }),
      botComment({ id: 931, in_reply_to_id: 930, body: "the bot's ping-pong reply" }),
      botComment({ id: 932, user: "alice", user_type: "User", body: "a human root" }),
      botComment({ id: 933, user: "dependabot[bot]" }),
    ]);
    expect(n).toBe(1);
    expect(h.capture.commentsFor(PR).map((c) => c.comment_id)).toEqual([930]);
    // the same read again changes nothing
    expect(h.capture.observeBotComments(PR, [botComment({ id: 930 })])).toBe(0);
  });

  it("links from the state database alone: a human reply names its thread, a record its thread_id", () => {
    const h = harness();
    h.round(H1, [
      posted({ key: "F1" }),
      posted({ key: "F2", path: "a.py", line: 5, thread_id: 951 }),
    ]);
    h.store.registerBotComment(950, PR, "review_comment", 1);
    h.store.registerBotComment(951, PR, "review_comment", 1);
    humanReply(h.store, { id: 960, root: 950, body: "why?", at: h.at() });
    // a reply to a HUMAN's comment names no bot thread
    humanReply(h.store, { id: 961, root: 999, body: "+1", at: h.at() });
    h.capture.linkComments(PR);
    expect(
      h.capture.commentsFor(PR).map((c) => [c.comment_id, c.source, c.finding_key, c.via]),
    ).toEqual([
      [950, "reply", "F1", "path_line"],
      [951, "record", "F2", "thread_id"],
    ]);
  });

  it("a comment the registry attributes to a round never links to ANOTHER round's finding", () => {
    // A round-1 comment whose reply has drifted onto a line a later round's
    // finding sits on stays round 1's.
    const h = harness();
    h.round(H1, [posted({ key: "F1", line: 10 })]);
    h.round(H2, [posted({ key: "G1", line: 16 })]);
    h.store.registerBotComment(970, PR, "review_comment", 1);
    h.store.recordPrComment({
      pr: PR,
      source: "review_comment",
      comment_id: 971,
      in_reply_to_id: 970,
      thread_id: 970,
      author: "alice",
      author_type: "User",
      path: "workers/ingest.py",
      line: 16, // GitHub's current line: drifted onto round 2's G1
      body: "why?",
      created_at: h.tick(1),
    });
    expect(h.capture.linkComments(PR)).toEqual({ linked: 0, unmatched: 1 });
    expect(h.capture.commentsFor(PR)[0]).toMatchObject({ comment_id: 970, finding_key: null });
  });

  it("a reply-sourced row carries the registry's posting time, not the record's", () => {
    const h = harness();
    h.round(H1, [posted({ key: "F1" })]);
    h.store.registerBotComment(975, PR, "review_comment", 1);
    const postedAt = h.store.botCommentPostedAt(975);
    expect(postedAt).not.toBeNull();
    humanReply(h.store, { id: 976, root: 975, body: "why?", at: h.tick(1) });
    h.capture.linkComments(PR);
    expect(h.capture.commentsFor(PR)[0]).toMatchObject({
      source: "reply",
      created_at: postedAt,
      finding_key: "F1",
    });
  });

  it("a finding two comments could claim by fallback is neither's, and capture is idempotent", async () => {
    const h = harness();
    h.round(H1, [posted({ key: "F1" })]);
    h.capture.observeBotComments(PR, [botComment({ id: 980 }), botComment({ id: 981 })]);
    expect(h.capture.linkComments(PR)).toEqual({ linked: 0, unmatched: 2 });
    // The order the comments are visited in decides nothing: capture twice,
    // and nothing moves.
    await h.capture.capturePr(PR);
    const first = JSON.stringify([h.capture.commentsFor(PR), h.capture.outcomesFor(PR)]);
    await h.capture.capturePr(PR);
    expect(
      JSON.stringify([h.capture.commentsFor(PR), h.capture.outcomesFor(PR)]).replace(
        /"(linked_at|updated_at|seen_at)":"[^"]*"/g,
        "",
      ),
    ).toBe(first.replace(/"(linked_at|updated_at|seen_at)":"[^"]*"/g, ""));
    // One of them gains a marker: the finding is the marker's, the other
    // stays unmatched.
    h.capture.observeBotComments(PR, [
      botComment({ id: 981, body: `[blocker] t\n\n${findingMarker(1, "F1")}` }),
    ]);
    h.capture.linkComments(PR);
    expect(h.capture.commentsFor(PR).map((c) => [c.comment_id, c.finding_key, c.via])).toEqual([
      [980, null, null],
      [981, "F1", "marker"],
    ]);
  });
});

// ---------------------------------------------------------------------------

describe("the fate table", () => {
  /** One linked, posted finding with a thread (comment 800). */
  function threaded(git?: AnchorGit, state?: "tracked" | "closed") {
    const h = harness({ ...(git ? { git } : {}), ...(state ? { state } : {}) });
    const round = h.round(H1, [posted({ key: "F1" })]);
    h.capture.observeBotComments(PR, [
      botComment({ id: 800, body: `[blocker] t\n\n${findingMarker(round, "F1")}` }),
    ]);
    return h;
  }
  const fate = async (h: ReturnType<typeof harness>) => {
    await h.capture.capturePr(PR);
    return h.capture.outcomesFor(PR).map((o) => [o.finding_key, o.fate, o.basis]);
  };
  const concededAgain = (over: Partial<RoundFindingInput> = {}): RoundFindingInput => ({
    key: "C1",
    path: "workers/ingest.py",
    line: 42,
    lens: "pass-baseline",
    disposition: "conceded",
    raised_in_round: 1,
    ...over,
  });

  it("a sha-cited fix is fixed — even when a later round records it 'conceded'", async () => {
    const h = threaded(fakeGit({}, { "3f2a9c1": true }));
    h.tick();
    humanReply(h.store, { id: 801, root: 800, body: "Fixed in 3f2a9c1, thanks", at: h.tick() });
    h.tick();
    h.round(H2, [concededAgain()]);
    expect(await fate(h)).toEqual([
      ["F1", "fixed", "conceded_after_fix"],
      // (round 2's own entry is a concession, not a posted finding — no fate row)
    ]);
    expect(h.capture.outcomesFor(PR)[0]).toMatchObject({ comment_id: 800, human_replies: 1 });
  });

  it("a cited sha counts only when git says it is a commit made after the review", async () => {
    // "Not a bug: introduced in 3f2a9c1" — the introducing commit is no fix.
    const notAFix = threaded(fakeGit({}, { "3f2a9c1": false }));
    notAFix.push(H2);
    humanReply(notAFix.store, {
      id: 820,
      root: 800,
      body: "Not a bug: deliberately introduced in 3f2a9c1, see the ADR",
      at: notAFix.tick(),
    });
    expect(await fate(notAFix)).toEqual([["F1", "unknown", null]]);

    // A token git cannot check is no evidence — and does not let a resolve
    // with no push read as a refutation either ("nothing was cited" is not
    // known).
    const unchecked = threaded(); // no git at all
    humanReply(unchecked.store, {
      id: 821,
      root: 800,
      body: "Fixed in 3f2a9c1",
      at: unchecked.tick(),
    });
    unchecked.tick();
    resolvedThread(unchecked.store, 800, 821);
    expect(await fate(unchecked)).toEqual([["F1", "unknown", null]]);

    // git present but unable to answer (the commit not fetched yet): still no
    // evidence — and a later concession with the anchor unchanged is no
    // refutation, because "no sha was cited" is not known either.
    const unfetched = threaded(fakeGit({ "workers/ingest.py@a1..b2": false }));
    unfetched.push(H2);
    humanReply(unfetched.store, {
      id: 830,
      root: 800,
      body: "Fixed in 3f2a9c1",
      at: unfetched.tick(),
    });
    unfetched.tick();
    unfetched.round(H2, [concededAgain()]);
    expect(await fate(unfetched)).toEqual([["F1", "unknown", null]]);

    // Never even asked: a UUID's segments and a colour are not candidates.
    const git = fakeGit({}, { "550e8400": true, "1a2b3c4d": true });
    const shaped = threaded(git);
    shaped.push(H2);
    humanReply(shaped.store, {
      id: 822,
      root: 800,
      body: "request 550e8400-e29b-41d4-a716-446655440000 hit it; colour #1a2b3c4d",
      at: shaped.tick(),
    });
    expect(await fate(shaped)).toEqual([["F1", "unknown", null]]);
    expect(git.asked.filter((a) => !a.includes("workers/"))).toEqual([]);
  });

  it("a resolve after a reply cited a fix is fixed — with no push the resolve could be read by", async () => {
    const h = threaded(fakeGit({}, { "3f2a9c1": true }));
    // The PR's head moved (the fix) though no push event was logged.
    h.store.db.prepare("UPDATE pr_state SET head_sha = ? WHERE number = ?").run(H2, PR);
    humanReply(h.store, { id: 823, root: 800, body: "Fixed in 3f2a9c1", at: h.tick() });
    h.tick();
    resolvedThread(h.store, 800, 823);
    expect(await fate(h)).toEqual([["F1", "fixed", "resolved_after_cited_fix"]]);
  });

  it("an argued refutation the session conceded is refuted_conceded", async () => {
    const h = threaded();
    humanReply(h.store, {
      id: 802,
      root: 800,
      body: "The guard timeout predates this PR; the diff changes none of it.",
      at: h.tick(),
    });
    h.tick();
    resolvedThread(h.store, 800, 802, { outcome: "refuted" });
    expect(await fate(h)).toEqual([["F1", "refuted_conceded", "pingpong_outcome"]]);
  });

  it("the decision's own outcome overrides the resolve it made, at the same instant", async () => {
    // A push touched the anchor, so the resolve alone would read `fixed`; the
    // session said the author's argument holds.
    const git = fakeGit({ "workers/ingest.py@a1..b2": true });
    const h = threaded(git);
    h.tick();
    h.push(H2);
    humanReply(h.store, { id: 824, root: 800, body: "This path is unreachable.", at: h.tick() });
    h.tick();
    resolvedThread(h.store, 800, 824, { outcome: "refuted" });
    expect(await fate(h)).toEqual([["F1", "refuted_conceded", "pingpong_outcome"]]);
  });

  it("legacy inference: conceded with the anchored code unchanged and no sha cited is refuted_conceded", async () => {
    const git = fakeGit({ "workers/ingest.py@a1..b2": false });
    const h = threaded(git);
    humanReply(h.store, { id: 803, root: 800, body: "This is intentional.", at: h.tick() });
    h.tick();
    h.round(H2, [concededAgain()]);
    expect(await fate(h)).toEqual([["F1", "refuted_conceded", "conceded_unchanged"]]);
  });

  it("…a later concession after the anchored lines changed is fixed, sha or none", async () => {
    const git = fakeGit({ "workers/ingest.py@a1..b2": true });
    const h = threaded(git);
    humanReply(h.store, { id: 825, root: 800, body: "Done.", at: h.tick() });
    h.tick();
    h.round(H2, [concededAgain()]);
    expect(await fate(h)).toEqual([["F1", "fixed", "conceded_after_fix"]]);
  });

  it("…and when git cannot tell, a bare 'conceded' decides nothing", async () => {
    const h = threaded(); // no git at all
    humanReply(h.store, { id: 804, root: 800, body: "This is intentional.", at: h.tick() });
    h.tick();
    h.round(H2, [concededAgain()]);
    expect(await fate(h)).toEqual([["F1", "unknown", null]]);
  });

  it("a resolve with no push since the review is a conceded refutation", async () => {
    const h = threaded();
    humanReply(h.store, { id: 805, root: 800, body: "Not reachable from here.", at: h.tick() });
    h.tick();
    resolvedThread(h.store, 800, 805);
    expect(await fate(h)).toEqual([["F1", "refuted_conceded", "resolved_no_change"]]);
  });

  it("an inferred refutation the human reply contradicts is unknown, its basis naming the conflict", async () => {
    // Replies like "fair catch", "Updated: the description now says …", or a
    // fix made away from the anchor contradict an inferred refutation.
    const resolved = threaded();
    humanReply(resolved.store, {
      id: 840,
      root: 800,
      body: "This one is a fair catch and I am not going to argue it is wrong. I updated the PR description accordingly.",
      at: resolved.tick(),
    });
    resolved.tick();
    resolvedThread(resolved.store, 800, 840);
    expect(await fate(resolved)).toEqual([["F1", "unknown", "conflict:resolved_no_change"]]);
    expect(resolved.capture.outcomesFor(PR)[0]).toMatchObject({ decided_at: null });
    expect(resolved.capture.outcomesFor(PR)[0]!.evidence).toContain("reply 840 accepts the point");

    const conceded = threaded(fakeGit({ "workers/ingest.py@a1..b2": false }));
    humanReply(conceded.store, {
      id: 841,
      root: 800,
      body: "Made part of this PR: the client now passes timeout=(5, 30).",
      at: conceded.tick(),
    });
    conceded.tick();
    conceded.round(H2, [concededAgain()]);
    expect(await fate(conceded)).toEqual([["F1", "unknown", "conflict:conceded_unchanged"]]);

    // Closed, a conflict still reads unknown — not open_at_close.
    const closed = threaded(undefined, "closed");
    humanReply(closed.store, { id: 842, root: 800, body: "You are right, corrected.", at: closed.tick() });
    closed.tick();
    resolvedThread(closed.store, 800, 842);
    closed.store.logEvent("pr_closed", PR, { merged: true, source: "webhook" });
    expect(await fate(closed)).toEqual([["F1", "unknown", "conflict:resolved_no_change"]]);
  });

  it("concedesPoint: the acceptance lexicon, and the refutations it leaves alone", () => {
    for (const yes of [
      "This one is a fair catch and I am not going to argue it is wrong",
      "Good catch…",
      "Correct, and it was my omission. The description now says plainly",
      "Updated: the description now says 60s lease",
      "You are right, and the PR description overclaimed. I have corrected it.",
      "You're right.",
      "Done",
      "Fixed in 432a199f79",
      "Accepted and documented in the PR",
    ])
      expect(concedesPoint(yes), yes).toBe(true);
    for (const no of [
      "This is intentional.",
      "Not reachable from here.",
      "I disagree.",
      "Out of scope here.",
      "ok",
      "The current behaviour is correct by design.",
      "",
      null,
    ])
      expect(concedesPoint(no), String(no)).toBe(false);
  });

  it("a thread kept open right after a sha-citing reply is no hold: a verified fix stands, an unchecked one is unknown", async () => {
    // 'Fixed in `432a199f79`' followed seconds later by keep_open is not a
    // hold: the sha decides.
    const verified = threaded(fakeGit({}, { "432a199f79": true }));
    verified.push(H2);
    humanReply(verified.store, {
      id: 850,
      root: 800,
      body: "Fixed in `432a199f79`",
      at: verified.tick(),
    });
    verified.tick();
    resolvedThread(verified.store, 800, 850, { resolution: "keep_open" });
    expect(await fate(verified)).toEqual([["F1", "fixed", "sha_cited"]]);

    const unchecked = threaded(); // no git
    humanReply(unchecked.store, {
      id: 851,
      root: 800,
      body: "Fixed in 432a199f79",
      at: unchecked.tick(),
    });
    unchecked.tick();
    resolvedThread(unchecked.store, 800, 851, { resolution: "keep_open" });
    expect(await fate(unchecked)).toEqual([
      ["F1", "unknown", "conflict:kept_open_after_unverified_sha"],
    ]);

    // The human argued on after the fix; the bot held: upheld, as before.
    const argued = threaded(fakeGit({}, { "432a199f79": true }));
    argued.push(H2);
    humanReply(argued.store, { id: 852, root: 800, body: "Fixed in 432a199f79", at: argued.tick() });
    humanReply(argued.store, { id: 853, root: 800, body: "And the rest is fine.", at: argued.tick() });
    argued.tick();
    resolvedThread(argued.store, 800, 853, { resolution: "keep_open" });
    expect(await fate(argued)).toEqual([["F1", "upheld_after_reply", "kept_open"]]);
  });

  it("a later verified fix supersedes an intervening hold — every citation is read, not only the first", async () => {
    const h = threaded(fakeGit({}, { aaaa1111: true, bbbb2222: true }));
    h.push(H2);
    humanReply(h.store, { id: 860, root: 800, body: "Fixed in aaaa1111", at: h.tick() });
    h.tick();
    resolvedThread(h.store, 800, 860, { resolution: "keep_open", outcome: "held" });
    h.tick();
    humanReply(h.store, { id: 861, root: 800, body: "Now fixed in bbbb2222", at: h.tick() });
    expect(await fate(h)).toEqual([["F1", "fixed", "sha_cited"]]);
    expect(h.capture.outcomesFor(PR)[0]!.evidence).toContain("reply 861 cites bbbb2222");
  });

  it("keep_open is judged by the reply it answered (its comment id), never by capture order or another reply's citation", async () => {
    // The argument (870) was captured BEFORE the older fix-citing reply (871)
    // was backfilled; the decision answered 870 — the bot held against it.
    const held = threaded(fakeGit({}, { "432a199f79": true }));
    held.push(H2);
    const early = held.tick();
    const late = held.tick();
    humanReply(held.store, { id: 870, root: 800, body: "I still disagree.", at: late });
    humanReply(held.store, { id: 871, root: 800, body: "Fixed in 432a199f79", at: early });
    held.tick();
    resolvedThread(held.store, 800, 870, { resolution: "keep_open" });
    expect(await fate(held)).toEqual([["F1", "upheld_after_reply", "kept_open"]]);

    // An earlier verified citation, then a reply citing a commit git cannot
    // check, kept open: THAT citation is unchecked — undecided, not fixed.
    const unchecked = threaded(fakeGit({}, { "432a199f79": true }));
    unchecked.push(H2);
    humanReply(unchecked.store, {
      id: 872,
      root: 800,
      body: "Fixed in 432a199f79",
      at: unchecked.tick(),
    });
    humanReply(unchecked.store, {
      id: 873,
      root: 800,
      body: "and the rest in cccc3333",
      at: unchecked.tick(),
    });
    unchecked.tick();
    resolvedThread(unchecked.store, 800, 873, { resolution: "keep_open" });
    expect(await fate(unchecked)).toEqual([
      ["F1", "unknown", "conflict:kept_open_after_unverified_sha"],
    ]);
  });

  it("a resolve after a push that changed the anchored lines is fixed", async () => {
    const git = fakeGit({ "workers/ingest.py@a1..b2": true });
    const h = threaded(git);
    h.tick();
    h.push(H2);
    humanReply(h.store, { id: 806, root: 800, body: "Done.", at: h.tick() });
    h.tick();
    resolvedThread(h.store, 800, 806);
    expect(await fate(h)).toEqual([["F1", "fixed", "resolved_after_push"]]);
  });

  it("a push from before the review was posted is not a fix of it", async () => {
    const git = fakeGit({ "workers/ingest.py@a1..b2": true });
    const h = harness({ git });
    h.push(H2); // 10:00:00 — the comment below is posted at 10:00:30
    const round = h.round(H1, [posted({ key: "F1" })]);
    h.capture.observeBotComments(PR, [
      botComment({ id: 800, body: `[blocker] t\n\n${findingMarker(round, "F1")}` }),
    ]);
    humanReply(h.store, { id: 826, root: 800, body: "Not reachable.", at: h.tick() });
    h.tick();
    resolvedThread(h.store, 800, 826);
    expect(await fate(h)).toEqual([["F1", "refuted_conceded", "resolved_no_change"]]);
  });

  it("a thread a human had already resolved is still the session's resolve", async () => {
    // After a push that touched the anchor: fixed.
    const git = fakeGit({ "workers/ingest.py@a1..b2": true });
    const h = threaded(git);
    h.tick();
    h.push(H2);
    humanReply(h.store, { id: 827, root: 800, body: "Done.", at: h.tick() });
    h.tick();
    resolvedThread(h.store, 800, 827, { skipped: "already-resolved" });
    expect(await fate(h)).toEqual([["F1", "fixed", "resolved_after_push"]]);
    expect(h.capture.outcomesFor(PR)[0]!.evidence).toContain("a human had resolved it first");

    // With no push since the review: the session agreed to resolve an
    // unchanged anchor, exactly as when it clicked itself.
    const k = threaded();
    humanReply(k.store, { id: 828, root: 800, body: "Out of scope here.", at: k.tick() });
    k.tick();
    resolvedThread(k.store, 800, 828, { skipped: "already-resolved" });
    expect(await fate(k)).toEqual([["F1", "refuted_conceded", "resolved_no_change"]]);
  });

  it("a check-this resolve the bot refused is no resolve at all", async () => {
    const h = threaded();
    humanReply(h.store, { id: 807, root: 800, body: "ok", at: h.tick() });
    resolvedThread(h.store, 800, 807, { skipped: "check-this-human-only" });
    expect(await fate(h)).toEqual([["F1", "unknown", null]]);
    const k = threaded();
    humanReply(k.store, { id: 829, root: 800, body: "ok", at: k.tick() });
    resolvedThread(k.store, 800, 829, { skipped: "deferred-human-only" });
    expect(await fate(k)).toEqual([["F1", "unknown", null]]);
  });

  it("gone at the next round with the code at its anchor changed is fixed — unchanged decides nothing", async () => {
    const changed = fakeGit({ "workers/ingest.py@a1..b2": true });
    const h = threaded(changed);
    h.tick();
    h.round(H2, []); // the next round raised nothing like it
    expect(await fate(h)).toEqual([["F1", "fixed", "gone_after_change"]]);

    const same = fakeGit({ "workers/ingest.py@a1..b2": false });
    const k = threaded(same);
    k.tick();
    k.round(H2, []);
    expect(await fate(k)).toEqual([["F1", "unknown", null]]);
  });

  it("a nearby same-lens finding at the next round keeps it from reading 'gone' — and is not carried", async () => {
    const git = fakeGit({ "workers/ingest.py@a1..b2": true });
    const h = threaded(git);
    h.tick();
    // re-raised without raised_in_round, three lines down: weakly the same
    h.round(H2, [posted({ key: "N1", line: 45 })]);
    const out = await fate(h);
    expect(out[0]).toEqual(["F1", "unknown", null]);
    expect(h.capture.outcomesFor(PR)[0]!.carried_to).toBeNull();
  });

  it("a weak next-round concession is no evidence — it may be another finding's", async () => {
    // A different entry (no raised_in_round) conceded six lines away, the
    // anchor unchanged: F1 was never conceded.
    const git = fakeGit({ "workers/ingest.py@a1..b2": false });
    const h = threaded(git);
    h.tick();
    h.round(H2, [concededAgain({ key: "G", line: 48, raised_in_round: null })]);
    expect(await fate(h)).toEqual([["F1", "unknown", null]]);
  });

  it("a human reply the bot held is upheld_after_reply — kept open, or posted again", async () => {
    const h = threaded();
    humanReply(h.store, { id: 808, root: 800, body: "I disagree.", at: h.tick() });
    h.tick();
    resolvedThread(h.store, 800, 808, { resolution: "keep_open" });
    expect(await fate(h)).toEqual([["F1", "upheld_after_reply", "kept_open"]]);

    const k = threaded();
    humanReply(k.store, { id: 809, root: 800, body: "I disagree.", at: k.tick() });
    k.tick();
    k.round(H2, [posted({ key: "R1", raised_in_round: 1 })]);
    const out = await fate(k);
    expect(out[0]).toEqual(["F1", "upheld_after_reply", "reposted_after_reply"]);
    expect(k.capture.outcomesFor(PR)[0]!.carried_to).toBe("2:R1");
  });

  it("posted again with no human reply is carried, not upheld", async () => {
    const h = harness();
    h.round(H1, [posted({ key: "F1" })]);
    h.tick();
    h.round(H2, [posted({ key: "R1", raised_in_round: 1 })]);
    await h.capture.capturePr(PR);
    expect(
      h.capture.outcomesFor(PR).map((o) => [o.finding_key, o.fate, o.basis, o.carried_to]),
    ).toEqual([
      ["F1", "unknown", null, "2:R1"],
      ["R1", "unknown", null, null],
    ]);
  });

  it("the latest decisive evidence wins: held, then fixed by a later push", async () => {
    const git = fakeGit({ "workers/ingest.py@a1..c3": true });
    const h = threaded(git);
    humanReply(h.store, { id: 810, root: 800, body: "No.", at: h.tick() });
    resolvedThread(h.store, 800, 810, { resolution: "keep_open", outcome: "held" });
    h.tick();
    h.round(H3, []); // gone at the next round, and the anchor changed
    expect(await fate(h)).toEqual([["F1", "fixed", "gone_after_change"]]);
  });

  it("a carried finding reads its successor's fate", async () => {
    const git = fakeGit({ "workers/ingest.py@b2..c3": true });
    const h = harness({ git });
    h.round(H1, [posted({ key: "F1" })]);
    h.tick();
    h.round(H2, [posted({ key: "F1b", raised_in_round: 1, line: 43 })]);
    h.tick();
    h.round(H3, []);
    await h.capture.capturePr(PR);
    expect(
      h.capture
        .outcomesFor(PR)
        .map((o) => [o.round_no, o.finding_key, o.fate, o.basis, o.carried_to]),
    ).toEqual([
      [1, "F1", "fixed", "carried:gone_after_change", "2:F1b"],
      [2, "F1b", "fixed", "gone_after_change", null],
    ]);
  });

  it("a later entry is ONE finding's: a sibling's concession or repost is not this one's", async () => {
    const two = [
      posted({ key: "F1", line: 10, title: "Retry loops" }),
      posted({ key: "F2", line: 16, title: "Timeout unbounded" }),
    ];
    // F2 conceded by key, the anchor unchanged: F1 was never conceded.
    const conceded = harness({ git: fakeGit({ "workers/ingest.py@a1..b2": false }) });
    conceded.round(H1, two);
    conceded.tick(5);
    conceded.round(H2, [concededAgain({ key: "F2", line: 16 })]);
    await conceded.capture.capturePr(PR);
    expect(conceded.capture.outcomesFor(PR).map((o) => [o.finding_key, o.fate])).toEqual([
      ["F1", "unknown"],
      ["F2", "refuted_conceded"],
    ]);

    // F2 posted again under a new key, nearest to F2: only F2 carries.
    const reposted = harness({ git: fakeGit({}) });
    reposted.round(H1, two);
    reposted.tick(5);
    reposted.round(H2, [posted({ key: "F2r", line: 15, raised_in_round: 1 })]);
    await reposted.capture.capturePr(PR);
    expect(
      reposted.capture.outcomesFor(PR).map((o) => [o.round_no, o.finding_key, o.carried_to]),
    ).toEqual([
      [1, "F1", null],
      [1, "F2", "2:F2r"],
      [2, "F2r", null],
    ]);

    // Equidistant from both: nobody's.
    const tie = harness({ git: fakeGit({}) });
    tie.round(H1, two);
    tie.tick(5);
    tie.round(H2, [posted({ key: "X", line: 13, raised_in_round: 1 })]);
    await tie.capture.capturePr(PR);
    expect(tie.capture.outcomesFor(PR).map((o) => [o.finding_key, o.carried_to])).toEqual([
      ["F1", null],
      ["F2", null],
      ["X", null],
    ]);
  });

  it("an equal key alone is no match: per-round key numbering is a coincidence, not identity", async () => {
    // r1 f1 at line 233 and r4 f1 at line 968 share a key, not a finding.
    const far = harness({ git: fakeGit({}) });
    far.round(H1, [posted({ key: "f1", line: 233 })]);
    far.tick(5);
    far.round(H2, [posted({ key: "f1", line: 968, raised_in_round: 1 })]);
    await far.capture.capturePr(PR);
    expect(far.capture.outcomesFor(PR).map((o) => [o.round_no, o.carried_to])).toEqual([
      [1, null],
      [2, null],
    ]);
    // Same key, another lens, two lines away: not this finding either.
    const otherLens = harness({ git: fakeGit({}) });
    otherLens.round(H1, [posted({ key: "f1", line: 40 })]);
    otherLens.tick(5);
    otherLens.round(H2, [posted({ key: "f1", line: 42, lens: "pass-security", raised_in_round: 1 })]);
    await otherLens.capture.capturePr(PR);
    expect(otherLens.capture.outcomesFor(PR)[0]!.carried_to).toBeNull();
    // Same key nearby, same lens: carried, as before.
    const near = harness({ git: fakeGit({}) });
    near.round(H1, [posted({ key: "f1", line: 40 })]);
    near.tick(5);
    near.round(H2, [posted({ key: "f1", line: 44, raised_in_round: 1 })]);
    await near.capture.capturePr(PR);
    expect(near.capture.outcomesFor(PR)[0]!.carried_to).toBe("2:f1");
  });

  it("no evidence: open_at_close once the PR closed, unknown while it is open", async () => {
    const h = threaded(undefined, "closed");
    h.store.logEvent("pr_closed", PR, { merged: true, source: "webhook" });
    expect(await fate(h)).toEqual([["F1", "open_at_close", "closed"]]);
    expect(await fate(threaded())).toEqual([["F1", "unknown", null]]);
  });

  it("a PR reopened since its close is open again", async () => {
    const h = threaded();
    h.store.logEvent("pr_closed", PR, { merged: false, source: "webhook" });
    expect(await fate(h)).toEqual([["F1", "unknown", null]]); // the row still says tracked
  });

  it("a fate is rewritten when its evidence changes, and fate_changed_at moves only then", async () => {
    const h = threaded(fakeGit({}, { abc1234: true }));
    await h.capture.capturePr(PR);
    const first = h.capture.outcomesFor(PR)[0]!;
    h.tick(5);
    await h.capture.capturePr(PR);
    expect(h.capture.outcomesFor(PR)[0]!.fate_changed_at).toBe(first.fate_changed_at);
    h.push(H2);
    humanReply(h.store, { id: 811, root: 800, body: "fixed in abc1234", at: h.tick() });
    const r = await h.capture.capturePr(PR);
    expect(r.changed).toBe(1);
    const now = h.capture.outcomesFor(PR)[0]!;
    expect(now.fate).toBe("fixed");
    expect(now.fate_changed_at).not.toBe(first.fate_changed_at);
  });

  it("a finding no longer posted (its round re-recorded) loses its fate row", async () => {
    const h = harness();
    h.round(H1, [posted({ key: "F1" }), posted({ key: "F2", line: 50 })]);
    await h.capture.capturePr(PR);
    expect(h.capture.outcomesFor(PR).map((o) => o.finding_key)).toEqual(["F1", "F2"]);
    const r1 = h.store.roundsFor(PR)[0]!;
    h.store.recordRoundFindings({ pr: PR, round_id: r1.id, round_no: 1, head_sha: H1 }, [
      posted({ key: "F1" }),
      { key: "F2", line: 50, lens: "pass-baseline", disposition: "killed", word: "duplicate" },
    ]);
    await h.capture.capturePr(PR);
    expect(h.capture.outcomesFor(PR).map((o) => o.finding_key)).toEqual(["F1"]);
  });

  it("only POSTED findings get a fate", async () => {
    const h = harness();
    h.round(H1, [
      posted({ key: "P" }),
      { key: "K", lens: "pass-ui", disposition: "killed", word: "below-bar" },
      { key: "D", lens: "pass-ui", disposition: "doubted", word: "refuted" },
      { key: "W", lens: "pass-ui", disposition: "withheld", word: "nits-off" },
    ]);
    await h.capture.capturePr(PR);
    expect(h.capture.outcomesFor(PR).map((o) => o.finding_key)).toEqual(["P"]);
  });
});

// ---------------------------------------------------------------------------

describe("whole-review signals are recorded per review, never smeared over findings", () => {
  it("a set-aside joins its round through gh_review_id; a merge over a block names the round that stood", async () => {
    const h = harness();
    h.round(H1, [posted({ key: "F1" })], { review_id: 7101, verdict: "REQUEST_CHANGES" });
    h.round(H2, [posted({ key: "G1", path: "b.py", line: 1 })], {
      review_id: 7102,
      verdict: "REQUEST_CHANGES",
    });
    h.tick();
    h.store.recordFeedbackSignalRow({
      kind: "review_set_aside",
      pr: PR,
      review_id: 7101,
      author: "pmercier",
      day: "2026-10-01",
    });
    h.store.recordFeedbackSignalRow({ kind: "merged_over_block", pr: PR, day: "2026-10-01" });
    // an unknown review id stays unattributed rather than guessed
    h.store.recordFeedbackSignalRow({
      kind: "review_set_aside",
      pr: PR,
      review_id: 9999,
      author: "x",
      day: "2026-10-01",
    });
    await h.capture.capturePr(PR);
    expect(
      h.capture.reviewOutcomesFor(PR).map((r) => [r.kind, r.round_no, r.gh_review_id]),
    ).toEqual([
      ["set_aside", 1, 7101],
      ["merged_over_block", 2, 7102],
      ["set_aside", null, 9999],
    ]);
    // The set-aside review's findings carry NO fate from it.
    expect(h.capture.outcomesFor(PR).map((o) => [o.finding_key, o.fate])).toEqual([
      ["F1", "unknown"],
      ["G1", "unknown"],
    ]);
  });

  it("a merge after an APPROVE is not attributed to any block", async () => {
    const h = harness();
    h.round(H1, [posted({ key: "F1" })], { verdict: "REQUEST_CHANGES" });
    h.round(H2, [], { verdict: "APPROVE" });
    h.tick();
    h.store.recordFeedbackSignalRow({ kind: "merged_over_block", pr: PR, day: "2026-10-01" });
    await h.capture.capturePr(PR);
    expect(h.capture.reviewOutcomesFor(PR).map((r) => [r.kind, r.round_no])).toEqual([
      ["merged_over_block", null],
    ]);
  });
});

// ---------------------------------------------------------------------------

describe("the bounded pass", () => {
  it("yields a real event-loop turn per PR it considers", async () => {
    // With no git (or every git answer memoised) a capture never awaits real
    // I/O, so without a yield per PR a pass would block the loop throughout.
    const h = harness();
    for (let i = 1; i <= 15; i++)
      h.store.upsertPr({
        number: PR + i,
        state: "tracked",
        head_sha: H1,
        title: `PR ${PR + i}`,
        author: "alice",
        trigger_ts: null,
        stale_recheck: 0,
        migration_gate: 0,
      });
    let turns = 0;
    let on = true;
    const tick = (): void => {
      turns++;
      if (on) setImmediate(tick);
    };
    setImmediate(tick);
    const r = await h.capture.sweep();
    on = false;
    expect(r).toMatchObject({ considered: 16, captured: 16, errors: [] });
    expect(turns).toBeGreaterThanOrEqual(16);
  });

  it("captures, then skips a PR whose inputs have not moved, and recaptures when one does", async () => {
    const h = harness();
    h.round(H1, [posted({ key: "F1" })]);
    const first = await h.capture.sweep();
    expect(first).toMatchObject({ captured: 1, skipped: 0, errors: [] });
    const second = await h.capture.sweep();
    expect(second).toMatchObject({ captured: 0, skipped: 1 });
    humanReply(h.store, { id: 1, root: 2, body: "hm", at: h.tick() });
    expect(await h.capture.sweep()).toMatchObject({ captured: 1 });
  });

  it("an unmoved PR is still re-captured once its capture is older than the recapture period", async () => {
    const h = harness();
    h.round(H1, [posted({ key: "F1" })]);
    expect(await h.capture.sweep()).toMatchObject({ captured: 1 });
    const mark = () =>
      h.store.db.prepare("SELECT signature FROM outcome_capture_marks WHERE pr = ?").get(PR) as {
        signature: string;
      };
    const sig = mark().signature;
    h.tick(OUTCOME_RECAPTURE_MS / 60_000 - 1);
    expect(await h.capture.sweep()).toMatchObject({ captured: 0, skipped: 1 });
    h.tick(1);
    expect(await h.capture.sweep()).toMatchObject({ captured: 1, skipped: 0 });
    expect(mark().signature).toBe(sig); // nothing moved — the period alone brought it back
  });

  it("an input that lands while a capture awaits git is not folded into its mark", async () => {
    let landed = false;
    const h = harness({
      git: {
        async anchorTouched() {
          await new Promise((r) => setTimeout(r, 5));
          if (!landed) {
            landed = true; // a push arrives mid-capture
            h.store.logEvent("head_push", PR, { head_sha: H3, source: "webhook" });
          }
          return null;
        },
        async introducedBetween() {
          return null;
        },
      },
    });
    h.round(H1, [posted({ key: "F1" })]);
    h.tick();
    h.round(H2, [
      {
        key: "C1",
        path: "workers/ingest.py",
        line: 42,
        lens: "pass-baseline",
        disposition: "conceded",
        raised_in_round: 1,
      },
    ]);
    expect(await h.capture.sweep()).toMatchObject({ captured: 1 });
    expect(landed).toBe(true);
    // The push was not read by that capture: the next pass captures again.
    expect(await h.capture.sweep()).toMatchObject({ captured: 1, skipped: 0 });
    expect(await h.capture.sweep()).toMatchObject({ captured: 0, skipped: 1 });
  });

  it("never throws: a failing PR is named and the pass goes on", async () => {
    const git: AnchorGit = {
      async anchorTouched() {
        throw new Error("git exploded");
      },
      async introducedBetween() {
        throw new Error("git exploded");
      },
    };
    const h = harness({ git });
    h.round(H1, [posted({ key: "F1" })]);
    h.tick();
    h.round(H2, []);
    // a git throw is an unknown answer, not a failed capture
    const r = await h.capture.sweep();
    expect(r.errors).toEqual([]);
    expect(h.capture.outcomesFor(PR)[0]!.fate).toBe("unknown");
  });

  it("stops starting PRs once its wall-time budget is spent — the pump waits behind it", async () => {
    const h = harness();
    for (let n = 1; n <= 3; n++)
      h.store.upsertPr({
        number: n,
        state: "tracked",
        head_sha: "h",
        title: "t",
        author: "a",
        trigger_ts: null,
        stale_recheck: 0,
        migration_gate: 0,
      });
    // A spent budget still finishes the PR it started, and starts no other.
    expect(await h.capture.sweep({ budgetMs: -1 })).toMatchObject({ captured: 1 });
    expect(await h.capture.sweep({ budgetMs: -1 })).toMatchObject({ captured: 1 });
  });

  it("leaves long-closed PRs alone and caps the PRs per pass", async () => {
    const h = harness();
    for (let n = 1; n <= 4; n++)
      h.store.upsertPr({
        number: n,
        state: "tracked",
        head_sha: "h",
        title: "t",
        author: "a",
        trigger_ts: null,
        stale_recheck: 0,
        migration_gate: 0,
      });
    // #4 closed two days ago: its fates were settled when it closed.
    h.store.db
      .prepare("UPDATE pr_state SET state = 'closed', updated_at = ? WHERE number = 4")
      .run("2026-09-29T10:00:00.000Z");
    // #3 closed an hour ago: still inside the window.
    h.store.db
      .prepare("UPDATE pr_state SET state = 'closed', updated_at = ? WHERE number = 3")
      .run("2026-10-01T09:00:00.000Z");
    const r = await h.capture.sweep({ maxPrs: 2 });
    expect(r.captured).toBe(2);
    const r2 = await h.capture.sweep({ maxPrs: 2 });
    expect(r2.captured).toBe(2); // the two not yet captured come first
    const marked = (
      h.store.db.prepare("SELECT pr FROM outcome_capture_marks ORDER BY pr").all() as Array<{
        pr: number;
      }>
    ).map((m) => m.pr);
    expect(marked).toEqual([1, 2, 3, PR]);
  });
});

describe("the reading helpers", () => {
  it("citedSha wants a hex run with a digit and a letter, standing alone", () => {
    expect(citedSha("Fixed in 3f2a9c1.")).toBe("3f2a9c1");
    expect(
      citedSha("see https://github.com/o/r/commit/0123456789abcdef0123456789abcdef01234567"),
    ).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(citedSha("defaced effaced 1234567 abcdefa")).toBeNull();
    expect(citedSha("a hash #ff00aa colour")).toBeNull();
    // never a colour or a UUID's segments — candidates only, git decides
    expect(citedSha("color is #1a2b3c4d")).toBeNull();
    expect(
      citedSha("The request id 550e8400-e29b-41d4-a716-446655440000 in the log proves it"),
    ).toBeNull();
    expect(citedShas("Fixed in 3f2a9c1 and 3F2A9C1, then a4b5c6d")).toEqual(["3f2a9c1", "a4b5c6d"]);
  });
  it("commentHead reads the closed tag grammar and the title", () => {
    expect(commentHead("**[check this]** Confirm the cron.\n\nbody")).toEqual({
      tags: ["check this"],
      title: "Confirm the cron.",
    });
    expect(commentHead("[ask your human] [question] Is EU data allowed?")).toEqual({
      tags: ["ask your human", "question"],
      title: "Is EU data allowed?",
    });
  });
  it("decideFate prefers the latest, then fixed over refuted over upheld", () => {
    expect(
      decideFate([
        { fate: "upheld_after_reply", at: 1 },
        { fate: "refuted_conceded", at: 2 },
        { fate: "fixed", at: 2 },
      ]),
    ).toEqual({ fate: "fixed", at: 2 });
    expect(decideFate([])).toBeNull();
  });
});

describe("`qcr outcomes` flags", () => {
  it("defaults to a 30-day read-only table", () => {
    expect(parseOutcomesArgs([])).toEqual({ days: 30, capture: false, readGithub: false });
    expect(parseOutcomesArgs(["--days", "60", "--capture", "--read-github"])).toEqual({
      days: 60,
      capture: true,
      readGithub: true,
    });
  });
  it("refuses an unknown token, a bad day count, and a read without a capture", () => {
    expect(() => parseOutcomesArgs(["--captrue"])).toThrow(OUTCOMES_USAGE);
    expect(() => parseOutcomesArgs(["--days", "0"])).toThrow(OUTCOMES_USAGE);
    expect(() => parseOutcomesArgs(["--days"])).toThrow(OUTCOMES_USAGE);
    expect(() => parseOutcomesArgs(["--read-github"])).toThrow(/needs --capture/);
  });
});

describe("the operator's table (`qcr outcomes`)", () => {
  it("counts per lens id, links, replied threads, and reviews per review", async () => {
    const h = harness({ git: fakeGit({}, { "3f2a9c1": true }) });
    const r = h.round(H1, [
      posted({ key: "F1", lens: "pass-baseline + pass-sweep (2 lenses)" }),
      posted({ key: "F2", lens: "recheck", path: "z.py", line: 1 }),
    ]);
    h.capture.observeBotComments(PR, [
      botComment({ id: 700, body: `[blocker] t\n\n${findingMarker(r, "F1")}` }),
    ]);
    h.push(H2);
    humanReply(h.store, { id: 701, root: 700, body: "Fixed in 3f2a9c1", at: h.tick() });
    h.store.recordFeedbackSignalRow({
      kind: "review_set_aside",
      pr: PR,
      review_id: 7001,
      author: "p",
      day: "d",
    });
    await h.capture.capturePr(PR);
    const s = h.capture.summary("2026-09-01T00:00:00.000Z");
    expect(s.total).toMatchObject({ posted: 2, linked: 1, fixed: 1, unknown: 1, uncaptured: 0 });
    expect(s.lenses.map((l) => [l.lens, l.posted, l.fixed])).toEqual([
      ["(no lens)", 1, 0],
      ["pass-baseline", 1, 1],
      ["pass-sweep", 1, 1],
    ]);
    expect([s.replied_threads, s.replied_known]).toEqual([1, 1]);
    expect(s.reviews).toEqual({ set_aside: 1 });
    const text = renderOutcomeSummary(s);
    expect(text).toContain("linked to their comment: 1/2 (50%)");
    expect(text).toContain("set aside 1, merged over a block 0");
  });
});

// ---------------------------------------------------------------------------

function ref(number: number): PrRef {
  return {
    number,
    title: "t",
    author: "alice",
    head_sha: H1,
    base_ref: "master",
    updated_at: "2026-10-01T10:30:00Z",
    state: "open",
    draft: false,
    merged: false,
    labels: [],
  };
}

class SweepGitHub implements ReconcileAdapter {
  open: PrRef[] = [];
  inline = new Map<number, ReviewCommentFull[]>();
  reads: string[] = [];
  async searchLabelTriggered() {
    return [];
  }
  async searchTeamTriggered() {
    return [];
  }
  async listOpenPrs() {
    return this.open;
  }
  async getPr(n: number) {
    return this.open.find((p) => p.number === n)!;
  }
  async listBotReviewComments() {
    return [];
  }
  async getRequestedReviewers() {
    return { users: [], teams: [] };
  }
  async listReviewCommentsFull(n: number) {
    this.reads.push(`inline:${n}`);
    return this.inline.get(n) ?? [];
  }
  async listIssueComments(n: number) {
    this.reads.push(`issue:${n}`);
    return [];
  }
  async listReviewsFull(n: number) {
    this.reads.push(`reviews:${n}`);
    return [];
  }
}

const hooks = (): SessionHooks =>
  ({
    ensureSession: async () => {},
    sendRoundOrder: async () => {},
    archiveAndClose: async () => {},
  }) as unknown as SessionHooks;

describe("the reconcile pass carries it", () => {
  it("links from the comment sweep's own read — one read per source, no extra call — and records fates", async () => {
    const h = harness({ git: fakeGit({}, { "3f2a9c1": true }) });
    const r = h.round(H1, [posted({ key: "F1" })]);
    // The fix's push (event only: GitHub still reports H1 below, and the
    // reconcile must not see a head to correct).
    h.store.logEvent("head_push", PR, { head_sha: H2, source: "webhook" });
    const gh = new SweepGitHub();
    gh.open = [ref(PR)];
    gh.inline.set(PR, [
      botComment({ id: 600, body: `[blocker] t\n\n${findingMarker(r, "F1")}` }),
      {
        ...botComment({ id: 601 }),
        user: "alice",
        user_type: "User",
        in_reply_to_id: 600,
        body: "Fixed in 3f2a9c1",
      },
    ]);
    const report = await reconcileOnce({
      cfg,
      store: h.store,
      adapter: gh,
      hooks: hooks(),
      outcomes: h.capture,
    });
    expect(gh.reads.filter((x) => x === `inline:${PR}`)).toHaveLength(1);
    expect(report.errors).toEqual([]);
    expect(report.outcomes).toMatchObject({ captured: 1, errors: [] });
    expect(h.capture.commentsFor(PR)).toMatchObject([{ comment_id: 600, via: "marker" }]);
    expect(h.capture.outcomesFor(PR)).toMatchObject([
      { finding_key: "F1", fate: "fixed", basis: "sha_cited" },
    ]);
  });

  it("a failing outcome capture never becomes a reconcile error", async () => {
    const h = harness();
    const gh = new SweepGitHub();
    gh.open = [ref(PR)];
    gh.inline.set(PR, [botComment({ id: 602 })]);
    const report = await reconcileOnce({
      cfg,
      store: h.store,
      adapter: gh,
      hooks: hooks(),
      outcomes: {
        observeBotComments: () => {
          throw new Error("boom");
        },
        sweep: async () => {
          throw new Error("boom");
        },
      },
    });
    expect(report.errors).toEqual([]);
    expect(report.outcomes).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe("the production wiring carries it", () => {
  it("createDaemon's reconcile links from the sweep's read and decides fates with the git it was handed", async () => {
    const root = mkdtempSync(join(tmpdir(), "qcr-outcomes-daemon-"));
    try {
      for (const d of ["state", "state/dryrun", "verdict", "inject"])
        mkdirSync(join(root, d), { recursive: true });
      const h = harness();
      const r = h.round(H1, [posted({ key: "F1" })]);
      h.tick();
      h.round(H2, []); // gone at the next round — fixed only if git says the anchor changed
      const git = fakeGit({ "workers/ingest.py@a1..b2": true });
      const adapter = {
        searchLabelTriggered: async () => [],
        searchTeamTriggered: async () => [],
        searchAwaitingEscalationReviewer: async () => [],
        listOpenPrs: async () => [ref(PR)],
        getPr: async () => ref(PR),
        stalenessScan: async () => [],
        listBotReviewComments: async () => [],
        getRequestedReviewers: async () => ({ users: [], teams: [] }),
        listReviewCommentsFull: async () => [
          botComment({ id: 640, body: `[blocker] t\n\n${findingMarker(r, "F1")}` }),
        ],
        listIssueComments: async () => [],
        listReviewsFull: async () => [],
      } as unknown as DaemonAdapter;
      const daemon = createDaemon({
        cfg: { ...cfg, dry_run: true },
        root,
        store: h.store,
        adapter,
        listen: false,
        log: () => {},
        outcomeGit: git,
      });
      await daemon.reconcile();
      expect(
        h.store.db
          .prepare("SELECT comment_id, round_no, finding_key, via FROM finding_comments")
          .all(),
      ).toEqual([{ comment_id: 640, round_no: 1, finding_key: "F1", via: "marker" }]);
      expect(
        h.store.db.prepare("SELECT finding_key, fate, basis FROM finding_outcomes").all(),
      ).toEqual([{ finding_key: "F1", fate: "fixed", basis: "gone_after_change" }]);
      expect(git.asked).toContain("workers/ingest.py@a1..b2");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("wire.ts hands the daemon the worktree manager as the outcome capture's git", () => {
    const wire = readFileSync(join(process.cwd(), "src", "wire.ts"), "utf8");
    expect(wire).toMatch(/\boutcomeGit:\s*sessions\.worktrees\b/);
  });
});

describe("`qcr outcomes --capture [--read-github]`", () => {
  it("reads through a gate that can only record — even the class a dry-run gate executes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qcr-outcomes-gate-"));
    const quiet = vi.spyOn(console, "log").mockImplementation(() => {}); // the gate's loud line
    try {
      const gate = recordOnlyGate(join(dir, "dryrun"));
      expect(gate.isDryRun).toBe(true);
      const recorded = await gate.execute({
        kind: "add_label",
        method: "POST",
        path: "/repos/o/r/issues/7/labels",
        body: { labels: ["x"] },
        note: "add label x to #7",
        pr: 7,
      });
      expect(recorded.executed).toBe(false);
      expect(readdirSync(join(dir, "dryrun"))).toHaveLength(1);
      // APP_SELF_CONFIG_KINDS run even in dry-run — the executor refuses them.
      await expect(
        gate.execute({
          kind: "update_own_webhook_url",
          method: "PATCH",
          path: "/app/hook/config",
          body: { url: "https://x.trycloudflare.com/webhook" },
          note: "re-point own App webhook URL",
        }),
      ).rejects.toThrow(/^qcr outcomes performs no mutations$/);
      // Every other read-only command names itself in the refusal.
      await expect(
        recordOnlyGate(join(dir, "dryrun"), "qcr history").execute({
          kind: "update_own_webhook_url",
          method: "PATCH",
          path: "/app/hook/config",
          body: { url: "https://x.trycloudflare.com/webhook" },
          note: "re-point own App webhook URL",
        }),
      ).rejects.toThrow(/^qcr history performs no mutations$/);
    } finally {
      quiet.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("captures exactly the PRs with a posted finding in the window, one comment read each", async () => {
    const h = harness();
    h.round(H1, [posted({ key: "F1" })]); // PR 5100, in the window
    const other = (pr: number, findings: RoundFindingInput[]) =>
      h.store.recordRoundFindings({ pr, round_id: null, round_no: 1, head_sha: H1 }, findings);
    other(6001, [{ key: "K", lens: "pass-ui", disposition: "killed", word: "below-bar" }]);
    other(6002, [posted({ key: "G1" })]);
    const since = h.tick(); // 6001's and 5100's findings are before; 6002's after
    other(6003, [posted({ key: "H1" })]);
    h.store.db
      .prepare("UPDATE round_findings SET recorded_at = ? WHERE pr = 6002")
      .run("2026-09-01T00:00:00.000Z");
    h.store.db.prepare("UPDATE round_findings SET recorded_at = ? WHERE pr = ?").run(since, PR);
    const reads: number[] = [];
    const lines: string[] = [];
    const captured = await captureOutcomesWindow({
      store: h.store,
      outcomes: h.capture,
      since,
      read: {
        async listReviewCommentsFull(pr: number) {
          reads.push(pr);
          if (pr === 6003) throw new Error("rate limited");
          return [botComment({ id: 660, body: `[blocker] t\n\n${findingMarker(1, "F1")}` })];
        },
      },
      write: (l) => lines.push(l),
    });
    expect(captured).toEqual([PR, 6003]);
    expect(reads).toEqual([PR, 6003]);
    expect(h.capture.commentsFor(PR)).toMatchObject([{ comment_id: 660, via: "marker" }]);
    // a failed read is reported, and the PR is still captured from the database
    expect(lines.some((l) => l.includes("#6003: could not read its comments"))).toBe(true);
    expect(h.capture.outcomesFor(6003).map((o) => o.finding_key)).toEqual(["H1"]);
  });
});

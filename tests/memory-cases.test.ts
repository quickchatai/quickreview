// knowledge into the engine: finding CASES.
//
// The slice's contract, one block per acceptance criterion:
//
//   * ONE case document per posted finding that drew a human response or
//     reached a fate — and none for a finding with neither; one per FINDING,
//     so a finding posted again in a later round is one case, at its first
//     posting.
//   * Into reviewer memory's `cases/`, through the one memory seam
//     (`MemoryStore.putDocuments` → the real `OpenVikingStore` over a fake
//     0.4.15 server): a deterministic name, created under `create_if_absent`
//     and replaced only under `replace_if_hash` of the bytes this writer last
//     wrote, ONE batch-write per root.
//   * The header: PR, round(s), lens ids, kind, severity, path and line
//     range, fate, dates, thread URL — header-only, so quoted text mints
//     nothing. The body: the finding's claim and the human replies quoted as
//     fenced DATA, attributed by role (the PR's author / another reviewer),
//     never by name.
//   * A case is rewritten when its fate changes; one that no longer stands is
//     WITHDRAWN (a `#retired` stub under its hash), never deleted; an entry
//     this writer did not write is never overwritten.
//   * `[feedback]` comments land in `events/` with their full text.
//   * The backfill: the last 60 days, from state.db plus ONE adapter read per
//     PR, resumable across a restart, rate-limited, and — like every write —
//     gated on memory health reading healthy.
//   * Not in the round's search scope (S9): cases are never searched by a
//     round and never listed by the store's whole-tree sweep.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CASE_LIMITS,
  CaseWriter,
  PROBE_EXPECT,
  REACHED_FATES,
  caseName,
  classifyFound,
  prCases,
  renderCase,
  roleOf,
  withdrawalStub,
  withoutMentions,
} from "../src/cases.js";
import { parseConfig, MEMORY_DEFAULTS, type Config } from "../src/config.js";
import {
  FEEDBACK_FULL_TEXT_LABEL,
  memoryEntryFor,
  memoryEntryForRow,
  type FeedbackEvent,
} from "../src/feedback.js";
import { findingMarker } from "../src/findingkey.js";
import type { ReviewCommentFull } from "../src/github.js";
import { cleanQuotedText, fenceAsData, readFencedData } from "../src/memory/datafence.js";
import { parseEventTags, parseHashTags } from "../src/memory/eventtags.js";
import {
  CASES_AREA,
  MEMORY_LAYOUT_NOTE,
  ROUND_SEARCH_AREAS,
  SWEEP_EXCLUDED_AREAS,
} from "../src/memory/layout.js";
import type { DocumentPut, DocumentPutResult } from "../src/memory/store.js";
import { inRoundSearchScope } from "../src/openviking/context.js";
import { sha256Prefixed } from "../src/openviking/store.js";
import { OutcomeCapture, inCaptureWindow } from "../src/outcomes.js";
import { StateStore, type RoundFindingInput } from "../src/state.js";
import { OV_ROOT, OvServer, ovStore } from "./helpers/ov-server.js";

const cfg: Config = parseConfig(
  readFileSync(resolve(process.cwd(), "tests/fixtures/config.toml"), "utf8"),
);
const BOT = cfg.github.bot_login;
const REPO = "example-org/example-app";
const PR = 5100;
const H1 = "a1".repeat(20);
const H2 = "b2".repeat(20);
const CASES = `${OV_ROOT}/${CASES_AREA}`;

// ---- a state database with posted findings ----------------------------------

function harness(opts: { pr?: number; author?: string; state?: "tracked" | "closed" } = {}) {
  let now = new Date("2026-10-01T10:00:00.000Z");
  const clock = () => now;
  const store = new StateStore(":memory:", clock);
  const pr = opts.pr ?? PR;
  const capture = new OutcomeCapture({ store, botLogin: BOT, now: clock });
  const h = {
    store,
    capture,
    clock,
    at: () => now.toISOString(),
    tick(min = 1): string {
      now = new Date(now.getTime() + min * 60_000);
      return now.toISOString();
    },
    setNow(iso: string): void {
      now = new Date(iso);
    },
    addPr(n: number, author = "alice", state: "tracked" | "closed" = "tracked"): void {
      store.upsertPr({
        number: n,
        state,
        head_sha: H1,
        title: "Retry the ingest worker",
        author,
        trigger_ts: null,
        stale_recheck: 0,
        migration_gate: 0,
      });
    },
    /** One finished round with a posted review and a parsed record. */
    round(head: string, findings: RoundFindingInput[], n = pr): number {
      const id = store.startRound(n, "first", ["pass-baseline"], 60);
      const no = store.roundsFor(n).find((r) => r.id === id)!.round_no;
      store.db
        .prepare(
          "UPDATE rounds SET status='done', verdict='REQUEST_CHANGES', finished_at=?, gh_review_id=?, gh_commit_id=? WHERE id=?",
        )
        .run(now.toISOString(), 7000 + n * 10 + no, head, id);
      now = new Date(now.getTime() + 60_000);
      store.recordRoundFindings({ pr: n, round_id: id, round_no: no, head_sha: head }, findings);
      store.logEvent("findings_recorded", n, { round_no: no, entries: findings.length });
      return no;
    },
    /** The bot's own inline comment carrying finding `key` of round `round`. */
    botComment(over: Partial<ReviewCommentFull> & { id: number; round: number; key: string }) {
      const { round, key, ...rest } = over;
      return {
        user: BOT,
        user_type: "Bot",
        body: `[blocker] t\n\nbody\n\n${findingMarker(round, key)}`,
        path: "workers/ingest.py",
        line: 42,
        original_line: 42,
        pull_request_review_id: null,
        in_reply_to_id: null,
        created_at: "2026-10-01T10:00:30.000Z",
        ...rest,
      } satisfies ReviewCommentFull;
    },
    reply(o: { id: number; root: number; body: string; author: string; at: string; n?: number }) {
      store.recordPrComment({
        pr: o.n ?? pr,
        source: "review_comment",
        comment_id: o.id,
        in_reply_to_id: o.root,
        thread_id: o.root,
        author: o.author,
        author_type: "User",
        tagged: /^\s*\[feedback\]/i.test(o.body),
        path: "workers/ingest.py",
        line: 42,
        body: o.body,
        created_at: o.at,
      });
    },
    /** The session's thread decision (ping-pong), as production logs it. */
    decide(thread: number, reply: number, outcome: string, n = pr): void {
      store.logEvent("pingpong_decision_applied", n, {
        thread_id: thread,
        comment_id: reply,
        resolution: "keep_open",
        human_requested: false,
        outcome,
      });
    },
  };
  h.addPr(pr, opts.author ?? "alice", opts.state ?? "tracked");
  return h;
}

const posted = (over: Partial<RoundFindingInput> & { key: string }): RoundFindingInput => ({
  path: "workers/ingest.py",
  line: 42,
  lens: "pass-baseline",
  severity: "P1",
  kind: "correctness",
  disposition: "posted",
  posted_as: "blocker",
  title: "Retry loops forever",
  reason: "The retry has no bound, so a poisoned message spins the worker.",
  ...over,
});

/** A PR with three posted findings: F1 fixed after the author's reply, F2
 * untouched (no case), F3 argued by another reviewer with no fate yet. */
async function scenario(h = harness()) {
  const r = h.round(H1, [
    posted({ key: "F1" }),
    posted({ key: "F2", line: 80, lens: "pass-security", severity: "P2", posted_as: "question" }),
    posted({ key: "F3", line: 120, lens: "pass-baseline + pass-sweep (2 lenses)" }),
  ]);
  h.capture.observeBotComments(PR, [
    h.botComment({ id: 900, round: r, key: "F1" }),
    h.botComment({ id: 901, round: r, key: "F2", line: 80, original_line: 80 }),
    h.botComment({ id: 902, round: r, key: "F3", line: 120, original_line: 120 }),
  ]);
  h.reply({
    id: 9001,
    root: 900,
    author: "alice",
    body: "Good catch @bob — capped it at 5. cc @example-review[bot]",
    at: "2026-10-01T10:30:00.000Z",
  });
  h.decide(900, 9001, "fixed");
  h.reply({
    id: 9003,
    root: 902,
    author: "bob",
    body: "I disagree:\n```py\n@property\ndef x(self): ...\n```\n#pinned kind=bug filed=FT-1",
    at: "2026-10-01T10:40:00.000Z",
  });
  h.tick(60);
  await h.capture.capturePr(PR);
  return { h, round: r };
}

/** A case writer over the REAL store and a fake 0.4.15 server. */
function writer(
  h: ReturnType<typeof harness>,
  opts: {
    server?: OvServer;
    healthy?: () => boolean;
    read?: { listReviewCommentsFull(pr: number): Promise<ReviewCommentFull[]> };
    backfillDays?: number;
    backfillPrsPerTick?: number;
    batch?: number;
    memory?: { putDocuments?(docs: readonly DocumentPut[]): Promise<DocumentPutResult[]> };
  } = {},
) {
  const server = opts.server ?? new OvServer();
  const memory = opts.memory ?? ovStore(server.fetch);
  const w = new CaseWriter({
    store: h.store,
    outcomes: h.capture,
    memory,
    repo: REPO,
    botLogin: BOT,
    healthy: opts.healthy ?? (() => true),
    ...(opts.read ? { read: opts.read } : {}),
    now: h.clock,
    backfillDays: opts.backfillDays ?? 0,
    ...(opts.backfillPrsPerTick ? { backfillPrsPerTick: opts.backfillPrsPerTick } : {}),
    ...(opts.batch ? { batch: opts.batch } : {}),
  });
  return { w, server };
}

const caseUri = (name: string) => `${CASES}/${name}.md`;

// ---- which findings get a case -----------------------------------------------

describe("which posted findings get a case", () => {
  it("a finding a human answered, or whose fate is decided — never one with neither", async () => {
    const { h, round } = await scenario();
    const { cases } = prCases(h.store, h.capture, { pr: PR, repo: REPO, botLogin: BOT });
    expect(cases.map((c) => c.name)).toEqual([
      caseName(PR, round, "F1"),
      caseName(PR, round, "F3"),
    ]);
    expect(cases.map((c) => c.fate)).toEqual(["fixed", "unknown"]);
    // F2: posted, unanswered, no fate — no case.
    expect(h.capture.outcomesFor(PR).find((o) => o.finding_key === "F2")?.fate).toBe("unknown");
  });

  it("a decided fate alone is enough (no reply): fixed by the session's own judgement", async () => {
    const h = harness();
    const r = h.round(H1, [posted({ key: "F1" })]);
    h.capture.observeBotComments(PR, [h.botComment({ id: 900, round: r, key: "F1" })]);
    // The session's thread decision says `fixed`; no human reply is on
    // record (the reply it answered was never captured).
    h.decide(900, 1, "fixed");
    await h.capture.capturePr(PR);
    const { cases } = prCases(h.store, h.capture, { pr: PR, repo: REPO, botLogin: BOT });
    expect(cases).toHaveLength(1);
    expect(cases[0]!.replies).toEqual([]);
    expect(cases[0]!.fate).toBe("fixed");
  });

  it("open at close is a reached fate: a case even with no human response — and a deleted bot comment is a response", async () => {
    const h = harness({ state: "closed" });
    const r = h.round(H1, [posted({ key: "F1" }), posted({ key: "F2", line: 80 })]);
    h.capture.observeBotComments(PR, [
      h.botComment({ id: 900, round: r, key: "F1" }),
      h.botComment({ id: 901, round: r, key: "F2", line: 80, original_line: 80 }),
    ]);
    h.store.recordFeedbackSignalRow({
      kind: "bot_comment_deleted",
      pr: PR,
      comment_id: 901,
      day: "2026-10-01",
    });
    await h.capture.capturePr(PR);
    expect(h.capture.outcomesFor(PR).map((o) => o.fate)).toEqual([
      "open_at_close",
      "open_at_close",
    ]);
    const { cases } = prCases(h.store, h.capture, { pr: PR, repo: REPO, botLogin: BOT });
    expect(cases.map((c) => c.name)).toEqual([caseName(PR, r, "F1"), caseName(PR, r, "F2")]);
    const [f1, f2] = cases.map(renderCase) as [string, string];
    // "Ignored, then merged" is what became of F1 — the learner's evidence.
    expect(parseEventTags(f1)).toMatchObject({ fate: "open_at_close", replies: "0" });
    expect(f1).toContain("Fate: OPEN AT CLOSE");
    expect(f1).not.toMatch(/deleted the bot comment/);
    expect(f2).toMatch(/A human deleted the bot comment that carried this finding in round 1/);
    // Only `unknown` — the PR still open — leaves a silent finding without one.
    expect(REACHED_FATES).toEqual([
      "fixed",
      "refuted_conceded",
      "upheld_after_reply",
      "open_at_close",
    ]);
  });

  it("a finding posted again is ONE case, at its first posting, quoting both threads", async () => {
    const h = harness();
    const r1 = h.round(H1, [posted({ key: "F1" })]);
    h.capture.observeBotComments(PR, [h.botComment({ id: 900, round: r1, key: "F1" })]);
    h.reply({ id: 9001, root: 900, author: "carol", body: "Not reachable.", at: h.tick(5) });
    h.tick(30);
    const r2 = h.round(H2, [posted({ key: "F1", line: 44, raised_in_round: r1 })]);
    h.capture.observeBotComments(PR, [
      h.botComment({ id: 950, round: r2, key: "F1", line: 44, original_line: 44 }),
    ]);
    h.reply({ id: 9501, root: 950, author: "alice", body: "Fixed now.", at: h.tick(5) });
    h.decide(950, 9501, "fixed");
    await h.capture.capturePr(PR);
    const { cases, caseOf } = prCases(h.store, h.capture, { pr: PR, repo: REPO, botLogin: BOT });
    expect(cases).toHaveLength(1);
    const c = cases[0]!;
    expect(c.name).toBe(caseName(PR, r1, "F1"));
    expect(c.members.map((m) => m.row.round_no)).toEqual([r1, r2]);
    expect(c.replies.map((x) => x.comment_id)).toEqual([9001, 9501]);
    expect(c.fate).toBe("fixed");
    expect(caseOf.get(`${r2}\u0000F1`)).toBe(c.name);
    const tags = parseEventTags(renderCase(c));
    expect(tags).toMatchObject({ round: String(r1), rounds: `${r1},${r2}`, lines: "42-44" });
  });
});

// ---- the document ----------------------------------------------------------------

describe("the case document", () => {
  it("its header carries PR, round, lens ids, kind, severity, path, lines, fate, dates and the thread URL", async () => {
    const { h, round } = await scenario();
    const { cases } = prCases(h.store, h.capture, { pr: PR, repo: REPO, botLogin: BOT });
    const doc = renderCase(cases[0]!);
    expect(parseHashTags(doc)).toEqual(["case"]);
    const tags = parseEventTags(doc);
    expect(tags).toEqual({
      kind: "case",
      case: caseName(PR, round, "F1").slice("case-".length),
      pr: String(PR),
      round: String(round),
      rounds: String(round),
      lens: "pass-baseline",
      finding_kind: "correctness",
      severity: "P1",
      posted_as: "blocker",
      path: "workers/ingest.py",
      lines: "42",
      fate: "fixed",
      basis: "pingpong_outcome",
      posted: "2026-10-01T10:00:30Z",
      decided: expect.stringMatching(/^2026-10-01T\d\d:\d\d:\d\dZ$/),
      replies: "1",
      thread: `https://github.com/${REPO}/pull/${PR}#discussion_r900`,
    });
    // A composite lens spelling becomes its canonical ids.
    expect(parseEventTags(renderCase(cases[1]!))["lens"]).toBe("pass-baseline,pass-sweep");
  });

  it("quotes the claim and every reply as fenced data, by role and never by name", async () => {
    const { h } = await scenario();
    const { cases } = prCases(h.store, h.capture, { pr: PR, repo: REPO, botLogin: BOT });
    const [f1, f3] = cases.map(renderCase) as [string, string];
    expect(f1).toContain("The PR's author, 2026-10-01T10:30:00Z, in the round 1 thread:");
    expect(f3).toContain("Another reviewer, 2026-10-01T10:40:00Z, in the round 1 thread:");
    // The claim, fenced.
    expect(f1).toContain(
      fenceAsData(
        "Retry loops forever\n\nThe retry has no bound, so a poisoned message spins the worker.",
      ),
    );
    // No login anywhere — not as attribution, not as a mention inside a quote.
    for (const doc of [f1, f3]) {
      expect(doc).not.toMatch(/\balice\b|\bbob\b|example-review/);
    }
    expect(f1).toContain("Good catch @<reviewer> — capped it at 5. cc @<bot>");
    // A decorator inside quoted code is not a mention: left alone.
    expect(f3).toContain("@property");
  });

  it("nothing a human wrote can close the fence or mint a header tag", async () => {
    const { h } = await scenario();
    const { cases } = prCases(h.store, h.capture, { pr: PR, repo: REPO, botLogin: BOT });
    const doc = renderCase(cases[1]!);
    // The reply carries a ``` block: the fence around it is longer.
    expect(doc).toContain("````text\nI disagree:\n```py");
    expect(readFencedData(doc, "Another reviewer")).toContain("#pinned kind=bug filed=FT-1");
    // `#pinned kind=bug` in the reply mints nothing.
    expect(parseHashTags(doc)).toEqual(["case"]);
    expect(parseEventTags(doc)["kind"]).toBe("case");
    expect(parseEventTags(doc)).not.toHaveProperty("filed");
  });

  it("a row recorded before S6 (no title) takes the posted comment's first line as its title", async () => {
    const h = harness();
    const r = h.round(H1, [posted({ key: "F1", title: null })]);
    h.capture.observeBotComments(PR, [
      h.botComment({
        id: 900,
        round: r,
        key: "F1",
        body: `**[blocker]** Unbounded retry\n\nbody\n\n${findingMarker(r, "F1")}`,
      }),
    ]);
    h.reply({ id: 9001, root: 900, author: "alice", body: "ok", at: h.tick(1) });
    await h.capture.capturePr(PR);
    const doc = renderCase(
      prCases(h.store, h.capture, { pr: PR, repo: REPO, botLogin: BOT }).cases[0]!,
    );
    expect(doc).toContain(
      fenceAsData(
        "[blocker] Unbounded retry\n\nThe retry has no bound, so a poisoned message spins the worker.",
      ),
    );
  });

  it("is a pure render: the same facts give the same bytes", async () => {
    const { h } = await scenario();
    const a = prCases(h.store, h.capture, { pr: PR, repo: REPO, botLogin: BOT }).cases.map(
      renderCase,
    );
    h.tick(600);
    await h.capture.capturePr(PR);
    const b = prCases(h.store, h.capture, { pr: PR, repo: REPO, botLogin: BOT }).cases.map(
      renderCase,
    );
    expect(b).toEqual(a);
  });

  it("long replies are capped and many replies counted — with the omission stated", async () => {
    const h = harness();
    const r = h.round(H1, [posted({ key: "F1" })]);
    h.capture.observeBotComments(PR, [h.botComment({ id: 900, round: r, key: "F1" })]);
    for (let i = 0; i < CASE_LIMITS.replies + 3; i++)
      h.reply({
        id: 9000 + i,
        root: 900,
        author: i % 2 ? "alice" : "dave",
        body: i === 0 ? "x".repeat(CASE_LIMITS.replyChars + 50) : `reply ${i}`,
        at: h.tick(1),
      });
    await h.capture.capturePr(PR);
    const doc = renderCase(
      prCases(h.store, h.capture, { pr: PR, repo: REPO, botLogin: BOT }).cases[0]!,
    );
    expect(doc).toContain("… (50 more characters not quoted)");
    expect(doc).toContain("(3 later replies not quoted.)");
    expect(parseEventTags(doc)["replies"]).toBe(String(CASE_LIMITS.replies + 3));
  });

  it("whole-review signals ride their own section, never the finding's fate", async () => {
    const h = harness();
    const r = h.round(H1, [posted({ key: "F1" })]);
    h.capture.observeBotComments(PR, [h.botComment({ id: 900, round: r, key: "F1" })]);
    h.reply({ id: 9001, root: 900, author: "alice", body: "meh", at: h.tick(1) });
    h.store.recordFeedbackSignalRow({
      kind: "review_set_aside",
      pr: PR,
      review_id: 7000 + PR * 10 + r,
      day: "2026-10-01",
    });
    await h.capture.capturePr(PR);
    const c = prCases(h.store, h.capture, { pr: PR, repo: REPO, botLogin: BOT }).cases[0]!;
    expect(c.fate).toBe("unknown");
    const doc = renderCase(c);
    expect(doc).toMatch(
      /## Review-level signals — about the whole review, never evidence about this finding alone\n- Round 1's review was set aside by a human/,
    );
    expect(parseEventTags(doc)["fate"]).toBe("unknown");
  });

  it("attribution is by role: the PR's author, another reviewer, or unknown when the PR's author is", () => {
    expect(roleOf("Alice", "alice")).toBe("author");
    expect(roleOf("bob", "alice")).toBe("reviewer");
    expect(roleOf("bob", null)).toBe("unknown");
    const logins = new Map([
      ["alice", "author"],
      ["bob", "reviewer"],
      ["example-review", "bot"],
    ]);
    expect(
      withoutMentions("@alice @Bob @example-review[bot] @property a@bob.com `@bob`", logins),
    ).toBe("@<author> @<reviewer> @<bot> @property a@bob.com `@bob`");
  });

  it("fenceAsData always outlasts the text it fences", () => {
    for (const text of ["plain", "```\nx\n```", "a ````` b", "\r\nline\u0007\n"]) {
      const f = fenceAsData(text);
      expect(readFencedData(`L:\n${f}`, "L:")).toBe(cleanQuotedText(text));
    }
    expect(fenceAsData("x")).toBe("```text\nx\n```");
    // Control bytes and carriage returns never survive into memory.
    expect(fenceAsData("a\u001b[31mb\r\nc\u0007")).toBe("```text\na[31mb\nc\n```");
  });

  it("a reply carrying a terminal escape renders into its case with no control byte", async () => {
    const h = harness();
    const r = h.round(H1, [posted({ key: "F1" })]);
    h.capture.observeBotComments(PR, [h.botComment({ id: 900, round: r, key: "F1" })]);
    h.reply({
      id: 9001,
      root: 900,
      author: "alice",
      body: "fine \u001b]0;pwned\u0007 by me\r\nsecond \u009b2J line",
      at: h.tick(1),
    });
    await h.capture.capturePr(PR);
    const doc = renderCase(
      prCases(h.store, h.capture, { pr: PR, repo: REPO, botLogin: BOT }).cases[0]!,
    );
    expect(doc).toContain("fine ]0;pwned by me\nsecond 2J line");
    expect(doc).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
  });
});

// ---- writing through the seam ------------------------------------------------------

describe("writing cases through the seam", () => {
  it("ONE batch-write under cases/: every case created under create_if_absent, at its deterministic name", async () => {
    const { h, round } = await scenario();
    const server = new OvServer();
    server.dirs.add(CASES);
    const { w } = writer(h, { server });
    const t = await w.tick();
    expect(t).toMatchObject({ synced: 1, attempted: 2, written: 2, held: false, owed: 0 });
    const batches = server.batches();
    expect(batches).toHaveLength(1);
    expect(batches[0]!.root).toBe(CASES);
    expect(batches[0]!.ops.map((o) => [o.uri, o.precondition.kind]).sort()).toEqual(
      [
        [caseUri(caseName(PR, round, "F1")), "create_if_absent"],
        [caseUri(caseName(PR, round, "F3")), "create_if_absent"],
      ].sort(),
    );
    const stored = server.files.get(caseUri(caseName(PR, round, "F1")))!;
    expect(parseEventTags(stored)["fate"]).toBe("fixed");
    const ledger = Object.fromEntries(
      w.casesFor(PR).map((c) => [c.finding_key, [c.state, c.stored_hash]]),
    );
    expect(ledger).toEqual({
      F1: ["written", sha256Prefixed(stored)],
      F3: ["written", sha256Prefixed(server.files.get(caseUri(caseName(PR, round, "F3")))!)],
    });
    // Nothing moved: nothing re-rendered, nothing written.
    expect(await w.tick()).toMatchObject({ synced: 0, attempted: 0 });
    h.tick(10);
    await h.capture.capturePr(PR);
    expect(await w.tick()).toMatchObject({ synced: 1, attempted: 0 });
    expect(server.batches()).toHaveLength(1);
  });

  it("on a fresh server the first write makes the cases/ area, once, and lands", async () => {
    const { h } = await scenario();
    const { w, server } = writer(h);
    expect(await w.tick()).toMatchObject({ written: 2 });
    expect(
      server.calls.filter((c) => c.path === "/api/v1/fs/mkdir").map((c) => c.body?.["uri"]),
    ).toEqual([CASES]);
    // The 404 that made it, then the batch that landed — the same one batch.
    expect(server.batches().map((b) => [b.root, b.ops.length])).toEqual([
      [CASES, 2],
      [CASES, 2],
    ]);
  });

  it("a fate change rewrites the case under the hash of the bytes this writer last wrote", async () => {
    const { h, round } = await scenario();
    const { w, server } = writer(h);
    await w.tick();
    const uri = caseUri(caseName(PR, round, "F3"));
    const before = server.files.get(uri)!;
    expect(parseEventTags(before)["fate"]).toBe("unknown");
    h.decide(902, 9003, "refuted");
    h.tick(5);
    await h.capture.capturePr(PR);
    // Owed again, and status.json says since when — before anything is written.
    expect(w.status().oldest_owed_at).toBeNull();
    expect(w.syncCaptured()).toBe(1);
    expect(w.status()).toMatchObject({ owed: 1, oldest_owed_at: h.at() });
    expect(await w.tick()).toMatchObject({ attempted: 1, written: 1 });
    const last = server.batches().at(-1)!;
    expect(last.root).toBe(CASES);
    expect(last.ops).toEqual([
      {
        uri,
        content: server.files.get(uri),
        precondition: { kind: "replace_if_hash", base_hash: sha256Prefixed(before) },
      },
    ]);
    expect(parseEventTags(server.files.get(uri)!)["fate"]).toBe("refuted_conceded");
  });

  it("a case that no longer stands is WITHDRAWN under its hash — never deleted", async () => {
    const { h, round } = await scenario();
    const { w, server } = writer(h);
    await w.tick();
    const uri = caseUri(caseName(PR, round, "F1"));
    const before = server.files.get(uri)!;
    // The round's record is re-written: F1 is no longer a posted finding.
    h.store.recordRoundFindings({ pr: PR, round_id: null, round_no: round, head_sha: H1 }, [
      posted({ key: "F1", disposition: "killed" }),
    ]);
    h.tick(5);
    await h.capture.capturePr(PR);
    expect(await w.tick()).toMatchObject({ attempted: 1, withdrawn: 1 });
    const stub = server.files.get(uri)!;
    expect(stub).toBe(
      withdrawalStub(
        { name: caseName(PR, round, "F1"), pr: PR, round_no: round, finding_key: "F1" },
        null,
      ),
    );
    expect(parseHashTags(stub)).toEqual(["retired", "case"]);
    expect(server.batches().at(-1)!.ops[0]!.precondition).toEqual({
      kind: "replace_if_hash",
      base_hash: sha256Prefixed(before),
    });
    expect(w.casesFor(PR).find((c) => c.finding_key === "F1")?.state).toBe("withdrawn");
    // No delete route was ever asked for.
    expect(server.calls.some((c) => /delete|rm/i.test(c.path))).toBe(false);
  });

  it("a posting that joins an earlier posting's chain gives up its own case, pointing at the chain's", async () => {
    const h = harness();
    const r1 = h.round(H1, [posted({ key: "F1" })]);
    h.capture.observeBotComments(PR, [h.botComment({ id: 900, round: r1, key: "F1" })]);
    h.tick(30);
    // Round 2 posts it again, but nothing yet proves it is F1 (no
    // raised_in_round): its own case.
    const r2 = h.round(H2, [posted({ key: "G1", line: 44 })]);
    h.capture.observeBotComments(PR, [
      h.botComment({ id: 950, round: r2, key: "G1", line: 44, original_line: 44 }),
    ]);
    h.reply({ id: 9501, root: 950, author: "alice", body: "Fixed.", at: h.tick(5) });
    h.decide(950, 9501, "fixed");
    await h.capture.capturePr(PR);
    const { w, server } = writer(h);
    await w.tick();
    const own = caseName(PR, r2, "G1");
    expect(server.files.has(caseUri(own))).toBe(true);
    // The record is re-written: G1 names F1's round — the same finding.
    h.store.recordRoundFindings({ pr: PR, round_id: null, round_no: r2, head_sha: H2 }, [
      posted({ key: "G1", line: 44, raised_in_round: r1 }),
    ]);
    h.tick(5);
    await h.capture.capturePr(PR);
    await w.tick();
    const root = caseName(PR, r1, "F1");
    expect(parseEventTags(server.files.get(caseUri(root))!)).toMatchObject({
      rounds: `${r1},${r2}`,
      fate: "fixed",
    });
    expect(server.files.get(caseUri(own))).toContain(`the case for it is cases/${root}.md`);
    expect(parseHashTags(server.files.get(caseUri(own))!)).toContain("retired");
  });

  it("an entry this writer did not write is NEVER overwritten: the case is blocked", async () => {
    const { h, round } = await scenario();
    const server = new OvServer();
    const foreign = "#lesson somebody else's note at this address\n";
    server.dirs.add(CASES);
    server.files.set(caseUri(caseName(PR, round, "F1")), foreign);
    const { w } = writer(h, { server });
    const t = await w.tick();
    // The batch was refused on F1's precondition; F3 went through in the retry.
    expect(t).toMatchObject({ written: 1, conflicts: 1, blocked: 1 });
    expect(server.files.get(caseUri(caseName(PR, round, "F1")))).toBe(foreign);
    expect(server.files.has(caseUri(caseName(PR, round, "F3")))).toBe(true);
    const blocked = w.casesFor(PR).find((c) => c.finding_key === "F1")!;
    expect(blocked.state).toBe("blocked");
    expect(blocked.last_error).toMatch(/never overwritten/);
    // Nothing is retried while its facts stand still.
    expect(await w.tick()).toMatchObject({ attempted: 0 });
    expect(server.files.get(caseUri(caseName(PR, round, "F1")))).toBe(foreign);
  });

  it("a case somebody RETIRED stays retired; this writer's own earlier bytes are adopted and replaced", async () => {
    const { h, round } = await scenario();
    const server = new OvServer();
    server.dirs.add(CASES);
    const name1 = caseName(PR, round, "F1");
    const name3 = caseName(PR, round, "F3");
    const { cases } = prCases(h.store, h.capture, { pr: PR, repo: REPO, botLogin: BOT });
    // F1: our case, retired by the operator (the TUI's retire prepends the tag).
    server.files.set(caseUri(name1), `#retired ${renderCase(cases[0]!)}`);
    // F3: our case as an older render left it (the ledger never heard).
    server.files.set(caseUri(name3), renderCase({ ...cases[1]!, fate: "upheld_after_reply" }));
    expect(classifyFound(server.files.get(caseUri(name1))!, name1)).toBe("retired");
    expect(classifyFound(server.files.get(caseUri(name3))!, name3)).toBe("ours");
    const { w } = writer(h, { server });
    expect(await w.tick()).toMatchObject({ conflicts: 2, blocked: 1, written: 0 });
    expect(await w.tick()).toMatchObject({ attempted: 1, written: 1 });
    expect(server.files.get(caseUri(name3))).toBe(renderCase(cases[1]!));
    expect(server.files.get(caseUri(name1))!.startsWith("#retired ")).toBe(true);
  });

  it("a write whose answer was lost is read back, and a landed one counts as written", async () => {
    const { h, round } = await scenario();
    const server = new OvServer();
    server.dirs.add(CASES);
    let lost = 0;
    const fetch: typeof server.fetch = async (url, init) => {
      if (url.includes("/content/batch-write") && lost === 0) {
        lost++;
        await server.fetch(url, init);
        const e = new Error("The operation was aborted due to timeout");
        e.name = "TimeoutError";
        throw e;
      }
      return server.fetch(url, init);
    };
    const { w } = writer(h, { server, memory: ovStore(fetch) });
    expect(await w.tick()).toMatchObject({ attempted: 2, written: 2, failed: 0 });
    expect(w.casesFor(PR).map((c) => c.state)).toEqual(["written", "written"]);
    expect(server.files.has(caseUri(caseName(PR, round, "F1")))).toBe(true);
  });

  it("memory refusing a case counts an attempt, keeps it owed, and gives up only at the cap", async () => {
    const { h } = await scenario();
    let n = 0;
    const memory = {
      async putDocuments(docs: readonly DocumentPut[]): Promise<DocumentPutResult[]> {
        n++;
        return docs.map((d) => ({ area: d.area, name: d.name, state: "failed", message: "busy" }));
      },
    };
    const w = new CaseWriter({
      store: h.store,
      outcomes: h.capture,
      memory,
      repo: REPO,
      botLogin: BOT,
      healthy: () => true,
      now: h.clock,
      backfillDays: 0,
      maxAttempts: 2,
    });
    expect(await w.tick()).toMatchObject({ failed: 2, owed: 2 });
    expect(await w.tick()).toMatchObject({ failed: 2, owed: 0 });
    expect(w.casesFor(PR).map((c) => c.state)).toEqual(["failed", "failed"]);
    expect(w.status()).toMatchObject({ failed: 2, owed: 0 });
    expect(n).toBe(2);
  });

  it("writes NOTHING while memory health is not healthy — but the ledger still says what is owed", async () => {
    const { h } = await scenario();
    let healthy = false;
    const { w, server } = writer(h, { healthy: () => healthy });
    expect(await w.tick()).toMatchObject({ synced: 1, held: true, attempted: 0, owed: 2 });
    expect(server.batches()).toHaveLength(0);
    expect(w.status()).toMatchObject({ owed: 2, written: 0 });
    healthy = true;
    expect(await w.tick()).toMatchObject({ held: false, written: 2, owed: 0 });
  });

  it("a store that cannot hold documents writes nothing, and says so once", async () => {
    const { h } = await scenario();
    const log: string[] = [];
    const w = new CaseWriter({
      store: h.store,
      outcomes: h.capture,
      memory: {},
      repo: REPO,
      botLogin: BOT,
      healthy: () => true,
      now: h.clock,
      backfillDays: 0,
      log: (m) => log.push(m),
    });
    await w.tick();
    await w.tick();
    expect(log.filter((l) => /cannot hold documents/.test(l))).toHaveLength(1);
    expect(w.status().owed).toBe(2);
  });

  it("a case given up on goes back in the queue daily — never every tick", async () => {
    const { h } = await scenario();
    const server = new OvServer();
    const real = ovStore(server.fetch);
    let failing = true;
    const memory = {
      async putDocuments(docs: readonly DocumentPut[]): Promise<DocumentPutResult[]> {
        if (!failing) return real.putDocuments(docs);
        return docs.map((d) => ({ area: d.area, name: d.name, state: "failed", message: "busy" }));
      },
    };
    const w = new CaseWriter({
      store: h.store,
      outcomes: h.capture,
      memory,
      repo: REPO,
      botLogin: BOT,
      healthy: () => true,
      now: h.clock,
      backfillDays: 0,
      maxAttempts: 1,
    });
    expect(await w.tick()).toMatchObject({ failed: 2, owed: 0 });
    expect(w.status()).toMatchObject({ failed: 2, owed: 0 });
    h.tick(60);
    expect(await w.tick()).toMatchObject({ attempted: 0 });
    failing = false;
    h.tick(60);
    expect(await w.tick()).toMatchObject({ attempted: 0 });
    h.tick(24 * 60);
    expect(await w.tick()).toMatchObject({ attempted: 2, written: 2, failed: 0 });
    expect(w.status()).toMatchObject({ failed: 0, written: 2 });
  });

  it("a restart re-queues the cases given up on at its first healthy tick", async () => {
    const { h } = await scenario();
    const failing = {
      async putDocuments(docs: readonly DocumentPut[]): Promise<DocumentPutResult[]> {
        return docs.map((d) => ({ area: d.area, name: d.name, state: "failed", message: "busy" }));
      },
    };
    const mk = (memory: typeof failing | ReturnType<typeof ovStore>) =>
      new CaseWriter({
        store: h.store,
        outcomes: h.capture,
        memory,
        repo: REPO,
        botLogin: BOT,
        healthy: () => true,
        now: h.clock,
        backfillDays: 0,
        maxAttempts: 1,
      });
    expect(await mk(failing).tick()).toMatchObject({ failed: 2 });
    const server = new OvServer();
    expect(await mk(ovStore(server.fetch)).tick()).toMatchObject({ written: 2, failed: 0 });
  });

  it("a case owed but never SENT is forgotten when it stops standing — no stub where nothing was written", async () => {
    const { h, round } = await scenario();
    let healthy = false;
    const { w, server } = writer(h, { healthy: () => healthy });
    expect(await w.tick()).toMatchObject({ held: true, owed: 2 });
    h.store.recordRoundFindings({ pr: PR, round_id: null, round_no: round, head_sha: H1 }, [
      posted({ key: "F1", disposition: "killed" }),
      posted({ key: "F3", line: 120, disposition: "killed" }),
    ]);
    h.tick(5);
    await h.capture.capturePr(PR);
    healthy = true;
    expect(await w.tick()).toMatchObject({ attempted: 0, owed: 0 });
    expect(server.batches()).toHaveLength(0);
    expect(w.casesFor(PR)).toEqual([]);
  });

  it("a create whose answer was lost, then no longer standing, is withdrawn: a PROBE finds it and the stub replaces it", async () => {
    const { h, round } = await scenario();
    const server = new OvServer();
    const real = ovStore(server.fetch);
    let lie = true;
    const sent: DocumentPut[][] = [];
    const memory = {
      async putDocuments(docs: readonly DocumentPut[]): Promise<DocumentPutResult[]> {
        sent.push([...docs]);
        const r = await real.putDocuments(docs);
        if (!lie) return r;
        // It landed; the answer did not (the writer's own deadline says the same).
        return docs.map((d) => ({
          area: d.area,
          name: d.name,
          state: "failed",
          message: "case write timed out after 60000ms",
        }));
      },
    };
    const w = new CaseWriter({
      store: h.store,
      outcomes: h.capture,
      memory,
      repo: REPO,
      botLogin: BOT,
      healthy: () => true,
      now: h.clock,
      backfillDays: 0,
    });
    expect(await w.tick()).toMatchObject({ failed: 2 });
    const f1 = caseName(PR, round, "F1");
    expect(server.files.has(caseUri(f1))).toBe(true);
    expect(w.casesFor(PR).map((c) => [c.stored_hash, c.maybe_stored])).toEqual([
      [null, 1],
      [null, 1],
    ]);
    lie = false;
    h.store.recordRoundFindings({ pr: PR, round_id: null, round_no: round, head_sha: H1 }, [
      posted({ key: "F1", disposition: "killed" }),
    ]);
    h.tick(5);
    await h.capture.capturePr(PR);
    // The withdrawal goes out as a probe — never a create, never forgotten.
    expect(await w.tick()).toMatchObject({ conflicts: 1, withdrawn: 0 });
    expect(sent.at(-1)!.find((d) => d.name === f1)!.expect).toBe(PROBE_EXPECT);
    expect(await w.tick()).toMatchObject({ withdrawn: 1 });
    expect(server.files.get(caseUri(f1))).toBe(
      withdrawalStub({ name: f1, pr: PR, round_no: round, finding_key: "F1" }, null),
    );
    expect(w.casesFor(PR).find((c) => c.finding_key === "F1")).toMatchObject({
      state: "withdrawn",
      maybe_stored: 0,
    });
  });

  it("a create that never landed, then no longer standing: the probe finds nothing and creates nothing", async () => {
    const { h, round } = await scenario();
    const server = new OvServer();
    server.dirs.add(CASES);
    const real = ovStore(server.fetch);
    let refuse = true;
    const memory = {
      async putDocuments(docs: readonly DocumentPut[]): Promise<DocumentPutResult[]> {
        if (!refuse) return real.putDocuments(docs);
        return docs.map((d) => ({
          area: d.area,
          name: d.name,
          state: "failed",
          message: "memory write failed: HTTP 503 — and it could not be read back",
        }));
      },
    };
    const w = new CaseWriter({
      store: h.store,
      outcomes: h.capture,
      memory,
      repo: REPO,
      botLogin: BOT,
      healthy: () => true,
      now: h.clock,
      backfillDays: 0,
    });
    expect(await w.tick()).toMatchObject({ failed: 2 });
    refuse = false;
    h.store.recordRoundFindings({ pr: PR, round_id: null, round_no: round, head_sha: H1 }, [
      posted({ key: "F1", disposition: "killed" }),
    ]);
    h.tick(5);
    await h.capture.capturePr(PR);
    expect(await w.tick()).toMatchObject({ written: 1, withdrawn: 1, conflicts: 1 });
    const f1 = caseName(PR, round, "F1");
    expect(server.files.has(caseUri(f1))).toBe(false);
    expect(
      server
        .batches()
        .flatMap((b) => b.ops)
        .filter((o) => o.uri === caseUri(f1))
        .map((o) => o.precondition),
    ).toEqual([{ kind: "replace_if_hash", base_hash: PROBE_EXPECT }]);
    expect(w.casesFor(PR).find((c) => c.finding_key === "F1")?.state).toBe("withdrawn");
  });

  it("a posting the outcome capture has not reached yet waits for it — the PR's other cases still sync and write", async () => {
    const { h } = await scenario();
    // A later round's record lands; no capture has run since.
    h.round(H2, [posted({ key: "N1", line: 7 })]);
    const { w } = writer(h);
    expect(await w.tick()).toMatchObject({ synced: 1, written: 2 });
    expect(
      w
        .casesFor(PR)
        .map((c) => c.finding_key)
        .sort(),
    ).toEqual(["F1", "F3"]);
  });

  it("this writer's own WITHDRAWAL stub at a standing case's address is adopted and replaced", async () => {
    const { h, round } = await scenario();
    const server = new OvServer();
    server.dirs.add(CASES);
    const name1 = caseName(PR, round, "F1");
    const stub = withdrawalStub({ name: name1, pr: PR, round_no: round, finding_key: "F1" }, null);
    server.files.set(caseUri(name1), stub);
    expect(classifyFound(stub, name1)).toBe("our-withdrawal");
    const { w } = writer(h, { server });
    expect(await w.tick()).toMatchObject({ conflicts: 1, blocked: 0, written: 1 });
    expect(await w.tick()).toMatchObject({ attempted: 1, written: 1 });
    expect(w.casesFor(PR).find((c) => c.finding_key === "F1")?.state).toBe("written");
    expect(parseHashTags(server.files.get(caseUri(name1))!)).toEqual(["case"]);
  });

  it("a document carrying the case's own header is this writer's, WHATEVER its body says: adopted and replaced", async () => {
    const { h, round } = await scenario();
    const server = new OvServer();
    server.dirs.add(CASES);
    const name3 = caseName(PR, round, "F3");
    const edited = `#case kind=case case=${name3.slice("case-".length)} pr=${PR}\nEdited by hand.\n`;
    server.files.set(caseUri(name3), edited);
    expect(classifyFound(edited, name3)).toBe("ours");
    // The same body under another case's id, or with no #case tag, is not.
    expect(classifyFound(edited, caseName(PR, round, "F1"))).toBe("foreign");
    expect(classifyFound(edited.replace("#case ", ""), name3)).toBe("foreign");
    const { w } = writer(h, { server });
    await w.tick();
    await w.tick();
    const { cases } = prCases(h.store, h.capture, { pr: PR, repo: REPO, botLogin: BOT });
    expect(server.files.get(caseUri(name3))).toBe(renderCase(cases[1]!));
  });

  it("re-owing a case resets its attempts and stamps when it became owed", async () => {
    const { h } = await scenario();
    const w = new CaseWriter({
      store: h.store,
      outcomes: h.capture,
      memory: {
        async putDocuments(docs: readonly DocumentPut[]): Promise<DocumentPutResult[]> {
          return docs.map((d) => ({
            area: d.area,
            name: d.name,
            state: "failed",
            message: "busy",
          }));
        },
      },
      repo: REPO,
      botLogin: BOT,
      healthy: () => true,
      now: h.clock,
      backfillDays: 0,
      maxAttempts: 1,
    });
    await w.tick();
    expect(w.casesFor(PR).map((c) => [c.state, c.attempts, c.owed_since])).toEqual([
      ["failed", 1, expect.any(String)],
      ["failed", 1, expect.any(String)],
    ]);
    // F3's fate changes: owed again, from scratch.
    h.decide(902, 9003, "refuted");
    h.tick(5);
    const at = h.at();
    await h.capture.capturePr(PR);
    expect(w.syncCaptured()).toBe(1);
    expect(w.casesFor(PR).find((c) => c.finding_key === "F3")).toMatchObject({
      state: "pending",
      attempts: 0,
      owed_since: at,
    });
  });

  it("a case withdrawn because its own finding no longer qualifies points nowhere — no cases/ path", async () => {
    const h = harness({ state: "closed" });
    const r = h.round(H1, [posted({ key: "F1" })]);
    h.capture.observeBotComments(PR, [h.botComment({ id: 900, round: r, key: "F1" })]);
    await h.capture.capturePr(PR);
    const { w, server } = writer(h);
    expect(await w.tick()).toMatchObject({ written: 1 });
    // The PR is reopened: open at close no longer stands, and nothing else
    // made a case of it (no reply, no fate yet).
    h.addPr(PR, "alice", "tracked");
    h.tick(5);
    await h.capture.capturePr(PR);
    expect(h.capture.outcomesFor(PR)[0]!.fate).toBe("unknown");
    expect(await w.tick()).toMatchObject({ withdrawn: 1 });
    const stub = server.files.get(caseUri(caseName(PR, r, "F1")))!;
    expect(stub).toContain("no longer a posted finding");
    expect(stub).not.toContain(`${CASES_AREA}/`);
  });
});

// ---- the store half --------------------------------------------------------------

describe("OpenVikingStore.putDocuments and the sweep", () => {
  it("one batch per area; a precondition refusal re-sends the rest once and reports the conflict's bytes", async () => {
    const server = new OvServer();
    server.dirs.add(CASES);
    server.files.set(`${CASES}/b.md`, "someone else\n");
    const store = ovStore(server.fetch);
    const res = await store.putDocuments([
      { area: "cases", name: "a", text: "A", expect: null },
      { area: "cases", name: "b", text: "B", expect: null },
      { area: "cases", name: "c", text: "C", expect: null },
    ]);
    expect(res.map((r) => r.state)).toEqual(["written", "conflict", "written"]);
    expect(res[1]).toMatchObject({
      found: "someone else\n",
      hash: sha256Prefixed("someone else\n"),
    });
    expect(res[0]!.hash).toBe(sha256Prefixed("A\n"));
    expect(server.batches().map((b) => [b.root, b.ops.length])).toEqual([
      [CASES, 3],
      [CASES, 2],
    ]);
    expect(server.files.get(`${CASES}/b.md`)).toBe("someone else\n");
  });

  it("refuses an address it cannot spell, and a document named twice", async () => {
    const store = ovStore(new OvServer().fetch);
    const res = await store.putDocuments([
      { area: "cases", name: "../x", text: "A", expect: null },
      { area: "cases", name: "a", text: "A", expect: null },
      { area: "cases", name: "a", text: "B", expect: null },
      { area: "cases", name: "e", text: "  ", expect: null },
    ]);
    expect(res.map((r) => r.state)).toEqual(["failed", "written", "failed", "failed"]);
  });

  it("the whole-tree sweep never lists cases/ — the timeline, the head and the relayout never see them", async () => {
    const server = new OvServer();
    server.files.set(`${OV_ROOT}/experiences/20261001T100000-a.md`, "a lesson\n");
    server.files.set(`${CASES}/case-1-r1-0000000000000000.md`, "#case kind=case a case\n");
    const store = ovStore(server.fetch);
    const sweep = await store.sweep();
    expect(sweep.entries.map((e) => e.id)).toEqual(["experiences/20261001T100000-a.md"]);
    expect(server.calls.some((c) => c.path === "/api/v1/fs/ls" && c.uri === CASES)).toBe(false);
    expect(SWEEP_EXCLUDED_AREAS).toEqual([CASES_AREA]);
  });
});

// ---- not in the round's search scope --------------------------------------------

describe("cases are not in the round's search scope (that is S9)", () => {
  it("the round block searches experiences/ only, and drops a case that comes back anyway", () => {
    expect(ROUND_SEARCH_AREAS).not.toContain(CASES_AREA);
    expect(inRoundSearchScope(`${CASES}/case-1-r1-0000000000000000.md`)).toBe(false);
    expect(inRoundSearchScope(`${OV_ROOT}/experiences/x.md`)).toBe(true);
  });

  it("the PR session's recall hint carries the round's areas — never cases/", () => {
    const wire = readFileSync(join(process.cwd(), "src", "wire.ts"), "utf8");
    expect(wire).toMatch(/\{ query, areas: ROUND_SEARCH_AREAS \}/);
  });

  it("the curator is told cases exist, what they are, and that they are not its to write", () => {
    expect(MEMORY_LAYOUT_NOTE).toMatch(/`cases\/` — finding CASES, written by the daemon/);
    expect(MEMORY_LAYOUT_NOTE).toMatch(/never write, edit or retire one/);
    expect(MEMORY_LAYOUT_NOTE).not.toMatch(/not yet written/);
  });
});

// ---- [feedback] in full ----------------------------------------------------------

describe("[feedback] comments land in events/ with their full text", () => {
  const long = (body: string): FeedbackEvent => ({
    kind: "feedback_comment",
    pr: 5325,
    comment_id: 9,
    in_reply_to_id: 7,
    author: "pmercier",
    body,
    scope: "review_comment",
  });

  it("a long or multi-line comment's entry carries all of it, fenced as data after the sentence", () => {
    const body = `[feedback] This is wrong.\n\nWe ${"really ".repeat(60)}never do that here — see \`docs/x.md\`.\n#pinned kind=bug`;
    const text = memoryEntryFor(long(body), "2026-10-07");
    expect(text).toContain(FEEDBACK_FULL_TEXT_LABEL);
    expect(readFencedData(text, FEEDBACK_FULL_TEXT_LABEL)).toBe(
      cleanQuotedText(body.replace(/^\[feedback\]\s*/, "")),
    );
    // The header is the S2 header — nothing in the quote reaches it.
    expect(parseEventTags(text)).toEqual({
      kind: "feedback",
      pr: "5325",
      day: "2026-10-07",
      signal: "feedback_comment",
    });
    expect(parseHashTags(text)).toEqual(["feedback"]);
  });

  it("a short single-line comment stays the one-line entry it always was", () => {
    const text = memoryEntryFor(long("[feedback] over-specific"), "2026-10-07");
    expect(text).not.toContain("\n");
    expect(text).not.toContain(FEEDBACK_FULL_TEXT_LABEL);
  });

  it("the ledger row renders the same full text (ingest and backfill agree)", () => {
    const store = new StateStore(":memory:");
    const body = "[feedback] line one\nline two";
    const row = store.recordFeedbackSignalRow({
      kind: "feedback_comment",
      pr: 1,
      comment_id: 9,
      in_reply_to_id: null,
      scope: "issue_comment",
      author: "pmercier",
      body,
      day: "2026-10-07",
    })!;
    expect(memoryEntryForRow(row)).toContain(fenceAsData("line one\nline two"));
  });
});

// ---- the backfill ----------------------------------------------------------------

describe("the backfill: 60 days, state.db plus one adapter read, resumable, rate-limited", () => {
  /** Three closed PRs with a finding answered by a human: one 70 days old,
   * two inside the window. Nothing has captured their outcomes. */
  function aged() {
    const h = harness({ pr: 1 });
    h.store.db.prepare("DELETE FROM pr_state").run();
    const make = (n: number, at: string) => {
      h.setNow(at);
      h.addPr(n, "alice", "closed");
      const r = h.round(H1, [posted({ key: `K${n}` })], n);
      h.reply({
        id: n * 10 + 1,
        root: n * 10,
        author: "bob",
        body: `reply on ${n}`,
        at: h.tick(1),
        n,
      });
      return r;
    };
    const rounds = {
      old: make(4001, "2026-07-20T10:00:00.000Z"),
      mid: make(4002, "2026-09-01T10:00:00.000Z"),
      new: make(4003, "2026-09-30T10:00:00.000Z"),
    };
    h.setNow("2026-10-07T10:00:00.000Z");
    const reads: number[] = [];
    const read = {
      async listReviewCommentsFull(n: number): Promise<ReviewCommentFull[]> {
        reads.push(n);
        return [h.botComment({ id: n * 10, round: 1, key: `K${n}` })];
      },
    };
    return { h, rounds, read, reads };
  }

  it("covers the window newest first, a PR a tick, one comments read each — and nothing older", async () => {
    const { h, read, reads } = aged();
    const server = new OvServer();
    const mk = () => writer(h, { server, read, backfillDays: 60, backfillPrsPerTick: 1 }).w;
    const w = mk();
    expect(w.status().backfill).toEqual({ days: 60, done: 0, remaining: 2 });
    expect((await w.tick()).backfilled).toEqual([4003]);
    expect(reads).toEqual([4003]);
    expect(server.files.has(caseUri(caseName(4003, 1, "K4003")))).toBe(true);
    // A restart: a new writer over the same state database resumes.
    const w2 = mk();
    expect((await w2.tick()).backfilled).toEqual([4002]);
    expect((await w2.tick()).backfilled).toEqual([]);
    expect(reads).toEqual([4003, 4002]);
    expect(w2.status().backfill).toEqual({ days: 60, done: 2, remaining: 0 });
    expect(server.files.has(caseUri(caseName(4001, 1, "K4001")))).toBe(false);
    const fates = h.capture.outcomesFor(4002);
    expect(fates.map((f) => f.fate)).toEqual(["open_at_close"]);
    expect(parseEventTags(server.files.get(caseUri(caseName(4002, 1, "K4002")))!)).toMatchObject({
      fate: "open_at_close",
      replies: "1",
      thread: `https://github.com/${REPO}/pull/4002#discussion_r40020`,
    });
  });

  it("is gated on memory health: no read, no capture, no write while it is not healthy", async () => {
    const { h, read, reads } = aged();
    let healthy = false;
    const { w, server } = writer(h, { read, healthy: () => healthy, backfillDays: 60 });
    expect(await w.tick()).toMatchObject({ held: true, backfilled: [] });
    expect(reads).toEqual([]);
    expect(h.capture.outcomesFor(4003)).toEqual([]);
    expect(server.batches()).toHaveLength(0);
    healthy = true;
    expect((await w.tick()).backfilled).toEqual([4003, 4002]);
  });

  it("skips the adapter read when the reconcile sweep already read the PR's bot comments", async () => {
    const { h, read, reads } = aged();
    h.capture.observeBotComments(4003, [h.botComment({ id: 40030, round: 1, key: "K4003" })]);
    const { w } = writer(h, { read, backfillDays: 60 });
    await w.tick();
    expect(reads).toEqual([4002]);
  });

  it("a failed comments read is a failed attempt: the PR stays owed, the backfill pauses, and the read after the pause links it", async () => {
    const { h, reads } = aged();
    let fail = true;
    const read = {
      async listReviewCommentsFull(n: number): Promise<ReviewCommentFull[]> {
        reads.push(n);
        if (fail) throw new Error("could not acquire mint lock");
        return [h.botComment({ id: n * 10, round: 1, key: `K${n}` })];
      },
    };
    const { w, server } = writer(h, { read, backfillDays: 60, backfillPrsPerTick: 1 });
    expect((await w.tick()).backfilled).toEqual([]);
    expect(reads).toEqual([4003]);
    // Not done, not captured from half the facts: owed, with the reason.
    expect(
      h.store.db.prepare("SELECT done, attempts, unread, outcome FROM case_backfill").all(),
    ).toEqual([
      {
        done: 0,
        attempts: 1,
        unread: 0,
        outcome: expect.stringMatching(/comments not read \(attempt 1 of 3\).*mint lock/),
      },
    ]);
    expect(h.capture.outcomesFor(4003)).toEqual([]);
    expect(w.status().backfill).toMatchObject({ done: 0, remaining: 2 });
    // The adapter is likely down for every PR: the whole backfill waits.
    fail = false;
    expect((await w.tick()).backfilled).toEqual([]);
    expect(reads).toEqual([4003]);
    h.tick(31);
    expect((await w.tick()).backfilled).toEqual([4003]);
    expect(reads).toEqual([4003, 4003]);
    expect(h.store.db.prepare("SELECT done, unread FROM case_backfill").get()).toEqual({
      done: 1,
      unread: 0,
    });
    // The bot's own comment, read this time, is the case's thread.
    expect(parseEventTags(server.files.get(caseUri(caseName(4003, 1, "K4003")))!)).toMatchObject({
      thread: `https://github.com/${REPO}/pull/4003#discussion_r40030`,
    });
  });

  it("a PR whose read keeps failing is captured from state.db alone at the cap, marked unread, and re-queued daily", async () => {
    const { h } = aged();
    const reads: number[] = [];
    let fail = true;
    const read = {
      async listReviewCommentsFull(n: number): Promise<ReviewCommentFull[]> {
        reads.push(n);
        if (fail) throw new Error("rate limited");
        return [h.botComment({ id: n * 10, round: 1, key: `K${n}` })];
      },
    };
    const { w } = writer(h, { read, backfillDays: 60, backfillPrsPerTick: 1 });
    for (let i = 0; i < 3; i++) {
      await w.tick();
      h.tick(31);
    }
    expect(reads).toEqual([4003, 4003, 4003]);
    expect(h.store.db.prepare("SELECT pr, done, unread, outcome FROM case_backfill").all()).toEqual(
      [
        {
          pr: 4003,
          done: 1,
          unread: 1,
          outcome: expect.stringMatching(
            /posted.*; given up after 3 attempts: comments never read: Error: rate limited/,
          ),
        },
      ],
    );
    // Captured from state.db all the same.
    expect(h.capture.outcomesFor(4003).map((o) => o.fate)).toEqual(["open_at_close"]);
    // The adapter is back: the next PR is not held back by the given-up one…
    fail = false;
    expect((await w.tick()).backfilled).toEqual([4002]);
    expect((await w.tick()).backfilled).toEqual([]);
    // …and a day on (the daily re-queue), the PR never read is read again.
    h.tick(24 * 60);
    expect((await w.tick()).backfilled).toEqual([4003]);
    expect(reads.filter((n) => n === 4003)).toHaveLength(4);
    expect(
      h.store.db.prepare("SELECT done, unread FROM case_backfill WHERE pr = 4003").get(),
    ).toEqual({ done: 1, unread: 0 });
  });

  it("a PR whose capture keeps throwing is given up on, not retried forever", async () => {
    const { h, read } = aged();
    const capture = h.capture;
    let throws = 0;
    const outcomes = {
      outcomesFor: (pr: number) => capture.outcomesFor(pr),
      commentsFor: (pr: number) => capture.commentsFor(pr),
      reviewOutcomesFor: (pr: number) => capture.reviewOutcomesFor(pr),
      observeBotComments: (pr: number, c: readonly ReviewCommentFull[]) =>
        capture.observeBotComments(pr, c),
      capturePr: async (pr: number) => {
        if (pr === 4003) {
          throws++;
          throw new Error("git on fire");
        }
        return capture.capturePr(pr);
      },
    };
    const w = new CaseWriter({
      store: h.store,
      outcomes,
      memory: ovStore(new OvServer().fetch),
      repo: REPO,
      botLogin: BOT,
      healthy: () => true,
      read,
      now: h.clock,
      backfillDays: 60,
      backfillPrsPerTick: 1,
    });
    for (let i = 0; i < 5; i++) await w.tick();
    expect(throws).toBe(3);
    const rows = h.store.db
      .prepare("SELECT pr, done, unread, outcome FROM case_backfill ORDER BY pr")
      .all();
    expect(rows).toEqual([
      {
        pr: 4002,
        done: 1,
        unread: 0,
        outcome: expect.stringMatching(/1 posted, 1 case\(s\) owed/),
      },
      { pr: 4003, done: 1, unread: 0, outcome: expect.stringMatching(/given up.*git on fire/) },
    ]);
  });

  it("feeds the queue only while it is short — the write side sets the pace", async () => {
    const { h, read } = aged();
    const w = new CaseWriter({
      store: h.store,
      outcomes: h.capture,
      memory: {
        async putDocuments(docs: readonly DocumentPut[]): Promise<DocumentPutResult[]> {
          return docs.map((d) => ({
            area: d.area,
            name: d.name,
            state: "failed",
            message: "busy",
          }));
        },
      },
      repo: REPO,
      botLogin: BOT,
      healthy: () => true,
      read,
      now: h.clock,
      backfillDays: 60,
      backfillPrsPerTick: 1,
      backfillWhileOwedBelow: 1,
    });
    expect((await w.tick()).backfilled).toEqual([4003]);
    // One case owed and not draining: the backfill waits.
    expect((await w.tick()).backfilled).toEqual([]);
  });
});

// ---- late activity -------------------------------------------------------------

describe("a reply or signal recorded after the capture stopped visiting a closed PR still reaches its case", () => {
  it("a closed PR outside the capture window is captured again and its case rewritten", async () => {
    const h = harness({ state: "closed" });
    const r = h.round(H1, [posted({ key: "F1" })]);
    h.capture.observeBotComments(PR, [h.botComment({ id: 900, round: r, key: "F1" })]);
    await h.capture.capturePr(PR);
    const { w, server } = writer(h);
    expect(await w.tick()).toMatchObject({ written: 1, late: [] });
    const uri = caseUri(caseName(PR, r, "F1"));
    expect(parseEventTags(server.files.get(uri)!)).toMatchObject({ replies: "0" });
    // Three days after the close: the capture pass no longer visits it.
    h.tick(3 * 24 * 60);
    expect(inCaptureWindow(h.store.getPr(PR), h.clock().getTime())).toBe(false);
    expect((await h.capture.sweep()).considered).toBe(0);
    h.reply({ id: 9001, root: 900, author: "bob", body: "Never reachable.", at: h.at() });
    expect(await w.tick()).toMatchObject({ late: [PR], written: 1 });
    expect(parseEventTags(server.files.get(uri)!)).toMatchObject({ replies: "1" });
    expect(server.files.get(uri)).toContain("Never reachable.");
    // Seen: not caught up again until something else arrives.
    expect(await w.tick()).toMatchObject({ late: [], attempted: 0 });
    h.store.recordFeedbackSignalRow({
      kind: "bot_comment_deleted",
      pr: PR,
      comment_id: 900,
      day: "2026-10-04",
    });
    expect(await w.tick()).toMatchObject({ late: [PR], written: 1 });
    expect(server.files.get(uri)).toMatch(/A human deleted the bot comment/);
  });

  it("a PR inside the window is the capture pass's — the late step leaves it alone", async () => {
    const { h } = await scenario();
    const { w } = writer(h);
    await w.tick();
    h.reply({ id: 9100, root: 901, author: "bob", body: "Hm.", at: h.tick(1) });
    expect(await w.tick()).toMatchObject({ late: [], attempted: 0 });
    // The pass captures it; step 1 syncs it.
    await h.capture.sweep();
    expect(await w.tick()).toMatchObject({ synced: 1, late: [], written: 1 });
  });
});

// ---- wiring --------------------------------------------------------------------------

describe("wire.ts: the case writer is actually connected", () => {
  const wire = readFileSync(join(process.cwd(), "src", "wire.ts"), "utf8");

  it("it writes through the daemon's ONE store, gated on memory health, with the outcome capture's tables", () => {
    expect(wire).toMatch(
      /caseWriter = new CaseWriter\(\{[\s\S]*?store: d\.store,[\s\S]*?outcomes: d\.outcomes,[\s\S]*?memory,[\s\S]*?healthy: \(\) => health\.currentState\(\) === "healthy",[\s\S]*?read: adapter,/,
    );
    expect(wire).toMatch(/caseWriter\.start\(\);/);
    expect(wire).toMatch(/caseWriter\?\.stop\(\);/);
  });

  it("its knobs come from [memory], with floors", () => {
    expect(wire).toMatch(/intervalMs: Math\.max\(10, cfg\.memory\.cases_interval_s\) \* 1000/);
    expect(wire).toMatch(/backfillDays: Math\.max\(0, cfg\.memory\.cases_backfill_days\)/);
    expect(MEMORY_DEFAULTS).toMatchObject({ cases_interval_s: 120, cases_backfill_days: 60 });
  });

  it("its ledger rides status.json's memory block — unknown when unread, never 'nothing owed'", () => {
    expect(wire).toMatch(
      /if \(caseWriter\) \{\s*let cases: CaseWritesStatus \| null;\s*try \{\s*cases = caseWriter\.status\(\);\s*\} catch \(err\) \{[\s\S]{0,120}?cases = null;\s*\}\s*base\.case_writes = cases;/,
    );
  });

  it("the daemon hands its outcome capture out — the same instance the reconcile pass drives", () => {
    const daemon = readFileSync(join(process.cwd(), "src", "daemon.ts"), "utf8");
    expect(daemon).toMatch(/readonly outcomes: OutcomeCapture;/);
    expect(daemon).toMatch(/return \{\s*store,\s*cfg,\s*outcomes,/);
  });

  it("cases.ts holds no GitHub writer and no gate — a read is all the backfill makes", () => {
    const src = readFileSync(join(process.cwd(), "src", "cases.ts"), "utf8");
    expect(src).not.toMatch(/MutationGate|gate\.js|executeMutation|import \{[^}]*GitHubAdapter/);
    expect(src).not.toMatch(/\.apply\(/);
  });
});

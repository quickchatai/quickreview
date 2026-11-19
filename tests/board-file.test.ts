// board.json (src/boardfile.ts): the daemon's board for a host, built from
// fixture state (a real in-memory store on a scripted clock, and the status
// snapshot the daemon builds from it), and the daemon writing it: on its
// status write and when a round moved. The export that reads the file is
// tests/board-export.test.ts.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GateResult } from "@quickchatai/pi-quickreview/src/gate.js";
import {
  BOARD_FILE,
  BOARD_LIST_CAP,
  BOARD_TITLE_MAX,
  buildBoardFile,
  parseBoardFile,
  roundTransitionKey,
  writeBoardJson,
  type BoardFile,
} from "../src/boardfile.js";
import { reviewedToday } from "../src/boardtoday.js";
import { loadConfig } from "../src/config.js";
import { createDaemon, type DaemonAdapter } from "../src/daemon.js";
import type { PrRef } from "../src/github.js";
import { autoReviewLabel } from "../src/home/autoreview.js";
import { known } from "../src/home/ports.js";
import { postingMarker } from "../src/posting-receipt.js";
import { StateStore, type StatusSnapshot } from "../src/state.js";
import { BoardWorld, HEAD, NOW, at, openPr } from "./helpers/board-rig.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

let w: BoardWorld;
beforeEach(() => {
  w = new BoardWorld();
});
afterEach(() => {
  w.close();
});

const numbers = (rows: ReadonlyArray<{ number: number }> | undefined): number[] =>
  (rows ?? []).map((r) => r.number);

describe("reviewing: work owed or in flight", () => {
  /** Seven pull requests, one in each standing the list knows. */
  function working(): StatusSnapshot {
    w.tick(-900);
    w.pr(1, { state: "queued", trigger_ts: at(-300) });
    w.pr(2, { state: "reviewing" });
    w.pr(3, { state: "reviewing" });
    w.pr(4, { state: "queued", trigger_ts: at(-500) });
    w.store.db.prepare("UPDATE pr_state SET paused = 1 WHERE number = 4").run();
    for (const n of [5, 6, 7]) w.pr(n);
    // #2 was reviewed once and is being reviewed again
    w.finished(2, { verdict: "REQUEST_CHANGES" });
    w.tick(-240);
    w.store.startRound(2, "re-review", ["pass-baseline"], 45);
    w.tick(-120);
    w.store.startRound(3, "first", ["pass-baseline"], 45);
    const failure = (pr: number, round_no: number, stage: string): void => {
      w.store.openReviewFailure({
        pr,
        round_no,
        head_sha: HEAD,
        stage,
        detail: "scripted",
        attempts: 3,
        retry_cap: 3,
      });
    };
    w.tick(-60);
    failure(5, 2, "round_end");
    w.tick(-30);
    failure(6, 1, "posting_receipt");
    w.tick(-20);
    failure(7, 1, "first_pass_start");
    w.store.db
      .prepare(
        "UPDATE review_failures SET next_action = 'retry_wait', next_retry_at = ? WHERE pr = 7",
      )
      .run(at(900));
    w.tick(0);
    const snapshot = w.snapshot();
    // #3's review is finished and waits on GitHub: the daemon's status writer
    // adds the delivery to the running round
    snapshot.prs.find((p) => p.number === 3)!.current_round!.posting_delivery = {
      attempts: 1,
      next_attempt_at: at(60),
    };
    return snapshot;
  }

  // MUTATION: drop the `p.state === "queued"` half of reviewingState's test, so
  // only a running round counts — #1 and #4 leave the list, and this fails.
  // MUTATION: test `p.paused` before the running round — #2 stays, but a
  // paused pull request with a round in flight would read `paused`.
  it("a queued, running, posting, paused and failed one each say which, newest first", () => {
    const board = w.board(working());
    const row = (number: number) => ({ number, title: `PR ${number}`, author: "alice" });
    expect(board.reviewing).toEqual([
      { ...row(7), state: "failed", problem: "retry_scheduled", round: 1, retry_at: at(900) },
      { ...row(6), state: "failed", problem: "posting_failed", round: 1 },
      { ...row(5), state: "failed", problem: "round_failed", round: 2 },
      { ...row(3), state: "posting", round: 1, started_at: at(-120) },
      { ...row(2), state: "running", round: 2, started_at: at(-240) },
      { ...row(1), state: "queued" },
      { ...row(4), state: "paused" },
    ]);
    // #2 carries a verdict from its first round and is not reviewed twice over
    expect(board.reviewed).toEqual([]);
    expect("more" in board).toBe(false);
  });

  // MUTATION: return null from reviewingState before the review_failure test
  // when the lifecycle state is `tracked` — a failed round disappears.
  it("a review failure puts a pull request there whatever its lifecycle state says", () => {
    w.pr(8, { state: "awaiting_author" });
    w.finished(8, { verdict: "REQUEST_CHANGES" });
    w.store.openReviewFailure({
      pr: 8,
      round_no: 2,
      head_sha: HEAD,
      stage: "round_end",
      detail: "scripted",
      attempts: 3,
      retry_cap: 3,
    });
    // the store requeues it; put the lifecycle back to prove the failure alone lists it
    w.store.setPrState(8, "awaiting_author");
    const board = w.board();
    expect(board.reviewing).toEqual([
      {
        number: 8,
        title: "PR 8",
        author: "alice",
        state: "failed",
        problem: "round_failed",
        round: 2,
      },
    ]);
    expect(board.reviewed).toEqual([]);
  });

  it("a parked worker fails the work it holds up, and nothing that has no work owed", () => {
    w.pr(9, { state: "queued", trigger_ts: at(-50) });
    w.pr(10);
    w.finished(10, { verdict: "APPROVE" });
    for (const pr of [9, 10])
      w.store.recordWorkerFailure(pr, {
        commandId: `c-${pr}`,
        error: "the worker exited",
        at: at(-10),
        parkAfter: 1,
      });
    const board = w.board();
    expect(board.reviewing).toEqual([
      { number: 9, title: "PR 9", author: "alice", state: "failed", problem: "worker_parked" },
    ]);
    expect(numbers(board.reviewed)).toEqual([10]);
  });
});

describe("reviewed: a last verdict, and what GitHub holds", () => {
  function reviewedWorld(): void {
    w.tick(-4000);
    for (const n of [10, 11, 12, 13, 15]) w.pr(n);
    w.pr(14, { state: "closed" });
    w.finished(14, { verdict: "APPROVE", posted: { event: "APPROVE", id: 9000, at: at(-3990) } });
    w.tick(-3600);
    // decided APPROVE, on GitHub as a comment until the checks pass
    w.finished(10, {
      verdict: "APPROVE",
      posted: { event: "COMMENT", id: 9001, at: at(-3590) },
      comments: 0,
    });
    // dry-run: the round confirms the event it intended and holds no review
    w.finished(11, {
      verdict: "REQUEST_CHANGES",
      posted: { event: "REQUEST_CHANGES", id: null, at: at(-3580) },
      comments: 3,
    });
    w.finished(12, {
      verdict: "REQUEST_CHANGES",
      posted: { event: "REQUEST_CHANGES", id: 9002, at: at(-3570) },
    });
    w.finished(12, { verdict: "APPROVE", posted: { event: "APPROVE", id: 9003, at: at(-900) } });
    // an older round: the retired verdict spelling, and no recorded head
    w.store.finishRound(w.store.startRound(13, "first", [], 45), "ESCALATE", null);
    w.tick(-400);
    w.pr(13);
    w.tick(-300);
    w.pr(11, { state: "awaiting_author", head_sha: "def7654321" });
    w.tick(-200);
    w.pr(12);
    w.tick(-100);
    w.pr(10);
    w.store.recordApprovalWithheld(10, { head_sha: HEAD, ci_state: "pending" });
    w.tick(0);
  }

  // MUTATION: read `posted_event` off the round whenever it is set — the
  // dry-run round of #11 confirmed its intended event, and would read as posted.
  // MUTATION: take the first round with a verdict instead of the last — #12
  // reads REQUEST_CHANGES and review 9002.
  it("a row carries the verdict, the posting, the withheld approval, counts and head", () => {
    reviewedWorld();
    const board = w.board();
    const row = (number: number) => ({ number, title: `PR ${number}`, author: "alice" });
    expect(board.reviewed).toEqual([
      {
        ...row(10),
        verdict: "APPROVE",
        posted_event: "COMMENT",
        approval_withheld: true,
        posted_at: at(-3590),
        review_id: 9001,
        rounds: 1,
        findings: 0,
        head_changed: false,
      },
      {
        ...row(12),
        verdict: "APPROVE",
        posted_event: "APPROVE",
        approval_withheld: false,
        posted_at: at(-900),
        review_id: 9003,
        rounds: 2,
        head_changed: false,
      },
      // not posted: no posted_event, no posted_at, no review_id
      {
        ...row(11),
        verdict: "REQUEST_CHANGES",
        approval_withheld: false,
        rounds: 1,
        findings: 3,
        head_changed: true,
      },
      // the head it reviewed is not on record: head_changed is unknown, not false
      { ...row(13), verdict: "NEEDS_HUMAN", approval_withheld: false, rounds: 1 },
    ]);
    // a closed pull request (#14) and one with no verdict (#15) are not reviewed
    expect(board.reviewing).toEqual([]);
  });

  it("a verdict outside the vocabulary leaves the row's verdict out, and keeps the row", () => {
    w.pr(20);
    w.store.finishRound(w.store.startRound(20, "first", [], 45), "SHRUG", null);
    expect(w.board().reviewed).toEqual([
      { number: 20, title: "PR 20", author: "alice", approval_withheld: false, rounds: 1 },
    ]);
  });

  it("carries no URL, and no title longer than the cap", () => {
    reviewedWorld();
    w.pr(21, { title: "t".repeat(BOARD_TITLE_MAX + 40) });
    w.finished(21, { verdict: "APPROVE", posted: { event: "APPROVE", id: 9004, at: at(-5) } });
    w.open = [openPr(15), openPr(30)];
    const board = w.board();
    expect(JSON.stringify(board)).not.toMatch(/https?:|html_url|"url"/);
    expect(board.reviewed.find((r) => r.number === 21)?.title).toHaveLength(BOARD_TITLE_MAX);
  });
});

describe("open: what the last pass listed, minus the two lists", () => {
  // MUTATION: list every open pull request in `open` — #1 and #2 appear twice.
  it("a tracked one with no verdict and an untracked one are open; the rest are not", () => {
    w.pr(1, { state: "queued", trigger_ts: at(-30) });
    w.pr(2);
    w.finished(2, { verdict: "APPROVE" });
    w.pr(3);
    w.open = [
      openPr(1),
      openPr(2),
      openPr(3, { updated_at: at(-500), draft: true }),
      openPr(4, { updated_at: at(-100), author: "bob", title: "an untracked one" }),
    ];
    const board = w.board();
    expect(numbers(board.reviewing)).toEqual([1]);
    expect(numbers(board.reviewed)).toEqual([2]);
    expect(board.open).toEqual([
      { number: 4, title: "an untracked one", author: "bob", draft: false, updated_at: at(-100) },
      { number: 3, title: "PR 3", author: "alice", draft: true, updated_at: at(-500) },
    ]);
    expect(board.listed_at).toBe(at(-60));
  });

  // MUTATION: default `open` to [] when the snapshot has no open list — a host
  // would read "no open pull requests" where nothing was listed.
  it("before a pass has listed them, the list and its time are absent, not empty", () => {
    w.pr(1);
    const board = w.board();
    expect("open" in board).toBe(false);
    expect("listed_at" in board).toBe(false);
    expect(board.reviewing).toEqual([]);
    expect(board.reviewed).toEqual([]);
  });
});

describe("the caps", () => {
  // MUTATION: raise BOARD_LIST_CAP, or drop the slice in `newest` — the lists
  // run long and this fails. MUTATION: sort oldest first — the numbers reverse.
  it("each list is its newest fifty, newest first, and says rows were cut", () => {
    for (let n = 1; n <= 60; n++) {
      w.tick(-20_000 + n);
      w.pr(n, { state: "queued", trigger_ts: at(-20_000 + n) });
    }
    for (let n = 101; n <= 155; n++) {
      w.tick(-10_000 + n);
      w.pr(n);
      w.finished(n, { verdict: "APPROVE" });
    }
    w.tick(0);
    w.open = [];
    for (let n = 201; n <= 270; n++) w.open.push(openPr(n, { updated_at: at(-30_000 + n) }));
    // the tracked ones are open on GitHub too, and belong to their own lists
    w.open.push(openPr(1), openPr(101));
    const asked: number[] = [];
    const board = buildBoardFile(w.snapshot(), (pr) => {
      asked.push(pr);
      return w.store.roundsFor(pr);
    });
    const down = (from: number): number[] =>
      Array.from({ length: BOARD_LIST_CAP }, (_, i) => from - i);
    expect(numbers(board.reviewing)).toEqual(down(60));
    expect(numbers(board.reviewed)).toEqual(down(155));
    expect(numbers(board.open)).toEqual(down(270));
    expect(board.more).toBe(true);
    // the rounds are read for the rows that are printed, and no other
    expect(asked.sort((a, b) => b - a)).toEqual(down(155));
  });

  it("a list at the cap was not cut", () => {
    for (let n = 1; n <= BOARD_LIST_CAP; n++) w.pr(n, { state: "queued", trigger_ts: at(-n) });
    const board = w.board();
    expect(board.reviewing).toHaveLength(BOARD_LIST_CAP);
    expect("more" in board).toBe(false);
  });
});

describe("spend and health", () => {
  it("the day's and the month's spend, with the rounds that have no price beside them", () => {
    w.pr(1);
    w.finished(1, { verdict: "APPROVE" });
    const priced = w.board();
    expect(priced.spend).toEqual({ today_usd: 0.25, month_usd: 0.25 });
    const id = w.finished(1, { verdict: "APPROVE" });
    w.store.db
      .prepare("UPDATE rounds SET est_usd = NULL, tokens_in = 10, tokens_out = 5 WHERE id = ?")
      .run(id);
    expect(w.board().spend).toEqual({
      today_usd: 0.25,
      month_usd: 0.25,
      today_unknown_rounds: 1,
      month_unknown_rounds: 1,
    });
  });

  // MUTATION: write `today_usd: 0` when the snapshot has no figure — an older
  // daemon's unknown would read as nothing spent.
  it("a snapshot with no spend figures has no spend", () => {
    const { today_spend_usd: _today, month_spend_usd: _month, ...older } = w.snapshot();
    expect("spend" in w.board(older as StatusSnapshot)).toBe(false);
  });

  // The export judges the reviewer by the home's rule over the board's health
  // slice, so the slice must carry every key that rule reads.
  // MUTATION: drop `pipeline` (or `provider`, `pi_auth_expired`, `login_refresh`)
  // from the health block in buildBoardFile — its case reads on-dry, and this fails.
  it("the health slice reads as the whole snapshot does, for every state of the label", () => {
    const label = (text: string) => {
      const l = autoReviewLabel({ container: known("running"), snapshot: known(text), now: NOW });
      return l.kind === "known" ? l.value.state : `unknown: ${l.why}`;
    };
    const cases: Array<[string, Partial<StatusSnapshot>]> = [
      ["on-dry", {}],
      ["on-live", { dry_run: false }],
      ["starting", { poll: { last_at: null, ok: null, interval_s: 300 } }],
      ["paused-login", { pi_auth_expired: { last_at: at(-5), hits: 2 } }],
      [
        "paused-login",
        {
          login_refresh: {
            state: "supervised",
            running: true,
            restarts: 0,
            login: {
              pid: 1,
              started_at: at(-900),
              expires_at: at(3600),
              provider: "openai-codex",
              last_refresh: null,
              last_error: null,
              error_since: null,
              paused: true,
              checked_at: at(-5),
            },
          },
        },
      ],
      ["broken", { poll: { last_at: at(-30), ok: false, error: "scripted", interval_s: 300 } }],
      [
        "broken",
        {
          pipeline: {
            healthy: false,
            failed_loud: 1,
            causes: [
              {
                key: "k",
                pr: 7,
                since: at(-50),
                stage: "round_end",
                detail: "scripted",
                next_action: "operator_unwedge",
              },
            ],
          },
        },
      ],
      ["broken", { provider: { healthy: false, detail: "scripted", last_at: at(-5) } }],
    ];
    for (const [want, over] of cases) {
      const snapshot = { ...w.snapshot(), ...over };
      expect(label(JSON.stringify(snapshot)), JSON.stringify(over)).toBe(want);
      expect(label(JSON.stringify(w.board(snapshot).health)), JSON.stringify(over)).toBe(want);
    }
  });
});

describe("the file", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qcr-board-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // MUTATION: write straight to board.json — a reader can meet half a file,
  // and (with the temp name dropped) nothing here can tell.
  it("is written through a temp file and a rename, and replaced in place", () => {
    w.pr(1, { state: "queued", trigger_ts: at(-5) });
    const target = join(dir, "nested", "state");
    writeBoardJson(target, w.board());
    expect(readdirSync(target)).toEqual([BOARD_FILE]);
    const first = statSync(join(target, BOARD_FILE)).ino;
    w.pr(2, { state: "queued", trigger_ts: at(-4) });
    writeBoardJson(target, w.board());
    expect(readdirSync(target)).toEqual([BOARD_FILE]);
    expect(statSync(join(target, BOARD_FILE)).ino).not.toBe(first);
    const read = parseBoardFile(readFileSync(join(target, BOARD_FILE), "utf8"));
    expect(numbers(read?.reviewing)).toEqual([2, 1]);
  });

  it("reads back as it was built", () => {
    w.pr(1, { state: "queued", trigger_ts: at(-5) });
    w.pr(2);
    w.finished(2, {
      verdict: "APPROVE",
      posted: { event: "APPROVE", id: 7, at: at(-3) },
      comments: 2,
    });
    w.open = [openPr(3)];
    const board = w.board();
    expect(parseBoardFile(JSON.stringify(board))).toEqual(board);
  });

  // MUTATION: pass a row through whole in readReviewing — the `url` a file
  // carried would reach the export.
  it("a reader keeps the fields it knows, and drops a row it cannot place", () => {
    const file = {
      format: 1,
      written_at: at(0),
      health: {},
      reviewing: [
        { number: 1, state: "queued", title: "kept", url: "https://example.test/1" },
        { state: "queued" },
        { number: 2, state: "exploded" },
        "not a row",
      ],
      reviewed: [
        { number: 3, verdict: "MAYBE", posted_event: "DISMISS", review_id: "9", rounds: -1 },
      ],
      open: [{ number: 4, draft: "no", html_url: "https://example.test/4" }],
      listed_at: at(-60),
      more: "yes",
    };
    expect(parseBoardFile(JSON.stringify(file))).toEqual({
      format: 1,
      written_at: at(0),
      health: {},
      reviewing: [{ number: 1, state: "queued", title: "kept" }],
      reviewed: [{ number: 3 }],
      open: [{ number: 4 }],
      listed_at: at(-60),
    });
  });

  it("what is not a board of this format is no board", () => {
    const good: BoardFile = w.board();
    expect(parseBoardFile(JSON.stringify(good))).not.toBeNull();
    expect(parseBoardFile("{")).toBeNull();
    expect(parseBoardFile("[]")).toBeNull();
    expect(parseBoardFile(JSON.stringify({ ...good, format: 2 }))).toBeNull();
    const { reviewed: _reviewed, ...noList } = good;
    expect(parseBoardFile(JSON.stringify(noList))).toBeNull();
    const { written_at: _at, ...noTime } = good;
    expect(parseBoardFile(JSON.stringify(noTime))).toBeNull();
  });

  it("a reader never takes more rows than the cap, and an open list only with its time", () => {
    const rows = Array.from({ length: BOARD_LIST_CAP + 10 }, (_, i) => ({
      number: i + 1,
      state: "queued",
    }));
    const file = { ...w.board(), reviewing: rows, open: [{ number: 900 }] };
    const read = parseBoardFile(JSON.stringify(file))!;
    expect(read.reviewing).toHaveLength(BOARD_LIST_CAP);
    expect("open" in read).toBe(false);
    expect("listed_at" in read).toBe(false);
  });
});

describe("the round transition key", () => {
  // MUTATION: leave the rounds out of roundTransitionKey — a posting confirmed
  // on a running round moves nothing, and this fails.
  it("moves when a pull request is queued, a round starts, posts and ends; and only then", () => {
    const key = (): string => roundTransitionKey(w.store);
    const seen = [key()];
    const moved = (what: string): void => {
      const k = key();
      expect(seen, what).not.toContain(k);
      expect(key(), `${what}, read twice`).toBe(k);
      seen.push(k);
    };
    w.pr(1, { state: "queued", trigger_ts: at(-10) });
    moved("queued");
    const id = w.store.startRound(1, "first", [], 45);
    w.store.setPrState(1, "reviewing");
    moved("a round started");
    w.store.db
      .prepare("UPDATE rounds SET posted_event = 'COMMENT', gh_review_id = 5 WHERE id = ?")
      .run(id);
    moved("its review reached GitHub");
    w.store.finishRound(id, "APPROVE", null);
    w.store.setPrState(1, "tracked");
    moved("the round ended");
    const settled = key();
    // a closed pull request is on no list, and a new title moves no round
    w.pr(2, { state: "closed" });
    w.pr(1, { title: "renamed" });
    expect(key()).toBe(settled);
  });
});

// ---- the daemon ----------------------------------------------------------------

const PR = 101;

function fakeAdapter(dryrunDir: string): DaemonAdapter {
  let calls = 0;
  const gateResult = (kind: string): GateResult => {
    writeFileSync(join(dryrunDir, `${++calls}-${kind}.json`), JSON.stringify({ kind }));
    return { executed: false };
  };
  const pr: PrRef = {
    number: PR,
    title: "test PR",
    author: "someone",
    head_sha: "headsha1",
    base_ref: "master",
    updated_at: "2026-08-13T00:00:00Z",
    state: "open",
    draft: false,
    merged: false,
    labels: ["AI review requested"],
  };
  return {
    searchLabelTriggered: async () => [
      {
        number: PR,
        title: pr.title,
        user: { login: pr.author, type: "User" },
        updated_at: pr.updated_at,
        created_at: pr.updated_at,
      },
    ],
    searchTeamTriggered: async () => [],
    searchAwaitingEscalationReviewer: async () => [],
    listOpenPrs: async () => [pr],
    getPr: async () => pr,
    stalenessScan: async () => [],
    listBotReviewComments: async () => [],
    getRequestedReviewers: async () => ({ users: [], teams: [] }),
    listPrFiles: async () => [
      { filename: "src/app.ts", additions: 5, deletions: 1, status: "modified" },
    ],
    addLabel: async () => gateResult("add_label"),
    removeLabel: async () => gateResult("remove_label"),
    deleteTeamReviewRequest: async () => gateResult("delete_team_review_request"),
    requestEscalationReview: async () => ({
      skipped: null,
      result: gateResult("request_reviewer"),
    }),
    createReview: async () => gateResult("create_review"),
  } as unknown as DaemonAdapter;
}

describe("the daemon writes it", () => {
  let root: string;
  let store: StateStore;
  const boardPath = (): string => join(root, "state", BOARD_FILE);
  const board = (): BoardFile => {
    const read = parseBoardFile(readFileSync(boardPath(), "utf8"));
    if (read === null) throw new Error("the daemon wrote no board this build reads");
    return read;
  };
  const cfg = () => ({
    ...loadConfig(join(process.cwd(), "tests/fixtures/config.toml")),
    dry_run: true,
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "qcr-board-daemon-"));
    for (const d of ["state", "state/dryrun", "verdict", "inject"])
      mkdirSync(join(root, d), { recursive: true });
    store = new StateStore(":memory:");
  });
  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  // MUTATION: drop `followRounds()` from the daemon's pump — the board is not
  // written until the status tick, and this fails at the first read.
  // MUTATION: write the board on every pump — the inode moves on the idle
  // pump, and this fails.
  it(
    "the board is rewritten when a round moved, and left alone while nothing did",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      store.upsertPr({
        number: PR,
        state: "queued",
        head_sha: "headsha1",
        title: "test PR",
        author: "someone",
        trigger_ts: new Date().toISOString(),
        stale_recheck: 0,
        migration_gate: 0,
      });
      const daemon = createDaemon({
        cfg: cfg(),
        root,
        store,
        adapter: fakeAdapter(join(root, "state", "dryrun")),
        listen: false,
        log: () => {},
        hooks: {
          inject: async () => {},
          dispatchRound: async () => {},
          async archiveAndClose() {},
        },
      });
      expect(existsSync(boardPath())).toBe(false);
      await daemon.pump();
      // dispatched by that pump: the pull request is being reviewed now
      expect(board().reviewing).toEqual([
        expect.objectContaining({ number: PR, title: "test PR", state: "running", round: 1 }),
      ]);
      expect(board().reviewed).toEqual([]);
      expect(board().health.dry_run).toBe(true);
      expect(existsSync(`${boardPath()}.tmp`)).toBe(false);
      // status.json is written by the same write, beside it
      expect(existsSync(join(root, "state", "status.json"))).toBe(true);

      const written = statSync(boardPath()).ino;
      await daemon.pump();
      expect(statSync(boardPath()).ino).toBe(written);

      // the round ends, as the verdict watcher leaves it
      const round = store.roundsFor(PR)[0]!;
      store.finishRound(round.id, "REQUEST_CHANGES", null);
      store.setPrState(PR, "awaiting_author");
      await daemon.pump();
      expect(statSync(boardPath()).ino).not.toBe(written);
      expect(board().reviewing).toEqual([]);
      expect(board().reviewed).toEqual([
        expect.objectContaining({ number: PR, verdict: "REQUEST_CHANGES", rounds: 1 }),
      ]);
    },
  );

  // The day's count is made where the store is open: by the daemon, when it
  // writes the board, on its configured calendar (`[ops] timezone`).
  // MUTATION: drop the `reviewedToday(...)` argument from the daemon's
  // buildBoardFile call — the board carries no count, and this fails.
  it(
    "counts the pull requests reviewed today from its round store, a closed one included",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const config = cfg();
      store.upsertPr({
        number: PR,
        state: "queued",
        head_sha: "headsha1",
        title: "test PR",
        author: "someone",
        trigger_ts: new Date().toISOString(),
        stale_recheck: 0,
        migration_gate: 0,
      });
      const daemon = createDaemon({
        cfg: config,
        root,
        store,
        adapter: fakeAdapter(join(root, "state", "dryrun")),
        listen: false,
        log: () => {},
        hooks: {
          inject: async () => {},
          dispatchRound: async () => {},
          async archiveAndClose() {},
        },
      });
      await daemon.pump();
      // a round runs and none has finished: a count of zero, with its day
      const before = board().reviewed_today;
      expect(before).toEqual(reviewedToday(store, new Date(), config.ops.timezone));
      expect(before).toMatchObject({ count: 0 });
      expect(Date.parse(before!.since)).toBeLessThanOrEqual(Date.now());
      expect(Date.parse(before!.until)).toBeGreaterThan(Date.now());

      // the round ends, and the pull request is then closed: in no list, and counted
      const round = store.roundsFor(PR)[0]!;
      store.finishRound(round.id, "REQUEST_CHANGES", null);
      store.setPrState(PR, "closed");
      await daemon.pump();
      expect(board().reviewed_today).toMatchObject({ count: 1 });
      expect(board().reviewing).toEqual([]);
      expect(board().reviewed).toEqual([]);
    },
  );

  // The whole path in dry-run: start (the first status write), the reconcile
  // pass that queues and dispatches, the verdict the watcher applies, and the
  // verdict sweep that follows it onto the board.
  // MUTATION: drop the board write from the daemon's status writer — no file
  // exists after start, and this fails.
  it(
    "on its status write, and a practice round lands in reviewed with nothing posted",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const daemon = createDaemon({
        cfg: cfg(),
        root,
        store,
        adapter: fakeAdapter(join(root, "state", "dryrun")),
        listen: false,
        log: () => {},
      });
      await daemon.start();
      try {
        expect(store.getPr(PR)?.state).toBe("reviewing");
        expect(numbers(board().reviewing)).toEqual([PR]);
        // the pass listed the open pull requests; the one it reviews is not "open"
        expect(board().open).toEqual([]);
        expect(board().listed_at).toEqual(expect.any(String));

        const running = store.roundsFor(PR)[0]!;
        const receiptDir = join(root, "state", "posting-receipts");
        mkdirSync(receiptDir, { recursive: true });
        writeFileSync(
          join(receiptDir, `pr-${PR}-round-1.json`),
          JSON.stringify({
            version: 1,
            posting_key: running.posting_key,
            marker: postingMarker(running.posting_key!),
            pr: PR,
            round_no: 1,
            head_sha: "headsha1",
            base_ref: "master",
            intended_event: "APPROVE",
            actual_event: "APPROVE",
            status: "dryrun",
            payload_sha256: "a".repeat(64),
            prepared_at: new Date().toISOString(),
            confirmed_at: new Date().toISOString(),
          }),
        );
        writeFileSync(
          join(root, "verdict", `pr-${PR}-round-1.json`),
          JSON.stringify({
            pr: PR,
            round_no: 1,
            verdict: "APPROVE",
            head_sha: "headsha1",
            finished_at: new Date().toISOString(),
          }),
        );
        await vi.waitFor(() => expect(store.getPr(PR)?.state).toBe("tracked"), {
          timeout: 5000,
          interval: 50,
        });
        await daemon.sweepVerdicts();
        expect(board().reviewing).toEqual([]);
        const [row] = board().reviewed;
        expect(row).toMatchObject({ number: PR, verdict: "APPROVE", rounds: 1 });
        // dry-run: the round confirmed its intended event and GitHub holds nothing
        expect(row).not.toHaveProperty("posted_event");
        expect(row).not.toHaveProperty("posted_at");
        expect(row).not.toHaveProperty("review_id");
      } finally {
        await daemon.stop();
      }
    },
  );
});

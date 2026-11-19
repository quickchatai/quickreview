// `host review-now`, `host proof-start` and `host proof-result`
// (src/host/proof.ts): a review a host's operator asks for, and the practice
// review a go-live is confirmed against. The daemon's container is a fake
// Docker (tests/helpers/host-rig.ts) that answers `qcr why`, the operator
// command write, its receipt and the dry-run directory; the checklist and the
// host record are real files.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PROOF_BODY_CAP,
  PROOF_COMMENT_BODY_CAP,
  PROOF_COMMENT_CAP,
  PROOF_PATH_CAP,
} from "../src/host/outcomes.js";
import {
  SETTLED_AFTER_MS,
  cappedReview,
  hostProofResult,
  hostProofStart,
  hostReviewNow,
  parsePrArg,
} from "../src/host/proof.js";
import { readHostProgress, readHostRecord } from "../src/host/record.js";
import { acquireChecklistLock } from "../src/onboard/checklistlock.js";
import { CHOICE_KEYS } from "../src/onboard/choices.js";
import { PROOF_STEP_ID } from "../src/onboard/steps/proof.js";
import {
  WALK_PID,
  finishedRound,
  hostWorld,
  setUpConfig,
  type HostWorld,
} from "./helpers/host-rig.js";

let w: HostWorld;
beforeEach(() => {
  w = hostWorld();
  w.writeConfig(setUpConfig());
});
afterEach(() => w.close());

const proofChoice = (): unknown => w.checklist()?.choices[CHOICE_KEYS.proof];
const rootWrites = (): string[][] => w.calls.filter((c) => c.includes("-u"));

describe("the pull request argument", () => {
  it("is one positive integer, and nothing else", () => {
    expect(parsePrArg("review-now", ["412"])).toBe(412);
    for (const args of [[], ["412", "413"], ["0"], ["-1"], ["#412"], ["4e2"], ["99999999999"]])
      expect(parsePrArg("review-now", args), args.join(" ")).toMatch(
        /usage: qcr --schema 3 host review-now <pr-number>/,
      );
  });
});

describe("host review-now", () => {
  it("writes one review-now command into the operator channel, as root, and reads its receipt", async () => {
    expect(await hostReviewNow(w.ports, ["7"])).toEqual({ state: "queued", pr: 7 });
    expect(rootWrites()).toHaveLength(1);
    expect(w.daemon.written).toHaveLength(1);
    expect(w.daemon.written[0]).toMatch(/-onboard-reviewnow-7\.json$/);
    // the payload is the daemon's own command, built from the number
    expect(rootWrites()[0]!.at(-1)).toContain('{"command":"review-now","pr":7}');
    // no GitHub call of its own, and no checklist write
    expect(w.github).toEqual([]);
    expect(w.checklist()).toBeNull();
  });

  it("says `sent` when the daemon has not answered yet, and relays a refusal", async () => {
    w.daemon.receipt = "pending";
    expect(await hostReviewNow(w.ports, ["7"])).toEqual({ state: "sent", pr: 7 });
    w.daemon.receipt = "refused";
    const out = await hostReviewNow(w.ports, ["7"]);
    expect(out).toMatchObject({ state: "refused", reason: "review_refused" });
    expect(out.message).toMatch(/refused to review #7: PR #7 is closed/);
  });

  it("refuses without a reviewer to ask", async () => {
    w.daemon.running = false;
    expect(await hostReviewNow(w.ports, ["7"])).toMatchObject({
      state: "refused",
      reason: "reviewer_not_running",
    });
    w.daemon.psFails = true;
    expect(await hostReviewNow(w.ports, ["7"])).toMatchObject({
      state: "refused",
      reason: "reviewer_unreachable",
    });
    w.daemon.psFails = false;
    w.daemon.running = true;
    w.daemon.writeFails = true;
    expect(await hostReviewNow(w.ports, ["7"])).toMatchObject({
      state: "refused",
      reason: "reviewer_unreachable",
    });
    expect(w.daemon.written).toEqual([]);
  });

  it("refuses before setup, and a call it cannot read", async () => {
    w.writeConfig(setUpConfig().replace(/^repo = .*$/m, 'repo = ""'));
    expect(await hostReviewNow(w.ports, ["7"])).toMatchObject({
      state: "refused",
      reason: "not_set_up",
    });
    expect(await hostReviewNow(w.ports, ["seven"])).toMatchObject({
      state: "refused",
      reason: "usage",
    });
    expect(w.calls).toEqual([]);
  });
});

describe("host proof-start", () => {
  it("asks for the practice round and returns: no proof record is written", async () => {
    expect(await hostProofStart(w.ports, ["7"])).toEqual({ state: "started", pr: 7 });
    expect(w.daemon.written).toHaveLength(1);
    expect(readHostRecord(w.stateDir).proof_request).toMatchObject({
      pr: 7,
      floor: 0,
      command: w.daemon.written[0],
    });
    // MUTATION: record the proof in proof-start — these fail.
    expect(proofChoice()).toBeUndefined();
    expect(readHostRecord(w.stateDir).proof_shown).toBeUndefined();
    // the lock was held only for the call
    expect(acquireChecklistLock(w.stateDir, "home", { pid: WALK_PID }).ok).toBe(true);
  });

  it("only a round later than those that had ended answers the request", async () => {
    w.daemon.rounds = [finishedRound(7, 1).round, finishedRound(7, 2).round];
    await hostProofStart(w.ports, ["7"]);
    expect(readHostRecord(w.stateDir).proof_request?.floor).toBe(2);
  });

  it("a round already under way is the practice round: nothing more is asked", async () => {
    w.daemon.rounds = [
      finishedRound(7, 1).round,
      { round_no: 2, status: "running", verdict: null, started_at: "2026-11-19T11:59:00.000Z" },
    ];
    expect(await hostProofStart(w.ports, ["7"])).toEqual({ state: "running", pr: 7 });
    expect(w.daemon.written).toEqual([]);
    expect(readHostRecord(w.stateDir).proof_request).toMatchObject({ pr: 7, floor: 1 });
  });

  // MUTATION: drop the dry-run check — a "practice" review is asked of a
  // reviewer that posts, and this fails.
  it("refuses when the config says the reviewer posts: a practice review is one that cannot post", async () => {
    w.writeConfig(setUpConfig({ dryRun: false }));
    const out = await hostProofStart(w.ports, ["7"]);
    expect(out).toMatchObject({ state: "refused", reason: "already_live" });
    expect(w.daemon.written).toEqual([]);
    expect(readHostRecord(w.stateDir).proof_request).toBeUndefined();
  });

  it("answers `busy` while something else holds the lock, and relays the daemon's refusal", async () => {
    const setup = acquireChecklistLock(w.stateDir, "setup", {
      pid: WALK_PID,
      alive: (p) => w.alivePids.has(p),
    });
    expect(await hostProofStart(w.ports, ["7"])).toEqual({ state: "busy", holder: "setup" });
    expect(w.daemon.written).toEqual([]);
    if (setup.ok) setup.lock.release();
    w.daemon.receipt = "refused";
    expect(await hostProofStart(w.ports, ["7"])).toMatchObject({
      state: "refused",
      reason: "review_refused",
    });
    expect(readHostRecord(w.stateDir).proof_request).toBeUndefined();
  });
});

describe("host proof-result", () => {
  const start = async (): Promise<void> => {
    expect(await hostProofStart(w.ports, ["7"])).toMatchObject({ state: "started" });
    w.calls.length = 0;
  };
  /** The daemon finishes round `n` of #7 and records its review. */
  const finish = (n = 1, o: Parameters<typeof finishedRound>[2] = {}): void => {
    const done = finishedRound(7, n, o);
    w.daemon.rounds = [...w.daemon.rounds.filter((r) => r.round_no !== n), done.round];
    w.daemon.dryrun = [...w.daemon.dryrun, ...done.records];
    w.daemon.state = "tracked";
  };

  it("with no practice round asked for, says so and reads nothing", async () => {
    expect(await hostProofResult(w.ports, ["7"])).toEqual({ state: "not_started", pr: 7 });
    await start();
    expect(await hostProofResult(w.ports, ["8"])).toEqual({ state: "not_started", pr: 8 });
    expect(w.calls).toEqual([]);
  });

  // MUTATION: wait for the round inside proof-result (the wizard's poll
  // loop) — the sleep count below is no longer zero, and this fails.
  it("never blocks: while the round is queued or runs it answers `running`, and writes nothing", async () => {
    let slept = 0;
    const ports = { ...w.ports, sleep: async () => void (slept += 1) };
    await start();
    w.daemon.state = "queued";
    expect(await hostProofResult(ports, ["7"])).toEqual({ state: "running", pr: 7 });
    w.daemon.state = "reviewing";
    w.daemon.rounds = [{ round_no: 1, status: "running", verdict: null }];
    expect(await hostProofResult(ports, ["7"])).toEqual({ state: "running", pr: 7 });
    expect(slept).toBe(0);
    expect(proofChoice()).toBeUndefined();
    expect(readHostProgress(w.stateDir)).toEqual({});
  });

  it("when the round has finished: the review as it would have been posted, and the proof record", async () => {
    await start();
    finish(1, { verdict: "REQUEST_CHANGES", comments: 2, body: "Two blockers." });
    const out = await hostProofResult(w.ports, ["7"]);
    expect(out).toEqual({
      state: "done",
      pr: 7,
      proof: {
        pr: 7,
        round_no: 1,
        verdict: "REQUEST_CHANGES",
        completed_at: new Date(w.now).toISOString(),
      },
      review: {
        event: "COMMENT",
        body: "Two blockers.",
        comments: [
          { path: "src/file0.ts", line: 1, body: "[blocker] finding 0" },
          { path: "src/file1.ts", line: 2, body: "[blocker] finding 1" },
        ],
        comments_total: 2,
      },
    });
    // the checklist's own record, where the go-live step reads it
    expect(proofChoice()).toEqual({
      pr: 7,
      round_no: 1,
      verdict: "REQUEST_CHANGES",
      completed_at: new Date(w.now).toISOString(),
      review_shown: true,
    });
    expect(w.checklist()!.steps[PROOF_STEP_ID]).toMatchObject({ status: "done" });
    // returning it is what marks it as shown, and what the board export prints
    expect(readHostRecord(w.stateDir).proof_shown).toMatchObject({ pr: 7, round_no: 1 });
    expect(readHostProgress(w.stateDir).proof).toMatchObject({ pr: 7, round_no: 1 });
    // nothing was posted, and nothing asked of GitHub
    expect(w.github).toEqual([]);
  });

  it("asked again, returns the same review and records nothing new", async () => {
    await start();
    finish();
    const first = await hostProofResult(w.ports, ["7"]);
    const record = JSON.stringify(readHostRecord(w.stateDir));
    w.now += 60_000;
    expect(await hostProofResult(w.ports, ["7"])).toEqual(first);
    expect(JSON.stringify(readHostRecord(w.stateDir))).toBe(record);
  });

  it("a round that ended before the request is not the practice review", async () => {
    finish(1);
    await start();
    w.daemon.state = "queued";
    expect(await hostProofResult(w.ports, ["7"])).toEqual({ state: "running", pr: 7 });
    expect(proofChoice()).toBeUndefined();
    finish(2, { verdict: "APPROVE", startedAt: "2026-11-19T12:10:00.000Z" });
    expect(await hostProofResult(w.ports, ["7"])).toMatchObject({
      state: "done",
      proof: { round_no: 2, verdict: "APPROVE" },
    });
  });

  it("a request the daemon settled without a new round is answered by the standing review, after a wait", async () => {
    finish(1);
    await start();
    expect(await hostProofResult(w.ports, ["7"])).toEqual({ state: "running", pr: 7 });
    w.now += SETTLED_AFTER_MS;
    expect(await hostProofResult(w.ports, ["7"])).toMatchObject({
      state: "done",
      proof: { round_no: 1 },
    });
  });

  it("a round that failed, a refusal that came late, a finished round with no recorded review", async () => {
    await start();
    w.daemon.rounds = [{ round_no: 1, status: "overdue", verdict: null }];
    expect(await hostProofResult(w.ports, ["7"])).toMatchObject({
      state: "failed",
      reason: "round_failed",
      pr: 7,
    });
    w.daemon.rounds = [];
    w.daemon.receipt = "refused";
    expect(await hostProofResult(w.ports, ["7"])).toMatchObject({
      state: "failed",
      reason: "review_refused",
    });
    w.daemon.receipt = "queued";
    w.daemon.rounds = [finishedRound(7, 1).round];
    w.daemon.dryrun = [];
    const out = await hostProofResult(w.ports, ["7"]);
    expect(out).toMatchObject({ state: "failed", reason: "no_dry_run_record" });
    // MUTATION: record the proof before the review is read — this fails.
    expect(proofChoice()).toBeUndefined();
    expect(readHostRecord(w.stateDir).proof_shown).toBeUndefined();
  });

  it("with the reviewer gone it says so, and with the lock taken it answers `busy`", async () => {
    await start();
    finish();
    w.daemon.whyFails = true;
    expect(await hostProofResult(w.ports, ["7"])).toMatchObject({
      state: "failed",
      reason: "reviewer_unreachable",
    });
    w.daemon.whyFails = false;
    const setup = acquireChecklistLock(w.stateDir, "setup", {
      pid: WALK_PID,
      alive: (p) => w.alivePids.has(p),
    });
    expect(setup.ok).toBe(true);
    expect(await hostProofResult(w.ports, ["7"])).toEqual({
      state: "busy",
      holder: "setup",
      pr: 7,
    });
    expect(proofChoice()).toBeUndefined();
  });
});

describe("the review, as printed", () => {
  const snapshot = (comments: number, body = "ok") => ({
    source: "sandbox" as const,
    state: "REQUEST_CHANGES",
    body,
    comments: Array.from({ length: comments }, (_, i) => ({
      path: `src/${i}.ts`,
      line: i + 1,
      body: `finding ${i}`,
    })),
  });

  // MUTATION: print every comment — this fails.
  it("carries at most 50 comments, and says how many there were", () => {
    const out = cappedReview(snapshot(PROOF_COMMENT_CAP + 7));
    expect(PROOF_COMMENT_CAP).toBe(50);
    expect(out.comments).toHaveLength(50);
    expect(out.comments_total).toBe(57);
    expect(out.comments[49]).toEqual({ path: "src/49.ts", line: 50, body: "finding 49" });
  });

  // MUTATION: print the body and each comment whole — this fails.
  it("cuts the body, each comment and each path at its cap, and says so", () => {
    const long = cappedReview({
      ...snapshot(1, "b".repeat(PROOF_BODY_CAP + 1)),
      comments: [
        {
          path: "p".repeat(PROOF_PATH_CAP + 9),
          line: 3,
          body: "c".repeat(PROOF_COMMENT_BODY_CAP + 1),
        },
      ],
    });
    expect(long.body).toHaveLength(PROOF_BODY_CAP);
    expect(long.body_truncated).toBe(true);
    expect(long.comments[0]!.body).toHaveLength(PROOF_COMMENT_BODY_CAP);
    expect(long.comments[0]!.truncated).toBe(true);
    expect(long.comments[0]!.path).toHaveLength(PROOF_PATH_CAP);
    const short = cappedReview(snapshot(1));
    expect(short).not.toHaveProperty("body_truncated");
    expect(short.comments[0]).not.toHaveProperty("truncated");
  });

  it("names the event only when it is one GitHub takes, and a line only when it is one", () => {
    expect(cappedReview(snapshot(0)).event).toBe("REQUEST_CHANGES");
    expect(cappedReview({ ...snapshot(0), state: "ESCALATE" })).not.toHaveProperty("event");
    const odd = cappedReview({
      ...snapshot(0),
      comments: [{ path: "a.ts", line: -3, body: "x" }],
    });
    expect(odd.comments[0]!.line).toBe(0);
  });
});

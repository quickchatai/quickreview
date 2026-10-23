// A round that posts its review and then outlives the stage limit, replayed
// through the REAL round-stage supervisor and the REAL verdict watcher (wired
// as daemon.ts wires them). Without the receipt check, the stage limit kills a
// round whose review is already posted, and the re-run posts a second one.
//
// The scenario's timeline (UTC):
//   08:28:10.849  round 5 dispatched at the PR's head
//   08:30:46 / 08:35:23  a human re-requests review → successor_required ×2
//   ~08:49:18     the last pass finishes
//   08:52:58.641  posting receipt CONFIRMED: REQUEST_CHANGES
//   08:54:18.408  the supervisor's parent_finalize limit fires (5 min after
//                 the last pass) → cancelled infrastructure_failure, session
//                 killed, self-requeued "before any merits verdict"
//   09:08         round 6 re-reviews the same head and posts a SECOND
//                 REQUEST_CHANGES
//
// The limit asks the receipt first: the review is on GitHub, so the session's
// tail gets its bounded grace and the round ends with ONE posting either way —
// the verdict file lands, or the grace runs out and the round settles from the
// receipt. With no receipt the limit cancels the round as an infrastructure
// failure, kills the session and requeues.
//
// The finalize limit now also waits while the parent's run reads ACTIVE —
// which in this scenario it does, so the limit would not fire at
// 08:54 at all (the first describe's last test replays exactly that). It still
// fires for an "active" snapshot when tmux reports the session gone, so the
// receipt tests below drive it that way: the receipt check is what is under
// test, and it is what keeps a posted round alive when that liveness report
// is wrong.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig, type Config } from "../src/config.js";
import type { GateResult } from "@quickchatai/pi-quickreview/src/gate.js";
import { postingMarker, roundPostingKey } from "../src/posting-receipt.js";
import type { RoundProgressSnapshot } from "@quickchatai/pi-quickreview/src/round-progress.js";
import { SessionCommandSupervisor } from "../src/session-command-supervisor.js";
import { standingReview } from "@quickchatai/pi-quickreview/src/standing-review.js";
import { StateStore } from "../src/state.js";
import type { SessionHooks } from "@quickchatai/pi-quickreview/src/types.js";
import { VerdictWatcher, type VerdictAdapter } from "../src/verdicts.js";
import { createHash } from "node:crypto";

const cfg: Config = parseConfig(
  readFileSync(resolve(process.cwd(), "tests/fixtures/config.toml"), "utf8"),
);

const PR = 4242;
const HEAD = "1111111111111111111111111111111111111111";
const CMD = "00000000-0000-4000-8000-000000000001";
const REVIEW_ID = 4000000101;

class FakeAdapter implements VerdictAdapter {
  calls: string[] = [];
  async addLabel(n: number, label: string): Promise<GateResult> {
    this.calls.push(`addLabel:${n}:${label}`);
    return { executed: false, dryRunFile: "d" };
  }
  async removeLabel(n: number, label: string): Promise<GateResult> {
    this.calls.push(`removeLabel:${n}:${label}`);
    return { executed: false, dryRunFile: "d" };
  }
}

let root: string;
let verdictDir: string;
let clock: Date;
let store: StateStore;
let killed: number[];
/** What the tmux liveness probe answers. */
let alive: boolean;
let roundId: number;

const set = (iso: string): void => {
  clock = new Date(iso);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "qcr-receipt-"));
  verdictDir = join(root, "verdict");
  mkdirSync(verdictDir, { recursive: true });
  killed = [];
  alive = true;
  set("2026-01-15T07:00:00.000Z");
  store = new StateStore(":memory:", () => clock);
  store.upsertPr({
    number: PR,
    state: "reviewing",
    head_sha: HEAD,
    title: "feat(api): import status and label filter",
    author: "pr-author",
    trigger_ts: "2026-01-15T08:15:46.079Z",
    stale_recheck: 0,
    migration_gate: 0,
  });
  // Rounds 1–4, decided and posted earlier.
  for (let k = 1; k <= 4; k++) {
    const id = store.startRound(PR, k === 1 ? "first" : "re-review", ["pass-baseline"], 75);
    store.finishRound(id, "REQUEST_CHANGES", null, null);
  }
  // 08:28:10.849 — round 5 dispatched; its command is accepted at 08:28:14.
  set("2026-01-15T08:28:10.849Z");
  roundId = store.startRound(
    PR,
    "re-review",
    ["pass-baseline", "pass-validate"],
    cfg.daemon.round_deadline_min,
  );
  store.stampPostingKey(roundId, roundPostingKey(PR, 5, HEAD));
  store.createSessionCommand({
    id: CMD,
    pr: PR,
    session: `pr-${PR}`,
    kind: "round",
    round_no: 5,
    payload_sha256: "a".repeat(64),
    payload_path: join(root, "state", "session-commands", `${CMD}.md`),
    inject_path: join(root, "inject", `pr-${PR}`, `wake--cmd-${CMD}.md`),
    next_check_at: "2026-01-15T08:30:10.849Z",
  });
  set("2026-01-15T08:28:14.000Z");
  store.claimSessionCommand(CMD, "bridge-1", "2026-01-15T08:30:14.000Z");
  store.markSessionCommandStarted(CMD, "bridge-1", "2026-01-15T09:13:14.000Z");
  // 08:30:46 and 08:35:23 — a human re-requests review while the round runs.
  set("2026-01-15T08:30:46.092Z");
  store.recordSuccessor({
    pr: PR,
    predecessor_round_id: roundId,
    head_sha: HEAD,
    provenance: "human",
    reason: "trigger-while-reviewing",
  });
  set("2026-01-15T08:35:23.128Z");
  store.recordSuccessor({
    pr: PR,
    predecessor_round_id: roundId,
    head_sha: HEAD,
    provenance: "human",
    reason: "trigger-while-reviewing",
  });
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

/** 08:52:58 — post-review.sh confirms the POST and stamps the mark, as the
 * shell route does (posted_event, no verdict yet). */
function postReview(): void {
  set("2026-01-15T08:52:58.641Z");
  const key = roundPostingKey(PR, 5, HEAD);
  const dir = join(root, "state", "posting-receipts");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `pr-${PR}-round-5.json`),
    JSON.stringify({
      version: 1,
      posting_key: key,
      marker: postingMarker(key),
      pr: PR,
      round_no: 5,
      head_sha: HEAD,
      intended_event: "REQUEST_CHANGES",
      actual_event: "REQUEST_CHANGES",
      status: "confirmed",
      payload_sha256: "b".repeat(64),
      prepared_at: "2026-01-15T08:52:57.900Z",
      confirmed_at: "2026-01-15T08:52:58.641Z",
      gh_review_id: REVIEW_ID,
      gh_commit_id: HEAD,
      gh_state: "CHANGES_REQUESTED",
    }),
  );
  set("2026-01-15T08:52:58.724Z");
  store.recordReviewedHead(PR, { head_sha: HEAD, posted_event: "REQUEST_CHANGES" });
}

/** Round-progress v2 telemetry: every planned pass terminal by 08:49:18. */
function progress(): RoundProgressSnapshot {
  return {
    version: 2,
    pr: PR,
    session: `pr-${PR}`,
    run_started_at: "2026-01-15T08:28:14.000Z",
    updated_at: clock.toISOString(),
    parent_status: "active",
    command_id: CMD,
    command_sha256: "a".repeat(64),
    command_accepted_at: "2026-01-15T08:28:15.000Z",
    first_lens_started_at: "2026-01-15T08:31:15.582Z",
    last_activity_at: clock.toISOString(),
    last_activity: "writing the findings record",
    agents: [
      {
        execution_id: "lens-1:pass-baseline",
        agent: "pass-baseline--sol-med",
        status: "completed",
        duration_ms: 1,
        tool_count: 1,
        started_at: "2026-01-15T08:31:15.582Z",
        finished_at: "2026-01-15T08:44:02.000Z",
      },
      {
        execution_id: "lens-2:pass-validate",
        agent: "pass-validate--sol-high",
        status: "completed",
        duration_ms: 1,
        tool_count: 1,
        started_at: "2026-01-15T08:44:30.000Z",
        finished_at: "2026-01-15T08:49:18.408Z",
      },
    ],
  };
}

function wire(live = false): { watcher: VerdictWatcher; supervisor: SessionCommandSupervisor } {
  const hooks: SessionHooks = {
    async dispatchRound() {},
    async inject() {},
    async archiveAndClose() {},
    async killSession(pr) {
      killed.push(pr);
    },
    async sessionAlive() {
      return alive;
    },
  };
  const watcher = new VerdictWatcher({
    cfg: live ? { ...cfg, dry_run: false } : cfg,
    store,
    adapter: new FakeAdapter(),
    hooks,
    verdictDir,
    root,
    usage: {},
    ledgerCheckDelayMs: 0,
    partialWrite: { windowMs: 0 },
    now: () => clock,
  });
  const supervisor = new SessionCommandSupervisor({
    cfg,
    store,
    hooks,
    verdictDir,
    progress: () => progress(),
    onRoundFailure: (pr, roundNo, stage, detail) =>
      watcher.recoverInfrastructureFailure(pr, roundNo, stage, detail),
    now: () => clock,
  });
  return { watcher, supervisor };
}

const count = (kind: string): number =>
  (store.db.prepare("SELECT COUNT(*) c FROM events WHERE kind = ?").get(kind) as { c: number }).c;
const postings = (): number =>
  (
    store.db
      .prepare("SELECT COUNT(*) c FROM rounds WHERE pr = ? AND gh_review_id IS NOT NULL")
      .get(PR) as { c: number }
  ).c;
const round5 = () => store.roundsFor(PR).find((r) => r.round_no === 5)!;

/** Exactly one posting, and nothing the daemon owes that would post again. */
function expectOnePostingAndNothingOwed(): void {
  expect(postings()).toBe(1);
  expect(round5()).toMatchObject({
    status: "done",
    verdict: "REQUEST_CHANGES",
    gh_review_id: REVIEW_ID,
    posted_event: "REQUEST_CHANGES",
  });
  expect(store.roundsFor(PR).map((r) => r.round_no)).toEqual([1, 2, 3, 4, 5]);
  expect(count("round_infrastructure_failure")).toBe(0);
  expect(count("round_self_requeued")).toBe(0);
  expect(store.openReviewFailure(PR)).toBeUndefined();
  // The human re-requests made during the round were for THIS head, and the
  // round's verdict covers it: no successor round is owed.
  expect(store.successorFor(PR)).toBeUndefined();
  expect(store.getPr(PR)?.state).toBe("awaiting_author");
  expect(standingReview(store.reviewedHead(PR))).toMatchObject({
    kind: "decided",
    verdict: "REQUEST_CHANGES",
  });
}

describe("a posted round 5 replayed", () => {
  it("a finished review survives an outage beyond stage limits and deadline, then settles without another round", async () => {
    const key = roundPostingKey(PR, 5, HEAD);
    const dir = join(root, "state", "posting-receipts");
    mkdirSync(dir, { recursive: true });
    const payload = {
      commit_id: HEAD,
      event: "REQUEST_CHANGES",
      body: `Review\n\n${postingMarker(key)}`,
    };
    writeFileSync(
      join(dir, `pr-${PR}-round-5.outbox.json`),
      JSON.stringify({
        version: 1,
        posting_key: key,
        repo: cfg.github.repo,
        mode: "live",
        pr: PR,
        round_no: 5,
        head_sha: HEAD,
        intended_event: "REQUEST_CHANGES",
        payload,
        status: "pending",
        attempts: 7,
        payload_sha256: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
        next_attempt_at: clock.toISOString(),
        created_at: clock.toISOString(),
      }),
    );
    const { watcher, supervisor } = wire(true);
    set("2026-01-15T08:54:18.408Z");
    await supervisor.scan();
    expect(round5().status).toBe("running");
    expect(killed).toEqual([]);
    set("2026-01-16T10:00:00.000Z");
    await watcher.checkDeadlines();
    expect(round5().status).toBe("running");
    expect(store.openReviewFailure(PR)).toBeUndefined();
    expect(count("round_self_requeued")).toBe(0);
    // Recovery confirmation is the same receipt the shell/worker writes.
    postReview();
    set("2026-01-16T10:30:00.000Z");
    await watcher.checkDeadlines();
    expectOnePostingAndNothingOwed();
  });

  it("the parent_finalize limit after a confirmed posting waits; the late verdict then lands — one posting", async () => {
    const { watcher, supervisor } = wire();
    postReview();
    alive = false; // the active snapshot is not trusted: the limit fires

    // 08:54:18.408 — the limit fires.
    set("2026-01-15T08:54:18.408Z");
    await supervisor.scan();
    expect(round5().status).toBe("running");
    expect(killed).toEqual([]);
    expect(store.getSessionCommand(CMD)?.status).toBe("running");
    expect(count("round_stage_posted_wait")).toBe(1);
    expect(count("round_infrastructure_failure")).toBe(0);
    expect(count("round_self_requeued")).toBe(0);

    // Later scans inside the grace change nothing and log nothing new.
    set("2026-01-15T08:55:18.408Z");
    await supervisor.scan();
    expect(round5().status).toBe("running");
    expect(count("round_stage_posted_wait")).toBe(1);

    // 08:56:30 — the session's tail finishes: ledger, findings record, verdict.
    set("2026-01-15T08:56:30.000Z");
    writeFileSync(
      join(verdictDir, `pr-${PR}-round-5.json`),
      JSON.stringify({
        pr: PR,
        round_no: 5,
        verdict: "REQUEST_CHANGES",
        head_sha: HEAD,
        summary: "One blocker remains.",
        passes: [{ name: "pass-baseline", tier: "sol-med", findings: 2 }],
        finished_at: "2026-01-15T08:56:29Z",
      }),
    );
    expect(await watcher.sweep()).toEqual([`pr-${PR}-round-5.json`]);
    store.finishSessionCommand(CMD, "bridge-1", "acked"); // the parent settles

    set("2026-01-15T08:58:43.075Z");
    await supervisor.scan();
    expectOnePostingAndNothingOwed();
    expect(killed).toEqual([]); // the session was never killed
    expect(count("verdict_settled_from_receipt")).toBe(0); // the real verdict won
  });

  it("the session never writes its verdict: past the posted-tail grace the round settles from the receipt — one posting", async () => {
    const { supervisor } = wire();
    postReview();
    alive = false; // the active snapshot is not trusted: the limit fires

    set("2026-01-15T08:54:18.408Z");
    await supervisor.scan();
    set("2026-01-15T09:07:58.000Z"); // confirmed + 14m59s: still inside
    await supervisor.scan();
    expect(round5().status).toBe("running");
    expect(killed).toEqual([]);

    set("2026-01-15T09:07:58.700Z"); // confirmed + 15 min
    await supervisor.scan();
    expectOnePostingAndNothingOwed();
    expect(count("verdict_settled_from_receipt")).toBe(1);
    expect(round5().summary).toContain("settled from the posted review");

    // The next scan releases the still-running command (the merits lifecycle
    // won) — the supervisor's ordinary terminal-round path.
    set("2026-01-15T09:08:58.700Z");
    await supervisor.scan();
    expect(killed).toEqual([PR]);
    expect(store.getSessionCommand(CMD)?.status).toBe("acked");
    expectOnePostingAndNothingOwed();
  });

  it("control — with NO receipt the old path still runs: cancelled as infrastructure, killed, requeued", async () => {
    const { supervisor } = wire();
    alive = false; // the active snapshot is not trusted: the limit fires
    // No postReview(): nothing reached GitHub.

    set("2026-01-15T08:54:18.408Z");
    await supervisor.scan();

    expect(round5()).toMatchObject({
      status: "cancelled",
      cancel_cause: "infrastructure_failure",
      gh_review_id: null,
    });
    expect(killed).toEqual([PR]);
    expect(count("round_self_requeued")).toBe(1);
    expect(store.getPr(PR)?.state).toBe("queued");
    expect(postings()).toBe(0);
  });

  it("as recorded — the parent still ACTIVE: the limit never fires, the verdict lands — one posting, no kill", async () => {
    const { watcher, supervisor } = wire();
    postReview();

    set("2026-01-15T08:54:18.408Z");
    await supervisor.scan();
    expect(round5().status).toBe("running");
    expect(store.getSessionCommand(CMD)?.status).toBe("running");
    expect(count("round_finalize_held_parent_active")).toBe(1);
    expect(count("round_stage_posted_wait")).toBe(0);

    set("2026-01-15T08:56:30.000Z");
    writeFileSync(
      join(verdictDir, `pr-${PR}-round-5.json`),
      JSON.stringify({
        pr: PR,
        round_no: 5,
        verdict: "REQUEST_CHANGES",
        head_sha: HEAD,
        summary: "One blocker remains.",
        passes: [{ name: "pass-baseline", tier: "sol-med", findings: 2 }],
        finished_at: "2026-01-15T08:56:29Z",
      }),
    );
    expect(await watcher.sweep()).toEqual([`pr-${PR}-round-5.json`]);
    store.finishSessionCommand(CMD, "bridge-1", "acked");

    set("2026-01-15T08:58:43.075Z");
    await supervisor.scan();
    expectOnePostingAndNothingOwed();
    expect(killed).toEqual([]);
  });
});

// A review POST GitHub answered 5xx, handed to the daemon as a `deferred`
// receipt: posting in flight for its whole retry window — no stage limit,
// deadline or verdict apply may requeue, fail or kill the round — and, once the
// daemon's retry confirms it, the round settles as a normally posted one.
describe("a deferred posting", () => {
  const key = roundPostingKey(PR, 5, HEAD);
  const dir = () => join(root, "state", "posting-receipts");
  function writeDeferred(event: "APPROVE" | "REQUEST_CHANGES", jobStatus = "pending"): void {
    mkdirSync(dir(), { recursive: true });
    const payload = { commit_id: HEAD, event, body: `Review\n\n${postingMarker(key)}` };
    const sha = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    writeFileSync(
      join(dir(), `pr-${PR}-round-5.outbox.json`),
      JSON.stringify({
        version: 1,
        posting_key: key,
        repo: cfg.github.repo,
        mode: "live",
        pr: PR,
        round_no: 5,
        head_sha: HEAD,
        intended_event: event,
        payload,
        status: jobStatus,
        attempts: 0,
        payload_sha256: sha,
        next_attempt_at: "2026-01-15T08:56:58.000Z",
        created_at: "2026-01-15T08:52:57.000Z",
        deferred_at: "2026-01-15T08:52:58.000Z",
      }),
    );
    writeFileSync(
      join(dir(), `pr-${PR}-round-5.json`),
      JSON.stringify({
        version: 1,
        posting_key: key,
        marker: postingMarker(key),
        pr: PR,
        round_no: 5,
        head_sha: HEAD,
        intended_event: event,
        actual_event: event,
        status: "deferred",
        payload_sha256: sha,
        prepared_at: "2026-01-15T08:52:57.000Z",
        deferred_at: "2026-01-15T08:52:58.000Z",
        defer_reason: "GitHub answered 502; marker read: none",
      }),
    );
  }
  function retryConfirmed(intended: string, actual: string, state: string): void {
    writeFileSync(
      join(dir(), `pr-${PR}-round-5.json`),
      JSON.stringify({
        version: 1,
        posting_key: key,
        marker: postingMarker(key),
        pr: PR,
        round_no: 5,
        head_sha: HEAD,
        intended_event: intended,
        actual_event: actual,
        status: "confirmed",
        payload_sha256: "c".repeat(64),
        prepared_at: "2026-01-15T08:52:57.000Z",
        confirmed_at: clock.toISOString(),
        gh_review_id: REVIEW_ID,
        gh_commit_id: HEAD,
        gh_state: state,
        delivered_by: "daemon_retry",
      }),
    );
  }
  const verdictFile = (verdict: string) =>
    writeFileSync(
      join(verdictDir, `pr-${PR}-round-5.json`),
      JSON.stringify({
        pr: PR,
        round_no: 5,
        verdict,
        head_sha: HEAD,
        summary: "done",
        passes: [{ name: "pass-baseline", tier: "sol-med", findings: 0 }],
        finished_at: "2026-01-15T08:53:30Z",
      }),
    );

  it("no stage limit, deadline or verdict apply requeues, fails or kills it; the retry's confirmation settles it", async () => {
    writeDeferred("REQUEST_CHANGES");
    const { watcher, supervisor } = wire(true);
    verdictFile("REQUEST_CHANGES");
    set("2026-01-15T08:54:00.000Z");
    expect(await watcher.sweep()).toEqual([]); // waiting on the posting
    store.finishSessionCommand(CMD, "bridge-1", "acked"); // the session finished its round
    for (const at of ["2026-01-15T08:58:43.000Z", "2026-01-15T09:40:00.000Z"]) {
      set(at);
      await supervisor.scan();
      await watcher.checkDeadlines();
      expect(await watcher.sweep()).toEqual([]);
    }
    expect(round5().status).toBe("running");
    expect(killed).toEqual([]);
    expect(count("round_self_requeued")).toBe(0);
    expect(count("round_infrastructure_failure")).toBe(0);
    expect(store.openReviewFailure(PR)).toBeUndefined();
    // No review exists yet, so nothing claims the head.
    expect(store.reviewedHead(PR)).toBeUndefined();
    expect(store.getPr(PR)?.state).toBe("reviewing");

    set("2026-01-15T09:29:00.000Z");
    retryConfirmed("REQUEST_CHANGES", "REQUEST_CHANGES", "CHANGES_REQUESTED");
    store.recordReviewedHead(PR, { head_sha: HEAD, posted_event: "REQUEST_CHANGES" }); // the gate's after-step
    expect(await watcher.sweep()).toEqual([`pr-${PR}-round-5.json`]);
    expectOnePostingAndNothingOwed();
  });

  it("an exhausted retry fails the round loud (FAILED_LOUD hold), never a requeue", async () => {
    writeDeferred("REQUEST_CHANGES", "failed");
    store.adoptPostingRetry({
      posting_key: key,
      pr: PR,
      round_no: 5,
      head_sha: HEAD,
      first_failed_at: "2026-01-15T08:52:58.000Z",
      now: "2026-01-15T08:52:58.000Z",
    });
    store.settlePostingRetry(key, "exhausted", "GitHub 502 ×3", "2026-01-15T09:29:00.000Z");
    const { supervisor } = wire(true);
    set("2026-01-15T09:30:00.000Z");
    await supervisor.scan();
    expect(round5()).toMatchObject({ status: "cancelled" });
    expect(count("round_self_requeued")).toBe(0);
    const failure = store.openReviewFailure(PR);
    expect(failure).toBeDefined();
    expect(failure!.detail).toContain("exhausted after 0 attempt(s): GitHub 502 ×3");
    expect(postings()).toBe(0);
  });

  it("an APPROVE the gate softened at retry time (red CI) lands as a withheld approval", async () => {
    writeDeferred("APPROVE");
    const { watcher } = wire(true);
    verdictFile("APPROVE");
    set("2026-01-15T09:00:00.000Z");
    retryConfirmed("APPROVE", "COMMENT", "COMMENTED");
    expect(await watcher.sweep()).toEqual([`pr-${PR}-round-5.json`]);
    expect(round5()).toMatchObject({ status: "done", verdict: "APPROVE", posted_event: "COMMENT" });
    expect(store.approvalWithheld(PR)?.head_sha).toBe(HEAD);
    expect(count("posting_retry_approval_withheld")).toBe(1);
    expect(store.getPr(PR)?.state).toBe("tracked");
  });
});

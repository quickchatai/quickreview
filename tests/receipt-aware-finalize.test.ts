// A recorded live round, replayed through the REAL round-stage supervisor and
// the REAL verdict watcher (wired as daemon.ts wires them). Without the
// receipt check, the stage limit kills a round whose review is already
// posted, and the re-run posts a second one.
//
// The recorded timeline (UTC):
//   08:28:10.849  round 5 dispatched at head 8693fde (round_id 2485)
//   08:30:46 / 08:35:23  a human re-requests review → successor_required ×2
//   ~08:49:18     the last pass finishes
//   08:52:58.641  posting receipt CONFIRMED: REQUEST_CHANGES, review 5454096308
//   08:54:18.408  the supervisor's parent_finalize limit fires (5 min after
//                 the last pass) → cancelled infrastructure_failure, session
//                 killed, self-requeued "before any merits verdict"
//   09:08         round 6 re-reviews the same head; 09:29:32 a SECOND
//                 REQUEST_CHANGES (review 5454497864)
//
// The limit asks the receipt first: the review is on GitHub, so the session's
// tail gets its bounded grace and the round ends with ONE posting either way —
// the verdict file lands, or the grace runs out and the round settles from the
// receipt. With no receipt the limit cancels the round as an infrastructure
// failure, kills the session and requeues.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig, type Config } from "../src/config.js";
import type { GateResult } from "../src/gate.js";
import { postingMarker, roundPostingKey } from "../src/posting-receipt.js";
import type { RoundProgressSnapshot } from "../src/round-progress.js";
import { SessionCommandSupervisor } from "../src/session-command-supervisor.js";
import { standingReview } from "../src/standing-review.js";
import { StateStore } from "../src/state.js";
import type { SessionHooks } from "../src/types.js";
import { VerdictWatcher, type VerdictAdapter } from "../src/verdicts.js";
import { createHash } from "node:crypto";

const cfg: Config = parseConfig(
  readFileSync(resolve(process.cwd(), "tests/fixtures/config.toml"), "utf8"),
);

const PR = 5850;
const HEAD = "8693fde76890fb52717db6673473211d25d0bea9";
const CMD = "a6682740-5454-471f-b636-4e8d7de9bded";
const REVIEW_ID = 5454096308;

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
let roundId: number;

const set = (iso: string): void => {
  clock = new Date(iso);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "qcr-5850-"));
  verdictDir = join(root, "verdict");
  mkdirSync(verdictDir, { recursive: true });
  killed = [];
  set("2026-10-08T07:00:00.000Z");
  store = new StateStore(":memory:", () => clock);
  store.upsertPr({
    number: PR,
    state: "reviewing",
    head_sha: HEAD,
    title: "feat(api): import status and label filter",
    author: "pr-author",
    trigger_ts: "2026-10-08T08:15:46.079Z",
    stale_recheck: 0,
    migration_gate: 0,
  });
  // Rounds 1–4, decided and posted earlier.
  for (let k = 1; k <= 4; k++) {
    const id = store.startRound(PR, k === 1 ? "first" : "re-review", ["pass-baseline"], 75);
    store.finishRound(id, "REQUEST_CHANGES", null, null);
  }
  // 08:28:10.849 — round 5 dispatched; its command is accepted at 08:28:14.
  set("2026-10-08T08:28:10.849Z");
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
    next_check_at: "2026-10-08T08:30:10.849Z",
  });
  set("2026-10-08T08:28:14.000Z");
  store.claimSessionCommand(CMD, "bridge-1", "2026-10-08T08:30:14.000Z");
  store.markSessionCommandStarted(CMD, "bridge-1", "2026-10-08T09:13:14.000Z");
  // 08:30:46 and 08:35:23 — a human re-requests review while the round runs.
  set("2026-10-08T08:30:46.092Z");
  store.recordSuccessor({
    pr: PR,
    predecessor_round_id: roundId,
    head_sha: HEAD,
    provenance: "human",
    reason: "trigger-while-reviewing",
  });
  set("2026-10-08T08:35:23.128Z");
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
  set("2026-10-08T08:52:58.641Z");
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
      prepared_at: "2026-10-08T08:52:57.900Z",
      confirmed_at: "2026-10-08T08:52:58.641Z",
      gh_review_id: REVIEW_ID,
      gh_commit_id: HEAD,
      gh_state: "CHANGES_REQUESTED",
    }),
  );
  set("2026-10-08T08:52:58.724Z");
  store.recordReviewedHead(PR, { head_sha: HEAD, posted_event: "REQUEST_CHANGES" });
}

/** Round-progress v2 telemetry: every planned pass terminal by 08:49:18. */
function progress(): RoundProgressSnapshot {
  return {
    version: 2,
    pr: PR,
    session: `pr-${PR}`,
    run_started_at: "2026-10-08T08:28:14.000Z",
    updated_at: clock.toISOString(),
    parent_status: "active",
    command_id: CMD,
    command_sha256: "a".repeat(64),
    command_accepted_at: "2026-10-08T08:28:15.000Z",
    first_lens_started_at: "2026-10-08T08:31:15.582Z",
    last_activity_at: clock.toISOString(),
    last_activity: "writing the findings record",
    agents: [
      {
        execution_id: "lens-1:pass-baseline",
        agent: "pass-baseline--sol-med",
        status: "completed",
        duration_ms: 1,
        tool_count: 1,
        started_at: "2026-10-08T08:31:15.582Z",
        finished_at: "2026-10-08T08:44:02.000Z",
      },
      {
        execution_id: "lens-2:pass-validate",
        agent: "pass-validate--sol-high",
        status: "completed",
        duration_ms: 1,
        tool_count: 1,
        started_at: "2026-10-08T08:44:30.000Z",
        finished_at: "2026-10-08T08:49:18.408Z",
      },
    ],
  };
}

function wire(live = false): { watcher: VerdictWatcher; supervisor: SessionCommandSupervisor } {
  const hooks: SessionHooks = {
    async dispatchRound() {},
    async inject() {},
    async injectOverseer() {},
    async archiveAndClose() {},
    async killSession(pr) {
      killed.push(pr);
    },
    async sessionAlive() {
      return true;
    },
  };
  const watcher = new VerdictWatcher({
    cfg: live ? { ...cfg, dry_run: false } : cfg,
    store,
    adapter: new FakeAdapter(),
    hooks,
    verdictDir,
    root,
    usage: { globalStoreDir: null },
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

describe("#5850 round 5 replayed", () => {
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
    set("2026-10-08T08:54:18.408Z");
    await supervisor.scan();
    expect(round5().status).toBe("running");
    expect(killed).toEqual([]);
    set("2026-10-09T10:00:00.000Z");
    await watcher.checkDeadlines();
    expect(round5().status).toBe("running");
    expect(store.openReviewFailure(PR)).toBeUndefined();
    expect(count("round_self_requeued")).toBe(0);
    // Recovery confirmation is the same receipt the shell/worker writes.
    postReview();
    set("2026-10-09T10:30:00.000Z");
    await watcher.checkDeadlines();
    expectOnePostingAndNothingOwed();
  });

  it("the parent_finalize limit after a confirmed posting waits; the late verdict then lands — one posting", async () => {
    const { watcher, supervisor } = wire();
    postReview();

    // 08:54:18.408 — the limit fires.
    set("2026-10-08T08:54:18.408Z");
    await supervisor.scan();
    expect(round5().status).toBe("running");
    expect(killed).toEqual([]);
    expect(store.getSessionCommand(CMD)?.status).toBe("running");
    expect(count("round_stage_posted_wait")).toBe(1);
    expect(count("round_infrastructure_failure")).toBe(0);
    expect(count("round_self_requeued")).toBe(0);

    // Later scans inside the grace change nothing and log nothing new.
    set("2026-10-08T08:55:18.408Z");
    await supervisor.scan();
    expect(round5().status).toBe("running");
    expect(count("round_stage_posted_wait")).toBe(1);

    // 08:56:30 — the session's tail finishes: ledger, findings record, verdict.
    set("2026-10-08T08:56:30.000Z");
    writeFileSync(
      join(verdictDir, `pr-${PR}-round-5.json`),
      JSON.stringify({
        pr: PR,
        round_no: 5,
        verdict: "REQUEST_CHANGES",
        head_sha: HEAD,
        summary: "One blocker remains.",
        passes: [{ name: "pass-baseline", tier: "sol-med", findings: 2 }],
        finished_at: "2026-10-08T08:56:29Z",
      }),
    );
    expect(await watcher.sweep()).toEqual([`pr-${PR}-round-5.json`]);
    store.finishSessionCommand(CMD, "bridge-1", "acked"); // the parent settles

    set("2026-10-08T08:58:43.075Z");
    await supervisor.scan();
    expectOnePostingAndNothingOwed();
    expect(killed).toEqual([]); // the session was never killed
    expect(count("verdict_settled_from_receipt")).toBe(0); // the real verdict won
  });

  it("the session never writes its verdict: past the posted-tail grace the round settles from the receipt — one posting", async () => {
    const { supervisor } = wire();
    postReview();

    set("2026-10-08T08:54:18.408Z");
    await supervisor.scan();
    set("2026-10-08T09:07:58.000Z"); // confirmed + 14m59s: still inside
    await supervisor.scan();
    expect(round5().status).toBe("running");
    expect(killed).toEqual([]);

    set("2026-10-08T09:07:58.700Z"); // confirmed + 15 min
    await supervisor.scan();
    expectOnePostingAndNothingOwed();
    expect(count("verdict_settled_from_receipt")).toBe(1);
    expect(round5().summary).toContain("settled from the posted review");

    // The next scan releases the still-running command (the merits lifecycle
    // won) — the supervisor's ordinary terminal-round path.
    set("2026-10-08T09:08:58.700Z");
    await supervisor.scan();
    expect(killed).toEqual([PR]);
    expect(store.getSessionCommand(CMD)?.status).toBe("acked");
    expectOnePostingAndNothingOwed();
  });

  it("control — with NO receipt the old path still runs: cancelled as infrastructure, killed, requeued", async () => {
    const { supervisor } = wire();
    // No postReview(): nothing reached GitHub.

    set("2026-10-08T08:54:18.408Z");
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
});

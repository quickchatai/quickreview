// End-to-end daemon wiring: reconcile → queue → dispatch (trigger consumption
// through the dry-run gate) → stub round order on disk → verdict file picked
// up by the watcher → labels intents recorded → state machine lands. No
// network, no tmux: fake adapter + stub hooks + temp root.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { createDaemon, type DaemonAdapter } from "../src/daemon.js";
import type { GateResult } from "../src/gate.js";
import type { PrRef } from "../src/github.js";
import { PingPongLedger } from "../src/pingpong.js";
import { StateStore } from "../src/state.js";
import { postingMarker } from "../src/posting-receipt.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const PR = 101;

function fakeAdapter(recorded: string[], dryrunDir: string): DaemonAdapter {
  const gateResult = (kind: string): GateResult => {
    recorded.push(kind);
    writeFileSync(
      join(dryrunDir, `${Date.now()}-${recorded.length}-${kind}.json`),
      JSON.stringify({ kind }),
    );
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

describe("daemon wiring", () => {
  let root: string;
  let store: StateStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "qcr-daemon-"));
    for (const d of ["state", "state/dryrun", "verdict", "inject"]) {
      mkdirSync(join(root, d), { recursive: true });
    }
    store = new StateStore(":memory:");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it(
    "recovers a blocked author's PR objection, answers it, and retains evidence in an explicitly requested round",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const cfg = {
        ...loadConfig(join(process.cwd(), "tests/fixtures/config.toml")),
        dry_run: true,
      };
      const adapter = fakeAdapter([], join(root, "state", "dryrun"));
      adapter.searchLabelTriggered = async () => [];
      adapter.getRequestedReviewers = async () => ({ users: [], teams: [] });
      adapter.createIssueComment = vi.fn(async () => ({
        executed: false,
        dryRunFile: "answer.json",
      }));
      adapter.listIssueComments = async () => [];
      const inject = vi.fn(async () => {});
      const dispatchRound = vi.fn(async (_order: unknown, _prompt: string) => {});
      store.upsertPr({
        number: PR,
        state: "awaiting_author",
        head_sha: "headsha1",
        title: "test PR",
        author: "someone",
        trigger_ts: null,
        stale_recheck: 0,
        migration_gate: 0,
      });
      store.recordReviewedHead(PR, { head_sha: "headsha1", verdict: "REQUEST_CHANGES" });
      store.recordPrComment({
        pr: PR,
        source: "issue_comment",
        comment_id: 900001,
        author: "someone",
        body: "This predates the PR; please reconsider",
        created_at: new Date(Date.now() + 1000).toISOString(),
      });
      const daemon = createDaemon({
        cfg,
        root,
        store,
        adapter,
        listen: false,
        log: () => {},
        now: () => new Date(Date.now() + 2000),
        hooks: { inject, dispatchRound, async injectOverseer() {}, async archiveAndClose() {} },
      });
      await daemon.reconcile();
      expect(inject).toHaveBeenCalledOnce();
      expect(dispatchRound).not.toHaveBeenCalled();
      writeFileSync(
        join(root, "verdict", `pr-${PR}-conversation-comment-900001.json`),
        JSON.stringify({
          pr: PR,
          comment_id: 900001,
          reply: "I concede this pre-existing finding; please explicitly request a fresh review.",
        }),
      );
      await daemon.reconcile();
      expect(adapter.createIssueComment).toHaveBeenCalledOnce();
      expect(store.getPr(PR)?.state).toBe("awaiting_author");
      expect(dispatchRound).not.toHaveBeenCalled();
      store.db
        .prepare("UPDATE pr_state SET state='queued', trigger_ts=? WHERE number=?")
        .run(new Date().toISOString(), PR);
      await daemon.pump();
      expect(dispatchRound).toHaveBeenCalledOnce();
      expect(dispatchRound.mock.calls[0]?.[1]).toContain("This predates the PR");
      expect(dispatchRound.mock.calls[0]?.[1]).toContain("I concede this pre-existing finding");
    },
  );

  // The production daemon supplies the ledger carry from
  // ledger-pin's mirror at state/ledgers/pr-<n>.md — the order re-hands it and
  // its SETTLED items become the digest; no file ⇒ neither.
  it(
    "re-hands the PR's mirrored ledger in the round order",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const cfg = {
        ...loadConfig(join(process.cwd(), "tests/fixtures/config.toml")),
        dry_run: true,
      };
      const ledger = `LEDGER PR #${PR} @ headsha1\nF1 [P1/0.9][delivery] src/app.ts:3 — x → open thread:9\nSETTLED: T2: conceded`;
      mkdirSync(join(root, "state", "ledgers"), { recursive: true });
      writeFileSync(join(root, "state", "ledgers", `pr-${PR}.md`), `${ledger}\n`);
      const dispatchRound = vi.fn(async (_order: unknown, _prompt: string) => {});
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
        cfg,
        root,
        store,
        adapter: fakeAdapter([], join(root, "state", "dryrun")),
        listen: false,
        log: () => {},
        hooks: {
          inject: async () => {},
          dispatchRound,
          async injectOverseer() {},
          async archiveAndClose() {},
        },
      });
      await daemon.pump();
      expect(dispatchRound).toHaveBeenCalledOnce();
      const order = dispatchRound.mock.calls[0]![0] as {
        ledger_carry?: { source: string; text: string };
        settled_digest: string;
      };
      expect(order.ledger_carry?.source).toBe(join(root, "state", "ledgers", `pr-${PR}.md`));
      expect(order.ledger_carry?.text).toBe(ledger);
      expect(order.settled_digest).toBe("- T2: conceded");
    },
  );

  it(
    "no ledger file ⇒ no carry and an empty digest, and the round still dispatches",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const cfg = {
        ...loadConfig(join(process.cwd(), "tests/fixtures/config.toml")),
        dry_run: true,
      };
      const dispatchRound = vi.fn(async (_order: unknown, _prompt: string) => {});
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
        cfg,
        root,
        store,
        adapter: fakeAdapter([], join(root, "state", "dryrun")),
        listen: false,
        log: () => {},
        hooks: {
          inject: async () => {},
          dispatchRound,
          async injectOverseer() {},
          async archiveAndClose() {},
        },
      });
      await daemon.pump();
      expect(dispatchRound).toHaveBeenCalledOnce();
      const order = dispatchRound.mock.calls[0]![0] as Record<string, unknown>;
      expect("ledger_carry" in order).toBe(false);
      expect(order.settled_digest).toBe("");
    },
  );

  // Boot order: the first reconcile can
  // nudge a recheck at a dead session immediately; the respawn path needs the
  // title resolver wired by onStart, so onStart must run BEFORE the sweep.
  it("runs onStart before the first reconcile", { timeout: HEAVY_TIMEOUT_MS }, async () => {
    const order: string[] = [];
    const recorded: string[] = [];
    const adapter = fakeAdapter(recorded, join(root, "state", "dryrun"));
    const listPrs = adapter.listOpenPrs.bind(adapter);
    adapter.listOpenPrs = async (...a: Parameters<typeof listPrs>) => {
      order.push("reconcile");
      return listPrs(...a);
    };
    const daemon = createDaemon({
      cfg: { ...loadConfig(join(process.cwd(), "tests/fixtures/config.toml")), dry_run: true },
      root,
      store,
      adapter,
      listen: false,
      log: () => {},
      onStart: () => {
        order.push("onStart");
      },
    });
    await daemon.start();
    try {
      expect(order[0]).toBe("onStart");
      expect(order).toContain("reconcile");
    } finally {
      await daemon.stop();
    }
  });

  // A throw in onStart (Slack auth.test refusing, a malformed profile pack,
  // tmux preflight) fails start(): if it were swallowed, reconcile and the
  // pump would run on while the command watchers and the EOD timer — built
  // later in the same onStart — never existed. A half-assembled daemon must
  // not start.
  it("an onStart failure fails start() — no reconcile, no half-assembled daemon", async () => {
    const order: string[] = [];
    const recorded: string[] = [];
    const adapter = fakeAdapter(recorded, join(root, "state", "dryrun"));
    const listPrs = adapter.listOpenPrs.bind(adapter);
    adapter.listOpenPrs = async (...a: Parameters<typeof listPrs>) => {
      order.push("reconcile");
      return listPrs(...a);
    };
    const daemon = createDaemon({
      cfg: { ...loadConfig(join(process.cwd(), "tests/fixtures/config.toml")), dry_run: true },
      root,
      store,
      adapter,
      listen: false,
      log: () => {},
      onStart: () => {
        throw new Error("slack: auth.test failed — refusing to start");
      },
    });
    try {
      await expect(daemon.start()).rejects.toThrow(/auth\.test failed/);
      expect(order).not.toContain("reconcile");
    } finally {
      await daemon.stop();
    }
  });

  it(
    "runs reconcile → dispatch → verdict apply end to end in dry-run",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const recorded: string[] = [];
      const daemon = createDaemon({
        cfg: { ...loadConfig(join(process.cwd(), "tests/fixtures/config.toml")), dry_run: true }, // the test exercises dry-run machinery regardless of the shipped flag
        root,
        store,
        adapter: fakeAdapter(recorded, join(root, "state", "dryrun")),
        listen: false,
        log: () => {},
      });

      await daemon.start();
      try {
        // Reconcile (run by start) queued the triggered PR; dispatch consumed
        // the triggers and moved it to reviewing.
        expect(store.getPr(PR)?.state).toBe("reviewing");
        expect(recorded).toContain("remove_label");
        expect(recorded).toContain("delete_team_review_request");
        expect(recorded).toContain("add_label"); // AI review in progress on

        // Stub hooks wrote the round order to disk.
        const orders = readdirSync(join(root, "state", "round-orders"));
        expect(orders.length).toBe(1);

        // Session posts through the guarded dry-run route, whose receipt is the
        // prerequisite for accepting the verdict.
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

        // Session finishes: verdict file appears; the watcher applies it.
        writeFileSync(
          join(root, "verdict", `pr-${PR}-round-1.json`),
          JSON.stringify({
            pr: PR,
            round_no: 1,
            verdict: "APPROVE",
            head_sha: "headsha1",
            spend_usd: 1.25,
            finished_at: new Date().toISOString(),
          }),
        );
        await vi.waitFor(() => expect(store.getPr(PR)?.state).toBe("tracked"), {
          timeout: 5000,
          interval: 50,
        });

        const round = store.db
          .prepare("SELECT verdict, spend_usd, status FROM rounds WHERE pr = ?")
          .get(PR) as any;
        expect(round.verdict).toBe("APPROVE");
        expect(round.spend_usd).toBeNull(); // self-reported spend is fiction — never stored
        expect(round.status).toBe("done");

        // status.json exists and reports dry-run.
        const status = JSON.parse(readFileSync(join(root, "state", "status.json"), "utf8"));
        expect(status.dry_run).toBe(true);
      } finally {
        await daemon.stop();
      }
    },
  );

  it(
    "complete pre-fanout failure chain self-heals through the daemon without duplicate ownership",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      let clock = new Date("2026-09-02T15:00:00.000Z");
      store.close();
      store = new StateStore(":memory:", () => clock);
      store.upsertPr({
        number: PR,
        state: "queued",
        head_sha: "headsha1",
        title: "test PR",
        author: "someone",
        trigger_ts: clock.toISOString(),
        trigger_provenance: "human",
        stale_recheck: 0,
        migration_gate: 0,
      });
      mkdirSync(join(root, "state", "round-progress"), { recursive: true });
      const recorded: string[] = [];
      const orders: Array<{
        round_no: number;
        head_sha: string;
        lenses: string[];
        recovery?: unknown;
      }> = [];
      const killed: number[] = [];
      const loaded = loadConfig(join(process.cwd(), "tests/fixtures/config.toml"));
      const cfg = {
        ...loaded,
        dry_run: true,
        daemon: {
          ...loaded.daemon,
          max_self_requeues: 2,
          round_first_pass_max_min: 5,
          round_passes_max_min: 35,
          session_command_running_max_min: 45,
        },
      };
      const daemon = createDaemon({
        cfg,
        root,
        store,
        adapter: fakeAdapter(recorded, join(root, "state", "dryrun")),
        hooks: {
          async dispatchRound(order) {
            orders.push(order);
            store.createSessionCommand({
              id: `cmd-${order.round_no}`,
              pr: order.pr,
              session: `pr-${order.pr}`,
              kind: "round",
              round_no: order.round_no,
              payload_sha256: `${order.round_no}`.repeat(64),
              payload_path: `/payload/${order.round_no}.md`,
              inject_path: `/inject/${order.round_no}.md`,
              next_check_at: clock.toISOString(),
            });
          },
          async inject() {},
          async injectOverseer() {},
          async archiveAndClose() {},
          async killSession(pr) {
            killed.push(pr);
          },
        },
        now: () => clock,
        listen: false,
        log: () => {},
      });
      const accept = (roundNo: number, withFanout = false): void => {
        const id = `cmd-${roundNo}`;
        const next = new Date(clock.getTime() + 45 * 60_000).toISOString();
        expect(store.claimSessionCommand(id, `owner-${roundNo}`, next)).toBeDefined();
        expect(store.markSessionCommandStarted(id, `owner-${roundNo}`, next)).toBe(true);
        const discovery = orders
          .find((order) => order.round_no === roundNo)!
          .lenses.find((lens) => lens !== "pass-validate")!;
        writeFileSync(
          join(root, "state", "round-progress", `pr-${PR}.json`),
          JSON.stringify({
            version: 2,
            pr: PR,
            session: `pr-${PR}`,
            run_started_at: clock.toISOString(),
            updated_at: clock.toISOString(),
            parent_status: "active",
            command_id: id,
            command_sha256: `${roundNo}`.repeat(64),
            command_accepted_at: clock.toISOString(),
            preparing_at: clock.toISOString(),
            round_no: roundNo,
            head_sha: "headsha1",
            ...(withFanout
              ? {
                  first_lens_started_at: clock.toISOString(),
                  fanout_started_at: clock.toISOString(),
                }
              : {}),
            last_activity_at: clock.toISOString(),
            last_activity: withFanout ? `${discovery} running` : "compact context preparation",
            agents: withFanout
              ? [
                  {
                    execution_id: `fanout-${roundNo}:${discovery}`,
                    agent: `${discovery}--sol-med`,
                    status: "running",
                    duration_ms: 0,
                    tool_count: 0,
                    started_at: clock.toISOString(),
                  },
                ]
              : [],
          }),
        );
      };

      await daemon.pump();
      for (const roundNo of [1, 2, 3]) {
        expect(orders.at(-1)?.round_no).toBe(roundNo);
        accept(roundNo);
        clock = new Date(clock.getTime() + 5 * 60_000);
        await daemon.scanRoundStages();
        if (roundNo < 3) await daemon.pump();
      }

      const debt = store.openReviewFailure(PR)!;
      expect(debt).toMatchObject({
        stage: "first_pass_start",
        next_action: "retry_wait",
        attempts: 2,
      });
      expect(debt.next_retry_at).toBe(new Date(clock.getTime() + 15 * 60_000).toISOString());
      expect(killed).toEqual([PR, PR, PR]);
      expect(store.runningRounds()).toHaveLength(0);

      clock = new Date(debt.next_retry_at!);
      expect(await daemon.retryDueReviewFailures()).toBe(1);
      expect(orders.at(-1)).toMatchObject({
        round_no: 4,
        head_sha: "headsha1",
        recovery: expect.any(Object),
      });
      accept(4, true);
      await daemon.scanRoundStages();

      expect(store.runningRounds()).toHaveLength(1);
      expect(store.runningRounds()[0]).toMatchObject({
        round_no: 4,
        fanout_started_at: clock.toISOString(),
      });
      expect(store.selfRequeueCount(PR, "headsha1")).toBe(0);
      expect(store.openReviewFailure(PR)).toBeUndefined();
      expect(
        (
          store.db.prepare("SELECT COUNT(*) AS c FROM session_commands WHERE pr=?").get(PR) as {
            c: number;
          }
        ).c,
      ).toBe(4);
      expect(recorded).not.toContain("create_review");
      expect(await daemon.retryDueReviewFailures()).toBe(0);
      expect(orders).toHaveLength(4);
    },
  );

  it(
    "due retry re-enters the one dispatch pump exactly once",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      let clock = new Date("2026-09-02T15:00:00.000Z");
      store.close();
      store = new StateStore(":memory:", () => clock);
      store.upsertPr({
        number: PR,
        state: "reviewing",
        head_sha: "headsha1",
        title: "test PR",
        author: "someone",
        trigger_ts: "2026-09-02T14:00:00.000Z",
        trigger_provenance: "human",
        stale_recheck: 0,
        migration_gate: 0,
      });
      const sourceRound = store.startRound(PR, "re-review", ["pass-baseline", "pass-validate"], 75);
      store.stampPostingKey(sourceRound, `v1:${PR}:1:headsha1`);
      store.createSessionCommand({
        id: "cmd-prepass",
        pr: PR,
        session: `pr-${PR}`,
        kind: "round",
        round_no: 1,
        payload_sha256: "a".repeat(64),
        payload_path: "/payload/source.md",
        inject_path: "/inject/source.md",
        next_check_at: clock.toISOString(),
      });
      const failure = store.terminalizeInfrastructureReviewFailure({
        pr: PR,
        round_id: sourceRound,
        round_no: 1,
        command_id: "cmd-prepass",
        head_sha: "headsha1",
        stage: "first_pass_start",
        detail: "accepted preparation launched no planned discovery lens",
        attempts: 2,
        retry_cap: 2,
        summary: "bounded pre-fanout recovery exhausted",
      })!;
      expect(failure.next_retry_at).toBe("2026-09-02T15:15:00.000Z");

      const recorded: string[] = [];
      const orders: Array<{ round_no: number; head_sha: string; recovery?: unknown }> = [];
      const daemon = createDaemon({
        cfg: { ...loadConfig(join(process.cwd(), "tests/fixtures/config.toml")), dry_run: true },
        root,
        store,
        adapter: fakeAdapter(recorded, join(root, "state", "dryrun")),
        hooks: {
          async dispatchRound(order) {
            orders.push(order);
            store.createSessionCommand({
              id: `cmd-target-${order.round_no}`,
              pr: order.pr,
              session: `pr-${order.pr}`,
              kind: "round",
              round_no: order.round_no,
              payload_sha256: "b".repeat(64),
              payload_path: `/payload/${order.round_no}.md`,
              inject_path: `/inject/${order.round_no}.md`,
              next_check_at: clock.toISOString(),
            });
          },
          async inject() {},
          async injectOverseer() {},
          async archiveAndClose() {},
        },
        listen: false,
        log: () => {},
      });

      clock = new Date("2026-09-02T15:15:00.000Z");
      expect(await daemon.retryDueReviewFailures()).toBe(1);
      expect(orders).toEqual([
        expect.objectContaining({
          round_no: 2,
          head_sha: "headsha1",
          recovery: expect.any(Object),
        }),
      ]);
      expect(store.roundsFor(PR)).toMatchObject([
        { round_no: 1, status: "cancelled" },
        { round_no: 2, status: "running" },
      ]);
      expect(store.getSessionCommand("cmd-prepass")?.status).toBe("cancelled");
      expect(store.getSessionCommand("cmd-target-2")?.status).toBe("pending");
      expect(store.openReviewFailure(PR)).toBeUndefined();
      expect(recorded).not.toContain("create_review");

      // Same due tick (or a concurrent timer) owns neither another round nor
      // another Pi command after the first transaction consumed the debt.
      expect(await daemon.retryDueReviewFailures()).toBe(0);
      expect(orders).toHaveLength(1);
    },
  );

  /**
   * The author's "I want a human" is recorded, not dropped.
   *
   * `human_requested` reaches `applyEvent`, whose transition returns `current`,
   * and `applyEvent` only logs a `pr_transition` on a change — so without its
   * own record the request would leave no trace any surface reads. It is
   * recorded durably (quiet tier — DB + heartbeat, no wake), and it is never a
   * handover: there is no park.
   */
  it(
    "records an author's request for a human as a durable anomaly, and still never parks",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const recorded: string[] = [];
      const daemon = createDaemon({
        cfg: { ...loadConfig(join(process.cwd(), "tests/fixtures/config.toml")), dry_run: true },
        root,
        store,
        adapter: fakeAdapter(recorded, join(root, "state", "dryrun")),
        listen: false,
        log: () => {},
      });
      await daemon.start();
      try {
        const stateBefore = store.getPr(PR)!.state;
        // The watcher only accepts a decision for a CLAIMED author message.
        new PingPongLedger(store.db).claimAuthorMessage({
          pr: PR,
          comment_id: 5001,
          in_reply_to_id: 4000,
          path: "src/app.ts",
          body: "can a person look at this?",
          author: "alice",
        });
        // `keep_open` with an empty reply, so nothing but the human-request
        // branch runs: no GitHub reply, no thread resolve.
        writeFileSync(
          join(root, "verdict", `pr-${PR}-thread-4000-comment-5001.json`),
          JSON.stringify({
            pr: PR,
            thread_id: 4000,
            comment_id: 5001,
            resolution: "keep_open",
            reply: "",
            reason: "author asked for a person",
            human_requested: true,
          }),
        );
        daemon.wakeThreadDecisions();

        const deadline = Date.now() + 5_000;
        while (store.anomalies().length === 0 && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 20));
        }

        expect(store.anomalies()).toMatchObject([{ kind: "human_requested", pr: PR }]);
        expect(store.anomalies()[0]!.detail).toContain("No handover exists");
        expect(store.anomalies()[0]!.detail).toContain("author asked for a person");
        // …and no handover happened: no park state, no reviewer nomination.
        expect(store.getPr(PR)!.state).toBe(stateBefore);
        expect(store.getPr(PR)!.state).not.toBe("awaiting_human");
        expect(recorded).not.toContain("request_reviewer");
      } finally {
        await daemon.stop();
      }
    },
  );
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseConfig, type Config } from "../src/config.js";
import { sessionCommandMarker } from "../src/session-command.js";
import { SessionCommandSupervisor } from "../src/session-command-supervisor.js";
import { StateStore } from "../src/state.js";
import type {
  RoundRecoveryDisposition,
  SessionCommandObservation,
  SessionHooks,
} from "../src/types.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const baseCfg: Config = parseConfig(
  readFileSync(resolve(process.cwd(), "tests/fixtures/config.toml"), "utf8"),
);

let root: string;
let verdictDir: string;
let clock: Date;
let store: StateStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "qcr-command-supervisor-"));
  verdictDir = join(root, "verdict");
  mkdirSync(verdictDir, { recursive: true });
  clock = new Date("2026-08-27T20:05:00.000Z");
  store = new StateStore(":memory:", () => clock);
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

function seedRoundCommand(
  opts: {
    id?: string;
    pr?: number;
    status?: "pending" | "running" | "acked";
    started?: boolean;
    attempt?: number;
    nextCheckAt?: string;
    lenses?: string[];
  } = {},
) {
  const id = opts.id ?? "cmd-1";
  const pr = opts.pr ?? 5408;
  store.upsertPr({
    number: pr,
    state: "reviewing",
    head_sha: "abc123",
    title: `PR ${pr}`,
    author: "alice",
    trigger_ts: null,
    stale_recheck: 0,
    migration_gate: 0,
  });
  const roundId = store.startRound(
    pr,
    "first",
    opts.lenses ?? ["pass-baseline"],
    baseCfg.daemon.round_deadline_min,
  );
  store.stampPostingKey(roundId, `v1:${pr}:1:abc123`);
  const round = store.roundsFor(pr)[0]!;
  store.createSessionCommand({
    id,
    pr,
    session: `pr-${pr}`,
    kind: "round",
    round_no: round.round_no,
    payload_sha256: "a".repeat(64),
    payload_path: join(root, "state", "session-commands", `${id}.md`),
    inject_path: join(root, "inject", `pr-${pr}`, `wake--cmd-${id}.md`),
    next_check_at: opts.nextCheckAt ?? "2026-08-27T20:04:00.000Z",
  });
  if (opts.status === "running" || opts.status === "acked") {
    store.claimSessionCommand(id, "bridge-1", opts.nextCheckAt ?? "2026-08-27T20:04:00.000Z");
    if (opts.started || opts.status === "acked") {
      store.markSessionCommandStarted(
        id,
        "bridge-1",
        opts.nextCheckAt ?? "2026-08-27T20:04:00.000Z",
      );
    }
    if (opts.status === "acked") store.finishSessionCommand(id, "bridge-1", "acked");
  }
  if (opts.attempt !== undefined)
    store.db.prepare("UPDATE session_commands SET attempt=? WHERE id=?").run(opts.attempt, id);
  return { id, pr, roundId, round };
}

function seedWakeCommand(
  opts: {
    id?: string;
    pr?: number;
    status?: "pending" | "running" | "failed";
    startedAt?: string;
    attempt?: number;
    nextCheckAt?: string;
  } = {},
) {
  const id = opts.id ?? "wake-1";
  const pr = opts.pr ?? 5454;
  store.upsertPr({
    number: pr,
    state: "queued",
    head_sha: "abc123",
    title: `PR ${pr}`,
    author: "alice",
    trigger_ts: clock.toISOString(),
    stale_recheck: 0,
    migration_gate: 0,
  });
  store.createSessionCommand({
    id,
    pr,
    session: `pr-${pr}`,
    kind: "wake",
    round_no: null,
    payload_sha256: "b".repeat(64),
    payload_path: join(root, "state", "session-commands", `${id}.md`),
    inject_path: join(root, "inject", `pr-${pr}`, `wake--cmd-${id}.md`),
    next_check_at: opts.nextCheckAt ?? "2026-08-27T19:45:00.000Z",
  });
  if (opts.status === "running" || opts.status === "failed") {
    store.claimSessionCommand(id, "bridge-1", opts.nextCheckAt ?? "2026-08-27T19:45:00.000Z");
    if (opts.startedAt) {
      store.markSessionCommandStarted(
        id,
        "bridge-1",
        opts.nextCheckAt ?? "2026-08-27T19:45:00.000Z",
      );
      store.db
        .prepare("UPDATE session_commands SET started_at=? WHERE id=?")
        .run(opts.startedAt, id);
    }
    if (opts.status === "failed") store.failActiveSessionCommand(id, "pre-fix failed wake");
  }
  if (opts.attempt !== undefined)
    store.db.prepare("UPDATE session_commands SET attempt=? WHERE id=?").run(opts.attempt, id);
  return { id, pr };
}

function hooks(overrides: Partial<SessionHooks> = {}): SessionHooks {
  return {
    async dispatchRound() {},
    async inject() {},
    async injectOverseer() {},
    async archiveAndClose() {},
    ...overrides,
  };
}

type RoundFailureHandler = (
  pr: number,
  roundNo: number,
  stage: string,
  detail: string,
) => Promise<RoundRecoveryDisposition>;

function supervisor(
  h: SessionHooks,
  // Typed by the REAL callback shape and disposition union, not inferred from
  // the default's one literal.
  onRoundFailure: ReturnType<typeof vi.fn<RoundFailureHandler>> = vi.fn<RoundFailureHandler>(
    async () => "requeued",
  ),
  cfg = baseCfg,
  progress?: () => import("../src/round-progress.js").RoundProgressSnapshot | undefined,
) {
  return {
    supervisor: new SessionCommandSupervisor({
      cfg,
      store,
      hooks: h,
      verdictDir,
      onRoundFailure,
      now: () => clock,
      progress,
    }),
    onRoundFailure,
  };
}

describe("bounded round-stage supervision", () => {
  it(
    "replays a started ordinary wake at its hard bound instead of making it a permanent blocker",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const { id, pr } = seedWakeCommand({
        status: "running",
        startedAt: "2026-08-27T19:00:00.000Z",
        nextCheckAt: "2026-08-27T19:45:00.000Z",
      });
      const retry = vi.fn(async () => {
        store.retrySessionCommandAfterFence(id, 1, clock.toISOString());
        store.claimSessionCommand(id, "bridge-new", clock.toISOString());
        return "retried" as const;
      });

      await supervisor(hooks({ retrySessionCommand: retry })).supervisor.scan();

      expect(retry).toHaveBeenCalledWith(
        id,
        expect.stringContaining("fixed 45-minute running bound"),
      );
      expect(store.getSessionCommand(id)).toMatchObject({ status: "running", attempt: 2 });
      const recovery = store
        .recentEvents(20)
        .find((event) => event.kind === "session_command_nonround_recovery");
      expect(JSON.parse(recovery!.payload!)).toMatchObject({
        recovery_attempt: 1,
        delivery_attempt: 2,
      });
      expect(store.openReviewFailure(pr)).toBeUndefined();
    },
  );

  it("recovers the pre-fix failed ordinary-wake rows that used to disappear from supervision", async () => {
    const { id } = seedWakeCommand({ status: "failed", attempt: 1 });
    const retry = vi.fn(async () => "retried" as const);

    await supervisor(hooks({ retrySessionCommand: retry })).supervisor.scan();

    expect(retry).toHaveBeenCalledWith(id, "pre-fix failed wake");
    expect(store.getSessionCommand(id)).toMatchObject({ status: "failed", recovery_attempts: 1 });
  });

  it("fails supervisor health without consuming recovery when the production retry hook is missing", async () => {
    const { id, pr } = seedWakeCommand({ status: "failed", attempt: 1 });
    const kill = vi.fn(async () => {});
    const s = supervisor(hooks({ killSession: kill })).supervisor;

    await expect(s.scan()).rejects.toThrow(/retry hook unavailable/);

    expect(kill).not.toHaveBeenCalled();
    expect(store.getSessionCommand(id)).toMatchObject({ status: "failed", recovery_attempts: 0 });
    expect(store.openReviewFailure(pr)).toBeUndefined();
    expect(s.health()).toMatchObject({
      healthy: false,
      last_error: expect.stringContaining("retry hook unavailable"),
    });
  });

  it("stops automatic non-round recovery after finite failed process births", async () => {
    const { id, pr } = seedWakeCommand({ status: "failed", attempt: 1 });
    const retry = vi.fn(async () => {
      store.retrySessionCommandAfterFence(id, 1, clock.toISOString());
      store.noteSessionCommandRecoveryFailure(id, "bridge ledger_open: database unavailable");
      return "retry_failed" as const;
    });
    const kill = vi.fn(async () => {});
    const immediateEvidenceCfg: Config = {
      ...baseCfg,
      daemon: { ...baseCfg.daemon, session_command_unknown_max_checks: 0 },
    };
    const s = supervisor(
      hooks({ retrySessionCommand: retry, killSession: kill }),
      undefined,
      immediateEvidenceCfg,
    ).supervisor;

    await expect(s.scan()).rejects.toThrow(/recovery failed before replay/);
    await expect(s.scan()).rejects.toThrow(/recovery failed before replay/);
    await s.scan();

    expect(retry).toHaveBeenCalledTimes(2);
    expect(kill).toHaveBeenCalledWith(pr);
    expect(store.getSessionCommand(id)?.status).toBe("failed");
    expect(store.openReviewFailure(pr)).toMatchObject({
      command_id: id,
      stage: "session_command",
      attempts: 2,
      retry_cap: 2,
      work_owed: 1,
      detail: "bridge ledger_open: database unavailable",
    });
    expect(store.dueSessionCommands(clock.toISOString())).toEqual([]);
  });

  it("attempt-zero rebirths fail precisely and keep four wakes plus queued work blocked", async () => {
    const { id, pr } = seedWakeCommand({ status: "failed", attempt: 0 });
    for (let n = 1; n <= 4; n++)
      store.holdWake(pr, `# Author reply — PR #${pr}\n\nreply ${n}`, "author_reply");
    const retry = vi.fn(async () => {
      store.retrySessionCommandAfterFence(id, 0, clock.toISOString());
      store.noteSessionCommandRecoveryFailure(
        id,
        "timed out waiting for matching bridge readiness before reservation",
      );
      return "retry_failed" as const;
    });
    const kill = vi.fn(async () => {});
    const immediateEvidenceCfg: Config = {
      ...baseCfg,
      daemon: { ...baseCfg.daemon, session_command_unknown_max_checks: 0 },
    };
    const s = supervisor(
      hooks({
        wakeReceiptPresent: async () => null,
        sessionAlive: async () => true,
        retrySessionCommand: retry,
        killSession: kill,
      }),
      undefined,
      immediateEvidenceCfg,
    ).supervisor;

    await expect(s.scan()).rejects.toThrow(/matching bridge readiness/);
    await expect(s.scan()).rejects.toThrow(/matching bridge readiness/);
    await s.scan();

    expect(retry).toHaveBeenCalledTimes(2);
    expect(kill).toHaveBeenCalledWith(pr);
    expect(store.getSessionCommand(id)).toMatchObject({
      status: "failed",
      attempt: 0,
      recovery_attempts: 2,
    });
    expect(store.heldWakes(pr)).toHaveLength(4);
    expect(store.getPr(pr)?.state).toBe("queued");
    expect(store.blockingSessionCommand(`pr-${pr}`)).toBeTruthy();
    expect(store.openReviewFailure(pr)).toMatchObject({
      command_id: id,
      work_owed: 1,
      detail: "timed out waiting for matching bridge readiness before reservation",
    });
  });

  it("does not reopen failed-loud debt when operator cancellation wins the exhaustion fence", async () => {
    const { id, pr } = seedWakeCommand({ status: "failed", attempt: 1 });
    store.db.prepare("UPDATE session_commands SET recovery_attempts=2 WHERE id=?").run(id);
    const kill = vi.fn(async () => {
      store.db.prepare("UPDATE session_commands SET status='cancelled' WHERE id=?").run(id);
    });

    await supervisor(hooks({ killSession: kill })).supervisor.scan();

    expect(kill).toHaveBeenCalledWith(pr);
    expect(store.getSessionCommand(id)?.status).toBe("cancelled");
    expect(store.openReviewFailure(pr)).toBeUndefined();
  });

  it("cancels an obsolete unstarted predecessor through bounded recovery", async () => {
    const { id, pr, roundId, round } = seedRoundCommand({
      status: "pending",
      nextCheckAt: "2026-08-27T20:45:00.000Z",
    });
    store.recordSuccessor({
      pr,
      predecessor_round_id: roundId,
      head_sha: "fresh-head",
      provenance: "system",
      reason: "push",
    });
    const onRoundFailure = vi.fn(async () => "requeued" as const);

    await supervisor(hooks({ killSession: async () => {} }), onRoundFailure).supervisor.scan();

    expect(onRoundFailure).toHaveBeenCalledWith(
      pr,
      round.round_no,
      "command_start",
      expect.stringContaining("superseded before command start"),
    );
    expect(store.getSessionCommand(id)?.status).toBe("failed");
  });

  it("lets an already-started predecessor finish while retaining fresh-head work", async () => {
    const { id, pr, roundId } = seedRoundCommand({
      status: "running",
      started: true,
      nextCheckAt: "2026-08-27T20:45:00.000Z",
    });
    store.recordSuccessor({
      pr,
      predecessor_round_id: roundId,
      head_sha: "fresh-head",
      provenance: "system",
      reason: "push",
    });
    const onRoundFailure = vi.fn(async () => "requeued" as const);

    await supervisor(hooks(), onRoundFailure).supervisor.scan();

    expect(onRoundFailure).not.toHaveBeenCalled();
    expect(store.getSessionCommand(id)?.status).toBe("running");
    expect(store.successorFor(pr)?.head_sha).toBe("fresh-head");
  });

  it("retries the same unstarted command after definitive missing-start evidence", async () => {
    const { id, pr } = seedRoundCommand({ status: "running" });
    const retried: string[] = [];
    const h = hooks({
      wakeReceiptPresent: async (_pr, marker) => {
        expect(marker).toBe(sessionCommandMarker(id, "a".repeat(64)));
        return false;
      },
      sessionAlive: async () => true,
      retrySessionCommand: async (commandId) => {
        retried.push(commandId);
        return "retried";
      },
    });

    await supervisor(h).supervisor.scan();

    expect(retried).toEqual([id]);
    expect(store.getSessionCommand(id)?.status).toBe("running"); // the hook owns fail→retry; this fake only records
    expect(events("session_command_start_recovery")).toMatchObject([
      {
        pr,
        payload: { command_id: id, recovery_attempt: 1, delivery_attempt: 1 },
      },
    ]);
  });

  it("bounds round rebirths even when no bridge generation ever reserves the command", async () => {
    const { id, pr, round } = seedRoundCommand({ status: "running" });
    const retry = vi.fn(async () => {
      store.retrySessionCommandAfterFence(id, 1, clock.toISOString());
      store.noteSessionCommandRecoveryFailure(id, "inject bridge generation failed at ledger_open");
      return "retry_failed" as const;
    });
    const onRoundFailure = vi.fn(async () => "requeued" as const);
    const immediateEvidenceCfg: Config = {
      ...baseCfg,
      daemon: { ...baseCfg.daemon, session_command_unknown_max_checks: 0 },
    };
    const s = supervisor(
      hooks({
        wakeReceiptPresent: async () => false,
        sessionAlive: async () => true,
        retrySessionCommand: retry,
      }),
      onRoundFailure,
      immediateEvidenceCfg,
    ).supervisor;

    await expect(s.scan()).rejects.toThrow(/failed before replay.*ledger_open/);
    await expect(s.scan()).rejects.toThrow(/failed before replay.*ledger_open/);
    await s.scan();

    expect(retry).toHaveBeenCalledTimes(2);
    expect(store.getSessionCommand(id)).toMatchObject({
      status: "failed",
      attempt: 1,
      recovery_attempts: 2,
    });
    expect(onRoundFailure).toHaveBeenCalledWith(
      pr,
      round.round_no,
      "command_start",
      expect.stringContaining("ledger_open"),
    );
  });

  it("allows unknown evidence one finite lease, then recovers instead of waiting indefinitely", async () => {
    const { id } = seedRoundCommand({ status: "running" });
    const retry = vi.fn(async () => "retried" as const);
    const h = hooks({
      wakeReceiptPresent: async () => null,
      sessionAlive: async () => true,
      retrySessionCommand: retry,
    });
    const s = supervisor(h).supervisor;

    await s.scan();
    expect(retry).not.toHaveBeenCalled();
    expect(store.getSessionCommand(id)).toMatchObject({ unknown_checks: 1, status: "running" });

    clock = new Date("2026-08-27T20:07:00.000Z");
    await s.scan();
    expect(retry).toHaveBeenCalledWith(id, expect.stringContaining("unknown"));
  });

  it("fails contradictory accepted-but-dead evidence through bounded round recovery", async () => {
    const { id, pr, round } = seedRoundCommand({ status: "running" });
    const onRoundFailure = vi.fn(async () => "requeued" as const);
    const h = hooks({ wakeReceiptPresent: async () => true, sessionAlive: async () => false });

    await supervisor(h, onRoundFailure).supervisor.scan();

    expect(store.getSessionCommand(id)?.status).toBe("failed");
    expect(onRoundFailure).toHaveBeenCalledWith(
      pr,
      round.round_no,
      "command_start",
      expect.stringContaining("accepted marker"),
    );
  });

  it("routes a restart-failed round command through the same bounded recovery", async () => {
    const { id, pr, round } = seedRoundCommand({ status: "pending" });
    store.failPendingSessionCommand(id, "restart reconstruction failed: payload hash mismatch");
    const onRoundFailure = vi.fn(async () => "requeued" as const);

    await supervisor(hooks(), onRoundFailure).supervisor.scan();

    expect(onRoundFailure).toHaveBeenCalledWith(
      pr,
      round.round_no,
      "command_start",
      expect.stringContaining("payload hash mismatch"),
    );
  });

  it("reconciles a correlated marker into a fixed running hard bound", async () => {
    const { id } = seedRoundCommand({ status: "running" });
    const h = hooks({ wakeReceiptPresent: async () => true, sessionAlive: async () => true });

    await supervisor(h).supervisor.scan();

    const command = store.getSessionCommand(id)!;
    expect(command.started_at).toBe("2026-08-27T20:04:00.000Z");
    expect(Date.parse(command.next_check_at) - Date.parse(command.started_at!)).toBe(
      (baseCfg.daemon.session_command_running_max_min ?? 45) * 60_000,
    );
  });

  it("terminalizes a settled round with no verdict through the infrastructure path", async () => {
    const { id, pr, round } = seedRoundCommand({ status: "acked", started: true });
    const onRoundFailure = vi.fn(async () => "requeued" as const);

    await supervisor(hooks(), onRoundFailure).supervisor.scan();

    expect(store.getSessionCommand(id)).toMatchObject({
      status: "failed",
      failure: expect.stringContaining("settled without verdict"),
    });
    expect(onRoundFailure).toHaveBeenCalledWith(
      pr,
      round.round_no,
      "settled_without_verdict",
      expect.stringContaining(id),
    );
  });

  it("a 'settled' disposition keeps the delivered command acked and opens no failure", async () => {
    const { id, pr, round } = seedRoundCommand({ status: "acked", started: true });
    const onRoundFailure = vi.fn(async () => "settled" as const);

    await supervisor(hooks(), onRoundFailure).supervisor.scan();

    expect(onRoundFailure).toHaveBeenCalledWith(
      pr,
      round.round_no,
      "settled_without_verdict",
      expect.stringContaining(id),
    );
    // An acked command proved delivery; a guard-2 no-op is not failed work.
    expect(store.getSessionCommand(id)?.status).toBe("acked");
    expect(store.blockingSessionCommand(`pr-${pr}`)).toBeUndefined();
    expect(store.openReviewFailure(pr)).toBeUndefined();
    const recovery = (
      store.db
        .prepare("SELECT payload FROM events WHERE kind = 'round_stage_recovery' AND pr = ?")
        .all(pr) as Array<{ payload: string }>
    ).map((row) => JSON.parse(row.payload) as Record<string, unknown>);
    expect(recovery).toEqual([
      expect.objectContaining({
        command_id: id,
        stage: "settled_without_verdict",
        disposition: "settled",
      }),
    ]);
  });

  it("uses matching settled telemetry with durable start evidence when the bridge died before ack", async () => {
    const { id, pr, round } = seedRoundCommand({ status: "running", started: true });
    const onRoundFailure = vi.fn(async () => "requeued" as const);
    const progress = () => ({
      version: 1 as const,
      pr,
      session: `pr-${pr}`,
      run_started_at: clock.toISOString(),
      updated_at: clock.toISOString(),
      parent_status: "settled" as const,
      command_id: id,
      command_sha256: "a".repeat(64),
      last_activity_at: clock.toISOString(),
      last_activity: "parent settled",
      agents: [],
    });

    const killed: number[] = [];
    await supervisor(
      hooks({
        killSession: async (n) => {
          killed.push(n);
        },
      }),
      onRoundFailure,
      baseCfg,
      progress,
    ).supervisor.scan();

    expect(killed).toEqual([pr]);
    expect(store.getSessionCommand(id)?.status).toBe("failed");
    expect(onRoundFailure).toHaveBeenCalledWith(
      pr,
      round.round_no,
      "settled_without_verdict",
      expect.stringContaining(id),
    );
  });

  it("leaves a settled command alone while its verdict file is pending", async () => {
    const { id, pr, round } = seedRoundCommand({ status: "acked", started: true });
    writeFileSync(join(verdictDir, `pr-${pr}-round-${round.round_no}.json`), "{}");
    const onRoundFailure = vi.fn(async () => "requeued" as const);

    await supervisor(hooks(), onRoundFailure).supervisor.scan();

    expect(store.getSessionCommand(id)?.status).toBe("acked");
    expect(onRoundFailure).not.toHaveBeenCalled();
  });

  it("recovers a command-correlated round that starts no first pass within its finite lease", async () => {
    clock = new Date("2026-08-27T20:00:00.000Z");
    const { id, pr, round } = seedRoundCommand({
      status: "running",
      started: true,
      nextCheckAt: "2026-08-27T20:45:00.000Z",
    });
    clock = new Date("2026-08-27T20:05:00.000Z");
    const onRoundFailure = vi.fn(async () => "requeued" as const);
    const progress = () => ({
      version: 2 as const,
      pr,
      session: `pr-${pr}`,
      run_started_at: "2026-08-27T20:00:00.000Z",
      updated_at: clock.toISOString(),
      parent_status: "active" as const,
      command_id: id,
      command_sha256: "a".repeat(64),
      command_accepted_at: "2026-08-27T20:00:01.000Z",
      last_activity_at: clock.toISOString(),
      last_activity: "parent thinking",
      agents: [],
    });

    await supervisor(
      hooks({ killSession: async () => {} }),
      onRoundFailure,
      baseCfg,
      progress,
    ).supervisor.scan();

    expect(onRoundFailure).toHaveBeenCalledWith(
      pr,
      round.round_no,
      "first_pass_start",
      expect.stringContaining("no planned pass started"),
    );
  });

  it("does not reopen exhausted debt when operator u wins while the recovery callback returns", async () => {
    clock = new Date("2026-08-27T20:00:00.000Z");
    const seeded = seedRoundCommand({
      status: "running",
      started: true,
      nextCheckAt: "2026-08-27T20:45:00.000Z",
    });
    clock = new Date("2026-08-27T20:05:00.000Z");
    const onRoundFailure = vi.fn(
      async (_pr: number, _roundNo: number, stage: string, detail: string) => {
        const failure = store.terminalizeInfrastructureReviewFailure({
          pr: seeded.pr,
          round_id: seeded.round.id,
          round_no: seeded.round.round_no,
          command_id: seeded.id,
          head_sha: store.getPr(seeded.pr)!.head_sha,
          stage,
          detail,
          attempts: 2,
          retry_cap: 2,
          summary: "pre-fanout recovery exhausted",
        });
        expect(failure?.work_owed).toBe(1);
        expect(store.recoverReviewFailure(seeded.pr, "operator-rerun")?.work_owed).toBe(0);
        return "exhausted" as const;
      },
    );
    const progress = () => ({
      version: 2 as const,
      pr: seeded.pr,
      session: `pr-${seeded.pr}`,
      run_started_at: "2026-08-27T20:00:00.000Z",
      updated_at: clock.toISOString(),
      parent_status: "active" as const,
      command_id: seeded.id,
      command_sha256: "a".repeat(64),
      command_accepted_at: "2026-08-27T20:00:01.000Z",
      last_activity_at: clock.toISOString(),
      last_activity: "preparing",
      agents: [],
    });

    await supervisor(
      hooks({ killSession: async () => {} }),
      onRoundFailure,
      baseCfg,
      progress,
    ).supervisor.scan();

    expect(store.openReviewFailure(seeded.pr)).toBeUndefined();
    expect(store.reviewFailureForCommand(seeded.id)).toMatchObject({
      work_owed: 0,
      recovery: "operator-rerun",
    });
    expect(store.getPr(seeded.pr)?.state).toBe("queued");
    expect(
      (
        store.db
          .prepare(
            "SELECT COUNT(*) AS c FROM events WHERE kind='round_stage_recovery_already_resolved' AND pr=?",
          )
          .get(seeded.pr) as { c: number }
      ).c,
    ).toBe(1);
  });

  it("does not accept validator-first or foreign subagents as planned discovery fanout", async () => {
    clock = new Date("2026-08-27T20:00:00.000Z");
    const { id, pr, round } = seedRoundCommand({
      status: "running",
      started: true,
      nextCheckAt: "2026-08-27T20:45:00.000Z",
      lenses: ["pass-baseline", "pass-security", "pass-validate"],
    });
    clock = new Date("2026-08-27T20:05:00.000Z");
    const onRoundFailure = vi.fn(async () => "requeued" as const);
    const progress = () => ({
      version: 2 as const,
      pr,
      session: `pr-${pr}`,
      run_started_at: "2026-08-27T20:00:00.000Z",
      updated_at: clock.toISOString(),
      parent_status: "active" as const,
      command_id: id,
      command_sha256: "a".repeat(64),
      command_accepted_at: "2026-08-27T20:00:01.000Z",
      fanout_started_at: "2026-08-27T20:01:00.000Z",
      last_activity_at: clock.toISOString(),
      last_activity: "validator-first",
      agents: [
        {
          execution_id: "foreign",
          agent: "pass-validate--sol-high",
          status: "running" as const,
          duration_ms: 1,
          tool_count: 0,
          started_at: "2026-08-27T20:01:00.000Z",
        },
      ],
    });

    await supervisor(
      hooks({ killSession: async () => {} }),
      onRoundFailure,
      baseCfg,
      progress,
    ).supervisor.scan();

    expect(onRoundFailure).toHaveBeenCalledWith(
      pr,
      round.round_no,
      "first_pass_start",
      expect.stringContaining("no planned pass started"),
    );
  });

  it("does not infer a missing first pass from legacy or uncorrelated telemetry", async () => {
    clock = new Date("2026-08-27T19:59:00.000Z");
    const { id, pr } = seedRoundCommand({
      status: "running",
      started: true,
      nextCheckAt: "2026-08-27T20:44:00.000Z",
    });
    clock = new Date("2026-08-27T20:05:00.000Z");
    const onRoundFailure = vi.fn(async () => "requeued" as const);
    const progress = () => ({
      version: 1 as const,
      pr,
      session: `pr-${pr}`,
      run_started_at: "2026-08-27T19:59:00.000Z",
      updated_at: clock.toISOString(),
      parent_status: "active" as const,
      command_id: id,
      command_sha256: "a".repeat(64),
      last_activity_at: clock.toISOString(),
      last_activity: "legacy telemetry",
      agents: [],
    });

    await supervisor(hooks(), onRoundFailure, baseCfg, progress).supervisor.scan();

    expect(onRoundFailure).not.toHaveBeenCalled();
    expect(store.getSessionCommand(id)?.status).toBe("running");
  });

  it("recovers an incomplete planned pass set at the absolute pass deadline", async () => {
    clock = new Date("2026-08-27T20:00:00.000Z");
    const { id, pr, round } = seedRoundCommand({
      status: "running",
      started: true,
      nextCheckAt: "2026-08-27T20:45:00.000Z",
      lenses: ["pass-baseline", "pass-validate"],
    });
    clock = new Date("2026-08-27T20:35:00.000Z");
    const onRoundFailure = vi.fn(async () => "requeued" as const);
    const progress = () => ({
      version: 2 as const,
      pr,
      session: `pr-${pr}`,
      run_started_at: "2026-08-27T20:00:00.000Z",
      updated_at: clock.toISOString(),
      parent_status: "active" as const,
      command_id: id,
      command_sha256: "a".repeat(64),
      command_accepted_at: "2026-08-27T20:00:01.000Z",
      first_lens_started_at: "2026-08-27T20:01:00.000Z",
      last_activity_at: clock.toISOString(),
      last_activity: "validator never launched",
      agents: [
        {
          execution_id: "lens-1:pass-baseline--sol-med",
          agent: "pass-baseline--sol-med",
          status: "completed" as const,
          duration_ms: 60_000,
          tool_count: 1,
          started_at: "2026-08-27T20:01:00.000Z",
          finished_at: "2026-08-27T20:02:00.000Z",
        },
      ],
    });

    await supervisor(
      hooks({ killSession: async () => {} }),
      onRoundFailure,
      baseCfg,
      progress,
    ).supervisor.scan();

    expect(onRoundFailure).toHaveBeenCalledWith(
      pr,
      round.round_no,
      "passes_incomplete",
      expect.stringContaining("pass-validate"),
    );
    expect(store.roundsFor(pr).find((item) => item.id === round.id)?.fanout_started_at).toBe(
      "2026-08-27T20:01:00.000Z",
    );
  });

  // An ACTIVE parent holds finalize — unless its session is
  // provably dead, when the frozen snapshot is not trusted.
  it("bounds parent finalization after every planned and added pass is terminal (session dead)", async () => {
    clock = new Date("2026-08-27T20:00:00.000Z");
    const { id, pr, round } = seedRoundCommand({
      status: "running",
      started: true,
      nextCheckAt: "2026-08-27T20:45:00.000Z",
    });
    clock = new Date("2026-08-27T20:30:00.000Z");
    const onRoundFailure = vi.fn(async () => "requeued" as const);
    const progress = () => ({
      version: 2 as const,
      pr,
      session: `pr-${pr}`,
      run_started_at: "2026-08-27T20:00:00.000Z",
      updated_at: clock.toISOString(),
      parent_status: "active" as const,
      command_id: id,
      command_sha256: "a".repeat(64),
      command_accepted_at: "2026-08-27T20:00:01.000Z",
      first_lens_started_at: "2026-08-27T20:20:00.000Z",
      last_activity_at: clock.toISOString(),
      last_activity: "all passes done",
      agents: [
        {
          execution_id: "lens-1:pass-baseline",
          agent: "pass-baseline",
          status: "completed" as const,
          duration_ms: 1,
          tool_count: 1,
          started_at: "2026-08-27T20:20:00.000Z",
          finished_at: "2026-08-27T20:25:00.000Z",
        },
        {
          execution_id: "lens-2:pass-added",
          agent: "pass-added",
          status: "failed" as const,
          duration_ms: 1,
          tool_count: 1,
          started_at: "2026-08-27T20:21:00.000Z",
          finished_at: "2026-08-27T20:25:00.000Z",
        },
      ],
    });

    await supervisor(
      hooks({ killSession: async () => {}, sessionAlive: async () => false }),
      onRoundFailure,
      baseCfg,
      progress,
    ).supervisor.scan();

    expect(onRoundFailure).toHaveBeenCalledWith(
      pr,
      round.round_no,
      "parent_finalize",
      expect.stringContaining("all observed passes terminal"),
    );
  });

  it("enforces the fixed running hard bound even when progress telemetry keeps changing", async () => {
    const { id, pr, round } = seedRoundCommand({ status: "running", started: true });
    store.db
      .prepare("UPDATE session_commands SET started_at=?, next_check_at=? WHERE id=?")
      .run("2026-08-27T19:00:00.000Z", "2026-08-27T19:45:00.000Z", id);
    const onRoundFailure = vi.fn(async () => "requeued" as const);
    const h = hooks({ sessionAlive: async () => true });

    // No progress reader is even a dependency: activity cannot renew durable time.
    await supervisor(h, onRoundFailure).supervisor.scan();

    expect(store.getSessionCommand(id)?.status).toBe("failed");
    expect(onRoundFailure).toHaveBeenCalledWith(
      pr,
      round.round_no,
      "running_hard_bound",
      expect.stringContaining(id),
    );
  });

  it("stops a cancelled round's possibly queued unstarted command before releasing its slot", async () => {
    const { id, pr, roundId } = seedRoundCommand({
      status: "running",
      nextCheckAt: "2026-08-27T20:45:00.000Z",
    });
    store.markRoundCancelled(roundId, "operator rerun", "operator");
    const killed: number[] = [];

    await supervisor(
      hooks({
        killSession: async (n) => {
          killed.push(n);
        },
      }),
    ).supervisor.scan();

    expect(killed).toEqual([pr]);
    expect(store.getSessionCommand(id)?.status).toBe("failed");
    expect(store.blockingSessionCommand(`pr-${pr}`)).toBeUndefined();
  });

  it("reconciles bridge death after settlement when the merits round already finished", async () => {
    const { id, pr, roundId } = seedRoundCommand({
      status: "running",
      started: true,
      nextCheckAt: "2026-08-27T20:45:00.000Z",
    });
    store.markRoundCancelled(roundId, "verdict lifecycle won", "unknown");
    const onRoundFailure = vi.fn(async () => "requeued" as const);
    const progress = () => ({
      version: 1 as const,
      pr,
      session: `pr-${pr}`,
      run_started_at: clock.toISOString(),
      updated_at: clock.toISOString(),
      parent_status: "settled" as const,
      command_id: id,
      command_sha256: "a".repeat(64),
      last_activity_at: clock.toISOString(),
      last_activity: "settled",
      agents: [],
    });

    const killed: number[] = [];
    await supervisor(
      hooks({
        killSession: async (n) => {
          killed.push(n);
        },
      }),
      onRoundFailure,
      baseCfg,
      progress,
    ).supervisor.scan();

    expect(killed).toEqual([pr]);
    expect(store.getSessionCommand(id)?.status).toBe("acked");
    expect(onRoundFailure).not.toHaveBeenCalled();
  });

  it("keeps a retryable round-recovery obligation due instead of losing it as failed", async () => {
    const { id } = seedRoundCommand({ status: "acked", started: true });
    const onRoundFailure = vi.fn(async () => "retryable" as const);

    await supervisor(hooks(), onRoundFailure).supervisor.scan();

    expect(store.getSessionCommand(id)).toMatchObject({
      status: "acked",
      next_check_at: "2026-08-27T20:06:00.000Z",
    });
    expect(events("round_stage_recovery_deferred")).toHaveLength(1);
  });

  it("a posted_wait disposition keeps the command running and alive — no failure, no kill, re-checked later", async () => {
    const { id } = seedRoundCommand({ status: "running", started: true });
    store.db
      .prepare("UPDATE session_commands SET started_at=?, next_check_at=? WHERE id=?")
      .run("2026-08-27T19:00:00.000Z", "2026-08-27T19:45:00.000Z", id);
    const onRoundFailure = vi.fn(async () => "posted_wait" as const);
    const killSession = vi.fn(async () => {});

    await supervisor(hooks({ killSession }), onRoundFailure).supervisor.scan();

    expect(onRoundFailure).toHaveBeenCalledWith(
      5408,
      1,
      "running_hard_bound",
      expect.stringContaining(id),
    );
    expect(store.getSessionCommand(id)).toMatchObject({
      status: "running",
      failure: null,
      next_check_at: "2026-08-27T20:06:00.000Z",
    });
    expect(killSession).not.toHaveBeenCalled();
    expect(store.roundsFor(5408)[0]?.status).toBe("running");
    expect(events("round_stage_recovery")).toHaveLength(0);
    expect(events("round_stage_recovery_deferred")).toHaveLength(0);
  });

  it("leaves command ownership due and marks supervisor health red when recovery throws", async () => {
    const { id } = seedRoundCommand({ status: "acked", started: true });
    const onRoundFailure = vi.fn(async () => {
      throw new Error("tmux kill refused");
    });
    const s = supervisor(hooks(), onRoundFailure).supervisor;

    await expect(s.scan()).rejects.toThrow(/tmux kill refused/);

    expect(store.getSessionCommand(id)?.status).toBe("acked");
    expect(s.health()).toMatchObject({
      healthy: false,
      last_error: expect.stringContaining("tmux kill refused"),
    });
  });

  it("one command's recovery error leaves the scan red but still inspects the commands after it", async () => {
    // Due first (earliest check): a failed wake whose retry hook is unwired.
    const wake = seedWakeCommand({ status: "failed", attempt: 1 });
    // Then an operator-cancelled round whose running command must be fenced.
    const round = seedRoundCommand({
      pr: 5500,
      status: "running",
      nextCheckAt: "2026-08-27T20:45:00.000Z",
    });
    store.markRoundCancelled(round.roundId, "operator rerun", "operator");
    const killed: number[] = [];
    const s = supervisor(
      hooks({
        killSession: async (n) => {
          killed.push(n);
        },
      }),
    ).supervisor;

    await expect(s.scan()).rejects.toThrow(/retry hook unavailable/);

    expect(killed).toEqual([round.pr]);
    expect(store.getSessionCommand(round.id)?.status).toBe("failed");
    expect(store.getSessionCommand(wake.id)).toMatchObject({
      status: "failed",
      recovery_attempts: 0,
    });
    expect(s.health()).toMatchObject({ healthy: false });
  });

  it("a failed attempt stamp does not wedge every later scan", async () => {
    const s = supervisor(hooks()).supervisor;
    const mark = store.markSupervisorAttempt.bind(store);
    let fail = true;
    store.markSupervisorAttempt = (...args) => {
      if (fail) {
        fail = false;
        throw new Error("database is locked");
      }
      return mark(...args);
    };

    await expect(s.scan()).rejects.toThrow(/database is locked/);
    await s.scan();

    expect(s.health()).toMatchObject({ last_success_at: clock.toISOString() });
  });

  it("leaves the session's tail alone after its verdict ended the round, then fences it past the grace", async () => {
    const { id, pr, roundId } = seedRoundCommand({
      status: "running",
      started: true,
      nextCheckAt: "2026-08-27T20:45:00.000Z",
    });
    store.finishRound(roundId, "APPROVE", null);
    const killed: number[] = [];
    const h = hooks({
      killSession: async (n) => {
        killed.push(n);
      },
    });

    await supervisor(h).supervisor.scan();
    expect(killed).toEqual([]);
    expect(store.getSessionCommand(id)?.status).toBe("running");

    clock = new Date(clock.getTime() + (baseCfg.daemon.round_finalize_grace_min ?? 5) * 60_000);
    await supervisor(h).supervisor.scan();
    expect(killed).toEqual([pr]);
    expect(store.getSessionCommand(id)?.status).toBe("acked");
  });

  it("rejects stale settled progress without exact command identity", async () => {
    const { id, pr } = seedRoundCommand({ status: "running", started: true });
    const onRoundFailure = vi.fn(async () => "requeued" as const);
    const progress = () => ({
      version: 1 as const,
      pr,
      session: `pr-${pr}`,
      run_started_at: clock.toISOString(),
      updated_at: clock.toISOString(),
      parent_status: "settled" as const,
      command_id: "older-command",
      command_sha256: "b".repeat(64),
      last_activity_at: clock.toISOString(),
      last_activity: "older run settled",
      agents: [],
    });

    await supervisor(hooks(), onRoundFailure, baseCfg, progress).supervisor.scan();

    expect(store.getSessionCommand(id)?.status).toBe("running");
    expect(onRoundFailure).not.toHaveBeenCalled();
  });

  it("writes its durable success lease only after the complete scan", async () => {
    seedRoundCommand({ status: "running" });
    let release!: () => void;
    const receipt = new Promise<boolean | null>((resolve) => {
      release = () => resolve(null);
    });
    const s = supervisor(
      hooks({ wakeReceiptPresent: async () => receipt, sessionAlive: async () => true }),
    ).supervisor;
    expect(s.health().healthy).toBe(false); // no successful scan is not health evidence

    const pending = s.scan();
    await vi.waitFor(() =>
      expect(store.supervisorLease("round-stage")?.last_attempt_at).toBe(clock.toISOString()),
    );
    expect(store.supervisorLease("round-stage")?.last_success_at).toBeNull();
    clock = new Date(
      clock.getTime() + ((baseCfg.daemon.round_stage_supervisor_stale_s ?? 180) + 1) * 1000,
    );
    expect(s.health()).toMatchObject({ healthy: false, last_success_at: null });
    release();
    await pending;
    expect(store.supervisorLease("round-stage")?.last_success_at).toBe(clock.toISOString());
    expect(s.health().healthy).toBe(true);
  });
});

// A wake flushed right after a verdict can wait behind the post-verdict
// compaction until its start lease runs out. A command waiting behind a
// compaction is late, not lost; a live, bridge-ready session gets a bounded
// REDELIVERY of the same command before any kill.
describe("missing start on a live session: compaction and redelivery come before any kill", () => {
  // The moment the wake's 120 s start lease has run out.
  const LEASE_OUT = "2026-08-27T20:04:00.000Z";

  function liveHooks(over: Partial<SessionHooks> = {}) {
    const retry = vi.fn(async () => "retried" as const);
    const kill = vi.fn(async () => {});
    // The real hook's contract: CAS on the row the supervisor OBSERVED.
    const redeliver = vi.fn(async (commandId: string, observed: SessionCommandObservation) =>
      store.requeueSessionCommandForRedelivery(
        commandId,
        observed,
        new Date(clock.getTime() + 120_000).toISOString(),
      )
        ? ("redelivered" as const)
        : ("raced" as const),
    );
    return {
      retry,
      kill,
      redeliver,
      h: hooks({
        wakeReceiptPresent: async () => false, // the JSONL holds no marker
        sessionAlive: async () => true,
        retrySessionCommand: retry,
        killSession: kill,
        redeliverSessionCommand: redeliver,
        ...over,
      }),
    };
  }

  it("a wake waiting behind a running compaction keeps its lease: no redelivery, no retry, no kill", async () => {
    const { id, pr } = seedWakeCommand({ status: "pending", nextCheckAt: LEASE_OUT });
    const { h, retry, kill, redeliver } = liveHooks({
      sessionCompaction: async () => ({
        state: "running",
        seq: 3,
        started_at: new Date(clock.getTime() - 73_000).toISOString(),
        source: "request",
      }),
    });

    await supervisor(h).supervisor.scan();

    expect(redeliver).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
    const row = store.getSessionCommand(id)!;
    expect(row).toMatchObject({ status: "pending", unknown_checks: 0, redeliveries: 0 });
    expect(Date.parse(row.next_check_at)).toBeGreaterThan(clock.getTime());
    expect(events("session_command_start_deferred")).toMatchObject([
      { pr, payload: { command_id: id, reason: "compacting", compaction_source: "request" } },
    ]);
  });

  it("the compaction deferral is bounded: a compaction 'running' past session_compaction_max_s defers nothing", async () => {
    const { id } = seedWakeCommand({ status: "pending", nextCheckAt: LEASE_OUT });
    const bound = baseCfg.daemon.session_compaction_max_s ?? 600;
    const { h, redeliver, kill } = liveHooks({
      sessionCompaction: async () => ({
        state: "running",
        seq: 0,
        started_at: new Date(clock.getTime() - bound * 1000).toISOString(),
      }),
    });

    await supervisor(h).supervisor.scan();

    expect(redeliver).toHaveBeenCalledWith(id, {
      attempt: 0,
      redeliveries: 0,
      next_check_at: LEASE_OUT,
    });
    expect(kill).not.toHaveBeenCalled();
    expect(events("session_command_start_deferred")).toEqual([]);
  });

  it("a live, bridge-ready session gets a bounded REDELIVERY of the same command before any kill", async () => {
    const { id, pr } = seedWakeCommand({ status: "running", nextCheckAt: LEASE_OUT });
    const { h, retry, kill, redeliver } = liveHooks();
    const s = supervisor(h).supervisor;
    const cap = baseCfg.daemon.max_prompt_redeliveries ?? 2;

    for (let n = 1; n <= cap; n++) {
      await s.scan();
      expect(redeliver).toHaveBeenCalledTimes(n);
      expect(retry).not.toHaveBeenCalled();
      expect(kill).not.toHaveBeenCalled();
      expect(store.getSessionCommand(id)).toMatchObject({
        status: "pending",
        redeliveries: n,
        recovery_attempts: 0,
      });
      clock = new Date(clock.getTime() + 121_000); // the redelivered lease runs out too
    }
    expect(events("session_command_redelivered").map((e) => e.payload)).toMatchObject([
      { command_id: id, redelivery: 1, cap, result: "redelivered" },
      { command_id: id, redelivery: 2, cap, result: "redelivered" },
    ]);

    // Redelivery spent: only now the kill-and-replay recovery.
    await s.scan();
    expect(redeliver).toHaveBeenCalledTimes(cap);
    expect(retry).toHaveBeenCalledWith(id, expect.stringContaining("no correlated start"));
    expect(events("session_command_redelivery_exhausted")).toMatchObject([
      { pr, payload: { command_id: id, redeliveries: cap, cap } },
    ]);
  });

  it("a provably dead session (tmux gone) skips redelivery and goes straight to the replay", async () => {
    const { id } = seedWakeCommand({ status: "running", nextCheckAt: LEASE_OUT });
    const { h, retry, redeliver } = liveHooks({ sessionAlive: async () => false });

    await supervisor(h).supervisor.scan();

    expect(redeliver).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledWith(id, expect.any(String));
  });

  it("no live, bridge-ready session to redeliver into (not_live) hands over to the replay", async () => {
    const { id } = seedWakeCommand({ status: "running", nextCheckAt: LEASE_OUT });
    const { h, retry } = liveHooks({ redeliverSessionCommand: async () => "not_live" as const });

    await supervisor(h).supervisor.scan();

    expect(retry).toHaveBeenCalledWith(id, expect.any(String));
    expect(events("session_command_redelivery_skipped")).toMatchObject([
      { payload: { command_id: id, result: "not_live" } },
    ]);
  });

  it("a command a bridge reserved between the read and the redelivery is looked at again later, not killed", async () => {
    const { id } = seedWakeCommand({ status: "running", nextCheckAt: LEASE_OUT });
    const { h, retry, kill } = liveHooks({ redeliverSessionCommand: async () => "raced" as const });

    await supervisor(h).supervisor.scan();

    expect(retry).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
    expect(Date.parse(store.getSessionCommand(id)!.next_check_at)).toBeGreaterThan(clock.getTime());
  });

  it("a round prompt gets the same redelivery-first treatment", async () => {
    const { id } = seedRoundCommand({ status: "running" });
    const { h, retry, redeliver } = liveHooks();

    await supervisor(h).supervisor.scan();

    expect(redeliver).toHaveBeenCalledWith(id, expect.objectContaining({ redeliveries: 0 }));
    expect(retry).not.toHaveBeenCalled();
    expect(store.getSessionCommand(id)).toMatchObject({ status: "pending", redeliveries: 1 });
  });

  // The supervisor awaits liveness and the JSONL before it
  // redelivers. A bridge that reserved the command in that window (a busy run
  // settled, a compaction ended) holds a FRESH submission pi may still be
  // preflighting — handing it back would send it twice.
  it("a bridge reservation made while the evidence was read is not handed back: raced, no kill", async () => {
    const { id } = seedWakeCommand({ status: "pending", nextCheckAt: LEASE_OUT });
    const freshLease = new Date(clock.getTime() + 120_000).toISOString();
    const { h, retry, kill, redeliver } = liveHooks({
      sessionAlive: async () => {
        // The bridge reserves (attempt 0 -> 1, a fresh lease) during the
        // supervisor's awaits, after its due read.
        store.claimSessionCommand(id, "bridge-2", freshLease);
        return true;
      },
    });

    await supervisor(h).supervisor.scan();

    expect(redeliver).toHaveBeenCalledWith(id, {
      attempt: 0,
      redeliveries: 0,
      next_check_at: LEASE_OUT,
    });
    expect(store.getSessionCommand(id)).toMatchObject({
      status: "running",
      owner_token: "bridge-2",
      attempt: 1,
      redeliveries: 0,
      next_check_at: freshLease, // the reservation's own lease, never cut short
    });
    expect(events("session_command_redelivered")).toEqual([]);
    expect(events("session_command_redelivery_raced")).toMatchObject([
      { payload: { command_id: id, result: "raced" } },
    ]);
    expect(retry).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  // A pi killed or OOM'd mid-compaction never reaches
  // `session_shutdown`, so its receipt still says "running". A provably dead
  // session is the kill-and-replay case at once, never held off for
  // `session_compaction_max_s`.
  it("a session that died mid-compaction is not deferred: it is replayed on the first check", async () => {
    const { id } = seedWakeCommand({ status: "running", nextCheckAt: LEASE_OUT });
    const { h, retry, redeliver } = liveHooks({
      sessionAlive: async () => false,
      sessionCompaction: async () => ({
        state: "running",
        seq: 3,
        started_at: new Date(clock.getTime() - 73_000).toISOString(),
        source: "request",
      }),
    });

    await supervisor(h).supervisor.scan();

    expect(events("session_command_start_deferred")).toEqual([]);
    expect(redeliver).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledWith(id, expect.stringContaining("no correlated start"));
  });

  // The redelivery budget is per session generation. A
  // command replayed into a fresh conversation after its budget was spent
  // gets its own: its next missed start there is redelivered, not killed.
  it("after a kill-and-replay, the fresh session's missed start is redelivered, not killed again", async () => {
    const { id } = seedWakeCommand({ status: "running", nextCheckAt: LEASE_OUT });
    const cap = baseCfg.daemon.max_prompt_redeliveries ?? 2;
    store.db.prepare("UPDATE session_commands SET redeliveries=? WHERE id=?").run(cap, id);
    const retry = vi.fn(async (commandId: string) => {
      // What PiSessionManager.retrySessionCommand does past its tmux fence,
      // then the reborn session's bridge reserving the replayed command.
      const row = store.getSessionCommand(commandId)!;
      const lease = new Date(clock.getTime() + 120_000).toISOString();
      store.retrySessionCommandAfterFence(commandId, row.attempt, lease);
      store.claimSessionCommand(commandId, "bridge-reborn", lease);
      return "retried" as const;
    });
    const { h, redeliver, kill } = liveHooks({ retrySessionCommand: retry });
    const s = supervisor(h).supervisor;

    await s.scan(); // budget spent: the one kill-and-replay
    expect(retry).toHaveBeenCalledTimes(1);
    expect(store.getSessionCommand(id)).toMatchObject({
      status: "running",
      owner_token: "bridge-reborn",
      redeliveries: 0,
      recovery_attempts: 1,
    });

    clock = new Date(clock.getTime() + 121_000); // the reborn bridge's start lease runs out
    await s.scan();
    expect(redeliver).toHaveBeenCalledTimes(1);
    expect(retry).toHaveBeenCalledTimes(1); // no second kill
    expect(kill).not.toHaveBeenCalled();
    expect(store.getSessionCommand(id)).toMatchObject({ status: "pending", redeliveries: 1 });
  });

  it("without the redelivery hook (stubs, older wiring) the kill-and-replay path is unchanged", async () => {
    const { id } = seedWakeCommand({ status: "running", nextCheckAt: LEASE_OUT });
    const retry = vi.fn(async () => "retried" as const);

    await supervisor(
      hooks({
        wakeReceiptPresent: async () => false,
        sessionAlive: async () => true,
        retrySessionCommand: retry,
      }),
    ).supervisor.scan();

    expect(retry).toHaveBeenCalledWith(id, expect.any(String));
  });
});

function events(kind: string): Array<{ pr: number | null; payload: any }> {
  return (
    store.db.prepare("SELECT pr, payload FROM events WHERE kind=? ORDER BY id").all(kind) as Array<{
      pr: number | null;
      payload: string;
    }>
  ).map((row) => ({ pr: row.pr, payload: JSON.parse(row.payload) }));
}

// docs/follow-up-rounds.md: a follow-up round whose pre-approval
// sweep is OWED runs a whole round-1 plan after its delta stage. Its passes
// limit and its hard cap get `[daemon] follow_up_sweep_extra_min` more, and a
// sweep lens started after the delta stage is an ADDED pass, never a missing
// planned one.
describe("a follow-up round with the pre-approval sweep owed", () => {
  const owe = (roundId: number) =>
    store.setRoundMeta(roundId, { scope: "delta", sweep_owed: true });

  function progressFor(
    id: string,
    pr: number,
    agents: Array<{
      agent: string;
      status: "running" | "completed";
      started: string;
      finished?: string;
    }>,
  ) {
    return () => ({
      version: 2 as const,
      pr,
      session: `pr-${pr}`,
      run_started_at: "2026-08-27T20:00:00.000Z",
      updated_at: clock.toISOString(),
      parent_status: "active" as const,
      command_id: id,
      command_sha256: "a".repeat(64),
      command_accepted_at: "2026-08-27T20:00:01.000Z",
      first_lens_started_at: "2026-08-27T20:01:00.000Z",
      last_activity_at: clock.toISOString(),
      last_activity: "sweep running",
      agents: agents.map((a, i) => ({
        execution_id: `lens-${i}:${a.agent}`,
        agent: a.agent,
        status: a.status,
        duration_ms: 1,
        tool_count: 1,
        started_at: a.started,
        ...(a.finished ? { finished_at: a.finished } : {}),
      })),
    });
  }

  it("the hard cap is the configured bound plus the sweep allowance", async () => {
    const { id, roundId, pr, round } = seedRoundCommand({ status: "running", started: true });
    owe(roundId);
    // Started 60 minutes ago: past 45, inside 45 + 20.
    store.db
      .prepare("UPDATE session_commands SET started_at=?, next_check_at=? WHERE id=?")
      .run("2026-08-27T19:05:00.000Z", "2026-08-27T19:50:00.000Z", id);
    const onRoundFailure = vi.fn(async () => "requeued" as const);
    await supervisor(hooks({ sessionAlive: async () => true }), onRoundFailure).supervisor.scan();
    expect(onRoundFailure).not.toHaveBeenCalled();
    expect(store.getSessionCommand(id)).toMatchObject({
      status: "running",
      next_check_at: "2026-08-27T20:10:00.000Z",
    });

    // Past 45 + 20: the fixed bound still binds.
    clock = new Date("2026-08-27T20:10:00.000Z");
    await supervisor(hooks({ sessionAlive: async () => true }), onRoundFailure).supervisor.scan();
    expect(onRoundFailure).toHaveBeenCalledWith(
      pr,
      round.round_no,
      "running_hard_bound",
      expect.stringContaining("65-minute"),
    );
  });

  it("a round with no sweep owed keeps the configured hard cap", async () => {
    const { id, roundId, pr, round } = seedRoundCommand({ status: "running", started: true });
    store.setRoundMeta(roundId, { scope: "delta", sweep_owed: false });
    store.db
      .prepare("UPDATE session_commands SET started_at=?, next_check_at=? WHERE id=?")
      .run("2026-08-27T19:05:00.000Z", "2026-08-27T19:50:00.000Z", id);
    const onRoundFailure = vi.fn(async () => "requeued" as const);
    await supervisor(hooks({ sessionAlive: async () => true }), onRoundFailure).supervisor.scan();
    expect(onRoundFailure).toHaveBeenCalledWith(
      pr,
      round.round_no,
      "running_hard_bound",
      expect.stringContaining("45-minute"),
    );
  });

  it("the passes limit gets the sweep allowance, then binds", async () => {
    clock = new Date("2026-08-27T20:00:00.000Z");
    const { id, pr, roundId, round } = seedRoundCommand({
      status: "running",
      started: true,
      nextCheckAt: "2026-08-27T21:05:00.000Z",
      lenses: ["pass-baseline", "pass-validate"],
    });
    owe(roundId);
    const progress = progressFor(id, pr, [
      {
        agent: "pass-baseline--sol-med",
        status: "completed",
        started: "2026-08-27T20:01:00.000Z",
        finished: "2026-08-27T20:10:00.000Z",
      },
      {
        agent: "pass-validate--sol-high",
        status: "completed",
        started: "2026-08-27T20:11:00.000Z",
        finished: "2026-08-27T20:15:00.000Z",
      },
      // The sweep: pass-security, then a second pass-baseline, still running.
      { agent: "pass-security--sol-high", status: "running", started: "2026-08-27T20:16:00.000Z" },
      { agent: "pass-baseline--sol-med", status: "running", started: "2026-08-27T20:16:00.000Z" },
    ]);
    const onRoundFailure = vi.fn(async () => "requeued" as const);

    // 35 minutes in: the plain passes limit, not the sweep-owed one.
    clock = new Date("2026-08-27T20:35:00.000Z");
    await supervisor(
      hooks({ killSession: async () => {} }),
      onRoundFailure,
      baseCfg,
      progress,
    ).supervisor.scan();
    expect(onRoundFailure).not.toHaveBeenCalled();

    // 55 minutes in: 35 + 20 — the sweep's passes are outstanding as ADDED
    // agents; the delta stage's planned lenses are complete, never missing.
    clock = new Date("2026-08-27T20:55:00.000Z");
    await supervisor(
      hooks({ killSession: async () => {} }),
      onRoundFailure,
      baseCfg,
      progress,
    ).supervisor.scan();
    expect(onRoundFailure).toHaveBeenCalledWith(
      pr,
      round.round_no,
      "passes_incomplete",
      expect.stringContaining(
        "within 55 minutes; outstanding: pass-security--sol-high, pass-baseline--sol-med",
      ),
    );
  });

  it("without the sweep owed, a re-run of a planned lens still counts against that lens (unchanged)", async () => {
    clock = new Date("2026-08-27T20:00:00.000Z");
    const { id, pr, round } = seedRoundCommand({
      status: "running",
      started: true,
      nextCheckAt: "2026-08-27T20:45:00.000Z",
      lenses: ["pass-baseline"],
    });
    const progress = progressFor(id, pr, [
      {
        agent: "pass-baseline--sol-med",
        status: "completed",
        started: "2026-08-27T20:01:00.000Z",
        finished: "2026-08-27T20:10:00.000Z",
      },
      { agent: "pass-baseline--sol-med", status: "running", started: "2026-08-27T20:16:00.000Z" },
    ]);
    const onRoundFailure = vi.fn(async () => "requeued" as const);
    clock = new Date("2026-08-27T20:35:00.000Z");
    await supervisor(
      hooks({ killSession: async () => {} }),
      onRoundFailure,
      baseCfg,
      progress,
    ).supervisor.scan();
    expect(onRoundFailure).toHaveBeenCalledWith(
      pr,
      round.round_no,
      "passes_incomplete",
      expect.stringContaining("within 35 minutes; outstanding: pass-baseline"),
    );
  });
});

// The finalize stage must not kill a main session whose run is
// still active. The grace after the last pass measures an IDLE parent; an
// active one is validating, writing its ledger or posting.
describe("parent finalize waits for an active parent run", () => {
  const STARTED = "2026-08-27T20:00:00.000Z";
  function seedAllPassesTerminal() {
    clock = new Date(STARTED);
    const seeded = seedRoundCommand({
      status: "running",
      started: true,
      nextCheckAt: "2026-08-27T20:45:00.000Z",
    });
    const progressWith =
      (parent: "active" | "settled") =>
      (): import("../src/round-progress.js").RoundProgressSnapshot => ({
        version: 2,
        pr: seeded.pr,
        session: `pr-${seeded.pr}`,
        run_started_at: STARTED,
        updated_at: clock.toISOString(),
        parent_status: parent,
        command_id: seeded.id,
        command_sha256: "a".repeat(64),
        command_accepted_at: "2026-08-27T20:00:01.000Z",
        first_lens_started_at: "2026-08-27T20:05:00.000Z",
        last_activity_at: clock.toISOString(),
        last_activity: "writing the ledger",
        agents: [
          {
            execution_id: "lens-1:pass-baseline",
            agent: "pass-baseline",
            status: "completed",
            duration_ms: 1,
            tool_count: 1,
            started_at: "2026-08-27T20:05:00.000Z",
            finished_at: "2026-08-27T20:10:00.000Z",
          },
        ],
      });
    return { ...seeded, progressWith };
  }

  it("all passes terminal + grace elapsed + parent active: no parent_finalize", async () => {
    const { id, pr, progressWith } = seedAllPassesTerminal();
    clock = new Date("2026-08-27T20:30:00.000Z"); // 20 min past the last pass
    const kill = vi.fn(async () => {});
    for (const h of [
      hooks({ killSession: kill, sessionAlive: async () => true }),
      // Liveness UNKNOWN (no hook, or a probe that throws) keeps the snapshot's word.
      hooks({ killSession: kill }),
      hooks({
        killSession: kill,
        sessionAlive: async () => {
          throw new Error("tmux unreachable");
        },
      }),
    ]) {
      const { supervisor: sup, onRoundFailure } = supervisor(
        h,
        undefined,
        baseCfg,
        progressWith("active"),
      );
      await sup.scan();
      await sup.scan();
      expect(onRoundFailure).not.toHaveBeenCalled();
    }
    expect(kill).not.toHaveBeenCalled();
    expect(store.getSessionCommand(id)?.status).toBe("running");
    // One diagnostic event per supervisor instance, not one per scan.
    const held = events("round_finalize_held_parent_active");
    expect(held).toHaveLength(3);
    expect(held[0]).toMatchObject({
      pr,
      payload: {
        command_id: id,
        passes_finished_at: "2026-08-27T20:10:00.000Z",
        hard_deadline_at: "2026-08-27T20:45:00.000Z",
      },
    });
  });

  it("the same snapshot once settled takes the existing settled path", async () => {
    const { pr, round, progressWith } = seedAllPassesTerminal();
    clock = new Date("2026-08-27T20:30:00.000Z");
    const kill = vi.fn(async () => {});
    const { supervisor: sup, onRoundFailure } = supervisor(
      hooks({ killSession: kill, sessionAlive: async () => true }),
      undefined,
      baseCfg,
      progressWith("settled"),
    );
    await sup.scan();
    expect(onRoundFailure).toHaveBeenCalledWith(
      pr,
      round.round_no,
      "settled_without_verdict",
      expect.any(String),
    );
    expect(onRoundFailure).not.toHaveBeenCalledWith(
      pr,
      round.round_no,
      "parent_finalize",
      expect.anything(),
    );
  });

  it("the fixed hard bound still fires while the parent reads active", async () => {
    const { id, pr, round, progressWith } = seedAllPassesTerminal();
    clock = new Date("2026-08-27T20:45:00.000Z");
    const { supervisor: sup, onRoundFailure } = supervisor(
      hooks({ killSession: async () => {}, sessionAlive: async () => true }),
      undefined,
      baseCfg,
      progressWith("active"),
    );
    await sup.scan();
    expect(onRoundFailure).toHaveBeenCalledTimes(1);
    expect(onRoundFailure).toHaveBeenCalledWith(
      pr,
      round.round_no,
      "running_hard_bound",
      expect.stringContaining(id),
    );
    expect(store.getSessionCommand(id)?.status).toBe("failed");
  });

  it("before the grace runs out an active parent is simply left alone (no hold event)", async () => {
    const { progressWith } = seedAllPassesTerminal();
    clock = new Date("2026-08-27T20:12:00.000Z");
    const { supervisor: sup, onRoundFailure } = supervisor(
      hooks({ sessionAlive: async () => true }),
      undefined,
      baseCfg,
      progressWith("active"),
    );
    await sup.scan();
    expect(onRoundFailure).not.toHaveBeenCalled();
    expect(events("round_finalize_held_parent_active")).toHaveLength(0);
  });
});

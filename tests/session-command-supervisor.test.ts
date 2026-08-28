import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseConfig, type Config } from "../src/config.js";
import { sessionCommandMarker } from "../src/session-command.js";
import { SessionCommandSupervisor } from "../src/session-command-supervisor.js";
import { StateStore } from "../src/state.js";
import type { SessionHooks } from "../src/types.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const baseCfg: Config = parseConfig(readFileSync(resolve(process.cwd(), "config.toml"), "utf8"));

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

function seedRoundCommand(opts: {
  id?: string;
  pr?: number;
  status?: "pending" | "running" | "acked";
  started?: boolean;
  attempt?: number;
  nextCheckAt?: string;
} = {}) {
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
  const roundId = store.startRound(pr, "first", ["pass-baseline"], baseCfg.daemon.round_deadline_min);
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
      store.markSessionCommandStarted(id, "bridge-1", opts.nextCheckAt ?? "2026-08-27T20:04:00.000Z");
    }
    if (opts.status === "acked") store.finishSessionCommand(id, "bridge-1", "acked");
  }
  if (opts.attempt !== undefined) store.db.prepare("UPDATE session_commands SET attempt=? WHERE id=?").run(opts.attempt, id);
  return { id, pr, roundId, round };
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

function supervisor(
  h: SessionHooks,
  onRoundFailure = vi.fn(async () => "requeued" as const),
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
    expect(events("session_command_start_recovery")).toMatchObject([{ pr, payload: { command_id: id, attempt: 1 } }]);
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
    expect(onRoundFailure).toHaveBeenCalledWith(pr, round.round_no, "command_start", expect.stringContaining("accepted marker"));
  });

  it("routes a restart-failed round command through the same bounded recovery", async () => {
    const { id, pr, round } = seedRoundCommand({ status: "pending" });
    store.failPendingSessionCommand(id, "restart reconstruction failed: payload hash mismatch");
    const onRoundFailure = vi.fn(async () => "requeued" as const);

    await supervisor(hooks(), onRoundFailure).supervisor.scan();

    expect(onRoundFailure).toHaveBeenCalledWith(pr, round.round_no, "command_start", expect.stringContaining("payload hash mismatch"));
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

    expect(store.getSessionCommand(id)).toMatchObject({ status: "failed", failure: expect.stringContaining("settled without verdict") });
    expect(onRoundFailure).toHaveBeenCalledWith(pr, round.round_no, "settled_without_verdict", expect.stringContaining(id));
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
    await supervisor(hooks({ killSession: async (n) => { killed.push(n); } }), onRoundFailure, baseCfg, progress).supervisor.scan();

    expect(killed).toEqual([pr]);
    expect(store.getSessionCommand(id)?.status).toBe("failed");
    expect(onRoundFailure).toHaveBeenCalledWith(pr, round.round_no, "settled_without_verdict", expect.stringContaining(id));
  });

  it("leaves a settled command alone while its verdict file is pending", async () => {
    const { id, pr, round } = seedRoundCommand({ status: "acked", started: true });
    writeFileSync(join(verdictDir, `pr-${pr}-round-${round.round_no}.json`), "{}");
    const onRoundFailure = vi.fn(async () => "requeued" as const);

    await supervisor(hooks(), onRoundFailure).supervisor.scan();

    expect(store.getSessionCommand(id)?.status).toBe("acked");
    expect(onRoundFailure).not.toHaveBeenCalled();
  });

  it("enforces the fixed running hard bound even when progress telemetry keeps changing", async () => {
    const { id, pr, round } = seedRoundCommand({ status: "running", started: true });
    store.db.prepare("UPDATE session_commands SET started_at=?, next_check_at=? WHERE id=?")
      .run("2026-08-27T19:00:00.000Z", "2026-08-27T19:45:00.000Z", id);
    const onRoundFailure = vi.fn(async () => "requeued" as const);
    const h = hooks({ sessionAlive: async () => true });

    // No progress reader is even a dependency: activity cannot renew durable time.
    await supervisor(h, onRoundFailure).supervisor.scan();

    expect(store.getSessionCommand(id)?.status).toBe("failed");
    expect(onRoundFailure).toHaveBeenCalledWith(pr, round.round_no, "running_hard_bound", expect.stringContaining(id));
  });

  it("stops a cancelled round's possibly queued unstarted command before releasing its slot", async () => {
    const { id, pr, roundId } = seedRoundCommand({ status: "running", nextCheckAt: "2026-08-27T20:45:00.000Z" });
    store.markRoundCancelled(roundId, "operator rerun", "operator");
    const killed: number[] = [];

    await supervisor(hooks({ killSession: async (n) => { killed.push(n); } })).supervisor.scan();

    expect(killed).toEqual([pr]);
    expect(store.getSessionCommand(id)?.status).toBe("failed");
    expect(store.blockingSessionCommand(`pr-${pr}`)).toBeUndefined();
  });

  it("reconciles bridge death after settlement when the merits round already finished", async () => {
    const { id, pr, roundId } = seedRoundCommand({ status: "running", started: true, nextCheckAt: "2026-08-27T20:45:00.000Z" });
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
    await supervisor(hooks({ killSession: async (n) => { killed.push(n); } }), onRoundFailure, baseCfg, progress).supervisor.scan();

    expect(killed).toEqual([pr]);
    expect(store.getSessionCommand(id)?.status).toBe("acked");
    expect(onRoundFailure).not.toHaveBeenCalled();
  });

  it("keeps a retryable round-recovery obligation due instead of losing it as failed", async () => {
    const { id } = seedRoundCommand({ status: "acked", started: true });
    const onRoundFailure = vi.fn(async () => "retryable" as const);

    await supervisor(hooks(), onRoundFailure).supervisor.scan();

    expect(store.getSessionCommand(id)).toMatchObject({ status: "acked", next_check_at: "2026-08-27T20:06:00.000Z" });
    expect(events("round_stage_recovery_deferred")).toHaveLength(1);
  });

  it("leaves command ownership due and marks supervisor health red when recovery throws", async () => {
    const { id } = seedRoundCommand({ status: "acked", started: true });
    const onRoundFailure = vi.fn(async () => { throw new Error("tmux kill refused"); });
    const s = supervisor(hooks(), onRoundFailure).supervisor;

    await expect(s.scan()).rejects.toThrow(/tmux kill refused/);

    expect(store.getSessionCommand(id)?.status).toBe("acked");
    expect(s.health()).toMatchObject({ healthy: false, last_error: expect.stringContaining("tmux kill refused") });
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
    const receipt = new Promise<boolean | null>((resolve) => { release = () => resolve(null); });
    const s = supervisor(hooks({ wakeReceiptPresent: async () => receipt, sessionAlive: async () => true })).supervisor;
    expect(s.health().healthy).toBe(false); // no successful scan is not health evidence

    const pending = s.scan();
    await vi.waitFor(() => expect(store.supervisorLease("round-stage")?.last_attempt_at).toBe(clock.toISOString()));
    expect(store.supervisorLease("round-stage")?.last_success_at).toBeNull();
    clock = new Date(clock.getTime() + ((baseCfg.daemon.round_stage_supervisor_stale_s ?? 180) + 1) * 1000);
    expect(s.health()).toMatchObject({ healthy: false, last_success_at: null });
    release();
    await pending;
    expect(store.supervisorLease("round-stage")?.last_success_at).toBe(clock.toISOString());
    expect(s.health().healthy).toBe(true);
  });
});

function events(kind: string): Array<{ pr: number | null; payload: any }> {
  return (store.db.prepare("SELECT pr, payload FROM events WHERE kind=? ORDER BY id").all(kind) as Array<{ pr: number | null; payload: string }>).map(
    (row) => ({ pr: row.pr, payload: JSON.parse(row.payload) }),
  );
}

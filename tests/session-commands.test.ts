import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../src/state.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const T0 = "2026-08-27T20:00:00.000Z";

function input(id: string, pr = 5408) {
  return {
    id,
    pr,
    session: `pr-${pr}`,
    kind: "round" as const,
    round_no: 20,
    payload_sha256: "a".repeat(64),
    payload_path: `/state/session-commands/${id}.md`,
    inject_path: `/inject/pr-${pr}/wake--cmd-${id}.md`,
    next_check_at: "2026-08-27T20:02:00.000Z",
  };
}

describe("durable PR-session command slot", () => {
  const stores: StateStore[] = [];
  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
  });

  const open = (path = ":memory:") => {
    const store = new StateStore(path, () => new Date(T0));
    stores.push(store);
    return store;
  };

  it(
    "persists one finite pending slot with exact command identity and payload evidence",
    { timeout: HEAVY_TIMEOUT_MS },
    () => {
      const store = open();
      const row = store.createSessionCommand(input("cmd-a"));

      expect(row).toMatchObject({
        id: "cmd-a",
        pr: 5408,
        session: "pr-5408",
        kind: "round",
        round_no: 20,
        payload_sha256: "a".repeat(64),
        payload_path: "/state/session-commands/cmd-a.md",
        inject_path: "/inject/pr-5408/wake--cmd-cmd-a.md",
        status: "pending",
        attempt: 0,
        owner_token: null,
        next_check_at: "2026-08-27T20:02:00.000Z",
      });
      expect(store.activeSessionCommand("pr-5408")?.id).toBe("cmd-a");
    },
  );

  it("structurally forbids two nonterminal commands for one PR session", () => {
    const store = open();
    store.createSessionCommand(input("cmd-a"));
    expect(() =>
      store.createSessionCommand({ ...input("cmd-b"), kind: "wake", round_no: null }),
    ).toThrow(/UNIQUE constraint failed/);

    store.createSessionCommand(input("cmd-other", 5409));
    expect(store.activeSessionCommand("pr-5409")?.id).toBe("cmd-other");
  });

  it("claims pending work with an owner token and rejects stale-owner terminalization", () => {
    const store = open();
    store.createSessionCommand(input("cmd-a"));

    const running = store.claimSessionCommand("cmd-a", "bridge-new", "2026-08-27T20:30:00.000Z");
    expect(running).toMatchObject({ status: "running", owner_token: "bridge-new", attempt: 1 });
    expect(
      store.claimSessionCommand("cmd-a", "bridge-old", "2026-08-27T20:31:00.000Z"),
    ).toBeUndefined();
    expect(store.finishSessionCommand("cmd-a", "bridge-old", "acked")).toBe(false);
    expect(store.finishSessionCommand("cmd-a", "bridge-new", "acked")).toBe(false); // not accepted yet
    expect(store.markSessionCommandStarted("cmd-a", "bridge-new", "2026-08-27T20:30:00.000Z")).toBe(
      true,
    );
    expect(store.finishSessionCommand("cmd-a", "bridge-new", "acked")).toBe(true);
    expect(store.getSessionCommand("cmd-a")).toMatchObject({
      status: "acked",
      owner_token: "bridge-new",
    });
    expect(store.activeSessionCommand("pr-5408")).toBeUndefined();
  });

  it("retries a terminal command under the same id and exact payload evidence", () => {
    const store = open();
    store.createSessionCommand(input("cmd-a"));
    store.claimSessionCommand("cmd-a", "bridge-a", "2026-08-27T20:30:00.000Z");
    expect(
      store.finishSessionCommand("cmd-a", "bridge-a", "failed", "no correlated run message"),
    ).toBe(true);
    expect(store.activeSessionCommand("pr-5408")).toBeUndefined();
    expect(store.blockingSessionCommand("pr-5408")).toMatchObject({
      id: "cmd-a",
      status: "failed",
    });

    expect(
      store.retrySessionCommand("cmd-a", {
        inject_path: "/inject/pr-5408/retry--cmd-cmd-a.md",
        next_check_at: "2026-08-27T20:04:00.000Z",
      }),
    ).toBe(true);
    expect(store.getSessionCommand("cmd-a")).toMatchObject({
      id: "cmd-a",
      status: "pending",
      owner_token: null,
      attempt: 1,
      payload_sha256: "a".repeat(64),
      payload_path: "/state/session-commands/cmd-a.md",
      inject_path: "/inject/pr-5408/retry--cmd-cmd-a.md",
      next_check_at: "2026-08-27T20:04:00.000Z",
    });
  });

  it("exposes due work and gives unknown evidence exactly one durable deferral", () => {
    const store = open();
    store.createSessionCommand({ ...input("cmd-a"), next_check_at: "2026-08-27T19:59:00.000Z" });
    store.claimSessionCommand("cmd-a", "bridge-a", "2026-08-27T19:59:30.000Z");

    expect(store.dueSessionCommands(T0)).toMatchObject([{ id: "cmd-a", unknown_checks: 0 }]);
    expect(store.deferSessionCommandEvidence("cmd-a", "2026-08-27T20:01:00.000Z")).toBe(true);
    expect(store.getSessionCommand("cmd-a")).toMatchObject({
      unknown_checks: 1,
      next_check_at: "2026-08-27T20:01:00.000Z",
    });
    expect(store.dueSessionCommands(T0)).toEqual([]);
  });

  it("durably bounds automatic recovery even before another bridge reserves the replay", () => {
    const store = open();
    store.createSessionCommand({ ...input("cmd-a"), kind: "wake", round_no: null });

    expect(store.beginSessionCommandRecovery("cmd-a", 0)).toBe(true);
    expect(store.beginSessionCommandRecovery("cmd-a", 0)).toBe(false);
    expect(store.getSessionCommand("cmd-a")).toMatchObject({ recovery_attempts: 1, attempt: 0 });
  });

  it("reconciles a correlated start and supervisor-fails active ownership atomically", () => {
    const store = open();
    store.createSessionCommand(input("cmd-a"));
    store.claimSessionCommand("cmd-a", "bridge-a", "2026-08-27T20:02:00.000Z");

    expect(store.observeSessionCommandStarted("cmd-a", T0, "2026-08-27T20:45:00.000Z")).toBe(true);
    expect(store.getSessionCommand("cmd-a")).toMatchObject({
      status: "running",
      owner_token: "bridge-a",
      started_at: T0,
      next_check_at: "2026-08-27T20:45:00.000Z",
    });
    expect(store.failActiveSessionCommand("cmd-a", "hard bound exhausted")).toBe(true);
    expect(store.getSessionCommand("cmd-a")).toMatchObject({
      status: "failed",
      failure: "hard bound exhausted",
    });
  });

  it("persists the supervisor attempt and success lease independently", () => {
    const store = open();
    store.markSupervisorAttempt("round-stage", "2026-08-27T20:00:00.000Z");
    expect(store.supervisorLease("round-stage")).toMatchObject({
      last_attempt_at: "2026-08-27T20:00:00.000Z",
      last_success_at: null,
      last_error: null,
    });

    store.markSupervisorSuccess("round-stage", "2026-08-27T20:00:05.000Z");
    expect(store.supervisorLease("round-stage")).toMatchObject({
      last_attempt_at: "2026-08-27T20:00:00.000Z",
      last_success_at: "2026-08-27T20:00:05.000Z",
      last_error: null,
    });
  });

  it("releases a failed round command only after that round terminalizes", () => {
    const store = open();
    store.upsertPr({
      number: 5408,
      state: "reviewing",
      head_sha: "abc",
      title: "PR 5408",
      author: "alice",
      trigger_ts: null,
      stale_recheck: 0,
      migration_gate: 0,
    });
    const roundId = store.startRound(5408, "first", ["pass-baseline"], 75);
    store.createSessionCommand({ ...input("cmd-a"), round_no: 1 });
    store.claimSessionCommand("cmd-a", "bridge-a", "2026-08-27T20:02:00.000Z");
    store.finishSessionCommand("cmd-a", "bridge-a", "failed", "no start");
    expect(store.blockingSessionCommand("pr-5408")?.id).toBe("cmd-a");

    store.markRoundCancelled(roundId, "infrastructure recovery", "infrastructure_failure");
    expect(store.blockingSessionCommand("pr-5408")).toBeUndefined();
  });

  it("migrates the pre-supervisor command table without losing its active row", () => {
    const dir = mkdtempSync(join(tmpdir(), "qcr-session-command-old-"));
    try {
      const path = join(dir, "state.db");
      const old = new Database(path);
      old.exec(`
        CREATE TABLE session_commands (
          id TEXT PRIMARY KEY, pr INTEGER NOT NULL, session TEXT NOT NULL,
          kind TEXT NOT NULL, round_no INTEGER, payload_sha256 TEXT NOT NULL,
          payload_path TEXT NOT NULL, inject_path TEXT NOT NULL,
          status TEXT NOT NULL, owner_token TEXT, attempt INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL, next_check_at TEXT NOT NULL,
          started_at TEXT, settled_at TEXT, failed_at TEXT, failure TEXT
        );
      `);
      old
        .prepare(
          `INSERT INTO session_commands
        (id,pr,session,kind,round_no,payload_sha256,payload_path,inject_path,status,owner_token,attempt,created_at,updated_at,next_check_at)
        VALUES ('cmd-old',5408,'pr-5408','round',20,?,?,?,'pending',NULL,0,?,?,?)`,
        )
        .run("a".repeat(64), "/state/old.md", "/inject/old.md", T0, T0, "2026-08-27T20:02:00.000Z");
      old.close();

      const migrated = open(path);
      expect(migrated.getSessionCommand("cmd-old")).toMatchObject({
        status: "pending",
        unknown_checks: 0,
        recovery_attempts: 0,
      });
      expect(migrated.supervisorLease("round-stage")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("operator recovery cancels only the target PR's blocking round command", () => {
    const store = open();
    store.createSessionCommand(input("cmd-target"));
    store.createSessionCommand(input("cmd-other", 5409));

    const result = store.cancelBlockingSessionCommandsForOperator(5408, [], "restart-session", [
      "cmd-target",
    ]);

    expect(result).toEqual({ cancelled_command_ids: ["cmd-target"], recovered_wake_ids: [] });
    expect(store.getSessionCommand("cmd-target")).toMatchObject({
      status: "cancelled",
      failure: "operator restart-session",
    });
    expect(store.blockingSessionCommand("pr-5408")).toBeUndefined();
    expect(store.blockingSessionCommand("pr-5409")?.id).toBe("cmd-other");
  });

  it("restores non-round payloads byte-for-byte ahead of later held wakes", () => {
    const store = open();
    store.createSessionCommand({ ...input("cmd-wake"), kind: "wake", round_no: null });
    store.holdWake(5408, "later wake\n", "author_reply");

    const result = store.cancelBlockingSessionCommandsForOperator(
      5408,
      [{ id: "cmd-wake", payload: "original wake\n" }],
      "restart-session",
      ["cmd-wake"],
    );

    expect(result.cancelled_command_ids).toEqual(["cmd-wake"]);
    expect(store.heldWakes(5408).map((wake) => wake.payload)).toEqual([
      "original wake\n",
      "later wake\n",
    ]);
    expect(store.getSessionCommand("cmd-wake")?.status).toBe("cancelled");
  });

  it("never evicts an operator-recovered payload when later wakes fill the cap", () => {
    const store = open();
    store.createSessionCommand({ ...input("cmd-wake"), kind: "wake", round_no: null });
    // Ordinary (evictable) wakes: since H1b an author reply is never
    // evicted, so the filler must be a wake the cap may drop.
    for (let i = 0; i < 5; i++) store.holdWake(5408, `later-${i}`, "ledger_stale");

    store.cancelBlockingSessionCommandsForOperator(
      5408,
      [{ id: "cmd-wake", payload: "recovered-first" }],
      "restart-session",
      ["cmd-wake"],
    );
    store.holdWake(5408, "latest", "ledger_stale");

    const wakes = store.heldWakes(5408);
    expect(wakes).toHaveLength(5);
    expect(wakes[0]).toMatchObject({
      payload: "recovered-first",
      reason: "operator_recovered:wake:cmd-wake",
    });
    expect(wakes.slice(1).map((wake) => wake.payload)).toEqual([
      "later-2",
      "later-3",
      "later-4",
      "latest",
    ]);
  });

  it("rolls back when a blocking non-round payload was not recovered", () => {
    const store = open();
    store.createSessionCommand({ ...input("cmd-wake"), kind: "wake", round_no: null });

    expect(() =>
      store.cancelBlockingSessionCommandsForOperator(5408, [], "restart-session", ["cmd-wake"]),
    ).toThrow(/payload set does not match/);
    expect(store.blockingSessionCommand("pr-5408")?.id).toBe("cmd-wake");
    expect(store.heldWakes(5408)).toEqual([]);
  });

  it("migrates the status constraint so existing rows can be operator-cancelled", () => {
    const dir = mkdtempSync(join(tmpdir(), "qcr-session-command-cancelled-"));
    try {
      const path = join(dir, "state.db");
      const old = new Database(path);
      old.exec(`
        CREATE TABLE session_commands (
          id TEXT PRIMARY KEY, pr INTEGER NOT NULL, session TEXT NOT NULL,
          kind TEXT NOT NULL, round_no INTEGER, payload_sha256 TEXT NOT NULL,
          payload_path TEXT NOT NULL, inject_path TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending','running','acked','failed')),
          owner_token TEXT, attempt INTEGER NOT NULL DEFAULT 0,
          unknown_checks INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL, next_check_at TEXT NOT NULL,
          started_at TEXT, settled_at TEXT, failed_at TEXT, failure TEXT
        );
        CREATE UNIQUE INDEX session_commands_one_active
          ON session_commands(session) WHERE status IN ('pending', 'running');
        CREATE UNIQUE INDEX session_commands_inject_path ON session_commands(inject_path);
        CREATE INDEX session_commands_pr_created ON session_commands(pr, created_at);
      `);
      old
        .prepare(
          `INSERT INTO session_commands
        (id,pr,session,kind,round_no,payload_sha256,payload_path,inject_path,status,owner_token,attempt,created_at,updated_at,next_check_at)
        VALUES ('cmd-old',5408,'pr-5408','round',20,?,?,?,'pending',NULL,0,?,?,?)`,
        )
        .run("a".repeat(64), "/state/old.md", "/inject/old.md", T0, T0, "2026-08-27T20:02:00.000Z");
      old.close();

      const second = open(path);
      expect(
        second.cancelBlockingSessionCommandsForOperator(5408, [], "restart-session", ["cmd-old"])
          .cancelled_command_ids,
      ).toEqual(["cmd-old"]);
      expect(second.getSessionCommand("cmd-old")?.status).toBe("cancelled");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reconstructs the same active slot after a store restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "qcr-session-command-"));
    try {
      const path = join(dir, "state.db");
      const first = open(path);
      first.createSessionCommand(input("cmd-a"));
      first.close();
      stores.splice(stores.indexOf(first), 1);

      const second = open(path);
      expect(second.activeSessionCommand("pr-5408")).toMatchObject({
        id: "cmd-a",
        status: "pending",
      });
      expect(second.getSessionCommandByInjectPath(input("cmd-a").inject_path)?.id).toBe("cmd-a");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// H1b (#5362 ③): the same-session redelivery CAS.
describe("requeueSessionCommandForRedelivery", () => {
  const stores: StateStore[] = [];
  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
  });
  const open = () => {
    const store = new StateStore(":memory:", () => new Date(T0));
    stores.push(store);
    return store;
  };
  const wake = (id: string) => ({ ...input(id), kind: "wake" as const, round_no: null });

  it("hands an unstarted command back to pending under the same id, counting the redelivery", () => {
    const store = open();
    store.createSessionCommand(wake("cmd-r"));
    store.claimSessionCommand("cmd-r", "bridge-1", "2026-08-27T20:02:00.000Z");

    expect(
      store.requeueSessionCommandForRedelivery(
        "cmd-r",
        { attempt: 1, redeliveries: 0, next_check_at: "2026-08-27T20:02:00.000Z" },
        "2026-08-27T20:04:00.000Z",
      ),
    ).toBe(true);
    expect(store.getSessionCommand("cmd-r")).toMatchObject({
      status: "pending",
      owner_token: null,
      attempt: 1, // a reservation, not a redelivery, moves the attempt
      redeliveries: 1,
      started_at: null,
      next_check_at: "2026-08-27T20:04:00.000Z",
    });
    expect(store.blockingSessionCommand("pr-5408")?.id).toBe("cmd-r"); // still the one slot
  });

  it("loses to a bridge that reserved or started it meanwhile, and never touches a started one", () => {
    const store = open();
    store.createSessionCommand(wake("cmd-s"));
    store.claimSessionCommand("cmd-s", "bridge-1", "2026-08-27T20:02:00.000Z");
    // Read at attempt 1; a second reservation happened since.
    store.db.prepare("UPDATE session_commands SET attempt=2 WHERE id='cmd-s'").run();
    expect(
      store.requeueSessionCommandForRedelivery(
        "cmd-s",
        { attempt: 1, redeliveries: 0, next_check_at: "2026-08-27T20:02:00.000Z" },
        T0,
      ),
    ).toBe(false);

    store.markSessionCommandStarted("cmd-s", "bridge-1", "2026-08-27T20:45:00.000Z");
    expect(
      store.requeueSessionCommandForRedelivery(
        "cmd-s",
        { attempt: 2, redeliveries: 0, next_check_at: "2026-08-27T20:45:00.000Z" },
        T0,
      ),
    ).toBe(false);
    expect(store.getSessionCommand("cmd-s")).toMatchObject({ status: "running", redeliveries: 0 });
  });

  it("re-offers a round prompt only while its round is still running", () => {
    const store = open();
    store.upsertPr({
      number: 5408,
      state: "reviewing",
      head_sha: "abc",
      title: "t",
      author: "a",
      trigger_ts: null,
      stale_recheck: 0,
      migration_gate: 0,
    });
    const roundId = store.startRound(5408, "first", ["pass-baseline"], 75);
    const roundNo = store.roundsFor(5408)[0]!.round_no;
    store.createSessionCommand({ ...input("cmd-round"), round_no: roundNo });
    expect(
      store.requeueSessionCommandForRedelivery(
        "cmd-round",
        { attempt: 0, redeliveries: 0, next_check_at: "2026-08-27T20:02:00.000Z" },
        T0,
      ),
    ).toBe(true);

    store.markRoundCancelled(roundId, "operator restart-session", "operator");
    expect(
      store.requeueSessionCommandForRedelivery(
        "cmd-round",
        { attempt: 0, redeliveries: 1, next_check_at: T0 }, // the row exactly as it stands
        T0,
      ),
    ).toBe(false);
  });

  // H1b review: the CAS is on the row the supervisor found DUE. A
  // bridge that re-reserved it since moved `attempt` and `next_check_at`; one
  // that only rescheduled it moved `next_check_at`. Neither is stale.
  it("refuses a row whose lease moved since the supervisor's due read, attempt unchanged or not", () => {
    const store = open();
    store.createSessionCommand(wake("cmd-m"));
    store.claimSessionCommand("cmd-m", "bridge-1", "2026-08-27T20:02:00.000Z");
    const due = { attempt: 1, redeliveries: 0, next_check_at: "2026-08-27T20:02:00.000Z" };

    // Only the lease moved (attempt untouched): still not the row that was due.
    store.db
      .prepare("UPDATE session_commands SET next_check_at=? WHERE id='cmd-m'")
      .run("2026-08-27T20:06:00.000Z");
    expect(store.requeueSessionCommandForRedelivery("cmd-m", due, T0)).toBe(false);
    expect(store.getSessionCommand("cmd-m")).toMatchObject({
      status: "running",
      owner_token: "bridge-1",
      redeliveries: 0,
    });

    // The row exactly as observed is handed back.
    expect(
      store.requeueSessionCommandForRedelivery(
        "cmd-m",
        { ...due, next_check_at: "2026-08-27T20:06:00.000Z" },
        T0,
      ),
    ).toBe(true);
  });
});

// H1b review: the same-session redelivery budget belongs to one
// session generation (or one delivery lifecycle). A replay into a fresh
// session — or a terminal command handed back — starts it again, so that
// conversation's first missed start is redelivered, not killed.
describe("a replay starts the redelivery budget again", () => {
  const stores: StateStore[] = [];
  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
  });
  const open = () => {
    const store = new StateStore(":memory:", () => new Date(T0));
    stores.push(store);
    return store;
  };
  const wake = (id: string) => ({ ...input(id), kind: "wake" as const, round_no: null });

  it("retrySessionCommandAfterFence (kill-and-replay into a rebirth) resets redeliveries", () => {
    const store = open();
    store.createSessionCommand(wake("cmd-f"));
    store.claimSessionCommand("cmd-f", "bridge-1", "2026-08-27T20:02:00.000Z");
    store.db.prepare("UPDATE session_commands SET redeliveries=2 WHERE id='cmd-f'").run();

    expect(store.retrySessionCommandAfterFence("cmd-f", 1, "2026-08-27T20:04:00.000Z")).toBe(true);
    expect(store.getSessionCommand("cmd-f")).toMatchObject({
      status: "pending",
      attempt: 1,
      redeliveries: 0,
    });
  });

  it("retrySessionCommand (a terminal command handed back) resets redeliveries", () => {
    const store = open();
    store.createSessionCommand(wake("cmd-t"));
    store.claimSessionCommand("cmd-t", "bridge-1", "2026-08-27T20:02:00.000Z");
    store.db.prepare("UPDATE session_commands SET redeliveries=2 WHERE id='cmd-t'").run();
    store.failActiveSessionCommand("cmd-t", "no start");

    expect(
      store.retrySessionCommand("cmd-t", {
        inject_path: "/inject/pr-5408/wake--cmd-cmd-t.md",
        next_check_at: "2026-08-27T20:04:00.000Z",
      }),
    ).toBe(true);
    expect(store.getSessionCommand("cmd-t")).toMatchObject({ status: "pending", redeliveries: 0 });
  });
});

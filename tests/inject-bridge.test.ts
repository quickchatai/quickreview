// inject-bridge consume/defer semantics. Three live losses (#5317
// round 2, #5257 round 8, #5362 round 2) shared one mechanism: a round prompt
// handed to a session that was still streaming was silently dropped, and the
// round then sat "running" until its deadline.
//
// The contract under test, in three layers — each covering a different half:
//   1. a file remains pending after fire-and-forget submission and is consumed
//      only when the run-start message correlates its injected marker;
//   2. while that run is active no successor submits, and only a deferred
//      `agent_settled` drain may advance the queue (#5362: `turn_end` is an
//      INNER-loop event and clearing on it re-opens every tool-call gap);
//   3. every send still carries `deliverAs: "followUp"` as a belt, while a
//      missing start acknowledgement expires loudly and preserves the file.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pi } from "@earendil-works/pi-coding-agent";
import activate, { RETRY_BASE_MS, START_ACK_TIMEOUT_MS } from "../extensions/inject-bridge.js";
import { readSessionBridgeState } from "../src/session-bridge.js";
import { StateStore } from "../src/state.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

let dir: string;
let handlers: Map<string, Array<(...args: unknown[]) => unknown>>;
let sends: Array<{ content: string; options?: { deliverAs?: string } }>;
// Production Pi 0.84.1 declares the extension-facing submission as `void`.
// The internal Promise is intentionally unavailable to extensions, so this
// fake must never offer tests stronger serialization than production has.
let sendImpl: (content: string) => void;
let savedEnv: {
  inject?: string;
  session?: string;
  stateDb?: string;
  root?: string;
  bridgeGeneration?: string;
  bridgeStateFile?: string;
  bridgeLedgerRequired?: string;
};

function fakePi(): Pi {
  return {
    on(event: string, handler: (...args: unknown[]) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    sendUserMessage(content: string, options?: { deliverAs?: string }): void {
      sends.push({ content, ...(options ? { options } : {}) });
      sendImpl(content);
    },
  } as unknown as Pi;
}

function fire(event: string, payload: unknown = {}): void {
  for (const h of handlers.get(event) ?? []) h(payload);
}

function sentBody(index: number): string {
  return sends[index]!.content.replace(/\n\n<!-- qcr-inject:[^\n]+ -->$/, "");
}

function acknowledgeLatest(): void {
  const content = sends.at(-1)!.content;
  fire("agent_start");
  fire("message_start", { message: { role: "user", content: [{ type: "text", text: content }] } });
}

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

function pending(): string[] {
  return readdirSync(dir).filter((f) => f.endsWith(".md"));
}
function done(): string[] {
  const d = join(dir, ".done");
  return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".md")) : [];
}
function terminal(): string[] {
  const d = join(dir, ".terminal");
  return existsSync(d) ? readdirSync(d) : [];
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-bridge-"));
  handlers = new Map();
  sends = [];
  sendImpl = () => {};
  savedEnv = {
    inject: process.env.QCR_INJECT_DIR,
    session: process.env.QCR_SESSION_NAME,
    stateDb: process.env.QCR_STATE_DB,
    root: process.env.QCR_SANDBOX_ROOT,
    bridgeGeneration: process.env.QCR_SESSION_BRIDGE_GENERATION,
    bridgeStateFile: process.env.QCR_SESSION_BRIDGE_STATE_FILE,
    bridgeLedgerRequired: process.env.QCR_SESSION_BRIDGE_LEDGER_REQUIRED,
  };
  process.env.QCR_INJECT_DIR = dir;
  process.env.QCR_SESSION_NAME = "pr-1";
  process.env.QCR_SESSION_BRIDGE_GENERATION = "generation-1";
  process.env.QCR_SESSION_BRIDGE_STATE_FILE = join(dir, "bridge-state.json");
  process.env.QCR_SESSION_BRIDGE_LEDGER_REQUIRED = "0";
  delete process.env.QCR_STATE_DB;
  delete process.env.QCR_SANDBOX_ROOT;
});

afterEach(() => {
  fire("session_shutdown"); // closes the watcher and cancels bridge timers
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (savedEnv.inject === undefined) delete process.env.QCR_INJECT_DIR;
  else process.env.QCR_INJECT_DIR = savedEnv.inject;
  if (savedEnv.session === undefined) delete process.env.QCR_SESSION_NAME;
  else process.env.QCR_SESSION_NAME = savedEnv.session;
  if (savedEnv.stateDb === undefined) delete process.env.QCR_STATE_DB;
  else process.env.QCR_STATE_DB = savedEnv.stateDb;
  if (savedEnv.root === undefined) delete process.env.QCR_SANDBOX_ROOT;
  else process.env.QCR_SANDBOX_ROOT = savedEnv.root;
  if (savedEnv.bridgeGeneration === undefined) delete process.env.QCR_SESSION_BRIDGE_GENERATION;
  else process.env.QCR_SESSION_BRIDGE_GENERATION = savedEnv.bridgeGeneration;
  if (savedEnv.bridgeStateFile === undefined) delete process.env.QCR_SESSION_BRIDGE_STATE_FILE;
  else process.env.QCR_SESSION_BRIDGE_STATE_FILE = savedEnv.bridgeStateFile;
  if (savedEnv.bridgeLedgerRequired === undefined)
    delete process.env.QCR_SESSION_BRIDGE_LEDGER_REQUIRED;
  else process.env.QCR_SESSION_BRIDGE_LEDGER_REQUIRED = savedEnv.bridgeLedgerRequired;
  rmSync(dir, { recursive: true, force: true });
});

describe("inject-bridge — start-acknowledged single flight", () => {
  it("retains a submitted file until its correlated run-start message", async () => {
    writeFileSync(join(dir, "2026-08-20T11-23-20-0000.md"), "ROUND 2 prompt");

    activate(fakePi());
    fire("session_start");

    expect(readSessionBridgeState(process.env.QCR_SESSION_BRIDGE_STATE_FILE!)).toMatchObject({
      session: "pr-1",
      generation: "generation-1",
      stage: "ready",
    });
    await vi.waitFor(() => expect(sends).toHaveLength(1));
    expect(pending()).toHaveLength(1);
    expect(done()).toHaveLength(0);

    acknowledgeLatest();
    await vi.waitFor(() => expect(done()).toHaveLength(1));
    expect(pending()).toHaveLength(0);
  });

  it("does not let an unrelated agent run acknowledge the submitted wake", async () => {
    writeFileSync(join(dir, "2026-08-20T11-23-21-0000.md"), "daemon prompt");
    activate(fakePi());
    fire("session_start");
    await vi.waitFor(() => expect(sends).toHaveLength(1));

    fire("agent_start");
    fire("message_start", {
      message: { role: "user", content: [{ type: "text", text: "interactive operator prompt" }] },
    });
    expect(pending()).toHaveLength(1);
    expect(done()).toHaveLength(0);

    fire("message_start", {
      message: { role: "user", content: [{ type: "text", text: sends[0]!.content }] },
    });
    await vi.waitFor(() => expect(done()).toHaveLength(1));
  });

  it("treats auto-retry agent_start events as one outer run with one settlement", async () => {
    activate(fakePi());
    fire("session_start");
    fire("agent_start");
    fire("agent_start"); // pinned Pi emits this again for agent.continue retry
    writeFileSync(join(dir, "2026-08-20T11-23-22-0000.md"), "pending");
    await sleep(150);
    expect(sends).toHaveLength(0);

    fire("agent_settled"); // one settlement covers the whole retrying run
    await vi.waitFor(() => expect(sends).toHaveLength(1));
    expect(sentBody(0)).toBe("pending");
  });

  it("a synchronous adapter failure retries on its timer and still requires correlated acceptance", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    let calls = 0;
    sendImpl = () => {
      calls++;
      if (calls === 1) throw new Error("adapter failed synchronously");
    };
    writeFileSync(join(dir, "2026-08-20T12-42-02-0000.md"), "round prompt");

    activate(fakePi());
    fire("session_start");

    expect(sends).toHaveLength(1);
    expect(pending()).toHaveLength(1);
    expect(done()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS);
    expect(sends).toHaveLength(2);
    expect(pending()).toHaveLength(1);
    acknowledgeLatest();
    expect(done()).toHaveLength(1);
  });

  it("an invisible asynchronous rejection expires loudly and preserves recoverable evidence", async () => {
    vi.useFakeTimers();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    sendImpl = () => {
      void Promise.reject(new Error("prompt preflight failed")).catch(() => {});
    };
    writeFileSync(join(dir, "2026-08-20T12-42-03-0000.md"), "lost round prompt");

    activate(fakePi());
    fire("session_start");
    await vi.advanceTimersByTimeAsync(0);
    expect(sends).toHaveLength(1);
    expect(pending()).toHaveLength(1);
    expect(done()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(START_ACK_TIMEOUT_MS);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("FAILED_LOUD"));
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("2026-08-20T12-42-03-0000.md"));
    expect(pending()).toHaveLength(1);
    expect(done()).toHaveLength(0);
    expect(sends).toHaveLength(1); // no blind retry storm
  });

  it("defers while a run is active, then waits for start acknowledgement after settle", async () => {
    activate(fakePi());
    fire("session_start");
    fire("turn_start");

    writeFileSync(join(dir, "2026-08-20T11-23-20-0001.md"), "held round prompt");
    await sleep(150);
    expect(sends).toHaveLength(0);
    expect(pending()).toHaveLength(1);

    fire("agent_settled");
    await vi.waitFor(() => expect(sends).toHaveLength(1));
    expect(done()).toHaveLength(0);
    acknowledgeLatest();
    await vi.waitFor(() => expect(done()).toHaveLength(1));
  });

  it("settlement schedules the next submission after event dispatch, never re-entrantly", async () => {
    activate(fakePi());
    fire("session_start");
    fire("agent_start");
    writeFileSync(join(dir, "2026-08-20T11-23-20-0002.md"), "deferred prompt");
    await sleep(150);
    expect(sends).toHaveLength(0);

    fire("agent_settled");
    expect(sends).toHaveLength(0); // the callback returned before Pi submission
    await vi.waitFor(() => expect(sends).toHaveLength(1));
  });

  it("does not let an older settlement release a run that starts before the deferred drain", async () => {
    activate(fakePi());
    fire("session_start");
    fire("agent_start");
    writeFileSync(join(dir, "2026-08-20T11-23-20-0003.md"), "deferred prompt");
    await sleep(150);

    fire("agent_settled");
    fire("agent_start"); // a newer run begins before the zero-delay drain
    await sleep(20);
    expect(sends).toHaveLength(0);

    fire("agent_settled");
    await vi.waitFor(() => expect(sends).toHaveLength(1));
  });

  it("retains a newer settlement that arrives before the older deferred drain", async () => {
    activate(fakePi());
    fire("session_start");
    fire("agent_start");
    writeFileSync(join(dir, "2026-08-20T11-23-20-0004.md"), "deferred prompt");
    await sleep(150);

    fire("agent_settled");
    fire("agent_start");
    fire("agent_settled");
    expect(sends).toHaveLength(0); // never re-entrant
    await vi.waitFor(() => expect(sends).toHaveLength(1));
  });

  it(
    "never overrides an active run merely because the old 15-minute hold elapsed",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const t0 = Date.now();
      const now = vi.spyOn(Date, "now").mockReturnValue(t0);
      activate(fakePi());
      fire("session_start");
      fire("agent_start");

      writeFileSync(join(dir, "2026-08-20T13-00-00-0000.md"), "wake A");
      await sleep(150);
      now.mockReturnValue(t0 + 15 * 60_000 + 1);
      writeFileSync(join(dir, "2026-08-20T13-00-01-0000.md"), "wake B");
      await sleep(150);

      expect(sends).toHaveLength(0);
      expect(pending()).toHaveLength(2);
      expect(done()).toHaveLength(0);
    },
  );

  it("submits at most one wake, then waits for its acknowledged run to settle", async () => {
    writeFileSync(join(dir, "2026-08-20T14-00-00-0000.md"), "first");
    writeFileSync(join(dir, "2026-08-20T14-00-01-0000.md"), "second");
    activate(fakePi());
    fire("session_start");

    await vi.waitFor(() => expect(sends).toHaveLength(1));
    expect(sentBody(0)).toBe("first");
    expect(pending()).toHaveLength(2);

    acknowledgeLatest();
    await vi.waitFor(() => expect(done()).toHaveLength(1));
    expect(sends).toHaveLength(1); // acknowledged, but its run is active

    fire("agent_settled");
    await vi.waitFor(() => expect(sends).toHaveLength(2));
    expect(sentBody(1)).toBe("second");
    expect(pending()).toHaveLength(1);
    acknowledgeLatest();
    await vi.waitFor(() => expect(done()).toHaveLength(2));
  });

  it("orders three author replies before a round prompt without loss or interleaving", async () => {
    const messages = ["reply A", "reply B", "reply C", "ROUND 20 prompt"];
    for (const [index, message] of messages.entries()) {
      writeFileSync(join(dir, `2026-08-20T14-01-0${index}-0000.md`), message);
    }
    activate(fakePi());
    fire("session_start");

    for (let index = 0; index < messages.length; index++) {
      await vi.waitFor(() => expect(sends).toHaveLength(index + 1));
      expect(sentBody(index)).toBe(messages[index]);
      expect(done()).toHaveLength(index);
      acknowledgeLatest();
      await vi.waitFor(() => expect(done()).toHaveLength(index + 1));
      expect(sends).toHaveLength(index + 1);
      fire("agent_settled");
    }
    await sleep(20);
    expect(sends).toHaveLength(messages.length);
    expect(pending()).toHaveLength(0);
  });

  it("retries an acknowledged archive failure on settlement before advancing", async () => {
    const file = "2026-08-20T14-01-09-0000.md";
    writeFileSync(join(dir, file), "prompt");
    mkdirSync(join(dir, ".done", file), { recursive: true });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    activate(fakePi());
    fire("session_start");
    await vi.waitFor(() => expect(sends).toHaveLength(1));

    acknowledgeLatest();
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("FAILED_LOUD"));
    expect(pending()).toHaveLength(1);

    rmSync(join(dir, ".done", file), { recursive: true });
    fire("agent_settled");
    await vi.waitFor(() => expect(done()).toHaveLength(1));
    expect(pending()).toHaveLength(0);
  });

  it("handles correlated run events emitted during the submission call", async () => {
    sendImpl = (content) => {
      fire("agent_start");
      fire("message_start", {
        message: { role: "user", content: [{ type: "text", text: content }] },
      });
    };
    writeFileSync(join(dir, "2026-08-20T14-02-00-0000.md"), "prompt");
    activate(fakePi());
    fire("session_start");

    await vi.waitFor(() => expect(sends).toHaveLength(1));
    await vi.waitFor(() => expect(done()).toHaveLength(1));
    expect(pending()).toHaveLength(0);
  });

  it("consumes an empty wake without a send", async () => {
    writeFileSync(join(dir, "2026-08-20T13-00-01-0000.md"), "  \n");
    activate(fakePi());
    fire("session_start");
    await vi.waitFor(() => expect(done()).toHaveLength(1));
    expect(sends).toHaveLength(0);
  });

  it("selects files oldest-first on start", async () => {
    writeFileSync(join(dir, "2026-08-20T10-00-01-0000.md"), "second");
    writeFileSync(join(dir, "2026-08-20T10-00-00-0000.md"), "first");
    activate(fakePi());
    fire("session_start");
    await vi.waitFor(() => expect(sends).toHaveLength(1));
    expect(sentBody(0)).toBe("first");
  });
});

describe("inject-bridge — durable command ownership", () => {
  it("fails closed when a managed PR bridge has no state database", () => {
    process.env.QCR_SESSION_BRIDGE_LEDGER_REQUIRED = "1";
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    activate(fakePi());
    fire("session_start");

    expect(readSessionBridgeState(process.env.QCR_SESSION_BRIDGE_STATE_FILE!)).toMatchObject({
      stage: "failed",
      failed_stage: "state_db",
    });
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("state_db"));
  });

  it("persists a pre-reserve ledger failure instead of presenting tmux as ready", () => {
    process.env.QCR_SESSION_BRIDGE_LEDGER_REQUIRED = "1";
    process.env.QCR_STATE_DB = join(dir, "missing-state.db");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    activate(fakePi());
    fire("session_start");

    expect(sends).toHaveLength(0);
    expect(readSessionBridgeState(process.env.QCR_SESSION_BRIDGE_STATE_FILE!)).toMatchObject({
      generation: "generation-1",
      stage: "failed",
      failed_stage: "ledger_open",
    });
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("ledger_open"));
  });

  function commandStore(): StateStore {
    const dbPath = join(dir, "state.db");
    process.env.QCR_SESSION_BRIDGE_LEDGER_REQUIRED = "1";
    process.env.QCR_STATE_DB = dbPath;
    process.env.QCR_SANDBOX_ROOT = dir;
    return new StateStore(dbPath, () => new Date("2026-08-27T20:00:00.000Z"));
  }

  it("quarantines an obsolete failed-round transport and continues to the next pending command", async () => {
    const store = commandStore();
    try {
      store.upsertPr({
        number: 1,
        state: "queued",
        head_sha: "head",
        title: "PR 1",
        author: "alice",
        trigger_ts: null,
        stale_recheck: 0,
        migration_gate: 0,
      });
      const staleRoundId = store.startRound(1, "re-review", ["pass-baseline"], 75);
      const staleRoundNo = store.roundsFor(1)[0]!.round_no;
      const staleFile = "2026-08-27T19-00-00-0000--cmd-stale-failed.md";
      const stalePath = join(dir, staleFile);
      const payloadDir = join(dir, "payloads");
      mkdirSync(payloadDir, { recursive: true });
      const stalePayload = "old failed command\n";
      writeFileSync(stalePath, stalePayload);
      writeFileSync(join(payloadDir, "stale.md"), stalePayload);
      store.createSessionCommand({
        id: "stale-failed",
        pr: 1,
        session: "pr-1",
        kind: "round",
        round_no: staleRoundNo,
        payload_sha256: createHash("sha256").update(stalePayload).digest("hex"),
        payload_path: join(payloadDir, "stale.md"),
        inject_path: stalePath,
        next_check_at: "2026-08-27T20:02:00.000Z",
      });
      store.failPendingSessionCommand("stale-failed", "delivery failed");
      store.markRoundCancelled(staleRoundId, "old round settled", "infrastructure_failure");

      const pendingFile = "2026-08-27T20-00-00-0000--cmd-current.md";
      const pendingPath = join(dir, pendingFile);
      const pendingPayload = "current batch\n";
      writeFileSync(pendingPath, pendingPayload);
      writeFileSync(join(payloadDir, "current.md"), pendingPayload);
      store.createSessionCommand({
        id: "current",
        pr: 1,
        session: "pr-1",
        kind: "wake",
        round_no: null,
        payload_sha256: createHash("sha256").update(pendingPayload).digest("hex"),
        payload_path: join(payloadDir, "current.md"),
        inject_path: pendingPath,
        next_check_at: "2026-08-27T20:02:00.000Z",
      });

      activate(fakePi());
      fire("session_start");

      await vi.waitFor(() => expect(sends).toHaveLength(1));
      expect(sentBody(0)).toContain("current batch");
      expect(terminal()).toEqual([`${staleFile}.failed`]);
      expect(done()).toEqual([]);
      expect(store.getSessionCommand("stale-failed")).toMatchObject({
        status: "failed",
        attempt: 0,
        failure: "delivery failed",
      });
      expect(store.getSessionCommand("current")).toMatchObject({ status: "running", attempt: 1 });
      expect(readSessionBridgeState(process.env.QCR_SESSION_BRIDGE_STATE_FILE!)).toMatchObject({
        stage: "ready",
      });
    } finally {
      fire("session_shutdown");
      store.close();
    }
  });

  it("quarantines a blocking failed transport but does not release its successor", () => {
    const store = commandStore();
    try {
      store.upsertPr({
        number: 1,
        state: "queued",
        head_sha: "head",
        title: "PR 1",
        author: "alice",
        trigger_ts: null,
        stale_recheck: 0,
        migration_gate: 0,
      });
      const payloadDir = join(dir, "payloads");
      mkdirSync(payloadDir, { recursive: true });
      const failedFile = "2026-08-27T19-00-00-0000--cmd-blocking-failed.md";
      const failedPath = join(dir, failedFile);
      const failedPayload = "failed ordinary wake\n";
      writeFileSync(failedPath, failedPayload);
      writeFileSync(join(payloadDir, "blocking-failed.md"), failedPayload);
      store.createSessionCommand({
        id: "blocking-failed",
        pr: 1,
        session: "pr-1",
        kind: "wake",
        round_no: null,
        payload_sha256: createHash("sha256").update(failedPayload).digest("hex"),
        payload_path: join(payloadDir, "blocking-failed.md"),
        inject_path: failedPath,
        next_check_at: "2026-08-27T20:02:00.000Z",
      });
      store.failPendingSessionCommand("blocking-failed", "delivery failed");
      store.openReviewFailure({
        pr: 1,
        command_id: "blocking-failed",
        round_id: null,
        round_no: null,
        head_sha: "head",
        stage: "session_command",
        detail: "delivery failed",
        attempts: 2,
        retry_cap: 2,
      });

      const pendingFile = "2026-08-27T20-00-00-0000--cmd-blocked-current.md";
      const pendingPath = join(dir, pendingFile);
      const pendingPayload = "must not overtake\n";
      writeFileSync(pendingPath, pendingPayload);
      writeFileSync(join(payloadDir, "blocked-current.md"), pendingPayload);
      store.createSessionCommand({
        id: "blocked-current",
        pr: 1,
        session: "pr-1",
        kind: "wake",
        round_no: null,
        payload_sha256: createHash("sha256").update(pendingPayload).digest("hex"),
        payload_path: join(payloadDir, "blocked-current.md"),
        inject_path: pendingPath,
        next_check_at: "2026-08-27T20:02:00.000Z",
      });

      activate(fakePi());
      fire("session_start");

      expect(sends).toHaveLength(0);
      expect(terminal()).toEqual([`${failedFile}.failed`]);
      expect(pending()).toEqual([pendingFile]);
      expect(store.getSessionCommand("blocking-failed")).toMatchObject({
        status: "failed",
        attempt: 0,
      });
      expect(store.getSessionCommand("blocked-current")).toMatchObject({
        status: "pending",
        attempt: 0,
      });
      expect(store.openReviewFailure(1)).toMatchObject({
        command_id: "blocking-failed",
        work_owed: 1,
      });
      expect(readSessionBridgeState(process.env.QCR_SESSION_BRIDGE_STATE_FILE!)).toMatchObject({
        stage: "failed",
        failed_stage: "command_link",
      });
    } finally {
      fire("session_shutdown");
      store.close();
    }
  });

  it.each(["acked", "cancelled"] as const)(
    "removes a stale %s transport without submitting it",
    (status) => {
      const store = commandStore();
      try {
        const file = `2026-08-27T19-00-00-0000--cmd-terminal-${status}.md`;
        const path = join(dir, file);
        const payloadDir = join(dir, "payloads");
        mkdirSync(payloadDir, { recursive: true });
        const payload = `${status} command\n`;
        writeFileSync(path, payload);
        writeFileSync(join(payloadDir, `${status}.md`), payload);
        store.createSessionCommand({
          id: `terminal-${status}`,
          pr: 1,
          session: "pr-1",
          kind: "wake",
          round_no: null,
          payload_sha256: createHash("sha256").update(payload).digest("hex"),
          payload_path: join(payloadDir, `${status}.md`),
          inject_path: path,
          next_check_at: "2026-08-27T20:02:00.000Z",
        });
        if (status === "acked") {
          store.claimSessionCommand(`terminal-${status}`, "bridge-old", "2026-08-27T20:02:00.000Z");
          store.markSessionCommandStarted(
            `terminal-${status}`,
            "bridge-old",
            "2026-08-27T20:45:00.000Z",
          );
          store.finishSessionCommand(`terminal-${status}`, "bridge-old", "acked");
        } else {
          store.db
            .prepare("UPDATE session_commands SET status='cancelled' WHERE id=?")
            .run(`terminal-${status}`);
        }

        activate(fakePi());
        fire("session_start");

        expect(sends).toHaveLength(0);
        expect(pending()).toEqual([]);
        expect(status === "acked" ? done() : terminal()).toEqual([
          status === "acked" ? file : `${file}.${status}`,
        ]);
        expect(store.getSessionCommand(`terminal-${status}`)?.status).toBe(status);
        expect(readSessionBridgeState(process.env.QCR_SESSION_BRIDGE_STATE_FILE!)).toMatchObject({
          stage: "ready",
        });
      } finally {
        fire("session_shutdown");
        store.close();
      }
    },
  );

  it("fails closed permanently if a terminal transport cannot be moved atomically", async () => {
    const store = commandStore();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const file = "2026-08-27T19-00-00-0000--cmd-move-failure.md";
      const path = join(dir, file);
      const payloadDir = join(dir, "payloads");
      mkdirSync(payloadDir, { recursive: true });
      const payload = "acked command\n";
      writeFileSync(path, payload);
      writeFileSync(join(payloadDir, "move-failure.md"), payload);
      store.createSessionCommand({
        id: "move-failure",
        pr: 1,
        session: "pr-1",
        kind: "wake",
        round_no: null,
        payload_sha256: createHash("sha256").update(payload).digest("hex"),
        payload_path: join(payloadDir, "move-failure.md"),
        inject_path: path,
        next_check_at: "2026-08-27T20:02:00.000Z",
      });
      store.claimSessionCommand("move-failure", "bridge-old", "2026-08-27T20:02:00.000Z");
      store.markSessionCommandStarted("move-failure", "bridge-old", "2026-08-27T20:45:00.000Z");
      store.finishSessionCommand("move-failure", "bridge-old", "acked");
      mkdirSync(join(dir, ".done", file), { recursive: true }); // rename(file → directory) must fail

      activate(fakePi());
      fire("session_start");

      expect(sends).toHaveLength(0);
      expect(pending()).toEqual([file]);
      expect(readSessionBridgeState(process.env.QCR_SESSION_BRIDGE_STATE_FILE!)).toMatchObject({
        stage: "failed",
        failed_stage: "terminal_transport",
        detail: expect.stringContaining(file),
      });
      expect(errors).toHaveBeenCalledWith(
        expect.stringContaining(`FAILED_LOUD terminal_transport: ${file}`),
      );

      // A durable failed birth is terminal for this generation. Even if the
      // filesystem obstruction disappears and a new watch event arrives, the
      // old Pi process must not spring back to life behind the daemon's back.
      rmSync(join(dir, ".done", file), { recursive: true, force: true });
      writeFileSync(join(dir, "2026-08-27T20-00-00-0000.md"), "later legacy wake\n");
      await sleep(30);
      expect(sends).toHaveLength(0);
      expect(pending()).toContain(file);
      expect(store.db.prepare("SELECT COUNT(*) AS n FROM session_commands").get()).toEqual({
        n: 1,
      });
    } finally {
      fire("session_shutdown");
      store.close();
    }
  });

  it("fails readiness on blocking failed debt even after its transport residue is gone", () => {
    const store = commandStore();
    try {
      const payloadDir = join(dir, "payloads");
      mkdirSync(payloadDir, { recursive: true });
      const payload = "owed failed command\n";
      const payloadPath = join(payloadDir, "owed-failure.md");
      writeFileSync(payloadPath, payload);
      store.createSessionCommand({
        id: "owed-failure",
        pr: 1,
        session: "pr-1",
        kind: "wake",
        round_no: null,
        payload_sha256: createHash("sha256").update(payload).digest("hex"),
        payload_path: payloadPath,
        inject_path: join(dir, "already-quarantined--cmd-owed-failure.md"),
        next_check_at: "2026-08-27T20:02:00.000Z",
      });
      store.failPendingSessionCommand("owed-failure", "still owed");

      activate(fakePi());
      fire("session_start");

      expect(sends).toHaveLength(0);
      expect(pending()).toEqual([]);
      expect(readSessionBridgeState(process.env.QCR_SESSION_BRIDGE_STATE_FILE!)).toMatchObject({
        stage: "failed",
        failed_stage: "command_link",
        detail: expect.stringContaining("owed-failure"),
      });
    } finally {
      fire("session_shutdown");
      store.close();
    }
  });

  it("does not quarantine a terminal row whose transport bytes fail the durable hash", () => {
    const store = commandStore();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const file = "2026-08-27T19-00-00-0000--cmd-corrupt-failed.md";
      const path = join(dir, file);
      const payloadDir = join(dir, "payloads");
      mkdirSync(payloadDir, { recursive: true });
      const durablePayload = "durable original\n";
      writeFileSync(path, "corrupt transport\n");
      writeFileSync(join(payloadDir, "corrupt.md"), durablePayload);
      store.createSessionCommand({
        id: "corrupt-failed",
        pr: 1,
        session: "pr-1",
        kind: "wake",
        round_no: null,
        payload_sha256: createHash("sha256").update(durablePayload).digest("hex"),
        payload_path: join(payloadDir, "corrupt.md"),
        inject_path: path,
        next_check_at: "2026-08-27T20:02:00.000Z",
      });
      store.failPendingSessionCommand("corrupt-failed", "old failure");

      activate(fakePi());
      fire("session_start");

      expect(pending()).toEqual([file]);
      expect(terminal()).toEqual([]);
      expect(readSessionBridgeState(process.env.QCR_SESSION_BRIDGE_STATE_FILE!)).toMatchObject({
        stage: "failed",
        failed_stage: "command_link",
      });
      expect(errors).toHaveBeenCalledWith(expect.stringContaining("payload hash mismatch"));
    } finally {
      fire("session_shutdown");
      store.close();
    }
  });

  it("keeps a running transport in place and fails readiness rather than duplicating it", () => {
    const store = commandStore();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const file = "2026-08-27T19-00-00-0000--cmd-running.md";
      const path = join(dir, file);
      const payloadDir = join(dir, "payloads");
      mkdirSync(payloadDir, { recursive: true });
      const payload = "possibly accepted command\n";
      writeFileSync(path, payload);
      writeFileSync(join(payloadDir, "running.md"), payload);
      store.createSessionCommand({
        id: "running",
        pr: 1,
        session: "pr-1",
        kind: "wake",
        round_no: null,
        payload_sha256: createHash("sha256").update(payload).digest("hex"),
        payload_path: join(payloadDir, "running.md"),
        inject_path: path,
        next_check_at: "2026-08-27T20:02:00.000Z",
      });
      store.claimSessionCommand("running", "bridge-old", "2026-08-27T20:02:00.000Z");

      activate(fakePi());
      fire("session_start");

      expect(sends).toHaveLength(0);
      expect(pending()).toEqual([file]);
      expect(terminal()).toEqual([]);
      expect(readSessionBridgeState(process.env.QCR_SESSION_BRIDGE_STATE_FILE!)).toMatchObject({
        stage: "failed",
        failed_stage: "command_link",
      });
      expect(errors).toHaveBeenCalledWith(expect.stringContaining("already running"));
    } finally {
      fire("session_shutdown");
      store.close();
    }
  });

  it("fails closed on an unlinked command-shaped transport instead of adopting it", () => {
    const store = commandStore();
    try {
      const file = "2026-08-27T20-00-00-0000--cmd-orphan.md";
      writeFileSync(join(dir, file), "orphan command transport\n");

      activate(fakePi());
      fire("session_start");

      expect(sends).toHaveLength(0);
      expect(pending()).toEqual([file]);
      expect(store.db.prepare("SELECT COUNT(*) AS n FROM session_commands").get()).toEqual({
        n: 0,
      });
      expect(readSessionBridgeState(process.env.QCR_SESSION_BRIDGE_STATE_FILE!)).toMatchObject({
        stage: "failed",
        failed_stage: "command_link",
      });
    } finally {
      fire("session_shutdown");
      store.close();
    }
  });

  it("claims the correlated command as running and acks it only on settlement", async () => {
    const store = commandStore();
    try {
      const file = "2026-08-27T20-00-00-0000--cmd-cmd-a.md";
      const path = join(dir, file);
      const payload = "durable prompt\n";
      writeFileSync(path, payload);
      store.createSessionCommand({
        id: "cmd-a",
        pr: 1,
        session: "pr-1",
        kind: "round",
        round_no: 20,
        payload_sha256: createHash("sha256").update(payload).digest("hex"),
        payload_path: join(dir, "payload-cmd-a.md"),
        inject_path: path,
        next_check_at: "2026-08-27T20:02:00.000Z",
      });
      writeFileSync(join(dir, "payload-cmd-a.md"), payload);

      activate(fakePi());
      fire("session_start");
      await vi.waitFor(() => expect(sends).toHaveLength(1));
      expect(store.getSessionCommand("cmd-a")).toMatchObject({
        status: "running",
        attempt: 1,
        started_at: null,
      });
      expect(readSessionBridgeState(process.env.QCR_SESSION_BRIDGE_STATE_FILE!)).toMatchObject({
        generation: "generation-1",
        stage: "ready",
      });

      acknowledgeLatest();
      await vi.waitFor(() => expect(store.getSessionCommand("cmd-a")?.started_at).not.toBeNull());
      expect(store.getSessionCommand("cmd-a")?.status).toBe("running");
      fire("agent_settled");
      await vi.waitFor(() => expect(store.getSessionCommand("cmd-a")?.status).toBe("acked"));
    } finally {
      fire("session_shutdown");
      store.close();
    }
  });

  it("expires an unaccepted reservation loudly without terminalizing a possibly queued followUp", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const store = commandStore();
    try {
      const file = "2026-08-27T20-00-00-5000--cmd-cmd-timeout.md";
      const path = join(dir, file);
      const payload = "never accepted\n";
      writeFileSync(path, payload);
      writeFileSync(join(dir, "payload-timeout.md"), payload);
      store.createSessionCommand({
        id: "cmd-timeout",
        pr: 1,
        session: "pr-1",
        kind: "wake",
        round_no: null,
        payload_sha256: createHash("sha256").update(payload).digest("hex"),
        payload_path: join(dir, "payload-timeout.md"),
        inject_path: path,
        next_check_at: "2026-08-27T20:02:00.000Z",
      });

      activate(fakePi());
      fire("session_start");
      await vi.advanceTimersByTimeAsync(0);
      expect(store.getSessionCommand("cmd-timeout")).toMatchObject({
        status: "running",
        started_at: null,
        attempt: 1,
      });
      await vi.advanceTimersByTimeAsync(START_ACK_TIMEOUT_MS);
      expect(store.getSessionCommand("cmd-timeout")).toMatchObject({
        status: "running",
        started_at: null,
      });
      expect(pending()).toContain(file);
      expect(sends).toHaveLength(1);
    } finally {
      fire("session_shutdown");
      store.close();
    }
  });

  it("a stale bridge owner cannot ack an attempt recovered by a newer owner", async () => {
    const store = commandStore();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const file = "2026-08-27T20-00-01-0000--cmd-cmd-b.md";
      const path = join(dir, file);
      const payload = "durable prompt\n";
      writeFileSync(path, payload);
      writeFileSync(join(dir, "payload-cmd-b.md"), payload);
      store.createSessionCommand({
        id: "cmd-b",
        pr: 1,
        session: "pr-1",
        kind: "wake",
        round_no: null,
        payload_sha256: createHash("sha256").update(payload).digest("hex"),
        payload_path: join(dir, "payload-cmd-b.md"),
        inject_path: path,
        next_check_at: "2026-08-27T20:02:00.000Z",
      });

      activate(fakePi());
      fire("session_start");
      await vi.waitFor(() => expect(sends).toHaveLength(1));
      acknowledgeLatest();
      await vi.waitFor(() => expect(store.getSessionCommand("cmd-b")?.status).toBe("running"));
      store.db
        .prepare(
          "UPDATE session_commands SET owner_token='recovered-owner', attempt=attempt+1 WHERE id='cmd-b'",
        )
        .run();

      fire("agent_settled");
      await sleep(20);
      expect(store.getSessionCommand("cmd-b")).toMatchObject({
        status: "running",
        owner_token: "recovered-owner",
        attempt: 2,
      });
      expect(errors).toHaveBeenCalledWith(expect.stringContaining("stale owner"));
    } finally {
      fire("session_shutdown");
      store.close();
    }
  });

  it("adopts an existing untracked inject file as pending without inventing acknowledgement", async () => {
    const store = commandStore();
    try {
      writeFileSync(join(dir, "2026-08-27T20-00-02-0000.md"), "legacy prompt\n");
      activate(fakePi());
      fire("session_start");
      await vi.waitFor(() => expect(sends).toHaveLength(1));

      const adopted = store.db.prepare("SELECT * FROM session_commands").get() as {
        id: string;
        status: string;
        kind: string;
        started_at: string | null;
      };
      expect(adopted).toMatchObject({ status: "running", kind: "legacy", started_at: null });
      acknowledgeLatest();
      await vi.waitFor(() =>
        expect(store.getSessionCommand(adopted.id)?.started_at).not.toBeNull(),
      );
      fire("agent_settled");
      await vi.waitFor(() => expect(store.getSessionCommand(adopted.id)?.status).toBe("acked"));
    } finally {
      fire("session_shutdown");
      store.close();
    }
  });
});

describe("inject-bridge — the busy span is the agent RUN, not one turn (#5362)", () => {
  it("turn_end does NOT clear busy — a wake landing between tool calls stays held", async () => {
    // THE #5362 REGRESSION. pi fires turn_start/turn_end once per assistant
    // turn INSIDE a run (turnIndex++ per turn, reset at agent_start), so
    // clearing `busy` on turn_end declared the session idle in the gap between
    // every tool call while the run was still streaming. #5362's round-2 order
    // landed in one of those gaps, 6.5s before the session finished, and pi
    // threw it away ("Agent is already processing") without the bridge ever
    // learning. Only agent_settled may clear the flag.
    activate(fakePi());
    fire("session_start");
    fire("agent_start"); // the run begins
    fire("turn_start");
    fire("turn_end"); // one tool-call turn ended — the RUN has not

    writeFileSync(join(dir, "2026-08-21T14-20-59-0031.md"), "ROUND 2 prompt");
    await sleep(150);
    expect(sends).toHaveLength(0); // held, not fired into the streaming run
    expect(pending()).toHaveLength(1);
    expect(done()).toHaveLength(0);

    fire("agent_settled"); // NOW the run is fully settled
    await vi.waitFor(() => expect(sends).toHaveLength(1));
    expect(done()).toHaveLength(0);
    acknowledgeLatest();
    await vi.waitFor(() => expect(done()).toHaveLength(1));
    expect(sentBody(0)).toBe("ROUND 2 prompt");
  });

  it("agent_start alone arms the hold — a run with no inner turn still defers", async () => {
    activate(fakePi());
    fire("session_start");
    fire("agent_start");

    writeFileSync(join(dir, "2026-08-21T14-21-00-0000.md"), "wake");
    await sleep(150);
    expect(sends).toHaveLength(0);
    expect(pending()).toHaveLength(1);
  });

  it("agent_end is not a settle — pi still runs retries/compaction after it", async () => {
    // agent_settled is documented as "after an agent run has FULLY SETTLED and
    // no automatic retry, compaction, or queued continuation will run". Taking
    // agent_end as the clear would re-open a narrower version of the same
    // window, so it must not be wired as one.
    activate(fakePi());
    fire("session_start");
    fire("agent_start");
    fire("agent_end");

    writeFileSync(join(dir, "2026-08-21T14-21-01-0000.md"), "wake");
    await sleep(150);
    expect(sends).toHaveLength(0);
    expect(pending()).toHaveLength(1);
  });
});

describe("inject-bridge — a delivery is QUEUED, never refused (#5362)", () => {
  it("every send passes deliverAs:followUp so a streaming agent queues it instead of throwing", async () => {
    // The bridge cannot detect a refusal: pi's extension-facing
    // sendUserMessage is declared `: void` and its runtime binding swallows
    // every rejection into an error banner. Start acknowledgement is the
    // correctness boundary; followUp remains a belt that asks Pi to queue if
    // our observed run state was stale.
    writeFileSync(join(dir, "2026-08-21T15-00-00-0000.md"), "round prompt");
    activate(fakePi());
    fire("session_start");

    await vi.waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]!.options?.deliverAs).toBe("followUp");
  });
});

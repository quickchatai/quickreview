// The inject bridge and pi's compaction.
//
// pi 1.0.0 refuses a prompt during compaction ("Cannot submit a prompt while
// compaction is in progress") and the extension-facing send swallows the
// refusal; manual compaction emits no `agent_settled`. A wake flushed while pi
// compacts after a verdict would therefore be lost, nothing would drain again,
// the start lease would run out, and the supervisor would kill a healthy, idle
// session.
//
// Pinned here, against a fake pi that refuses exactly as 1.0.0 does
// (tests/helpers/fake-pi-session.ts):
//   - a compaction holds the mailbox — nothing is submitted (or reserved)
//     while it runs, and the queue drains when it ends;
//   - the daemon's round-end compaction REQUEST runs through ctx.compact()
//     only while nothing is in flight, and before the wakes queued behind it;
//   - the bridge publishes the compaction in its ready receipt;
//   - a command the daemon hands back for redelivery is resubmitted
//     only when pi provably holds nothing of it.
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import activate, { IDLE_RECHECK_MS } from "../extensions/inject-bridge.js";
import {
  bridgeCompaction,
  COMPACTION_REQUEST_FILE,
  readSessionBridgeState,
} from "../src/session-bridge.js";
import { StateStore } from "../src/state.js";
import { FakePiSession } from "./helpers/fake-pi-session.js";

const ENV_KEYS = [
  "QCR_INJECT_DIR",
  "QCR_SESSION_NAME",
  "QCR_STATE_DB",
  "QCR_SANDBOX_ROOT",
  "QCR_SESSION_BRIDGE_GENERATION",
  "QCR_SESSION_BRIDGE_STATE_FILE",
  "QCR_SESSION_BRIDGE_LEDGER_REQUIRED",
  "QCR_SESSION_COMMAND_START_LEASE_MS",
] as const;

let dir: string;
let saved: Record<string, string | undefined>;
let session: FakePiSession;

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const pending = (): string[] => readdirSync(dir).filter((f) => f.endsWith(".md"));
const done = (): string[] => {
  const d = join(dir, ".done");
  return existsSync(d) ? readdirSync(d) : [];
};
const stateFile = (): string => process.env.QCR_SESSION_BRIDGE_STATE_FILE!;
const compactionReport = () => bridgeCompaction(readSessionBridgeState(stateFile()));

/** Atomic write the way the daemon writes (tmp + rename). */
function writeAtomic(path: string, body: string): void {
  writeFileSync(`${path}.tmp`, body);
  renameSync(`${path}.tmp`, path);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-bridge-compaction-"));
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.QCR_INJECT_DIR = dir;
  process.env.QCR_SESSION_NAME = "pr-1";
  process.env.QCR_SESSION_BRIDGE_GENERATION = "generation-1";
  process.env.QCR_SESSION_BRIDGE_STATE_FILE = join(dir, "bridge-state.json");
  process.env.QCR_SESSION_BRIDGE_LEDGER_REQUIRED = "0";
  delete process.env.QCR_STATE_DB;
  delete process.env.QCR_SANDBOX_ROOT;
});

afterEach(() => {
  session?.fire("session_shutdown");
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(dir, { recursive: true, force: true });
});

function start(opts: { withContext?: boolean } = {}): FakePiSession {
  session = new FakePiSession(opts);
  activate(session.pi());
  session.fire("session_start");
  return session;
}

describe("a compaction holds the mailbox (H1b)", () => {
  it("a wake written while pi compacts is submitted only after it ends — nothing refused, nothing lost", async () => {
    const s = start();
    s.startCompaction(); // a manual compaction, `/compact` typed into the pane
    writeAtomic(join(dir, "2026-10-08T08-52-10-0000.md"), "author reply wake");
    await sleep(150);
    // Held, not sent: a send now would be refused by pi and never retried.
    expect(s.sends).toEqual([]);
    expect(s.refused).toEqual([]);
    expect(pending()).toHaveLength(1);

    s.finishCompaction();
    await vi.waitFor(() => expect(s.accepted).toHaveLength(1));
    expect(s.sends).toHaveLength(1);
    expect(s.refused).toEqual([]);
    expect(s.accepted[0]).toContain("author reply wake");
    await vi.waitFor(() => expect(done()).toContain("2026-10-08T08-52-10-0000.md"));
  });

  it("a failed compaction releases the mailbox the same way", async () => {
    const s = start();
    s.startCompaction();
    writeAtomic(join(dir, "2026-10-08T08-52-11-0000.md"), "wake");
    await sleep(100);
    expect(s.sends).toEqual([]);
    s.finishCompaction(false);
    await vi.waitFor(() => expect(s.accepted).toHaveLength(1));
    expect(s.refused).toEqual([]);
    expect(compactionReport()).toMatchObject({ state: "idle", seq: 1, outcome: "failed" });
  });

  it("without a pi context (an older pi), the bridge's own compaction events hold the mailbox", async () => {
    const s = start({ withContext: false });
    s.startCompaction();
    writeAtomic(join(dir, "2026-10-08T08-52-12-0000.md"), "wake");
    await sleep(100);
    expect(s.sends).toEqual([]);
    s.finishCompaction();
    await vi.waitFor(() => expect(s.accepted).toHaveLength(1));
    expect(s.refused).toEqual([]);
  });

  it("publishes the compaction in its ready receipt: running, then idle with the next seq", async () => {
    const s = start();
    expect(compactionReport()).toEqual({ state: "idle", seq: 0 });
    s.startCompaction();
    expect(compactionReport()).toMatchObject({ state: "running", seq: 0, source: "event" });
    expect(readSessionBridgeState(stateFile())?.stage).toBe("ready");
    s.finishCompaction();
    const ended = compactionReport()!;
    expect(ended).toMatchObject({ state: "idle", seq: 1, outcome: "compacted" });
    expect(Date.parse(ended.ended_at!)).toBeGreaterThanOrEqual(Date.parse(ended.started_at!));
  });

  it("pi busy with something the bridge saw no event for: rechecks on a timer and delivers once idle", async () => {
    const s = start();
    s.compacting = true; // set inside pi without any event reaching the bridge
    writeAtomic(join(dir, "2026-10-08T08-52-13-0000.md"), "wake");
    await sleep(150);
    expect(s.sends).toEqual([]);
    s.compacting = false; // still no event: only the recheck can notice
    await vi.waitFor(() => expect(s.accepted).toHaveLength(1), { timeout: IDLE_RECHECK_MS * 3 });
    expect(s.refused).toEqual([]);
  });

  it("a compaction whose end event was missed is closed as stale once pi reads idle", async () => {
    const s = start();
    s.startCompaction();
    s.compacting = false; // pi finished, but session_compact never reached the bridge
    writeAtomic(join(dir, "2026-10-08T08-52-14-0000.md"), "wake");
    await vi.waitFor(() => expect(s.accepted).toHaveLength(1));
    expect(compactionReport()).toMatchObject({ state: "idle", seq: 1, outcome: "stale" });
  });
});

describe("the daemon's round-end compaction request (H1b)", () => {
  it("runs through ctx.compact once the active run settles, before the wakes queued behind it", async () => {
    const s = start();
    writeAtomic(join(dir, "2026-10-08T08-51-00-0000.md"), "round tail");
    await vi.waitFor(() => expect(s.accepted).toHaveLength(1));
    // The verdict lands mid-tail: the daemon requests compaction and flushes.
    writeAtomic(join(dir, COMPACTION_REQUEST_FILE), JSON.stringify({ version: 1 }));
    writeAtomic(join(dir, "2026-10-08T08-52-10-0000.md"), "held author replies");
    await sleep(150);
    expect(s.compactCalls).toBe(0); // never a compaction that aborts a running turn
    expect(s.sends).toHaveLength(1);

    s.settle();
    await vi.waitFor(() => expect(s.compactCalls).toBe(1));
    expect(s.sends).toHaveLength(1); // the wake waits for the compaction
    expect(existsSync(join(dir, COMPACTION_REQUEST_FILE))).toBe(false); // consumed once
    expect(compactionReport()).toMatchObject({ state: "running", source: "request" });

    s.finishCompaction();
    await vi.waitFor(() => expect(s.accepted).toHaveLength(2));
    expect(s.accepted[1]).toContain("held author replies");
    expect(s.refused).toEqual([]);
    expect(compactionReport()).toMatchObject({ state: "idle", seq: 1, outcome: "compacted" });
  });

  it("an idle session compacts at once and holds a wake written meanwhile", async () => {
    const s = start();
    writeAtomic(join(dir, COMPACTION_REQUEST_FILE), JSON.stringify({ version: 1 }));
    await vi.waitFor(() => expect(s.compactCalls).toBe(1));
    writeAtomic(join(dir, "2026-10-08T08-52-15-0000.md"), "wake");
    await sleep(100);
    expect(s.sends).toEqual([]);
    s.finishCompaction();
    await vi.waitFor(() => expect(s.accepted).toHaveLength(1));
    expect(s.refused).toEqual([]);
  });

  it("a request left from before this pi started is discarded: a recovered command is reserved at once", async () => {
    // A recovery writes its command before birth; the startup drain must
    // reserve it synchronously (sessions.retrySessionCommand checks the
    // attempt the moment the bridge reports ready) — never compact first.
    writeAtomic(join(dir, COMPACTION_REQUEST_FILE), JSON.stringify({ version: 1 }));
    writeAtomic(join(dir, "2026-10-08T08-54-17-0000.md"), "replayed wake");
    const s = start();
    expect(s.sends).toHaveLength(1); // synchronous, inside session_start
    expect(s.compactCalls).toBe(0);
    expect(existsSync(join(dir, COMPACTION_REQUEST_FILE))).toBe(false);
    expect(done().some((f) => f.endsWith(`-stale${COMPACTION_REQUEST_FILE}`))).toBe(true);
  });

  it("a pi without ctx.compact skips the request and keeps delivering", async () => {
    const s = start({ withContext: false });
    writeAtomic(join(dir, COMPACTION_REQUEST_FILE), JSON.stringify({ version: 1 }));
    writeAtomic(join(dir, "2026-10-08T08-52-16-0000.md"), "wake");
    vi.spyOn(console, "error").mockImplementation(() => {});
    await vi.waitFor(() => expect(s.accepted).toHaveLength(1));
    expect(s.compactCalls).toBe(0);
    expect(existsSync(join(dir, COMPACTION_REQUEST_FILE))).toBe(false);
  });
});

describe("redelivery into the same live session (#5362 ③, H1b)", () => {
  const LEASE_MS = 60;

  function commandStore(): StateStore {
    const dbPath = join(dir, "state.db");
    process.env.QCR_SESSION_BRIDGE_LEDGER_REQUIRED = "1";
    process.env.QCR_STATE_DB = dbPath;
    process.env.QCR_SANDBOX_ROOT = dir;
    // A short start lease: the bridge resubmits nothing younger than the
    // lease it reserved under (a belt over the daemon's own due check).
    process.env.QCR_SESSION_COMMAND_START_LEASE_MS = String(LEASE_MS);
    return new StateStore(dbPath, () => new Date("2026-10-08T08:52:10.000Z"));
  }

  function seedWake(store: StateStore, id: string, payload: string): string {
    const file = `2026-10-08T08-52-10-0000--cmd-${id}.md`;
    const path = join(dir, file);
    writeFileSync(join(dir, `payload-${id}.md`), payload);
    store.createSessionCommand({
      id,
      pr: 1,
      session: "pr-1",
      kind: "wake",
      round_no: null,
      payload_sha256: createHash("sha256").update(payload).digest("hex"),
      payload_path: join(dir, `payload-${id}.md`),
      inject_path: path,
      next_check_at: "2026-10-08T08:54:10.000Z",
    });
    writeAtomic(path, payload);
    return path;
  }

  /** What `PiSessionManager.redeliverSessionCommand` does to the row and file. */
  function daemonRedelivers(store: StateStore, id: string, path: string, payload: string): void {
    const row = store.getSessionCommand(id)!;
    expect(
      store.requeueSessionCommandForRedelivery(
        id,
        { attempt: row.attempt, redeliveries: row.redeliveries, next_check_at: row.next_check_at },
        "2026-10-08T08:56:20.000Z",
      ),
    ).toBe(true);
    writeAtomic(path, payload);
  }

  it("a command pi never started is resubmitted, same bytes and marker, when pi holds nothing", async () => {
    const store = commandStore();
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const s = start();
      s.refuseNext = 1; // the first submission is lost inside pi
      const payload = "# Author reply — PR #1\n\nreply\n";
      const path = seedWake(store, "cmd-r", payload);
      await vi.waitFor(() => expect(s.sends).toHaveLength(1));
      expect(store.getSessionCommand("cmd-r")).toMatchObject({ status: "running", attempt: 1 });

      daemonRedelivers(store, "cmd-r", path, payload);
      await vi.waitFor(() => expect(s.accepted).toHaveLength(1));
      expect(s.sends).toHaveLength(2);
      expect(s.sends[1]).toBe(s.sends[0]); // the exact bytes, the same marker
      expect(store.getSessionCommand("cmd-r")).toMatchObject({
        status: "running",
        attempt: 2,
        redeliveries: 1,
        started_at: expect.any(String),
      });
      s.settle();
      await vi.waitFor(() => expect(store.getSessionCommand("cmd-r")?.status).toBe("acked"));
    } finally {
      session.fire("session_shutdown");
      store.close();
    }
  });

  it("is never resubmitted while pi holds a queued prompt — it may be this one", async () => {
    const store = commandStore();
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const s = start();
      s.refuseNext = 1;
      const payload = "wake\n";
      const path = seedWake(store, "cmd-q", payload);
      await vi.waitFor(() => expect(s.sends).toHaveLength(1));
      s.followUps.push("something pi queued"); // hasPendingMessages() === true
      daemonRedelivers(store, "cmd-q", path, payload);
      await sleep(150);
      expect(s.sends).toHaveLength(1);
      expect(store.getSessionCommand("cmd-q")).toMatchObject({ status: "pending" });

      // The queue drains; pi is idle with nothing held: now it goes.
      s.followUps = [];
      writeAtomic(path, payload);
      await vi.waitFor(() => expect(s.accepted).toHaveLength(1));
      expect(s.sends).toHaveLength(2);
    } finally {
      session.fire("session_shutdown");
      store.close();
    }
  });

  it("is never resubmitted without pi's own answer (an older pi): unknown is never loss", async () => {
    const store = commandStore();
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const s = start({ withContext: false });
      s.refuseNext = 1;
      const payload = "wake\n";
      const path = seedWake(store, "cmd-u", payload);
      await vi.waitFor(() => expect(s.sends).toHaveLength(1));
      daemonRedelivers(store, "cmd-u", path, payload);
      await sleep(150);
      expect(s.sends).toHaveLength(1);
    } finally {
      session.fire("session_shutdown");
      store.close();
    }
  });

  it("an original submission that starts after the daemon handed it back is taken back and accepted", async () => {
    const store = commandStore();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const s = start();
      s.holdNextInPreflight = true; // pi took it, its run has not started yet
      const payload = "slow wake\n";
      const path = seedWake(store, "cmd-s", payload);
      await vi.waitFor(() => expect(s.sends).toHaveLength(1));
      const row = store.getSessionCommand("cmd-s")!;
      store.requeueSessionCommandForRedelivery(
        "cmd-s",
        { attempt: row.attempt, redeliveries: row.redeliveries, next_check_at: row.next_check_at },
        "2026-10-08T08:56:20.000Z",
      );
      s.startHeld(); // …and now it starts, before the rewrite lands
      expect(store.getSessionCommand("cmd-s")).toMatchObject({
        status: "running",
        started_at: expect.any(String),
      });
      expect(errors).not.toHaveBeenCalledWith(expect.stringContaining("stale owner"));
      writeAtomic(path, payload); // the daemon's rewrite, arriving late
      await sleep(100);
      expect(s.sends).toHaveLength(1); // never a second submission of a started command
      s.settle();
      await vi.waitFor(() => expect(store.getSessionCommand("cmd-s")?.status).toBe("acked"));
      // The late copy is transport residue of an acked command — quarantined
      // as delivered, never failing the lane.
      await vi.waitFor(() => expect(pending()).toHaveLength(0));
      expect(readSessionBridgeState(stateFile())?.stage).toBe("ready");
    } finally {
      session.fire("session_shutdown");
      store.close();
    }
  });
  // pi reads idle through its whole prompt preflight, so
  // idleness alone cannot say a submission is gone. Its `input` event can:
  // pi emits it right after the compaction refusal.
  it("a submission pi took past its input stage is never resubmitted, even if it never starts", async () => {
    const store = commandStore();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const s = start();
      s.failAfterInputNext = 1; // pi took it, then lost it past the input stage
      const payload = "wake\n";
      const path = seedWake(store, "cmd-i", payload);
      await vi.waitFor(() => expect(s.sends).toHaveLength(1));
      await sleep(LEASE_MS + 20); // older than its lease, pi idle, nothing queued
      expect(s.ctx.isIdle()).toBe(true);
      expect(s.ctx.hasPendingMessages()).toBe(false);

      daemonRedelivers(store, "cmd-i", path, payload);
      await sleep(LEASE_MS * 3);
      expect(s.sends).toHaveLength(1); // unknown is never loss
      expect(store.getSessionCommand("cmd-i")).toMatchObject({ status: "pending", attempt: 1 });
      expect(errors).toHaveBeenCalledWith(expect.stringContaining("past its input stage"));
    } finally {
      session.fire("session_shutdown");
      store.close();
    }
  });

  it("a redelivery that reaches a submission younger than its lease waits out the lease first", async () => {
    const store = commandStore();
    const lease = 400;
    process.env.QCR_SESSION_COMMAND_START_LEASE_MS = String(lease);
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const s = start();
      s.refuseNext = 1; // refused before pi's input stage: pi never took it
      const payload = "young wake\n";
      const notBefore = Date.now(); // the bridge submits after this instant
      const path = seedWake(store, "cmd-y", payload);
      await vi.waitFor(() => expect(s.sends).toHaveLength(1));

      daemonRedelivers(store, "cmd-y", path, payload);
      await sleep(100);
      expect(s.sends).toHaveLength(1); // still younger than its lease
      await vi.waitFor(() => expect(s.accepted).toHaveLength(1), { timeout: lease * 5 });
      expect(Date.now() - notBefore).toBeGreaterThanOrEqual(lease - 5);
      expect(s.sends[1]).toBe(s.sends[0]);
    } finally {
      session.fire("session_shutdown");
      store.close();
    }
  });
});

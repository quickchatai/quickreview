// H1b, end to end: the daemon's session manager and command
// supervisor, the REAL inject bridge, one SQLite file between them, and a fake
// pi that refuses a prompt during compaction exactly as pi 1.0.0 does
// (tests/helpers/fake-pi-session.ts). tmux is a recording fake: a kill or a
// respawn of the live session would show up in its calls.
//
// The incident (#5849, 2026-10-08 08:51–08:54Z): round 5's verdict landed, the
// daemon typed `/compact` and flushed a held wake 18 s later; pi refused the
// wake mid-compaction, nothing retried it, the 120 s start lease ran out and
// recovery killed the live session and started a new conversation.
//
// Acceptance pinned here:
//   1. a wake flushed while the bridge reports compacting starts after the
//      compaction ends — no kill, no respawn;
//   2. a live, bridge-ready session whose wake did not start within the lease
//      gets a REDELIVERY of the same bytes — no kill.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import activateInjectBridge from "../extensions/inject-bridge.js";
import { parseConfig, type Config } from "../src/config.js";
import { SessionCommandSupervisor } from "../src/session-command-supervisor.js";
import { writeSessionBridgeState } from "../src/session-bridge.js";
import { PiSessionManager } from "../src/sessions.js";
import { StateStore } from "../src/state.js";
import { Tmux, type ExecFn } from "../src/tmux.js";
import { WorktreeManager } from "../src/worktrees.js";
import { FakePiSession } from "./helpers/fake-pi-session.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const PR = 5849;
const SESSION = `pr-${PR}`;
const GENERATION = "gen-0804";

const baseCfg: Config = parseConfig(
  readFileSync(resolve(process.cwd(), "tests/fixtures/config.toml"), "utf8"),
);

let root: string;
let tmuxCalls: string[][];
let live: Set<string>;
let store: StateStore;
let session: FakePiSession | undefined;

const fakeExec: ExecFn = async (cmd, args) => {
  if (cmd !== "tmux") return { code: 0, stdout: "", stderr: "" };
  tmuxCalls.push(args);
  if (args[0] === "has-session")
    return { code: live.has(String(args[2]).replace(/^=/, "")) ? 0 : 1, stdout: "", stderr: "" };
  if (args[0] === "list-sessions") return { code: 0, stdout: [...live].join("\n"), stderr: "" };
  if (args[0] === "kill-session") live.delete(String(args[2]).replace(/^=/, ""));
  if (args[0] === "new-session") live.add(String(args[3]));
  return { code: 0, stdout: "", stderr: "" };
};

function config(): Config {
  return {
    ...baseCfg,
    github: { ...baseCfg.github, secrets_dir: join(root, "secrets") },
    pi: { ...baseCfg.pi, session_dir: "state/pi-sessions" },
  };
}

function manager(cfg: Config): PiSessionManager {
  return new PiSessionManager({
    cfg,
    root,
    tmux: new Tmux({ exec: fakeExec }),
    worktrees: new WorktreeManager({
      root,
      repo: "o/n",
      cloneDir: "example-app",
      cloneUrl: "/dev/null",
      run: fakeExec,
    }),
    piHome: join(root, "pihome"),
    ovSessions: { create: async () => true, remove: async () => true },
    commandStore: store,
  });
}

/** The live sticky session as the daemon left it at 08:04 — tmux up, its
 * birth record naming the bridge generation — and that generation's REAL
 * bridge running inside a fake pi. */
function liveSessionWithBridge(
  m: PiSessionManager,
  opts: { startLeaseMs?: number } = {},
): FakePiSession {
  live.add(SESSION);
  mkdirSync(join(root, "state", "sessions"), { recursive: true });
  writeFileSync(
    join(root, "state", "sessions", `${SESSION}.json`),
    `${JSON.stringify({ session: SESSION, born_at: new Date().toISOString(), bridge_generation: GENERATION })}\n`,
  );
  const stateFile = m.bridgeStatePath(SESSION, GENERATION);
  writeSessionBridgeState(stateFile, {
    version: 1,
    session: SESSION,
    generation: GENERATION,
    stage: "starting",
    updated_at: new Date().toISOString(),
  });
  const env: Record<string, string> = {
    QCR_INJECT_DIR: m.injectDir(SESSION),
    QCR_SESSION_NAME: SESSION,
    QCR_STATE_DB: join(root, "state", "state.db"),
    QCR_SANDBOX_ROOT: root,
    QCR_SESSION_BRIDGE_GENERATION: GENERATION,
    QCR_SESSION_BRIDGE_STATE_FILE: stateFile,
    QCR_SESSION_BRIDGE_LEDGER_REQUIRED: "1",
    // The pi env carries the daemon's start lease (sessions.ts); a short one
    // lets the bridge's own lease belt pass inside a test.
    ...(opts.startLeaseMs ? { QCR_SESSION_COMMAND_START_LEASE_MS: String(opts.startLeaseMs) } : {}),
  };
  const prior = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  const s = new FakePiSession();
  try {
    activateInjectBridge(s.pi());
    s.fire("session_start");
  } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  session = s;
  return s;
}

function supervisorAt(m: PiSessionManager, cfg: Config, at: () => Date): SessionCommandSupervisor {
  return new SessionCommandSupervisor({
    cfg,
    store,
    hooks: m,
    verdictDir: join(root, "verdict"),
    onRoundFailure: async () => "requeued",
    now: at,
  });
}

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const killsOrBirths = (): string[][] =>
  tmuxCalls.filter((a) => a[0] === "kill-session" || a[0] === "new-session");
const events = (kind: string) =>
  store
    .recentEvents(500)
    .filter((e) => e.kind === kind)
    .map((e) => JSON.parse(e.payload ?? "{}"));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "qcr-compaction-e2e-"));
  mkdirSync(join(root, "secrets"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(root, "secrets", "openai_api_key"), "sk-test\n");
  tmuxCalls = [];
  live = new Set();
  session = undefined;
  store = new StateStore(join(root, "state", "state.db"));
  store.upsertPr({
    number: PR,
    state: "tracked",
    head_sha: "2222222222222222222222222222222222222222",
    title: "Message queue",
    author: "pr-author",
    trigger_ts: null,
    stale_recheck: 0,
    migration_gate: 0,
  });
});

afterEach(() => {
  session?.fire("session_shutdown");
  store.close();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe("a wake behind the post-verdict compaction (H1b, #5849 08:52Z)", () => {
  it(
    "starts once the compaction ends — the supervisor holds its lease, nothing is killed or respawned",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(console, "log").mockImplementation(() => {});
      const cfg = config();
      const m = manager(cfg);
      const s = liveSessionWithBridge(m);
      const retry = vi.spyOn(m, "retrySessionCommand");
      const kill = vi.spyOn(m, "killSession");

      // 08:51:52 — the verdict applied, the daemon asks for the compaction…
      await m.compactSession(PR);
      await vi.waitFor(() => expect(s.compactCalls).toBe(1));
      // …as a request the bridge runs, never `/compact` typed into the pane.
      expect(tmuxCalls.some((a) => a[0] === "send-keys")).toBe(false);
      expect(await m.sessionCompaction(PR)).toMatchObject({ state: "running", seq: 0 });

      // 08:52:10 — …and flushes the held wake into the compacting session.
      await m.inject(PR, "# Author reply — PR #5849\n\nthe held reply\n");
      const command = store.activeSessionCommand(SESSION)!;
      await sleep(150);
      expect(s.sends).toEqual([]); // never submitted into the compaction
      expect(store.getSessionCommand(command.id)).toMatchObject({ status: "pending", attempt: 0 });

      // 08:54:10 — the start lease runs out with the compaction still running.
      const leaseOut = Date.parse(command.next_check_at) + 1_000;
      await supervisorAt(m, cfg, () => new Date(leaseOut)).scan();
      expect(retry).not.toHaveBeenCalled();
      expect(kill).not.toHaveBeenCalled();
      expect(events("session_command_start_deferred")).toMatchObject([
        { command_id: command.id, reason: "compacting", compaction_source: "request" },
      ]);

      // 08:53:05 — the compaction ends; the wake goes in, and starts.
      s.finishCompaction();
      await vi.waitFor(() =>
        expect(store.getSessionCommand(command.id)?.started_at).not.toBeNull(),
      );
      expect(s.refused).toEqual([]);
      expect(s.accepted).toHaveLength(1);
      expect(s.accepted[0]).toContain("the held reply");
      s.settle();
      await vi.waitFor(() => expect(store.getSessionCommand(command.id)?.status).toBe("acked"));

      // The same conversation throughout: no kill, no rebirth, one JSONL.
      expect(killsOrBirths()).toEqual([]);
      expect(retry).not.toHaveBeenCalled();
      expect(await m.sessionCompaction(PR)).toMatchObject({
        state: "idle",
        seq: 1,
        outcome: "compacted",
      });
    },
  );
});

describe("a pi that died mid-compaction (H1b review)", () => {
  it("reads no compaction once tmux is gone, though its last receipt still says running", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const m = manager(config());
    const s = liveSessionWithBridge(m);
    await m.compactSession(PR);
    await vi.waitFor(() => expect(s.compactCalls).toBe(1));
    expect(await m.sessionCompaction(PR)).toMatchObject({ state: "running" });

    // Killed or OOM'd: no session_shutdown, so the receipt is not rewritten.
    live.delete(SESSION);
    expect(await m.sessionCompaction(PR)).toBeNull();
  });
});

describe("a live, bridge-ready session whose wake did not start (#5362 ③, H1b)", () => {
  it("a bridge reservation made after the supervisor's due read is never handed back: raced, sent once", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const m = manager(config());
    const s = liveSessionWithBridge(m);
    s.startRun("the session's previous turn"); // busy: the bridge holds the wake
    await m.inject(PR, "# Author reply — PR #5849\n\nanswer me\n");
    const command = store.activeSessionCommand(SESSION)!;
    await sleep(50);
    expect(s.sends).toEqual([]);
    // The supervisor finds the pending row due…
    const due = store.getSessionCommand(command.id)!;
    expect(due).toMatchObject({ status: "pending", attempt: 0 });

    // …and while it reads its evidence the run settles: the bridge reserves
    // the wake and submits it, and pi takes it into its preflight.
    s.holdNextInPreflight = true;
    s.settle();
    await vi.waitFor(() => expect(s.sends).toHaveLength(1));
    expect(store.getSessionCommand(command.id)).toMatchObject({ status: "running", attempt: 1 });

    expect(
      await m.redeliverSessionCommand(command.id, {
        attempt: due.attempt,
        redeliveries: due.redeliveries,
        next_check_at: due.next_check_at,
      }),
    ).toBe("raced");
    expect(store.getSessionCommand(command.id)).toMatchObject({
      status: "running",
      attempt: 1,
      redeliveries: 0,
    });
    s.startHeld();
    await vi.waitFor(() => expect(store.getSessionCommand(command.id)?.started_at).not.toBeNull());
    await sleep(50);
    expect(s.sends).toHaveLength(1); // never sent twice
    expect(killsOrBirths()).toEqual([]);
  });

  it(
    "gets the same bytes REDELIVERED into the same session — no kill",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(console, "log").mockImplementation(() => {});
      const cfg = config();
      const m = manager(cfg);
      const s = liveSessionWithBridge(m, { startLeaseMs: 100 });
      const retry = vi.spyOn(m, "retrySessionCommand");
      s.refuseNext = 1; // pi refuses the first submission before its input stage

      const wake = "# Author reply — PR #5849\n\nanswer me\n";
      await m.inject(PR, wake);
      const command = store.activeSessionCommand(SESSION)!;
      await vi.waitFor(() => expect(s.sends).toHaveLength(1));
      expect(store.getSessionCommand(command.id)).toMatchObject({
        status: "running",
        attempt: 1,
        started_at: null,
      });
      // The session is alive and writing: its transcript is in scope and holds
      // no marker for this command — a definitive "never arrived".
      const sessionDir = m.sessionDir(SESSION);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(join(sessionDir, "2026-10-08T08-04-14-169Z_x.jsonl"), '{"type":"message"}\n');

      const leaseOut = Date.parse(store.getSessionCommand(command.id)!.next_check_at) + 1_000;
      await supervisorAt(m, cfg, () => new Date(leaseOut)).scan();

      expect(retry).not.toHaveBeenCalled();
      await vi.waitFor(() =>
        expect(store.getSessionCommand(command.id)?.started_at).not.toBeNull(),
      );
      expect(s.sends).toHaveLength(2);
      expect(s.sends[1]).toBe(s.sends[0]); // the exact dispatched bytes, same marker
      expect(createHash("sha256").update(readFileSync(command.payload_path)).digest("hex")).toBe(
        command.payload_sha256,
      );
      expect(store.getSessionCommand(command.id)).toMatchObject({
        status: "running",
        attempt: 2,
        redeliveries: 1,
        recovery_attempts: 0,
      });
      expect(events("session_command_redelivered")).toMatchObject([
        { command_id: command.id, redelivery: 1, result: "redelivered" },
      ]);
      expect(killsOrBirths()).toEqual([]);
    },
  );

  it("is never redelivered into a dead session — that one is replayed into a rebirth", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const cfg = config();
    const m = manager(cfg);
    const s = liveSessionWithBridge(m);
    s.refuseNext = 1;
    await m.inject(PR, "wake\n");
    const command = store.activeSessionCommand(SESSION)!;
    await vi.waitFor(() => expect(s.sends).toHaveLength(1));
    live.delete(SESSION); // tmux is gone

    const row = store.getSessionCommand(command.id)!;
    expect(
      await m.redeliverSessionCommand(command.id, {
        attempt: row.attempt,
        redeliveries: row.redeliveries,
        next_check_at: row.next_check_at,
      }),
    ).toBe("not_live");
    expect(store.getSessionCommand(command.id)).toMatchObject({ redeliveries: 0 });
  });
});

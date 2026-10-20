// Hosts for the SessionHooks conformance suite (tests/session-hooks-conformance
// .test.ts).
//
// `SessionHooks` (src/types.ts) is the one seam between the daemon's state
// machine and whatever runs the per-PR pi. The conformance suite states the
// contract once and runs it against every host in `SESSION_HOSTS`; a host joins
// by adding one entry here and passing the same cases. The suite never reaches
// below the hooks except through the `SessionHooksRig` verbs, which are the world
// the host runs in: what has reached a session's mailbox, what pi accepted,
// whether the session is up.
//
// The tmux host is today's `PiSessionManager` over a recording fake exec — no
// tmux, no pi and no git is ever spawned. The worker host (P8.6) is
// `WorkerSessionHost` over a real `WorkerSupervisor` whose spawn, process table
// and signals are fakes — no process, no socket, no model. Where the two differ
// by nature (a tmux session outlives its commands and has a bridge to redeliver
// into; a worker is a command), `SessionHooksHost` says so and the suite asks.
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { spawn as nodeSpawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/config.js";
import { CapabilityStore } from "../../src/ipc/capability.js";
import type { WorkerSpec } from "../../src/ipc/workerspec.js";
import { writeSessionBridgeState } from "../../src/overseer-bridge.js";
import { PiSessionManager, prSessionName } from "../../src/sessions.js";
import { StateStore } from "../../src/state.js";
import { Tmux, type ExecFn } from "../../src/tmux.js";
import type { SessionHooks } from "../../src/types.js";
import { WorkerSessionHost } from "../../src/worker-session-host.js";
import { WorkerSupervisor } from "../../src/workersupervisor.js";
import { WorktreeManager } from "../../src/worktrees.js";

/** The hooks a conforming host provides in full. The optional members of
 * `SessionHooks` are optional for stubs; a real host has all of them, but for the
 * two the worker host bypasses (its worker compacts) and its own marker. The tmux
 * host (the overseer's, until P9.13) offers no receipt read: that is the worker's. */
export type FullSessionHooks = Required<
  Omit<SessionHooks, "compactSession" | "sessionCompaction" | "ackIsReceipt">
>;

export const HOST_NOW = new Date("2026-08-13T10:00:00Z");

export interface SessionHooksRig {
  readonly hooks: FullSessionHooks;
  /** The durable command store the host and the daemon share. */
  readonly store: StateStore;
  /** Is the PR's (or the overseer's) session up in the host? */
  isRunning(session: string): boolean;
  /** A session the host already runs, with work in flight for it — as left by an
   * earlier daemon (a tmux session; a worker holding a command). Birth goes
   * through the hooks; this is only for a session that exists before the case
   * starts. */
  seedRunningSession(session: string): void | Promise<void>;
  /** The PR's session is there and takes a wake, with nothing in flight: a tmux
   * session waiting at its prompt; for a worker, an idle PR, which has no process. */
  seedIdleSession(session: string): void | Promise<void>;
  /** Messages that reached the session's mailbox and are not consumed yet,
   * as the exact bytes, in arrival order. */
  mailbox(session: string): string[];
  /** The session consumed what was in its mailbox and finished it: the
   * durable command is acked and the mailbox is empty. */
  settleDelivered(pr: number): void | Promise<void>;
  /** pi accepted this user message into the PR session's transcript. */
  recordAccepted(pr: number, text: string): void;
  /** pi wrote something to the PR session's transcript that is not a prompt. */
  recordActivity(pr: number): void;
  /** The session consumed what was in its mailbox without settling it (the
   * wake file is gone, the durable command is untouched). Bridge hosts only. */
  consumeMailbox(session: string): void;
  /** The session's bridge now reports a generation the host did not birth.
   * Bridge hosts only. */
  staleBridge(session: string): void;
  /** The order the session was handed is gone without a receipt: consumed and
   * never written to its transcript (tmux), or its worker ended before it
   * accepted (worker). The silent-round net's case. */
  loseDeliveredOrder(pr: number): void | Promise<void>;
  /** How many compactions the daemon has asked of the session. */
  compactionRequests(session: string): number;
  /** The session dies on its own — the container restarted, pi crashed. */
  killOutOfBand(session: string): void;
  /** From now on a kill of this session does not take. */
  wedgeSession(session: string): void;
  /** Every birth and kill the host performed, in order: "birth pr-42",
   * "kill pr-42". The fence cases read their ordering from it. */
  lifecycle(): string[];
  /** Run `fn` as a session comes up — the new consumer starting, which is
   * where a replayed command is reserved — or as a kill lands. */
  onBirth(fn: (session: string) => void): void;
  onKill(fn: (session: string) => void): void;
  /** The daemon restarts: fresh hooks over the same world and the same store.
   * Hosts whose sessions survive a restart only (a tmux session does; a worker
   * dies with its daemon, which `worker-session-host.test.ts` covers). */
  restart(): FullSessionHooks;
  dispose(): void;
}

export interface SessionHooksHost {
  /** Names the host in the suite's output. */
  readonly name: string;
  open(): SessionHooksRig;
  /** The host delivers through an inject bridge: a mailbox a session consumes,
   * a bridge generation, a redelivery into a live session, a restart that adopts
   * the live sessions. False for the worker host, whose command IS the delivery. */
  readonly bridge: boolean;
  /** A session outlives its commands, so a wake into a live one births nothing. */
  readonly persistent: boolean;
  /** The row a dispatched round's command is in right after `dispatchRound`:
   * the bridge claims it later; a worker claims it as it launches. */
  readonly dispatchedRow: { status: string; attempt: number };
  /** What a receipt read says when the session has done other work but not yet
   * this order: a transcript scan can say it was absent (false); a command's ack
   * cannot yet tell (null). */
  readonly receiptBeforeAck: boolean | null;
}

const TITLE = "Add rate limiting";

function config(root: string): Config {
  return {
    dry_run: true,
    github: {
      repo: "exampleorg/example-app",
      app_slug: "example-review",
      bot_login: "example-review[bot]",
      review_team: "exampleorg/review",
      trigger_label: "AI review requested",
      in_progress_label: "AI review in progress",
      reviewed_label: "Automatic Review",
      improvement_label: "Bot improvement",
      issue_label: "bot-filed",
      secrets_dir: join(root, "secrets"),
    },
    server: { hostname: "h", port: 8787 },
    daemon: {
      poll_interval_s: 300,
      max_concurrent_rounds: 6,
      round_deadline_min: 45,
      overseer_rotation_days: 7,
    },
    eod: { time: "18:00", timezone: "Europe/Warsaw" },
    caps: {
      improvement_pr_max_lines: 50,
      improvement_pr_max_files: 3,
      improvement_pr_per_day: 1,
      improvement_pr_per_week: 3,
      issues_per_day: 3,
    },
    models: {
      default: "openai/gpt-5.6-sol",
      conversation: "openai/conv",
      overseer: "openai/over",
      passes: {},
    },
    pi: {
      package: "@earendil-works/pi-coding-agent",
      version: "0.84.4",
      session_dir: "state/pi-sessions",
      subagent_max_concurrency: 6,
    },
    openviking: { host: "127.0.0.1", port: 1933, config_file: join(root, "ovhome", "ov.conf") },
  } as unknown as Config;
}

function openTmuxHost(): SessionHooksRig {
  const root = mkdtempSync(join(tmpdir(), "qcr-hooks-conformance-"));
  mkdirSync(join(root, "prompts"), { recursive: true });
  mkdirSync(join(root, "secrets"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(
    join(root, "prompts", "conversation-system.md"),
    "Shepherd of PR #{{n}} ({{title}}) at {{worktree}}.\n",
  );
  writeFileSync(join(root, "prompts", "overseer-system.md"), "You are the overseer.\n");
  writeFileSync(join(root, "secrets", "openai_api_key"), "sk-app-key\n");

  const live = new Set<string>();
  const wedged = new Set<string>();
  const lifecycle: string[] = [];
  let onBirth: ((session: string) => void) | undefined;
  let onKill: ((session: string) => void) | undefined;
  // The recording fake: tmux answers from `live`, and a new session's bridge
  // reports ready the way the real one does once pi is up.
  const exec: ExecFn = async (cmd, args) => {
    if (cmd !== "tmux") return { code: 0, stdout: "", stderr: "" };
    if (args[0] === "list-sessions") return { code: 0, stdout: [...live].join("\n"), stderr: "" };
    if (args[0] === "has-session")
      return { code: live.has(String(args[2]).replace(/^=/, "")) ? 0 : 1, stdout: "", stderr: "" };
    if (args[0] === "new-session") {
      const session = String(args[3]);
      live.add(session);
      lifecycle.push(`birth ${session}`);
      onBirth?.(session);
      const generation = args
        .find((value) => value.startsWith("QCR_SESSION_BRIDGE_GENERATION="))
        ?.split("=", 2)[1];
      const stateFile = args
        .find((value) => value.startsWith("QCR_SESSION_BRIDGE_STATE_FILE="))
        ?.slice("QCR_SESSION_BRIDGE_STATE_FILE=".length);
      if (generation && stateFile)
        writeSessionBridgeState(stateFile, {
          version: 1,
          session,
          generation,
          stage: "ready",
          run_status: "idle",
          compaction: { state: "idle", seq: 0 },
          updated_at: HOST_NOW.toISOString(),
        });
    }
    if (args[0] === "kill-session") {
      const name = String(args[2]).replace(/^=/, "");
      lifecycle.push(`kill ${name}`);
      onKill?.(name);
      if (!wedged.has(name)) live.delete(name);
    }
    return { code: 0, stdout: "", stderr: "" };
  };

  const store = new StateStore(join(root, "state", "state.db"), () => HOST_NOW);
  const build = (): PiSessionManager => {
    const m = new PiSessionManager({
      cfg: config(root),
      root,
      tmux: new Tmux({ exec }),
      worktrees: new WorktreeManager({
        root,
        repo: "o/n",
        cloneDir: "example-app",
        cloneUrl: "/dev/null",
        run: exec,
      }),
      piHome: join(root, "pihome"),
      ovSessions: { create: async () => true, remove: async () => true },
      now: () => HOST_NOW,
      commandStore: store,
    });
    // A tracked PR can be woken out of round; the registry knows its title.
    m.setTitleResolver((pr) => store.getPr(pr)?.title ?? undefined);
    return m;
  };
  let manager = build();

  const jsonlFor = (pr: number): string => {
    const dir = join(manager.sessionDir(prSessionName(pr)), "--home-sandbox--");
    mkdirSync(dir, { recursive: true });
    return join(dir, "2026-08-13T10-00-01-000Z_abc.jsonl");
  };

  return {
    get hooks() {
      return manager as unknown as FullSessionHooks;
    },
    store,
    isRunning: (session) => live.has(session),
    seedIdleSession(session) {
      return this.seedRunningSession(session);
    },
    seedRunningSession(session) {
      const generation = `existing-${session}`;
      live.add(session);
      mkdirSync(join(root, "state", "sessions"), { recursive: true });
      writeFileSync(
        join(root, "state", "sessions", `${session}.json`),
        `${JSON.stringify({ session, born_at: "2026-08-13T09:00:00.000Z", bridge_generation: generation })}\n`,
      );
      writeSessionBridgeState(manager.bridgeStatePath(session, generation), {
        version: 1,
        session,
        generation,
        stage: "ready",
        updated_at: "2026-08-13T09:00:00.000Z",
      });
    },
    mailbox(session) {
      const dir = manager.injectDir(session);
      if (!existsSync(dir)) return [];
      return readdirSync(dir)
        .filter((f) => f.endsWith(".md"))
        .sort()
        .map((f) => readFileSync(join(dir, f), "utf8"));
    },
    settleDelivered(pr) {
      const session = prSessionName(pr);
      const row = store.activeSessionCommand(session);
      if (!row) return;
      if (!store.claimSessionCommand(row.id, "conformance-bridge", HOST_NOW.toISOString()))
        throw new Error(`could not claim ${row.id}`);
      store.markSessionCommandStarted(row.id, "conformance-bridge", HOST_NOW.toISOString());
      store.finishSessionCommand(row.id, "conformance-bridge", "acked");
      rmSync(row.inject_path, { force: true });
    },
    consumeMailbox(session) {
      const dir = manager.injectDir(session);
      if (!existsSync(dir)) return;
      for (const f of readdirSync(dir)) if (f.endsWith(".md")) rmSync(join(dir, f));
    },
    staleBridge(session) {
      writeSessionBridgeState(manager.bridgeStatePath(session, `existing-${session}`), {
        version: 1,
        session,
        generation: "stale-generation",
        stage: "ready",
        updated_at: "2026-08-13T09:59:00.000Z",
      });
    },
    killOutOfBand: (session) => void live.delete(session),
    loseDeliveredOrder(pr) {
      const session = prSessionName(pr);
      for (const f of existsSync(manager.injectDir(session))
        ? readdirSync(manager.injectDir(session))
        : [])
        if (f.endsWith(".md")) rmSync(join(manager.injectDir(session), f));
      // pi wrote something since, but not the order: the receipt is absent, not unknown.
      writeFileSync(
        jsonlFor(pr),
        `${JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "working" }] } })}\n`,
      );
    },
    compactionRequests: () => 0,
    recordAccepted(pr, text) {
      writeFileSync(
        jsonlFor(pr),
        `${JSON.stringify({ message: { role: "user", content: [{ type: "text", text }] } })}\n`,
      );
    },
    recordActivity(pr) {
      writeFileSync(
        jsonlFor(pr),
        `${JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "working" }] } })}\n`,
      );
    },
    wedgeSession: (session) => void wedged.add(session),
    lifecycle: () => [...lifecycle],
    onBirth(fn) {
      onBirth = fn;
    },
    onKill(fn) {
      onKill = fn;
    },
    restart() {
      manager = build();
      return manager as unknown as FullSessionHooks;
    },
    dispose() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export const tmuxHost: SessionHooksHost = {
  name: "tmux",
  open: openTmuxHost,
  bridge: true,
  persistent: true,
  dispatchedRow: { status: "pending", attempt: 0 },
  receiptBeforeAck: false,
};

// ---- the worker host ---------------------------------------------------------

/** A worker process that is only a name: it is up until something ends it. */
class FakeWorker extends EventEmitter {
  exited = false;
  constructor(
    readonly pid: number,
    readonly session: string,
  ) {
    super();
  }

  end(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    this.emit("exit", code, signal);
  }
}

const untilGone = async (gone: () => boolean): Promise<void> => {
  const end = Date.now() + 2_000;
  while (!gone()) {
    if (Date.now() > end) throw new Error("the worker did not settle");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
};

/** The worker rig, with the pieces the worker-specific cases drive directly. */
export interface WorkerHostRig extends SessionHooksRig {
  readonly root: string;
  readonly host: WorkerSessionHost;
  readonly supervisor: WorkerSupervisor;
  /** The session's worker ends on its own with this exit code. */
  exit(session: string, code: number): Promise<void>;
  /** The login refresher holds a rewrite: no worker may start. */
  holdLogin(held: boolean): void;
  /** Live worker processes, by session. */
  workers(): string[];
}

export function openWorkerRig(): WorkerHostRig {
  const root = mkdtempSync(join(tmpdir(), "qcr-hooks-conformance-worker-"));
  for (const dir of ["prompts", "secrets", "state", "run"])
    mkdirSync(join(root, dir), { recursive: true });

  const workers = new Map<number, FakeWorker>();
  const wedged = new Set<string>();
  const lifecycle: string[] = [];
  let onBirth: ((session: string) => void) | undefined;
  let onKill: ((session: string) => void) | undefined;
  let nextPid = 1000;
  let disposed = false;
  let loginHeld = false;

  const store = new StateStore(join(root, "state", "state.db"), () => HOST_NOW);
  const supervisor = new WorkerSupervisor({
    store,
    capabilities: new CapabilityStore(),
    runDir: join(root, "run"),
    socketPath: join(root, "run", "q.sock"),
    workerMain: join(root, "botworker.js"),
    logDir: join(root, "state", "workers"),
    payloadDir: join(root, "state", "session-commands"),
    buildSpec: (row, mode): WorkerSpec => ({
      mode,
      command_id: row.id,
      pr: row.pr,
      session: row.session,
      round_no: row.round_no,
      payload_path: row.payload_path,
      payload_sha256: row.payload_sha256,
      root,
      cwd: root,
      agent_dir: join(root, "agent"),
      session_dir: join(root, "state", "pi-sessions", row.session),
      system_prompt_file: join(root, "prompts", "system.md"),
      model: "faux/faux-1",
      env: {},
      events_file: join(root, "state", "live", `${row.session}.jsonl`),
      stderr_file: join(root, "state", "workers", `${row.id}.err`),
      wall_clock_ms: 600_000,
      planned_wave: false,
    }),
    parentEnv: {},
    loginGate: { paused: () => loginHeld, whenResumed: async () => !loginHeld },
    loginWaitMs: 1,
    spawn: ((_node: string, args: readonly string[]) => {
      const command = store.getSessionCommand(String(args[args.indexOf("--command") + 1]))!;
      const worker = new FakeWorker(nextPid++, command.session);
      workers.set(worker.pid, worker);
      lifecycle.push(`birth ${worker.session}`);
      onBirth?.(worker.session);
      return worker;
    }) as unknown as typeof nodeSpawn,
    proc: {
      identity: (pid) => {
        const worker = workers.get(pid);
        return worker && !worker.exited ? { start: String(pid), pgid: pid } : undefined;
      },
      members: () => [],
      bootId: () => "conformance-boot",
    },
    signal: (target, sig) => {
      const worker = workers.get(Math.abs(target));
      if (!worker || worker.exited) return "gone";
      if (disposed || wedged.has(worker.session)) return "sent";
      lifecycle.push(`kill ${worker.session}`);
      onKill?.(worker.session);
      worker.end(null, sig);
      return "sent";
    },
    limits: { killGraceMs: 5, wallGraceMs: 0, tickMs: 60_000, fenceWaitMs: 150 },
  });
  const host = new WorkerSessionHost({
    cfg: config(root),
    root,
    worktrees: new WorktreeManager({
      root,
      repo: "o/n",
      cloneDir: "example-app",
      cloneUrl: "/dev/null",
      run: async () => ({ code: 0, stdout: "", stderr: "" }),
    }),
    store,
    supervisor,
    ovSessions: { create: async () => true, remove: async () => true },
    now: () => HOST_NOW,
    log: () => {},
  });

  const prOf = (session: string): number => Number(session.replace(/^pr-/, ""));
  const live = (session: string): FakeWorker | undefined =>
    [...workers.values()].find((w) => w.session === session && !w.exited);

  return {
    root,
    host,
    supervisor,
    hooks: host as unknown as FullSessionHooks,
    store,
    isRunning: (session) => supervisor.isLive(session),
    async exit(session, code) {
      live(session)?.end(code, null);
      await untilGone(() => !supervisor.isLive(session));
    },
    holdLogin(held) {
      loginHeld = held;
    },
    workers: () => [...workers.values()].filter((w) => !w.exited).map((w) => w.session),
    loseDeliveredOrder(pr) {
      // Exit 3: the handshake could not be trusted. The order never reached a session.
      const session = prSessionName(pr);
      live(session)?.end(3, null);
      return untilGone(() => !supervisor.isLive(session));
    },
    compactionRequests: () => 0,
    seedIdleSession() {
      // An idle PR has no process: nothing to seed.
    },
    async seedRunningSession(session) {
      const command = supervisor.submit({
        pr: prOf(session),
        kind: "wake",
        round_no: null,
        payload: "seeded wake",
      });
      await supervisor.launch(command.id);
    },
    mailbox(session) {
      const active = store.activeSessionCommand(session);
      if (!active) return [];
      return [readFileSync(active.payload_path, "utf8")];
    },
    async settleDelivered(pr) {
      const session = prSessionName(pr);
      const worker = live(session);
      if (!worker) return;
      worker.end(0, null);
      await untilGone(() => !supervisor.isLive(session));
    },
    recordAccepted(pr, text) {
      // The worker's `accepted` event: it took the order it was handed.
      const command = store.activeSessionCommand(prSessionName(pr));
      if (!command) return;
      const payload = readFileSync(command.payload_path, "utf8");
      if (payload.trimEnd() !== text.trimEnd()) return;
      supervisor.onEvent(
        {
          commandId: command.id,
          role: "worker",
          pr,
          generation: command.attempt,
          mayPost: false,
          answer: false,
          lease: "none",
          requirePr: () => {},
        },
        "accepted",
        {},
      );
    },
    recordActivity(pr) {
      const dir = join(host.sessionDir(prSessionName(pr)), "--home-sandbox--");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "2026-08-13T10-00-01-000Z_abc.jsonl"),
        `${JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "working" }] } })}
`,
      );
    },
    consumeMailbox() {
      throw new Error("a worker has no mailbox to consume");
    },
    staleBridge() {
      throw new Error("a worker has no bridge");
    },
    killOutOfBand(session) {
      live(session)?.end(null, "SIGKILL");
    },
    wedgeSession: (session) => void wedged.add(session),
    lifecycle: () => [...lifecycle],
    onBirth(fn) {
      onBirth = fn;
    },
    onKill(fn) {
      onKill = fn;
    },
    restart() {
      throw new Error("a worker dies with its daemon: nothing is adopted");
    },
    dispose() {
      disposed = true;
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export const workerHost: SessionHooksHost = {
  name: "worker",
  open: openWorkerRig,
  bridge: false,
  persistent: false,
  dispatchedRow: { status: "running", attempt: 1 },
  receiptBeforeAck: null,
};

/** Every host the contract runs against. */
export const SESSION_HOSTS: SessionHooksHost[] = [tmuxHost, workerHost];

/** A tracked (or closed) PR in the registry, the title the host wakes it by. */
export function trackPr(
  store: StateStore,
  pr: number,
  state: "tracked" | "closed" = "tracked",
): void {
  store.upsertPr({
    number: pr,
    state,
    head_sha: "abc123",
    title: TITLE,
    author: "alice",
    trigger_ts: null,
    stale_recheck: 0,
    migration_gate: 0,
  });
}

export function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

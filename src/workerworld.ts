// The worker world, assembled for the daemon (P8.15w): workers are the bot's ONLY host.
//
// P8.5 to P8.17 each built a part of it and left the daemon unwired; this is where wire.ts
// gets them put together, so it is one place that says what runs beside what:
//
//   - the capability store and the IPC server on `<state>/run/qcr.sock`, serving the
//     supervisor's lookup and ops (spec, control acks, held wakes, the post ops, the permit
//     broker's ops) and composing the worker's events with the spend intake (P8.9);
//   - the WorkerSupervisor, whose spawn policy is the crash-loop breaker's (P8.5b) and whose
//     spec is built here, from the same sources the tmux route's buildPiCommand used: the
//     conversation system prompt, the OpenViking identity and the git config pins;
//   - the WorkerSessionHost, the SessionHooks the daemon's state machine speaks;
//   - the takeover (P8.13) and debug-round (P8.13b) leases, which keep workers out of a
//     PR's session while an operator's pi is in it, and the idle-PR answer host (P8.17);
//   - the operator's controls (P8.12) and the per-PR runtime status.
//
// There is no switch and no tmux fallback: nothing here births a `pr-<n>` tmux session. The tmux
// PiSessionManager that still exists serves what has not moved yet (the overseer, until P9.13)
// and lends its path helpers and environment, which is what keeps a worker's session the same
// session a tmux round saw.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AnswerHost, answerCapsOf } from "./answerworker.js";
import type { ControlCommand } from "./commands.js";
import type { Config } from "./config.js";
import { DebugRoundManager } from "./debuground.js";
import type { FileOutcome } from "./improvements.js";
import { identityVars } from "./include.js";
import {
  CapabilityStore,
  LaunchFiles,
  capsDirOf,
  socketPathOf,
  runDirOf,
} from "./ipc/capability.js";
import type { PermitBroker } from "./ipc/permits.js";
import { IpcServer, type EventHandler } from "./ipc/server.js";
import type { WorkerMode, WorkerSpec } from "./ipc/workerspec.js";
import type { OvSessionLifecycle } from "./memory/ovsession.js";
import { PostingJournal } from "./posting-journal.js";
import { postingKeyHead } from "./posting-receipt.js";
import type { GhReader } from "./ghread.js";
import { commandRoundOf, type PostAdapter } from "./postops.js";
import { newestSessionFile } from "./sessionjsonl.js";
import { prSessionName, type PiSessionManager } from "./sessions.js";
import type { PrRuntime, SessionCommandRow, StateStore } from "./state.js";
import {
  TakeoverManager,
  composeHostGates,
  composeLookups,
  takeoverPlanFor,
  type TakeoverPlan,
} from "./takeover.js";
import { renderConversationSystemPrompt } from "./templates.js";
import { HeldWakeHandoff } from "./wakes.js";
import { WorkerSessionHost } from "./worker-session-host.js";
import { workerOperatorControl } from "./workercontrol.js";
import { runtimeOfPr } from "./workerruntime.js";
import { WorkerSupervisor } from "./workersupervisor.js";
import { workerUsageHandler } from "./workerusage.js";

/** The names the tmux route's environment carried that a worker's session does not:
 * the model key (a worker borrows the bot's login), the inject bridge's directory and the
 * state database. Nothing else is dropped: a worker round sees what a
 * tmux round saw. */
export const WORKER_ENV_DROPPED: readonly string[] = [
  "OPENAI_API_KEY",
  "QCR_INJECT_DIR",
  "QCR_STATE_DB",
];

/** How often a command a worker's death requeued is handed a fresh worker. */
export const LAUNCH_PENDING_EVERY_MS = 5_000;

export interface WorkerWorldOptions {
  cfg: Config;
  /** Sandbox root. */
  root: string;
  store: StateStore;
  adapter: PostAdapter;
  /** The helpers' GitHub reads (src/ghread.ts): the full adapter, in production. */
  reader?: GhReader;
  /** The model's tools run as a separate uid of the daemon's group (D32): the
   * socket is opened to the group so their shims can dial in. */
  toolUid?: boolean;
  /** The tmux manager that still serves the overseer: lends the worktrees, the OpenViking
   * and git environment, the system prompt writer and the tmux client the lease panes use. */
  sessions: PiSessionManager;
  ovSessions?: OvSessionLifecycle;
  permits: PermitBroker;
  /** pi's agent dir: where the login lives (the refresher keeps it). */
  agentDir: string;
  /** Run the daemon's pump (a lease freed, a worker gone). Late-bound: the daemon is built
   * after this. */
  pump: () => Promise<void>;
  /** The login refresher's hold while a login rewrites auth.json. Late-bound. */
  loginGate?: {
    paused(): boolean;
    whenResumed(timeoutMs: number): Promise<boolean>;
  };
  log: (msg: string, extra?: unknown) => void;
  /** Test seams. */
  nodeBin?: string;
  workerMain?: string;
}

export interface WorkerWorld {
  host: WorkerSessionHost;
  supervisor: WorkerSupervisor;
  server: IpcServer;
  capabilities: CapabilityStore;
  takeover: TakeoverManager;
  debug: DebugRoundManager;
  answer: AnswerHost;
  /** `CommandDeps.operatorControl`. */
  operatorControl: (command: ControlCommand, file: string) => Promise<FileOutcome>;
  /** `DaemonDeps.runtimeOf`. */
  runtimeOf: (pr: number) => PrRuntime;
  /** The daemon's boot: the socket up, whatever a previous daemon left reaped and requeued,
   * the timers running. */
  start(): Promise<void>;
  /** Workers end (their commands requeue), leases are reaped, the socket closes. */
  stop(): Promise<void>;
}

/** The worker's session environment, built from the tmux manager's: the same names and
 * values a tmux round's pi was given, minus `WORKER_ENV_DROPPED`, plus this PR's identity. */
export function workerSessionEnv(
  sessions: Pick<PiSessionManager, "buildEnv">,
  session: string,
  extra: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(sessions.buildEnv(session, extra))) {
    if (value === undefined || WORKER_ENV_DROPPED.includes(name)) continue;
    env[name] = value;
  }
  return env;
}

export function buildWorkerWorld(o: WorkerWorldOptions): WorkerWorld {
  const { cfg, root, store, sessions, log } = o;
  const stateDir = join(root, "state");
  const runDir = runDirOf(stateDir);
  const socketPath = socketPathOf(stateDir);
  const dist = (...p: string[]): string => join(root, "dist", "src", ...p);
  const capabilities = new CapabilityStore();
  const launchFiles = new LaunchFiles({ capsDir: capsDirOf(stateDir), store: capabilities });
  const rawMissing = new Set<number>();

  /** The round's head, which its posting key names; undefined for a key the daemon never issued. */
  const headOf = (pr: number, roundNo: number): string | undefined => {
    const key = store.roundsFor(pr).find((r) => r.round_no === roundNo)?.posting_key;
    return key ? postingKeyHead(key, pr, roundNo) : undefined;
  };

  const workerEnvFor = (row: SessionCommandRow, worktree: string, title: string) => {
    const extra: Record<string, string> = {
      QCR_PR: String(row.pr),
      QCR_PR_META: `PR #${row.pr} — ${title} (worktree ${worktree})`,
      QCR_WORKTREE: worktree,
      // A raw tier that could not be created leaves the session memory-less, as on tmux.
      ...(rawMissing.has(row.pr) ? { QCR_OV_SESSION_ID: "", OPENVIKING_SESSION_ID: "" } : {}),
    };
    if (row.kind === "round" && row.round_no !== null) {
      const round = store.roundsFor(row.pr).find((r) => r.round_no === row.round_no);
      extra["QCR_ROUND_NO"] = String(row.round_no);
      if (round?.posting_key) {
        extra["QCR_POSTING_KEY"] = round.posting_key;
        const head = postingKeyHead(round.posting_key, row.pr, row.round_no);
        if (head) extra["QCR_EXPECTED_HEAD"] = head;
      }
    }
    const env = workerSessionEnv(sessions, row.session, extra);
    // Memory switched off ([openviking] enabled = false) leaves the session no memory surface
    // to reach: not an outage, so no endpoint, key file or session id is named.
    if (!cfg.openviking.enabled)
      for (const name of Object.keys(env))
        if (name.startsWith("OPENVIKING_") || name.startsWith("QCR_OV_")) delete env[name];
    return env;
  };

  /** The command's spec: the daemon's layout, the conversation model, the session's env. */
  const buildSpec = (row: SessionCommandRow, mode: WorkerMode): WorkerSpec => {
    const pr = row.pr;
    const title = store.getPr(pr)?.title ?? `PR #${pr}`;
    const worktree = sessions.worktrees.worktreePath(pr);
    // The reviewer's key lands in the pi HOME before a session starts, as at a tmux birth.
    sessions.provisionOvCredentials();
    const prompt = renderConversationSystemPrompt(
      readFileSync(join(root, "prompts", "conversation-system.md"), "utf8"),
      { pr, title, worktree },
      identityVars(cfg),
    );
    const workers = join(stateDir, "workers");
    mkdirSync(workers, { recursive: true });
    return {
      mode,
      command_id: row.id,
      pr,
      session: row.session,
      round_no: row.round_no,
      payload_path: row.payload_path,
      payload_sha256: row.payload_sha256,
      root,
      cwd: root,
      agent_dir: o.agentDir,
      session_dir: sessions.sessionDir(row.session),
      system_prompt_file: sessions.writeSystemPrompt(row.session, prompt),
      model: cfg.models.conversation,
      env: workerEnvFor(row, worktree, title),
      events_file: join(workers, `${row.id}.events.jsonl`),
      stderr_file: join(workers, `${row.id}.pi-stderr.log`),
      wall_clock_ms:
        mode === "answer"
          ? answerCapsOf(cfg.daemon).timeoutMs
          : Math.round(cfg.daemon.round_deadline_min * 60_000),
      planned_wave: row.kind === "round" && cfg.pi.engine_wave,
    };
  };

  const wakes = new HeldWakeHandoff(store);
  const journal = new PostingJournal({
    dir: join(stateDir, "posting-receipts"),
    repo: cfg.github.repo,
  });

  // The takeover and debug managers are built before the supervisor (it takes their gates)
  // and need the supervisor's rows through it: the lazy references below close that loop.
  let supervisorRef: WorkerSupervisor | undefined;
  const workerRuns = (pr: number): boolean | null =>
    supervisorRef ? supervisorRef.runs(prSessionName(pr)) : null;
  const afterRelease = async (): Promise<void> => {
    await o.pump();
    await supervisorRef?.launchPending();
  };
  const modelEnv = (pr: number): Record<string, string> => {
    const env = workerSessionEnv(sessions, prSessionName(pr), {
      QCR_PR: String(pr),
      QCR_WORKTREE: sessions.worktrees.worktreePath(pr),
    });
    return env;
  };

  const takeover = new TakeoverManager({
    store,
    capabilities,
    launchFiles,
    runDir,
    socketPath,
    tmux: sessions.tmux,
    plan: (pr): TakeoverPlan =>
      takeoverPlanFor({
        root,
        agentDir: o.agentDir,
        sessionsRoot: sessions.sessionsRoot(),
        model: cfg.models.conversation,
        pr,
        newestSessionFile,
        env: modelEnv(pr),
        systemPromptFile: sessions.promptPath(prSessionName(pr)),
      }),
    launcherMain: dist("ipc", "launcher.js"),
    takeoverMain: dist("takeoverpi.js"),
    ...(o.nodeBin ? { nodeBin: o.nodeBin } : {}),
    workerRuns,
    afterRelease,
    log,
  });

  const debug = new DebugRoundManager({
    store,
    // The supervisor writes every command row; it is bound just below.
    commands: {
      claimHosted: (...a) => supervisorRef!.claimHosted(...a),
      markHostedStarted: (...a) => supervisorRef!.markHostedStarted(...a),
      settleHosted: (...a) => supervisorRef!.settleHosted(...a),
    },
    capabilities,
    launchFiles,
    runDir,
    socketPath,
    tmux: sessions.tmux,
    gate: (pr) => supervisorRef!.breaker.gate(pr),
    buildSpec: (row) => buildSpec(row, "round"),
    newestSessionFile,
    launcherMain: dist("ipc", "launcher.js"),
    debugMain: dist("debugroundpi.js"),
    ...(o.nodeBin ? { nodeBin: o.nodeBin } : {}),
    workerRuns,
    afterRelease,
    log,
  });

  let answerRef: AnswerHost | undefined;
  const supervisor: WorkerSupervisor = new WorkerSupervisor({
    store,
    capabilities,
    runDir,
    socketPath,
    workerMain: o.workerMain ?? dist("botworker.js"),
    logDir: join(stateDir, "workers"),
    payloadDir: join(stateDir, "session-commands"),
    buildSpec,
    ...(o.nodeBin ? { nodeBin: o.nodeBin } : {}),
    answer: answerCapsOf(cfg.daemon),
    settled: (s) => answerRef?.onSettled(s),
    post: {
      root,
      adapter: o.adapter,
      store,
      journal,
      cfg,
      botLogins: [cfg.github.bot_login, cfg.github.app_slug],
      roundOf: commandRoundOf(store, headOf),
      log,
    },
    wakes: wakes.forWorker(),
    ...(o.reader ? { ghRead: o.reader } : {}),
    permits: o.permits,
    hostGate: composeHostGates(takeover.hostGate.bind(takeover), debug.hostGate.bind(debug)),
    ...(o.loginGate ? { loginGate: o.loginGate } : {}),
    push: (id, kind, body) => server.push(id, kind, body),
    log,
  });
  supervisorRef = supervisor;

  const usage = workerUsageHandler(store);
  const onEvent: EventHandler = (ctx, kind, body) => {
    try {
      usage(ctx, kind, body);
    } catch (err) {
      log(`worker usage intake failed for ${ctx.commandId}: ${String(err)}`);
    }
    supervisor.onEvent(ctx, kind, body);
  };
  const server: IpcServer = new IpcServer({
    socketPath,
    capabilities,
    ...(o.toolUid === true ? { groupAccess: true } : {}),
    // A debug round's command and a takeover's are known to their managers; every worker's
    // is the supervisor's.
    commands: composeLookups(debug.lookup, takeover.lookup, supervisor.lookup),
    ops: supervisor.ops(),
    onEvent,
    log,
  });

  const host = new WorkerSessionHost({
    cfg,
    root,
    worktrees: sessions.worktrees,
    store,
    supervisor,
    debugRounds: debug,
    ...(o.ovSessions ? { ovSessions: o.ovSessions } : {}),
    onRawTier: (pr, ready) => {
      if (ready) rawMissing.delete(pr);
      else rawMissing.add(pr);
    },
  });

  const answer = new AnswerHost({
    supervisor,
    store,
    root,
    lease: (pr) => takeover.leaseOf(pr) ?? debug.leaseOf(pr),
    hasSession: (pr) => host.lifecycle.newestSessionFile(prSessionName(pr)) !== undefined,
    log: (m) => log(m),
  });
  answerRef = answer;

  const operatorControl = workerOperatorControl({
    supervisor,
    takeover,
    debug,
    message: (command) => answer.message(command),
  });

  const runtimeOf = (pr: number): PrRuntime =>
    runtimeOfPr(pr, {
      workers: () => supervisor.workers(),
      lease: (n) => takeover.leaseOf(n) ?? debug.leaseOf(n),
    });

  let pending: NodeJS.Timeout | null = null;
  return {
    host,
    supervisor,
    server,
    capabilities,
    takeover,
    debug,
    answer,
    operatorControl,
    runtimeOf,
    async start() {
      await server.start();
      // Whatever a previous daemon left: workers are reaped and their commands requeued before
      // any launch, and an operator's pi is ended and its lease freed once it is gone.
      const recovered = await supervisor.recover();
      log(
        `workers: recovered killed=${recovered.killed.length} stale=${recovered.stale.length} requeued=${recovered.requeued.length} failed=${recovered.failed.length}`,
      );
      await takeover.recover();
      await debug.recover();
      supervisor.start();
      takeover.start();
      debug.start();
      pending = setInterval(() => {
        void supervisor.launchPending().catch((err) => log("launchPending failed", err));
      }, LAUNCH_PENDING_EVERY_MS);
      pending.unref?.();
    },
    async stop() {
      if (pending) clearInterval(pending);
      pending = null;
      takeover.stopTimer();
      debug.stopTimer();
      await supervisor.stop();
      await server.stop();
      launchFiles.dispose();
    },
  };
}

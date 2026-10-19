// The WorkerSupervisor (P8.5, D22/D23): the daemon's end of the per-round worker.
//
// One Node process serves one round of one PR (src/botworker.ts). This module
// starts it, watches it and ends it:
//
//   - SPAWN. `node dist/src/botworker.js --command <id> --mode round|answer`, in
//     a process group of its own, with the command's capability on an inherited
//     fd (stdio[3]) and a small env built from an ALLOWLIST. No GitHub credential
//     of any name is in it (GITHUB_TOKEN_ENVS, from src/envstrip.ts, so this
//     module never imports src/engine/), and the capability is on the fd only.
//   - LISTEN. It serves `worker.spec` and the worker's events over the IPC socket
//     (src/ipc/server.ts). A request or event is accepted only for the command's
//     live generation (the claim's attempt count); a worker from an earlier
//     generation is refused, and its capability is dead anyway.
//   - WATCH. The worker's heartbeats (`progress` events) are its liveness; the
//     deadlines tolerate the 0.7-2.5 s a wave's session creation blocks its event
//     loop (tests/cpu-gate: staggered grants will shorten it, not remove it). A
//     worker is ended when it stops talking, when a stage runs over, or at its
//     wall clock: SIGTERM to the group, SIGKILL after the grace.
//   - LEASE. A file per session (src/workerlease.ts) names the leader's pid, pgid,
//     start time and the boot/container id, fenced by an owner token. Pids and
//     pgids repeat in a recreated container, so the daemon's boot signals a
//     leased group only when the leader still has the recorded start time in the
//     recorded boot and container.
//   - WRITE. This module is the single writer of session_commands rows for a
//     worker-hosted PR: it creates them, claims them, marks them started on the
//     worker's `accepted`, finishes them from the exit, and requeues a round whose
//     worker died. The one-active index (`session_commands_one_active`) gives one
//     worker per session; a second spawn is refused before the row is claimed.
//   - BREAKER (P8.5b, src/workerbreaker.ts). Every exit is counted: a worker that
//     served its round resets its PR's count; a non-zero exit, a `failed` event or
//     a deadline kill adds one. Two in a row park the PR (no further spawn, a
//     `worker_crash_loop` anomaly, the last error in status.json); failures on three
//     PRs within 15 minutes drain the bot. A drained bot or a parked PR starts no
//     worker, of any mode: `launch` refuses and `launchPending` skips. An end by the
//     daemon's own stop or by the operator is not a failure.
//   - RESTART. On a daemon restart every leased group is killed and its round is
//     requeued under the same command id (`recover`), so the fresh worker resumes
//     the JSONL and continues instead of sending the order again (D22).
//
// The session host over it is src/worker-session-host.ts (P8.6): the SessionHooks
// the daemon's state machine speaks, served by this supervisor.
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { GITHUB_TOKEN_ENVS } from "./envstrip.js";
import {
  type CapabilityStore,
  createCapabilityFd,
  ipcEnv,
  stdioWithCapability,
} from "./ipc/capability.js";
import {
  IpcError,
  type CommandLookup,
  type CommandState,
  type IpcEventKind,
} from "./ipc/protocol.js";
import { type PermitBroker, permitOps } from "./ipc/permits.js";
import type { EventHandler, OpHandler, RequestContext } from "./ipc/server.js";
import {
  WAKES_ACK_OP,
  WAKES_TAKE_OP,
  WORKER_SPEC_OP,
  parseWorkerSpec,
  type WakeBatch,
  type WorkerMode,
  type WorkerSpec,
} from "./ipc/workerspec.js";
import { postOps, type PostOpsDeps } from "./postops.js";
import { verifiedPayload } from "./session-command-payload.js";
import {
  DEFAULT_WORKER_LOG_LIMITS,
  rotateWorkerLogs,
  workerLogPath,
  type WorkerLogLimits,
} from "./workerlog.js";
import { WorkerBreaker, type BreakerLimits } from "./workerbreaker.js";
import type { SessionCommandKind, SessionCommandRow, StateStore } from "./state.js";
import {
  WorkerLeases,
  judgeLease,
  killLease,
  realProc,
  sendSignal,
  type ProcView,
  type SignalFn,
  type WorkerLease,
} from "./workerlease.js";

/** The env names a worker process may inherit from the daemon. Everything else is
 * dropped, whatever the daemon's own env holds: a worker carries the daemon's
 * locale, path and proxies, the tool-uid split the image arranged (the worker
 * reads them to run the model's tools under it), and nothing that is a secret. */
export const WORKER_ENV_ALLOW: readonly string[] = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "TERM",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "PI_CODING_AGENT_DIR",
  // The separate tool uid (src/engine/tooluid.ts TOOL_UID_ENVS; named here
  // because the daemon never imports src/engine/).
  "QCR_TOOL_UID",
  "QCR_TOOL_GID",
  "QCR_TOOL_UID_REQUIRED",
  "QCR_ALLOW_SHARED_TOOL_UID",
];

export interface WorkerLimits {
  /** Spawn to `ready`: the connect, the spec, the login, the session open (a
   * resume parses the whole JSONL). */
  readyMs: number;
  /** `ready` to `accepted`: the planned wave starts first, then the order. */
  acceptMs: number;
  /** The interval the worker is told to beat at (`heartbeat_ms` in its spec). */
  heartbeatMs: number;
  /** Beats a worker may miss before it counts as silent... */
  missedBeats: number;
  /** ...plus this: creating a wave of 8-20 sessions at once blocks the worker's
   * loop for 0.7-2.5 s (docs/cpu-gate.md), so a late beat is not a dead worker.
   * Twice the worst measured stall. */
  stallAllowanceMs: number;
  /** Added to the spec's `wall_clock_ms`: the worker's own cap fires first. */
  wallGraceMs: number;
  /** SIGTERM to SIGKILL. */
  killGraceMs: number;
  /** Times a round is handed to a fresh worker after its worker died. */
  maxRequeues: number;
  /** How often `start()` runs `tick`. */
  tickMs: number;
  /** How long `fence` waits for a worker it ended to be reaped before it says the
   * session is NOT proven gone. */
  fenceWaitMs: number;
}

export const DEFAULT_WORKER_LIMITS: WorkerLimits = {
  readyMs: 120_000,
  acceptMs: 120_000,
  heartbeatMs: 15_000,
  missedBeats: 4,
  stallAllowanceMs: 5_000,
  wallGraceMs: 30_000,
  killGraceMs: 10_000,
  maxRequeues: 3,
  tickMs: 1_000,
  fenceWaitMs: 15_000,
};

/** How long, once silent, a worker has before it is ended. */
export const staleAfterMs = (heartbeatMs: number, l: WorkerLimits): number =>
  l.missedBeats * heartbeatMs + l.stallAllowanceMs;

export type KillReason =
  | "wall_clock"
  | "stage_ready"
  | "stage_accept"
  | "heartbeat_lost"
  | "shutdown"
  | "operator"
  // The recovery fence (SessionHooks.killSession): the caller owns the row's fate,
  // as it does when it kills a tmux session, so the exit writes nothing to it.
  | "fence";

/** What a worker's death means for its command. */
export type Outcome =
  | { kind: "acked" }
  | { kind: "failed"; reason: string }
  | { kind: "requeue"; reason: string }
  | { kind: "leave" };

/**
 * The exit decides the row. Exit 0 is a served round (a verdict may or may not
 * have been written: that is the round's own business). A worker that failed in
 * a way a fresh one would repeat (a refused login, a turn that ran out of time or
 * money, a bad payload) fails the command; one that was lost (killed, crashed,
 * its daemon went away) hands the round to a fresh worker, which resumes the
 * JSONL. Ended for its wall clock, or by the operator: failed, not retried. Ended
 * by a recovery fence: left as it is, for the caller that fenced it.
 */
export function decideOutcome(x: {
  code: number | null;
  signal: NodeJS.Signals | null;
  killedFor: KillReason | undefined;
  failedReason: string | undefined;
  spawnError: string | undefined;
}): Outcome {
  if (x.spawnError !== undefined)
    return { kind: "failed", reason: `could not start the worker: ${x.spawnError}` };
  if (x.killedFor === "wall_clock")
    return { kind: "failed", reason: "the worker ran past its wall clock and was ended" };
  if (x.killedFor === "fence") return { kind: "leave" };
  if (x.killedFor === "operator")
    return { kind: "failed", reason: "the worker was ended by the operator" };
  if (x.killedFor !== undefined)
    return { kind: "requeue", reason: `the worker was ended: ${x.killedFor}` };
  if (x.code === 0) return { kind: "acked" };
  if (x.code !== null && x.code >= 1 && x.code <= 5)
    return { kind: "failed", reason: x.failedReason ?? `the worker exited ${x.code}` };
  return {
    kind: "requeue",
    reason: x.signal ? `the worker died of ${x.signal}` : `the worker exited ${x.code}`,
  };
}

/** The env of one worker process: the allowlisted part of the daemon's env, the
 * daemon's explicit additions, and the IPC names (the fd NUMBER, never the
 * capability). A GitHub credential is dropped last, by name, so no addition can
 * carry one in. */
export function workerProcessEnv(
  parent: NodeJS.ProcessEnv,
  extra: Readonly<Record<string, string>>,
  ipc: Readonly<Record<string, string>>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of WORKER_ENV_ALLOW) {
    const value = parent[name];
    if (value !== undefined && value !== "") env[name] = value;
  }
  for (const [name, value] of Object.entries(extra))
    if (!name.startsWith("QCR_IPC_")) env[name] = value;
  Object.assign(env, ipc);
  for (const name of GITHUB_TOKEN_ENVS) delete env[name];
  return env;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class WorkerLaunchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerLaunchError";
  }
}

/** What the observer is told: the supervisor's view of one worker event. */
export interface WorkerObservation {
  kind: IpcEventKind;
  command_id: string;
  pr: number;
  session: string;
  mode: WorkerMode;
  generation: number;
  body: unknown;
}

export interface WorkerSupervisorDeps {
  store: StateStore;
  /** The same store the IpcServer verifies against. */
  capabilities: CapabilityStore;
  /** `<state>/run`: the socket, the capability files and the leases live under it. */
  runDir: string;
  socketPath: string;
  /** `dist/src/botworker.js`. */
  workerMain: string;
  /** Where a worker's own stdout and stderr go: `<id>.log` (`state/workers/`),
   * rotated by size at each spawn and pruned by age and count (src/workerlog.ts). */
  logDir: string;
  logLimits?: Partial<WorkerLogLimits>;
  /** The crash-loop breaker's thresholds (src/workerbreaker.ts). */
  breaker?: Partial<BreakerLimits>;
  /** Where a submitted command's payload is saved. */
  payloadDir: string;
  /** The command's spec: the daemon's layout, the model, the session's env. */
  buildSpec: (row: SessionCommandRow, mode: WorkerMode) => WorkerSpec;
  /** The daemon's env, of which only WORKER_ENV_ALLOW is passed on. */
  parentEnv?: NodeJS.ProcessEnv;
  /** Daemon-chosen additions to every worker's env. */
  extraEnv?: Readonly<Record<string, string>>;
  nodeBin?: string;
  limits?: Partial<WorkerLimits>;
  /** What a command's IPC calls are told beyond its row: `may_post` and a
   * takeover/debug lease (P8.13, P8.17). Omitted: no post rights, no lease. */
  facts?: (row: SessionCommandRow) => Partial<Pick<CommandState, "may_post" | "lease">>;
  /** The daemon's post ops (P8.7): `post.review`, `post.approval` and `post.reply`,
   * run through the one gate for a host's post shims. Omitted: the daemon does not
   * know the ops, and a shim's post is refused. */
  post?: PostOpsDeps;
  /** Held wakes (P8.6). Omitted: the worker is told the daemon does not know the op. */
  wakes?: {
    take(ctx: RequestContext): WakeBatch[];
    ack(ctx: RequestContext, id: string): void;
  };
  /** The central lens permit broker (D25). Given: its two ops ride `ops()`, its
   * permits return when a worker's capability is revoked (the worker exited) or
   * its command goes stale, and `start`/`stop` run and end its reaper. */
  permits?: PermitBroker;
  /** The refresher's hold while a login rewrites auth.json (P8.22): a spawn waits. */
  loginGate?: { paused(): boolean; whenResumed(timeoutMs: number): Promise<boolean> };
  loginWaitMs?: number;
  /** Told of every worker event after the supervisor has acted on it. */
  observe?: (o: WorkerObservation) => void;
  spawn?: typeof nodeSpawn;
  proc?: ProcView;
  signal?: SignalFn;
  now?: () => number;
  log?: (msg: string, extra?: unknown) => void;
}

interface LiveWorker {
  row: SessionCommandRow;
  spec: WorkerSpec;
  mode: WorkerMode;
  token: string;
  generation: number;
  child: ChildProcess;
  lease: WorkerLease;
  spawnedAt: number;
  wallDeadline: number;
  staleMs: number;
  lastSeen: number;
  readyAt: number | undefined;
  acceptedAt: number | undefined;
  sessionId: string | undefined;
  verdictWritten: boolean;
  posted: number;
  failedReason: string | undefined;
  spawnError: string | undefined;
  killedFor: KillReason | undefined;
  killTimer: NodeJS.Timeout | undefined;
  settled: boolean;
  /** Resolves when the worker's row has been dealt with. */
  done: Promise<void>;
  finish: () => void;
}

export interface LaunchInfo {
  command_id: string;
  session: string;
  pid: number;
  generation: number;
}

export interface RecoverResult {
  /** Sessions whose lease named a group that was signalled. */
  killed: string[];
  /** Leases that named nothing of ours (another boot or container, a reused pid,
   * a dead leader): nothing was signalled. */
  stale: string[];
  requeued: string[];
  failed: string[];
}

export interface WorkerStatus {
  command_id: string;
  pr: number;
  session: string;
  mode: WorkerMode;
  pid: number;
  generation: number;
  stage: "starting" | "ready" | "running";
  age_ms: number;
  silent_ms: number;
  ending: KillReason | null;
}

export class WorkerSupervisor {
  readonly limits: WorkerLimits;
  readonly leases: WorkerLeases;
  /** The crash-loop breaker: also the question every host asks before a spawn. */
  readonly breaker: WorkerBreaker;
  private readonly byCommand = new Map<string, LiveWorker>();
  private readonly bySession = new Map<string, LiveWorker>();
  /** Sessions with a launch under way: the second spawn is refused before any await. */
  private readonly launching = new Set<string>();
  private readonly spawnFn: typeof nodeSpawn;
  private readonly proc: ProcView;
  private readonly signal: SignalFn;
  private readonly now: () => number;
  private readonly log: (msg: string, extra?: unknown) => void;
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;

  constructor(private readonly deps: WorkerSupervisorDeps) {
    this.limits = { ...DEFAULT_WORKER_LIMITS, ...deps.limits };
    this.leases = new WorkerLeases(join(deps.runDir, "workers"));
    this.spawnFn = deps.spawn ?? nodeSpawn;
    this.proc = deps.proc ?? realProc;
    this.signal = deps.signal ?? sendSignal;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((): void => {});
    this.breaker = new WorkerBreaker(deps.store, {
      ...(deps.breaker ? { limits: deps.breaker } : {}),
      now: this.now,
      log: this.log,
    });
    deps.permits?.attach(deps.capabilities);
  }

  // ---- what the IPC server asks the daemon ---------------------------------

  /** The server's view of a command, read fresh for every request. `active` is
   * true only while THIS supervisor holds a live worker for the row, so a worker
   * that outlived its row (or its supervisor) is refused as inactive; the
   * generation is the live worker's, so an earlier one is refused as stale. */
  readonly lookup: CommandLookup = (commandId) => {
    const row = this.deps.store.getSessionCommand(commandId);
    if (!row) return null;
    const rec = this.byCommand.get(commandId);
    const live =
      rec !== undefined &&
      !rec.settled &&
      row.status === "running" &&
      row.owner_token === rec.token;
    const facts = this.deps.facts?.(row) ?? {};
    const state: CommandState = {
      pr: row.pr,
      generation: rec?.generation ?? row.attempt,
      active: live,
      may_post: facts.may_post === true,
      lease: facts.lease ?? "none",
    };
    if (row.kind === "wake") state.answer = true;
    return state;
  };

  /** The ops the daemon serves a worker: its spec, its post ops (P8.7), and (P8.6)
   * its held wakes. */
  ops(): Record<string, OpHandler> {
    const ops: Record<string, OpHandler> = {
      [WORKER_SPEC_OP]: {
        roles: ["worker"],
        handle: (ctx) => {
          const rec = this.byCommand.get(ctx.commandId);
          if (!rec || rec.settled || rec.generation !== ctx.generation)
            throw new IpcError("command_inactive", "no live worker for this command");
          return rec.spec;
        },
      },
    };
    if (this.deps.post) Object.assign(ops, postOps(this.deps.post));
    if (this.deps.permits) Object.assign(ops, permitOps(this.deps.permits));
    const wakes = this.deps.wakes;
    if (wakes) {
      ops[WAKES_TAKE_OP] = {
        roles: ["worker"],
        handle: (ctx) => ({ batches: wakes.take(ctx) }),
      };
      ops[WAKES_ACK_OP] = {
        roles: ["worker"],
        handle: (ctx, body) => {
          const id = (body as { id?: unknown } | null)?.id;
          if (typeof id !== "string" || id === "")
            throw new IpcError("bad_request", "wakes.ack: `id` must be a string");
          wakes.ack(ctx, id);
          return {};
        },
      };
    }
    return ops;
  }

  /** The worker's events. Any event is a sign of life; `accepted` is the row's
   * start; the rest is kept for the exit and handed to the observer. */
  readonly onEvent: EventHandler = (ctx, kind, body) => {
    const rec = this.byCommand.get(ctx.commandId);
    if (!rec || rec.settled || rec.generation !== ctx.generation) return;
    const t = this.now();
    rec.lastSeen = t;
    const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    switch (kind) {
      case "ready":
        rec.readyAt = t;
        if (typeof b["session_id"] === "string") rec.sessionId = b["session_id"];
        break;
      case "accepted":
        if (rec.acceptedAt === undefined) {
          rec.acceptedAt = t;
          this.deps.store.markSessionCommandStarted(
            rec.row.id,
            rec.token,
            this.iso(this.hardDeadline(rec)),
          );
        }
        break;
      case "verdict_written":
        rec.verdictWritten = true;
        break;
      case "posted":
        rec.posted++;
        break;
      case "failed":
        if (typeof b["reason"] === "string") rec.failedReason = b["reason"].slice(0, 500);
        break;
      default:
        break;
    }
    try {
      this.deps.observe?.({
        kind,
        command_id: rec.row.id,
        pr: rec.row.pr,
        session: rec.row.session,
        mode: rec.mode,
        generation: rec.generation,
        body,
      });
    } catch (e) {
      this.log(`worker observer failed: ${String(e)}`);
    }
  };

  // ---- the single writer of session_commands -------------------------------

  /** Create a worker-hosted command: the saved payload and its row. The inject
   * path is a name only (`worker:<id>`): no bridge reads it. Refused while the
   * session has work owed, and for a round that is no longer running. */
  submit(input: {
    pr: number;
    kind: Exclude<SessionCommandKind, "legacy">;
    round_no: number | null;
    payload: string;
  }): SessionCommandRow {
    const { store } = this.deps;
    const session = `pr-${input.pr}`;
    const blocking = store.blockingSessionCommand(session);
    if (blocking) throw new Error(`session command ${blocking.id} is ${blocking.status}`);
    if (input.kind === "round" && input.round_no !== null) {
      const status = store.roundStatus(input.pr, input.round_no);
      if (status !== undefined && status !== "running")
        throw new Error(
          `round ${input.round_no} of #${input.pr} is ${status}; not submitting its order`,
        );
    }
    const id = randomUUID();
    const payload = input.payload.endsWith("\n") ? input.payload : `${input.payload}\n`;
    const payloadPath = join(this.deps.payloadDir, `${id}.md`);
    mkdirSync(dirname(payloadPath), { recursive: true });
    const tmp = `${payloadPath}.tmp-${process.pid}`;
    writeFileSync(tmp, payload);
    renameSync(tmp, payloadPath);
    return store.createSessionCommand({
      id,
      pr: input.pr,
      session,
      kind: input.kind,
      round_no: input.round_no,
      payload_sha256: createHash("sha256").update(payload).digest("hex"),
      payload_path: payloadPath,
      inject_path: `worker:${id}`,
      next_check_at: this.iso(this.now() + this.limits.readyMs),
    });
  }

  /** Start a worker for a pending command. Refused (a `WorkerLaunchError`) when
   * the session already has a worker, a lease held by a live process, or a login
   * rewrite that does not end; the row is left as it was. */
  async launch(commandId: string): Promise<LaunchInfo> {
    if (this.stopping) throw new WorkerLaunchError("the supervisor is stopping");
    const first = this.deps.store.getSessionCommand(commandId);
    if (!first) throw new WorkerLaunchError(`no such command: ${commandId}`);
    const session = first.session;
    this.mayStart(first);
    if (this.bySession.has(session) || this.launching.has(session))
      throw new WorkerLaunchError(`${session} already has a worker`);
    this.launching.add(session);
    try {
      return await this.launchHeld(commandId, session);
    } finally {
      this.launching.delete(session);
    }
  }

  /** Launch every pending command whose session has no worker, oldest first. */
  async launchPending(): Promise<LaunchInfo[]> {
    const out: LaunchInfo[] = [];
    for (const row of this.deps.store.activeSessionCommands()) {
      if (row.status !== "pending" || row.kind === "legacy") continue;
      if (this.bySession.has(row.session) || this.launching.has(row.session)) continue;
      // A drained bot or a parked PR starts nothing; the command waits, and the
      // refusal is not logged every pass.
      if (!this.breaker.gate(row.pr).ok) continue;
      try {
        out.push(await this.launch(row.id));
      } catch (e) {
        this.log(`worker launch for ${row.id} failed: ${String(e)}`);
        this.deps.store.logEvent("worker_launch_refused", row.pr, {
          command_id: row.id,
          error: String(e).slice(0, 300),
        });
      }
    }
    return out;
  }

  /** The breaker's no: a drained bot or a parked PR starts no worker (round or
   * answer; the debug round asks `breaker.gate` itself). The row is left as it was. */
  private mayStart(row: SessionCommandRow): void {
    const verdict = this.breaker.gate(row.pr);
    if (!verdict.ok) throw new WorkerLaunchError(verdict.reason);
  }

  private async launchHeld(commandId: string, session: string): Promise<LaunchInfo> {
    const { store, capabilities } = this.deps;
    const gate = this.deps.loginGate;
    if (gate?.paused() && !(await gate.whenResumed(this.deps.loginWaitMs ?? 30_000)))
      throw new WorkerLaunchError("a login holds the refresher paused: not starting a worker");
    if (this.stopping) throw new WorkerLaunchError("the supervisor is stopping");
    const row = store.getSessionCommand(commandId);
    if (!row || row.status !== "pending" || row.kind === "legacy")
      throw new WorkerLaunchError(`command ${commandId} is not a pending worker command`);
    this.mayStart(row); // a login wait or a failing neighbour may have drained the bot meanwhile

    // A lease still held by a live worker of ours (another daemon, a worker the
    // boot could not kill) refuses the spawn; one that names nothing is cleared.
    const held = this.leases.read(session);
    if (held !== undefined) {
      const verdict = held === null ? ({ kind: "dead" } as const) : judgeLease(held, this.proc);
      if (verdict.kind === "group" || verdict.kind === "members")
        throw new WorkerLaunchError(`${session} has a live worker (lease of ${held?.command_id})`);
      this.leases.forget(session);
    }

    const mode: WorkerMode = row.kind === "wake" ? "answer" : "round";
    const spec = this.checkedSpec(row, mode);
    const payload = verifiedPayload(row, "the command's payload");
    if (!payload.ok) {
      store.failPendingSessionCommand(row.id, payload.why);
      throw new WorkerLaunchError(payload.why);
    }

    const token = WorkerLeases.newToken();
    const t0 = this.now();
    const hardDeadline =
      t0 + spec.wall_clock_ms + this.limits.wallGraceMs + this.limits.killGraceMs;
    const claimed = store.claimSessionCommand(row.id, token, this.iso(hardDeadline));
    if (!claimed) throw new WorkerLaunchError(`command ${commandId} was claimed by another`);
    const generation = claimed.attempt;

    const lease: WorkerLease = {
      v: 1,
      owner_token: token,
      command_id: row.id,
      session,
      pr: row.pr,
      generation,
      pid: null,
      pgid: null,
      start_time: null,
      boot_id: this.proc.bootId(),
      command: `botworker --command ${row.id} --mode ${mode}`,
      created_at: new Date(t0).toISOString(),
    };
    let capFd = -1;
    let logFd = -1;
    let leased = false;
    let child: ChildProcess | undefined;
    try {
      this.leases.create(lease);
      leased = true;
      const capability = capabilities.mint(row.id);
      capFd = createCapabilityFd(this.deps.runDir, capability);
      mkdirSync(this.deps.logDir, { recursive: true });
      rotateWorkerLogs(this.deps.logDir, row.id, t0, { ...DEFAULT_WORKER_LOG_LIMITS, ...this.deps.logLimits });
      logFd = openSync(workerLogPath(this.deps.logDir, row.id), "a", 0o600);
      const env = workerProcessEnv(
        this.deps.parentEnv ?? process.env,
        this.deps.extraEnv ?? {},
        ipcEnv({ socketPath: this.deps.socketPath, commandId: row.id, generation }),
      );
      child = this.spawnFn(
        this.deps.nodeBin ?? process.execPath,
        [this.deps.workerMain, "--command", row.id, "--mode", mode],
        {
          cwd: spec.root,
          env,
          detached: true,
          stdio: stdioWithCapability(["ignore", logFd, logFd], capFd) as never,
        },
      );
    } catch (e) {
      this.abandon(row.id, token, session, leased, `could not start the worker: ${String(e)}`);
      throw new WorkerLaunchError(`could not start the worker: ${String(e)}`);
    } finally {
      if (capFd >= 0) closeSync(capFd); // the child holds its own copy
      if (logFd >= 0) closeSync(logFd);
    }

    const pid = child.pid;
    const identity = pid === undefined ? undefined : this.proc.identity(pid);
    if (pid !== undefined)
      this.leases.update(session, token, {
        pid,
        pgid: identity?.pgid ?? pid,
        start_time: identity?.start ?? null,
      });
    let finish = (): void => {};
    const done = new Promise<void>((resolve) => (finish = resolve));
    const rec: LiveWorker = {
      row: claimed,
      spec,
      mode,
      token,
      generation,
      child,
      lease: { ...lease, pid: pid ?? null, pgid: pid ?? null, start_time: identity?.start ?? null },
      spawnedAt: t0,
      wallDeadline: t0 + spec.wall_clock_ms + this.limits.wallGraceMs,
      staleMs: staleAfterMs(spec.heartbeat_ms ?? this.limits.heartbeatMs, this.limits),
      lastSeen: t0,
      readyAt: undefined,
      acceptedAt: undefined,
      sessionId: undefined,
      verdictWritten: false,
      posted: 0,
      failedReason: undefined,
      spawnError: undefined,
      killedFor: undefined,
      killTimer: undefined,
      settled: false,
      done,
      finish,
    };
    this.byCommand.set(row.id, rec);
    this.bySession.set(session, rec);
    child.once("exit", (code, signal) => void this.settle(rec, code, signal));
    child.once("error", (e) => {
      if (pid === undefined) {
        rec.spawnError = e.message;
        void this.settle(rec, null, null);
      } else this.log(`worker ${row.id}: ${e.message}`);
    });
    store.logEvent("worker_spawned", row.pr, {
      command_id: row.id,
      mode,
      generation,
      pid: pid ?? null,
    });
    return { command_id: row.id, session, pid: pid ?? -1, generation };
  }

  /** The spec as the worker will read it: from the builder, checked against the
   * row (a spec for another command, PR or payload is a bug, not a request), with
   * no GitHub credential, no IPC name, and the beat interval filled in. */
  private checkedSpec(row: SessionCommandRow, mode: WorkerMode): WorkerSpec {
    const built = this.deps.buildSpec(row, mode);
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(built.env)) {
      if (name.startsWith("QCR_IPC_"))
        throw new WorkerLaunchError(
          `the spec's env names ${name}: the IPC names are the supervisor's`,
        );
      if (!(GITHUB_TOKEN_ENVS as readonly string[]).includes(name)) env[name] = value;
    }
    const spec = parseWorkerSpec(
      JSON.parse(
        JSON.stringify({
          ...built,
          env,
          heartbeat_ms: built.heartbeat_ms ?? this.limits.heartbeatMs,
        }),
      ),
    );
    if (
      spec.command_id !== row.id ||
      spec.pr !== row.pr ||
      spec.session !== row.session ||
      spec.mode !== mode ||
      spec.payload_path !== row.payload_path ||
      spec.payload_sha256 !== row.payload_sha256
    )
      throw new WorkerLaunchError("the spec is not for this command");
    return spec;
  }

  /** Undo a launch that never produced a process. */
  private abandon(id: string, token: string, session: string, leased: boolean, why: string): void {
    this.deps.capabilities.revoke(id);
    if (leased) this.leases.remove(session, token);
    this.deps.store.finishSessionCommand(id, token, "failed", why);
  }

  // ---- watching ------------------------------------------------------------

  /** Begin the periodic `tick`. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.limits.tickMs);
    this.timer.unref();
    this.deps.permits?.start(this.lookup);
  }

  /** One pass of the deadlines. Pure of I/O but for the signals it sends. */
  tick(): void {
    const t = this.now();
    for (const rec of [...this.byCommand.values()]) {
      if (rec.settled || rec.killedFor !== undefined) continue;
      if (t >= rec.wallDeadline) this.end(rec, "wall_clock");
      else if (rec.readyAt === undefined) {
        if (t - rec.spawnedAt > this.limits.readyMs) this.end(rec, "stage_ready");
      } else if (rec.acceptedAt === undefined && t - rec.readyAt > this.limits.acceptMs)
        this.end(rec, "stage_accept");
      else if (t - rec.lastSeen > rec.staleMs) this.end(rec, "heartbeat_lost");
    }
  }

  /** End one worker's group (TERM, then KILL after the grace). The row follows
   * the exit: an operator's end fails it, a lost worker requeues it. */
  kill(commandId: string, why: KillReason = "operator"): boolean {
    const rec = this.byCommand.get(commandId);
    if (!rec || rec.settled) return false;
    this.end(rec, why);
    return true;
  }

  private end(rec: LiveWorker, why: KillReason): void {
    if (rec.settled || rec.killedFor !== undefined) return;
    rec.killedFor = why;
    this.log(`ending worker ${rec.row.id} (${why})`);
    this.deps.store.logEvent("worker_ending", rec.row.pr, { command_id: rec.row.id, why });
    this.signalGroup(rec, "SIGTERM");
    rec.killTimer = setTimeout(() => {
      if (!rec.settled) this.signalGroup(rec, "SIGKILL");
    }, this.limits.killGraceMs);
    rec.killTimer.unref();
  }

  /** Signal the live child's group. Safe by construction: the child has not been
   * reaped, so its pid cannot belong to anyone else. */
  private signalGroup(rec: LiveWorker, sig: NodeJS.Signals): void {
    const pid = rec.child.pid;
    if (pid === undefined) return;
    if (this.signal(-pid, sig) === "denied")
      this.log(`worker ${rec.row.id}: ${sig} to the group was refused`);
  }

  private async settle(
    rec: LiveWorker,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    if (rec.settled) return;
    rec.settled = true;
    if (rec.killTimer) clearTimeout(rec.killTimer);
    const { store } = this.deps;
    try {
      // The leader is gone; whatever it left in its group goes with it.
      const leftovers = await killLease(rec.lease, {
        proc: this.proc,
        signal: this.signal,
        graceMs: 0,
        pollMs: 10,
      });
      if (leftovers.verdict === "members")
        this.log(`worker ${rec.row.id}: left members in its group; ended`);
      if (leftovers.survivors) this.log(`worker ${rec.row.id}: group members survived the kill`);
      this.deps.capabilities.revoke(rec.row.id);
      const outcome = decideOutcome({
        code,
        signal,
        killedFor: rec.killedFor,
        failedReason: rec.failedReason,
        spawnError: rec.spawnError,
      });
      this.apply(rec, outcome);
      store.logEvent("worker_exited", rec.row.pr, {
        command_id: rec.row.id,
        generation: rec.generation,
        code,
        signal,
        outcome: outcome.kind,
        ...(outcome.kind === "acked" || outcome.kind === "leave" ? {} : { reason: outcome.reason }),
        verdict_written: rec.verdictWritten,
        posted: rec.posted,
      });
      this.count(rec, outcome, code);
    } catch (e) {
      this.log(`settling worker ${rec.row.id} failed: ${String(e)}`);
    } finally {
      this.leases.remove(rec.row.session, rec.token);
      this.byCommand.delete(rec.row.id);
      if (this.bySession.get(rec.row.session) === rec) this.bySession.delete(rec.row.session);
      rec.finish();
    }
  }

  /** Tell the breaker how the worker ended. A served round is a success; a
   * non-zero exit, a `failed` event or a deadline kill is a failure; the daemon's
   * own stop, the operator's end and a recovery fence are neither. A PR parked by this failure has
   * no round to retry, so a requeue it just got is failed instead. */
  private count(rec: LiveWorker, outcome: Outcome, code: number | null): void {
    const { pr } = rec.row;
    // A fenced worker was ended by the caller, who owns the row's fate: not a worker failure.
    if (rec.killedFor === "shutdown" || rec.killedFor === "operator" || outcome.kind === "leave") return;
    if (outcome.kind === "acked" && rec.failedReason === undefined) {
      this.breaker.success(pr);
      return;
    }
    const error =
      rec.failedReason ??
      (outcome.kind === "acked"
        ? `the worker reported a failure and exited ${code}`
        : outcome.reason);
    const res = this.breaker.failure(pr, rec.row.id, error);
    if (res.parked && outcome.kind === "requeue")
      this.deps.store.failPendingSessionCommand(
        rec.row.id,
        `PR #${pr} is parked after ${res.failures} consecutive worker failures: ${error}`.slice(0, 500),
      );
  }

  private apply(rec: LiveWorker, outcome: Outcome): void {
    const { store } = this.deps;
    const id = rec.row.id;
    if (outcome.kind === "leave") return;
    if (outcome.kind === "acked") {
      // An exit 0 is the round served, whether or not `accepted` got through.
      store.markSessionCommandStarted(id, rec.token, this.iso(this.now()));
      store.finishSessionCommand(id, rec.token, "acked");
    } else if (outcome.kind === "failed") {
      store.finishSessionCommand(id, rec.token, "failed", outcome.reason);
    } else {
      this.requeueOrFail(id, rec.token, outcome.reason);
    }
  }

  /** Hand the command to a fresh worker, or fail it once the requeues are spent
   * (or its round has ended meanwhile). */
  private requeueOrFail(id: string, token: string | null, reason: string): boolean {
    const { store } = this.deps;
    const row = store.getSessionCommand(id);
    if (!row || row.status !== "running") return false;
    if (row.recovery_attempts >= this.limits.maxRequeues) {
      this.failRow(row, token, `${reason}; requeued ${row.recovery_attempts} times already`);
      return false;
    }
    if (store.requeueWorkerCommand(id, token, this.iso(this.now()))) return true;
    this.failRow(row, token, `${reason}; its round is no longer running`);
    return false;
  }

  private failRow(row: SessionCommandRow, token: string | null, why: string): void {
    const { store } = this.deps;
    if (token !== null) store.finishSessionCommand(row.id, token, "failed", why);
    else store.failActiveSessionCommand(row.id, why);
  }

  // ---- restart -------------------------------------------------------------

  /**
   * The daemon's boot (D23): no worker of a previous daemon is wanted. Every
   * leased group is killed (only when the leader still has the lease's start time
   * in the lease's boot/container), the leases are removed, and every command a
   * dead worker held is handed back to `pending` under its own id, so the fresh
   * worker resumes the JSONL and continues. A command whose group could not be
   * ended is failed, not requeued: two workers must never serve one session.
   * Run before any `launch`.
   */
  async recover(): Promise<RecoverResult> {
    const result: RecoverResult = { killed: [], stale: [], requeued: [], failed: [] };
    const unkillable = new Set<string>();
    const entries = this.leases.list();
    await Promise.all(
      entries.map(async ({ session, lease }) => {
        if (lease === null) {
          this.leases.forget(session);
          result.stale.push(session);
          return;
        }
        const out = await killLease(lease, {
          proc: this.proc,
          signal: this.signal,
          graceMs: this.limits.killGraceMs,
        });
        if (out.verdict === "group" || out.verdict === "members") result.killed.push(session);
        else result.stale.push(session);
        if (out.survivors) unkillable.add(lease.command_id);
        else this.leases.forget(session);
        this.deps.store.logEvent("worker_lease_recovered", lease.pr, {
          command_id: lease.command_id,
          verdict: out.verdict,
          killed: out.killed,
          denied: out.denied,
          survivors: out.survivors,
        });
      }),
    );
    for (const row of this.deps.store.activeSessionCommands()) {
      if (row.status !== "running" || this.byCommand.has(row.id)) continue;
      if (unkillable.has(row.id)) {
        this.deps.store.failActiveSessionCommand(
          row.id,
          "the previous worker's group could not be ended",
        );
        result.failed.push(row.id);
      } else if (this.requeueOrFail(row.id, null, "the daemon restarted"))
        result.requeued.push(row.id);
      else result.failed.push(row.id);
    }
    return result;
  }

  /** The daemon is going down: end every worker; their commands requeue. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.deps.permits?.stop();
    const live = [...this.byCommand.values()];
    for (const rec of live) this.end(rec, "shutdown");
    await Promise.all(live.map((rec) => rec.done));
  }

  // ---- the session host's questions (P8.6) -----------------------------------

  /**
   * Does a worker of this session run? Ours (a live child, or a launch under way),
   * or one a lease file still names that the process table confirms. The host's
   * liveness answer: a lease alone never says "alive", since pids repeat.
   */
  runs(session: string): boolean {
    if (this.bySession.has(session) || this.launching.has(session)) return true;
    const held = this.leases.read(session);
    if (!held) return false;
    const verdict = judgeLease(held, this.proc);
    return verdict.kind === "group" || verdict.kind === "members";
  }

  /**
   * End the session's worker and answer only once it is proven gone: true when no
   * worker of the session runs (it had none, or its exit has been reaped), false
   * when it outlived `fenceWaitMs`. The command's row is left as it is (`fence`):
   * the caller fenced the session to decide the row itself. A launch that is
   * still under way is waited out first, so a worker cannot start behind the fence.
   */
  async fence(session: string): Promise<boolean> {
    // Real time, not the injected clock: this waits on processes.
    const end = Date.now() + this.limits.fenceWaitMs;
    while (this.launching.has(session) && Date.now() < end) await sleep(5);
    const rec = this.bySession.get(session);
    if (rec) {
      this.end(rec, "fence");
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        rec.done,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, Math.max(0, end - Date.now()));
          timer.unref();
        }),
      ]);
      clearTimeout(timer);
    }
    return !this.runs(session);
  }

  /**
   * Hand a command whose worker has been fenced and is gone back to `pending`
   * under the same id, for a fresh worker (`launch`) to resume. The CAS is on the
   * attempt the caller read, so a row that moved since is not replayed.
   */
  replay(commandId: string, expectedAttempt: number): boolean {
    return this.deps.store.retrySessionCommandAfterFence(
      commandId,
      expectedAttempt,
      this.iso(this.now() + this.limits.readyMs),
    );
  }

  // ---- views ---------------------------------------------------------------

  isLive(session: string): boolean {
    return this.bySession.has(session);
  }

  workers(): WorkerStatus[] {
    const t = this.now();
    return [...this.byCommand.values()].map((rec) => ({
      command_id: rec.row.id,
      pr: rec.row.pr,
      session: rec.row.session,
      mode: rec.mode,
      pid: rec.child.pid ?? -1,
      generation: rec.generation,
      stage:
        rec.readyAt === undefined ? "starting" : rec.acceptedAt === undefined ? "ready" : "running",
      age_ms: t - rec.spawnedAt,
      silent_ms: t - rec.lastSeen,
      ending: rec.killedFor ?? null,
    }));
  }

  private hardDeadline(rec: LiveWorker): number {
    return rec.wallDeadline + this.limits.killGraceMs;
  }

  private iso(ms: number): string {
    return new Date(ms).toISOString();
  }
}

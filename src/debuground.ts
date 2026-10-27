// The bot's debug round: a PR's next round runs inside interactive pi.
//
// `debug-round <pr>` (owner and companion tier) takes the PR's host lease in debug
// mode. The lease does not start a pi by itself: it is ARMED for the PR's next round.
// When that round's order is handed over (src/worker-session-host.ts `start`, or the
// sweep, for an order already waiting), the manager delivers it to a pi in tmux
// `debug-pr-<n>` instead of a worker:
//
//   - THE SESSION. The pi runs `--session` on the PR's own JSONL (write, not fork; a
//     PR with none gets one born in its session dir), so the round's history is the
//     one the next worker resumes. The round order is the pi's first message, behind
//     the same marker a worker's order carries (packages/pi-plugin/src/session-command.ts), so a worker
//     that takes the round over continues instead of sending the order again.
//   - THE ROUND IS THE COMMAND'S. The manager claims the round's own session_commands
//     row for the lease (the row's owner token is the lease's token), so the round
//     has one command id, one generation, one capability, and posts like any round:
//     its post shims (`post-review.sh` and the others) send the IPC request with
//     the command's capability and the daemon runs the one MutationGate with the
//     install's dry_run. Nothing here posts, and nothing here can.
//   - THE CAPABILITY reaches the pi through the launch file: the launcher in the
//     pane claims and unlinks it, and the pane's entry (src/debugroundpi.ts) hands the
//     fd to pi, whose bash tool (extensions/debug-round.ts) hands it to each command.
//   - ITS LOGIN is a refresh-blanked COPY, made by the pane's own entry.
//   - END. The round ends with the verdict commit: once the verdict file is there and
//     the pane has been quiet a few seconds, the pi is stopped. It also ends when the
//     operator releases it, when the pi exits, after 30 minutes without activity, and
//     with the daemon (`recover`). Ending BUMPS THE GENERATION the lookup reports and
//     REVOKES the capability, so a late post is refused. The pi is killed (the tmux
//     session, then its process group, TERM then KILL) and CONFIRMED gone before the
//     lease is freed, and the lease is what keeps every worker out (`hostGate`), so
//     two writers never append to the JSONL. Then the round's command is settled: acked
//     when the verdict was committed, otherwise handed back to `pending` for a worker,
//     which resumes the JSONL under its id and continues. The NEXT round
//     goes back to a worker, because the lease is gone.
//   - REFUSALS. Under a drain (reason `drained`) and for a parked PR no debug round is
//     granted, and one armed before the drain starts nothing until it lifts: the debug
//     round is a worker that can post, so it asks the same breaker gate every worker
//     asks. A takeover (src/takeover.ts) never posts, and stays available.
//
// Neutral by design (node builtins, the state store, the ipc capability module and
// src/workerlease.ts): the daemon imports it without reaching src/engine/. The
// pane's side (src/debugroundpi.ts) is the part that touches the login and pi.
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { FINDING_CLUSTERS_ENTRY, extensionFile } from "./coreext.js";
import { GITHUB_TOKEN_ENVS } from "@quickchatai/pi-quickreview/src/envstrip.js";
import {
  type CapabilityStore,
  type LaunchFiles,
  ensurePrivateDir,
  toolUidSplit,
  ipcEnv,
} from "./ipc/capability.js";
import type { CommandLookup } from "./ipc/protocol.js";
import { lensDirOf, roundPassesDir, type WorkerSpec } from "./ipc/workerspec.js";
import { sessionCommandMarker } from "@quickchatai/pi-quickreview/src/session-command.js";
import { findReviewerStub } from "@quickchatai/pi-quickreview/src/reviewerstub.js";
import { verifiedPayload } from "./session-command-payload.js";
import type { HostLeaseRow, SessionCommandRow, StateStore } from "./state.js";
import { killHostPane } from "./takeover.js";
import type { Tmux } from "./tmux.js";
import {
  WorkerLeases,
  judgeLease,
  leaseStillRuns,
  realProc,
  sendSignal,
  type ProcView,
  type SignalFn,
  type WorkerLease,
} from "./workerlease.js";

/** How long a debug round may sit without activity before the daemon ends it. */
export const DEBUG_IDLE_MS = 30 * 60_000;

/** How long the pane must be quiet after the verdict commit before the pi is
 * stopped: the model's closing words are written to the JSONL first. */
export const DEBUG_VERDICT_SETTLE_MS = 15_000;

/** The extensions of a bot debug round: a worker's own set
 * (src/engine/botsdk.ts), with the debug extension (which carries the lens
 * tools) in the lens slot. The shims are paths under the production tree;
 * cluster_findings is the core package's (`extensionFile`, src/coreext.ts). */
export const DEBUG_BOT_EXTENSIONS = [
  "extensions/cli/bash-guard.ts",
  "extensions/cli/ledger-pin.ts",
  "extensions/cli/debug-round.ts",
  FINDING_CLUSTERS_ENTRY,
  "extensions/vendor/openviking-pi/index.ts",
] as const;

/** The file the debug-round extension keeps its progress in, inside the borrowed
 * agent dir (extensions/debug-round.ts reads QCR_DEBUG_STATUS_FILE). */
export const DEBUG_STATUS_NAME = "debug-round.json";

export const debugSession = (pr: number): string => `debug-pr-${pr}`;

/** The lease's own id, before any round is delivered. It never holds a capability. */
export const debugLeaseCommandId = (token: string): string => `debug-${token}`;

/** What the pane's entry (src/debugroundpi.ts) is started on. Plain data, no secret:
 * it is written to a 0600 file the entry reads and removes. */
export interface DebugRoundSpec {
  v: 1;
  pr: number;
  /** The tmux session: `debug-pr-<n>`. */
  session: string;
  /** The round's command: the one whose capability the launcher claims. */
  command_id: string;
  round_no: number | null;
  /** The production tree (`QCR_SANDBOX_ROOT`) and the pi's cwd (the same: bash-guard
   * recognises the sanctioned scripts there). */
  root: string;
  cwd: string;
  /** The login's owner dir: read-only, borrowed from. */
  agent_dir: string;
  /** The login's dir when it is not `agent_dir` (the worker spec's). */
  login_dir?: string;
  /** Where the pi's own agent dir (the blanked login copy) is made. */
  borrow_dir: string;
  /** The window the borrowed login must outlast. */
  idle_ms: number;
  /** The PR's JSONL, appended to; absent for a PR with none (pi births one in `session_dir`). */
  session_file?: string;
  session_dir: string;
  model: string;
  system_prompt_file: string;
  /** The reviewer stub, appended to the system prompt: the cwd's own context
   * files are switched off, never written over. */
  stub_file?: string;
  /** Extensions by absolute path. */
  extensions: string[];
  /** The round's saved order and the sha256 recorded for it at dispatch. */
  payload_path: string;
  payload_sha256: string;
  /** The marker the order carries (marker idempotency, as a worker's). */
  marker: string;
  /** The round's planned wave: its pass dir (the task files are under `tasks/`). */
  planned_wave: boolean;
  passes_dir: string;
  /** Where the round's lens ledger and lens JSONLs go. */
  lens_dir: string;
  /** The model's env: the worker's own, with the IPC names and the debug names. */
  env: Record<string, string>;
  pi_bin?: string;
}

export type DebugResult =
  | { ok: true; session: string; command_id: string; message: string }
  | { ok: false; reason: string; code: DebugRefusal };

export type DebugRefusal =
  | "drained"
  | "parked"
  | "worker"
  | "leased"
  | "unknown_pr"
  | "closed"
  | "no_lease"
  | "pi_alive"
  | "failed";

/** What the breaker's gate answers (src/workerbreaker.ts `gate`). */
export type DebugGate = (
  pr: number,
) => { ok: true } | { ok: false; why: "draining" | "parked"; reason: string };

/** What the manager asks the WorkerSupervisor, the single writer of session_commands
 * rows, to do with the round command it hosts (`claimHosted`, `markHostedStarted` and
 * `settleHosted` of src/workersupervisor.ts). */
export interface HostedCommands {
  claimHosted(
    commandId: string,
    ownerToken: string,
    nextCheckAt: string,
  ): SessionCommandRow | undefined;
  markHostedStarted(commandId: string, ownerToken: string, nextCheckAt: string): boolean;
  settleHosted(
    commandId: string,
    ownerToken: string,
    outcome: { served: true } | { served: false; reason: string },
  ): "acked" | "requeued" | "failed" | "gone";
}

export interface DebugRoundDeps {
  store: StateStore;
  /** The supervisor, for every write to the round's command row. */
  commands: HostedCommands;
  capabilities: CapabilityStore;
  /** The launch files for panes (tmux passes no fd). */
  launchFiles: LaunchFiles;
  /** `<state>/run`: the spec files and the pi's process leases live under it. */
  runDir: string;
  socketPath: string;
  tmux: Pick<
    Tmux,
    "newSession" | "killSession" | "listSessionsKnown" | "panePid" | "lastActivityMs"
  >;
  /** Drain and park: the breaker's gate (`supervisor.breaker.gate`). A debug round
   * is a worker that can post, so it asks what every worker asks. */
  gate: DebugGate;
  /** The round command's spec, as a worker would be given it. */
  buildSpec: (row: SessionCommandRow) => WorkerSpec;
  /** The newest JSONL under a PR's session dir, if it has one. */
  newestSessionFile: (dir: string) => string | undefined;
  /** `dist/src/ipc/launcher.js` and `dist/src/debugroundpi.js`. */
  launcherMain: string;
  debugMain: string;
  nodeBin?: string;
  /** Does a worker run for the PR? null: could not be asked. Omitted: not asked
   * (the lease grant still refuses a PR with a claimed command). */
  workerRuns?: (pr: number) => boolean | null;
  /** Told after a lease was freed, so held wakes and the queue move on, and a round
   * handed back to `pending` gets its worker. */
  afterRelease?: (pr: number) => Promise<void> | void;
  idleMs?: number;
  verdictSettleMs?: number;
  /** How long a TERM gets before the KILL. */
  killGraceMs?: number;
  proc?: ProcView;
  signal?: SignalFn;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string, extra?: unknown) => void;
}

/** What `deliver` came to. */
export type DebugDelivery = { ok: true; session: string } | { ok: false; reason: string };

export interface DebugSweepReport {
  released: number[];
  /** Leases whose pi was still alive after the kill: they stand, `ending`. */
  stuck: number[];
  /** PRs whose waiting round order was delivered to a pi by this pass. */
  delivered: number[];
}

/** A round in a debug pi: what the manager holds in memory beside the lease row. */
interface Running {
  commandId: string;
  roundNo: number | null;
  root: string;
  sessionFile: string | undefined;
  sessionDir: string;
  statusFile: string;
  /** The row's next check while the round is in the pi: past the cap and the idle window. */
  deadline: string;
  startedMarked: boolean;
  verdictAt: number | undefined;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class DebugRoundManager {
  readonly leases: WorkerLeases;
  private readonly idleMs: number;
  private readonly settleMs: number;
  private readonly proc: ProcView;
  private readonly signal: SignalFn;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (msg: string, extra?: unknown) => void;
  /** The rounds in a pi, by PR. */
  private readonly running = new Map<number, Running>();
  /** Commands whose lease ended, with the generation their request would need now:
   * the lookup answers them inactive and a generation ahead, so a request that
   * outlived the revocation is fenced twice. Bounded. */
  private readonly ended = new Map<string, { generation: number; token: string }>();
  /** PRs with a stop under way: the sweep and a release never run two at once. */
  private readonly stopping = new Map<number, Promise<boolean>>();
  /** PRs with a delivery under way: one pi per PR, whoever asks first. */
  private readonly delivering = new Set<number>();
  /** The last undelivered reason logged per PR, so a repeating one logs once. */
  private readonly undelivered = new Map<number, string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: DebugRoundDeps) {
    this.idleMs = deps.idleMs ?? DEBUG_IDLE_MS;
    this.settleMs = deps.verdictSettleMs ?? DEBUG_VERDICT_SETTLE_MS;
    this.proc = deps.proc ?? realProc;
    this.signal = deps.signal ?? sendSignal;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? defaultSleep;
    this.log = deps.log ?? ((): void => {});
    this.leases = new WorkerLeases(join(deps.runDir, "debug"), { searchable: toolUidSplit() });
  }

  private iso(ms = this.now()): string {
    return new Date(ms).toISOString();
  }

  // ---- what the rest of the daemon asks ------------------------------------

  /** Is the PR under a debug lease (armed, or with its round in a pi)? */
  holds(pr: number): boolean {
    return this.deps.store.hostLease(pr)?.kind === "debug";
  }

  /** The PR's host lease kind, for status.json's `runtime`; null for none. */
  leaseOf(pr: number): "debug" | null {
    return this.holds(pr) ? "debug" : null;
  }

  /** Is this command a round order the armed lease should take in a worker's place? */
  claims(command: Pick<SessionCommandRow, "pr" | "kind" | "status">): boolean {
    const row = this.deps.store.hostLease(command.pr);
    return (
      row?.kind === "debug" &&
      row.state === "held" &&
      command.kind === "round" &&
      command.status === "pending" &&
      !this.running.has(command.pr) &&
      !this.delivering.has(command.pr)
    );
  }

  /** The supervisor's gate: why no worker may start for `pr`, or null. The lease row
   * stands until its pi is confirmed gone; a pi the process table still confirms
   * blocks even without a row (a row lost to a restore). */
  hostGate(pr: number): string | null {
    const row = this.deps.store.hostLease(pr);
    if (row?.kind === "debug")
      return `PR #${pr} is under a debug lease (${row.holder}, ${row.state}): no worker starts`;
    const held = this.leases.read(debugSession(pr));
    if (held === undefined) return null;
    const verdict = held === null ? ({ kind: "dead" } as const) : judgeLease(held, this.proc);
    return leaseStillRuns(verdict) ? `a debug pi for PR #${pr} still runs: no worker starts` : null;
  }

  /** The IPC server's view of a debug round's command. Active while its lease is
   * held and its row is the lease's; `lease: "debug"` and `may_post`, because a debug
   * round posts like any round. A command whose lease ended answers inactive
   * with its generation bumped. Anything else is not this manager's: null. */
  readonly lookup: CommandLookup = (commandId) => {
    const gone = this.ended.get(commandId);
    if (gone !== undefined) {
      const row = this.deps.store.getSessionCommand(commandId);
      // The round was handed back to a worker under the same id: that command is the
      // supervisor's again, and this manager no longer speaks for it.
      if (row && !(row.status === "running" && row.owner_token !== gone.token))
        return {
          pr: row.pr,
          generation: gone.generation,
          active: false,
          may_post: true,
          lease: "debug",
        };
    }
    for (const lease of this.deps.store.hostLeases()) {
      if (lease.kind !== "debug") continue;
      const row = this.commandOf(lease);
      if (!row || row.id !== commandId) continue;
      return {
        pr: row.pr,
        generation: row.attempt,
        active:
          lease.state === "held" && row.status === "running" && row.owner_token === lease.token,
        may_post: true,
        lease: "debug",
      };
    }
    return null;
  };

  /** The round command a lease holds: the PR's active command that the lease's token
   * claimed. */
  private commandOf(lease: HostLeaseRow): SessionCommandRow | undefined {
    const row = this.deps.store.activeSessionCommand(`pr-${lease.pr}`);
    return row?.status === "running" && row.owner_token === lease.token ? row : undefined;
  }

  // ---- grant -----------------------------------------------------------------

  /** Take the PR's lease in debug mode: its next round goes to interactive pi. */
  async arm(pr: number, holder = "operator"): Promise<DebugResult> {
    const { store } = this.deps;
    const verdict = this.deps.gate(pr);
    if (!verdict.ok)
      return refuse(
        verdict.why === "draining" ? `drained: ${verdict.reason}` : verdict.reason,
        verdict.why === "draining" ? "drained" : "parked",
      );
    const row = store.getPr(pr);
    if (!row) return refuse(`#${pr} is not a PR this bot tracks`, "unknown_pr");
    if (row.state === "closed") return refuse(`#${pr} is closed: it gets no round`, "closed");
    const runs = this.deps.workerRuns?.(pr);
    if (runs === true)
      return refuse(`a worker runs for PR #${pr}: abort the round or wait for it`, "worker");
    if (runs === null)
      return refuse(`cannot tell whether a worker runs for PR #${pr}: not granting`, "worker");
    const held = store.hostLease(pr);
    if (held)
      return refuse(
        `PR #${pr} is already under a ${held.kind} lease (${held.holder}, ${held.state})`,
        "leased",
      );
    const blocked = this.hostGate(pr);
    if (blocked !== null) return refuse(blocked, "leased");

    const token = WorkerLeases.newToken();
    const commandId = debugLeaseCommandId(token);
    const granted = store.grantHostLease({
      pr,
      kind: "debug",
      token,
      commandId,
      holder,
      at: this.iso(),
    });
    if (!granted.ok) return refuse(granted.reason, granted.why === "worker" ? "worker" : "leased");
    this.log(`debug: #${pr} armed by ${holder}`);
    store.logEvent("debug_round_armed", pr, { holder });

    // A round order already waiting for its worker is the one this lease takes.
    const waiting = store.activeSessionCommand(`pr-${pr}`);
    let delivered: DebugDelivery | undefined;
    if (waiting && this.claims(waiting)) delivered = await this.deliver(waiting);
    const session = debugSession(pr);
    return {
      ok: true,
      session,
      command_id: commandId,
      message: delivered?.ok
        ? `debug round of PR #${pr} started: attach with \`tmux attach -t ${session}\` (the bot container)`
        : `debug round armed for PR #${pr}: its next round runs in interactive pi (tmux ${session})` +
          (delivered && !delivered.ok
            ? `; the waiting order was not delivered yet: ${delivered.reason}`
            : ""),
    };
  }

  // ---- delivery --------------------------------------------------------------

  /**
   * Hand a round order to the armed lease's pi, in a worker's place. The order is the
   * pending command the host just created (or a waiting one): the lease's token claims
   * the row, a capability is minted for its id, and the pane is started on a spec file.
   * Nothing of a failed delivery stays: the pi is stopped, and the row goes back to
   * `pending` (to a worker, once the lease is gone).
   */
  async deliver(command: SessionCommandRow): Promise<DebugDelivery> {
    const { store, tmux } = this.deps;
    const pr = command.pr;
    const lease = store.hostLease(pr);
    if (lease?.kind !== "debug" || lease.state !== "held" || command.kind !== "round")
      return fail("the PR is not armed for a debug round");
    if (this.running.has(pr) || this.delivering.has(pr))
      return fail(`a debug round is already in PR #${pr}'s pi`);
    // A debug round is a worker that can post: a drain that began after the arm, or a
    // park, holds the order until it lifts, as it holds any worker.
    const verdict = this.deps.gate(pr);
    if (!verdict.ok) return fail(verdict.reason);
    const payload = verifiedPayload(command, "the round's saved order");
    if (!payload.ok) return fail(payload.why);

    this.delivering.add(pr);
    const session = debugSession(pr);
    let claimed: SessionCommandRow | undefined;
    let specFile: string | undefined;
    let spec: WorkerSpec;
    let deadline = this.iso();
    try {
      spec = this.checkedSpec(command);
    } catch (e) {
      this.delivering.delete(pr);
      return fail(e instanceof Error ? e.message : String(e));
    }
    try {
      deadline = this.iso(this.now() + spec.wall_clock_ms + this.idleMs);
      claimed = this.deps.commands.claimHosted(command.id, lease.token, deadline);
      if (!claimed) throw new Error(`command ${command.id} was claimed by another`);
      this.leases.create(this.processLease(lease.token, claimed, session));
      this.deps.capabilities.mint(claimed.id);
      const launch = this.deps.launchFiles.create(claimed.id);
      const planned = this.planFor(claimed, spec);
      // The status file is shared by every debug round of the PR: a receipt left by
      // an earlier round must not read as this command's start.
      try {
        unlinkSync(planned.statusFile);
      } catch {
        // none left
      }
      specFile = this.writeSpec(session, planned.spec);
      const node = this.deps.nodeBin ?? process.execPath;
      await tmux.newSession(
        session,
        [node, this.deps.launcherMain, launch.path, "--", node, this.deps.debugMain, specFile],
        { cwd: spec.cwd },
      );
      const pid = await tmux.panePid(session);
      if (pid === undefined) throw new Error("the debug pi did not start (no tmux pane)");
      const identity = this.proc.identity(pid);
      this.leases.update(session, lease.token, {
        pid,
        pgid: identity?.pgid ?? pid,
        start_time: identity?.start ?? null,
      });
      this.running.set(pr, {
        commandId: claimed.id,
        roundNo: claimed.round_no,
        root: spec.root,
        sessionFile: planned.spec.session_file,
        sessionDir: spec.session_dir,
        statusFile: planned.statusFile,
        deadline,
        startedMarked: false,
        verdictAt: undefined,
      });
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      this.deps.capabilities.revoke(command.id);
      const held = store.hostLease(pr);
      if (held && held.token === lease.token) {
        // The pi, if it began, is stopped and confirmed gone before the row is handed
        // back, so a half-started round never leaves a writer behind.
        store.endHostLease(pr, lease.token, this.iso(), `the round could not start: ${why}`);
        const gone = await this.finish(store.hostLease(pr) ?? held, "could not start", "requeue");
        if (!gone) this.log(`debug: #${pr} pi still alive after a failed start; the lease stands`);
      }
      if (claimed)
        this.deps.commands.settleHosted(claimed.id, lease.token, {
          served: false,
          reason: `the debug pi could not start: ${why}`,
        });
      if (specFile) rmQuiet(specFile);
      this.delivering.delete(pr);
      return fail(`debug round of PR #${pr} failed to start: ${why}`);
    }
    this.delivering.delete(pr);
    this.log(`debug: #${pr} round ${claimed.round_no ?? "?"} delivered to ${session}`);
    store.logEvent("debug_round_delivered", pr, {
      command_id: claimed.id,
      round_no: claimed.round_no,
      generation: claimed.attempt,
    });
    return { ok: true, session };
  }

  /** The worker spec a round would be given, checked against the row: no spec for
   * another command, no GitHub token, no IPC name (those are the manager's). */
  private checkedSpec(row: SessionCommandRow): WorkerSpec {
    const built = this.deps.buildSpec(row);
    if (
      built.command_id !== row.id ||
      built.pr !== row.pr ||
      built.session !== row.session ||
      built.payload_path !== row.payload_path ||
      built.payload_sha256 !== row.payload_sha256
    )
      throw new Error("the spec is not for this command");
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(built.env)) {
      if (name.startsWith("QCR_IPC_"))
        throw new Error(`the spec's env names ${name}: the IPC names are the manager's`);
      if (!(GITHUB_TOKEN_ENVS as readonly string[]).includes(name)) env[name] = value;
    }
    return { ...built, env };
  }

  private processLease(token: string, row: SessionCommandRow, session: string): WorkerLease {
    return {
      v: 1,
      owner_token: token,
      command_id: row.id,
      session,
      pr: row.pr,
      generation: row.attempt,
      pid: null,
      pgid: null,
      start_time: null,
      boot_id: this.proc.bootId(),
      command: `debugroundpi --pr ${row.pr}`,
      created_at: this.iso(),
    };
  }

  private planFor(
    row: SessionCommandRow,
    spec: WorkerSpec,
  ): { spec: DebugRoundSpec; statusFile: string } {
    const dir = join(this.deps.runDir, "debug");
    const session = debugSession(row.pr);
    const borrow = join(dir, `${session}.agent`);
    const statusFile = join(borrow, DEBUG_STATUS_NAME);
    const round = row.round_no ?? 0;
    const passes = roundPassesDir(spec, round);
    const lensDir = lensDirOf(spec);
    const file = this.deps.newestSessionFile(spec.session_dir);
    const stub = findReviewerStub(spec.root);
    const out: DebugRoundSpec = {
      v: 1,
      pr: row.pr,
      session,
      command_id: row.id,
      round_no: row.round_no,
      root: spec.root,
      cwd: spec.cwd,
      agent_dir: spec.agent_dir,
      ...(spec.login_dir !== undefined ? { login_dir: spec.login_dir } : {}),
      borrow_dir: borrow,
      idle_ms: this.idleMs,
      ...(file !== undefined ? { session_file: file } : {}),
      session_dir: spec.session_dir,
      model: spec.model,
      system_prompt_file: spec.system_prompt_file,
      ...(stub ? { stub_file: stub } : {}),
      extensions: DEBUG_BOT_EXTENSIONS.map((e) => extensionFile(spec.root, e)),
      payload_path: row.payload_path,
      payload_sha256: row.payload_sha256,
      marker: sessionCommandMarker(row.id, row.payload_sha256),
      planned_wave: spec.planned_wave,
      passes_dir: passes,
      lens_dir: lensDir,
      env: {
        ...spec.env,
        QCR_SANDBOX_ROOT: spec.root,
        QCR_PR: String(row.pr),
        ...ipcEnv({ socketPath: this.deps.socketPath, commandId: row.id, generation: row.attempt }),
      },
    };
    return { spec: out, statusFile };
  }

  private writeSpec(session: string, spec: DebugRoundSpec): string {
    const dir = join(this.deps.runDir, "debug");
    // The pane's pi runs as the tool uid and reaches its agent dir through here.
    ensurePrivateDir(dir, { searchable: toolUidSplit() });
    const file = join(dir, `${session}.${randomBytes(6).toString("hex")}.spec.json`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(spec)}\n`, { mode: 0o600 });
    return file;
  }

  // ---- release ---------------------------------------------------------------

  /** The operator's `release` (or the end of an idle lease): stop the pi, settle the
   * round, and free the lease only when the pi is confirmed gone. */
  async release(pr: number, why = "released by the operator"): Promise<DebugResult> {
    const row = this.deps.store.hostLease(pr);
    if (row?.kind !== "debug") return refuse(`PR #${pr} has no debug lease to release`, "no_lease");
    this.deps.store.endHostLease(pr, row.token, this.iso(), why);
    const gone = await this.finish(this.deps.store.hostLease(pr) ?? row, why);
    if (!gone)
      return refuse(
        `the debug pi of PR #${pr} is still running: the lease stays, and no worker starts, until it is gone`,
        "pi_alive",
      );
    return {
      ok: true,
      session: debugSession(pr),
      command_id: row.command_id,
      message: `debug round of PR #${pr} ended: the pi is gone and the next round goes to a worker`,
    };
  }

  /** Stop the lease's pi and, only once it is gone, settle the round and free the
   * lease. True when freed. */
  private finish(row: HostLeaseRow, why: string, force?: "requeue"): Promise<boolean> {
    const running = this.stopping.get(row.pr);
    if (running) return running;
    const p = this.stop(row, why, force).finally(() => this.stopping.delete(row.pr));
    this.stopping.set(row.pr, p);
    return p;
  }

  private async stop(row: HostLeaseRow, why: string, force?: "requeue"): Promise<boolean> {
    const { store } = this.deps;
    const session = debugSession(row.pr);
    const command = this.commandOf(row);
    // The generation moves and the capability goes first: a post from the dying pi
    // finds a command that is not its own any more.
    if (command) this.noteEnded(command.id, command.attempt + 1, row.token);
    if (command) {
      this.deps.capabilities.revoke(command.id);
      // A launch file the pane never claimed would revoke the next holder of this id.
      this.deps.launchFiles.cancel(command.id);
    }
    const out = await killHostPane(session, {
      tmux: this.deps.tmux,
      leases: this.leases,
      proc: this.proc,
      signal: this.signal,
      graceMs: this.deps.killGraceMs ?? 3_000,
      sleep: this.sleep,
      now: this.now,
    });
    if (!out.gone) {
      this.log(`debug: #${row.pr} pi still alive after the kill (${why}); the lease stands`);
      store.logEvent("debug_pi_alive", row.pr, {
        why,
        survivors: out.survivors,
        listed: out.listed,
      });
      return false;
    }
    // The pi is gone: only now is the round's command settled, and the lease freed.
    if (command)
      this.settle(command, row.token, force === "requeue" ? false : this.verdictOf(command));
    this.running.delete(row.pr);
    this.undelivered.delete(row.pr);
    store.releaseHostLease(row.pr, row.token);
    this.log(`debug: #${row.pr} released (${why})`);
    try {
      await this.deps.afterRelease?.(row.pr);
    } catch (e) {
      this.log(`debug: afterRelease for #${row.pr} failed: ${String(e)}`);
    }
    return true;
  }

  /** The round's verdict is committed: seen by a sweep (latched), or still there to see. */
  private verdictOf(command: SessionCommandRow): boolean {
    if (command.round_no === null) return false;
    const run = this.running.get(command.pr);
    if (run === undefined) return false;
    return (
      run.verdictAt !== undefined || this.verdictCommitted(command.pr, run.root, command.round_no)
    );
  }

  /** A committed verdict does not stay where the session wrote it: the daemon's watcher
   * applies it and moves it to verdict/processed/ at once. So the commit is the file, or
   * its archived copy, or the round's row no longer running (the watcher finished it). */
  private verdictCommitted(pr: number, root: string, roundNo: number): boolean {
    const name = `pr-${pr}-round-${roundNo}.json`;
    if (existsSync(join(root, "verdict", name))) return true;
    try {
      if (readdirSync(join(root, "verdict", "processed")).some((f) => f.endsWith(`-${name}`)))
        return true;
    } catch {
      /* no archive yet */
    }
    const round = this.deps.store.roundsFor(pr).find((r) => r.round_no === roundNo);
    return round !== undefined && round.status !== "running";
  }

  /** Settle the round's command after its pi is gone: served when the verdict was
   * committed, otherwise handed back to `pending` for a worker, which resumes the
   * JSONL under its id (the marker makes it continue, not send the order again).
   * The supervisor writes the row. */
  private settle(command: SessionCommandRow, token: string, served: boolean): void {
    this.deps.commands.settleHosted(
      command.id,
      token,
      served
        ? { served: true }
        : { served: false, reason: "the debug pi ended before the round's verdict" },
    );
  }

  private noteEnded(commandId: string, generation: number, token: string): void {
    this.ended.set(commandId, { generation, token });
    if (this.ended.size > 64) this.ended.delete(this.ended.keys().next().value as string);
  }

  // ---- progress, verdict, idle, exit, restart ----------------------------------

  /** One pass over the leases: deliver a waiting order to an armed lease, mark the
   * round started once the order went out, end the round whose verdict is committed,
   * free those whose pi exited or sat idle, retry those still `ending`. */
  async sweep(): Promise<DebugSweepReport> {
    const report: DebugSweepReport = { released: [], stuck: [], delivered: [] };
    const { store, tmux } = this.deps;
    for (const row of store.hostLeases()) {
      if (row.kind !== "debug") continue;
      let why: string | null = null;
      if (row.state === "ending") why = row.ending_why ?? "ending";
      else {
        const run = this.running.get(row.pr);
        if (run === undefined) {
          const waiting = store.activeSessionCommand(`pr-${row.pr}`);
          if (waiting && this.claims(waiting)) {
            const delivery = await this.deliver(waiting);
            if (delivery.ok) {
              this.undelivered.delete(row.pr);
              report.delivered.push(row.pr);
            } else if (this.undelivered.get(row.pr) !== delivery.reason) {
              this.undelivered.set(row.pr, delivery.reason);
              this.log(`debug: #${row.pr} waiting order not delivered: ${delivery.reason}`);
            }
            continue;
          }
          // A launch in flight has claimed its command but not yet registered its pi.
          if (this.delivering.has(row.pr)) continue;
          // A round claimed under this lease by a manager that is not this one: no pi
          // of ours to watch.
          if (this.commandOf(row)) why = "the debug round has no pi under this daemon";
          else if (this.now() - (await this.lastActivity(row, undefined)) >= this.idleMs)
            why = `idle for ${Math.round(this.idleMs / 60_000)} minutes`;
        } else {
          const names = await tmux.listSessionsKnown();
          if (names === null) continue; // could not ask: nothing is decided on a failed look
          this.markStarted(row, run);
          const last = await this.lastActivity(row, run);
          if (!names.includes(debugSession(row.pr))) why = "the debug pi exited";
          else if (this.verdictSeen(row, run, last)) why = "the round's verdict is committed";
          else if (this.now() - last >= this.idleMs)
            why = `idle for ${Math.round(this.idleMs / 60_000)} minutes`;
        }
      }
      if (why === null) continue;
      store.endHostLease(row.pr, row.token, this.iso(), why);
      if (await this.finish(store.hostLease(row.pr) ?? row, why)) report.released.push(row.pr);
      else report.stuck.push(row.pr);
    }
    return report;
  }

  /** The round is started (the order reached the session) once the extension wrote
   * `order_sent_at`: the receipt the silent-round net and the recheck sweep read. */
  private markStarted(row: HostLeaseRow, run: Running): void {
    if (run.startedMarked) return;
    try {
      const status = JSON.parse(readFileSync(run.statusFile, "utf8")) as {
        order_sent_at?: unknown;
      };
      if (typeof status.order_sent_at !== "string") return;
    } catch {
      return;
    }
    if (this.deps.commands.markHostedStarted(run.commandId, row.token, run.deadline))
      run.startedMarked = true;
  }

  /** The verdict is committed (latched once seen, as the watcher archives the file), and
   * the pane has been quiet for the settle window. */
  private verdictSeen(row: HostLeaseRow, run: Running, last: number): boolean {
    if (run.roundNo === null) return false;
    if (run.verdictAt === undefined) {
      if (!this.verdictCommitted(row.pr, run.root, run.roundNo)) return false;
      run.verdictAt = this.now();
    }
    return this.now() - Math.max(run.verdictAt, last) >= this.settleMs;
  }

  private async lastActivity(row: HostLeaseRow, run: Running | undefined): Promise<number> {
    let last = Date.parse(row.touched_at);
    const seen = [await this.deps.tmux.lastActivityMs(debugSession(row.pr)).catch(() => undefined)];
    const file =
      run?.sessionFile ?? (run ? this.deps.newestSessionFile(run.sessionDir) : undefined);
    if (file) {
      try {
        seen.push(statSync(file).mtimeMs);
      } catch {
        /* the file is not there to read */
      }
    }
    for (const t of seen) if (t !== undefined && t > last) last = t;
    // At most now: a clock skewed ahead must not keep a lease for ever.
    last = Math.min(last, this.now());
    if (last > Date.parse(row.touched_at))
      this.deps.store.touchHostLease(row.pr, row.token, this.iso(last));
    return last;
  }

  /** The daemon's boot: no debug round of a previous daemon is wanted (its capability
   * died with it). Every lease is ended, its pi stopped, its round handed back to
   * `pending`, and the lease freed once the pi is confirmed gone. The daemon's start
   * runs it after the supervisor's `recover`, which requeues any command still marked
   * running. */
  async recover(): Promise<DebugSweepReport> {
    const report: DebugSweepReport = { released: [], stuck: [], delivered: [] };
    for (const row of this.deps.store.hostLeases()) {
      if (row.kind !== "debug") continue;
      this.deps.store.endHostLease(row.pr, row.token, this.iso(), "the daemon restarted");
      const current = this.deps.store.hostLease(row.pr) ?? row;
      if (await this.finish(current, "the daemon restarted", "requeue"))
        report.released.push(row.pr);
      else report.stuck.push(row.pr);
    }
    // A process lease with no row (the row was lost): its pi is stopped too.
    for (const { session, lease } of this.leases.list()) {
      const named = /^debug-pr-(\d+)$/.exec(session);
      if (!named || this.deps.store.hostLease(Number(named[1]))) continue;
      if (lease === null) {
        this.leases.forget(session);
        continue;
      }
      await killHostPane(session, {
        tmux: this.deps.tmux,
        leases: this.leases,
        proc: this.proc,
        signal: this.signal,
        graceMs: this.deps.killGraceMs ?? 3_000,
        sleep: this.sleep,
        now: this.now,
      });
    }
    return report;
  }

  /** Run `sweep` every `everyMs` until `stopTimer`. */
  start(everyMs = 5_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.sweep().catch((e) => this.log(`debug: sweep failed: ${String(e)}`));
    }, everyMs);
    this.timer.unref();
  }

  stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

function refuse(reason: string, code: DebugRefusal): DebugResult {
  return { ok: false, reason, code };
}

function fail(reason: string): DebugDelivery {
  return { ok: false, reason };
}

function rmQuiet(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    /* already gone */
  }
}

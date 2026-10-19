// The takeover lease (P8.13, D27): the operator works in a PR's REAL session.
//
// A PR between rounds is its JSONL and nothing else (the worker world). A
// takeover opens that JSONL in interactive pi, in tmux, in the bot container, as
// `takeover-pr-<n>`, so the operator talks to the session that did the review and
// what they say is in the history the next round's worker resumes. The pi WRITES
// the file (--session, not --fork); that is the point, and it is why the lease
// exists: two writers must never append to one JSONL.
//
//   - GRANT. A SQLite row (`pr_host_leases`, src/state.ts), granted only when no
//     worker command owns the session, in the transaction that reads it, and
//     refused when a worker is seen running. It holds dispatch and parks wakes
//     (`pending_wakes`) while it stands, and the supervisor refuses every worker
//     (`hostGate`). A takeover never posts, so it is granted under a drain or a
//     park.
//   - NO POSTING. The pi has bash-guard on with the takeover policy (the post
//     scripts are blocked there), read tools and no write tools, and the daemon's
//     IPC refuses every post of a command under this lease (`lookup`, which says
//     `lease: "takeover"`; src/postops.ts). Two layers, neither trusting the other.
//   - ITS LOGIN. The pi reads a refresh-blanked COPY of the login (D5), made by
//     the pane's own entry (src/takeoverpi.ts), never the refresher's file.
//   - RELEASE. `release`, the pi exiting, or 30 minutes without activity. The
//     daemon kills the pi (the tmux session, then its process group by the
//     process lease, TERM then KILL) and frees the row only once the process is
//     CONFIRMED gone. A pi that survives leaves the row `ending`: it keeps every
//     worker out, and the next sweep tries again. So a worker is never started
//     behind a takeover pi that is still alive.
//   - RESTART. A daemon that comes back ends every takeover (`recover`), as it does
//     every worker (D23): the capability died with the old daemon.
//
// Neutral by design (node builtins, the state store, the ipc capability module and
// src/workerlease.ts), so the daemon imports it without reaching src/engine/. The
// pane's side (src/takeoverpi.ts) is the part that touches the login and pi.
import { randomBytes } from "node:crypto";
import { mkdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type CapabilityStore,
  type LaunchFiles,
  ensurePrivateDir,
  ipcEnv,
} from "./ipc/capability.js";
import type { CommandLookup } from "./ipc/protocol.js";
import type { HostLeaseKind, HostLeaseRow, StateStore } from "./state.js";
import { type Tmux } from "./tmux.js";
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

/** How long a takeover may sit without activity before the daemon ends it. */
export const TAKEOVER_IDLE_MS = 30 * 60_000;

/** The tools the takeover pi has: the read tools, and bash (behind bash-guard,
 * whose takeover policy blocks the post scripts). No edit, no write. */
export const TAKEOVER_TOOLS = "read,grep,find,ls,bash";

/** The names the pane's entry reads to mark the pi as a takeover: bash-guard
 * blocks the post scripts when it is set (extensions/bash-guard.ts). */
export const TAKEOVER_ENV = "QCR_TAKEOVER";

export const takeoverSession = (pr: number): string => `takeover-pr-${pr}`;

/** The grant's command id: the host's name on the IPC socket. */
export const takeoverCommandId = (token: string): string => `takeover-${token}`;

/** What the takeover pi is started on. Plain data, no secret: it is written to a
 * 0600 file the pane's entry reads and removes. */
export interface TakeoverPlan {
  /** The production tree (`QCR_SANDBOX_ROOT`). */
  root: string;
  /** The pi's cwd: the production tree's root, where bash-guard recognises the
   * sanctioned scripts. */
  cwd: string;
  /** The login's owner dir (`pihome/agent`): read-only, borrowed from. */
  agent_dir: string;
  /** The PR's JSONL, which the pi resumes and appends to. */
  session_file: string;
  model: string;
  /** The session's system prompt, when one is kept for it. */
  system_prompt_file?: string;
  /** Extensions by absolute path: bash-guard first, always. */
  extensions: string[];
  /** The non-secret names the pi's env carries. */
  env: Record<string, string>;
}

/** The spec file the pane's entry reads. */
export interface TakeoverSpec extends TakeoverPlan {
  v: 1;
  pr: number;
  session: string;
  /** Where the borrowed agent dir is made. */
  borrow_dir: string;
  /** The window the borrowed login must outlast. */
  idle_ms: number;
  tools: string;
  pi_bin?: string;
}

export type TakeoverResult =
  | { ok: true; session: string; command_id: string; message: string }
  | { ok: false; reason: string };

export interface TakeoverDeps {
  store: StateStore;
  capabilities: CapabilityStore;
  /** The launch files for panes (tmux passes no fd). */
  launchFiles: LaunchFiles;
  /** `<state>/run`: the spec files and the pi's process leases live under it. */
  runDir: string;
  socketPath: string;
  tmux: Pick<
    Tmux,
    "newSession" | "killSession" | "hasSession" | "listSessionsKnown" | "panePid" | "lastActivityMs"
  >;
  /** What the pi is started on, or why it cannot be. */
  plan: (pr: number) => TakeoverPlan;
  /** `dist/src/ipc/launcher.js` and `dist/src/takeoverpi.js`. */
  launcherMain: string;
  takeoverMain: string;
  nodeBin?: string;
  /** Does a worker run for the PR? null: could not be asked. Omitted: not asked
   * (the row check still stands). */
  workerRuns?: (pr: number) => boolean | null;
  /** Told after a lease was freed, so held wakes and the queue move on. */
  afterRelease?: (pr: number) => Promise<void> | void;
  idleMs?: number;
  /** How long a TERM gets before the KILL. */
  killGraceMs?: number;
  proc?: ProcView;
  signal?: SignalFn;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string, extra?: unknown) => void;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface SweepReport {
  released: number[];
  /** Leases whose pi was still alive after the kill: they stand, `ending`. */
  stuck: number[];
}

export class TakeoverManager {
  readonly leases: WorkerLeases;
  private readonly idleMs: number;
  private readonly proc: ProcView;
  private readonly signal: SignalFn;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (msg: string, extra?: unknown) => void;
  /** The JSONL each live takeover writes, for the idle clock. */
  private readonly files = new Map<number, string>();
  /** PRs with a stop under way: the sweep and a release never run two at once. */
  private readonly stopping = new Map<number, Promise<boolean>>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: TakeoverDeps) {
    this.idleMs = deps.idleMs ?? TAKEOVER_IDLE_MS;
    this.proc = deps.proc ?? realProc;
    this.signal = deps.signal ?? sendSignal;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? defaultSleep;
    this.log = deps.log ?? ((): void => {});
    this.leases = new WorkerLeases(join(deps.runDir, "takeover"));
  }

  private iso(ms = this.now()): string {
    return new Date(ms).toISOString();
  }

  // ---- what the rest of the daemon asks ------------------------------------

  /** The PR's host lease kind, for status.json's `runtime`; null for none. */
  leaseOf(pr: number): HostLeaseKind | null {
    return this.deps.store.hostLease(pr)?.kind ?? null;
  }

  /** The supervisor's gate: why no worker may start for `pr`, or null. A lease
   * row stands until its pi is confirmed gone; a pi the process table still
   * confirms blocks even without a row (a row lost to a restore). */
  hostGate(pr: number): string | null {
    const row = this.deps.store.hostLease(pr);
    if (row)
      return `PR #${pr} is under a ${row.kind} lease (${row.holder}, ${row.state}): no worker starts`;
    const held = this.leases.read(takeoverSession(pr));
    if (held === undefined) return null;
    const verdict = held === null ? ({ kind: "dead" } as const) : judgeLease(held, this.proc);
    return verdict.kind === "group" || verdict.kind === "members" || verdict.kind === "unstarted"
      ? `a takeover pi for PR #${pr} still runs: no worker starts`
      : null;
  }

  /** The IPC server's view of a takeover command: active while its lease is held,
   * and always `lease: "takeover"`, which is what makes the post ops refuse it. A
   * debug round's command is the debug manager's to answer (src/debuground.ts). */
  readonly lookup: CommandLookup = (commandId) => {
    for (const row of this.deps.store.hostLeases()) {
      if (row.kind !== "takeover" || row.command_id !== commandId) continue;
      return {
        pr: row.pr,
        generation: 1,
        active: row.state === "held",
        may_post: false,
        lease: "takeover",
      };
    }
    return null;
  };

  // ---- grant ----------------------------------------------------------------

  /** Take the PR's session for the operator and start the pi. */
  async grant(pr: number, holder = "operator"): Promise<TakeoverResult> {
    const { store } = this.deps;
    const runs = this.deps.workerRuns?.(pr);
    if (runs === true) return refuse(`a worker runs for PR #${pr}: abort the round or wait for it`);
    if (runs === null)
      return refuse(`cannot tell whether a worker runs for PR #${pr}: not granting`);
    const held = store.hostLease(pr);
    if (held)
      return refuse(
        `PR #${pr} is already under a ${held.kind} lease (${held.holder}, ${held.state})`,
      );
    const blocked = this.hostGate(pr);
    if (blocked !== null) return refuse(blocked);

    let plan: TakeoverPlan;
    try {
      plan = this.deps.plan(pr);
    } catch (e) {
      return refuse(e instanceof Error ? e.message : String(e));
    }

    const token = WorkerLeases.newToken();
    const commandId = takeoverCommandId(token);
    const granted = store.grantHostLease({
      pr,
      kind: "takeover",
      token,
      commandId,
      holder,
      at: this.iso(),
    });
    if (!granted.ok) return refuse(granted.reason);

    const session = takeoverSession(pr);
    let specFile: string | undefined;
    try {
      this.files.set(pr, plan.session_file);
      this.leases.create(this.processLease(token, commandId, pr, session));
      this.deps.capabilities.mint(commandId);
      const launch = this.deps.launchFiles.create(commandId);
      specFile = this.writeSpec(pr, session, plan, commandId);
      const node = this.deps.nodeBin ?? process.execPath;
      await this.deps.tmux.newSession(
        session,
        [node, this.deps.launcherMain, launch.path, "--", node, this.deps.takeoverMain, specFile],
        { cwd: plan.cwd },
      );
      const pid = await this.deps.tmux.panePid(session);
      if (pid === undefined) throw new Error("the takeover pi did not start (no tmux pane)");
      const identity = this.proc.identity(pid);
      this.leases.update(session, token, {
        pid,
        pgid: identity?.pgid ?? pid,
        start_time: identity?.start ?? null,
      });
    } catch (e) {
      // Nothing of this grant stays: the pi (if it began) is stopped and confirmed gone
      // before the row goes, so a half-started takeover never blocks a worker for ever
      // and never leaves a writer behind.
      const row = store.hostLease(pr);
      if (row && row.token === token) {
        store.endHostLease(pr, token, this.iso(), "the takeover could not start");
        await this.finish(row, "the takeover could not start");
      }
      if (specFile) rmQuiet(specFile);
      return refuse(`takeover of PR #${pr} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.log(`takeover: #${pr} granted to ${holder} (${session})`);
    return {
      ok: true,
      session,
      command_id: commandId,
      message: `takeover of PR #${pr} granted: attach with \`tmux attach -t ${session}\` (the bot container)`,
    };
  }

  private processLease(token: string, commandId: string, pr: number, session: string): WorkerLease {
    return {
      v: 1,
      owner_token: token,
      command_id: commandId,
      session,
      pr,
      generation: 1,
      pid: null,
      pgid: null,
      start_time: null,
      boot_id: this.proc.bootId(),
      command: `takeoverpi --pr ${pr}`,
      created_at: this.iso(),
    };
  }

  private writeSpec(pr: number, session: string, plan: TakeoverPlan, commandId: string): string {
    const dir = join(this.deps.runDir, "takeover");
    ensurePrivateDir(dir);
    const spec: TakeoverSpec = {
      v: 1,
      ...plan,
      env: {
        ...plan.env,
        ...ipcEnv({ socketPath: this.deps.socketPath, commandId, generation: 1 }),
        [TAKEOVER_ENV]: "1",
      },
      pr,
      session,
      borrow_dir: join(dir, `${session}.agent`),
      idle_ms: this.idleMs,
      tools: TAKEOVER_TOOLS,
    };
    const file = join(dir, `${session}.${randomBytes(6).toString("hex")}.spec.json`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(spec)}\n`, { mode: 0o600 });
    return file;
  }

  // ---- release ---------------------------------------------------------------

  /** The operator's `release` (or the end of an idle lease): stop the pi, and free
   * the lease only when it is confirmed gone. */
  async release(pr: number, why = "released by the operator"): Promise<TakeoverResult> {
    const row = this.deps.store.hostLease(pr);
    if (!row) return refuse(`PR #${pr} has no takeover lease to release`);
    // A debug round's lease is the debug manager's: its pi is a different one.
    if (row.kind !== "takeover")
      return refuse(`PR #${pr} is under a ${row.kind} lease, not a takeover`);
    this.deps.store.endHostLease(pr, row.token, this.iso(), why);
    const gone = await this.finish(this.deps.store.hostLease(pr) ?? row, why);
    if (!gone)
      return refuse(
        `the takeover pi of PR #${pr} is still running: the lease stays, and no worker starts, until it is gone`,
      );
    return {
      ok: true,
      session: takeoverSession(pr),
      command_id: row.command_id,
      message: `takeover of PR #${pr} released: the pi is gone and the next round resumes the session`,
    };
  }

  /** Stop the lease's pi and, only once it is gone, free the lease. True when freed. */
  private finish(row: HostLeaseRow, why: string): Promise<boolean> {
    const running = this.stopping.get(row.pr);
    if (running) return running;
    const p = this.stop(row, why).finally(() => this.stopping.delete(row.pr));
    this.stopping.set(row.pr, p);
    return p;
  }

  private async stop(row: HostLeaseRow, why: string): Promise<boolean> {
    const { store } = this.deps;
    const session = takeoverSession(row.pr);
    // The capability goes first: a post from the dying pi finds no command.
    this.deps.capabilities.revoke(row.command_id);
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
      this.log(`takeover: #${row.pr} pi still alive after the kill (${why}); the lease stands`);
      store.logEvent("takeover_pi_alive", row.pr, {
        why,
        survivors: out.survivors,
        listed: out.listed,
      });
      return false;
    }
    this.files.delete(row.pr);
    store.releaseHostLease(row.pr, row.token);
    this.log(`takeover: #${row.pr} released (${why})`);
    try {
      await this.deps.afterRelease?.(row.pr);
    } catch (e) {
      this.log(`takeover: afterRelease for #${row.pr} failed: ${String(e)}`);
    }
    return true;
  }

  // ---- idle, exit, restart ---------------------------------------------------

  /** One pass over the leases: end the idle, free those whose pi exited, retry
   * those still `ending`. */
  async sweep(): Promise<SweepReport> {
    const report: SweepReport = { released: [], stuck: [] };
    const { store, tmux } = this.deps;
    for (const row of store.hostLeases()) {
      if (row.kind !== "takeover") continue;
      let why: string | null = null;
      if (row.state === "ending") why = row.ending_why ?? "ending";
      else {
        const names = await tmux.listSessionsKnown();
        if (names === null) continue; // could not ask: nothing is decided on a failed look
        if (!names.includes(takeoverSession(row.pr))) why = "the takeover pi exited";
        else {
          const last = await this.lastActivity(row);
          if (this.now() - last >= this.idleMs)
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

  private async lastActivity(row: HostLeaseRow): Promise<number> {
    let last = Date.parse(row.touched_at);
    const session = takeoverSession(row.pr);
    const seen = [await this.deps.tmux.lastActivityMs(session).catch(() => undefined)];
    const file = this.files.get(row.pr);
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

  /** The daemon's boot: no takeover of a previous daemon is wanted (its capability
   * died with it). Every lease is ended, and freed once its pi is confirmed gone. */
  async recover(): Promise<SweepReport> {
    const report: SweepReport = { released: [], stuck: [] };
    for (const row of this.deps.store.hostLeases()) {
      if (row.kind !== "takeover") continue;
      this.deps.store.endHostLease(row.pr, row.token, this.iso(), "the daemon restarted");
      const current = this.deps.store.hostLease(row.pr) ?? row;
      if (await this.finish(current, "the daemon restarted")) report.released.push(row.pr);
      else report.stuck.push(row.pr);
    }
    // A process lease with no row (the row was lost): its pi is stopped too.
    for (const { session, lease } of this.leases.list()) {
      const named = /^takeover-pr-(\d+)$/.exec(session);
      if (!named || this.deps.store.hostLease(Number(named[1]))) continue;
      if (lease === null) {
        this.leases.forget(session);
        continue;
      }
      await this.deps.tmux.killSession(session).catch(() => undefined);
      const out = await killLease(lease, {
        proc: this.proc,
        signal: this.signal,
        graceMs: this.deps.killGraceMs ?? 3_000,
        sleep: this.sleep,
        now: this.now,
      });
      if (!out.survivors) this.leases.forget(session);
    }
    return report;
  }

  /** Run `sweep` every `everyMs` until `stop`. */
  start(everyMs = 30_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.sweep().catch((e) => this.log(`takeover: sweep failed: ${String(e)}`));
    }, everyMs);
    this.timer.unref();
  }

  stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export interface PaneKillDeps {
  tmux: Pick<Tmux, "killSession" | "listSessionsKnown">;
  /** The process leases the pane's pi was recorded in. */
  leases: WorkerLeases;
  proc: ProcView;
  signal: SignalFn;
  graceMs: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

/**
 * Stop the tmux session `session` and the process group its pi leads, and say
 * whether it is CONFIRMED gone: tmux no longer lists it and the process lease
 * names no survivor. `gone` is false when a process outlived the kill, or when
 * tmux could not be asked (a failed look proves nothing). A pi that is gone has
 * its process lease forgotten. Shared by the takeover (src/takeover.ts) and the
 * debug round (src/debuground.ts): both owe a worker the same promise, that two
 * writers never append to one JSONL.
 */
export async function killHostPane(
  session: string,
  d: PaneKillDeps,
): Promise<{ gone: boolean; survivors: boolean; listed: boolean }> {
  await d.tmux.killSession(session).catch(() => undefined);
  const lease = d.leases.read(session);
  let survivors = false;
  if (lease) {
    const out = await killLease(lease, {
      proc: d.proc,
      signal: d.signal,
      graceMs: d.graceMs,
      sleep: d.sleep,
      now: d.now,
    });
    survivors = out.survivors;
    // A leader that is gone may leave members of its group.
    if (!survivors) {
      const again = judgeLease(lease, d.proc);
      survivors = again.kind === "group" || again.kind === "members";
    }
  }
  // Confirm tmux no longer lists it; a tmux that cannot be asked proves nothing.
  const names = await d.tmux.listSessionsKnown();
  const listed = names === null ? true : names.includes(session);
  const gone = !survivors && !listed;
  if (gone) d.leases.forget(session);
  return { gone, survivors, listed };
}

/** One host gate over several: the first that has a reason to keep a worker out
 * of the PR's session gives it. */
export function composeHostGates(
  ...gates: Array<(pr: number) => string | null>
): (pr: number) => string | null {
  return (pr) => {
    for (const gate of gates) {
      const why = gate(pr);
      if (why !== null) return why;
    }
    return null;
  };
}

function refuse(reason: string): TakeoverResult {
  return { ok: false, reason };
}

function rmQuiet(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    /* already gone */
  }
}

/**
 * The plan for a PR from the daemon's layout: the production tree, the login's
 * owner dir, the PR's newest JSONL, the conversation model, and bash-guard as the
 * only extension. Throws, with the reason, when the PR has no session to take
 * over.
 */
export function takeoverPlanFor(o: {
  root: string;
  agentDir: string;
  sessionsRoot: string;
  model: string;
  pr: number;
  newestSessionFile: (dir: string) => string | undefined;
  env?: Record<string, string>;
  systemPromptFile?: string;
}): TakeoverPlan {
  const dir = join(o.sessionsRoot, `pr-${o.pr}`);
  const file = o.newestSessionFile(dir);
  if (file === undefined)
    throw new Error(`PR #${o.pr} has no session JSONL under ${dir}: nothing to take over`);
  return {
    root: o.root,
    cwd: o.root,
    agent_dir: o.agentDir,
    session_file: file,
    model: o.model,
    ...(o.systemPromptFile ? { system_prompt_file: o.systemPromptFile } : {}),
    extensions: [join(o.root, "extensions", "bash-guard.ts")],
    env: { QCR_SANDBOX_ROOT: o.root, ...o.env },
  };
}

/** One lookup over several: the first that knows the command answers. The IPC
 * server asks for a command's state in one place; a round's worker and a
 * takeover pi are known to different owners. */
export function composeLookups(...lookups: CommandLookup[]): CommandLookup {
  return (commandId) => {
    for (const lookup of lookups) {
      const state = lookup(commandId);
      if (state !== null) return state;
    }
    return null;
  };
}

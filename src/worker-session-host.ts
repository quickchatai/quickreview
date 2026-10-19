// The worker host (P8.6): the SessionHooks the daemon's state machine speaks,
// served by the per-round WorkerSupervisor (P8.5) over the host-neutral
// PrSessionLifecycle (P8.1). It does for a PR's session what `PiSessionManager`
// does with tmux and the inject bridge, with none of either:
//
//   - A PR's "session" is its JSONL and its OpenViking id. Nothing runs between
//     rounds. A round or a wake is a durable command (`session_commands`), and
//     handing it over is starting one worker for it, which resumes the JSONL.
//   - Liveness is the worker's: `sessionAlive` asks the supervisor (its child, or
//     a lease the process table confirms), never a listing.
//   - The ack is the receipt. A worker's `accepted` event stamps the command
//     started, so "did the order reach the session" is a column. The silent-round
//     net (`roundPromptAccepted`), the recheck sweep (`wakeReceiptPresent`) and
//     the patience signal (`injectPending`) all read it, and none reads a
//     transcript. Their answers are definitive (`ackIsReceipt`): the command
//     supervisor skips the compaction defer and the unknown-evidence deferral.
//   - Compaction is the worker's, before it exits (D22), so `compactSession` and
//     `sessionCompaction` are not offered and the round-end calls skip them.
//   - Held wakes of a running round are taken by that round's own worker
//     (`HeldWakeHandoff` in src/wakes.ts). Whatever is still held when the worker
//     is gone is flushed by `inject`, which starts a wake worker for it.
//   - The fence is the supervisor's `fence`: end the worker, answer once it is
//     reaped, leave the row to the caller (as a tmux kill leaves it).
//
// The tmux host (src/sessions.ts) survives only until P9.2 deletes it.
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.js";
import type { OvSessionLifecycle } from "./memory/ovsession.js";
import { PrSessionLifecycle, prSessionName, type PrSessionHost } from "./pr-session-lifecycle.js";
import { verifiedPayload } from "./session-command-payload.js";
import { restoreRotatedFiles, rotateSessionFiles } from "./sessionjsonl.js";
import {
  sameSessionCommandOwner,
  sessionCommandMarker,
  type SessionCommandOwnership,
} from "./session-command.js";
import type { SessionCommandRow, StateStore } from "./state.js";
import {
  roundPromptMarker,
  stampRoundPrompt,
  type OvSessionSweepReport,
  type RoundOrder,
  type SessionCommandObservation,
  type SessionCommandRedeliveryResult,
  type SessionCommandRetryResult,
  type SessionHooks,
} from "./types.js";
import type { WorktreeManager } from "./worktrees.js";
import { WorkerLaunchError, type WorkerSupervisor } from "./workersupervisor.js";

/** How far before a query's `since` a command may have been created and still
 * be the one the query means: the order is stored before the round row's clock. */
const COMMAND_SINCE_SLACK_MS = 60_000;

export interface WorkerSessionHostOptions {
  cfg: Config;
  /** Sandbox root. */
  root: string;
  worktrees: WorktreeManager;
  /** The durable command store the daemon and the supervisor share. */
  store: StateStore;
  supervisor: WorkerSupervisor;
  ovSessions?: OvSessionLifecycle;
  now?: () => Date;
  log?: (msg: string) => void;
}

/** What a command's own row says about whether its session took it: true once
 * the worker accepted it (or served it), false when it ended without, null while
 * it is still on its way. */
function ackOf(command: SessionCommandRow): boolean | null {
  if (command.started_at !== null || command.status === "acked") return true;
  if (command.status === "pending" || command.status === "running") return null;
  return false;
}

export class WorkerSessionHost implements SessionHooks {
  readonly ackIsReceipt = true as const;
  readonly lifecycle: PrSessionLifecycle;
  readonly worktrees: WorktreeManager;
  private readonly root: string;
  private readonly store: StateStore;
  private readonly supervisor: WorkerSupervisor;
  private readonly log: (msg: string) => void;
  private readonly now: () => Date;

  constructor(opts: WorkerSessionHostOptions) {
    this.now = opts.now ?? (() => new Date());
    this.root = opts.root;
    this.store = opts.store;
    this.supervisor = opts.supervisor;
    this.worktrees = opts.worktrees;
    this.log = opts.log ?? ((msg) => console.log(`[quickreviewd] worker-host: ${msg}`));
    this.lifecycle = new PrSessionLifecycle({
      cfg: opts.cfg,
      root: opts.root,
      worktrees: opts.worktrees,
      host: this.workerHost(),
      ...(opts.ovSessions ? { ovSessions: opts.ovSessions } : {}),
      ...(opts.now ? { now: opts.now } : {}),
      commandStore: opts.store,
    });
  }

  /** What the lifecycle asks of whatever runs the PR's pi: here, the supervisor. */
  private workerHost(): PrSessionHost {
    const { supervisor } = this;
    return {
      liveSessions: async () => supervisor.workers().map((w) => w.session),
      provenGone: async (pr) => !supervisor.runs(prSessionName(pr)),
      killConfirmed: (pr) => supervisor.fence(prSessionName(pr)),
      stop: async (pr) => {
        await supervisor.fence(prSessionName(pr));
      },
      reuseLive: async (pr) => (supervisor.runs(prSessionName(pr)) ? prSessionName(pr) : undefined),
      // Nothing runs between rounds: the session is born when its first worker is.
      spawn: async (pr) => prSessionName(pr),
    };
  }

  // ---- what the daemon's wiring reads --------------------------------------

  sessionsRoot(): string {
    return this.lifecycle.sessionsRoot();
  }

  sessionDir(session: string): string {
    return this.lifecycle.sessionDir(session);
  }

  birthInFlight(pr: number): boolean {
    return this.lifecycle.birthInFlight(pr);
  }

  /** The archiver's `beforeBirth`, as on the tmux host. */
  setBeforeBirth(fn: (pr: number) => Promise<void>): void {
    this.lifecycle.setBeforeBirth(fn);
  }

  /** Start a worker for every pending command whose session has none: the daemon's
   * timer calls it, since a command a worker's death requeued waits for a fresh one. */
  async launchPending(): Promise<void> {
    await this.supervisor.launchPending();
  }

  // ---- delivery ------------------------------------------------------------

  /**
   * SessionHooks: ensure the worktree and the session, then hand the round to a
   * worker. The worktree is checked out at the order's sha without a fetch, as on
   * the tmux host. The stamped prompt is the command's payload, saved before the
   * row exists; redelivery sends those bytes and no others.
   */
  async dispatchRound(order: RoundOrder, renderedPrompt: string): Promise<void> {
    await this.lifecycle.prepareRoundWorktree(order);
    await this.lifecycle.ensureSession(order.pr, order.title, order.worktree);
    if (this.store.getPr(order.pr)?.paused)
      throw new Error(`PR #${order.pr} paused during session preparation — round not handed off`);
    const stamped = stampRoundPrompt(renderedPrompt, order.pr, order.round_no);
    const command = this.supervisor.submit({
      pr: order.pr,
      kind: "round",
      round_no: order.round_no,
      payload: stamped,
    });
    await this.start(command);
  }

  /**
   * SessionHooks: a wake outside a round (ping-pong, rechecks, held wakes that
   * outlived their round's worker). The PR must be known and open; a worker is
   * started for the wake, unless the slot is taken, which throws as the tmux host
   * does, and the caller holds the wake.
   */
  async inject(pr: number, message: string): Promise<void> {
    // Before anything else: a closed PR's worker that outlived its close
    // cleanup takes no new wake either.
    if (this.lifecycle.prClosed(pr)) {
      throw new Error(`PR #${pr} is closed — refusing a wake into ${prSessionName(pr)}`);
    }
    await this.ensureSessionForWake(pr);
    const command = this.supervisor.submit({ pr, kind: "wake", round_no: null, payload: message });
    await this.start(command);
  }

  /** Born on first trigger, like the tmux host's rebirth: the archive comes back
   * first, the worktree is revived, the raw tier created. Throws when the PR is
   * closed or was never tracked, so no title is known. */
  private async ensureSessionForWake(pr: number): Promise<void> {
    const closing = this.lifecycle.cleanupInFlight(pr);
    if (closing) {
      await closing.catch(() => undefined);
      return this.ensureSessionForWake(pr);
    }
    const session = prSessionName(pr);
    if (this.lifecycle.prClosed(pr)) {
      throw new Error(`PR #${pr} is closed — refusing to start a worker for ${session}`);
    }
    const title = this.store.getPr(pr)?.title;
    if (title === undefined || title === null)
      throw new Error(`no live session ${session} — dispatch a round to birth it first`);
    await this.lifecycle.awaitBeforeBirth(pr);
    const worktree = await this.lifecycle.reviveWorktree(pr);
    if (this.lifecycle.prClosed(pr)) {
      throw new Error(`PR #${pr} is closed — refusing to start a worker for ${session}`);
    }
    await this.lifecycle.ensureSession(pr, title, worktree);
  }

  /** Launch the worker for a command the supervisor just created. A launch the
   * supervisor refuses (a login rewrite that does not end, a lease held by a live
   * process, a payload that no longer verifies) is not a dispatch failure: the
   * row stays the one obligation, the supervisor's own checks recover it, and the
   * event says why. */
  private async start(command: SessionCommandRow): Promise<void> {
    try {
      await this.supervisor.launch(command.id);
    } catch (err) {
      if (!(err instanceof WorkerLaunchError)) throw err;
      this.store.logEvent("worker_launch_deferred", command.pr, {
        command_id: command.id,
        kind: command.kind,
        error: String(err).slice(0, 300),
      });
      this.log(
        `command ${command.id} (${command.kind}) of #${command.pr} not started: ${String(err)}`,
      );
    }
  }

  // ---- receipts ------------------------------------------------------------

  /**
   * SessionHooks: did this round's order reach its session? The command's ack: the
   * worker's `accepted` event stamps the row started, and an exit 0 does too.
   * `null` while the command is still on its way (patience), `false` once it ended
   * without, and `false` for a round that never had a command: nothing was handed
   * to a worker, which is definitive here.
   */
  async roundPromptAccepted(
    pr: number,
    roundNo: number,
    _startedAtMs: number,
  ): Promise<boolean | null> {
    const command = this.store.sessionCommandForRound(pr, roundNo);
    return command ? ackOf(command) : false;
  }

  /**
   * SessionHooks: the same read for a wake carrying `marker`. The command that
   * carries it is found among the PR's recent commands: a round by its prompt
   * marker, a command by its own marker, a wake by the marker in its payload.
   * Acked anywhere ⇒ true; still on its way ⇒ null; ended without ⇒ false; no
   * command carries it ⇒ false, unless a payload could not be read (archived),
   * which proves nothing.
   */
  async wakeReceiptPresent(pr: number, marker: string, sinceMs: number): Promise<boolean | null> {
    const since = new Date(Math.max(0, sinceMs - COMMAND_SINCE_SLACK_MS)).toISOString();
    let unreadable = false;
    const hits: SessionCommandRow[] = [];
    for (const command of this.store.sessionCommandsSince(pr, since)) {
      if (sessionCommandMarker(command.id, command.payload_sha256) === marker) {
        hits.push(command);
      } else if (command.kind === "round") {
        if (command.round_no !== null && roundPromptMarker(pr, command.round_no) === marker)
          hits.push(command);
      } else {
        const read = verifiedPayload(command);
        if (!read.ok) unreadable = true;
        else if (read.payload.toString("utf8").includes(marker)) hits.push(command);
      }
    }
    const acks = hits.map(ackOf);
    if (acks.includes(true)) return true;
    if (acks.includes(null)) return null;
    if (hits.length > 0) return false;
    return unreadable ? null : false;
  }

  /** SessionHooks: is the PR's command still on its way to its session? The
   * patience signal of the silent-round net: a command a worker is starting for
   * (or none has been started for yet) is not a lost prompt. */
  async injectPending(pr: number): Promise<boolean> {
    const active = this.store.activeSessionCommand(prSessionName(pr));
    return active !== undefined && active.started_at === null;
  }

  /** SessionHooks: newest session-JSONL mtime for the PR's session, or null when
   * it has none. The JSONL is the worker's own; nothing about it is a receipt. */
  async sessionActivityAt(pr: number): Promise<number | null> {
    const file = this.lifecycle.newestSessionFile(prSessionName(pr));
    if (!file) return null;
    try {
      return statSync(file).mtimeMs;
    } catch {
      return null;
    }
  }

  // ---- redelivery ----------------------------------------------------------

  /**
   * SessionHooks: put a round's order in front of a worker again: the same
   * command, the same bytes, no round cancelled, no GitHub state touched. Cheap
   * recovery: a pending command gets its worker; a failed one is replayed under
   * its own id; one a worker already has is a no-op, which is never reported as a
   * redelivery. False when there is no command, its bytes no longer verify, or
   * its round has ended.
   */
  async redeliverRound(pr: number, roundNo: number): Promise<boolean> {
    const command = this.store.sessionCommandForRound(pr, roundNo);
    if (!command) return false;
    if (!verifiedPayload(command).ok) return false;
    if (command.status === "running") return command.started_at !== null;
    if (command.status === "pending") return this.startPending(command);
    if (command.status !== "failed" || this.store.roundStatus(pr, roundNo) !== "running")
      return false;
    return this.fenceAndReplay(command);
  }

  /**
   * SessionHooks: the cheap recovery for a command whose start lease ran out. A
   * worker takes its payload once, at spawn, so there is nothing to write into a
   * live one: a pending command with no worker gets one (`redelivered`), and a
   * worker that is up yet never accepted is `not_live` — the kill-and-replay
   * recovery owns it. Every check is against `observed`, never a fresh read.
   */
  async redeliverSessionCommand(
    commandId: string,
    observed: SessionCommandObservation,
  ): Promise<SessionCommandRedeliveryResult> {
    const command = this.store.getSessionCommand(commandId);
    if (!command) return "redelivery_failed";
    if (command.status === "acked" || command.status === "cancelled") return "settled";
    if (command.started_at !== null) return "started";
    if (command.status !== "pending" && command.status !== "running") return "redelivery_failed";
    if (
      command.attempt !== observed.attempt ||
      command.redeliveries !== observed.redeliveries ||
      command.next_check_at !== observed.next_check_at
    )
      return "raced";
    if (command.status === "running" || this.supervisor.runs(command.session)) return "not_live";
    if (!verifiedPayload(command).ok) return "redelivery_failed";
    return (await this.startPending(command)) ? "redelivered" : "redelivery_failed";
  }

  /** Give a pending command its worker. True when one is up for it afterwards. */
  private async startPending(command: SessionCommandRow): Promise<boolean> {
    if (this.supervisor.runs(command.session)) return true;
    await this.start(command);
    return this.store.getSessionCommand(command.id)?.status === "running";
  }

  /**
   * SessionHooks: retry one durable command without ever leaving the old worker
   * beside its replay. A round may only be retried before it started; an ordinary
   * wake may after, since the old worker is fenced first. The same id and the same
   * bytes survive; the fresh worker resumes the JSONL and the marker makes it
   * continue instead of sending the order again.
   */
  async retrySessionCommand(
    commandId: string,
    _reason: string,
  ): Promise<SessionCommandRetryResult> {
    const command = this.store.getSessionCommand(commandId);
    if (
      !command ||
      !["pending", "running", "failed"].includes(command.status) ||
      (command.kind === "round" && command.started_at !== null)
    )
      return "retry_failed";
    // A closed PR is never started a worker for an ordinary wake: settle the row.
    if (command.kind !== "round" && this.lifecycle.prClosed(command.pr)) {
      this.store.cancelSessionCommandsForClosedPr(command.pr);
      return "settled";
    }
    const read = verifiedPayload(command);
    if (!read.ok) {
      this.notePayloadUnusable(command, read.why);
      return "retry_failed";
    }
    let preparation: SessionCommandRetryResult | undefined;
    const fenced = await this.fenceSession(command.pr, command, () => {
      preparation = this.prepareReplay(command);
    });
    if (!fenced) {
      const current = this.store.getSessionCommand(command.id);
      return !current || current.status === "acked" || current.status === "cancelled"
        ? "settled"
        : "raced";
    }
    if (preparation) return preparation;
    try {
      await this.ensureSessionForWake(command.pr);
      await this.supervisor.launch(command.id);
    } catch (error) {
      // The pending row and its immutable payload remain the one obligation; the
      // next finite supervisor check retries the start.
      const detail = String(error);
      this.store.noteSessionCommandRecoveryFailure(command.id, detail);
      this.store.logEvent("session_command_rebirth_failed", command.pr, {
        command_id: command.id,
        delivery_attempt: this.store.getSessionCommand(command.id)?.attempt ?? command.attempt,
        detail,
      });
      this.log(`command ${command.id} recovery start failed: ${detail}`);
      return "retry_failed";
    }
    const replayed = this.store.getSessionCommand(command.id);
    if (replayed?.status === "acked" || replayed?.status === "cancelled") return "settled";
    // A launch is the reservation: it claims the row, and only a claim moves the attempt.
    if (!replayed || replayed.attempt <= command.attempt) {
      const detail = `no worker reserved command ${command.id} (delivery attempt stayed ${command.attempt})`;
      this.store.noteSessionCommandRecoveryFailure(command.id, detail);
      this.store.logEvent("session_command_replay_unreserved", command.pr, {
        command_id: command.id,
        delivery_attempt: replayed?.attempt ?? command.attempt,
        detail,
      });
      this.log(detail);
      return "retry_failed";
    }
    return "retried";
  }

  /** The merits lifecycle first, then the atomic hand-back to `pending`. A
   * settlement that won during the fence is success, never grounds for a replay. */
  private prepareReplay(command: SessionCommandRow): SessionCommandRetryResult | undefined {
    const { store } = this;
    if (command.kind === "round" && command.round_no !== null) {
      if (existsSync(join(this.root, "verdict", `pr-${command.pr}-round-${command.round_no}.json`)))
        return "round_finished";
      const round = store.roundsFor(command.pr).find((row) => row.round_no === command.round_no);
      if (!round || round.status !== "running") return "round_finished";
    }
    if (this.supervisor.replay(command.id, command.attempt)) return undefined;
    const current = store.getSessionCommand(command.id);
    if (current?.status === "acked") return "settled";
    if (
      command.kind === "round" &&
      current?.started_at !== null &&
      current?.started_at !== undefined
    )
      return "accepted_race";
    if (command.kind === "round" && command.round_no !== null) {
      const round = store.roundsFor(command.pr).find((row) => row.round_no === command.round_no);
      if (!round || round.status !== "running") return "round_finished";
    }
    return "retry_failed";
  }

  /** `redeliverRound`'s replay of a failed command: fence, hand back, start. */
  private async fenceAndReplay(command: SessionCommandRow): Promise<boolean> {
    let refused = false;
    const fenced = await this.fenceSession(command.pr, command, () => {
      refused = !this.supervisor.replay(command.id, command.attempt);
    });
    if (!fenced || refused) return false;
    return this.startPending(command);
  }

  /** A recovery route found the command's saved payload unusable: say why on the
   * row (the supervisor reports it in place of the original reason). */
  private notePayloadUnusable(command: SessionCommandRow, why: string): void {
    this.store.noteSessionCommandRecoveryFailure(command.id, why);
    this.store.logEvent("session_command_payload_unusable", command.pr, {
      command_id: command.id,
      detail: why,
    });
    this.log(`command ${command.id} cannot be replayed: ${why}`);
  }

  // ---- liveness and the fence ----------------------------------------------

  /** SessionHooks: worker liveness. A worker of the PR's session runs, or it does
   * not; there is no listing that could fail to answer. */
  async sessionAlive(pr: number): Promise<boolean> {
    return this.supervisor.runs(prSessionName(pr));
  }

  /** SessionHooks: end the PR's worker so the requeued round's dispatch starts a
   * fresh one (live-but-stuck recovery, and the operator's restart-session fence).
   * Returns only once the worker is reaped; a worker that outlives the kill throws,
   * so no caller releases ownership beside a process that may still run. The row
   * stays the caller's to decide. */
  async killSession(pr: number): Promise<void>;
  async killSession(pr: number, expected: SessionCommandOwnership): Promise<boolean>;
  async killSession(pr: number, expected?: SessionCommandOwnership): Promise<void | boolean>;
  async killSession(pr: number, expected?: SessionCommandOwnership): Promise<void | boolean> {
    const fenced = await this.fenceSession(pr, expected);
    return expected ? fenced : undefined;
  }

  /** The operator's restart-session, after the kill: rotate the PR's JSONLs aside
   * so the next worker births a fresh session (a worker resumes the newest JSONL,
   * where a killed tmux pi was simply born again). Refused while a worker of the
   * session runs; returns the undo. The review ledger is not touched: the next
   * round order re-hands it (src/ledgercarry.ts). */
  rotateSession(pr: number): () => void {
    const session = prSessionName(pr);
    if (this.supervisor.runs(session))
      throw new Error(`session ${session} has a worker; not rotating its JSONL beside it`);
    const stamp = this.now()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d+Z$/, "Z");
    const moves = rotateSessionFiles(this.lifecycle.sessionDir(session), stamp);
    this.store.logEvent("session_rotated", pr, { files: moves.length, stamp });
    this.log(`rotated ${moves.length} JSONL(s) of ${session}`);
    return () => restoreRotatedFiles(moves);
  }

  private async fenceSession(
    pr: number,
    expected?: SessionCommandOwnership,
    afterFence?: () => void,
  ): Promise<boolean> {
    const session = prSessionName(pr);
    let fenced = false;
    const owns = (): boolean => {
      if (!expected) return true;
      if (!sameSessionCommandOwner(this.store.getSessionCommand(expected.id), expected))
        return false;
      const active = this.store.activeSessionCommand(session);
      return !active || active.id === expected.id;
    };
    // Birth and delivery wait this close flight, so a successor cannot start
    // between the last ownership check and the end of the worker.
    await this.lifecycle.withPrClose(pr, async () => {
      if (!owns()) return;
      const gone = !this.supervisor.runs(session);
      if (!owns()) return;
      if (!gone && !(await this.supervisor.fence(session)))
        throw new Error(
          `session ${session} not proven gone after kill; recovery must not dispatch beside it`,
        );
      afterFence?.(); // Keep a replay's CAS inside the same birth/close serialization.
      fenced = true;
    });
    return fenced;
  }

  // ---- reconcile and close ---------------------------------------------------

  /** SessionHooks: the reconcile sweep over closed PRs' raw tier; see the lifecycle. */
  sweepStaleOvSessions(max?: number): Promise<OvSessionSweepReport | null> {
    return this.lifecycle.sweepStaleOvSessions(max);
  }

  /** SessionHooks: archive the PR's record, drop its worktree, end its worker and
   * delete its raw tier; see the lifecycle. */
  archiveAndClose(pr: number): Promise<void> {
    return this.lifecycle.archiveAndClose(pr);
  }
}

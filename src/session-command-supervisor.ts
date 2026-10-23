// Bounded daemon→Pi stage supervision.
//
// This is a reconciler over the ONE durable session-command slot, not another
// scheduler. Delivery remains inject-bridge-owned; round recovery remains the
// VerdictWatcher's existing self-requeue path. The supervisor only classifies
// finite start/finish obligations from durable command state + JSONL receipts.
import { roundStageDeadlines } from "./round-stage-deadlines.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_MAX_PROMPT_REDELIVERIES,
  DEFAULT_ROUND_FINALIZE_GRACE_MIN,
  DEFAULT_ROUND_FIRST_PASS_MAX_MIN,
  DEFAULT_ROUND_PASSES_MAX_MIN,
  DEFAULT_ROUND_STAGE_SUPERVISOR_STALE_S,
  DEFAULT_SESSION_COMMAND_MAX_START_RETRIES,
  DEFAULT_SESSION_COMMAND_RUNNING_MAX_MIN,
  DEFAULT_SESSION_COMMAND_UNKNOWN_GRACE_S,
  DEFAULT_FOLLOW_UP_SWEEP_EXTRA_MIN,
  resolveRoundStageBounds,
  type Config,
} from "./config.js";
import { sameSessionCommandOwner, sessionCommandMarker } from "./session-command.js";
import {
  isTerminalAgentStatus,
  executionsComplete,
  lensForAgent,
  plannedFanoutAgents,
  type RoundProgressSnapshot,
} from "./round-progress.js";
import type { RoundRow, SessionCommandRow, StateStore, SupervisorLeaseRow } from "./state.js";
import type { RoundRecoveryDisposition, SessionHooks } from "./types.js";

export const ROUND_STAGE_SUPERVISOR = "round-stage";

/** How far a progress snapshot's run start may sit from the command's durable
 * start and still be the same run. */
const RUN_START_TOLERANCE_MS = 5_000;

function runStartsNear(commandStart: string, progressStart: string): boolean {
  const started = Date.parse(commandStart);
  const runStarted = Date.parse(progressStart);
  return (
    Number.isFinite(started) &&
    Number.isFinite(runStarted) &&
    Math.abs(runStarted - started) <= RUN_START_TOLERANCE_MS
  );
}

export type RoundInfrastructureStage =
  | "command_start"
  | "first_pass_start"
  | "passes_incomplete"
  | "parent_finalize"
  | "settled_without_verdict"
  | "running_hard_bound";

export interface SessionCommandSupervisorDeps {
  cfg: Config;
  store: StateStore;
  hooks: SessionHooks;
  verdictDir: string;
  /** Independent observational sidecar, trusted only when it names the
   * command exactly. It corroborates a durable start that settled after the
   * bridge died, supplies the start ORIGIN (and so the fixed hard deadline)
   * when the bridge missed its start stamp, and drives the earlier pass-stage
   * bounds; it never creates or renews a lease. */
  progress?: (pr: number) => RoundProgressSnapshot | undefined;
  /** Existing bounded round recovery. `requeued` = fresh round queued;
   * `exhausted` = its recovery budget is spent and failed work remains owed;
   * `retryable` = re-check later; `settled` = the round terminalized cleanly;
   * `posted_wait` = its review is already posted, so the session keeps its
   * command while it finishes (see `failRound` for each). */
  onRoundFailure: (
    pr: number,
    roundNo: number,
    stage: RoundInfrastructureStage,
    detail: string,
  ) => Promise<RoundRecoveryDisposition>;
  now?: () => Date;
}

export interface RoundStageSupervisorHealth {
  healthy: boolean;
  stale_after_s: number;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_error_at: string | null;
  last_error: string | null;
}

export class SessionCommandSupervisor {
  private readonly now: () => Date;
  private inFlight = false;
  /** Commands whose finalize hold was already logged (one event each). */
  private readonly finalizeHeld = new Set<string>();

  constructor(private readonly deps: SessionCommandSupervisorDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** One non-overlapping scan. A second timer firing while this awaits Pi
   * evidence returns without touching success, so the durable lease ages and
   * status becomes unhealthy even though the process heartbeat still moves. */
  async scan(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    const attemptedAt = this.now().toISOString();
    try {
      this.deps.store.markSupervisorAttempt(ROUND_STAGE_SUPERVISOR, attemptedAt);
      const candidates = new Map<string, SessionCommandRow>();
      for (const command of this.deps.store.dueSessionCommands(attemptedAt))
        candidates.set(command.id, command);
      // A bridge can die after archiving the settled file but before its ack
      // UPDATE. Exact command-correlated progress lets us reconcile that gap
      // immediately instead of waiting for the 45-minute hard deadline.
      for (const command of this.deps.store.activeSessionCommands())
        candidates.set(command.id, command);
      // One command's failure (a kill that keeps failing, a missing hook)
      // leaves the scan red, but never costs the commands after it their
      // inspection: each is its own obligation.
      let failed: { error: unknown } | undefined;
      for (const command of candidates.values()) {
        try {
          await this.inspect(command);
        } catch (error) {
          failed ??= { error };
          this.deps.store.logEvent("round_stage_supervisor_command_error", command.pr, {
            command_id: command.id,
            round_no: command.round_no,
            error: String(error),
          });
        }
      }
      if (failed) throw failed.error;
      this.deps.store.markSupervisorSuccess(ROUND_STAGE_SUPERVISOR, this.now().toISOString());
    } catch (error) {
      this.deps.store.markSupervisorError(
        ROUND_STAGE_SUPERVISOR,
        String(error),
        this.now().toISOString(),
      );
      throw error;
    } finally {
      this.inFlight = false;
    }
  }

  health(at = this.now()): RoundStageSupervisorHealth {
    return roundStageSupervisorHealth(
      this.deps.store.supervisorLease(ROUND_STAGE_SUPERVISOR),
      this.deps.cfg.daemon.round_stage_supervisor_stale_s ?? DEFAULT_ROUND_STAGE_SUPERVISOR_STALE_S,
      at,
    );
  }

  private async finishTerminalRoundCommand(command: SessionCommandRow): Promise<void> {
    // The merits lifecycle already won, but Pi never durably settled. Stop the
    // stale parent before releasing the unique slot; a failed kill leaves the
    // running row due and supervisor health red.
    if (!this.deps.hooks.killSession)
      throw new Error(`cannot release terminal-round command ${command.id}: kill hook unavailable`);
    if ((await this.deps.hooks.killSession(command.pr, command)) === false) return;
    if (!sameSessionCommandOwner(this.deps.store.getSessionCommand(command.id), command)) return;
    const released =
      command.started_at === null
        ? this.deps.store.failActiveSessionCommand(
            command.id,
            `round ${command.round_no} terminal before correlated command start`,
          )
        : this.deps.store.ackSettledSessionCommand(command.id);
    if (released) {
      this.deps.store.logEvent("terminal_round_command_released", command.pr, {
        command_id: command.id,
        round_no: command.round_no,
      });
    }
  }

  /** Within the finalize grace of the verdict FILE that ended `round`. A
   * round the daemon settled from its posting receipt (the session never
   * wrote a usable verdict) has no healthy tail to wait for. */
  private inVerdictTail(round: RoundRow): boolean {
    const finished = Date.parse(round.finished_at ?? "");
    if (!Number.isFinite(finished)) return false;
    if (this.now().getTime() >= finished + this.finalizeGraceMin() * 60_000) return false;
    const settledFromReceipt = this.deps.store.db
      .prepare(
        "SELECT 1 FROM events WHERE kind = 'verdict_settled_from_receipt' AND pr = ? AND json_extract(payload, '$.round_id') = ? LIMIT 1",
      )
      .get(round.pr, round.id);
    return settledFromReceipt === undefined;
  }

  /** `[daemon] round_finalize_grace_min`. */
  private finalizeGraceMin(): number {
    return this.deps.cfg.daemon.round_finalize_grace_min ?? DEFAULT_ROUND_FINALIZE_GRACE_MIN;
  }

  private verdictPending(command: SessionCommandRow): boolean {
    return (
      command.round_no !== null &&
      existsSync(join(this.deps.verdictDir, `pr-${command.pr}-round-${command.round_no}.json`))
    );
  }

  private async inspect(snapshot: SessionCommandRow): Promise<void> {
    const command = this.deps.store.getSessionCommand(snapshot.id);
    if (!command) return;
    const nowIso = this.now().toISOString();
    const due = command.next_check_at <= nowIso;
    const settled = this.progressShowsSettlement(command);
    if (command.status === "running" && settled && this.awaitingSettlementAck(command)) return;
    let runningRound: RoundRow | undefined;
    if (command.kind === "round" && command.round_no !== null) {
      const round = this.deps.store
        .roundsFor(command.pr)
        .find((row) => row.round_no === command.round_no);
      if (!round) {
        if (due && (command.status === "pending" || command.status === "running")) {
          const reason = `orphan command ${command.id} references missing round ${command.round_no}`;
          if (this.deps.store.failActiveSessionCommand(command.id, reason)) {
            this.deps.store.logAnomaly(
              "session_command_orphaned",
              command.pr,
              command.round_no,
              reason,
            );
          }
        }
        return;
      }
      if (round.status !== "running") {
        // A round its verdict file ended is the session's own finished work:
        // the file is its last action, and its run settles moments later.
        // That tail is left alone for the finalize grace — killing it would
        // cost a healthy conversation — unless the run already settled (the
        // bridge died before its ack) or the round was settled from its
        // receipt because no verdict came.
        if (
          command.status === "running" &&
          (round.status === "done" ||
            (round.status === "cancelled" && round.cancel_cause === "no_new_evidence")) &&
          !settled &&
          this.inVerdictTail(round)
        )
          return;
        // Operator cancellation/head movement already ended the round. Stop an
        // owned Pi run immediately (not at its old hard deadline) before the
        // cancelled command releases the successor slot. Pending was never
        // submitted because bridge reservation precedes send, so it is safe
        // to fail directly.
        if (command.status === "running") await this.finishTerminalRoundCommand(command);
        else if (command.status === "pending") {
          this.deps.store.failPendingSessionCommand(
            command.id,
            `round ${command.round_no} terminal before command start`,
          );
        }
        return;
      }
      runningRound = round;
      const successor = this.deps.store.successorFor(command.pr);
      if (
        successor?.predecessor_round_id === round.id &&
        command.started_at === null &&
        (command.status === "pending" || command.status === "running")
      ) {
        await this.failRound(
          command,
          "command_start",
          `round ${round.round_no} was superseded before command start by fresh head ${successor.head_sha}`,
        );
        return;
      }
    } else if (command.status === "running" && settled) {
      await this.finishTerminalRoundCommand(command);
      return;
    }
    if (command.status === "running" && settled) {
      if (!due && this.hasDeferredStageCheck(command)) return;
      await this.settledWithoutVerdict(command);
      return;
    }
    if (this.verdictPending(command)) return; // the 10s verdict sweep owns it
    if (command.status === "running" && command.started_at !== null && runningRound) {
      // Initial stage detection precedes the ordinary hard-cap check. Once
      // recovery explicitly defers, its durable retry time owns the next probe.
      if (!due && this.hasDeferredStageCheck(command)) return;
      if (await this.executionStageExpired(command, runningRound)) return;
    }
    if (!due) return;

    if (command.status === "failed") {
      const detail = command.failure ?? `command ${command.id} failed without detail`;
      if (command.kind === "round") {
        await this.failRound(
          command,
          command.started_at === null ? "command_start" : "running_hard_bound",
          detail,
        );
      } else {
        await this.recoverNonRound(command, detail);
      }
      return;
    }
    if (command.status === "acked") {
      await this.settledWithoutVerdict(command);
      return;
    }
    if (command.status !== "pending" && command.status !== "running") return;
    if (command.started_at === null) {
      await this.missingStart(command);
      return;
    }
    if (this.progressShowsSettlement(command)) {
      await this.settledWithoutVerdict(command);
      return;
    }
    await this.runningHardBound(command);
  }

  private async missingStart(command: SessionCommandRow): Promise<void> {
    let receipt: boolean | null = null;
    let alive: boolean | null = null;
    try {
      alive = this.deps.hooks.sessionAlive ? await this.deps.hooks.sessionAlive(command.pr) : null;
    } catch {
      alive = null;
    }
    try {
      receipt = this.deps.hooks.wakeReceiptPresent
        ? await this.deps.hooks.wakeReceiptPresent(
            command.pr,
            sessionCommandMarker(command.id, command.payload_sha256),
            Date.parse(command.created_at),
          )
        : null;
    } catch {
      receipt = null;
    }

    if (receipt === true && alive === false) {
      const reason = `command ${command.id} has an accepted marker but its session is dead before durable settlement`;
      this.deps.store.logEvent("session_command_evidence_contradictory", command.pr, {
        command_id: command.id,
        round_no: command.round_no,
        receipt: true,
        session_alive: false,
      });
      if (command.kind === "round" && command.round_no !== null) {
        await this.failRound(command, "command_start", reason);
      } else {
        await this.recoverNonRound(command, reason);
      }
      return;
    }

    if (receipt === true) {
      const progress = this.matchingProgress(command);
      // If the bridge missed its SQLite start stamp, use exact progress
      // identity when available. Otherwise the already-expired start lease is
      // the conservative latest possible origin — never observation time,
      // which would let a long daemon outage reset the hard cap.
      const origin = progress?.run_started_at ?? command.next_check_at;
      const hardAt = new Date(this.hardDeadlineMs(origin, command)).toISOString();
      if (this.deps.store.observeSessionCommandStarted(command.id, origin, hardAt)) {
        this.deps.store.logEvent("session_command_start_reconciled", command.pr, {
          command_id: command.id,
          round_no: command.round_no,
          started_at: origin,
          hard_deadline_at: hardAt,
        });
        const reconciled = this.deps.store.getSessionCommand(command.id);
        if (reconciled && this.now().getTime() >= Date.parse(hardAt))
          await this.runningHardBound(reconciled);
      }
      return;
    }

    // The worker's ack is its receipt: a command with no correlated start by
    // its lease is definitively not delivered.
    const reason = `command ${command.id} has no correlated start before ${command.next_check_at}`;
    // A missing prompt is a delivery fault, so redelivery comes first.
    // A live session with no order is IDLE, not wedged — the kill-and-replay
    // recovery below costs its whole conversation, so it runs only when the
    // session is provably dead or its bounded redeliveries are spent.
    if (alive === true && (await this.redeliverFirst(command, reason))) return;
    await this.recoverMissingStart(command, reason);
  }

  /**
   * Redeliver a command that never started into the
   * same live session — the same row and bytes, no kill — up to
   * `[daemon] max_prompt_redeliveries` times. True when this check is
   * answered (redelivered, or the command started/settled/was reserved
   * meanwhile); false hands over to the kill-and-replay recovery: no
   * redelivery hook, the budget spent, or no live, bridge-ready session.
   */
  private async redeliverFirst(command: SessionCommandRow, reason: string): Promise<boolean> {
    const hook = this.deps.hooks.redeliverSessionCommand;
    if (!hook) return false;
    const cap = this.deps.cfg.daemon.max_prompt_redeliveries ?? DEFAULT_MAX_PROMPT_REDELIVERIES;
    if (command.redeliveries >= cap) {
      this.deps.store.logEvent("session_command_redelivery_exhausted", command.pr, {
        command_id: command.id,
        kind: command.kind,
        round_no: command.round_no,
        redeliveries: command.redeliveries,
        cap,
        reason,
      });
      return false;
    }
    let result: Awaited<ReturnType<typeof hook>>;
    let error: string | null = null;
    try {
      // The row as THIS check found it due: the hook's CAS is on it, so a
      // bridge reservation made since (a fresh lease) answers `raced`.
      result = await hook.call(this.deps.hooks, command.id, {
        attempt: command.attempt,
        redeliveries: command.redeliveries,
        next_check_at: command.next_check_at,
      });
    } catch (err) {
      result = "redelivery_failed";
      error = String(err);
    }
    const payload = {
      command_id: command.id,
      kind: command.kind,
      round_no: command.round_no,
      result,
      redelivery: command.redeliveries + 1,
      cap,
      reason,
      ...(error ? { error } : {}),
    };
    if (result === "redelivered") {
      this.deps.store.logEvent("session_command_redelivered", command.pr, payload);
      return true;
    }
    if (result === "started" || result === "settled") {
      this.deps.store.logEvent("session_command_redelivery_raced", command.pr, payload);
      return true;
    }
    if (result === "raced") {
      // A bridge reserved it after this check found it due: its own start
      // lease runs from that reservation and is never cut short. Only a row
      // still due is looked at again one interval on (no hot loop).
      const current = this.deps.store.getSessionCommand(command.id);
      if (!current || current.next_check_at <= this.now().toISOString())
        this.deps.store.scheduleSessionCommandCheck(
          command.id,
          this.deadlineFromNowSeconds(
            this.deps.cfg.daemon.session_command_unknown_grace_s ??
              DEFAULT_SESSION_COMMAND_UNKNOWN_GRACE_S,
          ),
        );
      this.deps.store.logEvent("session_command_redelivery_raced", command.pr, payload);
      return true;
    }
    this.deps.store.logEvent("session_command_redelivery_skipped", command.pr, payload);
    return false;
  }

  /**
   * Admit one automatic process recovery, for a round command and an ordinary
   * wake alike, and hand back the retry hook to run it with.
   *
   * An unbound production adapter is an unhealthy supervisor, not spent
   * recovery: it throws, keeping the command due so wiring can be repaired
   * and the same bytes replayed without inventing operator debt at 0/N. The
   * allowance is spent BEFORE any tmux/filesystem work, so a generation that
   * dies before a bridge reserves the row still advances the finite bound.
   */
  private admitRecovery(
    command: SessionCommandRow,
    retryCap: number,
    what: "round command" | "command",
  ): NonNullable<SessionHooks["retrySessionCommand"]> {
    const hook = this.deps.hooks.retrySessionCommand;
    if (!hook) {
      throw new Error(
        `${what} ${command.id} retry hook unavailable with ${command.recovery_attempts}/${retryCap} recoveries spent`,
      );
    }
    if (!this.deps.store.beginSessionCommandRecovery(command.id, command.recovery_attempts)) {
      throw new Error(`${what} ${command.id} lost its automatic-recovery claim`);
    }
    return (id, reason) => hook.call(this.deps.hooks, id, reason);
  }

  private async recoverMissingStart(command: SessionCommandRow, reason: string): Promise<void> {
    if (command.kind !== "round") {
      await this.recoverNonRound(command, reason);
      return;
    }
    const retryCap =
      this.deps.cfg.daemon.session_command_max_start_retries ??
      DEFAULT_SESSION_COMMAND_MAX_START_RETRIES;
    // Process rebirths and bridge reservations are different counters; the
    // admission spends the process-recovery allowance first (`admitRecovery`).
    if (command.recovery_attempts < retryCap) {
      const retry = this.admitRecovery(command, retryCap, "round command");
      const recoveryAttempt = command.recovery_attempts + 1;
      const result = await retry(command.id, reason);
      if (result === "retried") {
        const replayed = this.deps.store.getSessionCommand(command.id);
        this.deps.store.logEvent("session_command_start_recovery", command.pr, {
          command_id: command.id,
          round_no: command.round_no,
          recovery_attempt: recoveryAttempt,
          delivery_attempt: replayed?.attempt ?? command.attempt,
          retry_cap: retryCap,
          reason,
        });
        return;
      }
      if (result === "round_finished") {
        this.deps.store.failActiveSessionCommand(
          command.id,
          `round finished during start recovery: ${reason}`,
        );
        return;
      }
      if (result === "settled") {
        this.deps.store.logEvent("session_command_start_settled_race", command.pr, {
          command_id: command.id,
          round_no: command.round_no,
          recovery_attempt: recoveryAttempt,
        });
        return;
      }
      if (result === "raced") {
        this.deps.store.logEvent("session_command_recovery_owner_changed", command.pr, {
          command_id: command.id,
        });
        return; // The current reservation retains its own finite check/deadline.
      }
      if (result === "accepted_race") {
        const raced = `command ${command.id} became accepted while start recovery stopped its old session`;
        if (command.kind === "round" && command.round_no !== null)
          await this.failRound(command, "command_start", raced);
        else if (this.deps.store.failActiveSessionCommand(command.id, raced))
          this.deps.store.logAnomaly("session_command_failed", command.pr, null, raced);
        return;
      }
      // A failed rebirth leaves the same pending row due. Throw so the scan's
      // durable health is red; the next finite tick retries instead of losing
      // the only obligation by terminalizing it first.
      const failed = this.deps.store.getSessionCommand(command.id);
      throw new Error(
        `command ${command.id} start recovery failed before replay: ${failed?.failure ?? reason}`,
      );
    }

    const effectiveReason = command.failure?.trim() || reason;
    this.deps.store.logEvent("session_command_start_failed", command.pr, {
      command_id: command.id,
      round_no: command.round_no,
      recovery_attempts: command.recovery_attempts,
      delivery_attempts: command.attempt,
      retry_cap: retryCap,
      reason: effectiveReason,
    });
    if (command.kind === "round" && command.round_no !== null) {
      await this.failRound(command, "command_start", effectiveReason);
    } else if (this.deps.store.failActiveSessionCommand(command.id, effectiveReason)) {
      this.deps.store.logAnomaly(
        "session_command_failed",
        command.pr,
        null,
        `${effectiveReason}; ordinary wake remains failed and blocks successors`,
      );
    }
  }

  private hasDeferredStageCheck(command: SessionCommandRow): boolean {
    return (
      this.deps.store.db
        .prepare(
          `SELECT 1 FROM events WHERE pr = ? AND kind IN ('round_stage_recovery_deferred', 'round_stage_posted_tail_wait')
       AND json_extract(payload, '$.command_id') = ?
       AND json_extract(payload, '$.next_check_at') = ? LIMIT 1`,
        )
        .get(command.pr, command.id, command.next_check_at) !== undefined
    );
  }

  private matchingProgress(command: SessionCommandRow): RoundProgressSnapshot | undefined {
    if (!this.deps.progress) return undefined;
    const progress = this.deps.progress(command.pr);
    if (
      !progress ||
      progress.pr !== command.pr ||
      progress.session !== command.session ||
      progress.command_id !== command.id ||
      progress.command_sha256 !== command.payload_sha256
    )
      return undefined;
    return progress;
  }

  /** v2 milestones are observational proof for earlier finite bounds. Missing,
   * legacy or mismatched telemetry stays UNKNOWN and falls through to the
   * immutable hard runtime cap; activity can never renew a lease. */
  private correlatedExecutionProgress(
    command: SessionCommandRow,
  ): RoundProgressSnapshot | undefined {
    if (command.started_at === null) return undefined;
    const progress = this.matchingProgress(command);
    if (!progress || progress.version !== 2) return undefined;
    const runStarted = Date.parse(progress.run_started_at);
    const accepted = Date.parse(progress.command_accepted_at ?? "");
    if (
      !runStartsNear(command.started_at, progress.run_started_at) ||
      !Number.isFinite(accepted) ||
      accepted < runStarted
    )
      return undefined;
    return progress;
  }

  private async executionStageExpired(
    command: SessionCommandRow,
    round: RoundRow,
  ): Promise<boolean> {
    const progress = this.correlatedExecutionProgress(command);
    if (!progress) return false;
    const started = Date.parse(command.started_at!);
    const now = this.now().getTime();
    const minute = 60_000;
    const sweepOwed = round.sweep_owed === 1;
    const passesMaxMin =
      (this.deps.cfg.daemon.round_passes_max_min ?? DEFAULT_ROUND_PASSES_MAX_MIN) +
      (sweepOwed ? this.sweepExtraMin() : 0);
    const deadlines = roundStageDeadlines(
      started,
      resolveRoundStageBounds(this.deps.cfg.daemon),
      sweepOwed,
    );
    const firstPassAt = deadlines.first_pass_start;
    const passesAt = deadlines.passes_complete;
    const hardAt = deadlines.running_hard_bound;
    const planned = round.lenses
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);

    // The extension's generic subagent milestone is descriptive only. The
    // finite gate opens solely when exact correlated progress names one of the
    // authoritative planned DISCOVERY lenses — validator-first, an added lens
    // or a foreign tool cannot buy a later failure class.
    const fanoutAgents = plannedFanoutAgents(progress, planned);
    const plannedFanout = fanoutAgents.length > 0;
    if (plannedFanout) {
      const firstStarted = fanoutAgents.map((agent) => agent.started_at!).sort()[0]!;
      this.deps.store.recordRoundFanoutStarted(round.id, command.id, firstStarted);
    }
    if (!plannedFanout && now >= firstPassAt) {
      await this.failRound(
        command,
        "first_pass_start",
        `command ${command.id} was accepted and preparing, but no planned pass started (fanout milestone absent) within ${this.deps.cfg.daemon.round_first_pass_max_min ?? DEFAULT_ROUND_FIRST_PASS_MAX_MIN} minutes`,
      );
      return true;
    }
    if (!plannedFanout) return false;

    const terminal = isTerminalAgentStatus;
    // A sweep-owed round's planned (delta-stage) lens is judged by its FIRST
    // execution only: a later run of the same lens is the sweep's, started
    // after the delta stage, and counts as ADDED — never as this lens missing.
    const deltaStage = sweepOwed ? firstExecutionPerLens(progress.agents) : null;
    const missing = planned.filter((name) => {
      if (deltaStage) {
        const first = deltaStage.get(name);
        return first === undefined || !terminal(first.status);
      }
      const executions = progress.agents.filter((agent) => lensForAgent(agent.agent) === name);
      return !executionsComplete(executions);
    });
    const addedRunning = progress.agents
      .filter(
        (agent) =>
          (!planned.includes(lensForAgent(agent.agent)) ||
            (deltaStage !== null && deltaStage.get(lensForAgent(agent.agent)) !== agent)) &&
          !terminal(agent.status),
      )
      .map((agent) => agent.agent);
    if ((missing.length > 0 || addedRunning.length > 0) && now >= passesAt) {
      const outstanding = [...missing, ...addedRunning].join(", ");
      await this.failRound(
        command,
        "passes_incomplete",
        `command ${command.id} did not terminalize every planned/observed pass within ${passesMaxMin} minutes; outstanding: ${outstanding}`,
      );
      return true;
    }
    if (missing.length > 0 || addedRunning.length > 0) return false;

    const finished = progress.agents.map((agent) => Date.parse(agent.finished_at ?? ""));
    if (
      planned.length === 0 ||
      finished.length === 0 ||
      finished.some((value) => !Number.isFinite(value))
    )
      return false;
    const allFinishedAt = Math.max(...finished);
    const finalizeAt = Math.min(allFinishedAt + this.finalizeGraceMin() * minute, hardAt);
    if (now < finalizeAt) return false;
    // The grace measures how long the PARENT has been left with
    // nothing to wait for — and a parent whose run is still ACTIVE (writing
    // its ledger, validating, posting) is not idle. While the correlated
    // snapshot says `active`, finalize does not fire. This is not a lease
    // renewal: nothing here moves a deadline, and activity still can never
    // renew one. The fixed start-derived hard bound binds unconditionally.
    //
    // Staleness: `active` is trusted only from the snapshot already matched
    // above on command id + payload sha + run start (`correlatedExecution
    // Progress`), never from its age — a parent deep in one long model turn
    // writes nothing for minutes, and an updated_at freshness rule would
    // bring back exactly the kill this fixes. A frozen snapshot (the
    // extension or pi died mid-run) is caught two ways: a session tmux
    // provably reports dead is not trusted (finalize fires as before), and
    // anything else waits at most for the hard bound.
    if (progress.parent_status === "active" && (await this.parentMayBeRunning(command))) {
      if (now >= hardAt) {
        await this.runningHardBound(command);
        return true;
      }
      if (!this.finalizeHeld.has(command.id)) {
        if (this.finalizeHeld.size >= 1_000) this.finalizeHeld.clear(); // a log dedupe, never state
        this.finalizeHeld.add(command.id);
        this.deps.store.logEvent("round_finalize_held_parent_active", command.pr, {
          command_id: command.id,
          round_no: command.round_no,
          passes_finished_at: new Date(allFinishedAt).toISOString(),
          hard_deadline_at: new Date(hardAt).toISOString(),
        });
      }
      return false;
    }
    await this.failRound(
      command,
      "parent_finalize",
      `command ${command.id} left all observed passes terminal without a verdict for ${this.finalizeGraceMin()} minutes`,
    );
    return true;
  }

  /** False only when the session is PROVABLY gone (tmux says so). Unknown
   * (no hook, a probe that threw) keeps the active snapshot's word: the hard
   * bound is the backstop for everything this cannot see. */
  private async parentMayBeRunning(command: SessionCommandRow): Promise<boolean> {
    if (!this.deps.hooks.sessionAlive) return true;
    try {
      return (await this.deps.hooks.sessionAlive(command.pr)) !== false;
    } catch {
      return true;
    }
  }

  private progressShowsSettlement(command: SessionCommandRow): boolean {
    if (command.started_at === null) return false;
    const progress = this.matchingProgress(command);
    if (!progress || progress.parent_status !== "settled") return false;
    const started = Date.parse(command.started_at);
    const updated = Date.parse(progress.updated_at);
    return (
      runStartsNear(command.started_at, progress.run_started_at) &&
      Number.isFinite(updated) &&
      updated >= started
    );
  }

  /** agent_settled progress precedes the bridge's zero-delay ack callback.
   * Give that callback one finite grace, persisted across daemon restarts.
   * Later observations never extend it and the immutable hard bound wins. */
  private awaitingSettlementAck(command: SessionCommandRow): boolean {
    const prior = this.deps.store.db
      .prepare(
        `SELECT json_extract(payload, '$.wait_until') AS wait_until FROM events
       WHERE kind='session_command_settlement_ack_wait' AND pr=?
         AND json_extract(payload, '$.command_id')=?
         AND json_extract(payload, '$.attempt')=?
       ORDER BY id DESC LIMIT 1`,
      )
      .get(command.pr, command.id, command.attempt) as { wait_until: string } | undefined;
    const until = prior
      ? Date.parse(prior.wait_until)
      : Math.min(this.now().getTime() + 1_000, this.hardDeadlineMs(command.started_at!, command));
    if (!Number.isFinite(until) || this.now().getTime() >= until) return false;
    if (!prior)
      this.deps.store.logEvent("session_command_settlement_ack_wait", command.pr, {
        command_id: command.id,
        attempt: command.attempt,
        wait_until: new Date(until).toISOString(),
      });
    this.deps.store.scheduleSessionCommandCheck(command.id, new Date(until).toISOString());
    return true;
  }

  private async settledWithoutVerdict(command: SessionCommandRow): Promise<void> {
    const reason = `command ${command.id} settled without verdict for round ${command.round_no}`;
    if (command.status === "running") {
      // Pi settled but the bridge did not durably ack. Its callback returned
      // with an in-memory barrier still armed, so merely repairing SQLite
      // would strand the successor file. Restart that stale bridge first.
      if (!this.deps.hooks.killSession)
        throw new Error(
          `cannot recover unacked settled command ${command.id}: kill hook unavailable`,
        );
      if ((await this.deps.hooks.killSession(command.pr, command)) === false) return;
      if (!sameSessionCommandOwner(this.deps.store.getSessionCommand(command.id), command)) return;
    }
    this.deps.store.logEvent("round_settled_without_verdict", command.pr, {
      command_id: command.id,
      round_no: command.round_no,
      settled_at: command.settled_at,
    });
    if (command.round_no !== null) await this.failRound(command, "settled_without_verdict", reason);
  }

  /** `[daemon] follow_up_sweep_extra_min`. */
  private sweepExtraMin(): number {
    return this.deps.cfg.daemon.follow_up_sweep_extra_min ?? DEFAULT_FOLLOW_UP_SWEEP_EXTRA_MIN;
  }

  /** The command's fixed running cap in minutes: the configured bound, plus
   * the sweep allowance when it carries a round whose pre-approval sweep is
   * owed. Derived from the round ROW, never from progress. */
  private runningMaxMin(command: SessionCommandRow, round?: RoundRow): number {
    const base =
      this.deps.cfg.daemon.session_command_running_max_min ??
      DEFAULT_SESSION_COMMAND_RUNNING_MAX_MIN;
    if (command.kind !== "round" || command.round_no === null) return base;
    const row =
      round ??
      this.deps.store.roundsFor(command.pr).find((item) => item.round_no === command.round_no);
    return row?.sweep_owed === 1 ? base + this.sweepExtraMin() : base;
  }

  /** The fixed running deadline (epoch ms) of a command whose run began at
   * `origin`: the origin plus `runningMaxMin`. */
  private hardDeadlineMs(origin: string, command: SessionCommandRow, round?: RoundRow): number {
    return Date.parse(origin) + this.runningMaxMin(command, round) * 60_000;
  }

  private async runningHardBound(command: SessionCommandRow): Promise<void> {
    const maxMin = this.runningMaxMin(command);
    const hardAt = new Date(this.hardDeadlineMs(command.started_at!, command)).toISOString();
    if (this.now().getTime() < Date.parse(hardAt)) {
      // Upgrade/restart reconciliation: an older bridge may have written a
      // shorter advisory check. Move it to the FIXED start-derived cap; never
      // derive this from activity or progress telemetry.
      this.deps.store.scheduleSessionCommandCheck(command.id, hardAt);
      return;
    }
    const reason = `command ${command.id} exceeded its fixed ${maxMin}-minute running bound (started ${command.started_at})`;
    this.deps.store.logEvent("session_command_running_bound_exhausted", command.pr, {
      command_id: command.id,
      round_no: command.round_no,
      started_at: command.started_at,
      hard_deadline_at: hardAt,
    });
    if (command.kind === "round" && command.round_no !== null) {
      await this.failRound(command, "running_hard_bound", reason);
    } else {
      await this.recoverNonRound(command, reason);
    }
  }

  /** Ordinary wakes own conversation work rather than a merits round. Replay
   * the same row/bytes after the production hook fences the old Pi; never
   * convert the payload back into the capped held-wake queue. */
  private async recoverNonRound(command: SessionCommandRow, reason: string): Promise<void> {
    const retryCap =
      this.deps.cfg.daemon.session_command_max_start_retries ??
      DEFAULT_SESSION_COMMAND_MAX_START_RETRIES;
    const effectiveReason = command.failure?.trim() || reason;
    if (command.recovery_attempts < retryCap) {
      const retry = this.admitRecovery(command, retryCap, "command");
      const recoveryAttempt = command.recovery_attempts + 1;
      const result = await retry(command.id, effectiveReason);
      if (result === "retried") {
        const replayed = this.deps.store.getSessionCommand(command.id);
        this.deps.store.logEvent("session_command_nonround_recovery", command.pr, {
          command_id: command.id,
          kind: command.kind,
          recovery_attempt: recoveryAttempt,
          retry_cap: retryCap,
          delivery_attempt: replayed?.attempt ?? command.attempt,
          reason: effectiveReason,
        });
        return;
      }
      if (result === "settled") {
        this.deps.store.logEvent("session_command_nonround_settled_race", command.pr, {
          command_id: command.id,
          kind: command.kind,
          reason: effectiveReason,
        });
        return;
      }
      if (result === "raced") {
        this.deps.store.logEvent("session_command_recovery_owner_changed", command.pr, {
          command_id: command.id,
        });
        return; // The current reservation retains its own finite check/deadline.
      }
      if (result === "accepted_race") {
        const next = this.deadlineFromNowSeconds(
          this.deps.cfg.daemon.session_command_unknown_grace_s ??
            DEFAULT_SESSION_COMMAND_UNKNOWN_GRACE_S,
        );
        this.deps.store.scheduleSessionCommandCheck(command.id, next);
        this.deps.store.logEvent("session_command_nonround_recovery_deferred", command.pr, {
          command_id: command.id,
          next_check_at: next,
          reason: "acceptance won recovery race",
        });
        return;
      }
      // A failed fence/rebirth leaves the same command as the only obligation.
      // Keep supervisor health red; never release it or submit a successor.
      const failed = this.deps.store.getSessionCommand(command.id);
      throw new Error(
        `command ${command.id} non-round recovery failed before replay: ${failed?.failure ?? effectiveReason}`,
      );
    }

    if (!this.deps.hooks.killSession) {
      throw new Error(`cannot exhaust non-round command ${command.id}: kill hook unavailable`);
    }
    if ((await this.deps.hooks.killSession(command.pr, command)) === false) return;
    const current = this.deps.store.getSessionCommand(command.id);
    // Settlement or explicit operator cancellation may win while the fence is
    // in flight. Both terminalize this supervisor obligation; never reopen a
    // failure over the operator's successful reset.
    if (!current || current.status === "acked" || current.status === "cancelled") return;
    if (current.status === "pending" || current.status === "running") {
      if (!this.deps.store.failActiveSessionCommand(command.id, effectiveReason)) return;
    }
    const failed = this.deps.store.getSessionCommand(command.id);
    if (!failed || failed.status !== "failed") return;
    const row = this.deps.store.getPr(command.pr);
    this.deps.store.openReviewFailure({
      pr: command.pr,
      command_id: command.id,
      round_id: null,
      round_no: null,
      head_sha: row?.head_sha ?? "",
      stage: "session_command",
      detail: effectiveReason,
      attempts: failed.recovery_attempts,
      retry_cap: retryCap,
    });
    this.deps.store.logAnomaly(
      "session_command_recovery_exhausted",
      command.pr,
      null,
      `${effectiveReason}; automatic process recovery exhausted and operator recovery is required`,
    );
  }

  private async failRound(
    command: SessionCommandRow,
    stage: RoundInfrastructureStage,
    detail: string,
  ): Promise<void> {
    const disposition = await this.deps.onRoundFailure(
      command.pr,
      command.round_no!,
      stage,
      `${detail}; command=${command.id}`,
    );
    if (disposition === "retryable" || disposition === "posted_wait") {
      let next = this.deadlineFromNowSeconds(
        this.deps.cfg.daemon.session_command_unknown_grace_s ??
          DEFAULT_SESSION_COMMAND_UNKNOWN_GRACE_S,
      );
      if (disposition === "posted_wait") {
        // A posted tail's fixed end is an earlier obligation than the retry
        // interval; preserve that boundary without probing every scan.
        const tail = this.deps.store.db
          .prepare(
            `SELECT json_extract(payload, '$.wait_until') AS wait_until FROM events
           WHERE pr = ? AND kind = 'round_stage_posted_wait'
           AND json_extract(payload, '$.round_no') = ? ORDER BY id DESC LIMIT 1`,
          )
          .get(command.pr, command.round_no) as { wait_until: string } | undefined;
        if (tail && Number.isFinite(Date.parse(tail.wait_until)) && tail.wait_until < next)
          next = tail.wait_until;
      }
      this.deps.store.scheduleSessionCommandCheck(command.id, next);
      this.deps.store.logEvent(
        disposition === "posted_wait"
          ? "round_stage_posted_tail_wait"
          : "round_stage_recovery_deferred",
        command.pr,
        {
          command_id: command.id,
          round_no: command.round_no,
          stage,
          disposition,
          next_check_at: next,
          detail,
        },
      );
      return;
    }
    if (disposition === "settled") {
      // The round terminalized cleanly (a guard-2 refusal recorded as a
      // no-op, or a round settled from its posting receipt). The command was
      // delivered and did its work; failing it here would leave a blocking
      // failed command on a PR that owes nothing.
      this.deps.store.logEvent("round_stage_recovery", command.pr, {
        command_id: command.id,
        round_no: command.round_no,
        stage,
        disposition,
        detail,
      });
      return;
    }

    const current = this.deps.store.getSessionCommand(command.id);
    if (current?.status === "acked") this.deps.store.failSettledSessionCommand(command.id, detail);
    else if (current?.status === "pending" || current?.status === "running")
      this.deps.store.failActiveSessionCommand(command.id, detail);
    this.deps.store.logEvent("round_stage_recovery", command.pr, {
      command_id: command.id,
      round_no: command.round_no,
      stage,
      disposition,
      detail,
    });
    if (disposition === "exhausted") {
      // The recovery callback owns the atomic round+command+failure handoff.
      // Never open it again here: operator `u` may already have recovered the
      // incident while this awaited callback was returning. A historical row
      // (open or recovered) proves the callback committed the obligation.
      const failure = this.deps.store.reviewFailureForCommand(command.id);
      if (!failure || failure.round_no !== command.round_no || failure.stage !== stage) {
        throw new Error(
          `round failure callback returned exhausted without durable exact debt for command ${command.id}`,
        );
      }
      if (failure.work_owed === 1) {
        this.deps.store.logAnomaly(
          "round_stage_recovery_exhausted",
          command.pr,
          command.round_no,
          `${stage}: ${detail}; automatic recovery exhausted and work remains owed as ${failure.incident_id}`,
        );
      } else {
        this.deps.store.logEvent("round_stage_recovery_already_resolved", command.pr, {
          command_id: command.id,
          round_no: command.round_no,
          stage,
          incident_id: failure.incident_id,
          recovery: failure.recovery,
        });
      }
    }
  }

  private deadlineFromNowSeconds(seconds: number): string {
    return new Date(this.now().getTime() + seconds * 1000).toISOString();
  }
}

export function roundStageSupervisorHealth(
  lease: SupervisorLeaseRow | undefined,
  staleAfterS: number,
  now: Date,
): RoundStageSupervisorHealth {
  const reference = lease?.last_success_at ?? lease?.last_attempt_at ?? null;
  const ageMs = reference === null ? 0 : now.getTime() - Date.parse(reference);
  return {
    healthy:
      reference !== null &&
      Number.isFinite(ageMs) &&
      ageMs <= staleAfterS * 1000 &&
      lease?.last_error == null,
    stale_after_s: staleAfterS,
    last_attempt_at: lease?.last_attempt_at ?? null,
    last_success_at: lease?.last_success_at ?? null,
    last_error_at: lease?.last_error_at ?? null,
    last_error: lease?.last_error ?? null,
  };
}

/** Each lens's FIRST execution, by start (list order breaks ties and stands in
 * for an execution with no start milestone) — a follow-up round's delta
 * stage. */
function firstExecutionPerLens(
  agents: RoundProgressSnapshot["agents"],
): Map<string, RoundProgressSnapshot["agents"][number]> {
  const first = new Map<string, RoundProgressSnapshot["agents"][number]>();
  for (const agent of agents) {
    const lens = lensForAgent(agent.agent);
    const held = first.get(lens);
    if (
      held === undefined ||
      (agent.started_at !== undefined &&
        held.started_at !== undefined &&
        agent.started_at < held.started_at)
    )
      first.set(lens, agent);
  }
  return first;
}

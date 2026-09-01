// bounded daemon→Pi stage supervision.
//
// This is a reconciler over the ONE durable session-command slot, not another
// scheduler. Delivery remains inject-bridge-owned; round recovery remains the
// VerdictWatcher's existing self-requeue path. The supervisor only classifies
// finite start/finish obligations from durable command state + JSONL receipts.
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_MAX_SELF_REQUEUES,
  DEFAULT_ROUND_FINALIZE_GRACE_MIN,
  DEFAULT_ROUND_FIRST_PASS_MAX_MIN,
  DEFAULT_ROUND_PASSES_MAX_MIN,
  DEFAULT_ROUND_STAGE_SUPERVISOR_STALE_S,
  DEFAULT_SESSION_COMMAND_MAX_START_RETRIES,
  DEFAULT_SESSION_COMMAND_RUNNING_MAX_MIN,
  DEFAULT_SESSION_COMMAND_UNKNOWN_GRACE_S,
  DEFAULT_SESSION_COMMAND_UNKNOWN_MAX_CHECKS,
  type Config,
} from "./config.js";
import { sessionCommandMarker } from "./session-command.js";
import type { RoundProgressSnapshot } from "./round-progress.js";
import type { RoundRow, SessionCommandRow, StateStore, SupervisorLeaseRow } from "./state.js";
import type { RoundRecoveryDisposition, SessionHooks } from "./types.js";

export const ROUND_STAGE_SUPERVISOR = "round-stage";

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
  /** Existing bounded round recovery. true = fresh round queued; false = its
   * recovery budget is exhausted and failed work remains owed. */
  /** Independent observational sidecar. It can corroborate a durable start
   * that settled after the bridge died; it never creates/renews a lease. */
  progress?: (pr: number) => RoundProgressSnapshot | undefined;
  onRoundFailure: (
    pr: number,
    roundNo: number,
    stage: RoundInfrastructureStage,
    detail: string,
  ) => Promise<RoundRecoveryDisposition>;
  now?: () => Date;
  log?: (message: string, extra?: unknown) => void;
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
  private readonly log: (message: string, extra?: unknown) => void;
  private inFlight = false;

  constructor(private readonly deps: SessionCommandSupervisorDeps) {
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? (() => {});
  }

  /** One non-overlapping scan. A second timer firing while this awaits Pi
   * evidence returns without touching success, so the durable lease ages and
   * status becomes unhealthy even though the process heartbeat still moves. */
  async scan(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    const attemptedAt = this.now().toISOString();
    this.deps.store.markSupervisorAttempt(ROUND_STAGE_SUPERVISOR, attemptedAt);
    try {
      const candidates = new Map<string, SessionCommandRow>();
      for (const command of this.deps.store.dueSessionCommands(attemptedAt)) candidates.set(command.id, command);
      // A bridge can die after archiving the settled file but before its ack
      // UPDATE. Exact command-correlated progress lets us reconcile that gap
      // immediately instead of waiting for the 45-minute hard deadline.
      for (const command of this.deps.store.activeSessionCommands()) candidates.set(command.id, command);
      for (const command of candidates.values()) await this.inspect(command);
      this.deps.store.markSupervisorSuccess(ROUND_STAGE_SUPERVISOR, this.now().toISOString());
    } catch (error) {
      this.deps.store.markSupervisorError(ROUND_STAGE_SUPERVISOR, String(error), this.now().toISOString());
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
    if (!this.deps.hooks.killSession) throw new Error(`cannot release terminal-round command ${command.id}: kill hook unavailable`);
    await this.deps.hooks.killSession(command.pr);
    const released = command.started_at === null
      ? this.deps.store.failActiveSessionCommand(command.id, `round ${command.round_no} terminal before correlated command start`)
      : this.deps.store.ackSettledSessionCommand(command.id);
    if (released) {
      this.deps.store.logEvent("terminal_round_command_released", command.pr, {
        command_id: command.id,
        round_no: command.round_no,
      });
    }
  }

  private verdictPending(command: SessionCommandRow): boolean {
    return command.round_no !== null && existsSync(join(this.deps.verdictDir, `pr-${command.pr}-round-${command.round_no}.json`));
  }

  private async inspect(snapshot: SessionCommandRow): Promise<void> {
    const command = this.deps.store.getSessionCommand(snapshot.id);
    if (!command) return;
    const nowIso = this.now().toISOString();
    const due = command.next_check_at <= nowIso;
    const settled = this.progressShowsSettlement(command);
    let runningRound: RoundRow | undefined;
    if (command.kind === "round" && command.round_no !== null) {
      const round = this.deps.store.roundsFor(command.pr).find((row) => row.round_no === command.round_no);
      if (!round) {
        if (due && (command.status === "pending" || command.status === "running")) {
          const reason = `orphan command ${command.id} references missing round ${command.round_no}`;
          if (this.deps.store.failActiveSessionCommand(command.id, reason)) {
            this.deps.store.logAnomaly("session_command_orphaned", command.pr, command.round_no, reason);
          }
        }
        return;
      }
      if (round.status !== "running") {
        // Operator cancellation/head movement already ended the round. Stop an
        // owned Pi run immediately (not at its old hard deadline) before the
        // cancelled command releases the successor slot. Pending was never
        // submitted because bridge reservation precedes send, so it is safe
        // to fail directly.
        if (command.status === "running") await this.finishTerminalRoundCommand(command);
        else if (command.status === "pending") {
          this.deps.store.failActiveSessionCommand(command.id, `round ${command.round_no} terminal before command start`);
        }
        return;
      }
      runningRound = round;
      const successor = this.deps.store.successorFor(command.pr);
      if (
        successor?.predecessor_round_id === round.id
        && command.started_at === null
        && (command.status === "pending" || command.status === "running")
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
      await this.settledWithoutVerdict(command);
      return;
    }
    if (this.verdictPending(command)) return; // the 10s verdict sweep owns it
    if (command.status === "running" && command.started_at !== null && runningRound) {
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
    try {
      alive = this.deps.hooks.sessionAlive ? await this.deps.hooks.sessionAlive(command.pr) : null;
    } catch {
      alive = null;
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
      const hardAt = new Date(
        Date.parse(origin) + (this.deps.cfg.daemon.session_command_running_max_min ?? DEFAULT_SESSION_COMMAND_RUNNING_MAX_MIN) * 60_000,
      ).toISOString();
      if (this.deps.store.observeSessionCommandStarted(command.id, origin, hardAt)) {
        this.deps.store.logEvent("session_command_start_reconciled", command.pr, {
          command_id: command.id,
          round_no: command.round_no,
          started_at: origin,
          hard_deadline_at: hardAt,
        });
        const reconciled = this.deps.store.getSessionCommand(command.id);
        if (reconciled && this.now().getTime() >= Date.parse(hardAt)) await this.runningHardBound(reconciled);
      }
      return;
    }

    // A dead session cannot still hold a queued followUp. A readable JSONL
    // without the marker is definitive absence. Everything else is UNKNOWN.
    const definitive = receipt === false || alive === false;
    const unknownCap = this.deps.cfg.daemon.session_command_unknown_max_checks ?? DEFAULT_SESSION_COMMAND_UNKNOWN_MAX_CHECKS;
    if (!definitive && command.unknown_checks < unknownCap) {
      const next = this.deadlineFromNowSeconds(
        this.deps.cfg.daemon.session_command_unknown_grace_s ?? DEFAULT_SESSION_COMMAND_UNKNOWN_GRACE_S,
      );
      if (this.deps.store.deferSessionCommandEvidence(command.id, next)) {
        this.deps.store.logEvent("session_command_evidence_unknown", command.pr, {
          command_id: command.id,
          round_no: command.round_no,
          unknown_check: command.unknown_checks + 1,
          cap: unknownCap,
          next_check_at: next,
        });
      }
      return;
    }

    const reason = definitive
      ? `command ${command.id} has no correlated start before ${command.next_check_at}`
      : `command ${command.id} start evidence remained unknown after ${command.unknown_checks} finite check(s)`;
    await this.recoverMissingStart(command, reason);
  }

  private async recoverMissingStart(command: SessionCommandRow, reason: string): Promise<void> {
    if (command.kind !== "round") {
      await this.recoverNonRound(command, reason);
      return;
    }
    const retryCap = this.deps.cfg.daemon.session_command_max_start_retries ?? DEFAULT_SESSION_COMMAND_MAX_START_RETRIES;
    // attempt=1 is the original submission; retryCap counts additional starts.
    if (command.attempt <= retryCap && this.deps.hooks.retrySessionCommand) {
      const result = await this.deps.hooks.retrySessionCommand(command.id, reason);
      if (result === "retried") {
        this.deps.store.logEvent("session_command_start_recovery", command.pr, {
          command_id: command.id,
          round_no: command.round_no,
          attempt: command.attempt,
          retry_cap: retryCap,
          reason,
        });
        return;
      }
      if (result === "round_finished") {
        this.deps.store.failActiveSessionCommand(command.id, `round finished during start recovery: ${reason}`);
        return;
      }
      if (result === "accepted_race") {
        const raced = `command ${command.id} became accepted while start recovery stopped its old session`;
        if (command.kind === "round" && command.round_no !== null) await this.failRound(command, "command_start", raced);
        else if (this.deps.store.failActiveSessionCommand(command.id, raced)) this.deps.store.logAnomaly("session_command_failed", command.pr, null, raced);
        return;
      }
      // A failed rebirth leaves the same pending row due. Throw so the scan's
      // durable health is red; the next finite tick retries instead of losing
      // the only obligation by terminalizing it first.
      throw new Error(`command ${command.id} start recovery failed before replay`);
    }

    this.deps.store.logEvent("session_command_start_failed", command.pr, {
      command_id: command.id,
      round_no: command.round_no,
      attempts: command.attempt,
      retry_cap: retryCap,
      reason,
    });
    if (command.kind === "round" && command.round_no !== null) {
      await this.failRound(command, "command_start", reason);
    } else if (this.deps.store.failActiveSessionCommand(command.id, reason)) {
      this.deps.store.logAnomaly(
        "session_command_failed",
        command.pr,
        null,
        `${reason}; ordinary wake remains failed and blocks successors`,
      );
    }
  }

  private matchingProgress(command: SessionCommandRow): RoundProgressSnapshot | undefined {
    if (!this.deps.progress) return undefined;
    const progress = this.deps.progress(command.pr);
    if (
      !progress || progress.pr !== command.pr || progress.session !== command.session
      || progress.command_id !== command.id || progress.command_sha256 !== command.payload_sha256
    ) return undefined;
    return progress;
  }

  /** v2 milestones are observational proof for earlier finite bounds. Missing,
   * legacy or mismatched telemetry stays UNKNOWN and falls through to the
   * immutable hard runtime cap; activity can never renew a lease. */
  private correlatedExecutionProgress(command: SessionCommandRow): RoundProgressSnapshot | undefined {
    if (command.started_at === null) return undefined;
    const progress = this.matchingProgress(command);
    if (!progress || progress.version !== 2) return undefined;
    const started = Date.parse(command.started_at);
    const runStarted = Date.parse(progress.run_started_at);
    const accepted = Date.parse(progress.command_accepted_at ?? "");
    if (
      !Number.isFinite(started) || !Number.isFinite(runStarted) || !Number.isFinite(accepted)
      || Math.abs(runStarted - started) > 5_000 || accepted < runStarted
    ) return undefined;
    return progress;
  }

  private async executionStageExpired(command: SessionCommandRow, round: RoundRow): Promise<boolean> {
    const progress = this.correlatedExecutionProgress(command);
    if (!progress) return false;
    const started = Date.parse(command.started_at!);
    const now = this.now().getTime();
    const minute = 60_000;
    const firstPassAt = started + (this.deps.cfg.daemon.round_first_pass_max_min ?? DEFAULT_ROUND_FIRST_PASS_MAX_MIN) * minute;
    const passesAt = started + (this.deps.cfg.daemon.round_passes_max_min ?? DEFAULT_ROUND_PASSES_MAX_MIN) * minute;
    const hardAt = started + (this.deps.cfg.daemon.session_command_running_max_min ?? DEFAULT_SESSION_COMMAND_RUNNING_MAX_MIN) * minute;
    const planned = round.lenses.split(",").map((name) => name.trim()).filter(Boolean);

    if (!progress.first_lens_started_at && now >= firstPassAt) {
      await this.failRound(
        command,
        "first_pass_start",
        `command ${command.id} was accepted but no planned pass started within ${this.deps.cfg.daemon.round_first_pass_max_min ?? DEFAULT_ROUND_FIRST_PASS_MAX_MIN} minutes`,
      );
      return true;
    }
    if (!progress.first_lens_started_at) return false;

    const terminal = (status: string): boolean => status === "completed" || status === "failed";
    const missing = planned.filter((name) => {
      const executions = progress.agents.filter((agent) => agent.agent === name);
      return executions.length === 0 || executions.some((agent) => !terminal(agent.status));
    });
    const addedRunning = progress.agents.filter((agent) => !planned.includes(agent.agent) && !terminal(agent.status)).map((agent) => agent.agent);
    if ((missing.length > 0 || addedRunning.length > 0) && now >= passesAt) {
      const outstanding = [...missing, ...addedRunning].join(", ");
      await this.failRound(
        command,
        "passes_incomplete",
        `command ${command.id} did not terminalize every planned/observed pass within ${this.deps.cfg.daemon.round_passes_max_min ?? DEFAULT_ROUND_PASSES_MAX_MIN} minutes; outstanding: ${outstanding}`,
      );
      return true;
    }
    if (missing.length > 0 || addedRunning.length > 0) return false;

    const finished = progress.agents.map((agent) => Date.parse(agent.finished_at ?? ""));
    if (planned.length === 0 || finished.length === 0 || finished.some((value) => !Number.isFinite(value))) return false;
    const allFinishedAt = Math.max(...finished);
    const finalizeAt = Math.min(
      allFinishedAt + (this.deps.cfg.daemon.round_finalize_grace_min ?? DEFAULT_ROUND_FINALIZE_GRACE_MIN) * minute,
      hardAt,
    );
    if (now < finalizeAt) return false;
    await this.failRound(
      command,
      "parent_finalize",
      `command ${command.id} left all observed passes terminal without a verdict for ${this.deps.cfg.daemon.round_finalize_grace_min ?? DEFAULT_ROUND_FINALIZE_GRACE_MIN} minutes`,
    );
    return true;
  }

  private progressShowsSettlement(command: SessionCommandRow): boolean {
    if (command.started_at === null) return false;
    const progress = this.matchingProgress(command);
    if (!progress || progress.parent_status !== "settled") return false;
    const started = Date.parse(command.started_at);
    const runStarted = Date.parse(progress.run_started_at);
    const updated = Date.parse(progress.updated_at);
    return Number.isFinite(started) && Number.isFinite(runStarted) && Number.isFinite(updated)
      && runStarted >= started - 5_000 && runStarted <= started + 5_000 && updated >= started;
  }

  private async settledWithoutVerdict(command: SessionCommandRow): Promise<void> {
    const reason = `command ${command.id} settled without verdict for round ${command.round_no}`;
    if (command.status === "running") {
      // Pi settled but the bridge did not durably ack. Its callback returned
      // with an in-memory barrier still armed, so merely repairing SQLite
      // would strand the successor file. Restart that stale bridge first.
      if (!this.deps.hooks.killSession) throw new Error(`cannot recover unacked settled command ${command.id}: kill hook unavailable`);
      await this.deps.hooks.killSession(command.pr);
    }
    this.deps.store.logEvent("round_settled_without_verdict", command.pr, {
      command_id: command.id,
      round_no: command.round_no,
      settled_at: command.settled_at,
    });
    if (command.round_no !== null) await this.failRound(command, "settled_without_verdict", reason);
  }

  private async runningHardBound(command: SessionCommandRow): Promise<void> {
    const maxMin = this.deps.cfg.daemon.session_command_running_max_min ?? DEFAULT_SESSION_COMMAND_RUNNING_MAX_MIN;
    const hardAt = new Date(Date.parse(command.started_at!) + maxMin * 60_000).toISOString();
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
    const retryCap = this.deps.cfg.daemon.session_command_max_start_retries ?? DEFAULT_SESSION_COMMAND_MAX_START_RETRIES;
    if (command.recovery_attempts < retryCap) {
      // An unbound production adapter is an unhealthy supervisor, not spent
      // recovery. Keep the failed command due so wiring can be repaired and
      // the same bytes replayed without inventing operator debt at 0/N.
      if (!this.deps.hooks.retrySessionCommand) {
        throw new Error(`command ${command.id} retry hook unavailable with ${command.recovery_attempts}/${retryCap} recoveries spent`);
      }
      // Spend the allowance before tmux/filesystem work. If rebirth fails
      // before a bridge reserves the row, the finite bound still advances.
      if (!this.deps.store.beginSessionCommandRecovery(command.id, command.recovery_attempts)) {
        throw new Error(`command ${command.id} lost its automatic-recovery claim`);
      }
      const recoveryAttempt = command.recovery_attempts + 1;
      const result = await this.deps.hooks.retrySessionCommand(command.id, reason);
      if (result === "retried") {
        this.deps.store.logEvent("session_command_nonround_recovery", command.pr, {
          command_id: command.id,
          kind: command.kind,
          recovery_attempt: recoveryAttempt,
          retry_cap: retryCap,
          delivery_attempt: command.attempt,
          reason,
        });
        return;
      }
      if (result === "settled") {
        this.deps.store.logEvent("session_command_nonround_settled_race", command.pr, {
          command_id: command.id,
          kind: command.kind,
          reason,
        });
        return;
      }
      if (result === "accepted_race") {
        const next = this.deadlineFromNowSeconds(
          this.deps.cfg.daemon.session_command_unknown_grace_s ?? DEFAULT_SESSION_COMMAND_UNKNOWN_GRACE_S,
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
      throw new Error(`command ${command.id} non-round recovery failed before replay`);
    }

    if (!this.deps.hooks.killSession) {
      throw new Error(`cannot exhaust non-round command ${command.id}: kill hook unavailable`);
    }
    await this.deps.hooks.killSession(command.pr);
    const current = this.deps.store.getSessionCommand(command.id);
    // Settlement or explicit operator cancellation may win while the fence is
    // in flight. Both terminalize this supervisor obligation; never reopen a
    // failure over the operator's successful reset.
    if (!current || current.status === "acked" || current.status === "cancelled") return;
    if (current.status === "pending" || current.status === "running") {
      if (!this.deps.store.failActiveSessionCommand(command.id, reason)) return;
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
      detail: reason,
      attempts: failed.recovery_attempts,
      retry_cap: retryCap,
    });
    this.deps.store.logAnomaly(
      "session_command_recovery_exhausted",
      command.pr,
      null,
      `${reason}; automatic same-command replay exhausted and operator recovery is required`,
    );
  }

  private async failRound(command: SessionCommandRow, stage: RoundInfrastructureStage, detail: string): Promise<void> {
    const disposition = await this.deps.onRoundFailure(command.pr, command.round_no!, stage, `${detail}; command=${command.id}`);
    if (disposition === "retryable") {
      const next = this.deadlineFromNowSeconds(
        this.deps.cfg.daemon.session_command_unknown_grace_s ?? DEFAULT_SESSION_COMMAND_UNKNOWN_GRACE_S,
      );
      this.deps.store.scheduleSessionCommandCheck(command.id, next);
      this.deps.store.logEvent("round_stage_recovery_deferred", command.pr, {
        command_id: command.id,
        round_no: command.round_no,
        stage,
        next_check_at: next,
        detail,
      });
      return;
    }

    const current = this.deps.store.getSessionCommand(command.id);
    if (current?.status === "acked") this.deps.store.failSettledSessionCommand(command.id, detail);
    else if (current?.status === "pending" || current?.status === "running") this.deps.store.failActiveSessionCommand(command.id, detail);
    this.deps.store.logEvent("round_stage_recovery", command.pr, {
      command_id: command.id,
      round_no: command.round_no,
      stage,
      disposition,
      detail,
    });
    if (disposition === "exhausted") {
      const failed = this.deps.store.getSessionCommand(command.id) ?? command;
      const successor = this.deps.store.successorFor(command.pr);
      const row = this.deps.store.getPr(command.pr);
      this.deps.store.openReviewFailure({
        pr: command.pr,
        command_id: command.id,
        round_id: this.deps.store.roundsFor(command.pr).find((round) => round.round_no === command.round_no)?.id ?? null,
        round_no: command.round_no,
        head_sha: successor?.head_sha ?? row?.head_sha ?? "",
        stage,
        detail,
        attempts: failed.attempt,
        retry_cap: this.deps.cfg.daemon.max_self_requeues ?? DEFAULT_MAX_SELF_REQUEUES,
      });
      this.deps.store.logAnomaly(
        "round_stage_recovery_exhausted",
        command.pr,
        command.round_no,
        `${stage}: ${detail}; automatic recovery exhausted and work remains owed`,
      );
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
    healthy: reference !== null && Number.isFinite(ageMs) && ageMs <= staleAfterS * 1000 && lease?.last_error == null,
    stale_after_s: staleAfterS,
    last_attempt_at: lease?.last_attempt_at ?? null,
    last_success_at: lease?.last_success_at ?? null,
    last_error_at: lease?.last_error_at ?? null,
    last_error: lease?.last_error ?? null,
  };
}

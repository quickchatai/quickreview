// Operator recovery for a PR whose normal durable ownership protocol stopped
// making progress. This is deliberately outside dispatch: it fences
// the one sticky Pi first, repairs only that PR's command slot, then asks the
// ordinary pump to decide what work is actually eligible.
import { asyncCommandEffect, commandEffectKey } from "./commandeffects.js";
import { ovSessionIdForPr } from "./memory/ovsession.js";
import { verifiedPayload } from "./session-command-payload.js";
import type { StateStore } from "./state.js";

export type OperatorRecoveryMode = "rerun-round" | "restart-session";

export interface OperatorRecoveryDeps {
  /** Trusted watcher delivery identity, stable across retries. */
  deliveryKey?: string;
  store: StateStore;
  pump: () => Promise<void>;
  /** Required for restart-session. It must return only after the old Pi can no
   * longer acknowledge or consume the durable command slot. */
  killSession?: (pr: number) => Promise<void>;
  /** Does a worker of this PR run now (its lease, confirmed by the process
   * table — src/workerliveness.ts)? null = could not be asked. A running worker
   * is a live owner beside the command rows: `rerun-round` refuses it, and
   * `restart-session` releases ownership only once none runs. Absent = the
   * caller has no worker host to ask. */
  workerRuns?: (pr: number) => boolean | null;
  /** Worker-hosted PRs only (P8.12): a fresh worker RESUMES the newest JSONL, so
   * restart-session must rotate it away or it would resume the very conversation
   * the operator is replacing. Called once the old worker is proven gone and before
   * the blocking command is released; returns the undo, run if the release fails.
   * The tmux host births a fresh session after a kill and needs none. */
  rotateSession?: (pr: number) => Promise<() => void> | (() => void);
  now?: () => Date;
}

export interface OperatorRecoveryResult {
  [key: string]: unknown;
  ok: boolean;
  reason?: string;
  requeued?: number;
  redispatched?: boolean;
  no_op_state?: string;
  blocking_command?: string;
  recovery_hold_cleared?: string;
  migration_precheck_mark_repaired?: boolean;
  cancelled_rounds?: number[];
  cancelled_session_commands?: string[];
  recovered_wakes?: number;
  exact_head_retired?: boolean;
  restored_state?: "awaiting_author" | "tracked";
}

/**
 * Recover one PR through the same state machine the normal command handlers
 * use. `rerun-round` is non-destructive and therefore refuses a live durable
 * owner. `restart-session` is the operator's explicit destructive override:
 * unlike automatic missing-receipt recovery, it may kill an ambiguously busy
 * conversation, but it fences that owner, verifies the immutable payload, and
 * transactionally preserves non-round work before releasing ownership.
 */
export async function recoverPrForOperator(
  deps: OperatorRecoveryDeps,
  pr: number,
  mode: OperatorRecoveryMode,
): Promise<OperatorRecoveryResult> {
  return asyncCommandEffect(deps.store, commandEffectKey(mode, deps.deliveryKey, pr), () =>
    recoverPrForOperatorNow(deps, pr, mode),
  );
}

async function recoverPrForOperatorNow(
  deps: OperatorRecoveryDeps,
  pr: number,
  mode: OperatorRecoveryMode,
): Promise<OperatorRecoveryResult> {
  const row = deps.store.getPr(pr);
  if (!row) return { ok: false, reason: `unknown PR #${pr}` };
  if (row.state === "closed") return { ok: false, reason: `PR #${pr} is closed` };

  const blockers = deps.store.blockingSessionCommandsForPr(pr);
  if (mode === "rerun-round") {
    const runs = deps.workerRuns?.(pr);
    if (runs === true || runs === null)
      return {
        ok: false,
        reason:
          runs === true
            ? `PR #${pr} has a running worker; use restart-session to fence it`
            : `PR #${pr}: worker leases could not be read; use restart-session to fence it`,
      };
  }
  if (mode === "rerun-round" && blockers.length > 0) {
    return {
      ok: false,
      reason: `PR #${pr} is owned by session command ${blockers[0]!.id}; use restart-session to fence it`,
      blocking_command: blockers[0]!.id,
    };
  }

  // The worker crash-loop breaker (P8.5b) parked this PR after repeated worker
  // failures; either lever is the operator's word that it may run again.
  if (deps.store.clearWorkerBreaker(pr)) deps.store.logEvent("worker_unparked", pr, { by: mode });

  const failure = deps.store.openReviewFailure(pr);
  if (
    mode === "rerun-round" &&
    failure?.stage === "posting_receipt" &&
    failure.command_id !== null &&
    failure.round_id !== null &&
    failure.round_no !== null &&
    failure.head_sha !== ""
  ) {
    const retired = deps.store.resolveExactHeadReviewedFailure({
      pr,
      incident_id: failure.incident_id,
      command_id: failure.command_id,
      round_id: failure.round_id,
      round_no: failure.round_no,
      head_sha: failure.head_sha,
    });
    if (retired.kind === "blocked") return { ok: false, reason: retired.reason };
    if (retired.kind === "resolved") {
      return {
        ok: true,
        redispatched: false,
        exact_head_retired: true,
        restored_state: retired.restored_state,
        recovery_hold_cleared: retired.incident_id,
      };
    }
  }

  let reset: { cancelled_command_ids: string[]; recovered_wake_ids: number[] } = {
    cancelled_command_ids: [],
    recovered_wake_ids: [],
  };
  if (mode === "restart-session") {
    if (!deps.killSession) return { ok: false, reason: "restart-session kill hook unavailable" };

    const payloads: Array<{ command: (typeof blockers)[number]; text: string }> = [];
    for (const command of blockers) {
      const read = verifiedPayload(command, `session command ${command.id} payload`);
      if (!read.ok) return { ok: false, reason: read.why };
      const payload = read.payload;
      const text = payload.toString("utf8");
      if (!Buffer.from(text, "utf8").equals(payload)) {
        return {
          ok: false,
          reason: `session command ${command.id} payload is not UTF-8; refusing byte-changing recovery`,
        };
      }
      payloads.push({ command, text });
    }

    await deps.killSession(pr);
    // The kill's own answer is not the proof: the lease and the process table
    // are. A worker still running could append to the JSONL beside a fresh one.
    if (deps.workerRuns && deps.workerRuns(pr) !== false)
      return {
        ok: false,
        reason: `PR #${pr}: a worker still runs after the fence; ownership unchanged`,
      };

    // Keep the blocker in SQLite until the old session is rotated away; if
    // the exact blocker set changed while kill was in flight, the CAS below
    // refuses and the rotation is put back.
    let unrotate: (() => void) | undefined;
    try {
      if (deps.rotateSession) unrotate = await deps.rotateSession(pr);
      reset = deps.store.cancelBlockingSessionCommandsForOperator(
        pr,
        payloads
          .filter(({ command }) => command.kind !== "round" && command.kind !== "answer")
          .map(({ command, text }) => ({ id: command.id, payload: text })),
        "restart-session",
        blockers.map((command) => command.id),
      );
    } catch (error) {
      unrotate?.();
      throw error;
    }
  }

  const current = deps.store.getPr(pr) ?? row;
  const migrationMarkRepaired =
    failure?.stage === "posting_receipt"
      ? deps.store.repairMigrationPrecheckReviewedHead(pr)
      : false;
  const cancelled = deps.store.cancelRunningRounds(pr, mode);
  const recoveredFailure = deps.store.recoverReviewFailure(pr, mode);
  const successor = deps.store.successorFor(pr);
  if (successor) deps.store.promoteSuccessor(pr);
  // A human may explicitly retrigger the unchanged head while old receipt debt
  // waits for recovery — or while restart-session awaited the kill. It is
  // already queued; replacing its timestamp and provenance with an
  // operator-system trigger would erase that new request. Read the row as it
  // is now, not as it was before the kill.
  else if (!(
    current.state === "queued" &&
    current.trigger_ts !== null &&
    current.trigger_provenance === "human"
  )) {
    deps.store.queuePrForOperatorRecovery(pr, (deps.now ?? (() => new Date()))().toISOString());
  }

  await deps.pump();
  const after = deps.store.getPr(pr);
  const redispatched = deps.store.hasRunningRound(pr);
  const base = {
    requeued: pr,
    redispatched,
    ...(recoveredFailure ? { recovery_hold_cleared: recoveredFailure.incident_id } : {}),
    ...(migrationMarkRepaired ? { migration_precheck_mark_repaired: true } : {}),
    ...(cancelled.length > 0 ? { cancelled_rounds: cancelled } : {}),
    ...(reset.cancelled_command_ids.length > 0
      ? { cancelled_session_commands: reset.cancelled_command_ids }
      : {}),
    ...(reset.recovered_wake_ids.length > 0
      ? { recovered_wakes: reset.recovered_wake_ids.length }
      : {}),
  };
  if (!redispatched) {
    const blocker = deps.store.blockingSessionCommand(ovSessionIdForPr(pr));
    const held = deps.store.heldWakes(pr).length;
    return {
      ok: false,
      ...base,
      reason: blocker
        ? `PR #${pr} remains queued behind session command ${blocker.id} (${blocker.status})`
        : held > 0
          ? `PR #${pr} remains queued behind ${held} held conversational wake(s)`
          : `PR #${pr} has no running round after ${mode} (state=${after?.state ?? "missing"})`,
      no_op_state: after?.state ?? "missing",
      ...(blocker ? { blocking_command: blocker.id } : {}),
    };
  }
  return { ok: true, ...base };
}

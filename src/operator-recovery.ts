// Operator recovery for a PR whose normal durable ownership protocol stopped
// making progress. This is deliberately outside dispatch: it fences
// the one sticky Pi first, repairs only that PR's command slot, then asks the
// ordinary pump to decide what work is actually eligible.
import { randomUUID } from "node:crypto";
import { existsSync, renameSync, rmSync } from "node:fs";
import { verifiedPayload } from "./session-command-payload.js";
import type { StateStore } from "./state.js";

export type OperatorRecoveryMode = "rerun-round" | "restart-session";

export interface OperatorRecoveryDeps {
  store: StateStore;
  pump: () => Promise<void>;
  /** Required for restart-session. It must return only after the old Pi can no
   * longer acknowledge or consume the durable command slot. */
  killSession?: (pr: number) => Promise<void>;
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
  const row = deps.store.getPr(pr);
  if (!row) return { ok: false, reason: `unknown PR #${pr}` };
  if (row.state === "closed") return { ok: false, reason: `PR #${pr} is closed` };

  const blockers = deps.store.blockingSessionCommandsForPr(pr);
  if (mode === "rerun-round" && blockers.length > 0) {
    return {
      ok: false,
      reason: `PR #${pr} is owned by session command ${blockers[0]!.id}; use restart-session to fence it`,
      blocking_command: blockers[0]!.id,
    };
  }

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

    const payloads: Array<{ command: (typeof blockers)[number]; payload: Buffer; text: string }> =
      [];
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
      payloads.push({ command, payload, text });
    }

    await deps.killSession(pr);

    // Keep the blocker in SQLite while every old inject file is moved out of
    // the bridge's *.md namespace. That closes the release→cleanup gap: no
    // concurrent dispatch can birth a replacement Pi beside stale input. If
    // the exact blocker set changed while kill was in flight, restore the
    // quarantined files and leave the winner untouched.
    const quarantined: Array<{ commandId: string; injectPath: string; quarantinePath: string }> =
      [];
    try {
      for (const { command } of payloads) {
        if (!existsSync(command.inject_path)) continue;
        const quarantinePath = `${command.inject_path}.operator-recovery-${randomUUID()}`;
        renameSync(command.inject_path, quarantinePath);
        quarantined.push({
          commandId: command.id,
          injectPath: command.inject_path,
          quarantinePath,
        });
      }
      reset = deps.store.cancelBlockingSessionCommandsForOperator(
        pr,
        payloads
          .filter(({ command }) => command.kind !== "round")
          .map(({ command, text }) => ({ id: command.id, payload: text })),
        "restart-session",
        blockers.map((command) => command.id),
      );
    } catch (error) {
      const stillBlocking = new Set(
        deps.store.blockingSessionCommandsForPr(pr).map((command) => command.id),
      );
      for (const { commandId, injectPath, quarantinePath } of [...quarantined].reverse()) {
        if (!existsSync(quarantinePath)) continue;
        // Restore only a command that still owns work. If settlement won the
        // fence, putting its old file back into *.md would duplicate delivery
        // beside the successor that caused the blocker-set CAS to refuse.
        if (stillBlocking.has(commandId) && !existsSync(injectPath))
          renameSync(quarantinePath, injectPath);
        else rmSync(quarantinePath, { force: true });
      }
      throw error;
    }
    for (const { quarantinePath } of quarantined) rmSync(quarantinePath, { force: true });
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
    const blocker = deps.store.blockingSessionCommand(`pr-${pr}`);
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

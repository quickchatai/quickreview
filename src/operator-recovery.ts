// Operator recovery for a PR whose normal durable ownership protocol stopped
// making progress. This is deliberately outside dispatch: it fences
// the one sticky Pi first, repairs only that PR's command slot, then asks the
// ordinary pump to decide what work is actually eligible.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
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

  let reset: { cancelled_command_ids: string[]; recovered_wake_ids: number[] } = {
    cancelled_command_ids: [],
    recovered_wake_ids: [],
  };
  if (mode === "restart-session") {
    if (!deps.killSession) return { ok: false, reason: "restart-session kill hook unavailable" };

    const payloads: Array<{ command: (typeof blockers)[number]; payload: Buffer; text: string }> = [];
    for (const command of blockers) {
      let payload: Buffer;
      try {
        payload = readFileSync(command.payload_path);
      } catch (error) {
        return { ok: false, reason: `session command ${command.id} payload unreadable: ${String(error)}` };
      }
      const actual = createHash("sha256").update(payload).digest("hex");
      if (actual !== command.payload_sha256) {
        return { ok: false, reason: `session command ${command.id} payload hash ${actual} != ${command.payload_sha256}` };
      }
      const text = payload.toString("utf8");
      if (!Buffer.from(text, "utf8").equals(payload)) {
        return { ok: false, reason: `session command ${command.id} payload is not UTF-8; refusing byte-changing recovery` };
      }
      payloads.push({ command, payload, text });
    }

    await deps.killSession(pr);

    // The old bridge is fenced. First commit the all-or-nothing ownership
    // reset while the original inject files remain intact. Only then remove
    // those files, before any replacement session can be born. A concurrent
    // supervisor can no longer reconstruct a cancelled command after commit.
    reset = deps.store.cancelBlockingSessionCommandsForOperator(
      pr,
      payloads
        .filter(({ command }) => command.kind !== "round")
        .map(({ command, text }) => ({ id: command.id, payload: text })),
      "restart-session",
    );
    for (const { command } of payloads) {
      if (existsSync(command.inject_path)) rmSync(command.inject_path, { force: true });
    }
  }

  const failure = deps.store.openReviewFailure(pr);
  const migrationMarkRepaired = failure?.stage === "posting_receipt"
    ? deps.store.repairMigrationPrecheckReviewedHead(pr)
    : false;
  const cancelled = deps.store.cancelRunningRounds(pr, mode);
  const recoveredFailure = deps.store.recoverReviewFailure(pr, mode);
  const successorPromoted = deps.store.promoteSuccessor(pr);
  if (!successorPromoted) {
    deps.store.upsertPr({
      ...row,
      state: "queued",
      trigger_ts: (deps.now ?? (() => new Date()))().toISOString(),
    });
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
    return {
      ok: false,
      ...base,
      reason: blocker
        ? `PR #${pr} remains queued behind session command ${blocker.id} (${blocker.status})`
        : `PR #${pr} has no running round after ${mode} (state=${after?.state ?? "missing"})`,
      no_op_state: after?.state ?? "missing",
      ...(blocker ? { blocking_command: blocker.id } : {}),
    };
  }
  return { ok: true, ...base };
}

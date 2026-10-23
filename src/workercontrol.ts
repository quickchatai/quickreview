// The daemon's handler for the operator's round controls on a worker-hosted PR
// (P8.12): `CommandDeps.operatorControl`, served by the WorkerSupervisor.
//
// steer and follow-up are forwarded to the PR's running worker over IPC and come
// back with the worker's ack (`ack: "queued" | "handled"`), which the operator's
// control route shows as "the session has it" or "delivered" (src/tui/livecontrol.ts
// reads `ack` off the result file). abort-round asks the worker to abort, with the
// SIGKILL fallback after the grace period. The result is a refusal with a reason
// when there is no worker to reach, it is ending, or it did not answer: never a
// silent success.
//
// takeover and release (P8.13) are served by the TakeoverManager (src/takeover.ts):
// the daemon grants the lease and starts the operator's pi, or stops it and frees the
// lease once it is gone. message is the idle-PR answer worker's (P8.17,
// src/answerworker.ts): a round running makes it a steer, an idle PR gets a short
// worker. debug-round (P8.13b) is served by the DebugRoundManager (src/debuground.ts):
// it arms the PR's next round to run in interactive pi, and a drained bot or a parked PR
// is refused (`code: "drained"` or `"parked"`). `release` frees whichever lease the PR
// is under.
import type { ControlCommand } from "./commands.js";
import type { FileOutcome } from "./improvements.js";
import type { TakeoverManager, TakeoverResult } from "./takeover.js";
import type { DebugResult, DebugRoundManager } from "./debuground.js";
import type { ControlResult, WorkerSupervisor } from "./workersupervisor.js";

export interface WorkerControlDeps {
  supervisor: Pick<WorkerSupervisor, "control" | "abortRound">;
  /** The takeover lease (P8.13). Omitted: takeover and release go to `other`. */
  takeover?: Pick<TakeoverManager, "grant" | "release">;
  /** The debug round (P8.13b). Omitted: debug-round goes to `other`, and a release
   * is a takeover's. */
  debug?: Pick<DebugRoundManager, "arm" | "release" | "holds">;
  /** The answer host's `message` (P8.17). Omitted: a message goes to `other`. */
  message?: (
    command: Extract<ControlCommand, { command: "message" }>,
  ) => Promise<FileOutcome> | FileOutcome;
  other?: (command: ControlCommand, file: string) => Promise<FileOutcome> | FileOutcome;
}

const outcome = (r: ControlResult): FileOutcome =>
  r.ok
    ? { ok: true, ack: r.ack, command_id: r.command_id, ...(r.killed ? { killed: true } : {}) }
    : { ok: false, reason: r.reason };

const handledOutcome = (r: {
  session: string;
  command_id: string;
  message: string;
}): FileOutcome => ({
  ok: true,
  ack: "handled",
  session: r.session,
  command_id: r.command_id,
  message: r.message,
});

const takeoverOutcome = (r: TakeoverResult): FileOutcome =>
  r.ok ? handledOutcome(r) : { ok: false, reason: r.reason };

const debugOutcome = (r: DebugResult): FileOutcome =>
  r.ok ? handledOutcome(r) : { ok: false, reason: r.reason, code: r.code };

async function notServed(
  deps: WorkerControlDeps,
  command: ControlCommand,
  file: string,
): Promise<FileOutcome> {
  return (
    (await deps.other?.(command, file)) ?? {
      ok: false,
      reason: `${command.command} is not served by the worker host yet`,
    }
  );
}

export function workerOperatorControl(
  deps: WorkerControlDeps,
): (command: ControlCommand, file: string) => Promise<FileOutcome> {
  return async (command, file) => {
    switch (command.command) {
      case "steer":
        return outcome(await deps.supervisor.control(command.pr, "steer", command.text));
      case "follow-up":
        return outcome(await deps.supervisor.control(command.pr, "follow_up", command.text));
      case "abort-round":
        return outcome(await deps.supervisor.abortRound(command.pr));
      case "takeover":
        if (deps.takeover) return takeoverOutcome(await deps.takeover.grant(command.pr));
        return notServed(deps, command, file);
      case "debug-round":
        if (deps.debug) return debugOutcome(await deps.debug.arm(command.pr));
        return notServed(deps, command, file);
      case "release":
        if (deps.debug?.holds(command.pr))
          return debugOutcome(await deps.debug.release(command.pr));
        if (deps.takeover) return takeoverOutcome(await deps.takeover.release(command.pr));
        return notServed(deps, command, file);
      case "message":
        return deps.message ? deps.message(command) : notServed(deps, command, file);
      default:
        return notServed(deps, command, file);
    }
  };
}

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
// message is the idle-PR answer worker's (P8.17, src/answerworker.ts): a round
// running makes it a steer, an idle PR gets a short worker. takeover, release and
// debug-round are other tickets' verbs (P8.13): they go to `other` when the daemon
// has one, and are otherwise refused with a reason.
import type { ControlCommand } from "./commands.js";
import type { FileOutcome } from "./improvements.js";
import type { ControlResult, WorkerSupervisor } from "./workersupervisor.js";

export interface WorkerControlDeps {
  supervisor: Pick<WorkerSupervisor, "control" | "abortRound">;
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

export function workerOperatorControl(
  deps: WorkerControlDeps,
): (command: ControlCommand, file: string) => Promise<FileOutcome> {
  const elsewhere = async (command: ControlCommand, file: string): Promise<FileOutcome> =>
    (await deps.other?.(command, file)) ?? {
      ok: false,
      reason: `${command.command} is not served by the worker host yet`,
    };
  return async (command, file) => {
    switch (command.command) {
      case "steer":
        return outcome(await deps.supervisor.control(command.pr, "steer", command.text));
      case "follow-up":
        return outcome(await deps.supervisor.control(command.pr, "follow_up", command.text));
      case "abort-round":
        return outcome(await deps.supervisor.abortRound(command.pr));
      case "message":
        return deps.message ? deps.message(command) : elsewhere(command, file);
      default:
        return elsewhere(command, file);
    }
  };
}

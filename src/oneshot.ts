// The one-shot review, as its callers know it. The round itself is
// src/engine/round.ts (runRound, on an injected runtime); this module keeps the
// names the bench (src/bench/runner.ts reviewCase), `qcr review` and the
// detached driver import, and picks the runtime a caller did not inject: a
// process runtime over `piBin`.
import type { Runtime } from "./engine/port.js";
import { procRuntime } from "./engine/procruntime.js";
import { runRound, type RoundResult, type RoundSpec } from "./engine/round.js";

export {
  jsonProblem,
  missingOutputs,
  PI_RUN_FILES,
  readJson,
  unparseableOutputs,
} from "./engine/round.js";
// The pi child process moved to the process runtime; its callers still import
// these from here.
export { haltPi, killPiGroups, onLfLines, runPi } from "./engine/procruntime.js";
export type { PiRun } from "./engine/procruntime.js";

export interface OneShotInput extends RoundSpec {
  piBin?: string;
  /** Hosts the pi session. Omitted: a process runtime over `piBin`. */
  runtime?: Runtime;
}

export type OneShotResult = RoundResult;

/** Run the review: `runRound` on `runtime`, or on a process runtime over
 * `piBin` (default `pi`). */
export function runOneShot(i: OneShotInput): Promise<OneShotResult> {
  const { piBin, runtime, ...spec } = i;
  return runRound(spec, runtime ?? procRuntime({ bin: piBin ?? "pi" }));
}

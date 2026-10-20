// The one-shot review, as its callers know it. The round itself is
// src/engine/round.ts (runRound, on an injected runtime); this module keeps the
// names the bench (src/bench/runner.ts reviewCase), `qcr review` and the
// detached driver import.
import type { Runtime } from "./engine/port.js";
import { runRound, type RoundResult, type RoundSpec } from "./engine/round.js";

export {
  jsonProblem,
  missingOutputs,
  PI_RUN_FILES,
  readJson,
  unparseableOutputs,
} from "./engine/round.js";
export type { PiRun } from "./engine/port.js";

export interface OneShotInput extends RoundSpec {
  /** Hosts the pi session: the SDK runtime of the route. */
  runtime: Runtime;
}

export type OneShotResult = RoundResult;

/** Run the review: `runRound` on `runtime`. */
export function runOneShot(i: OneShotInput): Promise<OneShotResult> {
  const { runtime, ...spec } = i;
  return runRound(spec, runtime);
}

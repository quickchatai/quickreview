import type { StateStore } from "./state.js";
import type { LessonLedger } from "./lessonledger.js";
import { markRound } from "./lessonshadow.js";
import { resolveVerifiedPriorThreads, type PriorResolveDeps } from "./priorresolve.js";

export interface RecordedFindingsDeps extends Pick<
  PriorResolveDeps,
  "adapter" | "sidecarPath" | "log"
> {
  store: StateStore;
  ledger: LessonLedger | null;
}

/** The production consumer of a stored findings record. */
export async function completeRecordedFindings(
  deps: RecordedFindingsDeps,
  target: { pr: number; roundNo: number },
): Promise<void> {
  const { pr, roundNo } = target;
  if (!deps.ledger) throw new Error("lesson ledger is not ready");
  // Marking is idempotent; its successful return is part of this callback's
  // completion receipt, not a best-effort effect silently lost during boot.
  markRound(deps.ledger, deps.store, pr, roundNo);
  const result = await resolveVerifiedPriorThreads(deps, pr, roundNo);
  if (!result.readable)
    throw new Error(`prior threads for #${pr} round ${roundNo} could not be read`);
}

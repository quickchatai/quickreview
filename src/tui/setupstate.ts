// Is onboarding finished? Read from the checklist file the wizard keeps
// (src/onboard/engine.ts), so a TUI opened halfway through the wizard says
// so on its first frame instead of troubleshooting a daemon nobody has started
// yet.
//
// Only a checklist that EXISTS and is not complete counts: an install that
// never ran the wizard (a hand-written config, the VM operator's own setup)
// has no checklist and gets no banner. The next step is the first enabled step,
// in the wizard's own order, that the file does not record as done — the same
// predicates the engine applies, so the TUI cannot name a step the wizard would
// skip.
import { type ChecklistFile } from "../onboard/engine.js";

export interface SetupState {
  /** The title of the first pending step ("the final verification" when only
   * finish is left), or undefined when it could not be computed. */
  next: string | undefined;
}

/** The one sentence every surface uses. */
export function setupLine(s: SetupState): string {
  return `setup not finished — run \`qcr\` to finish setting up${s.next ? ` (next: ${s.next})` : ""}`;
}

/** Complete now: finished once and not reopened since (engine.ts `completeNow`). */
function completeNow(file: ChecklistFile): boolean {
  return typeof file.completed_at === "string" && !file.reopened_at;
}

/** undefined = nothing to say (no checklist, or onboarding is complete). */
export async function setupStateOf(
  checklist: ChecklistFile | null,
): Promise<SetupState | undefined> {
  if (checklist === null || completeNow(checklist)) return undefined;
  let next: string | undefined;
  try {
    const { defaultSteps } = await import("../onboard/steps/index.js");
    const steps = [...defaultSteps()].sort((a, b) => a.order - b.order);
    const pending = steps.find(
      (s) =>
        !s.optional &&
        (s.enabled ? s.enabled(checklist.choices) : true) &&
        checklist.steps[s.id]?.status !== "done",
    );
    next = pending?.title ?? "the final verification";
  } catch {
    // The step registry could not be loaded: the banner still says setup is
    // unfinished, without naming a step it could not compute.
    next = undefined;
  }
  return { next };
}

// OnboardingEngine: the onboarding wizard's checklist, the plugin's setup
// checklist (@quickchatai/pi-quickreview/src/setupchecklist.ts, the step registry
// and its engine) bound to this app's adapters and state. pi is a thin
// driver over it (extensions/onboarding.ts registers one tool per step); the
// engine itself is fully drivable from tests and from a non-LLM fallback
// entry, and nothing in here touches the network, Docker, or a real pi except
// through the adapters.
//
// What this module adds to the core's checklist:
//   - the wizard's adapter set (OnboardAdapters) and its step type;
//   - where the checklist lives: state/onboarding/checklist.json, tmp+rename
//     atomic, re-verified on resume (the core's resumability contract);
//   - the finish path's first-run marker, state/companion/first-run.json
//     ({"completed_at": "<iso>"}), written exactly once: the contract the
//     companion's first-run greeting consumes. Keep the path and shape
//     stable.
import {
  SetupChecklist,
  checklistCompleteNow,
  readChecklistFile,
  writeAtomic,
  type ChecklistAdapters,
  type ChecklistFile,
  type SetupStep,
  type StepContext as ChecklistStepContext,
  type StepRegistry,
  type VerifyAllResult,
} from "@quickchatai/pi-quickreview/src/setupchecklist.js";
import type { StepForward, StepForwardRequest } from "./stepforward.js";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export {
  CHECKLIST_VERSION,
  failures,
  readTextOrNull,
  writeAtomic,
  type CheckResult,
  type ChecklistFile,
  type ReconcileReport,
  type StepRecord,
  type StepReport,
  type StepRunResult,
  type StepStatusLine,
  type VerifyAllResult,
} from "@quickchatai/pi-quickreview/src/setupchecklist.js";

// ---- adapters ---------------------------------------------------------------

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Process seam. Never throws: a missing binary is a nonzero code with the
 * error text in stderr, so a step can render it as a plain red check. */
export interface ProcessRunner {
  run(cmd: string, args: string[]): Promise<ProcessResult>;
}

/** Everything a step may touch outside its own logic. All injected — tests
 * fake every field; extensions/onboarding.ts builds the real set. Steps use
 * fetch (manifest exchange, health probes) and prompter (non-LLM fallback
 * entry) as they need them; preflight needs neither. */
export interface OnboardAdapters extends ChecklistAdapters {
  /** HTTP seam (GitHub App manifest exchange, health endpoints, …). */
  fetch: typeof fetch;
  runner: ProcessRunner;
  clock: () => Date;
  /** Interactive fallback question seam. pi is the normal prompter — steps
   * driven from the pi session get their answers as tool inputs instead. */
  prompter?: (question: string) => Promise<string>;
  /** Deterministic host facts, captured once by the real assembly so steps
   * never read process globals themselves. `uid` is null where the platform
   * has no uid (Windows). `inContainer`: the wizard is running inside a
   * container (the release image), where there is no Docker to drive —
   * bring-up then prints the host's commands instead. */
  host: { nodeVersion: string; uid: number | null; inContainer?: boolean };
  /** Filesystem roots. `stateDir` is `<sandbox root>/state`; `configPath` is
   * the live config.toml as the install locator resolved it — the
   * one file every step reads and writes, captured once by the real assembly
   * so no step builds a config path itself. */
  paths: { stateDir: string; configPath: string };
  log?: (line: string) => void;
  /** Opens the local memory forward for one step call (src/onboard/stepforward.ts):
   * the compose route's memory engine is reachable from this machine only
   * through it. The real assembly sets it; absent (every test), no forward is
   * opened and the step sees whatever already listens. */
  memoryForward?: (req: StepForwardRequest) => Promise<StepForward | null>;
}

// ---- step vocabulary --------------------------------------------------------

export type StepContext = ChecklistStepContext<OnboardAdapters>;

/**
 * One onboarding step (the registered set is defaultSteps in
 * src/onboard/steps/index.ts): the core's SetupStep over the wizard's
 * adapters. The pi extension registers each step as tool `onboard_<id>`.
 */
export type OnboardingStep = SetupStep<OnboardAdapters>;

// ---- checklist file ---------------------------------------------------------

export function checklistPath(stateDir: string): string {
  return join(stateDir, "onboarding", "checklist.json");
}

/** The first-run contract path: the companion's first-run greeting keys off this
 * file. Written once, by finish(), shape {"completed_at": "<iso>"}. */
export function firstRunMarkerPath(stateDir: string): string {
  return join(stateDir, "companion", "first-run.json");
}

/** Read the checklist; null when absent or unreadable (both mean "fresh"). */
export function readChecklist(stateDir: string): ChecklistFile | null {
  return readChecklistFile(checklistPath(stateDir));
}

/** Does the checklist file say onboarding finished? The CLI's post-exit
 * handoff reads exactly this (the finish tool only sets it after a full green
 * re-verification, so "the file says so" is a verified claim). */
export function checklistComplete(stateDir: string): boolean {
  const file = readChecklist(stateDir);
  return file !== null && checklistCompleteNow(file);
}

/** `<sandbox root>` — the parent of `paths.stateDir`, by the adapters'
 * contract (stateDir = `<sandbox root>/state`). The one place that says so. */
export function sandboxRoot(paths: { readonly stateDir: string }): string {
  return resolve(paths.stateDir, "..");
}

// ---- engine -----------------------------------------------------------------

export type FinishResult =
  | { ok: true; completed_at: string; marker_written: boolean }
  | { ok: false; results: VerifyAllResult["results"] };

export class OnboardingEngine extends SetupChecklist<OnboardAdapters> {
  constructor(
    steps: StepRegistry<OnboardAdapters> | readonly OnboardingStep[],
    adapters: OnboardAdapters,
  ) {
    super(steps, adapters, { file: checklistPath(adapters.paths.stateDir) });
  }

  /**
   * The finish tool's engine half: the checklist's full verification. Anything
   * red ⇒ refuse with the failures (the caller returns them as the tool
   * result and does not exit). All green ⇒ the checklist is complete, and the
   * first-run marker is written — once: a marker already on disk is left
   * untouched, so the completed_at the companion greets on never moves.
   */
  override async finish(): Promise<FinishResult> {
    const done = await super.finish();
    if (!done.ok) return done;
    const marker = firstRunMarkerPath(this.adapters.paths.stateDir);
    let markerWritten = false;
    if (!existsSync(marker)) {
      writeAtomic(marker, `${JSON.stringify({ completed_at: done.completed_at })}\n`);
      markerWritten = true;
    }
    return { ok: true, completed_at: done.completed_at, marker_written: markerWritten };
  }
}

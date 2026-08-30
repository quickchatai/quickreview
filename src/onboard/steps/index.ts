// The onboarding step registry. ships the tracer step (preflight);
// the later slices (topology/auth, GitHub App manifest,
// tunnel/memory/bring-up/proof) register their steps HERE, in
// `order` order — the pi extension turns each into a tool automatically, and
// the engine handles persistence, resume re-verification and finish for all
// of them.
import type { OnboardingStep } from "../engine.js";
import { llmAuthStep } from "./llmauth.js";
import { preflightStep } from "./preflight.js";

export function defaultSteps(): OnboardingStep[] {
  return [preflightStep(), llmAuthStep()];
}

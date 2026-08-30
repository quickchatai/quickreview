// The onboarding step registry. ships the tracer step (preflight);
// the later slices (topology/auth, GitHub App manifest,
// tunnel/memory/bring-up/proof) register their steps HERE, in
// `order` order — the pi extension turns each into a tool automatically, and
// the engine handles persistence, resume re-verification and finish for all
// of them.
import type { OnboardingStep } from "../engine.js";
import { configFillStep } from "./configfill.js";
import { githubAppStep } from "./githubapp.js";
import { ingressStep } from "./ingress.js";
import { llmAuthStep } from "./llmauth.js";
import { memoryStep } from "./memory.js";
import { preflightStep } from "./preflight.js";

export function defaultSteps(): OnboardingStep[] {
  // Order matters and the steps interlock: config_fill records the reviewed
  // repo the App step needs, and the App step records the slug config_fill
  // consumes when it runs again. owns reconciling the slug the App
  // actually got against the one recorded here.
  return [
    preflightStep(),
    llmAuthStep(),
    configFillStep(),
    githubAppStep(),
    ingressStep(),
    memoryStep(),
  ];
}

// The onboarding step registry. ships the tracer step (preflight);
// the later slices (topology/auth, GitHub App manifest,
// tunnel/memory/bring-up/proof) register their steps HERE, in
// `order` order — the pi extension turns each into a tool automatically, and
// the engine handles persistence, resume re-verification and finish for all
// of them.
import type { OnboardingStep } from "../engine.js";
import { appSlugStep } from "./appslug.js";
import { bringUpStep } from "./bringup.js";
import { configFillStep } from "./configfill.js";
import { githubAppStep } from "./githubapp.js";
import { goLiveStep } from "./golive.js";
import { ingressStep } from "./ingress.js";
import { llmAuthStep } from "./llmauth.js";
import { memoryStep } from "./memory.js";
import { memoryUserKeysStep } from "./memorykeys.js";
import { preflightStep } from "./preflight.js";
import { proofRoundStep } from "./proof.js";
import { verifyStackStep } from "./verifyup.js";

export function defaultSteps(): OnboardingStep[] {
  // Order matters and the steps interlock: config_fill records the reviewed
  // repo the App step needs, and the App step records the slug config_fill
  // consumes when it runs again. reconciles the slug the App actually
  // got against the one recorded here (app_slug_reconcile), and then owns the
  // whole bring-up tail: the stack comes up, memory's second phase completes
  // against the now-running server, the running system is verified in layers,
  // a real PR is reviewed in front of the operator, and only then — once, on
  // their explicit word — the dry-run flip is offered.
  return [
    preflightStep(),
    llmAuthStep(),
    configFillStep(),
    githubAppStep(),
    ingressStep(),
    memoryStep(),
    appSlugStep(),
    bringUpStep(),
    memoryUserKeysStep(),
    verifyStackStep(),
    proofRoundStep(),
    goLiveStep(),
  ];
}

// The onboarding step registry. Every step registers here, in `order` order —
// the pi extension turns each into a tool automatically, and the engine
// handles persistence, resume re-verification and finish for all of them.
import type { OnboardingStep } from "../engine.js";
import { appSlugStep } from "./appslug.js";
import { bringUpStep } from "./bringup.js";
import { configFillStep } from "./configfill.js";
import { embeddingsStep } from "./embeddings.js";
import { escalationStep } from "./escalation.js";
import { githubAppStep } from "./githubapp.js";
import { goLiveStep } from "./golive.js";
import { ingressStep } from "./ingress.js";
import { vmInventoryStep } from "./inventory.js";
import { llmAuthStep } from "./llmauth.js";
import { memoryStep } from "./memory.js";
import { memoryUserKeysStep } from "./memorykeys.js";
import { preflightStep } from "./preflight.js";
import { proofRoundStep } from "./proof.js";
import { sshPreflightStep } from "./ssh.js";
import { topologyStep } from "./topology.js";
import { verifyStackStep } from "./verifyup.js";
import { vmDeployStep } from "./vmdeploy.js";

export function defaultSteps(): OnboardingStep[] {
  // Order matters and the steps interlock: config_fill records the reviewed
  // repo the App step needs, and the App step records the slug config_fill
  // consumes when it runs again. app_slug_reconcile reconciles the slug the
  // App actually got against the one recorded here, and then the bring-up
  // tail runs: the stack comes up, memory's second phase completes
  // against the now-running server, the running system is verified in layers,
  // a real PR is reviewed in front of the operator, and only then — once, on
  // their explicit word — the dry-run flip is offered.
  //
  // The VM-over-ssh topology is the second first-class route. The route split,
  // step by step (the route-specific steps gate themselves with `enabled`):
  //   topology (20)      asks the question — both answers first-class, the
  //                      server route advertised as the recommendation;
  //   ssh_preflight (22) VM only, and FIRST on that route: the alias, the
  //                      agent and the passphrase trap, before anything is
  //                      minted, written or deployed;
  //   vm_inventory (68)  VM only: the deploy inventory, from the answers;
  //   vm_deploy (71)     VM only: `scripts/deploy.sh`, composed, with every
  //                      preflight it has — the peer of bringup (70), which is
  //                      compose-only.
  // Everything AFTER bring-up is shared by both routes and runs over whichever
  // transport `stackTransportFor` picks (transport.ts) — memory's second
  // phase, the layered verification, the proof round and the flip are one
  // implementation each, never a per-topology copy.
  return [
    preflightStep(),
    topologyStep(),
    sshPreflightStep(),
    llmAuthStep(),
    configFillStep(),
    escalationStep(),
    embeddingsStep(),
    // ingress (39) before the App (40): the App step writes the webhook URL
    // the ingress step records into the manifest, once, at creation.
    ingressStep(),
    githubAppStep(),
    memoryStep(),
    appSlugStep(),
    vmInventoryStep(),
    bringUpStep(),
    vmDeployStep(),
    memoryUserKeysStep(),
    verifyStackStep(),
    proofRoundStep(),
    goLiveStep(),
  ];
}

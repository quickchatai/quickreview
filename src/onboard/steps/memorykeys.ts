// Memory, phase B (inherited obligation ② from the ticket's note).
//
// The memory step (order 60) is TWO-PHASE by design and says so in
// its own header: the server's root key must be on disk BEFORE the daemon
// boots (the entrypoint renders it into ov.conf; without it the server
// degrades to auth_mode=dev and the confinement this whole design exists for
// is not enforced), while the two USER keys can only be MINTED BY A RUNNING
// SERVER. Run at order 60 the step therefore lands phase A, says plainly that
// phase B is waiting, and stops.
//
// This step is phase B's place in the sequence: after bring-up, with the
// server answering, drive the SAME step again so it mints and places the user
// keys and proves the confinement with the four-cell matrix.
//
// DRIVE IT, DO NOT DUPLICATE IT. There is exactly one implementation of key
// minting, placement and the confinement proof, and it is memory.ts — which is
// itself only a driver for scripts/openviking-provision.mjs and the ONE
// four-cell matrix in scripts/companion-memory-forward.mjs. This file holds no
// key logic at all: it constructs that step and calls its run/verify with this
// step's context. The consequences are the ones we want:
//
//   * the recorded choices (memory declined / where the key file went) are
//     shared, because choices are engine-wide — so declining memory at order
//     60 is still declined here, and nothing is asked twice;
//   * the memory step's OWN checklist row goes green on its own terms at the
//     next verifyAll (the engine promotes a pending step whose verify holds),
//     so the two rows never disagree about reality;
//   * a second minting path — the thing rule 8's "two write paths is what this
//     retired" warns about — never comes into existence.
import type { OnboardingStep, StepContext, StepReport } from "../engine.js";
import { MEMORY_CHOICE_KEY, memoryStep, type MemoryStepOptions } from "./memory.js";
import { topologyOf } from "./topology.js";

export const MEMORY_KEYS_STEP_ID = "memory_user_keys";

export interface MemoryKeysStepOptions extends MemoryStepOptions {
  /** The step being driven. Defaults to the real memory step; injected in
   * tests so the delegation itself can be asserted. */
  inner?: OnboardingStep;
}

export function memoryUserKeysStep(opts: MemoryKeysStepOptions = {}): OnboardingStep {
  const { inner, ...memoryOpts } = opts;
  const target = inner ?? memoryStep(memoryOpts);

  function phaseNote(ctx: StepContext): string {
    if (ctx.choices[MEMORY_CHOICE_KEY] === "declined") {
      return "memory setup was declined earlier — nothing is minted, written or probed here either";
    }
    const base =
      "phase B of the memory step: the server is up now, so the two USER keys can be minted and the confinement proved";
    // on the server route the memory engine listens on the VM's
    // loopback and is never published, so this machine reaches it through the
    // memory forward — the same loopback address either way, which is exactly
    // why the forward binds 127.0.0.1. If minting cannot reach a server, that
    // is the first thing to check on this topology.
    return topologyOf(ctx.choices) === "vm"
      ? `${base}. Your reviewer runs on a server, so the engine answers on ITS loopback and never on a published port: this ` +
          "machine reaches it through the memory forward (docs/companion-memory-access.md). If nothing answers below, start " +
          "the forward and run this step again — the root key is already shipped with the deploy, which is what the daemon needs at boot"
      : base;
  }

  return {
    id: MEMORY_KEYS_STEP_ID,
    title: "Memory keys: the half that needs a running server",
    explain:
      "The memory step earlier put the server's own root key in place — the daemon needs it at boot. The two user keys (one " +
      "for the reviewer, one for your companion) can only be issued BY the running server, so they are minted now that the " +
      "stack is up, placed where each one belongs, and the confinement is proved: the reviewer's key must not reach companion " +
      "memory. If you declined memory earlier, this does nothing at all. Nothing here re-issues a key you already have.",
    order: 72,

    async run(ctx): Promise<StepReport> {
      const report = await target.run(ctx);
      return {
        ...report,
        checks: [{ name: "phase", ok: true, detail: phaseNote(ctx) }, ...report.checks],
      };
    },

    async verify(ctx): Promise<StepReport> {
      return target.verify(ctx);
    },
  };
}

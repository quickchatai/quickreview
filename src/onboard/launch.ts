// The onboarding wizard's pi session: pi at the pinned version via npx (pi
// stays a non-dependency, so this works from a bare clone with only Node and
// the checkout), with the onboarding system prompt, exactly one onboarding
// extension and a restricted built-in tool set.
//
// `qcr onboard`, the door that launched it, is gone: a bare `qcr` opens the
// home, whose setup checklist (src/home/setup.ts) covers a first run. The
// wizard's steps stay, for the home's Advanced route (the GitHub App, ingress,
// a remote server).
import { join } from "node:path";
import { defaultSteps } from "./steps/index.js";
import { onboardingToolAllowlist } from "./toolnames.js";

// The pin reader lives in a leaf module: src/version.ts (on the daemon's import
// graph) needs it, and this module imports the whole step registry.
export { piPinFromPackageJson, type PiPin } from "./pipin.js";
import type { PiPin } from "./pipin.js";

/** Dedicated onboarding session store — never the reviewer/companion dirs, so
 * onboarding cannot pollute (or be polluted by) any other pi session store. */
export function onboardingSessionDir(root: string): string {
  return join(root, "state", "onboarding", "pi-sessions");
}

/**
 * The full npx argv for the onboarding pi session.
 *
 * `--approve` is the same never-block-on-input rule as buildPiCommand
 * (src/sessions.ts) and the companion's piArgv: the wizard must never stall
 * on pi's interactive "Trust project folder?" modal.
 *
 * VERIFY-ON-PIN: `--no-extensions`, `--no-skills`, `--no-context-files`,
 * `-e <path>` and `--tools <list>` against the pinned pi version's --help —
 * the intent (no ambient extensions, exactly one onboarding extension, a
 * read-only built-in belt) is the design decision; the exact flag spellings
 * are unverified statically and belong to the named onboarding smoke step.
 *
 * `--tools` is an allowlist over extension tools too (pi 1.4.0; pinned by
 * tests/onboard-tools-sdk.test.ts on the real SDK), so it names every wizard
 * tool, derived from the step registry: a step added there is active here
 * with no second edit. bash, write and edit stay off it.
 */
export function onboardingPiArgv(
  pin: PiPin,
  root: string,
  stepIds: readonly string[] = defaultSteps().map((s) => s.id),
): string[] {
  return [
    "npx",
    "-y",
    `${pin.package}@${pin.version}`,
    "--approve",
    "--no-extensions",
    "--no-skills",
    "--no-context-files",
    "-e",
    join(root, "extensions", "cli", "onboarding.ts"),
    "--system-prompt",
    join(root, "prompts", "onboarding.md"),
    "--tools",
    onboardingToolAllowlist(stepIds).join(","),
    "--session-dir",
    onboardingSessionDir(root),
  ];
}

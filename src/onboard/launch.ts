// `qcr onboard` mechanics: launch pi at the pinned version via npx
// (pi stays a non-dependency — this works from a bare clone with only Node and
// the checkout), hand it the onboarding system prompt + exactly one onboarding
// extension + a restricted built-in tool set, and on exit either exec the TUI
// (checklist complete) or say how to resume.
//
// Everything effectful is injected (spawn, completion read, log), so tests
// drive the whole flow with fakes; src/cli.ts cmdOnboard is the one real
// assembly.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface PiPin {
  package: string;
  version: string;
}

/** The pin from package.json's "pi" block — the mirror that exists on a bare
 * public clone, where config.toml does not (the wizard writes it later).
 * config.toml [pi] stays the preferred source when it loads (cmdOnboard tries
 * it first); both mirror the same pinned version by rule 7's discipline. */
export function piPinFromPackageJson(
  root: string,
  readFile: (p: string) => string = (p) => readFileSync(p, "utf8"),
): PiPin | null {
  try {
    const pkg = JSON.parse(readFile(join(root, "package.json"))) as {
      pi?: { package?: unknown; version?: unknown };
    };
    const pi = pkg.pi;
    if (pi && typeof pi.package === "string" && typeof pi.version === "string") {
      return { package: pi.package, version: pi.version };
    }
  } catch {
    // fall through — the caller reports the missing pin
  }
  return null;
}

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
 */
export function onboardingPiArgv(pin: PiPin, root: string): string[] {
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
    "read,ls,grep",
    "--session-dir",
    onboardingSessionDir(root),
  ];
}

export interface OnboardRunDeps {
  pin: PiPin;
  root: string;
  /** Spawn with stdio inherited; resolves with the exit code (a spawn failure
   * is a nonzero code, never a throw). */
  spawn(cmd: string, args: string[]): Promise<number>;
  /** Does the checklist file say every step verified? (engine.checklistComplete
   * over state/ — the finish tool only sets the flag after a green re-verify.) */
  isComplete(): boolean;
  log(line: string): void;
  /** Compiled CLI path for the TUI handoff (dist/src/cli.js). */
  cliPath: string;
  /** Node binary for the handoff; defaults to the running one. */
  nodeBin?: string;
}

/**
 * Run the onboarding session and handle the handoff:
 *   - checklist complete after pi exits ⇒ open the TUI (same stdio);
 *   - otherwise print how to resume — `qcr onboard` again re-verifies
 *     completed steps and continues at the first unfinished one.
 */
export async function runOnboard(deps: OnboardRunDeps): Promise<number> {
  const argv = onboardingPiArgv(deps.pin, deps.root);
  deps.log(
    `onboarding: launching pi ${deps.pin.package}@${deps.pin.version} via npx (first run downloads it — give it a moment)`,
  );
  const code = await deps.spawn(argv[0]!, argv.slice(1));
  if (deps.isComplete()) {
    deps.log("onboarding: checklist verified complete — opening the TUI.");
    return deps.spawn(deps.nodeBin ?? process.execPath, [deps.cliPath, "tui"]);
  }
  deps.log(
    "onboarding: not finished yet. Run `qcr onboard` again to resume — completed steps are re-verified, not repeated.",
  );
  return code;
}

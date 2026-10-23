// The install locator never reads an install's own profile from the
// checkout, and every test file runs against an EMPTY temp config home
// (tests/helpers/install-env.ts), and the deployment's own pack lives in the
// install's config home, not the checkout. So the pins that bind that exact
// pack — the addenda byte-equivalence proof, the heuristics equivalence, the
// stack-rule proof, the deployed composition, the built-variant fence — read a
// tracked, frozen copy under tests/fixtures/profiles/ — the
// exact bytes the pins were written against — staged into this test file's
// temp config home, the place the locator really reads, so they run through
// the real lookup. The operator's live pack lives in the install's config
// home and may move on; the fixture does not.
//
// A deployment's own pack is not part of the public repository, so its
// fixture copy may be absent; then the pins that bind it self-skip.
//
// Idempotent; it refuses to write anywhere but the temp home the setup file
// installed, so it can never touch the developer's own config home.
import { cpSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXAMPLE_PROFILES, configHome, locateProfile } from "../../src/install.js";

/** Where the frozen fixture packs live, relative to a checkout root. */
export const FIXTURE_PROFILES = join("tests", "fixtures", "profiles");

/** Stage the fixture pack `<root>/tests/fixtures/profiles/<name>` into the temp
 * config home; true when the locator now finds `<name>`, false when the tree
 * carries no such fixture. */
export function stageFixtureProfile(root: string, name: string): boolean {
  const src = join(root, FIXTURE_PROFILES, name);
  if (existsSync(src) && !EXAMPLE_PROFILES.includes(name)) {
    const home = configHome(process.env);
    if (!home.startsWith(tmpdir()))
      throw new Error(
        `stageFixtureProfile: config home ${home} is not a temp dir — refusing to write`,
      );
    const dest = join(home, "profiles", name);
    if (!existsSync(dest)) cpSync(src, dest, { recursive: true });
  }
  return locateProfile({ root, profile: name }) !== null;
}

/** The fixture packs a checkout tracks. */
export function fixtureProfileNames(root: string): string[] {
  try {
    return readdirSync(join(root, FIXTURE_PROFILES), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** Stage every fixture pack; returns the names staged. */
export function stageFixtureProfiles(root: string): string[] {
  const names = fixtureProfileNames(root);
  for (const name of names) stageFixtureProfile(root, name);
  return names;
}

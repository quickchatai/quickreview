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
// A fixture pack is absent in exactly one place: an assembled publication
// snapshot, whose manifests drop it (the pack's content never travels). There
// the pins self-skip. In the SOURCE tree a missing fixture is a loud failure,
// never a skip: a silent skip would leave those pins binding nothing.
//
// Idempotent; it refuses to write anywhere but the temp home the setup file
// installed, so it can never touch the developer's own config home.
import { cpSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXAMPLE_PROFILES, configHome, locateProfile } from "../../src/install.js";

/** Where the frozen fixture packs live, relative to a checkout root. */
export const FIXTURE_PROFILES = join("tests", "fixtures", "profiles");

/** True in the source tree, false in an assembled snapshot (whose
 * publish-manifest.json carries an EMPTY `exclude` — applied at assembly). */
export function inSourceTree(root: string): boolean {
  try {
    const m = JSON.parse(readFileSync(join(root, "publish-manifest.json"), "utf8")) as {
      exclude?: unknown[];
    };
    return (m.exclude?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

/** Stage the fixture pack `<root>/tests/fixtures/profiles/<name>` into the temp
 * config home; true when the locator now finds `<name>`. False only in an
 * assembled snapshot; in the source tree a missing fixture THROWS. */
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
  const found = locateProfile({ root, profile: name }) !== null;
  if (!found && inSourceTree(root))
    throw new Error(
      `stageFixtureProfile: fixture pack ${src} is missing from the source tree — its pins would ` +
        `silently skip. Restore it (it is tracked); only an assembled snapshot may lack it.`,
    );
  return found;
}

/** The fixture packs a checkout tracks (none in an assembled snapshot). */
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

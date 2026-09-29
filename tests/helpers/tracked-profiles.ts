// the install locator never reads an install's own profile from the
// checkout, and every test file runs against an EMPTY temp config home
// (tests/helpers/install-env.ts). So a deployment pack the checkout still
// TRACKS is invisible to `locateProfile` in every test run, and the pins that
// bind that exact pack (the byte-equivalence proof, the
// heuristics equivalence, the stack-rule proof, the deployed
// composition, the built-variant fence) would self-skip everywhere — silently,
// forever.
//
// This stages the checkout's tracked pack into this test file's temp config
// home — the place the locator really reads — so those pins run through the
// real lookup wherever the pack is tracked, and self-skip only where it is
// absent (the assembled snapshots exclude it). Idempotent; it refuses
// to write anywhere but the temp home the setup file installed, so it can
// never touch the developer's own config home.
import { cpSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXAMPLE_PROFILES, configHome, locateProfile } from "../../src/install.js";

/** Stage `<root>/profiles/<name>` into the temp config home; true when the
 * locator now finds `<name>`. */
export function stageTrackedProfile(root: string, name: string): boolean {
  const src = join(root, "profiles", name);
  if (existsSync(src) && !EXAMPLE_PROFILES.includes(name)) {
    const home = configHome(process.env);
    if (!home.startsWith(tmpdir()))
      throw new Error(`stageTrackedProfile: config home ${home} is not a temp dir — refusing to write`);
    const dest = join(home, "profiles", name);
    if (!existsSync(dest)) cpSync(src, dest, { recursive: true });
  }
  return locateProfile({ root, profile: name }) !== null;
}

/** Stage every non-example pack under `<root>/profiles/`. */
export function stageTrackedProfiles(root: string): void {
  let names: string[] = [];
  try {
    names = readdirSync(join(root, "profiles"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return;
  }
  for (const name of names) stageTrackedProfile(root, name);
}

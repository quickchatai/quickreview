// The pinned pi version, read from package.json. A leaf: the daemon reaches it
// through src/version.ts, so it imports nothing from the onboarding wizard.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface PiPin {
  package: string;
  version: string;
}

/** The pin from package.json's "qcrPi" block — the mirror that exists on a bare
 * public clone, where config.toml does not (the wizard writes it later).
 * config.toml [pi] stays the preferred source when it loads (cmdOnboard tries
 * it first); both mirror the same pinned version by rule 7's discipline. */
export function piPinFromPackageJson(
  root: string,
  readFile: (p: string) => string = (p) => readFileSync(p, "utf8"),
): PiPin | null {
  try {
    const pkg = JSON.parse(readFile(join(root, "package.json"))) as {
      qcrPi?: { package?: unknown; version?: unknown };
    };
    const pi = pkg.qcrPi;
    if (pi && typeof pi.package === "string" && typeof pi.version === "string") {
      return { package: pi.package, version: pi.version };
    }
  } catch {
    // fall through — the caller reports the missing pin
  }
  return null;
}

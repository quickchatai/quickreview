// The one pi (rule 7): the pinned package in this install's node_modules. The
// SDK sessions import it (packages/pi-plugin/src/engine/pisdk.ts), and every pi CLI this code starts
// is that same package's own `pi` bin — the file node_modules/.bin/pi links to —
// never a `pi` looked up on the PATH. The release image carries no global pi
// CLI, so a PATH lookup there finds nothing; on a laptop it could find
// a pi of another version.
//
// A leaf: no SDK import (tests/fences-engine.test.ts allows that to pisdk.ts and
// the extension factories alone), so the daemon, the TUI and the CLI can ask
// where pi is without loading it.
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

/** The pi package rule 7 pins (config.toml [pi] package). */
export const PI_PACKAGE = "@earendil-works/pi-coding-agent";

/** The directory the installed pi package lives in. Found by walking the
 * module search path: the package's export map hides everything but its entry. */
export function piPackageDir(): string {
  const req = createRequire(import.meta.url);
  for (const base of req.resolve.paths(PI_PACKAGE) ?? []) {
    const dir = join(base, PI_PACKAGE);
    if (existsSync(join(dir, "package.json"))) return dir;
  }
  throw new Error(`pi SDK package ${PI_PACKAGE} not found on the module search path`);
}

/** The absolute path of the installed pi package's `pi` bin (its package.json
 * `bin`), the CLI entry node_modules/.bin/pi links to. A shebang script, so it
 * runs as a binary, through setpriv included. Throws when pi is not installed:
 * there is no other pi to fall back to.
 * VERIFY-ON-PIN (1.3.0: `"bin": {"pi": "dist/bundle/cli.js"}`): the bin's name. */
export function piCliPath(dir: string = piPackageDir()): string {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
    bin?: string | Record<string, string>;
  };
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.["pi"];
  if (typeof bin !== "string" || bin === "")
    throw new Error(`${PI_PACKAGE} in ${dir} declares no \`pi\` bin`);
  return resolve(dir, bin);
}

/** The pi CLI inside an image whose app root is `appRoot` (the release image's
 * /opt/qcr, `CONTAINER.app`): for a command built on one machine and run in a
 * container, where this process's own module path means nothing. */
export function piCliIn(appRoot: string): string {
  return `${appRoot}/node_modules/.bin/pi`;
}

// Where the review core's shipped data lives: prompts/, agents/, seeds/,
// profiles/ (the generic examples), schemas/, deploy/reviewer and the seed
// manifest. Resolved from this module's own location, however the package
// was installed: an installed package carries a byte copy of the data in its
// own `assets/` (its prepack, scripts/plugin-assets.mjs, makes it, and its
// postpack removes it again), and in the checkout the data is the repo
// root's, above packages/pi-plugin, whatever a pack left behind.
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The nearest directory at or above `dir` that holds a package.json — robust
 * under both dist/src (built) and src (vitest). `what` names it in the error. */
export function packageRootFrom(dir: string, what: string): string {
  let at = dir;
  for (let i = 0; i < 5; i++) {
    if (existsSync(resolve(at, "package.json"))) return at;
    at = resolve(at, "..");
  }
  throw new Error(`${what} not found (no package.json above module dir)`);
}

/** Is `at` this repo's checkout: the data itself (agents/ and prompts/) with
 * the review core's package beneath it? */
function isCheckout(at: string): boolean {
  return (
    existsSync(join(at, "agents")) &&
    existsSync(join(at, "prompts")) &&
    existsSync(join(at, "packages", "pi-plugin", "package.json"))
  );
}

/** The data root for a module in `dir`. The checkout comes first: a module
 * under it reads the repo root's data, never the frozen copy a pack of the
 * package makes in its `assets/` (the postpack removes it, but a pack that
 * stopped half way leaves it, and it is gitignored, so nothing shows it). Else
 * the first directory at or above `dir` that holds the data: an `assets/`
 * with `agents/` in it (an installed package; the answer is that `assets/`),
 * or one holding both `agents/` and `prompts/`. */
export function assetRootFrom(dir: string): string {
  const start = resolve(dir);
  for (let at = start; ; at = dirname(at)) {
    if (isCheckout(at)) return at;
    if (dirname(at) === at) break;
  }
  for (let at = start; ; at = dirname(at)) {
    if (existsSync(join(at, "assets", "agents"))) return join(at, "assets");
    if (existsSync(join(at, "agents")) && existsSync(join(at, "prompts"))) return at;
    if (dirname(at) === at) break;
  }
  throw new Error(
    `asset root not found: no assets/agents/, and no directory with agents/ and prompts/, above ${dir}`,
  );
}

/** The root of the review core's shipped data. */
export function assetRoot(): string {
  return assetRootFrom(dirname(fileURLToPath(import.meta.url)));
}

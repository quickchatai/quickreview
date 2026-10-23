// Where the review core's shipped data lives: prompts/, agents/, seeds/,
// profiles/ (the generic examples), schemas/, deploy/reviewer and the seed
// manifest. Resolved from this module's own location, so it is the package
// the core ships in — the checkout today, the plugin package once the core
// moves there — however that package was installed.
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
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

/** The root of the package the review core ships in: where its data lives. */
export function assetRoot(): string {
  return packageRootFrom(dirname(fileURLToPath(import.meta.url)), "asset root");
}

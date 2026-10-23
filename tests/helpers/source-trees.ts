// Where this repo's TypeScript lives: the app's src/ and extensions/ at the
// root, and the review core's own src/ and extensions/ in its package,
// packages/pi-plugin, laid out the same way. A fence that walks "the source"
// walks both, or it silently stops seeing the core.
import { existsSync } from "node:fs";
import { join } from "node:path";

/** The review core's package directory, repo-relative. */
export const CORE_PACKAGE = "packages/pi-plugin";

/** Every tree of .ts sources, repo-relative: the app's, then the core's. */
export const SRC_DIRS = ["src", `${CORE_PACKAGE}/src`] as const;

/** Every tree of extensions, repo-relative: the app's, then the core's. */
export const EXTENSION_DIRS = ["extensions", `${CORE_PACKAGE}/extensions`] as const;

/** The repo-relative path a file has now: `src/x.ts` (or `extensions/x.ts`)
 * as written, else its place in the core's package. Throws when neither
 * exists, so a fence that names a file by path cannot read a ghost. */
export function sourcePath(root: string, rel: string): string {
  if (existsSync(join(root, rel))) return rel;
  const moved = `${CORE_PACKAGE}/${rel}`;
  if (existsSync(join(root, moved))) return moved;
  throw new Error(`${rel}: no such source file, at the root or in ${CORE_PACKAGE}`);
}

/** The name the app imports the review core's package by. */
export const CORE_NAME = "@quickchatai/pi-quickreview";

/** `s` as a literal inside a RegExp. */
export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** Every `.js` specifier in `code` that names a source file: relative ones,
 * resolved from `file`, and the core's package specifiers, which name its
 * sources (`@quickchatai/pi-quickreview/src/x.js` is
 * packages/pi-plugin/src/x.ts). Absolute .ts paths; filter them against the
 * files a scan knows. */
export function sourceSpecifiers(root: string, file: string, code: string): string[] {
  return [
    ...[...code.matchAll(/["'](\.[^"']+)\.js["']/g)].map((m) => join(file, "..", `${m[1]!}.ts`)),
    ...[...code.matchAll(new RegExp(`["']${escapeRe(CORE_NAME)}/([^"']+)\\.js["']`, "g"))].map(
      (m) => join(root, CORE_PACKAGE, `${m[1]!}.ts`),
    ),
  ];
}

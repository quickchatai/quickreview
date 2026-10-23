// Where the core's own pi extensions are, as files: beside this module in
// whatever layout the package has. Built, this module is
// `dist/src/engine/extfiles.js` and the extensions are `dist/extensions/*.js`;
// run from source (vitest), it is `src/engine/extfiles.ts` and they are
// `extensions/*.ts`. Never a path under the caller's checkout: an installed
// package has none.
import { extname } from "node:path";
import { fileURLToPath } from "node:url";

/** The core's extension modules. */
export const CORE_EXTENSIONS = [
  "bash-guard",
  "finding-clusters",
  "ledger-pin",
  "lens",
  "pi-tool",
] as const;
export type CoreExtension = (typeof CORE_EXTENSIONS)[number];

/** The absolute file of the core extension `name`, resolved from `from` (this
 * module's URL by default). */
export function coreExtensionFile(name: CoreExtension, from: string = import.meta.url): string {
  const ext = extname(fileURLToPath(from)) === ".ts" ? ".ts" : ".js";
  return fileURLToPath(new URL(`../../extensions/${name}${ext}`, from));
}

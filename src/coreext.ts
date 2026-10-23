// The review core's own pi extensions, as the files the app hands pi. They are
// found through the core PACKAGE's directory, never under the app's root: an
// npm install of the app has no packages/ directory, the core being its own
// package beside it. A checkout links the workspace, whose sources are there,
// so pi loads the .ts; an installed core ships only its build, so pi loads
// dist/extensions/<name>.js.
//
// A leaf: node built-ins only, so the session manager and the debug and open
// routes reach it without the npm verbs' chain. Not even a type from the core:
// the core's extension names live in its engine/, which no daemon module's
// import closure may reach (tests/fences-engine.test.ts), type imports included.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** The pi plugin package the CLI depends on at its exact version. */
export const PLUGIN_PACKAGE = "@quickchatai/pi-quickreview";

/** The directory of the installed qcr pi plugin package: the one `qcr pi`
 * preloads. Found through its exported package.json, wherever the package
 * manager put it. */
export function pluginPackageDir(from: string = import.meta.url): string {
  const req = createRequire(from);
  return dirname(req.resolve(`${PLUGIN_PACKAGE}/package.json`));
}

/** The file of the core extension `name` in the package at `pkgDir`: its
 * source when the package has one (a checkout), else its build. */
export function coreExtensionPath(name: string, pkgDir: string = pluginPackageDir()): string {
  const source = join(pkgDir, "extensions", `${name}.ts`);
  return existsSync(source) ? source : join(pkgDir, "dist", "extensions", `${name}.js`);
}

const CORE_ENTRY_PREFIX = `${PLUGIN_PACKAGE}/extensions/`;

/** The entry an extension list carries for the core's `cluster_findings`
 * extension: a name in the core package, not a path under the app's root. */
export const FINDING_CLUSTERS_ENTRY = `${CORE_ENTRY_PREFIX}finding-clusters`;

/** The absolute file of one extension-list entry: an app shim is a path under
 * `root`, a core entry (`@quickchatai/pi-quickreview/extensions/<name>`) is
 * the core package's file (`coreExtensionPath`). */
export function extensionFile(root: string, entry: string, pkgDir?: string): string {
  if (!entry.startsWith(CORE_ENTRY_PREFIX)) return join(root, entry);
  const name = entry.slice(CORE_ENTRY_PREFIX.length);
  return coreExtensionPath(name, pkgDir);
}

// pi's own packages for the modules the plugin loads with Node's import().
//
// pi installs a package without its peer dependencies (`--omit=peer`, on
// purpose) and hands an extension its own modules through its loader's
// alias table. That covers the modules the loader loads: the entry and its
// static imports. The review's SDK is imported later with Node's own
// import() (src/engine/reviewruntime.ts), and Node resolves its bare
// specifiers from the plugin's install, where no pi is: ERR_MODULE_NOT_FOUND.
//
// The hook below resolves the plugin's declared peers (package.json
// `peerDependencies`) from the running pi's package dir instead, and only
// where Node found nothing from the importer. A host that installs pi beside
// the plugin (the qcr app, the image) never reaches the fallback, so its
// resolution is unchanged. One pi package dir per process: the first wins.
import { readFileSync } from "node:fs";
import * as nodeModule from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { packageRootFrom } from "../assetroot.js";

/** The packages the plugin's package.json declares as peers. */
export function declaredPeers(from: string = import.meta.url): string[] {
  const root = packageRootFrom(dirname(fileURLToPath(from)), "the plugin's package.json");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    peerDependencies?: Record<string, string>;
  };
  return Object.keys(pkg.peerDependencies ?? {});
}

/** Is `specifier` one of `peers` or a subpath of one? */
export function isPeer(specifier: string, peers: readonly string[]): boolean {
  return peers.some((p) => specifier === p || specifier.startsWith(`${p}/`));
}

interface ResolveContext {
  parentURL?: string | undefined;
  [key: string]: unknown;
}
type NextResolve = (specifier: string, context?: ResolveContext) => unknown;

/** The resolve hook: Node's own answer first; a peer Node cannot find from the
 * importer is resolved as if pi at `piDir` imported it. */
export function peerResolve(
  piDir: string,
  peers: readonly string[],
): (specifier: string, context: ResolveContext, next: NextResolve) => unknown {
  const parentURL = pathToFileURL(join(piDir, "package.json")).href;
  return (specifier, context, next) => {
    try {
      return next(specifier, context);
    } catch (err) {
      if ((err as { code?: string }).code !== "ERR_MODULE_NOT_FOUND" || !isPeer(specifier, peers))
        throw err;
      return next(specifier, { ...context, parentURL });
    }
  };
}

const INSTALLED = Symbol.for("qcr.plugin.piPeers");

/** Register the hook for this process, once; false where this Node has no
 * `module.registerHooks` or a hook is already in place. */
export function resolvePeersFrom(
  piDir: string,
  peers: readonly string[] = declaredPeers(),
): boolean {
  const g = globalThis as Record<symbol, unknown>;
  const register = (nodeModule as { registerHooks?: (hooks: { resolve: unknown }) => unknown })
    .registerHooks;
  if (g[INSTALLED] !== undefined || typeof register !== "function") return false;
  register({ resolve: peerResolve(piDir, peers) });
  g[INSTALLED] = piDir;
  return true;
}

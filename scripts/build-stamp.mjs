#!/usr/bin/env node
// The one "a whole build finished" signal the TUI's hot reload listens for.
//
// `tsc -b` builds two projects in order: the review core
// (packages/pi-plugin, into its own dist/) and then the app (into dist/).
// `noEmitOnError` holds per project, so a core edit that breaks the app still
// rewrites packages/pi-plugin/dist before the app fails to compile, and even a
// build that succeeds writes the core's dist seconds before the app's. A
// watcher on the core's dist would re-exec the TUI on a half-finished build:
// new core, old app. So the reload watches the app's dist/ (which changes only
// once the last project compiled) and this stamp, which every build route
// writes only after a whole pass succeeded: `npm run build` after tsc and
// verify-dist, `scripts/tsc-watch.mjs` after each "Found 0 errors" pass, and
// `scripts/dev-tui.sh` after its blocking build.
//
// The stamp is written only when a build output is newer than it, so a pass
// that emitted nothing (the watcher's first pass over an up-to-date tree)
// does not reload the TUI. It lives in the checkout's own state/ (beside the
// TUI's resume files and the watcher's log), outside every dist/ and outside
// node_modules/, which a worktree may share with the checkout it came from;
// `src/tui/reload.ts` names the same path (BUILD_STAMP).
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, "..");

/** The stamp, repo-relative. */
export const BUILD_STAMP = "state/build-complete";

/** The build output trees whose news the stamp carries. */
export const OUTPUT_DIRS = ["dist", "packages/pi-plugin/dist"];

/** The newest mtime (ms) of any file under `dir`, 0 when there is none. */
function newestUnder(dir) {
  let newest = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) newest = Math.max(newest, newestUnder(p));
    else newest = Math.max(newest, statSync(p, { throwIfNoEntry: false })?.mtimeMs ?? 0);
  }
  return newest;
}

/** Writes the stamp when a build output is newer than it (or it is missing
 * and an output exists). Returns whether it wrote. */
export function stampIfNewer(root = ROOT) {
  const stamp = join(root, BUILD_STAMP);
  const newest = Math.max(...OUTPUT_DIRS.map((d) => newestUnder(join(root, d))));
  if (newest === 0) return false;
  const last = existsSync(stamp) ? statSync(stamp).mtimeMs : -1;
  if (newest <= last) return false;
  mkdirSync(dirname(stamp), { recursive: true });
  writeFileSync(stamp, `${new Date().toISOString()}\n`);
  return true;
}

// `node scripts/build-stamp.mjs [root]` stamps; importing it does not.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)))
  stampIfNewer(process.argv[2] ? resolve(process.argv[2]) : ROOT);

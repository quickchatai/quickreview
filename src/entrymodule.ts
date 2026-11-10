// Is a module the process's entry? `node dist/src/cli.js` (the image's
// `qcr`) runs the app's `main`, and `node dist/src/qcrbin.js` (the detached
// review driver, src/reviewdetach.ts) runs the bin's front door; the npm bin
// (bin/qcr.js, reached through a package manager's link whose name is
// neither) imports the front door and calls it itself. A module asks with its
// own file, links resolved, so another script that merely shares the name is
// not it. Kept apart from both modules, so the front door loads nothing of
// the app's CLI to ask.
import { realpathSync } from "node:fs";

/** Whether `entry` (the process's argv[1]) is the module at `self`, links resolved. */
export function isEntryModule(entry: string | undefined, self: string): boolean {
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(self);
  } catch {
    return false;
  }
}

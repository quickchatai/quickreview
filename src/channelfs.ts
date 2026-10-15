// The file I/O of the scan's TUI↔companion records and channel files (the
// run record, the findings store, the stop and stage-2 start requests and
// their answers). A dependency-free leaf, so the two setup leaves the TUI
// imports (scanreport.ts, stage2request.ts) share it without reaching each
// other at runtime.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** A file's text, or null when it is ABSENT — any other failure throws, so a
 * reader can tell "not written yet" from "cannot be read". */
export function readTextIfPresent(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** tmp+rename: a reader never sees a half-written file. */
export function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

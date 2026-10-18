// The detached scan driver's log and launch bounds, shared by the two ways
// `qcr scan start` launches one: a host process (src/scancli.ts
// `detachDriver`) and a scan sandbox container (src/scanbox.ts). A leaf.
import { existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/** Under the state home: the detached driver's output. */
export const DRIVER_LOG = "scan/driver.log";
/** The driver log is rotated (one generation kept) past this size. */
export const DRIVER_LOG_MAX = 5 * 1024 * 1024;
/** How long a launch waits for the driver to say it started: planning
 * reads the tree at the sha, so this is generous. */
export const DETACH_TIMEOUT_MS = 120_000;

/** Make the driver log's directory and rotate the log past `logMax`; the
 * log's path, or why it cannot be prepared. */
export function prepareDriverLog(
  home: string,
  logMax: number = DRIVER_LOG_MAX,
): { ok: true; path: string } | { ok: false; error: string } {
  const log = join(home, DRIVER_LOG);
  try {
    mkdirSync(dirname(log), { recursive: true });
    if (existsSync(log) && statSync(log).size > logMax) renameSync(log, `${log}.1`);
    return { ok: true, path: log };
  } catch (err) {
    return {
      ok: false,
      error: `the driver log ${log} cannot be opened: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

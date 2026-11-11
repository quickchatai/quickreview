// Is the login refresher renewing the login right now. Its own module, importing
// only the status type, so the daemon's worker assembly and the `qcr model` verb
// (a route that must not reach the state store) ask the same question.

import type { LoginRefreshFileStatus } from "./types.js";

/** The file the login refresher publishes its state in, beside the login
 * (src/loginrefresh/refresher.ts `STATUS_FILE`). Named here because the
 * daemon does not import the refresher's own module. */
export const LOGIN_STATUS_FILE = "loginrefresh.status.json";

/** How old the refresher's last look at the login may be for its status to
 * count: twice its check interval (refresher.ts `CHECK_EVERY_MS`), so one late
 * check is not a dead refresher and a dead one is noticed within two. */
export const LOGIN_OWNER_FRESH_MS = 20 * 60_000;

/** Is a process with this pid there. One this process may not signal is. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Is the bot's refresher renewing the login right now: the `login_owner` a
 * worker's spec carries. True only when `[login_refresh]` is enabled and the
 * refresher's own status file (`statusText`, null when it cannot be read)
 * names a process that is there, says it looked at the login within
 * `LOGIN_OWNER_FRESH_MS`, is not paused for a login, and has no failure
 * standing. Anything else is false, and the worker then takes only a login
 * that lasts its whole command: a refresher that is off, gone, paused or
 * failing renews nothing, and a file that cannot be read says nothing about
 * one that works.
 */
export function loginOwnerOf(o: {
  enabled: boolean;
  statusText: string | null;
  now: number;
  /** Is the process the file names there. Omitted: asked of the system. */
  alive?: (pid: number) => boolean;
}): boolean {
  if (!o.enabled || o.statusText === null) return false;
  let status: Partial<LoginRefreshFileStatus> | null;
  try {
    status = JSON.parse(o.statusText) as Partial<LoginRefreshFileStatus> | null;
  } catch {
    return false;
  }
  if (typeof status !== "object" || status === null || Array.isArray(status)) return false;
  // Each fact has to be there and say so: a file without `paused` or
  // `last_error` is not one that reports neither.
  if (status.paused !== false || status.last_error !== null) return false;
  if (typeof status.checked_at !== "string") return false;
  const checked = Date.parse(status.checked_at);
  if (!Number.isFinite(checked) || Math.abs(o.now - checked) > LOGIN_OWNER_FRESH_MS) return false;
  // A file a refresher left behind (a daemon restart, a crash) is fresh for a
  // while after the process that wrote it is gone.
  const pid = status.pid;
  return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0
    ? (o.alive ?? pidAlive)(pid)
    : false;
}

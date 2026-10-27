// The login handover, in Node: what docker/entrypoint.sh's login mode does
// around pi's /login (login_handover_begin / login_handover_end), for a login
// made outside the container, by the home's re-login (src/home/loginowner.ts).
//
// On a single box the daemon's refresher owns the host pi home's auth.json
// while auto-review runs (one login per box, FT-0658). A login that rewrites
// that file beside it would race its refresh: whichever wrote last wins, and a
// refresh landing after the login would put the old grant back. So a login
// first asks the refresher to pause: it writes `auth.json.pause` and waits for
// `"paused": true` in the refresher's status file. A paused refresher neither
// refreshes nor writes, and KEEPS its lock, so no second refresher can start
// during the login. Releasing removes the pause file; the refresher re-reads
// the new login at once and resumes. A pause file left behind (the home killed
// mid-login) is lifted by the refresher after 15 minutes; while the hold
// lasts, the file's time is renewed so a slow device login is never cut off.
//
// Where no refresher holds the lock (auto-review off) nothing is paused: the
// home's own pi owns the login then, and its /login runs under pi's own lock.
// Nothing here reads or writes auth.json.
import { readFileSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loginLockHeld } from "./lock.js";
import { LOCK_FILE, PAUSE_FILE, STATUS_FILE } from "./refresher.js";

/** How long a login waits for the refresher to pause (the entrypoint's 60 s). */
export const PAUSE_WAIT_MS = 60_000;
/** How often the status file is read while waiting (the refresher looks at the
 * pause file every 2 s). */
export const PAUSE_POLL_MS = 500;
/** How often a held pause file's time is renewed: well inside the
 * refresher's 15 minutes. */
export const PAUSE_RENEW_MS = 5 * 60_000;

export type RefresherHold =
  /** `held`: a refresher was running and is paused now; false: none runs. */
  { ok: true; held: boolean; release(): void } | { ok: false; why: string };

export interface HoldOptions {
  flockBin?: string;
  /** When the lock cannot be probed (no flock here): does a refresher run?
   * null: unknown. */
  refresherRuns?: () => Promise<boolean | null>;
  waitMs?: number;
  pollMs?: number;
  renewMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Does a refresher hold the login in `agentDir` now? null: unknown. */
export async function refresherRuns(
  agentDir: string,
  o: Pick<HoldOptions, "flockBin" | "refresherRuns"> = {},
): Promise<boolean | null> {
  const held = loginLockHeld(join(agentDir, LOCK_FILE), o.flockBin ? { flockBin: o.flockBin } : {});
  if (held !== null) return held;
  return o.refresherRuns ? o.refresherRuns() : null;
}

/** The refresher's status file says it is paused. */
function pausedNow(statusPath: string): boolean {
  try {
    const v = JSON.parse(readFileSync(statusPath, "utf8")) as { paused?: unknown } | null;
    return v?.paused === true;
  } catch {
    return false;
  }
}

function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* lifted already */
  }
}

/**
 * Pause the refresher of the login in `agentDir` for a login, when one runs.
 * Answers once it is paused (or none runs), with the release; refuses when it
 * does not pause in time (the pause file is then removed again) or when
 * whether one runs cannot be told.
 */
export async function holdRefresher(agentDir: string, o: HoldOptions = {}): Promise<RefresherHold> {
  const runs = await refresherRuns(agentDir, o);
  if (runs === null)
    return {
      ok: false,
      why: "whether auto-review's login refresher runs can't be told on this machine",
    };
  if (!runs) return { ok: true, held: false, release: () => {} };
  const pause = join(agentDir, PAUSE_FILE);
  const status = join(agentDir, STATUS_FILE);
  try {
    writeFileSync(pause, "", { mode: 0o660 });
  } catch (err) {
    return {
      ok: false,
      why: `can't write ${pause}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const sleep = o.sleep ?? realSleep;
  const now = o.now ?? Date.now;
  const waitMs = o.waitMs ?? PAUSE_WAIT_MS;
  const until = now() + waitMs;
  while (!pausedNow(status)) {
    if (now() >= until) {
      removeQuietly(pause);
      return {
        ok: false,
        why: `auto-review's login refresher did not pause within ${Math.round(waitMs / 1000)} s (${status})`,
      };
    }
    await sleep(o.pollMs ?? PAUSE_POLL_MS);
  }
  const renew = setInterval(() => {
    try {
      const t = new Date();
      utimesSync(pause, t, t);
    } catch {
      /* lifted meanwhile */
    }
  }, o.renewMs ?? PAUSE_RENEW_MS);
  renew.unref?.();
  let released = false;
  return {
    ok: true,
    held: true,
    release: () => {
      if (released) return;
      released = true;
      clearInterval(renew);
      removeQuietly(pause);
    },
  };
}

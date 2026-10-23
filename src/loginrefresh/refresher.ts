// The bot login's single refresher (P8.22, the VM-only exception to D5).
//
// After the cutover no pi session lives long enough to refresh the bot's login:
// workers borrow refresh-blanked copies (src/engine/auth.ts). So ONE process
// owns `pihome/agent/auth.json`: this one. It is a separate small Node process
// (main.ts) the daemon spawns and supervises by path, so the daemon imports
// neither pi nor src/engine/.
//
//   Lock      an exclusive flock on `auth.json.lock` for its whole life (lock.ts);
//             a second refresher is refused, before and after any refresh.
//   Refresh   every 10 minutes, any OAuth entry that is inside pi's refresh
//             window plus a margin longer than the longest worker cap is
//             refreshed through `deps.refresh` (pi-ai's own, pirefresh.ts) and
//             written back atomically (atomic.ts): borrowers take no lock and
//             always read a whole file.
//   Failure   one `onFailure` per failure episode (the daemon raises one
//             `login_refresh_failed` anomaly); a success ends the episode.
//   Login     the entrypoint's login mode writes `auth.json.pause` and waits for
//             `paused: true` in the status file. The refresher then neither
//             refreshes nor writes, but KEEPS the lock, so no second refresher
//             can start during the login. When the pause file goes it re-reads
//             the (new) file and resumes. A pause file left behind is lifted
//             after 15 minutes.
//
// Nothing in here reads or prints a token outside the file it owns.
import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.js";
import { acquireLoginLock, type LoginLock } from "./lock.js";
import type { LoginRefreshFileStatus } from "./types.js";

export const AUTH_FILE = "auth.json";
export const LOCK_FILE = "auth.json.lock";
export const PAUSE_FILE = "auth.json.pause";
export const STATUS_FILE = "loginrefresh.status.json";

/** How often the expiry is checked. */
export const CHECK_EVERY_MS = 10 * 60_000;
/** How often the pause file is looked at, so a login is not kept waiting. */
export const PAUSE_POLL_MS = 2_000;
/** A pause file older than this was left behind and is lifted. */
export const PAUSE_STALE_MS = 15 * 60_000;
/** pi refreshes an OAuth token with less than this left (pi-ai auth/resolve.js
 * DEFAULT_OAUTH_MINIMUM_VALIDITY_MS). VERIFY-ON-PIN. */
export const PI_REFRESH_WINDOW_MS = 5 * 60_000;
/** A refresh request is abandoned after this (pi's own bound). */
export const REFRESH_TIMEOUT_MS = 15_000;

/** One OAuth entry of auth.json, as pi stores it. */
export interface OAuthEntry {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  [key: string]: unknown;
}

export type RefreshFn = (
  provider: string,
  credential: OAuthEntry,
  signal: AbortSignal,
) => Promise<Omit<OAuthEntry, "type"> & { type?: "oauth" }>;

export interface RefresherDeps {
  /** pi's agent dir: where auth.json, its lock, pause file and status live. */
  agentDir: string;
  refresh: RefreshFn;
  /** Refresh when the token has less than pi's window plus this left: longer
   * than the longest worker cap, so a worker that borrowed the file can finish. */
  marginMs: number;
  log: (msg: string, extra?: unknown) => void;
  /** Called once per failure episode, with a redacted message. */
  onFailure?: (message: string) => void;
  /** The login group a new file is given (default: auth.json's own). */
  gid?: number | undefined;
  now?: () => number;
  checkEveryMs?: number;
  /** How often the pause file is looked at (default PAUSE_POLL_MS). */
  pollMs?: number;
  pauseStaleMs?: number;
  flockBin?: string;
}

/** An error text safe to log and publish: token-looking runs removed, bounded. */
export function redactError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/[A-Za-z0-9._~+/=-]{32,}/g, "[redacted]").slice(0, 300);
}

function isOAuthEntry(v: unknown): v is OAuthEntry {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  return c["type"] === "oauth" && typeof c["expires"] === "number";
}

export class LoginRefresher {
  private readonly auth: string;
  private readonly pause: string;
  private readonly statusPath: string;
  private readonly now: () => number;
  private readonly checkEveryMs: number;
  private readonly pauseStaleMs: number;
  private readonly startedAt: string;
  private nextCheckAt = 0;
  private busy = false;
  private paused = false;
  private expiresAt: number | null = null;
  private provider: string | null = null;
  private lastRefresh: string | null = null;
  private lastError: string | null = null;
  private errorSince: string | null = null;
  private checkedAt: string | null = null;
  /** A refreshed file that could not be written yet: the rotated refresh token
   * lives only here, so the next check writes it before anything else. */
  private unsaved: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  private constructor(
    private readonly deps: RefresherDeps,
    private readonly lock: LoginLock,
  ) {
    this.auth = join(deps.agentDir, AUTH_FILE);
    this.pause = join(deps.agentDir, PAUSE_FILE);
    this.statusPath = join(deps.agentDir, STATUS_FILE);
    this.now = deps.now ?? Date.now;
    this.checkEveryMs = deps.checkEveryMs ?? CHECK_EVERY_MS;
    this.pauseStaleMs = deps.pauseStaleMs ?? PAUSE_STALE_MS;
    this.startedAt = new Date(this.now()).toISOString();
  }

  /**
   * Take the lock (throws `LoginLockHeld` when another refresher has it), look
   * at the login once, and, unless `autoRun` is false (tests drive `tick`),
   * keep looking.
   */
  static async start(deps: RefresherDeps, o: { autoRun?: boolean } = {}): Promise<LoginRefresher> {
    const lock = await acquireLoginLock(join(deps.agentDir, LOCK_FILE), {
      ...(deps.flockBin ? { flockBin: deps.flockBin } : {}),
      gid: deps.gid,
    });
    const r = new LoginRefresher(deps, lock);
    r.publish();
    await r.tick();
    if (o.autoRun !== false) {
      r.timer = setInterval(() => {
        void r.tick().catch((err) => deps.log("login refresh: tick failed", err));
      }, deps.pollMs ?? PAUSE_POLL_MS);
    }
    return r;
  }

  /** Resolves with a reason when the lock is lost under us (the process must end). */
  get lost(): Promise<string | undefined> {
    return this.lock.lost;
  }

  status(): LoginRefreshFileStatus {
    return {
      pid: process.pid,
      started_at: this.startedAt,
      expires_at: this.expiresAt === null ? null : new Date(this.expiresAt).toISOString(),
      provider: this.provider,
      last_refresh: this.lastRefresh,
      last_error: this.lastError,
      error_since: this.errorSince,
      paused: this.paused,
      checked_at: this.checkedAt,
    };
  }

  /** Stop looking and drop the lock. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.lock.release();
  }

  /** One look: the pause file first, then the expiry when it is due. */
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      if (this.pauseActive()) {
        if (!this.paused) {
          this.paused = true;
          this.deps.log("login refresh: paused for a login (lock kept)");
          this.publish();
        }
        return;
      }
      if (this.paused) {
        // The login ended: whatever it wrote is the file now. Look at once.
        this.paused = false;
        this.nextCheckAt = 0;
        // A refreshed file held back from before the login is older than it.
        this.unsaved = null;
        this.deps.log("login refresh: resumed");
        this.publish();
      }
      if (this.now() < this.nextCheckAt) return;
      await this.check();
    } finally {
      this.busy = false;
    }
  }

  /** True while a login holds the pause. A stale file is removed (and false). */
  private pauseActive(): boolean {
    let mtime: number;
    try {
      mtime = statSync(this.pause).mtimeMs;
    } catch {
      return false;
    }
    if (this.now() - mtime < this.pauseStaleMs) return true;
    try {
      unlinkSync(this.pause);
    } catch {
      /* lifted by someone else meanwhile */
    }
    this.deps.log(
      `login refresh: lifted a pause file left behind for over ${Math.round(this.pauseStaleMs / 60_000)} minutes`,
    );
    return false;
  }

  private async check(): Promise<void> {
    this.nextCheckAt = this.now() + this.checkEveryMs;
    this.checkedAt = new Date(this.now()).toISOString();
    const failures: string[] = [];

    if (this.unsaved !== null) {
      try {
        writeFileAtomic(this.auth, this.unsaved, { gid: this.deps.gid });
        this.unsaved = null;
      } catch (err) {
        failures.push(`could not write the refreshed login: ${redactError(err)}`);
      }
    }

    let parsed: Record<string, unknown> | null = null;
    if (this.unsaved === null && !existsSync(this.auth)) {
      this.expiresAt = null;
      this.provider = null;
    }
    if (this.unsaved === null && existsSync(this.auth)) {
      try {
        const v: unknown = JSON.parse(readFileSync(this.auth, "utf8"));
        if (typeof v !== "object" || v === null || Array.isArray(v))
          throw new Error("not an object");
        parsed = v as Record<string, unknown>;
      } catch (err) {
        failures.push(`auth.json is unreadable: ${redactError(err)}`);
      }
    }

    if (parsed) {
      const threshold = this.now() + PI_REFRESH_WINDOW_MS + this.deps.marginMs;
      for (const [name, entry] of Object.entries(parsed)) {
        if (!isOAuthEntry(entry) || entry.expires > threshold) continue;
        try {
          const fresh = await this.deps.refresh(
            name,
            entry,
            AbortSignal.timeout(REFRESH_TIMEOUT_MS),
          );
          parsed[name] = { ...entry, ...fresh, type: "oauth" };
          this.lastRefresh = new Date(this.now()).toISOString();
          // Persist now: the provider may have rotated the refresh token.
          const text = JSON.stringify(parsed, null, 2) + "\n";
          try {
            writeFileAtomic(this.auth, text, { gid: this.deps.gid });
          } catch (err) {
            this.unsaved = text;
            failures.push(`could not write the refreshed ${name} login: ${redactError(err)}`);
            break;
          }
          this.deps.log(`login refresh: refreshed ${name}`);
        } catch (err) {
          failures.push(`${name}: ${redactError(err)}`);
        }
      }
      this.expiresAt = null;
      this.provider = null;
      for (const [name, entry] of Object.entries(parsed)) {
        if (!isOAuthEntry(entry)) continue;
        if (this.expiresAt === null || entry.expires < this.expiresAt) {
          this.expiresAt = entry.expires;
          this.provider = name;
        }
      }
    }

    if (failures.length > 0) this.fail(failures.join("; "));
    else this.recover();
    this.publish();
  }

  private fail(message: string): void {
    this.lastError = message;
    this.deps.log(`login refresh: failed — ${message}`);
    if (this.errorSince !== null) return;
    this.errorSince = new Date(this.now()).toISOString();
    try {
      this.deps.onFailure?.(message);
    } catch (err) {
      this.deps.log("login refresh: failure hook threw", err);
    }
  }

  private recover(): void {
    if (this.errorSince !== null) this.deps.log("login refresh: recovered");
    this.lastError = null;
    this.errorSince = null;
  }

  private publish(): void {
    try {
      writeFileAtomic(this.statusPath, JSON.stringify(this.status(), null, 2) + "\n", {
        gid: this.deps.gid,
      });
    } catch (err) {
      this.deps.log("login refresh: status file not written", err);
    }
  }
}

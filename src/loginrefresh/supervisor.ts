// The login refresher as a supervised child of the daemon.
//
// The daemon spawns `dist/src/loginrefresh/main.js` BY PATH, like the local
// embedder (src/openviking/embedder.ts), so it imports neither pi nor
// src/engine/ (tests/fences-engine.test.ts holds the second, and
// tests/loginrefresh.test.ts the first). Same three properties as the other
// supervised children: `start()` never blocks, a crash respawns on a capped
// ladder forever, `status()` is synchronous and total.
//
// What the daemon adds to the refresher's own file (loginrefresh.status.json):
//   - one `login_refresh_failed` anomaly per failure episode, through the
//     existing anomaly sink (`raiseAnomaly` is store.logAnomaly), so a refresh
//     that cannot work is known at the first failure and not at authwatch's
//     "expires in under 48 h" backstop;
//   - `paused()` / `whenResumed()`: the spawn supervisor (the per-round
//     worker) holds spawns while a login has the refresher paused, because a
//     borrower's copy of a file a login is rewriting may not parse.
//
// Only started when `[login_refresh] enabled` (the cutover's config): until the
// bot's tmux pi sessions are gone they refresh auth.json themselves, and a
// second refresher would rotate the refresh token under them.
import { existsSync, readFileSync } from "node:fs";
import { spawn as nodeSpawn } from "node:child_process";
import { isAbsolute, join } from "node:path";
import {
  foldChildLines,
  restartDelayMs,
  terminateChild,
  type Schedule,
  type SpawnFn,
  type SupervisedChild,
} from "../openviking/supervisor.js";
import { LOCK_HELD_EXIT } from "./lock.js";
import type { LoginRefreshFileStatus, LoginRefreshStatus } from "./types.js";

/** Names the login's dir when it is not pi's agent dir. The single box's
 * shared login (one login per box): the home's switch-on mounts the
 * host pi home's agent dir at CONTAINER_LOGIN_DIR (docker-compose.yml,
 * QCR_PI_LOGIN_DIR in the project .env) and the compose file names it here.
 * Only the login moves: the refresher keeps auth.json there and every worker
 * borrows from there, while settings, models.json and the lens agents stay in
 * the container's own agent dir, whose settings the entrypoint provisions and
 * which must never be the person's own. */
export const LOGIN_DIR_ENV = "QCR_LOGIN_DIR";
/** Where docker-compose.yml mounts the host's login. */
export const CONTAINER_LOGIN_DIR = "/opt/qcr/login";

/** The login's dir: `QCR_LOGIN_DIR` when it is an absolute path, else pi's
 * agent dir (the login volume, as before). */
export function loginDirOf(
  env: Readonly<Record<string, string | undefined>>,
  agentDir: string,
): string {
  const set = (env[LOGIN_DIR_ENV] ?? "").trim();
  return set !== "" && isAbsolute(set) ? set : agentDir;
}

/** The restart ladder, ms: a refresher that cannot start (lock held, config) is
 * retried slowly; one that crashed after a good run is retried at once. */
export const LOGIN_RESTART_LADDER_MS = [2_000, 10_000, 60_000];
/** A run this long resets the ladder. */
const RESET_AFTER_MS = 60_000;
/** How often the status file is read for the heartbeat and the failure episodes. */
export const LOGIN_STATUS_POLL_MS = 5_000;

export interface LoginRefreshSupervisorDeps {
  /** The checkout root: where `dist/src/loginrefresh/main.js` lives. */
  repoRoot: string;
  /** The login's dir: pi's agent dir (the login volume's `agent/`), or the
   * single box's shared login (`loginDirOf`). */
  agentDir: string;
  marginMin: number;
  /** The login group, when the daemon knows it. */
  gid?: number | undefined;
  log: (msg: string, extra?: unknown) => void;
  /** store.logAnomaly("login_refresh_failed", null, null, detail). */
  raiseAnomaly: (detail: string) => void;
  spawn?: SpawnFn;
  schedule?: Schedule;
  now?: () => Date;
  exists?: (path: string) => boolean;
  readStatusFile?: () => string | null;
}

const defaultSchedule: Schedule = (fn, ms) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return () => clearTimeout(t);
};

export function loginRefreshMain(repoRoot: string): string {
  return join(repoRoot, "dist", "src", "loginrefresh", "main.js");
}

export class LoginRefreshSupervisor {
  private readonly main: string;
  private readonly spawnFn: SpawnFn;
  private readonly schedule: Schedule;
  private readonly now: () => Date;
  private readonly exists: (path: string) => boolean;
  private readonly readStatusFile: () => string | null;
  private started = false;
  private stopping = false;
  private state: LoginRefreshStatus["state"] = "off";
  private reason: string | undefined = "not started";
  private child: SupervisedChild | null = null;
  private startedAt: number | null = null;
  private attempt = 0;
  private restarts = 0;
  private lastExit: LoginRefreshStatus["last_exit"];
  private file: LoginRefreshFileStatus | undefined;
  private raisedFor: string | null = null;
  private cancelRestart: (() => void) | null = null;
  private cancelPoll: (() => void) | null = null;
  private resumeWaiters: Array<() => void> = [];

  constructor(private readonly deps: LoginRefreshSupervisorDeps) {
    this.main = loginRefreshMain(deps.repoRoot);
    this.spawnFn = deps.spawn ?? ((cmd, args, opts) => nodeSpawn(cmd, args, opts));
    this.schedule = deps.schedule ?? defaultSchedule;
    this.now = deps.now ?? (() => new Date());
    this.exists = deps.exists ?? existsSync;
    this.readStatusFile =
      deps.readStatusFile ??
      (() => {
        try {
          return readFileSync(join(deps.agentDir, "loginrefresh.status.json"), "utf8");
        } catch {
          return null;
        }
      });
  }

  /** Spawn the refresher and arm the status poll. Synchronous, non-blocking. */
  start(): void {
    if (this.started) return;
    this.started = true;
    if (!this.exists(this.main)) {
      this.state = "unavailable";
      this.reason = `${this.main} not found — the build carries it; this one predates it`;
      this.deps.log(`login refresh: unavailable — ${this.reason}`);
      return;
    }
    this.state = "supervised";
    this.reason = undefined;
    this.spawnChild();
    this.armPoll();
  }

  /** A login holds the handover: spawns that borrow auth.json wait. */
  paused(): boolean {
    return this.current()?.paused === true;
  }

  /** The cached file, only while it is the running refresher's own: a leftover
   * from a process that died (or from before a daemon restart) says nothing
   * about the refresher now holding the lock. */
  private current(): LoginRefreshFileStatus | undefined {
    const file = this.file;
    if (!file || this.child === null) return undefined;
    return this.child.pid === undefined || file.pid === this.child.pid ? file : undefined;
  }

  /** Resolves true once the refresher is not paused (at once when it is not),
   * false after `timeoutMs`. For the spawn supervisor's hold. */
  whenResumed(timeoutMs: number): Promise<boolean> {
    if (!this.paused()) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const cancel = this.schedule(() => {
        this.resumeWaiters = this.resumeWaiters.filter((w) => w !== wake);
        resolve(false);
      }, timeoutMs);
      const wake = (): void => {
        cancel();
        resolve(true);
      };
      this.resumeWaiters.push(wake);
    });
  }

  status(): LoginRefreshStatus {
    try {
      return {
        state: this.state,
        ...(this.reason ? { reason: this.reason } : {}),
        running: this.child !== null,
        restarts: this.restarts,
        ...(this.lastExit ? { last_exit: this.lastExit } : {}),
        ...(this.file ? { login: this.file } : {}),
      };
    } catch {
      return { state: this.state, running: false, restarts: this.restarts };
    }
  }

  /** SIGTERM the refresher (its lock goes with it) and stop supervising. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.cancelRestart?.();
    this.cancelPoll?.();
    for (const w of this.resumeWaiters.splice(0)) w();
    if (this.child) await terminateChild(this.child, this.schedule);
  }

  private spawnChild(): void {
    if (this.stopping) return;
    this.cancelRestart = null;
    try {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        QCR_LOGIN_AGENT_DIR: this.deps.agentDir,
        QCR_LOGIN_MARGIN_MIN: String(this.deps.marginMin),
      };
      if (this.deps.gid !== undefined) env["QCR_LOGIN_GID"] = String(this.deps.gid);
      const child = this.spawnFn(process.execPath, [this.main], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.child = child;
      this.startedAt = this.now().getTime();
      foldChildLines(child, (line) => this.deps.log(line));
      child.on("error", (err) => {
        this.deps.log("login refresh: spawn error", err);
        if (this.child !== child || child.pid !== undefined) return;
        this.child = null;
        this.scheduleRestart();
      });
      child.on("exit", (code, signal) => this.onExit(child, code, signal));
      this.deps.log(`login refresh: started (pid ${child.pid ?? "?"})`);
    } catch (err) {
      this.child = null;
      this.deps.log("login refresh: spawn failed", err);
      this.scheduleRestart();
    }
  }

  private onExit(child: SupervisedChild, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child !== child) return;
    const upMs = this.startedAt !== null ? this.now().getTime() - this.startedAt : 0;
    this.child = null;
    this.startedAt = null;
    this.lastExit = { code, signal, at: this.now().toISOString() };
    // a dead refresher holds no login handover: release the spawn hold now
    for (const w of this.resumeWaiters.splice(0)) w();
    if (this.stopping) return;
    if (upMs >= RESET_AFTER_MS) this.attempt = 0;
    this.deps.log(
      code === LOCK_HELD_EXIT
        ? "login refresh: another refresher holds the lock — retrying later"
        : `login refresh: exited (code=${code ?? "null"} signal=${signal ?? "null"})`,
    );
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.stopping) return;
    const delay = restartDelayMs(LOGIN_RESTART_LADDER_MS, this.attempt);
    this.attempt += 1;
    this.restarts += 1;
    this.cancelRestart = this.schedule(() => this.spawnChild(), delay);
  }

  private armPoll(): void {
    if (this.stopping) return;
    this.cancelPoll = this.schedule(() => {
      this.readFile();
      this.armPoll();
    }, LOGIN_STATUS_POLL_MS);
  }

  /** Read the refresher's file: cache it, raise the episode's anomaly once,
   * wake the spawn hold. Never throws. */
  readFile(): void {
    try {
      const raw = this.readStatusFile();
      if (raw === null) return;
      const file = JSON.parse(raw) as LoginRefreshFileStatus;
      this.file = file;
      // the published file is shown as-is, but only the running refresher's own
      // drives the episode and the hold (see current())
      if (!this.current()) return;
      if (file.error_since === null || file.error_since === undefined) this.raisedFor = null;
      else if (this.raisedFor !== file.error_since) {
        this.deps.raiseAnomaly(
          `the bot's model login could not be refreshed since ${file.error_since}: ${file.last_error ?? "no detail"}` +
            ` (token expires ${file.expires_at ?? "unknown"}); recover with the entrypoint's login mode`,
        );
        // marked only once raised: a failed write leaves the episode to the next poll
        this.raisedFor = file.error_since;
      }
      if (!this.paused()) for (const w of this.resumeWaiters.splice(0)) w();
    } catch (err) {
      this.deps.log("login refresh: status file unreadable", err);
    }
  }
}

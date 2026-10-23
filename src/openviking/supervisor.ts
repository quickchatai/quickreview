// The OpenViking server as a supervised child of the daemon.
//
// Why the daemon and not a second entrypoint process: the container has ONE
// PID 1 (docker's `init: true` reaps, the entrypoint execs the daemon), and a
// backgrounded server in the entrypoint would have no owner — nothing to
// notice a crash, nothing to fold its logs into `docker logs`, nothing to
// report it in the heartbeat. Here the daemon owns it end to end.
//
// Three properties this shape enforces rather than documents:
//
//   * No boot ordering. `start()` never waits for the server to become ready;
//     the daemon comes up regardless and rounds run memory-less until `/ready`
//     passes. Nothing in this module can delay or block a review round.
//   * Never gives up. A crash schedules a respawn on a capped backoff ladder,
//     forever. An engine that stays down is worse than a slow retry, and every
//     memory call site already degrades.
//   * Never throws at the heartbeat. `status()` is synchronous, reads only
//     cached samples, and returns a minimal block on any internal error — the
//     status writer must not be able to fail on the memory engine.
//
// Monitoring only: RSS/CPU ride the heartbeat, with no RSS watchdog and no
// auto-restart on a memory budget. Do not add one.
//
// `[openviking] endpoint = "remote"` is the memory sidecar (docker/memory/):
// the server is some other container's process. This class then supervises
// nothing — no binary check, no spawn, no restart ladder — and keeps only the
// health loop, so the heartbeat, `onReady` and memory health read the sidecar
// the same way they read the child. `local` (the default) never reaches that
// branch: its code path is the one that was here before the switch.
import { existsSync } from "node:fs";
import { spawn as nodeSpawn } from "node:child_process";
import { openVikingBaseUrl, type OpenVikingConfig } from "../config.js";
import { probeHealth, type FetchLike } from "./health.js";
import { ProcSampler } from "./proc.js";
import type { OpenVikingHealth, OpenVikingStatus, ProcSample } from "./types.js";

/** The slice of ChildProcess this module uses — the whole spawn seam. */
export interface SupervisedChild {
  readonly pid?: number | undefined;
  stdout: { on(event: "data", cb: (chunk: unknown) => void): unknown } | null;
  stderr: { on(event: "data", cb: (chunk: unknown) => void): unknown } | null;
  on(event: "exit", cb: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", cb: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv; stdio: ["ignore", "pipe", "pipe"] },
) => SupervisedChild;

/** A scheduled callback plus its canceller — the single timer seam, so tests
 * drive restarts and health polls without real clocks. */
export type Schedule = (fn: () => void, ms: number) => () => void;

/** How long a SIGTERM'd child gets before SIGKILL on daemon shutdown. */
const STOP_GRACE_MS = 5_000;

/** A supervised child's stdout and stderr, line-buffered: each complete,
 * non-blank line (trailing whitespace trimmed) goes to `onLine`; a partial
 * chunk waits for the rest of its line. */
export function foldChildLines(child: SupervisedChild, onLine: (line: string) => void): void {
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    let buffer = "";
    stream.on("data", (chunk: unknown) => {
      buffer += String(chunk);
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) onLine(line.trimEnd());
    });
  }
}

/** The capped restart ladder: the delay before restart number `attempt + 1`
 * (the last rung repeats; an empty ladder is 5 s). */
export function restartDelayMs(ladder: readonly number[], attempt: number): number {
  const rungs = ladder.length > 0 ? ladder : [5000];
  return rungs[Math.min(attempt, rungs.length - 1)]!;
}

/** Stop a child: SIGTERM, then SIGKILL after `STOP_GRACE_MS`; resolves at its
 * exit, at the kill, or at once when the signal cannot be sent (already
 * gone). Never rejects. */
export function terminateChild(child: SupervisedChild, schedule: Schedule): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const cancelKill = schedule(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      finish();
    }, STOP_GRACE_MS);
    child.on("exit", () => {
      cancelKill();
      finish();
    });
    try {
      child.kill("SIGTERM");
    } catch {
      cancelKill();
      finish();
    }
  });
}

export interface SupervisorDeps {
  cfg: OpenVikingConfig;
  log: (msg: string, extra?: unknown) => void;
  spawn?: SpawnFn;
  fetchFn?: FetchLike;
  now?: () => Date;
  /** Test seam for the binary-presence guard. */
  exists?: (path: string) => boolean;
  sampler?: ProcSampler;
  schedule?: Schedule;
  /** Fired by the health loop each time `/ready` turns from not-ready to
   * ready — the first pass after boot and again after every restart. The one
   * hook for work that needs a LIVE server and must not be awaited at boot
   * (the daemon materializes the memory root here). A throw is logged and
   * swallowed: a callback cannot take the health loop down. */
  onReady?: () => void;
  /** The address the spawned server binds (`--host`), when it differs from
   * the address the daemon probes (`cfg.host`). The sidecar binds every
   * interface of its private network and probes itself on loopback. */
  bindHost?: string;
  /** A precondition for the first spawn — the local embedder the
   * server's `/ready` probes. Polled every `pollMs` until `open()` holds or
   * `maxWaitMs` has passed; past the bound the server starts anyway, said
   * loudly (searches fail until the embedder serves — memory is degraded,
   * never held back for good). A respawn never waits: a server crash is not
   * the embedder's to gate, and `start()` still returns at once. */
  startGate?: { open: () => boolean; maxWaitMs: number; pollMs?: number; what: string };
}

const defaultSchedule: Schedule = (fn, ms) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return () => clearTimeout(t);
};

export class OpenVikingSupervisor {
  private readonly cfg: OpenVikingConfig;
  private readonly log: (msg: string, extra?: unknown) => void;
  private readonly spawnFn: SpawnFn;
  private readonly fetchFn: FetchLike | undefined;
  private readonly now: () => Date;
  private readonly exists: (path: string) => boolean;
  private readonly sampler: ProcSampler;
  private readonly schedule: Schedule;
  private readonly onReady: (() => void) | undefined;
  private readonly startGate: SupervisorDeps["startGate"];
  private readonly bindHost: string;
  private readonly remote: boolean;
  private waitingSince: number | null = null;
  private cancelGate: (() => void) | null = null;

  private child: SupervisedChild | null = null;
  private childPid: number | undefined;
  private startedAt: number | null = null;
  private attempt = 0;
  private restarts = 0;
  private stopping = false;
  private started = false;
  private unavailable = false;

  private health: OpenVikingHealth | null = null;
  /** Consecutive polls that reached the server but not its `/ready`. */
  private notReadyPolls = 0;
  private proc: ProcSample | undefined;
  private lastExit: OpenVikingStatus["last_exit"];
  private lastError: string | undefined;

  private cancelRestart: (() => void) | null = null;
  private cancelHealth: (() => void) | null = null;

  constructor(deps: SupervisorDeps) {
    this.cfg = deps.cfg;
    this.log = deps.log;
    this.spawnFn = deps.spawn ?? ((cmd, args, opts) => nodeSpawn(cmd, args, opts));
    this.fetchFn = deps.fetchFn;
    this.now = deps.now ?? (() => new Date());
    this.exists = deps.exists ?? existsSync;
    this.sampler = deps.sampler ?? new ProcSampler();
    this.schedule = deps.schedule ?? defaultSchedule;
    this.onReady = deps.onReady;
    this.startGate = deps.startGate;
    this.bindHost = deps.bindHost ?? deps.cfg.host;
    this.remote = deps.cfg.endpoint === "remote";
  }

  /** Spawn the server and arm the health loop. Synchronous and non-blocking:
   * the daemon's boot never waits on the memory engine. */
  start(): void {
    if (this.started) return;
    this.started = true;
    if (!this.cfg.enabled) {
      this.log("openviking: disabled in config.toml — the daemon runs memory-less");
      return;
    }
    if (this.remote) {
      // The memory sidecar owns the server. Nothing to spawn, nothing to
      // restart — a down sidecar is the container runtime's to restart —
      // and the first probe is fired, never awaited.
      this.log(
        `openviking: endpoint = remote — the memory sidecar serves ${openVikingBaseUrl(this.cfg)}; the daemon only probes it`,
      );
      void this.poll().finally(() => this.armHealthLoop());
      return;
    }
    // A dev PC has no venv. Report unavailable ONCE and stop; the binary will
    // not appear without an image rebuild, so retrying is pure noise.
    if (!this.exists(this.cfg.bin)) {
      this.unavailable = true;
      this.lastError = `binary not found: ${this.cfg.bin}`;
      this.log(`openviking: ${this.lastError} — not supervising (rounds run memory-less)`);
      return;
    }
    if (this.startGate && !this.gateOpen()) {
      this.waitingSince = this.now().getTime();
      this.log(`openviking: waiting for ${this.startGate.what} before starting the server`);
      this.waitForGate();
      return;
    }
    this.spawnChild();
    this.armHealthLoop();
  }

  private gateOpen(): boolean {
    try {
      return this.startGate?.open() ?? true;
    } catch (err) {
      // A gate that throws is no reason to keep memory down.
      this.log("openviking: start gate threw — starting the server", err);
      return true;
    }
  }

  /** Poll the start gate on the timer seam; spawn once it opens or
   * its bound passes. */
  private waitForGate(): void {
    const gate = this.startGate;
    if (!gate || this.stopping) return;
    this.cancelGate = this.schedule(() => {
      this.cancelGate = null;
      if (this.stopping) return;
      const waited = this.now().getTime() - (this.waitingSince ?? this.now().getTime());
      if (this.gateOpen()) {
        this.log(`openviking: ${gate.what} is ready — starting the server`);
      } else if (waited >= gate.maxWaitMs) {
        this.log(
          `openviking: ${gate.what} is not ready after ${Math.round(waited / 1000)}s — starting the server anyway; memory search fails until it serves`,
        );
      } else {
        this.waitForGate();
        return;
      }
      this.waitingSince = null;
      this.spawnChild();
      this.armHealthLoop();
    }, gate.pollMs ?? 500);
  }

  private spawnChild(): void {
    if (this.stopping) return;
    this.cancelRestart = null;
    this.notReadyPolls = 0;
    const args = [
      "--config",
      this.cfg.config_file,
      "--host",
      this.bindHost,
      "--port",
      String(this.cfg.port),
    ];
    try {
      const child = this.spawnFn(this.cfg.bin, args, {
        ...(this.exists(this.cfg.home) ? { cwd: this.cfg.home } : {}),
        env: { ...process.env, OPENVIKING_CONFIG_FILE: this.cfg.config_file },
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.child = child;
      this.childPid = child.pid;
      this.startedAt = this.now().getTime();
      this.sampler.reset();
      this.foldLogs(child);
      child.on("error", (err) => {
        // A spawn failure surfaces here, not as a throw. Treat it as an exit so
        // the backoff ladder governs the retry.
        this.lastError = err.message;
        this.log("openviking: spawn error", err);
        // Node emits `error` then `close` for a failed spawn — never `exit` —
        // and leaves `pid` unset. An error on a child that HAS a pid (a failed
        // kill) is not an exit: the live process stays tracked.
        if (this.child !== child || child.pid !== undefined) return;
        this.child = null;
        this.childPid = undefined;
        this.startedAt = null;
        this.sampler.reset();
        this.proc = undefined;
        this.health = null;
        this.scheduleRestart();
      });
      child.on("exit", (code, signal) => this.onExit(code, signal));
      this.log(
        `openviking: server started (pid ${child.pid ?? "?"}) on ${this.cfg.host}:${this.cfg.port}`,
      );
    } catch (err) {
      this.child = null;
      this.childPid = undefined;
      this.lastError = err instanceof Error ? err.message : String(err);
      this.log("openviking: spawn failed", err);
      this.scheduleRestart();
    }
  }

  /** Line-buffered stdout/stderr into the daemon log — one place to read when
   * something goes wrong, which is the whole point of supervising it here. */
  private foldLogs(child: SupervisedChild): void {
    foldChildLines(child, (line) => this.log(`openviking: ${line}`));
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    const upMs = this.startedAt !== null ? this.now().getTime() - this.startedAt : 0;
    this.child = null;
    this.childPid = undefined;
    this.startedAt = null;
    this.sampler.reset();
    this.proc = undefined;
    this.health = null;
    this.notReadyPolls = 0;
    this.lastExit = { code, signal, at: this.now().toISOString() };
    if (this.stopping) return;
    // A child that survived the reset window is not crash-looping: start the
    // ladder over, so an unrelated crash months later retries in a second.
    if (upMs >= this.cfg.restart_reset_after_s * 1000) this.attempt = 0;
    this.log(
      `openviking: server exited (code=${code ?? "null"} signal=${signal ?? "null"}) after ${Math.round(upMs / 1000)}s`,
    );
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.stopping) return;
    const delay = restartDelayMs(this.cfg.restart_backoff_ms, this.attempt);
    this.attempt += 1;
    this.restarts += 1;
    this.log(`openviking: restarting in ${delay}ms (attempt ${this.attempt})`);
    this.cancelRestart = this.schedule(() => this.spawnChild(), delay);
  }

  /** Self-rescheduling rather than an interval: two polls can never overlap,
   * so a hung probe cannot pile up requests against a struggling server. */
  private armHealthLoop(): void {
    if (this.stopping) return;
    this.cancelHealth = this.schedule(() => {
      void this.poll().finally(() => this.armHealthLoop());
    }, this.cfg.health_interval_s * 1000);
  }

  /** One health + resource sample into the cache. Never rejects. */
  async poll(): Promise<void> {
    const wasReady = this.health?.ready ?? false;
    const child = this.child;
    let health: OpenVikingHealth;
    try {
      health = await probeHealth({
        baseUrl: openVikingBaseUrl(this.cfg),
        timeoutMs: this.cfg.health_timeout_ms,
        ...(this.fetchFn ? { fetchFn: this.fetchFn } : {}),
        now: this.now,
      });
    } catch (err) {
      // probeHealth is total, but a caller-supplied fetch seam is not.
      health = {
        reachable: false,
        ready: false,
        error: err instanceof Error ? err.message : String(err),
        at: this.now().toISOString(),
      };
    }
    // A probe that raced an exit or a respawn describes a process that is no
    // longer the tracked one: the exit already cleared the cache, and the next
    // poll reads the new child. Installing it would report a dead server ready
    // and fire onReady for it.
    if (this.child !== child || this.stopping) return;
    this.health = health;
    // The server answered, so a spawn failure from before it came up is
    // history: the probe's own error (if any) is the current one.
    if (health.reachable) this.lastError = undefined;
    this.notReadyPolls = this.health.reachable && !this.health.ready ? this.notReadyPolls + 1 : 0;
    this.proc = this.childPid !== undefined ? this.sampler.sample(this.childPid) : undefined;
    if (this.health.ready && !wasReady) {
      try {
        this.onReady?.();
      } catch (err) {
        this.log("openviking: onReady callback threw", err);
      }
    }
  }

  /** The `openviking` block of status.json. Synchronous, cached, total. */
  status(): OpenVikingStatus {
    try {
      const base: OpenVikingStatus = {
        enabled: this.cfg.enabled && !this.unavailable,
        // A remote server has no child here: "running" is "answering".
        running: this.remote ? (this.health?.reachable ?? false) : this.child !== null,
        reachable: this.health?.reachable ?? false,
        ready: this.health?.ready ?? false,
        not_ready_polls: this.notReadyPolls,
        pinned_version: this.cfg.version,
        restarts: this.restarts,
      };
      const version = this.health?.version;
      return {
        ...base,
        ...(this.remote ? { endpoint: "remote" as const } : {}),
        ...(this.childPid !== undefined ? { pid: this.childPid } : {}),
        ...(version ? { version, version_drift: version !== this.cfg.version } : {}),
        ...(this.startedAt !== null ? { started_at: new Date(this.startedAt).toISOString() } : {}),
        ...(this.lastExit ? { last_exit: this.lastExit } : {}),
        ...((this.lastError ?? this.health?.error)
          ? { last_error: this.lastError ?? this.health?.error }
          : {}),
        ...(this.proc?.rss_bytes !== undefined ? { rss_bytes: this.proc.rss_bytes } : {}),
        ...(this.proc?.cpu_pct !== undefined ? { cpu_pct: this.proc.cpu_pct } : {}),
        ...(this.health ? { checked_at: this.health.at } : {}),
        ...(this.waitingSince !== null && this.startGate
          ? {
              waiting_for: `${this.startGate.what} (since ${new Date(this.waitingSince).toISOString()})`,
            }
          : {}),
      };
    } catch {
      return {
        enabled: false,
        running: false,
        reachable: false,
        ready: false,
        pinned_version: this.cfg.version,
        restarts: this.restarts,
      };
    }
  }

  /** SIGTERM, then SIGKILL after the grace window. Bounded, so daemon shutdown
   * can await it without risking a hang. */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.cancelRestart?.();
    this.cancelRestart = null;
    this.cancelHealth?.();
    this.cancelHealth = null;
    this.cancelGate?.();
    this.cancelGate = null;
    this.waitingSince = null;
    const child = this.child;
    if (!child) return;
    await terminateChild(child, this.schedule);
    this.child = null;
    this.childPid = undefined;
    this.log("openviking: server stopped");
  }
}

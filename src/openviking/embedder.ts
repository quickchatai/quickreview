// The local English embedder as a supervised child of the daemon.
//
// WHAT IT IS. `scripts/openviking-embedder.py` — an OpenAI-compatible
// `POST /v1/embeddings` on 127.0.0.1, run by the OpenViking venv's python over
// the pinned llama-cpp-python and the GGUF the image pins. ov.conf points the
// engine's OpenAI-compatible provider at it (`api_base` on loopback), which is
// the engine's async embedder: a search never runs a model on the server's
// one event loop. Nothing leaves the machine.
//
// WHY THE DAEMON SUPERVISES IT, and why apart from the server: the container
// keeps ONE supervised process tree (see supervisor.ts), and the two children
// fail differently — the server's `/ready` probes this service, so a dead
// embedder is a server that is up but not serving, never a server crash. The
// server's FIRST start waits for this one to answer (`gateOpen`), bounded: the
// gate orders a boot, it never holds memory hostage.
//
// ONLY WHEN IT IS THE EMBEDDER IN USE. The daemon starts it when config.toml
// says `local` AND the ov.conf the entrypoint rendered routes embeddings to
// this config's loopback URL. Anything else — a hosted opt-in, an ov.conf from
// an entrypoint that predates the local embedder (a `sync` without the
// `rebuild` the image needs) — is reported (`state: "off"`, with the reason) and nothing is
// spawned: a service nobody calls would only burn a CPU of the two. A file it
// needs that is missing is reported ONCE (`unavailable`), like the server's
// binary on a dev PC — it will not appear without a rebuild, so retrying is
// noise.
//
// The same three properties as the server's supervisor: start() never blocks,
// a crash respawns on the capped ladder forever, status() is synchronous,
// cached and total.
import { existsSync, readFileSync } from "node:fs";
import { spawn as nodeSpawn } from "node:child_process";
import { dirname, join } from "node:path";
import { LOCAL_EMBEDDING, localEmbedderBaseUrl, type OpenVikingConfig } from "../config.js";
import type { ServingAnswer } from "../memory/health.js";
import type { FetchLike } from "./health.js";
import { ProcSampler } from "./proc.js";
import type { Schedule, SpawnFn, SupervisedChild } from "./supervisor.js";
import type { LocalEmbedderStatus, OpenVikingStatus, ProcSample } from "./types.js";

/** What the service is started with. The boot's provisioning step builds the
 * same argv from the same seven values (`embedderArgv` in
 * scripts/openviking-provision.mjs) — tests/openviking-embedder.test.ts holds
 * the two spellings together. */
export interface LocalEmbedderSpec {
  python: string;
  script: string;
  model: string;
  file: string;
  sha256: string;
  port: number;
  threads: number;
}

export function localEmbedderSpec(cfg: OpenVikingConfig, repoRoot: string): LocalEmbedderSpec {
  return {
    // The OpenViking venv's interpreter: the one the image installed the
    // pinned llama-cpp-python into.
    python: join(dirname(cfg.bin), "python"),
    script: join(repoRoot, "scripts", "openviking-embedder.py"),
    model: LOCAL_EMBEDDING.model,
    file: cfg.local_embedder_file,
    sha256: cfg.local_embedder_sha256,
    port: cfg.local_embedder_port,
    threads: cfg.local_embedder_threads,
  };
}

/** The service's argv after the interpreter — loopback, always. */
export function localEmbedderArgv(spec: LocalEmbedderSpec): string[] {
  return [
    spec.script,
    "--model-path",
    spec.file,
    "--model-name",
    spec.model,
    "--sha256",
    spec.sha256,
    "--host",
    "127.0.0.1",
    "--port",
    String(spec.port),
    "--threads",
    String(spec.threads),
  ];
}

/**
 * Does the rendered ov.conf route embeddings to THIS config's local
 * embedder? `null` when it does, else why not — said in the heartbeat, because
 * "the daemon did not start it" must always come with a reason.
 */
export function localEmbedderOffReason(
  cfg: OpenVikingConfig,
  ovConfText: string | null,
): string | null {
  if (cfg.embedding_provider !== "local")
    return `config.toml embeds through the hosted '${cfg.embedding_provider}' provider`;
  if (ovConfText === null) return `${cfg.config_file} could not be read`;
  let dense: { provider?: unknown; api_base?: unknown } | undefined;
  try {
    dense = (JSON.parse(ovConfText) as { embedding?: { dense?: typeof dense } })?.embedding?.dense;
  } catch {
    return `${cfg.config_file} is not JSON`;
  }
  const want = localEmbedderBaseUrl(cfg);
  const apiBase = typeof dense?.api_base === "string" ? dense.api_base.replace(/\/+$/, "") : "";
  if (apiBase === want) return null;
  const said =
    apiBase !== ""
      ? `api_base ${apiBase}`
      : `provider '${typeof dense?.provider === "string" ? dense.provider : "(none)"}'`;
  const head = `ov.conf does not route embeddings to ${want} (it says ${said})`;
  // Three different faults, three different fixes — never one guess for all.
  if (apiBase === "")
    return (
      `${head} — rendered by an entrypoint that predates the local English embedder? ` +
      "It ships with the image: scripts/deploy.sh rebuild"
    );
  if (/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(apiBase))
    return (
      `${head} — config.toml [openviking] local_embedder_port and the port the boot rendered disagree, ` +
      `and nothing serves ${apiBase}: memory search fails until they agree (ansible: group_vars ` +
      "openviking_local_embedder_port; compose: the project .env's QCR_OPENVIKING_LOCAL_EMBEDDER_PORT, " +
      "which the onboarding bring-up mirrors from config.toml)"
    );
  return (
    `${head} — config.toml says local, but the boot rendered another embedder ` +
    "(the re-embed driver reports this drift as openviking.reembed.config_drift)"
  );
}

/**
 * Does memory SERVE — search, and vectorizing what is written? The answer
 * memory health folds in beside its authenticated probe, which is an `fs/ls`,
 * needs no embedding, and so keeps answering while a dead embedder fails every
 * search. Pure, from the two supervisors' cached statuses:
 *
 *   - under `local`, an embedder the daemon cannot run (`unavailable`), or
 *     runs but that does not answer, is NOT serving whatever the server last
 *     said — it is the server's only embedder;
 *   - a server that answers `/health` but fails `/ready` — which runs an
 *     embedding probe: a hosted embedder that refuses, an ov.conf routed to a
 *     port nothing serves — is NOT serving;
 *   - a server that does not answer at all is UNKNOWN here (`ok: null`): the
 *     authenticated probe fails too, and judges it;
 *   - anything else serves.
 */
export function memoryServing(
  provider: string,
  server: OpenVikingStatus | undefined,
  embedder: LocalEmbedderStatus | undefined,
): ServingAnswer {
  if (provider === "local" && embedder) {
    if (embedder.state === "unavailable")
      return {
        ok: false,
        reason: `the local embedder is unavailable — ${embedder.reason ?? "a file it needs is missing"}`,
      };
    if (embedder.state === "supervised" && !embedder.ready) {
      const exit = embedder.last_exit
        ? ` (last exit code=${embedder.last_exit.code ?? "null"} signal=${embedder.last_exit.signal ?? "null"} at ${embedder.last_exit.at})`
        : "";
      const why = !embedder.running
        ? `not running${exit}, ${embedder.restarts} restart(s)`
        : embedder.checked_at === undefined
          ? "starting (it has not answered /health yet)"
          : `running but not answering /health${embedder.last_error ? ` (${embedder.last_error})` : ""}${exit}`;
      return { ok: false, reason: `the local embedder on 127.0.0.1:${embedder.port} is ${why}` };
    }
  }
  if (!server || !server.running || !server.reachable) return { ok: null };
  // One failed `/ready` poll is no verdict: the probe runs an embedding on the
  // one-thread local embedder, which a case batch may hold for a few seconds,
  // and a single slow probe must not flip memory health to degraded and pause
  // every pump until the next poll. Unknown
  // keeps the not-serving clock where it stands; the second in a row decides.
  if (!server.ready && server.not_ready_polls === 1) return { ok: null };
  if (!server.ready) {
    const off =
      provider === "local" && embedder?.state === "off" && embedder.reason
        ? `; the local embedder is off — ${embedder.reason}`
        : "";
    return {
      ok: false,
      reason: `the server answers but its /ready fails (${server.last_error ?? "not ready"}) — /ready runs an embedding probe${off}`,
    };
  }
  return { ok: true };
}

/** How often a not-yet-ready child is probed — the gate waits on this. */
export const EMBEDDER_FAST_POLL_MS = 500;
/** How long the server's first start waits for the embedder before starting
 * anyway (the model loads in about a second; the sha256 check in a fraction). */
export const EMBEDDER_GATE_MAX_WAIT_MS = 120_000;
const STOP_GRACE_MS = 5_000;

export interface LocalEmbedderDeps {
  cfg: OpenVikingConfig;
  /** The checkout root — where `scripts/openviking-embedder.py` lives. */
  repoRoot: string;
  log: (msg: string, extra?: unknown) => void;
  spawn?: SpawnFn;
  fetchFn?: FetchLike;
  now?: () => Date;
  exists?: (path: string) => boolean;
  /** ov.conf's text, or null when it cannot be read (test seam). */
  readOvConf?: () => string | null;
  sampler?: ProcSampler;
  schedule?: Schedule;
}

const defaultSchedule: Schedule = (fn, ms) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return () => clearTimeout(t);
};

export class LocalEmbedderSupervisor {
  private readonly cfg: OpenVikingConfig;
  private readonly spec: LocalEmbedderSpec;
  private readonly log: (msg: string, extra?: unknown) => void;
  private readonly spawnFn: SpawnFn;
  private readonly fetchFn: FetchLike;
  private readonly now: () => Date;
  private readonly exists: (path: string) => boolean;
  private readonly readOvConf: () => string | null;
  private readonly sampler: ProcSampler;
  private readonly schedule: Schedule;

  private state: LocalEmbedderStatus["state"] = "off";
  private reason: string | undefined = "not started";
  private started = false;
  private stopping = false;
  private child: SupervisedChild | null = null;
  private childPid: number | undefined;
  private startedAt: number | null = null;
  private attempt = 0;
  private restarts = 0;
  private ready = false;
  private everReady = false;
  private checkedAt: string | undefined;
  private lastExit: LocalEmbedderStatus["last_exit"];
  private lastError: string | undefined;
  private proc: ProcSample | undefined;
  private cancelRestart: (() => void) | null = null;
  private cancelHealth: (() => void) | null = null;

  constructor(deps: LocalEmbedderDeps) {
    this.cfg = deps.cfg;
    this.spec = localEmbedderSpec(deps.cfg, deps.repoRoot);
    this.log = deps.log;
    this.spawnFn = deps.spawn ?? ((cmd, args, opts) => nodeSpawn(cmd, args, opts));
    this.fetchFn = deps.fetchFn ?? ((url, init) => fetch(url, init));
    this.now = deps.now ?? (() => new Date());
    this.exists = deps.exists ?? existsSync;
    this.readOvConf =
      deps.readOvConf ??
      (() => {
        try {
          return readFileSync(deps.cfg.config_file, "utf8");
        } catch {
          return null;
        }
      });
    this.sampler = deps.sampler ?? new ProcSampler();
    this.schedule = deps.schedule ?? defaultSchedule;
  }

  /** Decide, then spawn and arm the probe. Synchronous and non-blocking. */
  start(): void {
    if (this.started) return;
    this.started = true;
    if (!this.cfg.enabled) {
      this.reason = "memory is disabled in config.toml";
      return;
    }
    const off = localEmbedderOffReason(this.cfg, this.readOvConf());
    if (off !== null) {
      this.reason = off;
      if (this.cfg.embedding_provider === "local")
        this.log(`openviking: local embedder NOT started — ${off}`);
      return;
    }
    for (const [what, path] of [
      ["interpreter", this.spec.python],
      ["service script", this.spec.script],
      ["model file", this.spec.file],
    ] as const) {
      if (!this.exists(path)) {
        this.state = "unavailable";
        this.reason =
          `${what} not found: ${path}` +
          (what === "model file"
            ? " — the image carries it; this one predates it (scripts/deploy.sh rebuild)"
            : "");
        this.log(
          `openviking: local embedder unavailable — ${this.reason} (memory search degrades)`,
        );
        return;
      }
    }
    this.state = "supervised";
    this.reason = undefined;
    this.spawnChild();
  }

  /** The server's start gate: open once this embedder serves — or when it
   * never will (off, unavailable, stopping). */
  gateOpen(): boolean {
    return this.state !== "supervised" || this.stopping || this.ready;
  }

  /** The last probe answered 200 from a live child. */
  isReady(): boolean {
    return this.state === "supervised" && this.child !== null && this.ready;
  }

  private spawnChild(): void {
    if (this.stopping) return;
    this.cancelRestart = null;
    this.ready = false;
    this.everReady = false;
    try {
      const child = this.spawnFn(this.spec.python, localEmbedderArgv(this.spec), {
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.child = child;
      this.childPid = child.pid;
      this.startedAt = this.now().getTime();
      this.sampler.reset();
      this.foldLogs(child);
      child.on("error", (err) => {
        this.lastError = err.message;
        this.log("openviking: local embedder spawn error", err);
        // A failed spawn emits `error` (never `exit`) and has no pid.
        if (this.child !== child || child.pid !== undefined) return;
        this.clearChild();
        this.scheduleRestart();
      });
      child.on("exit", (code, signal) => this.onExit(child, code, signal));
      this.log(
        `openviking: local embedder started (pid ${child.pid ?? "?"}) — ${this.spec.model} on 127.0.0.1:${this.spec.port}`,
      );
      this.armProbe(EMBEDDER_FAST_POLL_MS);
    } catch (err) {
      this.clearChild();
      this.lastError = err instanceof Error ? err.message : String(err);
      this.log("openviking: local embedder spawn failed", err);
      this.scheduleRestart();
    }
  }

  private clearChild(): void {
    this.child = null;
    this.childPid = undefined;
    this.startedAt = null;
    this.ready = false;
    this.proc = undefined;
    this.sampler.reset();
  }

  /** Its stdout/stderr, line by line, into the daemon log — the service's own
   * lines already carry the `openviking-embedder:` prefix. */
  private foldLogs(child: SupervisedChild): void {
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue;
      let buffer = "";
      stream.on("data", (chunk: unknown) => {
        buffer += String(chunk);
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) if (line.trim()) this.log(line.trimEnd());
      });
    }
  }

  private onExit(child: SupervisedChild, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child !== child) return;
    const upMs = this.startedAt !== null ? this.now().getTime() - this.startedAt : 0;
    this.clearChild();
    this.cancelHealth?.();
    this.cancelHealth = null;
    this.lastExit = { code, signal, at: this.now().toISOString() };
    if (this.stopping) return;
    if (upMs >= this.cfg.restart_reset_after_s * 1000) this.attempt = 0;
    this.log(
      `openviking: local embedder exited (code=${code ?? "null"} signal=${signal ?? "null"}) after ${Math.round(upMs / 1000)}s`,
    );
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.stopping) return;
    const ladder = this.cfg.restart_backoff_ms.length > 0 ? this.cfg.restart_backoff_ms : [5000];
    const delay = ladder[Math.min(this.attempt, ladder.length - 1)]!;
    this.attempt += 1;
    this.restarts += 1;
    this.log(`openviking: local embedder restarting in ${delay}ms (attempt ${this.attempt})`);
    this.cancelRestart = this.schedule(() => this.spawnChild(), delay);
  }

  /** Self-rescheduling: fast until the child first serves, then at the
   * server's health cadence. Two probes never overlap. A probe re-arms only
   * for the child it probed: a replacement arms its own at spawn. */
  private armProbe(ms: number): void {
    if (this.stopping) return;
    this.cancelHealth?.();
    this.cancelHealth = this.schedule(() => {
      this.cancelHealth = null;
      const probed = this.child;
      void this.probe().finally(() => {
        if (this.child === null || this.child !== probed) return;
        this.armProbe(this.everReady ? this.cfg.health_interval_s * 1000 : EMBEDDER_FAST_POLL_MS);
      });
    }, ms);
  }

  /** One `/health` probe into the cache. Never rejects. An answer that lands
   * after the child it probed was replaced says nothing about the new one
   * and is dropped — the same identity rule `onExit` keeps. */
  async probe(): Promise<void> {
    const probed = this.child;
    const at = this.now().toISOString();
    let ok = false;
    let error: string | undefined;
    try {
      const res = await this.fetchFn(`http://127.0.0.1:${this.spec.port}/health`, {
        signal: AbortSignal.timeout(this.cfg.health_timeout_ms),
      });
      ok = res.ok;
      if (!ok) error = `health ${res.status}`;
    } catch (err) {
      ok = false;
      error = err instanceof Error ? err.message : String(err);
    }
    if (this.child !== probed) return;
    if (error !== undefined) this.lastError = error;
    this.checkedAt = at;
    const was = this.ready;
    this.ready = ok && this.child !== null;
    if (this.ready) {
      this.lastError = undefined;
      if (!this.everReady) this.everReady = true;
      if (!was)
        this.log(
          `openviking: local embedder ready — ${this.spec.model} serving on 127.0.0.1:${this.spec.port}`,
        );
    } else if (was && this.child !== null) {
      this.log(`openviking: local embedder stopped answering (${this.lastError ?? "no answer"})`);
    }
    this.proc = this.childPid !== undefined ? this.sampler.sample(this.childPid) : undefined;
  }

  /** The `embedder` block inside the heartbeat's `openviking` entry. */
  status(): LocalEmbedderStatus {
    try {
      return {
        state: this.state,
        ...(this.reason ? { reason: this.reason } : {}),
        model: this.spec.model,
        port: this.spec.port,
        threads: this.spec.threads,
        running: this.child !== null,
        ready: this.isReady(),
        restarts: this.restarts,
        ...(this.childPid !== undefined ? { pid: this.childPid } : {}),
        ...(this.startedAt !== null ? { started_at: new Date(this.startedAt).toISOString() } : {}),
        ...(this.lastExit ? { last_exit: this.lastExit } : {}),
        ...(this.lastError ? { last_error: this.lastError } : {}),
        ...(this.checkedAt ? { checked_at: this.checkedAt } : {}),
        ...(this.proc?.rss_bytes !== undefined ? { rss_bytes: this.proc.rss_bytes } : {}),
        ...(this.proc?.cpu_pct !== undefined ? { cpu_pct: this.proc.cpu_pct } : {}),
      };
    } catch {
      return {
        state: this.state,
        model: LOCAL_EMBEDDING.model,
        port: this.cfg.local_embedder_port,
        threads: this.cfg.local_embedder_threads,
        running: false,
        ready: false,
        restarts: this.restarts,
      };
    }
  }

  /** SIGTERM, then SIGKILL after the grace window. Bounded. */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.cancelRestart?.();
    this.cancelRestart = null;
    this.cancelHealth?.();
    this.cancelHealth = null;
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const cancelKill = this.schedule(() => {
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
    this.clearChild();
    this.log("openviking: local embedder stopped");
  }
}

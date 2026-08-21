// The memory forward, owned by the TUI process.
//
// WHAT CHANGED AND WHY. built the forward as a host-owned systemd
// --user service and said, in as many words, that it was "deliberately NOT
// part of the TUI: `qcr tui` starting and stopping is not an event memory
// should notice". That reasoning stands for the COMPANION — but it made the
// TUI's own Memory & learning tab depend on a unit the operator had to install
// first, and an uninstalled unit renders as MEMORY UNREACHABLE, which reads
// like a broken server rather than a missing local service. the owner asked for
// the forward to run inside the TUI (2026-08-21). This module is that, without
// giving up the property was protecting:
//
//   * If a forward is ALREADY listening — the systemd unit, or another TUI —
//     we ADOPT it. We never bind over it, never restart it, never stop it on
//     exit. The unit stays the better setup and keeps winning where installed.
//   * Only when nothing answers do we bind ourselves, and then we close
//     exactly what we opened.
//
// So the unit is now an OPTIONAL upgrade (memory that outlives the TUI) rather
// than a prerequisite, and the two can be installed in either order.
//
// ONE IMPLEMENTATION, NOT A SECOND ONE. The relay itself is not reimplemented
// here: `scripts/companion-memory-forward.mjs` stays the only place that knows
// how to reach the VM, and this module imports `createForwarder`/`parseArgs`
// out of it at runtime. The import is DYNAMIC and by file URL on purpose — the
// script is dependency-free, build-free ESM (systemd must run it from a bare
// checkout at boot) and lives outside `tsconfig`'s `include`, so a static
// import would either drag it into the build or fork the logic. Config comes
// from that script's own `parseArgs`, so both entrypoints honour the same
// flags and `QCR_*` env vars and cannot drift.
//
// NOTHING HERE HOLDS A VM CREDENTIAL, and nothing here changes that: the ssh
// runs on the owner's PC as him, exactly as the unit runs it (root CLAUDE.md
// rule 8). The forward carries bytes; the KEYS stay in the keys file that
// `src/tui/memory.ts` reads.
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/** What `createForwarder` hands back — the half of it this module uses. */
export interface ForwarderHandle {
  listen(): Promise<number>;
  close(): void;
}

/** The slice of `scripts/companion-memory-forward.mjs` we depend on. Declared
 * structurally because the script is untyped JS: this interface IS the
 * contract, and `tests/tui-memforward.test.ts` checks the real module still
 * satisfies it. */
export interface ForwardModule {
  parseArgs(argv: string[], env: NodeJS.ProcessEnv): { cfg: ForwardConfig };
  createForwarder(cfg: ForwardConfig, opts?: { log?: (line: string) => void }): ForwarderHandle;
}

export interface ForwardConfig {
  binds: string[];
  port: number;
  sshHost: string;
  container: string;
  [k: string]: unknown;
}

/**
 * Where the forward stands, as the tab paints it.
 *
 * `adopted` and `owned` are BOTH working states and the tab must not dress
 * them up as different degrees of health — the distinction exists so the
 * operator knows what happens when the TUI quits, nothing more.
 */
export type ForwardState =
  /** Something was already listening; we use it and will not stop it. */
  | "adopted"
  /** We bound it; it closes when the TUI quits. */
  | "owned"
  /** Nothing was listening and we could not bind — memory is unreachable. */
  | "failed"
  /** Not started (never called, or explicitly disabled). */
  | "off";

export interface ForwardStatus {
  state: ForwardState;
  /** One line, operator-facing: why it is in this state / what to do. */
  detail: string;
  /** The OpenViking base URL the TUI's store talks to. */
  baseUrl: string;
  /** The server's own web UI — what the memory tab links to. */
  studioUrl: string;
}

/** OpenViking's bundled web UI. Verified live against 0.4.15 (HTTP 200). */
export const STUDIO_PATH = "/studio";

export function studioUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${STUDIO_PATH}`;
}

export interface MemForwardDeps {
  /** Where the TUI's memory store points (`tuiMemoryBaseUrl`). */
  baseUrl: string;
  /** Repo root holding `scripts/` — `qcr` runs from anywhere. */
  repoRoot: string;
  env?: NodeJS.ProcessEnv;
  /** Is a forward already up? Default: GET `${baseUrl}/health`. */
  probe?: (baseUrl: string, timeoutMs: number) => Promise<boolean>;
  /** Loads the forward script. Injected so tests never spawn ssh. */
  load?: () => Promise<ForwardModule>;
  log?: (line: string) => void;
  /** Probe deadline. Short: this runs on the TUI's startup path. */
  probeTimeoutMs?: number;
}

const DEFAULT_PROBE_TIMEOUT_MS = 1_500;

/** Default probe: a 2xx from `/health` that does not say `healthy: false`.
 * Anything else — refused, slow, some other program on the port — is "no
 * forward", and we try to bind (and then fail loudly if the port is taken by
 * something that is not a forward, which is the honest outcome). */
async function httpProbe(baseUrl: string, timeoutMs: number): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    const body = (await res.json()) as { healthy?: unknown };
    return body.healthy !== false;
  } catch {
    return false;
  }
}

/**
 * Starts, adopts, reports and stops the memory forward for one TUI process.
 *
 * Every method is total: this sits on the TUI's startup path and a forward
 * that cannot start must cost the operator a red status line, never the TUI.
 */
export class MemoryForward {
  private readonly deps: Required<Omit<MemForwardDeps, "env">> & { env: NodeJS.ProcessEnv };
  private handle: ForwarderHandle | null = null;
  private status: ForwardStatus;

  constructor(deps: MemForwardDeps) {
    const repoRoot = deps.repoRoot;
    this.deps = {
      baseUrl: deps.baseUrl,
      repoRoot,
      env: deps.env ?? process.env,
      probe: deps.probe ?? httpProbe,
      load: deps.load ?? (() => import(pathToFileURL(join(repoRoot, "scripts", "companion-memory-forward.mjs")).href) as Promise<ForwardModule>),
      log: deps.log ?? (() => {}),
      probeTimeoutMs: deps.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    };
    this.status = {
      state: "off",
      detail: "not started",
      baseUrl: deps.baseUrl,
      studioUrl: studioUrl(deps.baseUrl),
    };
  }

  view(): ForwardStatus {
    return { ...this.status };
  }

  /** True once the forward is usable — adopted or owned. */
  get up(): boolean {
    return this.status.state === "adopted" || this.status.state === "owned";
  }

  /**
   * Bring the forward up if it is not already. Idempotent: calling it while we
   * own a forward re-probes rather than binding a second time, so the memory
   * tab's refresh key can drive it.
   *
   * Calls are SERIALISED through one in-flight promise. Two callers reach here
   * — the TUI's eager start at boot and the tab's refresh — and both begin
   * with an async probe, so without this the second would probe while the
   * first was still binding, see nothing listening, and bind a second time.
   */
  ensure(): Promise<ForwardStatus> {
    this.inFlight = (this.inFlight ?? Promise.resolve()).then(() => this.ensureOnce());
    return this.inFlight;
  }

  private inFlight: Promise<ForwardStatus> | null = null;

  private async ensureOnce(): Promise<ForwardStatus> {
    if (this.handle) {
      // We bound it; confirm it still answers rather than trusting the socket.
      const alive = await this.deps.probe(this.deps.baseUrl, this.deps.probeTimeoutMs);
      return this.settle(alive ? "owned" : "failed", alive ? this.ownedDetail() : "the forward we started stopped answering — r retries");
    }
    if (await this.deps.probe(this.deps.baseUrl, this.deps.probeTimeoutMs)) {
      // Somebody else's — the systemd unit, or another qcr tui. Hands off: it
      // outlives us, which is the better arrangement, and stopping it on our
      // exit would take memory away from a companion we did not start.
      return this.settle("adopted", "already running (systemd unit or another qcr tui) — left alone on quit");
    }
    return this.start();
  }

  private async start(): Promise<ForwardStatus> {
    let mod: ForwardModule;
    try {
      mod = await this.deps.load();
    } catch (err) {
      return this.settle("failed", `cannot load the forward script: ${errText(err)}`);
    }
    let bound = 0;
    try {
      const { cfg } = mod.parseArgs(["run"], this.deps.env);
      const handle = mod.createForwarder(cfg, { log: (line) => this.deps.log(`memory-forward: ${line}`) });
      bound = await handle.listen();
      if (bound === 0) {
        // Every bind failed. Closing is still right: `listen` may hold servers
        // that never got an address, and leaking them across a retry is worse
        // than a no-op close.
        handle.close();
        return this.settle("failed", `could not bind ${cfg.binds.join(", ")}:${cfg.port} — is something else on the port?`);
      }
      this.handle = handle;
      return this.settle("owned", this.ownedDetail(bound, cfg.binds.length));
    } catch (err) {
      return this.settle("failed", `forward failed to start: ${errText(err)}`);
    }
  }

  /** A partial bind is a WORKING state, not a failure: loopback alone serves
   * the TUI, and the docker-bridge bind only matters when the companion
   * container is up. Say which, rather than reporting a bare "ok". */
  private ownedDetail(bound?: number, wanted?: number): string {
    const base = "started by this TUI — closes on quit";
    if (bound === undefined || wanted === undefined || bound >= wanted) return base;
    return `${base} (bound ${bound}/${wanted} addresses — the companion bridge is down, the TUI is fine)`;
  }

  private settle(state: ForwardState, detail: string): ForwardStatus {
    this.status = { state, detail, baseUrl: this.deps.baseUrl, studioUrl: studioUrl(this.deps.baseUrl) };
    this.deps.log(`memory-forward: ${state} — ${detail}`);
    return this.view();
  }

  /**
   * Close ONLY a forward we started. An adopted one belongs to systemd or to
   * another TUI; stopping it here would be this module reaching outside its
   * own lifetime, and would strand a companion container we never launched.
   */
  stop(): void {
    if (!this.handle) return;
    try {
      this.handle.close();
    } catch {
      /* already gone — the process is exiting anyway */
    }
    this.handle = null;
    this.status = { ...this.status, state: "off", detail: "stopped with the TUI" };
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

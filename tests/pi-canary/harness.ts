// The offline pi canary rig . Every canary drives the REAL pi SDK
// (@earendil-works/pi-coding-agent at the pinned version) against pi-ai's faux
// provider, so a pi bump that breaks a behaviour we depend on fails here before
// it reaches a route, and nothing costs money.
//
// "Offline" is asserted, not assumed: useOfflineGuard() replaces fetch and the
// TCP connect of net.Socket for the duration of a file and fails the file's
// last test if anything tried to reach out. The rig itself touches only a
// private temp dir (agentDir, auth, models and session files all explicit), so
// a canary never reads the developer's ~/.pi either.
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect } from "vitest";
import {
  type FauxProviderHandle,
  type Model,
  fauxProvider,
  registerSessionResourceCleanup,
} from "@earendil-works/pi-ai";
import { type PiHostOptions, PiHost } from "@quickchatai/pi-quickreview/src/engine/pisdk.js";
import {
  type AgentSession,
  type CreateAgentSessionOptions,
  type ExtensionFactory,
  type ExtensionError,
  type ToolDefinition,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";

// pi's own switches for "do nothing over the network": no catalog refresh, no
// install/update telemetry. Set before any pi module reads them.
process.env.PI_OFFLINE = "1";
process.env.PI_TELEMETRY = "0";

/** Every network attempt seen while a guard is installed ("fetch <url>", "connect <host>:<port>"). */
export interface NetworkLog {
  attempts: string[];
}

export interface OfflineGuardOptions {
  /** Let TCP connects to this machine's loopback through (a canary that serves
   * its own fixture, such as the dispatcher's timeout one). Everything else is
   * still an attempt. */
  loopback?: boolean;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

/** Install the guard; the returned function removes it and hands back the log. */
export function installOfflineGuard(guardOptions: OfflineGuardOptions = {}): {
  log: NetworkLog;
  restore: () => NetworkLog;
} {
  const log: NetworkLog = { attempts: [] };
  const realFetch = globalThis.fetch;
  const realConnect = net.Socket.prototype.connect;
  globalThis.fetch = ((input: unknown, init?: unknown) => {
    const url =
      typeof input === "string" ? input : String((input as { url?: string })?.url ?? input);
    if (guardOptions.loopback && LOOPBACK.has(new URL(url).hostname.replace(/^\[|\]$/g, "")))
      return (realFetch as (...a: unknown[]) => Promise<Response>)(input, init);
    log.attempts.push(`fetch ${url}`);
    return Promise.reject(new Error(`offline canary: fetch ${url}`));
  }) as typeof fetch;
  // Every TCP/TLS client (undici, ws, http) ends in Socket.connect; unix-socket
  // connects (a path, no port) stay legal.
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]): net.Socket {
    // net.connect() hands over its arguments already normalised: [options, cb].
    const first = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
    const opts =
      first && typeof first === "object"
        ? (first as { host?: string; port?: number; path?: string })
        : undefined;
    const unix = typeof first === "string" ? isNaN(Number(first)) : opts?.path !== undefined;
    if (!unix) {
      const host = opts
        ? (opts.host ?? "localhost")
        : typeof args[1] === "string"
          ? args[1]
          : "localhost";
      if (guardOptions.loopback && LOOPBACK.has(host))
        return (realConnect as (...a: unknown[]) => net.Socket).apply(this, args);
      const target = `${host}:${opts ? opts.port : String(first)}`;
      log.attempts.push(`connect ${target}`);
      throw new Error(`offline canary: connect ${target}`);
    }
    return (realConnect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;
  return {
    log,
    restore: () => {
      globalThis.fetch = realFetch;
      net.Socket.prototype.connect = realConnect;
      return log;
    },
  };
}

/**
 * Guard a whole test file: installed before the first test, and an extra
 * assertion after the last one (inside afterAll, so a late attempt fails the
 * file rather than passing silently).
 */
export function useOfflineGuard(guardOptions: OfflineGuardOptions = {}): void {
  let guard: ReturnType<typeof installOfflineGuard> | undefined;
  beforeAll(() => {
    guard = installOfflineGuard(guardOptions);
  });
  afterAll(() => {
    const log = guard?.restore();
    expect(log?.attempts, "a canary must make no network attempt").toEqual([]);
  });
}

export interface OpenOptions {
  /** Default: a fresh in-memory manager with a unique id. */
  sessionManager?: SessionManager;
  extensionFactories?: ExtensionFactory[];
  /** Built-in tool allowlist. Default: none. */
  tools?: string[];
  customTools?: ToolDefinition[];
  thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];
  /** Compaction settings; auto-compaction is always off so a canary compacts on purpose. */
  keepRecentTokens?: number;
  /** Called for every extension error pi reports instead of throwing. */
  onExtensionError?: (error: ExtensionError) => void;
}

/** One faux provider, one ModelRuntime and one private agentDir. */
export interface Rig {
  dir: string;
  faux: FauxProviderHandle;
  model: Model<string>;
  runtime: ModelRuntime;
  /** Sessions opened through this rig, disposed by close(). */
  sessions: AgentSession[];
  open(options?: OpenOptions): Promise<AgentSession>;
  close(): void;
}

export async function createRig(): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), "pi-canary-"));
  const faux = fauxProvider();
  const runtime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: join(dir, "models.json"),
    modelsStorePath: join(dir, "models-store.json"),
    refreshOnCreate: false,
  });
  runtime.registerNativeProvider(faux.provider);
  const model = faux.getModel();
  const sessions: AgentSession[] = [];
  return {
    dir,
    faux,
    model,
    runtime,
    sessions,
    async open(options = {}) {
      const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: false, keepRecentTokens: options.keepRecentTokens ?? 20_000 },
        retry: { enabled: false },
      });
      const resourceLoader = new DefaultResourceLoader({
        cwd: dir,
        agentDir: dir,
        settingsManager,
        extensionFactories: options.extensionFactories ?? [],
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      });
      await resourceLoader.reload();
      const { session } = await createAgentSession({
        cwd: dir,
        agentDir: dir,
        model,
        thinkingLevel: options.thinkingLevel ?? "off",
        modelRuntime: runtime,
        resourceLoader,
        sessionManager: options.sessionManager ?? SessionManager.inMemory(dir),
        settingsManager,
        tools: options.tools ?? [],
        customTools: options.customTools,
      });
      await session.bindExtensions({ onError: options.onExtensionError });
      sessions.push(session);
      return session;
    },
    close() {
      for (const s of sessions) {
        try {
          s.dispose();
        } catch {
          /* a canary that disposed it already */
        }
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * A stand-in for the per-session transport a real provider holds (the codex
 * websocket cache is keyed by session id exactly like this). A faux response
 * factory opens one "socket" per request, keyed by the request's session id;
 * pi's session-resource cleanup closes every socket under the id it is given.
 */
export class FakeTransport {
  readonly sockets: { sessionId: string; closed: boolean }[] = [];
  readonly cleanups: string[] = [];
  private unregister: (() => void) | undefined;

  attach(): void {
    this.unregister = registerSessionResourceCleanup((sessionId) => {
      if (!sessionId) return;
      this.cleanups.push(sessionId);
      for (const s of this.sockets) if (s.sessionId === sessionId) s.closed = true;
    });
  }

  detach(): void {
    this.unregister?.();
  }

  open(sessionId: string | undefined): void {
    if (sessionId) this.sockets.push({ sessionId, closed: false });
  }

  isOpen(sessionId: string): boolean {
    return this.sockets.some((s) => s.sessionId === sessionId && !s.closed);
  }
}

/** Resolves when `pred` holds, polling to a deadline (never a fixed sleep). */
export async function waitFor(pred: () => boolean, ms = 4000, what = "condition"): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A PiHost on the faux provider, with a private agentDir, as a route builds one. */
export interface HostRig {
  dir: string;
  faux: FauxProviderHandle;
  host: PiHost;
  close(): void;
}

export async function createHostRig(options: Partial<PiHostOptions> = {}): Promise<HostRig> {
  const dir = mkdtempSync(join(tmpdir(), "pi-host-"));
  const faux = fauxProvider();
  const host = await PiHost.create({
    agentDir: join(dir, "agent"),
    settings: { compaction: { enabled: false }, retry: { enabled: false } },
    ...options,
    configureModels: async (runtime) => {
      runtime.registerNativeProvider(faux.provider);
      await options.configureModels?.(runtime);
    },
  });
  return {
    dir,
    faux,
    host,
    close() {
      host.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

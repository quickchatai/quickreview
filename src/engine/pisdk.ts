// The isolated SDK session builder: PiHost, and the ONLY module that imports the
// pi SDK at runtime (the extension factories are the other, tests/fences-engine
// pins both). An engine route that needs a pi session, the lens runner
// included, gets it from PiHost.makeSession and never touches the SDK itself.
//
// "Isolated" means the host reads and writes nothing it was not handed:
//
//   - Every path pi would default to ~/.pi/agent is explicit: one private
//     agentDir, and authPath / modelsPath / modelsStorePath inside it (the
//     defaults are model-runtime.js:81, models-store.js:30 and
//     settings-manager.js:223). PiHost refuses a relative or missing agentDir,
//     so a forgotten path cannot fall through to the operator's home.
//   - The ResourceLoader discovers nothing. No extension, skill, prompt
//     template or theme is read from HOME, the agentDir, the cwd's .pi/ or
//     .agents/ (the reviewed repo is untrusted input), or any ancestor. The
//     only things a session sees are what the spec hands it: extension
//     factories, the system prompt, and the context files (D34: the reviewer
//     stub, as data, never written into a checkout).
//   - The model's bash gets an environment built from an allowlist over the
//     spec's env, with the GitHub token names always stripped (envstrip.ts).
//   - The tool list is an allowlist of exact names. A tool an extension
//     registers that is not on it is dropped.
//   - The model's tools do not reach what holds the run's secrets (D32). Its
//     bash runs as the separate tool uid when the host is given one
//     (`toolUid`, from the image's QCR_TOOL_UID), which the kernel keeps out of
//     /proc/<pid>/mem and environ of this process. Its file tools (read, grep,
//     find, ls, edit, write) run in this process, so each path they are handed
//     goes through a fence (toolfence.ts) that refuses /proc, /run/qcr-in and
//     the agent dirs and the login's source, after resolving symlinks.
//
// The HTTP dispatcher follows D4. pi's CLI installs an undici dispatcher at
// startup (configureHttpDispatcher, which the package does not export); an
// SDK host needs the same one, since provider requests and our own GitHub
// fetches go through it. PiHost deep-imports pi's own function so the settings
// match exactly, and installs it only when the route says it owns the process.
// Inside a CLI pi (the debug round, the companion) the dispatcher is pi's, and
// PiHost leaves it alone. Canary 6 pins the function and its settings.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync } from "node:fs";
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type CreateAgentSessionOptions,
  type CreateModelRuntimeOptions,
  type ExtensionError,
  type ExtensionFactory,
  type ToolDefinition,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  createBashToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createEditToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { GITHUB_TOKEN_ENVS } from "../envstrip.js";
import type { AgentsFile } from "./port.js";
import {
  FENCED_TOOLS,
  createToolFence,
  fencedOperations,
  guardedTool,
  loginSourceDirs,
  type ImageSniffer,
  type ToolFence,
} from "./toolfence.js";
import { inheritingBashOperations, isolatedBashOperations, type ToolIds } from "./tooluid.js";

// ---- the HTTP dispatcher (D4) -------------------------------------------------

const PI_PACKAGE = "@earendil-works/pi-coding-agent";
/** Where undici keeps the process-global dispatcher: both Node's bundled fetch
 * and the npm undici pi installs read this one symbol. */
export const UNDICI_GLOBAL_DISPATCHER = Symbol.for("undici.globalDispatcher.1");
/** Set on globalThis to the dispatcher PiHost itself installed. */
const INSTALLED_BY_PIHOST = Symbol.for("qcr.pisdk.dispatcher");
/** The idle timeout the production routes run pi with (bench/aacr/Dockerfile's
 * project settings). pi's own default is five minutes. */
export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 120_000;

/** What PiHost found, or did, about the process-global HTTP dispatcher.
 *  - installed: pi's dispatcher, installed by a PiHost of this process.
 *  - reused: someone else's (a CLI pi's) is in place and was left there.
 *  - none: the route does not own the process, so nothing was installed. */
export type DispatcherOutcome = "installed" | "reused" | "none";

/** The process title pi's CLI gives itself: its APP_NAME (`pi` unless the
 * package's piConfig renames it), with `-rpc` appended by the rpc entry. */
function piCliTitles(): readonly string[] {
  let name = "pi";
  try {
    const pkg = JSON.parse(readFileSync(join(piPackageDir(), "package.json"), "utf8")) as {
      piConfig?: { name?: string };
    };
    name = pkg.piConfig?.name || name;
  } catch {
    // pi not found: the default name is the best there is.
  }
  return [name, `${name}-rpc`];
}

/** True inside a pi CLI process (setupCli and rpc-entry set both signals): the
 * dispatcher there is pi's own and must never be replaced. The environment flag
 * alone is not proof: pi's bash tool hands it to every child, so a standalone
 * `qcr review` started from a pi session inherits it. The process title is set
 * per process and never inherited, so it must agree. */
export function insideCliPi(
  env: NodeJS.ProcessEnv = process.env,
  title: string = process.title,
): boolean {
  return env["PI_CODING_AGENT"] === "true" && piCliTitles().includes(title);
}

/** The directory the installed pi package lives in. Found by walking the
 * module search path: the package's export map hides everything but its entry. */
export function piPackageDir(): string {
  const req = createRequire(import.meta.url);
  for (const base of req.resolve.paths(PI_PACKAGE) ?? []) {
    const dir = join(base, PI_PACKAGE);
    if (existsSync(join(dir, "package.json"))) return dir;
  }
  throw new Error(`pi SDK package ${PI_PACKAGE} not found on the module search path`);
}

export type ConfigureHttpDispatcher = (timeoutMs?: number) => void;

/** pi's own configureHttpDispatcher, deep-imported by file path (the export map
 * does not publish it; D4). It is the same module instance pi's SDK uses, so
 * its fetch bookkeeping stays single. Throws if pi moved or renamed it: that is
 * drift, and canary 6 is where a bump finds out. */
export async function loadConfigureHttpDispatcher(): Promise<ConfigureHttpDispatcher> {
  const file = join(piPackageDir(), "dist", "core", "http-dispatcher.js");
  let mod: { configureHttpDispatcher?: unknown };
  try {
    mod = createRequire(import.meta.url)(file) as typeof mod;
  } catch (e) {
    // Node < 22.12 cannot require() an ES module; the import cache is shared either way.
    if ((e as { code?: string }).code !== "ERR_REQUIRE_ESM") throw e;
    mod = (await import(pathToFileURL(file).href)) as typeof mod;
  }
  if (typeof mod.configureHttpDispatcher !== "function")
    throw new Error(
      `pi's configureHttpDispatcher is gone from ${file}: the pinned pi drifted from what pisdk.ts deep-imports (canary 6)`,
    );
  return mod.configureHttpDispatcher as ConfigureHttpDispatcher;
}

let imageSniffer: Promise<ImageSniffer | null> | undefined;

/** pi's own image sniffer (utils/mime.js), deep-imported the way the dispatcher
 * is: the fenced read tool tells an image from its first bytes with it. Null
 * where pi moved it: a file is then read as text, never as an image. */
export function loadImageSniffer(): Promise<ImageSniffer | null> {
  imageSniffer ??= (async () => {
    try {
      const file = join(piPackageDir(), "dist", "utils", "mime.js");
      const mod = (await import(pathToFileURL(file).href)) as {
        detectSupportedImageMimeType?: unknown;
      };
      return typeof mod.detectSupportedImageMimeType === "function"
        ? (mod.detectSupportedImageMimeType as ImageSniffer)
        : null;
    } catch {
      return null;
    }
  })();
  return imageSniffer;
}

/**
 * Make sure provider requests (and every Node fetch in the process) go through
 * pi's dispatcher, installing it at most once and only when `ownsProcess`.
 *
 * Inside a CLI pi the dispatcher is pi's own and is never touched, whatever the
 * route claims. Nor is one that PiHost installed and something else has since
 * replaced. (undici wraps every dispatcher it is given, and Node creates its own
 * lazily on the first fetch, so a dispatcher cannot be recognised as pi's by
 * looking at it: the flag and title pi's CLI sets, and PiHost's own marker,
 * are the facts there are.)
 */
export async function ensureHttpDispatcher(o: {
  ownsProcess: boolean;
  idleTimeoutMs: number;
}): Promise<DispatcherOutcome> {
  const g = globalThis as Record<symbol, unknown>;
  if (insideCliPi()) return "reused";
  const ours = g[INSTALLED_BY_PIHOST];
  if (ours !== undefined) return g[UNDICI_GLOBAL_DISPATCHER] === ours ? "installed" : "reused";
  if (!o.ownsProcess) return "none";
  (await loadConfigureHttpDispatcher())(o.idleTimeoutMs);
  g[INSTALLED_BY_PIHOST] = g[UNDICI_GLOBAL_DISPATCHER];
  return "installed";
}

// ---- the model's bash environment ---------------------------------------------

/** Names (or `PREFIX*` patterns) of the spec's env the model's bash receives by
 * default. A route adds its own through `bashEnv.allow`. */
export const DEFAULT_BASH_ENV_ALLOW: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LANGUAGE",
  "LC_*",
  "TERM",
  "TZ",
  "TMPDIR",
];

/** The session identity pi itself puts in the bash env (bash.js:137-153); the
 * tool's prompt text promises them, so they pass. */
const PI_SESSION_ENV = [
  "PI_SESSION_ID",
  "PI_SESSION_FILE",
  "PI_PROVIDER",
  "PI_MODEL",
  "PI_REASONING_LEVEL",
] as const;

export interface BashEnvOptions {
  /** Extra names (or `PREFIX*` patterns) taken from the spec's env. */
  allow?: readonly string[];
  /** Explicit values the route sets for the model's bash (a git config pin, a
   * relocator): applied after the allowlist, still subject to the token strip. */
  set?: Readonly<Record<string, string>>;
}

function allowed(name: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => (p.endsWith("*") ? name.startsWith(p.slice(0, -1)) : name === p));
}

/**
 * The environment of one bash call: the spec's env filtered by the allowlist,
 * pi's session identity, the route's explicit values, and never a GitHub token.
 * The process's own env is not a source: a token the host holds cannot leak
 * through here whatever the allowlist says.
 */
export function buildBashEnv(
  specEnv: Readonly<Record<string, string | undefined>>,
  piEnv: Readonly<Record<string, string | undefined>>,
  options: BashEnvOptions = {},
): Record<string, string> {
  const patterns = [...DEFAULT_BASH_ENV_ALLOW, ...(options.allow ?? [])];
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(specEnv))
    if (value !== undefined && allowed(name, patterns)) env[name] = value;
  for (const name of PI_SESSION_ENV) {
    const value = piEnv[name];
    if (value !== undefined) env[name] = value;
  }
  Object.assign(env, options.set);
  for (const name of GITHUB_TOKEN_ENVS) delete env[name];
  return env;
}

// ---- provider auth discovery that does not look in HOME ------------------------

/** pi-ai's default auth context expands `~` to the operator's home to look for
 * ambient credentials (google-vertex checks ~/.config/gcloud for ADC). A review
 * host takes its credentials from the auth file it was given and from env, so
 * `~` paths are simply absent. */
const ISOLATED_AUTH_CONTEXT = {
  async env(name: string): Promise<string | undefined> {
    const value = process.env[name];
    return typeof value === "string" && value.trim().length > 0 ? value : undefined;
  },
  async fileExists(path: string): Promise<boolean> {
    if (path.startsWith("~")) return false;
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  },
};

/** ModelRuntime builds its provider collection with pi-ai's default context and
 * exposes no way to pass another, so swap it on the collection. Fails closed:
 * a pi that moved the field has to be looked at (canary 4). */
function isolateProviderAuth(runtime: ModelRuntime): void {
  const models = (runtime as unknown as { models?: { authContext?: unknown } }).models;
  if (!models || typeof models.authContext !== "object" || models.authContext === null)
    throw new Error(
      "pi's ModelRuntime no longer holds an authContext pisdk.ts isolates (canary 4)",
    );
  models.authContext = ISOLATED_AUTH_CONTEXT;
}

// ---- the resource loader that discovers nothing -------------------------------

/** What a package manager resolves to when there is nothing to resolve. */
const NO_RESOURCES = { extensions: [], skills: [], prompts: [], themes: [] };

class IsolatedResourceLoader extends DefaultResourceLoader {
  constructor(o: {
    cwd: string;
    agentDir: string;
    settingsManager: SettingsManager;
    extensionFactories: readonly ExtensionFactory[];
    systemPrompt: string | undefined;
    appendSystemPrompt: readonly string[];
    agentsFiles: readonly AgentsFile[];
  }) {
    super({
      cwd: o.cwd,
      agentDir: o.agentDir,
      settingsManager: o.settingsManager,
      extensionFactories: [...o.extensionFactories],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      // The belts to the switches' braces: whatever a discovery path still
      // turned up (an extension's resources_discover, a pi that stops honouring
      // a switch) is dropped here. This is where $HOME/.agents/skills is closed
      // on the SDK route.
      skillsOverride: () => ({ skills: [], diagnostics: [] }),
      promptsOverride: () => ({ prompts: [], diagnostics: [] }),
      themesOverride: () => ({ themes: [], diagnostics: [] }),
      agentsFilesOverride: () => ({ agentsFiles: o.agentsFiles.map((f) => ({ ...f })) }),
      systemPromptOverride: () => o.systemPrompt,
      appendSystemPromptOverride: () => [...o.appendSystemPrompt],
    });
    // reload() asks the package manager to scan HOME (~/.agents/skills), the
    // agentDir and every cwd ancestor before any switch applies, so the switches
    // alone still read those directories. Nothing there may be read at all:
    // replace the scan with an empty answer. Fail closed if pi's shape moves.
    const self = this as unknown as { packageManager?: Record<string, unknown> };
    const pm = self.packageManager;
    if (
      !pm ||
      typeof pm["resolve"] !== "function" ||
      typeof pm["resolveExtensionSources"] !== "function"
    )
      throw new Error(
        "pi's DefaultResourceLoader no longer has the package manager pisdk.ts isolates (canary 4)",
      );
    pm["resolve"] = async () => NO_RESOURCES;
    pm["resolveExtensionSources"] = async () => NO_RESOURCES;
  }
}

// ---- the host -----------------------------------------------------------------

export interface PiHostOptions {
  /** A private, absolute directory: pi's auth, models and models-store files
   * live in it. Never the operator's ~/.pi/agent. */
  agentDir: string;
  /** The route owns this process, so PiHost may install pi's HTTP dispatcher
   * (D4). False inside a CLI pi or a host that someone else configured. */
  ownsProcess?: boolean;
  /** Idle timeout for provider requests and the dispatcher. */
  httpIdleTimeoutMs?: number;
  /** Credential storage in place of the file at authPath (read-only copies, D5). */
  credentials?: CreateModelRuntimeOptions["credentials"];
  /** Runs once on the new ModelRuntime: register a provider, set a runtime key. */
  configureModels?: (runtime: ModelRuntime) => void | Promise<void>;
  /** In-memory pi settings, merged over the host defaults. */
  settings?: Parameters<typeof SettingsManager.inMemory>[0];
  /** Context files every session gets unless its spec says otherwise (D34). */
  agentsFiles?: readonly AgentsFile[];
  /** The uid and gid the model's bash runs as (D32): every command of every
   * session of this host is started through setpriv to them. The process must
   * hold CAP_SETUID/CAP_SETGID (the image's cli mode does). Omitted: the
   * model's bash runs as this process. */
  toolUid?: ToolIds;
  /** The setpriv binary for `toolUid`: omitted, a system one by absolute path
   * (tooluid.ts trustedSetpriv). Tests hand a stand-in. */
  setprivBin?: string;
  /** What the file tools may not reach. Omitted: /proc, /run/qcr-in, /qcr-login,
   * the host's agent dir, this home's pi dir, the login sources this process's
   * env names (PI_CODING_AGENT_DIR, QCR_SCAN_AUTH_SRC) and `fenceDirs`.
   * `false` turns the fence off. */
  fence?: ToolFence | false;
  /** More directories for the default fence: where a caller's login source is
   * when it is not in the process env (reviewsdk's processEnv). */
  fenceDirs?: readonly string[];
}

export interface HostSessionSpec {
  /** The session's working directory (also the bash tool's). */
  cwd: string;
  /** The environment the model's bash may draw from; nothing else is read. */
  env: Readonly<Record<string, string | undefined>>;
  /** A model object, or `provider/id` looked up on the host's ModelRuntime. */
  model: string | Model<Api>;
  thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];
  /** The system prompt text. Omitted: pi's own default prompt. */
  systemPrompt?: string;
  /** Text appended to the system prompt, the way `--append-system-prompt` does
   * (a lens's body rides here, over pi's own base prompt). Literal text: never
   * read as a path, unlike the flag. Pieces join with a blank line. */
  appendSystemPrompt?: readonly string[];
  /** Context files (D34), as data. Omitted: the host's. */
  agentsFiles?: readonly AgentsFile[];
  /** Extension factories: the only extensions the session loads. */
  extensions?: readonly ExtensionFactory[];
  customTools?: readonly ToolDefinition[];
  /** The tool allowlist, exact names. Omitted: pi's four defaults. */
  tools?: readonly string[];
  bashEnv?: BashEnvOptions;
  /** Descriptors of this process that each of the model's bash commands gets at
   * the same number, and nothing else (Node closes every other one): the bot
   * worker's IPC capability, which the post scripts read (P8.3). Each must be
   * open now. */
  inheritFds?: readonly number[];
  /** Persist the session's JSONL: at an exact file (a new session, written from
   * its first user message on, as pi's `--session <path>` does), or under a
   * directory pi names the file in (`--session-dir`), or by reopening an
   * existing file under its own id (`resumeFile`; new turns append to it).
   * Omitted: in memory. */
  persist?: { sessionFile: string } | { sessionDir: string } | { resumeFile: string };
  /** The id of an in-memory session. Omitted: a fresh unique one. Sessions given
   * the SAME id share the provider's cache routing (pi derives the cache key and
   * the routing headers from it) and the provider-side resources held for it:
   * disposing any one of them closes the transports of all (pi's
   * cleanupSessionResources(id)). Only a caller that disposes the whole set
   * together (a lens cache group, D7) may share one. With `persist.sessionDir`
   * the file is named `<time>_<id>.jsonl`, so sessions sharing an id still write
   * files of their own. Refused with the other `persist` shapes and with
   * `sessionManager`, which carry their own id. */
  sessionId?: string;
  /** An already-built manager, for a caller that needs one pi's own way
   * (canaries). Wins over `persist`; give one or the other. Default: an
   * in-memory manager with a fresh unique id. */
  sessionManager?: SessionManager;
  /** Called for every extension error pi reports instead of throwing. */
  onExtensionError?: (error: ExtensionError) => void;
}

/** pi's own default tool set at the pin (DEFAULT_TOOL_NAMES). Canary 5 holds it. */
export const DEFAULT_TOOLS: readonly string[] = ["read", "bash", "edit", "write"];

function checkToolAllowlist(tools: readonly string[]): void {
  for (const t of tools)
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/.test(t))
      throw new Error(`tool allowlist entries are exact names, got ${JSON.stringify(t)}`);
}

function resolveModel(runtime: ModelRuntime, model: string | Model<Api>): Model<Api> {
  if (typeof model !== "string") return model;
  const at = model.indexOf("/");
  const found = at > 0 ? runtime.getModel(model.slice(0, at), model.slice(at + 1)) : undefined;
  if (!found) throw new Error(`model ${JSON.stringify(model)} is not known to the host`);
  return found;
}

/** The id a session JSONL's header carries; null when the file does not start
 * with a session header. */
export function headerId(file: string): string | null {
  let first: string | undefined;
  try {
    // The header is the first line; a transcript can run to megabytes.
    const fd = openSync(file, "r");
    try {
      const buf = Buffer.alloc(64 * 1024);
      first = buf.toString("utf8", 0, readSync(fd, buf, 0, buf.length, 0)).split("\n", 1)[0];
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  try {
    const h = JSON.parse(first ?? "") as { type?: unknown; id?: unknown };
    return h.type === "session" && typeof h.id === "string" && h.id !== "" ? h.id : null;
  } catch {
    return null;
  }
}

/** The session manager a spec asks for. A session file that already exists is a
 * resume, not a create, and is refused for `sessionFile`: nothing opens an old
 * session by accident. A resume names its file as `resumeFile`, which must hold
 * a session header: pi would otherwise start a fresh session (a new id, so a
 * cold prompt cache) at a missing or empty path. */
function sessionManagerFor(spec: HostSessionSpec): SessionManager {
  const { persist, sessionManager } = spec;
  if (spec.sessionId !== undefined && (sessionManager || (persist && !("sessionDir" in persist))))
    throw new Error(
      "sessionId names a new session: not with a sessionManager, a sessionFile or a resumeFile",
    );
  if (spec.sessionId === "") throw new Error("sessionId must not be empty");
  if (sessionManager) {
    if (persist) throw new Error("give a sessionManager or persist, not both");
    return sessionManager;
  }
  if (persist && "resumeFile" in persist) {
    const file = persist.resumeFile;
    if (!isAbsolute(file)) throw new Error(`a session file must be absolute, got ${file}`);
    const id = headerId(file);
    if (id === null) throw new Error(`${file} is not a session JSONL to resume`);
    // The cwd override keeps the session in the spec's cwd (the header's belongs
    // to the machine that wrote it); the header on disk is not rewritten.
    const manager = SessionManager.open(file, dirname(file), spec.cwd);
    if (manager.getSessionId() !== id)
      throw new Error(
        `resuming ${file} changed the session id (${id} -> ${manager.getSessionId()})`,
      );
    return manager;
  }
  if (persist && "sessionFile" in persist) {
    const file = persist.sessionFile;
    if (!isAbsolute(file)) throw new Error(`a session file must be absolute, got ${file}`);
    if (existsSync(file)) throw new Error(`session file ${file} already exists`);
    // open() on a path that does not exist yet is how pi starts a session at a
    // chosen file; the cwd override keeps the header's cwd the spec's.
    return SessionManager.open(file, dirname(file), spec.cwd);
  }
  if (persist)
    return SessionManager.create(
      spec.cwd,
      persist.sessionDir,
      spec.sessionId !== undefined ? { id: spec.sessionId } : undefined,
    );
  // VERIFY-ON-PIN (pi 1.3.0): inMemory({id}) sets the session id the provider
  // keys its cache on (prompt_cache_key, session-id, x-client-request-id).
  return SessionManager.inMemory(spec.cwd, { id: spec.sessionId ?? randomUUID() });
}

export class PiHost {
  readonly agentDir: string;
  readonly modelRuntime: ModelRuntime;
  /** What the host found or did about the HTTP dispatcher. */
  readonly dispatcher: DispatcherOutcome;
  readonly httpIdleTimeoutMs: number;
  /** What the file tools are kept out of, or null. */
  readonly fence: ToolFence | null;
  private readonly sessions = new Set<AgentSession>();

  private constructor(
    private readonly options: PiHostOptions,
    modelRuntime: ModelRuntime,
    dispatcher: DispatcherOutcome,
  ) {
    this.agentDir = options.agentDir;
    this.modelRuntime = modelRuntime;
    this.dispatcher = dispatcher;
    this.httpIdleTimeoutMs = options.httpIdleTimeoutMs ?? DEFAULT_HTTP_IDLE_TIMEOUT_MS;
    this.fence =
      options.fence === false
        ? null
        : (options.fence ??
          createToolFence({
            dirs: [
              options.agentDir,
              join(homedir(), ".pi"),
              ...loginSourceDirs(process.env),
              ...(options.fenceDirs ?? []),
            ],
          }));
  }

  static async create(options: PiHostOptions): Promise<PiHost> {
    if (!isAbsolute(options.agentDir))
      throw new Error(`PiHost needs an absolute private agentDir, got ${options.agentDir}`);
    mkdirSync(options.agentDir, { recursive: true });
    const idle = options.httpIdleTimeoutMs ?? DEFAULT_HTTP_IDLE_TIMEOUT_MS;
    const dispatcher = await ensureHttpDispatcher({
      ownsProcess: options.ownsProcess ?? false,
      idleTimeoutMs: idle,
    });
    const runtime = await ModelRuntime.create({
      authPath: join(options.agentDir, "auth.json"),
      modelsPath: join(options.agentDir, "models.json"),
      modelsStorePath: join(options.agentDir, "models-store.json"),
      ...(options.credentials ? { credentials: options.credentials } : {}),
      // No catalog refresh over the network at create: a review run does not
      // wait on, or leak to, a model-list endpoint.
      refreshOnCreate: false,
    });
    isolateProviderAuth(runtime);
    await options.configureModels?.(runtime);
    return new PiHost(options, runtime, dispatcher);
  }

  /** A fresh settings manager per session: sessions never share mutable
   * settings, and project settings (the reviewed repo's .pi/) are never read. */
  private settings(): SettingsManager {
    return SettingsManager.inMemory(
      { httpIdleTimeoutMs: this.httpIdleTimeoutMs, ...this.options.settings },
      { projectTrusted: false },
    );
  }

  /** The file tools of the allowlist, behind the fence. None when there is no fence. */
  private async fileTools(cwd: string, names: readonly string[]): Promise<ToolDefinition[]> {
    const fence = this.fence;
    if (fence === null) return [];
    const ops = fencedOperations(fence, await loadImageSniffer());
    const make: Record<(typeof FENCED_TOOLS)[number], () => unknown> = {
      read: () => createReadToolDefinition(cwd, { operations: ops.read }),
      grep: () => createGrepToolDefinition(cwd, { operations: ops.grep }),
      find: () => createFindToolDefinition(cwd),
      ls: () => createLsToolDefinition(cwd, { operations: ops.ls }),
      edit: () => createEditToolDefinition(cwd, { operations: ops.edit }),
      write: () => createWriteToolDefinition(cwd, { operations: ops.write }),
    };
    return FENCED_TOOLS.filter((n) => names.includes(n)).map((n) =>
      guardedTool(make[n]() as ToolDefinition, fence, cwd),
    );
  }

  /**
   * One isolated, extension-bound session. The caller owns it: dispose it, or
   * dispose the host to dispose every session it made.
   */
  async makeSession(spec: HostSessionSpec): Promise<AgentSession> {
    const tools = [...(spec.tools ?? DEFAULT_TOOLS)];
    checkToolAllowlist(tools);
    const sessionManager = sessionManagerFor(spec);
    const settingsManager = this.settings();
    const resourceLoader = new IsolatedResourceLoader({
      cwd: spec.cwd,
      agentDir: this.agentDir,
      settingsManager,
      extensionFactories: spec.extensions ?? [],
      systemPrompt: spec.systemPrompt,
      appendSystemPrompt: spec.appendSystemPrompt ?? [],
      agentsFiles: spec.agentsFiles ?? this.options.agentsFiles ?? [],
    });
    await resourceLoader.reload();
    // The model's bash: its environment from the allowlist, and, where the host
    // has a tool uid, its command run as that uid (tooluid.ts).
    const bash = createBashToolDefinition(spec.cwd, {
      spawnHook: (ctx) => ({
        command: ctx.command,
        cwd: ctx.cwd,
        env: buildBashEnv(spec.env, ctx.env, spec.bashEnv),
      }),
      ...(this.options.toolUid
        ? {
            operations: isolatedBashOperations(
              this.options.toolUid,
              this.options.setprivBin,
              spec.inheritFds,
            ),
          }
        : spec.inheritFds?.length
          ? { operations: inheritingBashOperations(spec.inheritFds) }
          : {}),
    });
    const files = await this.fileTools(spec.cwd, tools);
    const { session } = await createAgentSession({
      cwd: spec.cwd,
      agentDir: this.agentDir,
      model: resolveModel(this.modelRuntime, spec.model),
      ...(spec.thinkingLevel ? { thinkingLevel: spec.thinkingLevel } : {}),
      modelRuntime: this.modelRuntime,
      resourceLoader,
      sessionManager,
      settingsManager,
      tools,
      customTools: [bash as unknown as ToolDefinition, ...files, ...(spec.customTools ?? [])],
    });
    try {
      await session.bindExtensions({ onError: spec.onExtensionError });
      // The allowlist is enforced by pi; this is the host checking pi's work.
      const stray = session
        .getAllTools()
        .map((t) => t.name)
        .filter((name) => !tools.includes(name));
      if (stray.length > 0)
        throw new Error(`tools outside the allowlist are registered: ${stray.join(", ")}`);
    } catch (e) {
      session.dispose();
      throw e;
    }
    this.sessions.add(session);
    return session;
  }

  /** Dispose every session this host made. Idempotent. */
  dispose(): void {
    for (const s of this.sessions) {
      try {
        s.dispose();
      } catch {
        /* already disposed */
      }
    }
    this.sessions.clear();
  }
}

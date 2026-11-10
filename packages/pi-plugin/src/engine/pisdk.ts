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
//     factories, the system prompt, and the context files (the reviewer
//     stub, as data, never written into a checkout).
//   - The model's bash gets an environment built from an allowlist over the
//     spec's env, with the GitHub token names always stripped (envstrip.ts).
//   - The tool list is an allowlist of exact names. A tool an extension
//     registers that is not on it is dropped.
//   - The model's tools do not reach what holds the run's secrets. Its
//     bash runs as the separate tool uid when the host is given one
//     (`toolUid`, from the image's QCR_TOOL_UID), which the kernel keeps out of
//     /proc/<pid>/mem and environ of this process. Its file tools (read, grep,
//     find, ls, edit, write) run in this process, so each path they are handed
//     goes through a fence (toolfence.ts) that refuses /proc, /run/qcr-in and
//     the agent dirs and the login's source, after resolving symlinks.
//
// The HTTP dispatcher follows the dispatcher ruling. pi's CLI installs an undici dispatcher at
// startup (configureHttpDispatcher, which the package does not export); an
// SDK host needs the same one, since provider requests and our own GitHub
// fetches go through it. PiHost deep-imports pi's own function so the settings
// match exactly, and installs it only when the route says it owns the process.
// Inside a CLI pi (the debug round, the companion, the pi plugin's commands)
// the dispatcher is pi's, and PiHost leaves it alone. Canary 6 pins the
// function and its settings.
//
// A host built by an extension of the running pi (`hostPi`, the plugin's
// /review) knows it is inside pi without the title heuristic, and loads
// nothing from pi's dist/ by file path: the running pi may be a bundle or a
// binary whose files are not the package's. pi's own location comes from its
// exported getPackageDir(), never from a module-path walk.
//
// The pi-facing half of the model route lives here too, since this is where
// pi is: the inventory read off pi's registry facade (`registryInventory`),
// pi's own default per provider, pi's `--model` parser, and the host's one
// route per run (`PiHost.route`). The rule itself is pure and next door
// (../modelroute.ts). A session spec with no model runs on that route, and a
// spec that names a provider with no credential moves by the one rule there.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync } from "node:fs";
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
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
  ModelRegistry,
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
  getPackageDir,
  main as piCliMain,
  resolveCliModel,
} from "@earendil-works/pi-coding-agent";
import { isProtectedWriteTarget } from "../../extensions/bash-guard.js";
import { GITHUB_TOKEN_ENVS } from "../envstrip.js";
import {
  RouteRefused,
  moveToCredentialed,
  resolveRoute,
  splitProvider,
  type CredentialOrigin,
  type ModelRoute,
  type ProviderInventory,
  type RouteInput,
  type RouteResult,
  type SkippedLogin,
} from "../modelroute.js";
import { keyOnlyCredentials } from "./auth.js";
import type { AgentsFile } from "./port.js";
import {
  FENCED_TOOLS,
  createToolFence,
  credentialPaths,
  fencedOperations,
  guardedTool,
  loginSourceDirs,
  type ImageSniffer,
  type ToolFence,
} from "./toolfence.js";
import { inheritingBashOperations, isolatedBashOperations, type ToolIds } from "./tooluid.js";

// ---- the HTTP dispatcher -------------------------------------------------

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
export function piCliTitles(): readonly string[] {
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

/** The directory of the pi package this module runs against: pi's own answer
 * (its exported getPackageDir), so an extension inside a running pi, whose
 * package directory holds no pi of its own, gets the running one. */
export function piPackageDir(): string {
  return getPackageDir();
}

export type ConfigureHttpDispatcher = (timeoutMs?: number) => void;

/** pi's own configureHttpDispatcher, deep-imported by file path (the export map
 * does not publish it). It is the same module instance pi's SDK uses, so
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

// ---- pi's interactive CLI in the launcher's cwd (src/picwd.ts) -------------------

type SessionOpen = typeof SessionManager.open;
const CWD_PINNED = Symbol.for("qcr.picwd.pinned");

/** Make `SessionManager.open` default its cwd to `cwd()` (the launcher's, as its
 * host resolves it) instead of the session header's, the way `resumeFile` below opens a session in the spec's cwd. Idempotent.
 * An explicit override (pi's own missing-cwd recovery) still wins. VERIFY-ON-PIN: pi's
 * CLI reaches the class's static `open` at call time (main.js createSessionManager;
 * tests/picwd.test.ts drives the real one). */
export function pinSessionCwd(manager: { open: SessionOpen }, cwd: () => string): void {
  const holder = manager as { open: SessionOpen; [CWD_PINNED]?: true };
  if (holder[CWD_PINNED]) return;
  const open = manager.open.bind(manager);
  holder.open = (path, sessionDir, cwdOverride) => open(path, sessionDir, cwdOverride ?? cwd());
  holder[CWD_PINNED] = true;
}

/** pi's own CLI entry (its cli.js: setupCli, then main) with the session cwd pinned
 * to `cwd()`, the launching process's (src/picwd.ts). setupCli's steps are repeated
 * here because the package does not export it: the same title and flags (so
 * `insideCliPi` answers as in the CLI binary) and the same HTTP dispatcher. */
export async function runPiCliInCwd(argv: string[], cwd: () => string): Promise<void> {
  process.title = piCliTitles()[0]!;
  process.env["PI_CODING_AGENT"] = "true";
  process.env["AI_AGENT"] = "pi";
  process.emitWarning = () => {};
  (await loadConfigureHttpDispatcher())();
  pinSessionCwd(SessionManager, cwd);
  await piCliMain(argv);
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
  /** The caller is an extension of the running pi CLI: its dispatcher is in
   * place, whatever the title says. */
  hostPi?: boolean;
}): Promise<DispatcherOutcome> {
  const g = globalThis as Record<symbol, unknown>;
  if (o.hostPi === true || insideCliPi()) return "reused";
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
 * host takes its credentials from the store it was given and from an
 * environment, so `~` paths are simply absent. The environment is the one the
 * host names (`authEnv`), else the process's, read at each lookup. */
function isolatedAuthContext(authEnv: Readonly<Record<string, string | undefined>> | undefined) {
  return {
    async env(name: string): Promise<string | undefined> {
      const value = (authEnv ?? process.env)[name];
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
}

/** A model store that holds nothing and keeps nothing: what a host with no
 * stored catalog reads. A host refreshes offline only, and pi persists a
 * catalog only after fetching one, so nothing is ever written to it. */
const NO_STORED_MODELS: NonNullable<CreateModelRuntimeOptions["modelsStore"]> = {
  async read() {
    return undefined;
  },
  async write() {},
  async delete() {},
};

/** ModelRuntime builds its provider collection with pi-ai's default context and
 * exposes no way to pass another, so swap it on the collection. Fails closed:
 * a pi that moved the field has to be looked at (canary 4). */
function isolateProviderAuth(
  runtime: ModelRuntime,
  context: ReturnType<typeof isolatedAuthContext>,
): void {
  const models = (runtime as unknown as { models?: { authContext?: unknown } }).models;
  if (!models || typeof models.authContext !== "object" || models.authContext === null)
    throw new Error(
      "pi's ModelRuntime no longer holds an authContext pisdk.ts isolates (canary 4)",
    );
  models.authContext = context;
}

// ---- the model route's pi-facing half ------------------------------------------

/** The part of pi's ModelRegistry the inventory reads: its public methods
 * only. An SDK host wraps its own runtime in one; an extension inside a
 * running pi is handed one (`ctx.modelRegistry`). */
export interface RouteRegistry {
  getAll(): Model<Api>[];
  getAvailable(): Model<Api>[];
  getProviderAuthStatus(provider: string): {
    configured: boolean;
    source?: string;
    label?: string;
  };
  getProvider(provider: string): { auth: { oauth?: { isSubscription?: boolean } } } | undefined;
  getProviderDisplayName(provider: string): string;
  isUsingOAuth(model: Model<Api>): boolean;
}

/** An environment variable's name that says it carries a key or a token. */
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const KEY_WORD = /(^|_)(KEY|TOKEN)(_|$)/;

/**
 * Where pi found a provider's credential, from its auth status.
 *
 * VERIFY-ON-PIN (pi 1.4.0, canary 13): the status sources are `stored`,
 * `runtime`, `models_json_key`, `models_json_command`, `environment` and
 * `fallback`, and an `environment` status carries as its label what the
 * provider's own check named: the variable's name for a key or a token, a
 * phrase or a non-key variable for an ambient cloud identity (a profile, a
 * role, default credentials).
 */
export function credentialOrigin(status: { source?: string; label?: string }): CredentialOrigin {
  switch (status.source) {
    case "stored":
      return "stored";
    case "runtime":
      return "runtime";
    case "models_json_key":
    case "models_json_command":
      return "models-json";
    case "environment": {
      const label = status.label ?? "";
      return ENV_NAME.test(label) && KEY_WORD.test(label) ? "env-key" : "ambient";
    }
    default:
      return "ambient";
  }
}

/**
 * The inventory over pi's registry facade: every provider pi has a credential
 * for and at least one available model, in pi's own provider order. One
 * function for an SDK host and for a running pi, so the two cannot drift.
 * `exclude` names providers this surface cannot use.
 *
 * The facade reads pi's availability snapshot: the caller sees that it is
 * filled (a host refreshes offline; a running pi keeps it).
 */
export function registryInventory(
  registry: RouteRegistry,
  o: { exclude?: ReadonlySet<string> } = {},
): ProviderInventory[] {
  const all = new Map<string, Model<Api>[]>();
  for (const m of registry.getAll()) {
    const list = all.get(m.provider);
    if (list) list.push(m);
    else all.set(m.provider, [m]);
  }
  const available = new Map<string, Model<Api>[]>();
  for (const m of registry.getAvailable()) {
    const list = available.get(m.provider);
    if (list) list.push(m);
    else available.set(m.provider, [m]);
  }
  const out: ProviderInventory[] = [];
  for (const [provider, known] of all) {
    const models = available.get(provider);
    if (models === undefined || models.length === 0 || o.exclude?.has(provider)) continue;
    const status = registry.getProviderAuthStatus(provider);
    if (!status.configured) continue;
    const oauth = registry.isUsingOAuth(models[0]!);
    const piDefault = piDefaultModelId(provider, known);
    out.push({
      provider,
      name: registry.getProviderDisplayName(provider),
      credential: {
        kind: oauth ? "oauth" : "api_key",
        origin: credentialOrigin(status),
        ...(status.label !== undefined ? { label: status.label } : {}),
        subscription: oauth && registry.getProvider(provider)?.auth.oauth?.isSubscription === true,
      },
      models,
      ...(piDefault.id !== undefined ? { piDefaultId: piDefault.id } : {}),
      ...(piDefault.unread ? { piDefaultUnread: true } : {}),
    });
  }
  return out;
}

/** Rides the clone pi makes of a provider's default model. */
const PROBE_ORIGIN = Symbol.for("qcr.route.origin");
/** An id no provider has, so pi falls back to its "custom model" path. */
const PROBE_ID = "qcr-default-probe-0000";
/** The first model of the list the probe hands pi: what pi falls back to when
 * it names no default for the provider. */
const PROBE_DECOY = "qcr-default-probe-decoy";

/**
 * pi's default model id for `provider`, given the provider's models.
 *
 * pi does not export its per-provider default table, and a file-path import
 * is refused inside a running pi. Its root export `resolveCliModel` reads the
 * table for us: asked for an id the provider does not have, it answers with a
 * "custom model" that is a shallow clone of the provider's default model, or
 * of the provider's first model when it names no default. So each model is
 * tagged with its own id under a symbol, a decoy goes first, and the tag on
 * the clone says which it was.
 *
 * `unread` when pi threw or the clone no longer carries the tag: the guard
 * then has no reference and the version pick stands. A provider with no
 * default (a custom `models.json` provider) is normal and is not `unread`.
 *
 * VERIFY-ON-PIN (pi 1.4.0, canary 12): `resolveCliModel` touches only
 * `getModels()` and `hasConfiguredAuth()` of the runtime it is given, and its
 * custom-id fallback spreads the default model (model-resolver.js
 * buildFallbackModel).
 */
export function piDefaultModelId(
  provider: string,
  models: readonly Model<Api>[],
): { id?: string; unread: boolean } {
  const first = models[0];
  if (first === undefined) return { unread: false };
  try {
    const list = [
      { ...first, id: PROBE_DECOY, name: PROBE_DECOY, [PROBE_ORIGIN]: PROBE_DECOY },
      ...models.map((m) => ({ ...m, [PROBE_ORIGIN]: m.id })),
    ];
    const r = resolveCliModel({
      cliProvider: provider,
      cliModel: PROBE_ID,
      modelRuntime: {
        getModels: () => list,
        hasConfiguredAuth: () => false,
      } as unknown as ModelRuntime,
    });
    const origin = (r.model as unknown as Record<symbol, unknown> | undefined)?.[PROBE_ORIGIN];
    if (typeof origin !== "string") return { unread: true };
    return origin === PROBE_DECOY ? { unread: false } : { id: origin, unread: false };
  } catch {
    return { unread: true };
  }
}

/** A text up to the end of its first sentence. A `.` inside a model id is
 * followed by more of the id, never by a space. */
function firstSentence(text: string): string {
  const m = /^[\s\S]*?[.!?](?=\s|$)/.exec(text.trim());
  return m ? m[0] : text.trim();
}

/**
 * pi's `--model` parser over a registry, shaped for `resolveRoute`: an exact
 * `provider/id`, a bare id one credentialed provider serves, a substring, a
 * `:level` suffix, and an id pi does not know on a provider it does (kept as
 * a custom id).
 *
 * VERIFY-ON-PIN (pi 1.4.0, tests/engine-route.test.ts): `resolveCliModel`
 * answers with `model` and `thinkingLevel`, or with an `error` whose first
 * sentence states the fact and whose later ones name pi's own flags; a custom
 * id comes back as a model the catalog does not hold.
 */
export function textResolver(
  registry: Pick<RouteRegistry, "getAll" | "getProviderAuthStatus">,
): RouteInput["resolveText"] {
  return (text) => {
    const unknown = `Model ${JSON.stringify(text)} not found.`;
    let r: ReturnType<typeof resolveCliModel>;
    try {
      r = resolveCliModel({
        cliModel: text,
        modelRuntime: {
          getModels: () => registry.getAll(),
          hasConfiguredAuth: (provider: string) =>
            registry.getProviderAuthStatus(provider).configured,
        } as unknown as ModelRuntime,
      });
    } catch (e) {
      return { error: firstSentence(e instanceof Error ? e.message : String(e)) };
    }
    const model = r.model;
    if (r.error !== undefined || model === undefined)
      return { error: firstSentence(r.error ?? unknown) };
    const known = registry.getAll().some((m) => m.provider === model.provider && m.id === model.id);
    return {
      model,
      ...(r.thinkingLevel !== undefined ? { thinking: r.thinkingLevel } : {}),
      ...(known ? {} : { custom: true }),
    };
  };
}

/**
 * pi's saved default provider in an agent dir's global settings; undefined
 * when there is none. The cwd given to pi is the agent dir itself, never a
 * reviewed repo, and the project is untrusted, so no project settings are
 * read. pi locks the settings file to read it, which a read-only agent dir
 * refuses: the field is then read from the file as it stands.
 */
export function piSavedProvider(agentDir: string): string | undefined {
  const named = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim() !== "" ? v : undefined;
  try {
    // pi does not throw when it cannot load the file: it answers with empty settings.
    const viaPi = named(
      SettingsManager.create(agentDir, agentDir, { projectTrusted: false }).getGlobalSettings()
        .defaultProvider,
    );
    if (viaPi !== undefined) return viaPi;
  } catch {
    // fall through to the file
  }
  try {
    const raw = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as unknown;
    return typeof raw === "object" && raw !== null
      ? named((raw as Record<string, unknown>)["defaultProvider"])
      : undefined;
  } catch {
    return undefined;
  }
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
   *. False inside a CLI pi or a host that someone else configured. */
  ownsProcess?: boolean;
  /** The host is built by an extension of the running pi CLI (the pi plugin):
   * pi's dispatcher is reused, never installed, and nothing is loaded from
   * pi's dist/ by file path (the read tool then tells no image from its bytes
   * and reads every file as text). Implies `ownsProcess: false`. */
  hostPi?: boolean;
  /** Idle timeout for provider requests and the dispatcher. */
  httpIdleTimeoutMs?: number;
  /** The credential store. Omitted: an empty read-only one, so the host holds
   * no login and pi never creates an `auth.json` of its own in the agent dir;
   * credentials then come from the environment or `configureModels`. */
  credentials?: CreateModelRuntimeOptions["credentials"];
  /** What decides the model of a session whose spec names none. Either a
   * route an earlier step resolved, used as it is (`model`: the pi model it
   * resolved to, for an id this host's own catalog lacks), or the inputs the
   * host resolves one from over its own inventory. Omitted: no pin, no choice. */
  route?:
    | { fixed: ModelRoute; model?: Model<Api> }
    | Partial<Pick<RouteInput, "pin" | "choice" | "piProvider" | "skipped">>;
  /** Where pi's environment lookups for credentials read. Omitted: process.env. */
  authEnv?: Readonly<Record<string, string | undefined>>;
  /** Runs once on the new ModelRuntime: register a provider, set a runtime key. */
  configureModels?: (runtime: ModelRuntime) => void | Promise<void>;
  /** In-memory pi settings, merged over the host defaults. */
  settings?: Parameters<typeof SettingsManager.inMemory>[0];
  /** Context files every session gets unless its spec says otherwise. */
  agentsFiles?: readonly AgentsFile[];
  /** The uid and gid the model's bash runs as: every command of every
   * session of this host is started through setpriv to them. The process must
   * hold CAP_SETUID/CAP_SETGID (the image's cli mode does). Omitted: the
   * model's bash runs as this process. */
  toolUid?: ToolIds;
  /** The setpriv binary for `toolUid`: omitted, a system one by absolute path
   * (tooluid.ts trustedSetpriv). Tests hand a stand-in. */
  setprivBin?: string;
  /** The user's home, as pi resolves `~` (the host resolves it: core reads no
   * home of its own). The default fence keeps its `.pi` out of the file tools,
   * and a tool's `~` path is expanded against it. Omitted: no home is fenced,
   * and a `~` path is refused. */
  homeDir?: string;
  /** What the file tools may not reach. Omitted: /proc, /run/qcr-in, /qcr-login,
   * the host's agent dir, `homeDir`'s pi dir, the login sources this process's
   * env names (PI_CODING_AGENT_DIR, QCR_SCAN_AUTH_SRC), the credentials it
   * points at (toolfence.ts credentialPaths) and `fenceDirs`.
   * `false` turns the fence off. */
  fence?: ToolFence | false;
  /** More paths for the default fence: where a caller's login source and
   * credentials are when they are not in the process env (reviewsdk's
   * processEnv, a bot worker's session env). */
  fenceDirs?: readonly string[];
}

export interface HostSessionSpec {
  /** The session's working directory (also the bash tool's). */
  cwd: string;
  /** The environment the model's bash may draw from; nothing else is read. */
  env: Readonly<Record<string, string | undefined>>;
  /** A model object, or `provider/id` looked up on the host's ModelRuntime
   * (and moved to a credentialed provider that serves the same id when the
   * named one has no credential). Omitted or empty: the host's route. */
  model?: string | Model<Api>;
  thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];
  /** The system prompt text. Omitted: pi's own default prompt. */
  systemPrompt?: string;
  /** Text appended to the system prompt, the way `--append-system-prompt` does
   * (a lens's body rides here, over pi's own base prompt). Literal text: never
   * read as a path, unlike the flag. Pieces join with a blank line. */
  appendSystemPrompt?: readonly string[];
  /** Context files, as data. Omitted: the host's. */
  agentsFiles?: readonly AgentsFile[];
  /** Extension factories: the only extensions the session loads. */
  extensions?: readonly ExtensionFactory[];
  customTools?: readonly ToolDefinition[];
  /** The tool allowlist, exact names. Omitted: pi's four defaults. */
  tools?: readonly string[];
  bashEnv?: BashEnvOptions;
  /** Descriptors of this process that each of the model's bash commands gets at
   * the same number, and nothing else (Node closes every other one): the bot
   * worker's IPC capability, which the post scripts read. Each must be
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
   * together (a lens cache group) may share one. With `persist.sessionDir`
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

/** A spec that moved off the provider it named: `id` runs on `to`, since
 * `from` has no credential on this host. */
export interface RouteMove {
  from: string;
  to: string;
  id: string;
}

/** What `resolveModel` reads of a host. `PiHost` hands its own; a test hands a shape. */
export interface ModelSource {
  /** pi's model for `provider/id`, or undefined when its catalog has none. */
  getModel(provider: string, id: string): Model<Api> | undefined;
  /** The providers the host has a usable credential for. */
  inventory(): Promise<readonly ProviderInventory[]>;
  /** The model of the host's route; rejects with `RouteRefused` when there is none. */
  routeModel(): Promise<Model<Api>>;
  /** Logins left out of the host's store because they cannot last the run. */
  skipped?: readonly SkippedLogin[];
  /** The remembered provider: it breaks a tie between unrelated candidates. */
  prefer?: string;
  /** Told of each move, every time one is made. */
  moved?(move: RouteMove): void;
}

const unknownModel = (model: string): Error =>
  new Error(`model ${JSON.stringify(model)} is not known to the host`);

/**
 * The spec's model on this host.
 *
 *  - A model object is itself.
 *  - No model (`undefined`, `""`) is the host's route.
 *  - `provider/id` is pi's model for it when the provider has a credential.
 *    When it has none, the spec runs on another credentialed provider that
 *    serves the same id, if that choice is not a guess (modelroute.ts
 *    `moveToCredentialed`); otherwise it is refused, with the candidates named.
 *    A provider whose login was left out as too short is refused as such.
 *
 * An id pi does not know is "not known to the host" whoever holds a credential.
 */
export async function resolveModel(
  host: ModelSource,
  model: string | Model<Api> | undefined,
): Promise<Model<Api>> {
  if (model === undefined || model === "") return host.routeModel();
  if (typeof model !== "string") return model;
  const parts = splitProvider(model);
  if (parts === null) throw unknownModel(model);
  const { provider, rest: id } = parts;
  const named = host.getModel(provider, id);
  const inventory = await host.inventory();
  if (inventory.some((e) => e.provider === provider)) {
    if (named === undefined) throw unknownModel(model);
    return named;
  }
  const logins = (host.skipped ?? []).filter((l) => l.provider === provider);
  if (logins.length > 0) throw new RouteRefused({ code: "login-too-short", logins });
  const move = moveToCredentialed({ provider, id }, inventory, host.prefer);
  if (move !== null && "provider" in move) {
    const found = host.getModel(move.provider, id);
    if (found !== undefined) {
      host.moved?.({ from: provider, to: move.provider, id });
      return found;
    }
  }
  // An id pi has never heard of is a wrong name, not a missing credential.
  if (named === undefined) throw unknownModel(model);
  throw new RouteRefused({
    code: "pin-no-credential",
    pin: model,
    provider,
    from: "config",
    candidates: move !== null && "ambiguous" in move ? move.ambiguous : [],
  });
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
  // VERIFY-ON-PIN (pi 1.3.0, re-read at 1.4.0): inMemory({id}) sets the session id the provider
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
  private registryFacade: ModelRegistry | undefined;
  private inventoryOnce: Promise<readonly ProviderInventory[]> | undefined;
  private routeOnce: Promise<RouteResult> | undefined;
  /** pi's model objects for ids the catalog does not hold (a custom pin). */
  private readonly customModels = new Map<string, Model<Api>>();
  private readonly movesMade: RouteMove[] = [];

  private constructor(
    private readonly options: PiHostOptions,
    modelRuntime: ModelRuntime,
    dispatcher: DispatcherOutcome,
    httpIdleTimeoutMs: number,
  ) {
    this.agentDir = options.agentDir;
    this.modelRuntime = modelRuntime;
    this.dispatcher = dispatcher;
    this.httpIdleTimeoutMs = httpIdleTimeoutMs;
    this.fence =
      options.fence === false
        ? null
        : (options.fence ??
          createToolFence({
            protectedWrite: isProtectedWriteTarget,
            dirs: [
              options.agentDir,
              ...(options.homeDir !== undefined ? [join(options.homeDir, ".pi")] : []),
              ...loginSourceDirs(process.env),
              ...credentialPaths(process.env),
              ...(options.fenceDirs ?? []),
            ],
          }));
  }

  static async create(options: PiHostOptions): Promise<PiHost> {
    if (!isAbsolute(options.agentDir))
      throw new Error(`PiHost needs an absolute private agentDir, got ${options.agentDir}`);
    mkdirSync(options.agentDir, { recursive: true });
    const idle = options.httpIdleTimeoutMs ?? DEFAULT_HTTP_IDLE_TIMEOUT_MS;
    if (options.hostPi === true && options.ownsProcess === true)
      throw new Error("a host inside a running pi does not own its process");
    const dispatcher = await ensureHttpDispatcher({
      ownsProcess: options.ownsProcess ?? false,
      idleTimeoutMs: idle,
      ...(options.hostPi === true ? { hostPi: true } : {}),
    });
    const modelsStorePath = join(options.agentDir, "models-store.json");
    const runtime = await ModelRuntime.create({
      authPath: join(options.agentDir, "auth.json"),
      modelsPath: join(options.agentDir, "models.json"),
      modelsStorePath,
      // pi's file store creates the file it is pointed at the first time it is
      // read. A host with no stored catalog writes none: it gets an empty
      // store in memory, and the agent dir stays as it was handed over.
      ...(existsSync(modelsStorePath) ? {} : { modelsStore: NO_STORED_MODELS }),
      // Always a store of the host's own: pi would otherwise open (and create)
      // `auth.json` in the agent dir.
      credentials: options.credentials ?? keyOnlyCredentials(),
      // Nothing is refreshed inside create: pi would do it before the auth
      // context is isolated, and over the network when its switch allows.
      refreshOnCreate: false,
    });
    isolateProviderAuth(runtime, isolatedAuthContext(options.authEnv));
    // The offline refresh: it restores the catalog overlay pi stored in the
    // agent dir (`models-store.json`, the models pi learned since its build),
    // so the host knows the models the person's own pi knows, and it fills the
    // availability snapshot the registry facade reads. It makes no request: a
    // review run does not wait on, or leak to, a model-list endpoint.
    // VERIFY-ON-PIN (pi 1.4.0, canary 15): `refresh({ allowNetwork: false })`
    // runs each provider's restore phase and stops before any network check,
    // whatever PI_OFFLINE says, and the auth context swapped in above is still
    // the one in place after it.
    await runtime.refresh({ allowNetwork: false });
    await options.configureModels?.(runtime);
    return new PiHost(options, runtime, dispatcher, idle);
  }

  private registry(): ModelRegistry {
    this.registryFacade ??= new ModelRegistry(this.modelRuntime);
    return this.registryFacade;
  }

  /**
   * Wait until pi's availability snapshot, which the registry facade reads,
   * agrees with pi asked directly. pi runs its availability passes in the
   * background (after every provider it is handed, every runtime key), and a
   * pass a later one supersedes is dropped without a trace, so asking for one
   * and waiting is not enough: the snapshot is compared, provider by provider,
   * with pi's own unsnapshotted answer, and a pass is asked for again until
   * the two agree. Everything here is offline: a credential read and a check.
   */
  private async settleAvailability(): Promise<void> {
    const runtime = this.modelRuntime;
    for (let attempt = 0; attempt < 10; attempt++) {
      await runtime.getAvailable();
      const direct = new Set<string>();
      await Promise.all(
        runtime.getProviders().map(async (p) => {
          if ((await runtime.getAvailable(p.id)).length > 0) direct.add(p.id);
        }),
      );
      const snapshot = new Set(runtime.getAvailableSnapshot().map((m) => m.provider));
      if (direct.size === snapshot.size && [...direct].every((id) => snapshot.has(id))) return;
    }
  }

  /** The providers this host has a usable credential for, read once from
   * pi's registry facade (`registryInventory`). */
  inventory(): Promise<readonly ProviderInventory[]> {
    this.inventoryOnce ??= (async () => {
      await this.settleAvailability();
      return registryInventory(this.registry());
    })().catch((e: unknown) => {
      this.inventoryOnce = undefined;
      throw e;
    });
    return this.inventoryOnce;
  }

  /** The host's route: the model a session with no model of its own runs on,
   * or why there is none. Resolved once, on first use. */
  route(): Promise<RouteResult> {
    this.routeOnce ??= (async (): Promise<RouteResult> => {
      const given = this.options.route;
      if (given !== undefined && "fixed" in given) return { ok: true, route: given.fixed };
      const resolveText = textResolver(this.registry());
      return resolveRoute({
        inventory: await this.inventory(),
        skipped: given?.skipped ?? [],
        ...(given?.pin ? { pin: given.pin } : {}),
        ...(given?.choice ? { choice: given.choice } : {}),
        ...(given?.piProvider ? { piProvider: given.piProvider } : {}),
        resolveText: (text) => {
          const r = resolveText(text);
          // The route carries ids, not models: keep pi's object for an id the
          // catalog cannot give back.
          if (r.model !== undefined && r.custom === true)
            this.customModels.set(`${r.model.provider}/${r.model.id}`, r.model as Model<Api>);
          return r;
        },
      });
    })().catch((e: unknown) => {
      this.routeOnce = undefined;
      throw e;
    });
    return this.routeOnce;
  }

  /** The moves made so far: each spec that ran on another provider than the
   * one it named, once per provider pair and id. */
  moves(): readonly RouteMove[] {
    return [...this.movesMade];
  }

  /** pi's model for the host's route. */
  private async routeModel(): Promise<Model<Api>> {
    const result = await this.route();
    if (!result.ok) throw new RouteRefused(result.refusal);
    const { provider, modelId, spec } = result.route;
    const given = this.options.route;
    const found =
      this.modelRuntime.getModel(provider, modelId) ??
      this.customModels.get(spec) ??
      (given !== undefined && "fixed" in given ? given.model : undefined);
    if (found === undefined) throw unknownModel(spec);
    return found;
  }

  /** This host, as `resolveModel` reads one. */
  private modelSource(): ModelSource {
    const given = this.options.route;
    const inputs = given !== undefined && !("fixed" in given) ? given : undefined;
    return {
      getModel: (provider, id) => this.modelRuntime.getModel(provider, id),
      inventory: () => this.inventory(),
      routeModel: () => this.routeModel(),
      ...(inputs?.skipped ? { skipped: inputs.skipped } : {}),
      ...(inputs?.choice ? { prefer: inputs.choice.provider } : {}),
      moved: (move) => {
        if (
          !this.movesMade.some((m) => m.from === move.from && m.to === move.to && m.id === move.id)
        )
          this.movesMade.push(move);
      },
    };
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
    const ops = fencedOperations(
      fence,
      this.options.hostPi === true ? null : await loadImageSniffer(),
    );
    const make: Record<(typeof FENCED_TOOLS)[number], () => unknown> = {
      read: () => createReadToolDefinition(cwd, { operations: ops.read }),
      grep: () => createGrepToolDefinition(cwd, { operations: ops.grep }),
      find: () => createFindToolDefinition(cwd),
      ls: () => createLsToolDefinition(cwd, { operations: ops.ls }),
      edit: () => createEditToolDefinition(cwd, { operations: ops.edit }),
      write: () => createWriteToolDefinition(cwd, { operations: ops.write }),
    };
    return FENCED_TOOLS.filter((n) => names.includes(n)).map((n) =>
      guardedTool(make[n]() as ToolDefinition, fence, cwd, this.options.homeDir),
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
      model: await resolveModel(this.modelSource(), spec.model),
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

/** pi's own parse of a session file, as a worker's first act on it: open it and
 * rebuild the context. No session is started and nothing is written to `file`.
 * The cutover preflight (src/preflight.ts) resumes every open PR's JSONL with it. */
export function openSessionContext(file: string, sessionDir: string, cwd: string): void {
  SessionManager.open(file, sessionDir, cwd).buildSessionContext();
}

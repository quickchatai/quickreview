// lens — our lens tools (`lens`, `lens_wave`) as a pi extension, the interactive
// pi's way to run lenses in-process on the SDK.
//
// The tools themselves are packages/pi-plugin/src/engine/lens/tool.ts; this file gives them to pi,
// in the two shapes the hosts want:
//
//   lensTools(deps)    the two ToolDefinitions, for an SDK main session's
//                      `customTools` (the engine routes hand them over data,
//                      packages/pi-plugin/src/engine/lens/engine-tools.ts)
//   createLens(deps)   the factory that registers them on a pi
//   extensions/cli/lens.ts  the env shim for an interactive pi (a debug round, the
//                      companion): it builds the lens runner on first use
//
// The tmux bot does NOT load this file. pi's native `subagent` and the glue's
// `launch_plan` (extensions/subagents.ts) are retired. A lens session is
// never given either of these tools (the runner refuses an agent file that
// lists one, include.ts strips them at build time), so a pass cannot fan out.
// They ride the session's own extension list, never the global settings.json.
//
// The shim's lens sessions are SDK sessions of this pi process. It builds a
// PiHost over the pi's own agent dir (`PI_CODING_AGENT_DIR`) with a read-only
// copy of its login, and leaves the HTTP dispatcher to the CLI pi
// (`ownsProcess` false). The host is built when the first lens is asked for, so
// a login it cannot use fails that call, never the pi's start-up. The copy is
// borrowed like any other (packages/pi-plugin/src/engine/auth.ts
// `borrowedCredentials`), with nothing to renew it: no login file is an empty
// store, a login shorter than a round is left out, and the refusal a person
// sees is the route's (`login-too-short`, or `no-credential`). This is the one
// extension that may reach packages/pi-plugin/src/engine/pisdk.ts (tests/helpers/engine-fences.ts).
//
// A lens whose agent file pins no model runs on the model the session is on
// when that first lens is asked for: the host is handed the session's model as
// its route, so a debug round's lenses run where the round it reproduces ran,
// and the companion's where the companion itself runs. A session whose model
// pi has no credential for hands over nothing, and the host resolves a route
// of its own over the same login. A session on a login the borrow left out
// hands its model over as a stated choice instead: it runs on a key the
// environment holds for that provider, or the lens is refused, and never
// moves to another provider on its own.
//
// VERIFY-ON-PIN: defineTool's and registerTool's definition shape, as in
// finding-clusters.ts.
import { dirname, isAbsolute, join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionFactory,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { agentDirSettings } from "../src/engine/agentdir.js";
import { borrowedCredentials } from "../src/engine/auth.js";
import { LENS_LEDGER_FILE, LENS_SESSIONS_DIR } from "../src/engine/openable.js";
import { resolvePassDeadlineMs } from "../src/engine/lens/deadline.js";
import { loadBuiltAgents, type AgentRegistry } from "../src/engine/lens/registry.js";
import {
  createLensRunner,
  type LensRunConfig,
  type LensRunner,
} from "../src/engine/lens/runlens.js";
import {
  LENS_TOOL,
  LENS_WAVE_TOOL,
  lensToolDefinitions,
  type LensToolDeps,
} from "../src/engine/lens/tool.js";
import { LensWave } from "../src/engine/lens/wave.js";
import { PiHost, type PiHostOptions } from "../src/engine/pisdk.js";
import { listPrice } from "../src/modelpick.js";
import type { ModelRoute, SkippedLogin } from "../src/modelroute.js";
import { bashGuardConfigFromEnv, createBashGuard } from "./bash-guard.js";
import { toPiTool } from "./pi-tool.js";
import { registryInventory, type RouteRegistry } from "./route-registry.js";
import {
  resolveCacheGroup,
  resolveCacheStagger,
  resolveMaxConcurrency,
} from "../src/engine/lens/env.js";

export { LENS_TOOL, LENS_WAVE_TOOL };

/** The two tools as pi ToolDefinitions, over `deps`. */
export function lensTools(deps: LensToolDeps): ToolDefinition[] {
  return lensToolDefinitions(deps).map((t) => defineTool(toPiTool(t)));
}

/** The factory that registers `lens` and `lens_wave` on a pi. */
export function createLens(deps: LensToolDeps): ExtensionFactory {
  return (pi: ExtensionAPI): void => {
    for (const tool of lensTools(deps)) pi.registerTool(tool);
  };
}

/** How long a lens session has before its login must not expire: the
 * longest a round runs. */
const LOGIN_WINDOW_MS = 90 * 60_000;

/** The agent dir an interactive pi runs over; anything but an absolute path is refused. */
function requireAgentDir(env: Readonly<Record<string, string | undefined>>): string {
  const agentDir = env["PI_CODING_AGENT_DIR"];
  if (agentDir === undefined || !isAbsolute(agentDir))
    throw new Error(`lens: PI_CODING_AGENT_DIR is not an absolute path (${String(agentDir)})`);
  return agentDir;
}

/** The runner of an interactive pi, from its environment. Exported so the shim's
 * wiring can be tested with a host of its own, and so an engine route (the bench)
 * can build its round's runner the same way over agents it keeps elsewhere
 * (`registry`; omitted: the agent dir's own `agents`). */
export function lensRunConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  host: PiHost,
  cwd: string,
  registry?: AgentRegistry,
): LensRunConfig {
  const agentDir = requireAgentDir(env);
  const ledger = env["QCR_LEDGER_FILE"];
  const group = resolveCacheGroup({ ...env });
  const deadlineMs = resolvePassDeadlineMs({ ...env });
  return {
    host,
    permits: resolveMaxConcurrency({ ...env }),
    registry: registry ?? loadBuiltAgents(join(agentDir, "agents")),
    cwd,
    env,
    bashGuard: createBashGuard(bashGuardConfigFromEnv(env, cwd)),
    ledgerPath: join(ledger ? dirname(ledger) : agentDir, LENS_LEDGER_FILE),
    // A round's lens sessions are kept beside its ledger; an interactive pi
    // with no round keeps none, and never writes into its own agent dir.
    ...(ledger ? { sessionsDir: join(dirname(ledger), LENS_SESSIONS_DIR) } : {}),
    ...(deadlineMs !== undefined ? { deadlineMs } : {}),
    // The round's context pack belongs to a wave the engine launches; an
    // interactive pi's groups are warmed by the stagger.
    ...(group > 0 ? { cache: { size: group, staggerMs: resolveCacheStagger({ ...env }) } } : {}),
  };
}

/** The route a lens host is handed: the model the pi session is on, with pi's
 * own object for it (the host's catalog may not hold the id). */
export interface LensHostRoute {
  fixed: ModelRoute;
  model: Model<Api>;
}

/** Builds the PiHost an interactive pi's lens passes run on. `route` is the
 * session's model when it has one pi can use; omitted, the host resolves a
 * route of its own. */
export type MakeLensHost = (agentDir: string, route?: LensHostRoute) => Promise<PiHost>;

/** What the lens tools read of the pi session they are registered on. */
export interface LensSession {
  model: Model<Api> | undefined;
  modelRegistry: RouteRegistry | undefined;
}

/**
 * The session's model as a host's route, or undefined when the session has no
 * model, pi's registry cannot be read, or pi has no credential for the model's
 * provider (the host then resolves its own route, or refuses with the reason).
 * The credential is the one pi's registry reports for the provider: nothing
 * about it is made up here.
 */
export function sessionRoute(session: LensSession): LensHostRoute | undefined {
  const { model, modelRegistry } = session;
  if (model === undefined || modelRegistry === undefined) return undefined;
  let entry: ReturnType<typeof registryInventory>[number] | undefined;
  try {
    entry = registryInventory(modelRegistry).find((e) => e.provider === model.provider);
  } catch {
    return undefined;
  }
  if (entry === undefined) return undefined;
  return {
    model,
    fixed: {
      provider: model.provider,
      modelId: model.id,
      providerName: entry.name,
      spec: `${model.provider}/${model.id}`,
      thinking: null,
      source: "pi-provider",
      pick: "pinned",
      piDefaultId: null,
      custom: !entry.models.some((m) => m.id === model.id),
      movedFrom: null,
      credential: entry.credential,
      priced: listPrice(model) > 0,
      ask: false,
      alternatives: [],
      notices: [],
    },
  };
}

/** The shim's runner: the host and the runner are built by the first pass. */
function lazyRunner(
  env: Readonly<Record<string, string | undefined>>,
  cwd: () => string,
  makeHost: MakeLensHost,
  adjust: (config: LensRunConfig) => LensRunConfig,
  session: () => LensSession,
): LensToolDeps["runner"] {
  let built: Promise<LensRunner> | undefined;
  const ensure = (): Promise<LensRunner> => {
    built ??= (async () => {
      const agentDir = requireAgentDir(env);
      const host = await makeHost(agentDir, sessionRoute(session()));
      return createLensRunner(adjust(lensRunConfigFromEnv(env, host, cwd())));
    })();
    // A host that failed to build is not kept: the next ask tries again.
    built.catch(() => {
      built = undefined;
    });
    return built;
  };
  return { run: async (request) => (await ensure()).run(request) };
}

/**
 * What a lens host's route is built from: the session's model (`session`) and
 * the logins the host's borrow left out as too short for a round (`skipped`).
 *
 *  - Nothing left out: the session's route as it is, or none.
 *  - No session route: the host resolves its own, told what was left out, so
 *    with nothing else usable the refusal is `login-too-short`.
 *  - The session is on a login that was left out: its model is handed over as
 *    a choice the person stated. It holds like a pin: it runs on a credential
 *    the host does have for that provider (a key in the environment), and is
 *    refused as `login-too-short` otherwise. It is never moved elsewhere.
 *  - The session's own login was kept: its route as it is.
 */
export function lensHostRoute(
  session: LensHostRoute | undefined,
  skipped: readonly SkippedLogin[],
): PiHostOptions["route"] {
  if (skipped.length === 0) return session;
  if (session === undefined) return { skipped };
  const { provider, modelId } = session.fixed;
  if (!skipped.some((l) => l.provider === provider)) return session;
  return { skipped, choice: { provider, model: modelId, via: "use", no_estimate_ok: [] } };
}

/** A PiHost over the interactive pi's own agent dir: a read-only copy of its
 * login, pi's dispatcher left alone. Nothing renews the copy while a round
 * goes, so a login shorter than one is left out of it and named to the host's
 * route (`lensHostRoute`). pi looks for a provider key in `env`, by its own
 * names and in its own order (a stored credential owns its provider).
 * `route` is the session's model: what a lens that pins no model runs on. */
async function interactiveHost(
  agentDir: string,
  env: Readonly<Record<string, string | undefined>>,
  homeDir: string | undefined,
  route: LensHostRoute | undefined,
): Promise<PiHost> {
  const borrowed = borrowedCredentials({
    srcDir: agentDir,
    needMs: LOGIN_WINDOW_MS,
    owner: false,
  });
  const hostRoute = lensHostRoute(route, borrowed.skipped);
  return PiHost.create({
    agentDir,
    ownsProcess: false,
    ...(homeDir !== undefined ? { homeDir } : {}),
    credentials: borrowed.credentials,
    settings: agentDirSettings(agentDir),
    authEnv: env,
    ...(hostRoute !== undefined ? { route: hostRoute } : {}),
  });
}

/** The interactive pi's lens tools and the board and runner behind them. */
export interface InteractiveLens {
  /** Registers `lens` and `lens_wave` on a pi. */
  factory: ExtensionFactory;
  /** The runner a pass starts on (builds the host on its first pass). */
  runner: LensToolDeps["runner"];
  /** The rows in flight: what `lens_wave` joins. A round's wave starts on it. */
  wave: LensWave;
}

/** The interactive pi's lens tools over `makeHost`, which builds the PiHost on
 * the first pass. Exported so a test can hand it a host of its own, and so the
 * debug round (extensions/debug-round.ts) can start its planned wave on the very
 * board and runner the session's `lens_wave` reads. */
export function interactiveLensBoard(
  env: Readonly<Record<string, string | undefined>>,
  cwd: () => string,
  makeHost: MakeLensHost,
  /** Final say on the runner's config (the debug round adds the reviewer stub,
   * the bash env allowlist and the context pack). */
  adjust: (config: LensRunConfig) => LensRunConfig = (c) => c,
): InteractiveLens {
  // The session the tools are registered on, as it is now: its start and each
  // model the person picks are kept, and the first pass reads them. A wave the
  // host itself starts (a debug round's command) has no tool call to read it
  // from, so the events are the source.
  const session: LensSession = { model: undefined, modelRegistry: undefined };
  const runner = lazyRunner(env, cwd, makeHost, adjust, () => session);
  const wave = new LensWave();
  const tools = createLens({ runner, wave, env, cwd });
  const factory: ExtensionFactory = (pi) => {
    if (typeof pi.on === "function") {
      pi.on("session_start", (_event, ctx) => {
        session.model = ctx.model;
        session.modelRegistry = ctx.modelRegistry;
      });
      pi.on("model_select", (event, ctx) => {
        session.model = event.model;
        session.modelRegistry = ctx.modelRegistry;
      });
    }
    return tools(pi);
  };
  return { factory, runner, wave };
}

export function interactiveLens(
  env: Readonly<Record<string, string | undefined>>,
  cwd: () => string,
  makeHost: MakeLensHost,
  /** Where the runner's warnings go (`[lens] …`), one line each: the host's.
   * Omitted: nowhere. */
  warn?: (line: string) => void,
): ExtensionFactory {
  return interactiveLensBoard(env, cwd, makeHost, lensWarnTo(warn)).factory;
}

/** A runner config adjustment that sends its warnings to `warn`, prefixed. */
export function lensWarnTo(
  warn: ((line: string) => void) | undefined,
): (config: LensRunConfig) => LensRunConfig {
  return (c) => (warn ? { ...c, warn: (m) => warn(`[lens] ${m}`) } : c);
}

/** The host an interactive pi's lens passes run on, from its env. `homeDir` is
 * the user's home the host resolved (the tool fence keeps its `.pi` out). */
export function interactiveHostFor(
  env: Readonly<Record<string, string | undefined>>,
  homeDir?: string,
): MakeLensHost {
  return (dir, route) => interactiveHost(dir, env, homeDir, route);
}

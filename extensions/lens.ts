// lens — our lens tools (`lens`, `lens_wave`) as a pi extension, the interactive
// pi's way to run lenses in-process on the SDK.
//
// The tools themselves are src/engine/lens/tool.ts; this file gives them to pi,
// in the two shapes the hosts want:
//
//   lensTools(deps)    the two ToolDefinitions, for an SDK main session's
//                      `customTools` (the engine routes hand them over data,
//                      src/engine/lens/engine-tools.ts)
//   createLens(deps)   the factory that registers them on a pi
//   default export     the env shim for an interactive pi (a debug round, the
//                      companion): it builds the lens runner on first use
//
// The tmux bot does NOT load this file: it runs pi's native `subagent` and the
// glue's `launch_plan` through extensions/subagents.ts, unchanged, until it
// moves to workers. A lens session is never given either of these tools (the
// runner refuses an agent file that lists one, include.ts strips them at build
// time), so a pass cannot fan out. They ride the session's own extension list,
// never the global settings.json.
//
// The shim's lens sessions are SDK sessions of this pi process. It builds a
// PiHost over the pi's own agent dir (`PI_CODING_AGENT_DIR`) with a read-only
// copy of its login (D5), and leaves the HTTP dispatcher to the CLI pi (D4:
// `ownsProcess` false). The host is built when the first lens is asked for, so
// a missing login fails that call, never the pi's start-up. This is the one
// extension that may reach src/engine/pisdk.ts (tests/helpers/engine-fences.ts).
//
// VERIFY-ON-PIN: defineTool's and registerTool's definition shape, as in
// finding-clusters.ts.
import { dirname, isAbsolute, join } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionFactory,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { agentDirSettings } from "../src/engine/agentdir.js";
import { applyEnvApiKeys, engineCredentials } from "../src/engine/auth.js";
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
import { PiHost } from "../src/engine/pisdk.js";
import { bashGuardConfigFromEnv, createBashGuard } from "./bash-guard.js";
import { toPiTool } from "./pi-tool.js";
import { resolveCacheGroup, resolveCacheStagger, resolveMaxConcurrency } from "./subagents.js";

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

/** How long a lens session has before its login must not expire (D5): the
 * longest a round runs. */
const LOGIN_WINDOW_MS = 90 * 60_000;

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
  const agentDir = env["PI_CODING_AGENT_DIR"];
  if (agentDir === undefined || !isAbsolute(agentDir))
    throw new Error(`lens: PI_CODING_AGENT_DIR is not an absolute path (${String(agentDir)})`);
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
    ledgerPath: join(ledger ? dirname(ledger) : agentDir, "lens-ledger.jsonl"),
    ...(deadlineMs !== undefined ? { deadlineMs } : {}),
    // The round's context pack belongs to a wave the engine launches; an
    // interactive pi's groups are warmed by the stagger.
    ...(group > 0 ? { cache: { size: group, staggerMs: resolveCacheStagger({ ...env }) } } : {}),
  };
}

/** The shim's runner: the host and the runner are built by the first pass. */
function lazyRunner(
  env: Readonly<Record<string, string | undefined>>,
  cwd: () => string,
  makeHost: (agentDir: string) => Promise<PiHost>,
): LensToolDeps["runner"] {
  let built: Promise<LensRunner> | undefined;
  const ensure = (): Promise<LensRunner> => {
    built ??= (async () => {
      const agentDir = env["PI_CODING_AGENT_DIR"];
      if (agentDir === undefined || !isAbsolute(agentDir))
        throw new Error(`lens: PI_CODING_AGENT_DIR is not an absolute path (${String(agentDir)})`);
      const host = await makeHost(agentDir);
      return createLensRunner(lensRunConfigFromEnv(env, host, cwd()));
    })();
    // A host that failed to build is not kept: the next ask tries again.
    built.catch(() => {
      built = undefined;
    });
    return built;
  };
  return { run: async (request) => (await ensure()).run(request) };
}

/** A PiHost over the interactive pi's own agent dir: a read-only copy of its
 * login, pi's dispatcher left alone. */
async function interactiveHost(
  agentDir: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<PiHost> {
  const auth = engineCredentials({ srcDir: agentDir, needMs: LOGIN_WINDOW_MS });
  return PiHost.create({
    agentDir,
    ownsProcess: false,
    credentials: auth.credentials,
    settings: agentDirSettings(agentDir),
    configureModels: async (runtime) => {
      await applyEnvApiKeys(runtime, env);
    },
  });
}

/** The interactive pi's lens tools over `makeHost`, which builds the PiHost on
 * the first pass. Exported so a test can hand it a host of its own. */
export function interactiveLens(
  env: Readonly<Record<string, string | undefined>>,
  cwd: () => string,
  makeHost: (agentDir: string) => Promise<PiHost>,
): ExtensionFactory {
  return createLens({ runner: lazyRunner(env, cwd, makeHost), wave: new LensWave(), env });
}

const activate = (pi: ExtensionAPI): void => {
  if (typeof pi.registerTool !== "function") {
    console.error("lens: pi.registerTool unavailable — lens and lens_wave not registered.");
    return;
  }
  const env = process.env;
  void interactiveLens(
    env,
    () => process.cwd(),
    (dir) => interactiveHost(dir, env),
  )(pi);
};

export default activate;

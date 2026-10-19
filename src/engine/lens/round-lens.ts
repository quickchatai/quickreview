// The engine's lens tools for one round's main session, built from the session's
// spec: the passes' agents, cwd, env, cap, deadline and cache groups are read
// from the same env names the native tool reads (`QCR_SUBAGENT_*`), so one
// config drives either tool. A route that hosts a round on the SDK with
// `[pi] lens_runtime = "engine"` passes this as its `lens` (src/engine/
// reviewsdk.ts); the passes run on the same PiHost as the main session.
import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { lensRunConfigFromEnv } from "../../../extensions/lens.js";
import type { PiHost } from "../pisdk.js";
import type { SessionSpec } from "../port.js";
import { BASH_ENV_ALLOW } from "../roundsdk.js";
import { engineLensTools, type EngineLensTools } from "./engine-tools.js";
import { loadBuiltAgents } from "./registry.js";
import type { LensRunConfig } from "./runlens.js";

const SCOPE_ENV = "QCR_SUBAGENT_SCOPE";

/** Where a round's built lens agents are: the nearest `.pi/agents` above the cwd
 * for the `project` scope (the bench's), else the agent dir's `agents` (the host
 * route's `user` scope). */
export function lensAgentsDir(
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
): string {
  const agentDir = env["PI_CODING_AGENT_DIR"];
  if (agentDir === undefined || !isAbsolute(agentDir))
    throw new Error(`lens: PI_CODING_AGENT_DIR is not an absolute path (${String(agentDir)})`);
  if ((env[SCOPE_ENV] ?? "").trim() !== "project") return join(agentDir, "agents");
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const candidate = join(dir, ".pi", "agents");
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
    if (dirname(dir) === dir) throw new Error(`lens: no .pi/agents at or above ${cwd}`);
  }
}

/** The lens runner's config for the round `spec` opens, over the agents its
 * scope names. A pass's bash draws from the same names as the main session's
 * (the git isolation pins, QCR_*): on proc a pass child inherits the whole env,
 * and the pins must reach it all the same. */
export function roundLensConfig(spec: SessionSpec, host: PiHost): LensRunConfig {
  const registry = loadBuiltAgents(lensAgentsDir(spec.env, spec.cwd));
  return {
    ...lensRunConfigFromEnv(spec.env, host, spec.cwd, registry),
    bashEnv: { allow: BASH_ENV_ALLOW },
  };
}

/** `lens` and `lens_wave` for the round `spec` opens, running its passes on `host`. */
export function roundLensTools(spec: SessionSpec, host: PiHost): EngineLensTools {
  return engineLensTools(roundLensConfig(spec, host));
}

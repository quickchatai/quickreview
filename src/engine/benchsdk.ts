// The runtimes the bench hosts its sessions on when `[engine] runtime = "sdk"`:
// the review round's main session and the defect judge's session, each as an
// in-process SDK session. They are `reviewSdkRuntime` (packages/pi-plugin/src/engine/reviewsdk.ts)
// with the bench's pieces: the bench is its own host, so the HTTP dispatcher and
// the login are built from the case's private agent dir exactly as `qcr review`
// builds them.
//
// ONE HOST PER CASE. A bench process hosts one case (or one judge case) and
// exits: src/bench/casehost.ts starts a child node process per case, so a crash
// or a frozen event loop costs that case alone. This module does not pool; a
// runtime built here is meant to live as long as one case.
//
// LENSES. The main session gets our `lens` / `lens_wave` over the agents
// `buildBenchAgents` wrote, run in this process on the same host.
import {
  createBashGuard,
  bashGuardConfigFromEnv,
} from "@quickchatai/pi-quickreview/extensions/bash-guard.js";
import { homedir } from "node:os";
import { BUDGET_EXIT_CODE } from "@quickchatai/pi-quickreview/src/engine/budget.js";
import { engineLensTools } from "@quickchatai/pi-quickreview/src/engine/lens/engine-tools.js";
import { roundLensConfig } from "@quickchatai/pi-quickreview/src/engine/lens/round-lens.js";
import type { PiHostOptions, PiHost } from "@quickchatai/pi-quickreview/src/engine/pisdk.js";
import type { Runtime } from "@quickchatai/pi-quickreview/src/engine/port.js";
import { reviewSdkRuntime } from "@quickchatai/pi-quickreview/src/engine/reviewsdk.js";

export interface BenchSdkOptions {
  /** `[pi] engine_wave`, with the engine lens tool: the round starts the planned
   * discovery wave itself (rule 9) and the main session joins it. Off: the main
   * session launches the wave. */
  plannedWave?: boolean;
  /** Builds the host (tests hand a faux-provider host). */
  makeHost?: (o: PiHostOptions) => Promise<PiHost>;
  processEnv?: NodeJS.ProcessEnv;
}

/** What the model's bash may draw from the judge's env beyond the host defaults. */
const JUDGE_BASH_ENV_ALLOW = ["GIT_*"] as const;

/** A case host owns its process: a wedged turn exits it, the round's
 * diagnostics go to its stderr, and the fence knows this user's home. */
const CASE_HOST = {
  backstop: (): void => process.exit(BUDGET_EXIT_CODE),
  warn: (line: string): void => console.error(line),
  homeDir: homedir(),
};

/** The review round's runtime. */
export function benchSdkRuntime(o: BenchSdkOptions): Runtime {
  return reviewSdkRuntime({
    ...(o.makeHost ? { makeHost: o.makeHost } : {}),
    ...(o.processEnv ? { processEnv: o.processEnv } : {}),
    ...(o.plannedWave
      ? { engine: { plannedWave: true, config: (host, spec) => roundLensConfig(spec, host) } }
      : {
          lens: (spec, host) =>
            engineLensTools({
              ...roundLensConfig(spec, host),
              warn: (m) => CASE_HOST.warn(`[lens] ${m}`),
            }),
        }),
    ...CASE_HOST,
  });
}

/** The defect judge's runtime: no skill, no context file, no project-local file,
 * the no-exec bash guard the only extension, and no lens tool (a judge reads
 * code to check a claim). The spec's `tools` is its allowlist. */
export function judgeSdkRuntime(o: BenchSdkOptions = {}): Runtime {
  return reviewSdkRuntime({
    ...(o.makeHost ? { makeHost: o.makeHost } : {}),
    ...(o.processEnv ? { processEnv: o.processEnv } : {}),
    ...CASE_HOST,
    extras: (spec) => ({
      extensions: [createBashGuard(bashGuardConfigFromEnv(spec.env, spec.cwd))],
      agentsFiles: [],
      bashEnv: { allow: JUDGE_BASH_ENV_ALLOW },
    }),
  });
}

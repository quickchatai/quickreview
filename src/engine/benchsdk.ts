// The runtimes the bench hosts its sessions on when `[engine] runtime = "sdk"`:
// the review round's main session and the defect judge's session, each as an
// in-process SDK session. They are `reviewSdkRuntime` (src/engine/reviewsdk.ts)
// with the bench's pieces: the bench is its own host, so the HTTP dispatcher and
// the login are built from the case's private agent dir exactly as `qcr review`
// builds them.
//
// ONE HOST PER CASE. A bench process hosts one case (or one judge case) and
// exits: src/bench/casehost.ts starts a child node process per case, so a crash
// or a frozen event loop costs that case alone. This module does not pool; a
// runtime built here is meant to live as long as one case.
//
// LENSES. `lens_runtime = "native"` keeps pi's `subagent` / `launch_plan` tool
// (its children inherit the case's spill dir and git isolation through the
// process env, which the runtime scopes to the session's life); `"engine"` gives
// the main session our `lens` / `lens_wave` over the agents `buildBenchAgents`
// wrote, run in this process on the same host.
import { createBashGuard, bashGuardConfigFromEnv } from "../../extensions/bash-guard.js";
import type { LensRuntimeKind } from "../config.js";
import { roundLensTools } from "./lens/round-lens.js";
import type { PiHostOptions, PiHost } from "./pisdk.js";
import type { Runtime } from "./port.js";
import { reviewSdkRuntime } from "./reviewsdk.js";

export interface BenchSdkOptions {
  /** Which lens tool the review round's main session gets. */
  lens: LensRuntimeKind;
  /** Builds the host (tests hand a faux-provider host). */
  makeHost?: (o: PiHostOptions) => Promise<PiHost>;
  processEnv?: NodeJS.ProcessEnv;
}

/** The names of a case's env that the native lens tool's children need besides
 * the QCR_* names: the spill dir on the disk-backed volume and the git
 * isolation pins. */
const isBenchChildEnv = (name: string): boolean => name === "TMPDIR" || name.startsWith("GIT_");

/** What the model's bash may draw from the judge's env beyond the host defaults. */
const JUDGE_BASH_ENV_ALLOW = ["GIT_*"] as const;

/** The review round's runtime. */
export function benchSdkRuntime(o: BenchSdkOptions): Runtime {
  return reviewSdkRuntime({
    ...(o.makeHost ? { makeHost: o.makeHost } : {}),
    ...(o.processEnv ? { processEnv: o.processEnv } : {}),
    childEnv: isBenchChildEnv,
    ...(o.lens === "engine" ? { lens: (spec, host) => roundLensTools(spec, host) } : {}),
  });
}

/** The defect judge's runtime: no skill, no context file, no project-local file,
 * the no-exec bash guard the only extension, and no lens tool (a judge reads
 * code to check a claim). The spec's `tools` is its allowlist. */
export function judgeSdkRuntime(o: Omit<BenchSdkOptions, "lens"> = {}): Runtime {
  return reviewSdkRuntime({
    ...(o.makeHost ? { makeHost: o.makeHost } : {}),
    ...(o.processEnv ? { processEnv: o.processEnv } : {}),
    extras: (spec) => ({
      extensions: [createBashGuard(bashGuardConfigFromEnv(spec.env, spec.cwd))],
      agentsFiles: [],
      bashEnv: { allow: JUDGE_BASH_ENV_ALLOW },
    }),
  });
}

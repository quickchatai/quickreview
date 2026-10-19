// What a review round's main session carries on the SDK runtime, so that its
// provider request is the one the process route's `pi` sends (canary 10, full:
// tests/pi-canary/canary-10-oneshot-request.test.ts).
//
// The process route hands pi extension FILES (`--extension`), the cwd's context
// file and a spawn env. An SDK session has none of those, so the same things
// arrive as data and factories:
//
//   extension files          the factories the files' own shims call, built from
//                            the spec's env (bash-guard, ledger-pin,
//                            finding-clusters), in the file order of the proc route
//   the lens tool            a factory the route hands in (`lens`): today's native
//                            one is a file only; the engine's lens tools (P4.5)
//                            take this slot
//   the tool allowlist       pi's defaults plus every tool those extensions
//                            register: pi's CLI activates all of them, and the
//                            host drops anything not named
//   the D34 context stub     the reviewer stub handed as data, at the path pi
//                            would have read it from in the cwd; never read
//                            from, or written into, a checkout
//   the model's bash env     an allowlist over the spec's env, never a GitHub
//                            token (pisdk.ts buildBashEnv)
//
// `roundSdkExtras()` is the `extras` option of `sdkRuntime(host, { extras })`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { bashGuardConfigFromEnv, createBashGuard } from "../../extensions/bash-guard.js";
import {
  FINDING_CLUSTERS_TOOLS,
  createFindingClusters,
} from "../../extensions/finding-clusters.js";
import { createLedgerPin, ledgerPinConfigFromEnv } from "../../extensions/ledger-pin.js";
import { HOST_CONTEXT_STUB, REVIEWER_STUB } from "../reviewerstub.js";
import { DEFAULT_TOOLS } from "./pisdk.js";
import type { SessionSpec } from "./port.js";
import type { SessionExtras } from "./sdkruntime.js";

/** The lens tool of a round: the factories that register it (the native tool is
 * a file's extension) or the definitions handed over as `customTools` (our own,
 * src/engine/lens/engine-tools.ts), and the tool names they add to the allowlist. */
export interface RoundLensTools {
  factories: readonly ExtensionFactory[];
  customTools?: readonly ToolDefinition[];
  toolNames: readonly string[];
}

export interface RoundSdkOptions {
  /** The route's lens tool. Omitted: the session has none. */
  lens?: RoundLensTools;
}

/** The names the model's bash may draw from the spec's env besides the host
 * defaults: the git isolation pins and the QCR_* names the round's scripts read.
 * The proc route's bash saw the whole env; the API keys in it are not carried. */
export const BASH_ENV_ALLOW = ["GIT_*", "QCR_*"] as const;

/** The reviewer stub (D34) as a context file at `<cwd>/AGENTS.override.md`. A
 * checkout keeps it at `deploy/reviewer/`; the release and bench images install
 * it at the tree's root (docker/Dockerfile, bench/aacr/Dockerfile), so both
 * places are tried. A round without the stub fails here, loudly: a context file
 * is never dropped silently. */
export function reviewerStub(root: string, cwd: string): { path: string; content: string } {
  const sources = [join(root, REVIEWER_STUB), join(root, HOST_CONTEXT_STUB)];
  for (const source of sources) {
    try {
      return { path: join(cwd, HOST_CONTEXT_STUB), content: readFileSync(source, "utf8") };
    } catch {
      // try the next place
    }
  }
  throw new Error(`the reviewer context stub is missing at ${sources.join(" and ")}`);
}

/** The per-session pieces of a round's main session on the SDK runtime. */
export function roundSdkExtras(
  options: RoundSdkOptions = {},
): (spec: SessionSpec) => SessionExtras {
  return (spec) => {
    const root = spec.env["QCR_SANDBOX_ROOT"];
    if (root === undefined)
      throw new Error("a round's spec names its production tree (QCR_SANDBOX_ROOT)");
    const lens = options.lens;
    return {
      // The proc route's `--extension` order: bash-guard, ledger-pin, the lens
      // tool, finding-clusters. The tool list in the request follows it.
      extensions: [
        createBashGuard(bashGuardConfigFromEnv(spec.env, spec.cwd)),
        createLedgerPin(ledgerPinConfigFromEnv(spec.env)),
        ...(lens?.factories ?? []),
        createFindingClusters(),
      ],
      tools: [
        ...DEFAULT_TOOLS,
        ...(lens?.toolNames ?? []),
        ...FINDING_CLUSTERS_TOOLS.map((t) => t.name),
      ],
      ...(lens?.customTools?.length ? { customTools: lens.customTools } : {}),
      agentsFiles: [reviewerStub(root, spec.cwd)],
      bashEnv: { allow: BASH_ENV_ALLOW },
    };
  };
}

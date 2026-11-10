// The scan driver's SDK leaves: the leaf runner on the SDK (scanleaves.ts
// `sdkCaseRunner`, the in-process twin of `piCaseRunner`) over a host this
// module builds per case, on the owner's borrowed login.
//
// WHERE IT RUNS. Only in scancli's detached driver, a disposable one-scan
// process (the scan sandbox or the host process `detachDriver` starts), whose
// host this module builds and owns (`scanSdkCases`). The long-lived companion
// pi never imports it: src/scancli.ts loads it on demand, and tests/
// fences-engine.test.ts pins that no extension's import closure reaches it.
// That keeps the SDK's process-global HTTP dispatcher and a frozen loop out of
// the companion (the companion boundary).
//
// AUTH. Each case builds its own host on a fresh read-only copy of the owner's
// login (engineCredentials): a token the companion refreshed mid-scan is
// picked up at the next case, a token the case would not outlive is refused
// before it starts, and nothing is ever refreshed or written here. On the host
// (no container mount), a pi home with no login runs on a provider API key in
// the environment, as `qcr review` and /qcr-scan do: an empty in-memory store
// and the env keys handed to the runtime (`applyEnvApiKeys`). With neither, the
// run stops naming `qcr login`.
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  AuthExpiring,
  RUNTIME_KEY_ENVS,
  SCAN_AUTH_SRC_ENV,
  SCAN_CASE_AUTH_BUDGET_MS,
  applyEnvApiKeys,
  engineCredentials,
  keyOnlyCredentials,
  type RuntimeKeyTarget,
  scanAuthExpiring,
  scanAuthMissing,
} from "@quickchatai/pi-quickreview/src/engine/auth.js";
import { PiHost } from "@quickchatai/pi-quickreview/src/engine/pisdk.js";
import { sdkRuntime } from "@quickchatai/pi-quickreview/src/engine/sdkruntime.js";
import { BUDGET_EXIT_CODE } from "@quickchatai/pi-quickreview/src/engine/budget.js";
import type { CaseRunner } from "@quickchatai/pi-quickreview/src/scan/scanports.js";
import {
  LEAF_TURN_TIMEOUT_MS,
  sdkCaseRunner as sdkCaseRunnerOver,
  type SdkCaseRunnerOptions,
} from "@quickchatai/pi-quickreview/src/scan/scanleaves.js";

export {
  LEAF_TURN_TIMEOUT_MS,
  caseSessionDir,
  type LeafExtras,
  type SdkCaseRunnerOptions,
} from "@quickchatai/pi-quickreview/src/scan/scanleaves.js";

/** `sdkCaseRunner` (scanleaves.ts) in this process: the leaf env filtered
 * from this process's env and a read's `~` taken as this process's home,
 * unless told otherwise. */
export function sdkCaseRunner(
  opts: Omit<SdkCaseRunnerOptions, "env" | "home"> & { env?: NodeJS.ProcessEnv; home?: string },
): CaseRunner {
  return sdkCaseRunnerOver({ ...opts, env: opts.env ?? process.env, home: opts.home ?? homedir() });
}

// ---- the scan driver's host ----------------------------------------------------

export interface ScanSdkCasesOptions {
  agentsDir: string;
  cwd: string;
  transcriptDir?: string;
  /** The driver's env: names the login source (`QCR_SCAN_AUTH_SRC`, else
   * `PI_CODING_AGENT_DIR`, else the home's pi agent dir) and feeds the leaf env. */
  env: NodeJS.ProcessEnv;
  /** A private, absolute directory for the host's own files (models list). Never
   * the operator's pi home. */
  agentDir: string;
  /** Hears an expired or missing login, so the run can stop with the fix. */
  onExpired: (reason: string) => void;
  /** The host a case runs on, built from its credentials. Omitted: a PiHost that
   * owns this process (the driver's) and installs pi's HTTP dispatcher. */
  makeHost?: (o: {
    agentDir: string;
    credentials: ReturnType<typeof engineCredentials>["credentials"];
    /** Hands the runtime the environment's API keys, on the key-only route. */
    configureModels?: (runtime: RuntimeKeyTarget) => Promise<void>;
  }) => Promise<PiHost>;
}

/** The provider key variables set in `env` (RUNTIME_KEY_ENVS). */
function envKeyNames(env: NodeJS.ProcessEnv): string[] {
  return Object.values(RUNTIME_KEY_ENVS).filter((name) => (env[name] ?? "").trim() !== "");
}

/** Why a host scan cannot start with neither a pi login nor an env key. */
export function hostScanAuthMissing(src: string): string {
  return (
    `no pi login at ${src} and no provider API key in the environment ` +
    `(${Object.values(RUNTIME_KEY_ENVS).join(", ")}) — run \`qcr login\`, or set the key`
  );
}

/** Where the borrowed login is read from: the scan container's read-only mount
 * of the companion's agent dir, else the process's own pi agent dir. */
export function scanAuthSource(env: NodeJS.ProcessEnv): string {
  return (
    env[SCAN_AUTH_SRC_ENV]?.trim() ||
    env["PI_CODING_AGENT_DIR"]?.trim() ||
    join(env["HOME"]?.trim() || homedir(), ".pi", "agent")
  );
}

/**
 * The scan driver's SDK leaf runner: `sdkCaseRunner` over a host per case, each
 * on the login's refresh-blanked in-memory copy (engineCredentials). A login
 * that is missing or would expire inside the case stops the run through
 * `onExpired`, and the case is refused having spent nothing.
 */
export function scanSdkCases(o: ScanSdkCasesOptions): CaseRunner {
  if (!isAbsolute(o.agentDir))
    throw new Error(`the SDK host's agentDir must be absolute: ${o.agentDir}`);
  return sdkCaseRunner({
    agentsDir: o.agentsDir,
    home: homedir(),
    cwd: o.cwd,
    ...(o.transcriptDir !== undefined ? { transcriptDir: o.transcriptDir } : {}),
    env: o.env,
    runtime: async (extras) => {
      const src = scanAuthSource(o.env);
      const onHost = !o.env[SCAN_AUTH_SRC_ENV]?.trim();
      const keyOnly = onHost && !existsSync(join(src, "auth.json"));
      let auth: Pick<ReturnType<typeof engineCredentials>, "credentials">;
      try {
        if (keyOnly && envKeyNames(o.env).length === 0)
          throw new AuthExpiring(hostScanAuthMissing(join(src, "auth.json")), { code: "missing" });
        auth = keyOnly
          ? { credentials: keyOnlyCredentials() }
          : engineCredentials({
              srcDir: src,
              // In the scan container the driver's login wrapper ends a case at the case
              // budget; on the host nothing does, so the login must cover the turn's
              // whole wall clock.
              needMs: o.env[SCAN_AUTH_SRC_ENV]?.trim()
                ? SCAN_CASE_AUTH_BUDGET_MS
                : LEAF_TURN_TIMEOUT_MS,
              words: { missing: scanAuthMissing, expiring: scanAuthExpiring },
            });
      } catch (err) {
        if (err instanceof AuthExpiring) o.onExpired(err.message);
        throw err;
      }
      mkdirSync(o.agentDir, { recursive: true, mode: 0o700 });
      // A custom provider list lives next to the login; the host reads its own copy.
      const models = join(src, "models.json");
      const hostModels = join(o.agentDir, "models.json");
      if (existsSync(models)) copyFileSync(models, hostModels);
      else rmSync(hostModels, { force: true });
      const configureModels = keyOnly
        ? async (runtime: RuntimeKeyTarget): Promise<void> => {
            await applyEnvApiKeys(runtime, o.env);
          }
        : undefined;
      const host = await (o.makeHost
        ? o.makeHost({
            agentDir: o.agentDir,
            credentials: auth.credentials,
            ...(configureModels ? { configureModels } : {}),
          })
        : PiHost.create({
            agentDir: o.agentDir,
            ownsProcess: true,
            homeDir: homedir(),
            credentials: auth.credentials,
            ...(configureModels ? { configureModels } : {}),
          }));
      // The case driver owns its process: a turn its abort and dispose did not
      // end exits it (packages/pi-plugin/src/engine/budget.ts).
      return sdkRuntime(host, { extras, backstop: () => process.exit(BUDGET_EXIT_CODE) });
    },
  });
}

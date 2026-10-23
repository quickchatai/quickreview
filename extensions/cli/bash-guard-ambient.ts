// bash-guard's checkers with the process as their default context: the cwd,
// the env and the secrets dirs of THIS process, where packages/pi-plugin/extensions/bash-guard.ts
// takes them as arguments. Exported checkers that a test or a tool calls with
// no policy of its own come here; a session's guard is built from an explicit
// config (createBashGuard).
import {
  bashGuardConfigFromEnv as configFromEnv,
  checkBashCommand as checkBash,
  checkProcSecrets as checkProc,
  checkReadPath as checkRead,
  checkSecretPaths as checkSecrets,
  defaultSecretPathContext as secretContext,
  guardFlagsFromEnv,
  type BashCheck,
  type GuardPolicy,
  type SecretPathContext,
} from "@quickchatai/pi-quickreview/extensions/bash-guard.js";

let cachedSecretDirs: SecretPathContext | null = null;
/** The live process's context: dirs resolved once, the cwd read every call. */
function processSecretContext(): SecretPathContext {
  cachedSecretDirs ??= secretContext(process.env, process.cwd());
  return { ...cachedSecretDirs, cwd: process.cwd() };
}

/** The policy the process describes, read at each call: what the checkers use
 * when a caller passes none, so a test (or tool) that sets QCR_SANDBOX_ROOT or
 * QCR_REPLAY sees it at once. The secrets dirs are resolved once. */
function ambientPolicy(): GuardPolicy {
  const { cwd: _cwd, ...secrets } = processSecretContext();
  return {
    ...guardFlagsFromEnv(process.env, process.cwd()),
    cwd: process.cwd(),
    secrets,
  };
}

export function checkBashCommand(
  cmd: string,
  depth = 0,
  cwd: string | null = process.cwd(),
  policy: GuardPolicy = ambientPolicy(),
): BashCheck {
  return checkBash(cmd, depth, cwd, policy);
}

export function checkProcSecrets(cmd: string, cwd: string = process.cwd()): BashCheck {
  return checkProc(cmd, cwd);
}

export function checkSecretPaths(cmd: string, ctx?: SecretPathContext): BashCheck {
  return checkSecrets(cmd, ctx ?? processSecretContext());
}

export function checkReadPath(path: string, ctx?: SecretPathContext): BashCheck {
  return checkRead(path, ctx ?? processSecretContext());
}

export function defaultSecretPathContext(
  env: Readonly<Record<string, string | undefined>> = process.env,
  cwd: string = process.cwd(),
): SecretPathContext {
  return secretContext(env, cwd);
}

export function bashGuardConfigFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
  cwd: string = process.cwd(),
) {
  return configFromEnv(env, cwd);
}

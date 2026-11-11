// The environment a worker process is given. Its own module, importing only the
// credential names to drop, so the daemon's supervisor and the `qcr model` verb
// (a route that must not reach the state store) build the same environment.

import { GITHUB_TOKEN_ENVS } from "@quickchatai/pi-quickreview/src/envstrip.js";

/** The env names a worker process may inherit from the daemon. Everything else is
 * dropped, whatever the daemon's own env holds: a worker carries the daemon's
 * locale, path and proxies, the tool-uid split the image arranged (the worker
 * reads them to run the model's tools under it), and nothing that is a secret. */
export const WORKER_ENV_ALLOW: readonly string[] = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "TERM",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "PI_CODING_AGENT_DIR",
  // The separate tool uid (packages/pi-plugin/src/engine/tooluid.ts TOOL_UID_ENVS; named here
  // because the daemon never imports src/engine/).
  "QCR_TOOL_UID",
  "QCR_TOOL_GID",
  "QCR_TOOL_UID_REQUIRED",
  "QCR_ALLOW_SHARED_TOOL_UID",
  // The bot's setid helper, which the worker reaches the tool uid through
  // (tooluid.ts setidHelperOf): a path, no secret.
  "QCR_SETPRIV_BIN",
];

/** The env of one worker process: the model environment of the secrets dir
 * (`model`: a provider's key and settings by pi's own names, where the worker's
 * pi looks for them), the allowlisted part of the daemon's env, the daemon's
 * explicit additions, and the IPC names (the fd NUMBER, never the capability).
 * A model variable replaces nothing: one named like an allowlisted name or an
 * IPC name is left out, and everything after it is written over it. A GitHub
 * credential is dropped last, by name, so no addition can carry one in. */
export function workerProcessEnv(
  parent: NodeJS.ProcessEnv,
  extra: Readonly<Record<string, string>>,
  ipc: Readonly<Record<string, string>>,
  model: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(model))
    if (!WORKER_ENV_ALLOW.includes(name) && !name.startsWith("QCR_IPC_")) env[name] = value;
  for (const name of WORKER_ENV_ALLOW) {
    const value = parent[name];
    if (value !== undefined && value !== "") env[name] = value;
  }
  for (const [name, value] of Object.entries(extra))
    if (!name.startsWith("QCR_IPC_")) env[name] = value;
  Object.assign(env, ipc);
  for (const name of GITHUB_TOKEN_ENVS) delete env[name];
  return env;
}

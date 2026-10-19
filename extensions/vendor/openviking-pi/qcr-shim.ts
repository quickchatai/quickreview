// QCR FORK — file added by PATCH 12 (createOpenViking). Not upstream.
//
// The shim: everything the extension used to take from the process, in one
// place, so that `createOpenViking(cfg)` (index.ts) reads no environment, no
// argv, no working directory and no home directory. A tmux pi reaches the
// factory through the default export, which calls `openVikingConfigFromProcess`
// below; an SDK session builds the same `OpenVikingConfig` from its own values
// and attaches `createOpenViking(cfg)` as an extension factory.
//
// Moved here, unchanged in effect:
//   * the env overlay that sat in config.ts's `loadConfig` (`envOverlay`);
//   * the pending queue's directory, home-directory default and limits, which
//     shared/pending-queue.mjs used to read itself (`pendingQueueFromEnv`);
//   * the leaf decision, from argv (qcr-leaf.ts keeps the function, only this
//     file calls it) and from QCR_OV_LEAF;
//   * the daemon's per-session hand-offs: the OV session id, the retired-URI
//     file, the recall-hint file, the debug log, and the reviewer key.
//
// Pure functions of their arguments, so tests/openviking-fork.test.ts calls
// them (`index.ts` cannot be imported from a test).
import { homedir } from "node:os";
import { join } from "node:path";
import { envBool, loadConfig, type OVConfig } from "./config.js";
import type { OVClient } from "./client.js";
import { isLeafProcess } from "./qcr-leaf.js";
import { resolveExtraNamespaces, type NamespaceCredentials } from "./qcr-namespaces.js";
import { RETIRED_FILE_ENV } from "./qcr-recall.js";
import { RECALL_HINT_FILE_ENV } from "./qcr-hint.js";
import type { HookName } from "./qcr-hooks.js";
import type { PendingQueueConfig } from "./shared/pending-queue.mjs";

type Env = Record<string, string | undefined>;

/** Everything `createOpenViking` needs. A value, not a process. */
export interface OpenVikingConfig {
  /** The resolved extension config (config.json merged with credentials and the overlay). */
  config: OVConfig;
  /** A pi-subagents leaf: tools only, nothing ambient, no second namespace. */
  leaf: boolean;
  /** Namespaces reachable besides the own one (the companion's reviewer key). */
  extraNamespaces: NamespaceCredentials[];
  /** The OPENVIKING_* names the credential re-reader resolves from after an auth failure. */
  credentialEnv: Env;
  /** The OV session id the daemon created; "" when there is none. */
  sessionId: string;
  /** The working directory, for the bypass patterns. */
  cwd: string;
  /** The daemon's retired-URI file; re-read for every recall. */
  retiredFile?: string;
  /** The daemon's recall-hint file; re-read for every prompt and tool call. */
  recallHintFile?: string;
  /** Debug log file; none by default. */
  debugLogFile?: string;
  /** The offline queue's settings. */
  pendingQueue: PendingQueueConfig;
  /** Per-hook deadline overrides (qcr-hooks.ts HOOK_TIMEOUT_MS has the defaults). */
  hookTimeoutMs?: Partial<Record<HookName, number>>;
  /** Test seam: builds the client. Production passes nothing. */
  makeClient?: (config: OVConfig) => OVClient;
}

/** The names the credential resolver and the root-key guard read. */
function credentialEnvOf(env: Env): Env {
  return Object.fromEntries(
    Object.entries(env).filter(([k]) => k.startsWith("OPENVIKING_")),
  );
}

/** The env overlay that `loadConfig` applied between the file merge and the
 * clamps. (Its first five lines repeated what the credential resolver had
 * already taken from the same env, and are not carried over.) */
export function envOverlay(env: Env): (config: OVConfig) => void {
  return (config) => {
    if (env.OPENVIKING_WORKSPACE_PEER !== undefined) {
      config.workspacePeer = envBool(env.OPENVIKING_WORKSPACE_PEER, config.workspacePeer);
    }
    if (env.OPENVIKING_RECALL_PEER_SCOPE) {
      config.recallPeerScope = env.OPENVIKING_RECALL_PEER_SCOPE === "actor" ? "actor" : "all";
    }
    if (env.OPENVIKING_RECALL_LIMIT) {
      config.recallLimit = Number(env.OPENVIKING_RECALL_LIMIT);
      config.recallLimitConfigured = true;
    }
    if (env.OPENVIKING_RECALL_QUERY_EXPANSION) {
      config.recallQueryExpansion = env.OPENVIKING_RECALL_QUERY_EXPANSION === "off" ? "off" : "auto";
      config.recallQueryExpansionConfigured = true;
    }
  };
}

/** The offline queue's settings, as pending-queue.mjs used to read them. */
export function pendingQueueFromEnv(env: Env, home: string): PendingQueueConfig {
  const int = (name: string): number => parseInt(env[name] || "", 10);
  const retries = int("OPENVIKING_PENDING_MAX_RETRIES");
  const ttl = int("OPENVIKING_PENDING_TTL_DAYS");
  const limit = int("OPENVIKING_PENDING_REPLAY_LIMIT");
  return {
    dir: env.OPENVIKING_PENDING_DIR || join(home, ".openviking", "pending"),
    maxRetries: Number.isFinite(retries) && retries >= 0 ? retries : undefined,
    ttlDays: Number.isFinite(ttl) && ttl >= 0 ? ttl : undefined,
    replayLimit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
  };
}

export interface ShimInput {
  env: Env;
  argv: readonly string[];
  cwd: string;
  home: string;
  /** The directory holding config.json (the extension's own). */
  extensionDir: string;
}

/** Turns a pi process's surroundings into the factory's config. */
export function openVikingConfigFromEnv(input: ShimInput): OpenVikingConfig {
  const { env, argv, cwd, home } = input;
  const leaf = isLeafProcess(argv, env);
  const config = loadConfig(input.extensionDir, { env, cwd, overlay: envOverlay(env) });
  return {
    config,
    leaf,
    extraNamespaces: leaf ? [] : resolveExtraNamespaces(config, env),
    credentialEnv: credentialEnvOf(env),
    sessionId: (env.OPENVIKING_SESSION_ID ?? env.QCR_OV_SESSION_ID ?? "").trim(),
    cwd,
    retiredFile: env[RETIRED_FILE_ENV],
    recallHintFile: env[RECALL_HINT_FILE_ENV],
    debugLogFile: env.OV_DEBUG_LOG,
    pendingQueue: pendingQueueFromEnv(env, home),
  };
}

/** The default export's one call: the live process, read once. */
export function openVikingConfigFromProcess(extensionDir: string): OpenVikingConfig {
  return openVikingConfigFromEnv({
    env: process.env,
    argv: process.argv,
    cwd: process.cwd(),
    home: homedir(),
    extensionDir,
  });
}

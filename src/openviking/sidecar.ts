// The memory sidecar's process tree: what the daemon supervises in-container
// under `[openviking] endpoint = "local"`, run by the memory image instead
// (docker/memory/).
//
// ONE IMPLEMENTATION, THREE CALLERS. The server, the local embedder and the
// re-embed driver are the same classes the daemon builds in src/wire.ts, with
// the same start gate, restart ladder and health loop. The sidecar differs in
// three settings only: the config is forced to `local` (this process IS the
// endpoint the daemon's `remote` points at), the server binds the container
// network's interfaces (`QCR_OPENVIKING_BIND_HOST`, default 0.0.0.0) while
// its own probes stay on loopback, and the re-embed driver runs here because
// the store and its journal live on this container's volume.
//
// The boot steps that need no live server (ov.conf render, the embedder
// migration's `prepare`, user provisioning) run in docker/memory/entrypoint.sh
// before this starts, exactly as they do in the daemon's entrypoint. Nothing
// here ever wipes a store.
import { join } from "node:path";
import type { OpenVikingConfig } from "../config.js";
import { EMBEDDER_GATE_MAX_WAIT_MS, LocalEmbedderSupervisor } from "./embedder.js";
import { ReembedDriver, type ReembedDriverDeps } from "./reembed.js";
import { OpenVikingSupervisor, type SupervisorDeps } from "./supervisor.js";
import type { OpenVikingStatus } from "./types.js";

/** What the daemon's `remote` config names, seen from the sidecar's own side:
 * a local endpoint, probed on loopback. */
export function sidecarConfig(cfg: OpenVikingConfig): OpenVikingConfig {
  return { ...cfg, endpoint: "local", host: "127.0.0.1" };
}

export interface SidecarDeps {
  cfg: OpenVikingConfig;
  /** The app root — where `scripts/` lives. */
  repoRoot: string;
  /** The secrets mount holding the reviewer USER key the re-embed carries. */
  secretsDir: string;
  /** Address the server binds. */
  bindHost: string;
  log: (msg: string, extra?: unknown) => void;
  /** Test seams, forwarded to the supervisors. */
  spawn?: SupervisorDeps["spawn"];
  fetchFn?: SupervisorDeps["fetchFn"];
  exists?: SupervisorDeps["exists"];
  schedule?: SupervisorDeps["schedule"];
  readOvConf?: () => string | null;
  reembedLoad?: ReembedDriverDeps["load"];
  reembedFetch?: ReembedDriverDeps["fetchFn"];
}

export interface Sidecar {
  status(): OpenVikingStatus;
  stop(): Promise<void>;
}

export function startSidecar(deps: SidecarDeps): Sidecar {
  const cfg = sidecarConfig(deps.cfg);
  const seams = {
    ...(deps.spawn ? { spawn: deps.spawn } : {}),
    ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
    ...(deps.exists ? { exists: deps.exists } : {}),
    ...(deps.schedule ? { schedule: deps.schedule } : {}),
  };
  const embedder = new LocalEmbedderSupervisor({
    cfg,
    repoRoot: deps.repoRoot,
    log: deps.log,
    ...seams,
    ...(deps.readOvConf ? { readOvConf: deps.readOvConf } : {}),
  });
  embedder.start();
  const server = new OpenVikingSupervisor({
    cfg,
    log: deps.log,
    bindHost: deps.bindHost,
    startGate: {
      open: () => embedder.gateOpen(),
      maxWaitMs: EMBEDDER_GATE_MAX_WAIT_MS,
      what: "the local embedder",
    },
    ...seams,
  });
  server.start();
  const reembed = new ReembedDriver({
    cfg,
    repoRoot: deps.repoRoot,
    keyPath: join(deps.secretsDir, cfg.reviewer_key_file),
    ready: () => server.status().ready,
    log: deps.log,
    ...(deps.schedule ? { schedule: deps.schedule } : {}),
    ...(deps.reembedLoad ? { load: deps.reembedLoad } : {}),
    ...(deps.reembedFetch ? { fetchFn: deps.reembedFetch } : {}),
  });
  reembed.start();
  return {
    status: () => ({
      ...server.status(),
      reembed: reembed.status(),
      embedder: embedder.status(),
    }),
    async stop() {
      reembed.stop();
      await server.stop();
      await embedder.stop();
    },
  };
}

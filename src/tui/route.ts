// The TUI's route — which daemon the board reads, and how — resolved ONCE,
// before the first frame, from config.toml's [tui] block plus three local
// facts that cost no docker, network or directory walk: the compose
// project's `.env`, the onboarding checklist, and whether this user can open
// the Docker socket without sudo.
//
// Why a resolution step at all. `[tui]` ships VM-shaped defaults (target
// "ssh", sudo docker, the VM host's state path), and on one box a fresh
// install opens the TUI before onboarding's config_fill has written its
// local values — or with a hand-written config that never names them. Every
// builder in remote.ts reads the config it is handed, and the transport is
// still decided by the explicit `target` knob alone (`transportOf`); this
// module only decides which config that is, and says so once when it departs
// from the file:
//
//   * `target = "ssh"` with an EMPTY `ssh_host` cannot reach anything. When
//     this checkout is a compose project (the checklist recorded the local
//     topology, or none was recorded and the project `.env` pins a release)
//     the route is the local stack, said once; otherwise the route is
//     `unconfigured` and every surface shows the one precise remedy instead
//     of an ssh command with no host in it.
//   * On the local route the state dir is the release image's
//     (`/opt/qcr/state`, the compose `qcr-state` volume) whenever the knob
//     still holds the VM default, the daemon's `-daemon-N` container implies
//     its `-memory-N` sidecar for the memory forward, and sudo is dropped
//     when the socket answers this user without it (a non-interactive
//     `sudo docker` behind the alt screen can only fail).
//
// An operator's explicit, non-default value always wins: nothing here
// overwrites a value the file states differently from the shipped default.
import { accessSync, constants, readFileSync } from "node:fs";
import { join } from "node:path";
import { TUI_DEFAULTS, type TuiConfig } from "../config.js";
import { readChecklist, type ChecklistFile } from "../onboard/engine.js";
import { CHOICE_KEYS } from "../onboard/choices.js";
import { NO_SSH_HOST_STDERR } from "./remote.js";

/** The release image's state dir inside the daemon container (the compose
 * `qcr-state` volume; src/onboard/steps/ingress.ts CONTAINER_STATE_DIR). */
export const RELEASE_STATE_DIR = "/opt/qcr/state";

/** The bundled compose project's daemon and memory containers
 * (docker-compose.yml `name: quickreview`). */
export const COMPOSE_DAEMON_CONTAINER = "quickreview-daemon-1";
export const COMPOSE_MEMORY_CONTAINER = "quickreview-memory-1";

/** The legacy daemon container (no `qcr.layout` label): the one container whose
 * in-container state dir is still the VM-shaped default. */
const LEGACY_CONTAINER = "quickreview-sandbox";

export interface RouteFacts {
  /** The compose project directory (this checkout): remedy text names it. */
  projectDir: string;
  /** `<project>/.env`, or null when there is none. */
  projectEnv: string | null;
  /** The onboarding checklist, or null when absent or unreadable. */
  checklist: ChecklistFile | null;
  /** Can this user open the Docker socket without sudo? undefined = no socket
   * found to ask (no local Docker, or a remote DOCKER_HOST). */
  dockerSocketAccess: boolean | undefined;
}

export interface TuiRoute {
  /** The config every TUI remote op is built from. */
  cfg: TuiConfig;
  /** One-time lines for the notice line: where the route departs from the file. */
  notes: string[];
  /** Set when nothing can be reached: the precise reason and remedy, shown in
   * place of any ssh diagnosis. */
  unconfigured?: string;
}

/** The precise message for `target = "ssh"` with no host and no local stack —
 * the same words the ssh runner answers an empty host with. */
export const EMPTY_SSH_HOST = NO_SSH_HOST_STDERR;

/** `QCR_VERSION=` from a project `.env` — "" when absent. */
export function pinnedVersion(envText: string | null): string {
  if (envText === null) return "";
  const m = /^QCR_VERSION=(.*)$/m.exec(envText);
  return m ? (m[1] ?? "").trim().replace(/^["']|["']$/g, "") : "";
}

/** The recorded topology, or null when the checklist recorded none. */
function recordedTopology(checklist: ChecklistFile | null): "local" | "vm" | null {
  const raw = checklist?.choices[CHOICE_KEYS.topology];
  return raw === "local" || raw === "vm" ? raw : null;
}

/** The `-memory-N` sidecar a compose `-daemon-N` container implies, or "". */
export function composeMemoryFor(container: string): string {
  const m = /^(.+)-daemon-(\d+)$/.exec(container);
  return m ? `${m[1]}-memory-${m[2]}` : "";
}

/** Pure: the effective [tui] config for these facts. */
export function resolveTuiRoute(file: TuiConfig, facts: RouteFacts): TuiRoute {
  const notes: string[] = [];
  let cfg: TuiConfig = { ...file };
  if (cfg.target === "ssh" && cfg.ssh_host.trim() === "") {
    const topology = recordedTopology(facts.checklist);
    const composeProject = pinnedVersion(facts.projectEnv) !== "";
    if (topology === "local" || (topology === null && composeProject)) {
      cfg = {
        ...cfg,
        target: "local",
        container:
          cfg.container === TUI_DEFAULTS.container ? COMPOSE_DAEMON_CONTAINER : cfg.container,
      };
      notes.push(
        `[tui] target is "ssh" with no ssh_host — reading the local compose stack in ${facts.projectDir} instead ` +
          '(set [tui] target = "local" to make it explicit)',
      );
    } else {
      return {
        cfg,
        notes,
        unconfigured:
          topology === "vm"
            ? "[tui] ssh_host is empty — set it to the VM's ssh alias in config.toml"
            : EMPTY_SSH_HOST,
      };
    }
  }
  if (cfg.target !== "local") return { cfg, notes };
  if (cfg.remote_state_dir === TUI_DEFAULTS.remote_state_dir && cfg.container !== LEGACY_CONTAINER)
    cfg = { ...cfg, remote_state_dir: RELEASE_STATE_DIR };
  if ((cfg.memory_container ?? "").trim() === "") {
    const memory = composeMemoryFor(cfg.container);
    if (memory !== "") cfg = { ...cfg, memory_container: memory };
  }
  if (cfg.sudo_docker && facts.dockerSocketAccess === true) cfg = { ...cfg, sudo_docker: false };
  return { cfg, notes };
}

/** The Docker socket this process would talk to: `DOCKER_HOST` when it is a
 * unix socket, the default path otherwise; undefined for a remote daemon. */
export function dockerSocketPath(env: NodeJS.ProcessEnv): string | undefined {
  const host = (env["DOCKER_HOST"] ?? "").trim();
  if (host === "") return "/var/run/docker.sock";
  return host.startsWith("unix://") ? host.slice("unix://".length) : undefined;
}

/** One `access(2)` on the socket — no docker call, no walk. */
export function probeSocketAccess(
  path: string | undefined,
  access: (p: string, mode: number) => void = accessSync,
): boolean | undefined {
  if (path === undefined) return undefined;
  try {
    access(path, constants.R_OK | constants.W_OK);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EACCES" || code === "EPERM" ? false : undefined;
  }
}

/** The facts, read from this checkout: two small files and one access(2). */
export function readRouteFacts(root: string, env: NodeJS.ProcessEnv = process.env): RouteFacts {
  let projectEnv: string | null = null;
  try {
    projectEnv = readFileSync(join(root, ".env"), "utf8");
  } catch {
    projectEnv = null;
  }
  return {
    projectDir: root,
    projectEnv,
    checklist: readChecklist(join(root, "state")),
    dockerSocketAccess: probeSocketAccess(dockerSocketPath(env)),
  };
}

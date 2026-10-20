// Local companion container lifecycle.
//
// The shape mirrors remote.ts: command construction is pure so tests can assert
// the exact argv, execution goes through one injectable runner, and nothing
// here ever kills anything the user did not explicitly ask to stop.
//
// Lifecycle contract:
//   `qcr tui` start → adopt a running container, else `docker start`, else
//   `docker run` it. Quit → `docker stop` (conversation, pihome auth and
//   the pi home survive on volumes; next start is a fast resume). TUI crash →
//   the container keeps running and the next start adopts it. A second
//   concurrent TUI attaches to the same container, never spawns a twin:
//   ensureUp() and spawnPi() are both idempotent. A container goes away only
//   on the explicit `qcr companion down`, or when ensureUp() recreates one
//   whose mounts or DNS drifted from runArgv() or that can no longer start —
//   the conversation and the pi home survive both on their volumes.
import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import {
  companionConfigMirrorDir,
  CONFIG_FILE,
  companionGithubDir,
  configHome,
  KEYS_FILE,
  legacySecretsDir,
  locateConfig,
  locateKeysFile,
  PORTRAIT_DIR,
  PROFILES_DIR,
  stateHome,
  type InstallEnv,
} from "../install.js";
import type { CompanionConfig } from "../config.js";
import { appStamp } from "../appstamp.js";
import { TOKEN_FILE } from "./ghread.js";

export interface DockerResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

/** Runs `docker <argv…>`. Injectable — tests never spawn docker. */
export type DockerRunner = (argv: string[], opts?: { timeoutMs?: number }) => Promise<DockerResult>;

export interface ContainerStatus {
  exists: boolean;
  running: boolean;
  /** `dest -> source` for every mount the container was created with; empty
   * when it does not exist or docker could not be asked. */
  mounts: Map<string, string>;
  /** Set when docker could not be asked (daemon down, permission denied):
   * `exists`/`running` are then false by default, not by observation. Absent
   * when the inspect succeeded or docker said the container does not exist. */
  unknown?: string;
}

/** The one word `qcr companion status` prints — "unknown — <why>" when docker
 * could not be asked, so a failed inspect never reads as a confirmed absence. */
export function companionStateWord(st: ContainerStatus): string {
  if (st.unknown !== undefined) return `unknown — docker inspect failed: ${st.unknown}`;
  return st.running ? "running" : st.exists ? "stopped" : "absent";
}

/**
 * The companion's resolvers, pinned at `docker run`. Without this, docker's
 * embedded DNS forwards to whatever upstream the host had at container
 * creation — and that upstream is network-specific, so the first network
 * change after a long-lived start leaves every lookup dead (pi: "Error: fetch
 * failed" on all model calls). Public resolvers are identical on every
 * network, and the companion needs no LAN names: it talks to public endpoints
 * and to the memory bridge by IP.
 */
export const PUBLIC_DNS = ["1.1.1.1", "8.8.8.8"];

/** The filesystem facts the lifecycle needs. Injectable so argv tests stay
 * hermetic; the real one is plain node:fs. */
export interface CompanionFs {
  exists(path: string): boolean;
  /** File text, or undefined when it cannot be read. */
  read(path: string): string | undefined;
  /** Unix mode bits of a file, or undefined. */
  mode(path: string): number | undefined;
}

export const realCompanionFs: CompanionFs = {
  exists: (p) => existsSync(p),
  read: (p) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return undefined;
    }
  },
  mode: (p) => {
    try {
      return statSync(p).mode & 0o777;
    } catch {
      return undefined;
    }
  },
};

/** In-container paths. Fixed by the image (docker/Dockerfile, run in its
 * `companion` mode), so they are constants rather than knobs — the host side
 * of each is configured. */
export const CONTAINER = {
  /** The release image's fixed HOME (`ENV HOME` in docker/Dockerfile),
   * writable by whatever uid the container runs as. */
  home: "/home/qcr",
  piHome: "/home/qcr/.pi",
  /** The image's app root: the companion's extensions, its system prompt and
   * its agent set are loaded from here (D20), never from the /workspace
   * mount, so a change to them lands with `qcr companion rebuild`. */
  app: "/opt/qcr",
  /** The owner's checkout, read-write: the repo the companion works on and
   * commits to. It is the working directory, and the data it is about — not
   * where its code comes from. */
  workspace: "/workspace",
  tracker: "/tracker",
  /** The tracker's protocol docs, read-only. `/tracker` carries the
   * issues; the doc that says how to write them lives one level up on the
   * host, outside every other mount. */
  trackerDocs: "/tracker-docs",
  /** The reviewed repo, read-only. The companion reads the code a
   * review is about; `:ro` is the whole guarantee that it can never touch that
   * repo's `master`. Mounted only when the host checkout exists — a missing
   * one leaves the companion under-equipped, never broken. A generic path:
   * the container path is not the place a repo's name belongs. */
  reviewedRepo: "/reviewed-repo",
  /** The install's config home, in part: `profiles/` read-write — setup
   * writes and re-tunes the repo profile there — `portrait/` read-write (the
   * portrait narrative), and a mirror of the live `config.toml` read-only.
   * Deliberately not the whole home: it holds
   * `secrets/` (the App's private key, which can write to GitHub), and the
   * companion's reach into GitHub is the read-only token below and nothing
   * else. Mounting the two pieces rather than masking a subdirectory is what
   * keeps a `secrets/` created later out as well. */
  configHome: "/qcr-config",
  /** Inside `configHome`: the profiles dir (`:rw`) and a read-only mirror of
   * the live config (`configLive`, a directory mount). The live config is not
   * bind-mounted as a file: a file bind pins the inode, and every writer of
   * config.toml (the onboarding wizard, most editors) replaces it by rename —
   * the companion would read the old text until the container was recreated,
   * and no drift check can see it (the source path never changes). The host
   * copies the located config into the mirror dir instead
   * (`syncConfigMirror`), and a rename inside a mounted dir is visible.
   * Spelled out so the in-container paths are literals — nothing here builds
   * a host config path (the locator does). */
  configLive: "/qcr-config/live",
  configFile: "/qcr-config/live/config.toml",
  profiles: "/qcr-config/profiles",
  /** Inside `configHome`: the repo portrait's narrative (`:rw`) —
   * setup writes it there, keeping the one it replaced. */
  portrait: "/qcr-config/portrait",
  /** The install's state home, read-write: the survey, the scan
   * ledger, findings and the portrait facts — PC-only, never shipped. */
  stateHome: "/qcr-state",
  /** The down-scoped read-only GitHub token, as an env file the host re-mints
   * before it expires (`src/tui/ghread.ts`). `:ro` — the file is the
   * host's to write; the token itself cannot write to GitHub either way. */
  githubRead: "/github-read",
  /** Finished-round evidence, read-only. The TUI holds the VM access and
   * copies each finished round's artefacts down here; the companion reads
   * plain files. That is the whole of the transport — it grants no ssh, no
   * credential and no network reach (root CLAUDE.md rule 8).
   * `:ro` because this is a record: read history, never rewrite it. */
  evidence: "/evidence",
  feed: "/feed",
  alerts: "/alerts",
  /** The shared tmux-socket volume (`tmux-socket` mode, D35): the companion's
   * tmux server listens inside it, and the containerised TUI mounts the same
   * volume to drive that server with `tmux -S`. The image creates the dir
   * 1777, so a fresh named volume is writable by whatever uid runs. */
  tmuxDir: "/run/qcr-tmux",
} as const;

/** How the companion's tmux server is reached.
 *
 *   docker        `docker exec <container> tmux …`, the server on tmux's
 *                 default socket inside the container. The clone route, where
 *                 this process can run docker.
 *   tmux-socket   the server listens on a socket in a named volume that the
 *                 containerised TUI shares (D35), so the TUI drives it with
 *                 `tmux -S <socket>` and holds no docker.sock. The container
 *                 itself is run by the host wrapper (scripts/qcr-host.sh),
 *                 from the argv `qcr companion plan` prints. */
export type CompanionMode = "docker" | "tmux-socket";

/** The named volume holding the companion's tmux socket. */
export function tmuxVolume(cfg: Pick<CompanionConfig, "container_name">): string {
  return `${cfg.container_name}-tmux`;
}

/** The companion's tmux server socket, the same path in both containers. */
export function tmuxSocketPath(cfg: Pick<CompanionConfig, "session">): string {
  return `${CONTAINER.tmuxDir}/${cfg.session}.sock`;
}

/** Set on the companion container in `tmux-socket` mode: the socket its
 * entrypoint starts the tmux server on (docker/entrypoint.sh). */
export const TMUX_SOCKET_ENV = "QCR_TMUX_SOCKET";

/** The companion's ssh access to the VM (root CLAUDE.md rule 8: full ssh, so
 * it may deploy). Exactly three host
 * sources, each read-only and each only when the host has it: the ssh agent's
 * socket, the ssh config and `known_hosts` — the shape the containerised TUI
 * gets (D35). Never `~/.ssh` whole, never a private key file, never
 * `docker.sock`: the keys stay in the host's agent. */
export const SSH = {
  agent: "/run/qcr-ssh-agent",
  config: `${CONTAINER.home}/.ssh/config`,
  knownHosts: `${CONTAINER.home}/.ssh/known_hosts`,
} as const;

/** In `tmux-socket` mode this process sees none of the host's files, so the
 * host wrapper checks the three ssh sources itself and names the present ones
 * in these env vars (scripts/qcr-host.sh); the planner mounts what they name. */
export const HOST_SSH_ENV = {
  agent: "QCR_HOST_SSH_AUTH_SOCK",
  config: "QCR_HOST_SSH_CONFIG",
  knownHosts: "QCR_HOST_SSH_KNOWN_HOSTS",
} as const;

/** The host's ssh sources the companion is given, present ones only. */
export interface SshSources {
  agent?: string;
  config?: string;
  knownHosts?: string;
}

/** An absolute single-line path, else undefined. */
function hostPath(v: string | undefined): string | undefined {
  const t = (v ?? "").trim();
  return t !== "" && isAbsolute(t) && !/[\n\r]/.test(t) ? t : undefined;
}

/** How long a containerised TUI waits for the wrapper-run companion's tmux
 * server (the wrapper starts the container just before it starts the TUI). */
const WRAPPER_START_WAIT_MS = 20_000;

export type EnsureOutcome = "adopted" | "started" | "created" | "recreated";

/** The vendored patched OpenViking pi extension, relative to the app root. */
const VENDOR_EXTENSION = "extensions/vendor/openviking-pi/index.ts";

// ---- the memory forward -----------------------------------------------------

/**
 * Constants of the host-owned memory path. Memory never rides ssh:
 * a systemd --user forward on the owner's PC listens on a docker bridge the
 * companion is attached to and relays to OpenViking inside the VM container.
 *
 * The subnet is fixed so the gateway address is knowable before the network
 * exists; `resolveMemoryWiring()` still asks docker for the real gateway and
 * only falls back to this constant.
 */
export const MEMORY = {
  /** User-defined docker bridge shared by the forward and the companion. */
  network: "qcr-memory",
  subnet: "198.51.100.0/24",
  gateway: "198.51.100.1",
  /** Same port the server listens on in the VM container ([openviking] port). */
  port: 1933,
  /** The OpenViking user whose memory the companion owns — becomes the
   * `X-OpenViking-User` header on every request it makes. */
  user: "companion",
  /** Peer id the patched extension reports (`X-OpenViking-Actor-Peer`);
   * verified to override the path-derived default. Same
   * identity as `user` for the companion — one surface, one actor. */
  peerId: "companion",
  /** The vendored patched OpenViking pi extension, inside the image. */
  extension: `${CONTAINER.app}/${VENDOR_EXTENSION}`,
  /** The companion namespace's retired URIs, relative to the state home.
   * The TUI's memory store publishes them there on the host
   * (no daemon sweeps the companion's tree); the extension's per-turn recall
   * reads them from the mount (`QCR_OV_RETIRED_FILE`, set in `piEnvPrefix`)
   * and sends them as `exclude_uris`, so a retired companion memory is never
   * recalled — not only one whose own text still opens with the tag. */
  retiredFile: "openviking/companion-retired-uris.json",
} as const;

/** The companion's lens tools (`lens`, `lens_wave`; extensions/lens.ts), which
 * stand where pi's example subagent extension used to. They run a lens pass as
 * an SDK session of the companion's own pi process, over its own login and
 * reusing pi's HTTP dispatcher, and read their agents from the agents dir
 * under pi's agent dir, which the entrypoint links at the companion agent set
 * (explore/evidence/study, docker/companion/agents in the image). A lens
 * session is never given a lens tool (leaves, rule 9), and there is no cwd or
 * scope knob to pin: the tool takes `{agent, task}` and nothing else. */
export const LENS = {
  extension: `${CONTAINER.app}/extensions/lens.ts`,
  /** The companion's process-wide pass cap: 8, because a survey or scan fans
   * out one case per unit. Rides `QCR_SUBAGENT_MAX_CONCURRENCY` on the pi
   * command line (the name the retired subagents glue gave it, which
   * the lens tool and extensions/setup.ts still read). Pinned by
   * tests/tui-companion.test.ts. */
  maxConcurrency: 8,
} as const;

export type ConfigMirrorOutcome =
  "copied" | "unchanged" | "removed" | "absent" | { failed: string };

/** Mirror `source` (the host's live config, or undefined when there is none)
 * into `dir/config.toml`. Pure fs, total — see `syncConfigMirror`. */
export function mirrorConfigFile(source: string | undefined, dir: string): ConfigMirrorOutcome {
  const target = join(dir, CONFIG_FILE);
  try {
    if (source === undefined) {
      if (!existsSync(target)) return "absent";
      rmSync(target, { force: true });
      return "removed";
    }
    const text = readFileSync(source, "utf8");
    let current: string | undefined;
    try {
      current = readFileSync(target, "utf8");
    } catch {
      current = undefined;
    }
    if (current === text) return "unchanged";
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.${CONFIG_FILE}.tmp`);
    writeFileSync(tmp, text);
    renameSync(tmp, target);
    return "copied";
  } catch (err) {
    return { failed: err instanceof Error ? err.message : String(err) };
  }
}

/** The three env names the keys file must define. Values are never read into a
 * log line or an argv — docker reads the file itself via `--env-file`. */
export const KEY_NAMES = [
  "OPENVIKING_API_KEY",
  "OPENVIKING_COMPANION_KEY",
  "OPENVIKING_REVIEWER_KEY",
] as const;

export interface MemoryWiring {
  /** Docker network to attach the container to; "" = memory-less degraded. */
  network: string;
  /** Base URL the container reaches OpenViking on; "" = memory-less. */
  endpoint: string;
  /** Host path of the two-key env file, when it is readable. */
  keysFile?: string;
  /** Human notes worth showing on the status line (never secret values). */
  notes: string[];
}

/**
 * Non-secret memory env + the key file, for a container on `wiring`.
 *
 * The two USER keys ride `--env-file`, so the values never appear in this
 * process's argv (and therefore never in `ps`). docker reads the file
 * itself. Never switch these to `--env NAME=<value>`. The companion and the
 * scan sandbox (src/scanbox.ts) both wire memory with it.
 */
export function memoryEnvArgv(wiring: MemoryWiring): string[] {
  const argv: string[] = [];
  if (wiring.endpoint !== "") {
    argv.push(
      // Read straight out of the vendored extension's credential resolver
      // (shared/credentials.mjs): OPENVIKING_URL wins, OPENVIKING_BASE_URL is
      // its documented alias, and the user/peer headers are what select the
      // namespace a request addresses.
      "--env",
      `OPENVIKING_URL=${wiring.endpoint}`,
      "--env",
      `OPENVIKING_BASE_URL=${wiring.endpoint}`,
      "--env",
      `OPENVIKING_USER=${MEMORY.user}`,
      "--env",
      `OPENVIKING_PEER_ID=${MEMORY.peerId}`,
      // Ours: the in-container health watcher (docker/companion/memory-health.mjs).
      "--env",
      `QCR_MEMORY_ENDPOINT=${wiring.endpoint}`,
      "--env",
      `QCR_MEMORY_ALERTS_DIR=${CONTAINER.alerts}`,
    );
  }
  if (wiring.keysFile) argv.push("--env-file", wiring.keysFile);
  return argv;
}

export function memoryEndpoint(gateway: string, port: number = MEMORY.port): string {
  return `http://${gateway}:${port}`;
}

/** Host path of the OpenViking key file, decided by the install locator:
 * `QCR_OPENVIKING_KEYS`, else the operator home
 * (`$XDG_CONFIG_HOME/qcr-operator/<install>/`, outside every dir a container
 * mounts). 0600, and handed to the container by `--env-file`, so no value
 * reaches an argv. */
export function keysFilePath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  return locateKeysFile({ env: { ...env, HOME: home } }).path;
}

/** Which of KEY_NAMES the file defines — names only, values never leave here. */
export function keyNamesIn(text: string): string[] {
  const found = new Set<string>();
  for (const line of text.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=/.exec(line);
    if (m && (KEY_NAMES as readonly string[]).includes(m[1]!)) found.add(m[1]!);
  }
  return [...found];
}

/**
 * Lines docker's `--env-file` parser would choke on.
 *
 * This matters more than it looks: `docker run --env-file` rejects a file with
 * `export FOO=…`, `FOO = bar` or a bare word, and a rejected `docker run` is a
 * companion that does not start. Memory must never be able to do that, so a
 * file we cannot vouch for is left out of the argv (degraded, not fatal).
 */
export function envFileProblems(text: string): string[] {
  const problems: string[] = [];
  text.split("\n").forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) return;
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(line)) problems.push(`line ${i + 1} is not NAME=value`);
  });
  return problems;
}

/** Gateway address out of `docker network inspect -f …` output, or "". */
export function parseGateway(stdout: string): string {
  const line = stdout.trim().split("\n").pop() ?? "";
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(line.trim()) ? line.trim() : "";
}

/** Host side of the companion's inject dir (`/workspace/inject/<session>`):
 * the rollover's day-open and `qcr setup`'s request land here. */
export function companionInjectDir(cfg: Pick<CompanionConfig, "repo_dir" | "session">): string {
  return `${cfg.repo_dir}/inject/${cfg.session}`;
}

/** Set on the companion's pi: code that runs there (the setup belt, a
 * `qcr scan` the companion runs) knows it is inside the companion container. */
export const IN_COMPANION_ENV = "QCR_IN_COMPANION";

/** The release image's mode word for the companion container
 * (docker/entrypoint.sh): provision pi, start the tmux server, stay alive. */
export const COMPANION_MODE = "companion";

/** Why the companion image cannot be built from `ctx`, or null: the build
 * compiles the app itself, so all it needs is the release Dockerfile. */
export function imageBuildProblem(ctx: string, exists: (p: string) => boolean): string | null {
  const dockerfile = join(ctx, "docker", "Dockerfile");
  return exists(dockerfile)
    ? null
    : `the companion image is built from the release Dockerfile, and ${dockerfile} is not there — is ${ctx} a qcr checkout?`;
}

/** `docker build` of the companion image: the release image
 * (docker/Dockerfile, which compiles the app in its own build stage) from the
 * app root `ctx`, as `image`, stamped. Builds an image and nothing else: no
 * container is touched. No uid is baked in: the container is started as the
 * host user (`hostUser`). */
export function appImageBuildArgv(image: string, ctx: string, stamp: string): string[] {
  return [
    "build",
    "-t",
    image,
    "-f",
    join(ctx, "docker", "Dockerfile"),
    "--build-arg",
    `BUILD_SHA=${stamp}`,
    ctx,
  ];
}

/** The paths of the release image's build context (docker/Dockerfile): the
 * Dockerfile and its own ignore file, then every `!path` that ignore file
 * admits. Only BuildKit reads a per-Dockerfile ignore file; the legacy
 * builder (a Docker without buildx) reads the root .dockerignore, which is the
 * scan sandbox's narrower allowlist, so the context is assembled from this
 * list instead of relying on either — as bench/aacr/bench.sh does. */
export function releaseContextPaths(ignoreText: string): string[] {
  const admitted = ignoreText
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("!"))
    .map((l) => l.slice(1).replace(/^\/+/, ""))
    .filter((l) => l !== "");
  return ["docker/Dockerfile", "docker/Dockerfile.dockerignore", ...admitted];
}

/** Copy the release image's context out of `ctx` into a fresh temp dir
 * (node_modules, .git and tsbuildinfo files left out); the caller removes it. */
export function assembleReleaseContext(ctx: string): string {
  const out = mkdtempSync(join(tmpdir(), "qcr-companion-ctx-"));
  const ignore = readFileSync(join(ctx, "docker", "Dockerfile.dockerignore"), "utf8");
  for (const rel of releaseContextPaths(ignore)) {
    const from = join(ctx, rel);
    if (!existsSync(from)) continue;
    cpSync(from, join(out, rel), {
      recursive: true,
      filter: (src) => !/(^|\/)(node_modules|\.git)(\/|$)|\.tsbuildinfo$/.test(src),
    });
  }
  return out;
}

/** `uid:gid` the companion container runs as: the invoking host user, so the
 * host bind mounts it writes (/workspace, /tracker, /feed, /alerts) stay
 * writable and its files stay yours. The release image bakes no user. */
export function hostUser(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  const gid = typeof process.getgid === "function" ? process.getgid() : 1000;
  return `${uid}:${gid}`;
}

export class CompanionLifecycle {
  /** Resolved by ensureUp() before any `docker run`; the constants are the
   * safe standing answer so runArgv() stays pure and callable in tests. */
  private wiring: MemoryWiring = {
    network: MEMORY.network,
    endpoint: memoryEndpoint(MEMORY.gateway),
    notes: [],
  };

  constructor(
    readonly cfg: CompanionConfig,
    private readonly docker: DockerRunner,
    private readonly env: NodeJS.ProcessEnv = process.env,
    /** Host dirs are created before a cold run so docker does not invent them
     * root-owned. Injectable so tests touch no filesystem. */
    private readonly ensureDirs: (paths: string[]) => void = (paths) => {
      for (const p of paths) mkdirSync(p, { recursive: true });
    },
    /** Filesystem seam: the keys file and the vendored extension are looked up,
     * never assumed. Injectable so argv assertions need no real files. */
    private readonly fs: CompanionFs = realCompanionFs,
    /** The build stamp of the app under the build context (src/appstamp.ts).
     * Injectable so the build argv is assertable without hashing a tree. */
    private readonly stampOf: (root: string) => string = appStamp,
    /** How the tmux server is reached — see `CompanionMode`. */
    readonly mode: CompanionMode = "docker",
    /** Builds the image's context from the app root (`assembleReleaseContext`);
     * injectable so the build argv is assertable without copying a tree. */
    private readonly assembleContext: (ctx: string) => string = assembleReleaseContext,
  ) {}

  /** How long `ensureUp` waits, in `tmux-socket` mode, for the wrapper-run
   * companion's tmux server. A field so tests need not wait it out. */
  wrapperStartWaitMs = WRAPPER_START_WAIT_MS;

  /** The shared socket in `tmux-socket` mode, else undefined. */
  get socketPath(): string | undefined {
    return this.mode === "tmux-socket" ? tmuxSocketPath(this.cfg) : undefined;
  }

  /** `tmux <argv…>`, on the shared socket when there is one. */
  private tmuxArgv(...args: string[]): string[] {
    const socket = this.socketPath;
    return socket === undefined ? ["tmux", ...args] : ["tmux", "-S", socket, ...args];
  }

  /** Start without memory: no network, no endpoint env (the laptop route, where
   * the memory sidecar is opt-in). Pure; for the argv a host wrapper runs. */
  withoutMemory(): this {
    this.wiring = { network: "", endpoint: "", notes: [] };
    return this;
  }

  /** The memory path this instance will wire (or has wired). */
  get memory(): MemoryWiring {
    return this.wiring;
  }

  // ---- pure argv ----------------------------------------------------------

  /** `docker run` for a cold start: every mount the companion needs,
   * the three ssh sources among them (`SSH`, rule 8). Memory still rides the
   * docker network the host-owned forward listens on, never ssh. */
  runArgv(): string[] {
    const argv = [
      "run",
      "--detach",
      "--name",
      this.cfg.container_name,
      "--hostname",
      this.cfg.container_name,
    ];
    // Memory-less is a legitimate mode: no network, no endpoint env, container
    // still starts. It must never be able to wedge the companion.
    if (this.wiring.network !== "") argv.push("--network", this.wiring.network);
    // Network-roaming survival: see PUBLIC_DNS.
    for (const ip of PUBLIC_DNS) argv.push("--dns", ip);
    // The host user (the image bakes none), and the checkout as the working
    // directory: pi reads the repo's own context files from there, and the
    // image's WORKDIR is its app root, whose reviewer stub is not the
    // companion's to load.
    argv.push("--user", hostUser(), "--workdir", CONTAINER.workspace);
    // The wrapper-run companion (D35) is hardened like every other container
    // the wrapper starts; nothing it does needs a capability.
    if (this.socketPath !== undefined)
      argv.push("--init", "--cap-drop", "ALL", "--security-opt", "no-new-privileges");
    for (const m of this.mountSpec())
      argv.push("--volume", `${m.source}:${m.dest}${m.mode ? `:${m.mode}` : ""}`);
    argv.push(...this.memoryEnvArgv());
    // pi's default model, set by the entrypoint on every start.
    argv.push("--env", `QCR_PI_DEFAULT_MODEL=${this.cfg.model}`);
    if (this.socketPath !== undefined) argv.push("--env", `${TMUX_SOCKET_ENV}=${this.socketPath}`);
    // The agent is reached by its mounted socket; no key is in the container.
    if (this.sshSources().agent !== undefined) argv.push("--env", `SSH_AUTH_SOCK=${SSH.agent}`);
    // The release image, in its companion mode (docker/entrypoint.sh).
    argv.push(this.cfg.image, COMPANION_MODE);
    return argv;
  }

  /** Non-secret memory env + the key file, over this instance's wiring
   * (the free `memoryEnvArgv`). */
  memoryEnvArgv(): string[] {
    return memoryEnvArgv(this.wiring);
  }

  /**
   * The pi argv inside the companion's tmux session.
   *
   * Every extension, the theme and the system prompt are the IMAGE's
   * (`CONTAINER.app`, D20): the companion runs the code it was built with, and
   * the checkout at /workspace is the repo it works on, not where its hands
   * come from.
   *
   * VERIFY-ON-PIN, every flag (same list as sessions.ts buildPiCommand):
   * `--model` is documented; `--session-dir` is documented for RPC mode only
   * and assumed to apply to the interactive TUI; `--system-prompt` and
   * `--name` are not documented at all — the fallback for `--system-prompt` is
   * writing the body to <pi home>/.pi/SYSTEM.md, which is reachable on the
   * pihome volume without an image rebuild.
   *
   * The session dir lives on the pihome volume so the conversation survives
   * `docker stop` (that is what makes quit-then-restart a resume rather than a
   * fresh start), and so daily rollover can archive "the newest .jsonl".
   */
  piArgv(): string[] {
    const ext = `${CONTAINER.app}/extensions`;
    return [
      "pi",
      // --approve: pre-trust project-local .pi resources for this run. Without
      // it a cwd carrying .pi/ hits pi's interactive "Trust project folder?"
      // modal and the session stalls forever. Same flag sessions.ts passes
      // (the never-block-on-pi-input decision in root CLAUDE.md).
      "--approve",
      // The vendored patched OpenViking extension — the companion's memory
      // hands. It rides the image, so it is always there; with no memory
      // wiring it finds no endpoint and stays idle (the companion never wedges).
      "--extension",
      MEMORY.extension,
      // Ambient /feed state is deliberately not an extension: one would turn
      // every meaningful poll into a synthetic user message in the operator's
      // active conversation. The model reads the bounded feed files on demand
      // instead.
      "--extension",
      `${ext}/muted-theme.ts`,
      "--theme",
      `${ext}/muted-theme.json`,
      "--extension",
      // Day-open channel: the daemon's inject bridge, unmodified. It
      // drains its directory on session_start before it starts watching, so
      // the rollover can queue the opening message before pi is spawned and
      // the delivery is race-free. QCR_INJECT_DIR (below) points it at the
      // companion's own dir. VERIFY-ON-PIN: `--extension <path>` again.
      `${ext}/inject-bridge.ts`,
      "--extension",
      // The read-only `tui_*` tools over what the TUI published to
      // /feed (screen.txt + view.json). Reads only — it holds no credential and
      // cannot fetch; see the header of extensions/tui-view.ts for why that is
      // structural and not a promise. QCR_FEED_DIR (below) points it at the
      // same dir the FeedWriter writes. VERIFY-ON-PIN: `--extension <path>`.
      `${ext}/tui-view.ts`,
      "--extension",
      // Our lens tools (`lens`, `lens_wave`) at cap 8 — see LENS and
      // extensions/lens.ts. First-party and always in the image, so it loads
      // unconditionally like inject-bridge; its lens sessions are SDK
      // sessions of this pi, over pi's own dispatcher. The cap rides
      // QCR_SUBAGENT_MAX_CONCURRENCY in piEnvPrefix (LENS.maxConcurrency).
      LENS.extension,
      "--extension",
      // The companion's bright lines (frozen seeds, no-GitHub,
      // no-discard in the shared checkout) as tool_call vetoes — see the
      // header of extensions/companion-guard.ts. Companion only; the VM has
      // the gate.
      `${ext}/companion-guard.ts`,
      "--extension",
      // The setup & scan tool belt — the deterministic SetupEngine
      // (repo facts, the unit cut) as `setup_*` tools. Reads the reviewed
      // checkout (`:ro`) and writes only the state home; see the header of
      // extensions/setup.ts. Unconditional like every other extension:
      // a missing checkout is a refusal from the tools, never a pi that
      // won't start.
      `${ext}/setup.ts`,
      "--extension",
      // `!{cmd}` inline expansion in typed prompts — vendored
      // verbatim from the pinned pi package's shipped examples (see its
      // header; byte-identical at 0.84.1 and 0.84.4). QoL for the operator
      // typing into the mirrored terminal.
      `${ext}/inline-bash.ts`,
      "--model",
      this.cfg.model,
      "--session-dir",
      companionSessionDir(this.cfg.session),
      "--system-prompt",
      `${CONTAINER.app}/prompts/companion.md`,
      "--name",
      this.cfg.session,
    ];
  }

  /** QCR_* routing vars. They ride the pi command line, never the client env:
   * tmux panes inherit the tmux server's environment. */
  piEnvPrefix(): string[] {
    return [
      "env",
      `QCR_ROOT=${CONTAINER.workspace}`,
      `QCR_SESSION=${this.cfg.session}`,
      // inject-bridge resolves its session name from this one.
      `QCR_SESSION_NAME=${this.cfg.session}`,
      `QCR_INJECT_DIR=${CONTAINER.workspace}/inject/${this.cfg.session}`,
      `QCR_FEED_DIR=${CONTAINER.feed}`,
      `QCR_ALERTS_DIR=${CONTAINER.alerts}`,
      `QCR_TRACKER_DIR=${CONTAINER.tracker}`,
      // Where the install's homes and the token file sit in here.
      // The locator (src/install.ts) honours QCR_CONFIG_HOME/QCR_STATE_HOME
      // as whole-home overrides, so code run in the container resolves the
      // mounted homes — profiles written by setup land on the host, not in
      // the container user's ~/.config. QCR_CONFIG always names the mirror:
      // when the host has no config the file is simply absent, which the
      // reader reports — never a silent fall back to /workspace/config.toml.
      `QCR_CONFIG_HOME=${CONTAINER.configHome}`,
      `QCR_CONFIG=${CONTAINER.configFile}`,
      `QCR_STATE_HOME=${CONTAINER.stateHome}`,
      // Where the setup tools read the reviewed checkout.
      `QCR_REVIEWED_REPO=${CONTAINER.reviewedRepo}`,
      `QCR_GITHUB_READ_ENV=${CONTAINER.githubRead}/${TOKEN_FILE}`,
      // Survey and scan fan out one case per unit — see LENS.
      `QCR_SUBAGENT_MAX_CONCURRENCY=${LENS.maxConcurrency}`,
      // The lens tool builds its SDK host over pi's own agent dir and refuses
      // a relative or absent one (extensions/lens.ts); name the one pi uses.
      `PI_CODING_AGENT_DIR=${CONTAINER.piHome}/agent`,
      // The retired URIs the recall excludes — see MEMORY.retiredFile.
      `QCR_OV_RETIRED_FILE=${CONTAINER.stateHome}/${MEMORY.retiredFile}`,
      // What a `qcr scan` run here reads to default its sandbox to the host.
      `${IN_COMPANION_ENV}=1`,
    ];
  }

  /**
   * Host side of the install-home mounts, from the install locator over this
   * lifecycle's env (so a test's temp XDG homes are what it mounts):
   * `<config home>/profiles` and `<config home>/portrait`, the live config
   * file when one exists (the source of the mirror — never itself mounted),
   * the mirror dir, the state home, and the token dir. Never the config home
   * as a whole — see `CONTAINER.configHome` for why `secrets/` must stay out.
   */
  hostHomes(): {
    profiles: string;
    portrait: string;
    configFile?: string;
    configMirror: string;
    state: string;
    github: string;
  } {
    const env = this.installEnv();
    const located = locateConfig({ env });
    return {
      profiles: join(configHome(env), PROFILES_DIR),
      portrait: join(configHome(env), PORTRAIT_DIR),
      configFile: this.fs.exists(located.path) ? located.path : undefined,
      configMirror: companionConfigMirrorDir(env),
      state: stateHome(env),
      github: companionGithubDir(env),
    };
  }

  /**
   * Copy the host's live config into the mirror dir the companion mounts
   * (see `CONTAINER.configLive`), or remove the mirror when the host has none
   * — an absent file is the honest answer, a stale one is not. Atomic (tmp +
   * rename inside the mounted dir) and a no-op when nothing changed. Total:
   * a failure is an outcome, never a throw.
   */
  syncConfigMirror(): ConfigMirrorOutcome {
    const homes = this.hostHomes();
    return mirrorConfigFile(homes.configFile, homes.configMirror);
  }

  private installEnv(): InstallEnv {
    return { ...this.env, HOME: this.env.HOME || homedir() };
  }

  /** `docker exec … tmux new-session -d -s companion env QCR_… pi …`. */
  spawnArgv(): string[] {
    return [
      "exec",
      this.cfg.container_name,
      ...this.tmuxArgv("new-session", "-d", "-s", this.cfg.session),
      ...this.piEnvPrefix(),
      ...this.piArgv(),
    ];
  }

  /** Local attach — plain `docker exec -it`, no ssh (this box owns the
   * container). Returned argv is everything after the `docker` binary. */
  attachArgv(): string[] {
    return [
      "exec",
      "-it",
      this.cfg.container_name,
      ...this.tmuxArgv("attach", "-t", this.cfg.session),
    ];
  }

  /** Host side of `/workspace/inject/<session>` — where the rollover drops the
   * day-open message (the repo is bind-mounted, so no docker exec needed). */
  hostInjectDir(): string {
    return companionInjectDir(this.cfg);
  }

  /**
   * Is the reviewed repo checked out on this host?
   *
   * The mount is conditional on this, in `runArgv()` and in `expectedMounts()`,
   * so the two never disagree: present ⇒ the container must carry it (absence
   * is drift, and drift recreates); absent ⇒ nothing is expected and a stale
   * mount is still drift. `docker run` would happily invent an empty host dir
   * for a missing bind source, which is worse than no mount: the companion
   * would read an empty tree and conclude the code says nothing.
   */
  reviewedRepoPresent(): boolean {
    return this.cfg.reviewed_repo_dir !== "" && this.fs.exists(this.cfg.reviewed_repo_dir);
  }

  // ---- state --------------------------------------------------------------

  async status(): Promise<ContainerStatus> {
    // One inspect answers both questions: is it up, and what was it created
    // with. Line 1 is the running flag; every later line is `dest=source` for
    // one mount. Keeping it to a single call means the drift check
    // costs nothing on the start path.
    const res = await this.docker([
      "inspect",
      "--format",
      // `.Name` for a named volume, `.Source` for a bind. Docker reports a
      // volume's Source as its on-disk _data path, which never equals the
      // volume name the run argv asks for — comparing Source would make the
      // drift check fire on every start and recreate the container each time.
      "{{.State.Running}}\n{{range .Mounts}}{{.Destination}}={{if .Name}}{{.Name}}{{else}}{{.Source}}{{end}}\n{{end}}",
      this.cfg.container_name,
    ]);
    if (!res.ok) {
      const none = { exists: false, running: false, mounts: new Map<string, string>() };
      return /no such (object|container)/i.test(res.stderr)
        ? none
        : { ...none, unknown: errText(res) };
    }
    const [first = "", ...rest] = res.stdout.split("\n");
    const mounts = new Map<string, string>();
    for (const line of rest) {
      const eq = line.indexOf("=");
      if (eq > 0) mounts.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
    }
    return { exists: true, running: first.trim() === "true", mounts };
  }

  /**
   * The DNS servers the container was created with, or undefined when docker
   * could not be asked (no opinion — never drift). Its own inspect call on
   * purpose: on docker 29, referencing `.HostConfig` in the same template as
   * the mounts' `{{if .Name}}` makes execution fall back to the raw JSON map,
   * where a bind mount has no "Name" key and the whole inspect errors. Do not
   * fold this back into status().
   */
  async createdDns(): Promise<string[] | undefined> {
    const res = await this.docker([
      "inspect",
      "--format",
      "{{range .HostConfig.Dns}}{{.}}\n{{end}}",
      this.cfg.container_name,
    ]);
    if (!res.ok) return undefined;
    return res.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s !== "");
  }

  /** True when the companion tmux session is already live in the container. */
  async piRunning(): Promise<boolean> {
    const res = await this.docker([
      "exec",
      this.cfg.container_name,
      ...this.tmuxArgv("has-session", "-t", this.cfg.session),
    ]);
    return res.ok;
  }

  /** Is the companion's tmux server answering on its socket? `show-options`
   * never starts a server, so asking cannot birth one in the wrong container. */
  async serverUp(): Promise<boolean> {
    const res = await this.docker([
      "exec",
      this.cfg.container_name,
      ...this.tmuxArgv("show-options", "-s", "exit-empty"),
    ]);
    return res.ok;
  }

  // ---- transitions --------------------------------------------------------

  /** True when the companion image exists locally. */
  async imageExists(): Promise<boolean> {
    const res = await this.docker(["image", "inspect", this.cfg.image]);
    return res.ok;
  }

  /** Remove the container, running or not. Volumes (pihome: OAuth, the
   * conversation) survive — this replaces the container, never its memory. */
  async removeContainer(): Promise<void> {
    const st = await this.status();
    if (st.unknown) throw new Error(`container status unknown: ${st.unknown}`);
    if (!st.exists) return;
    await this.forceRemove();
  }

  /** `docker rm -f` the container; a refusal throws with docker's reason. */
  private async forceRemove(): Promise<void> {
    const res = await this.docker(["rm", "-f", this.cfg.container_name]);
    if (!res.ok) throw new Error(`docker rm ${this.cfg.container_name} failed: ${errText(res)}`);
  }

  /** Throws when the image cannot be built (`imageBuildProblem`) — asked
   * before anything is removed for a rebuild. */
  checkBuildable(): void {
    const problem = imageBuildProblem(this.cfg.build_context, (p) => this.fs.exists(p));
    if (problem !== null) throw new Error(problem);
  }

  /** Build the companion image (idempotent, cached) from the app root, with
   * the release Dockerfile (docker/Dockerfile): the image compiles the app
   * itself, so nothing needs building on the host first, and it is stamped
   * with the checkout's build stamp. The companion's extensions come from this
   * image (D20), so a change to them lands only with a rebuild. */
  async buildImage(onProgress?: (line: string) => void): Promise<void> {
    this.checkBuildable();
    const ctx = this.cfg.build_context;
    onProgress?.(`building ${this.cfg.image} image (first run — takes a few minutes)…`);
    // The stamp is the checkout's; the build reads an assembled copy of the
    // release context, so it works on the legacy builder too.
    const stamp = this.stampOf(ctx);
    const built = this.assembleContext(ctx);
    let res;
    try {
      res = await this.docker(appImageBuildArgv(this.cfg.image, built, stamp), {
        timeoutMs: 1_800_000,
      });
    } finally {
      if (built !== ctx) rmSync(built, { recursive: true, force: true });
    }
    if (!res.ok) throw new Error(`docker build ${this.cfg.image} failed: ${errText(res)}`);
    onProgress?.(`${this.cfg.image} image built`);
  }

  // ---- memory wiring --------------------------------------------------------

  /**
   * Work out how this container will reach memory, without ever failing.
   *
   * The forward (scripts/companion-memory-forward.mjs, run by systemd on the
   * host) owns the network; the lifecycle only joins it. When the network is
   * absent it is created here anyway — idempotent, same fixed subnet — so the
   * container's wiring is stable and memory starts working the moment the
   * forward comes up, rather than needing a container recreate. If even that
   * fails (a subnet clash, docker unhappy) the wiring degrades to memory-less
   * and the companion starts regardless.
   */
  async resolveMemoryWiring(onProgress?: (line: string) => void): Promise<MemoryWiring> {
    const notes: string[] = [];
    let gateway = await this.networkGateway();
    if (gateway === "") {
      await this.docker(["network", "create", "--subnet", MEMORY.subnet, MEMORY.network]);
      gateway = await this.networkGateway();
      if (gateway !== "") notes.push(`created docker network ${MEMORY.network}`);
    }
    if (gateway === "") {
      notes.push(`docker network ${MEMORY.network} unavailable — companion starts without memory`);
      this.wiring = { network: "", endpoint: "", notes };
      for (const n of notes) onProgress?.(n);
      return this.wiring;
    }
    const keysFile = keysFilePath(this.env);
    const keysText = this.fs.read(keysFile);
    let usableKeys: string | undefined;
    if (keysText === undefined) {
      notes.push(
        `no OpenViking keys at ${keysFile} — memory reads/writes will be refused (see docs/companion-memory-access.md)`,
      );
      // The old-place copy is never read; say so when it is the reason.
      const stranded = `${legacySecretsDir({ ...this.env, HOME: homedir() })}/${KEYS_FILE}`;
      if (this.fs.exists(stranded))
        notes.push(
          `${stranded} is no longer read — \`qcr install migrate\` moves it to ${keysFile}`,
        );
    } else {
      const names = keyNamesIn(keysText);
      const missing = KEY_NAMES.filter((n) => !names.includes(n));
      if (missing.length > 0) notes.push(`${keysFile} is missing ${missing.join(", ")}`);
      const mode = this.fs.mode(keysFile);
      if (mode !== undefined && (mode & 0o077) !== 0)
        notes.push(`${keysFile} is group/world readable — chmod 600 it`);
      const bad = envFileProblems(keysText);
      if (bad.length > 0) {
        // Passing it anyway would make `docker run` refuse and the companion
        // never start — memory is never allowed to cost that.
        notes.push(
          `${keysFile} is not a docker env-file (${bad[0]}) — starting without memory keys`,
        );
      } else {
        usableKeys = keysFile;
      }
    }
    this.wiring = {
      network: MEMORY.network,
      endpoint: memoryEndpoint(gateway),
      keysFile: usableKeys,
      notes,
    };
    for (const n of notes) onProgress?.(n);
    return this.wiring;
  }

  private async networkGateway(): Promise<string> {
    const res = await this.docker([
      "network",
      "inspect",
      "--format",
      "{{range .IPAM.Config}}{{.Gateway}}{{end}}",
      MEMORY.network,
    ]);
    return res.ok ? parseGateway(res.stdout) : "";
  }

  /** Attach an already-running container to the memory network. Idempotent —
   * "already exists" is the normal answer and never an error here. */
  async attachToMemoryNetwork(): Promise<boolean> {
    if (this.wiring.network === "") return false;
    const res = await this.docker([
      "network",
      "connect",
      this.wiring.network,
      this.cfg.container_name,
    ]);
    return res.ok;
  }

  /**
   * Bind mounts are frozen at creation, so a container that predates a mount
   * change keeps the old set forever — `docker start` on it silently resurrects
   * the old boundary. That is not cosmetic: a stale container can carry a
   * mount the boundary does not grant (an `~/.ssh` whole, a key file, a dead
   * agent socket) — root CLAUDE.md rule 8 means its mounts to be structural.
   *
   * So: compare what the container has against what `runArgv()` asks for, and
   * report the drift. Named volumes are compared by name, binds by host path.
   * Extra mounts count as drift (an `~/.ssh` whole is that case); an unreadable inspect
   * reports nothing.
   */
  mountDrift(actual: Map<string, string>): string[] {
    if (actual.size === 0) return [];
    const drift: string[] = [];
    // An agent socket moves with every login and differs between shells: a
    // container on another agent socket that is still live keeps its ssh, so
    // a TUI started from another shell never recreates a running companion.
    // A dead one is drift like any other.
    const liveAgent = (dest: string, have: string | undefined): boolean =>
      dest === SSH.agent && have !== undefined && this.fs.exists(have);
    for (const [dest, source] of this.expectedMounts()) {
      const have = actual.get(dest);
      if (have === undefined) drift.push(`missing ${dest}`);
      else if (have !== source && !liveAgent(dest, have))
        drift.push(`${dest} points at ${have}, expected ${source}`);
    }
    for (const [dest, have] of actual) {
      if (!this.expectedMounts().has(dest) && !liveAgent(dest, have)) drift.push(`stale ${dest}`);
    }
    return drift;
  }

  /**
   * DNS is frozen at creation exactly like the mounts, so a container created
   * before PUBLIC_DNS was pinned keeps forwarding lookups to a
   * network-specific upstream forever (see PUBLIC_DNS).
   * Same remedy as mount drift: recreate. Consulted only after status()
   * yielded a mount set (see ensureUp) so an unreadable inspect stays
   * "no opinion", never a recreate.
   */
  dnsDrift(actual: string[]): string[] {
    return actual.join(",") === PUBLIC_DNS.join(",")
      ? []
      : [`dns is [${actual.join(", ")}], expected [${PUBLIC_DNS.join(", ")}]`];
  }

  /**
   * Every mount the container is created with, in `runArgv()` order — the
   * one list `runArgv()` turns into `--volume` flags and `expectedMounts()`
   * (the drift check) reads, so the two can never disagree.
   */
  mountSpec(): Array<{ dest: string; source: string; mode?: "ro" | "rw" }> {
    const spec: Array<{ dest: string; source: string; mode?: "ro" | "rw" }> = [
      { dest: CONTAINER.piHome, source: this.cfg.pihome_volume },
      { dest: CONTAINER.workspace, source: this.cfg.repo_dir, mode: "rw" },
    ];
    // The tmux socket volume, shared with the containerised TUI (D35). The only
    // thing in it is the socket; it is no ssh agent and no docker.sock.
    if (this.socketPath !== undefined)
      spec.push({ dest: CONTAINER.tmuxDir, source: tmuxVolume(this.cfg), mode: "rw" });
    // The tracker and its protocol docs are optional: mounted only when the
    // operator configured them ([companion] tracker_dir / tracker_docs_dir).
    if (this.cfg.tracker_dir !== "")
      spec.push({ dest: CONTAINER.tracker, source: this.cfg.tracker_dir, mode: "rw" });
    if (this.cfg.tracker_docs_dir !== "")
      spec.push({ dest: CONTAINER.trackerDocs, source: this.cfg.tracker_docs_dir, mode: "ro" });
    // The reviewed repo, read-only and only when it is really there — see
    // reviewedRepoPresent().
    if (this.reviewedRepoPresent())
      spec.push({ dest: CONTAINER.reviewedRepo, source: this.cfg.reviewed_repo_dir, mode: "ro" });
    // The evidence store. Created by the TUI before the container starts
    // (`ensureDirs`), so unlike the reviewed repo it is never absent and the
    // mount is unconditional — an empty store is a companion that has seen no
    // rounds yet, which is honest; a missing one would have docker invent a
    // root-owned dir the copier could not then write.
    spec.push(
      { dest: CONTAINER.evidence, source: this.cfg.evidence_dir, mode: "ro" },
      { dest: CONTAINER.feed, source: this.cfg.feed_dir, mode: "rw" },
      { dest: CONTAINER.alerts, source: this.cfg.alerts_dir, mode: "rw" },
    );
    // The install's homes (profiles/, portrait/, state), the config mirror
    // and the read-only GitHub token. All directories, created before a cold
    // run (`ensureDirs`), so unconditional like the evidence store.
    const homes = this.hostHomes();
    spec.push(
      { dest: CONTAINER.profiles, source: homes.profiles, mode: "rw" },
      { dest: CONTAINER.portrait, source: homes.portrait, mode: "rw" },
      { dest: CONTAINER.configLive, source: homes.configMirror, mode: "ro" },
      { dest: CONTAINER.stateHome, source: homes.state, mode: "rw" },
      { dest: CONTAINER.githubRead, source: homes.github, mode: "ro" },
    );
    // The locator also searches beside an explicit config file. Keep that
    // fallback beside the mirrored config without mounting its secret home.
    const override = (this.installEnv().QCR_CONFIG ?? "").trim();
    const adjacent = override
      ? join(dirname(locateConfig({ env: this.installEnv() }).path), PROFILES_DIR)
      : undefined;
    if (adjacent && adjacent !== homes.profiles && this.fs.exists(adjacent))
      spec.push({ dest: `${CONTAINER.configLive}/profiles`, source: adjacent, mode: "rw" });
    // The VM access (rule 8): exactly these three, read-only, present ones
    // only. An agent socket moves with every login, so a new path is mount
    // drift and the container is recreated onto it.
    const ssh = this.sshSources();
    if (ssh.agent !== undefined) spec.push({ dest: SSH.agent, source: ssh.agent, mode: "ro" });
    if (ssh.config !== undefined) spec.push({ dest: SSH.config, source: ssh.config, mode: "ro" });
    if (ssh.knownHosts !== undefined)
      spec.push({ dest: SSH.knownHosts, source: ssh.knownHosts, mode: "ro" });
    return spec;
  }

  /**
   * The host's ssh sources the companion is given (`SSH`): the agent socket
   * `SSH_AUTH_SOCK` names, and `config` and `known_hosts` under the
   * configured `ssh_dir` — each only when it exists. In `tmux-socket` mode
   * this process cannot see the host, so the wrapper names them
   * (`HOST_SSH_ENV`).
   */
  sshSources(): SshSources {
    const out: SshSources = {};
    const set = (key: keyof SshSources, path: string | undefined): void => {
      if (path !== undefined) out[key] = path;
    };
    if (this.socketPath !== undefined) {
      set("agent", hostPath(this.env[HOST_SSH_ENV.agent]));
      set("config", hostPath(this.env[HOST_SSH_ENV.config]));
      set("knownHosts", hostPath(this.env[HOST_SSH_ENV.knownHosts]));
      return out;
    }
    const present = (path: string | undefined): string | undefined =>
      path !== undefined && this.fs.exists(path) ? path : undefined;
    const dir = hostPath(this.cfg.ssh_dir);
    set("agent", present(hostPath(this.env["SSH_AUTH_SOCK"])));
    set("config", present(dir === undefined ? undefined : join(dir, "config")));
    set("knownHosts", present(dir === undefined ? undefined : join(dir, "known_hosts")));
    return out;
  }

  /** `dest -> source` for every mount `runArgv()` declares. */
  expectedMounts(): Map<string, string> {
    return new Map(this.mountSpec().map((m) => [m.dest, m.source]));
  }

  /** Idempotent: running → adopt; stopped → start; absent → run. */
  async ensureUp(onProgress?: (line: string) => void): Promise<EnsureOutcome> {
    if (this.socketPath !== undefined) return this.adoptWrapperRun(onProgress);
    await this.resolveMemoryWiring(onProgress);
    // Say which of the two worlds this start is in, either way. A missing
    // checkout is a normal, non-fatal state — but a companion silently reading
    // no reviewed source at all must never be left implicit.
    onProgress?.(
      this.reviewedRepoPresent()
        ? `reviewed repo ${this.cfg.reviewed_repo_dir} → ${CONTAINER.reviewedRepo} (read-only)`
        : `no reviewed repo at ${this.cfg.reviewed_repo_dir} — companion starts without it ([companion] reviewed_repo_dir)`,
    );
    let st = await this.status();
    let recreating = false;
    // Mount drift is repaired by recreation and nothing else. Do it before the
    // adopt/start branches, so a stale container never survives a TUI start.
    // The conversation is on the pihome volume and survives the rm.
    if (st.exists) {
      // DNS drift is only worth asking about when the mounts came back clean
      // (drifted mounts already force the recreate) and status() actually
      // yielded a mount set: a real companion container always reports its
      // mounts, so an empty set means the answer was unreadable — no opinion,
      // never a recreate. An unreadable createdDns() is no opinion too.
      const mountIssues = this.mountDrift(st.mounts);
      const dns =
        mountIssues.length === 0 && st.mounts.size > 0 ? await this.createdDns() : undefined;
      const drift = [...mountIssues, ...(dns === undefined ? [] : this.dnsDrift(dns))];
      if (drift.length > 0) {
        onProgress?.(`companion mounts drifted (${drift.join("; ")}) — recreating`);
        await this.forceRemove();
        st = { exists: false, running: false, mounts: new Map() };
        recreating = true;
      }
    }
    if (st.running) {
      // A container created before the memory forward existed is still on the
      // old network; connecting is live and needs no recreate.
      await this.attachToMemoryNetwork();
      return "adopted";
    }
    if (st.exists) {
      const started = await this.docker(["start", this.cfg.container_name]);
      if (started.ok) {
        // Same repair as adopting a running container: one created before
        // the memory network existed joins it now.
        await this.attachToMemoryNetwork();
        return "started";
      }
      // A stopped container can be permanently unstartable: bind-mount
      // sources are recorded at creation, and a source that no longer exists
      // makes `docker start` fail forever. Remove the husk and recreate with
      // the current environment; named volumes (pihome auth, conversation)
      // survive the rm.
      onProgress?.(`companion container unstartable (${firstLine(errText(started))}) — recreating`);
      await this.forceRemove();
    }
    // Self-healing first run: build the image rather than failing on its absence.
    if (!(await this.imageExists())) await this.buildImage(onProgress);
    const homes = this.hostHomes();
    this.ensureDirs([
      this.cfg.feed_dir,
      this.cfg.alerts_dir,
      this.cfg.evidence_dir,
      homes.profiles,
      homes.portrait,
      homes.configMirror,
      homes.state,
      homes.github,
    ]);
    const created = await this.docker(this.runArgv(), { timeoutMs: 120_000 });
    if (!created.ok) throw new Error(`docker run ${this.cfg.image} failed: ${errText(created)}`);
    return st.exists || recreating ? "recreated" : "created";
  }

  /**
   * `tmux-socket` mode: the host wrapper started (or adopted) the companion
   * container before this process existed, and this one has no docker, so the
   * start is only a wait for the tmux server to answer on the shared socket.
   * A server that never answers is the wrapper's failure to report, not ours
   * to repair.
   */
  private async adoptWrapperRun(onProgress?: (line: string) => void): Promise<EnsureOutcome> {
    onProgress?.(`companion container run by the qcr wrapper — tmux socket ${this.socketPath}`);
    if (await this.waitRunning(this.wrapperStartWaitMs, 250)) return "adopted";
    throw new Error(
      `the companion's tmux server is not answering on ${this.socketPath} — the qcr wrapper starts the companion container before the TUI (is ${this.cfg.container_name} running?)`,
    );
  }

  /**
   * Wait until the container is actually running.
   *
   * `docker run --detach` returns once the container is created, and a
   * `docker exec` an instant later can still lose the race with "container is
   * not running", typically right after a recreate. Bounded and total: if
   * it never comes up, the caller's own error is the better message.
   */
  async waitRunning(timeoutMs = 5_000, stepMs = 100): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.socketPath !== undefined) {
        // No docker to ask: the server answering is "running".
        if (await this.serverUp()) return true;
        if (Date.now() >= deadline) return false;
        await new Promise((r) => setTimeout(r, stepMs));
        continue;
      }
      const st = await this.status();
      if (st.running) return true;
      // Gone rather than starting: waiting cannot help, and the caller's own
      // failure is a better message than a five-second stall.
      if (!st.exists) return false;
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, stepMs));
    }
  }

  /** Idempotent: a live companion session is left strictly alone (a second
   * TUI attaches to it). Returns true when this call birthed the session. */
  async spawnPi(): Promise<boolean> {
    if (await this.piRunning()) return false;
    let res = await this.docker(this.spawnArgv());
    // `docker run --detach` returns at create, not at running, so an exec an
    // instant after a recreate can lose the race with "container is not
    // running", which would report the companion unavailable for the whole
    // session. Wait for it once and try again;
    // anything else is a real failure and is raised as one.
    if (!res.ok && /is not running|tmux server is not up/i.test(errText(res))) {
      await this.waitRunning();
      res = await this.docker(this.spawnArgv());
    }
    // Another TUI may have created the session between the check above and
    // this spawn (tmux refuses a duplicate): that session is the one to adopt.
    if (!res.ok && (await this.piRunning())) return false;
    if (!res.ok) throw new Error(`spawning the companion pi session failed: ${errText(res)}`);
    return true;
  }

  /** Graceful `docker stop` — SIGTERM to the entrypoint; volumes persist.
   * A container docker could not be asked about is not a stopped one: that
   * throws rather than return as if the stop had happened. */
  async gracefulStop(): Promise<void> {
    // The wrapper that ran the container stops it, after the TUI container
    // has exited; this process cannot, and must not pretend to.
    if (this.socketPath !== undefined) return;
    const st = await this.status();
    if (st.unknown !== undefined)
      throw new Error(
        `cannot tell whether ${this.cfg.container_name} is running (docker inspect failed: ${st.unknown}) — nothing was stopped`,
      );
    if (!st.running) return;
    const res = await this.docker(["stop", this.cfg.container_name], { timeoutMs: 60_000 });
    if (!res.ok) throw new Error(`docker stop ${this.cfg.container_name} failed: ${errText(res)}`);
  }
}

/** One-line cause from a failed docker call: the last line of stderr, else
 * of stdout, else the exit status. */
export function dockerFailureLine(r: DockerResult): string {
  return (r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`).split("\n").slice(-1)[0]!;
}

const errText = dockerFailureLine;

/** The companion's pi session dir inside the container — where `piArgv` points
 * pi and where the day rollover looks for the conversation. */
export function companionSessionDir(session: string): string {
  return `${CONTAINER.piHome}/agent/sessions/${session}`;
}

function firstLine(s: string): string {
  return s.split("\n", 1)[0] ?? "";
}

export const realDockerRunner: DockerRunner = (argv, opts) => runCommand("docker", argv, opts);

/** Run `bin argv…` and collect its output. A spawn failure (no such binary,
 * no permission) or the timeout is said in `stderr`, so the caller's
 * one-line cause names it instead of "exit null". */
export function runCommand(
  bin: string,
  argv: string[],
  opts?: { timeoutMs?: number },
): Promise<DockerResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(bin, argv, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (ok: boolean, code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ ok, stdout, stderr, code });
    };
    const timeoutMs = opts?.timeoutMs ?? 20_000;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      stderr += `${stderr === "" || stderr.endsWith("\n") ? "" : "\n"}${bin} timed out after ${timeoutMs} ms`;
      settle(false, null);
    }, timeoutMs);
    // Decoded by the stream, never per chunk: a multi-byte character split
    // across two reads (a `─` in a large capture, any non-ASCII in a long
    // copied buffer) otherwise becomes two U+FFFD.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => (stdout += d));
    child.stderr.on("data", (d: string) => (stderr += d));
    child.on("error", (err) => {
      stderr += `${stderr === "" || stderr.endsWith("\n") ? "" : "\n"}${bin}: ${err.message}`;
      settle(false, null);
    });
    child.on("close", (code) => settle(code === 0, code));
  });
}

// Local companion container lifecycle (build slice C1).
//
// The shape mirrors remote.ts: command construction is pure so tests can assert
// the exact argv, execution goes through one injectable runner, and nothing
// here ever kills anything the user did not explicitly ask to stop.
//
// Lifecycle contract (grilled):
//   `qcr tui` start → adopt a running container, else `docker start`, else
//   `docker run` it. Quit → `docker stop` (conversation, pihome auth and
//   the pi home survive on volumes; next start is a fast resume). TUI crash →
//   the container keeps running and the next start adopts it. A second
//   concurrent TUI attaches to the same container, never spawns a twin:
//   ensureUp() and spawnPi() are both idempotent and there is no kill path
//   except the explicit `qcr companion down`.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CompanionConfig } from "../config.js";

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
  /** `dest -> source` for every mount the container was CREATED with; empty
   * when it does not exist or docker could not be asked. */
  mounts: Map<string, string>;
}

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

/** In-container paths. Fixed by the image (docker/companion/Dockerfile), so
 * they are constants rather than knobs — the host side of each is configured. */
export const CONTAINER = {
  home: "/home/companion",
  piHome: "/home/companion/.pi",
  workspace: "/workspace",
  tracker: "/tracker",
  /** The tracker's protocol docs, read-only. `/tracker` carries the
   * issues; the doc that says how to write them lives one level up on the
   * host, outside every other mount. */
  trackerDocs: "/tracker-docs",
  feed: "/feed",
  alerts: "/alerts",
} as const;

// NOTE: `/home/companion/.ssh` and `/ssh-agent` used to be mounted
// here so the companion could read the VM itself. They are GONE, and the
// removal is the point of this slice: the companion's reach into the VM is now
// OpenViking memory over a forward the HOST owns (systemd --user, see
// scripts/companion-memory-forward.mjs), so the container holds no VM ssh
// credential of any kind and cannot ssh anywhere even if it wanted to. Do not
// reintroduce either mount — the boundary is meant to be structural, not
// prompted (root CLAUDE.md rule 8).

export type EnsureOutcome = "adopted" | "started" | "created" | "recreated";

// ---- the memory forward ------------------------------------------

/**
 * Constants of the host-owned memory path. The companion never speaks ssh:
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
  /** The OpenViking USER whose memory the companion owns — becomes the
   * `X-OpenViking-User` header on every request it makes. */
  user: "companion",
  /** Peer id the patched extension reports (`X-OpenViking-Actor-Peer`);
   * verified to override the path-derived default (spike). Same
   * identity as `user` for the companion — one surface, one actor. */
  peerId: "companion",
  /** The vendored patched OpenViking pi extension, inside /workspace. */
  extension: `${CONTAINER.workspace}/extensions/vendor/openviking-pi/index.ts`,
} as const;

/** The three env names the keys file must define. Values are NEVER read into a
 * log line or an argv — docker reads the file itself via `--env-file`. */
export const KEY_NAMES = ["OPENVIKING_API_KEY", "OPENVIKING_COMPANION_KEY", "OPENVIKING_REVIEWER_KEY"] as const;

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

export function memoryEndpoint(gateway: string, port: number = MEMORY.port): string {
  return `http://${gateway}:${port}`;
}

/** Host path of the OpenViking key file. `QCR_OPENVIKING_KEYS` overrides it;
 * the default sits beside the app credential, in the same 0600 discipline. */
export function keysFilePath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const override = env["QCR_OPENVIKING_KEYS"]?.trim();
  return override && override !== "" ? override : join(home, ".config", "quickreview-bot", "openviking-keys.env");
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
 * This matters more than it looks: `docker run --env-file` REJECTS a file with
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

export class CompanionLifecycle {
  /** Resolved by ensureUp() before any `docker run`; the constants are the
   * safe standing answer so runArgv() stays pure and callable in tests. */
  private wiring: MemoryWiring = { network: MEMORY.network, endpoint: memoryEndpoint(MEMORY.gateway), notes: [] };

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
  ) {}

  /** The memory path this instance will wire (or has wired). */
  get memory(): MemoryWiring {
    return this.wiring;
  }

  // ---- pure argv ----------------------------------------------------------

  /** `docker run` for a cold start: every mount the companion needs.
   *
   * There is deliberately no ssh mount and no agent socket: the one
   * thing the companion reaches on the VM is OpenViking, through the docker
   * network the host-owned forward listens on. */
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
    argv.push(
      "--volume",
      `${this.cfg.pihome_volume}:${CONTAINER.piHome}`,
      "--volume",
      `${this.cfg.repo_dir}:${CONTAINER.workspace}:rw`,
      "--volume",
      `${this.cfg.tracker_dir}:${CONTAINER.tracker}:rw`,
      "--volume",
      `${this.cfg.tracker_docs_dir}:${CONTAINER.trackerDocs}:ro`,
      "--volume",
      `${this.cfg.feed_dir}:${CONTAINER.feed}:rw`,
      "--volume",
      `${this.cfg.alerts_dir}:${CONTAINER.alerts}:rw`,
    );
    argv.push(...this.memoryEnvArgv());
    argv.push(this.cfg.image);
    return argv;
  }

  /**
   * Non-secret memory env + the key file.
   *
   * The two USER keys ride `--env-file`, so the values never appear in this
   * process's argv (and therefore never in `ps`). docker reads the file
   * itself. NEVER switch these to `--env NAME=<value>`.
   */
  memoryEnvArgv(): string[] {
    const argv: string[] = [];
    if (this.wiring.endpoint !== "") {
      argv.push(
        // Read straight out of the vendored extension's credential resolver
        // (shared/credentials.mjs): OPENVIKING_URL wins, OPENVIKING_BASE_URL is
        // its documented alias, and the user/peer headers are what select the
        // namespace a request addresses.
        "--env",
        `OPENVIKING_URL=${this.wiring.endpoint}`,
        "--env",
        `OPENVIKING_BASE_URL=${this.wiring.endpoint}`,
        "--env",
        `OPENVIKING_USER=${MEMORY.user}`,
        "--env",
        `OPENVIKING_PEER_ID=${MEMORY.peerId}`,
        // Ours: the in-container health watcher (docker/companion/memory-health.mjs).
        "--env",
        `QCR_MEMORY_ENDPOINT=${this.wiring.endpoint}`,
        "--env",
        `QCR_MEMORY_ALERTS_DIR=${CONTAINER.alerts}`,
      );
    }
    if (this.wiring.keysFile) argv.push("--env-file", this.wiring.keysFile);
    return argv;
  }

  /**
   * The pi argv inside the companion's tmux session.
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
    // the vendored patched OpenViking extension — the companion's
    // memory hands. Loaded only when the vendor dir is actually present: a
    // missing extension must degrade to memory-less, never to a pi that
    // refuses to start (the companion never wedges).
    const openviking = this.fs.exists(this.hostVendorExtension()) ? ["--extension", MEMORY.extension] : [];
    return [
      "pi",
      // --approve: pre-trust project-local .pi resources for this run. Without
      // it a cwd carrying .pi/ hits pi's interactive "Trust project folder?"
      // modal and the session stalls forever — the pr-5334 incident, whose
      // three-layer fix (rule 7 / CLAUDE.md 2026-08-20) was applied to the
      // reviewer sessions but never to the companion, which has been eating
      // the modal on every start since. Same flag sessions.ts passes.
      "--approve",
      ...openviking,
      // Ambient /feed state is deliberately NOT an extension: loading the old
      // companion-wake here turned every meaningful poll into a synthetic user
      // message in the owner's active conversation. The model reads the bounded
      // feed files on demand instead.
      "--extension",
      `${CONTAINER.workspace}/extensions/muted-theme.ts`,
      "--theme",
      `${CONTAINER.workspace}/extensions/muted-theme.json`,
      "--extension",
      // day-open channel: the daemon's inject bridge, unmodified. It
      // drains its directory on session_start before it starts watching, so
      // the rollover can queue the opening message BEFORE pi is spawned and
      // the delivery is race-free. QCR_INJECT_DIR (below) points it at the
      // companion's own dir. VERIFY-ON-PIN: `--extension <path>` again.
      `${CONTAINER.workspace}/extensions/inject-bridge.ts`,
      "--model",
      this.cfg.model,
      "--session-dir",
      `${CONTAINER.piHome}/agent/sessions/${this.cfg.session}`,
      "--system-prompt",
      `${CONTAINER.workspace}/prompts/companion.md`,
      "--name",
      this.cfg.session,
    ];
  }

  /** QCR_* routing vars. They ride the pi command line, never the client env:
   * tmux panes inherit the tmux SERVER's environment (§Q4.3). */
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
    ];
  }

  /** `docker exec … tmux new-session -d -s companion env QCR_… pi …`. */
  spawnArgv(): string[] {
    return [
      "exec",
      this.cfg.container_name,
      "tmux",
      "new-session",
      "-d",
      "-s",
      this.cfg.session,
      ...this.piEnvPrefix(),
      ...this.piArgv(),
    ];
  }

  /** Local attach — plain `docker exec -it`, no ssh (this box owns the
   * container). Returned argv is everything after the `docker` binary. */
  attachArgv(): string[] {
    return ["exec", "-it", this.cfg.container_name, "tmux", "attach", "-t", this.cfg.session];
  }

  /** Host side of `/workspace/inject/<session>` — where the rollover drops the
   * day-open message (the repo is bind-mounted, so no docker exec needed). */
  hostInjectDir(): string {
    return `${this.cfg.repo_dir}/inject/${this.cfg.session}`;
  }

  /** Host side of the vendored extension (the repo is bind-mounted). */
  hostVendorExtension(): string {
    return `${this.cfg.repo_dir}/extensions/vendor/openviking-pi/index.ts`;
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
      // `.Name` for a named volume, `.Source` for a bind. Docker
      // reports a volume's Source as its on-disk _data path, which never
      // equals the volume NAME the run argv asks for — comparing Source made
      // the drift check fire on every single start and recreate the container
      // each time, which is also how a `docker exec` landed on a container
      // that was still coming up.
      "{{.State.Running}}\n{{range .Mounts}}{{.Destination}}={{if .Name}}{{.Name}}{{else}}{{.Source}}{{end}}\n{{end}}",
      this.cfg.container_name,
    ]);
    if (!res.ok) return { exists: false, running: false, mounts: new Map() };
    const [first = "", ...rest] = res.stdout.split("\n");
    const mounts = new Map<string, string>();
    for (const line of rest) {
      const eq = line.indexOf("=");
      if (eq > 0) mounts.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
    }
    return { exists: true, running: first.trim() === "true", mounts };
  }

  /** True when the companion tmux session is already live in the container. */
  async piRunning(): Promise<boolean> {
    const res = await this.docker(["exec", this.cfg.container_name, "tmux", "has-session", "-t", this.cfg.session]);
    return res.ok;
  }

  // ---- transitions --------------------------------------------------------

  /** Idempotent: running → adopt; stopped → start; absent → run. */
  /** True when the companion image exists locally. */
  async imageExists(): Promise<boolean> {
    const res = await this.docker(["image", "inspect", this.cfg.image]);
    return res.ok;
  }

  /** Build the companion image from docker/companion (idempotent, cached).
   * Runs with the caller's uid so the host bind mounts stay writable. */
  /** Remove the container, running or not. Volumes (pihome: OAuth, the
   * conversation) survive — this replaces the container, never its memory. */
  async removeContainer(): Promise<void> {
    const st = await this.status();
    if (!st.exists) return;
    const res = await this.docker(["rm", "-f", this.cfg.container_name]);
    if (!res.ok) throw new Error(`docker rm ${this.cfg.container_name} failed: ${errText(res)}`);
  }

  async buildImage(onProgress?: (line: string) => void): Promise<void> {
    onProgress?.(`building ${this.cfg.image} image (first run — takes a few minutes)…`);
    const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
    const res = await this.docker(
      ["build", "-t", this.cfg.image, "--build-arg", `COMPANION_UID=${uid}`, this.cfg.build_context],
      { timeoutMs: 1_800_000 },
    );
    if (!res.ok) throw new Error(`docker build ${this.cfg.image} failed: ${errText(res)}`);
    onProgress?.(`${this.cfg.image} image built`);
  }

  // ---- memory wiring --------------------------------------------

  /**
   * Work out how this container will reach memory, WITHOUT ever failing.
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
      notes.push(`no OpenViking keys at ${keysFile} — memory reads/writes will be refused (see docs/companion-memory-access.md)`);
    } else {
      const names = keyNamesIn(keysText);
      const missing = KEY_NAMES.filter((n) => !names.includes(n));
      if (missing.length > 0) notes.push(`${keysFile} is missing ${missing.join(", ")}`);
      const mode = this.fs.mode(keysFile);
      if (mode !== undefined && (mode & 0o077) !== 0) notes.push(`${keysFile} is group/world readable — chmod 600 it`);
      const bad = envFileProblems(keysText);
      if (bad.length > 0) {
        // Passing it anyway would make `docker run` refuse and the companion
        // never start — memory is never allowed to cost that.
        notes.push(`${keysFile} is not a docker env-file (${bad[0]}) — starting without memory keys`);
      } else {
        usableKeys = keysFile;
      }
    }
    this.wiring = { network: MEMORY.network, endpoint: memoryEndpoint(gateway), keysFile: usableKeys, notes };
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
    const res = await this.docker(["network", "connect", this.wiring.network, this.cfg.container_name]);
    return res.ok;
  }

  /**
   * Bind mounts are frozen at creation, so a container that predates a mount
   * change keeps the OLD set forever — `docker start` on it silently resurrects
   * the old boundary. That is not cosmetic: it is how a container created
   * before still carries `~/.ssh` and an ssh-agent socket, defeating a
   * boundary root CLAUDE.md rule 8 means to be structural.
   *
   * So: compare what the container HAS against what `runArgv()` asks for, and
   * report the drift. Named volumes are compared by name, binds by host path.
   * Extra mounts count as drift (that is the ssh case); an unreadable inspect
   * reports nothing.
   */
  mountDrift(actual: Map<string, string>): string[] {
    if (actual.size === 0) return [];
    const drift: string[] = [];
    for (const [dest, source] of this.expectedMounts()) {
      const have = actual.get(dest);
      if (have === undefined) drift.push(`missing ${dest}`);
      else if (have !== source) drift.push(`${dest} points at ${have}, expected ${source}`);
    }
    for (const dest of actual.keys()) {
      if (!this.expectedMounts().has(dest)) drift.push(`stale ${dest}`);
    }
    return drift;
  }

  /** `dest -> source` for every mount `runArgv()` declares. */
  expectedMounts(): Map<string, string> {
    return new Map([
      [CONTAINER.piHome, this.cfg.pihome_volume],
      [CONTAINER.workspace, this.cfg.repo_dir],
      [CONTAINER.tracker, this.cfg.tracker_dir],
      [CONTAINER.trackerDocs, this.cfg.tracker_docs_dir],
      [CONTAINER.feed, this.cfg.feed_dir],
      [CONTAINER.alerts, this.cfg.alerts_dir],
    ]);
  }

  async ensureUp(onProgress?: (line: string) => void): Promise<EnsureOutcome> {
    await this.resolveMemoryWiring(onProgress);
    let st = await this.status();
    let recreating = false;
    // Mount drift is repaired by recreation and nothing else. Do it before the
    // adopt/start branches, so a stale container never survives a TUI start.
    // The conversation is on the pihome volume and survives the rm.
    if (st.exists) {
      const drift = this.mountDrift(st.mounts);
      if (drift.length > 0) {
        onProgress?.(`companion mounts drifted (${drift.join("; ")}) — recreating`);
        const removed = await this.docker(["rm", "-f", this.cfg.container_name]);
        if (!removed.ok) throw new Error(`docker rm ${this.cfg.container_name} failed: ${errText(removed)}`);
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
      if (started.ok) return "started";
      // A stopped container can be permanently unstartable: bind-mount
      // sources are recorded at creation, and the ssh-agent socket path is
      // random per boot — after a reboot `docker start` fails forever
      // (observed live, 2026-08-14 crash). Remove the husk and recreate with
      // the CURRENT environment; named volumes (pihome auth, conversation)
      // survive the rm.
      onProgress?.(`companion container unstartable (${firstLine(errText(started))}) — recreating`);
      const removed = await this.docker(["rm", "-f", this.cfg.container_name]);
      if (!removed.ok) throw new Error(`docker rm ${this.cfg.container_name} failed: ${errText(removed)}`);
    }
    // Self-healing first run: build the image rather than failing on its absence.
    if (!(await this.imageExists())) await this.buildImage(onProgress);
    this.ensureDirs([this.cfg.feed_dir, this.cfg.alerts_dir]);
    const created = await this.docker(this.runArgv(), { timeoutMs: 120_000 });
    if (!created.ok) throw new Error(`docker run ${this.cfg.image} failed: ${errText(created)}`);
    return st.exists || recreating ? "recreated" : "created";
  }

  /** Idempotent: a live companion session is left strictly alone (a second
   * TUI attaches to it). Returns true when this call birthed the session. */
  /**
   * Wait until the container is actually running.
   *
   * `docker run --detach` returns once the container is created, and a
   * `docker exec` an instant later can still lose the race with "container is
   * not running" — observed live right after a recreate. Bounded and total: if
   * it never comes up, the caller's own error is the better message.
   */
  async waitRunning(timeoutMs = 5_000, stepMs = 100): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const st = await this.status();
      if (st.running) return true;
      // Gone rather than starting: waiting cannot help, and the caller's own
      // failure is a better message than a five-second stall.
      if (!st.exists) return false;
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, stepMs));
    }
  }

  async spawnPi(): Promise<boolean> {
    if (await this.piRunning()) return false;
    let res = await this.docker(this.spawnArgv());
    // `docker run --detach` returns at CREATE, not at running, so an exec an
    // instant after a recreate can lose the race — observed live as
    // "container is not running", which then reported the companion as
    // unavailable for the whole session. Wait for it once and try again;
    // anything else is a real failure and is raised as one.
    if (!res.ok && /is not running/i.test(errText(res))) {
      await this.waitRunning();
      res = await this.docker(this.spawnArgv());
    }
    if (!res.ok) throw new Error(`spawning the companion pi session failed: ${errText(res)}`);
    return true;
  }

  /** Graceful `docker stop` — SIGTERM to the entrypoint; volumes persist. */
  async gracefulStop(): Promise<void> {
    const st = await this.status();
    if (!st.running) return;
    const res = await this.docker(["stop", this.cfg.container_name], { timeoutMs: 60_000 });
    if (!res.ok) throw new Error(`docker stop ${this.cfg.container_name} failed: ${errText(res)}`);
  }
}

function errText(r: DockerResult): string {
  return (r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`).split("\n").slice(-1)[0]!;
}

function firstLine(s: string): string {
  return s.split("\n", 1)[0] ?? "";
}

export const realDockerRunner: DockerRunner = (argv, opts) =>
  new Promise((resolvePromise) => {
    const child = spawn("docker", argv, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (ok: boolean, code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ ok, stdout, stderr, code });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle(false, null);
    }, opts?.timeoutMs ?? 20_000);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", () => settle(false, null));
    child.on("close", (code) => settle(code === 0, code));
  });

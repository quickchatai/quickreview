// Local companion container lifecycle (build slice C1).
//
// The shape mirrors remote.ts: command construction is pure so tests can assert
// the exact argv, execution goes through one injectable runner, and nothing
// here ever kills anything the user did not explicitly ask to stop.
//
// Lifecycle contract (grilled):
//   `qcr tui` start → adopt a running container, else `docker start`, else
//   `docker run` it. Quit → `docker stop` (conversation, pihome auth and
//   pi-memory survive on volumes; next start is a fast resume). TUI crash →
//   the container keeps running and the next start adopts it. A second
//   concurrent TUI attaches to the same container, never spawns a twin:
//   ensureUp() and spawnPi() are both idempotent and there is no kill path
//   except the explicit `qcr companion down`.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
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
}

/** In-container paths. Fixed by the image (docker/companion/Dockerfile), so
 * they are constants rather than knobs — the host side of each is configured. */
export const CONTAINER = {
  home: "/home/companion",
  piHome: "/home/companion/.pi",
  workspace: "/workspace",
  tracker: "/tracker",
  feed: "/feed",
  alerts: "/alerts",
  ssh: "/home/companion/.ssh",
  agentSock: "/ssh-agent",
} as const;

export type EnsureOutcome = "adopted" | "started" | "created";

export class CompanionLifecycle {
  constructor(
    readonly cfg: CompanionConfig,
    private readonly docker: DockerRunner,
    private readonly env: NodeJS.ProcessEnv = process.env,
    /** Host dirs are created before a cold run so docker does not invent them
     * root-owned. Injectable so tests touch no filesystem. */
    private readonly ensureDirs: (paths: string[]) => void = (paths) => {
      for (const p of paths) mkdirSync(p, { recursive: true });
    },
  ) {}

  // ---- pure argv ----------------------------------------------------------

  /** `docker run` for a cold start: every mount the companion needs. */
  runArgv(): string[] {
    const argv = [
      "run",
      "--detach",
      "--name",
      this.cfg.container_name,
      "--hostname",
      this.cfg.container_name,
      "--volume",
      `${this.cfg.pihome_volume}:${CONTAINER.piHome}`,
      "--volume",
      `${this.cfg.repo_dir}:${CONTAINER.workspace}:rw`,
      "--volume",
      `${this.cfg.tracker_dir}:${CONTAINER.tracker}:rw`,
      "--volume",
      `${this.cfg.feed_dir}:${CONTAINER.feed}:rw`,
      "--volume",
      `${this.cfg.alerts_dir}:${CONTAINER.alerts}:rw`,
      "--volume",
      `${this.cfg.ssh_dir}:${CONTAINER.ssh}:ro`,
    ];
    // The agent socket is optional: without it the companion simply cannot read
    // the VM, which is a degraded mode, not a failure to start.
    const sock = this.env["SSH_AUTH_SOCK"];
    if (sock) {
      argv.push("--volume", `${sock}:${CONTAINER.agentSock}:ro`, "--env", `SSH_AUTH_SOCK=${CONTAINER.agentSock}`);
    }
    argv.push(this.cfg.image);
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
    return [
      "pi",
      "--extension",
      // wake channel: fs.watch on /feed/wake → sendUserMessage. The
      // repo is mounted at /workspace, so the extension ships with the repo, no
      // image rebuild. VERIFY-ON-PIN: `--extension <path>` (same undocumented
      // flag sessions.ts uses; fallback is the settings.json "extensions" array
      // the entrypoint already writes).
      `${CONTAINER.workspace}/extensions/companion-wake.ts`,
      "--extension",
      `${CONTAINER.workspace}/extensions/companion-theme.ts`,
      "--theme",
      `${CONTAINER.workspace}/docker/companion/theme.json`,
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

  // ---- state --------------------------------------------------------------

  async status(): Promise<ContainerStatus> {
    const res = await this.docker(["inspect", "--format", "{{.State.Running}}", this.cfg.container_name]);
    if (!res.ok) return { exists: false, running: false };
    return { exists: true, running: res.stdout.trim() === "true" };
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

  async ensureUp(onProgress?: (line: string) => void): Promise<EnsureOutcome> {
    const st = await this.status();
    if (st.running) return "adopted";
    if (st.exists) {
      const started = await this.docker(["start", this.cfg.container_name]);
      if (!started.ok) throw new Error(`docker start ${this.cfg.container_name} failed: ${errText(started)}`);
      return "started";
    }
    // Self-healing first run: build the image rather than failing on its absence.
    if (!(await this.imageExists())) await this.buildImage(onProgress);
    this.ensureDirs([this.cfg.feed_dir, this.cfg.alerts_dir]);
    const created = await this.docker(this.runArgv(), { timeoutMs: 120_000 });
    if (!created.ok) throw new Error(`docker run ${this.cfg.image} failed: ${errText(created)}`);
    return "created";
  }

  /** Idempotent: a live companion session is left strictly alone (a second
   * TUI attaches to it). Returns true when this call birthed the session. */
  async spawnPi(): Promise<boolean> {
    if (await this.piRunning()) return false;
    const res = await this.docker(this.spawnArgv());
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

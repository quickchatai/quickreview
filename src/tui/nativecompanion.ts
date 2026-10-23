// The companion without Docker: the same pi, on the host.
//
// Docker answering → the container companion, exactly as before
// (companion.ts). No Docker → this: a pi on the host, in a tmux server of its
// own (`tmux -L`), started with the very argv the container's pi gets — every
// extension in it, the guards included (companion-guard, inline-bash, the
// lens tool, the inject bridge, the tui-view tools) — so its bright lines are
// the same vetoes. What it does NOT have is the container: it runs as this
// user, it can read whatever this user can, and nothing structural keeps it
// out of the config home's secrets. That is said, every start, as an
// "unsandboxed" warning in the TUI. The companion boundary binds it all the same: it
// reaches the daemon only through the TUI-validated files, makes no GitHub
// write, and never touches the gate or `dry_run`.
//
// The container's paths become host paths by one table, the container's own
// mount table read backwards (`nativePathMap`): /workspace is the checkout,
// /opt/qcr the app root, the pi home the user's pi agent dir, and so on. The
// pi argv and its env are rewritten through it once, at spawn; the rollover's
// shell scripts are rewritten through it as they run (`nativeRunner`), so the
// sidebar, the rollover and the lifecycle keep speaking the one
// `docker exec <container> tmux …` dialect they already speak.
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { piCliPath } from "../picli.js";
import {
  CONTAINER,
  runCommand,
  SSH,
  type CompanionLifecycle,
  type ConfigMirrorOutcome,
  type DockerResult,
  type DockerRunner,
  type EnsureOutcome,
} from "./companion.js";

/** Which companion this TUI runs. */
export type CompanionKind = "docker" | "native";

/** The tmux server label (`tmux -L`) of the native companion: a server of
 * its own, never the user's default one. */
export const NATIVE_TMUX_LABEL = "qcr-companion";

/** What the column and the notices say about a native companion. */
export const UNSANDBOXED_WARNING =
  "UNSANDBOXED: no Docker here, so the companion runs as you on this host — its guards still veto, but no container walls it in";

/** The one choice: Docker answering → the container, else native. A probe
 * that throws is a Docker that did not answer. */
export async function chooseCompanionKind(
  dockerUp: () => Promise<boolean>,
): Promise<CompanionKind> {
  let up = false;
  try {
    up = await dockerUp();
  } catch {
    up = false;
  }
  return up ? "docker" : "native";
}

/** Is a Docker daemon answering? `docker info` through the given runner,
 * bounded; anything but a version on stdout is "no". */
export async function probeDocker(docker: DockerRunner): Promise<boolean> {
  const res = await docker(["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 5_000 });
  return res.ok && res.stdout.trim() !== "";
}

/** The pi agent dir the native companion uses: the user's own (where
 * `qcr login` logs in), `PI_CODING_AGENT_DIR` when set. */
export function nativeAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const set = env["PI_CODING_AGENT_DIR"]?.trim();
  return set ? set : join(env["HOME"] || homedir(), ".pi", "agent");
}

/**
 * Container path → host path, longest container path first: the companion
 * container's mount table (`CompanionLifecycle.mountSpec`) read backwards,
 * plus the three paths the image provides itself (the app root, the pi home
 * and its agent dir) and the config home the mounts sit inside. The ssh
 * mounts are left out: on the host, ssh is the host's own.
 */
export function nativePathMap(
  lc: Pick<CompanionLifecycle, "mountSpec" | "cfg">,
  host: { appRoot: string; agentDir: string; configHome: string },
): Array<[string, string]> {
  const map = new Map<string, string>();
  const skip = new Set<string>([
    CONTAINER.piHome,
    CONTAINER.tmuxDir,
    SSH.agent,
    SSH.config,
    SSH.knownHosts,
  ]);
  for (const m of lc.mountSpec()) if (!skip.has(m.dest)) map.set(m.dest, m.source);
  // The reviewed repo is mounted only when it is there; on the host its
  // configured path stands either way, and an absent one is refused by the
  // tools that read it, as the container's empty path is.
  if (!map.has(CONTAINER.reviewedRepo) && lc.cfg.reviewed_repo_dir !== "")
    map.set(CONTAINER.reviewedRepo, lc.cfg.reviewed_repo_dir);
  map.set(CONTAINER.app, host.appRoot);
  map.set(`${CONTAINER.piHome}/agent`, host.agentDir);
  map.set(CONTAINER.piHome, dirname(host.agentDir));
  if (!map.has(CONTAINER.configHome)) map.set(CONTAINER.configHome, host.configHome);
  return [...map.entries()].sort((a, b) => b[0].length - a[0].length);
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Rewrite every container path in `text` that stands as a path — at the
 * start, or after whitespace, `=`, `'`, `"` or `:`, and ending at a `/`, a
 * quote, whitespace or the end — to its host path. One pass, so a host path
 * is never rewritten again. */
export function toHostPaths(text: string, map: Array<[string, string]>): string {
  if (map.length === 0) return text;
  const alt = map.map(([dest]) => escapeRe(dest)).join("|");
  const re = new RegExp(`(^|[\\s='":])(${alt})(?=$|[/\\s'":;])`, "g");
  const lookup = new Map(map);
  return text.replace(re, (_m, lead: string, dest: string) => `${lead}${lookup.get(dest) ?? dest}`);
}

/** tmux commands that start a server when none is listening. */
const SERVER_STARTING = new Set(["new-session", "new", "start-server", "start"]);

export interface NativeRunnerDeps {
  /** Runs `bin argv…`; the real one spawns it. Injectable so tests never do. */
  run?: (bin: string, argv: string[], opts?: { timeoutMs?: number }) => Promise<DockerResult>;
  /** The tmux config a starting server reads (the image's own,
   * docker/vm/tmux.conf), when it exists. */
  tmuxConf?: string;
}

const refuse = (stderr: string): DockerResult => ({ ok: false, stdout: "", stderr, code: null });

/**
 * The `DockerRunner` the sidebar, the rollover and the lifecycle drive the
 * native companion through:
 *
 *   exec <name> tmux <args…>    →  tmux -L <label> [-f <conf>] <args…>
 *   exec <name> sh -c <script>  →  sh -c <script, container paths rewritten>
 *
 * The tmux args are passed as they are (send-keys carries what the operator
 * typed, and that is never rewritten). Anything else is refused by name: there
 * is no container to inspect, start or stop.
 */
export function nativeRunner(
  containerName: string,
  map: Array<[string, string]>,
  deps: NativeRunnerDeps = {},
): DockerRunner {
  const run = deps.run ?? runCommand;
  return async (argv, opts) => {
    if (argv[0] !== "exec" || argv[1] !== containerName)
      return refuse(
        `docker ${argv[0] ?? ""} is not available: no Docker here — the companion runs on the host`,
      );
    const [bin, ...rest] = argv.slice(2);
    if (bin === "tmux") {
      const word = rest.find((a) => !a.startsWith("-"));
      const conf =
        word !== undefined && SERVER_STARTING.has(word) && deps.tmuxConf
          ? ["-f", deps.tmuxConf]
          : [];
      return run("tmux", ["-L", NATIVE_TMUX_LABEL, ...conf, ...rest], opts);
    }
    if (bin === "sh" && rest[0] === "-c" && rest.length === 2)
      return run("sh", ["-c", toHostPaths(rest[1]!, map)], opts);
    return refuse(
      `exec ${bin ?? ""} is not available on the native companion — only tmux and sh -c reach it`,
    );
  };
}

export interface NativeCompanionDeps {
  /** The app root: where extensions/, prompts/ and docker/ live. */
  appRoot: string;
  /** The pi agent dir (`nativeAgentDir`). */
  agentDir: string;
  /** The install's config home (src/install.ts `configHome`). */
  configHome: string;
  /** The pinned pi's CLI. Default: `piCliPath()`. */
  piBin?: () => string;
  /** Runs a binary; default `runCommand`. */
  run?: NativeRunnerDeps["run"];
  /** Creates host dirs before the spawn. */
  ensureDirs?: (paths: string[]) => void;
  exists?: (path: string) => boolean;
}

/** The companion on the host. The same surface the TUI drives the container
 * companion through (`CompanionHost`), over the container lifecycle's own
 * argv and mount table. */
export class NativeCompanion {
  readonly kind = "native" as const;
  readonly map: Array<[string, string]>;
  readonly runner: DockerRunner;
  private readonly run: NonNullable<NativeRunnerDeps["run"]>;
  private readonly exists: (path: string) => boolean;

  constructor(
    private readonly lc: CompanionLifecycle,
    private readonly deps: NativeCompanionDeps,
  ) {
    this.map = nativePathMap(lc, deps);
    this.run = deps.run ?? runCommand;
    this.exists = deps.exists ?? existsSync;
    const conf = join(deps.appRoot, "docker", "vm", "tmux.conf");
    this.runner = nativeRunner(lc.cfg.container_name, this.map, {
      run: this.run,
      ...(this.exists(conf) ? { tmuxConf: conf } : {}),
    });
  }

  /** The container pi's argv, on the host: the pinned pi's own CLI in place
   * of the image's, every other path rewritten. Same extensions, same
   * order — the guards are in it because they are in the container's. */
  piArgv(): string[] {
    const [, ...rest] = this.lc.piArgv();
    const bin = (this.deps.piBin ?? piCliPath)();
    return [bin, ...rest.map((a) => toHostPaths(a, this.map))];
  }

  /** The container pi's `env QCR_…` prefix, its paths rewritten. */
  piEnvPrefix(): string[] {
    return this.lc.piEnvPrefix().map((a) => toHostPaths(a, this.map));
  }

  /** `exec <name> tmux new-session -d -s <session> env … pi …`, for the
   * native runner. */
  spawnArgv(): string[] {
    return [
      "exec",
      this.lc.cfg.container_name,
      "tmux",
      "new-session",
      "-d",
      "-s",
      this.lc.cfg.session,
      "-c",
      this.lc.cfg.repo_dir,
      ...this.piEnvPrefix(),
      ...this.piArgv(),
    ];
  }

  /** Nothing to start but the host dirs and a tmux to start it in. Says the
   * warning every time: a native companion is never silent about it. */
  async ensureUp(onProgress?: (line: string) => void): Promise<EnsureOutcome | "native"> {
    onProgress?.(UNSANDBOXED_WARNING);
    const tmux = await this.run("tmux", ["-V"], { timeoutMs: 5_000 });
    if (!tmux.ok)
      throw new Error(
        "no Docker here, and the companion runs on the host in tmux — install tmux (or Docker) to start it",
      );
    onProgress?.(
      this.lc.reviewedRepoPresent()
        ? `reviewed repo ${this.lc.cfg.reviewed_repo_dir} (read it — on the host nothing makes it read-only)`
        : `no reviewed repo at ${this.lc.cfg.reviewed_repo_dir} — companion starts without it ([companion] reviewed_repo_dir)`,
    );
    const homes = this.lc.hostHomes();
    const dirs = [
      this.lc.cfg.feed_dir,
      this.lc.cfg.alerts_dir,
      this.lc.cfg.evidence_dir,
      this.lc.hostInjectDir(),
      homes.profiles,
      homes.portrait,
      homes.configMirror,
      homes.state,
      homes.github,
      join(this.deps.agentDir, "sessions", this.lc.cfg.session),
    ];
    const ensureDirs =
      this.deps.ensureDirs ??
      ((ps: string[]): void => {
        for (const p of ps) mkdirSync(p, { recursive: true });
      });
    ensureDirs(dirs);
    return "native";
  }

  async piRunning(): Promise<boolean> {
    const res = await this.runner([
      "exec",
      this.lc.cfg.container_name,
      "tmux",
      "has-session",
      "-t",
      this.lc.cfg.session,
    ]);
    return res.ok;
  }

  /** Idempotent like the container's: a live session is adopted. */
  async spawnPi(): Promise<boolean> {
    if (await this.piRunning()) return false;
    const res = await this.runner(this.spawnArgv());
    if (!res.ok && (await this.piRunning())) return false;
    if (!res.ok)
      throw new Error(
        `spawning the companion pi session failed: ${(res.stderr.trim() || `exit ${res.code}`).split("\n").slice(-1)[0]}`,
      );
    return true;
  }

  /** Quit ends the session, as `docker stop` does for the container: the
   * conversation is on disk and the next start resumes it. Nothing to stop
   * is not an error. */
  async gracefulStop(): Promise<void> {
    await this.runner([
      "exec",
      this.lc.cfg.container_name,
      "tmux",
      "kill-session",
      "-t",
      this.lc.cfg.session,
    ]);
  }

  syncConfigMirror(): ConfigMirrorOutcome {
    return this.lc.syncConfigMirror();
  }

  hostInjectDir(): string {
    return this.lc.hostInjectDir();
  }

  hostHomes(): ReturnType<CompanionLifecycle["hostHomes"]> {
    return this.lc.hostHomes();
  }
}

/** What the TUI drives a companion through, whichever kind runs. */
export interface CompanionHost {
  ensureUp(onProgress?: (line: string) => void): Promise<string>;
  spawnPi(): Promise<boolean>;
  gracefulStop(): Promise<void>;
  syncConfigMirror(): ConfigMirrorOutcome;
  hostInjectDir(): string;
  hostHomes(): ReturnType<CompanionLifecycle["hostHomes"]>;
}

/**
 * The container companion or the native one, chosen once, at the first
 * bring-up (never before the first frame: the choice asks Docker). Until
 * then — and for good when Docker answers — everything is the container
 * lifecycle's. `runner` is the one seam the sidebar and the rollover hold;
 * it follows the choice.
 */
export class SelectingCompanion implements CompanionHost {
  private chosen: CompanionKind | undefined;
  private native: NativeCompanion | undefined;
  private choosing: Promise<CompanionKind> | undefined;

  constructor(
    private readonly container: CompanionLifecycle,
    private readonly containerRunner: DockerRunner,
    private readonly opts: {
      dockerUp: () => Promise<boolean>;
      makeNative: () => NativeCompanion;
      /** Told once, when the native companion is chosen. */
      onNative?: (native: NativeCompanion) => void;
    },
  ) {}

  /** The choice, made once; undefined until made. */
  get kind(): CompanionKind | undefined {
    return this.chosen;
  }

  readonly runner: DockerRunner = (argv, opts) =>
    (this.native ? this.native.runner : this.containerRunner)(argv, opts);

  /** Make the choice (once; concurrent callers share it). */
  select(): Promise<CompanionKind> {
    this.choosing ??= (async () => {
      const kind = await chooseCompanionKind(this.opts.dockerUp);
      if (kind === "native") {
        this.native = this.opts.makeNative();
        this.opts.onNative?.(this.native);
      }
      this.chosen = kind;
      return kind;
    })();
    return this.choosing;
  }

  private get host(): CompanionHost {
    return this.native ?? this.container;
  }

  async ensureUp(onProgress?: (line: string) => void): Promise<string> {
    await this.select();
    return this.host.ensureUp(onProgress);
  }

  async spawnPi(): Promise<boolean> {
    await this.select();
    return this.host.spawnPi();
  }

  gracefulStop(): Promise<void> {
    return this.host.gracefulStop();
  }

  syncConfigMirror(): ConfigMirrorOutcome {
    return this.host.syncConfigMirror();
  }

  hostInjectDir(): string {
    return this.host.hostInjectDir();
  }

  hostHomes(): ReturnType<CompanionLifecycle["hostHomes"]> {
    return this.host.hostHomes();
  }
}

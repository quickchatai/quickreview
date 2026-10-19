// The companion the host wrapper runs for a containerised TUI (D35).
//
// `qcr tui` in a container has no docker.sock. So the wrapper (scripts/qcr-host.sh,
// plain sh on the host) starts the companion container itself, and a second
// container runs the TUI. The wrapper does not know the companion's mounts: the
// image does, in `CompanionLifecycle`. `qcr companion plan` prints them as text
// lines the wrapper reads, so the sh side holds no copy of the mount list that
// could drift from the one tests pin:
//
//   name <container>     the companion container's name
//   plan <hash>          fingerprint of the run argv; the container carries it
//                        as a label, and a different one means a recreate
//                        (mount drift, a new image, a new flag)
//   mkdir <path>         a host dir to create as the caller before docker runs
//                        (docker would invent it root-owned)
//   tui-mount <path>     a host dir the TUI container mounts at its own path
//   tui-volume <v>:<dst> a named volume the TUI container mounts (the tmux socket)
//   tui-env <NAME=value> an env var for the TUI container
//   run <arg>            one argument of `docker run`, in order
//
// Every path is the host's own, and the TUI container mounts what it shares
// with the companion at the same path, so the config both derive from the same
// env resolves identically on either side.
//
// What the plan never contains: ~/.ssh, an ssh agent socket, docker.sock (rule 8
// and D35: the agent goes to the TUI container alone, the wrapper adds it).
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
import { COMPANION_DEFAULTS, type CompanionConfig } from "../config.js";
import { operatorStateHome } from "../install.js";
import {
  CompanionLifecycle,
  CONTAINER,
  companionInjectDir,
  tmuxVolume,
  type CompanionFs,
  type DockerRunner,
} from "./companion.js";

/** The host's own paths, handed to both containers by the wrapper. */
export const HOST_ENV_NAMES = [
  "QCR_HOST_HOME",
  "QCR_HOST_XDG_CONFIG_HOME",
  "QCR_HOST_XDG_STATE_HOME",
] as const;

/** The wrapper-run companion has a name and a pi home of its own, so it never
 * adopts, recreates or shares a login with a clone-route companion on the same
 * machine (the owner's dev TUI, `qcr companion up`). */
export const LAPTOP_COMPANION = {
  container_name: "qcr-tui-companion",
  pihome_volume: "qcr-companion-pihome",
} as const;

function absolute(name: string, value: string | undefined): string {
  const v = (value ?? "").trim();
  if (v === "" || !isAbsolute(v) || /[\n\r]/.test(v))
    throw new Error(`${name} must be an absolute path on one line (got ${JSON.stringify(value)})`);
  return v;
}

/**
 * The install env both containers derive their paths from: the host's HOME and
 * XDG dirs, with the config home at `<xdg config>/qcr` (so `profiles/` is the
 * ruled `~/.config/qcr/profiles`, D39) and the state home beside the host's
 * other qcr state. Never the container's own HOME. `QCR_CONFIG` passes through:
 * it names the config the TUI reads, and the companion's mirror is a copy of it.
 */
export function laptopInstallEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const home = absolute("QCR_HOST_HOME", env["QCR_HOST_HOME"]);
  const xdgConfig = (env["QCR_HOST_XDG_CONFIG_HOME"] ?? "").trim() || join(home, ".config");
  const xdgState = (env["QCR_HOST_XDG_STATE_HOME"] ?? "").trim() || join(home, ".local", "state");
  absolute("QCR_HOST_XDG_CONFIG_HOME", xdgConfig);
  absolute("QCR_HOST_XDG_STATE_HOME", xdgState);
  return {
    HOME: home,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_STATE_HOME: xdgState,
    QCR_CONFIG_HOME: join(xdgConfig, "qcr"),
    QCR_STATE_HOME: join(xdgState, "qcr", "home"),
    ...(env["QCR_INSTALL"] ? { QCR_INSTALL: env["QCR_INSTALL"] } : {}),
    ...(env["QCR_CONFIG"] ? { QCR_CONFIG: env["QCR_CONFIG"] } : {}),
  };
}

/**
 * The `[companion]` section of the wrapper-run companion: the channels
 * (`feed`, `alerts`, `evidence`, the workspace the inject dir lives in) are
 * host dirs under the operator state home, which no container mounts whole.
 * No tracker and no reviewed repo: under-equipped, never broken.
 */
export function laptopCompanionConfig(
  env: NodeJS.ProcessEnv,
  base: CompanionConfig = COMPANION_DEFAULTS,
): CompanionConfig {
  const ops = join(operatorStateHome(laptopInstallEnv(env)), "companion");
  return {
    ...base,
    ...LAPTOP_COMPANION,
    image: (env["QCR_IMAGE"] ?? "").trim() || base.image,
    repo_dir: join(ops, "workspace"),
    tracker_dir: "",
    tracker_docs_dir: "",
    reviewed_repo_dir: "",
    evidence_dir: join(ops, "evidence"),
    feed_dir: join(ops, "feed"),
    alerts_dir: join(ops, "alerts"),
    build_context: "",
  };
}

/** The lifecycle of the wrapper-run companion, for a process that has none of
 * the host's files (the planner, or the TUI container). */
export function laptopLifecycle(
  env: NodeJS.ProcessEnv,
  docker: DockerRunner,
  base?: CompanionConfig,
): CompanionLifecycle {
  // No file of the host is visible from here, and none is asked about: a
  // present-or-not decision (the reviewed repo) is already made by the config.
  const fs: CompanionFs = { exists: () => false, read: () => undefined, mode: () => undefined };
  return new CompanionLifecycle(
    laptopCompanionConfig(env, base),
    docker,
    laptopInstallEnv(env),
    () => {},
    fs,
    () => "",
    "tmux-socket",
  ).withoutMemory();
}

export interface CompanionPlan {
  name: string;
  hash: string;
  mkdirs: string[];
  tuiMounts: string[];
  /** `<volume>:<destination>` */
  tuiVolumes: string[];
  tuiEnv: string[];
  run: string[];
}

const noDocker: DockerRunner = async () => ({
  ok: false,
  stdout: "",
  stderr: "the planner runs no docker",
  code: null,
});

/** What the wrapper needs to run the companion and to mount its shared dirs
 * into the TUI container. Pure over `env`. */
export function companionPlan(env: NodeJS.ProcessEnv): CompanionPlan {
  const lc = laptopLifecycle(env, noDocker);
  const homes = lc.hostHomes();
  const cfg = lc.cfg;
  const inject = dirname(companionInjectDir(cfg));
  const mkdirs = [
    cfg.repo_dir,
    inject,
    cfg.feed_dir,
    cfg.alerts_dir,
    cfg.evidence_dir,
    homes.profiles,
    homes.portrait,
    homes.configMirror,
    homes.state,
    homes.github,
  ];
  // What the TUI reads or writes of the companion's files, at the host's paths.
  const tuiMounts = [
    cfg.feed_dir,
    cfg.alerts_dir,
    cfg.evidence_dir,
    inject,
    homes.configMirror,
    homes.state,
    homes.github,
  ];
  const run = lc.runArgv();
  const hash = createHash("sha256").update(run.join("\n")).digest("hex").slice(0, 16);
  // After `run --detach`: the label is read back by the wrapper to tell a
  // current container from a drifted one.
  run.splice(2, 0, "--label", `qcr.plan=${hash}`);
  const installEnv = laptopInstallEnv(env);
  const tuiEnv = [
    ...HOST_ENV_NAMES.map((n) => `${n}=${env[n] ?? ""}`).filter((l) => !l.endsWith("=")),
    `QCR_STATE_HOME=${installEnv.QCR_STATE_HOME ?? ""}`,
    `QCR_IMAGE=${cfg.image}`,
  ];
  return {
    name: cfg.container_name,
    hash,
    mkdirs: unique(mkdirs),
    tuiMounts: unique(tuiMounts),
    tuiVolumes: [`${tmuxVolume(cfg)}:${CONTAINER.tmuxDir}`],
    tuiEnv,
    run,
  };
}

function unique(xs: string[]): string[] {
  return [...new Set(xs)];
}

/** The plan as the lines the wrapper reads. A value with a newline would split
 * a line, so it is refused rather than escaped. */
export function renderPlan(plan: CompanionPlan): string {
  const lines: Array<[string, string]> = [
    ["name", plan.name],
    ["plan", plan.hash],
    ...plan.mkdirs.map((p): [string, string] => ["mkdir", p]),
    ...plan.tuiMounts.map((p): [string, string] => ["tui-mount", p]),
    ...plan.tuiVolumes.map((v): [string, string] => ["tui-volume", v]),
    ...plan.tuiEnv.map((e): [string, string] => ["tui-env", e]),
    ...plan.run.map((a): [string, string] => ["run", a]),
  ];
  for (const [kind, value] of lines)
    if (/[\n\r]/.test(value)) throw new Error(`plan: a ${kind} value holds a newline`);
  return lines.map(([k, v]) => `${k} ${v}`).join("\n") + "\n";
}

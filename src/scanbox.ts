// The scan sandbox: where `qcr scan start` (and `stage2 start`) drives a run
// when `[scan] sandbox = "docker"` — the default. Instead of a detached host
// process, the launch runs the same `qcr scan … --foreground` driver in a
// throwaway container (`docker run --rm`) from the companion image, which
// carries the built app at /opt/qcr (docker/companion/Dockerfile). The
// container sees only what a scan needs:
//
//   the reviewed repo         /reviewed-repo         read-only
//   (a worktree's git dir     at its own host path   read-only)
//   the install's state home  /qcr-state             read-write — the run
//                             record, findings, ledger, transcripts, lease,
//                             stop channel and driver log stay on the host,
//                             so every other `qcr scan` verb reads them there
//   the scan's pi home        /home/companion/.pi    a named volume of its own
//   a copy of the live config /qcr-config/live       read-only
//   the repo profiles         /qcr-config/profiles   read-only
//
// No /workspace, no ssh, no tracker, no GitHub token, no evidence. The network
// is unrestricted (the model provider), and the memory wiring is the
// companion's own (its docker network and key file), so the run's memory
// notes are written as they are from the companion.
//
// The started handshake: the driver inside writes its start outcome to a
// file in the state home named by its env (`writeStartedFile`); the launch
// polls for it, watching the container, and gives up after the same bound as
// a host launch — removing the container. A run ends with the container
// (`--rm`); `qcr scan stop` reaches it through the stop channel, and a
// container that dies lets the driver lease lapse, as a host driver does.
//
// Before any of that, the image's build stamp must be the checkout's
// (src/appstamp.ts): a container never drives a scan with other code.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { appStamp } from "./appstamp.js";
import type { ScanSandboxConfig } from "./config.js";
import {
  configHome,
  installName,
  PROFILES_DIR,
  scanConfigMirrorDir,
  stateHome,
  type InstallEnv,
} from "./install.js";
import { DETACH_TIMEOUT_MS, DRIVER_LOG, prepareDriverLog } from "./scandriverlog.js";
import {
  CONTAINER,
  dockerFailureLine,
  memoryEnvArgv,
  mirrorConfigFile,
  PUBLIC_DNS,
  runCommand,
  type ConfigMirrorOutcome,
  type DockerResult,
  type DockerRunner,
  type MemoryWiring,
} from "./tui/companion.js";

/** What a launch answers: the run the driver recorded (as `qcr scan`'s
 * `DetachOutcome` carries it — `R` is its run record), its log and, from a
 * sandbox, its container; or a refusal. */
export type StartOutcome<R = unknown> =
  { ok: true; run: R; log: string; container?: string } | { ok: false; errors: string[] };

/** In-container paths of a scan sandbox. The image fixes the app's and the
 * pi home's; the rest are the companion's own mount points, so code inside
 * resolves the same homes either way. */
export const SCANBOX = {
  app: "/opt/qcr",
  cli: "/opt/qcr/dist/src/cli.js",
  reviewedRepo: CONTAINER.reviewedRepo,
  stateHome: CONTAINER.stateHome,
  configHome: CONTAINER.configHome,
  configLive: CONTAINER.configLive,
  configFile: CONTAINER.configFile,
  profiles: CONTAINER.profiles,
  piHome: CONTAINER.piHome,
} as const;

/** The image label carrying the build stamp. */
export const STAMP_LABEL = "qcr.build-sha";
/** Set in a scan sandbox: the process is the driver inside, so the
 * `[companion]` checkout and tracker (host paths) are not read, and no
 * further sandbox is launched. */
export const IN_SANDBOX_ENV = "QCR_IN_SCAN_SANDBOX";
/** Where the driver inside writes its start outcome. */
export const STARTED_FILE_ENV = "QCR_SCAN_STARTED_FILE";
/** Where the entrypoint sends the container's output (the driver log). */
export const DRIVER_LOG_ENV = "QCR_DRIVER_LOG";
/** Under the state home: the started handshake files. */
export const STARTED_DIR = "scan/started";
/** How often the launch looks for the outcome. */
export const STARTED_POLL_MS = 500;
/** The doctor's one-shot pi answers within this. */
export const PI_PROBE_TIMEOUT_MS = 90_000;
export const PI_PROBE_PROMPT = "Reply with the single word OK.";

export interface ScanMount {
  dest: string;
  source: string;
  mode?: "ro" | "rw";
}

/** One container's worth of resolved inputs. */
export interface ScanBoxPlan {
  name: string;
  image: string;
  pihomeVolume: string;
  /** Host path of the reviewed checkout. */
  reviewedRepo: string;
  /** Host git dirs outside the checkout (a worktree's), mounted where they sit. */
  gitDirs: string[];
  stateHome: string;
  configMirror: string;
  profiles: string;
  install: string;
  token: string;
  memory: MemoryWiring;
}

/** Every mount a scan container gets, in `docker run` order. */
export function scanMounts(p: ScanBoxPlan): ScanMount[] {
  return [
    { dest: SCANBOX.reviewedRepo, source: p.reviewedRepo, mode: "ro" },
    ...p.gitDirs.map((d) => ({ dest: d, source: d, mode: "ro" as const })),
    { dest: SCANBOX.stateHome, source: p.stateHome, mode: "rw" },
    { dest: SCANBOX.piHome, source: p.pihomeVolume },
    { dest: SCANBOX.configLive, source: p.configMirror, mode: "ro" },
    { dest: SCANBOX.profiles, source: p.profiles, mode: "ro" },
  ];
}

/** The container's path of a state-home file. */
function inState(rel: string): string {
  return `${SCANBOX.stateHome}/${rel}`;
}

/** `docker run` for one scan driver: `argv` is the `qcr scan` subcommand
 * the host was given; the driver runs it in the foreground inside. */
export function scanRunArgv(p: ScanBoxPlan, argv: readonly string[]): string[] {
  const out = [
    "run",
    "--rm",
    "--detach",
    // A real PID 1: signals reach the driver, and the pi children it
    // leaves behind are reaped.
    "--init",
    "--name",
    p.name,
    "--label",
    `qcr.scan=${p.install}`,
  ];
  if (p.memory.network !== "") out.push("--network", p.memory.network);
  for (const ip of PUBLIC_DNS) out.push("--dns", ip);
  for (const m of scanMounts(p))
    out.push("--volume", `${m.source}:${m.dest}${m.mode ? `:${m.mode}` : ""}`);
  const env: Array<[string, string]> = [
    ["QCR_ROOT", SCANBOX.app],
    ["QCR_CONFIG", SCANBOX.configFile],
    ["QCR_CONFIG_HOME", SCANBOX.configHome],
    ["QCR_STATE_HOME", SCANBOX.stateHome],
    ["QCR_REVIEWED_REPO", SCANBOX.reviewedRepo],
    ["QCR_INSTALL", p.install],
    [IN_SANDBOX_ENV, "1"],
    [STARTED_FILE_ENV, inState(`${STARTED_DIR}/${p.token}.json`)],
    [DRIVER_LOG_ENV, inState(DRIVER_LOG)],
  ];
  for (const [k, v] of env) out.push("--env", `${k}=${v}`);
  out.push(...memoryEnvArgv(p.memory));
  out.push(p.image, "node", SCANBOX.cli, "scan", ...argv, "--foreground", "--json");
  return out;
}

/** `qcr scan login`: pi, interactive, over the scan's pi home — `/login`
 * there is what every scan container's pi then uses. */
export function scanLoginArgv(s: ScanSandboxConfig): string[] {
  return [
    "run",
    "--rm",
    "-it",
    ...PUBLIC_DNS.flatMap((d) => ["--dns", d]),
    "--volume",
    `${s.pihome_volume}:${SCANBOX.piHome}`,
    s.image,
    "pi",
  ];
}

/** The driver's side of the handshake: its start outcome, written whole
 * (aside, then renamed into place). */
export function writeStartedFile(path: string, outcome: StartOutcome): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(outcome)}\n`);
  renameSync(tmp, path);
}

// ---- the checks both the launch and the doctor make ------------------------------

/** The image's build stamp, or why it cannot be read. */
export async function imageStamp(
  docker: DockerRunner,
  image: string,
): Promise<{ ok: true; stamp: string | null } | { ok: false; missing: boolean; error: string }> {
  const r = await docker([
    "image",
    "inspect",
    "--format",
    `{{index .Config.Labels "${STAMP_LABEL}"}}`,
    image,
  ]);
  if (!r.ok) {
    const why = dockerFailureLine(r);
    return /no such image/i.test(why)
      ? { ok: false, missing: true, error: `the image ${image} is not built` }
      : { ok: false, missing: false, error: why };
  }
  const v = r.stdout.trim();
  return { ok: true, stamp: v === "" || v === "<no value>" ? null : v };
}

/** Why the image cannot drive a scan with this checkout's code, or null. */
export async function imageProblem(
  docker: DockerRunner,
  image: string,
  stamp: string,
): Promise<string | null> {
  const s = await imageStamp(docker, image);
  if (!s.ok)
    return s.missing
      ? `${s.error} — run \`qcr companion rebuild\``
      : `docker is not reachable (${s.error}) — the scan sandbox needs it; or set [scan] sandbox = "host"`;
  if (s.stamp === null)
    return `the image ${image} carries no build stamp — run \`qcr companion rebuild\``;
  if (s.stamp !== stamp)
    return `the image ${image} was built from other code (stamp ${s.stamp}; this checkout is ${stamp}) — run \`qcr companion rebuild\``;
  return null;
}

export type GitDirs = { ok: true; mounts: string[] } | { ok: false; error: string };

/** The git dirs a container needs mounted beside the checkout: none for a
 * plain clone; for a worktree, the repository's common dir (and its own
 * git dir when that sits elsewhere), each where it is on the host. */
export function hostGitDirs(repo: string): GitDirs {
  let out: string;
  try {
    out = execFileSync(
      "git",
      [
        "-c",
        `safe.directory=${repo}`,
        "-C",
        repo,
        "rev-parse",
        "--path-format=absolute",
        "--git-dir",
        "--git-common-dir",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (err) {
    const e = err as { stderr?: string | Buffer; message?: string };
    const why =
      String(e.stderr ?? "")
        .trim()
        .split("\n")[0] ||
      e.message ||
      String(err);
    return { ok: false, error: why };
  }
  const [gitDir = "", common = ""] = out.trim().split("\n");
  const inside = (p: string, dir: string): boolean => {
    const r = relative(dir, p);
    return r === "" || (!r.startsWith("..") && !isAbsolute(r));
  };
  const mounts: string[] = [];
  for (const d of [common, gitDir].map((x) => resolve(x))) {
    if (inside(d, repo) || mounts.some((m) => inside(d, m))) continue;
    mounts.push(d);
  }
  return { ok: true, mounts };
}

// ---- the launch -------------------------------------------------------------------

export interface ScanBoxDeps {
  docker: DockerRunner;
  /** The host's install env (the homes are located from it). */
  env: InstallEnv;
  sandbox: ScanSandboxConfig;
  /** Host path of the reviewed checkout; "" when none is set. */
  reviewedRepo: string;
  /** The app root whose build stamp the image must carry. */
  appRoot: string;
  /** The live config file, when there is one. */
  configSource: () => string | undefined;
  stamp?: () => string;
  gitDirs?: (repo: string) => GitDirs;
  /** The memory wiring (the companion's; degrades, never refuses). */
  memory?: () => Promise<MemoryWiring>;
  mirror?: (source: string, dir: string) => ConfigMirrorOutcome;
  token?: () => string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  pollMs?: number;
  logMax?: number;
}

/** A container name docker accepts, unique per launch. */
export function scanContainerName(install: string, token: string): string {
  return `qcr-scan-${install}-${token}`;
}

/** The scan sandbox's `detach`: check, launch the container, and resolve
 * with the driver's own start outcome (its log the host path, its container
 * named) — or a refusal. */
export function dockerDetach<R = unknown>(
  deps: ScanBoxDeps,
): (argv: string[]) => Promise<StartOutcome<R>> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());
  const timeoutMs = deps.timeoutMs ?? DETACH_TIMEOUT_MS;
  const pollMs = deps.pollMs ?? STARTED_POLL_MS;
  const refuse = (...errors: string[]): StartOutcome<R> => ({ ok: false, errors });
  return async (argv) => {
    const repo = deps.reviewedRepo.trim();
    if (repo === "")
      return refuse(
        "no reviewed repo is set — set [companion] reviewed_repo_dir (or QCR_REVIEWED_REPO) to the checkout to scan",
      );
    // `docker run` would invent an empty directory for a missing source,
    // and a scan of an empty tree reads as a clean repo.
    if (!existsSync(repo))
      return refuse(
        `no reviewed repo at ${repo} — set [companion] reviewed_repo_dir (or QCR_REVIEWED_REPO)`,
      );
    const source = deps.configSource();
    if (source === undefined)
      return refuse(
        "no live config to hand the scan container — `qcr install where` shows where it is looked for",
      );
    const problem = await imageProblem(
      deps.docker,
      deps.sandbox.image,
      (deps.stamp ?? (() => appStamp(deps.appRoot)))(),
    );
    if (problem !== null) return refuse(problem);
    const git = (deps.gitDirs ?? hostGitDirs)(repo);
    if (!git.ok) return refuse(`git cannot read the reviewed repo at ${repo}: ${git.error}`);
    const home = stateHome(deps.env);
    const mirrorDir = scanConfigMirrorDir(deps.env);
    const mirrored = (deps.mirror ?? mirrorConfigFile)(source, mirrorDir);
    if (typeof mirrored === "object")
      return refuse(`the config could not be copied for the container: ${mirrored.failed}`);
    const log = prepareDriverLog(home, deps.logMax);
    if (!log.ok) return refuse(log.error);
    const profiles = join(configHome(deps.env), PROFILES_DIR);
    try {
      // Created here, never by docker: a source docker invents is root-owned.
      for (const d of [join(home, STARTED_DIR), profiles]) mkdirSync(d, { recursive: true });
    } catch (err) {
      return refuse(`the scan container's directories cannot be made: ${String(err)}`);
    }
    const token = (deps.token ?? (() => randomBytes(4).toString("hex")))();
    const install = installName(deps.env);
    const memory = deps.memory
      ? await deps.memory()
      : { network: "", endpoint: "", notes: ["memory wiring not resolved"] };
    const plan: ScanBoxPlan = {
      name: scanContainerName(install, token),
      image: deps.sandbox.image,
      pihomeVolume: deps.sandbox.pihome_volume,
      reviewedRepo: repo,
      gitDirs: git.mounts,
      stateHome: home,
      configMirror: mirrorDir,
      profiles,
      install,
      token,
      memory,
    };
    const started = join(home, STARTED_DIR, `${token}.json`);
    const run = await deps.docker(scanRunArgv(plan, argv), { timeoutMs: 120_000 });
    if (!run.ok) return refuse(`the scan container could not start: ${dockerFailureLine(run)}`);
    const read = (): StartOutcome<R> | null => {
      let text: string;
      try {
        text = readFileSync(started, "utf8");
      } catch {
        return null;
      }
      rmSync(started, { force: true });
      try {
        const o = JSON.parse(text) as StartOutcome<R>;
        return o.ok ? { ...o, log: log.path, container: plan.name } : o;
      } catch {
        return refuse(`the scan driver's start outcome could not be read: ${started}`);
      }
    };
    const t0 = now();
    for (;;) {
      const o = read();
      if (o) return o;
      const st = await deps.docker(["inspect", "--format", "{{.State.Running}}", plan.name]);
      if (!st.ok || st.stdout.trim() !== "true") {
        // It may have written its outcome just before it went.
        const last = read();
        if (last) return last;
        return refuse(
          `the scan container ${plan.name} exited before the driver started — see ${log.path}`,
        );
      }
      if (now() - t0 >= timeoutMs) {
        await deps.docker(["rm", "-f", plan.name]);
        return refuse(
          `the scan driver did not say it started within ${Math.round(timeoutMs / 1000)}s — its container was removed; see ${log.path}`,
        );
      }
      await sleep(pollMs);
    }
  };
}

// ---- doctor -----------------------------------------------------------------------

export interface DoctorCheck {
  check: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

export interface DoctorReport {
  ok: boolean;
  sandbox: string;
  reviewed_repo: string;
  checks: DoctorCheck[];
}

export interface DoctorDeps {
  sandbox: ScanSandboxConfig;
  docker: DockerRunner;
  stamp: () => string;
  reviewedRepo: string;
  gitDirs?: (repo: string) => GitDirs;
  /** Whether a unit cut is saved, and what made it unreadable. */
  cut: () => { saved: boolean; problems: readonly string[] };
  /** The model the scan's stage 1 runs on — the login the probe needs. */
  model: string;
  /** `pi …` on this machine (sandbox = "host"); default the PATH's. */
  hostPi?: (argv: string[], opts: { timeoutMs: number }) => Promise<DockerResult>;
  piTimeoutMs?: number;
}

/** pi's one-shot probe arguments. */
function probeArgv(model: string): string[] {
  return ["-p", "--no-session", "--no-extensions", "--model", model, PI_PROBE_PROMPT];
}

/** `qcr scan doctor`: is this machine ready to run a scan where `[scan]
 * sandbox` says? Every check runs (a failed one never hides the next),
 * each failure naming its fix. */
export async function scanDoctor(d: DoctorDeps): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const timeoutMs = d.piTimeoutMs ?? PI_PROBE_TIMEOUT_MS;
  const LOGIN = "qcr scan login";
  if (d.sandbox.sandbox === "docker") {
    const v = await d.docker(["version", "--format", "{{.Server.Version}}"]);
    const reachable = v.ok;
    checks.push(
      reachable
        ? { check: "docker", ok: true, detail: `docker ${v.stdout.trim()}` }
        : {
            check: "docker",
            ok: false,
            detail: `docker is not reachable: ${dockerFailureLine(v)}`,
            fix: 'start docker (or set [scan] sandbox = "host")',
          },
    );
    if (!reachable) {
      checks.push(
        { check: "image", ok: false, detail: "not checked — docker is not reachable" },
        { check: "pihome", ok: false, detail: "not checked — docker is not reachable" },
      );
    } else {
      const problem = await imageProblem(d.docker, d.sandbox.image, d.stamp());
      checks.push(
        problem === null
          ? { check: "image", ok: true, detail: `${d.sandbox.image} matches this checkout` }
          : { check: "image", ok: false, detail: problem, fix: "qcr companion rebuild" },
      );
      checks.push(await pihomeCheck(d, problem === null, timeoutMs, LOGIN));
    }
  } else {
    const pi = d.hostPi ?? ((argv, o) => runCommand("pi", argv, o));
    const r = await pi(probeArgv(d.model), { timeoutMs });
    checks.push(
      r.ok
        ? { check: "pi", ok: true, detail: `pi on this machine answers on ${d.model}` }
        : {
            check: "pi",
            ok: false,
            detail: `pi on this machine did not answer on ${d.model}: ${dockerFailureLine(r)}`,
            fix: "install pi on the PATH, run `pi` and /login",
          },
    );
  }
  checks.push(repoCheck(d));
  const cut = d.cut();
  checks.push(
    cut.saved
      ? { check: "unit_cut", ok: true, detail: "a unit cut is saved" }
      : {
          check: "unit_cut",
          ok: false,
          detail:
            cut.problems.length > 0
              ? `the saved unit cut cannot be read: ${cut.problems.join("; ")}`
              : "no unit cut is saved — a scan reads by unit",
          fix: "qcr scan units propose, then qcr scan units show and qcr scan units save",
        },
  );
  return {
    ok: checks.every((c) => c.ok),
    sandbox: d.sandbox.sandbox,
    reviewed_repo: d.reviewedRepo,
    checks,
  };
}

async function pihomeCheck(
  d: DoctorDeps,
  imageOk: boolean,
  timeoutMs: number,
  login: string,
): Promise<DoctorCheck> {
  const vol = d.sandbox.pihome_volume;
  // Asked first: `docker run -v` would create an empty volume.
  const exists = await d.docker(["volume", "inspect", vol]);
  if (!exists.ok)
    return {
      check: "pihome",
      ok: false,
      detail: `the scan pi home volume ${vol} does not exist — never logged in`,
      fix: login,
    };
  if (!imageOk)
    return { check: "pihome", ok: false, detail: "not checked — the image must match first" };
  const r = await d.docker(
    [
      "run",
      "--rm",
      ...PUBLIC_DNS.flatMap((x) => ["--dns", x]),
      "--volume",
      `${vol}:${SCANBOX.piHome}`,
      d.sandbox.image,
      "pi",
      ...probeArgv(d.model),
    ],
    { timeoutMs },
  );
  return r.ok
    ? { check: "pihome", ok: true, detail: `pi in ${vol} answers on ${d.model}` }
    : {
        check: "pihome",
        ok: false,
        detail: `pi in ${vol} did not answer on ${d.model}: ${dockerFailureLine(r)}`,
        fix: login,
      };
}

function repoCheck(d: DoctorDeps): DoctorCheck {
  const repo = d.reviewedRepo.trim();
  const fix = "set [companion] reviewed_repo_dir (or QCR_REVIEWED_REPO) to the checkout to scan";
  if (repo === "")
    return { check: "reviewed_repo", ok: false, detail: "no reviewed repo is set", fix };
  if (!existsSync(repo))
    return { check: "reviewed_repo", ok: false, detail: `no checkout at ${repo}`, fix };
  const git = (d.gitDirs ?? hostGitDirs)(repo);
  if (!git.ok)
    return {
      check: "reviewed_repo",
      ok: false,
      detail: `${repo} is not a git checkout git can read: ${git.error}`,
      fix,
    };
  return {
    check: "reviewed_repo",
    ok: true,
    detail:
      git.mounts.length > 0
        ? `${repo} (a worktree; its git dir ${git.mounts.join(", ")} is mounted read-only beside it)`
        : repo,
  };
}

/** The doctor's report in words: one line per check, its fix under it. */
export function renderDoctor(r: DoctorReport): string {
  const lines = [`Scan sandbox: ${r.sandbox}`];
  for (const c of r.checks) {
    lines.push(`${c.ok ? "✓" : "✗"} ${c.check} — ${c.detail}`);
    if (!c.ok && c.fix) lines.push(`  fix: ${c.fix}`);
  }
  const failed = r.checks.filter((c) => !c.ok).length;
  lines.push(failed === 0 ? "All checks pass." : `${failed} check(s) failed.`);
  return lines.join("\n");
}

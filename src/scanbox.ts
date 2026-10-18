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
//   the companion's pi agent  /pi-agent-src          read-only (its sessions
//   dir (its login)                                  hidden under a tmpfs)
//   the scan's pi home        /home/companion/.pi    a tmpfs, private to the run
//   a copy of the live config /qcr-config/live       read-only
//   the repo profiles         /qcr-config/profiles   read-only
//
// The login is the companion's: one login, refreshed by the companion alone.
// Before every case the driver copies its auth.json into the tmpfs pi home
// with the refresh token neutralised (src/scanauth.ts), so the scan never
// refreshes and never writes anything the companion reads; a case the access
// token would not outlive is refused.
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
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { appStamp } from "./appstamp.js";
import type { ScanSandboxConfig } from "./config.js";
import type { LoginSummary } from "./piauthcopy.js";
import {
  SCAN_AUTH_FIX,
  SCAN_AUTH_SRC_ENV,
  SCAN_CASE_AUTH_BUDGET_MS,
  scanAuthExpiring,
  scanAuthMissing,
} from "./scanauth.js";
import {
  configHome,
  installName,
  operatorStateHome,
  PROFILES_DIR,
  scanConfigMirrorDir,
  stateHome,
  type InstallEnv,
} from "./install.js";
import { DETACH_TIMEOUT_MS, DRIVER_LOG, prepareDriverLog } from "./scandriverlog.js";
import {
  appBuildProblem,
  appImageBuildArgv,
  CONTAINER,
  dockerFailureLine,
  IN_COMPANION_ENV,
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
  /** The companion's agent dir, read-only: the login the scan copies. */
  authSrc: "/pi-agent-src",
  /** The scan's own pi agent dir, on the tmpfs pi home. */
  agentDir: `${CONTAINER.piHome}/agent`,
  /** `qcr scan login`'s login (src/scanlogin.ts). */
  loginScript: "/opt/qcr/dist/src/scanlogin.js",
} as const;

/** The companion's pi home is its login: only its `agent/` dir is mounted. */
const AGENT_SUBPATH = "agent";

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
  /** A host path (bind), a volume name, or "" for a tmpfs. */
  source: string;
  mode?: "ro" | "rw";
  /** The volume's sub-directory mounted, not the whole volume. */
  subpath?: string;
  tmpfs?: true;
  /** A tmpfs's permission bits, octal. */
  tmpfsMode?: string;
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
  /** The memory env's non-secret half comes from `memory`; its key is this
   * file's alone — the reviewer key, never the companion's whole key file. */
  keysFile?: string;
  memory: MemoryWiring;
}

/** The login mounts: the companion's agent dir read-only at the source path
 * (its sessions hidden under an empty tmpfs) and a private tmpfs pi home the
 * copy is made in — never the companion's pi home at the pi home. */
export function loginMounts(pihomeVolume: string): ScanMount[] {
  return [
    { dest: SCANBOX.authSrc, source: pihomeVolume, subpath: AGENT_SUBPATH, mode: "ro" },
    { dest: `${SCANBOX.authSrc}/sessions`, source: "", tmpfs: true },
    // World-writable: docker makes a tmpfs root's, and the image's user
    // makes the agent dir in it.
    { dest: SCANBOX.piHome, source: "", tmpfs: true, tmpfsMode: "1777" },
  ];
}

/** The env that points the container's pi and driver at the copy. */
function loginEnvArgv(): string[] {
  return [
    "--env",
    `${SCAN_AUTH_SRC_ENV}=${SCANBOX.authSrc}`,
    "--env",
    `PI_CODING_AGENT_DIR=${SCANBOX.agentDir}`,
  ];
}

/** Every mount a scan container gets, in `docker run` order. */
export function scanMounts(p: ScanBoxPlan): ScanMount[] {
  return [
    { dest: SCANBOX.reviewedRepo, source: p.reviewedRepo, mode: "ro" },
    ...p.gitDirs.map((d) => ({ dest: d, source: d, mode: "ro" as const })),
    { dest: SCANBOX.stateHome, source: p.stateHome, mode: "rw" },
    ...loginMounts(p.pihomeVolume),
    { dest: SCANBOX.configLive, source: p.configMirror, mode: "ro" },
    { dest: SCANBOX.profiles, source: p.profiles, mode: "ro" },
  ];
}

/** One mount as docker's `--mount` spells it. Unlike `--volume`, a bind
 * whose source is missing fails rather than being created, and nothing in a
 * path can be read as a mode. A path holding a comma cannot be spelled
 * (`commaProblem` refuses it first). */
export function mountSpec(m: ScanMount): string {
  if (m.tmpfs)
    return [
      `type=tmpfs`,
      `dst=${m.dest}`,
      ...(m.tmpfsMode ? [`tmpfs-mode=${m.tmpfsMode}`] : []),
    ].join(",");
  const bind = m.source.startsWith("/");
  return [
    `type=${bind ? "bind" : "volume"}`,
    `src=${m.source}`,
    `dst=${m.dest}`,
    ...(m.subpath ? [`volume-subpath=${m.subpath}`] : []),
    ...(m.mode === "ro" ? ["readonly"] : []),
  ].join(",");
}

/** A path `--mount` cannot take, or null. */
function commaProblem(paths: readonly string[]): string | null {
  const bad = paths.find((p) => p.includes(","));
  return bad === undefined
    ? null
    : `the path ${bad} holds a comma, which docker's --mount cannot take — move or link it`;
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
  for (const m of scanMounts(p)) out.push("--mount", mountSpec(m));
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
  out.push(...loginEnvArgv());
  out.push(...memoryEnvArgv({ ...p.memory, keysFile: undefined }));
  if (p.keysFile) out.push("--env-file", p.keysFile);
  out.push(p.image, "node", SCANBOX.cli, "scan", ...argv, "--foreground", "--json");
  return out;
}

/** How `qcr scan login` reaches the companion's pi: the argv after
 * `docker`, which route, the line saying so — or why it cannot. */
export interface ScanLoginRoute {
  route: "exec" | "run";
  argv: string[];
  say: string;
  problem?: string;
}

/** `qcr scan login` logs the companion's pi in to `provider` — the login
 * every scan reads — straight through pi's own OAuth flow
 * (`SCANBOX.loginScript`). With the companion container running, inside it
 * (`docker exec`), so the companion stays the one process that writes its
 * login; otherwise in a throwaway container over its pi home volume,
 * read-write. A `[scan] pihome_volume` that is not the companion's is logged
 * in the throwaway way. */
export async function scanLoginRoute(
  docker: DockerRunner,
  s: ScanSandboxConfig,
  companion: { container_name: string; pihome_volume: string },
  provider: string,
): Promise<ScanLoginRoute> {
  const vol = s.pihome_volume;
  const script = ["node", SCANBOX.loginScript, "--provider", provider];
  if (vol === companion.pihome_volume) {
    const name = companion.container_name;
    const st = await docker(["inspect", "--format", "{{.State.Running}}", name]);
    if (st.ok && st.stdout.trim() === "true") {
      const has = await docker(["exec", name, "test", "-f", SCANBOX.loginScript]);
      return {
        route: "exec",
        argv: ["exec", "-it", name, ...script],
        say: `scan login: the companion container ${name} is running — logging its pi in to ${provider} inside it (pi home ${vol}, the login every scan reads).`,
        ...(has.ok
          ? {}
          : {
              problem: `the running companion ${name} runs an image without the login script — \`qcr companion rebuild\`, then \`qcr scan login\` again`,
            }),
      };
    }
  }
  return {
    route: "run",
    argv: [
      "run",
      "--rm",
      "-it",
      ...PUBLIC_DNS.flatMap((d) => ["--dns", d]),
      "--mount",
      mountSpec({ dest: SCANBOX.piHome, source: vol }),
      s.image,
      ...script,
    ],
    say:
      vol === companion.pihome_volume
        ? `scan login: the companion container ${companion.container_name} is not running — logging pi in to ${provider} in a throwaway container over its pi home ${vol} (the login every scan reads).`
        : `scan login: [scan] pihome_volume ${vol} is not the companion's — logging pi in to ${provider} in a throwaway container over it (the login every scan reads).`,
  };
}

// ---- the companion's login, read-only --------------------------------------------

/** Prints the login summary of the agent dir named by its argument
 * (`loginSummary`: providers and expiries, never a token). */
export const LOGIN_SUMMARY_SCRIPT =
  `const { readFileSync } = await import("node:fs");` +
  `const { loginSummary } = await import("${SCANBOX.app}/dist/src/piauthcopy.js");` +
  `let raw = "{}";` +
  `try { raw = readFileSync(process.argv[1] + "/auth.json", "utf8"); } catch {}` +
  `console.log(JSON.stringify(loginSummary(raw)));`;

/** Makes the refresh-disabled copy where the env says (`syncScanAuthFromEnv`),
 * for a token that outlives the doctor's probe. */
export const SCAN_AUTH_COPY_SCRIPT =
  `const { syncScanAuthFromEnv } = await import("${SCANBOX.app}/dist/src/scanauth.js");` +
  `syncScanAuthFromEnv(process.env, ${PI_PROBE_TIMEOUT_MS});`;

/** `docker run` reading the companion's login summary over a read-only mount. */
export function loginSummaryArgv(image: string, pihomeVolume: string): string[] {
  return [
    "run",
    "--rm",
    "--mount",
    mountSpec(loginMounts(pihomeVolume)[0]!),
    image,
    "node",
    "--input-type=module",
    "-e",
    LOGIN_SUMMARY_SCRIPT,
    SCANBOX.authSrc,
  ];
}

/** The companion's login, as the image reads it, or why it cannot be read. */
export async function readLoginSummary(
  docker: DockerRunner,
  image: string,
  pihomeVolume: string,
): Promise<{ ok: true; summary: LoginSummary } | { ok: false; error: string }> {
  const r = await docker(loginSummaryArgv(image, pihomeVolume), { timeoutMs: 60_000 });
  if (!r.ok) return { ok: false, error: dockerFailureLine(r) };
  const last = r.stdout.trim().split("\n").pop() ?? "";
  try {
    const parsed = JSON.parse(last) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new Error("not an object");
    return { ok: true, summary: parsed as LoginSummary };
  } catch {
    return { ok: false, error: `the login summary could not be read: ${last.slice(0, 200)}` };
  }
}

/** The earliest OAuth expiry in a login — the token a copy must outlive. */
function earliestExpiry(s: LoginSummary): { provider: string; expiresAt: number } | null {
  let out: { provider: string; expiresAt: number } | null = null;
  for (const [provider, c] of Object.entries(s))
    if (c.type === "oauth" && c.expires !== null && (out === null || c.expires < out.expiresAt))
      out = { provider, expiresAt: c.expires };
  return out;
}

/** "3h 12m" — a token's remaining life. */
export function lifeWords(ms: number): string {
  if (ms <= 0) return "expired";
  const m = Math.floor(ms / 60_000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  return d > 0 ? `${d}d ${h}h` : `${h}h ${m % 60}m`;
}

/** Why a scan cannot run on this login now, or null: no login at all, or
 * a token that would expire inside a case's budget. */
export function loginProblem(s: LoginSummary, now: number): string | null {
  if (Object.keys(s).length === 0) return scanAuthMissing(`${SCANBOX.authSrc}/auth.json`);
  const e = earliestExpiry(s);
  if (e !== null && e.expiresAt < now + SCAN_CASE_AUTH_BUDGET_MS)
    return scanAuthExpiring({ ...e, needMs: SCAN_CASE_AUTH_BUDGET_MS });
  return null;
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
      ? `${s.error} — run \`qcr scan rebuild\``
      : `docker is not reachable (${s.error}) — the scan sandbox needs it; or set [scan] sandbox = "host"`;
  if (s.stamp === null)
    return `the image ${image} carries no build stamp — run \`qcr scan rebuild\``;
  if (s.stamp !== stamp)
    return `the image ${image} was built from other code (stamp ${s.stamp}; this checkout is ${stamp}) — run \`qcr scan rebuild\``;
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

/** Under the operator state home: the scan container's key file — the
 * reviewer key alone (`reviewerKeyFile`). */
export const SCAN_KEYS_FILE = "scan-memory-keys.env";
/** The one key a scan writes memory with (src/setup/adapters.ts
 * `reviewerMemoryFromEnv`). */
const REVIEWER_KEY = "OPENVIKING_REVIEWER_KEY";

/** Write the reviewer key line of the wiring's key file, alone, to `dest`
 * (0600, written aside and renamed into place); "" when there is none to
 * pass — no key file, or no reviewer key in it (a stale `dest` is removed). */
export function reviewerKeyFile(memory: MemoryWiring, dest: string): string | { failed: string } {
  try {
    const text = memory.keysFile ? readFileSync(memory.keysFile, "utf8") : "";
    const line = text.split("\n").find((l) => l.startsWith(`${REVIEWER_KEY}=`));
    if (line === undefined) {
      rmSync(dest, { force: true });
      return "";
    }
    mkdirSync(dirname(dest), { recursive: true });
    const tmp = `${dest}.${process.pid}.tmp`;
    writeFileSync(tmp, `${line}\n`, { mode: 0o600 });
    renameSync(tmp, dest);
    return dest;
  } catch (err) {
    return { failed: `the scan container's memory key could not be prepared: ${String(err)}` };
  }
}

/** Remove the handshake files no launch can still be waiting for: older
 * than the launch bound. Best effort. */
function sweepStarted(dir: string, olderThanMs: number): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - olderThanMs;
  for (const n of names) {
    const p = join(dir, n);
    try {
      if (statSync(p).mtimeMs < cutoff) rmSync(p, { force: true });
    } catch {
      // Gone already.
    }
  }
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
    const repoComma = commaProblem([repo]);
    if (repoComma !== null) return refuse(repoComma);
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
    // Asked, never assumed: `docker run` would create the volume empty, and
    // every case would then fail on a pi that is not logged in.
    const vol = deps.sandbox.pihome_volume;
    const volume = await deps.docker(["volume", "inspect", vol]);
    if (!volume.ok)
      return refuse(
        /no such volume/i.test(dockerFailureLine(volume))
          ? `the companion's pi home volume ${vol} does not exist — run \`qcr scan login\` to log the companion's pi in`
          : `the companion's pi home volume ${vol} cannot be inspected: ${dockerFailureLine(volume)}`,
      );
    // The login is read before anything starts: a token the first case
    // would not outlive is refused here, not case by case.
    const login = await readLoginSummary(deps.docker, deps.sandbox.image, vol);
    if (!login.ok)
      return refuse(`the companion's pi login in ${vol} cannot be read: ${login.error}`);
    const loginWhy = loginProblem(login.summary, now());
    if (loginWhy !== null) return refuse(loginWhy);
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
    const comma = commaProblem([...git.mounts, home, mirrorDir, profiles]);
    if (comma !== null) return refuse(comma);
    sweepStarted(join(home, STARTED_DIR), timeoutMs);
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
    const keys = reviewerKeyFile(memory, join(operatorStateHome(deps.env), SCAN_KEYS_FILE));
    if (typeof keys === "object") return refuse(keys.failed);
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
      ...(keys !== "" ? { keysFile: keys } : {}),
      memory,
    };
    const started = join(home, STARTED_DIR, `${token}.json`);
    // One bound over the whole launch: what `docker run` takes is gone from
    // the wait for the driver.
    const t0 = now();
    const left = (): number => Math.max(0, timeoutMs - (now() - t0));
    const run = await deps.docker(scanRunArgv(plan, argv), { timeoutMs: Math.max(1, left()) });
    if (!run.ok) {
      // A run that timed out may still have made its container.
      await deps.docker(["rm", "-f", plan.name]);
      return refuse(`the scan container could not start: ${dockerFailureLine(run)}`);
    }
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
      if (left() <= 0) {
        await deps.docker(["rm", "-f", plan.name]);
        // It may have answered while it was being removed.
        const late = read();
        if (late) return late;
        return refuse(
          `the scan driver did not say it started within ${Math.round(timeoutMs / 1000)}s — its container was removed; see ${log.path}`,
        );
      }
      await sleep(Math.min(pollMs, Math.max(1, left())));
    }
  };
}

// ---- where, and with what image ----------------------------------------------------

/** What the companion container's CLI is told about its sandbox. */
export const IN_COMPANION_NOTE =
  "inside the companion container — [scan] sandbox defaults to host there";

/** The sandbox a run here uses: the configured one, except that an unset
 * `[scan] sandbox` is `host` inside the companion container — which its env
 * says (`IN_COMPANION_ENV`), or which a `/workspace` mount with no docker
 * reachable gives away. There, `host` is the container itself. */
export async function effectiveSandbox(
  s: ScanSandboxConfig,
  o: {
    env: NodeJS.ProcessEnv;
    exists: (path: string) => boolean;
    docker: DockerRunner;
  },
): Promise<{ sandbox: ScanSandboxConfig; note?: string }> {
  if (s.sandbox_set || s.sandbox === "host") return { sandbox: s };
  const host = { sandbox: { ...s, sandbox: "host" as const }, note: IN_COMPANION_NOTE };
  if (o.env[IN_COMPANION_ENV]?.trim()) return host;
  if (!o.exists(CONTAINER.workspace)) return { sandbox: s };
  const v = await o.docker(["version", "--format", "{{.Server.Version}}"], { timeoutMs: 10_000 });
  return v.ok ? { sandbox: s } : host;
}

/** `qcr scan rebuild`: build `[scan] image` from the app root, stamped, and
 * nothing else — no container is removed, stopped or started, so a running
 * companion on the same image keeps running (it moves to the new image at
 * its own next recreate, `qcr companion rebuild`). */
export async function buildScanImage(o: {
  docker: DockerRunner;
  image: string;
  buildContext: string;
  exists: (path: string) => boolean;
  stamp: (root: string) => string;
  onProgress?: (line: string) => void;
}): Promise<{ ok: true; image: string; stamp: string } | { ok: false; errors: string[] }> {
  const problem = appBuildProblem(o.buildContext, o.exists);
  if (problem !== null) return { ok: false, errors: [problem] };
  const stamp = o.stamp(o.buildContext);
  o.onProgress?.(`building ${o.image} (stamp ${stamp}) — takes a few minutes…`);
  const r = await o.docker(appImageBuildArgv(o.image, o.buildContext, stamp), {
    timeoutMs: 1_800_000,
  });
  if (!r.ok)
    return { ok: false, errors: [`docker build ${o.image} failed: ${dockerFailureLine(r)}`] };
  return { ok: true, image: o.image, stamp };
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
  /** Why the sandbox is not the configured one, when it is not. */
  note?: string;
  reviewed_repo: string;
  checks: DoctorCheck[];
}

export interface DoctorDeps {
  sandbox: ScanSandboxConfig;
  /** Why `sandbox` is not the configured one (`effectiveSandbox`). */
  note?: string;
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
  now?: () => number;
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
          : { check: "image", ok: false, detail: problem, fix: "qcr scan rebuild" },
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
    ...(d.note ? { note: d.note } : {}),
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
  // Asked first: `docker run` would create an empty volume.
  const exists = await d.docker(["volume", "inspect", vol]);
  if (!exists.ok)
    return {
      check: "pihome",
      ok: false,
      detail: `the companion's pi home volume ${vol} does not exist — never logged in`,
      fix: login,
    };
  if (!imageOk)
    return { check: "pihome", ok: false, detail: "not checked — the image must match first" };
  const read = await readLoginSummary(d.docker, d.sandbox.image, vol);
  if (!read.ok)
    return {
      check: "pihome",
      ok: false,
      detail: `the login in ${vol} cannot be read: ${read.error}`,
      fix: login,
    };
  const provider = d.model.split("/")[0] ?? "";
  const cred = read.summary[provider];
  if (cred === undefined)
    return {
      check: "pihome",
      ok: false,
      detail: `no ${provider} login in ${vol} — the stage-1 model ${d.model} needs one`,
      fix: login,
    };
  const now = (d.now ?? Date.now)();
  const life =
    cred.expires === null
      ? `a ${cred.type} login (no expiry)`
      : `access token good for ${lifeWords(cred.expires - now)} (until ${new Date(cred.expires).toISOString()})`;
  const why = loginProblem(read.summary, now);
  if (why !== null)
    return {
      check: "pihome",
      ok: false,
      detail: `${vol}: ${provider} ${life} — ${why}`,
      fix: SCAN_AUTH_FIX,
    };
  // The probe runs the scan's own route: a refresh-disabled copy of the
  // read-only login in a private pi home, never the volume itself.
  const r = await d.docker(
    [
      "run",
      "--rm",
      ...PUBLIC_DNS.flatMap((x) => ["--dns", x]),
      ...loginMounts(vol).flatMap((m) => ["--mount", mountSpec(m)]),
      ...loginEnvArgv(),
      d.sandbox.image,
      "sh",
      "-c",
      'node --input-type=module -e "$0" && exec pi "$@"',
      SCAN_AUTH_COPY_SCRIPT,
      ...probeArgv(d.model),
    ],
    { timeoutMs },
  );
  return r.ok
    ? {
        check: "pihome",
        ok: true,
        detail: `${vol}: ${provider} ${life}; pi on a read-only copy answers on ${d.model}`,
      }
    : {
        check: "pihome",
        ok: false,
        detail: `${vol}: ${provider} ${life}; pi on a read-only copy did not answer on ${d.model}: ${dockerFailureLine(r)}`,
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
  const lines = [`Scan sandbox: ${r.sandbox}${r.note ? ` (${r.note})` : ""}`];
  for (const c of r.checks) {
    lines.push(`${c.ok ? "✓" : "✗"} ${c.check} — ${c.detail}`);
    if (!c.ok && c.fix) lines.push(`  fix: ${c.fix}`);
  }
  const failed = r.checks.filter((c) => !c.ok).length;
  lines.push(failed === 0 ? "All checks pass." : `${failed} check(s) failed.`);
  return lines.join("\n");
}

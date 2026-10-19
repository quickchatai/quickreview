// Shared machinery for the bring-up half of the wizard: everything
// the bring-up, verification, proof-round and go-live steps need to talk to
// the compose stack, in one place so the four steps cannot drift apart in how
// they name a service, reach the daemon, or restart it.
//
// The stack is the released images, pulled (`ghcr.io/quickchatai/quickreview`
// and `-memory`, pinned by QCR_VERSION in the project `.env`): nothing here
// builds the app. Only the tunnel sidecars are built, from the thin wrappers in
// docker/tunnel/ that the release image carries.
//
// Two seams live here:
//
//   * `ProcessRunner` (the engine adapter) for every short command — compose
//     ps, an exec into the daemon, reading a file out of the container. These
//     answer in seconds and their whole output matters.
//   * `StreamRunner` (a step option, defaulted here) for the long ones — the
//     first `docker compose pull` downloads two images, the memory one with
//     its embedding model inside, and runs for minutes. The engine's runner
//     returns only when the child is done and caps its wait at a minute, so a
//     pull driven through it would look like a hang and then fail on a
//     timeout. The streaming runner reports every line as it arrives and has
//     no timeout of its own. Same discipline as the GitHub App step's
//     callback-server seam: an extra injectable that tests replace wholesale,
//     never a second ambient I/O path.
//
// The wizard may itself run inside the release image (`qcr onboard`), where
// there is no Docker (the image never carries docker.sock or a docker CLI).
// Then it cannot pull or start anything: `hostCommands` renders the exact
// commands for the HOST instead, and the bring-up step prints them.

// Nothing here knows about GitHub, and nothing here writes config.toml — the
// only step that may touch `dry_run` is golive.ts, and it is the only
// onboarding file that writes that key at all (root CLAUDE.md rule 1).
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sandboxRoot as packageRoot } from "../../config.js";
import {
  readTextOrNull,
  sandboxRoot,
  writeAtomic,
  type CheckResult,
  type OnboardAdapters,
  type ProcessResult,
  type ProcessRunner,
  type StepContext,
} from "../engine.js";
import {
  INGRESS_CHOICE_KEY,
  isUp,
  optionFor,
  parseComposePs,
  readEnvKey,
  readTomlKey,
  secretsDirFor,
  type IngressOption,
  type RunningService,
} from "./ingress.js";

// The wizard's shared file helpers, re-exported for the steps that reach them
// through this module.
export { isUp, readTextOrNull, secretsDirFor, writeAtomic };

/** The compose service that runs the daemon (docker-compose.yml). */
export const DAEMON_SERVICE = "daemon";
/** The compose service that runs the memory sidecar (docker/memory/). */
export const MEMORY_SERVICE = "memory";

/** The released images (docker/Dockerfile, docker/memory/Dockerfile), tagged
 * by version: what .github/workflows/release.yml pushes. */
export const RELEASE_IMAGE_REPO = "ghcr.io/quickchatai/quickreview";
export const MEMORY_IMAGE_REPO = "ghcr.io/quickchatai/quickreview-memory";

/** Where the container roots its state — the same absolute path the ingress
 * step's hostname check and the docs use (the release image's app root is
 * /opt/qcr, and <root>/state is its one writable directory). */
export const CONTAINER_STATE_DIR = "/opt/qcr/state";
export const CONTAINER_DRYRUN_DIR = `${CONTAINER_STATE_DIR}/dryrun`;

/** `<sandbox root>` — the engine's contract is stateDir = `<root>/state`. */
export function rootOf(adapters: OnboardAdapters): string {
  return sandboxRoot(adapters.paths);
}

/** The live config.toml — the install locator's answer, captured on the
 * adapters. Never `<root>/config.toml` built here. */
export function configPath(adapters: OnboardAdapters): string {
  return adapters.paths.configPath;
}

/** The live install locator owns the config path on every resumed step. */
export function interviewConfigPath(ctx: StepContext): string {
  return configPath(ctx.adapters);
}

export function readConfigText(adapters: OnboardAdapters): string | null {
  return readTextOrNull(configPath(adapters));
}

export function readEnvText(root: string): string {
  return readTextOrNull(join(root, ".env")) ?? "";
}

/** The image tag the stack runs: the project `.env`'s QCR_VERSION (the pin an
 * earlier bring-up wrote, which a later wizard run must not silently move),
 * else the version of the package this wizard is running from. "" when
 * neither gives one: there is no floating `latest` tag (release.yml), so the
 * caller reports a failed check ("set QCR_VERSION") rather than name an image
 * that does not exist. */
export function releaseVersion(root: string): string {
  const pinned = (readEnvKey(readEnvText(root), "QCR_VERSION") ?? "").trim();
  if (pinned !== "") return pinned;
  try {
    const pkg = JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8")) as {
      version?: unknown;
    };
    if (typeof pkg.version === "string" && pkg.version !== "") return pkg.version;
  } catch {
    // no package.json to read: the empty answer below, which callers turn into a failed check
  }
  return "";
}

export function releaseImage(version: string): string {
  return `${RELEASE_IMAGE_REPO}:${version}`;
}

export function memoryImage(version: string): string {
  return `${MEMORY_IMAGE_REPO}:${version}`;
}

/** The ingress shape the operator picked, or null when none is recorded. */
export function ingressOptionOf(choices: Readonly<Record<string, unknown>>): IngressOption | null {
  return optionFor(String(choices[INGRESS_CHOICE_KEY] ?? ""));
}

// ---- compose command construction -------------------------------------------

/** Every compose invocation the onboarding steps make, built in one place. */
export function composeArgs(root: string, rest: readonly string[]): string[] {
  return ["compose", "--project-directory", root, ...rest];
}

/** `docker compose [--profile p] pull --ignore-buildable`: the two released
 * images. The tunnel sidecars are built from their wrappers, not pulled, so
 * they are skipped (`--ignore-buildable`) rather than failing the pull. */
export function pullArgs(root: string, profile: string): string[] {
  const profileArgs = profile === "" ? [] : ["--profile", profile];
  return composeArgs(root, [...profileArgs, "pull", "--ignore-buildable"]);
}

/** `docker compose exec -T daemon <argv…>` — `-T` because there is no TTY. */
export function daemonExecArgs(root: string, argv: readonly string[]): string[] {
  return composeArgs(root, ["exec", "-T", DAEMON_SERVICE, ...argv]);
}

export async function daemonExec(
  runner: ProcessRunner,
  root: string,
  argv: readonly string[],
): Promise<ProcessResult> {
  return runner.run("docker", daemonExecArgs(root, argv));
}

export interface PsReport {
  /** Did `docker compose ps` itself run? (false ⇒ docker is unreachable.) */
  ok: boolean;
  rows: RunningService[];
  detail: string;
}

export async function composePs(runner: ProcessRunner, root: string): Promise<PsReport> {
  const ps = await runner.run("docker", composeArgs(root, ["ps", "--format", "json"]));
  if (ps.code !== 0) {
    return {
      ok: false,
      rows: [],
      detail: (ps.stderr || ps.stdout).trim() || `docker compose ps exited ${ps.code}`,
    };
  }
  return { ok: true, rows: parseComposePs(ps.stdout), detail: "" };
}

export function serviceRow(
  rows: readonly RunningService[],
  service: string,
): RunningService | undefined {
  return rows.find((r) => r.service === service);
}

// ---- the streaming runner ----------------------------------------------------

export interface StreamRunner {
  /** Run to completion, reporting each output line as it arrives. Never throws
   * — a missing binary is a nonzero code with the reason in stderr, exactly
   * like the engine's ProcessRunner. */
  run(cmd: string, args: readonly string[], onLine: (line: string) => void): Promise<ProcessResult>;
}

/**
 * The real one: spawn, split both streams into lines, and hand each line to
 * the caller as it arrives. Deliberately without a timeout — the first pull
 * downloads the memory image (its embedding model is a layer) over whatever
 * link the operator has and can legitimately run for many minutes; a timeout
 * here would kill exactly the case this exists for.
 */
export const nodeStreamRunner: StreamRunner = {
  run: (cmd, args, onLine) =>
    new Promise<ProcessResult>((resolvePromise) => {
      const child = spawn(cmd, [...args], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      // One partial line per stream: an unfinished stdout line must never be
      // spliced onto a line stderr completes in between.
      const pending = { out: "", err: "" };
      const feed = (chunk: string, into: "out" | "err"): void => {
        if (into === "out") stdout += chunk;
        else stderr += chunk;
        const lines = (pending[into] + chunk).split("\n");
        pending[into] = lines.pop() ?? "";
        for (const line of lines) if (line.trim() !== "") onLine(line.replace(/\r$/, ""));
      };
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (c: string) => feed(c, "out"));
      child.stderr?.on("data", (c: string) => feed(c, "err"));
      child.on("error", (err) => {
        resolvePromise({ code: 127, stdout, stderr: `${stderr}${String(err)}` });
      });
      child.on("close", (code) => {
        for (const rest of [pending.out, pending.err])
          if (rest.trim() !== "") onLine(rest.replace(/\r$/, ""));
        resolvePromise({ code: code ?? 1, stdout, stderr });
      });
    }),
};

// ---- the daemon's HTTP surface ----------------------------------------------

export const DEFAULT_WEBHOOK_PORT = 8787;

/**
 * Where the daemon's `GET /health` answers on this machine.
 *
 * compose publishes the webhook port as `${QCR_WEBHOOK_BIND:-127.0.0.1}:
 * ${QCR_WEBHOOK_PORT:-8787}:8787`, so the project `.env` is the authority for
 * both halves. A bind of 0.0.0.0 still answers on loopback, and loopback is
 * what the wizard probes — it never reaches for a routable address.
 */
export function healthUrl(root: string): string {
  const env = readEnvText(root);
  const raw = (readEnvKey(env, "QCR_WEBHOOK_PORT") ?? "").trim();
  const port = /^[0-9]{1,5}$/.test(raw) ? Number(raw) : DEFAULT_WEBHOOK_PORT;
  return `http://127.0.0.1:${port}/health`;
}

// ---- restart ----------------------------------------------------------------

/**
 * Restart the daemon so it re-reads config.toml (the loader runs once, at
 * boot). Streamed, because a restart re-runs the entrypoint. Returns one
 * check; a stack that is not up at all is reported as such rather than as a
 * failure — there is nothing to restart, and the next bring-up reads the new
 * config anyway.
 */
export async function restartDaemon(
  stream: StreamRunner,
  root: string,
  log: (line: string) => void,
  running: boolean,
): Promise<CheckResult> {
  if (!running) {
    return {
      name: "daemon-restart",
      ok: true,
      detail:
        "the daemon is not running, so there is nothing to restart — it reads the new value the next time it starts",
    };
  }
  log("restarting the daemon so it re-reads config.toml (the config is read once, at boot)");
  const r = await stream.run("docker", composeArgs(root, ["restart", DAEMON_SERVICE]), (line) =>
    log(line),
  );
  return r.code === 0
    ? {
        name: "daemon-restart",
        ok: true,
        detail: "the daemon was restarted and is running with the value on disk",
      }
    : {
        name: "daemon-restart",
        ok: false,
        detail:
          `\`docker compose restart ${DAEMON_SERVICE}\` exited ${r.code}: ${(r.stderr || r.stdout).trim().slice(0, 400) || "no output"} — ` +
          "restart it by hand (`docker compose restart daemon`); the file on disk is already correct",
      };
}

// ---- small shared checks -----------------------------------------------------

/** The daemon container's state, as one check with its own fix. `memory`: the
 * stack also runs the memory sidecar (config.toml `[openviking]` is on), so
 * its container is checked too. */
export function containerStateCheck(
  ps: PsReport,
  ingress: IngressOption | null,
  opts: { memory?: boolean } = {},
): CheckResult[] {
  if (!ps.ok) {
    return [
      {
        name: "containers",
        ok: false,
        detail:
          `could not ask Docker what is running (${ps.detail}) — is the Docker daemon up, and are you in the directory ` +
          "with docker-compose.yml? Fix: start Docker, then run this step again",
      },
    ];
  }
  const checks: CheckResult[] = [];
  const daemon = serviceRow(ps.rows, DAEMON_SERVICE);
  checks.push(
    isUp(daemon)
      ? {
          name: "containers",
          ok: true,
          detail: `the ${DAEMON_SERVICE} container is ${daemon!.state}`,
        }
      : {
          name: "containers",
          ok: false,
          detail:
            `the ${DAEMON_SERVICE} container is ${daemon ? daemon.state : "not there at all"} — ` +
            "Fix: `docker compose logs --tail 200 daemon` says why it stopped; `docker compose up -d` starts it again",
        },
  );
  if (opts.memory) {
    const memory = serviceRow(ps.rows, MEMORY_SERVICE);
    checks.push(
      isUp(memory)
        ? {
            name: "memory-sidecar",
            ok: true,
            detail: `the ${MEMORY_SERVICE} sidecar is ${memory!.state}`,
          }
        : {
            name: "memory-sidecar",
            ok: false,
            detail:
              `the ${MEMORY_SERVICE} sidecar (OpenViking, the review memory) is ${memory ? memory.state : "not there at all"} — ` +
              "Fix: `docker compose logs --tail 200 memory` says why it stopped; `docker compose up -d` starts it again",
          },
    );
  }
  if (ingress?.service) {
    const sidecar = serviceRow(ps.rows, ingress.service);
    checks.push(
      isUp(sidecar)
        ? {
            name: "ingress-sidecar",
            ok: true,
            detail: `the ${ingress.service} tunnel sidecar is ${sidecar!.state}`,
          }
        : {
            name: "ingress-sidecar",
            ok: false,
            detail:
              `the ${ingress.service} sidecar (the ${ingress.id} ingress shape you chose) is ${sidecar ? sidecar.state : "not running"} — ` +
              `Fix: \`COMPOSE_PROFILES=${ingress.profile} docker compose up -d\`, then \`docker compose logs ${ingress.service}\` if it exits again`,
          },
    );
  }
  return checks;
}

/** Is the stack up enough for a step that needs to talk to the daemon? */
export async function daemonIsRunning(runner: ProcessRunner, root: string): Promise<boolean> {
  const ps = await composePs(runner, root);
  return ps.ok && isUp(serviceRow(ps.rows, DAEMON_SERVICE));
}

/** Repo-root helper shared by the steps' option resolution. */
export function contextRoot(ctx: StepContext): string {
  return rootOf(ctx.adapters);
}

/** Does config.toml leave memory on? Only an explicit `enabled = false` (a
 * declined memory setup) turns it off. */
export function memoryOn(configText: string): boolean {
  return readTomlKey(configText, "openviking", "enabled") !== "false";
}

/** Is there a compose file in the project directory to drive? */
export function composeFileCheck(root: string, version = releaseVersion(root)): CheckResult {
  const path = join(root, "docker-compose.yml");
  return existsSync(path)
    ? { name: "compose-file", ok: true, detail: `${path} is the stack this step drives` }
    : {
        name: "compose-file",
        ok: false,
        detail: `${path} is missing — Fix: the release image carries it; in ${root} run \`${extractCommand(version)}\``,
      };
}

/** The one command that puts the compose file and the tunnel wrappers' build
 * context from the release image into the current directory. */
export function extractCommand(version: string): string {
  return (
    `docker run --rm --entrypoint tar ${releaseImage(version)} ` +
    "-C /opt/qcr -cf - docker-compose.yml docker/tunnel | tar -xf -"
  );
}

/** Can this process drive Docker Compose at all? `false` is the normal answer
 * inside the release image, which never carries a docker CLI or socket. */
export async function composeAvailable(runner: ProcessRunner): Promise<boolean> {
  const r = await runner.run("docker", ["compose", "version"]);
  return r.code === 0;
}

export interface HostCommandsInput {
  version: string;
  /** The directory on the host that holds the project (compose file, .env). */
  projectDir: string;
  /** The project .env's lines, `KEY=value`, in order. */
  env: readonly string[];
  /** Host directories to create first, as shell words (`mkdir -p`), so Docker
   * never creates the bind-mount sources as root. */
  dirs?: readonly string[];
  /** Shell-comment lines printed after the directories: what only the
   * operator can place there (the config and the secrets). */
  notes?: readonly string[];
  /** The compose profile the ingress step chose; "" is the daemon alone. */
  profile: string;
}

/**
 * The exact commands for the HOST, in order — what the wizard prints when it
 * cannot run Docker itself. No secret is in them: the .env holds paths,
 * a port, a uid, a version pin and the embedder's non-secret knobs; every
 * credential stays in the files the secrets directory already holds.
 */
export function hostCommands(input: HostCommandsInput): string[] {
  const profile = input.profile === "" ? [] : ["--profile", input.profile];
  const compose = ["docker", "compose", ...profile].join(" ");
  const dirs = input.dirs ?? [];
  return [
    `mkdir -p ${input.projectDir} && cd ${input.projectDir}`,
    ...(dirs.length > 0 ? [`mkdir -p ${dirs.join(" ")}`] : []),
    ...(input.notes ?? []),
    extractCommand(input.version),
    ["cat > .env <<'QCR_ENV'", ...input.env, "QCR_ENV"].join("\n"),
    `${compose} pull --ignore-buildable`,
    `${compose} up -d`,
  ];
}

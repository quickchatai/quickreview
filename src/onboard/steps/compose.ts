// Shared machinery for the bring-up half of the wizard: everything
// the bring-up, verification, proof-round and go-live steps need to talk to
// the compose stack, in one place so the four steps cannot drift apart in how
// they name a service, reach the daemon, or restart it.
//
// Two seams live here:
//
//   * `ProcessRunner` (the engine adapter) for every short command — compose
//     ps, an exec into the daemon, reading a file out of the container. These
//     answer in seconds and their whole output matters.
//   * `StreamRunner` (a step option, defaulted here) for the long ones — the
//     first `docker compose up --build` compiles the local embedder from
//     source and runs for tens of minutes. The engine's runner returns only
//     when the child is done and caps its wait at a minute, so a build driven
//     through it would look like a hang and then fail on a timeout. The
//     streaming runner reports every line as it arrives and has no timeout of
//     its own. Same discipline as the GitHub App step's callback-server seam:
//     an extra injectable that tests replace wholesale, never a second
//     ambient I/O path.
//
// Nothing here knows about GitHub, and nothing here writes config.toml — the
// only step that may touch `dry_run` is golive.ts, and it is the only
// onboarding file that writes that key at all (root CLAUDE.md rule 1).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
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
  secretsDirFor,
  type IngressOption,
  type RunningService,
} from "./ingress.js";

// The wizard's shared file helpers, re-exported for the steps that reach them
// through this module.
export { isUp, readTextOrNull, secretsDirFor, writeAtomic };

/** The compose service that runs the daemon (docker-compose.yml). */
export const DAEMON_SERVICE = "daemon";

/** Where the container roots its state — the same absolute path the ingress
 * step's hostname check and the docs use. */
export const CONTAINER_STATE_DIR = "/opt/quickreview/state";
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

export function readConfigText(adapters: OnboardAdapters): string | null {
  return readTextOrNull(configPath(adapters));
}

export function readEnvText(root: string): string {
  return readTextOrNull(join(root, ".env")) ?? "";
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
 * the caller as it arrives. Deliberately without a timeout — the first image
 * build compiles llama-cpp-python from source and legitimately runs for tens
 * of minutes; a timeout here would kill exactly the case this exists for.
 */
export const nodeStreamRunner: StreamRunner = {
  run: (cmd, args, onLine) =>
    new Promise<ProcessResult>((resolvePromise) => {
      const child = spawn(cmd, [...args], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let pending = "";
      const feed = (chunk: string, into: "out" | "err"): void => {
        if (into === "out") stdout += chunk;
        else stderr += chunk;
        pending += chunk;
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
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
        if (pending.trim() !== "") onLine(pending.replace(/\r$/, ""));
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

/** The daemon container's state, as one check with its own fix. */
export function containerStateCheck(ps: PsReport, ingress: IngressOption | null): CheckResult[] {
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

/** Does the checkout still look like a checkout? (A compose file we can drive.) */
export function composeFileCheck(root: string): CheckResult {
  const path = join(root, "docker-compose.yml");
  return existsSync(path)
    ? { name: "compose-file", ok: true, detail: `${path} is the stack this step drives` }
    : {
        name: "compose-file",
        ok: false,
        detail: `${path} is missing — Fix: run the wizard from the QuickReview checkout (the compose file ships with it)`,
      };
}

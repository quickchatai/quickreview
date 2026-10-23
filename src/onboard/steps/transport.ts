// The stack transport — THE ONE DECISION POINT for "where does this system
// actually run?".
//
// Bring-up, layered verification, the proof round and the go-live flip run
// either against `docker compose` on this machine or against a VM/server over
// ssh. They are written once, not twice with `ssh` in front of every command:
// exactly one function decides — `stackTransportFor(ctx)` — and every step
// asks IT for the four things it actually needs from the host: are the
// containers up, run this argv in the daemon, does health answer, restart so
// the daemon re-reads its config. The TUI follows the same discipline
// (`runnerFor(cfg)` in src/tui/remote.ts: one interface, two implementations,
// one place that picks). The steps keep their logic, their check names, their
// fix text and their tests; what changes underneath them is the transport.
//
// Two implementations, and they are NOT symmetrical, because the two topologies
// genuinely are not:
//
//   * compose — `docker compose …` here. Health is a plain fetch to the
//     published loopback port; a restart is `docker compose restart daemon`.
//     This transport delegates to the helpers in compose.ts rather than
//     re-deriving them.
//   * ssh — `ssh <alias> sudo docker …` there, with BatchMode on every hop (see
//     ssh.ts: a prompt is a hang, and a hang is the failure mode of this whole
//     route). Health is curl ON the box against its loopback publish, because
//     the daemon's port is deliberately not exposed off the VM. And a "restart"
//     is `scripts/deploy.sh release <version>` — on that route the config the
//     daemon reads is the one the release ships, so re-running the recorded
//     release IS the restart, with every one of its preflights intact. Never a hand-rolled
//     `ssh … docker restart` that would leave the box running a config nobody
//     shipped.
import { TUI_DEFAULTS } from "../../config.js";
import type { CheckResult, OnboardAdapters, ProcessResult, StepContext } from "../engine.js";
import {
  DAEMON_SERVICE,
  MEMORY_SERVICE,
  composeArgs,
  composePs,
  containerStateCheck,
  daemonExecArgs,
  daemonRootExecArgs,
  healthUrl,
  memoryOn,
  isUp,
  nodeStreamRunner,
  readConfigText,
  restartDaemon,
  rootOf,
  serviceRow,
  type StreamRunner,
} from "./compose.js";
import {
  effectiveInventoryPath,
  deployArgv,
  deployCommandLine,
  recordedReleaseVersion,
} from "./deploysh.js";
import { readTomlKey, type IngressOption } from "./ingress.js";
import { inventoryTargetMismatch } from "./inventory.js";
import { sshArgv, sshCommandLine } from "./ssh.js";
import { sshAliasOf, topologyOf } from "./topology.js";

export const DEFAULT_HEALTH_TIMEOUT_MS = 10_000;

export type TransportKind = "compose" | "ssh";

/** What a probe of the daemon's container found; `unknown` is a probe that failed. */
export type DaemonState =
  | { readonly state: "running" | "stopped" }
  | { readonly state: "unknown"; readonly detail: string };

/**
 * Everything the bring-up tail needs from the host the system runs on. Total
 * by construction: nothing here throws, and an unreachable host is a red check
 * with its own fix, never an exception.
 */
export interface StackTransport {
  readonly kind: TransportKind;
  /** One clause naming where these commands run, for a check detail. */
  readonly where: string;
  /** Layer 1 of verification: is the daemon (and the chosen ingress) up? */
  containerChecks(ingress: IngressOption | null): Promise<CheckResult[]>;
  /** Is the daemon up enough to talk to? A probe that failed reads false. */
  running(): Promise<boolean>;
  /**
   * The same probe, with a failed one kept apart from a daemon that is not
   * running: `unknown` carries why the host could not be asked.
   */
  daemonState(): Promise<DaemonState>;
  /** Run an argv INSIDE the daemon container. */
  exec(argv: readonly string[]): Promise<ProcessResult>;
  /** The same, as uid 0: the one way to write the root-sealed operator
   * command directory (`commands/operator/`), as `qcr drain` and the TUI's
   * levers do. Used for the operator's own commands only. */
  execAsRoot(argv: readonly string[]): Promise<ProcessResult>;
  /** Run an argv INSIDE the container that owns the memory engine: the memory
   * sidecar on the compose stack, `[tui] memory_container` (else the daemon's
   * container) on the server route. */
  execMemory(argv: readonly string[]): Promise<ProcessResult>;
  /** Layer 2 of verification: does the daemon answer `GET /health`? */
  health(): Promise<CheckResult>;
  /** Make the daemon re-read config.toml. */
  restart(log: (line: string) => void, running: boolean): Promise<CheckResult>;
  /** The command the OPERATOR types to read the daemon's log. */
  logsCommand(tail: number): string;
  /** The command the OPERATOR types to run something in the daemon container. */
  execCommand(rest: string): string;
  /** The command the OPERATOR types to run the daemon's own CLI. */
  cliCommand(rest: string): string;
}

export interface TransportOptions {
  /** Newly collected secrets need the host provisioning a release skips:
   * `provision` runs it first. The default is the release alone. */
  deploymentMode?: "release" | "provision";
  /** Long-running commands (the deploy that stands in for a restart). */
  stream?: StreamRunner;
  /** Health probe budget. */
  healthTimeoutMs?: number;
}

/**
 * THE decision point. Every step in the bring-up tail calls this and nothing
 * else; adding a third topology one day means adding one implementation and
 * one branch HERE, not touching four steps.
 */
export function stackTransportFor(ctx: StepContext, opts: TransportOptions = {}): StackTransport {
  return topologyOf(ctx.choices) === "vm" ? sshTransport(ctx, opts) : composeTransport(ctx, opts);
}

// ---- this computer -----------------------------------------------------------

function composeTransport(ctx: StepContext, opts: TransportOptions): StackTransport {
  const root = rootOf(ctx.adapters);
  const stream = opts.stream ?? nodeStreamRunner;
  const healthTimeoutMs = opts.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const daemonState = async (): Promise<DaemonState> => {
    const ps = await composePs(ctx.adapters.runner, root);
    if (!ps.ok) return { state: "unknown", detail: ps.detail };
    return { state: isUp(serviceRow(ps.rows, DAEMON_SERVICE)) ? "running" : "stopped" };
  };

  return {
    kind: "compose",
    where: "on this machine, through docker compose",

    async containerChecks(ingress) {
      const config = readConfigText(ctx.adapters);
      return containerStateCheck(await composePs(ctx.adapters.runner, root), ingress, {
        memory: config === null || memoryOn(config),
      });
    },

    async running() {
      return (await daemonState()).state === "running";
    },

    daemonState,

    async exec(argv) {
      return ctx.adapters.runner.run("docker", daemonExecArgs(root, argv));
    },

    async execAsRoot(argv) {
      return ctx.adapters.runner.run("docker", daemonRootExecArgs(root, argv));
    },

    async execMemory(argv) {
      return ctx.adapters.runner.run(
        "docker",
        composeArgs(root, ["exec", "-T", MEMORY_SERVICE, ...argv]),
      );
    },

    async health() {
      const url = healthUrl(root);
      return probeHealthOverHttp(ctx.adapters, url, healthTimeoutMs, {
        badStatus:
          "Fix: `docker compose logs --tail 200 daemon`. A daemon that started but cannot serve is nearly always a config.toml " +
          "the loader rejected; the log line says which key",
        notPayload:
          "Fix: something else is listening on that port. Change QCR_WEBHOOK_PORT in .env and run the bring-up step again",
        unreachable:
          "Fix: check the port is published (`docker compose ps`) and that QCR_WEBHOOK_PORT/QCR_WEBHOOK_BIND in .env match what " +
          "you are probing; then `docker compose logs --tail 200 daemon`",
      });
    },

    async restart(log, running) {
      return restartDaemon(stream, root, log, running);
    },

    logsCommand: (tail) => `docker compose logs --tail ${tail} daemon`,
    execCommand: (rest) => `docker compose exec ${DAEMON_SERVICE} ${rest}`,
    cliCommand: (rest) => `docker compose exec ${DAEMON_SERVICE} node dist/src/cli.js ${rest}`,
  };
}

// ---- a VM or server over ssh -------------------------------------------------

/** Where the VM's daemon container lives, read from config.toml's [tui] block
 * (the same values the operator TUI uses) with the shipped defaults. */
export interface RemoteFacts {
  alias: string;
  container: string;
  /** The container the memory engine runs in: `[tui] memory_container`, else `container`. */
  memoryContainer: string;
  sudo: boolean;
  port: number;
}

export function remoteFactsFor(
  adapters: OnboardAdapters,
  choices: Readonly<Record<string, unknown>>,
): RemoteFacts {
  const text = readConfigText(adapters);
  const container = (text ? readTomlKey(text, "tui", "container") : null)?.trim();
  const sudo = (text ? readTomlKey(text, "tui", "sudo_docker") : null)?.trim();
  const port = (text ? readTomlKey(text, "server", "port") : null)?.trim();
  const daemonContainer = container && container !== "" ? container : TUI_DEFAULTS.container;
  const memory = (text ? readTomlKey(text, "tui", "memory_container") : null)?.trim();
  return {
    alias: sshAliasOf(choices),
    container: daemonContainer,
    memoryContainer: memory && memory !== "" ? memory : daemonContainer,
    // The playbook's Docker socket is root-owned; sudo is the shipped default
    // and only an explicit `false` turns it off.
    sudo: sudo === undefined || sudo === "" ? TUI_DEFAULTS.sudo_docker : sudo !== "false",
    port: port && /^[0-9]{1,5}$/.test(port) ? Number(port) : 8787,
  };
}

/** The container names a `docker ps --format '{{.Names}}…'` listing shows,
 * one per row. Docker's `name=` filter matches substrings, so a caller picks
 * its container out of these by EXACT name — never by prefix. */
function psRows(stdout: string): Array<{ name: string; rest: string }> {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .map((l) => {
      const cut = l.search(/\s/);
      return cut < 0 ? { name: l, rest: "" } : { name: l.slice(0, cut), rest: l.slice(cut).trim() };
    });
}

/** deploy.sh's default `memory_container_name` for the VM sidecar. */
const DEPLOY_MEMORY_CONTAINER = "quickreview-memory";

function sshTransport(ctx: StepContext, opts: TransportOptions): StackTransport {
  const root = rootOf(ctx.adapters);
  const facts = remoteFactsFor(ctx.adapters, ctx.choices);
  // Shipping a changed config is a release of the version already deployed
  // (the config home rides every release); a host that needs its secrets
  // provisioned runs `provision` first.
  const version = recordedReleaseVersion(ctx.choices);
  const shipLine = (): string => {
    const release =
      version === null
        ? "scripts/deploy.sh release <version>"
        : deployCommandLine("release", { version });
    return opts.deploymentMode === "provision"
      ? `${deployCommandLine("provision")} && ${release}`
      : release;
  };
  const stream = opts.stream ?? nodeStreamRunner;
  const healthTimeoutS = Math.max(
    1,
    Math.ceil((opts.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS) / 1000),
  );
  const dockerPrefix = facts.sudo ? ["sudo", "docker"] : ["docker"];
  const memoryContainer = facts.memoryContainer;
  // The sidecar the stack check probes: the one `[tui] memory_container` names
  // apart from the daemon's container, else the sidecar scripts/deploy.sh always
  // deploys on the VM (`memory_container_name`), never the daemon's own name.
  const sidecarContainer =
    memoryContainer !== facts.container ? memoryContainer : DEPLOY_MEMORY_CONTAINER;
  const remote = (argv: readonly string[]): Promise<ProcessResult> =>
    ctx.adapters.runner.run("ssh", sshArgv(facts.alias, argv));
  const healthEndpoint = `http://127.0.0.1:${facts.port}/health`;
  const daemonState = async (): Promise<DaemonState> => {
    // No alias recorded: the server route was never deployed to.
    if (facts.alias === "") return { state: "stopped" };
    const ps = await remote([
      ...dockerPrefix,
      "ps",
      "--filter",
      `name=${facts.container}`,
      "--format",
      "{{.Names}}",
    ]);
    if (ps.code !== 0) {
      return {
        state: "unknown",
        detail: (ps.stderr || ps.stdout).trim().slice(0, 200) || `exit ${ps.code}`,
      };
    }
    return {
      state: psRows(ps.stdout).some((r) => r.name === facts.container) ? "running" : "stopped",
    };
  };
  const logsCommand = (tail: number): string =>
    sshCommandLine(facts.alias || "<vm>", [
      ...dockerPrefix,
      "logs",
      "--tail",
      String(tail),
      facts.container,
    ]);
  const execCommand = (rest: string): string =>
    `${sshCommandLine(facts.alias || "<vm>", [...dockerPrefix, "exec", facts.container])} ${rest}`;
  const cliCommand = (rest: string): string => execCommand(`node dist/src/cli.js ${rest}`);

  function noAlias(name: string): CheckResult {
    return {
      name,
      ok: false,
      detail:
        'no ssh alias is recorded for the server route — run the topology step with choice: "vm" and ssh_host: "<alias>"',
    };
  }

  return {
    kind: "ssh",
    where: `on ${facts.alias || "the review host"}, over ssh`,

    async containerChecks(ingress) {
      if (facts.alias === "") return [noAlias("containers")];
      const ps = await remote([
        ...dockerPrefix,
        "ps",
        "--all",
        "--filter",
        `name=${facts.container}`,
        "--format",
        "{{.Names}} {{.State}}",
      ]);
      if (ps.code !== 0) {
        return [
          {
            name: "containers",
            ok: false,
            detail:
              `could not ask Docker on ${facts.alias} what is running (${(ps.stderr || ps.stdout).trim().slice(0, 240) || `exit ${ps.code}`}) — ` +
              `Fix: \`${sshCommandLine(facts.alias, [...dockerPrefix, "ps"])}\` by hand. If Docker is not installed there yet, ` +
              "run the deploy step: the playbook installs it",
          },
        ];
      }
      const state = psRows(ps.stdout).find((r) => r.name === facts.container)?.rest ?? "";
      const checks: CheckResult[] = [
        state !== "" && /running|up/i.test(state)
          ? {
              name: "containers",
              ok: true,
              detail: `the ${facts.container} container on ${facts.alias} is ${state}`,
            }
          : {
              name: "containers",
              ok: false,
              detail:
                `the ${facts.container} container on ${facts.alias} is ${state || "not there at all"} — ` +
                `Fix: \`${logsCommand(200)}\` says why it stopped; re-running the deploy step recreates it`,
            },
      ];
      // The memory sidecar is part of the stack: the daemon's health answers
      // without it, so a stopped sidecar is checked here.
      {
        const mem = await remote([
          ...dockerPrefix,
          "ps",
          "--all",
          "--filter",
          `name=${sidecarContainer}`,
          "--format",
          "{{.Names}} {{.State}}",
        ]);
        const memState =
          mem.code === 0
            ? (psRows(mem.stdout).find((r) => r.name === sidecarContainer)?.rest ?? "")
            : null;
        checks.push(
          memState !== null && /running|up/i.test(memState)
            ? {
                name: "memory-sidecar",
                ok: true,
                detail: `the ${sidecarContainer} memory sidecar on ${facts.alias} is ${memState}`,
              }
            : {
                name: "memory-sidecar",
                ok: false,
                detail:
                  `the ${sidecarContainer} memory sidecar (OpenViking, the review memory) on ${facts.alias} is ` +
                  `${memState === null ? "unreadable (docker ps failed)" : memState || "not there at all"} — ` +
                  `Fix: \`${sshCommandLine(facts.alias, [...dockerPrefix, "logs", "--tail", "200", sidecarContainer])}\` says why it stopped; ` +
                  "re-running the deploy step recreates it",
              },
        );
      }
      // The VM route's ingress is cloudflared as a HOST service (the playbook
      // installs it), never a compose sidecar — so this is the only ingress
      // shape there is anything to check for here.
      const cloudflared = async () => {
        const unit = await remote(["systemctl", "is-active", "cloudflared"]);
        const status = (unit.stdout || unit.stderr).trim();
        return { ...unit, status, active: unit.code === 0 && status.startsWith("active") };
      };
      if (ingress?.id === "named") {
        const unit = await cloudflared();
        const status = (unit.stdout || unit.stderr).trim() || `exit ${unit.code}`;
        checks.push(
          unit.active
            ? {
                name: "ingress-sidecar",
                ok: true,
                detail: `the cloudflared service on ${facts.alias} is ${status}`,
              }
            : {
                name: "ingress-sidecar",
                ok: false,
                detail:
                  `cloudflared on ${facts.alias} is ${status} — that is the named tunnel fronting your webhook hostname. ` +
                  `Fix: \`${sshCommandLine(facts.alias, ["sudo", "systemctl", "restart", "cloudflared"])}\`, then ` +
                  `\`${sshCommandLine(facts.alias, ["journalctl", "-u", "cloudflared", "-n", "50"])}\` if it will not stay up`,
              },
        );
      } else if (ingress?.id === "polling") {
        // Polling promises nothing exposed, but a downgrade from the named
        // tunnel never stops cloudflared: the playbook skips every cloudflared
        // task once it is disabled and has no stop task. So say what is live.
        // A warning, never a failure and never a stop: on a shared box the
        // service may be someone else's tunnel, which this wizard must not
        // touch (the playbook's foreign-cloudflared caution).
        const unit = await cloudflared();
        const status = unit.status;
        checks.push(
          unit.active
            ? {
                name: "ingress-sidecar",
                ok: true,
                detail:
                  `WARNING: you chose polling, but cloudflared on ${facts.alias} is ${status}. If it is the tunnel an earlier ` +
                  "named-ingress deploy installed, it still forwards that hostname to this daemon, so the daemon is NOT " +
                  "unexposed — the deploy does not stop it. Stop it with " +
                  `\`${sshCommandLine(facts.alias, ["sudo", "systemctl", "disable", "--now", "cloudflared"])}\`. ` +
                  "If it serves someone else's tunnel on a shared box, leave it alone.",
              }
            : /^(inactive|failed|unknown)/.test(status)
              ? {
                  name: "ingress-sidecar",
                  ok: true,
                  detail: `no cloudflared service is active on ${facts.alias} (${status}) — polling, nothing exposed`,
                }
              : {
                  name: "ingress-sidecar",
                  ok: true,
                  detail:
                    `could not tell whether cloudflared runs on ${facts.alias} (${status || `exit ${unit.code}`}) — ` +
                    `check by hand: \`${sshCommandLine(facts.alias, ["systemctl", "is-active", "cloudflared"])}\``,
                },
        );
      }
      return checks;
    },

    async running() {
      return (await daemonState()).state === "running";
    },

    daemonState,

    async exec(argv) {
      if (facts.alias === "")
        return { code: 1, stdout: "", stderr: "no ssh alias recorded for the server route" };
      return remote([...dockerPrefix, "exec", facts.container, ...argv]);
    },

    async execAsRoot(argv) {
      if (facts.alias === "")
        return { code: 1, stdout: "", stderr: "no ssh alias recorded for the server route" };
      return remote([...dockerPrefix, "exec", "-u", "0", facts.container, ...argv]);
    },

    async execMemory(argv) {
      if (facts.alias === "")
        return { code: 1, stdout: "", stderr: "no ssh alias recorded for the server route" };
      return remote([...dockerPrefix, "exec", memoryContainer, ...argv]);
    },

    async health() {
      if (facts.alias === "") return noAlias("health");
      // curl ON the box: the daemon's port is published to the VM's loopback
      // only (that is the design — cloudflared fronts it), so probing it from
      // here would be probing the wrong machine.
      const r = await remote([
        "curl",
        "-sS",
        "-m",
        String(healthTimeoutS),
        "-o",
        "-",
        "-w",
        "\\n%{http_code}",
        healthEndpoint,
      ]);
      const lines = r.stdout.trim().split("\n");
      const status = Number(lines.at(-1) ?? "0");
      const body = lines.slice(0, -1).join("\n");
      if (r.code !== 0 || !Number.isFinite(status) || status === 0) {
        return {
          name: "health",
          ok: false,
          detail:
            `nothing answered ${healthEndpoint} on ${facts.alias} (${(r.stderr || r.stdout).trim().slice(0, 200) || `exit ${r.code}`}) — ` +
            `Fix: \`${logsCommand(200)}\`. If curl is missing on that box, \`${sshCommandLine(facts.alias, ["sudo", "apt", "install", "-y", "curl"])}\``,
        };
      }
      if (status !== 200) {
        return {
          name: "health",
          ok: false,
          detail:
            `${healthEndpoint} on ${facts.alias} answered HTTP ${status} — Fix: \`${logsCommand(200)}\`. A daemon that ` +
            "started but cannot serve is nearly always a config.toml the loader rejected; the log line says which key",
        };
      }
      return healthPayloadOk(body)
        ? {
            name: "health",
            ok: true,
            detail: `${healthEndpoint} on ${facts.alias} answers {"ok":true} — the daemon is up, has loaded its config and is serving`,
          }
        : {
            name: "health",
            ok: false,
            detail:
              `${healthEndpoint} on ${facts.alias} answered 200 but not the health payload (${body.slice(0, 120)}) — Fix: something ` +
              "else on that machine is listening on that port; free it and run the deploy step again",
          };
    },

    async restart(log, running) {
      if (!running) {
        // A server that was never deployed to gets this config with its first
        // deploy. A STOPPED container that was deployed is different: it
        // holds the config last shipped, and starting it brings that back —
        // so the change is still owed, not delivered.
        const nothingDeployed: CheckResult = {
          name: "daemon-restart",
          ok: true,
          detail:
            "nothing is deployed on the server yet, so there is nothing to restart — the deploy step ships this config when you run it",
        };
        if (facts.alias === "") return nothingDeployed;
        const ps = await remote([
          ...dockerPrefix,
          "ps",
          "--all",
          "--filter",
          `name=${facts.container}`,
          "--format",
          "{{.Names}}",
        ]);
        if (ps.code !== 0) {
          return {
            name: "daemon-restart",
            ok: false,
            detail:
              `could not ask Docker on ${facts.alias} whether ${facts.container} exists (${(ps.stderr || ps.stdout).trim().slice(0, 200) || `exit ${ps.code}`}) — ` +
              `the changed config is NOT known to be on the server. Fix: \`${shipLine()}\` ships it`,
          };
        }
        if (!psRows(ps.stdout).some((r) => r.name === facts.container)) return nothingDeployed;
        return {
          name: "daemon-restart",
          ok: false,
          detail:
            `the ${facts.container} container on ${facts.alias} exists but is not running — it holds the config last shipped, ` +
            `not this one, and starting it as it is would bring the old value back. Fix: \`${shipLine()}\` ` +
            "ships the change and recreates the container",
        };
      }
      // The deploy ships to whatever the inventory names; everything above
      // checked facts.alias. Refuse rather than ship to a host never looked at.
      const mismatch = inventoryTargetMismatch(root, facts.alias, effectiveInventoryPath(root));
      if (mismatch !== null) {
        return {
          name: "daemon-restart",
          ok: false,
          detail: `not shipping: ${mismatch}. The file on disk here is already correct; it reaches the server with the next deploy`,
        };
      }
      log(
        `shipping the changed config to ${facts.alias} with \`${shipLine()}\` — on the server route the deploy IS the restart`,
      );
      if (version === null) {
        return {
          name: "daemon-restart",
          ok: false,
          detail:
            "not shipping: no release version is recorded for this server, and a release is the only deploy. " +
            "The file on disk here is already correct; run the deploy step with a version (it records it), or " +
            "`scripts/deploy.sh release <version>` yourself",
        };
      }
      let r: { code: number; stdout: string; stderr: string } = { code: 0, stdout: "", stderr: "" };
      if (opts.deploymentMode === "provision") {
        r = await stream.run("bash", deployArgv(root, "provision"), (line) => log(line));
      }
      if (r.code === 0)
        r = await stream.run("bash", deployArgv(root, "release", { version }), (line) => log(line));
      return r.code === 0
        ? {
            name: "daemon-restart",
            ok: true,
            detail: `\`${shipLine()}\` shipped the config to ${facts.alias} and recreated the container — it is running with the value on disk`,
          }
        : {
            name: "daemon-restart",
            ok: false,
            detail:
              `\`${shipLine()}\` exited ${r.code}: ${(r.stderr || r.stdout).trim().split("\n").slice(-6).join(" ").slice(0, 400) || "no output"} — ` +
              "the file on disk here is already correct; run that command yourself to ship it (it refuses on a dirty tree or a " +
              "pin mismatch, and those refusals are the point)",
          };
    },

    logsCommand,
    execCommand,
    cliCommand,
  };
}

// ---- shared -----------------------------------------------------------------

/** Is this a 200 body the daemon's own `/health` answers — `{"ok": true}`?
 * The one acceptance rule both transports apply after reading the body. */
export function healthPayloadOk(body: string): boolean {
  try {
    return (JSON.parse(body) as { ok?: unknown } | null)?.ok === true;
  } catch {
    return false;
  }
}

/** The compose route's health probe: a plain fetch at the published port. */
async function probeHealthOverHttp(
  adapters: OnboardAdapters,
  url: string,
  timeoutMs: number,
  fixes: { badStatus: string; notPayload: string; unreachable: string },
): Promise<CheckResult> {
  try {
    const res = await adapters.fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    if (res.status !== 200) {
      return {
        name: "health",
        ok: false,
        detail: `${url} answered HTTP ${res.status} — ${fixes.badStatus}`,
      };
    }
    return healthPayloadOk(text)
      ? {
          name: "health",
          ok: true,
          detail: `${url} answers {"ok":true} — the daemon is up, has loaded its config and is serving`,
        }
      : {
          name: "health",
          ok: false,
          detail: `${url} answered 200 but not the health payload (${text.slice(0, 120)}) — ${fixes.notPayload}`,
        };
  } catch (err) {
    return {
      name: "health",
      ok: false,
      detail: `nothing answered ${url} (${String(err)}) — ${fixes.unreachable}`,
    };
  }
}

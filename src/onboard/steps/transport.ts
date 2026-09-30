// The stack transport — THE ONE DECISION POINT for "where does this
// system actually run?".
//
// built bring-up, layered verification, the proof round and the go-live
// flip against `docker compose` on this machine. adds a VM/server over
// ssh, and the temptation is to write those four steps again with `ssh` in
// front of every command. That is the thing this file exists to prevent.
//
// Instead, exactly one function decides — `stackTransportFor(ctx)` — and every
// step asks IT for the four things it actually needs from the host: are the
// containers up, run this argv in the daemon, does health answer, restart so
// the daemon re-reads its config. This is the same discipline used for
// the TUI (`runnerFor(cfg)` in src/tui/remote.ts: one interface, two
// implementations, one place that picks, every caller untouched). The steps
// keep their logic, their check names, their fix text and their tests; what
// changes underneath them is the transport.
//
// Two implementations, and they are NOT symmetrical, because the two topologies
// genuinely are not:
//
//   * compose — `docker compose …` here. Health is a plain fetch to the
//     published loopback port; a restart is `docker compose restart daemon`.
//     Byte-for-byte the behaviour: this transport delegates to the
//     existing helpers in compose.ts rather than re-deriving them.
//   * ssh — `ssh <alias> sudo docker …` there, with BatchMode on every hop (see
//     ssh.ts: a prompt is a hang, and a hang is the failure mode of this whole
//     route). Health is curl ON the box against its loopback publish, because
//     the daemon's port is deliberately not exposed off the VM. And a "restart"
//     is `scripts/deploy.sh sync` — on that route the config the daemon reads
//     is the one the deploy ships, so re-running the existing deploy IS the
//     restart, with every one of its preflights intact. Never a hand-rolled
//     `ssh … docker restart` that would leave the box running a config nobody
//     shipped.
import type { CheckResult, OnboardAdapters, ProcessResult, StepContext } from "../engine.js";
import {
  DAEMON_SERVICE,
  composeArgs,
  composePs,
  containerStateCheck,
  daemonExecArgs,
  healthUrl,
  isUp,
  nodeStreamRunner,
  readConfigText,
  restartDaemon,
  rootOf,
  serviceRow,
  type StreamRunner,
} from "./compose.js";
import { deployArgv, deployCommandLine } from "./deploysh.js";
import { readTomlKey, type IngressOption } from "./ingress.js";
import { inventoryTargetMismatch } from "./inventory.js";
import { sshArgv, sshCommandLine } from "./ssh.js";
import { sshAliasOf, topologyOf } from "./topology.js";

export type TransportKind = "compose" | "ssh";

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
  /** Is the daemon up enough to talk to? */
  running(): Promise<boolean>;
  /** Run an argv INSIDE the daemon container. */
  exec(argv: readonly string[]): Promise<ProcessResult>;
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
  /** The command the OPERATOR types to attach to a tmux session. */
  attachCommand(session: string): string;
}

export interface TransportOptions {
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
  const healthTimeoutMs = opts.healthTimeoutMs ?? 10_000;

  return {
    kind: "compose",
    where: "on this machine, through docker compose",

    async containerChecks(ingress) {
      return containerStateCheck(await composePs(ctx.adapters.runner, root), ingress);
    },

    async running() {
      const ps = await composePs(ctx.adapters.runner, root);
      return ps.ok && isUp(serviceRow(ps.rows, DAEMON_SERVICE));
    },

    async exec(argv) {
      return ctx.adapters.runner.run("docker", daemonExecArgs(root, argv));
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
    attachCommand: (session) => `docker compose exec -it daemon tmux attach -t ${session}`,
  };
}

// ---- a VM or server over ssh -------------------------------------------------

/** Where the VM's daemon container lives, read from config.toml's [tui] block
 * (the same values the operator TUI uses) with the shipped defaults. */
export interface RemoteFacts {
  alias: string;
  container: string;
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
  return {
    alias: sshAliasOf(choices),
    container: container && container !== "" ? container : "quickreview-sandbox",
    // The playbook's Docker socket is root-owned; sudo is the shipped default
    // and only an explicit `false` turns it off.
    sudo: sudo !== "false",
    port: port && /^[0-9]{1,5}$/.test(port) ? Number(port) : 8787,
  };
}

function sshTransport(ctx: StepContext, opts: TransportOptions): StackTransport {
  const root = rootOf(ctx.adapters);
  const facts = remoteFactsFor(ctx.adapters, ctx.choices);
  const stream = opts.stream ?? nodeStreamRunner;
  const dockerPrefix = facts.sudo ? ["sudo", "docker"] : ["docker"];
  const remote = (argv: readonly string[]): Promise<ProcessResult> =>
    ctx.adapters.runner.run("ssh", sshArgv(facts.alias, argv));
  const healthEndpoint = `http://127.0.0.1:${facts.port}/health`;
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
      const row = ps.stdout
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.startsWith(facts.container));
      const state = row ? row.slice(facts.container.length).trim() : "";
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
      // The VM route's ingress is cloudflared as a HOST service (the playbook
      // installs it), never a compose sidecar — so this is the only ingress
      // shape there is anything to check for here.
      if (ingress?.id === "named") {
        const unit = await remote(["systemctl", "is-active", "cloudflared"]);
        const status = (unit.stdout || unit.stderr).trim() || `exit ${unit.code}`;
        checks.push(
          unit.code === 0 && status.startsWith("active")
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
      }
      return checks;
    },

    async running() {
      if (facts.alias === "") return false;
      const ps = await remote([
        ...dockerPrefix,
        "ps",
        "--filter",
        `name=${facts.container}`,
        "--format",
        "{{.Names}}",
      ]);
      return ps.code === 0 && ps.stdout.includes(facts.container);
    },

    async exec(argv) {
      if (facts.alias === "")
        return { code: 1, stdout: "", stderr: "no ssh alias recorded for the server route" };
      return remote([...dockerPrefix, "exec", facts.container, ...argv]);
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
        "10",
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
      let ok = false;
      try {
        ok = (JSON.parse(body) as { ok?: unknown }).ok === true;
      } catch {
        ok = false;
      }
      return ok
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
        return {
          name: "daemon-restart",
          ok: true,
          detail:
            "nothing is deployed on the server yet, so there is nothing to restart — the deploy step ships this config when you run it",
        };
      }
      // The deploy ships to whatever the inventory names; everything above
      // checked facts.alias. Refuse rather than ship to a host never looked at.
      const mismatch = inventoryTargetMismatch(root, facts.alias);
      if (mismatch !== null) {
        return {
          name: "daemon-restart",
          ok: false,
          detail: `not shipping: ${mismatch}. The file on disk here is already correct; it reaches the server with the next deploy`,
        };
      }
      log(
        `shipping the changed config to ${facts.alias} with \`${deployCommandLine("sync")}\` — on the server route the deploy IS the restart`,
      );
      const r = await stream.run("bash", deployArgv(root, "sync"), (line) => log(line));
      return r.code === 0
        ? {
            name: "daemon-restart",
            ok: true,
            detail: `\`${deployCommandLine("sync")}\` shipped the config to ${facts.alias} and recreated the container — it is running with the value on disk`,
          }
        : {
            name: "daemon-restart",
            ok: false,
            detail:
              `\`${deployCommandLine("sync")}\` exited ${r.code}: ${(r.stderr || r.stdout).trim().split("\n").slice(-6).join(" ").slice(0, 400) || "no output"} — ` +
              "the file on disk here is already correct; run that command yourself to ship it (it refuses on a dirty tree or a " +
              "pin mismatch, and those refusals are the point)",
          };
    },

    logsCommand,
    execCommand,
    cliCommand,
    attachCommand: (session) =>
      `ssh -t ${facts.alias || "<vm>"} ${facts.sudo ? "sudo " : ""}docker exec -it ${facts.container} tmux attach -t ${session}`,
  };
}

// ---- shared -----------------------------------------------------------------

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
    let ok = false;
    try {
      ok = (JSON.parse(text) as { ok?: unknown }).ok === true;
    } catch {
      ok = false;
    }
    return ok
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

/** `docker compose …` argv, exported so a caller that must show the command it
 * ran can render it the same way the transport built it. */
export function composeCommandLine(root: string, rest: readonly string[]): string {
  return `docker ${composeArgs(root, rest).join(" ")}`;
}

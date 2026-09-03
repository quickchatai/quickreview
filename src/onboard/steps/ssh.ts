// ssh preflight — the FIRST thing the VM route does, and the reason
// it is first is one specific failure mode.
//
// THE PASSPHRASE TRAP. An ssh key with a passphrase and no agent does not
// fail: it PROMPTS. A prompt inside a wizard has nowhere to appear and nobody
// to type into it, so what the operator sees is the deploy stopping dead,
// halfway through an Ansible run, with no output and no explanation. That is
// the single worst thing this route can do, and it is closed here in two ways:
//
//   1. STRUCTURALLY — every ssh this wizard runs, in this step and in the ssh
//      transport (transport.ts), carries `-o BatchMode=yes`. BatchMode makes
//      ssh refuse to ask: no passphrase prompt, no password prompt, no host-key
//      question. A key that would have prompted fails instantly with a message
//      instead of hanging forever with none. There is no code path in this
//      slice that builds an ssh command without it — `sshArgv` is the only
//      builder, and it always prepends the options.
//   2. IN THE OPEN — this step probes the alias, the agent and a real
//      connection BEFORE anything is minted, written or deployed, and when the
//      agent is empty it hands the operator the exact command to run IN THEIR
//      OWN SHELL. It cannot run `ssh-add` for them: the passphrase prompt
//      belongs to their terminal, not ours. Saying so plainly is the whole
//      point.
//
// Everything else here follows from that: the alias must be one ssh actually
// knows, the controller must have ansible-playbook (the deploy dies without
// it), and remote sudo must be passwordless (the playbook runs `become: true`,
// and a sudo password prompt is the same hang wearing a different hat).
import { CHOICE_KEYS } from "../choices.js";
import type {
  CheckResult,
  OnboardingStep,
  ProcessRunner,
  StepContext,
  StepReport,
} from "../engine.js";
import { shellQuote } from "../../tui/remote.js";
import { SSH_ALIAS_RE, TOPOLOGY_STEP_ID, sshAliasOf, topologyOf } from "./topology.js";

export const SSH_PREFLIGHT_STEP_ID = "ssh_preflight";
/** Resolved login user, recorded for the inventory's `ansible_user`. */
export const SSH_USER_CHOICE_KEY = CHOICE_KEYS.sshUser;

/**
 * The options EVERY ssh in this slice carries.
 *
 * `BatchMode=yes` is the load-bearing one (see the header): it turns every
 * would-be prompt into an immediate, explained failure. `ConnectTimeout` keeps
 * an unreachable box from eating the engine runner's whole budget.
 */
export const SSH_BATCH_OPTS: readonly string[] = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];

/** The ONE ssh command builder in the onboarding slice. Remote argv is quoted
 * into a single command string, because ssh hands its arguments to a remote
 * shell rather than execing them. */
export function sshArgv(host: string, remote: readonly string[]): string[] {
  return [...SSH_BATCH_OPTS, host, remote.map(shellQuote).join(" ")];
}

/** How the same command reads when the operator types it themselves. */
export function sshCommandLine(host: string, remote: readonly string[]): string {
  return `ssh ${host} ${remote.map(shellQuote).join(" ")}`;
}

// ---- what the agent has ------------------------------------------------------

export type AgentKind = "keys" | "empty" | "no-agent" | "unknown";

export interface AgentState {
  kind: AgentKind;
  count: number;
  detail: string;
}

/**
 * `ssh-add -l`, read totally. Exit 0 = identities listed, 1 = the agent is
 * running but empty, 2 = there is no agent to talk to. Anything else is
 * "unknown", which is never reported as a failure on its own — the connection
 * probe is the authority, and this only shapes the advice it gives.
 */
export function parseSshAddList(code: number, stdout: string, stderr: string): AgentState {
  const text = `${stdout}\n${stderr}`;
  if (code === 0) {
    const lines = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "" && !/has no identities/i.test(l));
    return {
      kind: "keys",
      count: lines.length,
      detail: lines.length === 1 ? "1 key" : `${lines.length} keys`,
    };
  }
  if (/no identities/i.test(text))
    return { kind: "empty", count: 0, detail: "the agent is running but holds no keys" };
  if (
    code === 2 ||
    /could not open a connection|error connecting to agent|agent refused/i.test(text)
  ) {
    return { kind: "no-agent", count: 0, detail: "no ssh agent is reachable from this shell" };
  }
  return {
    kind: "unknown",
    count: 0,
    detail: (stderr || stdout).trim().slice(0, 200) || `ssh-add -l exited ${code}`,
  };
}

// ---- why a connection failed -------------------------------------------------

export type SshFailure = "no-such-host" | "auth" | "host-key" | "timeout" | "refused" | "unknown";

/** Classify an ssh failure from its own words. Pure — the step turns this into
 * advice, and the tests drive every branch without an ssh anywhere. */
export function classifySshFailure(stderr: string): SshFailure {
  const t = stderr.toLowerCase();
  if (/could not resolve hostname|name or service not known|nodename nor servname/.test(t))
    return "no-such-host";
  if (/host key verification failed|remote host identification has changed/.test(t))
    return "host-key";
  if (
    /permission denied|no supported authentication|too many authentication failures|publickey/.test(
      t,
    )
  )
    return "auth";
  if (/timed out|timeout/.test(t)) return "timeout";
  if (/connection refused|no route to host|network is unreachable/.test(t)) return "refused";
  return "unknown";
}

/**
 * The remedy, in the operator's own shell, for a failed connection. `agent`
 * shapes it because the same "Permission denied (publickey)" means two very
 * different things depending on whether the agent is empty (your key is not
 * loaded — the passphrase case) or full (the server does not have your key).
 */
export function connectionAdvice(failure: SshFailure, agent: AgentState, alias: string): string {
  const batch =
    "Every ssh this wizard runs carries -o BatchMode=yes, so it fails in the open instead of hanging on a prompt you cannot see.";
  switch (failure) {
    case "no-such-host":
      return (
        `ssh cannot resolve "${alias}" at all. Fix: it must be a name ssh knows — either a real hostname/IP, or a Host entry in ` +
        `~/.ssh/config. Check with:\n    ssh -G ${alias} | head -3\nand try \`ssh ${alias}\` in your own shell until that works; ` +
        "then run this step again."
      );
    case "host-key":
      return (
        'ssh refused on the host key. That is deliberate: BatchMode never answers the "are you sure you want to continue ' +
        `connecting?" question for you. Fix, in your own shell:\n    ssh ${alias} true\naccept the fingerprint once (or fix a ` +
        `changed key with \`ssh-keygen -R ${alias}\`), then run this step again. ${batch}`
      );
    case "auth":
      return agent.kind === "keys"
        ? `the connection reached ${alias} and it rejected your key (${agent.detail} loaded). Fix: the PUBLIC half of one of ` +
            `those keys must be in ~/.ssh/authorized_keys on ${alias}. \`ssh-copy-id ${alias}\` does it if you can log in ` +
            `another way. ${batch}`
        : `your ssh agent has no usable key (${agent.detail}), so ${alias} had nothing to authenticate with. THIS IS THE ` +
            "PASSPHRASE CASE, and it is the one that would otherwise hang a deploy halfway through:\n\n" +
            (agent.kind === "no-agent"
              ? '    eval "$(ssh-agent -s)"\n    ssh-add ~/.ssh/id_ed25519\n'
              : "    ssh-add ~/.ssh/id_ed25519\n") +
            "\nRun that IN YOUR OWN SHELL — the passphrase prompt belongs to your terminal and this wizard must never try to " +
            `type into it. (Use the path of your own key if it is not id_ed25519.) Then run this step again. ${batch}`;
    case "timeout":
      return `the connection to ${alias} timed out. Fix: is the machine up, and is port 22 reachable from here (firewall, VPN, bastion)? ${batch}`;
    case "refused":
      return `${alias} refused the connection. Fix: sshd must be running and reachable on the port your config uses. ${batch}`;
    default:
      return (
        `ssh failed and did not say anything this step recognises. Fix: run \`ssh ${alias} true\` in your own shell — its ` +
        `message is the one to act on. ${batch}`
      );
  }
}

// ---- the step ----------------------------------------------------------------

export interface SshPreflightOptions {
  /** Skip the remote sudo probe (tests, and boxes where the operator drives
   * ansible with --ask-become-pass by hand). */
  probeSudo?: boolean;
}

async function run(runner: ProcessRunner, cmd: string, args: readonly string[]) {
  return runner.run(cmd, [...args]);
}

export function sshPreflightStep(opts: SshPreflightOptions = {}): OnboardingStep {
  const probeSudo = opts.probeSudo ?? true;

  async function probe(ctx: StepContext): Promise<StepReport> {
    const alias = sshAliasOf(ctx.choices);
    if (alias === "" || !SSH_ALIAS_RE.test(alias)) {
      return {
        ok: false,
        checks: [
          {
            name: "alias",
            ok: false,
            detail: `no ssh alias is recorded — run the ${TOPOLOGY_STEP_ID} step with choice: "vm" and ssh_host: "<alias>" first`,
          },
        ],
      };
    }
    const { runner } = ctx.adapters;
    const checks: CheckResult[] = [];

    // 1. is there an ssh at all?
    const version = await run(runner, "ssh", ["-V"]);
    if (version.code !== 0) {
      checks.push({
        name: "ssh-binary",
        ok: false,
        detail: `\`ssh -V\` exited ${version.code} (${(version.stderr || version.stdout).trim() || "no output"}) — Fix: install an OpenSSH client`,
      });
      return { ok: false, checks };
    }
    checks.push({
      name: "ssh-binary",
      ok: true,
      detail: (version.stderr || version.stdout).trim().split("\n")[0] ?? "ssh present",
    });

    // 2. does ssh know this alias, and as what?
    const resolved = await run(runner, "ssh", ["-G", alias]);
    if (resolved.code !== 0) {
      checks.push({
        name: "alias",
        ok: false,
        detail:
          `\`ssh -G ${alias}\` exited ${resolved.code}: ${(resolved.stderr || resolved.stdout).trim().slice(0, 300) || "no output"} — ` +
          "Fix: that usually means ~/.ssh/config has an error, or the alias is not a name ssh can use at all",
      });
      return { ok: false, checks };
    }
    const facts = parseSshConfig(resolved.stdout);
    if (facts.user !== "") ctx.recordChoice(CHOICE_KEYS.sshUser, facts.user);
    checks.push({
      name: "alias",
      ok: true,
      detail:
        `${alias} → ${facts.user ? `${facts.user}@` : ""}${facts.hostname || alias}:${facts.port || "22"}` +
        (facts.hostname === alias
          ? " (no ~/.ssh/config Host entry matched, so ssh treats the alias as the hostname itself)"
          : ""),
    });

    // 3+4. What the agent holds, and then the authority: a real,
    // non-interactive connection. The CONNECTION decides — an empty agent is
    // perfectly fine when the key has no passphrase, and the agent line exists
    // to shape the advice, never to fail the step on its own.
    const agentRaw = await run(runner, "ssh-add", ["-l"]);
    const agent = parseSshAddList(agentRaw.code, agentRaw.stdout, agentRaw.stderr);
    const connect = await run(runner, "ssh", sshArgv(alias, ["true"]));
    const connected = connect.code === 0;
    checks.push({
      name: "ssh-agent",
      ok: agent.kind === "keys" || connected,
      detail:
        agent.kind === "keys"
          ? `your ssh agent holds ${agent.detail} — a passphrase-protected key can be used without ever prompting`
          : connected
            ? `${agent.detail}, and the connection below still succeeded — so your key has no passphrase and needs no agent`
            : `${agent.detail}. If your key has a passphrase this fails the connection below rather than prompting, which is ` +
              "deliberate. Load it in your own shell:\n" +
              (agent.kind === "no-agent"
                ? '    eval "$(ssh-agent -s)"\n    ssh-add ~/.ssh/id_ed25519'
                : "    ssh-add ~/.ssh/id_ed25519"),
    });
    if (!connected) {
      const failure = classifySshFailure(connect.stderr || connect.stdout);
      checks.push({
        name: "connection",
        ok: false,
        detail:
          `\`${sshCommandLine(alias, ["true"])}\` failed (exit ${connect.code}): ` +
          `${(connect.stderr || connect.stdout).trim().split("\n").slice(-2).join(" ").slice(0, 240) || "no output"}\n\n` +
          connectionAdvice(failure, agent, alias),
      });
      return { ok: false, checks };
    }
    checks.push({
      name: "connection",
      ok: true,
      detail: `\`${sshCommandLine(alias, ["true"])}\` succeeded without prompting for anything — the deploy cannot hang on a passphrase`,
    });

    // 5. passwordless sudo: the playbook runs as root on the box, and a sudo
    //    password prompt is the same hang in different clothes.
    if (probeSudo) {
      const sudo = await run(runner, "ssh", sshArgv(alias, ["sudo", "-n", "true"]));
      checks.push(
        sudo.code === 0
          ? {
              name: "remote-sudo",
              ok: true,
              detail: `sudo on ${alias} works without a password — the Ansible deploy can install packages and run Docker`,
            }
          : {
              name: "remote-sudo",
              ok: false,
              detail:
                `\`sudo -n true\` on ${alias} exited ${sudo.code} (${(sudo.stderr || sudo.stdout).trim().slice(0, 200) || "no output"}). ` +
                "The deploy runs as root on that machine (packages, Docker, the container), and a sudo PASSWORD PROMPT would hang " +
                "it exactly the way an ssh passphrase would. Fix: give your login passwordless sudo there — on most clouds that is " +
                "already true for the default user; otherwise add a sudoers line for it. (You can also deploy by hand with " +
                "`ansible-playbook --ask-become-pass`, but then the wizard cannot drive it for you.)",
            },
      );
    }

    // 6. the controller side: the deploy is an ansible-playbook run.
    const ansible = await run(runner, "ansible-playbook", ["--version"]);
    checks.push(
      ansible.code === 0
        ? {
            name: "ansible",
            ok: true,
            detail:
              (ansible.stdout || ansible.stderr).trim().split("\n")[0] ??
              "ansible-playbook present",
          }
        : {
            name: "ansible",
            ok: false,
            detail:
              `\`ansible-playbook --version\` exited ${ansible.code} — the deploy IS an Ansible run from this machine, and ` +
              "scripts/deploy.sh refuses without it. Fix: install Ansible here (`pipx install ansible`, `pip install --user " +
              "ansible`, or your package manager). Nothing needs to be installed on the server by hand — the playbook does that.",
          },
    );

    return {
      ok: checks.every((c) => c.ok),
      checks,
      data: { alias, user: facts.user, hostname: facts.hostname },
    };
  }

  return {
    id: SSH_PREFLIGHT_STEP_ID,
    title: "ssh: prove the alias, the agent and the passphrase trap — before anything is deployed",
    explain:
      "The very first thing the server route does, and deliberately so. It checks that ssh knows your alias, that your agent " +
      "holds a usable key, that a real connection succeeds without prompting for anything, that sudo on that machine needs no " +
      "password, and that this machine has Ansible. The one worth explaining out loud: a passphrase-protected key with no agent " +
      "does not fail, it PROMPTS — and a prompt inside a deploy is an invisible hang. Every ssh here uses BatchMode, so it fails " +
      "in the open instead, and when the agent is empty this step hands them the exact `ssh-add` line to run in their OWN shell.",
    order: 22,
    enabled: (choices) => topologyOf(choices) === "vm",
    run: probe,
    verify: probe,
  };
}

export interface SshConfigFacts {
  hostname: string;
  user: string;
  port: string;
}

/** `ssh -G <alias>` prints one lowercase `key value` per line. */
export function parseSshConfig(stdout: string): SshConfigFacts {
  const facts: SshConfigFacts = { hostname: "", user: "", port: "" };
  for (const line of stdout.split("\n")) {
    const m = /^(hostname|user|port)\s+(.+)$/i.exec(line.trim());
    if (!m) continue;
    const key = m[1]!.toLowerCase() as keyof SshConfigFacts;
    if (facts[key] === "") facts[key] = m[2]!.trim();
  }
  return facts;
}

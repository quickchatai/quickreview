// Topology — the wizard's first real question, and the one that
// decides what the rest of the wizard even is.
//
// WHY IT SITS AT ORDER 20, between preflight (10) and LLM auth (30):
//
//   * preflight (10) is not a question at all — it establishes that this
//     machine can run *anything* (Node, Docker, a uid to build images with).
//     It has to come first because a machine that cannot run Docker cannot run
//     either topology, and asking someone to choose between two things they
//     cannot have is not a question, it is a trap.
//   * topology (20) comes next because every later step reads it: LLM auth's
//     honest "how many browser logins are coming" answer differs by route,
//     the ingress step's recommended default differs, config_fill only asks
//     for an ssh alias on the VM route, and the whole bring-up tail is either
//     `docker compose up` here or the Ansible deploy over there. Asking it
//     later would mean asking questions whose answers we would then throw
//     away.
//   * the ssh preflight (22) follows IMMEDIATELY on the VM route — see
//     ssh.ts. The alias and the agent are proven before a single credential is
//     minted or a single config key written, because a dead alias found at
//     deploy time has already cost the operator the entire interview.
//
// BOTH ANSWERS ARE FIRST-CLASS. "A VM or server over ssh" is advertised as
// the always-on recommendation (it is not the "advanced" path), and
// "this computer" is a complete, supported installation — the trade is stated
// in the operator's own terms and then they pick.
//
// SWITCHING IS A GUIDED, EXPLICIT ACT. A re-run that names a different
// topology does NOT silently reconfigure: it refuses once, says exactly what
// changes and what is left running where, and demands the confirmation phrase.
// The engine then does the rest by itself — the steps that belong to the old
// route go `disabled`, the new route's steps are pending, and the shared tail
// (verification, proof, the flip) re-verifies against the new transport and is
// demoted if it no longer holds. Nothing is torn down behind the operator's
// back: a stack on the machine they are switching away from keeps running
// until they stop it, and this step says so.
import { CHOICE_KEYS, TOPOLOGY_CHOICES, memberOf, type Topology } from "../choices.js";
import type { CheckResult, OnboardingStep, StepReport } from "../engine.js";

export const TOPOLOGY_STEP_ID = "topology";

/** The one place the topology is recorded — an alias of the shared key, so
 * this step and every reader name the same declaration (src/onboard/choices.ts). */
export const TOPOLOGY_CHOICE_KEY = CHOICE_KEYS.topology;

/** The ssh alias of the review host, recorded on the VM route. config_fill's
 * `[tui] ssh_host` question reads this key (its `from` list), so the operator
 * is never asked for the same alias twice. */
export const SSH_ALIAS_CHOICE_KEY = CHOICE_KEYS.sshAlias;

export type { Topology };

/** The recorded topology. Absent ⇒ "local", the compose path, so a checklist
 * that never recorded a topology keeps its meaning. */
export function topologyOf(choices: Readonly<Record<string, unknown>>): Topology {
  return choices[TOPOLOGY_CHOICE_KEY] === "vm" ? "vm" : "local";
}

/** Was a topology ever actually recorded? (`topologyOf` defaults; this does
 * not — switching has to be able to tell "unset" from "local".) */
export function topologyRecorded(choices: Readonly<Record<string, unknown>>): Topology | null {
  const raw = choices[TOPOLOGY_CHOICE_KEY];
  return typeof raw === "string" ? memberOf(TOPOLOGY_CHOICES, raw) : null;
}

export function sshAliasOf(choices: Readonly<Record<string, unknown>>): string {
  const raw = choices[SSH_ALIAS_CHOICE_KEY];
  return typeof raw === "string" ? raw.trim() : "";
}

/** An ssh alias as it appears in ~/.ssh/config — a Host name, not a URL.
 * Never a leading dash: ssh would read it as an option, not the destination. */
export const SSH_ALIAS_RE = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;

export interface TopologyOption {
  id: Topology;
  headline: string;
  tradeoffs: readonly string[];
}

const TOPOLOGY_OPTION_METADATA = {
  vm: {
    headline:
      "A VM or server over ssh — RECOMMENDED, because a reviewer that is asleep reviews nothing",
    tradeoffs: [
      "it is on 24/7: pull requests opened while you sleep, while your laptop is shut, or while you are on a plane still get reviewed",
      "you bring the box (any ssh-reachable Linux machine — a cheap cloud VM is plenty); the wizard does not create one for you",
      "setup rides the same Ansible deploy the maintainers use, with every one of its preflights: clean tree, version-pin coherence, disk space, and a warning when rounds are still running",
      "your operator TUI reaches it over ssh, so you need an ssh alias and a key your agent can use — checked in the very next step, before anything is built",
      "the recommended webhook ingress here is a named Cloudflare tunnel on your own domain: a permanent hostname, no rotation",
    ],
  },
  local: {
    headline: "This computer — everything in Docker on the machine you are sitting at",
    tradeoffs: [
      "nothing else to own: `docker compose up` and the whole system is here — daemon, memory engine, tunnel",
      "it reviews only while this machine is awake and the containers are running; close the lid and the reviewer stops",
      "zero third-party signup on the default path: the quick tunnel needs no account, and the daemon re-points its own webhook URL when that hostname rotates",
      "the honest way to try QuickReview, and a perfectly good permanent setup for one person on a desktop that stays on",
      "you can switch to a server later by re-running this step — the answers you gave (repo, App, keys) are kept",
    ],
  },
} satisfies Record<Topology, Omit<TopologyOption, "id">>;

export const TOPOLOGY_OPTIONS: readonly TopologyOption[] = TOPOLOGY_CHOICES.map((id) => ({
  id,
  ...TOPOLOGY_OPTION_METADATA[id],
}));

/** The offer text — what the guide reads out when nothing is recorded yet. */
export function renderTopologyOptions(): string {
  return TOPOLOGY_OPTIONS.map((o) =>
    [`${o.id}: ${o.headline}`, ...o.tradeoffs.map((t) => `    - ${t}`)].join("\n"),
  ).join("\n\n");
}

/** Not "yes": changing where the system lives is worth a sentence. */
export const TOPOLOGY_SWITCH_CONFIRMATION = "SWITCH TOPOLOGY";

export function isSwitchConfirmation(value: unknown): boolean {
  return typeof value === "string" && value.trim().toUpperCase() === TOPOLOGY_SWITCH_CONFIRMATION;
}

/** What changes when the operator moves between the two routes — read out
 * BEFORE the switch, never after it. */
export function switchConsequences(from: Topology, to: Topology): string {
  const lines = [
    `You recorded "${from}" earlier and are now asking for "${to}". That is a real change of where your reviewer lives, so it is`,
    "an explicit act rather than a quiet re-configuration. What happens:",
    "",
    to === "vm"
      ? "  • the compose steps (bring the stack up) stop applying; the Ansible deploy over ssh takes their place"
      : "  • the ssh steps (ssh preflight, inventory, deploy) stop applying; `docker compose up` on this machine takes their place",
    "  • verification, the proof round and the go-live decision stay — they simply run against the new host, and any of them",
    "    that no longer holds there is marked unfinished again the next time the checklist re-verifies",
    "  • everything you have already answered is kept: the repo, the GitHub App, the labels, the memory keys, your config",
    to === "vm"
      ? "  • the ssh alias and a usable key are checked in the very next step, before anything is deployed"
      : "  • the TUI moves back to talking to local Docker; `[tui] ssh_host` stops being used",
    "",
    from === "local"
      ? "  • NOTHING IS TORN DOWN. Containers already running on this machine keep running until you stop them yourself"
      : "  • NOTHING IS TORN DOWN. Anything already deployed on the server keeps running until you stop it yourself",
    "    (`docker compose down` here, or stopping the container on the server).",
    "",
    `If that is what you want, call this step again with choice: "${to}" and confirm: "${TOPOLOGY_SWITCH_CONFIRMATION}".`,
  ];
  return lines.join("\n");
}

function choiceOf(input: Readonly<Record<string, unknown>>): Topology | null {
  const raw = String(input.choice ?? "")
    .trim()
    .toLowerCase();
  if (raw === "vm" || raw === "server" || raw === "ssh") return "vm";
  if (raw === "local" || raw === "laptop" || raw === "this_computer") return "local";
  return null;
}

function aliasOf(
  input: Readonly<Record<string, unknown>>,
  choices: Readonly<Record<string, unknown>>,
): string {
  const raw = input.ssh_host ?? input.alias;
  const typed = typeof raw === "string" ? raw.trim() : "";
  return typed !== "" ? typed : sshAliasOf(choices);
}

function offerCheck(): CheckResult {
  return {
    name: "choice",
    ok: false,
    detail:
      "Read both of these out, in this order, and let them pick. Neither answer is the advanced one.\n\n" +
      `${renderTopologyOptions()}\n\n` +
      'Then call this step again with choice: "vm" (and ssh_host: "<the alias from your ~/.ssh/config>") or choice: "local".',
  };
}

export function topologyStep(): OnboardingStep {
  return {
    id: TOPOLOGY_STEP_ID,
    title: "Where should your reviewer live?",
    explain:
      "The first real question, and it steers everything after it. Two answers, both fully supported: a VM or server you " +
      "reach over ssh — the always-on recommendation, because a reviewer that is asleep reviews nothing — or this computer, " +
      "in Docker, which needs no server at all and is the honest way to try the system. Call this tool with no arguments to " +
      "get both options with their real trade-offs, read them out, then call it again with their answer. On the server route " +
      "ask for the ssh alias at the same time: it is the only extra thing that route needs from them.",
    order: 20,
    parameters: {
      type: "object",
      properties: {
        choice: {
          type: "string",
          enum: TOPOLOGY_CHOICES,
          description:
            'Where the reviewer will run: "vm" (a VM/server over ssh) or "local" (this computer). Omit to read out both options.',
        },
        ssh_host: {
          type: "string",
          description:
            'VM route only: the ssh alias of that machine, exactly as you would type it after `ssh`. Ignored for "local".',
        },
        confirm: {
          type: "string",
          description: `Only needed when CHANGING an already-recorded topology: the words ${TOPOLOGY_SWITCH_CONFIRMATION}.`,
        },
      },
    },

    async run(ctx): Promise<StepReport> {
      const choice = choiceOf(ctx.input);
      const recorded = topologyRecorded(ctx.choices);
      if (choice === null) {
        const checks: CheckResult[] = [offerCheck()];
        if (recorded !== null) {
          checks.push({
            name: "recorded",
            ok: true,
            detail: `"${recorded}" is recorded from an earlier run — calling this step with the same answer changes nothing.`,
          });
        }
        return { ok: false, checks };
      }

      // Switching: explicit, guided, and never a side effect of a re-run.
      if (recorded !== null && recorded !== choice && !isSwitchConfirmation(ctx.input.confirm)) {
        return {
          ok: false,
          checks: [{ name: "switch", ok: false, detail: switchConsequences(recorded, choice) }],
        };
      }
      const switching = recorded !== null && recorded !== choice;

      const checks: CheckResult[] = [];
      if (choice === "vm") {
        const alias = aliasOf(ctx.input, ctx.choices);
        if (alias === "") {
          return {
            ok: false,
            checks: [
              {
                name: "ssh-alias",
                ok: false,
                detail:
                  "the server route needs the ssh alias of that machine — the name you would type after `ssh`, as it appears in " +
                  '~/.ssh/config. Call this step again with choice: "vm" and ssh_host: "<alias>". (If you normally type a full ' +
                  "user@host, add a Host entry for it in ~/.ssh/config first: the deploy, the TUI and the memory forward all use " +
                  "that one name.)",
              },
            ],
          };
        }
        if (!SSH_ALIAS_RE.test(alias)) {
          return {
            ok: false,
            checks: [
              {
                name: "ssh-alias",
                ok: false,
                detail:
                  `"${alias}" is not an ssh alias — an alias is letters, digits, dots, dashes and underscores (a Host name from ` +
                  "~/.ssh/config), not a URL, not user@host and not a command. Nothing was recorded.",
              },
            ],
          };
        }
        ctx.recordChoice(CHOICE_KEYS.sshAlias, alias);
        checks.push({
          name: "ssh-alias",
          ok: true,
          detail:
            `${alias} recorded — the deploy, the operator TUI and the memory forward all use this one name, and the very next ` +
            "step proves it works (alias, agent, and the passphrase trap) before anything is built or deployed",
        });
      }

      ctx.recordChoice(CHOICE_KEYS.topology, choice);
      const option = TOPOLOGY_OPTIONS.find((o) => o.id === choice)!;
      checks.unshift({ name: "topology", ok: true, detail: `${option.id} — ${option.headline}` });
      if (switching) {
        checks.push({
          name: "switch",
          ok: true,
          detail:
            `switched from "${recorded}" to "${choice}" on your explicit confirmation. Nothing was torn down: whatever is ` +
            "already running where you came from keeps running until you stop it. Run the checklist status next — the steps " +
            "that belong to the other route now show as skipped, and anything that no longer holds here is unfinished again.",
        });
      }
      return {
        ok: true,
        checks,
        data: { topology: choice, recorded_at: ctx.adapters.clock().toISOString() },
      };
    },

    async verify(ctx): Promise<StepReport> {
      const recorded = topologyRecorded(ctx.choices);
      if (recorded === null) {
        return {
          ok: false,
          checks: [
            {
              name: "topology",
              ok: false,
              detail:
                "no topology recorded yet — run this step: it is the question the rest of the wizard is shaped by",
            },
          ],
        };
      }
      const checks: CheckResult[] = [
        {
          name: "topology",
          ok: true,
          detail: `${recorded} — ${TOPOLOGY_OPTIONS.find((o) => o.id === recorded)!.headline}`,
        },
      ];
      if (recorded === "vm") {
        const alias = sshAliasOf(ctx.choices);
        checks.push(
          alias !== ""
            ? { name: "ssh-alias", ok: true, detail: `${alias} recorded as the review host` }
            : {
                name: "ssh-alias",
                ok: false,
                detail:
                  'the VM route is recorded but no ssh alias is — run this step again with choice: "vm" and ssh_host: "<alias>"',
              },
        );
      }
      return { ok: checks.every((c) => c.ok), checks };
    },
  };
}

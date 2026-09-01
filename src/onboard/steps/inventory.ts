// The Ansible inventory, filled from the interview.
//
// `deploy/ansible/inventory.example.ini` is the tracked template and
// `inventory.ini` beside it is gitignored, operator-local and exactly where
// `scripts/deploy.sh` looks by default. So the guided route does not invent a
// path, an env var or a second inventory: it writes the file the manual route
// already reads, in the shape the example documents.
//
// ONE THING HERE IS NOT OBVIOUS, and it is deliberate. The ingress choice has
// to reach the playbook as `cloudflared_enabled`, and the tracked
// `group_vars/all.yml` sets it to true. We do NOT edit that file: it is
// committed, and editing it would dirty the working tree — which is precisely
// what `scripts/deploy.sh` refuses to deploy. Instead the value rides the
// inventory as a HOST var on the host line. In Ansible's precedence order,
// inventory host vars outrank playbook group_vars/all, so the operator's
// answer wins without a single tracked byte changing and without an `-e`
// override the wizard would have to smuggle past the script.
//
// The step also pins the operator TUI to this machine: `[tui] target = "ssh"`
// (the shipped default, asserted rather than assumed) and `[tui] ssh_host` =
// the recorded alias. The TUI's native ssh mode is what this topology uses;
//'s local runner belongs to the other one.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CheckResult, OnboardingStep, StepContext, StepReport } from "../engine.js";
import { ingressOptionOf, readConfigText, readTextOrNull, rootOf, writeAtomic } from "./compose.js";
import { assertNoDryRunEdit, patchToml, tomlString, type TomlEdit } from "./configfill.js";
import { readTomlKey } from "./ingress.js";
import { SSH_USER_CHOICE_KEY } from "./ssh.js";
import { SSH_ALIAS_RE, TOPOLOGY_STEP_ID, sshAliasOf, topologyOf } from "./topology.js";

export const VM_INVENTORY_STEP_ID = "vm_inventory";

/** The inventory group the playbook targets (`hosts: quickreview`). */
export const INVENTORY_GROUP = "quickreview";

export function inventoryPath(root: string): string {
  return join(root, "deploy", "ansible", "inventory.ini");
}

export function inventoryExamplePath(root: string): string {
  return join(root, "deploy", "ansible", "inventory.example.ini");
}

export interface InventoryFacts {
  host: string;
  /** Empty when the operator's ssh config already sets the login user. */
  ansibleUser: string;
  pythonInterpreter: string;
  /** false ⇒ the playbook installs no cloudflared and depends on no token. */
  cloudflaredEnabled: boolean;
}

export const DEFAULT_PYTHON_INTERPRETER = "/usr/bin/python3";

/** Render the inventory, in the example's shape. Pure — the test reads it. */
export function renderInventory(f: InventoryFacts): string {
  const lines = [
    "# Written by the QuickReview onboarding wizard from your answers.",
    "# It is the file scripts/deploy.sh reads by default, and it is gitignored:",
    "# your real hostnames stay on this machine. Edit it by hand whenever you",
    "# like — re-running the wizard's inventory step is what rewrites it.",
    "#",
    "# cloudflared_enabled rides the HOST line as a host var on purpose: host",
    "# vars outrank the tracked group_vars/all.yml, so your ingress choice wins",
    "# without editing a committed file (a dirty tree is a deploy refusal).",
    "",
    `[${INVENTORY_GROUP}]`,
    `${f.host} cloudflared_enabled=${f.cloudflaredEnabled ? "true" : "false"}`,
    "",
    `[${INVENTORY_GROUP}:vars]`,
  ];
  if (f.ansibleUser !== "") lines.push(`ansible_user=${f.ansibleUser}`);
  else lines.push("# ansible_user is not set here: your ~/.ssh/config already decides the login user.");
  lines.push(`ansible_python_interpreter=${f.pythonInterpreter}`);
  return `${lines.join("\n")}\n`;
}

/** The first host of the group, the way deploy.sh's own awk reads it. */
export function parseInventoryHost(text: string): string {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";") || line.startsWith("[")) continue;
    return line.split(/\s+/)[0] ?? "";
  }
  return "";
}

/** Host vars on that first host line, as written above. */
export function parseInventoryHostVars(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";") || line.startsWith("[")) continue;
    for (const token of line.split(/\s+/).slice(1)) {
      const eq = token.indexOf("=");
      if (eq > 0) out[token.slice(0, eq)] = token.slice(eq + 1);
    }
    return out;
  }
  return out;
}

/**
 * The ingress the operator picked, expressed for the VM.
 *
 * On this route the tunnel is not a compose sidecar — the playbook installs
 * cloudflared as a HOST service when `cloudflared_enabled` is true. Only the
 * named tunnel is that; every other shape means "no cloudflared, you front the
 * daemon's loopback port yourself (or not at all, for polling)". The playbook
 * has no other task that depends on the tunnel, so this is one clean knob.
 */
export function cloudflaredEnabledFor(ingressId: string | null): boolean {
  return ingressId === "named";
}

export function ingressNoteFor(ingressId: string | null, webhookPort: number): string {
  switch (ingressId) {
    case "named":
      return (
        "cloudflared_enabled=true — the playbook installs the cloudflared service on the server from your `tunnel_token` " +
        "secret, and your permanent hostname fronts the daemon. This is the recommended shape on this route."
      );
    case "polling":
      return (
        "cloudflared_enabled=false — you chose polling-only, so nothing is exposed and nothing needs to be: the reconcile " +
        "poll is the trigger path. Nothing else has to change if you add a tunnel later."
      );
    case null:
      return (
        "cloudflared_enabled=false — no ingress shape is recorded yet. Run the ingress step; on this route the named " +
        "Cloudflare tunnel is the recommended answer."
      );
    default:
      return (
        `cloudflared_enabled=false — you chose "${ingressId}", which on this route means YOU run that tunnel on the server ` +
        `yourself, pointing it at 127.0.0.1:${webhookPort} (the playbook installs no sidecar there; the compose sidecars are ` +
        "the other topology). The named Cloudflare tunnel is the shape this route installs for you."
      );
  }
}

function webhookPortOf(root: string): number {
  const text = readConfigText(root);
  const raw = (text ? readTomlKey(text, "server", "port") : null)?.trim() ?? "";
  return /^[0-9]{1,5}$/.test(raw) ? Number(raw) : 8787;
}

/** Assert (and, on run, correct) the two `[tui]` keys this topology needs. */
function tuiChecks(root: string, alias: string, write: boolean): CheckResult[] {
  const text = readConfigText(root);
  if (text === null) {
    return [
      {
        name: "tui",
        ok: false,
        detail: "config.toml does not exist yet — Fix: run the config_fill step; this step then points its [tui] block at the server",
      },
    ];
  }
  const target = (readTomlKey(text, "tui", "target") ?? "").trim();
  const host = (readTomlKey(text, "tui", "ssh_host") ?? "").trim();
  if (target === "ssh" && host === alias) {
    return [
      {
        name: "tui",
        ok: true,
        detail: `[tui] target = "ssh", ssh_host = "${alias}" — your board reads the daemon over ssh, which is this topology's native mode`,
      },
    ];
  }
  if (!write) {
    return [
      {
        name: "tui",
        ok: false,
        detail:
          `[tui] target = "${target}" / ssh_host = "${host}" does not point at ${alias} — Fix: run the ${VM_INVENTORY_STEP_ID} ` +
          "step, which corrects both",
      },
    ];
  }
  // Rule 1, structurally: the ONLY file in the wizard that may write `dry_run`
  // is golive.ts, on an explicit confirmation after a proven round. Every
  // other config edit — this one included — is asserted clean first.
  const edits: TomlEdit[] = [
    { section: "tui", key: "target", value: tomlString("ssh") },
    { section: "tui", key: "ssh_host", value: tomlString(alias) },
  ];
  assertNoDryRunEdit(edits);
  writeAtomic(join(root, "config.toml"), patchToml(text, edits));
  return [
    {
      name: "tui",
      ok: true,
      detail:
        `[tui] target = "ssh" and ssh_host = "${alias}" — the operator TUI stays on its native ssh mode for this topology ` +
        "(the local runner belongs to the this-computer route)",
    },
  ];
}

export interface VmInventoryOptions {
  /** Default interpreter path written into the inventory. */
  pythonInterpreter?: string;
}

export function vmInventoryStep(opts: VmInventoryOptions = {}): OnboardingStep {
  const pythonInterpreter = opts.pythonInterpreter ?? DEFAULT_PYTHON_INTERPRETER;

  function facts(ctx: StepContext, _root: string): InventoryFacts {
    const typedUser = typeof ctx.input.ansible_user === "string" ? ctx.input.ansible_user.trim() : "";
    const recordedUser = typeof ctx.choices[SSH_USER_CHOICE_KEY] === "string" ? (ctx.choices[SSH_USER_CHOICE_KEY] as string).trim() : "";
    return {
      host: sshAliasOf(ctx.choices),
      // The ssh config's own answer is the right default: it is what plain
      // `ssh <alias>` uses, so ansible and the operator agree by construction.
      ansibleUser: typedUser !== "" ? typedUser : recordedUser,
      pythonInterpreter: typeof ctx.input.python === "string" && ctx.input.python.trim() !== "" ? ctx.input.python.trim() : pythonInterpreter,
      cloudflaredEnabled: cloudflaredEnabledFor(ingressOptionOf(ctx.choices)?.id ?? null),
    };
  }

  async function act(ctx: StepContext, write: boolean): Promise<StepReport> {
    const root = rootOf(ctx.adapters);
    const alias = sshAliasOf(ctx.choices);
    if (topologyOf(ctx.choices) !== "vm" || alias === "" || !SSH_ALIAS_RE.test(alias)) {
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
    const path = inventoryPath(root);
    if (!existsSync(inventoryExamplePath(root))) {
      return {
        ok: false,
        checks: [
          {
            name: "ansible",
            ok: false,
            detail: `${inventoryExamplePath(root)} is missing — Fix: run the wizard from the QuickReview checkout; the deploy ships with it`,
          },
        ],
      };
    }

    const f = facts(ctx, root);
    const rendered = renderInventory(f);
    const checks: CheckResult[] = [];
    const ingressId = ingressOptionOf(ctx.choices)?.id ?? null;

    if (write) {
      writeAtomic(path, rendered);
      checks.push({
        name: "inventory",
        ok: true,
        detail:
          `${path} written from your answers: host ${f.host}` +
          `${f.ansibleUser !== "" ? `, ansible_user ${f.ansibleUser}` : " (login user left to your ~/.ssh/config)"}` +
          `, ${f.pythonInterpreter}. This is the file scripts/deploy.sh reads by default — no environment override, no second copy`,
      });
    } else {
      const existing = readTextOrNull(path) ?? "";
      const host = parseInventoryHost(existing);
      checks.push(
        host === f.host
          ? {
              name: "inventory",
              ok: true,
              detail: `${path} targets ${host}${cloudflaredNote(existing)} — the deploy has an inventory to run against`,
            }
          : {
              name: "inventory",
              ok: false,
              detail:
                existing === ""
                  ? `${path} does not exist yet — Fix: run the ${VM_INVENTORY_STEP_ID} step; it fills it from your answers`
                  : `${path} targets "${host || "(nothing)"}", not the recorded alias "${f.host}" — Fix: run the ` +
                    `${VM_INVENTORY_STEP_ID} step, or edit the file if the inventory is right and the alias is wrong`,
            },
      );
    }

    checks.push({ name: "ingress", ok: true, detail: ingressNoteFor(ingressId, webhookPortOf(root)) });
    checks.push(...tuiChecks(root, alias, write));
    return { ok: checks.every((c) => c.ok), checks, data: { inventory: path, host: f.host, cloudflared: f.cloudflaredEnabled } };
  }

  return {
    id: VM_INVENTORY_STEP_ID,
    title: "Fill the deploy inventory from your answers",
    explain:
      "Writes deploy/ansible/inventory.ini — the file the deploy reads — from what they have already told you: the ssh alias, " +
      "the login user their ssh config resolves, and whether the playbook should install the Cloudflare tunnel service (yes " +
      "for the named tunnel, no for every other ingress shape, in which case they front the daemon's port themselves). It also " +
      "points the operator TUI at that machine. Nothing is asked twice here; call it with no arguments unless they want a " +
      "different login user or a non-standard python path on the server.",
    order: 68,
    enabled: (choices) => topologyOf(choices) === "vm",
    parameters: {
      type: "object",
      properties: {
        ansible_user: {
          type: "string",
          description: "Login user on the server. Omit unless it differs from what their ~/.ssh/config already resolves.",
        },
        python: {
          type: "string",
          description: `Python interpreter path on the server. Omit for the Ubuntu/Debian default (${DEFAULT_PYTHON_INTERPRETER}).`,
        },
      },
    },

    run: (ctx) => act(ctx, true),
    verify: (ctx) => act(ctx, false),
  };
}

function cloudflaredNote(text: string): string {
  const vars = parseInventoryHostVars(text);
  return vars.cloudflared_enabled === undefined ? "" : ` with cloudflared_enabled=${vars.cloudflared_enabled}`;
}

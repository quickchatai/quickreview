// The deploy — the VM route's bring-up, and the whole point of the
// route being first-class rather than an "advanced README".
//
// THIS STEP COMPOSES `scripts/deploy.sh`. It does not reimplement it, does not
// call ansible-playbook itself, and does not pass it anything that could soften
// a check (see deploysh.ts for why that is structural rather than a promise).
// The guided path is exactly the manual path, so every refusal the deploying
// skill documents lands here unchanged:
//
//   * a dirty working tree — what runs on the server must be a commit you can
//     point at;
//   * pin coherence — pi, OpenViking, llama-cpp-python, the vendored
//     extension's base commit, the memory auth posture and the provisioned
//     user list, each mirrored in two or three places, all refused on drift,
//     plus the "PIN-ME" placeholder;
//   * the release manifest CI emitted with the images, and every pin it records
//     held to config.toml and group_vars (rule 7);
//   * ansible-playbook on this machine and an inventory to run against;
//   * the drain advisory — a WARNING when rounds are still running, because
//     recreating the container orphans them (deliberately a warning, never a
//     refusal, and the wizard neither hides it nor upgrades it);
//   * the playbook's own preflights on the box (the webhook port free, the
//     minimum free disk);
//   * the post-deploy checks over ssh, which the script runs itself and fails
//     on.
//
// THE PLAN COMES FIRST, ALWAYS. Every run does `--dry-run <mode>` and shows the
// operator exactly what is about to happen — the same plan they would read on
// the manual path — before the real invocation. A refusal at plan time costs
// nothing and is where nearly every refusal shows up.
//
// FIRST DEPLOY IS `provision` THEN `release <version>`. A machine with no
// updater needs the host made (packages, Docker, secrets, `qcr-update`);
// after that every deploy is `release <version>`: the image CI built once from
// the release tag, pulled by digest and recreated by the updater. Nothing is
// built or rsynced on the server. `provision` again is the deliberate act
// after a host setting (the inventory's cloudflared or embedder vars) changed,
// and the operator can always ask for it by name.
import { existsSync } from "node:fs";
import { CHOICE_KEYS } from "../choices.js";
import type { CheckResult, OnboardingStep, StepContext, StepReport } from "../engine.js";
import { nodeStreamRunner, readTextOrNull, rootOf, type StreamRunner } from "./compose.js";
import {
  effectiveInventoryPath,
  deployArgv,
  deployCommandLine,
  deployScriptPath,
  releaseVersionOf,
  type DeployArgvOptions,
  type DeployMode,
} from "./deploysh.js";
import { inventoryTargetMismatch, parseInventoryHostVars } from "./inventory.js";
import { SSH_PREFLIGHT_STEP_ID } from "./ssh.js";
import { SSH_ALIAS_RE, TOPOLOGY_STEP_ID, sshAliasOf, topologyOf } from "./topology.js";
import { stackTransportFor } from "./transport.js";

export const VM_DEPLOY_STEP_ID = "vm_deploy";
/** Recorded once a deploy has actually succeeded (mode + version + when + where). */
export const VM_DEPLOY_CHOICE_KEY = CHOICE_KEYS.vmDeployed;

export const ONBOARD_DEPLOY_MODES = ["provision", "release"] as const;
type OnboardDeployMode = (typeof ONBOARD_DEPLOY_MODES)[number];
const deployMode = (raw: unknown): OnboardDeployMode | null =>
  typeof raw === "string" && (ONBOARD_DEPLOY_MODES as readonly string[]).includes(raw)
    ? (raw as OnboardDeployMode)
    : null;

export interface VmDeployRecord {
  /** `release`: the deploy that landed (a `provision` before it, when one ran,
   * is `provisioned`). */
  mode: "release";
  /** The release version that was deployed. */
  version: string;
  /** Whether that deploy ran `provision` first. */
  provisioned: boolean;
  at: string;
  /** The ssh alias it deployed to. `null` on a record that names no host —
   * never trusted as "this host was deployed". */
  host: string | null;
  /** The inventory's host vars it deployed with (cloudflared_enabled, the
   * embedder's) — absent on a record from before they were kept. */
  host_vars?: Record<string, string>;
}

export function parseDeployRecord(value: unknown): VmDeployRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const r = value as Record<string, unknown>;
  // A record from before the release route (mode sync / rebuild) names no
  // version: it is no deploy on record, and the next run provisions and
  // releases.
  if (r.mode !== "release") return null;
  const version = releaseVersionOf(r.version);
  if (version === null) return null;
  if (typeof r.at !== "string" || r.at === "") return null;
  const vars = r.host_vars;
  const hostVars =
    typeof vars === "object" &&
    vars !== null &&
    Object.values(vars).every((v) => typeof v === "string")
      ? { host_vars: { ...(vars as Record<string, string>) } }
      : {};
  return {
    mode: "release",
    version,
    provisioned: r.provisioned === true,
    at: r.at,
    host: typeof r.host === "string" && r.host !== "" ? r.host : null,
    ...hostVars,
  };
}

/** The host vars the inventory on disk carries now. */
function currentHostVars(root: string): Record<string, string> {
  return parseInventoryHostVars(readTextOrNull(effectiveInventoryPath(root)) ?? "");
}

/** The host vars whose value differs between the last deploy and now. */
export function changedHostVars(
  before: Readonly<Record<string, string>>,
  now: Readonly<Record<string, string>>,
): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(now)]);
  return [...keys].filter((k) => before[k] !== now[k]).sort();
}

/** The deploy recorded for THIS alias, or null: a bare release only makes
 * sense on a host that has already been provisioned. */
export function deployRecordFor(value: unknown, alias: string): VmDeployRecord | null {
  const record = parseDeployRecord(value);
  return record !== null && record.host === alias ? record : null;
}

/** The warning, before the wait — the same promise the compose route makes.
 * `provision` installs the host from this machine; `release` pulls the image CI
 * built and recreates the container, so nothing compiles on the server. */
export const DEPLOY_BUILD_WARNING = [
  "About to run the same deploy the maintainers use: `scripts/deploy.sh`, which acts on your server over ssh from THIS machine.",
  "The first one is `provision`, which installs packages, Docker, your secrets and the updater on the server and starts no image.",
  "Then `release <version>` ships the image CI built once from that release's tag: the server pulls it by digest, the updater",
  "recreates the container, and the new daemon's first healthy reconcile lifts the drain. Nothing is built on the server.",
  "Every line is streamed below as it arrives. Before anything runs, the script's own preflights execute at full strength:",
  "it refuses without the release's deploy manifest, on any version-pin mismatch, without an inventory or ansible-playbook,",
  "when the server's run spec differs from this checkout's, and while review rounds are still running.",
  "Nothing is posted to GitHub by this step.",
].join("\n");

function modeOf(input: Readonly<Record<string, unknown>>): OnboardDeployMode | null {
  const raw = String(input.mode ?? "")
    .trim()
    .toLowerCase();
  return deployMode(raw);
}

export interface VmDeployStepOptions {
  stream?: StreamRunner;
  /** Emit an elapsed-time marker every N streamed lines. */
  progressEvery?: number;
}

export function vmDeployStep(opts: VmDeployStepOptions = {}): OnboardingStep {
  const stream = opts.stream ?? nodeStreamRunner;
  const progressEvery = opts.progressEvery ?? 25;

  function log(ctx: StepContext, line: string): void {
    ctx.adapters.log?.(`${VM_DEPLOY_STEP_ID}: ${line}`);
  }

  function preconditions(ctx: StepContext, root: string): CheckResult[] {
    const checks: CheckResult[] = [];
    const alias = sshAliasOf(ctx.choices);
    if (topologyOf(ctx.choices) !== "vm" || alias === "" || !SSH_ALIAS_RE.test(alias)) {
      checks.push({
        name: "alias",
        ok: false,
        detail: `no ssh alias is recorded — run the ${TOPOLOGY_STEP_ID} step, then ${SSH_PREFLIGHT_STEP_ID}, before deploying`,
      });
      return checks;
    }
    if (!existsSync(deployScriptPath(root))) {
      checks.push({
        name: "deploy-script",
        ok: false,
        detail: `${deployScriptPath(root)} is missing — Fix: run the wizard from the QuickReview checkout; the deploy ships with it`,
      });
      return checks;
    }
    const mismatch = inventoryTargetMismatch(root, alias, effectiveInventoryPath(root));
    if (mismatch !== null) checks.push({ name: "inventory", ok: false, detail: mismatch });
    return checks;
  }

  async function invoke(
    ctx: StepContext,
    root: string,
    mode: DeployMode,
    opts: DeployArgvOptions,
  ): Promise<{ code: number; tail: string }> {
    const started = ctx.adapters.clock().getTime();
    let lines = 0;
    const result = await stream.run("bash", deployArgv(root, mode, opts), (line) => {
      lines += 1;
      log(ctx, line);
      if (!opts.dryRun && lines % progressEvery === 0) {
        const mins = Math.round((ctx.adapters.clock().getTime() - started) / 60_000);
        log(
          ctx,
          `… still working — ${lines} lines of deploy output, ${mins} minute${mins === 1 ? "" : "s"} elapsed. This is normal.`,
        );
      }
    });
    const text = `${result.stdout}\n${result.stderr}`.trimEnd();
    return { code: result.code, tail: text.split("\n").slice(-20).join("\n") };
  }

  return {
    id: VM_DEPLOY_STEP_ID,
    title: "Deploy to the server, through the real deploy script",
    explain:
      "Brings the system up on the server by running scripts/deploy.sh — the same script, with the same preflights, that the " +
      "maintainers run. The first deploy is `provision` (the host: packages, Docker, secrets, the updater) and then " +
      "`release <version>` (the image CI built once from that tag, pulled by digest — nothing is built on the server). Ask which " +
      "version, and say that its deploy manifest (deploy-manifest-<version>.json, emitted by the release workflow) must be on this " +
      "machine. The plan is always printed first (a --dry-run of the same mode), and if the script refuses — missing manifest, a " +
      "version-pin mismatch, no inventory — read its own words out: those refusals are the reason the guided path is trustworthy, " +
      "and the wizard neither bypasses nor softens any of them.",
    order: 71,
    enabled: (choices) => topologyOf(choices) === "vm",
    parameters: {
      type: "object",
      properties: {
        version: {
          type: "string",
          description:
            "The release to deploy, X.Y.Z (optionally -prerelease; a leading v is dropped). Required: a release is the only deploy.",
        },
        manifest: {
          type: "string",
          description:
            "Path to the release's deploy manifest when it is not ./deploy-manifest-<version>.json.",
        },
        mode: {
          type: "string",
          enum: [...ONBOARD_DEPLOY_MODES],
          description:
            'Omit it: the first deploy provisions the host and then releases, and later ones only release. Pass "provision" by name after changing the inventory\'s host settings or the secrets.',
        },
      },
      required: ["version"],
    },

    async run(ctx): Promise<StepReport> {
      const root = rootOf(ctx.adapters);
      const checks = preconditions(ctx, root);
      if (!checks.every((c) => c.ok)) return { ok: false, checks };

      const version = releaseVersionOf(ctx.input.version);
      if (version === null) {
        checks.push({
          name: "version",
          ok: false,
          detail:
            `a release version is needed (X.Y.Z, optionally -prerelease), got ${JSON.stringify(String(ctx.input.version ?? ""))}. ` +
            "Fix: pass the version of the release whose images CI published; a release is the only deploy",
        });
        return { ok: false, checks };
      }
      const manifest =
        typeof ctx.input.manifest === "string" && ctx.input.manifest.trim() !== ""
          ? ctx.input.manifest.trim()
          : undefined;
      const releaseOpts: DeployArgvOptions = { version, ...(manifest ? { manifest } : {}) };

      const alias = sshAliasOf(ctx.choices);
      const previous = deployRecordFor(ctx.choices[VM_DEPLOY_CHOICE_KEY], alias);
      const hostVars = currentHostVars(root);
      // A release starts past the host provisioning (cloudflared, packages), so
      // an ingress or embedder choice that changed the inventory's host vars
      // since the last deploy is applied only by `provision`.
      const changed =
        previous?.host_vars !== undefined ? changedHostVars(previous.host_vars, hostVars) : [];
      const asked = modeOf(ctx.input);
      // Asking for the release by name is the release alone — on a host that has been
      // provisioned before; otherwise a changed host setting provisions first.
      const provision =
        asked === "provision" || previous === null || (asked === null && changed.length > 0);
      checks.push({
        name: "mode",
        ok: true,
        detail: provision
          ? `\`${deployCommandLine("provision")}\` then \`${deployCommandLine("release", releaseOpts)}\` — the host is made first` +
            (asked !== null
              ? ", as you asked"
              : previous === null
                ? ", which is what a first deploy needs"
                : `, because the inventory's host settings changed since the last deploy (${changed.join(", ")}) and only provision ` +
                  "re-runs the host setup that applies them")
          : `\`${deployCommandLine("release", releaseOpts)}\` — the image CI built for ${version} is pulled by digest and the container recreated; ` +
            `the host is left alone (deployed before, ${previous?.version} at ${previous?.at ?? "an unrecorded time"})`,
      });

      // 1. THE PLAN. The same --dry-run the manual path reads, and where a
      //    refusal almost always surfaces — before anything has been touched.
      //    A host that is not provisioned yet has no updater to ask, so its
      //    release plan is printed after the provision.
      const planOf = async (mode: DeployMode, opts: DeployArgvOptions): Promise<boolean> => {
        const line = deployCommandLine(mode, { ...opts, dryRun: true });
        log(ctx, `printing the plan first: \`${line}\``);
        const plan = await invoke(ctx, root, mode, { ...opts, dryRun: true });
        if (plan.code !== 0) {
          checks.push({
            name: "plan",
            ok: false,
            detail:
              `\`${line}\` refused (exit ${plan.code}). This is the deploy script's own ` +
              `refusal, quoted exactly, and the wizard does not have a way to override it:\n\n${plan.tail}\n\n` +
              "Fix what it names and run this step again. The commonest on a first install are a missing deploy manifest " +
              "(download deploy-manifest-<version>.json from the release, or name it with `manifest`) and a version-pin mismatch " +
              "(reconcile the two spellings by hand).",
          });
          return false;
        }
        checks.push({
          name: "plan",
          ok: true,
          detail:
            `the plan for \`${line}\`, and the deploy script's own preflights on this machine passed. ` +
            `The checks on the server and the post-deploy checks run with the real deploy below:\n${plan.tail}`,
        });
        return true;
      };
      if (provision) {
        if (!(await planOf("provision", {}))) return { ok: false, checks };
      } else if (!(await planOf("release", releaseOpts))) {
        return { ok: false, checks };
      }

      // 2. The warning goes out BEFORE the long wait, never after it.
      for (const line of DEPLOY_BUILD_WARNING.split("\n")) log(ctx, line);
      checks.push({ name: "first-deploy", ok: true, detail: DEPLOY_BUILD_WARNING });

      // 3. The deploy itself.
      const started = ctx.adapters.clock().getTime();
      const fail = (
        mode: DeployMode,
        opts: DeployArgvOptions,
        code: number,
        tail: string,
      ): StepReport => {
        checks.push({
          name: "deploy",
          ok: false,
          detail:
            `\`${deployCommandLine(mode, opts)}\` exited ${code}. Its last output:\n${tail}\n\n` +
            "Fix: the message above is the script's, Ansible's or the updater's own. Re-running this step is safe — provision is " +
            "idempotent, and a release that failed before the recreate left the previous container as it was; one that failed " +
            "after it keeps the drain on and is fixed forward (the updater's output says which). Run the verification step, " +
            "which asks what is actually running, in layers.",
        });
        return { ok: false, checks };
      };
      if (provision) {
        const prov = await invoke(ctx, root, "provision", {});
        if (prov.code !== 0) return fail("provision", {}, prov.code, prov.tail);
        // The release's own plan needs the updater provision just installed.
        if (!(await planOf("release", releaseOpts))) return { ok: false, checks };
      }
      const run = await invoke(ctx, root, "release", releaseOpts);
      if (run.code !== 0) return fail("release", releaseOpts, run.code, run.tail);
      const mins = Math.round((ctx.adapters.clock().getTime() - started) / 60_000);
      checks.push({
        name: "deploy",
        ok: true,
        detail: `\`${deployCommandLine("release", releaseOpts)}\` finished in ${mins} minute${mins === 1 ? "" : "s"}, including its own post-deploy checks over ssh`,
      });

      // 4. Docker's own answer, through the same transport every later step
      //    uses — so "it deployed" is a checked claim, not the script's word.
      const transport = stackTransportFor(ctx);
      checks.push(...(await transport.containerChecks(null)));

      const ok = checks.every((c) => c.ok);
      const record: VmDeployRecord = {
        mode: "release",
        version,
        provisioned: provision,
        at: ctx.adapters.clock().toISOString(),
        host: alias,
        ...(provision
          ? { host_vars: hostVars }
          : previous?.host_vars !== undefined
            ? { host_vars: previous.host_vars }
            : {}),
      };
      // The release exited 0, so the version is deployed whatever the follow-up
      // container probe found; a probe failure must not leave the previous version
      // recorded for the next config delivery to re-release.
      ctx.recordChoice(CHOICE_KEYS.vmDeployed, record);
      return { ok, checks, data: { deploy: record } };
    },

    async verify(ctx): Promise<StepReport> {
      // Verification NEVER deploys — and never re-runs the script either: its
      // preflights are about shipping, and a missing manifest is not a reason
      // to call a running server unhealthy. It asks the server what is running.
      const root = rootOf(ctx.adapters);
      const checks = preconditions(ctx, root);
      if (!checks.every((c) => c.ok)) return { ok: false, checks };
      const alias = sshAliasOf(ctx.choices);
      const record = deployRecordFor(ctx.choices[VM_DEPLOY_CHOICE_KEY], alias);
      const other = parseDeployRecord(ctx.choices[VM_DEPLOY_CHOICE_KEY]);
      checks.push(
        record === null
          ? {
              name: "deploy",
              ok: false,
              detail:
                other === null
                  ? `no deploy recorded yet to ${alias} — run the ${VM_DEPLOY_STEP_ID} step`
                  : `the recorded deploy (${other.at}) was to ${other.host === null ? "an unrecorded host" : `"${other.host}"`}, ` +
                    `not ${alias} — run the ${VM_DEPLOY_STEP_ID} step (it provisions a host with no deploy on record first)`,
            }
          : {
              name: "deploy",
              ok: true,
              detail: `last deployed with \`${deployCommandLine("release", { version: record.version })}\` at ${record.at}`,
            },
      );
      const drift =
        record?.host_vars === undefined
          ? []
          : changedHostVars(record.host_vars, currentHostVars(root));
      if (drift.length > 0)
        checks.push({
          name: "host-settings",
          ok: false,
          detail: `inventory host settings changed since the last provision (${drift.join(", ")}); run ${VM_DEPLOY_STEP_ID} with mode "provision"`,
        });
      checks.push(...(await stackTransportFor(ctx).containerChecks(null)));
      return { ok: checks.every((c) => c.ok), checks };
    },
  };
}

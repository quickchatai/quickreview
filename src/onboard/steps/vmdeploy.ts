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
//   * `sandbox_src` actually wired, or the rsync silently no-ops;
//   * ansible-playbook on this machine and an inventory to run against;
//   * the drain advisory — a WARNING when rounds are still running, because
//     recreating the container orphans them (WARN by the owner's own choice,
//     never a refusal, and the wizard neither hides it nor upgrades it);
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
// FIRST DEPLOY IS `rebuild`, LATER ONES ARE `sync`. A machine with no image
// needs one built against the pins; after that the image is the pinned
// artifact and a code change ships with an rsync + container recreate. Bumping
// a pin is the deliberate act that calls for `rebuild` again, and the operator
// can always ask for it by name.
import { existsSync } from "node:fs";
import type { CheckResult, OnboardingStep, StepContext, StepReport } from "../engine.js";
import { nodeStreamRunner, rootOf, type StreamRunner } from "./compose.js";
import { deployArgv, deployCommandLine, deployScriptPath, type DeployMode } from "./deploysh.js";
import { inventoryTargetMismatch } from "./inventory.js";
import { SSH_PREFLIGHT_STEP_ID } from "./ssh.js";
import { SSH_ALIAS_RE, TOPOLOGY_STEP_ID, sshAliasOf, topologyOf } from "./topology.js";
import { stackTransportFor } from "./transport.js";

export const VM_DEPLOY_STEP_ID = "vm_deploy";
/** Recorded once a deploy has actually succeeded (mode + when + where). */
export const VM_DEPLOY_CHOICE_KEY = "vm_deployed";

export interface VmDeployRecord {
  mode: DeployMode;
  at: string;
  /** The ssh alias it deployed to. `null` on a record written before deploys
   * were scoped to a host — never trusted as "this host was deployed". */
  host: string | null;
}

export function parseDeployRecord(value: unknown): VmDeployRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const r = value as Record<string, unknown>;
  const mode = r.mode;
  if (mode !== "sync" && mode !== "rebuild") return null;
  if (typeof r.at !== "string" || r.at === "") return null;
  return { mode, at: r.at, host: typeof r.host === "string" && r.host !== "" ? r.host : null };
}

/** The deploy recorded for THIS alias, or null: a sync only makes sense on a
 * host that has already had its first (rebuild) install. */
export function deployRecordFor(value: unknown, alias: string): VmDeployRecord | null {
  const record = parseDeployRecord(value);
  return record !== null && record.host === alias ? record : null;
}

/** The warning, before the wait — the same promise the compose route makes.
 * `rebuild` builds the image on the SERVER, and that image compiles the memory
 * engine's local embedder from source. */
export const DEPLOY_BUILD_WARNING = [
  "About to run the same deploy the maintainers use: `scripts/deploy.sh`, which is an Ansible run from THIS machine",
  "against your server over ssh.",
  "The first one is a `rebuild`: it installs packages on the server, builds the container image there, and that image",
  "compiles the memory engine's local embedder (llama-cpp-python) from source. On a small VM that is tens of minutes.",
  "Every line is streamed below as it arrives — a long quiet stretch inside a build step is normal, not a hang.",
  "Before anything runs, the script's own preflights execute at full strength: it refuses on a dirty working tree, on any",
  "version-pin mismatch, without an inventory or ansible-playbook, and it warns if review rounds are still running.",
  "Nothing is posted to GitHub by this step.",
].join("\n");

function modeOf(input: Readonly<Record<string, unknown>>): DeployMode | null {
  const raw = String(input.mode ?? "")
    .trim()
    .toLowerCase();
  return raw === "sync" || raw === "rebuild" ? raw : null;
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
    const mismatch = inventoryTargetMismatch(root, alias);
    if (mismatch !== null) checks.push({ name: "inventory", ok: false, detail: mismatch });
    return checks;
  }

  async function invoke(
    ctx: StepContext,
    root: string,
    mode: DeployMode,
    dryRun: boolean,
  ): Promise<{ code: number; tail: string }> {
    const started = ctx.adapters.clock().getTime();
    let lines = 0;
    const result = await stream.run("bash", deployArgv(root, mode, { dryRun }), (line) => {
      lines += 1;
      log(ctx, line);
      if (!dryRun && lines % progressEvery === 0) {
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
      "maintainers run. Say plainly BEFORE starting that the first deploy builds the container image on the server and compiles " +
      "the memory engine's embedder from source, so it takes tens of minutes and the streamed output is the proof it is alive. " +
      "The plan is always printed first (a --dry-run of the same mode), and if the script refuses — dirty tree, a version-pin " +
      "mismatch, no inventory — read its own words out: those refusals are the reason the guided path is trustworthy, and the " +
      "wizard neither bypasses nor softens any of them.",
    order: 71,
    enabled: (choices) => topologyOf(choices) === "vm",
    parameters: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["sync", "rebuild"],
          description:
            'Omit it: the first deploy picks "rebuild" (the image must exist) and later ones pick "sync". Pass "rebuild" by name after bumping a pinned version.',
        },
      },
    },

    async run(ctx): Promise<StepReport> {
      const root = rootOf(ctx.adapters);
      const checks = preconditions(ctx, root);
      if (!checks.every((c) => c.ok)) return { ok: false, checks };

      const alias = sshAliasOf(ctx.choices);
      const previous = deployRecordFor(ctx.choices[VM_DEPLOY_CHOICE_KEY], alias);
      const mode: DeployMode = modeOf(ctx.input) ?? (previous === null ? "rebuild" : "sync");
      checks.push({
        name: "mode",
        ok: true,
        detail:
          mode === "rebuild"
            ? `\`${deployCommandLine("rebuild")}\` — the image is (re)built on the server against the pinned versions` +
              `${previous === null ? ", which is what a first deploy needs" : ", as you asked"}`
            : `\`${deployCommandLine("sync")}\` — the working copy is mirrored to the server and the container recreated; the ` +
              "pinned image is left alone (deployed before, at " +
              `${previous?.at ?? "an unrecorded time"})`,
      });

      // 1. THE PLAN. The same --dry-run the manual path reads, and where a
      //    refusal almost always surfaces — before anything has been touched.
      log(ctx, `printing the plan first: \`${deployCommandLine(mode, { dryRun: true })}\``);
      const plan = await invoke(ctx, root, mode, true);
      if (plan.code !== 0) {
        checks.push({
          name: "plan",
          ok: false,
          detail:
            `\`${deployCommandLine(mode, { dryRun: true })}\` refused (exit ${plan.code}). This is the deploy script's own ` +
            `refusal, quoted exactly, and the wizard does not have a way to override it:\n\n${plan.tail}\n\n` +
            "Fix what it names and run this step again. The commonest two on a first install are an uncommitted change (commit " +
            "it locally — this checkout has no remote to push to) and a version-pin mismatch (reconcile the two spellings by hand).",
        });
        return { ok: false, checks };
      }
      checks.push({
        name: "plan",
        ok: true,
        detail: `the plan, and every preflight passed:\n${plan.tail}`,
      });

      // 2. The warning goes out BEFORE the long wait, never after it.
      for (const line of DEPLOY_BUILD_WARNING.split("\n")) log(ctx, line);
      checks.push({ name: "first-deploy", ok: true, detail: DEPLOY_BUILD_WARNING });

      // 3. The deploy itself.
      const started = ctx.adapters.clock().getTime();
      const run = await invoke(ctx, root, mode, false);
      if (run.code !== 0) {
        checks.push({
          name: "deploy",
          ok: false,
          detail:
            `\`${deployCommandLine(mode)}\` exited ${run.code}. Its last output:\n${run.tail}\n\n` +
            "Fix: the message above is the script's or Ansible's own. Re-running this step is always safe — the playbook is " +
            "idempotent, and a failed run leaves the previous container where it was. If the POST-DEPLOY checks are what failed, " +
            "the system may well be up: run the verification step, which asks the same questions in layers.",
        });
        return { ok: false, checks };
      }
      const mins = Math.round((ctx.adapters.clock().getTime() - started) / 60_000);
      checks.push({
        name: "deploy",
        ok: true,
        detail: `\`${deployCommandLine(mode)}\` finished in ${mins} minute${mins === 1 ? "" : "s"}, including its own post-deploy checks over ssh`,
      });

      // 4. Docker's own answer, through the same transport every later step
      //    uses — so "it deployed" is a checked claim, not the script's word.
      const transport = stackTransportFor(ctx);
      checks.push(...(await transport.containerChecks(null)));

      const ok = checks.every((c) => c.ok);
      const record: VmDeployRecord = { mode, at: ctx.adapters.clock().toISOString(), host: alias };
      if (ok) ctx.recordChoice(VM_DEPLOY_CHOICE_KEY, record);
      return { ok, checks, data: { deploy: record } };
    },

    async verify(ctx): Promise<StepReport> {
      // Verification NEVER deploys — and never re-runs the script either: its
      // preflights are about shipping, and a dirty tree is not a reason to
      // call a running server unhealthy. It asks the server what is running.
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
                    `not ${alias} — run the ${VM_DEPLOY_STEP_ID} step (it defaults to a full rebuild for a host with no deploy on record)`,
            }
          : {
              name: "deploy",
              ok: true,
              detail: `last deployed with \`${deployCommandLine(record.mode)}\` at ${record.at}`,
            },
      );
      checks.push(...(await stackTransportFor(ctx).containerChecks(null)));
      return { ok: checks.every((c) => c.ok), checks };
    },
  };
}

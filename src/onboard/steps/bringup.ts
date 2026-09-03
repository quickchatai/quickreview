// Bring-up — the moment the system stops being configuration and
// starts being a running reviewer.
//
// Three things this step owes the operator, and each one is a design decision
// rather than a detail:
//
//   1. THE UID. Preflight captured it; the image build takes it as
//      `REVIEW_UID` so the container user owns the bind-mounted checkout. The
//      engine's ProcessRunner takes no environment, and compose reads the
//      project `.env` for exactly this kind of value — so the uid is written
//      there (`QCR_UID`), which also means the operator's own later
//      `docker compose up` behaves identically to the wizard's. Same reason the
//      chosen ingress profile is written there by the ingress step; this step
//      re-asserts it and ALSO passes `--profile` explicitly, so what comes up
//      is visible in the command rather than inferred from a file.
//
//   2. AN HONEST WARNING, BEFORE THE WAIT. The first build compiles
//      llama-cpp-python from source (the memory engine's local embedder — not
//      optional: without it the OpenViking image cannot boot at all). That is
//      tens of minutes on a laptop, and a wizard that goes silent for half an
//      hour reads as broken. The warning is emitted BEFORE the build starts,
//      never after, and the test pins that ordering.
//
//   3. PROGRESS, NOT SILENCE. Build output is streamed line by line through
//      the engine's log adapter (see compose.ts's StreamRunner and why the
//      short-command ProcessRunner cannot do this job), with an elapsed-time
//      marker every few lines so a long quiet stretch inside Docker still
//      looks alive.
//
// What this step does NOT do: verify the system works. Container state, the
// health endpoint and webhook ping delivery are the verify_stack step's job —
// layered, each with its own fix. Bring-up's own success bar is "the compose
// command succeeded and the daemon container is running".
import { existsSync, readFileSync } from "node:fs";
import type { CheckResult, OnboardingStep, StepContext, StepReport } from "../engine.js";
import {
  composePs,
  composeFileCheck,
  containerStateCheck,
  ingressOptionOf,
  nodeStreamRunner,
  readEnvText,
  rootOf,
  writeAtomic,
  type StreamRunner,
} from "./compose.js";
import { declaredEmbedderOf, describeEmbedder, embedderEnvEntries } from "./embeddings.js";
import { readEnvKey, setEnvKey } from "./ingress.js";
import { UID_CHOICE_KEY } from "./preflight.js";
import { CHOICE_KEYS } from "./configfill.js";

export const BRINGUP_STEP_ID = "bringup";
/** Recorded so the later steps know the stack was actually started once. */
export const BROUGHT_UP_CHOICE_KEY = "stack_brought_up_at";

/**
 * The warning, in the operator's words, emitted BEFORE the build begins.
 * Exported so the test can assert both its content and its ordering.
 */
export const FIRST_BUILD_WARNING = [
  "About to build the container images and start the stack.",
  "The FIRST build is slow — genuinely slow. It compiles the memory engine's local embedder",
  "(llama-cpp-python) from source, which on a laptop takes anywhere from ten minutes to an hour",
  "depending on your CPU. That is expected, not a hang: every line Docker prints is shown below",
  "as it arrives. Later builds reuse the cache and take seconds.",
  "Nothing is downloaded from anywhere but Docker Hub, PyPI and npm, and nothing is posted to",
  "GitHub by this step.",
].join("\n");

export interface BringUpStepOptions {
  /** The long-command seam (see compose.ts). Tests replace it wholesale. */
  stream?: StreamRunner;
  /** Emit an elapsed-time marker every N streamed lines. */
  progressEvery?: number;
}

/** `docker compose [--profile p] up -d --build`, built in one place. */
export function bringUpArgs(root: string, profile: string): string[] {
  const profileArgs = profile === "" ? [] : ["--profile", profile];
  return ["compose", "--project-directory", root, ...profileArgs, "up", "-d", "--build"];
}

export function bringUpStep(opts: BringUpStepOptions = {}): OnboardingStep {
  const stream = opts.stream ?? nodeStreamRunner;
  const progressEvery = opts.progressEvery ?? 25;

  function log(ctx: StepContext, line: string): void {
    ctx.adapters.log?.(`${BRINGUP_STEP_ID}: ${line}`);
  }

  /** The captured uid — preflight's recorded choice, then the live host. */
  function uidOf(ctx: StepContext): number | null {
    const recorded = ctx.choices[UID_CHOICE_KEY];
    if (typeof recorded === "number" && Number.isInteger(recorded)) return recorded;
    return ctx.adapters.host.uid;
  }

  return {
    id: BRINGUP_STEP_ID,
    title: "Bring the stack up",
    explain:
      "Starts QuickReview: it builds the images (as your own user id, so the container and your checkout can share files) " +
      "and brings up the daemon plus whichever webhook tunnel you chose. Say plainly BEFORE running it that the first build " +
      "compiles the memory engine's local embedder from source and can take from ten minutes to an hour — the output is " +
      "streamed line by line so the wait is visible rather than silent. Later builds are seconds.",
    order: 70,
    // The compose stack is the laptop route. The VM-over-ssh route brings the
    // same system up through the existing Ansible flow and registers
    // its own steps; this one stays out of its way.
    enabled: (choices) => choices[CHOICE_KEYS.topology] !== "vm",

    async run(ctx): Promise<StepReport> {
      const root = rootOf(ctx.adapters);
      const checks: CheckResult[] = [composeFileCheck(root)];
      if (!checks[0]!.ok) return { ok: false, checks };

      const uid = uidOf(ctx);
      if (uid === null) {
        checks.push({
          name: "uid",
          ok: false,
          detail:
            "no user id was captured, so the container user cannot be matched to your checkout — Fix: run the preflight step " +
            "(on Windows, run the wizard inside WSL2, which is the supported route)",
        });
        return { ok: false, checks };
      }
      if (!existsSync(`${root}/config.toml`)) {
        checks.push({
          name: "config",
          ok: false,
          detail:
            "config.toml does not exist yet — Fix: run the config_fill step; the daemon reads that file at boot",
        });
        return { ok: false, checks };
      }

      // The project .env: the uid for the image build, and the ingress profile
      // the ingress step chose (re-asserted here so a hand-edited .env cannot
      // silently bring up a different shape than the checklist recorded).
      const option = ingressOptionOf(ctx.choices);
      const envText = readEnvText(root);
      const profile = option ? option.profile : (readEnvKey(envText, "COMPOSE_PROFILES") ?? "");
      let next = setEnvKey(envText, "QCR_UID", String(uid));
      next = setEnvKey(next, "COMPOSE_PROFILES", profile);
      // the embedder config.toml declares, carried into the .env the
      // compose file passes to the container — the ONE place the boot reads
      // it from on this route. config.toml is the truth; this is its mirror,
      // re-asserted on every bring-up so the two cannot drift apart.
      const embedder = declaredEmbedderOf(readFileSync(`${root}/config.toml`, "utf8"));
      for (const [key, value] of embedderEnvEntries(embedder)) next = setEnvKey(next, key, value);
      if (next !== envText) writeAtomic(`${root}/.env`, next);
      checks.push({
        name: "build-inputs",
        ok: true,
        detail:
          `.env: QCR_UID=${uid} (the container user, so it owns the files it writes in your checkout), ` +
          `COMPOSE_PROFILES=${profile === "" ? "(empty — daemon only, the polling shape)" : profile}` +
          `${option ? ` for the ${option.id} ingress you chose` : " (no ingress shape recorded — bringing up the daemon alone)"}` +
          `, and the memory embedder ${describeEmbedder(embedder)} from config.toml${embedder.provider === "local" ? " (local: no memory text leaves this machine)" : ""}`,
      });

      // The warning goes out BEFORE the long wait, never after it.
      for (const line of FIRST_BUILD_WARNING.split("\n")) log(ctx, line);
      checks.push({ name: "first-build", ok: true, detail: FIRST_BUILD_WARNING });

      const started = ctx.adapters.clock().getTime();
      let lines = 0;
      const result = await stream.run("docker", bringUpArgs(root, profile), (line) => {
        lines += 1;
        log(ctx, line);
        if (lines % progressEvery === 0) {
          const mins = Math.round((ctx.adapters.clock().getTime() - started) / 60_000);
          log(
            ctx,
            `… still working — ${lines} lines of Docker output, ${mins} minute${mins === 1 ? "" : "s"} elapsed. This is normal.`,
          );
        }
      });
      if (result.code !== 0) {
        checks.push({
          name: "compose-up",
          ok: false,
          detail:
            `\`docker compose up -d --build\` exited ${result.code}. Last output:\n${tail(result.stderr || result.stdout)}\n` +
            "Fix: the message above is Docker's own. The three that come up most often are: no disk space (`docker system df`, " +
            "then `docker system prune`), the Docker daemon not running, and a network failure mid-download — all of them are " +
            "safe to retry by running this step again, which resumes from the layers already built.",
        });
        return { ok: false, checks };
      }
      const elapsedMin = Math.round((ctx.adapters.clock().getTime() - started) / 60_000);
      checks.push({
        name: "compose-up",
        ok: true,
        detail: `the stack was built and started in ${elapsedMin} minute${elapsedMin === 1 ? "" : "s"} (${lines} lines of build output)`,
      });

      checks.push(...containerStateCheck(await composePs(ctx.adapters.runner, root), option));
      const ok = checks.every((c) => c.ok);
      if (ok) ctx.recordChoice(BROUGHT_UP_CHOICE_KEY, ctx.adapters.clock().toISOString());
      return { ok, checks, data: { profile, up_at: ctx.adapters.clock().toISOString() } };
    },

    async verify(ctx): Promise<StepReport> {
      // Re-running as verification NEVER builds: it asks what is running.
      const root = rootOf(ctx.adapters);
      const checks = containerStateCheck(
        await composePs(ctx.adapters.runner, root),
        ingressOptionOf(ctx.choices),
      );
      return { ok: checks.every((c) => c.ok), checks };
    },
  };
}

/** The last few lines of a failed command, which is the part that says why. */
function tail(text: string, lines = 12): string {
  const rows = text.trimEnd().split("\n");
  return rows.slice(Math.max(0, rows.length - lines)).join("\n");
}

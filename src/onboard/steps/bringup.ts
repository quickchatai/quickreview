// Bring-up — the moment the system stops being configuration and
// starts being a running reviewer.
//
// Three things this step owes the operator, and each one is a design decision
// rather than a detail:
//
//   1. The uid. Preflight captured it; the image build takes it as
//      `REVIEW_UID` so the container user owns the bind-mounted checkout. The
//      engine's ProcessRunner takes no environment, and compose reads the
//      project `.env` for exactly this kind of value — so the uid is written
//      there (`QCR_UID`), which also means the operator's own later
//      `docker compose up` behaves identically to the wizard's. Same reason the
//      chosen ingress profile is written there by the ingress step; this step
//      re-asserts it and also passes `--profile` explicitly, so what comes up
//      is visible in the command rather than inferred from a file.
//
//   2. An honest warning, before the wait. The first build compiles
//      llama-cpp-python from source (the memory engine's local embedder — not
//      optional: without it the OpenViking image cannot boot at all). That is
//      tens of minutes on a laptop, and a wizard that goes silent for half an
//      hour reads as broken. The warning is emitted before the build starts,
//      never after, and the test pins that ordering.
//
//   3. Progress, not silence. Build output is streamed line by line through
//      the engine's log adapter (see compose.ts's StreamRunner and why the
//      short-command ProcessRunner cannot do this job), with an elapsed-time
//      marker every few lines so a long quiet stretch inside Docker still
//      looks alive.
//
// What this step does not do: verify the system works. Container state, the
// health endpoint and webhook ping delivery are the verify_stack step's job —
// layered, each with its own fix. Bring-up's own success bar is "the compose
// command succeeded and the daemon container is running".
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { CheckResult, OnboardingStep, StepContext, StepReport } from "../engine.js";
import {
  composeArgs,
  composePs,
  composeFileCheck,
  containerStateCheck,
  ingressOptionOf,
  nodeStreamRunner,
  readEnvText,
  readTextOrNull,
  rootOf,
  secretsDirFor,
  writeAtomic,
  type StreamRunner,
} from "./compose.js";
import {
  declaredEmbedderOf,
  describeEmbedder,
  embedderEnvEntries,
  embedderInputsCheck,
  localEmbedderEnvEntries,
} from "./embeddings.js";
import { readEnvKey, setEnvKey } from "./ingress.js";
import { UID_CHOICE_KEY } from "./preflight.js";
import { topologyOf } from "./topology.js";

export const BRINGUP_STEP_ID = "bringup";
/** Recorded timestamp of this step's successful bring-up. */
export const BROUGHT_UP_CHOICE_KEY = "stack_brought_up_at";

/**
 * The warning, in the operator's words, emitted before the build begins.
 * Exported so the test can assert both its content and its ordering.
 */
export const FIRST_BUILD_WARNING = [
  "About to build the container images and start the stack.",
  "The FIRST build is slow — genuinely slow. It compiles the memory engine's local embedder",
  "(llama-cpp-python) from source, which on a laptop takes anywhere from ten minutes to an hour",
  "depending on your CPU. That is expected, not a hang: every line Docker prints is shown below",
  "as it arrives. Later builds reuse the cache and take seconds.",
  "The build downloads only what the images are made of — the base image (Docker Hub), system",
  "packages (Ubuntu, NodeSource, the GitHub CLI's apt repository), tmux's source (GitHub), Python",
  "and npm packages, and the embedder's pinned model file (Hugging Face) — and nothing is posted to",
  "GitHub by this step.",
].join("\n");

export interface BringUpStepOptions {
  /** The long-command seam (see compose.ts). Tests replace it wholesale. */
  stream?: StreamRunner;
  /** Emit an elapsed-time marker every N streamed lines. */
  progressEvery?: number;
}

/** What the compose file mounts as the container's config home: the
 * directory of the config the locator found, whatever it is — the container
 * reads no other (there is no checkout fallback). */
export function configMountOf(configPath: string): { dir: string; name: string } {
  const located = resolve(configPath);
  return { dir: dirname(located), name: basename(located) };
}

/** `docker compose [--profile p] up -d --build`, built in one place. */
export function bringUpArgs(root: string, profile: string): string[] {
  const profileArgs = profile === "" ? [] : ["--profile", profile];
  return composeArgs(root, [...profileArgs, "up", "-d", "--build"]);
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
    enabled: (choices) => topologyOf(choices) === "local",

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
      if (!existsSync(ctx.adapters.paths.configPath)) {
        checks.push({
          name: "config",
          ok: false,
          detail:
            "config.toml does not exist yet — Fix: run the config_fill step; the daemon reads that file at boot",
        });
        return { ok: false, checks };
      }

      // The two host dirs the compose file bind-mounts from .env values.
      // Compose interpolates `$VAR` in an unquoted .env value, so a path
      // carrying a `$` would mount a different directory than this one
      // (`/srv/$TEAM` → `/srv/` with TEAM unset) — refused before anything
      // is created or written.
      const mount = configMountOf(ctx.adapters.paths.configPath);
      const secretsDir = secretsDirFor(ctx.adapters, ctx.choices);
      const uninterpolable = [mount.dir, mount.name, secretsDir].filter((p) => /[$\n]|\s#/.test(p));
      if (uninterpolable.length > 0) {
        checks.push({
          name: "mount-paths",
          ok: false,
          detail:
            `${uninterpolable.join(", ")} cannot be passed to Docker Compose through .env: Compose expands \`$\` and treats whitespace followed by # as a comment, ` +
            "so it would mount a different directory than the one you chose — Fix: move it to a path without `$`, newlines or whitespace followed by # " +
            "(the config's [github] secrets_dir, or where QCR_CONFIG points) and run this step again",
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
      // The embedder config.toml declares, carried into the .env the
      // compose file passes to the container — the one place the boot reads
      // it from on this route. config.toml is the truth; this is its mirror,
      // re-asserted on every bring-up so the two cannot drift apart.
      const configText = readFileSync(ctx.adapters.paths.configPath, "utf8");
      const embedder = declaredEmbedderOf(configText);
      for (const [key, value] of embedderEnvEntries(embedder)) next = setEnvKey(next, key, value);
      // And the local embedder's port and threads — the daemon
      // reads them from config.toml, the boot renders ov.conf from these.
      for (const [key, value] of localEmbedderEnvEntries(configText))
        next = setEnvKey(next, key, value);
      // The directory the compose file mounts read-only as the
      // container's config home — the one holding the config the install
      // locator found — the only config the container reads. Created here so
      // Docker never creates it, owned by root.
      mkdirSync(mount.dir, { recursive: true, mode: 0o700 });
      next = setEnvKey(next, "QCR_CONFIG_HOME", mount.dir);
      next = setEnvKey(next, "QCR_CONFIG_NAME", mount.name);
      // The secrets dir the compose file mounts read-only at
      // /opt/quickreview/secrets — the install locator's answer, the same one
      // the daemon's loader reaches (the compose default is only the default
      // install's, for a stack started by hand before this step ran). Created here
      // for the same reason as the config home: never by Docker, as root.
      mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
      next = setEnvKey(next, "QCR_SECRETS_DIR", secretsDir);
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

      // The warning goes out before the long wait, never after it.
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
      // Re-running as verification never builds: it asks what is running.
      const root = rootOf(ctx.adapters);
      const checks = containerStateCheck(
        await composePs(ctx.adapters.runner, root),
        ingressOptionOf(ctx.choices),
      );
      const text = readTextOrNull(ctx.adapters.paths.configPath);
      if (text === null)
        return {
          ok: false,
          checks: [
            ...checks,
            {
              name: "embedder",
              ok: false,
              detail:
                "config.toml is unreadable — embedder inputs are unknown; restore it before verifying bring-up",
            },
          ],
        };
      checks.push(embedderInputsCheck(text, readEnvText(root)));
      return { ok: checks.every((c) => c.ok), checks };
    },
  };
}

/** The last few lines of a failed command, which is the part that says why. */
function tail(text: string, lines = 12): string {
  const rows = text.trimEnd().split("\n");
  return rows.slice(Math.max(0, rows.length - lines)).join("\n");
}

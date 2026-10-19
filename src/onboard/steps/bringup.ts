// Bring-up — the moment the system stops being configuration and
// starts being a running reviewer.
//
// The stack is the released images, pulled, never built: `docker compose pull`
// fetches `ghcr.io/quickchatai/quickreview` (the daemon) and
// `quickreview-memory` (OpenViking and its local embedder), pinned by
// QCR_VERSION in the project `.env`, and `docker compose up -d` starts them.
// Only the tunnel sidecar the operator chose is built, from a thin wrapper
// over the vendor's own image. Four things this step owes the operator, and
// each one is a design decision rather than a detail:
//
//   1. The uid. Preflight captured it; the containers run as it (`user:` in
//      the compose file) so they can read the 0600 files the operator owns in
//      the secrets mount. The engine's ProcessRunner takes no environment, and
//      compose reads the project `.env` for exactly this kind of value — so the
//      uid is written there (`QCR_UID`), which also means the operator's own
//      later `docker compose up` behaves identically to the wizard's. Same
//      reason the chosen ingress profile is written there by the ingress step;
//      this step re-asserts it and also passes `--profile` explicitly, so what
//      comes up is visible in the command rather than inferred from a file.
//
//   2. The memory endpoint. The release image carries no OpenViking: the
//      memory engine is the `memory` service, so config.toml must say
//      `[openviking] endpoint = "remote"` and `host = "memory"`. This step
//      writes both when memory is on, like the other config-writing steps
//      (never `dry_run`, in either direction).
//
//   3. An honest note, before the wait. The first pull downloads two images,
//      the memory one with its embedding model inside. That is minutes on a
//      slow link, and a wizard that goes silent reads as broken. The note is
//      emitted before the pull starts, never after, and the test pins that
//      ordering. Every line Docker prints is streamed as it arrives (see
//      compose.ts's StreamRunner and why the short-command ProcessRunner
//      cannot do this job), with an elapsed-time marker every few lines.
//
//   4. No Docker, no problem (D16). The wizard can run inside the release
//      image (`qcr onboard`), which has no docker CLI and no socket and never
//      gets one. When this step finds no `docker compose` it starts nothing:
//      it prints the exact commands for the host — the extraction of the
//      compose file from the image, the `.env`, the pull and the `up` — and
//      stays red until the stack is seen running.
//
// What this step does not do: verify the system works. Container state, the
// health endpoint and webhook ping delivery are the verify_stack step's job —
// layered, each with its own fix. Bring-up's own success bar is "the compose
// command succeeded and the daemon container is running".
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { parseConfig } from "../../config.js";
import { installName } from "../../install.js";
import type { CheckResult, OnboardingStep, StepContext, StepReport } from "../engine.js";
import {
  composeArgs,
  composeAvailable,
  composePs,
  composeFileCheck,
  containerStateCheck,
  hostCommands,
  ingressOptionOf,
  memoryImage,
  memoryOn,
  nodeStreamRunner,
  pullArgs,
  readEnvText,
  readTextOrNull,
  releaseImage,
  releaseVersion,
  rootOf,
  secretsDirFor,
  writeAtomic,
  type StreamRunner,
} from "./compose.js";
import { assertNoDryRunEdit, patchToml, type TomlEdit } from "./configfill.js";
import {
  declaredEmbedderOf,
  describeEmbedder,
  embedderEnvEntries,
  embedderInputsCheck,
  localEmbedderEnvEntries,
} from "./embeddings.js";
import { readEnvKey, readTomlKey, setEnvKey } from "./ingress.js";
import { UID_CHOICE_KEY } from "./preflight.js";
import { topologyOf } from "./topology.js";

export const BRINGUP_STEP_ID = "bringup";
/** Recorded timestamp of this step's successful bring-up. */
export const BROUGHT_UP_CHOICE_KEY = "stack_brought_up_at";

/**
 * The note, in the operator's words, emitted before the pull begins.
 * Exported so the test can assert both its content and its ordering.
 */
export const FIRST_PULL_NOTICE = [
  "About to pull the container images and start the stack.",
  "The FIRST pull is the slow one: it downloads the daemon image and the memory image, and the",
  "memory image carries its embedding model, so it is the larger of the two. How long that takes",
  "depends on your connection. That is expected, not a hang: every line Docker prints is shown",
  "below as it arrives. Later starts reuse the layers already here and take seconds.",
  "The images come from ghcr.io (they are private: `gh auth refresh -s read:packages`, then",
  "`gh auth token | docker login ghcr.io -u <user> --password-stdin`). The tunnel you chose, if any,",
  "is built from a small wrapper over the vendor's own image. Nothing is posted to GitHub by this step.",
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

/** `docker compose [--profile p] up -d`, built in one place. No `--build`: the
 * daemon and memory images are pulled (`pullArgs`); only a tunnel sidecar that
 * is not built yet is built, and compose does that on its own. */
export function bringUpArgs(root: string, profile: string): string[] {
  const profileArgs = profile === "" ? [] : ["--profile", profile];
  return composeArgs(root, [...profileArgs, "up", "-d"]);
}

/** The memory sidecar's compose service name: what `[openviking] host` must say. */
export const MEMORY_HOST = "memory";

/**
 * Point the daemon at the memory sidecar: `[openviking] endpoint = "remote"`
 * and `host = "memory"`. Returns the patched text, or null when the file
 * already says so (or memory is off). Comment-preserving, like every wizard
 * config write, and never `dry_run` in either direction.
 */
export function memoryEndpointPatch(configText: string): string | null {
  if (!memoryOn(configText)) return null;
  const edits: TomlEdit[] = [];
  if (readTomlKey(configText, "openviking", "endpoint") !== "remote")
    edits.push({ section: "openviking", key: "endpoint", value: '"remote"' });
  if (readTomlKey(configText, "openviking", "host") !== MEMORY_HOST)
    edits.push({ section: "openviking", key: "host", value: `"${MEMORY_HOST}"` });
  if (edits.length === 0) return null;
  assertNoDryRunEdit(edits);
  return patchToml(configText, edits);
}

/** The host's own default config home and secrets dir for this install, as
 * shell words (the install locator's answer for that account). */
function hostPaths(configText: string): { home: string; secrets: string } {
  const home = `\${XDG_CONFIG_HOME:-$HOME/.config}/qcr/${installName()}`;
  const configured = (readTomlKey(configText, "github", "secrets_dir") ?? "").trim();
  return { home, secrets: configured.startsWith("/") ? configured : `${home}/secrets` };
}

/** The project `.env` lines the host commands write, for a host this process
 * cannot see: paths are the host's own defaults, spelled with shell variables.
 * The heredoc that writes them is quoted, so the variables land literally in
 * the file and Docker Compose expands them when it reads it. */
function hostEnvLines(
  ctx: StepContext,
  version: string,
  uid: number,
  profile: string,
  configText: string,
): string[] {
  const { home, secrets } = hostPaths(configText);
  const lines: string[] = [
    `QCR_VERSION=${version}`,
    `QCR_UID=${uid}`,
    `COMPOSE_PROFILES=${profile}`,
    `QCR_CONFIG_HOME=${home}`,
    `QCR_CONFIG_NAME=${basename(ctx.adapters.paths.configPath)}`,
    `QCR_SECRETS_DIR=${secrets}`,
  ];
  for (const [key, value] of embedderEnvEntries(declaredEmbedderOf(configText)))
    lines.push(`${key}=${value}`);
  for (const [key, value] of localEmbedderEnvEntries(configText)) lines.push(`${key}=${value}`);
  return lines;
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
      "Starts QuickReview: it pulls the released images (the daemon and the memory engine, pinned to one version) and brings " +
      "up the daemon, its memory sidecar and whichever webhook tunnel you chose, running as your own user id so they can read " +
      "your secrets. Say plainly BEFORE running it that the first pull downloads two images, the memory one with its " +
      "embedding model inside, and takes as long as your connection needs — the output is streamed line by line so the wait " +
      "is visible rather than silent. Later starts are seconds. Where this wizard runs inside the image there is no Docker to " +
      "drive, so the step prints the exact commands to run on your host instead, and you run them there.",
    order: 70,
    // The compose stack is the laptop route. The VM-over-ssh route brings the
    // same system up through the existing Ansible flow and registers
    // its own steps; this one stays out of its way.
    enabled: (choices) => topologyOf(choices) === "local",

    async run(ctx): Promise<StepReport> {
      const root = rootOf(ctx.adapters);
      const checks: CheckResult[] = [];
      const hasDocker = await composeAvailable(ctx.adapters.runner);
      const version = releaseVersion(root);
      if (version === "") {
        checks.push({
          name: "version",
          ok: false,
          detail:
            "no release version to run: QCR_VERSION is not in the project .env and this wizard has no package version — " +
            "Fix: set QCR_VERSION in .env to the release you want (the image tag; there is no floating `latest`), then run this step again",
        });
        return { ok: false, checks };
      }
      if (hasDocker) {
        checks.push(composeFileCheck(root, version));
        if (!checks[0]!.ok) return { ok: false, checks };
      }

      const uid = uidOf(ctx);
      if (uid === null) {
        checks.push({
          name: "uid",
          ok: false,
          detail:
            "no user id was captured, so the containers cannot be matched to the files you own — Fix: run the preflight step " +
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

      // The memory sidecar replaces the in-container OpenViking: the daemon
      // must be told to probe it instead of supervising its own.
      let configText = readFileSync(ctx.adapters.paths.configPath, "utf8");
      const patched = memoryEndpointPatch(configText);
      if (patched !== null) {
        try {
          parseConfig(patched);
        } catch (err) {
          checks.push({
            name: "memory-endpoint",
            ok: false,
            detail: `[openviking] endpoint = "remote" / host = "${MEMORY_HOST}" would not load in ${ctx.adapters.paths.configPath}: ${String(err)} — nothing was written`,
          });
          return { ok: false, checks };
        }
        writeAtomic(ctx.adapters.paths.configPath, patched);
        configText = patched;
        checks.push({
          name: "memory-endpoint",
          ok: true,
          detail: `[openviking] endpoint = "remote" and host = "${MEMORY_HOST}" written to ${ctx.adapters.paths.configPath} — the daemon probes the memory sidecar this stack runs`,
        });
      }

      const option = ingressOptionOf(ctx.choices);
      const envText = readEnvText(root);
      const profile = option ? option.profile : (readEnvKey(envText, "COMPOSE_PROFILES") ?? "");

      if (!hasDocker) {
        // D16: no Docker here, so nothing is started from here. The commands
        // for the host, exactly, and a red step until the stack is seen up.
        const paths = hostPaths(configText);
        const commands = hostCommands({
          version,
          projectDir: "~/qcr-bot",
          env: hostEnvLines(ctx, version, uid, profile, configText),
          dirs: [`"${paths.home}"`, `"${paths.secrets}"`],
          notes: [
            `# Put ${basename(ctx.adapters.paths.configPath)} in ${paths.home} and your secrets in ${paths.secrets}:`,
            "# the config this wizard filled in is " +
              `${ctx.adapters.paths.configPath} where the wizard runs, with [openviking] endpoint = "remote" and host = "${MEMORY_HOST}".`,
          ],
          profile,
        });
        for (const line of commands) log(ctx, line);
        checks.push({
          name: "host-commands",
          ok: false,
          detail:
            "there is no `docker compose` where this wizard runs (inside the qcr image there never is: no docker CLI, no socket), " +
            `so nothing was started. Run these on the host, in order — the images are ${releaseImage(version)} and ${memoryImage(version)}; ` +
            `the paths in the .env are the install's default config home, so edit those two lines if yours is elsewhere:\n${commands.join("\n")}\n` +
            "Then run this step again to confirm the stack is up.",
        });
        return { ok: false, checks };
      }

      // The project .env: the pin and the uid for the containers, and the
      // ingress profile the ingress step chose (re-asserted here so a
      // hand-edited .env cannot silently bring up a different shape than the
      // checklist recorded).
      let next = setEnvKey(envText, "QCR_VERSION", version);
      next = setEnvKey(next, "QCR_UID", String(uid));
      next = setEnvKey(next, "COMPOSE_PROFILES", profile);
      // The embedder config.toml declares, carried into the .env the
      // compose file passes to the memory container — the one place the boot
      // reads it from on this route. config.toml is the truth; this is its
      // mirror, re-asserted on every bring-up so the two cannot drift apart.
      const embedder = declaredEmbedderOf(configText);
      for (const [key, value] of embedderEnvEntries(embedder)) next = setEnvKey(next, key, value);
      // And the local embedder's port and threads — the daemon
      // reads them from config.toml, the boot renders ov.conf from these.
      for (const [key, value] of localEmbedderEnvEntries(configText))
        next = setEnvKey(next, key, value);
      // The directory the compose file mounts read-only as the
      // containers' config home — the one holding the config the install
      // locator found — the only config they read. Created here so
      // Docker never creates it, owned by root.
      mkdirSync(mount.dir, { recursive: true, mode: 0o700 });
      next = setEnvKey(next, "QCR_CONFIG_HOME", mount.dir);
      next = setEnvKey(next, "QCR_CONFIG_NAME", mount.name);
      // The secrets dir the compose file mounts read-only at
      // /opt/quickreview/secrets — the install locator's answer, the same one
      // the daemon's loader reaches. Created here for the same reason as the
      // config home: never by Docker, as root.
      mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
      next = setEnvKey(next, "QCR_SECRETS_DIR", secretsDir);
      if (next !== envText) writeAtomic(`${root}/.env`, next);
      checks.push({
        name: "pull-inputs",
        ok: true,
        detail:
          `.env: QCR_VERSION=${version} (${releaseImage(version)} and ${memoryImage(version)}), ` +
          `QCR_UID=${uid} (the containers' user, so they can read the files you own), ` +
          `COMPOSE_PROFILES=${profile === "" ? "(empty — daemon only, the polling shape)" : profile}` +
          `${option ? ` for the ${option.id} ingress you chose` : " (no ingress shape recorded — bringing up the daemon alone)"}` +
          `, and the memory embedder ${describeEmbedder(embedder)} from config.toml${embedder.provider === "local" ? " (local: no memory text leaves this machine)" : ""}`,
      });

      // The note goes out before the long wait, never after it.
      for (const line of FIRST_PULL_NOTICE.split("\n")) log(ctx, line);
      checks.push({ name: "first-pull", ok: true, detail: FIRST_PULL_NOTICE });

      const started = ctx.adapters.clock().getTime();
      let lines = 0;
      const onLine = (line: string): void => {
        lines += 1;
        log(ctx, line);
        if (lines % progressEvery === 0) {
          const mins = Math.round((ctx.adapters.clock().getTime() - started) / 60_000);
          log(
            ctx,
            `… still working — ${lines} lines of Docker output, ${mins} minute${mins === 1 ? "" : "s"} elapsed. This is normal.`,
          );
        }
      };
      const pull = await stream.run("docker", pullArgs(root, profile), onLine);
      if (pull.code !== 0) {
        checks.push({
          name: "compose-pull",
          ok: false,
          detail:
            `\`docker compose pull\` exited ${pull.code}. Last output:\n${tail(pull.stderr || pull.stdout)}\n` +
            "Fix: the message above is Docker's own. The usual causes: not logged in to ghcr.io (the images are private — " +
            "`gh auth refresh -s read:packages`, then `gh auth token | docker login ghcr.io -u <user> --password-stdin`), " +
            `no release tagged ${version} (QCR_VERSION in .env), no disk space (\`docker system df\`, then \`docker system prune\`), ` +
            "or a network failure mid-download — all safe to retry by running this step again, which resumes from the layers already here.",
        });
        return { ok: false, checks };
      }
      const result = await stream.run("docker", bringUpArgs(root, profile), onLine);
      if (result.code !== 0) {
        checks.push({
          name: "compose-up",
          ok: false,
          detail:
            `\`docker compose up -d\` exited ${result.code}. Last output:\n${tail(result.stderr || result.stdout)}\n` +
            "Fix: the message above is Docker's own. Safe to retry by running this step again.",
        });
        return { ok: false, checks };
      }
      const elapsedMin = Math.round((ctx.adapters.clock().getTime() - started) / 60_000);
      checks.push({
        name: "compose-up",
        ok: true,
        detail: `the stack was pulled and started in ${elapsedMin} minute${elapsedMin === 1 ? "" : "s"} (${lines} lines of Docker output)`,
      });

      checks.push(
        ...containerStateCheck(await composePs(ctx.adapters.runner, root), option, {
          memory: memoryOn(configText),
        }),
      );
      const ok = checks.every((c) => c.ok);
      if (ok) ctx.recordChoice(BROUGHT_UP_CHOICE_KEY, ctx.adapters.clock().toISOString());
      return { ok, checks, data: { profile, up_at: ctx.adapters.clock().toISOString() } };
    },

    async verify(ctx): Promise<StepReport> {
      // Re-running as verification never pulls or starts anything: it asks
      // what is running.
      const root = rootOf(ctx.adapters);
      const text = readTextOrNull(ctx.adapters.paths.configPath);
      const checks = containerStateCheck(
        await composePs(ctx.adapters.runner, root),
        ingressOptionOf(ctx.choices),
        { memory: text === null || memoryOn(text) },
      );
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

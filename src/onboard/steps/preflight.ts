// Preflight — the first real onboarding step: the machine facts the
// rest of the wizard stands on. Node ≥22 (the wizard's own floor), Docker and
// Docker Compose present (the laptop route's runtime), the released image
// reachable (the stack is pulled, never built, and the images are private), and
// the current uid captured — later steps write it to the project `.env` as
// QCR_UID so the containers run as the user who owns the secrets.
//
// Inside the release image there is no Docker and never will be (D16): the
// wizard then notes it and goes on, and bring-up prints the host's commands.
//
// Deterministic by construction: every fact comes through the adapters
// (host facts injected, binaries probed via the ProcessRunner seam), so tests
// drive both paths with fakes and no test touches a real Docker.
import { CHOICE_KEYS } from "../choices.js";
import type { CheckResult, OnboardingStep, StepContext, StepReport } from "../engine.js";
import { releaseImage, releaseVersion, rootOf } from "./compose.js";

export const PREFLIGHT_STEP_ID = "preflight";
/** The daemon's Node floor — package.json `engines.node` says the same
 * (tests/onboard-engine.test.ts holds the two equal). */
export const MIN_NODE_MAJOR = 22;
/** The choice key later steps read the captured uid from (QCR_UID input). */
export const UID_CHOICE_KEY = CHOICE_KEYS.uid;

/** "v22.1.0" | "22.1.0" → 22; null when unparseable. */
export function parseNodeMajor(version: string): number | null {
  const m = /^v?(\d+)\./.exec(version.trim());
  return m ? Number(m[1]) : null;
}

async function toolingChecks(ctx: StepContext): Promise<CheckResult[]> {
  const { host, runner } = ctx.adapters;
  const checks: CheckResult[] = [];

  const major = parseNodeMajor(host.nodeVersion);
  checks.push(
    major !== null && major >= MIN_NODE_MAJOR
      ? {
          name: "node",
          ok: true,
          detail: `Node ${host.nodeVersion} (>= ${MIN_NODE_MAJOR} required)`,
        }
      : {
          name: "node",
          ok: false,
          detail: `Node >= ${MIN_NODE_MAJOR} is required; this is ${host.nodeVersion}`,
        },
  );

  // Inside the release image there is no docker CLI: not a failure of this
  // machine, and the step after this one says what to run on the host instead.
  const noDockerHere = (what: string): CheckResult => ({
    name: what,
    ok: true,
    detail:
      `${what} is not runnable here, and this wizard is running inside a container, which never has it — ` +
      "the bring-up step prints the exact commands to run on your host (where Docker must be installed)",
  });

  const docker = await runner.run("docker", ["--version"]);
  if (docker.code !== 0 && host.inContainer) {
    checks.push(noDockerHere("docker"), noDockerHere("compose"));
    return checks;
  }
  checks.push(
    docker.code === 0
      ? {
          name: "docker",
          ok: true,
          detail: docker.stdout.trim().split("\n")[0] ?? "docker present",
        }
      : {
          name: "docker",
          ok: false,
          detail: `docker not runnable (exit ${docker.code}): ${(docker.stderr || docker.stdout).trim() || "is Docker installed and on PATH?"}`,
        },
  );

  const compose = await runner.run("docker", ["compose", "version"]);
  checks.push(
    compose.code === 0
      ? {
          name: "compose",
          ok: true,
          detail: compose.stdout.trim().split("\n")[0] ?? "docker compose present",
        }
      : {
          name: "compose",
          ok: false,
          detail: `docker compose not runnable (exit ${compose.code}): ${(compose.stderr || compose.stdout).trim() || "the Compose v2 plugin is required (docker compose, not docker-compose)"}`,
        },
  );

  // The stack is pulled, not built, and the images are private: ask the
  // registry for the manifest now, so a missing login is a preflight line with
  // its fix, not a failed pull far into the wizard. Not a failure of this
  // step, because preflight runs before the topology is chosen and the server
  // route builds on the server: bring-up's pull is the hard gate, and carries
  // the same fix.
  if (docker.code === 0 && compose.code === 0) {
    const image = releaseImage(releaseVersion(rootOf(ctx.adapters)));
    const manifest = await runner.run("docker", ["manifest", "inspect", image]);
    checks.push(
      manifest.code === 0
        ? { name: "images", ok: true, detail: `${image} is reachable on ghcr.io` }
        : {
            name: "images",
            ok: true,
            detail:
              `cannot reach ${image} (exit ${manifest.code}): ${(manifest.stderr || manifest.stdout).trim().slice(0, 300) || "no output"}. ` +
              "The images are private. Fix: `gh auth refresh -s read:packages`, then " +
              "`gh auth token | docker login ghcr.io -u <your github login> --password-stdin`; " +
              "if that is done, that release tag may not exist (QCR_VERSION in the project .env). " +
              "Only the laptop route pulls it (the server route builds on the server), so this does not stop the wizard here",
          },
    );
  }

  return checks;
}

export function preflightStep(): OnboardingStep {
  return {
    id: PREFLIGHT_STEP_ID,
    title: "Preflight: Node, Docker, Compose, images, uid",
    explain:
      `Checks that this machine can run QuickReview at all: Node ${MIN_NODE_MAJOR} or newer, Docker, the Compose plugin, and whether ` +
      "the released image can be pulled (it is private: a missing ghcr.io login is noted here, with the fix, and enforced by bring-up). " +
      "It also captures your user id so the containers run as you and can read the secrets you own.",
    order: 10,
    async run(ctx): Promise<StepReport> {
      const checks = await toolingChecks(ctx);
      const uid = ctx.adapters.host.uid;
      if (uid === null) {
        checks.push({
          name: "uid",
          ok: false,
          detail:
            "could not determine the current user id (no uid on this platform — WSL2 is the supported route on Windows)",
        });
      } else {
        checks.push({
          name: "uid",
          ok: true,
          detail: `uid ${uid} captured — later steps write it to .env as QCR_UID`,
        });
      }
      const ok = checks.every((c) => c.ok);
      if (ok && uid !== null) {
        ctx.recordChoice(CHOICE_KEYS.uid, uid);
        return { ok, checks, data: { uid } };
      }
      return { ok, checks };
    },
    async verify(ctx): Promise<StepReport> {
      const checks = await toolingChecks(ctx);
      const recorded = ctx.data.uid;
      const current = ctx.adapters.host.uid;
      if (typeof recorded !== "number") {
        checks.push({ name: "uid", ok: false, detail: "no uid recorded — run the preflight step" });
      } else if (current === null) {
        checks.push({
          name: "uid",
          ok: false,
          detail: "could not determine the current user id — re-run preflight on a supported host",
        });
      } else if (current !== recorded) {
        checks.push({
          name: "uid",
          ok: false,
          detail: `recorded uid ${recorded} no longer matches the current user (${current}) — re-run preflight before bringing the stack up`,
        });
      } else {
        checks.push({ name: "uid", ok: true, detail: `uid ${recorded} recorded` });
      }
      return { ok: checks.every((c) => c.ok), checks };
    },
  };
}

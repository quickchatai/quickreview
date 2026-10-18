// Preflight — the first real onboarding step: the machine facts the
// rest of the wizard stands on. Node ≥22 (the daemon's floor), Docker and
// Docker Compose present (the laptop route's runtime; the VM route still
// builds images locally for the companion), and the current uid captured —
// later steps pass it to the image build as QCR_UID so the container user
// matches the bind-mount owner.
//
// Deterministic by construction: every fact comes through the adapters
// (host facts injected, binaries probed via the ProcessRunner seam), so tests
// drive both paths with fakes and no test touches a real Docker.
import { CHOICE_KEYS } from "../choices.js";
import type { CheckResult, OnboardingStep, StepContext, StepReport } from "../engine.js";

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

  const docker = await runner.run("docker", ["--version"]);
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

  return checks;
}

export function preflightStep(): OnboardingStep {
  return {
    id: PREFLIGHT_STEP_ID,
    title: "Preflight: Node, Docker, Compose, uid",
    explain:
      `Checks that this machine can run QuickReview at all: Node ${MIN_NODE_MAJOR} or newer, Docker, and the Compose plugin. ` +
      "It also captures your user id so the containers built later run as you and can share files with your checkout.",
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
          detail: `uid ${uid} captured — later steps pass it to the image build as QCR_UID`,
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
          detail: `recorded uid ${recorded} no longer matches the current user (${current}) — re-run preflight before building images`,
        });
      } else {
        checks.push({ name: "uid", ok: true, detail: `uid ${recorded} recorded` });
      }
      return { ok: checks.every((c) => c.ok), checks };
    },
  };
}

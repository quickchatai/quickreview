// The setup walk: switch-on's steps, run by a detached process after `host
// setup` has answered.
//
// It is the home's switch-on (src/home/switchon.ts `runSwitchOn`) with the
// same silent defaults and nobody watching: this machine, the account the
// token file is, polling, escalation off, local embeddings, memory as the
// steps leave it, the login of the pi on this machine shared with the stack,
// the bring-up and the verification. The machine checks run first, as they do
// before the home asks anything. It comes up in dry-run: the walk never runs
// the practice review or the go-live, and is handed no confirm for either.
//
// How far it has got is written to the host record after every step, which
// is what the board export prints as `setup`: `running` with the step, then
// `done`, or `failed` with the step it stopped at and a closed word for why.
// The words a step said go to the walk's own log (state/onboarding/
// host-setup.log), never to the record.
//
// The walk holds the checklist lock for as long as it runs. It did not take
// it: the verb did, and handed it over with a token (`adoptLock`). A walk
// started without that hand-over holds nothing and runs nothing.
import { readConfigToml } from "@quickchatai/pi-quickreview/src/shippedconfig.js";
import { configFacts } from "../boardexport.js";
import { adoptChecklistLock, type HeldLock } from "../onboard/checklistlock.js";
import { BRINGUP_STEP_ID } from "../onboard/steps/bringup.js";
import { MEMORY_SERVICE } from "../onboard/steps/compose.js";
import { GITHUB_ACCOUNT_STEP_ID } from "../onboard/steps/githubaccount.js";
import { LOGIN_SHARE_STEP_ID } from "../onboard/steps/loginshare.js";
import { MEMORY_STEP_ID } from "../onboard/steps/memory.js";
import { MEMORY_KEYS_STEP_ID } from "../onboard/steps/memorykeys.js";
import { VERIFY_STACK_STEP_ID } from "../onboard/steps/verifyup.js";
import type { SwitchResult } from "../home/ports.js";
import { DAEMON_START_STEP_ID, MACHINE_CHECKS_STEP_ID, runSwitchOn } from "../home/switchon.js";
import { SETUP_STEPS, type SetupProblem, type SetupStepId } from "./outcomes.js";
import type { HostPorts } from "./ports.js";
import { readHostRecord, updateHostRecord } from "./record.js";
import { sessionMarker } from "./session.js";

/** How often, and how long apart, a walk looks for the lock handed to it:
 * the verb rewrites the record right after it starts the walk. */
export const ADOPT_TRIES = 40;
export const ADOPT_WAIT_MS = 250;

/** The checklist lock the verb handed this walk, or null when none arrives. */
export async function adoptLock(ports: HostPorts, token: string): Promise<HeldLock | null> {
  for (let attempt = 0; attempt < ADOPT_TRIES; attempt += 1) {
    const lock = adoptChecklistLock(ports.stateDir, token, {
      pid: ports.pid,
      bootId: () => ports.bootId(),
      startTime: (pid) => ports.startTime(pid),
    });
    if (lock !== null) return lock;
    await ports.sleep(ADOPT_WAIT_MS);
  }
  return null;
}

/** The closed word for a step that failed, from the step and the names of
 * its failed checks. */
export function setupProblem(step: string, checks: readonly string[]): SetupProblem {
  switch (step) {
    case MACHINE_CHECKS_STEP_ID:
      if (checks.includes("docker") || checks.includes("compose")) return "docker_unavailable";
      if (checks.includes("disk")) return "disk_low";
      if (checks.includes("ports")) return "port_in_use";
      return "machine_check_failed";
    case GITHUB_ACCOUNT_STEP_ID:
      return "github_failed";
    case LOGIN_SHARE_STEP_ID:
      return checks.includes("login") ? "model_login_missing" : "start_failed";
    case MEMORY_STEP_ID:
    case MEMORY_KEYS_STEP_ID:
      return "memory_failed";
    case DAEMON_START_STEP_ID:
    case BRINGUP_STEP_ID:
      return "start_failed";
    case VERIFY_STACK_STEP_ID:
      return "verify_failed";
    default:
      return "step_failed";
  }
}

const stepIdOf = (id: string | undefined): SetupStepId | undefined =>
  SETUP_STEPS.find((s) => s === id);

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const firstLine = (s: string): string => s.trim().split("\n")[0]?.trim() || "no output";

/** The config's facts the walk needs, each null when the file cannot say. */
function configNow(ports: HostPorts): { repo: string | null; dryRun: boolean | null } {
  try {
    const text = ports.read(ports.configPath);
    const dry = readConfigToml(text, ports.template())["dry_run"];
    return {
      repo: configFacts(text).repo ?? null,
      dryRun: typeof dry === "boolean" ? dry : null,
    };
  } catch {
    return { repo: null, dryRun: null };
  }
}

/**
 * Run the setup walk under the lock `token` names. The process's exit code:
 * 0 when the reviewer came up, 1 otherwise. The record says which.
 */
export async function walkSetup(ports: HostPorts, token: string): Promise<number> {
  if (sessionMarker(ports.env) !== null || ports.inImage) {
    ports.log("host setup: not run from an agent session or inside the stack's container");
    return 1;
  }
  const lock = await adoptLock(ports, token);
  if (lock === null) {
    ports.log("host setup: no setup lock was handed to this walk; nothing was run");
    return 1;
  }
  const startedAt = readHostRecord(ports.stateDir).setup?.started_at ?? ports.now().toISOString();
  let current: SetupStepId | undefined = MACHINE_CHECKS_STEP_ID;
  const write = (
    state: "running" | "done" | "failed",
    step: SetupStepId | undefined,
    problem?: SetupProblem,
  ): void => {
    updateHostRecord(ports.stateDir, (r) => ({
      ...r,
      setup: {
        state,
        ...(step !== undefined ? { step } : {}),
        ...(problem !== undefined ? { problem } : {}),
        started_at: startedAt,
        updated_at: ports.now().toISOString(),
      },
    }));
  };
  const at = (id: string): void => {
    current = stepIdOf(id) ?? current;
    write("running", current);
  };
  const compose = async (args: string[], what: string): Promise<SwitchResult> => {
    const r = await ports.compose(args);
    return r.code === 0
      ? { ok: true, detail: what }
      : {
          ok: false,
          detail: `docker compose ${args.join(" ")} exited ${r.code}: ${firstLine(r.stderr || r.stdout)}`,
        };
  };
  try {
    ports.seedStack();
    const checklist = ports.checklist(ports.registry(), (l) => ports.log(l));
    at(MACHINE_CHECKS_STEP_ID);
    const checks = await checklist.runStep(MACHINE_CHECKS_STEP_ID);
    if (!checks.ok) {
      ports.log(`host setup: the machine checks failed: ${checks.failures.join("; ")}`);
      write(
        "failed",
        current,
        setupProblem(
          MACHINE_CHECKS_STEP_ID,
          checks.checks.filter((c) => !c.ok).map((c) => c.name),
        ),
      );
      return 1;
    }
    const out = await runSwitchOn({
      checklist,
      // The confirm is the host's attested operator's: the person the host
      // authenticated, starting the reviewer from it. Memory is left as the
      // steps leave it; nothing here is handed a go-live confirm.
      answers: { memory: null, confirmed: true },
      repo: configNow(ports).repo,
      dryRun: () => configNow(ports).dryRun,
      stopMemory: () => compose(["stop", MEMORY_SERVICE], "memory stopped"),
      startMemory: () => compose(["up", "-d", MEMORY_SERVICE], "the memory engine runs"),
      progress: (l) => ports.log(l),
      onStep: at,
      sleep: (ms) => ports.sleep(ms),
    });
    ports.log(`host setup: ${out.detail}`);
    if (!out.ok) {
      const failed = out.failed;
      write(
        "failed",
        failed !== undefined ? (stepIdOf(failed.step) ?? current) : undefined,
        failed !== undefined
          ? setupProblem(failed.step, failed.checks)
          : out.live === null
            ? "config_unreadable"
            : "step_failed",
      );
      return 1;
    }
    write("done", undefined);
    return 0;
  } catch (err) {
    ports.log(`host setup: the walk stopped: ${message(err)}`);
    try {
      write("failed", current, "internal_error");
    } catch {
      // the record cannot be written either: the export says `interrupted`
    }
    return 1;
  } finally {
    lock.release();
  }
}

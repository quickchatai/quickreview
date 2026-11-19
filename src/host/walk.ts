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
// Its last step is its own (`set_trigger`), walked when setup was given
// `--trigger`: once the reviewer is up, the word is handed to it through the
// sealed operator channel `host set-trigger` uses (src/host/trigger.ts), so
// the daemon's stored choice, the one it follows, is setup's word. Nobody
// waits on the walk, so it reads the daemon's receipt for up to
// TRIGGER_RECEIPT_MS, not the verb's moment. A reviewer that is not there to
// take the word fails the step with what is wrong (`reviewer_not_running`,
// `reviewer_unreachable`, `config_unreadable`); `trigger_failed` is only a
// reviewer found running that refused the word or whose channel could not
// take it, which then follows the trigger it followed before. A word still
// unanswered when the wait is over is on the channel: setup is `done` with
// `trigger_pending`, and the export's `trigger`, the daemon's own word, says
// when it has taken it.
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
import { SETUP_STEPS, type HostReason, type SetupProblem, type SetupStepId } from "./outcomes.js";
import type { HostPorts } from "./ports.js";
import { RECEIPT_WAIT_MS, isAnswer, standing } from "./proof.js";
import { readHostRecord, updateHostRecord } from "./record.js";
import { sessionMarker } from "./session.js";
import { handTriggerTo } from "./trigger.js";

/** The walk's own last step: setup's `--trigger`, handed to the reviewer. */
export const SET_TRIGGER_STEP_ID = "set_trigger" satisfies SetupStepId;

/** How long the walk waits for the reviewer to take setup's `--trigger`:
 * past the operator watcher's fallback sweep (15 s, src/commands.ts), which
 * is what finds the file on a box whose operator directory this very write
 * created, with one queued command served ahead of it. */
export const TRIGGER_RECEIPT_MS = 60_000;
export const TRIGGER_RECEIPT_TRIES = Math.ceil(TRIGGER_RECEIPT_MS / RECEIPT_WAIT_MS);

/** The closed word for a reviewer that was not there to hand setup's
 * `--trigger` to, from `standing`'s refusal. */
export function standingProblem(reason: HostReason | undefined): SetupProblem {
  switch (reason) {
    case "reviewer_not_running":
      return "reviewer_not_running";
    case "reviewer_unreachable":
      return "reviewer_unreachable";
    // the config the walk wrote cannot be read, or names no repository now
    case "config_unreadable":
    case "not_set_up":
      return "config_unreadable";
    default:
      return "step_failed";
  }
}

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
  const begun = readHostRecord(ports.stateDir).setup;
  const startedAt = begun?.started_at ?? ports.now().toISOString();
  /** The `--trigger` the verb was given: handed to the reviewer last. */
  const trigger = begun?.trigger;
  let current: SetupStepId | undefined = MACHINE_CHECKS_STEP_ID;
  const write = (
    state: "running" | "done" | "failed",
    step: SetupStepId | undefined,
    problem?: SetupProblem,
    triggerPending = false,
  ): void => {
    updateHostRecord(ports.stateDir, (r) => ({
      ...r,
      setup: {
        state,
        ...(step !== undefined ? { step } : {}),
        ...(problem !== undefined ? { problem } : {}),
        ...(triggerPending ? { trigger_pending: true as const } : {}),
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
    // setup's `--trigger`, handed to the reviewer now it is up, the way
    // `set-trigger` hands it: the daemon's stored choice is the one it
    // follows, so a setup run again with another word takes effect at once
    let pending = false;
    if (trigger !== undefined) {
      at(SET_TRIGGER_STEP_ID);
      const couldNot = (why: string | undefined, problem: SetupProblem): number => {
        ports.log(
          `host setup: the trigger "${trigger}" could not be handed to the reviewer: ${why ?? problem}`,
        );
        write("failed", SET_TRIGGER_STEP_ID, problem);
        return 1;
      };
      const reviewer = await standing(ports);
      // no reviewer to take the word: say what is wrong with it
      if (isAnswer(reviewer)) return couldNot(reviewer.message, standingProblem(reviewer.reason));
      const handed = await handTriggerTo(ports, reviewer, trigger, TRIGGER_RECEIPT_TRIES);
      // a reviewer found running refused the word, or its channel could not
      // take it
      if (handed.state !== "done" && handed.state !== "sent")
        return couldNot(handed.message, "trigger_failed");
      pending = handed.state === "sent";
      ports.log(
        pending
          ? `host setup: the trigger "${trigger}" is on the reviewer's channel and was not taken within ${TRIGGER_RECEIPT_MS / 1000} s; the reviewer takes it when it reads its channel`
          : `host setup: the reviewer follows the trigger "${trigger}"`,
      );
    }
    write("done", undefined, undefined, pending);
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

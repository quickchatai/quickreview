// Switch-on: the steps that turn auto-review on from the home, on the
// plugin's step registry (the app's setup is the plugin's checklist with more
// steps, ADR 0001). They are the wizard's own step modules (src/onboard/
// steps/), registered here in the wizard's order, over the wizard's checklist
// file, so an answer given in either place is the same answer:
//
//   machine_checks   Docker, disk, ports (the wizard's preflight, plus the
//                    disk and the webhook port) — run first, before the home
//                    asks anything
//   topology         "this machine" (the home asks; another server goes to
//                    the advanced steps, never through here)
//   github_account   the person's own account: polling, no App
//   escalation       off            ┐
//   embeddings       local          │ silent defaults, each asked only by
//   ingress          polling        ┘ the wizard; a recorded answer stands
//   memory           the memory offer's answer, when it was offered
//   login_share      the daemon reviews on the home's own login, which its
//                    refresher keeps while it runs: one login per box
//                    (src/onboard/steps/loginshare.ts)
//   daemon_start     start a stack that was brought up before (a second
//                    switch-on is this and little else: its data is kept)
//   bringup          the first time: pull and start the stack (restart:
//                    unless-stopped, so it survives reboots)
//   memory_user_keys, verify_stack
//   proof_round      ┐ after switch-on, never walked by it: auto-review
//   go_live          ┘ comes up in dry-run. Going live is its own act
//                    (runGoLive): the wizard's proof round on one real pull
//                    request, read by the person, then one more confirm
//                    handed to the go-live step, the only thing here that
//                    may move dry_run, and only through goLiveStep
//                    (invariant 6)
//
// A step the checklist already records as done is not run again (its answer
// stands), except the two that act on the running machine: the machine checks
// and the daemon start.
//
// Memory is set up in two phases (src/onboard/steps/memorykeys.ts): its root
// key must be on disk before the engine boots, and its user keys can only be
// minted by the running engine. On a stack not running it yet, the memory
// step lands the root key and stops on the engine not answering; switch-on
// goes on, the engine is started, and before memory_user_keys the memory
// step runs again until the engine answers (memoryPhaseB). Any other memory
// failure ends the walk.
import { createServer } from "node:net";
import { execFile } from "node:child_process";
import {
  StepRegistry,
  type ChecklistAdapters,
  type SetupChecklist,
} from "@quickchatai/pi-quickreview/src/setupchecklist.js";
import type {
  CheckResult,
  OnboardAdapters,
  OnboardingStep,
  ProcessRunner,
  StepReport,
} from "../onboard/engine.js";
import { BRINGUP_STEP_ID, BROUGHT_UP_CHOICE_KEY, bringUpStep } from "../onboard/steps/bringup.js";
import {
  DAEMON_SERVICE,
  DEFAULT_WEBHOOK_PORT,
  composeArgs,
  composePs,
  readEnvText,
  rootOf,
  serviceRow,
} from "../onboard/steps/compose.js";
import { EMBEDDINGS_STEP_ID, embeddingsStep } from "../onboard/steps/embeddings.js";
import { ESCALATION_STEP_ID, escalationStep } from "../onboard/steps/escalation.js";
import { GITHUB_ACCOUNT_STEP_ID, githubAccountStep } from "../onboard/steps/githubaccount.js";
import { GO_LIVE_CONFIRMATION, GO_LIVE_STEP_ID, goLiveStep } from "../onboard/steps/golive.js";
import { INGRESS_STEP_ID, isUp, readEnvKey, ingressStep } from "../onboard/steps/ingress.js";
import { MEMORY_STEP_ID, memoryStep, waitsOnServer } from "../onboard/steps/memory.js";
import { MEMORY_KEYS_STEP_ID, memoryUserKeysStep } from "../onboard/steps/memorykeys.js";
import { preflightStep } from "../onboard/steps/preflight.js";
import {
  PROOF_CHOICE_KEY,
  PROOF_STEP_ID,
  parseProofRecord,
  proofRoundStep,
  type ProofRecord,
} from "../onboard/steps/proof.js";
import { TOPOLOGY_STEP_ID, topologyOf, topologyStep } from "../onboard/steps/topology.js";
import { VERIFY_STACK_STEP_ID, verifyStackStep } from "../onboard/steps/verifyup.js";
import {
  LOGIN_SHARE_STEP_ID,
  loginShareStep,
  type LoginShareOptions,
} from "../onboard/steps/loginshare.js";
import type { SwitchOnAnswers, SwitchOnOutcome, SwitchResult } from "./ports.js";

export const MACHINE_CHECKS_STEP_ID = "machine_checks";
export const DAEMON_START_STEP_ID = "daemon_start";

/** Free disk the stack needs where Docker keeps its images: the two released
 * images (the memory one carries its embedding model) and room to run. */
export const MIN_FREE_GB = 10;

/** Switch-on's steps, in the order they run (the registry sorts by `order`). */
export const SWITCH_ON_ORDER = [
  MACHINE_CHECKS_STEP_ID,
  TOPOLOGY_STEP_ID,
  GITHUB_ACCOUNT_STEP_ID,
  ESCALATION_STEP_ID,
  EMBEDDINGS_STEP_ID,
  INGRESS_STEP_ID,
  MEMORY_STEP_ID,
  LOGIN_SHARE_STEP_ID,
  DAEMON_START_STEP_ID,
  BRINGUP_STEP_ID,
  MEMORY_KEYS_STEP_ID,
  VERIFY_STACK_STEP_ID,
  PROOF_STEP_ID,
  GO_LIVE_STEP_ID,
] as const;

/** The steps that act on the running machine: run on every switch-on. */
const EVERY_TIME: ReadonlySet<string> = new Set([MACHINE_CHECKS_STEP_ID, DAEMON_START_STEP_ID]);

/** The steps after switch-on, each the person's own act: never walked. */
const AFTER_SWITCH_ON: ReadonlySet<string> = new Set([PROOF_STEP_ID, GO_LIVE_STEP_ID]);

/** How long phase B waits for a memory engine that has just started. */
export const MEMORY_WAIT_ATTEMPTS = 20;
export const MEMORY_WAIT_MS = 15_000;

// ---- the machine checks -------------------------------------------------

export interface MachineCheckOptions {
  /** Is `port` free on loopback? null when it could not be told. */
  portFree?: (port: number) => Promise<boolean | null>;
}

/** Can something listen on 127.0.0.1:`port` now? */
export function loopbackPortFree(port: number): Promise<boolean | null> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", (err: NodeJS.ErrnoException) =>
      resolve(err.code === "EADDRINUSE" || err.code === "EACCES" ? false : null),
    );
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

/** The webhook port the stack publishes: the project `.env`'s
 * QCR_WEBHOOK_PORT, else compose's default. */
export function webhookPort(root: string): number {
  const raw = (readEnvKey(readEnvText(root), "QCR_WEBHOOK_PORT") ?? "").trim();
  return /^[0-9]{1,5}$/.test(raw) ? Number(raw) : DEFAULT_WEBHOOK_PORT;
}

/** `df -Pk <dir>`'s available space, in GB; null when it does not parse. */
export function freeGbFromDf(stdout: string): number | null {
  const row = stdout.trim().split("\n")[1];
  const kb = Number(row?.trim().split(/\s+/)[3]);
  return Number.isFinite(kb) ? kb / (1024 * 1024) : null;
}

async function diskCheck(runner: ProcessRunner, root: string): Promise<CheckResult> {
  const info = await runner.run("docker", ["info", "--format", "{{.DockerRootDir}}"]);
  const dir = info.code === 0 && info.stdout.trim() !== "" ? info.stdout.trim() : root;
  const df = await runner.run("df", ["-Pk", dir]);
  const gb = df.code === 0 ? freeGbFromDf(df.stdout) : null;
  if (gb === null)
    // Docker Desktop keeps its images inside its VM, where df cannot look:
    // said as unknown, never as enough.
    return {
      name: "disk",
      ok: true,
      detail: `free disk unknown: ${dir} could not be measured (${(df.stderr || df.stdout).trim().split("\n")[0] || `exit ${df.code}`}); the stack needs about ${MIN_FREE_GB} GB`,
    };
  return gb >= MIN_FREE_GB
    ? { name: "disk", ok: true, detail: `${Math.floor(gb)} GB free` }
    : {
        name: "disk",
        ok: false,
        detail: `only ${gb.toFixed(1)} GB free in ${dir}; the stack needs about ${MIN_FREE_GB} GB. Fix: free some space, then switch it on again`,
      };
}

async function portCheck(
  runner: ProcessRunner,
  root: string,
  portFree: (port: number) => Promise<boolean | null>,
): Promise<CheckResult> {
  const port = webhookPort(root);
  const ps = await composePs(runner, root);
  if (ps.ok && isUp(serviceRow(ps.rows, DAEMON_SERVICE)))
    return { name: "ports", ok: true, detail: `port ${port} is your own daemon's` };
  const free = await portFree(port);
  if (free === null)
    return { name: "ports", ok: true, detail: `whether port ${port} is free is unknown` };
  return free
    ? { name: "ports", ok: true, detail: `port ${port} is free` }
    : {
        name: "ports",
        ok: false,
        detail: `port ${port} is in use by another program. Fix: stop it, or set QCR_WEBHOOK_PORT in ${root}/.env to a free port`,
      };
}

/** The machine checks: the wizard's preflight (Docker, Compose, the images,
 * the uid it records), then the disk and the webhook port. */
export function machineChecksStep(o: MachineCheckOptions = {}): OnboardingStep {
  const preflight = preflightStep();
  const portFree = o.portFree ?? loopbackPortFree;
  const run = async (ctx: Parameters<OnboardingStep["run"]>[0]): Promise<StepReport> => {
    const base = await preflight.run(ctx);
    const root = rootOf(ctx.adapters);
    const checks = [
      ...base.checks,
      await diskCheck(ctx.adapters.runner, root),
      await portCheck(ctx.adapters.runner, root, portFree),
    ];
    return {
      ok: checks.every((c) => c.ok),
      checks,
      ...(base.data ? { data: base.data } : {}),
    };
  };
  return {
    id: MACHINE_CHECKS_STEP_ID,
    title: "Machine checks: Docker, disk, ports",
    explain:
      "Checks that this machine can run auto-review: Docker and Compose, free disk, the webhook port.",
    order: preflight.order,
    run,
    verify: run,
  };
}

// ---- the daemon start ---------------------------------------------------

/** Start a stack that was brought up before and switched off since: its
 * containers and volumes are all there, so this is the whole of a second
 * switch-on. Before the first bring-up there is nothing to start. */
export function daemonStartStep(): OnboardingStep {
  const state = async (ctx: Parameters<OnboardingStep["run"]>[0]): Promise<StepReport> => {
    const ps = await composePs(ctx.adapters.runner, rootOf(ctx.adapters));
    if (!ps.ok)
      return {
        ok: false,
        checks: [{ name: "daemon", ok: false, detail: `can't ask Docker: ${ps.detail}` }],
      };
    const up = isUp(serviceRow(ps.rows, DAEMON_SERVICE));
    return {
      ok: up,
      checks: [
        { name: "daemon", ok: up, detail: up ? "the daemon runs" : "the daemon is stopped" },
      ],
    };
  };
  return {
    id: DAEMON_START_STEP_ID,
    title: "Start the daemon",
    explain: "Starts the stack a previous switch-on brought up; its data is kept.",
    // after the config steps, just before the first bring-up (70)
    order: 69,
    enabled: (choices) => topologyOf(choices) === "local",
    async run(ctx): Promise<StepReport> {
      if (typeof ctx.choices[BROUGHT_UP_CHOICE_KEY] !== "string")
        return {
          ok: true,
          checks: [{ name: "daemon", ok: true, detail: "not brought up yet: bring-up starts it" }],
        };
      const now = await state(ctx);
      if (now.ok) return now;
      const root = rootOf(ctx.adapters);
      const r = await ctx.adapters.runner.run(
        "docker",
        composeArgs(root, ["start", DAEMON_SERVICE]),
      );
      return r.code === 0
        ? {
            ok: true,
            checks: [{ name: "daemon", ok: true, detail: "started, with its data as it was" }],
          }
        : {
            ok: false,
            checks: [
              {
                name: "daemon",
                ok: false,
                detail: `\`docker compose start ${DAEMON_SERVICE}\` exited ${r.code}: ${(r.stderr || r.stdout).trim().slice(0, 300) || "no output"}`,
              },
            ],
          };
    },
    verify: state,
  };
}

// ---- the registry and its run --------------------------------------------

export type SwitchOnStepOptions = MachineCheckOptions & LoginShareOptions;

/** Switch-on's registry: the wizard's step modules plus the two above. */
export function switchOnRegistry(o: SwitchOnStepOptions = {}): StepRegistry<OnboardAdapters> {
  return new StepRegistry<OnboardAdapters>([
    machineChecksStep(o),
    topologyStep(),
    githubAccountStep(),
    escalationStep(),
    embeddingsStep(),
    ingressStep(),
    memoryStep(),
    loginShareStep(o),
    daemonStartStep(),
    bringUpStep(),
    memoryUserKeysStep(),
    verifyStackStep(),
    proofRoundStep(),
    goLiveStep(),
  ]);
}

/** What each step is handed: switch-on's silent defaults and the person's
 * answers. Only go_live is ever handed the confirm, and only by runGoLive. */
export function switchOnInput(
  id: string,
  a: { answers: { memory: boolean | null; confirmed: boolean }; repo: string | null },
): Record<string, unknown> {
  switch (id) {
    case TOPOLOGY_STEP_ID:
      return { choice: "local" };
    case GITHUB_ACCOUNT_STEP_ID:
      return { github_auth: "user", ...(a.repo ? { repo: a.repo } : {}) };
    case ESCALATION_STEP_ID:
      return { enable: "no" };
    case INGRESS_STEP_ID:
      return { choice: "polling" };
    case MEMORY_STEP_ID:
      return a.answers.memory === null
        ? {}
        : { choice: a.answers.memory ? "configure" : "declined" };
    case GO_LIVE_STEP_ID:
      return a.answers.confirmed === true
        ? { decision: "go_live", confirm: GO_LIVE_CONFIRMATION }
        : {};
    default:
      return {};
  }
}

export interface StepsRun<A extends ChecklistAdapters> {
  checklist: SetupChecklist<A>;
  /** The memory answer the memory step is handed (null: leave it). */
  memory: boolean | null;
  /** The configured repository, for the own-account step. */
  repo: string | null;
  progress?: (line: string) => void;
  /** Start the memory engine, for memory's phase B on a stack brought up
   * without it. Absent: the bring-up is what starts it. */
  startMemory?: () => Promise<SwitchResult>;
  /** Between phase B's tries while the engine starts (tests skip the wait). */
  sleep?: (ms: number) => Promise<void>;
}

export interface SwitchOnRun<A extends ChecklistAdapters> extends Omit<StepsRun<A>, "memory"> {
  answers: SwitchOnAnswers;
  /** The config's dry_run now: true, false, or null when unreadable. */
  dryRun: () => boolean | null;
  /** Keep the memory engine stopped after a bring-up started it (the person
   * left memory off). */
  stopMemory: () => Promise<SwitchResult>;
}

const line = (id: string, what: string): string => `${id}: ${what}`;
const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export type Walked = { ok: true } | { ok: false; detail: string };

/** Memory's phase B on a stack that runs now: start the engine (when the
 * caller can), then run the memory step again until the engine answers, for
 * a bounded wait. The root key is already in place, so the engine read it at
 * boot. A failure that is not the engine starting up ends it at once. */
export async function memoryPhaseB<A extends ChecklistAdapters>(
  r: Pick<StepsRun<A>, "checklist" | "startMemory" | "sleep" | "progress">,
  input: Record<string, unknown>,
): Promise<{ ok: true; detail: string } | { ok: false; detail: string }> {
  if (r.startMemory) {
    const up = await r.startMemory();
    if (!up.ok) return { ok: false, detail: `the memory engine did not start: ${up.detail}` };
  }
  r.progress?.("Waiting for the memory engine to answer…");
  for (let attempt = 1; ; attempt += 1) {
    const res = await r.checklist.runStep(MEMORY_STEP_ID, input);
    if (res.ok) return { ok: true, detail: res.checks.map((c) => c.detail).join("; ") || "done" };
    const why = res.failures.join("; ") || "it did not finish";
    if (!waitsOnServer(res.checks) || attempt >= MEMORY_WAIT_ATTEMPTS)
      return { ok: false, detail: why };
    await (r.sleep ?? realSleep)(MEMORY_WAIT_MS);
  }
}

/** The steps between the machine checks and the proof round, in order. The
 * first that fails ends the walk with what it said, except memory's phase A
 * waiting on an engine not yet running (its phase B follows the bring-up).
 * No step here is ever handed a confirm: the go-live is not among them. */
export async function runSteps<A extends ChecklistAdapters>(
  r: StepsRun<A>,
  steps: string[],
): Promise<Walked> {
  const say = (s: string): void => {
    steps.push(s);
    r.progress?.(s);
  };
  const inputs = { answers: { memory: r.memory, confirmed: false as const }, repo: r.repo };
  const failed = (id: string, title: string, why: string): Walked => {
    steps.push(line(id, `failed: ${why}`));
    return { ok: false, detail: `${title}: ${why}` };
  };
  let memoryWaits = false;
  const phaseB = async (): Promise<Walked> => {
    memoryWaits = false;
    const b = await memoryPhaseB(r, switchOnInput(MEMORY_STEP_ID, inputs));
    if (!b.ok) return failed(MEMORY_STEP_ID, "Memory", b.detail);
    say(line(MEMORY_STEP_ID, b.detail));
    return { ok: true };
  };
  for (const s of r.checklist.list()) {
    if (s.id === MACHINE_CHECKS_STEP_ID || AFTER_SWITCH_ON.has(s.id)) continue;
    // the engine runs now (the bring-up, or a stack brought up before)
    if (s.id === MEMORY_KEYS_STEP_ID && memoryWaits) {
      const b = await phaseB();
      if (!b.ok) return b;
    }
    if (s.status === "disabled") {
      say(line(s.id, "not on this route"));
      continue;
    }
    // a memory "yes" given now runs even over a recorded answer
    const answered = s.id === MEMORY_STEP_ID && r.memory === true;
    if (s.status === "done" && !EVERY_TIME.has(s.id) && !answered) {
      say(line(s.id, "already done"));
      continue;
    }
    r.progress?.(`${s.title}…`);
    const res = await r.checklist.runStep(s.id, switchOnInput(s.id, inputs));
    if (!res.ok && s.id === MEMORY_STEP_ID && waitsOnServer(res.checks)) {
      memoryWaits = true;
      say(line(s.id, "its root key is placed; its user keys follow once the engine runs"));
      continue;
    }
    if (!res.ok) return failed(s.id, s.title, res.failures.join("; ") || "it did not finish");
    say(line(s.id, res.checks.map((c) => c.detail).join("; ") || "done"));
  }
  if (memoryWaits) return phaseB();
  return { ok: true };
}

/**
 * Run switch-on's steps after the machine checks, in order (runSteps).
 * Auto-review comes up in dry-run: switch-on never runs the proof round or
 * the go-live, whatever the config says. Going live is runGoLive, its own
 * act with its own confirm.
 */
export async function runSwitchOn<A extends ChecklistAdapters>(
  r: SwitchOnRun<A>,
): Promise<SwitchOnOutcome> {
  if (r.answers.confirmed !== true) throw new Error("switch-on runs only on the person's confirm");
  const steps: string[] = [];
  const say = (s: string): void => {
    steps.push(s);
    r.progress?.(s);
  };
  const walked = await runSteps({ ...r, memory: r.answers.memory }, steps);
  if (!walked.ok) {
    const dry = r.dryRun();
    return { ok: false, live: dry === null ? null : !dry, detail: walked.detail, steps };
  }
  if (r.answers.memory === false) {
    const stopped = await r.stopMemory();
    say(line("memory", stopped.ok ? "kept off" : `could not be kept off: ${stopped.detail}`));
  }
  const dry = r.dryRun();
  if (dry === false) {
    say(line(GO_LIVE_STEP_ID, "already live"));
    return { ok: true, live: true, detail: "Auto-review is on and posts live.", steps };
  }
  if (dry === null) {
    steps.push(line(GO_LIVE_STEP_ID, "unknown: the config's dry_run cannot be read"));
    return {
      ok: false,
      live: null,
      detail:
        "Auto-review started, but whether it posts live is unknown: the config cannot be read.",
      steps,
    };
  }
  say(line(GO_LIVE_STEP_ID, "not yet: auto-review is in dry-run"));
  return {
    ok: true,
    live: false,
    detail:
      "Auto-review is on in dry-run: it reviews, and posts nothing yet. Going live is its own step: one review you read, then one more confirm.",
    steps,
  };
}

/** The proof round the checklist records, or null: what the go-live step
 * demands (and re-verifies against the daemon's own state). */
export function recordedProof<A extends ChecklistAdapters>(
  checklist: SetupChecklist<A>,
): ProofRecord | null {
  return parseProofRecord(checklist.choices()[PROOF_CHOICE_KEY]);
}

/** The wizard's proof round on pull request `pr`, from dry-run: the daemon
 * reviews it now, the round is followed through its own state, and the
 * review it would have posted is read back. The detail is that review. */
export async function runProofRound<A extends ChecklistAdapters>(
  checklist: SetupChecklist<A>,
  pr: number,
): Promise<SwitchResult> {
  const r = await checklist.runStep(PROOF_STEP_ID, { pr });
  return r.ok
    ? { ok: true, detail: r.checks.map((c) => c.detail).join("\n\n") }
    : { ok: false, detail: r.failures.join("; ") || "the proof round did not finish" };
}

/** The go-live step, from dry-run, on the person's own go-live confirm
 * (asked after the proof round, never the switch-on's). */
export async function runGoLive<A extends ChecklistAdapters>(
  checklist: SetupChecklist<A>,
  answers: { confirmed: true },
): Promise<SwitchResult> {
  if (answers.confirmed !== true) throw new Error("go-live runs only on the person's confirm");
  const go = await checklist.runStep(
    GO_LIVE_STEP_ID,
    switchOnInput(GO_LIVE_STEP_ID, { answers: { memory: null, confirmed: true }, repo: null }),
  );
  return go.ok
    ? { ok: true, detail: "Auto-review posts live now." }
    : { ok: false, detail: go.failures.join("; ") || "going live did not finish" };
}

// ---- the real adapters -----------------------------------------------------

/** A process runner for the steps (a minute per call; the long pulls stream
 * through the steps' own runner). */
export const stepRunner: ProcessRunner = {
  run: (cmd, args) =>
    new Promise((resolve) => {
      execFile(cmd, args, { timeout: 60_000, maxBuffer: 16 << 20 }, (err, stdout, stderr) => {
        const code = err === null ? 0 : typeof err.code === "number" ? err.code : 1;
        resolve({
          code,
          stdout: String(stdout),
          stderr: err && !stderr ? String(err.message) : String(stderr),
        });
      });
    }),
};

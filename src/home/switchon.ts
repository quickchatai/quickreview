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
//                    (src/home/loginshare.ts)
//   daemon_start     start a stack that was brought up before (a second
//                    switch-on is this and little else: its data is kept)
//   bringup          the first time: pull and start the stack (restart:
//                    unless-stopped, so it survives reboots)
//   memory_user_keys, verify_stack
//   go_live          the wizard's go-live step, handed the person's one
//                    confirm: the only thing here that may move dry_run, and
//                    it moves it only through goLiveStep (invariant 6)
//
// A step the checklist already records as done is not run again (its answer
// stands), except the two that act on the running machine: the machine checks
// and the daemon start.
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
import { MEMORY_STEP_ID, memoryStep } from "../onboard/steps/memory.js";
import { MEMORY_KEYS_STEP_ID, memoryUserKeysStep } from "../onboard/steps/memorykeys.js";
import { preflightStep } from "../onboard/steps/preflight.js";
import { TOPOLOGY_STEP_ID, topologyOf, topologyStep } from "../onboard/steps/topology.js";
import { VERIFY_STACK_STEP_ID, verifyStackStep } from "../onboard/steps/verifyup.js";
import { LOGIN_SHARE_STEP_ID, loginShareStep, type LoginShareOptions } from "./loginshare.js";
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
  GO_LIVE_STEP_ID,
] as const;

/** The steps that act on the running machine: run on every switch-on. */
const EVERY_TIME: ReadonlySet<string> = new Set([MACHINE_CHECKS_STEP_ID, DAEMON_START_STEP_ID]);

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
    goLiveStep(),
  ]);
}

/** What each step is handed: switch-on's silent defaults and the person's
 * answers. Only go_live is ever handed the confirm. */
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

/** The steps between the machine checks and the go-live, in order. The first
 * that fails ends the walk with what it said. No step here is ever handed a
 * confirm: the go-live is not among them. */
export async function runSteps<A extends ChecklistAdapters>(
  r: StepsRun<A>,
  steps: string[],
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const say = (s: string): void => {
    steps.push(s);
    r.progress?.(s);
  };
  const inputs = { answers: { memory: r.memory, confirmed: false as const }, repo: r.repo };
  for (const s of r.checklist.list()) {
    if (s.id === MACHINE_CHECKS_STEP_ID || s.id === GO_LIVE_STEP_ID) continue;
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
    if (!res.ok) {
      const why = res.failures.join("; ") || "it did not finish";
      steps.push(line(s.id, `failed: ${why}`));
      return { ok: false, detail: `${s.title}: ${why}` };
    }
    say(line(s.id, res.checks.map((c) => c.detail).join("; ") || "done"));
  }
  return { ok: true };
}

/**
 * Run switch-on's steps after the machine checks, in order (runSteps). The
 * go-live step runs last, and only while the config is in dry-run: it is
 * handed the person's confirm, and whatever it decides is the answer (it may
 * refuse: then auto-review is on, in dry-run, and the outcome says why).
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
    steps.push(line(GO_LIVE_STEP_ID, "skipped: the config's dry_run cannot be read"));
    return {
      ok: false,
      live: null,
      detail:
        "Auto-review started, but whether it posts live is unknown: the config cannot be read.",
      steps,
    };
  }
  const go = await r.checklist.runStep(GO_LIVE_STEP_ID, switchOnInput(GO_LIVE_STEP_ID, r));
  if (go.ok) {
    say(line(GO_LIVE_STEP_ID, "live"));
    return { ok: true, live: true, detail: "Auto-review is on and posts live.", steps };
  }
  const why = go.failures.join("; ") || "it did not finish";
  steps.push(line(GO_LIVE_STEP_ID, `refused: ${why}`));
  return {
    ok: true,
    live: false,
    detail: `Auto-review is on in dry-run: it reviews, and posts nothing yet. Going live was refused: ${why}`,
    steps,
  };
}

/** The go-live step alone, from dry-run, on the person's confirm. */
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

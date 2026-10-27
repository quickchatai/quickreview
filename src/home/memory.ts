// Memory in the home: its own switch, off by default, independent of
// auto-review. On this machine the memory engine is the compose stack's
// `memory` service (OpenViking and its local embedder): on is that container
// running, off is it stopped, with what it learned kept in its volume.
//
// Switching it on sets memory up the wizard's way when it never was: the
// memory step places the root key, the engine is started (it reads that key
// at boot), the memory step runs again until the engine answers and mints the
// user keys (memoryPhaseB), then memory_user_keys. On a machine whose
// stack was never brought up it brings the stack up through switch-on's own
// steps (never the go-live, and never a confirm) and leaves the daemon as it
// found it: memory on never switches auto-review on. Switching auto-review
// off never stops memory (src/home/autoreview.ts stops the daemon alone).
import type {
  ChecklistAdapters,
  SetupChecklist,
} from "@quickchatai/pi-quickreview/src/setupchecklist.js";
import { OnboardingEngine, type OnboardAdapters, type ProcessRunner } from "../onboard/engine.js";
import { BROUGHT_UP_CHOICE_KEY } from "../onboard/steps/bringup.js";
import {
  DAEMON_SERVICE,
  MEMORY_SERVICE,
  composeArgs,
  readEnvText,
} from "../onboard/steps/compose.js";
import { readEnvKey } from "../onboard/steps/ingress.js";
import { MEMORY_CHOICE_KEY, MEMORY_STEP_ID, waitsOnServer } from "../onboard/steps/memory.js";
import { MEMORY_KEYS_STEP_ID } from "../onboard/steps/memorykeys.js";
import { serviceState } from "./autoreview.js";
import {
  known,
  type Known,
  type MemoryPort,
  type MemoryState,
  type SwitchResult,
} from "./ports.js";
import {
  MACHINE_CHECKS_STEP_ID,
  memoryPhaseB,
  runSteps,
  switchOnInput,
  switchOnRegistry,
  type StepsRun,
  type SwitchOnStepOptions,
} from "./switchon.js";

/** compose's memory cap when the project `.env` names none
 * (docker-compose.yml `mem_limit: ${QCR_MEMORY_LIMIT:-4g}`). */
export const DEFAULT_MEMORY_LIMIT = "4g";

/** "4g" → "up to 4 GB of RAM"; a value compose would not read is said as is. */
export function ramCostOf(limit: string): string {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([kmgt])?b?\s*$/i.exec(limit);
  if (!m) return `up to ${limit.trim()} of RAM`;
  const unit = { k: "KB", m: "MB", g: "GB", t: "TB" }[(m[2] ?? "").toLowerCase()] ?? "bytes";
  return `up to ${m[1]} ${unit} of RAM`;
}

/** The memory engine's state from its container's. */
export function memoryStateOf(c: Known<"running" | "restarting" | "stopped">): Known<MemoryState> {
  if (c.kind === "unknown") return c;
  return known(c.value === "running" ? "on" : c.value === "restarting" ? "starting" : "off");
}

export interface ComposeMemoryOptions extends SwitchOnStepOptions {
  root: string;
  runner: ProcessRunner;
  stepAdapters: (log: (line: string) => void) => OnboardAdapters;
  /** The configured repository, for a first bring-up's own-account step. */
  repo: () => Promise<string | null>;
  /** Between phase B's tries while the engine starts (tests skip the wait). */
  sleep?: (ms: number) => Promise<void>;
}

const firstLine = (s: string): string => s.trim().split("\n")[0]?.trim() || "no output";

/** The memory step's answer when the person turns memory on. */
const MEMORY_YES = switchOnInput(MEMORY_STEP_ID, {
  answers: { memory: true, confirmed: false },
  repo: null,
});

/**
 * Memory on, on a stack brought up before. Set up when it never was (or was
 * declined): phase A places the root key, and when the engine does not run
 * yet that is all it can do, so the engine is started (it reads the key at
 * boot) and phase B runs once it answers (memoryPhaseB). Otherwise the engine
 * is started as it is. Then its user keys, when that step is not done.
 */
export async function memoryOnStack<A extends ChecklistAdapters>(
  e: SetupChecklist<A>,
  o: Pick<StepsRun<A>, "progress" | "sleep"> & { startMemory: () => Promise<SwitchResult> },
): Promise<SwitchResult> {
  const configured = e.list().find((s) => s.id === MEMORY_STEP_ID);
  let waits = false;
  if (configured?.status !== "done" || e.choices()[MEMORY_CHOICE_KEY] === "declined") {
    o.progress?.("Setting memory up…");
    const r = await e.runStep(MEMORY_STEP_ID, MEMORY_YES);
    if (!r.ok && !waitsOnServer(r.checks)) return { ok: false, detail: r.failures.join("; ") };
    waits = !r.ok;
  }
  if (waits) {
    const b = await memoryPhaseB({ ...o, checklist: e }, MEMORY_YES);
    if (!b.ok) return { ok: false, detail: b.detail };
  } else {
    const up = await o.startMemory();
    if (!up.ok) return up;
  }
  const keys = e.list().find((s) => s.id === MEMORY_KEYS_STEP_ID);
  if (keys && keys.status !== "done" && keys.status !== "disabled") {
    const r = await e.runStep(MEMORY_KEYS_STEP_ID);
    if (!r.ok) return { ok: false, detail: `the engine runs, but ${r.failures.join("; ")}` };
  }
  return { ok: true, detail: "Memory is on." };
}

export function composeMemory(o: ComposeMemoryOptions): MemoryPort {
  const compose = async (args: string[], what: string): Promise<SwitchResult> => {
    const r = await o.runner.run("docker", composeArgs(o.root, args));
    return r.code === 0
      ? { ok: true, detail: what }
      : {
          ok: false,
          detail: `docker compose ${args.join(" ")} exited ${r.code}: ${firstLine(r.stderr || r.stdout)}`,
        };
  };
  const engine = (log: (line: string) => void): OnboardingEngine =>
    new OnboardingEngine(switchOnRegistry(o), o.stepAdapters(log));
  const startMemory = (): Promise<SwitchResult> =>
    compose(["up", "-d", MEMORY_SERVICE], "the memory engine runs");

  return {
    status: async () => memoryStateOf(await serviceState(o.runner, o.root, MEMORY_SERVICE)),
    control: {
      ramCost: () =>
        ramCostOf(
          (readEnvKey(readEnvText(o.root), "QCR_MEMORY_LIMIT") ?? "").trim() ||
            DEFAULT_MEMORY_LIMIT,
        ),
      switchOn: async (progress) => {
        const e = engine((l) => progress?.(l));
        if (typeof e.choices()[BROUGHT_UP_CHOICE_KEY] !== "string") {
          // No stack yet: switch-on's steps bring it up with memory, and the
          // daemon is put back as it was (off), so auto-review stays off.
          const daemonWas = await serviceState(o.runner, o.root, DAEMON_SERVICE);
          const checks = await e.runStep(MACHINE_CHECKS_STEP_ID);
          if (!checks.ok) return { ok: false, detail: checks.failures.join("; ") };
          const steps: string[] = [];
          const walked = await runSteps(
            {
              checklist: e,
              memory: true,
              repo: await o.repo(),
              startMemory,
              ...(o.sleep ? { sleep: o.sleep } : {}),
              ...(progress ? { progress } : {}),
            },
            steps,
          );
          if (!walked.ok) return { ok: false, detail: walked.detail };
          if (daemonWas.kind === "known" && daemonWas.value !== "running") {
            const stopped = await compose(["stop", DAEMON_SERVICE], "");
            if (!stopped.ok) return { ok: false, detail: `memory is on, but ${stopped.detail}` };
          }
          return { ok: true, detail: "Memory is on." };
        }
        return memoryOnStack(e, {
          startMemory,
          ...(o.sleep ? { sleep: o.sleep } : {}),
          ...(progress ? { progress } : {}),
        });
      },
      switchOff: () => compose(["stop", MEMORY_SERVICE], "Memory is off. What it learned is kept."),
    },
  };
}

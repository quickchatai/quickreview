// onboarding — the wizard's tool belt. Loaded ONLY by the wizard's own pi
// session (src/onboard/launch.ts onboardingPiArgv; per spawn, `-e`, alongside --no-extensions — no ambient extension rides the
// onboarding session), never registered globally. pi jiti-loads this TS source
// on the HOST, so it imports the OnboardingEngine source directly and runs it
// in-process: pi talks, these deterministic tools act, and the LLM never
// freestyles a shell command (the built-in belt is read-only by argv).
//
// One tool per registered engine step (onboard_<id>), plus:
//   - onboard_status: reconcile + checklist listing (resume re-verifies every
//     claimed-done step against reality — the file is never trusted alone);
//   - finish_and_exit: re-runs the FULL verification; anything red comes back
//     as the tool result (no exit, ever, while red); all green marks the
//     checklist complete, writes the companion's first-run marker
//     (state/companion/first-run.json), and triggers pi's deferred shutdown.
//
// Convention notes (same shape as companion-guard/tui-view): degrade, never
// wedge — a pi without registerTool registers nothing and says so; a missing
// ctx.shutdown falls back to telling the operator to /exit.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionFactory,
  ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import {
  registerQcrTool,
  textResult as text,
  type QcrTool,
} from "@quickchatai/pi-quickreview/extensions/pi-tool.js";
import {
  OnboardingEngine,
  type CheckResult,
  type OnboardAdapters,
  type ReconcileReport,
  type StepStatusLine,
} from "../src/onboard/engine.js";
import { defaultSteps } from "../src/onboard/steps/index.js";
import { openStepMemoryForward } from "../src/onboard/stepforward.js";
import { locateConfig } from "../src/install.js";
import { registerLoginRoute } from "./login-route.js";
import {
  ONBOARD_FINISH_TOOL,
  ONBOARD_STATUS_TOOL,
  onboardStepToolName,
} from "../src/onboard/toolnames.js";

const NO_PARAMS = { type: "object", properties: {} } as const;

// ---- real adapters ----------------------------------------------------------

/** The one real adapter assembly. Steps see the host only through this. */
export function realAdapters(root: string): OnboardAdapters {
  return {
    fetch: (input, init) => fetch(input, init),
    runner: {
      run: (cmd, args) =>
        new Promise((resolvePromise) => {
          execFile(cmd, args, { timeout: 60_000 }, (err, stdout, stderr) => {
            const code = err === null ? 0 : typeof err.code === "number" ? err.code : 1;
            resolvePromise({
              code,
              stdout: String(stdout),
              stderr: err && !stderr ? String(err.message) : String(stderr),
            });
          });
        }),
    },
    clock: () => new Date(),
    host: {
      nodeVersion: process.version,
      uid: typeof process.getuid === "function" ? process.getuid() : null,
      inContainer: existsSync("/.dockerenv"),
    },
    // The install locator decides which config.toml the wizard edits —
    // $QCR_CONFIG, else the install's config home (never the checkout's).
    paths: { stateDir: join(root, "state"), configPath: locateConfig().path },
    log: (line) => console.error(line),
    memoryForward: (req) => openStepMemoryForward(req),
  };
}

export function buildEngine(root: string): OnboardingEngine {
  return new OnboardingEngine(defaultSteps(), realAdapters(root));
}

// ---- rendering --------------------------------------------------------------

export function renderChecks(checks: readonly CheckResult[]): string {
  return checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.name} — ${c.detail}`).join("\n");
}

export function renderStatus(
  lines: readonly StepStatusLine[],
  reconciled: ReconcileReport,
): string {
  const rows = lines.map((l) => {
    const mark =
      l.status === "done"
        ? "[done]"
        : l.status === "disabled"
          ? "[skipped]"
          : l.optional
            ? "[after setup]"
            : "[ ]";
    return `${mark} ${l.id} — ${l.title}${l.note ? ` (${l.note})` : ""}`;
  });
  const demoted = reconciled.demoted.map(
    (d) => `re-verification demoted ${d.id}: ${d.failures.join("; ")}`,
  );
  return [
    "Onboarding checklist (claimed-done steps were just re-verified against reality):",
    ...rows,
    ...demoted,
  ].join("\n");
}

// ---- tool belt --------------------------------------------------------------

/**
 * Build the tool definitions over an engine. `shutdown` is injected so tests
 * assert the finish tool's refusal/exit behaviour without a pi; activate wires
 * the real ctx probe.
 */
export function toolDefinitions(
  engine: OnboardingEngine,
  shutdown: (ctx?: Pick<ExtensionToolContext, "shutdown">) => void,
): QcrTool[] {
  const stepTools: QcrTool[] = engine.stepDefs().map((step) => ({
    name: onboardStepToolName(step.id),
    label: step.title,
    description:
      `${step.explain} Deterministic: runs the "${step.id}" onboarding step's real checks and returns one ✓/✗ line per check. ` +
      "Safe to re-run; a failed run leaves the step pending.",
    promptSnippet: `Run the ${step.id} onboarding step`,
    // A step that needs the operator's answer declares its own schema; the
    // params land on the step as ctx.input (the ingress choice is one).
    // Everything else takes no input at all.
    parameters: step.parameters ?? NO_PARAMS,
    execute: async (_id, params) => {
      const result = await engine.runStep(step.id, params ?? {});
      if (result.ok)
        return text(`Step "${step.id}" completed and recorded.\n${renderChecks(result.checks)}`);
      // A refusal (a disabled or unknown step) runs no checks: its reason is
      // the engine's failures, and there are no red checks to fix.
      if (result.checks.length === 0)
        return text(
          `Step "${step.id}" REFUSED — ${result.failures.join("; ") || "no reason given"}.`,
        );
      return text(
        `Step "${step.id}" FAILED — fix the red checks and run it again.\n${renderChecks(result.checks)}`,
      );
    },
  }));

  const status: QcrTool = {
    name: ONBOARD_STATUS_TOOL,
    label: "Onboarding status",
    description:
      "The checklist: every step in order with its status. Re-verifies each claimed-done step against reality first " +
      "(the state file is never trusted alone), so call this at the start of every session and after anything changes outside the tools.",
    promptSnippet: "Read and re-verify the onboarding checklist",
    parameters: NO_PARAMS,
    execute: async () => {
      const reconciled = await engine.reconcile();
      return text(renderStatus(engine.list(), reconciled));
    },
  };

  const finish: QcrTool = {
    name: ONBOARD_FINISH_TOOL,
    label: "Finish onboarding",
    description:
      "Re-run EVERY verification. While anything is red this refuses and returns the failures — it never exits on red. " +
      "When all green it marks onboarding complete, writes the companion first-run marker, and shuts this session down; " +
      "the wizard process then opens the TUI.",
    promptSnippet: "Verify everything and, only when green, finish onboarding",
    parameters: NO_PARAMS,
    execute: async (_id, _params, _signal, _onUpdate, ctx) => {
      const result = await engine.finish();
      if (!result.ok) {
        const red = result.results
          .filter((r) => !r.ok && !r.optional)
          .map((r) => `✗ ${r.id}: ${r.failures.join("; ") || "not verified"}`);
        return text(
          `Not finished — these verifications are red:\n${red.join("\n")}\n` +
            "Fix them (or run the step tools again), then call finish_and_exit once more.",
        );
      }
      // Green: shut down AFTER this result is returned. The 250ms defer is
      // belt-and-braces so the model sees the confirmation first.
      // VERIFY-ON-PIN: ctx.shutdown's own idle-deferral (pi's ExtensionContext) may
      // make the timer redundant — the onboarding smoke step is the evidence.
      setTimeout(() => shutdown(ctx), 250);
      return text(
        `Every step verified green — onboarding is complete (recorded ${result.completed_at}).\n` +
          `${result.marker_written ? "First-run marker written for the companion greeting." : "First-run marker already present — left untouched."}\n` +
          "This session now shuts down and the TUI opens: the board lists the repository's open pull requests — " +
          "select one and press R to review it now (dry-run: nothing is posted).",
      );
    },
  };

  return [...stepTools, status, finish];
}

// ---- activation -------------------------------------------------------------

export interface OnboardingConfig {
  /** The checkout the wizard inspects and writes the install's config for. */
  root: string;
}

/** The root the env describes: QCR_ROOT, else `cwd`. */
export function onboardingConfigFromEnv(env: NodeJS.ProcessEnv, cwd: string): OnboardingConfig {
  return { root: env.QCR_ROOT ?? cwd };
}

/** The factory that registers the wizard's tools. The env shim is
 * extensions/cli/onboarding.ts. */
export function createOnboarding(config: OnboardingConfig): ExtensionFactory {
  return (pi) => registerOnboarding(pi, config);
}

/**
 * The onboarding session's first-run login: when pi has no usable model
 * login, pi's own /login menu opens with a widget that says which logins work
 * (any OpenAI one), and an OpenAI model whose provider has no login runs on
 * the twin login that exists (extensions/login-route.ts). The wizard's
 * session registers it with the tools; a host that builds its own onboarding
 * extension over `toolDefinitions` + `registerQcrTool` calls it too.
 */
export function registerOnboardingSession(pi: ExtensionAPI): void {
  registerLoginRoute(pi, { open: "submit" });
}

function registerOnboarding(pi: ExtensionAPI, config: OnboardingConfig): void {
  registerOnboardingSession(pi);
  if (typeof pi.registerTool !== "function") {
    // Degrade loudly, never wedge: pi still starts, the guide can only talk.
    console.error(
      "onboarding: pi.registerTool unavailable — no wizard tools registered; this pi cannot run onboarding.",
    );
    return;
  }
  const engine = buildEngine(config.root);
  const shutdown = (ctx?: Pick<ExtensionToolContext, "shutdown">): void => {
    const fn = ctx?.shutdown ?? (pi as { shutdown?: () => void | Promise<void> }).shutdown;
    if (typeof fn === "function") {
      // VERIFY-ON-PIN: deferred clean shutdown with exit code 0 (pi 1.4.0's
      // ExtensionContext.shutdown). Bound to the named onboarding smoke step.
      void fn.call(ctx ?? pi);
    } else {
      console.error(
        "onboarding: no shutdown API on this pi — type /exit to leave; the wizard will open the TUI.",
      );
    }
  };
  for (const def of toolDefinitions(engine, shutdown)) registerQcrTool(pi, def);
}

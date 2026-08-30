// onboarding — the wizard's tool belt. Loaded ONLY by `qcr onboard`
// (per spawn, `-e`, alongside --no-extensions — no ambient extension rides the
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
//     checklist complete, writes the first-run marker
//     (state/companion/first-run.json), and triggers pi's deferred shutdown —
//     the `qcr onboard` process then opens the TUI.
//
// Convention notes (same shape as companion-guard/tui-view): degrade, never
// wedge — a pi without registerTool registers nothing and says so; a missing
// ctx.shutdown falls back to telling the operator to /exit.
import { execFile } from "node:child_process";
import { join } from "node:path";
import type { Pi, PiToolContext, PiToolDefinition, PiToolResult } from "@earendil-works/pi-coding-agent";
import {
  OnboardingEngine,
  type CheckResult,
  type OnboardAdapters,
  type ReconcileReport,
  type StepStatusLine,
} from "../src/onboard/engine.js";
import { defaultSteps } from "../src/onboard/steps/index.js";

const NO_PARAMS = { type: "object", properties: {} } as const;

function text(t: string): PiToolResult {
  return { content: [{ type: "text", text: t }] };
}

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
            resolvePromise({ code, stdout: String(stdout), stderr: err && !stderr ? String(err.message) : String(stderr) });
          });
        }),
    },
    clock: () => new Date(),
    host: {
      nodeVersion: process.version,
      uid: typeof process.getuid === "function" ? process.getuid() : null,
    },
    paths: { stateDir: join(root, "state") },
    log: (line) => console.error(line),
  };
}

export function buildEngine(root: string): OnboardingEngine {
  return new OnboardingEngine(defaultSteps(), realAdapters(root));
}

// ---- rendering --------------------------------------------------------------

export function renderChecks(checks: readonly CheckResult[]): string {
  return checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.name} — ${c.detail}`).join("\n");
}

export function renderStatus(lines: readonly StepStatusLine[], reconciled: ReconcileReport): string {
  const rows = lines.map((l) => {
    const mark = l.status === "done" ? "[done]" : l.status === "disabled" ? "[skipped]" : "[ ]";
    return `${mark} ${l.id} — ${l.title}${l.note ? ` (${l.note})` : ""}`;
  });
  const demoted = reconciled.demoted.map((d) => `re-verification demoted ${d.id}: ${d.failures.join("; ")}`);
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
export function toolDefinitions(engine: OnboardingEngine, shutdown: (ctx?: PiToolContext) => void): PiToolDefinition[] {
  const stepTools: PiToolDefinition[] = engine.stepDefs().map((step) => ({
    name: `onboard_${step.id}`,
    label: step.title,
    description:
      `${step.explain} Deterministic: runs the "${step.id}" onboarding step's real checks and returns one ✓/✗ line per check. ` +
      "Safe to re-run; a failed run leaves the step pending.",
    promptSnippet: `Run the ${step.id} onboarding step`,
    parameters: NO_PARAMS,
    execute: async () => {
      const result = await engine.runStep(step.id);
      const head = result.ok ? `Step "${step.id}" completed and recorded.` : `Step "${step.id}" FAILED — fix the red checks and run it again.`;
      return text(`${head}\n${renderChecks(result.checks)}`);
    },
  }));

  const status: PiToolDefinition = {
    name: "onboard_status",
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

  const finish: PiToolDefinition = {
    name: "finish_and_exit",
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
        const red = result.results.filter((r) => !r.ok).map((r) => `✗ ${r.id}: ${r.failures.join("; ") || "not verified"}`);
        return text(
          `Not finished — these verifications are red:\n${red.join("\n")}\n` +
            "Fix them (or run the step tools again), then call finish_and_exit once more.",
        );
      }
      // Green: shut down AFTER this result is returned. The 250ms defer is
      // belt-and-braces so the model sees the confirmation first.
      // VERIFY-ON-PIN: ctx.shutdown's own idle-deferral (see pi-api.d.ts) may
      // make the timer redundant — the onboarding smoke step is the evidence.
      setTimeout(() => shutdown(ctx), 250);
      return text(
        `Every step verified green — onboarding is complete (recorded ${result.completed_at}).\n` +
          `${result.marker_written ? "First-run marker written for the companion greeting." : "First-run marker already present — left untouched."}\n` +
          "This session now shuts down and the TUI opens.",
      );
    },
  };

  return [...stepTools, status, finish];
}

// ---- activation -------------------------------------------------------------

const activate = (pi: Pi): void => {
  if (typeof pi.registerTool !== "function") {
    // Degrade loudly, never wedge: pi still starts, the guide can only talk.
    console.error("onboarding: pi.registerTool unavailable — no wizard tools registered; this pi cannot run onboarding.");
    return;
  }
  const root = process.env.QCR_ROOT ?? process.cwd();
  const engine = buildEngine(root);
  const shutdown = (ctx?: PiToolContext): void => {
    const fn = ctx?.shutdown ?? (pi as { shutdown?: () => void | Promise<void> }).shutdown;
    if (typeof fn === "function") {
      // VERIFY-ON-PIN: deferred clean shutdown with exit code 0 (pi-api.d.ts
      // PiToolContext). Bound to the named onboarding smoke step.
      void fn.call(ctx ?? pi);
    } else {
      console.error("onboarding: no shutdown API on this pi — type /exit to leave; the wizard will open the TUI.");
    }
  };
  for (const def of toolDefinitions(engine, shutdown)) pi.registerTool(def);
};

export default activate;

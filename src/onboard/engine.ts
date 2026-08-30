// OnboardingEngine — the one new seam of the onboarding wizard (spec,
// skeleton): a checklist state machine plus deterministic step
// implementations behind injected adapters. pi is a thin driver over this
// engine (extensions/onboarding.ts registers one tool per step); the engine
// itself is fully drivable from tests and from a non-LLM fallback entry, and
// nothing in here touches the network, Docker, or a real pi except through
// the adapters.
//
// Resumability contract ("Engine and resumability"):
//   - checklist state persists to state/onboarding/checklist.json after every
//     step, tmp+rename atomic (the verdicts.ts convention);
//   - startup reconciles claimed state against REALITY: a step claimed done is
//     re-verified with its verify(), never trusted from the file alone;
//   - a fully-done checklist re-runs as verify-only (the wizard doubles as a
//     diagnostic);
//   - a corrupt/unreadable checklist degrades to a fresh one (the resume
//     re-verifies everything anyway) — never a crash.
//
// The finish path writes the first-run marker state/companion/first-run.json
// ({"completed_at": "<iso>"}) exactly once — the contract's companion
// first-run greeting consumes. Keep the path and shape stable.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// ---- adapters ---------------------------------------------------------------

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Process seam. NEVER throws: a missing binary is a nonzero code with the
 * error text in stderr, so a step can render it as a plain red check. */
export interface ProcessRunner {
  run(cmd: string, args: string[]): Promise<ProcessResult>;
}

/** Everything a step may touch outside its own logic. All injected — tests
 * fake every field; extensions/onboarding.ts builds the real set. Later
 * steps use fetch (manifest exchange, health
 * probes) and prompter (non-LLM fallback entry); preflight needs neither. */
export interface OnboardAdapters {
  /** HTTP seam (GitHub App manifest exchange, health endpoints, …). */
  fetch: typeof fetch;
  runner: ProcessRunner;
  clock: () => Date;
  /** Interactive fallback question seam. pi is the normal prompter — steps
   * driven from the pi session get their answers as tool inputs instead. */
  prompter?: (question: string) => Promise<string>;
  /** Deterministic host facts, captured once by the real assembly so steps
   * never read process globals themselves. `uid` is null where the platform
   * has no uid (Windows). */
  host: { nodeVersion: string; uid: number | null };
  /** Filesystem roots. `stateDir` is `<sandbox root>/state`. */
  paths: { stateDir: string };
  log?: (line: string) => void;
}

// ---- step vocabulary --------------------------------------------------------

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

/** What run() and verify() both return. `data` (run only) is persisted onto
 * the step's checklist record and handed back as ctx.data on later calls. */
export interface StepReport {
  ok: boolean;
  checks: CheckResult[];
  data?: Record<string, unknown>;
}

export interface StepContext {
  adapters: OnboardAdapters;
  /** The tool call's inputs — the operator's ANSWER to a step that asks one
   * (`{}` for a step that declares no `parameters`, and always on verify()).
   * A step that needs an answer and does not get one must return a refusal
   * naming the options, never a guess: the wizard offers, the operator picks. */
  input: Readonly<Record<string, unknown>>;
  /** Recorded operator choices (topology, auth route, captured uid, …). */
  choices: Readonly<Record<string, unknown>>;
  /** This step's persisted data from a previous run ({} on first run). */
  data: Readonly<Record<string, unknown>>;
  /** Record an operator choice / derived fact for later steps (persisted with
   * the step result). */
  recordChoice(key: string, value: unknown): void;
}

/**
 * One onboarding step. Later tickets register more of these (defaultSteps in
 * src/onboard/steps/index.ts); the interface is the extension point:
 *   - `id` must be tool-name-safe ([a-z][a-z0-9_]*) — the pi extension
 *     registers each step as tool `onboard_<id>`;
 *   - `explain` is the teach-text the guide relays BEFORE running the step;
 *   - `enabled` gates on recorded choices (e.g. the VM route's steps are
 *     disabled on the laptop topology); absent ⇒ always enabled;
 *   - `run` performs the step; `verify` re-checks its outcome against reality
 *     and must be safe to call any number of times.
 */
export interface OnboardingStep {
  id: string;
  title: string;
  explain: string;
  /** Ascending display/registration order. */
  order: number;
  /** JSON-schema object the step's pi tool declares, for steps that need the
   * operator's answer (a choice, a hostname). Absent ⇒ the tool takes no
   * input, which is the common case. */
  parameters?: unknown;
  enabled?(choices: Readonly<Record<string, unknown>>): boolean;
  run(ctx: StepContext): Promise<StepReport>;
  verify(ctx: StepContext): Promise<StepReport>;
}

export function failures(checks: readonly CheckResult[]): string[] {
  return checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
}

// ---- checklist file ---------------------------------------------------------

export const CHECKLIST_VERSION = 1;

export interface StepRecord {
  status: "pending" | "done";
  completed_at: string | null;
  /** Last successful re-verification (resume / finish). */
  verified_at: string | null;
  /** Why a claimed-done step was demoted, or other engine notes. */
  note: string | null;
  data: Record<string, unknown>;
}

export interface ChecklistFile {
  version: number;
  created_at: string;
  updated_at: string;
  /** Set exactly once, by finish() when every enabled step verifies green. */
  completed_at: string | null;
  choices: Record<string, unknown>;
  steps: Record<string, StepRecord>;
}

export function checklistPath(stateDir: string): string {
  return join(stateDir, "onboarding", "checklist.json");
}

/** The contract path: the companion's first-run greeting keys off this
 * file. Written once, by finish(), shape {"completed_at": "<iso>"}. */
export function firstRunMarkerPath(stateDir: string): string {
  return join(stateDir, "companion", "first-run.json");
}

/** Read the checklist; null when absent or unreadable (both mean "fresh"). */
export function readChecklist(stateDir: string): ChecklistFile | null {
  const path = checklistPath(stateDir);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof raw !== "object" || raw === null) return null;
    const file = raw as ChecklistFile;
    if (typeof file.version !== "number" || typeof file.steps !== "object" || file.steps === null) return null;
    return file;
  } catch {
    return null;
  }
}

/** Does the checklist file say onboarding finished? The CLI's post-exit
 * handoff reads exactly this (the finish tool only sets it after a full green
 * re-verification, so "the file says so" is a verified claim). */
export function checklistComplete(stateDir: string): boolean {
  return typeof readChecklist(stateDir)?.completed_at === "string";
}

/** tmp+rename atomic write, the same convention as the CLI's command files and
 * the shell posting receipts: a reader never sees a half-written file. */
function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${path.split("/").at(-1)}.tmp`);
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

// ---- engine -----------------------------------------------------------------

export interface StepStatusLine {
  id: string;
  title: string;
  explain: string;
  status: "pending" | "done" | "disabled";
  note: string | null;
}

export interface ReconcileReport {
  /** Claimed-done steps whose verify() held. */
  verified: string[];
  /** Claimed-done steps whose verify() failed — demoted to pending. */
  demoted: Array<{ id: string; failures: string[] }>;
}

export interface StepRunResult {
  id: string;
  ok: boolean;
  checks: CheckResult[];
  failures: string[];
}

export interface VerifyAllResult {
  ok: boolean;
  results: Array<{ id: string; ok: boolean; failures: string[] }>;
}

export type FinishResult =
  | { ok: true; completed_at: string; marker_written: boolean }
  | { ok: false; results: VerifyAllResult["results"] };

export class OnboardingEngine {
  private readonly registry: OnboardingStep[];
  private checklist: ChecklistFile;

  constructor(steps: OnboardingStep[], private readonly adapters: OnboardAdapters) {
    this.registry = [...steps].sort((a, b) => a.order - b.order);
    const loaded = readChecklist(adapters.paths.stateDir);
    if (loaded === null && existsSync(checklistPath(adapters.paths.stateDir))) {
      adapters.log?.("onboarding: checklist file unreadable — starting fresh (resume re-verifies against reality anyway)");
    }
    this.checklist = loaded ?? this.fresh();
  }

  private fresh(): ChecklistFile {
    const now = this.adapters.clock().toISOString();
    return { version: CHECKLIST_VERSION, created_at: now, updated_at: now, completed_at: null, choices: {}, steps: {} };
  }

  private save(): void {
    this.checklist.updated_at = this.adapters.clock().toISOString();
    writeAtomic(checklistPath(this.adapters.paths.stateDir), `${JSON.stringify(this.checklist, null, 2)}\n`);
  }

  private record(id: string): StepRecord {
    const existing = this.checklist.steps[id];
    if (existing) return existing;
    const created: StepRecord = { status: "pending", completed_at: null, verified_at: null, note: null, data: {} };
    this.checklist.steps[id] = created;
    return created;
  }

  private ctxFor(id: string, input: Record<string, unknown> = {}): StepContext {
    return {
      adapters: this.adapters,
      input,
      choices: this.checklist.choices,
      data: this.record(id).data,
      recordChoice: (key, value) => {
        this.checklist.choices[key] = value;
      },
    };
  }

  /** The registered steps, in order (later tickets' tools register off this). */
  stepDefs(): readonly OnboardingStep[] {
    return this.registry;
  }

  private enabled(step: OnboardingStep): boolean {
    return step.enabled ? step.enabled(this.checklist.choices) : true;
  }

  choices(): Readonly<Record<string, unknown>> {
    return this.checklist.choices;
  }

  isComplete(): boolean {
    return this.checklist.completed_at !== null;
  }

  list(): StepStatusLine[] {
    return this.registry.map((step) => {
      const rec = this.checklist.steps[step.id];
      return {
        id: step.id,
        title: step.title,
        explain: step.explain,
        status: this.enabled(step) ? (rec?.status ?? "pending") : "disabled",
        note: rec?.note ?? null,
      };
    });
  }

  /**
   * Resume: re-verify every enabled claimed-done step against reality. A step
   * whose verify() fails is DEMOTED to pending with the failures in its note —
   * the file's claim is never trusted alone. A fully-done checklist therefore
   * re-runs as verify-only. Persists once at the end.
   */
  async reconcile(): Promise<ReconcileReport> {
    const report: ReconcileReport = { verified: [], demoted: [] };
    for (const step of this.registry) {
      if (!this.enabled(step)) continue;
      const rec = this.checklist.steps[step.id];
      if (!rec || rec.status !== "done") continue;
      const outcome = await this.safeVerify(step);
      if (outcome.ok) {
        rec.verified_at = this.adapters.clock().toISOString();
        report.verified.push(step.id);
      } else {
        const fails = failures(outcome.checks);
        rec.status = "pending";
        rec.note = `re-verification failed: ${fails.join("; ") || "unknown"}`;
        report.demoted.push({ id: step.id, failures: fails });
      }
    }
    this.save();
    return report;
  }

  /** Run one step, optionally with the operator's answer (`input`, the pi
   * tool's params). Unknown/disabled ids are refusals-as-answers, never
   * throws (the caller is an LLM tool belt). Persists after the step. */
  async runStep(id: string, input: Record<string, unknown> = {}): Promise<StepRunResult> {
    const step = this.registry.find((s) => s.id === id);
    if (!step) {
      return { id, ok: false, checks: [], failures: [`unknown step "${id}" — known: ${this.registry.map((s) => s.id).join(", ")}`] };
    }
    if (!this.enabled(step)) {
      return { id, ok: false, checks: [], failures: [`step "${id}" is disabled by the recorded choices`] };
    }
    let report: StepReport;
    try {
      report = await step.run(this.ctxFor(id, input));
    } catch (err) {
      report = { ok: false, checks: [{ name: id, ok: false, detail: `step threw: ${String(err)}` }] };
    }
    const rec = this.record(id);
    if (report.data) rec.data = { ...rec.data, ...report.data };
    if (report.ok) {
      rec.status = "done";
      rec.completed_at = this.adapters.clock().toISOString();
      rec.verified_at = null;
      rec.note = null;
    } else {
      rec.status = "pending";
      rec.note = `last run failed: ${failures(report.checks).join("; ") || "unknown"}`;
    }
    this.save();
    return { id, ok: report.ok, checks: report.checks, failures: failures(report.checks) };
  }

  private async safeVerify(step: OnboardingStep): Promise<StepReport> {
    try {
      return await step.verify(this.ctxFor(step.id));
    } catch (err) {
      return { ok: false, checks: [{ name: step.id, ok: false, detail: `verify threw: ${String(err)}` }] };
    }
  }

  /**
   * Verify EVERY enabled step — done or not. A pending step whose verify()
   * holds is promoted to done (its outcome exists in reality, which is the
   * only truth the checklist mirrors); a done step whose verify() fails
   * reports red here (finish refuses) but demotion is reconcile()'s job.
   */
  async verifyAll(): Promise<VerifyAllResult> {
    const results: VerifyAllResult["results"] = [];
    for (const step of this.registry) {
      if (!this.enabled(step)) continue;
      const outcome = await this.safeVerify(step);
      const rec = this.record(step.id);
      if (outcome.ok) {
        rec.verified_at = this.adapters.clock().toISOString();
        if (rec.status !== "done") {
          rec.status = "done";
          rec.completed_at = rec.completed_at ?? rec.verified_at;
          rec.note = "verified green without a recorded run";
        }
      }
      results.push({ id: step.id, ok: outcome.ok, failures: failures(outcome.checks) });
    }
    this.save();
    return { ok: results.every((r) => r.ok), results };
  }

  /**
   * The finish tool's engine half: re-run the full verification checklist.
   * Anything red ⇒ refuse with the failures (the caller returns them as the
   * tool result and does NOT exit). All green ⇒ mark the checklist complete
   * and write the first-run marker — once: a marker already on disk is left
   * untouched, so the completed_at the companion greets on never moves.
   */
  async finish(): Promise<FinishResult> {
    const all = await this.verifyAll();
    if (!all.ok) return { ok: false, results: all.results };
    const completedAt = this.checklist.completed_at ?? this.adapters.clock().toISOString();
    this.checklist.completed_at = completedAt;
    this.save();
    const marker = firstRunMarkerPath(this.adapters.paths.stateDir);
    let markerWritten = false;
    if (!existsSync(marker)) {
      writeAtomic(marker, `${JSON.stringify({ completed_at: completedAt })}\n`);
      markerWritten = true;
    }
    return { ok: true, completed_at: completedAt, marker_written: markerWritten };
  }
}

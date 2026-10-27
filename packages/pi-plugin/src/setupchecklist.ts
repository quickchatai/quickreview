// The setup checklist: a step registry and the engine that walks it. Ordered
// steps, each with detect, run and verify, recorded in a checklist. ADR 0001
// makes this a public seam: the plugin's /qcr-setup is the checklist of the
// plugin's own steps (src/plugin/setup.ts), and the app's setup is that
// checklist with more steps registered onto it (the onboarding wizard,
// src/onboard/ in the app, and the home's first-run steps). The app's steps
// live on the app's registry only, so plain /qcr-setup never shows them.
//
// Nothing here touches the network, a process or pi: a step reaches the
// outside world through the adapters its host hands in (or the facts its own
// factory closed over), and the engine itself is fully drivable from tests.
//
// A step's three verbs:
//   - detect: is it already true? `{ found }` (what was found, for the
//     person: "@user · via gh") marks the step done without running it;
//     `{ missing }` says why not. A step without detect is never skipped.
//   - run: performs the step, with the person's answer as input.
//   - verify: re-checks its outcome against reality, safe to call any number
//     of times.
//
// Resumability contract (for a checklist kept in a file):
//   - checklist state persists after every step, tmp+rename atomic;
//   - a resume (reconcile) re-verifies every claimed-done step with its
//     verify(), never trusting the file alone;
//   - a fully-done checklist re-runs as verify-only (the checklist doubles as
//     a diagnostic);
//   - a corrupt/unreadable checklist degrades to a fresh one (the resume
//     re-verifies everything anyway), never a crash.
// A checklist kept in memory (`file: null`, /qcr-setup's) has the same
// behaviour for its lifetime and writes nothing.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

// ---- adapters ---------------------------------------------------------------

/** What the engine itself needs of its host. A host's own adapter set extends
 * it with what its steps need (the app's wizard adds fetch, a process runner,
 * paths…); a step that needs only this runs on any host's checklist. */
export interface ChecklistAdapters {
  clock: () => Date;
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

/** What detect() returns: already true (`found` says what was found, as the
 * person reads it), or not (`missing` says why, with the fix when it has
 * one). */
export type Detection = { found: string } | { missing: string };

export interface StepContext<A extends ChecklistAdapters = ChecklistAdapters> {
  adapters: A;
  /** The inputs of the call: the person's answer to a step that asks one
   * (`{}` for a step that declares no `parameters`, and always on verify()
   * and detect()). A step that needs an answer and does not get one must
   * return a refusal naming the options, never a guess. */
  input: Readonly<Record<string, unknown>>;
  /** Recorded choices (topology, auth route, captured uid, …). */
  choices: Readonly<Record<string, unknown>>;
  /** This step's persisted data from a previous run ({} on first run). */
  data: Readonly<Record<string, unknown>>;
  /** Record a choice / derived fact for later steps (persisted with the step
   * result). */
  recordChoice(key: string, value: unknown): void;
}

/** A step id: tool-name-safe, because a host may register each step as a
 * tool of its own (the wizard's `onboard_<id>`). */
export const STEP_ID_RE = /^[a-z][a-z0-9_]*$/;

/**
 * One setup step; the interface is the extension point:
 *   - `id` matches STEP_ID_RE and is unique on its registry;
 *   - `explain` is the teach-text a guide relays before running the step;
 *   - `enabled` gates on recorded choices; absent ⇒ always enabled;
 *   - `detect`, `run` and `verify` as the module header says.
 */
export interface SetupStep<A extends ChecklistAdapters = ChecklistAdapters> {
  id: string;
  title: string;
  explain: string;
  /** Ascending display/registration order. */
  order: number;
  /** JSON-schema object the step's tool declares, for steps that need the
   * person's answer (a choice, a hostname). Absent ⇒ the step takes no
   * input, which is the common case. */
  parameters?: unknown;
  enabled?(choices: Readonly<Record<string, unknown>>): boolean;
  /** The checklist completes without it: it still runs and verifies like any
   * other, but finish never waits on it. */
  optional?: boolean;
  detect?(ctx: StepContext<A>): Promise<Detection>;
  run(ctx: StepContext<A>): Promise<StepReport>;
  verify(ctx: StepContext<A>): Promise<StepReport>;
}

export function failures(checks: readonly CheckResult[]): string[] {
  return checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
}

// ---- the registry -----------------------------------------------------------

/** The steps one checklist walks, in `order` order. Each host keeps its own:
 * the plugin's /qcr-setup builds one of the plugin's steps, and the app
 * builds one of those steps plus its own, so a step the app registers never
 * reaches a plain /qcr-setup. */
export class StepRegistry<A extends ChecklistAdapters = ChecklistAdapters> {
  private readonly entries: SetupStep<A>[] = [];

  constructor(steps: Iterable<SetupStep<A>> = []) {
    for (const step of steps) this.register(step);
  }

  /** Add steps. An id that is not tool-name-safe, or one already registered,
   * throws: two steps under one id would share one checklist record. */
  register(...steps: SetupStep<A>[]): this {
    for (const step of steps) {
      if (!STEP_ID_RE.test(step.id))
        throw new Error(`setup step id ${JSON.stringify(step.id)} is not [a-z][a-z0-9_]*`);
      if (this.entries.some((s) => s.id === step.id))
        throw new Error(`setup step "${step.id}" is registered twice`);
      this.entries.push(step);
    }
    return this;
  }

  /** The registered steps in ascending `order` (registration order breaks a
   * tie). */
  steps(): SetupStep<A>[] {
    return [...this.entries].sort((a, b) => a.order - b.order);
  }
}

// ---- checklist file ---------------------------------------------------------

export const CHECKLIST_VERSION = 1;

export interface StepRecord {
  status: "pending" | "done";
  completed_at: string | null;
  /** Last successful re-verification (resume / finish / detect). */
  verified_at: string | null;
  /** Why a claimed-done step was demoted, why detect found it missing, or
   * other engine notes. */
  note: string | null;
  /** What detect() found when it marked the step done without a run; absent
   * once a run did it. */
  found?: string;
  data: Record<string, unknown>;
}

export interface ChecklistFile {
  version: number;
  created_at: string;
  updated_at: string;
  /** Set exactly once, by finish() when every enabled step verifies green.
   * History: when the checklist first finished; it never moves and never
   * clears. */
  completed_at: string | null;
  /** When a completed checklist stopped verifying (a demotion, a failed run,
   * a refused finish, a newly-enabled unfinished step, a step run again:
   * a run changes what the full verification checked); null/absent while the
   * completion still holds. A green finish() clears it. Whether the checklist
   * is complete now is `completed_at` set and this unset. */
  reopened_at?: string | null;
  choices: Record<string, unknown>;
  steps: Record<string, StepRecord>;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Read a checklist file; null when absent or unreadable (both mean
 * "fresh"). */
export function readChecklistFile(path: string): ChecklistFile | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof raw !== "object" || raw === null) return null;
    const file = raw as ChecklistFile;
    // Every field the engine dereferences is checked here: a file that parses
    // but lacks one (hand-edited, foreign) would otherwise throw out of a
    // step predicate or record() on every call: a wedge, not a fresh start.
    if (typeof file.version !== "number") return null;
    if (!isPlainObject(file.choices)) return null;
    if (file.completed_at !== null && typeof file.completed_at !== "string") return null;
    if (!isPlainObject(file.steps)) return null;
    for (const rec of Object.values(file.steps)) {
      if (!isPlainObject(rec) || !isPlainObject(rec.data)) return null;
    }
    return file;
  } catch {
    return null;
  }
}

/** Is the checklist complete NOW: finished once, and not reopened since. The
 * one reading of the two fields, for a file on disk and the engine's copy. */
export function checklistCompleteNow(
  file: Pick<ChecklistFile, "completed_at" | "reopened_at">,
): boolean {
  return typeof file.completed_at === "string" && !file.reopened_at;
}

/** tmp+rename atomic write: a reader never sees a half-written file, and an
 * interrupted write leaves the previous file whole. The checklist's writer,
 * and the one the app's setup steps write their files through. */
export function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.onboard.tmp`);
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

/** A file's text, or null when it cannot be read for any reason. For a read
 * where only ABSENCE may be null, read it yourself. */
export function readTextOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

// ---- engine -----------------------------------------------------------------

export interface StepStatusLine {
  id: string;
  title: string;
  explain: string;
  status: "pending" | "done" | "disabled";
  note: string | null;
  /** What detect() found, when that is how the step got done. */
  found?: string;
  /** The step's `optional` flag: the checklist completes without it. */
  optional?: boolean;
}

export interface ReconcileReport {
  /** Claimed-done steps whose verify() held. */
  verified: string[];
  /** Claimed-done steps whose verify() failed: demoted to pending. */
  demoted: Array<{ id: string; failures: string[] }>;
}

export interface DetectReport {
  /** One entry per enabled, not-yet-done step that has a detect(). */
  results: Array<{ id: string; found: string } | { id: string; missing: string }>;
}

export interface StepRunResult {
  id: string;
  ok: boolean;
  checks: CheckResult[];
  failures: string[];
}

export interface VerifyAllResult {
  ok: boolean;
  /** `optional` results are reported but never hold `ok` false. */
  results: Array<{ id: string; ok: boolean; failures: string[]; optional?: boolean }>;
}

export type ChecklistFinish =
  { ok: true; completed_at: string } | { ok: false; results: VerifyAllResult["results"] };

export interface ChecklistOptions {
  /** Where the checklist persists; null keeps it in memory only. */
  file: string | null;
}

export class SetupChecklist<A extends ChecklistAdapters = ChecklistAdapters> {
  private readonly registry: SetupStep<A>[];
  private checklist: ChecklistFile;
  private readonly file: string | null;

  constructor(
    steps: StepRegistry<A> | readonly SetupStep<A>[],
    protected readonly adapters: A,
    o: ChecklistOptions,
  ) {
    this.registry = (steps instanceof StepRegistry ? steps : new StepRegistry(steps)).steps();
    this.file = o.file;
    const loaded = o.file === null ? null : readChecklistFile(o.file);
    if (loaded === null && o.file !== null && existsSync(o.file)) {
      adapters.log?.(
        "setup checklist: the checklist file is unreadable, starting fresh (recorded choices and step progress were reset)",
      );
    }
    this.checklist = loaded ?? this.fresh();
  }

  private fresh(): ChecklistFile {
    const now = this.adapters.clock().toISOString();
    return {
      version: CHECKLIST_VERSION,
      created_at: now,
      updated_at: now,
      completed_at: null,
      choices: {},
      steps: {},
    };
  }

  private save(): void {
    this.checklist.updated_at = this.adapters.clock().toISOString();
    if (this.file !== null) writeAtomic(this.file, `${JSON.stringify(this.checklist, null, 2)}\n`);
  }

  private record(id: string): StepRecord {
    const existing = this.checklist.steps[id];
    if (existing) return existing;
    const created: StepRecord = {
      status: "pending",
      completed_at: null,
      verified_at: null,
      note: null,
      data: {},
    };
    this.checklist.steps[id] = created;
    return created;
  }

  private ctxFor(id: string, input: Record<string, unknown> = {}): StepContext<A> {
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

  /** The registered steps, in order (a host's tools register off this). */
  stepDefs(): readonly SetupStep<A>[] {
    return this.registry;
  }

  private enabled(step: SetupStep<A>): boolean {
    return step.enabled ? step.enabled(this.checklist.choices) : true;
  }

  choices(): Readonly<Record<string, unknown>> {
    return this.checklist.choices;
  }

  isComplete(): boolean {
    return checklistCompleteNow(this.checklist);
  }

  /** A completed checklist no longer verifies: withdraw the current-completion
   * claim without touching the history. */
  private reopen(): void {
    if (this.checklist.completed_at === null || this.checklist.reopened_at) return;
    this.checklist.reopened_at = this.adapters.clock().toISOString();
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
        ...(rec?.found !== undefined ? { found: rec.found } : {}),
        ...(step.optional ? { optional: true } : {}),
      };
    });
  }

  /**
   * Detect: ask every enabled, not-yet-done step that has a detect() whether
   * it is already true. A step that is is marked done with what was found,
   * and never runs; one that is not stays pending with why in its note. A
   * throwing detect is a "missing", never a throw. Persists once at the end.
   */
  async detect(): Promise<DetectReport> {
    const report: DetectReport = { results: [] };
    for (const step of this.registry) {
      if (!step.detect || !this.enabled(step)) continue;
      const rec = this.record(step.id);
      if (rec.status === "done") continue;
      let found: Detection;
      try {
        found = await step.detect(this.ctxFor(step.id));
      } catch (err) {
        found = { missing: `detect threw: ${String(err)}` };
      }
      if ("found" in found) {
        const now = this.adapters.clock().toISOString();
        rec.status = "done";
        rec.completed_at = now;
        rec.verified_at = now;
        rec.note = null;
        rec.found = found.found;
        report.results.push({ id: step.id, found: found.found });
      } else {
        rec.note = found.missing;
        this.reopen();
        report.results.push({ id: step.id, missing: found.missing });
      }
    }
    this.save();
    return report;
  }

  /**
   * Resume: re-verify every enabled claimed-done step against reality. A step
   * whose verify() fails is demoted to pending with the failures in its
   * note: the file's claim is never trusted alone. A fully-done checklist
   * therefore re-runs as verify-only. Persists once at the end.
   */
  async reconcile(): Promise<ReconcileReport> {
    const report: ReconcileReport = { verified: [], demoted: [] };
    for (const step of this.registry) {
      if (!this.enabled(step)) continue;
      const rec = this.checklist.steps[step.id];
      if (!rec || rec.status !== "done") {
        this.reopen();
        continue;
      }
      const outcome = await this.safeVerify(step);
      if (outcome.ok) {
        rec.verified_at = this.adapters.clock().toISOString();
        report.verified.push(step.id);
      } else {
        const fails = failures(outcome.checks);
        rec.status = "pending";
        rec.note = `re-verification failed: ${fails.join("; ") || "unknown"}`;
        this.reopen();
        report.demoted.push({ id: step.id, failures: fails });
      }
    }
    this.save();
    return report;
  }

  /** Run one step, optionally with the person's answer (`input`, the tool's
   * params). Unknown/disabled ids are refusals-as-answers, never throws (the
   * caller may be an LLM tool belt). Persists after the step. */
  async runStep(id: string, input: Record<string, unknown> = {}): Promise<StepRunResult> {
    const step = this.registry.find((s) => s.id === id);
    if (!step) {
      return {
        id,
        ok: false,
        checks: [],
        failures: [`unknown step "${id}" — known: ${this.registry.map((s) => s.id).join(", ")}`],
      };
    }
    if (!this.enabled(step)) {
      return {
        id,
        ok: false,
        checks: [],
        failures: [`step "${id}" is disabled by the recorded choices`],
      };
    }
    const rec = this.record(id);
    rec.status = "pending";
    delete rec.found;
    this.reopen();
    this.save();
    let report: StepReport;
    try {
      report = await step.run(this.ctxFor(id, input));
    } catch (err) {
      report = {
        ok: false,
        checks: [{ name: id, ok: false, detail: `step threw: ${String(err)}` }],
      };
    }
    if (report.data) rec.data = { ...rec.data, ...report.data };
    if (report.ok) {
      rec.status = "done";
      rec.completed_at = this.adapters.clock().toISOString();
      rec.verified_at = null;
      rec.note = null;
      // A run acts on the installation (choices, config, deploys) after the
      // full verification that backed the completion claim: only the next
      // green finish() may make that claim again.
      this.reopen();
    } else {
      rec.status = "pending";
      rec.note = `last run failed: ${failures(report.checks).join("; ") || "unknown"}`;
      this.reopen();
    }
    this.save();
    return { id, ok: report.ok, checks: report.checks, failures: failures(report.checks) };
  }

  private async safeVerify(step: SetupStep<A>): Promise<StepReport> {
    try {
      return await step.verify(this.ctxFor(step.id));
    } catch (err) {
      return {
        ok: false,
        checks: [{ name: step.id, ok: false, detail: `verify threw: ${String(err)}` }],
      };
    }
  }

  /**
   * Verify every enabled step, done or not. A pending step whose verify()
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
      results.push({
        id: step.id,
        ok: outcome.ok,
        failures: failures(outcome.checks),
        ...(step.optional ? { optional: true } : {}),
      });
    }
    this.save();
    return { ok: results.every((r) => r.ok || r.optional === true), results };
  }

  /**
   * Re-run the full verification. Anything red ⇒ refuse with the failures.
   * All green ⇒ mark the checklist complete; `completed_at` is set once and
   * never moves. A host that marks its own first finish (the app's first-run
   * marker) does so on top of this.
   */
  async finish(): Promise<ChecklistFinish> {
    const all = await this.verifyAll();
    if (!all.ok) {
      this.reopen();
      this.save();
      return { ok: false, results: all.results };
    }
    const completedAt = this.checklist.completed_at ?? this.adapters.clock().toISOString();
    this.checklist.completed_at = completedAt;
    this.checklist.reopened_at = null;
    this.save();
    return { ok: true, completed_at: completedAt };
  }
}

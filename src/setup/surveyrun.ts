// The survey RUN: the stateful half behind the setup engine's
// survey verbs — preview, start, status, stop. The rules (what is read, what
// it costs, the lens's grammar, the memory spelling) are survey.ts's; this
// file owns the effects, every one through a SetupEngine port.
//
// Three promises, each of them structural:
//   * NOTHING RUNS UNSEEN. `start` must quote the key `preview` handed out;
//     a plan (or a head) that moved since is refused, so the operator always
//     saw the cases and the price of what runs.
//   * NOTHING RUNS UNASKED. There is no timer and no trigger here: a survey
//     starts only from a start call, and once one has completed a start is
//     refused unless it says `resurvey` — the companion asks the operator
//     first. An interrupted run is not "completed" and may simply be started
//     again.
//   * THE COMPANION STAYS RESPONSIVE. `start` persists the run and returns;
//     the cases run in the background through the case runner (background pi
//     subagents), at most `concurrency` at once, and `status` reads the
//     progress. A background failure is recorded on the run, never thrown —
//     an unhandled rejection would take the companion's pi down with it.
//
// Supersession: every note is written as its case finishes (a stopped run
// keeps what it read). The survey memory live when the run starts is read
// once; a unit's entries among it — any run but this one — are retired once
// ALL of that unit's cases finished and every note of
// theirs was written; a unit whose read failed keeps its old entries, since
// stale is better than none. When the whole run completes, whatever survey
// memory is left from earlier runs (units since removed from the cut) goes
// too. Retire, never delete: the timeline keeps the history.
//
// Persistence: `<state home>/setup/survey.json` — the current run, the last
// COMPLETED run's summary (what makes a re-survey a re-survey) and the rate
// measured from finished cases (what later previews price with).
import type { Refusal, SetupPorts } from "./engine.js";
import {
  REFERENCE_RATE,
  SURVEY_AGENT,
  SURVEY_TAG,
  caseEstimate,
  measuredRate,
  parseSurveyNotes,
  planEstimate,
  planKey,
  planSurvey,
  surveyEntryTags,
  surveyMemoryText,
  surveyPrompt,
  type PlanInput,
  type SurveyCasePlan,
  type SurveyPlan,
  type SurveyRate,
} from "./survey.js";
import { refOf, type MemoryEntry } from "../memory/store.js";

export const SURVEY_FILE = "setup/survey.json";
export const SURVEY_VERSION = 1;

/** Cases in flight at once when the caller does not say (the companion
 * passes its subagent cap). */
export const DEFAULT_SURVEY_CONCURRENCY = 4;

export type CaseStatus = "pending" | "running" | "done" | "failed" | "stopped";
export type RunState = "running" | "complete" | "partial" | "stopped";

export interface SurveyCaseState {
  id: string;
  unit: string;
  stage: "repo" | "unit";
  files: string[];
  lines: number;
  status: CaseStatus;
  notes_written: number;
  /** Notes the store refused — a unit with any keeps its older entries. */
  notes_failed: number;
  /** Notes past the per-case cap, or cut at the length cap. */
  notes_dropped: number;
  notes_truncated: number;
  /** The lens answered NONE. */
  none: boolean;
  cost_usd: number | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface SurveyRun {
  id: string;
  started_at: string;
  finished_at: string | null;
  head: string | null;
  plan_key: string;
  estimate_usd: number;
  rate_basis: string;
  resurvey: boolean;
  state: RunState;
  cases: SurveyCaseState[];
  unsampled: string[];
  /** Earlier `#survey` entries this run retired. */
  superseded: number;
  problems: string[];
}

export interface CompletedSurvey {
  id: string;
  finished_at: string;
  head: string | null;
  notes: number;
  cost_usd: number | null;
}

export interface SurveyFile {
  version: number;
  current: SurveyRun | null;
  last_complete: CompletedSurvey | null;
  rate: SurveyRate | null;
}

export interface SurveyPreview {
  key: string;
  head: string | null;
  cases: Array<SurveyCasePlan & { estimate_usd: number }>;
  unsampled: string[];
  lines: number;
  estimate_usd: number;
  rate: SurveyRate;
  concurrency: number;
  /** Live `#survey` entries a completed run would supersede; null when
   * memory could not be read (or there is none). */
  existing_entries: number | null;
  last_complete: CompletedSurvey | null;
  /** A survey already completed — a start must say `resurvey`. */
  needs_resurvey: boolean;
  /** Why a start would be refused regardless of the key (no memory). */
  blockers: string[];
}

export interface SurveyStatus {
  ok: boolean;
  problems: string[];
  /** The latest run; `display` is `interrupted` for a run the file says is
   * running that no process here is driving (the companion restarted). */
  run: (SurveyRun & { display: RunState | "interrupted" }) | null;
  last_complete: CompletedSurvey | null;
  active: boolean;
}

/** What the engine hands the run: the plan input over the saved cut, or why
 * there is none. */
export type SurveyInputs = { ok: true; input: PlanInput; head: string | null } | Refusal;

export interface SurveyRunOptions {
  concurrency?: number;
  /** Where the lens finds the checkout (the RepoReader's location). */
  repoRoot: string;
}

interface LiveSurveyEntry {
  entry: MemoryEntry;
  unit: string | null;
  run: string | null;
}

const clean = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export class SurveyRunner {
  private active: { id: string; abort: AbortController; done: Promise<void> } | null = null;
  private readonly concurrency: number;

  constructor(
    private readonly ports: SetupPorts,
    private readonly inputs: () => SurveyInputs,
    private readonly opts: SurveyRunOptions,
  ) {
    this.concurrency = Math.max(1, Math.floor(opts.concurrency ?? DEFAULT_SURVEY_CONCURRENCY));
  }

  // -- the file --

  private load(): { file: SurveyFile; error: string | null } {
    const empty: SurveyFile = { version: SURVEY_VERSION, current: null, last_complete: null, rate: null };
    let text: string | null;
    try {
      text = this.ports.state.read(SURVEY_FILE);
    } catch (err) {
      return { file: empty, error: `${SURVEY_FILE} in ${this.ports.state.location} cannot be read: ${clean(err)}` };
    }
    if (text === null) return { file: empty, error: null };
    try {
      const raw = JSON.parse(text) as Partial<SurveyFile> | null;
      if (typeof raw !== "object" || raw === null || raw.version !== SURVEY_VERSION) {
        throw new Error(`unknown version ${JSON.stringify(raw?.version)}`);
      }
      const current = raw.current ?? null;
      if (current !== null && (typeof current !== "object" || !Array.isArray(current.cases))) {
        throw new Error("`current` is not a survey run");
      }
      return {
        file: { version: SURVEY_VERSION, current, last_complete: raw.last_complete ?? null, rate: raw.rate ?? null },
        error: null,
      };
    } catch (err) {
      return {
        file: empty,
        error:
          `${SURVEY_FILE} in ${this.ports.state.location} is not a survey record this version reads (${clean(err)}) — ` +
          "nothing will overwrite it; move it aside to survey again",
      };
    }
  }

  private store(file: SurveyFile): void {
    this.ports.state.write(SURVEY_FILE, `${JSON.stringify(file, null, 2)}\n`);
  }

  // -- the plan --

  private plan(): { ok: true; plan: SurveyPlan; head: string | null } | Refusal {
    const got = this.inputs();
    if (!got.ok) return got;
    return { ok: true, plan: planSurvey(got.input), head: got.head };
  }

  /** Live survey entries in memory, or null when there is no memory or it
   * could not be read. */
  private async surveyEntries(): Promise<LiveSurveyEntry[] | null> {
    const memory = this.ports.memory;
    if (memory === null) return null;
    let entries: MemoryEntry[];
    try {
      entries = await memory.search("", { tag: SURVEY_TAG });
    } catch {
      return null;
    }
    return entries.flatMap((e) => {
      const tags = surveyEntryTags(e);
      return tags === null ? [] : [{ entry: e, ...tags }];
    });
  }

  // -- the four verbs --

  /** What a survey would read and cost now, and the key a start must quote. */
  async preview(): Promise<{ ok: true; preview: SurveyPreview } | Refusal> {
    const p = this.plan();
    if (!p.ok) return p;
    const { file, error } = this.load();
    if (error !== null) return { ok: false, errors: [error] };
    const rate = file.rate ?? REFERENCE_RATE;
    const existing = await this.surveyEntries();
    const blockers: string[] = [];
    if (this.ports.memory === null) blockers.push(noMemory());
    if (p.plan.cases.length === 0) blockers.push("there is nothing to survey: no directive files, design docs or code to sample");
    return {
      ok: true,
      preview: {
        key: planKey(p.plan, p.head),
        head: p.head,
        cases: p.plan.cases.map((c) => ({ ...c, estimate_usd: caseEstimate(c.lines, rate) })),
        unsampled: p.plan.unsampled,
        lines: p.plan.lines,
        estimate_usd: planEstimate(p.plan, rate),
        rate,
        concurrency: this.concurrency,
        existing_entries: existing === null ? null : existing.length,
        last_complete: file.last_complete,
        needs_resurvey: file.last_complete !== null,
        blockers,
      },
    };
  }

  /**
   * Start the survey the preview showed, in the background. Refused when the
   * key is not the current plan's, when a survey is already running here,
   * when one has completed and this is not a `resurvey`, or when there is no
   * memory to write into.
   */
  async start(args: { key?: unknown; resurvey?: unknown }): Promise<{ ok: true; run: SurveyRun } | Refusal> {
    if (this.active) return { ok: false, errors: [`survey ${this.active.id} is still running — stop it or wait for it`] };
    const memory = this.ports.memory;
    if (memory === null) return { ok: false, errors: [noMemory()] };
    const p = this.plan();
    if (!p.ok) return p;
    const key = planKey(p.plan, p.head);
    if (typeof args.key !== "string" || args.key === "") {
      return { ok: false, errors: ["no preview key — run the survey preview, show the operator the cost, then start with its key"] };
    }
    if (args.key !== key) {
      return {
        ok: false,
        errors: [`the plan changed since that preview (key ${args.key}, now ${key}) — preview again and show the operator the new cost`],
      };
    }
    if (p.plan.cases.length === 0) return { ok: false, errors: ["there is nothing to survey"] };
    const { file, error } = this.load();
    if (error !== null) return { ok: false, errors: [error] };
    const resurvey = args.resurvey === true;
    if (file.last_complete !== null && !resurvey) {
      return {
        ok: false,
        errors: [
          `a survey already completed (${file.last_complete.id}, ${file.last_complete.finished_at}); a re-survey supersedes its ` +
            "memory — run one only when the operator asks, with resurvey: true",
        ],
      };
    }
    if (memory.ensureWritable) {
      const ready = await memory.ensureWritable();
      if (!ready.ok) return { ok: false, errors: [`reviewer memory is not writable: ${ready.message}`] };
    }

    const now = this.ports.clock();
    const rate = file.rate ?? REFERENCE_RATE;
    const run: SurveyRun = {
      id: `survey-${now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`,
      started_at: now.toISOString(),
      finished_at: null,
      head: p.head,
      plan_key: key,
      estimate_usd: planEstimate(p.plan, rate),
      rate_basis: rate.basis,
      resurvey,
      state: "running",
      cases: p.plan.cases.map((c) => ({
        id: c.id,
        unit: c.unit,
        stage: c.stage,
        files: c.files.map((f) => f.path),
        lines: c.lines,
        status: "pending",
        notes_written: 0,
        notes_failed: 0,
        notes_dropped: 0,
        notes_truncated: 0,
        none: false,
        cost_usd: null,
        error: null,
        started_at: null,
        finished_at: null,
      })),
      unsampled: p.plan.unsampled,
      superseded: 0,
      problems: [],
    };
    file.current = run;
    this.store(file);

    const abort = new AbortController();
    const done = this.drive(file, run, p.plan, abort.signal)
      .catch((err: unknown) => {
        // Belt: drive() records its own failures; this catches a bug in it.
        run.problems.push(`the survey stopped on an internal error: ${clean(err)}`);
        this.settle(file, run, "partial");
        this.ports.log?.(`setup: survey ${run.id} failed: ${clean(err)}`);
      })
      .finally(() => {
        if (this.active?.id === run.id) this.active = null;
      });
    this.active = { id: run.id, abort, done };
    return { ok: true, run };
  }

  /** The latest run and the last completed one. */
  status(): SurveyStatus {
    const { file, error } = this.load();
    const run = file.current;
    return {
      ok: error === null,
      problems: error === null ? [] : [error],
      run:
        run === null
          ? null
          : { ...run, display: run.state === "running" && this.active?.id !== run.id ? "interrupted" : run.state },
      last_complete: file.last_complete,
      active: this.active !== null,
    };
  }

  /** Stop the running survey: in-flight cases are aborted, pending ones
   * never start; notes already written stay. */
  stop(): { ok: true; id: string } | Refusal {
    if (!this.active) return { ok: false, errors: ["no survey is running in this companion"] };
    this.active.abort.abort();
    return { ok: true, id: this.active.id };
  }

  /** Resolves when no survey is running (tests; a clean shutdown). */
  async idle(): Promise<void> {
    await this.active?.done;
  }

  // -- the background run --

  private async drive(file: SurveyFile, run: SurveyRun, plan: SurveyPlan, signal: AbortSignal): Promise<void> {
    // What this run may supersede: the survey memory that was live before it
    // wrote anything — read ONCE, not per unit (a sweep reads every entry).
    const earlier = await this.surveyEntries();
    if (earlier === null) {
      run.problems.push("could not read memory to supersede earlier survey entries — they stay live");
    }
    const ctx = { file, run, signal, earlier: earlier ?? [] };
    const repoCases = plan.cases.filter((c) => c.stage === "repo");
    const unitCases = plan.cases.filter((c) => c.stage === "unit");
    const repoNotes: string[] = [];
    let repoFinished = true;
    await this.pool(repoCases, async (c) => {
      const notes = await this.runCase(ctx, c, null);
      if (notes === null) repoFinished = false;
      else repoNotes.push(...notes);
    });
    await this.pool(unitCases, (c) => this.runCase(ctx, c, repoFinished ? repoNotes : null));

    if (signal.aborted) {
      for (const c of run.cases) if (c.status === "pending") c.status = "stopped";
      this.settle(file, run, "stopped");
      return;
    }
    const complete = run.cases.every((c) => c.status === "done" && c.notes_failed === 0);
    if (complete) {
      // Whatever earlier survey memory is still live belongs to a unit this
      // cut no longer has (or to @repo parts that no longer exist).
      await this.supersede(run, ctx.earlier, () => true);
    }
    this.settle(file, run, complete ? "complete" : "partial");
  }

  /** Run `work` over `items`, at most `concurrency` at once, never past an
   * abort. */
  private async pool<T>(items: readonly T[], work: (item: T) => Promise<unknown>): Promise<void> {
    let next = 0;
    const lane = async (): Promise<void> => {
      while (next < items.length) {
        const item = items[next++]!;
        await work(item);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, items.length) }, lane));
  }

  /** One case, start to finish. Resolves with the note texts it wrote (for
   * stage 1's hand-over), or null when it did not finish. */
  private async runCase(
    ctx: { file: SurveyFile; run: SurveyRun; signal: AbortSignal; earlier: LiveSurveyEntry[] },
    plan: SurveyCasePlan,
    repoNotes: string[] | null,
  ): Promise<string[] | null> {
    const { file, run, signal } = ctx;
    const c = run.cases.find((x) => x.id === plan.id)!;
    if (signal.aborted) {
      c.status = "stopped";
      this.store(file);
      return null;
    }
    c.status = "running";
    c.started_at = this.ports.clock().toISOString();
    this.store(file);

    let outcome;
    try {
      outcome = await this.ports.cases.run(
        {
          id: `${run.id}/${plan.id}`,
          unit: plan.unit,
          agent: SURVEY_AGENT,
          files: plan.files.map((f) => f.path),
          prompt: surveyPrompt(plan, { repoRoot: this.opts.repoRoot, head: run.head, repoNotes }),
        },
        signal,
      );
    } catch (err) {
      outcome = { ok: false as const, reason: `the case runner threw: ${clean(err)}` };
    }
    c.finished_at = this.ports.clock().toISOString();
    if (!outcome.ok) {
      c.status = signal.aborted ? "stopped" : "failed";
      c.error = outcome.reason;
      this.store(file);
      return null;
    }
    c.cost_usd = outcome.cost_usd;
    const parsed = parseSurveyNotes(outcome.output);
    c.none = parsed.none;
    c.notes_dropped = parsed.dropped;
    c.notes_truncated = parsed.truncated;
    const written: string[] = [];
    for (const note of parsed.notes) {
      const r = await this.write(surveyMemoryText(note, plan.unit, run.id, run.head));
      if (r.ok) {
        c.notes_written++;
        written.push(`[${note.kind}] ${note.text}`);
      } else {
        c.notes_failed++;
        c.error = `memory refused a note: ${r.message}`;
      }
    }
    c.status = "done";
    this.store(file);

    // Supersede the unit's earlier entries once all of its cases are in and
    // every note landed; a partial read keeps them.
    const mine = run.cases.filter((x) => x.unit === plan.unit);
    if (mine.every((x) => x.status === "done" && x.notes_failed === 0)) {
      await this.supersede(run, ctx.earlier, (unit) => unit === plan.unit);
      this.store(file);
    }
    return written;
  }

  private async write(text: string): Promise<{ ok: boolean; message: string }> {
    try {
      return await this.ports.memory!.apply({ op: "note", text });
    } catch (err) {
      return { ok: false, message: clean(err) };
    }
  }

  /** Retire the `earlier` entries (of any other run) whose unit `which`
   * picks, taking each out of `earlier` so none is retired twice. */
  private async supersede(
    run: SurveyRun,
    earlier: LiveSurveyEntry[],
    which: (unit: string | null) => boolean,
  ): Promise<void> {
    for (const e of [...earlier]) {
      if (e.run === run.id || !which(e.unit)) continue;
      earlier.splice(earlier.indexOf(e), 1);
      let r: { ok: boolean; message: string };
      try {
        r = await this.ports.memory!.apply({ op: "retire", ...refOf(e.entry) });
      } catch (err) {
        r = { ok: false, message: clean(err) };
      }
      if (r.ok) run.superseded++;
      else run.problems.push(`could not retire an earlier survey entry (${e.entry.id}): ${r.message}`);
    }
  }

  private settle(file: SurveyFile, run: SurveyRun, state: RunState): void {
    run.state = state;
    run.finished_at = this.ports.clock().toISOString();
    const measured = measuredRate(run.cases.filter((c) => c.status === "done"));
    if (measured) file.rate = measured;
    if (state === "complete") {
      const costs = run.cases.map((c) => c.cost_usd);
      file.last_complete = {
        id: run.id,
        finished_at: run.finished_at,
        head: run.head,
        notes: run.cases.reduce((n, c) => n + c.notes_written, 0),
        cost_usd: costs.every((x) => x !== null) ? costs.reduce((n, x) => n + x!, 0) : null,
      };
    }
    try {
      this.store(file);
    } catch (err) {
      this.ports.log?.(`setup: could not record survey ${run.id}: ${clean(err)}`);
    }
  }
}

function noMemory(): string {
  return (
    "survey notes are written to reviewer memory, and this companion has no memory store " +
    "(OPENVIKING_URL and OPENVIKING_REVIEWER_KEY must both be set)"
  );
}

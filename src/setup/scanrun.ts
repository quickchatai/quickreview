// Scan stage 1's RUN: preview, start, status, stop — the stateful
// half behind the companion's `scan_*` tools. The rules are scan.ts's; the
// records are ledger.ts's and findings.ts's; every effect goes through a port.
//
// Four promises, each structural:
//   * NOTHING RUNS UNSEEN. `start` must quote the key `preview` handed out; a
//     plan, sha, price or setting that moved since is refused, so the
//     operator always saw the cases and the price of what runs.
//   * THE FIRST SCAN CALIBRATES. With no measured price for this lens at
//     these settings, a preview offers only the CALIBRATION run — one case
//     from each of `[scan] calibration_units` units spread across the size
//     range, stopped hard at `calibration_max_usd`. Its cases are real stage-1
//     work (their findings and ledger rows count); what it adds is the price.
//     Every later preview is priced from the ledger's actual costs.
//   * HARD STOP AT THE ESTIMATE. The run's cap is the estimate the operator
//     approved (the calibration cap, for a calibration run). A case starts
//     only while what is spent, plus the estimates of the cases in flight,
//     plus its own estimate stays within the cap; the moment spending reaches
//     the cap, every case still in flight is aborted and the run ends
//     `capped`. What it did not read stays out of the ledger, so the next
//     preview prices exactly the rest.
//   * STOP AND RESUME BY THE LEDGER. `stop` aborts in-flight cases and starts
//     no more. A run the companion was not there to finish (a TUI quit, an
//     expired login) reads as `interrupted`. Either way, only FINISHED cases
//     wrote ledger rows, so starting again reads only what is left.
//
// Where a case runs: background pi subagents inside the companion (the case
// runner port), from the scan agent build — `pass-scan`, and the validator
// when `[scan] validator` is on, both built with the scan-mode anchor
// addendum. The tree they read is the reviewed checkout AT THE CHOSEN SHA,
// materialised read-only by the source port; the sha is recorded on every
// ledger row and finding.
//
// Persistence: `<state home>/scan/run.json` (the current run and a short
// history), `scan/suggestions.json` (stage 1's deep-lens suggestions, the
// input to stage 2), beside the ledger and the findings store.
import type { PassTier } from "../types.js";
import type { ScanConfig } from "../config.js";
import type { CaseOutcome, CaseRunner, Refusal, StateFs } from "./engine.js";
import { FindingsStore, type ReportedFinding } from "./findings.js";
import { casesFor, coveredBy, Ledger, measuredRate, type LedgerEntry, type RateKey } from "./ledger.js";
import {
  anchoredLines,
  calibrationCases,
  caseEstimate,
  findingFingerprint,
  normalizeCode,
  parseScanAnswer,
  parseValidatorAnswer,
  planKey,
  planStage1,
  scanCasePrompt,
  scanValidatorPrompt,
  SCAN_PASS,
  type ExclusionReason,
  type ScanCandidate,
  type ScanCasePlan,
  type ScanRate,
  type ScanSuggestion,
  type TreeFile,
} from "./scan.js";
import type { UnitCut } from "./unitcut.js";

// ---- ports ---------------------------------------------------------------------

/** The repository at one sha, materialised where the lenses read it. */
export interface ScanTree {
  sha: string;
  /** Absolute path of the materialised tree — what the lens is told. */
  root: string;
  files: TreeFile[];
  read(path: string): string | null;
  lines(path: string): number | null;
}

/** The reviewed checkout as a source of trees (READ-ONLY). */
export interface ScanSource {
  readonly location: string;
  /** The full commit sha `ref` names, or null (unknown ref, no checkout). */
  resolve(ref: string): string | null;
  /** The tree at `sha`, materialised; earlier trees other than `keep` may be
   * removed to bound the disk. */
  open(sha: string, keep: readonly string[]): { ok: true; tree: ScanTree } | { ok: false; reason: string };
}

/** The resolved settings a scan runs with: `config.toml [scan]` under the
 * profile's `[scan]` (the profile wins), and the validator's tier. */
export interface ScanSettings {
  scan: ScanConfig;
  validateTier: PassTier;
}

export interface ScanPorts {
  state: StateFs;
  clock: () => Date;
  /** Runs one case as background subagents, from the scan agent build. */
  cases: CaseRunner;
  source: ScanSource;
  /** The SAVED unit cut (the engine's), or why there is none. */
  savedCut: () => { ok: true; cut: UnitCut } | Refusal;
  settings: () => { ok: true; settings: ScanSettings } | Refusal;
  /** (Re)build the scan agents where `cases` reads them. */
  buildAgents: (settings: ScanSettings) => { ok: true } | Refusal;
  log?: (line: string) => void;
}

// ---- records -------------------------------------------------------------------

export const RUN_FILE = "scan/run.json";
export const SUGGESTIONS_FILE = "scan/suggestions.json";
export const RUN_VERSION = 1;
/** Summaries of finished runs kept beside the current one. */
export const RUN_HISTORY = 20;

export type ScanMode = "calibration" | "stage1";
export type ScanCaseStatus = "pending" | "running" | "done" | "failed" | "stopped" | "skipped";
export type ScanRunState = "running" | "complete" | "partial" | "stopped" | "capped";

export interface ScanCaseState {
  id: string;
  unit: string;
  part: number;
  parts: number;
  files: string[];
  lines: number;
  estimate_usd: number | null;
  status: ScanCaseStatus;
  /** Stage 1 plus the validator; null when the runner could not price it. */
  cost_usd: number | null;
  findings: number;
  /** Findings the validator doubted — kept, marked "may not be valid". */
  doubted: number;
  /** Answer items that could not be read or anchored. */
  dropped: number;
  suggestions: ScanSuggestion[];
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface ScanRun {
  id: string;
  mode: ScanMode;
  sha: string;
  plan_key: string;
  started_at: string;
  finished_at: string | null;
  state: ScanRunState;
  /** The hard stop: the approved estimate, or the calibration cap. */
  cap_usd: number;
  estimate_usd: number | null;
  /** Priced cost, plus the estimate of every case that finished unpriced. */
  spent_usd: number;
  unpriced_cases: number;
  settings: { tier: PassTier; effort: string; validator: boolean; validate_tier: PassTier | null };
  cases: ScanCaseState[];
  problems: string[];
}

export interface ScanRunSummary {
  id: string;
  mode: ScanMode;
  sha: string;
  state: ScanRunState | "interrupted";
  started_at: string;
  finished_at: string | null;
  cases_done: number;
  cases: number;
  findings: number;
  spent_usd: number;
}

interface RunFile {
  version: number;
  current: ScanRun | null;
  history: ScanRunSummary[];
}

export interface StoredSuggestion extends ScanSuggestion {
  unit: string;
  sha: string;
  run: string;
  at: string;
}

// ---- views ---------------------------------------------------------------------

export interface ScanPreview {
  key: string;
  mode: ScanMode;
  sha: string;
  cases: Array<ScanCasePlan & { estimate_usd: number | null }>;
  files: number;
  lines: number;
  /** Null for a calibration run: that is what it measures. */
  estimate_usd: number | null;
  /** The run would stop hard here. */
  cap_usd: number;
  rate: ScanRate | null;
  /** Priced cases the rate stands on, and how many calibration wants. */
  calibration: { measured: number; wanted: number };
  /** Stage-1 cases left after this run (all of them, for a calibration). */
  remaining_cases: number;
  excluded: Record<ExclusionReason, number>;
  covered: number;
  unassigned: string[];
  unreadable: number;
  settings: ScanRun["settings"] & { exclude: string[]; concurrency: number };
  /** Why a start would be refused whatever the key. */
  blockers: string[];
}

export interface ScanStatus {
  ok: boolean;
  problems: string[];
  run: (ScanRun & { display: ScanRunState | "interrupted" }) | null;
  active: boolean;
  history: ScanRunSummary[];
  ledger: { files: number; cost_usd: number } | null;
}

const EPS = 1e-9;
const clean = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const stage1Agent = (tier: PassTier): string => `${SCAN_PASS}--${tier}`;
const validatorAgent = (tier: PassTier): string => `pass-validate--${tier}`;

interface Planned {
  preview: ScanPreview;
  tree: ScanTree;
  settings: ScanSettings;
}

export class ScanRunner {
  private active: { id: string; sha: string; abort: AbortController; done: Promise<void> } | null = null;
  private readonly ledger: Ledger;
  private readonly findings: FindingsStore;

  constructor(private readonly ports: ScanPorts) {
    this.ledger = new Ledger(ports.state);
    this.findings = new FindingsStore(ports.state);
  }

  // -- the run file --

  private load(): { file: RunFile; error: string | null } {
    const empty: RunFile = { version: RUN_VERSION, current: null, history: [] };
    let text: string | null;
    try {
      text = this.ports.state.read(RUN_FILE);
    } catch (err) {
      return { file: empty, error: `${RUN_FILE} in ${this.ports.state.location} cannot be read: ${clean(err)}` };
    }
    if (text === null) return { file: empty, error: null };
    try {
      const raw = JSON.parse(text) as Partial<RunFile> | null;
      if (typeof raw !== "object" || raw === null || raw.version !== RUN_VERSION) throw new Error("unknown version");
      const current = raw.current ?? null;
      if (current !== null && (typeof current !== "object" || !Array.isArray(current.cases))) {
        throw new Error("`current` is not a scan run");
      }
      return { file: { version: RUN_VERSION, current, history: Array.isArray(raw.history) ? raw.history : [] }, error: null };
    } catch (err) {
      return {
        file: empty,
        error: `${RUN_FILE} in ${this.ports.state.location} is not a scan record this version reads (${clean(err)}) — nothing will overwrite it; move it aside to scan again`,
      };
    }
  }

  private store(file: RunFile): void {
    this.ports.state.write(RUN_FILE, `${JSON.stringify(file, null, 1)}\n`);
  }

  private summary(run: ScanRun, state: ScanRunSummary["state"]): ScanRunSummary {
    return {
      id: run.id,
      mode: run.mode,
      sha: run.sha,
      state,
      started_at: run.started_at,
      finished_at: run.finished_at,
      cases_done: run.cases.filter((c) => c.status === "done").length,
      cases: run.cases.length,
      findings: run.cases.reduce((n, c) => n + c.findings, 0),
      spent_usd: run.spent_usd,
    };
  }

  // -- the plan --

  private async plan(ref: string | undefined): Promise<{ ok: true; planned: Planned } | Refusal> {
    const s = this.ports.settings();
    if (!s.ok) return s;
    const cut = this.ports.savedCut();
    if (!cut.ok) return cut;
    const wanted = (ref ?? "").trim() || "HEAD";
    const sha = this.ports.source.resolve(wanted);
    if (sha === null) return { ok: false, errors: [`${JSON.stringify(wanted)} names no commit in ${this.ports.source.location}`] };
    const opened = this.ports.source.open(sha, this.active ? [this.active.sha] : []);
    if (!opened.ok) return { ok: false, errors: [`cannot read the tree at ${sha.slice(0, 12)}: ${opened.reason}`] };
    const tree = opened.tree;
    const { entries, error } = this.ledger.load();
    if (error !== null) return { ok: false, errors: [error] };
    const settings = s.settings;
    const cfg = settings.scan;
    const plan = planStage1({
      cut: cut.cut,
      files: tree.files,
      linesOf: (p) => tree.lines(p),
      covered: coveredBy(entries, SCAN_PASS),
      exclude: cfg.exclude,
      budget: { maxFiles: cfg.case_max_files, maxLines: cfg.case_max_lines },
    });
    const key: RateKey = { lens: SCAN_PASS, tier: cfg.tier, effort: cfg.effort, validator: cfg.validator };
    const rate = measuredRate(entries, key);
    const tally = casesFor(entries, key);
    const measured = rate?.cases ?? 0;
    const blockers: string[] = [];
    // Calibrated once `calibration_units` priced cases stand behind the rate —
    // or every case there is, on a repo smaller than that.
    const calibrated = rate !== null && measured >= Math.min(cfg.calibration_units, measured + plan.cases.length);
    let mode: ScanMode;
    let cases: Array<ScanCasePlan & { estimate_usd: number | null }>;
    let cap: number;
    let estimate: number | null;
    if (calibrated) {
      mode = "stage1";
      cases = plan.cases.map((c) => ({ ...c, estimate_usd: caseEstimate(c.lines, rate) }));
      estimate = cases.reduce((n, c) => n + (c.estimate_usd ?? 0), 0);
      cap = estimate;
    } else {
      mode = "calibration";
      if (tally.cases > 0 && tally.priced === 0) {
        blockers.push(
          `${tally.cases} stage-1 case(s) finished at these settings but the case runner priced none of them — ` +
            "a scan cannot be estimated, so none is started (check that the companion's pi reports usage cost)",
        );
      }
      cases = calibrationCases(plan.cases, Math.max(1, cfg.calibration_units - measured)).map((c) => ({ ...c, estimate_usd: null }));
      estimate = null;
      cap = cfg.calibration_max_usd;
    }
    if (cases.length === 0) {
      blockers.push(
        plan.covered > 0
          ? `nothing left to read at ${sha.slice(0, 12)}: the ledger already covers every stage-1 file at this content`
          : "nothing to read: no unit of the saved cut owns a readable, non-excluded file",
      );
    }
    const runSettings = {
      tier: cfg.tier,
      effort: cfg.effort,
      validator: cfg.validator,
      validate_tier: cfg.validator ? settings.validateTier : null,
    };
    const preview: ScanPreview = {
      key: planKey({
        mode,
        sha,
        cases: cases.map((c) => [c.id, c.files.map((f) => `${f.path}@${f.blob}`)]),
        settings: runSettings,
        cap: Math.round(cap * 1e6),
      }),
      mode,
      sha,
      cases,
      files: cases.reduce((n, c) => n + c.files.length, 0),
      lines: cases.reduce((n, c) => n + c.lines, 0),
      estimate_usd: estimate,
      cap_usd: cap,
      rate,
      calibration: { measured, wanted: cfg.calibration_units },
      remaining_cases: mode === "stage1" ? 0 : plan.cases.length - cases.length,
      excluded: plan.excluded,
      covered: plan.covered,
      unassigned: plan.unassigned,
      unreadable: plan.unreadable,
      settings: { ...runSettings, exclude: cfg.exclude, concurrency: cfg.concurrency },
      blockers,
    };
    return { ok: true, planned: { preview, tree, settings } };
  }

  // -- the four verbs --

  /** What a scan would read and cost now at `sha` (default the checkout's
   * HEAD), and the key a start must quote. */
  async preview(args: { sha?: string } = {}): Promise<{ ok: true; preview: ScanPreview } | Refusal> {
    const p = await this.plan(args.sha);
    return p.ok ? { ok: true, preview: p.planned.preview } : p;
  }

  /** Start the previewed run in the background. Returns once it is recorded. */
  async start(args: { key?: unknown; sha?: string }): Promise<{ ok: true; run: ScanRun } | Refusal> {
    if (this.active) return { ok: false, errors: [`scan ${this.active.id} is still running — stop it or wait for it`] };
    if (typeof args.key !== "string" || args.key === "") {
      return { ok: false, errors: ["no preview key — preview the scan, show the operator the cost, then start with its key"] };
    }
    const p = await this.plan(args.sha);
    if (!p.ok) return p;
    const { preview, tree, settings } = p.planned;
    if (args.key !== preview.key) {
      return {
        ok: false,
        errors: [`the plan changed since that preview (key ${args.key}, now ${preview.key}) — preview again and show the operator the new cost`],
      };
    }
    if (preview.blockers.length > 0) return { ok: false, errors: preview.blockers };
    const { file, error } = this.load();
    if (error !== null) return { ok: false, errors: [error] };
    const built = this.ports.buildAgents(settings);
    if (!built.ok) return { ok: false, errors: built.errors.map((e) => `the scan agents could not be built: ${e}`) };

    const now = this.ports.clock();
    const run: ScanRun = {
      id: `scan-${now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`,
      mode: preview.mode,
      sha: preview.sha,
      plan_key: preview.key,
      started_at: now.toISOString(),
      finished_at: null,
      state: "running",
      cap_usd: preview.cap_usd,
      estimate_usd: preview.estimate_usd,
      spent_usd: 0,
      unpriced_cases: 0,
      settings: {
        tier: preview.settings.tier,
        effort: preview.settings.effort,
        validator: preview.settings.validator,
        validate_tier: preview.settings.validate_tier,
      },
      cases: preview.cases.map((c) => ({
        id: c.id,
        unit: c.unit,
        part: c.part,
        parts: c.parts,
        files: c.files.map((f) => f.path),
        lines: c.lines,
        estimate_usd: c.estimate_usd,
        status: "pending",
        cost_usd: null,
        findings: 0,
        doubted: 0,
        dropped: 0,
        suggestions: [],
        error: null,
        started_at: null,
        finished_at: null,
      })),
      problems: [],
    };
    // A run left `running` by a companion that is gone was interrupted.
    if (file.current !== null) {
      const prev = file.current;
      file.history = [this.summary(prev, prev.state === "running" ? "interrupted" : prev.state), ...file.history].slice(0, RUN_HISTORY);
    }
    file.current = run;
    this.store(file);

    const abort = new AbortController();
    const done = this.drive(file, run, preview.cases, tree, settings, abort)
      .catch((err: unknown) => {
        // Belt: drive() records its own failures; this catches a bug in it.
        run.problems.push(`the scan stopped on an internal error: ${clean(err)}`);
        this.settle(file, run, "partial");
        this.ports.log?.(`setup: scan ${run.id} failed: ${clean(err)}`);
      })
      .finally(() => {
        if (this.active?.id === run.id) this.active = null;
      });
    this.active = { id: run.id, sha: run.sha, abort, done };
    return { ok: true, run };
  }

  /** The latest run, the history and the ledger's totals. */
  status(): ScanStatus {
    const { file, error } = this.load();
    const problems = error === null ? [] : [error];
    const ledger = this.ledger.load();
    if (ledger.error !== null) problems.push(ledger.error);
    const run = file.current;
    return {
      ok: problems.length === 0,
      problems,
      run: run === null ? null : { ...run, display: run.state === "running" && this.active?.id !== run.id ? "interrupted" : run.state },
      active: this.active !== null,
      history: file.history,
      ledger:
        ledger.error !== null
          ? null
          : {
              files: ledger.entries.filter((e) => e.lens === SCAN_PASS).length,
              cost_usd: ledger.entries.reduce((n, e) => n + (e.cost_usd ?? 0), 0),
            },
    };
  }

  /** Stop the running scan: in-flight cases are aborted, pending ones never
   * start; what finished stays in the ledger, so a later start resumes. */
  stop(): { ok: true; id: string } | Refusal {
    if (!this.active) return { ok: false, errors: ["no scan is running in this companion"] };
    this.active.abort.abort();
    return { ok: true, id: this.active.id };
  }

  /** Resolves when no scan is running (tests; a clean shutdown). */
  async idle(): Promise<void> {
    await this.active?.done;
  }

  /** Stage 1's stored deep-lens suggestions (stage 2's input). */
  suggestions(): { suggestions: StoredSuggestion[]; error: string | null } {
    try {
      const text = this.ports.state.read(SUGGESTIONS_FILE);
      if (text === null) return { suggestions: [], error: null };
      const raw = JSON.parse(text) as { version?: unknown; suggestions?: unknown };
      if (raw.version !== RUN_VERSION || !Array.isArray(raw.suggestions)) throw new Error("not a version-1 suggestions file");
      return { suggestions: raw.suggestions as StoredSuggestion[], error: null };
    } catch (err) {
      return { suggestions: [], error: `${SUGGESTIONS_FILE} cannot be read: ${clean(err)}` };
    }
  }

  // -- the background run --

  private async drive(
    file: RunFile,
    run: ScanRun,
    plans: ReadonlyArray<ScanCasePlan & { estimate_usd: number | null }>,
    tree: ScanTree,
    settings: ScanSettings,
    abort: AbortController,
  ): Promise<void> {
    const signal = abort.signal;
    let capHit = false;
    let reserved = 0;
    let next = 0;
    // May a case with this estimate start? Within the cap counting what is in
    // flight; a case with no estimate (calibration) only while the cap is not
    // yet reached. A zero cap is a free run (the runner prices at zero).
    const within = (extra: number): boolean =>
      run.cap_usd <= EPS ||
      (extra > 0
        ? run.spent_usd + reserved + extra <= run.cap_usd + EPS
        : run.spent_usd + reserved < run.cap_usd - EPS);
    const lane = async (): Promise<void> => {
      while (next < plans.length && !signal.aborted) {
        const plan = plans[next]!;
        const est = plan.estimate_usd ?? 0;
        if (!within(est)) {
          capHit = true;
          return;
        }
        next++;
        reserved += est;
        const spent = await this.runCase(file, run, plan, tree, settings, signal);
        reserved -= est;
        run.spent_usd += spent;
        this.store(file);
        // The hard stop: once spending reaches the cap, nothing in flight may
        // add to it.
        if (
          run.cap_usd > EPS &&
          run.spent_usd >= run.cap_usd - EPS &&
          !signal.aborted &&
          run.cases.some((c) => c.status === "running")
        ) {
          capHit = true;
          abort.abort();
        }
      }
    };
    const lanes = Math.max(1, Math.min(settings.scan.concurrency, plans.length));
    await Promise.all(Array.from({ length: lanes }, lane));

    // Never started: `skipped` when the cap kept it out, `stopped` when a stop did.
    for (const c of run.cases) if (c.status === "pending") c.status = capHit ? "skipped" : "stopped";
    const allDone = run.cases.every((c) => c.status === "done");
    this.settle(file, run, allDone ? "complete" : capHit ? "capped" : signal.aborted ? "stopped" : "partial");
  }

  /** One case, start to finish. Resolves with what it cost (its estimate
   * when the runner could not price it), never rejects. */
  private async runCase(
    file: RunFile,
    run: ScanRun,
    plan: ScanCasePlan & { estimate_usd: number | null },
    tree: ScanTree,
    settings: ScanSettings,
    signal: AbortSignal,
  ): Promise<number> {
    const c = run.cases.find((x) => x.id === plan.id)!;
    if (signal.aborted) {
      c.status = "stopped";
      return 0;
    }
    c.status = "running";
    c.started_at = this.ports.clock().toISOString();
    this.store(file);
    const ctx = { root: tree.root, sha: run.sha, caseId: `${run.id}/${plan.id}` };

    let cost: number | null = 0;
    const addCost = (o: CaseOutcome): void => {
      if (o.ok) cost = cost === null || o.cost_usd === null ? null : cost + o.cost_usd;
    };
    const outcome = await this.runOne(
      { id: ctx.caseId, unit: plan.unit, agent: stage1Agent(settings.scan.tier), files: c.files, prompt: scanCasePrompt(plan, ctx) },
      signal,
    );
    addCost(outcome);
    const finish = (status: ScanCaseStatus, error: string | null): number => {
      c.status = status;
      c.error = error;
      c.cost_usd = cost;
      c.finished_at = this.ports.clock().toISOString();
      if (cost === null) run.unpriced_cases++;
      return cost ?? plan.estimate_usd ?? 0;
    };
    if (!outcome.ok) return finish(signal.aborted ? "stopped" : "failed", outcome.reason);

    const inTree = new Set(tree.files.map((f) => f.path));
    const answer = parseScanAnswer(outcome.output, { root: tree.root });
    let dropped = answer.dropped + answer.suggestions_dropped;
    const anchored: Array<{ cand: ScanCandidate; code: string }> = [];
    for (const cand of answer.candidates) {
      const text = inTree.has(cand.path) ? tree.read(cand.path) : null;
      const lines = text === null ? null : anchoredLines(text, cand.start, cand.end);
      if (lines === null) {
        dropped++;
        continue;
      }
      anchored.push({ cand, code: normalizeCode(lines) });
    }

    // The validator, when this scan runs one: survivors are validated, a
    // doubt is kept and marked, anything else it kills is gone.
    let validated = false;
    const doubts = new Map<ScanCandidate, { word: string; reason: string }>();
    let kept = anchored;
    if (settings.scan.validator && anchored.length > 0) {
      const v = await this.runOne(
        {
          id: `${ctx.caseId}/validate`,
          unit: plan.unit,
          agent: validatorAgent(settings.validateTier),
          files: c.files,
          prompt: scanValidatorPrompt(plan, anchored.map((a) => a.cand), ctx),
        },
        signal,
      );
      addCost(v);
      if (!v.ok && signal.aborted) return finish("stopped", v.reason);
      if (!v.ok) {
        run.problems.push(`case ${plan.id}: the validator failed (${v.reason}) — its findings are kept unvalidated`);
      } else {
        validated = true;
        const read = parseValidatorAnswer(v.output, tree.root);
        const survivors: typeof anchored = [];
        for (const s of read.survivors) {
          const text = inTree.has(s.path) ? tree.read(s.path) : null;
          const lines = text === null ? null : anchoredLines(text, s.start, s.end);
          if (lines === null) dropped++;
          else survivors.push({ cand: s, code: normalizeCode(lines) });
        }
        for (const d of read.doubted) {
          const hit = anchored.find(
            (a) => a.cand.path === d.path && (d.line === null || (d.line >= a.cand.start && d.line <= a.cand.end)) && !doubts.has(a.cand),
          );
          if (hit) {
            doubts.set(hit.cand, { word: d.word, reason: d.reason });
            survivors.push(hit);
          }
        }
        kept = survivors;
      }
    }

    const reported: ReportedFinding[] = kept.map(({ cand, code }) => ({
      fingerprint: findingFingerprint({ path: cand.path, lens: SCAN_PASS, kind: cand.kind, code }),
      unit: plan.unit,
      path: cand.path,
      start: cand.start,
      end: cand.end,
      lens: SCAN_PASS,
      kind: cand.kind,
      severity: cand.severity,
      confidence: cand.confidence,
      claim: cand.claim,
      evidence: cand.evidence,
      fix: cand.fix,
      detail: cand.detail,
      validated,
      doubt: doubts.get(cand) ?? null,
    }));
    const at = this.ports.clock().toISOString();
    try {
      this.findings.report(reported, { run: run.id, sha: run.sha, at });
    } catch (err) {
      // Nothing recorded, so nothing enters the ledger: the case is read again.
      return finish("failed", `its findings could not be stored: ${clean(err)}`);
    }
    c.findings = reported.length;
    c.doubted = reported.filter((r) => r.doubt !== null).length;

    const suggestions = answer.suggestions
      .map((s) => ({ ...s, files: s.files.filter((p) => inTree.has(p)) }))
      .filter((s) => s.files.length > 0);
    dropped += answer.suggestions.length - suggestions.length;
    c.suggestions = suggestions;
    c.dropped = dropped;
    this.storeSuggestions(run, plan.unit, suggestions, at);

    // Last: the ledger. Only now is the case's reading on record.
    const total = plan.files.reduce((n, f) => n + Math.max(f.lines, 1), 0);
    const rows: LedgerEntry[] = plan.files.map((f) => ({
      path: f.path,
      blob: f.blob,
      lens: SCAN_PASS,
      tier: settings.scan.tier,
      effort: settings.scan.effort,
      validator: settings.scan.validator,
      sha: run.sha,
      lines: f.lines,
      cost_usd: cost === null ? null : (cost * Math.max(f.lines, 1)) / total,
      run: run.id,
      case: plan.id,
      at,
    }));
    try {
      this.ledger.record(rows);
    } catch (err) {
      run.problems.push(`case ${plan.id}: the ledger refused its rows (${clean(err)}) — it will be read again`);
      return finish("failed", "not recorded in the coverage ledger");
    }
    return finish("done", null);
  }

  private async runOne(spec: Parameters<CaseRunner["run"]>[0], signal: AbortSignal): Promise<CaseOutcome> {
    try {
      return await this.ports.cases.run(spec, signal);
    } catch (err) {
      return { ok: false, reason: `the case runner threw: ${clean(err)}` };
    }
  }

  private storeSuggestions(run: ScanRun, unit: string, found: readonly ScanSuggestion[], at: string): void {
    if (found.length === 0) return;
    const { suggestions, error } = this.suggestions();
    if (error !== null) {
      run.problems.push(`deep-lens suggestions not stored: ${error}`);
      return;
    }
    const key = (s: { unit: string; lens: string; files: string[] }): string => `${s.unit}\0${s.lens}\0${[...s.files].sort().join(",")}`;
    const byKey = new Map(suggestions.map((s) => [key(s), s]));
    for (const s of found) {
      const row: StoredSuggestion = { ...s, unit, sha: run.sha, run: run.id, at };
      byKey.set(key(row), row);
    }
    try {
      this.ports.state.write(SUGGESTIONS_FILE, `${JSON.stringify({ version: RUN_VERSION, suggestions: [...byKey.values()] }, null, 1)}\n`);
    } catch (err) {
      run.problems.push(`deep-lens suggestions not stored: ${clean(err)}`);
    }
  }

  private settle(file: RunFile, run: ScanRun, state: ScanRunState): void {
    run.state = state;
    run.finished_at = this.ports.clock().toISOString();
    try {
      this.store(file);
    } catch (err) {
      this.ports.log?.(`setup: could not record scan ${run.id}: ${clean(err)}`);
    }
  }
}

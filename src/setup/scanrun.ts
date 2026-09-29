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
//     the cap — read LIVE, from the running cost the case runner reports as
//     each case goes, not only when a case ends — every case still in flight
//     is aborted and the run ends `capped`. A case that failed or was aborted
//     counts what it spent (its estimate when the runner cannot say), so
//     failures can never carry a run past the cap. What it did not read stays
//     out of the ledger, so the next preview prices exactly the rest.
//   * STOP AND RESUME BY THE LEDGER. `stop` aborts in-flight cases and starts
//     no more. A run the companion was not there to finish (a TUI quit, an
//     expired login) reads as `interrupted`. Either way, only FINISHED cases
//     wrote ledger rows, so starting again reads only what is left.
//
// A DELTA re-scan is the same run over only the files whose
// content changed since the last scan (scan.ts changedSince): priced from the
// ledger like any stage-1 preview — so never before calibration — and
// stopped hard at its estimate. Deep passes never ride a delta; stage 2 runs
// only when asked. Every run, delta or not, ends by RECONCILING the findings
// store (findings.ts): exact matches were already recognised case by case;
// what a re-read file no longer reports is fixed, or handed to the companion
// as a match question when a fresh finding might be the same one.
//
// Where a case runs: background pi subagents inside the companion (the case
// runner port), from the scan agent build — `pass-scan`, and the validator
// when `[scan] validator` is on, both built with the scan-mode anchor
// addendum. The tree they read is the reviewed checkout AT THE CHOSEN SHA,
// materialised read-only by the source port; the sha is recorded on every
// ledger row and finding.
//
// STAGE 2 is the same run over a different plan: the companion
// PROPOSES rows (file set × deep lens × tier, cost — stage2.ts's rules),
// optionally fitted to a budget; the proposal is stored, and its key starts
// it — quoted by the companion on the operator's word, or by the TUI's click
// through the start channel (stage2request.ts). One case per row, the same
// hard stop at the approved estimate, the same ledger (keyed by the row's
// lens), the same findings store (filed under the unit owning each file).
//
// Persistence: `<state home>/scan/run.json` (the current run and a short
// history), `scan/suggestions.json` (stage 1's deep-lens suggestions, the
// input to stage 2), `scan/stage2.json` (the latest stage-2 proposal),
// beside the ledger and the findings store.
import type { LensTuningMap } from "../lenstuning.js";
import { PASS_TIER_ORDER, type PassTier } from "../types.js";
import type { ScanConfig } from "../config.js";
import type { CaseOutcome, CaseRunner, Refusal, StateFs } from "./engine.js";
import { FindingsStore, type ReconcileResult, type ReportedFinding } from "./findings.js";
import { blobsRead, casesFor, coveredBy, lastScanned, Ledger, measuredRate, rateWhere, type LedgerEntry, type RateKey } from "./ledger.js";
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
  type PromptContext,
  type ScanCandidate,
  type ScanCasePlan,
  type ScanRate,
  type ScanSuggestion,
  type TreeFile,
} from "./scan.js";
import { planStage2, stage2CasePrompt, stage2Key, unitOwner, type RowPrice, type Stage2Row, type Stage2RowRequest } from "./stage2.js";
import {
  parseStage2File,
  parseStartRequest,
  parseStartResult,
  STAGE2_FILE,
  STAGE2_RESULT_FILE,
  STAGE2_START_FILE,
  STAGE2_VERSION,
  type Stage2StartResult,
  type StoredStage2Proposal,
} from "./stage2request.js";
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
  /** The files (and content hashes) at `sha`, listed without materialising
   * anything, or null when git cannot list them — a delta's baseline. */
  list(sha: string): TreeFile[] | null;
}

/** The resolved settings a scan runs with: `config.toml [scan]` under the
 * profile's `[scan]` (the profile wins), and the validator's tier. */
export interface ScanSettings {
  scan: ScanConfig;
  validateTier: PassTier;
  /** The profile's per-lens tuning — which deep lenses stage 2 may run, at
   * which tiers and effort. */
  lenses?: LensTuningMap;
  /** `[models] risk_passes` — built at `sol-high` only. */
  riskPasses?: readonly string[];
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
  /** After the run's reconcile: close the tickets of promoted findings it
   * found fixed (triage.ts `closeFixed`). Absent: nothing closes. */
  closeFixedTickets?: () => Promise<{ closed: readonly unknown[]; problems: readonly string[] }>;
  log?: (line: string) => void;
}

// ---- records -------------------------------------------------------------------

export const RUN_FILE = "scan/run.json";
export const SUGGESTIONS_FILE = "scan/suggestions.json";
export const RUN_VERSION = 1;
/** Summaries of finished runs kept beside the current one. */
export const RUN_HISTORY = 20;

export type ScanMode = "calibration" | "stage1" | "delta" | "stage2";
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
  /** Stage 2: the row's lens, tier, reason and every unit it spans. */
  lens?: string;
  tier?: PassTier;
  reason?: string;
  units?: string[];
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
  /** What the run's end did to the stored findings; null until it
   * ran, or when it could not. */
  matching?: ReconcileResult | null;
  /** Tickets of promoted findings this run's end closed as fixed. */
  tickets_closed?: number;
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
  /** A delta: the last scan's sha it compares against, and the unchanged
   * files it leaves out that the ledger does not cover (the rest of an
   * unfinished scan). Null for a full preview. */
  delta: { since: string; unchanged: number } | null;
  /** Why a start would be refused whatever the key. */
  blockers: string[];
}

export interface ScanStatus {
  ok: boolean;
  problems: string[];
  run: (ScanRun & { display: ScanRunState | "interrupted" }) | null;
  active: boolean;
  history: ScanRunSummary[];
  /** `files`: read by stage 1; `deep_files`: file × lens rows stage 2 read. */
  ledger: { files: number; deep_files: number; cost_usd: number } | null;
}

/** What `proposeStage2` answers. */
export type Stage2Proposal = StoredStage2Proposal;

const EPS = 1e-9;
const clean = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const validatorAgent = (tier: PassTier): string => `pass-validate--${tier}`;

/** One case of a run, whatever the stage: what it reads, with which lens at
 * which tier and effort, what it is told, and where its findings are filed. */
interface CaseJob {
  plan: ScanCasePlan & { estimate_usd: number | null };
  lens: string;
  tier: PassTier;
  effort: string;
  prompt: (ctx: PromptContext) => string;
  /** The validator's view of the case, e.g. `stage 1, unit app`. */
  label: string;
  /** The unit a finding at `path` is filed under. */
  unitOf: (path: string) => string;
  /** Stage 1 reads and stores deep-lens suggestions; stage 2 does not. */
  suggestions: boolean;
  /** Stage 2: why the row, and every unit it spans. */
  reason?: string;
  units?: string[];
}

type Stage2Planned = { ok: true; proposal: StoredStage2Proposal; tree: ScanTree; settings: ScanSettings; cut: UnitCut } | Refusal;

interface Planned {
  preview: ScanPreview;
  tree: ScanTree;
  settings: ScanSettings;
}

export class ScanRunner {
  private active: { id: string; sha: string; abort: AbortController; done: Promise<void> } | null = null;
  private starting = false;
  private consuming = false;
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

  private async plan(ref: string | undefined, delta = false): Promise<{ ok: true; planned: Planned } | Refusal> {
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
    // A delta compares against the last scan: every content the ledger read
    // per file, and the tree that scan read (listed, not materialised).
    let basis: { since: string; read: Map<string, Set<string>>; baseline: Map<string, string> } | null = null;
    if (delta) {
      const last = lastScanned(entries, SCAN_PASS);
      if (last === null) return { ok: false, errors: ["no stage-1 scan to re-scan against — preview and run a full scan first"] };
      const listed = this.ports.source.list(last.sha);
      if (listed === null) {
        return { ok: false, errors: [`cannot list the tree the last scan read (${last.sha.slice(0, 12)}) — a delta cannot tell which files are new`] };
      }
      basis = { since: last.sha, read: blobsRead(entries, SCAN_PASS), baseline: new Map(listed.map((f) => [f.path, f.blob])) };
    }
    const plan = planStage1({
      cut: cut.cut,
      files: tree.files,
      linesOf: (p) => tree.lines(p),
      covered: coveredBy(entries, SCAN_PASS),
      exclude: cfg.exclude,
      budget: { maxFiles: cfg.case_max_files, maxLines: cfg.case_max_lines },
      ...(basis ? { delta: basis } : {}),
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
    if (delta) {
      // Priced like stage 1 — a delta never calibrates, and never guesses.
      mode = "delta";
      if (rate === null) {
        blockers.push("no measured price for stage 1 at these settings — run the calibration (an ordinary preview) before a delta re-scan");
      }
      cases = plan.cases.map((c) => ({ ...c, estimate_usd: rate === null ? null : caseEstimate(c.lines, rate) }));
      estimate = rate === null ? null : cases.reduce((n, c) => n + (c.estimate_usd ?? 0), 0);
      cap = estimate ?? 0;
    } else if (calibrated) {
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
    if (cases.length === 0 && delta) {
      blockers.push(`nothing changed to read at ${sha.slice(0, 12)} since the last scan (${basis!.since.slice(0, 12)})`);
    } else if (cases.length === 0) {
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
      remaining_cases: mode === "calibration" ? plan.cases.length - cases.length : 0,
      excluded: plan.excluded,
      covered: plan.covered,
      unassigned: plan.unassigned,
      unreadable: plan.unreadable,
      settings: { ...runSettings, exclude: cfg.exclude, concurrency: cfg.concurrency },
      delta: basis ? { since: basis.since, unchanged: plan.unchanged } : null,
      blockers,
    };
    return { ok: true, planned: { preview, tree, settings } };
  }

  // -- the four verbs --

  /** What a scan would read and cost now at `sha` (default the checkout's
   * HEAD), and the key a start must quote. */
  async preview(args: { sha?: string; delta?: boolean } = {}): Promise<{ ok: true; preview: ScanPreview } | Refusal> {
    const p = await this.plan(args.sha, args.delta === true);
    return p.ok ? { ok: true, preview: p.planned.preview } : p;
  }

  /** Start the previewed run in the background. Returns once it is recorded. */
  async start(args: { key?: unknown; sha?: string; delta?: boolean }): Promise<{ ok: true; run: ScanRun } | Refusal> {
    if (this.active) return { ok: false, errors: [`scan ${this.active.id} is still running — stop it or wait for it`] };
    // Two starts in parallel (a model may issue tool calls concurrently) must
    // not both pass the check above while the first is still planning: that
    // would run — and pay for — the same scan twice.
    if (this.starting) return { ok: false, errors: ["a scan is already starting — wait for it, then check scan_status"] };
    if (typeof args.key !== "string" || args.key === "") {
      return { ok: false, errors: ["no preview key — preview the scan, show the operator the cost, then start with its key"] };
    }
    this.starting = true;
    try {
      return await this.startPlanned(args.key, args.sha, args.delta === true);
    } finally {
      this.starting = false;
    }
  }

  private async startPlanned(key: string, sha: string | undefined, delta: boolean): Promise<{ ok: true; run: ScanRun } | Refusal> {
    const args = { key, sha };
    const p = await this.plan(args.sha, delta);
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

    const cfg = settings.scan;
    const jobs: CaseJob[] = preview.cases.map((c) => ({
      plan: c,
      lens: SCAN_PASS,
      tier: cfg.tier,
      effort: cfg.effort,
      prompt: (ctx) => scanCasePrompt(c, ctx),
      label: `stage 1, unit ${c.unit}`,
      unitOf: () => c.unit,
      suggestions: true,
    }));
    const run = this.launch(file, {
      mode: preview.mode,
      sha: preview.sha,
      plan_key: preview.key,
      cap_usd: preview.cap_usd,
      estimate_usd: preview.estimate_usd,
      settings: {
        tier: preview.settings.tier,
        effort: preview.settings.effort,
        validator: preview.settings.validator,
        validate_tier: preview.settings.validate_tier,
      },
    }, jobs, tree, settings);
    return { ok: true, run };
  }

  /** Record a new run as current and drive its cases in the background. */
  private launch(
    file: RunFile,
    head: Pick<ScanRun, "mode" | "sha" | "plan_key" | "cap_usd" | "estimate_usd" | "settings">,
    jobs: CaseJob[],
    tree: ScanTree,
    settings: ScanSettings,
  ): ScanRun {
    const now = this.ports.clock();
    const run: ScanRun = {
      id: `scan-${now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`,
      ...head,
      started_at: now.toISOString(),
      finished_at: null,
      state: "running",
      spent_usd: 0,
      unpriced_cases: 0,
      cases: jobs.map(({ plan: c, ...job }) => ({
        id: c.id,
        unit: c.unit,
        part: c.part,
        parts: c.parts,
        files: c.files.map((f) => f.path),
        lines: c.lines,
        estimate_usd: c.estimate_usd,
        status: "pending" as const,
        cost_usd: null,
        findings: 0,
        doubted: 0,
        dropped: 0,
        suggestions: [],
        error: null,
        started_at: null,
        finished_at: null,
        ...(head.mode === "stage2" ? { lens: job.lens, tier: job.tier, reason: job.reason, units: job.units } : {}),
      })),
      problems: [],
      matching: null,
    };
    // A run left `running` by a companion that is gone was interrupted.
    if (file.current !== null) {
      const prev = file.current;
      file.history = [this.summary(prev, prev.state === "running" ? "interrupted" : prev.state), ...file.history].slice(0, RUN_HISTORY);
    }
    file.current = run;
    this.store(file);

    const abort = new AbortController();
    const done = this.drive(file, run, jobs, tree, settings, abort)
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
    return run;
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
              deep_files: ledger.entries.filter((e) => e.lens !== SCAN_PASS).length,
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

  // -- stage 2 --

  /** The latest stored stage-2 proposal, none, or why it cannot be read. */
  stage2Proposal(): { proposal: StoredStage2Proposal | null; error: string | null } {
    try {
      const text = this.ports.state.read(STAGE2_FILE);
      return { proposal: text === null ? null : parseStage2File(text).proposal, error: null };
    } catch (err) {
      return { proposal: null, error: `${STAGE2_FILE} cannot be read: ${clean(err)}` };
    }
  }

  /** A row's price at `lens`/`tier`/`effort` from the ledger (stage2.ts
   * "PRICED FROM THE LEDGER"). */
  private priceRow(entries: readonly LedgerEntry[], cfg: ScanConfig, lens: string, tier: PassTier, effort: string): RowPrice | null {
    const validator = cfg.validator;
    const own = measuredRate(entries, { lens, tier, effort, validator });
    if (own) return { rate: own, basis: "measured", from: lens };
    // Borrowed only from another DEEP lens: pass-scan is the cheap wide pass,
    // and its rate at a matching tier/effort (a profile giving a deep lens
    // `effort = "low"` at `[scan] tier`) would price a deep row at stage 1's
    // cost unscaled — stage 1's rate reaches a row only through the factor.
    const others = (e: LedgerEntry): boolean =>
      e.lens !== lens && e.lens !== SCAN_PASS && e.tier === tier && e.effort === effort && e.validator === validator;
    const borrowed = rateWhere(entries, others);
    if (borrowed) {
      const from = [...new Set(entries.filter((e) => others(e) && e.cost_usd !== null).map((e) => e.lens))].sort().join(", ");
      return { rate: borrowed, basis: "borrowed", from };
    }
    const stage1 =
      measuredRate(entries, { lens: SCAN_PASS, tier: cfg.tier, effort: cfg.effort, validator }) ??
      rateWhere(entries, (e) => e.lens === SCAN_PASS);
    if (!stage1) return null;
    return {
      rate: { ...stage1, usd_per_kline: stage1.usd_per_kline * cfg.unmeasured_rate_factor },
      basis: "extrapolated",
      from: SCAN_PASS,
    };
  }

  private async planStage2(request: Stage2RowRequest[], budgetUsd: number | null, ref: string | undefined): Promise<Stage2Planned> {
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
    const plan = planStage2({
      rows: request,
      cut: cut.cut,
      files: tree.files,
      linesOf: (p) => tree.lines(p),
      exclude: cfg.exclude,
      budget: { maxFiles: cfg.case_max_files, maxLines: cfg.case_max_lines },
      lenses: settings.lenses,
      riskPasses: settings.riskPasses ?? [],
      defaultTier: cfg.tier,
      covered: (lens) => coveredBy(entries, lens),
      price: (lens, tier, effort) => this.priceRow(entries, cfg, lens, tier, effort),
      budgetUsd,
    });
    if (!plan.ok) return { ok: false, errors: plan.errors };
    const validateTier = cfg.validator ? settings.validateTier : null;
    const runnable = plan.rows.filter((r) => r.status === "run");
    const key = stage2Key({
      sha,
      rows: runnable.map((r) => [r.id, r.lens, r.tier, r.effort, [...r.files, ...r.tests].map((f) => `${f.path}@${f.blob}`)]),
      validator: cfg.validator,
      validate_tier: validateTier,
      cap: Math.round(plan.total_usd * 1e6),
    });
    const proposal: StoredStage2Proposal = {
      key,
      sha,
      at: this.ports.clock().toISOString(),
      request,
      budget_usd: budgetUsd,
      rows: plan.rows,
      cap_usd: plan.total_usd,
      runnable: plan.runnable,
      over_budget_usd: plan.over_budget_usd,
      validator: cfg.validator,
    };
    return { ok: true, proposal, tree, settings, cut: cut.cut };
  }

  /**
   * Plan and STORE a stage-2 proposal from the companion's rows: checked,
   * tests paired, priced from the ledger, fitted to `budget_usd` when given.
   * Runs nothing. The stored proposal replaces the previous one — it is what
   * the TUI shows and what a start's key must name.
   */
  async proposeStage2(args: { rows?: unknown; budget_usd?: unknown; sha?: string }): Promise<{ ok: true; proposal: Stage2Proposal } | Refusal> {
    if (!Array.isArray(args.rows)) return { ok: false, errors: ["`rows` must be a list of { lens, files, tier?, reason }"] };
    const request: Stage2RowRequest[] = [];
    for (const [i, r] of args.rows.entries()) {
      if (typeof r !== "object" || r === null || Array.isArray(r)) return { ok: false, errors: [`row-${i + 1}: not a { lens, files, tier?, reason } object`] };
      const o = r as Record<string, unknown>;
      request.push({
        lens: typeof o.lens === "string" ? o.lens : "",
        files: Array.isArray(o.files) ? o.files.filter((f): f is string => typeof f === "string") : typeof o.files === "string" ? o.files.split(",") : [],
        ...(typeof o.tier === "string" && o.tier.trim() !== "" ? { tier: o.tier.trim() } : {}),
        reason: typeof o.reason === "string" ? o.reason : "",
      });
    }
    let budget: number | null = null;
    if (args.budget_usd !== undefined && args.budget_usd !== null) {
      if (typeof args.budget_usd !== "number" || !Number.isFinite(args.budget_usd) || args.budget_usd <= 0) {
        return { ok: false, errors: ["`budget_usd` must be a positive number of dollars (or left out)"] };
      }
      budget = args.budget_usd;
    }
    const p = await this.planStage2(request, budget, args.sha);
    if (!p.ok) return p;
    try {
      this.ports.state.write(STAGE2_FILE, `${JSON.stringify({ version: STAGE2_VERSION, proposal: p.proposal }, null, 1)}\n`);
    } catch (err) {
      return { ok: false, errors: [`the proposal could not be stored: ${clean(err)}`] };
    }
    return { ok: true, proposal: p.proposal };
  }

  /**
   * Start the stored stage-2 proposal whose key is quoted — on the
   * operator's word (the companion) or his click (the TUI, through
   * `consumeStage2Request`). Re-planned first: a proposal that moved since it
   * was shown is refused. Hard stop at its estimate.
   */
  async startStage2(args: { key?: unknown }): Promise<{ ok: true; run: ScanRun } | Refusal> {
    if (this.active) return { ok: false, errors: [`scan ${this.active.id} is still running — stop it or wait for it`] };
    if (this.starting) return { ok: false, errors: ["a scan is already starting — wait for it, then check scan_status"] };
    if (typeof args.key !== "string" || args.key === "") {
      return { ok: false, errors: ["no proposal key — propose stage 2, show the operator the rows and the cost, then start with its key"] };
    }
    this.starting = true;
    try {
      return await this.startStage2Planned(args.key);
    } finally {
      this.starting = false;
    }
  }

  private async startStage2Planned(key: string): Promise<{ ok: true; run: ScanRun } | Refusal> {
    const stored = this.stage2Proposal();
    if (stored.error !== null) return { ok: false, errors: [stored.error] };
    if (stored.proposal === null) return { ok: false, errors: ["no stage 2 proposal — propose one first"] };
    if (stored.proposal.key !== key) {
      return { ok: false, errors: [`${key} is not the latest stage 2 proposal (that is ${stored.proposal.key}) — show the operator the latest one`] };
    }
    const p = await this.planStage2(stored.proposal.request, stored.proposal.budget_usd, stored.proposal.sha);
    if (!p.ok) return p;
    if (p.proposal.key !== key) {
      return {
        ok: false,
        errors: [`the plan changed since the proposal (key ${key}, now ${p.proposal.key}: a file, a price or the settings moved) — propose again and show the operator the new cost`],
      };
    }
    const rows = p.proposal.rows.filter((r) => r.status === "run");
    if (rows.length === 0) return { ok: false, errors: ["nothing to run: every row is covered by the ledger or over the budget"] };
    const { file, error } = this.load();
    if (error !== null) return { ok: false, errors: [error] };
    const built = this.ports.buildAgents(p.settings);
    if (!built.ok) return { ok: false, errors: built.errors.map((e) => `the scan agents could not be built: ${e}`) };
    const unitOf = unitOwner(p.cut, p.tree.files.map((f) => f.path));
    const jobs: CaseJob[] = rows.map((row: Stage2Row) => ({
      plan: {
        unit: row.units.join("+"),
        id: row.id,
        part: 1,
        parts: 1,
        files: [...row.files, ...row.tests],
        lines: row.lines,
        estimate_usd: row.estimate_usd,
      },
      lens: row.lens,
      tier: row.tier,
      effort: row.effort,
      prompt: (ctx) => stage2CasePrompt(row, ctx),
      label: `stage 2, ${row.id} (${row.lens})`,
      unitOf,
      suggestions: false,
      reason: row.reason,
      units: row.units,
    }));
    const cfg = p.settings.scan;
    const top = rows.reduce<PassTier>((t, r) => (PASS_TIER_ORDER.indexOf(r.tier) > PASS_TIER_ORDER.indexOf(t) ? r.tier : t), rows[0]!.tier);
    const run = this.launch(
      file,
      {
        mode: "stage2",
        sha: p.proposal.sha,
        plan_key: key,
        cap_usd: p.proposal.cap_usd,
        estimate_usd: p.proposal.cap_usd,
        settings: { tier: top, effort: "per row", validator: cfg.validator, validate_tier: cfg.validator ? p.settings.validateTier : null },
      },
      jobs,
      p.tree,
      p.settings,
    );
    return { ok: true, run };
  }

  /**
   * Answer the TUI's start request, if there is one not yet answered: start
   * the proposal it names and write the outcome to `STAGE2_RESULT_FILE`.
   * Resolves null when there is nothing to answer. The companion's scan belt
   * polls this; one request is answered once.
   */
  async consumeStage2Request(): Promise<Stage2StartResult | null> {
    if (this.consuming) return null;
    this.consuming = true;
    try {
      let text: string | null;
      try {
        text = this.ports.state.read(STAGE2_START_FILE);
      } catch (err) {
        this.ports.log?.(`setup: ${STAGE2_START_FILE} cannot be read: ${clean(err)}`);
        return null;
      }
      const req = text === null ? null : parseStartRequest(text);
      if (req === null) return null;
      let prev: string | null = null;
      try {
        prev = this.ports.state.read(STAGE2_RESULT_FILE);
      } catch {
        // Unreadable: answer again rather than never.
      }
      if (prev !== null && parseStartResult(prev)?.request === req.id) return null;
      const r = await this.startStage2({ key: req.key });
      const result: Stage2StartResult = {
        request: req.id,
        key: req.key,
        at: this.ports.clock().toISOString(),
        ok: r.ok,
        run: r.ok ? r.run.id : null,
        errors: r.ok ? [] : r.errors,
      };
      try {
        this.ports.state.write(STAGE2_RESULT_FILE, `${JSON.stringify(result)}\n`);
      } catch (err) {
        this.ports.log?.(`setup: the stage 2 start result could not be written: ${clean(err)}`);
      }
      this.ports.log?.(`setup: the TUI asked to start stage 2 (${req.key}): ${r.ok ? `started ${r.run.id}` : r.errors.join("; ")}`);
      return result;
    } finally {
      this.consuming = false;
    }
  }

  // -- the background run --

  private async drive(
    file: RunFile,
    run: ScanRun,
    jobs: readonly CaseJob[],
    tree: ScanTree,
    settings: ScanSettings,
    abort: AbortController,
  ): Promise<void> {
    const signal = abort.signal;
    let capHit = false;
    let reserved = 0;
    let next = 0;
    // What each in-flight case has spent SO FAR, as its runner reports it.
    // The hard stop reads these live: a case never runs on past the cap just
    // because it has not finished yet.
    const live = new Map<string, number>();
    const liveTotal = (): number => [...live.values()].reduce((n, v) => n + v, 0);
    const onCost = (caseId: string, spentSoFar: number): void => {
      live.set(caseId, spentSoFar);
      if (run.cap_usd > EPS && !signal.aborted && run.spent_usd + liveTotal() >= run.cap_usd - EPS) {
        capHit = true;
        abort.abort();
      }
    };
    // May a case with this estimate start? Within the cap counting what is in
    // flight; a case with no estimate (calibration) only while the cap is not
    // yet reached. A zero cap is a free run (the runner prices at zero).
    const within = (extra: number): boolean =>
      run.cap_usd <= EPS ||
      (extra > 0
        ? run.spent_usd + reserved + extra <= run.cap_usd + EPS
        : run.spent_usd + reserved < run.cap_usd - EPS);
    const lane = async (): Promise<void> => {
      while (next < jobs.length && !signal.aborted) {
        const job = jobs[next]!;
        const plan = job.plan;
        const est = plan.estimate_usd ?? 0;
        if (!within(est)) {
          capHit = true;
          return;
        }
        next++;
        reserved += est;
        live.set(plan.id, 0);
        const spent = await this.runCase(file, run, job, tree, settings, signal, (v) => onCost(plan.id, v));
        live.delete(plan.id);
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
    const lanes = Math.max(1, Math.min(settings.scan.concurrency, jobs.length));
    await Promise.all(Array.from({ length: lanes }, lane));

    // Never started: `skipped` when the cap kept it out, `stopped` when a stop did.
    for (const c of run.cases) if (c.status === "pending") c.status = capHit ? "skipped" : "stopped";
    this.reconcile(run, tree);
    await this.closeFixedTickets(run);
    const allDone = run.cases.every((c) => c.status === "done");
    this.settle(file, run, allDone ? "complete" : capHit ? "capped" : signal.aborted ? "stopped" : "partial");
  }

  /** One case, start to finish. Resolves with what it cost (its estimate
   * when the runner could not price it), never rejects. */
  private async runCase(
    file: RunFile,
    run: ScanRun,
    job: CaseJob,
    tree: ScanTree,
    settings: ScanSettings,
    signal: AbortSignal,
    onCost: (spentSoFar: number) => void = () => {},
  ): Promise<number> {
    const plan = job.plan;
    const c = run.cases.find((x) => x.id === plan.id)!;
    if (signal.aborted) {
      c.status = "stopped";
      return 0;
    }
    c.status = "running";
    c.started_at = this.ports.clock().toISOString();
    this.store(file);
    const ctx = { root: tree.root, sha: run.sha, caseId: `${run.id}/${plan.id}` };

    // What the case has spent: every call's cost, a FAILED call's included
    // (it spent money too). Null once any call could not say.
    let cost: number | null = 0;
    // The most the runner has reported so far — the floor of what an
    // unpriced case is counted at.
    let seen = 0;
    const addCost = (o: CaseOutcome): void => {
      const spent = o.cost_usd === undefined ? null : o.cost_usd;
      cost = cost === null || spent === null ? null : cost + spent;
    };
    const report = (base: number) => (v: number): void => {
      seen = Math.max(seen, base + v);
      onCost(seen);
    };
    const outcome = await this.runOne(
      { id: ctx.caseId, unit: plan.unit, agent: `${job.lens}--${job.tier}`, files: c.files, prompt: job.prompt(ctx) },
      signal,
      report(0),
    );
    addCost(outcome);
    const finish = (status: ScanCaseStatus, error: string | null): number => {
      c.status = status;
      c.error = error;
      c.cost_usd = cost;
      c.finished_at = this.ports.clock().toISOString();
      if (cost === null) run.unpriced_cases++;
      // Unpriced: counted at its estimate (or what the runner saw it spend,
      // if more) — never as free.
      return cost ?? Math.max(seen, plan.estimate_usd ?? 0);
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
          prompt: scanValidatorPrompt(plan, anchored.map((a) => a.cand), ctx, job.lens, job.label),
        },
        signal,
        report(cost ?? seen),
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

    const blobOf = new Map(tree.files.map((f) => [f.path, f.blob]));
    const all: ReportedFinding[] = kept.map(({ cand, code }) => ({
      fingerprint: findingFingerprint({ path: cand.path, lens: job.lens, kind: cand.kind, code }),
      unit: job.unitOf(cand.path),
      path: cand.path,
      blob: blobOf.get(cand.path) ?? null,
      start: cand.start,
      end: cand.end,
      lens: job.lens,
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
    // One finding per fingerprint: the validator may list a candidate as a
    // survivor AND doubt it — the doubt wins, and it is counted once.
    const byFp = new Map<string, ReportedFinding>();
    for (const r of all) {
      const had = byFp.get(r.fingerprint);
      if (!had || (had.doubt === null && r.doubt !== null)) byFp.set(r.fingerprint, r);
    }
    const reported = [...byFp.values()];
    const at = this.ports.clock().toISOString();
    try {
      this.findings.report(reported, { run: run.id, sha: run.sha, at });
    } catch (err) {
      // Nothing recorded, so nothing enters the ledger: the case is read again.
      return finish("failed", `its findings could not be stored: ${clean(err)}`);
    }
    c.findings = reported.length;
    c.doubted = reported.filter((r) => r.doubt !== null).length;

    if (job.suggestions) {
      const suggestions = answer.suggestions
        .map((s) => ({ ...s, files: s.files.filter((p) => inTree.has(p)) }))
        .filter((s) => s.files.length > 0);
      dropped += answer.suggestions.length - suggestions.length;
      c.suggestions = suggestions;
      this.storeSuggestions(run, plan.unit, suggestions, at);
    }
    c.dropped = dropped;

    // Last: the ledger. Only now is the case's reading on record.
    const total = plan.files.reduce((n, f) => n + Math.max(f.lines, 1), 0);
    const rows: LedgerEntry[] = plan.files.map((f) => ({
      path: f.path,
      blob: f.blob,
      lens: job.lens,
      tier: job.tier,
      effort: job.effort,
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

  private async runOne(
    spec: Parameters<CaseRunner["run"]>[0],
    signal: AbortSignal,
    onCost: (spentSoFar: number) => void,
  ): Promise<CaseOutcome> {
    try {
      return await this.ports.cases.run(spec, signal, onCost);
    } catch (err) {
      return { ok: false, reason: `the case runner threw: ${clean(err)}`, cost_usd: null };
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

  /** The run's end, whatever ended it: what re-read files no longer report
   * is fixed, or handed to the companion (findings.ts reconcile). Only
   * FINISHED cases wrote ledger rows, so only their reading counts. */
  private reconcile(run: ScanRun, tree: ScanTree): void {
    const { entries, error } = this.ledger.load();
    try {
      if (error !== null) throw new Error(error);
      run.matching = this.findings.reconcile({
        rows: entries,
        tree: new Set(tree.files.map((f) => f.path)),
        run: { run: run.id, sha: run.sha, at: this.ports.clock().toISOString() },
      });
    } catch (err) {
      run.problems.push(`the findings were not reconciled (${clean(err)}) — the next run's end does it`);
    }
  }

  /** A promoted finding the reconcile fixed has its ticket closed with the
   * run's sha; a refused close is a problem on the run, retried next time. */
  private async closeFixedTickets(run: ScanRun): Promise<void> {
    if (!this.ports.closeFixedTickets) return;
    try {
      const r = await this.ports.closeFixedTickets();
      run.tickets_closed = r.closed.length;
      for (const p of r.problems) run.problems.push(`ticket not closed: ${p}`);
    } catch (err) {
      run.problems.push(`the fixed findings' tickets were not closed (${clean(err)}) — the next run's end retries`);
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

// Scan stage 1's run: preview, start, status, stop — the stateful
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
//     out of the ledger, so the next preview prices exactly the rest — and
//     runs it first: stage-1 and delta cases are ordered coverage-first
//     (scan.ts readTier: never read or cut short, then changed — stalest
//     reading first — then the rest), so the stop never starves the same
//     tail run after run. Stage-2 rows keep the proposal's order.
//   * STOP AND RESUME BY THE LEDGER. `stop` aborts in-flight cases and starts
//     no more. A run the companion was not there to finish (a TUI quit, an
//     expired login) reads as `interrupted`. Either way, only FINISHED cases
//     wrote ledger rows, so starting again reads only what is left.
//
// A delta re-scan is the same run over the files whose content
// changed since the last scan (scan.ts changedSince) AND every file no
// complete reading covers at its content — never read, cut short, unreadable
// before (the plan's `owed`, read unread-first): priced from the ledger like
// any stage-1 preview — so never before calibration — and
// stopped hard at its estimate. Deep passes never ride a delta; stage 2 runs
// only when asked. Every run, delta or not, ends by RECONCILING the findings
// store (findings.ts): exact matches were already recognised case by case;
// what a re-read file no longer reports is fixed, or handed to the companion
// as a match question when a fresh finding might be the same one.
//
// DEPTH (`[scan] depth`, profile over config.toml): a deep run builds the
// agents deep (scanbuild.ts — the deep suggest and dig addenda), lifts stage
// 1's suggestion cap to `SCAN_DEEP_MAX_SUGGESTIONS`, writes `depth: "deep"` on
// its ledger rows and reads coverage at its depth: a file the ledger holds
// only a standard reading of is read again by a deep run (ledger.ts). It is
// priced from readings at its depth, or — when none prices it — from readings
// at the other depth, and the preview says so (`rate_across_depth`, a row's
// `across_depth`). A stage-2 proposal records the depth it was made at — the
// propose call's `deep`, else `[scan] depth` — and a start re-plans and
// builds at that depth; a deep one adds the floor (stage2.ts). The depth is
// part of a deep plan's key, so a key never starts a run at another depth.
//
// Where a case runs: background pi subagents inside the companion (the case
// runner port), from the scan agent build — `pass-scan`, and the validator
// when `[scan] validator` is on, both built with the scan-mode anchor
// addendum. The tree they read is the reviewed checkout AT THE CHOSEN SHA,
// materialised read-only by the source port; the sha is recorded on every
// ledger row and finding.
//
// Stage 2 is the same run over a different plan: the companion
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
// beside the ledger and the findings store — and the TUI's stop request
// and its answer (`scan/stop.json`, `scan/stop-result.json` —
// scanreport.ts, which also owns the run record's name and parser).
import { posix } from "node:path";
import type { LensTuningMap } from "../lenstuning.js";
import { PASS_TIER_ORDER, type PassTier } from "../types.js";
import type { ScanConfig, ScanDepth } from "../config.js";
import type { CaseOutcome, CaseRunner, Refusal, StateFs } from "./engine.js";
import {
  FindingsStore,
  type FindingDoubt,
  type ReconcileResult,
  type ReportedFinding,
  type Validity,
} from "./findings.js";
import {
  casesFor,
  coveredBy,
  lastScanned,
  Ledger,
  measuredRate,
  newestRead,
  partialRanges,
  readings,
  type LedgerEntry,
  type RateKey,
} from "./ledger.js";
import {
  anchoredLines,
  calibrationCases,
  caseEstimate,
  changedSince,
  coverKey,
  evidenceQuotesAnchor,
  findingFingerprint,
  normalizeCode,
  parseScanAnswer,
  parseValidatorAnswer,
  planKey,
  planStage1,
  scanCasePrompt,
  scanValidatorPrompt,
  SCAN_DEEP_MAX_SUGGESTIONS,
  SCAN_PASS,
  type ExclusionReason,
  type PromptContext,
  type ScanCandidate,
  type ScanCasePlan,
  type ScanRate,
  type ScanSuggestion,
  type SkippedFile,
  type TreeFile,
  type UnreadableReason,
} from "./scan.js";
import {
  planStage2,
  priceStage2Row,
  stage2Cases,
  stage2CasePrompt,
  stage2Leads,
  stage2Key,
  unitOwner,
  type Stage2Row,
  type Stage2RowRequest,
} from "./stage2.js";
import {
  keptRows,
  parseStage2File,
  parseStartRequest,
  parseStartResult,
  proposalDepth,
  STAGE2_FILE,
  STAGE2_RESULT_FILE,
  STAGE2_START_FILE,
  STAGE2_VERSION,
  type Stage2StartResult,
  type StoredStage2Proposal,
} from "./stage2request.js";
import type { UnitCut } from "./unitcut.js";
import {
  parseRunFile,
  parseStopRequest,
  parseStopResult,
  RUN_FILE,
  RUN_VERSION,
  SCAN_STOP_FILE,
  SCAN_STOP_RESULT_FILE,
  type ScanStopResult,
} from "./scanreport.js";

// ---- did the lens read? ------------------------------------------------------------

/**
 * Why a lens's answer is not a reading of its case, or null when it is. A
 * lens can answer NONE without opening a file; such an answer must not
 * record the files as read in the ledger, nor price the lens.
 *
 * `reads` is what the case runner saw the lens's file-read calls name
 * (`CaseOutcome.reads`); absent means the runner cannot tell, and unknown is
 * never judged as zero. A reading needs at least one focus file opened at
 * its path under the tree root. The runner reports each read resolved to the
 * file it opened, so a relative read counts exactly when it resolved inside
 * the tree: the lens runs outside the tree (first-party cwd), and a relative
 * `api/x.py` opened the app root's copy — another repository — which is no
 * reading of the case. A read left relative (a runner that cannot resolve)
 * is never credited, and a read of some other file (a CLAUDE.md, a caller)
 * is context, not the case. Pure.
 */
export function unreadFocus(
  reads: readonly string[] | undefined,
  focus: readonly string[],
  root: string,
): string | null {
  if (reads === undefined) return null;
  if (openedFocus(reads, focus, root)!.size > 0) return null;
  const n = focus.length;
  return `the lens read none of its ${n} focus file${n === 1 ? "" : "s"} (${reads.length} file-read call${reads.length === 1 ? "" : "s"} in all)`;
}

/**
 * The focus files a lens opened, by the same reading `unreadFocus` makes: a
 * read resolved inside the tree root naming the file. Null when the runner
 * cannot tell (`reads` absent). A focus file the lens never opened is no
 * reading of THAT file, whatever it read of the others: it gets no ledger
 * row, so it is read again and a reconcile never settles its findings fixed
 * from a reading that never happened. Pure.
 */
export function openedFocus(
  reads: readonly string[] | undefined,
  focus: readonly string[],
  root: string,
): Set<string> | null {
  if (reads === undefined) return null;
  const base = posix.normalize(`${root}/`);
  const opened = new Set(
    reads
      // pi strips one leading `@` from a path argument (its `stripAtPrefix`),
      // so `@/tree/x.py` opened `/tree/x.py`.
      .map((r) => (r.startsWith("@") ? r.slice(1) : r))
      .filter((r) => r.startsWith("/"))
      .map((r) => posix.normalize(r))
      .filter((r) => r.startsWith(base))
      .map((r) => r.slice(base.length)),
  );
  return new Set(focus.filter((f) => opened.has(posix.normalize(f))));
}

// ---- ports ---------------------------------------------------------------------

/** The repository at one sha, materialised where the lenses read it. */
export interface ScanTree {
  sha: string;
  /** Absolute path of the materialised tree — what the lens is told. */
  root: string;
  files: TreeFile[];
  read(path: string): string | null;
  lines(path: string): number | null;
  /** Why `read` answers null for a listed file (`binary`, `too-big`), or
   * null when it reads. Optional: a tree without it reports `unreadable`. */
  whyUnreadable?(path: string): UnreadableReason | null;
}

/** The reviewed checkout as a source of trees (READ-ONLY). */
export interface ScanSource {
  readonly location: string;
  /** The full commit sha `ref` names, or null (unknown ref, no checkout). */
  resolve(ref: string): string | null;
  /** The tree at `sha`, materialised; earlier trees other than `keep` may be
   * removed to bound the disk. */
  open(
    sha: string,
    keep: readonly string[],
  ): { ok: true; tree: ScanTree } | { ok: false; reason: string };
  /** The files (and content hashes) at `sha`, listed without materialising
   * anything, or null when git cannot list them — a delta's baseline. */
  list(sha: string): TreeFile[] | null;
}

/** The resolved settings a scan runs with: `config.toml [scan]` under the
 * profile's `[scan]` (the profile wins). The validator — the skeptic — has
 * no tier of its own: it runs at the tier of the lens it judges. */
export interface ScanSettings {
  scan: ScanConfig;
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

export { RUN_FILE, RUN_VERSION };
export const SUGGESTIONS_FILE = "scan/suggestions.json";
/** Under the state home: every case's event stream, one directory per run
 * (`caserunner.ts` `transcriptFile`). */
export const SCAN_TRANSCRIPTS_DIR = "scan/transcripts";
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
  /** A file read in line ranges: the range this case reports inside. */
  ranges?: Array<{ path: string; start: number; end: number; total: number }>;
  lines: number;
  estimate_usd: number | null;
  status: ScanCaseStatus;
  /** Stage 1 plus the validator; null when the runner could not price it. */
  cost_usd: number | null;
  findings: number;
  /** Findings the validator doubted — kept, marked "may not be valid". */
  doubted: number;
  /** Findings the skeptic confirmed / found likely (absent on records
   * written before the tiers). */
  confirmed?: number;
  likely?: number;
  /** Answer items that could not be read or anchored. */
  dropped: number;
  /** The lens's file-read calls, counted; absent when the runner could not
   * tell. */
  reads?: number;
  /** Focus files the lens never opened — no coverage, read again. Absent
   * when it opened every one, or the runner could not tell. */
  unopened?: string[];
  /** The case's and its validator's event streams, relative to
   * `SCAN_TRANSCRIPTS_DIR`; absent when none was kept. */
  transcript?: string;
  validator_transcript?: string;
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
  settings: {
    tier: PassTier;
    effort: string;
    validator: boolean;
    validate_tier: PassTier | null;
    /** `"deep"` for a deep run; absent = standard. */
    depth?: ScanDepth;
  };
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

export interface RunFile {
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
  /** The run's depth (`[scan] depth`). */
  depth: ScanDepth;
  /** The rate stands on readings at the other depth: nothing at this depth
   * is priced at these settings yet. */
  rate_across_depth: boolean;
  /** Priced cases the rate stands on, and how many calibration wants. */
  calibration: { measured: number; wanted: number };
  /** Stage-1 cases left after this run (all of them, for a calibration). */
  remaining_cases: number;
  excluded: Record<ExclusionReason, number>;
  covered: number;
  unassigned: string[];
  unreadable: number;
  /** The unreadable files by path and reason — `skipped: binary` is said,
   * never silently absent. */
  skipped: SkippedFile[];
  settings: ScanRun["settings"] & { exclude: string[]; concurrency: number };
  /** A delta: the last scan's sha it compares against, and how many of its
   * files are unchanged since but still owed a complete reading (never read,
   * cut short, unreadable before). Null for a full preview. `owed_shallow`
   * (a deep delta only): how many of those a complete standard reading covers
   * at this content — owed only because no deep reading does. */
  delta: { since: string; owed: number; owed_shallow?: number } | null;
  /** Why a start would be refused whatever the key. */
  blockers: string[];
}

export interface ScanStatus {
  ok: boolean;
  problems: string[];
  run: (ScanRun & { display: ScanRunState | "interrupted" }) | null;
  active: boolean;
  history: ScanRunSummary[];
  /** `files`: distinct paths stage 1 read; `deep_files`: distinct file × lens
   * pairs stage 2 read. */
  ledger: { files: number; deep_files: number; cost_usd: number } | null;
}

/** What `proposeStage2` answers. */
export type Stage2Proposal = StoredStage2Proposal;

const EPS = 1e-9;
const clean = (err: unknown): string => (err instanceof Error ? err.message : String(err));
/** The validator's variant at the tier of the lens it judges — never raised:
 * the scan validator is the skeptic, at the same tier. */
const validatorAgent = (tier: PassTier): string => `pass-validate--${tier}`;

/** Why a candidate the skeptic's answer never mentioned is doubtful. */
export const UNMENTIONED_REASON =
  "the skeptic listed it neither as a survivor nor under DOUBTED — kept, not upheld";

/** A finding on its way to the store, with the skeptic's judgement. */
interface KeptFinding {
  cand: ScanCandidate;
  code: string;
  quoted: boolean;
  validity: Validity | null;
  scenario: string | null;
  doubt: FindingDoubt | null;
}

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

type Stage2Planned =
  | {
      ok: true;
      proposal: StoredStage2Proposal;
      tree: ScanTree;
      settings: ScanSettings;
      cut: UnitCut;
    }
  | Refusal;

interface Planned {
  preview: ScanPreview;
  tree: ScanTree;
  settings: ScanSettings;
}

/** The run record, read totally: an unreadable file is the error beside an
 * empty record, never a throw (the portrait and the re-tune read it too). */
export function readRunFile(state: StateFs): { file: RunFile; error: string | null } {
  const empty: RunFile = { version: RUN_VERSION, current: null, history: [] };
  let text: string | null;
  try {
    text = state.read(RUN_FILE);
  } catch (err) {
    return { file: empty, error: `${RUN_FILE} in ${state.location} cannot be read: ${clean(err)}` };
  }
  if (text === null) return { file: empty, error: null };
  try {
    return { file: parseRunFile(text), error: null };
  } catch (err) {
    return {
      file: empty,
      error: `${RUN_FILE} in ${state.location} is not a scan record this version reads (${clean(err)}) — nothing will overwrite it; move it aside to scan again`,
    };
  }
}

export function runSummary(run: ScanRun, state: ScanRunSummary["state"]): ScanRunSummary {
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

/**
 * The scan runs that finished — complete, partial, stopped or capped —
 * newest first (what a portrait refresh and a re-tune stand on). A
 * run still `running` in the file is either live or was interrupted; neither
 * is a scan whose findings are settled.
 */
export function finishedRuns(state: StateFs): { runs: ScanRunSummary[]; error: string | null } {
  const { file, error } = readRunFile(state);
  const out: ScanRunSummary[] = [];
  if (file.current && file.current.state !== "running")
    out.push(runSummary(file.current, file.current.state));
  for (const h of file.history) {
    if (h.state !== "running" && h.state !== "interrupted" && !out.some((r) => r.id === h.id))
      out.push(h);
  }
  out.sort((a, b) => (b.finished_at ?? b.started_at).localeCompare(a.finished_at ?? a.started_at));
  return { runs: out, error };
}

export class ScanRunner {
  private active: { id: string; sha: string; abort: AbortController; done: Promise<void> } | null =
    null;
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
    return readRunFile(this.ports.state);
  }

  private store(file: RunFile): void {
    this.ports.state.write(RUN_FILE, `${JSON.stringify(file, null, 1)}\n`);
  }

  private summary(run: ScanRun, state: ScanRunSummary["state"]): ScanRunSummary {
    return runSummary(run, state);
  }

  // -- the plan --

  private async plan(
    ref: string | undefined,
    delta = false,
  ): Promise<{ ok: true; planned: Planned } | Refusal> {
    const s = this.ports.settings();
    if (!s.ok) return s;
    const cut = this.ports.savedCut();
    if (!cut.ok) return cut;
    const wanted = (ref ?? "").trim() || "HEAD";
    const sha = this.ports.source.resolve(wanted);
    if (sha === null)
      return {
        ok: false,
        errors: [`${JSON.stringify(wanted)} names no commit in ${this.ports.source.location}`],
      };
    const opened = this.ports.source.open(sha, this.active ? [this.active.sha] : []);
    if (!opened.ok)
      return {
        ok: false,
        errors: [`cannot read the tree at ${sha.slice(0, 12)}: ${opened.reason}`],
      };
    const tree = opened.tree;
    const { entries, error } = this.ledger.load();
    if (error !== null) return { ok: false, errors: [error] };
    const settings = s.settings;
    const cfg = settings.scan;
    const depth = cfg.depth;
    // A delta compares against the last scan: each file's newest content the
    // ledger read, and the tree that scan read (listed, not materialised).
    let basis: { since: string; read: Map<string, string>; baseline: Map<string, string> } | null =
      null;
    if (delta) {
      const last = lastScanned(entries, SCAN_PASS);
      if (last === null)
        return {
          ok: false,
          errors: ["no stage-1 scan to re-scan against — preview and run a full scan first"],
        };
      const listed = this.ports.source.list(last.sha);
      if (listed === null) {
        return {
          ok: false,
          errors: [
            `cannot list the tree the last scan read (${last.sha.slice(0, 12)}) — a delta cannot tell which files are new`,
          ],
        };
      }
      basis = {
        since: last.sha,
        read: newestRead(entries, SCAN_PASS),
        baseline: new Map(listed.map((f) => [f.path, f.blob])),
      };
    }
    const plan = planStage1({
      cut: cut.cut,
      files: tree.files,
      linesOf: (p) => tree.lines(p),
      whyUnreadable: (p) => tree.whyUnreadable?.(p) ?? null,
      // Coverage at the run's depth: a deep run reads again what only a
      // standard reading covers.
      covered: coveredBy(entries, SCAN_PASS, depth),
      partial: partialRanges(entries, SCAN_PASS, depth),
      // Coverage first: never-read and cut-short files run before changed
      // ones, so the hard stop never starves the same tail run after run.
      history: new Map(
        [...readings(entries, SCAN_PASS, depth)].map(([path, r]) => [
          path,
          { blob: r.blob, complete: r.complete, at: r.newest.at },
        ]),
      ),
      textOf: (p) => tree.read(p),
      exclude: cfg.exclude,
      budget: { maxFiles: cfg.case_max_files, maxLines: cfg.case_max_lines },
      ...(basis ? { delta: basis } : {}),
    });
    const key: RateKey = {
      lens: SCAN_PASS,
      tier: cfg.tier,
      effort: cfg.effort,
      validator: cfg.validator,
    };
    // Priced at the run's depth; from readings at the other depth only when
    // none at this one is priced yet (and the preview says so).
    const own = measuredRate(entries, { ...key, depth });
    const rate = own ?? measuredRate(entries, key);
    const tally = casesFor(entries, key);
    const measured = rate?.cases ?? 0;
    const blockers: string[] = [];
    // Calibrated once `calibration_units` priced cases stand behind the rate —
    // or every case there is, on a repo smaller than that.
    const calibrated =
      rate !== null && measured >= Math.min(cfg.calibration_units, measured + plan.cases.length);
    let mode: ScanMode;
    let cases: Array<ScanCasePlan & { estimate_usd: number | null }>;
    let cap: number;
    let estimate: number | null;
    if (delta) {
      // Priced like stage 1 — a delta never calibrates, and never guesses.
      mode = "delta";
      if (rate === null) {
        blockers.push(
          "no measured price for stage 1 at these settings — run the calibration (an ordinary preview) before a delta re-scan",
        );
      }
      cases = plan.cases.map((c) => ({
        ...c,
        estimate_usd: rate === null ? null : caseEstimate(c.lines, rate),
      }));
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
      cases = calibrationCases(plan.cases, Math.max(1, cfg.calibration_units - measured)).map(
        (c) => ({ ...c, estimate_usd: null }),
      );
      estimate = null;
      cap = cfg.calibration_max_usd;
    }
    if (cases.length === 0 && delta) {
      blockers.push(
        `nothing changed to read at ${sha.slice(0, 12)} since the last scan (${basis!.since.slice(0, 12)}), and the ledger covers every other file at its content`,
      );
    } else if (cases.length === 0) {
      blockers.push(
        plan.covered > 0
          ? `nothing left to read at ${sha.slice(0, 12)}: the ledger already covers every stage-1 file at this content`
          : "nothing to read: no unit of the saved cut owns a readable, non-excluded file",
      );
    }
    // A deep delta owes an unchanged file a standard reading already covers
    // only because no deep one does: counted apart, so the preview says so.
    const owedShallow = (b: NonNullable<typeof basis>): { owed_shallow?: number } => {
      if (depth !== "deep") return {};
      const standard = coveredBy(entries, SCAN_PASS, "standard");
      const seen = new Set<string>();
      for (const c of plan.cases)
        for (const f of c.files)
          if (!changedSince(f, b) && standard.has(coverKey(f.path, f.blob))) seen.add(f.path);
      return { owed_shallow: seen.size };
    };
    const runSettings: ScanRun["settings"] = {
      tier: cfg.tier,
      effort: cfg.effort,
      validator: cfg.validator,
      validate_tier: cfg.validator ? cfg.tier : null,
      ...(depth === "deep" ? { depth } : {}),
    };
    const preview: ScanPreview = {
      key: planKey({
        mode,
        sha,
        cases: cases.map((c) => [
          c.id,
          c.files.map(
            (f) => `${f.path}@${f.blob}${f.range ? `:${f.range.start}-${f.range.end}` : ""}`,
          ),
        ]),
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
      depth,
      rate_across_depth: own === null && rate !== null,
      calibration: { measured, wanted: cfg.calibration_units },
      remaining_cases: mode === "calibration" ? plan.cases.length - cases.length : 0,
      excluded: plan.excluded,
      covered: plan.covered,
      unassigned: plan.unassigned,
      unreadable: plan.unreadable,
      skipped: plan.skipped,
      settings: { ...runSettings, exclude: cfg.exclude, concurrency: cfg.concurrency },
      delta: basis ? { since: basis.since, owed: plan.owed, ...owedShallow(basis) } : null,
      blockers,
    };
    return { ok: true, planned: { preview, tree, settings } };
  }

  // -- the four verbs --

  /** What a scan would read and cost now at `sha` (default the checkout's
   * HEAD), and the key a start must quote. */
  async preview(
    args: { sha?: string; delta?: boolean } = {},
  ): Promise<{ ok: true; preview: ScanPreview } | Refusal> {
    const p = await this.plan(args.sha, args.delta === true);
    return p.ok ? { ok: true, preview: p.planned.preview } : p;
  }

  /** Start the previewed run in the background. Returns once it is recorded. */
  async start(args: {
    key?: unknown;
    sha?: string;
    delta?: boolean;
  }): Promise<{ ok: true; run: ScanRun } | Refusal> {
    if (this.active)
      return {
        ok: false,
        errors: [`scan ${this.active.id} is still running — stop it or wait for it`],
      };
    // Two starts in parallel (a model may issue tool calls concurrently) must
    // not both pass the check above while the first is still planning: that
    // would run — and pay for — the same scan twice.
    if (this.starting)
      return {
        ok: false,
        errors: ["a scan is already starting — wait for it, then check scan_status"],
      };
    if (typeof args.key !== "string" || args.key === "") {
      return {
        ok: false,
        errors: [
          "no preview key — preview the scan, show the operator the cost, then start with its key",
        ],
      };
    }
    this.starting = true;
    try {
      return await this.startPlanned(args.key, args.sha, args.delta === true);
    } finally {
      this.starting = false;
    }
  }

  private async startPlanned(
    key: string,
    sha: string | undefined,
    delta: boolean,
  ): Promise<{ ok: true; run: ScanRun } | Refusal> {
    const args = { key, sha };
    const p = await this.plan(args.sha, delta);
    if (!p.ok) return p;
    const { preview, tree, settings } = p.planned;
    if (args.key !== preview.key) {
      return {
        ok: false,
        errors: [
          `the plan changed since that preview (key ${args.key}, now ${preview.key}) — preview again and show the operator the new cost`,
        ],
      };
    }
    if (preview.blockers.length > 0) return { ok: false, errors: preview.blockers };
    const { file, error } = this.load();
    if (error !== null) return { ok: false, errors: [error] };
    const built = this.ports.buildAgents(settings);
    if (!built.ok)
      return {
        ok: false,
        errors: built.errors.map((e) => `the scan agents could not be built: ${e}`),
      };

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
    const run = this.launch(
      file,
      {
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
          ...(preview.settings.depth ? { depth: preview.settings.depth } : {}),
        },
      },
      jobs,
      tree,
      settings,
    );
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
      id: `scan-${now
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d+Z$/, "Z")}`,
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
        ...(c.files.some((f) => f.range)
          ? { ranges: c.files.filter((f) => f.range).map((f) => ({ path: f.path, ...f.range! })) }
          : {}),
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
        ...(head.mode === "stage2"
          ? { lens: job.lens, tier: job.tier, reason: job.reason, units: job.units }
          : {}),
      })),
      problems: [],
      matching: null,
    };
    // A run left `running` by a companion that is gone was interrupted.
    if (file.current !== null) {
      const prev = file.current;
      file.history = [
        this.summary(prev, prev.state === "running" ? "interrupted" : prev.state),
        ...file.history,
      ].slice(0, RUN_HISTORY);
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
      run:
        run === null
          ? null
          : {
              ...run,
              display:
                run.state === "running" && this.active?.id !== run.id ? "interrupted" : run.state,
            },
      active: this.active !== null,
      history: file.history,
      ledger:
        ledger.error !== null
          ? null
          : {
              // Distinct files (and file × lens pairs): a file read at two
              // contents, two depths or in ranges is still one file.
              files: new Set(ledger.entries.filter((e) => e.lens === SCAN_PASS).map((e) => e.path))
                .size,
              deep_files: new Set(
                ledger.entries
                  .filter((e) => e.lens !== SCAN_PASS)
                  .map((e) => `${e.lens}\0${e.path}`),
              ).size,
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
      if (raw.version !== RUN_VERSION || !Array.isArray(raw.suggestions))
        throw new Error("not a version-1 suggestions file");
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

  /** Plan the companion's rows at `deep` (true / false), or at `[scan] depth`
   * when it is undefined; the settings returned carry that depth, so the
   * build and the run are at it too. */
  private async planStage2(
    request: Stage2RowRequest[],
    budgetUsd: number | null,
    ref: string | undefined,
    deep: boolean | undefined,
  ): Promise<Stage2Planned> {
    const s = this.ports.settings();
    if (!s.ok) return s;
    const cut = this.ports.savedCut();
    if (!cut.ok) return cut;
    const wanted = (ref ?? "").trim() || "HEAD";
    const sha = this.ports.source.resolve(wanted);
    if (sha === null)
      return {
        ok: false,
        errors: [`${JSON.stringify(wanted)} names no commit in ${this.ports.source.location}`],
      };
    const opened = this.ports.source.open(sha, this.active ? [this.active.sha] : []);
    if (!opened.ok)
      return {
        ok: false,
        errors: [`cannot read the tree at ${sha.slice(0, 12)}: ${opened.reason}`],
      };
    const tree = opened.tree;
    const { entries, error } = this.ledger.load();
    if (error !== null) return { ok: false, errors: [error] };
    const depth: ScanDepth =
      deep === undefined ? s.settings.scan.depth : deep ? "deep" : "standard";
    const settings: ScanSettings = { ...s.settings, scan: { ...s.settings.scan, depth } };
    const cfg = settings.scan;
    const plan = planStage2({
      rows: request,
      cut: cut.cut,
      files: tree.files,
      linesOf: (p) => tree.lines(p),
      whyUnreadable: (p) => tree.whyUnreadable?.(p) ?? null,
      textOf: (p) => tree.read(p),
      exclude: cfg.exclude,
      budget: { maxFiles: cfg.case_max_files, maxLines: cfg.case_max_lines },
      lenses: settings.lenses,
      riskPasses: settings.riskPasses ?? [],
      defaultTier: cfg.tier,
      covered: (lens) => coveredBy(entries, lens, depth),
      partial: (lens) => partialRanges(entries, lens, depth),
      price: (lens, tier, effort) => priceStage2Row(entries, cfg, lens, tier, effort, depth),
      budgetUsd,
      ...(depth === "deep" ? { floor: cfg.deep_lenses } : {}),
    });
    if (!plan.ok) return { ok: false, errors: plan.errors };
    const runnable = plan.rows.filter((r) => r.status === "run");
    const key = stage2Key({
      sha,
      rows: runnable.map((r) => [
        r.id,
        r.lens,
        r.tier,
        r.effort,
        [...r.files, ...r.tests].map((f) => `${f.path}@${f.blob}`),
        ...(r.ranges ? [r.ranges.map((x) => `${x.start}-${x.end}`)] : []),
      ]),
      validator: cfg.validator,
      cap: Math.round(plan.total_usd * 1e6),
      ...(depth === "deep" ? { depth } : {}),
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
      depth,
      floor: plan.floor,
    };
    return { ok: true, proposal, tree, settings, cut: cut.cut };
  }

  /**
   * Plan and STORE a stage-2 proposal from the companion's rows: checked,
   * tests paired, priced from the ledger, fitted to `budget_usd` when given.
   * `deep` (true / false) sets its depth, else `[scan] depth`; a deep one adds
   * the floor after the companion's rows, which may then be none.
   * Runs nothing. The stored proposal replaces the previous one — it is what
   * the TUI shows and what a start's key must name.
   */
  async proposeStage2(args: {
    rows?: unknown;
    budget_usd?: unknown;
    sha?: string;
    deep?: unknown;
  }): Promise<{ ok: true; proposal: Stage2Proposal } | Refusal> {
    const rows = args.rows ?? [];
    if (!Array.isArray(rows))
      return { ok: false, errors: ["`rows` must be a list of { lens, files, tier?, reason }"] };
    if (args.deep !== undefined && args.deep !== null && typeof args.deep !== "boolean")
      return { ok: false, errors: ["`deep` must be true or false (or left out)"] };
    const deep = typeof args.deep === "boolean" ? args.deep : undefined;
    const request: Stage2RowRequest[] = [];
    for (const [i, r] of rows.entries()) {
      if (typeof r !== "object" || r === null || Array.isArray(r))
        return { ok: false, errors: [`row-${i + 1}: not a { lens, files, tier?, reason } object`] };
      const o = r as Record<string, unknown>;
      request.push({
        lens: typeof o.lens === "string" ? o.lens : "",
        files: Array.isArray(o.files)
          ? o.files.filter((f): f is string => typeof f === "string")
          : typeof o.files === "string"
            ? o.files.split(",")
            : [],
        ...(typeof o.tier === "string" && o.tier.trim() !== "" ? { tier: o.tier.trim() } : {}),
        reason: typeof o.reason === "string" ? o.reason : "",
      });
    }
    let budget: number | null = null;
    if (args.budget_usd !== undefined && args.budget_usd !== null) {
      if (
        typeof args.budget_usd !== "number" ||
        !Number.isFinite(args.budget_usd) ||
        args.budget_usd <= 0
      ) {
        return {
          ok: false,
          errors: ["`budget_usd` must be a positive number of dollars (or left out)"],
        };
      }
      budget = args.budget_usd;
    }
    const p = await this.planStage2(request, budget, args.sha, deep);
    if (!p.ok) return p;
    try {
      this.ports.state.write(
        STAGE2_FILE,
        `${JSON.stringify({ version: STAGE2_VERSION, proposal: p.proposal }, null, 1)}\n`,
      );
    } catch (err) {
      return { ok: false, errors: [`the proposal could not be stored: ${clean(err)}`] };
    }
    return { ok: true, proposal: p.proposal };
  }

  /**
   * Start the stored stage-2 proposal whose key is quoted — on the
   * operator's word (the companion) or their click (the TUI, through
   * `consumeStage2Request`). Re-planned first: a proposal that moved since it
   * was shown is refused. Hard stop at its estimate — or, when `rows` keeps
   * only some of its runnable rows (the TUI's plan pane), exactly
   * those rows, stopped hard at their total.
   */
  async startStage2(args: {
    key?: unknown;
    rows?: unknown;
  }): Promise<{ ok: true; run: ScanRun } | Refusal> {
    if (this.active)
      return {
        ok: false,
        errors: [`scan ${this.active.id} is still running — stop it or wait for it`],
      };
    if (this.starting)
      return {
        ok: false,
        errors: ["a scan is already starting — wait for it, then check scan_status"],
      };
    if (typeof args.key !== "string" || args.key === "") {
      return {
        ok: false,
        errors: [
          "no proposal key — propose stage 2, show the operator the rows and the cost, then start with its key",
        ],
      };
    }
    let keep: string[] | undefined;
    if (args.rows !== undefined && args.rows !== null) {
      if (
        !Array.isArray(args.rows) ||
        !args.rows.every((r): r is string => typeof r === "string")
      ) {
        return {
          ok: false,
          errors: ["`rows` must be a list of row ids from the proposal (`row-<n>` / `floor-<n>`)"],
        };
      }
      keep = args.rows;
    }
    this.starting = true;
    try {
      return await this.startStage2Planned(args.key, keep);
    } finally {
      this.starting = false;
    }
  }

  private async startStage2Planned(
    key: string,
    keep: readonly string[] | undefined,
  ): Promise<{ ok: true; run: ScanRun } | Refusal> {
    const stored = this.stage2Proposal();
    if (stored.error !== null) return { ok: false, errors: [stored.error] };
    if (stored.proposal === null)
      return { ok: false, errors: ["no stage 2 proposal — propose one first"] };
    if (stored.proposal.key !== key) {
      return {
        ok: false,
        errors: [
          `${key} is not the latest stage 2 proposal (that is ${stored.proposal.key}) — show the operator the latest one`,
        ],
      };
    }
    // At the depth it was made at, whatever `[scan] depth` says now.
    const p = await this.planStage2(
      stored.proposal.request,
      stored.proposal.budget_usd,
      stored.proposal.sha,
      proposalDepth(stored.proposal) === "deep",
    );
    if (!p.ok) return p;
    if (p.proposal.key !== key) {
      return {
        ok: false,
        errors: [
          `the plan changed since the proposal (key ${key}, now ${p.proposal.key}: a file, a price or the settings moved) — propose again and show the operator the new cost`,
        ],
      };
    }
    if (!p.proposal.rows.some((r) => r.status === "run")) {
      return {
        ok: false,
        errors: ["nothing to run: every row is covered by the ledger or over the budget"],
      };
    }
    const kept = keptRows(p.proposal.rows, keep);
    if (!kept.ok) return kept;
    const rows = kept.rows;
    const cap = kept.cap_usd ?? p.proposal.cap_usd;
    const { file, error } = this.load();
    if (error !== null) return { ok: false, errors: [error] };
    const built = this.ports.buildAgents(p.settings);
    if (!built.ok)
      return {
        ok: false,
        errors: built.errors.map((e) => `the scan agents could not be built: ${e}`),
      };
    const unitOf = unitOwner(
      p.cut,
      p.tree.files.map((f) => f.path),
    );
    // What stage 1 pointed each row's lens at in its files rides the case's
    // prompt. An unreadable suggestions file is a problem on the run, never a
    // refused start: the leads are help, not the plan.
    const leadSource = this.suggestions();
    const leadsOf = (row: Stage2Row) => stage2Leads(row, leadSource.suggestions);
    // One case per row — or, for a row over a file too big for one case, one
    // per line range (`<row>#<i>`), its estimate the range's share.
    const jobs: CaseJob[] = rows.flatMap((row: Stage2Row) =>
      stage2Cases(row).map((c) => ({
        plan: {
          unit: row.units.join("+"),
          id: c.id,
          part: c.part,
          parts: c.parts,
          files: c.files,
          lines: c.lines,
          estimate_usd: row.lines > 0 ? (row.estimate_usd * c.lines) / row.lines : row.estimate_usd,
        },
        lens: row.lens,
        tier: row.tier,
        effort: row.effort,
        prompt: (ctx: PromptContext) => stage2CasePrompt(row, ctx, c.files, leadsOf(row)),
        label: `stage 2, ${c.id} (${row.lens})`,
        unitOf,
        suggestions: false,
        reason: row.reason,
        units: row.units,
      })),
    );
    const cfg = p.settings.scan;
    const top = rows.reduce<PassTier>(
      (t, r) => (PASS_TIER_ORDER.indexOf(r.tier) > PASS_TIER_ORDER.indexOf(t) ? r.tier : t),
      rows[0]!.tier,
    );
    const run = this.launch(
      file,
      {
        mode: "stage2",
        sha: p.proposal.sha,
        plan_key: key,
        cap_usd: cap,
        estimate_usd: cap,
        settings: {
          tier: top,
          effort: "per row",
          validator: cfg.validator,
          validate_tier: cfg.validator ? top : null,
          ...(cfg.depth === "deep" ? { depth: cfg.depth } : {}),
        },
      },
      jobs,
      p.tree,
      p.settings,
    );
    if (leadSource.error !== null) {
      run.problems.push(`stage-1 leads not carried into the cases: ${leadSource.error}`);
      this.store(file);
    }
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
      const r = await this.startStage2({
        key: req.key,
        ...(req.rows !== undefined ? { rows: req.rows } : {}),
      });
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
      this.ports.log?.(
        `setup: the TUI asked to start stage 2 (${req.key}): ${r.ok ? `started ${r.run.id}` : r.errors.join("; ")}`,
      );
      return result;
    } finally {
      this.consuming = false;
    }
  }

  /**
   * Answer the TUI's stop request (scanreport.ts), if there is one
   * not yet answered: stop the run it names when that is the run in flight
   * here, and write the outcome to `SCAN_STOP_RESULT_FILE`. A request naming
   * another run — or arriving when nothing runs in this companion (a run
   * recorded as running that nobody is driving is already interrupted) — is
   * refused, never aimed at whatever runs now. Answered once.
   */
  consumeStopRequest(): ScanStopResult | null {
    let text: string | null;
    try {
      text = this.ports.state.read(SCAN_STOP_FILE);
    } catch (err) {
      this.ports.log?.(`setup: ${SCAN_STOP_FILE} cannot be read: ${clean(err)}`);
      return null;
    }
    const req = text === null ? null : parseStopRequest(text);
    if (req === null) return null;
    let prev: string | null = null;
    try {
      prev = this.ports.state.read(SCAN_STOP_RESULT_FILE);
    } catch {
      // Unreadable: answer again rather than never.
    }
    if (prev !== null && parseStopResult(prev)?.request === req.id) return null;
    const inFlight = this.active?.id ?? null;
    const errors: string[] = [];
    if (!this.active)
      errors.push(
        `no scan is running in this companion — ${req.run} is not in flight, so there is nothing to stop (the ledger resumes it when started again)`,
      );
    else if (this.active.id !== req.run)
      errors.push(
        `the scan in flight is ${this.active.id}, not ${req.run} — look at the report again`,
      );
    else this.stop();
    const result: ScanStopResult = {
      request: req.id,
      run: req.run,
      at: this.ports.clock().toISOString(),
      ok: errors.length === 0,
      errors,
      in_flight: inFlight,
    };
    try {
      this.ports.state.write(SCAN_STOP_RESULT_FILE, `${JSON.stringify(result)}\n`);
    } catch (err) {
      this.ports.log?.(`setup: the scan stop result could not be written: ${clean(err)}`);
    }
    this.ports.log?.(
      `setup: the TUI asked to stop ${req.run}: ${result.ok ? "stopped" : errors.join("; ")}`,
    );
    return result;
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
      if (
        run.cap_usd > EPS &&
        !signal.aborted &&
        run.spent_usd + liveTotal() >= run.cap_usd - EPS
      ) {
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
        const spent = await this.runCase(file, run, job, tree, settings, signal, (v) =>
          onCost(plan.id, v),
        );
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
    for (const c of run.cases)
      if (c.status === "pending") c.status = capHit ? "skipped" : "stopped";
    this.reconcile(run, tree);
    await this.closeFixedTickets(run);
    const allDone = run.cases.every((c) => c.status === "done");
    this.settle(
      file,
      run,
      allDone ? "complete" : capHit ? "capped" : signal.aborted ? "stopped" : "partial",
    );
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
    const report =
      (base: number) =>
      (v: number): void => {
        seen = Math.max(seen, base + v);
        onCost(seen);
      };
    const outcome = await this.runOne(
      {
        id: ctx.caseId,
        unit: plan.unit,
        agent: `${job.lens}--${job.tier}`,
        files: c.files,
        prompt: job.prompt(ctx),
      },
      signal,
      report(0),
    );
    addCost(outcome);
    if (outcome.transcript !== undefined) c.transcript = outcome.transcript;
    if (outcome.ok && outcome.reads !== undefined) c.reads = outcome.reads.length;
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
    // A lens that opened none of its files did not read the case, whatever it
    // answered: never coverage (no ledger row, so it is read again), never a
    // price sample (the rate comes from ledger rows), and its findings are
    // not stored — they were not drawn from the code. Said on the run, the
    // way a failed validator is, so a cheap empty lens cannot pass as a
    // quiet one.
    const unread = unreadFocus(
      outcome.reads,
      plan.files.map((f) => f.path),
      tree.root,
    );
    if (unread !== null) {
      run.problems.push(
        `case ${plan.id}: ${job.lens} — ${unread}; not a reading (not coverage, not a price sample) — it will be read again`,
      );
      return finish("failed", unread);
    }
    // Opened some of its files and not others: the others are not read.
    const focusPaths = [...new Set(plan.files.map((f) => f.path))];
    const opened = openedFocus(outcome.reads, focusPaths, tree.root);
    const unopened = opened === null ? [] : focusPaths.filter((p) => !opened.has(p));
    if (unopened.length > 0) {
      c.unopened = unopened;
      run.problems.push(
        `case ${plan.id}: ${job.lens} opened ${focusPaths.length - unopened.length} of its ${focusPaths.length} focus files — not opened: ${unopened.join(", ")}; those are not coverage and will be read again`,
      );
    }

    const inTree = new Set(tree.files.map((f) => f.path));
    // A file read in line ranges: this case reports only inside its range —
    // the neighbouring ranges are other cases' (scan.ts cutRanges).
    const rangeOf = new Map(plan.files.filter((f) => f.range).map((f) => [f.path, f.range!]));
    const outside = (cand: ScanCandidate): boolean => {
      const r = rangeOf.get(cand.path);
      return r !== undefined && (cand.end < r.start || cand.start > r.end);
    };
    const deep = settings.scan.depth === "deep";
    const answer = parseScanAnswer(outcome.output, {
      root: tree.root,
      ...(deep && job.suggestions ? { maxSuggestions: SCAN_DEEP_MAX_SUGGESTIONS } : {}),
    });
    // Only findings or an explicit NONE is a reading. Prose with neither (a
    // tool error told in words, a broken grammar) is not "nothing found",
    // and must never enter the ledger as clean coverage — that reading is
    // what settles earlier findings fixed.
    if (answer.candidates.length === 0 && !answer.none) {
      return finish("failed", "the lens answered with no finding and no NONE line");
    }
    let dropped = answer.dropped + answer.suggestions_dropped;
    const anchored: Array<{ cand: ScanCandidate; code: string; quoted: boolean }> = [];
    for (const cand of answer.candidates) {
      if (outside(cand)) {
        dropped++;
        continue;
      }
      const text = inTree.has(cand.path) ? tree.read(cand.path) : null;
      const lines = text === null ? null : anchoredLines(text, cand.start, cand.end);
      if (lines === null) {
        dropped++;
        continue;
      }
      anchored.push({
        cand,
        code: normalizeCode(lines),
        quoted: evidenceQuotesAnchor(cand.evidence, lines),
      });
    }

    // The validator, when this scan runs one, is the skeptic: at the tier of
    // the lens it judges, it sorts every
    // candidate into a validity tier — and kills none. A survivor is
    // `confirmed` (a traced scenario) or `likely`; a DOUBTED line, a KILLED
    // line and a candidate its answer never mentions are all kept `doubtful`,
    // so no kill path of the frozen validator can make a finding vanish. A
    // validator that failed judges nothing: its findings are kept with no
    // tier (unknown), never a guessed one.
    let validated = false;
    let kept: KeptFinding[] = anchored.map((a) => ({
      ...a,
      validity: null,
      scenario: null,
      doubt: null,
    }));
    if (settings.scan.validator && anchored.length > 0) {
      const v = await this.runOne(
        {
          id: `${ctx.caseId}/validate`,
          unit: plan.unit,
          agent: validatorAgent(job.tier),
          files: c.files,
          prompt: scanValidatorPrompt(
            plan,
            anchored.map((a) => a.cand),
            ctx,
            job.lens,
            job.label,
          ),
        },
        signal,
        report(cost ?? seen),
      );
      addCost(v);
      if (v.transcript !== undefined) c.validator_transcript = v.transcript;
      if (!v.ok && signal.aborted) return finish("stopped", v.reason);
      const read = v.ok ? parseValidatorAnswer(v.output, tree.root) : null;
      if (read === null || !read.answered) {
        const why = v.ok ? "it answered with no survivor, NONE, DOUBTED or KILLED" : v.reason;
        run.problems.push(
          `case ${plan.id}: the validator failed (${why}) — its findings are kept unvalidated`,
        );
      } else {
        validated = true;
        const judged: KeptFinding[] = [];
        // The candidate each survivor stands for — ONE per survivor: the same
        // file and overlapping lines, the same kind first. One survivor must
        // never stand for two candidates, or the one it did not mean (a
        // duplicate on the same lines, a neighbour of another kind) would be
        // neither upheld nor unmentioned — silently dropped, a kill.
        const upheld = new Set<ScanCandidate>();
        const standsFor = (s: ScanCandidate): ScanCandidate | undefined => {
          const open = anchored.filter(
            (a) =>
              !upheld.has(a.cand) &&
              a.cand.path === s.path &&
              a.cand.start <= s.end &&
              s.start <= a.cand.end,
          );
          return (open.find((a) => a.cand.kind === s.kind) ?? open[0])?.cand;
        };
        for (const s of read.survivors) {
          if (outside(s)) {
            dropped++;
            continue;
          }
          const text = inTree.has(s.path) ? tree.read(s.path) : null;
          const lines = text === null ? null : anchoredLines(text, s.start, s.end);
          if (lines === null) {
            dropped++;
            continue;
          }
          const meant = standsFor(s);
          if (meant) upheld.add(meant);
          judged.push({
            cand: s,
            code: normalizeCode(lines),
            quoted: evidenceQuotesAnchor(s.evidence, lines),
            validity: s.validity,
            scenario: s.scenario,
            doubt: null,
          });
        }
        // A doubt — or, in a scan, a kill — marks the candidate it names.
        const doubted = new Set<ScanCandidate>();
        for (const d of [...read.doubted, ...read.killed]) {
          const names = (a: (typeof anchored)[number]): boolean =>
            a.cand.path === d.path &&
            (d.line === null || (d.line >= a.cand.start && d.line <= a.cand.end)) &&
            !doubted.has(a.cand);
          // A candidate no survivor stands for first: two candidates on the
          // same lines (a duplicate the skeptic doubts beside the one it
          // upholds) must not have the doubt land on the upheld one — its
          // fingerprint would then turn the confirmed survivor doubtful and
          // leave the duplicate standing as "upheld".
          const hit = anchored.find((a) => names(a) && !upheld.has(a.cand)) ?? anchored.find(names);
          if (!hit) continue;
          doubted.add(hit.cand);
          judged.push({
            ...hit,
            validity: "doubtful",
            scenario: null,
            doubt: { word: d.word, reason: d.reason, class: d.class },
          });
        }
        // Never mentioned — neither upheld nor doubted: kept, doubtful.
        for (const a of anchored) {
          if (upheld.has(a.cand) || doubted.has(a.cand)) continue;
          judged.push({
            ...a,
            validity: "doubtful",
            scenario: null,
            doubt: { word: "not-upheld", reason: UNMENTIONED_REASON, class: null },
          });
        }
        kept = judged;
      }
    }

    const blobOf = new Map(tree.files.map((f) => [f.path, f.blob]));
    const all: ReportedFinding[] = kept.map(
      ({ cand, code, quoted, validity, scenario, doubt }) => ({
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
        reachability: cand.reachability,
        capped_from: cand.capped_from,
        anchor_quoted: quoted,
        claim: cand.claim,
        evidence: cand.evidence,
        fix: cand.fix,
        detail: cand.detail,
        validated,
        doubt,
        validity,
        scenario,
      }),
    );
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
    c.confirmed = reported.filter((r) => r.validity === "confirmed").length;
    c.likely = reported.filter((r) => r.validity === "likely").length;

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
    // Each row keeps its share of the WHOLE case's cost, so leaving out a file
    // the lens never opened leaves the rate per line what the case measured.
    const total = plan.files.reduce((n, f) => n + Math.max(f.lines, 1), 0);
    const notRead = new Set(unopened);
    const rows: LedgerEntry[] = plan.files
      .filter((f) => !notRead.has(f.path))
      .map((f) => ({
        path: f.path,
        blob: f.blob,
        lens: job.lens,
        ...(f.range ? { range: f.range } : {}),
        tier: job.tier,
        effort: job.effort,
        validator: settings.scan.validator,
        ...(deep ? { depth: "deep" as const } : {}),
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
      run.problems.push(
        `case ${plan.id}: the ledger refused its rows (${clean(err)}) — it will be read again`,
      );
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

  private storeSuggestions(
    run: ScanRun,
    unit: string,
    found: readonly ScanSuggestion[],
    at: string,
  ): void {
    if (found.length === 0) return;
    const { suggestions, error } = this.suggestions();
    if (error !== null) {
      run.problems.push(`deep-lens suggestions not stored: ${error}`);
      return;
    }
    const key = (s: { unit: string; lens: string; files: string[] }): string =>
      `${s.unit}\0${s.lens}\0${[...s.files].sort().join(",")}`;
    const byKey = new Map(suggestions.map((s) => [key(s), s]));
    for (const s of found) {
      const row: StoredSuggestion = { ...s, unit, sha: run.sha, run: run.id, at };
      byKey.set(key(row), row);
    }
    try {
      this.ports.state.write(
        SUGGESTIONS_FILE,
        `${JSON.stringify({ version: RUN_VERSION, suggestions: [...byKey.values()] }, null, 1)}\n`,
      );
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
        blobs: new Map(tree.files.map((f) => [f.path, f.blob])),
        run: { run: run.id, sha: run.sha, at: this.ports.clock().toISOString() },
      });
    } catch (err) {
      run.problems.push(
        `the findings were not reconciled (${clean(err)}) — the next run's end does it`,
      );
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
      run.problems.push(
        `the fixed findings' tickets were not closed (${clean(err)}) — the next run's end retries`,
      );
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

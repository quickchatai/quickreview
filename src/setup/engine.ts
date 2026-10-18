// SetupEngine — the deterministic half of setup & scan. The onboarding
// engine's pattern (src/onboard/engine.ts): a state machine with every outside
// effect behind an injected port, fully drivable from tests, and a thin pi
// tool belt over it (extensions/setup.ts, loaded by the companion). The
// companion judges — which units a repo has, what a finding means — and these
// tools act: what they do with its answers is deterministic, validated, and
// persisted here.
//
// Behaviours: the deterministic repo facts and the unit cut, the survey
// (preview, start, status, stop; the run itself is surveyrun.ts, its rules
// survey.ts), the review history themes (history.ts), the repo portrait
// (portrait.ts — facts assembled here, the companion's narrative stored in the
// config home), the interview's tuning (tuning.ts — the priority table
// applied to the repo profile, validated with the daemon's own loaders; pin
// proposals handed to the operator) and the post-scan re-tune (retune.ts —
// the same profile path, every change with its reason, logged for the deploy
// tab). The scan's own records and triage live beside it (scanrun.ts,
// findings.ts, triage.ts) over the same ports: the tracker sink is
// trackersink.ts's. The GitHub reader port is declared and injected, but no
// engine behaviour calls it yet (the PR replay builds its own reader).
//
// Persistence: `<state home>/setup/unit-cut.json`, tmp+rename atomic through
// the state port. It holds the saved cut (the one survey and scan reuse), the
// previous saved cut (so a re-cut can be compared and undone), and at most one
// draft (the companion's proposal as the operator adjusts it). A saved cut is
// never touched by a propose or an adjust — only `save` replaces it. An
// unreadable file is reported and refuses every write: it may hold the
// operator's saved cut, and silently starting fresh over it would lose that.
import { isSampleable } from "./survey.js";
import type { MemoryStore } from "../memory/store.js";
import { isSweepSkipped } from "../heuristics.js";
import {
  repoFacts,
  unitCandidates,
  vendoredRoots,
  type RepoFacts,
  type UnitCandidate,
} from "./facts.js";
import {
  SurveyRunner,
  type SurveyInputs,
  type SurveyPreview,
  type SurveyRun,
  type SurveyStatus,
} from "./surveyrun.js";
import {
  historyPage,
  historyThemesState,
  readDigest,
  saveHistoryThemes,
  summarize,
  type HistorySection,
  type HistorySummary,
  type HistoryThemesFile,
  type SaveThemesResult,
} from "./history.js";
import {
  readPortrait,
  saveFacts,
  storeNarrative,
  type AssembleResult,
  type PortraitFacts,
  type PortraitView,
  type StoreNarrativeResult,
} from "./portrait.js";
import type { ProfileHome } from "./profile.js";
import { retune, type RetuneInput, type RetuneResult } from "./retune.js";
import { scanFacts } from "./scanfacts.js";
import {
  profileApply,
  profileStatus,
  profileValidate,
  proposePins,
  type ApplyInput,
  type ApplyResult,
  type PinProposeResult,
  type ProfileStatus,
} from "./tuning.js";
import type { ProfileCheck } from "./profile.js";
import {
  DEFAULT_CASE_BUDGET,
  applyOps,
  assign,
  checkCut,
  normalizeCut,
  splitUnit,
  type CaseBudget,
  type CasePlan,
  type UnitCut,
} from "./unitcut.js";

// ---- ports -------------------------------------------------------------------

/** The reviewed checkout, read-only (the companion mounts it `:ro`). Every
 * method is total: an unreadable checkout answers null, never throws. */
export interface RepoReader {
  /** Where the checkout is, for messages. */
  readonly location: string;
  /** Repo-relative paths of every tracked file, or null when there is no
   * readable checkout. */
  listFiles(): string[] | null;
  /** A file's text, or null (missing, binary, over the reader's size cap). */
  read(rel: string): string | null;
  /** A file's line count (0 for an empty file), or null when unreadable. */
  lines(rel: string): number | null;
  /** The checked-out commit, or null when it cannot be read. */
  head(): string | null;
  /** Commits touching each file over the recent history — the survey's
   * "most-changed" sample. Optional and total: absent or null when
   * the history cannot be read, which only empties that one reason. */
  changeCounts?(): Record<string, number> | null;
}

/** The filesystem rooted at the install's state home — PC-only, never shipped.
 * Paths are relative to that root; the implementation refuses any that would
 * leave it. The same shape roots the config home (`SetupPorts.config`). */
export interface StateFs {
  readonly location: string;
  /** The file's text, or null when it does not exist. Throws only when it
   * exists and cannot be read — the caller reports that, never overwrites. */
  read(rel: string): string | null;
  /** tmp+rename atomic write; creates parent directories. */
  write(rel: string, text: string): void;
}

/** One case: a unit (or part of one) handed to background pi subagents inside
 * the companion. */
export interface CaseSpec {
  id: string;
  unit: string;
  agent: string;
  files: string[];
  prompt: string;
}

/** How a case ended: the lens's final answer and what it cost (null when
 * the runner could not tell), or why there is none. A failed or aborted case
 * may still have spent money: `cost_usd` on a failure is what it spent before
 * it ended (0 when it never started, null or absent when the runner cannot
 * tell) — a caller holding a budget counts it. */
export type CaseOutcome =
  | {
      ok: true;
      output: string;
      cost_usd: number | null;
      /** The files the case's file-read tool calls opened (`read`, and
       * `grep` given a `path`), in call order, each resolved to the absolute
       * path the call opened (against the case's working directory, which is
       * not the scanned tree) — `[]` when it read nothing. Absent when the
       * runner cannot tell, which is unknown, never "read nothing". The scan
       * judges a lens that read none of its focus files as no reading at all. */
      reads?: string[];
      /** Where the runner kept the case's event stream, relative to its
       * transcript directory; absent when it kept none. */
      transcript?: string;
    }
  | { ok: false; reason: string; cost_usd?: number | null; transcript?: string };

/** Runs cases as background subagents (survey, scan). The
 * engine decides what runs when and how many at once; the runner runs one
 * case to its end. Resolves for every outcome — a failed or aborted case is
 * `{ok:false}`, never a rejection. `onCost`, when given, hears the case's
 * running cost each time the runner learns more of it, so a caller with a
 * hard cap can abort a case mid-flight rather than after the fact. */
export interface CaseRunner {
  run(
    spec: CaseSpec,
    signal: AbortSignal,
    onCost?: (spentSoFar: number) => void,
  ): Promise<CaseOutcome>;
}

export interface TrackerTicket {
  title: string;
  body: string;
  /** The effort the ticket belongs in (the companion picks the one that fits). */
  effort: string;
  /** Stamped on the ticket, so a finding is never filed twice. */
  fingerprint: string;
  /** Fingerprints the finding carried before a match — a ticket stamped with
   * one of them is the same finding's. */
  aliases?: string[];
  /** The tracker's `Category:` — `bug` when absent. */
  category?: "bug" | "enhancement";
}

/** Filed or closed: the sink's reference, and `existing` when nothing new was
 * written — a ticket already stamped with the fingerprint, or one already
 * closed. */
export type SinkResult =
  { ok: true; ref: string; existing?: boolean } | { ok: false; reason: string };

/** Where a promoted finding goes (trackersink.ts): the issue
 * tracker, or one markdown file per finding in the state home when the
 * install has none. `kind` is recorded on the finding, so a close goes back
 * to the sink that filed it. `close` closes only a ticket this sink filed. */
export interface TrackerSink {
  readonly kind: string;
  file(ticket: TrackerTicket): Promise<SinkResult>;
  close(ref: string, note: string): Promise<SinkResult>;
}

export type GitHubRead = { ok: true; data: unknown } | { ok: false; reason: string };

/** GitHub, read-only: the interface has no method that could write — a GET of
 * a REST path under the API root, and nothing else. */
export interface GitHubReader {
  get(path: string): Promise<GitHubRead>;
}

export interface SetupPorts {
  repo: RepoReader;
  state: StateFs;
  /** The install's config home, where the operator-facing results live (the
   * portrait narrative). Absent or null when this assembly has none
   * — every write there then answers a refusal naming why. In the companion
   * only some of it is mounted: code writes only under a mounted directory
   * (`portrait/`), never at the root. */
  config?: StateFs | null;
  /** Where the repo profile is read, checked and written: the app
   * checkout (for the generic examples a profile extends) and the install
   * environment whose config home holds `profiles/`. Real paths, because the
   * check is the daemon's own loaders, which read disk. Absent or null when
   * this assembly has none — every profile tool then refuses, naming why. */
  profiles?: ProfileHome | null;
  clock: () => Date;
  /** The one memory seam. Null when this assembly has no memory — every
   * memory write then answers a refusal naming why. */
  memory: MemoryStore | null;
  cases: CaseRunner;
  tracker?: TrackerSink;
  github?: GitHubReader;
  log?: (line: string) => void;
}

export interface SetupOptions {
  /** How much one case of the unit view and the survey may read (the scan
   * sizes its own cases from `[scan]`). */
  caseBudget?: CaseBudget;
  /** Survey cases in flight at once (the companion passes its subagent cap). */
  surveyConcurrency?: number;
}

// ---- the persisted file ------------------------------------------------------

export const UNIT_CUT_FILE = "setup/unit-cut.json";
export const UNIT_CUT_VERSION = 1;

export interface SavedCut extends UnitCut {
  saved_at: string;
  /** The commit the cut was checked against, when readable. */
  head: string | null;
  /** How many files the cut covered at save — a later listing that differs is
   * how a stale cut shows itself. */
  files: number;
}

export interface DraftCut extends UnitCut {
  updated_at: string;
  /** `candidates` = the deterministic guess taken as-is; `companion` = a
   * proposal the companion wrote; `adjusted` = either, after operator edits. */
  source: "candidates" | "companion" | "adjusted";
}

export interface UnitCutFile {
  version: number;
  saved: SavedCut | null;
  previous: SavedCut | null;
  draft: DraftCut | null;
}

// ---- results -----------------------------------------------------------------

export type Refusal = { ok: false; errors: string[] };

export interface UnitSummary {
  name: string;
  kind: string;
  roots: string[];
  note: string;
  files: number | null;
  /** Files a pass would actually read (lockfiles, binaries, prose skipped). */
  reviewable: number | null;
  lines: number | null;
  /** One per case; a unit that fits is one case under its own name. */
  cases: Array<{ id: string; files: number; lines: number; over_budget: boolean }> | null;
}

export interface CutView {
  units: UnitSummary[];
  ignored: string[];
  ignored_files: number | null;
  unassigned: string[] | null;
  /** Structural refusals — should never appear on a stored cut; shown if a
   * hand-edited file carries one. */
  errors: string[];
  /** What save would refuse for (a draft may carry these; a saved cut that
   * shows one has gone stale against the repo). */
  blocking_save: string[];
}

export interface CutStatus {
  ok: boolean;
  /** Why the file or the repo could not be read — the rest is then partial. */
  problems: string[];
  /** The cut file exists but could not be read: `saved`/`draft` are then
   * unknown, not absent. */
  cut_file_unreadable: boolean;
  saved: (CutView & { saved_at: string; head: string | null; files_at_save: number }) | null;
  draft: (CutView & { updated_at: string; source: DraftCut["source"] }) | null;
  has_previous: boolean;
  repo_files: number | null;
  head: string | null;
}

export type FactsResult = { ok: true; head: string | null; facts: RepoFacts } | Refusal;

/** Why a stored cut is not one this version can read, or null when it is (or
 * is absent). Structure only — the partition itself is `checkCut`'s. */
function cutShapeError(cut: unknown): string | null {
  if (cut === null) return null;
  if (typeof cut !== "object") return "is not an object";
  const c = cut as { units?: unknown; ignored?: unknown };
  const strings = (v: unknown): boolean =>
    Array.isArray(v) && v.every((x) => typeof x === "string");
  if (!Array.isArray(c.units)) return "has no `units` array";
  for (const [i, u] of c.units.entries()) {
    const unit = (u ?? {}) as { name?: unknown; roots?: unknown; kind?: unknown; note?: unknown };
    if (
      typeof unit.name !== "string" ||
      !strings(unit.roots) ||
      typeof unit.kind !== "string" ||
      typeof unit.note !== "string"
    ) {
      return `units[${i}] is not {name, roots, kind, note}`;
    }
  }
  if (!strings(c.ignored)) return "has no `ignored` array of paths";
  return null;
}

// ---- engine ------------------------------------------------------------------

/** The cut setup offers when none is saved: the candidates as units, the
 * vendored roots ignored. */
function candidateCut(candidates: readonly UnitCandidate[], files: readonly string[]): UnitCut {
  return {
    units: candidates.map((c) => ({ name: c.name, roots: c.roots, kind: c.kind, note: c.reason })),
    ignored: vendoredRoots(files),
  };
}

export class SetupEngine {
  private readonly budget: CaseBudget;
  private readonly surveyRun: SurveyRunner;

  constructor(
    private readonly ports: SetupPorts,
    opts: SetupOptions = {},
  ) {
    this.budget = opts.caseBudget ?? DEFAULT_CASE_BUDGET;
    this.surveyRun = new SurveyRunner(ports, () => this.surveyInputs(), {
      repoRoot: ports.repo.location,
      ...(opts.surveyConcurrency !== undefined ? { concurrency: opts.surveyConcurrency } : {}),
    });
  }

  private files(): string[] | null {
    const listed = this.ports.repo.listFiles();
    return listed === null ? null : [...listed].sort();
  }

  private noRepo(): Refusal {
    return {
      ok: false,
      errors: [
        `no readable checkout at ${this.ports.repo.location} — is the reviewed repo mounted?`,
      ],
    };
  }

  /** The deterministic repo facts. Recomputed on every call — they are cheap
   * and a cache would be one more thing to go stale. */
  facts(): FactsResult {
    const files = this.files();
    if (files === null) return this.noRepo();
    return {
      ok: true,
      head: this.ports.repo.head(),
      facts: repoFacts(files, (p) => this.ports.repo.read(p)),
    };
  }

  // -- the file --

  private load(): { file: UnitCutFile; error: string | null } {
    const empty: UnitCutFile = {
      version: UNIT_CUT_VERSION,
      saved: null,
      previous: null,
      draft: null,
    };
    let text: string | null;
    try {
      text = this.ports.state.read(UNIT_CUT_FILE);
    } catch (err) {
      return {
        file: empty,
        error: `${UNIT_CUT_FILE} in ${this.ports.state.location} cannot be read: ${String(err)}`,
      };
    }
    if (text === null) return { file: empty, error: null };
    try {
      const raw = JSON.parse(text) as Partial<UnitCutFile>;
      if (typeof raw !== "object" || raw === null || raw.version !== UNIT_CUT_VERSION) {
        throw new Error(
          `unknown version ${JSON.stringify((raw as { version?: unknown } | null)?.version)}`,
        );
      }
      const file: UnitCutFile = {
        version: UNIT_CUT_VERSION,
        saved: raw.saved ?? null,
        previous: raw.previous ?? null,
        draft: raw.draft ?? null,
      };
      // A hand-edited file must be reported, never crash a view: every later
      // reader (assign, splitUnit) takes the shape on trust.
      for (const key of ["saved", "previous", "draft"] as const) {
        const bad = cutShapeError(file[key]);
        if (bad !== null) throw new Error(`\`${key}\` ${bad}`);
      }
      return { file, error: null };
    } catch (err) {
      return {
        file: empty,
        error:
          `${UNIT_CUT_FILE} in ${this.ports.state.location} is not a unit cut this version reads (${String(err)}) — ` +
          "nothing will overwrite it; move it aside to start over",
      };
    }
  }

  private store(file: UnitCutFile): void {
    this.ports.state.write(UNIT_CUT_FILE, `${JSON.stringify(file, null, 2)}\n`);
  }

  /** Load for a write: an unreadable file refuses rather than being replaced. */
  private loadForWrite(): { file: UnitCutFile } | Refusal {
    const { file, error } = this.load();
    return error === null ? { file } : { ok: false, errors: [error] };
  }

  // -- views --

  private view(cut: UnitCut, files: readonly string[], lines: (p: string) => number): CutView {
    const { errors, blocking_save } = checkCut(cut, files);
    // A cut with structural errors (a hand-edited file) still gets a
    // best-effort view, with the errors beside it.
    const a = assign(cut, files);
    const sizeErrors: string[] = [];
    const units: UnitSummary[] = cut.units.map((u) => {
      const owned = a.byUnit.get(u.name) ?? [];
      const reviewable = owned.filter((f) => !isSweepSkipped(f));
      let cases: CasePlan[] = [];
      let unavailable = false;
      try {
        cases = splitUnit(u.name, reviewable, lines, this.budget);
      } catch (err) {
        unavailable = true;
        sizeErrors.push(String(err));
      }
      return {
        name: u.name,
        kind: u.kind,
        roots: u.roots,
        note: u.note,
        files: owned.length,
        reviewable: reviewable.length,
        lines: unavailable ? null : cases.reduce((n, c) => n + c.lines, 0),
        cases: unavailable
          ? null
          : cases.map((c) => ({
              id: c.id,
              files: c.files.length,
              lines: c.lines,
              over_budget: c.over_budget,
            })),
      };
    });
    return {
      units,
      ignored: cut.ignored,
      ignored_files: a.ignored.length,
      unassigned: a.unassigned,
      errors: [...errors, ...sizeErrors],
      blocking_save,
    };
  }

  private lineCounter(): (p: string) => number {
    const cache = new Map<string, number>();
    return (p) => {
      let n = cache.get(p);
      if (n === undefined) {
        const measured = this.ports.repo.lines(p);
        if (measured === null)
          throw new Error(
            `line count UNKNOWN for ${p} — unreadable, binary or too large; no case or price can be inferred`,
          );
        n = measured;
        cache.set(p, n);
      }
      return n;
    };
  }

  /** The saved cut and the draft, each re-checked against the repo as it is
   * now — so a saved cut the repo has outgrown (a new top-level directory no
   * unit claims) shows up here instead of being silently skipped later. */
  status(): CutStatus {
    const { file, error } = this.load();
    const problems = error === null ? [] : [error];
    const files = this.files();
    if (files === null) problems.push(this.noRepo().errors[0]!);
    const head = files === null ? null : this.ports.repo.head();
    const lines = this.lineCounter();
    const see = (cut: UnitCut): CutView =>
      files === null
        ? {
            units: cut.units.map((u) => ({
              ...u,
              files: null,
              reviewable: null,
              lines: null,
              cases: null,
            })),
            ignored: cut.ignored,
            ignored_files: null,
            unassigned: null,
            errors: [],
            blocking_save: [],
          }
        : this.view(cut, files, lines);
    return {
      ok: problems.length === 0,
      problems,
      cut_file_unreadable: error !== null,
      saved: file.saved
        ? {
            ...see(file.saved),
            saved_at: file.saved.saved_at,
            head: file.saved.head,
            files_at_save: file.saved.files,
          }
        : null,
      draft: file.draft
        ? { ...see(file.draft), updated_at: file.draft.updated_at, source: file.draft.source }
        : null,
      has_previous: file.previous !== null,
      repo_files: files?.length ?? null,
      head,
    };
  }

  // -- the three verbs --

  /**
   * Store a proposal as the draft, replacing any earlier draft (never the
   * saved cut). `raw` is the companion's proposal — `{units, ignored?}` — or
   * undefined to take the deterministic candidates as they are (vendored
   * trees ignored). Refused when it is structurally wrong; save-blocking
   * conditions are allowed in a draft and reported.
   */
  propose(raw?: unknown): { ok: true; draft: CutView } | Refusal {
    const files = this.files();
    if (files === null) return this.noRepo();
    const loaded = this.loadForWrite();
    if ("ok" in loaded) return loaded;
    let cut: UnitCut;
    let source: DraftCut["source"];
    if (raw === undefined || raw === null || (typeof raw === "object" && !("units" in raw))) {
      cut = candidateCut(unitCandidates(files), files);
      source = "candidates";
    } else {
      const n = normalizeCut(raw);
      if (!n.ok) return n;
      cut = n.cut;
      source = "companion";
    }
    const problems = checkCut(cut, files);
    if (problems.errors.length > 0) return { ok: false, errors: problems.errors };
    loaded.file.draft = { ...cut, updated_at: this.ports.clock().toISOString(), source };
    this.store(loaded.file);
    return { ok: true, draft: this.view(cut, files, this.lineCounter()) };
  }

  /**
   * Apply the operator's corrections to the draft — starting one from the
   * saved cut when there is no draft — all-or-nothing: a refused op, or a
   * result that is structurally wrong, leaves the stored draft as it was.
   */
  adjust(ops: unknown): { ok: true; draft: CutView } | Refusal {
    if (!Array.isArray(ops) || ops.length === 0) {
      return { ok: false, errors: ["`ops` must be a non-empty array of adjust operations"] };
    }
    const files = this.files();
    if (files === null) return this.noRepo();
    const loaded = this.loadForWrite();
    if ("ok" in loaded) return loaded;
    const base = loaded.file.draft ?? loaded.file.saved;
    if (!base)
      return { ok: false, errors: ["there is no unit cut to adjust yet — propose one first"] };
    const applied = applyOps({ units: base.units, ignored: base.ignored }, ops);
    if (!applied.ok) return applied;
    const problems = checkCut(applied.cut, files);
    if (problems.errors.length > 0) return { ok: false, errors: problems.errors };
    loaded.file.draft = {
      ...applied.cut,
      updated_at: this.ports.clock().toISOString(),
      source: "adjusted",
    };
    this.store(loaded.file);
    return { ok: true, draft: this.view(applied.cut, files, this.lineCounter()) };
  }

  /**
   * Promote the draft to the unit cut. Refused unless it is a complete
   * partition of the repo as it is now — every file in exactly one unit or
   * deliberately ignored, no unit left empty. The cut it replaces is kept as
   * `previous`.
   */
  save(): { ok: true; saved: CutView } | Refusal {
    const files = this.files();
    if (files === null) return this.noRepo();
    const loaded = this.loadForWrite();
    if ("ok" in loaded) return loaded;
    const draft = loaded.file.draft;
    if (!draft) {
      return {
        ok: false,
        errors: [
          loaded.file.saved
            ? "no draft to save — the saved cut is already in use; adjust it to start a draft"
            : "no draft to save — propose a unit cut first",
        ],
      };
    }
    const cut: UnitCut = { units: draft.units, ignored: draft.ignored };
    const problems = checkCut(cut, files);
    if (problems.errors.length > 0 || problems.blocking_save.length > 0) {
      return { ok: false, errors: [...problems.errors, ...problems.blocking_save] };
    }
    loaded.file.previous = loaded.file.saved;
    loaded.file.saved = {
      ...cut,
      saved_at: this.ports.clock().toISOString(),
      head: this.ports.repo.head(),
      files: files.length,
    };
    loaded.file.draft = null;
    this.store(loaded.file);
    return { ok: true, saved: this.view(cut, files, this.lineCounter()) };
  }

  // -- reuse --

  /** The saved cut, for every later survey and scan; null when none is saved
   * (or the file cannot be read — `status()` says which). */
  savedCut(): SavedCut | null {
    return this.load().file.saved;
  }

  /**
   * The saved cut as cases: every unit's reviewable files (optionally only
   * those `include` keeps — a scan's stage 1 drops tests and migrations),
   * split to fit the case budget, each case under its unit's name. Refused
   * when there is no saved cut: a survey or scan never runs on a guess.
   */
  cases(
    include: (path: string) => boolean = () => true,
  ): { ok: true; cases: CasePlan[] } | Refusal {
    const files = this.files();
    if (files === null) return this.noRepo();
    const { file, error } = this.load();
    if (error !== null) return { ok: false, errors: [error] };
    if (!file.saved)
      return { ok: false, errors: ["no saved unit cut — propose, adjust and save one first"] };
    const a = assign(file.saved, files);
    const lines = this.lineCounter();
    const cases: CasePlan[] = [];
    try {
      for (const u of file.saved.units) {
        const owned = (a.byUnit.get(u.name) ?? []).filter((f) => !isSweepSkipped(f) && include(f));
        if (owned.length > 0) cases.push(...splitUnit(u.name, owned, lines, this.budget));
      }
    } catch (err) {
      return { ok: false, errors: [String(err)] };
    }
    return { ok: true, cases };
  }

  // -- review history (src/setup/history.ts) --

  /** The digest in the state home: its summary, one page of one half, and the
   * themes saved from it so far. `digest: "absent"` is the normal state
   * before the TUI has pulled one — never an error. */
  history(page: { section: HistorySection; offset?: number; limit?: number } | null = null): {
    digest: "absent" | "unreadable" | "ok";
    problems: string[];
    summary: HistorySummary | null;
    page: { section: HistorySection; total: number; offset: number; lines: string[] } | null;
    themes: HistoryThemesFile | null;
    /** The saved themes file exists but cannot be read — UNKNOWN, never "no
     * themes saved yet". */
    themes_error: string | null;
  } {
    const read = readDigest(this.ports.state);
    const saved = historyThemesState(this.ports.state);
    const themes = saved.state === "ok" ? saved.file : null;
    const themes_error = saved.state === "unreadable" ? saved.error : null;
    if (read.state !== "ok") {
      return {
        digest: read.state,
        problems: read.state === "unreadable" ? [read.error] : [],
        summary: null,
        page: null,
        themes,
        themes_error,
      };
    }
    return {
      digest: "ok",
      problems: [],
      summary: summarize(read.digest),
      page: page
        ? {
            section: page.section,
            ...historyPage(read.digest, page.section, page.offset ?? 0, page.limit ?? 50),
          }
        : null,
      themes,
      themes_error,
    };
  }

  /** Save the companion's themes — the only part of the history that goes on
   * to memory and the portrait. One save at a time: two overlapping saves
   * would each read the same earlier entries to replace and both write their
   * own, leaving two sets live while the file holds one. */
  saveHistoryThemes(raw: unknown): Promise<SaveThemesResult> {
    const run = this.historySaves.then(() =>
      saveHistoryThemes(
        { state: this.ports.state, memory: this.ports.memory, clock: this.ports.clock },
        raw,
      ),
    );
    this.historySaves = run.catch(() => undefined);
    return run;
  }

  private historySaves: Promise<unknown> = Promise.resolve();

  // -- the survey (the run itself is surveyrun.ts) --

  /** What a survey reads, over the saved cut and the facts as they are now. */
  private surveyInputs(): SurveyInputs {
    const files = this.files();
    if (files === null) return this.noRepo();
    const { file, error } = this.load();
    if (error !== null) return { ok: false, errors: [error] };
    if (!file.saved)
      return {
        ok: false,
        errors: [
          "no saved unit cut — the survey reads by unit; propose, adjust and save one first",
        ],
      };
    const facts = repoFacts(files, (p) => this.ports.repo.read(p));
    const lines = this.lineCounter();
    const assigned = assign(file.saved, files);
    const candidates = new Set([
      ...facts.agent_files,
      ...facts.guides,
      ...[...assigned.byUnit.values()].flat().filter(isSampleable),
    ]);
    try {
      for (const path of candidates) if (!assigned.ignored.includes(path)) lines(path);
    } catch (err) {
      return { ok: false, errors: [String(err)] };
    }
    let changes: Record<string, number> | null = null;
    try {
      changes = this.ports.repo.changeCounts?.() ?? null;
    } catch {
      changes = null;
    }
    return {
      ok: true,
      head: this.ports.repo.head(),
      input: {
        cut: file.saved,
        files,
        agentFiles: facts.agent_files,
        guides: facts.guides,
        linesOf: lines,
        changes,
        budget: this.budget,
      },
    };
  }

  /** The survey's cases, sample and price now, and the key a start quotes. */
  surveyPreview(): Promise<{ ok: true; preview: SurveyPreview } | Refusal> {
    return this.surveyRun.preview();
  }

  /** Start the previewed survey in the background (see surveyrun.ts for
   * every refusal). Returns as soon as the run is recorded. */
  surveyStart(args: {
    key?: unknown;
    resurvey?: unknown;
  }): Promise<{ ok: true; run: SurveyRun } | Refusal> {
    return this.surveyRun.start(args);
  }

  surveyStatus(): SurveyStatus {
    return this.surveyRun.status();
  }

  surveyStop(): { ok: true; id: string } | Refusal {
    return this.surveyRun.stop();
  }

  /** Resolves when no survey is running. */
  surveyIdle(): Promise<void> {
    return this.surveyRun.idle();
  }

  // -- the repo portrait (src/setup/portrait.ts) --

  /** The portrait facts as they are now, from what is already on disk: the
   * repo facts, the saved cut (the candidates, flagged, when none is saved),
   * the saved history themes, the last completed survey and what the scans
   * found. */
  private portraitFacts(): { ok: true; facts: PortraitFacts } | Refusal {
    const files = this.files();
    if (files === null) return this.noRepo();
    const repo = repoFacts(files, (p) => this.ports.repo.read(p));
    const problems: string[] = [];
    const { file, error } = this.load();
    if (error !== null) problems.push(error);
    const cut: UnitCut = file.saved ?? candidateCut(repo.unit_candidates, files);
    const view = this.view(cut, files, this.lineCounter());
    problems.push(...view.errors, ...view.blocking_save);
    const unassigned = view.unassigned?.length;
    if (unassigned !== undefined && unassigned > 0)
      problems.push(`${unassigned} file(s) are unassigned by the saved unit cut`);
    const themes = historyThemesState(this.ports.state);
    if (themes.state === "unreadable") problems.push(themes.error);
    const survey = this.surveyRun.status();
    problems.push(...survey.problems);
    const done = survey.last_complete;
    // What the scans found, from the state home's scan records.
    const scanned = scanFacts(this.ports.state);
    problems.push(...scanned.problems);
    return {
      ok: true,
      facts: {
        head: this.ports.repo.head(),
        stack: {
          files: repo.files,
          languages: repo.languages,
          manifests: repo.manifests,
          frameworks: repo.frameworks,
        },
        units: {
          source: file.saved ? "saved" : "candidates",
          saved_at: file.saved?.saved_at ?? null,
          units: view.units.map((u) => ({
            name: u.name,
            kind: u.kind,
            roots: u.roots,
            note: u.note,
            files: u.files,
            reviewable: u.reviewable,
            lines: u.lines,
            cases: u.cases?.length ?? null,
          })),
          ignored: cut.ignored,
        },
        conventions: {
          guides: repo.guides,
          style_guides: repo.style_guides,
          agent_files: repo.agent_files,
        },
        enforced: { ci: repo.ci, linters: repo.linters },
        history:
          themes.state === "ok"
            ? {
                state: "ok",
                saved_at: themes.file.saved_at,
                digest_generated_at: themes.file.digest_generated_at,
                themes: themes.file.themes,
              }
            : { state: themes.state, saved_at: null, digest_generated_at: null, themes: [] },
        survey: done
          ? { id: done.id, finished_at: done.finished_at, head: done.head, notes: done.notes }
          : null,
        scan: scanned.scan,
        problems,
      },
    };
  }

  /** Assemble the portrait facts and store them in the state home, keeping
   * the version a new shape replaces (portrait.ts `saveFacts`). */
  portraitAssemble(): AssembleResult {
    const r = this.portraitFacts();
    if (!r.ok) return r;
    return saveFacts(this.ports.state, r.facts, this.ports.clock());
  }

  /** The stored portrait — facts, narrative, whether the narrative predates
   * the facts — and, when asked, what changed since the kept versions. */
  portrait(opts: { diff?: boolean } = {}): PortraitView {
    return readPortrait(this.portraitDeps(), opts);
  }

  /** Store the companion's narrative against the facts key it read. */
  storePortraitNarrative(raw: { facts_key?: unknown; narrative?: unknown }): StoreNarrativeResult {
    return storeNarrative(this.portraitDeps(), raw);
  }

  private portraitDeps(): { state: StateFs; config: StateFs | null; clock: () => Date } {
    return { state: this.ports.state, config: this.ports.config ?? null, clock: this.ports.clock };
  }

  // -- the interview's tuning (src/setup/tuning.ts) --

  private tuningDeps(): Parameters<typeof profileStatus>[0] {
    return {
      state: this.ports.state,
      profiles: this.ports.profiles ?? null,
      memory: this.ports.memory,
      clock: this.ports.clock,
    };
  }

  /** Which profile the install uses, whether it loads, whether setup is
   * owed (the companion's nudge), the answers so far and the commits asked. */
  profileStatus(): ProfileStatus | Refusal {
    return profileStatus(this.tuningDeps());
  }

  /** The daemon's own check of a profile as it is on disk — a direct edit's
   * safety net. */
  profileValidate(name?: unknown): { profile: string; check: ProfileCheck } | Refusal {
    return profileValidate(this.tuningDeps(), name);
  }

  /** The interview's answers → the profile: previewed with a diff, or
   * written (validated first, committed on the operator's machine). */
  profileApply(input: ApplyInput): ApplyResult | Refusal {
    return profileApply(this.tuningDeps(), input);
  }

  /** After a scan (src/setup/retune.ts): the companion's profile
   * changes, each with its reason, previewed or written through the same
   * path as the interview's — a write logs the report and refreshes the
   * portrait facts. It reaches PR reviews only on the operator's deploy. */
  retune(input: RetuneInput): RetuneResult | Refusal {
    return retune(
      {
        ...this.tuningDeps(),
        refreshPortrait: () => {
          const r = this.portraitAssemble();
          return r.ok ? { ok: true, key: r.current.key } : r;
        },
      },
      input,
    );
  }

  /** Propose memory entries to pin; the operator decides in the TUI. */
  proposePins(entries: unknown): Promise<PinProposeResult | Refusal> {
    return proposePins(this.tuningDeps(), entries);
  }
}

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
// Persistence: the unit cut is unitcutstore.ts's, `<state home>/setup/unit-cut.json`:
// the saved cut (the one survey and scan reuse), the previous saved cut (so a
// re-cut can be compared and undone), and at most one draft. The ports the
// scan shares (the checkout, the state home, the case runner) are
// scanports.ts's.
import { isSampleable } from "./survey.js";
import type { MemoryStore } from "../memory/store.js";
import { repoFacts, type RepoFacts } from "./facts.js";
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
  assign,
  type CaseBudget,
  type CasePlan,
  type UnitCut,
} from "./unitcut.js";
import type { CaseRunner, Refusal, RepoReader, StateFs } from "./scanports.js";
import {
  UnitCutStore,
  candidateCut,
  type CutStatus,
  type CutView,
  type SavedCut,
  type UnitCutFile,
} from "./unitcutstore.js";

// ---- ports -------------------------------------------------------------------

// The checkout, the state home and the case runner: the scan's own ports,
// shared with it (scanports.ts).
export type {
  CaseOutcome,
  CaseRunner,
  CaseSpec,
  Refusal,
  RepoReader,
  StateFs,
} from "./scanports.js";
// The stored unit cut (unitcutstore.ts), under the names setup has always used.
export {
  UNIT_CUT_FILE,
  UNIT_CUT_VERSION,
  type CutStatus,
  type CutView,
  type DraftCut,
  type SavedCut,
  type UnitCutFile,
  type UnitSummary,
} from "./unitcutstore.js";

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

// ---- results -----------------------------------------------------------------

export type FactsResult = { ok: true; head: string | null; facts: RepoFacts } | Refusal;

// ---- engine ------------------------------------------------------------------

export class SetupEngine {
  private readonly budget: CaseBudget;
  private readonly surveyRun: SurveyRunner;
  /** The unit cut: its file, its views and its three verbs. */
  private readonly cut: UnitCutStore;

  constructor(
    private readonly ports: SetupPorts,
    opts: SetupOptions = {},
  ) {
    this.budget = opts.caseBudget ?? DEFAULT_CASE_BUDGET;
    this.cut = new UnitCutStore(ports, this.budget);
    this.surveyRun = new SurveyRunner(ports, () => this.surveyInputs(), {
      repoRoot: ports.repo.location,
      ...(opts.surveyConcurrency !== undefined ? { concurrency: opts.surveyConcurrency } : {}),
    });
  }

  private files(): string[] | null {
    return this.cut.files();
  }

  private noRepo(): Refusal {
    return this.cut.noRepo();
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

  // -- the unit cut (unitcutstore.ts) --

  private load(): { file: UnitCutFile; error: string | null } {
    return this.cut.load();
  }

  private view(cut: UnitCut, files: readonly string[], lines: (p: string) => number): CutView {
    return this.cut.view(cut, files, lines);
  }

  private lineCounter(): (p: string) => number {
    return this.cut.lineCounter();
  }

  /** The saved cut and the draft, each re-checked against the repo as it is
   * now — so a saved cut the repo has outgrown (a new top-level directory no
   * unit claims) shows up here instead of being silently skipped later. */
  status(): CutStatus {
    return this.cut.status();
  }

  /** Store a proposal as the draft (unitcutstore.ts `propose`). */
  propose(raw?: unknown): { ok: true; draft: CutView } | Refusal {
    return this.cut.propose(raw);
  }

  /** Apply the operator's corrections to the draft (unitcutstore.ts `adjust`). */
  adjust(ops: unknown): { ok: true; draft: CutView } | Refusal {
    return this.cut.adjust(ops);
  }

  /** Promote the draft to the unit cut (unitcutstore.ts `save`). */
  save(): { ok: true; saved: CutView } | Refusal {
    return this.cut.save();
  }

  /** The saved cut, for every later survey and scan; null when none is saved
   * (or the file cannot be read — `status()` says which). */
  savedCut(): SavedCut | null {
    return this.cut.savedCut();
  }

  /** The saved cut as cases (unitcutstore.ts `cases`). */
  cases(
    include: (path: string) => boolean = () => true,
  ): { ok: true; cases: CasePlan[] } | Refusal {
    return this.cut.cases(include);
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

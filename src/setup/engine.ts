// SetupEngine — the deterministic half of setup & scan (setup & scan
// spec "Setup & scan engine", seam 3). The onboarding engine's pattern
// (src/onboard/engine.ts): a state machine with every outside effect behind an
// injected port, fully drivable from tests, and a thin pi tool belt over it
// (extensions/setup.ts, loaded by the companion). The companion JUDGES — which
// units a repo has, what a finding means — and these tools ACT: what they do
// with its answers is deterministic, validated, and persisted here.
//
// This slice carries the first two behaviours: the deterministic repo facts
// and the unit cut. The ports for the later slices (case runner, tracker
// sink, GitHub reader, MemoryStore) are declared and injected now so every
// later tool lands on the same engine; their real implementations arrive with
// the slice that first calls them.
//
// Persistence: `<state home>/setup/unit-cut.json`, tmp+rename atomic through
// the state port. It holds the SAVED cut (the one survey and scan reuse), the
// PREVIOUS saved cut (so a re-cut can be compared and undone), and at most one
// DRAFT (the companion's proposal as the operator adjusts it). A saved cut is
// never touched by a propose or an adjust — only `save` replaces it. An
// unreadable file is REPORTED and refuses every write: it may hold the
// operator's saved cut, and silently starting fresh over it would lose that.
import type { MemoryStore } from "../memory/store.js";
import { isSweepSkipped } from "../heuristics.js";
import { repoFacts, unitCandidates, vendoredRoots, type RepoFacts } from "./facts.js";
import {
  historyPage,
  readDigest,
  readHistoryThemes,
  saveHistoryThemes,
  summarize,
  type HistorySection,
  type HistorySummary,
  type HistoryThemesFile,
  type SaveThemesResult,
} from "./history.js";
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

/** The reviewed checkout, READ-ONLY (the companion mounts it `:ro`). Every
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
}

/** The filesystem rooted at the install's STATE home — PC-only, never shipped.
 * Paths are relative to that root; the implementation refuses any that would
 * leave it. */
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

export type CaseLaunch = { ok: true; id: string } | { ok: false; reason: string };

/** Launches cases as background subagents (survey, scan). */
export interface CaseRunner {
  launch(spec: CaseSpec): Promise<CaseLaunch>;
  stop(id: string): Promise<CaseLaunch>;
}

export interface TrackerTicket {
  title: string;
  body: string;
  /** The effort the ticket belongs in (the companion picks the one that fits). */
  effort: string;
  /** Stamped on the ticket, so a finding is never filed twice. */
  fingerprint: string;
}

export type SinkResult = { ok: true; ref: string } | { ok: false; reason: string };

/** Where a promoted finding goes: the issue tracker, or one markdown
 * file per finding when the install has none. */
export interface TrackerSink {
  file(ticket: TrackerTicket): Promise<SinkResult>;
  close(ref: string, note: string): Promise<SinkResult>;
}

export type GitHubRead = { ok: true; data: unknown } | { ok: false; reason: string };

/** GitHub, READ-ONLY: the interface has no method that could write — a GET of
 * a REST path under the API root, and nothing else. */
export interface GitHubReader {
  get(path: string): Promise<GitHubRead>;
}

export interface SetupPorts {
  repo: RepoReader;
  state: StateFs;
  clock: () => Date;
  /** The ONE memory seam. Null when this assembly has no memory — every
   * memory write then answers a refusal naming why. */
  memory: MemoryStore | null;
  cases: CaseRunner;
  tracker: TrackerSink;
  github: GitHubReader;
  log?: (line: string) => void;
}

export interface SetupOptions {
  /** How much one case may read (`[scan]` config will own it). */
  caseBudget?: CaseBudget;
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
  files: number;
  /** Files a pass would actually read (lockfiles, binaries, prose skipped). */
  reviewable: number;
  lines: number;
  /** One per case; a unit that fits is one case under its own name. */
  cases: Array<{ id: string; files: number; lines: number; over_budget: boolean }>;
}

export interface CutView {
  units: UnitSummary[];
  ignored: string[];
  ignored_files: number;
  unassigned: string[];
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
   * UNKNOWN, not absent. */
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
  const strings = (v: unknown): boolean => Array.isArray(v) && v.every((x) => typeof x === "string");
  if (!Array.isArray(c.units)) return "has no `units` array";
  for (const [i, u] of c.units.entries()) {
    const unit = (u ?? {}) as { name?: unknown; roots?: unknown; kind?: unknown; note?: unknown };
    if (typeof unit.name !== "string" || !strings(unit.roots) || typeof unit.kind !== "string" || typeof unit.note !== "string") {
      return `units[${i}] is not {name, roots, kind, note}`;
    }
  }
  if (!strings(c.ignored)) return "has no `ignored` array of paths";
  return null;
}

// ---- engine ------------------------------------------------------------------

export class SetupEngine {
  private readonly budget: CaseBudget;

  constructor(
    private readonly ports: SetupPorts,
    opts: SetupOptions = {},
  ) {
    this.budget = opts.caseBudget ?? DEFAULT_CASE_BUDGET;
  }

  private files(): string[] | null {
    const listed = this.ports.repo.listFiles();
    return listed === null ? null : [...listed].sort();
  }

  private noRepo(): Refusal {
    return {
      ok: false,
      errors: [`no readable checkout at ${this.ports.repo.location} — is the reviewed repo mounted?`],
    };
  }

  /** The deterministic repo facts. Recomputed on every call — they are cheap
   * and a cache would be one more thing to go stale. */
  facts(): FactsResult {
    const files = this.files();
    if (files === null) return this.noRepo();
    return { ok: true, head: this.ports.repo.head(), facts: repoFacts(files, (p) => this.ports.repo.read(p)) };
  }

  // -- the file --

  private load(): { file: UnitCutFile; error: string | null } {
    const empty: UnitCutFile = { version: UNIT_CUT_VERSION, saved: null, previous: null, draft: null };
    let text: string | null;
    try {
      text = this.ports.state.read(UNIT_CUT_FILE);
    } catch (err) {
      return { file: empty, error: `${UNIT_CUT_FILE} in ${this.ports.state.location} cannot be read: ${String(err)}` };
    }
    if (text === null) return { file: empty, error: null };
    try {
      const raw = JSON.parse(text) as Partial<UnitCutFile>;
      if (typeof raw !== "object" || raw === null || raw.version !== UNIT_CUT_VERSION) {
        throw new Error(`unknown version ${JSON.stringify((raw as { version?: unknown } | null)?.version)}`);
      }
      const file: UnitCutFile = {
        version: UNIT_CUT_VERSION,
        saved: raw.saved ?? null,
        previous: raw.previous ?? null,
        draft: raw.draft ?? null,
      };
      // A hand-edited file must be REPORTED, never crash a view: every later
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
    const units: UnitSummary[] = cut.units.map((u) => {
      const owned = a.byUnit.get(u.name) ?? [];
      const reviewable = owned.filter((f) => !isSweepSkipped(f));
      const cases = splitUnit(u.name, reviewable, lines, this.budget);
      return {
        name: u.name,
        kind: u.kind,
        roots: u.roots,
        note: u.note,
        files: owned.length,
        reviewable: reviewable.length,
        lines: cases.reduce((n, c) => n + c.lines, 0),
        cases: cases.map((c) => ({ id: c.id, files: c.files.length, lines: c.lines, over_budget: c.over_budget })),
      };
    });
    return {
      units,
      ignored: cut.ignored,
      ignored_files: a.ignored.length,
      unassigned: a.unassigned,
      errors,
      blocking_save,
    };
  }

  private lineCounter(): (p: string) => number {
    const cache = new Map<string, number>();
    return (p) => {
      let n = cache.get(p);
      if (n === undefined) {
        n = this.ports.repo.lines(p) ?? 0;
        cache.set(p, n);
      }
      return n;
    };
  }

  /** The saved cut and the draft, each re-checked against the repo as it is
   * NOW — so a saved cut the repo has outgrown (a new top-level directory no
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
        ? { units: [], ignored: cut.ignored, ignored_files: 0, unassigned: [], errors: [], blocking_save: [] }
        : this.view(cut, files, lines);
    return {
      ok: problems.length === 0,
      problems,
      cut_file_unreadable: error !== null,
      saved: file.saved
        ? { ...see(file.saved), saved_at: file.saved.saved_at, head: file.saved.head, files_at_save: file.saved.files }
        : null,
      draft: file.draft ? { ...see(file.draft), updated_at: file.draft.updated_at, source: file.draft.source } : null,
      has_previous: file.previous !== null,
      repo_files: files?.length ?? null,
      head,
    };
  }

  // -- the three verbs --

  /**
   * Store a proposal as the DRAFT, replacing any earlier draft (never the
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
      cut = {
        units: unitCandidates(files).map((c) => ({ name: c.name, roots: c.roots, kind: c.kind, note: c.reason })),
        ignored: vendoredRoots(files),
      };
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
    if (!base) return { ok: false, errors: ["there is no unit cut to adjust yet — propose one first"] };
    const applied = applyOps({ units: base.units, ignored: base.ignored }, ops);
    if (!applied.ok) return applied;
    const problems = checkCut(applied.cut, files);
    if (problems.errors.length > 0) return { ok: false, errors: problems.errors };
    loaded.file.draft = { ...applied.cut, updated_at: this.ports.clock().toISOString(), source: "adjusted" };
    this.store(loaded.file);
    return { ok: true, draft: this.view(applied.cut, files, this.lineCounter()) };
  }

  /**
   * Promote the draft to THE unit cut. Refused unless it is a complete
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
   * The saved cut as CASES: every unit's reviewable files (optionally only
   * those `include` keeps — a scan's stage 1 drops tests and migrations),
   * split to fit the case budget, each case under its unit's name. Refused
   * when there is no saved cut: a survey or scan never runs on a guess.
   */
  cases(include: (path: string) => boolean = () => true): { ok: true; cases: CasePlan[] } | Refusal {
    const files = this.files();
    if (files === null) return this.noRepo();
    const { file, error } = this.load();
    if (error !== null) return { ok: false, errors: [error] };
    if (!file.saved) return { ok: false, errors: ["no saved unit cut — propose, adjust and save one first"] };
    const a = assign(file.saved, files);
    const lines = this.lineCounter();
    const cases: CasePlan[] = [];
    for (const u of file.saved.units) {
      const owned = (a.byUnit.get(u.name) ?? []).filter((f) => !isSweepSkipped(f) && include(f));
      if (owned.length > 0) cases.push(...splitUnit(u.name, owned, lines, this.budget));
    }
    return { ok: true, cases };
  }

  // -- review history (src/setup/history.ts) --

  /** The digest in the state home: its summary, one page of one half, and the
   * themes saved from it so far. `digest: "absent"` is the normal state
   * before the TUI has pulled one — never an error. */
  history(
    page: { section: HistorySection; offset?: number; limit?: number } | null = null,
  ): {
    digest: "absent" | "unreadable" | "ok";
    problems: string[];
    summary: HistorySummary | null;
    page: { section: HistorySection; total: number; offset: number; lines: string[] } | null;
    themes: HistoryThemesFile | null;
  } {
    const read = readDigest(this.ports.state);
    const themes = readHistoryThemes(this.ports.state);
    if (read.state !== "ok") {
      return { digest: read.state, problems: read.state === "unreadable" ? [read.error] : [], summary: null, page: null, themes };
    }
    return {
      digest: "ok",
      problems: [],
      summary: summarize(read.digest),
      page: page
        ? { section: page.section, ...historyPage(read.digest, page.section, page.offset ?? 0, page.limit ?? 50) }
        : null,
      themes,
    };
  }

  /** Save the companion's themes — the only part of the history that goes on
   * to memory and the portrait. */
  saveHistoryThemes(raw: unknown): Promise<SaveThemesResult> {
    return saveHistoryThemes({ state: this.ports.state, memory: this.ports.memory, clock: this.ports.clock }, raw);
  }
}

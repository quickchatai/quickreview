// The unit cut, stored: the saved cut every survey and scan reads by, the cut
// it replaced, and at most one draft (the companion's proposal as the
// operator adjusts it), in `<state home>/setup/unit-cut.json`, tmp+rename
// atomic through the state port. A saved cut is never touched by a propose or
// an adjust — only `save` replaces it. An unreadable file is reported and
// refuses every write: it may hold the operator's saved cut, and silently
// starting fresh over it would lose that.
//
// Its ports are the checkout (read-only), the state home and the clock, and
// nothing else: the setup engine (engine.ts) owns one for its views, and a
// scan host with no setup engine (the pi plugin's /qcr-scan) builds one of its
// own over the same file.
import { isSweepSkipped } from "../heuristics.js";
import { unitCandidates, vendoredRoots, type UnitCandidate } from "./facts.js";
import type { Refusal, RepoReader, StateFs } from "./scanports.js";
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

/** The cut setup offers when none is saved: the candidates as units, the
 * vendored roots ignored. */
export function candidateCut(
  candidates: readonly UnitCandidate[],
  files: readonly string[],
): UnitCut {
  return {
    units: candidates.map((c) => ({ name: c.name, roots: c.roots, kind: c.kind, note: c.reason })),
    ignored: vendoredRoots(files),
  };
}

/** What the store reads and writes through. */
export interface UnitCutPorts {
  repo: RepoReader;
  state: StateFs;
  clock: () => Date;
}

export class UnitCutStore {
  private readonly budget: CaseBudget;

  constructor(
    private readonly ports: UnitCutPorts,
    /** How much one case of the unit view may read. */
    caseBudget: CaseBudget = DEFAULT_CASE_BUDGET,
  ) {
    this.budget = caseBudget;
  }

  files(): string[] | null {
    const listed = this.ports.repo.listFiles();
    return listed === null ? null : [...listed].sort();
  }

  noRepo(): Refusal {
    return {
      ok: false,
      errors: [
        `no readable checkout at ${this.ports.repo.location} — is the reviewed repo mounted?`,
      ],
    };
  }

  // -- the file --

  load(): { file: UnitCutFile; error: string | null } {
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

  /** A unit's case plans over its reviewable (not sweep-skipped) files. */
  private unitCases(
    name: string,
    owned: readonly string[],
    lines: (p: string) => number,
  ): CasePlan[] {
    return splitUnit(
      name,
      owned.filter((f) => !isSweepSkipped(f)),
      lines,
      this.budget,
    );
  }

  view(cut: UnitCut, files: readonly string[], lines: (p: string) => number): CutView {
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
        cases = this.unitCases(u.name, owned, lines);
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

  lineCounter(): (p: string) => number {
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
        cases.push(...this.unitCases(u.name, (a.byUnit.get(u.name) ?? []).filter(include), lines));
      }
    } catch (err) {
      return { ok: false, errors: [String(err)] };
    }
    return { ok: true, cases };
  }
}

/** What a scan reads of the unit cut: the saved cut, and why there is none. */
export type UnitCutStatusPort = Pick<UnitCutStore, "savedCut" | "status">;

/** The unit-cut verbs `qcr scan units` and `/qcr-scan units` call. */
export type UnitCutPort = Pick<UnitCutStore, "status" | "propose" | "adjust" | "save">;

// The unit cut (setup & scan spec "Unit"): the
// partition of a repo into stack-aware units — a Django app, a package, a
// workspace — that the survey reads, the scan reviews and every report groups
// by. The COMPANION proposes it, the OPERATOR adjusts it, and once saved it is
// reused by every later survey and scan; the companion re-cuts only on request.
//
// A unit OWNS path prefixes (`roots`). A file belongs to the unit whose root is
// the LONGEST prefix of it, so units nest naturally (`backend` and
// `backend/payments` are two units, and `backend/payments/x.py` is the
// second's); an `ignored` prefix is the same kind of claim held by nobody, so
// `backend/vendor` can be carved out of `backend` and a unit inside an ignored
// tree takes its files back. The root `""` claims everything, which is how a
// catch-all "rest" unit is spelt. A SAVED cut is a partition: every file is in
// exactly one unit or deliberately ignored — a file nobody claims refuses the
// save, because a scan that silently skips it would read as "covered".
//
// Pure: the cut is a value, validation and the adjust ops are functions over
// it and a file listing. The engine persists it (src/setup/engine.ts).
import { SCAN_DEFAULTS } from "../reviewconfig.js";
import { displayRoot, UNIT_KINDS, UNIT_NAME_MAX, UNIT_NAME_RE, type UnitKind } from "./facts.js";

export interface Unit {
  name: string;
  roots: string[];
  kind: UnitKind;
  /** Why this unit exists — the marker that proposed it, or the operator's
   * reason. Shown beside the unit; never parsed. */
  note: string;
}

export interface UnitCut {
  units: Unit[];
  /** Prefixes nobody reviews (vendored, generated, fixtures the operator
   * chose to leave out). */
  ignored: string[];
}

// ---- normalisation -----------------------------------------------------------

/** A root as stored: repo-relative, no leading `./` or `/`, no trailing `/`.
 * Null for anything that could leave the repo (`..`, an absolute path after
 * stripping is fine — it is relative by construction — but `..` is not). */
export function normalizeRoot(raw: string): string | null {
  let r = raw.trim().replace(/\\/g, "/");
  while (r.startsWith("./")) r = r.slice(2);
  r = r
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\/{2,}/g, "/");
  if (r === ".") r = "";
  if (r.split("/").some((s) => s === ".." || s === ".")) return null;
  return r;
}

function covers(root: string, path: string): boolean {
  return root === "" || path === root || path.startsWith(`${root}/`);
}

// ---- assignment --------------------------------------------------------------

export interface Assignment {
  /** unit name → its files, in listing order. Every unit has an entry. */
  byUnit: Map<string, string[]>;
  ignored: string[];
  unassigned: string[];
}

/** Longest-prefix assignment of every listed file. */
export function assign(cut: UnitCut, files: readonly string[]): Assignment {
  const claims: Array<{ root: string; unit: string | null }> = [
    ...cut.units.flatMap((u) => u.roots.map((root) => ({ root, unit: u.name }))),
    ...cut.ignored.map((root) => ({ root, unit: null })),
  ].sort((a, b) => b.root.length - a.root.length);
  const byUnit = new Map<string, string[]>(cut.units.map((u) => [u.name, []]));
  const ignored: string[] = [];
  const unassigned: string[] = [];
  for (const f of files) {
    const hit = claims.find((c) => covers(c.root, f));
    if (!hit) unassigned.push(f);
    else if (hit.unit === null) ignored.push(f);
    else byUnit.get(hit.unit)!.push(f);
  }
  return { byUnit, ignored, unassigned };
}

// ---- validation --------------------------------------------------------------

export interface CutProblems {
  /** Refusals: the cut cannot be stored at all. */
  errors: string[];
  /** Fine for a draft, refused by save (an empty unit, unclaimed files). */
  blocking_save: string[];
}

const SAMPLE = 8;

/** Refused both when a proposal is read and when a cut is checked. */
const ROOT_IGNORED = "the repo root cannot be ignored — that would leave nothing to review";

function sample(paths: readonly string[]): string {
  const head = paths.slice(0, SAMPLE).join(", ");
  return paths.length > SAMPLE ? `${head}, … (+${paths.length - SAMPLE} more)` : head;
}

/**
 * Structural refusals (bad names, duplicate names or roots, a root that could
 * leave the repo or matches no file, an ignored repo root) and the two
 * save-only conditions (a unit that ends up with no files, files no unit
 * claims). The cut is expected normalised (see `normalizeCut`).
 */
export function checkCut(cut: UnitCut, files: readonly string[]): CutProblems {
  const errors: string[] = [];
  const blocking: string[] = [];
  if (cut.units.length === 0) errors.push("a unit cut needs at least one unit");
  const names = new Set<string>();
  const roots = new Map<string, string>();
  for (const u of cut.units) {
    if (!UNIT_NAME_RE.test(u.name) || u.name.includes("..")) {
      errors.push(
        `unit name ${JSON.stringify(u.name)} is not a plain name — letters, digits, '.', '_' and '-', at most ${UNIT_NAME_MAX}`,
      );
    }
    if (names.has(u.name)) errors.push(`unit name "${u.name}" is used twice`);
    names.add(u.name);
    if (u.roots.length === 0) errors.push(`unit "${u.name}" owns no root`);
    for (const r of u.roots) {
      const owner = roots.get(r);
      if (owner !== undefined)
        errors.push(`root "${displayRoot(r)}" is claimed by both "${owner}" and "${u.name}"`);
      roots.set(r, u.name);
    }
  }
  for (const r of cut.ignored) {
    if (r === "") errors.push(ROOT_IGNORED);
    const owner = roots.get(r);
    if (owner !== undefined) errors.push(`root "${r}" is both ignored and owned by "${owner}"`);
    roots.set(r, "(ignored)");
  }
  for (const [r, owner] of roots) {
    if (r !== "" && !files.some((f) => covers(r, f))) {
      errors.push(`root "${r}" (${owner}) matches no file in the repo`);
    }
  }
  if (errors.length === 0) {
    const a = assign(cut, files);
    for (const [name, owned] of a.byUnit) {
      if (owned.length === 0) {
        blocking.push(
          `unit "${name}" ends up with no files — every file under its roots belongs to a deeper unit or is ignored`,
        );
      }
    }
    if (a.unassigned.length > 0) {
      blocking.push(
        `${a.unassigned.length} file(s) belong to no unit: ${sample(a.unassigned)} — add them to a unit, add a catch-all unit with root "", or ignore them`,
      );
    }
  }
  return { errors, blocking_save: blocking };
}

/** Raw input (a tool call's JSON) → a normalised cut, or the reasons it is not
 * one. Normalisation never guesses: an unspellable root is an error, not a
 * silently-dropped entry. */
export function normalizeCut(
  raw: unknown,
): { ok: true; cut: UnitCut } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const obj = (raw ?? {}) as { units?: unknown; ignored?: unknown };
  if (!Array.isArray(obj.units))
    return { ok: false, errors: ["`units` must be an array of {name, roots, kind?, note?}"] };
  const units: Unit[] = [];
  for (const [i, u] of obj.units.entries()) {
    const unit = (u ?? {}) as { name?: unknown; roots?: unknown; kind?: unknown; note?: unknown };
    if (typeof unit.name !== "string") {
      errors.push(`units[${i}]: name must be a string`);
      continue;
    }
    const rawRoots = typeof unit.roots === "string" ? [unit.roots] : unit.roots;
    if (!Array.isArray(rawRoots) || rawRoots.some((r) => typeof r !== "string")) {
      errors.push(`unit "${unit.name}": roots must be an array of repo-relative paths`);
      continue;
    }
    const roots = normalizeRoots(rawRoots as string[], `unit "${unit.name}"`, errors);
    units.push({
      name: unit.name.trim(),
      roots,
      kind: unitKind(unit.kind),
      note: typeof unit.note === "string" ? unit.note.trim() : "",
    });
  }
  let ignored: string[] = [];
  if (obj.ignored !== undefined) {
    if (!Array.isArray(obj.ignored) || obj.ignored.some((r) => typeof r !== "string")) {
      errors.push("`ignored` must be an array of repo-relative paths");
    } else {
      ignored = normalizeRoots(obj.ignored as string[], "ignored", errors);
      if (ignored.includes("")) errors.push(ROOT_IGNORED);
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, cut: { units, ignored } };
}

/** A supplied kind, or `custom` for anything that is not one of `UNIT_KINDS`. */
function unitKind(raw: unknown): UnitKind {
  return typeof raw === "string" && new Set<string>(UNIT_KINDS).has(raw)
    ? (raw as UnitKind)
    : "custom";
}

function normalizeRoots(raw: readonly string[], owner: string, errors: string[]): string[] {
  const out: string[] = [];
  for (const r of raw) {
    const n = normalizeRoot(r);
    if (n === null) errors.push(`${owner}: root ${JSON.stringify(r)} leaves the repo`);
    else if (!out.includes(n)) out.push(n);
  }
  return out;
}

// ---- adjust ops --------------------------------------------------------------

/** The operator's corrections, as the companion relays them. Applied to a
 * draft all-or-nothing: one refused op leaves the draft untouched. */
export type AdjustOp =
  | { op: "rename"; unit: string; to: string }
  | { op: "add"; name: string; roots: string[]; kind?: string; note?: string }
  | { op: "remove"; unit: string }
  | { op: "merge"; units: string[]; into: string }
  | { op: "move"; root: string; to: string }
  | { op: "set_roots"; unit: string; roots: string[] }
  | { op: "ignore"; roots: string[] }
  | { op: "unignore"; roots: string[] }
  | { op: "note"; unit: string; note: string };

export const ADJUST_OPS = [
  "rename",
  "add",
  "remove",
  "merge",
  "move",
  "set_roots",
  "ignore",
  "unignore",
  "note",
] as const;

function clone(cut: UnitCut): UnitCut {
  return {
    units: cut.units.map((u) => ({ ...u, roots: [...u.roots] })),
    ignored: [...cut.ignored],
  };
}

function strings(v: unknown): string[] | null {
  if (typeof v === "string") return [v];
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? v : null;
}

/**
 * Apply `ops` in order to a copy of `cut`. Returns the new cut, or every
 * reason it could not (unknown unit, unknown op, a root that leaves the repo).
 * The structural check of the RESULT is the caller's (`checkCut`) — an op
 * sequence may pass through an invalid intermediate state (swap two names).
 */
export function applyOps(
  cut: UnitCut,
  ops: readonly unknown[],
): { ok: true; cut: UnitCut } | { ok: false; errors: string[] } {
  const next = clone(cut);
  const errors: string[] = [];
  const unit = (name: unknown, i: number): Unit | null => {
    const u = typeof name === "string" ? next.units.find((x) => x.name === name) : undefined;
    if (!u)
      errors.push(
        `ops[${i}]: no unit named ${JSON.stringify(name)} — units: ${next.units.map((x) => x.name).join(", ")}`,
      );
    return u ?? null;
  };
  const rootsOf = (v: unknown, i: number): string[] | null => {
    const raw = strings(v);
    if (raw === null) {
      errors.push(`ops[${i}]: roots must be a path or an array of paths`);
      return null;
    }
    return normalizeRoots(raw, `ops[${i}]`, errors);
  };
  const release = (roots: readonly string[]): void => {
    for (const u of next.units) u.roots = u.roots.filter((r) => !roots.includes(r));
    next.ignored = next.ignored.filter((r) => !roots.includes(r));
  };
  for (const [i, raw] of ops.entries()) {
    const o = (raw ?? {}) as Record<string, unknown>;
    switch (o.op) {
      case "rename": {
        const u = unit(o.unit, i);
        if (u && typeof o.to === "string") u.name = o.to.trim();
        else if (u) errors.push(`ops[${i}]: rename needs \`to\``);
        break;
      }
      case "add": {
        const roots = rootsOf(o.roots, i);
        if (typeof o.name !== "string") errors.push(`ops[${i}]: add needs \`name\``);
        else if (roots) {
          release(roots);
          next.units.push({
            name: o.name.trim(),
            roots,
            kind: unitKind(o.kind),
            note: typeof o.note === "string" ? o.note.trim() : "added by the operator",
          });
        }
        break;
      }
      case "remove": {
        const u = unit(o.unit, i);
        if (u) next.units = next.units.filter((x) => x !== u);
        break;
      }
      case "merge": {
        const names = strings(o.units);
        if (!names || names.length < 2 || typeof o.into !== "string") {
          errors.push(`ops[${i}]: merge needs \`units\` (two or more) and \`into\``);
          break;
        }
        const members = names.map((n) => unit(n, i));
        if (members.some((m) => m === null)) break;
        const into = o.into.trim();
        const keep = members.find((m) => m!.name === into) ?? members[0]!;
        keep.roots = [...new Set(members.flatMap((m) => m!.roots))];
        keep.name = into;
        keep.note = keep.note
          ? `${keep.note}; merged from ${names.join(", ")}`
          : `merged from ${names.join(", ")}`;
        next.units = next.units.filter((x) => x === keep || !members.includes(x));
        break;
      }
      case "move": {
        const roots = rootsOf(o.root, i);
        const u = unit(o.to, i);
        if (roots && u) {
          release(roots);
          u.roots.push(...roots);
        }
        break;
      }
      case "set_roots": {
        const u = unit(o.unit, i);
        const roots = rootsOf(o.roots, i);
        if (u && roots) {
          release(roots);
          u.roots = roots;
        }
        break;
      }
      case "ignore": {
        const roots = rootsOf(o.roots, i);
        if (roots) {
          release(roots);
          next.ignored.push(...roots);
        }
        break;
      }
      case "unignore": {
        const roots = rootsOf(o.roots, i);
        if (roots) {
          const missing = roots.filter((r) => !next.ignored.includes(r));
          if (missing.length > 0) errors.push(`ops[${i}]: not ignored: ${missing.join(", ")}`);
          next.ignored = next.ignored.filter((r) => !roots.includes(r));
        }
        break;
      }
      case "note": {
        const u = unit(o.unit, i);
        if (u && typeof o.note === "string") u.note = o.note.trim();
        else if (u) errors.push(`ops[${i}]: note needs \`note\``);
        break;
      }
      default:
        errors.push(
          `ops[${i}]: unknown op ${JSON.stringify(o.op)} — one of ${ADJUST_OPS.join(", ")}`,
        );
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, cut: next };
}

// ---- cases: an oversized unit split to fit, its name kept --------------------

/** How much one case may read. The default is one PR round's sweep capacity
 * (`sweep_max_groups` × a sweep group, 6 × 5 files / 500 lines): a case is one
 * main pi fanning out leaf lenses, so it holds what a round holds. The scan's
 * `[scan]` config is where a repo tunes it. */
export interface CaseBudget {
  maxFiles: number;
  maxLines: number;
}

export const DEFAULT_CASE_BUDGET: CaseBudget = {
  maxFiles: SCAN_DEFAULTS.case_max_files,
  maxLines: SCAN_DEFAULTS.case_max_lines,
};

export interface CasePlan {
  /** The UNIT's name — never the part's. Reports group by this. */
  unit: string;
  /** `<unit>` when the unit fits, `<unit>#<i>` (1-based) when it was split. */
  id: string;
  part: number;
  parts: number;
  files: string[];
  lines: number;
  /** One file alone over the budget: it is its own case here — this split
   * never cuts a file. The SCAN then reads such a file in line ranges, one
   * case per range under the unit's name (scan.ts cutRanges). */
  over_budget: boolean;
}

interface Piece {
  files: string[];
  lines: number;
}

/**
 * Split one unit's files into cases that fit `budget`: subdirectory first
 * (a directory that fits stays whole), then file chunks in path order; small
 * neighbouring pieces are packed back together so a split never produces a
 * case per tiny directory. Every case keeps the unit's name. Deterministic:
 * the same files, sizes and budget always give the same cases. No files, no
 * case.
 */
export function splitUnit(
  unit: string,
  files: readonly string[],
  linesOf: (path: string) => number,
  budget: CaseBudget = DEFAULT_CASE_BUDGET,
): CasePlan[] {
  if (files.length === 0) return [];
  const sorted = [...files].sort();
  const size = new Map(sorted.map((f) => [f, Math.max(0, linesOf(f))]));
  const fits = (n: number, lines: number): boolean =>
    n <= budget.maxFiles && lines <= budget.maxLines;
  const total = (fs: readonly string[]): number => fs.reduce((n, f) => n + size.get(f)!, 0);

  const pieces = (fs: string[], depth: number): Piece[] => {
    const lines = total(fs);
    if (fits(fs.length, lines)) return [{ files: fs, lines }];
    // By the next path segment below the common prefix of this depth.
    const groups = new Map<string, string[]>();
    const loose: string[] = [];
    for (const f of fs) {
      const segs = f.split("/");
      if (segs.length - 1 > depth) {
        const key = segs.slice(0, depth + 1).join("/");
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(f);
      } else {
        loose.push(f);
      }
    }
    // One directory holding everything: descend without spending a split.
    if (loose.length === 0 && groups.size === 1) return pieces(fs, depth + 1);
    const out: Piece[] = [];
    for (const key of [...groups.keys()].sort()) out.push(...pieces(groups.get(key)!, depth + 1));
    out.push(...chunk(loose));
    return out;
  };

  const chunk = (fs: readonly string[]): Piece[] => {
    const out: Piece[] = [];
    let cur: Piece = { files: [], lines: 0 };
    for (const f of fs) {
      const n = size.get(f)!;
      if (cur.files.length > 0 && !fits(cur.files.length + 1, cur.lines + n)) {
        out.push(cur);
        cur = { files: [], lines: 0 };
      }
      cur.files.push(f);
      cur.lines += n;
    }
    if (cur.files.length > 0) out.push(cur);
    return out;
  };

  // Pack neighbours: a directory that fit on its own may share a case with
  // the next one when both still fit together.
  const packed: Piece[] = [];
  for (const p of pieces(sorted, commonDepth(sorted))) {
    const last = packed[packed.length - 1];
    if (last && fits(last.files.length + p.files.length, last.lines + p.lines)) {
      last.files.push(...p.files);
      last.lines += p.lines;
    } else {
      packed.push({ files: [...p.files], lines: p.lines });
    }
  }
  const parts = packed.length;
  return packed.map((p, i) => ({
    unit,
    id: parts === 1 ? unit : `${unit}#${i + 1}`,
    part: i + 1,
    parts,
    files: p.files,
    lines: p.lines,
    over_budget: !fits(p.files.length, p.lines),
  }));
}

/** Depth of the directory every file shares, so a unit rooted at
 * `backend/payments` splits by what is BELOW it rather than re-grouping on
 * `backend`. */
function commonDepth(files: readonly string[]): number {
  if (files.length === 0) return 0;
  const first = files[0]!.split("/").slice(0, -1);
  let depth = first.length;
  for (const f of files) {
    const segs = f.split("/").slice(0, -1);
    let d = 0;
    while (d < depth && d < segs.length && segs[d] === first[d]) d++;
    depth = d;
  }
  return depth;
}

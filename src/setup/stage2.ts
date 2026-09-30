// Scan stage 2's RULES (setup & scan spec "Scan stage 2"), pure:
// what a proposed row reads, which tests ride with its code, what it costs,
// how a proposal is fitted to a budget, and what the lens is told. The run
// itself is scanrun.ts's — the same hard-stopped, ledger-resumed run stage 1
// uses.
//
// Stage 2 is the scan's deep, targeted plan. The COMPANION proposes it from
// stage 1's deep-lens suggestions (its judgement is not tested; what these
// rules do with its rows is): each ROW is a file set × one deep lens × one
// tier, with a reason. Five rules bind a row, each structural here:
//
//   * A ROW MAY SPAN MODULES. Its files are any files of the tree at the scan
//     sha, whichever units own them — cross-cutting bugs (auth across views,
//     middleware and the model) live exactly between units. The row records
//     every unit it touches; a finding is filed under the unit that owns its
//     file.
//   * TESTS ARE PAIRED, ONLY HERE. Stage 1 never reads a test. In stage 2 a
//     test enters a row only as the pair of a code file the row names
//     (`pairTests`: same subject, same language family, nearest directory),
//     so the lens reads the contract the code is held to. A row that names a
//     test itself is refused — name the code it tests. Migrations, excluded
//     from stage 1 as well, may be named outright.
//   * ONLY A DEEP LENS, ONLY A TIER IT IS BUILT AT. A lens that needs a diff
//     or a PR body (`DIFF_ONLY_LENSES`), a lens the repo's profile switched
//     off, and a tier below the lens's `min_tier` (or other than `sol-high`
//     for a risk pass) are refused.
//   * PRICED FROM THE LEDGER (`priceStage2Row`). A row's price is its lines
//     at a $/kline: this lens measured at these settings when the ledger has
//     it ("measured" — the only price the preview calls a measurement);
//     else another DEEP lens measured at the same tier, effort and validator
//     setting ("borrowed" — never pass-scan, whose cheap wide rate reaches a
//     row only through a factor); else LEARNED: stage 1's measured rate at
//     the row's validator setting × the stage-2/stage-1 factor a deep lens
//     (this one first) showed at the same tier and effort with the validator
//     the OTHER way — stage 1 measured both ways is what carries the
//     skeptic's share across; else stage 1's rate scaled by `[scan]
//     unmeasured_rate_factor` ("extrapolated"). With no measured rate at all
//     there is no estimate, and the proposal is refused: run stage 1 first.
//     A price is fixed when the operator approves it: a run's own finished
//     cases never re-price that run (its hard stop stands) — the ledger rows
//     they write are what the NEXT proposal is priced from.
//   * FITTED TO A BUDGET, WHEN GIVEN ONE. Rows are kept in the companion's
//     order (most valuable first) while they fit; a row that does not fit is
//     left out and named, and a later, cheaper row may still fit. A row whose
//     every file the ledger already holds for its lens at this content is
//     `covered` — free, and not run again.
import { createHash } from "node:crypto";
import { globMatcher } from "../glob.js";
import { isSweepSkipped, isTestFile } from "../heuristics.js";
import { lensEnabled, flooredTier, type LensTuningMap } from "../lenstuning.js";
import { PASS_TIER_ORDER, type PassTier } from "../types.js";
import {
  caseEstimate,
  coverKey,
  cutRanges,
  focusLine,
  rangeNote,
  rangesCover,
  SCAN_DEEP_LENSES,
  type FileRange,
  SCAN_PASS,
  type PromptContext,
  type ScanCaseFile,
  type ScanRate,
  type TreeFile,
  type UnreadableReason,
} from "./scan.js";
import { measuredRate, rateWhere, type LedgerEntry } from "./ledger.js";
import { assign, type CaseBudget, type UnitCut } from "./unitcut.js";

/** At most this many rows in one proposal. */
export const MAX_STAGE2_ROWS = 100;
/** At most this many tests paired with one code file (the nearest win). */
export const MAX_PAIRED_PER_FILE = 3;
/** A row's reason is one line. */
export const ROW_REASON_MAX = 300;
/** The unit a file no unit of the cut owns is filed under. */
export const NO_UNIT = "(no unit)";

/** What the companion proposes for one row. */
export interface Stage2RowRequest {
  lens: string;
  files: string[];
  /** Default: the lens's floor over `[scan] tier` (`sol-high` for a risk pass). */
  tier?: string;
  reason: string;
}

export type PriceBasis = "measured" | "borrowed" | "learned" | "extrapolated";

export interface RowPrice {
  rate: ScanRate;
  basis: PriceBasis;
  /** The lens whose measured cost it is (this row's own when `measured`;
   * the lens the factor was learned from when `learned`). */
  from: string;
  /** `learned` only: the validator setting the stage-2 measurement was at,
   * its rate over stage 1's at that setting, and stage 1's rate at the row's
   * setting over that one (the skeptic's measured share, as a multiplier). */
  learned?: { validator: boolean; factor: number; skeptic: number };
  /** `extrapolated` only: the `[scan] unmeasured_rate_factor` applied. */
  factor?: number;
}

/** Stage 1 measured at BOTH validator settings at one tier and effort —
 * `[scan]`'s own when it has both, else the first other pair (sorted) that
 * does — or null: the skeptic's share is then unmeasured. */
function stage1Pair(entries: readonly LedgerEntry[], cfg: PriceSettings, validator: boolean): { row: ScanRate; other: ScanRate } | null {
  const at = (tier: string, effort: string) => {
    const row = measuredRate(entries, { lens: SCAN_PASS, tier, effort, validator });
    const other = measuredRate(entries, { lens: SCAN_PASS, tier, effort, validator: !validator });
    return row && other ? { row, other } : null;
  };
  const own = at(cfg.tier, cfg.effort);
  if (own) return own;
  const keys = [...new Set(entries.filter((e) => e.lens === SCAN_PASS).map((e) => `${e.tier}\0${e.effort}`))].sort();
  for (const k of keys) {
    const [tier, effort] = k.split("\0") as [string, string];
    const p = at(tier, effort);
    if (p) return p;
  }
  return null;
}

/** The scan settings a stage-2 price reads. */
export type PriceSettings = { tier: string; effort: string; validator: boolean; unmeasured_rate_factor: number };

/**
 * A stage-2 row's price at `lens`/`tier`/`effort` from the ledger (header
 * "PRICED FROM THE LEDGER"), or null when stage 1 has measured nothing.
 */
export function priceStage2Row(entries: readonly LedgerEntry[], cfg: PriceSettings, lens: string, tier: string, effort: string): RowPrice | null {
  const validator = cfg.validator;
  const own = measuredRate(entries, { lens, tier, effort, validator });
  if (own) return { rate: own, basis: "measured", from: lens };
  // Borrowed only from another DEEP lens: pass-scan is the cheap wide pass,
  // and its rate at a matching tier/effort (a profile giving a deep lens
  // `effort = "low"` at `[scan] tier`) would price a deep row at stage 1's
  // cost unscaled — stage 1's rate reaches a row only through a factor.
  const deepAt = (v: boolean, same: boolean) => (e: LedgerEntry): boolean =>
    (same ? e.lens === lens : e.lens !== lens && e.lens !== SCAN_PASS) && e.tier === tier && e.effort === effort && e.validator === v;
  const lensesOf = (keep: (e: LedgerEntry) => boolean): string =>
    [...new Set(entries.filter((e) => keep(e) && e.cost_usd !== null).map((e) => e.lens))].sort().join(", ");
  const borrowed = rateWhere(entries, deepAt(validator, false));
  if (borrowed) return { rate: borrowed, basis: "borrowed", from: lensesOf(deepAt(validator, false)) };
  // Stage 1 at a validator setting: at `[scan]`'s tier and effort, else at
  // any (the same fallback the extrapolation has always used).
  const stage1At = (v: boolean): ScanRate | null =>
    measuredRate(entries, { lens: SCAN_PASS, tier: cfg.tier, effort: cfg.effort, validator: v }) ??
    rateWhere(entries, (e) => e.lens === SCAN_PASS && e.validator === v);
  // Learned: a stage-2 measurement at the same tier and effort with the
  // validator the other way, carried across by the skeptic's measured share —
  // stage 1's rate at the row's setting over its rate at the other. Both
  // stage-1 rates must come from ONE tier and effort (`[scan]`'s first, else
  // the first other pair measured both ways): a ratio across tiers would be
  // the tier's price, not the skeptic's. The share is bounded by direction —
  // the skeptic adds work, so it can raise a price learned from a skeptic-off
  // measurement and lower one learned from a skeptic-on one, never the
  // reverse (two noisy stage-1 samples must not price a validated row UNDER
  // what the unvalidated lens was measured at).
  const other = !validator;
  const s1Row = stage1At(validator);
  const pair = stage1Pair(entries, cfg, validator);
  if (pair && pair.other.usd_per_kline > 0) {
    const raw = pair.row.usd_per_kline / pair.other.usd_per_kline;
    const skeptic = validator ? Math.max(raw, 1) : Math.min(raw, 1);
    for (const same of [true, false]) {
      const s2 = rateWhere(entries, deepAt(other, same));
      if (!s2) continue;
      return {
        rate: { ...s2, usd_per_kline: s2.usd_per_kline * skeptic },
        basis: "learned",
        from: lensesOf(deepAt(other, same)),
        learned: { validator: other, factor: s2.usd_per_kline / pair.other.usd_per_kline, skeptic },
      };
    }
  }
  const stage1 = s1Row ?? rateWhere(entries, (e) => e.lens === SCAN_PASS);
  if (!stage1) return null;
  return {
    rate: { ...stage1, usd_per_kline: stage1.usd_per_kline * cfg.unmeasured_rate_factor },
    basis: "extrapolated",
    from: SCAN_PASS,
    factor: cfg.unmeasured_rate_factor,
  };
}

export type Stage2RowStatus = "run" | "covered" | "over-budget";

export interface Stage2Row {
  /** `row-<n>`, in the companion's order. */
  id: string;
  lens: string;
  tier: PassTier;
  /** The lens's reasoning level (its profile `effort`, or `tier` = the
   * tier's own). Part of the price key. */
  effort: string;
  reason: string;
  /** Every unit the row's files belong to — more than one is a cross-module
   * row. */
  units: string[];
  /** The code files the companion named. */
  files: ScanCaseFile[];
  /** The tests paired with them. */
  tests: ScanCaseFile[];
  /** Tests that would have paired but did not fit the case budget. */
  unpaired: string[];
  /** A row naming ONE file too big for one case is cut into line ranges
   * (scan.ts cutRanges): one case per range still to read, each reading the
   * whole file (and the paired tests) but reporting only inside its range.
   * The named file's `lines` stays the file's; the row's is what the cases
   * read. Absent for an ordinary row. */
  ranges?: FileRange[];
  /** What the row's cases read in all — the price's basis. */
  lines: number;
  estimate_usd: number;
  price: RowPrice;
  status: Stage2RowStatus;
}

export interface Stage2PlanInput {
  rows: readonly Stage2RowRequest[];
  cut: UnitCut;
  files: readonly TreeFile[];
  linesOf: (path: string) => number | null;
  /** Why `linesOf` answered null (`binary`, `too-big`), when the tree knows. */
  whyUnreadable?: (path: string) => UnreadableReason | null;
  /** A file's text, where a range cut looks for declaration boundaries. */
  textOf?: (path: string) => string | null;
  exclude: readonly string[];
  budget: CaseBudget;
  lenses?: LensTuningMap;
  riskPasses: readonly string[];
  /** `[scan] tier` — a row's default tier before the lens's floor. */
  defaultTier: PassTier;
  /** `coverKey`s the ledger holds for `lens`. */
  covered: (lens: string) => ReadonlySet<string>;
  /** `path\0blob` → the ranges a still-incomplete reading by `lens` holds. */
  partial?: (lens: string) => ReadonlyMap<string, readonly { start: number; end: number }[]>;
  /** The price of a lens at a tier and effort, or null when nothing measured
   * can price it. */
  price: (lens: string, tier: PassTier, effort: string) => RowPrice | null;
  /** Fit the runnable rows to this many dollars; null = no budget. */
  budgetUsd: number | null;
}

export type Stage2Plan =
  | {
      ok: true;
      rows: Stage2Row[];
      /** The rows that run, and their total — the hard stop. */
      runnable: number;
      total_usd: number;
      /** Rows the budget left out, and what they would have cost. */
      over_budget_usd: number;
    }
  | { ok: false; errors: string[] };

/** A row's effort as the ledger keys it: the lens's profile `effort`, or
 * `tier` (the tier's own reasoning level). */
export function lensEffort(lenses: LensTuningMap | undefined, lens: string): string {
  return lenses?.[lens]?.effort ?? "tier";
}

/** The tiers `lens` may run at in a scan: the ones its build variants exist
 * at, at or above its profile floor. */
export function lensTiers(lenses: LensTuningMap | undefined, lens: string, riskPasses: readonly string[]): PassTier[] {
  if (riskPasses.includes(lens)) return ["sol-high"];
  const floor = flooredTier(lenses, lens, PASS_TIER_ORDER[0]!);
  return PASS_TIER_ORDER.slice(PASS_TIER_ORDER.indexOf(floor));
}

/** The deep lenses stage 2 may run on this repo: stage 1's suggestible set,
 * less every lens the profile switched off. */
export function stage2Lenses(lenses: LensTuningMap | undefined): string[] {
  return SCAN_DEEP_LENSES.filter((l) => lensEnabled(lenses, l, true));
}

// ---- pairing tests -------------------------------------------------------------

const TEST_DIRS = new Set(["test", "tests", "__tests__", "spec", "specs", "testing", "main"]);
const FAMILY: Record<string, string> = { ts: "js", tsx: "js", js: "js", jsx: "js", mjs: "js", cjs: "js", mts: "js", cts: "js" };

function ext(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const i = base.lastIndexOf(".");
  return i <= 0 ? "" : base.slice(i + 1).toLowerCase();
}

function family(path: string): string {
  const e = ext(path);
  return FAMILY[e] ?? e;
}

function dirSegs(path: string): string[] {
  const i = path.lastIndexOf("/");
  return i < 0 ? [] : path.slice(0, i).split("/");
}

/** A code file's subject: its basename without the extension. */
function codeStem(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const i = base.lastIndexOf(".");
  return (i <= 0 ? base : base.slice(0, i)).toLowerCase();
}

/** A test file's subject: its basename with the extension and every test
 * marker (`test_`, `_test`, `.test`, `.spec`, `Test`, …) stripped. */
function testStem(path: string): string {
  let s = path.slice(path.lastIndexOf("/") + 1);
  const i = s.lastIndexOf(".");
  if (i > 0) s = s.slice(0, i);
  s = s.replace(/[._-](test|spec)s?$/i, "").replace(/(?<=[a-z0-9])Tests?$/, "").replace(/^tests?[_-]/i, "");
  return s.toLowerCase();
}

const endsWithSegs = (a: string[], b: string[]): boolean => b.length <= a.length && b.every((s, i) => a[a.length - b.length + i] === s);

/**
 * The tests in `tree` that pair with `code`: same subject, same language
 * family, and a directory that mirrors the code's once the test directories
 * (`tests/`, `__tests__/`, `src/test` vs `src/main`, …) are set aside — the
 * code's own directory, a `tests/` beside or under it, or a top-level tests
 * tree mirroring its package. The nearest (most shared leading directories)
 * win, at most `MAX_PAIRED_PER_FILE`. A heuristic, deliberately: a pair is
 * reading context for the lens, never a claim about coverage.
 */
export function pairTests(code: string, tree: readonly string[]): string[] {
  const stem = codeStem(code);
  if (stem === "" || isTestFile(code)) return [];
  const fam = family(code);
  const cDir = dirSegs(code);
  const cNorm = cDir.filter((s) => !TEST_DIRS.has(s.toLowerCase()));
  const scored: Array<{ path: string; score: number }> = [];
  for (const t of tree) {
    if (t === code || !isTestFile(t) || family(t) !== fam || testStem(t) !== stem) continue;
    const tDir = dirSegs(t);
    const tNorm = tDir.filter((s) => !TEST_DIRS.has(s.toLowerCase()));
    if (!(endsWithSegs(cNorm, tNorm) || endsWithSegs(tNorm, cNorm))) continue;
    let shared = 0;
    while (shared < cDir.length && shared < tDir.length && cDir[shared] === tDir[shared]) shared++;
    scored.push({ path: t, score: shared * 10 - Math.abs(tNorm.length - cNorm.length) });
  }
  scored.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return scored.slice(0, MAX_PAIRED_PER_FILE).map((s) => s.path);
}

// ---- the plan ------------------------------------------------------------------

const cleanPath = (p: string): string => p.trim().replace(/^`+|`+$/g, "").replace(/^\.?\/+/, "");

/**
 * Plan a proposal: every row checked (all-or-nothing — one bad row refuses
 * the proposal, each problem named), tests paired, units found, each row
 * priced, covered rows marked, then the runnable rows fitted to the budget.
 * Deterministic.
 */
export function planStage2(input: Stage2PlanInput): Stage2Plan {
  const errors: string[] = [];
  if (input.rows.length === 0) return { ok: false, errors: ["a stage 2 proposal needs at least one row"] };
  if (input.rows.length > MAX_STAGE2_ROWS) {
    return { ok: false, errors: [`${input.rows.length} rows — at most ${MAX_STAGE2_ROWS} in one proposal`] };
  }
  const excluded = globMatcher(input.exclude);
  const blobs = new Map(input.files.map((f) => [f.path, f.blob]));
  const treePaths = [...blobs.keys()].sort();
  const unitOf = unitOwner(input.cut, treePaths);
  const allowed = stage2Lenses(input.lenses);
  const seen = new Set<string>();
  const rows: Stage2Row[] = [];

  input.rows.forEach((req, i) => {
    const id = `row-${i + 1}`;
    const bad = (why: string): void => void errors.push(`${id}: ${why}`);
    const lens = typeof req?.lens === "string" ? req.lens.trim() : "";
    if (lens === SCAN_PASS) return bad(`${SCAN_PASS} is stage 1's lens — a stage 2 row names a deep lens`);
    if (!allowed.includes(lens)) {
      return bad(
        SCAN_DEEP_LENSES.includes(lens)
          ? `${JSON.stringify(lens)} is switched off by this repo's profile`
          : `${JSON.stringify(lens)} is not a deep lens a scan can run (one of: ${allowed.join(", ")})`,
      );
    }
    const reason = typeof req.reason === "string" ? req.reason.trim().replace(/\s+/g, " ") : "";
    if (reason === "") return bad("no reason — say in one line what the lens should chase");
    if (reason.length > ROW_REASON_MAX) return bad(`the reason is ${reason.length} characters — one line, at most ${ROW_REASON_MAX}`);
    const tiers = lensTiers(input.lenses, lens, input.riskPasses);
    let tier: PassTier;
    if (req.tier === undefined || req.tier === null || req.tier === "") {
      tier = input.riskPasses.includes(lens) ? "sol-high" : flooredTier(input.lenses, lens, input.defaultTier);
    } else if ((tiers as readonly string[]).includes(req.tier)) {
      tier = req.tier as PassTier;
    } else {
      return bad(`${lens} cannot run at ${JSON.stringify(req.tier)} here — one of: ${tiers.join(", ")}`);
    }
    const named = [...new Set((Array.isArray(req.files) ? req.files : []).filter((p) => typeof p === "string").map(cleanPath))].filter(
      (p) => p !== "",
    );
    if (named.length === 0) return bad("no files");
    const problems: string[] = [];
    const lines = new Map<string, number>();
    for (const p of named) {
      if (!blobs.has(p)) problems.push(`${p} is not in the tree at the scan sha`);
      else if (isTestFile(p)) problems.push(`${p} is a test — tests enter stage 2 only paired with the code they test; name that code`);
      else if (isSweepSkipped(p)) problems.push(`${p} is not code a lens reads (lockfile, generated, binary or prose)`);
      else if (excluded(p)) problems.push(`${p} is excluded from scans by [scan] exclude`);
      else {
        const n = input.linesOf(p);
        if (n === null) {
          const why = input.whyUnreadable?.(p) ?? null;
          problems.push(`${p} cannot be read as text${why === "binary" ? " (skipped: binary)" : why === "too-big" ? " (skipped: over the size cap)" : ""}`);
        }
        else lines.set(p, n);
      }
    }
    if (problems.length > 0) return bad(problems.join("; "));
    const sorted = [...named].sort();
    const dedupe = `${lens}\0${sorted.join("\0")}`;
    if (seen.has(dedupe)) return bad(`the same ${lens} row as an earlier one`);
    seen.add(dedupe);

    let rowLines = sorted.reduce((n, p) => n + lines.get(p)!, 0);
    // One file too big for one case is cut into line ranges; anywhere else a
    // row over one case is refused.
    const oversize = sorted.length === 1 && lines.get(sorted[0]!)! > input.budget.maxLines;
    if (!oversize && (sorted.length > input.budget.maxFiles || rowLines > input.budget.maxLines)) {
      const big = sorted.filter((p) => lines.get(p)! > input.budget.maxLines);
      return bad(
        `${sorted.length} files, ${rowLines} lines — over one case (${input.budget.maxFiles} files, ${input.budget.maxLines} lines); split it into narrower rows` +
          (big.length > 0
            ? ` (${big.join(", ")} ${big.length === 1 ? "is" : "are"} over one case alone — name ${big.length === 1 ? "it" : "each"} alone in a row and it is cut into line ranges)`
            : ""),
      );
    }
    // Pair the tests, nearest first, while the case budget holds. A ranged
    // row's tests ride in EVERY range case, so they get at most half a case.
    const testFiles = oversize ? input.budget.maxFiles - 1 : input.budget.maxFiles - sorted.length;
    const testLines = oversize ? Math.floor(input.budget.maxLines / 2) : input.budget.maxLines - rowLines;
    let pairedLines = 0;
    const tests: ScanCaseFile[] = [];
    const unpaired: string[] = [];
    const taken = new Set(sorted);
    for (const code of sorted) {
      for (const t of pairTests(code, treePaths)) {
        if (taken.has(t)) continue;
        taken.add(t);
        // An excluded file is never scanned — paired or named.
        if (excluded(t)) continue;
        const n = input.linesOf(t);
        if (n === null) continue;
        if (tests.length + 1 > testFiles || pairedLines + n > testLines) {
          unpaired.push(t);
          continue;
        }
        tests.push({ path: t, blob: blobs.get(t)!, lines: n });
        pairedLines += n;
      }
    }
    let ranges: FileRange[] | undefined;
    if (oversize) {
      const p = sorted[0]!;
      const done = input.partial?.(lens).get(coverKey(p, blobs.get(p)!)) ?? [];
      ranges = cutRanges(lines.get(p)!, input.budget.maxLines - pairedLines, input.textOf?.(p) ?? null).filter(
        (r) => !rangesCover(done, r.start, r.end),
      );
      rowLines = ranges.reduce((n, r) => n + (r.end - r.start + 1) + pairedLines, 0);
    } else {
      rowLines += pairedLines;
    }
    const effort = lensEffort(input.lenses, lens);
    const price = input.price(lens, tier, effort);
    if (price === null) {
      return bad(`no measured price for any scan lens yet — run stage 1 (its calibration run prices the scan) before proposing stage 2`);
    }
    const files = sorted.map((p) => ({ path: p, blob: blobs.get(p)!, lines: lines.get(p)! }));
    const cover = input.covered(lens);
    const all = [...files, ...tests];
    const isCovered = all.every((f) => cover.has(coverKey(f.path, f.blob))) || (ranges !== undefined && ranges.length === 0);
    rows.push({
      id,
      lens,
      tier,
      effort,
      reason,
      units: [...new Set(all.map((f) => unitOf(f.path)))].sort(),
      files,
      tests,
      unpaired,
      ...(ranges !== undefined ? { ranges } : {}),
      lines: rowLines,
      estimate_usd: isCovered
        ? 0
        : ranges !== undefined
          ? ranges.reduce((n, r) => n + caseEstimate(r.end - r.start + 1 + pairedLines, price.rate), 0)
          : caseEstimate(rowLines, price.rate),
      price,
      status: isCovered ? "covered" : "run",
    });
  });
  if (errors.length > 0) return { ok: false, errors };

  let total = 0;
  let over = 0;
  for (const r of rows) {
    if (r.status !== "run") continue;
    if (input.budgetUsd !== null && total + r.estimate_usd > input.budgetUsd + 1e-9) {
      r.status = "over-budget";
      over += r.estimate_usd;
      continue;
    }
    total += r.estimate_usd;
  }
  const runnable = rows.filter((r) => r.status === "run").length;
  return { ok: true, rows, runnable, total_usd: total, over_budget_usd: over };
}

/** The unit owning each tree path under `cut` (NO_UNIT for none). */
export function unitOwner(cut: UnitCut, paths: readonly string[]): (path: string) => string {
  const owner = new Map<string, string>();
  for (const [unit, ps] of assign(cut, paths).byUnit) for (const p of ps) owner.set(p, unit);
  return (p) => owner.get(p) ?? NO_UNIT;
}

// ---- the prompt ----------------------------------------------------------------

/** The cases one row runs as: the row itself, or — a row over a file too
 * big for one case — one per range, `<row>#<i>`, each the ranged file plus
 * the paired tests. */
export function stage2Cases(row: Stage2Row): Array<{ id: string; part: number; parts: number; files: ScanCaseFile[]; lines: number }> {
  if (row.ranges === undefined) return [{ id: row.id, part: 1, parts: 1, files: [...row.files, ...row.tests], lines: row.lines }];
  const code = row.files[0]!;
  const tests = row.tests.reduce((n, t) => n + t.lines, 0);
  return row.ranges.map((r, i) => ({
    id: `${row.id}#${i + 1}`,
    part: i + 1,
    parts: row.ranges!.length,
    files: [{ ...code, lines: r.end - r.start + 1, range: r }, ...row.tests],
    lines: r.end - r.start + 1 + tests,
  }));
}

/** The stage-2 task string for one row — or, for a ranged row, for the one
 * case whose `files` (from `stage2Cases`) are given. */
export function stage2CasePrompt(row: Stage2Row, ctx: PromptContext, caseFiles?: readonly ScanCaseFile[]): string {
  const list = (fs: readonly ScanCaseFile[]): string => fs.map(focusLine).join("\n");
  const code = caseFiles ? caseFiles.slice(0, row.files.length) : row.files;
  return [
    `SCAN CASE ${ctx.caseId} — stage 2, ${row.id}: ${row.lens}${row.units.length > 1 ? ` across units ${row.units.join(", ")}` : ` in unit ${row.units[0]}`}.`,
    `Scan sha: ${ctx.sha}`,
    `Tree root (the repository at the scan sha, read-only): ${ctx.root}`,
    "Every path below and in your answer is relative to the tree root.",
    "",
    `Why this case: ${row.reason}`,
    "",
    `Focus files (${code.length} — read each in full; they are one case because the problem may live between them):`,
    list(code),
    ...rangeNote(code),
    ...(row.tests.length > 0
      ? ["", `Their tests (${row.tests.length} — read them for the contract the code is held to; a missing test is not a finding):`, list(row.tests)]
      : []),
    "",
    `Answer with the findings block headed \`FINDINGS ${row.lens} SCAN ${ctx.caseId} @${ctx.sha}\` (or NONE).`,
  ].join("\n");
}

/** The key a stage-2 start must quote: the runnable rows, the sha, the
 * validator setting and the cap. */
export function stage2Key(parts: unknown): string {
  return createHash("sha256").update(JSON.stringify({ stage: 2, parts })).digest("hex").slice(0, 16);
}

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
//   * PRICED FROM THE LEDGER. A row's price is its lines at a measured
//     $/kline: this lens at these settings when the ledger has it; else
//     another lens measured at the same tier, effort and validator setting
//     ("borrowed"); else stage 1's own measured rate scaled by `[scan]
//     unmeasured_rate_factor` ("extrapolated"). With no measured rate at all
//     there is no estimate, and the proposal is refused: run stage 1 first.
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
  SCAN_DEEP_LENSES,
  SCAN_PASS,
  type PromptContext,
  type ScanCaseFile,
  type ScanRate,
  type TreeFile,
} from "./scan.js";
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

export type PriceBasis = "measured" | "borrowed" | "extrapolated";

export interface RowPrice {
  rate: ScanRate;
  basis: PriceBasis;
  /** The lens whose measured cost it is (this row's own when `measured`). */
  from: string;
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
  exclude: readonly string[];
  budget: CaseBudget;
  lenses?: LensTuningMap;
  riskPasses: readonly string[];
  /** `[scan] tier` — a row's default tier before the lens's floor. */
  defaultTier: PassTier;
  /** `coverKey`s the ledger holds for `lens`. */
  covered: (lens: string) => ReadonlySet<string>;
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
        if (n === null) problems.push(`${p} cannot be read as text`);
        else lines.set(p, n);
      }
    }
    if (problems.length > 0) return bad(problems.join("; "));
    const sorted = [...named].sort();
    const dedupe = `${lens}\0${sorted.join("\0")}`;
    if (seen.has(dedupe)) return bad(`the same ${lens} row as an earlier one`);
    seen.add(dedupe);

    let rowLines = sorted.reduce((n, p) => n + lines.get(p)!, 0);
    if (sorted.length > input.budget.maxFiles || rowLines > input.budget.maxLines) {
      return bad(
        `${sorted.length} files, ${rowLines} lines — over one case (${input.budget.maxFiles} files, ${input.budget.maxLines} lines); split it into narrower rows`,
      );
    }
    // Pair the tests, nearest first, while the case budget holds.
    const tests: ScanCaseFile[] = [];
    const unpaired: string[] = [];
    const taken = new Set(sorted);
    for (const code of sorted) {
      for (const t of pairTests(code, treePaths)) {
        if (taken.has(t)) continue;
        taken.add(t);
        const n = input.linesOf(t);
        if (n === null) continue;
        if (sorted.length + tests.length + 1 > input.budget.maxFiles || rowLines + n > input.budget.maxLines) {
          unpaired.push(t);
          continue;
        }
        tests.push({ path: t, blob: blobs.get(t)!, lines: n });
        rowLines += n;
      }
    }
    const effort = lensEffort(input.lenses, lens);
    const price = input.price(lens, tier, effort);
    if (price === null) {
      return bad(`no measured price for any scan lens yet — run stage 1 (its calibration run prices the scan) before proposing stage 2`);
    }
    const files = sorted.map((p) => ({ path: p, blob: blobs.get(p)!, lines: lines.get(p)! }));
    const cover = input.covered(lens);
    const all = [...files, ...tests];
    const isCovered = all.every((f) => cover.has(coverKey(f.path, f.blob)));
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
      lines: rowLines,
      estimate_usd: isCovered ? 0 : caseEstimate(rowLines, price.rate),
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

/** The stage-2 task string for one row. */
export function stage2CasePrompt(row: Stage2Row, ctx: PromptContext): string {
  const list = (fs: readonly ScanCaseFile[]): string => fs.map((f) => `- ${f.path} (${f.lines} lines)`).join("\n");
  return [
    `SCAN CASE ${ctx.caseId} — stage 2, ${row.id}: ${row.lens}${row.units.length > 1 ? ` across units ${row.units.join(", ")}` : ` in unit ${row.units[0]}`}.`,
    `Scan sha: ${ctx.sha}`,
    `Tree root (the repository at the scan sha, read-only): ${ctx.root}`,
    "Every path below and in your answer is relative to the tree root.",
    "",
    `Why this case: ${row.reason}`,
    "",
    `Focus files (${row.files.length} — read each in full; they are one case because the problem may live between them):`,
    list(row.files),
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

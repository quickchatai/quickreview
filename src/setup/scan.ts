// Scan stage 1's RULES (setup & scan spec "Scan stage 1"), pure:
// what a stage-1 case reads, what it is expected to cost, what the lens is
// told, how its answer is read back, and a scan finding's identity. The
// stateful half — the run, the ledger, the findings store — is scanrun.ts,
// ledger.ts and findings.ts, every effect through a port.
//
// Stage 1 is `pass-scan` over every unit of the SAVED unit cut, one case per
// unit (an oversized unit splits, its name kept; a single FILE over one case
// is read in overlapping line ranges, one case each — `cutRanges`), at the `[scan]` tier and
// effort. It never reads tests or migrations (they enter only in stage 2,
// paired with their code), nor what no pass reads (lockfiles, generated
// output, binaries, prose — `isSweepSkipped`), nor the operator's `[scan]
// exclude` globs. A file the coverage ledger already holds at the same
// content hash for `pass-scan` is not read again: that is how an interrupted
// scan resumes, and why a finished one costs nothing to "re-run".
//
// A DELTA re-scan is stage 1 over the files whose content CHANGED
// since the last scan (read by the ledger at another content, or new or
// different against the tree the last scan read) AND every file no complete
// reading covers at its content — never read (a capped or stopped run's
// tail; unreadable then, readable now) or cut short between ranges. Those
// are OWED, not skipped: a delta that left them out would leave a file no
// lens ever read out of every delta for as long as it stays unchanged.
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { ALL_PASSES } from "../dispatch.js";
import { globMatcher } from "../glob.js";
import { isSweepSkipped, isTestFile } from "../heuristics.js";
import { SCAN_FALSE_POSITIVE_CLASSES, VALIDATE_PASS } from "../include.js";
import { REACHABILITY_VALUES, reachabilityCappedSeverity, type Reachability } from "../severity.js";
import { assign, splitUnit, type CaseBudget, type UnitCut } from "./unitcut.js";

/** The stage-1 lens (agents/scan/pass-scan.md). */
export const SCAN_PASS = "pass-scan";

/** Lenses a stage-1 suggestion may NOT name: each needs a diff, a PR body or
 * a mid-round session to mean anything (diff-only exclusions),
 * plus the validator, which is not a lens. */
export const DIFF_ONLY_LENSES: readonly string[] = [
  "pass-intent",
  "pass-claims",
  "pass-backcompat",
  "pass-rollout",
  "pass-delivery",
  "pass-widened",
  "pass-sweep",
  "pass-ask-human",
  VALIDATE_PASS,
];

/** The deep lenses stage 1 may point stage 2 at. */
export const SCAN_DEEP_LENSES: readonly string[] = ALL_PASSES.filter((p) => !DIFF_ONLY_LENSES.includes(p));

/** Migration files, whatever the stack calls their directory. */
const MIGRATION_RE = /(^|\/)(migrations?|alembic\/versions|db\/migrate)\//i;

export function isMigrationFile(path: string): boolean {
  return MIGRATION_RE.test(path);
}

export type ExclusionReason = "test" | "migration" | "unreadable-kind" | "excluded-glob";

/** Why stage 1 does not read `path`, or null when it does. */
export function stage1Exclusion(path: string, excluded: (p: string) => boolean): ExclusionReason | null {
  if (isSweepSkipped(path)) return "unreadable-kind";
  if (isTestFile(path)) return "test";
  if (isMigrationFile(path)) return "migration";
  if (excluded(path)) return "excluded-glob";
  return null;
}

// ---- the plan ----------------------------------------------------------------

export interface TreeFile {
  path: string;
  /** The git blob hash — the content hash the ledger keys on. */
  blob: string;
}

export interface ScanCaseFile {
  path: string;
  blob: string;
  /** Lines this case READS of the file for sizing and price: the whole file,
   * or its `range`'s length. */
  lines: number;
  /** A file over one case is cut into line ranges (`cutRanges`): this case
   * reads the whole file for context but reports only inside `range`. */
  range?: FileRange;
}

/** One line range of a file too big for one case — 1-based, inclusive, and
 * `total` the file's own line count (what the ledger's coverage needs). */
export interface FileRange {
  start: number;
  end: number;
  total: number;
}

/** Neighbouring ranges overlap by this many lines at most (a tenth of the
 * window below that), so a finding straddling a cut sits whole in one. */
export const RANGE_OVERLAP_MAX = 40;

/** A top-level declaration: a line a cut may fall just before. */
const DECL_RE =
  /^(export\s+(default\s+)?)?(declare\s+)?(abstract\s+)?(async\s+)?(pub(\([a-z]+\))?\s+)?(def|class|function\*?|interface|type|enum|const|let|var|namespace|module|fn|func|impl|struct|trait|object)\b/;
/** Lines that belong to the declaration below them (decorators, comments). */
const LEAD_RE = /^(@\w|#|\/\/|\/\*|\s\*)/;

/**
 * Cut a file of `total` lines into windows of at most `maxLines`: each
 * window ends just before a top-level declaration found in its second half
 * when the text is at hand (pulled above that declaration's decorators and
 * comments), else at the limit; the next starts a few lines earlier
 * (`RANGE_OVERLAP_MAX`), so neighbours overlap and nothing falls between
 * them. A file that fits is one window. Deterministic.
 */
export function cutRanges(total: number, maxLines: number, text: string | null): FileRange[] {
  const n = Math.max(0, Math.floor(total));
  const w = Math.max(1, Math.floor(maxLines));
  if (n <= w) return [{ start: 1, end: Math.max(n, 1), total: n }];
  const overlap = Math.min(RANGE_OVERLAP_MAX, Math.floor(w / 10));
  const lines = text === null ? null : text.split("\n");
  const at = (l: number): string => (lines === null ? "" : (lines[l - 1] ?? ""));
  const out: FileRange[] = [];
  let s = 1;
  for (;;) {
    if (n - s + 1 <= w) {
      out.push({ start: s, end: n, total: n });
      return out;
    }
    let end = s + w - 1;
    if (lines !== null) {
      const floor = s + Math.ceil(w / 2);
      for (let l = end + 1; l > floor; l--) {
        if (!DECL_RE.test(at(l))) continue;
        let first = l;
        while (first - 1 > floor && LEAD_RE.test(at(first - 1))) first--;
        end = first - 1;
        break;
      }
    }
    out.push({ start: s, end, total: n });
    s = Math.max(end + 1 - overlap, s + 1);
  }
}

/** Does the union of `ranges` cover every line of `start..end`? */
export function rangesCover(ranges: readonly { start: number; end: number }[], start: number, end: number): boolean {
  let reach = start - 1;
  for (const r of [...ranges].sort((a, b) => a.start - b.start)) {
    if (r.start > reach + 1) break;
    reach = Math.max(reach, r.end);
    if (reach >= end) return true;
  }
  return reach >= end;
}

export interface ScanCasePlan {
  /** The UNIT's name, never the part's. */
  unit: string;
  /** `<unit>` or `<unit>#<i>` — unitcut.ts's spelling. */
  id: string;
  part: number;
  parts: number;
  files: ScanCaseFile[];
  lines: number;
}

export interface Stage1Plan {
  cases: ScanCasePlan[];
  /** Files stage 1 skips, by reason. */
  excluded: Record<ExclusionReason, number>;
  /** Readable files the ledger already covers at this content. */
  covered: number;
  /** Files at this sha no unit of the saved cut owns (the repo outgrew it). */
  unassigned: string[];
  /** Files the tree lists but whose text cannot be read (binary, too big). */
  unreadable: number;
  /** Each of those files and why (`binary`, `too-big`, `unreadable` when the
   * tree cannot say) — reported, never silently absent from coverage. */
  skipped: SkippedFile[];
  /** Delta only: planned files whose content has NOT changed since the last
   * scan but that no complete reading covers at it — never read (the rest of
   * an unfinished scan, or unreadable then and readable now), or read only in
   * part. A delta owes them as much as the changed ones (0 for a full plan). */
  owed: number;
}

/** What a delta re-scan compares against. */
export interface DeltaBasis {
  /** Each path's newest content hash in the ledger for `pass-scan`. */
  read: ReadonlyMap<string, string>;
  /** The tree the last scan read: path → blob. */
  baseline: ReadonlyMap<string, string>;
}

/** Has `f`'s content changed since the last scan? Newest read by the ledger
 * at another content, or absent from / different in the last scan's tree.
 * Not what a delta reads by: an unchanged file with no complete reading at
 * this content is owed too (planStage1). */
export function changedSince(f: TreeFile, basis: DeltaBasis): boolean {
  const read = basis.read.get(f.path);
  if (read !== undefined && read !== f.blob) return true;
  const was = basis.baseline.get(f.path);
  return was === undefined || was !== f.blob;
}

/** Why a listed file has no text for a lens. */
export type UnreadableReason = "binary" | "too-big" | "unreadable";

export interface SkippedFile {
  path: string;
  why: UnreadableReason;
}

export interface PlanInput {
  cut: UnitCut;
  files: readonly TreeFile[];
  linesOf: (path: string) => number | null;
  /** Why `linesOf` answered null; absent = `unreadable` (the reason unknown). */
  whyUnreadable?: (path: string) => UnreadableReason | null;
  /** `path\0blob` of each file's newest ledger reading for `pass-scan`. */
  covered: ReadonlySet<string>;
  exclude: readonly string[];
  budget: CaseBudget;
  /** A delta re-scan: files changed since the last scan, and every file no
   * complete reading covers at its content (`covered`, `history`). */
  delta?: DeltaBasis;
  /** A file's text, where a range cut looks for declaration boundaries;
   * absent (or null) = fixed windows. */
  textOf?: (path: string) => string | null;
  /** `path\0blob` → the line ranges the ledger's newest, still-incomplete
   * reading holds for `pass-scan`: a range inside them is not read again. */
  partial?: ReadonlyMap<string, readonly { start: number; end: number }[]>;
  /** path → the ledger's newest `pass-scan` reading of it (any content):
   * what orders the cases. Absent: the plan's own (unit) order stands. */
  history?: ReadonlyMap<string, PriorReading>;
}

/** A file's newest reading as the plan orders by it (ledger.ts `readings`). */
export interface PriorReading {
  blob: string;
  /** Whole file, or ranges covering every line. */
  complete: boolean;
  /** When that reading's newest row was written (ISO): among changed files
   * the stalest reading runs first. */
  at: string;
}

/**
 * Coverage first (scan-loop). The hard stop ends a run whose actuals outrun
 * its estimate before the plan's tail, so the tail must not be the SAME
 * cases every run: a file the ledger never read, or whose newest reading was
 * cut short between ranges, is tier 0; a file read before at other content
 * is tier 1 (changed); anything else is tier 2. A case takes its best file's
 * tier; a tier keeps the plan's order.
 */
export function readTier(f: { path: string; blob: string }, history: ReadonlyMap<string, PriorReading>): 0 | 1 | 2 {
  const r = history.get(f.path);
  if (r === undefined || !r.complete) return 0;
  return r.blob !== f.blob ? 1 : 2;
}

export const coverKey = (path: string, blob: string): string => `${path}\0${blob}`;

/** Stage 1 over the saved cut at one tree: every readable, uncovered,
 * non-excluded file (a delta the same set, counting what it owes unchanged
 * as `owed`), one case per
 * unit, split to fit — ordered coverage-first by `history` (readTier).
 * Deterministic. */
export function planStage1(input: PlanInput): Stage1Plan {
  const excludedGlob = globMatcher(input.exclude);
  const excluded: Record<ExclusionReason, number> = { test: 0, migration: 0, "unreadable-kind": 0, "excluded-glob": 0 };
  const blobs = new Map(input.files.map((f) => [f.path, f.blob]));
  const lines = new Map<string, number>();
  let covered = 0;
  let unreadable = 0;
  const skipped: SkippedFile[] = [];
  const unchangedPaths = new Set<string>();
  const readable: string[] = [];
  // Files over one case: the ranges still to read, cut up front.
  const ranged = new Map<string, FileRange[]>();
  for (const f of [...input.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const why = stage1Exclusion(f.path, excludedGlob);
    if (why !== null) {
      excluded[why]++;
      continue;
    }
    const n = input.linesOf(f.path);
    if (n === null) {
      unreadable++;
      skipped.push({ path: f.path, why: input.whyUnreadable?.(f.path) ?? "unreadable" });
      continue;
    }
    if (input.covered.has(coverKey(f.path, f.blob))) {
      covered++;
      continue;
    }
    // A delta reads what changed since the last scan AND every file no
    // complete reading covers at this content — never read (the rest of an
    // unfinished scan; unreadable then, readable now), or cut short between
    // ranges. Past `covered`, that is every file left: a delta leaves out only
    // what an ordinary plan leaves out, and says how much it owes unchanged.
    // (Self-scan round 7: a never-read, unchanged file was skipped as
    // "unchanged" — no lens had ever read it.)
    if (input.delta !== undefined && !changedSince(f, input.delta)) unchangedPaths.add(f.path);
    if (n > input.budget.maxLines) {
      const done = input.partial?.get(coverKey(f.path, f.blob)) ?? [];
      const todo = cutRanges(n, input.budget.maxLines, input.textOf?.(f.path) ?? null).filter(
        (r) => !rangesCover(done, r.start, r.end),
      );
      if (todo.length === 0) {
        covered++;
        continue;
      }
      ranged.set(f.path, todo);
    }
    lines.set(f.path, n);
    readable.push(f.path);
  }
  const a = assign(input.cut, readable);
  const cases: ScanCasePlan[] = [];
  for (const u of input.cut.units) {
    const owned = a.byUnit.get(u.name) ?? [];
    if (owned.length === 0) continue;
    // A file over one case is alone in its split case; it becomes one case
    // per range. Parts are numbered over the unit's final list.
    const parts: Array<{ files: ScanCaseFile[]; lines: number }> = [];
    for (const c of splitUnit(u.name, owned, (p) => lines.get(p) ?? 0, input.budget)) {
      const only = c.files.length === 1 ? ranged.get(c.files[0]!) : undefined;
      if (only !== undefined) {
        const p = c.files[0]!;
        for (const r of only) {
          parts.push({ files: [{ path: p, blob: blobs.get(p)!, lines: r.end - r.start + 1, range: r }], lines: r.end - r.start + 1 });
        }
        continue;
      }
      parts.push({ files: c.files.map((p) => ({ path: p, blob: blobs.get(p)!, lines: lines.get(p) ?? 0 })), lines: c.lines });
    }
    parts.forEach((p, i) => {
      cases.push({
        unit: u.name,
        id: parts.length === 1 ? u.name : `${u.name}#${i + 1}`,
        part: i + 1,
        parts: parts.length,
        files: p.files,
        lines: p.lines,
      });
    });
  }
  const history = input.history;
  if (history !== undefined) {
    const rank = (c: ScanCasePlan, i: number) => {
      const tiers = c.files.map((f) => readTier(f, history));
      const t = Math.min(...tiers);
      // The stalest tier-1 reading of the case ("" sorts first; tier 0/2 unused).
      let at = "";
      if (t === 1) {
        const stamps = c.files.filter((_, k) => tiers[k] === 1).map((f) => history.get(f.path)!.at);
        at = stamps.reduce((m, x) => (x < m ? x : m));
      }
      return { c, i, t, at };
    };
    const ranked = cases.map(rank);
    ranked.sort((x, y) => x.t - y.t || (x.at < y.at ? -1 : x.at > y.at ? 1 : 0) || x.i - y.i);
    cases.splice(0, cases.length, ...ranked.map((r) => r.c));
  }
  const owed = new Set(cases.flatMap((c) => c.files.map((f) => f.path)).filter((p) => unchangedPaths.has(p))).size;
  return { cases, excluded, covered, unassigned: a.unassigned, unreadable, skipped, owed };
}

/**
 * The calibration pick: one case from each of up to `n` units spread across
 * the size range (by the unit's planned lines), so the measured rate is not
 * the rate of the smallest or the largest code alone. Deterministic.
 */
export function calibrationCases(plan: readonly ScanCasePlan[], n: number): ScanCasePlan[] {
  const byUnit = new Map<string, ScanCasePlan[]>();
  for (const c of plan) byUnit.set(c.unit, [...(byUnit.get(c.unit) ?? []), c]);
  const units = [...byUnit.entries()]
    .map(([unit, cs]) => ({ unit, lines: cs.reduce((s, c) => s + c.lines, 0), first: cs[0]! }))
    .sort((a, b) => a.lines - b.lines || (a.unit < b.unit ? -1 : 1));
  if (units.length <= n) return units.map((u) => u.first);
  const picked = new Set<number>();
  for (let i = 0; i < n; i++) picked.add(Math.floor(((i + 1) * units.length) / (n + 1)));
  return [...picked].sort((a, b) => a - b).map((i) => units[i]!.first);
}

// ---- the price -----------------------------------------------------------------

/** A measured stage-1 price: dollars per thousand lines read, from finished
 * cases of the SAME lens, tier, effort and validator setting. */
export interface ScanRate {
  usd_per_kline: number;
  /** Priced cases it was measured over, and their lines and cost. */
  cases: number;
  lines: number;
  cost_usd: number;
}

export function caseEstimate(lines: number, rate: ScanRate): number {
  return (Math.max(lines, 1) / 1000) * rate.usd_per_kline;
}

/** What a preview's key covers: change any of it and a start quoting the old
 * key is refused — the operator always saw the price of what runs. */
export function planKey(parts: unknown): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

// ---- the prompts -----------------------------------------------------------------

export interface PromptContext {
  /** Absolute path of the tree at the scan sha. */
  root: string;
  sha: string;
  caseId: string;
}

/** Where a lens opens a tree file: its absolute path under the root. */
export function treePath(root: string, path: string): string {
  return posix.join(root, path);
}

/** The line every scan task carries about paths: the lens runs OUTSIDE the
 * tree (first-party cwd — the case runner), so a relative path it opens is
 * some other checkout's file, never the scanned one (scan-loop). */
export const TREE_PATHS_NOTE =
  "Your working directory is NOT the tree: a relative path opens some other checkout's file. Open every file — focus files, callers, tests — by its absolute path under the tree root (each focus file below says where). Paths in your answer are relative to the tree root.";

/** One focus file as a task names it: its repo-relative path (what an
 * answer anchors to), its size or range, and — given the tree root — the
 * absolute path to open it by. */
export function focusLine(f: ScanCaseFile, root?: string): string {
  const open = root === undefined ? "" : ` — open ${treePath(root, f.path)}`;
  return f.range
    ? `- ${f.path} (lines ${f.range.start}-${f.range.end} of ${f.range.total} — read the whole file, report only inside lines ${f.range.start}-${f.range.end})${open}`
    : `- ${f.path} (${f.lines} lines)${open}`;
}

/** The note a case with a ranged file carries, or none. */
export function rangeNote(files: readonly ScanCaseFile[]): string[] {
  const ranged = files.filter((f) => f.range);
  if (ranged.length === 0) return [];
  return [
    "",
    ...ranged.map(
      (f) =>
        `Focus range: ${f.path} lines ${f.range!.start}-${f.range!.end} of ${f.range!.total}. The file is larger than one case, so it is cut into line ranges and the other ranges are other cases: read the whole file for context, but report only findings anchored inside lines ${f.range!.start}-${f.range!.end} — anything outside it is dropped.`,
    ),
  ];
}

function fileList(c: ScanCasePlan, root: string): string {
  return c.files.map((f) => focusLine(f, root)).join("\n");
}

/** The stage-1 task string for one case. */
export function scanCasePrompt(c: ScanCasePlan, ctx: PromptContext, deepLenses: readonly string[] = SCAN_DEEP_LENSES): string {
  const part = c.parts > 1 ? ` (part ${c.part} of ${c.parts})` : "";
  return [
    `SCAN CASE ${ctx.caseId} — stage 1, unit ${c.unit}${part}.`,
    `Scan sha: ${ctx.sha}`,
    `Tree root (the repository at the scan sha, read-only): ${ctx.root}`,
    TREE_PATHS_NOTE,
    "",
    `Focus files (${c.files.length}, ${c.lines} lines — read each in full):`,
    fileList(c, ctx.root),
    ...rangeNote(c.files),
    "",
    `Deep lenses you may name in SUGGEST: ${deepLenses.join(", ")}.`,
    "",
    `Answer with the findings block headed \`FINDINGS ${SCAN_PASS} SCAN ${ctx.caseId} @${ctx.sha}\` (or NONE), then the SUGGEST block.`,
  ].join("\n");
}

/** The validator's task string over one case's stage-1 candidates. */
export function scanValidatorPrompt(
  c: ScanCasePlan,
  candidates: readonly ScanCandidate[],
  ctx: PromptContext,
  lens: string = SCAN_PASS,
  label = `stage 1, unit ${c.unit}`,
): string {
  const block = candidates
    .map((f) =>
      [
        `- path: ${f.path}`,
        `  line: ${f.start === f.end ? f.end : `${f.start}-${f.end}`}`,
        `  kind: ${f.kind}`,
        // The severity the LENS wrote, not the capped one: the validator audits
        // reachability, and a corrected `routine` must be able to restore it —
        // its survivors are re-read, so the cap applies again on the way out.
        `  severity: ${f.capped_from ?? f.severity}`,
        ...(f.confidence !== null ? [`  confidence: ${f.confidence}`] : []),
        ...(f.reachability !== null ? [`  reachability: ${f.reachability}`] : []),
        `  claim: ${f.claim}`,
        ...(f.evidence ? [`  evidence: ${f.evidence}`] : []),
        // The failure mechanism: the validator judges with it, and a survivor
        // is re-read from the validator's answer, so it must travel both ways.
        ...(f.detail ? [`  detail: ${f.detail}`] : []),
        ...(f.fix ? [`  fix: ${f.fix}`] : []),
      ].join("\n"),
    )
    .join("\n");
  return [
    `SCAN VALIDATION ${ctx.caseId} — ${label}.`,
    `Scan sha: ${ctx.sha}`,
    `Tree root (read-only): ${ctx.root}`,
    TREE_PATHS_NOTE,
    "",
    `The ${lens} lens read these files:`,
    fileList(c, ctx.root),
    "",
    `Its ${candidates.length} candidate finding(s):`,
    `FINDINGS ${lens} SCAN ${ctx.caseId} @${ctx.sha}`,
    block,
    "",
    `Judge every candidate against the files under the tree root, as the scan's skeptic: try to refute each one. Return the survivors as a findings block headed \`FINDINGS ${VALIDATE_PASS} SCAN ${ctx.caseId} @${ctx.sha}\` (keep each survivor's path, line, kind and detail, and add its \`validity:\` — confirmed or likely — and its \`scenario:\`; a confirmed scenario cites a \`path:line\` for every hop it traced, or it is read as likely), then your DOUBTED block for every other candidate. Nothing is killed in a scan: write no KILLED block.`,
  ].join("\n");
}

// ---- reading the answer ----------------------------------------------------------

export const SEVERITIES = ["P0", "P1", "P2", "P3", "nit"] as const;
export type ScanSeverity = (typeof SEVERITIES)[number];

/** A stage-1 candidate as read back, anchored or not yet checked. */
export interface ScanCandidate {
  path: string;
  start: number;
  end: number;
  kind: string;
  /** After the reachability cap (`capped_from` holds what the lens said). */
  severity: ScanSeverity;
  confidence: number | null;
  /** The lens's `reachability:` field, or null when it wrote none (read as
   * `routine`, exactly as a PR round reads it). */
  reachability: Reachability | null;
  /** The severity the lens wrote, when the reachability axis capped it —
   * the posting map's gate (`reachabilityCappedSeverity`): contrived never
   * blocks, plausible P2 is a question. Null when nothing was capped. */
  capped_from: ScanSeverity | null;
  claim: string;
  evidence: string | null;
  fix: string | null;
  detail: string | null;
}

export interface ScanSuggestion {
  lens: string;
  files: string[];
  reason: string;
}

export interface ParsedScanAnswer {
  candidates: ScanCandidate[];
  /** Items with no path, claim or line — never repaired. */
  dropped: number;
  suggestions: ScanSuggestion[];
  /** Suggestions naming no allowed lens or no file, or past the cap. */
  suggestions_dropped: number;
  /** The findings block said NONE. */
  none: boolean;
}

/** At most this many suggestions per case are kept. */
export const MAX_SUGGESTIONS = 5;

const ITEM_FIELD = /^(\s*)(-\s+)?([a-z][a-z0-9_-]{0,40}):(?:\s(.*)|$)/i;

/** Parse the `- key: value` items of one block (continuation lines join the
 * previous field; the first occurrence of a key wins). */
function parseItems(text: string): Array<Map<string, string>> {
  const items: Array<Map<string, string>> = [];
  let cur: Map<string, string> | null = null;
  let last = "";
  let itemIndent = -1;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (/^\s*```/.test(line) || line.trim() === "") continue;
    const indent = /^\s*/.exec(line)![0].length;
    const m = ITEM_FIELD.exec(line);
    if (m && m[2] !== undefined && (itemIndent < 0 || indent <= itemIndent)) {
      cur = new Map();
      items.push(cur);
      itemIndent = indent;
      last = m[3]!.toLowerCase();
      cur.set(last, (m[4] ?? "").trim());
      continue;
    }
    if (!cur || indent <= itemIndent) {
      cur = null;
      continue;
    }
    if (m) {
      last = m[3]!.toLowerCase();
      if (!cur.has(last)) cur.set(last, (m[4] ?? "").trim());
      else last = "";
      continue;
    }
    if (last) cur.set(last, `${cur.get(last) ?? ""} ${line.trim()}`.trim());
  }
  return items;
}

function lineRange(v: string | undefined): { start: number; end: number } | null {
  const m = /^\s*`?L?(\d+)(?:\s*[-–]\s*L?(\d+))?/.exec(v ?? "");
  if (!m) return null;
  const a = Number(m[1]);
  const b = m[2] !== undefined ? Number(m[2]) : a;
  if (!(a > 0) || b < a) return null;
  return { start: a, end: b };
}

function cleanPath(v: string, root: string | null): string {
  let p = v.trim().replace(/^`+|`+$/g, "");
  if (root && p.startsWith(`${root.replace(/\/+$/, "")}/`)) p = p.slice(root.replace(/\/+$/, "").length + 1);
  return p.replace(/^\.?\/+/, "").replace(/:(\d+)(?:-\d+)?$/, "");
}

function severityOf(v: string | undefined): ScanSeverity {
  const s = (v ?? "").trim().replace(/[`*]/g, "");
  const m = /^(p[0-3])\b/i.exec(s);
  if (m) return m[1]!.toUpperCase() as ScanSeverity;
  return /^nit\b/i.test(s) ? "nit" : "P3";
}

function reachabilityOf(v: string | undefined): Reachability | null {
  const r = (v ?? "").trim().replace(/[`*]/g, "").toLowerCase().split(/[\s,;.(—–-]/)[0] ?? "";
  return (REACHABILITY_VALUES as readonly string[]).includes(r) ? (r as Reachability) : null;
}

/** One lowercase word naming the class — the identity half of a kind. */
export function normalizeKind(v: string | undefined): string {
  const k = (v ?? "")
    .toLowerCase()
    .replace(/[`*]/g, "")
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return k === "" ? "unclassified" : k.slice(0, 40);
}

/** The findings of one block of text (the part before SUGGEST / DOUBTED /
 * KILLED). */
function readFindings(text: string, root: string | null): { candidates: ScanCandidate[]; dropped: number } {
  const { read, dropped } = readFindingItems(text, root);
  return { candidates: read.map((r) => r.candidate), dropped };
}

/** `readFindings`, each candidate beside the raw fields it was read from. */
function readFindingItems(
  text: string,
  root: string | null,
): { read: Array<{ candidate: ScanCandidate; fields: Map<string, string> }>; dropped: number } {
  const read: Array<{ candidate: ScanCandidate; fields: Map<string, string> }> = [];
  let dropped = 0;
  for (const f of parseItems(text)) {
    const path = cleanPath(f.get("path") ?? f.get("file") ?? "", root);
    const claim = (f.get("claim") ?? "").trim();
    const range = lineRange(f.get("line")) ?? lineRange(/:(\d+(?:-\d+)?)`?$/.exec(f.get("path") ?? "")?.[1]);
    if (path === "" || claim === "" || range === null) {
      dropped++;
      continue;
    }
    const conf = Number((f.get("confidence") ?? "").trim());
    const opt = (k: string): string | null => {
      const v = f.get(k)?.trim();
      return v ? v : null;
    };
    const said = severityOf(f.get("severity"));
    const reachability = reachabilityOf(f.get("reachability"));
    const severity = reachabilityCappedSeverity(said, reachability);
    const candidate: ScanCandidate = {
      path,
      ...range,
      kind: normalizeKind(f.get("kind")),
      severity,
      confidence: (f.get("confidence") ?? "").trim() !== "" && Number.isFinite(conf) ? conf : null,
      reachability,
      capped_from: severity === said ? null : said,
      claim,
      evidence: opt("evidence"),
      fix: opt("fix"),
      detail: opt("detail"),
    };
    read.push({ candidate, fields: f });
  }
  return { read, dropped };
}

const BLOCK_RE = /^\s*(SUGGEST|DOUBTED|KILLED)\b.*$/m;

/** The text before the first trailing block (SUGGEST / DOUBTED / KILLED). */
function findingsPart(text: string): string {
  const m = BLOCK_RE.exec(text);
  return m ? text.slice(0, m.index) : text;
}

/** The body of one named trailing block, up to the next one. */
function blockBody(text: string, name: string): string | null {
  const re = new RegExp(`^\\s*${name}\\b(.*)$`, "m");
  const m = re.exec(text);
  if (!m) return null;
  const rest = text.slice(m.index + m[0].length);
  const next = BLOCK_RE.exec(rest);
  return `${m[1] ?? ""}\n${next ? rest.slice(0, next.index) : rest}`;
}

/**
 * Read a `pass-scan` answer: its findings (line anchors required — a scan
 * finding without lines is dropped, per the scan-mode anchor rule) and its
 * deep-lens suggestions (lenses from `deepLenses` only, files as given — the
 * caller checks they exist). `root` strips an absolute tree prefix a lens
 * wrote by mistake.
 */
export function parseScanAnswer(
  text: string,
  opts: { root?: string | null; deepLenses?: readonly string[] } = {},
): ParsedScanAnswer {
  const root = opts.root ?? null;
  const lenses = opts.deepLenses ?? SCAN_DEEP_LENSES;
  const head = findingsPart(text);
  const { candidates, dropped } = readFindings(head, root);
  const none = candidates.length === 0 && /^\s*NONE\s*$/m.test(head);
  const suggestions: ScanSuggestion[] = [];
  let suggestionsDropped = 0;
  const body = blockBody(text, "SUGGEST");
  if (body !== null && !/^\s*NONE\b/.test(body)) {
    for (const s of parseItems(body)) {
      const lens = (s.get("lens") ?? "").trim().replace(/[`*]/g, "");
      const files = (s.get("files") ?? s.get("file") ?? "")
        .split(",")
        .map((p) => cleanPath(p, root))
        .filter((p) => p !== "");
      const reason = (s.get("reason") ?? "").trim();
      if (!lenses.includes(lens) || files.length === 0 || reason === "" || suggestions.length >= MAX_SUGGESTIONS) {
        suggestionsDropped++;
        continue;
      }
      suggestions.push({ lens, files: [...new Set(files)], reason });
    }
  }
  return { candidates, dropped, suggestions, suggestions_dropped: suggestionsDropped, none };
}

export interface DoubtLine {
  path: string;
  line: number | null;
  word: string;
  reason: string;
  /** The false-positive class the skeptic named (`[<slug>]` leading the
   * reason — a SCAN_FALSE_POSITIVE_CLASSES slug), or null. */
  class: string | null;
}

/** The slugs a doubt may name as its class — the ONE class list. */
export const SCAN_FALSE_POSITIVE_SLUGS: readonly string[] = SCAN_FALSE_POSITIVE_CLASSES.map((c) => c.slug);

/** A `path:line` reference — a file with an extension, a colon, a line
 * (`src/tui/app.ts:369`, `webhook.ts:88`, `a.py:3-7`); or an extensionless
 * file named with its directory (`scripts/qcr:12`) or by one of the common
 * extensionless build/CI names (`Dockerfile:5`, `Makefile:30`) — a scan
 * reviews any repo, and those files are anchored like any other. */
const PATH_LINE =
  /(?:[A-Za-z0-9_][\w./-]*\.[A-Za-z][A-Za-z0-9]*|[A-Za-z0-9_.][\w.-]*(?:\/[\w.-]+)+|\b(?:Dockerfile|Containerfile|Makefile|GNUmakefile|Jenkinsfile|Procfile|Gemfile|Rakefile|Vagrantfile|Brewfile|Justfile|justfile|Earthfile|Tiltfile))(?:\.[\w-]+)?:\d+/;

/**
 * Whether a skeptic's scenario is ANCHORED: it cites at least one `path:line`
 * of the path it traced. scan-loop (skeptic vs the outside check, self-scan
 * rounds 6–7): every refuted `confirmed` was a prose chain of names and
 * arrows with no `path:line` — the hop it had not read is exactly the one it
 * could not cite. The engine can check that structure; the rest of the
 * tightening lives in SCAN_SKEPTIC_ADDENDUM.
 */
export function scenarioIsAnchored(scenario: string): boolean {
  return PATH_LINE.test(scenario);
}

/** A survivor as the scan's skeptic sorted it (owner ruling 2026-09-30). */
export interface SkepticSurvivor extends ScanCandidate {
  /** `confirmed` only with a written `scenario:` that cites a `path:line`
   * (scenarioIsAnchored) — a demonstration not written down, or not anchored
   * in the code it traced, is not one; anything else that survived is
   * `likely` (the scenario kept, so the reader sees what was traced). */
  validity: "confirmed" | "likely";
  scenario: string | null;
}

/** One `- <lens> <path:line> — <word>: [<class>] <reason>` line per entry of
 * a DOUBTED or KILLED block; a line that does not parse is skipped. */
function judgementLines(body: string | null, root: string | null): DoubtLine[] {
  const out: DoubtLine[] = [];
  if (body === null) return out;
  for (const raw of body.split("\n")) {
    const m = /^\s*-\s+\S+\s+(\S+?)(?::(\d+)(?:-\d+)?)?\s+[—–-]+\s+([a-z-]+):?\s*(.*)$/i.exec(raw);
    if (!m) continue;
    let reason = (m[4] ?? "").trim();
    let cls: string | null = null;
    const c = /^\[\s*`?([a-z-]+)`?\s*\]\s*(.*)$/i.exec(reason);
    if (c && SCAN_FALSE_POSITIVE_SLUGS.includes(c[1]!.toLowerCase())) {
      cls = c[1]!.toLowerCase();
      reason = (c[2] ?? "").trim();
    }
    out.push({
      path: cleanPath(m[1]!, root),
      line: m[2] !== undefined ? Number(m[2]) : null,
      word: m[3]!.toLowerCase(),
      reason,
      class: cls,
    });
  }
  return out;
}

/**
 * Read the validator's answer over a scan case — the scan's SKEPTIC
 * (owner ruling 2026-09-30): the survivors (its findings block — they carry the
 * lens's anchors), each with its tier (`validity: confirmed` with a
 * `scenario:` citing a `path:line`, else `likely`), its DOUBTED lines,
 * `- <lens> <path:line> — <word>: [<class>] <reason>`, and its KILLED lines
 * in the same shape. In a scan nothing is killed: the caller stores a KILLED
 * line as a doubt exactly like a DOUBTED one (the frozen validator's kill
 * paths — below-bar, restated, duplicate, a confidence under 0.5 — become a
 * doubtful mark, never a deletion).
 */
export function parseValidatorAnswer(
  text: string,
  root: string | null,
): { survivors: SkepticSurvivor[]; dropped: number; doubted: DoubtLine[]; killed: DoubtLine[]; answered: boolean } {
  const head = findingsPart(text);
  const { read, dropped } = readFindingItems(head, root);
  const survivors = read.map(({ candidate, fields }): SkepticSurvivor => {
    const said = (fields.get("validity") ?? "").trim().replace(/[`*]/g, "").toLowerCase();
    const scenario = fields.get("scenario")?.trim() || null;
    const confirmed = said.startsWith("confirmed") && scenario !== null && scenarioIsAnchored(scenario);
    return { ...candidate, validity: confirmed ? "confirmed" : "likely", scenario };
  });
  const body = blockBody(text, "DOUBTED");
  const killedBody = blockBody(text, "KILLED");
  const doubted = judgementLines(body, root);
  const killed = judgementLines(killedBody, root);
  // A validator's answer: survivors, a NONE, or a DOUBTED/KILLED block.
  // Prose with none of them (a tool error told in words) judges nothing.
  const answered = survivors.length > 0 || doubted.length > 0 || /^\s*NONE\s*$/m.test(head) || killedBody !== null || body !== null;
  return { survivors, dropped, doubted, killed, answered };
}

// ---- identity ----------------------------------------------------------------------

/** The anchored code, whitespace-normalised: each line's runs of whitespace
 * collapsed, blank lines dropped — so a re-indent or a reflow is the same
 * code, and a changed token is not. */
export function normalizeCode(lines: readonly string[]): string {
  return lines
    .map((l) => l.trim().replace(/\s+/g, " "))
    .filter((l) => l !== "")
    .join("\n");
}

/** Lines `start..end` (1-based, inclusive) of `text`, or null when the range
 * is not inside the file. */
export function anchoredLines(text: string, start: number, end: number): string[] | null {
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  if (start < 1 || end < start || end > lines.length) return null;
  return lines.slice(start - 1, end);
}

/** Whitespace collapsed and trimmed, for the quote check. */
const squash = (t: string): string => t.replace(/\s+/g, " ").trim();

/** A fragment long enough to mean something: four characters or more with a
 * letter or digit in it (never a lone `}` or `)`). */
const quotable = (t: string): boolean => t.length >= 4 && /[A-Za-z0-9]/.test(t);

/**
 * Does a finding's evidence quote its anchored code? True when the evidence
 * contains a whole anchored line (whitespace-normalised), or a quoted
 * fragment of it — a `backticked` or "double-quoted" run that sits inside one
 * of the anchored lines. An anchor with nothing quotable in it (braces, blank
 * lines) cannot be checked and is not held against the finding. A finding
 * whose evidence quotes only code ABOVE or BELOW its anchor — the function
 * signature for a dereference twelve lines down — is exactly the misanchor
 * this catches.
 */
export function evidenceQuotesAnchor(evidence: string | null, anchored: readonly string[]): boolean {
  const lines = anchored.map(squash).filter(quotable);
  if (lines.length === 0) return true;
  if (evidence === null) return false;
  const ev = squash(evidence);
  if (lines.some((l) => ev.includes(l))) return true;
  for (const m of evidence.matchAll(/`([^`]+)`|"([^"]+)"/g)) {
    const frag = squash(m[1] ?? m[2] ?? "");
    if (quotable(frag) && lines.some((l) => l.includes(frag))) return true;
  }
  return false;
}

/**
 * A scan finding's fingerprint: file + lens + kind + a hash of the
 * anchored code, whitespace-normalised. Stable across a re-scan that only
 * moved the code or re-indented it; different when the code itself changed.
 */
export function findingFingerprint(f: { path: string; lens: string; kind: string; code: string }): string {
  const code = createHash("sha256").update(f.code).digest("hex");
  return createHash("sha256").update([f.path, f.lens, f.kind, code].join("\0")).digest("hex");
}

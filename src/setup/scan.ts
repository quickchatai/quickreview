// Scan stage 1's RULES (setup & scan spec "Scan stage 1"), pure:
// what a stage-1 case reads, what it is expected to cost, what the lens is
// told, how its answer is read back, and a scan finding's identity. The
// stateful half — the run, the ledger, the findings store — is scanrun.ts,
// ledger.ts and findings.ts, every effect through a port.
//
// Stage 1 is `pass-scan` over every unit of the SAVED unit cut, one case per
// unit (an oversized unit splits, its name kept), at the `[scan]` tier and
// effort. It never reads tests or migrations (they enter only in stage 2,
// paired with their code), nor what no pass reads (lockfiles, generated
// output, binaries, prose — `isSweepSkipped`), nor the operator's `[scan]
// exclude` globs. A file the coverage ledger already holds at the same
// content hash for `pass-scan` is not read again: that is how an interrupted
// scan resumes, and why a finished one costs nothing to "re-run".
//
// A DELTA re-scan is stage 1 over only the files whose content
// CHANGED since the last scan: read by the ledger at another content, or new
// or different against the tree the last scan read. A file the last scan
// simply never reached (a capped or stopped run) is not a change — that is
// the rest of the scan, and an ordinary preview prices it.
import { createHash } from "node:crypto";
import { ALL_PASSES } from "../dispatch.js";
import { globMatcher } from "../glob.js";
import { isSweepSkipped, isTestFile } from "../heuristics.js";
import { VALIDATE_PASS } from "../include.js";
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
  lines: number;
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
  /** Delta only: readable files the ledger does not cover that are left out
   * because they have not changed since the last scan — the rest of an
   * unfinished scan, which an ordinary preview prices (0 for a full plan). */
  unchanged: number;
}

/** What a delta re-scan compares against. */
export interface DeltaBasis {
  /** Every content hash the ledger holds per path for `pass-scan`. */
  read: ReadonlyMap<string, ReadonlySet<string>>;
  /** The tree the last scan read: path → blob. */
  baseline: ReadonlyMap<string, string>;
}

/** Has `f`'s content changed since the last scan? Read at another content
 * by the ledger, or absent from / different in the last scan's tree. */
export function changedSince(f: TreeFile, basis: DeltaBasis): boolean {
  const read = basis.read.get(f.path);
  if (read !== undefined && !read.has(f.blob)) return true;
  const was = basis.baseline.get(f.path);
  return was === undefined || was !== f.blob;
}

export interface PlanInput {
  cut: UnitCut;
  files: readonly TreeFile[];
  linesOf: (path: string) => number | null;
  /** `path\0blob` of every file the ledger holds for `pass-scan`. */
  covered: ReadonlySet<string>;
  exclude: readonly string[];
  budget: CaseBudget;
  /** A delta re-scan: only files changed since the last scan. */
  delta?: DeltaBasis;
}

export const coverKey = (path: string, blob: string): string => `${path}\0${blob}`;

/** Stage 1 over the saved cut at one tree: every readable, uncovered,
 * non-excluded file (with `delta`, only the changed ones), one case per
 * unit, split to fit. Deterministic. */
export function planStage1(input: PlanInput): Stage1Plan {
  const excludedGlob = globMatcher(input.exclude);
  const excluded: Record<ExclusionReason, number> = { test: 0, migration: 0, "unreadable-kind": 0, "excluded-glob": 0 };
  const blobs = new Map(input.files.map((f) => [f.path, f.blob]));
  const lines = new Map<string, number>();
  let covered = 0;
  let unreadable = 0;
  let unchanged = 0;
  const readable: string[] = [];
  for (const f of [...input.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const why = stage1Exclusion(f.path, excludedGlob);
    if (why !== null) {
      excluded[why]++;
      continue;
    }
    const n = input.linesOf(f.path);
    if (n === null) {
      unreadable++;
      continue;
    }
    if (input.covered.has(coverKey(f.path, f.blob))) {
      covered++;
      continue;
    }
    if (input.delta !== undefined && !changedSince(f, input.delta)) {
      unchanged++;
      continue;
    }
    lines.set(f.path, n);
    readable.push(f.path);
  }
  const a = assign(input.cut, readable);
  const cases: ScanCasePlan[] = [];
  for (const u of input.cut.units) {
    const owned = a.byUnit.get(u.name) ?? [];
    if (owned.length === 0) continue;
    for (const c of splitUnit(u.name, owned, (p) => lines.get(p) ?? 0, input.budget)) {
      cases.push({
        unit: c.unit,
        id: c.id,
        part: c.part,
        parts: c.parts,
        files: c.files.map((p) => ({ path: p, blob: blobs.get(p)!, lines: lines.get(p) ?? 0 })),
        lines: c.lines,
      });
    }
  }
  return { cases, excluded, covered, unassigned: a.unassigned, unreadable, unchanged };
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

function fileList(c: ScanCasePlan): string {
  return c.files.map((f) => `- ${f.path} (${f.lines} lines)`).join("\n");
}

/** The stage-1 task string for one case. */
export function scanCasePrompt(c: ScanCasePlan, ctx: PromptContext, deepLenses: readonly string[] = SCAN_DEEP_LENSES): string {
  const part = c.parts > 1 ? ` (part ${c.part} of ${c.parts})` : "";
  return [
    `SCAN CASE ${ctx.caseId} — stage 1, unit ${c.unit}${part}.`,
    `Scan sha: ${ctx.sha}`,
    `Tree root (the repository at the scan sha, read-only): ${ctx.root}`,
    "Every path below and in your answer is relative to the tree root.",
    "",
    `Focus files (${c.files.length}, ${c.lines} lines — read each in full):`,
    fileList(c),
    "",
    `Deep lenses you may name in SUGGEST: ${deepLenses.join(", ")}.`,
    "",
    `Answer with the findings block headed \`FINDINGS ${SCAN_PASS} SCAN ${ctx.caseId} @${ctx.sha}\` (or NONE), then the SUGGEST block.`,
  ].join("\n");
}

/** The validator's task string over one case's stage-1 candidates. */
export function scanValidatorPrompt(c: ScanCasePlan, candidates: readonly ScanCandidate[], ctx: PromptContext): string {
  const block = candidates
    .map((f) =>
      [
        `- path: ${f.path}`,
        `  line: ${f.start === f.end ? f.end : `${f.start}-${f.end}`}`,
        `  kind: ${f.kind}`,
        `  severity: ${f.severity}`,
        ...(f.confidence !== null ? [`  confidence: ${f.confidence}`] : []),
        `  claim: ${f.claim}`,
        ...(f.evidence ? [`  evidence: ${f.evidence}`] : []),
        ...(f.fix ? [`  fix: ${f.fix}`] : []),
      ].join("\n"),
    )
    .join("\n");
  return [
    `SCAN VALIDATION ${ctx.caseId} — stage 1, unit ${c.unit}.`,
    `Scan sha: ${ctx.sha}`,
    `Tree root (read-only): ${ctx.root}`,
    "",
    `The ${SCAN_PASS} lens read these files:`,
    fileList(c),
    "",
    `Its ${candidates.length} candidate finding(s):`,
    `FINDINGS ${SCAN_PASS} SCAN ${ctx.caseId} @${ctx.sha}`,
    block,
    "",
    `Validate every candidate against the files under the tree root. Return the survivors as a findings block headed \`FINDINGS ${VALIDATE_PASS} SCAN ${ctx.caseId} @${ctx.sha}\` (keep each survivor's path, line and kind), then your DOUBTED and KILLED blocks.`,
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
  severity: ScanSeverity;
  confidence: number | null;
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
  const candidates: ScanCandidate[] = [];
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
    candidates.push({
      path,
      ...range,
      kind: normalizeKind(f.get("kind")),
      severity: severityOf(f.get("severity")),
      confidence: (f.get("confidence") ?? "").trim() !== "" && Number.isFinite(conf) ? conf : null,
      claim,
      evidence: opt("evidence"),
      fix: opt("fix"),
      detail: opt("detail"),
    });
  }
  return { candidates, dropped };
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
}

/**
 * Read the validator's answer over a scan case: the survivors (its findings
 * block — they carry the lens's anchors) and its DOUBTED lines,
 * `- <lens> <path:line> — <word>: <reason>`. KILLED is not read: a kill that
 * is not a doubt (a duplicate, below the bar) is the validator's to make.
 */
export function parseValidatorAnswer(
  text: string,
  root: string | null,
): { survivors: ScanCandidate[]; dropped: number; doubted: DoubtLine[] } {
  const { candidates, dropped } = readFindings(findingsPart(text), root);
  const doubted: DoubtLine[] = [];
  const body = blockBody(text, "DOUBTED");
  if (body !== null) {
    for (const raw of body.split("\n")) {
      const m = /^\s*-\s+\S+\s+(\S+?)(?::(\d+)(?:-\d+)?)?\s+[—–-]+\s+([a-z-]+):?\s*(.*)$/i.exec(raw);
      if (!m) continue;
      doubted.push({
        path: cleanPath(m[1]!, root),
        line: m[2] !== undefined ? Number(m[2]) : null,
        word: m[3]!.toLowerCase(),
        reason: (m[4] ?? "").trim(),
      });
    }
  }
  return { survivors: candidates, dropped, doubted };
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

/**
 * A scan finding's fingerprint: file + lens + kind + a hash of the
 * anchored code, whitespace-normalised. Stable across a re-scan that only
 * moved the code or re-indented it; different when the code itself changed.
 */
export function findingFingerprint(f: { path: string; lens: string; kind: string; code: string }): string {
  const code = createHash("sha256").update(f.code).digest("hex");
  return createHash("sha256").update([f.path, f.lens, f.kind, code].join("\0")).digest("hex");
}

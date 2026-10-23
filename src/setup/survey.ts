// The survey's deterministic half (setup & scan spec "Survey"):
// what the survey reads, what it costs, what its lens must answer, and how an
// answer becomes memory. Pure — no port, no clock, no disk — so the survey run
// (surveyrun.ts) owns every effect and these rules are testable
// on their own.
//
// The survey reads a repo in two stages, and the order is the point:
//   1. the REPO-WIDE read: every agent-directive file and design doc, in
//      full, first — what the team already told agents and humans is the
//      starting point (one case, split to fit, under the reserved scope
//      `@repo`, which no unit name can spell);
//   2. one case per UNIT over a small SAMPLE of its code — entry points,
//      models and schemas, the most-changed files, the largest — carrying
//      stage 1's notes, so a unit is read in the light of what the repo says
//      about itself rather than rediscovering it.
// A survey hunts no bugs; the lens (`pass-survey`, the companion's agent
// set) writes convention and architecture notes, nothing else. Each note
// becomes one UNPINNED `#survey` memory entry, and a re-survey supersedes the
// entries of the run before it.
import { createHash } from "node:crypto";
import {
  CODE_FILE_RE,
  isSweepSkipped,
  isTestFile,
} from "@quickchatai/pi-quickreview/src/heuristics.js";
import { dehash, formatEventTags, parseEventTags, parseHashTags } from "../memory/eventtags.js";
import { normalizeTag, type MemoryEntry } from "../memory/store.js";
import { isMigrationFile, isVendored } from "./facts.js";
import { assign, splitUnit, type CaseBudget, type UnitCut } from "./unitcut.js";

/** The lens. Named `pass-*` like every lens, and deliberately NOT `survey`:
 * the companion already has a skill by that name (candidate triage), and a
 * subagent sharing it would make "run the survey" ambiguous. */
export const SURVEY_AGENT = "pass-survey";

/** The memory tag every survey note carries (`#survey`). */
export const SURVEY_TAG = "survey";

/** Stage 1's scope. Not a legal unit name (UNIT_NAME_RE starts alphanumeric),
 * so it can never collide with a unit in reports or memory tags. */
export const REPO_SCOPE = "@repo";

/** How much of one unit the sample may read: at most `perCategory` files per
 * reason, `maxFiles` in all, and no more than `maxLines` lines unless no
 * candidate fits the cap at all (then its first one is read whole). A survey is meant to cost a fraction of
 * a scan — this cap is what makes it so. */
export interface SampleLimits {
  perCategory: number;
  maxFiles: number;
  maxLines: number;
}

export const DEFAULT_SAMPLE_LIMITS: SampleLimits = { perCategory: 2, maxFiles: 8, maxLines: 2000 };

/** What one lens answer may put into memory. A longer answer is cut, and the
 * cut is counted, never silent. */
export const MAX_NOTES_PER_CASE = 12;
export const MAX_NOTE_CHARS = 600;

export const NOTE_KINDS = ["convention", "architecture"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

// ---- the plan ------------------------------------------------------------------

export interface PlannedFile {
  path: string;
  lines: number;
  /** Why it is read: `agent-directive file`, `design doc`, or the sample
   * reason (`entry point`, `model / schema`, `most-changed (N commits)`,
   * `largest (N lines)`). */
  reason: string;
}

export interface SurveyCasePlan {
  /** `@repo`, `@repo#2`, or the unit's name — a unit's sample is one case. */
  id: string;
  /** The unit's name, or `@repo` for stage 1. */
  unit: string;
  stage: "repo" | "unit";
  /** The unit's kind and roots, for the prompt ("repo" / [""] for stage 1). */
  kind: string;
  roots: string[];
  files: PlannedFile[];
  lines: number;
}

export interface SurveyPlan {
  cases: SurveyCasePlan[];
  /** Units with nothing to sample (no code files outside tests and
   * migrations) — reported, never silently dropped. */
  unsampled: string[];
  /** Files the saved cut gives to no unit (the repo grew past it): no unit
   * case samples them — reported, never silently dropped. */
  unassigned: string[];
  lines: number;
}

export interface PlanInput {
  cut: UnitCut;
  /** The repo's listing. */
  files: readonly string[];
  /** From the repo facts. */
  agentFiles: readonly string[];
  guides: readonly string[];
  linesOf: (path: string) => number;
  /** Commits touching each file over the recent history, or null when the
   * history cannot be read (then "most-changed" simply picks nothing). */
  changes: Readonly<Record<string, number>> | null;
  budget: CaseBudget;
  sample?: SampleLimits;
}

/** Code a sample may read: first-party source, not tests, migrations,
 * generated or vendored output, prose or config. */
export function isSampleable(path: string): boolean {
  return (
    CODE_FILE_RE.test(path) &&
    !isVendored(path) &&
    !isSweepSkipped(path) &&
    !isTestFile(path) &&
    !isMigrationFile(path)
  );
}

const ENTRY_RE =
  /(^|\/)(__main__\.py|manage\.py|wsgi\.py|asgi\.py|urls\.py|lib\.rs|(main|index|app|server|cli|routes?|router|api)\.[a-z]+)$/i;
const MODEL_RE = /(^|\/)(models?|schemas?|entities|entity|types|serializers?|dtos?)(\/|\.[a-z]+$)/i;

const depth = (p: string): number => p.split("/").length;
const shallowFirst = (a: string, b: string): number =>
  depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0);

/**
 * One unit's sample, deterministic: entry points and models/schemas
 * (shallowest first), then the most-changed and the largest files, each
 * reason at most `perCategory` files, no file twice, inside the line cap —
 * except that a unit whose every candidate is over the cap still gets its
 * first one, whole, rather than no sample at all.
 */
export function pickSample(
  files: readonly string[],
  linesOf: (path: string) => number,
  changes: Readonly<Record<string, number>> | null,
  limits: SampleLimits = DEFAULT_SAMPLE_LIMITS,
): PlannedFile[] {
  const pool = files.filter(isSampleable);
  const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const categories: Array<{ reason: (p: string) => string; order: string[] }> = [
    { reason: () => "entry point", order: pool.filter((p) => ENTRY_RE.test(p)).sort(shallowFirst) },
    {
      reason: () => "model / schema",
      order: pool.filter((p) => MODEL_RE.test(p)).sort(shallowFirst),
    },
    {
      reason: (p) => `most-changed (${changes?.[p] ?? 0} commits)`,
      order:
        changes === null
          ? []
          : pool
              .filter((p) => (changes[p] ?? 0) > 0)
              .sort((a, b) => (changes[b] ?? 0) - (changes[a] ?? 0) || byPath(a, b)),
    },
    {
      reason: (p) => `largest (${linesOf(p)} lines)`,
      order: [...pool].sort((a, b) => linesOf(b) - linesOf(a) || byPath(a, b)),
    },
  ];
  // The over-the-cap exception belongs to a unit with nothing that fits —
  // never to whichever oversized file happens to lead its category.
  const anyFits = pool.some((p) => Math.max(0, linesOf(p)) <= limits.maxLines);
  const chosen: PlannedFile[] = [];
  let lines = 0;
  for (const cat of categories) {
    let taken = 0;
    for (const p of cat.order) {
      if (taken >= limits.perCategory || chosen.length >= limits.maxFiles) break;
      if (chosen.some((c) => c.path === p)) continue;
      const n = Math.max(0, linesOf(p));
      if (lines + n > limits.maxLines && (anyFits || chosen.length > 0)) continue;
      chosen.push({ path: p, lines: n, reason: cat.reason(p) });
      lines += n;
      taken++;
    }
  }
  return chosen;
}

/** The whole survey plan over a saved cut. */
export function planSurvey(input: PlanInput): SurveyPlan {
  const a = assign(input.cut, input.files);
  // Only files the repo lists, that no one ignored, and that are its own.
  const readable = new Set(input.files.filter((f) => !isVendored(f)));
  for (const f of a.ignored) readable.delete(f);
  const reasonOf = new Map<string, string>();
  for (const f of input.agentFiles) if (readable.has(f)) reasonOf.set(f, "agent-directive file");
  for (const f of input.guides)
    if (readable.has(f) && !reasonOf.has(f)) reasonOf.set(f, "design doc");

  const cases: SurveyCasePlan[] = [];
  // Stage 1: read in full, so split to fit — every part under `@repo`. A
  // repo with no directive file and no design doc has no stage 1 at all.
  const repoParts =
    reasonOf.size === 0
      ? []
      : splitUnit(REPO_SCOPE, [...reasonOf.keys()], input.linesOf, input.budget);
  for (const part of repoParts) {
    const files = part.files
      .map((p) => ({ path: p, lines: Math.max(0, input.linesOf(p)), reason: reasonOf.get(p)! }))
      // Directive files before design docs, as the survey reads them.
      .sort((x, y) =>
        x.reason === y.reason
          ? x.path < y.path
            ? -1
            : 1
          : x.reason === "agent-directive file"
            ? -1
            : 1,
      );
    cases.push({
      id: part.id,
      unit: REPO_SCOPE,
      stage: "repo",
      kind: "repo",
      roots: [""],
      files,
      lines: part.lines,
    });
  }

  const unsampled: string[] = [];
  for (const u of input.cut.units) {
    const sample = pickSample(
      a.byUnit.get(u.name) ?? [],
      input.linesOf,
      input.changes,
      input.sample,
    );
    if (sample.length === 0) {
      unsampled.push(u.name);
      continue;
    }
    cases.push({
      id: u.name,
      unit: u.name,
      stage: "unit",
      kind: u.kind,
      roots: u.roots,
      files: sample,
      lines: sample.reduce((n, f) => n + f.lines, 0),
    });
  }
  return {
    cases,
    unsampled,
    unassigned: a.unassigned,
    lines: cases.reduce((n, c) => n + c.lines, 0),
  };
}

/** A short key naming exactly this plan at this head at this rate: the
 * preview hands it out and a start must quote it back, so nothing starts on a
 * plan (or a price, or a coverage gap) the operator was not shown — a run
 * that settles with a measured rate invalidates every key priced before it. */
export function planKey(plan: SurveyPlan, head: string | null, rate: SurveyRate): string {
  const shape = plan.cases.map((c) => [c.id, c.files.map((f) => [f.path, f.lines])]);
  const price = [rate.usd_per_case, rate.usd_per_kline];
  return createHash("sha256")
    .update(JSON.stringify([head, shape, plan.unsampled, plan.unassigned, price]))
    .digest("hex")
    .slice(0, 12);
}

// ---- the price ------------------------------------------------------------------

export interface SurveyRate {
  usd_per_case: number;
  usd_per_kline: number;
  /** What the rate stands on — rendered beside every estimate. */
  basis: string;
}

/** Before any survey has run here: a rough reference from the sandbox
 * research (a sweep-sized pass at `low` measured ~$0.05), per case plus per
 * thousand lines read. The first measured run replaces it. */
export const REFERENCE_RATE: SurveyRate = {
  usd_per_case: 0.02,
  usd_per_kline: 0.06,
  basis:
    "reference rate (no survey measured on this install yet — the first run's cost replaces it)",
};

/** A rate measured from finished cases, or null when they carry no cost. */
export function measuredRate(
  cases: ReadonlyArray<{ lines: number; cost_usd: number | null }>,
): SurveyRate | null {
  const priced = cases.filter((c) => c.cost_usd !== null && c.cost_usd > 0);
  const cost = priced.reduce((n, c) => n + c.cost_usd!, 0);
  const lines = priced.reduce((n, c) => n + c.lines, 0);
  if (priced.length === 0 || lines === 0) return null;
  return {
    usd_per_case: 0,
    usd_per_kline: cost / (lines / 1000),
    basis: `measured on this install's last survey (${priced.length} cases, $${cost.toFixed(2)} over ${lines} lines)`,
  };
}

export function caseEstimate(lines: number, rate: SurveyRate): number {
  return rate.usd_per_case + (lines / 1000) * rate.usd_per_kline;
}

export function planEstimate(plan: SurveyPlan, rate: SurveyRate): number {
  return plan.cases.reduce((n, c) => n + caseEstimate(c.lines, rate), 0);
}

// ---- the prompt -----------------------------------------------------------------

export interface PromptContext {
  /** Where the checkout is mounted — the lens reads absolute paths. */
  repoRoot: string;
  head: string | null;
  /** Stage 1's notes, for a unit case. Empty when stage 1 wrote none; null
   * when it did not finish (the prompt says so rather than implying "none"). */
  repoNotes: string[] | null;
  /** Stage 1 finished but read only part of what it was given (a file not
   * opened, a note memory refused): its notes stand, and the prompt says the
   * read was partial. */
  repoPartial?: boolean;
}

export function surveyPrompt(c: SurveyCasePlan, ctx: PromptContext): string {
  const abs = (p: string): string => `${ctx.repoRoot.replace(/\/+$/, "")}/${p}`;
  const at = ctx.head ? ` at ${ctx.head.slice(0, 12)}` : "";
  const list = c.files.map((f) => `- ${abs(f.path)} — ${f.reason}, ${f.lines} lines`).join("\n");
  if (c.stage === "repo") {
    return [
      `SURVEY — stage 1, the repo-wide read (${c.id}) of the repository at ${ctx.repoRoot}${at}.`,
      "Read EVERY file below IN FULL, in this order — agent-directive files first, then design docs:",
      list,
      "Write the conventions and architecture these files state, in the output grammar of your instructions.",
    ].join("\n\n");
  }
  const roots = c.roots.map((r) => (r === "" ? "(the repo root)" : r)).join(", ");
  const partial = ctx.repoPartial === true;
  const notes =
    ctx.repoNotes === null
      ? "The repo-wide read did not finish; read the sample on its own terms."
      : ctx.repoNotes.length === 0
        ? partial
          ? "The repo-wide read was only partial and wrote no notes; read the sample on its own terms."
          : "The repo-wide read wrote no notes."
        : `${
            partial
              ? "The repo-wide read was only partial (not every file was opened, or not every note was kept); what it did establish (do NOT restate these):"
              : "What the repo-wide read already established (do NOT restate these):"
          }\n${ctx.repoNotes.map((n) => `- ${n}`).join("\n")}`;
  return [
    `SURVEY — stage 2, unit \`${c.unit}\` (${c.kind}; owns ${roots}) of the repository at ${ctx.repoRoot}${at}.`,
    notes,
    `Read this sample (why each is in it is beside it):\n${list}`,
    "You may list or grep the unit's directories to confirm a convention holds beyond the sample; do not read the unit wholesale. " +
      "Write the conventions and architecture of THIS unit, in the output grammar of your instructions.",
  ].join("\n\n");
}

// ---- the answer -----------------------------------------------------------------

export interface SurveyNote {
  kind: NoteKind;
  text: string;
}

export interface ParsedNotes {
  notes: SurveyNote[];
  /** The lens answered `NONE` — a read with nothing worth keeping. */
  none: boolean;
  /** Notes past MAX_NOTES_PER_CASE. */
  dropped: number;
  /** Notes cut at MAX_NOTE_CHARS. */
  truncated: number;
}

const NOTE_START_RE = new RegExp(`^\\s*(?:[-*]\\s*)?\\[(${NOTE_KINDS.join("|")})\\]\\s*(.*)$`, "i");

/**
 * The lens's answer, by its grammar: each note opens with `[convention]` or
 * `[architecture]` at the start of a line and runs to the next note or a
 * blank line; anything else is ignored. Whitespace is collapsed — an entry is
 * one paragraph — and a note is cut at MAX_NOTE_CHARS.
 */
export function parseSurveyNotes(output: string): ParsedNotes {
  const raw: SurveyNote[] = [];
  let open: SurveyNote | null = null;
  for (const line of output.split("\n")) {
    const m = NOTE_START_RE.exec(line);
    if (m) {
      open = { kind: m[1]!.toLowerCase() as NoteKind, text: m[2]! };
      raw.push(open);
    } else if (line.trim() === "") {
      open = null;
    } else if (open) {
      open.text += ` ${line}`;
    }
  }
  let truncated = 0;
  const notes = raw
    .map((n) => {
      let text = n.text.replace(/\s+/g, " ").trim();
      if (text.length > MAX_NOTE_CHARS) {
        text = `${text.slice(0, MAX_NOTE_CHARS - 1).trimEnd()}…`;
        truncated++;
      }
      return { kind: n.kind, text };
    })
    .filter((n) => n.text !== "");
  return {
    notes: notes.slice(0, MAX_NOTES_PER_CASE),
    none: notes.length === 0 && /^\s*NONE\s*$/m.test(output),
    dropped: Math.max(0, notes.length - MAX_NOTES_PER_CASE),
    truncated,
  };
}

// ---- memory ---------------------------------------------------------------------

/**
 * One note as a memory entry: `#survey kind=… unit=… run=… sha=… — text`.
 * The header is written HERE, from values the engine owns; the lens's text
 * only ever follows the em dash, which ends the header scan, so a note can
 * neither pin itself nor forge a run or a unit (eventtags.ts reads the
 * header only), and its own `#word`s are de-hashed. Never `#pinned`: survey memory is ordinary memory the EOD
 * curator may merge.
 */
export function surveyMemoryText(
  note: SurveyNote,
  unit: string,
  run: string,
  head: string | null,
): string {
  const tags: Record<string, string> = { kind: note.kind, unit, run };
  if (head) tags.sha = head.slice(0, 12);
  return `#${SURVEY_TAG} ${formatEventTags(tags)} — ${dehash(note.text)}`;
}

/** A live (not retired) survey entry's header, or null for any other entry. */
export function surveyEntryTags(
  e: MemoryEntry,
): { unit: string | null; run: string | null } | null {
  const hash = parseHashTags(e.text);
  if (
    !hash.includes(SURVEY_TAG) ||
    hash.includes("retired") ||
    e.tags.some((t) => normalizeTag(t) === "retired")
  ) {
    return null;
  }
  const kv = parseEventTags(e.text);
  return { unit: kv.unit ?? null, run: kv.run ?? null };
}

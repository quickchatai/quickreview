// Lesson SELECTION (S9a): which curated lessons and which past
// finding cases a round WOULD carry — pure, deterministic, no I/O.
//
// The round's prefetch (src/lessonselect.ts) asks OpenViking ONE `/search/find`
// per plan row inside `memories/experiences/`, and one for the main session
// inside `memories/finding-cases/`, under a hard budget. What comes back is a
// ranked list of hits by the ENGINE's score — semantic similarity, which knows
// nothing of lenses, paths or retirements. This module turns those hits into a
// selection with rules a person can read:
//
//   FILTER (on the typed header — src/memory/lessons.ts `parseLesson`, the
//   header only, so quoted prose in a body can never make a lesson eligible):
//     * the hit is a file inside the area that was searched (never a folder
//       blurb, never another area's entry the server let through);
//     * never `#retired`, never a move's `#moved` stub, never a URI on the
//       store's retired list, never a URI the operator SUPPRESSED (the kill
//       switch, `commands/operator/` → state.db — src/lessonledger.ts);
//     * a lesson (a typed header, or one of the legacy shapes the tolerant
//       reader knows) whose polarity is known — a lesson nobody can tell is
//       a "look for" or a "don't raise" is delivered to nobody;
//     * the row's lens is in its `lens=` (a lesson naming no lens — the
//       legacy conventions — is for every lens);
//     * one of its `paths=` globs matches one of the row's files, when it
//       names any;
//     * created strictly before `as_of`, when a replay sets one (a temporal
//       hold-out: a lesson the replayed PR's own outcome produced must not
//       grade that PR). A lesson whose creation date cannot be read is not
//       provably older, so it is out.
//   RANK (deterministic — the engine's score only decided which hits came
//   back, never their order here): pinned > a `paths=` glob hit > a `lens=`
//   hit > evidence count > recency > URI.
//   CAP per role (`SELECTION_CAPS`): items and an estimated token budget,
//   greedy in rank order; EVERY lesson cut is listed with why.
//
// A CASE (src/cases.ts) is filtered on its own header: `#case kind=case`, not
// withdrawn, about a file this PR changes, from ANOTHER PR (the session has
// this PR's own history in its ledger), posted before `as_of`. Ranked by a
// shared lens > the replies it drew > recency > URI.
//
// Nothing here is delivered anywhere (S9a ships `[memory] delivery` in
// shadow): the selection is what the shadow ledger records, and what S9b's
// delivery will render.
import { globMatcher } from "../glob.js";
import { canonicalLensIds } from "../lensids.js";
import { roundContextQuery } from "./context.js";
import { parseEventTags, parseHashTags } from "./eventtags.js";
import { CASES_AREA, EXPERIENCES_AREA, PINNED_AREA } from "./layout.js";
import { parseLesson, type LessonKind, type ParsedLesson } from "./lessons.js";

/** The validator's lens id — it has no task file and judges every finding. */
export const VALIDATOR_LENS = "pass-validate";

/** What each role may carry: items and an ESTIMATED token budget. */
export const SELECTION_CAPS = Object.freeze({
  /** One lens row's task file. */
  row: Object.freeze({ items: 6, tokens: 1200 }),
  /** The main session's "past reviews of these files". */
  cases: Object.freeze({ items: 8, tokens: 2000 }),
  /** The validator's lesson addendum. */
  validator: Object.freeze({ items: 20, tokens: 2500 }),
});

export type SelectionCap = { readonly items: number; readonly tokens: number };

/** How many hits one find asks for, per area. Generous: the filters run on
 * our side, after the engine ranked by similarity alone. */
export const FIND_LIMITS = Object.freeze({ lessons: 20, cases: 40 });

/** At most this many distinct finds per round (identical queries are asked
 * once). A wide sweep plan past it leaves its last rows unasked — recorded
 * as `find_cap`, never silently. */
export const MAX_FINDS_PER_ROUND = 24;

/** Characters per token for the caps' estimate — the usual English ratio. */
export const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.trim().length / CHARS_PER_TOKEN));
}

/** One hit of a `/search/find`, as the engine adapter hands it over. */
export interface FindHit {
  uri: string;
  score: number;
  /** The entry text the engine returned (the abstract — the stored content
   * itself in a deployment without a VLM, §3.3). The header is its
   * first line. */
  text: string;
}

/** What one find produced, after the prefetch's budget. */
export type FindOutcome =
  | { status: "ok"; hits: readonly FindHit[] }
  | { status: "unreadable"; reason: string }
  | { status: "timeout" };

/** `20260824T153000-…` / `20260824-eod-…` → `2026-08-24[T15:30:00]`; null when
 * the file name carries no date. */
export function createdOfUri(uri: string): string | null {
  const name = uri.slice(uri.lastIndexOf("/") + 1);
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?/.exec(name);
  if (!m) return null;
  const day = `${m[1]}-${m[2]}-${m[3]}`;
  return m[4] !== undefined ? `${day}T${m[4]}:${m[5]}:${m[6]}` : day;
}

/** Is `uri` a FILE directly addressable under `<root>/<area>/` (never a
 * folder, never the engine's `.abstract.md`/`.overview.md` blurbs)? */
export function inArea(uri: string, root: string, area: string): boolean {
  const prefix = `${root.replace(/\/+$/, "")}/${area}/`;
  if (!uri.startsWith(prefix)) return false;
  const rest = uri.slice(prefix.length);
  const base = rest.slice(rest.lastIndexOf("/") + 1);
  // `experiences/` holds files directly; a deeper path is another area
  // (`preferences/pinned/` under `preferences/`) or something we never write.
  if (rest.includes("/")) return false;
  return base.endsWith(".md") && !base.startsWith(".");
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Sort by URI and keep one hit per URI (the highest score), so the order the
 * engine returned them in can never change what is selected. */
function dedupeHits(hits: readonly FindHit[]): { hits: FindHit[]; duplicates: number } {
  const best = new Map<string, FindHit>();
  let duplicates = 0;
  for (const h of hits) {
    if (typeof h?.uri !== "string" || h.uri === "") continue;
    const prev = best.get(h.uri);
    if (prev) {
      duplicates += 1;
      if ((h.score ?? 0) > (prev.score ?? 0)) best.set(h.uri, h);
    } else best.set(h.uri, h);
  }
  return { hits: [...best.values()].sort((a, b) => cmp(a.uri, b.uri)), duplicates };
}

// ---- lessons ----------------------------------------------------------------

export type LessonDropReason =
  | "out_of_area"
  | "duplicate"
  | "moved"
  | "retired"
  | "suppressed"
  | "not_lesson"
  | "kind_unknown"
  | "lens"
  | "paths"
  | "as_of";

export interface LessonCandidate {
  uri: string;
  text: string;
  score: number;
  created: string | null;
  lesson: ParsedLesson & { kind: LessonKind };
  tokens: number;
  pinned: boolean;
  /** One of its `paths=` globs matched one of the files it was judged for. */
  pathHit: boolean;
}

export interface LessonFilterContext {
  /** The memories root URI (`viking://user/reviewer/memories`). */
  root: string;
  /** The lens the lessons are for. */
  lens: string;
  /** The files that lens reviews (the row's focus, else the PR's files). */
  files: readonly string[];
  retired: ReadonlySet<string>;
  suppressed: ReadonlySet<string>;
  /** `YYYY-MM-DD`: only lessons created strictly before it. */
  asOf?: string | null;
}

export type DropCounts = Partial<Record<string, number>>;

function bump(d: DropCounts, reason: string, n = 1): void {
  d[reason] = (d[reason] ?? 0) + n;
}

/** Retired or moved, by the store's list or by the entry's own header. */
function retiredState(uri: string, text: string, retired: ReadonlySet<string>): "moved" | "retired" | null {
  const hash = parseHashTags(text.trim());
  if (hash.includes("moved")) return "moved";
  if (hash.includes("retired") || retired.has(uri)) return "retired";
  return null;
}

function beforeAsOf(created: string | null, asOf: string | null | undefined): boolean {
  if (!asOf) return true;
  if (created === null) return false;
  return created.slice(0, 10) < asOf.slice(0, 10);
}

/**
 * The hits that may be selected for one lens, and how many were dropped for
 * each reason. Pure; the order of `hits` does not matter.
 */
export function filterLessonHits(
  hits: readonly FindHit[],
  ctx: LessonFilterContext,
): { eligible: LessonCandidate[]; dropped: DropCounts } {
  const dropped: DropCounts = {};
  const { hits: unique, duplicates } = dedupeHits(hits);
  if (duplicates > 0) bump(dropped, "duplicate", duplicates);
  const eligible: LessonCandidate[] = [];
  for (const h of unique) {
    const text = typeof h.text === "string" ? h.text : "";
    if (!inArea(h.uri, ctx.root, EXPERIENCES_AREA)) {
      bump(dropped, "out_of_area");
      continue;
    }
    const gone = retiredState(h.uri, text, ctx.retired);
    if (gone) {
      bump(dropped, gone);
      continue;
    }
    if (ctx.suppressed.has(h.uri)) {
      bump(dropped, "suppressed");
      continue;
    }
    const lesson = parseLesson(text);
    if (!lesson) {
      bump(dropped, "not_lesson");
      continue;
    }
    if (lesson.kind === null) {
      bump(dropped, "kind_unknown");
      continue;
    }
    if (lesson.lens.length > 0 && !lesson.lens.includes(ctx.lens)) {
      bump(dropped, "lens");
      continue;
    }
    const pathHit = lesson.paths.length > 0 && ctx.files.some(globMatcherSafe(lesson.paths));
    if (lesson.paths.length > 0 && !pathHit) {
      bump(dropped, "paths");
      continue;
    }
    const created = createdOfUri(h.uri);
    if (!beforeAsOf(created, ctx.asOf)) {
      bump(dropped, "as_of");
      continue;
    }
    eligible.push({
      uri: h.uri,
      text: text.trim(),
      score: typeof h.score === "number" && Number.isFinite(h.score) ? h.score : 0,
      created,
      lesson: lesson as ParsedLesson & { kind: LessonKind },
      tokens: estimateTokens(text),
      pinned: h.uri.includes(`/memories/${PINNED_AREA}/`),
      pathHit,
    });
  }
  return { eligible, dropped };
}

/** A glob list as a predicate; a list the glob compiler refuses matches
 * nothing (never everything). */
function globMatcherSafe(globs: readonly string[]): (path: string) => boolean {
  try {
    return globMatcher(globs);
  } catch {
    return () => false;
  }
}

/** Ranking keys, most significant first; every key is "higher first" except
 * the URI, the final tie-break. */
function lessonKey(c: LessonCandidate, lens: string): Array<number | string> {
  return [
    c.pinned ? 1 : 0,
    c.pathHit ? 1 : 0,
    c.lesson.lens.includes(lens) ? 1 : 0,
    c.lesson.evidence.length,
    c.created ?? "",
  ];
}

function compareKeys(a: Array<number | string>, b: Array<number | string>): number {
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x === y) continue;
    return x > y ? -1 : 1;
  }
  return 0;
}

/** Deterministic order: pinned > path-glob hit > lens hit > evidence count >
 * recency > URI. The engine's score is not a key. */
export function rankLessons(cands: readonly LessonCandidate[], lens: string): LessonCandidate[] {
  return [...cands].sort(
    (a, b) => compareKeys(lessonKey(a, lens), lessonKey(b, lens)) || cmp(a.uri, b.uri),
  );
}

export type CutReason = "items" | "tokens";
export interface SelectionCut {
  uri: string;
  reason: CutReason;
}

/** Greedy in rank order: an item past the item cap, or one that would take
 * the role over its token budget, is CUT (and listed); a smaller one after
 * it may still fit. */
export function capSelection<T extends { uri: string; tokens: number }>(
  ranked: readonly T[],
  cap: SelectionCap,
): { selected: T[]; cuts: SelectionCut[] } {
  const selected: T[] = [];
  const cuts: SelectionCut[] = [];
  let used = 0;
  for (const c of ranked) {
    if (selected.length >= cap.items) {
      cuts.push({ uri: c.uri, reason: "items" });
      continue;
    }
    if (used + c.tokens > cap.tokens) {
      cuts.push({ uri: c.uri, reason: "tokens" });
      continue;
    }
    selected.push(c);
    used += c.tokens;
  }
  return { selected, cuts };
}

// ---- cases ------------------------------------------------------------------

export interface CaseHeader {
  pr: number | null;
  path: string | null;
  lens: string[];
  fate: string | null;
  posted: string | null;
  replies: number;
  kind: string | null;
  severity: string | null;
}

/** A case header value, decoded (src/cases.ts `tagValue` encodes `%`, the
 * whitespace and the control bytes as `%XX`). */
function decodeTagValue(v: string): string {
  return v.replace(/%([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
}

/** A finding case's header, or null when the text is not a live case (no
 * `#case kind=case` header, or withdrawn/retired). Header only. */
export function parseCaseHeader(text: string): CaseHeader | null {
  const t = text.trim();
  const hash = parseHashTags(t);
  if (!hash.includes("case") || hash.includes("retired") || hash.includes("moved")) return null;
  const tags = parseEventTags(t);
  if (tags["kind"] !== "case") return null;
  const pr = tags["pr"] !== undefined && /^\d{1,9}$/.test(tags["pr"]) ? Number(tags["pr"]) : null;
  const replies = tags["replies"] !== undefined && /^\d{1,6}$/.test(tags["replies"]) ? Number(tags["replies"]) : 0;
  return {
    pr,
    path: tags["path"] !== undefined ? decodeTagValue(tags["path"]) : null,
    lens: canonicalLensIds(tags["lens"] ?? ""),
    fate: tags["fate"] ?? null,
    posted: tags["posted"] ?? null,
    replies,
    kind: tags["finding_kind"] ?? null,
    severity: tags["severity"] !== undefined ? decodeTagValue(tags["severity"]) : null,
  };
}

export type CaseDropReason =
  | "out_of_area"
  | "duplicate"
  | "retired"
  | "suppressed"
  | "not_case"
  | "same_pr"
  | "paths"
  | "as_of";

export interface CaseCandidate {
  uri: string;
  text: string;
  score: number;
  header: CaseHeader;
  tokens: number;
  lensHit: boolean;
}

export interface CaseFilterContext {
  root: string;
  /** The PR under review: its own cases are its own history, not precedent. */
  pr: number;
  /** The PR's changed files — a case is about one of them, or it is out. */
  files: readonly string[];
  /** The round's planned lenses (a case raised by one of them ranks first). */
  lenses: readonly string[];
  retired: ReadonlySet<string>;
  suppressed: ReadonlySet<string>;
  asOf?: string | null;
}

export function filterCaseHits(
  hits: readonly FindHit[],
  ctx: CaseFilterContext,
): { eligible: CaseCandidate[]; dropped: DropCounts } {
  const dropped: DropCounts = {};
  const { hits: unique, duplicates } = dedupeHits(hits);
  if (duplicates > 0) bump(dropped, "duplicate", duplicates);
  const files = new Set(ctx.files);
  const eligible: CaseCandidate[] = [];
  for (const h of unique) {
    const text = typeof h.text === "string" ? h.text : "";
    if (!inArea(h.uri, ctx.root, CASES_AREA)) {
      bump(dropped, "out_of_area");
      continue;
    }
    if (ctx.retired.has(h.uri) || parseHashTags(text.trim()).includes("retired")) {
      bump(dropped, "retired");
      continue;
    }
    if (ctx.suppressed.has(h.uri)) {
      bump(dropped, "suppressed");
      continue;
    }
    const header = parseCaseHeader(text);
    if (!header) {
      bump(dropped, "not_case");
      continue;
    }
    if (header.pr === ctx.pr) {
      bump(dropped, "same_pr");
      continue;
    }
    if (header.path === null || !files.has(header.path)) {
      bump(dropped, "paths");
      continue;
    }
    if (!beforeAsOf(header.posted, ctx.asOf)) {
      bump(dropped, "as_of");
      continue;
    }
    eligible.push({
      uri: h.uri,
      text: text.trim(),
      score: typeof h.score === "number" && Number.isFinite(h.score) ? h.score : 0,
      header,
      tokens: estimateTokens(text),
      lensHit: header.lens.some((l) => ctx.lenses.includes(l)),
    });
  }
  return { eligible, dropped };
}

/** Deterministic: a shared lens > replies drawn > recency > URI. */
export function rankCases(cands: readonly CaseCandidate[]): CaseCandidate[] {
  return [...cands].sort(
    (a, b) =>
      compareKeys(
        [a.lensHit ? 1 : 0, a.header.replies, a.header.posted ?? ""],
        [b.lensHit ? 1 : 0, b.header.replies, b.header.posted ?? ""],
      ) || cmp(a.uri, b.uri),
  );
}

// ---- the round ----------------------------------------------------------------

/** One row of the round's pass plan, as selection needs it. */
export interface SelectionRow {
  /** Index into `pass_plan` (the task file's row). */
  row: number;
  lens: string;
  agent: string;
  /** Sweep rows: the files this row covers. */
  focus?: readonly string[];
}

/** One find the prefetch asks. Identical (area, query) pairs are asked once. */
export interface PlannedFind {
  key: string;
  area: typeof EXPERIENCES_AREA | typeof CASES_AREA;
  query: string;
  limit: number;
}

export interface FindPlan {
  finds: PlannedFind[];
  /** Plan row → its find's key; a row past `MAX_FINDS_PER_ROUND` has none. */
  rowKey: Map<number, string>;
  /** The main session's cases find, when there is one. */
  casesKey: string | null;
}

const QUERY_MAX_CHARS = 600;

/** The query for one row: the PR title and the shape of the row's files (the
 * round context query's own builder), and the lens. */
export function lessonRowQuery(input: {
  title: string;
  lens: string;
  files: readonly string[];
}): string {
  const base = roundContextQuery({ title: input.title, files: input.files.map((filename) => ({ filename })) });
  const lensWord = input.lens.replace(/^pass-/, "");
  return [base, lensWord].filter((p) => p !== "").join(" — ").slice(0, QUERY_MAX_CHARS);
}

/** The main session's cases query: the title and the changed paths, sorted
 * (a function of the file SET). */
export function casesQuery(input: { title: string; files: readonly string[] }): string {
  const title = input.title.replace(/\s+/g, " ").trim();
  const paths = [...new Set(input.files)].sort().slice(0, 12).join(" ");
  return [title, paths].filter((p) => p !== "").join(" — ").slice(0, QUERY_MAX_CHARS);
}

function findKey(area: string, query: string): string {
  return `${area}\u0000${query}`;
}

/** The round's finds: one per discovery row and one for the validator row
 * (deduplicated), then the main session's cases, capped. */
export function planFinds(input: {
  title: string;
  rows: readonly SelectionRow[];
  prFiles: readonly string[];
}): FindPlan {
  const finds: PlannedFind[] = [];
  const rowKey = new Map<number, string>();
  const seen = new Set<string>();
  const add = (area: PlannedFind["area"], query: string, limit: number): string | null => {
    const key = findKey(area, query);
    if (seen.has(key)) return key;
    if (finds.length >= MAX_FINDS_PER_ROUND) return null;
    seen.add(key);
    finds.push({ key, area, query, limit });
    return key;
  };
  // The cases find is the main session's single ask: planned FIRST so a wide
  // plan's cap never takes it.
  const casesKey =
    input.prFiles.length > 0
      ? add(CASES_AREA, casesQuery({ title: input.title, files: input.prFiles }), FIND_LIMITS.cases)
      : null;
  for (const r of input.rows) {
    const files = r.focus && r.focus.length > 0 ? r.focus : input.prFiles;
    const key = add(
      EXPERIENCES_AREA,
      lessonRowQuery({ title: input.title, lens: r.lens, files }),
      FIND_LIMITS.lessons,
    );
    if (key !== null) rowKey.set(r.row, key);
  }
  return { finds, rowKey, casesKey };
}

/** A lesson as the ledger records it — every field the shadow matcher and
 * the report need, so neither ever reads memory. */
export interface SelectedLesson {
  uri: string;
  kind: LessonKind;
  class: string | null;
  lens: string[];
  paths: string[];
  evidence: number;
  format: "typed" | "legacy";
  tokens: number;
  score: number;
  created: string | null;
}

export interface SelectedCase {
  uri: string;
  pr: number | null;
  path: string | null;
  lens: string[];
  fate: string | null;
  replies: number;
  tokens: number;
  score: number;
}

export type SelectionRole = "row" | "validator" | "cases";
export type SelectionStatus = "ok" | "timeout" | "unreadable" | "find_cap";

export interface RoleSelection {
  role: SelectionRole;
  /** The plan row (`row`, `validator`); -1 for the main session's cases. */
  row: number;
  lens: string;
  agent: string | null;
  query: string | null;
  status: SelectionStatus;
  reason?: string;
  lessons: SelectedLesson[];
  cases: SelectedCase[];
  cuts: SelectionCut[];
  dropped: DropCounts;
}

function asSelected(c: LessonCandidate): SelectedLesson {
  return {
    uri: c.uri,
    kind: c.lesson.kind,
    class: c.lesson.class,
    lens: [...c.lesson.lens],
    paths: [...c.lesson.paths],
    evidence: c.lesson.evidence.length,
    format: c.lesson.format,
    tokens: c.tokens,
    score: Math.round(c.score * 1000) / 1000,
    created: c.created,
  };
}

function caseSelected(c: CaseCandidate): SelectedCase {
  return {
    uri: c.uri,
    pr: c.header.pr,
    path: c.header.path,
    lens: [...c.header.lens],
    fate: c.header.fate,
    replies: c.header.replies,
    tokens: c.tokens,
    score: Math.round(c.score * 1000) / 1000,
  };
}

export interface SelectRoundInput {
  pr: number;
  title: string;
  rows: readonly SelectionRow[];
  prFiles: readonly string[];
  root: string;
  plan: FindPlan;
  outcomes: ReadonlyMap<string, FindOutcome>;
  retired: ReadonlySet<string>;
  suppressed: ReadonlySet<string>;
  asOf?: string | null;
  caps?: { row: SelectionCap; cases: SelectionCap; validator: SelectionCap };
}

/**
 * The round's selection, one record per role: every discovery row's lessons,
 * the validator's (the dont-raise lessons any discovery row found eligible,
 * and every lesson naming `pass-validate` its own find returned), and the
 * main session's cases. Pure and deterministic: the same outcomes in any
 * order give the same records.
 */
export function selectRound(input: SelectRoundInput): RoleSelection[] {
  const caps = input.caps ?? SELECTION_CAPS;
  const out: RoleSelection[] = [];
  const query = (key: string | undefined | null): string | null =>
    key ? (input.plan.finds.find((f) => f.key === key)?.query ?? null) : null;
  const base = { retired: input.retired, suppressed: input.suppressed, asOf: input.asOf ?? null, root: input.root };
  // Every dont-raise lesson some discovery row found eligible — the
  // validator's candidates beside its own find's.
  const dontRaise = new Map<string, LessonCandidate>();
  let validatorRow: SelectionRow | null = null;

  for (const r of input.rows) {
    if (r.lens === VALIDATOR_LENS) {
      validatorRow ??= r;
      continue;
    }
    const key = input.plan.rowKey.get(r.row);
    const rec: RoleSelection = {
      role: "row",
      row: r.row,
      lens: r.lens,
      agent: r.agent,
      query: query(key),
      status: "ok",
      lessons: [],
      cases: [],
      cuts: [],
      dropped: {},
    };
    out.push(rec);
    if (!key) {
      rec.status = "find_cap";
      continue;
    }
    const o = input.outcomes.get(key) ?? { status: "timeout" as const };
    if (o.status !== "ok") {
      rec.status = o.status;
      if (o.status === "unreadable") rec.reason = o.reason;
      continue;
    }
    const files = r.focus && r.focus.length > 0 ? r.focus : input.prFiles;
    const { eligible, dropped } = filterLessonHits(o.hits, { ...base, lens: r.lens, files });
    rec.dropped = dropped;
    for (const c of eligible) if (c.lesson.kind === "dont-raise" && !dontRaise.has(c.uri)) dontRaise.set(c.uri, c);
    const { selected, cuts } = capSelection(rankLessons(eligible, r.lens), caps.row);
    rec.lessons = selected.map(asSelected);
    rec.cuts = cuts;
  }

  if (validatorRow) {
    const key = input.plan.rowKey.get(validatorRow.row);
    const rec: RoleSelection = {
      role: "validator",
      row: validatorRow.row,
      lens: VALIDATOR_LENS,
      agent: validatorRow.agent,
      query: query(key),
      status: "ok",
      lessons: [],
      cases: [],
      cuts: [],
      dropped: {},
    };
    const pool = new Map(dontRaise);
    if (!key) rec.status = "find_cap";
    else {
      const o = input.outcomes.get(key) ?? { status: "timeout" as const };
      if (o.status !== "ok") {
        // Its own find did not answer; the discovery rows' dont-raise lessons
        // are still its candidates.
        rec.status = o.status;
        if (o.status === "unreadable") rec.reason = o.reason;
      } else {
        const { eligible, dropped } = filterLessonHits(o.hits, {
          ...base,
          lens: VALIDATOR_LENS,
          files: input.prFiles,
        });
        rec.dropped = dropped;
        for (const c of eligible)
          if (c.lesson.lens.includes(VALIDATOR_LENS) || c.lesson.kind === "dont-raise")
            if (!pool.has(c.uri)) pool.set(c.uri, c);
      }
    }
    // Ranked against the whole PR: a path hit is a hit on any changed file.
    const ranked = rankLessons(
      [...pool.values()].map((c) => ({
        ...c,
        pathHit: c.lesson.paths.length > 0 && input.prFiles.some(globMatcherSafe(c.lesson.paths)),
      })),
      VALIDATOR_LENS,
    );
    const { selected, cuts } = capSelection(ranked, caps.validator);
    rec.lessons = selected.map(asSelected);
    rec.cuts = cuts;
    out.push(rec);
  }

  const casesKey = input.plan.casesKey;
  const casesRec: RoleSelection = {
    role: "cases",
    row: -1,
    lens: "",
    agent: null,
    query: query(casesKey),
    status: "ok",
    lessons: [],
    cases: [],
    cuts: [],
    dropped: {},
  };
  if (casesKey) {
    const o = input.outcomes.get(casesKey) ?? { status: "timeout" as const };
    if (o.status !== "ok") {
      casesRec.status = o.status;
      if (o.status === "unreadable") casesRec.reason = o.reason;
    } else {
      const { eligible, dropped } = filterCaseHits(o.hits, {
        ...base,
        pr: input.pr,
        files: input.prFiles,
        lenses: input.rows.map((r) => r.lens),
      });
      casesRec.dropped = dropped;
      const { selected, cuts } = capSelection(rankCases(eligible), caps.cases);
      casesRec.cases = selected.map(caseSelected);
      casesRec.cuts = cuts;
    }
  }
  out.push(casesRec);
  return out;
}

// ---- the engine port ---------------------------------------------------------

/**
 * What the selector asks of the context engine — the port, so selection and
 * its budget are testable over a fake engine and nothing above it knows HTTP
 * (src/openviking/lessonfind.ts is the implementation). TOTAL: both methods
 * resolve, a refusal is an answer (`ok: false`) and never a throw.
 */
export interface LessonEngine {
  /** The memories root URI the areas live under. */
  root(): string;
  /** One `/search/find` inside `<root>/<area>`. */
  find(
    area: string,
    query: string,
    opts: { limit: number; timeoutMs: number },
  ): Promise<{ ok: true; hits: readonly FindHit[] } | { ok: false; reason: string }>;
  /** The store's list of retired URIs (its last completed sweep). */
  retiredUris(): Promise<readonly string[]>;
}

// Typed lessons (S8): the header a curated lesson carries, and the
// tolerant reader for every lesson shape memory already holds.
//
// A lesson in `experiences/` used to be prose: 10 of the 17 EOD lessons the
// audit read carried no machine header at all, and the rest spelled their
// type, lens and evidence three different ways in the BODY. Nothing could
// tell which lens a lesson was for, whether it said "look for X" or "do not
// raise X", or which human evidence it rested on — so nothing could deliver
// it to the right lens (S9), measure the look-for : don't-raise balance, or
// tell which candidate a lesson adopted.
//
// THE GRAMMAR. A typed lesson opens with one header line, written by the
// vendored `viking_write` from its structured `lesson` parameter (patch 0010,
// `extensions/vendor/openviking-pi/qcr-lesson.ts` — never typed by hand):
//
//   #lesson kind=<repo-fact|look-for|dont-raise|convention> lens=<ids>
//           class=<slug> paths=<globs> evidence=<refs>
//
// on ONE line; lists are comma-separated, values carry no whitespace (the tag
// grammar of src/memory/eventtags.ts), lens ids are the built passes
// (`ALL_PASSES`, the validator included), and an evidence ref is `<kind>:<id>`
// (`pr:5312`, `comment:3832300186`, `case:case-5312-r2-…`, `commit:<sha>`,
// and `cand:c42` — the learner's candidate the lesson adopts). Only the HEADER
// is read: both parsers stop at the first word of prose, so a quoted comment
// in the body can never mint a field.
//
// THE TOLERANT READER (`parseLesson`) also reads the legacy shapes, under
// three limits: it never reads body fields from an entry whose header says it
// is an event (`#feedback`, `#adjudication`, `#bug`, `#operations`, `#case`,
// or any `kind=` that is not a lesson kind); it never derives a placement or a
// retirement from the body; and it records where its fields came from
// (`fieldsSource`). The legacy shapes, from the live store:
//
//   * `#refuted #eod-learning` + a `type: refuted — … Lens: UI/backcompat.
//     Evidence: <PR url> …` body (August EOD lessons);
//   * the import: `#imported #learning import-key:… #false-positive
//     #eod-learning [[pr-5312]] type: false-positive — …`;
//   * October's headerless `# Title` / `type:` / `lens:` / `date:` lines;
//   * `#convention #corpus topic=… source=…` (the conventions).
//
// A leaf: the tag parsers and the lens vocabulary, nothing engine-specific.
import { canonicalLensIds } from "../lensids.js";
import { ALL_PASSES } from "../passes.js";
import { parseEventTags, parseHashTags } from "./eventtags.js";

/** The hash tag a typed lesson's header opens with. */
export const LESSON_TAG = "lesson";

export const LESSON_KINDS = ["repo-fact", "look-for", "dont-raise", "convention"] as const;
export type LessonKind = (typeof LESSON_KINDS)[number];

/** A lesson's class: the slug the learner clusters candidates by
 * (`baseline.authz`, `missed.backend`) and a lesson names to cover them. */
export const LESSON_CLASS_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;
/** One path glob: anything but whitespace and the list separator. */
const PATH_GLOB_RE = /^[^\s,]{1,200}$/;
/** One evidence ref: `<kind>:<id>`, no whitespace, no list separator. */
const EVIDENCE_REF_RE = /^[a-z][a-z0-9-]{0,19}:[^\s,]{1,200}$/;

export const LESSON_LIMITS = Object.freeze({ lenses: 8, paths: 12, evidence: 16 });

/** The evidence-ref prefix that names a learner candidate (`cand:c42`). */
export const CANDIDATE_REF = "cand";

/** The lens ids a lesson may name: every built pass, the validator included
 * (`ALL_PASSES` — the same list `canonicalLensIds` knows). The vendored
 * `viking_write` holds a copy, pinned equal to this by
 * tests/openviking-fork.test.ts. */
export const LESSON_LENS_IDS: readonly string[] = ALL_PASSES;

export interface LessonFields {
  kind: LessonKind;
  lens: string[];
  class: string;
  paths: string[];
  evidence: string[];
}

function stringList(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return [];
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : null;
  if (!list) return null;
  const out: string[] = [];
  for (const v of list) {
    if (typeof v !== "string") return null;
    const t = v.trim();
    if (t !== "" && !out.includes(t)) out.push(t);
  }
  return out;
}

/** `baseline` → `pass-baseline` when that is a known lens; the id itself when
 * it is one; null otherwise. */
function knownLens(id: string, known: readonly string[]): string | null {
  const t = id.trim().toLowerCase();
  if (known.includes(t)) return t;
  if (known.includes(`pass-${t}`)) return `pass-${t}`;
  return null;
}

/**
 * Check a structured lesson (the `lesson` parameter of `viking_write`, or a
 * test's) against the grammar. Every field is required; lens ids must be
 * built passes (a short `baseline` is read as `pass-baseline`); an unknown
 * lens id, a class that is not a slug, a glob or ref with whitespace or a
 * comma is REFUSED with a sentence saying which — a mistyped lens that
 * silently lands would be delivered to nobody (S9).
 */
export function validateLessonFields(
  raw: unknown,
  knownLenses: readonly string[] = LESSON_LENS_IDS,
): { ok: true; fields: LessonFields } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return { ok: false, error: "`lesson` must be an object {kind, lens, class, paths, evidence}." };
  const o = raw as Record<string, unknown>;
  const unknown = Object.keys(o).filter(
    (k) => !["kind", "lens", "class", "paths", "evidence"].includes(k),
  );
  if (unknown.length > 0) return { ok: false, error: `Unknown lesson field(s): ${unknown.join(", ")}.` };
  const kind = typeof o["kind"] === "string" ? o["kind"].trim().toLowerCase() : "";
  if (!(LESSON_KINDS as readonly string[]).includes(kind))
    return { ok: false, error: `lesson.kind must be one of ${LESSON_KINDS.join(", ")}.` };
  const lensRaw = stringList(o["lens"]);
  if (!lensRaw || lensRaw.length === 0)
    return { ok: false, error: "lesson.lens must name at least one lens id (e.g. pass-baseline)." };
  if (lensRaw.length > LESSON_LIMITS.lenses)
    return { ok: false, error: `lesson.lens names ${lensRaw.length} lenses; at most ${LESSON_LIMITS.lenses}.` };
  const lens: string[] = [];
  const bad: string[] = [];
  for (const id of lensRaw) {
    const k = knownLens(id, knownLenses);
    if (k === null) bad.push(id);
    else if (!lens.includes(k)) lens.push(k);
  }
  if (bad.length > 0)
    return {
      ok: false,
      error: `Unknown lens id(s): ${bad.join(", ")}. A lesson names built passes only (${knownLenses.join(", ")}).`,
    };
  const cls = typeof o["class"] === "string" ? o["class"].trim().toLowerCase() : "";
  if (!LESSON_CLASS_RE.test(cls))
    return {
      ok: false,
      error: "lesson.class must be a slug: lowercase letters, digits, '.', '_' or '-' (e.g. baseline.pre-existing-scope).",
    };
  const paths = stringList(o["paths"]);
  if (!paths || paths.length === 0)
    return { ok: false, error: "lesson.paths must name at least one path glob (`**` for the whole repo)." };
  if (paths.length > LESSON_LIMITS.paths)
    return { ok: false, error: `lesson.paths names ${paths.length} globs; at most ${LESSON_LIMITS.paths}.` };
  const badGlob = paths.find((p) => !PATH_GLOB_RE.test(p));
  if (badGlob !== undefined)
    return {
      ok: false,
      error: `Path glob "${badGlob}" may not contain whitespace or a comma (write a brace expansion as separate globs).`,
    };
  const evidence = stringList(o["evidence"]);
  if (!evidence || evidence.length === 0)
    return {
      ok: false,
      error: "lesson.evidence must cite at least one ref (pr:<n>, comment:<id>, case:<name>, commit:<sha>, cand:<id>) — no lesson without evidence.",
    };
  if (evidence.length > LESSON_LIMITS.evidence)
    return { ok: false, error: `lesson.evidence cites ${evidence.length} refs; at most ${LESSON_LIMITS.evidence}.` };
  const badRef = evidence.find((r) => !EVIDENCE_REF_RE.test(r));
  if (badRef !== undefined)
    return {
      ok: false,
      error: `Evidence ref "${badRef}" must be <kind>:<id> with no whitespace or comma (e.g. pr:5312, cand:c42).`,
    };
  return { ok: true, fields: { kind: kind as LessonKind, lens, class: cls, paths, evidence } };
}

/** The one header line of a typed lesson. */
export function renderLessonHeader(f: LessonFields): string {
  return [
    `#${LESSON_TAG}`,
    `kind=${f.kind}`,
    `lens=${f.lens.join(",")}`,
    `class=${f.class}`,
    `paths=${f.paths.join(",")}`,
    `evidence=${f.evidence.join(",")}`,
  ].join(" ");
}

// ---- the tolerant reader ----------------------------------------------------

/** The legacy `type:` values and the lesson kind each one is. */
const LEGACY_TYPES: Readonly<Record<string, LessonKind>> = {
  "missed-finding": "look-for",
  "false-positive": "dont-raise",
  refuted: "dont-raise",
  "wontfix-pattern": "dont-raise",
  wontfix: "dont-raise",
  "repo-gotcha": "repo-fact",
};

/** Header tags that say an entry is an EVENT (or not ours to read as a
 * lesson): its body is never read for lesson fields. */
const EVENT_HASH_TAGS: ReadonlySet<string> = new Set([
  "feedback",
  "adjudication",
  "bug",
  "operations",
  "case",
  "retired",
  "moved",
  "survey",
  "scan",
  "history",
  "rejected-proposal",
]);

export interface ParsedLesson {
  /** `typed` — the S8 header; `legacy` — one of the older shapes. */
  format: "typed" | "legacy";
  /** null when the entry is a lesson whose polarity cannot be told. */
  kind: LessonKind | null;
  /** The legacy `type:` word, when that is what decided the kind. */
  legacyType: string | null;
  lens: string[];
  class: string | null;
  paths: string[];
  evidence: string[];
  /** Learner candidate ids the evidence cites (`cand:c42` → 42). */
  candidates: number[];
  /** Where the fields were read: the header (typed, conventions) or the
   * body (the legacy prose shapes). */
  fieldsSource: "header" | "body";
}

function splitList(v: string | undefined): string[] {
  if (v === undefined) return [];
  return [...new Set(v.split(",").map((s) => s.trim()).filter((s) => s !== ""))];
}

/** `cand:c42` / `cand:42` → 42; anything else null. */
export function candidateIdOfRef(ref: string): number | null {
  const m = /^cand:c?(\d{1,12})$/i.exec(ref.trim());
  return m ? Number(m[1]) : null;
}

/** The candidate ids a list of evidence refs cites. */
export function citedCandidates(evidence: readonly string[]): number[] {
  const out: number[] = [];
  for (const r of evidence) {
    const id = candidateIdOfRef(r);
    if (id !== null && !out.includes(id)) out.push(id);
  }
  return out;
}

/** The first `<label>: value` line in the first lines of the body. */
function bodyField(text: string, label: RegExp): string | null {
  const lines = text.split("\n").slice(0, 20);
  for (const line of lines) {
    const m = label.exec(line.trim());
    if (m) return m[1]!.trim();
  }
  return null;
}

/**
 * Read a memory entry as a lesson, or null when it is not one (an event, an
 * ops note, a retired entry, a probe, prose with no lesson shape). Typed
 * headers first; then the legacy shapes, from the body, only when the header
 * does not say the entry is something else.
 */
export function parseLesson(text: string): ParsedLesson | null {
  const trimmed = text.trim();
  const hash = parseHashTags(trimmed);
  const tags = parseEventTags(trimmed);
  if (hash.some((t) => EVENT_HASH_TAGS.has(t))) return null;

  if (hash.includes(LESSON_TAG) && (LESSON_KINDS as readonly string[]).includes(tags["kind"] ?? "")) {
    const evidence = splitList(tags["evidence"]);
    const cls = (tags["class"] ?? "").toLowerCase();
    return {
      format: "typed",
      kind: tags["kind"] as LessonKind,
      legacyType: null,
      lens: canonicalLensIds(splitList(tags["lens"]).join(",")),
      class: LESSON_CLASS_RE.test(cls) ? cls : null,
      paths: splitList(tags["paths"]),
      evidence,
      candidates: citedCandidates(evidence),
      fieldsSource: "header",
    };
  }
  // Any other `kind=` is an event's (feedback, bug, ops, case): never a lesson.
  if (tags["kind"] !== undefined) return null;

  if (hash.includes("convention")) {
    const topic = (tags["topic"] ?? "").toLowerCase();
    return {
      format: "legacy",
      kind: "convention",
      legacyType: "convention",
      lens: [],
      class: LESSON_CLASS_RE.test(`convention.${topic}`) && topic !== "" ? `convention.${topic}` : null,
      paths: [],
      evidence: tags["source"] ? [`source:${tags["source"]}`] : [],
      candidates: [],
      fieldsSource: "header",
    };
  }

  // Legacy prose: the type from the header's own hash tags first, else a
  // `type:` line near the top of the body.
  const headerType = hash.find((t) => t in LEGACY_TYPES) ?? null;
  const learningTagged = hash.includes("eod-learning") || hash.includes("learning");
  // A `type:` line near the top; for an entry the header already calls a
  // learning (the import puts it mid-line, after its own tags), a
  // `type:` anywhere in the opening.
  const bodyType = (
    bodyField(trimmed, /^(?:[-*]\s*)?type:\s*([a-z-]+)/i) ??
    (learningTagged ? (/\btype:\s*([a-z-]+)/i.exec(trimmed.slice(0, 600))?.[1] ?? "") : "")
  ).toLowerCase();
  const legacyType = headerType ?? (bodyType in LEGACY_TYPES ? bodyType : null);
  if (legacyType === null && !learningTagged) return null;

  const lensLine =
    bodyField(trimmed, /^(?:[-*]\s*)?lens:\s*(.+)$/i) ?? /\bLens:\s*([^.\n]+)/.exec(trimmed)?.[1] ?? "";
  const prs = [
    ...new Set(
      [...trimmed.matchAll(/(?:\/pull\/|\bPR #|\[\[pr-)(\d{1,7})/g)].map((m) => `pr:${m[1]}`),
    ),
  ];
  return {
    format: "legacy",
    kind: legacyType ? LEGACY_TYPES[legacyType]! : null,
    legacyType,
    lens: canonicalLensIds(lensLine),
    class: null,
    paths: [],
    evidence: prs,
    candidates: [],
    fieldsSource: "body",
  };
}

// ---- what the learner reads off the lessons in force ------------------------

/** A lesson in force, as the learner indexes it. */
export interface IndexedLesson extends ParsedLesson {
  /** The memory entry's id (`experiences/<file>`). */
  id: string;
}

/** The health metric (S8): lessons in force by kind. `look_for` and
 * `dont_raise` are the two the ratio compares; a lesson whose polarity cannot
 * be told is `unknown`. */
export interface LessonBalance {
  look_for: number;
  dont_raise: number;
  repo_fact: number;
  convention: number;
  unknown: number;
  /** look_for / dont_raise, rounded to 2 places; null when no dont-raise
   * lesson exists (a ratio over zero is not a number anyone can read). */
  ratio: number | null;
  /** How many of them carry the typed header. */
  typed: number;
}

export function lessonBalance(lessons: readonly ParsedLesson[]): LessonBalance {
  const b: LessonBalance = {
    look_for: 0,
    dont_raise: 0,
    repo_fact: 0,
    convention: 0,
    unknown: 0,
    ratio: null,
    typed: 0,
  };
  for (const l of lessons) {
    if (l.format === "typed") b.typed += 1;
    switch (l.kind) {
      case "look-for":
        b.look_for += 1;
        break;
      case "dont-raise":
        b.dont_raise += 1;
        break;
      case "repo-fact":
        b.repo_fact += 1;
        break;
      case "convention":
        b.convention += 1;
        break;
      default:
        b.unknown += 1;
    }
  }
  b.ratio = b.dont_raise === 0 ? null : Math.round((b.look_for / b.dont_raise) * 100) / 100;
  return b;
}

/** `look-for:dont-raise 3:25 (0.12)` — the metric as one phrase. */
export function balancePhrase(b: LessonBalance): string {
  return `look-for:dont-raise ${b.look_for}:${b.dont_raise}${b.ratio === null ? "" : ` (${b.ratio.toFixed(2)})`}`;
}

/**
 * The lessons already covering a candidate class: a typed lesson whose class
 * is the class, or one a dot-segment above or below it (`baseline` covers
 * `baseline.authz`); a lesson with no class (the legacy shapes) when it names
 * the class's lens (`baseline.authz` → `pass-baseline`). Ids, newest first as
 * given, at most `max`.
 */
export function coveringLessons(
  lessons: readonly IndexedLesson[],
  cls: string,
  lensIds: readonly string[],
  max = 5,
): string[] {
  const out: string[] = [];
  const related = (a: string, b: string): boolean =>
    a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
  for (const l of lessons) {
    const hit =
      l.class !== null
        ? related(l.class, cls)
        : lensIds.length > 0 && l.lens.some((id) => lensIds.includes(id));
    if (hit && !out.includes(l.id)) out.push(l.id);
    if (out.length >= max) break;
  }
  return out;
}

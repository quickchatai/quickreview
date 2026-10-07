// QCR FORK — file added by PATCH 10 (typed lessons). Not upstream.
// a curated lesson carries a machine header, written by the tool.
//
// The pure half, kept free of pi and of the OV client so
// `tests/openviking-fork.test.ts` can exercise it (`tools.ts` cannot be
// imported from a test).
//
// The EOD curator wrote its lessons as prose: 10 of 17 carried no machine
// header, the rest spelled type, lens and evidence three ways in the body, and
// nothing could tell which lens a lesson was for or which human evidence it
// rested on. `viking_write` now takes a structured `lesson` parameter and
// RENDERS the header itself, on the entry's first line:
//
//   #lesson kind=<repo-fact|look-for|dont-raise|convention> lens=<ids>
//           class=<slug> paths=<globs> evidence=<refs>
//
// (one line; lists comma-separated; no whitespace in a value). The daemon's
// reader is `src/memory/lessons.ts` (`parseLesson`); the test suite pins this
// renderer against it, and `LESSON_LENS_IDS` here equal to the daemon's built
// passes (`ALL_PASSES`) — one list, two readers, like PATCH 9's areas. An
// unknown lens id is REFUSED: a lesson for a lens nobody runs would be
// delivered to nobody. A lesson is written into `experiences/` and nowhere
// else, and its content may not carry a header of its own.

/** The lesson kinds — the daemon's `LESSON_KINDS`. */
export const LESSON_KINDS: readonly string[] = ["repo-fact", "look-for", "dont-raise", "convention"];

/** The lens ids a lesson may name: every pass the daemon builds, the
 * validator included. Pinned equal to `src/passes.ts` `ALL_PASSES`. */
export const LESSON_LENS_IDS: readonly string[] = [
  "pass-baseline",
  "pass-ui",
  "pass-contracts",
  "pass-data-safety",
  "pass-security",
  "pass-statelessness",
  "pass-prod-risk",
  "pass-delivery",
  "pass-intent",
  "pass-placement",
  "pass-simplicity",
  "pass-backcompat",
  "pass-concurrency",
  "pass-ask-human",
  "pass-widened",
  "pass-roundtrip",
  "pass-deferred",
  "pass-bounds",
  "pass-claims",
  "pass-rollout",
  "pass-behaviour-delta",
  "pass-sweep",
  "pass-tests",
  "pass-maintainability",
  "pass-duplication",
  "pass-abstraction",
  "pass-consistency",
  "pass-style",
  "pass-lint-conformance",
  "pass-validate",
];

const CLASS_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const GLOB_RE = /^[^\s,]{1,200}$/;
const REF_RE = /^[a-z][a-z0-9-]{0,19}:[^\s,]{1,200}$/;
const LIMITS = { lenses: 8, paths: 12, evidence: 16 };

/** Where a lesson may be written: a file directly in a user's
 * `memories/experiences/`. */
const LESSON_URI_RE = /^viking:\/\/user\/[^/\s]+\/memories\/experiences\/[^/\s]+$/;

export interface LessonHeaderOk {
  ok: true;
  header: string;
}

export interface LessonHeaderError {
  ok: false;
  error: string;
}

function list(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return [];
  const items = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : null;
  if (!items) return null;
  const out: string[] = [];
  for (const v of items) {
    if (typeof v !== "string") return null;
    const t = v.trim();
    if (t !== "" && !out.includes(t)) out.push(t);
  }
  return out;
}

/**
 * The header line for a structured `lesson`, or the sentence saying what is
 * wrong with it. Every field is required; `baseline` is read as
 * `pass-baseline`; nothing unknown is accepted.
 */
export function buildLessonHeader(
  raw: unknown,
  known: readonly string[] = LESSON_LENS_IDS,
): LessonHeaderOk | LessonHeaderError {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return { ok: false, error: "`lesson` must be an object {kind, lens, class, paths, evidence}." };
  const o = raw as Record<string, unknown>;
  const unknown = Object.keys(o).filter(
    (k) => !["kind", "lens", "class", "paths", "evidence"].includes(k),
  );
  if (unknown.length > 0) return { ok: false, error: `Unknown lesson field(s): ${unknown.join(", ")}.` };
  const kind = typeof o["kind"] === "string" ? o["kind"].trim().toLowerCase() : "";
  if (!LESSON_KINDS.includes(kind))
    return { ok: false, error: `lesson.kind must be one of ${LESSON_KINDS.join(", ")}.` };
  const lensRaw = list(o["lens"]);
  if (!lensRaw || lensRaw.length === 0)
    return { ok: false, error: "lesson.lens must name at least one lens id (e.g. pass-baseline)." };
  if (lensRaw.length > LIMITS.lenses)
    return { ok: false, error: `lesson.lens names ${lensRaw.length} lenses; at most ${LIMITS.lenses}.` };
  const lens: string[] = [];
  const bad: string[] = [];
  for (const id of lensRaw) {
    const t = id.toLowerCase();
    const k = known.includes(t) ? t : known.includes(`pass-${t}`) ? `pass-${t}` : null;
    if (k === null) bad.push(id);
    else if (!lens.includes(k)) lens.push(k);
  }
  if (bad.length > 0)
    return {
      ok: false,
      error: `Unknown lens id(s): ${bad.join(", ")}. A lesson names built passes only (${known.join(", ")}).`,
    };
  const cls = typeof o["class"] === "string" ? o["class"].trim().toLowerCase() : "";
  if (!CLASS_RE.test(cls))
    return {
      ok: false,
      error: "lesson.class must be a slug: lowercase letters, digits, '.', '_' or '-' (e.g. baseline.pre-existing-scope).",
    };
  const paths = list(o["paths"]);
  if (!paths || paths.length === 0)
    return { ok: false, error: "lesson.paths must name at least one path glob (`**` for the whole repo)." };
  if (paths.length > LIMITS.paths)
    return { ok: false, error: `lesson.paths names ${paths.length} globs; at most ${LIMITS.paths}.` };
  const badGlob = paths.find((p) => !GLOB_RE.test(p));
  if (badGlob !== undefined)
    return {
      ok: false,
      error: `Path glob "${badGlob}" may not contain whitespace or a comma (write a brace expansion as separate globs).`,
    };
  const evidence = list(o["evidence"]);
  if (!evidence || evidence.length === 0)
    return {
      ok: false,
      error: "lesson.evidence must cite at least one ref (pr:<n>, comment:<id>, case:<name>, commit:<sha>, cand:<id>) — no lesson without evidence.",
    };
  if (evidence.length > LIMITS.evidence)
    return { ok: false, error: `lesson.evidence cites ${evidence.length} refs; at most ${LIMITS.evidence}.` };
  const badRef = evidence.find((r) => !REF_RE.test(r));
  if (badRef !== undefined)
    return {
      ok: false,
      error: `Evidence ref "${badRef}" must be <kind>:<id> with no whitespace or comma (e.g. pr:5312, cand:c42).`,
    };
  return {
    ok: true,
    header: [
      "#lesson",
      `kind=${kind}`,
      `lens=${lens.join(",")}`,
      `class=${cls}`,
      `paths=${paths.join(",")}`,
      `evidence=${evidence.join(",")}`,
    ].join(" "),
  };
}

/**
 * The content of a lesson entry: the rendered header on the first line, the
 * author's prose after it. Refused when the target is not in `experiences/`
 * or the prose already opens with a header of its own — the header is the
 * tool's to write, so a hand-typed one can neither duplicate nor contradict
 * it.
 */
export function withLessonHeader(
  uri: string,
  content: unknown,
  lesson: unknown,
  known: readonly string[] = LESSON_LENS_IDS,
): { ok: true; content: string } | LessonHeaderError {
  if (!LESSON_URI_RE.test(uri))
    return {
      ok: false,
      error: `A lesson is written into experiences/ (viking://user/<user>/memories/experiences/<name>.md); got "${uri}".`,
    };
  const built = buildLessonHeader(lesson, known);
  if (!built.ok) return built;
  const prose = String(content ?? "").trim();
  if (prose === "") return { ok: false, error: "A lesson needs its one-sentence rule in `content`." };
  if (/^#lesson\b/i.test(prose) || /^#[a-z0-9-]+\s+kind=/i.test(prose))
    return {
      ok: false,
      error: "Leave the header out of `content` — the tool writes it from `lesson`. Start `content` with the lesson's prose.",
    };
  return { ok: true, content: `${built.header}\n\n${prose}` };
}

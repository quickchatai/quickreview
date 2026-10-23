// The loosened-test hint: a deterministic scan of the diff of TEST files for
// assertions the PR weakens. A prompt-only rule (`tests-loosened-is-behaviour`)
// rarely fires on its own, so the hits are computed here and handed to
// pass-tests as concrete candidates (dispatch.ts: the row's reason names each
// site). The lens decides whether a weakening hides a behaviour change; this
// only points.
// Pure, no I/O; reads only the patches the PR files carry.

import { parseHunkHeader } from "./hunkheader.js";
import { isTestFile, type PrFile } from "./heuristics.js";

export type LoosenedKind =
  | "exact-to-bound"
  | "exact-to-contains"
  | "tolerance-widened"
  | "count-lowered"
  | "bound-relaxed"
  | "timeout-lengthened"
  | "assert-removed"
  | "assert-commented"
  | "skip-added";

export interface LoosenedHit {
  file: string;
  /** Head line of the weakened assertion (the removed line's base line for a removal). */
  line: number;
  kind: LoosenedKind;
}

const ASSERT_RE =
  /\b(assert\w*|expect|should|require\.\w+|t\.(Error|Fatal|Fail)\w*|XCTAssert\w*|assert_eq!|assert_ne!|assert!|verify|check)\b|\.(toBe|toEqual|toStrictEqual|toHaveLength|toHaveBeenCalledTimes|toMatch|toContain|toThrow)\b/;
// `assert_eq!` ends in a non-word character, so it sits outside the `\b…\b`
// group: a trailing `\b` between `!` and `(` never matches.
const EXACT_RE =
  /==|\bassert_eq!|\b(assertEqual|assertEquals|toBe|toEqual|toStrictEqual|toHaveLength|toHaveBeenCalledTimes|XCTAssertEqual|Equal|Equals|is)\b/;
/** Named lower-bound matchers: lowering their N relaxes them. */
const LOWER_NAMED =
  "assertGreater\\w*|toBeGreaterThan\\w*|XCTAssertGreaterThan\\w*|GreaterOrEqual|atLeast";
/** Named upper-bound matchers: raising their N relaxes them. */
const UPPER_NAMED = "assertLess\\w*|toBeLessThan\\w*|XCTAssertLessThan\\w*|LessOrEqual|atMost";
const BOUND_RE = new RegExp(`>=|<=|(?<![=!<>])[<>](?!=)|\\b(${LOWER_NAMED}|${UPPER_NAMED})\\b`);
const CONTAINS_RE =
  /\b(assertIn|assertContains|toContain|toMatch|stringContaining|objectContaining|arrayContaining|Contains|contains|includes|startswith|endswith|startsWith|endsWith|XCTAssertTrue)\b|\bin\b/;
const TOLERANCE_RE =
  /\b(tol|tolerance|delta|places|epsilon|eps|atol|rtol|approx|abs_tol|rel_tol|within|closeTo|toBeCloseTo|accuracy|margin|decimal|numDigits)\b/i;
/** A PRECISION argument (digits or places to agree on): unlike a tolerance,
 * LOWERING it is what loosens the check. */
const PRECISION_RE = /\b(places|decimal|numDigits|toBeCloseTo)\b/i;
const TIMEOUT_RE =
  /\b(timeout|time_out|sleep|wait|deadline|retries|retry|attempts|max_wait|waitFor|patience)\w*\b/i;
const COUNT_RE =
  /\b(len|length|count|size|toHaveLength|toHaveBeenCalledTimes|Times|call_count|assert_called\w*)\b/;
const SKIP_RE =
  /@pytest\.mark\.(skip|xfail)|pytest\.(skip|xfail)\(|@unittest\.skip|\bt\.Skip(f|Now)?\(|\b(it|test|describe)\.(skip|todo)\(|\bx(it|describe|test)\(|@(Ignore|Disabled)\b|#\[ignore\]|\bXCTSkip\w*|\.skip\(|@skip\b|\bpending\(/;
const CHECK_OP_RE = /==|!=|>=|<=/;
/** `x >= N` / `x > N` / `assertGreater…` / `toBeGreaterThan…`: lowering N relaxes it. */
const LOWER_BOUND_RE = new RegExp(`>=?\\s*-?\\d|\\b(${LOWER_NAMED})\\b`);
/** `x <= N` / `x < N` / `assertLess…` / `toBeLessThan…`: raising N relaxes it. */
const UPPER_BOUND_RE = new RegExp(`<=?\\s*-?\\d|\\b(${UPPER_NAMED})\\b`);
const isCheck = (s: string): boolean => ASSERT_RE.test(s) || CHECK_OP_RE.test(s);
const COMMENT_PREFIX_RE = /^\s*(#|\/\/|\/\*|\*|--)\s*/;

/** A number literal, as both the extraction and the shape mask read it. */
const NUMBER_RE = /-?\d+(\.\d+)?(e-?\d+)?/gi;
const nums = (s: string): number[] => (s.match(NUMBER_RE) ?? []).map(Number);
const norm = (s: string): string => s.replace(/\s+/g, " ").trim();
/** The line with every number masked: two lines that differ only in numbers match. */
const shape = (s: string): string => norm(s).replace(NUMBER_RE, "#");

function numberGrew(oldL: string, newL: string): boolean | null {
  const a = nums(oldL);
  const b = nums(newL);
  if (a.length === 0 || a.length !== b.length) return null;
  let grew = false;
  for (let i = 0; i < a.length; i++) {
    if (b[i]! < a[i]!) return false;
    if (b[i]! > a[i]!) grew = true;
  }
  return grew;
}

interface Hunk {
  removed: { text: string; line: number }[];
  added: { text: string; line: number }[];
}

function hunks(patch: string): Hunk[] {
  const out: Hunk[] = [];
  let cur: Hunk | null = null;
  let oldLn = 0;
  let newLn = 0;
  for (const raw of patch.split("\n")) {
    const h = parseHunkHeader(raw);
    if (h) {
      cur = { removed: [], added: [] };
      out.push(cur);
      oldLn = h.old_start;
      newLn = h.new_start;
      continue;
    }
    // Inside a hunk every line is content: a removed `--x` arrives as `---x`.
    if (!cur || raw.startsWith("\\")) continue;
    if (raw.startsWith("-")) cur.removed.push({ text: raw.slice(1), line: oldLn++ });
    else if (raw.startsWith("+")) cur.added.push({ text: raw.slice(1), line: newLn++ });
    else {
      oldLn++;
      newLn++;
    }
  }
  return out;
}

/** Every weakened assertion in the PR's test files, in diff order. */
export function detectLoosenedAssertions(files: readonly PrFile[]): LoosenedHit[] {
  const hits: LoosenedHit[] = [];
  for (const f of files) {
    if (!isTestFile(f.filename) || !f.patch) continue;
    for (const h of hunks(f.patch)) {
      const usedAdded = new Set<number>();
      const unchanged = new Set<number>();
      const commented = new Map<number, { text: string; line: number }>();
      for (const [ri, r] of h.removed.entries()) {
        const ai = h.added.findIndex((a, i) => !usedAdded.has(i) && norm(a.text) === norm(r.text));
        if (ai >= 0) {
          unchanged.add(ri);
          usedAdded.add(ai);
        }
      }
      for (const [ri, r] of h.removed.entries()) {
        if (unchanged.has(ri) || !isCheck(r.text)) continue;
        const ai = h.added.findIndex(
          (a, i) =>
            !usedAdded.has(i) &&
            COMMENT_PREFIX_RE.test(a.text) &&
            norm(a.text.replace(COMMENT_PREFIX_RE, "")) === norm(r.text),
        );
        if (ai >= 0) {
          commented.set(ri, h.added[ai]!);
          usedAdded.add(ai);
        }
      }
      for (const [ri, r] of h.removed.entries()) {
        if (unchanged.has(ri)) continue;
        if (norm(r.text) === "") continue;
        // in a test file a comparison is a check whether or not an assert keyword wraps it
        const isAssert = isCheck(r.text);
        const comment = commented.get(ri);
        if (comment) {
          hits.push({ file: f.filename, line: comment.line, kind: "assert-commented" });
          continue;
        }
        // its counterpart: the first unused added line of the same shape, or
        // (for an assertion) the first unused added assertion
        let ai = h.added.findIndex(
          (a, i) =>
            !usedAdded.has(i) && shape(a.text) === shape(r.text) && norm(a.text) !== norm(r.text),
        );
        if (ai < 0 && isAssert)
          ai = h.added.findIndex(
            (a, i) => !usedAdded.has(i) && isCheck(a.text) && norm(a.text) !== norm(r.text),
          );
        const a = ai >= 0 ? h.added[ai]! : undefined;
        if (a) usedAdded.add(ai);
        if (a && shape(a.text) === shape(r.text)) {
          const grew = numberGrew(r.text, a.text);
          const shrank = numberGrew(a.text, r.text);
          const loosened = PRECISION_RE.test(r.text) ? shrank : grew;
          if (loosened === true && TOLERANCE_RE.test(r.text))
            hits.push({ file: f.filename, line: a.line, kind: "tolerance-widened" });
          else if (grew === true && TIMEOUT_RE.test(r.text))
            hits.push({ file: f.filename, line: a.line, kind: "timeout-lengthened" });
          else if (shrank === true && LOWER_BOUND_RE.test(r.text))
            hits.push({ file: f.filename, line: a.line, kind: "bound-relaxed" });
          else if (grew === true && UPPER_BOUND_RE.test(r.text) && !LOWER_BOUND_RE.test(r.text))
            hits.push({ file: f.filename, line: a.line, kind: "bound-relaxed" });
          // a lowered UPPER bound is a tightening, not a lowered count
          else if (
            shrank === true &&
            isAssert &&
            COUNT_RE.test(r.text) &&
            !(UPPER_BOUND_RE.test(r.text) && !LOWER_BOUND_RE.test(r.text))
          )
            hits.push({ file: f.filename, line: a.line, kind: "count-lowered" });
          continue;
        }
        if (isAssert && a) {
          if (EXACT_RE.test(r.text) && BOUND_RE.test(a.text) && !BOUND_RE.test(r.text))
            hits.push({ file: f.filename, line: a.line, kind: "exact-to-bound" });
          else if (EXACT_RE.test(r.text) && CONTAINS_RE.test(a.text) && !CONTAINS_RE.test(r.text))
            hits.push({ file: f.filename, line: a.line, kind: "exact-to-contains" });
          continue;
        }
        // only an UNUSED added check can stand in for this one: an addition
        // another removal already paired with does not
        if (isAssert && !a && !h.added.some((x, i) => !usedAdded.has(i) && isCheck(x.text)))
          hits.push({ file: f.filename, line: r.line, kind: "assert-removed" });
      }
      for (const a of h.added) {
        if (SKIP_RE.test(a.text) && !h.removed.some((r) => norm(r.text) === norm(a.text)))
          hits.push({ file: f.filename, line: a.line, kind: "skip-added" });
      }
    }
  }
  return hits;
}

const KIND_TEXT: Record<LoosenedKind, string> = {
  "exact-to-bound": "an exact check became a bound",
  "exact-to-contains": "an exact check became a contains/match",
  "tolerance-widened": "a tolerance was widened",
  "count-lowered": "an expected count was lowered",
  "bound-relaxed": "a lower bound was lowered or an upper bound raised",
  "timeout-lengthened": "a timeout, wait or retry was lengthened",
  "assert-removed": "an assertion was removed",
  "assert-commented": "an assertion was commented out",
  "skip-added": "a skip or expected-failure was added",
};

/** The plan reason that hands the hits to pass-tests (at most `max` sites named). */
export function loosenedReason(hits: readonly LoosenedHit[], max = 12): string {
  const sites = hits.slice(0, max).map((h) => `${h.file}:${h.line} (${KIND_TEXT[h.kind]})`);
  const more = hits.length > max ? `; and ${hits.length - max} more` : "";
  return (
    `these hunks weaken existing test assertions — ${sites.join("; ")}${more}. ` +
    "For each, decide whether the weakening hides a behaviour change in the production code; when it does, report THAT change at the production line, with the weakened assertion as evidence"
  );
}

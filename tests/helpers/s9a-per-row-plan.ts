// The per-row find planner, kept verbatim as the reference the two-find
// planner's equivalence test compares against: one `/search/find` per distinct
// plan-row query inside `experiences/` (20 hits each), the main session's
// cases find first (40), the one addable find last (40), at most 24 finds a
// round — the rows past the cap left unasked (`find_cap`).
//
// src/memory/selection.ts plans TWO finds a round instead (the cases, and one
// lesson find sized to the whole corpus), because per-row finds mostly did not
// answer inside the 2 s budget. The selection (`selectRound`) is the same for
// both: it takes any plan, each row's
// answer by its `rowKey`. So this planner also serves the selectRound unit
// tests that give each row an answer of its own.
import { roundContextQuery } from "../../src/memory/context.js";
import { CASES_AREA, EXPERIENCES_AREA } from "../../src/memory/layout.js";
import {
  casesQuery,
  type FindPlan,
  type PlannedFind,
  type SelectionRow,
} from "../../src/memory/selection.js";

export const S9A_LIMITS = Object.freeze({ lessons: 20, cases: 40, addable: 40 });
export const S9A_MAX_FINDS_PER_ROUND = 24;

const QUERY_MAX_CHARS = 600;

/** The per-row query: the PR title, the shape of the row's files, the lens. */
export function s9aRowQuery(input: { title: string; lens: string; files: readonly string[] }): string {
  const base = roundContextQuery({
    title: input.title,
    files: input.files.map((filename) => ({ filename })),
  });
  const lensWord = input.lens.replace(/^pass-/, "");
  return [base, lensWord].filter((p) => p !== "").join(" — ").slice(0, QUERY_MAX_CHARS);
}

export function s9aPlanFinds(input: {
  title: string;
  rows: readonly SelectionRow[];
  prFiles: readonly string[];
  addable?: readonly string[];
}): FindPlan {
  const finds: PlannedFind[] = [];
  const rowKey = new Map<number, string>();
  const seen = new Set<string>();
  const add = (area: PlannedFind["area"], query: string, limit: number): string | null => {
    const key = `${area}\u0000${query}`;
    if (seen.has(key)) return key;
    if (finds.length >= S9A_MAX_FINDS_PER_ROUND) return null;
    seen.add(key);
    finds.push({ key, area, query, limit });
    return key;
  };
  const casesKey =
    input.prFiles.length > 0
      ? add(CASES_AREA, casesQuery({ title: input.title, files: input.prFiles }), S9A_LIMITS.cases)
      : null;
  for (const r of input.rows) {
    const files = r.focus && r.focus.length > 0 ? r.focus : input.prFiles;
    const key = add(
      EXPERIENCES_AREA,
      s9aRowQuery({ title: input.title, lens: r.lens, files }),
      S9A_LIMITS.lessons,
    );
    if (key !== null) rowKey.set(r.row, key);
  }
  const addableKey =
    (input.addable ?? []).length > 0
      ? add(
          EXPERIENCES_AREA,
          s9aRowQuery({ title: input.title, lens: "", files: input.prFiles }),
          S9A_LIMITS.addable,
        )
      : null;
  return { finds, rowKey, casesKey, addableKey };
}

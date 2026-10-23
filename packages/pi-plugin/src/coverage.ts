// Per-file coverage check (`[review] coverage_check`): after the planned
// lenses return, every changed NON-test source file
// that no lens raised a finding on is a file nobody looked at closely enough
// to say anything — the shape of the high-severity miss where a changed file
// got no finding from any lens at all. The round then launches pass-sweep
// once per group of such files (at most COVERAGE_MAX_GROUPS rows, packed by
// the sweep's line budget), each row carrying the reason
// `coverage: no lens addressed <files>`.
//
// A file also counts as addressed when a RETURNED pass-sweep row had it in
// its focus list, NONE answers included: that row read every changed line
// of the file at the sweep's tier, so a coverage row over it would re-read
// the same lines for nothing.
// The check stays total: a row that failed, errored or was cut short is not
// "returned" and its focus counts for nothing, so a coverage row fires only
// for files no returned row read — the files past the per-round sweep cap
// and those of a failed row. A pass-behaviour-delta row does NOT count, though
// it carries `focus` too: that lens reads only modified, replaced and deleted
// hunks ("pure additions are not yours"), so a file past the sweep cap with new
// code in it would lose its only line-by-line read.
//
// Pure, and on the code path both routes share: dispatch puts the eligible
// files on the round order, the `coverage_gaps` tool
// (packages/pi-plugin/extensions/finding-clusters.ts) answers the uncovered groups.

import {
  CODE_FILE_RE,
  isSweepSkipped,
  isTestFile,
  SWEEP_MAX_LINES_PER_GROUP,
  type PrFile,
} from "./heuristics.js";
import { packByBudget } from "./packing.js";

/** At most this many coverage rows per round. */
export const COVERAGE_MAX_GROUPS = 2;
/** Changed lines per coverage row (the sweep's own group budget). */
export const COVERAGE_GROUP_LINES = SWEEP_MAX_LINES_PER_GROUP;

export interface CoverageFile {
  path: string;
  /** Changed lines (additions + deletions). */
  lines: number;
}

/** The files the check holds the round to: changed (not removed, at least
 * one added line), source code by extension, not a test, not generated /
 * lock / vendored / binary / prose (the sweep's skip list). */
export function coverageEligible(files: readonly PrFile[]): CoverageFile[] {
  return files
    .filter(
      (f) =>
        f.status !== "removed" &&
        f.additions > 0 &&
        CODE_FILE_RE.test(f.filename) &&
        !isTestFile(f.filename) &&
        !isSweepSkipped(f.filename),
    )
    .map((f) => ({ path: f.filename, lines: f.additions + f.deletions }));
}

/** The eligible paths `addressed` names. A name that is itself an eligible
 * path names that path alone. Any other name is either a repo-relative tail
 * (lenses often cite one), naming every eligible path that ends with it at a
 * `/` boundary, or a path with a prefix of its own (a worktree's absolute
 * path), naming the LONGEST eligible path it ends with — never also a
 * shorter eligible path that happens to be its tail. */
function addressedPaths(
  eligible: readonly CoverageFile[],
  addressed: ReadonlySet<string>,
): Set<string> {
  const paths = new Set(eligible.map((f) => f.path));
  const out = new Set<string>();
  for (const a of addressed) {
    if (paths.has(a)) {
      out.add(a);
      continue;
    }
    let longest: string | undefined;
    for (const p of paths) {
      if (p.endsWith(`/${a}`)) out.add(p);
      else if (a.endsWith(`/${p}`) && (longest === undefined || p.length > longest.length))
        longest = p;
    }
    if (longest !== undefined) out.add(longest);
  }
  return out;
}

export interface CoverageGaps {
  /** Eligible files no lens addressed and no returned sweep row had in
   * focus, in the order given. */
  uncovered: string[];
  /** The coverage rows to launch: at most COVERAGE_MAX_GROUPS. */
  groups: string[][];
  /** Uncovered files past the last row — listed so the gap is never silent. */
  unchecked: string[];
}

/**
 * The uncovered files and the rows that cover them: greedy in the given
 * order, a row closes when the next file would push it past `maxLines`
 * (a single file larger than the budget gets a row of its own).
 */
export function coverageGaps(
  eligible: readonly CoverageFile[],
  addressed: Iterable<string>,
  maxGroups: number = COVERAGE_MAX_GROUPS,
  maxLines: number = COVERAGE_GROUP_LINES,
  swept: Iterable<string> = [],
): CoverageGaps {
  const seen = new Set(
    [...addressed, ...swept].map((a) => a.trim().replace(/^\.?\//, "")).filter(Boolean),
  );
  const covered = addressedPaths(eligible, seen);
  const uncovered = eligible.filter((f) => !covered.has(f.path));
  const { groups, left: unchecked } = packByBudget(
    uncovered,
    { maxGroups, maxLines },
    (file) => file.path,
    (file) => file.lines,
  );
  return { uncovered: uncovered.map((f) => f.path), groups, unchecked };
}

/** The plan reason a coverage row carries. */
export function coverageReason(files: readonly string[]): string {
  return `coverage: no lens addressed ${files.join(", ")}`;
}

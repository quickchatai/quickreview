// The unified-diff hunk header, `@@ -a[,b] +c[,d] @@`, decoded once for every
// patch reader (outcome capture, the learner's recall scan, the follow-up
// delta and posting anchors). The readers keep their own body policies; the
// header grammar and its omitted-count rule live here. Pure: no I/O.

/** One hunk header: each side's first line and line count (an omitted count
 * is 1; a count of 0 is an empty side — a pure insertion or deletion). */
export interface HunkHeader {
  old_start: number;
  old_count: number;
  new_start: number;
  new_count: number;
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The hunk header `line` starts with, or null when it is not one. */
export function parseHunkHeader(line: string): HunkHeader | null {
  const m = HUNK_HEADER_RE.exec(line);
  if (!m) return null;
  return {
    old_start: Number(m[1]),
    old_count: m[2] === undefined ? 1 : Number(m[2]),
    new_start: Number(m[3]),
    new_count: m[4] === undefined ? 1 : Number(m[4]),
  };
}

// Inline-comment anchor validation (ported discipline, §3: "each
// claimed range must lie completely within one changed-line run in one hunk on
// the exact claimed path and side").
//
// GitHub rejects the *whole* review call when a single inline comment fails to
// anchor, so every comment is validated here first and anything invalid is
// stripped into the summary-body overflow instead — never a failed post.
//
// Input is the unified patch text GitHub returns per file in the PR files API
// (`patch` field). Pure module: no I/O.

export type Side = "RIGHT" | "LEFT";

export interface ChangedRun {
  side: Side;
  /** First and last line number of the run, in the file version for `side`. */
  start: number;
  end: number;
  /** 0-based index of the hunk this run belongs to (runs never span hunks). */
  hunk: number;
}

export interface AnchorRequest {
  path: string;
  side: Side;
  /** Last line of the anchored range (GitHub's `line`). */
  line: number;
  /** First line of a multi-line anchor (GitHub's `start_line`); optional. */
  start_line?: number;
}

/**
 * Changed-line runs of one file's unified patch.
 *
 * A run is a maximal sequence of consecutive changed lines on one side inside
 * one hunk. Context lines (` `) end a run on both sides. A `-` line does not
 * advance the RIGHT line counter (and a `+` does not advance LEFT), so a
 * `+ / - / +` sequence stays one RIGHT run — the line numbers are contiguous.
 */
export function changedRuns(patch: string): ChangedRun[] {
  const runs: ChangedRun[] = [];
  let hunk = -1;
  let oldLine = 0;
  let newLine = 0;
  const open: Partial<Record<Side, ChangedRun>> = {};

  const close = (side?: Side) => {
    for (const s of side ? [side] : (["RIGHT", "LEFT"] as Side[])) {
      const run = open[s];
      if (run) {
        runs.push(run);
        delete open[s];
      }
    }
  };
  const extend = (side: Side, line: number) => {
    const run = open[side];
    if (run && run.end + 1 === line) {
      run.end = line;
      return;
    }
    close(side);
    open[side] = { side, start: line, end: line, hunk };
  };

  for (const raw of patch.split("\n")) {
    if (raw.startsWith("@@")) {
      close();
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
      if (!m) continue;
      hunk += 1;
      oldLine = Number(m[1]);
      newLine = Number(m[3]);
      continue;
    }
    if (hunk < 0) continue; // preamble (diff --git / index / --- / +++)
    if (raw.startsWith("\\")) continue; // "\ No newline at end of file"
    const marker = raw.length === 0 ? " " : raw[0];
    if (marker === "+") {
      extend("RIGHT", newLine);
      newLine += 1;
    } else if (marker === "-") {
      extend("LEFT", oldLine);
      oldLine += 1;
    } else if (marker === " ") {
      close();
      oldLine += 1;
      newLine += 1;
    } else {
      // Unknown line shape (e.g. a truncated patch): be conservative.
      close();
    }
  }
  close();
  // Deterministic order: by hunk, then start line, then LEFT before RIGHT.
  const sideRank = (s: Side) => (s === "LEFT" ? 0 : 1);
  return runs.sort(
    (a, b) => a.hunk - b.hunk || a.start - b.start || sideRank(a.side) - sideRank(b.side),
  );
}

/** All changed runs of a PR, keyed by file path. */
export function runsByPath(patches: Record<string, string>): Record<string, ChangedRun[]> {
  const out: Record<string, ChangedRun[]> = {};
  for (const [path, patch] of Object.entries(patches)) out[path] = changedRuns(patch);
  return out;
}

export interface AnchorCheck {
  ok: boolean;
  reason?: "unknown-path" | "no-runs" | "outside-changed-run" | "inverted-range";
  run?: ChangedRun;
}

/** Validate one anchor against the runs of its claimed path. */
export function checkAnchor(runs: Record<string, ChangedRun[]>, req: AnchorRequest): AnchorCheck {
  const fileRuns = runs[req.path];
  if (!fileRuns) return { ok: false, reason: "unknown-path" };
  if (fileRuns.length === 0) return { ok: false, reason: "no-runs" };
  const end = req.line;
  const start = req.start_line ?? req.line;
  if (start > end) return { ok: false, reason: "inverted-range" };
  const run = fileRuns.find((r) => r.side === req.side && start >= r.start && end <= r.end);
  return run ? { ok: true, run } : { ok: false, reason: "outside-changed-run" };
}

export interface AnchorPartition<T extends AnchorRequest> {
  accepted: T[];
  rejected: Array<{ comment: T; reason: NonNullable<AnchorCheck["reason"]> }>;
}

/**
 * Split inline comments into those that anchor cleanly and those that must be
 * stripped into the body. Never throws — an unparseable/absent patch simply
 * means the comment cannot be anchored.
 */
export function partitionByAnchor<T extends AnchorRequest>(
  comments: T[],
  patches: Record<string, string>,
): AnchorPartition<T> {
  const runs = runsByPath(patches);
  const accepted: T[] = [];
  const rejected: AnchorPartition<T>["rejected"] = [];
  for (const c of comments) {
    const check = checkAnchor(runs, c);
    if (check.ok) accepted.push(c);
    else rejected.push({ comment: c, reason: check.reason ?? "outside-changed-run" });
  }
  return { accepted, rejected };
}

export const ANCHOR_REASON_TEXT: Record<NonNullable<AnchorCheck["reason"]>, string> = {
  "unknown-path": "path is not in this PR's diff",
  "no-runs": "file has no changed lines in this PR",
  "outside-changed-run": "line is outside any changed-line run on that side",
  "inverted-range": "start_line is after line",
};

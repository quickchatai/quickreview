import { describe, expect, it } from "vitest";
import { changedRuns, checkAnchor, partitionByAnchor, runsByPath } from "../src/anchors.js";

// A realistic two-hunk patch as GitHub returns it in the files API.
const PATCH = `@@ -10,7 +10,9 @@ def handler(request):
     ctx = build_context(request)
-    old_line_a
-    old_line_b
+    new_line_a
+    new_line_b
+    new_line_c
     return ctx

 def other():
@@ -40,6 +42,7 @@ def other():
     x = 1
     y = 2
+    z = 3
     return x + y`;

describe("changedRuns", () => {
  it("derives RIGHT and LEFT runs with correct line numbers", () => {
    const runs = changedRuns(PATCH);
    expect(runs).toEqual([
      { side: "LEFT", start: 11, end: 12, hunk: 0 },
      { side: "RIGHT", start: 11, end: 13, hunk: 0 },
      { side: "RIGHT", start: 44, end: 44, hunk: 1 },
    ]);
  });

  it("keeps runs inside one hunk — a new hunk always starts a new run", () => {
    const runs = changedRuns(`@@ -1,2 +1,2 @@\n+a\n b\n@@ -5,2 +5,2 @@\n+c\n d`);
    expect(runs).toEqual([
      { side: "RIGHT", start: 1, end: 1, hunk: 0 },
      { side: "RIGHT", start: 5, end: 5, hunk: 1 },
    ]);
  });

  it("treats +/-/+ as one contiguous RIGHT run (a '-' does not advance RIGHT)", () => {
    const runs = changedRuns(`@@ -1,3 +1,3 @@\n+a\n-gone\n+b\n c`);
    expect(runs.filter((r) => r.side === "RIGHT")).toEqual([
      { side: "RIGHT", start: 1, end: 2, hunk: 0 },
    ]);
    expect(runs.filter((r) => r.side === "LEFT")).toEqual([
      { side: "LEFT", start: 1, end: 1, hunk: 0 },
    ]);
  });

  it("breaks a run on a context line", () => {
    const runs = changedRuns(`@@ -1,5 +1,5 @@\n+a\n ctx\n+b`);
    expect(runs).toEqual([
      { side: "RIGHT", start: 1, end: 1, hunk: 0 },
      { side: "RIGHT", start: 3, end: 3, hunk: 0 },
    ]);
  });

  it("ignores the diff preamble and the no-newline marker", () => {
    const runs = changedRuns(
      `diff --git a/f b/f\nindex 1..2 100644\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file`,
    );
    expect(runs).toEqual([
      { side: "LEFT", start: 1, end: 1, hunk: 0 },
      { side: "RIGHT", start: 1, end: 1, hunk: 0 },
    ]);
  });

  it("returns nothing for an empty or headerless patch", () => {
    expect(changedRuns("")).toEqual([]);
    expect(changedRuns("no hunks here")).toEqual([]);
  });
});

describe("checkAnchor", () => {
  const runs = runsByPath({ "a.py": PATCH });

  it("accepts a single line inside a run", () => {
    expect(checkAnchor(runs, { path: "a.py", side: "RIGHT", line: 12 }).ok).toBe(true);
  });

  it("accepts a multi-line range fully inside one run", () => {
    expect(checkAnchor(runs, { path: "a.py", side: "RIGHT", line: 13, start_line: 11 }).ok).toBe(
      true,
    );
  });

  it("rejects a range that spills outside the run", () => {
    const check = checkAnchor(runs, { path: "a.py", side: "RIGHT", line: 14, start_line: 12 });
    expect(check).toEqual({ ok: false, reason: "outside-changed-run" });
  });

  it("rejects a range that spans two runs", () => {
    expect(checkAnchor(runs, { path: "a.py", side: "RIGHT", line: 44, start_line: 11 }).ok).toBe(
      false,
    );
  });

  it("is side-sensitive", () => {
    expect(checkAnchor(runs, { path: "a.py", side: "LEFT", line: 11 }).ok).toBe(true);
    expect(checkAnchor(runs, { path: "a.py", side: "LEFT", line: 13 }).ok).toBe(false);
    expect(checkAnchor(runs, { path: "a.py", side: "RIGHT", line: 42 }).ok).toBe(false);
  });

  it("rejects a path that is not in the diff", () => {
    expect(checkAnchor(runs, { path: "other.py", side: "RIGHT", line: 1 })).toEqual({
      ok: false,
      reason: "unknown-path",
    });
  });

  it("rejects a file with no changed lines", () => {
    expect(
      checkAnchor(runsByPath({ "b.py": "" }), { path: "b.py", side: "RIGHT", line: 1 }),
    ).toEqual({
      ok: false,
      reason: "no-runs",
    });
  });

  it("rejects an inverted range", () => {
    expect(checkAnchor(runs, { path: "a.py", side: "RIGHT", line: 11, start_line: 13 })).toEqual({
      ok: false,
      reason: "inverted-range",
    });
  });
});

describe("partitionByAnchor", () => {
  it("splits valid from invalid without throwing", () => {
    const comments = [
      { path: "a.py", side: "RIGHT" as const, line: 12, id: "ok" },
      { path: "a.py", side: "RIGHT" as const, line: 99, id: "out" },
      { path: "gone.py", side: "RIGHT" as const, line: 1, id: "nopath" },
      { path: "a.py", side: "RIGHT" as const, line: 44, id: "hunk2" },
    ];
    const { accepted, rejected } = partitionByAnchor(comments, { "a.py": PATCH });
    expect(accepted.map((c) => c.id)).toEqual(["ok", "hunk2"]);
    expect(rejected.map((r) => [r.comment.id, r.reason])).toEqual([
      ["out", "outside-changed-run"],
      ["nopath", "unknown-path"],
    ]);
  });

  it("rejects everything when no patches are known, rather than failing", () => {
    const { accepted, rejected } = partitionByAnchor(
      [{ path: "a.py", side: "RIGHT" as const, line: 1 }],
      {},
    );
    expect(accepted).toHaveLength(0);
    expect(rejected).toHaveLength(1);
  });
});

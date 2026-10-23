// The unified-diff reader behind `qcr review --diff` (packages/pi-plugin/src/diffinput.ts):
// files, statuses and changed-line counts from what git and diff -u print.
// Pure text in, no repository needed.

import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "@quickchatai/pi-quickreview/src/diffinput.js";

const gitDiff = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,4 @@",
  " one",
  "-two",
  "+two!",
  "+three",
  " four",
  "diff --git a/src/new.ts b/src/new.ts",
  "new file mode 100644",
  "index 0000000..3333333",
  "--- /dev/null",
  "+++ b/src/new.ts",
  "@@ -0,0 +1,2 @@",
  "+x",
  "+y",
  "diff --git a/old.txt b/old.txt",
  "deleted file mode 100644",
  "index 4444444..0000000",
  "--- a/old.txt",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-gone",
  "",
].join("\n");

describe("parseUnifiedDiff", () => {
  it("reads a git diff: paths, statuses and counts, with each file's own patch", () => {
    const { files, lines } = parseUnifiedDiff(gitDiff);
    expect(files.map((f) => [f.filename, f.status, f.additions, f.deletions])).toEqual([
      ["src/a.ts", "modified", 2, 1],
      ["src/new.ts", "added", 2, 0],
      ["old.txt", "removed", 0, 1],
    ]);
    expect(lines).toBe(3 + 2 + 1);
    expect(files[0]!.patch).toMatch(/^diff --git a\/src\/a.ts/);
    expect(files[0]!.patch).not.toContain("new.ts");
    expect(files[0]!.patch!.endsWith(" four\n")).toBe(true);
  });

  it("counts a removed line that starts with -- as content, not a header", () => {
    const { files } = parseUnifiedDiff(
      [
        "diff --git a/s.sql b/s.sql",
        "--- a/s.sql",
        "+++ b/s.sql",
        "@@ -1,2 +1,2 @@",
        "--- a comment",
        "+-- another comment",
        " select 1;",
        "",
      ].join("\n"),
    );
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ filename: "s.sql", additions: 1, deletions: 1 });
  });

  it("reads a plain diff -u of two files, stripping timestamps", () => {
    const { files } = parseUnifiedDiff(
      [
        "--- a/x.py\t2026-01-01 10:00:00",
        "+++ b/x.py\t2026-01-02 10:00:00",
        "@@ -1 +1 @@",
        "-a",
        "+b",
        "--- a/y.py\t2026-01-01 10:00:00",
        "+++ b/y.py\t2026-01-02 10:00:00",
        "@@ -1,0 +2 @@",
        "+c",
        "",
      ].join("\n"),
    );
    expect(files.map((f) => [f.filename, f.additions, f.deletions])).toEqual([
      ["x.py", 1, 1],
      ["y.py", 1, 0],
    ]);
  });

  it("reads renames, binaries, quoted paths and drops a format-patch signature", () => {
    const { files } = parseUnifiedDiff(
      [
        "diff --git a/a.ts b/b.ts",
        "similarity index 100%",
        "rename from a.ts",
        "rename to b.ts",
        "diff --git a/img.png b/img.png",
        "index 1..2 100644",
        "Binary files a/img.png and b/img.png differ",
        'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"',
        '--- "a/caf\\303\\251.txt"',
        '+++ "b/caf\\303\\251.txt"',
        "@@ -1 +1 @@",
        "-a",
        "+b",
        "-- ",
        "2.40.0",
        "",
      ].join("\n"),
    );
    expect(files[0]).toMatchObject({
      filename: "b.ts",
      status: "renamed",
      previous_filename: "a.ts",
    });
    expect(files[1]).toMatchObject({ filename: "img.png", additions: 0, deletions: 0 });
    expect(files[1]!.patch).toBeUndefined();
    expect(files[2]!.filename).toBe("café.txt");
    expect(files[2]!.patch).not.toContain("2.40.0");
  });

  it("finds nothing in text that is not a diff", () => {
    expect(parseUnifiedDiff("hello\nworld\n")).toEqual({ files: [], lines: 0 });
    expect(parseUnifiedDiff("")).toEqual({ files: [], lines: 0 });
  });

  it("decodes every git escape and whole code points in a quoted header", () => {
    const diff = [
      '--- "a/a\\rb\\a\\b\\v\\f.ts"',
      '+++ "b/a\\rb\\a\\b\\v\\f\\t\u{1F600}.ts"',
      "@@ -1 +1 @@",
      "-x",
      "+y",
      "",
    ].join("\n");
    expect(parseUnifiedDiff(diff).files[0]!.filename).toBe("a\rb\x07\b\v\f\t\u{1F600}.ts");
  });

  it("keeps trailing spaces of a filename before git's separator tab", () => {
    const diff = ["--- a/report \t", "+++ b/report \t", "@@ -1 +1 @@", "-x", "+y", ""].join("\n");
    expect(parseUnifiedDiff(diff).files[0]!.filename).toBe("report ");
  });
});

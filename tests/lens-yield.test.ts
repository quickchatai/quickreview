// bench/aacr/lens_yield.py counts per ROOT CAUSE (merge group), so "posted"
// can never exceed "raised" and a lens has one unique count (FREEZE-ANALYSIS
// B, 2026-10-03: the per-trailer count gave pass-abstraction 6 and 2).
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const LY = join(import.meta.dirname, "..", "bench", "aacr");

function py(code: string, ...args: string[]): unknown {
  const out = execFileSync("python3", ["-c", `import sys, json; sys.path.insert(0, ${JSON.stringify(LY)}); import lens_yield as ly\n${code}`, ...args]);
  return JSON.parse(out.toString());
}

function caseDir(findings: unknown[]): string {
  const d = join(mkdtempSync(join(tmpdir(), "ly-")), "case");
  mkdirSync(d);
  writeFileSync(join(d, "findings-record.json"), JSON.stringify({ findings }));
  return d;
}

describe("lens_yield: merge groups", () => {
  it("folds old-format merges ('MERGED x into F1') and new merged_into into their lead; raisers are the union", () => {
    const d = caseDir([
      { id: "F1", path: "a.py", line: "10", lens: "pass-baseline", disposition: "posted" },
      { id: "t-1", path: "a.py", line: "10", lens: "pass-tests", disposition: "merged", reason: "MERGED t-1 into F1: same" },
      { id: "s-1", path: "a.py", line: "40", lens: "pass-sweep", disposition: "merged", merged_into: "F1" },
      { id: "F2", path: "b.py", line: "5", lens: "pass-abstraction", disposition: "posted" },
      { id: "F3", path: "c.py", line: "1", lens: "pass-style", disposition: "killed" },
    ]);
    const g = py(
      "print(json.dumps(sorted([sorted(x['raisers']), x['posted']] for x in ly.case_groups(__import__('pathlib').Path(sys.argv[1])))))",
      d,
    );
    expect(g).toEqual([
      [["pass-abstraction"], true],
      [["pass-baseline", "pass-sweep", "pass-tests"], true],
      [["pass-style"], false],
    ]);
  });

  it("a merge with no pointer joins the lead on the same path within 3 lines", () => {
    const d = caseDir([
      { id: "F1", path: "a.py", line: "10", lens: "pass-baseline", disposition: "posted" },
      { id: "x", path: "a.py", line: "12", lens: "pass-consistency", disposition: "merged", reason: "same thing" },
    ]);
    const g = py("print(json.dumps([sorted(x['raisers']) for x in ly.case_groups(__import__('pathlib').Path(sys.argv[1]))]))", d);
    expect(g).toEqual([["pass-baseline", "pass-consistency"]]);
  });

  it("a comment credits its group once; a corroborated group is not unique to any lens; posted never exceeds raised", () => {
    const d = caseDir([
      { id: "F1", path: "a.py", line: "10", lens: "pass-baseline", disposition: "posted" },
      { id: "t-1", path: "a.py", line: "10", lens: "pass-tests", disposition: "merged", merged_into: "F1" },
      { id: "F2", path: "b.py", line: "5", lens: "pass-abstraction", disposition: "posted" },
    ]);
    const r = py(
      `from pathlib import Path
groups = ly.case_groups(Path(sys.argv[1]))
# the trailer credits both corroborating lenses — the old count's source of double credit
comments = [("a.py", 11, ["pass-baseline", "pass-tests"], True), ("b.py", 5, ["pass-abstraction"], False)]
out = ly.match_comments(groups, comments)
print(json.dumps(sorted([sorted(ls), real] for ls, real in out)))`,
      d,
    );
    expect(r).toEqual([
      [["pass-abstraction"], false],
      [["pass-baseline", "pass-tests"], true],
    ]);
  });
});

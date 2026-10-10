// bench/aacr/lens_yield.py counts per ROOT CAUSE (merge group), so "posted"
// can never exceed "raised" and a lens has one unique count (a per-trailer
// count would give one lens two different totals).
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const LY = join(import.meta.dirname, "..", "bench", "aacr");

function py(code: string, ...args: string[]): unknown {
  const out = execFileSync("python3", [
    "-c",
    `import sys, json; sys.path.insert(0, ${JSON.stringify(LY)}); import lens_yield as ly\n${code}`,
    ...args,
  ]);
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
      {
        id: "t-1",
        path: "a.py",
        line: "10",
        lens: "pass-tests",
        disposition: "merged",
        reason: "MERGED t-1 into F1: same",
      },
      {
        id: "s-1",
        path: "a.py",
        line: "40",
        lens: "pass-sweep",
        disposition: "merged",
        merged_into: "F1",
      },
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
      {
        id: "x",
        path: "a.py",
        line: "12",
        lens: "pass-consistency",
        disposition: "merged",
        reason: "same thing",
      },
    ]);
    const g = py(
      "print(json.dumps([sorted(x['raisers']) for x in ly.case_groups(__import__('pathlib').Path(sys.argv[1]))]))",
      d,
    );
    expect(g).toEqual([["pass-baseline", "pass-consistency"]]);
  });

  it("a comment credits its group once; a corroborated group is not unique to any lens; posted never exceeds raised", () => {
    const d = caseDir([
      { id: "F1", path: "a.py", line: "10", lens: "pass-baseline", disposition: "posted" },
      {
        id: "t-1",
        path: "a.py",
        line: "10",
        lens: "pass-tests",
        disposition: "merged",
        merged_into: "F1",
      },
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

describe("lens_yield: Martian case identity", () => {
  it("a PR is read from its own case dir by instance id; an empty review never borrows another PR's case", () => {
    const runs = mkdtempSync(join(tmpdir(), "ly-runs-"));
    const run = "r";
    for (const id of ["acme__app-1@aaaaaaa", "acme__app-2@bbbbbbb"]) {
      const d = join(runs, run, "cases", id);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "comments.json"), JSON.stringify([{ body: `finding in ${id} widget`, path: "a.py", line: 3 }]));
    }
    const res = join(runs, `${run}.martian`, "results", "gpt-6.1-sol");
    mkdirSync(res, { recursive: true });
    writeFileSync(
      join(res, "candidates.json"),
      JSON.stringify({
        "https://github.com/acme/app/pull/2": { quickreview: [] },
        "https://github.com/acme/app/pull/9": { quickreview: [{ text: "finding widget" }] },
      }),
    );
    writeFileSync(join(res, "evaluations.json"), "{}");
    const audit = join(runs, "audit.json");
    writeFileSync(audit, "[]");
    const got = py(
      `from pathlib import Path
print(json.dumps([p.name for p, _ in ly.martian_comments(Path(sys.argv[1]), sys.argv[2], Path(sys.argv[3]))]))`,
      runs,
      run,
      audit,
    );
    expect(got).toEqual(["acme__app-2@bbbbbbb"]);
  });
});

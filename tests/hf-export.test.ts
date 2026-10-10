// bench/aacr/hf_export.py — the Hugging Face dataset export. Its
// pure helpers run for real under python3 (standard library only; pyarrow is
// imported only by main):
//
//   1. the scrub rewrites every name the run-data policy lists to
//      its one placeholder, the longer spellings first, and counts each rule;
//   2. review_for_judge numbers comments exactly as the defect judge did
//      (src/bench/defects.ts reviewForJudge): scored rows first, deleted-line
//      comments appended last, tag and footer stripped;
//   3. defect_summary counts a defect with no verdict row as missed and a
//      partial find as 1/2;
//   4. qodo_effective reads the Qodo judge's append-only cache as its scorer
//      does: one pass-1 judgement per PR and tool, a retry's success winning.

import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "hf-export-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function py(code: string, ...args: string[]): unknown {
  const out = execFileSync("python3", [
    "-c",
    `import sys, json; sys.path.insert(0, 'bench/aacr'); import hf_export as h\n${code}`,
    ...args,
  ]);
  return JSON.parse(out.toString());
}

describe("hf_export.scrub", () => {
  it("rewrites every listed name to its placeholder and counts each rule", () => {
    const text =
      "Automated review by `example-review[bot]` (quickreviewd). Tell the owner; example-review is the app. " +
      "Logs: /home/user/qcr-bench-runs/runs/x and /home/user/.config, volume companion-pihome; OWNER.";
    const r = py(
      "import collections; c = collections.Counter(); print(json.dumps([h.scrub(sys.argv[1], c), dict(c)]))",
      text,
    ) as [string, Record<string, number>];
    expect(r[0]).toBe(
      "Automated review by `<review-bot>` (quickreview). Tell <owner>; <review-bot> is the app. " +
        "Logs: <runs>/runs/x and <home>/.config, volume <pi-login-volume>; <owner>.",
    );
    expect(r[0].toLowerCase()).not.toContain("owner_legacy");
    expect(r[1]["review bot"]).toBe(1);
    expect(r[1]["owner"]).toBe(1);
    expect(r[1]["owner (other case)"]).toBe(1);
  });

  it("walks nested values, keys included, and leaves non-strings alone", () => {
    const r = py(
      "print(json.dumps(h.scrub_obj({'the owner': ['quickreviewd', 3, None, {'x': 'example-review[bot]'}]})))",
    );
    expect(r).toEqual({ "<owner>": ["quickreview", 3, null, { x: "<review-bot>" }] });
  });
});

describe("hf_export.review_for_judge", () => {
  it("numbers scored rows, then deleted-line comments, stripping tag and footer", () => {
    const run = join(tmp, "run");
    const id = "o__r@1111111";
    mkdirSync(join(run, "results", "all"), { recursive: true });
    mkdirSync(join(run, "cases", id), { recursive: true });
    writeFileSync(
      join(run, "results", "all", `${id}.json`),
      JSON.stringify({
        review: {
          comments: [
            {
              path: "a.py",
              start_line: 3,
              end_line: 4,
              content: "[blocker] Crash on empty input\n\n_P1 · confidence 1.00_",
            },
            { path: "b.py", start_line: 9, content: "   " },
            { path: "b.py", start_line: 9, content: "plain note" },
          ],
        },
      }),
    );
    writeFileSync(
      join(run, "cases", id, "comments.json"),
      JSON.stringify([
        { path: "a.py", line: 3, side: "RIGHT", body: "[blocker] already above" },
        {
          path: "c.py",
          line: 12,
          side: "LEFT",
          body: "[question] Was this removal intended?\n\n_P2 · x_",
        },
      ]),
    );
    const r = py("print(json.dumps(h.review_for_judge(sys.argv[1], sys.argv[2])))", run, id);
    expect(r).toEqual([
      {
        id: "C1",
        path: "a.py",
        line: 3,
        end_line: 4,
        deleted_line: false,
        tag: "blocker",
        text: "Crash on empty input",
      },
      {
        id: "C2",
        path: "b.py",
        line: 9,
        end_line: 9,
        deleted_line: false,
        tag: null,
        text: "plain note",
      },
      {
        id: "C3",
        path: "c.py",
        line: 12,
        end_line: 12,
        deleted_line: true,
        tag: "question",
        text: "Was this removal intended?",
      },
    ]);
  });

  it("reads a Claude Code result file the harness reader's way", () => {
    const run = join(tmp, "claude");
    const id = "o__r@2222222";
    mkdirSync(join(run, "results", "all"), { recursive: true });
    writeFileSync(
      join(run, "results", "all", `${id}.json`),
      JSON.stringify({
        review_output: [
          {
            file: "x.ts",
            line: 5,
            summary: "Null deref",
            failure_scenario: "when the list is empty",
          },
          { file: "y.ts", line: 1, summary: "  " },
        ],
      }),
    );
    const r = py("print(json.dumps(h.review_for_judge(sys.argv[1], sys.argv[2])))", run, id) as {
      text: string;
    }[];
    expect(r.map((c) => c.text)).toEqual(["Null deref\nwhen the list is empty"]);
  });
});

describe("hf_export.defect_summary", () => {
  it("counts a partial find as 1/2 and a defect with no verdict as missed", () => {
    const r = py(
      "d = {('p','D1'):'high', ('p','D2'):'low', ('q','D1'):'medium'}\n" +
        "rows = [{'instance_id':'p','defect_id':'D1','verdict':'found'}, {'instance_id':'p','defect_id':'D2','verdict':'partial'}]\n" +
        "print(json.dumps(h.defect_summary(rows, d)))",
    ) as Record<string, number>;
    expect(r.found).toBe(1.5);
    expect(r.total).toBe(3);
    expect(r.high).toBe(1);
    expect(r.low).toBe(0.5);
    expect(r.medium).toBe(0);
    expect(r.weighted).toBeCloseTo(3.5 / 6, 6);
  });
});

describe("hf_export.qodo_effective", () => {
  it("keeps the judgement the scorer scores: one per PR and tool, a retry's success over its errored record", () => {
    const rec = (pr: string, tool: string, pass: number, meta: Record<string, unknown>) =>
      JSON.stringify({ pr, tool, pass, meta, n_comments: 1, matches: [], comments: [] });
    const lines = [
      rec("a", "x", 1, { error: "timeout" }),
      rec("a", "y", 1, { tries: 1 }),
      rec("a", "x", 2, { tries: 1 }),
      rec("b", "x", 1, { error: "first" }),
      rec("a", "x", 1, { tries: 1, n: "retry" }),
      rec("b", "x", 1, { error: "second" }),
      "",
    ].join("\n");
    const r = py("print(json.dumps(h.qodo_effective(sys.argv[1].splitlines())))", lines) as {
      pr: string;
      tool: string;
      meta: Record<string, unknown>;
    }[];
    expect(r.map((j) => [j.pr, j.tool, j.meta])).toEqual([
      ["a", "x", { tries: 1, n: "retry" }],
      ["a", "y", { tries: 1 }],
      ["b", "x", { error: "second" }],
    ]);
  });
});

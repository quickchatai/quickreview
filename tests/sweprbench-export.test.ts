// bench/aacr/ext/sweprbench_export.py — QuickReview's review as SWE-PRBench's
// agent answer, run for real against a scratch run dir (no network, no model).
//
//   1. the array is ordered P0, P1, P2, then P3/unstamped (the harness keeps
//      the first 30, so the cap only ever drops the least severe);
//   2. a comment on a DELETED line (side LEFT) is exported with `line: null`
//      instead of being dropped (a PR whose only finding sits on a deleted
//      line would otherwise score as an empty review, a hard zero);
//   3. a case that did not finish (any status but ok) answers [], whatever
//      partial comments it left in either source.

import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "sweprbench-export-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function exportRun(results: object[], caseComments: object[], status = "ok") {
  const id = "o__r@1111111";
  const run = join(tmp, `run-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(run, "results", "all"), { recursive: true });
  mkdirSync(join(run, "cases", id), { recursive: true });
  writeFileSync(
    join(run, "results", "all", `${id}.json`),
    JSON.stringify({ qcr: { status }, review: { comments: results } }),
  );
  writeFileSync(join(run, "cases", id, "comments.json"), JSON.stringify(caseComments));
  const data = join(run, "data");
  for (const sub of ["config_A", "config_B", "config_C"]) {
    mkdirSync(join(data, "contexts", sub), { recursive: true });
    writeFileSync(
      join(data, "contexts", sub, "r__1.json"),
      JSON.stringify({ rendered: `ctx ${sub}` }),
    );
  }
  const set = join(run, "set.json");
  writeFileSync(set, JSON.stringify({ cases: [{ task_id: "r__1", instance_id: id }] }));
  const out = join(run, "out", "replay-table.json");
  execFileSync("python3", [
    "bench/aacr/ext/sweprbench_export.py",
    "--run",
    run,
    "--set",
    set,
    "--data",
    data,
    "--out",
    out,
  ]);
  const answers = JSON.parse(readFileSync(join(run, "out", "quickreview-answers.json"), "utf8"));
  return answers["r__1"].comments as {
    body: string;
    file: string | null;
    line: number | null;
    severity: string | null;
  }[];
}

describe("sweprbench_export.py", () => {
  it("orders by QuickReview's severity, most severe first", () => {
    const items = exportRun(
      [
        { content: "[nit] tidy\n\n_P3 · confidence 1.00_", path: "a.py", start_line: 3 },
        { content: "[blocker] crash\n\n_P1 · confidence 1.00_", path: "a.py", start_line: 9 },
        { content: "[question] maybe\n\n_P2 · confidence 0.90_", path: "b.py", start_line: 4 },
      ],
      [],
    );
    expect(items.map((i) => i.severity)).toEqual(["P1", "P2", null]);
  });

  it("exports a comment on a deleted line with line null instead of dropping it", () => {
    const items = exportRun(
      [],
      [
        {
          path: "pkg.json",
          line: 87,
          side: "LEFT",
          body: "[question] Should the peers also become required?\n\n_P2 · confidence 0.92_",
        },
        {
          path: "pkg.json",
          line: 12,
          side: "RIGHT",
          body: "[nit] already in the result file\n\n_P3 · confidence 1.00_",
        },
      ],
    );
    expect(items).toEqual([
      {
        body: "[question] Should the peers also become required?\n\n_P2 · confidence 0.92_",
        file: "pkg.json",
        line: null,
        severity: "P2",
      },
    ]);
  });
});

describe("sweprbench_export.py — unfinished cases", () => {
  it.each(["timeout", "failed", "no-output", "no-verdict"])(
    "a %s case answers [] despite partial comments",
    (status) => {
      const items = exportRun(
        [{ content: "[blocker] crash\n\n_P1 · confidence 1.00_", path: "a.py", start_line: 9 }],
        [
          {
            path: "a.py",
            line: 4,
            side: "LEFT",
            body: "[question] gone?\n\n_P2 · confidence 0.9_",
          },
        ],
        status,
      );
      expect(items).toEqual([]);
    },
  );
});

describe("sweprbench_report.py", () => {
  it("labels the row with the run's case set, not always 'smoke'", () => {
    const label = (name: string) =>
      execFileSync("python3", [
        "-c",
        "import sys; sys.path.insert(0, 'bench/aacr/ext'); import sweprbench_report as r; from pathlib import Path; print(r.set_label(Path(sys.argv[1])))",
        `/runs/${name}`,
      ])
        .toString()
        .trim();
    expect(label("ext-r5-sweprbench-eval100.sweprbench")).toBe("eval100");
    expect(label("ext-g61-sweprbench-smoke10.sweprbench")).toBe("smoke10");
    expect(label("ext-x-sweprbench-smoke10.sweprbench-MOCK")).toBe("smoke10");
    expect(label("r7-dedup5-swepr.sweprbench")).toBe("set unknown");
  });

  it("a derived set's label comes from the set ext.sh scored it on", () => {
    const label = (name: string, set: string) =>
      execFileSync("python3", [
        "-c",
        "import sys; sys.path.insert(0, 'bench/aacr/ext'); import sweprbench_report as r; from pathlib import Path; print(r.set_label(Path(sys.argv[1]), sys.argv[2]))",
        `/runs/${name}`,
        set,
      ])
        .toString()
        .trim();
    expect(label("r7-dedup5-swepr.sweprbench", "dedup5-swepr")).toBe("dedup5-swepr");
    expect(label("ext-r5-sweprbench-eval100.sweprbench", "sweprbench-eval100")).toBe("eval100");
    const ext = readFileSync("bench/aacr/ext/ext.sh", "utf8");
    expect(ext).toContain('sweprbench_report.py" "$work" "$set_name"');
  });
});

// The dataset card (bench/aacr/hf/card.md, rendered by hf_export.py) and the
// public pages that cite run data:
//
//   1. the card renders with every {{NAME}} filled: a name the exporter does
//      not supply stops the export, and what is unknown at export time (the
//      DOI, the papers' arXiv ids) renders as a visible pending marker, never
//      as "TBD", an empty string or a bare <...> a Markdown renderer would hide;
//   2. every config the exporter writes has its own entry in the card;
//   3. `arms.judges` names only the judges that left verdicts for the arm, and
//      the judge-coverage checks fail when a judge's rows reach past what the
//      card says it scored;
//   4. every public page that cites run data links the published dataset and
//      no longer says the data is unpublished.

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const DATASET = "https://huggingface.co/datasets/quickchatai/quickreview-bench";
const CARD = readFileSync("bench/aacr/hf/card.md", "utf8");

const SCRUB_ENV = {
  QCR_SCRUB_HOME: "/home/alice",
  QCR_SCRUB_RUNS_DIR: "/home/alice/projects/qcr-bench-runs",
  // The identities come from the exporter; these are neutral plants.
  QCR_SCRUB_OWNER: "Jordan",
  QCR_SCRUB_BOT: "acme-review,acme-review-2",
  QCR_SCRUB_OLD_NAME: "acme-reviewd",
  QCR_SCRUB_PRIVATE_REPO: "widgetco-app",
};

function py(code: string, ...args: string[]): unknown {
  const out = execFileSync(
    "python3",
    ["-c", `import sys, json, types, collections; sys.path.insert(0, 'bench/aacr'); import hf_export as h\n${code}`, ...args],
    { env: { ...process.env, ...SCRUB_ENV } },
  );
  return JSON.parse(out.toString());
}

/** Render card.md as the exporter does, with one row per config. */
function render(extra = ""): string {
  return py(
    "a = types.SimpleNamespace(repo_id='acme/bench'" + extra + ")\n" +
      "sizes = {n: 1 for n in h.CONFIGS}\n" +
      "runs = [{'family': 'f1'}, {'family': 'f1'}, {'family': 'f2'}]\n" +
      "print(json.dumps(h.fill_card(open('bench/aacr/hf/card.md').read(), " +
      "h.card_values(a, sizes, [{'ok': True}], collections.Counter(), runs))))",
  ) as string;
}

describe("the dataset card renders completely", () => {
  // MUTATION: delete the `if left:` refusal in fill_card — this fails
  it("refuses a template name the exporter does not supply", () => {
    const r = py(
      "try:\n    h.fill_card('a {{REPO_ID}} b {{NOT_SUPPLIED}}', {'REPO_ID': 'x'})\n    print(json.dumps('rendered'))\n" +
        "except SystemExit as e:\n    print(json.dumps(str(e)))",
    );
    expect(r).toBe("card template: no value for NOT_SUPPLIED");
  });

  // MUTATION: remove "DOI_MD" from card_values — this fails (the export stops on the unfilled name)
  it("fills every name, with pending markers in code font until the ids exist", () => {
    const card = render();
    expect(card).not.toContain("{{");
    expect(card).not.toMatch(/\bTBD\b/);
    expect(card).toContain("DOI: `<DOI pending>`.");
    expect(card).toContain("(the benchmark paper, arXiv `<arXiv pending>`).");
    // the run archive and the slim bundle default to this dataset's own folders
    expect(card).toContain("(https://huggingface.co/datasets/acme/bench/tree/main/archive)");
    expect(card).toContain("(https://huggingface.co/datasets/acme/bench/tree/main/slim)");
    expect(card).toContain("3 run directories in\n  2 families");
    expect(card).toContain("size_categories:\n- n<1K\n"); // one row per config
  });

  // MUTATION: make md_link always return the pending form — this fails
  it("links a known DOI and arXiv id, and keeps the raw id in the BibTeX", () => {
    const card = render(", doi='10.0000/acme.1', arxiv_benchmark='2611.00001', arxiv_quickreview='2611.00002'");
    expect(card).toContain("DOI: [10.0000/acme.1](https://doi.org/10.0000/acme.1).");
    expect(card).toContain("arXiv [2611.00001](https://arxiv.org/abs/2611.00001)");
    expect(card).toContain("note   = {Quickchat AI. arXiv 2611.00002}");
    expect(card).not.toContain("<DOI pending>");
    expect(card).not.toContain("<arXiv pending>");
  });

  // MUTATION: put "arXiv id TBD" back into card.md's citation — this fails
  it("carries no TBD and no literal pending marker: the unknown ids come from the exporter", () => {
    expect(CARD).not.toMatch(/\bTBD\b/);
    expect(CARD.match(/<[^<>`]* pending>/g) ?? []).toEqual([]);
  });
});

describe("the card describes every config", () => {
  // MUTATION: delete the "- `elo_ratings` — …" bullet from card.md — this fails
  it("has a bullet entry for each config the exporter writes", () => {
    const configs = py("print(json.dumps(h.CONFIGS))") as string[];
    const described = new Set<string>();
    for (const line of CARD.split("\n")) {
      const m = /^- ((?:`[a-z_]+`(?:, )?)+) — /.exec(line);
      if (m) for (const n of m[1]!.matchAll(/`([a-z_]+)`/g)) described.add(n[1]!);
    }
    expect(configs.filter((c) => !described.has(c))).toEqual([]);
  });
});

describe("judge coverage", () => {
  // MUTATION: return [jlabel(x) for x in looked_for] in judges_that_scored — this fails
  it("arms.judges lists only the judges with verdict rows for the arm, in the searched order", () => {
    const r = py(
      "dv = [{'arm_id': 'a1', 'judge': 'gpt-6-sol-high'}, {'arm_id': 'a2', 'judge': 'claude-opus-5-5'}]\n" +
        "cv = [{'arm_id': 'a1', 'judge': 'gpt-6-sol-high-repeat'}]\n" +
        "print(json.dumps([h.judges_that_scored('a1', list(h.PAPER_JUDGES), dv, cv), " +
        "h.judges_that_scored('a3', list(h.PAPER_JUDGES), dv, cv)]))",
    );
    expect(r).toEqual([["gpt-6-sol-high", "gpt-6-sol-high-repeat"], []]);
  });

  // MUTATION: drop the second-judge check from judge_coverage_checks — this fails
  it("fails when the second judge scored an arm outside the earlier study", () => {
    const r = py(
      "seven = sorted(h.SOL_IDS.values())\n" +
        "dv = [{'arm_id': a, 'judge': j} for a in seven for j in ('gpt-6-sol-high', 'claude-opus-5-5', 'gpt-6-sol-high-repeat')]\n" +
        "dv.append({'arm_id': 'quickreview-default-g61', 'judge': 'claude-opus-5-5'})\n" +
        "arms = [{'arm_id': a, 'judges': sorted({r['judge'] for r in dv if r['arm_id'] == a})} for a in seven + ['quickreview-default-g61']]\n" +
        "t = {'defect_verdicts': dv, 'comment_verdicts': [], 'arms': arms,\n" +
        "     'martian_verdicts': [{'judge': h.EXT_JUDGE}], 'qodo_verdicts': [{'judge': h.EXT_JUDGE}],\n" +
        "     'elo_judgments': [{'plan': h.ELO_PLAN, 'judge_model': m, 'used_in_ratings': True} for m in h.ELO_JUDGES]}\n" +
        "print(json.dumps({c['check']: c['ok'] for c in h.judge_coverage_checks(t)}))",
    ) as Record<string, boolean>;
    expect(r["judges: arms the second judge (claude-opus-5-5) scored"]).toBe(false);
    expect(r["judges: arms the primary judge's re-run scored"]).toBe(true);
    expect(r["judges: martian_verdicts judges"]).toBe(true);
    expect(r[`judges: elo martian-hard20-all-gpt judges in the ratings`]).toBe(true);
    expect(r["judges: arms.judges == the judges with verdict rows for the arm"]).toBe(true);
  });

  // MUTATION: compare arms.judges against PAPER_JUDGES instead of the verdict rows — this fails
  it("fails when arms.judges claims a judge with no rows for the arm", () => {
    const r = py(
      "t = {'defect_verdicts': [{'arm_id': 'x', 'judge': 'gpt-6-sol-high'}], 'comment_verdicts': [],\n" +
        "     'arms': [{'arm_id': 'x', 'judges': ['gpt-6-sol-high', 'claude-opus-5-5']}]}\n" +
        "print(json.dumps([c for c in h.judge_coverage_checks(t) if c['check'].startswith('judges: arms.judges')]))",
    ) as { got: string[]; ok: boolean }[];
    expect(r[0]!.ok).toBe(false);
    expect(r[0]!.got).toEqual(["x"]);
  });
});

describe("public pages that cite run data link the published dataset", () => {
  const PAGES = [
    "README.md",
    "bench/aacr/README.md",
    "bench/aacr/docs/DIGITALOCEAN.md",
    "bench/aacr/docs/METHODOLOGY.md",
    "bench/aacr/docs/THREATS-TO-VALIDITY.md",
    "bench/aacr/elo/README.md",
    "bench/aacr/showcase/readme_charts.py",
  ];

  // MUTATION: delete the "## The published runs" section from DIGITALOCEAN.md — this fails
  it.each(PAGES)("%s links the dataset", (page) => {
    expect(readFileSync(page, "utf8")).toContain(DATASET);
  });

  // MUTATION: put "the run archive will be published separately" back into README.md — this fails
  it.each(PAGES)("%s no longer calls the data unpublished", (page) => {
    const text = readFileSync(page, "utf8");
    expect(text).not.toMatch(/not out yet|to be published|will be published|published separately/);
  });

  // MUTATION: cite "the run archive's elo/martian-hard20-all-gpt/REPORT.md" in readme_charts.py — this fails
  it("the Elo chart's source names the published judgments, not a private run path", () => {
    const src = readFileSync("bench/aacr/showcase/readme_charts.py", "utf8");
    expect(src).toContain("`elo_judgments` table");
    expect(src).not.toMatch(/run archive's elo\//);
  });
});

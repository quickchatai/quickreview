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
//      no longer says the data is unpublished;
//   5. the claim ids the card's table names are the claims manifest's groups,
//      never a hand-written label.

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    [
      "-c",
      `import sys, json, types, collections; sys.path.insert(0, 'bench/aacr'); import hf_export as h\n${code}`,
      ...args,
    ],
    { env: { ...process.env, ...SCRUB_ENV } },
  );
  return JSON.parse(out.toString());
}

/** Render card.md as the exporter does, with one row per config. */
function render(extra = ""): string {
  return py(
    "a = types.SimpleNamespace(repo_id='acme/bench'" +
      extra +
      ")\n" +
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
    expect(card).toMatch(/\b3 run index\s+units\b[^.]*?\bin\s+2\s+families\b/); // the template wraps freely
    // the clone the verify steps use, and the verifier's result, pending until it has run
    expect(card).toContain("git clone --branch main https://github.com/quickchatai/quickreview");
    expect(card).toContain("On this release: `<verifier result pending>`");
    expect(card).toContain("size_categories:\n- n<1K\n"); // one row per config
  });

  // MUTATION: make md_link always return the pending form — this fails
  it("links a known DOI and arXiv id, and keeps the raw id in the BibTeX", () => {
    const card = render(
      ", doi='10.0000/acme.1', arxiv_benchmark='2611.00001', arxiv_quickreview='2611.00002'",
    );
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

describe("the card's claim ids are the manifest's groups", () => {
  // MUTATION: write the list of groups on no run into card.md by hand (drop {{GROUPS_ON_NO_RUN}}) — this fails
  // MUTATION: in groups_on_no_run, list every group (ignore the runs' claims) — this fails
  it("renders the groups no run carries from the runs table, never a hand-written list", () => {
    expect(CARD).toMatch(
      /A group none of whose keys reads a run is on no run:\s+\{\{GROUPS_ON_NO_RUN\}\}\./,
    );
    const groups = Object.keys(
      (
        JSON.parse(readFileSync("bench/aacr/claims.json", "utf8")) as {
          groups: Record<string, unknown>;
        }
      ).groups,
    );
    const r = py(
      "runs = json.loads(sys.argv[1])\n" +
        "print(json.dumps([h.groups_on_no_run(runs, {'a:x': {}, 'b:y': {}, 'c:z': {}}), h.groups_on_no_run(runs[:1], {'a:x': {}}),\n" +
        "  h.groups_on_no_run([{'claims': g} for g in [json.loads(sys.argv[2])]])]))",
      JSON.stringify([{ claims: ["a:x"] }, { claims: ["c:z", "a:x"] }, { claims: [] }]),
      JSON.stringify(groups.filter((g) => g !== "do:sets")),
    ) as string[];
    expect(r).toEqual(["`b:y`", "none", "`do:sets`"]);
  });

  // MUTATION: put `qr:max-anecdote` (a retired hand-written label) back into the card's claim table — this fails
  it("names in the claim table's id column only groups bench/aacr/claims.json declares", () => {
    const groups = Object.keys(
      (
        JSON.parse(readFileSync("bench/aacr/claims.json", "utf8")) as {
          groups: Record<string, unknown>;
        }
      ).groups,
    );
    // the first table of the section: its header row to the first line that is not a table row
    const table = CARD.split("\n| Published claim | Claim id |")[1]!.split("\n\n")[0]!;
    const ids = table
      .split("\n")
      .filter((l) => l.startsWith("| "))
      .flatMap((l) => [...(l.split(" | ")[1] ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1]!));
    expect(ids.length).toBeGreaterThan(30);
    expect(ids.filter((x) => !groups.includes(x))).toEqual([]);
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

describe("the card states the release's verified state", () => {
  // MUTATION: make verify_result ignore its report (always the pending marker) — this fails
  it("renders the verifier's counts and the repository ref the release was verified against", () => {
    const dir = mkdtempSync(join(tmpdir(), "hf-card-"));
    try {
      const report = join(dir, "vc.json");
      writeFileSync(
        report,
        JSON.stringify({
          results: [
            ...Array(5).fill({ status: "pass" }),
            { status: "no-script" },
            { status: "not-published" },
            { status: "not-published" },
          ],
          consistency: [{ ok: true }, { ok: true }],
        }),
      );
      const card = render(`, repo_ref='bench-data-v1', verify_report=${JSON.stringify(report)}`);
      expect(card).toContain(
        "git clone --branch bench-data-v1 https://github.com/quickchatai/quickreview",
      );
      expect(card).toContain(
        "On this release: 5 of 8 claims pass; 0 mismatch, 0 error and 0 missing source; the documented " +
          "gaps are 1 claims with no recompute script yet and 2 whose data the release does not hold.",
      );
      expect(card).toContain("5 of 8 pass; the rest are listed in the verifier's report");
      expect(card).not.toContain("Every one of them passes");
      expect(card).not.toContain("<verifier result pending>");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // MUTATION: make claims_lead say every number passes whatever the report counts — this fails
  // MUTATION: make verify_result print the no-gap sentence when a claim is not-published — this fails
  // MUTATION: count "pending-relabel" as a pass in claims_lead — this fails
  it("says every number is checked only when the report has no claim left unchecked", () => {
    const dir = mkdtempSync(join(tmpdir(), "hf-card-"));
    try {
      const clean = join(dir, "clean.json");
      writeFileSync(
        clean,
        JSON.stringify({
          results: Array(6).fill({ status: "pass" }),
          consistency: [{ ok: true }, { ok: true }],
        }),
      );
      const card = render(`, repo_ref='bench-data-v1', verify_report=${JSON.stringify(clean)}`);
      expect(card).toContain("Every one of them passes");
      expect(card).toContain(
        "On this release: all 6 claims pass, with 0 mismatch, 0 error, 0 missing source and no claim left unchecked.",
      );
      expect(card).not.toContain("--allow-gaps");
      const gap = join(dir, "gap.json");
      writeFileSync(
        gap,
        JSON.stringify({
          results: [...Array(5).fill({ status: "pass" }), { status: "not-published" }],
          consistency: [],
        }),
      );
      const card2 = render(`, repo_ref='bench-data-v1', verify_report=${JSON.stringify(gap)}`);
      expect(card2).not.toContain("Every one of them passes");
      expect(card2).not.toContain("no claim left unchecked");
      // a status the verifier does not know (the retired "pending-relabel") is not a pass either
      const relabel = join(dir, "relabel.json");
      writeFileSync(
        relabel,
        JSON.stringify({
          results: [...Array(5).fill({ status: "pass" }), { status: "pending-relabel" }],
          consistency: [],
        }),
      );
      const card3 = render(`, repo_ref='bench-data-v1', verify_report=${JSON.stringify(relabel)}`);
      expect(card3).not.toContain("Every one of them passes");
      expect(card3).not.toContain("no claim left unchecked");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the card is leak-scanned like every other file", () => {
  // MUTATION: put README.md back on leak_scan's skip list — this fails
  it("finds a scrubbed name in the card, except on a BibTeX author line", () => {
    const dir = mkdtempSync(join(tmpdir(), "hf-leak-"));
    try {
      mkdirSync(join(dir, "data"));
      const r = py(
        "import os\n" +
          "out = sys.argv[1]\n" +
          "h.CONFIGS[:] = []\n" +
          "open(os.path.join(out, 'README.md'), 'w').write('  author = {Jordan Smith},\\nAsk Jordan.\\n')\n" +
          "a = h.leak_scan(out)\n" +
          "open(os.path.join(out, 'README.md'), 'w').write('  author = {Jordan Smith},\\n')\n" +
          "print(json.dumps([sum(a.values()), sum(h.leak_scan(out).values())]))",
        dir,
      );
      const [before, after] = r as [number, number];
      expect(before).toBeGreaterThan(0); // "Ask Jordan." (both owner rules match it)
      expect(after).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the card's comment inventory comes from the tables", () => {
  const tables = {
    reviews: [
      {
        arm_id: "quickreview-frozen",
        comments: [
          { text: "a", raw_text: "a" },
          { text: "", raw_text: "b" },
        ],
      },
      { arm_id: "ccvq-cc303-high-flagsoff", comments: [{ text: "c", raw_text: "c" }] },
      { arm_id: "ccvq-qcr-master-opus55", comments: [{ text: "d", raw_text: "d" }] },
      { arm_id: "copilot-2025-upstream", comments: [{ text: "", raw_text: null }] },
    ],
    martian_reviews: [
      {
        tool: "quickreview-frozen",
        comments: [{ body: "e" }],
        comments_beyond_first_page: [{ body: "f" }],
      },
      { tool: "rejudged-cubic-v2", comments: [], comments_beyond_first_page: [] },
    ],
    qodo_reviews: [{ tool: "greptile", comments: [{ body: "" }, { body: "" }] }],
  };

  // MUTATION: put a hand-typed table in card.md in place of {{COMMENT_INVENTORY}} — this fails
  // MUTATION: drop ("cc303", "Claude Code") from INVENTORY_AACR_TOKENS — this fails
  // MUTATION: in comment_inventory's add(), count every comment as having text (c[0] += 1) — this fails
  it("counts comments with and without text per reviewer and benchmark", () => {
    expect(CARD).toContain("\n{{COMMENT_INVENTORY}}\n");
    const r = py(
      "inv = h.comment_inventory(json.loads(sys.argv[1]))\nprint(json.dumps([inv, h.render_inventory(inv)]))",
      JSON.stringify(tables),
    ) as [Record<string, Record<string, number[]>>, string];
    expect(r[0]).toEqual({
      QuickReview: { "AACR-Bench": [3, 0, 2], Martian: [2, 0, 1] },
      "Claude Code": { "AACR-Bench": [1, 0, 1] },
      "Copilot 2025 (upstream)": { "AACR-Bench": [0, 1, 1] },
      "cubic-v2 (Martian's published review)": { Martian: [0, 0, 1] },
      "greptile (Qodo's published run)": { Qodo: [0, 2, 1] },
    });
    expect(r[1]).toContain("| QuickReview | 3 | 2 | – |");
    expect(r[1]).toContain("| greptile (Qodo's published run) | – | – | 2 location or link only |");
    expect(r[1]).toContain(
      "| cubic-v2 (Martian's published review) | – | no comment rows (1 reviews) | – |",
    );
    expect(r[1]).toContain(
      "| **All** | 4 + 1 location or link only | 2 | 2 location or link only |",
    );
  });

  // MUTATION: delete the unknown-tool SystemExit in comment_inventory — this fails
  it("stops on a Martian or Qodo tool it has no name for, and renders pending without tables", () => {
    const r = py(
      "t = json.loads(sys.argv[1])\nt['qodo_reviews'].append({'tool': 'newvendor', 'comments': []})\n" +
        "try:\n    h.comment_inventory(t)\n    print(json.dumps('counted'))\n" +
        "except SystemExit as e:\n    print(json.dumps(str(e)))",
      JSON.stringify(tables),
    );
    expect(r).toMatch(/qodo_reviews tool 'newvendor' has no reviewer name/);
    expect(render()).toContain("`<comment inventory pending>`");
  });
});

describe("the reproduction docs work on a fresh machine", () => {
  const PAGES = [
    "bench/aacr/hf/card.md",
    "bench/aacr/README.md",
    "bench/aacr/docs/DIGITALOCEAN.md",
    "README.md",
  ];
  const read = (p: string) => readFileSync(p, "utf8");

  // MUTATION: delete the "Needs:" paragraph from card.md's "How to verify" — this fails
  // MUTATION: delete the "**Needs.**" paragraph from bench/aacr/README.md's "Reproduce" — this fails
  it("names the tools the data-only route needs, where it starts", () => {
    const verify = CARD.split("\n## How to verify\n")[1]!.split("\n```sh\n")[0]!;
    const reproduce = read("bench/aacr/README.md")
      .split("\n## Reproduce\n")[1]!
      .split("\n**Tier 1")[0]!;
    for (const text of [verify, reproduce]) {
      for (const need of [
        "git",
        "Python 3.11",
        "https://docs.astral.sh/uv/",
        "zstd",
        "uvx hf auth login",
        "`uvx hf`",
        "uv run --no-project --with datasets python",
        "3 GB",
      ])
        expect(text).toContain(need);
    }
    expect(reproduce).toContain("`docker info` succeeds");
    expect(reproduce).toContain("Docker 25 or newer");
  });

  // MUTATION: put "QCR_BENCH_AUTH=api-key OPENAI_API_KEY=... python3 bench/aacr/ext/ext_judge.py" back in ext_judge.py's docstring — this fails
  it("never puts a key value on a command line", () => {
    const files = [
      ...PAGES,
      "bench/aacr/ext/ext_judge.py",
      "bench/aacr/recompute/martian_scores.py",
    ];
    const bad: string[] = [];
    for (const f of files)
      for (const [i, line] of read(f).split("\n").entries()) {
        // a command line (python, uv, bench.sh, ext.sh, after any env assignments) carrying KEY=<literal>
        if (
          !/^\s*\(?\s*(?:[A-Z_]+=\S+\s+)*(?:exec\s+)?(?:python3?|uv|\S*\/(?:bench|ext)\.sh)\b/.test(
            line,
          )
        )
          continue;
        for (const m of line.matchAll(/\b[A-Z_]*(?:API_KEY|TOKEN)=(\S+)/g))
          if (!/^"\$[A-Z_]+"$/.test(m[1]!) && m[1] !== "local")
            bad.push(`${f}:${i + 1}: ${line.trim()}`);
      }
    expect(bad).toEqual([]);
  });

  // MUTATION: drop the `export QCR_CHARTS_OUT=…` line from bench/aacr/README.md's Tier 1 block — this fails
  it("keeps re-drawn charts out of the clone wherever score.sh is run on the slim bundle", () => {
    const slim = py(
      "import export_runs as e\nprint(json.dumps(e.slim_readme(1, collections.Counter())))",
    ) as string;
    // the fenced sh blocks of the two pages, and the slim README's indented block
    const blocks = [CARD, read("bench/aacr/README.md")]
      .flatMap((t) => [...t.matchAll(/```sh\n([\s\S]*?)\n```/g)].map((m) => m[1]!))
      .concat(
        slim
          .split("\n    mkdir slim")
          .slice(1)
          .map((b) => b.split(/\n\n(?! )/)[0]!),
      );
    const runs = blocks.filter((b) =>
      /QCR_BENCH_RUNS_DIR=\S*slim\S*runs[\s\S]*final\/score\.sh/.test(b),
    );
    expect(runs.length).toBe(3);
    expect(runs.filter((b) => !b.includes("QCR_CHARTS_OUT="))).toEqual([]);
  });

  // MUTATION: rename the README Martian table's "Mean min/PR" back to "min/PR" — this fails
  // MUTATION: rename the README AACR table's "Median min/PR" to "Mean min/PR" — this fails
  it("labels each per-PR cost and time column with the statistic its claims compute", () => {
    const text = read("README.md").split("\n");
    const claims = (
      JSON.parse(read("bench/aacr/claims.json")) as {
        claims: { file: string; anchor: string; q?: string }[];
      }
    ).claims.filter((c) => c.file === "README.md" && /:(usd|min_mean|min_median)$/.test(c.q ?? ""));
    const want: Record<string, string> = {
      usd: "Mean $/PR",
      min_mean: "Mean min/PR",
      min_median: "Median min/PR",
    };
    const seen = new Set<string>();
    for (const c of claims) {
      const i = text.findIndex((l) => l.includes(c.anchor));
      if (i < 0 || !text[i]!.startsWith("|")) continue;
      let h = i;
      while (h > 0 && !/^\|[-|]+\|$/.test(text[h]!)) h--;
      const header = text[h - 1]!;
      const metric = c.q!.split(":").pop()!;
      expect(header, `${c.anchor} (${c.q})`).toContain(`| ${want[metric]} |`);
      seen.add(metric);
    }
    expect([...seen].sort()).toEqual(["min_mean", "min_median", "usd"]);
    expect(text.filter((l) => /^\| .*\| (\$|min)\/PR \|/.test(l))).toEqual([]);
  });
});

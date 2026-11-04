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
//      does: one pass-1 judgement per PR and tool, a retry's success winning;
//   5. aacr_arms resolves every arm name the committed arms files list;
//   6. generated_files fills what the public tree leaves out (charts,
//      rendered keys, FULL-BENCHMARK.md) from --generated, the tree winning;
//   7. the private product repository's name ($QCR_SCRUB_PRIVATE_REPO) becomes
//      `<private-repo>` in any case, in this export and in the run archive's
//      rewrite (export_runs.py), and the archive's re-grep still hunts it;
//   8. the release's added scrub (scrub_extra.py): credential values by value,
//      private tokens as whole words, `$HOME/` path spellings, and the
//      public repository's content rules with filter-repo's semantics, each
//      regex's prefilter literal present in every match;
//   9. the run catalogue decides what ships (release_catalogue.py): a
//      withheld or uncatalogued unit never ships, the Elo packs never ship;
//  10. a copied file ships once (plan_copies), at the source run's path;
//  11. the slim bundle's pruned transcript keeps what the recompute scripts
//      read and no text, and lensfinal reads it when the full one is absent;
//  12. no raw model session log ships (session_logs.py): every kind is named
//      by file kind, an unnamed log kind inside a run dir is left out (fail
//      closed), each JSONL one ships as its numbers-only extract, and
//      compare.py prices a case from its extract exactly as from the full
//      stream;
//  13. the authors' tracker ids and paths become `<ticket>`, run names stay;
//  14. each `qcr_commit` is remapped to public main, with a flag saying so;
//      a dirty build maps to the commit it was built on and is flagged
//      `qcr_commit_dirty`, every on-main commit says how it was matched
//      (`qcr_commit_match`, `same` or `ancestor`, from the remap's evidence
//      file, which is refused with any other kind), and the run index
//      is checked against the recorded ids and the evidence
//      (release_catalogue.commit_problems);
//  15. the answer key's build data (candidate maps, diff.stat sizes) is read
//      as data (key_data.py);
//  16. `pc2-*` is withheld whatever the catalogue says;
//  17. the fail-closed log rule reaches every tree (an unnamed log kind, an
//      aborted run's log and a session's task file are left out anywhere);
//  18. session text inside kept JSON files (a harness result's stdout and
//      stderr, a prompt argument, a prompt template, denied commands) becomes
//      numbers or hashes, and a data file still holding it is left out;
//  19. PR authors' descriptions and the vendors' Martian review bodies are
//      linked, not copied, wherever a file copied them; the Martian judge's
//      extractions of vendor comments and the blind annotation's vendor
//      candidates ship verbatim (third-party text, copied by the owner's ruling);
//  20. the re-grep is a gate, verify_slim fails on what it finds, and a run
//      suffix ships with its run only when it is a known one;
//  21. `qodo_prs` publishes the real GitHub commits (the leak-proof block's
//      merge-base and head), never a harness replay id, which it keeps in
//      `replay_*`; and a repository whose licence changed between its PRs
//      (the redis fork) gets each PR's own licence;
//  22. what a re-judge needs: each AACR PR's merge base and title (the answer
//      key's meta.json), each comment's text as the run's files hold it
//      (`raw_text`) with QuickReview's priority and confidence, a Martian
//      review's inline comments beyond the page Martian read;
//  23. a Martian scoring dir's reviews keep their run's own tool name (a
//      mislabelled ingest is relabelled, its scores merged), and no review in
//      QuickReview's style carries a third-party tool's name;
//  24. every Martian scoring dir's `runs.judges` states its judge's settings
//      from its own record;
//  25. `arms.paper_tables`, `arms.in_paper` and `runs.claims` follow the claims
//      manifest's q keys, and a Qodo verdict ships only beside its review;
//  26. the export's load check reads the folder it wrote, through a cache of
//      its own (load_counts), never an earlier export's.

import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "hf-export-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const SCRUB_ENV = {
  QCR_SCRUB_HOME: "/home/alice",
  QCR_SCRUB_RUNS_DIR: "/home/alice/projects/qcr-bench-runs",
  // The identities come from the exporter; these are neutral plants.
  QCR_SCRUB_OWNER: "Jordan",
  QCR_SCRUB_BOT: "acme-review,acme-review-2",
  QCR_SCRUB_OLD_NAME: "acme-reviewd",
  QCR_SCRUB_PRIVATE_REPO: "widgetco-app",
};

function pyModule(mod: string, code: string, ...args: string[]): unknown {
  return pyEnv({}, mod, code, ...args);
}

/** pyModule with extra environment (the scrub inputs are read at import). */
function pyEnv(env: Record<string, string>, mod: string, code: string, ...args: string[]): unknown {
  const out = execFileSync(
    "python3",
    [
      "-c",
      `import sys, json; sys.path.insert(0, 'bench/aacr'); import ${mod} as h\n${code}`,
      ...args,
    ],
    { env: { ...process.env, ...SCRUB_ENV, ...env } },
  );
  return JSON.parse(out.toString());
}

function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function py(code: string, ...args: string[]): unknown {
  return pyModule("hf_export", code, ...args);
}

describe("hf_export.scrub", () => {
  it("rewrites every listed name to its placeholder and counts each rule", () => {
    const text =
      "Automated review by `acme-review[bot]` (acme-reviewd). Tell Jordan; acme-review is the app, " +
      "acme-review-2[bot] its twin. " +
      "Logs: /home/alice/projects/qcr-bench-runs/runs/x and /home/alice/.config, volume companion-pihome; JORDAN.";
    const r = py(
      "import collections; c = collections.Counter(); print(json.dumps([h.scrub(sys.argv[1], c), dict(c)]))",
      text,
    ) as [string, Record<string, number>];
    expect(r[0]).toBe(
      "Automated review by `<review-bot>` (quickreview). Tell <owner>; <review-bot> is the app, " +
        "<review-bot> its twin. " +
        "Logs: <runs>/runs/x and <home>/.config, volume <pi-login-volume>; <owner>.",
    );
    expect(r[0].toLowerCase()).not.toMatch(/jordan|acme/);
    expect(r[1]["review bot"]).toBe(2);
    expect(r[1]["owner"]).toBe(1);
    expect(r[1]["owner (other case)"]).toBe(1);
  });

  // MUTATION: drop the "private repo" entry from hf_export.SCRUB_RULES — this fails
  it("rewrites the private product repository's name in any case", () => {
    const r = py(
      "import collections; c = collections.Counter(); print(json.dumps([h.scrub(sys.argv[1], c), dict(c)]))",
      "Compare with widgetco-app/src and WidgetCo-App's profile; profiles/widgetco stays.",
    ) as [string, Record<string, number>];
    expect(r[0]).toBe(
      "Compare with <private-repo>/src and <private-repo>'s profile; profiles/widgetco stays.",
    );
    expect(r[1]["private repo"]).toBe(2);
  });

  it("walks nested values, keys included, and leaves non-strings alone", () => {
    const r = py(
      "print(json.dumps(h.scrub_obj({'Jordan': ['acme-reviewd', 3, None, {'x': 'acme-review[bot]'}]})))",
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
        raw_text: "[blocker] Crash on empty input\n\n_P1 · confidence 1.00_",
        priority: "P1",
        confidence: 1,
      },
      {
        id: "C2",
        path: "b.py",
        line: 9,
        end_line: 9,
        deleted_line: false,
        tag: null,
        text: "plain note",
        raw_text: "plain note",
        priority: null,
        confidence: null,
      },
      {
        id: "C3",
        path: "c.py",
        line: 12,
        end_line: 12,
        deleted_line: true,
        tag: "question",
        text: "Was this removal intended?",
        raw_text: "[question] Was this removal intended?\n\n_P2 · x_",
        priority: null,
        confidence: null,
      },
    ]);
    // the files read again in the same order: what the export's raw_text check compares
    const again = py("print(json.dumps(h.archive_texts(sys.argv[1], sys.argv[2])))", run, id);
    expect(again).toEqual([
      "[blocker] Crash on empty input\n\n_P1 · confidence 1.00_",
      "plain note",
      "[question] Was this removal intended?\n\n_P2 · x_",
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

describe("hf_export: Qodo commits and per-PR licences", () => {
  // MUTATION: in qodo_pr_commits, publish the case's base_commit/head_commit as base_commit/head_commit — this fails
  // MUTATION: in replay_commit_problems, drop the `x in replay_ids` test — this fails
  it("publishes the PR's real merge-base and head, keeps the replay ids apart, and counts a row that publishes one", () => {
    const r = py(
      "import os\n" +
        "cases = json.load(open(os.path.join(h.HERE, 'sets', 'qodo-pr100.json')))['cases']\n" +
        "rows = [h.qodo_pr_commits(c) for c in cases]\n" +
        "ids = h.set_replay_ids()\n" +
        "a, b = rows[0], rows[1]\n" +
        "planted = [dict(a, head_commit=b['replay_head_commit']), dict(a, base_commit=None), dict(a)]\n" +
        "print(json.dumps({'n': len(rows), 'ids': len(ids),\n" +
        "  'real': sum(r['head_commit'] == c['leakproof']['source_head'] and r['base_commit'] == c['leakproof']['source_merge_base'] for r, c in zip(rows, cases)),\n" +
        "  'replay': sum(r['replay_head_commit'] == c['head_commit'] and r['replay_base_commit'] == c['base_commit'] for r, c in zip(rows, cases)),\n" +
        "  'published_replay': sum(r[k] in ids for r in rows for k in ('base_commit', 'head_commit')),\n" +
        "  'problems': h.replay_commit_problems(rows, ids), 'planted': h.replay_commit_problems(planted, ids)}))",
    ) as Record<string, number>;
    expect(r.n).toBe(100);
    expect(r.ids).toBeGreaterThanOrEqual(200);
    expect(r.real).toBe(100);
    expect(r.replay).toBe(100);
    expect(r.published_replay).toBe(0);
    expect(r.problems).toBe(0);
    expect(r.planted).toBe(2);
  });

  // MUTATION: map redis PR 8 to _REDIS8 in BENCH_PR_LICENSES — this fails
  // MUTATION: drop the BENCH_PR_LICENSES lookup from bench_repo_license — this fails
  it("gives each redis PR the licence read at its head, and an unlisted redis PR none", () => {
    const r = py(
      "import os\n" +
        "R = 'agentic-review-benchmarks/redis'\n" +
        "cases = json.load(open(os.path.join(h.HERE, 'sets', 'qodo-pr100.json')))['cases']\n" +
        "print(json.dumps({'redis': {n: h.bench_repo_license(R, n)['repo_license'] for n in range(1, 11)},\n" +
        "  'note': h.bench_repo_license(R, 8)['repo_license_note'],\n" +
        "  'cal': h.bench_repo_license('agentic-review-benchmarks/cal.com', 3)['repo_license'],\n" +
        "  'unlicensed': [c['pr_url'] for c in cases if not h.bench_repo_license(c['repo'], c.get('pr'))['repo_license']]}))",
    ) as { redis: Record<string, string | null>; note: string; cal: string; unlicensed: string[] };
    const tri = "LicenseRef-RSALv2 OR SSPL-1.0 OR AGPL-3.0-only";
    expect(r.redis).toEqual({
      "1": tri,
      "2": tri,
      "3": tri,
      "4": tri,
      "5": tri,
      "6": tri,
      "7": tri,
      "8": "LicenseRef-RSALv2 OR SSPL-1.0",
      "9": tri,
      "10": null,
    });
    expect(r.note).toContain("LICENSE.txt at the PR's head commit");
    expect(r.cal).toBe("AGPL-3.0-only");
    expect(r.unlicensed).toEqual([]);
  });
});

describe("hf_export.aacr_arms", () => {
  it("maps every name in the committed arms files to an arm id", () => {
    const r = py(
      "import os\n" +
        "names = lambda f: [n for n, _ in h.read_arms_file(os.path.join(h.HERE, 'final', f))]\n" +
        "print(json.dumps({'final': [n for n in names('arms.txt') if n not in h.FINAL_IDS],\n" +
        "  'sol': [n for n in names('arms-gpt6sol.txt') if n not in h.SOL_IDS],\n" +
        "  'open': [n for n in names('arms-open-models.txt') if n not in h.OPEN_IDS],\n" +
        "  'ids': [a['arm_id'] for a in h.aacr_arms()]}))",
    ) as { final: string[]; sol: string[]; open: string[]; ids: string[] };
    expect(r.final).toEqual([]);
    expect(r.sol).toEqual([]);
    expect(r.open).toEqual([]);
    expect(r.ids).toContain("quickreview-default-sol");
    expect(r.ids).toContain("quickreview-low-sol");
  });
});

describe("export_runs private-repo rewrite", () => {
  // MUTATION: drop the private-repo rule from export_runs._identity_rules — this fails
  it("rewrites the private repository's name in file text and member names, and counts it", () => {
    const r = pyModule(
      "export_runs",
      "import collections; c = collections.Counter()\n" +
        "t = h.rewrite(sys.argv[1].encode(), c).decode()\n" +
        "n = h.rewrite_name('runs/x/WIDGETCO-APP-notes.txt', c)\n" +
        "print(json.dumps([t, n, c['private-repo']]))",
      'The diff touches widgetco-app/README and {"repo":"WidgetCo-App"}.',
    ) as [string, string, number];
    expect(r[0]).toBe('The diff touches <private-repo>/README and {"repo":"<private-repo>"}.');
    expect(r[1]).toBe("runs/x/<private-repo>-notes.txt");
    expect(r[2]).toBe(3);
  });

  // MUTATION: drop SCRUB_PRIVATE_REPOS from export_runs.REGREP_SCAN — this fails
  it("re-greps the private repository's name after the rewrite", () => {
    const r = pyModule(
      "export_runs",
      "import re\n" +
        "print(json.dumps([bool(re.search(h.REGREP_SCAN, b'see WidgetCo-App here')),\n" +
        "  [k for k in h.REGREP if k.startswith('private repo')]]))",
    ) as [boolean, string[]];
    expect(r[0]).toBe(true);
    expect(r[1]).toEqual(["private repo 0 (any case)"]);
  });
});

describe("hf_export.generated_files", () => {
  // MUTATION: put a.generated before HERE in generated_files' roots — this fails
  it("takes the tree's own artefact and fills the rest from --generated", () => {
    const gen = join(tmp, "generated");
    mkdirSync(join(gen, "charts"), { recursive: true });
    writeFileSync(join(gen, "charts", "two-scores.jpg"), "older render");
    writeFileSync(join(gen, "charts", "numbers.json"), "{}");
    writeFileSync(join(gen, "FULL-BENCHMARK.md"), "# report");
    const r = py(
      "import types, os\n" +
        "a = types.SimpleNamespace(generated=sys.argv[1])\n" +
        "c = h.generated_files(a, 'charts'); top = h.generated_files(a, '')\n" +
        "rel = lambda p: 'tree' if p.startswith(h.HERE + os.sep) else 'generated'\n" +
        "print(json.dumps({'two': rel(c['two-scores.jpg']), 'numbers': rel(c['numbers.json']),\n" +
        "  'full': rel(top['FULL-BENCHMARK.md']), 'none': sorted(h.generated_files(types.SimpleNamespace(generated=None), 'nope'))}))",
      gen,
    ) as Record<string, unknown>;
    expect(r).toEqual({ two: "tree", numbers: "generated", full: "generated", none: [] });
  });
});

describe("hf_export.figure_problems", () => {
  // MUTATION: drop the \chart{} pattern from hf_export.PAPER_CHART_RX (keep only ../charts/) — this fails
  // MUTATION: in figure_problems, skip a paper chart whose figure is missing (compare only when both exist) — this fails
  // MUTATION: in figure_problems, compare the ARM_FREE_CHARTS figure with itself instead of its -gpt6sol twin — this fails
  it("flags a paper chart whose repository copy is not the exported figure, and an arm-free chart unlike its twin", () => {
    const root = join(tmp, "figs");
    const paper = join(root, "paper");
    const charts = join(root, "charts");
    const fig = join(root, "figures");
    put(
      join(paper, "a.tex"),
      "\\newcommand{\\chart}[1]{../charts/#1.jpg}\n" +
        "\\includegraphics{\\chart{bars-gpt6sol}}\n\\includegraphics{\\chart{same}}\n" +
        "\\includegraphics[width=1.0\\textwidth]{../charts/vector.pdf}\n\\includegraphics{\\chart{gone}}\n",
    );
    put(join(charts, "bars-gpt6sol.jpg"), "drawn from the older arm names");
    put(join(fig, "bars-gpt6sol.jpg"), "drawn from the public arm names");
    put(join(charts, "same.jpg"), "one drawing");
    put(join(fig, "same.jpg"), "one drawing");
    put(join(charts, "vector.pdf"), "pdf");
    put(join(fig, "vector.pdf"), "pdf");
    put(join(charts, "gone.jpg"), "in the repository only");
    put(join(fig, "reference-quality.jpg"), "a staged older layout");
    put(join(fig, "reference-quality-gpt6sol.jpg"), "the redraw");
    const r = py(
      "print(json.dumps({'names': h.paper_charts(sys.argv[1]),\n" +
        "  'bad': h.figure_problems(sys.argv[1], sys.argv[2], sys.argv[3]),\n" +
        "  'empty': h.figure_problems(sys.argv[2], sys.argv[2], sys.argv[3])['paper_differs']}))",
      paper,
      charts,
      fig,
    ) as Record<string, unknown>;
    expect(r).toEqual({
      names: ["bars-gpt6sol.jpg", "gone.jpg", "same.jpg", "vector.pdf"],
      bad: {
        paper_differs: ["bars-gpt6sol.jpg", "gone.jpg"],
        arm_free_differs: ["reference-quality.jpg"],
      },
      empty: ["(no chart in the papers)"],
    });
    put(join(fig, "reference-quality.jpg"), "the redraw");
    const same = py(
      "print(json.dumps(h.figure_problems(sys.argv[1], sys.argv[2], sys.argv[3])['arm_free_differs']))",
      paper,
      charts,
      fig,
    );
    expect(same).toEqual([]);
  });
});

describe("scrub_extra: credentials, private tokens, home spellings", () => {
  // A neutral plant: no real credential shape, never a real value.
  const secretFile = join(tmp, "creds", "planted.env");
  put(secretFile, "# a comment\nPLANTED_KEY='planted-not-a-key-0123456789'\nSHORT=abc\n");
  const env = {
    QCR_SCRUB_SECRET_FILES: secretFile,
    QCR_SCRUB_PRIVATE_WORDS: "zz-operator-handle",
  };

  // MUTATION: drop the "secret" rules from export_runs._identity_rules — this fails
  it("redacts every credential value wherever it occurs, and the re-grep hunts it", () => {
    const r = pyEnv(
      env,
      "export_runs",
      "import collections, re; c = collections.Counter()\n" +
        "t = h.rewrite(sys.argv[1].encode(), c).decode()\n" +
        "print(json.dumps([t, c['secret'], bool(re.search(h.REGREP_SCAN, b'x planted-not-a-key-0123456789 y'))]))",
      'env: {"Authorization": "Bearer planted-not-a-key-0123456789"} and SHORT=abc',
    ) as [string, number, boolean];
    expect(r[0]).toBe('env: {"Authorization": "Bearer <redacted-secret>"} and SHORT=abc');
    expect(r[1]).toBe(1);
    expect(r[2]).toBe(true);
  });

  // MUTATION: drop the "private-word" rules from export_runs._identity_rules — this fails
  it("rewrites a private token as a whole word in any case, never inside a longer word", () => {
    const r = pyEnv(
      env,
      "export_runs",
      "import collections; c = collections.Counter()\n" +
        "print(json.dumps(h.rewrite(sys.argv[1].encode(), c).decode()))",
      'github_login = "ZZ-Operator-Handle" and xzz-operator-handles stays',
    );
    expect(r).toBe('github_login = "<private>" and xzz-operator-handles stays');
  });

  // MUTATION: drop the `$HOME` spellings from export_runs._path_rx — this fails
  it("rewrites the runs dir spelled through $HOME or ${HOME}", () => {
    const r = pyEnv(
      env,
      "export_runs",
      "import collections; c = collections.Counter()\n" +
        "print(json.dumps(h.rewrite(sys.argv[1].encode(), c).decode()))",
      "EXT_CACHE=$HOME/projects/qcr-bench-runs/ext-cache X=${HOME}/projects/qcr-bench-runs/runs",
    );
    expect(r).toBe("EXT_CACHE=<runs>/ext-cache X=<runs>/runs");
  });

  it("hf_export.scrub applies the same credential and token rules", () => {
    const r = pyEnv(
      env,
      "hf_export",
      "print(json.dumps(h.scrub(sys.argv[1])))",
      "key planted-not-a-key-0123456789 from zz-operator-handle",
    );
    expect(r).toBe("key <redacted-secret> from <private>");
  });
});

describe("scrub_extra.ContentRules", () => {
  const rulesFile = join(tmp, "rules", "replacements.txt");
  put(
    rulesFile,
    [
      "Widgetco support guideline==>a support guideline",
      "widget tracker==>gadget tracker",
      "regex:\\bwidget([ \\t]*)tracker\\b==>issue\\1tracker",
      "regex: \\(#90(12|34)\\)==>",
      "dropme-token",
      "Widgetco==>Example",
      "",
    ].join("\n"),
  );

  // MUTATION: apply the regexes before the literals in ContentRules.apply — this fails
  it("applies every literal first, in file order, then every regex", () => {
    const r = pyEnv(
      { QCR_SCRUB_CONTENT_RULES: rulesFile },
      "export_runs",
      "import collections; c = collections.Counter()\n" +
        "t = h.rewrite(sys.argv[1].encode(), c).decode()\n" +
        "print(json.dumps([t, sorted(k for k in c if k.startswith('content-rule'))]))",
      "Widgetco support guideline, see widget tracker and widget  tracker (#9012) and dropme-token; Widgetco.",
    ) as [string, string[]];
    // the literal turns "widget tracker" into "gadget tracker" before the
    // regex runs; the regex rewrites only the spelling the literal missed
    expect(r[0]).toBe(
      "a support guideline, see gadget tracker and issue  tracker and ***REMOVED***; Example.",
    );
    expect(r[1]).toEqual([
      "content-rule literal #1",
      "content-rule literal #2",
      "content-rule literal #3",
      "content-rule literal #4",
      "content-rule regex #1",
      "content-rule regex #2",
    ]);
  });

  // MUTATION: stop dropping the char before a `?` quantifier in regex_anchor — this fails
  it("gives each regex a prefilter literal that every match contains", () => {
    const cases: [string, string[]][] = [
      ["colou?r scheme", ["color scheme", "colour scheme"]],
      ["ab+c-d", ["abbbc-d"]],
      ["\\bblue([ \\t]*)widget\\b", ["blue widget", "bluewidget"]],
      ["x{2,3}yz-tail", ["xxyz-tail"]],
      ["(?i)Mixed-Case", ["mixed-case"]],
      ["pre[0-9]+post-fix", ["pre42post-fix"]],
      ["\\(#90(12|34)\\)", ["(#9012)"]],
    ];
    const r = pyModule(
      "scrub_extra",
      "import re\ncases = json.loads(sys.argv[1]); out = []\n" +
        "for pat, texts in cases:\n" +
        "  a, ic = h.regex_anchor(pat.encode())\n" +
        "  ok = all(re.search(pat, t) and (a is None or a in (re.search(pat, t).group(0).lower().encode() if ic else re.search(pat, t).group(0).encode())) for t in texts)\n" +
        "  out.append([pat, a.decode() if a else None, ok])\n" +
        "print(json.dumps(out))",
      JSON.stringify(cases),
    ) as [string, string | null, boolean][];
    for (const [pat, , ok] of r) expect(ok, pat).toBe(true);
    expect(r[0]![1]).toBe("r scheme");
    expect(r[4]![1]).toBe("mixed-case");
  });

  it("has no prefilter for a top-level alternation", () => {
    const r = pyModule(
      "scrub_extra",
      "print(json.dumps(h.regex_anchor(b'alpha-one|beta-two')[0]))",
    );
    expect(r).toBeNull();
  });
});

describe("release_catalogue and export_runs: what ships", () => {
  const root = join(tmp, "cat");
  const src = join(root, "bench-runs");
  const om = join(root, "open-models");
  put(
    join(src, "runs", "keep-dev10", "run.json"),
    JSON.stringify({ set: "dev10", qcr_commit: "aaa111" }),
  );
  put(join(src, "runs", "keep-dev10", "cases", "x", "pi-events.jsonl"), "{}\n");
  put(join(src, "runs", "keep-dev10.review.log"), "log\n");
  put(join(src, "runs", "own-repo-run", "run.json"), "{}");
  put(join(src, "runs", "nobody-knows", "run.json"), "{}");
  put(join(src, "elo", "plan-a", "plan.json"), "{}");
  put(join(src, "elo", "plan-a", "packs", "u1.txt"), "whole reviewed file");
  put(join(om, "runs", "om-run", "run.json"), "{}");
  put(join(om, "driver.sh"), "echo\n");
  const catalogue = join(root, "catalogue.json");
  writeFileSync(
    catalogue,
    JSON.stringify({
      claims: { "c:one": "a claim" },
      families: [
        {
          id: "kept",
          title: "Kept runs",
          location: "qcr-bench-runs/runs/",
          members: ["keep-dev10"],
          ship: "yes",
          hf_tables: ["runs (new)", "reviews"],
          claims: ["c:one"],
        },
        {
          id: "own",
          title: "Own repo",
          location: "qcr-bench-runs/runs/",
          members: ["own-repo-run"],
          ship: "no:own-repo",
          hf_tables: [],
          claims: "none",
        },
        {
          id: "elo",
          title: "Elo",
          location: "qcr-bench-runs/",
          members: ["elo"],
          ship: "yes",
          hf_tables: [],
          claims: "none",
        },
        {
          id: "om",
          title: "Open models",
          location: "review-sandbox bench/aacr/artifacts/open-models/runs/ (gitignored)",
          members: ["om-run"],
          ship: "yes",
          hf_tables: [],
          claims: "none",
        },
        {
          id: "drv",
          title: "Driver",
          location: "review-sandbox bench/aacr/artifacts/open-models/ (top level)",
          members: ["driver.sh"],
          ship: "yes",
          hf_tables: [],
          claims: "none",
        },
      ],
    }),
  );

  // MUTATION: make release_catalogue.Catalogue.ships accept every family — this fails
  it("ships only catalogued families' units, and never the Elo packs", () => {
    const r = pyModule(
      "export_runs",
      "from pathlib import Path\nimport release_catalogue as RC\n" +
        "p = h.Processor(Path(sys.argv[1]), Path(sys.argv[2]), RC.Catalogue.load(sys.argv[3]))\n" +
        "out = {rel: p.drop(rel) for rel in h.walk_files(p.src, p.om)}\n" +
        "print(json.dumps(out))",
      src,
      om,
      catalogue,
    ) as Record<string, string | null>;
    expect(r["runs/keep-dev10/run.json"]).toBeNull();
    expect(r["runs/keep-dev10.review.log"]).toBeNull();
    expect(r["open-models/runs/om-run/run.json"]).toBeNull();
    expect(r["open-models/driver.sh"]).toBeNull();
    expect(r["elo/plan-a/plan.json"]).toBeNull();
    expect(r["runs/own-repo-run/run.json"]).toMatch(
      /^withheld: QuickReview reviewing our own repositories/,
    );
    expect(r["runs/nobody-knows/run.json"]).toMatch(/^not in the run catalogue/);
    expect(r["elo/plan-a/packs/u1.txt"]).toMatch(/^regenerable: Elo packs/);
  });

  it("indexes every shipped unit with its run.json facts, and lists withheld families", () => {
    const r = pyModule(
      "release_catalogue",
      "c = h.Catalogue.load(sys.argv[1])\n" +
        "rows = h.index_rows(c, {'runs': sys.argv[2] + '/runs', 'top': sys.argv[2]}, {'aaa111': 'bbb222'},\n" +
        "  evidence={'aaa111': {'recorded': 'aaa111', 'match': 'same'}})\n" +
        "print(json.dumps([[r['unit'], r['family'], r['set'], r['qcr_commit'], r['qcr_commit_on_public_main'], r['qcr_commit_match'], r['qcr_commit_dirty'], r['claims'], r['hf_tables']] for r in rows]\n" +
        "  + [[w['family'], w['reason']] for w in h.withheld_rows(c)]))",
      catalogue,
      src,
    ) as unknown[][];
    expect(r).toContainEqual([
      "keep-dev10",
      "kept",
      "dev10",
      "bbb222",
      true,
      "same",
      false,
      ["c:one"],
      ["runs", "reviews"],
    ]);
    expect(r).toContainEqual(["elo", "elo", null, null, null, null, null, [], []]);
    expect(r.find((x) => x[0] === "own")?.[1]).toMatch(/^withheld/);
    expect(r.some((x) => x[0] === "own-repo-run")).toBe(false);
  });

  // MUTATION: drop the `dirty_unflagged` count from release_catalogue.commit_problems — this fails
  // MUTATION: in commit_problems, count `off_main` only when the commit is missing (skip the remap comparison) — this fails
  // MUTATION: in commit_problems, accept any match kind on a main row (drop the evidence comparison) — this fails
  // MUTATION: in commit_problems, stop counting a match on a row off main (drop the `elif match is not None`) — this fails
  // MUTATION: in commit_problems, drop the `dropped_paths_on_public_main == []` condition of `ancestor_unproven` — this fails
  // MUTATION: in commit_problems, drop the `ancestor_of_origin_main` condition of `ancestor_unproven` — this fails
  it("checks the run index's build commits against the recorded ids and the evidence: a dirty build flagged, main only per the remap, every match kind proven", () => {
    const row = (
      path: string,
      qcr_commit: string | null,
      on: boolean | null,
      match: string | null,
      dirty: boolean | null,
    ) => ({
      path,
      qcr_commit,
      qcr_commit_on_public_main: on,
      qcr_commit_match: match,
      qcr_commit_dirty: dirty,
    });
    const rows = [
      row("runs/a", "p1-dirty", true, "same", true),
      row("runs/b", "p1-dirty", true, "same", false),
      row("runs/c", "p1", true, "same", false),
      row("runs/d", "p2", true, "same", false),
      row("runs/e", "s1", false, null, false),
      row("runs/f", null, null, null, null),
      // g: on main without a match kind; h: a retired kind, not the evidence's; i: off main with one
      row("runs/g", "p1", true, null, false),
      row("runs/h", "p1", true, "date+subject", false),
      row("runs/i", "s1", false, "same", false),
      // j: a proven ancestor; k: its dropped commit touched a published path; l: not an ancestor of main
      row("runs/j", "p4", true, "ancestor", false),
      row("runs/k", "p5", true, "ancestor", false),
      row("runs/l", "p6", true, "ancestor", false),
    ];
    const recorded = {
      "runs/a": "r1-dirty",
      "runs/b": "r1-dirty",
      "runs/c": "r1",
      "runs/d": "r3",
      "runs/e": "s1",
      "runs/f": null,
      "runs/g": "r1",
      "runs/h": "r1",
      "runs/i": "s1",
      "runs/j": "r4",
      "runs/k": "r5",
      "runs/l": "r6",
    };
    const remap = {
      "r1-dirty": "p1",
      r1: "p1",
      r2: "p2",
      r3: "p1",
      s1: null,
      r4: "p4",
      r5: "p5",
      r6: "p6",
    };
    const anc = (recorded: string, public_main: string, onMain: boolean, paths: string[]) => ({
      recorded,
      public_main,
      match: "ancestor",
      ancestor_of_origin_main: onMain,
      dropped_paths_on_public_main: paths,
    });
    const evidence = {
      "r1-dirty": { recorded: "r1-dirty", match: "same" },
      r1: { recorded: "r1", match: "same" },
      r3: { recorded: "r3", match: "same" },
      r4: anc("r4", "p4", true, []),
      r5: anc("r5", "p5", true, ["src/gate.ts"]),
      r6: anc("r6", "p6", false, []),
    };
    const r = pyModule(
      "release_catalogue",
      "print(json.dumps(h.commit_problems(*(json.loads(a) for a in sys.argv[1:5]))))",
      JSON.stringify(rows),
      JSON.stringify(recorded),
      JSON.stringify(remap),
      JSON.stringify(evidence),
    );
    // b: a dirty build published unflagged; d: p2 is on main, but not the commit r3 became (and r3's
    // kind is the evidence's); g, h, i: unmatched; k, l: an ancestor the evidence does not prove
    expect(r).toEqual({ dirty_unflagged: 1, off_main: 1, unmatched: 3, ancestor_unproven: 2 });
  });

  // MUTATION: make release_catalogue.load_remap return an empty evidence map — this fails
  // MUTATION: drop the missing-evidence SystemExit from release_catalogue.load_remap — this fails
  // MUTATION: add "date+subject" back to release_catalogue.MATCH_KINDS — this fails
  // MUTATION: drop the unknown-kind SystemExit from release_catalogue.load_remap — this fails
  it("reads each mapped id's match kind from the evidence file beside the remap, and refuses a remap without one or with a kind other than same and ancestor", () => {
    const dir = join(tmp, "remap");
    put(join(dir, "qcr-commit-remap.json"), JSON.stringify({ r1: "p1", s1: null }));
    put(
      join(dir, "qcr-commit-remap-evidence.json"),
      JSON.stringify({ entries: [{ recorded: "r1", public_main: "p1", match: "ancestor" }] }),
    );
    put(join(dir, "bare.json"), JSON.stringify({ r1: "p1" }));
    // the retired kind: matched by author date and subject alone
    put(join(dir, "old.json"), JSON.stringify({ r1: "p1" }));
    put(
      join(dir, "old-evidence.json"),
      JSON.stringify({ entries: [{ recorded: "r1", public_main: "p1", match: "date+subject" }] }),
    );
    const r = pyModule(
      "release_catalogue",
      "remap, ev = h.load_remap(sys.argv[1])\n" +
        "def tried(p):\n    try:\n        h.load_remap(p); return 'loaded'\n    except SystemExit:\n        return 'refused'\n" +
        "print(json.dumps([h.commit_fields('r1-dirty', remap, ev), h.commit_fields('s1', remap, ev), tried(sys.argv[2]), tried(sys.argv[3])]))",
      join(dir, "qcr-commit-remap.json"),
      join(dir, "bare.json"),
      join(dir, "old.json"),
    );
    expect(r).toEqual([
      {
        qcr_commit: "p1-dirty",
        qcr_commit_on_public_main: true,
        qcr_commit_match: "ancestor",
        qcr_commit_dirty: true,
      },
      {
        qcr_commit: "s1",
        qcr_commit_on_public_main: false,
        qcr_commit_match: null,
        qcr_commit_dirty: false,
      },
      "refused",
      "refused",
    ]);
  });
});

describe("export_runs.plan_copies", () => {
  // MUTATION: in plan_copies, pick the hardlink canonical by path alone (drop copy_rank) — this fails
  it("ships a hardlinked file once, at the source run's path, and maps a variant's byte copy to its source", () => {
    const src = join(tmp, "copies");
    put(join(src, "runs", "zsource-a", "cases", "x", "f.json"), "same bytes\n");
    mkdirSync(join(src, "runs", "mv-a", "cases", "x"), { recursive: true });
    linkSync(
      join(src, "runs", "zsource-a", "cases", "x", "f.json"),
      join(src, "runs", "mv-a", "cases", "x", "f.json"),
    );
    put(
      join(src, "runs", "mv-b", "VARIANT.json"),
      JSON.stringify({ policy: { src: ["zsource-a"] } }),
    );
    put(join(src, "runs", "mv-b", "cases", "x", "f.json"), "same bytes\n");
    put(join(src, "runs", "mv-b", "cases", "x", "own.json"), "new\n");
    const r = pyModule(
      "export_runs",
      "from pathlib import Path\nt = h.Tree(Path(sys.argv[1]))\n" +
        "rels = [r for r in h.walk_files(t.src, None, ('runs',)) if not r.endswith('VARIANT.json')]\n" +
        "print(json.dumps(h.plan_copies(t, rels)))",
      src,
    );
    expect(r).toEqual({
      "runs/mv-a/cases/x/f.json": "runs/zsource-a/cases/x/f.json",
      "runs/mv-b/cases/x/f.json": "runs/zsource-a/cases/x/f.json",
    });
  });
});

describe("the slim bundle's pruned transcript", () => {
  const events = [
    {
      type: "message_start",
      message: { role: "assistant", content: [{ type: "text", text: "SECRET-PROSE" }] },
    },
    {
      type: "message_end",
      message: {
        role: "assistant",
        timestamp: 1000,
        usage: { output: 7 },
        content: [{ type: "text", text: "SECRET-PROSE" }],
      },
    },
    {
      type: "tool_execution_end",
      toolName: "launch_plan",
      result: {
        content: [{ type: "text", text: "SECRET-PROSE" }],
        details: {
          results: [
            {
              agent: "pass-x--sol-high",
              stopReason: "error",
              errorMessage: "overloaded",
              messages: [
                {
                  role: "assistant",
                  timestamp: 1500,
                  usage: { output: 3 },
                  content: "SECRET-PROSE",
                },
              ],
            },
          ],
        },
      },
    },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n");

  // MUTATION: drop "timestamp" from the message keys prune_events keeps — this fails
  it("keeps timestamps, usage and lens outcomes and no text; lensfinal reads it in place of pi-events.jsonl", () => {
    const caseDir = join(tmp, "slimcase");
    mkdirSync(caseDir, { recursive: true });
    const r = pyModule(
      "export_runs",
      "from pathlib import Path\nsys.path.insert(0, 'bench/aacr/openmodels')\nimport lensfinal\n" +
        "d = Path(sys.argv[2]); pruned = h.prune_events(sys.argv[1].encode())\n" +
        "(d / h.PRUNED_EVENTS).write_bytes(pruned)\n" +
        "lines = [json.loads(l) for l in pruned.decode().splitlines()]\n" +
        "print(json.dumps({'text': b'SECRET-PROSE' in pruned, 'n': len(lines),\n" +
        "  'ts': lines[0]['message']['timestamp'], 'kid_ts': lines[1]['result']['details']['results'][0]['messages'][0]['timestamp'],\n" +
        "  'marked': all(l['_slim'] == 'pruned' for l in lines),\n" +
        "  'lost': lensfinal.lost(['pass-x--sol-high'], d / 'pi-events.jsonl')}))",
      events,
      caseDir,
    ) as Record<string, unknown>;
    expect(r).toEqual({
      text: false,
      n: 2,
      ts: 1000,
      kid_ts: 1500,
      marked: true,
      lost: [["pass-x--sol-high", "overloaded"]],
    });
  });
});

describe("hf_export.work_dir_name", () => {
  // MUTATION: return scoring_dir.split(suffix)[0] in work_dir_name — this fails
  it("names a scoring dir by its run, and keeps a variant scoring of the same run apart", () => {
    const r = py(
      "print(json.dumps([h.work_dir_name('r1-martian.martian', '.martian'), h.work_dir_name('r1-martian.martian-rescore', '.martian'),\n" +
        "  h.work_dir_name('q.qodo', '.qodo')]))",
    );
    expect(r).toEqual(["r1-martian", "r1-martian.martian-rescore", "q"]);
  });
});

describe("export_runs: stray NULs and the ripgrep re-grep", () => {
  // MUTATION: drop the text-extension clause from export_runs.is_text — this fails
  it("rewrites a log that carries a stray NUL", () => {
    const r = pyModule(
      "export_runs",
      "import collections; c = collections.Counter()\n" +
        "p = h.Processor.__new__(h.Processor)\n" +
        "data = b'ok\\x00 report: /home/alice/projects/qcr-bench-runs/runs/x\\n'\n" +
        "print(json.dumps([h.is_text(data, 'open-models/score.log'), h.is_text(data, 'figure.png'),\n" +
        "  h.rewrite(data, c).decode().split(' ', 1)[1]]))",
    );
    expect(r).toEqual([true, false, "report: <runs>/runs/x\n"]);
  });

  // MUTATION: drop SCRUB_PRIVATE_REPOS from export_runs.REGREP_RG's literal list — this fails
  it("hunts the private repository's name in the ripgrep patterns too", () => {
    const r = pyModule(
      "export_runs",
      "import re\nprint(json.dumps(any(re.search(p, b'see WidgetCo-App here') for p in h.REGREP_RG)))",
    );
    expect(r).toBe(true);
  });
});

describe("the product's earlier name in another case", () => {
  // MUTATION: drop the "old-product-name-other-case" rule from export_runs._identity_rules — this fails
  it("becomes the public name in the archive's rewrite and in the tables", () => {
    const text = "In the ACME-Reviewd benchmark and acme-reviewd footers";
    const a = pyModule(
      "export_runs",
      "import collections; print(json.dumps(h.rewrite(sys.argv[1].encode(), collections.Counter()).decode()))",
      text,
    );
    const b = py("print(json.dumps(h.scrub(sys.argv[1])))", text);
    expect(a).toBe("In the quickreview benchmark and quickreview footers");
    expect(b).toBe("In the quickreview benchmark and quickreview footers");
  });
});

describe("session_logs.classify: the session-log set, by file kind", () => {
  // MUTATION: drop "codex-sessions" from session_logs.TRANSCRIPT_DIRS — this fails
  // MUTATION: delete the fail-closed R_UNKNOWN return in session_logs.classify — this fails
  it("names every session-log kind, extracts the JSONL ones, and leaves out an unnamed log kind in a run dir", () => {
    const paths = [
      "runs/r/cases/o__r@1111111/pi-events.jsonl",
      "runs/r/cases/o__r@1111111/pi-events.rsecurity.jsonl",
      "runs/r/cases/o__r@1111111/session/2026-10-01T21-40-12-394Z_01a0f969-23e9-726f-810d-a5228a5b57f7.jsonl",
      "runs/r/cases/o__r@1111111/lens-sessions/u/2026-x.jsonl",
      "runs/r/cases/o__r@1111111/codex-sessions/rollout-1.jsonl",
      "runs/r/cases/o__r@1111111/claude-transcripts/-work-repo/u/subagents/agent-1.jsonl",
      "runs/r/cases/o__r@1111111/opencode-events.jsonl",
      "runs/r/judge/v2-gpt-6-sol-high/o__r@1111111.r1.events.jsonl",
      "runs/r/cases/o__r@1111111/pi-stderr.log",
      "runs/r/cases/o__r@1111111/codex-driver.log",
      "runs/r/cases/o__r@1111111/pragent-review.log",
      "runs/r.sandbox-commands.log",
      "runs/r/cases/o__r@1111111/system-prompt.md",
      "runs/r/cases/o__r@1111111/round-order.md",
      "runs/r/cases/o__r@1111111/tasks/01-pass-baseline--sol-high.md",
      "runs/r/cases/o__r@1111111/head-patches.json",
      "runs/r/mystery.jsonl",
      "open-models/runs/om/cases/o__r@1111111/unknown.log",
      // data: kept
      "runs/r/cases/o__r@1111111/review.md",
      "runs/r/cases/o__r@1111111/findings-record.json",
      "runs/r/cases/o__r@1111111/lens-ledger.jsonl",
      "runs/r/cases/o__r@1111111/driver.log",
      "runs/r/bridge.jsonl",
      "runs/r.martian/judge/judge.jsonl",
      "runs/r.qodo/judgements.jsonl",
      "runs/r/eval/harness-all.log",
      "runs/r.review.log",
      "open-models/full-glm53.log",
      "elo/plan/judgments/gpt.jsonl",
      "analysis/x/wp-data/logs/shim-k5-all-default-rest145.log",
    ];
    const r = pyModule(
      "session_logs",
      "print(json.dumps({p: (lambda c: None if c is None else [c[0].split(':')[0].split(',')[0], c[1]])(h.classify(p)) for p in sys.argv[1:]}))",
      ...paths,
    ) as Record<string, [string, string | null] | null>;
    const extracted = (p: string) => r[p]?.[1];
    expect(extracted("runs/r/cases/o__r@1111111/pi-events.jsonl")).toBe("pi");
    expect(extracted("runs/r/cases/o__r@1111111/pi-events.rsecurity.jsonl")).toBe("pi");
    for (const p of paths.slice(2, 8)) expect(extracted(p), p).toBe("metrics");
    for (const p of paths.slice(8, 18)) {
      expect(r[p], p).not.toBeNull();
      expect(extracted(p), p).toBeNull();
    }
    expect(r["runs/r/mystery.jsonl"]?.[0]).toBe("session log rule");
    for (const p of paths.slice(18)) expect(r[p], p).toBeNull();
  });
});

describe("session_logs.metrics_only: the generic numbers-only extract", () => {
  // MUTATION: in session_logs._metrics, return a string under any key (drop the KEEP_STR test) — this fails
  it("keeps numbers, booleans and single-token labels, and no text under any key", () => {
    const lines = [
      {
        timestamp: "2026-10-01T21:40:12.394Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { total_token_usage: { input_tokens: 10, output_tokens: 3 } },
          note: "SECRET-PROSE",
        },
      },
      {
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "SECRET-PROSE" }] },
      },
      {
        type: "assistant",
        model: "a model with spaces",
        message: { usage: { input: 5, output: 2 }, stop: true },
      },
      { type: "response_item", payload: { type: "SECRET PROSE IN A LABEL" } },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n");
    const r = pyModule(
      "session_logs",
      "out = h.metrics_only(sys.argv[1].encode()).decode()\nprint(json.dumps([json.loads(l) for l in out.splitlines()]))",
      lines,
    ) as Record<string, unknown>[];
    expect(JSON.stringify(r)).not.toMatch(/SECRET|spaces/);
    expect(r).toEqual([
      {
        _extract: "metrics",
        timestamp: "2026-10-01T21:40:12.394Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { total_token_usage: { input_tokens: 10, output_tokens: 3 } },
        },
      },
      {
        _extract: "metrics",
        type: "assistant",
        message: { usage: { input: 5, output: 2 }, stop: true },
      },
    ]);
  });
});

describe("session_logs.prune_pi: compare.py prices the extract as the full stream", () => {
  const full = [
    { type: "message_start", message: { role: "assistant", content: "SECRET-PROSE" } },
    {
      type: "message_end",
      message: {
        role: "assistant",
        timestamp: 1,
        usage: { output: 9, cost: { total: 0.1 } },
        content: "SECRET-PROSE",
      },
    },
    // call A reports lens run k1; call B reports k1 again and k2: k1 counts once
    {
      type: "tool_execution_end",
      toolName: "launch_plan",
      toolCallId: "A",
      result: {
        content: "SECRET-PROSE",
        details: {
          results: [{ id: "k1", agent: "pass-a--sol-high", usage: { cost: { total: 0.7 } } }],
        },
      },
    },
    {
      type: "tool_execution_end",
      toolName: "lens_wave",
      toolCallId: "B",
      result: {
        details: {
          results: [
            { id: "k1", agent: "pass-a--sol-high", usage: { cost: { total: 0.7 } } },
            {
              id: "k2",
              agent: "pass-b--sol-high",
              stopReason: "error",
              errorMessage: "request timed out",
              usage: { cost: { total: 0.2 } },
            },
          ],
        },
      },
    },
    // call C never ended: its largest live figure counts
    {
      type: "tool_execution_update",
      toolName: "subagent",
      toolCallId: "C",
      partialResult: {
        details: {
          results: [
            { id: "k3", usage: { cost: { total: 0.3 } }, messages: [{ content: "SECRET-PROSE" }] },
          ],
        },
      },
    },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n");

  // MUTATION: keep only tool_execution_end in session_logs.prune_pi (drop the update events) — this fails
  // MUTATION: drop "id" from session_logs._lens_result — this fails
  it("keeps every field pi_cost reads, the error as a class, and no text", () => {
    const r = pyModule(
      "session_logs",
      "import compare\npruned = h.prune_pi(sys.argv[1].encode())\n" +
        "kid = [json.loads(l) for l in pruned.decode().splitlines()][2]['result']['details']['results'][1]\n" +
        "print(json.dumps({'full': round(compare.pi_cost_lines(sys.argv[1].encode().splitlines()), 9),\n" +
        "  'pruned': round(compare.pi_cost_lines(pruned.splitlines()), 9), 'text': b'SECRET' in pruned or b'timed out' in pruned,\n" +
        "  'error': kid.get('errorClass'), 'message': 'errorMessage' in kid}))",
      full,
    );
    expect(r).toEqual({ full: 1.3, pruned: 1.3, text: false, error: "timeout", message: false });
  });
});

describe("export_runs: a run ships without its session logs", () => {
  const root = join(tmp, "sessions");
  const src = join(root, "bench-runs");
  const c = join(src, "runs", "r1", "cases", "o__r@1111111");
  put(join(src, "runs", "r1", "run.json"), '{\n  "set": "dev10",\n  "qcr_commit": "aaa1111"\n}\n');
  put(
    join(c, "pi-events.jsonl"),
    JSON.stringify({
      type: "message_end",
      message: { role: "assistant", timestamp: 5, usage: { output: 1 }, content: "SECRET-PROSE" },
    }) + "\n",
  );
  put(
    join(c, "session", "2026-10-01T00-00-00-000Z_01a0f969-23e9-726f-810d-a5228a5b57f7.jsonl"),
    '{"type":"message","message":{"content":"SECRET-PROSE","usage":{"input":4}}}\n',
  );
  put(join(c, "system-prompt.md"), "SECRET-PROSE\n");
  put(join(c, "tasks", "01-pass-x--sol-high.md"), "SECRET-PROSE\n");
  put(join(c, "pi-stderr.log"), "SECRET-PROSE\n");
  put(join(c, "review.md"), "the review\n");
  put(join(c, "case-summary.json"), '{"fingerprint": {"qcr_commit": "ccc3333"}}\n');
  put(join(c, "dirty-summary.json"), '{"fingerprint": {"qcr_commit": "ddd4444-dirty"}}\n');
  put(join(src, "runs", "r1", "mystery.jsonl"), '{"text":"SECRET-PROSE"}\n');
  put(join(src, "runs", "r1.sandbox-commands.log"), "SECRET-PROSE\n");
  put(join(src, "runs", "r1.review.log"), "progress\n");
  put(join(src, "runs", "pc2-dev10", "run.json"), "{}");
  const catalogue = join(root, "catalogue.json");
  writeFileSync(
    catalogue,
    JSON.stringify({
      families: [
        {
          id: "f",
          title: "F",
          location: "qcr-bench-runs/runs/",
          members: ["r1", "pc2-dev10"],
          ship: "yes",
          hf_tables: [],
        },
      ],
    }),
  );

  // MUTATION: make export_runs.Processor.arc_rel return rel unchanged — this fails
  // MUTATION: drop the OWNER_WITHHELD_PREFIXES check from export_runs.drop_reason — this fails
  it("ships extracts in place of JSONL session logs, leaves out the rest, and withholds pc2 whatever the catalogue says", () => {
    const r = pyModule(
      "export_runs",
      "import collections\nfrom pathlib import Path\nimport release_catalogue as RC\n" +
        "p = h.Processor(Path(sys.argv[1]), None, RC.Catalogue.load(sys.argv[2]), {'aaa1111': 'bbb2222', 'ccc3333': None, 'ddd4444-dirty': 'eee5555'},\n" +
        "  {'aaa1111': {'recorded': 'aaa1111', 'match': 'same'}, 'ddd4444-dirty': {'recorded': 'ddd4444-dirty', 'match': 'ancestor'}})\n" +
        "out = {}\n" +
        "for rel in h.walk_files(p.src, None):\n" +
        "    data, why = p.process(rel, collections.Counter())\n" +
        "    out[rel] = [p.arc_rel(rel), why is None, None if data is None else (b'SECRET' in data), None if data is None else data.decode()]\n" +
        "print(json.dumps(out))",
      src,
      catalogue,
    ) as Record<string, [string, boolean, boolean | null, string | null]>;
    const base = "runs/r1/cases/o__r@1111111";
    expect(r[`${base}/pi-events.jsonl`]?.slice(0, 3)).toEqual([
      `${base}/pi-events.pruned.jsonl`,
      true,
      false,
    ]);
    const sess = Object.keys(r).find((k) => k.includes("/session/"))!;
    expect(r[sess]?.[0]).toMatch(/\.pruned\.jsonl$/);
    expect(r[sess]?.slice(1, 3)).toEqual([true, false]);
    for (const k of [
      `${base}/system-prompt.md`,
      `${base}/tasks/01-pass-x--sol-high.md`,
      `${base}/pi-stderr.log`,
      "runs/r1/mystery.jsonl",
      "runs/r1.sandbox-commands.log",
      "runs/pc2-dev10/run.json",
    ]) {
      expect(r[k]?.[1], k).toBe(false);
    }
    expect(r[`${base}/review.md`]?.slice(1, 3)).toEqual([true, false]);
    expect(r["runs/r1.review.log"]?.[1]).toBe(true);
    // MUTATION: drop the `false`/`null` branch of export_runs.remap_commits — this fails
    // MUTATION: drop the `"qcr_commit_dirty"` insertion from export_runs.remap_commits — this fails
    // MUTATION: drop the `"qcr_commit_match"` insertion from export_runs.remap_commits — this fails
    expect(JSON.parse(r["runs/r1/run.json"]![3]!)).toEqual({
      set: "dev10",
      qcr_commit: "bbb2222",
      qcr_commit_on_public_main: true,
      qcr_commit_match: "same",
      qcr_commit_dirty: false,
    });
    expect(JSON.parse(r[`${base}/case-summary.json`]![3]!)).toEqual({
      fingerprint: {
        qcr_commit: "ccc3333",
        qcr_commit_on_public_main: false,
        qcr_commit_match: null,
        qcr_commit_dirty: false,
      },
    });
    // a dirty build maps to the commit it was built on, keeps its suffix and is flagged
    // MUTATION: make release_catalogue.commit_fields return "qcr_commit_dirty": False always — this fails
    expect(JSON.parse(r[`${base}/dirty-summary.json`]![3]!)).toEqual({
      fingerprint: {
        qcr_commit: "eee5555-dirty",
        qcr_commit_on_public_main: true,
        qcr_commit_match: "ancestor",
        qcr_commit_dirty: true,
      },
    });
  });

  it("counts a session log among a volume's members, never its extract", () => {
    const r = pyModule(
      "export_runs",
      "print(json.dumps(sum(h.session_members(sys.argv[1:]).values())))",
      "runs/r/cases/x@1/pi-events.jsonl",
      "runs/r/cases/x@1/pi-events.pruned.jsonl",
      "runs/r/cases/x@1/review.md",
    );
    expect(r).toBe(1);
  });
});

describe("the authors' tracker becomes <ticket>", () => {
  // Fake ids, built at run time so this file carries no ticket-id-shaped literal: the 9xxx range
  // and 0999 are not tickets.
  const id = (n: string): string => ["FT", n].join("-");
  const lower = (n: string): string => ["ft", n].join("");
  // MUTATION: drop *SX.ticket_rules() from export_runs.NAME_RULES — this fails
  // MUTATION: drop SX.ticket_rules_str() from hf_export.SCRUB_RULES — this fails
  // MUTATION: drop the "ticket-id-lower" rule from scrub_extra.TICKET_RULES — this fails
  it("rewrites ticket ids and tracker paths in the archive and the tables, run names included", () => {
    const text =
      `Per ${id("9622")} and ${id("9550").toLowerCase()} (see ${id("9517").replace("-", "")}); ` +
      `notes in ../x/${["tracker", "efforts"].join("/")}/y/tickets/${id("9999")}-x.md; ` +
      `image qcr-bench:${lower("0999")}; run ${lower("0998")}-hard20-sonnet and ${id("12345")} stay.`;
    const want =
      "Per <ticket> and <ticket> (see <ticket>); notes in <ticket>; image qcr-bench:<ticket>; " +
      `run <ticket>-hard20-sonnet and ${id("12345")} stay.`;
    const a = pyModule(
      "export_runs",
      "import collections; print(json.dumps(h.rewrite(sys.argv[1].encode(), collections.Counter()).decode()))",
      text,
    );
    const b = py("print(json.dumps(h.scrub(sys.argv[1])))", text);
    expect(a).toBe(want);
    expect(b).toBe(want);
  });

  // MUTATION: drop *SX.rename_rules() from export_runs.NAME_RULES — this fails
  // MUTATION: drop SX.rename_rules_str() from hf_export.SCRUB_RULES — this fails
  // MUTATION: move *SX.rename_rules() after *SX.ticket_rules() in export_runs.NAME_RULES — this fails
  it("renames a study's run-name prefix ($QCR_SCRUB_RENAMES) before the tracker's rules see it", () => {
    const env = { QCR_SCRUB_RENAMES: `${lower("0998")}=study,${id("0998")}=study` };
    const text =
      `run ${lower("0998")}-hard20-sonnet, plan martian-hard20-${lower("0998")}, ` +
      `title "${id("0998")} probes", x${lower("0998")} and ${lower("0998")}1.`;
    const want =
      'run study-hard20-sonnet, plan martian-hard20-study, title "study probes", ' +
      `x${lower("0998")} and ${lower("0998")}1.`;
    const a = pyEnv(
      env,
      "export_runs",
      "import collections; print(json.dumps(h.rewrite(sys.argv[1].encode(), collections.Counter()).decode()))",
      text,
    );
    const b = pyEnv(env, "hf_export", "print(json.dumps(h.scrub(sys.argv[1])))", text);
    const n = pyEnv(
      env,
      "export_runs",
      "import collections; print(json.dumps(h.rewrite_name(sys.argv[1], collections.Counter())))",
      `runs/${lower("0998")}-hard20-qr/cases/x/review.md`,
    );
    expect(a).toBe(want);
    expect(b).toBe(want);
    expect(n).toBe("runs/study-hard20-qr/cases/x/review.md");
  });

  // MUTATION: drop the SX.renamed() of family ids in release_catalogue.Catalogue.__init__ — this fails
  it("names a renamed study's families (and so its volumes) by the new name, and still finds its source dirs", () => {
    const env = { QCR_SCRUB_RENAMES: `${lower("0998")}=study` };
    const fam = `${lower("0998")}-claude-code-high`;
    const unit = `${lower("0998")}-hard20-cc-high-opus55`;
    const r = pyEnv(
      env,
      "release_catalogue",
      "c = h.Catalogue({'families': [{'id': sys.argv[1], 'location': 'qcr-bench-runs/runs/', 'members': [sys.argv[2]], " +
        "'ship': 'yes'}]}); f = c.family_of('runs', sys.argv[2]); print(json.dumps([f['id'], list(c.families)]))",
      fam,
      unit,
    );
    expect(r).toEqual(["study-claude-code-high", ["study-claude-code-high"]]);
  });
});

describe("key_data: the answer key's build, as data", () => {
  const src = join(tmp, "keydata");
  const d = join(src, "rest145-code", "o__r@1111111");
  put(
    join(d, "candidates-key.json"),
    JSON.stringify({ C2: "all-low-rest145", C1: "all-ocr-rest145" }),
  );
  put(
    join(d, "candidates.json"),
    JSON.stringify({
      candidates: [{ cand: "C1", path: "a.py", from_line: 3, to_line: 4, text: "t" }],
    }),
  );
  put(join(d, "new-candidates-key.json"), JSON.stringify({ N1: "codex" }));
  put(
    join(d, "diff.stat"),
    " a.py | 4 +++-\n 2 files changed, 85 insertions(+), 36 deletions(-)\n",
  );
  put(
    join(src, "fresh10-code", "o__r@1111111", "diff.stat"),
    " 2 files changed, 85 insertions(+), 36 deletions(-)\n",
  );
  put(join(src, "orig40-code", "p__q@2222222", "diff.stat"), " 1 file changed, 7 insertions(+)\n");

  // MUTATION: make changed_lines insertions alone in key_data.parse_diffstat — this fails
  it("maps each candidate to who raised it and sizes each PR from its diff.stat", () => {
    const r = pyModule(
      "key_data",
      "print(json.dumps([[[x['candidate'], x['round'], x['raised_by'], x['path']] for x in h.candidate_rows(sys.argv[1])],\n" +
        "  [[x['instance_id'], x['files_changed'], x['insertions'], x['deletions'], x['changed_lines'], x['code_dirs']] for x in h.diffstat_rows(sys.argv[1])]]))",
      src,
    );
    expect(r).toEqual([
      [
        ["C1", "candidates", "all-ocr-rest145", "a.py"],
        ["C2", "candidates", "all-low-rest145", null],
        ["N1", "new-candidates", "codex", null],
      ],
      [
        ["o__r@1111111", 2, 85, 36, 121, ["rest145-code", "fresh10-code"]],
        ["p__q@2222222", 1, 7, 0, 7, ["orig40-code"]],
      ],
    ]);
  });
});

describe("session_logs: fail closed beyond the run dirs, and prompt files by kind", () => {
  // MUTATION: in session_logs.classify, apply the R_UNKNOWN rule only when run_inner(rel) is not None — this fails
  // MUTATION: drop the `.aborted` return in session_logs.classify — this fails
  // MUTATION: drop TASK_FILE from session_logs.classify — this fails
  // MUTATION: drop the analysis/relabel label-file rule from session_logs.TREE_LOGS — this fails
  it("leaves out an unnamed log kind anywhere, an aborted run's log and a session's task file; keeps the named harness logs", () => {
    const paths = [
      "logs/rerun-x.log.aborted",
      "analysis/x/wp-data/logs/notes.log",
      "elo/plan/stray.jsonl",
      "open-models/sub/driver.log",
      "runs/r/mystery.log",
      "runs/r/cases/o__r@1111111/validate-task.md",
      "analysis/relabel/notes.jsonl",
      // data: kept
      "logs/rerun-x.log",
      "elo/plan/run.log",
      "elo/plan/units.jsonl",
      "analysis/x/wp-data/logs/selfcons-all-claude-c1-rest145.log",
      "runs/r.judge-opus.log",
      "runs/r.launch.log",
      "runs/r/cases/o__r@1111111/ledger.md",
      "analysis/relabel/lost_credit.labels.jsonl",
    ];
    const r = pyModule(
      "session_logs",
      "print(json.dumps({p: h.classify(p) is not None for p in sys.argv[1:]}))",
      ...paths,
    ) as Record<string, boolean>;
    for (const p of paths.slice(0, 7)) expect(r[p], p).toBe(true);
    for (const p of paths.slice(7)) expect(r[p], p).toBe(false);
  });
});

/** What strip_session_fields returns for the documents of the test below. */
interface Extracted {
  review_output?: string[];
  stdout_extract?: {
    events: Record<string, number>;
    items_completed: Record<string, number>;
    usage: object[];
  };
  stderr_extract?: { error_class: string };
  argv?: string[];
  permission_denials_count?: number;
  result?: string;
}

describe("session_logs.strip_session_fields: session text inside kept JSON files", () => {
  const stream = [
    { type: "thread.started", thread_id: "t" },
    {
      type: "item.completed",
      item: { type: "command_execution", command: "cat SECRET", aggregated_output: "SECRET-CODE" },
    },
    { type: "item.completed", item: { type: "agent_message", text: "SECRET-PROSE" } },
    { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 3 } },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n");

  // MUTATION: in session_logs.strip_session_fields, keep `stdout` (drop the `del obj[k]`) — this fails
  // MUTATION: in session_logs._argv_clean, keep every element — this fails
  it("turns a result's stdout and stderr into numbers, a prompt argument and a template into hashes, denied commands into a count", () => {
    const docs: [string, unknown][] = [
      [
        "runs/r/results/all/o__r@1111111.json",
        { review_output: ["kept"], stdout: stream, stderr: "Error: SECRET timed out" },
      ],
      [
        "runs/r/cases/o__r@1111111/codex-driver.json",
        { argv: ["codex", "exec", "SECRET-PROMPT ".repeat(40)] },
      ],
      [
        "runs/r/cases/o__r@1111111/opencode-argv.json",
        ["opencode", "run", "line one\nSECRET-PROMPT"],
      ],
      [
        "runs/r/cases/o__r@1111111/opencode-config.json",
        { command: { review: { template: "SECRET-PROMPT", subtask: false } } },
      ],
      [
        "runs/r/cases/o__r@1111111/claude-stdout.json",
        { result: "the review", permission_denials: [{ tool_input: { command: "ls SECRET" } }] },
      ],
    ];
    const r = pyModule(
      "session_logs",
      "import collections\nc = collections.Counter()\n" +
        "out = [h.strip_session_fields(rel, doc, c) for rel, doc in json.loads(sys.argv[1])]\n" +
        "print(json.dumps([out, dict(c)]))",
      JSON.stringify(docs),
    ) as [Extracted[], Record<string, number>];
    const text = JSON.stringify(r[0]);
    expect(text).not.toContain("SECRET");
    const res = r[0][0]!;
    expect(res.review_output).toEqual(["kept"]);
    expect(res.stdout_extract!.events).toEqual({
      "thread.started": 1,
      "item.completed": 2,
      "turn.completed": 1,
    });
    expect(res.stdout_extract!.items_completed).toEqual({ command_execution: 1, agent_message: 1 });
    expect(res.stdout_extract!.usage).toEqual([{ input_tokens: 10, output_tokens: 3 }]);
    expect(res.stderr_extract!.error_class).toBe("timeout");
    expect(r[0][1]!.argv!.slice(0, 2)).toEqual(["codex", "exec"]);
    expect(r[0][1]!.argv![2]).toMatch(/^\[prompt omitted: sha256:[0-9a-f]{16}, \d+ chars\]$/);
    expect(r[0][4]!.permission_denials_count).toBe(1);
    expect(r[0][4]!.result).toBe("the review");
  });

  // MUTATION: drop the "event stream (aggregated_output)" entry from session_logs.CONTENT_MARKERS — this fails
  it("finds session text left in a data file, and never flags code", () => {
    const r = pyModule(
      "session_logs",
      "print(json.dumps([h.content_markers(p, sys.argv[2].encode()) for p in ('runs/r/x.json', 'analysis/a/parse.py')]))",
      "",
      '{"other": "{\\"aggregated_output\\": \\"code\\"}"}',
    ) as string[][];
    expect(r[0]).toEqual(["event stream (aggregated_output)"]);
    expect(r[1]).toEqual([]);
  });

  // MUTATION: in session_logs.strip_prompt_lines, keep lines found in the prompts — this fails
  it("removes the lines a ledger copied from its case's prompt files", () => {
    const r = pyModule(
      "session_logs",
      "print(json.dumps(h.strip_prompt_lines(sys.argv[1], [sys.argv[2]])))",
      "# Ledger\n===ROUNDORDER===\nRun the full round from your system prompt now.\nfound a bug in a.py\n",
      "Run the full round from your system prompt now.\n",
    );
    expect(r).toEqual(["# Ledger\nfound a bug in a.py\n", 2]);
  });
});

describe("export_runs: third-party and session text inside kept files", () => {
  const root = join(tmp, "fields");
  const src = join(root, "bench-runs");
  const om = join(root, "om");
  const iid = "o__r@1111111";
  put(
    join(src, "runs", "r1", "results", "all", `${iid}.json`),
    JSON.stringify({ review_output: ["kept"], stdout: '{"type":"thread.started"}\n', stderr: "" }),
  );
  put(
    join(src, "runs", "r1", "results", "all", "odd.json"),
    JSON.stringify({ note: '{"type":"item.completed","item":{"aggregated_output":"SECRET"}}' }),
  );
  put(
    join(src, "runs", "r1", "cases", iid, "pragent-description.md"),
    "<!-- pr-agent-generated -->\n### **User description**\nSECRET-BODY by the author\n\n### **PR Type**\nBug fix\n",
  );
  put(
    join(src, "runs", "r1", "cases", iid, "pragent-describe.json"),
    JSON.stringify({
      pr_text: "SECRET-BODY",
      published_description: {
        title: "t",
        body: "### **User description**\nSECRET-BODY\n### **PR Type**\nx",
      },
    }),
  );
  put(
    join(src, "runs", "r1", "cases", iid, "round-order.md"),
    "===ROUNDORDER===\nYou are this PR's only shepherd, keep going.\n",
  );
  put(
    join(src, "runs", "r1", "cases", iid, "ledger.md"),
    "# L\n===ROUNDORDER===\nYou are this PR's only shepherd, keep going.\nnote\n",
  );
  put(
    join(src, "runs", "r1.martian", "results", "j", "candidates.json"),
    JSON.stringify({
      u: {
        quickreview: [{ text: "ours" }],
        "rejudged-cubic-v2": [{ text: "VENDOR-CANDIDATE", line: 3 }],
      },
    }),
  );
  put(
    join(src, "runs", "r1.martian", "results", "j", "evaluations.json"),
    JSON.stringify({
      u: {
        "rejudged-cubic-v2": {
          true_positives: [{ matched_candidate: "VENDOR-MATCHED" }],
          false_positives: [{ candidate: "VENDOR-UNMATCHED" }],
        },
      },
    }),
  );
  put(
    join(src, "runs", "r1.martian", "benchmark_data.json"),
    JSON.stringify({
      "https://x/pull/2": {
        reviews: [
          { tool: "rejudged-cubic-v2", review_comments: [{ body: "SECRET-VENDOR-BODY", line: 4 }] },
        ],
      },
    }),
  );
  put(
    join(src, "analysis", "a1", "fair", "secret.json"),
    JSON.stringify({
      C1: { tool: "cubic-v2", pr: "u", text: "VENDOR-FAIR" },
      C2: { tool: "quickreview", pr: "u", text: "ours" },
    }),
  );
  put(
    join(om, "sets-low", "s.json"),
    JSON.stringify({
      cases: [{ instance_id: iid, pr_url: "https://x/pull/1", body: "SECRET-BODY" }],
    }),
  );
  put(join(om, "runs", ".keep"), "");
  const catalogue = join(root, "catalogue.json");
  writeFileSync(
    catalogue,
    JSON.stringify({
      families: [
        {
          id: "f",
          title: "F",
          location: "qcr-bench-runs/runs/",
          members: ["r1"],
          ship: "yes",
          hf_tables: [],
        },
        {
          id: "d",
          title: "D",
          location: "open-models/",
          members: ["sets-low"],
          ship: "yes",
          hf_tables: [],
        },
        {
          id: "analysis",
          title: "A",
          location: "qcr-bench-runs/",
          members: ["analysis"],
          ship: "yes",
          hf_tables: [],
        },
      ],
    }),
  );

  // MUTATION: drop the SL.content_markers check from export_runs.Processor.process — this fails
  // MUTATION: drop the pragent_description_md branch from export_runs.Processor.process — this fails
  // MUTATION: drop the martian_benchmark_data branch from export_runs.Processor.process — this fails
  // MUTATION: restore a branch that sends results/<judge>/candidates.json, evaluations.json or
  //           analysis/…/fair/secret.json through omitted() — this fails
  it("rewrites results, PR bodies, vendor review bodies and copied prompt lines, ships the judge's vendor candidates verbatim, and leaves out a file still holding a stream", () => {
    const r = pyModule(
      "export_runs",
      "import collections\nfrom pathlib import Path\nimport release_catalogue as RC\n" +
        "p = h.Processor(Path(sys.argv[1]), Path(sys.argv[3]), RC.Catalogue.load(sys.argv[2]), {})\n" +
        "out = {}\n" +
        "for rel in h.walk_files(p.src, p.om):\n" +
        "    data, why = p.process(rel, collections.Counter())\n" +
        "    out[rel] = [why, None if data is None else data.decode()]\n" +
        "print(json.dumps(out))",
      src,
      catalogue,
      om,
    ) as Record<string, [string | null, string | null]>;
    const base = `runs/r1/cases/${iid}`;
    for (const [k, v] of Object.entries(r)) {
      if (v[1] !== null)
        expect(v[1], k).not.toMatch(
          /SECRET|"type": ?"thread\.started"|only shepherd|User description/,
        );
    }
    expect(JSON.parse(r[`runs/r1/results/all/${iid}.json`]![1]!).stdout_extract.events).toEqual({
      "thread.started": 1,
    });
    expect(r["runs/r1/results/all/odd.json"]![0]).toMatch(/still carries session or prompt text/);
    expect(r[`${base}/pragent-description.md`]![1]).toContain("third-party text omitted");
    expect(r[`${base}/pragent-description.md`]![1]).toContain("### **PR Type**");
    expect(r[`${base}/ledger.md`]![1]).toBe("# L\nnote\n");
    expect(r[`${base}/round-order.md`]![1]).toBeNull();
    const cands = JSON.parse(r["runs/r1.martian/results/j/candidates.json"]![1]!);
    expect(cands.u.quickreview[0].text).toBe("ours");
    expect(cands.u["rejudged-cubic-v2"][0]).toEqual({ text: "VENDOR-CANDIDATE", line: 3 });
    const evals = JSON.parse(r["runs/r1.martian/results/j/evaluations.json"]![1]!);
    expect(evals.u["rejudged-cubic-v2"].true_positives[0].matched_candidate).toBe("VENDOR-MATCHED");
    expect(evals.u["rejudged-cubic-v2"].false_positives[0].candidate).toBe("VENDOR-UNMATCHED");
    const fair = JSON.parse(r["analysis/a1/fair/secret.json"]![1]!);
    expect(fair.C1.text).toBe("VENDOR-FAIR");
    expect(fair.C2.text).toBe("ours");
    const bodies = JSON.parse(r["runs/r1.martian/benchmark_data.json"]![1]!);
    const body = bodies["https://x/pull/2"].reviews[0].review_comments[0];
    expect(body.body).toMatch(
      /^\[third-party text omitted, sha256:[0-9a-f]+; see https:\/\/github\.com\/withmartian\//,
    );
    expect(body.line).toBe(4);
    expect(JSON.parse(r["open-models/sets-low/s.json"]![1]!).cases[0].body).toContain(
      "https://x/pull/1",
    );
  });
});

describe("export_runs.regrep_failures: the re-grep is a gate", () => {
  // MUTATION: make export_runs.regrep_failures return [] — this fails
  it("fails on any identity, ticket or session-text count and on a fixture class over its ceiling", () => {
    const r = pyModule(
      "export_runs",
      "import collections\nprint(json.dumps(h.regrep_failures(collections.Counter(json.loads(sys.argv[1])), json.loads(sys.argv[2]))))",
      JSON.stringify({
        "owner name 0 (any case)": 0,
        "ticket id (FT-NNNN)": 1,
        "session text: event stream (aggregated_output)": 2,
        "Google API key-shaped (AIza)": 5,
        "JWT-shaped (eyJ..eyJ..)": 3,
        "quickchat (any case)": 9,
        "companion-pihome": 2,
      }),
      JSON.stringify({ "Google API key-shaped (AIza)": 4, "JWT-shaped (eyJ..eyJ..)": 3 }),
    ) as string[];
    expect(r).toEqual([
      "Google API key-shaped (AIza): 5 (allowed 4)",
      "session text: event stream (aggregated_output): 2",
      "ticket id (FT-NNNN): 1",
    ]);
  });
});

describe("export_runs: member names stay unique, and an unknown run suffix is its own unit", () => {
  // MUTATION: in export_runs.Tree.run_of, accept any `.` suffix again — this fails
  it("strips only the known scoring and log suffixes", () => {
    const r = pyModule(
      "export_runs",
      "print(json.dumps([h.strip_run_suffix(n) for n in sys.argv[1:]]))",
      "r1.martian",
      "r1.review.log",
      "r1.qodo-rescore",
      "r1.newthing",
      "r1",
    );
    expect(r).toEqual(["r1", "r1", "r1", "r1.newthing", "r1"]);
  });
});

describe("verify_slim.summary_failures: the bundle check fails on what it finds", () => {
  // MUTATION: make verify_slim.summary_failures return [] — this fails
  it("fails on an unlisted file, a skipped or different scoring dir, a differing table or chart", () => {
    const r = pyModule(
      "verify_slim",
      "print(json.dumps(h.summary_failures(json.loads(sys.argv[1]))))",
      JSON.stringify({
        hash_mismatches: 0,
        unlisted_files: 1,
        session_text_files: 0,
        martian: { identical: 3, "SKIPPED: judge output but no martian-scores.json": 1 },
        qodo: { identical: 2, "numbers identical, scores.md text differs": 1 },
        compare_vs_full: { a: "identical", b: "2 diff lines" },
        charts: ["final IDENTICAL to", "study DIFFER from"],
      }),
    ) as string[];
    expect(r).toEqual([
      "unlisted_files: 1",
      "martian: {'identical': 3, 'SKIPPED: judge output but no martian-scores.json': 1}",
      "compare.py b: 2 diff lines",
      "study DIFFER from",
    ]);
  });
});

describe("hf_export: what a re-judge needs", () => {
  // MUTATION: in priority_confidence, take the last footer entry on the line instead of the first — this fails
  // MUTATION: drop the `/(\d…)` alternative (the older `_(P1/0.99, …)_` footer) from PRIORITY_RE — this fails
  it("reads QuickReview's priority and confidence from either footer form, the first entry of a merged footer", () => {
    const r = py(
      "xs = ['[blocker] a\\n\\n_P1 · confidence 0.99 · lens pass-baseline_', '[nit] b _(P3/0.88, pass-style)_. more',\n" +
        "  'c\\n\\n_P2 · confidence 0.98 · lens x_; _P3 · confidence 0.95 · lens y_', 'P1 in prose, confidence 1',\n" +
        "  'see _P2 · confidence 0.9_ above\\n\\n_P3 · confidence 0.5 · lens z_']\n" +
        "print(json.dumps([h.priority_confidence(x) for x in xs]))",
    );
    expect(r).toEqual([
      ["P1", 0.99],
      ["P3", 0.88],
      ["P2", 0.98],
      [null, null],
      ["P3", 0.5],
    ]);
  });

  // MUTATION: in pr_meta, read the case's base_commit as its merge_base — this fails
  it("reads each key PR's title and merge base from the answer key's case dirs", () => {
    const src = join(tmp, "pr-meta");
    const meta = (iid: string, title: string, base: string, mb: string) =>
      JSON.stringify({
        instance_id: iid,
        title,
        base_commit: base.repeat(40),
        merge_base: mb.repeat(40),
      });
    put(
      join(src, "rest145-code", "o__r@1111111", "meta.json"),
      meta("o__r@1111111", "Fix it", "a", "b"),
    );
    put(
      join(src, "orig40-code", "o__s@2222222", "meta.json"),
      meta("o__s@2222222", "Other", "c", "c"),
    );
    put(join(src, "fresh10-code", "gt-A.json"), "{}");
    put(join(src, "runs", "x", "meta.json"), meta("o__t@3333333", "not a key dir", "d", "e"));
    const r = py("print(json.dumps(h.pr_meta(sys.argv[1])))", src);
    expect(r).toEqual({
      "o__r@1111111": { title: "Fix it", merge_base: "b".repeat(40) },
      "o__s@2222222": { title: "Other", merge_base: "c".repeat(40) },
    });
  });

  // MUTATION: return {} from ingest_relabels — this fails
  // MUTATION: in ingest_relabels, relabel a `rejudged-*` tool too — this fails
  // MUTATION: in ingest_relabels, relabel a tool when any one of its reviews carries the run's note — this fails
  it("relabels a run's reviews that its ingest recorded under another tool's name, never a vendor's", () => {
    const note = (tool: string, run: string) =>
      `https://x/pull/1 (${tool}, bench run ${run}; not posted)`;
    const bench = {
      u1: {
        reviews: [
          { tool: "claude-code", pr_url: note("claude-code", "fast1-m50") },
          { tool: "rejudged-claude-code", pr_url: note("rejudged-claude-code", "fast1-m50") },
          { tool: "mixed", pr_url: note("mixed", "fast1-m50") },
        ],
      },
      u2: {
        reviews: [
          { tool: "quickreview", pr_url: note("quickreview", "fast1-m50") },
          { tool: "claude-code", pr_url: note("claude-code", "fast1-m50") },
          { tool: "mixed", pr_url: "https://github.com/o/r/pull/2" },
        ],
      },
    };
    const r = py(
      "b = json.loads(sys.argv[1])\n" +
        "print(json.dumps([h.ingest_relabels(b, 'fast1-m50', 'quickreview'), h.ingest_relabels(b, 'other', 'quickreview'),\n" +
        "  h.ingest_relabels(b, 'fast1-m50', None)]))",
      JSON.stringify(bench),
    );
    expect(r).toEqual([{ "claude-code": "quickreview" }, {}, {}]);
  });

  // MUTATION: in merge_scores, average the two precisions instead of recomputing from the summed counts — this fails
  it("merges two score records over disjoint PRs as Martian's scorer would score them together", () => {
    const r = py(
      "a = {'core': {'tp': 1, 'fp': 3, 'fn': 1, 'precision': 0.25, 'recall': 0.5, 'prs': 1}}\n" +
        "b = {'core': {'tp': 9, 'fp': 1, 'fn': 9, 'precision': 0.9, 'recall': 0.5, 'prs': 49}}\n" +
        "print(json.dumps(h.merge_scores(a, b)['core']))",
    ) as Record<string, number>;
    expect([r.tp, r.fp, r.fn, r.prs]).toEqual([10, 4, 10, 50]);
    expect(r.precision).toBeCloseTo(10 / 14, 12);
    expect(r.recall).toBeCloseTo(0.5, 12);
    expect(r.f1).toBeCloseTo((2 * (10 / 14) * 0.5) / (10 / 14 + 0.5), 12);
    expect(r.f2).toBeCloseTo((5 * (10 / 14) * 0.5) / (4 * (10 / 14) + 0.5), 12);
  });

  // MUTATION: in posted_beyond_page, slice from 0 instead of MI.GITHUB_PAGE — this fails
  it("gives the inline comments beyond Martian's 30-item page: QuickReview's posted ones, an arm's findings", () => {
    const run = join(tmp, "beyond");
    const id = "o__r@4444444";
    const posted = Array.from({ length: 33 }, (_, i) => ({
      path: "a.py",
      line: i + 1,
      side: "RIGHT",
      body: i === 31 ? "" : `c${i + 1}`,
    }));
    put(join(run, "cases", id, "comments.json"), JSON.stringify(posted));
    const rows = Array.from({ length: 32 }, (_, i) => ({
      path: "b.py",
      start_line: i,
      end_line: i === 31 ? null : i + 1,
      content: ` f${i + 1} `,
    }));
    put(join(run, "results", "all", `${id}.json`), JSON.stringify({ review: { comments: rows } }));
    const r = py(
      "print(json.dumps([h.posted_beyond_page(sys.argv[1], sys.argv[2], None), h.posted_beyond_page(sys.argv[1], sys.argv[2], 'pragent')]))",
      run,
      id,
    );
    expect(r).toEqual([
      [
        { path: "a.py", line: 31, body: "c31" },
        { path: "a.py", line: 33, body: "c33" },
      ],
      [
        { path: "b.py", line: 31, body: "f31" },
        { path: "b.py", line: 31, body: "f32" },
      ],
    ]);
  });

  // MUTATION: drop the dropped-key clause from martian_judge_settings — this fails
  // MUTATION: in martian_judge_settings, count the temperature probe as a call — this fails
  it("states a Martian scoring dir's judge from its own record: model, effort, verbosity, backend, dropped keys", () => {
    const d = join(tmp, "mjudge", "w.martian");
    put(
      join(d, "judge", "JUDGE.txt"),
      "gpt-6.1-sol, reasoning effort low, via bench/aacr/ext/ext_judge.py (ChatGPT login, refresh-disabled copy)\n",
    );
    const call = (dropped: string[]) =>
      JSON.stringify({
        model: "gpt-6.1-sol",
        served_model: "gpt-6.1-sol",
        effort: "low",
        dropped,
        status: 200,
      });
    put(
      join(d, "judge", "judge.jsonl"),
      [
        JSON.stringify({
          probe: "temperature",
          accepted: false,
          status: 400,
          model: "gpt-6.1-sol",
          effort: "low",
        }),
        call(["temperature"]),
        call(["max_completion_tokens", "temperature"]),
        call(["temperature"]),
        "",
      ].join("\n"),
    );
    put(
      join(d, "judge", "container.log"),
      "ext-judge on 0.0.0.0:8765 → https://chatgpt.com/backend-api/codex/responses (gpt-6.1-sol, effort low, max in flight 64) t\n",
    );
    const bare = join(tmp, "mjudge", "bare.martian");
    put(
      join(bare, "judge", "JUDGE.txt"),
      "gpt-6.1-sol, reasoning effort low, via ext_judge.py (ChatGPT login)",
    );
    const r = py(
      "print(json.dumps([h.martian_judge_settings(p) for p in sys.argv[1:]]))",
      d,
      bare,
      join(tmp, "mjudge", "none"),
    ) as (string | null)[];
    expect(r[0]).toBe(
      "gpt-6.1-sol served all 3 calls of Martian's steps 2, 2.5 and 3 (extraction, de-duplication, judging); " +
        "reasoning effort low; verbosity medium (ext_judge.py's default; the judge was started without --verbosity); " +
        "backend https://chatgpt.com/backend-api/codex/responses (ChatGPT login, refresh-disabled copy); " +
        "dropped by the bridge before the upstream: max_completion_tokens (1 of 3 requests), temperature (3 of 3 requests); " +
        "the upstream rejects temperature: the start probe got HTTP 400",
    );
    expect(r[1]).toContain("no request log in this dir");
    expect(r[2]).toBeNull();
  });

  // MUTATION: in cited, drop the `arm=`/`done=` selector arms — this fails
  // MUTATION: in claim_links, stop adding an arm's runs to its units — this fails
  // MUTATION: in cited, scan a martian key's segments for arm ids like a script's key — this fails (the tool label
  //           quickreview-frozen is also an AACR arm id)
  it("links each claim group to the arms and runs its q keys read", () => {
    const r = py(
      "arms = [{'arm_id': a, 'runs': rs} for a, rs in (('qr-a', ['r1', 'r2']), ('cp', ['c1']), ('x', ['x1']), ('quickreview-frozen', ['f1']))]\n" +
        "runs = [{'unit': u} for u in ('r1', 'r2', 'c1', 'x1', 'f1', 'm1', 'm1.martian', 'q1', 'q1.qodo', 'elo', 'ccvq-run')]\n" +
        "claims = [{'group': 'g:aacr', 'q': '{aacr:qr-a~own:found} / {aacr:cp~own&arm=x:recall}'},\n" +
        "  {'group': 'g:m', 'q': 'martian:m1|quickreview-frozen:core_tp'}, {'group': 'g:q', 'q': 'qodo:q1|quickreview:recall'},\n" +
        "  {'group': 'g:boot', 'q': 'bootstrap:pairs/high/qr-a | cp/diff'}, {'group': 'g:elo', 'q': 'elo:plan|combined|overall|ccvq-run:elo'},\n" +
        "  {'group': 'g:key', 'q': 'key:prs'}, {'q': 'aacr:qr-a:found'}, {'group': 'g:dirs', 'q': '{martian:dirs:m} - 1'}]\n" +
        "a, u = h.claim_links(claims, arms, runs, {'m1', 'z1'})\n" +
        "print(json.dumps([{k: sorted(v) for k, v in sorted(a.items())}, {k: sorted(v) for k, v in sorted(u.items())}]))",
    );
    expect(r).toEqual([
      { cp: ["g:aacr", "g:boot"], "qr-a": ["g:aacr", "g:boot"], x: ["g:aacr"] },
      {
        c1: ["g:aacr", "g:boot"],
        "ccvq-run": ["g:elo"],
        elo: ["g:elo"],
        m1: ["g:dirs", "g:m"],
        "m1.martian": ["g:dirs", "g:m"],
        q1: ["g:q"],
        "q1.qodo": ["g:q"],
        r1: ["g:aacr", "g:boot"],
        r2: ["g:aacr", "g:boot"],
        x1: ["g:aacr"],
      },
    ]);
  });

  // MUTATION: drop the VERDICTS_NEED filter from release_catalogue.Catalogue.hf_tables — this fails
  it("lists a family's Qodo verdicts only beside its Qodo reviews", () => {
    const r = pyModule(
      "release_catalogue",
      "f = lambda t: h.Catalogue.hf_tables({'ship': 'yes', 'hf_tables': t})\n" +
        "print(json.dumps([f(['runs (new)', 'qodo_verdicts', 'martian_verdicts']), f(['qodo_reviews', 'qodo_verdicts'])]))",
    );
    expect(r).toEqual([
      ["runs", "martian_verdicts"],
      ["qodo_reviews", "qodo_verdicts"],
    ]);
  });

  // MUTATION: in rejudge_column_checks, drop the priority_confidence comparison — this fails
  // MUTATION: in rejudge_column_checks, drop the judge_view comparison (raw_text against tag and text) — this fails
  // MUTATION: in rejudge_column_checks, compare len(more) with n alone (not n - 30) — this fails
  // MUTATION: in rejudge_column_checks, check martian_reviews only for the QuickReview style (skip qodo_reviews and reviews) — this fails
  // MUTATION: make martian_score_problems return [] — this fails
  // MUTATION: in rejudge_column_checks, drop "verbosity" from the judges keys — this fails
  // MUTATION: in rejudge_column_checks, skip the qodo_verdicts orphan count — this fails
  it("fails each re-judge column check on a planted fault and passes the clean tables", () => {
    const r = py(`
import copy
def counts(**k): return {f'{p}_{x}': k.get(f'{p}_{x}', 0) for p in ('all', 'core', 'strict') for x in ('tp', 'fp', 'fn')}
qr = {'id': 'C1', 'tag': 'nit', 'text': 'Do x', 'raw_text': '[nit] Do x\\n\\n_P3 · confidence 0.9 · lens l_', 'priority': 'P3', 'confidence': 0.9}
base = dict(
  prs=[{'instance_id': 'p1', 'base_commit': 'b' * 40, 'merge_base': 'a' * 40, 'title': 'T'}],
  reviews=[{'arm_id': 'quickreview-x', 'instance_id': 'p1', 'source_url': None, 'comments': [qr]},
           {'arm_id': 'claude-code-opus55', 'instance_id': 'p1', 'source_url': None,
            'comments': [{'id': 'C1', 'tag': None, 'text': 'note', 'raw_text': 'note', 'priority': None, 'confidence': None}]},
           {'arm_id': 'copilot-2025-upstream', 'instance_id': 'p1', 'source_url': 'https://x',
            'comments': [{'id': 'C1', 'tag': None, 'text': None, 'raw_text': None, 'priority': None, 'confidence': None}]}],
  martian_goldens=[{'pr_url': 'u', 'golden_index': 0, 'category': 'logic'}, {'pr_url': 'u', 'golden_index': 1, 'category': 'style'}],
  martian_reviews=[{'work_dir': 'w', 'tool': 'quickreview', 'judge': 'j', 'pr_url': 'u', 'vendor_link_only': False, 'fp': 1,
                    'comments': [{'path': 'a', 'line': 1, 'body': '[nit] x _P3 · confidence 0.9_'}] * 30 + [{'path': None, 'line': None, 'body': 'b'}],
                    'n_posted_inline': 32, 'comments_beyond_first_page': [{'path': 'a', 'line': 2, 'body': 'y'}] * 2},
                   {'work_dir': 'w', 'tool': 'rejudged-cubic-v2', 'judge': 'j', 'pr_url': 'u', 'vendor_link_only': True, 'fp': 0,
                    'comments': [], 'n_posted_inline': None, 'comments_beyond_first_page': []}],
  martian_verdicts=[{'work_dir': 'w', 'tool': 'quickreview', 'judge': 'j', 'pr_url': 'u', 'golden_index': 0, 'matched': True},
                    {'work_dir': 'w', 'tool': 'quickreview', 'judge': 'j', 'pr_url': 'u', 'golden_index': 1, 'matched': False}],
  martian_scores=[{'work_dir': 'w', 'tool': 'quickreview', 'judge': 'j', **counts(all_tp=1, all_fp=1, all_fn=1, core_tp=1, core_fp=1, strict_tp=1, strict_fp=1)},
                  {'work_dir': None, 'tool': 'claude-code', 'judge': 'published: m', **counts()}],
  qodo_reviews=[{'work_dir': 'qw', 'tool': 'quickreview', 'comments': [{'body': '[nit] y _(P3/0.9, pass-a)_'}]}],
  qodo_verdicts=[{'work_dir': 'qw', 'tool': 'quickreview'}],
  runs=[{'unit': 'w.martian', 'claims': [], 'judges': 'fam. This scoring dir: m; reasoning effort low; verbosity medium; backend b; dropped by the bridge: t'},
        {'unit': 'r1', 'claims': [], 'judges': None}],
  arms=[{'arm_id': 'quickreview-x', 'runs': ['r1'], 'in_paper': False, 'paper_tables': []}])
def failed(t): return sorted(c['check'][:36] for c in h.rejudge_column_checks(t) if not c['ok'])
def plant(f):
    t = copy.deepcopy(base); f(t); return failed(t)
out = {'clean': failed(base)}
out['merge_base'] = plant(lambda t: t['prs'][0].update(merge_base=None))
out['raw'] = plant(lambda t: t['reviews'][0]['comments'][0].update(raw_text='[nit] Do y\\n\\n_P3 · confidence 0.9 · lens l_'))
out['priority'] = plant(lambda t: t['reviews'][0]['comments'][0].update(priority='P1'))
out['link'] = plant(lambda t: t['reviews'][2]['comments'][0].update(raw_text='vendor text'))
out['beyond'] = plant(lambda t: t['martian_reviews'][0].update(comments_beyond_first_page=[]))
out['styled_martian'] = plant(lambda t: [x.update(tool='claude-code') for x in t['martian_reviews'][:1] + t['martian_verdicts'] + t['martian_scores'][:1]])
out['styled_qodo'] = plant(lambda t: [x.update(tool='coderabbit') for x in t['qodo_reviews'] + t['qodo_verdicts']])
out['styled_aacr'] = plant(lambda t: t['reviews'][1]['comments'][0].update(raw_text='[nit] note\\n\\n_P1 · confidence 1.0_', tag='nit', priority='P1', confidence=1.0))
out['scores'] = plant(lambda t: t['martian_scores'][0].update(core_tp=2))
out['judges'] = plant(lambda t: t['runs'][0].update(judges='fam. This scoring dir: m; reasoning effort low; backend b; dropped by the bridge: t'))
out['orphan'] = plant(lambda t: t['qodo_verdicts'].append({'work_dir': 'qw2', 'tool': 'quickreview'}))
print(json.dumps(out))
`) as Record<string, string[]>;
    const mb = "prs: PRs whose merge base is not bas"; // the pinned count of the real key (150), never 1 here
    expect(r.clean).toEqual([mb]);
    const only = (k: string) => r[k]!.filter((x) => x !== mb);
    expect(only("merge_base")).toEqual(["prs: every PR has its merge base (40"]);
    expect(only("raw")).toEqual(["reviews: every comment's raw_text st"]);
    expect(only("priority")).toEqual(["reviews: every comment's raw_text st"]);
    expect(only("link")).toEqual(["reviews: a link-only arm's comment r"]);
    expect(only("beyond")).toEqual(["martian_reviews: the first page hold"]);
    expect(only("styled_martian")).toEqual(["no QuickReview-styled review carries"]);
    expect(only("styled_qodo")).toEqual(["no QuickReview-styled review carries"]);
    expect(only("styled_aacr")).toEqual(["no QuickReview-styled review carries"]);
    expect(only("scores")).toEqual(["martian_scores: every scoring dir's "]);
    expect(only("judges")).toEqual(["runs: every Martian scoring dir's ju"]);
    expect(only("orphan")).toEqual(["qodo_verdicts: every (work_dir, tool"]);
  });
});

describe("hf_export.load_counts", () => {
  // The export's own load check: the loader's default cache is keyed by the
  // folder's name and the card's file patterns, not the files, so a re-export
  // to the same path was answered from the first export's cache. The fake
  // loader keys its cache the same way (one file per config name) and says
  // whether each read found that cache empty.
  // MUTATION: drop cache_dir=cache from load_counts' load_dataset call — this fails
  it("reads every config through a cache made for that check, never an earlier one", () => {
    const fake = join(tmp, "fake-datasets");
    put(
      join(fake, "datasets.py"),
      [
        "import os",
        "calls = []",
        "class _Rows:",
        "    def __init__(self, n):",
        "        self.num_rows = n",
        "def load_dataset(path, name, split=None, cache_dir=None):",
        "    cache = cache_dir or os.environ['FAKE_DEFAULT_CACHE']",
        "    os.makedirs(cache, exist_ok=True)",
        "    hit = os.path.join(cache, name)",
        "    calls.append({'name': name, 'split': split, 'fresh': not os.path.exists(hit)})",
        "    open(hit, 'w').close()",
        "    return _Rows(len(name))",
      ].join("\n") + "\n",
    );
    const got = pyEnv(
      { FAKE_DEFAULT_CACHE: join(tmp, "fake-default-cache") },
      "hf_export",
      "sys.path.insert(0, sys.argv[1]); import datasets\n" +
        "a = h.load_counts('/data/out', ['prs', 'runs']); b = h.load_counts('/data/out', ['prs'])\n" +
        "print(json.dumps({'a': a, 'b': b, 'calls': datasets.calls}))",
      fake,
    );
    expect(got).toEqual({
      a: { prs: 3, runs: 4 },
      b: { prs: 3 },
      calls: [
        { name: "prs", split: "test", fresh: true },
        { name: "runs", split: "test", fresh: true },
        { name: "prs", split: "test", fresh: true },
      ],
    });
  });
});

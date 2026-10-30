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
//      read and no text, and lensfinal reads it when the full one is absent.

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
    ["-c", `import sys, json; sys.path.insert(0, 'bench/aacr'); import ${mod} as h\n${code}`, ...args],
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
    expect(r[0]).toBe("Compare with <private-repo>/src and <private-repo>'s profile; profiles/widgetco stays.");
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
    expect(r[0]).toBe("a support guideline, see gadget tracker and issue  tracker and ***REMOVED***; Example.");
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
      ["\\bfleet([ \\t]*)tracker\\b", ["fleet tracker", "fleettracker"]],
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
    const r = pyModule("scrub_extra", "print(json.dumps(h.regex_anchor(b'alpha-one|beta-two')[0]))");
    expect(r).toBeNull();
  });
});

describe("release_catalogue and export_runs: what ships", () => {
  const root = join(tmp, "cat");
  const src = join(root, "bench-runs");
  const om = join(root, "open-models");
  put(join(src, "runs", "keep-dev10", "run.json"), JSON.stringify({ set: "dev10", qcr_commit: "aaa111" }));
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
        { id: "kept", title: "Kept runs", location: "qcr-bench-runs/runs/", members: ["keep-dev10"], ship: "yes", hf_tables: ["runs (new)", "reviews"], claims: ["c:one"] },
        { id: "own", title: "Own repo", location: "qcr-bench-runs/runs/", members: ["own-repo-run"], ship: "no:own-repo", hf_tables: [], claims: "none" },
        { id: "elo", title: "Elo", location: "qcr-bench-runs/", members: ["elo"], ship: "yes", hf_tables: [], claims: "none" },
        { id: "om", title: "Open models", location: "review-sandbox bench/aacr/artifacts/open-models/runs/ (gitignored)", members: ["om-run"], ship: "yes", hf_tables: [], claims: "none" },
        { id: "drv", title: "Driver", location: "review-sandbox bench/aacr/artifacts/open-models/ (top level)", members: ["driver.sh"], ship: "yes", hf_tables: [], claims: "none" },
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
    expect(r["runs/own-repo-run/run.json"]).toMatch(/^withheld: QuickReview reviewing our own repositories/);
    expect(r["runs/nobody-knows/run.json"]).toMatch(/^not in the run catalogue/);
    expect(r["elo/plan-a/packs/u1.txt"]).toMatch(/^regenerable: Elo packs/);
  });

  it("indexes every shipped unit with its run.json facts, and lists withheld families", () => {
    const r = pyModule(
      "release_catalogue",
      "c = h.Catalogue.load(sys.argv[1])\n" +
        "rows = h.index_rows(c, {'runs': sys.argv[2] + '/runs', 'top': sys.argv[2]}, {'aaa111': 'bbb222'})\n" +
        "print(json.dumps([[r['unit'], r['family'], r['set'], r['qcr_commit_public'], r['claims'], r['hf_tables']] for r in rows]\n" +
        "  + [[w['family'], w['reason']] for w in h.withheld_rows(c)]))",
      catalogue,
      src,
    ) as unknown[][];
    expect(r).toContainEqual(["keep-dev10", "kept", "dev10", "bbb222", ["c:one"], ["runs", "reviews"]]);
    expect(r).toContainEqual(["elo", "elo", null, null, [], []]);
    expect(r.find((x) => x[0] === "own")?.[1]).toMatch(/^withheld/);
    expect(r.some((x) => x[0] === "own-repo-run")).toBe(false);
  });
});

describe("export_runs.plan_copies", () => {
  // MUTATION: in plan_copies, pick the hardlink canonical by path alone (drop copy_rank) — this fails
  it("ships a hardlinked file once, at the source run's path, and maps a variant's byte copy to its source", () => {
    const src = join(tmp, "copies");
    put(join(src, "runs", "zsource-a", "cases", "x", "f.json"), "same bytes\n");
    mkdirSync(join(src, "runs", "mv-a", "cases", "x"), { recursive: true });
    linkSync(join(src, "runs", "zsource-a", "cases", "x", "f.json"), join(src, "runs", "mv-a", "cases", "x", "f.json"));
    put(join(src, "runs", "mv-b", "VARIANT.json"), JSON.stringify({ policy: { src: ["zsource-a"] } }));
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
    { type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "SECRET-PROSE" }] } },
    {
      type: "message_end",
      message: { role: "assistant", timestamp: 1000, usage: { output: 7 }, content: [{ type: "text", text: "SECRET-PROSE" }] },
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
              messages: [{ role: "assistant", timestamp: 1500, usage: { output: 3 }, content: "SECRET-PROSE" }],
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

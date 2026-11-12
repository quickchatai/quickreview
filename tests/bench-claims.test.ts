// bench/aacr/claims.json and bench/aacr/verify_claims.py — every published
// benchmark number, where it is printed, and the check that recomputes it from
// the released data. Runs for real under python3, standard library only, with
// no release data:
//
//   1. the completeness fence: on the real tree, every number token of
//      README.md and of BENCHMARKS.md (the full results the README links) is a
//      manifest claim or a listed not-claim, and every anchor of every listed
//      file is still on exactly one line carrying its value;
//   2. the fence bites: a copy of either page with one more benchmark
//      percentage, or with a claimed number changed, fails the lint;
//   3. the tokenizer: what counts as a number on a published line;
//   4. the verifier, end to end on small .jsonl tables: a claim whose number
//      the data gives passes, a stale one fails as a mismatch, a claim with no
//      script fails, a claim whose source is not in --data fails unless
//      --partial, and one that needs only --martian is skipped under
//      --partial with the flag named, the run exiting 0;
//   5. how a computed number is compared: printed like the published value,
//      and an "about" claim within its tolerance;
//   6. verify_slim.py's constants for the open-model figures (the DigitalOcean
//      table and smoke, BENCHMARKS.md's notes under the Other models table) are
//      the numbers the pages print;
//   7. both papers name the published dataset, leave no XXXX placeholder, and
//      say the raw session transcripts are not published.
// Neutral planted names throughout.

import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AACR = join(ROOT, "bench", "aacr");
const VERIFY = join(AACR, "verify_claims.py");
const tmp = mkdtempSync(join(tmpdir(), "bench-claims-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

interface Manifest {
  files: Record<string, { lint: string }>;
  checks: Record<string, unknown>;
  claims: { id: string; file: string; anchor: string; value: string; q: string | null }[];
  not_claims: { file: string; anchor: string; tokens: string[] }[];
  [k: string]: unknown;
}

function run(args: string[]): { code: number; out: string } {
  const p = spawnSync("python3", ["-I", VERIFY, ...args], { encoding: "utf8" });
  return { code: p.status ?? -1, out: `${p.stdout}\n${p.stderr}` };
}

function py(code: string, ...args: string[]): unknown {
  const p = spawnSync(
    "python3",
    [
      "-c",
      `import sys, json; sys.path.insert(0, ${JSON.stringify(join(AACR, "recompute"))}); sys.path.insert(0, ${JSON.stringify(AACR)})\n${code}`,
      ...args,
    ],
    { encoding: "utf8" },
  );
  if (p.status !== 0) throw new Error(p.stderr);
  return JSON.parse(p.stdout);
}

const MANIFEST = JSON.parse(readFileSync(join(AACR, "claims.json"), "utf8")) as Manifest;

/** The two pages a reader meets first: the README, and the full results it links. */
const PAGES = ["README.md", "BENCHMARKS.md"] as const;
type Page = (typeof PAGES)[number];

/** A scratch tree holding one page and a manifest of only that page's entries. */
function pageTree(name: string, page: Page, text: string): { repo: string; manifest: string } {
  const repo = join(tmp, name);
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, page), text);
  const m: Manifest = {
    ...MANIFEST,
    files: { [page]: MANIFEST.files[page]! },
    claims: MANIFEST.claims.filter((c) => c.file === page),
    not_claims: MANIFEST.not_claims.filter((n) => n.file === page),
    checks: Object.fromEntries(
      Object.entries(MANIFEST.checks).map(([k, v]) => [k, { ...(v as object), scripts: [] }]),
    ),
  };
  const manifest = join(repo, "claims.json");
  writeFileSync(manifest, JSON.stringify(m));
  return { repo, manifest };
}

describe("the claims manifest against the published text", () => {
  // MUTATION: add a sentence with a new percentage ("QuickReview finds 99% of …")
  // to README.md or to BENCHMARKS.md and no manifest entry — this fails (and so
  // does editing any claimed number or anchored line of a listed file without
  // updating the manifest).
  // MUTATION: set BENCHMARKS.md's `lint` to "report" in claims.json's `files` — this fails
  it("accounts for every number of README.md and BENCHMARKS.md, and every anchor is on its line", () => {
    const r = run(["--lint"]);
    expect(r.out).not.toMatch(/MANIFEST:/);
    for (const page of PAGES) {
      // the page's own line: "bench/aacr/README.md: …" is another file's
      const line = r.out.split("\n").find((l) => l.startsWith(`${page}: `));
      expect(line, page).toMatch(
        /: \d+ number tokens, \d+ claims, \d+ not-claims, 0 unaccounted \(complete\)$/,
      );
      expect(MANIFEST.files[page]?.lint, page).toBe("complete");
    }
    expect(r.code).toBe(0);
  });

  // The README prints the headline paragraph and its chart; every other
  // benchmark number is on BENCHMARKS.md.
  // MUTATION: turn the claims of BENCHMARKS.md's full tables into not-claims — this fails
  it("lists every number the two pages print as a claim with a check, never one without", () => {
    const readme = MANIFEST.claims.filter((c) => c.file === "README.md");
    const full = MANIFEST.claims.filter((c) => c.file === "BENCHMARKS.md");
    expect(readme.length).toBeGreaterThan(20);
    expect(full.length).toBeGreaterThan(300);
    expect([...readme, ...full].filter((c) => !c.q)).toEqual([]);
  });

  // MUTATION: drop the undeclared-group check from verify_claims.py's lint (the `groups` loop) — this fails
  // MUTATION: remove "bench-readme" from claims.json's `groups` — this fails (the lint test above too)
  it("declares and describes every claim group the claims name, and fails one it does not", () => {
    const used = [
      ...new Set(MANIFEST.claims.map((c) => (c as { group?: string }).group).filter(Boolean)),
    ];
    const groups = MANIFEST["groups"] as Record<string, { what?: string }>;
    expect(used.filter((g) => !groups[g!]?.what)).toEqual([]);
    const t = pageTree("groups", "README.md", readFileSync(join(ROOT, "README.md"), "utf8"));
    const m = JSON.parse(readFileSync(t.manifest, "utf8")) as Manifest;
    const g = (m.claims[0] as { group?: string }).group!;
    const plant = (name: string, f: (gs: Record<string, { what?: string }>) => void): string => {
      const gs = JSON.parse(JSON.stringify(m["groups"])) as Record<string, { what?: string }>;
      f(gs);
      const path = join(t.repo, `${name}.json`);
      writeFileSync(path, JSON.stringify({ ...m, groups: gs }));
      const r = run(["--lint", "--repo", t.repo, "--manifest", path]);
      return `${r.code} ${r.out
        .split("\n")
        .filter((l) => l.startsWith("MANIFEST:"))
        .join("|")}`;
    };
    expect(plant("ok", () => {})).toBe("0 ");
    expect(plant("undeclared", (gs) => delete gs[g])).toBe(
      `1 MANIFEST: group '${g}': claims name it and \`groups\` does not declare it`,
    );
    expect(plant("undescribed", (gs) => delete gs[g]!.what)).toBe(
      `1 MANIFEST: group '${g}': no \`what\` in \`groups\` (the description RUNS-INDEX.json prints)`,
    );
  });

  // Each page, with the sentence planted under its Benchmarks heading.
  it.each([
    ["README.md", "## Benchmarks\n"],
    ["BENCHMARKS.md", "# Benchmarks\n"],
  ] as const)(
    "fails a %s with one more benchmark number than the manifest lists",
    (page, heading) => {
      const real = readFileSync(join(ROOT, page), "utf8");
      const ok = pageTree(`${page}-ok`, page, real);
      expect(run(["--lint", "--repo", ok.repo, "--manifest", ok.manifest]).code).toBe(0);
      const added = pageTree(
        `${page}-added`,
        page,
        real.replace(heading, `${heading}\nQuickReview finds 99% of every defect.\n`),
      );
      const r = run(["--lint", "--repo", added.repo, "--manifest", added.manifest]);
      expect(r.code).toBe(1);
      expect(r.out).toContain(`${page}: 1 number(s) neither a claim nor a listed not-claim`);
      expect(r.out).toContain("'99%'");
    },
  );

  it("fails a BENCHMARKS.md whose claimed number changed under the manifest", () => {
    const real = readFileSync(join(ROOT, "BENCHMARKS.md"), "utf8");
    const line = real
      .split("\n")
      .find((l) => l.includes("The price: 6.9 comments per PR, 42% of them"));
    expect(line).toBeDefined();
    const changed = pageTree(
      "page-changed",
      "BENCHMARKS.md",
      real.replace("42% of them true but minor", "41% of them true but minor"),
    );
    const r = run(["--lint", "--repo", changed.repo, "--manifest", changed.manifest]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/anchor not found|not on the anchored line/);
  });
});

describe("claim_text: the numbers of a published line", () => {
  const tok = (line: string, tex = false) =>
    py(
      "import claim_text as T; print(json.dumps(T.tokens(sys.argv[1], sys.argv[2] == '1', [r'\\b(?:Opus|Sonnet)\\s+\\d+(?:\\.\\d+)*'])))",
      line,
      tex ? "1" : "0",
    );

  // MUTATION: drop the `(?<![A-Za-z_]-)` lookbehind from NUM — the gpt-6.1 version becomes a token and this fails
  it("reads values, signs and units, never a version glued to a word", () => {
    expect(
      tok(
        "finds **97% of 90**, $0.07–0.53 (+8.3 [+1.9, +14.6]) on gpt-6.1-sol, S40, v1.0, #42, 21k, 0.86x",
      ),
    ).toEqual(["97%", "90", "0.07", "0.53", "+8.3", "+1.9", "+14.6", "21k", "0.86x"]);
  });

  it("drops dates, clock times, versions after a model name, URLs and image sizes", () => {
    expect(
      tok(
        'On 2026-10-04 at 17:23, Claude Opus 5.5 found 3,093 <img width="800" src="a/b2.png"> https://x.io/9',
      ),
    ).toEqual(["3,093"]);
  });

  it("reads LaTeX as printed: escaped percent, thousands braces, math signs, and no reference numbers", () => {
    expect(
      tok(
        "\\textbf{409} & 79\\% & 10{,}000 & $-2.7$ & 85--87\\% \\ref{tab:x2} % 55 is a comment",
        true,
      ),
    ).toEqual(["409", "79%", "10,000", "-2.7", "85", "87%"]);
  });
});

describe("verify_claims end to end on small tables", () => {
  const data = join(tmp, "data");
  const repo = join(tmp, "repo");
  mkdirSync(data, { recursive: true });
  mkdirSync(repo, { recursive: true });
  const jsonl = (name: string, rows: object[]) =>
    writeFileSync(
      join(data, `${name}.jsonl`),
      rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
    );
  jsonl("prs", [
    {
      instance_id: "p1",
      set: "s1",
      in_s40: true,
      language: "Go",
      pr_category: "Bug Fix",
      change_line_count: 10,
      repo: "r1",
    },
    {
      instance_id: "p2",
      set: "s1",
      in_s40: false,
      language: "Go",
      pr_category: "Bug Fix",
      change_line_count: 20,
      repo: "r1",
    },
  ]);
  jsonl("defects", [
    {
      instance_id: "p1",
      defect_id: "d1",
      severity: "high",
      kind: "bug",
      provenance_hunt: true,
      provenance_dataset_refs: [],
    },
    {
      instance_id: "p1",
      defect_id: "d2",
      severity: "low",
      kind: "bug",
      provenance_hunt: false,
      provenance_dataset_refs: [],
    },
    {
      instance_id: "p2",
      defect_id: "d1",
      severity: "medium",
      kind: "build",
      provenance_hunt: false,
      provenance_dataset_refs: ["R1"],
    },
  ]);
  jsonl("arms", [{ arm_id: "acme-review", judge: "judge-a" }]);
  jsonl("defect_verdicts", [
    {
      arm_id: "acme-review",
      judge: "judge-a",
      instance_id: "p1",
      defect_id: "d1",
      verdict: "found",
      credit: 1,
    },
    {
      arm_id: "acme-review",
      judge: "judge-a",
      instance_id: "p1",
      defect_id: "d2",
      verdict: "partial",
      credit: 0.5,
    },
  ]);
  jsonl("comment_verdicts", []);
  jsonl("reviews", [
    {
      arm_id: "acme-review",
      instance_id: "p1",
      judged: true,
      cost_usd: 1.0,
      minutes: 4,
      n_comments: 2,
    },
    {
      arm_id: "acme-review",
      instance_id: "p2",
      judged: true,
      cost_usd: 2.0,
      minutes: 6,
      n_comments: 1,
    },
  ]);
  writeFileSync(
    join(repo, "PAGE.md"),
    [
      "Acme finds 1.5 of 3 defects (50%) at $1.50 per PR.",
      "Acme finds 2 of the 3.",
      "The report has 7 more.",
      "Acme scores about $1.6 a PR, and its smoke ran 12 minutes.",
      "Released in 2026, version 3.",
    ].join("\n") + "\n",
  );
  const base = {
    schema: "quickreview-claims/1",
    about_tolerance: 0.1,
    version_patterns: [],
    files: { "PAGE.md": { lint: "complete" } },
    checks: {
      key: { kind: "tables", provider: "key", needs: "hf", scripts: [] },
      aacr: { kind: "tables", provider: "aacr", needs: "hf", scripts: [] },
      do_speed: { kind: "slim", part: "do_speed.slim.json", needs: "slim", scripts: [] },
      mart: { kind: "tables", provider: "key", needs: "hf+martian", scripts: [] },
    },
    groups: {},
    not_claims: [
      {
        file: "PAGE.md",
        anchor: "Released in 2026",
        tokens: ["2026", "3"],
        why: "a year; a version",
      },
    ],
  };
  const claim = (
    id: string,
    anchor: string,
    value: string,
    q: string | null,
    extra: object = {},
  ) => ({
    id,
    file: "PAGE.md",
    anchor,
    value,
    q,
    ...extra,
  });
  const good = [
    claim("found", "Acme finds 1.5 of 3", "1.5", "aacr:acme-review:found"),
    claim("defects", "Acme finds 1.5 of 3", "3", "key:defects"),
    claim("recall", "Acme finds 1.5 of 3", "50%", "aacr:acme-review:recall"),
    claim("usd", "Acme finds 1.5 of 3", "1.50", "aacr:acme-review:usd"),
    claim(
      "expr",
      "Acme finds 2 of the 3.",
      "2",
      "{aacr:acme-review:found} + {aacr:acme-review:partials} / 2",
    ),
    claim("expr-n", "Acme finds 2 of the 3.", "3", "key:defects"),
    claim("about", "Acme scores about $1.6 a PR", "1.6", "aacr:acme-review:usd", { about: true }),
  ];
  const writeManifest = (name: string, claims: object[]) => {
    const p = join(repo, name);
    writeFileSync(p, JSON.stringify({ ...base, claims }));
    return p;
  };
  const verify = (manifest: string, ...extra: string[]) =>
    run([
      "--manifest",
      manifest,
      "--repo",
      repo,
      "--data",
      data,
      "--work",
      join(tmp, "work"),
      "--no-validation",
      ...extra,
    ]);

  // MUTATION: make `same` compare floats exactly (drop render_like) — 50% against 50.0 fails and this fails
  it("passes every claim the tables give, printed the way the page prints it", () => {
    const m = writeManifest("good.json", [
      ...good,
      claim("seven", "The report has 7 more.", "7", "key:defects", { note: "planted" }),
      claim("smoke", "its smoke ran 12 minutes", "12", "do_speed:smokes/x/median_min"),
    ]);
    const r = verify(m, "--partial");
    expect(r.out).toContain("claims: {'mismatch': 1, 'pass': 7, 'skipped': 1}");
    expect(r.out).toMatch(/MISMATCH seven .*published '7', computed 3/);
    expect(r.code).toBe(1);
  });

  // MUTATION: count a no-source claim as skipped without --partial — this fails
  it("fails a claim with no script, and one whose source --data does not hold", () => {
    const m = writeManifest("gaps.json", [
      ...good,
      claim("seven", "The report has 7 more.", "7", null, {
        no_script: "planted: not computed yet",
      }),
      claim("smoke", "its smoke ran 12 minutes", "12", "do_speed:smokes/x/median_min"),
    ]);
    const strict = verify(m);
    expect(strict.code).toBe(1);
    expect(strict.out).toContain("NO-SCRIPT x1: planted: not computed yet");
    expect(strict.out).toContain("NO-SOURCE smoke");
    const partial = verify(m, "--partial");
    expect(partial.out).toContain("NO-SCRIPT x1: planted: not computed yet");
    expect(partial.out).not.toContain("NO-SOURCE smoke");
  });

  // MUTATION: in verify_claims.main's failing(), allow a gap with no recorded reason — this fails
  // MUTATION: drop the needs-input status (a missing --martian is a missing source again) — this fails
  it("passes documented gaps with --allow-gaps, and never a gap without its reason or a mismatch", () => {
    const gaps = writeManifest("gaps-only.json", [
      ...good,
      claim("seven", "The report has 7 more.", "7", null, {
        no_script: "planted: not computed yet",
      }),
      claim("smoke", "its smoke ran 12 minutes", "12", "mart:defects"),
    ]);
    const strict = verify(gaps);
    expect(strict.code).toBe(1);
    expect(strict.out).toContain("'needs-input': 1");
    const allowed = verify(gaps, "--allow-gaps");
    expect(allowed.out).toContain("result: 7 pass, 0 failing, 2 documented gaps (allowed)");
    expect(allowed.code).toBe(0);
    const bare = writeManifest("gaps-bare.json", [
      ...good,
      claim("seven", "The report has 7 more.", "7", null),
      claim("smoke", "its smoke ran 12 minutes", "12", "mart:defects"),
    ]);
    expect(verify(bare, "--allow-gaps").code).toBe(1);
    const wrong = writeManifest("gaps-wrong.json", [
      ...good,
      claim("seven", "The report has 7 more.", "7", "key:defects"),
      claim("smoke", "its smoke ran 12 minutes", "12", "mart:defects"),
    ]);
    expect(verify(wrong, "--allow-gaps").code).toBe(1);
  });

  // MUTATION: in verify_claims.verify, keep "needs-input" under --partial (drop the skipped branch) — this fails
  // MUTATION: in result_line, print the gaps' parenthetical when gaps_n is 0 — this fails
  // MUTATION: in result_line, drop the skipped count — this fails
  it("with --partial skips a claim that needs only --martian, names the flag, and exits 0", () => {
    const m = writeManifest("needs-martian.json", [
      ...good,
      claim("seven", "The report has 7 more.", "7", "{key:defects} + 4"),
      claim("smoke", "its smoke ran 12 minutes", "12", "mart:defects"),
    ]);
    const strict = verify(m);
    expect(strict.code).toBe(1);
    expect(strict.out).toContain("'needs-input': 1");
    expect(strict.out).toContain(
      "result: 8 pass, 1 failing, 1 documented gaps (failing; --allow-gaps passes them)",
    );
    const partial = verify(m, "--partial");
    expect(partial.out).toContain("claims: {'pass': 8, 'skipped': 1}");
    expect(partial.out).toContain("SKIPPED x1: needs --martian (--partial)");
    expect(partial.out).toContain(
      "result: 8 pass, 0 failing, 0 documented gaps, 1 skipped (needs --martian; pass it to include them),",
    );
    expect(partial.out).not.toContain("failing;");
    expect(partial.code).toBe(0);
    // a mismatch still fails under --partial
    const stale = writeManifest("needs-martian-stale.json", [
      ...good,
      claim("seven", "The report has 7 more.", "7", "key:defects"),
      claim("smoke", "its smoke ran 12 minutes", "12", "mart:defects"),
    ]);
    expect(verify(stale, "--partial").code).toBe(1);
  });

  // MUTATION: restore a non-failing status for a no_script reason starting "pending relabel" — this fails
  it("has no pending status: a claim waiting for a labelling pass fails like any claim with no script", () => {
    const pending = writeManifest("pending.json", [
      ...good,
      claim("seven", "The report has 7 more.", "7", null, {
        no_script: "pending relabel: a labelling pass will produce the data",
      }),
    ]);
    const r = verify(pending);
    expect(r.code).toBe(1);
    expect(r.out).toContain("'no-script': 1");
    expect(r.out).not.toMatch(/pending relabel,/);
  });

  it("fails the lint when a listed file prints a number the manifest does not account for", () => {
    const m = writeManifest("short.json", good.slice(0, 3));
    const r = run(["--lint", "--manifest", m, "--repo", repo]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/PAGE\.md: \d+ number\(s\) neither a claim nor a listed not-claim/);
  });
});

describe("a slim cell that needs a third-party input", () => {
  // The cells verify_slim produced, empty: `_slim` reads them instead of
  // running the bundle check.
  const slimCell = (key: string, martian: string | null) =>
    py(
      `import types, verify_claims as V
a = types.SimpleNamespace(work=sys.argv[3], martian=json.loads(sys.argv[2]), qodo_gt=None)
src = V.Sources(a, {"checks": {}}, {})
src._json["slim"] = {"cells": {}, "files": {}}
try:
    src._slim({"part": "cells"}, sys.argv[1]); print(json.dumps("value"))
except V.NoSource as e:
    print(json.dumps("no-source: " + str(e)))
except KeyError:
    print(json.dumps("error"))`,
      key,
      JSON.stringify(martian),
      join(tmp, "slim-needs"),
    );

  // MUTATION: drop the slim_needs check in Sources._slim — the Martian cell is an error again and this fails
  it("is a missing source without that input, and an error only when the input was given", () => {
    expect(slimCell("tab:martianfinal|PR-Agent|P", null)).toBe(
      "no-source: --martian (third-party, never in the release)",
    );
    expect(slimCell("tab:qodo|qodo-precise|P", null)).toMatch(/^no-source: --qodo-gt/);
    expect(slimCell("tab:martianfinal|PR-Agent|P", "/m")).toBe("error");
    expect(slimCell("tab:final|arm|P", null)).toBe("error");
  });

  // MUTATION: make input_flag always answer --martian — the Qodo case reads "--martian" and this fails
  it("names the flag a skipped claim needs: --martian, --qodo-gt, or both", () => {
    const flag = (whys: string[]) =>
      py(
        "import verify_claims as V; print(json.dumps(V.input_flag([{'why': w} for w in json.loads(sys.argv[1])])))",
        JSON.stringify(whys),
      );
    expect(flag(["needs hf+martian (third-party: pass --martian)"])).toBe("--martian");
    expect(flag(["needs --qodo-gt (third-party, never in the release)"])).toBe("--qodo-gt");
    expect(
      flag([
        "needs --martian (third-party, never in the release)",
        "needs --qodo-gt (third-party)",
      ]),
    ).toBe("--martian and --qodo-gt");
  });
});

describe("the release checks name what they need", () => {
  // MUTATION: drop `flag` from the Martian and Qodo re-scores' needs in verify_claims.consistency (needs
  // ["slim"]) — the card then counts them in a --partial run, and this fails.
  // MUTATION: give the bundle's hash check needs [] — the card then counts it on the tables alone, and this fails.
  it("marks the slim bundle's checks, and the re-scores that need --martian or --qodo-gt", () => {
    const work = join(tmp, "consistency");
    mkdirSync(join(work, "slim-verify", "out"), { recursive: true });
    writeFileSync(
      join(work, "slim-verify", "out", "summary.json"),
      JSON.stringify({
        hash_mismatches: 0,
        pi_events_in_bundle: 0,
        martian: { identical: 3 },
        qodo: { identical: 2 },
        elo_refit_equals_ratings_json: true,
      }),
    );
    const got = py(
      `import types, verify_claims as V
a = types.SimpleNamespace(work=sys.argv[1], martian="/m", qodo_gt="/q", no_validation=True)
src = V.Sources(a, {"checks": {}}, {})
src._json["slim"] = {"cells": {}, "files": {}}
print(json.dumps([[c["check"], c["needs"], c["ok"]] for c in V.consistency(a, {"slim": "bundle"}, src)]))`,
      work,
    );
    expect(got).toEqual([
      ["every bundle file matches FILES.sha256", ["slim"], true],
      ["no transcript text (pi-events.jsonl) in the bundle", ["slim"], true],
      ["every martian scoring dir re-scores to its stored scores", ["slim", "--martian"], true],
      ["every qodo scoring dir re-scores to its stored scores", ["slim", "--qodo-gt"], true],
      ["the Elo refit from the judgments equals the run's ratings.json", ["slim"], true],
    ]);
  });
});

describe("comparing a computed number with the printed one", () => {
  const same = (printed: string, x: number | string, about: number | null = null) =>
    py(
      "import verify_claims as V; print(json.dumps(V.same(sys.argv[1], json.loads(sys.argv[2]), json.loads(sys.argv[3]))))",
      printed,
      JSON.stringify(x),
      JSON.stringify(about),
    );

  it("prints the computed number like the published one", () => {
    expect(same("79%", 78.65)).toBe(true);
    expect(same("+8.3", 8.333)).toBe(true);
    expect(same("8.3", 8.333)).toBe(true);
    expect(same("+8.3", -8.333)).toBe(false);
    expect(same("3,093", 3093)).toBe(true);
    expect(same("461", 460.5)).toBe(false); // half credit never rounds into a published count
    expect(same("21k", 21.4)).toBe(true);
    expect(same("244", "244")).toBe(true); // a source that prints its own number
  });

  // MUTATION: compare an `about` claim at the printed precision instead of the tolerance — $20.95 for "about $20" fails
  it("passes an approximate claim within the tolerance, and only then", () => {
    expect(same("20", 20.95, 0.1)).toBe(true);
    expect(same("4", 4.61, 0.1)).toBe(false);
  });
});

describe("claim_metrics: published numbers by key, from the tables", () => {
  const dir = join(tmp, "metrics");
  mkdirSync(dir, { recursive: true });
  const jl = (name: string, rows: object[]) =>
    writeFileSync(join(dir, `${name}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  jl("prs", [
    {
      instance_id: "p1",
      set: "s1",
      in_s40: true,
      language: "Go",
      pr_category: "x",
      change_line_count: 5,
      repo: "r",
    },
    {
      instance_id: "p2",
      set: "s2",
      in_s40: false,
      language: "Go",
      pr_category: "x",
      change_line_count: 9,
      repo: "r",
    },
  ]);
  jl("defects", [
    {
      instance_id: "p1",
      defect_id: "d1",
      severity: "high",
      kind: "bug",
      provenance_hunt: true,
      provenance_dataset_refs: [],
      provenance_reviewer_comments: [],
    },
    {
      instance_id: "p1",
      defect_id: "d2",
      severity: "low",
      kind: "bug",
      provenance_hunt: false,
      provenance_dataset_refs: [],
      provenance_reviewer_comments: ["C1"],
    },
    {
      instance_id: "p2",
      defect_id: "d1",
      severity: "medium",
      kind: "build",
      provenance_hunt: false,
      provenance_dataset_refs: ["R1"],
      provenance_reviewer_comments: [],
    },
  ]);
  jl("arms", [
    { arm_id: "acme", judge: "j1" },
    { arm_id: "widget", judge: "j1" },
  ]);
  jl("reviews", [
    {
      arm_id: "acme",
      instance_id: "p1",
      judged: true,
      judged_by: ["j1", "j2"],
      cost_usd: 1,
      minutes: 2,
      n_comments: 1,
    },
    {
      arm_id: "acme",
      instance_id: "p2",
      judged: true,
      judged_by: ["j1", "j2"],
      cost_usd: 3,
      minutes: 4,
      n_comments: 1,
    },
    {
      arm_id: "widget",
      instance_id: "p2",
      judged: true,
      judged_by: ["j1"],
      cost_usd: 1,
      minutes: 1,
      n_comments: 0,
    },
  ]);
  jl("defect_verdicts", [
    { arm_id: "acme", judge: "j1", instance_id: "p1", defect_id: "d1", verdict: "found" },
    { arm_id: "acme", judge: "j1", instance_id: "p1", defect_id: "d2", verdict: "partial" },
    { arm_id: "acme", judge: "j2", instance_id: "p1", defect_id: "d1", verdict: "found" },
    { arm_id: "widget", judge: "j1", instance_id: "p2", defect_id: "d1", verdict: "found" },
  ]);
  jl("comment_verdicts", []);
  const value = (provider: string, key: string) =>
    py(
      `import claim_metrics as M; t = M.Tables(sys.argv[1]); print(json.dumps(M.PROVIDERS[sys.argv[2]](t).value(sys.argv[3])))`,
      dir,
      provider,
      key,
    );

  // MUTATION: credit a partial find as 1 in CREDIT — found becomes 2 and this fails
  it("scores an arm by its judge: a partial counts 1/2, a defect with no row is missed", () => {
    expect(value("aacr", "acme:found")).toBe(1.5);
    expect(value("aacr", "acme:high_rec")).toBe(100);
    expect(value("aacr", "acme:missed")).toBe(1.5);
    expect(value("aacr", "acme@j2:found")).toBe(1);
  });

  // MUTATION: drop the `arm=` selector's PR filter — widget's PRs become both and this fails
  it("narrows the PRs and the key by selector", () => {
    expect(value("aacr", "acme~arm=widget:defects")).toBe(1);
    expect(value("aacr", "acme~dset=indep:defects")).toBe(2);
    expect(value("aacr", "acme+widget~all:single_found")).toBe(3);
    expect(value("key", "one_source")).toBe(3);
    expect(value("key", "reviewer_only")).toBe(1);
  });

  // MUTATION: compare the two judges on every review instead of the ones both judged — pairs becomes 3+ and this fails
  it("compares two judges only on the reviews both judged, missing rows as missed", () => {
    expect(value("judges", "j1|j2|acme:pairs")).toBe(3);
    expect(value("judges", "j1|j2|acme:same")).toBe(2);
    expect(value("judges", "j1|j2|acme:disagree_partial")).toBe(1);
  });

  it("refuses a key it cannot read, never a number", () => {
    expect(() => value("aacr", "nobody:found")).toThrow(/no arm/);
  });
});

describe("verify_slim.py's copy of the published open-model figures", () => {
  // verify_slim.py compares the bundle with the numbers the pages print, held as
  // constants; a page corrected to the data without its constant (or the reverse)
  // turns a passing cell into a DOC row. These read both sides.
  const vs = py(
    "import verify_slim as v; print(json.dumps({'table': v.DO_TABLE, 'smoke': v.DO_SMOKE, " +
      "'slowest': v.DO_SLOWEST, 'notes': v.README_OPEN_NOTES}))",
  ) as {
    table: Record<string, string[]>;
    smoke: Record<string, string>;
    slowest: string;
    notes: Record<string, string>;
  };
  const doc = readFileSync(join(AACR, "docs", "DIGITALOCEAN.md"), "utf8");
  const flat = (s: string) => s.replace(/\s+/g, " ");

  // MUTATION: put the GPT-6.1 Sol row of DIGITALOCEAN.md back to "| GPT-6.1 Sol | 8 | 21k | 71 |" — this fails
  it("holds the DigitalOcean speed table exactly as the page prints it", () => {
    expect(Object.keys(vs.table).sort()).toEqual(
      ["DeepSeek V4.1 Flash", "GLM-5.3 Flash", "GPT-6.1 Sol", "Gemma 4 31B"].sort(),
    );
    for (const [model, exp] of Object.entries(vs.table)) {
      const row = doc.split("\n").find((l) => l.startsWith(`| ${model} |`));
      expect(row, model).toBeDefined();
      const cells = row!
        .split("|")
        .slice(2, 8)
        .map((c) => c.trim());
      const printed = [
        cells[0],
        cells[1]!.replace(/k$/, ""),
        cells[2],
        cells[3]!.replace(/ s$/, ""),
        cells[4]!.replace(/^~/, "").replace(/ tok\/s$/, ""),
        cells[5]!.replace(/^~?\$/, "").split(" ")[0],
      ];
      expect(printed, model).toEqual(exp);
    }
  });

  // MUTATION: set DO_SMOKE["median min"] back to "28", or DO_SLOWEST to "54-66" — this fails
  it("holds the GLM smoke and the slowest full-run reviews as the page prints them", () => {
    const text = flat(doc);
    expect(text).toContain(
      `median ${vs.smoke["median min"]} minutes per PR (mean ${vs.smoke["mean min"]}), ` +
        `slowest ${vs.smoke["slowest min"]} minutes.`,
    );
    expect(text).toContain(`$${vs.smoke.usd} in total at list price`);
    expect(text).toContain(`${vs.smoke.ok} reviews ok`);
    expect(text).toContain(`took ${vs.slowest.replace("-", "–")} minutes`);
  });

  // MUTATION: print "missing a lens pass on 8" in BENCHMARKS.md's Other models notes — this fails
  it("holds the notes on the open-model rows as BENCHMARKS.md prints them", () => {
    const page = flat(readFileSync(join(ROOT, "BENCHMARKS.md"), "utf8"));
    const n = vs.notes;
    expect(page).toContain(
      `low reasoning effort on ${n["DeepSeek low-effort PRs"]} of its PRs and lost one lens pass on ` +
        `${n["DeepSeek PRs that lost a lens pass"]} PRs.`,
    );
    expect(page).toContain(
      `one lens pass was lost on ${n["GLM PRs that lost a lens pass"]} PR and the validator on ` +
        `${n["GLM PRs that lost only the validator"]}, and on ${n["GLM PRs missing a lens pass"]} more a lens pass ran`,
    );
  });
});

describe("the papers' data availability", () => {
  const PAPER = join(AACR, "paper");
  const DATASET = "https://huggingface.co/datasets/quickchatai/quickreview-bench";
  const tex = (name: string) => readFileSync(join(PAPER, name), "utf8");

  // MUTATION: put back "\code{huggingface.co/datasets/XXXX/XXXX}" in benchmark.tex's run-archive paragraph — this fails
  it("names the published dataset and leaves no XXXX placeholder in either paper", () => {
    for (const name of ["benchmark.tex", "quickreview.tex"]) {
      const t = tex(name);
      expect(t, name).toContain(`\\url{${DATASET}}`);
      expect(t.match(/X{4}/g), name).toBeNull();
    }
  });

  // MUTATION: restore "The full run directories (reviews, transcripts," as the run-archive paragraph's opening — this fails
  it("says the raw session transcripts are not published, only numbers-only extracts of them", () => {
    const t = tex("benchmark.tex");
    const para = t.slice(
      t.indexOf("\\paragraph{Run archive.}"),
      t.indexOf("\\paragraph{Local only.}"),
    );
    expect(para.length).toBeGreaterThan(0);
    expect(para).not.toMatch(/\(reviews, transcripts,/);
    expect(para.replace(/\s+/g, " ")).toContain("Raw model session transcripts are not published");
  });
});

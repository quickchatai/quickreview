// bench/aacr/recompute/ — the recompute scripts that read the run archive (its
// key-building files, case summaries, numbers-only session extracts and judge
// files), and the verifier's handling of them. Each runs for real under python3
// on a small fixture tree (standard library only; neutral planted names):
//
//   1. archive: an unpacked archive is read in place; a volume the archive does
//      not hold is an error naming it, never an empty tree;
//   2. verify_claims: a check that needs two parts of the release (hf+archive)
//      runs only when --data holds both; a claim whose data the release does not
//      hold is "not published", apart from the claims still waiting for a script;
//   3. key_build: tab:prov attributes a first-key comment to the run that wrote
//      it; the key without QuickReview-only defects drops a defect only QuickReview's
//      earlier runs raised (on the original 40, any reviewer-only defect);
//   4. tokens: a pi session's tokens are its assistant messages plus every
//      subagent result, cache writes counted as uncached input; a bridged tool's
//      cached count never exceeds its input;
//   5. judge_ops: a judgement in error is skipped for the arm's next run, and a
//      judgement with no extract needed no model call;
//   6. passes: the PRs where the session added passes, and a lens that never ran
//      reads 0%, not unknown;
//   7. martian_ext: a tool's second candidate naming the same issue is a DUP, and
//      the one kept is the higher-ranked class;
//   8. claim_metrics: a Martian score restricted to one half is recounted under
//      the profile's golden categories; PR size buckets are inclusive; a reference
//      label that does not align with its reference is a fault; `done=` keeps only
//      the PRs an arm's review completed;
//   9. lens_credit: a comment posted in the review body (no lens trailer) takes the
//      lenses of the posted finding at its site;
//  10. panel_confirmed: the judge's C1.. follow the panel's right-side clusters, then
//      the base-side ones;
//  11. copilot_harvest, smoke_lenses, martian_published: an earlier push's line is
//      kept only when the harvest mapped it; a lens's timeout is read from its
//      error class; a published credit naming no listed golden is left out.

import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AACR = join(ROOT, "bench", "aacr");
const RECOMPUTE = join(AACR, "recompute");
const tmp = mkdtempSync(join(tmpdir(), "bench-recompute-archive-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function py(code: string, ...args: string[]): unknown {
  const p = spawnSync(
    "python3",
    [
      "-c",
      `import sys, json; sys.path.insert(0, ${JSON.stringify(RECOMPUTE)}); sys.path.insert(0, ${JSON.stringify(AACR)})\n${code}`,
      ...args,
    ],
    { encoding: "utf8", cwd: ROOT },
  );
  if (p.status !== 0) throw new Error(p.stderr);
  return JSON.parse(p.stdout);
}

function write(path: string, body: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
}

function jsonl(path: string, rows: object[]): void {
  write(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

describe("archive", () => {
  const unpacked = join(tmp, "unpacked");
  write(join(unpacked, "runs", "r1", "run.json"), { run: "r1" });

  it("reads an unpacked archive in place", () => {
    const r = py(
      "import archive as A; print(json.dumps(str(A.open_archive(sys.argv[1], sys.argv[2], ['x']))))",
      unpacked,
      join(tmp, "work-unpacked"),
    );
    expect(r).toBe(realpathSync(unpacked));
  });

  // MUTATION: drop the `if not vol.exists()` check in open_archive — a missing volume is no longer named and this fails
  it("names a volume the archive does not hold", () => {
    const vols = join(tmp, "volumes");
    write(join(vols, "MANIFEST.json"), {});
    write(join(vols, "quickreview-runs-present.tar.zst"), "");
    const p = spawnSync(
      "python3",
      [
        "-c",
        `import sys; sys.path.insert(0, ${JSON.stringify(RECOMPUTE)}); import archive as A; A.open_archive(sys.argv[1], sys.argv[2], ['absent'])`,
        vols,
        join(tmp, "work-volumes"),
      ],
      { encoding: "utf8" },
    );
    expect(p.status).not.toBe(0);
    expect(p.stderr).toContain("archive volume missing: quickreview-runs-absent.tar.zst");
  });
});

describe("verify_claims", () => {
  // MUTATION: make Sources.available test `any` part instead of `all` — this fails
  it("runs a check that needs hf+archive only when --data holds both", () => {
    const r = py(
      "import argparse, verify_claims as V\n" +
        "a = argparse.Namespace(work=sys.argv[1], martian=None, qodo_gt=None)\n" +
        "m = {'checks': {'k': {'needs': 'hf+archive'}}}\n" +
        "both = V.Sources(a, m, {'hf': 'h', 'archive': 'a'}).available('k')\n" +
        "one = V.Sources(a, m, {'hf': 'h', 'archive': None}).available('k')\n" +
        "print(json.dumps([both, one]))",
      join(tmp, "work-needs"),
    );
    expect(r).toEqual([true, false]);
  });

  // MUTATION: drop the not-published branch in verify (every claim with no q is "no-script") — this fails
  it("tells a claim whose data is not published from one still waiting for a script", () => {
    const r = py(
      "import argparse, verify_claims as V\n" +
        "a = argparse.Namespace(work=sys.argv[1], martian=None, qodo_gt=None, partial=False, file=None, no_validation=True)\n" +
        "c = lambda i, why: {'id': i, 'file': 'P.md', 'anchor': i, 'value': '1', 'no_script': why}\n" +
        "m = {'checks': {}, 'claims': [c('a', 'data not published: a planted log'), c('b', 'planted: not computed yet')]}\n" +
        "res = V.verify(a, m, {'hf': None, 'slim': None, 'archive': None, 'repo': '.'})\n" +
        "print(json.dumps([[x['status'] for x in res], 'not-published' in V.FAIL]))",
      join(tmp, "work-unpublished"),
    );
    expect(r).toEqual([["not-published", "no-script"], true]);
  });
});

describe("key_build", () => {
  const root = join(tmp, "key");
  const truth = (defects: object[], excluded: object[] = []) => ({ defects, excluded });
  const d = (id: string, p: object, severity = "low") => ({
    id,
    severity,
    title: id,
    statement: id,
    sites: [],
    provenance: { hunt: false, dataset_refs: [], reviewer_comments: [], ...p },
  });
  // P1 (R145): D1 raised by the default run alone; D2 by OCR alone; D3 by the hunt and the low run.
  const r145 = join(root, "rest145-code", "P1");
  write(join(r145, "candidates-key.json"), {
    C1: "all-default-rest145",
    C2: "all-ocr-rest145",
    C3: "all-low-rest145",
  });
  write(join(r145, "new-candidates-key.json"), { N1: "codex" });
  const p1 = [
    d("D1", { reviewer_comments: ["C1"] }),
    d("D2", { reviewer_comments: ["C2"] }),
    d("D3", { hunt: true, reviewer_comments: ["C3"] }),
  ];
  write(join(r145, "truth.json"), truth(p1));
  write(join(r145, "truth-current.json"), truth(p1));
  write(join(r145, "truth-ext.json"), truth(p1, [{ source: "N1", reason: "planted" }]));
  write(join(r145, "hunt.json"), { defects: [], references: [] });
  // P2 (original 40): D1 raised only by an earlier-pool comment, D2 by the hunt.
  const o40 = join(root, "orig40-code", "P2");
  write(join(o40, "new-candidates-key.json"), {});
  const p2 = [d("D1", { reviewer_comments: ["R4"] }), d("D2", { hunt: true })];
  write(join(o40, "truth-current.json"), truth(p2));
  write(join(o40, "truth-ext.json"), truth(p2));
  const hfDefects = [
    ...p1.map((x) => ({ instance_id: "P1", defect_id: x.id, severity: "low" })),
    ...p2.map((x) => ({ instance_id: "P2", defect_id: x.id, severity: "low" })),
  ].map((x, i) => ({
    ...x,
    provenance_hunt: [false, false, true, false, true][i],
    provenance_dataset_refs: [],
    provenance_reviewer_comments: [["C1"], ["C2"], ["C3"], ["R4"], []][i],
  }));

  // MUTATION: attribute every first-key comment to the default run (ignore candidates-key.json) — this fails
  it("credits each first-key comment to the run that wrote it in tab:prov", () => {
    const r = py(
      "import key_build as K; k = K.Key(__import__('pathlib').Path(sys.argv[1])); t = K.prov_table(k)\n" +
        "print(json.dumps([t['raised'], t['only']]))",
      root,
    ) as [Record<string, number>, Record<string, number>];
    expect(r[0]).toEqual({ default: 1, ocr: 1, hunt: 1, low: 1 });
    expect(r[1]).toEqual({ default: 1, ocr: 1 });
  });

  // MUTATION: count a C comment of all-ocr-rest145 as QuickReview's in own_seeding — D2 is dropped and this fails
  it("drops the defects only QuickReview's earlier runs raised, and the original 40's reviewer-only ones", () => {
    const r = py(
      "import key_build as K; a = json.loads(sys.argv[2]); k = K.Key(__import__('pathlib').Path(sys.argv[1]))\n" +
        "K.FINAL = ('X', 'Y')\n" +
        "o = K.own_seeding(k, ['P1', 'P2'], a, [])\n" +
        "print(json.dumps([o['kept'], o['dropped'], o['dropped_orig40'], o['dropped_rest145']]))",
      root,
      JSON.stringify(hfDefects),
    );
    expect(r).toEqual([3, 2, 1, 1]);
  });

  // MUTATION: count every N-sourced exclusion of truth-ext.json, also those truth-current.json already had — this fails
  it("counts the extension's exclusions as the N-sourced ones the extension added", () => {
    write(join(r145, "truth-current.json"), truth(p1, [{ source: "N1", reason: "planted" }]));
    const r = py(
      "import key_build as K; k = K.Key(__import__('pathlib').Path(sys.argv[1])); print(json.dumps(K.extension(k)['excluded']))",
      root,
    );
    write(join(r145, "truth-current.json"), truth(p1));
    expect(r).toBe(0);
  });
});

describe("tokens", () => {
  const base = join(tmp, "tokens");
  const pi = join(base, "pi");
  jsonl(join(pi, "pi-events.pruned.jsonl"), [
    {
      type: "message_end",
      message: {
        role: "assistant",
        usage: { input: 10, cacheWrite: 5, cacheRead: 100, output: 7 },
      },
    },
    { type: "message_end", message: { role: "user" } },
    {
      type: "tool_execution_end",
      toolName: "subagent",
      result: {
        details: { results: [{ agent: "pass-x", usage: { input: 1, cacheRead: 2, output: 3 } }] },
      },
    },
  ]);
  write(join(pi, "case-summary.json"), { status: "ok" });
  const claude = join(base, "claude");
  write(join(claude, "case-summary.json"), {
    arm: "claude",
    tokens: { input: 1, cache_creation: 2, cache_read: 3, output: 4 },
  });
  const bridge = join(base, "bridge");
  write(join(bridge, "case-summary.json"), {
    arm: "ocr",
    bridge: { input_tokens: 10, cached_tokens: 50, output_tokens: 6 },
  });

  // MUTATION: leave cacheWrite out of a pi session's uncached input — this fails
  it("sums a pi session's messages and subagent results, a bridge's cache capped at its input", () => {
    const r = py(
      "import tokens as T, pathlib\n" +
        "print(json.dumps([T.case_tokens(pathlib.Path(p)) for p in sys.argv[1:]]))",
      pi,
      claude,
      bridge,
    );
    expect(r).toEqual([
      { uncached: 16, cached: 102, output: 10, passes: [3] },
      { uncached: 3, cached: 3, output: 4, passes: [] },
      { uncached: 0, cached: 10, output: 6, passes: [] },
    ]);
  });
});

describe("judge_ops", () => {
  const root = join(tmp, "judge");
  const dir = (run: string) => join(root, "runs", run, "judge", "v2-gpt-6-sol-high");
  write(join(dir("r1"), "P1.r1.json"), { error: "HTTP 429" });
  write(join(dir("r2"), "P1.r1.json"), { defects: [] });
  jsonl(join(dir("r2"), "P1.r1.events.pruned.jsonl"), [
    {
      type: "message_end",
      message: { role: "assistant", usage: { input: 1000, cacheRead: 0, output: 100 } },
    },
    {
      type: "message_end",
      message: { role: "assistant", usage: { input: 1000, cacheRead: 0, output: 100 } },
    },
  ]);
  write(join(dir("r1"), "P2.r1.json"), { defects: [] }); // no extract: no model call

  // MUTATION: count a judgement in error as judged (drop the `if j is None: continue`) — this fails
  it("skips a judgement in error for the next run, and counts one without an extract as needing no call", () => {
    const r = py(
      "import judge_ops as J, pathlib\n" +
        "arms = {a: [] for a in J.STUDY}; arms[J.STUDY[0]] = ['r1', 'r2']\n" +
        "prs = {'P1': {'key_version': 2}, 'P2': {'key_version': 2}}\n" +
        "c = J.judge_cost(pathlib.Path(sys.argv[1]), arms, prs, 'gpt-6-sol-high')\n" +
        "print(json.dumps([c['judgements'], c['no_call'], c['error_files_skipped'], c['calls'], round(c['usd_list'], 6)]))",
      root,
    );
    expect(r).toEqual([2, 1, 1, 2, round6((2000 * 2 + 200 * 10) / 1e6)]);
  });
});

function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

describe("passes", () => {
  // MUTATION: drop the ADDABLE seeding in stats — a lens that never ran has no share and this fails
  it("counts the PRs where the session added passes, and a never-run lens at 0%", () => {
    const r = py(
      "import passes as P\n" +
        "s = {'A': {'planned_lenses': ['pass-baseline--sol-med'], 'executed_passes': ['pass-baseline--sol-med', 'pass-concurrency--sol-med', 'pass-validate--sol-high']},\n" +
        "     'B': {'planned_lenses': ['pass-baseline--sol-med', 'pass-validate--sol-high'], 'executed_passes': ['pass-baseline--sol-med', 'pass-validate--sol-high']}}\n" +
        "x = P.stats(s); print(json.dumps([x['added'], x['lens_share']['concurrency'], x['lens_share']['ask-human'], x['lens_share']['baseline']]))",
    );
    expect(r).toEqual([1, 50, 0, 100]);
  });
});

describe("martian_ext", () => {
  const root = join(tmp, "martian");
  const an = join(root, "analysis", "external-benchmarks-2026-10-02");
  const PR = "https://github.com/calcom/cal.com/pull/1";
  // One PR, two goldens (cal1.0 valid, cal1.1 trivial) and one unlisted real defect.
  write(join(an, "gm", "rows.json"), [
    { pr: "cal1", idx: 0, q: "valid", D: "P+" },
    { pr: "cal1", idx: 1, q: "trivial", D: "NR" },
  ]);
  const cand = (cid: string, matched: string[], tool = "quickreview") => ({
    tool,
    pr: PR,
    idx: 0,
    text: cid,
    matched,
    cid,
  });
  // C1 calls the unlisted defect minor, C2 (same issue) calls it real; C3 states the valid golden.
  // Every other tool gets one wrong candidate.
  const others = [
    "cubic-v2",
    "qodo-extended-v2",
    "claude-code",
    "augment",
    "qodo-v2",
    "macroscope",
    "devin",
  ];
  write(join(an, "fair", "secret.json"), {
    C1: cand("C1", []),
    C2: cand("C2", []),
    C3: cand("C3", ["g"]),
    ...Object.fromEntries(others.map((t) => [`O-${t}`, cand(`O-${t}`, [], t)])),
  });
  write(join(an, "fair", "out", "cal1.json"), {
    packet: "cal1",
    key_entries: { "cal1.R1": { title: "t", where: "w", severity: "low" } },
    candidates: {
      C1: { class: "MINOR", issue: "cal1.R1" },
      C2: { class: "REAL", issue: "cal1.R1" },
      C3: { class: "GOLDEN", issue: "cal1.0" },
      ...Object.fromEntries(
        others.map((t) => [`O-${t}`, { class: "WRONG", issue: `cal1.W-${t}` }]),
      ),
    },
  });
  const res = join(root, "runs", "mv-r1-asposted.martian", "results");
  write(join(res, "benchmark_data.json"), {
    [PR]: {
      golden_comments: [
        { comment: "g0", severity: "High" },
        { comment: "g1", severity: "Low" },
      ],
    },
  });
  write(join(res, "gpt-6.1-sol", "candidates.json"), { [PR]: {} });
  write(join(res, "gpt-6.1-sol", "evaluations.json"), { [PR]: {} });

  // MUTATION: order a tool's candidates by id only in Ext._final (drop the class rank) — C1 MINOR is kept and this fails
  it("keeps the higher-ranked class when two candidates name one issue, the other a DUP", () => {
    const r = py(
      "import martian_ext as M, pathlib; x = M.compute(pathlib.Path(sys.argv[1]))\n" +
        "t = x['tool']['quickreview']; print(json.dumps([x['key'], t['raised'], t['p_strict'], t['dup_pct'], t['minor_pct']]))",
      root,
    );
    const [key, raised, pStrict, dupPct, minorPct] = r as number[];
    expect([key, raised, minorPct]).toEqual([2, 2, 0]);
    expect(pStrict).toBeCloseTo((100 * 2) / 3, 9);
    expect(dupPct).toBeCloseTo(100 / 3, 9);
  });
});

describe("claim_metrics", () => {
  const sets = JSON.parse(readFileSync(join(AACR, "sets", "martian-test30.json"), "utf8")) as {
    cases: { pr_url: string }[];
  };
  const A = sets.cases[0]!.pr_url; // in test30
  const B = "https://example.invalid/not-in-test30/1";

  // MUTATION: drop the profile's category exclusion in Martian._counts — the style golden counts and this fails
  it("recounts a Martian score on one half under the profile's golden categories", () => {
    const d = join(tmp, "martian-tables");
    jsonl(join(d, "martian_goldens.jsonl"), [
      { pr_url: A, golden_index: 0, category: "bug" },
      { pr_url: A, golden_index: 1, category: "style" },
      { pr_url: A, golden_index: 2, category: "bug" },
      { pr_url: B, golden_index: 0, category: "bug" },
    ]);
    const v = (pr_url: string, golden_index: number, matched: boolean) => ({
      work_dir: "w",
      tool: "t",
      judge: "gpt-6.1-sol",
      pr_url,
      golden_index,
      matched,
    });
    jsonl(join(d, "martian_verdicts.jsonl"), [
      v(A, 0, true),
      v(A, 1, true),
      v(A, 2, false),
      v(B, 0, true),
    ]);
    jsonl(join(d, "martian_reviews.jsonl"), [
      { work_dir: "w", tool: "t", pr_url: A, fp: 3 },
      { work_dir: "w", tool: "t", pr_url: B, fp: 10 },
    ]);
    const r = py(
      "import claim_metrics as CM; m = CM.Martian(CM.Tables(sys.argv[1]))\n" +
        "print(json.dumps([m.value(f'w|t~martian-test30:core_{x}') for x in ('tp', 'fp', 'fn', 'precision', 'recall')]))",
      d,
    );
    expect(r).toEqual([1, 3, 1, 25, 50]);
  });

  // MUTATION: make the size bucket's upper bound exclusive (`<` for `<=`) — the 50-line PR leaves the bucket and this fails
  it("buckets a PR by its diff.stat size with inclusive bounds", () => {
    const d = join(tmp, "size-tables");
    jsonl(
      join(d, "prs.jsonl"),
      ["a", "b", "c"].map((instance_id) => ({ instance_id })),
    );
    jsonl(join(d, "pr_diffstats.jsonl"), [
      { instance_id: "a", changed_lines: 50 },
      { instance_id: "b", changed_lines: 51 },
      { instance_id: "c", changed_lines: 200 },
    ]);
    jsonl(join(d, "defects.jsonl"), []);
    const r = py(
      "import claim_metrics as CM; k = CM.Key(CM.Tables(sys.argv[1]))\n" +
        "print(json.dumps([k.value('prs~size=0-50'), k.value('prs~size=51-200'), k.value('size_median')]))",
      d,
    );
    expect(r).toEqual([1, 2, 51]);
  });

  // MUTATION: skip a label that does not align instead of raising in labelled_refs — this fails
  it("refuses a reference label that does not align with the reference at its position", () => {
    const d = join(tmp, "label-tables");
    jsonl(join(d, "aacr_references.jsonl"), [
      { instance_id: "a", ref_index: 0, ref_key: "k0", path: "x.py", from_line: 3 },
    ]);
    jsonl(join(d, "aacr_reference_labels.jsonl"), [
      { instance_id: "a", index: 0, path: "y.py", from_line: 3, reality: "dubious" },
    ]);
    const p = spawnSync(
      "python3",
      [
        "-c",
        `import sys; sys.path.insert(0, ${JSON.stringify(RECOMPUTE)}); import claim_metrics as CM; CM.Aacr(CM.Tables(sys.argv[1])).labelled_refs()`,
        d,
      ],
      { encoding: "utf8" },
    );
    expect(p.status).not.toBe(0);
    expect(p.stderr).toContain("does not align with a reference");
  });
});

describe("the claims manifest's gaps", () => {
  const m = JSON.parse(readFileSync(join(AACR, "claims.json"), "utf8")) as {
    checks: Record<string, { needs: string; scripts?: string[] }>;
    claims: { id: string; file: string; q?: string | null; alt?: string[]; no_script?: string }[];
  };

  // MUTATION: drop the q of any dataset-card claim (give it a no_script reason instead) — this fails
  it("gives every number the dataset card prints a check", () => {
    const card = m.claims.filter((c) => c.file === "bench/aacr/hf/card.md");
    expect(card.length).toBeGreaterThan(50);
    expect(card.filter((c) => !c.q && !(c.alt ?? []).length).map((c) => c.id)).toEqual([]);
  });

  // MUTATION: write a reason as "data not published" with nothing after it — this fails
  it("says why, for every claim whose data the release does not hold", () => {
    const unpublished = m.claims.filter((c) =>
      (c.no_script ?? "").startsWith("data not published"),
    );
    expect(unpublished.length).toBeGreaterThan(0);
    for (const c of unpublished) expect(c.no_script!).toMatch(/^data not published: .{20,}/);
  });

  // MUTATION: name a check's script that is not in the tree (e.g. "bench/aacr/recompute/missing.py") — this fails
  it("runs every archive-backed check from a script in this tree", () => {
    const archive = Object.entries(m.checks).filter(([, c]) =>
      c.needs.split("+").includes("archive"),
    );
    expect(archive.map(([k]) => k).sort()).toEqual(
      expect.arrayContaining([
        "claude_arm",
        "judge_ops",
        "key_build",
        "martian_ext",
        "passes",
        "tokens",
      ]),
    );
    for (const [, c] of archive) {
      expect(c.scripts?.length).toBeGreaterThan(0);
      for (const s of c.scripts ?? []) expect(() => readFileSync(join(ROOT, s))).not.toThrow();
    }
  });
});

describe("lens_credit", () => {
  const root = join(tmp, "lens");
  const case_ = join(root, "runs", "r", "cases", "P");
  write(join(root, "runs", "r", "results", "all", "P.json"), {
    review: {
      comments: [
        {
          path: "a.go",
          start_line: 10,
          content: "[blocker] x\n_P1 · confidence 1.0 · lens pass-baseline, pass-sweep_",
        },
        { path: "b.go", start_line: 1, content: "[blocker] (body-only) y" },
      ],
    },
  });
  write(join(case_, "comments.json"), []);
  write(join(case_, "findings-record.json"), {
    findings: [
      { id: "f1", path: "b.go", line: 1, lens: "pass-intent, pass-claims", disposition: "posted" },
      {
        id: "f2",
        path: "b.go",
        line: 2,
        lens: "pass-tests",
        disposition: "merged",
        merged_into: "f1",
      },
    ],
  });

  // MUTATION: drop the findings-record fallback in judged_comments — C2 has no lens and this fails
  it("gives a body-posted comment the lenses of the posted finding at its site", () => {
    const r = py(
      "import lens_credit as L, pathlib; c = pathlib.Path(sys.argv[1])\n" +
        "out = L.judged_comments(c, c.parent.parent / 'results' / 'all' / 'P.json')\n" +
        "print(json.dumps([[i, sorted(x)] for i, x in out]))",
      case_,
    );
    expect(r).toEqual([
      ["C1", ["baseline", "sweep"]],
      ["C2", ["claims", "intent", "tests"]],
    ]);
  });
});

describe("panel_confirmed", () => {
  // MUTATION: number the clusters in meta order (drop the right-then-base split) — this fails
  it("numbers the judged comments right-side clusters first, then base-side ones", () => {
    const r = py(
      "import panel_confirmed as P\n" +
        "f = lambda s, side: {'summary': s, 'actionable': True, 'location': {'side': side}}\n" +
        "meta = {'sourceFindings': [{'id': 'a', 'finding': f('A', 'base')}, {'id': 'b', 'finding': f('B', 'head')}, {'id': 'c', 'finding': f('C', 'head')}],\n" +
        "        'confirmedClusters': [{'summary': 'A', 'confirmed': True, 'sourceFindingIds': ['a']}, {'summary': 'B', 'confirmed': True, 'sourceFindingIds': ['b']}],\n" +
        "        'advisories': [{'summary': 'C', 'confirmed': False, 'sourceFindingIds': ['c']}]}\n" +
        "print(json.dumps(P.confirmed_ids(meta)))",
    );
    expect(r).toEqual({ C1: true, C2: false, C3: true });
  });
});

describe("copilot_harvest, smoke_lenses, martian_published", () => {
  // MUTATION: count every finding not at the head as kept (drop the KEPT test) — this fails
  it("keeps an earlier push's line only when the harvest mapped it", () => {
    const root = join(tmp, "copilot");
    write(join(root, "runs", "upstream-copilot2025-dev10", "cases", "P", "case-summary.json"), {
      reviewed_aacr_head: false,
      by_source: { inline: 3, "body-low-confidence": 1 },
      findings: [
        { mapping: "identical-context" },
        { mapping: "dropped-line" },
        { mapping: "identical-file" },
        { mapping: "at-head" },
      ],
    });
    const r = py(
      "import copilot_harvest as C, pathlib; x = C.compute(pathlib.Path(sys.argv[1]))\n" +
        "print(json.dumps([x['earlier_push'], x['earlier_push_lines'], x['earlier_push_kept'], x['earlier_push_path_only'], x['findings']]))",
      root,
    );
    expect(r).toEqual([1, 3, 2, 1, 4]);
  });

  // MUTATION: count lens outcomes by stopReason only (drop errorClass) — the timeout reads "error" and this fails
  it("reads a lens's timeout from its error class", () => {
    const root = join(tmp, "smoke");
    jsonl(
      join(root, "open-models", "runs", "s-glm-aacr1", "cases", "P", "pi-events.pruned.jsonl"),
      [
        {
          type: "tool_execution_end",
          result: {
            details: {
              results: [{ stopReason: "error", errorClass: "timeout" }, { stopReason: "stop" }],
            },
          },
        },
      ],
    );
    const r = py(
      "import smoke_lenses as S, pathlib; print(json.dumps(S.compute(pathlib.Path(sys.argv[1]), 's-glm-')['timed_out']))",
      root,
    );
    expect(r).toBe(1);
  });

  // MUTATION: raise on a credit whose text names no listed golden (as before) instead of leaving it out — this fails
  it("leaves out a published credit naming no listed golden, and shares the rest by audit bucket", () => {
    const m = join(tmp, "martian-src", "offline", "results");
    write(join(m, "benchmark_data.json"), {
      u: { golden_comments: [{ comment: "g0" }, { comment: "g1" }] },
    });
    write(join(m, "anthropic_claude-opus-4-5-20251101", "evaluations.json"), {
      u: {
        tool: {
          true_positives: [
            { golden_comment: "g0" },
            { golden_comment: "g1" },
            { golden_comment: "gone" },
          ],
        },
      },
    });
    const r = py(
      "import martian_published as P, pathlib\n" +
        "g = [{'pr_url': 'u', 'golden_index': 0, 'audit_bucket': 'real', 'severity': 'High'}, {'pr_url': 'u', 'golden_index': 1, 'audit_bucket': 'notreal', 'severity': 'Low'}]\n" +
        "x = P.compute(pathlib.Path(sys.argv[1]), g); t = x['tools']['tool']\n" +
        "print(json.dumps([x['unknown_credits'], t['credited'], t['real_found'], t['notreal_share'], t['all_blocking_real']]))",
      join(tmp, "martian-src"),
    );
    expect(r).toEqual([{ tool: 1 }, 2, 1, 50, 1]);
  });
});

describe("claim_metrics: completed reviews", () => {
  // MUTATION: drop the status test in the done= selector — the timed-out PR is kept and this fails
  it("keeps only the PRs an arm's review completed", () => {
    const d = join(tmp, "done-tables");
    jsonl(
      join(d, "prs.jsonl"),
      ["a", "b"].map((instance_id) => ({ instance_id, in_s40: false })),
    );
    jsonl(join(d, "defects.jsonl"), [
      { instance_id: "a", defect_id: "D1", severity: "low" },
      { instance_id: "b", defect_id: "D1", severity: "low" },
    ]);
    jsonl(join(d, "arms.jsonl"), [{ arm_id: "M", judge: "gpt-6-sol-high" }]);
    jsonl(join(d, "reviews.jsonl"), [
      {
        arm_id: "M",
        instance_id: "a",
        run: "r",
        judged: true,
        status: "ok",
        n_comments: 1,
        cost_usd: 1,
        minutes: 1,
      },
      {
        arm_id: "M",
        instance_id: "b",
        run: "r",
        judged: true,
        status: "timeout",
        n_comments: 0,
        cost_usd: 1,
        minutes: 45,
      },
    ]);
    jsonl(join(d, "defect_verdicts.jsonl"), [
      { arm_id: "M", judge: "gpt-6-sol-high", instance_id: "a", defect_id: "D1", verdict: "found" },
    ]);
    jsonl(join(d, "comment_verdicts.jsonl"), []);
    const r = py(
      "import claim_metrics as CM; a = CM.Aacr(CM.Tables(sys.argv[1]))\n" +
        "print(json.dumps([a.value('M~done=M:defects'), a.value('M~done=M:found'), a.value('M:defects')]))",
      d,
    );
    expect(r).toEqual([1, 1, 2]);
  });
});

// bench/aacr/recompute/ — the scripts that rebuild published numbers from the
// released data, with no model call. Each runs for real under python3 on a small
// fixture (tables as .jsonl, standard library only; neutral planted names):
//
//   1. aacr_bootstrap: credit and severity become recall, high, high+medium and
//      weighted ratios of sums; a defect with no verdict row is a miss; another
//      judge's rows are ignored; the resamples are drawn over the SORTED ids with
//      the papers' seed; the interval is the sorted values at 250 and 9749;
//   2. heldout: the Qodo held-out set excludes a PR on a vendor's SEMANTIC match
//      the earlier build missed (location not required), never on a rule issue,
//      and every validation set's PRs; Martian halves come from the set files,
//      not from the export's audit_split; a Qodo hit needs the location;
//   3. elo_ratings: with no packs, a unit's current prompt is the hash of its
//      latest ok judgment; a judgment at another hash is stale and dropped;
//   4. open_models: effort from each case's fingerprint; a pass that never ran
//      or failed last is LOST, one that ran but the session did not record is
//      UNRECORDED;
//   5. do_speed: a reply counts (and is timed) only when a message follows it;
//   6. the committed data behind the README: the Elo chart's file is what the
//      README's alt text and prose say, and the held-out Qodo set is 31 PRs of
//      qodo-pr100 in no validation set.

import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RECOMPUTE = join(ROOT, "bench", "aacr", "recompute");
const tmp = mkdtempSync(join(tmpdir(), "bench-recompute-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function py(mod: string, code: string, ...args: string[]): unknown {
  const out = execFileSync(
    "python3",
    [
      "-c",
      `import sys, json; sys.path.insert(0, ${JSON.stringify(RECOMPUTE)}); import ${mod} as h\n${code}`,
      ...args,
    ],
    { cwd: ROOT },
  );
  return JSON.parse(out.toString());
}

function jsonl(dir: string, name: string, rows: object[]): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

// Three PRs, four defects; arm X finds p1/d1, half of p1/d2, p2/d1, and has no row for p3/d1.
const PRS = ["p1", "p2", "p3"].map((instance_id) => ({ instance_id }));
const DEFECTS = [
  { instance_id: "p1", defect_id: "d1", severity: "high" },
  { instance_id: "p1", defect_id: "d2", severity: "low" },
  { instance_id: "p2", defect_id: "d1", severity: "medium" },
  { instance_id: "p3", defect_id: "d1", severity: "high" },
];
const J = "gpt-6-sol-high";
const VERDICTS = [
  { arm_id: "X", judge: J, instance_id: "p1", defect_id: "d1", credit: 1 },
  { arm_id: "X", judge: J, instance_id: "p1", defect_id: "d2", credit: 0.5 },
  { arm_id: "X", judge: J, instance_id: "p2", defect_id: "d1", credit: 1 },
  { arm_id: "X", judge: "claude-opus-5-5", instance_id: "p3", defect_id: "d1", credit: 1 },
  { arm_id: "Y", judge: J, instance_id: "p3", defect_id: "d1", credit: 1 },
];

describe("aacr_bootstrap", () => {
  // MUTATION: count another judge's rows (drop `v["judge"] == judge` in per_pr) — this fails
  it("scores ratios of sums from the primary judge's credit, a missing row a miss", () => {
    const r = py(
      "aacr_bootstrap",
      "a = json.loads(sys.argv[1]); res = h.bootstrap([p['instance_id'] for p in a['p']], a['d'], a['v'], ['X', 'Y'], b=200)\n" +
        "print(json.dumps({m: res['intervals']['X'][m]['point'] for m in h.METRICS} | {'pair': res['pairs']['high']['X | Y']['diff']}))",
      JSON.stringify({ p: PRS, d: DEFECTS, v: VERDICTS }),
    ) as Record<string, number>;
    expect(r.recall).toBeCloseTo((100 * 2.5) / 4);
    expect(r.high).toBeCloseTo(50);
    expect(r.serious).toBeCloseTo((100 * 2) / 3);
    expect(r.weighted).toBeCloseTo((100 * (3 + 0.5 + 2)) / 9);
    expect(r.pair).toBeCloseTo(0); // X finds p1's high, Y p3's: one each
  });

  // MUTATION: draw over the ids as given (drop `sorted` in resamples) — this fails
  it("draws the papers' resamples: sorted ids, Random(20261001), one choice per PR", () => {
    const r = py(
      "aacr_bootstrap",
      "import random; rng = random.Random(20261001); ids = ['a', 'b', 'c']\n" +
        "want = [[rng.choice(ids) for _ in ids] for _ in range(5)]\n" +
        "print(json.dumps([h.resamples(['c', 'a', 'b'], 5) == want, h.resamples(['a', 'b', 'c'], 5) == want]))",
    );
    expect(r).toEqual([true, true]);
  });

  // MUTATION: take the upper bound at int(.975 * B) instead of int(.975 * B) - 1 — this fails
  it("reads the percentile interval at index 250 and 9749 of 10,000", () => {
    const r = py(
      "tables",
      "import random; v = list(range(10000)); random.shuffle(v); print(json.dumps(h.percentile_ci(v)))",
    );
    expect(r).toEqual([250, 9749]);
  });

  // MUTATION: ignore --seed in main (always SEED) — the earlier study's intervals and this fail
  it("draws with the seed it is given (the earlier study's is 20260928)", () => {
    const d = join(tmp, "aacr-seed");
    jsonl(d, "prs", PRS);
    jsonl(d, "defects", DEFECTS);
    jsonl(d, "defect_verdicts", VERDICTS);
    jsonl(
      d,
      "reviews",
      ["p1", "p2", "p3"].map((i) => ({ arm_id: "X", instance_id: i, judged: true, cost_usd: 1.0 })),
    );
    const out = join(tmp, "aacr-seed.json");
    execFileSync("python3", [
      "-I",
      join(RECOMPUTE, "aacr_bootstrap.py"),
      "--data",
      d,
      "--arms",
      "X",
      "--resamples",
      "50",
      "--seed",
      "7",
      "--json",
      out,
    ]);
    const res = JSON.parse(readFileSync(out, "utf8"));
    expect(res.seed).toBe(7);
    const want = py(
      "aacr_bootstrap",
      "a = json.loads(sys.argv[1]); r = h.bootstrap([p['instance_id'] for p in a['p']], a['d'], a['v'], ['X'], b=50, seed=7)\n" +
        "print(json.dumps(r['intervals']['X']['recall']))",
      JSON.stringify({ p: PRS, d: DEFECTS, v: VERDICTS }),
    );
    expect(res.intervals.X.recall).toEqual(want);
  });

  // MUTATION: resample both halves from one pool (sa and sb from ha + hb) in halves() — this fails
  it("tests the halves: the first arm's margin on A minus on B, resampled within each half", () => {
    const sets = { p1: "a", p2: "a", p3: "b" };
    const r = py(
      "aacr_bootstrap",
      "import random\na = json.loads(sys.argv[1]); s = json.loads(sys.argv[2])\n" +
        "res = h.halves(s, a['d'], a['v'], ['X', 'Y'], ['a'], ['b'], b=40, seed=3)\n" +
        "per = {x: h.per_pr(['p1', 'p2', 'p3'], a['d'], a['v'], x) for x in ('X', 'Y')}\n" +
        "mg = lambda ids: 100 * (h.ratio(per['X'], ids, 'recall') - h.ratio(per['Y'], ids, 'recall'))\n" +
        "rng = random.Random(3); vals = []\n" +
        "for _ in range(40):\n" +
        "    sa = [rng.choice(['p1', 'p2']) for _ in range(2)]; sb = [rng.choice(['p3'])]\n" +
        "    vals.append(mg(sa) - mg(sb))\n" +
        "from tables import percentile_ci\n" +
        "print(json.dumps([res['diff'], mg(['p1', 'p2']) - mg(['p3']), [res['lo'], res['hi']], list(percentile_ci(vals)), res['prs_a'], res['prs_b']]))",
      JSON.stringify({ d: DEFECTS, v: VERDICTS }),
      JSON.stringify(sets),
    ) as [number, number, number[], number[], number, number];
    expect(r[0]).toBeCloseTo(r[1]);
    expect(r[0]).toBeCloseTo(100 * (2.5 / 3) - (0 - 100));
    expect(r[2]).toEqual(r[3]);
    expect([r[4], r[5]]).toEqual([2, 1]);
  });

  it("runs end to end on the tables and prices a defect found from the judged reviews", () => {
    const d = join(tmp, "aacr");
    jsonl(d, "prs", PRS);
    jsonl(d, "defects", DEFECTS);
    jsonl(d, "defect_verdicts", VERDICTS);
    jsonl(d, "reviews", [
      ...["p1", "p2", "p3"].map((i) => ({
        arm_id: "X",
        instance_id: i,
        judged: true,
        cost_usd: 1.0,
      })),
      { arm_id: "X", instance_id: "p1", judged: false, cost_usd: 50 },
      ...["p1", "p2", "p3"].map((i) => ({
        arm_id: "Y",
        instance_id: i,
        judged: true,
        cost_usd: null,
      })),
    ]);
    const out = join(tmp, "aacr.json");
    execFileSync("python3", [
      "-I",
      join(RECOMPUTE, "aacr_bootstrap.py"),
      "--data",
      d,
      "--arms",
      "X,Y",
      "--resamples",
      "100",
      "--json",
      out,
    ]);
    const res = JSON.parse(readFileSync(out, "utf8"));
    expect(res.costs.X.usd_per_defect).toBeCloseTo(3 / 2.5);
    expect(res.costs.X.reviews).toBe(3);
    expect(res.costs.Y).toBeNull(); // an unpriced review: unknown, never $0
  });
});

describe("heldout", () => {
  const ISSUES = [
    { pr_url: "u1", issue_index: 0, functional: true },
    { pr_url: "u2", issue_index: 0, functional: false },
    { pr_url: "u3", issue_index: 0, functional: true },
    { pr_url: "u4", issue_index: 0, functional: true },
  ];
  const v = (tool: string, pr_url: string, matched: boolean, located_n5: boolean) => ({
    tool,
    pr_url,
    issue_index: 0,
    judge: "gpt-6.1-sol",
    matched,
    located_n5,
  });
  const QV = [
    v("augment", "u1", true, false), // a vendor's semantic match, off by more than 5 lines
    v("quickreview-2026-10-02", "u1", false, false),
    v("augment", "u2", true, true), // a rule issue: never a mined miss
    v("augment", "u3", true, true),
    v("quickreview-2026-10-02", "u3", true, false), // the earlier build had it semantically
    v("quickreview-frozen", "u3", true, false),
  ];

  // MUTATION: require located_n5 for the vendor's match in qodo_heldout_urls — this fails
  it("excludes a vendor-caught miss's PR by semantic match, and every validation set", () => {
    const r = py(
      "heldout",
      "a = json.loads(sys.argv[1]); d = h.qodo_heldout_urls(['u1', 'u2', 'u3', 'u4'], a['i'], a['v'], [['u4']])\n" +
        "print(json.dumps([d['kept'], d['vendor_caught_misses']]))",
      JSON.stringify({ i: ISSUES, v: QV }),
    );
    expect(r).toEqual([["u2", "u3"], 1]);
  });

  // MUTATION: drop `and v["located_n5"]` from qodo_hits' primary-rule hit — this fails
  it("counts a Qodo hit only within the location rule", () => {
    const r = py(
      "heldout",
      "a = json.loads(sys.argv[1]); s = h.qodo_score(['u3'], 'quickreview-frozen', a['i'], a['v'], [{'tool': 'quickreview-frozen', 'pr_url': 'u3', 'n_comments': 2}])\n" +
        "print(json.dumps([s['hits'], s['issues'], s['comments']]))",
      JSON.stringify({ i: ISSUES, v: QV }),
    );
    expect(r).toEqual([0, 1, 2]);
  });

  // MUTATION: place a golden by its audit_split instead of the set files' halves — this fails
  it("places Martian's goldens in their half by the set files, not audit_split", () => {
    const r = py(
      "heldout",
      "g = [{'pr_url': 'm1', 'golden_index': 0, 'audit_bucket': 'real', 'audit_split': None},\n" +
        "     {'pr_url': 'm2', 'golden_index': 0, 'audit_bucket': 'real', 'audit_split': 'tune20'},\n" +
        "     {'pr_url': 'm2', 'golden_index': 1, 'audit_bucket': 'notreal', 'audit_split': 'tune20'}]\n" +
        "v = [{'tool': 'T', 'pr_url': u, 'golden_index': i, 'judge': 'gpt-6.1-sol', 'matched': True} for u, i in (('m1', 0), ('m2', 0), ('m2', 1))]\n" +
        "r = h.martian(g, v, {'test30': ['m1'], 'tune20': ['m2']}); print(json.dumps([r['real_by_half'], r['tools']['T']]))",
    );
    expect(r).toEqual([
      { test30: 1, tune20: 1 },
      { real_found: 2, test30: 1, tune20: 1 },
    ]);
  });
});

describe("elo_ratings", () => {
  const verdict = (w: string) => ({
    overall: { winner: w },
    categories: Object.fromEntries(
      ["recall", "precision", "finding_quality", "writing"].map((c) => [c, { winner: w }]),
    ),
  });
  const row = (judge: string, id: string, pr: string, sha: string, at: string, w: string) => ({
    id,
    pr,
    a: "x",
    b: "y",
    judge,
    status: "ok",
    prompt_sha256: sha,
    at,
    verdict: verdict(w),
  });
  const JUDGMENTS = {
    gpt: [
      row("gpt", "u1", "p1", "old", "2026-01-01T00:00:00Z", "A"), // stale: the unit was re-packed since
      row("gpt", "u2", "p2", "s2", "2026-01-01T00:00:01Z", "A"),
      row("gpt", "u1", "p1", "new", "2026-01-02T00:00:00Z", "B"),
    ],
    opus: [
      row("opus", "u1", "p1", "new", "2026-01-02T00:00:05Z", "B"),
      row("opus", "u2", "p2", "s2", "2026-01-01T00:00:09Z", "A"),
    ],
  };

  // MUTATION: keep a judge's first ok row whatever its hash (drop the current-hash check in finals) — this fails
  it("drops a judgment made at a prompt the unit no longer has", () => {
    const r = py(
      "elo_ratings",
      "j = json.loads(sys.argv[1]); f = h.finals(j); rat = h.ratings({'runs': ['x', 'y'], 'seed': 1}, j)\n" +
        "print(json.dumps([f['gpt']['u1']['verdict']['overall']['winner'], h.stale_count(j), rat['combined']['overall']['games'], rat['agreement']['overall']['same']]))",
      JSON.stringify(JUDGMENTS),
    );
    expect(r).toEqual(["B", { gpt: 1, opus: 0 }, 4, 2]);
  });
});

describe("open_models", () => {
  const runs = join(tmp, "runs");
  const ev = (results: { agent: string; stopReason: string }[]) =>
    JSON.stringify({
      type: "tool_execution_end",
      toolName: "launch_plan",
      result: { details: { results } },
    }) + "\n";
  const kase = (id: string, summary: object, events: string) => {
    const d = join(runs, "r1", "cases", id);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "case-summary.json"), JSON.stringify(summary));
    writeFileSync(join(d, "pi-events.jsonl"), events);
  };
  kase(
    "c1",
    {
      fingerprint: { effort: { effort: "low" } },
      planned_lenses: ["pass-a--sol-med", "pass-validate--sol-high"],
      executed_passes: ["pass-a--sol-med"],
    },
    ev([{ agent: "pass-a--sol-med", stopReason: "stop" }]),
  );
  kase(
    "c2",
    {
      fingerprint: { effort: { effort: "" } },
      planned_lenses: ["pass-b--sol-high"],
      executed_passes: [],
    },
    ev([{ agent: "pass-b--sol-high", stopReason: "stop" }]),
  );
  kase(
    "c3",
    { fingerprint: {}, planned_lenses: ["pass-c--sol-med"], executed_passes: ["pass-c--sol-med"] },
    ev([{ agent: "pass-c--sol-med", stopReason: "error" }]),
  );

  // MUTATION: read only executed_passes in missing_passes (drop the lensfinal check) — this fails
  it("splits the gate's failed passes into lost lens, lost validator and unrecorded", () => {
    const r = py(
      "open_models",
      "s = {'c1': 'r1', 'c2': 'r1', 'c3': 'r1'}; d = h.degraded(sys.argv[1], s); e = h.composition(sys.argv[1], s)\n" +
        "print(json.dumps([d['lens_lost'], d['validator_only_lost'], d['lens_unrecorded_only'], e['total']]))",
      runs,
    );
    expect(r).toEqual([["c3"], ["c1"], ["c2"], { low: 1, default: 2 }]);
  });

  it("reads an arms file's NAME=runs lines and skips comments", () => {
    const f = join(tmp, "arms.txt");
    writeFileSync(f, "# a note\nModel A (low)=r1,r2\n\nModel B=r3\n");
    expect(py("open_models", "print(json.dumps(h.read_arms(sys.argv[1])))", f)).toEqual([
      ["Model A (low)", ["r1", "r2"]],
      ["Model B", ["r3"]],
    ]);
  });
});

describe("do_speed", () => {
  // MUTATION: price only input and output in projection() (drop cacheRead) — this fails
  it("projects a never-run model's cost from every case's recorded usage", () => {
    const base = join(tmp, "proj");
    const cases = [
      { input: 1_000_000, output: 0, cacheRead: 0 },
      { input: 0, output: 1_000_000, cacheRead: 10_000_000 },
    ].map((usage, i) => {
      const d = join(base, `c${i}`);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "case-summary.json"), JSON.stringify({ usage }));
      return d;
    });
    const r = py(
      "do_speed",
      "from pathlib import Path; p = h.projection([Path(x) for x in sys.argv[1:]], h.QWEN_PRICE)\n" +
        "print(json.dumps([p['prs'], round(p['usd_total'], 6), round(p['usd_per_pr'], 6)]))",
      ...cases,
    );
    // $2 input + ($6 output + 10 x $0.20 cache read) = $10 over two PRs
    expect(r).toEqual([2, 10, 5]);
  });

  // MUTATION: count every assistant message as a reply, timed or not — this fails
  it("times a reply from its request to the next message, and counts only timed replies", () => {
    const d = join(tmp, "speed", "case");
    mkdirSync(d, { recursive: true });
    writeFileSync(
      join(d, "case-summary.json"),
      JSON.stringify({
        duration_seconds: 600,
        usage: { input: 1_000_000, output: 1_000_000, cacheRead: 0 },
      }),
    );
    const end = (m: object) => JSON.stringify({ type: "message_end", message: m });
    writeFileSync(
      join(d, "pi-events.jsonl"),
      [
        end({ role: "assistant", timestamp: 1000, usage: { output: 10 } }),
        end({ role: "toolResult", timestamp: 3000 }),
        end({ role: "assistant", timestamp: 4000, usage: { output: 5 } }), // last: no time
        JSON.stringify({
          type: "tool_execution_end",
          toolName: "subagent",
          result: {
            details: {
              results: [
                {
                  messages: [
                    { role: "user", timestamp: 0 },
                    { role: "assistant", timestamp: 10000, usage: { output: 20 } },
                    { role: "toolResult", timestamp: 14000 },
                  ],
                },
              ],
            },
          },
        }),
      ].join("\n") + "\n",
    );
    const r = py(
      "do_speed",
      "from pathlib import Path; s = h.case_stats(Path(sys.argv[1]), {'input': 1, 'output': 2, 'cacheRead': 0})\n" +
        "print(json.dumps([s['minutes'], s['output'], s['replies'], s['timed'], s['usd']]))",
      d,
    );
    expect(r).toEqual([
      10,
      35,
      2,
      [
        [2, 10],
        [4, 20],
      ],
      3,
    ]);
  });
});

describe("the committed data behind the README", () => {
  const README = readFileSync(join(ROOT, "README.md"), "utf8");
  const elo = JSON.parse(
    readFileSync(
      join(ROOT, "bench", "aacr", "showcase", "data", "elo-martian-hard20.json"),
      "utf8",
    ),
  );

  // MUTATION: change one row's "elo" in bench/aacr/showcase/data/elo-martian-hard20.json by 1 — this fails
  it("the Elo chart's data is what the README's alt text and prose say", () => {
    const alt = /<img src="docs\/media\/bench-elo\.png" alt="([^"]+)"/.exec(README)?.[1] ?? "";
    const printed = [...alt.matchAll(/\b1[0-9]{3}\b/g)].map((m) => Number(m[0]));
    expect(printed).toEqual(elo.rows.map((r: { elo: number }) => Math.round(r.elo)));
    expect(README).toContain(`their ${elo.games} verdicts`);
    expect(README).toContain(
      `same winner only ${Math.round(100 * elo.agreement_overall)}% of the time`,
    );
    const pair = elo.pairs.find(
      (p: { upper: string; lower: string }) =>
        p.upper === "ccvq-hard20-qr-opus55" && p.lower === "ccvq-hard20-cc-high-opus55",
    );
    const { w, t, l } = pair.direct;
    expect(README).toContain(`in ${w} of ${w + t + l} verdicts`);
  });

  // MUTATION: add a qodo-rules30 PR to bench/aacr/sets/qodo-heldout31.json — this fails
  it("the held-out Qodo set is 31 PRs of qodo-pr100 in no validation set", () => {
    const urls = (name: string): string[] =>
      JSON.parse(
        readFileSync(join(ROOT, "bench", "aacr", "sets", `${name}.json`), "utf8"),
      ).cases.map((c: { pr_url: string }) => c.pr_url);
    const held = urls("qodo-heldout31");
    expect(held).toHaveLength(31);
    expect(new Set(held).size).toBe(31);
    const all = new Set(urls("qodo-pr100"));
    expect(held.filter((u) => !all.has(u))).toEqual([]);
    for (const s of [
      "qodo-rules30",
      "qodo-swift13",
      "qodo-miss6",
      "qodo-dv5",
      "dedup5-qodo",
      "qodo-smoke10",
    ]) {
      const used = new Set(urls(s));
      expect(
        held.filter((u) => used.has(u)),
        s,
      ).toEqual([]);
    }
  });
});

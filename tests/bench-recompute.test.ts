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
//      README's alt text and prose say, the held-out Qodo set is 31 PRs of
//      qodo-pr100 in no validation set, and final/score.sh prints tab:copilot2025
//      on its 19 PRs from the arms the other tables use;
//   7. another judge's verdicts: score_verdicts, qodo_scores, martian_scores and
//      --judge on aacr_bootstrap and heldout score them beside ours and refuse
//      what the release cannot place; score_verdicts --select scores only the PRs
//      a claim's selector names; a judge of some PRs is scored beside ours on
//      those PRs alone; elo_ratings rates the plan's judges;
//   8. judge_prompt equals defects.ts judgePrompt() on the same inputs, refuses
//      a link-only review and writes no prompt the judge was never given.

import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { judgePrompt, type Defect } from "../src/bench/defects.js";

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

  // MUTATION: make elo_ratings.displaced return {} — this fails
  // MUTATION: in displaced, count a unit whose other judges hold a judgment at the current hash — this fails
  it("names a judge whose newer prompt set the others' judgments of a unit aside", () => {
    const repacked = {
      ...JUDGMENTS,
      third: [
        row("third", "u1", "p1", "other", "2026-01-03T00:00:00Z", "A"),
        row("third", "u2", "p2", "s2", "2026-01-03T00:00:01Z", "A"),
      ],
    };
    const r = py(
      "elo_ratings",
      "print(json.dumps([h.displaced(json.loads(sys.argv[1])), h.displaced(json.loads(sys.argv[2]))]))",
      JSON.stringify(JUDGMENTS),
      JSON.stringify(repacked),
    );
    expect(r).toEqual([{}, { third: 1 }]);
  });

  // MUTATION: hard-code the rated judges as ("gpt", "opus") again in elo_ratings — this fails
  it("rates the judges the plan names: a third judge gets its table, every pair its agreement, all of them the pool", () => {
    const third = {
      ...JUDGMENTS,
      third: [
        row("third", "u1", "p1", "new", "2026-01-03T00:00:00Z", "A"),
        row("third", "u2", "p2", "s2", "2026-01-03T00:00:01Z", "A"),
      ],
    };
    const r = py(
      "elo_ratings",
      "j = json.loads(sys.argv[1]); p = {'runs': ['x', 'y'], 'seed': 1, 'judges': {'gpt': {}, 'opus': {}, 'third': {}}}\n" +
        "rat = h.ratings(p, j); one = h.ratings({'runs': ['x', 'y'], 'seed': 1, 'judges': {'gpt': {}}}, j)\n" +
        "print(json.dumps([sorted(k for k in rat if k not in ('agreement', 'combined')), {k: v['overall']['same'] for k, v in rat['agreement'].items()},\n" +
        "  rat['combined']['overall']['games'], sorted(one)]))",
      JSON.stringify(third),
    );
    expect(r).toEqual([
      ["gpt", "opus", "third"],
      { "gpt|opus": 2, "gpt|third": 1, "opus|third": 1 },
      6,
      ["gpt"],
    ]);
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

  // MUTATION: drop the tab:copilot2025 call from bench/aacr/final/score.sh — this fails
  // MUTATION: drop its --exclude-refs (the table's AACR columns are the bot-reference-free ones) — this fails
  // MUTATION: give a row of final/arms-copilot2025.txt other runs than the same arm in arms.txt or arms-gpt6sol.txt — this fails
  it("final/score.sh prints tab:copilot2025: its 19 PRs, bot references removed, the arms the other tables use", () => {
    const FINAL_DIR = join(ROOT, "bench", "aacr", "final");
    const bin = join(tmp, "score-bin");
    const log = join(tmp, "score-uv.log");
    mkdirSync(bin, { recursive: true });
    // a stand-in uv: one line per call, its arguments joined by a tab
    writeFileSync(
      join(bin, "uv"),
      `#!/bin/sh
(IFS='	'; printf '%s\n' "$*") >> "${log}"
`,
      {
        mode: 0o755,
      },
    );
    writeFileSync(log, "");
    execFileSync(join(FINAL_DIR, "score.sh"), [], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        QCR_BENCH_RUNS_DIR: tmp,
        QCR_CHARTS_OUT: join(tmp, "score-charts"),
      },
    });
    const cases = readFileSync(join(FINAL_DIR, "copilot19.txt"), "utf8").trim();
    const calls = readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split("\t"));
    const call = calls.find((c) => c[3] === cases);
    expect(call, "a compare.py call on copilot19.txt").toBeDefined();
    expect(call!.slice(0, 3)).toEqual(["run", `${FINAL_DIR}/../compare.py`, "--cases"]);
    expect(call!.slice(4, 6)).toEqual(["--exclude-refs", `${FINAL_DIR}/../bot_references.json`]);
    const lines = (name: string): string[] =>
      readFileSync(join(FINAL_DIR, name), "utf8").split("\n").filter(Boolean);
    const rows = lines("arms-copilot2025.txt");
    expect(call!.slice(6)).toEqual(rows);
    const ids = cases.split("+").flatMap((g) => g.split(":")[1]!.split(","));
    expect(ids).toHaveLength(19);
    expect(new Set(ids).size).toBe(19);
    // Each QuickReview and comparator row is the arm another table prints under the same runs.
    const runs = (line: string): string => line.slice(line.indexOf("=") + 1);
    const byName = (name: string): Map<string, string> =>
      new Map(lines(name).map((l) => [l.slice(0, l.indexOf("=")), runs(l)]));
    const sol = byName("arms-gpt6sol.txt");
    const fin = byName("arms.txt");
    const want = new Map<string, string | undefined>([
      ["QuickReview default", sol.get("QuickReview default")],
      ["QuickReview default, gpt-6.1-sol", fin.get("QuickReview default")],
      ["QuickReview low", sol.get("QuickReview low")],
      ...["Claude Code (Opus 5.5)", "open-code-review", "pi-review", "OpenCode", "Codex CLI"].map(
        (n): [string, string | undefined] => [n, sol.get(n)],
      ),
    ]);
    const got = byName("arms-copilot2025.txt");
    for (const [name, r] of want) expect(got.get(name), name).toBe(r);
    expect(rows).toHaveLength(10);
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

// Another judge's verdicts on the published reviews (score_verdicts, qodo_scores,
// martian_scores, and --judge on aacr_bootstrap and heldout): one fixture
// release, our verdicts in it, the other judge's answers in their own dir
// with no judge column, scored side by side; the scorers refuse what the
// release cannot place.
describe("another judge's verdicts", () => {
  const D = join(tmp, "rejudge");
  const MINE = join(tmp, "rejudge-mine");
  const SETS = join(tmp, "rejudge-sets");
  const F = "quickreview-frozen";
  const QF = { work_dir: "final1-qodo-pr100", tool: "quickreview-frozen" };
  const QE = { work_dir: "ext-r6-qodo-pr100", tool: "quickreview-2026-10-02" };
  const MW = { work_dir: "final1-martian50", tool: "quickreview" };
  const QJ = "gpt-6.1-sol";
  const dv = (instance_id: string, defect_id: string, verdict: string, judge?: string) => ({
    arm_id: F,
    ...(judge ? { judge } : {}),
    instance_id,
    defect_id,
    verdict,
    credit: { found: 1, partial: 0.5, missed: 0 }[verdict],
  });
  const cv = (instance_id: string, grade: string, judge?: string) => ({
    arm_id: F,
    ...(judge ? { judge } : {}),
    instance_id,
    comment_id: "C1",
    grade,
    defect_id: null,
    new_defect: false,
  });
  const qv = (
    run: object,
    pr_url: string,
    issue_index: number,
    comment_index: number | null,
    judge?: string,
  ) => ({
    ...run,
    ...(judge ? { judge } : {}),
    pr_url,
    issue_index,
    matched: comment_index !== null,
    comment_index,
  });
  const mv = (pr_url: string, golden_index: number, matched: boolean, judge?: string) => ({
    ...MW,
    ...(judge ? { judge } : {}),
    pr_url,
    golden_index,
    matched,
  });
  const c = (index: number, path: string, line: number) => ({
    index,
    path,
    start: line,
    end: line,
    body: `c${index}`,
  });
  // Ours: p1/d1 found, p1/d2 partial, p2/d1 found, p3/d1 no row (2.5 of 4);
  // mine: p1/d2 missed, p3/d1 found (3 of 4). Two of the four pairs agree.
  jsonl(D, "prs", PRS);
  jsonl(D, "arms", [{ arm_id: F, judge: J }]);
  jsonl(D, "defects", DEFECTS);
  jsonl(
    D,
    "reviews",
    ["p1", "p2", "p3"].map((i) => ({
      arm_id: F,
      instance_id: i,
      judged: true,
      judged_by: [J],
      comments: [{ id: "C1" }],
      n_comments: 1,
      cost_usd: 1,
      minutes: 1,
      run: "r",
      status: "ok",
    })),
  );
  jsonl(D, "defect_verdicts", [
    dv("p1", "d1", "found", J),
    dv("p1", "d2", "partial", J),
    dv("p2", "d1", "found", J),
  ]);
  jsonl(D, "comment_verdicts", [
    cv("p1", "correct-valuable", J),
    cv("p2", "incorrect", J),
    cv("p3", "correct-minor", J),
  ]);
  jsonl(MINE, "defect_verdicts", [
    dv("p1", "d1", "found"),
    dv("p1", "d2", "missed"),
    dv("p2", "d1", "found"),
    dv("p3", "d1", "found"),
  ]);
  jsonl(MINE, "comment_verdicts", [
    cv("p1", "correct-valuable"),
    cv("p2", "correct-minor"),
    cv("p3", "correct-minor"),
  ]);
  // Qodo: three issues on two PRs; the frozen build's second comment on q1 names
  // the rule issue 39 lines away (a semantic match, never a hit at N=5).
  jsonl(D, "qodo_issues", [
    {
      pr_url: "q1",
      issue_index: 0,
      functional: true,
      file_path: "a.py",
      start_line: 10,
      end_line: 12,
    },
    {
      pr_url: "q1",
      issue_index: 1,
      functional: false,
      file_path: "b.py",
      start_line: 1,
      end_line: 1,
    },
    {
      pr_url: "q2",
      issue_index: 0,
      functional: true,
      file_path: "c.py",
      start_line: 5,
      end_line: 5,
    },
  ]);
  const rev = (run: object, pr_url: string, comments: object[]) => ({
    ...run,
    pr_url,
    comments,
    n_comments: comments.length,
    cost_usd: null,
    minutes: null,
  });
  jsonl(D, "qodo_reviews", [
    rev(QF, "q1", [c(0, "a.py", 11), c(1, "b.py", 40)]),
    rev(QF, "q2", [c(0, "c.py", 5)]),
    rev(QE, "q1", [c(0, "a.py", 11)]),
    rev(QE, "q2", []),
  ]);
  const loc = (row: object, n5: boolean) => ({ ...row, located_n5: n5, located_same_file: n5 });
  jsonl(D, "qodo_verdicts", [
    loc(qv(QF, "q1", 0, 0, QJ), true),
    loc(qv(QF, "q1", 1, null, QJ), false),
    loc(qv(QF, "q2", 0, null, QJ), false),
    loc(qv(QE, "q1", 0, 0, QJ), true),
    loc(qv(QE, "q1", 1, null, QJ), false),
    loc(qv(QE, "q2", 0, null, QJ), false),
  ]);
  jsonl(MINE, "qodo_verdicts", [
    qv(QF, "q1", 0, 0),
    qv(QF, "q1", 1, 1),
    qv(QF, "q2", 0, 0),
    qv(QE, "q1", 0, 0),
    qv(QE, "q1", 1, null),
    qv(QE, "q2", 0, null),
  ]);
  // Martian: m1 has a bug and a style golden, m2 a bug; ours matched both of m1's.
  jsonl(D, "martian_goldens", [
    { pr_url: "m1", golden_index: 0, category: "bug", audit_bucket: "real" },
    { pr_url: "m1", golden_index: 1, category: "style", audit_bucket: "real" },
    { pr_url: "m2", golden_index: 0, category: "bug", audit_bucket: "real" },
  ]);
  jsonl(D, "martian_reviews", [
    { ...MW, judge: QJ, pr_url: "m1", fp: 3 },
    { ...MW, judge: QJ, pr_url: "m2", fp: 1 },
  ]);
  jsonl(D, "martian_verdicts", [
    mv("m1", 0, true, QJ),
    mv("m1", 1, true, QJ),
    mv("m2", 0, false, QJ),
  ]);
  // Our stored scores, from Martian's formulas over the counts above (tp, fp, fn).
  const prf = (tp: number, fp: number, fn: number) => {
    const p = tp / (tp + fp);
    const r = tp / (tp + fn);
    return {
      tp,
      fp,
      fn,
      precision: p,
      recall: r,
      f1: (2 * p * r) / (p + r),
      f2: (5 * p * r) / (4 * p + r),
    };
  };
  const stored = (all: number[], core: number[]) =>
    Object.fromEntries(
      Object.entries({
        all: prf(all[0]!, all[1]!, all[2]!),
        core: prf(core[0]!, core[1]!, core[2]!),
        strict: prf(core[0]!, core[1]!, core[2]!),
      }).flatMap(([p, v]) => Object.entries(v).map(([k, x]) => [`${p}_${k}`, x])),
    );
  jsonl(D, "martian_scores", [
    { ...MW, judge: QJ, ...stored([2, 4, 1], [1, 4, 1]) },
    { work_dir: "calib.martian", tool: "quickreview", judge: QJ, ...stored([1, 1, 1], [1, 1, 1]) },
  ]);
  jsonl(MINE, "martian_verdicts", [mv("m1", 0, true), mv("m1", 1, false), mv("m2", 0, true)]);
  jsonl(MINE, "martian_reviews", [
    { ...MW, pr_url: "m1", fp: 1 },
    { ...MW, pr_url: "m2", fp: 0 },
  ]);
  // A sample: the other judge on p1, q1 and m1 alone.
  const PART = join(tmp, "rejudge-part");
  jsonl(PART, "defect_verdicts", [dv("p1", "d1", "found"), dv("p1", "d2", "missed")]);
  jsonl(PART, "qodo_verdicts", [qv(QF, "q1", 0, 0), qv(QF, "q1", 1, 1)]);
  jsonl(PART, "martian_verdicts", [mv("m1", 0, true), mv("m1", 1, false)]);
  jsonl(PART, "martian_reviews", [{ ...MW, pr_url: "m1", fp: 1 }]);
  mkdirSync(SETS, { recursive: true });
  const set = (name: string, cases: object[]) =>
    writeFileSync(join(SETS, `${name}.json`), JSON.stringify({ cases }));
  set("holdout10", [{ instance_id: "p1" }]);
  set("fresh10", [{ instance_id: "p2" }]);
  set("martian-test30", [{ pr_url: "m1" }]);
  set("martian-tune20", [{ pr_url: "m2" }]);
  set("qodo-heldout31", [{ pr_url: "q1" }, { pr_url: "q2" }]);

  const script = (name: string, ...args: string[]) =>
    execFileSync("python3", ["-I", join(RECOMPUTE, name), ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    }).toString();
  const refused = (name: string, ...args: string[]): string => {
    try {
      script(name, ...args);
      return "";
    } catch (e) {
      return String((e as { stderr: Buffer }).stderr);
    }
  };
  const json = (name: string, ...args: string[]) => {
    const out = join(tmp, `${name}.${args.length}.json`);
    script(name, ...args, "--json", out);
    return JSON.parse(readFileSync(out, "utf8"));
  };

  // MUTATION: drop the judged_by append in score_verdicts.WithJudge (no review is "both judged") — this fails
  // MUTATION: label your rows with the arm's own judge instead of --judge (score_verdicts.defect_rows via with_judge) — this fails
  it("score_verdicts: recall, precision and agreement under the new judge, beside ours", () => {
    const r = json("score_verdicts.py", "--data", D, "--verdicts", MINE, "--judge", "my-judge")
      .arms[F];
    expect(r.reviews).toBe(3);
    expect(r["my-judge"]).toMatchObject({ found: 3, defects: 4, recall: 75, correct: 100 });
    expect(r[J]).toMatchObject({ found: 2.5, recall: 62.5 });
    expect(r[J].correct).toBeCloseTo(200 / 3);
    expect(r.agreement).toMatchObject({ pairs: 4, pct: 50, c_pairs: 3 });
    expect(r.agreement.c_pct).toBeCloseTo(200 / 3);
  });

  // MUTATION: build score_verdicts.score's keys without the --select selector — this fails
  it("score_verdicts --select scores only the PRs the selector names, ours and the new judge's alike", () => {
    const r = json(
      "score_verdicts.py",
      "--data",
      D,
      "--verdicts",
      MINE,
      "--judge",
      "my-judge",
      "--select",
      "pr=p1",
    );
    expect(r.select).toBe("pr=p1");
    expect(r.arms[F]["my-judge"]).toMatchObject({ found: 1, defects: 2, recall: 50 });
    expect(r.arms[F][J]).toMatchObject({ found: 1.5, defects: 2, recall: 75 });
  });

  // MUTATION: in score_verdicts.score, never treat a judge of some PRs as a sample (no pr= restriction) — this fails
  // MUTATION: in score_verdicts.score, build Judges over the whole tables (drop only_judged_on) — this fails
  it("score_verdicts: a judge of some PRs is scored beside ours on those PRs, and --select narrows the agreement", () => {
    const r = json("score_verdicts.py", "--data", D, "--verdicts", PART, "--judge", "my-judge")
      .arms[F];
    expect(r).toMatchObject({ reviews: 1, reference_reviews: 3, sample: true });
    expect(r["my-judge"]).toMatchObject({ found: 1, defects: 2, recall: 50 });
    expect(r[J]).toMatchObject({ found: 1.5, defects: 2, recall: 75 });
    const whole = json(
      "score_verdicts.py",
      "--data",
      D,
      "--verdicts",
      PART,
      "--judge",
      "my-judge",
      "--whole-run",
    ).arms[F];
    expect(whole.sample).toBe(false);
    expect(whole["my-judge"]).toMatchObject({ found: 1, defects: 4, recall: 25 });
    expect(whole[J]).toMatchObject({ found: 2.5, recall: 62.5 });
    const sel = json(
      "score_verdicts.py",
      "--data",
      D,
      "--verdicts",
      MINE,
      "--judge",
      "my-judge",
      "--select",
      "pr=p1",
    ).arms[F];
    expect(sel.reviews).toBe(1);
    expect(sel.agreement).toMatchObject({ pairs: 2, c_pairs: 1 });
  });

  // MUTATION: drop the published-label check in tables.with_judge — this fails
  // MUTATION: drop the credit check in score_verdicts.defect_rows — this fails
  it("score_verdicts refuses a used label, a defect not in the key and a credit that is not the verdict's", () => {
    expect(refused("score_verdicts.py", "--data", D, "--verdicts", MINE, "--judge", J)).toMatch(
      /already labels published defect_verdicts rows/,
    );
    const bad = join(tmp, "rejudge-bad");
    jsonl(bad, "defect_verdicts", [dv("p1", "d9", "found")]);
    expect(refused("score_verdicts.py", "--data", D, "--verdicts", bad, "--judge", "x")).toMatch(
      /not in the key/,
    );
    jsonl(bad, "defect_verdicts", [{ ...dv("p1", "d1", "found"), credit: 0.5 }]);
    expect(refused("score_verdicts.py", "--data", D, "--verdicts", bad, "--judge", "x")).toMatch(
      /credit 0.5 is not the credit of 'found'/,
    );
  });

  // MUTATION: drop `judge=judge` from aacr_bootstrap's per_pr call in bootstrap() — this fails
  it("aacr_bootstrap --judge scores that judge's verdicts", () => {
    const r = json(
      "aacr_bootstrap.py",
      "--data",
      D,
      "--arms",
      F,
      "--resamples",
      "50",
      "--judge",
      "my-judge",
      "--verdicts",
      MINE,
    );
    expect(r.judge).toBe("my-judge");
    expect(r.intervals[F].recall.point).toBeCloseTo(75);
    const ours = json("aacr_bootstrap.py", "--data", D, "--arms", F, "--resamples", "50");
    expect(ours.intervals[F].recall.point).toBeCloseTo(62.5);
  });

  // MUTATION: drop `and v["judge"] == judge` from claim_metrics.Qodo — this fails (our hits become the union)
  // MUTATION: trust a supplied located_n5 instead of computing it in qodo_scores.verdict_rows — this fails
  it("qodo_scores: hits under the location rule, per judge, on the run and on the committed held-out set", () => {
    const r = json(
      "qodo_scores.py",
      "--data",
      D,
      "--verdicts",
      MINE,
      "--judge",
      "my-judge",
      "--sets-dir",
      SETS,
      "--resamples",
      "50",
    );
    const f = r.runs["final1-qodo-pr100|quickreview-frozen"];
    expect(f["my-judge"]).toMatchObject({ hits: 2, comments: 3 });
    expect(f["my-judge"].recall).toBeCloseTo(200 / 3);
    expect(f["my-judge"].recall_semantic).toBeCloseTo(100);
    expect(f[QJ]).toMatchObject({ hits: 1, comments: 3 });
    expect(f.heldout["my-judge"]).toMatchObject({ hits: 2, issues: 3 });
    expect(r.gain["my-judge"].diff).toBeCloseTo(100 / 3);
    expect(r.gain[QJ].diff).toBeCloseTo(0);
    const bad = join(tmp, "rejudge-bad-q");
    jsonl(bad, "qodo_verdicts", [{ ...qv(QF, "q1", 1, 1), located_n5: true }]);
    expect(
      refused("qodo_scores.py", "--data", D, "--verdicts", bad, "--judge", "x", "--sets-dir", SETS),
    ).toMatch(/located_n5 True disagrees with the comment's location/);
    jsonl(bad, "qodo_verdicts", [qv(QF, "q1", 0, 0), qv(QF, "q1", 1, 0)]);
    expect(
      refused("qodo_scores.py", "--data", D, "--verdicts", bad, "--judge", "x", "--sets-dir", SETS),
    ).toMatch(/credits two issues/);
  });

  // MUTATION: in qodo_scores.main, never scope a run to the PRs the judge judged (scope None for every run) — this fails
  it("qodo_scores: a judge of some PRs is scored beside ours on those PRs' issues and comments", () => {
    const run = (...extra: string[]) =>
      json(
        "qodo_scores.py",
        "--data",
        D,
        "--verdicts",
        PART,
        "--judge",
        "my-judge",
        "--sets-dir",
        SETS,
        "--resamples",
        "50",
        ...extra,
      ).runs["final1-qodo-pr100|quickreview-frozen"];
    const f = run();
    expect(f).toMatchObject({ prs: 1, run_prs: 2, sample: true, heldout_prs: 1 });
    expect(f["my-judge"]).toMatchObject({ hits: 1, comments: 2, recall: 50, precision: 50 });
    expect(f[QJ]).toMatchObject({ hits: 1, comments: 2, recall: 50 });
    expect(f.heldout["my-judge"]).toMatchObject({ hits: 1, issues: 2 });
    const whole = run("--whole-run");
    expect(whole.sample).toBe(false);
    expect(whole["my-judge"]).toMatchObject({ hits: 1, comments: 3 });
    expect(whole["my-judge"].recall).toBeCloseTo(100 / 3);
  });

  // MUTATION: in martian_scores.main, count ours over every PR on a sample (drop `mine if sample`) — this fails
  // MUTATION: drop the not_recomputed listing from martian_scores.main — this fails
  it("martian_scores: a judge of some PRs is scored beside ours on those PRs; ours names what it cannot recompute", () => {
    const r = json("martian_scores.py", "--data", D, "--verdicts", PART, "--judge", "my-judge")
      .runs["final1-martian50|quickreview"];
    expect(r).toMatchObject({ prs: 1, reference_prs: 2, sample: true, stored: null });
    expect(r["my-judge"]).toMatchObject({ all_tp: 1, all_fp: 1, all_fn: 1 });
    expect(r["gpt-6.1-sol"]).toMatchObject({ all_tp: 2, all_fp: 3, all_fn: 0 });
    const whole = json(
      "martian_scores.py",
      "--data",
      D,
      "--verdicts",
      PART,
      "--judge",
      "my-judge",
      "--whole-run",
    ).runs["final1-martian50|quickreview"];
    expect(whole["gpt-6.1-sol"]).toMatchObject({ all_tp: 2, all_fp: 4, all_fn: 1 });
    expect(json("martian_scores.py", "--data", D).not_recomputed).toEqual([
      "calib.martian|quickreview",
    ]);
  });

  // MUTATION: count Core's tp over every golden (drop PROFILES' exclusion in martian_scores.counts) — this fails
  it("martian_scores: our stored scores recompute, and the new judge's are counted the same way", () => {
    const ours = json("martian_scores.py", "--data", D).runs["final1-martian50|quickreview"];
    expect(ours.stored_equal).toBe(true);
    const r = json("martian_scores.py", "--data", D, "--verdicts", MINE, "--judge", "my-judge")
      .runs["final1-martian50|quickreview"];
    expect(r["my-judge"]).toMatchObject({
      all_tp: 2,
      all_fp: 1,
      all_fn: 1,
      core_tp: 2,
      core_fn: 0,
      core_recall: 100,
    });
    expect(r["gpt-6.1-sol"]).toMatchObject({ core_tp: 1, core_fp: 4 });
    const bad = join(tmp, "rejudge-bad-m");
    jsonl(bad, "martian_verdicts", [mv("m2", 5, true)]);
    jsonl(bad, "martian_reviews", [{ ...MW, pr_url: "m2", fp: 0 }]);
    expect(refused("martian_scores.py", "--data", D, "--verdicts", bad, "--judge", "x")).toMatch(
      /a golden the PR does not have/,
    );
  });

  // MUTATION: re-derive the Qodo set under --fixed-set (it needs qodo-pr100.json, which this sets dir lacks) — this fails
  // MUTATION: score heldout's Qodo part with QODO_JUDGE whatever --judge says — this fails
  it("heldout --fixed-set --judge scores every part with the new judge on the committed sets", () => {
    const r = json(
      "heldout.py",
      "--data",
      D,
      "--sets-dir",
      SETS,
      "--aacr-arms",
      F,
      "--resamples",
      "50",
      "--fixed-set",
      "--judge",
      "my-judge",
      "--verdicts",
      MINE,
    );
    expect(r.judges).toEqual({ aacr: "my-judge", martian: "my-judge", qodo: "my-judge" });
    expect(r.aacr.found[F].found).toBe(2); // p1/d1 + p2/d1; ours is 2.5
    expect(r.martian.tools.quickreview).toEqual({ real_found: 2, test30: 1, tune20: 1 });
    expect(r.qodo.derived).toBeNull();
    expect(r.qodo.scores["quickreview-frozen"]).toMatchObject({ hits: 2, issues: 3 });
    expect(r.qodo.recall_gain.diff).toBeCloseTo(100 / 3);
    expect(
      refused("heldout.py", "--data", D, "--sets-dir", SETS, "--aacr-arms", F, "--verdicts", MINE),
    ).toMatch(/--verdicts needs --judge/);
  });

  // MUTATION: keep the papers' eight arms as heldout's default under --judge — this fails (AACR unknown)
  it("heldout --judge with no --aacr-arms scores the arms that judge judged", () => {
    const r = json(
      "heldout.py",
      "--data",
      D,
      "--sets-dir",
      SETS,
      "--resamples",
      "50",
      "--fixed-set",
      "--judge",
      "my-judge",
      "--verdicts",
      MINE,
    );
    expect(Object.keys(r.aacr.found)).toEqual([F]);
    expect(r.aacr.found[F].found).toBe(2);
  });
});

const D_ = (id: string): Defect => ({
  id,
  title: `defect ${id}`,
  statement: `what ${id} breaks`,
  sites: [{ path: "a.py", from_line: 10, to_line: 12, role: "cause" }],
  kind: "bug",
  severity: "high",
  evidence: "a.py:10",
});

// judge_prompt.py is the Python reference of the AACR defect judge's prompt,
// rebuilt from the tables: it must equal src/bench/defects.ts judgePrompt()
// (unchanged since the judging) on the same inputs, byte for byte.
describe("judge_prompt", () => {
  const D = join(tmp, "prompt");
  const AK = join(tmp, "prompt-key");
  const sites = [{ path: "a.py", from_line: 10, to_line: 12, role: "cause" }];
  const defect = (defect_id: string, extra: object = {}) => ({
    instance_id: "o__r@1111111",
    defect_id,
    title: `defect ${defect_id}`,
    statement: `what ${defect_id} breaks`,
    sites,
    kind: "bug",
    severity: "high",
    ...extra,
  });
  const long = "x".repeat(700);
  const comments = [
    {
      id: "C1",
      path: "a.py",
      line: 11,
      end_line: 12,
      deleted_line: false,
      tag: "blocker",
      text: "It breaks",
    },
    {
      id: "C2",
      path: "old.py",
      line: 4,
      end_line: 4,
      deleted_line: true,
      tag: "nit",
      text: "Removed guard",
    },
    {
      id: "C3",
      path: null,
      line: null,
      end_line: null,
      deleted_line: false,
      tag: null,
      text: "No anchor",
    },
  ];
  jsonl(D, "prs", [
    {
      instance_id: "o__r@1111111",
      repo: "o/r",
      head_commit: "hd1",
      merge_base: "mb1",
      title: "Fix it",
    },
    { instance_id: "o__r@2222222", repo: "o/r", head_commit: "hd2" },
    { instance_id: "o__r@3333333", repo: "o/r", head_commit: "hd3" },
  ]);
  jsonl(D, "defects", [
    defect("D1", { counts_if: "must name the None return" }),
    defect("D2", { severity: "low" }),
  ]);
  jsonl(D, "exclusions", [
    { instance_id: "o__r@1111111", index: 1, source: "lens b", reason: long },
    { instance_id: "o__r@1111111", index: 0, source: "lens a", reason: "pre-existing" },
  ]);
  jsonl(D, "reviews", [
    {
      arm_id: "A",
      instance_id: "o__r@1111111",
      verdict: "REQUEST_CHANGES",
      body: "The body.",
      comments,
    },
    { arm_id: "A", instance_id: "o__r@2222222", verdict: null, body: null, comments: [] },
    { arm_id: "A", instance_id: "o__r@3333333", verdict: null, body: null, comments: [] },
    {
      arm_id: "L",
      instance_id: "o__r@1111111",
      verdict: null,
      body: null,
      source_url: "https://example.invalid/pull/1",
      comments: [{ ...comments[0], text: null }],
    },
  ]);
  mkdirSync(join(AK, "fresh10-code", "o__r@2222222"), { recursive: true });
  writeFileSync(
    join(AK, "fresh10-code", "o__r@2222222", "meta.json"),
    JSON.stringify({ instance_id: "o__r@2222222", merge_base: "mb2", title: "From meta" }),
  );
  const prompt = (pr: string) =>
    execFileSync(
      "python3",
      [
        "-I",
        join(RECOMPUTE, "judge_prompt.py"),
        "--data",
        D,
        "--arm",
        "A",
        "--pr",
        pr,
        "--answer-key",
        AK,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    ).toString();

  // MUTATION: render a deleted-line comment's anchor without " (deleted line)" in judge_prompt.where — this fails
  // MUTATION: order the exclusions by table order instead of `index` in judge_prompt.Prompts — this fails
  // MUTATION: cut an exclusion's reason at 500 instead of MAX_EXCLUDED_REASON (600) — this fails
  it("equals defects.ts judgePrompt() on the same PR, defects, rejected claims and review", () => {
    const ts = judgePrompt(
      { instance_id: "o__r@1111111", repo: "o/r", title: "Fix it", merge_base: "mb1", head: "hd1" },
      [
        { ...D_("D1"), notes: "must name the None return" },
        { ...D_("D2"), severity: "low" },
      ],
      {
        verdict: "REQUEST_CHANGES",
        body: "The body.",
        comments: [
          { id: "C1", path: "a.py", line: 11, end_line: 12, tag: "blocker", text: "It breaks" },
          {
            id: "C2",
            path: "old.py (deleted line)",
            line: 4,
            end_line: 4,
            tag: "nit",
            text: "Removed guard",
          },
          { id: "C3", path: null, line: null, end_line: null, tag: null, text: "No anchor" },
        ],
      },
      [
        { source: "lens a", reason: "pre-existing" },
        { source: "lens b", reason: long },
      ],
    );
    expect(prompt("o__r@1111111")).toBe(ts + "\n");
    const empty = judgePrompt(
      {
        instance_id: "o__r@2222222",
        repo: "o/r",
        title: "From meta",
        merge_base: "mb2",
        head: "hd2",
      },
      [],
      { verdict: null, body: null, comments: [] },
    );
    expect(prompt("o__r@2222222")).toBe(empty + "\n");
  });

  // MUTATION: drop the link-only refusal from judge_prompt.Prompts.prompt — this fails
  // MUTATION: in judge_prompt.main, write a prompt for every review of the arm under --all — this fails
  it("refuses a link-only review, and --all leaves out the reviews the judge was never asked about", () => {
    const run = (...args: string[]) =>
      execFileSync("python3", ["-I", join(RECOMPUTE, "judge_prompt.py"), "--data", D, ...args], {
        stdio: ["ignore", "pipe", "pipe"],
      }).toString();
    expect(() => run("--arm", "L", "--pr", "o__r@1111111")).toThrow(/link-only/);
    const out = join(tmp, "prompt-all");
    expect(run("--arm", "A", "--all", "--out-dir", out)).toMatch(
      /wrote 1 prompts of A .* left out 2 reviews/,
    );
    expect(readdirSync(out)).toEqual(["o__r@1111111.txt"]);
  });

  // MUTATION: fall back to prs.base_commit when no merge base is found — this fails
  it("refuses a PR whose merge base it cannot find, never guessing prs.base_commit", () => {
    expect(() => prompt("o__r@3333333")).toThrow(/no merge base/);
  });
});

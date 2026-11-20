// The dataset's GPT-6.2 Sol comparison (`gpt62_sol/`): the export copies the folder only when it is the
// committed manifest's, validation.json checks it (its rows against the dataset's final1 rows and answer
// key, its README, the Elo refit) and recomputes every number of the write-up from the folder and the
// tables, the claims verifier reads those numbers by name, and the card links the folder and counts its
// checks apart. Runs for real under python3, standard library only, on a small comparison of .jsonl
// tables (five pull requests, four Elo plans):
//
//   1. the manifest: a folder with a file missing, extra or changed is refused before anything is copied;
//      without the folder every check fails;
//   2. validation.json's checks pass on a whole folder whose numbers are the expected ones, and each fails
//      on what it guards (a column, each way a row can fail to fit, the README, the refit, the numbers);
//   3. the Elo numbers: each judge over every plan it judged, the pooled fit with each judge weighted the
//      same, position, order, agreement and every attempt;
//   4. the claims verifier, the export and the card;
//   5. the build: the plans lose where they ran, the set-aside first attempts come back in order, and the
//      refusals.

import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AACR = join(ROOT, "bench", "aacr");
const RECOMPUTE = join(AACR, "recompute");
const tmp = mkdtempSync(join(tmpdir(), "hf-gpt62-sol-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const SCRUB_ENV = {
  QCR_SCRUB_HOME: "/home/alice",
  QCR_SCRUB_RUNS_DIR: "/home/alice/projects/qcr-bench-runs",
  QCR_SCRUB_OWNER: "Jordan",
  QCR_SCRUB_BOT: "acme-review,acme-review-2",
  QCR_SCRUB_OLD_NAME: "acme-reviewd",
  QCR_SCRUB_PRIVATE_REPO: "widgetco-app",
};

function py(code: string, ...args: string[]): unknown {
  const p = spawnSync(
    "python3",
    [
      "-c",
      `import sys, json, types, collections; sys.path.insert(0, ${JSON.stringify(RECOMPUTE)}); sys.path.insert(0, ${JSON.stringify(AACR)})\n${code}`,
      ...args,
    ],
    { encoding: "utf8", env: { ...process.env, ...SCRUB_ENV } },
  );
  if (p.status !== 0) throw new Error(p.stderr);
  return JSON.parse(p.stdout);
}

type Row = Record<string, unknown>;

function jsonl(dir: string, name: string, rows: Row[]): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

function rows(dir: string, name: string): Row[] {
  return readFileSync(join(dir, `${name}.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Row);
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

/** A sha256sum manifest of a dataset root's gpt62_sol/ (paths relative to the root). */
function manifest(root: string, path: string): string {
  const lines = files(join(root, "gpt62_sol"))
    .sort()
    .map(
      (p) => `${createHash("sha256").update(readFileSync(p)).digest("hex")}  ${relative(root, p)}`,
    );
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

const N = "s62";
const O = "final1";
const PRS = ["p1", "p2", "p3", "p4", "p5"];
const PLANS = [
  "aacr185-sol62-vs-final1",
  "aacr185-sol62-vs-final1-swap",
  "aacr185-sol62-vs-final1-ds3",
  "aacr185-sol62-vs-final1-ds4",
];
const CATS = ["recall", "precision", "finding_quality", "writing"];

/** Who wins each unit by pull request: "N" (s62), "O" (final1), "tie", or a failed status. */
type W = "N" | "O" | "tie" | "error" | "invalid";
// GPT: in both orders; p2 flips with the order, p4 is a tie in one
const GPT: Record<string, W[]> = {
  [PLANS[0]!]: ["N", "N", "O", "tie", "N"],
  [PLANS[1]!]: ["N", "O", "O", "N", "N"],
};
// DeepSeek: four plans, never answers p5; p4 invalid in the last plan
const DS: Record<string, W[]> = {
  [PLANS[0]!]: ["O", "O", "O", "N", "error"],
  [PLANS[1]!]: ["O", "N", "O", "N", "error"],
  [PLANS[2]!]: ["O", "O", "O", "O"],
  [PLANS[3]!]: ["O", "O", "O", "invalid"],
};

/** The A/B order of unit i of a plan: pass 1 and pass 3 put s62 first on odd PRs, the swaps reverse it. */
function order(plan: number, i: number): [string, string] {
  const first: [string, string] = i % 2 === 0 ? [N, O] : [O, N];
  return plan % 2 === 0 ? first : [first[1], first[0]];
}

function judgment(plan: number, judge: string, i: number, w: W, line: number, aside = false): Row {
  const [a, b] = order(plan, i);
  const ok = w === "N" || w === "O" || w === "tie";
  const ab = w === "tie" ? "tie" : (w === "N" ? N : O) === a ? "A" : "B";
  // recall always to s62; the other categories follow the overall winner
  const recall = ok ? (a === N ? "A" : "B") : null;
  const row: Row = {
    plan: PLANS[plan],
    judgment_file: judge,
    line,
    set_aside: aside,
    unit_id: `u${i + 1}`,
    round: 0,
    pr: PRS[i],
    a,
    b,
    judge,
    judge_model: judge === "gpt" ? "gpt-6.1-sol" : "deepseek-v4.1-flash",
    effort: "xhigh",
    at: `2026-11-19T0${plan}:${String(line).padStart(2, "0")}:00Z`,
    status: ok ? "ok" : w,
    prompt_sha256: `h${plan}${i}`,
    used_in_ratings: ok,
    turns: ok ? 1 : null,
    finish_reason: ok ? "stop" : null,
    http_attempts: 1,
    error: w === "error" ? "timed out after 600 s" : null,
    raw: w === "invalid" ? "not json" : null,
    input_tokens: ok ? 100 : null,
    output_tokens: ok ? 10 : null,
    cached_tokens: ok ? 0 : null,
    reasoning_tokens: ok ? 5 : null,
    overall_winner: ok ? ab : null,
    overall_explanation: ok ? "why" : null,
  };
  for (const c of CATS) {
    row[`${c}_winner`] = ok ? (c === "recall" ? recall : ab) : null;
    row[`${c}_reasoning`] = ok ? "because" : null;
  }
  return row;
}

/**
 * A comparison on five PRs. Answer key: p1 D1 high and D2 low, p2 D1 medium, p3 D1 low, p5 D1 high (key
 * version 1; the others 2). s62 finds p1/D1, p3/D1, p5/D1 and p1/D2 in part (a finding in the review body);
 * final1 finds p1/D1 and p5/D1 and p2/D1 in part.
 */
function dataset(root: string): void {
  const data = join(root, "data");
  const g = join(root, "gpt62_sol");
  const sev: Record<string, [string, string][]> = {
    p1: [
      ["D1", "high"],
      ["D2", "low"],
    ],
    p2: [["D1", "medium"]],
    p3: [["D1", "low"]],
    p5: [["D1", "high"]],
  };
  jsonl(
    data,
    "defects",
    Object.entries(sev).flatMap(([p, ds]) =>
      ds.map(([d, s]) => ({
        instance_id: p,
        defect_id: d,
        severity: s,
        key_version: p === "p5" ? "1" : "2",
      })),
    ),
  );
  jsonl(data, "arms", [
    {
      arm_id: "quickreview-frozen",
      runs: ["smoke10", "dev10", "holdout10", "fresh10", "rest145"].map((s) => `${O}-${s}`),
      judge: "gpt-6-sol-high",
      model_billed: "gpt-6.1-sol",
    },
    { arm_id: "other", runs: ["x"], judge: "j", model_billed: "m" },
  ]);
  jsonl(
    data,
    "reviews",
    PRS.map((p, i) => ({
      arm_id: "quickreview-frozen",
      instance_id: p,
      run: `${O}-rest145`,
      n_comments: 1,
      cost_usd: 1,
      minutes: 5 + i,
    })),
  );
  const fdv: [string, string, string, number][] = [
    ["p1", "D1", "found", 1],
    ["p1", "D2", "missed", 0],
    ["p2", "D1", "partial", 0.5],
    ["p3", "D1", "missed", 0],
    ["p5", "D1", "found", 1],
  ];
  jsonl(
    data,
    "defect_verdicts",
    fdv.map(([p, d, v, c]) => ({
      arm_id: "quickreview-frozen",
      instance_id: p,
      defect_id: d,
      verdict: v,
      credit: c,
    })),
  );
  jsonl(data, "comment_verdicts", [
    {
      arm_id: "quickreview-frozen",
      instance_id: "p1",
      comment_id: "C1",
      grade: "correct-valuable",
      defect_id: "D1",
    },
    {
      arm_id: "quickreview-frozen",
      instance_id: "p2",
      comment_id: "C1",
      grade: "partly-correct",
      defect_id: "D1",
    },
    {
      arm_id: "quickreview-frozen",
      instance_id: "p2",
      comment_id: "C2",
      grade: "incorrect",
      defect_id: null,
    },
    {
      arm_id: "quickreview-frozen",
      instance_id: "p5",
      comment_id: "C1",
      grade: "correct-minor",
      defect_id: "D1",
    },
    { arm_id: "other", instance_id: "p1", comment_id: "C1", grade: "incorrect", defect_id: null },
  ]);

  jsonl(g, "arms", [
    {
      arm_id: N,
      display_name: "new",
      dataset_arm: null,
      image: "img",
      image_id: "sha256:a",
      config: "c",
      profile: null,
      qcr_commit: "a1",
      qcr_commit_on_public_main: true,
      qcr_commit_match: "same",
      qcr_commit_dirty: false,
      pi: "1",
      reviewer_model: "m2",
      judge: "gpt-6.1-sol-high",
      runs: [`${N}-x`],
      prs: 5,
      note: "n",
    },
    {
      arm_id: O,
      display_name: "old",
      dataset_arm: "quickreview-frozen",
      image: null,
      image_id: null,
      config: null,
      profile: null,
      qcr_commit: null,
      qcr_commit_on_public_main: null,
      qcr_commit_match: null,
      qcr_commit_dirty: null,
      pi: null,
      reviewer_model: "m1",
      judge: "gpt-6-sol-high",
      runs: [`${O}-x`],
      prs: 5,
      note: "o",
    },
  ]);
  jsonl(
    g,
    "cases",
    PRS.map((p, i) => ({
      arm_id: N,
      instance_id: p,
      set: "rest145",
      run: `${N}-rest145`,
      status: "ok",
      verdict: "COMMENT",
      usd: i + 1,
      minutes: 10 * (i + 1),
      n_posted: p === "p1" ? 2 : 1,
      judged: true,
      judge_input_tokens: 1,
      judge_output_tokens: 1,
      judge_cache_read_tokens: 0,
    })),
  );
  const review = (p: string, index: number | null, cid: string): Row => ({
    arm_id: N,
    instance_id: p,
    index,
    inline: index !== null,
    path: "a.c",
    line: 1,
    side: index === null ? null : "RIGHT",
    body: `finding ${p} ${cid}`,
    comment_id: cid,
  });
  jsonl(g, "reviews", [
    review("p1", 0, "C1"),
    review("p1", 1, "C2"),
    review("p1", null, "C3"),
    ...["p2", "p3", "p4", "p5"].map((p) => review(p, 0, "C1")),
  ]);
  const dv: [string, string, string, number, string[]][] = [
    ["p1", "D1", "found", 1, ["C1"]],
    ["p1", "D2", "partial", 0.5, ["C3"]],
    ["p2", "D1", "missed", 0, []],
    ["p3", "D1", "found", 1, ["C1"]],
    ["p5", "D1", "found", 1, ["C1"]],
  ];
  jsonl(
    g,
    "defect_verdicts",
    dv.map(([p, d, v, c, ids]) => ({
      arm_id: N,
      instance_id: p,
      judge: "gpt-6.1-sol-high",
      key_version: p === "p5" ? "1" : "2",
      defect_id: d,
      verdict: v,
      credit: c,
      comment_ids: ids,
      why: "w",
    })),
  );
  const cv: [string, string, number | null, string, string | null][] = [
    ["p1", "C1", 0, "correct-valuable", "D1"],
    ["p1", "C2", 1, "incorrect", null],
    ["p1", "C3", null, "partly-correct", "D2"],
    ["p2", "C1", 0, "correct-minor", null],
    ["p3", "C1", 0, "unverifiable", "D1"],
    ["p4", "C1", 0, "correct-valuable", null],
    ["p5", "C1", 0, "correct-valuable", "D1"],
  ];
  jsonl(
    g,
    "comment_verdicts",
    cv.map(([p, c, i, gr, d]) => ({
      arm_id: N,
      instance_id: p,
      judge: "gpt-6.1-sol-high",
      comment_id: c,
      index: i,
      grade: gr,
      defect_id: d,
      new_defect: null,
      why: "w",
    })),
  );
  const labels = [
    { run: N, label: "new" },
    { run: O, label: "old" },
  ];
  jsonl(
    g,
    "elo_plans",
    PLANS.map((p, k) => ({
      plan: p,
      order: k,
      role: `role ${k}`,
      benchmark: "aacr",
      sets: ["rest145"],
      runs: [N, O],
      labels,
      judges: (k < 2 ? ["gpt", "deepseek"] : ["deepseek"]).map((j) => ({
        judge: j,
        model: "m",
        effort: "xhigh",
        max_tokens: null,
        timeout_s: null,
      })),
      max_prompt_tokens: 1,
      round0_prs: 5,
      per_pair_step: 0,
      cap: 5,
      seed: 1,
      note: null,
    })),
  );
  jsonl(
    g,
    "elo_units",
    PLANS.flatMap((p, k) =>
      PRS.slice(0, k < 2 ? 5 : 4).map((pr, i) => {
        const [a, b] = order(k, i);
        return { plan: p, unit_id: `u${i + 1}`, round: 0, pr, a, b };
      }),
    ),
  );
  const js: Row[] = [];
  PLANS.forEach((p, k) => {
    if (GPT[p]) GPT[p].forEach((w, i) => js.push(judgment(k, "gpt", i, w, i)));
    let line = 0;
    // the first DeepSeek attempt of pass 1 at p1 failed and was set aside before the re-judging
    if (k === 0) js.push(judgment(0, "deepseek", 0, "error", line++, true));
    DS[p]!.forEach((w, i) => js.push(judgment(k, "deepseek", i, w, line++)));
    // pass 1: p5 failed twice
    if (k === 0) js.push(judgment(0, "deepseek", 4, "error", line++));
  });
  jsonl(g, "elo_judgments", js);
  writeRefit(g);
  writeReadme(g);
}

/** elo_ratings and elo_gaps as the refit of the folder's judgments gives them (NaN where a judge has too
 * few PRs for an interval, as a parquet float holds it). */
function writeRefit(g: string): void {
  py(
    `import gpt62_sol as G
t = {n: G.load_table(sys.argv[1], n) for n in ("elo_plans", "elo_judgments")}
for name, rs in G.refit_rows(G.refit(t), {"${N}": "new", "${O}": "old"}).items():
    with open(sys.argv[1] + "/" + name + ".jsonl", "w") as f:
        f.write("".join(json.dumps(r) + "\\n" for r in rs))
print(json.dumps("ok"))`,
    g,
  );
}

function writeReadme(g: string): void {
  writeFileSync(
    join(g, "README.md"),
    py("import gpt62_sol as G\nprint(json.dumps(G.readme(G.numbers(sys.argv[1]))))", g) as string,
  );
}

/** The fixture's numbers in POST's shape; the Elo group comes from an independent fit (ELO below). */
const POST_BASE = {
  prs: 5,
  answer_key: {
    defects: 5,
    high: 2,
    medium: 1,
    low: 2,
    [N]: { all: 3.5, high: 2, medium: 0, low: 1.5 },
    [O]: { all: 2.5, high: 2, medium: 0.5, low: 0 },
  },
  comments: {
    [N]: { judged: 7, on_key: 4, not_correct: 3, not_correct_pct: 43, per_pr: 1.4 },
    [O]: { judged: 4, on_key: 3, not_correct: 2, not_correct_pct: 50, per_pr: 0.8 },
  },
  cost: { [N]: { usd_per_pr: 3, minutes_median: 30 }, [O]: { usd_per_pr: 1, minutes_median: 7 } },
  elo_games: {
    gpt: { games: 10, prs: 5 },
    deepseek: { games: 15, prs: 4, prs_never: 1 },
    combined: { games: 35, prs: 5 },
  },
  position: {
    gpt: { a_wins: 4, decided: 9, ties: 1, b_pct: 56 },
    deepseek: { a_wins: 9, decided: 15, ties: 0, a_pct: 60 },
  },
  order: {
    gpt: { pairs: 5, same: 3, flipped: 1, with_tie: 1 },
    deepseek: { pairs: 14, same: 11, flipped: 3, with_tie: 0 },
  },
  agreement: { units: 8, same: 3, opposite: 4, one_tie: 1 },
  attempts: {
    gpt: { total: 10, ok: 10, not_ok: 0 },
    deepseek: { total: 20, ok: 15, not_ok: 5, set_aside: 1 },
  },
};

/**
 * The Elo group from the games written out by hand and elo_rating.table directly: the GPT judge's ten
 * games, DeepSeek's fifteen, and the pooled fit with every GPT game twice (two plans against four).
 */
const ELO = py(
  `sys.path.insert(0, ${JSON.stringify(join(AACR, "elo"))})
import elo_rating as R, gpt62_sol as G
gpt = {"overall": "NNOtNNOONN", "recall": "NNNNNNNNNN"}
ds = {"overall": "OOONONONOOOOOOO", "recall": "NNNNNNNNNNNNNNN"}
gpt_prs = ["p1", "p2", "p3", "p4", "p5"] * 2
ds_prs = ["p1", "p2", "p3", "p4"] * 3 + ["p1", "p2", "p3"]
S = {"N": 1.0, "O": 0.0, "t": 0.5}
def games(ws, prs):
    return [(p, "s62", "final1", S[w]) for w, p in zip(ws, prs)]
out = {"gpt": {}, "deepseek": {}, "combined": {}}
for c in ("overall", "recall", "precision", "finding_quality", "writing"):
    g = games(gpt["recall" if c == "recall" else "overall"], gpt_prs)
    d = games(ds["recall" if c == "recall" else "overall"], ds_prs)
    for k, gs in (("gpt", g), ("deepseek", d), ("combined", g * 2 + d)):
        x = G._signed(R.table(["s62", "final1"], gs, reps=G.REPS))
        out[k][c] = [G._i(v) for v in x]
print(json.dumps(out))`,
) as Record<string, Record<string, (number | null)[]>>;

const POST = { ...POST_BASE, elo: ELO };

const BASE = join(tmp, "base");
dataset(BASE);
const MANIFEST = manifest(BASE, join(tmp, "gpt62-sol.sha256"));

/** A copy of the base dataset changed by `edit`; its README rendered again unless `keepReadme`. */
function variant(name: string, edit: (g: string) => void, keepReadme = false): string {
  const root = join(tmp, name);
  const g = join(root, "gpt62_sol");
  cpSync(BASE, root, { recursive: true });
  edit(g);
  if (!keepReadme && existsSync(join(g, "README.md"))) {
    try {
      writeReadme(g);
    } catch {
      // tables readme() cannot render: the README stays the base's, and fails its check
    }
  }
  return root;
}

function edit(g: string, table: string, f: (r: Row) => Row | null): void {
  jsonl(
    g,
    table,
    rows(g, table)
      .map(f)
      .filter((r): r is Row => r !== null),
  );
}

type Check = { check: string; ok: boolean; got: unknown; want: unknown };

function checks(root: string, man = MANIFEST): Check[] {
  return py(
    `import gpt62_sol as G\nprint(json.dumps(G.checks(sys.argv[1], sys.argv[2], json.loads(sys.argv[3])), default=str).replace("NaN", "null"))`,
    root,
    man,
    JSON.stringify(POST),
  ) as Check[];
}

function failing(root: string): string[] {
  return checks(root, manifest(root, join(root, "m.sha256")))
    .filter((c) => !c.ok)
    .map((c) => c.check.replace("gpt62_sol: ", ""));
}

const C = {
  manifest:
    "every file is the committed manifest's (bench/aacr/hf/gpt62-sol.sha256), none missing, extra or differing",
  columns: "every table has exactly its listed columns",
  whole:
    "the rows are whole: s62 reviewed and was judged on final1's pull requests in the dataset (arm quickreview-frozen), one verdict on every answer-key defect at its key version, every judged comment a posted one (inline or in the review body), and every Elo judgment of a unit of its plan between s62 and final1, in its file's order",
  readme: "README.md is the README its tables give (gpt62_sol.readme of numbers())",
  refit:
    "elo_ratings, elo_gaps and elo_judgments.used_in_ratings are the refit of elo_judgments (each judge over every plan it judged, and both pooled with each judge weighted the same)",
  prs: "s62 reviewed all the pull requests",
  answer_key:
    "the answer key's defects by severity, and each setup's credit on them (found 1, partial 0.5) from its defect judge's verdicts",
  comments:
    "the comments each setup's defect judge read: on an answer-key defect, not correct (incorrect, partly correct or unverifiable), and per pull request",
  cost: "list-price dollars per pull request and median minutes per review (compare.usd_and_minutes)",
  elo: "the Elo gap of s62 over final1 with its 95% interval, per judge and pooled, overall and per category (refit from elo_judgments)",
  elo_games:
    "the games each judge's ratings use and the pull requests they cover, and the pull requests DeepSeek never answered",
  position: "how often each judge picked Review A among its decided verdicts",
  order:
    "the pairs each judge judged in both orders: the same winner both times, flipped, or a tie in one",
  agreement: "the units both judges answered: the same winner, opposite winners, one tie",
  attempts: "every judgment attempt by judge and status, the set-aside first attempts included",
};

describe("gpt62_sol: the manifest", () => {
  // MUTATION: in gpt62_sol.manifest_problems, return no "extra" list — this fails
  // MUTATION: in hf_export.refuse_gpt62_sol, return before the manifest check — this fails
  it("refuses a folder with a file missing, extra or changed, before anything is copied", () => {
    const extra = variant("extra", (g) => writeFileSync(join(g, "notes.md"), "x\n"));
    const changed = variant("changed", (g) => appendFileSync(join(g, "README.md"), " "), true);
    const missing = variant("missing", (g) => rmSync(join(g, "elo_gaps.jsonl")));
    const copy = (root: string, out: string) =>
      py(
        `import hf_export as h
try:
    h.copy_gpt62_sol(sys.argv[1], sys.argv[2], sys.argv[3]); print(json.dumps("copied"))
except SystemExit as e:
    print(json.dumps(str(e)))`,
        join(root, "gpt62_sol"),
        out,
        MANIFEST,
      ) as string;
    const out = join(tmp, "copy-out");
    mkdirSync(out, { recursive: true });
    expect(copy(extra, out)).toMatch(
      /not the committed manifest's .*extra \['gpt62_sol\/notes.md'\]/,
    );
    expect(copy(changed, out)).toMatch(/differs \['gpt62_sol\/README.md'\]/);
    expect(copy(missing, out)).toMatch(/missing \['gpt62_sol\/elo_gaps.jsonl'\]/);
    expect(existsSync(join(out, "gpt62_sol"))).toBe(false);
    expect(copy(BASE, out)).toBe("copied");
    expect(
      checks(extra)
        .filter((c) => !c.ok)
        .map((c) => c.check),
    ).toEqual([`gpt62_sol: ${C.manifest}`]);
  });

  // MUTATION: in gpt62_sol.checks, give the number checks `post.get(key)` as got when the folder is missing — this fails
  it("fails every check when the folder is not in the dataset (fails closed)", () => {
    const gone = variant("gone", (g) => rmSync(g, { recursive: true }));
    const cs = checks(gone);
    expect(cs).toHaveLength(15);
    expect(cs.filter((c) => c.ok)).toEqual([]);
  });

  it("the committed manifest is the release folder's: its README and the ten tables", () => {
    const got = py(
      "import gpt62_sol as G\nprint(json.dumps(sorted(G.read_manifest())))",
    ) as string[];
    const tables = py("import gpt62_sol as G\nprint(json.dumps(list(G.TABLES)))") as string[];
    expect(got).toEqual(
      ["gpt62_sol/README.md", ...tables.map((t) => `gpt62_sol/${t}.parquet`)].sort(),
    );
  });
});

describe("gpt62_sol: validation.json's checks", () => {
  it("passes all fifteen on a whole folder that is the manifest's, recomputing every number", () => {
    const cs = checks(BASE);
    expect(cs).toHaveLength(15);
    expect(cs.filter((c) => !c.ok)).toEqual([]);
    expect(cs.find((c) => c.check.endsWith(C.attempts))!.got).toEqual(POST.attempts);
  });

  it("POST holds the write-up's numbers", () => {
    const post = py("import gpt62_sol as G\nprint(json.dumps(G.POST))") as typeof POST;
    expect(post.answer_key).toEqual({
      defects: 520,
      high: 90,
      medium: 145,
      low: 285,
      [N]: { all: 435.5, high: 87, medium: 135, low: 213.5 },
      [O]: { all: 461, high: 87.5, medium: 134.5, low: 239 },
    });
    expect(post.comments[N]).toEqual({
      judged: 1501,
      on_key: 499,
      not_correct: 176,
      not_correct_pct: 12,
      per_pr: 8.1,
    });
    expect(post.comments[O]).toEqual({
      judged: 1278,
      on_key: 507,
      not_correct: 97,
      not_correct_pct: 8,
      per_pr: 6.9,
    });
    expect(post.cost).toEqual({
      [N]: { usd_per_pr: 3.25, minutes_median: 11 },
      [O]: { usd_per_pr: 2.06, minutes_median: 17.5 },
    });
    expect(post.elo.gpt!.overall).toEqual([37, -9, 82]);
    expect(post.elo.deepseek!.overall).toEqual([-77, -122, -34]);
    expect(post.elo.combined).toEqual({
      overall: [-17, -53, 18],
      recall: [115, 78, 152],
      precision: [-101, -139, -64],
      finding_quality: [-78, -111, -48],
      writing: [-105, -142, -69],
    });
    expect(post.elo_games.deepseek.prs_never).toBe(5);
    expect(post.position.gpt.b_pct).toBe(57);
    expect(post.agreement).toEqual({ units: 354, same: 219, opposite: 120, one_tie: 15 });
    expect(Object.keys(post).sort()).toEqual(Object.keys(POST).sort());
  });

  // MUTATION: in gpt62_sol.checks, pass a table that has every listed column (set(want) <= set(c)) — this fails
  it("fails a table carrying a column it does not list", () => {
    const bad = variant("columns", (g) => edit(g, "elo_units", (r) => ({ ...r, host: "x" })));
    expect(failing(bad)).toEqual([C.columns]);
  });

  // MUTATION: in gpt62_sol.whole_problems, skip the defect ids' comparison with the dataset's defects — this fails
  // MUTATION: in gpt62_sol.whole_problems, accept a set-aside ok row — this fails
  // MUTATION: in gpt62_sol.whole_problems, skip the line numbering check — this fails
  it("fails rows that do not fit each other or the dataset's", () => {
    const verdict = variant("whole-verdict", (g) =>
      edit(g, "defect_verdicts", (r) => (r.instance_id === "p2" ? null : r)),
    );
    expect(failing(verdict)).toContain(C.whole);
    const version = variant("whole-version", (g) =>
      edit(g, "defect_verdicts", (r) => (r.instance_id === "p5" ? { ...r, key_version: "2" } : r)),
    );
    expect(failing(version)).toEqual([C.whole]);
    const aside = variant("whole-aside", (g) =>
      edit(g, "elo_judgments", (r) =>
        r.plan === PLANS[1] && r.judgment_file === "deepseek" && r.line === 0
          ? { ...r, set_aside: true }
          : r,
      ),
    );
    expect(failing(aside)).toContain(C.whole);
    const line = variant("whole-line", (g) =>
      edit(g, "elo_judgments", (r) =>
        r.plan === PLANS[2] && r.line === 3 ? { ...r, line: 7 } : r,
      ),
    );
    expect(failing(line)).toEqual([C.whole]);
    const unit = variant("whole-unit", (g) =>
      edit(g, "elo_units", (r) =>
        r.plan === PLANS[3] && r.unit_id === "u4" ? { ...r, b: r.a } : r,
      ),
    );
    expect(failing(unit)).toContain(C.whole);
    const prs = variant("whole-prs", (g) =>
      jsonl(
        join(dirname(g), "data"),
        "reviews",
        rows(join(dirname(g), "data"), "reviews").slice(0, 4),
      ),
    );
    expect(failing(prs)).toContain(C.whole);
    const body = variant("whole-body", (g) =>
      edit(g, "comment_verdicts", (r) => (r.comment_id === "C3" ? { ...r, index: 2 } : r)),
    );
    expect(failing(body)).toEqual([C.whole]);
  });

  // MUTATION: in gpt62_sol.checks, compare README.md with readme() of the base numbers (always True) — this fails
  it("fails a README that is not the one its tables give", () => {
    const bad = variant(
      "readme",
      (g) =>
        writeFileSync(
          join(g, "README.md"),
          readFileSync(join(g, "README.md"), "utf8").replace("## Tables", "## Tablez"),
        ),
      true,
    );
    expect(failing(bad)).toEqual([C.readme]);
  });

  // MUTATION: in gpt62_sol.refit_problems, skip the used_in_ratings comparison — this fails
  // MUTATION: in gpt62_sol.refit_problems, compare only the keys of elo_ratings (not the values) — this fails
  it("fails ratings that are not the refit of the judgments, and a used flag the refit does not set", () => {
    // (python edits it: the table holds NaN, which JSON.parse refuses)
    const value = variant("refit-value", (g) =>
      py(
        `import gpt62_sol as G
rs = G.load_table(sys.argv[1], "elo_ratings")
rs[0]["elo"] = 1600.0
open(sys.argv[1] + "/elo_ratings.jsonl", "w").write("".join(json.dumps(r) + "\\n" for r in rs))
print(json.dumps(rs[0]["scope"]))`,
        g,
      ),
    );
    expect(failing(value)).toEqual([C.refit]);
    const used = variant("refit-used", (g) =>
      edit(g, "elo_judgments", (r) => (r.status !== "ok" ? { ...r, used_in_ratings: true } : r)),
    );
    expect(failing(used)).toEqual([C.refit]);
  });

  // MUTATION: in gpt62_sol.refit, weigh every judge's games once (drop the lcm repetition) — this fails
  it("recomputes the Elo gaps per judge and pooled with each judge weighted the same", () => {
    const got = checks(BASE).find((c) => c.check.endsWith(C.elo))!;
    expect(got.got).toEqual(ELO);
    // the pooled overall gap is not the plain mix of the 25 games: GPT counts twice
    const plain = py(
      `sys.path.insert(0, ${JSON.stringify(join(AACR, "elo"))})
import elo_rating as R, gpt62_sol as G
S = {"N": 1.0, "O": 0.0, "t": 0.5}
g = [(p, "s62", "final1", S[w]) for w, p in zip("NNOtNNOONN" + "OOONONONOOOOOOO", ["p1", "p2", "p3", "p4", "p5"] * 2 + ["p1", "p2", "p3", "p4"] * 3 + ["p1", "p2", "p3"])]
print(json.dumps(G._i(G._signed(R.table(["s62", "final1"], g, reps=G.REPS))[0])))`,
    ) as number;
    expect(ELO.combined!.overall![0]).not.toBe(plain);
    // a judgment's winner moved: the Elo group no longer matches POST (after the refit tables follow it)
    const moved = variant("elo-moved", (g) => {
      edit(g, "elo_judgments", (r) =>
        r.judgment_file === "gpt" && r.pr === "p3"
          ? { ...r, overall_winner: r.a === N ? "A" : "B" }
          : r,
      );
      writeRefit(g);
    });
    // GPT's p3 winner flips in both orders: position and order stay, agreement with DeepSeek moves
    expect(failing(moved)).toEqual([C.elo, C.agreement]);
  });

  // MUTATION: in gpt62_sol.numbers_of, count only "incorrect" as not correct — this fails
  it("recomputes the answer key, the comments and the cost from the folder and the dataset's final1 rows", () => {
    const bad = variant("comments", (g) =>
      edit(g, "comment_verdicts", (r) =>
        r.comment_id === "C2" ? { ...r, grade: "correct-minor" } : r,
      ),
    );
    expect(failing(bad)).toEqual([C.comments]);
    // final1's numbers are the dataset's: another arm's rows there are not read
    const other = variant("other-arm", (g) =>
      jsonl(join(dirname(g), "data"), "defect_verdicts", [
        ...rows(join(dirname(g), "data"), "defect_verdicts"),
        { arm_id: "other", instance_id: "p3", defect_id: "D1", verdict: "found", credit: 1 },
      ]),
    );
    expect(failing(other)).toEqual([]);
    const cost = variant("cost", (g) =>
      edit(g, "cases", (r) => (r.instance_id === "p5" ? { ...r, usd: 10 } : r)),
    );
    expect(failing(cost)).toEqual([C.cost]);
  });
});

describe("gpt62_sol: the claims verifier", () => {
  // MUTATION: in claim_metrics.Gpt62Sol, return None for a name numbers() does not give — this fails
  // MUTATION: in claim_metrics.Gpt62Sol, compute numbers() without the isdir test — this fails
  it("gives the comparison's numbers by name, and refuses an unknown name or a missing folder", () => {
    const got = py(
      `import claim_metrics as M
out = {}
for root in sys.argv[1:]:
    p = M.PROVIDERS["gpt62_sol"](M.Tables(root + "/data"))
    r = {}
    for k in ("key.s62.all", "comments.final1.on_key", "elo.deepseek.prs_never", "nope"):
        try:
            r[k] = p.value(k)
        except M.KeyError_ as e:
            r[k] = "KeyError: " + str(e)
    out[root.rsplit("/", 1)[1]] = r
print(json.dumps(out))`,
      BASE,
      variant("claims-gone", (g) => rmSync(g, { recursive: true })),
    ) as Record<string, Record<string, unknown>>;
    expect(got.base).toEqual({
      "key.s62.all": 3.5,
      "comments.final1.on_key": 3,
      "elo.deepseek.prs_never": 1,
      nope: "KeyError: unknown gpt62_sol number 'nope'",
    });
    expect(got["claims-gone"]!["key.s62.all"]).toBe("KeyError: no gpt62_sol/ beside the tables");
  });

  // MUTATION: in verify_claims.discover, never set found["gpt62_sol"] — this fails
  // MUTATION: in verify_claims.consistency, give the gpt62_sol checks needs [] — this fails
  it("finds the folder beside the tables, and its release checks need it", () => {
    const root = variant("consistency-data", (g) =>
      jsonl(join(dirname(g), "data"), "prs", [{ instance_id: "p1" }]),
    );
    const got = py(
      `import verify_claims as V
a = types.SimpleNamespace(work=sys.argv[2], martian=None, qodo_gt=None, no_validation=True)
found = V.discover([sys.argv[1]])
src = V.Sources(a, {"checks": {}}, found)
a.no_validation = False
import hf_export as H
H.CONFIGS[:] = []
H.validate = lambda t: []
H.validate_release = lambda *x: []
print(json.dumps([found["gpt62_sol"], [[c["needs"], c["ok"]] for c in V.consistency(a, found, src) if c["needs"] == ["gpt62_sol"]]]))`,
      root,
      join(tmp, "consistency"),
    ) as [string, [string[], boolean][]];
    expect(got[0]).toBe(join(root, "gpt62_sol"));
    // the fixture is not the committed manifest's, and its numbers are not the release's (POST): the
    // manifest check and the ten number checks fail, the columns, the rows, the README and the refit pass
    expect(got[1].map(([, ok]) => ok)).toEqual([
      false,
      true,
      true,
      true,
      true,
      ...Array(10).fill(false),
    ]);
  });

  it("lints a claims manifest whose check needs gpt62_sol", () => {
    const lint = spawnSync("python3", ["-I", join(AACR, "verify_claims.py"), "--lint"], {
      encoding: "utf8",
    });
    expect(lint.stderr).not.toMatch(/needs \[.gpt62_sol.\] is not a part of the release/);
    expect(lint.stdout).toMatch(
      /bench\/aacr\/hf\/card.md: \d+ number tokens, \d+ claims, \d+ not-claims, 0 unaccounted/,
    );
    expect(lint.status).toBe(0);
  });
});

describe("gpt62_sol: the export and the card", () => {
  // MUTATION: in hf_export.leak_scan, drop GS.file_rows — this fails
  it("leak-scans the folder's tables as it scans the configs", () => {
    const dir = variant("leak", (g) =>
      edit(g, "elo_judgments", (r) => ({ ...r, overall_explanation: "ask Jordan" })),
    );
    const n = py(
      `import hf_export as h\nh.CONFIGS[:] = []\nprint(json.dumps(sum(v for k, v in h.leak_scan(sys.argv[1]).items() if k.startswith("gpt62_sol/elo_judgments.jsonl"))))`,
      dir,
    ) as number;
    expect(n).toBeGreaterThan(0);
  });

  // MUTATION: in hf_export.cited, drop "gpt62_sol" from the folders whose keys link nothing — this fails
  it("a gpt62_sol key links no arm and no run, whatever its name", () => {
    const got = py(
      `import hf_export as h
claims = [{"group": "g", "q": "gpt62_sol:prs"}, {"group": "g2", "q": "{gpt62_sol:prs} + {gpt62_sol:key.s62.all}"}]
print(json.dumps([{k: sorted(v) for k, v in d.items()} for d in h.claim_links(claims, [{"arm_id": "prs", "runs": ["prs"]}], [{"unit": "prs"}], set(), {})]))`,
    ) as [Record<string, string[]>, Record<string, string[]>];
    expect(got).toEqual([{}, {}]);
  });

  // MUTATION: in hf_export.card_values, render GPT62_SOL_MD from nothing (gpt62_sol_link([], url)) — this fails
  // MUTATION: in hf_export.card_values, render GPT62_SOL_FILES from nothing (always the pending marker) — this fails
  it("links the folder where the card lists the dataset's parts and in its own section, and lists its tables", () => {
    const card = py(
      `import hf_export as h, gpt62_sol as G
a = types.SimpleNamespace(repo_id="acme/bench")
v = lambda gs: h.fill_card(open(sys.argv[2]).read(), h.card_values(a, {n: 1 for n in h.CONFIGS}, [{"ok": True}],
                                                                   collections.Counter(), [], None, None, None, gs))
print(json.dumps([v(G.file_rows(sys.argv[1])), v([])]))`,
      BASE,
      join(AACR, "hf", "card.md"),
    ) as [string, string];
    const link = "[`gpt62_sol/`](https://huggingface.co/datasets/acme/bench/tree/main/gpt62_sol)";
    expect(card[0]).toContain(
      `("State-machine study"), and ${link} holds QuickReview on GPT-6.2 Sol`,
    );
    expect(card[0]).toContain(`## GPT-6.2 Sol comparison\n\n${link} holds a comparison`);
    expect(card[0]).toContain("| File | Rows |\n|---|---:|\n| `gpt62_sol/arms.jsonl` | 2 |");
    expect(card[0]).toContain("| `gpt62_sol/elo_judgments.jsonl` | 30 |");
    expect(card[1]).toContain("and `<gpt62_sol/ not in this build>` holds QuickReview");
    expect(card[1]).not.toContain("tree/main/gpt62_sol");
  });

  // MUTATION: in hf_export.verify_result, count the gpt62_sol checks with the slim bundle's (gs = 0) — this fails
  it("counts the comparison's checks with validation.json's, apart from the tables alone", () => {
    const report = join(tmp, "vc.json");
    const check = (needs: string[]) => ({ ok: true, needs });
    writeFileSync(
      report,
      JSON.stringify({
        results: [{ status: "pass" }],
        consistency: [
          ...Array(3).fill(check([])),
          ...Array(2).fill(check(["second_judges"])),
          ...Array(4).fill(check(["state_machines"])),
          ...Array(5).fill(check(["gpt62_sol"])),
          check(["slim"]),
        ],
      }),
    );
    expect(
      py(`import hf_export as h\nprint(json.dumps(h.verify_result(sys.argv[1])))`, report),
    ).toContain(
      "The release's own checks pass 15 of 15: 14 from `validation.json`, re-run on the dataset (3 on the " +
        "tables, 2 on its `second_judges/` folder, 4 on its `state_machines/` folder and 5 on its " +
        "`gpt62_sol/` folder), and 1 the slim bundle's.",
    );
  });
});

describe("gpt62_sol: the build", () => {
  // MUTATION: in gpt62_sol._attempts, return the current file alone (drop the set-aside rows) — this fails
  // MUTATION: in gpt62_sol._attempts, accept an ok row that was moved out — this fails
  it("puts the set-aside first attempts back in the order they were made, and refuses a moved-out ok row", () => {
    const d = join(tmp, "attempts");
    const j = join(d, "judgments");
    mkdirSync(j, { recursive: true });
    const r = (id: string, status: string, at: string) => ({ id, status, at });
    const first = [
      r("u1", "error", "1"),
      r("u1", "ok", "2"),
      r("u2", "error", "3"),
      r("u3", "ok", "4"),
    ];
    const kept = [first[1]!, first[3]!];
    const later = [r("u2", "ok", "5")];
    const write = (name: string, rs: Row[]) =>
      writeFileSync(join(j, name), rs.map((x) => JSON.stringify(x)).join("\n") + "\n");
    write("deepseek.jsonl", [...kept, ...later]);
    write("deepseek.jsonl.pass1-with-errors.bak", first);
    write("gpt.jsonl", kept);
    const attempts = (judge: string) =>
      py(
        `import gpt62_sol as G
try:
    print(json.dumps([[r["at"], aside] for r, aside in G._attempts(sys.argv[1], sys.argv[2])]))
except SystemExit as e:
    print(json.dumps(str(e)))`,
        d,
        judge,
      );
    expect(attempts("deepseek")).toEqual([
      ["1", true],
      ["2", false],
      ["3", true],
      ["4", false],
      ["5", false],
    ]);
    expect(attempts("gpt")).toEqual([
      ["2", false],
      ["4", false],
    ]);
    write("deepseek.jsonl", [first[3]!, ...later]);
    expect(attempts("deepseek")).toMatch(/an ok judgment was moved out/);
  });

  // MUTATION: in gpt62_sol.PLAN_KEYS, add "git_root" — this fails
  // MUTATION: in gpt62_sol.JUDGE_KEYS, add "env_file" — this fails
  it("keeps a plan's design and drops where it ran", () => {
    const keys = py(
      "import gpt62_sol as G\nprint(json.dumps([list(G.PLAN_KEYS), list(G.JUDGE_KEYS)]))",
    ) as [string[], string[]];
    for (const k of ["git_root", "url", "env_file", "runs_dir", "prs"]) {
      expect(keys[0]).not.toContain(k);
      expect(keys[1]).not.toContain(k);
    }
    expect(keys[1]).toEqual(["model", "effort", "max_tokens", "timeout_s"]);
  });

  it("refuses an --out that exists or is not the folder itself, before reading anything", () => {
    const run = (out: string) =>
      py(
        `import gpt62_sol as G
a = types.SimpleNamespace(out=sys.argv[1], runs_dir="/nonexistent", elo_dir="/nonexistent", data="/nonexistent", repo="/nonexistent")
try:
    G.build(a); print(json.dumps("built"))
except SystemExit as e:
    print(json.dumps(str(e)))`,
        out,
      ) as string;
    expect(run(join(BASE, "gpt62_sol"))).toMatch(/exists: give a new folder/);
    expect(run(join(tmp, "elsewhere"))).toMatch(/the `gpt62_sol` folder itself/);
  });
});

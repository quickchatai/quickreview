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

/*
 * Martian and Qodo, on two pull requests each. Martian's goldens: m1 g0 bug High real, m1 g1 style Low notreal,
 * m2 g0 doc_defect Medium real, m2 g1 perf Low disputed. s62 matches m1/g0 and m2/g1 with 3 + 2 false positives;
 * final1 m1/g0, m1/g1 and m2/g0 with 1 + 1. A re-judged comparator, `rejudged-x`, is in both scorings: m1/g0 with
 * 1 + 0 false positives in s62's, m1/g0 and m2/g0 with 2 + 1 in final1's. Qodo's issues: q1 i0 functional
 * (a.py 10-12), q1 i1 rule (b.py 5), q2 i0 functional (c.py 1-3), q2 i1 rule (d.py 20). s62 matches q1/i0 within
 * 5 lines, q1/i1 in the same file only, q2/i0 in another file; final1 matches all four within 5 lines, its two
 * rule violations from a P3 `[nit]` and a nit-footed `[nit]`.
 */
const M1 = "https://example.test/m/1";
const M2 = "https://example.test/m/2";
const Q1 = "https://example.test/q/1";
const Q2 = "https://example.test/q/2";
const MW = (arm: string): string => `${arm}-martian50`;
const QW = (arm: string): string => `${arm}-qodo-pr100`;
const TOOL = (arm: string): string => (arm === N ? N : "quickreview-frozen");
const JUDGE = "gpt-6.1-sol";
const foot = (sev: string, lens: string) => `\n\n_${sev} · confidence 0.9 · lens ${lens}_`;

const MQ_CASES: Row[] = [
  [M1, "martian50", 2, 10, 3, { rate_limited: 3, overloaded: 0, usage_limit: 0, other: 3 }, "ok"],
  [M2, "martian50", 4, 30, 1, null, "ok"],
  [Q1, "qodo-pr100", 2, 6, 2, { rate_limited: 0, overloaded: 0, usage_limit: 0, other: 0 }, "ok"],
  [
    Q2,
    "qodo-pr100",
    4,
    8,
    1,
    { rate_limited: 2, overloaded: 0, usage_limit: 0, other: 1 },
    "error",
  ],
].map(([url, set, usd, minutes, posted, errors, status], i) => ({
  arm_id: N,
  instance_id: `mq${i}`,
  set,
  run: `${N}-${set as string}`,
  pr_url: url,
  status,
  verdict: "COMMENT",
  usd,
  minutes,
  n_posted: posted,
  model_errors: errors,
  judged: true,
  judge_input_tokens: null,
  judge_output_tokens: null,
  judge_cache_read_tokens: null,
}));

type Inline = { path: string | null; line: number | null; body: string };
/** One martian_reviews row: QuickReview's (comments, the rest beyond the page) or a re-judged one (link only). */
function martianReview(
  arm: string,
  tool: string,
  url: string,
  fp: number,
  extracted: number,
  own?: { comments: Inline[]; beyond: Inline[]; posted: number; usd: number; minutes: number },
): Row {
  return {
    tool,
    pr_url: url,
    work_dir: MW(arm),
    vendor_link_only: !own,
    source_url: own ? null : `${url}#vendor`,
    comments: own ? own.comments : [],
    n_comments: own ? own.comments.length : 0,
    n_posted_inline: own ? own.posted : null,
    comments_beyond_first_page: own ? own.beyond : [],
    extracted_candidates: extracted,
    unmatched_candidates: own ? Array.from({ length: fp }, (_, k) => `u${k}`) : null,
    tp: 0,
    fp,
    fn: 0,
    skipped: false,
    cost_usd: own ? own.usd : null,
    minutes: own ? own.minutes : null,
    judge: JUDGE,
    run_family: arm === O ? "martian-final" : null,
  };
}

const GOLDENS: [string, number, string, string, string][] = [
  [M1, 0, "High", "bug", "real"],
  [M1, 1, "Low", "style", "notreal"],
  [M2, 0, "Medium", "doc_defect", "real"],
  [M2, 1, "Low", "perf", "disputed"],
];

function martianVerdicts(arm: string, tool: string, hits: string[]): Row[] {
  return GOLDENS.map(([url, i]) => ({
    tool,
    pr_url: url,
    judge: JUDGE,
    golden_index: i,
    matched: hits.includes(`${url}#${i}`),
    confidence: hits.includes(`${url}#${i}`) ? 0.9 : null,
    matched_candidate: null,
    reasoning: null,
    work_dir: MW(arm),
    run_family: arm === O ? "martian-final" : null,
  }));
}

/** A martian_scores row with Martian's rates (fractions) of its counts. */
function martianScore(arm: string, tool: string, c: Record<string, [number, number, number]>): Row {
  const row: Row = {
    tool,
    judge: JUDGE,
    work_dir: MW(arm),
    run_family: arm === O ? "martian-final" : null,
  };
  for (const p of ["strict", "core", "all"]) {
    const [tp, fp, fn] = c[p]!;
    const pr = tp + fp ? tp / (tp + fp) : 0;
    const rc = tp + fn ? tp / (tp + fn) : 0;
    Object.assign(row, {
      [`${p}_precision`]: pr,
      [`${p}_recall`]: rc,
      [`${p}_f1`]: pr + rc ? (2 * pr * rc) / (pr + rc) : 0,
      [`${p}_f2`]: pr + rc ? (5 * pr * rc) / (4 * pr + rc) : 0,
      [`${p}_tp`]: tp,
      [`${p}_fp`]: fp,
      [`${p}_fn`]: fn,
    });
  }
  return row;
}

type QComment = {
  index: number;
  path: string | null;
  start: number | null;
  end: number | null;
  body: string;
};
function qodoReview(
  arm: string,
  url: string,
  comments: QComment[],
  usd: number,
  minutes: number,
): Row {
  return {
    tool: TOOL(arm),
    pr_url: url,
    work_dir: QW(arm),
    vendor_link_only: false,
    source_url: null,
    comments,
    n_comments: comments.length,
    cost_usd: usd,
    minutes,
    judge: JUDGE,
    run_family: arm === O ? "qodo-final" : null,
  };
}

/** One qodo_verdicts row per issue: [url, issue, comment matched or null, located_n5, located_same_file]. */
function qodoVerdicts(arm: string, vs: [string, number, number | null, boolean, boolean][]): Row[] {
  return vs.map(([url, i, c, n5, same]) => ({
    tool: TOOL(arm),
    pr_url: url,
    work_dir: QW(arm),
    judge: JUDGE,
    issue_index: i,
    matched: c !== null,
    comment_index: c,
    located_n5: n5,
    located_same_file: same,
    why: c !== null ? "same defect" : null,
    run_family: arm === O ? "qodo-final" : null,
  }));
}

function mqTables(data: string, g: string): void {
  jsonl(
    data,
    "martian_goldens",
    GOLDENS.map(([url, i, severity, category, audit_bucket]) => ({
      pr_url: url,
      golden_index: i,
      comment: `golden ${url} ${i}`,
      severity,
      category,
      audit_bucket,
    })),
  );
  jsonl(
    data,
    "qodo_issues",
    [
      [Q1, 0, "a.py", 10, 12, null],
      [Q1, 1, "b.py", 5, 5, "R1"],
      [Q2, 0, "c.py", 1, 3, null],
      [Q2, 1, "d.py", 20, 20, "R2"],
    ].map(([url, i, file_path, start_line, end_line, rule_name]) => ({
      pr_url: url,
      issue_index: i,
      file_path,
      start_line,
      end_line,
      rule_name,
      functional: rule_name === null,
    })),
  );
  // s62's Martian scoring: m1 has three inline comments (two on Martian's page, one beyond it in this small
  // fixture's terms) and its review body; m2 one inline comment and its body
  const s62Reviews = [
    martianReview(N, N, M1, 3, 4, {
      comments: [
        { path: "a.c", line: 1, body: "[blocker] x" + foot("P1", "pass-baseline") },
        { path: "a.c", line: 2, body: "[question] y" },
        { path: null, line: null, body: "review body" },
      ],
      beyond: [{ path: "a.c", line: 3, body: "[question] z" }],
      posted: 3,
      usd: 2,
      minutes: 10,
    }),
    martianReview(N, N, M2, 2, 3, {
      comments: [
        { path: "a.c", line: 1, body: "[blocker] w" },
        { path: null, line: null, body: "review body" },
      ],
      beyond: [],
      posted: 1,
      usd: 4,
      minutes: 30,
    }),
    martianReview(N, "rejudged-x", M1, 1, 2),
    martianReview(N, "rejudged-x", M2, 0, 1),
  ];
  jsonl(g, "martian_reviews", s62Reviews);
  jsonl(g, "martian_verdicts", [
    ...martianVerdicts(N, N, [`${M1}#0`, `${M2}#1`]),
    ...martianVerdicts(N, "rejudged-x", [`${M1}#0`]),
  ]);
  jsonl(g, "martian_scores", [
    martianScore(N, N, { core: [2, 5, 1], strict: [1, 5, 0], all: [2, 5, 2] }),
    martianScore(N, "rejudged-x", { core: [1, 1, 2], strict: [1, 1, 0], all: [1, 1, 3] }),
  ]);
  jsonl(data, "martian_reviews", [
    martianReview(O, TOOL(O), M1, 1, 2, {
      comments: [
        { path: "a.c", line: 1, body: "[nit] n1" },
        { path: null, line: null, body: "review body" },
      ],
      beyond: [],
      posted: 1,
      usd: 1,
      minutes: 20,
    }),
    martianReview(O, TOOL(O), M2, 1, 2, {
      comments: [
        { path: "a.c", line: 1, body: "[blocker] b1" },
        { path: "a.c", line: 2, body: "[nit] n2" },
        { path: null, line: null, body: "review body" },
      ],
      beyond: [],
      posted: 2,
      usd: 3,
      minutes: 40,
    }),
    martianReview(O, "rejudged-x", M1, 2, 2),
    martianReview(O, "rejudged-x", M2, 1, 2),
    // another scoring's row: not final1's, never read
    { ...martianReview(O, "quickreview", M1, 9, 9), work_dir: "other-martian50" },
  ]);
  jsonl(data, "martian_verdicts", [
    ...martianVerdicts(O, TOOL(O), [`${M1}#0`, `${M1}#1`, `${M2}#0`]),
    ...martianVerdicts(O, "rejudged-x", [`${M1}#0`, `${M2}#0`]),
  ]);
  jsonl(data, "martian_scores", [
    martianScore(O, TOOL(O), { core: [2, 2, 1], strict: [1, 2, 0], all: [3, 2, 1] }),
    martianScore(O, "rejudged-x", { core: [2, 3, 1], strict: [1, 3, 0], all: [2, 3, 2] }),
  ]);
  jsonl(g, "qodo_reviews", [
    qodoReview(
      N,
      Q1,
      [
        {
          index: 0,
          path: "a.py",
          start: 11,
          end: 11,
          body: "[blocker] f1" + foot("P1", "pass-baseline"),
        },
        {
          index: 1,
          path: "b.py",
          start: 50,
          end: 50,
          body: "[question] r1" + foot("P2", "pass-style"),
        },
      ],
      2,
      6,
    ),
    qodoReview(
      N,
      Q2,
      [
        {
          index: 0,
          path: "x.py",
          start: 1,
          end: 1,
          body: "[blocker] f2" + foot("P2", "pass-sweep"),
        },
        // a finding posted in the review body: no footer
        { index: 1, path: null, start: null, end: null, body: "[question] in the body" },
      ],
      4,
      8,
    ),
  ]);
  jsonl(
    g,
    "qodo_verdicts",
    qodoVerdicts(N, [
      [Q1, 0, 0, true, true],
      [Q1, 1, 1, false, true],
      [Q2, 0, 0, false, false],
      [Q2, 1, null, false, false],
    ]),
  );
  jsonl(data, "qodo_reviews", [
    qodoReview(
      O,
      Q1,
      [
        {
          index: 0,
          path: "a.py",
          start: 10,
          end: 10,
          body: "[blocker] g1" + foot("P1", "pass-baseline"),
        },
        { index: 1, path: "b.py", start: 5, end: 5, body: "[nit] g2" + foot("P3", "pass-style") },
      ],
      1,
      10,
    ),
    qodoReview(
      O,
      Q2,
      [
        { index: 0, path: "d.py", start: 20, end: 21, body: "[nit] g3" + foot("nit", "pass-lint") },
        {
          index: 1,
          path: "c.py",
          start: 2,
          end: 2,
          body: "[question] g4" + foot("P2", "pass-baseline"),
        },
        { index: 2, path: null, start: null, end: null, body: "[nit] in the body" },
      ],
      3,
      20,
    ),
  ]);
  jsonl(
    data,
    "qodo_verdicts",
    qodoVerdicts(O, [
      [Q1, 0, 0, true, true],
      [Q1, 1, 1, true, true],
      [Q2, 0, 1, true, true],
      [Q2, 1, 0, true, true],
    ]),
  );
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
      pi_source: "pi rebuilt from its unreleased main at c0ffee; it reports itself as 1",
      engine: "runtime=sdk, lens_runtime=engine, wave=true",
      reviewer_model: "m2",
      judge: "gpt-6.1-sol-high",
      runs: [`${N}-x`],
      prs: 5,
      martian_run: `${N}-martian50`,
      qodo_run: `${N}-qodo-pr100`,
      mq_judge: "gpt-6.1-sol at reasoning effort low",
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
      pi: "0",
      pi_source: null,
      engine: null,
      reviewer_model: "m1",
      judge: "gpt-6-sol-high",
      runs: [`${O}-x`],
      prs: 5,
      martian_run: `${O}-martian50`,
      qodo_run: `${O}-qodo-pr100`,
      mq_judge: "gpt-6.1-sol at reasoning effort low",
      note: "o",
    },
  ]);
  jsonl(g, "cases", [
    ...PRS.map((p, i) => ({
      arm_id: N,
      instance_id: p,
      set: "rest145",
      run: `${N}-rest145`,
      pr_url: null,
      status: "ok",
      verdict: "COMMENT",
      usd: i + 1,
      minutes: 10 * (i + 1),
      n_posted: p === "p1" ? 2 : 1,
      model_errors: null,
      judged: true,
      judge_input_tokens: 1,
      judge_output_tokens: 1,
      judge_cache_read_tokens: 0,
    })),
    ...MQ_CASES,
  ]);
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
  mqTables(data, g);
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
  // Martian, by hand from the fixture (mqTables): Core leaves out the style golden, Strict also the doc_defect
  // and perf ones; s62 2 found + 5 false positives, final1 2 + 2 on Core
  martian: {
    [N]: {
      prs: 2,
      core: { precision: 28.6, recall: 66.7, f1: 40.0, f2: 52.6, tp: 2, golden: 3, fp: 5, fn: 1 },
      strict: {
        precision: 16.7,
        recall: 100.0,
        f1: 28.6,
        f2: 50.0,
        tp: 1,
        golden: 1,
        fp: 5,
        fn: 0,
      },
      all: { precision: 28.6, recall: 50.0, f1: 36.4, f2: 43.5, tp: 2, golden: 4, fp: 5, fn: 2 },
    },
    [O]: {
      prs: 2,
      core: { precision: 50.0, recall: 66.7, f1: 57.1, f2: 62.5, tp: 2, golden: 3, fp: 2, fn: 1 },
      strict: {
        precision: 33.3,
        recall: 100.0,
        f1: 50.0,
        f2: 71.4,
        tp: 1,
        golden: 1,
        fp: 2,
        fn: 0,
      },
      all: { precision: 60.0, recall: 75.0, f1: 66.7, f2: 71.4, tp: 3, golden: 4, fp: 2, fn: 1 },
    },
    delta: {
      core: { precision: -21.4, recall: 0, f1: -17.1, f2: -9.9, tp: 0, fp: 3 },
      strict: { precision: -16.6, recall: 0, f1: -21.4, f2: -21.4, tp: 0, fp: 3 },
      all: { precision: -31.4, recall: -25.0, f1: -30.3, f2: -27.9, tp: -1, fp: 3 },
    },
  },
  martian_goldens: {
    goldens: {
      "category.bug": 1,
      "category.doc_defect": 1,
      "category.perf": 1,
      "category.style": 1,
      "severity.High": 1,
      "severity.Low": 2,
      "severity.Medium": 1,
      "audit.disputed": 1,
      "audit.notreal": 1,
      "audit.real": 2,
      total: 4,
    },
    [N]: {
      "category.bug": 1,
      "category.doc_defect": 0,
      "category.perf": 1,
      "category.style": 0,
      "severity.High": 1,
      "severity.Low": 1,
      "severity.Medium": 0,
      "audit.disputed": 1,
      "audit.notreal": 0,
      "audit.real": 1,
    },
    [O]: {
      "category.bug": 1,
      "category.doc_defect": 1,
      "category.perf": 0,
      "category.style": 1,
      "severity.High": 1,
      "severity.Low": 1,
      "severity.Medium": 1,
      "audit.disputed": 0,
      "audit.notreal": 1,
      "audit.real": 2,
    },
    paired: {
      ...paired("category.bug", 1, 1, 0, 0, 0),
      ...paired("category.doc_defect", 1, 0, 0, 1, 0),
      ...paired("category.perf", 1, 0, 1, 0, 0),
      ...paired("category.style", 1, 0, 0, 1, 0),
      ...paired("category.total", 4, 1, 1, 2, 0),
      ...paired("audit.disputed", 1, 0, 1, 0, 0),
      ...paired("audit.notreal", 1, 0, 0, 1, 0),
      ...paired("audit.real", 2, 1, 0, 1, 0),
      ...paired("audit.total", 4, 1, 1, 2, 0),
    },
  },
  martian_comments: {
    [N]: {
      "posted.total": 4,
      "posted.mean": 2,
      "posted.median": 2,
      "ingested.total": 3,
      "ingested.mean": 1.5,
      "ingested.median": 1.5,
      "extracted.total": 7,
      "extracted.mean": 3.5,
      "extracted.median": 3.5,
      dropped: 1,
      prs_over_page: 1,
      prs_with_body: 2,
      listed_match_posted: 1,
      "tag.blocker": 2,
      "tag.question": 2,
    },
    [O]: {
      "posted.total": 3,
      "posted.mean": 1.5,
      "posted.median": 1.5,
      "ingested.total": 3,
      "ingested.mean": 1.5,
      "ingested.median": 1.5,
      "extracted.total": 4,
      "extracted.mean": 2,
      "extracted.median": 2,
      dropped: 0,
      prs_over_page: 0,
      prs_with_body: 2,
      listed_match_posted: 1,
      "tag.nit": 2,
      "tag.blocker": 1,
    },
  },
  martian_rejudged: {
    [N]: { "rejudged-x.tp": 1, "rejudged-x.fp": 1, "rejudged-x.fn": 2 },
    [O]: { "rejudged-x.tp": 2, "rejudged-x.fp": 3, "rejudged-x.fn": 1 },
    max_core_move: 2,
  },
  // Qodo: s62 1 / 2 / 3 matches under N=5 / same file / semantic only on 4 comments, final1 4 on 5 throughout
  qodo: {
    issues: { total: 4, functional: 2, rule: 2, prs: 2 },
    [N]: {
      prs: 2,
      n5: qodo(4, 2, 25.0, 25.0, 25.0, 50.0, 0.0, 1, 1, 0),
      same_file: qodo(4, 2, 50.0, 50.0, 50.0, 50.0, 50.0, 2, 1, 1),
      semantic: qodo(4, 2, 75.0, 75.0, 75.0, 100.0, 50.0, 3, 2, 1),
    },
    [O]: {
      prs: 2,
      n5: qodo(5, 2.5, 80.0, 100.0, 88.9, 100.0, 100.0, 4, 2, 2),
      same_file: qodo(5, 2.5, 80.0, 100.0, 88.9, 100.0, 100.0, 4, 2, 2),
      semantic: qodo(5, 2.5, 80.0, 100.0, 88.9, 100.0, 100.0, 4, 2, 2),
    },
    delta: {
      n5: qodoDelta(-55.0, -75.0, -63.9, -50.0, -100.0, -3, -1, -2),
      same_file: qodoDelta(-30.0, -50.0, -38.9, -50.0, -50.0, -2, -1, -1),
      semantic: qodoDelta(-5.0, -25.0, -13.9, 0.0, -50.0, -1, 0, -1),
    },
  },
  qodo_comments: {
    [N]: {
      listed: 4,
      prs_without: 0,
      "tag.blocker": 2,
      "tag.question": 2,
      "severity.P1": 1,
      "severity.P2": 2,
      "severity.none": 1,
    },
    [O]: {
      listed: 5,
      prs_without: 0,
      "tag.blocker": 1,
      "tag.nit": 3,
      "tag.question": 1,
      "severity.P1": 1,
      "severity.P3": 1,
      "severity.nit": 1,
      "severity.P2": 1,
      "severity.none": 1,
    },
    [`${N}_n5_hits`]: {
      "functional.tag.blocker": 1,
      "functional.severity.P1": 1,
      "functional.lens.pass-baseline": 1,
    },
    [`${O}_n5_hits`]: {
      "functional.tag.blocker": 1,
      "functional.tag.question": 1,
      "functional.severity.P1": 1,
      "functional.severity.P2": 1,
      "functional.lens.pass-baseline": 2,
      "rule.tag.nit": 2,
      "rule.severity.P3": 1,
      "rule.severity.nit": 1,
      "rule.lens.pass-style": 1,
      "rule.lens.pass-lint": 1,
    },
    paired: {
      ...paired("n5.functional", 2, 1, 0, 1, 0),
      ...paired("n5.rule", 2, 0, 0, 2, 0),
      ...paired("n5.total", 4, 1, 0, 3, 0),
      ...paired("semantic.functional", 2, 2, 0, 0, 0),
      ...paired("semantic.rule", 2, 1, 0, 1, 0),
      ...paired("semantic.total", 4, 3, 0, 1, 0),
    },
    drop: {
      old_rule_hits_nit_tag: 2,
      old_rule_hits_quiet: 2,
      old_functional_hits_quiet: 0,
      old_rule_hits_p0_p2: 0,
      old_rule_hits_no_footer: 0,
      new_rule_hits_p0_p2: 0,
      new_rule_hits_no_footer: 0,
      [`${N}_nits`]: 0,
      [`${O}_nits`]: 3,
    },
  },
  mq_cost: {
    ...cost("martian", N, 2, 6, 3, 3, 20, 20),
    ...cost("martian", O, 2, 4, 2, 2, 30, 30),
    ...cost("qodo", N, 2, 6, 3, 3, 7, 7),
    ...cost("qodo", O, 2, 4, 2, 2, 15, 15),
    [`martian50.${N}.ok`]: 2,
    [`martian50.${N}.rate_limited`]: 3,
    [`qodo-pr100.${N}.ok`]: 1,
    [`qodo-pr100.${N}.rate_limited`]: 2,
  },
};

function paired(
  k: string,
  items: number,
  both: number,
  n: number,
  o: number,
  neither: number,
): Row {
  return {
    [`${k}.items`]: items,
    [`${k}.both`]: both,
    [`${k}.${N}_only`]: n,
    [`${k}.${O}_only`]: o,
    [`${k}.neither`]: neither,
  };
}

function qodo(
  comments: number,
  per_pr: number,
  precision: number,
  recall: number,
  f1: number,
  recall_functional: number,
  recall_rule: number,
  hits: number,
  hits_functional: number,
  hits_rule: number,
): Row {
  return {
    comments,
    per_pr,
    precision,
    recall,
    f1,
    recall_functional,
    recall_rule,
    hits,
    hits_functional,
    hits_rule,
  };
}

/** s62 minus final1, of the rounded numbers; comments per PR 2 against 2.5 throughout. */
function qodoDelta(
  precision: number,
  recall: number,
  f1: number,
  recall_functional: number,
  recall_rule: number,
  hits: number,
  hits_functional: number,
  hits_rule: number,
): Row {
  return {
    per_pr: -0.5,
    precision,
    recall,
    f1,
    recall_functional,
    recall_rule,
    hits,
    hits_functional,
    hits_rule,
  };
}

function cost(
  b: string,
  arm: string,
  reviews: number,
  total: number,
  perPr: number,
  median: number,
  minMedian: number,
  minMean: number,
): Row {
  const k = `${b}.${arm}`;
  return {
    [`${k}.reviews`]: reviews,
    [`${k}.usd_total`]: total,
    [`${k}.usd_per_pr`]: perPr,
    [`${k}.usd_median`]: median,
    [`${k}.minutes_median`]: minMedian,
    [`${k}.minutes_mean`]: minMean,
  };
}

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
  columns:
    "every table has exactly its listed columns, and the Martian and Qodo tables those of the dataset's tables of the same names",
  whole:
    "the rows are whole: s62 reviewed and was judged on final1's pull requests in the dataset (arm quickreview-frozen), one verdict on every answer-key defect at its key version, every judged comment a posted one (inline or in the review body), and every Elo judgment of a unit of its plan between s62 and final1, in its file's order; s62's Martian and Qodo scorings are of final1's pull requests there, one verdict on every golden or issue, Martian scores that recount, Qodo matches one to one and located as qodo_judge.located gives, and one case per review with its cost",
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
  martian:
    "Martian's scores of each setup per profile (Core, Strict, All), recounted from the verdicts and the reviews' false positives (martian_scores.counts), and their difference",
  martian_goldens:
    "the goldens each setup found by Martian's category and severity and by the audit bucket, and the goldens found by both setups, one or neither",
  martian_comments:
    "each setup's inline comments posted, the first page Martian read of them, its extracted candidates and the comments' tags",
  martian_rejudged:
    "the re-judged comparators' Core counts in each Martian scoring, and the most one moved",
  qodo: "Qodo's issues, and each setup's comments, precision, recall, F1 and recall by issue kind under each location rule (claim_metrics.Qodo), and their difference",
  qodo_comments:
    "the judged comments' tags and footer severities and those of the N=5 hits, the issues found by both setups, one or neither, and the rule-violation drop",
  mq_cost:
    "Martian and Qodo: list-price dollars and minutes per review, and s62's reviews that finished ok and its rate-limit errors",
};
const CHECKS = 22;

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
    expect(cs).toHaveLength(CHECKS);
    expect(cs.filter((c) => c.ok)).toEqual([]);
  });

  it("the committed manifest is the release folder's: its README and the fifteen tables", () => {
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
  it("passes all twenty-two on a whole folder that is the manifest's, recomputing every number", () => {
    const cs = checks(BASE);
    expect(cs).toHaveLength(CHECKS);
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
    // Martian and Qodo: the analysis's numbers file
    expect(post.martian[N].core).toEqual({
      precision: 12.9,
      recall: 62,
      f1: 21.3,
      f2: 35.2,
      tp: 98,
      golden: 158,
      fp: 664,
      fn: 60,
    });
    expect(post.martian[O].core).toEqual({
      precision: 16.2,
      recall: 65.8,
      f1: 26.1,
      f2: 40.9,
      tp: 104,
      golden: 158,
      fp: 536,
      fn: 54,
    });
    expect(post.martian_rejudged.max_core_move).toBe(4);
    expect(post.qodo.issues).toEqual({ total: 580, functional: 309, rule: 271, prs: 100 });
    expect(post.qodo[N].n5).toMatchObject({
      comments: 729,
      per_pr: 7.29,
      precision: 28,
      recall: 35.2,
      f1: 31.2,
      recall_functional: 53.1,
      recall_rule: 14.8,
    });
    expect(post.qodo[O].n5).toMatchObject({
      comments: 706,
      per_pr: 7.06,
      precision: 37.3,
      recall: 45.3,
      f1: 40.9,
      recall_functional: 52.1,
      recall_rule: 37.6,
      hits_rule: 102,
    });
    expect(post.qodo_comments.drop).toMatchObject({
      old_rule_hits_nit_tag: 70,
      old_rule_hits_quiet: 71,
      old_rule_hits_p0_p2: 31,
      // by footer, as the README defines severity: s62's one rule hit from a review-body finding has none
      new_rule_hits_p0_p2: 39,
      new_rule_hits_no_footer: 1,
    });
    expect(post.mq_cost).toMatchObject({
      [`martian.${N}.usd_per_pr`]: 5.4,
      [`martian.${O}.usd_per_pr`]: 2.84,
      [`qodo.${N}.usd_per_pr`]: 3.55,
      [`qodo.${O}.usd_per_pr`]: 2.48,
      [`martian50.${N}.rate_limited`]: 34,
      [`qodo-pr100.${N}.rate_limited`]: 49,
    });
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

  // MUTATION: in gpt62_sol.mq_rows, read final1's rows from the folder (src = t[name]) — this fails
  // MUTATION: in gpt62_sol.mq_whole_problems, skip the stored martian_scores' recount — this fails
  it("recounts Martian from s62's verdicts here and final1's in the dataset, and fails a stored score that does not recount", () => {
    const mine = variant("martian-s62", (g) =>
      edit(g, "martian_verdicts", (r) =>
        r.tool === N && r.pr_url === M2 && r.golden_index === 1 ? { ...r, matched: false } : r,
      ),
    );
    expect(failing(mine)).toEqual([C.whole, C.martian, C.martian_goldens]);
    const theirs = variant("martian-final1", (g) =>
      edit(join(dirname(g), "data"), "martian_verdicts", (r) =>
        r.tool === "quickreview-frozen" && r.pr_url === M2 && r.golden_index === 0
          ? { ...r, matched: false }
          : r,
      ),
    );
    expect(failing(theirs)).toEqual([C.martian, C.martian_goldens]);
    // the dataset's rows of another scoring are never final1's
    const other = variant("martian-other", (g) =>
      edit(join(dirname(g), "data"), "martian_reviews", (r) =>
        r.work_dir === "other-martian50" ? { ...r, tool: "quickreview-frozen" } : r,
      ),
    );
    expect(failing(other)).toEqual([]);
  });

  // MUTATION: in gpt62_sol.mq_whole_problems, skip the location flags' comparison with qodo_judge.located — this fails
  // MUTATION: in gpt62_sol.qodo_numbers, count only P3 as a class the quiet default does not post (drop "nit") — this fails
  it("recounts Qodo under each location rule, checks the flags against the comment, and reads the drop from footers", () => {
    // final1's two rule-violation matches came from a P3 and a nit footer: both are the quiet class
    expect(checks(BASE).find((c) => c.check.endsWith(C.qodo_comments))!.got).toEqual(
      POST.qodo_comments,
    );
    const flag = variant("qodo-flag", (g) =>
      edit(g, "qodo_verdicts", (r) =>
        r.pr_url === Q1 && r.issue_index === 1 ? { ...r, located_n5: true } : r,
      ),
    );
    expect(failing(flag)).toEqual([C.whole, C.qodo, C.qodo_comments]);
    // final1's nit-footed rule-violation match rated P2 instead: one fewer from the quiet class
    const footer = variant("qodo-footer", (g) =>
      edit(join(dirname(g), "data"), "qodo_reviews", (r) =>
        r.pr_url === Q2
          ? {
              ...r,
              comments: (r.comments as QComment[]).map((c) =>
                c.index === 0 ? { ...c, body: c.body.replace("_nit · ", "_P2 · ") } : c,
              ),
            }
          : r,
      ),
    );
    expect(failing(footer)).toEqual([C.qodo_comments]);
  });

  // MUTATION: in gpt62_sol.checks, skip the dataset's columns of the Martian and Qodo tables — this fails
  it("fails a Martian or Qodo table whose columns are not the dataset's table's", () => {
    const theirs = variant("columns-dataset", (g) =>
      edit(join(dirname(g), "data"), "qodo_verdicts", (r) => ({ ...r, judge_effort: "low" })),
    );
    expect(failing(theirs)).toEqual([C.columns]);
    const mine = variant("columns-mine", (g) =>
      edit(g, "martian_scores", (r) => ({ ...r, note: "x" })),
    );
    expect(failing(mine)).toEqual([C.columns]);
  });

  // MUTATION: in gpt62_sol.mq_whole_problems, skip the cases' cost and minutes against their review's — this fails
  // MUTATION: in gpt62_sol.mq_whole_problems, accept a row of another work dir — this fails
  it("fails s62's Martian and Qodo cases that are not its reviews, and rows of another scoring", () => {
    const cost = variant("mq-case-cost", (g) =>
      edit(g, "cases", (r) => (r.pr_url === Q1 ? { ...r, usd: 9 } : r)),
    );
    expect(failing(cost)).toEqual([C.whole]);
    const stray = variant("mq-stray", (g) =>
      edit(g, "qodo_reviews", (r) => (r.pr_url === Q2 ? { ...r, work_dir: QW(O) } : r)),
    );
    expect(failing(stray)).toContain(C.whole);
    const limits = variant("mq-limits", (g) =>
      edit(g, "cases", (r) =>
        r.pr_url === M2
          ? { ...r, model_errors: { rate_limited: 1, overloaded: 0, usage_limit: 0, other: 0 } }
          : r,
      ),
    );
    expect(failing(limits)).toEqual([C.mq_cost]);
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
    // manifest check and the seventeen number checks fail, the columns, the rows, the README and the refit pass
    expect(got[1].map(([, ok]) => ok)).toEqual([
      false,
      true,
      true,
      true,
      true,
      ...Array(17).fill(false),
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

  // MUTATION: in hf_export.build_elo, drop the `plan_name in GS.PLANS` skip — this fails
  // MUTATION: in hf_export.elo_plan_checks, count no row (got = 0) — this fails
  // MUTATION: in hf_export.validate_release, drop `checks += elo_plan_checks(t)` — this fails
  it("keeps the comparison's Elo plans out of the dataset's own Elo tables, and its checks fail them there", () => {
    const elo = join(tmp, "elo-default");
    for (const plan of ["martian-plan", PLANS[0]!]) {
      mkdirSync(join(elo, plan, "judgments"), { recursive: true });
      writeFileSync(
        join(elo, plan, "plan.json"),
        JSON.stringify({ runs: ["x", "y"], judges: ["gpt"], labels: {} }),
      );
      // a judgment file of no rated judge: its rows are tabled, and no ratings are fit
      jsonl(join(elo, plan, "judgments"), "spot", [{ id: "u1", status: "error", at: "1" }]);
    }
    const got = py(
      `import hf_export as h
x = h.Exporter(types.SimpleNamespace(runs_dir=sys.argv[1], elo_dir=sys.argv[2]))
x.build_elo()
t = x.tables
bad = {"elo_judgments": t["elo_judgments"] + [{"plan": sys.argv[3]}], "elo_ratings": [{"plan": sys.argv[3]}] * 2}
src = open(h.__file__).read()
body = src[src.index("def validate_release("):src.index("\\ndef ", src.index("def validate_release(") + 1)]
print(json.dumps([sorted({r["plan"] for r in t["elo_judgments"]}),
                  [c["ok"] for c in h.elo_plan_checks(t)], [c["got"] for c in h.elo_plan_checks(bad)],
                  "elo_plan_checks(t)" in body]))`,
      tmp,
      elo,
      PLANS[0]!,
    );
    expect(got).toEqual([["martian-plan"], [true, true], [1, 2], true]);
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

describe("gpt62_sol: Martian and Qodo in the export and the build", () => {
  // MUTATION: in hf_export.build_martian, drop the GS.MQ_WORK_DIRS skip — this fails
  // MUTATION: in hf_export.build_qodo, drop the GS.MQ_WORK_DIRS skip — this fails
  // MUTATION: in hf_export.mq_run_checks, count no row (got = 0) — this fails
  // MUTATION: in hf_export.validate_release, drop `checks += mq_run_checks(t)` — this fails
  it("keeps s62's Martian and Qodo scorings out of the dataset's own tables, and its checks fail them there", () => {
    const runs = join(tmp, "mq-runs");
    const got = py(
      `import hf_export as h, hashlib, os, martian_real
martian_real.buckets = lambda published: {}  # no goldens: the scoring dirs are what is under test
runs = sys.argv[1]
os.makedirs(runs + "/final1-martian50.martian", exist_ok=True)
open(runs + "/final1-martian50.martian/published-benchmark_data.json", "w").write("{}")
qset = json.load(open(h.HERE + "/sets/qodo-pr100.json"))["cases"]
gt = runs + "/gt.jsonl"
open(gt, "w").write("".join(json.dumps({"pr_url_to_review": c["pr_url"], "issues": []}) + "\\n" for c in qset))
h.QODO_GT_SHA256 = hashlib.sha256(open(gt, "rb").read()).hexdigest()
open(runs + "/tools.json", "w").write("[]")
x = h.Exporter(types.SimpleNamespace(runs_dir=runs, qodo_gt=gt, qodo_tools=runs + "/tools.json"))
x.all_runs = lambda: ["s62-martian50.martian", "s62-qodo-pr100.qodo", "other-martian50.martian", "other-qodo-pr100.qodo"]
seen = []
x._martian_dir = lambda wd, *a, **k: seen.append(wd)
x._qodo_dir = lambda qdir, wd, *a, **k: seen.append(wd)
x.build_martian()
x.build_qodo()
bad = {"martian_reviews": [{"work_dir": "s62-martian50"}], "qodo_verdicts": [{"work_dir": "s62-qodo-pr100"}] * 2,
       "martian_scores": [{"work_dir": "final1-martian50"}]}
src = open(h.__file__).read()
body = src[src.index("def validate_release("):src.index("\\ndef ", src.index("def validate_release(") + 1)]
print(json.dumps([[w for w in seen if "s62" in w or "other" in w], [c["ok"] for c in h.mq_run_checks({})],
                  [c["got"] for c in h.mq_run_checks(bad)], "mq_run_checks(t)" in body]))`,
      runs,
    );
    expect(got).toEqual([
      ["other-martian50.martian", "other-qodo-pr100"],
      [true, true, true, true, true],
      [1, 0, 0, 0, 2],
      true,
    ]);
  });

  // MUTATION: in gpt62_sol._mq_judge, skip the served model's comparison — this fails
  // MUTATION: in gpt62_sol._mq_judge, skip JUDGE.txt's comparison — this fails
  it("names the Martian and Qodo judge only when every answered call was it, at its effort", () => {
    const judge = (name: string, txt: string, calls: Row[]) => {
      const d = join(tmp, "mq-judge", name, "judge");
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "JUDGE.txt"), txt);
      jsonl(d, "judge", calls);
      return py(
        `import gpt62_sol as G
try:
    print(json.dumps(G._mq_judge(sys.argv[1])))
except SystemExit as e:
    print(json.dumps(str(e)))`,
        dirname(d),
      ) as string;
    };
    const txt = "gpt-6.1-sol, reasoning effort low, via bench/aacr/ext/ext_judge.py\n";
    const call = (served: string | null, status = 200, effort = "low"): Row => ({
      asked_model: "gpt-6.1-sol",
      served_model: served,
      effort,
      status,
    });
    expect(judge("ok", txt, [call("gpt-6.1-sol"), call(null, 502), { probe: true }])).toBe(
      "gpt-6.1-sol at reasoning effort low",
    );
    expect(judge("served", txt, [call("gpt-6.1-sol"), call("gpt-6-sol")])).toMatch(
      /was served gpt-6-sol/,
    );
    expect(judge("effort", txt, [call("gpt-6.1-sol", 200, "high")])).toMatch(/at high/);
    expect(judge("named", "gpt-6.1-sol, reasoning effort high\n", [call("gpt-6.1-sol")])).toMatch(
      /JUDGE.txt names/,
    );
    expect(judge("none", txt, [call(null, 502)])).toMatch(/no answered call/);
  });

  it("states the Martian and Qodo numbers in the README, with final1's from the dataset", () => {
    const md = readFileSync(join(BASE, "gpt62_sol", "README.md"), "utf8");
    expect(md).toContain("## Martian and Qodo");
    expect(md).toContain(
      "| Core precision / recall / F1 / F2 | 28.6 / 66.7 / 40.0 / 52.6 | 50.0 / 66.7 / 57.1 / 62.5 |",
    );
    expect(md).toContain("| N=5 recall on rule violations (found, of 2) | 0.0 (0) | 100.0 (2) |");
    expect(md).toContain("N=5, 2 came from comments whose footer gives P3 or nit");
    expect(md).toContain(
      "By footer, `final1`'s rule-violation matches at P0 to P2 number 0,\nagainst `s62`'s 0.",
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

  // MUTATION: in gpt62_sol.PI_MAIN, drop s62's image — this fails
  // MUTATION: in gpt62_sol._pi_source, return the commit without comparing the image's label — this fails
  // MUTATION: in gpt62_sol._engine, return None for every run — this fails
  it("records where s62's pi came from and each run's engine, and refuses an image whose label disagrees", () => {
    const got = py(
      `import gpt62_sol as G, subprocess
img = next(iter(G.PI_MAIN))
real = subprocess.run
def fake(label):
    def run(argv, **kw):
        if argv[:2] != ["docker", "image"]:
            return real(argv, **kw)
        mine = label and argv[3] == img  # only s62's image carries the label
        out = json.dumps({"qcr.pi.main": label}) if mine else ""
        return subprocess.CompletedProcess(argv, 0 if mine else 1, out, "")
    return run
out = []
for label in (None, G.PI_MAIN[img]):
    subprocess.run = fake(label)
    out.append([G._pi_source(img, "1.5.2"), G._pi_source("sha256:other", "1.5.2")])
subprocess.run = fake("0" * 40)
try:
    G._pi_source(img, "1.5.2"); out.append("accepted")
except SystemExit as e:
    out.append(str(e))
out.append([G._engine({"runtime": "sdk", "lens_runtime": "engine", "wave": True}), G._engine(None)])
print(json.dumps([img, out]))`,
    ) as [string, [[string | null, null], [string | null, null], string, [string, null]]];
    const [img, [noDocker, labelled, refused, engines]] = got;
    expect(img).toBe("sha256:0224d9578ad8afa4d027d603b1e3257c033f5a4d95be1bcca9c520d120eb3f42");
    const src =
      "pi rebuilt from its unreleased main at 1e34c3b4c7df78e716a8f53ad0bcf3a00feceedc; it reports itself as 1.5.2";
    expect(noDocker).toEqual([src, null]);
    expect(labelled).toEqual([src, null]);
    expect(refused).toMatch(/qcr\.pi\.main label is 0{40}, PI_MAIN says 1e34c3b4/);
    expect(engines).toEqual(["runtime=sdk, lens_runtime=engine, wave=true", null]);
  });

  // MUTATION: in gpt62_sol.readme, name three differences between the setups (drop the runtime) — this fails
  it("names the runtime among the differences between the setups", () => {
    const md = readFileSync(join(BASE, "gpt62_sol", "README.md"), "utf8");
    expect(md).toContain(
      "Four things differ between the setups: the model, the QuickReview releases",
    );
    expect(md).toContain("runtime under them");
    expect(md).toContain("| Runtime | the SDK engine");
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

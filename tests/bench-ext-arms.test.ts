// The external benchmarks' scorers read a third-party bench arm's run
// (PR-Agent, OpenCode, …) as well as QuickReview's: martian_ingest.py --arm
// builds the record Martian's step 1 would have collected from the arm's
// review as the AACR defect judge reads it, under the arm's own tool name;
// qodo_judge.py --run-tool scores the run under that name.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = join(ROOT, "bench", "aacr", "ext");

let t: string;
beforeEach(() => {
  t = mkdtempSync(join(tmpdir(), "qcr-extarms-"));
});
afterEach(() => rmSync(t, { recursive: true, force: true }));

const URL_A = "https://github.com/o/r/pull/1";
const URL_B = "https://github.com/o/r/pull/2";

function writeArmCase(
  runDir: string,
  id: string,
  status: string,
  comments: unknown[],
  body: string | null,
) {
  mkdirSync(join(runDir, "cases", id), { recursive: true });
  mkdirSync(join(runDir, "results", "all"), { recursive: true });
  writeFileSync(
    join(runDir, "cases", id, "case-summary.json"),
    JSON.stringify({ instance_id: id, status }),
  );
  writeFileSync(
    join(runDir, "results", "all", `${id}.json`),
    JSON.stringify({
      instance_id: id,
      reviewer: "pragent",
      started_at: "2026-10-04T10:00:00Z",
      review: { comments },
    }),
  );
  if (body !== null) writeFileSync(join(runDir, "cases", id, "review.md"), body);
}

async function ingest(
  runDir: string,
  arm: string | null,
  rejudge: string | null = null,
  extra: string[] = [],
) {
  const set = join(t, "set.json");
  writeFileSync(
    set,
    JSON.stringify({
      cases: [
        { instance_id: "o__r-1@aaa", pr_url: URL_A },
        { instance_id: "o__r-2@bbb", pr_url: URL_B },
      ],
    }),
  );
  const pub = join(t, "published.json");
  const golden = { golden_comments: [{ comment: "x", severity: "High" }] };
  writeFileSync(
    pub,
    JSON.stringify({
      [URL_A]: { ...golden, reviews: [{ tool: "cubic-v2", review_comments: [] }] },
      [URL_B]: { ...golden, reviews: [{ tool: "cubic-v2", review_comments: [] }] },
    }),
  );
  const out = join(t, "work", "results", "benchmark_data.json");
  await run("python3", [
    join(EXT, "martian_ingest.py"),
    "--run",
    runDir,
    "--set",
    set,
    "--published",
    pub,
    "--out",
    out,
    ...(arm ? ["--arm", arm] : []),
    ...(rejudge ? ["--rejudge", rejudge] : []),
    ...extra,
  ]);
  return JSON.parse(readFileSync(out, "utf8")) as Record<
    string,
    { reviews: Array<{ tool: string; review_comments: Array<Record<string, unknown>> }> }
  >;
}

describe("martian_ingest.py --arm (a third-party bench arm)", () => {
  it("pragent: located findings as inline comments (first 30), then review.md as one body item, under pr-agent", async () => {
    const runDir = join(t, "run");
    const many = Array.from({ length: 33 }, (_, i) => ({
      path: "a.py",
      start_line: i + 1,
      end_line: i + 2,
      content: `finding ${i}`,
    }));
    writeArmCase(
      runDir,
      "o__r-1@aaa",
      "ok",
      [{ path: "a.py", start_line: 3, end_line: 3, content: "  " }, ...many],
      "## PR Reviewer Guide\nbody",
    );
    writeArmCase(runDir, "o__r-2@bbb", "failed", many, "never posted");
    const d = await ingest(runDir, "pragent");
    const a = d[URL_A]!.reviews;
    expect(a.map((r) => r.tool)).toEqual(["pr-agent"]);
    const items = a[0]!.review_comments;
    expect(items).toHaveLength(31);
    expect(items[0]).toMatchObject({ path: "a.py", line: 2, body: "finding 0" });
    expect(items[29]!.body).toBe("finding 29");
    expect(items[30]).toMatchObject({ path: null, line: null, body: "## PR Reviewer Guide\nbody" });
    // A case that did not finish posted nothing.
    expect(d[URL_B]!.reviews[0]).toMatchObject({ tool: "pr-agent", review_comments: [] });
  });

  it("opencode: no review.md → inline comments only", async () => {
    const runDir = join(t, "run");
    writeArmCase(
      runDir,
      "o__r-1@aaa",
      "ok",
      [{ path: "b.ts", start_line: 7, end_line: null, content: "bug" }],
      null,
    );
    writeArmCase(runDir, "o__r-2@bbb", "ok", [], null);
    const d = await ingest(runDir, "opencode");
    expect(d[URL_A]!.reviews[0]).toMatchObject({
      tool: "opencode",
      review_comments: [{ path: "b.ts", line: 7, body: "bug" }],
    });
    expect(d[URL_B]!.reviews[0]!.review_comments).toEqual([]);
  });

  it("no --arm reads QuickReview's own case files, as before", async () => {
    const runDir = join(t, "run");
    for (const id of ["o__r-1@aaa", "o__r-2@bbb"]) {
      mkdirSync(join(runDir, "cases", id), { recursive: true });
      writeFileSync(
        join(runDir, "cases", id, "case-summary.json"),
        JSON.stringify({ status: "ok" }),
      );
      writeFileSync(
        join(runDir, "cases", id, "outcome.json"),
        JSON.stringify({ finished_at: "t", verdict: "COMMENT" }),
      );
      writeFileSync(
        join(runDir, "cases", id, "comments.json"),
        JSON.stringify([{ path: "c.go", line: 4, body: "[nit] x" }]),
      );
      writeFileSync(join(runDir, "cases", id, "review.md"), "summary");
    }
    const d = await ingest(runDir, null);
    expect(d[URL_A]!.reviews[0]).toMatchObject({
      tool: "quickreview",
      review_comments: [
        { path: "c.go", line: 4, body: "[nit] x" },
        { path: null, line: null, body: "summary" },
      ],
    });
  });
});

describe("a run from the release's archive: its SOURCE-COPIES restored first", () => {
  const RESTORE = join(EXT, "restore_copies.py");
  // The archive's shape: one volume holds the source run, another the variant
  // whose case-summary.json is listed in its SOURCE-COPIES.json, not shipped.
  const archive = () => {
    const src = join(t, "vol-a", "runs", "src-run", "cases");
    const variant = join(t, "vol-b", "runs", "variant");
    for (const id of ["o__r-1@aaa", "o__r-2@bbb"]) {
      mkdirSync(join(src, id), { recursive: true });
      writeFileSync(join(src, id, "case-summary.json"), JSON.stringify({ status: "ok" }));
      mkdirSync(join(variant, "cases", id), { recursive: true });
      writeFileSync(
        join(variant, "cases", id, "outcome.json"),
        JSON.stringify({ finished_at: "t", verdict: "COMMENT" }),
      );
      writeFileSync(
        join(variant, "cases", id, "comments.json"),
        JSON.stringify([{ path: "c.go", line: 4, body: "kept by the policy" }]),
      );
    }
    writeFileSync(
      join(variant, "SOURCE-COPIES.json"),
      JSON.stringify({
        note: "stored once",
        files: Object.fromEntries(
          ["o__r-1@aaa", "o__r-2@bbb"].map((id) => [
            `cases/${id}/case-summary.json`,
            `runs/src-run/cases/${id}/case-summary.json`,
          ]),
        ),
      }),
    );
    return variant;
  };
  const fails = (p: Promise<unknown>) =>
    p.then(
      () => "",
      (e: { stderr: string }) => String(e.stderr),
    );

  // MUTATION: drop the unrestored() check in martian_ingest.py main() — this fails
  // MUTATION: make case_summary() return None for a case dir with no summary (the old silent path) — this fails
  it("martian_ingest refuses the unrestored run and its summary-less case, never scores them silent", async () => {
    const variant = archive();
    expect(await fails(ingest(variant, null))).toMatch(
      /2 file\(s\) its SOURCE-COPIES\.json lists are missing .*restore_copies\.py/,
    );
    rmSync(join(variant, "SOURCE-COPIES.json"));
    expect(await fails(ingest(variant, null))).toMatch(
      /o__r-1@aaa: no case-summary\.json .*restore_copies\.py/,
    );
    // A run still in progress (ext.sh EXT_WORK_TAG): a case with no summary yet is silent, as before.
    const d = await ingest(variant, null, null, ["--interim"]);
    expect(d[URL_A]!.reviews[0]!.review_comments).toEqual([]);
  });

  // MUTATION: write each copy next to its source instead of next to the SOURCE-COPIES.json — this fails
  // MUTATION: drop the ".." refusal in inside() — this fails
  it("restore_copies.py puts every listed file back from any volume, after which the variant ingests", async () => {
    const variant = archive();
    const dry = await run("python3", [RESTORE, "--dry-run", join(t, "vol-a"), join(t, "vol-b")]);
    expect(dry.stdout).toContain("2 listed files: would copy 2, 0 already in place");
    const done = await run("python3", [RESTORE, join(t, "vol-a"), join(t, "vol-b")]);
    expect(done.stdout).toContain("2 listed files: copied 2, 0 already in place");
    const again = await run("python3", [RESTORE, join(t, "vol-a"), join(t, "vol-b")]);
    expect(again.stdout).toContain("2 listed files: copied 0, 2 already in place");
    const d = await ingest(variant, null);
    expect(d[URL_A]!.reviews[0]!.review_comments).toMatchObject([{ body: "kept by the policy" }]);
    // A target that differs is never overwritten, and no path climbs out of its root.
    writeFileSync(join(variant, "cases", "o__r-2@bbb", "case-summary.json"), "{}");
    expect(await fails(run("python3", [RESTORE, join(t, "vol-a"), join(t, "vol-b")]))).toMatch(
      /exists and differs/,
    );
    writeFileSync(
      join(variant, "SOURCE-COPIES.json"),
      JSON.stringify({
        files: { "../../escape.json": "runs/src-run/cases/o__r-1@aaa/case-summary.json" },
      }),
    );
    expect(await fails(run("python3", [RESTORE, join(t, "vol-a"), join(t, "vol-b")]))).toMatch(
      /not a relative path inside the archive/,
    );
  });
});

describe("martian_ingest.py --rejudge", () => {
  // The re-judge loop must not reuse the arm's tool variable: if it does, from
  // the second PR on the arm's review is filed under the last re-judged tool's
  // name and the arm is scored on one PR.
  it("keeps the arm's tool name on every PR beside the re-judged reviews", async () => {
    const runDir = join(t, "run");
    for (const id of ["o__r-1@aaa", "o__r-2@bbb"]) {
      mkdirSync(join(runDir, "cases", id), { recursive: true });
      writeFileSync(
        join(runDir, "cases", id, "case-summary.json"),
        JSON.stringify({ status: "ok" }),
      );
      writeFileSync(
        join(runDir, "cases", id, "outcome.json"),
        JSON.stringify({ finished_at: "t", verdict: "COMMENT" }),
      );
      writeFileSync(
        join(runDir, "cases", id, "comments.json"),
        JSON.stringify([{ path: "c.go", line: 4, body: "x" }]),
      );
    }
    const d = await ingest(runDir, null, "cubic-v2");
    for (const url of [URL_A, URL_B])
      expect(d[url]!.reviews.map((r) => r.tool)).toEqual(["quickreview", "rejudged-cubic-v2"]);
  });
});

describe("qodo_judge.py reads a third-party arm's run", () => {
  it("ours() takes the arm's results/all review.comments view", async () => {
    const runDir = join(t, "run");
    writeArmCase(
      runDir,
      "o__r-1@aaa",
      "ok",
      [
        { path: "a.py", start_line: 5, end_line: 9, content: "race" },
        { path: null, start_line: null, end_line: null, content: "no location" },
      ],
      "body is not judged",
    );
    const { stdout } = await run("python3", [
      "-c",
      "import sys, json; from pathlib import Path; sys.path.insert(0, sys.argv[1]); import qodo_judge as q; print(json.dumps(q.ours(Path(sys.argv[2]), 'o__r-1@aaa')))",
      EXT,
      runDir,
    ]);
    expect(JSON.parse(stdout)).toEqual([{ path: "a.py", start: 5, end: 9, body: "race" }]);
  });

  it("--run-tool refuses a published vendor's name", async () => {
    const err = await run("python3", [
      join(EXT, "qodo_judge.py"),
      "--set",
      "/dev/null",
      "--gt",
      "/dev/null",
      "--tools",
      "/dev/null",
      "--run",
      t,
      "--run-tool",
      "codex",
      "--endpoint",
      "http://127.0.0.1:9",
      "--out",
      join(t, "w"),
    ]).catch((e: { stderr: string }) => e);
    expect(String((err as { stderr: string }).stderr)).toMatch(/published vendor's name/);
  });
});

describe("qodo_judge.py's judgement cache", () => {
  // Runs main() with ask() replaced: ASK=match answers C0↔I0 and counts the
  // calls into <out>/asked; ASK=fail raises, so a cached judgement must serve.
  const MAIN = [
    "import sys, os; from pathlib import Path; sys.path.insert(0, os.environ['EXT']); import qodo_judge as q",
    "def ask(endpoint, issues, comments, model=None):",
    "    if os.environ['ASK'] == 'fail': raise AssertionError('asked')",
    "    with open(os.path.join(os.environ['OUT'], 'asked'), 'a') as f: f.write(model[0] if model else 'x')",
    "    return [{'comment': 0, 'issue': 0, 'why': 'same'}], {}",
    "q.ask = ask",
    "sys.argv = ['qodo_judge.py'] + sys.argv[1:]",
    "q.main()",
  ].join("\n");

  it("re-asks a case judged silent at an interim score once its comments exist", async () => {
    let resume: string[] = [];
    const runDir = join(t, "run");
    const out = join(t, "work");
    mkdirSync(join(runDir, "results", "all"), { recursive: true });
    writeFileSync(
      join(t, "set.json"),
      JSON.stringify({ cases: [{ pr_url: URL_A, instance_id: "o__r-1@aaa" }] }),
    );
    writeFileSync(
      join(t, "gt.jsonl"),
      JSON.stringify({
        pr_url_to_review: URL_A,
        issues: [
          { title: "race", description: "d", file_path: "a.py", start_line: 5, end_line: 9 },
        ],
      }) + "\n",
    );
    writeFileSync(join(t, "tools.json"), "[]");
    const judge = (ask: string) =>
      run(
        "python3",
        [
          "-c",
          MAIN,
          "--set",
          join(t, "set.json"),
          "--gt",
          join(t, "gt.jsonl"),
          "--tools",
          join(t, "tools.json"),
          "--run",
          runDir,
          "--only-tools",
          "quickreview",
          "--endpoint",
          "http://127.0.0.1:9",
          "--out",
          out,
          ...resume,
        ],
        { env: { ...process.env, EXT, ASK: ask, OUT: out } },
      );
    const tp = () =>
      (
        JSON.parse(readFileSync(join(out, "scores.json"), "utf8")) as {
          scores: { quickreview: { "N=5": { tp: number } } };
        }
      ).scores.quickreview["N=5"].tp;

    await judge("fail"); // the case is unfinished: judged silent without asking
    expect(tp()).toBe(0);
    resume = ["--resume"]; // the same judge continues its own work dir

    writeArmCase(
      runDir,
      "o__r-1@aaa",
      "ok",
      [{ path: "a.py", start_line: 5, end_line: 9, content: "race" }],
      null,
    );
    await judge("match");
    expect(tp()).toBe(1);
    expect(readFileSync(join(out, "asked"), "utf8")).toBe("g"); // gpt-6.1-sol, the default model

    await judge("fail"); // unchanged comments: the cached judgement serves
    expect(tp()).toBe(1);
  });
});

describe("qodo_judge.py with another judge (re-judging the published reviews)", () => {
  // main() with ask() replaced: it records the model asked and the comments
  // sent per call into <out>/asked.jsonl and matches C0 to I0.
  const MAIN = [
    "import sys, os, json; sys.path.insert(0, os.environ['EXT']); import qodo_judge as q",
    "def ask(endpoint, issues, comments, model=None):",
    "    with open(os.path.join(os.environ['OUT'], 'asked.jsonl'), 'a') as f:",
    "        f.write(json.dumps({'model': model, 'comments': comments}) + '\\n')",
    "    return [{'comment': 0, 'issue': 0, 'why': 'same'}], {}",
    "q.ask = ask",
    "sys.argv = ['qodo_judge.py'] + sys.argv[1:]",
    "q.main()",
  ].join("\n");
  const KEY = "ext-r6-qodo-pr100|quickreview-2026-10-02";
  let out: string;
  beforeEach(() => {
    out = join(t, "work");
    writeFileSync(
      join(t, "set.json"),
      JSON.stringify({ cases: [{ pr_url: URL_A, instance_id: "o__r-1@aaa" }] }),
    );
    writeFileSync(
      join(t, "gt.jsonl"),
      JSON.stringify({
        pr_url_to_review: URL_A,
        issues: [
          { title: "race", description: "d", file_path: "a.py", start_line: 5, end_line: 9 },
        ],
      }) + "\n",
    );
    // The published table: the judged list, in `index` order, beside another
    // build's rows on the same PR that must not be read.
    const row = (tool: string, comments: unknown[]) =>
      JSON.stringify({ work_dir: "ext-r6-qodo-pr100", tool, pr_url: URL_A, comments });
    writeFileSync(
      join(t, "qodo_reviews.jsonl"),
      [
        row("quickreview-2026-10-02", [
          { index: 1, path: "b.py", start: 2, end: 2, body: "second" },
          { index: 0, path: "a.py", start: 5, end: 9, body: "race" },
        ]),
        row("quickreview-frozen", [
          { index: 0, path: "z.py", start: 1, end: 1, body: "other build" },
        ]),
      ].join("\n") + "\n",
    );
  });
  const judge = (...extra: string[]) =>
    run(
      "python3",
      [
        "-c",
        MAIN,
        "--set",
        join(t, "set.json"),
        "--gt",
        join(t, "gt.jsonl"),
        "--reviews",
        join(t, "qodo_reviews.jsonl"),
        "--review-key",
        KEY,
        "--endpoint",
        "http://127.0.0.1:9",
        "--out",
        out,
        ...extra,
      ],
      { env: { ...process.env, EXT, OUT: out } },
    );
  const fails = (p: Promise<unknown>) =>
    p.then(
      () => "",
      (e: { stderr: string }) => String(e.stderr),
    );

  // MUTATION: call ask() without model=a.model in qodo_judge.main (the default model is asked) — this fails
  // MUTATION: print "one judge (gpt-6.1-sol)" in score() again — this fails
  it("--model is what is asked, --judge-label what the verdicts and the scores carry", async () => {
    mkdirSync(out);
    await judge("--model", "my-model", "--judge-label", "my-judge");
    const asked = readFileSync(join(out, "asked.jsonl"), "utf8").trim().split("\n");
    expect(asked.map((l) => (JSON.parse(l) as { model: string }).model)).toEqual(["my-model"]);
    const rows = readFileSync(join(out, "judgements.jsonl"), "utf8").trim().split("\n");
    expect(rows.map((l) => (JSON.parse(l) as { judge: string }).judge)).toEqual(["my-judge"]);
    const scores = JSON.parse(readFileSync(join(out, "scores.json"), "utf8")) as {
      judge: string;
      scores: Record<string, { "N=5": { tp: number; comments: number } }>;
    };
    expect(scores.judge).toBe("my-judge");
    expect(readFileSync(join(out, "scores.md"), "utf8")).toContain(
      "one judge (my-judge) for every tool",
    );
  });

  // MUTATION: read the comments with ours() (a run dir) instead of the --reviews rows, or drop the index sort — this fails
  // MUTATION: make --tools required again — this fails
  it("--reviews judges exactly the published list of the key's rows, under the key's tool, with no vendor file", async () => {
    await judge();
    const asked = JSON.parse(readFileSync(join(out, "asked.jsonl"), "utf8")) as {
      comments: unknown[];
    };
    expect(asked.comments).toEqual([
      { path: "a.py", start: 5, end: 9, body: "race" },
      { path: "b.py", start: 2, end: 2, body: "second" },
    ]);
    const scores = JSON.parse(readFileSync(join(out, "scores.json"), "utf8")) as {
      judge: string;
      scores: Record<string, { "N=5": { tp: number; comments: number } }>;
    };
    expect(Object.keys(scores.scores)).toEqual(["quickreview-2026-10-02"]);
    expect(scores.scores["quickreview-2026-10-02"]!["N=5"]).toMatchObject({ tp: 1, comments: 2 });
    expect(scores.judge).toBe("gpt-6.1-sol");
    expect(await fails(judge("--only-tools", "augment", "--resume"))).toMatch(
      /judging augment needs their comments: --tools/,
    );
  });

  // MUTATION: drop the `cache.exists() and not a.resume` refusal — this fails
  // MUTATION: drop the per-row judge-label check on resume — this fails
  it("an existing work dir is refused without --resume, and --resume never mixes two judges", async () => {
    await judge("--judge-label", "first");
    expect(await fails(judge("--judge-label", "first"))).toMatch(
      /judgements\.jsonl exists .*--resume/,
    );
    await judge("--judge-label", "first", "--resume"); // the same judge continues
    expect(await fails(judge("--judge-label", "second", "--resume"))).toMatch(
      /holds judgements by first; this run's judge is second/,
    );
    // An archive's judgements carry no label: they are gpt-6.1-sol's.
    const legacy = join(t, "legacy");
    mkdirSync(legacy);
    writeFileSync(
      join(legacy, "judgements.jsonl"),
      JSON.stringify({
        pr: URL_A,
        tool: "quickreview-2026-10-02",
        pass: 1,
        meta: {},
        matches: [],
      }) + "\n",
    );
    out = legacy;
    expect(await fails(judge("--judge-label", "mine", "--resume"))).toMatch(
      /holds judgements by gpt-6\.1-sol/,
    );
  });
});

describe("ext.sh qodo: one judge per work dir, any judge model (stub docker; nothing runs)", () => {
  // The real ext.sh in a scratch tree (its set pinned to a scratch dataset),
  // against a `docker` that logs its argv and answers every health check.
  const tree = () => {
    const aacr = join(t, "repo", "bench", "aacr");
    mkdirSync(join(aacr, "ext"), { recursive: true });
    mkdirSync(join(aacr, "sets"));
    for (const f of ["ext.sh", "martian_ingest.py"])
      writeFileSync(join(aacr, "ext", f), readFileSync(join(EXT, f)));
    const cache = join(t, "ext-cache", "qodo");
    mkdirSync(cache, { recursive: true });
    const gt = "{}\n";
    writeFileSync(join(cache, "git_code_review_bench_100_w_open_prs.jsonl"), gt);
    const sha = createHash("sha256").update(gt).digest("hex");
    writeFileSync(
      join(aacr, "sets", "q.json"),
      JSON.stringify({ dataset: { sha256: sha }, cases: [] }),
    );
    mkdirSync(join(t, "runs", "r1", "results", "all"), { recursive: true });
    const bin = join(t, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "docker"),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${join(t, "docker.log")}"\n`,
    );
    chmodSync(join(bin, "docker"), 0o755);
    writeFileSync(join(t, "openai.env"), "OPENAI_API_KEY=sk-test\n");
    return join(aacr, "ext", "ext.sh");
  };
  const ext = (sh: string, env: Record<string, string>, ...args: string[]) =>
    spawnSync("bash", [sh, "qodo", ...args], {
      env: {
        PATH: `${join(t, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        HOME: t,
        QCR_BENCH_RUNS_DIR: join(t, "runs"),
        EXT_CACHE: join(t, "ext-cache"),
        QCR_BENCH_OPENAI_ENV: join(t, "openai.env"),
        ...env,
      },
      encoding: "utf8",
    });
  const calls = () => readFileSync(join(t, "docker.log"), "utf8").split("\n");
  const judgeCall = () =>
    calls()
      .filter((l) => l.includes("ext_judge.py"))
      .at(-1) ?? "";
  const scorerCall = () =>
    calls()
      .filter((l) => l.includes("/ext/qodo_judge.py"))
      .at(-1) ?? "";

  // MUTATION: hard-code JUDGE_MODEL="gpt-6.1-sol" again, or drop `--model "$JUDGE_MODEL"` from the scorer — this fails
  // MUTATION: put `--tools /data/tool-comments.json` back unconditionally — this fails
  it("EXT_JUDGE_MODEL reaches the judge and the scorer; with no vendor file QuickReview is judged alone", () => {
    const sh = tree();
    const r = ext(sh, { EXT_JUDGE_MODEL: "my-model" }, "r1", "q");
    expect(r.status, r.stderr).toBe(0);
    expect(judgeCall()).toContain("--model my-model");
    expect(scorerCall()).toContain("--model my-model");
    expect(scorerCall()).toContain("--run /run --run-tool quickreview");
    expect(scorerCall()).not.toContain("--tools");
    expect(readFileSync(join(t, "runs", "r1.qodo", "judge", "JUDGE.txt"), "utf8")).toMatch(
      /^my-model, /,
    );
    expect(r.stdout).toContain("judging QuickReview only");
  });

  // MUTATION: drop the `[[ ! -e "$work" || "$resume" == 1 ]]` refusal from ext.sh qodo — this fails
  it("an existing work dir is refused unless --resume, which reaches qodo_judge.py", () => {
    const sh = tree();
    expect(ext(sh, {}, "r1", "q").status).toBe(0);
    const again = ext(sh, {}, "r1", "q");
    expect(again.status).not.toBe(0);
    expect(again.stderr).toContain("r1.qodo exists — pass --resume");
    expect(ext(sh, {}, "r1", "q", "--resume").status).toBe(0);
    expect(scorerCall()).toMatch(/--endpoint \S+ --out \/work --resume$/);
  });

  // MUTATION: run `cli.js auth` on the API-key route again — this fails
  it("the API-key route starts the judge without the login check (no compiled CLI needed)", () => {
    const sh = tree();
    expect(ext(sh, {}, "r1", "q").status).toBe(0);
    expect(judgeCall()).toContain("cli.js auth --need-min 120 && ");
    rmSync(join(t, "runs", "r1.qodo"), { recursive: true });
    expect(ext(sh, { QCR_BENCH_AUTH: "api-key" }, "r1", "q").status).toBe(0);
    expect(judgeCall()).not.toContain("cli.js auth");
    expect(judgeCall()).toContain("exec python3 /opt/quickreview/bench/ext_judge.py");
  });

  // MUTATION: drop the --reviews/--review-key runargs for EXT_QODO_REVIEWS — this fails
  it("EXT_QODO_REVIEWS judges the published rows of one key, mounted read-only; vendors alone still need their file", () => {
    const sh = tree();
    const table = join(t, "qodo_reviews.jsonl");
    writeFileSync(table, "");
    const r = ext(
      sh,
      { EXT_QODO_REVIEWS: table, EXT_QODO_REVIEW_KEY: "ext-r6-qodo-pr100|quickreview-2026-10-02" },
      "none",
      "q",
    );
    expect(r.status, r.stderr).toBe(0);
    expect(scorerCall()).toContain(`src=${table},dst=/reviews.jsonl,readonly`);
    expect(scorerCall()).toContain(
      "--reviews /reviews.jsonl --review-key ext-r6-qodo-pr100|quickreview-2026-10-02",
    );
    const vendors = ext(sh, {}, "none", "q");
    expect(vendors.status).not.toBe(0);
    expect(vendors.stderr).toContain("tool-comments.json");
  });
});

describe("martian_real.py — the audit's buckets over a work dir", () => {
  it("counts real / not-real credits and the all-found PRs from the true positives", async () => {
    const labels = (
      JSON.parse(
        readFileSync(join(ROOT, "bench", "aacr", "charts", "martian-data.json"), "utf8"),
      ) as {
        goldens: Array<{ sev: string; bucket: string }>;
      }
    ).goldens;
    // Two goldens per fake PR, in the labels' order (sorted urls, then index).
    const published: Record<
      string,
      { golden_comments: Array<{ comment: string; severity: string }> }
    > = {};
    labels.forEach((g, k) => {
      const url = `https://x/pull/${String(Math.floor(k / 2)).padStart(3, "0")}`;
      (published[url] ??= { golden_comments: [] }).golden_comments.push({
        comment: `g${k}`,
        severity: g.sev,
      });
    });
    const urls = Object.keys(published).sort();
    // The tool finds exactly the goldens of the first PR with two real ones, and one not-real.
    const pr = urls.find((u) =>
      published[u]!.golden_comments.every(
        (_, i) => labels[urls.indexOf(u) * 2 + i]!.bucket === "real",
      ),
    )!;
    const notReal = labels.findIndex((g) => g.bucket === "notreal");
    const notRealUrl = urls[Math.floor(notReal / 2)]!;
    const tps = (u: string) => [
      ...(u === pr
        ? published[u]!.golden_comments.map((g) => ({ golden_comment: g.comment }))
        : []),
      ...(u === notRealUrl ? [{ golden_comment: `g${notReal}` }] : []),
    ];
    const work = join(t, "w.martian");
    mkdirSync(join(work, "results", "judge-x"), { recursive: true });
    writeFileSync(join(work, "published-benchmark_data.json"), JSON.stringify(published));
    writeFileSync(
      join(work, "results", "judge-x", "evaluations.json"),
      JSON.stringify(
        Object.fromEntries(urls.map((u) => [u, { "pr-agent": { true_positives: tps(u) } }])),
      ),
    );
    const { stdout } = await run("python3", [join(EXT, "martian_real.py"), work]);
    const nReal = labels.filter((g) => g.bucket === "real").length;
    expect(stdout).toContain(
      `| w.martian | pr-agent | 2 of ${nReal} (${(200 / nReal).toFixed(1)}%) | 33% |`,
    );
    expect(stdout).toMatch(/\| 1 of \d+ \|$/m); // every real golden found on exactly one PR
  });
});

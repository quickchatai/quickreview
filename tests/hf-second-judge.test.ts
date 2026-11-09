// The dataset's second judges (`second_judges/<label>/`): the export copies the folder only when it is
// the committed manifest's, validation.json checks it, the claims verifier reads its numbers through the
// repository's scorers, and the card counts its checks apart. Runs for real under python3, standard
// library only, on a small dataset of .jsonl tables (neutral planted names):
//
//   1. the manifest: a folder with a file missing, extra or changed is refused before anything is
//      copied, and fails validation.json's manifest check;
//   2. validation.json's checks pass on a folder that covers the published judge's rows and whose
//      scores/ the scorers reproduce, and each fails on what it guards: a judge column naming another
//      label, a row missing, repeated or outside the named arms, a published judge's row the folder
//      lacks, a scores/ file that differs by one byte, a text column in a verdict table;
//   3. the claims verifier: claim_metrics.SecondJudge gives the second judge's numbers by label through
//      the scorers, discover finds the folder beside the tables, a claim reading it passes, and without
//      the folder it is skipped under --partial; its release checks carry needs ["second_judges"];
//   4. the card: the folder's tables by row count, a link to each judge's folder in the dataset, and
//      the release checks' split.

import { afterAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
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
const tmp = mkdtempSync(join(tmpdir(), "hf-second-judge-"));
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
      `import sys, json, types; sys.path.insert(0, ${JSON.stringify(RECOMPUTE)}); sys.path.insert(0, ${JSON.stringify(AACR)})\n${code}`,
      ...args,
    ],
    { encoding: "utf8", env: { ...process.env, ...SCRUB_ENV } },
  );
  if (p.status !== 0) throw new Error(p.stderr);
  return JSON.parse(p.stdout);
}

function jsonl(dir: string, name: string, rows: object[]): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

/** A sha256sum manifest of a dataset root's second_judges/ (paths relative to the root). */
function manifest(root: string, path: string): string {
  const lines = files(join(root, "second_judges"))
    .sort()
    .map(
      (p) => `${createHash("sha256").update(readFileSync(p)).digest("hex")}  ${relative(root, p)}`,
    );
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

// A held-out Qodo PR, so qodo_scores' held-out block (the committed set) has one PR to count.
const QURL = (
  JSON.parse(readFileSync(join(AACR, "sets", "qodo-heldout31.json"), "utf8")) as {
    cases: { pr_url: string }[];
  }
).cases[0]!.pr_url;
const LABEL = "my-judge";
const PUB = "judge-a"; // the arm's published AACR judge (arms.judge)
const EXT = "gpt-6.1-sol"; // the published Martian and Qodo judge
const ARM = "acme-review";
const MW = { work_dir: "w-martian", tool: "acme" };
const QW = { work_dir: "w-qodo", tool: "acme" };
const SPECS = {
  [LABEL]: {
    aacr_arms: [ARM],
    martian_runs: [["w-martian", "acme"]],
    qodo_runs: [["w-qodo", "acme"]],
  },
};

/** The published tables (data/) and a second judge's folder of exactly the published judge's rows. */
function dataset(root: string): void {
  const data = join(root, "data");
  jsonl(data, "prs", [
    { instance_id: "p1", key_version: 2 },
    { instance_id: "p2", key_version: 2 },
  ]);
  jsonl(data, "arms", [{ arm_id: ARM, judge: PUB, runs: ["r"] }]);
  jsonl(data, "defects", [
    { instance_id: "p1", defect_id: "d1", severity: "high" },
    { instance_id: "p2", defect_id: "d1", severity: "low" },
    { instance_id: "p2", defect_id: "d2", severity: "medium" },
  ]);
  const review = (instance_id: string) => ({
    arm_id: ARM,
    instance_id,
    judged: true,
    judged_by: [PUB],
    comments: [{ id: "C1" }],
    n_comments: 1,
    cost_usd: 1,
    minutes: 1,
    run: "r",
    status: "ok",
  });
  jsonl(data, "reviews", [review("p1"), review("p2")]);
  const dv = (instance_id: string, defect_id: string, verdict: string, judge: string) => ({
    arm_id: ARM,
    judge,
    instance_id,
    defect_id,
    verdict,
    credit: { found: 1, partial: 0.5, missed: 0 }[verdict],
  });
  // p2/d2 has a row of another judge only: the published judge has no verdict on it
  jsonl(data, "defect_verdicts", [
    dv("p1", "d1", "found", PUB),
    dv("p2", "d1", "missed", PUB),
    dv("p2", "d2", "found", "other-judge"),
  ]);
  const cv = (instance_id: string, grade: string, judge: string) => ({
    arm_id: ARM,
    judge,
    instance_id,
    comment_id: "C1",
    grade,
    defect_id: null,
    new_defect: false,
  });
  jsonl(data, "comment_verdicts", [cv("p1", "correct-valuable", PUB), cv("p2", "incorrect", PUB)]);
  jsonl(data, "martian_goldens", [
    { pr_url: "m1", golden_index: 0, category: "bug", audit_bucket: "real", comment: "g0" },
    { pr_url: "m1", golden_index: 1, category: "style", audit_bucket: "real", comment: "g1" },
  ]);
  jsonl(data, "martian_reviews", [{ ...MW, judge: EXT, pr_url: "m1", fp: 2 }]);
  jsonl(data, "martian_verdicts", [
    { ...MW, judge: EXT, pr_url: "m1", golden_index: 0, matched: true },
    { ...MW, judge: EXT, pr_url: "m1", golden_index: 1, matched: false },
  ]);
  jsonl(data, "martian_scores", []);
  jsonl(data, "qodo_issues", [
    {
      pr_url: QURL,
      issue_index: 0,
      functional: true,
      file_path: "a.py",
      start_line: 10,
      end_line: 12,
    },
  ]);
  jsonl(data, "qodo_reviews", [
    {
      ...QW,
      pr_url: QURL,
      comments: [{ index: 0, path: "a.py", start: 11, end: 11, body: "c0" }],
      n_comments: 1,
      cost_usd: null,
      minutes: null,
    },
  ]);
  jsonl(data, "qodo_verdicts", [
    {
      ...QW,
      judge: EXT,
      pr_url: QURL,
      issue_index: 0,
      matched: false,
      comment_index: null,
      located_n5: false,
      located_same_file: false,
    },
  ]);

  const v = join(root, "second_judges", LABEL);
  const why = { why: "the judge's reason" };
  // the release's columns: no credit (the scorer takes it from the verdict)
  const mine = (instance_id: string, defect_id: string, verdict: string) => {
    const { credit: _credit, ...row } = dv(instance_id, defect_id, verdict, LABEL);
    return { ...row, ...why };
  };
  jsonl(join(v, "aacr"), "defect_verdicts", [mine("p1", "d1", "found"), mine("p2", "d1", "found")]);
  jsonl(join(v, "aacr"), "comment_verdicts", [
    { ...cv("p1", "correct-minor", LABEL), ...why },
    { ...cv("p2", "incorrect", LABEL), ...why },
  ]);
  const judgement = (instance_id: string) => ({
    judge: LABEL,
    arm_id: ARM,
    instance_id,
    model: LABEL,
    effort_requested: "high",
    effort_used: "high",
    ok: true,
    attempts: 1,
    finish: "stop",
    prompt_tokens: 10,
    completion_tokens: 5,
    usd: 0.01,
    error: null,
    no_tools_system_line: true,
    prompt_sha256: "0".repeat(64),
  });
  // p1: asked at high, answered at low (the next attempt after a cap); p2: the second run, asked at low
  jsonl(join(v, "aacr"), "judgements", [
    { ...judgement("p1"), effort_used: "low" },
    { ...judgement("p2"), effort_requested: "low", effort_used: "low" },
  ]);
  jsonl(join(v, "martian"), "martian_verdicts", [
    { ...MW, pr_url: "m1", golden_index: 0, matched: true, judge: LABEL },
    { ...MW, pr_url: "m1", golden_index: 1, matched: true, judge: LABEL },
  ]);
  jsonl(join(v, "martian"), "martian_reviews", [{ ...MW, pr_url: "m1", fp: 1, judge: LABEL }]);
  jsonl(join(v, "qodo"), "qodo_verdicts", [
    { ...QW, pr_url: QURL, issue_index: 0, matched: true, comment_index: 0, judge: LABEL },
  ]);
  writeFileSync(join(v, "README.md"), "# A second judge\n");
  mkdirSync(join(v, "code"), { recursive: true });
  writeFileSync(join(v, "code", "judge.py"), "# data, never run\n");
  // scores/: the folder README's commands, run as second_judges.reproduce runs them
  mkdirSync(join(v, "scores"), { recursive: true });
  const score = (part: string, script: string, ...extra: string[]) =>
    writeFileSync(
      join(v, "scores", `${part}.txt`),
      execFileSync("python3", [
        "-I",
        join(RECOMPUTE, script),
        "--data",
        root,
        "--verdicts",
        join(v, part),
        "--judge",
        LABEL,
        ...extra,
        "--json",
        join(v, "scores", `${part}.json`),
      ]),
    );
  score("aacr", "score_verdicts.py", "--arms", ARM);
  score("martian", "martian_scores.py");
  score("qodo", "qodo_scores.py");
}

const BASE = join(tmp, "base");
dataset(BASE);
const MANIFEST = manifest(BASE, join(tmp, "second-judges.sha256"));

/** A copy of the base dataset, changed by `edit` (the manifest stays the base's unless re-made). */
function variant(name: string, edit: (root: string) => void): string {
  const root = join(tmp, name);
  cpSync(BASE, root, { recursive: true });
  edit(root);
  return root;
}

type Check = { check: string; ok: boolean; got: unknown; want: unknown };

function checks(root: string, man = MANIFEST): Check[] {
  return py(
    `import second_judges as SJ\nprint(json.dumps(SJ.checks(sys.argv[1], sys.argv[2], ${JSON.stringify(SPECS)}), default=str))`,
    root,
    man,
  ) as Check[];
}

function failing(cs: Check[]): string[] {
  return cs.filter((c) => !c.ok).map((c) => c.check.replace(`second_judges/${LABEL}: `, ""));
}

describe("second_judges: the manifest", () => {
  // MUTATION: in second_judges.manifest_problems, return no "extra" list (only missing and differs) — this fails
  // MUTATION: in hf_export.refuse_second_judges, return before the manifest check — this fails
  it("refuses a folder with a file missing, extra or changed, before anything is copied", () => {
    const extra = variant("extra", (r) =>
      writeFileSync(join(r, "second_judges", LABEL, "notes.md"), "x\n"),
    );
    const changed = variant("changed", (r) =>
      appendFileSync(join(r, "second_judges", LABEL, "README.md"), " "),
    );
    const missing = variant("missing", (r) =>
      rmSync(join(r, "second_judges", LABEL, "code", "judge.py")),
    );
    const copy = (root: string, out: string) =>
      py(
        `import hf_export as h
try:
    h.copy_second_judges(sys.argv[1], sys.argv[2], sys.argv[3]); print(json.dumps("copied"))
except SystemExit as e:
    print(json.dumps(str(e)))`,
        join(root, "second_judges"),
        out,
        MANIFEST,
      ) as string;
    const out = join(tmp, "copy-out");
    mkdirSync(out, { recursive: true });
    expect(copy(extra, out)).toMatch(
      new RegExp(`not the committed manifest's .*extra \\['second_judges/${LABEL}/notes.md'\\]`),
    );
    expect(copy(changed, out)).toMatch(/differs \['second_judges\/my-judge\/README.md'\]/);
    expect(copy(missing, out)).toMatch(/missing \['second_judges\/my-judge\/code\/judge.py'\]/);
    expect(existsSync(join(out, "second_judges"))).toBe(false);
    expect(copy(BASE, out)).toBe("copied");
    expect(readFileSync(join(out, "second_judges", LABEL, "README.md"), "utf8")).toBe(
      "# A second judge\n",
    );
    expect(failing(checks(extra))).toEqual([
      "second_judges: every file is the committed manifest's (bench/aacr/hf/second-judges.sha256), none missing, extra or differing",
    ]);
  });

  // MUTATION: in second_judges.checks, iterate the labels on disk instead of labels_of(manifest) — this fails
  it("fails every check of a label whose folder is not in the dataset (fails closed)", () => {
    const gone = variant("gone", (r) => rmSync(join(r, "second_judges"), { recursive: true }));
    const cs = checks(gone);
    expect(cs).toHaveLength(9);
    expect(cs.filter((c) => c.ok)).toEqual([]);
  });

  it("the committed manifest is the release folder's, one label, every file under it", () => {
    const m = py(
      "import second_judges as SJ\nm = SJ.read_manifest()\nprint(json.dumps([SJ.labels_of(m), sorted({p.split('/')[2] for p in m})]))",
    ) as [string[], string[]];
    expect(m[0]).toEqual(
      Object.keys(py("import second_judges as SJ\nprint(json.dumps(SJ.SPECS))") as object),
    );
    expect(m[1]).toEqual(["README.md", "aacr", "code", "martian", "qodo", "scores"]);
  });
});

describe("second_judges: validation.json's checks", () => {
  it("passes all nine on a folder that is the manifest's, covers the published rows and reproduces its scores", () => {
    const cs = checks(BASE);
    expect(cs).toHaveLength(9);
    expect(failing(cs)).toEqual([]);
  });

  // MUTATION: in second_judges.checks, accept a table whose judge values include the label (`label in v`) — this fails
  it("fails a verdict table whose judge column names another label, or a label a published row carries", () => {
    const other = variant("other-label", (r) =>
      jsonl(join(r, "second_judges", LABEL, "martian"), "martian_verdicts", [
        { ...MW, pr_url: "m1", golden_index: 0, matched: true, judge: LABEL },
        { ...MW, pr_url: "m1", golden_index: 1, matched: true, judge: "someone-else" },
      ]),
    );
    expect(failing(checks(other, manifest(other, join(other, "m.sha256"))))).toContain(
      "every verdict table's judge column is the label alone, and no published row carries it",
    );
    const used = variant("used-label", (r) =>
      appendFileSync(
        join(r, "data", "qodo_verdicts.jsonl"),
        JSON.stringify({ ...QW, judge: LABEL, pr_url: "q9", issue_index: 0, matched: false }) +
          "\n",
      ),
    );
    const got = checks(used).find((c) => c.check.includes("judge column"))!;
    expect(got.got).toEqual({ tables: {}, published_tables_with_label: ["qodo_verdicts"] });
  });

  // MUTATION: in second_judges.coverage, read the published AACR rows of every judge (drop the arms.judge filter) — this fails
  // MUTATION: in second_judges._cover, drop the "repeated" count — this fails
  it("fails a row missing, repeated or outside the named arms, and counts only the published judge's rows", () => {
    const v = (r: string) => join(r, "second_judges", LABEL, "aacr");
    const rows = (r: string, t: string) =>
      readFileSync(join(v(r), `${t}.jsonl`), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    const bad = variant("coverage", (r) => {
      const dv = rows(r, "defect_verdicts");
      jsonl(v(r), "defect_verdicts", [dv[0]!, dv[0]!, { ...dv[1]!, arm_id: "not-named" }]);
      jsonl(v(r), "judgements", rows(r, "judgements").slice(0, 1));
    });
    const cs = checks(bad, manifest(bad, join(bad, "m.sha256")));
    const aacr = cs.find((c) => c.check.includes("AACR-Bench rows"))!;
    expect(aacr.ok).toBe(false);
    expect(aacr.got).toEqual({
      defect_verdicts: { missing: 1, extra: 1, repeated: 1 },
      comment_verdicts: { missing: 0, extra: 0, repeated: 0 },
      judgements: { missing: 1, extra: 0, repeated: 0 },
    });
    // the base folder has no row for p2/d2, which only another judge published: nothing is missing
    expect(checks(BASE).find((c) => c.check.includes("AACR-Bench rows"))!.ok).toBe(true);
    const q = variant("coverage-q", (r) =>
      jsonl(join(r, "second_judges", LABEL, "qodo"), "qodo_verdicts", []),
    );
    expect(
      checks(q, manifest(q, join(q, "m.sha256"))).find((c) => c.check.includes("Qodo rows"))!.got,
    ).toEqual({ qodo_verdicts: { missing: 1, extra: 0, repeated: 0 } });
  });

  // MUTATION: in second_judges.reproduce, compare scores/<part>.txt with the scorer's stdout after .strip() on both — this fails
  // MUTATION: in second_judges.reproduce, skip the scores/<part>.json comparison — this fails
  it("fails a scores/ file the scorers do not reproduce: a .txt by one byte, a .json by one value", () => {
    const s = (r: string, f: string) => join(r, "second_judges", LABEL, "scores", f);
    const bad = variant("scores", (r) => {
      appendFileSync(s(r, "aacr.txt"), " ");
      const j = JSON.parse(readFileSync(s(r, "martian.json"), "utf8")) as {
        runs: Record<string, Record<string, Record<string, number>>>;
      };
      j.runs["w-martian|acme"]![LABEL]!.core_tp = 9;
      writeFileSync(s(r, "martian.json"), JSON.stringify(j, null, 1));
      // the same object, its keys in another order: still reproduced
      const q = JSON.parse(readFileSync(s(r, "qodo.json"), "utf8")) as Record<string, unknown>;
      writeFileSync(
        s(r, "qodo.json"),
        JSON.stringify(Object.fromEntries(Object.entries(q).reverse()), null, 2),
      );
    });
    const cs = checks(bad, manifest(bad, join(bad, "m.sha256")));
    expect(failing(cs)).toEqual([
      "score_verdicts.py on the folder reproduces scores/aacr.json (as an object) and scores/aacr.txt (byte for byte)",
      "martian_scores.py on the folder reproduces scores/martian.json (as an object) and scores/martian.txt (byte for byte)",
    ]);
    expect(cs.find((c) => c.check.includes("score_verdicts"))!.got).toEqual([
      "scores/aacr.txt differs from the scorer's output",
    ]);
  });

  // MUTATION: in second_judges.checks, pass a table that has every listed column (set(want) <= set(c)) — this fails
  it("fails a verdict table carrying a column it does not list (a comment's text)", () => {
    const bad = variant("columns", (r) =>
      jsonl(join(r, "second_judges", LABEL, "qodo"), "qodo_verdicts", [
        {
          ...QW,
          pr_url: QURL,
          issue_index: 0,
          matched: true,
          comment_index: 0,
          judge: LABEL,
          body: "c0",
        },
      ]),
    );
    const c = checks(bad, manifest(bad, join(bad, "m.sha256"))).find((x) =>
      x.check.includes("listed columns"),
    )!;
    expect(c.ok).toBe(false);
    expect(Object.keys(c.got as object)).toEqual(["qodo/qodo_verdicts"]);
  });
});

describe("second_judges: the claims verifier", () => {
  // MUTATION: in claim_metrics.SecondJudge, read an aacr metric from the arm's published judge's column (row[row["reference_judge"]]) — this fails
  // MUTATION: in claim_metrics.SecondJudge, count Martian over the published judge's rows (label -> "gpt-6.1-sol") — this fails
  // MUTATION: in claim_metrics.SecondJudge, count effort_used=E from the effort_requested column — this fails
  // MUTATION: in claim_metrics.SecondJudge, count every review of the run as `empty` (drop the n_comments test) — this fails
  it("gives the second judge's numbers by label, through the scorers, beside the published judge's", () => {
    const got = py(
      `import claim_metrics as M
t = M.Tables(sys.argv[1] + "/data")
sj, a = M.PROVIDERS["second_judge"](t), M.PROVIDERS["aacr"](t)
L = "${LABEL}"
keys = [L + "/aacr/${ARM}:found", L + "/aacr/${ARM}:recall", L + "/aacr/${ARM}:correct", L + "/aacr/${ARM}:pct",
        L + "/aacr/${ARM}:c_pct", L + "/martian/w-martian|acme:core_recall", L + "/martian/w-martian|acme:core_precision",
        L + "/qodo/w-qodo|acme:recall", L + "/qodo/w-qodo|acme:precision"]
keys += [L + "/aacr/judgements:rows", L + "/aacr/judgements:usd", L + "/aacr/judgements:effort_used=high",
         L + "/aacr/judgements:effort_used=low", L + "/aacr/judgements:effort_requested=low",
         L + "/qodo/w-qodo|acme:empty"]
out = {k: sj.value(k) for k in keys}
out["published found"] = a.value("${ARM}:found")
try:
    sj.value(L + "/aacr/not-an-arm:found")
except M.KeyError_ as e:
    out["unknown arm"] = str(e)
print(json.dumps(out))`,
      BASE,
    ) as Record<string, number | string>;
    // mine: p1/d1 and p2/d1 found, p2/d2 no row (2 of 3); the published judge: p1/d1 found (1 of 3).
    // Pairs: p1/d1 agree, p2/d1 differ, p2/d2 missed by both; comments: p1 differs, p2 agrees.
    expect(got[`${LABEL}/aacr/${ARM}:recall`]).toBeCloseTo(200 / 3);
    expect(got[`${LABEL}/aacr/${ARM}:pct`]).toBeCloseTo(200 / 3);
    delete got[`${LABEL}/aacr/${ARM}:recall`];
    delete got[`${LABEL}/aacr/${ARM}:pct`];
    expect(got).toEqual({
      [`${LABEL}/aacr/${ARM}:found`]: 2,
      [`${LABEL}/aacr/${ARM}:correct`]: 50,
      [`${LABEL}/aacr/${ARM}:c_pct`]: 50,
      [`${LABEL}/martian/w-martian|acme:core_recall`]: 100,
      [`${LABEL}/martian/w-martian|acme:core_precision`]: 50,
      [`${LABEL}/qodo/w-qodo|acme:recall`]: 100,
      [`${LABEL}/qodo/w-qodo|acme:precision`]: 100,
      [`${LABEL}/aacr/judgements:rows`]: 2,
      [`${LABEL}/aacr/judgements:usd`]: 0.02,
      [`${LABEL}/aacr/judgements:effort_used=high`]: 0,
      [`${LABEL}/aacr/judgements:effort_used=low`]: 2,
      [`${LABEL}/aacr/judgements:effort_requested=low`]: 1,
      [`${LABEL}/qodo/w-qodo|acme:empty`]: 0,
      "published found": 1,
      "unknown arm": `no ${LABEL} verdicts for arm 'not-an-arm'`,
    });
  });

  // MUTATION: in verify_claims.discover, never set found["second_judges"] — this fails
  // MUTATION: in verify_claims.consistency, give the second judges' checks needs [] — this fails
  it("finds the folder beside the tables, passes a claim reading it, and skips it under --partial without it", () => {
    const repo = join(tmp, "claims-repo");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "PAGE.md"), "The second judge finds 67% where ours finds 1.\n");
    const claim = (id: string, value: string, q: string) => ({
      id,
      file: "PAGE.md",
      anchor: "The second judge finds",
      value,
      q,
    });
    const m = join(repo, "claims.json");
    writeFileSync(
      m,
      JSON.stringify({
        schema: "quickreview-claims/1",
        about_tolerance: 0.1,
        version_patterns: [],
        files: { "PAGE.md": { lint: "complete" } },
        checks: {
          aacr: { kind: "tables", provider: "aacr", needs: "hf", scripts: [] },
          second_judge: {
            kind: "tables",
            provider: "second_judge",
            needs: "hf+second_judges",
            scripts: [],
          },
        },
        groups: {},
        claims: [
          claim("sj", "67%", `second_judge:${LABEL}/aacr/${ARM}:recall`),
          claim("pub", "1", `aacr:${ARM}:found`),
        ],
        not_claims: [],
      }),
    );
    const verify = (data: string, ...extra: string[]) => {
      const p = spawnSync(
        "python3",
        [
          "-I",
          join(AACR, "verify_claims.py"),
          "--manifest",
          m,
          "--repo",
          repo,
          "--data",
          data,
          "--work",
          join(tmp, `vc-${relative(tmp, data).replace(/\W/g, "-")}`),
          "--no-validation",
          ...extra,
        ],
        { encoding: "utf8" },
      );
      return { code: p.status, out: `${p.stdout}\n${p.stderr}` };
    };
    const full = verify(BASE);
    expect(full.out).toContain(`second_judges=${join(BASE, "second_judges")}`);
    expect(full.out).toContain("claims: {'pass': 2}");
    expect(full.code).toBe(0);
    const tablesOnly = variant("tables-only", (r) =>
      rmSync(join(r, "second_judges"), { recursive: true }),
    );
    const partial = verify(tablesOnly, "--partial");
    expect(partial.out).toContain("SKIPPED x1: needs second_judges in --data (--partial)");
    expect(partial.code).toBe(0);
    expect(verify(tablesOnly).code).toBe(1);
    const needs = py(
      `import verify_claims as V
a = types.SimpleNamespace(work=sys.argv[2], martian=None, qodo_gt=None, no_validation=False)
found = V.discover([sys.argv[1]])
src = V.Sources(a, {"checks": {}}, found)
print(json.dumps([[c["source"], c["needs"], c["ok"]] for c in V.consistency(a, found, src) if c["needs"]]))`,
      BASE,
      join(tmp, "consistency"),
    ) as [string, string[], boolean][];
    // the fixture's folder is not the committed manifest's (another label), so all nine fail here: what
    // matters is that they run on a download and carry what they need
    expect(needs).toHaveLength(9);
    expect(
      needs.every(([s, n]) => s === "hf_export.validate" && n.join() === "second_judges"),
    ).toBe(true);
  });
});

describe("second_judges: the card", () => {
  // MUTATION: in hf_export.card_values, render SECOND_JUDGE_FILES from nothing (always the pending marker) — this fails
  it("lists the folder's verdict tables with their rows, and says so when the build has none", () => {
    const card = py(
      `import hf_export as h, second_judges as SJ, collections
a = types.SimpleNamespace(repo_id="acme/bench")
v = lambda sj: h.fill_card(open(sys.argv[2]).read(), h.card_values(a, {n: 1 for n in h.CONFIGS}, [{"ok": True}],
                                                                   collections.Counter(), [], None, sj))
print(json.dumps([v(SJ.file_rows(sys.argv[1])), v([])]))`,
      BASE,
      join(AACR, "hf", "card.md"),
    ) as [string, string];
    expect(card[0]).toContain(
      `| File | Rows |\n|---|---:|\n| \`second_judges/${LABEL}/aacr/defect_verdicts.jsonl\` | 2 |`,
    );
    expect(card[0]).toContain(`| \`second_judges/${LABEL}/qodo/qodo_verdicts.jsonl\` | 1 |`);
    expect(card[1]).toContain("`<second_judges/ not in this build>`");
  });

  // MUTATION: in hf_export.second_judge_links, link `{SJ.FOLDER}/{x}` as a relative path (drop `{url}/tree/main/`) — this fails
  // MUTATION: in hf_export.card_values, render SECOND_JUDGE_MD from nothing (second_judge_links([], url)) — this fails
  it("links each judge's folder in this dataset where the card says what it holds, pending without one", () => {
    const card = py(
      `import hf_export as h, second_judges as SJ, collections
a = types.SimpleNamespace(repo_id="acme/bench")
v = lambda sj: h.fill_card(open(sys.argv[2]).read(), h.card_values(a, {n: 1 for n in h.CONFIGS}, [{"ok": True}],
                                                                   collections.Counter(), [], None, sj))
print(json.dumps([v(SJ.file_rows(sys.argv[1])), v([])]))`,
      BASE,
      join(AACR, "hf", "card.md"),
    ) as [string, string];
    const link = `[\`second_judges/${LABEL}/\`](https://huggingface.co/datasets/acme/bench/tree/main/second_judges/${LABEL})`;
    // the top of the card, where it lists the dataset's parts, and the section of its own
    expect(card[0]).toContain(`Beside them, ${link} holds a second judge's verdicts`);
    expect(card[0]).toContain(`## Second judge\n\n${link} holds`);
    expect(card[1]).toContain("Beside them, `<second_judges/ not in this build>` holds");
    expect(card[1]).not.toContain("tree/main/second_judges");
  });

  // MUTATION: in hf_export.verify_result, count the second judges' checks with the slim bundle's (drop `folder`) — this fails
  it("counts the second judges' checks with validation.json's, apart from the tables alone", () => {
    const report = join(tmp, "vc.json");
    const check = (needs: string[]) => ({ ok: true, needs });
    writeFileSync(
      report,
      JSON.stringify({
        results: [{ status: "pass" }],
        consistency: [
          ...Array(3).fill(check([])),
          ...Array(2).fill(check(["second_judges"])),
          check(["slim"]),
          check(["slim", "--martian"]),
        ],
      }),
    );
    const got = py(
      `import hf_export as h\nprint(json.dumps(h.verify_result(sys.argv[1])))`,
      report,
    );
    expect(got).toContain(
      "The release's own checks pass 7 of 7: 5 from `validation.json`, re-run on the dataset (3 on the " +
        "tables and 2 on its `second_judges/` folder), and 2 the slim bundle's. `--partial` without " +
        "`--martian` and `--qodo-gt` re-runs 6 of them (the slim bundle's Martian and Qodo re-scores need " +
        "those inputs), and with the tables alone the 3 from `validation.json`.",
    );
  });
});

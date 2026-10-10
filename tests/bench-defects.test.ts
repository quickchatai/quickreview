import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { parseCaseSet } from "../src/bench/aacr.js";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  judgePrompt,
  lastJsonObject,
  parseDefectSet,
  parseJudgement,
  renderDefectReport,
  reviewForJudge,
  reviewHash,
  scoreRun,
  scoreExitCode,
  type CaseJudgement,
  type Defect,
  type ReviewForJudge,
} from "../src/bench/defects.js";
import {
  judgeCase,
  judgeLabel,
  loadJudgements,
  readJudgeEvents,
} from "../src/bench/defectjudge.js";
import { judgePiArgv, runJudgeSession } from "../src/bench/runner.js";
import { caseCostUsd, caseTokenCounts } from "../src/bench/cost.js";

const D = (id: string, severity: "high" | "medium" | "low" = "high"): Defect => ({
  id,
  title: `defect ${id}`,
  statement: `what ${id} breaks`,
  sites: [{ path: "a.py", from_line: 10, to_line: 12, role: "cause" }],
  kind: "bug",
  severity,
  evidence: "a.py:10",
});

const SET = {
  set: "t",
  version: "1",
  method: "test",
  cases: {
    "o__r@1234567": {
      instance_id: "o__r@1234567",
      pr_summary: "x",
      defects: [D("D1", "high"), D("D2", "low")],
    },
    "o__s@7654321": { instance_id: "o__s@7654321", pr_summary: "y", defects: [] },
  },
};

const REVIEW: ReviewForJudge = {
  verdict: "APPROVE",
  body: null,
  comments: [
    { id: "C1", path: "a.py", line: 11, end_line: 11, tag: "blocker", text: "finds D1" },
    { id: "C2", path: "b.py", line: 3, end_line: 3, tag: "nit", text: "a nit" },
  ],
};

describe("defect sets", () => {
  it("parse, normalise reversed sites, and refuse what a judge could not use", () => {
    const s = parseDefectSet({
      ...SET,
      cases: { x: { defects: [{ ...D("D1"), sites: [{ path: "a", from_line: 9, to_line: 3 }] }] } },
    });
    expect(s.cases["x"]!.defects[0]!.sites[0]).toEqual({ path: "a", from_line: 3, to_line: 9 });
    expect(() => parseDefectSet({ ...SET, cases: { x: { defects: [D("D1"), D("D1")] } } })).toThrow(
      /duplicate/,
    );
    expect(() =>
      parseDefectSet({ ...SET, cases: { x: { defects: [{ ...D("D1"), severity: "urgent" }] } } }),
    ).toThrow(/severity/);
    expect(() =>
      parseDefectSet({ ...SET, cases: { x: { defects: [{ ...D("D1"), sites: [] }] } } }),
    ).toThrow(/no site/);
    expect(() => parseDefectSet({ ...SET, version: "" })).toThrow(/version/);
  });
});

describe("the review as the author received it", () => {
  it("reads either arm's run dir: tags and footers stripped, verdict and body when present", () => {
    const run = mkdtempSync(join(tmpdir(), "defects-run-"));
    mkdirSync(join(run, "results", "all"), { recursive: true });
    mkdirSync(join(run, "cases", "o__r@1234567"), { recursive: true });
    writeFileSync(
      join(run, "results", "all", "o__r@1234567.json"),
      JSON.stringify({
        review: {
          comments: [
            {
              path: "a.py",
              start_line: 11,
              end_line: 12,
              content: "[blocker] It breaks\n\n_P1 · confidence 0.9 · lens pass-baseline_",
            },
            { path: "b.py", start_line: 3, end_line: 3, content: "plain OCR-style comment" },
            { path: "c.py", start_line: 1, content: "   " },
          ],
        },
      }),
    );
    writeFileSync(
      join(run, "cases", "o__r@1234567", "case-summary.json"),
      JSON.stringify({ verdict: "REQUEST_CHANGES" }),
    );
    writeFileSync(join(run, "cases", "o__r@1234567", "review.md"), "The body.\n");
    const r = reviewForJudge(run, "o__r@1234567");
    expect(r.verdict).toBe("REQUEST_CHANGES");
    expect(r.body).toBe("The body.");
    expect(r.comments).toEqual([
      { id: "C1", path: "a.py", line: 11, end_line: 12, tag: "blocker", text: "It breaks" },
      { id: "C2", path: "b.py", line: 3, end_line: 3, tag: null, text: "plain OCR-style comment" },
    ]);
    // A comment on a DELETED line (outside the AACR-scored file) is part of
    // the review: appended last, so the other ids never shift.
    writeFileSync(
      join(run, "cases", "o__r@1234567", "comments.json"),
      JSON.stringify([
        { path: "a.py", line: 11, side: "RIGHT", body: "[blocker] It breaks" },
        { path: "old.py", line: 4, side: "LEFT", body: "[nit] The removed guard mattered" },
      ]),
    );
    expect(reviewForJudge(run, "o__r@1234567").comments[2]).toEqual({
      id: "C3",
      path: "old.py (deleted line)",
      line: 4,
      end_line: 4,
      tag: "nit",
      text: "The removed guard mattered",
    });
    // A case that produced nothing is an empty review, never an error.
    expect(reviewForJudge(run, "missing__case@0000000")).toEqual({
      verdict: null,
      body: null,
      comments: [],
    });
  });

  it("the prompt names every defect and comment by id, with sites and the counts-if note", () => {
    const p = judgePrompt(
      { instance_id: "o__r@1234567", repo: "o/r", title: "T", merge_base: "mb", head: "hd" },
      [{ ...D("D1"), notes: "must name the None return" }],
      REVIEW,
    );
    expect(p).toContain("D1 [high, bug] defect D1");
    expect(p).toContain("sites: a.py:10-12 (cause)");
    expect(p).toContain("counts if: must name the None return");
    expect(p).toContain("C1 [blocker] a.py:11\nfinds D1");
    expect(p).toContain("Verdict: APPROVE");
    expect(p).toMatch(/Never run project code/);
  });
});

describe("the judge sees the claims the ground truth already rejected", () => {
  it("lists them with their reasons, capped, and never offers them as new defects", () => {
    const pr = {
      instance_id: "o__r@1234567",
      repo: "o/r",
      title: "T",
      merge_base: "mb",
      head: "hd",
    };
    const p = judgePrompt(pr, [D("D1")], REVIEW, [
      { source: "ref 2", reason: "Pre-existing: the old code skipped the same path." },
      { source: "R7", reason: "x".repeat(2_000) },
    ]);
    expect(p).toContain("CLAIMS ALREADY CHECKED AGAINST THE CODE AND REJECTED");
    expect(p).toContain("- ref 2: Pre-existing: the old code skipped the same path.");
    expect(p).toContain(`- R7: ${"x".repeat(600)}…`);
    expect(p).not.toContain("x".repeat(601));
    expect(p).toMatch(/neither in the list nor among the rejected claims/);
    // No rejected claims: no section at all.
    expect(judgePrompt(pr, [D("D1")], REVIEW)).not.toContain("ALREADY CHECKED");
    // A very long list is cut, and says so.
    const many = Array.from({ length: 100 }, (_, i) => ({
      source: `R${i}`,
      reason: "y".repeat(500),
    }));
    const q = judgePrompt(pr, [D("D1")], REVIEW, many);
    expect(q).toMatch(/more rejected claims not shown/);
    expect(q.length).toBeLessThan(20_000);
  });

  it("the parser keeps a case's excluded list", () => {
    const s = parseDefectSet({
      ...SET,
      cases: { x: { defects: [], excluded: [{ source: "R1", reason: "wrong" }, { source: 3 }] } },
    });
    expect(s.cases["x"]!.excluded).toEqual([{ source: "R1", reason: "wrong" }]);
  });
});

describe("the judge's answer", () => {
  const good = {
    defects: [
      { id: "D1", verdict: "found", comments: ["C1", "C9"], why: "C1 says it" },
      { id: "D2", verdict: "missed", comments: [], why: "-" },
    ],
    comments: [
      { id: "C1", defect: "D1", verdict: "correct-valuable", new_defect: false, why: "a.py:10" },
      { id: "C2", defect: null, verdict: "correct-minor", new_defect: false, why: "b.py:3" },
    ],
  };

  it("takes the last JSON object, fenced or after prose, with braces inside strings", () => {
    expect(lastJsonObject('thinking {"a":1}\n```json\n{"b":"x}{y"}\n```\ndone')).toEqual({
      b: "x}{y",
    });
    expect(lastJsonObject("no json here")).toBeUndefined();
  });

  it("parses a complete answer and drops comment ids the review does not have", () => {
    const j = parseJudgement(JSON.stringify(good), SET.cases["o__r@1234567"].defects, REVIEW);
    expect(j.defects[0]).toEqual({
      id: "D1",
      verdict: "found",
      comments: ["C1"],
      why: "C1 says it",
    });
    expect(j.comments.map((c) => c.verdict)).toEqual(["correct-valuable", "correct-minor"]);
  });

  it("refuses an answer that skips, repeats or invents an id, or leaves the vocabulary", () => {
    const defects = SET.cases["o__r@1234567"].defects;
    const bad = (patch: object) => JSON.stringify({ ...good, ...patch });
    expect(() => parseJudgement(bad({ defects: [good.defects[0]] }), defects, REVIEW)).toThrow(
      /skips defect/,
    );
    expect(() => parseJudgement(bad({ comments: [good.comments[0]] }), defects, REVIEW)).toThrow(
      /skips comment/,
    );
    expect(() =>
      parseJudgement(bad({ defects: [...good.defects, good.defects[0]] }), defects, REVIEW),
    ).toThrow(/twice/);
    // A comment id the review does not have is ignored, not an error.
    expect(
      parseJudgement(
        bad({ comments: [...good.comments, { id: "C9", defect: null, verdict: "incorrect" }] }),
        defects,
        REVIEW,
      ).comments.map((c) => c.id),
    ).toEqual(["C1", "C2"]);
    expect(() =>
      parseJudgement(
        bad({ defects: [...good.defects, { id: "D9", verdict: "found" }] }),
        defects,
        REVIEW,
      ),
    ).toThrow(/unknown defect/);
    expect(() =>
      parseJudgement(
        bad({ defects: [{ ...good.defects[0], verdict: "sort-of" }, good.defects[1]] }),
        defects,
        REVIEW,
      ),
    ).toThrow(/verdict/);
    expect(() =>
      parseJudgement(
        bad({ comments: [good.comments[0], { ...good.comments[1], verdict: "fine" }] }),
        defects,
        REVIEW,
      ),
    ).toThrow(/verdict/);
    expect(() => parseJudgement("nothing", defects, REVIEW)).toThrow(/no JSON/);
  });
});

describe("scoring", () => {
  const J = (
    round: number,
    d1: "found" | "partial" | "missed",
    c2: string,
    extra: Partial<CaseJudgement> = {},
  ): CaseJudgement => ({
    instance_id: "o__r@1234567",
    round,
    defect_set_version: "1",
    model: "m",
    defects: [
      { id: "D1", verdict: d1, comments: d1 === "missed" ? [] : ["C1"], why: "" },
      { id: "D2", verdict: "missed", comments: [], why: "" },
    ],
    comments: [
      {
        id: "C1",
        defect: d1 === "missed" ? null : "D1",
        verdict: d1 === "missed" ? "incorrect" : "correct-valuable",
        new_defect: false,
        why: "",
      },
      {
        id: "C2",
        defect: null,
        verdict: c2 as never,
        new_defect: c2 === "correct-valuable",
        why: "new thing",
      },
    ],
    ...extra,
  });
  const set = parseDefectSet(SET);

  it("averages rounds per case; partial is half; weights high 3 / medium 2 / low 1", () => {
    const s = scoreRun(
      set,
      ["o__r@1234567"],
      { "o__r@1234567": [J(1, "found", "correct-minor"), J(2, "partial", "correct-minor")] },
      { "o__r@1234567": REVIEW },
    );
    expect(s.defects.total).toBe(2);
    expect(s.by_severity.high).toEqual({ total: 1, credit: 0.75, recall: 0.75 });
    expect(s.defects.recall).toBeCloseTo(0.375);
    expect(s.weighted_recall).toBeCloseTo((3 * 0.75) / 4);
    expect(s.comments["correct-valuable"]).toBe(1);
    expect(s.comments["correct-minor"]).toBe(1);
    expect(s.comments.correct_share).toBe(1);
    expect(s.approved_over_missed_high).toEqual([]);
  });

  it("an errored or unjudged case misses every defect and verifies nothing — it never leaves the denominator", () => {
    const err = { ...J(1, "found", "correct-minor"), error: "judge timed out" };
    const s = scoreRun(
      set,
      ["o__r@1234567", "o__s@7654321"],
      { "o__r@1234567": [err] },
      { "o__r@1234567": REVIEW },
    );
    expect(s.judged).toBe(0);
    expect(s.errors).toBe(1);
    expect(s.defects.missed).toBe(2);
    expect(s.comments.unverifiable).toBe(2);
  });

  it("a report over missing judgements exits 1, like one over judge errors", () => {
    // defect-report over a judge dir with no round for one case: no error
    // round exists, and defect-judge never ran to flag it incomplete.
    const s = scoreRun(
      set,
      ["o__r@1234567", "o__s@7654321"],
      { "o__r@1234567": [J(1, "found", "correct-minor")] },
      { "o__r@1234567": REVIEW },
    );
    expect(s.errors).toBe(0);
    expect(s.judged).toBe(1);
    expect(scoreExitCode(s, false)).toBe(1);
    const full = scoreRun(
      set,
      ["o__r@1234567"],
      { "o__r@1234567": [J(1, "found", "correct-minor")] },
      { "o__r@1234567": REVIEW },
    );
    expect(scoreExitCode(full, false)).toBe(0);
    expect(scoreExitCode(full, true)).toBe(1);
    expect(scoreExitCode({ ...full, errors: 1 }, false)).toBe(1);
  });

  it("a round that judged a different review is stale: never scored, and the run exits 1", () => {
    // `review --resume` rewrote the case's review, then `defect-report` ran
    // without re-judging: the old verdicts must not attach to the new comments
    // by their stable ids.
    const fresh = J(1, "found", "correct-minor", { review_hash: reviewHash(REVIEW) });
    const old = J(2, "missed", "incorrect", { review_hash: "0".repeat(64) });
    const s = scoreRun(
      set,
      ["o__r@1234567"],
      { "o__r@1234567": [fresh, old] },
      { "o__r@1234567": REVIEW },
    );
    expect(s.stale).toBe(1);
    expect(s.judged).toBe(1);
    expect(s.by_severity.high.credit).toBe(1);
    expect(scoreExitCode(s, false)).toBe(1);
    expect(renderDefectReport("t", set, s, {})).toMatch(/1 stale round/);
    // A legacy round (no stamp) stands while it judged exactly these comment ids.
    const { review_hash: _h, ...legacy } = fresh;
    const l = scoreRun(
      set,
      ["o__r@1234567"],
      { "o__r@1234567": [legacy] },
      { "o__r@1234567": REVIEW },
    );
    expect(l.stale).toBe(0);
    expect(l.judged).toBe(1);
    const gone = scoreRun(
      set,
      ["o__r@1234567"],
      { "o__r@1234567": [legacy] },
      { "o__r@1234567": { ...REVIEW, comments: [REVIEW.comments[0]!] } },
    );
    expect(gone.stale).toBe(1);
    expect(gone.judged).toBe(0);
  });

  it("a round that judged an earlier ground-truth version is stale, even over the same review", () => {
    // `defect-judge --label fresh10` ran against v1; the defect set was bumped
    // to v2 and `defect-report --label fresh10` reused the dir over the same
    // review: v1 verdicts must not attach to the revised defects by id.
    const v1 = J(1, "found", "correct-minor", {
      review_hash: reviewHash(REVIEW),
      defect_set_version: "0",
    });
    const s = scoreRun(set, ["o__r@1234567"], { "o__r@1234567": [v1] }, { "o__r@1234567": REVIEW });
    expect(s.stale).toBe(1);
    expect(s.judged).toBe(0);
    expect(scoreExitCode(s, false)).toBe(1);
  });

  it("scored under a judge model, a round another model wrote is stale, never averaged in", () => {
    // Three rounds by model A, then `--resume --model B` with one round over
    // the same `--label`: round 1 is re-judged, rounds 2–3 by A stay on disk.
    const b1 = J(1, "found", "correct-minor", { review_hash: reviewHash(REVIEW), model: "B" });
    const a2 = J(2, "missed", "correct-minor", { review_hash: reviewHash(REVIEW), model: "A" });
    const a3 = J(3, "missed", "correct-minor", { review_hash: reviewHash(REVIEW), model: "A" });
    const ids = ["o__r@1234567"];
    const by = { "o__r@1234567": [b1, a2, a3] };
    const s = scoreRun(set, ids, by, { "o__r@1234567": REVIEW }, "B");
    expect(s.stale).toBe(2);
    expect(s.judged).toBe(1);
    expect(s.by_severity.high.credit).toBe(1);
    expect(scoreExitCode(s, false)).toBe(1);
    // With no model named, every round stands, as before.
    const any = scoreRun(set, ids, by, { "o__r@1234567": REVIEW });
    expect(any.stale).toBe(0);
    expect(any.by_severity.high.credit).toBeCloseTo(1 / 3);
  });

  it("counts wrong blockers, approvals over a missed high defect, and new-defect candidates once", () => {
    const s = scoreRun(
      set,
      ["o__r@1234567"],
      { "o__r@1234567": [J(1, "missed", "correct-valuable"), J(2, "missed", "correct-valuable")] },
      { "o__r@1234567": REVIEW },
    );
    expect(s.comments.wrong_blockers).toBe(1);
    expect(s.approved_over_missed_high).toEqual(["o__r@1234567"]);
    expect(s.new_defect_candidates).toEqual([
      { instance_id: "o__r@1234567", comment: "C2", why: "new thing" },
    ]);
    const md = renderDefectReport("t", set, s, {
      tokensInPerPr: 1_000_000,
      tokensOutPerPr: 15_000,
      medianMinPerPr: 5,
    });
    expect(md).toContain("## Did the review find the real defects?");
    expect(md).toContain("| 2 | 0 | 0 | 2 | 0% | 0% |");
    expect(md).toContain("Approved despite a missed high-severity defect: o__r@1234567");
    expect(md).toContain("| 1000k | 15.0k | 5.0 |");
  });
});

describe("the judge session", () => {
  it("is read-only: only read and bash, bash behind the no-exec guard, no project files, no session", () => {
    const argv = judgePiArgv("/opt/quickreview/sandbox", "openai-codex/gpt-6-sol:high");
    expect(argv).toEqual(
      expect.arrayContaining([
        "-p",
        "--no-session",
        "--no-approve",
        "--no-extensions",
        "--no-context-files",
      ]),
    );
    expect(argv[argv.indexOf("--tools") + 1]).toBe("read,bash");
    expect(argv[argv.indexOf("--extension") + 1]).toBe(
      "/opt/quickreview/sandbox/extensions/bash-guard.ts",
    );
    expect(argv.filter((a) => a === "--extension")).toHaveLength(1);
    expect(judgeLabel("3", "openai-codex/gpt-6-sol:high")).toBe("v3-gpt-6-sol-high");
  });

  it("writes one file per round, records a bad answer as an error, and resumes only what is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "defects-judge-"));
    const answer = JSON.stringify({
      defects: [
        { id: "D1", verdict: "found", comments: ["C1"], why: "x" },
        { id: "D2", verdict: "missed", comments: [], why: "y" },
      ],
      comments: [
        { id: "C1", defect: "D1", verdict: "correct-valuable", new_defect: false, why: "z" },
        { id: "C2", defect: null, verdict: "correct-minor", new_defect: false, why: "w" },
      ],
    });
    mkdirSync(join(dir, "bin"));
    const fake = join(dir, "bin", "pi");
    const counter = join(dir, "calls");
    // Round 1 answers well; any later call answers garbage.
    writeFileSync(
      fake,
      `#!/bin/sh\ncat >/dev/null\nn=$(cat ${counter} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${counter}\n` +
        `if [ "$n" = 1 ]; then printf '%s\\n' '${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: answer }], usage: { input: 10, output: 5, cacheRead: 2 } } }).replace(/'/g, "'\\''")}'; ` +
        `else printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"no idea"}]}}'; fi\n`,
    );
    chmodSync(fake, 0o755);
    const common = {
      pr: { instance_id: "o__r@1234567", repo: "o/r", title: "T", merge_base: "mb", head: "hd" },
      defects: SET.cases["o__r@1234567"].defects,
      review: REVIEW,
      outDir: join(dir, "judge"),
      defectSetVersion: "1",
      log: () => {},
      pi: {
        root: "/x",
        cwd: dir,
        model: "m",
        // The judge spawns `pi` from the env PATH: the fake stands first.
        env: { PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}` },
        timeoutMs: 10_000,
      },
    };
    const js = await judgeCase({ ...common, rounds: 2, resume: false });
    expect(js[0]!.error).toBeUndefined();
    expect(js[0]!.usage).toEqual({ input: 10, output: 5, cacheRead: 2 });
    expect(js[1]!.error).toMatch(/no JSON/);
    expect(existsSync(join(dir, "judge", "o__r@1234567.r2.answer.txt"))).toBe(true);
    // Resume keeps the good round 1 and re-asks only the errored round 2.
    const again = await judgeCase({ ...common, rounds: 2, resume: true });
    expect(readFileSync(counter, "utf8").trim()).toBe("3");
    expect(again[0]!.defects[0]!.verdict).toBe("found");
    expect(Object.keys(loadJudgements(join(dir, "judge")))).toEqual(["o__r@1234567"]);
    // The review was re-run in the same run dir (`review --resume`): a saved
    // round judged the OLD review, so resume re-asks both rather than scoring
    // the old verdicts against the new comment ids.
    const rerun = await judgeCase({
      ...common,
      review: { ...REVIEW, comments: [{ ...REVIEW.comments[0]!, text: "different words" }] },
      rounds: 2,
      resume: true,
    });
    expect(readFileSync(counter, "utf8").trim()).toBe("5");
    expect(rerun[0]!.error).toMatch(/no JSON/);
    // A round written before the stamp existed: kept while it judged exactly
    // this review's comment ids (no re-spend on an old judge dir), re-judged
    // once the ids differ.
    const { review_hash: _h, ...legacy } = again[0]!;
    expect(_h).toMatch(/^[0-9a-f]{64}$/);
    for (const k of [1, 2])
      writeFileSync(
        join(dir, "judge", `o__r@1234567.r${k}.json`),
        JSON.stringify({ ...legacy, round: k }),
      );
    const kept = await judgeCase({ ...common, rounds: 2, resume: true });
    expect(readFileSync(counter, "utf8").trim()).toBe("5");
    expect(kept.map((j) => j.error)).toEqual([undefined, undefined]);
    await judgeCase({
      ...common,
      review: { ...REVIEW, comments: [REVIEW.comments[0]!] },
      rounds: 2,
      resume: true,
    });
    expect(readFileSync(counter, "utf8").trim()).toBe("7");
    // The ground truth was bumped under an explicit --label: a round judged
    // against the old version is re-asked on resume, never kept.
    writeFileSync(join(dir, "judge", "o__r@1234567.r1.json"), JSON.stringify(again[0]));
    writeFileSync(
      join(dir, "judge", "o__r@1234567.r2.json"),
      JSON.stringify({ ...again[0]!, round: 2 }),
    );
    await judgeCase({ ...common, defectSetVersion: "2", rounds: 2, resume: true });
    expect(readFileSync(counter, "utf8").trim()).toBe("9");
    // The judge model changed under an explicit --label: a round judged by
    // the old model is re-asked on resume, never mixed into the new model's.
    writeFileSync(join(dir, "judge", "o__r@1234567.r1.json"), JSON.stringify(again[0]));
    writeFileSync(
      join(dir, "judge", "o__r@1234567.r2.json"),
      JSON.stringify({ ...again[0]!, round: 2 }),
    );
    const kept2 = await judgeCase({ ...common, rounds: 2, resume: true });
    expect(readFileSync(counter, "utf8").trim()).toBe("9");
    expect(kept2.map((j) => j.error)).toEqual([undefined, undefined]);
    await judgeCase({ ...common, pi: { ...common.pi, model: "m2" }, rounds: 2, resume: true });
    expect(readFileSync(counter, "utf8").trim()).toBe("11");
  });
});

describe("a re-judged round", () => {
  it("never reads an earlier attempt's answer out of the events file", async () => {
    // Round 1 was judged (review A) and answered well; `review --resume`
    // rewrote the review, and the re-judge's pi dies with no assistant text.
    const dir = mkdtempSync(join(tmpdir(), "defects-rejudge-"));
    const out = join(dir, "judge");
    mkdirSync(out, { recursive: true });
    const answer = JSON.stringify({
      defects: [
        { id: "D1", verdict: "found", comments: ["C1"], why: "x" },
        { id: "D2", verdict: "missed", comments: [], why: "y" },
      ],
      comments: [
        { id: "C1", defect: "D1", verdict: "correct-valuable", new_defect: false, why: "z" },
        { id: "C2", defect: null, verdict: "correct-minor", new_defect: false, why: "w" },
      ],
    });
    writeFileSync(
      join(out, "o__r@1234567.r1.events.jsonl"),
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: answer }],
          usage: { input: 100, output: 50, cacheRead: 0 },
        },
      }) + "\n",
    );
    writeFileSync(
      join(out, "o__r@1234567.r1.json"),
      JSON.stringify({
        instance_id: "o__r@1234567",
        round: 1,
        defect_set_version: "1",
        model: "m",
        defects: [],
        comments: [],
        review_hash: "0".repeat(64),
      }),
    );
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin", "pi"), "#!/bin/sh\ncat >/dev/null\nexit 1\n");
    chmodSync(join(dir, "bin", "pi"), 0o755);
    const [j] = await judgeCase({
      pr: { instance_id: "o__r@1234567", repo: "o/r", title: "T", merge_base: "mb", head: "hd" },
      defects: SET.cases["o__r@1234567"].defects,
      review: REVIEW,
      outDir: out,
      defectSetVersion: "1",
      rounds: 1,
      resume: true,
      log: () => {},
      pi: {
        root: "/x",
        cwd: dir,
        model: "m",
        env: { PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}` },
        timeoutMs: 10_000,
      },
    });
    expect(j!.error).toBeDefined();
    expect(j!.usage).toEqual({ input: 0, output: 0, cacheRead: 0 });
  });
});

describe("the bench's one pi spawn", () => {
  const fakePi = (script: string): { dir: string; env: NodeJS.ProcessEnv } => {
    const dir = mkdtempSync(join(tmpdir(), "defects-runpi-"));
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin", "pi"), `#!/bin/sh\n${script}\n`);
    chmodSync(join(dir, "bin", "pi"), 0o755);
    return { dir, env: { PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}` } };
  };

  it("records a pi that exits without reading its prompt as a failure, never an unhandled EPIPE", async () => {
    // The stdin path exists because orders exceed the 128 KiB argv cap.
    const { dir, env } = fakePi("exit 3");
    const r = await runJudgeSession("x".repeat(4 << 20), {
      root: "/x",
      cwd: dir,
      model: "m",
      env,
      eventsPath: join(dir, "e.jsonl"),
      timeoutMs: 10_000,
    });
    expect(r.code).toBe(3);
    // Let a late EPIPE surface inside this test, not after it.
    await new Promise((res) => setTimeout(res, 200));
  });

  it("resolves only once its output files are fully written", async () => {
    // A long stream whose LAST line carries the answer: the judge reads the
    // events file, and the review reads stderr, synchronously the moment
    // runPi resolves. One run can win the race by luck; thirty in a row not.
    const answer = JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "THE ANSWER" }] },
    });
    const { dir, env } = fakePi("");
    const big = join(dir, "big");
    writeFileSync(
      big,
      ('{"type":"x","pad":"' + "z".repeat(2000) + '"}\n').repeat(2000) + answer + "\n",
    );
    writeFileSync(
      join(dir, "bin", "pi"),
      `#!/bin/sh\ncat >/dev/null\ncat ${big} >&2\ncat ${big}\n`,
    );
    for (let i = 0; i < 30; i++) {
      const eventsPath = join(dir, `e${i}.jsonl`);
      const r = await runJudgeSession("prompt", {
        root: "/x",
        cwd: dir,
        model: "m",
        env,
        eventsPath,
        timeoutMs: 60_000,
      });
      expect(r.code).toBe(0);
      expect(readJudgeEvents(eventsPath).text).toBe("THE ANSWER");
      expect(readFileSync(join(dir, `e${i}.stderr.log`), "utf8").endsWith(answer + "\n")).toBe(
        true,
      );
    }
  }, 120_000);
});

describe("the committed ground truth", () => {
  it.each(["smoke10", "dev10", "holdout10"])(
    "%s parses and covers every case of its set",
    (name) => {
      const root = join(import.meta.dirname, "..", "bench", "aacr");
      const set = parseCaseSet(
        JSON.parse(readFileSync(join(root, "sets", `${name}.json`), "utf8")),
      );
      const truth = parseDefectSet(
        JSON.parse(readFileSync(join(root, "defects", `${name}.json`), "utf8")),
      );
      expect(truth.set).toBe(name);
      expect(Object.keys(truth.cases).sort()).toEqual(set.cases.map((c) => c.instance_id).sort());
      // Every defect is anchored in a file and carries the evidence it was graded on.
      for (const c of Object.values(truth.cases))
        for (const d of c.defects)
          expect(d.evidence.length, `${c.instance_id} ${d.id}`).toBeGreaterThan(20);
    },
  );
});

describe("dollar cost, as pi prices it", () => {
  it("sums pi's per-call costs over the main session and every lens pass", () => {
    const dir = mkdtempSync(join(tmpdir(), "defects-cost-"));
    const ev = [
      { type: "message_end", message: { role: "assistant", usage: { cost: { total: 0.1 } } } },
      { type: "message_end", message: { role: "user", usage: { cost: { total: 9 } } } },
      {
        type: "tool_execution_end",
        toolName: "subagent",
        result: {
          details: { results: [{ usage: { cost: 0.25 } }, { usage: { cost: { total: 0.05 } } }] },
        },
      },
    ];
    writeFileSync(
      join(dir, "pi-events.jsonl"),
      ev.map((e) => JSON.stringify(e)).join("\n") + "\nnot json\n",
    );
    const c = caseCostUsd(dir)!;
    expect(c.source).toBe("pi");
    expect(c.usd).toBeCloseTo(0.4);
  });

  it("prices the OCR arm's bridge tokens at pi's gpt-6-sol rates", () => {
    const dir = mkdtempSync(join(tmpdir(), "defects-cost-ocr-"));
    writeFileSync(
      join(dir, "case-summary.json"),
      JSON.stringify({
        bridge: { input_tokens: 1_000_000, cached_tokens: 500_000, output_tokens: 100_000 },
      }),
    );
    // 0.5M uncached × $2 + 0.5M cached × $0.20 + 0.1M output × $10
    expect(caseCostUsd(dir)).toEqual({ usd: 1 + 0.1 + 1, source: "priced", model: "gpt-6-sol" });
    expect(caseCostUsd(join(dir, "nope"))).toBeNull();
  });
});

describe("token counts, whichever arm recorded them", () => {
  it("reads pi's usage, the OCR arm's ocr_tokens and Claude Code's tokens; input counts cache reads", () => {
    expect(caseTokenCounts({ usage: { input: 10, cacheRead: 90, output: 5 } })).toEqual({
      input: 100,
      output: 5,
    });
    expect(caseTokenCounts({ ocr_tokens: { input: 40, output: 7, total: 47 } })).toEqual({
      input: 40,
      output: 7,
    });
    expect(
      caseTokenCounts({
        tokens: { input: 10, output: 900, cache_read: 1000, cache_creation: 200 },
      }),
    ).toEqual({ input: 1210, output: 900 });
  });

  it("is unknown (null) when the summary records no counts — never zero", () => {
    expect(caseTokenCounts({ tokens: null, usage: null })).toBeNull();
    expect(caseTokenCounts({ duration_seconds: 3 })).toBeNull();
    expect(caseTokenCounts(null)).toBeNull();
  });

  it("a report with no recorded tokens says so rather than 0k", () => {
    const set = parseDefectSet(SET);
    const s = scoreRun(set, ["o__r@1234567"], { "o__r@1234567": [] }, { "o__r@1234567": REVIEW });
    const md = renderDefectReport("t", set, s, { medianMinPerPr: 2 });
    expect(md).toContain("| — | — | — | — | 2.0 |");
  });
});

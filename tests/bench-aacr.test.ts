// The AACR-Bench harness (src/bench/, bench/aacr/). What is pinned here:
//
//   1. the case-set contract: only AACR-Bench v1.0, validated shapes, no dupes;
//   2. the git → file-list parse the lens heuristics consume (real statuses,
//      renames, binaries — never every file stamped `modified`);
//   3. the offline override: every GitHub-bound step replaced, every
//      review-quality step kept, the output files named;
//   4. the conversion to the scorer's shape — above all that a failed case
//      still produces a file (the scorer silently drops a missing one);
//   5. that every lens the bench PLANS is an agent the bench BUILDS (a bare
//      lens name with no `<lens>--<tier>` agent leaves `qcr regression`
//      unrunnable);
//   6. the sandbox's structural promises: src/bench imports no mutation code,
//      the image carries no scripts/ and no gh;
//   7. the open-code-review baseline arm: OCR run flag-for-flag as the
//      harness's reviewers/ocr.py runs it, its result file in that runner's
//      shape, the pinned binary, the bridge reading only the refresh-disabled
//      token copy, and neither arm able to overwrite the other's run.

import { afterAll, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AACR_V1,
  benchAppendix,
  bodyPostedFindings,
  filesFromGitDiff,
  parseCaseSet,
  parseSessionComments,
  patchFromGitDiff,
  safeId,
  VARIANTS,
  selectCases,
  tagOf,
  toOcrResult,
  reanchorLeftComments,
  reanchorLeftLine,
  modelErrorsFromEvents,
  usageFromEvents,
  type BenchCase,
  type BenchComment,
  type PrefetchMeta,
} from "../src/bench/aacr.js";
import { parseReferenceLabels, recallByQuality, renderReport } from "../src/bench/report.js";
import { renderReviewFromRecord } from "../src/reviewrender.js";
import { AuthExpiring, benchAuthFrom, DISABLED_REFRESH, syncBenchAuth, BENCH_RETRY } from "../src/bench/auth.js";
import {
  bridgeDelta,
  OCR_HARNESS_DEFAULTS,
  ocrEnv,
  ocrProcessTimeoutMs,
  ocrResultPayload,
  ocrReviewArgv,
  runArmOf,
  scoredOcrComments,
  summarizeOcrRun,
  type BridgeStats,
  type OcrCaseSummary,
} from "../src/bench/ocr.js";
import { latestMetrics, metricsFiles, renderOcrReport, roundMetrics } from "../src/bench/report.js";
import {
  applyConfigOverrides,
  boundBody,
  buildBenchAgents,
  benchConfig,
  collectComments,
  prepareReviewCases,
  recordUnprefetched,
  HEAD_PATCHES_FILE,
  rebuildResults,
  renderCasePrompts,
  resultLine,
  retryable,
  runFingerprint,
  withPresetInToml,
  writeResults,
  type CaseSummary,
  type RunFingerprint,
} from "../src/bench/runner.js";
import { loadConfig } from "../src/config.js";
import { ecosystemFor } from "../src/ecosystem.js";
import { buildAgents, identityVars, PASS_ADDENDA } from "../src/include.js";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..");
const SMOKE = JSON.parse(readFileSync(join(ROOT, "bench", "aacr", "sets", "smoke10.json"), "utf8"));
const FULL = JSON.parse(readFileSync(join(ROOT, "bench", "aacr", "sets", "full.json"), "utf8"));

describe("case sets", () => {
  it("the committed smoke10 and full sets parse, and pin v1.0", () => {
    const s = parseCaseSet(SMOKE);
    expect(s.cases).toHaveLength(10);
    expect(s.references).toBe(62);
    expect(new Set(s.cases.map((c) => c.repo)).size).toBe(10);
    const f = parseCaseSet(FULL);
    expect(f.cases).toHaveLength(196);
    // Every published leaderboard row is denominated in exactly this.
    expect(f.references).toBe(1505);
    expect(f.dataset.sha256).toBe(AACR_V1.sha256);
  });

  it("the holdout10 set shares no repository with smoke10 — an improvement must generalise", () => {
    const h = parseCaseSet(
      JSON.parse(readFileSync(join(ROOT, "bench", "aacr", "sets", "holdout10.json"), "utf8")),
    );
    const s = parseCaseSet(SMOKE);
    expect(h.cases).toHaveLength(10);
    const smokeRepos = new Set(s.cases.map((c) => c.repo));
    for (const c of h.cases) expect(smokeRepos.has(c.repo), c.repo).toBe(false);
    expect(new Set(h.cases.map((c) => c.repo)).size).toBe(10);
  });

  it("the dev10 set shares no repository with smoke10 or holdout10", () => {
    const set = (name: string) =>
      parseCaseSet(
        JSON.parse(readFileSync(join(ROOT, "bench", "aacr", "sets", `${name}.json`), "utf8")),
      );
    const d = set("dev10");
    expect(d.cases).toHaveLength(10);
    const taken = new Set([...set("smoke10").cases, ...set("holdout10").cases].map((c) => c.repo));
    for (const c of d.cases) expect(taken.has(c.repo), c.repo).toBe(false);
    expect(new Set(d.cases.map((c) => c.repo)).size).toBe(10);
  });

  it("refuses any other dataset revision", () => {
    const moved = { ...SMOKE, dataset: { ...SMOKE.dataset, sha256: "7a4a0e70" } };
    expect(() => parseCaseSet(moved)).toThrow(/v1\.0/);
  });

  it("refuses a duplicate id, a bad sha and an id that does not match repo@head", () => {
    const c0 = SMOKE.cases[0];
    expect(() => parseCaseSet({ ...SMOKE, cases: [c0, c0] })).toThrow(/duplicate/);
    expect(() => parseCaseSet({ ...SMOKE, cases: [{ ...c0, head_commit: "HEAD" }] })).toThrow(
      /40-hex/,
    );
    expect(() =>
      parseCaseSet({ ...SMOKE, cases: [{ ...c0, instance_id: "x__y@1234567" }] }),
    ).toThrow(/does not match/);
    expect(() => parseCaseSet({ ...SMOKE, cases: [{ ...c0, repo: "../../etc" }] })).toThrow(
      /bad repo/,
    );
  });

  it("--only selects by id in the given order, backups included, and never silently narrows", () => {
    const s = parseCaseSet(SMOKE);
    const [a, b] = [s.cases[3]!.instance_id, s.backups[0]!.instance_id];
    expect(selectCases(s, [b, a]).map((c) => c.instance_id)).toEqual([b, a]);
    expect(() => selectCases(s, ["nope@1234567"])).toThrow(/not in set/);
    expect(selectCases(s, undefined)).toHaveLength(10);
  });

  it.each(["smoke10", "holdout10", "dev10"])(
    "the %s labels cover every reference, in the dataset's own order",
    (name) => {
      const s = parseCaseSet(
        JSON.parse(readFileSync(join(ROOT, "bench", "aacr", "sets", `${name}.json`), "utf8")),
      );
      const l = parseReferenceLabels(
        JSON.parse(
          readFileSync(join(ROOT, "bench", "aacr", "sets", `${name}.labels.json`), "utf8"),
        ),
      );
      for (const c of s.cases) {
        const ls = l.labels[c.instance_id] ?? [];
        expect(ls, c.instance_id).toHaveLength(c.references);
        expect(ls.every(Boolean), c.instance_id).toBe(true);
      }
    },
  );

  it("recall by quality averages the judge rounds, and a misaligned label is unlabelled", () => {
    const out = mkdtempSync(join(tmpdir(), "bench-quality-"));
    const dir = join(out, "results", "all");
    mkdirSync(dir, { recursive: true });
    const round = (m: boolean[]) => ({
      eval_res: [
        {
          instance_id: "a__b@1234567",
          comments: [
            { path: "x.py", from_line: 3, semantic_match: m[0] },
            { path: "y.py", from_line: 9, semantic_match: m[1] },
            { path: "z.py", from_line: 1, semantic_match: m[2] },
          ],
        },
        // Not in the case list: never counted.
        {
          instance_id: "c__d@7654321",
          comments: [{ path: "q", from_line: 1, semantic_match: true }],
        },
      ],
    });
    writeFileSync(
      join(dir, "metrics_ocr_1_round_1.json"),
      JSON.stringify(round([true, true, false])),
    );
    writeFileSync(
      join(dir, "metrics_ocr_2_round_2.json"),
      JSON.stringify(round([false, true, false])),
    );
    // The average file is not a round and must not be double-counted.
    writeFileSync(join(dir, "metrics_ocr_average.json"), JSON.stringify({ summary: {} }));
    const labels = parseReferenceLabels({
      source: "test",
      labels: {
        "a__b@1234567": [
          { reality: "real-defect", value: "high", path: "x.py", from_line: 3 },
          { reality: "dubious", path: "y.py", from_line: 9 },
          { reality: "real-defect", value: "low", path: "OTHER.py", from_line: 1 },
        ],
      },
    });
    expect(recallByQuality(dir, labels, ["a__b@1234567"])).toEqual([
      { cls: "real, high/medium value", total: 1, matched: 0.5 },
      { cls: "dubious", total: 1, matched: 1 },
      { cls: "unlabelled", total: 1, matched: 0 },
    ]);
    const set = parseCaseSet(SMOKE);
    const md = renderReport(set, out, [{ ...set.cases[0]!, instance_id: "a__b@1234567" }], labels);
    expect(md).toContain("## Recall by reference quality");
    expect(md).toContain("| all | 0.5/1 | 1/1 | 0/1 |");
    rmSync(out, { recursive: true, force: true });
  });

  it("reads a one-round eval, whose metrics file carries no _round_ suffix", () => {
    // eval_shards.py writes `metrics_ocr_<ts>.json` when rounds == 1.
    const dir = mkdtempSync(join(tmpdir(), "bench-quality1-"));
    writeFileSync(
      join(dir, "metrics_ocr_20260930.json"),
      JSON.stringify({
        eval_res: [
          {
            instance_id: "a__b@1234567",
            comments: [{ path: "x.py", from_line: 3, semantic_match: true }],
          },
        ],
      }),
    );
    const labels = parseReferenceLabels({
      source: "test",
      labels: {
        "a__b@1234567": [{ reality: "real-defect", value: "high", path: "x.py", from_line: 3 }],
      },
    });
    expect(recallByQuality(dir, labels, ["a__b@1234567"])).toEqual([
      { cls: "real, high/medium value", total: 1, matched: 1 },
    ]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("safeId is the scorer's own rule", () => {
    expect(safeId("a__b@1234567")).toBe("a__b@1234567");
    expect(safeId("a/b@1")).toBe("a__b@1");
  });
});

describe("git diff → the files list the lens heuristics read", () => {
  it("carries real status, renames and binaries (the replay stamped everything `modified`)", () => {
    const nameStatus = [
      "M",
      "src/a.py",
      "A",
      "src/new.ts",
      "D",
      "old.go",
      "R087",
      "lib/x.js",
      "lib/y.js",
      "A",
      "img.png",
      "",
    ].join("\0");
    const numstat = [
      "3\t1\tsrc/a.py",
      "10\t0\tsrc/new.ts",
      "0\t7\told.go",
      "2\t2\t",
      "lib/x.js",
      "lib/y.js",
      "-\t-\timg.png",
      "",
    ].join("\0");
    const files = filesFromGitDiff(
      nameStatus,
      numstat,
      new Map([["src/a.py", "@@ -1 +1 @@\n-a\n+b"]]),
    );
    expect(files).toEqual([
      {
        filename: "src/a.py",
        additions: 3,
        deletions: 1,
        status: "modified",
        patch: "@@ -1 +1 @@\n-a\n+b",
      },
      { filename: "src/new.ts", additions: 10, deletions: 0, status: "added" },
      { filename: "old.go", additions: 0, deletions: 7, status: "removed" },
      {
        filename: "lib/y.js",
        additions: 2,
        deletions: 2,
        status: "renamed",
        previous_filename: "lib/x.js",
      },
      { filename: "img.png", additions: 0, deletions: 0, status: "added" },
    ]);
  });

  it("a path with a tab or newline survives the -z framing", () => {
    const weird = "we\tird\nname.py";
    const files = filesFromGitDiff(["A", weird, ""].join("\0"), [`1\t0\t${weird}`, ""].join("\0"));
    expect(files).toEqual([{ filename: weird, additions: 1, deletions: 0, status: "added" }]);
  });

  it("patchFromGitDiff keeps hunks only, like GitHub's `patch`", () => {
    const d =
      "diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-a\n+b\n c\n";
    expect(patchFromGitDiff(d)).toBe("@@ -1,2 +1,2 @@\n-a\n+b\n c\n");
    expect(patchFromGitDiff("Binary files a/x and b/x differ\n")).toBeUndefined();
    expect(patchFromGitDiff(`@@ -1 +1 @@\n${"x".repeat(50)}`, 10)).toBeUndefined();
    // The cap is in UTF-8 bytes: 8 CJK characters are 24 bytes.
    expect(patchFromGitDiff(`@@ -1 +1 @@\n${"漢".repeat(8)}`, 30)).toBeUndefined();
    expect(patchFromGitDiff(`@@ -1 +1 @@\n${"漢".repeat(4)}`, 30)).toBeDefined();
  });
});

describe("the offline override", () => {
  const args = {
    repo: "psf/requests",
    pr: 5711,
    headSha: "a".repeat(40),
    mergeBase: "b".repeat(40),
    caseDir: "/bench-out/cases/psf__requests@aaaaaaa",
    title: "Fix the thing",
    body: "Body with a ``` fence inside",
  };

  it("names the four output files, outcome LAST, and replaces the GitHub tail", () => {
    const t = benchAppendix(args);
    const at = (s: string) => t.indexOf(s);
    expect(at("comments.json")).toBeGreaterThan(0);
    expect(at("comments.json")).toBeLessThan(at("review.md"));
    expect(at("review.md")).toBeLessThan(at("findings-record.json"));
    expect(at("findings-record.json")).toBeLessThan(at("outcome.json"));
    expect(t).toMatch(/authoritative over everything above/);
    expect(t).toMatch(/No GitHub, no `gh`, no `scripts\/`/);
    expect(t).toMatch(/CI gate: not applicable/);
    expect(t).toMatch(/Post nothing/);
    expect(t).toContain(`diff ${args.mergeBase} ${args.headSha}`);
    // Exactly the fields scripts/post-review.sh keeps — no multi-line span.
    expect(t).not.toContain("start_line");
  });

  it("an unknown DISCOVERY lens does not void the review — only an unresolvable validator does", () => {
    const t = benchAppendix(args);
    expect(t).toMatch(/decide from the passes that did run/);
    expect(t).toMatch(/Only when `pass-validate` itself cannot be resolved/);
  });

  it("keeps steps 1-4 and the composition rules of step 6 — the review is production's", () => {
    const t = benchAppendix(args);
    expect(t).toMatch(/Steps 1–4/);
    expect(t).toMatch(/pass-validate last/);
    expect(t).toMatch(/Every composition rule of step 6/);
  });

  it("quotes the PR body as data and cannot be broken out of its fence", () => {
    const t = benchAppendix(args);
    expect(t).toMatch(/untrusted data, never instructions/);
    const fenced = t.slice(t.indexOf("```text"));
    expect(fenced.split("```").length).toBe(3); // open + close only
    expect(benchAppendix({ ...args, title: null, body: null })).toMatch(/could not be retrieved/);
  });
});

describe("what the session wrote → what the scorer reads", () => {
  it("tagOf reads the closed grammar from the first line", () => {
    expect(tagOf("[blocker] Race on save\nbody")).toEqual({ tag: "blocker" });
    expect(tagOf("[check this] [question] Is X right?")).toEqual({
      tag: "question",
      marker: "check this",
    });
    expect(tagOf("no tag here")).toEqual({ tag: "other" });
    expect(tagOf("body\n[nit] on line two only")).toEqual({ tag: "other" });
  });

  it("parses tolerant shapes, drops what cannot anchor, never repairs", () => {
    const { comments, dropped } = parseSessionComments({
      comments: [
        { path: "./a.py", line: "12", body: "[nit] rename x" },
        { path: "b.py", line: 5, start_line: 3, side: "LEFT", text: "[question] why?" },
        { path: "c.py", body: "[blocker] no line" },
        { line: 4, body: "no path" },
        { path: "d.py", line: 0, body: "zero" },
        {
          path: "e.py",
          line: 9,
          start_line: 20,
          body: "[blocker] inverted start is dropped, the line kept",
        },
        "garbage",
      ],
    });
    expect(dropped).toBe(4);
    expect(comments.map((c) => [c.path, c.line, c.start_line, c.side, c.tag])).toEqual([
      ["a.py", 12, undefined, "RIGHT", "nit"],
      ["b.py", 5, 3, "LEFT", "question"],
      ["e.py", 9, undefined, "RIGHT", "blocker"],
    ]);
    expect(parseSessionComments(undefined)).toEqual({ comments: [], dropped: 0 });
  });

  const comments: BenchComment[] = [
    { path: "a.py", line: 10, side: "RIGHT", body: "[blocker] x", tag: "blocker" },
    {
      path: "a.py",
      line: 20,
      start_line: 18,
      side: "RIGHT",
      body: "[question] y",
      tag: "question",
    },
    { path: "b.py", line: 3, side: "RIGHT", body: "[nit] z", tag: "nit" },
    { path: "b.py", line: 4, side: "LEFT", body: "[blocker] old side", tag: "blocker" },
  ];
  const meta = {
    instance_id: "a__b@1234567",
    status: "ok" as const,
    duration_seconds: 60,
    usage: { input: 1000, output: 200, cacheRead: 5000 },
    verdict: "REQUEST_CHANGES",
    unparseable: 1,
  };

  it("emits the OCR shape the harness reads, per variant, with LEFT comments excluded and counted", () => {
    const all = toOcrResult(comments, { ...meta, variant: "all" }) as {
      review: { comments: Array<Record<string, unknown>>; summary: Record<string, number> };
      qcr: { excluded: Record<string, number> };
    };
    expect(all.review.comments).toEqual([
      { path: "a.py", start_line: 10, end_line: 10, content: "[blocker] x" },
      // Single-line even though the session wrote start_line 18: production's
      // posting script drops start_line, so the span never reaches GitHub.
      { path: "a.py", start_line: 20, end_line: 20, content: "[question] y" },
      { path: "b.py", start_line: 3, end_line: 3, content: "[nit] z" },
    ]);
    expect(all.review.summary).toEqual({ input_tokens: 6000, output_tokens: 200 });
    expect(all.qcr.excluded).toEqual({ left_side: 1, variant: 0, unparseable: 1 });
    const noNits = toOcrResult(comments, { ...meta, variant: "no-nits" }) as typeof all;
    expect(noNits.review.comments).toHaveLength(2);
    const blockers = toOcrResult(comments, { ...meta, variant: "blockers" }) as typeof all;
    expect(blockers.review.comments.map((c) => c["content"])).toEqual(["[blocker] x"]);
    expect(blockers.qcr.excluded.variant).toBe(2);
  });

  it("a finding posted in the review BODY (no inline anchor) is scored, with its body text, never twice", () => {
    const record = {
      findings: [
        {
          path: "nb.ipynb",
          line: 240,
          disposition: "posted",
          posted_as: "blocker",
          reason: "r",
          evidence: "e",
        },
        {
          path: "a.py",
          line: 11,
          disposition: "posted",
          posted_as: "nit",
          reason: "already inline",
        },
        { path: "x.py", line: 5, disposition: "killed", posted_as: null, reason: "killed" },
        {
          path: "y.py",
          line: 7,
          disposition: "posted",
          posted_as: "check this",
          reason: "why",
          evidence: "ev",
        },
      ],
    };
    const reviewMd = [
      "### Blockers",
      "",
      "- `nb.ipynb:240` — Launchers lose their imports _(P1/0.99, pass-baseline)_",
      "",
      "  [blocker] Selecting a launcher fails in a fresh runtime.",
      "",
      "  _P1 · confidence 0.99 · lens pass-baseline_",
      "",
      "---",
    ].join("\n");
    const inline: BenchComment[] = [
      { path: "a.py", line: 10, side: "RIGHT", body: "[nit] x", tag: "nit" },
    ];
    const got = bodyPostedFindings(record, reviewMd, inline);
    expect(got.map((c) => [c.path, c.line, c.tag, c.source])).toEqual([
      ["nb.ipynb", 240, "blocker", "body"],
      ["y.py", 7, "question", "body"],
    ]);
    expect(got[0]!.body).toBe(
      "[blocker] Launchers lose their imports\n\n[blocker] Selecting a launcher fails in a fresh runtime.",
    );
    // No bullet in the body for y.py: the record's own reason + evidence.
    expect(got[1]!.body).toBe("[check this] why\n\nev");
    expect(bodyPostedFindings(undefined, "", [])).toEqual([]);
  });

  describe("body findings on the rendered route (render_outputs)", () => {
    const entry = (over: Record<string, unknown>) => ({
      disposition: "posted",
      posted_as: "blocker",
      severity: "P1",
      confidence: 0.9,
      lens: "pass-baseline",
      title: "T",
      body: "B",
      ...over,
    });
    const rendered = (findings: Array<Record<string, unknown>>) => {
      const r = renderReviewFromRecord(
        { verdict: "REQUEST_CHANGES", summary: "S.", lenses_applied: "pass-baseline", findings },
        {},
      );
      return {
        body: r.body,
        inline: parseSessionComments(r.comments).comments,
      };
    };

    it("an inline:false finding keeps its posted EXPLANATION, not the section's title-only bullet", () => {
      const findings = [
        entry({
          path: "a.py",
          line: 12,
          inline: false,
          title: "Loses data",
          body: "Why it loses data.",
        }),
      ];
      const { body, inline } = rendered(findings);
      const got = bodyPostedFindings({ findings }, body, inline);
      expect(got.map((c) => c.body)).toEqual(["[blocker] Loses data\n\nWhy it loses data."]);
    });

    it("a distinct finding beside an inline one is still scored — proximity is not identity", () => {
      const findings = [
        entry({ path: "a.py", line: 10, title: "Inline one", body: "x" }),
        entry({ path: "a.py", line: 12, inline: false, title: "Body one", body: "y" }),
      ];
      const { body, inline } = rendered(findings);
      expect(inline.map((c) => c.line)).toEqual([10]);
      const got = bodyPostedFindings({ findings }, body, inline);
      expect(got.map((c) => [c.line, c.body])).toEqual([[12, "[blocker] Body one\n\ny"]]);
    });

    it("an ask-your-human or deferred finding carries its severity's tag in the body as it does inline", () => {
      const findings = [
        entry({ path: "a.py", line: 3, posted_as: "ask your human", severity: "P1", title: "H" }),
        entry({ path: "a.py", line: 30, posted_as: "deferred", severity: "nit", inline: false }),
        entry({
          path: "a.py",
          line: 50,
          posted_as: "ask your human",
          severity: "P1",
          inline: false,
        }),
      ];
      const { body, inline } = rendered(findings);
      expect(inline.map((c) => c.tag)).toEqual(["blocker"]);
      const got = bodyPostedFindings({ findings }, body, inline);
      expect(got.map((c) => [c.line, c.tag])).toEqual([
        [30, "nit"],
        [50, "blocker"],
      ]);
    });
  });

  it("the handwritten route: one comment carries one record entry; a second beside it is in the body only when the body names it", () => {
    const inline: BenchComment[] = [
      { path: "a.py", line: 10, side: "RIGHT", body: "[question] x", tag: "question" },
    ];
    const record = {
      findings: [
        { path: "a.py", line: 12, disposition: "posted", posted_as: "question", reason: "r12" },
        { path: "a.py", line: 10, disposition: "posted", posted_as: "question", reason: "r10" },
      ],
    };
    // The body names a.py:12: a distinct finding the session posted there.
    const named = bodyPostedFindings(record, "- `a.py:12` — Twelve _(P2, pass-x)_\n", inline);
    expect(named.map((c) => [c.line, c.body])).toEqual([[12, "[question] Twelve"]]);
    // It does not: folded into the comment beside it, as the session merged it.
    expect(bodyPostedFindings(record, "", inline)).toEqual([]);
  });

  it("the handwritten route: record-only neighbours the session posted nowhere count ONCE, as they always did", () => {
    // Three posted rows a line apart, in neither comments.json nor review.md.
    const record = {
      findings: [
        { path: "m.go", line: 50, disposition: "posted", posted_as: "blocker", reason: "a" },
        { path: "m.go", line: 51, disposition: "posted", posted_as: "blocker", reason: "b" },
        { path: "m.go", line: 51, disposition: "posted", posted_as: "nit", reason: "c" },
        { path: "m.go", line: 90, disposition: "posted", posted_as: "nit", reason: "far" },
      ],
    };
    expect(bodyPostedFindings(record, "", []).map((c) => [c.line, c.body])).toEqual([
      [50, "[blocker] a"],
      [90, "[nit] far"],
    ]);
    // Named in the body, each is its own finding.
    const md = ["- `m.go:50` — A", "- `m.go:51` — B"].join("\n");
    expect(bodyPostedFindings(record, md, []).map((c) => c.line)).toEqual([50, 51, 51, 90]);
  });

  it("a failed case still yields a file with zero comments — its references count against recall", () => {
    const r = toOcrResult([], { ...meta, status: "timeout", variant: "all" }) as {
      review: { comments: unknown[] };
      qcr: { status: string };
    };
    expect(r.review.comments).toEqual([]);
    expect(r.qcr.status).toBe("timeout");
  });

  it("sums parent usage and every lens child's usage from pi's JSON stream", () => {
    const lines = [
      JSON.stringify({ type: "message_end", message: { role: "user", usage: { input: 999 } } }),
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", usage: { input: 100, output: 10, cacheRead: 50 } },
      }),
      JSON.stringify({
        type: "tool_execution_end",
        result: {
          details: {
            results: [
              { usage: { input: 7, output: 3, cacheRead: 1 } },
              { usage: { input: 1, output: 1 } },
            ],
          },
        },
      }),
      "not json",
      "",
    ];
    expect(usageFromEvents(lines)).toEqual({ input: 108, output: 14, cacheRead: 51, children: 2 });
  });

  it("counts each failed model call once, by kind — the parent's and the lens children's", () => {
    const err = (ts: number, msg: string) => ({
      role: "assistant",
      stopReason: "error",
      timestamp: ts,
      errorMessage: msg,
    });
    const limited = err(1, "429 Too Many Requests: rate limit reached");
    const lines = [
      JSON.stringify({ type: "message_end", message: limited }),
      // pi repeats a message in later events: the same call, not a second one
      JSON.stringify({ type: "agent_end", messages: [limited, { role: "user" }] }),
      JSON.stringify({
        type: "tool_execution_end",
        toolName: "subagent",
        result: {
          details: {
            results: [
              { messages: [err(2, "Codex error: Our servers are currently overloaded.")] },
              { messages: [err(3, "WebSocket idle timeout after 120000ms")] },
            ],
          },
        },
      }),
      // a source file that merely MENTIONS rate limits is not an error
      JSON.stringify({
        type: "tool_execution_end",
        result: { content: "usage_limit_reached 429" },
      }),
      "not json",
    ];
    const e = modelErrorsFromEvents(lines);
    expect(e).toMatchObject({ rate_limited: 1, overloaded: 1, usage_limit: 0, other: 1 });
    expect(e.sample).toContain("429");
  });

  it("the plan's usage window running out is its own kind, not a short rate limit", () => {
    // The exact text pi 0.99.1 records for openai-codex when the plan window runs out.
    const err = (ts: number, errorMessage: string) =>
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", stopReason: "error", errorMessage, timestamp: ts },
      });
    const e = modelErrorsFromEvents([
      err(1, "Codex error: The usage limit has been reached"),
      err(2, "Codex error: The usage limit has been reached"),
      err(
        3,
        '429 {"type":"error","error":{"type":"rate_limit_error","message":"rate limit of 50 requests per minute"}}',
      ),
    ]);
    expect(e).toMatchObject({ usage_limit: 2, rate_limited: 1, overloaded: 0, other: 0 });
    expect(e.sample).toContain("usage limit has been reached");
  });

  it("a case's result line says whether arm.sh should retry it and whether the login pushed back", () => {
    const base = { instance_id: "o__a@1111111", error: undefined } as unknown as CaseSummary;
    const mk = (status: CaseSummary["status"], extra: Partial<CaseSummary> = {}) =>
      ({ ...base, status, ...extra }) as CaseSummary;
    expect(resultLine(mk("ok"))).toBe("result: o__a@1111111 ok retry=0 limited=0");
    expect(resultLine(mk("ok"), true)).toBe("result: o__a@1111111 ok retry=0 limited=0 skipped");
    expect(
      resultLine(mk("no-verdict", { model_errors: { rate_limited: 2, overloaded: 1, other: 4 } })),
    ).toBe("result: o__a@1111111 no-verdict retry=1 limited=3");
    // The plan's usage window: counted as pushback AND named, so arm.sh stops launching.
    expect(
      resultLine(
        mk("no-output", {
          model_errors: { rate_limited: 0, overloaded: 0, usage_limit: 2, other: 0 },
        }),
      ),
    ).toBe("result: o__a@1111111 no-output retry=1 limited=2 quota=2");
    // Unfetchable (force-pushed away) never succeeds on a re-run.
    expect(
      retryable(mk("failed", { error: "x: not prefetched (run `bench.sh prefetch` first)" })),
    ).toBe(false);
    expect(retryable(mk("timeout"))).toBe(true);
    expect(retryable(mk("failed", { error: "spawn pi ENOENT" }))).toBe(true);
  });
});

describe("the round the bench runs is the production round", () => {
  // The bench reads the install locator's config (inside the image: the copy
  // bench.sh baked, named by QCR_CONFIG). The checkout's own config.toml is
  // never read, so the test names a production-shaped one.
  const LIVE = join(ROOT, "tests", "fixtures", "config.toml");
  const savedConfig = process.env.QCR_CONFIG;
  process.env.QCR_CONFIG = LIVE;
  afterAll(() => {
    if (savedConfig === undefined) delete process.env.QCR_CONFIG;
    else process.env.QCR_CONFIG = savedConfig;
  });
  const cfg = benchConfig("");
  const c = parseCaseSet(SMOKE).cases[0]!;
  const meta: PrefetchMeta = {
    instance_id: c.instance_id,
    repo: c.repo,
    pr: c.pr,
    base_commit: c.base_commit,
    head_commit: c.head_commit,
    merge_base: "c".repeat(40),
    base_ref: "master",
    base_ref_source: "github-api",
    title: "Enforce all pyflake lint rules",
    body: "A body long enough to be a body.",
    depth: 50,
    diff: { files: 2, additions: 60, deletions: 5 },
    fetched_at: "2026-09-25T00:00:00Z",
  };
  const files = [
    { filename: "comfy/model.py", additions: 40, deletions: 5, status: "modified" },
    { filename: "tests/test_model.py", additions: 20, deletions: 0, status: "added" },
  ];

  it("every planned lens is a BUILT agent (the qcr-regression defect: bare names vs lens--tier)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "bench-agents-"));
    try {
      // The same build buildBenchAgents runs, into a temp dir instead of
      // <root>/.pi/agents (which is the sandbox's tmpfs).
      const out = join(tmp, "agents");
      buildAgents(join(ROOT, "agents"), out, {
        root: ROOT,
        tiers: cfg.models.tiers,
        riskPasses: cfg.models.risk_passes,
        validateTier: cfg.models.validate_tier,
        vars: identityVars(cfg),
        addenda: [...PASS_ADDENDA],
      });
      const built = new Set(readdirSync(out).map((f) => f.replace(/\.md$/, "")));
      const { plannedLenses } = renderCasePrompts({
        root: ROOT,
        cfg,
        ecosystem: ecosystemFor("none"),
        c,
        meta,
        tree: "/opt/quickreview/sandbox/wt/x",
        caseDir: "/bench-out/cases/x",
        files,
        issuedAt: "2026-09-25T00:00:00Z",
      });
      expect(plannedLenses.length).toBeGreaterThan(1);
      expect(plannedLenses.at(-1)).toMatch(/^pass-validate--/);
      for (const agent of plannedLenses) expect(built.has(agent), agent).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("the order is round-first.md rendered by production, then the override, with the foreign repo's identity", () => {
    const { order, system } = renderCasePrompts({
      root: ROOT,
      cfg,
      ecosystem: ecosystemFor("none"),
      c,
      meta,
      tree: "/opt/quickreview/sandbox/wt/x",
      caseDir: "/bench-out/cases/x",
      files,
      issuedAt: "2026-09-25T00:00:00Z",
    });
    const roundFirst = readFileSync(join(ROOT, "prompts", "round-first.md"), "utf8");
    // Ratified fences travel byte-for-byte.
    // The fence CONTENTS travel; the marker lines are maintainer-only.
    const open = roundFirst.indexOf("<!-- RATIFIED posting-map");
    const fence = roundFirst.slice(
      roundFirst.indexOf("\n", open) + 1,
      roundFirst.indexOf("<!-- /RATIFIED posting-map -->"),
    );
    expect(order).not.toContain("<!-- RATIFIED");
    expect(order).toContain(fence);
    expect(order.indexOf("## 6. Post")).toBeLessThan(order.indexOf("## BENCHMARK MODE"));
    expect(order).not.toMatch(/\{\{[a-z_]+\}\}/);
    expect(order).toContain(`\`${meta.base_ref}\` @ \`${c.base_commit}\``);
    expect(system).toContain(`\`${c.repo}\``);
    expect(system).not.toContain(identityVars(loadConfig(LIVE)).repo);
  });

  it("the PR body is bounded ONCE, by UTF-8 bytes, before both places it appears", () => {
    expect(boundBody(null)).toBeNull();
    expect(boundBody("short")).toBe("short");
    const cjk = "字".repeat(10_000); // 30,000 bytes
    const cut = boundBody(cjk, 20_000)!;
    expect(Buffer.byteLength(cut.split("\n…")[0]!, "utf8")).toBeLessThanOrEqual(20_000);
    expect(cut).not.toContain("\uFFFD");
    expect(cut).toMatch(/truncated for the benchmark/);
    const { order } = renderCasePrompts({
      root: ROOT,
      cfg,
      ecosystem: ecosystemFor("none"),
      c,
      meta: { ...meta, body: "x".repeat(200_000) },
      tree: "/opt/quickreview/sandbox/wt/x",
      caseDir: "/bench-out/cases/x",
      files,
      issuedAt: "2026-09-25T00:00:00Z",
    });
    expect(order).not.toContain("x".repeat(20_001));
  });

  it("buildBenchAgents follows the profile's ecosystem: no profile builds no Django pre-check claim", () => {
    const tmp = mkdtempSync(join(tmpdir(), "bench-eco-"));
    try {
      // A bench root the way the sandbox mounts one: the seeds and prompts,
      // no profiles/ — cfg.review.profile is "" so the ecosystem is none.
      symlinkSync(join(ROOT, "agents"), join(tmp, "agents"));
      symlinkSync(join(ROOT, "prompts"), join(tmp, "prompts"));
      expect(buildBenchAgents(tmp, cfg)).toBeGreaterThan(0);
      const out = join(tmp, ".pi", "agents");
      const ds = readdirSync(out).find((f) => f.startsWith("pass-data-safety--"))!;
      const body = readFileSync(join(out, ds), "utf8");
      expect(body).toContain("judge from the migration file and the model diff");
      expect(body).not.toContain("handled daemon-side");
      expect(body).not.toContain("Django");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("the bench config is production's, with only the profile swapped", () => {
    expect(cfg.review.profile).toBe("");
    const swapped = benchConfig("example-django");
    expect(swapped.review.profile).toBe("example-django");
    expect({ ...swapped, review: { ...swapped.review, profile: "" } }).toEqual(cfg);
    expect(cfg.models.conversation).toMatch(/^openai-codex\//);
    void buildBenchAgents; // exercised in the sandbox; the pure build is above
  });
});

describe("the sandbox cannot post", () => {
  const benchSrc = readdirSync(join(ROOT, "src", "bench")).map(
    (f) => [f, readFileSync(join(ROOT, "src", "bench", f), "utf8")] as const,
  );

  it("src/bench imports no gate, adapter, token, posting or daemon module at runtime", () => {
    const forbidden =
      /from\s+"\.\.\/(gate|github|githubAuth|posting|daemon|wire|reconcile|verdicts|sessions|tmux|improvements)\.js"/;
    for (const [name, src] of benchSrc) {
      const runtime = src.replace(/import type[^;]+;/g, "");
      expect(runtime, name).not.toMatch(forbidden);
    }
  });

  it("the image and its build context carry no scripts/ and no gh", () => {
    const docker = readFileSync(join(ROOT, "bench", "aacr", "Dockerfile"), "utf8");
    expect(docker).not.toMatch(/^COPY\s+scripts/m);
    expect(docker).toMatch(/! test -e scripts && ! command -v gh/);
    const sh = readFileSync(join(ROOT, "bench", "aacr", "bench.sh"), "utf8");
    const tarList = sh.slice(sh.indexOf("tar -cf -"), sh.indexOf("| tar -xf -"));
    expect(tarList).not.toMatch(/\bscripts\b/);
    // ONE file from deploy/ may ride: the reviewer context stub production
    // installs at boot (tests/reviewer-context.test.ts). Nothing else of it.
    expect(tarList).toContain("deploy/reviewer/AGENTS.override.md");
    expect(tarList.replace("deploy/reviewer/AGENTS.override.md", "")).not.toMatch(
      /\bdeploy\b|\bstate\b|\.git\b/,
    );
    // Every review container runs hardened.
    for (const flag of [
      "--read-only",
      "--cap-drop ALL",
      "no-new-privileges",
      "--pids-limit",
      "--memory",
      "--user",
    ]) {
      expect(sh).toContain(flag);
    }
  });

  it("the companion's login is mounted READ-ONLY (only agent/, sessions hidden), never shadow-bound", () => {
    const sh = readFileSync(join(ROOT, "bench", "aacr", "bench.sh"), "utf8");
    expect(sh).toContain(
      "type=volume,src=$AUTH_VOLUME,dst=/pi-agent-src,volume-subpath=agent,readonly",
    );
    expect(sh).toContain("type=tmpfs,dst=/pi-agent-src/sessions");
    // Nothing of the companion's is bound read-write any more…
    expect(sh).not.toMatch(/dst=\/pi-agent[^-]/);
    // …and no host-side file inside the run dir is bound or appended to.
    expect(sh).not.toContain(".pi-shadow");
    expect(sh).toContain('>> "$RUNS_DIR/$RUN.sandbox-commands.log"');
    expect(sh).toContain('[[ ! -L "$d" ]]');
  });

  it("runs can live outside the worktree, and default to bench/aacr/runs", () => {
    const sh = readFileSync(join(ROOT, "bench", "aacr", "bench.sh"), "utf8");
    expect(sh).toContain('RUNS_DIR="${QCR_BENCH_RUNS_DIR:-$HERE/runs}"');
    expect(sh).toContain('local d="$RUNS_DIR/$RUN"');
    expect(sh).not.toContain('"$HERE/runs/$RUN');
  });

  it("the defect judge reads its ground truth and the repos READ-ONLY, and re-scoring needs no network", () => {
    const sh = readFileSync(join(ROOT, "bench", "aacr", "bench.sh"), "utf8");
    const block = sh.slice(sh.indexOf("  judge|judge-report)"), sh.indexOf("  eval)\n"));
    // The key dir is defects/ itself, or a scratch copy of it with a derived
    // set's cut key added (defects_from) — read-only either way.
    expect(block).toContain('DEFECTS_DIR="$HERE/defects"');
    expect(block).toContain(
      '"type=bind,src=$DEFECTS_DIR,dst=/opt/quickreview/bench/defects,readonly"',
    );
    expect(block).toContain('"type=volume,src=$REPOS_VOLUME,dst=/repos,readonly"');
    // The login and the repos only for `judge`; `judge-report` is --network none.
    expect(block).toMatch(
      /jn=\(--network none\)\n\s+if \[\[ "\$cmd" == judge \]\]; then\n[^\n]*\bauth_mounts\b/,
    );
    expect(block).toContain('"${HARDEN[@]}"');
    const ic = readFileSync(join(ROOT, "bench", "aacr", "in-container.sh"), "utf8");
    expect(ic).toContain("defect-judge --set");
    expect(ic).toContain("defect-report --set");
  });

  it("--run cannot name `.`, `..` or a dotfile, and empty arrays survive bash < 4.4", () => {
    const sh = readFileSync(join(ROOT, "bench", "aacr", "bench.sh"), "utf8");
    const re = /\^\[A-Za-z0-9\]\[A-Za-z0-9\._-\]\*\$/;
    expect(sh).toMatch(re);
    const runRe = new RegExp("^[A-Za-z0-9][A-Za-z0-9._-]*$");
    for (const bad of [".", "..", ".ctl", "../x", "a/b"]) expect(runRe.test(bad), bad).toBe(false);
    expect(runRe.test("smoke10-1")).toBe(true);
    // Every possibly-empty array is expanded in the guarded form.
    for (const a of ["ONLY_ARGS", "EXTRA", "envs", "mounts", "net"]) {
      expect(sh, a).not.toMatch(new RegExp(`(?<!\\+)"\\$\\{${a}\\[@\\]\\}"(?!\\})`));
    }
  });

  it("the image ships AGENTS.md — pi loads it before CLAUDE.md, as production's reviewers do", () => {
    const docker = readFileSync(join(ROOT, "bench", "aacr", "Dockerfile"), "utf8");
    const sh = readFileSync(join(ROOT, "bench", "aacr", "bench.sh"), "utf8");
    // pi 0.84.4 loadContextFileFromDir order; the first that exists at the
    // repo root is what production reviewers read.
    const first = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"].find(
      (f) => existsSync(join(ROOT, f)),
    )!;
    expect(docker).toMatch(
      new RegExp(`^COPY [^\\n]*\\b${first.replace(".", "\\.")}\\b[^\\n]*\\./$`, "m"),
    );
    const tarList = sh.slice(sh.indexOf("tar -cf -"), sh.indexOf("| tar -xf -"));
    expect(tarList).toContain(first);
  });
});

describe("the benchmark's login: read-only, never refreshed", () => {
  const auth = {
    "openai-codex": {
      type: "oauth",
      access: "A",
      refresh: "R-real",
      expires: 2_000_000,
      accountId: "x",
    },
    other: { type: "api", key: "k" },
  };

  it("disables every OAuth refresh token, keeps the rest, reports the earliest expiry", () => {
    const { json, expiresAt } = benchAuthFrom(JSON.stringify(auth));
    const out = JSON.parse(json);
    expect(out["openai-codex"].refresh).toBe(DISABLED_REFRESH);
    expect(out["openai-codex"].access).toBe("A");
    expect(out.other).toEqual({ type: "api", key: "k" });
    expect(json).not.toContain("R-real");
    expect(expiresAt).toBe(2_000_000);
  });

  it("refuses a case the token would not outlive, and writes nothing then", () => {
    const tmp = mkdtempSync(join(tmpdir(), "bench-auth-"));
    try {
      const src = join(tmp, "src");
      const dst = join(tmp, "dst");
      mkdirSync(src);
      writeFileSync(join(src, "auth.json"), JSON.stringify(auth));
      expect(() =>
        syncBenchAuth({
          srcDir: src,
          dstDir: dst,
          root: "/r",
          needMs: 1_000_000,
          now: () => 1_500_000,
        }),
      ).toThrow(AuthExpiring);
      expect(existsSync(join(dst, "auth.json"))).toBe(false);
      syncBenchAuth({ srcDir: src, dstDir: dst, root: "/r", needMs: 1_000, now: () => 1_500_000 });
      const copied = JSON.parse(readFileSync(join(dst, "auth.json"), "utf8"));
      expect(copied["openai-codex"].refresh).toBe(DISABLED_REFRESH);
      expect(statSync(join(dst, "auth.json")).mode & 0o777).toBe(0o600);
      // The VM's global settings: bash-guard for every process, pi's built-in
      // extensions (MCP first) switched off, all trusted.
      const settings = JSON.parse(readFileSync(join(dst, "settings.json"), "utf8"));
      expect(settings).toEqual({
        extensions: [
          "/r/extensions/bash-guard.ts",
          "-builtin:mcp",
          "-builtin:codemode",
          "-builtin:tool-search",
          "-builtin:llama.cpp",
        ],
        defaultProjectTrust: "always",
        retry: BENCH_RETRY,
      });
      // The source is never touched.
      expect(JSON.parse(readFileSync(join(src, "auth.json"), "utf8"))["openai-codex"].refresh).toBe(
        "R-real",
      );
      expect(() =>
        syncBenchAuth({ srcDir: join(tmp, "none"), dstDir: dst, root: "/r", needMs: 0 }),
      ).toThrow(/no pi login/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("the open-code-review baseline arm", () => {
  const set = parseCaseSet(SMOKE);
  const c = set.cases[0]!;

  it("runs OCR flag for flag as the harness's reviewers/ocr.py does", () => {
    // reviewers/ocr.py run_ocr_review at 68a5697; pipeline.py: timeout 30,
    // --max-tools 30; ocr.py's own concurrency default 8 (pipeline passes none).
    expect(OCR_HARNESS_DEFAULTS).toEqual({ concurrency: 8, timeoutMin: 30, maxTools: 30 });
    expect(
      ocrReviewArgv({
        repo: "/wt/x",
        from: c.base_commit,
        to: c.head_commit,
        ...OCR_HARNESS_DEFAULTS,
      }),
    ).toEqual([
      "review",
      "--repo",
      "/wt/x",
      "--from",
      c.base_commit,
      "--to",
      c.head_commit,
      "--format",
      "json",
      "--audience",
      "agent",
      "--concurrency",
      "8",
      "--timeout",
      "30",
      "--max-tools",
      "30",
    ]);
    // process_timeout = timeout_minutes * 60 + 300
    expect(ocrProcessTimeoutMs(30)).toBe(2_100_000);
  });

  it("OCR talks only to the loopback bridge, with a dummy bearer, no update check, no git config", () => {
    const env = ocrEnv({
      path: "/usr/bin",
      home: "/tmp/home",
      tmpDir: "/wt/x.tmp",
      bridgeUrl: "http://127.0.0.1:8766/",
      model: "gpt-6-sol",
    });
    expect(env["OCR_LLM_URL"]).toBe("http://127.0.0.1:8766/v1");
    expect(env["OCR_LLM_TOKEN"]).toBe("loopback-bridge");
    expect(env["OCR_USE_ANTHROPIC"]).toBe("false");
    expect(env["OCR_NO_UPDATE"]).toBe("1");
    expect(env["GIT_CONFIG_GLOBAL"]).toBe("/dev/null");
    // Nothing of the login rides OCR's environment.
    expect(
      Object.keys(env).some(
        (k) => /PI_|OPENAI|ANTHROPIC_(AUTH|BASE)|TOKEN$/.test(k) && k !== "OCR_LLM_TOKEN",
      ),
    ).toBe(false);
  });

  it("writes reviewers/ocr.py's result file; the scorer's reader counts exactly its comments", () => {
    const stdout = JSON.stringify({
      status: "success",
      comments: [
        { path: "a.py", content: "Null deref when x is None", start_line: 3, end_line: 4 },
        { path: "b.py", content: "   ", start_line: 1, end_line: 1 },
      ],
      summary: { files_reviewed: 2, input_tokens: 1000, output_tokens: 50, total_tokens: 1050 },
    });
    const payload = ocrResultPayload({
      c,
      startedAt: "2026-09-25T00:00:00Z",
      durationSeconds: 12.345,
      exitCode: 0,
      stdout,
      stderr: "",
      bench: {},
    });
    expect(Object.keys(payload)).toEqual([
      "instance_id",
      "repo",
      "base_commit",
      "head_commit",
      "reviewer",
      "started_at",
      "duration_seconds",
      "ocr_exit_code",
      "ocr_format",
      "review",
      "stderr",
      "bench",
    ]);
    expect(payload["duration_seconds"]).toBe(12.35);
    // build_target_comments_from_ocr skips blank content
    expect(scoredOcrComments(payload)).toBe(1);
    // …and a run that printed no JSON is kept as text: zero comments, its
    // references still count against recall.
    const failed = ocrResultPayload({
      c,
      startedAt: "t",
      durationSeconds: 1,
      exitCode: 1,
      stdout: "review failed: resolve LLM endpoint",
      stderr: "boom",
      bench: {},
    });
    expect(failed["review"]).toBe("review failed: resolve LLM endpoint");
    expect(scoredOcrComments(failed)).toBe(0);
  });

  it("names a run's status from what OCR did, never from what it hoped", () => {
    const review = (status: string) => ({
      status,
      comments: [],
      summary: { files_reviewed: 3, input_tokens: 9, output_tokens: 1, total_tokens: 10 },
    });
    expect(
      summarizeOcrRun({ exitCode: 0, timedOut: false, review: review("success") }),
    ).toMatchObject({
      status: "ok",
      files_reviewed: 3,
      ocr_tokens: { input: 9, output: 1, total: 10 },
    });
    expect(
      summarizeOcrRun({ exitCode: 0, timedOut: false, review: review("completed_with_errors") })
        .status,
    ).toBe("partial");
    expect(summarizeOcrRun({ exitCode: 1, timedOut: false, review: null }).status).toBe("failed");
    expect(summarizeOcrRun({ exitCode: 137, timedOut: true, review: null }).status).toBe("timeout");
    expect(summarizeOcrRun({ exitCode: 0, timedOut: false, review: null }).status).toBe(
      "no-output",
    );
  });

  it("a case's traffic is the bridge's after − before, and unknown stays unknown", () => {
    const at = (n: number, s: Record<string, number>): BridgeStats => ({
      requests: n,
      ok: n,
      errors: 0,
      upstream_refusals: 0,
      input_tokens: n * 100,
      cached_tokens: n * 10,
      output_tokens: n,
      reasoning_tokens: n,
      by_status: s,
      dropped_keys: {},
    });
    expect(bridgeDelta(at(2, { "200": 2 }), at(7, { "200": 6, "429": 1 }))).toEqual({
      requests: 5,
      ok: 5,
      errors: 0,
      upstream_refusals: 0,
      input_tokens: 500,
      cached_tokens: 50,
      output_tokens: 5,
      reasoning_tokens: 5,
      by_status: { "200": 4, "429": 1 },
    });
    expect(bridgeDelta(null, at(1, {}))).toBeNull();
  });

  it("the report shows every judge round and the average, and the per-case cost", () => {
    const tmp = mkdtempSync(join(tmpdir(), "bench-ocr-"));
    try {
      const all = join(tmp, "results", "all");
      mkdirSync(all, { recursive: true });
      const m = (p: number) => ({
        summary: {
          evaluated_instances: 10,
          generated_notes: 40,
          matched_semantic_notes: p,
          expected_notes: 62,
          semantic_match_rate: p / 40,
          semantic_recall_rate: p / 62,
          semantic_f1: 0.1,
          line_match_rate: 0.5,
          line_recall_rate: 0.3,
        },
      });
      writeFileSync(join(all, "metrics_ocr_20260925_100000_round_1.json"), JSON.stringify(m(8)));
      writeFileSync(join(all, "metrics_ocr_20260925_100100_round_2.json"), JSON.stringify(m(6)));
      writeFileSync(join(all, "metrics_ocr_average.json"), JSON.stringify(m(7)));
      const r = roundMetrics(all);
      expect(r.rounds.map((x) => x.round)).toEqual([1, 2]);
      expect(r.average?.["matched_semantic_notes"]).toBe(7);
      writeFileSync(
        join(tmp, "run.json"),
        JSON.stringify({
          reviewer: "ocr",
          ocr_version: "open-code-review v1.3.1 (7fcb9db) linux/amd64",
          model: "gpt-6-sol",
          effort: "medium",
          flags: { concurrency: 8, timeout_min: 30, max_tools: 30 },
        }),
      );
      const s: OcrCaseSummary = {
        instance_id: c.instance_id,
        arm: "ocr",
        status: "ok",
        fingerprint: {
          qcr_commit: "x",
          ocr_version: "1.3.1",
          model: "gpt-6-sol",
          effort: "medium",
          flags: { concurrency: 8, timeoutMin: 30, maxTools: 30 },
        },
        ocr_status: "success",
        exit_code: 0,
        duration_seconds: 300,
        comments: 4,
        files_reviewed: 9,
        ocr_tokens: { input: 120_000, output: 8_000, total: 128_000 },
        bridge: {
          requests: 31,
          ok: 31,
          errors: 0,
          upstream_refusals: 0,
          input_tokens: 120_000,
          cached_tokens: 60_000,
          output_tokens: 8_000,
          reasoning_tokens: 5_000,
          by_status: { "200": 31 },
        },
        merge_base_ok: true,
        warnings: [],
      };
      mkdirSync(join(tmp, "cases", safeId(c.instance_id)), { recursive: true });
      writeFileSync(
        join(tmp, "cases", safeId(c.instance_id), "case-summary.json"),
        JSON.stringify(s),
      );
      const md = renderOcrReport(set, tmp, [c]);
      expect(md).toContain("- Reviewer: open-code-review v1.3.1 (7fcb9db) linux/amd64, run as");
      expect(md).toContain("--concurrency 8 --timeout 30 --max-tools 30");
      expect(md).toMatch(/\| \*\*average\*\* \| 10\/1 \| 40 \| 7\/62 \|/);
      expect(md).toMatch(/^\| 1 \| 10\/1 \| 40 \| 8\/62 \|/m);
      expect(md).toMatch(/^\| 2 \| 10\/1 \| 40 \| 6\/62 \|/m);
      expect(md).toContain("| 31 (0) | 120k (60k) / 8k (5k) |");
      expect(md).toContain("no PR title/description — the harness passes none");
      expect(md).not.toContain("--background");
      // The equal-inputs switch: the report says the PR text reached OCR,
      // and names a case whose PR text was missing.
      const runRec = JSON.parse(readFileSync(join(tmp, "run.json"), "utf8"));
      writeFileSync(join(tmp, "run.json"), JSON.stringify({ ...runRec, pr_text: true }));
      writeFileSync(
        join(tmp, "cases", safeId(c.instance_id), "case-summary.json"),
        JSON.stringify({ ...s, pr_text: false }),
      );
      const withText = renderOcrReport(set, tmp, [c]);
      expect(withText).not.toContain("the harness passes none)");
      expect(withText).toContain("--max-tools 30 --background <PR title/description>");
      expect(withText).toContain("PR title/description through --background");
      expect(withText).toContain(
        `- Reviewed WITHOUT the PR title/description (none prefetched): \`${c.instance_id}\``,
      );
      // The backend is the one run.json recorded, the API-key route included.
      const api =
        "the public OpenAI API (API key) via the loopback bridge (bench/aacr/codex_bridge.py)";
      writeFileSync(join(tmp, "run.json"), JSON.stringify({ ...runRec, endpoint: api }));
      const viaKey = renderOcrReport(set, tmp, [c]);
      expect(viaKey).toContain(`— ${api}: OCR's Chat Completions calls`);
      expect(viaKey).not.toContain("ChatGPT Codex backend");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("each arm refuses the other's run dir (a quickreviewd rebuild would wipe OCR's scored files)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "bench-arm-"));
    try {
      expect(runArmOf(tmp)).toBeNull();
      writeFileSync(join(tmp, "run.json"), JSON.stringify({ set: "smoke10" }));
      expect(runArmOf(tmp)).toBe("qcr");
      writeFileSync(join(tmp, "run.json"), JSON.stringify({ reviewer: "ocr" }));
      expect(runArmOf(tmp)).toBe("ocr");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    const cli = readFileSync(join(ROOT, "src", "bench", "cli.ts"), "utf8");
    for (const cmd of ["review", "results", "report"]) {
      const at = cli.indexOf(`if (f.cmd === "${cmd}")`);
      expect(cli.slice(at, at + 600), cmd).toContain('assertArm(outDir, "qcr")');
    }
    for (const cmd of ["ocr-review", "ocr-report"]) {
      const at = cli.indexOf(`if (f.cmd === "${cmd}")`);
      expect(cli.slice(at, at + 2500), cmd).toContain('assertArm(outDir, "ocr")');
    }
    const inContainer = readFileSync(join(ROOT, "bench", "aacr", "in-container.sh"), "utf8");
    expect(inContainer).toContain('[[ "$run_arm" == "$arm" ]]');
    expect(inContainer).toContain(
      '[[ "$arm" != qcr ]] && { variants="all"; report_cmd="$arm-report"; }',
    );
  });

  it("the image pins OCR 1.3.1 by sha256, needs git >= 2.41 (trixie), and never builds it over qcr-bench", () => {
    const docker = readFileSync(join(ROOT, "bench", "aacr", "Dockerfile"), "utf8");
    const ocrStage = docker.slice(docker.indexOf("FROM runtime AS ocr"));
    expect(ocrStage).toContain("ARG OCR_VERSION=1.3.1");
    expect(ocrStage).toMatch(/ARG OCR_SHA256_LINUX_AMD64=[0-9a-f]{64}/);
    expect(ocrStage).toContain("sha256sum -c -");
    expect(ocrStage).toContain("v[2] >= 41");
    expect(ocrStage).toContain("codex_bridge.py --self-test");
    expect(ocrStage).toMatch(/! test -e scripts && ! command -v gh/);
    expect(docker).toMatch(/^FROM \$\{RUNTIME_BASE\} AS runtime$/m);
    const sh = readFileSync(join(ROOT, "bench", "aacr", "bench.sh"), "utf8");
    expect(sh).toContain('qcr) IMAGE="${QCR_BENCH_IMAGE:-qcr-bench:latest}"; TARGET=runtime');
    expect(sh).toContain('ocr) IMAGE="${QCR_BENCH_OCR_IMAGE:-qcr-bench-ocr:latest}"; TARGET=ocr');
    expect(sh).toContain("RUNTIME_BASE=node:22-trixie");
    expect(sh).toContain('docker build --target "$TARGET"');
    const tarList = sh.slice(sh.indexOf("tar -cf -"), sh.indexOf("| tar -xf -"));
    expect(tarList).toContain("bench/aacr/codex_bridge.py");
    expect(tarList).toContain("bench/aacr/eval_shards.py");
    expect(docker).toContain("bench/aacr/eval_shards.py /opt/quickreview/bench/");
    // Cases run one at a time: the arm has no case-level pool.
    const cli = readFileSync(join(ROOT, "src", "bench", "cli.ts"), "utf8");
    const ocrReview = cli.slice(
      cli.indexOf('if (f.cmd === "ocr-review")'),
      cli.indexOf('if (f.cmd === "ocr-report")'),
    );
    expect(ocrReview).not.toContain("pool(");
  });

  it("the bridge reads only the refresh-disabled token copy, and forwards no refresh token", () => {
    const bridge = readFileSync(join(ROOT, "bench", "aacr", "codex_bridge.py"), "utf8");
    expect(bridge).toContain(`DISABLED_REFRESH = "${DISABLED_REFRESH}"`);
    expect(bridge).toMatch(
      /if cred\.get\("refresh"\) != DISABLED_REFRESH:\s*\n\s*raise SystemExit/,
    );
    // The only credential fields read into a request: the access token and the account id.
    expect(bridge).not.toMatch(/cred\[["']refresh["']\]/);
    expect(bridge).toContain('ThreadingHTTPServer(("127.0.0.1", a.port)');
  });
});

describe("arm.sh / compare.py — the defect-benchmark loop", () => {
  const arm = readFileSync(join(ROOT, "bench", "aacr", "arm.sh"), "utf8");
  it("judges only the arm's own PRs, and retries a malformed answer once", () => {
    expect(arm).toContain('judge --run "$run" --set "$dset" --only "$dids"');
    expect(arm).toMatch(/--only "\$dids" --concurrency "\$JCONC" --resume/);
    expect(arm).toMatch(/EVAL_VARIANTS="" JCONC=4\n/);
  });
  it("refuses to run without a runs dir outside the worktree", () => {
    expect(arm).toContain("${QCR_BENCH_RUNS_DIR:?");
  });
  it("its levers16 group is exactly the 16 PRs in compare.py", () => {
    const py = readFileSync(join(ROOT, "bench", "aacr", "compare.py"), "utf8");
    const ids = (t: string) => new Set(t.match(/[A-Za-z0-9_.-]+__[A-Za-z0-9_.-]+@[0-9a-f]{7}/g));
    const fromArm = ids(arm.split("# Expand")[0]!);
    expect(fromArm.size).toBe(16);
    expect(ids(py)).toEqual(fromArm);
  });
});

describe("run-to-run consistency in the benchmark", () => {
  it("arm.sh repeats an arm and compare.py scores repeats with a consistency line", () => {
    const arm = readFileSync(join(ROOT, "bench", "aacr", "arm.sh"), "utf8");
    const py = readFileSync(join(ROOT, "bench", "aacr", "compare.py"), "utf8");
    expect(arm).toContain("--repeat) REPEAT=");
    expect(arm).toContain('p="$PREFIX-r$k"');
    expect(py).toContain("found in every run");
    expect(py).toContain("benchmark_limitation");
  });
});

// A comment the session anchored on a deleted line would be dropped from every
// head-side scorer's input (results/all excludes it), so it is moved to the
// head side of its own hunk; a deleted file gets a file-level anchor.
describe("reanchorLeftLine / reanchorLeftComments", () => {
  const patch = [
    "@@ -10,6 +10,5 @@ fn",
    " a",
    " b",
    "-if (!guard) return;",
    "-  check();",
    "+check();",
    " c",
    "@@ -40,3 +39,2 @@",
    " x",
    "-gone();",
    " y",
  ].join("\n");

  it("lands on the nearest added line of the same hunk", () => {
    expect(reanchorLeftLine(patch, 12)).toEqual({ line: 12, how: "hunk" });
    expect(reanchorLeftLine(patch, 13)).toEqual({ line: 12, how: "hunk" });
  });

  it("uses the head-side position when the hunk adds nothing", () => {
    expect(reanchorLeftLine(patch, 41)).toEqual({ line: 40, how: "hunk" });
  });

  it("a deletion at the END of the file lands on the head's last line, never past it", () => {
    expect(reanchorLeftLine("@@ -1,3 +1,2 @@\n a\n b\n-c", 3)).toEqual({ line: 2, how: "hunk" });
    expect(reanchorLeftLine("@@ -1,2 +1 @@\n a\n-b", 2)).toEqual({ line: 1, how: "hunk" });
    // A zero-context hunk names the line before it, which exists.
    expect(reanchorLeftLine("@@ -5,2 +4,0 @@\n-x\n-y", 6)).toEqual({ line: 4, how: "hunk" });
  });

  it("gives a deleted file a file-level anchor, and refuses a line the patch lacks", () => {
    expect(reanchorLeftLine("--- a/f\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b", 2)).toEqual({
      line: 1,
      how: "file",
    });
    expect(reanchorLeftLine(patch, 99)).toBeNull();
  });

  it("moves LEFT comments, keeps the body, and leaves an unknown path LEFT", () => {
    const comments = [
      {
        path: "f.ts",
        line: 12,
        side: "LEFT" as const,
        body: "[blocker] guard removed",
        tag: "blocker" as const,
      },
      { path: "g.ts", line: 3, side: "LEFT" as const, body: "[nit] x", tag: "nit" as const },
      { path: "f.ts", line: 12, side: "RIGHT" as const, body: "[nit] y", tag: "nit" as const },
    ];
    const r = reanchorLeftComments(comments, { "f.ts": patch });
    expect(r.reanchored).toBe(1);
    expect(r.comments[0]).toMatchObject({
      side: "RIGHT",
      line: 12,
      body: "[blocker] guard removed",
      reanchored_from: { side: "LEFT", line: 12, how: "hunk" },
    });
    expect(r.comments[1]!.side).toBe("LEFT");
    expect(r.comments[2]).toBe(comments[2]);
    // toOcrResult then scores the moved one and still excludes what stayed LEFT.
    const res = toOcrResult(r.comments, {
      instance_id: "i",
      status: "ok",
      variant: "all",
      duration_seconds: 1,
      usage: { input: 0, output: 0, cacheRead: 0 },
      verdict: "REQUEST_CHANGES",
      unparseable: 0,
    }) as { review: { comments: unknown[] }; qcr: { excluded: { left_side: number } } };
    expect(res.review.comments).toHaveLength(2);
    expect(res.qcr.excluded.left_side).toBe(1);
  });

  it("collectComments re-anchors from the case's kept patches, so a results rebuild scores the same", () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-reanchor-"));
    try {
      writeFileSync(
        join(dir, "comments.json"),
        JSON.stringify([{ path: "f.ts", line: 12, side: "LEFT", body: "[blocker] guard removed" }]),
      );
      // No kept patches: the LEFT comment stays where it is.
      const before = collectComments(dir);
      expect(before.reanchored).toBe(0);
      expect(before.comments[0]!.side).toBe("LEFT");
      writeFileSync(join(dir, HEAD_PATCHES_FILE), JSON.stringify({ "f.ts": patch }));
      const after = collectComments(dir);
      expect(after.reanchored).toBe(1);
      expect(after.comments[0]).toMatchObject({
        side: "RIGHT",
        line: 12,
        source: "inline",
        reanchored_from: { side: "LEFT", line: 12, how: "hunk" },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a results rebuild that changes a scorer input drops that variant's metrics; a no-op rebuild keeps them", () => {
    const out = mkdtempSync(join(tmpdir(), "bench-rebuild-"));
    try {
      const c = { instance_id: "o__r@1234567" } as BenchCase;
      const caseDir = join(out, "cases", c.instance_id);
      mkdirSync(caseDir, { recursive: true });
      const summary: CaseSummary = {
        instance_id: c.instance_id,
        status: "ok",
        verdict: "REQUEST_CHANGES",
        duration_seconds: 1,
        usage: { input: 0, output: 0, cacheRead: 0, children: 0 },
        planned_lenses: [],
        executed_passes: [],
        comments: { total: 0, by_tag: {}, left_side: 0, unparseable: 0, body: 0 },
        pr_meta: { title: false, body: false, base_ref_source: "none" },
        diff: { files: 0, additions: 0, deletions: 0 },
        continued: false,
        warnings: [],
      };
      writeFileSync(join(caseDir, "case-summary.json"), JSON.stringify(summary));
      writeFileSync(
        join(caseDir, "comments.json"),
        JSON.stringify([{ path: "f.ts", line: 12, side: "LEFT", body: "[blocker] guard removed" }]),
      );
      const lines: string[] = [];
      rebuildResults(out, [c], (l) => lines.push(l));
      const all = join(out, "results", "all");
      const metrics = join(all, "metrics_ocr_round_1.json");
      // the run is scored; a rebuild that changes nothing keeps the score
      writeFileSync(metrics, "{}\n");
      rebuildResults(out, [c], (l) => lines.push(l));
      expect(existsSync(metrics)).toBe(true);
      // the stored comment now converts differently: the old score goes
      writeFileSync(join(caseDir, HEAD_PATCHES_FILE), JSON.stringify({ "f.ts": patch }));
      rebuildResults(out, [c], (l) => lines.push(l));
      expect(readdirSync(all).filter((n) => n.startsWith("metrics_"))).toEqual([]);
      expect(lines.join("\n")).toMatch(/metrics.*re-run eval/i);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe("prepareReviewCases: what a review run keeps of an earlier invocation", () => {
  const fp = { qcr_commit: "new" } as unknown as RunFingerprint;
  const old = { qcr_commit: "old" } as unknown as RunFingerprint;
  const summaryFor = (id: string, fingerprint?: RunFingerprint): CaseSummary => ({
    instance_id: id,
    status: "ok",
    ...(fingerprint ? { fingerprint } : {}),
    verdict: "APPROVE",
    duration_seconds: 1,
    usage: { input: 0, output: 0, cacheRead: 0, children: 0 },
    planned_lenses: [],
    executed_passes: [],
    comments: { total: 0, by_tag: {}, left_side: 0, unparseable: 0, body: 0 },
    pr_meta: { title: false, body: false, base_ref_source: "none" },
    diff: { files: 0, additions: 0, deletions: 0 },
    continued: false,
    warnings: [],
  });
  const cases = ["o__r@1", "o__r@2", "o__r@3", "o__r@4", "o__r@5"].map(
    (instance_id) => ({ instance_id }) as BenchCase,
  );
  /** cases[0] finished under `fp`, cases[1] under `old`, cases[2] with no
   * fingerprint, cases[3] only a result file, cases[4] never prefetched
   * under `fp` (a failed summary and an EMPTY result file). */
  const seed = (out: string): void => {
    const write = (c: BenchCase, s: CaseSummary | null): void => {
      const dir = join(out, "cases", safeId(c.instance_id));
      mkdirSync(dir, { recursive: true });
      if (s) writeFileSync(join(dir, "case-summary.json"), JSON.stringify(s));
      for (const v of Object.keys(VARIANTS)) {
        mkdirSync(join(out, "results", v), { recursive: true });
        writeFileSync(join(out, "results", v, `${safeId(c.instance_id)}.json`), "{}\n");
      }
    };
    write(cases[0]!, summaryFor(cases[0]!.instance_id, fp));
    write(cases[1]!, summaryFor(cases[1]!.instance_id, old));
    write(cases[2]!, summaryFor(cases[2]!.instance_id));
    write(cases[3]!, null);
    recordUnprefetched(out, cases[4]!, "o__r@5: not prefetched", fp);
  };
  /** [summary present, every variant's result present] */
  const has = (out: string, c: BenchCase): [boolean, boolean] => [
    existsSync(join(out, "cases", safeId(c.instance_id), "case-summary.json")),
    Object.keys(VARIANTS).every((v) =>
      existsSync(join(out, "results", v, `${safeId(c.instance_id)}.json`)),
    ),
  ];
  const run = (fn: (out: string) => void): void => {
    const out = mkdtempSync(join(tmpdir(), "bench-prepare-"));
    try {
      seed(out);
      fn(out);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  };

  it("a resume under the same configuration drops nothing it produced, a never-prefetched case included", () => {
    run((out) => {
      const lines: string[] = [];
      const dropped = prepareReviewCases(
        out,
        [cases[0]!, cases[4]!],
        { resume: true, fingerprint: fp },
        (l) => lines.push(l),
      );
      expect(dropped).toEqual([]);
      expect(lines).toEqual([]);
      expect(has(out, cases[0]!)).toEqual([true, true]);
      // the failed summary AND its empty result file: the scorer's denominator keeps it
      expect(has(out, cases[4]!)).toEqual([true, true]);
      const s = JSON.parse(
        readFileSync(
          join(out, "cases", safeId(cases[4]!.instance_id), "case-summary.json"),
          "utf8",
        ),
      ) as CaseSummary;
      expect(s.status).toBe("failed");
      expect(s.fingerprint).toEqual(fp);
      expect(
        JSON.parse(
          readFileSync(
            join(out, "results", "all", `${safeId(cases[4]!.instance_id)}.json`),
            "utf8",
          ),
        ),
      ).toBeTruthy();
    });
  });

  it("a resume under a changed configuration drops exactly the cases another one produced", () => {
    run((out) => {
      const lines: string[] = [];
      expect(
        prepareReviewCases(out, cases, { resume: true, fingerprint: fp }, (l) => lines.push(l)),
      ).toEqual(["o__r@2", "o__r@3"]);
      expect(has(out, cases[0]!)).toEqual([true, true]);
      expect(has(out, cases[1]!)).toEqual([false, false]);
      expect(has(out, cases[2]!)).toEqual([false, false]);
      // no summary claims it for any configuration: left as it is
      expect(has(out, cases[3]!)).toEqual([false, true]);
      expect(has(out, cases[4]!)).toEqual([true, true]);
      expect(lines).toHaveLength(2);
      // and under the OTHER configuration, the same seed loses everything `fp` produced
      expect(prepareReviewCases(out, cases, { resume: true, fingerprint: old }, () => {})).toEqual([
        "o__r@1",
        "o__r@5",
      ]);
    });
  });

  it("a fresh run clears every case it owns, whatever produced it", () => {
    run((out) => {
      expect(prepareReviewCases(out, cases, { resume: false, fingerprint: fp }, () => {})).toEqual(
        [],
      );
      for (const c of cases) expect(has(out, c), c.instance_id).toEqual([false, false]);
    });
  });
});

describe("report and result bookkeeping", () => {
  const set = parseCaseSet(SMOKE);
  const c = set.cases[0]!;
  const martian = {
    ...set,
    dataset: {
      ...set.dataset,
      commit: "e616e849755441da38f18bf3adba2c9583b03803",
      sha256: "0265909b9ebe206e9b8e28f548f0a3ffa145c9b28d317da522ef1034186269ee",
    },
  };
  const ocrSummary = (over: Partial<OcrCaseSummary>): OcrCaseSummary =>
    ({
      instance_id: c.instance_id,
      arm: "ocr",
      status: "ok",
      fingerprint: {},
      ocr_status: "success",
      exit_code: 0,
      duration_seconds: 60,
      comments: 1,
      files_reviewed: 1,
      ocr_tokens: null,
      bridge: null,
      merge_base_ok: true,
      warnings: [],
      ...over,
    }) as unknown as OcrCaseSummary;

  it("a report names the dataset its set is pinned to, and the AACR preamble opens only an AACR-Bench report", () => {
    const tmp = mkdtempSync(join(tmpdir(), "bench-report-ds-"));
    try {
      const aacr = renderOcrReport(set, tmp, [c]);
      expect(aacr).toContain("- Dataset: AACR-Bench v1.0 (1,505 references)");
      expect(aacr).toContain("AACR-Bench's reference comments (74% AI-written");
      const ext = renderOcrReport(martian, tmp, [c]);
      expect(ext).toContain("- Dataset: Martian offline code-review benchmark @ e616e84");
      expect(ext).not.toContain("AACR-Bench v1.0");
      expect(ext).not.toContain("74% AI-written");
      expect(ext).toContain("_What this measures: how closely the review reproduces the dataset's");
      expect(renderReport(martian, tmp, [c])).not.toContain("AACR-Bench v1.0");
      // The closing note's reference-population facts are AACR-Bench's alone.
      expect(renderReport(set, tmp, [c])).toContain("The references are 74% AI-authored");
      const extFull = renderReport(martian, tmp, [c]);
      expect(extFull).not.toContain("74% AI-authored");
      expect(extFull).toContain("Compare variants, not just the headline.");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("the OCR total row says unknown for measurements no case has, and a lower bound for a partial one", () => {
    const tmp = mkdtempSync(join(tmpdir(), "bench-report-tot-"));
    try {
      const c2 = set.cases[1]!;
      const write = (cs: BenchCase, s: OcrCaseSummary): void => {
        mkdirSync(join(tmp, "cases", safeId(cs.instance_id)), { recursive: true });
        writeFileSync(
          join(tmp, "cases", safeId(cs.instance_id), "case-summary.json"),
          JSON.stringify({ ...s, instance_id: cs.instance_id }),
        );
      };
      write(c, ocrSummary({}));
      write(c2, ocrSummary({}));
      const none = renderOcrReport(set, tmp, [c, c2]);
      const totalOf = (md: string): string =>
        md.split("\n").find((l) => l.startsWith("| **total**"))!;
      expect(totalOf(none)).toMatch(/\| \? \| \? \| \? \|$/);
      write(
        c2,
        ocrSummary({
          ocr_tokens: { input: 4000, output: 1000, total: 5000 },
          bridge: {
            requests: 3,
            ok: 3,
            errors: 0,
            upstream_refusals: 0,
            input_tokens: 4000,
            cached_tokens: 0,
            output_tokens: 1000,
            reasoning_tokens: 0,
            by_status: { "200": 3 },
          },
        }),
      );
      const partial = totalOf(renderOcrReport(set, tmp, [c, c2]));
      expect(partial).toContain("≥ 4k/1k (1 unmeasured)");
      expect(partial).toContain("≥ 3 (0) (1 unmeasured)");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("the closing note counts the deleted-line comments that were moved and scored", () => {
    const tmp = mkdtempSync(join(tmpdir(), "bench-report-left-"));
    try {
      const s: CaseSummary = {
        instance_id: c.instance_id,
        status: "ok",
        verdict: "APPROVE",
        duration_seconds: 1,
        usage: { input: 0, output: 0, cacheRead: 0, children: 0 },
        planned_lenses: [],
        executed_passes: [],
        comments: { total: 3, by_tag: {}, left_side: 1, reanchored: 2, unparseable: 0, body: 0 },
        pr_meta: { title: true, body: true, base_ref_source: "set" },
        diff: { files: 1, additions: 1, deletions: 1 },
        continued: false,
        warnings: [],
      };
      mkdirSync(join(tmp, "cases", safeId(c.instance_id)), { recursive: true });
      writeFileSync(
        join(tmp, "cases", safeId(c.instance_id), "case-summary.json"),
        JSON.stringify(s),
      );
      const md = renderReport(set, tmp, [c]);
      expect(md).toContain(
        "2 comment(s) anchored on a deleted line were moved to the head side of their hunk and scored there; 1 LEFT-side (old-code) comment(s) that could not be moved were excluded",
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("the latest metrics are the average's, else the highest round's — round 10 after round 9", () => {
    const tmp = mkdtempSync(join(tmpdir(), "bench-report-rounds-"));
    try {
      const m = (x: number) => JSON.stringify({ summary: { matched_semantic_notes: x } });
      writeFileSync(join(tmp, "metrics_ocr_round_9.json"), m(9));
      writeFileSync(join(tmp, "metrics_ocr_round_10.json"), m(10));
      expect(latestMetrics(tmp)?.summary["matched_semantic_notes"]).toBe(10);
      expect(metricsFiles(tmp).rounds.map((r) => r.round)).toEqual([9, 10]);
      writeFileSync(join(tmp, "metrics_ocr_20260925_100000.json"), m(1));
      expect(metricsFiles(tmp).rounds.map((r) => r.round)).toEqual([1, 9, 10]);
      writeFileSync(join(tmp, "metrics_ocr_average.json"), m(7));
      expect(latestMetrics(tmp)?.summary["matched_semantic_notes"]).toBe(7);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("a fresh review run drops the metrics that scored the result files it clears; a resume of the same configuration keeps them", () => {
    const out = mkdtempSync(join(tmpdir(), "bench-prepare-metrics-"));
    try {
      const fp = { qcr_commit: "same" } as unknown as RunFingerprint;
      const all = join(out, "results", "all");
      const seed = (): void => {
        mkdirSync(join(out, "cases", safeId(c.instance_id)), { recursive: true });
        writeFileSync(
          join(out, "cases", safeId(c.instance_id), "case-summary.json"),
          JSON.stringify({ instance_id: c.instance_id, status: "ok", fingerprint: fp }),
        );
        mkdirSync(all, { recursive: true });
        writeFileSync(join(all, `${safeId(c.instance_id)}.json`), "{}\n");
        writeFileSync(join(all, "metrics_ocr_round_1.json"), "{}\n");
      };
      seed();
      prepareReviewCases(out, [c], { resume: true, fingerprint: fp }, () => {});
      expect(existsSync(join(all, "metrics_ocr_round_1.json"))).toBe(true);
      const lines: string[] = [];
      prepareReviewCases(out, [c], { resume: false, fingerprint: fp }, (l) => lines.push(l));
      expect(readdirSync(all).filter((n) => n.startsWith("metrics_"))).toEqual([]);
      expect(lines.join("\n")).toMatch(/all: 1 metrics file\(s\) scored the old results/);
      // A resume under ANOTHER configuration drops the case and its score.
      seed();
      prepareReviewCases(
        out,
        [c],
        { resume: true, fingerprint: { qcr_commit: "other" } as unknown as RunFingerprint },
        () => {},
      );
      expect(readdirSync(all).filter((n) => n.startsWith("metrics_"))).toEqual([]);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("a review that rewrites a scored result drops that variant's metrics before the new bytes land", () => {
    const out = mkdtempSync(join(tmpdir(), "bench-write-metrics-"));
    try {
      const fp = { qcr_commit: "x" } as unknown as RunFingerprint;
      const all = join(out, "results", "all");
      recordUnprefetched(out, c, "first", fp);
      writeFileSync(join(all, "metrics_ocr_round_1.json"), "{}\n");
      // Same bytes again: the score still stands.
      recordUnprefetched(out, c, "first", fp);
      expect(existsSync(join(all, "metrics_ocr_round_1.json"))).toBe(true);
      // The scorer input changes (a status the result file records):
      // the old score goes.
      const s = recordUnprefetched(out, c, "x", fp);
      expect(s.status).toBe("failed");
      expect(writeResults(out, c, [], { ...s, status: "ok", duration_seconds: 9 })).toContainEqual({
        variant: "all",
        metrics: 1,
      });
      expect(readdirSync(all).filter((n) => n.startsWith("metrics_"))).toEqual([]);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("an unprefetched attempt leaves none of an earlier attempt's review — a rebuild finds the same empty case", () => {
    const out = mkdtempSync(join(tmpdir(), "bench-unprefetched-clear-"));
    try {
      const caseDir = join(out, "cases", safeId(c.instance_id));
      mkdirSync(caseDir, { recursive: true });
      // An earlier attempt's review, on a case whose store is now gone.
      writeFileSync(
        join(caseDir, "comments.json"),
        JSON.stringify([{ path: "f.ts", line: 12, body: "[blocker] the earlier attempt's finding" }]),
      );
      writeFileSync(join(caseDir, "review.md"), "the earlier attempt's body\n");
      writeFileSync(join(caseDir, "findings-record.json"), JSON.stringify({ findings: [] }));
      recordUnprefetched(out, c, "no store", { qcr_commit: "x" } as unknown as RunFingerprint);
      for (const f of ["comments.json", "review.md", "findings-record.json"])
        expect(existsSync(join(caseDir, f))).toBe(false);
      rebuildResults(out, [c], () => {});
      const result = JSON.parse(
        readFileSync(join(out, "results", "all", `${safeId(c.instance_id)}.json`), "utf8"),
      );
      expect(result.review.comments).toEqual([]);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("a rebuild writes a case's summary only after its result files", () => {
    const out = mkdtempSync(join(tmpdir(), "bench-rebuild-summary-last-"));
    try {
      const fp = { qcr_commit: "x" } as unknown as RunFingerprint;
      recordUnprefetched(out, c, "no store", fp);
      const caseDir = join(out, "cases", safeId(c.instance_id));
      writeFileSync(
        join(caseDir, "comments.json"),
        JSON.stringify([{ path: "f.ts", line: 12, body: "[blocker] guard removed" }]),
      );
      // A result dir that cannot be written: the rebuild of the scorer input fails.
      rmSync(join(out, "results", "all"), { recursive: true, force: true });
      writeFileSync(join(out, "results", "all"), "not a dir");
      expect(() => rebuildResults(out, [c], () => {})).toThrow();
      const s = JSON.parse(readFileSync(join(caseDir, "case-summary.json"), "utf8"));
      expect(s.comments.total).toBe(0);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("an unprefetched case's summary is written only after its result files", () => {
    const out = mkdtempSync(join(tmpdir(), "bench-summary-last-"));
    try {
      mkdirSync(join(out, "results"), { recursive: true });
      // A result dir that cannot be made: the write of the scorer input fails.
      writeFileSync(join(out, "results", "all"), "not a dir");
      expect(() =>
        recordUnprefetched(out, c, "no store", { qcr_commit: "x" } as unknown as RunFingerprint),
      ).toThrow();
      expect(existsSync(join(out, "cases", safeId(c.instance_id), "case-summary.json"))).toBe(
        false,
      );
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("the fingerprint tells apart configurations that differ only in a setting no named field records", () => {
    const base = loadConfig(join(ROOT, "tests", "fixtures", "config.toml"));
    const fp = (mut: (cfg: typeof base) => void) => {
      const cfg = structuredClone(base);
      mut(cfg);
      return runFingerprint(cfg, "");
    };
    const same = fp(() => {});
    expect(same).toEqual(runFingerprint(structuredClone(base), ""));
    expect(fp((x) => (x.review.render_outputs = !x.review.render_outputs))).not.toEqual(same);
    expect(fp((x) => (x.review.task_files = !x.review.task_files))).not.toEqual(same);
    expect(
      fp((x) => (x.review.context_pack = x.review.context_pack === "off" ? "pack-first" : "off")),
    ).not.toEqual(same);
    expect(fp((x) => (x.review.lint_conformance = !x.review.lint_conformance))).not.toEqual(same);
    expect(fp((x) => (x.pi.subagent_max_concurrency += 1))).not.toEqual(same);
  });

  it("`--config models.effort` takes the config file's spellings", () => {
    const cfg = loadConfig(join(ROOT, "tests", "fixtures", "config.toml"));
    expect(applyConfigOverrides(cfg, "models.effort=HIGH").models.effort).toBe("high");
    expect(applyConfigOverrides(cfg, "models.effort=med").models.effort).toBe("medium");
    expect(() => applyConfigOverrides(cfg, "models.effort=extreme")).toThrow(
      /--config: .*effort must be/,
    );
  });

  it("`review.preset` finds a [review] header that carries a comment", () => {
    const toml = '[review] # review settings\nnits = "strict"\n\n[models]\neffort = ""\n';
    const out = withPresetInToml(toml, "max");
    expect(out.match(/^\[review\]/gm)).toHaveLength(1);
    expect(out).toContain('[review] # review settings\npreset = "max"\nnits = "strict"');
  });
});

// The AACR-Bench harness (src/bench/, bench/aacr/). What is pinned here:
//
//   1. the case-set contract: only AACR-Bench v1.0, validated shapes, no dupes;
//   2. the git → file-list parse the lens heuristics consume (real statuses,
//      renames, binaries — the replay seam stamped everything `modified`);
//   3. the offline override: every GitHub-bound step replaced, every
//      review-quality step kept, the output files named;
//   4. the conversion to the scorer's shape — above all that a failed case
//      still produces a file (the scorer silently drops a missing one);
//   5. that every lens the bench PLANS is an agent the bench BUILDS — the
//      exact defect that left `qcr regression` unrunnable (bare lens names vs
//      `<lens>--<tier>` agents);
//   6. the sandbox's structural promises: src/bench imports no mutation code,
//      the image carries no scripts/ and no gh;
//   7. the open-code-review baseline arm: OCR run flag-for-flag as the
//      harness's reviewers/ocr.py runs it, its result file in that runner's
//      shape, the pinned binary, the bridge reading only the refresh-disabled
//      token copy, and neither arm able to overwrite the other's run.

import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
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
  selectCases,
  tagOf,
  toOcrResult,
  usageFromEvents,
  type BenchComment,
  type PrefetchMeta,
} from "../src/bench/aacr.js";
import { AuthExpiring, benchAuthFrom, DISABLED_REFRESH, syncBenchAuth } from "../src/bench/auth.js";
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
import { renderOcrReport, roundMetrics } from "../src/bench/report.js";
import {
  boundBody,
  buildBenchAgents,
  benchConfig,
  renderCasePrompts,
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
});

describe("the round the bench runs is the production round", () => {
  const cfg = benchConfig(ROOT, "");
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
    const fence = roundFirst.slice(
      roundFirst.indexOf("<!-- RATIFIED posting-map"),
      roundFirst.indexOf("<!-- /RATIFIED posting-map -->"),
    );
    expect(order).toContain(fence);
    expect(order.indexOf("## 6. Post")).toBeLessThan(order.indexOf("## BENCHMARK MODE"));
    expect(order).not.toMatch(/\{\{[a-z_]+\}\}/);
    expect(order).toContain(`\`${meta.base_ref}\` @ \`${c.base_commit}\``);
    expect(system).toContain(`\`${c.repo}\``);
    expect(system).not.toContain(identityVars(loadConfig(join(ROOT, "config.toml"))).repo);
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

  it("the bench config is production's, with only the profile swapped", () => {
    expect(cfg.review.profile).toBe("");
    const deployed = loadConfig(join(ROOT, "config.toml")).review.profile;
    expect(benchConfig(ROOT, deployed).review.profile).toBe(deployed);
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
    expect(tarList).not.toMatch(/\bdeploy\b|\bstate\b|\.git\b/);
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
    expect(sh).toContain('>> "$HERE/runs/$RUN.sandbox-commands.log"');
    expect(sh).toContain('[[ ! -L "$d" ]]');
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
      // The VM's global settings: bash-guard for every process, all trusted.
      const settings = JSON.parse(readFileSync(join(dst, "settings.json"), "utf8"));
      expect(settings).toEqual({
        extensions: ["/r/extensions/bash-guard.ts"],
        defaultProjectTrust: "always",
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
          ocr_version: "1.3.1",
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
      expect(md).toContain("open-code-review 1.3.1");
      expect(md).toContain("--concurrency 8 --timeout 30 --max-tools 30");
      expect(md).toMatch(/\| \*\*average\*\* \| 10\/1 \| 40 \| 7\/62 \|/);
      expect(md).toMatch(/^\| 1 \| 10\/1 \| 40 \| 8\/62 \|/m);
      expect(md).toMatch(/^\| 2 \| 10\/1 \| 40 \| 6\/62 \|/m);
      expect(md).toContain("| 31 (0) | 120k (60k) / 8k (5k) |");
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
      '[[ "$arm" == ocr ]] && { variants="all"; report_cmd=ocr-report; }',
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

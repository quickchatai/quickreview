// The pi-review arm of the AACR benchmark (src/bench/pireview.ts): the argv,
// the environment, the PI_REVIEW_META_JSON → result conversion the harness and
// the defect judge read, and the no-refresh guarantee on the credential path.
// Stub-based: pi-review itself is replaced by an injected runner; git runs
// against a scratch repo (prepareTree).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { BenchCase, CaseSet, PrefetchMeta } from "../src/bench/aacr.js";
import { DISABLED_REFRESH } from "../src/bench/auth.js";
import { reviewForJudge } from "../src/bench/defects.js";
import { run } from "../src/bench/exec.js";
import { runArmOf, scoredOcrComments } from "../src/bench/ocr.js";
import {
  findingNote,
  isTimeoutExit,
  normalizeFindingPath,
  parsePireviewMeta,
  PIREVIEW_DEFAULTS,
  PIREVIEW_PI_SETTINGS,
  pireviewArgv,
  pireviewCommand,
  pireviewEnv,
  pireviewResultPayload,
  pireviewStatus,
  pireviewTarget,
  pireviewText,
  renderPireviewReport,
  reviewCasePireview,
  runPireviewReview,
  toComments,
  toolCounts,
  unprefetchedPireviewCase,
  type PireviewFingerprint,
} from "../src/bench/pireview.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);

const CASE: BenchCase = {
  instance_id: "acme__widget@bbbbbbb",
  repo: "acme/widget",
  pr: 7,
  pr_url: "https://github.com/acme/widget/pull/7",
  base_commit: BASE,
  head_commit: HEAD,
  language: "Python",
  pr_category: "Bug Fixes",
  change_line_count: 3,
  references: 2,
};
const SET: CaseSet = {
  name: "t",
  dataset: { source: "s", commit: "ab8af8d5c74e", file: "f", sha256: "x" },
  rule: "",
  references: 2,
  cases: [CASE],
} as unknown as CaseSet;
const FP: PireviewFingerprint = {
  qcr_commit: "c",
  pireview_version: "0.18.0",
  pi_version: "0.87.1",
  model: "openai-codex/gpt-6-sol",
  thinking: "medium",
  timeout_min: 30,
};

/** What pi-review 0.18.0 prints on stdout with PI_REVIEW_META_STDOUT=1: the
 * streamed review, its ASCII footer, the meta line. */
const META = {
  metaVersion: 1,
  reviewMode: "code",
  verdict: "request_changes",
  verdictSource: "parsed",
  status: "has_findings",
  findings: [
    {
      id: "F1",
      severity: "high",
      path: "a.py",
      summary: "Off by one in the loop",
      actionable: true,
      details: "Evidence: range(n - 1) skips the last row.\n\nImpact: the last row is never saved.",
      recommendation: "Use range(n).",
      location: { startLine: 2, endLine: 3 },
    },
    {
      id: "F2",
      severity: "medium",
      path: "b.py",
      summary: "Removed guard",
      actionable: true,
      details: "Evidence: the deleted check guarded None.",
      location: { startLine: 9, side: "base" },
    },
    { id: "F3", severity: "low", summary: "No tests for the change", actionable: false },
  ],
  actionableCount: 2,
  durationMs: 42300,
  model: "openai-codex/gpt-6-sol",
  thinking: "medium",
  usage: {
    input: 18031,
    output: 512,
    cacheRead: 2048,
    cacheWrite: 0,
    reasoning: 100,
    totalTokens: 20591,
    costTotal: 0.05,
  },
};
const STDOUT =
  "## Verdict\nrequest_changes\n\n## Findings\n### F1: Off by one in the loop\n- Severity: high\n\n" +
  "── pi-review ────────────────────────────\n  Verdict     ! REQUEST CHANGES\n" +
  "──────────────────────────────────────────\n" +
  `PI_REVIEW_META_JSON: ${JSON.stringify(META)}\n`;

describe("invocation: pi-review's own CLI, its defaults, one target sentence", () => {
  it("argv: model + thinking + progress log, then the diff as @file and the target text", () => {
    const argv = pireviewArgv({
      model: PIREVIEW_DEFAULTS.model,
      thinking: "medium",
      progressLog: "/out/pi-events.jsonl",
      diffFile: "/work/x.pireview/pr.diff",
      base: BASE,
      head: HEAD,
    });
    expect(argv).toEqual([
      "--model",
      "openai-codex/gpt-6-sol",
      "--thinking",
      "medium",
      "--progress-log",
      "/out/pi-events.jsonl",
      "--",
      "@/work/x.pireview/pr.diff",
      pireviewTarget(BASE, HEAD),
    ]);
    // Single review: no panel, loop, mode, tools or rules override of ours.
    for (const f of [
      "--reviewers",
      "--panel",
      "--mode",
      "--tools",
      "--no-rules",
      "--skill",
      "loop",
    ])
      expect(argv).not.toContain(f);
    // The target names WHAT to review, never how.
    expect(pireviewTarget(BASE, HEAD)).toBe(
      `Review the code changes in the attached diff (git diff ${BASE}...${HEAD}). The working directory is the repository checked out at ${HEAD}.`,
    );
  });

  it("runs under coreutils timeout (kills the process group), harness budget + 60 s", () => {
    const c = pireviewCommand({ bin: "pi-review", timeoutMin: 30, argv: ["--", "x"] });
    expect(c).toEqual({ bin: "timeout", args: ["-k", "30s", "1860s", "pi-review", "--", "x"] });
    expect(isTimeoutExit(124)).toBe(true);
    expect(isTimeoutExit(137)).toBe(true);
    expect(isTimeoutExit(1)).toBe(false);
  });

  it("env: the case's agent dir, meta on stdout, phone-home off, no Jev key, no inherited secrets", () => {
    const env = pireviewEnv({
      path: "/usr/bin",
      home: "/w/h",
      tmpDir: "/w/t",
      agentDir: "/tmp/pi-agent-pireview",
    });
    expect(env).toMatchObject({
      HOME: "/w/h",
      PI_CODING_AGENT_DIR: "/tmp/pi-agent-pireview",
      PI_REVIEW_META_STDOUT: "1",
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
    });
    expect(Object.keys(env)).not.toContain("TYPESAFE_API_KEY");
    expect(Object.keys(env)).not.toContain("GH_TOKEN");
    expect(Object.keys(env)).not.toContain("PI_REVIEW_CHILD_EXTENSIONS");
    // pi's defaults for the child — no quickreviewd bash-guard, no extensions.
    expect(PIREVIEW_PI_SETTINGS).toEqual({ defaultProjectTrust: "always" });
  });
});

describe("output → findings: pi-review's PI_REVIEW_META_JSON line", () => {
  it("reads the last meta line and the review text before the footer", () => {
    expect(parsePireviewMeta(STDOUT)).toEqual(META);
    expect(parsePireviewMeta("no meta here")).toBeNull();
    expect(parsePireviewMeta("PI_REVIEW_META_JSON: {broken")).toBeNull();
    const text = pireviewText(STDOUT);
    expect(text.startsWith("## Verdict")).toBe(true);
    expect(text).not.toContain("── pi-review");
    expect(text).not.toContain("PI_REVIEW_META_JSON");
  });

  it("every finding becomes a comment; base-side ones go to the defect judge only", () => {
    const { comments, left } = toComments(META.findings as never, "/work/wt/acme__widget@bbbbbbb");
    expect(comments).toEqual([
      {
        path: "a.py",
        start_line: 2,
        end_line: 3,
        content:
          "Off by one in the loop\n\nEvidence: range(n - 1) skips the last row.\n\nImpact: the last row is never saved.\n\nRecommendation: Use range(n).",
        severity: "high",
      },
      {
        path: "",
        start_line: null,
        end_line: null,
        content: "No tests for the change",
        severity: "low",
      },
    ]);
    expect(left).toEqual([
      {
        path: "b.py",
        line: 9,
        side: "LEFT",
        body: "Removed guard\n\nEvidence: the deleted check guarded None.",
      },
    ]);
    expect(findingNote({ summary: "", actionable: true })).toBe("");
  });

  it("normalizes paths: tree prefix, ./, a/ b/, and a line written into Path", () => {
    const t = "/work/wt/x";
    expect(normalizeFindingPath("/work/wt/x/src/a.ts", t)).toEqual({
      path: "src/a.ts",
      lines: null,
    });
    expect(normalizeFindingPath("./src/a.ts", t)).toEqual({ path: "src/a.ts", lines: null });
    expect(normalizeFindingPath("b/src/a.ts", t)).toEqual({ path: "src/a.ts", lines: null });
    expect(normalizeFindingPath("`src/a.ts:12-14`", t)).toEqual({
      path: "src/a.ts",
      lines: { start: 12, end: 14 },
    });
    const { comments } = toComments([{ summary: "S", actionable: true, path: "src/a.ts:7" }], t);
    expect(comments[0]).toMatchObject({ path: "src/a.ts", start_line: 7, end_line: 7 });
    // A parsed location wins over a line in Path; a single line ends where it starts.
    const two = toComments(
      [{ summary: "S", actionable: true, path: "a.ts:7", location: { startLine: 3 } }],
      t,
    );
    expect(two.comments[0]).toMatchObject({ start_line: 3, end_line: 3 });
  });

  it("status: timeout, no meta, blocked are not ok; needs_human with a parse error still is", () => {
    const m = META as never;
    expect(pireviewStatus({ exitCode: 1, timedOut: false, meta: m })).toBe("ok");
    expect(
      pireviewStatus({
        exitCode: 0,
        timedOut: false,
        meta: { ...META, status: "clean", findings: [] } as never,
      }),
    ).toBe("ok");
    expect(pireviewStatus({ exitCode: 124, timedOut: false, meta: null })).toBe("timeout");
    expect(pireviewStatus({ exitCode: 0, timedOut: true, meta: m })).toBe("timeout");
    expect(pireviewStatus({ exitCode: 4, timedOut: false, meta: null })).toBe("no-output");
    expect(
      pireviewStatus({
        exitCode: 4,
        timedOut: false,
        meta: { ...META, status: "blocked" } as never,
      }),
    ).toBe("failed");
    expect(
      pireviewStatus({
        exitCode: 3,
        timedOut: false,
        meta: { ...META, status: "needs_human" } as never,
      }),
    ).toBe("ok");
  });

  it("the result file: harness keys, OCR-shaped comments the scorer and defect judge read", () => {
    const tmp = mkdtempSync(join(tmpdir(), "bench-pireview-result-"));
    try {
      const { comments } = toComments(META.findings as never, "/t");
      const payload = pireviewResultPayload({
        c: CASE,
        model: "openai-codex/gpt-6-sol",
        startedAt: "t",
        durationSeconds: 12.345,
        exitCode: 1,
        meta: META as never,
        comments,
        stderr: "",
        bench: {},
      });
      expect(payload).toMatchObject({
        reviewer: "pireview",
        instance_id: CASE.instance_id,
        base_commit: BASE,
        head_commit: HEAD,
        review_output_source: "pi_review_meta_json",
        duration_seconds: 12.35,
        token_usage: { input_tokens: 18031, output_tokens: 512, cache_read_input_tokens: 2048 },
      });
      expect(scoredOcrComments(payload)).toBe(2);
      mkdirSync(join(tmp, "results", "all"), { recursive: true });
      writeFileSync(
        join(tmp, "results", "all", `${CASE.instance_id}.json`),
        JSON.stringify(payload),
      );
      mkdirSync(join(tmp, "cases", CASE.instance_id), { recursive: true });
      writeFileSync(
        join(tmp, "cases", CASE.instance_id, "comments.json"),
        JSON.stringify(toComments(META.findings as never, "/t").left),
      );
      const r = reviewForJudge(tmp, CASE.instance_id);
      expect(r.comments.map((c) => [c.path, c.line, c.end_line])).toEqual([
        ["a.py", 2, 3],
        ["", null, null],
        ["b.py (deleted line)", 9, 9],
      ]);
      writeFileSync(join(tmp, "run.json"), JSON.stringify({ reviewer: "pireview" }));
      expect(runArmOf(tmp)).toBe("pireview");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("real output (pi-review 0.18.0 on immich-app__immich@966c3f2, smoke 2026-09-28): meta ↔ Markdown agree", () => {
    const out = readFileSync(join(ROOT, "tests", "fixtures", "pireview-stdout-immich.txt"), "utf8");
    const meta = parsePireviewMeta(out)!;
    expect(meta).toMatchObject({
      metaVersion: 1,
      verdict: "request_changes",
      status: "has_findings",
    });
    const { comments, left } = toComments(meta.findings, "/work/wt/immich-app__immich@966c3f2");
    expect(left).toEqual([]);
    expect(comments.map((c) => [c.path, c.start_line, c.end_line, c.severity])).toEqual([
      ["server/src/repositories/album.repository.ts", 162, 170, "high"],
      ["server/src/repositories/album.repository.ts", 140, 160, "medium"],
    ]);
    expect(
      comments[0]!.content.startsWith("Preserve the full last-modified timestamp\n\nEvidence: "),
    ).toBe(true);
    expect(comments[0]!.content).toContain("\n\nImpact: ");
    expect(comments[0]!.content).toContain("\n\nRecommendation: ");
    // The Markdown the model wrote says the same lines the meta carries.
    const text = pireviewText(out);
    expect(text).toContain("- Lines: 162-170");
    expect(text).toContain("- Lines: 140-160");
    expect(text).not.toContain("PI_REVIEW_META_JSON");
  });

  it("counts the child's tool calls from its event stream", () => {
    const log = [
      JSON.stringify({ type: "tool_execution_start", toolName: "read" }),
      JSON.stringify({ type: "tool_execution_start", toolName: "read" }),
      JSON.stringify({ type: "tool_execution_start", toolName: "grep" }),
      JSON.stringify({ type: "message_end" }),
      "not json",
    ].join("\n");
    expect(toolCounts(log)).toEqual({ read: 2, grep: 1 });
  });
});

describe("one case end to end, pi-review stubbed", () => {
  it("prepares the tree outside the sandbox root, attaches base...head, folds the meta into the result", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "bench-pireview-case-"));
    try {
      const src = join(tmp, "src");
      mkdirSync(src);
      // No auto-maintenance: a commit can leave a detached `git maintenance
      // run --auto` writing into .git, and on a loaded machine it is still
      // there when the copy below walks the directory (a vanished lock file).
      const git = (...a: string[]) =>
        execFileSync(
          "git",
          [
            "-C",
            src,
            "-c",
            "user.email=a@b",
            "-c",
            "user.name=a",
            "-c",
            "maintenance.auto=false",
            "-c",
            "gc.auto=0",
            ...a,
          ],
          {
            encoding: "utf8",
            env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
          },
        ).trim();
      git("init", "-q");
      writeFileSync(join(src, "a.py"), "x = 1\n");
      git("add", "a.py");
      git("commit", "-q", "-m", "base");
      const base = git("rev-parse", "HEAD");
      writeFileSync(join(src, "a.py"), "x = 1\ny = 2\nz = 3\n");
      git("commit", "-q", "-am", "head");
      const head = git("rev-parse", "HEAD");
      const c: BenchCase = { ...CASE, base_commit: base, head_commit: head };
      const store = join(tmp, "store");
      mkdirSync(store);
      execFileSync("cp", ["-r", join(src, ".git"), join(store, c.instance_id)]);
      const meta = {
        instance_id: c.instance_id,
        repo: c.repo,
        pr: 7,
        base_commit: base,
        head_commit: head,
        merge_base: base,
        base_ref: "main",
        base_ref_source: "github-api",
        title: null,
        body: null,
        depth: 2,
        diff: { files: 1, additions: 2, deletions: 0 },
        fetched_at: "t",
      } as PrefetchMeta;
      const work = join(tmp, "work");
      const outDir = join(tmp, "out");
      const seen: {
        bin?: string;
        args?: string[];
        env?: NodeJS.ProcessEnv;
        cwd?: string;
        diff?: string;
      } = {};
      const runImpl: typeof run = async (bin, args, opts = {}) => {
        if (bin !== "timeout") return run(bin, args, opts);
        seen.bin = bin;
        seen.args = args;
        seen.env = opts.env;
        seen.cwd = opts.cwd;
        const at = args.indexOf("--");
        seen.diff = readFileSync(args[at + 1]!.slice(1), "utf8");
        const log = args[args.indexOf("--progress-log") + 1]!;
        writeFileSync(
          log,
          JSON.stringify({ type: "tool_execution_start", toolName: "read" }) + "\n",
        );
        return { code: 1, stdout: STDOUT, stderr: "pi-review: review finished\n", timedOut: false };
      };
      const s = await reviewCasePireview(c, meta, {
        work,
        store,
        outDir,
        agentDir: join(tmp, "agent"),
        pireviewBin: "pi-review",
        model: "openai-codex/gpt-6-sol",
        thinking: "medium",
        timeoutMin: 30,
        fingerprint: FP,
        runImpl,
      });
      expect(s.status).toBe("ok");
      expect(s.merge_base_ok).toBe(true);
      expect(s.comments).toBe(2);
      expect(s.left_side).toBe(1);
      expect(s.findings).toBe(3);
      expect(s.actionable).toBe(2);
      expect(s.verdict).toBe("request_changes");
      expect(s.usage).toEqual({ input: 18031, output: 512, cacheRead: 2048 });
      expect(s.cost_usd).toBe(0.05);
      expect(s.tools).toEqual({ read: 1 });
      expect(seen.args!.slice(0, 4)).toEqual(["-k", "30s", "1860s", "pi-review"]);
      expect(seen.cwd).toBe(join(work, "wt", c.instance_id));
      expect(seen.diff).toContain("+y = 2");
      expect(seen.env!["HOME"]).toContain(`${c.instance_id}.pireview`);
      expect(seen.args!.at(-1)).toBe(pireviewTarget(base, head));
      const result = JSON.parse(
        readFileSync(join(outDir, "results", "all", `${c.instance_id}.json`), "utf8"),
      );
      expect(result.review.comments).toHaveLength(2);
      expect(result.review_output).toHaveLength(3);
      const caseDir = join(outDir, "cases", c.instance_id);
      expect(readFileSync(join(caseDir, "review.md"), "utf8")).toContain("## Verdict");
      expect(JSON.parse(readFileSync(join(caseDir, "comments.json"), "utf8"))).toHaveLength(1);
      expect(existsSync(join(caseDir, "pi-events.jsonl"))).toBe(true);
      // The tree and the scratch (HOME, diff) are gone.
      expect(execFileSync("ls", ["-A", join(work, "wt")], { encoding: "utf8" }).trim()).toBe("");
      expect(existsSync(join(work, `${c.instance_id}.pireview`))).toBe(false);
      const md = renderPireviewReport(SET, outDir, [c]);
      expect(md).toContain(
        "| acme__widget@bbbbbbb | Python | 2 | ok | request_changes | 2 (+1) | 3 (2) |",
      );
      expect(md).toContain("read 1");
      // A rerun into the same run dir that produces nothing must not leave the
      // judge the earlier attempt's body or base-side rows.
      expect(reviewForJudge(outDir, c.instance_id).comments.length).toBe(3);
      const opts = {
        work,
        store,
        outDir,
        agentDir: join(tmp, "agent"),
        pireviewBin: "pi-review",
        model: "openai-codex/gpt-6-sol",
        thinking: "medium",
        timeoutMin: 30,
        fingerprint: FP,
      };
      const silent: typeof run = async (bin, args, o = {}) =>
        bin === "timeout"
          ? { code: 124, stdout: "", stderr: "", timedOut: true }
          : run(bin, args, o);
      const again = await reviewCasePireview(c, meta, { ...opts, runImpl: silent });
      expect(again.status).not.toBe("ok");
      expect(existsSync(join(caseDir, "review.md"))).toBe(false);
      expect(reviewForJudge(outDir, c.instance_id)).toMatchObject({ body: null, comments: [] });
      // …and a case that was never prefetched this time leaves neither behind.
      await reviewCasePireview(c, meta, { ...opts, runImpl });
      expect(existsSync(join(caseDir, "review.md"))).toBe(true);
      unprefetchedPireviewCase(outDir, c, FP, "no store");
      expect(existsSync(join(caseDir, "review.md"))).toBe(false);
      expect(existsSync(join(caseDir, "comments.json"))).toBe(false);
      expect(reviewForJudge(outDir, c.instance_id)).toMatchObject({ body: null, comments: [] });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("the credential: a refresh-disabled copy, never a refresher", () => {
  it("each case re-takes the copy with the refresh token disabled, pi defaults, the source untouched", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "bench-pireview-auth-"));
    try {
      const src = join(tmp, "src");
      const agent = join(tmp, "agent");
      mkdirSync(src);
      const real = JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: "h.p.s",
          refresh: "REAL-REFRESH-TOKEN",
          expires: Date.now() + 5 * 86_400_000,
        },
      });
      writeFileSync(join(src, "auth.json"), real);
      const out = join(tmp, "out");
      const code = await runPireviewReview({
        set: SET,
        cases: [CASE],
        outDir: out,
        work: join(tmp, "work"),
        root: "/opt/quickreview/sandbox",
        store: join(tmp, "store"),
        authSrc: src,
        agentDir: agent,
        pireviewBin: "pi-review",
        pireviewVersion: "0.18.0",
        piVersion: "0.87.1",
        model: "openai-codex/gpt-6-sol",
        thinking: "medium",
        timeoutMin: 30,
        qcrCommit: "c",
        resume: false,
        keepTree: false,
        readMeta: () => {
          throw new Error("not prefetched");
        },
        log: () => {},
      });
      expect(code).toBe(1);
      expect(readFileSync(join(src, "auth.json"), "utf8")).toBe(real);
      const copy = readFileSync(join(agent, "auth.json"), "utf8");
      expect(copy).not.toContain("REAL-REFRESH-TOKEN");
      expect(JSON.parse(copy)["openai-codex"].refresh).toBe(DISABLED_REFRESH);
      // The child pi gets pi's defaults, never the quickreviewd bash-guard settings.
      const settings = readFileSync(join(agent, "settings.json"), "utf8");
      expect(JSON.parse(settings)).toEqual(PIREVIEW_PI_SETTINGS);
      expect(settings).not.toContain("bash-guard");
      expect(JSON.parse(readFileSync(join(out, "run.json"), "utf8")).reviewer).toBe("pireview");
      expect(
        JSON.parse(readFileSync(join(out, "results", "all", `${CASE.instance_id}.json`), "utf8"))
          .review.comments,
      ).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("an expiring token stops the run before any case, never refreshing it", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "bench-pireview-exp-"));
    try {
      const src = join(tmp, "src");
      mkdirSync(src);
      writeFileSync(
        join(src, "auth.json"),
        JSON.stringify({
          "openai-codex": {
            type: "oauth",
            access: "a",
            refresh: "R",
            expires: Date.now() + 60_000,
          },
        }),
      );
      const lines: string[] = [];
      let ran = false;
      const code = await runPireviewReview({
        set: SET,
        cases: [CASE],
        outDir: join(tmp, "out"),
        work: join(tmp, "work"),
        root: "/opt/quickreview/sandbox",
        store: join(tmp, "store"),
        authSrc: src,
        agentDir: join(tmp, "agent"),
        pireviewBin: "pi-review",
        pireviewVersion: "0.18.0",
        piVersion: "0.87.1",
        model: "m",
        thinking: "medium",
        timeoutMin: 30,
        qcrCommit: "c",
        resume: false,
        keepTree: false,
        readMeta: () => {
          ran = true;
          throw new Error("x");
        },
        log: (l) => lines.push(l),
        runImpl: async () => {
          ran = true;
          return { code: 0, stdout: "", stderr: "", timedOut: false };
        },
      });
      expect(code).toBe(1);
      expect(ran).toBe(false);
      expect(lines.join("\n")).toContain("STOPPED");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("--resume under a new model drops every mismatched result BEFORE the loop, so an auth stop cannot score model A under model B", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "bench-pireview-resume-"));
    try {
      const out = join(tmp, "out");
      const SAME: BenchCase = { ...CASE, instance_id: "acme__widget@ccccccc" };
      const fpA: PireviewFingerprint = { ...FP, model: "model-A" };
      const fpB: PireviewFingerprint = { ...FP, model: "model-B" };
      // Case 0 was reviewed under A; case 1 under B (already matches the resume).
      const seed = (c: BenchCase, fp: PireviewFingerprint) => {
        mkdirSync(join(out, "cases", c.instance_id), { recursive: true });
        writeFileSync(
          join(out, "cases", c.instance_id, "case-summary.json"),
          JSON.stringify({
            instance_id: c.instance_id,
            arm: "pireview",
            status: "ok",
            fingerprint: fp,
          }),
        );
        mkdirSync(join(out, "results", "all"), { recursive: true });
        writeFileSync(join(out, "results", "all", `${c.instance_id}.json`), "{}");
      };
      seed(CASE, fpA);
      seed(SAME, fpB);
      const src = join(tmp, "src");
      mkdirSync(src);
      writeFileSync(
        join(src, "auth.json"),
        JSON.stringify({
          "openai-codex": {
            type: "oauth",
            access: "a",
            refresh: "R",
            expires: Date.now() + 60_000,
          },
        }),
      );
      const code = await runPireviewReview({
        set: SET,
        cases: [SAME, CASE],
        outDir: out,
        work: join(tmp, "work"),
        root: "/opt/quickreview/sandbox",
        store: join(tmp, "store"),
        authSrc: src,
        agentDir: join(tmp, "agent"),
        pireviewBin: "pi-review",
        pireviewVersion: fpB.pireview_version,
        piVersion: fpB.pi_version,
        model: fpB.model,
        thinking: fpB.thinking,
        timeoutMin: fpB.timeout_min,
        qcrCommit: fpB.qcr_commit,
        resume: true,
        keepTree: false,
        readMeta: () => {
          throw new Error("x");
        },
        log: () => {},
        runImpl: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }),
      });
      expect(code).toBe(1); // stopped on the expiring login at the mismatched case
      expect(JSON.parse(readFileSync(join(out, "run.json"), "utf8")).model).toBe("model-B");
      // Model A's result is gone, not left to be scored under the model-B label…
      expect(existsSync(join(out, "results", "all", `${CASE.instance_id}.json`))).toBe(false);
      expect(existsSync(join(out, "cases", CASE.instance_id, "case-summary.json"))).toBe(false);
      // …while the matching one is kept.
      expect(existsSync(join(out, "results", "all", `${SAME.instance_id}.json`))).toBe(true);
      expect(existsSync(join(out, "cases", SAME.instance_id, "case-summary.json"))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("the report", () => {
  it("names the endpoint the run recorded — an API-key run never reads as the ChatGPT login", () => {
    const tmp = mkdtempSync(join(tmpdir(), "pireview-report-"));
    try {
      const endpoint = "pi's built-in openai provider (the public OpenAI API), an API key";
      writeFileSync(
        join(tmp, "run.json"),
        JSON.stringify({ reviewer: "pireview", model: "openai/gpt-6-sol", endpoint }),
      );
      const md = renderPireviewReport(SET, tmp, [CASE]);
      expect(md).toContain(`thinking \`?\` — ${endpoint}`);
      expect(md).not.toContain("ChatGPT login");
      writeFileSync(join(tmp, "run.json"), JSON.stringify({ reviewer: "pireview" }));
      expect(renderPireviewReport(SET, tmp, [CASE])).toContain("— endpoint not recorded");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("the sandbox wiring", () => {
  const docker = readFileSync(join(ROOT, "bench", "aacr", "Dockerfile"), "utf8");
  const sh = readFileSync(join(ROOT, "bench", "aacr", "bench.sh"), "utf8");
  const inContainer = readFileSync(join(ROOT, "bench", "aacr", "in-container.sh"), "utf8");
  const arm = readFileSync(join(ROOT, "bench", "aacr", "arm.sh"), "utf8");

  it("pins pi-review 0.18.0 by the tarball's sha512 on the shared runtime (its pi), no GitHub route", () => {
    expect(docker.indexOf("FROM runtime AS pireview")).toBeGreaterThan(0);
    // Above the ocr stage: without BuildKit, every stage above the target builds.
    expect(docker.indexOf("FROM runtime AS pireview")).toBeLessThan(
      docker.indexOf("FROM runtime AS ocr"),
    );
    const stage = docker.slice(
      docker.indexOf("FROM runtime AS pireview"),
      docker.indexOf("FROM runtime AS ocr"),
    );
    expect(stage).toContain("ARG PIREVIEW_VERSION=0.18.0");
    expect(stage).toMatch(/ARG PIREVIEW_SHA512=[0-9a-f]{128}\n/);
    expect(stage).toContain("sha512sum -c -");
    expect(stage).not.toContain("npm install");
    expect(stage).toMatch(/! test -e scripts && ! command -v gh/);
    expect(stage).toContain("PI_OFFLINE=1");
    // The same pi as every other arm: the runtime's one pin.
    expect(docker).toContain("ARG PI_VERSION=1.0.0");
  });

  it("bench.sh, in-container.sh and arm.sh know the arm; the trees sit on /work", () => {
    expect(sh).toContain(
      'pireview) IMAGE="${QCR_BENCH_PIREVIEW_IMAGE:-qcr-bench-pireview:latest}"; TARGET=pireview',
    );
    expect(sh).toContain("REVIEW_ENTRY=pireview-review");
    expect(sh).toContain("oe+=(--mount type=volume,dst=/work)");
    expect(inContainer).toContain("pireview-review)");
    expect(arm).toContain('"$ARM" == pireview || "$ARM" == pragent ]]; then');
    const cli = readFileSync(join(ROOT, "src", "bench", "cli.ts"), "utf8");
    for (const cmd of ["pireview-review", "pireview-report"]) {
      const at = cli.indexOf(`if (f.cmd === "${cmd}")`);
      expect(at, cmd).toBeGreaterThan(0);
      expect(cli.slice(at, at + 600), cmd).toContain('assertArm(outDir, "pireview")');
    }
  });
});

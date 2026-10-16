// The PR-Agent arm of the AACR benchmark (src/bench/pragent.ts +
// bench/aacr/pragent_driver.py): the driver argv and environment, the
// conversion of PR-Agent's /review key issues and /improve suggestions into
// the result file the harness and the defect judge read, per-model pricing,
// and the sandbox wiring. Stub-based: the driver (PR-Agent itself) is replaced
// by an injected runner that writes what the real driver writes; git runs
// against a scratch repo (prepareTree). The real driver runs end to end at
// image build time (`pragent_driver.py --self-test`, Dockerfile).

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { BenchCase, CaseSet, PrefetchMeta } from "../src/bench/aacr.js";
import { CODEX_USD_PER_MTOK, caseCostUsd, ratesFor } from "../src/bench/cost.js";
import { reviewForJudge } from "../src/bench/defects.js";
import { run } from "../src/bench/exec.js";
import { runArmOf } from "../src/bench/ocr.js";
import {
  commandStatus,
  improveFindings,
  normalizePath,
  pragentDriverArgv,
  pragentEnv,
  pragentProcessTimeoutMs,
  renderPragentReport,
  reviewBody,
  reviewCasePragent,
  reviewFindings,
  runPragentReview,
  splitFindings,
  unprefetchedPragentCase,
  PRAGENT_COMMANDS,
  type PragentCapture,
  type PragentFingerprint,
} from "../src/bench/pragent.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const CASE: BenchCase = {
  instance_id: "acme__widget@bbbbbbb",
  repo: "acme/widget",
  pr: 7,
  pr_url: "https://github.com/acme/widget/pull/7",
  base_commit: "a".repeat(40),
  head_commit: "b".repeat(40),
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
  backups: [],
};
const FP: PragentFingerprint = {
  qcr_commit: "c",
  pragent_version: "0.46.0",
  model: "gpt-6.1-sol",
  effort: "medium",
  verbosity: "medium",
  pr_text: true,
  timeout_min: 30,
};

// What pragent_driver.py writes for /review (the shape PR-Agent 0.46.0's
// publish_structured_review hook hands over: YAML block scalars keep a "\n").
const REVIEW_CAP: PragentCapture = {
  command: "review",
  exit: 0,
  pr_title: "Add division",
  pr_text: "pr",
  diff_files: ["calc.py", "util/io.py"],
  structured_review: {
    review: {
      "estimated_effort_to_review_[1-5]": "2\n",
      relevant_tests: "No\n",
      key_issues_to_review: [
        {
          relevant_file: "calc.py\n",
          issue_header: "Possible Bug\n",
          issue_content: "Division by zero when b is 0.\n",
          start_line: 2,
          end_line: 3,
        },
        // no line range → the review body, not a scored comment
        {
          relevant_file: "util/io.py\n",
          issue_header: "Leak\n",
          issue_content: "File handle never closed.\n",
        },
        // a string line and a git a/ prefix, as models sometimes write them
        {
          relevant_file: "b/util/io.py",
          issue_header: "Race",
          issue_content: "Unlocked write.",
          start_line: "9",
        },
      ],
      security_concerns: "SQL injection: the query is formatted from user input.\n",
    },
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  },
  comments: ["## PR Reviewer Guide 🔍\n\n### 🔒 Security concerns\n\nSQL injection: …\n"],
};
const IMPROVE_CAP: PragentCapture = {
  command: "improve",
  exit: 0,
  diff_files: ["calc.py", "util/io.py"],
  suggestions: [
    {
      body: "**Suggestion:** Guard against a zero divisor. [possible bug, importance: 8]",
      relevant_file: "calc.py",
      relevant_lines_start: 3,
      relevant_lines_end: 3,
      original_suggestion: {
        relevant_file: "calc.py\n",
        existing_code: "    return a / b",
        suggestion_content: "Guard against a zero divisor.\n",
        improved_code: "    return a / b if b else 0\n",
        one_sentence_summary: "Guard zero divisor\n",
        label: "possible bug\n",
        score: 8,
      },
    },
    {
      // PR-Agent could not resolve the range (-1 sentinel): unlocated
      body: "x",
      relevant_file: "util/io.py",
      relevant_lines_start: -1,
      relevant_lines_end: -1,
      original_suggestion: {
        suggestion_content: "Close the file.",
        one_sentence_summary: "Close file",
        label: "general",
      },
    },
  ],
};

describe("invocation: PR-Agent's own CLI per command, on its local git provider", () => {
  it("argv: the driver, the tree, the target branch, one command, the model and the bridge", () => {
    const argv = pragentDriverArgv({
      driver: "/opt/quickreview/bench/pragent_driver.py",
      tree: "/t",
      targetBranch: "main",
      out: "/o",
      command: "review",
      model: "gpt-6.1-sol",
      bridgeUrl: "http://127.0.0.1:8766/",
      titleFile: "/s/title.txt",
      bodyFile: "/s/body.txt",
    });
    expect(argv).toEqual([
      "/opt/quickreview/bench/pragent_driver.py",
      "--tree",
      "/t",
      "--target-branch",
      "main",
      "--out",
      "/o",
      "--command",
      "review",
      "--model",
      "gpt-6.1-sol",
      "--api-base",
      "http://127.0.0.1:8766/v1",
      "--title-file",
      "/s/title.txt",
      "--body-file",
      "/s/body.txt",
    ]);
    // Withheld PR text: the local provider's own stand-ins, said out loud.
    expect(
      pragentDriverArgv({
        driver: "d",
        tree: "/t",
        targetBranch: "main",
        out: "/o",
        command: "improve",
        model: "m",
        bridgeUrl: "http://b",
        titleFile: null,
        bodyFile: null,
      }).slice(-1),
    ).toEqual(["--no-pr-text"]);
    // The GitHub App's default pr_commands, in its order.
    expect([...PRAGENT_COMMANDS]).toEqual(["describe", "review", "improve"]);
    expect(pragentProcessTimeoutMs(30)).toBe(1_860_000);
  });

  it("env: fresh HOME, no credential, LiteLLM's bundled price map, every non-loopback request to a dead proxy", () => {
    const env = pragentEnv({ path: "/usr/bin", home: "/h", tmpDir: "/x" });
    expect(env.HOME).toBe("/h");
    expect(env.LITELLM_LOCAL_MODEL_COST_MAP).toBe("True");
    for (const k of [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "http_proxy",
      "https_proxy",
      "all_proxy",
    ])
      expect(env[k], k).toBe("http://127.0.0.1:9");
    expect(env.NO_PROXY).toBe("127.0.0.1,localhost");
    expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    const keys = Object.keys(env).join(" ");
    expect(keys).not.toMatch(/OPENAI|API_KEY|TOKEN|GITHUB|PI_CODING_AGENT_DIR/);
  });

  it("the driver swaps in only its bench provider, and sets the model the documented LiteLLM way", () => {
    const py = readFileSync(join(ROOT, "bench", "aacr", "pragent_driver.py"), "utf8");
    expect(py).toContain("register_git_provider(PROVIDER_ID, make_provider(capture, title, body))");
    expect(py).toContain("class BenchLocalGitProvider(LocalGitProvider):");
    expect(py).toContain('pr_cli.run(inargs=["--pr_url", a.target_branch, a.command])');
    expect(py).toContain('"CONFIG.MODEL": f"openai/{a.model}"');
    expect(py).toContain('"OPENAI.KEY": "loopback-bridge"');
    expect(py).toContain('"CONFIG.FALLBACK_MODELS": []');
    expect(py).toContain('"LITELLM.DROP_PARAMS": True');
    // never PR-Agent's own GitHub route, and no real key anywhere
    expect(py).not.toMatch(/GITHUB\.|github_token|user_token/i);
  });
});

describe("output → findings: key issues and suggestions with lines are comments", () => {
  it("normalizes paths: ./ and a git a/ b/ prefix a diff file does not carry", () => {
    expect(normalizePath(" ./src/a.py\n")).toBe("src/a.py");
    expect(normalizePath("b/util/io.py", ["util/io.py"])).toBe("util/io.py");
    expect(normalizePath("b/x.py", ["b/x.py"])).toBe("b/x.py");
  });

  it("/review: header + content at relevant_file:start-end; a missing range is unlocated", () => {
    const f = reviewFindings(REVIEW_CAP);
    expect(f).toEqual([
      {
        source: "review",
        path: "calc.py",
        start_line: 2,
        end_line: 3,
        content: "Possible Bug\nDivision by zero when b is 0.",
        label: "Possible Bug",
      },
      {
        source: "review",
        path: "util/io.py",
        start_line: null,
        end_line: null,
        content: "Leak\nFile handle never closed.",
        label: "Leak",
      },
      {
        source: "review",
        path: "util/io.py",
        start_line: 9,
        end_line: 9,
        content: "Race\nUnlocked write.",
        label: "Race",
      },
    ]);
    expect(reviewFindings(null)).toEqual([]);
  });

  it("/improve: summary, suggestion and replacement code at the resolved range; -1 is unlocated", () => {
    const f = improveFindings(IMPROVE_CAP);
    expect(f[0]).toEqual({
      source: "improve",
      path: "calc.py",
      start_line: 3,
      end_line: 3,
      content:
        "Guard zero divisor\nGuard against a zero divisor.\n\nSuggested code:\n```\n    return a / b if b else 0\n```",
      label: "possible bug",
      score: 8,
    });
    expect(f[1]).toMatchObject({
      path: "util/io.py",
      start_line: null,
      end_line: null,
      content: "Close file\nClose the file.",
    });
  });

  it("located → OCR-shaped comments; unlocated and the security verdict → the review body", () => {
    const { comments, unlocated } = splitFindings([
      ...reviewFindings(REVIEW_CAP),
      ...improveFindings(IMPROVE_CAP),
    ]);
    expect(comments.map((c) => [c.path, c.start_line, c.end_line])).toEqual([
      ["calc.py", 2, 3],
      ["util/io.py", 9, 9],
      ["calc.py", 3, 3],
    ]);
    expect(comments[0]).toMatchObject({
      content: "Possible Bug\nDivision by zero when b is 0.",
      severity: "Possible Bug",
    });
    expect(unlocated.map((u) => u.source)).toEqual(["review", "improve"]);
    const body = reviewBody(REVIEW_CAP, unlocated);
    expect(body).toContain("## PR Reviewer Guide");
    expect(body).toContain("SQL injection");
    expect(body).toContain("## Findings without a line range");
    expect(body).toContain("`util/io.py`: Leak");
    expect(body).toContain("Close file");
  });

  it("status is what PR-Agent PRODUCED: it exits 0 after a failed model call", () => {
    const ok = { code: 0, timedOut: false };
    expect(commandStatus("review", ok, REVIEW_CAP)).toBe("ok");
    expect(commandStatus("review", ok, { comments: ["Failed to review PR"] })).toBe("failed");
    expect(commandStatus("review", { code: 0, timedOut: true }, REVIEW_CAP)).toBe("timeout");
    expect(commandStatus("review", { code: 1, timedOut: false }, REVIEW_CAP)).toBe("failed");
    expect(commandStatus("review", ok, { ...REVIEW_CAP, error: "boom" })).toBe("failed");
    expect(commandStatus("improve", ok, IMPROVE_CAP)).toBe("ok");
    expect(
      commandStatus("improve", ok, { comments: ["No suggestions found to improve this PR."] }),
    ).toBe("ok");
    // No suggestions: PR-Agent publishes an EMPTY artifact (smoke, immich-app__immich@7e2009f).
    expect(commandStatus("improve", ok, { suggestions: [] })).toBe("ok");
    expect(
      commandStatus("improve", ok, { comments: ["Failed to generate code suggestions for PR"] }),
    ).toBe("failed");
    expect(commandStatus("improve", null, null)).toBe("not-run");
    expect(
      commandStatus("describe", ok, { published_description: { title: null, body: "x" } }),
    ).toBe("ok");
    expect(commandStatus("describe", ok, { comments: ["Failed to generate PR description"] })).toBe(
      "failed",
    );
  });
});

describe("pricing is per model", () => {
  it("gpt-6.1-sol at pi's catalog rates (cache reads half gpt-6-sol's); unknown models unpriced", () => {
    expect(CODEX_USD_PER_MTOK["gpt-6.1-sol"]).toEqual({ input: 2, cacheRead: 0.1, output: 10 });
    expect(ratesFor(undefined)).toEqual(CODEX_USD_PER_MTOK["gpt-6-sol"]);
    expect(ratesFor("gpt-9")).toBeNull();
    const dir = mkdtempSync(join(tmpdir(), "pragent-cost-"));
    try {
      const summary = {
        model: "gpt-6.1-sol",
        bridge: { input_tokens: 1_000_000, cached_tokens: 500_000, output_tokens: 100_000 },
      };
      writeFileSync(join(dir, "case-summary.json"), JSON.stringify(summary));
      // 0.5M × $2 + 0.5M × $0.10 + 0.1M × $10
      expect(caseCostUsd(dir)).toEqual({
        usd: 1 + 0.05 + 1,
        source: "priced",
        model: "gpt-6.1-sol",
      });
      writeFileSync(join(dir, "case-summary.json"), JSON.stringify({ ...summary, model: "gpt-9" }));
      expect(caseCostUsd(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("compare.py carries the same table", () => {
    const py = readFileSync(join(ROOT, "bench", "aacr", "compare.py"), "utf8");
    expect(py).toContain('"gpt-6-sol": {"input": 2, "cacheRead": 0.2, "output": 10}');
    expect(py).toContain('"gpt-6.1-sol": {"input": 2, "cacheRead": 0.1, "output": 10}');
  });
});

// A scratch "prefetched store": a repo with a base and a head commit.
function scratchCase(tmp: string): { c: BenchCase; meta: PrefetchMeta; store: string } {
  const src = join(tmp, "src");
  mkdirSync(src);
  const git = (...a: string[]) =>
    execFileSync("git", ["-C", src, "-c", "user.email=a@b", "-c", "user.name=a", ...a], {
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    }).trim();
  git("init", "-q");
  writeFileSync(join(src, "calc.py"), "def div(a, b):\n    return a\n");
  git("add", "calc.py");
  git("commit", "-q", "-m", "base");
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(src, "calc.py"), "def div(a, b):\n    # divide\n    return a / b\n");
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
    title: "Add division",
    body: "Divides a by b.",
    depth: 2,
    diff: { files: 1, additions: 2, deletions: 0 },
    fetched_at: "t",
  } as PrefetchMeta;
  return { c, meta, store };
}

describe("one case end to end, PR-Agent stubbed", () => {
  it("branches the target at base, runs /review then /improve, folds both into the result, prices at gpt-6.1-sol", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "bench-pragent-case-"));
    try {
      const { c, meta, store } = scratchCase(tmp);
      const root = join(tmp, "root");
      const outDir = join(tmp, "out");
      mkdirSync(join(root, "wt"), { recursive: true });
      const seen: Array<{
        argv: string[];
        cwd?: string;
        env?: NodeJS.ProcessEnv;
        branches: string;
        title: string;
        body: string;
      }> = [];
      const runImpl: typeof run = async (bin, args, opts = {}) => {
        if (bin !== "/venv/bin/python") return run(bin, args, opts);
        const at = (k: string) => args[args.indexOf(k) + 1]!;
        const tree = at("--tree");
        const branches = execFileSync(
          "git",
          ["-C", tree, "for-each-ref", "refs/heads", "--format=%(refname:short) %(objectname)"],
          {
            encoding: "utf8",
          },
        ).trim();
        seen.push({
          argv: args,
          cwd: opts.cwd,
          env: opts.env,
          branches,
          title: readFileSync(at("--title-file"), "utf8"),
          body: readFileSync(at("--body-file"), "utf8"),
        });
        const cmd = at("--command");
        const cap =
          cmd === "describe"
            ? {
                command: cmd,
                exit: 0,
                published_description: {
                  title: null,
                  body: "<!-- pr-agent-generated -->\nAI summary + Divides a by b.",
                },
              }
            : cmd === "review"
              ? REVIEW_CAP
              : IMPROVE_CAP;
        writeFileSync(join(at("--out"), `${cmd}.json`), JSON.stringify(cap));
        writeFileSync(join(at("--out"), `${cmd}.md`), `# ${cmd}\n`);
        return { code: 0, stdout: `pr-agent ${cmd} log`, stderr: "", timedOut: false };
      };
      let stats = 0;
      const fetchImpl = (async (url: string) => {
        const u = String(url);
        const body = u.endsWith("/stats")
          ? {
              requests: stats,
              ok: stats,
              errors: 0,
              upstream_refusals: 0,
              input_tokens: 250_000 * stats,
              cached_tokens: 100_000 * stats,
              output_tokens: 10_000 * stats,
              reasoning_tokens: 2_000 * stats,
              by_status: { "200": stats },
              dropped_keys: {},
            }
          : { ok: true };
        if (u.endsWith("/stats")) stats += 3;
        return new Response(JSON.stringify(body), { status: 200 });
      }) as unknown as typeof fetch;
      const s = await reviewCasePragent(c, meta, {
        root,
        store,
        outDir,
        python: "/venv/bin/python",
        driver: "/opt/quickreview/bench/pragent_driver.py",
        bridgeUrl: "http://127.0.0.1:8766",
        model: "gpt-6.1-sol",
        timeoutMin: 30,
        prText: true,
        fingerprint: FP,
        fetchImpl,
        runImpl,
      });
      expect(s.status).toBe("ok");
      expect(s.merge_base_ok).toBe(true);
      expect(s.target_branch).toBe("main");
      expect(seen.map((x) => x.argv[x.argv.indexOf("--command") + 1])).toEqual([
        "describe",
        "review",
        "improve",
      ]);
      // /describe reads the author's body; the next two read what /describe published, as on GitHub.
      expect(seen.map((x) => x.body)).toEqual([
        "Divides a by b.",
        "<!-- pr-agent-generated -->\nAI summary + Divides a by b.",
        "<!-- pr-agent-generated -->\nAI summary + Divides a by b.",
      ]);
      expect(s.described).toBe(true);
      // The local provider's target is a LOCAL branch at the PR's base commit.
      expect(seen[0]!.branches).toBe(`main ${c.base_commit}`);
      expect(seen[0]!.cwd).toContain(join("wt", c.instance_id));
      expect(seen[0]!.title).toBe("Add division");
      expect(seen[0]!.env!["HTTPS_PROXY"]).toBe("http://127.0.0.1:9");
      expect(s.comments).toBe(3);
      expect(s.review_findings).toBe(3);
      expect(s.improve_findings).toBe(2);
      expect(s.unlocated).toBe(2);
      expect(s.model).toBe("gpt-6.1-sol");
      expect(s.bridge).toMatchObject({
        requests: 3,
        input_tokens: 750_000,
        cached_tokens: 300_000,
      });
      expect(s.usage).toEqual({ input: 450_000, cacheRead: 300_000, output: 30_000 });
      const caseDir = join(outDir, "cases", c.instance_id);
      // 0.45M × $2 + 0.3M × $0.10 + 0.03M × $10
      expect(caseCostUsd(caseDir)?.usd).toBeCloseTo(0.9 + 0.03 + 0.3, 10);
      const result = JSON.parse(
        readFileSync(join(outDir, "results", "all", `${c.instance_id}.json`), "utf8"),
      );
      expect(result.reviewer).toBe("pragent");
      expect(result.review.comments).toHaveLength(3);
      expect(result.review_output.review.security_concerns).toContain("SQL injection");
      expect(result.token_usage).toMatchObject({
        input_tokens: 750_000,
        cached_input_tokens: 300_000,
        output_tokens: 30_000,
      });
      // The defect judge reads the same comments and the body.
      const j = reviewForJudge(outDir, c.instance_id);
      expect(j.comments.map((x) => [x.path, x.line, x.end_line])).toEqual([
        ["calc.py", 2, 3],
        ["util/io.py", 9, 9],
        ["calc.py", 3, 3],
      ]);
      expect(j.body).toContain("SQL injection");
      expect(j.body).toContain("Findings without a line range");
      for (const f of [
        "pragent-review.json",
        "pragent-improve.json",
        "pragent-review.log",
        "pragent-argv.json",
      ])
        expect(readdirSync(caseDir), f).toContain(f);
      // The scratch (PR-Agent's HOME, its outputs) and the tree are gone.
      expect(readdirSync(join(root, "wt"))).toEqual([]);
      const md = renderPragentReport(SET, outDir, [c]);
      expect(md).toContain(
        "| acme__widget@bbbbbbb | Python | 2 | ok | 3 | ok | ok (3) | ok (2) | 2 |",
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("a model failure (PR-Agent exits 0, says 'Failed to review PR') is a failed case that keeps what /improve found", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "bench-pragent-fail-"));
    try {
      const { c, meta, store } = scratchCase(tmp);
      const root = join(tmp, "root");
      const outDir = join(tmp, "out");
      mkdirSync(join(root, "wt"), { recursive: true });
      const runImpl: typeof run = async (bin, args, opts = {}) => {
        if (bin !== "py") return run(bin, args, opts);
        const at = (k: string) => args[args.indexOf(k) + 1]!;
        const cmd = at("--command");
        const cap =
          cmd === "describe"
            ? { command: cmd, exit: 0, published_description: { body: "d" } }
            : cmd === "review"
              ? { command: cmd, exit: 0, comments: ["Failed to review PR"] }
              : IMPROVE_CAP;
        writeFileSync(join(at("--out"), `${cmd}.json`), JSON.stringify(cap));
        return { code: 0, stdout: "", stderr: "", timedOut: false };
      };
      const s = await reviewCasePragent(
        c,
        { ...meta, title: null, body: null },
        {
          root,
          store,
          outDir,
          python: "py",
          driver: "d",
          bridgeUrl: "http://127.0.0.1:1",
          model: "gpt-6.1-sol",
          timeoutMin: 30,
          prText: false,
          fingerprint: { ...FP, pr_text: false },
          runImpl,
        },
      );
      expect(s.status).toBe("failed");
      expect(s.commands.review.status).toBe("failed");
      expect(s.commands.improve.status).toBe("ok");
      expect(s.error).toContain("Failed to review PR");
      expect(s.comments).toBe(1);
      expect(s.bridge).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("an attempt that produces no review body removes the body an earlier attempt left", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "bench-pragent-stale-"));
    try {
      const { c, meta, store } = scratchCase(tmp);
      const root = join(tmp, "root");
      const outDir = join(tmp, "out");
      mkdirSync(join(root, "wt"), { recursive: true });
      const caseDir = join(outDir, "cases", c.instance_id);
      mkdirSync(caseDir, { recursive: true });
      writeFileSync(join(caseDir, "review.md"), "an earlier attempt's SQL injection finding\n");
      const runImpl: typeof run = async (bin, args, opts = {}) => {
        if (bin !== "py") return run(bin, args, opts);
        return { code: 1, stdout: "", stderr: "boom", timedOut: false };
      };
      const s = await reviewCasePragent(
        c,
        { ...meta, title: null, body: null },
        {
          root,
          store,
          outDir,
          python: "py",
          driver: "d",
          bridgeUrl: "http://127.0.0.1:1",
          model: "gpt-6.1-sol",
          timeoutMin: 30,
          prText: false,
          fingerprint: { ...FP, pr_text: false },
          runImpl,
          log: () => {},
        },
      );
      expect(s.status).toBe("failed");
      expect(readdirSync(caseDir)).not.toContain("review.md");
      expect(reviewForJudge(outDir, c.instance_id).body).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("the run", () => {
  it("run.json names the arm; an unprefetched case gets a zero-comment result; --resume drops a different model's results first", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "bench-pragent-run-"));
    try {
      const src = join(tmp, "src");
      mkdirSync(src);
      const jwtPayload = Buffer.from(
        JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc" } }),
      ).toString("base64url");
      writeFileSync(
        join(src, "auth.json"),
        JSON.stringify({
          "openai-codex": {
            type: "oauth",
            access: `h.${jwtPayload}.s`,
            refresh: "R",
            expires: Date.now() + 5 * 86_400_000,
          },
        }),
      );
      const out = join(tmp, "out");
      // An earlier result by another model.
      mkdirSync(join(out, "cases", CASE.instance_id), { recursive: true });
      writeFileSync(
        join(out, "cases", CASE.instance_id, "case-summary.json"),
        JSON.stringify({
          arm: "pragent",
          status: "ok",
          fingerprint: { ...FP, model: "gpt-6-sol" },
        }),
      );
      writeFileSync(join(out, "cases", CASE.instance_id, "review.md"), "the other model's body\n");
      const base = {
        set: SET,
        cases: [CASE],
        outDir: out,
        root: join(tmp, "root"),
        store: join(tmp, "store"),
        authSrc: src,
        agentDir: join(tmp, "agent"),
        python: "py",
        driver: "d",
        pragentVersion: "0.46.0",
        bridgeUrl: "http://127.0.0.1:1",
        model: "gpt-6.1-sol",
        effort: "medium",
        verbosity: "medium",
        timeoutMin: 30,
        prText: true,
        qcrCommit: "c",
        keepTree: false,
        readMeta: () => {
          throw new Error("not prefetched");
        },
        log: () => {},
      };
      const code = await runPragentReview({ ...base, resume: true });
      expect(code).toBe(1);
      const rec = JSON.parse(readFileSync(join(out, "run.json"), "utf8"));
      expect(rec.reviewer).toBe("pragent");
      expect(rec.commands).toEqual(["describe", "review", "improve"]);
      expect(runArmOf(out)).toBe("pragent");
      const s = JSON.parse(
        readFileSync(join(out, "cases", CASE.instance_id, "case-summary.json"), "utf8"),
      );
      expect(s.fingerprint.model).toBe("gpt-6.1-sol");
      expect(s.status).toBe("failed");
      expect(readdirSync(join(out, "cases", CASE.instance_id))).not.toContain("review.md");
      expect(
        JSON.parse(readFileSync(join(out, "results", "all", `${CASE.instance_id}.json`), "utf8"))
          .review.comments,
      ).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("--resume drops a result the bridge produced at another text verbosity, and keeps one at the same", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "bench-pragent-verbosity-"));
    try {
      const src = join(tmp, "src");
      mkdirSync(src);
      const jwtPayload = Buffer.from(
        JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc" } }),
      ).toString("base64url");
      writeFileSync(
        join(src, "auth.json"),
        JSON.stringify({
          "openai-codex": {
            type: "oauth",
            access: `h.${jwtPayload}.s`,
            refresh: "R",
            expires: Date.now() + 5 * 86_400_000,
          },
        }),
      );
      const out = join(tmp, "out");
      const summaryFile = join(out, "cases", CASE.instance_id, "case-summary.json");
      const base = {
        set: SET,
        cases: [CASE],
        outDir: out,
        root: join(tmp, "root"),
        store: join(tmp, "store"),
        authSrc: src,
        agentDir: join(tmp, "agent"),
        python: "py",
        driver: "d",
        pragentVersion: "0.46.0",
        bridgeUrl: "http://127.0.0.1:1",
        model: "gpt-6.1-sol",
        effort: "medium",
        verbosity: "low",
        timeoutMin: 30,
        prText: true,
        qcrCommit: "c",
        keepTree: false,
        resume: true,
        readMeta: () => {
          throw new Error("not prefetched");
        },
        log: () => {},
      };
      const seed = (verbosity: string) => {
        mkdirSync(join(out, "cases", CASE.instance_id), { recursive: true });
        writeFileSync(
          summaryFile,
          JSON.stringify({ arm: "pragent", status: "ok", fingerprint: { ...FP, verbosity } }),
        );
      };
      // Reviewed at medium, resumed at low: the result goes.
      seed("medium");
      await runPragentReview(base);
      let s = JSON.parse(readFileSync(summaryFile, "utf8"));
      expect(s.status).toBe("failed");
      expect(s.fingerprint.verbosity).toBe("low");
      // Reviewed at low, resumed at low: the result stays.
      seed("low");
      await runPragentReview(base);
      s = JSON.parse(readFileSync(summaryFile, "utf8"));
      expect(s.status).toBe("ok");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("a run stopped before reviewing a dropped case leaves none of its judge inputs behind", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "bench-pragent-stop-"));
    try {
      const src = join(tmp, "src");
      mkdirSync(src);
      const jwtPayload = Buffer.from(
        JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc" } }),
      ).toString("base64url");
      // A login that expires before one case could finish: the run stops first.
      writeFileSync(
        join(src, "auth.json"),
        JSON.stringify({
          "openai-codex": {
            type: "oauth",
            access: `h.${jwtPayload}.s`,
            refresh: "R",
            expires: Date.now() + 60_000,
          },
        }),
      );
      const out = join(tmp, "out");
      const caseDir = join(out, "cases", CASE.instance_id);
      mkdirSync(caseDir, { recursive: true });
      writeFileSync(
        join(caseDir, "case-summary.json"),
        JSON.stringify({
          arm: "pragent",
          status: "ok",
          fingerprint: { ...FP, model: "gpt-6-sol" },
        }),
      );
      // A body-only review: its saved judgement keys on the body alone.
      writeFileSync(join(caseDir, "review.md"), "the other model's body-only finding\n");
      const lines: string[] = [];
      const code = await runPragentReview({
        set: SET,
        cases: [CASE],
        outDir: out,
        root: join(tmp, "root"),
        store: join(tmp, "store"),
        authSrc: src,
        agentDir: join(tmp, "agent"),
        python: "py",
        driver: "d",
        pragentVersion: "0.46.0",
        bridgeUrl: "http://127.0.0.1:1",
        model: "gpt-6.1-sol",
        effort: "medium",
        verbosity: "medium",
        timeoutMin: 30,
        prText: true,
        qcrCommit: "c",
        keepTree: false,
        resume: true,
        readMeta: () => {
          throw new Error("not prefetched");
        },
        log: (l) => lines.push(l),
      });
      expect(code).toBe(1);
      expect(lines.some((l) => l.includes("STOPPED"))).toBe(true);
      expect(readdirSync(caseDir)).not.toContain("case-summary.json");
      expect(readdirSync(caseDir)).not.toContain("review.md");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("the report", () => {
  it("names the endpoint run.json recorded, the API-key route included", () => {
    const tmp = mkdtempSync(join(tmpdir(), "bench-pragent-report-"));
    try {
      const api =
        "the public OpenAI API (API key) via the loopback bridge (bench/aacr/codex_bridge.py)";
      writeFileSync(join(tmp, "run.json"), JSON.stringify({ reviewer: "pragent", endpoint: api }));
      const md = renderPragentReport(SET, tmp, []);
      expect(md).toContain(`— ${api}, Chat Completions`);
      expect(md).not.toContain("ChatGPT Codex backend");
      writeFileSync(join(tmp, "run.json"), JSON.stringify({ reviewer: "pragent" }));
      expect(renderPragentReport(SET, tmp, [])).toContain(
        "— ChatGPT Codex backend via the loopback bridge (bench/aacr/codex_bridge.py), Chat Completions",
      );
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

  it("pins pr-agent 0.46.0 by the wheel's sha256 on the shared runtime (trixie), self-tested, no GitHub route", () => {
    const at = docker.indexOf("FROM runtime AS pragent");
    expect(at).toBeGreaterThan(docker.indexOf("FROM runtime AS claude"));
    const stage = docker.slice(at);
    expect(stage).toContain("ARG PRAGENT_VERSION=0.46.0");
    expect(stage).toMatch(/ARG PRAGENT_SHA256=[0-9a-f]{64}\n/);
    expect(stage).toContain("--no-deps --only-binary=:all:");
    expect(stage).toContain("sha256sum -c -");
    expect(stage).toContain("pragent_driver.py --self-test");
    expect(stage).toContain("codex_bridge.py --self-test");
    expect(stage).toMatch(/! test -e scripts && ! command -v gh/);
  });

  it("bench.sh, in-container.sh and arm.sh know the arm; its bridge serves gpt-6.1-sol; eval scores `all`", () => {
    expect(sh).toContain(
      'pragent) IMAGE="${QCR_BENCH_PRAGENT_IMAGE:-qcr-bench-pragent:latest}"; TARGET=pragent',
    );
    expect(sh).toContain("REVIEW_ENTRY=pragent-review");
    expect(sh).toContain("bench/aacr/pragent_driver.py");
    // The served model is a bench.sh knob (gpt-6-sol for parity with the other arms).
    expect(sh).toContain('oe+=(-e "PRAGENT_BRIDGE_MODEL=$QCR_BENCH_PRAGENT_MODEL")');
    expect(inContainer).toContain("pragent-review)");
    expect(inContainer).toContain(
      '--model "${PRAGENT_BRIDGE_MODEL:-gpt-6.1-sol}" --effort "${PRAGENT_BRIDGE_EFFORT:-medium}"',
    );
    expect(inContainer).toContain(
      '[[ "$arm" != qcr ]] && { variants="all"; report_cmd="$arm-report"; }',
    );
    expect(arm).toContain('"$ARM" == pragent ]]; then');
    const cli = readFileSync(join(ROOT, "src", "bench", "cli.ts"), "utf8");
    for (const cmd of ["pragent-review", "pragent-report"]) {
      const i = cli.indexOf(`if (f.cmd === "${cmd}")`);
      expect(i, cmd).toBeGreaterThan(0);
      expect(cli.slice(i, i + 600), cmd).toContain('assertArm(outDir, "pragent")');
    }
  });
});

describe("what an attempt and a run leave behind", () => {
  const authSrc = (tmp: string): string => {
    const src = join(tmp, "src-auth");
    mkdirSync(src);
    const jwtPayload = Buffer.from(
      JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc" } }),
    ).toString("base64url");
    writeFileSync(
      join(src, "auth.json"),
      JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: `h.${jwtPayload}.s`,
          refresh: "R",
          expires: Date.now() + 5 * 86_400_000,
        },
      }),
    );
    return src;
  };
  const runBase = (tmp: string, out: string) => ({
    set: SET,
    cases: [CASE],
    outDir: out,
    root: join(tmp, "root"),
    store: join(tmp, "store"),
    authSrc: authSrc(tmp),
    agentDir: join(tmp, "agent"),
    python: "py",
    driver: "d",
    pragentVersion: "0.46.0",
    bridgeUrl: "http://127.0.0.1:1",
    model: "gpt-6.1-sol",
    effort: "medium",
    verbosity: "medium",
    timeoutMin: 30,
    prText: true,
    qcrCommit: "c",
    keepTree: false,
    readMeta: (): PrefetchMeta => {
      throw new Error("not prefetched");
    },
    log: () => {},
  });

  it("a failed attempt keeps none of an earlier attempt's PR-Agent captures", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "bench-pragent-captures-"));
    try {
      const { c, meta, store } = scratchCase(tmp);
      const root = join(tmp, "root");
      const outDir = join(tmp, "out");
      mkdirSync(join(root, "wt"), { recursive: true });
      const caseDir = join(outDir, "cases", c.instance_id);
      mkdirSync(caseDir, { recursive: true });
      for (const f of ["pragent-review.json", "pragent-improve.md", "pragent-argv.json"])
        writeFileSync(join(caseDir, f), "an earlier attempt's\n");
      const runImpl: typeof run = async (bin, args, opts = {}) => {
        if (bin !== "py") return run(bin, args, opts);
        return { code: 1, stdout: "", stderr: "boom", timedOut: false };
      };
      await reviewCasePragent(
        c,
        { ...meta, title: null, body: null },
        {
          root,
          store,
          outDir,
          python: "py",
          driver: "d",
          bridgeUrl: "http://127.0.0.1:1",
          model: "gpt-6.1-sol",
          timeoutMin: 30,
          prText: false,
          fingerprint: { ...FP, pr_text: false },
          runImpl,
          log: () => {},
        },
      );
      const left = readdirSync(caseDir);
      expect(left).not.toContain("pragent-review.json");
      expect(left).not.toContain("pragent-improve.md");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("a run that rewrites results drops the metrics that scored them; a resume that skips every case keeps them", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "bench-pragent-metrics-"));
    try {
      const out = join(tmp, "out");
      const all = join(out, "results", "all");
      const base = runBase(tmp, out);
      const metrics = join(all, "metrics_ocr_round_1.json");
      // A finished, scored run at this configuration: a resume skips the case.
      mkdirSync(join(out, "cases", CASE.instance_id), { recursive: true });
      mkdirSync(all, { recursive: true });
      writeFileSync(
        join(out, "cases", CASE.instance_id, "case-summary.json"),
        JSON.stringify({
          arm: "pragent",
          status: "ok",
          fingerprint: {
            ...FP,
            qcr_commit: "c",
            effort: "medium",
            verbosity: "medium",
            pr_text: true,
            timeout_min: 30,
          },
        }),
      );
      writeFileSync(join(all, `${CASE.instance_id}.json`), "{}\n");
      writeFileSync(metrics, "{}\n");
      await runPragentReview({ ...base, resume: true });
      expect(readdirSync(all)).toContain("metrics_ocr_round_1.json");
      // Run again without --resume: the case is reviewed again, the score goes.
      await runPragentReview({ ...base, resume: false });
      expect(readdirSync(all).filter((n) => n.startsWith("metrics_"))).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("the report opens with what the score measures", () => {
    const tmp = mkdtempSync(join(tmpdir(), "bench-pragent-preamble-"));
    try {
      expect(renderPragentReport(SET, tmp, [])).toContain("_What this measures:");
      const aacr = {
        ...SET,
        dataset: {
          ...SET.dataset,
          commit: "ab8af8d5c74e2a4d1945d247ea4bbc49f93eb33f",
          sha256: "d8683cb240249bc4e0aff6428802bdffa7b7573ace600552cab1cd0cb7e905c9",
        },
      };
      const md = renderPragentReport(aacr, tmp, []);
      expect(md).toContain("AACR-Bench's reference comments (74% AI-written");
      expect(md).toContain("- Dataset: AACR-Bench v1.0 (1,505 references)");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("the completion mark", () => {
  it("a case's summary is written only after its result file", () => {
    const tmp = mkdtempSync(join(tmpdir(), "bench-pragent-order-"));
    try {
      mkdirSync(join(tmp, "results"), { recursive: true });
      // A result dir that cannot be made: the write of the scorer input fails.
      writeFileSync(join(tmp, "results", "all"), "not a dir");
      expect(() => unprefetchedPragentCase(tmp, CASE, FP, "no store")).toThrow();
      expect(readdirSync(join(tmp, "cases", CASE.instance_id))).not.toContain("case-summary.json");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

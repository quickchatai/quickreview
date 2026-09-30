// The Claude Code arm of the AACR benchmark (src/bench/claudecode.ts,
// bench/aacr/claude_driver.py, `bench.sh --arm claude`). Root CLAUDE.md rule 5
// forbids spawning `claude`, with ONE ratified exception (2026-09-28):
// Claude Code as a BENCHMARKED REVIEWER inside the locked-down bench/aacr
// sandbox only. What is pinned here:
//   1. the argv the harness's reviewers/claude.py runs, checked flag for flag
//      (the fixture is the argv the pinned runner produced in the image);
//   2. the credential: its own env-file, exactly one of the two variables, no
//      host environment riding along, and a refusal that says how to make one;
//   3. the harness's result file read the way its scorer reads it, and an auth
//      failure (which Claude Code reports with exit 0) never read as a review;
//   4. nothing reads or mounts the host's ~/.claude;
//   5. THE FENCE: no host-side code path spawns `claude` — the only route to it
//      is in-container.sh → cli claude-review → claude_driver.py → the harness.
// Everything runs against stubs: no container, no model, no `claude` binary.
import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BenchCase, CaseSet, PrefetchMeta } from "../src/bench/aacr.js";
import {
  CLAUDE_HARNESS_DEFAULTS,
  CLAUDE_HARNESS_FLAGS,
  checkHarnessArgv,
  claudeEnv,
  claudeFinalText,
  changedFilesFromStore,
  claudeProcessTimeoutMs,
  claudeRebuildRun,
  claudeRepoPath,
  claudeReviewRun,
  claudeRowsForJudge,
  claudeScoredFindings,
  emptyClaudeResult,
  pickCredential,
  readClaudeSummary,
  renderClaudeReport,
  summarizeClaudeResult,
  withClaudeView,
} from "../src/bench/claudecode.js";
import { reviewForJudge } from "../src/bench/defects.js";
import { runArmOf } from "../src/bench/ocr.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const B = join(ROOT, "bench", "aacr");
const BASE = "6ba94ac2f2f78c871f56874a7c2ff61b2ff4a06b";
const HEAD = "966c3f22d034c230a14bb21b02627ef6d00eec68";
const REPO = "/work/repo/immich-app__immich";

// The argv the PINNED harness runner (aacr-bench 68a5697, reviewers/claude.py
// run_claude_review) produced inside qcr-bench-claude on 2026-09-28, recorded
// by claude_driver.py from CompletedProcess.args.
const SYSTEM_PROMPT =
  "STRUCTURED OUTPUT REQUIREMENT (highest priority):\nYou have an MCP tool named `mcp__findings__report`. The moment you confirm any individual code-review finding, immediately call this tool once for that single finding — do not wait until the end or batch them into one final message.\nThe tool is already bound to the instance under review, so you do NOT pass any instance id. For every call provide ONLY the finding itself:\n  - file: path relative to the repository root\n  - line: the 1-based line number, or omit it if not applicable\n  - summary: a concise description of the issue\n  - failure_scenario: a concrete failure scenario plus the suggested fix\nCall the tool exactly once per finding, in addition to whatever you normally print. Any finding not sent through this tool will be lost.";
const HARNESS_ARGV = [
  "claude",
  "-p",
  `/code-review ${BASE}...${HEAD} `,
  "--add-dir",
  REPO,
  "--permission-mode",
  "acceptEdits",
  "--output-format",
  "json",
  "--mcp-config",
  JSON.stringify({
    mcpServers: {
      findings: {
        type: "stdio",
        command: "/opt/aacr-venv/bin/python",
        args: ["/opt/aacr-bench/evaluation/mcp_finding_server.py"],
        env: {
          REVIEW_RESULTS_DIR: "/bench-out/results/all",
          REVIEW_INSTANCE_ID: "immich-app__immich@966c3f2",
        },
      },
    },
  }),
  "--allowed-tools",
  "mcp__findings__report",
  "--append-system-prompt",
  SYSTEM_PROMPT,
  "--settings",
  "/tmp/claude-home/immich-app__immich@966c3f2.tmp/claude_settings_bv3siq3p.json",
];

// What Claude Code 2.1.283 printed with an invalid OAuth token: exit 0,
// is_error false, subtype success — the failure is only in `result`.
const AUTH_FAILURE_STDOUT = JSON.stringify({
  is_error: false,
  num_turns: 0,
  total_cost_usd: 0,
  modelUsage: {},
  subtype: "success",
  result: "Failed to authenticate. API Error: 401 OAuth access token is invalid.",
  local_command: "code_review",
  type: "result",
});

describe("the harness's argv, flag for flag", () => {
  it("accepts exactly what reviewers/claude.py runs", () => {
    expect(CLAUDE_HARNESS_FLAGS).toEqual([
      "--add-dir",
      "--permission-mode",
      "--output-format",
      "--mcp-config",
      "--allowed-tools",
      "--append-system-prompt",
      "--settings",
    ]);
    expect(checkHarnessArgv(HARNESS_ARGV, { repo: REPO, base: BASE, head: HEAD })).toEqual([]);
    // pipeline.py apply_defaults: 30 min; reviewers/claude.py: ×60 + 60 s.
    expect(CLAUDE_HARNESS_DEFAULTS.timeoutMin).toBe(30);
    expect(claudeProcessTimeoutMs(30)).toBe(1_860_000);
    // The harness's layout: repo/<owner>__<name>.
    expect(claudeRepoPath("/work", "immich-app/immich")).toBe(REPO);
  });

  it("names every drift from it", () => {
    const at = (i: number, v: string) => HARNESS_ARGV.map((x, k) => (k === i ? v : x));
    const o = { repo: REPO, base: BASE, head: HEAD };
    const cases: Array<[string[], RegExp]> = [
      [at(0, "/usr/bin/claude"), /argv\[0\]/],
      [at(2, `/code-review ${BASE}...${HEAD}`), /prompt/], // the trailing space is the harness's
      [at(2, `/review ${BASE}...${HEAD} `), /prompt/],
      [at(4, "/somewhere/else"), /--add-dir/],
      [at(6, "bypassPermissions"), /permission-mode/],
      [at(8, "stream-json"), /output-format/],
      [at(10, '{"mcpServers":{}}'), /findings server/],
      [at(12, "Bash"), /allowed-tools/],
      [at(14, "be terse"), /findings requirement/],
      [HARNESS_ARGV.slice(0, -2), /trailing args/],
      [[...HARNESS_ARGV, "--model", "opus"], /trailing args/],
    ];
    for (const [argv, why] of cases) {
      const bad = checkHarnessArgv(argv, o);
      expect(bad.join("; "), why.source).toMatch(why);
    }
    expect(checkHarnessArgv("claude -p", o)).toEqual(["argv is not a list of strings"]);
  });
});

describe("the credential is its own, and only it rides", () => {
  it("takes exactly one of the two variables", () => {
    expect(pickCredential({ CLAUDE_CODE_OAUTH_TOKEN: "t1" })).toEqual({
      kind: "oauth-token",
      vars: { CLAUDE_CODE_OAUTH_TOKEN: "t1" },
    });
    expect(pickCredential({ ANTHROPIC_API_KEY: "k1" })).toEqual({
      kind: "api-key",
      vars: { ANTHROPIC_API_KEY: "k1" },
    });
    expect(() => pickCredential({ CLAUDE_CODE_OAUTH_TOKEN: "t", ANTHROPIC_API_KEY: "k" })).toThrow(
      /BOTH/,
    );
    expect(() => pickCredential({})).toThrow(/claude setup-token/);
  });

  it("runs with a fresh per-case HOME, no update check, no telemetry, and nothing of the host", () => {
    const env = claudeEnv({
      path: "/usr/bin",
      home: "/tmp/claude-home/x",
      tmpDir: "/tmp/claude-home/x.tmp",
      credential: { CLAUDE_CODE_OAUTH_TOKEN: "t" },
      maxRetries: "10",
    });
    expect(env["HOME"]).toBe("/tmp/claude-home/x");
    expect(env["CLAUDE_CONFIG_DIR"]).toBe("/tmp/claude-home/x/.claude");
    expect(env["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("t");
    expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect(env["CLAUDE_CODE_MAX_RETRIES"]).toBe("10");
    for (const k of [
      "DISABLE_AUTOUPDATER",
      "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
      "DISABLE_TELEMETRY",
      "DISABLE_ERROR_REPORTING",
    ])
      expect(env[k], k).toBe("1");
    // A closed set: no pi login, no GitHub token, no gateway triple.
    expect(Object.keys(env).sort()).toEqual(
      [
        "PATH",
        "HOME",
        "CLAUDE_CONFIG_DIR",
        "TMPDIR",
        "LANG",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "CLAUDE_CODE_MAX_RETRIES",
        "DISABLE_AUTOUPDATER",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
        "DISABLE_TELEMETRY",
        "DISABLE_ERROR_REPORTING",
        "DISABLE_BUG_COMMAND",
        "CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY",
        "CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL",
        "PYTHONDONTWRITEBYTECODE",
        "GIT_CONFIG_NOSYSTEM",
        "GIT_CONFIG_SYSTEM",
        "GIT_CONFIG_GLOBAL",
        "GIT_TERMINAL_PROMPT",
      ].sort(),
    );
  });
});

describe("the result file, read the way the harness's scorer reads it", () => {
  it("scores dict findings with a summary or failure scenario; raw text scores zero", () => {
    const r = {
      review_output: [
        { file: "a.ts", line: 3, summary: "off by one", failure_scenario: "x" },
        { file: "b.ts", summary: "  ", failure_scenario: "only a scenario" },
        { file: "c.ts", line: 9, summary: " ", failure_scenario: "" },
        "not a dict",
      ],
    };
    expect(claudeScoredFindings(r)).toEqual([
      { path: "a.ts", line: 3, note: "off by one\nx" },
      { path: "b.ts", line: null, note: "only a scenario" },
    ]);
    expect(claudeScoredFindings({ review_output: "Failed to authenticate." })).toEqual([]);
  });

  it("an auth failure exits 0 — it is still never a review", () => {
    const result = {
      claude_exit_code: 0,
      retry_exhausted: null,
      review_output_source: "stdout_fallback",
      review_output: "Failed to authenticate. API Error: 401 OAuth access token is invalid.",
      token_usage: { input_tokens: 0, output_tokens: 0, model_usage: null },
    };
    const s = summarizeClaudeResult({
      result,
      driverExit: 0,
      driverTimedOut: false,
      stdout: AUTH_FAILURE_STDOUT,
    });
    expect(s.status).toBe("auth-failed");
    expect(s.raw_text_fallback).toBe(true);
    expect(s.comments).toBe(0);
    // No usage and no recognisable error: nothing was reviewed either.
    expect(
      summarizeClaudeResult({
        result: { ...result, review_output: "hm" },
        driverExit: 0,
        driverTimedOut: false,
        stdout: JSON.stringify({ result: "hm", modelUsage: {} }),
      }).status,
    ).toBe("no-model-call");
  });

  it("records the model that ran — the one with the most output — and the harness's timeouts", () => {
    const result = {
      claude_exit_code: 0,
      review_output_source: "mcp_stream",
      review_output: [{ file: "a", line: 1, summary: "s", failure_scenario: "f" }],
      claude_cost_usd: 1.25,
      claude_num_turns: 12,
      token_usage: {
        input_tokens: 10,
        output_tokens: 900,
        cache_read_input_tokens: 5000,
        cache_creation_input_tokens: 200,
        model_usage: {
          "claude-haiku-4-5": { outputTokens: 100 },
          "claude-opus-4-7": { outputTokens: 800 },
        },
      },
    };
    const s = summarizeClaudeResult({ result, driverExit: 0, driverTimedOut: false, stdout: "" });
    expect(s).toMatchObject({
      status: "ok",
      model: "claude-opus-4-7",
      models: ["claude-haiku-4-5", "claude-opus-4-7"],
      comments: 1,
      cost_usd: 1.25,
      num_turns: 12,
      tokens: { input: 10, output: 900, cache_read: 5000, cache_creation: 200 },
    });
    const timedOut = {
      ...result,
      claude_exit_code: -1,
      stderr: "Process timed out after 1860 seconds",
    };
    expect(
      summarizeClaudeResult({ result: timedOut, driverExit: 0, driverTimedOut: false }).status,
    ).toBe("timeout");
    expect(
      summarizeClaudeResult({
        result: { ...result, claude_exit_code: 1, retry_exhausted: { error: "rate_limit" } },
        driverExit: 0,
        driverTimedOut: false,
      }).status,
    ).toBe("retry-exhausted");
    expect(claudeFinalText(AUTH_FAILURE_STDOUT)).toMatch(/^Failed to authenticate/);
    expect(
      claudeFinalText(`{"type":"system"}\n{"type":"result","result":"## Review\\nfine"}`),
    ).toBe("## Review\nfine");
  });
});

// ---- the runner, end to end, against a stub driver and a scratch repo store ----

function scratchCase(t: string): { set: CaseSet; c: BenchCase; meta: PrefetchMeta; store: string } {
  const g = (cwd: string, ...a: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    }).trim();
  const work = join(t, "src-repo");
  mkdirSync(work);
  g(work, "init", "--quiet", "-b", "main");
  writeFileSync(join(work, "a.ts"), "export const a = 1;\n");
  g(work, "add", ".");
  g(work, "commit", "--quiet", "-m", "base");
  const base = g(work, "rev-parse", "HEAD");
  writeFileSync(join(work, "a.ts"), "export const a = 2;\n");
  g(work, "commit", "--quiet", "-am", "head");
  const head = g(work, "rev-parse", "HEAD");
  const id = `o__r@${head.slice(0, 7)}`;
  const store = join(t, "store");
  mkdirSync(store);
  g(store, "init", "--quiet", "--bare", id);
  g(work, "push", "--quiet", join(store, id), "HEAD:refs/heads/pr");
  const c: BenchCase = {
    instance_id: id,
    repo: "o/r",
    pr: 1,
    pr_url: "https://github.com/o/r/pull/1",
    base_commit: base,
    head_commit: head,
    language: "TypeScript",
    pr_category: "bug",
    change_line_count: 2,
    references: 1,
  };
  const meta: PrefetchMeta = {
    instance_id: id,
    repo: "o/r",
    pr: 1,
    base_commit: base,
    head_commit: head,
    merge_base: base,
    base_ref: "main",
    base_ref_source: "github-api",
    title: null,
    body: null,
    depth: 0,
    diff: { files: 1, additions: 1, deletions: 1 },
    fetched_at: "2026-09-28T00:00:00Z",
  };
  const set: CaseSet = {
    name: "t",
    dataset: { source: "s", commit: "c".repeat(40), file: "f", sha256: "x" },
    rule: "r",
    references: 1,
    cases: [c],
    backups: [],
  };
  return { set, c, meta, store };
}

// A stand-in for claude_driver.py: writes what the harness would (the argv it
// ran, Claude Code's stdout, save_result's file) and what env it was given.
const STUB_DRIVER = `import json, os, sys
a = dict(zip(sys.argv[1::2], sys.argv[2::2]))
mode = open(os.path.join(os.path.dirname(__file__), "mode")).read().strip()
base, head, repo = a["--base"], a["--head"], a["--repo"]
argv = json.loads(open(os.path.join(os.path.dirname(__file__), "argv.json")).read())
argv = [x.replace("@BASE@", base).replace("@HEAD@", head).replace("@REPO@", repo) for x in argv]
json.dump(argv, open(a["--argv-out"], "w"))
json.dump(dict(os.environ), open(os.path.join(os.path.dirname(a["--argv-out"]), "env-seen.json"), "w"))
json.dump({"cwd": os.getcwd(), "files": sorted(os.listdir(repo))}, open(os.path.join(os.path.dirname(a["--argv-out"]), "tree-seen.json"), "w"))
if mode == "auth":
    out = ${JSON.stringify(AUTH_FAILURE_STDOUT)}
    review, usage = "Failed to authenticate. API Error: 401 OAuth access token is invalid.", None
else:
    out = json.dumps({"type": "result", "result": "## Findings\\n- a.ts:1 wrong constant", "modelUsage": {"claude-opus-4-7": {"outputTokens": 50}}})
    review, usage = [{"file": "a.ts", "line": 1, "summary": "wrong constant", "failure_scenario": "a is 2, callers expect 1"}], {"claude-opus-4-7": {"outputTokens": 50}}
open(a["--stdout-out"], "w").write(out)
os.makedirs(a["--results-dir"], exist_ok=True)
json.dump({"instance_id": a["--instance-id"], "reviewer": "claude-code/code-review", "claude_exit_code": 0,
           "retry_exhausted": None, "review_output_source": "mcp_stream" if usage else "stdout_fallback",
           "review_output": review, "claude_cost_usd": 0.5 if usage else 0,
           "token_usage": {"input_tokens": 1, "output_tokens": 50, "model_usage": usage}},
          open(os.path.join(a["--results-dir"], a["--instance-id"].replace("/", "__") + ".json"), "w"))
`;

function stubDriver(t: string, mode: "ok" | "auth"): string {
  const d = join(t, "driver");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "mode"), mode);
  const argv = HARNESS_ARGV.map((x) =>
    x.replaceAll(BASE, "@BASE@").replaceAll(HEAD, "@HEAD@").replaceAll(REPO, "@REPO@"),
  );
  writeFileSync(join(d, "argv.json"), JSON.stringify(argv));
  writeFileSync(join(d, "driver.py"), STUB_DRIVER);
  return join(d, "driver.py");
}

describe("claudeReviewRun: one case at a time, through the driver", () => {
  it("reviews a case, checks the argv it ran, and records the model", async () => {
    const t = mkdtempSync(join(tmpdir(), "qcr-claude-"));
    const { set, c, meta, store } = scratchCase(t);
    const out = join(t, "run");
    const lines: string[] = [];
    const code = await claudeReviewRun({
      set,
      outDir: out,
      store,
      workRoot: join(t, "work"),
      homeRoot: join(t, "homes"),
      python: "python3",
      driver: stubDriver(t, "ok"),
      timeoutMin: 30,
      resume: false,
      keepTree: false,
      env: {
        PATH: process.env.PATH,
        CLAUDE_CODE_OAUTH_TOKEN: "tok-123",
        QCR_CLAUDE_VERSION: "2.1.283",
        GH_TOKEN: "must-not-ride",
        HOME: "/home/someone",
      },
      readMeta: () => meta,
      log: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    const s = readClaudeSummary(out, c)!;
    expect(s).toMatchObject({
      status: "ok",
      argv_ok: true,
      model: "claude-opus-4-7",
      comments: 1,
      merge_base_ok: true,
      fingerprint: { claude_code_version: "2.1.283", credential: "oauth-token", timeout_min: 30 },
    });
    const caseDir = join(out, "cases", c.instance_id);
    // The driver saw the curated env only: its own HOME, the one credential.
    const env = JSON.parse(readFileSync(join(caseDir, "env-seen.json"), "utf8")) as Record<
      string,
      string
    >;
    expect(env["HOME"]).toBe(join(t, "homes", c.instance_id));
    expect(env["CLAUDE_CONFIG_DIR"]).toBe(join(t, "homes", c.instance_id, ".claude"));
    expect(env["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("tok-123");
    expect(env["GH_TOKEN"]).toBeUndefined();
    expect(env["DISABLE_AUTOUPDATER"]).toBe("1");
    // …in the harness's repo layout, the PR head checked out.
    const tree = JSON.parse(readFileSync(join(caseDir, "tree-seen.json"), "utf8")) as {
      cwd: string;
      files: string[];
    };
    expect(tree.cwd).toBe(join(t, "work", "repo", "o__r"));
    expect(tree.files).toContain("a.ts");
    // The per-case HOME and the tree are gone afterwards.
    expect(existsSync(join(t, "homes", c.instance_id))).toBe(false);
    expect(existsSync(join(t, "work", "repo", "o__r"))).toBe(false);
    // What /code-review said is the review body the defect judge reads…
    expect(readFileSync(join(caseDir, "review.md"), "utf8")).toContain("wrong constant");
    // …and the findings are its comments, in the harness's Claude reading.
    const review = reviewForJudge(out, c.instance_id);
    expect(review.comments).toEqual([
      {
        id: "C1",
        path: "a.ts",
        line: 1,
        end_line: 1,
        tag: null,
        text: "wrong constant\na is 2, callers expect 1",
      },
    ]);
    expect(review.body).toContain("## Findings");
    // The result file carries the OCR-shaped view, built from the harness's
    // structured findings, beside the harness's untouched payload.
    const scored = JSON.parse(
      readFileSync(join(out, "results", "all", `${c.instance_id}.json`), "utf8"),
    ) as Record<string, unknown>;
    expect(scored["review_output"]).toEqual([
      { file: "a.ts", line: 1, summary: "wrong constant", failure_scenario: "a is 2, callers expect 1" },
    ]);
    expect((scored["review"] as { comments: unknown[] }).comments).toEqual([
      { path: "a.ts", start_line: 1, end_line: 1, content: "wrong constant\na is 2, callers expect 1" },
    ]);
    expect(scored["bench"]).toEqual({ claude_view: { source: "harness", comments: 1 } });
    expect(s.view_source).toBe("harness");
    expect(s.harness_comments).toBe(1);
    const run = JSON.parse(readFileSync(join(out, "run.json"), "utf8")) as Record<string, unknown>;
    expect(run["reviewer"]).toBe("claude");
    expect(runArmOf(out)).toBe("claude");
    const report = renderClaudeReport(set, out, [c]);
    expect(report).toContain("claude-opus-4-7");
    expect(report).toContain("reviewers/claude.py");
    expect(report).toContain("OCR reader on the `review.comments` view");
    // A rerun into the same run dir whose driver produces nothing must not
    // leave the judge (or claude-rebuild) the earlier attempt's review body.
    const again = await claudeReviewRun({
      set,
      outDir: out,
      store,
      workRoot: join(t, "work"),
      homeRoot: join(t, "homes"),
      python: "python3",
      driver: join(t, "no-such-driver.py"),
      timeoutMin: 30,
      resume: false,
      keepTree: false,
      env: { PATH: process.env.PATH, CLAUDE_CODE_OAUTH_TOKEN: "tok-123" },
      readMeta: () => meta,
      log: () => {},
    });
    expect(again).not.toBe(0);
    expect(readClaudeSummary(out, c)!.status).not.toBe("ok");
    expect(existsSync(join(caseDir, "review.md"))).toBe(false);
    expect(reviewForJudge(out, c.instance_id)).toMatchObject({ body: null, comments: [] });
    // Nor a rerun whose prefetched store has gone missing: the case fails
    // before any attempt, and the earlier body must go with it.
    writeFileSync(join(caseDir, "review.md"), "## Findings\n\n- a.ts:1 — stale finding\n");
    const unprefetched = await claudeReviewRun({
      set,
      outDir: out,
      store,
      workRoot: join(t, "work"),
      homeRoot: join(t, "homes"),
      python: "python3",
      driver: join(t, "no-such-driver.py"),
      timeoutMin: 30,
      resume: false,
      keepTree: false,
      env: { PATH: process.env.PATH, CLAUDE_CODE_OAUTH_TOKEN: "tok-123" },
      readMeta: () => {
        throw new Error("no bench-meta.json");
      },
      log: () => {},
    });
    expect(unprefetched).not.toBe(0);
    expect(readClaudeSummary(out, c)!.status).toBe("failed");
    expect(existsSync(join(caseDir, "review.md"))).toBe(false);
    expect(reviewForJudge(out, c.instance_id)).toMatchObject({ body: null, comments: [] });
  });

  it("a raw-text answer gets its view from the prose parser, paths checked against the tree's diff", async () => {
    const t = mkdtempSync(join(tmpdir(), "qcr-claude-"));
    const { set, c, meta, store } = scratchCase(t);
    const d = stubDriver(t, "ok");
    // this driver's harness stored the answer as raw text, as 2.1.283's /code-review makes it
    writeFileSync(
      d,
      readFileSync(d, "utf8").replace(
        'review, usage = [{"file": "a.ts", "line": 1, "summary": "wrong constant", "failure_scenario": "a is 2, callers expect 1"}], {"claude-opus-4-7": {"outputTokens": 50}}',
        'review, usage = "I found 2 bugs.\\n\\n- `a.ts:1` — wrong constant.\\n- `lib/gone.ts:3` — not in this PR.\\n", {"claude-opus-4-7": {"outputTokens": 50}}',
      ),
    );
    const out = join(t, "run");
    const code = await claudeReviewRun({
      set,
      outDir: out,
      store,
      workRoot: join(t, "work"),
      homeRoot: join(t, "homes"),
      python: "python3",
      driver: d,
      timeoutMin: 30,
      resume: false,
      keepTree: false,
      env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: "k" },
      readMeta: () => meta,
      log: () => {},
    });
    expect(code).toBe(0);
    const scored = JSON.parse(
      readFileSync(join(out, "results", "all", `${c.instance_id}.json`), "utf8"),
    ) as Record<string, unknown>;
    expect(typeof scored["review_output"]).toBe("string");
    expect((scored["review"] as { comments: unknown[] }).comments).toEqual([
      { path: "a.ts", start_line: 1, end_line: 1, content: "`a.ts:1` — wrong constant." },
      { path: "lib/gone.ts", start_line: 3, end_line: 3, content: "`lib/gone.ts:3` — not in this PR." },
    ]);
    expect((scored["bench"] as Record<string, unknown>)["claude_prose_parsed"]).toMatchObject({
      findings: 2,
      paths_matched: 1,
      paths_unmatched: 1,
      paths_unchecked: 0,
      changed_files: 1,
    });
    const s = readClaudeSummary(out, c)!;
    expect(s).toMatchObject({ comments: 2, harness_comments: 0, view_source: "prose", raw_text_fallback: true });
    expect(reviewForJudge(out, c.instance_id).comments.map((x) => [x.path, x.line])).toEqual([
      ["a.ts", 1],
      ["lib/gone.ts", 3],
    ]);
    expect(renderClaudeReport(set, out, [c])).toContain("| 2 (prose) |");
  });

  it("an auth failure fails the case, keeps a result file, and stops the run", async () => {
    const t = mkdtempSync(join(tmpdir(), "qcr-claude-"));
    const { set, c, meta, store } = scratchCase(t);
    const second: BenchCase = { ...c, instance_id: "o__r@0000000" };
    const two: CaseSet = { ...set, cases: [c, second] };
    const out = join(t, "run");
    const lines: string[] = [];
    const reached: string[] = [];
    const code = await claudeReviewRun({
      set: two,
      outDir: out,
      store,
      workRoot: join(t, "work"),
      homeRoot: join(t, "homes"),
      python: "python3",
      driver: stubDriver(t, "auth"),
      timeoutMin: 30,
      resume: false,
      keepTree: false,
      env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: "k" },
      readMeta: (x) => {
        reached.push(x.instance_id);
        return meta;
      },
      log: (l) => lines.push(l),
    });
    expect(code).toBe(1);
    expect(readClaudeSummary(out, c)?.status).toBe("auth-failed");
    expect(readClaudeSummary(out, c)?.error).toMatch(/Failed to authenticate/);
    expect(existsSync(join(out, "results", "all", `${c.instance_id}.json`))).toBe(true);
    expect(reached).toEqual([c.instance_id]);
    expect(lines.join("\n")).toMatch(/STOPPED — Claude Code could not authenticate/);
  });

  it("refuses to run without a credential, and refuses another arm's run dir", async () => {
    const t = mkdtempSync(join(tmpdir(), "qcr-claude-"));
    const { set, meta, store } = scratchCase(t);
    const base = {
      set,
      store,
      workRoot: join(t, "work"),
      homeRoot: join(t, "homes"),
      python: "python3",
      driver: stubDriver(t, "ok"),
      timeoutMin: 30,
      resume: false,
      keepTree: false,
      readMeta: () => meta,
      log: () => {},
    };
    await expect(
      claudeReviewRun({ ...base, outDir: join(t, "a"), env: { PATH: process.env.PATH } }),
    ).rejects.toThrow(/claude setup-token/);
    mkdirSync(join(t, "b"));
    writeFileSync(join(t, "b", "run.json"), JSON.stringify({ reviewer: "ocr" }));
    await expect(
      claudeReviewRun({
        ...base,
        outDir: join(t, "b"),
        env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: "k" },
      }),
    ).rejects.toThrow(/another arm/);
  });
});

// ---- the OCR-shaped view, and rebuilding it for a finished run -----------------

const RAW_ANSWER =
  "I found 2 bugs.\n\n- **`src/a.ts:12`** — wrong constant.\n- **mongo.go:7** — escaped twice.\n\n" +
  "What I checked:\n- **Callers** (`src/b.ts:3`): fine.\n";

function rawResult(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    instance_id: "o__r@1234567",
    reviewer: "claude-code/code-review",
    claude_exit_code: 0,
    review_output_source: "stdout_fallback",
    review_output: RAW_ANSWER,
    token_usage: { input_tokens: 5, output_tokens: 7, model_usage: { m: { outputTokens: 7 } } },
    ...extra,
  };
}

describe("withClaudeView: the view the eval scores, beside the harness's payload", () => {
  it("structured findings: exactly the harness's Claude reading, no parser involved", () => {
    const r = {
      review_output: [
        { file: "a.ts", line: 3, summary: "off by one", failure_scenario: "x" },
        { file: "b.ts", summary: " ", failure_scenario: "" },
      ],
      review_output_source: "mcp_stream",
      bench: { keep: 1, claude_prose_parsed: { stale: true } },
    };
    const v = withClaudeView(r, ["a.ts"]);
    expect(v["review_output"]).toBe(r.review_output);
    expect((v["review"] as { comments: unknown[] }).comments).toEqual(claudeRowsForJudge(r));
    expect(v["bench"]).toEqual({ keep: 1, claude_view: { source: "harness", comments: 1 } });
    // an EMPTY structured answer is still the harness's answer
    expect(withClaudeView({ review_output: [] }, null)["bench"]).toEqual({
      claude_view: { source: "harness", comments: 0 },
    });
  });

  it("raw text: the prose parser's findings, a marker with its counts, review_output untouched", () => {
    const r = rawResult();
    const v = withClaudeView(r, ["src/a.ts", "pkg/mongo/mongo.go"]);
    expect(v["review_output"]).toBe(RAW_ANSWER);
    expect(v["review"]).toEqual({
      comments: [
        { path: "src/a.ts", start_line: 12, end_line: 12, content: "**`src/a.ts:12`** — wrong constant." },
        { path: "pkg/mongo/mongo.go", start_line: 7, end_line: 7, content: "**mongo.go:7** — escaped twice." },
      ],
      summary: { input_tokens: 5, output_tokens: 7, total_tokens: 12 },
    });
    expect(v["bench"]).toEqual({
      claude_view: { source: "prose", comments: 2 },
      claude_prose_parsed: {
        parser_version: 1,
        findings: 2,
        paths_matched: 2,
        paths_unmatched: 0,
        paths_unchecked: 0,
        changed_files: 2,
        skipped: { non_finding: 1, recap: 0, unlocated: 0 },
      },
    });
    // idempotent: rebuilding a rebuilt file changes nothing
    expect(withClaudeView(v, ["src/a.ts", "pkg/mongo/mongo.go"])).toEqual(v);
    // the harness's own Claude reader still sees nothing in it
    expect(claudeScoredFindings(v)).toEqual([]);
    // no file list: paths as written, unchecked
    const u = withClaudeView(r, null);
    expect((u["bench"] as Record<string, Record<string, unknown>>)["claude_prose_parsed"]).toMatchObject({
      paths_unchecked: 2,
      changed_files: null,
    });
  });

  it("the empty result of a case that never ran carries an empty view", () => {
    const c = { instance_id: "o__r@1", repo: "o/r", base_commit: "a", head_commit: "b" } as BenchCase;
    const e = emptyClaudeResult(c, "boom");
    expect((e["review"] as { comments: unknown[] }).comments).toEqual([]);
  });
});

describe("claudeRebuildRun: the view for a finished run, no model and no network", () => {
  function finishedRun(t: string, result: Record<string, unknown>) {
    const id = "o__r@1234567";
    const set: CaseSet = {
      name: "t",
      dataset: { source: "s", commit: "c".repeat(40), file: "f", sha256: "x" },
      rule: "r",
      references: 1,
      cases: [
        { instance_id: id, repo: "o/r", pr: 1, pr_url: "u", base_commit: "a".repeat(40), head_commit: "b".repeat(40), language: "Go", pr_category: "bug", change_line_count: 1, references: 1 },
        { instance_id: "o__r@0000000", repo: "o/r", pr: 2, pr_url: "u", base_commit: "a".repeat(40), head_commit: "c".repeat(40), language: "Go", pr_category: "bug", change_line_count: 1, references: 1 },
      ],
      backups: [],
    };
    const out = join(t, "run");
    mkdirSync(join(out, "results", "all"), { recursive: true });
    mkdirSync(join(out, "cases", id), { recursive: true });
    writeFileSync(join(out, "run.json"), JSON.stringify({ reviewer: "claude" }));
    writeFileSync(join(out, "results", "all", `${id}.json`), JSON.stringify(result));
    writeFileSync(
      join(out, "cases", id, "case-summary.json"),
      JSON.stringify({ instance_id: id, arm: "claude", status: "ok", comments: 0, raw_text_fallback: true, fingerprint: {}, warnings: [], argv_ok: true, argv_mismatches: [], duration_seconds: 60, cost_usd: 0.1, tokens: null, models: [], model: "m", review_output_source: "stdout_fallback", num_turns: 0, exit_code: 0, merge_base_ok: true }),
    );
    const files = join(t, "code");
    mkdirSync(join(files, id), { recursive: true });
    writeFileSync(join(files, id, "files.txt"), "src/a.ts\npkg/mongo/mongo.go\n");
    return { set, out, id, files };
  }

  it("adds the view and the marker, updates the case summary, skips a case with no result", async () => {
    const t = mkdtempSync(join(tmpdir(), "qcr-claude-rebuild-"));
    const { set, out, id, files } = finishedRun(t, rawResult());
    const lines: string[] = [];
    const got = await claudeRebuildRun({ set, outDir: out, filesDir: files, log: (l) => lines.push(l) });
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ instance_id: id, source: "prose", comments: 2 });
    const r = JSON.parse(readFileSync(join(out, "results", "all", `${id}.json`), "utf8")) as Record<string, unknown>;
    expect(r["review_output"]).toBe(RAW_ANSWER);
    expect((r["review"] as { comments: Array<{ path: string }> }).comments.map((x) => x.path)).toEqual([
      "src/a.ts",
      "pkg/mongo/mongo.go",
    ]);
    const s = JSON.parse(readFileSync(join(out, "cases", id, "case-summary.json"), "utf8")) as Record<string, unknown>;
    expect(s).toMatchObject({ comments: 2, harness_comments: 0, view_source: "prose" });
    expect(lines.join("\n")).toMatch(/o__r@0000000 — no result file, skipped/);
    expect(lines.join("\n")).toMatch(/paths 2\/2 matched to 2 changed file\(s\)/);
    // the defect judge now gets the comments too
    expect(reviewForJudge(out, id).comments).toHaveLength(2);
    // a second rebuild is a no-op
    const before = readFileSync(join(out, "results", "all", `${id}.json`), "utf8");
    await claudeRebuildRun({ set, outDir: out, filesDir: files, log: () => {} });
    expect(readFileSync(join(out, "results", "all", `${id}.json`), "utf8")).toBe(before);
  });

  it("reads the changed files from the prefetched store, never writing into it", async () => {
    const t = mkdtempSync(join(tmpdir(), "qcr-claude-rebuild-"));
    const { c, meta, store } = scratchCase(t);
    const listing = () => readdirSync(join(store, c.instance_id)).sort().join(",");
    const before = listing();
    expect(await changedFilesFromStore(join(store, c.instance_id), meta)).toEqual(["a.ts"]);
    expect(listing()).toBe(before);
    expect(await changedFilesFromStore(join(t, "nowhere"), meta)).toBeNull();
  });
});

// ---- bench.sh, run for real against a stub docker ----------------------------

function benchTree(): { here: string; bin: string; log: string } {
  const tmp = mkdtempSync(join(tmpdir(), "claude-sh-"));
  const here = join(tmp, "repo", "bench", "aacr");
  mkdirSync(here, { recursive: true });
  cpSync(join(B, "bench.sh"), join(here, "bench.sh"));
  const bin = join(tmp, "bin");
  mkdirSync(bin);
  const log = join(tmp, "docker.log");
  writeFileSync(join(bin, "docker"), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${log}"\n`);
  chmodSync(join(bin, "docker"), 0o755);
  return { here, bin, log };
}

function bench(t: { here: string; bin: string }, env: Record<string, string>, ...args: string[]) {
  return spawnSync("bash", [join(t.here, "bench.sh"), ...args], {
    env: { ...process.env, PATH: `${t.bin}:${process.env.PATH}`, ...env },
    encoding: "utf8",
  });
}

describe("bench.sh --arm claude: its own credential file, and the same hardening", () => {
  it("refuses without bench/aacr/claude.env and says exactly how to make one", () => {
    const t = benchTree();
    const r = bench(t, {}, "review", "--arm", "claude", "--run", "r1", "--set", "fresh10");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(join(t.here, "claude.env"));
    expect(r.stderr).toContain("CLAUDE_CODE_OAUTH_TOKEN=");
    expect(r.stderr).toContain("claude setup-token");
    expect(r.stderr).toContain("ANTHROPIC_API_KEY=");
    const calls = existsSync(t.log) ? readFileSync(t.log, "utf8") : "";
    expect(calls).not.toMatch(/^run /m);
  });

  it("refuses a file that sets both, or neither, or is a symlink", () => {
    const t = benchTree();
    const f = join(t.here, "claude.env");
    writeFileSync(f, "CLAUDE_CODE_OAUTH_TOKEN=a\nANTHROPIC_API_KEY=b\n");
    let r = bench(t, {}, "review", "--arm", "claude", "--run", "r1");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/exactly one .*found 2/);
    writeFileSync(f, "# nothing\nOTHER=1\n");
    r = bench(t, {}, "review", "--arm", "claude", "--run", "r1");
    expect(r.stderr).toMatch(/found 0/);
    const real = join(t.here, "..", "elsewhere.env");
    writeFileSync(real, "ANTHROPIC_API_KEY=k\n");
    r = bench(
      t,
      { QCR_BENCH_CLAUDE_ENV: join(t.here, "link.env") },
      "review",
      "--arm",
      "claude",
      "--run",
      "r1",
    );
    expect(r.stderr).toMatch(/needs its own credential/);
    symlinkSync(real, join(t.here, "link.env"));
    r = bench(
      t,
      { QCR_BENCH_CLAUDE_ENV: join(t.here, "link.env") },
      "review",
      "--arm",
      "claude",
      "--run",
      "r1",
    );
    expect(r.stderr).toMatch(/not a symlink/);
  });

  it("passes the file with --env-file — the value never reaches an argv or a log — and no pi login", () => {
    const t = benchTree();
    const secret = "sk-ant-oat01-SECRET-VALUE-XYZ";
    writeFileSync(join(t.here, "claude.env"), `CLAUDE_CODE_OAUTH_TOKEN=${secret}\n`);
    const r = bench(
      t,
      {},
      "review",
      "--arm",
      "claude",
      "--run",
      "r1",
      "--set",
      "fresh10",
      "--only",
      "o__r@1234567",
    );
    expect(r.status, r.stderr).toBe(0);
    const calls = readFileSync(t.log, "utf8");
    const run = calls.split("\n").find((l) => l.startsWith("run "))!;
    expect(run).toContain(`--env-file ${join(t.here, "claude.env")}`);
    expect(run).toContain("--mount type=volume,dst=/work");
    expect(run).toContain("qcr-bench-claude:latest claude-review fresh10 --only o__r@1234567");
    for (const flag of [
      "--read-only",
      "--cap-drop ALL",
      "no-new-privileges",
      "--pids-limit",
      "--user",
    ])
      expect(run).toContain(flag);
    expect(run).not.toContain("/pi-agent-src"); // no pi login
    expect(run).not.toContain("companion-pihome");
    expect(run).not.toMatch(/\.claude(\/|\b)(?!\.env)|\.credentials/);
    expect(run).not.toMatch(/docker\.sock/);
    expect(calls).not.toContain(secret);
    const cmdLog = join(t.here, "runs", "r1.sandbox-commands.log");
    expect(readFileSync(cmdLog, "utf8")).not.toContain(secret);
    // Only the credential file and the run dir are bound from the host.
    expect(run.match(/type=bind/g)).toHaveLength(1);
  });

  it("builds the `claude` target; eval runs on the arm's image, without the credential", () => {
    const t = benchTree();
    const sh = readFileSync(join(B, "bench.sh"), "utf8");
    expect(sh).toMatch(
      /claude\) IMAGE="\$\{QCR_BENCH_CLAUDE_IMAGE:-qcr-bench-claude:latest\}"; TARGET=claude/,
    );
    expect(sh).toContain("bench/aacr/claude_driver.py");
    bench(t, {}, "eval", "--arm", "claude", "--run", "r2", "--set", "fresh10", "--judge", "mock");
    const ev = readFileSync(t.log, "utf8")
      .split("\n")
      .filter((l) => l.startsWith("run "))
      .at(-1)!;
    expect(ev).toContain("BENCH_ARM=claude");
    expect(ev).toContain("qcr-bench-claude:latest eval fresh10 mock");
    expect(ev).not.toContain("--env-file"); // scoring never gets the reviewer's credential
  });

  it("claude-rebuild: --network none, the store read-only, no credential; only for this arm", () => {
    const t = benchTree();
    let r = bench(t, {}, "claude-rebuild", "--arm", "claude", "--run", "r3", "--set", "fresh10", "--only", "o__r@1234567");
    expect(r.status, r.stderr).toBe(0);
    const run = readFileSync(t.log, "utf8")
      .split("\n")
      .filter((l) => l.startsWith("run "))
      .at(-1)!;
    expect(run).toContain("--network none");
    expect(run).toContain("dst=/repos,readonly");
    expect(run).toContain("qcr-bench-claude:latest claude-rebuild fresh10 --only o__r@1234567");
    expect(run).not.toContain("--env-file");
    expect(run).not.toContain("/pi-agent-src");
    r = bench(t, {}, "claude-rebuild", "--run", "r3");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/pass --arm claude/);
  });

  it("the eval scores the Claude Code arm with the OCR reader on its view, and refuses a run without one", () => {
    const sh = readFileSync(join(B, "in-container.sh"), "utf8");
    expect(sh).toMatch(/^\s*reader=ocr$/m);
    expect(sh).not.toMatch(/reader=claude/);
    expect(sh).toContain("--check-results /bench-out/results/all --require-view");
    expect(sh).toMatch(/claude-rebuild\)[\s\S]*?"\$\{CLI\[@\]\}" claude-rebuild --set/);
    // stale metrics of the old reader are cleared with the new ones
    expect(sh).toContain('rm -f "$dir"/metrics_*.json');
    const driver = readFileSync(join(B, "claude_driver.py"), "utf8");
    expect(driver).toContain("build_target_comments_from_claude, evaluate.build_target_comments_from_ocr");
  });
});

// ---- the fences -------------------------------------------------------------------

/** Every file of this repo a host-side path could run: sources, scripts,
 * tests, the bench, extensions, docker and deploy — no node_modules, no dist,
 * no worktrees, no run outputs. */
function repoFiles(): string[] {
  const skip = new Set([
    "node_modules",
    "dist",
    ".git",
    "runs",
    "whatif",
    "worktrees",
    "state",
    "__pycache__",
  ]);
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      if (skip.has(n)) continue;
      const p = join(d, n);
      const st = statSync(p, { throwIfNoEntry: false });
      if (!st) continue;
      if (st.isDirectory()) walk(p);
      else if (st.size < 2_000_000 && !/\.(pyc|png|jpg|gz|tgz|sqlite|md|json|jsonl)$/.test(n))
        out.push(p);
    }
  };
  for (const d of ["src", "scripts", "tests", "bench", "extensions", "docker", "deploy", "bin"])
    if (existsSync(join(ROOT, d))) walk(join(ROOT, d));
  // config.example.toml is the tracked config (untracked the live config.toml).
  for (const f of ["package.json", "config.example.toml"]) out.push(join(ROOT, f));
  return out.map((p) => relative(ROOT, p));
}

const SELF = "tests/bench-claude.test.ts";

/** A line that RUNS `claude` (not one that merely names it). */
function spawnsClaude(file: string, line: string): boolean {
  const t = line.trim();
  const ext = file.split(".").pop() ?? "";
  if (/^(ts|js|mjs|cjs|tsx)$/.test(ext)) {
    if (/^(\/\/|\*|\/\*)/.test(t)) return false;
    return (
      /\b(spawn|spawnSync|exec|execSync|execFile|execFileSync|fork|run|runCmd|must|execa)\(\s*["'`]claude["'`]/.test(
        t,
      ) ||
      /["'`]claude["'`]\s*,\s*\[/.test(t) ||
      /["'`][^"'`]*(^|[;&|(]\s*|\$\(\s*)claude\s+(-|setup-token|mcp|config|update|doctor)/.test(t)
    );
  }
  if (ext === "py") {
    if (t.startsWith("#")) return false;
    return (
      /\[\s*["']claude["']/.test(t) ||
      /\b(run|Popen|call|check_call|check_output|system|execvp?|spawn\w*)\(\s*\[?\s*["']claude\b/.test(
        t,
      )
    );
  }
  // shell, Dockerfiles, templates, extensionless scripts
  if (t.startsWith("#")) return false;
  return /(^|[;&|(]\s*|\$\(\s*|`\s*|\b(exec|sudo|xargs|nohup|env|then|do|else|RUN)\s+|\b[A-Za-z_]\w*=\S*\s+)claude(\s|$|;)/.test(
    t,
  );
}

describe("rule 5 fence: `claude` runs only inside the benchmark sandbox", () => {
  const files = repoFiles();

  it("no host-side file spawns `claude` — only the image build and the container entry name it", () => {
    const hits: string[] = [];
    for (const f of files) {
      if (f === SELF) continue;
      const lines = readFileSync(join(ROOT, f), "utf8").split("\n");
      lines.forEach((l, i) => {
        if (spawnsClaude(f, l)) hits.push(`${f}:${i + 1}: ${l.trim().slice(0, 120)}`);
      });
    }
    // The Dockerfile's `claude` stage runs `claude --version` INSIDE the image
    // build (never on the host) — the only spawn this repo writes itself.
    const allowed = hits.filter((h) => h.startsWith("bench/aacr/Dockerfile:"));
    expect(hits.filter((h) => !allowed.includes(h))).toEqual([]);
    expect(allowed.length).toBeGreaterThan(0);
    const docker = readFileSync(join(B, "Dockerfile"), "utf8");
    const stage = docker.slice(docker.indexOf("FROM runtime AS claude"));
    for (const h of allowed)
      expect(stage).toContain(h.split(": ").slice(1).join(": ").slice(0, 40));
  });

  it("the fence's own detector catches the spellings it must", () => {
    const yes: Array<[string, string]> = [
      ["src/x.ts", 'spawn("claude", ["-p", x])'],
      ["src/x.ts", "execFileSync('claude', args)"],
      ["src/x.ts", 'const cmd = "cd /r && claude -p foo";'],
      ["scripts/x.sh", "claude -p '/code-review'"],
      ["scripts/x.sh", 'out="$(claude --version)"'],
      ["scripts/x.sh", "exec claude --print hi"],
      ["scripts/x.sh", "  && HOME=/tmp/h claude --version"],
      ["x.py", 'subprocess.run(["claude", "-p", "x"])'],
      ["x.py", 'cmd = ["claude", "-p"]'],
    ];
    for (const [f, l] of yes) expect(spawnsClaude(f, l), l).toBe(true);
    const no: Array<[string, string]> = [
      ["src/x.ts", "// claude -p '/code-review'"],
      ["src/x.ts", 'join(ROOT, "CLAUDE.md")'],
      ["scripts/x.sh", "# never spawn claude"],
      ["scripts/x.sh", 'echo "read CLAUDE.md"'],
      ["scripts/x.sh", '  claude) IMAGE="qcr-bench-claude"; TARGET=claude'],
      ["x.py", 'stub = bin_dir / "claude"'],
    ];
    for (const [f, l] of no) expect(spawnsClaude(f, l), l).toBe(false);
  });

  it("the only route to it: in-container.sh → cli claude-review → claude_driver.py → the harness", () => {
    const refs = (re: RegExp) =>
      files.filter((f) => f !== SELF && re.test(readFileSync(join(ROOT, f), "utf8"))).sort();
    // The harness's Claude runner is imported by the driver alone.
    expect(refs(/reviewers import claude|run_claude_review\(/)).toEqual([
      "bench/aacr/claude_driver.py",
    ]);
    // The driver is started by claudecode.ts (path defaulted in cli.ts), shipped
    // by the Dockerfile and the build context, named by the entry's header —
    // nothing else knows it.
    expect(refs(/claude_driver\.py/)).toEqual(
      [
        "bench/aacr/Dockerfile",
        "bench/aacr/bench.sh",
        "bench/aacr/in-container.sh",
        "src/bench/claudecode.ts",
        "src/bench/cli.ts",
      ].sort(),
    );
    const cc = readFileSync(join(ROOT, "src/bench/claudecode.ts"), "utf8");
    // claudecode.ts spawns the driver, never `claude`.
    expect(cc).toMatch(/await run\(\s*o\.python,\s*\[\s*o\.driver,/);
    // The command is served by cli.ts and invoked only by the container entry.
    expect(refs(/\bclaudeReviewRun\b/)).toEqual(["src/bench/claudecode.ts", "src/bench/cli.ts"]);
    // Only the container entry invokes it; bench.sh names that entry, the
    // rest are its implementation and its messages.
    expect(refs(/"\$\{CLI\[@\]\}" claude-review/)).toEqual(["bench/aacr/in-container.sh"]);
    expect(refs(/\bclaude-review\b/)).toEqual(
      [
        "bench/aacr/bench.sh",
        "bench/aacr/claude_driver.py",
        "bench/aacr/in-container.sh",
        "src/bench/claudecode.ts",
        "src/bench/cli.ts",
      ].sort(),
    );
    // Claude Code is installed in the bench image's `claude` stage and nowhere else.
    expect(refs(/@anthropic-ai\/claude-code/)).toEqual(["bench/aacr/Dockerfile"]);
    const docker = readFileSync(join(B, "Dockerfile"), "utf8");
    expect(docker.indexOf("@anthropic-ai/claude-code")).toBeGreaterThan(
      docker.indexOf("FROM runtime AS claude"),
    );
    const pkg = readFileSync(join(ROOT, "package.json"), "utf8");
    expect(pkg).not.toContain("claude-code");
  });

  it("nothing reads, copies or mounts the host's ~/.claude login", () => {
    const re =
      /(~|\$HOME|\$\{HOME\}|homedir\(\)[^\n]*|process\.env\.HOME[^\n]*)\/?["'`, ]*\.claude\b|\.credentials\.json/;
    const scope = [
      "bench/aacr/bench.sh",
      "bench/aacr/arm.sh",
      "bench/aacr/in-container.sh",
      "bench/aacr/Dockerfile",
      "bench/aacr/claude_driver.py",
      "src/bench/claudecode.ts",
      "src/bench/claudeshape.ts",
      "src/bench/cli.ts",
    ];
    for (const f of scope) expect(readFileSync(join(ROOT, f), "utf8"), f).not.toMatch(re);
    // The credential file is gitignored, and bench.sh never cats or sources it.
    expect(readFileSync(join(B, ".gitignore"), "utf8")).toMatch(/^claude\.env$/m);
    const sh = readFileSync(join(B, "bench.sh"), "utf8");
    expect(sh).not.toMatch(/(source|\.)\s+"?\$CLAUDE_ENV|cat\s+"?\$CLAUDE_ENV/);
    expect(sh).toContain('CENV=(--env-file "$CLAUDE_ENV")');
  });
});

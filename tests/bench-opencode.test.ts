// The OpenCode arm of the AACR benchmark (src/bench/opencode.ts): the argv,
// the config, the result conversion the harness and the defect judge read,
// and the no-refresh guarantee on the credential path. Stub-based: OpenCode
// itself is replaced by an injected runner; git runs against a scratch repo
// (prepareTree), and the bridge's own credential check runs under python3.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { BenchCase, CaseSet, PrefetchMeta } from "../src/bench/aacr.js";
import { authFingerprint, DISABLED_REFRESH } from "../src/bench/auth.js";
import { reviewForJudge } from "../src/bench/defects.js";
import { run } from "../src/bench/exec.js";
import { runArmOf, scoredOcrComments } from "../src/bench/ocr.js";
import {
  BRIDGE_PROVIDER,
  chooseFindings,
  extractFindingsFromText,
  FINDINGS_TOOL,
  INLINE_FINDINGS_PROMPT_FRAGMENT,
  opencodeConfig,
  opencodeEnv,
  opencodeProcessTimeoutMs,
  opencodeResultPayload,
  opencodeReviewArguments,
  opencodeRunArgv,
  opencodeStatus,
  parseOpencodeEvents,
  renderOpencodeReport,
  REVIEW_COMMAND_TEMPLATE,
  reviewCaseOpencode,
  runOpencodeReview,
  toOcrShapedComments,
  type OpencodeFingerprint,
} from "../src/bench/opencode.js";

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
  backups: [],
};
const FP: OpencodeFingerprint = {
  qcr_commit: "c",
  opencode_version: "1.18.33",
  model: "gpt-6-sol",
  effort: "medium",
  variant: "medium",
  timeout_min: 30,
};

// A trimmed copy of a real `opencode run --format json` stream (1.18.33): the
// review runs as a subtask (the `task` tool), the parent then summarises.
const EVENTS = [
  {
    type: "tool_use",
    sessionID: "ses_1",
    part: {
      type: "tool",
      tool: "task",
      state: {
        status: "completed",
        output:
          '<task id="ses_2" state="completed">\n<task_result>\n```json\n[{"file":"a.py","start_line":2,"summary":"x","description":"y"}]\n```\n</task_result>\n</task>',
      },
    },
  },
  { type: "step_start", sessionID: "ses_1", part: { type: "step-start" } },
  { type: "text", sessionID: "ses_1", part: { type: "text", text: "Summary: one finding." } },
  {
    type: "step_finish",
    sessionID: "ses_1",
    part: {
      type: "step-finish",
      reason: "stop",
      tokens: { total: 110, input: 50, output: 7, reasoning: 3, cache: { write: 0, read: 50 } },
    },
  },
]
  .map((e) => JSON.stringify(e))
  .join("\n");

describe("the OpenCode arm runs in the shape of the harness's codex runner", () => {
  it("argv: the built-in /review over base...head, JSON events, no external plugins, auto-approve", () => {
    const argv = opencodeRunArgv({
      dir: "/wt/x",
      model: "gpt-6-sol",
      variant: "medium",
      title: CASE.instance_id,
      arguments: opencodeReviewArguments(BASE, HEAD),
    });
    expect(argv.slice(0, -1)).toEqual([
      "run",
      "--pure",
      "--auto",
      "--format",
      "json",
      "--dir",
      "/wt/x",
      "--model",
      `${BRIDGE_PROVIDER}/gpt-6-sol`,
      "--variant",
      "medium",
      "--title",
      CASE.instance_id,
      "--command",
      "review",
    ]);
    // codex.py: `/review {base}...{head} ({INLINE_FINDINGS_PROMPT_FRAGMENT})`
    expect(argv.at(-1)).toBe(`${BASE}...${HEAD} (${INLINE_FINDINGS_PROMPT_FRAGMENT})`);
  });

  it("the findings fragment is the harness's, naming OpenCode's spelling of the tool", () => {
    expect(FINDINGS_TOOL).toBe("findings_report");
    expect(INLINE_FINDINGS_PROMPT_FRAGMENT).toContain(
      "You have an MCP tool named `findings_report`.",
    );
    for (const line of [
      "  - file: path relative to the repository root\n",
      "  - start_line: the 1-based starting line number\n",
      "  - severity: one of Critical, Major, Minor, Trivial, Info\n",
      "Any finding not sent through this tool will be lost.",
    ])
      expect(INLINE_FINDINGS_PROMPT_FRAGMENT).toContain(line);
  });

  it("the process timeout is codex.py's: timeout×60 + 60 s", () => {
    expect(opencodeProcessTimeoutMs(30)).toBe(1_860_000);
  });

  it("config: one provider (the loopback bridge, dummy key), the harness's MCP server, nothing phones home", () => {
    const c = opencodeConfig({
      bridgeUrl: "http://127.0.0.1:8766/",
      model: "gpt-6-sol",
      mcpPython: "/opt/aacr-venv/bin/python",
      mcpScript: "/opt/aacr-bench/evaluation/mcp_codex_finding_server.py",
      resultsDir: "/wt/x.opencode/findings",
      instanceId: CASE.instance_id,
    }) as Record<string, any>;
    expect(c["autoupdate"]).toBe(false);
    expect(c["share"]).toBe("disabled");
    expect(c["enabled_providers"]).toEqual(["bridge"]);
    expect(c["model"]).toBe("bridge/gpt-6-sol");
    expect(c["small_model"]).toBe("bridge/gpt-6-sol");
    const p = c["provider"]["bridge"];
    expect(p.npm).toBe("@ai-sdk/openai-compatible");
    expect(p.options.baseURL).toBe("http://127.0.0.1:8766/v1");
    expect(p.options.apiKey).toBe("loopback-bridge");
    expect(p.options.headerTimeout).toBeGreaterThanOrEqual(600_000);
    expect(c["mcp"]["findings"]).toMatchObject({
      type: "local",
      command: [
        "/opt/aacr-venv/bin/python",
        "/opt/aacr-bench/evaluation/mcp_codex_finding_server.py",
      ],
      environment: {
        REVIEW_RESULTS_DIR: "/wt/x.opencode/findings",
        REVIEW_INSTANCE_ID: CASE.instance_id,
      },
    });
    expect(c["permission"]).toMatchObject({ webfetch: "deny", external_directory: "deny" });
    // The built-in review template, re-declared only to run in ONE session:
    // as a subtask the parent re-reviewed and re-reported every finding.
    expect(c["command"]["review"]).toEqual({
      template: REVIEW_COMMAND_TEMPLATE,
      description: "review changes [commit|branch|pr], defaults to uncommitted",
      subtask: false,
    });
  });

  it("the review template is OpenCode 1.18.33's built-in text", () => {
    expect(
      REVIEW_COMMAND_TEMPLATE.startsWith(
        "You are a code reviewer. Your job is to review code changes and provide actionable feedback.\n\n---\n\nInput: $ARGUMENTS\n\n---\n\n## Determining What to Review",
      ),
    ).toBe(true);
    expect(REVIEW_COMMAND_TEMPLATE.match(/\$ARGUMENTS/g)).toHaveLength(5);
    expect(REVIEW_COMMAND_TEMPLATE).toContain("   - Run: `git diff $ARGUMENTS...HEAD`");
    expect(REVIEW_COMMAND_TEMPLATE).toContain("O(n²) on unbounded data");
    expect(
      REVIEW_COMMAND_TEMPLATE.trimEnd().endsWith(
        'Avoid phrasing like "Great job ...", "Thanks for ...".',
      ),
    ).toBe(true);
    expect(REVIEW_COMMAND_TEMPLATE).not.toContain("findings_report");
  });

  it("env: a fresh HOME/XDG per case, project config and every phone-home off, and no pi login in reach", () => {
    const env = opencodeEnv({
      path: "/usr/bin",
      home: "/wt/x.opencode/home",
      tmpDir: "/t",
      configPath: "/c.json",
    });
    expect(env["XDG_DATA_HOME"]).toBe("/wt/x.opencode/home/.local/share");
    expect(env["OPENCODE_CONFIG"]).toBe("/c.json");
    for (const k of [
      "OPENCODE_DISABLE_PROJECT_CONFIG",
      "OPENCODE_DISABLE_AUTOUPDATE",
      "OPENCODE_DISABLE_SHARE",
      "OPENCODE_DISABLE_MODELS_FETCH",
      "OPENCODE_DISABLE_LSP_DOWNLOAD",
      "OPENCODE_DISABLE_DEFAULT_PLUGINS",
    ])
      expect(env[k], k).toBe("1");
    // OpenCode never sees the credential: no pi agent dir, no token, nothing
    // pointing at the read-only login mount or the sandbox's copy of it.
    const text = JSON.stringify(env);
    expect(env["PI_CODING_AGENT_DIR"]).toBeUndefined();
    expect(text).not.toMatch(/pi-agent|auth\.json|OPENAI_API_KEY|access/i);
  });
});

describe("what OpenCode wrote → what the scorer and the defect judge read", () => {
  it("parses the event stream: the subtask's result, tokens, tools", () => {
    const e = parseOpencodeEvents(EVENTS + "\nnot json\n");
    expect(e.resultText).toContain('"file":"a.py"');
    expect(e.tokens).toEqual({ input: 50, output: 7, reasoning: 3, cacheRead: 50 });
    expect(e.steps).toBe(1);
    expect(e.tools).toEqual({ task: 1 });
    expect(e.sessionId).toBe("ses_1");
    expect(
      parseOpencodeEvents('{"type":"error","error":{"name":"APIError","data":{"message":"boom"}}}')
        .errors,
    ).toEqual(["boom"]);
  });

  it("the dual channel is codex.py's: the larger wins, a tie goes to MCP, raw text scores nothing", () => {
    const mcp = [{ file: "a.py", summary: "s", description: "d" }];
    expect(chooseFindings(mcp, "No findings.")).toMatchObject({
      source: "mcp_stream",
      mcp: 1,
      text: 0,
    });
    expect(chooseFindings(mcp, '[{"file":"b"}]')).toMatchObject({
      source: "mcp_stream",
      review_output: mcp,
    });
    expect(chooseFindings(mcp, '```json\n[{"file":"b"},{"file":"c"}]\n```')).toMatchObject({
      source: "jsonl_fallback",
      mcp: 1,
      text: 2,
    });
    expect(chooseFindings(null, "I looked around, it is mostly fine")).toMatchObject({
      source: "jsonl_fallback",
      review_output: "I looked around, it is mostly fine",
      text: null,
    });
    expect(extractFindingsFromText("Nothing to report.")).toEqual([]);
    expect(toOcrShapedComments("raw text")).toEqual([]);
  });

  it("comments: note = summary + description, the line range as given; empty ones dropped", () => {
    expect(
      toOcrShapedComments([
        {
          file: "a.py",
          start_line: 3,
          end_line: 5,
          severity: "Major",
          summary: " S ",
          description: "D",
        },
        { file: "b.py", start_line: "7", summary: "only" },
        { file: "c.py", summary: "", description: "" },
        "junk",
      ]),
    ).toEqual([
      { path: "a.py", start_line: 3, end_line: 5, content: "S\nD", severity: "Major" },
      { path: "b.py", start_line: 7, end_line: null, content: "only" },
    ]);
  });

  it("the result file carries codex.py's payload AND the OCR reader's copy, which the defect judge reads", () => {
    const tmp = mkdtempSync(join(tmpdir(), "bench-opencode-"));
    try {
      const chosen = chooseFindings(
        [
          {
            file: "a.py",
            start_line: 2,
            end_line: 3,
            severity: "Major",
            summary: "Off by one",
            description: "loop skips the last row",
          },
        ],
        "",
      );
      const payload = opencodeResultPayload({
        c: CASE,
        model: "gpt-6-sol",
        startedAt: "t",
        durationSeconds: 12.345,
        exitCode: 0,
        chosen,
        tokenUsage: { input_tokens: 1 },
        stderr: "",
        bench: {},
      });
      expect(payload).toMatchObject({
        reviewer: "opencode",
        instance_id: CASE.instance_id,
        base_commit: BASE,
        head_commit: HEAD,
        review_output_source: "mcp_stream",
        duration_seconds: 12.35,
        opencode_exit_code: 0,
      });
      expect(scoredOcrComments(payload)).toBe(1);
      mkdirSync(join(tmp, "results", "all"), { recursive: true });
      writeFileSync(
        join(tmp, "results", "all", `${CASE.instance_id}.json`),
        JSON.stringify(payload),
      );
      const r = reviewForJudge(tmp, CASE.instance_id);
      expect(r.comments).toEqual([
        {
          id: "C1",
          path: "a.py",
          line: 2,
          end_line: 3,
          tag: null,
          text: "Off by one\nloop skips the last row",
        },
      ]);
      writeFileSync(join(tmp, "run.json"), JSON.stringify({ reviewer: "opencode" }));
      expect(runArmOf(tmp)).toBe("opencode");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("status: exit 0 with an error event or no model call is not ok", () => {
    const events = parseOpencodeEvents(EVENTS);
    expect(opencodeStatus({ exitCode: 0, timedOut: false, events, bridgeOk: 3 })).toBe("ok");
    expect(opencodeStatus({ exitCode: 0, timedOut: true, events, bridgeOk: 3 })).toBe("timeout");
    expect(opencodeStatus({ exitCode: 1, timedOut: false, events, bridgeOk: 3 })).toBe("failed");
    expect(
      opencodeStatus({
        exitCode: 0,
        timedOut: false,
        events: parseOpencodeEvents(""),
        bridgeOk: 0,
      }),
    ).toBe("no-output");
    expect(
      opencodeStatus({
        exitCode: 0,
        timedOut: false,
        events: { ...events, errors: ["x"] },
        bridgeOk: 3,
      }),
    ).toBe("failed");
  });
});

describe("one case end to end, OpenCode stubbed", () => {
  it("prepares the tree, runs the argv, folds the MCP partial into the result, reports", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "bench-opencode-case-"));
    try {
      // A scratch "prefetched store": a repo with a base and a head commit.
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
      const root = join(tmp, "root");
      const outDir = join(tmp, "out");
      mkdirSync(join(root, "wt"), { recursive: true });
      const seen: { argv?: string[]; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {};
      const runImpl: typeof run = async (bin, args, opts = {}) => {
        if (bin !== "/usr/local/bin/opencode") return run(bin, args, opts);
        seen.argv = args;
        seen.env = opts.env;
        seen.timeoutMs = opts.timeoutMs;
        // What the harness's MCP server would have written for one report() call.
        const cfg = JSON.parse(readFileSync(opts.env!["OPENCODE_CONFIG"]!, "utf8"));
        const dir = cfg.mcp.findings.environment.REVIEW_RESULTS_DIR as string;
        writeFileSync(
          join(dir, `${c.instance_id}.partial.json`),
          JSON.stringify([
            {
              file: "a.py",
              start_line: 2,
              end_line: 3,
              severity: "Major",
              summary: "S",
              description: "D",
            },
          ]),
        );
        return { code: 0, stdout: EVENTS, stderr: "", timedOut: false };
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
              input_tokens: 1000 * stats,
              cached_tokens: 400 * stats,
              output_tokens: 50 * stats,
              reasoning_tokens: 10 * stats,
              by_status: { "200": stats },
              dropped_keys: {},
            }
          : { ok: true };
        if (u.endsWith("/stats")) stats += 4;
        return new Response(JSON.stringify(body), { status: 200 });
      }) as unknown as typeof fetch;
      const s = await reviewCaseOpencode(c, meta, {
        root,
        store,
        outDir,
        opencodeBin: "/usr/local/bin/opencode",
        bridgeUrl: "http://127.0.0.1:8766",
        model: "gpt-6-sol",
        mcpPython: "/opt/aacr-venv/bin/python",
        mcpScript: "/opt/aacr-bench/evaluation/mcp_codex_finding_server.py",
        flags: { timeoutMin: 30, variant: "medium" },
        fingerprint: FP,
        fetchImpl,
        runImpl,
      });
      expect(s.status).toBe("ok");
      expect(s.merge_base_ok).toBe(true);
      expect(s.comments).toBe(1);
      expect(s.review_output_source).toBe("mcp_stream");
      expect(s.mcp_findings).toBe(1);
      expect(s.bridge).toMatchObject({ requests: 4, input_tokens: 4000, cached_tokens: 1600 });
      expect(s.usage).toEqual({ input: 2400, cacheRead: 1600, output: 200 });
      expect(seen.timeoutMs).toBe(1_860_000);
      expect(seen.argv).toContain("--command");
      expect(seen.argv!.at(-1)).toBe(opencodeReviewArguments(base, head));
      expect(seen.env!["HOME"]).toContain(`${c.instance_id}.opencode`);
      const result = JSON.parse(
        readFileSync(join(outDir, "results", "all", `${c.instance_id}.json`), "utf8"),
      );
      expect(result.review.comments).toEqual([
        { path: "a.py", start_line: 2, end_line: 3, content: "S\nD", severity: "Major" },
      ]);
      expect(result.token_usage).toMatchObject({
        input_tokens: 4000,
        cached_input_tokens: 1600,
        output_tokens: 200,
      });
      // The scratch HOME (OpenCode's DB, config, partial) and the tree are gone.
      expect(
        spawnSync("ls", [join(root, "wt")])
          .stdout.toString()
          .trim(),
      ).toBe("");
      const md = renderOpencodeReport(SET, outDir, [c]);
      expect(md).toContain("| acme__widget@bbbbbbb | Python | 2 | ok | 1 (mcp_stream) |");
      expect(md).toContain("task 1");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("the credential: the bridge's refresh-disabled copy, never a refresher", () => {
  it("each case re-takes the copy with the refresh token disabled and never writes the source", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "bench-opencode-auth-"));
    try {
      const src = join(tmp, "src");
      const agent = join(tmp, "agent");
      mkdirSync(src);
      const jwtPayload = Buffer.from(
        JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc" } }),
      ).toString("base64url");
      const real = JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: `h.${jwtPayload}.s`,
          refresh: "REAL-REFRESH-TOKEN",
          expires: Date.now() + 5 * 86_400_000,
        },
      });
      writeFileSync(join(src, "auth.json"), real);
      const out = join(tmp, "out");
      const code = await runOpencodeReview({
        set: SET,
        cases: [CASE],
        outDir: out,
        root: join(tmp, "root"),
        store: join(tmp, "store"),
        authSrc: src,
        agentDir: agent,
        opencodeBin: "opencode",
        opencodeVersion: "1.18.33",
        bridgeUrl: "http://127.0.0.1:1",
        model: "gpt-6-sol",
        effort: "medium",
        verbosity: "medium",
        mcpPython: "p",
        mcpScript: "s",
        flags: { timeoutMin: 30, variant: "medium" },
        qcrCommit: "c",
        resume: false,
        keepTree: false,
        readMeta: () => {
          throw new Error("not prefetched");
        },
        log: () => {},
      });
      expect(code).toBe(1);
      // The source is untouched; the copy carries the disabled sentinel.
      expect(readFileSync(join(src, "auth.json"), "utf8")).toBe(real);
      const copy = readFileSync(join(agent, "auth.json"), "utf8");
      expect(copy).not.toContain("REAL-REFRESH-TOKEN");
      expect(JSON.parse(copy)["openai-codex"].refresh).toBe(DISABLED_REFRESH);
      // An unprefetched case still gets a (zero-comment) result file and the run its record.
      expect(JSON.parse(readFileSync(join(out, "run.json"), "utf8")).reviewer).toBe("opencode");
      expect(
        JSON.parse(readFileSync(join(out, "results", "all", `${CASE.instance_id}.json`), "utf8"))
          .review.comments,
      ).toEqual([]);
      // The bridge — the only thing holding the token — accepts the copy and
      // refuses the real login (so it can never be pointed at a refreshable grant).
      const load = (p: string) =>
        spawnSync(
          "python3",
          [
            "-c",
            "import sys; sys.path.insert(0, sys.argv[1]); import codex_bridge as b; print(b.load_credentials(sys.argv[2])[1])",
            join(ROOT, "bench", "aacr"),
            p,
          ],
          { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } },
        );
      const ok = load(join(agent, "auth.json"));
      expect(ok.status, ok.stderr).toBe(0);
      expect(ok.stdout.trim()).toBe("acc");
      const refused = load(join(src, "auth.json"));
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toContain("refresh token is not the disabled sentinel");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("--resume under a new model drops every mismatched result BEFORE the loop, so an auth stop cannot score model A under model B", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "bench-opencode-resume-"));
    try {
      const out = join(tmp, "out");
      const SAME: BenchCase = { ...CASE, instance_id: "acme__widget@ccccccc" };
      const base: OpencodeFingerprint = {
        qcr_commit: "c",
        opencode_version: "1.18.33",
        model: "model-B",
        effort: "medium",
        variant: "medium",
        timeout_min: 30,
        ...authFingerprint(),
      };
      const fpA: OpencodeFingerprint = { ...base, model: "model-A" };
      const fpB: OpencodeFingerprint = base;
      // Case 0 was reviewed under A; case 1 under B (already matches the resume).
      const seed = (c: BenchCase, fp: OpencodeFingerprint) => {
        mkdirSync(join(out, "cases", c.instance_id), { recursive: true });
        writeFileSync(
          join(out, "cases", c.instance_id, "case-summary.json"),
          JSON.stringify({
            instance_id: c.instance_id,
            arm: "opencode",
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
      // A login too close to expiry for one case: the run stops at the first case it must review.
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
      const code = await runOpencodeReview({
        set: SET,
        cases: [SAME, CASE],
        outDir: out,
        root: join(tmp, "root"),
        store: join(tmp, "store"),
        authSrc: src,
        agentDir: join(tmp, "agent"),
        opencodeBin: "opencode",
        opencodeVersion: fpB.opencode_version,
        bridgeUrl: "http://127.0.0.1:1",
        model: fpB.model,
        effort: fpB.effort,
        verbosity: "medium",
        mcpPython: "p",
        mcpScript: "s",
        flags: { timeoutMin: fpB.timeout_min, variant: fpB.variant },
        qcrCommit: fpB.qcr_commit,
        resume: true,
        keepTree: false,
        readMeta: () => {
          throw new Error("x");
        },
        log: (l) => lines.push(l),
      });
      expect(code).toBe(1);
      expect(lines.join("\n")).toContain("STOPPED");
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

  it("the bridge's self-test passes, streaming replay included", () => {
    const r = spawnSync(
      "python3",
      [join(ROOT, "bench", "aacr", "codex_bridge.py"), "--self-test"],
      {
        encoding: "utf8",
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      },
    );
    expect(r.status, r.stderr).toBe(0);
    const bridge = readFileSync(join(ROOT, "bench", "aacr", "codex_bridge.py"), "utf8");
    expect(bridge).toContain("def chat_stream_chunks(");
    expect(bridge).toContain('if kind == "chat" and req.get("stream") is True:');
  });
});

describe("the sandbox wiring", () => {
  const docker = readFileSync(join(ROOT, "bench", "aacr", "Dockerfile"), "utf8");
  const sh = readFileSync(join(ROOT, "bench", "aacr", "bench.sh"), "utf8");
  const inContainer = readFileSync(join(ROOT, "bench", "aacr", "in-container.sh"), "utf8");
  const arm = readFileSync(join(ROOT, "bench", "aacr", "arm.sh"), "utf8");

  it("pins OpenCode 1.18.33 by sha256 on the shared runtime, with no GitHub route", () => {
    // Above the ocr stage: without BuildKit, every stage above the target builds.
    expect(docker.indexOf("FROM runtime AS opencode")).toBeLessThan(
      docker.indexOf("FROM runtime AS ocr"),
    );
    const stage = docker.slice(
      docker.indexOf("FROM runtime AS opencode"),
      docker.indexOf("FROM runtime AS ocr"),
    );
    expect(stage).toContain("ARG OPENCODE_VERSION=1.18.33");
    expect(stage).toMatch(/ARG OPENCODE_SHA256_LINUX_X64=[0-9a-f]{64}/);
    expect(stage).toContain("sha256sum -c -");
    expect(stage).toContain("codex_bridge.py --self-test");
    expect(stage).toContain("mcp_codex_finding_server.py");
    expect(stage).toMatch(/! test -e scripts && ! command -v gh/);
    expect(stage).toContain("OPENCODE_DISABLE_AUTOUPDATE=1");
  });

  it("bench.sh, in-container.sh and arm.sh know the arm; eval scores `all` only", () => {
    expect(sh).toContain(
      'opencode) IMAGE="${QCR_BENCH_OPENCODE_IMAGE:-qcr-bench-opencode:latest}"; TARGET=opencode',
    );
    expect(sh).toContain("REVIEW_ENTRY=opencode-review");
    expect(inContainer).toContain("opencode-review)");
    expect(inContainer).toContain(
      '[[ "$arm" != qcr ]] && { variants="all"; report_cmd="$arm-report"; }',
    );
    expect(inContainer).toContain('print(json.load(open(sys.argv[1])).get("reviewer") or "qcr")');
    expect(arm).toContain(
      '[[ "$ARM" == ocr || "$ARM" == codex || "$ARM" == opencode || "$ARM" == claude || "$ARM" == pireview || "$ARM" == pragent ]]; then',
    );
    const cli = readFileSync(join(ROOT, "src", "bench", "cli.ts"), "utf8");
    for (const cmd of ["opencode-review", "opencode-report"]) {
      const at = cli.indexOf(`if (f.cmd === "${cmd}")`);
      expect(cli.slice(at, at + 600), cmd).toContain('assertArm(outDir, "opencode")');
    }
  });
});

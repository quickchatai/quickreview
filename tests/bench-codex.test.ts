// The Codex CLI arm of the AACR-Bench harness (src/bench/codex.ts,
// bench/aacr/codex_arm.py): the harness's own runner, the login that can
// never refresh, the result file every reader of this bench scores, and the
// scripts that wire it. No container, no model: stubs and fixtures only.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { benchAuthFrom, DISABLED_REFRESH } from "../src/bench/auth.js";
import {
  CODEX_HARNESS_DEFAULTS,
  codexAuthFrom,
  codexCommentsAsOcr,
  codexDriverArgv,
  codexDriverEnv,
  codexProcessTimeoutMs,
  emptyCodexResult,
  REFRESH_BLACKHOLE,
  summarizeCodexRun,
  withOcrView,
} from "../src/bench/codex.js";
import { caseCostUsd } from "../src/bench/cost.js";
import { reviewForJudge } from "../src/bench/defects.js";
import { runArmOf } from "../src/bench/ocr.js";
import type { BenchCase } from "../src/bench/aacr.js";

const execp = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");

const jwt = (claims: object) =>
  `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
const ACCESS = jwt({
  "https://api.openai.com/auth": { chatgpt_account_id: "acct-from-jwt" },
  sub: "u",
});
const PI_AUTH = JSON.stringify({
  "openai-codex": {
    type: "oauth",
    access: ACCESS,
    refresh: "REAL-REFRESH-TOKEN",
    expires: 9_999_999_999_999,
    accountId: "acct-1",
  },
});

const CASE: BenchCase = {
  instance_id: "o__r@1234567",
  repo: "o/r",
  pr: 1,
  pr_url: "https://github.com/o/r/pull/1",
  base_commit: "b".repeat(40),
  head_commit: "h".repeat(40),
  language: "Python",
  pr_category: "x",
  change_line_count: 10,
  references: 2,
};

let t: string;
beforeEach(() => {
  t = mkdtempSync(join(tmpdir(), "qcr-codex-"));
});
afterEach(() => rmSync(t, { recursive: true, force: true }));

describe("the Codex login: the refresh-disabled copy, never a refresh", () => {
  it("builds a ChatGPT auth.json from the sandbox copy with the sentinel as refresh token", () => {
    const copy = benchAuthFrom(PI_AUTH).json; // what src/bench/auth.ts writes into the tmpfs
    const now = new Date("2026-09-28T08:00:00Z");
    const out = codexAuthFrom(copy, now);
    const a = JSON.parse(out) as {
      auth_mode: string;
      OPENAI_API_KEY: unknown;
      tokens: Record<string, string>;
      last_refresh: string;
    };
    expect(a.auth_mode).toBe("chatgpt");
    expect(a.OPENAI_API_KEY).toBeNull();
    expect(a.tokens.refresh_token).toBe(DISABLED_REFRESH);
    expect(a.tokens.access_token).toBe(ACCESS);
    expect(a.tokens.id_token).toBe(ACCESS);
    expect(a.tokens.account_id).toBe("acct-1");
    // Fresh, so Codex's age-based proactive refresh has nothing to do.
    expect(a.last_refresh).toBe(now.toISOString());
    // The real refresh token appears NOWHERE in what Codex gets.
    expect(out).not.toContain("REAL-REFRESH-TOKEN");
  });

  it("refuses the companion's real login — only the refresh-disabled copy may feed Codex", () => {
    expect(() => codexAuthFrom(PI_AUTH)).toThrow(/disabled sentinel/);
    expect(() => codexAuthFrom(JSON.stringify({ other: { type: "api", key: "k" } }))).toThrow(
      /no openai-codex OAuth login/,
    );
  });

  it("takes the account id from the access token when the login carries none", () => {
    const raw = JSON.parse(benchAuthFrom(PI_AUTH).json);
    delete raw["openai-codex"].accountId;
    const a = JSON.parse(codexAuthFrom(JSON.stringify(raw)));
    expect(a.tokens.account_id).toBe("acct-from-jwt");
    raw["openai-codex"].access = "not-a-jwt";
    expect(() => codexAuthFrom(JSON.stringify(raw))).toThrow(/no ChatGPT account id/);
  });

  it("the driver's environment has no API key, no gateway, no CODEX_HOME, and refreshes go nowhere", () => {
    const env = codexDriverEnv({ path: "/bin", home: "/tmp/h", tmpDir: "/tmp/x" });
    for (const k of ["CODEX_API_KEY", "OPENAI_API_KEY", "CODEX_GATEWAY_URL", "CODEX_HOME"])
      expect(env[k], k).toBeUndefined();
    expect(env["CODEX_REFRESH_TOKEN_URL_OVERRIDE"]).toBe(REFRESH_BLACKHOLE);
    expect(new URL(REFRESH_BLACKHOLE).hostname).toBe("127.0.0.1");
    expect(env["GIT_CONFIG_GLOBAL"]).toBe("/dev/null");
  });

  it("the Python driver refuses an auth.json whose refresh token is real, before importing the harness", async () => {
    const bad = join(t, "auth.json");
    const good = JSON.parse(codexAuthFrom(benchAuthFrom(PI_AUTH).json));
    good.tokens.refresh_token = "REAL-REFRESH-TOKEN";
    writeFileSync(bad, JSON.stringify(good));
    const args = [
      join(ROOT, "bench", "aacr", "codex_arm.py"),
      ...["--instance-id", "x", "--tree", t, "--results", t, "--case-dir", t],
      ...["--home-base", t, "--auth-json", bad],
    ];
    const r = await execp("python3", args, { env: { PATH: process.env.PATH ?? "/usr/bin" } }).then(
      () => ({ code: 0, err: "" }),
      (e: { code: number; stderr: string }) => ({ code: e.code, err: e.stderr }),
    );
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("not a refresh-disabled ChatGPT auth.json");
    // …and an API key in the environment is refused too.
    writeFileSync(bad, codexAuthFrom(benchAuthFrom(PI_AUTH).json));
    const k = await execp("python3", args, {
      env: { PATH: process.env.PATH ?? "/usr/bin", CODEX_API_KEY: "sk-x" },
    }).then(
      () => ({ code: 0, err: "" }),
      (e: { code: number; stderr: string }) => ({ code: e.code, err: e.stderr }),
    );
    expect(k.code).not.toBe(0);
    expect(k.err).toContain("CODEX_API_KEY is set");
  });

  it("codex_arm.py stages the copy into the harness's CODEX_HOME and never writes a refresh", () => {
    const py = read("bench", "aacr", "codex_arm.py");
    expect(py).toContain(`DISABLED_REFRESH = "${DISABLED_REFRESH}"`);
    expect(py).toContain('tokens.get("refresh_token") != DISABLED_REFRESH');
    expect(py).toMatch(/shutil\.copyfile\(auth_src, dst\)/);
    // The harness's cleanup removes the temporary CODEX_HOME, auth.json included.
    expect(py).toContain("cx.cleanup_codex_home(codex_home)");
    expect(py).toContain('os.environ.pop("CODEX_HOME_BACKUP", None)');
  });
});

describe("Codex runs as the harness's reviewers/codex.py runs it", () => {
  it("the driver imports the harness runner and replaces only prepare_repo", () => {
    const py = read("bench", "aacr", "codex_arm.py");
    expect(py).toContain("from reviewers import codex as cx");
    expect(py).toContain("cx.write_codex_config(codex_env)");
    expect(py).toContain("cx.review_instance(");
    expect(py).toContain("cx.prepare_repo = lambda **_kw: tree");
    // Only the model rides codex_env — plus, on the API-key route only, the key
    // the harness's own way (CODEX_API_KEY); never a gateway.
    expect(py).toContain("codex_env: Dict[str, str] = {config.CODEX_MODEL_VAR: a.model}");
    // The self-test pins the harness's argv, prompt and process timeout.
    expect(py).toContain(
      '["codex", "--sandbox", "workspace-write", "exec", "review", "--json", "--skip-git-repo-check"]',
    );
    expect(py).toContain("30 * 60 + 60");
  });

  it("the config prelude is top-level keys only: effort, file credentials, no update check, no web search", () => {
    const py = read("bench", "aacr", "codex_arm.py");
    const prelude = py.slice(py.indexOf("def config_prelude"), py.indexOf("ANALYTICS_OFF ="));
    for (const k of [
      'model_reasoning_effort = "{effort}"',
      'cli_auth_credentials_store = "file"',
      // the login copy by default; "api" only on the API-key route
      'login: str = "chatgpt"',
      'forced_login_method = "{login}"',
      "check_for_update_on_startup = false",
      'web_search = "disabled"',
    ])
      expect(prelude).toContain(k);
    expect(prelude).not.toMatch(/"\[/);
  });

  it("timeout and driver argv", () => {
    expect(CODEX_HARNESS_DEFAULTS.timeoutMin).toBe(30);
    expect(codexProcessTimeoutMs(30)).toBe((30 * 60 + 60) * 1000);
    const argv = codexDriverArgv(
      CASE,
      {
        python: "/py",
        driver: "/d.py",
        dataset: "/ds.jsonl",
        tree: "/wt/x",
        results: "/out/results/all",
        caseDir: "/out/cases/x",
        homeBase: "/wt/x.codex",
        authJson: "/tmp/pi-agent/codex-auth.json",
      },
      { timeoutMin: 30, model: "gpt-6-sol", effort: "medium" },
    );
    expect(argv).toEqual([
      "/d.py",
      "--instance-id",
      CASE.instance_id,
      "--dataset",
      "/ds.jsonl",
      "--tree",
      "/wt/x",
      "--results",
      "/out/results/all",
      "--case-dir",
      "/out/cases/x",
      "--home-base",
      "/wt/x.codex",
      "--auth-json",
      "/tmp/pi-agent/codex-auth.json",
      "--timeout-min",
      "30",
      "--model",
      "gpt-6-sol",
      "--effort",
      "medium",
    ]);
  });
});

describe("the result file: the harness's payload + the OCR-shaped view", () => {
  const harness = {
    instance_id: CASE.instance_id,
    reviewer: "codex",
    model: "gpt-6-sol",
    duration_seconds: 12.5,
    codex_exit_code: 0,
    review_output_source: "mcp_stream",
    review_output: [
      {
        file: "a.py",
        start_line: 3,
        end_line: 5,
        severity: "Major",
        summary: "  S  ",
        description: "D",
      },
      { file: "b.py", start_line: null, end_line: 7, summary: "", description: "" },
      "not a dict",
      { file: "c.py", start_line: 9, summary: "only summary" },
    ],
    token_usage: {
      input_tokens: 1000,
      cached_input_tokens: 600,
      output_tokens: 200,
      reasoning_output_tokens: 50,
    },
    stderr: "",
    stdout: "",
  };

  it("maps findings exactly as evaluate.py build_target_comments_from_codex reads them", () => {
    expect(codexCommentsAsOcr(harness.review_output)).toEqual([
      { path: "a.py", start_line: 3, end_line: 5, content: "S\nD" },
      { path: "c.py", start_line: 9, end_line: null, content: "only summary" },
    ]);
    // The harness's raw-text fallback scores zero comments.
    expect(codexCommentsAsOcr("free text review")).toEqual([]);
  });

  it("keeps every harness key untouched and adds `review` + `bench`", () => {
    const out = withOcrView(harness, { status: "ok" });
    for (const [k, v] of Object.entries(harness)) expect(out[k], k).toEqual(v);
    expect(out["bench"]).toEqual({ status: "ok" });
    expect((out["review"] as { summary: object }).summary).toEqual({
      input_tokens: 1000,
      output_tokens: 200,
      total_tokens: 1200,
    });
  });

  it("the defect judge and the pricing read a Codex run dir unchanged", () => {
    const run = join(t, "run");
    mkdirSync(join(run, "results", "all"), { recursive: true });
    mkdirSync(join(run, "cases", CASE.instance_id), { recursive: true });
    writeFileSync(
      join(run, "results", "all", `${CASE.instance_id}.json`),
      JSON.stringify(withOcrView(harness, {})),
    );
    const r = reviewForJudge(run, CASE.instance_id);
    expect(r.comments.map((c) => [c.path, c.line, c.end_line, c.text])).toEqual([
      ["a.py", 3, 5, "S\nD"],
      ["c.py", 9, 9, "only summary"],
    ]);
    const s = summarizeCodexRun({ exitCode: 0, timedOut: false, result: harness });
    writeFileSync(
      join(run, "cases", CASE.instance_id, "case-summary.json"),
      JSON.stringify({ arm: "codex", ...s }),
    );
    const cost = caseCostUsd(join(run, "cases", CASE.instance_id));
    expect(cost?.source).toBe("priced");
    // 400 uncached × $2 + 600 cached × $0.20 + 200 out × $10, per million.
    expect(cost?.usd).toBeCloseTo((400 * 2 + 600 * 0.2 + 200 * 10) / 1e6, 12);
    expect(s.usage).toEqual({ input: 400, cacheRead: 600, output: 200 });
  });

  it("status: ok, failed (codex exit), timeout (the harness's marker), no-output", () => {
    expect(summarizeCodexRun({ exitCode: 0, timedOut: false, result: harness }).status).toBe("ok");
    expect(
      summarizeCodexRun({
        exitCode: 0,
        timedOut: false,
        result: { ...harness, codex_exit_code: 1 },
      }).status,
    ).toBe("failed");
    expect(
      summarizeCodexRun({
        exitCode: 0,
        timedOut: false,
        result: { ...harness, codex_exit_code: -1, stderr: "Process timed out after 1860 seconds" },
      }).status,
    ).toBe("timeout");
    expect(summarizeCodexRun({ exitCode: 1, timedOut: false, result: null }).status).toBe(
      "no-output",
    );
  });

  it("a case with no result still gets a scored-empty file in the harness's shape", () => {
    const e = withOcrView(emptyCodexResult(CASE, "gpt-6-sol", "boom"), { status: "failed" });
    expect(e["reviewer"]).toBe("codex");
    expect(e["review_output"]).toEqual([]);
    expect((e["review"] as { comments: unknown[] }).comments).toEqual([]);
  });

  it("a Codex run dir is its own arm: quickreviewd commands refuse it", () => {
    writeFileSync(join(t, "run.json"), JSON.stringify({ reviewer: "codex" }));
    expect(runArmOf(t)).toBe("codex");
  });
});

describe("the scripts that wire the Codex arm", () => {
  it("the image pins Codex 0.158.0 by sha256, self-tests the driver, and precedes `ocr`", () => {
    const docker = read("bench", "aacr", "Dockerfile");
    const stage = docker.slice(
      docker.indexOf("FROM runtime AS codex"),
      docker.indexOf("FROM runtime AS ocr"),
    );
    expect(docker.indexOf("FROM runtime AS codex")).toBeGreaterThan(0);
    expect(docker.indexOf("FROM runtime AS codex")).toBeLessThan(
      docker.indexOf("FROM runtime AS ocr"),
    );
    expect(stage).toContain("ARG CODEX_VERSION=0.158.0");
    expect(stage).toMatch(/ARG CODEX_SHA256_LINUX_X64=[0-9a-f]{64}/);
    expect(stage).toContain("sha256sum -c -");
    expect(stage).toContain("codex_arm.py --self-test");
    expect(stage).toMatch(/! test -e scripts && ! command -v gh/);
  });

  it("bench.sh builds and runs the codex target hardened; only its review loosens seccomp", () => {
    const sh = read("bench", "aacr", "bench.sh");
    expect(sh).toContain(
      'codex) IMAGE="${QCR_BENCH_CODEX_IMAGE:-qcr-bench-codex:latest}"; TARGET=codex; BASE_ARGS=(); REVIEW_ENTRY=codex-review\n',
    );
    const tarList = sh.slice(sh.indexOf("tar -cf -"), sh.indexOf("| tar -xf -"));
    expect(tarList).toContain("bench/aacr/codex_arm.py");
    const code = sh
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .join("\n");
    expect(code.match(/seccomp=unconfined/g)?.length).toBe(1);
    expect(sh).toMatch(
      /if \[\[ "\$ARM" == codex \]\]; then\n\s+oe\+=\(--security-opt seccomp=unconfined\)/,
    );
    const review = sh.slice(sh.indexOf("  review)\n"), sh.indexOf("  judge|judge-report)"));
    expect(review).toContain('"${HARDEN[@]}" "${AUTH[@]}" ${oe[@]+"${oe[@]}"}');
  });

  it("in-container dispatches codex-review and scores the `all` variant with the codex report", () => {
    const ic = read("bench", "aacr", "in-container.sh");
    expect(ic).toContain('exec "${CLI[@]}" codex-review --set');
    expect(ic).toContain('[[ "$arm" != qcr ]] && { variants="all"; report_cmd="$arm-report"; }');
    expect(ic).toContain('print(json.load(open(sys.argv[1])).get("reviewer") or "qcr")');
    const cli = read("src", "bench", "cli.ts");
    expect(cli).toContain('if (f.cmd === "codex-review" || f.cmd === "codex-report")');
    // Cases one at a time, like the harness's pipeline default.
    expect(read("src", "bench", "codexcli.ts")).not.toContain("pool(");
  });

  it("arm.sh runs --arm codex per set in its own image and judges it in the quickreviewd image", async () => {
    const b = join(t, "bench", "aacr");
    const runs = join(t, "runs");
    mkdirSync(join(b, "sets"), { recursive: true });
    mkdirSync(join(b, "defects"));
    mkdirSync(runs);
    copyFileSync(join(ROOT, "bench", "aacr", "arm.sh"), join(b, "arm.sh"));
    const A = "o__a@1111111";
    writeFileSync(
      join(b, "sets", "fresh10.json"),
      JSON.stringify({ cases: [{ instance_id: A, change_line_count: 1 }] }),
    );
    writeFileSync(
      join(b, "defects", "fresh10.json"),
      JSON.stringify({ version: "1", cases: { [A]: { defects: [] } } }),
    );
    writeFileSync(
      join(b, "bench.sh"),
      `#!/usr/bin/env bash
echo "IMG=\${QCR_BENCH_IMAGE:-} $*" >> "${t}/calls.log"
cmd="$1"; shift; run=""; only=""
while (($#)); do case "$1" in --run) run="$2"; shift 2;; --only) only="$2"; shift 2;; *) shift;; esac; done
if [[ "$cmd" == review ]]; then
  mkdir -p "$QCR_BENCH_RUNS_DIR/$run"
  python3 -c "import json,sys; json.dump({'reviewer': 'codex', 'cases': [sys.argv[1]]}, open(sys.argv[2], 'w'))" "$only" "$QCR_BENCH_RUNS_DIR/$run/run.json"
fi
exit 0
`,
    );
    chmodSync(join(b, "bench.sh"), 0o755);
    mkdirSync(join(t, "bin"));
    writeFileSync(
      join(t, "bin", "docker"),
      '#!/bin/sh\ncase "$*" in *eval_shards.py*) exit 0;; esac\necho "sha256:img-$3"\n',
    );
    chmodSync(join(t, "bin", "docker"), 0o755);
    const r = await execp(
      "bash",
      [
        join(b, "arm.sh"),
        "--prefix",
        "cx",
        "--arm",
        "codex",
        "--cases",
        `fresh10:${A}`,
        "--eval",
        "1",
      ],
      {
        env: {
          ...process.env,
          PATH: `${join(t, "bin")}:${process.env.PATH}`,
          QCR_BENCH_RUNS_DIR: runs,
          QCR_BENCH_IMAGE: "qcr-bench:x",
          QCR_BENCH_CODEX_IMAGE: "qcr-bench-codex:x",
        },
      },
    );
    expect(r.stdout).toContain("arm cx done");
    const calls = readFileSync(join(t, "calls.log"), "utf8").trim().split("\n");
    expect(calls.find((c) => c.includes(" review "))).toContain(
      `--arm codex --run cx-fresh10 --set fresh10 --only ${A}`,
    );
    for (const j of calls.filter((c) => c.includes(" judge "))) {
      expect(j.startsWith("IMG=qcr-bench:x ")).toBe(true);
      expect(j).not.toContain("--arm");
    }
    expect(calls.find((c) => c.includes(" eval "))).toContain("--arm codex --run cx-fresh10");
    const rec = JSON.parse(readFileSync(join(runs, "cx-fresh10.arm.json"), "utf8"));
    expect(rec.arm).toBe("codex");
    expect(rec.image).toBe("qcr-bench-codex:x");
    expect(existsSync(join(runs, "cx-fresh10", "run.json"))).toBe(true);
  });
});

describe("codex-review --resume with a changed configuration", () => {
  it("a stop before every stale case re-ran leaves those cases incomplete, never scoreable under the new label", async () => {
    const { codexCommand } = await import("../src/bench/codexcli.js");
    const bin = join(t, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "codex"), "#!/bin/sh\necho 'codex-cli 9.9.9'\n");
    chmodSync(join(bin, "codex"), 0o755);
    const fresh: BenchCase = { ...CASE, instance_id: "o__r@1111111" };
    const stale: BenchCase = { ...CASE, instance_id: "o__r@2222222" };
    const out = join(t, "run");
    const fp = (model: string) => ({ qcr_commit: "c1", codex_version: "9.9.9", model, effort: "medium", timeout_min: 30 });
    mkdirSync(join(out, "results", "all"), { recursive: true });
    writeFileSync(join(out, "run.json"), JSON.stringify({ reviewer: "codex", model: "old" }));
    for (const [c, model] of [[fresh, "new"], [stale, "old"]] as const) {
      mkdirSync(join(out, "cases", c.instance_id), { recursive: true });
      writeFileSync(
        join(out, "cases", c.instance_id, "case-summary.json"),
        JSON.stringify({ instance_id: c.instance_id, arm: "codex", status: "ok", fingerprint: fp(model), comments: 1 }),
      );
      writeFileSync(join(out, "results", "all", `${c.instance_id}.json`), "{}");
    }
    const flags: Record<string, string> = { "--out": out, "--model": "new", "--effort": "medium", "--timeout-min": "30" };
    const env = { PATH: process.env.PATH, QCR_BENCH_COMMIT: process.env.QCR_BENCH_COMMIT };
    process.env.PATH = `${bin}:${process.env.PATH}`;
    process.env.QCR_BENCH_COMMIT = "c1";
    const lines: string[] = [];
    let code: number;
    try {
      code = await codexCommand("codex-review", {
        root: t,
        store: join(t, "store"),
        authSrc: join(t, "no-login"), // no auth.json: AuthExpiring on the first case that needs a review
        agentDir: join(t, "agent"),
        get: (k) => flags[k],
        has: (k) => k === "--resume",
        loadSet: () => ({ name: "t", dataset: { source: "s", commit: "c", file: "f", sha256: "x" }, rule: "r", references: 2, cases: [fresh, stale], backups: [] }),
        only: undefined,
        readMeta: () => {
          throw new Error("unreached");
        },
        log: (l) => lines.push(l),
      });
    } finally {
      process.env.PATH = env.PATH;
      if (env.QCR_BENCH_COMMIT === undefined) delete process.env.QCR_BENCH_COMMIT;
      else process.env.QCR_BENCH_COMMIT = env.QCR_BENCH_COMMIT;
    }
    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(/STOPPED/);
    // the case already done under this configuration is kept
    expect(existsSync(join(out, "cases", fresh.instance_id, "case-summary.json"))).toBe(true);
    expect(existsSync(join(out, "results", "all", `${fresh.instance_id}.json`))).toBe(true);
    // the old-configuration case is no longer a result of this run
    expect(existsSync(join(out, "cases", stale.instance_id, "case-summary.json"))).toBe(false);
    expect(existsSync(join(out, "results", "all", `${stale.instance_id}.json`))).toBe(false);
  });
});

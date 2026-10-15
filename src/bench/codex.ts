// The Codex CLI arm of the AACR-Bench harness.
//
// A reference point measured the same way as ours and OCR's: the same PRs,
// the same model (gpt-6-sol) through the same ChatGPT login, the same judges.
// Codex is run by the AACR harness's OWN runner — `evaluation/reviewers/
// codex.py` at the pinned harness commit, imported by bench/aacr/codex_arm.py
// — so its prompt, `codex exec review` argv, temporary CODEX_HOME/config.toml,
// findings MCP server, token accounting and result file are the harness's
// code. This module does what the harness would do around it on its own
// machine: prepare the repo (here: `prepareTree` from the prefetched store,
// as every arm gets it), provide a login, and keep the per-case record.
//
// The login (no-refresh guarantee). Codex gets a native ChatGPT `auth.json`
// built from the sandbox's refresh-disabled pi token copy (src/bench/auth.ts):
// the ACCESS token and account id, with the refresh token set to the disabled
// sentinel — the real refresh token never reaches Codex, so Codex cannot
// refresh (and rotate) the companion's grant even if it tried. Belt and
// braces: `CODEX_REFRESH_TOKEN_URL_OVERRIDE` points any refresh attempt at a
// closed loopback port, and the driver refuses to start if an API key, a
// gateway or a CODEX_HOME is set in its environment.
//
// The result file. The harness's `save_result` payload, untouched, plus two
// keys it does not write: `review` — an OCR-shaped view of the same comments
// (`review.comments[].path/start_line/end_line/content`, `review.summary`
// tokens) so the rest of this bench (the `--reviewer ocr` eval, the defect
// judge, compare.py) reads the file unchanged — and `bench` (ours). The view
// is checked per case by the harness's own two readers
// (`codex_arm.py --check-result`): Codex reader on `review_output` and OCR
// reader on `review` must produce the SAME comments, or the case fails.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { safeId, type BenchCase, type PrefetchMeta } from "./aacr.js";
import { checkMergeBase, harnessProcessTimeoutMs } from "./armrun.js";
import { piUsageFromInclusive } from "./cost.js";
import { benchAuthMode, DISABLED_REFRESH, type BenchAuthMode } from "./auth.js";
import { GIT_ISOLATION_ENV, run } from "./exec.js";
import { prTextFor } from "./prtext.js";
import { prepareTree } from "./runner.js";

/** pipeline.py `apply_defaults`: timeout None → 30 minutes; reviewers/codex.py
 * `run_codex_review`: process timeout = timeout×60 + 60 s. */
export const CODEX_HARNESS_DEFAULTS = { timeoutMin: 30 } as const;

export function codexProcessTimeoutMs(timeoutMin: number): number {
  return harnessProcessTimeoutMs(timeoutMin);
}

/** The driver's outer bound: the harness bounds codex itself
 * (codexProcessTimeoutMs); this only catches a driver that hangs around it.
 * The login a case is admitted with must outlive it. */
export function codexDriverTimeoutMs(timeoutMin: number): number {
  return codexProcessTimeoutMs(timeoutMin) + 5 * 60_000;
}

/** Where any refresh attempt would go: a closed loopback port (codex's own
 * override variable), so even a bug cannot reach OpenAI's token endpoint. */
export const REFRESH_BLACKHOLE = "http://127.0.0.1:9/bench-refresh-disabled";

/** The ChatGPT account id from the access token's claims: the auth claim
 * object is the one carrying `chatgpt_account_id` (its key is a namespaced
 * URL, which is not needed to find it). */
export function jwtAccount(token: string): string | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const claims = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    for (const v of Object.values(claims)) {
      const id = (v as Record<string, unknown> | null)?.["chatgpt_account_id"];
      if (typeof v === "object" && typeof id === "string" && id) return id;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The ChatGPT login in the sandbox's refresh-disabled pi copy, admitted for a
 * third-party reviewer (`consumer`, for the refusal). Refuses a source whose
 * refresh token is anything but the disabled sentinel — so it can never be
 * pointed at the companion's real login. The account id is the login's own,
 * else the access token's claim.
 */
export function sandboxChatgptLogin(
  benchAuthRaw: string,
  consumer: string,
): { cred: Record<string, unknown>; access: string; account: string } {
  const parsed = JSON.parse(benchAuthRaw) as Record<string, unknown>;
  const cred = parsed["openai-codex"] as Record<string, unknown> | undefined;
  if (!cred || cred["type"] !== "oauth" || typeof cred["access"] !== "string" || !cred["access"])
    throw new Error("no openai-codex OAuth login in the sandbox's token copy");
  if (cred["refresh"] !== DISABLED_REFRESH)
    throw new Error(
      `refusing a pi login whose refresh token is not the disabled sentinel — only the sandbox's refresh-disabled copy (src/bench/auth.ts) may feed ${consumer}`,
    );
  const access = cred["access"];
  const account =
    (typeof cred["accountId"] === "string" && cred["accountId"]) || jwtAccount(access);
  if (!account) throw new Error("the pi login carries no ChatGPT account id");
  return { cred, access, account };
}

/**
 * Codex's `auth.json` from the sandbox's refresh-disabled pi copy
 * (sandboxChatgptLogin), never copying a refresh token: the output's is the
 * sentinel, whatever the input held. `id_token` is the access token (a JWT
 * with the same account/plan claims Codex reads from an id token; Codex never
 * verifies its signature).
 */
export function codexAuthFrom(benchAuthRaw: string, now: Date = new Date()): string {
  const { access, account } = sandboxChatgptLogin(benchAuthRaw, "Codex");
  return (
    JSON.stringify(
      {
        auth_mode: "chatgpt",
        OPENAI_API_KEY: null,
        tokens: {
          id_token: access,
          access_token: access,
          refresh_token: DISABLED_REFRESH,
          account_id: account,
        },
        // Fresh, so Codex's age-based proactive refresh never fires.
        last_refresh: now.toISOString(),
      },
      null,
      2,
    ) + "\n"
  );
}

/** The environment the driver (and so Codex, which inherits it) runs with:
 * no API key, no gateway, no CODEX_HOME (the harness makes its own), git
 * without system/global config, and refreshes black-holed. */
export function codexDriverEnv(o: {
  path: string;
  home: string;
  tmpDir: string;
  /** The API-key route (src/bench/auth.ts): the key, handed to the driver
   * under its own name (codex_arm.py API_KEY_VAR), never as an API-key
   * variable Codex or the driver would read on their own. */
  apiKey?: string;
}): NodeJS.ProcessEnv {
  return {
    ...(o.apiKey ? { QCR_CODEX_API_KEY: o.apiKey } : {}),
    PATH: o.path,
    HOME: o.home,
    TMPDIR: o.tmpDir,
    LANG: "C.UTF-8",
    PYTHONDONTWRITEBYTECODE: "1",
    CODEX_REFRESH_TOKEN_URL_OVERRIDE: REFRESH_BLACKHOLE,
    JUDGE_USE_MOCK: "true",
    ...GIT_ISOLATION_ENV,
  };
}

export interface CodexDriverPaths {
  driver: string;
  dataset: string;
  tree: string;
  results: string;
  caseDir: string;
  homeBase: string;
  /** The login copy; `null` on the API-key route (the driver's --api-key). */
  authJson: string | null;
}

/** The driver's argv. `prTextFile` (the equal-inputs switch, src/bench/
 * prtext.ts) makes codex_arm.py append the PR title/body to the harness's own
 * `/review <base>...<head> (…)` instructions — Codex's custom-review-
 * instructions channel; absent, the argv is exactly the published one. */
export function codexDriverArgv(
  c: BenchCase,
  p: CodexDriverPaths,
  o: { timeoutMin: number; model: string; effort: string; prTextFile?: string | null },
): string[] {
  return [
    p.driver,
    "--instance-id",
    c.instance_id,
    "--dataset",
    p.dataset,
    "--tree",
    p.tree,
    "--results",
    p.results,
    "--case-dir",
    p.caseDir,
    "--home-base",
    p.homeBase,
    ...(p.authJson === null ? ["--api-key"] : ["--auth-json", p.authJson]),
    "--timeout-min",
    String(o.timeoutMin),
    "--model",
    o.model,
    "--effort",
    o.effort,
    ...(o.prTextFile ? ["--pr-text", o.prTextFile] : []),
  ];
}

// ---- the result file ----------------------------------------------------------

export interface OcrShapedComment {
  path: unknown;
  start_line: unknown;
  end_line: unknown;
  content: string;
}

function strip(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** evaluate.py `build_target_comments_from_codex`'s note for one finding:
 * `summary + "\n" + description`, each trimmed, an empty one left out; ""
 * when both are (the finding is then skipped). */
export function codexFindingNote(r: Record<string, unknown>): string {
  return [strip(r["summary"]), strip(r["description"])].filter(Boolean).join("\n").trim();
}

/** evaluate.py `build_target_comments_from_codex`, as OCR-reader input: one
 * comment per dict finding with a non-empty `summary + "\n" + description`,
 * `file` → path, start/end lines passed through as they are (both readers
 * normalise ranges the same way). A non-list `review_output` (the harness's
 * raw-text fallback) has no comments, as the harness scores it. */
export function codexCommentsAsOcr(reviewOutput: unknown): OcrShapedComment[] {
  if (!Array.isArray(reviewOutput)) return [];
  const out: OcrShapedComment[] = [];
  for (const f of reviewOutput) {
    if (typeof f !== "object" || f === null || Array.isArray(f)) continue;
    const r = f as Record<string, unknown>;
    const note = codexFindingNote(r);
    if (!note) continue;
    out.push({
      path: "file" in r ? r["file"] : "",
      start_line: r["start_line"] ?? null,
      end_line: r["end_line"] ?? null,
      content: note,
    });
  }
  return out;
}

export interface CodexTokens {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function codexTokens(result: Record<string, unknown>): CodexTokens {
  const u = (result["token_usage"] ?? {}) as Record<string, unknown>;
  return {
    input_tokens: num(u["input_tokens"]),
    cached_input_tokens: num(u["cached_input_tokens"]),
    output_tokens: num(u["output_tokens"]),
    reasoning_output_tokens: num(u["reasoning_output_tokens"]),
  };
}

/** The harness's payload plus the OCR-shaped `review` view and `bench`. */
export function withOcrView(
  result: Record<string, unknown>,
  bench: Record<string, unknown>,
): Record<string, unknown> {
  const t = codexTokens(result);
  return {
    ...result,
    review: {
      comments: codexCommentsAsOcr(result["review_output"]),
      summary: {
        input_tokens: t.input_tokens,
        output_tokens: t.output_tokens,
        total_tokens: t.input_tokens + t.output_tokens,
      },
    },
    bench,
  };
}

/** A result file for a case Codex never produced one for (not prefetched,
 * the driver died): the harness's shape with no findings, so the case's
 * references count against recall instead of vanishing. */
export function emptyCodexResult(
  c: BenchCase,
  model: string,
  error: string,
): Record<string, unknown> {
  return {
    instance_id: c.instance_id,
    repo: c.repo,
    base_commit: c.base_commit,
    head_commit: c.head_commit,
    reviewer: "codex",
    model,
    started_at: new Date().toISOString(),
    duration_seconds: 0,
    codex_exit_code: -1,
    retry_exhausted: null,
    review_output_source: "none",
    review_output: [],
    token_usage: {
      input_tokens: 0,
      cached_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      total_tokens: 0,
    },
    stderr: error,
    stdout: "",
  };
}

// ---- one case -------------------------------------------------------------------

export type CodexStatus = "ok" | "failed" | "timeout" | "no-output";

export interface CodexFingerprint {
  qcr_commit: string;
  codex_version: string;
  model: string;
  effort: string;
  timeout_min: number;
  /** Present only when the PR text was handed over (QCR_BENCH_PR_TEXT=1). */
  pr_text?: true;
  /** Present only on the API-key route (src/bench/auth.ts authFingerprint). */
  auth?: "api-key";
}

export interface CodexCaseSummary {
  instance_id: string;
  arm: "codex";
  status: CodexStatus;
  error?: string;
  fingerprint: CodexFingerprint;
  exit_code: number | null;
  duration_seconds: number;
  /** Comments the scorer reads (both harness readers agree — checked). */
  comments: number;
  /** The harness's pick: `mcp_stream` | `jsonl_fallback` | `none`. */
  review_output_source: string | null;
  /** Codex's own usage (OpenAI style: input includes cached). */
  tokens: CodexTokens | null;
  /** The same tokens in the shape the defect judge's per-PR totals read
   * (pi style: input WITHOUT cache reads). */
  usage: { input: number; output: number; cacheRead: number } | null;
  /** The same tokens under the key the pricing readers take (src/bench/
   * cost.ts, compare.py) — this arm has no bridge; the name is theirs. */
  bridge: {
    input_tokens: number;
    cached_tokens: number;
    output_tokens: number;
    reasoning_tokens: number;
  } | null;
  merge_base_ok: boolean;
  warnings: string[];
  /** With the PR-text switch on: whether this case's title/body reached Codex. */
  pr_text?: boolean;
}

export function summarizeCodexRun(a: {
  exitCode: number | null;
  timedOut: boolean;
  result: Record<string, unknown> | null;
}): Pick<CodexCaseSummary, "status" | "review_output_source" | "tokens" | "usage" | "bridge"> {
  const r = a.result;
  const codexExit = r && typeof r["codex_exit_code"] === "number" ? r["codex_exit_code"] : null;
  const stderr = r && typeof r["stderr"] === "string" ? r["stderr"] : "";
  // A result that records no usage has unknown tokens, never zero.
  const recorded = r?.["token_usage"];
  const tokens =
    r && typeof recorded === "object" && recorded !== null && !Array.isArray(recorded)
      ? codexTokens(r)
      : null;
  const status: CodexStatus =
    a.timedOut || /Process timed out after/.test(stderr)
      ? "timeout"
      : r === null
        ? "no-output"
        : a.exitCode !== 0 || codexExit !== 0
          ? "failed"
          : "ok";
  const usage = tokens
    ? piUsageFromInclusive(tokens.input_tokens, tokens.cached_input_tokens, tokens.output_tokens)
    : null;
  return {
    status,
    review_output_source:
      r && typeof r["review_output_source"] === "string" ? r["review_output_source"] : null,
    tokens,
    usage,
    bridge:
      tokens && usage
        ? {
            input_tokens: tokens.input_tokens,
            cached_tokens: usage.cacheRead,
            output_tokens: tokens.output_tokens,
            reasoning_tokens: tokens.reasoning_output_tokens,
          }
        : null,
  };
}

export interface CodexRunnerOptions {
  root: string;
  store: string;
  outDir: string;
  /** The sandbox's refresh-disabled pi copy (src/bench/auth.ts wrote it). */
  benchAuthFile: string;
  /** Where Codex's auth.json is staged (a tmpfs). */
  codexAuthFile: string;
  python: string;
  driver: string;
  dataset: string;
  model: string;
  effort: string;
  timeoutMin: number;
  fingerprint: CodexFingerprint;
  keepTree?: boolean;
  log?: (line: string) => void;
  /** Hand Codex the PR title/body in its review instructions (src/bench/prtext.ts). */
  prText?: boolean;
  /** Default `benchAuthMode()`; on "api-key" the key is OPENAI_API_KEY. */
  authMode?: BenchAuthMode;
}

function resultPath(outDir: string, c: BenchCase): string {
  return join(outDir, "results", "all", `${safeId(c.instance_id)}.json`);
}

function writeResult(outDir: string, c: BenchCase, payload: Record<string, unknown>): void {
  mkdirSync(join(outDir, "results", "all"), { recursive: true });
  writeFileSync(resultPath(outDir, c), JSON.stringify(payload, null, 2) + "\n");
}

function blankSummary(c: BenchCase, fp: CodexFingerprint): CodexCaseSummary {
  return {
    instance_id: c.instance_id,
    arm: "codex",
    status: "failed",
    fingerprint: fp,
    exit_code: null,
    duration_seconds: 0,
    comments: 0,
    review_output_source: null,
    tokens: null,
    usage: null,
    bridge: null,
    merge_base_ok: false,
    warnings: [],
  };
}

/** Review one case through the harness's Codex runner and write its result
 * file. Never throws for a case that fails — a failure is a recorded outcome
 * with an empty result. */
export async function reviewCaseCodex(
  c: BenchCase,
  meta: PrefetchMeta,
  o: CodexRunnerOptions,
): Promise<CodexCaseSummary> {
  const log = o.log ?? (() => {});
  const safe = safeId(c.instance_id);
  const caseDir = join(o.outDir, "cases", safe);
  const tree = join(o.root, "wt", safe);
  const tmpDir = join(o.root, "wt", `${safe}.tmp`);
  const homeBase = join(o.root, "wt", `${safe}.codex`);
  mkdirSync(caseDir, { recursive: true });
  const started = Date.now();
  const summary = blankSummary(c, o.fingerprint);
  let result: Record<string, unknown> | null = null;
  const apiKeyRoute = (o.authMode ?? benchAuthMode()) === "api-key";
  try {
    let apiKey: string | undefined;
    if (apiKeyRoute) {
      apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey)
        throw new Error("the API-key route needs OPENAI_API_KEY (bench/aacr/openai.env)");
    } else {
      writeFileSync(o.codexAuthFile, codexAuthFrom(readFileSync(o.benchAuthFile, "utf8")), {
        mode: 0o600,
      });
    }
    await prepareTree(join(o.store, safe), tree, meta);
    for (const d of [tmpDir, homeBase]) {
      rmSync(d, { recursive: true, force: true });
      mkdirSync(d, { recursive: true });
    }
    const env = codexDriverEnv({
      path: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      home: process.env.HOME ?? "/tmp",
      tmpDir,
      ...(apiKey ? { apiKey } : {}),
    });
    const mb = await checkMergeBase(run, tree, c, meta, env);
    summary.merge_base_ok = mb.ok;
    if (mb.warning) summary.warnings.push(mb.warning);
    // The harness's result file is written by the driver; a stale one from an
    // earlier attempt must never be read as this attempt's.
    rmSync(resultPath(o.outDir, c), { force: true });
    const prText = prTextFor(meta, o.prText === true);
    if (o.prText) summary.pr_text = prText !== null;
    const prTextFile = prText === null ? null : join(tmpDir, "pr-text.md");
    if (prTextFile !== null) writeFileSync(prTextFile, prText + "\n");
    const argv = codexDriverArgv(
      c,
      {
        driver: o.driver,
        dataset: o.dataset,
        tree,
        results: join(o.outDir, "results", "all"),
        caseDir,
        homeBase,
        authJson: apiKeyRoute ? null : o.codexAuthFile,
      },
      { timeoutMin: o.timeoutMin, model: o.model, effort: o.effort, prTextFile },
    );
    log(
      `codex: ${c.instance_id} — ${meta.diff.files} files, codex exec review via reviewers/codex.py …`,
    );
    const r = await run(o.python, argv, {
      cwd: tree,
      env,
      timeoutMs: codexDriverTimeoutMs(o.timeoutMin),
    });
    writeFileSync(
      join(caseDir, "codex-driver.log"),
      `${r.stderr}\n--- stdout\n${r.stdout.slice(-20_000)}`,
    );
    summary.exit_code = r.code;
    const p = resultPath(o.outDir, c);
    result = existsSync(p)
      ? (JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>)
      : null;
    Object.assign(summary, summarizeCodexRun({ exitCode: r.code, timedOut: r.timedOut, result }));
    if (summary.status !== "ok")
      summary.error = (
        (result && typeof result["stderr"] === "string" ? result["stderr"] : "") ||
        r.stderr ||
        r.stdout
      )
        .trim()
        .slice(-1500);
  } catch (err) {
    summary.status = "failed";
    summary.error = String(err instanceof Error ? err.message : err).slice(0, 2000);
    log(`codex: ${c.instance_id} FAILED — ${summary.error}`);
  } finally {
    rmSync(o.codexAuthFile, { force: true });
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(homeBase, { recursive: true, force: true });
    if (!o.keepTree) rmSync(tree, { recursive: true, force: true });
  }
  summary.duration_seconds = Math.round((Date.now() - started) / 1000);
  const bench = { status: summary.status, fingerprint: o.fingerprint };
  const payload = withOcrView(
    result ?? emptyCodexResult(c, o.model, summary.error ?? "no result"),
    bench,
  );
  writeResult(o.outDir, c, payload);
  summary.comments = (payload["review"] as { comments: unknown[] }).comments.length;
  // The harness's own readers must agree on what is scored.
  const check = await run(o.python, [o.driver, "--check-result", resultPath(o.outDir, c)], {
    env: codexDriverEnv({
      path: process.env.PATH ?? "/usr/bin:/bin",
      home: process.env.HOME ?? "/tmp",
      tmpDir: "/tmp",
    }),
    timeoutMs: 120_000,
  });
  if (check.code !== 0) {
    summary.status = "failed";
    summary.error = `result check failed: ${(check.stderr || check.stdout).trim().slice(-800)}`;
    summary.comments = 0;
    writeResult(
      o.outDir,
      c,
      withOcrView(emptyCodexResult(c, o.model, summary.error), { ...bench, status: "failed" }),
    );
  }
  writeFileSync(join(caseDir, "case-summary.json"), JSON.stringify(summary, null, 2) + "\n");
  log(
    `codex: ${c.instance_id} ${summary.status} — ${summary.comments} comment(s) (${summary.review_output_source ?? "?"}), ${summary.duration_seconds}s` +
      (summary.tokens
        ? `, ${summary.tokens.input_tokens} in (${summary.tokens.cached_input_tokens} cached) / ${summary.tokens.output_tokens} out`
        : ""),
  );
  return summary;
}

/** A case with no prefetched store: failed, WITH an empty result file. */
export function unprefetchedCodexCase(
  outDir: string,
  c: BenchCase,
  fingerprint: CodexFingerprint,
  model: string,
  error: string,
): CodexCaseSummary {
  const summary = { ...blankSummary(c, fingerprint), error };
  const caseDir = join(outDir, "cases", safeId(c.instance_id));
  mkdirSync(caseDir, { recursive: true });
  writeFileSync(join(caseDir, "case-summary.json"), JSON.stringify(summary, null, 2) + "\n");
  writeResult(
    outDir,
    c,
    withOcrView(emptyCodexResult(c, model, error), { status: "failed", fingerprint }),
  );
  return summary;
}

export function readCodexSummary(outDir: string, c: BenchCase): CodexCaseSummary | null {
  const p = join(outDir, "cases", safeId(c.instance_id), "case-summary.json");
  if (!existsSync(p)) return null;
  const s = JSON.parse(readFileSync(p, "utf8")) as Partial<CodexCaseSummary>;
  return s.arm === "codex" ? (s as CodexCaseSummary) : null;
}

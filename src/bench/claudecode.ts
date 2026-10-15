// The Claude Code arm of the AACR-Bench harness — a BENCHMARKED REVIEWER only.
//
// The project never spawns `claude`, with one sanctioned exception
// (CLAUDE.md rule 5): Claude Code may run as a benchmarked reviewer inside
// the locked-down bench/aacr docker sandbox (`bench.sh --arm claude`), never on
// the host, never in the daemon/TUI/companion/review rounds, never as a tool
// our reviewer calls. So this module never spawns `claude` itself: it spawns
// bench/aacr/claude_driver.py, which calls the AACR harness's OWN runner
// (`evaluation/reviewers/claude.py`, pinned in the image) — and that runner is
// what runs `claude`. `in-container.sh claude-review` is the only way in
// (tests/bench-claude.test.ts fences the chain, and that no host path spawns
// `claude` at all).
//
// What is the harness's, exactly (reviewers/claude.py `run_claude_review` +
// `save_result`, pipeline.py `apply_defaults`):
//   claude -p '/code-review <base>...<head> ' --add-dir <repo>
//     --permission-mode acceptEdits --output-format json
//     --mcp-config '{"mcpServers":{"findings":{…mcp_finding_server.py…}}}'
//     --allowed-tools mcp__findings__report
//     --append-system-prompt <the findings-reporting requirement>
//     --settings <a temp file holding the StopFailure hook>
//   cwd = the repo, timeout 30 min → process timeout 30×60+60 s, and the
//   result file `save_result` writes, kept untouched (the view below is added
//   beside it, and scored with the harness's OCR reader).
// `/code-review` is Claude Code's BUILT-IN skill (2.1.283 ships it; no plugin
// is installed), exactly as the harness assumes.
//
// What differs, all mechanical (and said in the report):
//   - the repo is `prepareTree`'s (prefetched objects, detached head) at
//     /work/repo/<owner>__<name> — the harness's own layout (repo/<owner>__<name>)
//     under a directory with no CLAUDE.md above it, instead of a fresh clone;
//   - the credential is Claude Code's own (CLAUDE_CODE_OAUTH_TOKEN from
//     `claude setup-token`, or ANTHROPIC_API_KEY), from bench/aacr/claude.env
//     via `docker run --env-file` — never the host's interactive login — and
//     the model is Claude Code's default for it unless the container's
//     ANTHROPIC_MODEL pins one (bench.sh's QCR_BENCH_CLAUDE_MODEL); either
//     way the case records which model ran;
//   - every case gets a FRESH, empty HOME/CLAUDE_CONFIG_DIR on tmpfs, so no
//     session, memory or settings carry from one case to the next.
//
// The result file gets one thing the harness does not write (its payload stays
// untouched, `review_output` included): `review` — an OCR-shaped view
// (`review.comments[].path/start_line/end_line/content`) that the eval scores
// with the harness's OCR reader and the defect judge reads, exactly as for the
// Codex and OpenCode arms — plus a `bench` marker saying where it came from.
// Why it is needed: Claude Code 2.1.283's `/code-review` is a built-in LOCAL
// command that never sees the harness's findings prompt or its findings MCP
// tool, so `save_result` stores its answer as RAW TEXT, which the harness's
// Claude reader scores as zero. The view is built (`withClaudeView`) from the
// harness's structured findings when it got any, and otherwise by reading the
// stored text with the documented prose parser (src/bench/claudeprose.ts). It
// is built at review time, and `claude-rebuild` rebuilds it for a finished run
// without re-reviewing anything.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeId, selectCases, type BenchCase, type CaseSet, type PrefetchMeta } from "./aacr.js";
import {
  aacrScoreTable,
  checkMergeBase,
  dropStaleMetrics,
  HARNESS_TIMEOUT_MIN,
  harnessProcessTimeoutMs,
  prepareArmCases,
  runLifecycle,
} from "./armrun.js";
import { GIT_ISOLATION_ENV, run } from "./exec.js";
import { datasetLine, reportPreamble, roundMetrics } from "./report.js";
import { claudeRowsForJudge, claudeScoredFindings } from "./claudeshape.js";
import { parseClaudeProse, PROSE_PARSER_VERSION } from "./claudeprose.js";
import { prepareTree } from "./runner.js";

export { claudeRowsForJudge, claudeScoredFindings } from "./claudeshape.js";

/** pipeline.py `apply_defaults`: `--timeout-minutes` None → 30. */
export const CLAUDE_HARNESS_DEFAULTS = { timeoutMin: HARNESS_TIMEOUT_MIN } as const;

/** The pinned Claude Code version (Dockerfile `CLAUDE_CODE_VERSION`). */
export const CLAUDE_CODE_PIN = "2.1.283";

/** reviewers/claude.py: `process_timeout = timeout_minutes * 60 + 60`. Our
 * outer bound on the driver leaves the harness's own timeout room to fire and
 * still write its result file. */
export function claudeProcessTimeoutMs(timeoutMin: number): number {
  return harnessProcessTimeoutMs(timeoutMin);
}
export function driverTimeoutMs(timeoutMin: number): number {
  return claudeProcessTimeoutMs(timeoutMin) + 5 * 60_000;
}

/** The flags reviewers/claude.py passes, in order, after `claude -p <cmd>`. */
export const CLAUDE_HARNESS_FLAGS = [
  "--add-dir",
  "--permission-mode",
  "--output-format",
  "--mcp-config",
  "--allowed-tools",
  "--append-system-prompt",
  "--settings",
] as const;

/** Check the argv the harness ran (the driver's CompletedProcess.args) against
 * the pinned shape. Returns the mismatches — [] is faithful. */
export function checkHarnessArgv(
  argv: unknown,
  o: { repo: string; base: string; head: string },
): string[] {
  const bad: string[] = [];
  if (!Array.isArray(argv) || argv.some((x) => typeof x !== "string"))
    return ["argv is not a list of strings"];
  const a = argv as string[];
  if (a[0] !== "claude") bad.push(`argv[0] is ${JSON.stringify(a[0])}, not "claude"`);
  if (a[1] !== "-p") bad.push(`argv[1] is ${JSON.stringify(a[1])}, not "-p"`);
  if (a[2] !== `/code-review ${o.base}...${o.head} `)
    bad.push(`the prompt is ${JSON.stringify(a[2])}, not "/code-review <base>...<head> "`);
  const rest = a.slice(3);
  if (rest.length !== CLAUDE_HARNESS_FLAGS.length * 2)
    bad.push(`${rest.length} trailing args, expected ${CLAUDE_HARNESS_FLAGS.length * 2}`);
  const val = (flag: string): string | undefined => {
    const i = rest.indexOf(flag);
    return i >= 0 && i % 2 === 0 ? rest[i + 1] : undefined;
  };
  CLAUDE_HARNESS_FLAGS.forEach((flag, k) => {
    if (rest[k * 2] !== flag)
      bad.push(`flag ${k + 1} is ${JSON.stringify(rest[k * 2])}, not ${flag}`);
  });
  if (val("--add-dir") !== o.repo) bad.push(`--add-dir is not the repo (${o.repo})`);
  if (val("--permission-mode") !== "acceptEdits") bad.push("--permission-mode is not acceptEdits");
  if (val("--output-format") !== "json") bad.push("--output-format is not json");
  if (val("--allowed-tools") !== "mcp__findings__report")
    bad.push("--allowed-tools is not mcp__findings__report");
  try {
    const m = JSON.parse(val("--mcp-config") ?? "") as {
      mcpServers?: Record<string, { args?: string[] }>;
    };
    const f = m.mcpServers?.["findings"];
    if (!f || !String(f.args?.[0] ?? "").endsWith("mcp_finding_server.py"))
      bad.push("--mcp-config does not start the harness's findings server");
  } catch {
    bad.push("--mcp-config is not JSON");
  }
  if (!(val("--append-system-prompt") ?? "").includes("mcp__findings__report"))
    bad.push("--append-system-prompt is not the findings requirement");
  return bad;
}

/** Which credential the env-file gave: exactly one of the two, never both. */
export type ClaudeCredential = "oauth-token" | "api-key";

export function pickCredential(env: NodeJS.ProcessEnv): {
  kind: ClaudeCredential;
  vars: Record<string, string>;
} {
  const oauth = (env["CLAUDE_CODE_OAUTH_TOKEN"] ?? "").trim();
  const key = (env["ANTHROPIC_API_KEY"] ?? "").trim();
  if (oauth && key)
    throw new Error(
      "claude-review: bench/aacr/claude.env sets BOTH CLAUDE_CODE_OAUTH_TOKEN and ANTHROPIC_API_KEY — keep exactly one",
    );
  if (oauth) return { kind: "oauth-token", vars: { CLAUDE_CODE_OAUTH_TOKEN: oauth } };
  if (key) return { kind: "api-key", vars: { ANTHROPIC_API_KEY: key } };
  throw new Error(
    "claude-review: no Claude Code credential in the environment — bench/aacr/claude.env must hold CLAUDE_CODE_OAUTH_TOKEN=… (from `claude setup-token`) or ANTHROPIC_API_KEY=…",
  );
}

/** The environment the driver (and so the harness, and so `claude`) runs
 * with: a fresh per-case HOME and CLAUDE_CONFIG_DIR, exactly one credential,
 * the pinned model (ANTHROPIC_MODEL) when there is one, no auto-update, no
 * telemetry or other non-essential traffic, git without any system/global
 * config. Nothing else of the container's environment rides. */
export function claudeEnv(o: {
  path: string;
  home: string;
  tmpDir: string;
  credential: Record<string, string>;
  maxRetries?: string;
  model?: string;
}): NodeJS.ProcessEnv {
  return {
    PATH: o.path,
    HOME: o.home,
    CLAUDE_CONFIG_DIR: join(o.home, ".claude"),
    TMPDIR: o.tmpDir,
    LANG: "C.UTF-8",
    ...o.credential,
    ...(o.maxRetries ? { CLAUDE_CODE_MAX_RETRIES: o.maxRetries } : {}),
    ...(o.model ? { ANTHROPIC_MODEL: o.model } : {}),
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    DISABLE_BUG_COMMAND: "1",
    CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
    CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    ...GIT_ISOLATION_ENV,
  };
}

/** The harness's repo layout: repo/<owner>__<name> (repo_utils.local_repo_path). */
export function claudeRepoPath(workRoot: string, repo: string): string {
  return join(workRoot, "repo", repo.replaceAll("/", "__"));
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

// ---- the OCR-shaped view ----------------------------------------------------------

export type ClaudeViewSource = "harness" | "prose";

/** What the prose parser did for one case (the result file's
 * `bench.claude_prose_parsed`). */
export interface ClaudeProseMarker {
  parser_version: number;
  findings: number;
  /** Findings whose path resolved to one of the PR's changed files… */
  paths_matched: number;
  /** …did not (kept as written; the harness only matches same-file anyway)… */
  paths_unmatched: number;
  /** …or could not be checked (no changed-file list for the case). */
  paths_unchecked: number;
  /** How many changed files the paths were checked against; null = none known. */
  changed_files: number | null;
  skipped: { non_finding: number; recap: number; unlocated: number };
}

/**
 * The result file with its OCR-shaped `review` view (and `bench` marker)
 * rebuilt; the harness's own payload — `review_output` included — is kept as
 * it is. The view comes from the harness's structured findings when
 * `review_output` is a list (even an empty one: the harness then got an
 * answer through its findings tool, and that answer is the one it scores),
 * read exactly as its Claude reader reads them, so the OCR reader scores the
 * same comments. Otherwise (`review_output` is the raw-text fallback, or
 * missing) the stored text is read by the prose parser (claudeprose.ts), with
 * paths resolved against the PR's changed files when they are known. Pure and
 * idempotent: a rebuild replaces the previous view and marker.
 */
export function withClaudeView(
  result: Obj,
  changedFiles: readonly string[] | null,
  /** The text to parse when `review_output` holds none (the case's review.md). */
  fallbackText?: string,
): Obj {
  const ro = result["review_output"];
  const tu = isObj(result["token_usage"]) ? result["token_usage"] : {};
  const summary = {
    input_tokens: num(tu["input_tokens"]),
    output_tokens: num(tu["output_tokens"]),
    total_tokens: num(tu["input_tokens"]) + num(tu["output_tokens"]),
  };
  const bench: Obj = { ...(isObj(result["bench"]) ? result["bench"] : {}) };
  delete bench["claude_prose_parsed"];
  if (Array.isArray(ro)) {
    const comments = claudeRowsForJudge(result) ?? [];
    return {
      ...result,
      review: { comments, summary },
      bench: { ...bench, claude_view: { source: "harness", comments: comments.length } },
    };
  }
  const text = typeof ro === "string" && ro.trim() ? ro : (fallbackText ?? "");
  const parsed = parseClaudeProse(text, changedFiles);
  const comments = parsed.findings.map((f) => ({
    path: f.path,
    start_line: f.start_line,
    end_line: f.end_line,
    content: f.text,
  }));
  const marker: ClaudeProseMarker = {
    parser_version: PROSE_PARSER_VERSION,
    findings: comments.length,
    paths_matched: parsed.findings.filter((f) => f.matched === true).length,
    paths_unmatched: parsed.findings.filter((f) => f.matched === false).length,
    paths_unchecked: parsed.findings.filter((f) => f.matched === null).length,
    changed_files: changedFiles ? changedFiles.length : null,
    skipped: parsed.skipped,
  };
  return {
    ...result,
    review: { comments, summary },
    bench: {
      ...bench,
      claude_view: { source: "prose", comments: comments.length },
      claude_prose_parsed: marker,
    },
  };
}

/** The view's comment count and source, read back from a result file; null
 * when the file has no view. */
export function claudeViewOf(
  result: unknown,
): { comments: number; source: ClaudeViewSource | null } | null {
  if (!isObj(result) || !isObj(result["review"])) return null;
  const c = result["review"]["comments"];
  const b = isObj(result["bench"]) ? result["bench"] : {};
  const v = isObj(b["claude_view"]) ? b["claude_view"] : {};
  const source = v["source"] === "harness" || v["source"] === "prose" ? v["source"] : null;
  return { comments: Array.isArray(c) ? c.length : 0, source };
}

const GIT_ENV: NodeJS.ProcessEnv = {
  PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  HOME: tmpdir(),
  ...GIT_ISOLATION_ENV,
};

/** The PR's changed files (`diff --name-only -M <merge base> <head>`, the new
 * name of a rename) in a checkout that has both commits; null on any failure —
 * checking paths is best-effort and never fails a case. */
export async function changedFilesIn(
  tree: string,
  mergeBase: string,
  head: string,
): Promise<string[] | null> {
  const r = await run(
    "git",
    ["-C", tree, "diff", "-z", "--name-only", "-M", "--no-ext-diff", mergeBase, head],
    { env: GIT_ENV, timeoutMs: 5 * 60_000 },
  );
  if (r.code !== 0) return null;
  return r.stdout.split("\0").filter(Boolean);
}

/** The same, from a prefetched store (mounted read-only): a throwaway repo
 * borrows its objects through `alternates`, as prepareTree does, so the store
 * is never written and never has to pass git's ownership check. */
export async function changedFilesFromStore(
  store: string,
  meta: PrefetchMeta,
): Promise<string[] | null> {
  if (!existsSync(join(store, "objects"))) return null;
  const tmp = mkdtempSync(join(tmpdir(), "claude-files-"));
  try {
    const init = await run("git", ["init", "--quiet", tmp], { env: GIT_ENV });
    if (init.code !== 0) return null;
    writeFileSync(
      join(tmp, ".git", "objects", "info", "alternates"),
      `${join(store, "objects")}\n`,
    );
    return await changedFilesIn(tmp, meta.merge_base, meta.head_commit);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** A changed-file list saved as text, one path per line (`files.txt`). */
export function readFilesList(file: string): string[] | null {
  if (!existsSync(file)) return null;
  return readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

// ---- one case ---------------------------------------------------------------------

/** `auth-failed`: Claude Code could not authenticate — it still exits 0 and
 * prints the error as its "result", so this is read from the output, and it
 * stops the run (every later case would fail the same way). `no-model-call`:
 * exit 0 but no model reported any usage — nothing was reviewed. */
export type ClaudeStatus =
  "ok" | "failed" | "timeout" | "no-output" | "retry-exhausted" | "auth-failed" | "no-model-call";

const AUTH_FAILURE_RE =
  /failed to authenticate|invalid api key|oauth (access )?token (is )?(invalid|expired|revoked)|\b401\b|please run \/login/i;

export interface ClaudeFingerprint {
  qcr_commit: string;
  claude_code_version: string;
  credential: ClaudeCredential;
  timeout_min: number;
  /** The model ANTHROPIC_MODEL pinned; absent = Claude Code's default. */
  model?: string;
}

export interface ClaudeTokens {
  input: number;
  output: number;
  cache_read: number;
  cache_creation: number;
}

export interface ClaudeCaseSummary {
  instance_id: string;
  arm: "claude";
  status: ClaudeStatus;
  error?: string;
  fingerprint: ClaudeFingerprint;
  exit_code: number | null;
  duration_seconds: number;
  /** Comments the eval scores: the result file's OCR-shaped `review` view. */
  comments: number;
  /** Findings the harness's own Claude reader sees (0 on a raw-text result). */
  harness_comments?: number;
  /** Where the view came from: the harness's structured findings, or the
   * prose parser over the stored text. */
  view_source?: ClaudeViewSource | null;
  /** `mcp_stream` | `stdout_fallback` — which channel save_result kept. */
  review_output_source: string | null;
  /** True when review_output is the harness's raw-text fallback (scores 0). */
  raw_text_fallback: boolean;
  /** Every model Claude Code's JSON output reports usage for… */
  models: string[];
  /** …and the one that produced the most output tokens: the model that ran. */
  model: string | null;
  tokens: ClaudeTokens | null;
  /** Claude Code's own `total_cost_usd` (API-price equivalent). */
  cost_usd: number | null;
  num_turns: number | null;
  /** Did the argv the harness ran match the pinned shape? */
  argv_ok: boolean;
  argv_mismatches: string[];
  merge_base_ok: boolean;
  warnings: string[];
}

/** Status + what ran, from the result file save_result wrote. */
export function summarizeClaudeResult(a: {
  result: unknown;
  driverExit: number;
  driverTimedOut: boolean;
  /** Claude Code's stdout (the JSON envelope), when the driver saved it. */
  stdout?: string;
}): Pick<
  ClaudeCaseSummary,
  | "status"
  | "exit_code"
  | "comments"
  | "harness_comments"
  | "view_source"
  | "review_output_source"
  | "raw_text_fallback"
  | "models"
  | "model"
  | "tokens"
  | "cost_usd"
  | "num_turns"
> {
  const r = isObj(a.result) ? a.result : null;
  const exit = r && typeof r["claude_exit_code"] === "number" ? r["claude_exit_code"] : null;
  const tu = r && isObj(r["token_usage"]) ? r["token_usage"] : null;
  const mu = tu && isObj(tu["model_usage"]) ? tu["model_usage"] : {};
  const models = Object.keys(mu).sort();
  let model: string | null = null;
  let best = -1;
  for (const m of models) {
    const u = mu[m];
    const out = isObj(u) ? num(u["outputTokens"]) : 0;
    if (out > best) {
      best = out;
      model = m;
    }
  }
  const stderr = r && typeof r["stderr"] === "string" ? r["stderr"] : "";
  const status: ClaudeStatus = a.driverTimedOut
    ? "timeout"
    : r === null
      ? "no-output"
      : exit === -1 && /timed out/i.test(stderr)
        ? "timeout"
        : r["retry_exhausted"]
          ? "retry-exhausted"
          : exit !== 0 || a.driverExit !== 0
            ? "failed"
            : "ok";
  // Exit 0 is not success: an auth failure (or any API error before the first
  // model call) is printed as the envelope's `result` with exit 0.
  let envelope: Obj | null = null;
  try {
    const e = JSON.parse(a.stdout ?? "") as unknown;
    envelope = isObj(e) ? e : null;
  } catch {
    envelope = null;
  }
  const said = typeof envelope?.["result"] === "string" ? envelope["result"] : "";
  const raw = typeof r?.["review_output"] === "string" ? r["review_output"] : "";
  const finalStatus: ClaudeStatus =
    status !== "ok"
      ? status
      : models.length === 0 || envelope?.["is_error"] === true
        ? AUTH_FAILURE_RE.test(said) || AUTH_FAILURE_RE.test(raw)
          ? "auth-failed"
          : "no-model-call"
        : "ok";
  const harness = claudeScoredFindings(r).length;
  const view = claudeViewOf(r);
  return {
    status: finalStatus,
    exit_code: exit,
    // what the eval scores: the view when the file has one
    comments: view ? view.comments : harness,
    harness_comments: harness,
    view_source: view ? view.source : null,
    review_output_source:
      r && typeof r["review_output_source"] === "string" ? r["review_output_source"] : null,
    raw_text_fallback: !!r && typeof r["review_output"] === "string",
    models,
    model,
    tokens: tu
      ? {
          input: num(tu["input_tokens"]),
          output: num(tu["output_tokens"]),
          cache_read: num(tu["cache_read_input_tokens"]),
          cache_creation: num(tu["cache_creation_input_tokens"]),
        }
      : null,
    cost_usd: r && typeof r["claude_cost_usd"] === "number" ? r["claude_cost_usd"] : null,
    num_turns: r && typeof r["claude_num_turns"] === "number" ? r["claude_num_turns"] : null,
  };
}

/** The final text Claude Code printed (the JSON envelope's `result`), which
 * is what `/code-review` said to the user — the defect judge reads it as the
 * review body (cases/<id>/review.md). */
export function claudeFinalText(stdout: string): string {
  try {
    const e = JSON.parse(stdout) as unknown;
    if (isObj(e) && typeof e["result"] === "string") return e["result"];
  } catch {
    // stream-json: the `result` event, as the harness's fallback reads it
    for (const line of stdout.split("\n")) {
      try {
        const e = JSON.parse(line) as unknown;
        if (isObj(e) && e["type"] === "result" && typeof e["result"] === "string")
          return e["result"];
      } catch {
        // not an event line
      }
    }
  }
  return "";
}

export interface ClaudeRunnerOptions {
  /** Where case repos are materialised: a disk-backed anonymous volume with no
   * CLAUDE.md anywhere above it (Claude Code reads parent-dir CLAUDE.md files). */
  workRoot: string;
  store: string;
  outDir: string;
  /** The driver: `<python> claude_driver.py` (the harness venv's python). */
  python: string;
  driver: string;
  /** The container's PATH, and where per-case HOMEs go (a tmpfs). */
  path: string;
  homeRoot: string;
  credential: Record<string, string>;
  /** ANTHROPIC_MODEL for `claude`; absent = Claude Code's default. */
  model?: string;
  /** CLAUDE_CODE_MAX_RETRIES for `claude`, from the command's environment. */
  maxRetries?: string;
  timeoutMin: number;
  fingerprint: ClaudeFingerprint;
  keepTree?: boolean;
  log?: (line: string) => void;
}

/** A case's summary before anything is known of it: failed, nothing ran. */
function failedClaudeSummary(c: BenchCase, fingerprint: ClaudeFingerprint): ClaudeCaseSummary {
  return {
    instance_id: c.instance_id,
    arm: "claude",
    status: "failed",
    fingerprint,
    exit_code: null,
    duration_seconds: 0,
    comments: 0,
    review_output_source: null,
    raw_text_fallback: false,
    models: [],
    model: null,
    tokens: null,
    cost_usd: null,
    num_turns: null,
    argv_ok: false,
    argv_mismatches: [],
    merge_base_ok: false,
    warnings: [],
  };
}

function writeClaudeSummary(outDir: string, s: ClaudeCaseSummary): void {
  const caseDir = join(outDir, "cases", safeId(s.instance_id));
  mkdirSync(caseDir, { recursive: true });
  writeFileSync(join(caseDir, "case-summary.json"), JSON.stringify(s, null, 2) + "\n");
}

function readJson(p: string): unknown {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return undefined;
  }
}

/** Review one case with Claude Code, through the harness's runner. Never
 * throws for a case that fails — a failure is a recorded outcome, and a
 * result file always exists so the case counts against recall. */
export async function reviewCaseClaude(
  c: BenchCase,
  meta: PrefetchMeta,
  o: ClaudeRunnerOptions,
): Promise<ClaudeCaseSummary> {
  const log = o.log ?? (() => {});
  const safe = safeId(c.instance_id);
  const caseDir = join(o.outDir, "cases", safe);
  const resultsDir = join(o.outDir, "results", "all");
  const tree = claudeRepoPath(o.workRoot, c.repo);
  const home = join(o.homeRoot, safe);
  const tmpDir = join(o.homeRoot, `${safe}.tmp`);
  mkdirSync(caseDir, { recursive: true });
  mkdirSync(resultsDir, { recursive: true });
  const started = Date.now();
  const summary = failedClaudeSummary(c, o.fingerprint);
  const resultFile = join(resultsDir, `${safe}.json`);
  rmSync(resultFile, { force: true });
  // An earlier attempt's body must not outlive it: the defect judge and
  // claude-rebuild read review.md whatever this attempt's status.
  rmSync(join(caseDir, "review.md"), { force: true });
  try {
    await prepareTree(join(o.store, safe), tree, meta);
    for (const d of [home, tmpDir]) {
      rmSync(d, { recursive: true, force: true });
      mkdirSync(d, { recursive: true });
    }
    const env = claudeEnv({
      path: o.path,
      home,
      tmpDir,
      credential: o.credential,
      maxRetries: o.maxRetries,
      model: o.model,
    });
    const mb = await checkMergeBase(run, tree, c, meta, env);
    summary.merge_base_ok = mb.ok;
    if (mb.warning) summary.warnings.push(mb.warning);
    const argvFile = join(caseDir, "claude-argv.json");
    const stdoutFile = join(caseDir, "claude-stdout.json");
    rmSync(argvFile, { force: true });
    rmSync(stdoutFile, { force: true });
    log(
      `claude: ${c.instance_id} — ${meta.diff.files} files, /code-review ${c.base_commit.slice(0, 7)}...${c.head_commit.slice(0, 7)}`,
    );
    const r = await run(
      o.python,
      [
        o.driver,
        "--repo",
        tree,
        "--repo-name",
        c.repo,
        "--base",
        c.base_commit,
        "--head",
        c.head_commit,
        "--instance-id",
        c.instance_id,
        "--results-dir",
        resultsDir,
        "--timeout-min",
        String(o.timeoutMin),
        "--argv-out",
        argvFile,
        "--stdout-out",
        stdoutFile,
      ],
      { cwd: tree, env, timeoutMs: driverTimeoutMs(o.timeoutMin) },
    );
    writeFileSync(join(caseDir, "driver.log"), `${r.stdout}\n--- stderr\n${r.stderr}`);
    const argv = readJson(argvFile);
    summary.argv_mismatches =
      argv === undefined
        ? ["the driver wrote no argv"]
        : checkHarnessArgv(argv, { repo: tree, base: c.base_commit, head: c.head_commit });
    summary.argv_ok = summary.argv_mismatches.length === 0;
    let result = readJson(resultFile);
    const stdout = existsSync(stdoutFile) ? readFileSync(stdoutFile, "utf8") : "";
    const finalText = claudeFinalText(stdout);
    if (isObj(result)) {
      // The OCR-shaped view the eval scores, beside the harness's payload.
      const files = await changedFilesIn(tree, meta.merge_base, c.head_commit);
      result = withClaudeView(result, files, finalText);
      writeFileSync(resultFile, JSON.stringify(result, null, 2) + "\n");
    }
    Object.assign(
      summary,
      summarizeClaudeResult({ result, driverExit: r.code, driverTimedOut: r.timedOut, stdout }),
    );
    if (finalText.trim()) writeFileSync(join(caseDir, "review.md"), finalText.trim() + "\n");
    if (summary.status !== "ok") {
      const stderr = isObj(result) && typeof result["stderr"] === "string" ? result["stderr"] : "";
      summary.error = (
        finalText.trim() ||
        stderr.trim() ||
        r.stderr.trim() ||
        r.stdout.trim()
      ).slice(-1500);
    }
  } catch (err) {
    summary.status = "failed";
    summary.error = String(err instanceof Error ? err.message : err).slice(0, 2000);
    log(`claude: ${c.instance_id} FAILED — ${summary.error}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(tmpDir, { recursive: true, force: true });
    if (!o.keepTree) rmSync(tree, { recursive: true, force: true });
  }
  // The harness always leaves a result file; a case that never reached it
  // still needs one, or the scorer would drop it from both denominators.
  if (!existsSync(resultFile))
    writeFileSync(
      resultFile,
      JSON.stringify(emptyClaudeResult(c, summary.error ?? ""), null, 2) + "\n",
    );
  summary.duration_seconds = Math.round((Date.now() - started) / 1000);
  writeClaudeSummary(o.outDir, summary);
  log(
    `claude: ${c.instance_id} ${summary.status} — ${summary.comments} finding(s), ${summary.duration_seconds}s, model ${summary.model ?? "?"}` +
      (summary.cost_usd !== null ? `, $${summary.cost_usd.toFixed(2)}` : "") +
      (summary.argv_ok ? "" : ` — ARGV DRIFT: ${summary.argv_mismatches.join("; ")}`),
  );
  return summary;
}

/** save_result's shape for a case that produced nothing (with its empty view). */
export function emptyClaudeResult(c: BenchCase, error: string): Obj {
  return withClaudeView(
    {
      instance_id: c.instance_id,
      repo: c.repo,
      base_commit: c.base_commit,
      head_commit: c.head_commit,
      reviewer: "claude-code/code-review",
      model: null,
      started_at: new Date().toISOString(),
      duration_seconds: 0,
      claude_exit_code: -1,
      retry_exhausted: null,
      review_output_source: "stdout_fallback",
      review_output: [],
      stderr: error,
    },
    null,
  );
}

/** A case with no prefetched store: failed WITH an empty result file. */
export function unprefetchedClaudeCase(
  outDir: string,
  c: BenchCase,
  fingerprint: ClaudeFingerprint,
  error: string,
): ClaudeCaseSummary {
  const s: ClaudeCaseSummary = { ...failedClaudeSummary(c, fingerprint), error };
  writeClaudeSummary(outDir, s);
  // An earlier attempt's body must not outlive it: the defect judge and
  // claude-rebuild read review.md whatever this case's status.
  rmSync(join(outDir, "cases", safeId(c.instance_id), "review.md"), { force: true });
  const dir = join(outDir, "results", "all");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${safeId(c.instance_id)}.json`),
    JSON.stringify(emptyClaudeResult(c, error), null, 2) + "\n",
  );
  return s;
}

export function readClaudeSummary(outDir: string, c: BenchCase): ClaudeCaseSummary | null {
  const s = readJson(join(outDir, "cases", safeId(c.instance_id), "case-summary.json")) as
    Partial<ClaudeCaseSummary> | undefined;
  return s?.arm === "claude" ? (s as ClaudeCaseSummary) : null;
}

// ---- rebuilding the view of a finished run ---------------------------------------

export interface ClaudeRebuildCommand {
  set: CaseSet;
  only?: string[];
  outDir: string;
  /** Where each case's changed files come from: a directory of
   * `<safe id>/files.txt` lists, checked first… */
  filesDir?: string;
  /** …then the prefetched store (`<store>/<safe id>` + its bench-meta.json). */
  store?: string;
  readMeta?: (c: BenchCase) => PrefetchMeta;
  log: (line: string) => void;
}

export interface ClaudeRebuildCase {
  instance_id: string;
  source: ClaudeViewSource | null;
  comments: number;
  prose?: ClaudeProseMarker;
}

/** `cli.js claude-rebuild`: rebuild every case's `review` view (and `bench`
 * marker) from the result file the harness wrote — no model, no network, no
 * re-review; the harness's payload stays as it is. Updates each
 * case-summary.json's counts to match. A case with no result file is
 * reported and skipped. */
export async function claudeRebuildRun(o: ClaudeRebuildCommand): Promise<ClaudeRebuildCase[]> {
  const out: ClaudeRebuildCase[] = [];
  let missing = 0;
  let changed = 0;
  for (const c of selectCases(o.set, o.only)) {
    const safe = safeId(c.instance_id);
    const resultFile = join(o.outDir, "results", "all", `${safe}.json`);
    const result = readJson(resultFile);
    if (!isObj(result)) {
      missing++;
      o.log(
        existsSync(resultFile)
          ? `claude-rebuild: ${c.instance_id} — ${resultFile} is unreadable or not a JSON object, skipped`
          : `claude-rebuild: ${c.instance_id} — no result file, skipped`,
      );
      continue;
    }
    let files: string[] | null = o.filesDir
      ? readFilesList(join(o.filesDir, safe, "files.txt"))
      : null;
    if (!files && o.store && o.readMeta) {
      try {
        files = await changedFilesFromStore(join(o.store, safe), o.readMeta(c));
      } catch {
        files = null;
      }
    }
    const md = join(o.outDir, "cases", safe, "review.md");
    const next = withClaudeView(
      result,
      files,
      existsSync(md) ? readFileSync(md, "utf8") : undefined,
    );
    const text = JSON.stringify(next, null, 2) + "\n";
    if (readFileSync(resultFile, "utf8") !== text) {
      // The metrics scored the old results: they go BEFORE the first result
      // changes, so a rebuild cut short never leaves them beside new findings
      // (and a re-run, finding those bytes already written, would not know).
      if (changed === 0)
        dropStaleMetrics(
          join(o.outDir, "results", "all"),
          o.log,
          "claude-rebuild",
          "the rebuilt view",
        );
      changed++;
      writeFileSync(resultFile, text);
    }
    const view = claudeViewOf(next)!;
    const bench = next["bench"] as Obj;
    const prose = bench["claude_prose_parsed"] as ClaudeProseMarker | undefined;
    const summary = readClaudeSummary(o.outDir, c);
    if (summary) {
      summary.comments = view.comments;
      summary.harness_comments = claudeScoredFindings(next).length;
      summary.view_source = view.source;
      writeClaudeSummary(o.outDir, summary);
    }
    out.push({ instance_id: c.instance_id, source: view.source, comments: view.comments, prose });
    o.log(
      `claude-rebuild: ${c.instance_id} — ${view.comments} comment(s) from the ${view.source === "prose" ? "prose parser" : "harness's findings"}` +
        (prose
          ? prose.changed_files === null
            ? " (paths unchecked: no changed-file list)"
            : `, paths ${prose.paths_matched}/${prose.findings} matched to ${prose.changed_files} changed file(s)`
          : ""),
    );
  }
  const n = out.reduce((a, x) => a + x.comments, 0);
  o.log(
    `claude-rebuild: ${out.length} case(s) rebuilt (${out.filter((x) => x.source === "prose").length} from prose), ${n} comment(s)` +
      (missing ? `; ${missing} case(s) had no readable result file` : ""),
  );
  return out;
}

// ---- the whole run -------------------------------------------------------------

export interface ClaudeReviewCommand {
  set: CaseSet;
  only?: string[];
  outDir: string;
  store: string;
  workRoot: string;
  homeRoot: string;
  python: string;
  driver: string;
  timeoutMin: number;
  resume: boolean;
  keepTree: boolean;
  env: NodeJS.ProcessEnv;
  readMeta: (c: BenchCase) => PrefetchMeta;
  log: (line: string) => void;
}

/** `cli.js claude-review`: every case ONE AT A TIME (the harness's default
 * concurrency is 1), each through reviewCaseClaude. */
export async function claudeReviewRun(o: ClaudeReviewCommand): Promise<number> {
  if (!Number.isInteger(o.timeoutMin) || o.timeoutMin < 1)
    throw new Error("claude-review: --timeout-min must be a positive integer");
  const cred = pickCredential(o.env);
  const version = (o.env["QCR_CLAUDE_VERSION"] ?? "").trim() || "unknown";
  const model = (o.env["ANTHROPIC_MODEL"] ?? "").trim() || undefined;
  const cases = selectCases(o.set, o.only);
  const fingerprint: ClaudeFingerprint = {
    qcr_commit: o.env["QCR_BENCH_COMMIT"] ?? "unknown",
    claude_code_version: version,
    credential: cred.kind,
    timeout_min: o.timeoutMin,
    ...(model ? { model } : {}),
  };
  mkdirSync(o.outDir, { recursive: true });
  const runFile = join(o.outDir, "run.json");
  const previous = readJson(runFile) as Obj | undefined;
  if (previous && previous["reviewer"] !== "claude")
    throw new Error(
      `${o.outDir} holds another arm's run (reviewer ${JSON.stringify(previous["reviewer"] ?? "QuickReview")}) — pick a new --run`,
    );
  // run.json is about to carry THIS configuration, so no case reviewed under
  // another may stay a result of the run: without --resume every case goes;
  // with it, every case whose fingerprint differs goes now (its judge inputs
  // with it), not when the loop reaches it — a stop partway (an auth failure)
  // must leave those cases unreviewed, never scored under the new label. The
  // run's metrics go before the first result changes; a resume that skips
  // every case keeps them.
  const prep = prepareArmCases({
    outDir: o.outDir,
    cases,
    resume: o.resume,
    fingerprint,
    readSummary: readClaudeSummary,
    log: o.log,
    arm: "claude",
    differs: "a different build/version",
  });
  const runRecord = {
    reviewer: "claude",
    set: o.set.name,
    dataset: o.set.dataset,
    claude_code_version: version,
    credential: cred.kind,
    model: model
      ? `${model} (pinned by ANTHROPIC_MODEL; per case: case-summary.json \`model\`)`
      : "Claude Code's default for the credential (per case: case-summary.json `model`)",
    pinned_model: model ?? null,
    invocation:
      "AACR harness evaluation/reviewers/claude.py run_claude_review + save_result, via bench/aacr/claude_driver.py",
    flags: { timeout_min: o.timeoutMin },
    qcr_commit: fingerprint.qcr_commit,
    cases: cases.map((c) => c.instance_id),
    ...runLifecycle(o.resume, previous ?? null, fingerprint),
    finished_at: null as string | null,
  };
  writeFileSync(runFile, JSON.stringify(runRecord, null, 2) + "\n");
  const summaries: ClaudeCaseSummary[] = [];
  for (const c of cases) {
    const prior = readClaudeSummary(o.outDir, c);
    // A prior summary left here is this configuration's (the rest went above).
    if (o.resume && prior && prior.status === "ok") {
      o.log(`claude: ${c.instance_id} already done — skipped (--resume)`);
      summaries.push(prior);
      continue;
    }
    prep.beforeReview();
    let meta: PrefetchMeta;
    try {
      meta = o.readMeta(c);
    } catch (err) {
      const error = String(err instanceof Error ? err.message : err);
      o.log(error);
      summaries.push(unprefetchedClaudeCase(o.outDir, c, fingerprint, error));
      continue;
    }
    const s = await reviewCaseClaude(c, meta, {
      workRoot: o.workRoot,
      store: o.store,
      outDir: o.outDir,
      python: o.python,
      driver: o.driver,
      path: o.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
      homeRoot: o.homeRoot,
      credential: cred.vars,
      model,
      maxRetries: o.env["CLAUDE_CODE_MAX_RETRIES"],
      timeoutMin: o.timeoutMin,
      fingerprint,
      keepTree: o.keepTree,
      log: o.log,
    });
    summaries.push(s);
    if (s.status === "auth-failed") {
      o.log(
        `claude: STOPPED — Claude Code could not authenticate (${s.error ?? "?"}). Renew the token in bench/aacr/claude.env (\`claude setup-token\`), then re-run with --resume.`,
      );
      break;
    }
  }
  runRecord.finished_at = new Date().toISOString();
  writeFileSync(runFile, JSON.stringify(runRecord, null, 2) + "\n");
  const ok = summaries.filter((s) => s.status === "ok").length;
  o.log(`claude: ${ok}/${cases.length} reviewed — results in ${join(o.outDir, "results", "all")}`);
  return ok === cases.length ? 0 : 1;
}

// ---- the report ------------------------------------------------------------------

/** The Claude Code arm's report: the harness's numbers (its Claude reader),
 * then per case what ran, which model, and what it cost. */
export function renderClaudeReport(set: CaseSet, outDir: string, cases: BenchCase[]): string {
  const L: string[] = [];
  const run = (readJson(join(outDir, "run.json")) ?? {}) as Obj;
  const judgeFile = join(outDir, "judge.txt");
  const judge = existsSync(judgeFile)
    ? readFileSync(judgeFile, "utf8").trim().split("\n")
    : ["not run"];
  const summaries = cases.map((c) => ({ c, s: readClaudeSummary(outDir, c) }));
  const models = [...new Set(summaries.flatMap((x) => (x.s?.model ? [x.s.model] : [])))];
  L.push(`# AACR-Bench run — ${set.name} — Claude Code`);
  L.push("");
  L.push(reportPreamble(set));
  L.push("");
  L.push(datasetLine(set, cases));
  L.push(
    `- Reviewer: Claude Code ${String(run["claude_code_version"] ?? "?")}, run by the AACR harness's own reviewers/claude.py: \`claude -p '/code-review <base_commit>...<head_commit> ' --add-dir <repo> --permission-mode acceptEdits --output-format json --mcp-config <findings server> --allowed-tools mcp__findings__report --append-system-prompt <findings requirement> --settings <StopFailure hook>\`, timeout ${String((run["flags"] as Obj | undefined)?.["timeout_min"] ?? "?")} min; no PR title/description (the harness passes none)`,
  );
  L.push(
    `- Model: ${models.length ? models.map((m) => `\`${m}\``).join(", ") : "?"} — ${typeof run["pinned_model"] === "string" ? `pinned by ANTHROPIC_MODEL=\`${run["pinned_model"]}\`` : `Claude Code's default for its ${String(run["credential"] ?? "?")} credential`} (this arm records what ran)`,
  );
  L.push(`- Judge: ${judge[0] ?? ""}`);
  for (const w of judge.slice(1)) L.push(`  ${w}`);
  L.push("");
  L.push("## Scores (the AACR harness, OCR reader on the `review.comments` view)");
  L.push("");
  L.push(...aacrScoreTable(roundMetrics(join(outDir, "results", "all"), "ocr"), cases.length));
  L.push("");
  L.push("## Per case");
  L.push("");
  L.push(
    "| Case | Refs | Status | Findings | Source | Model | Turns | Minutes | Tokens in (cache read/created) / out | $ |",
  );
  L.push("|---|---|---|---|---|---|---|---|---|---|");
  let usd = 0;
  let unknownCost = 0;
  for (const { c, s } of summaries) {
    if (!s) {
      L.push(`| ${c.instance_id} | ${c.references} | not run | — | — | — | — | — | — | — |`);
      continue;
    }
    if (s.cost_usd === null) unknownCost++;
    else usd += s.cost_usd;
    const t = s.tokens;
    L.push(
      `| ${c.instance_id} | ${c.references} | ${s.status}${s.argv_ok ? "" : " (argv drift)"} | ${s.comments}${s.view_source === "prose" ? " (prose)" : s.raw_text_fallback ? " (raw text)" : ""} | ${s.review_output_source ?? "?"} | ${s.model ?? "?"} | ${s.num_turns ?? "?"} | ${(s.duration_seconds / 60).toFixed(1)} | ${t ? `${t.input} (${t.cache_read}/${t.cache_creation}) / ${t.output}` : "?"} | ${s.cost_usd !== null ? s.cost_usd.toFixed(2) : "?"} |`,
    );
  }
  L.push("");
  const ran = summaries.filter((x) => x.s).length;
  L.push(
    unknownCost === 0
      ? `Total Claude Code cost (its own \`total_cost_usd\`, API-price equivalent): $${usd.toFixed(2)}`
      : unknownCost === ran
        ? "Total Claude Code cost (its own `total_cost_usd`, API-price equivalent): UNKNOWN — no case recorded one"
        : `Claude Code cost recorded (its own \`total_cost_usd\`, API-price equivalent): $${usd.toFixed(2)} over ${ran - unknownCost} of ${ran} case(s) — ${unknownCost} recorded none, so the total is at least this`,
  );
  const bad = summaries.filter((x) => x.s && (x.s.error || x.s.warnings.length || !x.s.argv_ok));
  if (bad.length) {
    L.push("");
    L.push("## Warnings (case errors, argv drift)");
    L.push("");
    for (const { c, s } of bad) {
      if (!s) continue;
      if (!s.argv_ok) L.push(`- ${c.instance_id}: argv drift — ${s.argv_mismatches.join("; ")}`);
      if (s.error) L.push(`- ${c.instance_id}: ${s.error.replace(/\s+/g, " ").slice(0, 400)}`);
      for (const w of s.warnings) L.push(`- ${c.instance_id}: ${w}`);
    }
  }
  L.push("");
  L.push(
    "Reading the numbers: Claude Code's findings carry no severity tag, so only the `all` variant exists for this arm — compare it with the QuickReview arm's `all` row. Claude Code 2.1.283's `/code-review` is a built-in local command that ignores the harness's findings prompt and findings tool, so the harness stores its answer as raw text, which the harness's own Claude reader scores as zero. Each result file therefore carries an OCR-shaped `review` view, scored with the harness's OCR reader: built from the harness's structured findings when it got any (identical to what its Claude reader sees), otherwise read out of the stored markdown by a deterministic prose parser (src/bench/claudeprose.ts) — every top-level list item (or paragraph) that opens with a `path:line` location, outside lists the review itself says are not findings. `(prose)` in the Findings column marks those cases. Items that name a file but no line are not counted.",
  );
  return L.join("\n") + "\n";
}

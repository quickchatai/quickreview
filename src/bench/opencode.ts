// The OpenCode arm of the AACR-Bench harness (`bench.sh --arm opencode`).
//
// The AACR harness ships runners for three reviewers — OCR, Claude Code and
// Codex CLI (`evaluation/reviewers/{ocr,claude,codex}.py` at the pinned
// harness commit) — and none for OpenCode. This module is that runner, built
// in the shape of the harness's CODEX runner so the rows compare:
//
//   harness codex.py                          here
//   ----------------------------------------  ---------------------------------------
//   `codex exec review "/review B...H (F)"`   `opencode run --command review "B...H (F)"`
//     (codex's built-in /review)                (OpenCode's built-in /review command,
//                                               "review changes [commit|branch|pr]")
//   F = INLINE_FINDINGS_PROMPT_FRAGMENT       the same fragment, word for word, but the
//                                               tool is named `findings_report` (OpenCode
//                                               prefixes MCP tools with the server name)
//   MCP server mcp_codex_finding_server.py    the SAME script from the pinned harness,
//     report(file, start_line, end_line,        run by the harness's own venv
//     severity, summary, description)
//   --sandbox workspace-write                 --auto (permissions not explicitly denied are
//                                               approved); webfetch and directories outside
//                                               the tree denied (workspace-write has no network)
//   process timeout = timeout×60 + 60 s       the same (timeout 30 → 1,860 s)
//   save_result: MCP partial vs JSON parsed   the same dual channel and the same tie rule
//     from the final text, the larger wins,     (text = the review subtask's result)
//     tie → MCP
//   result file { review_output, … }          the same payload, reviewer "opencode", PLUS
//                                               `review.comments` — the identical comments in
//                                               the OCR reader's shape (note = summary + "\n"
//                                               + description, lines = start/end), because
//                                               the bench scores every arm with the harness's
//                                               OCR reader and the defect judge reads that key
//
// What cannot be the harness's: the model endpoint. Like the OCR arm, OpenCode
// reaches `gpt-6-sol` through the loopback Codex bridge (bench/aacr/
// codex_bridge.py) as a custom OpenAI-compatible provider; the bridge forces
// the model and the effort and reads only the sandbox's refresh-disabled copy
// of the pi login. OpenCode itself never sees a credential: its API key is a
// dummy for the loopback, and its data dir (where it would keep its own
// auth.json) is a fresh per-case tmpfs directory.
//
// No PR title or description reaches OpenCode — the harness's codex runner
// passes none either.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { safeId, type BenchCase, type CaseSet, type PrefetchMeta } from "./aacr.js";
import { AuthExpiring, syncBenchAuth } from "./auth.js";
import { run } from "./exec.js";
import { bridgeDelta, type BridgeStats, type BridgeUsage } from "./ocr.js";
import { roundMetrics } from "./report.js";
import { prepareTree } from "./runner.js";

// ---- the harness's codex runner, mirrored -----------------------------------------

/** reviewers/codex.py `review_instance(timeout_minutes=30)` = pipeline.py
 * `apply_defaults` (timeout None → 30). */
export const OPENCODE_HARNESS_DEFAULTS = { timeoutMin: 30 } as const;

/** reviewers/codex.py `run_codex_review`: `process_timeout = timeout_minutes * 60 + 60`. */
export function opencodeProcessTimeoutMs(timeoutMin: number): number {
  return (timeoutMin * 60 + 60) * 1000;
}

/** The MCP server's name in OpenCode's config; its `report` tool is exposed
 * to the model as `<server>_report`. */
export const FINDINGS_SERVER = "findings";
export const FINDINGS_TOOL = `${FINDINGS_SERVER}_report`;

/** reviewers/codex.py INLINE_FINDINGS_PROMPT_FRAGMENT at the pinned harness
 * commit, verbatim, except the tool's name. */
export const INLINE_FINDINGS_PROMPT_FRAGMENT =
  `You have an MCP tool named \`${FINDINGS_TOOL}\`. The moment you confirm any individual ` +
  "code-review finding, immediately call this tool once for that single finding " +
  "— do not wait until the end or batch them into one final message. The tool is " +
  "already bound to the instance under review, so you do NOT pass any instance id. " +
  "For every call provide ONLY the finding itself:\n" +
  "  - file: path relative to the repository root\n" +
  "  - start_line: the 1-based starting line number\n" +
  "  - end_line: the 1-based ending line number (for single-line issues, set equal to start_line or omit)\n" +
  "  - severity: one of Critical, Major, Minor, Trivial, Info\n" +
  "  - summary: a concise one-line title of the issue\n" +
  "  - description: detailed explanation including failure scenario and suggested fix\n" +
  "Call the tool exactly once per finding, in addition to whatever you normally " +
  "print. Any finding not sent through this tool will be lost.";

/** reviewers/codex.py `build_findings_prompt` is `/review {base}...{head} ({F})`;
 * with `--command review` OpenCode supplies the `/review` and this is its
 * `$ARGUMENTS`. */
export function opencodeReviewArguments(base: string, head: string): string {
  return `${base}...${head} (${INLINE_FINDINGS_PROMPT_FRAGMENT})`;
}

/** The provider id and model OpenCode is told to use: `bridge/<model>`. */
export const BRIDGE_PROVIDER = "bridge";

export interface OpencodeFlags {
  timeoutMin: number;
  /** `--variant` (reasoning effort); the bridge forces its own --effort
   * whatever arrives, and logs what was asked. */
  variant: string;
}

/** `opencode run`, non-interactive: JSON events on stdout, the built-in
 * review command, external plugins off, permissions auto-approved. */
export function opencodeRunArgv(o: {
  dir: string;
  model: string;
  variant: string;
  title: string;
  arguments: string;
}): string[] {
  return [
    "run",
    "--pure",
    "--auto",
    "--format",
    "json",
    "--dir",
    o.dir,
    "--model",
    `${BRIDGE_PROVIDER}/${o.model}`,
    "--variant",
    o.variant,
    "--title",
    o.title,
    "--command",
    "review",
    o.arguments,
  ];
}

/**
 * OpenCode's whole configuration for one case (written to a per-case file and
 * named by OPENCODE_CONFIG; project config is disabled, so the reviewed repo
 * cannot add providers, plugins, MCP servers or permissions).
 *   - one provider, the loopback bridge, through the AI SDK's
 *     openai-compatible provider (bundled in the binary — nothing is
 *     installed at run time); a dummy API key; header/chunk timeouts long
 *     enough for one aggregated high-reasoning call (the bridge answers only
 *     after the backend finished);
 *   - the harness's codex findings MCP server, bound to this instance;
 *   - no auto-update, no sharing, no snapshots (OpenCode's undo tracking —
 *     it hashes the whole tree every step and changes nothing the model sees).
 */
export function opencodeConfig(o: {
  bridgeUrl: string;
  model: string;
  mcpPython: string;
  mcpScript: string;
  resultsDir: string;
  instanceId: string;
}): Record<string, unknown> {
  const model = `${BRIDGE_PROVIDER}/${o.model}`;
  return {
    autoupdate: false,
    share: "disabled",
    snapshot: false,
    model,
    small_model: model,
    enabled_providers: [BRIDGE_PROVIDER],
    provider: {
      [BRIDGE_PROVIDER]: {
        npm: "@ai-sdk/openai-compatible",
        name: "ChatGPT Codex backend via the loopback bridge",
        options: {
          baseURL: `${o.bridgeUrl.replace(/\/+$/, "")}/v1`,
          apiKey: "loopback-bridge",
          headerTimeout: 900_000,
          chunkTimeout: 900_000,
        },
        models: {
          [o.model]: {
            name: o.model,
            tool_call: true,
            reasoning: true,
            limit: { context: 272_000, output: 128_000 },
          },
        },
      },
    },
    permission: { webfetch: "deny", websearch: "deny", external_directory: "deny" },
    mcp: {
      [FINDINGS_SERVER]: {
        type: "local",
        command: [o.mcpPython, o.mcpScript],
        environment: { REVIEW_RESULTS_DIR: o.resultsDir, REVIEW_INSTANCE_ID: o.instanceId },
        enabled: true,
        timeout: 30_000,
      },
    },
  };
}

/** The environment OpenCode runs with: a fresh HOME and XDG tree per case (its
 * auth.json, sessions DB and caches live there and die with the case), the
 * per-case config, every phone-home off, git without any system/global
 * config. No pi agent dir, no token — the credential stays in the bridge. */
export function opencodeEnv(o: {
  path: string;
  home: string;
  tmpDir: string;
  configPath: string;
}): NodeJS.ProcessEnv {
  return {
    PATH: o.path,
    HOME: o.home,
    TMPDIR: o.tmpDir,
    LANG: "C.UTF-8",
    XDG_CONFIG_HOME: join(o.home, ".config"),
    XDG_DATA_HOME: join(o.home, ".local", "share"),
    XDG_CACHE_HOME: join(o.home, ".cache"),
    XDG_STATE_HOME: join(o.home, ".local", "state"),
    OPENCODE_CONFIG: o.configPath,
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_SHARE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
}

// ---- reading what OpenCode did -----------------------------------------------------

export interface OpencodeEvents {
  /** The review subtask's final answer (the `task` tool's result), else the
   * session's last text — what codex.py reads as the `agent_message`. */
  resultText: string;
  /** Tokens OpenCode itself reported per step (the parent session only — a
   * subtask's steps are not in the stream; the bridge counts everything). */
  tokens: { input: number; output: number; reasoning: number; cacheRead: number };
  steps: number;
  /** Tool calls seen in the stream, by tool name. */
  tools: Record<string, number>;
  errors: string[];
  sessionId: string | null;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

const TASK_RESULT_RE = /<task_result>\s*([\s\S]*?)\s*<\/task_result>/;

export function parseOpencodeEvents(stdout: string): OpencodeEvents {
  const out: OpencodeEvents = {
    resultText: "",
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0 },
    steps: 0,
    tools: {},
    errors: [],
    sessionId: null,
  };
  let lastText = "";
  let taskResult = "";
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (out.sessionId === null && typeof e["sessionID"] === "string") out.sessionId = e["sessionID"];
    const part = (e["part"] ?? {}) as Record<string, unknown>;
    switch (e["type"]) {
      case "text":
        if (typeof part["text"] === "string" && part["text"].trim()) lastText = part["text"];
        break;
      case "tool_use": {
        const tool = typeof part["tool"] === "string" ? part["tool"] : "?";
        out.tools[tool] = (out.tools[tool] ?? 0) + 1;
        const state = (part["state"] ?? {}) as Record<string, unknown>;
        if (tool === "task" && typeof state["output"] === "string") {
          const m = TASK_RESULT_RE.exec(state["output"]);
          taskResult = (m ? m[1]! : state["output"]).trim();
        }
        break;
      }
      case "step_finish": {
        out.steps++;
        const t = (part["tokens"] ?? {}) as Record<string, unknown>;
        const cache = (t["cache"] ?? {}) as Record<string, unknown>;
        out.tokens.input += num(t["input"]);
        out.tokens.output += num(t["output"]);
        out.tokens.reasoning += num(t["reasoning"]);
        out.tokens.cacheRead += num(cache["read"]);
        break;
      }
      case "error": {
        const err = (e["error"] ?? {}) as Record<string, unknown>;
        const data = (err["data"] ?? {}) as Record<string, unknown>;
        out.errors.push(
          String(data["message"] ?? err["message"] ?? err["name"] ?? JSON.stringify(err)).slice(0, 600),
        );
        break;
      }
    }
  }
  out.resultText = taskResult || lastText;
  return out;
}

/** reviewers/codex.py `_EMPTY_REVIEW_PATTERNS` / `looks_like_empty_review`. */
const EMPTY_REVIEW_PATTERNS = [
  /\bno\s+findings?\b/m,
  /\bno\s+issues?\s+found\b/m,
  /\bnothing\s+to\s+report\b/m,
  /\bno\s+comments?\b/m,
  /^\s*\(?\s*none\s*\)?\s*$/m,
];

export function looksLikeEmptyReview(text: string): boolean {
  if (!text.trim()) return true;
  const lowered = text.toLowerCase();
  return EMPTY_REVIEW_PATTERNS.some((p) => p.test(lowered));
}

/** reviewers/codex.py `extract_findings_from_result`: a fenced or bare JSON
 * value → that value; an explicit "no findings" → []; else the raw text. */
export function extractFindingsFromText(text: string): unknown {
  const fence = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(text);
  const jsonText = fence ? fence[1]! : text;
  try {
    return JSON.parse(jsonText);
  } catch {
    return looksLikeEmptyReview(text) ? [] : text;
  }
}

export interface ChosenFindings {
  review_output: unknown;
  source: "mcp_stream" | "jsonl_fallback";
  mcp: number;
  text: number | null;
}

/** reviewers/codex.py `save_result`'s dual channel: the MCP partial file vs
 * the findings parsed from the final text; the larger wins, a tie goes to
 * MCP, and with neither structured the raw text is stored (scored as zero
 * comments). */
export function chooseFindings(mcp: unknown[] | null, text: string): ChosenFindings {
  const mcpCount = mcp?.length ?? 0;
  const parsed = extractFindingsFromText(text);
  const structured = Array.isArray(parsed);
  const textCount = structured ? parsed.length : 0;
  if (mcpCount === 0 && !structured)
    return { review_output: parsed, source: "jsonl_fallback", mcp: 0, text: null };
  if (mcpCount >= textCount)
    return { review_output: mcp ?? [], source: "mcp_stream", mcp: mcpCount, text: textCount };
  return { review_output: parsed, source: "jsonl_fallback", mcp: mcpCount, text: textCount };
}

/** reviewers/codex.py `load_streamed_findings`: the partial file, or null
 * when absent, unreadable or empty. */
export function loadPartialFindings(path: string): unknown[] | null {
  if (!existsSync(path)) return null;
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return Array.isArray(v) && v.length ? v : null;
  } catch {
    return null;
  }
}

export interface OcrShapedComment {
  path: string;
  start_line: number | null;
  end_line: number | null;
  content: string;
  severity?: string;
}

function intOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}

/** evaluate.py `build_target_comments_from_codex`, emitted in the shape its
 * `build_target_comments_from_ocr` reads: note = summary + "\n" + description
 * (a finding with neither is skipped), path = file, the line range as given.
 * Scoring this with the OCR reader is scoring review_output with the codex
 * reader — the same notes, paths and lines. */
export function toOcrShapedComments(reviewOutput: unknown): OcrShapedComment[] {
  if (!Array.isArray(reviewOutput)) return [];
  const out: OcrShapedComment[] = [];
  for (const f of reviewOutput) {
    if (typeof f !== "object" || f === null) continue;
    const r = f as Record<string, unknown>;
    const summary = typeof r["summary"] === "string" ? r["summary"].trim() : "";
    const description = typeof r["description"] === "string" ? r["description"].trim() : "";
    const note = [summary, description].filter(Boolean).join("\n").trim();
    if (!note) continue;
    out.push({
      path: typeof r["file"] === "string" ? r["file"] : "",
      start_line: intOrNull(r["start_line"]),
      end_line: intOrNull(r["end_line"]),
      content: note,
      ...(typeof r["severity"] === "string" ? { severity: r["severity"] } : {}),
    });
  }
  return out;
}

/** reviewers/codex.py `save_result`'s payload, reviewer "opencode", plus the
 * OCR-reader copy of the comments under `review` and our `bench` block (the
 * scorer ignores both extras' other keys). The full event stream stays in the
 * case dir instead of the result file. */
export function opencodeResultPayload(a: {
  c: BenchCase;
  model: string;
  startedAt: string;
  durationSeconds: number;
  exitCode: number;
  chosen: ChosenFindings;
  tokenUsage: Record<string, number>;
  stderr: string;
  bench: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    instance_id: a.c.instance_id,
    repo: a.c.repo,
    base_commit: a.c.base_commit,
    head_commit: a.c.head_commit,
    reviewer: "opencode",
    model: a.model,
    started_at: a.startedAt,
    duration_seconds: Math.round(a.durationSeconds * 100) / 100,
    opencode_exit_code: a.exitCode,
    review_output_source: a.chosen.source,
    review_output: a.chosen.review_output,
    token_usage: a.tokenUsage,
    review: { comments: toOcrShapedComments(a.chosen.review_output) },
    stderr: a.stderr,
    bench: a.bench,
  };
}

// ---- one case ----------------------------------------------------------------------

export type OpencodeStatus = "ok" | "failed" | "timeout" | "no-output";

export interface OpencodeFingerprint {
  qcr_commit: string;
  opencode_version: string;
  model: string;
  effort: string;
  variant: string;
  timeout_min: number;
}

export interface OpencodeCaseSummary {
  instance_id: string;
  arm: "opencode";
  status: OpencodeStatus;
  error?: string;
  fingerprint: OpencodeFingerprint;
  exit_code: number | null;
  duration_seconds: number;
  /** Comments the scorer reads from the result file. */
  comments: number;
  review_output_source: ChosenFindings["source"] | null;
  mcp_findings: number;
  text_findings: number | null;
  /** OpenCode's own per-step tokens (parent session only). */
  opencode_tokens: OpencodeEvents["tokens"] | null;
  /** The bridge's count of every call the case made (subtask included). */
  bridge: BridgeUsage | null;
  /** Bridge tokens in the shape the defect judge's cost line reads:
   * input without the cached part, the cached part, output. */
  usage: { input: number; output: number; cacheRead: number } | null;
  tools: Record<string, number>;
  merge_base_ok: boolean;
  warnings: string[];
}

export function writeOpencodeResult(
  outDir: string,
  c: BenchCase,
  payload: Record<string, unknown>,
): void {
  const dir = join(outDir, "results", "all");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${safeId(c.instance_id)}.json`), JSON.stringify(payload, null, 2) + "\n");
}

export function readOpencodeSummary(outDir: string, c: BenchCase): OpencodeCaseSummary | null {
  const p = join(outDir, "cases", safeId(c.instance_id), "case-summary.json");
  if (!existsSync(p)) return null;
  const s = JSON.parse(readFileSync(p, "utf8")) as Partial<OpencodeCaseSummary>;
  return s.arm === "opencode" ? (s as OpencodeCaseSummary) : null;
}

/** Status from one finished process: a timeout or a non-zero exit as named;
 * an `error` event, or a run that reached the model not once, is a failure
 * even when OpenCode exits 0. */
export function opencodeStatus(a: {
  exitCode: number;
  timedOut: boolean;
  events: OpencodeEvents;
  bridgeOk: number | null;
}): OpencodeStatus {
  if (a.timedOut) return "timeout";
  if (a.exitCode !== 0 || a.events.errors.length) return "failed";
  if (a.events.steps === 0 && !a.bridgeOk) return "no-output";
  return "ok";
}

export interface OpencodeRunnerOptions {
  root: string;
  store: string;
  outDir: string;
  opencodeBin: string;
  bridgeUrl: string;
  model: string;
  mcpPython: string;
  mcpScript: string;
  flags: OpencodeFlags;
  fingerprint: OpencodeFingerprint;
  keepTree?: boolean;
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
  /** Injected in tests; defaults to the real subprocess runner. */
  runImpl?: typeof run;
}

async function bridgeCall(
  o: Pick<OpencodeRunnerOptions, "bridgeUrl" | "fetchImpl">,
  path: string,
  body?: unknown,
): Promise<Record<string, unknown> | null> {
  try {
    const res = await (o.fetchImpl ?? fetch)(`${o.bridgeUrl.replace(/\/+$/, "")}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok ? ((await res.json()) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function emptySummary(c: BenchCase, fingerprint: OpencodeFingerprint): OpencodeCaseSummary {
  return {
    instance_id: c.instance_id,
    arm: "opencode",
    status: "failed",
    fingerprint,
    exit_code: null,
    duration_seconds: 0,
    comments: 0,
    review_output_source: null,
    mcp_findings: 0,
    text_findings: null,
    opencode_tokens: null,
    bridge: null,
    usage: null,
    tools: {},
    merge_base_ok: false,
    warnings: [],
  };
}

/** Review one case with OpenCode and write its result file. Never throws for
 * a case that fails — a failure is a recorded outcome with an empty result. */
export async function reviewCaseOpencode(
  c: BenchCase,
  meta: PrefetchMeta,
  o: OpencodeRunnerOptions,
): Promise<OpencodeCaseSummary> {
  const log = o.log ?? (() => {});
  const exec = o.runImpl ?? run;
  const safe = safeId(c.instance_id);
  const caseDir = join(o.outDir, "cases", safe);
  const tree = join(o.root, "wt", safe);
  const scratch = join(o.root, "wt", `${safe}.opencode`);
  const home = join(scratch, "home");
  const tmpDir = join(scratch, "tmp");
  const partialDir = join(scratch, "findings");
  mkdirSync(caseDir, { recursive: true });
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const summary = emptySummary(c, o.fingerprint);
  let stdout = "";
  let stderr = "";
  let exitCode = -1;
  let chosen: ChosenFindings = { review_output: [], source: "mcp_stream", mcp: 0, text: 0 };
  try {
    await prepareTree(join(o.store, safe), tree, meta);
    rmSync(scratch, { recursive: true, force: true });
    for (const d of [home, tmpDir, partialDir]) mkdirSync(d, { recursive: true });
    const configPath = join(scratch, "opencode.json");
    const config = opencodeConfig({
      bridgeUrl: o.bridgeUrl,
      model: o.model,
      mcpPython: o.mcpPython,
      mcpScript: o.mcpScript,
      resultsDir: partialDir,
      instanceId: c.instance_id,
    });
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    writeFileSync(join(caseDir, "opencode-config.json"), JSON.stringify(config, null, 2) + "\n");
    const env = opencodeEnv({
      path: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      home,
      tmpDir,
      configPath,
    });
    const mb = await exec("git", ["-C", tree, "merge-base", c.base_commit, c.head_commit], { env });
    summary.merge_base_ok = mb.code === 0 && mb.stdout.trim() === meta.merge_base;
    if (!summary.merge_base_ok)
      summary.warnings.push(
        `merge-base(${c.base_commit.slice(0, 7)}, head) = ${mb.stdout.trim() || mb.stderr.trim().slice(0, 200)}, prefetched ${meta.merge_base.slice(0, 7)}`,
      );
    const argv = opencodeRunArgv({
      dir: tree,
      model: o.model,
      variant: o.flags.variant,
      title: c.instance_id,
      arguments: opencodeReviewArguments(c.base_commit, c.head_commit),
    });
    writeFileSync(
      join(caseDir, "opencode-argv.json"),
      JSON.stringify([o.opencodeBin, ...argv], null, 2) + "\n",
    );
    await bridgeCall(o, "/label", { label: c.instance_id });
    const before = (await bridgeCall(o, "/stats")) as BridgeStats | null;
    log(`opencode: ${c.instance_id} — ${meta.diff.files} files, /review ${c.base_commit.slice(0, 7)}...${c.head_commit.slice(0, 7)}`);
    const r = await exec(o.opencodeBin, argv, {
      cwd: tree,
      env,
      timeoutMs: opencodeProcessTimeoutMs(o.flags.timeoutMin),
    });
    const after = (await bridgeCall(o, "/stats")) as BridgeStats | null;
    await bridgeCall(o, "/label", { label: "" });
    stdout = r.stdout;
    stderr = r.stderr;
    exitCode = r.code;
    summary.exit_code = r.code;
    summary.bridge = bridgeDelta(before, after);
    const events = parseOpencodeEvents(stdout);
    summary.opencode_tokens = events.tokens;
    summary.tools = events.tools;
    chosen = chooseFindings(
      loadPartialFindings(join(partialDir, `${safe}.partial.json`)),
      events.resultText,
    );
    summary.review_output_source = chosen.source;
    summary.mcp_findings = chosen.mcp;
    summary.text_findings = chosen.text;
    summary.status = opencodeStatus({
      exitCode: r.code,
      timedOut: r.timedOut,
      events,
      bridgeOk: summary.bridge?.ok ?? null,
    });
    summary.warnings.push(...events.errors.map((e) => `opencode error: ${e}`));
    if (summary.status !== "ok")
      summary.error = (events.errors.join(" | ") || stderr.trim() || stdout.trim()).slice(-1500);
    writeFileSync(join(caseDir, "opencode-result.txt"), events.resultText);
    // OpenCode's own log (it writes one per process under its data dir).
    const logDir = join(home, ".local", "share", "opencode", "log");
    if (existsSync(logDir))
      for (const f of readdirSync(logDir).filter((n) => n.endsWith(".log")).slice(-1))
        copyFileSync(join(logDir, f), join(caseDir, "opencode.log"));
  } catch (err) {
    summary.status = "failed";
    summary.error = String(err instanceof Error ? err.message : err).slice(0, 2000);
    log(`opencode: ${c.instance_id} FAILED — ${summary.error}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    if (!o.keepTree) rmSync(tree, { recursive: true, force: true });
  }
  summary.duration_seconds = Math.round((Date.now() - started) / 1000);
  const b = summary.bridge;
  summary.usage = b
    ? {
        input: b.input_tokens - Math.min(b.cached_tokens, b.input_tokens),
        cacheRead: Math.min(b.cached_tokens, b.input_tokens),
        output: b.output_tokens,
      }
    : null;
  writeFileSync(join(caseDir, "opencode-events.jsonl"), stdout);
  writeFileSync(join(caseDir, "opencode-stderr.log"), stderr);
  const payload = opencodeResultPayload({
    c,
    model: o.model,
    startedAt,
    durationSeconds: (Date.now() - started) / 1000,
    exitCode,
    chosen,
    // codex.py `_extract_codex_usage` field names, from the bridge (OpenAI
    // convention: input includes the cached part).
    tokenUsage: {
      input_tokens: b?.input_tokens ?? 0,
      cached_input_tokens: b?.cached_tokens ?? 0,
      output_tokens: b?.output_tokens ?? 0,
      reasoning_output_tokens: b?.reasoning_tokens ?? 0,
      cache_read_input_tokens: b?.cached_tokens ?? 0,
      cache_creation_input_tokens: 0,
      total_tokens: (b?.input_tokens ?? 0) + (b?.output_tokens ?? 0),
    },
    stderr,
    bench: { status: summary.status, bridge: b, fingerprint: o.fingerprint },
  });
  summary.comments = (payload["review"] as { comments: unknown[] }).comments.length;
  writeFileSync(join(caseDir, "case-summary.json"), JSON.stringify(summary, null, 2) + "\n");
  writeOpencodeResult(o.outDir, c, payload);
  log(
    `opencode: ${c.instance_id} ${summary.status} — ${summary.comments} comment(s) (${chosen.source}: mcp ${chosen.mcp}, text ${chosen.text ?? "raw"}), ${summary.duration_seconds}s` +
      (b
        ? `, ${b.requests} model call(s) (${b.errors} failed), ${b.input_tokens} in/${b.output_tokens} out`
        : ""),
  );
  return summary;
}

/** A case with no prefetched store: failed WITH an empty result file, so its
 * references count against recall instead of vanishing from both
 * denominators. */
export function unprefetchedOpencodeCase(
  outDir: string,
  c: BenchCase,
  fingerprint: OpencodeFingerprint,
  error: string,
): OpencodeCaseSummary {
  const summary = { ...emptySummary(c, fingerprint), error };
  const caseDir = join(outDir, "cases", safeId(c.instance_id));
  mkdirSync(caseDir, { recursive: true });
  writeFileSync(join(caseDir, "case-summary.json"), JSON.stringify(summary, null, 2) + "\n");
  writeOpencodeResult(
    outDir,
    c,
    opencodeResultPayload({
      c,
      model: fingerprint.model,
      startedAt: new Date().toISOString(),
      durationSeconds: 0,
      exitCode: -1,
      chosen: { review_output: [], source: "mcp_stream", mcp: 0, text: 0 },
      tokenUsage: {},
      stderr: error,
      bench: { status: "failed", bridge: null, fingerprint },
    }),
  );
  return summary;
}

// ---- the whole run (cli `opencode-review`) -------------------------------------------

export interface OpencodeReviewRun {
  set: CaseSet;
  cases: BenchCase[];
  outDir: string;
  root: string;
  store: string;
  authSrc: string;
  agentDir: string;
  opencodeBin: string;
  opencodeVersion: string;
  bridgeUrl: string;
  /** From the bridge's /health — what the model IS, never a flag. */
  model: string;
  effort: string;
  verbosity: string | null;
  mcpPython: string;
  mcpScript: string;
  flags: OpencodeFlags;
  qcrCommit: string;
  resume: boolean;
  keepTree: boolean;
  readMeta: (c: BenchCase) => PrefetchMeta;
  log: (line: string) => void;
}

/** Every case, ONE AT A TIME (as the harness runs its CLI reviewers, and the
 * login is shared with the companion). Returns the process exit code. */
export async function runOpencodeReview(r: OpencodeReviewRun): Promise<number> {
  const fingerprint: OpencodeFingerprint = {
    qcr_commit: r.qcrCommit,
    opencode_version: r.opencodeVersion,
    model: r.model,
    effort: r.effort,
    variant: r.flags.variant,
    timeout_min: r.flags.timeoutMin,
  };
  mkdirSync(r.outDir, { recursive: true });
  const runFile = join(r.outDir, "run.json");
  const previous = existsSync(runFile)
    ? (JSON.parse(readFileSync(runFile, "utf8")) as Record<string, unknown>)
    : null;
  if (!r.resume) {
    for (const c of r.cases) {
      rmSync(join(r.outDir, "cases", safeId(c.instance_id), "case-summary.json"), { force: true });
      rmSync(join(r.outDir, "results", "all", `${safeId(c.instance_id)}.json`), { force: true });
    }
  }
  const runRecord = {
    reviewer: "opencode",
    set: r.set.name,
    dataset: r.set.dataset,
    opencode_version: r.opencodeVersion,
    model: r.model,
    effort: r.effort,
    verbosity: r.verbosity,
    variant: r.flags.variant,
    endpoint: "ChatGPT Codex backend via the loopback bridge (bench/aacr/codex_bridge.py)",
    command: "opencode run --pure --auto --format json --command review '<base>...<head> (<findings fragment>)'",
    flags: { timeout_min: r.flags.timeoutMin },
    qcr_commit: r.qcrCommit,
    cases: r.cases.map((c) => c.instance_id),
    started_at:
      (r.resume && typeof previous?.["started_at"] === "string" && previous["started_at"]) ||
      new Date().toISOString(),
    resumes: [
      ...(r.resume && Array.isArray(previous?.["resumes"]) ? (previous["resumes"] as unknown[]) : []),
      ...(r.resume && previous ? [{ at: new Date().toISOString(), fingerprint }] : []),
    ],
    finished_at: null as string | null,
  };
  writeFileSync(runFile, JSON.stringify(runRecord, null, 2) + "\n");
  const summaries: OpencodeCaseSummary[] = [];
  let stopped: string | null = null;
  for (const c of r.cases) {
    const prior = readOpencodeSummary(r.outDir, c);
    if (r.resume && prior && prior.status === "ok") {
      if (JSON.stringify(prior.fingerprint) === JSON.stringify(fingerprint)) {
        r.log(`opencode: ${c.instance_id} already done — skipped (--resume)`);
        summaries.push(prior);
        continue;
      }
      r.log(`opencode: ${c.instance_id} was reviewed by a different OpenCode/model/flags — re-running`);
    }
    try {
      // The bridge reads this refresh-disabled copy on every call.
      syncBenchAuth({
        srcDir: r.authSrc,
        dstDir: r.agentDir,
        root: r.root,
        needMs: opencodeProcessTimeoutMs(r.flags.timeoutMin) + 5 * 60_000,
      });
    } catch (err) {
      if (!(err instanceof AuthExpiring)) throw err;
      stopped = err.message;
      r.log(`opencode: STOPPED — ${err.message}`);
      break;
    }
    let meta: PrefetchMeta;
    try {
      meta = r.readMeta(c);
    } catch (err) {
      const error = String(err instanceof Error ? err.message : err);
      r.log(error);
      summaries.push(unprefetchedOpencodeCase(r.outDir, c, fingerprint, error));
      continue;
    }
    summaries.push(
      await reviewCaseOpencode(c, meta, {
        root: r.root,
        store: r.store,
        outDir: r.outDir,
        opencodeBin: r.opencodeBin,
        bridgeUrl: r.bridgeUrl,
        model: r.model,
        mcpPython: r.mcpPython,
        mcpScript: r.mcpScript,
        flags: r.flags,
        fingerprint,
        keepTree: r.keepTree,
        log: r.log,
      }),
    );
  }
  runRecord.finished_at = new Date().toISOString();
  writeFileSync(runFile, JSON.stringify(runRecord, null, 2) + "\n");
  const ok = summaries.filter((s) => s.status === "ok").length;
  r.log(`opencode: ${ok}/${r.cases.length} reviewed — results in ${join(r.outDir, "results", "all")}`);
  if (stopped !== null) r.log(`opencode: run stopped early — ${stopped}`);
  return ok === r.cases.length ? 0 : 1;
}

// ---- the report ---------------------------------------------------------------------

function n(v: number | undefined): string {
  return v === undefined ? "?" : Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
}

/** The OpenCode arm's report: the harness's numbers (average and every
 * round), then per case what OpenCode did and what it cost at the bridge. */
export function renderOpencodeReport(set: CaseSet, outDir: string, cases: BenchCase[]): string {
  const L: string[] = [];
  const runPath = join(outDir, "run.json");
  const run = (existsSync(runPath) ? JSON.parse(readFileSync(runPath, "utf8")) : {}) as Record<
    string,
    unknown
  >;
  const judgeFile = join(outDir, "judge.txt");
  const judge = existsSync(judgeFile) ? readFileSync(judgeFile, "utf8").trim().split("\n") : ["not run"];
  const k = (x: number): string => `${Math.round(x / 1000)}k`;
  L.push(`# AACR-Bench run — ${set.name} — OpenCode`);
  L.push("");
  L.push(
    `- Dataset: AACR-Bench v1.0 (\`${set.dataset.commit.slice(0, 7)}\`), ${cases.length} PRs, ${cases.reduce((a, c) => a + c.references, 0)} reference comments`,
  );
  L.push(
    `- Reviewer: OpenCode ${String(run["opencode_version"] ?? "?")}, run in the shape of the AACR harness's reviewers/codex.py: \`opencode run --command review "<base>...<head> (<findings fragment>)"\` (OpenCode's built-in /review), findings through the harness's codex MCP findings server, timeout ${String((run["flags"] as Record<string, unknown> | undefined)?.["timeout_min"] ?? "?")} min (+60 s); no PR title/description`,
  );
  L.push(
    `- Model: \`${String(run["model"] ?? "?")}\`, reasoning effort \`${String(run["effort"] ?? "?")}\` (asked: --variant \`${String(run["variant"] ?? "?")}\`) — the ChatGPT Codex backend through the loopback bridge (bench/aacr/codex_bridge.py, streaming Chat Completions)`,
  );
  L.push(`- Judge: ${judge[0] ?? ""}`);
  for (const w of judge.slice(1)) L.push(`  ${w}`);
  L.push("");
  L.push("## Scores (the AACR harness, OCR reader over the same comments)");
  L.push("");
  L.push("| Round | Evaluated | Generated | Matched | Precision | Recall | F1 | Line P | Line R |");
  L.push("|---|---|---|---|---|---|---|---|---|");
  const row = (label: string, s: Record<string, number>): string =>
    `| ${label} | ${n(s["evaluated_instances"])}/${cases.length} | ${n(s["generated_notes"])} | ${n(s["matched_semantic_notes"])}/${n(s["expected_notes"])} | ${s["semantic_match_rate"]} | ${s["semantic_recall_rate"]} | ${s["semantic_f1"]} | ${s["line_match_rate"]} | ${s["line_recall_rate"]} |`;
  const { rounds, average } = roundMetrics(join(outDir, "results", "all"));
  if (average) L.push(row("**average**", average));
  for (const r of rounds) L.push(row(String(r.round), r.summary));
  if (!average && rounds.length === 0) L.push("| — | — | — | — | — | — | — | — | — |");
  L.push("");
  L.push("## Per case");
  L.push("");
  L.push(
    "| Case | Lang | Refs | Status | Comments (source) | Minutes | Model calls (failed) | Backend tokens in (cached) / out (reasoning) | Tools |",
  );
  L.push("|---|---|---|---|---|---|---|---|---|");
  const warned: Array<{ c: BenchCase; s: OpencodeCaseSummary }> = [];
  for (const c of cases) {
    const s = readOpencodeSummary(outDir, c);
    if (!s) {
      L.push(`| ${c.instance_id} | ${c.language} | ${c.references} | not run | | | | | |`);
      continue;
    }
    if (s.warnings.length || s.error || !s.merge_base_ok) warned.push({ c, s });
    const b = s.bridge;
    const tools = Object.entries(s.tools)
      .sort((x, y) => y[1] - x[1])
      .map(([t, m]) => `${t} ${m}`)
      .join(", ");
    L.push(
      `| ${c.instance_id} | ${c.language} | ${c.references} | ${s.status} | ${s.comments} (${s.review_output_source ?? "?"}) | ${(s.duration_seconds / 60).toFixed(1)} | ${b ? `${b.requests} (${b.errors})` : "?"} | ${b ? `${k(b.input_tokens)} (${k(b.cached_tokens)}) / ${k(b.output_tokens)} (${k(b.reasoning_tokens)})` : "?"} | ${tools} |`,
    );
  }
  if (warned.length) {
    L.push("");
    L.push("## Warnings (case errors)");
    L.push("");
    for (const { c, s } of warned) {
      if (!s.merge_base_ok && s.status !== "failed")
        L.push(`- \`${c.instance_id}\`: merge-base check failed — see case-summary.json`);
      for (const w of [...(s.error ? [s.error.replaceAll("\n", " ").slice(0, 400)] : []), ...s.warnings])
        L.push(`- \`${c.instance_id}\`: ${w}`);
    }
  }
  L.push("");
  L.push(
    "Reading the numbers: the findings carry the harness's codex severities (Critical…Info), not our blocker/nit tags, so only the `all` variant exists for this arm. The Tools column counts the parent session's tool calls (the review itself runs as a subtask, visible as `task`); the backend columns are the bridge's count of every call, subtask included.",
  );
  L.push("");
  return L.join("\n");
}

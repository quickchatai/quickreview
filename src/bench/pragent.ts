// The PR-Agent arm of the AACR-Bench harness (`bench.sh --arm pragent`).
//
// PR-Agent (qodo-ai/pr-agent, MIT; pip `pr-agent`, pinned in the Dockerfile's
// `pragent` stage) is the open-source PR reviewer Qodo ships as a GitHub App.
// The AACR harness has no runner for it, so this module is one, built in the
// shape of the other third-party arms (opencode.ts, pireview.ts): one case at
// a time, the case's tree prepared exactly as for every arm, the model through
// the loopback Codex bridge, a result file the harness's OCR reader and the
// defect judge read unchanged.
//
// WHAT RUNS. On a GitHub PR the app runs `pr_commands` = /describe, /review,
// /improve (its documented default). /describe writes the PR's title/summary
// and walkthrough — no findings, nothing a reviewer is scored on — so it does
// not run here. "Its review" is the other two: /review (the "PR Reviewer Guide":
// up to `num_max_findings` = 3 key issues, each with a file and a line range,
// plus a security-concerns verdict) and /improve (code suggestions, each with a
// file and a line range, scored by its self-reflection pass). Both run through
// PR-Agent's own CLI (`python -m pr_agent.cli --pr_url <target> review|improve`)
// on its documented LOCAL git provider — HEAD is the change, the diff is HEAD
// against merge-base(HEAD, <target>), i.e. `git diff base...head`, with full
// base/head file contents for its context extension — driven by
// bench/aacr/pragent_driver.py, which swaps in `bench-local` (the local
// provider plus what the GitHub provider would give it: the PR's title and
// description, AGENTS.md repo context, and the findings as JSON rather than
// only Markdown). No GitHub access exists or is needed.
//
// THE MODEL. `gpt-6.1-sol` (the operator's choice, 2026-09-30) through the ChatGPT login,
// via bench/aacr/codex_bridge.py (non-streaming Chat Completions → the Codex
// Responses backend), which forces the model and the effort and holds the only
// credential (the refresh-disabled copy src/bench/auth.ts writes). PR-Agent is
// configured the way it documents an OpenAI-compatible endpoint (LiteLLM
// `openai/gpt-6.1-sol`, `openai.api_base` = the bridge, a dummy key) and keeps
// its defaults, `reasoning_effort = "medium"` included — which is the effort
// the bridge forces.
//
// OUTPUT → FINDINGS. Every /review key issue and every /improve suggestion with
// a file and a valid line range becomes one comment (path, start/end line,
// text); anything unlocated — a key issue without lines, a suggestion whose
// range PR-Agent could not resolve, a security concern — lives in the review
// body (`cases/<id>/review.md`, PR-Agent's own /review comment plus the
// unlocated suggestions), which the defect judge reads as the body, like the
// other arms'. PR-Agent carries no blocker/nit tags, so only the `all` variant
// exists for this arm.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { safeId, type BenchCase, type CaseSet, type PrefetchMeta } from "./aacr.js";
import { AuthExpiring, syncBenchAuth } from "./auth.js";
import { run } from "./exec.js";
import { bridgeDelta, type BridgeStats, type BridgeUsage } from "./ocr.js";
import type { OcrShapedComment } from "./opencode.js";
import { roundMetrics } from "./report.js";
import { prepareTree } from "./runner.js";

/** The harness's CLI-runner budget (reviewers/codex.py: 30 min + 60 s), per
 * PR-Agent command. */
export const PRAGENT_DEFAULTS = { timeoutMin: 30, model: "gpt-6.1-sol" } as const;

/** PR-Agent's commands that make up its review, in the order the GitHub App
 * runs them (`pr_commands`, minus /describe — it produces no findings). */
export const PRAGENT_COMMANDS = ["review", "improve"] as const;
export type PragentCommand = (typeof PRAGENT_COMMANDS)[number];

export function pragentProcessTimeoutMs(timeoutMin: number): number {
  return (timeoutMin * 60 + 60) * 1000;
}

/** Where the target branch of the local provider points: the PR's base commit,
 * under the PR's base branch name when git accepts it. */
export const FALLBACK_TARGET_BRANCH = "pragent-base";

export function pragentDriverArgv(o: {
  driver: string;
  tree: string;
  targetBranch: string;
  out: string;
  command: PragentCommand;
  model: string;
  bridgeUrl: string;
  titleFile: string | null;
  bodyFile: string | null;
}): string[] {
  return [
    o.driver,
    "--tree",
    o.tree,
    "--target-branch",
    o.targetBranch,
    "--out",
    o.out,
    "--command",
    o.command,
    "--model",
    o.model,
    "--api-base",
    `${o.bridgeUrl.replace(/\/+$/, "")}/v1`,
    ...(o.titleFile === null && o.bodyFile === null
      ? ["--no-pr-text"]
      : [
          ...(o.titleFile !== null ? ["--title-file", o.titleFile] : []),
          ...(o.bodyFile !== null ? ["--body-file", o.bodyFile] : []),
        ]),
  ];
}

/** The environment PR-Agent runs with: a fresh HOME per case, LiteLLM's model
 * price map from its bundled copy (it would otherwise fetch it from GitHub at
 * import), every outbound HTTP(S) request not to the loopback sent to a dead
 * proxy (PR-Agent, LiteLLM and httpx honour the proxy variables — the bridge on
 * 127.0.0.1 is the one endpoint it can reach), git without system/global
 * config. No token: the credential stays in the bridge. */
export function pragentEnv(o: { path: string; home: string; tmpDir: string }): NodeJS.ProcessEnv {
  const dead = "http://127.0.0.1:9";
  return {
    PATH: o.path,
    HOME: o.home,
    TMPDIR: o.tmpDir,
    LANG: "C.UTF-8",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONUNBUFFERED: "1",
    LOG_LEVEL: "INFO",
    LITELLM_LOCAL_MODEL_COST_MAP: "True",
    LITELLM_TELEMETRY: "False",
    HTTP_PROXY: dead,
    HTTPS_PROXY: dead,
    ALL_PROXY: dead,
    http_proxy: dead,
    https_proxy: dead,
    all_proxy: dead,
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
}

// ---- what PR-Agent wrote --------------------------------------------------------

/** One command's capture (pragent_driver.py `<command>.json`). */
export interface PragentCapture {
  command?: string;
  exit?: unknown;
  error?: string;
  seconds?: number;
  pr_title?: string;
  pr_text?: string;
  reasoning_effort?: unknown;
  max_model_tokens?: unknown;
  repo_pyproject_section?: string | null;
  diff_files?: string[];
  structured_review?: { review?: Record<string, unknown>; usage?: Record<string, unknown> };
  suggestions?: Array<Record<string, unknown>>;
  comments?: string[];
}

export function readCapture(path: string): PragentCapture | null {
  if (!existsSync(path)) return null;
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return typeof v === "object" && v !== null ? (v as PragentCapture) : null;
  } catch {
    return null;
  }
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
}

function lineOf(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string" && /^\s*\d+\s*$/.test(v)) return Number(v.trim());
  return null;
}

/** A path as the scorer reads it: repo-relative, no `./`, no git `a/`/`b/`. */
export function normalizePath(p: string, diffFiles: string[] = []): string {
  let s = p.trim().replace(/^\.\//, "");
  if (/^[ab]\//.test(s) && !diffFiles.includes(s) && diffFiles.includes(s.slice(2))) s = s.slice(2);
  return s;
}

/** A located range: both ends positive and in order (a single line ends where
 * it starts). Anything else is unlocated. */
function range(start: unknown, end: unknown): { start: number; end: number } | null {
  const a = lineOf(start);
  const b = lineOf(end) ?? a;
  if (a === null || b === null || a < 1 || b < a) return null;
  return { start: a, end: b };
}

export interface PragentFinding {
  source: "review" | "improve";
  path: string;
  start_line: number | null;
  end_line: number | null;
  content: string;
  label?: string;
  score?: number;
}

/** /review's key issues: `issue_header` + `issue_content` at relevant_file:start-end. */
export function reviewFindings(cap: PragentCapture | null): PragentFinding[] {
  const issues = cap?.structured_review?.review?.["key_issues_to_review"];
  if (!Array.isArray(issues)) return [];
  const out: PragentFinding[] = [];
  for (const raw of issues) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const header = str(r["issue_header"]);
    const content = str(r["issue_content"]);
    const text = [header, content].filter(Boolean).join("\n");
    if (!text) continue;
    const at = range(r["start_line"], r["end_line"]);
    const path = normalizePath(str(r["relevant_file"]), cap?.diff_files);
    out.push({
      source: "review",
      path,
      start_line: path && at ? at.start : null,
      end_line: path && at ? at.end : null,
      content: text,
      ...(header ? { label: header } : {}),
    });
  }
  return out;
}

/** /improve's suggestions as PR-Agent published them (the rendered list the
 * local provider writes to improve.md): its one-line summary, the suggestion,
 * and the replacement code it proposes, at relevant_file:start-end. */
export function improveFindings(cap: PragentCapture | null): PragentFinding[] {
  const out: PragentFinding[] = [];
  for (const s of cap?.suggestions ?? []) {
    const o = (s["original_suggestion"] ?? {}) as Record<string, unknown>;
    const summary = str(o["one_sentence_summary"]);
    const content = str(o["suggestion_content"]);
    const improved = typeof o["improved_code"] === "string" ? o["improved_code"].replace(/\s+$/, "") : "";
    const label = str(o["label"]);
    const score = typeof o["score"] === "number" ? o["score"] : lineOf(o["score"]);
    const text =
      [summary, content].filter(Boolean).join("\n") +
      (improved ? `\n\nSuggested code:\n\`\`\`\n${improved}\n\`\`\`` : "");
    if (!text.trim()) continue;
    const path = normalizePath(str(s["relevant_file"] ?? o["relevant_file"]), cap?.diff_files);
    const at = range(s["relevant_lines_start"], s["relevant_lines_end"]);
    out.push({
      source: "improve",
      path,
      start_line: path && at ? at.start : null,
      end_line: path && at ? at.end : null,
      content: text.trim(),
      ...(label ? { label } : {}),
      ...(score !== null ? { score } : {}),
    });
  }
  return out;
}

/** The scored comments (located findings, in the OCR reader's shape) and the
 * findings that go to the review body. */
export function splitFindings(findings: PragentFinding[]): {
  comments: OcrShapedComment[];
  unlocated: PragentFinding[];
} {
  const comments: OcrShapedComment[] = [];
  const unlocated: PragentFinding[] = [];
  for (const f of findings) {
    if (f.path && f.start_line !== null) {
      comments.push({
        path: f.path,
        start_line: f.start_line,
        end_line: f.end_line,
        content: f.content,
        ...(f.label ? { severity: f.label } : {}),
      });
    } else unlocated.push(f);
  }
  return { comments, unlocated };
}

/** The review body the defect judge reads: PR-Agent's own /review comment (the
 * "PR Reviewer Guide" it would post — security concerns included), then any
 * unlocated finding under its own heading. */
export function reviewBody(review: PragentCapture | null, unlocated: PragentFinding[]): string {
  const parts: string[] = [];
  const posted = (review?.comments ?? []).filter((c) => c.trim());
  if (posted.length) parts.push(posted.at(-1)!.trim());
  if (unlocated.length) {
    parts.push(
      "## Findings without a line range\n\n" +
        unlocated
          .map((f) => `- **${f.source}**${f.path ? ` \`${f.path}\`` : ""}: ${f.content.replace(/\n/g, "\n  ")}`)
          .join("\n"),
    );
  }
  return parts.join("\n\n");
}

export type CommandStatus = "ok" | "failed" | "timeout" | "not-run";

/** One command's outcome. PR-Agent exits 0 even when the model call failed (it
 * publishes "Failed to review PR" instead), so success is what it PRODUCED:
 * /review a structured review; /improve its suggestions or its explicit
 * "no suggestions" answer. */
export function commandStatus(
  command: PragentCommand,
  r: { code: number; timedOut: boolean } | null,
  cap: PragentCapture | null,
): CommandStatus {
  if (!r) return "not-run";
  if (r.timedOut) return "timeout";
  if (r.code !== 0 || !cap || cap.error) return "failed";
  if (command === "review") return cap.structured_review?.review ? "ok" : "failed";
  if ((cap.suggestions ?? []).length) return "ok";
  return (cap.comments ?? []).some((c) => /no (code )?suggestions/i.test(c)) ? "ok" : "failed";
}

// ---- one case ------------------------------------------------------------------------

export type PragentStatus = "ok" | "failed" | "timeout";

export interface PragentFingerprint {
  qcr_commit: string;
  pragent_version: string;
  model: string;
  effort: string;
  pr_text: boolean;
  timeout_min: number;
}

export interface PragentCaseSummary {
  instance_id: string;
  arm: "pragent";
  status: PragentStatus;
  error?: string;
  fingerprint: PragentFingerprint;
  /** The model the bridge served — what compare.py / cost.ts price the tokens as. */
  model: string;
  commands: Record<PragentCommand, { status: CommandStatus; exit: number | null; seconds: number }>;
  duration_seconds: number;
  /** Comments the scorer reads from the result file. */
  comments: number;
  review_findings: number;
  improve_findings: number;
  unlocated: number;
  target_branch: string | null;
  pr_text: string | null;
  bridge: BridgeUsage | null;
  /** Bridge tokens in the shape the defect judge's cost line reads. */
  usage: { input: number; output: number; cacheRead: number } | null;
  merge_base_ok: boolean;
  warnings: string[];
}

export interface PragentRunnerOptions {
  root: string;
  store: string;
  outDir: string;
  python: string;
  driver: string;
  bridgeUrl: string;
  model: string;
  timeoutMin: number;
  prText: boolean;
  fingerprint: PragentFingerprint;
  keepTree?: boolean;
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
  runImpl?: typeof run;
}

async function bridgeCall(
  o: Pick<PragentRunnerOptions, "bridgeUrl" | "fetchImpl">,
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

function emptySummary(c: BenchCase, fingerprint: PragentFingerprint): PragentCaseSummary {
  const none = { status: "not-run" as CommandStatus, exit: null, seconds: 0 };
  return {
    instance_id: c.instance_id,
    arm: "pragent",
    status: "failed",
    fingerprint,
    model: fingerprint.model,
    commands: { review: { ...none }, improve: { ...none } },
    duration_seconds: 0,
    comments: 0,
    review_findings: 0,
    improve_findings: 0,
    unlocated: 0,
    target_branch: null,
    pr_text: null,
    bridge: null,
    usage: null,
    merge_base_ok: false,
    warnings: [],
  };
}

/** The result file: the harness CLI-runner shape, reviewer "pragent", with
 * PR-Agent's structured output as `review_output`, plus `review.comments` in
 * the OCR reader's shape (what `eval` and the defect judge read). */
export function pragentResultPayload(a: {
  c: BenchCase;
  model: string;
  startedAt: string;
  durationSeconds: number;
  review: PragentCapture | null;
  improve: PragentCapture | null;
  comments: OcrShapedComment[];
  bridge: BridgeUsage | null;
  bench: Record<string, unknown>;
}): Record<string, unknown> {
  const b = a.bridge;
  return {
    instance_id: a.c.instance_id,
    repo: a.c.repo,
    base_commit: a.c.base_commit,
    head_commit: a.c.head_commit,
    reviewer: "pragent",
    model: a.model,
    started_at: a.startedAt,
    duration_seconds: Math.round(a.durationSeconds * 100) / 100,
    review_output: {
      review: a.review?.structured_review?.review ?? null,
      code_suggestions: a.improve?.suggestions ?? null,
    },
    token_usage: {
      input_tokens: b?.input_tokens ?? 0,
      cached_input_tokens: b?.cached_tokens ?? 0,
      output_tokens: b?.output_tokens ?? 0,
      reasoning_output_tokens: b?.reasoning_tokens ?? 0,
      total_tokens: (b?.input_tokens ?? 0) + (b?.output_tokens ?? 0),
    },
    review: { comments: a.comments },
    bench: a.bench,
  };
}

function writeResult(outDir: string, c: BenchCase, payload: Record<string, unknown>): void {
  const dir = join(outDir, "results", "all");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${safeId(c.instance_id)}.json`), JSON.stringify(payload, null, 2) + "\n");
}

export function readPragentSummary(outDir: string, c: BenchCase): PragentCaseSummary | null {
  const p = join(outDir, "cases", safeId(c.instance_id), "case-summary.json");
  if (!existsSync(p)) return null;
  const s = JSON.parse(readFileSync(p, "utf8")) as Partial<PragentCaseSummary>;
  return s.arm === "pragent" ? (s as PragentCaseSummary) : null;
}

/** Review one case with PR-Agent (/review then /improve) and write its result
 * file. Never throws for a case that fails — a failure is a recorded outcome
 * with whatever PR-Agent did produce. */
export async function reviewCasePragent(
  c: BenchCase,
  meta: PrefetchMeta,
  o: PragentRunnerOptions,
): Promise<PragentCaseSummary> {
  const log = o.log ?? (() => {});
  const exec = o.runImpl ?? run;
  const safe = safeId(c.instance_id);
  const caseDir = join(o.outDir, "cases", safe);
  const tree = join(o.root, "wt", safe);
  const scratch = join(o.root, "wt", `${safe}.pragent`);
  const home = join(scratch, "home");
  const tmpDir = join(scratch, "tmp");
  const out = join(scratch, "out");
  mkdirSync(caseDir, { recursive: true });
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const summary = emptySummary(c, o.fingerprint);
  const caps: Record<PragentCommand, PragentCapture | null> = { review: null, improve: null };
  try {
    await prepareTree(join(o.store, safe), tree, meta);
    rmSync(scratch, { recursive: true, force: true });
    for (const d of [home, tmpDir, out]) mkdirSync(d, { recursive: true });
    const env = pragentEnv({
      path: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      home,
      tmpDir,
    });
    const git = (...args: string[]) => exec("git", ["-C", tree, ...args], { env });
    const mb = await git("merge-base", c.base_commit, c.head_commit);
    summary.merge_base_ok = mb.code === 0 && mb.stdout.trim() === meta.merge_base;
    if (!summary.merge_base_ok)
      summary.warnings.push(
        `merge-base(${c.base_commit.slice(0, 7)}, head) = ${mb.stdout.trim() || mb.stderr.trim().slice(0, 200)}, prefetched ${meta.merge_base.slice(0, 7)}`,
      );
    // The local provider's target: a LOCAL branch at the PR's base commit,
    // named like the PR's base branch when git takes the name.
    let target = meta.base_ref;
    if ((await git("branch", "--no-track", target, c.base_commit)).code !== 0) {
      target = FALLBACK_TARGET_BRANCH;
      const b = await git("branch", "--no-track", target, c.base_commit);
      if (b.code !== 0) throw new Error(`git branch ${target}: ${b.stderr.trim().slice(0, 300)}`);
    }
    summary.target_branch = target;
    let titleFile: string | null = null;
    let bodyFile: string | null = null;
    if (o.prText) {
      if (meta.title !== null) writeFileSync((titleFile = join(scratch, "title.txt")), meta.title);
      if (meta.body !== null) writeFileSync((bodyFile = join(scratch, "body.txt")), meta.body);
      if (meta.title === null && meta.body === null)
        summary.warnings.push("the PR's title and body were not prefetched — PR-Agent got the local provider's");
    }
    await bridgeCall(o, "/label", { label: c.instance_id });
    const before = (await bridgeCall(o, "/stats")) as BridgeStats | null;
    log(`pragent: ${c.instance_id} — ${meta.diff.files} files, ${c.base_commit.slice(0, 7)}...${c.head_commit.slice(0, 7)} (target ${target})`);
    const argvs: Record<string, string[]> = {};
    for (const command of PRAGENT_COMMANDS) {
      const argv = pragentDriverArgv({
        driver: o.driver,
        tree,
        targetBranch: target,
        out,
        command,
        model: o.model,
        bridgeUrl: o.bridgeUrl,
        titleFile,
        bodyFile,
      });
      argvs[command] = [o.python, ...argv];
      const t0 = Date.now();
      const r = await exec(o.python, argv, {
        cwd: tree,
        env,
        timeoutMs: pragentProcessTimeoutMs(o.timeoutMin),
      });
      writeFileSync(join(caseDir, `pragent-${command}.log`), `${r.stdout}\n--- stderr ---\n${r.stderr}`);
      caps[command] = readCapture(join(out, `${command}.json`));
      const st = commandStatus(command, r, caps[command]);
      summary.commands[command] = {
        status: st,
        exit: r.code,
        seconds: Math.round((Date.now() - t0) / 1000),
      };
      if (caps[command]?.error) summary.warnings.push(`${command}: ${caps[command]!.error}`);
      if (st !== "ok")
        summary.warnings.push(
          `${command}: ${st}${caps[command]?.comments?.length ? ` — PR-Agent said: ${caps[command]!.comments!.at(-1)!.slice(0, 300)}` : ""}`,
        );
    }
    writeFileSync(join(caseDir, "pragent-argv.json"), JSON.stringify(argvs, null, 2) + "\n");
    const after = (await bridgeCall(o, "/stats")) as BridgeStats | null;
    await bridgeCall(o, "/label", { label: "" });
    summary.bridge = bridgeDelta(before, after);
    summary.pr_text = caps.review?.pr_text ?? null;
    if (caps.review?.repo_pyproject_section)
      summary.warnings.push(
        `the repo's pyproject.toml has a [${caps.review.repo_pyproject_section}] section (PR-Agent loads it; the bench's settings override it)`,
      );
    const statuses = PRAGENT_COMMANDS.map((k) => summary.commands[k].status);
    summary.status = statuses.every((s) => s === "ok")
      ? "ok"
      : statuses.includes("timeout")
        ? "timeout"
        : "failed";
    if (summary.status !== "ok") summary.error = summary.warnings.join(" | ").slice(0, 1500);
    for (const [name, file] of [
      ["pragent-review.json", "review.json"],
      ["pragent-improve.json", "improve.json"],
      ["pragent-review.md", "review.md"],
      ["pragent-improve.md", "improve.md"],
    ] as const)
      if (existsSync(join(out, file))) writeFileSync(join(caseDir, name), readFileSync(join(out, file)));
  } catch (err) {
    summary.status = "failed";
    summary.error = String(err instanceof Error ? err.message : err).slice(0, 2000);
    log(`pragent: ${c.instance_id} FAILED — ${summary.error}`);
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
  const review = reviewFindings(caps.review);
  const improve = improveFindings(caps.improve);
  const { comments, unlocated } = splitFindings([...review, ...improve]);
  summary.review_findings = review.length;
  summary.improve_findings = improve.length;
  summary.unlocated = unlocated.length;
  summary.comments = comments.length;
  const body = reviewBody(caps.review, unlocated);
  if (body) writeFileSync(join(caseDir, "review.md"), body + "\n");
  writeFileSync(join(caseDir, "case-summary.json"), JSON.stringify(summary, null, 2) + "\n");
  writeResult(
    o.outDir,
    c,
    pragentResultPayload({
      c,
      model: o.model,
      startedAt,
      durationSeconds: (Date.now() - started) / 1000,
      review: caps.review,
      improve: caps.improve,
      comments,
      bridge: b,
      bench: { status: summary.status, bridge: b, fingerprint: o.fingerprint, unlocated },
    }),
  );
  log(
    `pragent: ${c.instance_id} ${summary.status} — ${summary.comments} comment(s) (review ${review.length}, improve ${improve.length}, unlocated ${unlocated.length}), ${summary.duration_seconds}s` +
      (b ? `, ${b.requests} model call(s) (${b.errors} failed), ${b.input_tokens} in/${b.output_tokens} out` : ""),
  );
  return summary;
}

/** A case with no prefetched store: failed WITH an empty result file, so its
 * references count against recall instead of vanishing from both denominators. */
export function unprefetchedPragentCase(
  outDir: string,
  c: BenchCase,
  fingerprint: PragentFingerprint,
  error: string,
): PragentCaseSummary {
  const summary = { ...emptySummary(c, fingerprint), error };
  const caseDir = join(outDir, "cases", safeId(c.instance_id));
  mkdirSync(caseDir, { recursive: true });
  writeFileSync(join(caseDir, "case-summary.json"), JSON.stringify(summary, null, 2) + "\n");
  writeResult(
    outDir,
    c,
    pragentResultPayload({
      c,
      model: fingerprint.model,
      startedAt: new Date().toISOString(),
      durationSeconds: 0,
      review: null,
      improve: null,
      comments: [],
      bridge: null,
      bench: { status: "failed", bridge: null, fingerprint, error },
    }),
  );
  return summary;
}

// ---- the whole run (cli `pragent-review`) --------------------------------------------

export interface PragentReviewRun {
  set: CaseSet;
  cases: BenchCase[];
  outDir: string;
  root: string;
  store: string;
  authSrc: string;
  agentDir: string;
  python: string;
  driver: string;
  pragentVersion: string;
  bridgeUrl: string;
  /** From the bridge's /health — what the model IS, never a flag. */
  model: string;
  effort: string;
  verbosity: string | null;
  timeoutMin: number;
  prText: boolean;
  qcrCommit: string;
  resume: boolean;
  keepTree: boolean;
  readMeta: (c: BenchCase) => PrefetchMeta;
  log: (line: string) => void;
  fetchImpl?: typeof fetch;
  runImpl?: typeof run;
}

/** Every case, ONE AT A TIME (as the harness runs its CLI reviewers; the login
 * is shared). Returns the process exit code. */
export async function runPragentReview(r: PragentReviewRun): Promise<number> {
  const fingerprint: PragentFingerprint = {
    qcr_commit: r.qcrCommit,
    pragent_version: r.pragentVersion,
    model: r.model,
    effort: r.effort,
    pr_text: r.prText,
    timeout_min: r.timeoutMin,
  };
  mkdirSync(r.outDir, { recursive: true });
  const runFile = join(r.outDir, "run.json");
  const previous = existsSync(runFile)
    ? (JSON.parse(readFileSync(runFile, "utf8")) as Record<string, unknown>)
    : null;
  // run.json is about to carry THIS configuration: a case reviewed under
  // another goes now (not when the loop reaches it), so a stop partway can
  // never leave it scored under this run's label.
  for (const c of r.cases) {
    const prior = r.resume ? readPragentSummary(r.outDir, c) : null;
    if (r.resume && (!prior || JSON.stringify(prior.fingerprint) === JSON.stringify(fingerprint))) continue;
    if (prior) r.log(`pragent: ${c.instance_id} was reviewed by a different PR-Agent/model/flags — its result is dropped`);
    rmSync(join(r.outDir, "cases", safeId(c.instance_id), "case-summary.json"), { force: true });
    rmSync(join(r.outDir, "results", "all", `${safeId(c.instance_id)}.json`), { force: true });
  }
  const runRecord = {
    reviewer: "pragent",
    set: r.set.name,
    dataset: r.set.dataset,
    pragent_version: r.pragentVersion,
    model: r.model,
    effort: r.effort,
    verbosity: r.verbosity,
    pr_text: r.prText,
    endpoint: "ChatGPT Codex backend via the loopback bridge (bench/aacr/codex_bridge.py)",
    command:
      "git branch <base_ref> <base>; (in the tree at <head>) python pragent_driver.py --command review|improve → python -m pr_agent.cli --pr_url <base_ref> review|improve (local git provider)",
    commands: [...PRAGENT_COMMANDS],
    flags: { timeout_min: r.timeoutMin },
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
  const summaries: PragentCaseSummary[] = [];
  let stopped: string | null = null;
  for (const c of r.cases) {
    const prior = readPragentSummary(r.outDir, c);
    if (r.resume && prior && prior.status === "ok") {
      r.log(`pragent: ${c.instance_id} already done — skipped (--resume)`);
      summaries.push(prior);
      continue;
    }
    try {
      // The bridge reads this refresh-disabled copy on every call.
      syncBenchAuth({
        srcDir: r.authSrc,
        dstDir: r.agentDir,
        root: r.root,
        needMs: PRAGENT_COMMANDS.length * pragentProcessTimeoutMs(r.timeoutMin) + 5 * 60_000,
      });
    } catch (err) {
      if (!(err instanceof AuthExpiring)) throw err;
      stopped = err.message;
      r.log(`pragent: STOPPED — ${err.message}`);
      break;
    }
    let meta: PrefetchMeta;
    try {
      meta = r.readMeta(c);
    } catch (err) {
      const error = String(err instanceof Error ? err.message : err);
      r.log(error);
      summaries.push(unprefetchedPragentCase(r.outDir, c, fingerprint, error));
      continue;
    }
    summaries.push(
      await reviewCasePragent(c, meta, {
        root: r.root,
        store: r.store,
        outDir: r.outDir,
        python: r.python,
        driver: r.driver,
        bridgeUrl: r.bridgeUrl,
        model: r.model,
        timeoutMin: r.timeoutMin,
        prText: r.prText,
        fingerprint,
        keepTree: r.keepTree,
        log: r.log,
        ...(r.fetchImpl ? { fetchImpl: r.fetchImpl } : {}),
        ...(r.runImpl ? { runImpl: r.runImpl } : {}),
      }),
    );
  }
  runRecord.finished_at = new Date().toISOString();
  writeFileSync(runFile, JSON.stringify(runRecord, null, 2) + "\n");
  const ok = summaries.filter((s) => s.status === "ok").length;
  r.log(`pragent: ${ok}/${r.cases.length} reviewed — results in ${join(r.outDir, "results", "all")}`);
  if (stopped !== null) r.log(`pragent: run stopped early — ${stopped}`);
  return ok === r.cases.length ? 0 : 1;
}

// ---- the report ----------------------------------------------------------------------

function n(v: number | undefined): string {
  return v === undefined ? "?" : Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
}

/** The PR-Agent arm's report: the harness's numbers, then per case what each
 * command did and what it cost at the bridge. */
export function renderPragentReport(set: CaseSet, outDir: string, cases: BenchCase[]): string {
  const L: string[] = [];
  const runPath = join(outDir, "run.json");
  const run = (existsSync(runPath) ? JSON.parse(readFileSync(runPath, "utf8")) : {}) as Record<string, unknown>;
  const judgeFile = join(outDir, "judge.txt");
  const judge = existsSync(judgeFile) ? readFileSync(judgeFile, "utf8").trim().split("\n") : ["not run"];
  const k = (x: number): string => `${Math.round(x / 1000)}k`;
  L.push(`# AACR-Bench run — ${set.name} — PR-Agent`);
  L.push("");
  L.push(
    `- Dataset: AACR-Bench v1.0 (\`${set.dataset.commit.slice(0, 7)}\`), ${cases.length} PRs, ${cases.reduce((a, c) => a + c.references, 0)} reference comments`,
  );
  L.push(
    `- Reviewer: PR-Agent ${String(run["pragent_version"] ?? "?")} — its CLI \`review\` then \`improve\` on the local git provider (base...head), PR title/description ${run["pr_text"] === false ? "withheld (--no-pr-text)" : "as the GitHub provider supplies them"}, PR-Agent's default configuration; timeout ${String((run["flags"] as Record<string, unknown> | undefined)?.["timeout_min"] ?? "?")} min (+60 s) per command`,
  );
  L.push(
    `- Model: \`${String(run["model"] ?? "?")}\`, reasoning effort \`${String(run["effort"] ?? "?")}\` — the ChatGPT Codex backend through the loopback bridge (bench/aacr/codex_bridge.py, Chat Completions)`,
  );
  L.push(`- Judge: ${judge[0] ?? ""}`);
  for (const w of judge.slice(1)) L.push(`  ${w}`);
  L.push("");
  L.push("## Scores (the AACR harness, OCR reader)");
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
    "| Case | Lang | Refs | Status | Comments | /review (issues) | /improve (suggestions) | Unlocated | Minutes | Model calls (failed) | Tokens in (cached) / out (reasoning) |",
  );
  L.push("|---|---|---|---|---|---|---|---|---|---|---|");
  const warned: Array<{ c: BenchCase; s: PragentCaseSummary }> = [];
  for (const c of cases) {
    const s = readPragentSummary(outDir, c);
    if (!s) {
      L.push(`| ${c.instance_id} | ${c.language} | ${c.references} | not run | | | | | | | |`);
      continue;
    }
    if (s.warnings.length || s.error || !s.merge_base_ok) warned.push({ c, s });
    const b = s.bridge;
    L.push(
      `| ${c.instance_id} | ${c.language} | ${c.references} | ${s.status} | ${s.comments} | ${s.commands.review.status} (${s.review_findings}) | ${s.commands.improve.status} (${s.improve_findings}) | ${s.unlocated} | ${(s.duration_seconds / 60).toFixed(1)} | ${b ? `${b.requests} (${b.errors})` : "?"} | ${b ? `${k(b.input_tokens)} (${k(b.cached_tokens)}) / ${k(b.output_tokens)} (${k(b.reasoning_tokens)})` : "?"} |`,
    );
  }
  if (warned.length) {
    L.push("");
    L.push("## Warnings (case errors)");
    L.push("");
    for (const { c, s } of warned) {
      if (!s.merge_base_ok && s.status !== "failed")
        L.push(`- \`${c.instance_id}\`: merge-base check failed — see case-summary.json`);
      for (const w of s.warnings) L.push(`- \`${c.instance_id}\`: ${w.replaceAll("\n", " ").slice(0, 400)}`);
      if (s.error && !s.warnings.length) L.push(`- \`${c.instance_id}\`: ${s.error.replaceAll("\n", " ").slice(0, 400)}`);
    }
  }
  L.push("");
  L.push(
    "Reading the numbers: PR-Agent's findings carry no blocker/nit tags, so only the `all` variant exists for this arm. Comments are /review's key issues (at most 3 per PR by PR-Agent's default) and /improve's suggestions; unlocated findings and the security verdict are in each case's review.md, which the defect judge reads as the review body.",
  );
  L.push("");
  return L.join("\n");
}

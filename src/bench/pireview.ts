// The pi-review arm of the AACR-Bench harness (`bench.sh --arm pireview`).
//
// @zephyrdeng/pi-review (npm; github.com/ZephyrDeng/pi-review) is the most
// downloaded dedicated code-review package for the pi coding agent. Its CLI
// (`pi-review`, the documented non-interactive entry — "Scripts / CI:
// foreground is fine") hands the review to ONE fresh child `pi -p --mode json`
// session with a hard read-only tool allowlist (`read,grep,find,ls` — no
// shell, so the reviewer cannot run git), its own appended system prompt
// (resources/system-prompt.md) and a review contract (dist/prompt.js) that
// makes the model answer in a fixed Markdown shape:
//
//   ## Verdict / ## Summary / ## Findings
//   ### F1: <summary>
//   - Severity: critical | high | medium | low
//   - Path: <path or none>        - Lines: <42 | 42-58 | none>
//   - Side: base | working        - Actionable: yes | no
//   - Evidence / Impact / Recommendation
//
// pi-review parses that itself (dist/review-result.js) and prints the result
// as ONE `PI_REVIEW_META_JSON:` line — its documented, versioned machine
// contract (`metaVersion: 1`; findings carry path, `location.{startLine,
// endLine, side}`, `details` = Evidence+Impact, `recommendation`). This arm
// reads THAT line: no Markdown scraping of ours, and no findings tool or
// instruction added — the output is already structured.
//
// How it is run (the harness has no pi-review runner; this is one):
//
//   git diff <base>...<head>  > <scratch>/pr.diff        (outside the tree)
//   cd <tree checked out at head>
//   pi-review --model openai-codex/gpt-6-sol --thinking medium \
//             --progress-log <case>/pi-events.jsonl \
//             -- @<scratch>/pr.diff "<PIREVIEW_TARGET>"
//
// The diff rides a documented `@file` attachment (pi inlines the file into
// the first message) because the read-only reviewer has no way to compute
// it; `stdin` works too but lands in the child's ARGV, which Linux caps at
// 128 KiB per argument — a large PR would fail to spawn. The one sentence of
// target text says what the attachment is (pi-review's contract: "Pass the
// review request as natural language after `--`"). Single reviewer, `code`
// mode, its own prompts and defaults — the CLI default is not a panel. The
// ONE departure from its preset: `--thinking medium` (the preset says high)
// so every arm of the benchmark runs gpt-6-sol at the same effort; the
// `--thinking` flag of `pireview-review` changes it.
//
// The model is pi's built-in `openai-codex` provider on the benchmark's ONE
// ChatGPT login: the refresh-disabled copy src/bench/auth.ts takes before
// every case (never a second refresher, never a write to the source). The
// child pi runs `--no-extensions` (pi-review's default isolation) plus
// pi-review's own `.claude/rules` loader; its agent dir holds the token and
// default settings only — NOT the quickreviewd sandbox's bash-guard settings.
// The tree lives under /work, not under /opt/quickreview/sandbox: pi loads
// AGENTS.md/CLAUDE.md from EVERY ancestor of its cwd, and the sandbox root
// carries the production reviewer's context files.
//
// No PR title or description reaches pi-review — the harness's CLI runners
// pass none either — unless the equal-inputs switch is on (QCR_BENCH_PR_TEXT=1,
// src/bench/prtext.ts): then they follow the target sentence, in the natural-
// language request pi-review's contract asks for.
//
// The PANEL (fairness audit item A, `--panel code-experts`, QCR_BENCH_PIREVIEW_
// PANEL): what `/rv` runs inside Pi by default — its `pi_review` tool spawns
// `pi-review --mode code --panel code-experts -- <target>` when no width or
// preset is given (extensions/panel-tool.ts, extensions/rv-prompts.ts). Three
// isolated reviewers (correctness, security, testing), quorum 2; the meta line
// then carries `confirmedClusters` and `advisories` ("singletons stay visible
// as advisories"), and its `findings` list only the confirmed clusters without
// their locations. This arm scores what the panel SHOWS: one comment per
// cluster, confirmed and advisory alike (as the single-reviewer arm keeps every
// finding, actionable or not), from the cluster's canonical source finding —
// the one pi-review itself picks (the first actionable, else the first) — with
// its path, lines, evidence and recommendation from `sourceFindings`.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { safeId, type BenchCase, type CaseSet, type PrefetchMeta } from "./aacr.js";
import { AuthExpiring, syncBenchAuth } from "./auth.js";
import { run } from "./exec.js";
import { prTextFor } from "./prtext.js";
import { roundMetrics } from "./report.js";
import { prepareTree } from "./runner.js";

// ---- how pi-review is invoked --------------------------------------------------------

/** The harness's CLI runners' default (reviewers/codex.py, pipeline.py
 * `apply_defaults`): 30 minutes, process timeout = that + 60 s. */
export const PIREVIEW_DEFAULTS = {
  timeoutMin: 30,
  model: "openai-codex/gpt-6-sol",
  thinking: "medium",
} as const;

export function pireviewProcessTimeoutMs(timeoutMin: number): number {
  return (timeoutMin * 60 + 60) * 1000;
}

/** The natural-language review target: WHAT the attached file is, nothing
 * about how to review it (pi-review's own prompts carry that). */
export function pireviewTarget(base: string, head: string, prText: string | null = null): string {
  const target =
    `Review the code changes in the attached diff (git diff ${base}...${head}). ` +
    `The working directory is the repository checked out at ${head}.`;
  return prText ? `${target}\n\n${prText}` : target;
}

/** `pi-review` argv (single review, mode `code`, streaming — its defaults). */
export function pireviewArgv(o: {
  model: string;
  thinking: string;
  progressLog: string;
  diffFile: string;
  base: string;
  head: string;
  /** A named panel preset (`code-experts` = what /rv runs); absent = one reviewer. */
  panel?: string | null;
  prText?: string | null;
}): string[] {
  return [
    "--model",
    o.model,
    "--thinking",
    o.thinking,
    ...(o.panel ? ["--panel", o.panel] : []),
    "--progress-log",
    o.progressLog,
    "--",
    `@${o.diffFile}`,
    pireviewTarget(o.base, o.head, o.prText ?? null),
  ];
}

/** The whole command: pi-review under coreutils `timeout`, which signals its
 * own process GROUP — the child `pi` dies with pi-review (a plain kill of the
 * node process would orphan it, still spending tokens). */
export function pireviewCommand(o: {
  bin: string;
  timeoutMin: number;
  argv: string[];
}): { bin: string; args: string[] } {
  return {
    bin: "timeout",
    args: ["-k", "30s", `${o.timeoutMin * 60 + 60}s`, o.bin, ...o.argv],
  };
}

/** Exit codes of `timeout` meaning the time ran out (124) or the grace
 * period's KILL was needed (137). */
export function isTimeoutExit(code: number): boolean {
  return code === 124 || code === 137;
}

/** pi-review's environment: a fresh HOME per case (its ~/.pi/pi-review config
 * and ~/.claude/rules are absent → its defaults), the case's agent dir with
 * the refresh-disabled token, the meta line on stdout, every phone-home off.
 * No TYPESAFE_API_KEY: Jev (a hosted adjudicator) is optional and stays off. */
export function pireviewEnv(o: {
  path: string;
  home: string;
  tmpDir: string;
  agentDir: string;
}): NodeJS.ProcessEnv {
  return {
    PATH: o.path,
    HOME: o.home,
    TMPDIR: o.tmpDir,
    LANG: "C.UTF-8",
    PI_CODING_AGENT_DIR: o.agentDir,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    PI_REVIEW_META_STDOUT: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
}

/** The pi global settings for this arm: only what keeps a non-interactive run
 * from stalling — no extensions, no quickreviewd bash-guard. */
export const PIREVIEW_PI_SETTINGS = { defaultProjectTrust: "always" } as const;

// ---- reading what pi-review did ------------------------------------------------------

export interface PireviewFinding {
  id?: string;
  severity?: string;
  path?: string;
  summary: string;
  actionable: boolean;
  details?: string;
  recommendation?: string;
  location?: { startLine: number; endLine?: number; side?: "base" | "working" };
}

export interface PireviewMeta {
  metaVersion?: number;
  reviewMode?: string;
  verdict: string;
  verdictSource?: string;
  status: string;
  parseError?: string;
  findings: PireviewFinding[];
  actionableCount?: number;
  durationMs?: number;
  model?: string | null;
  thinking?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    reasoning?: number;
    totalTokens?: number;
    costTotal?: number;
  };
  /** Panel runs only (pi-review's PanelReviewMeta). */
  strategy?: string;
  panelPreset?: string;
  panelHealth?: string;
  configuredReviewers?: number;
  successfulReviewers?: number;
  confirmedClusters?: PireviewCluster[];
  advisories?: PireviewCluster[];
  sourceFindings?: Array<{ id: string; reviewerId: string; finding: PireviewFinding }>;
}

/** pi-review's FindingCluster (a panel's merged view of one issue). */
export interface PireviewCluster {
  id: string;
  summary: string;
  severity?: string;
  path?: string;
  confirmed: boolean;
  supportCount?: number;
  actionableSupportCount?: number;
  supportingReviewerIds?: string[];
  sourceFindingIds: string[];
}

export function isPanelMeta(meta: PireviewMeta): boolean {
  return meta.strategy === "panel" || Array.isArray(meta.confirmedClusters);
}

/**
 * A panel's findings as the benchmark scores them: one per cluster, confirmed
 * clusters first, then the advisories — each the cluster's canonical source
 * finding (pi-review's own pick: the first actionable one, else the first),
 * with the cluster's path when the canonical finding has none and the first
 * location any of its source findings carries. A cluster whose source findings
 * are missing from the meta falls back to its own summary/severity/path.
 */
export function panelFindings(meta: PireviewMeta): PireviewFinding[] {
  const byId = new Map((meta.sourceFindings ?? []).map((sf) => [sf.id, sf.finding]));
  const out: PireviewFinding[] = [];
  for (const cl of [...(meta.confirmedClusters ?? []), ...(meta.advisories ?? [])]) {
    const sources = cl.sourceFindingIds
      .map((id) => byId.get(id))
      .filter((f): f is PireviewFinding => f !== undefined);
    const canonical = sources.find((f) => f.actionable) ?? sources[0];
    const location = canonical?.location ?? sources.find((f) => f.location)?.location;
    const path = canonical?.path ?? sources.find((f) => f.path)?.path ?? cl.path;
    out.push({
      ...(canonical ?? { summary: cl.summary, actionable: cl.confirmed }),
      ...(canonical?.severity ?? cl.severity ? { severity: canonical?.severity ?? cl.severity } : {}),
      ...(path ? { path } : {}),
      ...(location ? { location } : {}),
      actionable: cl.confirmed,
    });
  }
  return out;
}

/** What the arm scores from one meta line: a panel's clusters, else the findings. */
export function scoredFindings(meta: PireviewMeta): PireviewFinding[] {
  return isPanelMeta(meta) ? panelFindings(meta) : meta.findings;
}

export const META_PREFIX = "PI_REVIEW_META_JSON:";

/** The last `PI_REVIEW_META_JSON:` line of pi-review's output, or null. */
export function parsePireviewMeta(output: string): PireviewMeta | null {
  const lines = output.split("\n").filter((l) => l.startsWith(META_PREFIX));
  for (const line of lines.reverse()) {
    try {
      const v = JSON.parse(line.slice(META_PREFIX.length).trim()) as PireviewMeta;
      if (v && typeof v === "object" && Array.isArray(v.findings)) return v;
    } catch {
      // not this one
    }
  }
  return null;
}

/** The review Markdown pi-review streamed to stdout: everything before its
 * ASCII footer (and never the meta line). */
export function pireviewText(stdout: string): string {
  const cut = stdout.indexOf("── pi-review");
  const body = cut >= 0 ? stdout.slice(0, cut) : stdout;
  return body
    .split("\n")
    .filter((l) => !l.startsWith(META_PREFIX))
    .join("\n")
    .trim();
}

/** Tool calls in the child's event stream (the progress log), by name. */
export function toolCounts(progressLog: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of progressLog.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const e = JSON.parse(line) as Record<string, unknown>;
      if (e["type"] === "tool_execution_start" && typeof e["toolName"] === "string")
        out[e["toolName"]] = (out[e["toolName"]] ?? 0) + 1;
    } catch {
      // skip
    }
  }
  return out;
}

export interface OcrShapedComment {
  path: string;
  start_line: number | null;
  end_line: number | null;
  content: string;
  severity?: string;
}

/** A comment on the BASE side (deleted/old lines), kept for the defect judge
 * in the quickreviewd `comments.json` shape — the AACR scorer reads only the
 * new side, so these stay out of the scored file (as the quickreviewd arm's do). */
export interface LeftSideComment {
  path: string;
  line: number | null;
  side: "LEFT";
  body: string;
}

/**
 * The path as the scorer compares it: repo-relative. Strips the tree's
 * absolute prefix, `./`, and git's `a/`/`b/` diff prefixes, and splits a
 * trailing `:42` / `:42-58` off a Path the model wrote with its line in it
 * (only used when pi-review parsed no `Lines`).
 */
export function normalizeFindingPath(
  raw: string | undefined,
  tree: string,
): { path: string; lines: { start: number; end: number } | null } {
  let p = (raw ?? "").trim().replace(/^`|`$/g, "");
  let lines: { start: number; end: number } | null = null;
  const m = /^(.*?):(\d+)(?:-(\d+))?$/.exec(p);
  if (m && m[1]) {
    p = m[1];
    const start = Number(m[2]);
    const end = m[3] ? Number(m[3]) : start;
    if (start > 0 && end >= start) lines = { start, end };
  }
  const t = tree.replace(/\/+$/, "") + "/";
  if (p.startsWith(t)) p = p.slice(t.length);
  p = p.replace(/^\.\//, "");
  if (/^[ab]\//.test(p)) p = p.slice(2);
  return { path: p, lines };
}

/** The comment text: pi-review's summary, then its details (Evidence +
 * Impact) and its recommendation — every field of the finding it printed. */
export function findingNote(f: PireviewFinding): string {
  return [
    f.summary?.trim() ?? "",
    f.details?.trim() ?? "",
    f.recommendation?.trim() ? `Recommendation: ${f.recommendation.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

/**
 * pi-review's findings → the OCR reader's comment rows (what the harness
 * scores with `--reviewer ocr`, and the defect judge reads). Every finding it
 * reported counts, actionable or not (the review shows them all); a finding
 * with no Lines keeps null lines, one with no Path an empty path — both are
 * scored as they are, as the codex/opencode arms score theirs. A finding on
 * the BASE side goes to `left` instead.
 */
export function toComments(
  findings: PireviewFinding[],
  tree: string,
): { comments: OcrShapedComment[]; left: LeftSideComment[] } {
  const comments: OcrShapedComment[] = [];
  const left: LeftSideComment[] = [];
  for (const f of findings) {
    const note = findingNote(f);
    if (!note) continue;
    const { path, lines } = normalizeFindingPath(f.path, tree);
    const start = f.location?.startLine ?? lines?.start ?? null;
    const end = f.location ? (f.location.endLine ?? f.location.startLine) : (lines?.end ?? null);
    if (f.location?.side === "base") {
      left.push({ path, line: start, side: "LEFT", body: note });
      continue;
    }
    comments.push({
      path,
      start_line: start,
      end_line: end,
      content: note,
      ...(f.severity ? { severity: f.severity } : {}),
    });
  }
  return { comments, left };
}

// ---- one case ------------------------------------------------------------------------

export type PireviewStatus = "ok" | "failed" | "timeout" | "no-output";

export interface PireviewFingerprint {
  qcr_commit: string;
  pireview_version: string;
  pi_version: string;
  model: string;
  thinking: string;
  timeout_min: number;
  /** Present only for a panel run (the preset's name). */
  panel?: string;
  /** Present only when the PR text was handed over (QCR_BENCH_PR_TEXT=1). */
  pr_text?: true;
}

export interface PireviewCaseSummary {
  instance_id: string;
  arm: "pireview";
  status: PireviewStatus;
  error?: string;
  fingerprint: PireviewFingerprint;
  exit_code: number | null;
  duration_seconds: number;
  /** Comments the scorer reads from the result file. */
  comments: number;
  /** Base-side findings, kept for the defect judge only. */
  left_side: number;
  findings: number;
  actionable: number;
  verdict: string | null;
  pireview_status: string | null;
  verdict_source: string | null;
  parse_error: string | null;
  diff_bytes: number;
  /** pi-review's own token count (the child session's usage). */
  usage: { input: number; output: number; cacheRead: number } | null;
  cost_usd: number | null;
  tools: Record<string, number>;
  merge_base_ok: boolean;
  warnings: string[];
  /** Panel runs: the clusters and the reviewers that contributed. */
  panel?: {
    confirmed: number;
    advisories: number;
    reviewers_ok: number | null;
    reviewers: number | null;
    health: string | null;
  };
  /** With the PR-text switch on: whether this case's title/body reached pi-review. */
  pr_text?: boolean;
}

export function pireviewStatus(a: {
  exitCode: number;
  timedOut: boolean;
  meta: PireviewMeta | null;
}): PireviewStatus {
  if (a.timedOut || isTimeoutExit(a.exitCode)) return "timeout";
  if (!a.meta) return "no-output";
  if (a.meta.status === "blocked") return "failed";
  return "ok";
}

/** The harness's CLI-runner payload (codex.py `save_result`'s keys),
 * reviewer "pireview", plus the OCR-reader copy of the comments under
 * `review` and our `bench` block. */
export function pireviewResultPayload(a: {
  c: BenchCase;
  model: string;
  startedAt: string;
  durationSeconds: number;
  exitCode: number;
  meta: PireviewMeta | null;
  comments: OcrShapedComment[];
  stderr: string;
  bench: Record<string, unknown>;
}): Record<string, unknown> {
  const u = a.meta?.usage ?? {};
  return {
    instance_id: a.c.instance_id,
    repo: a.c.repo,
    base_commit: a.c.base_commit,
    head_commit: a.c.head_commit,
    reviewer: "pireview",
    model: a.model,
    started_at: a.startedAt,
    duration_seconds: Math.round(a.durationSeconds * 100) / 100,
    pireview_exit_code: a.exitCode,
    review_output_source: "pi_review_meta_json",
    review_output: a.meta?.findings ?? [],
    token_usage: {
      input_tokens: u.input ?? 0,
      output_tokens: u.output ?? 0,
      reasoning_output_tokens: u.reasoning ?? 0,
      cache_read_input_tokens: u.cacheRead ?? 0,
      cache_creation_input_tokens: u.cacheWrite ?? 0,
      total_tokens: u.totalTokens ?? 0,
    },
    review: { comments: a.comments },
    stderr: a.stderr,
    bench: a.bench,
  };
}

export function writePireviewResult(outDir: string, c: BenchCase, payload: Record<string, unknown>): void {
  const dir = join(outDir, "results", "all");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${safeId(c.instance_id)}.json`), JSON.stringify(payload, null, 2) + "\n");
}

export function readPireviewSummary(outDir: string, c: BenchCase): PireviewCaseSummary | null {
  const p = join(outDir, "cases", safeId(c.instance_id), "case-summary.json");
  if (!existsSync(p)) return null;
  const s = JSON.parse(readFileSync(p, "utf8")) as Partial<PireviewCaseSummary>;
  return s.arm === "pireview" ? (s as PireviewCaseSummary) : null;
}

function emptySummary(c: BenchCase, fingerprint: PireviewFingerprint): PireviewCaseSummary {
  return {
    instance_id: c.instance_id,
    arm: "pireview",
    status: "failed",
    fingerprint,
    exit_code: null,
    duration_seconds: 0,
    comments: 0,
    left_side: 0,
    findings: 0,
    actionable: 0,
    verdict: null,
    pireview_status: null,
    verdict_source: null,
    parse_error: null,
    diff_bytes: 0,
    usage: null,
    cost_usd: null,
    tools: {},
    merge_base_ok: false,
    warnings: [],
  };
}

export interface PireviewRunnerOptions {
  /** Where the case trees live (NOT under the sandbox root — see the header). */
  work: string;
  store: string;
  outDir: string;
  agentDir: string;
  pireviewBin: string;
  model: string;
  thinking: string;
  timeoutMin: number;
  fingerprint: PireviewFingerprint;
  keepTree?: boolean;
  log?: (line: string) => void;
  /** Injected in tests; defaults to the real subprocess runner. */
  runImpl?: typeof run;
  /** A named panel preset (`code-experts`); absent = the single reviewer. */
  panel?: string | null;
  /** Hand pi-review the PR title/body in its target (src/bench/prtext.ts). */
  prText?: boolean;
}

/** Review one case with pi-review and write its result file. Never throws for
 * a case that fails — a failure is a recorded outcome with an empty result. */
export async function reviewCasePireview(
  c: BenchCase,
  meta: PrefetchMeta,
  o: PireviewRunnerOptions,
): Promise<PireviewCaseSummary> {
  const log = o.log ?? (() => {});
  const exec = o.runImpl ?? run;
  const safe = safeId(c.instance_id);
  const caseDir = join(o.outDir, "cases", safe);
  const tree = join(o.work, "wt", safe);
  const scratch = join(o.work, `${safe}.pireview`);
  const home = join(scratch, "home");
  const tmpDir = join(scratch, "tmp");
  const diffFile = join(scratch, "pr.diff");
  const progressLog = join(caseDir, "pi-events.jsonl");
  mkdirSync(caseDir, { recursive: true });
  rmSync(progressLog, { force: true });
  for (const f of reviewerLogs(caseDir)) rmSync(join(caseDir, f), { force: true });
  clearJudgeInputs(caseDir);
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const summary = emptySummary(c, o.fingerprint);
  let stdout = "";
  let stderr = "";
  let exitCode = -1;
  let pmeta: PireviewMeta | null = null;
  let comments: OcrShapedComment[] = [];
  let left: LeftSideComment[] = [];
  try {
    await prepareTree(join(o.store, safe), tree, meta);
    rmSync(scratch, { recursive: true, force: true });
    for (const d of [home, tmpDir]) mkdirSync(d, { recursive: true });
    const env = pireviewEnv({
      path: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      home,
      tmpDir,
      agentDir: o.agentDir,
    });
    const mb = await exec("git", ["-C", tree, "merge-base", c.base_commit, c.head_commit], { env });
    summary.merge_base_ok = mb.code === 0 && mb.stdout.trim() === meta.merge_base;
    if (!summary.merge_base_ok)
      summary.warnings.push(
        `merge-base(${c.base_commit.slice(0, 7)}, head) = ${mb.stdout.trim() || mb.stderr.trim().slice(0, 200)}, prefetched ${meta.merge_base.slice(0, 7)}`,
      );
    const diff = await exec(
      "git",
      ["-C", tree, "diff", "--no-color", "--no-ext-diff", `${c.base_commit}...${c.head_commit}`],
      { env, maxBytes: 256 * 1024 * 1024 },
    );
    if (diff.code !== 0) throw new Error(`git diff failed: ${diff.stderr.trim().slice(0, 400)}`);
    writeFileSync(diffFile, diff.stdout);
    summary.diff_bytes = Buffer.byteLength(diff.stdout);
    const prText = prTextFor(meta, o.prText === true);
    if (o.prText) summary.pr_text = prText !== null;
    const argv = pireviewArgv({
      model: o.model,
      thinking: o.thinking,
      progressLog,
      diffFile,
      base: c.base_commit,
      head: c.head_commit,
      panel: o.panel ?? null,
      prText,
    });
    const cmd = pireviewCommand({ bin: o.pireviewBin, timeoutMin: o.timeoutMin, argv });
    writeFileSync(join(caseDir, "pireview-argv.json"), JSON.stringify([cmd.bin, ...cmd.args], null, 2) + "\n");
    log(
      `pireview: ${c.instance_id} — ${meta.diff.files} files, diff ${Math.round(summary.diff_bytes / 1024)} KiB, ${c.base_commit.slice(0, 7)}...${c.head_commit.slice(0, 7)}`,
    );
    const r = await exec(cmd.bin, cmd.args, {
      cwd: tree,
      env,
      // Backstop only: `timeout` ends the process group first.
      timeoutMs: pireviewProcessTimeoutMs(o.timeoutMin) + 60_000,
    });
    stdout = r.stdout;
    stderr = r.stderr;
    exitCode = r.code;
    summary.exit_code = r.code;
    pmeta = parsePireviewMeta(stdout) ?? parsePireviewMeta(stderr);
    summary.status = pireviewStatus({ exitCode: r.code, timedOut: r.timedOut, meta: pmeta });
    if (pmeta) {
      summary.verdict = pmeta.verdict ?? null;
      summary.pireview_status = pmeta.status ?? null;
      summary.verdict_source = pmeta.verdictSource ?? null;
      summary.parse_error = pmeta.parseError ?? null;
      const scored = scoredFindings(pmeta);
      summary.findings = scored.length;
      summary.actionable = scored.filter((f) => f.actionable).length;
      if (isPanelMeta(pmeta))
        summary.panel = {
          confirmed: pmeta.confirmedClusters?.length ?? 0,
          advisories: pmeta.advisories?.length ?? 0,
          reviewers_ok: pmeta.successfulReviewers ?? null,
          reviewers: pmeta.configuredReviewers ?? null,
          health: pmeta.panelHealth ?? null,
        };
      const u = pmeta.usage;
      if (u) {
        summary.usage = { input: u.input ?? 0, output: u.output ?? 0, cacheRead: u.cacheRead ?? 0 };
        summary.cost_usd = typeof u.costTotal === "number" ? u.costTotal : null;
      }
      ({ comments, left } = toComments(scored, tree));
      if (pmeta.parseError) summary.warnings.push(`pi-review: ${pmeta.parseError.slice(0, 600)}`);
    }
    if (summary.status !== "ok")
      summary.error = (pmeta?.parseError || stderr.trim() || stdout.trim()).slice(-1500);
    const text = pireviewText(stdout);
    if (text) writeFileSync(join(caseDir, "review.md"), text + "\n");
    // A panel logs one progress file per reviewer (<log>.r<id>.jsonl): joined
    // into the one file the tool counts and compare.py's cost read.
    const perReviewer = reviewerLogs(caseDir);
    if (perReviewer.length && !existsSync(progressLog))
      writeFileSync(
        progressLog,
        perReviewer.map((f) => readFileSync(join(caseDir, f), "utf8")).join(""),
      );
    if (existsSync(progressLog)) summary.tools = toolCounts(readFileSync(progressLog, "utf8"));
  } catch (err) {
    summary.status = "failed";
    summary.error = String(err instanceof Error ? err.message : err).slice(0, 2000);
    log(`pireview: ${c.instance_id} FAILED — ${summary.error}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    if (!o.keepTree) rmSync(tree, { recursive: true, force: true });
  }
  summary.duration_seconds = Math.round((Date.now() - started) / 1000);
  summary.comments = comments.length;
  summary.left_side = left.length;
  writeFileSync(join(caseDir, "pireview-stdout.txt"), stdout);
  writeFileSync(join(caseDir, "pireview-stderr.log"), stderr);
  if (pmeta) writeFileSync(join(caseDir, "pireview-meta.json"), JSON.stringify(pmeta, null, 2) + "\n");
  // Base-side findings: the defect judge reads LEFT rows from comments.json.
  writeFileSync(join(caseDir, "comments.json"), JSON.stringify(left, null, 2) + "\n");
  writeFileSync(join(caseDir, "case-summary.json"), JSON.stringify(summary, null, 2) + "\n");
  writePireviewResult(
    o.outDir,
    c,
    pireviewResultPayload({
      c,
      model: o.model,
      startedAt,
      durationSeconds: (Date.now() - started) / 1000,
      exitCode,
      meta: pmeta,
      comments,
      stderr,
      bench: { status: summary.status, fingerprint: o.fingerprint },
    }),
  );
  log(
    `pireview: ${c.instance_id} ${summary.status} — ${summary.comments} comment(s)` +
      (summary.left_side ? ` + ${summary.left_side} base-side` : "") +
      ` (${summary.findings} finding(s), ${summary.actionable} actionable, verdict ${summary.verdict ?? "?"}), ${summary.duration_seconds}s` +
      (summary.usage ? `, ${summary.usage.input} in/${summary.usage.output} out` : ""),
  );
  return summary;
}

/** A panel's per-reviewer progress logs in a case dir (pi-events.r<id>.jsonl). */
function reviewerLogs(caseDir: string): string[] {
  if (!existsSync(caseDir)) return [];
  return readdirSync(caseDir)
    .filter((f) => /^pi-events\.r.+\.jsonl$/.test(f))
    .sort();
}

/** An earlier attempt's review body and base-side rows must not outlive it:
 * the defect judge reads both whatever this attempt's status. */
function clearJudgeInputs(caseDir: string): void {
  rmSync(join(caseDir, "review.md"), { force: true });
  rmSync(join(caseDir, "comments.json"), { force: true });
}

/** A case with no prefetched store: failed WITH an empty result file, so its
 * references count against recall instead of vanishing from both denominators. */
export function unprefetchedPireviewCase(
  outDir: string,
  c: BenchCase,
  fingerprint: PireviewFingerprint,
  error: string,
): PireviewCaseSummary {
  const summary = { ...emptySummary(c, fingerprint), error };
  const caseDir = join(outDir, "cases", safeId(c.instance_id));
  mkdirSync(caseDir, { recursive: true });
  clearJudgeInputs(caseDir);
  writeFileSync(join(caseDir, "case-summary.json"), JSON.stringify(summary, null, 2) + "\n");
  writePireviewResult(
    outDir,
    c,
    pireviewResultPayload({
      c,
      model: fingerprint.model,
      startedAt: new Date().toISOString(),
      durationSeconds: 0,
      exitCode: -1,
      meta: null,
      comments: [],
      stderr: error,
      bench: { status: "failed", fingerprint },
    }),
  );
  return summary;
}

// ---- the whole run (cli `pireview-review`) -----------------------------------------

export interface PireviewReviewRun {
  set: CaseSet;
  cases: BenchCase[];
  outDir: string;
  work: string;
  root: string;
  store: string;
  authSrc: string;
  agentDir: string;
  pireviewBin: string;
  pireviewVersion: string;
  piVersion: string;
  model: string;
  thinking: string;
  timeoutMin: number;
  qcrCommit: string;
  resume: boolean;
  keepTree: boolean;
  readMeta: (c: BenchCase) => PrefetchMeta;
  log: (line: string) => void;
  runImpl?: typeof run;
  /** A named panel preset (`code-experts`); absent = the single reviewer. */
  panel?: string | null;
  /** The equal-inputs switch (src/bench/prtext.ts). */
  prText?: boolean;
}

/** Every case, ONE AT A TIME (as the harness runs its CLI reviewers; the
 * login is shared). Returns the process exit code. */
export async function runPireviewReview(r: PireviewReviewRun): Promise<number> {
  const fingerprint: PireviewFingerprint = {
    qcr_commit: r.qcrCommit,
    pireview_version: r.pireviewVersion,
    pi_version: r.piVersion,
    model: r.model,
    thinking: r.thinking,
    timeout_min: r.timeoutMin,
    ...(r.panel ? { panel: r.panel } : {}),
    ...(r.prText ? { pr_text: true as const } : {}),
  };
  mkdirSync(r.outDir, { recursive: true });
  const runFile = join(r.outDir, "run.json");
  const previous = existsSync(runFile)
    ? (JSON.parse(readFileSync(runFile, "utf8")) as Record<string, unknown>)
    : null;
  // run.json is about to carry THIS configuration, so no case reviewed under
  // another may stay a result of the run: without --resume every case goes;
  // with it, every case whose fingerprint differs goes now, not when the loop
  // reaches it — a stop partway (AuthExpiring) must leave those cases
  // incomplete, never scored under the new model/thinking label.
  for (const c of r.cases) {
    const prior = r.resume ? readPireviewSummary(r.outDir, c) : null;
    if (r.resume && (!prior || JSON.stringify(prior.fingerprint) === JSON.stringify(fingerprint))) continue;
    if (prior) r.log(`pireview: ${c.instance_id} was reviewed by a different pi-review/model/flags — its result is dropped`);
    rmSync(join(r.outDir, "cases", safeId(c.instance_id), "case-summary.json"), { force: true });
    rmSync(join(r.outDir, "results", "all", `${safeId(c.instance_id)}.json`), { force: true });
  }
  const runRecord = {
    reviewer: "pireview",
    set: r.set.name,
    dataset: r.set.dataset,
    pireview_version: r.pireviewVersion,
    pi_version: r.piVersion,
    model: r.model,
    thinking: r.thinking,
    endpoint: "pi's built-in openai-codex provider (ChatGPT Codex backend), refresh-disabled login copy",
    command: `git diff <base>...<head> > pr.diff; pi-review --model <model> --thinking <level>${r.panel ? ` --panel ${r.panel}` : ""} --progress-log <case>/pi-events.jsonl -- @pr.diff '<target>'`,
    target: pireviewTarget("<base>", "<head>", r.prText ? "<the PR title and description>" : null),
    panel: r.panel ?? null,
    // The equal-inputs switch (src/bench/prtext.ts): the PR title/body in the target.
    pr_text: r.prText === true,
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
  const summaries: PireviewCaseSummary[] = [];
  let stopped: string | null = null;
  for (const c of r.cases) {
    const prior = readPireviewSummary(r.outDir, c);
    // (a prior summary here carries this run's fingerprint — the others went above)
    if (r.resume && prior && prior.status === "ok") {
      r.log(`pireview: ${c.instance_id} already done — skipped (--resume)`);
      summaries.push(prior);
      continue;
    }
    try {
      // The child pi reads this refresh-disabled copy; re-taken before every case.
      syncBenchAuth({
        srcDir: r.authSrc,
        dstDir: r.agentDir,
        root: r.root,
        needMs: pireviewProcessTimeoutMs(r.timeoutMin) + 5 * 60_000,
      });
      // …and pi-review's child gets pi's defaults, not the quickreviewd sandbox's
      // global settings (bash-guard registered for OUR sessions).
      writeFileSync(join(r.agentDir, "settings.json"), JSON.stringify(PIREVIEW_PI_SETTINGS, null, 2) + "\n");
    } catch (err) {
      if (!(err instanceof AuthExpiring)) throw err;
      stopped = err.message;
      r.log(`pireview: STOPPED — ${err.message}`);
      break;
    }
    let meta: PrefetchMeta;
    try {
      meta = r.readMeta(c);
    } catch (err) {
      const error = String(err instanceof Error ? err.message : err);
      r.log(error);
      summaries.push(unprefetchedPireviewCase(r.outDir, c, fingerprint, error));
      continue;
    }
    summaries.push(
      await reviewCasePireview(c, meta, {
        work: r.work,
        store: r.store,
        outDir: r.outDir,
        agentDir: r.agentDir,
        pireviewBin: r.pireviewBin,
        model: r.model,
        thinking: r.thinking,
        timeoutMin: r.timeoutMin,
        fingerprint,
        keepTree: r.keepTree,
        log: r.log,
        ...(r.runImpl ? { runImpl: r.runImpl } : {}),
        panel: r.panel ?? null,
        prText: r.prText === true,
      }),
    );
  }
  runRecord.finished_at = new Date().toISOString();
  writeFileSync(runFile, JSON.stringify(runRecord, null, 2) + "\n");
  const ok = summaries.filter((s) => s.status === "ok").length;
  r.log(`pireview: ${ok}/${r.cases.length} reviewed — results in ${join(r.outDir, "results", "all")}`);
  if (stopped !== null) r.log(`pireview: run stopped early — ${stopped}`);
  return ok === r.cases.length ? 0 : 1;
}

// ---- the report ------------------------------------------------------------------------

function n(v: number | undefined): string {
  return v === undefined ? "?" : Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
}

export function renderPireviewReport(set: CaseSet, outDir: string, cases: BenchCase[]): string {
  const L: string[] = [];
  const runPath = join(outDir, "run.json");
  const runRec = (existsSync(runPath) ? JSON.parse(readFileSync(runPath, "utf8")) : {}) as Record<string, unknown>;
  const judgeFile = join(outDir, "judge.txt");
  const judge = existsSync(judgeFile) ? readFileSync(judgeFile, "utf8").trim().split("\n") : ["not run"];
  const k = (x: number): string => `${Math.round(x / 1000)}k`;
  L.push(`# AACR-Bench run — ${set.name} — pi-review`);
  L.push("");
  L.push(
    `- Dataset: AACR-Bench v1.0 (\`${set.dataset.commit.slice(0, 7)}\`), ${cases.length} PRs, ${cases.reduce((a, c) => a + c.references, 0)} reference comments`,
  );
  L.push(
    `- Reviewer: @zephyrdeng/pi-review ${String(runRec["pireview_version"] ?? "?")} on pi ${String(runRec["pi_version"] ?? "?")} — ${typeof runRec["panel"] === "string" ? `panel \`${runRec["panel"]}\` (every cluster scored, confirmed and advisory)` : "single reviewer"}, mode \`code\`, its own prompts; the diff \`git diff <base>...<head>\` attached with \`@file\`, the tree checked out at head; findings from its \`PI_REVIEW_META_JSON\` line; timeout ${String((runRec["flags"] as Record<string, unknown> | undefined)?.["timeout_min"] ?? "?")} min (+60 s); ${runRec["pr_text"] === true ? "PR title/description in the target" : "no PR title/description"}`,
  );
  L.push(
    `- Model: \`${String(runRec["model"] ?? "?")}\`, thinking \`${String(runRec["thinking"] ?? "?")}\` — pi's openai-codex provider on the refresh-disabled ChatGPT login copy`,
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
    "| Case | Lang | Refs | Status | Verdict | Comments (+base side) | Findings (actionable) | Minutes | Tokens in (cached) / out | Cost | Tools |",
  );
  L.push("|---|---|---|---|---|---|---|---|---|---|---|");
  const warned: Array<{ c: BenchCase; s: PireviewCaseSummary }> = [];
  for (const c of cases) {
    const s = readPireviewSummary(outDir, c);
    if (!s) {
      L.push(`| ${c.instance_id} | ${c.language} | ${c.references} | not run | | | | | | | |`);
      continue;
    }
    if (s.warnings.length || s.error || !s.merge_base_ok) warned.push({ c, s });
    const tools = Object.entries(s.tools)
      .sort((x, y) => y[1] - x[1])
      .map(([t, m]) => `${t} ${m}`)
      .join(", ");
    const u = s.usage;
    L.push(
      `| ${c.instance_id} | ${c.language} | ${c.references} | ${s.status} | ${s.verdict ?? "?"} | ${s.comments}${s.left_side ? ` (+${s.left_side})` : ""} | ${s.findings} (${s.actionable}) | ${(s.duration_seconds / 60).toFixed(1)} | ${u ? `${k(u.input + u.cacheRead)} (${k(u.cacheRead)}) / ${k(u.output)}` : "?"} | ${s.cost_usd !== null ? `$${s.cost_usd.toFixed(2)}` : "?"} | ${tools} |`,
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
    "Reading the numbers: the findings carry pi-review's severities (critical…low), not our blocker/nit tags, so only the `all` variant exists for this arm. Every finding pi-review reported is a comment, actionable or not; a finding it placed on the BASE side (deleted lines) is not scored by AACR (which reads the new side) but is shown to the defect judge. Tokens and cost are pi's own count for the child session.",
  );
  L.push("");
  return L.join("\n");
}

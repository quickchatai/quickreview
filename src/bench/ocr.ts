// The open-code-review (OCR) baseline arm of the AACR-Bench harness.
//
// Why it exists: the published leaderboard's rows ran under an undisclosed
// judge, round count and line tolerance, so none of them is comparable with
// a number this harness produces. A baseline re-run under THIS harness is:
// the same PRs, the same model our reviewer's conversation runs, the same
// judge, rounds and `--line-k`. This module runs OCR the way the harness's own
// runner does — `evaluation/reviewers/ocr.py` at the pinned harness commit —
// and writes the result file that runner writes, so the harness scores it with
// its OCR reader (`evaluate.py build_target_comments_from_ocr`) untouched.
//
// What is the harness's, exactly (reviewers/ocr.py + pipeline.py defaults):
//   `ocr review --repo R --from <base_commit> --to <head_commit> --format json
//    --audience agent --concurrency 8 --timeout 30 --max-tools 30`, a process
//   timeout of timeout×60+300 s, and the result payload of `save_result`.
//   OCR's range mode diffs merge-base(from, to)..to itself — the same
//   merge-base..head range the QuickReview arm reviews.
//
// What differs, all mechanical:
//   - the repo is `prepareTree`'s (objects borrowed read-only from the
//     prefetched per-instance store, a detached head, one base ref) instead
//     of the harness's full clone. OCR reads code only through
//     `git show <to>:path`, `git ls-tree <to>`, `git grep <to>` and that diff,
//     so everything it can reach is identical — minus later history, which it
//     never reads;
//   - the binary is called directly: the npm `ocr` wrapper spawns a
//     background self-update check on every run;
//   - the model endpoint is the loopback Codex bridge (bench/aacr/
//     codex_bridge.py), not a public API key. The result file also carries the
//     bridge's per-case counters under `bench`, which the scorer ignores.
//
// By default no PR title or description reaches OCR: reviewers/ocr.py passes
// no `--background`, and in range mode OCR reads no commit message. The
// equal-inputs switch (`prText`, src/bench/prtext.ts) hands OCR the title and
// body through `--background`; the report says which. (The QuickReview arm
// gets both, as production does.)

import { bridgeApiBase } from "./values.js";
import { finiteNumber as num } from "./values.js";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { safeId, type BenchCase, type PrefetchMeta } from "./aacr.js";
import { checkMergeBase, HARNESS_TIMEOUT_MIN } from "./armrun.js";
import { GIT_ISOLATION_ENV, run } from "./exec.js";
import { prTextFor } from "./prtext.js";
import { prepareTree } from "./runner.js";

/** The harness's OCR flags: reviewers/ocr.py `review_instance` defaults and
 * pipeline.py's `apply_defaults` (timeout None → 30; --max-tools 30). The
 * concurrency is ocr.py's own default — pipeline.py never passes one. */
export const OCR_HARNESS_DEFAULTS = {
  concurrency: 8,
  timeoutMin: HARNESS_TIMEOUT_MIN,
  maxTools: 30,
} as const;

export interface OcrFlags {
  concurrency: number;
  timeoutMin: number;
  maxTools: number;
}

/** reviewers/ocr.py `run_ocr_review`, flag for flag (never `--preview`).
 * `background` (the equal-inputs switch, src/bench/prtext.ts) rides OCR's own
 * `-b/--background` — "optional requirement/business context for the review";
 * absent, the argv is exactly the harness's. */
export function ocrReviewArgv(
  o: { repo: string; from: string; to: string; background?: string | null } & OcrFlags,
): string[] {
  return [
    "review",
    "--repo",
    o.repo,
    "--from",
    o.from,
    "--to",
    o.to,
    "--format",
    "json",
    "--audience",
    "agent",
    "--concurrency",
    String(o.concurrency),
    "--timeout",
    String(o.timeoutMin),
    "--max-tools",
    String(o.maxTools),
    ...(o.background ? ["--background", o.background] : []),
  ];
}

/** reviewers/ocr.py: `process_timeout = timeout_minutes * 60 + 300`. */
export function ocrProcessTimeoutMs(timeoutMin: number): number {
  return (timeoutMin * 60 + 300) * 1000;
}

/** The environment OCR runs with: its OpenAI-protocol endpoint is the
 * loopback bridge, whose bearer is a dummy (the real token never leaves the
 * bridge); no update check; git without any system/global config. */
export function ocrEnv(o: {
  path: string;
  home: string;
  tmpDir: string;
  bridgeUrl: string;
  model: string;
}): NodeJS.ProcessEnv {
  return {
    PATH: o.path,
    HOME: o.home,
    TMPDIR: o.tmpDir,
    LANG: "C.UTF-8",
    OCR_LLM_URL: bridgeApiBase(o.bridgeUrl),
    OCR_LLM_TOKEN: "loopback-bridge",
    OCR_LLM_MODEL: o.model,
    OCR_USE_ANTHROPIC: "false",
    OCR_NO_UPDATE: "1",
    ...GIT_ISOLATION_ENV,
  };
}

/** The comments the harness will score: evaluate.py
 * `build_target_comments_from_ocr` — `review` must be an object, and a
 * comment with blank `content` is skipped. */
export function scoredOcrComments(result: Record<string, unknown>): number {
  const review = result["review"];
  if (typeof review !== "object" || review === null || Array.isArray(review)) return 0;
  const comments = (review as Record<string, unknown>)["comments"];
  if (!Array.isArray(comments)) return 0;
  return comments.filter(
    (c) =>
      typeof c === "object" &&
      c !== null &&
      typeof (c as Record<string, unknown>)["content"] === "string" &&
      ((c as Record<string, unknown>)["content"] as string).trim() !== "",
  ).length;
}

/** OCR stdout is JSON when parseable, otherwise retained verbatim for diagnosis. */
function parseOcrStdout(stdout: string): unknown {
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    return stdout;
  }
}

/** reviewers/ocr.py `save_result`: the parsed JSON when stdout is JSON, else
 * the raw text (the scorer then reads zero comments — a failure costs the
 * case's references, as it does in the harness). `bench` is ours. */
export function ocrResultPayload(a: {
  c: BenchCase;
  startedAt: string;
  durationSeconds: number;
  exitCode: number;
  stdout: string;
  stderr: string;
  bench: Record<string, unknown>;
}): Record<string, unknown> {
  const review = parseOcrStdout(a.stdout);
  return {
    instance_id: a.c.instance_id,
    repo: a.c.repo,
    base_commit: a.c.base_commit,
    head_commit: a.c.head_commit,
    reviewer: "ocr",
    started_at: a.startedAt,
    duration_seconds: Math.round(a.durationSeconds * 100) / 100,
    ocr_exit_code: a.exitCode,
    ocr_format: "json",
    review,
    stderr: a.stderr,
    bench: a.bench,
  };
}

// ---- the bridge's counters ------------------------------------------------------

export interface BridgeStats {
  requests: number;
  ok: number;
  errors: number;
  upstream_refusals: number;
  input_tokens: number;
  cached_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  by_status: Record<string, number>;
  dropped_keys: Record<string, number>;
  model?: string;
  effort?: string;
  verbosity?: string;
}

const COUNTERS = [
  "requests",
  "ok",
  "errors",
  "upstream_refusals",
  "input_tokens",
  "cached_tokens",
  "output_tokens",
  "reasoning_tokens",
] as const;

export type BridgeUsage = Pick<BridgeStats, (typeof COUNTERS)[number]> & {
  by_status: Record<string, number>;
};

/** What one case cost at the bridge: after − before. Cases run one at a time,
 * so the difference is that case's traffic and nothing else's. `null` when
 * either snapshot is missing — never a guessed zero. */
export function bridgeDelta(
  before: BridgeStats | null,
  after: BridgeStats | null,
): BridgeUsage | null {
  if (!before || !after) return null;
  const out: BridgeUsage = {
    requests: 0,
    ok: 0,
    errors: 0,
    upstream_refusals: 0,
    input_tokens: 0,
    cached_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    by_status: {},
  };
  for (const k of COUNTERS) out[k] = (after[k] ?? 0) - (before[k] ?? 0);
  for (const [s, n] of Object.entries(after.by_status ?? {})) {
    const d = n - (before.by_status?.[s] ?? 0);
    if (d) out.by_status[s] = d;
  }
  return out;
}

// ---- one case ---------------------------------------------------------------------

export type OcrStatus = "ok" | "partial" | "failed" | "timeout" | "no-output";

export interface OcrFingerprint {
  qcr_commit: string;
  ocr_version: string;
  model: string;
  effort: string;
  flags: OcrFlags;
  /** Present only when the PR text was handed over (QCR_BENCH_PR_TEXT=1). */
  pr_text?: true;
  /** Present only on the API-key route (src/bench/auth.ts authFingerprint). */
  auth?: "api-key";
}

export interface OcrCaseSummary {
  instance_id: string;
  arm: "ocr";
  /** `partial`: OCR finished but some files errored (`completed_with_errors`)
   * — scored as is, like the harness does. */
  status: OcrStatus;
  error?: string;
  fingerprint: OcrFingerprint;
  ocr_status: string | null;
  exit_code: number | null;
  duration_seconds: number;
  /** Comments the scorer reads from the result file. */
  comments: number;
  files_reviewed: number | null;
  /** OCR's own summary (prompt tokens include cached ones, OpenAI style). */
  ocr_tokens: { input: number; output: number; total: number } | null;
  /** The bridge's count of the same traffic, from the backend's usage. */
  bridge: BridgeUsage | null;
  /** merge-base(base_commit, head) in the prepared tree = the prefetched one. */
  merge_base_ok: boolean;
  warnings: string[];
  /** With the PR-text switch on: whether this case's title/body reached OCR. */
  pr_text?: boolean;
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : fallback;
}

/** Status + OCR's own numbers from one finished process. The case's warnings
 * so far (the merge-base check's) stay ahead of OCR's own. */
export function summarizeOcrRun(a: {
  exitCode: number;
  timedOut: boolean;
  review: unknown;
  warnings?: readonly string[];
}): Pick<OcrCaseSummary, "status" | "ocr_status" | "files_reviewed" | "ocr_tokens" | "warnings"> {
  const r =
    typeof a.review === "object" && a.review !== null && !Array.isArray(a.review)
      ? (a.review as Record<string, unknown>)
      : null;
  const ocrStatus = r && typeof r["status"] === "string" ? r["status"] : null;
  const s =
    r && typeof r["summary"] === "object" && r["summary"] !== null
      ? (r["summary"] as Record<string, unknown>)
      : null;
  const warnings = Array.isArray(r?.["warnings"])
    ? (r["warnings"] as Array<Record<string, unknown> | null>).map((w) =>
        `${str(w?.["type"], "warning")} ${str(w?.["file"])}: ${str(w?.["message"])}`
          .trim()
          .slice(0, 300),
      )
    : [];
  const status: OcrStatus = a.timedOut
    ? "timeout"
    : a.exitCode !== 0
      ? "failed"
      : r === null
        ? "no-output"
        : ocrStatus === "completed_with_errors"
          ? "partial"
          : "ok";
  return {
    status,
    ocr_status: ocrStatus,
    files_reviewed: s ? num(s["files_reviewed"]) : null,
    ocr_tokens: s
      ? {
          input: num(s["input_tokens"]),
          output: num(s["output_tokens"]),
          total: num(s["total_tokens"]),
        }
      : null,
    warnings: [...(a.warnings ?? []), ...[...new Set(warnings)].slice(0, 20)],
  };
}

export interface OcrRunnerOptions {
  /** The image's production tree; cases are materialised under `<root>/wt`
   * (a disk-backed anonymous volume), as the QuickReview arm's are. */
  root: string;
  store: string;
  outDir: string;
  ocrBin: string;
  bridgeUrl: string;
  model: string;
  flags: OcrFlags;
  fingerprint: OcrFingerprint;
  keepTree?: boolean;
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
  /** Hand OCR the PR title/body through `--background` (src/bench/prtext.ts). */
  prText?: boolean;
}

/** One call to the loopback Codex bridge (`/label`, `/stats`): GET without a
 * body, POST with one; any failure — refused, timed out, non-2xx — is null,
 * never a throw. */
export async function bridgeCall(
  o: Pick<OcrRunnerOptions, "bridgeUrl" | "fetchImpl">,
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

/** A case's summary before anything is known: failed, nothing measured. */
function blankOcrSummary(c: BenchCase, fingerprint: OcrFingerprint): OcrCaseSummary {
  return {
    instance_id: c.instance_id,
    arm: "ocr",
    status: "failed",
    fingerprint,
    ocr_status: null,
    exit_code: null,
    duration_seconds: 0,
    comments: 0,
    files_reviewed: null,
    ocr_tokens: null,
    bridge: null,
    merge_base_ok: false,
    warnings: [],
  };
}

export function writeOcrResult(
  outDir: string,
  c: BenchCase,
  payload: Record<string, unknown>,
): void {
  const dir = join(outDir, "results", "all");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${safeId(c.instance_id)}.json`),
    JSON.stringify(payload, null, 2) + "\n",
  );
}

/** The per-attempt diagnostics a case dir holds beside its summary. */
const OCR_ATTEMPT_FILES = ["ocr-argv.json", "ocr-stdout.json", "ocr-stderr.log"] as const;

/** Review one case with OCR and write its result file. Never throws for a
 * case that fails — a failure is a recorded outcome with an empty result. */
export async function reviewCaseOcr(
  c: BenchCase,
  meta: PrefetchMeta,
  o: OcrRunnerOptions,
): Promise<OcrCaseSummary> {
  const log = o.log ?? (() => {});
  const safe = safeId(c.instance_id);
  const caseDir = join(o.outDir, "cases", safe);
  const tree = join(o.root, "wt", safe);
  const tmpDir = join(o.root, "wt", `${safe}.tmp`);
  mkdirSync(caseDir, { recursive: true });
  // A failure before this attempt writes its argv must not leave an earlier one's.
  for (const f of OCR_ATTEMPT_FILES) rmSync(join(caseDir, f), { force: true });
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const summary = blankOcrSummary(c, o.fingerprint);
  let stdout = "";
  let stderr = "";
  try {
    await prepareTree(join(o.store, safe), tree, meta);
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
    const env = ocrEnv({
      path: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      home: process.env.HOME ?? "/tmp",
      tmpDir,
      bridgeUrl: o.bridgeUrl,
      model: o.model,
    });
    const mb = await checkMergeBase(run, tree, c, meta, env);
    summary.merge_base_ok = mb.ok;
    if (mb.warning) summary.warnings.push(mb.warning);
    const background = prTextFor(meta, o.prText === true);
    if (o.prText) summary.pr_text = background !== null;
    const argv = ocrReviewArgv({
      repo: tree,
      from: c.base_commit,
      to: c.head_commit,
      ...o.flags,
      background,
    });
    writeFileSync(
      join(caseDir, "ocr-argv.json"),
      JSON.stringify([o.ocrBin, ...argv], null, 2) + "\n",
    );
    await bridgeCall(o, "/label", { label: c.instance_id });
    const before = (await bridgeCall(o, "/stats")) as BridgeStats | null;
    log(
      `ocr: ${c.instance_id} — ${meta.diff.files} files, ${o.ocrBin} ${argv.slice(0, 7).join(" ")} …`,
    );
    const r = await run(o.ocrBin, argv, {
      cwd: tree,
      env,
      timeoutMs: ocrProcessTimeoutMs(o.flags.timeoutMin),
    });
    const after = (await bridgeCall(o, "/stats")) as BridgeStats | null;
    await bridgeCall(o, "/label", { label: "" });
    stdout = r.stdout;
    stderr = r.stderr;
    summary.exit_code = r.code;
    summary.bridge = bridgeDelta(before, after);
    const review = parseOcrStdout(stdout);
    Object.assign(
      summary,
      summarizeOcrRun({
        exitCode: r.code,
        timedOut: r.timedOut,
        review,
        warnings: summary.warnings,
      }),
    );
    if (summary.status === "failed" || summary.status === "timeout")
      summary.error = (stderr.trim() || stdout.trim()).slice(-1500);
  } catch (err) {
    summary.status = "failed";
    summary.error = String(err instanceof Error ? err.message : err).slice(0, 2000);
    log(`ocr: ${c.instance_id} FAILED — ${summary.error}`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    if (!o.keepTree) rmSync(tree, { recursive: true, force: true });
  }
  summary.duration_seconds = Math.round((Date.now() - started) / 1000);
  writeFileSync(join(caseDir, "ocr-stdout.json"), stdout);
  writeFileSync(join(caseDir, "ocr-stderr.log"), stderr);
  const payload = ocrResultPayload({
    c,
    startedAt,
    durationSeconds: (Date.now() - started) / 1000,
    exitCode: summary.exit_code ?? -1,
    stdout,
    stderr,
    bench: { status: summary.status, bridge: summary.bridge, fingerprint: o.fingerprint },
  });
  summary.comments = scoredOcrComments(payload);
  writeOcrResult(o.outDir, c, payload);
  writeFileSync(join(caseDir, "case-summary.json"), JSON.stringify(summary, null, 2) + "\n");
  log(
    `ocr: ${c.instance_id} ${summary.status} — ${summary.comments} comment(s), ${summary.duration_seconds}s` +
      (summary.bridge
        ? `, ${summary.bridge.requests} model call(s) (${summary.bridge.errors} failed), ${summary.bridge.input_tokens} in/${summary.bridge.output_tokens} out`
        : ""),
  );
  return summary;
}

/** A case with no prefetched store: recorded as failed WITH an empty result
 * file, so its references count against recall instead of vanishing from
 * both denominators. */
export function unprefetchedOcrCase(
  outDir: string,
  c: BenchCase,
  fingerprint: OcrFingerprint,
  error: string,
): OcrCaseSummary {
  const summary: OcrCaseSummary = { ...blankOcrSummary(c, fingerprint), error };
  const caseDir = join(outDir, "cases", safeId(c.instance_id));
  mkdirSync(caseDir, { recursive: true });
  // An earlier attempt's invocation and output would read as this one's.
  for (const f of OCR_ATTEMPT_FILES) rmSync(join(caseDir, f), { force: true });
  writeFileSync(join(caseDir, "case-summary.json"), JSON.stringify(summary, null, 2) + "\n");
  writeOcrResult(
    outDir,
    c,
    ocrResultPayload({
      c,
      startedAt: new Date().toISOString(),
      durationSeconds: 0,
      exitCode: -1,
      stdout: "",
      stderr: error,
      bench: { status: "failed", bridge: null, fingerprint },
    }),
  );
  return summary;
}

export function readOcrSummary(outDir: string, c: BenchCase): OcrCaseSummary | null {
  const p = join(outDir, "cases", safeId(c.instance_id), "case-summary.json");
  if (!existsSync(p)) return null;
  const s = JSON.parse(readFileSync(p, "utf8")) as Partial<OcrCaseSummary>;
  return s.arm === "ocr" ? (s as OcrCaseSummary) : null;
}

/** Every arm a run dir can hold, as its run.json `reviewer` names it (a
 * QuickReview run names none). */
const ARM_NAMES = {
  qcr: "a QuickReview",
  ocr: "an open-code-review",
  codex: "a Codex CLI",
  opencode: "an OpenCode",
  claude: "a Claude Code",
  pireview: "a pi-review",
  pragent: "a PR-Agent",
} as const;

export type ArmName = keyof typeof ARM_NAMES;

/** A command of one arm refuses another arm's run dir: the QuickReview
 * `review`/`results` rewrite every variant's result files, which would wipe an
 * OCR run's scored input. A dir with no run.json yet belongs to anyone. */
export function assertArm(outDir: string, arm: ArmName): void {
  const found = runArmOf(outDir);
  if (found !== null && found !== arm)
    throw new Error(
      `${outDir} is ${ARM_NAMES[found]} run — this command belongs to ${ARM_NAMES[arm]} arm (bench.sh --arm ${found})`,
    );
}

/** The arm a run dir holds, from its run.json's `reviewer` (one of ARM_NAMES;
 * a QuickReview run carries none, and an unknown one reads as QuickReview);
 * `null` when there is no readable run.json yet. */
export function runArmOf(outDir: string): ArmName | null {
  const p = join(outDir, "run.json");
  if (!existsSync(p)) return null;
  try {
    const r = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    const v = r["reviewer"];
    return typeof v === "string" && Object.hasOwn(ARM_NAMES, v) ? (v as ArmName) : "qcr";
  } catch {
    return null;
  }
}

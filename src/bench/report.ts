// The AACR-Bench run report: the scorer's numbers per variant, then per case
// what the reviewer did — so a number is never read without what produced it.

import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { datasetPin, safeId, VARIANTS, type BenchCase, type CaseSet } from "./aacr.js";
import { readOcrSummary } from "./ocr.js";
import type { CaseSummary } from "./runner.js";

interface Metrics {
  summary: Record<string, number>;
}

/** One variant dir's metrics files as the harness names them: one per judge
 * round (`_round_<r>`, or bare when the eval ran a single round — round 1),
 * plus an `_average` file when it ran several. Rounds first round first. The
 * one reader of the naming, for every report. */
export function metricsFiles(
  dir: string,
  /** The harness reader the eval ran with (`--reviewer`): ocr, or claude for
   * the Claude Code arm. */
  reviewer = "ocr",
): { rounds: Array<{ round: number; file: string }>; average: string | null } {
  if (!existsSync(dir)) return { rounds: [], average: null };
  const names = readdirSync(dir)
    .filter((n) => n.startsWith(`metrics_${reviewer}_`) && n.endsWith(".json"))
    .sort();
  let average: string | null = null;
  const rounds: Array<{ round: number; file: string }> = [];
  for (const n of names) {
    if (n.includes("average")) {
      average ??= join(dir, n);
      continue;
    }
    const r = /_round_(\d+)\.json$/.exec(n);
    rounds.push({ round: r ? Number(r[1]) : 1, file: join(dir, n) });
  }
  rounds.sort((a, b) => a.round - b.round || a.file.localeCompare(b.file));
  return { rounds, average };
}

/** The number to report for a variant: the multi-round average, else the
 * last round's. */
export function latestMetrics(dir: string): Metrics | null {
  const { rounds, average } = metricsFiles(dir);
  const pick = average ?? rounds.at(-1)?.file;
  if (!pick) return null;
  return JSON.parse(readFileSync(pick, "utf8")) as Metrics;
}

/** The harness scored the result files as they were: once one changes or
 * goes, every metrics file beside it is a score of findings that no longer
 * exist. They go (as the eval step's own `rm -f metrics_*.json` does), so a
 * report before the next eval shows no score rather than a stale one.
 * Returns the names removed. */
export function dropMetricsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const stale = readdirSync(dir).filter((n) => n.startsWith("metrics_") && n.endsWith(".json"));
  for (const f of stale) rmSync(join(dir, f), { force: true });
  return stale;
}

/** Agent-produced reference labels (`sets/<set>.labels.json`, no human check): per instance, one
 * entry per dataset reference in dataset order, saying whether the reference
 * names a real issue. The score counts a match on a dubious reference the same
 * as one on a real defect; this is how the report tells the two apart. */
export interface ReferenceLabel {
  reality: "real-defect" | "real-maintainability" | "trivial" | "dubious" | "duplicate";
  value?: "high" | "medium" | "low";
  path: string;
  from_line: number | null;
}
export interface ReferenceLabels {
  source: string;
  labels: Record<string, (ReferenceLabel | null)[]>;
}

export function parseReferenceLabels(raw: unknown): ReferenceLabels {
  const o = raw as { source?: unknown; labels?: unknown };
  if (!o || typeof o.labels !== "object" || o.labels === null)
    throw new Error("labels file: missing `labels`");
  return { source: String(o.source ?? ""), labels: o.labels as ReferenceLabels["labels"] };
}

const QUALITY_CLASSES = [
  "real, high/medium value",
  "real, low value",
  "trivial",
  "dubious",
  "duplicate",
  "unlabelled",
] as const;
type QualityClass = (typeof QUALITY_CLASSES)[number];

function qualityClass(l: ReferenceLabel | null | undefined): QualityClass {
  if (!l) return "unlabelled";
  if (l.reality === "real-defect" || l.reality === "real-maintainability")
    return l.value === "low" ? "real, low value" : "real, high/medium value";
  return l.reality;
}

interface RoundFile {
  eval_res: {
    instance_id: string;
    comments: { path: string; from_line: number | null; semantic_match: boolean }[];
  }[];
}

/** Matched references per quality class, averaged over the judge rounds of one
 * variant. A label whose path/line no longer lines up with the reference it
 * was written for counts as unlabelled rather than as the wrong class. */
export function recallByQuality(
  dir: string,
  labels: ReferenceLabels,
  instances: string[],
): { cls: QualityClass; total: number; matched: number }[] | null {
  if (!existsSync(dir)) return null;
  // One file per round; the average file is not a round.
  const rounds = metricsFiles(dir).rounds.map(
    (r) => JSON.parse(readFileSync(r.file, "utf8")) as RoundFile,
  );
  if (!rounds.length) return null;
  const total = new Map<QualityClass, number>();
  const matched = new Map<QualityClass, number>();
  let first = true;
  for (const r of rounds) {
    for (const e of r.eval_res) {
      if (!instances.includes(e.instance_id)) continue;
      const ls = labels.labels[e.instance_id] ?? [];
      e.comments.forEach((c, k) => {
        const l = ls[k];
        const aligned = l && l.path === c.path && l.from_line === c.from_line ? l : null;
        const cls = qualityClass(aligned);
        if (first) total.set(cls, (total.get(cls) ?? 0) + 1);
        if (c.semantic_match) matched.set(cls, (matched.get(cls) ?? 0) + 1);
      });
    }
    first = false;
  }
  return QUALITY_CLASSES.filter((c) => total.has(c)).map((cls) => ({
    cls,
    total: total.get(cls) ?? 0,
    matched: (matched.get(cls) ?? 0) / rounds.length,
  }));
}

function readSummary(outDir: string, c: BenchCase): CaseSummary | null {
  const p = join(outDir, "cases", safeId(c.instance_id), "case-summary.json");
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as CaseSummary) : null;
}

/** A scorer count for a report cell: an averaged count is written as a float
 * (`10.0`) and shows as the integer, a fraction to two places, a missing one
 * as `?`. */
export function metricNumber(v: number | undefined): string {
  return v === undefined
    ? "?"
    : Number.isInteger(v)
      ? String(v)
      : String(Math.round(v * 100) / 100);
}
const n = metricNumber;

/** Tool-call counts as "name n, name n", most-used first. */
export function formatToolCounts(tools: Record<string, number>): string {
  return Object.entries(tools)
    .sort((x, y) => y[1] - x[1])
    .map(([t, m]) => `${t} ${m}`)
    .join(", ");
}

/** A token count in thousands, for a report cell. */
export function kTokens(x: number): string {
  return `${Math.round(x / 1000)}k`;
}

/** What a case summary says went wrong, for a report's warnings section. */
export interface CaseDiagnostics {
  instance_id: string;
  status: string;
  merge_base_ok: boolean;
  error?: string;
  warnings: string[];
}

/** A warnings section's lines: every case with an error, a warning or a
 * failed merge-base check (a failed case's merge-base is not news), its error
 * flattened and capped. Nothing when there is none. */
export function caseWarningLines(cases: readonly CaseDiagnostics[]): string[] {
  const L: string[] = [];
  for (const s of cases) {
    if (!s.warnings.length && !s.error && s.merge_base_ok) continue;
    if (!s.merge_base_ok && s.status !== "failed")
      L.push(`- \`${s.instance_id}\`: merge-base check failed — see case-summary.json`);
    for (const w of [
      ...(s.error ? [s.error.replaceAll("\n", " ").slice(0, 400)] : []),
      ...s.warnings,
    ])
      L.push(`- \`${s.instance_id}\`: ${w}`);
  }
  return L;
}

/** The scores table's header, then one row per variant or round. */
export const SCORE_TABLE_HEAD = [
  "| Round | Evaluated | Generated | Matched | Precision | Recall | F1 | Line P | Line R |",
  "|---|---|---|---|---|---|---|---|---|",
] as const;

/** The report's dataset line: what the set's registered pin denominates its
 * numbers in (an unregistered dataset says so), its commit, and the cases
 * and references this report covers. */
export function datasetLine(set: CaseSet, cases: readonly BenchCase[]): string {
  const pin = datasetPin(set.dataset);
  return `- Dataset: ${pin ? pin.denomination : "an unregistered dataset"} (\`${set.dataset.commit.slice(0, 7)}\`), ${cases.length} PRs, ${cases.reduce((a, c) => a + c.references, 0)} reference comments`;
}

/** What a report over any other dataset measures: the same reference-matching
 * score, without AACR-Bench's own reference population. */
const REFERENCE_REPORT_PREAMBLE =
  "_What this measures: how closely the review reproduces the dataset's reference comments at the same lines (±1), as judged by a model. A comment that is not a reference counts against precision even when it is a real bug. It is not a defect count. Details: bench/aacr/METRICS.md and bench/aacr/EXTERNAL-BENCHMARKS.md._";

/** The preamble that opens a run report: AACR-Bench's, with its reference
 * population, for an AACR-Bench set; the plain reference-matching caveat for
 * any other. */
export function reportPreamble(set: CaseSet): string {
  return isAacrSet(set) ? AACR_REPORT_PREAMBLE : REFERENCE_REPORT_PREAMBLE;
}

/** Is the set AACR-Bench's own — the one reference population the reports'
 * AACR facts (who wrote the references, what they are about) describe? */
function isAacrSet(set: CaseSet): boolean {
  return datasetPin(set.dataset)?.id === "aacr-v1";
}

/** What an AACR-Bench report measures — opens every report over an
 * AACR-Bench set (bench/aacr/METRICS.md). */
export const AACR_REPORT_PREAMBLE =
  "_What this measures: how closely the review reproduces AACR-Bench's reference comments (74% AI-written; 47% code defect, 42% maintainability and readability) at the same lines (±1), as judged by a model. A comment that is not a reference counts against precision even when it is a real bug, and most references are not defects — in a hand check of 253 on 30 PRs, 11% were real defects and 8% real maintainability issues. It is the cross-check against published numbers, not a defect count: the defect benchmark (`bench.sh judge`) is. Details: bench/aacr/METRICS.md._";

/** The run report: the scorer's numbers per variant, then per case what the
 * reviewer did, so a number is never read without what produced it. */
export function renderReport(
  set: CaseSet,
  outDir: string,
  cases: BenchCase[],
  labels?: ReferenceLabels,
): string {
  const L: string[] = [];
  const run = existsSync(join(outDir, "run.json"))
    ? JSON.parse(readFileSync(join(outDir, "run.json"), "utf8"))
    : {};
  const judgeFile = join(outDir, "judge.txt");
  const judge = existsSync(judgeFile)
    ? readFileSync(judgeFile, "utf8").trim().split("\n")
    : ["not run"];
  const summaries = cases.map((c) => ({ c, s: readSummary(outDir, c) }));
  L.push(`# AACR-Bench run — ${set.name}`);
  L.push("");
  L.push(reportPreamble(set));
  L.push("");
  L.push(datasetLine(set, cases));
  L.push(
    `- Reviewer: QuickReview \`${String(run.qcr_commit ?? "?").slice(0, 10)}\`, profile \`${run.profile || "(generic)"}\`, conversation model \`${run.models?.conversation ?? "?"}\`, pi ${run.pi ?? "?"}`,
  );
  if (Array.isArray(run.resumes) && run.resumes.length)
    L.push(
      `- Resumed ${run.resumes.length} time(s); cases reviewed by a different build were re-run.`,
    );
  L.push(`- Judge: ${judge[0] ?? ""}`);
  for (const w of judge.slice(1)) L.push(`  ${w}`);
  const verdicts = { APPROVE: 0, REQUEST_CHANGES: 0, other: 0 };
  for (const { s } of summaries) {
    if (!s) continue;
    if (s.verdict === "APPROVE") verdicts.APPROVE++;
    else if (s.verdict === "REQUEST_CHANGES") verdicts.REQUEST_CHANGES++;
    else verdicts.other++;
  }
  L.push(
    `- Verdicts: ${verdicts.REQUEST_CHANGES} REQUEST_CHANGES, ${verdicts.APPROVE} APPROVE, ${verdicts.other} none. ` +
      "(On an APPROVE with green CI, production's approve route posts findings as body bullets, not inline comments; the bench scores the review as composed with its inline comments — production's COMMENT path.)",
  );
  const degraded = summaries.filter(({ s }) => s && !s.pr_meta.title && !s.pr_meta.body);
  if (degraded.length)
    L.push(
      `- Reviewed WITHOUT the PR title/description (API unavailable at prefetch — no pass-intent, unlike production): ${degraded.map(({ c }) => `\`${c.instance_id}\``).join(", ")}`,
    );
  L.push("");
  L.push("## Scores (the AACR harness, OCR result shape)");
  L.push("");
  L.push(
    "| Variant | Evaluated | Generated | Matched | Precision | Recall | F1 | Line P | Line R |",
  );
  L.push("|---|---|---|---|---|---|---|---|---|");
  for (const v of Object.keys(VARIANTS)) {
    const m = latestMetrics(join(outDir, "results", v));
    if (!m) {
      L.push(`| ${v} | — | — | — | — | — | — | — | — |`);
      continue;
    }
    L.push(scoreRow(v, m.summary, cases.length));
  }
  if (labels) {
    const ids = cases.map((c) => c.instance_id);
    const rows = Object.keys(VARIANTS).map((v) => ({
      v,
      q: recallByQuality(join(outDir, "results", v), labels, ids),
    }));
    const classes = QUALITY_CLASSES.filter((cls) =>
      rows.some((r) => r.q?.some((x) => x.cls === cls)),
    );
    if (classes.length) {
      L.push("");
      L.push("## Recall by reference quality");
      L.push("");
      L.push(
        `Each reference checked against the code by agents, no human check (${labels.source}). A match on a dubious reference scores the same as one on a real defect; the first column is the one that says whether the review got better.`,
      );
      L.push("");
      L.push(`| Variant | ${classes.map((c) => c).join(" | ")} |`);
      L.push(`|---|${classes.map(() => "---").join("|")}|`);
      for (const { v, q } of rows) {
        if (!q) continue;
        L.push(
          `| ${v} | ${classes
            .map((cls) => {
              const x = q.find((y) => y.cls === cls);
              return x ? `${n(x.matched)}/${x.total}` : "—";
            })
            .join(" | ")} |`,
        );
      }
    }
  }
  L.push("");
  L.push("## Per case");
  L.push("");
  L.push(
    "| Case | Lang | Refs | Status | Verdict | Posted (b/q/n/other) | In body | LEFT excl. | Lenses planned → ran | Minutes | Tokens in/out |",
  );
  L.push("|---|---|---|---|---|---|---|---|---|---|---|");
  let left = 0;
  let reanchored = 0;
  for (const { c, s } of summaries) {
    if (!s) {
      L.push(`| ${c.instance_id} | ${c.language} | ${c.references} | not run | | | | | | | |`);
      continue;
    }
    left += s.comments.left_side;
    reanchored += s.comments.reanchored ?? 0;
    const t = s.comments.by_tag;
    L.push(
      `| ${c.instance_id} | ${c.language} | ${c.references} | ${s.status}${s.continued ? " (continued)" : ""} | ${s.verdict ?? "—"} | ${t["blocker"] ?? 0}/${t["question"] ?? 0}/${t["nit"] ?? 0}/${t["other"] ?? 0} | ${s.comments.body ?? 0} | ${s.comments.left_side} | ${s.planned_lenses.length} → ${s.executed_passes.length} | ${(s.duration_seconds / 60).toFixed(1)} | ${kTokens(s.usage.input + s.usage.cacheRead)}/${kTokens(s.usage.output)} |`,
    );
  }
  const warned = summaries.filter(
    (x): x is { c: BenchCase; s: CaseSummary } =>
      x.s !== null && ((x.s.warnings ?? []).length > 0 || Boolean(x.s.error)),
  );
  if (warned.length) {
    L.push("");
    L.push("## Warnings (pi stderr, case errors)");
    L.push("");
    for (const { c, s } of warned) {
      for (const w of [...(s.error ? [s.error] : []), ...(s.warnings ?? [])])
        L.push(`- \`${c.instance_id}\`: ${w}`);
    }
  }
  L.push("");
  L.push(
    `Reading the numbers: precision counts every posted head-side comment against the dataset's references, so a real issue the annotators did not record scores as a false positive. ${reanchored} comment(s) anchored on a deleted line were moved to the head side of their hunk and scored there; ${left} LEFT-side (old-code) comment(s) that could not be moved were excluded — the harness forces every generated comment to the right side, so an old-side anchor could only score wrong. ${isAacrSet(set) ? "The references are 74% AI-authored and 42% maintainability/readability — compare" : "Compare"} variants, not just the headline. Published leaderboard rows used an undisclosed judge; only a baseline re-run under this judge is a like-for-like comparison.`,
  );
  L.push("");
  return L.join("\n");
}

// ---- the open-code-review baseline arm -------------------------------------------

/** Every round's metrics file, in round order, plus the average when the
 * harness wrote one. A round's number is exact; the average is a float. */
export function roundMetrics(
  dir: string,
  /** The harness reader the eval ran with (`--reviewer`): ocr, or claude for
   * the Claude Code arm. */
  reviewer = "ocr",
): {
  rounds: Array<{ round: number; summary: Record<string, number> }>;
  average: Record<string, number> | null;
} {
  const files = metricsFiles(dir, reviewer);
  const read = (f: string): Record<string, number> =>
    (JSON.parse(readFileSync(f, "utf8")) as Metrics).summary;
  return {
    rounds: files.rounds.map((r) => ({ round: r.round, summary: read(r.file) })),
    average: files.average === null ? null : read(files.average),
  };
}

/** One scores-table row: a variant or a judge round. */
export function scoreRow(label: string, s: Record<string, number>, cases: number): string {
  return `| ${label} | ${n(s["evaluated_instances"])}/${cases} | ${n(s["generated_notes"])} | ${n(s["matched_semantic_notes"])}/${n(s["expected_notes"])} | ${s["semantic_match_rate"]} | ${s["semantic_recall_rate"]} | ${s["semantic_f1"]} | ${s["line_match_rate"]} | ${s["line_recall_rate"]} |`;
}

/** The AACR score table of an arm's run: the header, the average, then every
 * judge round (from `roundMetrics`); one dash row when nothing was scored. */
export function aacrScoreTable(m: ReturnType<typeof roundMetrics>, cases: number): string[] {
  const L: string[] = [...SCORE_TABLE_HEAD];
  if (m.average) L.push(scoreRow("**average**", m.average, cases));
  for (const r of m.rounds) L.push(scoreRow(String(r.round), r.summary, cases));
  if (!m.average && m.rounds.length === 0) L.push("| — | — | — | — | — | — | — | — | — |");
  return L;
}

/** The OCR arm's report: the harness's numbers (average and every round),
 * then per case what OCR did and what it cost at the bridge. */
export function renderOcrReport(set: CaseSet, outDir: string, cases: BenchCase[]): string {
  const L: string[] = [];
  const run = existsSync(join(outDir, "run.json"))
    ? JSON.parse(readFileSync(join(outDir, "run.json"), "utf8"))
    : {};
  const judgeFile = join(outDir, "judge.txt");
  const judge = existsSync(judgeFile)
    ? readFileSync(judgeFile, "utf8").trim().split("\n")
    : ["not run"];
  const summaries = cases.map((c) => ({ c, s: readOcrSummary(outDir, c) }));
  const flags = run.flags ?? {};
  L.push(`# AACR-Bench run — ${set.name} — open-code-review baseline`);
  L.push("");
  L.push(reportPreamble(set));
  L.push("");
  L.push(datasetLine(set, cases));
  L.push(
    `- Reviewer: ${run.ocr_version ?? "open-code-review ?"}, run as the AACR harness's reviewers/ocr.py runs it: \`ocr review --from <base_commit> --to <head_commit> --format json --audience agent --concurrency ${flags.concurrency ?? "?"} --timeout ${flags.timeout_min ?? "?"} --max-tools ${flags.max_tools ?? "?"}${run.pr_text === true ? " --background <PR title/description>" : ""}\` (range = merge-base..head; ${run.pr_text === true ? "PR title/description through --background, the equal-inputs switch — the harness itself passes none" : "no PR title/description — the harness passes none"})`,
  );
  if (run.pr_text === true) {
    const without = summaries.filter(({ s }) => s?.pr_text === false);
    if (without.length > 0) {
      L.push(
        `- Reviewed WITHOUT the PR title/description (none prefetched): ${without.map(({ c }) => `\`${c.instance_id}\``).join(", ")}`,
      );
    }
  }
  L.push(
    `- Model: \`${run.model ?? "?"}\`, reasoning effort \`${run.effort ?? "?"}\`, text verbosity \`${run.verbosity ?? "?"}\` — ${typeof run.endpoint === "string" ? run.endpoint : "ChatGPT Codex backend via the loopback bridge (bench/aacr/codex_bridge.py)"}: OCR's Chat Completions calls → streamed Responses`,
  );
  L.push(`- Judge: ${judge[0] ?? ""}`);
  for (const w of judge.slice(1)) L.push(`  ${w}`);
  L.push("");
  L.push("## Scores (the AACR harness, OCR reader)");
  L.push("");
  L.push(...aacrScoreTable(roundMetrics(join(outDir, "results", "all")), cases.length));
  L.push("");
  L.push("## Per case");
  L.push("");
  L.push(
    "| Case | Lang | Refs | Status | Comments | Files reviewed | Minutes | OCR tokens in/out | Model calls (failed) | Backend tokens in (cached) / out (reasoning) |",
  );
  L.push("|---|---|---|---|---|---|---|---|---|---|");
  const k = kTokens;
  const tot = {
    calls: 0,
    errors: 0,
    inp: 0,
    cached: 0,
    out: 0,
    reasoning: 0,
    secs: 0,
    oin: 0,
    oout: 0,
    /** Ran cases whose OCR tokens / bridge counts were not measured. */
    noOcr: 0,
    noBridge: 0,
  };
  for (const { c, s } of summaries) {
    if (!s) {
      L.push(`| ${c.instance_id} | ${c.language} | ${c.references} | not run | | | | | | |`);
      continue;
    }
    const b = s.bridge;
    tot.secs += s.duration_seconds;
    if (s.ocr_tokens) {
      tot.oin += s.ocr_tokens.input;
      tot.oout += s.ocr_tokens.output;
    } else tot.noOcr++;
    if (!b) tot.noBridge++;
    if (b) {
      tot.calls += b.requests;
      tot.errors += b.errors;
      tot.inp += b.input_tokens;
      tot.cached += b.cached_tokens;
      tot.out += b.output_tokens;
      tot.reasoning += b.reasoning_tokens;
    }
    L.push(
      `| ${c.instance_id} | ${c.language} | ${c.references} | ${s.status}${s.ocr_status && s.ocr_status !== "success" ? ` (${s.ocr_status})` : ""} | ${s.comments} | ${s.files_reviewed ?? "?"} | ${(s.duration_seconds / 60).toFixed(1)} | ${s.ocr_tokens ? `${k(s.ocr_tokens.input)}/${k(s.ocr_tokens.output)}` : "?"} | ${b ? `${b.requests} (${b.errors})` : "?"} | ${b ? `${k(b.input_tokens)} (${k(b.cached_tokens)}) / ${k(b.output_tokens)} (${k(b.reasoning_tokens)})` : "?"} |`,
    );
  }
  const ran = summaries.filter((x) => x.s).length;
  // A total over cases some of which were never measured is a lower bound,
  // and says so; over none, it is unknown — never a zero.
  const total = (cell: string, unmeasured: number): string =>
    unmeasured === ran ? "?" : unmeasured ? `≥ ${cell} (${unmeasured} unmeasured)` : cell;
  if (ran)
    L.push(
      `| **total** | | ${cases.reduce((a, c) => a + c.references, 0)} | | ${summaries.reduce((a, x) => a + (x.s?.comments ?? 0), 0)} | | ${(tot.secs / 60).toFixed(1)} (avg ${(tot.secs / 60 / ran).toFixed(1)}) | ${total(`${k(tot.oin)}/${k(tot.oout)}`, tot.noOcr)} | ${total(`${tot.calls} (${tot.errors})`, tot.noBridge)} | ${total(`${k(tot.inp)} (${k(tot.cached)}) / ${k(tot.out)} (${k(tot.reasoning)})`, tot.noBridge)} |`,
    );
  const warnings = caseWarningLines(
    summaries.flatMap((x) => (x.s ? [{ ...x.s, instance_id: x.c.instance_id }] : [])),
  );
  if (warnings.length) L.push("", "## Warnings (OCR warnings, case errors)", "", ...warnings);
  L.push("");
  L.push(
    "Reading the numbers: OCR's comments carry no severity tag, so only the `all` variant exists for this arm — compare it with the QuickReview arm's `all` row. OCR tokens are OCR's own summary (prompt tokens, cached included); the backend columns are the bridge's count of the same calls from the backend's usage (reasoning tokens are part of output). Precision counts every comment against the dataset's references, so a real issue the annotators did not record scores as a false positive.",
  );
  L.push("");
  return L.join("\n");
}

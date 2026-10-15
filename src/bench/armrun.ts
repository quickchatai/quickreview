// What the third-party arms' runs share around their own case runners (the
// Codex CLI, OCR, OpenCode and pi-review arms): setting a run dir up for a new
// configuration, the run record's lifecycle fields, the harness's time
// budget, the prepared tree's merge-base check and the AACR score table.

import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { safeId, type BenchCase, type PrefetchMeta } from "./aacr.js";
import type { ExecOptions, ExecResult } from "./exec.js";
import type { roundMetrics } from "./report.js";

/** reviewers/codex.py `run_codex_review`: `process_timeout = timeout_minutes
 * * 60 + 60` — the budget the harness gives its CLI reviewers, which the arms
 * run in the shape of. */
export function harnessProcessTimeoutMs(timeoutMin: number): number {
  return (timeoutMin * 60 + 60) * 1000;
}

/** The harness scored the result files as they were; a rewritten or removed
 * one makes every metrics file beside them a score of findings that no longer
 * exist. They go (as the eval step's own `rm -f metrics_*.json` does), so a
 * report before the next eval shows no score rather than a stale one.
 * Returns how many went. */
export function dropStaleMetrics(
  resultsDir: string,
  log: (line: string) => void,
  who: string,
  what: string,
): number {
  if (!existsSync(resultsDir)) return 0;
  const stale = readdirSync(resultsDir).filter(
    (n) => n.startsWith("metrics_") && n.endsWith(".json"),
  );
  for (const f of stale) rmSync(join(resultsDir, f), { force: true });
  if (stale.length)
    log(
      `${who}: ${stale.length} metrics file(s) scored the old results — removed; re-run eval to score ${what}`,
    );
  return stale.length;
}

/** The case-dir files the defect judge reads beside a case's result
 * (defects.ts `reviewForJudge`): a case no longer in the run takes them too. */
export const JUDGE_INPUT_FILES = ["review.md", "comments.json"] as const;

export interface ArmCasePrep {
  /** Call before a case is reviewed (again): its result file is about to be
   * rewritten, so the run's metrics go — once. */
  beforeReview(): void;
  /** The cases whose earlier review was dropped for another configuration. */
  dropped: string[];
}

/**
 * A run dir set up for the run.json about to carry `fingerprint`: no case
 * reviewed under another configuration may stay a result of the run. Without
 * --resume every case goes; with it, every case whose recorded fingerprint
 * differs goes now, not when the loop reaches it — a stop partway
 * (AuthExpiring) must leave those cases incomplete, never scored under the new
 * label. The run's metrics go with the first result removed or rewritten; a
 * resume that keeps every case keeps them.
 */
export function prepareArmCases(o: {
  outDir: string;
  cases: readonly BenchCase[];
  resume: boolean;
  fingerprint: unknown;
  readSummary: (outDir: string, c: BenchCase) => { fingerprint: unknown } | null;
  log: (line: string) => void;
  /** The log prefix: the arm's name. */
  arm: string;
  /** What changed, for the log: "a different Codex/model/effort". */
  differs: string;
}): ArmCasePrep {
  const resultsDir = join(o.outDir, "results", "all");
  let metricsDropped = false;
  const dropMetrics = (): void => {
    if (metricsDropped) return;
    metricsDropped = true;
    dropStaleMetrics(resultsDir, o.log, o.arm, "the new reviews");
  };
  const want = JSON.stringify(o.fingerprint);
  const dropped: string[] = [];
  for (const c of o.cases) {
    const prior = o.resume ? o.readSummary(o.outDir, c) : null;
    if (o.resume && (!prior || JSON.stringify(prior.fingerprint) === want)) continue;
    if (prior) {
      o.log(`${o.arm}: ${c.instance_id} was reviewed by ${o.differs} — its result is dropped`);
      dropped.push(c.instance_id);
    }
    const caseDir = join(o.outDir, "cases", safeId(c.instance_id));
    rmSync(join(caseDir, "case-summary.json"), { force: true });
    for (const f of JUDGE_INPUT_FILES) rmSync(join(caseDir, f), { force: true });
    rmSync(join(resultsDir, `${safeId(c.instance_id)}.json`), { force: true });
  }
  if (!o.resume || dropped.length) dropMetrics();
  return { beforeReview: dropMetrics, dropped };
}

/** The run record's lifecycle fields: a resume keeps the run's start and adds
 * itself (with the fingerprint it ran under) to the resumes so far. */
export function runLifecycle(
  resume: boolean,
  previous: Record<string, unknown> | null,
  fingerprint: unknown,
): { started_at: string; resumes: unknown[] } {
  const now = new Date().toISOString();
  return {
    started_at:
      (resume && typeof previous?.["started_at"] === "string" && previous["started_at"]) || now,
    resumes: [
      ...(resume && Array.isArray(previous?.["resumes"]) ? (previous["resumes"] as unknown[]) : []),
      ...(resume && previous ? [{ at: now, fingerprint }] : []),
    ],
  };
}

/** Does the prepared tree's merge base of the case's commits match the one
 * prefetched? A mismatch is a warning on the case, never a refusal. */
export async function checkMergeBase(
  exec: (bin: string, args: string[], o?: ExecOptions) => Promise<ExecResult>,
  tree: string,
  c: BenchCase,
  meta: PrefetchMeta,
  env: NodeJS.ProcessEnv,
): Promise<{ ok: boolean; warning: string | null }> {
  const mb = await exec("git", ["-C", tree, "merge-base", c.base_commit, c.head_commit], { env });
  const ok = mb.code === 0 && mb.stdout.trim() === meta.merge_base;
  return {
    ok,
    warning: ok
      ? null
      : `merge-base(${c.base_commit.slice(0, 7)}, head) = ${mb.stdout.trim() || mb.stderr.trim().slice(0, 200)}, prefetched ${meta.merge_base.slice(0, 7)}`,
  };
}

/** A harness metric: `?` when absent, an integer as is, else two decimals. */
function fmtMetric(v: number | undefined): string {
  return v === undefined
    ? "?"
    : Number.isInteger(v)
      ? String(v)
      : String(Math.round(v * 100) / 100);
}

/** The AACR score table (average, then every round) from `roundMetrics`. */
export function aacrScoreTable(m: ReturnType<typeof roundMetrics>, cases: number): string[] {
  const row = (label: string, s: Record<string, number>): string =>
    `| ${label} | ${fmtMetric(s["evaluated_instances"])}/${cases} | ${fmtMetric(s["generated_notes"])} | ${fmtMetric(s["matched_semantic_notes"])}/${fmtMetric(s["expected_notes"])} | ${s["semantic_match_rate"]} | ${s["semantic_recall_rate"]} | ${s["semantic_f1"]} | ${s["line_match_rate"]} | ${s["line_recall_rate"]} |`;
  const L = [
    "| Round | Evaluated | Generated | Matched | Precision | Recall | F1 | Line P | Line R |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  if (m.average) L.push(row("**average**", m.average));
  for (const r of m.rounds) L.push(row(String(r.round), r.summary));
  if (!m.average && m.rounds.length === 0) L.push("| — | — | — | — | — | — | — | — | — |");
  return L;
}

/** What a case summary says went wrong, for the report's warnings section. */
export interface CaseDiagnostics {
  instance_id: string;
  status: string;
  merge_base_ok: boolean;
  error?: string;
  warnings: string[];
}

/** The report's "Warnings (case errors)" section: every case with an error,
 * a warning or a failed merge-base check; nothing when there is none. */
export function caseWarningsSection(cases: readonly CaseDiagnostics[]): string[] {
  const warned = cases.filter((s) => s.warnings.length || s.error || !s.merge_base_ok);
  if (!warned.length) return [];
  const L = ["", "## Warnings (case errors)", ""];
  for (const s of warned) {
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

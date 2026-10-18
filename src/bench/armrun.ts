// What the third-party arms' runs share around their own case runners (the
// Codex CLI, OCR, OpenCode and pi-review arms): setting a run dir up for a new
// configuration, the run record's lifecycle fields, the harness's time
// budget, the prepared tree's merge-base check and the AACR score table.

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readJsonObject } from "./publication.js";
import { safeId, type BenchCase, type PrefetchMeta } from "./aacr.js";
import type { ExecOptions, ExecResult } from "./exec.js";
import { caseWarningLines, dropMetricsFiles, type CaseDiagnostics } from "./report.js";

// The harness's review budget lives in the leaf exec.ts: the arms read it at
// module load, and armrun sits in an import cycle (report → ocr → armrun).
export { HARNESS_TIMEOUT_MIN } from "./exec.js";

/** reviewers/codex.py `run_codex_review`: `process_timeout = timeout_minutes
 * * 60 + 60` — the budget the harness gives its CLI reviewers, which the arms
 * run in the shape of. */
export function harnessProcessTimeoutMs(timeoutMin: number): number {
  return (timeoutMin * 60 + 60) * 1000;
}

/** `dropMetricsFiles` (report.ts) with the line that says so: the metrics
 * beside rewritten or removed result files scored findings that no longer
 * exist. Returns how many went. */
export function dropStaleMetrics(
  resultsDir: string,
  log: (line: string) => void,
  who: string,
  what: string,
): number {
  const stale = dropMetricsFiles(resultsDir);
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
  /** The cases whose earlier review was dropped for another configuration, or
   * for a summary that could not be read. */
  dropped: string[];
}

/**
 * A run dir set up for the run.json about to carry `fingerprint`: no case
 * reviewed under another configuration may stay a result of the run. Without
 * --resume every case goes; with it, every case whose recorded fingerprint
 * differs goes now, not when the loop reaches it — a stop partway
 * (AuthExpiring) must leave those cases incomplete, never scored under the new
 * label. A case with no summary of this arm (an interrupted review: its
 * result is written before its summary) is re-reviewed by the loop, so any
 * result or judge input it left goes now too — nothing unverified is scored
 * under the new label; so does a case whose summary cannot be read (no proof
 * of this run's fingerprint). The run's metrics go BEFORE the first file is
 * removed (and with the first result rewritten), so no stop can leave a score
 * of findings already gone; a resume that keeps every case keeps them.
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
  const clear: string[][] = [];
  for (const c of o.cases) {
    const caseDir = join(o.outDir, "cases", safeId(c.instance_id));
    const files = [
      join(caseDir, "case-summary.json"),
      ...JUDGE_INPUT_FILES.map((f) => join(caseDir, f)),
      join(resultsDir, `${safeId(c.instance_id)}.json`),
    ];
    if (o.resume) {
      let prior: { fingerprint: unknown } | null;
      try {
        prior = o.readSummary(o.outDir, c);
      } catch {
        // An unreadable summary is no proof of this run's fingerprint.
        prior = { fingerprint: undefined };
      }
      if (prior) {
        if (JSON.stringify(prior.fingerprint) === want) {
          if (readJsonObject(join(resultsDir, `${safeId(c.instance_id)}.json`)) !== undefined)
            continue;
          o.log(
            `${o.arm}: ${c.instance_id} has no readable result despite its summary — reviewed again`,
          );
        } else
          o.log(`${o.arm}: ${c.instance_id} was reviewed by ${o.differs} — its result is dropped`);
        dropped.push(c.instance_id);
      } else {
        const left = files.slice(1).filter((f) => existsSync(f));
        if (!left.length) continue;
        o.log(
          `${o.arm}: ${c.instance_id} left a result without a case summary (an interrupted review) — dropped; it is reviewed again`,
        );
      }
    }
    clear.push(files);
  }
  if (!o.resume || clear.length) dropMetrics();
  for (const files of clear) for (const f of files) rmSync(f, { force: true });
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

/** The AACR score table, report.ts's: the arms render it from there. */
export { aacrScoreTable } from "./report.js";

/** The report's "Warnings (case errors)" section: every case with an error,
 * a warning or a failed merge-base check; nothing when there is none. */
export function caseWarningsSection(cases: readonly CaseDiagnostics[]): string[] {
  const lines = caseWarningLines(cases);
  return lines.length ? ["", "## Warnings (case errors)", "", ...lines] : [];
}

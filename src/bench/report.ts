// The AACR-Bench run report: the scorer's numbers per variant, then per case
// what the reviewer did — so a number is never read without what produced it.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { safeId, VARIANTS, type BenchCase, type CaseSet } from "./aacr.js";
import type { CaseSummary } from "./runner.js";

interface Metrics {
  summary: Record<string, number>;
}

export function latestMetrics(dir: string): Metrics | null {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((n) => n.startsWith("metrics_ocr_") && n.endsWith(".json"));
  // Multi-round evals write an `_average` file — that is the number to report.
  const pick = files.find((n) => n.includes("average")) ?? files.sort().at(-1);
  if (!pick) return null;
  return JSON.parse(readFileSync(join(dir, pick), "utf8")) as Metrics;
}

function readSummary(outDir: string, c: BenchCase): CaseSummary | null {
  const p = join(outDir, "cases", safeId(c.instance_id), "case-summary.json");
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as CaseSummary) : null;
}

/** An averaged count is written as a float (`10.0`); show it as the integer. */
function n(v: number | undefined): string {
  return v === undefined
    ? "?"
    : Number.isInteger(v)
      ? String(v)
      : String(Math.round(v * 100) / 100);
}

/** The run report: the scorer's numbers per variant, then per case what the
 * reviewer did, so a number is never read without what produced it. */
export function renderReport(set: CaseSet, outDir: string, cases: BenchCase[]): string {
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
  L.push(
    `- Dataset: AACR-Bench v1.0 (\`${set.dataset.commit.slice(0, 7)}\`), ${cases.length} PRs, ${cases.reduce((a, c) => a + c.references, 0)} reference comments`,
  );
  L.push(
    `- Reviewer: quickreviewd \`${String(run.qcr_commit ?? "?").slice(0, 10)}\`, profile \`${run.profile || "(generic)"}\`, conversation model \`${run.models?.conversation ?? "?"}\`, pi ${run.pi ?? "?"}`,
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
    const s = m.summary;
    L.push(
      `| ${v} | ${n(s["evaluated_instances"])}/${cases.length} | ${n(s["generated_notes"])} | ${n(s["matched_semantic_notes"])}/${n(s["expected_notes"])} | ${s["semantic_match_rate"]} | ${s["semantic_recall_rate"]} | ${s["semantic_f1"]} | ${s["line_match_rate"]} | ${s["line_recall_rate"]} |`,
    );
  }
  L.push("");
  L.push("## Per case");
  L.push("");
  L.push(
    "| Case | Lang | Refs | Status | Verdict | Posted (b/q/n/other) | In body | LEFT excl. | Lenses planned → ran | Minutes | Tokens in/out |",
  );
  L.push("|---|---|---|---|---|---|---|---|---|---|---|");
  let left = 0;
  for (const { c, s } of summaries) {
    if (!s) {
      L.push(`| ${c.instance_id} | ${c.language} | ${c.references} | not run | | | | | | | |`);
      continue;
    }
    left += s.comments.left_side;
    const t = s.comments.by_tag;
    L.push(
      `| ${c.instance_id} | ${c.language} | ${c.references} | ${s.status}${s.continued ? " (continued)" : ""} | ${s.verdict ?? "—"} | ${t["blocker"] ?? 0}/${t["question"] ?? 0}/${t["nit"] ?? 0}/${t["other"] ?? 0} | ${s.comments.body ?? 0} | ${s.comments.left_side} | ${s.planned_lenses.length} → ${s.executed_passes.length} | ${(s.duration_seconds / 60).toFixed(1)} | ${Math.round((s.usage.input + s.usage.cacheRead) / 1000)}k/${Math.round(s.usage.output / 1000)}k |`,
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
    `Reading the numbers: precision counts every posted head-side comment against the dataset's references, so a real issue the annotators did not record scores as a false positive. ${left} LEFT-side (old-code) comment(s) were excluded — the harness forces every generated comment to the right side, so an old-side anchor could only score wrong. The references are 74% AI-authored and 42% maintainability/readability — compare variants, not just the headline. Published leaderboard rows used an undisclosed judge; only a baseline re-run under this judge is a like-for-like comparison.`,
  );
  L.push("");
  return L.join("\n");
}

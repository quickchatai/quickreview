// The AACR-Bench run report: the scorer's numbers per variant, then per case
// what the reviewer did — so a number is never read without what produced it.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { safeId, VARIANTS, type BenchCase, type CaseSet } from "./aacr.js";
import type { CaseSummary } from "./runner.js";

interface Metrics {
  summary: Record<string, number>;
  judge?: string;
}

export function latestMetrics(dir: string): Metrics | null {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((n) => n.startsWith("metrics_ocr_") && n.endsWith(".json"));
  // Multi-round evals write an `_average` file — that is the number to report.
  const pick = files.find((n) => n.includes("average")) ?? files.sort().at(-1);
  if (!pick) return null;
  return JSON.parse(readFileSync(join(dir, pick), "utf8")) as Metrics;
}

/** The run report: the scorer's numbers per variant, then per case what the
 * reviewer did, so a number is never read without what produced it. */
export function renderReport(set: CaseSet, outDir: string, cases: BenchCase[]): string {
  const L: string[] = [];
  const run = existsSync(join(outDir, "run.json"))
    ? JSON.parse(readFileSync(join(outDir, "run.json"), "utf8"))
    : {};
  const judgeFile = join(outDir, "judge.txt");
  const judge = existsSync(judgeFile) ? readFileSync(judgeFile, "utf8").trim() : "not run";
  L.push(`# AACR-Bench run — ${set.name}`);
  L.push("");
  L.push(
    `- Dataset: AACR-Bench v1.0 (\`${set.dataset.commit.slice(0, 7)}\`), ${cases.length} PRs, ${cases.reduce((n, c) => n + c.references, 0)} reference comments`,
  );
  L.push(
    `- Reviewer: quickreviewd \`${String(run.qcr_commit ?? "?").slice(0, 10)}\`, profile \`${run.profile || "(generic)"}\`, conversation model \`${run.models?.conversation ?? "?"}\`, pi ${run.pi ?? "?"}`,
  );
  L.push(`- Judge: ${judge}`);
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
      `| ${v} | ${s["evaluated_instances"]}/${cases.length} | ${s["generated_notes"]} | ${s["matched_semantic_notes"]}/${s["expected_notes"]} | ${s["semantic_match_rate"]} | ${s["semantic_recall_rate"]} | ${s["semantic_f1"]} | ${s["line_match_rate"]} | ${s["line_recall_rate"]} |`,
    );
  }
  L.push("");
  L.push("## Per case");
  L.push("");
  L.push(
    "| Case | Lang | Refs | Status | Verdict | Posted (b/q/n/other) | In body | Lenses planned → ran | Minutes | Tokens in/out |",
  );
  L.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const c of cases) {
    const p = join(outDir, "cases", safeId(c.instance_id), "case-summary.json");
    if (!existsSync(p)) {
      L.push(`| ${c.instance_id} | ${c.language} | ${c.references} | not run | | | | | | |`);
      continue;
    }
    const s = JSON.parse(readFileSync(p, "utf8")) as CaseSummary;
    const t = s.comments.by_tag;
    L.push(
      `| ${c.instance_id} | ${c.language} | ${c.references} | ${s.status}${s.continued ? " (continued)" : ""} | ${s.verdict ?? "—"} | ${t["blocker"] ?? 0}/${t["question"] ?? 0}/${t["nit"] ?? 0}/${t["other"] ?? 0} | ${s.comments.body ?? 0} | ${s.planned_lenses.length} → ${s.executed_passes.length} | ${(s.duration_seconds / 60).toFixed(1)} | ${Math.round((s.usage.input + s.usage.cacheRead) / 1000)}k/${Math.round(s.usage.output / 1000)}k |`,
    );
  }
  const warned = cases
    .map((c) => {
      const p = join(outDir, "cases", safeId(c.instance_id), "case-summary.json");
      if (!existsSync(p)) return null;
      const s = JSON.parse(readFileSync(p, "utf8")) as CaseSummary;
      return (s.warnings ?? []).length || s.error ? { c, s } : null;
    })
    .filter((x): x is { c: BenchCase; s: CaseSummary } => x !== null);
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
    "Reading the numbers: precision counts every posted comment against the dataset's references, so a real issue the annotators did not record scores as a false positive. The references are 74% AI-authored and 42% maintainability/readability — compare variants, not just the headline. Published leaderboard rows used an undisclosed judge; only a baseline re-run under this judge is a like-for-like comparison.",
  );
  L.push("");
  return L.join("\n");
}

// The AACR-Bench run report: the scorer's numbers per variant, then per case
// what the reviewer did — so a number is never read without what produced it.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { safeId, VARIANTS, type BenchCase, type CaseSet } from "./aacr.js";
import { readOcrSummary, type OcrCaseSummary } from "./ocr.js";
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

/** Hand-checked reference labels (`sets/<set>.labels.json`): per instance, one
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
  const rounds = readdirSync(dir)
    .filter((f) => /^metrics_ocr_.*_round_\d+\.json$/.test(f))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as RoundFile);
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
        `Each reference hand-checked against the code (${labels.source}). A match on a dubious reference scores the same as one on a real defect; the first column is the one that says whether the review got better.`,
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

// ---- the open-code-review baseline arm -------------------------------------------

/** Every round's metrics file, in round order, plus the average when the
 * harness wrote one. A round's number is exact; the average is a float. */
export function roundMetrics(dir: string): {
  rounds: Array<{ round: number; summary: Record<string, number> }>;
  average: Record<string, number> | null;
} {
  if (!existsSync(dir)) return { rounds: [], average: null };
  const files = readdirSync(dir).filter((n) => n.startsWith("metrics_ocr_") && n.endsWith(".json"));
  const rounds: Array<{ round: number; summary: Record<string, number> }> = [];
  let average: Record<string, number> | null = null;
  for (const f of files.sort()) {
    const m = JSON.parse(readFileSync(join(dir, f), "utf8")) as Metrics;
    if (f.includes("average")) {
      average = m.summary;
      continue;
    }
    const r = /_round_(\d+)\.json$/.exec(f);
    rounds.push({ round: r ? Number(r[1]) : rounds.length + 1, summary: m.summary });
  }
  rounds.sort((a, b) => a.round - b.round);
  return { rounds, average };
}

function scoreRow(label: string, s: Record<string, number>, cases: number): string {
  return `| ${label} | ${n(s["evaluated_instances"])}/${cases} | ${n(s["generated_notes"])} | ${n(s["matched_semantic_notes"])}/${n(s["expected_notes"])} | ${s["semantic_match_rate"]} | ${s["semantic_recall_rate"]} | ${s["semantic_f1"]} | ${s["line_match_rate"]} | ${s["line_recall_rate"]} |`;
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
  L.push(
    `- Dataset: AACR-Bench v1.0 (\`${set.dataset.commit.slice(0, 7)}\`), ${cases.length} PRs, ${cases.reduce((a, c) => a + c.references, 0)} reference comments`,
  );
  L.push(
    `- Reviewer: ${run.ocr_version ?? "open-code-review ?"}, run as the AACR harness's reviewers/ocr.py runs it: \`ocr review --from <base_commit> --to <head_commit> --format json --audience agent --concurrency ${flags.concurrency ?? "?"} --timeout ${flags.timeout_min ?? "?"} --max-tools ${flags.max_tools ?? "?"}\` (range = merge-base..head; no PR title/description — the harness passes none)`,
  );
  L.push(
    `- Model: \`${run.model ?? "?"}\`, reasoning effort \`${run.effort ?? "?"}\`, text verbosity \`${run.verbosity ?? "?"}\` — the ChatGPT Codex backend through the loopback bridge (bench/aacr/codex_bridge.py: OCR's Chat Completions calls → streamed Responses)`,
  );
  L.push(`- Judge: ${judge[0] ?? ""}`);
  for (const w of judge.slice(1)) L.push(`  ${w}`);
  L.push("");
  L.push("## Scores (the AACR harness, OCR reader)");
  L.push("");
  L.push("| Round | Evaluated | Generated | Matched | Precision | Recall | F1 | Line P | Line R |");
  L.push("|---|---|---|---|---|---|---|---|---|");
  const { rounds, average } = roundMetrics(join(outDir, "results", "all"));
  if (average) L.push(scoreRow("**average**", average, cases.length));
  for (const r of rounds) L.push(scoreRow(String(r.round), r.summary, cases.length));
  if (!average && rounds.length === 0) L.push("| — | — | — | — | — | — | — | — | — |");
  L.push("");
  L.push("## Per case");
  L.push("");
  L.push(
    "| Case | Lang | Refs | Status | Comments | Files reviewed | Minutes | OCR tokens in/out | Model calls (failed) | Backend tokens in (cached) / out (reasoning) |",
  );
  L.push("|---|---|---|---|---|---|---|---|---|---|");
  const k = (x: number): string => `${Math.round(x / 1000)}k`;
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
    }
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
  if (ran)
    L.push(
      `| **total** | | ${cases.reduce((a, c) => a + c.references, 0)} | | ${summaries.reduce((a, x) => a + (x.s?.comments ?? 0), 0)} | | ${(tot.secs / 60).toFixed(1)} (avg ${(tot.secs / 60 / ran).toFixed(1)}) | ${k(tot.oin)}/${k(tot.oout)} | ${tot.calls} (${tot.errors}) | ${k(tot.inp)} (${k(tot.cached)}) / ${k(tot.out)} (${k(tot.reasoning)}) |`,
    );
  const warned = summaries.filter(
    (x): x is { c: BenchCase; s: OcrCaseSummary } =>
      x.s !== null && (x.s.warnings.length > 0 || Boolean(x.s.error) || !x.s.merge_base_ok),
  );
  if (warned.length) {
    L.push("");
    L.push("## Warnings (OCR warnings, case errors)");
    L.push("");
    for (const { c, s } of warned) {
      if (!s.merge_base_ok && s.status !== "failed")
        L.push(`- \`${c.instance_id}\`: merge-base check failed — see case-summary.json`);
      for (const w of [
        ...(s.error ? [s.error.replaceAll("\n", " ").slice(0, 400)] : []),
        ...s.warnings,
      ])
        L.push(`- \`${c.instance_id}\`: ${w}`);
    }
  }
  L.push("");
  L.push(
    "Reading the numbers: OCR's comments carry no severity tag, so only the `all` variant exists for this arm — compare it with the quickreviewd arm's `all` row. OCR tokens are OCR's own summary (prompt tokens, cached included); the backend columns are the bridge's count of the same calls from the backend's usage (reasoning tokens are part of output). Precision counts every comment against the dataset's references, so a real issue the annotators did not record scores as a false positive.",
  );
  L.push("");
  return L.join("\n");
}

// The Codex CLI arm's AACR report: the harness's numbers (average and every
// round), then per case what Codex did and what it cost.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BenchCase, CaseSet } from "./aacr.js";
import { readCodexSummary } from "./codex.js";
import { AACR_REPORT_PREAMBLE, roundMetrics } from "./report.js";

function n(v: number | undefined): string {
  return v === undefined
    ? "?"
    : Number.isInteger(v)
      ? String(v)
      : String(Math.round(v * 100) / 100);
}

function scoreRow(label: string, s: Record<string, number>, cases: number): string {
  return `| ${label} | ${n(s["evaluated_instances"])}/${cases} | ${n(s["generated_notes"])} | ${n(s["matched_semantic_notes"])}/${n(s["expected_notes"])} | ${s["semantic_match_rate"]} | ${s["semantic_recall_rate"]} | ${s["semantic_f1"]} | ${s["line_match_rate"]} | ${s["line_recall_rate"]} |`;
}

export function renderCodexReport(set: CaseSet, outDir: string, cases: BenchCase[]): string {
  const L: string[] = [];
  const run = existsSync(join(outDir, "run.json"))
    ? (JSON.parse(readFileSync(join(outDir, "run.json"), "utf8")) as Record<string, unknown>)
    : {};
  const judgeFile = join(outDir, "judge.txt");
  const judge = existsSync(judgeFile)
    ? readFileSync(judgeFile, "utf8").trim().split("\n")
    : ["not run"];
  const k = (x: number): string => `${Math.round(x / 1000)}k`;
  L.push(`# AACR-Bench run — ${set.name} — Codex CLI`);
  L.push("");
  L.push(AACR_REPORT_PREAMBLE);
  L.push("");
  L.push(
    `- Dataset: AACR-Bench v1.0 (\`${set.dataset.commit.slice(0, 7)}\`), ${cases.length} PRs, ${cases.reduce((a, c) => a + c.references, 0)} reference comments`,
  );
  L.push(
    `- Reviewer: Codex CLI ${String(run["codex_version"] ?? "?")}, run by the AACR harness's own reviewers/codex.py: \`codex --sandbox workspace-write exec review --json --skip-git-repo-check "/review <base>...<head> (<report-tool instructions>)"\`, findings through its \`report\` MCP tool, timeout ${String(run["timeout_min"] ?? "?")} min (no PR title/description — the harness passes none)`,
  );
  L.push(
    `- Model: \`${String(run["model"] ?? "?")}\`, reasoning effort \`${String(run["effort"] ?? "?")}\` — Codex's native ChatGPT login (the refresh-disabled token copy)`,
  );
  L.push(`- Judge: ${judge[0] ?? ""}`);
  for (const w of judge.slice(1)) L.push(`  ${w}`);
  L.push("");
  L.push("## Scores (the AACR harness; Codex reader = OCR reader on this file, checked per case)");
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
    "| Case | Lang | Refs | Status | Comments | Source | Minutes | Tokens in (cached) / out (reasoning) |",
  );
  L.push("|---|---|---|---|---|---|---|---|");
  let secs = 0;
  let ran = 0;
  for (const c of cases) {
    const s = readCodexSummary(outDir, c);
    if (!s) {
      L.push(`| ${c.instance_id} | ${c.language} | ${c.references} | not run | | | | |`);
      continue;
    }
    ran++;
    secs += s.duration_seconds;
    const t = s.tokens;
    L.push(
      `| ${c.instance_id} | ${c.language} | ${c.references} | ${s.status} | ${s.comments} | ${s.review_output_source ?? "?"} | ${(s.duration_seconds / 60).toFixed(1)} | ${t ? `${k(t.input_tokens)} (${k(t.cached_input_tokens)}) / ${k(t.output_tokens)} (${k(t.reasoning_output_tokens)})` : "?"} |`,
    );
  }
  if (ran)
    L.push(
      `| **total** | | | | | | ${(secs / 60).toFixed(1)} (avg ${(secs / 60 / ran).toFixed(1)}) | |`,
    );
  L.push("");
  L.push(
    "Reading the numbers: Codex findings carry a severity but the harness ignores it, so only the `all` variant exists for this arm — compare it with the quickreviewd arm's `all` row. Source `mcp_stream` = the findings came through the harness's `report` MCP tool; `jsonl_fallback` = parsed from Codex's final message (raw text there scores zero comments, as in the harness).",
  );
  L.push("");
  return L.join("\n");
}

// The Codex CLI arm's AACR report: the harness's numbers (average and every
// round), then per case what Codex did and what it cost.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BenchCase, CaseSet } from "./aacr.js";
import { aacrScoreTable, caseWarningsSection } from "./armrun.js";
import { readCodexSummary, type CodexCaseSummary } from "./codex.js";
import { datasetLine, kTokens, reportPreamble, roundMetrics } from "./report.js";

/** A run recorded before run.json carried its endpoint ran on the login. */
const LEGACY_ENDPOINT = "Codex's native ChatGPT login (the refresh-disabled token copy)";

export function renderCodexReport(set: CaseSet, outDir: string, cases: BenchCase[]): string {
  const L: string[] = [];
  const run = existsSync(join(outDir, "run.json"))
    ? (JSON.parse(readFileSync(join(outDir, "run.json"), "utf8")) as Record<string, unknown>)
    : {};
  const judgeFile = join(outDir, "judge.txt");
  const judge = existsSync(judgeFile)
    ? readFileSync(judgeFile, "utf8").trim().split("\n")
    : ["not run"];
  const k = kTokens;
  L.push(`# AACR-Bench run — ${set.name} — Codex CLI`);
  L.push("");
  L.push(reportPreamble(set));
  L.push("");
  L.push(datasetLine(set, cases));
  L.push(
    `- Reviewer: Codex CLI ${String(run["codex_version"] ?? "?")}, run by the AACR harness's own reviewers/codex.py: \`codex --sandbox workspace-write exec review --json --skip-git-repo-check "/review <base>...<head> (<report-tool instructions>)"\`, findings through its \`report\` MCP tool, timeout ${String(run["timeout_min"] ?? "?")} min; ${run["pr_text"] === true ? "PR title/description appended to the /review instructions (the equal-inputs switch)" : "no PR title/description (the harness passes none)"}`,
  );
  L.push(
    `- Model: \`${String(run["model"] ?? "?")}\`, reasoning effort \`${String(run["effort"] ?? "?")}\` — ${typeof run["endpoint"] === "string" ? run["endpoint"] : LEGACY_ENDPOINT}`,
  );
  L.push(`- Judge: ${judge[0] ?? ""}`);
  for (const w of judge.slice(1)) L.push(`  ${w}`);
  L.push("");
  L.push("## Scores (the AACR harness; Codex reader = OCR reader on this file, checked per case)");
  L.push("");
  L.push(...aacrScoreTable(roundMetrics(join(outDir, "results", "all")), cases.length));
  L.push("");
  L.push("## Per case");
  L.push("");
  L.push(
    "| Case | Lang | Refs | Status | Comments | Source | Minutes | Tokens in (cached) / out (reasoning) |",
  );
  L.push("|---|---|---|---|---|---|---|---|");
  let secs = 0;
  const reviewed: CodexCaseSummary[] = [];
  for (const c of cases) {
    const s = readCodexSummary(outDir, c);
    if (!s) {
      L.push(`| ${c.instance_id} | ${c.language} | ${c.references} | not run | | | | |`);
      continue;
    }
    reviewed.push(s);
    secs += s.duration_seconds;
    const t = s.tokens;
    L.push(
      `| ${c.instance_id} | ${c.language} | ${c.references} | ${s.status} | ${s.comments} | ${s.review_output_source ?? "?"} | ${(s.duration_seconds / 60).toFixed(1)} | ${t ? `${k(t.input_tokens)} (${k(t.cached_input_tokens)}) / ${k(t.output_tokens)} (${k(t.reasoning_output_tokens)})` : "?"} |`,
    );
  }
  if (reviewed.length)
    L.push(
      `| **total** | | | | | | ${(secs / 60).toFixed(1)} (avg ${(secs / 60 / reviewed.length).toFixed(1)}) | |`,
    );
  L.push(...caseWarningsSection(reviewed));
  L.push("");
  L.push(
    "Reading the numbers: Codex findings carry a severity but the harness ignores it, so only the `all` variant exists for this arm — compare it with the QuickReview arm's `all` row. Source `mcp_stream` = the findings came through the harness's `report` MCP tool; `jsonl_fallback` = parsed from Codex's final message (raw text there scores zero comments, as in the harness).",
  );
  L.push("");
  return L.join("\n");
}

// The Claude Code arm's result file, read the way the AACR harness's scorer
// reads it — pure, no imports, so the defect judge (src/bench/defects.ts) can
// read a Claude Code run without pulling in the arm's runner.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** evaluate.py `build_target_comments_from_claude`: every dict finding in
 * `review_output` whose `summary` + `failure_scenario` is non-blank, at its
 * single `line`. A raw-text `review_output` (the harness's worst-case
 * fallback) scores ZERO comments. */
export function claudeScoredFindings(
  result: unknown,
): { path: string; line: number | null; note: string }[] {
  if (!isObj(result) || !Array.isArray(result["review_output"])) return [];
  const out: { path: string; line: number | null; note: string }[] = [];
  for (const f of result["review_output"] as unknown[]) {
    if (!isObj(f)) continue;
    const s = typeof f["summary"] === "string" ? f["summary"].trim() : "";
    const fs = typeof f["failure_scenario"] === "string" ? f["failure_scenario"].trim() : "";
    const note = [s, fs].filter(Boolean).join("\n").trim();
    if (!note) continue;
    const line = typeof f["line"] === "number" && Number.isFinite(f["line"]) ? f["line"] : null;
    out.push({ path: typeof f["file"] === "string" ? f["file"] : "", line, note });
  }
  return out;
}

/** The same findings in the OCR row shape the defect judge reads
 * (src/bench/defects.ts `reviewForJudge`); `undefined` for a result file that
 * is not a Claude Code one. */
export function claudeRowsForJudge(result: unknown): Obj[] | undefined {
  if (!isObj(result) || !("review_output" in result)) return undefined;
  return claudeScoredFindings(result).map((f) => ({
    path: f.path,
    start_line: f.line,
    end_line: f.line,
    content: f.note,
  }));
}

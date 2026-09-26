// What a reviewed PR cost in dollars, the way pi prices it.
//
// quickreviewd runs through pi, which prices every model call it makes
// (usage.cost on each assistant message_end, and a per-child total on each
// subagent result): the case's cost is the sum over the main session and every
// lens pass — together they are exactly the case's recorded tokens. The OCR
// arm does not run through pi, so its tokens (the Codex bridge's counts) are
// priced at pi's own rates for the same model, so both arms are in one
// currency. Neither is a bill: the runs go through a ChatGPT login.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** pi's price list for openai-codex/gpt-6-sol, $ per million tokens (pi 0.87.1,
 * model catalog `cost` — VERIFY-ON-PIN). Requests above 272k input tokens are
 * priced higher by pi; OCR's per-file calls never get near that. */
export const GPT6_SOL_USD_PER_MTOK = { input: 2, cacheRead: 0.2, output: 10 } as const;

export interface CaseCost {
  usd: number;
  /** "pi": summed from pi's own per-call costs; "priced": tokens priced at
   * GPT6_SOL_USD_PER_MTOK (the OCR arm). */
  source: "pi" | "priced";
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function caseCostUsd(caseDir: string): CaseCost | null {
  const events = join(caseDir, "pi-events.jsonl");
  if (existsSync(events)) {
    let usd = 0;
    for (const line of readFileSync(events, "utf8").split("\n")) {
      if (!line.startsWith("{")) continue;
      let e: {
        type?: string;
        toolName?: string;
        message?: { role?: string; usage?: { cost?: { total?: unknown } } };
        result?: { details?: { results?: { usage?: { cost?: unknown } }[] } };
      };
      try {
        e = JSON.parse(line) as typeof e;
      } catch {
        continue;
      }
      if (e.type === "message_end" && e.message?.role === "assistant")
        usd += num(e.message.usage?.cost?.total);
      else if (e.type === "tool_execution_end" && e.toolName === "subagent")
        for (const r of e.result?.details?.results ?? []) {
          const c = r.usage?.cost;
          usd +=
            typeof c === "object" && c !== null ? num((c as { total?: unknown }).total) : num(c);
        }
    }
    return { usd, source: "pi" };
  }
  const summary = join(caseDir, "case-summary.json");
  if (!existsSync(summary)) return null;
  const s = JSON.parse(readFileSync(summary, "utf8")) as {
    bridge?: { input_tokens?: unknown; cached_tokens?: unknown; output_tokens?: unknown };
  };
  if (!s.bridge) return null;
  const input = num(s.bridge.input_tokens);
  const cached = Math.min(num(s.bridge.cached_tokens), input);
  const r = GPT6_SOL_USD_PER_MTOK;
  const usd =
    ((input - cached) * r.input + cached * r.cacheRead + num(s.bridge.output_tokens) * r.output) /
    1e6;
  return { usd, source: "priced" };
}

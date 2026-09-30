// What a reviewed PR cost in dollars, the way pi prices it.
//
// quickreviewd runs through pi, which prices every model call it makes
// (usage.cost on each assistant message_end, and a per-child total on each
// subagent result): the case's cost is the sum over the main session and every
// lens pass — together they are exactly the case's recorded tokens. The OCR
// arm does not run through pi, so its tokens (the Codex bridge's counts) are
// priced at pi's own rates for the model the bridge served (per model: the
// PR-Agent arm runs gpt-6.1-sol), so all arms are in one currency. Neither
// is a bill: the runs go through a ChatGPT login.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** pi's price list for the openai-codex models the priced arms run on, $ per
 * million tokens (model catalog `cost` in pi 0.99.1 — VERIFY-ON-PIN). The
 * pricing is per MODEL: gpt-6.1-sol's cache reads cost half of gpt-6-sol's.
 * Requests above 272k input tokens are priced higher by pi; the bridge-driven
 * arms' calls stay well below that (PR-Agent clamps at 32k by default). */
export const CODEX_USD_PER_MTOK = {
  "gpt-6-sol": { input: 2, cacheRead: 0.2, output: 10 },
  "gpt-6.1-sol": { input: 2, cacheRead: 0.1, output: 10 },
} as const satisfies Record<string, { input: number; cacheRead: number; output: number }>;

export type PricedModel = keyof typeof CODEX_USD_PER_MTOK;

/** gpt-6-sol's rates — the model every priced arm ran on before gpt-6.1-sol. */
export const GPT6_SOL_USD_PER_MTOK = CODEX_USD_PER_MTOK["gpt-6-sol"];

/** The rates for a case's model; a summary that names none predates per-model
 * pricing and ran on gpt-6-sol. An unknown model has no price — never a guess. */
export function ratesFor(
  model: string | null | undefined,
): { input: number; cacheRead: number; output: number } | null {
  const m = model ?? "gpt-6-sol";
  return Object.hasOwn(CODEX_USD_PER_MTOK, m) ? CODEX_USD_PER_MTOK[m as PricedModel] : null;
}

export interface CaseCost {
  usd: number;
  /** "pi": summed from pi's own per-call costs; "priced": the bridge's tokens
   * priced at CODEX_USD_PER_MTOK for the case's model (the OCR, OpenCode and
   * PR-Agent arms). */
  source: "pi" | "priced";
  /** The model the tokens were priced as ("priced" only). */
  model?: string;
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
    model?: unknown;
    fingerprint?: { model?: unknown };
    bridge?: { input_tokens?: unknown; cached_tokens?: unknown; output_tokens?: unknown };
  };
  if (!s.bridge) return null;
  const named = typeof s.model === "string" ? s.model : s.fingerprint?.model;
  const model = typeof named === "string" ? named : "gpt-6-sol";
  const r = ratesFor(model);
  if (!r) return null;
  const input = num(s.bridge.input_tokens);
  const cached = Math.min(num(s.bridge.cached_tokens), input);
  const usd =
    ((input - cached) * r.input + cached * r.cacheRead + num(s.bridge.output_tokens) * r.output) /
    1e6;
  return { usd, source: "priced", model };
}

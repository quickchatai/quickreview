// What a reviewed PR cost in dollars, the way pi prices it.
//
// QuickReview runs through pi, which prices every model call it makes
// (usage.cost on each assistant message_end, and a per-child total on each
// subagent result): the case's cost is the sum over the main session and every
// lens pass — together they are exactly the case's recorded tokens. The OCR
// arm does not run through pi, so its tokens (the Codex bridge's counts) are
// priced at pi's own rates for the model the bridge served (per model: the
// PR-Agent arm runs gpt-6.1-sol), so all those arms are in one currency.
// Neither is a bill: the runs go through a ChatGPT login. The Claude Code arm
// runs no OpenAI model; its cost is Claude Code's own `total_cost_usd` (the
// API-price equivalent), as bench/aacr/compare.py reads it — labelled apart.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** pi's price list for the openai-codex models the priced arms run on, $ per
 * million tokens (model catalog `cost` in pi 0.99.1, unchanged at 1.0.0 — VERIFY-ON-PIN). The
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

/** OpenAI-style counts (input INCLUDING its cached part) as pi-style usage:
 * input without cache reads, the cached part — capped at the input — apart. */
export function piUsageFromInclusive(
  input: number,
  cached: number,
  output: number,
): { input: number; cacheRead: number; output: number } {
  const cacheRead = Math.min(cached, input);
  return { input: input - cacheRead, cacheRead, output };
}

export interface CaseCost {
  usd: number;
  /** "pi": summed from pi's own per-call costs; "priced": the bridge's tokens
   * priced at CODEX_USD_PER_MTOK for the case's model (the OCR, OpenCode and
   * PR-Agent arms); "claude": Claude Code's own total_cost_usd. */
  source: "pi" | "priced" | "claude";
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
      else if (
        e.type === "tool_execution_end" &&
        (e.toolName === "subagent" || e.toolName === "launch_plan")
      )
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
    arm?: unknown;
    cost_usd?: unknown;
    model?: unknown;
    fingerprint?: { model?: unknown };
    bridge?: { input_tokens?: unknown; cached_tokens?: unknown; output_tokens?: unknown };
  };
  if (s.arm === "claude")
    return typeof s.cost_usd === "number" && Number.isFinite(s.cost_usd)
      ? { usd: s.cost_usd, source: "claude" }
      : null;
  if (!s.bridge) return null;
  const named = typeof s.model === "string" ? s.model : s.fingerprint?.model;
  const model = typeof named === "string" ? named : "gpt-6-sol";
  const r = ratesFor(model);
  if (!r) return null;
  const u = piUsageFromInclusive(
    num(s.bridge.input_tokens),
    num(s.bridge.cached_tokens),
    num(s.bridge.output_tokens),
  );
  const usd = (u.input * r.input + u.cacheRead * r.cacheRead + u.output * r.output) / 1e6;
  return { usd, source: "priced", model };
}

/** A case's token counts from its case-summary.json, whichever arm wrote it:
 * `usage` (pi style, input without cache reads — our arm, Codex, OpenCode,
 * PR-Agent), `ocr_tokens` (the OCR arm) or Claude Code's `tokens` (input,
 * cache reads and cache writes apart). Input counts cache reads. A summary
 * that records no counts is null — unknown, never zero. */
export function caseTokenCounts(summary: unknown): { input: number; output: number } | null {
  if (typeof summary !== "object" || summary === null) return null;
  const s = summary as {
    usage?: { input?: unknown; output?: unknown; cacheRead?: unknown } | null;
    ocr_tokens?: { input?: unknown; output?: unknown } | null;
    tokens?: {
      input?: unknown;
      output?: unknown;
      cache_read?: unknown;
      cache_creation?: unknown;
    } | null;
  };
  if (s.usage)
    return { input: num(s.usage.input) + num(s.usage.cacheRead), output: num(s.usage.output) };
  if (s.ocr_tokens) return { input: num(s.ocr_tokens.input), output: num(s.ocr_tokens.output) };
  const t = s.tokens;
  if (t && typeof t.input === "number" && typeof t.output === "number")
    return {
      input: num(t.input) + num(t.cache_read) + num(t.cache_creation),
      output: num(t.output),
    };
  return null;
}

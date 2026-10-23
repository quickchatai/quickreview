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
// A slim re-score bundle has no transcripts: its case-summary.json carries
// the price the export computed from the full case dir (`bench_cost_usd`,
// null = unpriced), which wins for every arm, as compare.py reads it.
//
// The price table and the event-stream meter are core (packages/pi-plugin/src/pricing.ts): a
// round prices itself with them. This module adds the run-level report.
import { finiteNumber as num } from "./values.js";
import { caseCostUsd, ratesFor } from "@quickchatai/pi-quickreview/src/pricing.js";

export {
  CODEX_USD_PER_MTOK,
  EventCostMeter,
  GPT6_SOL_USD_PER_MTOK,
  LENS_LEDGER_FILE,
  SLIM_COST_KEY,
  caseCostUsd,
  eventLineCostUsd,
  piUsageFromInclusive,
  ratesFor,
  type CaseCost,
  type PricedModel,
} from "@quickchatai/pi-quickreview/src/pricing.js";

/** The defect report's dollar figures over a run's case dirs: the per-PR
 * average over the cases that recorded a price, their total, and how many of
 * the run's cases that is — a case with no price is unknown, never $0, so a
 * partly priced run says so. Empty when no case recorded a price. */
export function runCostUsd(caseDirs: readonly string[]): {
  usdPerPr?: number;
  usdTotal?: number;
  usdSource?: string;
  usdBasis?: string;
  usdPriced?: number;
  usdCases?: number;
} {
  let usd = 0,
    priced = 0;
  const sources = new Set<string>();
  const pricedAs = new Set<string>();
  for (const dir of caseDirs) {
    const k = caseCostUsd(dir);
    if (!k) continue;
    usd += k.usd;
    priced++;
    sources.add(k.source);
    if (k.model) pricedAs.add(k.model);
  }
  if (!priced) return {};
  const rates = [...pricedAs]
    .sort()
    .flatMap((m) => {
      const r = ratesFor(m);
      return r
        ? [
            `${m}: $${r.input} input, $${r.cacheRead.toFixed(2)} cache read, $${r.output} output per million`,
          ]
        : [];
    })
    .join("; ");
  return {
    usdPerPr: usd / priced,
    usdTotal: usd,
    usdSource: sources.has("claude")
      ? "Cost: Claude Code's own total_cost_usd per case (the API-price equivalent) — this arm runs no OpenAI model, so pi has no price for it."
      : sources.has("priced")
        ? `Cost: tokens priced at pi's rates (${rates}) — this arm does not run through pi.`
        : "Cost: pi's own per-call prices, summed over the main session and every lens pass.",
    ...(sources.has("claude") ? { usdBasis: "Claude Code's own" } : {}),
    usdPriced: priced,
    usdCases: caseDirs.length,
  };
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

// The benchmark's hand price table, and what a benchmark case cost.
//
// Bench only: no product path prices anything from this table. A review's
// dollars are pi's own per-call prices (packages/pi-plugin/src/pricing.ts);
// the table exists for the comparator arms that do not run through pi (the
// OCR, OpenCode and PR-Agent arms), whose tokens (the Codex bridge's counts)
// are priced at pi's rates for the model the bridge served, so every arm is
// in one currency. The Claude Code arm runs none of these models; its cost
// is Claude Code's own `total_cost_usd` (the API-price equivalent), labelled
// apart. A slim re-score bundle has no transcripts: its case-summary.json
// carries the price the export computed from the full case dir
// (`bench_cost_usd`, null = unpriced), which wins for every arm.
//
// bench/aacr/compare.py and bench/aacr/rerun_plan.py mirror the table;
// tests/bench-defects.test.ts holds the three equal.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { eventsCost, finiteNumber as num } from "@quickchatai/pi-quickreview/src/pricing.js";

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

/** The slim bundle's per-case price (bench/aacr/export_runs.py, compare.py
 * `SLIM_COST_KEY`). */
export const SLIM_COST_KEY = "bench_cost_usd";

/** What a benchmark case cost, or null when it has no price. A case that ran
 * through pi is priced from its event stream and lens ledger (the core's
 * `eventsCost`); one with a call pi stamped at zero for its tokens has no
 * price, never the sum of the rest. Any other case is priced from its
 * case-summary.json: the slim bundle's figure, Claude Code's own, or the
 * bridge's tokens at the table's rates. */
export function caseCostUsd(caseDir: string): CaseCost | null {
  const stream = eventsCost(caseDir);
  if (stream !== null) return stream.unpricedCalls > 0 ? null : { usd: stream.usd, source: "pi" };
  const summary = join(caseDir, "case-summary.json");
  if (!existsSync(summary)) return null;
  const s = JSON.parse(readFileSync(summary, "utf8")) as {
    arm?: unknown;
    cost_usd?: unknown;
    model?: unknown;
    fingerprint?: { model?: unknown };
    bridge?: { input_tokens?: unknown; cached_tokens?: unknown; output_tokens?: unknown };
    [SLIM_COST_KEY]?: unknown;
  };
  const named = typeof s.model === "string" ? s.model : s.fingerprint?.model;
  const model = typeof named === "string" ? named : "gpt-6-sol";
  if (Object.hasOwn(s, SLIM_COST_KEY)) {
    const usd = s[SLIM_COST_KEY];
    if (typeof usd !== "number" || !Number.isFinite(usd)) return null;
    return s.arm === "claude"
      ? { usd, source: "claude" }
      : s.bridge
        ? { usd, source: "priced", ...(ratesFor(model) ? { model } : {}) }
        : { usd, source: "pi" };
  }
  if (s.arm === "claude")
    return typeof s.cost_usd === "number" && Number.isFinite(s.cost_usd)
      ? { usd: s.cost_usd, source: "claude" }
      : null;
  if (!s.bridge) return null;
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

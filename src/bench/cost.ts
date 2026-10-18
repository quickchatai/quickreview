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
import { finiteNumber as num, usageCost } from "./values.js";
import { isLensTool, ledgerLineFrom, lensIdOf, lensResultsOf } from "../lensresult.js";
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

/** The slim bundle's per-case price (bench/aacr/export_runs.py, compare.py
 * `SLIM_COST_KEY`). */
export const SLIM_COST_KEY = "bench_cost_usd";

/** What the lens children of one lens tool event (`subagent`, `launch_plan`,
 * `lens`, `lens_wave`) report so far: the sum of their per-child prices. A
 * result carrying an `id` (LensResult v1) counts only when `owns` says this
 * call owns that lens run — a `lens_wave` result repeats runs the engine
 * already launched, and a second call can repeat them again. */
function toolEventCostUsd(
  e: { partialResult?: unknown; result?: unknown },
  owns: (id: string) => boolean,
): number {
  let usd = 0;
  for (const r of lensResultsOf(e.partialResult ?? e.result)) {
    const id = lensIdOf(r);
    if (id !== null && !owns(id)) continue;
    usd += usageCost((r as { usage?: { cost?: unknown } } | null)?.usage?.cost);
  }
  return usd;
}

/** Owner key of every lens run a ledger line prices. */
const LEDGER = "\0ledger";

/** A pi `--mode json` stream's running price. An assistant `message_end` adds
 * its own price. A lens tool call (`subagent`/`launch_plan`, or `lens`/
 * `lens_wave`) prices its lens children twice over its life: each `tool_execution_update` carries what they have
 * spent so far (counted as the largest value seen for that toolCallId — the
 * figure only grows, and a repeated or reordered update adds nothing), and the
 * `tool_execution_end` carries the final figure, which REPLACES that value
 * rather than adding to it. A stream with no updates (every pi-events.jsonl
 * runPi writes) prices as it always did: the ends alone.
 *
 * Each LENS RUN counts once. A result with an `id` (LensResult v1) is owned by
 * the first call — or ledger line — that reports it; every later carrier of
 * the same run adds nothing. A result without an `id` is the native shape and
 * always counts. A lens-ledger line (`add` takes the lines of
 * lens-ledger.jsonl too) prices a run no tool result reported, and a cache
 * warm-up, which only the ledger records. */
export class EventCostMeter {
  private readonly perCall = new Map<string, number>();
  /** Open tool call → its instance key (a repeated toolCallId after an end is
   * a new call). */
  private readonly instance = new Map<string, string>();
  /** Lens run id → the instance (or the ledger) that owns its price. */
  private readonly owner = new Map<string, string>();
  private total = 0;
  private settled = 0;

  private claim(id: string, who: string): boolean {
    const held = this.owner.get(id);
    if (held === undefined) {
      this.owner.set(id, who);
      return true;
    }
    return held === who;
  }

  /** Feed one event line; returns the change in the running price (negative
   * only when a call's final figure comes in under its largest live one). */
  add(line: string): number {
    if (!line.startsWith("{")) return 0;
    let e: {
      type?: string;
      toolName?: string;
      toolCallId?: unknown;
      message?: { role?: string; usage?: { cost?: { total?: unknown } } };
      partialResult?: unknown;
      result?: unknown;
    };
    try {
      e = JSON.parse(line) as typeof e;
    } catch {
      return 0;
    }
    const ledger = ledgerLineFrom(e);
    if (ledger !== null) {
      // One-shot: a ledger line read twice, or for a run a tool result owns,
      // adds nothing.
      if (this.owner.has(ledger.id)) return 0;
      this.owner.set(ledger.id, LEDGER);
      this.total += ledger.usage.cost;
      return ledger.usage.cost;
    }
    if (e.type === "message_end" && e.message?.role === "assistant") {
      const usd = num(e.message.usage?.cost?.total);
      this.total += usd;
      return usd;
    }
    if (
      (e.type !== "tool_execution_update" && e.type !== "tool_execution_end") ||
      !isLensTool(e.toolName)
    )
      return 0;
    // A call with no id cannot be matched to its end: it is its own entry.
    const id = typeof e.toolCallId === "string" ? e.toolCallId : `\0anon${this.settled++}`;
    const prev = this.perCall.get(id) ?? 0;
    const who = this.instance.get(id) ?? `${id}\0${this.settled++}`;
    this.instance.set(id, who);
    const usd = toolEventCostUsd(e, (lensId) => this.claim(lensId, who));
    const next = e.type === "tool_execution_end" ? usd : Math.max(prev, usd);
    // A finished call is closed under a fresh key: the same id turning up
    // again (pi-events.jsonl appends across a continuation's processes) is a
    // new call, priced on its own, as a line-by-line sum always did.
    if (e.type === "tool_execution_end") {
      this.instance.delete(id);
      this.perCall.delete(id);
      this.perCall.set(`\0end${this.settled++}`, next);
    } else this.perCall.set(id, next);
    // Added in stream order, so a stream with no updates sums exactly as a
    // line-by-line sum of the prices would (float addition is not associative).
    this.total += next - prev;
    return next - prev;
  }

  /** The running price over everything fed so far. */
  get totalUsd(): number {
    return this.total;
  }
}

/** What one pi `--mode json` event line costs on its own: an assistant
 * `message_end`'s price, or the children a lens tool update or end reports. Zero for any other line, or one that is not JSON. Summing it
 * over a stream that carries updates counts a call once per update — price a
 * stream with an EventCostMeter. */
export function eventLineCostUsd(line: string): number {
  return new EventCostMeter().add(line);
}

/** The round's lens ledger, beside the events in a case dir. */
export const LENS_LEDGER_FILE = "lens-ledger.jsonl";

export function caseCostUsd(caseDir: string): CaseCost | null {
  const events = join(caseDir, "pi-events.jsonl");
  if (existsSync(events)) {
    const meter = new EventCostMeter();
    for (const line of readFileSync(events, "utf8").split("\n")) meter.add(line);
    // The ledger after the events: a run a tool result already reported is
    // owned there and adds nothing here; a warm-up is added.
    const ledger = join(caseDir, LENS_LEDGER_FILE);
    if (existsSync(ledger))
      for (const line of readFileSync(ledger, "utf8").split("\n")) meter.add(line);
    return { usd: meter.totalUsd, source: "pi" };
  }
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

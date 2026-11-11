// What a review cost in dollars, the way pi prices it: the running price of a
// pi event stream, and how a spend that is partly unknown is said. Core: a
// round prices its own case dir with `eventsCost`, and a turn's dollar cap
// meters its stream with `EventCostMeter` (packages/pi-plugin/src/engine/budget.ts).
//
// pi prices every model call it makes (usage.cost on each assistant
// message_end, and a per-child total on each lens result): a round's cost is
// the sum over the main session and every lens pass.
//
// pi stamps a cost of 0 on a call of a model it has no price for, so a zero
// is not "free": a call that used tokens at a cost of exactly 0 is UNPRICED,
// the meter counts it, and a measurement with any such call has no dollar
// figure at all (`costUsd` null), never the sum of the calls that had one.
// (The usage shape and the zero stamp are pi's: a message's usage.cost.total
// is a number, a lens child's usage.cost is its sum, and a model with no
// rates in pi's catalog is priced at 0 — VERIFY-ON-PIN.)
// No price table lives here: prices are pi's.
import { isLensTool, ledgerLineFrom, lensIdOf, lensResultsOf } from "./lensresult.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** A number, or 0 for anything that is not a finite one. */
export function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Child usage accepts either a scalar cost or a total-bearing object. */
export function usageCost(value: unknown): number {
  return finiteNumber(
    typeof value === "object" && value !== null ? (value as { total?: unknown }).total : value,
  );
}

const num = finiteNumber;

/** The token fields of a pi `usage` object, a lens child's and a message's. */
const TOKEN_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;

/** Is this `usage` object pi's stamp on a call it has no price for: tokens
 * used, at a cost of exactly 0? `cost` is a number (a lens child's sum) or an
 * assistant message's `{ total }`. A call with no tokens (one that failed
 * before the model answered) cost nothing, and a usage with no cost recorded
 * says nothing either way. */
export function isUnpricedUsage(usage: unknown): boolean {
  if (typeof usage !== "object" || usage === null) return false;
  const u = usage as Record<string, unknown>;
  const raw = u["cost"];
  const cost = typeof raw === "object" && raw !== null ? (raw as { total?: unknown }).total : raw;
  if (cost !== 0) return false;
  return TOKEN_FIELDS.some((k) => num(u[k]) > 0);
}

/** A spend sum as every surface says it. `unknownRounds` is how many rounds
 * behind the sum recorded tokens and no price: `$X` with none, `$X + N rounds
 * unknown` with both, `unknown (N rounds)` when nothing was priced at all.
 * A count that is null or absent (a record written before the count existed)
 * is not a zero: the sum is said as it is, and nothing is claimed about the
 * rest. `basis` is said after the sum (`at list prices`). */
export function spendText(usd: number, unknownRounds?: number | null, basis = ""): string {
  const sum = `$${usd.toFixed(2)}${basis === "" ? "" : ` ${basis}`}`;
  const n = unknownRounds ?? 0;
  if (!(n > 0)) return sum;
  const rounds = `${n} round${n === 1 ? "" : "s"}`;
  return usd > 0 ? `${sum} + ${rounds} unknown` : `unknown (${rounds})`;
}

/** A scan's words where a dollar figure would be a zero pi stamped on a model
 * it has no price for. */
export const NO_PRICE_NO_STOP = "no price for this model: no dollar stop";

/** Did this scan run read its cases on a model pi has no price for? Every
 * call of such a model is stamped at exactly 0, so the run spent nothing it
 * could count: a case finished its reading at a cost of exactly 0, or the
 * run's own stop is 0 (its estimate was measured on such cases). A run that
 * counted any dollars is priced. */
export function scanRanUnpriced(run: {
  cap_usd: number;
  spent_usd: number;
  cases: ReadonlyArray<{ status: string; cost_usd: number | null }>;
}): boolean {
  if (run.spent_usd > 0 || run.cases.length === 0) return false;
  return run.cap_usd === 0 || run.cases.some((c) => c.status === "done" && c.cost_usd === 0);
}

/** What the lens children of one lens tool event (`subagent`, `launch_plan`,
 * `lens`, `lens_wave`) report so far: the sum of their per-child prices, and
 * how many of them are unpriced. A result carrying an `id` (LensResult v1)
 * counts only when `owns` says this call owns that lens run — a `lens_wave`
 * result repeats runs the engine already launched, and a second call can
 * repeat them again. */
function toolEventCost(
  e: { partialResult?: unknown; result?: unknown },
  owns: (id: string) => boolean,
): { usd: number; unpriced: number } {
  let usd = 0;
  let unpriced = 0;
  for (const r of lensResultsOf(e.partialResult ?? e.result)) {
    const id = lensIdOf(r);
    if (id !== null && !owns(id)) continue;
    const usage = (r as { usage?: { cost?: unknown } } | null)?.usage;
    usd += usageCost(usage?.cost);
    if (isUnpricedUsage(usage)) unpriced++;
  }
  return { usd, unpriced };
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
 * warm-up, which only the ledger records.
 *
 * UNPRICED calls are counted beside the price, by the same rules: an
 * assistant message, a lens child or a ledger line that used tokens at a cost
 * of exactly 0 (`isUnpricedUsage`). With any, `costUsd` is null: the stream
 * has no dollar figure. `totalUsd` stays the sum of what pi did price, which
 * is what a dollar cap can still be held against. */
export class EventCostMeter {
  private readonly perCall = new Map<string, number>();
  /** Open tool call → the unpriced children it reports so far. */
  private readonly perCallUnpriced = new Map<string, number>();
  /** Open tool call → its instance key (a repeated toolCallId after an end is
   * a new call). */
  private readonly instance = new Map<string, string>();
  /** Lens run id → the instance (or the ledger) that owns its price. */
  private readonly owner = new Map<string, string>();
  private total = 0;
  private unpriced = 0;
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
      if (isUnpricedUsage(ledger.usage)) this.unpriced++;
      return ledger.usage.cost;
    }
    if (e.type === "message_end" && e.message?.role === "assistant") {
      const usd = num(e.message.usage?.cost?.total);
      this.total += usd;
      if (isUnpricedUsage(e.message.usage)) this.unpriced++;
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
    const prevUnpriced = this.perCallUnpriced.get(id) ?? 0;
    const who = this.instance.get(id) ?? `${id}\0${this.settled++}`;
    this.instance.set(id, who);
    const now = toolEventCost(e, (lensId) => this.claim(lensId, who));
    const ended = e.type === "tool_execution_end";
    const next = ended ? now.usd : Math.max(prev, now.usd);
    const nextUnpriced = ended ? now.unpriced : Math.max(prevUnpriced, now.unpriced);
    // A finished call is forgotten: the same id turning up again
    // (pi-events.jsonl appends across a continuation's processes) is a new
    // call, priced on its own, as a line-by-line sum always did.
    if (ended) {
      this.instance.delete(id);
      this.perCall.delete(id);
      this.perCallUnpriced.delete(id);
    } else {
      this.perCall.set(id, next);
      this.perCallUnpriced.set(id, nextUnpriced);
    }
    // Added in stream order, so a stream with no updates sums exactly as a
    // line-by-line sum of the prices would (float addition is not associative).
    this.total += next - prev;
    this.unpriced += nextUnpriced - prevUnpriced;
    return next - prev;
  }

  /** The running price over everything fed so far: the sum of what pi priced. */
  get totalUsd(): number {
    return this.total;
  }

  /** How many calls so far used tokens at a cost of exactly 0. */
  get unpricedCalls(): number {
    return this.unpriced;
  }

  /** What the stream cost, or null when any call in it is unpriced: the
   * dollars are then unknown, never the part that had a price. */
  get costUsd(): number | null {
    return this.unpriced > 0 ? null : this.total;
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

/** What a case dir's event stream and lens ledger cost. */
export interface EventsCost {
  /** The sum of what pi priced. */
  usd: number;
  /** Calls that used tokens at a cost of exactly 0. With any, `usd` is not
   * what the stream cost: that is unknown. */
  unpricedCalls: number;
}

/** Price `caseDir`'s `pi-events.jsonl`, then its lens ledger; null when the
 * dir has no event stream. */
export function eventsCost(caseDir: string): EventsCost | null {
  const events = join(caseDir, "pi-events.jsonl");
  if (!existsSync(events)) return null;
  const meter = new EventCostMeter();
  for (const line of readFileSync(events, "utf8").split("\n")) meter.add(line);
  // The ledger after the events: a run a tool result already reported is
  // owned there and adds nothing here; a warm-up is added.
  const ledger = join(caseDir, LENS_LEDGER_FILE);
  if (existsSync(ledger))
    for (const line of readFileSync(ledger, "utf8").split("\n")) meter.add(line);
  return { usd: meter.totalUsd, unpricedCalls: meter.unpricedCalls };
}

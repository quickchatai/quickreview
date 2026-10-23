// What a round's pi event stream says about the round: its token usage, its
// per-stage cost and time (the lens calls, split into the change review and the
// pre-approval sweep), and the model-call failures it saw. Pure readers of the
// `pi --mode json` stream either runtime writes; the round records them
// (packages/pi-plugin/src/engine/round.ts), the bench reports them (src/bench/aacr.ts).
import { isLensTool, LENS_WAVE_TOOL, lensIdOf, LensOnce, lensResultsOf } from "../lensresult.js";
import { usageCost } from "../pricing.js";

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
}

// ---- pi's JSON event stream ---------------------------------------------------

/** Add one pi `usage` object's token counts to `into` (a field that is not a
 * number counts 0; a usage that is not an object adds nothing). */
function addUsage(into: Usage, x: unknown): void {
  if (typeof x !== "object" || x === null) return;
  const r = x as Record<string, unknown>;
  const n = (k: string): number => (typeof r[k] === "number" ? r[k] : 0);
  into.input += n("input");
  into.output += n("output");
  into.cacheRead += n("cacheRead");
}

/** The child results a `tool_execution_end` event of a lens tool carries
 * (`result.details.results`); [] for any other shape. A result with an `id`
 * (LensResult v1) can come back from more than one call — claim it on a
 * `LensOnce` before counting it. */
export function childResults(e: Record<string, unknown>): unknown[] {
  return lensResultsOf(e["result"]);
}

/**
 * Sum model usage from pi `--mode json` stdout lines. The parent's own turns
 * carry `usage` on every assistant `message_end`; lens passes run as child
 * processes, and the native subagent tool reports each child's usage in its
 * tool result — both are counted, and a line that is not JSON is skipped
 * (stderr noise, a truncated final line).
 */
export function usageFromEvents(lines: Iterable<string>): Usage & { children: number } {
  const u = { input: 0, output: 0, cacheRead: 0, children: 0 };
  const add = (x: unknown): void => addUsage(u, x);
  const once = new LensOnce();
  for (const line of lines) {
    if (!line.trim()) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (e["type"] === "message_end") {
      const m = e["message"] as Record<string, unknown> | undefined;
      if (m?.["role"] === "assistant") add(m["usage"]);
    }
    if (e["type"] === "tool_execution_end") {
      for (const r of childResults(e)) {
        const usage = (r as Record<string, unknown> | null)?.["usage"];
        if (usage && once.claim(lensIdOf(r))) {
          add(usage);
          u.children++;
        }
      }
    }
  }
  return u;
}

// ---- per-stage cost and time -------------------------------------------------

/** One lens tool call (`subagent`, `launch_plan`, `lens`, `lens_wave`) of the
 * main session: a lens fan-out, a validator, a re-run. */
export interface StageCall {
  /** Launch order, from 0. */
  call: number;
  tool_call_id: string | null;
  /** The agents it launched (one, or a parallel `tasks` list). */
  agents: string[];
  /** `validate` when every agent is pass-validate. */
  kind: "lens" | "validate";
  /**
   * A GUESS from launch order: `delta` up to and including the first
   * validator call, `sweep` for every call launched after that validator
   * returned. On a follow-up round that is the change review vs the
   * pre-approval sweep (its lenses and its own validator); on a round-1 case
   * a `sweep` call is a re-run after the validator.
   */
  phase: "delta" | "sweep";
  /** The main session's last message before the call — so the window
   * includes the session writing the tasks (tool-call arguments are output
   * tokens). Null when no message preceded it. */
  start_ms: number | null;
  /** The last child message; else the session's first message after the
   * call returned. Null when neither exists (a truncated stream). */
  end_ms: number | null;
  usage: Usage;
  /** pi's own price of the children ($), summed. */
  cost: number;
  children: number;
}

export interface StageTotals {
  calls: number;
  agents: number;
  usage: Usage;
  cost: number;
  /** First start to last end over the phase's calls; null when unknown. */
  start_ms: number | null;
  end_ms: number | null;
  wall_ms: number | null;
}

export interface Stages {
  calls: StageCall[];
  phases: { delta: StageTotals; sweep: StageTotals };
}

/**
 * Split one review's pi `--mode json` stream into its subagent calls, each
 * with its agents, its phase (by launch order relative to the first
 * pass-validate call — see `StageCall.phase`), its wall window and its usage
 * and cost, plus a total per phase. Pure; a line that is not JSON is skipped.
 * `tool_execution_*` events carry no timestamp, so times come from message
 * stamps: the parent's, and each child's own messages in the tool result.
 */
export function stagesFromEvents(lines: Iterable<string>): Stages {
  const calls: StageCall[] = [];
  const open = new Map<string, StageCall>();
  const awaitingEnd: StageCall[] = [];
  const once = new LensOnce();
  let lastTs: number | null = null;
  let firstValidateDone = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const m = e["message"] as Record<string, unknown> | undefined;
    const ts = typeof m?.["timestamp"] === "number" ? m["timestamp"] : null;
    if (ts !== null) {
      for (const c of awaitingEnd.splice(0)) c.end_ms = ts;
      lastTs = ts;
    }
    // `launch_plan` launches lenses through the subagent tool's own
    // execute; its args name task dirs, so its agents come from the result.
    // `lens_wave` joins a wave the engine launched: no args at all.
    if (!isLensTool(e["toolName"])) continue;
    const id = typeof e["toolCallId"] === "string" ? e["toolCallId"] : null;
    if (e["type"] === "tool_execution_start") {
      const args = (e["args"] ?? {}) as Record<string, unknown>;
      const agents =
        typeof args["agent"] === "string"
          ? [args["agent"]]
          : Array.isArray(args["tasks"])
            ? (args["tasks"] as unknown[])
                .map((t) => (t as Record<string, unknown> | null)?.["agent"])
                .filter((a): a is string => typeof a === "string")
            : [];
      const call: StageCall = {
        call: calls.length,
        tool_call_id: id,
        agents,
        kind:
          agents.length > 0 && agents.every((a) => a.startsWith("pass-validate"))
            ? "validate"
            : "lens",
        phase: firstValidateDone ? "sweep" : "delta",
        start_ms: lastTs,
        end_ms: null,
        usage: { input: 0, output: 0, cacheRead: 0 },
        cost: 0,
        children: 0,
      };
      calls.push(call);
      if (id !== null) open.set(id, call);
    } else if (e["type"] === "tool_execution_end") {
      const call = id !== null ? open.get(id) : undefined;
      if (!call) continue;
      open.delete(id!);
      const results = childResults(e);
      // A run a lens-id'd result already reported (a `lens_wave` joining a
      // wave, or joining it again) is counted by its first call only.
      const fresh = new Set(results.filter((r) => once.claim(lensIdOf(r))));
      // A launch_plan call named no agent at start: its results do.
      if (call.agents.length === 0)
        call.agents = results
          .filter((r) => fresh.has(r))
          .map((r) => (r as Record<string, unknown> | null)?.["agent"])
          .filter((a): a is string => typeof a === "string");
      let last: number | null = null;
      let first: number | null = null;
      for (const r0 of results) {
        const r = (r0 ?? {}) as Record<string, unknown>;
        const u = r["usage"] as Record<string, unknown> | undefined;
        if (u && fresh.has(r0)) {
          addUsage(call.usage, u);
          call.cost += usageCost(u["cost"]);
          call.children++;
        }
        for (const msg of Array.isArray(r["messages"]) ? (r["messages"] as unknown[]) : []) {
          const t = (msg as Record<string, unknown> | null)?.["timestamp"];
          if (typeof t !== "number") continue;
          if (last === null || t > last) last = t;
          if (fresh.has(r0) && (first === null || t < first)) first = t;
        }
      }
      // A `lens_wave` joins a wave the engine started at round start: the
      // wave's window opens with its first lens message, not with the join.
      if (e["toolName"] === LENS_WAVE_TOOL && first !== null)
        call.start_ms = call.start_ms === null ? first : Math.min(call.start_ms, first);
      if (last !== null) call.end_ms = last;
      else awaitingEnd.push(call);
      if (call.kind === "validate") firstValidateDone = true;
    }
  }
  const total = (phase: "delta" | "sweep"): StageTotals => {
    const mine = calls.filter((c) => c.phase === phase);
    const starts = mine.map((c) => c.start_ms).filter((x): x is number => x !== null);
    const ends = mine.map((c) => c.end_ms).filter((x): x is number => x !== null);
    const start = starts.length ? Math.min(...starts) : null;
    const end = ends.length ? Math.max(...ends) : null;
    return {
      calls: mine.length,
      agents: mine.reduce((n, c) => n + c.agents.length, 0),
      usage: mine.reduce(
        (u, c) => ({
          input: u.input + c.usage.input,
          output: u.output + c.usage.output,
          cacheRead: u.cacheRead + c.usage.cacheRead,
        }),
        { input: 0, output: 0, cacheRead: 0 },
      ),
      cost: mine.reduce((n, c) => n + c.cost, 0),
      start_ms: start,
      end_ms: end,
      wall_ms: start !== null && end !== null && end >= start ? end - start : null,
    };
  };
  return { calls, phases: { delta: total("delta"), sweep: total("sweep") } };
}

/** Model-call failures one review saw, by kind. `rate_limited` and
 * `overloaded` are the shared login pushing back (every bench container
 * draws on ONE ChatGPT login): a case that failed with either is retried by
 * arm.sh after a pause, never scored as the reviewer's own miss.
 * `usage_limit` is the login's PLAN window exhausted ("Codex error: The usage
 * limit has been reached", each case failing within seconds): no pause of
 * minutes cures it, so arm.sh stops launching instead of burning the retries
 * (older summaries lack this kind). */
export interface ModelErrors {
  rate_limited: number;
  overloaded: number;
  usage_limit?: number;
  other: number;
  /** One message of the most telling kind, for the log. */
  sample?: string;
}

/** The plan's usage window is spent (checked before RATE_LIMIT_RE, which it
 * would also match). */
export const USAGE_LIMIT_RE =
  /usage limit has been reached|usage[ _-]?limit[ _-]?reached|insufficient[ _-]?quota|exceeded your current quota/i;
export const RATE_LIMIT_RE = /\b429\b|rate[ _-]?limit|too many requests|usage[ _-]?limit|quota/i;
export const OVERLOAD_RE = /overloaded|\b50[23]\b|\b529\b|capacity/i;

/** A model error message's kind: a spent usage window first (its words would
 * also read as a rate limit), then a rate limit, then an overload. One
 * reading for pi's event stream and its stderr. */
export function modelErrorKind(
  message: string,
): "usage_limit" | "rate_limited" | "overloaded" | "other" {
  if (USAGE_LIMIT_RE.test(message)) return "usage_limit";
  if (RATE_LIMIT_RE.test(message)) return "rate_limited";
  if (OVERLOAD_RE.test(message)) return "overloaded";
  return "other";
}

/**
 * Count the failed model calls in pi's `--mode json` stream: every assistant
 * message with `stopReason: "error"`, the parent's and the lens children's
 * alike (children's arrive nested in the subagent tool result). pi repeats a
 * message in later events (updates, the final message list), so each is
 * counted once, keyed by its timestamp and text.
 */
export function modelErrorsFromEvents(lines: Iterable<string>): ModelErrors {
  const seen = new Set<string>();
  const out: ModelErrors = { rate_limited: 0, overloaded: 0, usage_limit: 0, other: 0 };
  const visit = (x: unknown, depth: number): void => {
    if (depth > 12 || typeof x !== "object" || x === null) return;
    if (Array.isArray(x)) {
      for (const y of x) visit(y, depth + 1);
      return;
    }
    const r = x as Record<string, unknown>;
    if (r["stopReason"] === "error" && typeof r["errorMessage"] === "string") {
      const msg = r["errorMessage"];
      const key = `${String(r["timestamp"] ?? "")}|${msg}`;
      if (!seen.has(key)) {
        seen.add(key);
        const kind = modelErrorKind(msg);
        if (kind === "usage_limit") {
          out.usage_limit = (out.usage_limit ?? 0) + 1;
          out.sample = msg.slice(0, 200);
        } else if (kind === "rate_limited") {
          out.rate_limited++;
          if (!out.usage_limit) out.sample = msg.slice(0, 200);
        } else if (kind === "overloaded") {
          out.overloaded++;
          if (!out.rate_limited && !out.usage_limit) out.sample = msg.slice(0, 200);
        } else {
          out.other++;
          out.sample ??= msg.slice(0, 200);
        }
      }
    }
    for (const v of Object.values(r)) visit(v, depth + 1);
  };
  for (const line of lines) {
    if (!line.trim() || !line.includes('"errorMessage"')) continue;
    try {
      visit(JSON.parse(line), 0);
    } catch {
      // not JSON — stderr noise or a truncated final line
    }
  }
  return out;
}

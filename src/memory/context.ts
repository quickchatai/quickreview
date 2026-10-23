// Round-memory seeding: the two pieces of memory every round prompt
// arrives carrying — the PINNED HEAD (the owner's standing instructions) and ONE
// budgeted CONTEXT BLOCK assembled for this PR.
//
// This module is the daemon's whole relationship with the context store on the
// round path. Four properties are structural, not conventions:
//
//   * ONE context call per round. `assembleRoundMemory` invokes
//     `contextBlock` exactly once and is itself called once per round
//     (src/dispatch.ts, right before the prompt is rendered). Per-pass context
//     blocks would cost ~10 extra searches per round, so the seam takes a
//     query and returns a block rather than exposing the store to callers;
//     adding per-pass blocks later means adding an assembly function here,
//     not a new client for every lens.
//   * DETERMINISTIC output. The assembler contract has no `rewrite` knob: the
//     daemon asks for a query and a token budget and nothing else, so
//     `rewrite="auto"` (an LLM rewriting the query server-side) cannot be
//     requested from this path even by accident. The daemon has no LLM in its
//     hot path and its prompts must be reproducible from the round order.
//   * Memory never blocks or delays a round. Both assembler methods resolve
//     — with the text, or with the reason it could not be read — and never
//     reject; this module additionally caps them with a deadline and swallows
//     a throw, so the worst case is a memory-less prompt `timeoutMs` later.
//     Every gap is reported back (`gaps`, `degraded`) for the caller to log
//     and alert on; none of them is ever a reason to hold a round. The one
//     wait inside a seed — for the case writer's embedding tail before the
//     search is sent (`quiet`) — is inside that same deadline.
//   * Empty is not degraded. A store that answers with nothing — no pinned
//     entries yet, nothing recalled for this PR — has answered, and that is a
//     different thing from a store that could not be read. Every adopter's
//     first review runs against a healthy store with an empty pinned area;
//     calling that an outage would make every fresh install look broken. So
//     the seam carries the distinction (`MemoryRead`) instead of collapsing both into
//     "", and only a read that did not happen is ever a gap.
//
// Nothing here knows about HTTP or OpenViking: an implementation
// of `ContextAssembler` is injected (see src/dispatch.ts `DispatchDeps.memory`).

import { withinBudget } from "../budget.js";
import { MEMORY_DEFAULTS } from "../config.js";
import { MEMORY_LESS, type MemoryGap, type RoundMemory } from "../memoryport.js";
import type { RoundActivityWindow } from "./roundactivity.js";

// The seed's shape and its renderers are the review core's (src/memoryport.ts):
// it renders a seed it is handed, and never reads memory itself.
export {
  describeGaps,
  ensurePinnedHead,
  MEMORY_LESS,
  pinnedHeadState,
  renderContextBlockSection,
  renderPinnedHeadSection,
  type MemoryGap,
  type RoundMemory,
} from "../memoryport.js";

/**
 * What one read of memory produced: the text the store holds — `""` when it
 * holds nothing, which is an ANSWER — or the reason the read could not happen.
 *
 * The two arms are the whole point of the type: a pinned area nobody has
 * written to yet and a server that refused the connection must not both read
 * as "". An implementation says which it was, and the round path believes it.
 */
export type MemoryRead =
  | { readonly status: "read"; readonly text: string }
  | { readonly status: "unreadable"; readonly reason: string };

/**
 * The seam the round path reads memory through.
 *
 * Both methods RESOLVE with a `MemoryRead` — they never reject, and a store
 * that is down is reported as `unreadable`, not thrown. That is the
 * degradation contract: a caller can always render what it gets, and a round
 * with nothing readable simply goes memory-less.
 */
export interface ContextAssembler {
  /** The owner's pinned standing instructions, already rendered. `text: ""`
   * means nothing is pinned — a fact about a healthy store, not a gap. */
  pinnedHead(): Promise<MemoryRead>;
  /** One deterministic, budgeted context block for this query. `text: ""`
   * means memory had nothing to say about this PR. `onSent`, when given, is
   * called once the search request has been ISSUED (under
   * `[memory] delivery = "on"` the round's lesson finds wait for it, so they
   * never queue ahead of the round's own search on the server's one-thread
   * embedder). Optional to honour: an implementation that never calls it only
   * makes those finds wait until the seed settles. `timeoutMs`, when given,
   * is what is LEFT of the round's seed budget when the search is asked for
   * (a seed that waited for the case writer's embedding tail sends its search
   * late) — an implementation must not let its request
   * outlive it, since a search the round has given up on is pure cost on the
   * one-thread embedder. */
  contextBlock(
    query: string,
    opts: { maxTokens: number; onSent?: () => void; timeoutMs?: number },
  ): Promise<MemoryRead>;
}




export const ROUND_CONTEXT_DEFAULTS = {
  /** Token budget for the ONE context block. */
  maxTokens: MEMORY_DEFAULTS.context_tokens,
  /** Deadline for the whole seed (head + block run concurrently). The round
   * proceeds memory-less the instant it expires — this is the ceiling on how
   * long memory may ever delay a review. Sized so a seed's query queued
   * behind one document embedding (3 s or more on the VM) still finishes.
   * Uses the same default as the parsed memory configuration. */
  timeoutMs: MEMORY_DEFAULTS.context_timeout_ms,
  /** The part of the budget a seed keeps for its SEARCH when it waits for the
   * case writer's embedding tail: the wait is at most
   * `timeoutMs - searchReserveMs`. An uncontested context search takes
   * 0.3–2.3 s on the VM. With a budget at or under the reserve a seed never
   * waits. */
  searchReserveMs: 3000,
  /** Defensive char-per-token factor for clamping an oversized block: the
   * budget is the store's job, this only stops a mis-behaving implementation
   * from blowing up a prompt. */
  charsPerToken: 6,
  /** Cap on the generated query string. */
  queryMaxChars: 600,
} as const;

/** Knobs for one seeding. Every one has a default — memory seeding must work
 * with nothing configured. */
export interface RoundMemoryOptions {
  maxTokens?: number;
  timeoutMs?: number;
  now?: () => number;
  log?: (msg: string, extra?: unknown) => void;
  /** Handed to `contextBlock` as its `onSent`. Absent ⇒ the assembler is
   * asked with `{ maxTokens }` alone. */
  onContextSent?: () => void;
  /** Wait, before the context search is SENT, until the case writer's
   * batches are estimated to be done embedding
   * (`RoundActivityWindow.whenEmbedderQuiet`); resolves with the ms waited.
   * The wait is INSIDE the seed's budget — at most `timeoutMs -
   * searchReserveMs` — so the seed never takes longer than `timeoutMs`, and
   * the search is then told the time left (`contextBlock`'s `timeoutMs`).
   * The pinned head is read at once: it is a listing, not an embedding.
   * Absent ⇒ no wait and no `timeoutMs` for the assembler. Total: a
   * wait that throws or rejects counts as no wait. */
  quiet?: (maxWaitMs: number) => Promise<number>;
  /** Overrides `ROUND_CONTEXT_DEFAULTS.searchReserveMs`. */
  searchReserveMs?: number;
}

/** What dispatch is handed to seed a round: the assembler plus its knobs. */
export interface RoundMemorySeed {
  assembler: ContextAssembler;
  maxTokens?: number;
  timeoutMs?: number;
  /** Told about every round's seed AFTER the round was built — the memory
   * health monitor's view of the round path (`src/memory/health.ts`). The
   * operator is told by the monitor, on state transitions, through
   * status.json and the TUI. Must not throw; a throw is logged and swallowed. */
  onSeeded?: (mem: RoundMemory) => void;
  /** Told the round's context query BEFORE memory is asked: the
   * daemon publishes it as the PR session's recall hint, so the session's own
   * per-prompt recall searches for this PR (and only `experiences/`) instead
   * of embedding the round order's fixed header. A local file write — it
   * never touches the store and never delays the round. Must not throw; a
   * throw is logged and swallowed. */
  publishQuery?: (pr: number, query: string) => void;
  /** The round's MEMORY WINDOW (src/memory/roundactivity.ts):
   * dispatch opens one before the seed and closes it once the round's lesson
   * selection has taken over (or the round's handoff ended without one), so
   * the case writer starts no batch in front of the round's reads on the
   * one-thread embedder. Bookkeeping only — it never delays the round.
   * It also carries the case writer's EMBEDDING TAIL
   * (`whenEmbedderQuiet`): the seed's search waits it out, inside `timeoutMs`
   * and leaving `searchReserveMs` of it for the search. */
  activity?: RoundActivityWindow;
  /** Overrides `ROUND_CONTEXT_DEFAULTS.searchReserveMs` (tests). */
  searchReserveMs?: number;
}

/** The slice of a changed file the query builder reads. */
export interface ContextQueryFile {
  filename: string;
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function clamp(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max).trimEnd();
}

/** Count occurrences, then order by count desc, key asc — so the query is a
 * function of the file SET, never of the order the files API returned them. */
function topKeys(keys: string[], limit: number): string[] {
  const counts = new Map<string, number>();
  for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => (b[1] - a[1] !== 0 ? b[1] - a[1] : a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, limit)
    .map(([k]) => k);
}

/** The first two path segments of a file's directory — "src/tui", "backend",
 * "" for a root file. Two segments is the level at which this codebase's
 * areas are named; the full path would make every query unique. */
function areaOf(filename: string): string {
  const parts = filename.split("/");
  parts.pop();
  return parts.slice(0, 2).join("/");
}

function extOf(filename: string): string {
  const base = filename.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot) : "";
}

/**
 * The ONE query the round's context block is asked for: the PR's title plus
 * its diff shape (the areas it touches and the file kinds it touches them
 * with). Pure and order-independent — the same PR at the same head always
 * produces the same query, which is what makes the daemon's prompt
 * reproducible from the round order.
 */
export function roundContextQuery(input: { title: string; files: readonly ContextQueryFile[] }): string {
  const title = collapse(input.title);
  const names = input.files.map((f) => f.filename);
  const areas = topKeys(names.map(areaOf).filter((a) => a !== ""), 6);
  const exts = topKeys(names.map(extOf).filter((e) => e !== ""), 4);
  const shape = [...areas, ...exts].join(" ");
  return clamp([title, shape].filter((p) => p !== "").join(" — "), ROUND_CONTEXT_DEFAULTS.queryMaxChars);
}

/** A short, log-safe spelling of a value that broke the contract. */
function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return `a string (${value.length} chars)`;
  return typeof value === "object" ? `an object with keys [${Object.keys(value).join(", ")}]` : `a ${typeof value}`;
}

/**
 * Run `fn` with a deadline, turning every way the text can fail to arrive —
 * a timeout, an `unreadable` answer, a throw, a settled value that is not a
 * `MemoryRead` at all — into "" plus a gap. A `read` answer is returned as its
 * text, empty or not, and is never a gap.
 * The timer is cleared on settle and unref'd where the runtime allows it, so a
 * slow memory call can neither delay the round nor keep the process alive.
 */
async function guarded(
  part: MemoryGap["part"],
  timeoutMs: number,
  fn: () => Promise<MemoryRead>,
  gaps: MemoryGap[],
  log: (msg: string, extra?: unknown) => void,
): Promise<string> {
  try {
    // Defer the call so a synchronous throw remains inside this refusal path.
    const result = await withinBudget(Promise.resolve().then(fn), timeoutMs);
    if (result.kind === "budget") {
      gaps.push({ part, reason: "timeout" });
      log(`memory: ${part} timed out after ${timeoutMs}ms — round proceeds memory-less`);
      return "";
    }
    const value = result.value;
    if (value.status === "unreadable") {
      gaps.push({ part, reason: `unreadable: ${clamp(collapse(value.reason), 200)}` });
      log(`memory: ${part} unreadable (${value.reason}) — round proceeds memory-less`);
      return "";
    }
    if (value.status === "read") return value.text;
    // Unreachable from a TypeScript caller, reachable from an untyped
    // assembler (e.g. one returning a bare string). A broken client is a
    // gap, never a rejection — "total" has to hold for the value, not only
    // for the type.
    gaps.push({ part, reason: `error: assembler returned ${describeValue(value)}, not a MemoryRead` });
    log(`memory: ${part} answered outside the contract — round proceeds memory-less`, value);
    return "";
  } catch (err) {
    // The contract says these never reject; if one does, that is a bug in the
    // client, not a reason to lose a review round.
    gaps.push({ part, reason: `error: ${String(err)}` });
    log(`memory: ${part} failed — round proceeds memory-less`, err);
    return "";
  }
}

/**
 * Assemble one round's memory: the pinned head and exactly ONE context block,
 * fetched concurrently and both capped by the same deadline.
 *
 * Total by construction — it resolves for every input, including no assembler
 * at all, a throwing assembler and one that never settles. Callers log
 * `degraded`/`gaps` and carry on; nothing here can hold a round.
 */
export async function assembleRoundMemory(
  assembler: ContextAssembler | undefined | null,
  query: string,
  opts: RoundMemoryOptions = {},
): Promise<RoundMemory> {
  const maxTokens = opts.maxTokens ?? ROUND_CONTEXT_DEFAULTS.maxTokens;
  const timeoutMs = opts.timeoutMs ?? ROUND_CONTEXT_DEFAULTS.timeoutMs;
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? (() => {});
  if (!assembler) return { ...MEMORY_LESS, query, max_tokens: maxTokens };

  const started = now();
  const gaps: MemoryGap[] = [];
  // The context search may first wait for the case writer's embedding
  // tail — inside the budget, leaving the search its reserve.
  const quiet = opts.quiet;
  const reserve = Math.max(0, opts.searchReserveMs ?? ROUND_CONTEXT_DEFAULTS.searchReserveMs);
  const maxQuietWait = Math.max(0, timeoutMs - reserve);
  let quietWaitMs: number | undefined;
  let quietFrom: number | undefined;
  const askContext = (): Promise<MemoryRead> => {
    const base: { maxTokens: number; onSent?: () => void } = opts.onContextSent
      ? { maxTokens, onSent: opts.onContextSent }
      : { maxTokens };
    if (!quiet) return assembler.contextBlock(query, base);
    quietFrom = now();
    return waitQuiet(quiet, maxQuietWait).then((waited): Promise<MemoryRead> | MemoryRead => {
      quietWaitMs = waited;
      const left = timeoutMs - Math.max(0, now() - started);
      // The deadline already passed (a zero reserve): the round has gone on
      // memory-less, and a search sent now would be pure cost.
      if (left <= 0) return { status: "unreadable", reason: "the seed's budget ran out first" };
      return assembler.contextBlock(query, { ...base, timeoutMs: left });
    });
  };
  // Exactly one call to each method, both in flight at once: the seed costs
  // one round trip of latency, not two.
  const [head, rawBlock] = await Promise.all([
    guarded("head", timeoutMs, () => assembler.pinnedHead(), gaps, log),
    // No `rewrite` is passed — the daemon never asks the store to rewrite its
    // query, so the round prompt stays a pure function of the round order.
    guarded("context", timeoutMs, askContext, gaps, log),
  ]);
  // A wait the deadline overtook is still a wait: what it lasted, not 0.
  if (quietWaitMs === undefined && quietFrom !== undefined)
    quietWaitMs = Math.max(0, now() - quietFrom);
  if (quietWaitMs !== undefined && quietWaitMs > 0)
    log(
      `memory: the context search waited ${quietWaitMs}ms for the case writer's embedding tail (the seed's budget is ${timeoutMs}ms)`,
    );

  const charBudget = maxTokens * ROUND_CONTEXT_DEFAULTS.charsPerToken;
  const clamped = rawBlock.length > charBudget;
  const block = clamped ? `${rawBlock.slice(0, charBudget).trimEnd()}\n… (context block cut at the round's char budget)` : rawBlock;
  if (clamped) log(`memory: context block over budget (${rawBlock.length} chars) — cut to ${charBudget}`);

  return {
    asked: true,
    head: head.trim(),
    block: block.trim(),
    query,
    max_tokens: maxTokens,
    // Only a read that did not happen is a gap. An empty head and an empty
    // block are answers — a fresh install has nothing pinned and a healthy
    // store may have nothing to say about this PR — and neither degrades.
    degraded: gaps.length > 0,
    clamped,
    gaps,
    ms: Math.max(0, now() - started),
    ...(quiet ? { quiet_wait_ms: quietWaitMs ?? 0 } : {}),
  };
}

/** The bounded wait for the embedder, made total: a wait that throws,
 * rejects or answers nonsense counts as no wait. Never longer than `maxMs`
 * by its own word — the seed's deadline (`guarded`) is the belt. */
async function waitQuiet(
  quiet: (maxWaitMs: number) => Promise<number>,
  maxMs: number,
): Promise<number> {
  if (maxMs <= 0) return 0;
  try {
    const waited = await quiet(maxMs);
    return typeof waited === "number" && Number.isFinite(waited)
      ? Math.max(0, Math.min(maxMs, Math.round(waited)))
      : 0;
  } catch {
    return 0;
  }
}


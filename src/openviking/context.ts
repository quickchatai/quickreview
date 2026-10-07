// `ContextAssembler` over OpenViking — the round path's half of the
// memory engine.
//
// The interface itself belongs to the round-seeding slice
// (`src/memory/context.ts`) and is IMPORTED, not restated: its contract — both
// methods resolve with a `MemoryRead`, `read` with the text ("" when the store
// holds nothing, which is an answer) or `unreadable` with the reason, and
// neither ever rejects — is the load-bearing part, and a second declaration of
// it would be free to drift.
//
// This module is where that contract is honoured against a real network. Every
// path out of here has exactly three outcomes: the text, an empty text, or
// `unreadable` with the reason — there is no fourth, and nothing is thrown.
// `assembleRoundMemory` already caps both calls with a deadline and swallows
// throws, so this file could in principle be sloppier; it is not, because a
// store that throws would spend the round's whole memory deadline getting to
// the same answer, and "memory must never DELAY a round" is half of the
// invariant.
//
// The two halves are asymmetric on purpose:
//
//   * pinnedHead() is EXACT and GUARANTEED. The owner's standing instructions
//     are delivered verbatim, in full, every round, so it reads the stored
//     bytes — never a search, whose budget and tier degradation could
//     silently truncate an instruction. Since S5 it reads the pinned
//     DIRECTORY alone (`preferences/pinned/`, `store.pinnedSweep()`): one
//     listing and the few files in it, where it used to read all ~176 files
//     of the store every round to find the pinned ones.
//   * contextBlock() is BUDGETED and APPROXIMATE. It is the server's own
//     assembled block: one deterministic `mode: "context"` search, rendered
//     server-side, pasted verbatim. Determinism is pinned inside the client
//     (`rewrite`/`query_expansion` off) rather than requested here, so this
//     module cannot ask for an LLM in the daemon's hot path even by accident.
//     Since S5 it searches `experiences/` ONLY (`ROUND_SEARCH_AREAS`):
//     the quotas name nothing else whatever config.toml says, and an entry
//     from anywhere else that comes back anyway is dropped — no ops notes, no
//     raw feedback events, no folder blurbs in a round.
import type { ContextAssembler, MemoryRead } from "../memory/context.js";
import { ROUND_SEARCH_AREAS } from "../memory/layout.js";
import type { ContextSearchOptions, ContextSearchResult, OpenVikingClient } from "./client.js";
import type { OpenVikingStore } from "./store.js";

/** The quota each round-search area gets when config names none of them. */
export const DEFAULT_ROUND_QUOTA = 24;

/**
 * The round search's quotas: the configured ones, cut to the areas a round
 * may search (`ROUND_SEARCH_AREAS` — `experiences` alone), each defaulted
 * when config gives it no positive count. Pure.
 */
export function roundSearchQuotas(
  configured: Readonly<Record<string, number>> | undefined,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const area of ROUND_SEARCH_AREAS) {
    const n = configured?.[area];
    out[area] =
      typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_ROUND_QUOTA;
  }
  return out;
}

/** Is this recalled URI inside an area a round may search? */
export function inRoundSearchScope(uri: string): boolean {
  return ROUND_SEARCH_AREAS.some((area) => uri.includes(`/memories/${area}/`));
}

export interface OpenVikingContextOptions {
  client: OpenVikingClient;
  store: OpenVikingStore;
  /** Per-category caps for the context search (`[memory] context_quotas`).
   * Only the round-search areas are honoured (`roundSearchQuotas`): a key for
   * any other bucket is dropped, with one log line. */
  quotas?: Record<string, number>;
  /** Deadline for the ONE context search. Shorter than the client's default:
   * the round's own memory deadline is ~3s and a request that outlives it is
   * pure cost. */
  searchTimeoutMs?: number;
  log?: (msg: string, extra?: unknown) => void;
}

const DEFAULT_SEARCH_TIMEOUT_MS = 2_500;

export class OpenVikingContextAssembler implements ContextAssembler {
  private readonly client: OpenVikingClient;
  private readonly store: Pick<OpenVikingStore, "pinnedSweep" | "retiredUris">;
  private readonly quotas: Record<string, number>;
  private readonly searchTimeoutMs: number;
  private readonly log: (msg: string, extra?: unknown) => void;

  /** The stats of the last context search, for the caller that wants to know
   * what the budget actually bought. Read-only bookkeeping — nothing in the
   * round path depends on it, so a caller that ignores it loses nothing. */
  lastSearch: ContextSearchResult | null = null;

  constructor(opts: OpenVikingContextOptions) {
    this.client = opts.client;
    this.store = opts.store;
    this.quotas = roundSearchQuotas(opts.quotas);
    this.searchTimeoutMs = opts.searchTimeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS;
    this.log = opts.log ?? (() => {});
    const ignored = Object.keys(opts.quotas ?? {}).filter((k) => !ROUND_SEARCH_AREAS.includes(k));
    if (ignored.length > 0)
      this.log(
        `openviking: [memory] context_quotas ${ignored.join(", ")} ignored — a round searches ${ROUND_SEARCH_AREAS.join(", ")} only (S5)`,
      );
  }

  /**
   * The owner's pinned standing instructions, oldest first, verbatim — the
   * pinned directory and nothing else (S5).
   *
   * Three answers, kept apart: the text; `text: ""` when the pinned
   * area was read whole and holds nothing — every fresh install, and not a
   * gap; and `unreadable` when the pinned area could not be listed, or any
   * file in it read. The last is strict on purpose: the head is EXACT and
   * GUARANTEED, so a read that skipped even one pinned file cannot vouch
   * that no standing instruction was in it, and says so rather than
   * delivering a head that might be missing one. The rest of the store is
   * never read here — an unreadable lesson elsewhere is not the head's gap.
   */
  async pinnedHead(): Promise<MemoryRead> {
    try {
      const { entries, unread } = await this.store.pinnedSweep();
      if (unread.length > 0) {
        const reason =
          unread.length === 1 ? unread[0]! : `${unread[0]} (+${unread.length - 1} more)`;
        this.log(
          `openviking: pinned head unreadable (${reason}) — the round proceeds without standing instructions`,
        );
        return { status: "unreadable", reason };
      }
      const text = entries
        .map((e) => e.text.trim())
        .filter((t) => t !== "")
        .join("\n\n");
      return { status: "read", text };
    } catch (err) {
      this.log(
        "openviking: pinned head unavailable — the round proceeds without standing instructions",
        err,
      );
      return { status: "unreadable", reason: String(err) };
    }
  }

  /**
   * ONE deterministic, budgeted context block, rendered by the server.
   *
   * `rendered` is used rather than re-rendering `entries` locally: the server
   * did the budgeting, and a second renderer here would be a second place for
   * the token budget to be wrong. The one exception is a retired entry that
   * leaked past the exclusion cap (see below).
   */
  async contextBlock(
    query: string,
    opts: { maxTokens: number; onSent?: () => void },
  ): Promise<MemoryRead> {
    try {
      // A retirement is a header tag on a file that stays in the indexed root,
      // so the search is told to skip it; `read()` filtering it is not enough.
      // Answered from the last completed sweep, so the search is never queued
      // behind a sweep inside the round's deadline; the store refreshes that
      // sweep in the background for the next round (the head no longer sweeps
      // the store, S5). A sweep that fails yields no exclusions rather
      // than no block.
      const excludeUris = await this.store.retiredUris().catch(() => [] as string[]);
      const search: ContextSearchOptions = {
        maxTokens: opts.maxTokens,
        purpose: "coding",
        timeoutMs: this.searchTimeoutMs,
        // `experiences/` alone (S5) — never the server's own balance
        // across every scope, never an area config.toml adds.
        quotas: this.quotas,
        ...(excludeUris.length > 0 ? { excludeUris } : {}),
      };
      // Issue the search, THEN say so (S9b): the client reaches its
      // `fetch` synchronously, so by the time `onSent` runs the round's own
      // search is ahead of any lesson find the signal releases.
      const pending = this.client.searchContext(query, search);
      if (opts.onSent) {
        try {
          opts.onSent();
        } catch {
          /* a signal, never a reason to lose the block */
        }
      }
      const res = await pending;
      if (!res.ok) {
        this.lastSearch = null;
        return { status: "unreadable", reason: `search ${res.code}: ${res.message}` };
      }
      this.lastSearch = res.result;
      // Two leaks the request alone cannot rule out, and one remedy. The
      // request carries at most EXCLUDE_URIS_CAP exclusions, so past that many
      // retirements the server can hand a retired entry back; and an entry
      // from outside `experiences/` (a folder blurb, an event) must never
      // reach a round, whatever the server's buckets do. The server's block
      // cannot be edited safely, so a leak rebuilds the block from the
      // surviving entries' text — the only time this module renders.
      const retired = new Set(excludeUris);
      const kept = res.result.entries.filter(
        (e) => !retired.has(e.uri) && inRoundSearchScope(e.uri),
      );
      if (kept.length < res.result.entries.length) {
        this.log(
          `openviking: context search returned ${res.result.entries.length - kept.length} retired or out-of-scope entr(ies) — dropped`,
        );
        const text = kept
          .map((e) => e.text.trim())
          .filter((t) => t !== "")
          .join("\n\n");
        return { status: "read", text };
      }
      return { status: "read", text: res.result.rendered };
    } catch (err) {
      this.lastSearch = null;
      this.log("openviking: context search failed — the round proceeds memory-less", err);
      return { status: "unreadable", reason: String(err) };
    }
  }
}

/** The assembler the round path is wired with. */
export function openVikingContextAssembler(
  opts: OpenVikingContextOptions,
): OpenVikingContextAssembler {
  return new OpenVikingContextAssembler(opts);
}

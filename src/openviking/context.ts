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
//     bytes through the store's sweep — never a search, whose budget and tier
//     degradation could silently truncate an instruction.
//   * contextBlock() is BUDGETED and APPROXIMATE. It is the server's own
//     assembled block: one deterministic `mode: "context"` search, rendered
//     server-side, pasted verbatim. Determinism is pinned inside the client
//     (`rewrite`/`query_expansion` off) rather than requested here, so this
//     module cannot ask for an LLM in the daemon's hot path even by accident.
import type { ContextAssembler, MemoryRead } from "../memory/context.js";
import type { ContextSearchOptions, ContextSearchResult, OpenVikingClient } from "./client.js";
import type { OpenVikingStore } from "./store.js";

export interface OpenVikingContextOptions {
  client: OpenVikingClient;
  store: OpenVikingStore;
  /** Per-category caps for the context search. Keys must be server quota
   * buckets; unknown ones are dropped by the client with a gap. */
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
  private readonly store: OpenVikingStore;
  private readonly quotas: Record<string, number> | undefined;
  private readonly searchTimeoutMs: number;
  private readonly log: (msg: string, extra?: unknown) => void;

  /** The stats of the last context search, for the caller that wants to know
   * what the budget actually bought. Read-only bookkeeping — nothing in the
   * round path depends on it, so a caller that ignores it loses nothing. */
  lastSearch: ContextSearchResult | null = null;

  constructor(opts: OpenVikingContextOptions) {
    this.client = opts.client;
    this.store = opts.store;
    this.quotas = opts.quotas;
    this.searchTimeoutMs = opts.searchTimeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS;
    this.log = opts.log ?? (() => {});
  }

  /**
   * The owner's pinned standing instructions, oldest first, verbatim.
   *
   * Three answers, kept apart: the text; `text: ""` when the sweep
   * read the whole store and nothing in it is pinned — every fresh install,
   * and not a gap; and `unreadable` when any part of the store could not be
   * read. The last is strict on purpose: the head is EXACT and GUARANTEED, so
   * a sweep that skipped even one entry cannot vouch that no standing
   * instruction was in it, and says so rather than delivering a head that
   * might be missing one.
   */
  async pinnedHead(): Promise<MemoryRead> {
    try {
      const { entries, unread } = await this.store.sweep();
      if (unread.length > 0) {
        const reason =
          unread.length === 1 ? unread[0]! : `${unread[0]} (+${unread.length - 1} more)`;
        this.log(
          `openviking: pinned head unreadable (${reason}) — the round proceeds without standing instructions`,
        );
        return { status: "unreadable", reason };
      }
      const text = entries
        .filter((e) => e.pinned)
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
  async contextBlock(query: string, opts: { maxTokens: number }): Promise<MemoryRead> {
    try {
      // A retirement is a header tag on a file that stays in the indexed root,
      // so the search is told to skip it; `read()` filtering it is not enough.
      // Answered from the last completed sweep (the pinned head's), so the
      // search is never queued behind a sweep inside the round's deadline. A
      // sweep that fails yields no exclusions rather than no block.
      const excludeUris = await this.store.retiredUris().catch(() => [] as string[]);
      const search: ContextSearchOptions = {
        maxTokens: opts.maxTokens,
        purpose: "coding",
        timeoutMs: this.searchTimeoutMs,
        ...(this.quotas ? { quotas: this.quotas } : {}),
        ...(excludeUris.length > 0 ? { excludeUris } : {}),
      };
      const res = await this.client.searchContext(query, search);
      if (!res.ok) {
        this.lastSearch = null;
        return { status: "unreadable", reason: `search ${res.code}: ${res.message}` };
      }
      this.lastSearch = res.result;
      // The request carries at most EXCLUDE_URIS_CAP exclusions, so past that
      // many retirements the server can hand a retired entry back. The
      // server's block cannot be edited safely, so a leak rebuilds the block
      // from the surviving entries' text — the only time this module renders.
      const retired = new Set(excludeUris);
      const kept = res.result.entries.filter((e) => !retired.has(e.uri));
      if (kept.length < res.result.entries.length) {
        this.log(
          `openviking: context search returned ${res.result.entries.length - kept.length} retired entr(ies) past the exclusion cap — dropped`,
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

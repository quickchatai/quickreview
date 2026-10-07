import type { OVClient } from "./client.js";
import type { OVConfig } from "./config.js";
import { buildRecallBlock } from "./shared/recall-core.mjs";
// [QCR PATCH 7]
import { budgetedFetch, raceBudget, RECALL_WAIT_MS, retiredGuard } from "./qcr-recall.js";
// [QCR PATCH 8]
import { scopeGuard } from "./qcr-hint.js";

export interface RecallCache {
  block: string | null;
  promptText: string;      // the query this cache is for
}

/** [QCR PATCH 7] What the recall manager needs beyond the client. */
export interface RecallOptions {
  /** The retired URIs to exclude (the daemon's published list). */
  retiredUris?: () => readonly string[];
  /** Millisecond clock for the recall deadline. Tests inject one. */
  now?: () => number;
}

export class RecallManager {
  private client: OVClient;
  private config: OVConfig;
  private cache: RecallCache = { block: null, promptText: "" };
  private pendingPrompt = "";
  // [QCR PATCH 8] The memory areas the pending recall may draw from; null =
  // unscoped (upstream's behaviour).
  private pendingScope: readonly string[] | null = null;
  // Read lazily: the session manager that owns this id is constructed after the
  // recall manager, and the id only exists once a session has been opened.
  private sessionId: () => string | null;
  // [QCR PATCH 7]
  private retiredUris: () => readonly string[];
  private now: () => number;

  constructor(
    client: OVClient,
    config: OVConfig,
    sessionId: () => string | null = () => null,
    opts: RecallOptions = {},
  ) {
    this.client = client;
    this.config = config;
    this.sessionId = sessionId;
    this.retiredUris = opts.retiredUris ?? (() => []);
    this.now = opts.now ?? Date.now;
  }

  /** [QCR PATCH 8] `scope` keeps the recall inside those memory areas (a PR
   * session's hint: `experiences` alone); omitted = unscoped. */
  queueSearch(userQuery: string, scope: readonly string[] | null = null): void {
    this.pendingPrompt = userQuery;
    this.pendingScope = scope && scope.length > 0 ? [...scope] : null;
  }

  /**
   * [QCR PATCH 7] Bounded: the whole recall — every request of it, fallbacks
   * included — runs on ONE deadline `budgetMs` from now, capped at
   * `RECALL_WAIT_MS` (owner ruling R3, S3). A recall that misses it is
   * "no recall for this run": the turn proceeds, and a late answer is dropped
   * rather than injected into a later turn (that would rewrite a message the
   * provider has already cached). Retired entries are excluded and filtered
   * (`retiredGuard`).
   */
  async searchPending(budgetMs: number = RECALL_WAIT_MS): Promise<string | null> {
    if (!this.pendingPrompt) return this.cache.block;

    const userQuery = this.pendingPrompt;
    this.pendingPrompt = "";
    // [QCR PATCH 8]
    const scope = this.pendingScope;
    this.pendingScope = null;
    if (userQuery.trim().length < this.config.minQueryLength) {
      this.cache = { block: null, promptText: userQuery };
      return null;
    }

    const budget = Math.max(0, Math.min(Number(budgetMs) || 0, RECALL_WAIT_MS));
    const deadline = this.now() + budget;
    // [QCR PATCH 8] …and kept inside the hint's areas (`scopeGuard`).
    const fetch = scopeGuard(
      retiredGuard(
        budgetedFetch(
          // 10s was this extension's own budget for a bare retrieval; the
          // deadline above now caps every request at the time left on it.
          (path: string, init?: any, options?: any) =>
            this.client.fetchJSON(path, init, options?.timeoutMs ?? 10000),
          deadline,
          this.now,
        ),
        this.retiredUris,
      ),
      () => scope,
    );
    const { value: block } = await raceBudget(
      buildRecallBlock(fetch, this.config as any, userQuery, {
        actorPeerId: this.config.peerId,
        // The OV session id buys the cross-turn dedup ledger; query
        // expansion, which it would also turn on, is forced off in config.ts.
        sessionId: this.sessionId() ?? "",
      }),
      deadline - this.now(),
      null as string | null,
    );
    this.cache = { block, promptText: userQuery };
    return block;
  }

  // --- Injection ---

  injectRecall(messages: any[]): any[] {
    if (!this.cache.block) return messages;

    // Find the user message (scan backwards)
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "user") {
        // Idempotency check
        const content = typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("")
            : "";

        if (content.includes("<openviking-context")) break;

        // Prepend block to user message
        const block = this.cache.block;
        if (typeof msg.content === "string") {
          msg.content = block + "\n" + msg.content;
        } else if (Array.isArray(msg.content)) {
          const textBlocks = msg.content.filter((b: any) => b.type === "text");
          if (textBlocks.length > 0) {
            (textBlocks[0] as any).text = block + "\n" + (textBlocks[0] as any).text;
          }
        }
        break;
      }
    }
    return messages;
  }

  invalidate(): void {
    this.cache = { block: null, promptText: "" };
    this.pendingPrompt = "";
    this.pendingScope = null;
  }
}

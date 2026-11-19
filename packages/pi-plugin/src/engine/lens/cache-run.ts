// The runtime side of lens cache groups: who shares a group, when a group
// is warm, and when its sessions may be disposed. Pure over its injected clock
// and key source (no pi, no filesystem); the runner supplies the sessions.
//
// A group's lens sessions share ONE session id, which is its cache key: pi
// derives prompt_cache_key and the routing headers from the session id, so
// that is what puts the group's requests on one backend cache
// (docs/probes/p4.6-codex-cache-routing.md). The price is in dispose: pi's
// session.dispose() runs cleanupSessionResources(sessionId), which closes
// every provider transport held for that id, a sibling's live websocket
// included. So no session of a group is disposed until the whole group is done:
// each member leases the group, hands its finished sessions over with keep(),
// and the last release disposes them together.
//
// The shared id is for every API: where a provider has no cache routing keyed
// on it, the id is harmless. What is not for every API is the pack: a group is
// PACKED (warm-up, wait, pack-first requests) only when its model speaks an API
// of the family the rewrite is built for (leaf-cache.ts PACK_FIRST_APIS). The
// runner decides that per model, before a pass joins its group (runlens.ts),
// so every member of a group takes the same path.
//
// Seen in production at pi 1.3.0: cleanupSessionResources closes by session id
// alone (groups disposed their sessions together, and no sibling lens failed after).
import { CacheGrouper, type CacheSlot } from "./cache-group.js";
import { PACK_CLOSING, prefixDifference, type PrefixDigest } from "./leaf-cache.js";

/** The longest a packed group's lens waits for its warm-up. */
export const WARMUP_WAIT_MS = 30_000;
/** The warm-up's whole prompt: the message that closes the pack, which asks
 * for one word when nothing follows it. The warm-up exists to put the pack in
 * the cache, and its request must end where the shared prefix ends
 * (leaf-cache.ts `PACK_CLOSING`), so it says nothing of its own. */
export const WARMUP_REPLY_TASK = PACK_CLOSING;

/** What the group disposes: a pi session, as far as the group knows it. */
export interface Retired {
  dispose(): void;
}

/** A lens's first turn counts as read from its group's warm-up when it read at
 * least this share of what the warm-up sent. */
export const TURN1_HOT_SHARE = 0.9;

/** What a cache key's sessions were seen to do, for as long as the runner
 * lives: a late pass joins a key whose first members are long done. */
export interface CacheKeyFacts {
  /** The warm-up's first request, as sent. */
  warmup?: PrefixDigest;
  /** The tokens the warm-up's request held (uncached and cached). */
  warmupInput?: number;
  /** Passes of the key whose first turn was read. */
  turn1: number;
  /** Those that read the warm-up from cache (TURN1_HOT_SHARE). */
  turn1Hot: number;
  /** A pass's request did not extend the warm-up's, and this was said. */
  differenceTold: boolean;
}

/** One group's shared state while any member is alive. */
class Lifetime {
  members = 0;
  readonly sessions: Retired[] = [];
  /** The group's warm-up, memoised: set once, by the group's first lens. */
  warmup: Promise<void> | undefined;
}

/** A member's hold on its group. Released exactly once. */
export class CacheLease {
  private released = false;

  constructor(
    readonly key: string,
    /** Whether this member is the group's first. */
    readonly first: boolean,
    /** How long a member of a group that is not packed should wait before starting. */
    readonly delayMs: number,
    private readonly life: Lifetime,
    private readonly leave: () => void,
    private readonly facts: CacheKeyFacts,
    private readonly used: (nowMs: number) => void = () => {},
  ) {}

  /** Whether a pass that finds no warm-up running should start one: the key
   * was never warmed (its first pass is this one, or its warm-up failed). A
   * late pass of a key that was warmed reads that cache and starts none. */
  needsWarmup(): boolean {
    return this.life.warmup === undefined && this.facts.warmupInput === undefined;
  }

  /** The warm-up's first request, as it was sent. */
  warmedWith(digest: PrefixDigest): void {
    this.facts.warmup ??= digest;
  }

  /** How many tokens the warm-up's request held. */
  warmedInput(tokens: number): void {
    if (tokens > 0) this.facts.warmupInput ??= tokens;
  }

  /**
   * The part in which a pass's first request does not extend the group's
   * warm-up, the first time one does not; undefined when it does, when the
   * warm-up's request is not known, and for every later pass of the key (one
   * line per key says it).
   */
  differenceFromWarmup(digest: PrefixDigest): string | undefined {
    if (this.facts.warmup === undefined || this.facts.differenceTold) return undefined;
    const part = prefixDifference(this.facts.warmup, digest);
    if (part !== undefined) this.facts.differenceTold = true;
    return part;
  }

  /** A pass's first turn: what it paid for and what it read from cache. True
   * when it read the warm-up; undefined when the warm-up's size is not known. */
  firstTurn(turn: { input: number; cacheRead: number }): boolean | undefined {
    const warm = this.facts.warmupInput;
    if (warm === undefined) return undefined;
    const hot = turn.cacheRead >= TURN1_HOT_SHARE * warm;
    this.facts.turn1 += 1;
    if (hot) this.facts.turn1Hot += 1;
    return hot;
  }

  /** A finished session, to be disposed with the group, never before. */
  keep(session: Retired): void {
    this.life.sessions.push(session);
  }

  /** The group's warm-up if one was started, to await. */
  warmup(): Promise<void> | undefined {
    return this.life.warmup;
  }

  /**
   * Start the group's warm-up unless it already started; return it either way.
   * `run` never rejects; it is handed `keep` for the session it makes. The
   * warm-up is a member of the group until it settles, so a group whose lenses
   * all finished first still waits to dispose it.
   */
  startWarmup(run: (keep: (s: Retired) => void) => Promise<void>): Promise<void> {
    if (this.life.warmup !== undefined) return this.life.warmup;
    this.life.members += 1;
    const life = this.life;
    const settle = (): void => {
      life.members -= 1;
      this.leave();
    };
    life.warmup = run((s) => life.sessions.push(s)).then(settle, settle);
    return life.warmup;
  }

  /** The member is done with the group, at `nowMs` when the caller has a
   * clock: the group was in use until then. The last release disposes its
   * sessions. */
  release(nowMs?: number): void {
    if (this.released) return;
    this.released = true;
    if (nowMs !== undefined) this.used(nowMs);
    this.life.members -= 1;
    this.leave();
  }
}

/**
 * The key a pass's cache group is shared under: its model spec, its tool
 * allowlist, in order, and, where the provider keeps a cache per thinking
 * level, that level (`level`; the runner passes none where it does not,
 * leaf-cache.ts `cacheSplitsByLevel`). Two passes on one model whose sessions
 * hold different tools declare different tools, which are part of the cached
 * prefix (leaf-cache.ts), so they share no prefix; and where the cache is per
 * level, a pass reads nothing of a warm-up sent at another (measured: 0 of
 * ~35k tokens at medium behind a warm-up at high, 33k at high). A group that
 * mixed either would warm the prefix of whichever pass came first, for that
 * pass's like alone. Undefined tools (no allowlist) is its own key, never the
 * same as an empty list.
 */
export function cacheGroupKey(
  spec: string,
  tools: readonly string[] | undefined,
  level?: string | null,
): string {
  const base = `${spec}\u0000${tools === undefined ? "\u0000*" : tools.join(",")}`;
  return level === undefined || level === null ? base : `${base}\u0000${level}`;
}

/** Per group key (cacheGroupKey), cache groups of `size`; each live group's lifetime. */
export class CacheGroups {
  private readonly grouper: CacheGrouper;
  private readonly lives = new Map<string, Lifetime>();
  /** Per cache key, never pruned: a round has a handful of keys. */
  private readonly facts = new Map<string, CacheKeyFacts>();

  /** `onDisposed` is told each time a group's sessions are disposed: the
   * production evidence the cleanupSessionResources pin rests on. */
  constructor(
    size: number,
    staggerMs: number,
    newKey?: () => string,
    private readonly onDisposed?: (key: string, sessions: number) => void,
  ) {
    this.grouper = new CacheGrouper(size, staggerMs, newKey);
  }

  /** Join the group for `key`'s next lens (cacheGroupKey). */
  join(key: string, nowMs: number): CacheLease {
    // A group with a pass still running is in use now, however long ago its
    // last pass joined: its sessions keep the provider's cache fresh.
    const current = this.grouper.current(key);
    if (current !== undefined && this.lives.has(current)) this.grouper.used(nowMs, key, current);
    const slot: CacheSlot = this.grouper.next(nowMs, key);
    let life = this.lives.get(slot.key);
    if (life === undefined) {
      life = new Lifetime();
      this.lives.set(slot.key, life);
    }
    life.members += 1;
    const held = life;
    let facts = this.facts.get(slot.key);
    if (facts === undefined) {
      facts = { turn1: 0, turn1Hot: 0, differenceTold: false };
      this.facts.set(slot.key, facts);
    }
    return new CacheLease(
      slot.key,
      slot.first,
      slot.delayMs,
      held,
      () => this.settle(slot.key, held),
      facts,
      (ms) => this.grouper.used(ms, key, slot.key),
    );
  }

  /** What the sessions of `key` were seen to do so far. */
  factsOf(key: string): Readonly<CacheKeyFacts> | undefined {
    return this.facts.get(key);
  }

  private settle(key: string, life: Lifetime): void {
    if (life.members > 0) return;
    if (this.lives.get(key) === life) this.lives.delete(key);
    const retired = life.sessions.splice(0);
    for (const s of retired) {
      try {
        s.dispose();
      } catch {
        // already disposed
      }
    }
    if (retired.length > 0) this.onDisposed?.(key, retired.length);
  }

  /** Groups with a member alive now (diagnostics and tests). */
  liveGroups(): number {
    return this.lives.size;
  }
}

/** Resolve after `ms`, or as soon as `signal` aborts (the caller then checks it). */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Wait for `p`, but at most `ms` (or until `signal` aborts). True when `p`
 * settled first. The timer never outlives the wait. */
export async function settledWithin(
  p: Promise<unknown>,
  ms: number,
  signal?: AbortSignal,
): Promise<boolean> {
  const stop = new AbortController();
  const timeout = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
  let won = false;
  const settle = (): void => {
    won = true;
  };
  try {
    await Promise.race([p.then(settle, settle), delay(ms, timeout)]);
  } finally {
    stop.abort();
  }
  return won;
}

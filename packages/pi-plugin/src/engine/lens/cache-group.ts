// Cache grouping for lens children: which provider cache key a child shares.
// Pure (the key source is injectable). Lifted from the retired
// extensions/subagents.ts; the rationale for the groups is in
// docs/prompt-caching.md.
import { randomUUID } from "node:crypto";

/** A group older than this starts afresh: the provider's cache is short-lived. */
export const CACHE_GROUP_MAX_AGE_MS = 4 * 60_000;

/** One cache group's place: its key, whether the caller is its first child,
 * and how long a pack-less child should wait. */
export interface CacheSlot {
  key: string;
  first: boolean;
  delayMs: number;
}

/** Hands out cache keys: per model, one per group of `size` children, a fresh
 * group when the last is full or stale. */
export class CacheGrouper {
  private readonly groups = new Map<string, { key: string; leaderAt: number; members: number }>();

  constructor(
    readonly size: number,
    readonly staggerMs: number,
    private readonly newKey: () => string = randomUUID,
  ) {}

  next(now: number, model = ""): CacheSlot {
    const g = this.groups.get(model);
    if (g === undefined || g.members >= this.size || now - g.leaderAt > CACHE_GROUP_MAX_AGE_MS) {
      const key = this.newKey();
      this.groups.set(model, { key, leaderAt: now, members: 1 });
      return { key, first: true, delayMs: 0 };
    }
    g.members += 1;
    return { key: g.key, first: false, delayMs: Math.max(0, g.leaderAt + this.staggerMs - now) };
  }
}

// Cache grouping for lens children: which provider cache key a child shares.
// Pure (the key source is injectable). Lifted from the retired
// extensions/subagents.ts; the rationale for the groups is in
// docs/prompt-caching.md.
import { randomUUID } from "node:crypto";

/** A group none of whose sessions was in use for this long starts afresh: the
 * provider's cache is short-lived, and a key it has forgotten needs a warm-up
 * again. Counted from the group's last use (a pass joining or leaving it), not
 * from its first pass: a round's later rows (the validator, a retry) come
 * minutes after its first wave began and seconds after it ended, and they read
 * the same cache (measured: a lens 20 s behind its group read all of it). */
export const CACHE_GROUP_MAX_IDLE_MS = 4 * 60_000;

/** One cache group's place: its key, and how long a pack-less child should
 * wait. */
export interface CacheSlot {
  key: string;
  delayMs: number;
}

/** Hands out cache keys: per model, one per group of `size` children, a fresh
 * group when the last is full or idle too long. */
export class CacheGrouper {
  private readonly groups = new Map<
    string,
    { key: string; leaderAt: number; usedAt: number; members: number }
  >();

  constructor(
    readonly size: number,
    readonly staggerMs: number,
    private readonly newKey: () => string = randomUUID,
  ) {}

  next(now: number, model = ""): CacheSlot {
    const g = this.groups.get(model);
    if (g === undefined || g.members >= this.size || now - g.usedAt > CACHE_GROUP_MAX_IDLE_MS) {
      const key = this.newKey();
      this.groups.set(model, { key, leaderAt: now, usedAt: now, members: 1 });
      return { key, delayMs: 0 };
    }
    g.members += 1;
    g.usedAt = Math.max(g.usedAt, now);
    return { key: g.key, delayMs: Math.max(0, g.leaderAt + this.staggerMs - now) };
  }

  /** The key of `model`'s current group, if it has one. */
  current(model = ""): string | undefined {
    return this.groups.get(model)?.key;
  }

  /** A session of the group `key` was in use at `now`. A group that is no
   * longer `model`'s current one is not touched. */
  used(now: number, model: string, key: string): void {
    const g = this.groups.get(model);
    if (g !== undefined && g.key === key) g.usedAt = Math.max(g.usedAt, now);
  }
}

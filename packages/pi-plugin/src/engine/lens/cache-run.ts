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
// Seen in production at pi 1.3.0: cleanupSessionResources closes by session id
// alone (groups disposed their sessions together, and no sibling lens failed after).
import { CacheGrouper, type CacheSlot } from "./cache-group.js";

/** The longest a packed group's lens waits for its warm-up. */
export const WARMUP_WAIT_MS = 30_000;
/** The warm-up's whole task: it exists to put the pack in the cache. */
export const WARMUP_REPLY_TASK = "Reply with the single word OK.";

/** What the group disposes: a pi session, as far as the group knows it. */
export interface Retired {
  dispose(): void;
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
    /** How long a pack-less member should wait before starting. */
    readonly delayMs: number,
    private readonly life: Lifetime,
    private readonly leave: () => void,
  ) {}

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

  /** The member is done with the group. The last release disposes its sessions. */
  release(): void {
    if (this.released) return;
    this.released = true;
    this.life.members -= 1;
    this.leave();
  }
}

/** Per model, cache groups of `size`; each live group's lifetime. */
export class CacheGroups {
  private readonly grouper: CacheGrouper;
  private readonly lives = new Map<string, Lifetime>();

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

  /** Join the group for `model`'s next lens. */
  join(model: string, nowMs: number): CacheLease {
    const slot: CacheSlot = this.grouper.next(nowMs, model);
    let life = this.lives.get(slot.key);
    if (life === undefined) {
      life = new Lifetime();
      this.lives.set(slot.key, life);
    }
    life.members += 1;
    const held = life;
    return new CacheLease(slot.key, slot.first, slot.delayMs, held, () =>
      this.settle(slot.key, held),
    );
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

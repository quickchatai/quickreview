// One pass at a time, for as long as the pass is alive.
//
// The reconcile poll runs ONE pass at a time: a tick that finds a pass running
// is skipped, an explicit call waits for it. A guard like that must never
// outlive the pass it guards by more than a bound. A pass that never settles —
// a git fetch on a dead connection, a call with no timeout — would otherwise
// hold it for the rest of the daemon's life, and with it the authoritative
// reconcile, the push backstop and the sweep that releases a lost nudge's
// claim, which must happen within a bounded time.
//
// So a pass that has run for `overdueMs` is ABANDONED: reported once, no longer
// waited for, and the next tick (or a waiting call) starts a new pass beside
// it. If the abandoned pass ever wakes it runs on — two passes then overlap,
// as unguarded passes always could — and when it settles it clears nothing: the guard belongs to the newer pass.

export interface SingleFlightDeps {
  /** How long a pass may run before it is abandoned (read at every check). */
  overdueMs: () => number;
  /** Milliseconds on a monotonic clock; `performance.now` by default, so a
   * wall-clock step can neither fake an overdue pass nor hide one. */
  now?: () => number;
  /** Called once per abandoned pass, with how long it had run. */
  onOverdue: (ageMs: number) => void;
}

interface Flight {
  /** Settles (never rejects) when the pass does. */
  done: Promise<void>;
  startedMs: number;
}

export class SingleFlight {
  private current: Flight | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: SingleFlightDeps) {
    this.now = deps.now ?? (() => performance.now());
  }

  /** Is a pass running that is still waited for? A pass found overdue here is
   * abandoned (and reported) and does not count. */
  running(): boolean {
    return this.live() !== null;
  }

  /** Run `fn` as THE pass. A running pass is waited for first — but never past
   * the moment it becomes overdue. With none running, `fn` starts before this
   * returns, so a `running()` check followed by `run()` cannot race. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    for (let cur = this.live(); cur; cur = this.live())
      await settledOrAfter(cur.done, cur.startedMs + this.deps.overdueMs() - this.now());
    let settle!: () => void;
    const flight: Flight = {
      done: new Promise<void>((resolve) => (settle = resolve)),
      startedMs: this.now(),
    };
    this.current = flight;
    try {
      return await fn();
    } finally {
      settle();
      if (this.current === flight) this.current = null;
    }
  }

  private live(): Flight | null {
    const cur = this.current;
    if (!cur) return null;
    const age = this.now() - cur.startedMs;
    if (age < this.deps.overdueMs()) return cur;
    this.current = null;
    this.deps.onOverdue(age);
    return null;
  }
}

/** `p` settled, or `ms` passed — whichever comes first; the timer is cleared
 * either way. */
function settledOrAfter(p: Promise<void>, ms: number): Promise<void> {
  if (!(ms > 0)) return Promise.resolve();
  let timer: NodeJS.Timeout | undefined;
  const elapsed = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return Promise.race([p, elapsed]).finally(() => clearTimeout(timer));
}

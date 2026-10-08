// ROUND MEMORY ACTIVITY (F2): is a review round reading memory right
// now? The one question the case writer asks before it starts a batch.
//
// WHY. Every memory read a round makes — its seed's context search, its
// lesson selection's two finds — embeds a query on the server's local
// embedder, which serializes on ONE lock. Every finding case the case writer
// stores is embedded on that same lock, and on the live VM's throttled two
// CPUs one case costs about 3.4 s there. A batch of cases started just before
// a round's reads puts the round behind every one of them: on 2026-10-07 the
// first rounds after the S9 deploy got 1–9 of their 17–24 lesson finds
// inside the 2 s budget while the case backfill held the embedder. So a case
// batch never STARTS while a round's memory window is open (src/cases.ts).
// It cannot stop a batch already running: what bounds that is the batch's
// size.
//
// WHAT IS A WINDOW. Dispatch opens one before the round's memory seed and
// closes it once the round's lesson selection has taken over (under `shadow`
// the selection starts after the handoff, so the window spans the handoff
// too — a batch started there would sit in front of the selection's finds);
// the selector opens its own for every prefetch it runs (src/lessonselect.ts).
// Windows nest and overlap freely; memory is BUSY while any is open.
//
// THE EMBEDDING TAIL (H3). A window stops the case writer STARTING a
// batch; it cannot help a round whose seed arrives just AFTER a batch was
// sent. OpenViking embeds a written batch asynchronously — the write
// returns, the embeddings run on — so the one-thread embedder is still busy
// for seconds (about 4 s a case on the live VM, 8–29 s under CPU throttling)
// when the seed's query arrives, and the query queues behind them. On
// 2026-10-08 three of fifteen seeds ran memory-less that way, 1–3 s after a
// case batch. So the writer tells this tracker when it SENDS a batch and,
// when the write settles, how long the embeddings are estimated to run on
// (`embeddingSent`); a seed asks `whenEmbedderQuiet` and waits — at most
// what its own budget allows, never longer — so its search starts
// uncontested. The estimate is only an estimate: a seed that waited the
// whole tail may still meet a slow embedder, and a seed whose budget cannot
// cover the tail sends its search anyway.
//
// Pure bookkeeping: no I/O. Every `end` is idempotent, and nothing here throws
// — a broken window must never stop a round, and a window that is never
// closed only ever HOLDS the case writer (its wait is bounded: it skips a
// tick, logged, and tries again the next). A tail that is never settled holds
// a seed only for the wait the seed itself bounds.

/** What the case writer reads: busy now, and a bounded wait for idle. */
export interface RoundActivityGate {
  /** A round's memory window is open right now. */
  busy(): boolean;
  /** Resolves `true` the moment no window is open (at once when none is),
   * `false` when `timeoutMs` passes first. Never rejects. The caller must
   * re-check `busy()` after it resolves: a new window may open in between. */
  whenIdle(timeoutMs: number): Promise<boolean>;
  /** The case writer SENT a batch (H3): the embedder is busy from now
   * until the returned `settled` is called, and for `tailMs` after that —
   * the server embeds a written batch after the write returns. `settled` is
   * idempotent. Optional: a gate without it tracks no tail. */
  embeddingSent?(): (tailMs: number) => void;
}

/** What dispatch and the selector hold: open a window, get its `end`. */
export interface RoundActivityWindow {
  /** Open one window; the returned function closes it (idempotent). */
  begin(label?: string): () => void;
  /** Resolves with the milliseconds it waited, the moment no case batch is
   * out and no embedding tail runs (at once, with 0, when none does), or
   * when `maxWaitMs` passes first (H3). Never rejects. Optional: a
   * tracker without it never holds a seed. */
  whenEmbedderQuiet?(maxWaitMs: number): Promise<number>;
}

/** The longest tail one settled batch may claim, whatever it asks: an
 * absurd estimate must not hold seeds for minutes (each seed's own budget
 * bounds its wait anyway). */
export const EMBEDDING_TAIL_MAX_MS = 60_000;

export interface RoundMemoryActivityOptions {
  /** Milliseconds on a MONOTONIC clock — the tail's clock; `performance.now`
   * by default, so a wall-clock step cannot stretch (or cut) a tail. */
  now?: () => number;
}

export class RoundMemoryActivity implements RoundActivityGate, RoundActivityWindow {
  private open = 0;
  private readonly waiters = new Set<() => void>();
  private readonly labels = new Map<number, string>();
  private seq = 0;
  /** Case batches sent and not yet settled — their tail is not known yet. */
  private batchesOut = 0;
  /** Clock ms (`now`) until which the last settled batches are still
   * embedding. */
  private tailUntil = 0;
  /** Seeds waiting for the embedder to go quiet: each re-checks when told. */
  private readonly quietWaiters = new Set<() => void>();
  private readonly now: () => number;

  constructor(opts: RoundMemoryActivityOptions = {}) {
    this.now = opts.now ?? (() => performance.now());
  }

  begin(label = "round"): () => void {
    const id = (this.seq += 1);
    this.open += 1;
    this.labels.set(id, label);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.labels.delete(id);
      this.open = Math.max(0, this.open - 1);
      if (this.open === 0) {
        const wake = [...this.waiters];
        this.waiters.clear();
        for (const w of wake) w();
      }
    };
  }

  busy(): boolean {
    return this.open > 0;
  }

  /** Windows open right now. */
  inFlight(): number {
    return this.open;
  }

  /** The labels of the open windows, oldest first — for a log line. */
  openLabels(): string[] {
    return [...this.labels.values()];
  }

  whenIdle(timeoutMs: number): Promise<boolean> {
    if (this.open === 0) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (idle: boolean): void => {
        if (timer !== undefined) clearTimeout(timer);
        this.waiters.delete(wake);
        resolve(idle);
      };
      const wake = (): void => done(true);
      this.waiters.add(wake);
      timer = setTimeout(() => done(false), Math.max(0, timeoutMs));
      (timer as unknown as { unref?: () => void }).unref?.();
    });
  }

  // ---- the embedding tail (H3) --------------------------------------------------

  embeddingSent(): (tailMs: number) => void {
    this.batchesOut += 1;
    let settled = false;
    return (tailMs: number): void => {
      if (settled) return;
      settled = true;
      this.batchesOut = Math.max(0, this.batchesOut - 1);
      const ms = Number.isFinite(tailMs) ? Math.max(0, Math.min(EMBEDDING_TAIL_MAX_MS, tailMs)) : 0;
      this.tailUntil = Math.max(this.tailUntil, this.now() + ms);
      this.notifyQuiet();
    };
  }

  /** How long the embedder is still estimated busy with case batches: 0 when
   * quiet, `null` while a batch is still out (its tail is not known yet). */
  embedderBusyForMs(): number | null {
    if (this.batchesOut > 0) return null;
    // Never more than one tail can claim, whatever the clock did: a clock
    // that stepped back (an injected wall clock) must not hold seeds for the
    // size of the step.
    return Math.max(0, Math.min(EMBEDDING_TAIL_MAX_MS, this.tailUntil - this.now()));
  }

  whenEmbedderQuiet(maxWaitMs: number): Promise<number> {
    const started = this.now();
    const max = Number.isFinite(maxWaitMs) ? Math.max(0, maxWaitMs) : 0;
    if (this.embedderBusyForMs() === 0) return Promise.resolve(0);
    if (max === 0) return Promise.resolve(0);
    return new Promise<number>((resolve) => {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let tailTimer: ReturnType<typeof setTimeout> | undefined;
      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        if (deadline !== undefined) clearTimeout(deadline);
        if (tailTimer !== undefined) clearTimeout(tailTimer);
        this.quietWaiters.delete(check);
        resolve(Math.max(0, this.now() - started));
      };
      // Re-evaluated when a batch settles and when the known tail runs out.
      const check = (): void => {
        if (finished) return;
        if (tailTimer !== undefined) clearTimeout(tailTimer);
        tailTimer = undefined;
        const left = this.embedderBusyForMs();
        if (left === 0) return finish();
        if (left !== null) {
          tailTimer = setTimeout(check, left);
          (tailTimer as unknown as { unref?: () => void }).unref?.();
        }
      };
      this.quietWaiters.add(check);
      deadline = setTimeout(finish, max);
      (deadline as unknown as { unref?: () => void }).unref?.();
      check();
    });
  }

  private notifyQuiet(): void {
    for (const check of [...this.quietWaiters]) check();
  }
}

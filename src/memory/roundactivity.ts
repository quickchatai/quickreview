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
// Pure bookkeeping: no I/O. Every `end` is idempotent, and nothing here throws
// — a broken window must never stop a round, and a window that is never
// closed only ever HOLDS the case writer (its wait is bounded: it skips a
// tick, logged, and tries again the next).

/** What the case writer reads: busy now, and a bounded wait for idle. */
export interface RoundActivityGate {
  /** A round's memory window is open right now. */
  busy(): boolean;
  /** Resolves `true` the moment no window is open (at once when none is),
   * `false` when `timeoutMs` passes first. Never rejects. The caller must
   * re-check `busy()` after it resolves: a new window may open in between. */
  whenIdle(timeoutMs: number): Promise<boolean>;
}

/** What dispatch and the selector hold: open a window, get its `end`. */
export interface RoundActivityWindow {
  /** Open one window; the returned function closes it (idempotent). */
  begin(label?: string): () => void;
}

export class RoundMemoryActivity implements RoundActivityGate, RoundActivityWindow {
  private open = 0;
  private readonly waiters = new Set<() => void>();
  private readonly labels = new Map<number, string>();
  private seq = 0;

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
}

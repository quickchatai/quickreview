// The process-wide lens cap: a FIFO counting semaphore with per-call weights.
// Pure. Lifted verbatim from extensions/subagents.ts (which re-exports it).

/** A weighted counting semaphore (FIFO). */
export class WeightedSemaphore {
  private available: number;
  private readonly waiters: Array<{ weight: number; resolve: () => void }> = [];

  constructor(readonly permits: number) {
    this.available = permits;
  }

  /** Number of permits currently held (for tests/diagnostics). */
  get held(): number {
    return this.permits - this.available;
  }

  private normalizeWeight(weight: number): number {
    return Math.max(1, Math.min(weight, this.permits));
  }

  async acquire(weight: number): Promise<void> {
    const w = this.normalizeWeight(weight);
    if (this.available >= w && this.waiters.length === 0) {
      this.available -= w;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push({ weight: w, resolve });
    });
  }

  release(weight: number): void {
    this.available += this.normalizeWeight(weight);
    if (this.available > this.permits) this.available = this.permits;
    while (
      this.waiters.length > 0 &&
      this.waiters[0] !== undefined &&
      this.available >= this.waiters[0].weight
    ) {
      const next = this.waiters.shift();
      if (!next) break;
      this.available -= next.weight;
      next.resolve();
    }
  }
}

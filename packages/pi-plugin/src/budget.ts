// A bounded wait. A round end waits for its transcripts and its
// integrity re-hash, and a dispatch for its integrity baseline, at most so
// long — then goes on without the answer. A filesystem read that never
// returns must cost a bounded wait and an honest "unknown", never a verdict
// that is not applied or a dispatch pump that never moves again.

export type Bounded<T> = { kind: "done"; value: T } | { kind: "budget" };

/**
 * `work`'s answer, or `{ kind: "budget" }` once `ms` has passed — whichever
 * comes first; the timer is cleared either way and never holds the process
 * open. The work is NOT cancelled (a read already in the kernel cannot be): it
 * runs on, and its late answer or rejection is dropped. A rejection BEFORE the
 * budget is the caller's to catch.
 */
export async function withinBudget<T>(work: Promise<T>, ms: number): Promise<Bounded<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<Bounded<T>>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "budget" }), Math.max(0, ms));
    timer.unref?.();
  });
  // Keeps a loser's late rejection handled.
  work.catch(() => undefined);
  try {
    return await Promise.race([
      work.then((value): Bounded<T> => ({ kind: "done", value })),
      budget,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

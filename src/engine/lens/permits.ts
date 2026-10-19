// The lens cap's port (D25). A pass holds a permit from before its session exists
// until the session is read and disposed (runlens.ts). Where the permit comes from
// depends on the route:
//   - one-shot routes (review, scan, bench, the interactive pi's lens shim) own
//     their process: a local WeightedSemaphore, one cap per host;
//   - a bot worker shares the box with the other workers: the daemon's broker
//     (src/ipc/permits.ts) holds the one global ceiling and staggers the grants.
// The runner sees only this port, so the two cannot differ in what a permit means.
import type { WeightedSemaphore } from "./semaphore.js";

export interface Permit {
  /** Give the permit back. Idempotent. */
  release(): void;
}

export interface Permits {
  /** Resolves with the permit once `weight` of them are free. `lensId` names the
   * pass (a broker keys on it). A `signal` that aborts while waiting ends the
   * wait and rejects; the local semaphore ignores it, as it always has. */
  acquire(lensId: string, weight: number, signal?: AbortSignal): Promise<Permit>;
}

/** The local semaphore as a port. */
export function localPermits(semaphore: WeightedSemaphore): Permits {
  return {
    async acquire(_lensId, weight) {
      await semaphore.acquire(weight);
      let given = false;
      return {
        release: () => {
          if (given) return;
          given = true;
          semaphore.release(weight);
        },
      };
    },
  };
}

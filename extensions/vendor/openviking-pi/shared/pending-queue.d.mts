/** [QCR PATCH 12] The queue's settings, handed in by the caller (qcr-shim.ts). */
export interface PendingQueueConfig {
  /** The queue directory. Without one the queue is off. */
  dir?: string;
  /** Max retry attempts per item (default 3). */
  maxRetries?: number;
  /** Max age in days before stale cleanup (default 7). */
  ttlDays?: number;
  /** Max items replayed per session-start (default 50). */
  replayLimit?: number;
}
export function enqueue(type: string, sessionId: string, payload: Record<string, any>, options?: { createdAt?: number; queue?: PendingQueueConfig }): Promise<{ ok: boolean; path?: string; error?: string }>;
export function listPending(queue?: PendingQueueConfig): Promise<Array<{ filename: string; entry: Record<string, any> }>>;
export function replayPending(
  fetchJSON: (path: string, init?: any) => Promise<{ ok: boolean; status?: number; result?: any; error?: any }>,
  log: (stage: string, data?: any) => void,
  queue?: PendingQueueConfig,
): Promise<{ replayed: number; failed: number; skipped: number; deferred: number }>;
export function cleanStale(queue?: PendingQueueConfig): Promise<number>;

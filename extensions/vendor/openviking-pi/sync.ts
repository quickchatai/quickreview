import type { OVClient } from "./client.js";
import type { OVConfig } from "./config.js";
// [QCR PATCH 3] `deriveHarnessSessionId` is no longer imported — minting an OV
// session id from pi's is exactly what this fork must not do.
import { enqueue, listPending, replayPending, type PendingQueueConfig } from "./shared/pending-queue.mjs";
import { extractBranchCapturePayloads } from "./lib/capture-adapter.mjs";
import { countUndeliveredForSession, estimatePayloadTokens } from "./lib/takeover-core.mjs";
// [QCR PATCH 7]
import { refuseCommits } from "./qcr-recall.js";

// --- SyncManager ---

export interface AddPayloadResult {
  accepted: boolean;
  delivered: boolean;
}

export interface SyncBranchResult {
  added: number;
  tokens: number;
  allDelivered: boolean;
}

/** [QCR PATCH 12] What the sync manager needs beyond the client: the offline
 * queue's settings and the debug log, both decided by the caller (the shim
 * reads the pending-queue and debug-log variables; sync.ts reads no environment). */
export interface SyncOptions {
  /** The offline queue. Without a `dir` a failed message is not queued. */
  queue?: PendingQueueConfig;
  /** Best-effort debug line sink; none by default. */
  log?: (message: string) => void;
}

export class SyncManager {
  private client: OVClient;
  private config: OVConfig;
  private ovSessionId: string | null = null;
  private syncedEntryCount = 0;
  private queue: PendingQueueConfig;
  private debugLog: (message: string) => void;
  // [QCR PATCH 13] One turn sync in flight per session. A turn that ends
  // while one runs queues its branch here, in order; the running sync sends
  // each in turn. `idle` settles when the queue is empty again.
  private syncing = false;
  private waiting: any[][] = [];
  private idle: Promise<void> = Promise.resolve();

  constructor(client: OVClient, config: OVConfig, opts: SyncOptions = {}) {
    this.client = client;
    this.config = config;
    this.queue = opts.queue ?? {};
    this.debugLog = opts.log ?? (() => {});
  }

  get sessionId(): string | null { return this.ovSessionId; }
  get syncedCount(): number { return this.syncedEntryCount; }

  restoreWatermark(n: number): void {
    const next = Math.max(0, Math.floor(Number(n) || 0));
    this.syncedEntryCount = next;
  }

  /**
   * [QCR PATCH 3] ATTACH to the session the daemon created — never create one,
   * and never derive an id from pi's own session id (upstream did:
   * `deriveHarnessSessionId("pi-", piSessionId)`, which mints a fresh OV
   * session on first message and gets extraction-enabled defaults).
   *
   * The id rides the environment, which is how everything else per-session
   * reaches a pi in this daemon (`env K=V … pi …` — tmux panes inherit the
   * tmux SERVER env, not the client's). `OPENVIKING_SESSION_ID` is the
   * upstream-shaped name; `QCR_OV_SESSION_ID` is the one that survives
   * `src/sessions.ts`'s QCR_-only argv prefix, so both are read.
   *
   * Returns false — a normal, non-fatal state — when there is no id, or when
   * the named session does not exist server-side. False means "no ambient
   * sync"; the memory tools are unaffected.
   */
  async ensureSession(env: Record<string, string | undefined>): Promise<boolean> {
    if (this.ovSessionId) return true;

    const id = (env.OPENVIKING_SESSION_ID ?? env.QCR_OV_SESSION_ID ?? "").trim();
    if (!id) {
      this.debugLog("ensureSession: no daemon-provided session id; ambient sync disabled");
      return false;
    }

    // Existence check, not a creation: getSession no longer has an
    // auto_create route (client.ts, PATCH 3).
    const meta = await this.client.getSession(id);
    if (!meta) {
      this.debugLog(`ensureSession: session=${id} does not exist; ambient sync disabled`);
      return false;
    }

    this.ovSessionId = id;
    return true;
  }

  async replayPending(): Promise<void> {
    if (!this.client.connected) return;
    await replayPending(
      // [QCR PATCH 7] A commit an older build queued on disk is answered with
      // a final refusal here — dropped from the queue, never sent.
      refuseCommits((path: string, init?: any) => this.client.fetchJSON(path, init, 10000)),
      (stage: string, data: unknown) =>
        this.debugLog(`${stage}: ${JSON.stringify(data)}`),
      this.queue,
    );
  }

  async flushForTakeover(): Promise<boolean> {
    if (!this.ovSessionId) return false;
    await this.replayPending();
    const pending = await listPending(this.queue);
    return countUndeliveredForSession(pending, this.ovSessionId) === 0;
  }

  /**
   * [QCR PATCH 13] The turn_end hook's deadline returns without cancelling
   * this sync, so under a slow server the next turn used to start a second one
   * from the same watermark: the same messages went to one session several
   * times at once and queued on its lock. Now one sync runs at a time. A turn
   * that ends while it runs queues its branch, and the running sync sends the
   * queued branches one after another, each from the watermark the one before
   * it left: nothing is sent twice or at once, and no turn is overwritten by a
   * later one. `drain()` (awaited at agent_end) waits for the queue to empty.
   */
  async syncBranch(branch: any[]): Promise<SyncBranchResult> {
    if (!this.ovSessionId) return { added: 0, tokens: 0, allDelivered: true };
    if (this.syncing) {
      this.waiting.push(branch);
      return { added: 0, tokens: 0, allDelivered: false };
    }
    this.syncing = true;
    let done!: () => void;
    this.idle = new Promise<void>((resolve) => (done = resolve));
    try {
      const total = await this.syncOnce(branch);
      for (let next = this.waiting.shift(); next; next = this.waiting.shift()) {
        const r = await this.syncOnce(next);
        total.added += r.added;
        total.tokens += r.tokens;
        total.allDelivered = total.allDelivered && r.allDelivered;
      }
      return total;
    } finally {
      this.syncing = false;
      done();
    }
  }

  /** [QCR PATCH 13] Settles once no sync runs and no turn waits for one. */
  drain(): Promise<void> {
    return this.idle;
  }

  private async syncOnce(branch: any[]): Promise<SyncBranchResult> {

    const extracted = extractBranchCapturePayloads(branch, this.syncedEntryCount, this.config);
    if (extracted.resetWatermark) this.syncedEntryCount = 0;
    let added = 0;
    let tokens = 0;
    let allDelivered = true;
    for (const payload of extracted.payloads) {
      const result = await this.addPayload(payload);
      if (!result.accepted) break;
      added++;
      tokens += estimatePayloadTokens(payload);
      allDelivered = allDelivered && result.delivered;
    }
    if (added === extracted.payloads.length) {
      this.syncedEntryCount = extracted.nextEntryCount;
    }
    // [QCR PATCH 7] was `if (added > 0 && !takeoverEnabled) await
    // this.commitIfNeeded()` — a session GET after every synced turn and a
    // commit at 20k pending tokens. Commit is never called; the
    // per-turn sync above stays (owner ruling R3).
    return { added, tokens, allDelivered };
  }

  async addPayload(payload: any): Promise<AddPayloadResult> {
    if (!this.ovSessionId) return { accepted: false, delivered: false };
    const ok = await this.client.addMessagePayload(this.ovSessionId, payload);
    if (ok) return { accepted: true, delivered: true };
    await enqueue("addMessage", this.ovSessionId, payload, { queue: this.queue });
    return { accepted: true, delivered: false };
  }

  // [QCR PATCH 7] `commitIfNeeded()` is DELETED (it read the session after
  // every synced turn to decide a commit), and `commit()` never sends one:
  // commit exists to PROMOTE session notes into memories through an
  // extraction model this deployment does not configure, so each one archived
  // the raw notes and produced nothing (143 archives on the VM, 0 overviews).
  // It also queues nothing, so a refused commit cannot come back on replay.
  // The signature stays for the takeover manager, which config.ts forces off.
  async commit(
    _opts: { queueOnFailure?: boolean; keepRecentCount?: number } = {},
  ): Promise<any | null> {
    if (this.ovSessionId) this.debugLog(`commit: session=${this.ovSessionId} refused (QCR PATCH 7)`);
    return null;
  }

  async shutdown(): Promise<void> {
    return;
  }
}

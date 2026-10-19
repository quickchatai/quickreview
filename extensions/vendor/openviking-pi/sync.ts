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

  async syncBranch(branch: any[]): Promise<SyncBranchResult> {
    if (!this.ovSessionId) return { added: 0, tokens: 0, allDelivered: true };

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

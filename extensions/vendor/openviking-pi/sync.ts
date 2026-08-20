import type { OVClient } from "./client.js";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { OVConfig } from "./config.js";
// [QCR PATCH 3] `deriveHarnessSessionId` is no longer imported — minting an OV
// session id from pi's is exactly what this fork must not do.
import { enqueue, listPending, replayPending } from "./shared/pending-queue.mjs";
import { extractBranchCapturePayloads } from "./lib/capture-adapter.mjs";
import { countUndeliveredForSession, estimatePayloadTokens } from "./lib/takeover-core.mjs";

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

function debugLog(message: string): void {
  const file = process.env.OV_DEBUG_LOG;
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Best effort; logging must never affect pi.
  }
}

export class SyncManager {
  private client: OVClient;
  private config: OVConfig;
  private ovSessionId: string | null = null;
  private syncedEntryCount = 0;

  constructor(client: OVClient, config: OVConfig) {
    this.client = client;
    this.config = config;
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
  async ensureSession(env: Record<string, string | undefined> = process.env): Promise<boolean> {
    if (this.ovSessionId) return true;

    const id = (env.OPENVIKING_SESSION_ID ?? env.QCR_OV_SESSION_ID ?? "").trim();
    if (!id) {
      debugLog("ensureSession: no daemon-provided session id; ambient sync disabled");
      return false;
    }

    // Existence check, not a creation: getSession no longer has an
    // auto_create route (client.ts, PATCH 3).
    const meta = await this.client.getSession(id);
    if (!meta) {
      debugLog(`ensureSession: session=${id} does not exist; ambient sync disabled`);
      return false;
    }

    this.ovSessionId = id;
    return true;
  }

  async replayPending(): Promise<void> {
    if (!this.client.connected) return;
    await replayPending(
      (path: string, init?: any) => this.client.fetchJSON(path, init, 10000),
      (stage: string, data: unknown) =>
        debugLog(`${stage}: ${JSON.stringify(data)}`),
    );
  }

  async flushForTakeover(): Promise<boolean> {
    if (!this.ovSessionId) return false;
    await this.replayPending();
    const pending = await listPending();
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
    if (added > 0 && !this.config.takeoverEnabled) {
      await this.commitIfNeeded();
    }
    return { added, tokens, allDelivered };
  }

  async addPayload(payload: any): Promise<AddPayloadResult> {
    if (!this.ovSessionId) return { accepted: false, delivered: false };
    const ok = await this.client.addMessagePayload(this.ovSessionId, payload);
    if (ok) return { accepted: true, delivered: true };
    await enqueue("addMessage", this.ovSessionId, payload);
    return { accepted: true, delivered: false };
  }

  async commitIfNeeded(): Promise<void> {
    if (!this.ovSessionId) return;
    const meta = await this.client.getSession(this.ovSessionId);
    const pending = Number(meta?.pending_tokens || 0);
    if (pending >= this.config.commitTokenThreshold) {
      await this.commit();
    }
  }

  async commit(opts: { queueOnFailure?: boolean; keepRecentCount?: number } = {}): Promise<any | null> {
    if (!this.ovSessionId) return null;
    const response = await this.client.commitSessionResponse(
      this.ovSessionId,
      opts.keepRecentCount,
    );
    const result = response.result;
    if (!result) {
      debugLog(
        `commit: session=${this.ovSessionId} ok=false status=${response.status ?? 0} ` +
          `trace_id=${response.traceId || "none"} ` +
          `error=${response.error?.message || response.error?.code || "unknown"}`,
      );
      if (opts.queueOnFailure !== false) {
        await enqueue("commitSession", this.ovSessionId, {
          keep_recent_count: opts.keepRecentCount ?? this.config.commitKeepRecentCount,
        });
      }
      return null;
    }
    debugLog(
      `commit: session=${this.ovSessionId} ok=true trace_id=${result.trace_id || "none"}`,
    );
    return result;
  }

  async shutdown(): Promise<void> {
    return;
  }
}

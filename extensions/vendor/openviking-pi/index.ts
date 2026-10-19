/**
 * Pi OpenViking Extension
 *
 * Integrates pi with an OpenViking context database for persistent,
 * cross-session memory. Syncs conversation turns to OV, recalls
 * relevant memories on each prompt, and commits sessions for long-term
 * memory extraction.
 *
 * Design informed by: OpenClaw (synchronous recall), Claude Code plugin
 * (most mature, production-hardened), Hermes (anti-pattern: stale prefetch).
 *
 * ── QCR FORK ────────────────────────────────────────────────────────────────
 * Vendored from volcengine/OpenViking @ v0.4.15, examples/pi-coding-agent-
 * extension. Twelve numbered patches; every hunk carries a `[QCR PATCH n]`
 * marker so a rebase is a search, not an audit. See README.md here.
 *   PATCH 1 — no session_before_compact handler (extensions/ledger-pin.ts is
 *             the sole owner of compaction) and takeover forced off.
 *   PATCH 2 — no ambient recall/sync/commit in a pi-subagents leaf.
 *   PATCH 3 — never auto-create an OV session; the daemon owns lifecycle.
 *   PATCH 4 — viking_write (durable content/batch-write), the ONLY write tool.
 *   PATCH 5 — a second memory namespace (the companion's reviewer key), tools
 *             only; a leaf and a single-keyed review session are unchanged.
 *   PATCH 6 — writes that stick: a busy 409 is retried (a precondition 409
 *             is not), viking_write takes several entries as ONE batch, a
 *             refused key is re-read once, and no failure reads as "No
 *             results found".
 *   PATCH 7 — bounded recall, no commit: the context hook waits at most
 *             500 ms for recall (every request of it on one deadline, no
 *             fallback past it), query expansion is off in code, retired
 *             entries are never recalled, and nothing commits a session.
 *   PATCH 8 — PR-derived recall: a PR session recalls with the daemon's hint
 *             (the round's own query: the PR title plus the areas it touches)
 *             and only inside the hint's memory areas (`experiences/`), not
 *             with the whole round order across every scope.
 *   PATCH 9 — the memory TOOLS of a PR session stay inside the same areas:
 *             viking_search keeps only in-area hits, viking_read and
 *             viking_browse refuse a memory URI outside them (finding cases
 *             and feedback events are not a round's to read, S7).
 *   PATCH 12 — createOpenViking(cfg): the extension is a factory over a value.
 *             The default export is the shim — it reads the process once
 *             (qcr-shim.ts) and calls the factory; the factory reads no env,
 *             argv, cwd or home. Every hook runs under a deadline and a catch
 *             (qcr-hooks.ts): a memory call that hangs or throws costs the
 *             turn its memory, never the turn.
 * ────────────────────────────────────────────────────────────────────────────
 */
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rereadApiKey, type OVConfig } from "./config.js";
import { OVClient } from "./client.js";
import { RecallManager } from "./recall.js";
import { SyncManager } from "./sync.js";
import { buildProfileBlock } from "./shared/profile-inject.mjs";
import { guardVikingUriToolCall } from "./lib/uri-guard-adapter.mjs";
import { registerTools } from "./tools.js";
import { createTakeoverManager } from "./takeover.js";
// [QCR PATCH 5]
import { ownNamespaceName } from "./qcr-namespaces.js";
// [QCR PATCH 7]
import { readRetiredUris, RECALL_WAIT_MS } from "./qcr-recall.js";
// [QCR PATCH 11]
import { recallScope } from "./qcr-hint.js";
// [QCR PATCH 9]
import { toolScopeAreas, toolScopeNote } from "./qcr-hint.js";
// [QCR PATCH 12]
import { boundedHook, HOOK_TIMEOUT_MS, type HookName } from "./qcr-hooks.js";
import { openVikingConfigFromProcess, type OpenVikingConfig } from "./qcr-shim.js";

export type { OpenVikingConfig } from "./qcr-shim.js";

/**
 * [QCR PATCH 12] The extension as a factory over a value. An SDK session
 * attaches `createOpenViking(cfg)` as an extension factory; the default export
 * below is the shim for a pi that loads this file by path.
 */
export function createOpenViking(cfg: OpenVikingConfig): ExtensionFactory {
  return (pi) => register(pi, cfg);
}

/** The shim: the live process, read once (qcr-shim.ts), handed to the factory. */
export default async function (pi: ExtensionAPI) {
  await createOpenViking(openVikingConfigFromProcess(dirname(fileURLToPath(import.meta.url))))(pi);
}

async function register(pi: ExtensionAPI, cfg: OpenVikingConfig): Promise<void> {
  // [QCR PATCH 2] Decided once, by the shim (from argv; qcr-leaf.ts): a
  // pi-subagents leaf gets the tools and nothing ambient.
  const leaf = cfg.leaf;

  // --- Config ---
  const config = cfg.config;
  if (!config.enabled) return;

  // --- Initialize modules ---
  const makeClient = cfg.makeClient ?? ((c: OVConfig) => new OVClient(c));
  const client = makeClient(config);
  // [QCR PATCH 6] The primary key is re-read from its source after an auth
  // failure (the daemon rewrites ovcli.conf on a key rotation). The extra
  // namespaces' keys come from the environment, which cannot change
  // in-process, so they get no re-reader. [QCR PATCH 12] The re-reader
  // resolves from the config's own credential env, not the live process.
  client.rekey = () => rereadApiKey(cfg.credentialEnv);
  // [QCR PATCH 5] A SECOND client, and only when a second USER key is in the
  // environment: the companion's `OPENVIKING_REVIEWER_KEY`, which lets the
  // local pi read AND write reviewer memory as well as its own. Same base URL,
  // same account, same actor peer (this pi is still the actor) — only the
  // bearer key and `X-OpenViking-User` differ, which is exactly the pairing the
  // server confines. The key goes through config.ts's root-key guard on the way
  // (qcr-namespaces.ts), so a second key cannot become a ROOT client either.
  //
  // `leaf ? []` is belt to qcr-namespaces' own braces: a pi-subagents leaf must
  // not gain a namespace PATCH 2 and PATCH 4 deliberately withheld, so the
  // clients are not even constructed there. No key is a NORMAL state — this pi
  // then reaches its own namespace only, exactly as before this patch, which is
  // every review session's shape.
  const extraNamespaces = (leaf ? [] : cfg.extraNamespaces).map((ns) => ({
    name: ns.name,
    client: makeClient({ ...config, apiKey: ns.apiKey, user: ns.user }),
  }));
  const namespaces = [{ name: ownNamespaceName(config.user), client }, ...extraNamespaces];
  // [QCR PATCH 12] The debug log and the offline queue are the shim's values.
  const debugLog = (message: string) => {
    const file = cfg.debugLogFile;
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
    } catch {
      // Best effort; logging must never affect pi.
    }
  };
  const sync = new SyncManager(client, config, { queue: cfg.pendingQueue, log: debugLog });
  // [QCR PATCH 7] The retired URIs the daemon publishes beside ovcli.conf,
  // re-read for every recall (a small local file), so a retirement reaches a
  // running session without a restart.
  const recall = new RecallManager(client, config, () => sync.sessionId, {
    retiredUris: () => readRetiredUris(cfg.retiredFile),
  });
  const takeover = createTakeoverManager({ pi, client, sync, config, log: debugLog });
  // [QCR PATCH 9] The memory TOOLS of a PR session stay inside the round's
  // areas — re-read per call, like the recall hint. Unscoped (null) where the
  // daemon publishes no hint: the overseer, the companion.
  const toolAreas = () => toolScopeAreas(cfg.recallHintFile);

  // [QCR PATCH 12] Every hook runs under a deadline and a catch: one that
  // throws or does not answer costs the turn its memory, never the turn. A
  // hook that fails carries on as though it had done nothing.
  const deadline = (name: HookName) => cfg.hookTimeoutMs?.[name] ?? HOOK_TIMEOUT_MS[name];
  const guard =
    <E, C, R>(
      name: HookName,
      handler: (event: E, ctx: C) => Promise<R> | R,
      onFail?: (reason: string) => R,
    ) =>
    (event: E, ctx: C): Promise<R | undefined> =>
      boundedHook(name, deadline(name), () => handler(event, ctx), debugLog, onFail);

  // Session state
  let connected = false;
  let bypassed = false;
  let profileBlock = "";
  let archiveOverview = "";
  let toolsRegistered = false;
  // [QCR PATCH 1] `compacted` is gone with the session_before_compact handler
  // that was the only thing setting it.
  let started = false;
  let startPromise: Promise<void> | null = null;

  // ================================================================
  // Event Handlers
  // ================================================================

  const start = async (ctx: any): Promise<void> => {
    if (started) return;
    if (startPromise) return startPromise;

    startPromise = (async () => {
      // Bypass check
      const cwd = cfg.cwd;
      for (const pattern of config.bypassPatterns) {
        if (matchBypass(cwd, pattern)) {
          bypassed = true;
          started = true;
          return;
        }
      }

      // Health check
      connected = await client.health();
      if (!connected) {
        if (config.logLevel === "info") {
          ctx.ui.notify("OpenViking: server not reachable", "warning");
        }
        return;
      }

      // [QCR PATCH 2] A leaf stops here: tools register (read-only — see
      // tools.ts), nothing ambient runs. No OV session, no profile block, no
      // recall injection, no turn sync, no commit.
      if (leaf) {
        if (!toolsRegistered) {
          registerTools(pi, client, sync, { leaf: true, areas: toolAreas });
          toolsRegistered = true;
        }
        started = true;
        return;
      }

      // [QCR PATCH 3] Attach to the session the DAEMON created; never mint
      // one. No session is a normal, non-fatal state: the tools still work,
      // only ambient turn-sync is off.
      const piSessionId = ctx.sessionManager.getSessionId();
      const attached = await sync.ensureSession({ OPENVIKING_SESSION_ID: cfg.sessionId });
      if (attached) {
        await sync.replayPending();
      } else if (config.logLevel === "info") {
        ctx.ui.notify("OpenViking: no daemon session — memory tools only", "info");
      }

      // Profile injection
      profileBlock = await buildSessionProfileBlock(client, config);

      const branch = typeof ctx.sessionManager.getBranch === "function"
        ? ctx.sessionManager.getBranch()
        : [];
      if (config.takeoverEnabled) {
        takeover.restore(branch);
        sync.restoreWatermark(takeover.state.syncedEntryCount);
      } else if (sync.sessionId) {
        // Resume rehydration — fetch archive overview if session was previously committed.
        archiveOverview = await fetchArchiveOverview(client, sync.sessionId, config);
      }

      // [QCR PATCH 5] Each extra namespace's client carries its own `connected`
      // flag (the tools read it), so each is probed once here — after the leaf
      // early-return above, so a leaf never even opens the socket. A namespace
      // that does not answer is degraded, never fatal: its tools say "not
      // reachable" and the primary namespace is untouched.
      for (const ns of extraNamespaces) {
        const reachable = await ns.client.health();
        if (!reachable && config.logLevel === "info") {
          ctx.ui.notify(`OpenViking: ${ns.name} memory not reachable`, "warning");
        }
      }

      // Register tools (also needed for pi -c continuations).
      if (!toolsRegistered) {
        registerTools(pi, client, sync, { leaf: false, namespaces, areas: toolAreas });
        toolsRegistered = true;
      }
      updateStatus(ctx, connected, 0, sync.sessionId, config, takeover.state);

      started = true;
      if (config.logLevel === "info") {
        ctx.ui.notify(`OpenViking connected (${piSessionId.slice(0, 8)}...)`, "info");
      }
    })().finally(() => {
      startPromise = null;
    });

    return startPromise;
  };

  // --- session_start ---
  pi.on("session_start", guard("session_start", async (_event, ctx) => {
    await start(ctx);
  }));

  // --- before_agent_start ---
  pi.on("before_agent_start", guard("before_agent_start", async (event, ctx) => {
    // session_start doesn't fire for pi -c continuations.
    await start(ctx);

    if (!connected || bypassed) return;
    // [QCR PATCH 2] No recall queue and no injected profile inside a leaf.
    if (leaf) return;

    // Queue recall for the context hook. Pi renders the user message before
    // that hook, so recall latency does not delay the message appearing.
    // [QCR PATCH 8] A PR session asks with its PR's query, inside the round's
    // areas — the daemon's hint, re-read for every prompt (a small local
    // file). No hint variable (the overseer, the companion): the prompt,
    // unscoped. [QCR PATCH 11] A PR session whose hint is not there yet (a
    // recheck or ping-pong wake before its next round) asks with the prompt
    // INSIDE the round's areas — fail closed, as the tools do.
    // [QCR build conformance] pi 1.3.0 types the event as a union whose custom
    // variant has no `prompt`; the cast keeps the read exactly as it was.
    const plan = recallScope(
      cfg.recallHintFile,
      (event as { prompt: string }).prompt,
    );
    recall.queueSearch(plan.query, plan.areas);

    // Compose system prompt additions
    const parts: string[] = [];
    if (profileBlock) parts.push(profileBlock);
    // [QCR PATCH 1] was `(compacted || archiveOverview.trim())`.
    if (!config.takeoverEnabled && archiveOverview && archiveOverview.trim()) {
      parts.push(archiveOverview);
    }
    // [QCR PATCH 4] viking_remember / viking_forget / viking_add_resource are
    // gone; viking_write is the one write tool.
    parts.push("OpenViking tools: viking_search, viking_read, viking_browse, viking_write, viking_archive_expand.");
    // [QCR PATCH 9] Said, not only enforced: a refused read must not surprise.
    const scopedAreas = toolAreas();
    if (scopedAreas) parts.push(toolScopeNote(scopedAreas));
    // [QCR PATCH 5] Say it in the system prompt too, not only in the tool
    // schemas: with two namespaces reachable, "which memory am I touching" is a
    // question the model must never have to guess at.
    if (extraNamespaces.length > 0) {
      parts.push(
        `Two OpenViking memory namespaces are reachable: ${namespaces.map((n) => n.name).join(" and ")}. ` +
          `${namespaces[0]!.name} is your own memory and the default; ` +
          `${extraNamespaces.map((n) => n.name).join(" and ")} is the review system's, readable and writable from here. ` +
          "Choose with the `namespace` parameter or by addressing a viking://user/<namespace>/… URI, and check the prefix on every answer.",
      );
    }

    const additions = parts.join("\n\n");
    if (!additions) return;

    return {
      systemPrompt: event.systemPrompt + "\n\n" + additions,
    };
  }));

  // --- context ---
  pi.on("context", guard("context", async (event, _ctx) => {
    if (!connected || bypassed) return;
    // [QCR PATCH 2] A leaf's context is exactly the pass prompt it was given.
    if (leaf) return;

    // Keep recall synchronous with the provider request so the current prompt
    // still receives current-query memory, without blocking user-message UI.
    // [QCR PATCH 7] …but never for longer than RECALL_WAIT_MS (owner ruling
    // R3): every request of the recall shares that one deadline, and a recall
    // that misses it leaves this run without a block — the turn goes on.
    await recall.searchPending(RECALL_WAIT_MS);

    const afterTakeover = config.takeoverEnabled
      ? takeover.transformContext(event.messages as any)
      : event.messages;
    const messages = recall.injectRecall(afterTakeover);
    return { messages };
  }));

  // --- tool_call ---
  // [QCR PATCH 12] This one is a guard, so it fails CLOSED: a throw or a missed
  // deadline refuses the call, which is also what pi does with a throwing
  // tool_call handler (canary 9).
  pi.on("tool_call", guard("tool_call", async (event, _ctx) => {
    const decision = guardVikingUriToolCall(event);
    if (!decision) return;
    return decision;
  }, (reason) => ({ block: true, reason: `OpenViking URI guard failed (${reason}); the call was refused` })));

  // --- turn_end ---
  pi.on("turn_end", guard("turn_end", async (_event, ctx) => {
    if (!connected || bypassed || !config.syncTurns) return;
    // [QCR PATCH 2] No turn sync from a leaf. ([QCR PATCH 7]: the threshold
    // auto-commit that rode the sync is gone everywhere — sync.ts.)
    if (leaf) return;

    const branch = ctx.sessionManager.getBranch();
    const result = await sync.syncBranch(branch);
    debugLog(`turn_end: synced ${result.added} entries, ~${result.tokens} tokens`);
    await takeover.onTurnSynced(result.tokens);
    updateStatus(ctx, connected, result.added, sync.sessionId, config, takeover.state);
  }));

  // --- session_before_compact ---
  //
  // [QCR PATCH 1] DELETED. `extensions/ledger-pin.ts` is the sole owner of
  // this event: it re-pins the review ledger block that pi's token-driven
  // compaction would otherwise summarise away, and pi does not document how
  // two registered handlers merge. Upstream registered its handler
  // UNCONDITIONALLY — `takeover.enabled: false` only changed what the handler
  // did (a synchronous sync.commit() instead of a takeover), it did not
  // unhook it (verified on a running v0.4.15 + pi 0.84.1:
  // assets/findings.md §4.2). So the knob is NOT a substitute for
  // this deletion; do not "restore and disable".
  //
  // Nothing replaces it. Losing an archive-overview refresh at compaction
  // costs a stale rehydration block; losing the ledger costs the review.
  //
  // Consequences kept in sync elsewhere in this file: `compacted` is gone,
  // and config.ts forces takeoverEnabled=false so takeover — which exists
  // only to REPLACE compaction — can never rewrite the context either.

  // --- session_shutdown ---
  pi.on("session_shutdown", guard("session_shutdown", async (_event, _ctx) => {
    if (!connected || bypassed) return;
    // [QCR PATCH 2] A leaf exits after every pass; it commits nothing.
    if (leaf) return;

    // [QCR PATCH 7] was `takeover.shutdown()` / `sync.commit()` — a commit on
    // every shutdown.: commit is never called (it only promotes notes
    // through an extraction model this deployment does not run); the PR's raw
    // tier ages out by the daemon's DELETE when the PR closes.
    await sync.shutdown();
  }));

  // --- agent_end ---
  pi.on("agent_end", guard("agent_end", async (_event, _ctx) => {
    recall.invalidate();
  }));

  // ================================================================
  // Commands
  // ================================================================

  pi.registerCommand("viking", {
    description: "OpenViking status and manual operations. Use 'commit' to force a sync.",
    handler: guard("command", async (args: string | undefined, ctx: any) => {
      if (!connected) {
        ctx.ui.notify("OpenViking: not connected", "warning");
        return;
      }

      if (args?.trim() === "commit") {
        // [QCR PATCH 7] No manual commit either — say so rather
        // than report a "failed" commit that was never attempted.
        ctx.ui.notify(
          "OpenViking: session commit is disabled in this deployment — durable memory is written with viking_write",
          "info",
        );
        return;
      }

      // Status
      const sid = sync.sessionId ?? "none";
      const t = takeover.state;
      const takeoverInfo = config.takeoverEnabled
        ? ` | takeover: ${t.coveredUserTurns}/${t.lastSeenUserTurns} turns archived, ~${t.pendingTokens} tokens pending`
        : "";
      ctx.ui.notify(
        `OpenViking: ${connected ? "connected" : "disconnected"} | session: ${sid.slice(0, 12)}...${takeoverInfo}`,
        "info",
      );
    }),
  });
}

// ================================================================
// Helper Functions
// ================================================================

/** Simple bypass pattern matching (prefix and glob). */
function matchBypass(cwd: string, pattern: string): boolean {
  if (pattern.startsWith("*")) {
    return cwd.endsWith(pattern.slice(1));
  }
  if (pattern.endsWith("*")) {
    return cwd.startsWith(pattern.slice(0, -1));
  }
  return cwd === pattern || cwd.startsWith(pattern + "/");
}

/** Build the <openviking-context> profile block. */
async function buildSessionProfileBlock(
  client: OVClient, config: OVConfig,
): Promise<string> {
  try {
    const profile = await buildProfileBlock(
      (path: string, init?: any, _options?: any) => client.fetchJSON(path, init, 10000),
      config.profileTokenBudget,
      config.peerId,
    );
    if (!profile?.block) return "";
    return [
      '<openviking-context source="session-start">',
      profile.block,
      "</openviking-context>",
    ].join("\n");
  } catch {
    return "";
  }
}

/** Fetch archive overview for rehydration using the session context API. */
async function fetchArchiveOverview(
  client: OVClient, sessionId: string, config: OVConfig,
): Promise<string> {
  try {
    const ctx = await client.getSessionContext(sessionId, config.resumeContextBudget);
    if (!ctx || !ctx.latest_archive_overview) return "";

    return [
      '<openviking-context source="session-archive">',
      "<session-archive>",
      ctx.latest_archive_overview,
      "</session-archive>",
      "</openviking-context>",
    ].join("\n");
  } catch {
    return "";
  }
}

function updateStatus(
  ctx: any,
  connected: boolean,
  added: number,
  sessionId: string | null,
  config: OVConfig,
  takeoverState?: { pendingTokens?: number; coveredUserTurns?: number },
): void {
  const setter = ctx?.ui?.setStatus;
  if (typeof setter !== "function") return;
  // [QCR PATCH 7] was ` · ✎ ${commitTokenThreshold}` — a commit threshold
  // that no longer exists.
  const pending = config.takeoverEnabled && takeoverState
    ? ` · ctx ${takeoverState.coveredUserTurns ?? 0} · ~${takeoverState.pendingTokens ?? 0}/${config.takeoverTokenThreshold}`
    : " · no commit";
  const status = `${connected ? "OV ✓" : "OV ✗"} · ↩${added}${pending} · ${sessionId ? sessionId.slice(0, 12) : "none"}`;
  try {
    setter(status);
  } catch {
    // Best effort; pi API shape may vary across fast-moving versions.
  }
}

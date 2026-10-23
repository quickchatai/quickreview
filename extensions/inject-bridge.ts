// inject-bridge — the daemon→session wake channel.
//
// Modelled on pi's shipped examples/extensions/file-trigger.ts: fs.watch a
// directory and offer the oldest pending *.md file to pi.sendUserMessage().
// Pi's extension API is fire-and-forget, so the file remains pending until the
// marker-correlated user `message_start` (after `agent_start`) acknowledges that
// Pi accepted the wake. Only then is it moved to .done/ (consumption means
// accepted delivery, never pickup or attempted submission). The daemon writes files atomically (tmp + rename), so a watch
// event sees a complete file.
//
// The companion (its inbox) is the one session that still reads a mailbox. A PR's
// wake is not a file at all: a worker takes its order as its first message.
// The bridge keeps what the companion needs:
//   1. only one unacknowledged wake exists per session,
//   2. a marker-correlated user `message_start` after `agent_start` is the
//      acceptance acknowledgement, and the busy flag brackets the whole RUN,
//      not one assistant turn,
//   3. a delivery that still reaches a streaming agent is QUEUED, not refused
//      (`DELIVER_AS`),
//   4. compaction holds the mailbox: pi REFUSES a prompt while it compacts
//      ("Cannot submit a prompt while compaction is in progress"), and the
//      refusal is swallowed like every other extension-side send failure, so
//      nothing is submitted while pi is not idle (pi's own `ctx.isIdle()`,
//      else the bridge's compaction events) and the queue drains again when
//      it ends.
//
// pi is a dependency of this repo, so the pi API is typechecked against its own
// declarations; what a live session does with it stays VERIFY-ON-PIN.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  watch,
} from "node:fs";
import { basename, join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { writeSessionBridgeState, type SessionBridgeCompaction } from "../src/session-bridge.js";

/**
 * Session name resolution, in order:
 *   1. QCR_SESSION_NAME — set by the daemon in the env it constructs for the
 *      tmux/pi process. Deterministic, so the bridge never has to guess.
 *   2. pi.session?.name — pi 1.4.0's ExtensionAPI declares no `session`
 *      accessor, so on a real pi this branch is inert. `getSessionName()` is
 *      deliberately not used: it would change which inject dir a session with
 *      no QCR_SESSION_NAME watches.
 *   3. "session" as the last resort (matches ledger-pin's default).
 */
export function resolveSessionName(pi: ExtensionAPI, env: NodeJS.ProcessEnv): string {
  const fromEnv = env.QCR_SESSION_NAME?.trim();
  if (fromEnv) return fromEnv;
  const named = (pi as { session?: { name?: unknown } }).session?.name;
  const fromPi = typeof named === "string" ? named.trim() : "";
  if (fromPi) return fromPi;
  return "session";
}

export function resolveInjectDir(pi: ExtensionAPI, env: NodeJS.ProcessEnv, cwd: string): string {
  const explicit = env.QCR_INJECT_DIR?.trim();
  if (explicit) return explicit;
  const root = env.QCR_SANDBOX_ROOT?.trim() || cwd;
  return join(root, "inject", resolveSessionName(pi, env));
}

/** Pending *.md files, oldest name first (names are ISO timestamps). */
export function pendingFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .filter((f) => {
      try {
        return statSync(join(dir, f)).isFile();
      } catch {
        return false;
      }
    })
    .sort();
}

/** Retry cadence for the only submission failure visible at this seam: a
 * synchronous adapter throw. Bounded backoff, reset after a start ack. */
export const RETRY_BASE_MS = 2_000;
export const RETRY_MAX_MS = 30_000;
/** A submitted wake should start a Pi run almost immediately. This bound is
 * deliberately generous for local preflight. Expiry never retries or consumes
 * the wake: it emits one FAILED_LOUD record and leaves the pending file as
 * evidence for the operator. */
export const START_ACK_TIMEOUT_MS = 2 * 60_000;
/** While pi is busy with something the bridge has no end event for (a run it
 * missed the start of, a compaction whose end event did not arrive), look
 * again this often. Only armed while a delivery is actually waiting. */
export const IDLE_RECHECK_MS = 1_000;

/**
 * How a message that reaches pi while the agent is STREAMING is handled
 * (`AgentSessionExtensionApi.sendUserMessage` options, mapped internally onto
 * `streamingBehavior`). Without it pi throws
 *   "Agent is already processing. Specify streamingBehavior…"
 * and — because the extension-facing `sendUserMessage` is fire-and-forget
 * (see `deliver` below) — the bridge never learns, archives the file, and the
 * order is gone. `followUp` queues the message for after the current run
 * instead, which is exactly the wake semantics the daemon wants and keeps the
 * single-shepherd invariant (rule 9): never two instructions in flight, the
 * queued one lands when the run ends.
 *
 * `steer` is deliberately NOT used: it interrupts the turn in progress, and a
 * run's tail must not be cut off.
 * VERIFY-ON-PIN: option name `deliverAs` and its "followUp" value — read off
 * the pinned 0.84.1 dist (`extensions/types.d.ts` sendUserMessage, mapped at
 * `agent-session.js` `streamingBehavior: options?.deliverAs`).
 */
export const DELIVER_AS = "followUp" as const;

/** What one inbox bridge needs, resolved: no env is read past here. */
export interface InjectBridgeConfig {
  /** The mailbox directory the bridge watches. */
  dir: string;
  /** The session's name (the bridge-state receipt carries it). */
  session: string;
  /** The generation and file of the bridge-state receipt; both or neither. */
  bridgeGeneration?: string;
  bridgeStateFile?: string;
}

/** The config the env describes: QCR_INJECT_DIR (else the sandbox root, else
 * `cwd`, plus `inject/<session>`), QCR_SESSION_NAME, and the bridge-state
 * receipt's QCR_SESSION_BRIDGE_GENERATION / QCR_SESSION_BRIDGE_STATE_FILE. */
export function injectBridgeConfigFromEnv(
  pi: ExtensionAPI,
  env: NodeJS.ProcessEnv,
  cwd: string,
): InjectBridgeConfig {
  const bridgeGeneration = env.QCR_SESSION_BRIDGE_GENERATION?.trim();
  const bridgeStateFile = env.QCR_SESSION_BRIDGE_STATE_FILE?.trim();
  return {
    dir: resolveInjectDir(pi, env, cwd),
    session: resolveSessionName(pi, env),
    ...(bridgeGeneration ? { bridgeGeneration } : {}),
    ...(bridgeStateFile ? { bridgeStateFile } : {}),
  };
}

/** The factory that watches `config.dir` and offers each wake to pi. The env
 * shim is extensions/cli/inject-bridge.ts. */
export function createInjectBridge(config: InjectBridgeConfig): ExtensionFactory {
  return (pi) => registerInjectBridge(pi, config);
}

function registerInjectBridge(pi: ExtensionAPI, config: InjectBridgeConfig): void {
  const { dir, session, bridgeGeneration, bridgeStateFile } = config;
  const doneDir = join(dir, ".done");
  let watcher: ReturnType<typeof watch> | undefined;
  let closed = false;
  let bridgeFailed = false;
  let readyPublished = false;
  // pi's compaction, as far as the bridge knows it. Published
  // with the ready receipt so the daemon can tell "waiting behind a
  // compaction" from "lost".
  let compaction: SessionBridgeCompaction = { state: "idle", seq: 0 };

  const publishBridgeState = (
    stage: "ready" | "failed" | "closed",
    failure?: { failedStage: string; detail: string },
  ): void => {
    if (!bridgeGeneration || !bridgeStateFile) return;
    try {
      writeSessionBridgeState(bridgeStateFile, {
        version: 1,
        session,
        generation: bridgeGeneration,
        stage,
        updated_at: new Date().toISOString(),
        ...(failure ? { failed_stage: failure.failedStage, detail: failure.detail } : {}),
        ...(stage === "ready"
          ? { compaction, run_status: busy ? ("active" as const) : ("idle" as const) }
          : {}),
      });
      if (stage === "ready") readyPublished = true;
    } catch (error) {
      console.error(
        `[inject-bridge] FAILED_LOUD could not publish ${stage} receipt: ${String(error)}`,
      );
    }
  };

  const failBridge = (stage: string, detail: string): void => {
    bridgeFailed = true;
    publishBridgeState("failed", { failedStage: stage, detail });
    console.error(`[inject-bridge] FAILED_LOUD ${stage}: ${detail}`);
  };

  // The span that matters is the AGENT RUN, not one assistant turn:
  // `turn_start`/`turn_end` fire once per turn INSIDE a run, so a wake sent
  // in one of those gaps reaches a running agent. `agent_settled` is the only
  // event that may make the session available for another wake.
  let busy = false;
  let runGeneration = 0;
  interface SubmittedWake {
    file: string;
    full: string;
    marker: string;
    submittedAt: number;
    accepted: boolean;
  }
  let submitted: SubmittedWake | undefined;
  let activeWake: SubmittedWake | undefined;
  let retryTimer: NodeJS.Timeout | undefined;
  let retryDelay = RETRY_BASE_MS;
  let startAckTimer: NodeJS.Timeout | undefined;
  let archiveRetryTimer: NodeJS.Timeout | undefined;
  let settleDrainTimer: NodeJS.Timeout | undefined;
  let latestSettledGeneration: number | undefined;
  let idleRecheckTimer: NodeJS.Timeout | undefined;
  let compactionDrainTimer: NodeJS.Timeout | undefined;
  // The latest extension context pi handed any event handler. Its methods
  // resolve pi's state at CALL time (pi 1.0.0 `ExtensionRunner.createContext`),
  // so an old context still answers for the live session — and throws once the
  // runner is torn down, which every reader below turns into "unknown".
  let piCtx: ExtensionContext | undefined;
  let compacting = false;

  const remember = (ctx: unknown): void => {
    if (ctx && typeof ctx === "object") piCtx = ctx as ExtensionContext;
  };

  /** pi's own answer to "may a prompt be submitted now?": no agent run AND no
   * compaction (pi 1.0.0 `AgentSession.isIdle`, exposed as
   * `ExtensionContext.isIdle()`). undefined = unknown (no context yet, a stale
   * one, or a pi without it). VERIFY-ON-PIN: read off the 1.0.0 dist
   * (`core/agent-session.js` `get isIdle()`, `core/extensions/runner.js`
   * `createContext`), not yet observed in a live session. */
  const piIdle = (): boolean | undefined => {
    try {
      const fn = (piCtx as { isIdle?: unknown } | undefined)?.isIdle;
      return typeof fn === "function" ? Boolean(fn.call(piCtx)) : undefined;
    } catch {
      return undefined;
    }
  };

  const republish = (): void => {
    if (readyPublished && !bridgeFailed && !closed) publishBridgeState("ready");
  };

  const beginCompaction = (): void => {
    if (compacting) return;
    compacting = true;
    compaction = {
      state: "running",
      seq: compaction.seq,
      started_at: new Date().toISOString(),
      source: "event",
    };
    republish();
  };

  const endCompaction = (outcome: "compacted" | "failed" | "stale"): void => {
    if (!compacting) return;
    compacting = false;
    compaction = {
      state: "idle",
      seq: compaction.seq + 1,
      ...(compaction.started_at ? { started_at: compaction.started_at } : {}),
      ended_at: new Date().toISOString(),
      outcome,
      ...(compaction.source ? { source: compaction.source } : {}),
    };
    republish();
    // pi emits the end BEFORE it clears its own compaction state (pi 1.0.0
    // `compact()`: `session_compact`, then `_clearManualCompactionState()`), so
    // the queue is looked at on a later turn, never from inside the event.
    if (compactionDrainTimer || closed) return;
    compactionDrainTimer = setTimeout(() => {
      compactionDrainTimer = undefined;
      drain();
    }, 0);
  };

  /** Must the mailbox wait for pi? True while pi compacts or runs something
   * the bridge did not see start. pi's own idle answer wins; without one, the
   * bridge's compaction events decide. */
  const piNotReady = (): boolean => {
    const idle = piIdle();
    if (idle === false) return true;
    if (idle === true) {
      // pi is idle, so a compaction the bridge still holds open ended without
      // its event reaching here — never wait on it forever.
      if (compacting) endCompaction("stale");
      return compacting;
    }
    return compacting;
  };

  const scheduleIdleRecheck = (): void => {
    if (closed || idleRecheckTimer) return;
    idleRecheckTimer = setTimeout(() => {
      idleRecheckTimer = undefined;
      drain();
    }, IDLE_RECHECK_MS);
  };

  const clearStartAckTimer = (): void => {
    if (startAckTimer) clearTimeout(startAckTimer);
    startAckTimer = undefined;
  };

  const scheduleRetry = (): void => {
    if (closed || retryTimer || busy || submitted || activeWake) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
      drain();
    }, retryDelay);
  };

  // An accepted wake whose transport file could not be archived keeps the
  // mailbox closed to successors. Settlement retries the archive once; if that
  // fails too, no agent event is guaranteed to follow, so this timer keeps
  // retrying (backing off) until the file is archived, then drains.
  const archiveAcceptedWake = (): void => {
    const wake = submitted;
    if (closed || !wake?.accepted) return;
    if (archive(wake)) {
      submitted = undefined;
      retryDelay = RETRY_BASE_MS;
      return;
    }
    if (archiveRetryTimer) return;
    archiveRetryTimer = setTimeout(() => {
      archiveRetryTimer = undefined;
      retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
      archiveAcceptedWake();
      if (!submitted) drain();
    }, retryDelay);
  };

  const armStartAckTimeout = (wake: SubmittedWake): void => {
    clearStartAckTimer();
    startAckTimer = setTimeout(() => {
      startAckTimer = undefined;
      if (closed || submitted?.full !== wake.full) return;
      const failure = `${wake.file} was submitted ${Date.now() - wake.submittedAt}ms ago without its correlated run message`;
      // Do not retry or consume: a stale busy reading can make Pi queue
      // `followUp`, and a queued message cannot be withdrawn.
      console.error(
        `[inject-bridge] FAILED_LOUD ${failure}; preserving the pending file and refusing successor delivery`,
      );
    }, START_ACK_TIMEOUT_MS);
  };

  const archive = (wake: SubmittedWake): boolean => {
    try {
      mkdirSync(doneDir, { recursive: true });
      renameSync(wake.full, join(doneDir, basename(wake.full)));
      return true;
    } catch (err) {
      console.error(
        `[inject-bridge] FAILED_LOUD could not acknowledge ${wake.file}: ${String(err)}`,
      );
      return false;
    }
  };

  /** Returns true only when drain may immediately inspect another file. */
  const deliver = (file: string): boolean => {
    const full = join(dir, file);
    if (closed || bridgeFailed || busy || submitted || activeWake || !existsSync(full))
      return false;
    // pi refuses a prompt while it compacts, and the refusal is
    // invisible here. Nothing is reserved or submitted until pi is idle again;
    // the compaction's end (or the recheck) drains the queue.
    if (piNotReady()) {
      scheduleIdleRecheck();
      return false;
    }
    try {
      const content = readFileSync(full, "utf8");
      if (content.trim().length === 0) {
        mkdirSync(doneDir, { recursive: true });
        renameSync(full, join(doneDir, basename(full)));
        return true;
      }

      // Install the single-flight barrier BEFORE invoking Pi: a pinned-Pi
      // adapter may emit agent_start synchronously from inside this call.
      const marker = `<!-- qcr-inject:${file} -->`;
      const wake: SubmittedWake = {
        file,
        full,
        marker,
        submittedAt: Date.now(),
        accepted: false,
      };
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = undefined;
      submitted = wake;
      armStartAckTimeout(wake);
      try {
        const separator = content.endsWith("\n") ? "\n" : "\n\n";
        pi.sendUserMessage(`${content}${separator}${marker}`, { deliverAs: DELIVER_AS });
      } catch (err) {
        // Only a synchronous proxy/adapter throw is observable here. If a
        // synchronous agent_start already acknowledged the wake, do not turn
        // the post-ack throw into a duplicate submission.
        if (submitted?.full === full) {
          submitted = undefined;
          clearStartAckTimer();
          console.error(`[inject-bridge] failed to submit ${file}: ${String(err)}`);
          scheduleRetry();
        } else {
          console.error(
            `[inject-bridge] submission for acknowledged ${file} threw: ${String(err)}`,
          );
        }
      }
      return false;
    } catch (err) {
      failBridge("command_read", `${file}: ${String(err)}`);
      return false;
    }
  };

  // Every trigger funnels through this one synchronous drain. It may consume
  // empty files, but a non-empty submission always stops the drain until its
  // start is acknowledged and its run settles.
  let draining = false;
  let drainAgain = false;
  const drain = (): void => {
    if (closed || bridgeFailed) return;
    if (draining) {
      drainAgain = true;
      return;
    }
    draining = true;
    try {
      do {
        drainAgain = false;
        if (piNotReady()) {
          scheduleIdleRecheck();
          break;
        }
        for (const file of pendingFiles(dir)) {
          if (!deliver(file)) break;
        }
      } while (drainAgain && !closed && !bridgeFailed && !busy && !submitted && !activeWake);
    } finally {
      draining = false;
    }
  };

  const start = (): void => {
    if (watcher || closed || bridgeFailed) return;
    let stage = "mkdir";
    try {
      mkdirSync(dir, { recursive: true });
      mkdirSync(doneDir, { recursive: true });
      stage = "watch_register";
      // Register before sweeping: a daemon rename between sweep and watch
      // registration would otherwise remain pending until an unrelated event.
      watcher = watch(dir, (_event, filename) => {
        if (!filename) {
          drain();
          return;
        }
        // Route EVERY event through the one drain queue (never a per-file
        // deliver): concurrent watch events cannot interleave or reorder —
        // pendingFiles() sorts, so delivery is strictly oldest-first.
        const name = String(filename);
        if (name.endsWith(".md")) drain();
      });
      stage = "initial_drain";
      drain(); // anything dropped before or during watch registration
      if (bridgeFailed) return;
      publishBridgeState("ready");
      console.error(`[inject-bridge] watching ${dir}`);
    } catch (error) {
      watcher?.close();
      watcher = undefined;
      failBridge(stage, String(error));
    }
  };

  // VERIFY-ON-PIN: "session_start" / "session_shutdown" event names (findings §5).
  pi.on("session_start", (_event, ctx) => {
    remember(ctx);
    start();
  });
  pi.on("session_shutdown", () => {
    closed = true;
    if (!bridgeFailed) publishBridgeState("closed");
    if (retryTimer) clearTimeout(retryTimer);
    if (startAckTimer) clearTimeout(startAckTimer);
    if (archiveRetryTimer) clearTimeout(archiveRetryTimer);
    if (settleDrainTimer) clearTimeout(settleDrainTimer);
    if (idleRecheckTimer) clearTimeout(idleRecheckTimer);
    if (compactionDrainTimer) clearTimeout(compactionDrainTimer);
    retryTimer = undefined;
    startAckTimer = undefined;
    archiveRetryTimer = undefined;
    settleDrainTimer = undefined;
    idleRecheckTimer = undefined;
    compactionDrainTimer = undefined;
    piCtx = undefined;
    latestSettledGeneration = undefined;
    watcher?.close();
    watcher = undefined;
  });

  // Run boundaries. Verified on the 0.84.1 dist
  // (`core/extensions/types.d.ts`): `agent_start` = "fired when an agent loop
  // starts", `agent_end` = "…ends", `agent_settled` = "fired after an agent
  // run has FULLY SETTLED and no automatic retry, compaction, or queued
  // continuation will run", `turn_start`/`turn_end` = "at the start/end of
  // EACH TURN".
  // Auto-retry/continue emits another agent_start inside the SAME outer run,
  // but only one agent_settled after the whole run. Do not count inner loop
  // starts as separate runs or the mailbox would remain busy forever.
  const markRunActive = (): void => {
    if (!busy) runGeneration++;
    busy = true;
  };
  pi.on("agent_start", (_event, ctx) => {
    remember(ctx);
    markRunActive();
    republish();
  });
  // A turn cannot start outside a run, so this reaffirms `busy` but is NOT a
  // correlated acceptance ack.
  pi.on("turn_start", () => {
    // Belt for a missed agent_start. Further turns belong to the same run.
    markRunActive();
    republish();
  });

  // Raw agent_start carries no prompt identity. The following user
  // message_start is still part of the run-start sequence and contains the
  // deterministic marker appended above, so unrelated interactive prompts
  // cannot consume the daemon wake. Defensive payload parsing is intentional:
  // everything touching Pi events is VERIFY-ON-PIN.
  pi.on("message_start", (event) => {
    const wake = submitted;
    if (!wake) return;
    const message =
      event && typeof event === "object" ? (event as { message?: unknown }).message : undefined;
    if (!message || typeof message !== "object") return;
    const record = message as { role?: unknown; content?: unknown };
    if (record.role !== "user" || !Array.isArray(record.content)) return;
    const matched = record.content.some((part) => {
      if (!part || typeof part !== "object") return false;
      const text = part as { type?: unknown; text?: unknown };
      return (
        text.type === "text" && typeof text.text === "string" && text.text.includes(wake.marker)
      );
    });
    if (!matched) return;
    // Belt for missed run-start events: a correlated user message can only
    // be emitted from an active run.
    markRunActive();
    republish();
    wake.accepted = true;
    clearStartAckTimer();
    if (!archive(wake)) return;
    submitted = undefined;
    activeWake = wake;
    retryDelay = RETRY_BASE_MS;
  });
  // `agent_settled` is the ONLY clear. `turn_end` must not clear it (a turn
  // ends inside a run) and neither may `agent_end`: pi emits `agent_settled`
  // strictly later, once retries/compaction/queued continuations are done.
  // Never override a missing settle by submitting into a run: daemon-side
  // bounded recovery owns that failure. Delivery is scheduled onto a later
  // event-loop turn so this extension cannot call prompt preflight re-entrantly
  // from Pi's own settlement event dispatch.
  pi.on("agent_settled", (_event, ctx) => {
    if (closed) return;
    remember(ctx);
    // Always retain the newest settlement even when a deferred drain is
    // already scheduled. A complete newer run can start and settle during
    // another extension's event dispatch; dropping that second settle would
    // leave the bridge busy forever after the old callback sees generation
    // drift.
    latestSettledGeneration = runGeneration;
    busy = false;
    if (settleDrainTimer) return;
    settleDrainTimer = setTimeout(() => {
      settleDrainTimer = undefined;
      const settledGeneration = latestSettledGeneration;
      latestSettledGeneration = undefined;
      // A newer run started but has not settled. Auto-retry starts do not
      // change generation because they belong to one outer run and share its
      // final settlement.
      if (busy || settledGeneration === undefined || runGeneration !== settledGeneration) return;
      archiveAcceptedWake();
      activeWake = undefined;
      republish(); // Only full settlement clears the run receipt, never agent_end.
      drain();
    }, 0);
  });

  // Compaction boundaries. pi 1.0.0 emits `session_before_compact`
  // once its compaction state is set (manual and automatic alike, and only
  // while some extension handles it — ledger-pin always does), then exactly
  // one of `session_compact` (the summary landed) or `session_compact_failed`
  // (failed, aborted, or "Nothing to compact"). This handler returns nothing,
  // so it never overrides ledger-pin's compaction (pi keeps the last
  // non-undefined handler result). The inject bridge loads first, so a
  // compaction is visible here before ledger-pin's summariser runs.
  // VERIFY-ON-PIN: event names and order from the 1.0.0 dist
  // (`core/agent-session.js` `compact()` / `_runAutoCompaction()`,
  // `core/extensions/runner.js` `emit`).
  pi.on("session_before_compact", (_event, ctx) => {
    remember(ctx);
    beginCompaction();
  });
  pi.on("session_compact", (_event, ctx) => {
    remember(ctx);
    endCompaction("compacted");
  });
  pi.on("session_compact_failed", (_event, ctx) => {
    remember(ctx);
    endCompaction("failed");
  });
}

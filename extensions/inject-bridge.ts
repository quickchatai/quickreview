// inject-bridge — the daemon→session wake channel.
//
// Modelled on pi's shipped examples/extensions/file-trigger.ts: fs.watch a
// directory and offer the oldest pending *.md file to pi.sendUserMessage().
// Pi's extension API is fire-and-forget, so the file remains pending until the
// next `agent_start` acknowledges that Pi accepted a run. Only then is it moved
// to .done/ (consumption means accepted delivery, never pickup or attempted
// submission). The daemon writes files atomically (tmp + rename), so a watch
// event sees a complete file.
//
// "Resolved" is not "accepted": pi's extension-facing sendUserMessage is
// fire-and-forget and swallows every failure into an error banner, so a drop
// cannot be detected from here at all. Four things cover that loss:
//   1. only one unacknowledged wake may exist per PR session,
//   2. a marker-correlated user `message_start` after `agent_start` is the
//      acceptance acknowledgement, and the busy flag brackets the whole RUN,
//      not one assistant turn,
//   3. a delivery that still reaches a streaming agent is QUEUED, not refused
//      (`DELIVER_AS`),
//   4. the daemon independently reads the prompt receipt out of the session's
//      own JSONL (`SessionHooks.roundPromptAccepted`).
//
// pi also REFUSES a prompt while it compacts — `prompt()` throws "Cannot
// submit a prompt while compaction is in progress" — and the refusal is
// swallowed like every other extension-side send failure. A wake submitted
// INTO a compaction is lost, and manual compaction emits no `agent_settled`
// to re-drain, so the start lease would run out on a healthy, idle session.
// Three more rules cover it:
//   5. compaction holds the mailbox — no submission while pi is not idle
//      (pi's own `ctx.isIdle()`, which counts compaction, else the bridge's
//      compaction events), and the queue drains again when it ends,
//   6. the round-end compaction is the bridge's to run (`ctx.compact()` on the
//      daemon's request file), only while nothing is in flight — never a
//      keystroke that aborts a running wake,
//   7. a command the daemon hands back for REDELIVERY is resubmitted
//      only when pi provably holds nothing of it: it never took it (pi's
//      `input` event never carried its marker), its start lease has passed,
//      and pi is idle with nothing queued.
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
  unlinkSync,
  watch,
} from "node:fs";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sessionCommandMarker } from "../src/session-command.js";
import {
  COMPACTION_REQUEST_FILE,
  OVERSEER_RETIRE_REQUEST_FILE,
  writeSessionBridgeState,
  type SessionBridgeCompaction,
} from "../src/session-bridge.js";
import { SessionCommandLedger } from "./session-command-ledger.js";

/**
 * Session name resolution, in order:
 *   1. QCR_SESSION_NAME — set by the daemon in the env it constructs for the
 *      tmux/pi process. Deterministic, so the bridge never has to guess.
 *   2. pi.session?.name — pi 1.3.0's ExtensionAPI declares no `session`
 *      accessor, so on a real pi this branch is inert. `getSessionName()` is
 *      deliberately not used: it would change which inject dir a session with
 *      no QCR_SESSION_NAME watches.
 *   3. "overseer" as the last resort (the only unnumbered session).
 */
export function resolveSessionName(pi: ExtensionAPI, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.QCR_SESSION_NAME?.trim();
  if (fromEnv) return fromEnv;
  const named = (pi as { session?: { name?: unknown } }).session?.name;
  const fromPi = typeof named === "string" ? named.trim() : "";
  if (fromPi) return fromPi;
  return "overseer";
}

export function resolveInjectDir(pi: ExtensionAPI, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.QCR_INJECT_DIR?.trim();
  if (explicit) return explicit;
  const root = env.QCR_SANDBOX_ROOT?.trim() || process.cwd();
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
 * deliberately generous for local preflight while remaining far below a
 * round's deadline. Expiry never retries or consumes the wake: it
 * emits one FAILED_LOUD record and leaves the pending file as recovery
 * evidence for the daemon/operator watchdogs. */
export const START_ACK_TIMEOUT_MS = 2 * 60_000;
/** While pi is busy with something the bridge has no end event for (a run it
 * missed the start of, a compaction whose end event did not arrive), look
 * again this often. Only armed while a delivery is actually waiting. */
export const IDLE_RECHECK_MS = 1_000;

function positiveEnvMs(name: string): number | undefined {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

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
 * round's tail (ledger, then the verdict file) is the one part that must not
 * be cut off.
 * VERIFY-ON-PIN: option name `deliverAs` and its "followUp" value — read off
 * the pinned 0.84.1 dist (`extensions/types.d.ts` sendUserMessage, mapped at
 * `agent-session.js` `streamingBehavior: options?.deliverAs`).
 */
export const DELIVER_AS = "followUp" as const;

export const activate: (pi: ExtensionAPI) => void = (pi) => {
  const dir = resolveInjectDir(pi);
  const doneDir = join(dir, ".done");
  const terminalDir = join(dir, ".terminal");
  let watcher: ReturnType<typeof watch> | undefined;
  let closed = false;
  const stateDb = process.env.QCR_STATE_DB?.trim();
  const session = resolveSessionName(pi);
  const root = process.env.QCR_SANDBOX_ROOT?.trim() || process.cwd();
  const prSession = /^pr-\d+$/.test(session);
  // Managed daemon PR sessions explicitly require the SQLite ledger. The
  // default is fail-closed; only isolated smoke/replay managers pass "0".
  const ledgerRequired =
    prSession && process.env.QCR_SESSION_BRIDGE_LEDGER_REQUIRED?.trim() !== "0";
  const bridgeGeneration = process.env.QCR_SESSION_BRIDGE_GENERATION?.trim();
  const bridgeStateFile = process.env.QCR_SESSION_BRIDGE_STATE_FILE?.trim();
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

  if (ledgerRequired && (!bridgeGeneration || !bridgeStateFile)) {
    failBridge(
      "startup_fence",
      "missing QCR_SESSION_BRIDGE_GENERATION or QCR_SESSION_BRIDGE_STATE_FILE",
    );
  }
  if (ledgerRequired && !stateDb) {
    failBridge("state_db", "missing QCR_STATE_DB for a ledger-required PR bridge");
  }

  // The start lease the ledger reserves with — the daemon's own
  // (`sessions.ts` passes it in the pi env). Read once: the bridge's own
  // bounds must agree with the reservation it made.
  const startLeaseMs = positiveEnvMs("QCR_SESSION_COMMAND_START_LEASE_MS") ?? START_ACK_TIMEOUT_MS;

  let ledger: SessionCommandLedger | undefined;
  if (ledgerRequired && stateDb) {
    try {
      ledger = new SessionCommandLedger(stateDb, root, session, undefined, {
        startMs: positiveEnvMs("QCR_SESSION_COMMAND_START_LEASE_MS"),
        runningMs: positiveEnvMs("QCR_SESSION_COMMAND_RUNNING_LEASE_MS"),
      });
    } catch (err) {
      failBridge("ledger_open", String(err));
    }
  }
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
    commandId?: string;
    /** pi's `input` event carried this wake's marker: pi took the submission
     * past its compaction refusal and holds it (preflight or queue) — or
     * failed it after, which the bridge cannot see. Never resubmitted. */
    inputSeen?: boolean;
    /** The "pi holds it" refusal of a redelivery is logged once per wake. */
    holdLogged?: boolean;
  }
  let submitted: SubmittedWake | undefined;
  let activeWake: SubmittedWake | undefined;
  let retryTimer: NodeJS.Timeout | undefined;
  let retryDelay = RETRY_BASE_MS;
  let startAckTimer: NodeJS.Timeout | undefined;
  let settleDrainTimer: NodeJS.Timeout | undefined;
  let latestSettledGeneration: number | undefined;
  let idleRecheckTimer: NodeJS.Timeout | undefined;
  let compactionDrainTimer: NodeJS.Timeout | undefined;
  let reclaimTimer: NodeJS.Timeout | undefined;
  // The latest extension context pi handed any event handler. Its methods
  // resolve pi's state at CALL time (pi 1.0.0 `ExtensionRunner.createContext`),
  // so an old context still answers for the live session — and throws once the
  // runner is torn down, which every reader below turns into "unknown".
  let piCtx: ExtensionContext | undefined;
  let compacting = false;
  // True from the bridge's own `ctx.compact()` call until pi reports its end:
  // pi sets its compaction flag only after an awaited abort, so in that first
  // moment pi still reads idle and that must not be taken for a missed end.
  let compactionRequestInFlight = false;

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

  /** Are prompts queued inside pi (steer/followUp)? pi 1.0.0
   * `ExtensionContext.hasPendingMessages()`. undefined = unknown.
   * VERIFY-ON-PIN, as above. */
  const piHasPending = (): boolean | undefined => {
    try {
      const fn = (piCtx as { hasPendingMessages?: unknown } | undefined)?.hasPendingMessages;
      return typeof fn === "function" ? Boolean(fn.call(piCtx)) : undefined;
    } catch {
      return undefined;
    }
  };

  const republish = (): void => {
    if (readyPublished && !bridgeFailed && !closed) publishBridgeState("ready");
  };

  const beginCompaction = (source: "request" | "event"): void => {
    if (compacting) return;
    compacting = true;
    compaction = {
      state: "running",
      seq: compaction.seq,
      started_at: new Date().toISOString(),
      source,
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
      if (compacting && !compactionRequestInFlight) endCompaction("stale");
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

  const armStartAckTimeout = (wake: SubmittedWake): void => {
    clearStartAckTimer();
    startAckTimer = setTimeout(() => {
      startAckTimer = undefined;
      if (closed || submitted?.full !== wake.full) return;
      const failure = `${wake.file} was submitted ${Date.now() - wake.submittedAt}ms ago without its correlated run message`;
      // Do NOT terminalize the durable reservation here. A stale busy reading
      // can make Pi queue `followUp`; that queued command cannot be withdrawn.
      // Leaving the short running lease expired lets the daemon's recovery
      // reconcile JSONL/liveness: on a live, ready session it REDELIVERS
      // first (`reclaimRedelivered` below resubmits only when pi provably
      // holds nothing), and only a dead session or spent redeliveries reach
      // the kill-before-replay.
      console.error(
        `[inject-bridge] FAILED_LOUD ${failure}; preserving the pending file and refusing successor delivery`,
      );
    }, startLeaseMs);
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

  const disposeTerminalTransport = (
    full: string,
    file: string,
    terminal: { id: string; status: "acked" | "failed" | "cancelled"; blocksSuccessors: boolean },
  ): boolean => {
    // SQLite + immutable payload_path own terminal evidence. The exact
    // inject_path copy is only transport residue: acked is a delivery receipt;
    // failed/cancelled use a distinct non-delivery quarantine.
    const targetDir = terminal.status === "acked" ? doneDir : terminalDir;
    const targetName =
      terminal.status === "acked" ? basename(full) : `${basename(full)}.${terminal.status}`;
    try {
      mkdirSync(targetDir, { recursive: true });
      renameSync(full, join(targetDir, targetName));
    } catch (error) {
      failBridge(
        "terminal_transport",
        `${file}: could not move stale ${terminal.status} transport: ${String(error)}`,
      );
      return false;
    }
    console.error(
      `[inject-bridge] moved stale ${terminal.status} transport ${file} for command ${terminal.id}`,
    );
    if (terminal.blocksSuccessors) {
      failBridge(
        "command_link",
        `failed command ${terminal.id} still owns the serialized session lane`,
      );
      return false;
    }
    return true;
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
    if (ledgerRequired && !ledger) {
      failBridge("ledger_open", "durable command ledger is unavailable");
      return false;
    }
    try {
      const payload = readFileSync(full);
      const content = payload.toString("utf8");
      const link = ledger?.linkOrAdopt(full, payload);
      if (link && !link.ok) {
        if (link.terminal) return disposeTerminalTransport(full, file, link.terminal);
        failBridge("command_link", `${file}: ${link.reason}`);
        return false;
      }
      if (content.trim().length === 0) {
        if (link?.ok && ledger) {
          ledger.failPending(link.command.id, "empty command payload");
          failBridge(
            "payload_validate",
            `refusing empty command ${link.command.id}; preserving its file`,
          );
          return false;
        }
        mkdirSync(doneDir, { recursive: true });
        renameSync(full, join(doneDir, basename(full)));
        return true;
      }

      // Install the single-flight barrier BEFORE invoking Pi: a pinned-Pi
      // adapter may emit agent_start synchronously from inside this call.
      if (link?.ok && ledger && !ledger.reserve(link.command.id)) {
        failBridge("command_reserve", `${file}: command ${link.command.id} could not be reserved`);
        return false;
      }
      const marker = link?.ok
        ? sessionCommandMarker(link.command.id, link.command.payload_sha256)
        : `<!-- qcr-inject:${file} -->`;
      const wake: SubmittedWake = {
        file,
        full,
        marker,
        submittedAt: Date.now(),
        accepted: false,
        ...(link?.ok ? { commandId: link.command.id } : {}),
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
          if (submitted.commandId && ledger && !ledger.releasePending(submitted.commandId)) {
            console.error(
              `[inject-bridge] FAILED_LOUD could not release command ${submitted.commandId} after synchronous throw`,
            );
          }
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
      scheduleRetry();
      return false;
    }
  };

  /**
   * The daemon REDELIVERS a command whose start lease
   * ran out on this live, ready bridge by handing the same row back to
   * `pending` (same id, path and bytes) and rewriting its file. If this bridge
   * still holds that command as submitted-but-never-started, its barrier is
   * stale — but only pi can say whether the earlier submission is truly gone.
   * It is resubmitted only when ALL of these hold; unknown is never loss, so
   * whenever one cannot be shown the barrier stays and the daemon's bounded
   * recovery decides:
   *   - pi never took it: its `input` event never carried this wake's marker
   *     (pi reads idle through its whole prompt preflight — auth, a pre-prompt
   *     compaction check, before_agent_start — so idleness alone cannot say a
   *     submission is gone; pi emits `input` right after the compaction
   *     refusal, so a wake refused into a compaction never shows one),
   *   - its own start lease has passed since this bridge submitted it,
   *   - pi is idle (no run, no compaction) AND holds nothing queued.
   */
  const reclaimRedelivered = (): void => {
    const wake = submitted;
    if (!wake || wake.accepted || !wake.commandId || !ledger) return;
    if (!ledger.redeliveryRequested(wake.commandId)) return;
    if (wake.inputSeen) {
      if (!wake.holdLogged) {
        wake.holdLogged = true;
        console.error(
          `[inject-bridge] not redelivering ${wake.file}: pi took command ${wake.commandId} past its input stage and may still start it`,
        );
      }
      return;
    }
    const age = Date.now() - wake.submittedAt;
    if (age < startLeaseMs) {
      // A belt over the daemon's own lease: look again once this
      // submission is as old as the lease it was reserved under.
      if (!reclaimTimer && !closed) {
        reclaimTimer = setTimeout(() => {
          reclaimTimer = undefined;
          drain();
        }, startLeaseMs - age);
      }
      return;
    }
    if (busy || compacting || activeWake) return;
    if (piIdle() !== true || piHasPending() !== false) return;
    clearStartAckTimer();
    submitted = undefined;
    console.error(
      `[inject-bridge] redelivering ${wake.file}: command ${wake.commandId} never started and pi holds nothing queued`,
    );
  };

  const requestPath = join(dir, COMPACTION_REQUEST_FILE);

  /**
   * Run the daemon's round-end compaction request through pi's
   * own `ctx.compact()` — but only while the mailbox is empty-handed: no run,
   * no submitted or active wake, pi idle. Returns true while a compaction holds
   * the mailbox (running, or just started), so the caller delivers nothing.
   * The request is consumed exactly once, before the call, so a failure is
   * never retried into a loop; a compaction is an optimisation, not owed work.
   * VERIFY-ON-PIN: `ExtensionContext.compact({ onComplete, onError })` is pi
   * 1.0.0's (`core/extensions/types.d.ts` `CompactOptions`; it calls the same
   * `AgentSession.compact()` as `/compact`, without awaiting it).
   */
  const startRequestedCompaction = (): boolean => {
    if (compacting) {
      // Still running — unless pi reads idle, which closes a compaction whose
      // end never reached the bridge (`piNotReady`), and the queue goes on.
      if (piNotReady()) {
        scheduleIdleRecheck();
        return true;
      }
    }
    if (!existsSync(requestPath)) return false;
    if (busy || submitted || activeWake) return false;
    if (piNotReady()) {
      scheduleIdleRecheck();
      return true;
    }
    try {
      mkdirSync(doneDir, { recursive: true });
      renameSync(
        requestPath,
        join(
          doneDir,
          `${new Date().toISOString().replace(/[:.]/g, "-")}${COMPACTION_REQUEST_FILE}`,
        ),
      );
    } catch (err) {
      try {
        unlinkSync(requestPath);
      } catch {
        console.error(
          `[inject-bridge] FAILED_LOUD could not consume the compaction request: ${String(err)}`,
        );
        return false;
      }
    }
    const compact = (piCtx as { compact?: unknown } | undefined)?.compact;
    if (typeof compact !== "function") {
      console.error(
        "[inject-bridge] compaction requested, but pi offers no ctx.compact here — skipped",
      );
      return false;
    }
    compactionRequestInFlight = true;
    beginCompaction("request");
    const finished = (outcome: "compacted" | "failed", detail?: string): void => {
      compactionRequestInFlight = false;
      if (detail) console.error(`[inject-bridge] requested compaction ${outcome}: ${detail}`);
      endCompaction(outcome);
    };
    try {
      compact.call(piCtx, {
        onComplete: () => finished("compacted"),
        onError: (error: unknown) =>
          finished("failed", error instanceof Error ? error.message : String(error)),
      });
    } catch (err) {
      finished("failed", String(err));
      return false;
    }
    return true;
  };

  // Every trigger funnels through this one synchronous drain. It may consume
  // empty files, but a non-empty submission always stops the drain until its
  // start is acknowledged and its run settles. A requested compaction goes
  // first: it is the end of the round the queued wakes follow.
  const retireIdleOverseer = (): boolean => {
    if (session !== "overseer" || !bridgeGeneration) return false;
    try {
      const requestPath = join(dir, OVERSEER_RETIRE_REQUEST_FILE);
      if (!existsSync(requestPath) || statSync(requestPath).size > 4096) return false;
      const request = JSON.parse(readFileSync(requestPath, "utf8")) as Record<string, unknown>;
      if (
        request["version"] !== 1 ||
        request["generation"] !== bridgeGeneration ||
        typeof request["nonce"] !== "string" ||
        !request["nonce"]
      )
        return false;
      if (
        busy ||
        submitted ||
        activeWake ||
        compacting ||
        compactionRequestInFlight ||
        piIdle() !== true ||
        piHasPending() !== false ||
        pendingFiles(dir).length > 0 ||
        existsSync(join(dir, COMPACTION_REQUEST_FILE))
      )
        return false;
      const birth = JSON.parse(
        readFileSync(join(root, "state", "sessions", "overseer.json"), "utf8"),
      ) as Record<string, unknown>;
      if (birth["session"] !== session || birth["bridge_generation"] !== bridgeGeneration)
        return false;
      // Consume and exit in one synchronous callback: no fresh prompt can be
      // admitted between the in-process idle proof and process termination.
      unlinkSync(requestPath);
      closed = true;
      watcher?.close();
      process.exit(0);
      return true;
    } catch {
      return false; // Malformed/unreadable/stale requests never terminate work.
    }
  };

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
        if (retireIdleOverseer()) break;
        reclaimRedelivered();
        if (startRequestedCompaction()) break;
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
      // A compaction request left from before this pi started
      // belonged to the conversation that was there then; a newborn one has
      // nothing to compact, and its first job is the command a recovery wrote
      // before birth, which the startup drain below must reserve at once.
      stage = "stale_compaction_request";
      if (existsSync(requestPath)) {
        try {
          renameSync(
            requestPath,
            join(
              doneDir,
              `${new Date().toISOString().replace(/[:.]/g, "-")}-stale${COMPACTION_REQUEST_FILE}`,
            ),
          );
        } catch {
          try {
            unlinkSync(requestPath);
          } catch (err) {
            // Not worth failing the bridge over: the worst case is one
            // compaction of a fresh conversation before its first command.
            console.error(
              `[inject-bridge] could not discard a stale compaction request: ${String(err)}`,
            );
          }
        }
      }
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
        if (
          name.endsWith(".md") ||
          name === COMPACTION_REQUEST_FILE ||
          name === OVERSEER_RETIRE_REQUEST_FILE
        )
          drain();
      });
      stage = "initial_drain";
      drain(); // anything dropped before or during watch registration
      if (bridgeFailed) return;
      const blockingFailure = ledger?.blockingFailedCommand();
      if (blockingFailure) {
        failBridge(
          "command_link",
          `failed command ${blockingFailure.id} still owns the serialized session lane`,
        );
        return;
      }
      // Recovery writes its immutable command file before Pi birth. Since the
      // drain above is synchronous and reserve precedes sendUserMessage, this
      // receipt means a pre-existing command has already incremented attempt.
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
    if (settleDrainTimer) clearTimeout(settleDrainTimer);
    if (idleRecheckTimer) clearTimeout(idleRecheckTimer);
    if (compactionDrainTimer) clearTimeout(compactionDrainTimer);
    if (reclaimTimer) clearTimeout(reclaimTimer);
    retryTimer = undefined;
    startAckTimer = undefined;
    settleDrainTimer = undefined;
    idleRecheckTimer = undefined;
    compactionDrainTimer = undefined;
    reclaimTimer = undefined;
    piCtx = undefined;
    latestSettledGeneration = undefined;
    ledger?.close();
    ledger = undefined;
    watcher?.close();
    watcher = undefined;
  });

  // Run boundaries. Verified on the 0.84.1 dist
  // (`core/extensions/types.d.ts`): `agent_start` = "fired when an agent loop
  // starts", `agent_end` = "…ends", `agent_settled` = "fired after an agent
  // run has FULLY SETTLED and no automatic retry, compaction, or queued
  // continuation will run", `turn_start`/`turn_end` = "at the start/end of
  // EACH TURN".
  pi.on("agent_start", (_event, ctx) => {
    remember(ctx);
    // Auto-retry/continue emits another agent_start inside the SAME outer run,
    // but only one agent_settled after the whole run. Do not count inner loop
    // starts as separate runs or the mailbox would remain busy forever.
    if (!busy) runGeneration++;
    busy = true;
    republish();
  });
  // A turn cannot start outside a run, so this reaffirms `busy` but is NOT a
  // correlated acceptance ack.
  pi.on("turn_start", () => {
    // Belt for a missed agent_start. Further turns belong to the same run.
    if (!busy) runGeneration++;
    busy = true;
    republish();
  });

  // pi 1.0.0 `prompt()` emits `input` (source
  // "extension" for this bridge's own sends) right after its compaction
  // refusal and BEFORE the rest of its preflight — auth, the pre-prompt
  // compaction check, before_agent_start — during all of which it still reads
  // idle. A marker seen here means pi holds this submission (or failed it
  // after, invisibly), so `reclaimRedelivered` never sends it again. Returns
  // nothing: the input is never transformed or handled. VERIFY-ON-PIN: event
  // name, `text` field and emission point read off the 1.0.0 dist
  // (`core/agent-session.js` `prompt()` / `_runInputHandlers`,
  // `core/extensions/runner.js` `emitInput`), not yet observed live.
  pi.on("input", (event, ctx) => {
    remember(ctx);
    const wake = submitted;
    if (!wake || wake.accepted) return;
    const text =
      event && typeof event === "object" ? (event as { text?: unknown }).text : undefined;
    if (typeof text === "string" && text.includes(wake.marker)) wake.inputSeen = true;
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
    if (!busy) {
      // Belt for missed run-start events: a correlated user message can only
      // be emitted from an active run.
      runGeneration++;
      busy = true;
    }
    republish();
    // The daemon may have handed this very command back for redelivery
    // a moment before pi started it: the row is `pending` again.
    // The run that just started IS that command, so take it back and accept
    // it rather than fail the lane.
    if (
      wake.commandId &&
      ledger &&
      !ledger.markAccepted(wake.commandId) &&
      !(
        ledger.redeliveryRequested(wake.commandId) &&
        ledger.reserve(wake.commandId) &&
        ledger.markAccepted(wake.commandId)
      )
    ) {
      clearStartAckTimer();
      console.error(
        `[inject-bridge] FAILED_LOUD command ${wake.commandId} reached Pi but a stale owner cannot mark it accepted`,
      );
      return;
    }
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
      const wake = submitted;
      if (wake?.accepted && archive(wake)) {
        submitted = undefined;
        activeWake = wake;
        retryDelay = RETRY_BASE_MS;
      }
      const completed = activeWake;
      if (completed?.commandId && ledger && !ledger.ack(completed.commandId)) {
        console.error(
          `[inject-bridge] FAILED_LOUD stale owner cannot ack command ${completed.commandId}`,
        );
        return;
      }
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
    beginCompaction(compactionRequestInFlight ? "request" : "event");
  });
  pi.on("session_compact", (_event, ctx) => {
    remember(ctx);
    endCompaction("compacted");
  });
  pi.on("session_compact_failed", (_event, ctx) => {
    remember(ctx);
    endCompaction("failed");
  });
};

export default activate;

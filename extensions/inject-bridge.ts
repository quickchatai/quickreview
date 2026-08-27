// inject-bridge — the daemon→session wake channel (spec §4, brief B3 step 3).
//
// Modelled on pi's shipped examples/extensions/file-trigger.ts (findings §3
// option 2): fs.watch a directory and offer the oldest pending *.md file to
// pi.sendUserMessage(). Pi's extension API is fire-and-forget, so the file
// remains pending until the next `agent_start` acknowledges that Pi accepted
// a run. Only then is it moved to .done/ (consumption means
// accepted delivery, never pickup or attempted submission). The daemon writes
// files atomically (tmp + rename), so a watch event sees a complete file.
//
// #5362 (2026-08-21) proved that "resolved" is not "accepted": pi's
// extension-facing sendUserMessage is fire-and-forget and swallows every
// failure into an error banner, so a drop cannot be detected from here at all.
// Four things cover different halves of that loss:
//   1. only one unacknowledged wake may exist per PR session,
//   2. a marker-correlated user `message_start` after `agent_start` is the
//      acceptance acknowledgement, and the busy flag brackets the whole RUN,
//      not one assistant turn,
//   3. a delivery that still reaches a streaming agent is QUEUED, not refused
//      (`DELIVER_AS`),
//   4. the daemon independently reads the prompt receipt out of the session's
//      own JSONL (`SessionHooks.roundPromptAccepted`).
//
// pi is not installed here — everything touching the pi API is VERIFY-ON-PIN.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, watch } from "node:fs";
import { basename, join } from "node:path";
import type { Pi } from "@earendil-works/pi-coding-agent";
import { sessionCommandMarker } from "../src/session-command.js";
import { SessionCommandLedger } from "./session-command-ledger.js";

/**
 * Session name resolution, in order:
 *   1. QCR_SESSION_NAME — set by the daemon in the env it constructs for the
 *      tmux/pi process. Deterministic, so the bridge never has to guess.
 *   2. pi.session?.name — // VERIFY-ON-PIN: accessor name and availability at
 *      session_start.
 *   3. "overseer" as the last resort (the only unnumbered session).
 */
export function resolveSessionName(pi: Pi, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.QCR_SESSION_NAME?.trim();
  if (fromEnv) return fromEnv;
  const fromPi = typeof pi.session?.name === "string" ? pi.session.name.trim() : "";
  if (fromPi) return fromPi;
  return "overseer";
}

export function resolveInjectDir(pi: Pi, env: NodeJS.ProcessEnv = process.env): string {
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
 * deliberately generous for local preflight while remaining far below the
 * old 75-minute round deadline. Expiry never retries or consumes the wake: it
 * emits one FAILED_LOUD record and leaves the pending file as recovery
 * evidence for the daemon/operator watchdogs. */
export const START_ACK_TIMEOUT_MS = 2 * 60_000;

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

export const activate: (pi: Pi) => void = (pi) => {
  const dir = resolveInjectDir(pi);
  const doneDir = join(dir, ".done");
  let watcher: ReturnType<typeof watch> | undefined;
  let closed = false;
  const stateDb = process.env.QCR_STATE_DB?.trim();
  const session = resolveSessionName(pi);
  const root = process.env.QCR_SANDBOX_ROOT?.trim() || process.cwd();
  const ledgerRequired = Boolean(stateDb && /^pr-\d+$/.test(session));
  let ledger: SessionCommandLedger | undefined;
  if (ledgerRequired) {
    try {
      ledger = new SessionCommandLedger(stateDb!, root, session);
    } catch (err) {
      console.error(`[inject-bridge] FAILED_LOUD could not open durable command ledger: ${String(err)}`);
    }
  }
  // The span that matters is the AGENT RUN, not one assistant turn:
  // `turn_start`/`turn_end` fire once per turn INSIDE a run. #5362's order
  // landed in one of those gaps. `agent_settled` is the only event that may
  // make the session available for another wake.
  let busy = false;
  let runGeneration = 0;
  interface SubmittedWake {
    file: string;
    full: string;
    marker: string;
    submittedAt: number;
    accepted: boolean;
    commandId?: string;
  }
  let submitted: SubmittedWake | undefined;
  let activeWake: SubmittedWake | undefined;
  let retryTimer: NodeJS.Timeout | undefined;
  let retryDelay = RETRY_BASE_MS;
  let startAckTimer: NodeJS.Timeout | undefined;
  let settleDrainTimer: NodeJS.Timeout | undefined;
  let latestSettledGeneration: number | undefined;

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
      // Leaving the short running lease expired lets reconcile JSONL/
      // liveness and kill the old session before any safe retry.
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
      console.error(`[inject-bridge] FAILED_LOUD could not acknowledge ${wake.file}: ${String(err)}`);
      return false;
    }
  };

  /** Returns true only when drain may immediately inspect another file. */
  const deliver = (file: string): boolean => {
    const full = join(dir, file);
    if (closed || busy || submitted || activeWake || !existsSync(full)) return false;
    if (ledgerRequired && !ledger) return false;
    try {
      const payload = readFileSync(full);
      const content = payload.toString("utf8");
      const link = ledger?.linkOrAdopt(full, payload);
      if (link && !link.ok) {
        console.error(`[inject-bridge] FAILED_LOUD refusing ${file}: ${link.reason}`);
        return false;
      }
      if (content.trim().length === 0) {
        if (link?.ok && ledger) {
          ledger.failPending(link.command.id, "empty command payload");
          console.error(`[inject-bridge] FAILED_LOUD refusing empty command ${link.command.id}; preserving its file`);
          return false;
        }
        mkdirSync(doneDir, { recursive: true });
        renameSync(full, join(doneDir, basename(full)));
        return true;
      }

      // Install the single-flight barrier BEFORE invoking Pi: a pinned-Pi
      // adapter may emit agent_start synchronously from inside this call.
      if (link?.ok && ledger && !ledger.reserve(link.command.id)) {
        console.error(`[inject-bridge] FAILED_LOUD refusing ${file}: command ${link.command.id} could not be reserved`);
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
            console.error(`[inject-bridge] FAILED_LOUD could not release command ${submitted.commandId} after synchronous throw`);
          }
          submitted = undefined;
          clearStartAckTimer();
          console.error(`[inject-bridge] failed to submit ${file}: ${String(err)}`);
          scheduleRetry();
        } else {
          console.error(`[inject-bridge] submission for acknowledged ${file} threw: ${String(err)}`);
        }
      }
      return false;
    } catch (err) {
      console.error(`[inject-bridge] failed to read or consume ${file}: ${String(err)}`);
      scheduleRetry();
      return false;
    }
  };

  // Every trigger funnels through this one synchronous drain. It may consume
  // empty files, but a non-empty submission always stops the drain until its
  // start is acknowledged and its run settles.
  let draining = false;
  let drainAgain = false;
  const drain = (): void => {
    if (closed) return;
    if (draining) {
      drainAgain = true;
      return;
    }
    draining = true;
    try {
      do {
        drainAgain = false;
        for (const file of pendingFiles(dir)) {
          if (!deliver(file)) break;
        }
      } while (drainAgain && !closed && !busy && !submitted && !activeWake);
    } finally {
      draining = false;
    }
  };

  const start = (): void => {
    if (watcher || closed) return;
    mkdirSync(dir, { recursive: true });
    mkdirSync(doneDir, { recursive: true });
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
    drain(); // anything dropped before or during watch registration
    console.error(`[inject-bridge] watching ${dir}`);
  };

  // VERIFY-ON-PIN: "session_start" / "session_shutdown" event names (findings §5).
  pi.on("session_start", () => start());
  pi.on("session_shutdown", () => {
    closed = true;
    if (retryTimer) clearTimeout(retryTimer);
    if (startAckTimer) clearTimeout(startAckTimer);
    if (settleDrainTimer) clearTimeout(settleDrainTimer);
    retryTimer = undefined;
    startAckTimer = undefined;
    settleDrainTimer = undefined;
    latestSettledGeneration = undefined;
    ledger?.close();
    ledger = undefined;
    watcher?.close();
    watcher = undefined;
  });

  // Run boundaries. Verified on the pinned 0.84.1 dist
  // (`core/extensions/types.d.ts`): `agent_start` = "fired when an agent loop
  // starts", `agent_end` = "…ends", `agent_settled` = "fired after an agent
  // run has FULLY SETTLED and no automatic retry, compaction, or queued
  // continuation will run", `turn_start`/`turn_end` = "at the start/end of
  // EACH TURN".
  pi.on("agent_start", () => {
    // Auto-retry/continue emits another agent_start inside the SAME outer run,
    // but only one agent_settled after the whole run. Do not count inner loop
    // starts as separate runs or the mailbox would remain busy forever.
    if (!busy) runGeneration++;
    busy = true;
  });
  // A turn cannot start outside a run, so this reaffirms `busy` but is NOT a
  // correlated acceptance ack.
  pi.on("turn_start", () => {
    // Belt for a missed agent_start. Further turns belong to the same run.
    if (!busy) runGeneration++;
    busy = true;
  });

  // Raw agent_start carries no prompt identity. The following user
  // message_start is still part of the run-start sequence and contains the
  // deterministic marker appended above, so unrelated interactive prompts
  // cannot consume the daemon wake. Defensive payload parsing is intentional:
  // everything touching Pi events is VERIFY-ON-PIN.
  pi.on("message_start", (event) => {
    const wake = submitted;
    if (!wake) return;
    const message = event && typeof event === "object" ? (event as { message?: unknown }).message : undefined;
    if (!message || typeof message !== "object") return;
    const record = message as { role?: unknown; content?: unknown };
    if (record.role !== "user" || !Array.isArray(record.content)) return;
    const matched = record.content.some((part) => {
      if (!part || typeof part !== "object") return false;
      const text = (part as { type?: unknown; text?: unknown });
      return text.type === "text" && typeof text.text === "string" && text.text.includes(wake.marker);
    });
    if (!matched) return;
    if (!busy) {
      // Belt for missed run-start events: a correlated user message can only
      // be emitted from an active run.
      runGeneration++;
      busy = true;
    }
    if (wake.commandId && ledger && !ledger.markAccepted(wake.commandId)) {
      clearStartAckTimer();
      console.error(`[inject-bridge] FAILED_LOUD command ${wake.commandId} reached Pi but a stale owner cannot mark it accepted`);
      return;
    }
    wake.accepted = true;
    clearStartAckTimer();
    if (!archive(wake)) return;
    submitted = undefined;
    activeWake = wake;
    retryDelay = RETRY_BASE_MS;
  });
  // `agent_settled` is the ONLY clear. `turn_end` must not clear it (that was
  // the #5362 bug) and neither may `agent_end`: pi emits `agent_settled`
  // strictly later, once retries/compaction/queued continuations are done.
  // Never override a missing settle by submitting into a run: daemon-side
  // bounded recovery owns that failure. Delivery is scheduled onto a later
  // event-loop turn so this extension cannot call prompt preflight re-entrantly
  // from Pi's own settlement event dispatch.
  pi.on("agent_settled", () => {
    if (closed) return;
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
        console.error(`[inject-bridge] FAILED_LOUD stale owner cannot ack command ${completed.commandId}`);
        return;
      }
      activeWake = undefined;
      drain();
    }, 0);
  });
};

export default activate;

// inject-bridge — the daemon→session wake channel (spec §4, brief B3 step 3).
//
// Modelled on pi's shipped examples/extensions/file-trigger.ts (findings §3
// option 2): fs.watch a directory, and on every new *.md file read it, hand
// the content to pi.sendUserMessage(), and — only once that submission
// resolved — move the file into .done/ so it cannot fire twice (:
// consumption means delivery, never mere pickup). The daemon writes those
// files atomically (tmp + rename), so a watch event always sees a complete
// file.
//
// pi is not installed here — everything touching the pi API is VERIFY-ON-PIN.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, watch } from "node:fs";
import { basename, join } from "node:path";
import type { Pi } from "@earendil-works/pi-coding-agent";

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

/** Retry cadence while a delivery cannot be made (busy session / a failed
 * send). Bounded backoff: base doubles up to the cap, reset on success. */
export const RETRY_BASE_MS = 2_000;
export const RETRY_MAX_MS = 30_000;
/** How long the busy flag may defer deliveries before it is overridden. If
 * the turn-boundary events never fire (or fire under other names on the
 * pinned pi), busy-tracking must degrade to the old behaviour — not to a
 * bridge that never delivers anything again. */
export const BUSY_MAX_HOLD_MS = 15 * 60_000;

export const activate: (pi: Pi) => void = (pi) => {
  const dir = resolveInjectDir(pi);
  const doneDir = join(dir, ".done");
  const inFlight = new Set<string>();
  let watcher: ReturnType<typeof watch> | undefined;
  let closed = false;
  // Best-effort turn tracking. pi.sendUserMessage() while the agent
  // is mid-turn dropped the message on the floor (#5317 round 2, #5257 round
  // 8: the inject was consumed during a recheck turn and the round prompt
  // never reached the session). While a turn is believed in flight, deliveries
  // are DEFERRED, the file stays where it is, and the turn-end events drain.
  let busy = false;
  let busySince = 0;
  // Per-file first-deferred timestamp: the BUSY_MAX_HOLD_MS override window
  // counts from when THIS delivery first deferred, never from turn start.
  // Measuring from busySince meant a wake arriving >15 min into a long turn
  // was "overridden" instantly — delivered straight into the live turn (the
  // exact drop mechanism this extension exists to prevent), archived, lost;
  // and the override cleared `busy` permanently, so every later wake in the
  // same turn was dropped too.
  const firstDeferredAt = new Map<string, number>();
  let retryTimer: NodeJS.Timeout | undefined;
  let retryDelay = RETRY_BASE_MS;

  const scheduleRetry = (): void => {
    if (closed || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
      void drain();
    }, retryDelay);
  };

  const deliver = async (file: string): Promise<void> => {
    const full = join(dir, file);
    if (closed || inFlight.has(full) || !existsSync(full)) return;
    // Busy hold with a PER-DELIVERY override window. Only after THIS file has
    // been deferred a full BUSY_MAX_HOLD_MS do we conclude the turn-boundary
    // events are not what we think they are on this pi build and deliver
    // anyway (the legacy behaviour) rather than hold wakes forever.
    let override = false;
    if (busy) {
      const nowMs = Date.now();
      const since = firstDeferredAt.get(full) ?? nowMs;
      firstDeferredAt.set(full, since);
      if (nowMs - since < BUSY_MAX_HOLD_MS) {
        scheduleRetry();
        return;
      }
      console.error(
        `[inject-bridge] ${file} held ${nowMs - since}ms against a busy session — overriding the hold and delivering`,
      );
      override = true;
    }
    inFlight.add(full);
    try {
      const content = readFileSync(full, "utf8").trim();
      if (content.length === 0) {
        // An empty wake carries nothing to lose — consume it outright.
        mkdirSync(doneDir, { recursive: true });
        renameSync(full, join(doneDir, basename(full)));
        firstDeferredAt.delete(full);
        return;
      }
      // Send FIRST, archive only after the submission resolved.
      // The old order (archive, then send) meant a send that failed — or was
      // silently dropped by a busy session — had already consumed the file,
      // so the round prompt was gone for good. The trade is deliberate: a
      // crash between send and rename re-fires the same wake on restart,
      // and a duplicated wake is benign where a dropped round is not.
      // The same trade is accepted for NON-round wakes: a replayed
      // author-reply wake double-charges the ping-pong exchange budget
      // (pingpong.ts, ≤3 exchanges) — a duplicate reply costs one budget
      // slot where a dropped round costs the whole review, so the round
      // side of the trade wins. (Reviewer's note, 2026-08-20: if replayed
      // non-round wakes ever get expensive, dedupe belongs daemon-side on
      // the wake content, never here — this extension stays drop-proof.)
      // VERIFY-ON-PIN: sendUserMessage(content) — findings §3 option 2; it
      // always triggers a turn, which is exactly the wake semantics we want.
      // VERIFY-ON-PIN: whether a resolved sendUserMessage() promise implies
      // the message was accepted into the session (vs dropped mid-turn) —
      // the busy-deferral above exists precisely because it did not on 0.84.1.
      await pi.sendUserMessage(content);
      mkdirSync(doneDir, { recursive: true });
      renameSync(full, join(doneDir, basename(full)));
      firstDeferredAt.delete(full);
      retryDelay = RETRY_BASE_MS;
      if (override) {
        // The override delivery itself starts a turn — RE-ARM the hold (do
        // not clear it): the next wake defers on its own fresh window instead
        // of being dropped into whatever this delivery started. A real settle
        // event still clears `busy` the moment one fires.
        busy = true;
        busySince = Date.now();
      }
    } catch (err) {
      // The file stays in place — retried until it lands or shutdown.
      console.error(`[inject-bridge] failed to deliver ${file}: ${String(err)}`);
      scheduleRetry();
    } finally {
      inFlight.delete(full);
    }
  };

  // The ONE serialized drain queue: every trigger (start sweep, watch event,
  // retry timer, settle) funnels through here, oldest-first. Concurrent
  // triggers coalesce into a re-run instead of interleaving deliveries —
  // per-file watch deliveries used to race the sweep and could reorder.
  let draining = false;
  let drainAgain = false;
  const drain = async (): Promise<void> => {
    if (draining) {
      drainAgain = true;
      return;
    }
    draining = true;
    try {
      do {
        drainAgain = false;
        for (const file of pendingFiles(dir)) await deliver(file);
      } while (drainAgain && !closed);
    } finally {
      draining = false;
    }
  };

  const start = (): void => {
    mkdirSync(dir, { recursive: true });
    mkdirSync(doneDir, { recursive: true });
    void drain(); // anything dropped while the session was down
    watcher = watch(dir, (_event, filename) => {
      if (!filename) {
        void drain();
        return;
      }
      // Route EVERY event through the one drain queue (never a per-file
      // deliver): concurrent watch events cannot interleave or reorder —
      // pendingFiles() sorts, so delivery is strictly oldest-first.
      const name = String(filename);
      if (name.endsWith(".md")) void drain();
    });
    console.error(`[inject-bridge] watching ${dir}`);
  };

  // VERIFY-ON-PIN: "session_start" / "session_shutdown" event names (findings §5).
  pi.on("session_start", () => start());
  pi.on("session_shutdown", () => {
    closed = true;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = undefined;
    watcher?.close();
    watcher = undefined;
  });

  // Turn boundaries. "turn_end" and "agent_settled" are documented (findings
  // §5); a matching start event is required for the busy flag to ever be set.
  // VERIFY-ON-PIN: "turn_start" event name — NOT in findings §5. If it never
  // fires on the pinned pi, busy stays false and the bridge degrades to
  // send-then-archive with retries, never to holding wakes.
  pi.on("turn_start", () => {
    busy = true;
    busySince = Date.now();
  });
  const settle = (): void => {
    busy = false;
    // The moment the session can accept a turn again is the moment deferred
    // wakes should go in — event-driven, with the retry timer as backstop.
    void drain();
  };
  pi.on("turn_end", settle);
  // VERIFY-ON-PIN: "agent_settled" semantics (findings §5) — treated as a
  // second settle signal; harmless if it duplicates turn_end.
  pi.on("agent_settled", settle);
};

export default activate;

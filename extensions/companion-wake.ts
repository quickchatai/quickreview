// companion-wake — the feed→companion wake channel (slice C2).
//
// Same shape as inject-bridge.ts (pi's shipped file-trigger example): fs.watch
// one directory, and on a marker write hand a one-line message to the model
// via pi.sendUserMessage(). The difference is cadence ownership: the TUI
// decides what "meaningful" means and writes `/feed/wake` only then,
// so this extension owns no timer of its own — only a throttle floor, so a
// burst of board activity cannot turn into a burst of turns.
//
// pi is not installed on the dev box — every pi API touch is VERIFY-ON-PIN.
import { existsSync, readFileSync, watch } from "node:fs";
import { join } from "node:path";
import type { Pi } from "@earendil-works/pi-coding-agent";

/** Minimum gap between two wakes, however often the feed changes. */
export const WAKE_THROTTLE_MS = 60_000;

export function resolveFeedDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.QCR_FEED_DIR?.trim() || "/feed";
}

/** `wake` is a JSON marker `{ts, gist}`; a torn/short read degrades to no gist
 * rather than to no wake. */
export function parseWake(text: string): { ts?: string; gist: string } {
  try {
    const p = JSON.parse(text) as { ts?: unknown; gist?: unknown };
    return { ts: typeof p.ts === "string" ? p.ts : undefined, gist: typeof p.gist === "string" ? p.gist : "" };
  } catch {
    return { gist: "" };
  }
}

/** The exact message the model receives — deliberately one line: it is a nudge
 * to read /feed/snapshot.json, not a substitute for reading it. */
export function wakeMessage(gist: string): string {
  return `feed updated: ${gist.trim() || "board changed"}`;
}

/**
 * The whole wake gate, pure and testable:
 *  - the same marker content never wakes twice (fs.watch fires repeatedly);
 *  - two wakes are never closer than WAKE_THROTTLE_MS, so a burst of board
 *    activity cannot turn into a burst of turns. The suppressed change is not
 *    lost: the next distinct marker after the window still fires, and the
 *    snapshot the model then reads is the current one.
 */
export function shouldWake(nowMs: number, lastWakeAt: number, raw: string, lastSeen: string): boolean {
  if (raw === lastSeen) return false;
  return nowMs - lastWakeAt >= WAKE_THROTTLE_MS;
}

export const activate: (pi: Pi) => void = (pi) => {
  const dir = resolveFeedDir();
  const wakeFile = join(dir, "wake");
  let watcher: ReturnType<typeof watch> | undefined;
  let lastWakeAt = 0;
  let lastSeen = "";
  let inFlight = false;

  const fire = async (nowMs: number): Promise<void> => {
    if (inFlight || !existsSync(wakeFile)) return;
    let raw: string;
    try {
      raw = readFileSync(wakeFile, "utf8");
    } catch {
      return;
    }
    if (!shouldWake(nowMs, lastWakeAt, raw, lastSeen)) return;
    lastSeen = raw;
    lastWakeAt = nowMs;
    inFlight = true;
    try {
      // VERIFY-ON-PIN: sendUserMessage(text) always triggers a turn — the wake
      // semantics we want (same assumption as inject-bridge).
      await pi.sendUserMessage(wakeMessage(parseWake(raw).gist));
    } catch (err) {
      console.error(`[companion-wake] failed to wake: ${String(err)}`);
    } finally {
      inFlight = false;
    }
  };

  const start = (): void => {
    if (!existsSync(dir)) {
      console.error(`[companion-wake] no feed dir at ${dir} — not watching`);
      return;
    }
    watcher = watch(dir, (_event, filename) => {
      if (filename && String(filename) !== "wake") return;
      void fire(Date.now());
    });
    console.error(`[companion-wake] watching ${wakeFile}`);
  };

  // VERIFY-ON-PIN: "session_start" / "session_shutdown" event names.
  pi.on("session_start", () => start());
  pi.on("session_shutdown", () => {
    watcher?.close();
    watcher = undefined;
  });
};

export default activate;

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type SessionBridgeStage = "starting" | "ready" | "failed" | "closed";

export interface SessionBridgeState {
  version: 1;
  session: string;
  generation: string;
  stage: SessionBridgeStage;
  updated_at: string;
  failed_stage?: string;
  detail?: string;
}

export function writeSessionBridgeState(path: string, state: SessionBridgeState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, path);
}

export function readSessionBridgeState(path: string): SessionBridgeState | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<SessionBridgeState>;
    if (
      parsed.version !== 1 ||
      typeof parsed.session !== "string" ||
      typeof parsed.generation !== "string" ||
      !["starting", "ready", "failed", "closed"].includes(String(parsed.stage)) ||
      typeof parsed.updated_at !== "string"
    )
      return undefined;
    return parsed as SessionBridgeState;
  } catch {
    return undefined;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A tmux process is only a container. This receipt proves the matching Pi
 * generation loaded the inject bridge and finished its synchronous startup
 * sweep. Stale generations and malformed files are deliberately invisible. */
export async function waitForSessionBridgeReady(
  path: string,
  session: string,
  generation: string,
  timeoutMs: number,
  pollMs = 25,
): Promise<SessionBridgeState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = readSessionBridgeState(path);
    if (state?.session === session && state.generation === generation) {
      if (state.stage === "ready") return state;
      if (state.stage === "failed") {
        throw new Error(
          `inject bridge ${session} generation ${generation} failed at ${state.failed_stage ?? "startup"}: ${state.detail ?? "unknown failure"}`,
        );
      }
      if (state.stage === "closed") {
        throw new Error(
          `inject bridge ${session} generation ${generation} closed before readiness`,
        );
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for inject bridge ${session} generation ${generation}`,
      );
    }
    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
}

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// The session↔daemon readiness receipt: one small JSON file per bridge
// generation, written only by the inject bridge (and `starting` by the
// session manager before birth).

export type SessionBridgeStage = "starting" | "ready" | "failed" | "closed";

/**
 * What the inject bridge knows about pi's compaction (H1b), published
 * beside its `ready` stage. A compaction holds the session's one mailbox: pi
 * refuses every prompt while one runs ("Cannot submit a prompt while
 * compaction is in progress"), so the bridge delivers nothing until it ends,
 * and the daemon's command supervisor reads `running` as a reason to extend a
 * waiting command's start lease, never as a lost delivery.
 *
 * `seq` counts the compactions this bridge generation has seen END (succeeded
 * or failed); a reader that remembers it can tell a new compaction from an
 * old one without comparing clocks.
 */
export interface SessionBridgeCompaction {
  state: "idle" | "running";
  seq: number;
  started_at?: string;
  ended_at?: string;
  /** How the last one ended: pi's summary landed, it failed or was refused
   * ("Nothing to compact"), or the bridge found pi idle without having seen
   * the end (a missed event). */
  outcome?: "compacted" | "failed" | "stale";
  /** Who started it: the daemon's round-end request, or pi itself (an
   * automatic compaction, or `/compact` typed into the pane). */
  source?: "request" | "event";
}

export interface SessionBridgeState {
  version: 1;
  session: string;
  generation: string;
  stage: SessionBridgeStage;
  updated_at: string;
  failed_stage?: string;
  detail?: string;
  /** Absent on a bridge from before H1b: compaction unknown. */
  compaction?: SessionBridgeCompaction;
}

/**
 * The daemon's round-end compaction request (H1b), written atomically
 * into the session's inject dir. The bridge — the session's one mailbox
 * consumer — runs it through pi's own `ctx.compact()` only while nothing is in
 * flight, and delivers no wake until it ends. Before H1b the daemon typed
 * `/compact` into the pane, which aborted whatever turn was running and left
 * any wake submitted during the compaction refused by pi and never retried.
 * A dot-name that is not `*.md`, so no wake reader ever takes it for a wake.
 */
export const COMPACTION_REQUEST_FILE = ".compact-request.json";

export interface CompactionRequest {
  version: 1;
  requested_at: string;
  reason: string;
}

/** The compaction block of a bridge state, validated; undefined when absent
 * or malformed (an unknown, never an idle). */
export function bridgeCompaction(
  state: SessionBridgeState | undefined,
): SessionBridgeCompaction | undefined {
  const raw = state?.compaction as Partial<SessionBridgeCompaction> | undefined;
  if (!raw || typeof raw !== "object") return undefined;
  if (raw.state !== "idle" && raw.state !== "running") return undefined;
  if (typeof raw.seq !== "number" || !Number.isInteger(raw.seq) || raw.seq < 0) return undefined;
  const iso = (v: unknown): string | undefined =>
    typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : undefined;
  const startedAt = iso(raw.started_at);
  const endedAt = iso(raw.ended_at);
  const outcome =
    raw.outcome === "compacted" || raw.outcome === "failed" || raw.outcome === "stale"
      ? raw.outcome
      : undefined;
  const source = raw.source === "request" || raw.source === "event" ? raw.source : undefined;
  return {
    state: raw.state,
    seq: raw.seq,
    ...(startedAt ? { started_at: startedAt } : {}),
    ...(endedAt ? { ended_at: endedAt } : {}),
    ...(outcome ? { outcome } : {}),
    ...(source ? { source } : {}),
  };
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

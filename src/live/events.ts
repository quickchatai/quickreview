// LiveEvent v1: the one event log a viewer reads, whatever hosts the session.
//
// A host (the one-shot engine today; a bot round worker later) appends one JSON
// line per event to
//
//   state/live/<key>/r<round>/main.jsonl          the round's main session
//   state/live/<key>/r<round>/lens-<id>.jsonl     one lens session
//
// Each line is `{v:1, seq, at, type, ...}`. `seq` counts from 1 in its own file
// and never repeats, so a reader that has seen seq N asks only for what follows
// and a gap is visible. `at` is the instant the event happened, an ISO string.
//
// The lines are SLIM: the event stream carries a whole transcript on every
// `message_update` and `tool_execution_update`, so the log keeps a coalesced
// text delta per ~250 ms window (writer.ts) and, for a lens tool call, only
// the fields round-progress reads, and only for the children that changed
// since the line before. What a line must keep to project round-progress v2
// (projection.ts) is exactly what the fields below name; everything else of a
// pi event is dropped on purpose.
//
// The reader survives a torn last line: it consumes complete (newline-ended)
// lines only, and the offset it returns points past the last one, so a tail
// poll resumes there and never sees half a line. A writer that finds a file
// whose last line is torn starts a fresh line first; the torn one is skipped.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";

export const LIVE_EVENT_VERSION = 1 as const;

/** Which session a log belongs to. */
export type LiveStreamKind = "main" | "lens";

/** One child of a lens tool call, reduced to what round-progress reads. `slot`
 * is its position in the call's `details.results`; a line carries only the
 * slots that changed since the call's previous line (`n` is the whole count). */
export interface LiveResult {
  slot: number;
  agent?: string;
  /** The lens run's identity (LensResult v1 `id`); absent on the native shape. */
  id?: string;
  /** As reported: a number on every shape pi and the engine produce. */
  exit_code?: number | string | boolean | null;
  stop_reason?: string;
  error_message?: string;
  progress?: {
    status?: string;
    duration_ms?: number;
    tool_count?: number;
    last_message?: string;
    error?: string;
    /** `{tool, args, status}` as the native extension reports them. */
    recent_tools?: Array<{ tool?: string; args?: string; status?: string }>;
  };
  /** The native shape carries no `progress`: what its transcript says. */
  native?: { tool_count: number; last_text?: string; last_tool?: string };
  /** Dollars this child has spent so far. */
  cost_usd?: number;
}

/** A task a lens tool call launches, as the host resolved it at call start. */
export interface LiveExecution {
  agent: string;
  phase?: "plan" | "sweep" | "optional";
}

export interface LiveUsage {
  input: number;
  output: number;
  cache_read: number;
  cost_usd: number;
}

/** What happens on a line, by `type`. */
export type LiveBody =
  | {
      type: "session_start";
      stream: LiveStreamKind;
      /** The state key (`pr-<n>` on the bot, the review's name on a one-shot). */
      key: string;
      round: number;
      /** The PR number round-progress is published for; null when there is none. */
      pr: number | null;
      session: string;
      /** The lens run id, on a lens stream. */
      lens_id?: string;
      agent?: string;
    }
  | { type: "agent_start" }
  | { type: "agent_end"; will_retry?: boolean }
  | { type: "agent_settled"; aborted: boolean }
  | { type: "turn_start" }
  | { type: "turn_end" }
  /** `text` is the joined text of a USER message (the round order carries the
   * command marker); absent for every other role. */
  | { type: "message_start"; role: string; text?: string }
  /** Streamed text since the previous line, coalesced to ~250 ms. */
  | { type: "message_delta"; text?: string; thinking?: string }
  | {
      type: "message_end";
      role: string;
      text?: string;
      tool_calls?: string[];
      stop_reason?: string;
      error?: string;
      usage?: LiveUsage;
    }
  | {
      type: "tool_start";
      id: string;
      tool: string;
      /** The tool call this one was made through (`ctx.executeTool`). */
      parent?: string;
      /** A lens tool keeps its arguments; any other tool a one-line preview. */
      args?: Record<string, unknown>;
      preview?: string;
      /** What a lens tool call launches, resolved by the host at call start. */
      executions?: LiveExecution[];
    }
  | {
      type: "tool_update";
      id: string;
      tool: string;
      parent?: string;
      mode?: string;
      /** Children in the whole call; `results` holds the ones that changed. */
      n: number;
      results: LiveResult[];
    }
  | {
      type: "tool_end";
      id: string;
      tool: string;
      parent?: string;
      is_error: boolean;
      duration_ms?: number;
      n: number;
      results: LiveResult[];
      /** Dollars the call's children spent, summed. */
      cost_usd?: number;
    }
  | { type: "queue_update"; steering: string[]; follow_up: string[] }
  | { type: "compaction_start"; reason: string }
  | {
      type: "compaction_end";
      reason: string;
      aborted: boolean;
      will_retry: boolean;
      error?: string;
    }
  | { type: "retry"; phase: "start" | "end"; attempt: number; error?: string; success?: boolean };

export type LiveEvent = { v: 1; seq: number; at: string } & LiveBody;

/** A line with no seq or instant yet: what a sink hands the file writer. */
export type LiveDraft = LiveBody & { at: string };

// ---- paths -----------------------------------------------------------------------

/** `<root>/state/live/<key>/r<round>`: the directory one round's logs live in.
 * `root` is the install's (or a run's) state-bearing directory. */
export function liveRoundDir(root: string, key: string, round: number): string {
  return join(root, "state", "live", key, `r${round}`);
}

export const LIVE_MAIN_FILE = "main.jsonl";

/** `lens-<id>.jsonl`. The id is a path component: anything but a plain token is
 * refused rather than escaped. */
export function lensLogName(id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new Error(`not a lens log id: ${id}`);
  return `lens-${id}.jsonl`;
}

// ---- reading ---------------------------------------------------------------------

export interface LiveRead {
  events: LiveEvent[];
  /** Byte offset just past the last complete line read: pass it back as
   * `fromOffset` to read only what has been appended since. */
  nextOffset: number;
  /** Complete lines that were not events (garbage, or a torn line a writer
   * later closed off). */
  skipped: number;
}

function isEvent(value: unknown): value is LiveEvent {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const e = value as Record<string, unknown>;
  return (
    e.v === LIVE_EVENT_VERSION &&
    typeof e.seq === "number" &&
    Number.isInteger(e.seq) &&
    e.seq >= 1 &&
    typeof e.at === "string" &&
    Number.isFinite(Date.parse(e.at)) &&
    typeof e.type === "string"
  );
}

/** Parse the complete lines of `text`; the bytes of a trailing partial line are
 * not counted in `consumed`. */
function parseLines(text: Buffer): { events: LiveEvent[]; consumed: number; skipped: number } {
  const end = text.lastIndexOf(0x0a);
  if (end < 0) return { events: [], consumed: 0, skipped: 0 };
  const events: LiveEvent[] = [];
  let skipped = 0;
  for (const line of text.subarray(0, end).toString("utf8").split("\n")) {
    if (line === "") continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isEvent(value)) events.push(value);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  return { events, consumed: end + 1, skipped };
}

/** Read the events appended to `path` from byte `fromOffset` on. A missing file
 * is an empty read. A last line without its newline is a write in progress (or
 * a torn one): it is left for the next read. */
export function readLiveEvents(path: string, fromOffset = 0): LiveRead {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT")
      return { events: [], nextOffset: fromOffset, skipped: 0 };
    throw err;
  }
  try {
    const size = fstatSync(fd).size;
    if (size <= fromOffset)
      return { events: [], nextOffset: Math.min(fromOffset, size), skipped: 0 };
    const buf = Buffer.alloc(size - fromOffset);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, fromOffset + got);
      if (n === 0) break;
      got += n;
    }
    const { events, consumed, skipped } = parseLines(buf.subarray(0, got));
    return { events, nextOffset: fromOffset + consumed, skipped };
  } finally {
    closeSync(fd);
  }
}

/** Where a file left off: the last good seq, and whether its last line is torn
 * (non-empty and not newline-ended), so a writer can resume it. */
export function resumePoint(path: string): { lastSeq: number; torn: boolean } {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { lastSeq: 0, torn: false };
    throw err;
  }
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return { lastSeq: 0, torn: false };
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    const torn = last[0] !== 0x0a;
    const { events } = readLiveEvents(path);
    return { lastSeq: events.at(-1)?.seq ?? 0, torn };
  } finally {
    closeSync(fd);
  }
}

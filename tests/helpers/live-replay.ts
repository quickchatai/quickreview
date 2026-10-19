// Replays a recorded pi session through the two publishers of round-progress,
// so a test can hold them byte-equal: extensions/round-progress.ts (the
// reference, fed pi's events through a fake `pi.on`) and the LiveEvent writer
// plus the projection (src/live/).
//
// A pi session JSONL is the on-disk record of a run: user and assistant messages
// with their tool calls, the tool results, the timestamps. It holds no
// `*_update` events, so a replay is a start and an end per tool call; tests that
// need updates build their events by hand with `timed`.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import activate from "../../extensions/round-progress.js";
import { roundLiveWriter } from "../../src/engine/livewire.js";
import { liveRoundDir, LIVE_MAIN_FILE, readLiveEvents } from "../../src/live/events.js";
import { projectRoundProgress, type RoundProgressProjection } from "../../src/live/projection.js";

export interface TimedEvent {
  /** Epoch ms of the event. */
  at: number;
  event: Record<string, unknown>;
}

type Row = { type?: string; timestamp?: string; message?: Record<string, unknown> };

/** pi's events for a recorded session: an agent_start at its header, a
 * message_start per user message, a message_end per assistant message followed
 * by a tool_execution_start per tool call, a tool_execution_end per tool
 * result, and an agent_settled a second after the last row. `{ROOT}` in the
 * file names the run's root. */
export function eventsFromSession(jsonl: string, root: string): TimedEvent[] {
  const rows = jsonl
    .replaceAll("{ROOT}", root)
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Row);
  const out: TimedEvent[] = [];
  const stamp = (row: Row): number => Date.parse(row.timestamp ?? "");
  let last = stamp(rows[0]!);
  out.push({ at: last, event: { type: "agent_start" } });
  for (const row of rows) {
    const at = stamp(row);
    if (!Number.isFinite(at)) continue;
    last = at;
    const m = row.message;
    if (row.type !== "message" || m === undefined) continue;
    if (m.role === "user") out.push({ at, event: { type: "message_start", message: m } });
    else if (m.role === "assistant") {
      out.push({ at, event: { type: "message_end", message: m } });
      for (const part of (m.content as Array<Record<string, unknown>>) ?? [])
        if (part.type === "toolCall")
          out.push({
            at,
            event: {
              type: "tool_execution_start",
              toolCallId: part.id,
              toolName: part.name,
              args: part.arguments,
            },
          });
    } else if (m.role === "toolResult")
      out.push({
        at,
        event: {
          type: "tool_execution_end",
          toolCallId: m.toolCallId,
          toolName: m.toolName,
          result: { content: m.content, details: m.details },
          isError: m.isError === true,
        },
      });
  }
  out.push({ at: last + 1000, event: { type: "agent_settled", aborted: false } });
  return out;
}

export interface Replayed {
  /** `state/round-progress/pr-<n>.json` as the extension left it. */
  extensionSnapshot: string;
  /** `state/round-progress/pr-<n>.jsonl`. */
  extensionTransitions: string;
  projection: RoundProgressProjection | undefined;
  /** The LiveEvent main log the writer wrote. */
  logPath: string;
  root: string;
  cleanup: () => void;
}

/** Make the root a replay runs against: the plan's task files exist, so a
 * `launch_plan` call resolves to its three passes. */
export function mkReplayRoot(pr: number): string {
  const root = mkdtempSync(join(tmpdir(), "live-replay-"));
  const tasks = join(root, "state", `pr-${pr}-round-1-passes`, "tasks");
  mkdirSync(tasks, { recursive: true });
  for (const f of [
    "01-pass-baseline--sol-high.md",
    "02-pass-security--sol-high.md",
    "03-pass-data-safety--sol-high.md",
  ])
    writeFileSync(join(tasks, f), "task");
  return root;
}

/** Feed `events` to the extension and to the LiveEvent writer under one fake
 * clock, then read both outputs back. The writer's log is read from the file
 * and projected, so the whole path (slim, write, read, project) is the one a
 * viewer takes. */
export function replay(opts: { root: string; pr: number; events: TimedEvent[] }): Replayed {
  const { root, pr, events } = opts;
  const session = `pr-${pr}`;
  const previous = { ...process.env };
  process.env.QCR_SANDBOX_ROOT = root;
  process.env.QCR_SESSION_NAME = session;
  process.env.QCR_PR = String(pr);
  const handlers = new Map<string, Array<(event: Record<string, unknown>) => unknown>>();
  const pi = {
    on(name: string, handler: (event: Record<string, unknown>) => unknown) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
  };
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  try {
    vi.setSystemTime(events[0]!.at);
    activate(pi as never);
    const live = { root, key: session, round: 1 };
    const sink = roundLiveWriter(live, { ...process.env }).main({
      key: live.key,
      round: live.round,
      pr,
      session,
    });
    for (const { at, event } of events) {
      const wait = at - Date.now();
      if (wait > 0) vi.advanceTimersByTime(wait);
      for (const handler of handlers.get(String(event.type)) ?? []) void handler(event);
      sink.feed(event);
    }
    vi.advanceTimersByTime(1_000);
    sink.close();
  } finally {
    vi.useRealTimers();
    process.env = previous;
  }
  const logPath = join(liveRoundDir(root, session, 1), LIVE_MAIN_FILE);
  const progress = join(root, "state", "round-progress");
  return {
    extensionSnapshot: readFileSync(join(progress, `${session}.json`), "utf8"),
    extensionTransitions: readFileSync(join(progress, `${session}.jsonl`), "utf8"),
    projection: projectRoundProgress(readLiveEvents(logPath).events),
    logPath,
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

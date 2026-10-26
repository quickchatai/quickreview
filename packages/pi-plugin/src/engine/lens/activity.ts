// What a lens pass is doing while it runs: its tool calls as they start and
// end, counted, with the current tool and the file it is on.
//
// The runner (runlens.ts) feeds a tracker every event of the pass's session and
// hands each change to the request's `onActivity`; the lens tools (tool.ts) lay
// it on the still-running slot of their progress updates in the native
// subagent tool's `progress` shape, so the main session's LiveEvent log carries
// it (live/writer.ts slimResult) and the round-progress projection reads it
// (live/projection.ts) while the lens runs, not only when it ends.
import { isAbsolute, relative } from "node:path";
import type { LiveAgentStatus } from "../../round-progress.js";
import { argPreview } from "../../live/writer.js";

export interface LensActivity {
  /** Milliseconds the pass has run, as of the last change (or its end). */
  durationMs: number;
  /** Tool calls started so far. */
  toolCount: number;
  /** The tool running now, or the last one that ran. */
  tool?: string;
  /** Its arguments as one line: the command, path, query, pattern or url. */
  args?: string;
  /** The path it works on (a read's, grep's or find's `path`), relative to the
   * pass's cwd when it lies inside it. */
  target?: string;
  /** `tool` is still running. */
  toolRunning: boolean;
}

type Bag = Record<string, unknown>;

function record(value: unknown): Bag | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Bag)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** The path a tool call works on, when it names one. */
export function toolTarget(args: Bag, cwd?: string): string | undefined {
  const raw = text(args["path"]) ?? text(args["file_path"]);
  if (raw === undefined) return undefined;
  if (cwd === undefined || !isAbsolute(raw)) return raw;
  const rel = relative(cwd, raw);
  if (rel === "") return ".";
  return rel.startsWith("..") || isAbsolute(rel) ? raw : rel;
}

interface Call {
  tool: string;
  args?: string;
  target?: string;
}

/** One pass's activity, from its session's events. */
export class LensActivityTracker {
  private count = 0;
  /** Calls started and not yet ended, in start order. */
  private readonly open = new Map<string, Call>();
  private last: Call | undefined;

  constructor(
    private readonly startedAtMs: number,
    private readonly now: () => number,
    private readonly cwd?: string,
  ) {}

  /** Hear one session event; true when the activity changed. */
  feed(event: unknown): boolean {
    const e = record(event);
    if (e === undefined) return false;
    const id = text(e["toolCallId"]) ?? text(e["id"]);
    if (e["type"] === "tool_execution_start") {
      const tool = text(e["toolName"]) ?? text(e["name"]) ?? "tool";
      const args = record(e["args"]) ?? record(e["input"]) ?? record(e["arguments"]) ?? {};
      const preview = argPreview(args);
      const target = toolTarget(args, this.cwd);
      const call: Call = {
        tool,
        ...(preview !== undefined ? { args: preview } : {}),
        ...(target !== undefined ? { target } : {}),
      };
      this.count += 1;
      this.open.set(id ?? `${tool}#${this.count}`, call);
      this.last = call;
      return true;
    }
    if (e["type"] === "tool_execution_end") {
      if (id !== undefined && this.open.delete(id)) return true;
      return false;
    }
    return false;
  }

  /** Every call of an attempt that ended is over: a retried pass starts clean. */
  settle(): void {
    this.open.clear();
  }

  /** The activity now. */
  view(): LensActivity {
    const running = [...this.open.values()].at(-1);
    const current = running ?? this.last;
    return {
      durationMs: Math.max(0, this.now() - this.startedAtMs),
      toolCount: this.count,
      ...(current !== undefined ? { tool: current.tool } : {}),
      ...(current?.args !== undefined ? { args: current.args } : {}),
      ...(current?.target !== undefined ? { target: current.target } : {}),
      toolRunning: running !== undefined,
    };
  }
}

/**
 * A lens slot's `progress` record, in the native subagent tool's shape (what
 * round-progress has always read off a child): its status, duration and tool
 * count, and while it runs the current tool (`recentTools`) and the path it is
 * on (`currentTarget`). A finished pass carries its totals only.
 */
export function lensProgressRecord(activity: LensActivity, status: LiveAgentStatus): Bag {
  const running = status === "running";
  return {
    status,
    durationMs: activity.durationMs,
    toolCount: activity.toolCount,
    ...(running && activity.target !== undefined ? { currentTarget: activity.target } : {}),
    ...(running && activity.tool !== undefined
      ? {
          recentTools: [
            {
              tool: activity.tool,
              ...(activity.args !== undefined ? { args: activity.args } : {}),
              status: activity.toolRunning ? "running" : "done",
            },
          ],
        }
      : {}),
  };
}

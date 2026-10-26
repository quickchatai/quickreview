// One lens's live entry (round-progress v2, projection.ts) as a short line a
// person reads while the review runs:
//
//   security · read src/x.ts · 7 tools · 0:41
//   tests · done · 12 tools · 1:20
//   data-safety · failed · 3 tools · 0:15
//
// Pure: the plugin's status line and the app's home both print it. A field the
// entry does not carry is left out, never shown as a zero: a lens that has made
// no tool call yet says "starting", and a duration nobody measured is absent.
import { lensForAgent, type LiveAgentProgress } from "../round-progress.js";

/** The lens's short name: `pass-security--sol-high` is `security`. */
export function lensShortName(agent: string): string {
  const lens = lensForAgent(agent);
  return lens.startsWith("pass-") && lens.length > 5 ? lens.slice(5) : lens;
}

/** `m:ss` (and `h:mm:ss` past an hour). */
export function clockOf(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** A long path keeps its end, where the file name is. */
function shortPath(path: string, max: number): string {
  return path.length <= max ? path : `…${path.slice(path.length - (max - 1))}`;
}

/** How long the lens has run: its measured duration, or, while it runs and a
 * clock is given, at least the time since its start. Undefined when neither is
 * known. */
export function lensElapsedMs(entry: LiveAgentProgress, nowMs?: number): number | undefined {
  const measured = entry.duration_ms > 0 ? entry.duration_ms : undefined;
  if (entry.status !== "running" || nowMs === undefined || entry.started_at === undefined)
    return measured;
  const started = Date.parse(entry.started_at);
  if (!Number.isFinite(started)) return measured;
  return Math.max(measured ?? 0, nowMs - started);
}

export interface LensLineOptions {
  /** Now, in ms: a running lens's time keeps counting between its updates. */
  nowMs?: number;
  /** The longest path shown; a longer one keeps its end. Default 48. */
  maxPath?: number;
}

/** What the lens is doing: its tool and the path it is on, or its outcome. */
function doing(entry: LiveAgentProgress, maxPath: number): string {
  if (entry.status === "completed") return "done";
  if (entry.status === "failed") return "failed";
  const raw = entry.current_tool;
  if (raw === undefined) return "starting";
  const colon = raw.indexOf(": ");
  const tool = colon > 0 ? raw.slice(0, colon) : raw;
  return entry.current_target !== undefined
    ? `${tool} ${shortPath(entry.current_target, maxPath)}`
    : tool;
}

/** One lens's live entry as a line: name · doing · tools · time. */
export function lensActivityLine(entry: LiveAgentProgress, options: LensLineOptions = {}): string {
  const parts = [lensShortName(entry.agent), doing(entry, options.maxPath ?? 48)];
  if (entry.tool_count > 0 || entry.status !== "running")
    parts.push(`${entry.tool_count} tool${entry.tool_count === 1 ? "" : "s"}`);
  const elapsed = lensElapsedMs(entry, options.nowMs);
  if (elapsed !== undefined) parts.push(clockOf(elapsed));
  return parts.join(" · ");
}

/** The lines of the lenses running now, in the snapshot's order. */
export function runningLensLines(
  agents: readonly LiveAgentProgress[],
  options: LensLineOptions = {},
): string[] {
  return agents.filter((a) => a.status === "running").map((a) => lensActivityLine(a, options));
}

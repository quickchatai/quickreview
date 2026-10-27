// The round-progress v2 projection of a LiveEvent log.
//
// extensions/round-progress.ts publishes `state/round-progress/pr-<n>.json`
// (and the append-only transition log beside it) from inside the tmux pi, by
// listening to pi's events. This module reproduces both from the LiveEvent log
// alone, so the engine routes - which have no such extension - and a viewer
// reading a finished or running round all get the same snapshot, with the
// contract in packages/pi-plugin/src/round-progress.ts unchanged: board.ts, requiredpasses.ts and
// the supervisor read it as they always have.
//
// The extension is the REFERENCE. Every rule here mirrors the handler it
// stands for, line by line, because the golden test
// (tests/live-projection-golden.test.ts) holds the two byte-equal on the same
// events. The one place the log is coarser than pi's stream is time: a held
// update is stamped at its window's flush (~250 ms), so a heartbeat or a
// `started_at` taken from an update can differ from the extension's by that
// much. Nothing the supervisor decides on (the milestones' order, statuses,
// command identity) depends on it.
//
// One field goes past the extension: `current_target`, the path a running
// lens's current tool works on, which only our lens tools report (their
// `progress.currentTarget`, engine/lens/activity.ts). A native round carries
// none, so its projection is the extension's to the byte.
//
// It lives in the core so the plugin can read a running review's lenses
// (its status line) the way `qcr review status` and the bot's publisher do.
import { parseSessionCommandMarker } from "../session-command.js";
import {
  isLiveAgentStatus,
  type LiveAgentProgress,
  type LiveAgentStatus,
  type PassExecutionPhase,
  type ProgressLogLine,
  type ProgressTransition,
  type RoundProgressSnapshot,
} from "../round-progress.js";
import type { LiveEvent, LiveResult } from "./events.js";

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function status(value: unknown, exitCode?: unknown): LiveAgentStatus {
  if (isLiveAgentStatus(value)) return value;
  return exitCode === 0 ? "completed" : exitCode === undefined ? "running" : "failed";
}

/** The round number rides the order's posting calls (`QCR_ROUND_NO=<k>`, with
 * or without `export`); the head rides the Worktree line. */
function reviewIdentity(body: string): { round_no: number; head_sha: string } | undefined {
  const round = /(?:^|\s)(?:export )?QCR_ROUND_NO=(\d+)(?=\s|$)/.exec(body);
  const head = /\*\*Worktree\*\*:[^\n]* @ `([^`]+)`/.exec(body);
  if (!round || !head) return undefined;
  const roundNo = Number(round[1]);
  return Number.isInteger(roundNo) && roundNo > 0
    ? { round_no: roundNo, head_sha: head[1]! }
    : undefined;
}

function currentTool(progress: LiveResult["progress"]): string | undefined {
  if (!Array.isArray(progress?.recent_tools)) return undefined;
  const tools = progress.recent_tools;
  const picked = [...tools].reverse().find((x) => x.status === "running") ?? tools.at(-1);
  if (!picked) return undefined;
  const name = text(picked.tool) ?? "tool";
  const args = text(picked.args);
  return args ? `${name}: ${args.slice(0, 120)}` : name;
}

function asAgent(
  result: LiveResult,
  fallbackAgent?: string,
  live = false,
): LiveAgentProgress | undefined {
  const agent = text(result.agent) ?? fallbackAgent;
  if (!agent) return undefined;
  const progress = result.progress;
  const native = result.native ?? { tool_count: 0 };
  const error = text(progress?.error) ?? text(result.error_message);
  const exit = result.exit_code;
  const nativeFailed =
    (typeof exit === "number" && exit > 0) ||
    result.stop_reason === "error" ||
    result.stop_reason === "aborted";
  const st: LiveAgentStatus = isLiveAgentStatus(progress?.status)
    ? progress.status
    : nativeFailed
      ? "failed"
      : live || exit === -1 || exit === undefined
        ? "running"
        : status(undefined, exit);
  const tool = currentTool(progress) ?? (live ? native.last_tool : undefined);
  // Our lens tools name the path a running child is on; the native shape never
  // did, so a recorded native round projects exactly as before.
  const target = st === "running" ? text(progress?.current_target) : undefined;
  const last = text(progress?.last_message) ?? native.last_text;
  return {
    agent,
    status: st,
    duration_ms: number(progress?.duration_ms),
    tool_count: number(progress?.tool_count) || native.tool_count,
    ...(tool ? { current_tool: tool } : {}),
    ...(target ? { current_target: target } : {}),
    ...(last ? { last_message: last } : {}),
    ...(error ? { error } : {}),
  };
}

export interface ProjectionIdentity {
  pr: number;
  session: string;
}

export class RoundProgressProjection {
  private snapshotState: RoundProgressSnapshot | undefined;
  private written: string | undefined;
  private readonly log: ProgressLogLine[] = [];
  private lastHeartbeat = 0;
  private clock = "";
  private readonly agents = new Map<string, LiveAgentProgress>();
  private readonly callAgents = new Map<string, string[]>();
  private readonly runKeys = new Map<string, string>();
  private readonly endLogged = new Set<string>();
  /** The children of each open lens call, rebuilt from the changed slots. */
  private readonly calls = new Map<string, LiveResult[]>();

  constructor(private readonly who: ProjectionIdentity) {}

  /** The snapshot as its file would hold it now (the last write). */
  get snapshot(): RoundProgressSnapshot | undefined {
    return this.written === undefined
      ? undefined
      : (JSON.parse(this.written) as RoundProgressSnapshot);
  }

  /** The bytes of `pr-<n>.json`. */
  get snapshotJson(): string | undefined {
    return this.written;
  }

  /** The transition lines, in order. */
  get transitions(): readonly ProgressLogLine[] {
    return this.log;
  }

  /** The bytes of `pr-<n>.jsonl` (before its size-cap rotation). */
  get transitionsJsonl(): string {
    return this.log.map((l) => `${JSON.stringify(l)}\n`).join("");
  }

  apply(event: LiveEvent): void {
    this.clock = event.at;
    switch (event.type) {
      case "agent_start":
        return this.agentStart();
      case "message_start":
        return this.messageStart(event.role, event.text);
      case "turn_start":
      case "message_delta":
        return this.heartbeat();
      case "tool_start":
        return this.toolStart(event);
      case "tool_update":
        return this.toolUpdate(event);
      case "tool_end":
        return this.toolEnd(event);
      case "agent_settled":
        return this.settled();
      default:
        return;
    }
  }

  // ---- the extension's helpers --------------------------------------------------

  private nowIso(): string {
    return this.clock;
  }

  private bindRun(run: string | null, key: string): string {
    if (run === null) return key;
    const held = this.runKeys.get(run);
    if (held !== undefined) return held;
    this.runKeys.set(run, key);
    return key;
  }

  private executionKeys(callId: string, names: readonly string[]): string[] {
    const seen = new Map<string, number>();
    return names.map((agent) => {
      const n = (seen.get(agent) ?? 0) + 1;
      seen.set(agent, n);
      return n === 1 ? `${callId}:${agent}` : `${callId}:${agent}#${n}`;
    });
  }

  private write(): void {
    const snapshot = this.snapshotState;
    if (!snapshot) return;
    snapshot.updated_at = this.nowIso();
    snapshot.agents = [...this.agents.values()];
    this.written = `${JSON.stringify(snapshot)}\n`;
  }

  private transition(entry: ProgressTransition): void {
    const snapshot = this.snapshotState;
    if (!snapshot) return;
    this.log.push({
      at: this.nowIso(),
      pr: this.who.pr,
      session: this.who.session,
      run_started_at: snapshot.run_started_at,
      ...(snapshot.command_id ? { command_id: snapshot.command_id } : {}),
      ...entry,
    });
  }

  private passEnded(agent: LiveAgentProgress): void {
    const key = agent.execution_id;
    if (!key || agent.status === "running" || this.endLogged.has(key)) return;
    this.endLogged.add(key);
    this.transition({
      event: "pass_end",
      execution_id: key,
      agent: agent.agent,
      status: agent.status,
    });
  }

  private fanoutSeen(): void {
    const snapshot = this.snapshotState;
    if (!snapshot || this.agents.size === 0) return;
    snapshot.first_lens_started_at ??= this.nowIso();
    snapshot.fanout_started_at ??= snapshot.first_lens_started_at;
  }

  private activity(description: string): void {
    const snapshot = this.snapshotState;
    if (!snapshot) return;
    snapshot.last_activity = description;
    snapshot.last_activity_at = this.nowIso();
    this.write();
  }

  private heartbeat(): void {
    if (!this.snapshotState) return;
    const now = Date.parse(this.clock);
    if (now - this.lastHeartbeat < 1_000) return;
    this.lastHeartbeat = now;
    this.write();
  }

  private freshSnapshot(lastActivity: string): RoundProgressSnapshot {
    const at = this.nowIso();
    this.agents.clear();
    this.callAgents.clear();
    this.runKeys.clear();
    this.endLogged.clear();
    return {
      version: 2,
      pr: this.who.pr,
      session: this.who.session,
      run_started_at: at,
      updated_at: at,
      parent_status: "active",
      last_activity_at: at,
      last_activity: lastActivity,
      agents: [],
    };
  }

  /** The children of a call after this line: the slots it carries laid over
   * what the call's earlier lines left. */
  private merge(id: string, n: number, changed: readonly LiveResult[]): LiveResult[] {
    const held = this.calls.get(id) ?? [];
    for (const r of changed) held[r.slot] = r;
    const full = Array.from({ length: n }, (_, slot) => held[slot] ?? { slot });
    this.calls.set(id, full);
    return full;
  }

  // ---- the handlers ---------------------------------------------------------------

  private agentStart(): void {
    // pi's automatic retry or queued continuation emits another agent_start
    // inside the SAME outer run: an inner start keeps the run's command,
    // milestones and passes.
    if (this.snapshotState && this.snapshotState.parent_status === "active") {
      this.activity("parent run continued");
      return;
    }
    this.snapshotState = this.freshSnapshot("parent run started");
    this.write();
    this.transition({ event: "parent_start" });
  }

  private messageStart(role: string, body: string | undefined): void {
    const snapshot = this.snapshotState;
    if (!snapshot || role !== "user" || !body) return;
    const marker = parseSessionCommandMarker(body);
    if (!marker) return;
    // A different command in a run that has one already is a new execution.
    let current = snapshot;
    if (current.command_id !== undefined && current.command_id !== marker.id) {
      current = this.freshSnapshot("parent run started");
      this.snapshotState = current;
    }
    current.command_id = marker.id;
    current.command_sha256 = marker.payloadSha256;
    const identity = reviewIdentity(body);
    if (identity) {
      current.round_no = identity.round_no;
      current.head_sha = identity.head_sha;
    }
    const firstAcceptance = current.command_accepted_at === undefined;
    current.command_accepted_at ??= this.nowIso();
    current.preparing_at ??= current.command_accepted_at;
    if (firstAcceptance)
      this.transition({
        event: "command_accepted",
        ...(current.round_no !== undefined ? { round_no: current.round_no } : {}),
        ...(current.head_sha !== undefined ? { head_sha: current.head_sha } : {}),
      });
    this.activity(`command ${marker.id} accepted; parent preparing compact fanout context`);
  }

  private toolStart(ev: Extract<LiveEvent, { type: "tool_start" }>): void {
    const snapshot = this.snapshotState;
    if (!snapshot) return;
    const executions = ev.executions ?? [];
    if (executions.length > 0) {
      const names = executions.map(({ agent }) => agent);
      const at = this.nowIso();
      this.callAgents.set(ev.id, names);
      const keys = this.executionKeys(ev.id, names);
      for (const [index, agent] of names.entries()) {
        const key = keys[index]!;
        const phase: PassExecutionPhase | undefined = executions[index]?.phase;
        this.agents.set(key, {
          execution_id: key,
          agent,
          ...(phase ? { phase } : {}),
          status: "running",
          duration_ms: 0,
          tool_count: 0,
          started_at: at,
        });
        this.transition({ event: "pass_start", execution_id: key, agent });
      }
      snapshot.first_lens_started_at ??= at;
      snapshot.fanout_started_at ??= snapshot.first_lens_started_at;
      snapshot.active_tool = `subagent: ${names.join(", ")}`;
      this.activity(`${names.join(", ")} started`);
      return;
    }
    snapshot.active_tool = ev.preview ? `${ev.tool}: ${ev.preview}` : ev.tool;
    this.activity(snapshot.active_tool);
  }

  private toolUpdate(ev: Extract<LiveEvent, { type: "tool_update" }>): void {
    const snapshot = this.snapshotState;
    if (!snapshot) return;
    const fallbacks = this.callAgents.get(ev.id) ?? [];
    const reported = this.merge(ev.id, ev.n, ev.results);
    // Native parallel mode marks a still-running slot with exitCode -1 and a
    // finished one with its real exit code.
    let changed = false;
    const updated = reported.flatMap((result, index) => {
      const agent = asAgent(
        result,
        fallbacks[index] ?? (fallbacks.length === 1 ? fallbacks[0] : undefined),
        ev.mode === "parallel" ? result.exit_code === -1 : true,
      );
      return agent ? [{ agent, run: result.id ?? null }] : [];
    });
    const updateKeys = this.executionKeys(
      ev.id,
      updated.map(({ agent }) => agent.agent),
    );
    for (const [index, { agent, run }] of updated.entries()) {
      const key = this.bindRun(run, updateKeys[index]!);
      const previous = this.agents.get(key);
      // A parallel slot can finish while its siblings still run: a terminal
      // record carries its completion milestone from the first update that
      // reports it, and a running one never carries one. The path a child is
      // on is its latest line's alone: a tool with no path, or an end, has none.
      const { finished_at: previousFinished, current_target, ...kept } = previous ?? {};
      const next: LiveAgentProgress = {
        ...kept,
        ...agent,
        execution_id: key,
        started_at: previous?.started_at ?? this.nowIso(),
        ...(agent.status === "running" ? {} : { finished_at: previousFinished ?? this.nowIso() }),
      };
      this.agents.set(key, next);
      this.passEnded(next);
      snapshot.active_tool = `subagent: ${agent.agent}`;
      changed = true;
    }
    this.fanoutSeen();
    if (changed) this.write();
    else this.heartbeat();
  }

  private toolEnd(ev: Extract<LiveEvent, { type: "tool_end" }>): void {
    const snapshot = this.snapshotState;
    if (!snapshot) return;
    const id = ev.id;
    const fallbacks = this.callAgents.get(id) ?? [];
    const reported = this.merge(id, ev.n, ev.results);
    this.calls.delete(id);
    const finalAgents: LiveAgentProgress[] = [];
    const ended = reported.flatMap((result, index) => {
      const agent = asAgent(
        result,
        fallbacks[index] ?? (fallbacks.length === 1 ? fallbacks[0] : undefined),
      );
      return agent ? [{ agent, run: result.id ?? null }] : [];
    });
    const endKeys = this.executionKeys(
      id,
      ended.map(({ agent }) => agent.agent),
    );
    for (const [index, { agent, run }] of ended.entries()) {
      const key = this.bindRun(run, endKeys[index]!);
      const previous = this.agents.get(key);
      // A child the call returns still running (a placeholder) carries no
      // finish time, as in toolUpdate: the parser refuses the pair.
      const { finished_at: previousFinished, current_target, ...kept } = previous ?? {};
      const finalAgent: LiveAgentProgress = {
        ...kept,
        ...agent,
        execution_id: key,
        started_at: previous?.started_at ?? this.nowIso(),
        ...(agent.status === "running" ? {} : { finished_at: previousFinished ?? this.nowIso() }),
      };
      this.agents.set(key, finalAgent);
      finalAgents.push(finalAgent);
      this.passEnded(finalAgent);
    }
    if (finalAgents.length === 0 && fallbacks.length > 0) {
      const failed = ev.is_error;
      const fallbackKeys = this.executionKeys(id, fallbacks);
      for (const [index, fallback] of fallbacks.entries()) {
        const key = fallbackKeys[index]!;
        const previous = this.agents.get(key);
        if (previous && previous.status !== "running") {
          finalAgents.push(previous);
          continue;
        }
        const finalAgent: LiveAgentProgress = {
          ...(previous ?? {
            execution_id: key,
            agent: fallback,
            duration_ms: 0,
            tool_count: 0,
            started_at: this.nowIso(),
          }),
          status: failed ? "failed" : "completed",
          finished_at: previous?.finished_at ?? this.nowIso(),
        };
        // An ended pass is on no file.
        delete finalAgent.current_target;
        this.agents.set(key, finalAgent);
        finalAgents.push(finalAgent);
        this.passEnded(finalAgent);
      }
    }
    this.fanoutSeen();
    this.callAgents.delete(id);
    snapshot.active_tool = undefined;
    this.activity(
      finalAgents.length > 0
        ? `${finalAgents.map((agent) => `${agent.agent} ${agent.status}`).join(", ")}`
        : `${ev.tool} ${ev.is_error ? "failed" : "completed"}`,
    );
  }

  private settled(): void {
    const snapshot = this.snapshotState;
    if (!snapshot) return;
    snapshot.parent_status = "settled";
    snapshot.active_tool = undefined;
    this.activity("parent session settled");
    this.transition({ event: "parent_settle" });
  }
}

/** Project a main log. The identity (PR, session) comes from its
 * `session_start` line; a log with none, or for a round that has no PR number,
 * projects to nothing - as the extension does nothing outside a numbered PR
 * session. */
export function projectRoundProgress(
  events: readonly LiveEvent[],
): RoundProgressProjection | undefined {
  const start = events.find((e) => e.type === "session_start");
  if (start?.type !== "session_start" || start.stream !== "main" || start.pr === null)
    return undefined;
  const projection = new RoundProgressProjection({ pr: start.pr, session: start.session });
  for (const e of events) projection.apply(e);
  return projection;
}

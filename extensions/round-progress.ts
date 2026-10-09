// Live round-progress sidecar for the operator TUI.
//
// SQLite knows which lenses were planned and when the round must finish, but
// only pi sees the transient lifecycle of the subagents it is running. This
// extension observes pi's documented tool-execution events and atomically
// publishes that ephemeral state under state/round-progress/. It never drives
// a session and never writes daemon state.
//
// VERIFY-ON-PIN (probed at 0.84.1; result shapes re-read statically against
// the 0.84.4 tarball): tool_execution_start/update/end payload
// keys are probed defensively because the local build intentionally carries
// only ambient extension types; an unfamiliar payload degrades to parent
// activity, never to a session failure.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Pi, PiEventPayload } from "@earendil-works/pi-coding-agent";
import type {
  LiveAgentProgress,
  LiveAgentStatus,
  RoundProgressSnapshot,
} from "../src/round-progress.js";
import { parseSessionCommandMarker } from "../src/session-command.js";
import { LAUNCH_PLAN_TOOL, planLaunch } from "./subagents.js";

/**
 * One subagent's slot in the tool result's `details.results` array.
 *
 * Two shapes have shipped here: the retired third-party pi-subagents carried a
 * `progress` record (status/durationMs/toolCount/lastMessage/error), while
 * pi's native subagent extension carries `exitCode` (-1 = still
 * running in parallel mode), `stopReason`/`errorMessage`, and the raw
 * `messages` transcript. Both are probed defensively — an unfamiliar payload
 * degrades to parent activity, never to a session failure.
 */
interface SubagentResultLike {
  agent?: unknown;
  exitCode?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
  messages?: unknown;
  progress?: {
    status?: unknown;
    durationMs?: unknown;
    toolCount?: unknown;
    lastMessage?: unknown;
    error?: unknown;
    recentTools?: unknown;
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function status(value: unknown, exitCode?: unknown): LiveAgentStatus {
  if (value === "completed" || value === "failed" || value === "running") return value;
  return exitCode === 0 ? "completed" : exitCode === undefined ? "running" : "failed";
}

function toolName(event: PiEventPayload): string {
  return text(event.toolName) ?? text(event.name) ?? "tool";
}

function toolId(event: PiEventPayload): string {
  return text(event.toolCallId) ?? text(event.id) ?? `${toolName(event)}:unknown`;
}

function toolArgs(event: PiEventPayload): Record<string, unknown> {
  return record(event.args) ?? record(event.input) ?? record(event.arguments) ?? {};
}

/** Native subagent supports one `{agent, task}` or parallel `{tasks:[...]}`.
 * Capture the latter at tool START — waiting for its first streaming update is
 * precisely the false pre-fanout stall must eliminate. */
function subagentNames(args: Record<string, unknown>): string[] {
  const single = text(args.agent);
  if (single) return [single];
  if (!Array.isArray(args.tasks)) return [];
  return args.tasks
    .map(record)
    .map((task) => text(task?.agent))
    .filter((name): name is string => name !== undefined);
}

/** The agents a `launch_plan` call launches, read at tool START
 * from the same plan the tool computes — its args name directories, not
 * agents, and the pre-fanout stall clock must see the fan-out begin exactly as
 * it sees a `subagent` call's. A plan the tool will refuse names no agent:
 * nothing launches, so nothing started. */
function launchPlanNames(args: Record<string, unknown>): string[] {
  const plan = planLaunch(args);
  return plan.ok ? plan.units.map((u) => u.agent) : [];
}

function reviewIdentity(body: string): { round_no: number; head_sha: string } | undefined {
  const round = /(?:^|\n)export QCR_ROUND_NO=(\d+)(?:\n|$)/.exec(body);
  const head = /\*\*Worktree\*\*:[^\n]* @ `([^`]+)`/.exec(body);
  if (!round || !head) return undefined;
  const roundNo = Number(round[1]);
  return Number.isInteger(roundNo) && roundNo > 0
    ? { round_no: roundNo, head_sha: head[1]! }
    : undefined;
}

function argPreview(args: Record<string, unknown>): string | undefined {
  for (const key of ["command", "path", "query", "pattern", "url"]) {
    const value = text(args[key]);
    if (value) return value.replace(/\s+/g, " ").slice(0, 120);
  }
  return undefined;
}

function userMessageText(event: PiEventPayload): string | undefined {
  const message = record(event.message);
  if (message?.role !== "user" || !Array.isArray(message.content)) return undefined;
  return message.content
    .map(record)
    .filter(
      (part): part is Record<string, unknown> =>
        part !== undefined && part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text as string)
    .join("\n");
}

function resultsFrom(
  event: PiEventPayload,
  carrier: "partialResult" | "result",
): SubagentResultLike[] {
  const outer = record(event[carrier]);
  const details = record(outer?.details);
  return Array.isArray(details?.results)
    ? details.results.filter((x): x is SubagentResultLike => record(x) !== undefined)
    : [];
}

function currentTool(progress: SubagentResultLike["progress"]): string | undefined {
  if (!Array.isArray(progress?.recentTools)) return undefined;
  const tools = progress.recentTools
    .map(record)
    .filter((x): x is Record<string, unknown> => x !== undefined);
  const picked = [...tools].reverse().find((x) => x.status === "running") ?? tools.at(-1);
  if (!picked) return undefined;
  const name = text(picked.tool) ?? "tool";
  const args = text(picked.args);
  return args ? `${name}: ${args.slice(0, 120)}` : name;
}

/** Tool-call / assistant-text extraction from the native shape's transcript. */
function nativeMessageParts(result: SubagentResultLike): {
  toolCount: number;
  lastText?: string;
  lastTool?: string;
} {
  if (!Array.isArray(result.messages)) return { toolCount: 0 };
  let toolCount = 0;
  let lastText: string | undefined;
  let lastTool: string | undefined;
  for (const msg of result.messages.map(record)) {
    if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const part of msg.content.map(record)) {
      if (part?.type === "toolCall") {
        toolCount += 1;
        lastTool = text(part.name) ?? lastTool;
      } else if (part?.type === "text") {
        lastText = text(part.text) ?? lastText;
      }
    }
  }
  return { toolCount, lastText, lastTool };
}

function asAgent(
  result: SubagentResultLike,
  fallbackAgent?: string,
  live = false,
): LiveAgentProgress | undefined {
  const agent = text(result.agent) ?? fallbackAgent;
  if (!agent) return undefined;
  const progress = result.progress;
  const native = nativeMessageParts(result);
  const error = text(progress?.error) ?? text(result.errorMessage);
  // Native failure signals: a non-zero exit, or a stopReason of error/aborted.
  const nativeFailed =
    (typeof result.exitCode === "number" && result.exitCode > 0) ||
    result.stopReason === "error" ||
    result.stopReason === "aborted";
  const st: LiveAgentStatus =
    progress?.status === "completed" ||
    progress?.status === "failed" ||
    progress?.status === "running"
      ? progress.status
      : nativeFailed
        ? "failed"
        : live || result.exitCode === -1 || result.exitCode === undefined
          ? "running"
          : status(undefined, result.exitCode);
  const tool = currentTool(progress) ?? (live ? native.lastTool : undefined);
  const last = text(progress?.lastMessage) ?? native.lastText;
  return {
    agent,
    status: st,
    duration_ms: number(progress?.durationMs),
    tool_count: number(progress?.toolCount) || native.toolCount,
    ...(tool ? { current_tool: tool } : {}),
    ...(last ? { last_message: last } : {}),
    ...(error ? { error } : {}),
  };
}

function parsePr(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.QCR_PR?.trim();
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const pr = Number(raw);
  return Number.isSafeInteger(pr) && pr > 0 ? pr : undefined;
}

export default function activate(pi: Pi): void {
  const pr = parsePr(process.env);
  if (pr === undefined) return; // overseer and companion do not publish PR progress
  const session = process.env.QCR_SESSION_NAME?.trim() || `pr-${pr}`;
  const root = process.env.QCR_SANDBOX_ROOT?.trim() || process.cwd();
  const path = join(root, "state", "round-progress", `pr-${pr}.json`);
  let sequence = 0;
  let lastHeartbeat = 0;
  // Key by invocation, never by agent name: a parent may deliberately launch
  // the same lens twice, and the second run must not inherit the first run's
  // terminal timestamp.
  const agents = new Map<string, LiveAgentProgress>();
  const callAgents = new Map<string, string[]>();
  const executionKey = (callId: string, agent: string): string => `${callId}:${agent}`;
  const nowIso = (): string => new Date().toISOString();
  let snapshot: RoundProgressSnapshot | undefined;

  const write = (): void => {
    if (!snapshot) return;
    snapshot.updated_at = nowIso();
    snapshot.agents = [...agents.values()];
    try {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp-${process.pid}-${sequence++}`;
      writeFileSync(tmp, `${JSON.stringify(snapshot)}\n`);
      renameSync(tmp, path);
    } catch (err) {
      console.error(`[round-progress] snapshot write failed: ${String(err)}`);
    }
  };

  const activity = (description: string): void => {
    if (!snapshot) return;
    snapshot.last_activity = description;
    snapshot.last_activity_at = nowIso();
    write();
  };

  const heartbeat = (): void => {
    if (!snapshot) return;
    const now = Date.now();
    if (now - lastHeartbeat < 1_000) return;
    lastHeartbeat = now;
    write();
  };

  pi.on("agent_start", () => {
    const at = nowIso();
    agents.clear();
    callAgents.clear();
    snapshot = {
      version: 2,
      pr,
      session,
      run_started_at: at,
      updated_at: at,
      parent_status: "active",
      last_activity_at: at,
      last_activity: "parent run started",
      agents: [],
    };
    write();
  });

  pi.on("message_start", (event) => {
    if (!snapshot) return;
    const body = userMessageText(event);
    const marker = body ? parseSessionCommandMarker(body) : undefined;
    if (!marker) return;
    snapshot.command_id = marker.id;
    snapshot.command_sha256 = marker.payloadSha256;
    const identity = reviewIdentity(body!);
    if (identity) {
      snapshot.round_no = identity.round_no;
      snapshot.head_sha = identity.head_sha;
    }
    snapshot.command_accepted_at ??= nowIso();
    snapshot.preparing_at ??= snapshot.command_accepted_at;
    activity(`command ${marker.id} accepted; parent preparing compact fanout context`);
  });

  pi.on("turn_start", heartbeat);
  pi.on("message_update", heartbeat);

  pi.on("tool_execution_start", (event) => {
    if (!snapshot) return;
    const name = toolName(event);
    const args = toolArgs(event);
    if (name === "subagent" || name === LAUNCH_PLAN_TOOL) {
      const names = name === "subagent" ? subagentNames(args) : launchPlanNames(args);
      if (names.length > 0) {
        const at = nowIso();
        const callId = toolId(event);
        callAgents.set(callId, names);
        for (const agent of names) {
          const key = executionKey(callId, agent);
          agents.set(key, {
            execution_id: key,
            agent,
            status: "running",
            duration_ms: 0,
            tool_count: 0,
            started_at: at,
          });
        }
        snapshot.first_lens_started_at ??= at;
        snapshot.fanout_started_at ??= snapshot.first_lens_started_at;
        snapshot.active_tool = `subagent: ${names.join(", ")}`;
        activity(`${names.join(", ")} started`);
        return;
      }
    }
    const preview = argPreview(args);
    snapshot.active_tool = preview ? `${name}: ${preview}` : name;
    activity(snapshot.active_tool);
  });

  pi.on("tool_execution_update", (event) => {
    if (!snapshot) return;
    const fallbacks = callAgents.get(toolId(event)) ?? [];
    const reported = resultsFrom(event, "partialResult");
    // Native parallel mode marks a still-running slot with exitCode -1 and a
    // finished one with its real exit code; single/chain slots keep exitCode 0
    // while streaming, so mid-update they read as running regardless.
    const mode = record(record(event.partialResult)?.details)?.mode;
    let changed = false;
    for (const [index, result] of reported.entries()) {
      const stillLive = mode === "parallel" ? result.exitCode === -1 : true;
      const agent = asAgent(
        result,
        fallbacks[index] ?? (fallbacks.length === 1 ? fallbacks[0] : undefined),
        stillLive,
      );
      if (!agent) continue;
      const key = executionKey(toolId(event), agent.agent);
      const previous = agents.get(key);
      agents.set(key, {
        ...previous,
        ...agent,
        execution_id: key,
        started_at: previous?.started_at ?? nowIso(),
        ...(previous?.finished_at ? { finished_at: previous.finished_at } : {}),
      });
      snapshot.active_tool = `subagent: ${agent.agent}`;
      changed = true;
    }
    if (changed) write();
    else heartbeat();
  });

  pi.on("tool_execution_end", (event) => {
    if (!snapshot) return;
    const id = toolId(event);
    const fallbacks = callAgents.get(id) ?? [];
    const reported = resultsFrom(event, "result");
    const finalAgents: LiveAgentProgress[] = [];
    for (const [index, result] of reported.entries()) {
      const agent = asAgent(
        result,
        fallbacks[index] ?? (fallbacks.length === 1 ? fallbacks[0] : undefined),
      );
      if (!agent) continue;
      const key = executionKey(id, agent.agent);
      const previous = agents.get(key);
      const finalAgent: LiveAgentProgress = {
        ...previous,
        ...agent,
        execution_id: key,
        started_at: previous?.started_at ?? nowIso(),
        finished_at: previous?.finished_at ?? nowIso(),
      };
      agents.set(key, finalAgent);
      finalAgents.push(finalAgent);
    }
    if (finalAgents.length === 0 && fallbacks.length > 0) {
      const failed = event.isError === true;
      for (const fallback of fallbacks) {
        const key = executionKey(id, fallback);
        const previous = agents.get(key);
        const finalAgent: LiveAgentProgress = {
          ...(previous ?? {
            execution_id: key,
            agent: fallback,
            duration_ms: 0,
            tool_count: 0,
            started_at: nowIso(),
          }),
          status: failed ? "failed" : "completed",
          finished_at: previous?.finished_at ?? nowIso(),
        };
        agents.set(key, finalAgent);
        finalAgents.push(finalAgent);
      }
    }
    callAgents.delete(id);
    snapshot.active_tool = undefined;
    activity(
      finalAgents.length > 0
        ? `${finalAgents.map((agent) => `${agent.agent} ${agent.status}`).join(", ")}`
        : `${toolName(event)} completed`,
    );
  });

  pi.on("agent_settled", () => {
    if (!snapshot) return;
    snapshot.parent_status = "settled";
    snapshot.active_tool = undefined;
    activity("parent session settled");
  });
}

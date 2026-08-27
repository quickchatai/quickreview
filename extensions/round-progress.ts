// Live round-progress sidecar for the operator TUI.
//
// SQLite knows which lenses were planned and when the round must finish, but
// only pi sees the transient lifecycle of the subagents it is running. This
// extension observes pi's documented tool-execution events and atomically
// publishes that ephemeral state under state/round-progress/. It never drives
// a session and never writes daemon state.
//
// VERIFY-ON-PIN (pi 0.84.1): tool_execution_start/update/end payload keys are
// probed defensively because the local build intentionally carries only
// ambient extension types; an unfamiliar payload degrades to parent activity,
// never to a session failure.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Pi, PiEventPayload } from "@earendil-works/pi-coding-agent";
import type { LiveAgentProgress, LiveAgentStatus, RoundProgressSnapshot } from "../src/round-progress.js";

interface SubagentResultLike {
  agent?: unknown;
  exitCode?: unknown;
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
    ? value as Record<string, unknown>
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

function argPreview(args: Record<string, unknown>): string | undefined {
  for (const key of ["command", "path", "query", "pattern", "url"]) {
    const value = text(args[key]);
    if (value) return value.replace(/\s+/g, " ").slice(0, 120);
  }
  return undefined;
}

function resultsFrom(event: PiEventPayload, carrier: "partialResult" | "result"): SubagentResultLike[] {
  const outer = record(event[carrier]);
  const details = record(outer?.details);
  return Array.isArray(details?.results) ? details.results.filter((x): x is SubagentResultLike => record(x) !== undefined) : [];
}

function currentTool(progress: SubagentResultLike["progress"]): string | undefined {
  if (!Array.isArray(progress?.recentTools)) return undefined;
  const tools = progress.recentTools.map(record).filter((x): x is Record<string, unknown> => x !== undefined);
  const picked = [...tools].reverse().find((x) => x.status === "running") ?? tools.at(-1);
  if (!picked) return undefined;
  const name = text(picked.tool) ?? "tool";
  const args = text(picked.args);
  return args ? `${name}: ${args.slice(0, 120)}` : name;
}

function asAgent(result: SubagentResultLike, fallbackAgent?: string): LiveAgentProgress | undefined {
  const agent = text(result.agent) ?? fallbackAgent;
  if (!agent) return undefined;
  const progress = result.progress;
  const error = text(progress?.error);
  return {
    agent,
    status: status(progress?.status, result.exitCode),
    duration_ms: number(progress?.durationMs),
    tool_count: number(progress?.toolCount),
    ...(currentTool(progress) ? { current_tool: currentTool(progress) } : {}),
    ...(text(progress?.lastMessage) ? { last_message: text(progress?.lastMessage) } : {}),
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
  const agents = new Map<string, LiveAgentProgress>();
  const callAgents = new Map<string, string>();
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
      version: 1,
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

  pi.on("turn_start", heartbeat);
  pi.on("message_update", heartbeat);

  pi.on("tool_execution_start", (event) => {
    if (!snapshot) return;
    const name = toolName(event);
    const args = toolArgs(event);
    if (name === "subagent") {
      const agent = text(args.agent);
      if (agent) {
        callAgents.set(toolId(event), agent);
        agents.set(agent, { agent, status: "running", duration_ms: 0, tool_count: 0 });
        snapshot.active_tool = `subagent: ${agent}`;
        activity(`${agent} started`);
        return;
      }
    }
    const preview = argPreview(args);
    snapshot.active_tool = preview ? `${name}: ${preview}` : name;
    activity(snapshot.active_tool);
  });

  pi.on("tool_execution_update", (event) => {
    if (!snapshot) return;
    const fallback = callAgents.get(toolId(event));
    const reported = resultsFrom(event, "partialResult");
    let changed = false;
    for (const result of reported) {
      const agent = asAgent(result, fallback);
      if (!agent) continue;
      agents.set(agent.agent, agent);
      snapshot.active_tool = `subagent: ${agent.agent}`;
      changed = true;
    }
    if (changed) write();
    else heartbeat();
  });

  pi.on("tool_execution_end", (event) => {
    if (!snapshot) return;
    const id = toolId(event);
    const fallback = callAgents.get(id);
    const reported = resultsFrom(event, "result");
    let finalAgent: LiveAgentProgress | undefined;
    for (const result of reported) {
      const agent = asAgent(result, fallback);
      if (!agent) continue;
      finalAgent = agent;
      agents.set(agent.agent, agent);
    }
    if (!finalAgent && fallback) {
      const previous = agents.get(fallback);
      const failed = event.isError === true;
      finalAgent = {
        ...(previous ?? { agent: fallback, duration_ms: 0, tool_count: 0 }),
        status: failed ? "failed" : "completed",
      };
      agents.set(fallback, finalAgent);
    }
    callAgents.delete(id);
    snapshot.active_tool = undefined;
    activity(finalAgent ? `${finalAgent.agent} ${finalAgent.status}` : `${toolName(event)} completed`);
  });

  pi.on("agent_settled", () => {
    if (!snapshot) return;
    snapshot.parent_status = "settled";
    snapshot.active_tool = undefined;
    activity("parent session settled");
  });
}

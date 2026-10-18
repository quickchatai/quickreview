// Live round-progress sidecar for the operator TUI.
//
// SQLite knows which lenses were planned and when the round must finish, but
// only pi sees the transient lifecycle of the subagents it is running. This
// extension observes pi's documented tool-execution events and atomically
// publishes that ephemeral state under state/round-progress/. It never drives
// a session and never writes daemon state. Beside the rewritten snapshot it
// appends one line per lifecycle transition to `pr-<n>.jsonl`, so
// the order a run took survives the snapshot's next rewrite.
//
// VERIFY-ON-PIN (probed at 0.84.1; result shapes re-read statically against
// the 0.84.4 tarball): tool_execution_start/update/end payload
// keys are probed defensively because the local build intentionally carries
// only ambient extension types; an unfamiliar payload degrades to parent
// activity, never to a session failure.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Pi, PiEventPayload } from "@earendil-works/pi-coding-agent";
import {
  appendProgressLog,
  isLiveAgentStatus,
  progressLogPath,
  type LiveAgentProgress,
  type LiveAgentStatus,
  type PassExecutionPhase,
  type ProgressTransition,
  type RoundProgressSnapshot,
} from "../src/round-progress.js";
import { parsePrIdentity } from "../src/pr-identity.js";
import { parseSessionCommandMarker } from "../src/session-command.js";
import { LAUNCH_PLAN_TOOL, planLaunch } from "./subagents.js";
import { isLensTool, lensIdOf } from "../src/lensresult.js";

/**
 * One subagent's (or lens's) slot in the tool result's `details.results` array.
 * The tmux bot's tools are `subagent` and `launch_plan`; the engine's are
 * `lens` (the same `{agent, task}` / `{tasks:[...]}` arguments) and
 * `lens_wave` (no arguments: it joins the wave the engine launched, so its
 * agents are known only from its results). A lens run's result carries an `id`
 * (LensResult v1), and one run is ONE slot however many calls report it.
 *
 * Two shapes are read: a `progress` record
 * (status/durationMs/toolCount/lastMessage/error), and pi's native subagent
 * extension's `exitCode` (-1 = still running in parallel mode),
 * `stopReason`/`errorMessage`, and the raw
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
  if (isLiveAgentStatus(value)) return value;
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
 * Capture the latter at tool START — waiting for its first streaming update
 * would read as a false pre-fanout stall. */
function subagentExecutions(
  args: Record<string, unknown>,
): Array<{ agent: string; phase?: PassExecutionPhase }> {
  const tasks =
    typeof args.agent === "string" ? [args] : Array.isArray(args.tasks) ? args.tasks : args.chain;
  if (!Array.isArray(tasks)) return [];
  return tasks.map(record).flatMap((task) => {
    const agent = text(task?.agent);
    if (!agent) return [];
    // Native calls receive the same canonical task-file pointers as launch_plan.
    // Free-form/legacy tasks stay unclassified rather than guessing a sweep.
    const pointer = text(task?.task)?.match(
      /^Task file: [^\n]*[\/]tasks(-sweep|-optional)?[\/][^\n]+\. Read it first;/,
    );
    const phase: PassExecutionPhase | undefined = pointer
      ? pointer[1] === "-sweep"
        ? "sweep"
        : pointer[1] === "-optional"
          ? "optional"
          : "plan"
      : undefined;
    return [{ agent, ...(phase ? { phase } : {}) }];
  });
}

/** Read phase and agents from the same accepted launch plan as the tool. */
function launchPlanExecutions(
  args: Record<string, unknown>,
): Array<{ agent: string; phase: PassExecutionPhase }> {
  const plan = planLaunch(args);
  return plan.ok ? plan.units.map(({ agent, phase }) => ({ agent, phase })) : [];
}

/** The round number rides the order's posting calls. The templates spell it
 * as an env prefix on the call itself (`QCR_EXPECTED_HEAD=… QCR_ROUND_NO=<k>
 * scripts/…` — `export` is refused by the exec policy); an order rendered from
 * an older template carries an `export QCR_ROUND_NO=<k>` line, so both
 * spellings are read. */
function reviewIdentity(body: string): { round_no: number; head_sha: string } | undefined {
  const round = /(?:^|\s)(?:export )?QCR_ROUND_NO=(\d+)(?=\s|$)/.exec(body);
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
  const st: LiveAgentStatus = isLiveAgentStatus(progress?.status)
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

export default function activate(pi: Pi): void {
  const pr = parsePrIdentity(process.env.QCR_PR);
  if (pr === undefined) return; // overseer and companion do not publish PR progress
  const session = process.env.QCR_SESSION_NAME?.trim() || `pr-${pr}`;
  const root = process.env.QCR_SANDBOX_ROOT?.trim() || process.cwd();
  const path = join(root, "state", "round-progress", `pr-${pr}.json`);
  const logPath = progressLogPath(path);
  let sequence = 0;
  let lastHeartbeat = 0;
  // Key by invocation and task slot, never by agent name alone: a parent may
  // deliberately launch the same lens twice, and one call may carry several
  // tasks of one agent (sweep rows); no run may inherit or hide another's
  // status. The first slot of an agent in a call is `<call>:<agent>`, a later
  // one `<call>:<agent>#<n>` — the n-th task of that agent in the call's order.
  const agents = new Map<string, LiveAgentProgress>();
  const callAgents = new Map<string, string[]>();
  // A lens run reported under an id keeps the slot of the call that reported
  // it first: a `lens_wave` that joins the wave again adds no second row.
  const runKeys = new Map<string, string>();
  const bindRun = (run: string | null, key: string): string => {
    if (run === null) return key;
    const held = runKeys.get(run);
    if (held !== undefined) return held;
    runKeys.set(run, key);
    return key;
  };
  const executionKeys = (callId: string, names: readonly string[]): string[] => {
    const seen = new Map<string, number>();
    return names.map((agent) => {
      const n = (seen.get(agent) ?? 0) + 1;
      seen.set(agent, n);
      return n === 1 ? `${callId}:${agent}` : `${callId}:${agent}#${n}`;
    });
  };
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

  // Every pass whose end is already logged, so an end reported by an update
  // and again by the tool's end is one line.
  const endLogged = new Set<string>();
  const transition = (entry: ProgressTransition): void => {
    if (!snapshot) return;
    try {
      mkdirSync(dirname(logPath), { recursive: true });
      appendProgressLog(logPath, {
        at: nowIso(),
        pr,
        session,
        run_started_at: snapshot.run_started_at,
        ...(snapshot.command_id ? { command_id: snapshot.command_id } : {}),
        ...entry,
      });
    } catch (err) {
      console.error(`[round-progress] transition log append failed: ${String(err)}`);
    }
  };
  const passEnded = (agent: LiveAgentProgress): void => {
    const key = agent.execution_id;
    if (!key || agent.status === "running" || endLogged.has(key)) return;
    endLogged.add(key);
    transition({ event: "pass_end", execution_id: key, agent: agent.agent, status: agent.status });
  };

  // A lens_wave names no agents at start (the engine launched the wave before
  // the main session joined it), so its rows can first appear in an update or
  // an end — the fan-out milestones are stamped then, as a start would.
  const fanoutSeen = (): void => {
    if (!snapshot || agents.size === 0) return;
    snapshot.first_lens_started_at ??= nowIso();
    snapshot.fanout_started_at ??= snapshot.first_lens_started_at;
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

  const freshSnapshot = (lastActivity: string): RoundProgressSnapshot => {
    const at = nowIso();
    agents.clear();
    callAgents.clear();
    runKeys.clear();
    endLogged.clear();
    return {
      version: 2,
      pr,
      session,
      run_started_at: at,
      updated_at: at,
      parent_status: "active",
      last_activity_at: at,
      last_activity: lastActivity,
      agents: [],
    };
  };

  // pi's automatic retry or queued continuation emits another agent_start
  // inside the SAME outer run (only one agent_settled follows the whole run,
  // as extensions/inject-bridge.ts reads it too). An inner start keeps the
  // run's command identity, milestones and passes; only a start after the
  // run settled — or a different command, below — begins a fresh snapshot.
  pi.on("agent_start", () => {
    if (snapshot && snapshot.parent_status === "active") {
      activity("parent run continued");
      return;
    }
    snapshot = freshSnapshot("parent run started");
    write();
    transition({ event: "parent_start" });
  });

  pi.on("message_start", (event) => {
    if (!snapshot) return;
    const body = userMessageText(event);
    const marker = body ? parseSessionCommandMarker(body) : undefined;
    if (!marker) return;
    // A different command in a run that has one already (a follow-up
    // delivered into the same run, or a settle never seen) is a new
    // execution: nothing of the previous command's progress carries over.
    if (snapshot.command_id !== undefined && snapshot.command_id !== marker.id)
      snapshot = freshSnapshot("parent run started");
    snapshot.command_id = marker.id;
    snapshot.command_sha256 = marker.payloadSha256;
    const identity = reviewIdentity(body!);
    if (identity) {
      snapshot.round_no = identity.round_no;
      snapshot.head_sha = identity.head_sha;
    }
    const firstAcceptance = snapshot.command_accepted_at === undefined;
    snapshot.command_accepted_at ??= nowIso();
    snapshot.preparing_at ??= snapshot.command_accepted_at;
    if (firstAcceptance)
      transition({
        event: "command_accepted",
        ...(snapshot.round_no !== undefined ? { round_no: snapshot.round_no } : {}),
        ...(snapshot.head_sha !== undefined ? { head_sha: snapshot.head_sha } : {}),
      });
    activity(`command ${marker.id} accepted; parent preparing compact fanout context`);
  });

  pi.on("turn_start", heartbeat);
  pi.on("message_update", heartbeat);

  pi.on("tool_execution_start", (event) => {
    if (!snapshot) return;
    const name = toolName(event);
    const args = toolArgs(event);
    if (isLensTool(name)) {
      const executions =
        name === LAUNCH_PLAN_TOOL ? launchPlanExecutions(args) : subagentExecutions(args);
      const names = executions.map(({ agent }) => agent);
      if (names.length > 0) {
        const at = nowIso();
        const callId = toolId(event);
        callAgents.set(callId, names);
        const keys = executionKeys(callId, names);
        for (const [index, agent] of names.entries()) {
          const key = keys[index]!;
          agents.set(key, {
            execution_id: key,
            agent,
            ...(executions[index]?.phase ? { phase: executions[index]!.phase } : {}),
            status: "running",
            duration_ms: 0,
            tool_count: 0,
            started_at: at,
          });
          transition({ event: "pass_start", execution_id: key, agent });
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
    const updated = reported.flatMap((result, index) => {
      const agent = asAgent(
        result,
        fallbacks[index] ?? (fallbacks.length === 1 ? fallbacks[0] : undefined),
        mode === "parallel" ? result.exitCode === -1 : true,
      );
      return agent ? [{ agent, run: lensIdOf(result) }] : [];
    });
    const updateKeys = executionKeys(
      toolId(event),
      updated.map(({ agent }) => agent.agent),
    );
    for (const [index, { agent, run }] of updated.entries()) {
      const key = bindRun(run, updateKeys[index]!);
      const previous = agents.get(key);
      // A parallel slot can finish while its siblings still run: a terminal
      // record carries its completion milestone from the first update that
      // reports it, and a running one never carries one.
      const { finished_at: previousFinished, ...kept } = previous ?? {};
      const next: LiveAgentProgress = {
        ...kept,
        ...agent,
        execution_id: key,
        started_at: previous?.started_at ?? nowIso(),
        ...(agent.status === "running" ? {} : { finished_at: previousFinished ?? nowIso() }),
      };
      agents.set(key, next);
      passEnded(next);
      snapshot.active_tool = `subagent: ${agent.agent}`;
      changed = true;
    }
    fanoutSeen();
    if (changed) write();
    else heartbeat();
  });

  pi.on("tool_execution_end", (event) => {
    if (!snapshot) return;
    const id = toolId(event);
    const fallbacks = callAgents.get(id) ?? [];
    const reported = resultsFrom(event, "result");
    const finalAgents: LiveAgentProgress[] = [];
    const ended = reported.flatMap((result, index) => {
      const agent = asAgent(
        result,
        fallbacks[index] ?? (fallbacks.length === 1 ? fallbacks[0] : undefined),
      );
      return agent ? [{ agent, run: lensIdOf(result) }] : [];
    });
    const endKeys = executionKeys(
      id,
      ended.map(({ agent }) => agent.agent),
    );
    for (const [index, { agent, run }] of ended.entries()) {
      const key = bindRun(run, endKeys[index]!);
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
      passEnded(finalAgent);
    }
    if (finalAgents.length === 0 && fallbacks.length > 0) {
      const failed = event.isError === true;
      const fallbackKeys = executionKeys(id, fallbacks);
      for (const [index, fallback] of fallbacks.entries()) {
        const key = fallbackKeys[index]!;
        const previous = agents.get(key);
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
            started_at: nowIso(),
          }),
          status: failed ? "failed" : "completed",
          finished_at: previous?.finished_at ?? nowIso(),
        };
        agents.set(key, finalAgent);
        finalAgents.push(finalAgent);
        passEnded(finalAgent);
      }
    }
    fanoutSeen();
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
    transition({ event: "parent_settle" });
  });
}

/**
 * Live, ephemeral progress from one PR's sticky pi session.
 *
 * SQLite remains authoritative for the round plan, timing and verdict. This
 * sidecar answers only the question SQLite cannot: what the parent and its
 * lens subagents are doing right now. Missing/stale data is UNKNOWN, never
 * inferred as pending or done.
 */
export type LiveAgentStatus = "running" | "completed" | "failed";

export interface LiveAgentProgress {
  /** One subagent tool invocation, not merely an agent name. Repeated lenses
   * remain distinct so an older completion cannot satisfy a newer run. */
  execution_id?: string;
  agent: string;
  status: LiveAgentStatus;
  duration_ms: number;
  tool_count: number;
  /** Immutable execution milestones. Absent on version-1/display-only
   * snapshots; supervisors must never infer their absence as a failure. */
  started_at?: string;
  finished_at?: string;
  current_tool?: string;
  last_message?: string;
  error?: string;
}

export type RoundExecutionStage =
  "unknown" | "accepted" | "preparing" | "fanout-started" | "passes-complete" | "finalized";

export interface RoundProgressSnapshot {
  /** v2 adds immutable execution milestones. v1 remains readable for the TUI
   * and for settlement evidence, but cannot drive early pass-stage recovery. */
  version: 1 | 2;
  pr: number;
  session: string;
  run_started_at: string;
  updated_at: string;
  parent_status: "active" | "settled";
  /** Exact durable command identity, learned from its correlated user
   * message. Absent on interactive/legacy runs; absent means telemetry cannot
   * prove settlement for command recovery. */
  command_id?: string;
  command_sha256?: string;
  command_accepted_at?: string;
  /** Prompt-derived immutable review identity. Together with command id/hash,
   * this prevents a neighboring accepted run from impersonating this round. */
  round_no?: number;
  head_sha?: string;
  /** named parent milestones. `preparing_at` is stamped with exact
   * command acceptance; `fanout_started_at` is the first subagent execution.
   * `first_lens_started_at` remains the backwards-compatible spelling. */
  preparing_at?: string;
  first_lens_started_at?: string;
  fanout_started_at?: string;
  last_activity_at: string;
  last_activity: string;
  active_tool?: string;
  agents: LiveAgentProgress[];
}

/** Built pass agents append their model tier to the lens identity. SQLite's
 * authoritative plan stores the lens, while Pi progress reports the invoked
 * agent, so every comparison crosses this one normalization seam. */
export function lensForAgent(agent: string): string {
  return agent.replace(/--(?:terra-med|sol-med|sol-high)$/, "");
}

/** Classify the current parent stage from immutable milestones plus the
 * authoritative round plan. Activity text and heartbeat age are deliberately
 * absent: they can describe a stage but can never renew it. */
export function roundExecutionStage(
  progress: RoundProgressSnapshot,
  planned: readonly string[],
): RoundExecutionStage {
  if (progress.version !== 2 || !progress.command_id || !progress.command_sha256) return "unknown";
  if (progress.parent_status === "settled") return "finalized";
  const discovery = planned.filter((name) => name !== "pass-validate");
  const plannedFanout = progress.agents.some(
    (agent) => discovery.includes(lensForAgent(agent.agent)) && agent.started_at !== undefined,
  );
  if (!plannedFanout) return progress.preparing_at ? "preparing" : "accepted";
  const terminal = (status: LiveAgentStatus): boolean =>
    status === "completed" || status === "failed";
  const plannedComplete = planned.every((name) => {
    const executions = progress.agents.filter((agent) => lensForAgent(agent.agent) === name);
    return executions.length > 0 && executions.every((agent) => terminal(agent.status));
  });
  const addedComplete = progress.agents
    .filter((agent) => !planned.includes(lensForAgent(agent.agent)))
    .every((agent) => terminal(agent.status));
  return plannedComplete && addedComplete ? "passes-complete" : "fanout-started";
}

function instant(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Parse an untrusted remote sidecar. A malformed file is simply unavailable. */
export function parseRoundProgress(raw: string): RoundProgressSnapshot | undefined {
  try {
    const value = JSON.parse(raw) as Partial<RoundProgressSnapshot>;
    if (
      (value.version !== 1 && value.version !== 2) ||
      !Number.isInteger(value.pr) ||
      typeof value.session !== "string" ||
      instant(value.run_started_at) === undefined ||
      instant(value.updated_at) === undefined ||
      (value.parent_status !== "active" && value.parent_status !== "settled") ||
      (value.command_id === undefined) !== (value.command_sha256 === undefined) ||
      (value.command_id !== undefined && typeof value.command_id !== "string") ||
      (value.command_sha256 !== undefined &&
        (typeof value.command_sha256 !== "string" ||
          !/^[a-f0-9]{64}$/.test(value.command_sha256))) ||
      (value.round_no !== undefined && (!Number.isInteger(value.round_no) || value.round_no < 1)) ||
      (value.head_sha !== undefined &&
        (typeof value.head_sha !== "string" || value.head_sha.length === 0)) ||
      instant(value.last_activity_at) === undefined ||
      typeof value.last_activity !== "string" ||
      !Array.isArray(value.agents)
    )
      return undefined;

    const runStarted = instant(value.run_started_at)!;
    const accepted =
      value.command_accepted_at === undefined ? undefined : instant(value.command_accepted_at);
    const preparing = value.preparing_at === undefined ? undefined : instant(value.preparing_at);
    const firstLens =
      value.first_lens_started_at === undefined ? undefined : instant(value.first_lens_started_at);
    const fanout =
      value.fanout_started_at === undefined ? undefined : instant(value.fanout_started_at);
    if (
      (value.command_accepted_at !== undefined && accepted === undefined) ||
      (value.preparing_at !== undefined && preparing === undefined) ||
      (value.first_lens_started_at !== undefined && firstLens === undefined) ||
      (value.fanout_started_at !== undefined && fanout === undefined) ||
      (accepted !== undefined && accepted < runStarted) ||
      (accepted !== undefined && preparing !== undefined && preparing < accepted) ||
      (accepted !== undefined && firstLens !== undefined && firstLens < accepted) ||
      (preparing !== undefined && fanout !== undefined && fanout < preparing) ||
      (firstLens !== undefined && fanout !== undefined && firstLens !== fanout)
    )
      return undefined;
    if (value.version === 2 && value.command_id !== undefined && accepted === undefined)
      return undefined;

    if (
      value.version === 2 &&
      value.agents.length > 0 &&
      firstLens === undefined &&
      fanout === undefined
    )
      return undefined;
    for (const rawAgent of value.agents) {
      if (rawAgent === null || typeof rawAgent !== "object" || Array.isArray(rawAgent))
        return undefined;
      const agent = rawAgent as Partial<LiveAgentProgress>;
      if (
        (value.version === 2 && typeof agent.execution_id !== "string") ||
        typeof agent.agent !== "string" ||
        (agent.status !== "running" && agent.status !== "completed" && agent.status !== "failed") ||
        typeof agent.duration_ms !== "number" ||
        !Number.isFinite(agent.duration_ms) ||
        typeof agent.tool_count !== "number" ||
        !Number.isFinite(agent.tool_count)
      )
        return undefined;
      const started = agent.started_at === undefined ? undefined : instant(agent.started_at);
      const finished = agent.finished_at === undefined ? undefined : instant(agent.finished_at);
      if (
        (agent.started_at !== undefined && started === undefined) ||
        (agent.finished_at !== undefined && finished === undefined) ||
        (started !== undefined && started < runStarted) ||
        (accepted !== undefined && started !== undefined && started < accepted) ||
        (started !== undefined && finished !== undefined && finished < started) ||
        (finished !== undefined && finished > instant(value.updated_at)!) ||
        (value.version === 2 && started === undefined) ||
        (value.version === 2 && agent.status === "running" && finished !== undefined) ||
        (value.version === 2 && agent.status !== "running" && finished === undefined)
      )
        return undefined;
    }
    if (value.version === 2) {
      const ids = value.agents.map((agent) => agent.execution_id);
      if (new Set(ids).size !== ids.length) return undefined;
    }
    return value as RoundProgressSnapshot;
  } catch {
    return undefined;
  }
}

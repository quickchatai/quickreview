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
  first_lens_started_at?: string;
  last_activity_at: string;
  last_activity: string;
  active_tool?: string;
  agents: LiveAgentProgress[];
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
      ((value.command_id === undefined) !== (value.command_sha256 === undefined)) ||
      (value.command_id !== undefined && typeof value.command_id !== "string") ||
      (value.command_sha256 !== undefined && (typeof value.command_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.command_sha256))) ||
      instant(value.last_activity_at) === undefined ||
      typeof value.last_activity !== "string" ||
      !Array.isArray(value.agents)
    ) return undefined;

    const runStarted = instant(value.run_started_at)!;
    const accepted = value.command_accepted_at === undefined ? undefined : instant(value.command_accepted_at);
    const firstLens = value.first_lens_started_at === undefined ? undefined : instant(value.first_lens_started_at);
    if (
      (value.command_accepted_at !== undefined && accepted === undefined) ||
      (value.first_lens_started_at !== undefined && firstLens === undefined) ||
      (accepted !== undefined && accepted < runStarted) ||
      (accepted !== undefined && firstLens !== undefined && firstLens < accepted)
    ) return undefined;
    if (value.version === 2 && value.command_id !== undefined && accepted === undefined) return undefined;

    if (value.version === 2 && value.agents.length > 0 && firstLens === undefined) return undefined;
    for (const rawAgent of value.agents) {
      if (rawAgent === null || typeof rawAgent !== "object" || Array.isArray(rawAgent)) return undefined;
      const agent = rawAgent as Partial<LiveAgentProgress>;
      if (
        (value.version === 2 && typeof agent.execution_id !== "string") ||
        typeof agent.agent !== "string" ||
        (agent.status !== "running" && agent.status !== "completed" && agent.status !== "failed") ||
        typeof agent.duration_ms !== "number" || !Number.isFinite(agent.duration_ms) ||
        typeof agent.tool_count !== "number" || !Number.isFinite(agent.tool_count)
      ) return undefined;
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
      ) return undefined;
    }
    if (value.version === 2) {
      const ids = value.agents.map((agent) => (agent as LiveAgentProgress).execution_id);
      if (new Set(ids).size !== ids.length) return undefined;
    }
    return value as RoundProgressSnapshot;
  } catch {
    return undefined;
  }
}

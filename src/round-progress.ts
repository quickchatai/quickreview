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
  agent: string;
  status: LiveAgentStatus;
  duration_ms: number;
  tool_count: number;
  current_tool?: string;
  last_message?: string;
  error?: string;
}

export interface RoundProgressSnapshot {
  version: 1;
  pr: number;
  session: string;
  run_started_at: string;
  updated_at: string;
  parent_status: "active" | "settled";
  last_activity_at: string;
  last_activity: string;
  active_tool?: string;
  agents: LiveAgentProgress[];
}

/** Parse an untrusted remote sidecar. A malformed file is simply unavailable. */
export function parseRoundProgress(raw: string): RoundProgressSnapshot | undefined {
  try {
    const value = JSON.parse(raw) as Partial<RoundProgressSnapshot>;
    if (
      value.version !== 1 ||
      !Number.isInteger(value.pr) ||
      typeof value.session !== "string" ||
      typeof value.run_started_at !== "string" ||
      typeof value.updated_at !== "string" ||
      (value.parent_status !== "active" && value.parent_status !== "settled") ||
      typeof value.last_activity_at !== "string" ||
      typeof value.last_activity !== "string" ||
      !Array.isArray(value.agents)
    ) return undefined;
    return value as RoundProgressSnapshot;
  } catch {
    return undefined;
  }
}

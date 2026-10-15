// Durable ownership journal for the TUI's deploy ceremony. Hot reload re-execs
// the TUI unconditionally, so drain ownership cannot live only in a closure:
// losing it would leave the daemon drained with no visible continuation.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Every phase the journal may hold — the type and the reader's check both
 * come from this one list, so a phase the TUI can write is one it can read. */
export const DURABLE_DEPLOY_PHASES = [
  "engaging-drain",
  "abort-requested",
  "waiting-rounds",
  "syncing",
  "awaiting-lift",
  "deploy-failed",
  "drain-failed",
  "lifting-after-abort",
] as const;

export type DurableDeployPhase = (typeof DURABLE_DEPLOY_PHASES)[number];

export interface DeployCeremonyRecord {
  version: 1;
  phase: DurableDeployPhase;
  target_head?: string;
  /** Snapshot that proved the pre-deploy drain. Auto-lift must be observed on
   * a strictly newer daemon generation, never inferred from this one. */
  pre_deploy_snapshot_at?: string;
  /** True only after a fresh status snapshot visibly showed the drain ON. */
  drain_observed?: boolean;
  /** First fresh undrained snapshot seen after the command receipt. A second
   * newer one proves an external drain-off even if ON was never observed. */
  first_undrained_snapshot_at?: string;
  /** Stable local detached-process identity; survives mandatory TUI re-exec. */
  deploy_run_id?: string;
  updated_at: string;
}

export interface DeployCeremonyStore {
  read(): DeployCeremonyRecord | undefined;
  write(record: DeployCeremonyRecord): void;
  clear(): void;
}

function valid(value: unknown): value is DeployCeremonyRecord {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.version === 1 &&
    typeof v.phase === "string" &&
    (DURABLE_DEPLOY_PHASES as readonly string[]).includes(v.phase) &&
    (v.target_head === undefined || typeof v.target_head === "string") &&
    (v.pre_deploy_snapshot_at === undefined || typeof v.pre_deploy_snapshot_at === "string") &&
    (v.drain_observed === undefined || typeof v.drain_observed === "boolean") &&
    (v.first_undrained_snapshot_at === undefined ||
      typeof v.first_undrained_snapshot_at === "string") &&
    (v.deploy_run_id === undefined || typeof v.deploy_run_id === "string") &&
    typeof v.updated_at === "string"
  );
}

export class MemoryDeployCeremonyStore implements DeployCeremonyStore {
  private record: DeployCeremonyRecord | undefined;
  read(): DeployCeremonyRecord | undefined {
    return this.record;
  }
  write(record: DeployCeremonyRecord): void {
    this.record = { ...record };
  }
  clear(): void {
    this.record = undefined;
  }
}

export class FileDeployCeremonyStore implements DeployCeremonyStore {
  constructor(private readonly path: string) {}

  read(): DeployCeremonyRecord | undefined {
    try {
      const value: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      return valid(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  write(record: DeployCeremonyRecord): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  clear(): void {
    try {
      rmSync(this.path, { force: true });
    } catch {
      // A journal cleanup failure cannot change daemon state. A stale journal
      // is safer than forgetting a drain and is re-evaluated on next boot.
    }
  }
}

// Poller: one `ssh … cat status.json` every poll interval, with backoff on
// failure and an honest health classification — the TUI never silently shows
// old truth.
import type { StatusSnapshot } from "../state.js";
import type { TuiConfig } from "../config.js";
import { resolveLayout } from "./layout.js";
import { statusArgv, type SshRunner } from "./remote.js";

export type Health =
  | { kind: "ok"; heartbeatAgeS: number }
  | {
      kind: "pipeline_unhealthy";
      heartbeatAgeS: number;
      causes: NonNullable<StatusSnapshot["pipeline"]>["causes"];
    }
  | { kind: "stale"; dataAgeS: number }
  | { kind: "unreachable"; sinceS: number };

/**
 * Health rules, in precedence order:
 *  - no successful fetch yet, or the last fetch failed → unreachable;
 *  - `written_at` older than `staleAfterS` (sized to the daemon's ~30s write
 *    cadence, not the TUI's fetch cadence) → DATA STALE;
 *  - a fresh snapshot whose pipeline reports itself unhealthy → pipeline
 *    unhealthy, with its causes;
 *  - otherwise ok, reporting the daemon heartbeat age.
 * Snapshot ages are judged against wall clock, so a dead daemon behind a
 * healthy ssh path still degrades to stale.
 */
export function classifyHealth(
  now: Date,
  staleAfterS: number,
  lastSnapshot: StatusSnapshot | undefined,
  lastFetchOk: boolean,
  lastOkAt: Date | undefined,
): Health {
  if (!lastFetchOk || !lastSnapshot || !lastOkAt) {
    const sinceS = lastOkAt
      ? Math.floor((now.getTime() - lastOkAt.getTime()) / 1000)
      : Number.POSITIVE_INFINITY;
    return { kind: "unreachable", sinceS };
  }
  const dataAgeS = Math.floor((now.getTime() - new Date(lastSnapshot.written_at).getTime()) / 1000);
  if (dataAgeS > staleAfterS) return { kind: "stale", dataAgeS };
  const heartbeatAgeS = Math.floor(
    (now.getTime() - new Date(lastSnapshot.heartbeat).getTime()) / 1000,
  );
  if (lastSnapshot.pipeline?.healthy === false) {
    return { kind: "pipeline_unhealthy", heartbeatAgeS, causes: lastSnapshot.pipeline.causes };
  }
  return { kind: "ok", heartbeatAgeS };
}

/** Whether the snapshot behind `h` is fresh enough to act on: the poller
 * reached it and it is not stale. An unhealthy pipeline is still a fresh
 * reading. The one admission rule for every consumer that files or notifies
 * from a snapshot. */
export function isFreshHealth(h: Health): boolean {
  return h.kind === "ok" || h.kind === "pipeline_unhealthy";
}

export function parseSnapshot(text: string): StatusSnapshot | undefined {
  try {
    const parsed = JSON.parse(text) as StatusSnapshot;
    if (typeof parsed.written_at !== "string" || !Array.isArray(parsed.prs)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export interface PollerState {
  snapshot?: StatusSnapshot;
  lastFetchOk: boolean;
  lastOkAt?: Date;
  consecutiveFailures: number;
}

/** Interval poller with linear backoff (interval × failures, capped ×5). */
export class Poller {
  readonly state: PollerState = { lastFetchOk: false, consecutiveFailures: 0 };
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(
    private readonly cfg: TuiConfig,
    private readonly ssh: SshRunner,
    private readonly onUpdate: () => void,
    private readonly now: () => Date = () => new Date(),
  ) {}

  health(): Health {
    return classifyHealth(
      this.now(),
      this.cfg.stale_after_s,
      this.state.snapshot,
      this.state.lastFetchOk,
      this.state.lastOkAt,
    );
  }

  private generation = 0;

  async tick(): Promise<void> {
    const generation = ++this.generation;
    // The cutover recreates the container mid-connection; every remote path
    // follows the root this keeps current (src/tui/layout.ts). Its probe never
    // fails the poll.
    // Resolved first: the status read below must use the root it settles on.
    await resolveLayout(this.cfg, this.ssh);
    const res = await this.ssh(this.cfg.ssh_host, statusArgv(this.cfg));
    if (generation !== this.generation) return;
    const snapshot = res.ok ? parseSnapshot(res.stdout) : undefined;
    if (snapshot) {
      this.state.snapshot = snapshot;
      this.state.lastFetchOk = true;
      this.state.lastOkAt = this.now();
      this.state.consecutiveFailures = 0;
    } else {
      this.state.lastFetchOk = false;
      this.state.consecutiveFailures += 1;
    }
    this.onUpdate();
  }

  nextDelayMs(): number {
    const backoff = Math.min(Math.max(this.state.consecutiveFailures, 1), 5);
    return this.cfg.poll_interval_s * 1000 * backoff;
  }

  start(): void {
    const loop = async () => {
      if (this.stopped) return;
      await this.tick();
      if (this.stopped) return;
      // Fire-and-forget, deliberately and explicitly: `loop` awaits its own
      // tick and swallows nothing, and setTimeout cannot await a callback.
      this.timer = setTimeout(() => void loop(), this.nextDelayMs());
    };
    void loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }
}

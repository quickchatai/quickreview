// The worker crash-loop breaker: what the daemon does when workers keep
// dying, so a broken round, a dead login or a bad build cannot spend the bot's
// budget one respawn at a time.
//
//   - PER PR. A worker's failure is a non-zero exit, a `failed` event over the IPC,
//     or a deadline kill (wall clock, stage or silence). After `parkAfter`
//     consecutive ones the PR is PARKED: no further spawn, a `worker_crash_loop`
//     anomaly (to the companion inbox), the last error in status.json and a TUI
//     alert. A worker that served its round resets the PR's count. The operator
//     unparks with `rerun-round` or `restart-session` (src/operator-recovery.ts).
//   - GLOBAL. `drainAfterPrs` PRs failing within `windowMs`, with no worker success
//     in between, set the existing drain valve with the reason `worker_failures`.
//     Only an explicit `drain off` lifts it (a boot's first healthy reconcile pass
//     leaves a reasoned drain standing). A PR's FIRST failure that is the
//     provider's network dropping (`fetch failed`, a reset socket) does not feed
//     the drain: one blip fails every concurrent worker at the same instant, and
//     each of them is retried. A retry that fails again counts.
//   - EVERY HOST. `gate` is the one question each host asks before it starts a
//     round worker, an answer worker or a debug round: the bot
//     is drained, or the PR is parked, and the answer is no. A takeover
//     never posts, so it does not ask.
//
// A daemon's own stop or an operator's kill is not a failure: the caller does not
// report it. Single-shepherd (rule 9): this module decides whether to spawn, it
// never schedules an agent and never touches GitHub.
import { WORKER_FAILURES_DRAIN_REASON, type StateStore } from "./state.js";

export interface BreakerLimits {
  /** Consecutive failures of one PR's workers before it is parked. */
  parkAfter: number;
  /** PRs with a failed worker (no success between) before the bot drains. */
  drainAfterPrs: number;
  /** The window those PRs' latest failures must fall in. */
  windowMs: number;
}

export const DEFAULT_BREAKER_LIMITS: BreakerLimits = {
  parkAfter: 2,
  drainAfterPrs: 3,
  windowMs: 15 * 60_000,
};

export type SpawnVerdict = { ok: true } | { ok: false; why: "draining" | "parked"; reason: string };

export interface WorkerFailure {
  parked: boolean;
  newlyParked: boolean;
  failures: number;
  drained: boolean;
}

const ERROR_CHARS = 300;

/** The provider's transport dropped the turn (src/botworker.ts words it), as
 * opposed to the provider answering with an error or refusing the login. */
const PROVIDER_TRANSPORT =
  /the provider failed the turn: .*\b(fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up)\b/i;

function isProviderTransportFailure(error: string): boolean {
  return PROVIDER_TRANSPORT.test(error);
}

export class WorkerBreaker {
  readonly limits: BreakerLimits;
  private readonly now: () => number;
  private readonly log: (msg: string, extra?: unknown) => void;

  constructor(
    private readonly store: StateStore,
    o: {
      limits?: Partial<BreakerLimits>;
      now?: () => number;
      log?: (msg: string, extra?: unknown) => void;
    } = {},
  ) {
    this.limits = { ...DEFAULT_BREAKER_LIMITS, ...o.limits };
    this.now = o.now ?? Date.now;
    this.log = o.log ?? ((): void => {});
  }

  /** May a worker that can POST (a round, an answer, a debug round) start for `pr`? */
  gate(pr: number | null): SpawnVerdict {
    const drain = this.store.drainState();
    if (drain.draining)
      return {
        ok: false,
        why: "draining",
        reason: `the bot is draining${drain.reason ? ` (${drain.reason})` : ""}: no worker starts`,
      };
    if (pr !== null) {
      const row = this.store.workerBreaker(pr);
      if (row?.parked_at)
        return {
          ok: false,
          why: "parked",
          reason: `PR #${pr} is parked after ${row.failures} consecutive worker failures${row.last_error ? ` (last: ${row.last_error})` : ""}; rerun-round or restart-session unparks it`,
        };
    }
    return { ok: true };
  }

  /** A worker for `pr` served its round. */
  success(pr: number): void {
    this.store.recordWorkerSuccess(pr, this.iso());
  }

  /** A worker for `pr` failed. */
  failure(pr: number, commandId: string, error: string): WorkerFailure {
    const at = this.iso();
    const last = error.replace(/\s+/g, " ").trim().slice(0, ERROR_CHARS) || "no reason given";
    const firstFailure = (this.store.workerBreaker(pr)?.failures ?? 0) === 0;
    const res = this.store.recordWorkerFailure(pr, {
      commandId,
      error: last,
      at,
      parkAfter: this.limits.parkAfter,
      drain: !(firstFailure && isProviderTransportFailure(last)),
    });
    if (res.newlyParked) {
      const detail = `PR #${pr} is parked after ${res.failures} consecutive worker failures; last: ${last}`;
      this.log(`worker_crash_loop — ${detail}`);
      this.store.logAnomaly(
        "worker_crash_loop",
        pr,
        null,
        detail,
        [
          `ANOMALY (worker_crash_loop) — PR #${pr}`,
          `${res.failures} consecutive worker failures; no further worker is started for it.`,
          `Last error: ${last}`,
          `The operator unparks it with rerun-round or restart-session.`,
        ].join("\n"),
      );
    }
    const drained = this.maybeDrain(at);
    return { ...res, drained };
  }

  private maybeDrain(at: string): boolean {
    const since = new Date(this.now() - this.limits.windowMs).toISOString();
    const prs = this.store.failedWorkerPrsSince(since);
    if (prs.length < this.limits.drainAfterPrs) return false;
    const res = this.store.engageDrain(
      { issuer: "operator", expires_at: null },
      WORKER_FAILURES_DRAIN_REASON,
    );
    if (res.outcome === "unchanged") return false;
    const detail = `workers failed for ${prs.length} PRs (${prs.map((n) => `#${n}`).join(", ")}) within ${Math.round(this.limits.windowMs / 60_000)} min with no success; the bot is draining (${WORKER_FAILURES_DRAIN_REASON}) until an operator runs drain off`;
    this.log(`worker_failures drain — ${detail}`);
    this.store.logEvent("drain_on", null, {
      by: "system",
      reason: WORKER_FAILURES_DRAIN_REASON,
      outcome: res.outcome,
      prs,
      at,
    });
    this.store.logAnomaly(
      "worker_crash_loop",
      null,
      null,
      detail,
      `ANOMALY (worker_crash_loop)\n${detail}`,
    );
    return true;
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }
}

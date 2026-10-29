// The worker crash-loop breaker: what the daemon does when workers keep
// dying, so a broken round, a dead login or a bad build cannot spend the bot's
// budget one respawn at a time.
//
//   - PER PR. A worker's failure is a non-zero exit, a `failed` event over the IPC,
//     or a deadline kill (wall clock, stage or silence). After `parkAfter`
//     consecutive ones the PR is PARKED (a provider network drop counts but
//     never parks by itself: it says nothing about the PR): no further spawn, a `worker_crash_loop`
//     anomaly (to the companion inbox), the last error in status.json and a TUI
//     alert. A worker that served its round resets the PR's count. The operator
//     unparks with `rerun-round` or `restart-session` (src/operator-recovery.ts).
//   - GLOBAL. `drainAfterPrs` PRs failing within `windowMs`, with no worker success
//     in between, set the existing drain valve with the reason `worker_failures`.
//     The drain heals itself: it lapses after `healAfterMs`, the queue retries,
//     and if workers fail again it drains again, each time waiting twice as long
//     up to `healMaxMs`. A served round (or the operator's `drain off`, which
//     lifts it at once) starts the wait from `healAfterMs` again. A boot's first
//     healthy reconcile pass does not lift it early, and an operator's own
//     `drain on` over it stands until the operator lifts it. A PR's FIRST
//     failure that is the provider's network dropping (`fetch failed`, a reset
//     socket) does not feed the drain: one blip fails every concurrent worker at
//     the same instant, and each of them is retried. A retry that fails again counts.
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
  /** How long the breaker's first drain stands before it lapses and the queue retries. */
  healAfterMs: number;
  /** The longest a drain waits, however often it has tripped. */
  healMaxMs: number;
}

export const DEFAULT_BREAKER_LIMITS: BreakerLimits = {
  parkAfter: 2,
  drainAfterPrs: 3,
  windowMs: 15 * 60_000,
  healAfterMs: 15 * 60_000,
  healMaxMs: 4 * 60 * 60_000,
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
    const transport = isProviderTransportFailure(last);
    const res = this.store.recordWorkerFailure(pr, {
      commandId,
      error: last,
      at,
      parkAfter: this.limits.parkAfter,
      drain: !(firstFailure && transport),
      park: !transport,
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
    // A standing drain, the breaker's or a hand-set one, is never extended here.
    if (this.store.drainState().draining) return false;
    const waitMs = Math.min(
      this.limits.healAfterMs * 2 ** this.store.workerBreakerTrips(),
      this.limits.healMaxMs,
    );
    const lapses = new Date(this.now() + waitMs).toISOString();
    const res = this.store.engageDrain(
      { issuer: "operator", expires_at: lapses },
      WORKER_FAILURES_DRAIN_REASON,
    );
    if (res.outcome === "unchanged") return false;
    this.store.recordWorkerBreakerTrip();
    const detail = `workers failed for ${prs.length} PRs (${prs.map((n) => `#${n}`).join(", ")}) within ${Math.round(this.limits.windowMs / 60_000)} min with no success; the bot is draining (${WORKER_FAILURES_DRAIN_REASON}) and retries at ${lapses} (in ${Math.round(waitMs / 60_000)} min); drain off lifts it now`;
    this.log(`worker_failures drain — ${detail}`);
    this.store.logEvent("drain_on", null, {
      by: "system",
      reason: WORKER_FAILURES_DRAIN_REASON,
      outcome: res.outcome,
      prs,
      at,
      lapses,
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

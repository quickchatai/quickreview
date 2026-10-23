// The budget of one turn: its wall-clock deadline and its dollar cap, enforced
// in ONE place whichever runtime hosts the session. The spend is read from the
// stream the turn writes (an assistant `message_end`, and the lens children a
// lens tool call reports live on every update), so the cap bites mid-call.
//
// A hit ends the turn in steps: `abort()`, then `dispose()` if the turn is
// still there after the grace, then the host's backstop if even that did not
// end it. The core never owns the process: a host that does (the bot worker,
// `qcr review`, the bench) passes a backstop that exits it; a host inside
// another program's process (a pi plugin) passes a no-op, and the abort and
// dispose are all it gets. Timers are what make this work, so it cannot save
// a process whose event loop is frozen by a synchronous loop: that case is
// covered from OUTSIDE (packages/pi-plugin/src/heartbeat.ts, the watchdog in src/reviewdetach.ts).
import { EventCostMeter } from "../pricing.js";
import { trackDeadline } from "../heartbeat.js";
import type { SessionEvent } from "./port.js";

export type BudgetReason = "timeout" | "cap";

/** What a budget stops. A RuntimeSession fits; so does a pi child. */
export interface BudgetTarget {
  /** Stop the turn in flight. Resolves once it has stopped, or when it cannot say. */
  abort(): Promise<void>;
  /** Release the turn for good: nothing survives it. */
  dispose(): Promise<void>;
}

/** Milliseconds a step gets before the next one, per reason or for both. */
export type Grace = number | Partial<Record<BudgetReason, number>>;

export interface BudgetOptions {
  /** Wall clock for the turn. */
  timeoutMs: number;
  /** Hard stop in dollars. Omitted: no cap (and the spend is not metered). */
  capUsd?: number;
  /** How long `abort()` gets to end the turn, then `dispose()`, before the next step. */
  graceMs?: Grace;
  /** Told once, as the budget trips and before it stops anything. */
  onTrip?: (reason: BudgetReason) => void;
  /** The last resort, run when `dispose()` did not end the turn either. A host
   * that owns its process passes one that exits it (`BUDGET_EXIT_CODE`); a host
   * whose turn is a child it can SIGKILL, or that runs inside another
   * program's process, passes a no-op. */
  backstop: (reason: BudgetReason) => void;
}

const DEFAULT_GRACE_MS = 5_000;
/** Exit code of a host's exiting backstop: `timeout(1)`'s. */
export const BUDGET_EXIT_CODE = 124;

const graceFor = (g: Grace | undefined, reason: BudgetReason): number =>
  typeof g === "number" ? g : (g?.[reason] ?? DEFAULT_GRACE_MS);

/** Run a stop step; one that throws or rejects has still been tried. */
function attempt(step: () => Promise<void>): void {
  try {
    step().catch(() => undefined);
  } catch {
    // a step that throws synchronously
  }
}

/** SIGTERM now, SIGKILL after `graceMs` (never holding the process open): the
 * escalation for a process group a runtime owns. */
export function termThenKill(kill: (sig: NodeJS.Signals) => void, graceMs: number): void {
  kill("SIGTERM");
  setTimeout(() => kill("SIGKILL"), graceMs).unref();
}

export class TurnBudget {
  private readonly meter = new EventCostMeter();
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly release: () => void;
  private reason: BudgetReason | null = null;
  private over = false;
  private stopping: Promise<void> | null = null;
  private readonly ended: Promise<void>;
  private markEnded: () => void = () => {};

  /** Starts the clock. Call `end()` when the turn settles. */
  constructor(
    private readonly target: BudgetTarget,
    private readonly opts: BudgetOptions,
  ) {
    this.ended = new Promise((resolve) => {
      this.markEnded = resolve;
    });
    this.release = trackDeadline(Date.now() + opts.timeoutMs);
    this.timer = setTimeout(() => this.trip("timeout"), opts.timeoutMs);
  }

  /** Feed one event of the turn, as a line or as the parsed event. Once the cap
   * is reached the turn is stopped. With no cap nothing is metered. */
  observe(event: string | SessionEvent): void {
    if (this.opts.capUsd === undefined || this.reason !== null || this.over) return;
    this.meter.add(typeof event === "string" ? event : JSON.stringify(event));
    if (this.meter.totalUsd >= this.opts.capUsd) this.trip("cap");
  }

  /** What the turn has spent, as far as the stream has said (0 with no cap). */
  get spentUsd(): number {
    return this.meter.totalUsd;
  }

  /** Why the budget stopped the turn; null while it has not. */
  get tripped(): BudgetReason | null {
    return this.reason;
  }

  /** The turn has settled: no timer is left, and an unfinished stop is called off. */
  end(): void {
    this.over = true;
    clearTimeout(this.timer);
    this.release();
    this.markEnded();
  }

  /** Resolves when a trip's steps are done (or at once if none happened). */
  async settled(): Promise<void> {
    await this.stopping;
  }

  private trip(reason: BudgetReason): void {
    if (this.reason !== null || this.over) return;
    this.reason = reason;
    clearTimeout(this.timer);
    this.opts.onTrip?.(reason);
    this.stopping = this.stop(reason);
  }

  /** The steps, each given `grace` to see the turn end before the next. */
  private async stop(reason: BudgetReason): Promise<void> {
    const grace = graceFor(this.opts.graceMs, reason);
    const ended = async (): Promise<boolean> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const limit = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, grace);
      });
      await Promise.race([this.ended, limit]);
      clearTimeout(timer);
      return this.over;
    };
    attempt(() => this.target.abort());
    if (await ended()) return;
    attempt(() => this.target.dispose());
    if (await ended()) return;
    this.opts.backstop(reason);
  }
}

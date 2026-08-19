// Overseer wake policy — which anomalies WAKE the overseer, and the
// daily heartbeat that wakes it even when nothing does.
//
// Background (2026-08-19 audit §5): anomaly EVENTS land durably in the DB
// (`store.logAnomaly`), but before this slice each call site decided
// ad hoc whether to also write an overseer inject — and most never did, so the
// overseer produced zero transcripts all day. Decision (the owner, 2026-08-19):
// heartbeat + severe classes.
//
// Shape: `store.logAnomaly` stays the ONE durable funnel; it now forwards each
// record to an optional sink (`StateStore.setAnomalySink`), and the sink built
// here applies the severity map + dedup and writes the overseer inject for
// WAKE classes. Call sites keep their bespoke wake text by passing it as
// `injectMessage` — they no longer inject themselves, so policy and dedup live
// in exactly one place.
//
// Single-shepherd (rule 9): this module only writes inject files through
// SessionHooks.injectOverseer — it never schedules an agent and never touches
// GitHub.

import { localWallClockToInstant, nextEodFire, parseHHMM, zonedParts, zoneDateString } from "./eod.js";
import type { AnomalyRecord } from "./state.js";

export type AnomalySeverity = "wake" | "quiet";

/**
 * The severity map (the owner, 2026-08-19). WAKE = the overseer sees an
 * inject immediately; QUIET = DB-only, reviewed at the daily heartbeat.
 *
 *   wake:  malformed / overdue verdicts, plan≠executed passes, degraded
 *          migration pre-check — each one means a review ran unsoundly NOW.
 *   quiet: recheck merge-verify degraded, delta-read failures — chatty,
 *          self-healing (the reconcile poll comes round again), heartbeat-tier.
 *
 * Any UNLISTED kind defaults to quiet: a new anomaly class never spams the
 * overseer until someone deliberately promotes it here.
 *
 * `slack_connections` is deliberately NOT listed: its wake rides the announcer
 * seam in wire.ts (`onAnomalySignal`, its own origin reason) — the default-
 * quiet rule here is what keeps that from double-injecting.
 */
const WAKE_KINDS: ReadonlySet<string> = new Set([
  "malformed",
  "overdue",
  "pass_plan_mismatch",
  "migration_precheck_degraded",
  // x: a ledger still stale AFTER its one re-nudge — the
  // session ignored the nudge, a human-attention grade. First-detection
  // "ledger_stale" stays quiet: the nudge is the response.
  "ledger_stale_unresolved",
]);

export function anomalySeverity(kind: string): AnomalySeverity {
  return WAKE_KINDS.has(kind) ? "wake" : "quiet";
}

/** Identical kind+pr inside this window injects once (the row is still
 * written every time — dedup is about the wake, never the audit trail). */
export const ANOMALY_DEDUP_WINDOW_MS = 10 * 60_000;

/** What logAnomaly forwards: the record plus the caller's richer wake text. */
export interface AnomalySignal extends AnomalyRecord {
  /** Bespoke inject body from the call site; absent ⇒ a generic one is built. */
  injectMessage?: string | undefined;
}

export interface AnomalyWakePolicyDeps {
  /** SessionHooks.injectOverseer (wire.ts hands the origin-stamping wrapper). */
  injectOverseer: (message: string) => Promise<void>;
  now?: () => Date;
  dedupWindowMs?: number;
  log?: (msg: string, extra?: unknown) => void;
}

/**
 * The sink `StateStore.setAnomalySink` is wired to. Never throws and never
 * blocks the caller: logAnomaly is sync and often sits inside posting paths —
 * a failed or suppressed wake must not take the durable row down with it.
 */
export class AnomalyWakePolicy {
  private readonly lastInject = new Map<string, number>();
  private readonly now: () => Date;
  private readonly windowMs: number;
  private readonly log: (msg: string, extra?: unknown) => void;

  constructor(private readonly deps: AnomalyWakePolicyDeps) {
    this.now = deps.now ?? (() => new Date());
    this.windowMs = deps.dedupWindowMs ?? ANOMALY_DEDUP_WINDOW_MS;
    this.log = deps.log ?? (() => {});
  }

  onAnomaly(signal: AnomalySignal): void {
    if (anomalySeverity(signal.kind) !== "wake") return;
    const key = `${signal.kind}#${signal.pr ?? "-"}`;
    const nowMs = this.now().getTime();
    const prev = this.lastInject.get(key);
    if (prev !== undefined && nowMs - prev < this.windowMs) {
      this.log(`anomaly wake suppressed (dedup ${key}) — row written, inject skipped`);
      return;
    }
    this.lastInject.set(key, nowMs);
    const message =
      signal.injectMessage ??
      [
        `ANOMALY (${signal.kind})${signal.pr !== null ? ` — PR #${signal.pr}` : ""}${signal.round_no !== null ? ` round ${signal.round_no}` : ""}`,
        signal.detail,
      ].join("\n");
    this.deps.injectOverseer(message).catch((err) => {
      this.log(`anomaly wake inject failed (${key}) — row is written, wake lost`, err);
    });
  }
}

// ---- daily heartbeat -------------------------------------------------------
//
// One overseer inject at 09:00 Europe/Warsaw (config `[eod] heartbeat_time`,
// same DST-correct Intl machinery as the EOD sweep): review the anomaly table
// and the digest since the last heartbeat, flag-owner-legacy what matters. The
// QUIET classes above are exactly what this pass is for.

export function renderHeartbeatMessage(date: string, lastFired: string | null): string {
  return [
    `OVERSEER HEARTBEAT — ${date}`,
    `Daily check-in. Review the anomaly table (qcr status / the anomaly events in state.db) and the digest ` +
      `since the last heartbeat${lastFired ? ` (${lastFired})` : " (first heartbeat on record)"}.`,
    "Flag-owner-legacy (commands/flag-owner-legacy) anything that matters — recurring quiet anomalies, degraded checks, stuck PRs.",
    "If nothing does, note that briefly and stand down. Do not open rounds or touch GitHub — this is a read-and-report pass.",
  ].join("\n");
}

export interface HeartbeatDeps {
  /** "HH:MM" wall time, e.g. "09:00". */
  timeHHMM: string;
  /** IANA zone, e.g. "Europe/Warsaw". */
  timeZone: string;
  /** Last fired local date ("YYYY-MM-DD"), persisted; null = never. */
  lastFired: () => string | null;
  recordFired: (date: string) => void;
  injectOverseer: (message: string) => Promise<void>;
  now?: () => Date;
  setTimer?: (cb: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  log?: (msg: string, extra?: unknown) => void;
  onError?: (err: unknown) => void;
}

export interface HeartbeatTimer {
  nextFire(): Date;
  stop(): void;
  /** Resolves when the boot catch-up decision (and any resulting inject) is done. */
  readonly booted: Promise<void>;
}

const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * Arm the daily heartbeat. Fires at most once per Warsaw calendar day (the
 * persisted last-fired date is the guard, so a restart never double-fires);
 * if the daemon was down at the hour, the next boot catches up AT MOST once —
 * only for TODAY's missed slot, never a backlog of days.
 */
export function startHeartbeat(deps: HeartbeatDeps): HeartbeatTimer {
  const now = deps.now ?? (() => new Date());
  const setT = deps.setTimer ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
  const clearT = deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const log = deps.log ?? (() => {});
  const onError = deps.onError ?? ((err: unknown) => log("heartbeat inject failed", err));
  const { hour, minute } = parseHHMM(deps.timeHHMM);

  let stopped = false;
  let handle: unknown = null;
  let target = nextEodFire(now(), deps.timeHHMM, deps.timeZone);

  const fire = async (date: string): Promise<void> => {
    const last = deps.lastFired();
    if (last === date) return; // already fired this local day (restart, race)
    try {
      await deps.injectOverseer(renderHeartbeatMessage(date, last));
      deps.recordFired(date);
      log(`heartbeat injected for ${date}`);
    } catch (err) {
      onError(err);
    }
  };

  const arm = (): void => {
    if (stopped) return;
    const delay = Math.max(0, target.getTime() - now().getTime());
    handle = setT(tick, Math.min(delay, MAX_TIMEOUT_MS));
  };

  const tick = (): void => {
    if (stopped) return;
    if (now().getTime() < target.getTime()) {
      arm(); // chunked wait — not yet due
      return;
    }
    const date = zoneDateString(target, deps.timeZone);
    void fire(date).finally(() => {
      if (!stopped) {
        target = nextEodFire(now(), deps.timeHHMM, deps.timeZone);
        arm();
      }
    });
  };

  // Boot catch-up: if today's slot already passed and today never fired, fire
  // once now. Days missed entirely while down are NOT replayed — the anomaly
  // table is cumulative, so today's pass reads everything since `lastFired`.
  const boot = (async (): Promise<void> => {
    const t = now();
    const today = zonedParts(t, deps.timeZone);
    const slot = localWallClockToInstant(today.year, today.month, today.day, hour, minute, deps.timeZone);
    if (t.getTime() >= slot.getTime()) {
      const date = zoneDateString(slot, deps.timeZone);
      if (deps.lastFired() !== date) {
        log(`heartbeat boot catch-up for ${date} (daemon was down at ${deps.timeHHMM})`);
        await fire(date);
      }
    }
  })().catch(onError);

  arm();
  return {
    nextFire: () => target,
    stop: () => {
      stopped = true;
      if (handle !== null) clearT(handle);
    },
    booted: boot,
  };
}

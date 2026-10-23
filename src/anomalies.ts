// Companion-inbox policy — which anomalies reach the companion's inbox at once,
// and the daily heartbeat that reaches it even when nothing does. (The overseer
// they used to wake is retired; the inbox is src/companioninbox.ts.)
//
// Anomaly EVENTS land durably in the DB through `store.logAnomaly`, the ONE
// durable funnel. It forwards each record to an optional sink
// (`StateStore.setAnomalySink`), and the sink built here applies the severity
// map + dedup and writes one inbox item for WAKE classes. Call sites keep
// their bespoke wake text by passing it as `injectMessage` — they never inject
// themselves, so policy and dedup live in exactly one place. Severe classes
// wake at once; everything else waits for the daily heartbeat.
//
// Single-shepherd (rule 9): this module only writes inbox items — it never
// schedules an agent and never touches GitHub.

import {
  localWallClockToInstant,
  nextEodFire,
  parseHHMM,
  zonedParts,
  zoneDateString,
} from "./eod.js";
import { inboxClassForAnomaly, type InboxClass, type InboxWriter } from "./companioninbox.js";
import type { AnomalyRecord } from "./state.js";

export type AnomalySeverity = "wake" | "quiet";

/**
 * The severity map. WAKE = an inbox item at once; QUIET = DB-only, reviewed
 * at the daily heartbeat.
 *
 *   wake:  malformed / overdue verdicts, plan≠executed passes, degraded
 *          migration pre-check — each one means a review ran unsoundly NOW.
 *   quiet: recheck merge-verify degraded, delta-read failures — chatty,
 *          self-healing (the reconcile poll comes round again), heartbeat-tier.
 *
 * Any UNLISTED kind defaults to quiet: a new anomaly class never spams the
 * inbox until someone deliberately promotes it here.
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
  // The same check, quieter the other way — collisions found, but
  // the GitHub COMMENT withheld because the event log holds a collision-
  // comment row it cannot read. Nothing self-heals: every later collision
  // comment on that PR stays withheld until a person repairs the row, so it is
  // human-attention grade — and it fires at most once per PR by construction
  // (`StateStore.anomalyRaised` gates it in dispatch), so it cannot spam.
  "migration_collision_comment_withheld",
  // A ledger still stale AFTER its one re-nudge — the
  // session ignored the nudge, a human-attention grade. First-detection
  // "ledger_stale" stays quiet: the nudge is the response.
  "ledger_stale_unresolved",
  // The same shape one tier down: a findings record still absent
  // AFTER its one re-nudge — the session ignored the nudge, which is
  // human-attention grade. First detection ("findings_record_missing") stays
  // quiet: the nudge IS the response, and a wake there would double every
  // missing record into inbox traffic.
  "findings_record_unresolved",
  // pi sessions failing API calls with token-expired errors — every round in
  // flight is doomed until someone logs in again, so this
  // is human-attention grade. Detected passively (packages/pi-plugin/src/authwatch.ts), never by
  // a smoke call.
  "pi_auth_expired",
  // The bot login's refresher could not refresh (src/loginrefresh/): the same
  // consequence one step earlier — the token runs out within hours and every
  // worker's copy dies with it — so the same grade. One per failure episode by
  // construction (the supervisor raises on the episode's start only).
  "login_refresh_failed",
  // The EOD curator may have edited the owner's pinned standing
  // instructions — the one thing curation must never touch. Human-attention
  // grade by the same logic as pi_auth_expired. The watchdog's own degraded
  // kind (`eod_pinned_watchdog_degraded`) is deliberately left unlisted: "could
  // not check" is heartbeat-tier, "may have been rewritten" is not.
  "eod_pinned_area_modified",
  // A bot-authored APPROVE on GitHub at the current head that the
  // daemon has no record of posting. Human-attention grade by construction —
  // either something wrote to GitHub outside the ONE mutation gate (rule 1,
  // the CI hard-gate and every posting guard bypassed at once), or the local
  // reviewed-head stamp failed silently and guard 2 is now blind for that PR.
  // The quieter sibling `ungated_review` (non-APPROVE) stays unlisted: it is a
  // durable row and a report line, not a wake.
  "ungated_approval",
  // Git's configuration changed DURING a round. Nothing the daemon
  // does rewrites those files mid-round, so this is a session write, and
  // config-supplied shell turns a plain `git diff` into arbitrary execution —
  // which makes this round's entire output untrusted. Human-attention grade,
  // and it cannot fire routinely: the baseline is taken from the same paths by
  // the same helper that re-checks them.
  "git_config_modified",
  // The same check over this system's OWN policy surface —
  // config.toml, the sanctioned scripts, the compiled guard, the seeds. A
  // change here is worse than the git one: it does not merely taint this
  // round, it rewrites the boundary every LATER round in the container runs
  // under. Human-attention grade; cannot fire routinely for the same reason.
  "policy_surface_modified",
  // A round that blew its deadline and is being buried rather than
  // rescued — nothing will ever come back for it, and the PR it belonged to
  // may never have been reviewed at all. Fires at most once per round, by
  // construction (the sweep terminalizes what it reports), so it can wake.
  "round_stranded",
  // Automatic recovery is exhausted and review work remains owed.
  // Stable incident state suppresses duplicates; this wake is the first loud
  // transition, while status/TUI/Slack heartbeat keep it persistently visible.
  "review_failed_loud",
  // Reviewer memory, from src/memory/health.ts. These three are raised by
  // the health monitor on TRANSITIONS (and every 6 h while an outage
  // lasts), never per round, so they cannot spam:
  //   memory_auth_failed — a credential in use is refused, or there is none;
  //                        never graced, never deferred by a drain;
  //   memory_down        — no authenticated answer for 10 min (5 min boot
  //                        grace); a drain defers it until it lifts;
  //   memory_provision_failed — the boot's provisioning report says a user
  //                        could not be ensured, the reviewer key does not
  //                        authenticate, or a user was (re)created.
  // The inbox is NOT the main audience: the same facts ride status.json
  // `memory`, which the TUI turns into a board banner, a desktop notification
  // and a tracker ticket.
  "memory_auth_failed",
  "memory_down",
  "memory_provision_failed",
  // `memory_write_backlog` — a [feedback] signal ledgered but still not in
  // reviewer memory 2 h later (the backfill pump writes owed rows only while
  // memory is healthy), or rows the pump gave up on. Raised by the pump on the crossing and every 6 h while it
  // lasts, never per row.
  "memory_write_backlog",
  // The EOD sweep's inbox write failed four times (one try and three backed-off
  // retries): the day's curation did not happen.
  "eod_inject_failed",
  // The learner (src/learner/learner.ts): the curation of a day's
  // outcomes packet did not reach memory. `eod_curation_missing` — the sweep
  // was delivered, its packet offered candidates, and no
  // `eod-curation-receipt` came within `[memory] lessons_receipt_wait_min`;
  // `eod_lessons_not_persisted` — the curator reported a lesson write refused,
  // or claimed an adoption no lesson in memory cites. Each is raised once per
  // day (the refused/missing list wakes again only when it names something
  // new), and both also ride status.json `memory.curation` —
  // the board banner, the desktop notification, `qcr status` and one tracker
  // ticket per incident — until something makes the failure good.
  "eod_curation_missing",
  "eod_lessons_not_persisted",
  // src/eventloop.ts: the daemon's OWN event loop was held — one
  // delay of `[daemon] event_loop_stall_max_s` (10 s) or more, or a p99 of
  // `event_loop_stall_p99_s` (2 s) over a full window. While it is held no
  // webhook, /health, verdict or status write runs. The detail names
  // the cause, each from its own evidence, the stall's own first: the loop
  // itself blocked (the daemon on CPU across the stall), CPU starved (the
  // cgroup's throttling), or unknown (neither — host contention or a
  // blocking wait). Raised by the watch at most once per
  // `event_loop_wake_cooldown_min` (60), so it cannot spam.
  "daemon_event_loop_stalled",
  // The archiver (src/archive/archiver.ts):
  //   archive_disk_low       — free space on the archive or state mount is
  //                            below `[archive] disk_headroom_gb` (plus the
  //                            next file's size); the archiver starts no file.
  //                            Raised once per incident (it ends only at a
  //                            reading with room for what raised it) and every
  //                            6 h while it lasts, never per file or per tick.
  //   archive_restore_failed — a reopened PR's archived transcripts or
  //                            payloads could not be restored (a corrupt or
  //                            missing archive record, or no room on the live
  //                            mount). Its session is born anyway and the
  //                            receipt guard keeps the
  //                            archived window UNKNOWN (never absent), so the
  //                            PR's pre-close recheck claims stay standing
  //                            until a person looks. Once per incident per PR.
  //   archive_live_cap       — `state/live/` plus `state/lens/` (the per-round
  //                            worker logs) is over `[archive] live_cap_gb`.
  //                            Nothing is deleted to get under it. Once per
  //                            incident and every 6 h while it lasts.
  // The archiver's verify failures stay the QUIET `archive_verify_failed`
  // (a status counter; a source that fails to verify is simply kept).
  "archive_disk_low",
  "archive_live_cap",
  "archive_restore_failed",
  // src/wakes.ts: the held-wake cap evicted an author reply or
  // an operator-recovered obligation. The store never selects either for
  // eviction, so this cannot fire routinely — it is the loud half of that
  // guarantee: a dropped reply's ping-pong claim refuses every redelivery, so
  // nobody would ever answer it.
  "author_reply_wake_dropped",
  // src/workerbreaker.ts: a PR's workers failed twice in a row and the PR
  // is parked, or workers failed on three PRs within 15 minutes and the bot is
  // draining (pr null). Every spawn is stopped until a person acts, so it is
  // human-attention grade; it fires once per park / per drain by construction.
  "worker_crash_loop",
]);

/** The WAKE set, sorted — exported so `tests/anomalies.test.ts` can pin it by
 * deep equality: promoting a kind to wake is a decision, never a side effect. */
export function wakeKinds(): string[] {
  return [...WAKE_KINDS].sort();
}

/**
 * Two cancellation kinds are DELIBERATELY unlisted above, for opposite
 * reasons:
 *
 *   `round_stopped_dead` — human-attention grade, but its wake already exists:
 *     the self-requeue path writes its own bespoke inbox item beside the
 *     anomaly row. Listing it here would inject the same event twice.
 *   the orphan sweep — no anomaly row at ALL, by design. tmux lives in the
 *     container, so a clean redeploy orphans every in-flight round, and it is
 *     the most common cancellation. Alarming on it would train everyone to
 *     ignore cancellation while the rare, serious kinds need attention. It is
 *     counted, grouped and rendered — never alarmed on.
 */

export function anomalySeverity(kind: string): AnomalySeverity {
  return WAKE_KINDS.has(kind) ? "wake" : "quiet";
}

/** Identical kind+pr inside this window injects once (the row is still
 * written every time — dedup is about the wake, never the audit trail). */
export const ANOMALY_DEDUP_WINDOW_MS = 10 * 60_000;

/**
 * Kinds whose RAISER already rate-limits them to transitions, so the generic
 * dedup keys on what the wake SAYS (kind + pr + detail) rather than on kind +
 * pr alone. The memory health monitor raises `memory_auth_failed`
 * on each transition (a new credential failing, a relapse) and every 6 h; the
 * boot raises `memory_provision_failed` once per report. Keyed on kind alone,
 * a SECOND transition inside 10 minutes — the sessions' credential failing
 * after the daemon's — would be swallowed until the 6 h re-wake. Keyed on the
 * detail, a different transition always reaches the inbox, while an
 * identical repeat (a credential flapping between refused and accepted) is
 * still held back by the window. Pinned by deep equality in
 * `tests/anomalies.test.ts`.
 */
const DETAIL_KEYED_KINDS: ReadonlySet<string> = new Set([
  "memory_auth_failed",
  "memory_down",
  "memory_provision_failed",
  // The pump raises it on the backlog crossing (every 6 h while
  // it lasts) and once per tick that gave rows up — a give-up minutes after a
  // backlog wake is a different fact and must still reach the inbox.
  "memory_write_backlog",
  // Raised once per DAY by the learner; deferred days fire back
  // to back after a drain, so two days' wakes can land minutes apart.
  "eod_curation_missing",
  "eod_lessons_not_persisted",
]);

export function detailKeyedKinds(): string[] {
  return [...DETAIL_KEYED_KINDS].sort();
}

/** What logAnomaly forwards: the record plus the caller's richer wake text. */
export interface AnomalySignal extends AnomalyRecord {
  /** Bespoke item text from the call site; absent ⇒ a generic one is built. */
  injectMessage?: string | undefined;
}

export interface AnomalyWakePolicyDeps {
  /** Writes one inbox item (src/companioninbox.ts `CompanionInbox.writer()`). */
  writeInbox: InboxWriter;
  now?: () => Date;
  dedupWindowMs?: number;
  log?: (msg: string, extra?: unknown) => void;
  /** The waits before each RETRY of a failed wake write — its length is the
   * retry count. Defaults to `WAKE_RETRY_BACKOFF_MS`. */
  retryBackoffMs?: readonly number[];
  setTimer?: (cb: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** A failed inbox write is retried after these waits: a producer that records
 * its incident once (a stranded round, a withheld comment) never signals
 * again, so the policy owns the retry. Past the last one the wake is lost and
 * the row stays for the heartbeat's review. */
export const WAKE_RETRY_BACKOFF_MS: readonly number[] = Object.freeze([60_000, 300_000, 900_000]);

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
  private readonly backoff: readonly number[];
  private readonly setTimer: (cb: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  /** Retries armed and not yet run. */
  private readonly retries = new Set<unknown>();
  private stopped = false;
  private readonly chains = new Map<string, { retry?: unknown }>();

  constructor(private readonly deps: AnomalyWakePolicyDeps) {
    this.now = deps.now ?? (() => new Date());
    this.windowMs = deps.dedupWindowMs ?? ANOMALY_DEDUP_WINDOW_MS;
    this.log = deps.log ?? (() => {});
    this.backoff = deps.retryBackoffMs ?? WAKE_RETRY_BACKOFF_MS;
    this.setTimer =
      deps.setTimer ??
      ((cb, ms) => {
        const t = setTimeout(cb, ms);
        t.unref?.();
        return t;
      });
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  onAnomaly(signal: AnomalySignal): void {
    if (this.stopped || anomalySeverity(signal.kind) !== "wake") return;
    const key = `${signal.kind}#${signal.pr ?? "-"}${DETAIL_KEYED_KINDS.has(signal.kind) ? `#${signal.detail}` : ""}`;
    const nowMs = this.now().getTime();
    const prev = this.lastInject.get(key);
    if (prev !== undefined && nowMs - prev < this.windowMs) {
      this.log(`anomaly wake suppressed (dedup ${key}) — row written, inbox item skipped`);
      return;
    }
    const message =
      signal.injectMessage ??
      [
        `ANOMALY (${signal.kind})${signal.pr !== null ? ` — PR #${signal.pr}` : ""}${signal.round_no !== null ? ` round ${signal.round_no}` : ""}`,
        signal.detail,
      ].join("\n");
    const prior = this.chains.get(key);
    if (prior?.retry !== undefined) {
      this.clearTimer(prior.retry);
      this.retries.delete(prior.retry);
    }
    const chain = {};
    this.chains.set(key, chain);
    this.deliver(key, message, inboxClassForAnomaly(signal.kind), 0, chain);
  }

  /** Disarm every pending retry (daemon shutdown). */
  stop(): void {
    this.stopped = true;
    for (const h of this.retries) this.clearTimer(h);
    this.retries.clear();
    this.chains.clear();
  }

  /** Write one inbox item, holding the dedup window from now. A failed write —
   * a rejection, or a hook that throws before it returns its promise —
   * releases the window (the next identical signal injects again) and is
   * retried after `backoff[attempt]` unless a later identical signal has
   * taken the key meanwhile. */
  private deliver(
    key: string,
    message: string,
    cls: InboxClass,
    attempt: number,
    chain: { retry?: unknown },
  ): void {
    if (this.stopped || this.chains.get(key) !== chain) return;
    const stampMs = this.now().getTime();
    this.lastInject.set(key, stampMs);
    let sent: Promise<void>;
    try {
      sent = this.deps.writeInbox(message, cls);
    } catch (err) {
      sent = Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    sent.then(
      () => {
        if (this.chains.get(key) === chain) this.chains.delete(key);
      },
      (err: unknown) => {
        if (this.chains.get(key) !== chain) return;
        if (this.lastInject.get(key) === stampMs) this.lastInject.delete(key);
        const wait = this.backoff[attempt];
        if (this.stopped || wait === undefined) {
          this.chains.delete(key);
          this.log(`anomaly inbox write failed (${key}) — row is written, item lost`, err);
          return;
        }
        this.log(
          `anomaly inbox write failed (${key}) — retried in ${Math.round(wait / 1000)} s`,
          err,
        );
        const handle = this.setTimer(() => {
          this.retries.delete(handle);
          delete chain.retry;
          if (this.stopped || this.chains.get(key) !== chain || this.lastInject.has(key)) return;
          this.deliver(key, message, cls, attempt + 1, chain);
        }, wait);
        chain.retry = handle;
        this.retries.add(handle);
      },
    );
  }
}

// ---- daily heartbeat -------------------------------------------------------
//
// One heartbeat inbox item each morning (config `[eod] heartbeat_time` + timezone,
// same DST-correct Intl machinery as the EOD sweep): review the anomaly table
// and the digest since the last heartbeat, flag-owner what matters. The
// QUIET classes above are exactly what this pass is for.

export function renderHeartbeatMessage(date: string, lastFired: string | null): string {
  return [
    `HEARTBEAT — ${date}`,
    `Daily check-in. Review the anomaly table (qcr status / the anomaly events in state.db) and the digest ` +
      `since the last heartbeat${lastFired ? ` (${lastFired})` : " (first heartbeat on record)"}.`,
    "Flag-owner (commands/flag-owner) anything that matters — recurring quiet anomalies, degraded checks, stuck PRs.",
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
  /** Writes one inbox item; the heartbeat is class `heartbeat`, one per day. */
  writeInbox: (message: string, date: string) => Promise<void>;
  now?: () => Date;
  setTimer?: (cb: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  log?: (msg: string, extra?: unknown) => void;
  onError?: (err: unknown) => void;
  /** The waits before each RETRY of a failed write on the same day — its
   * length is the retry count. Defaults to `HEARTBEAT_RETRY_BACKOFF_MS`. */
  retryBackoffMs?: readonly number[];
}

/** A failed heartbeat write is retried after these waits, the same day's
 * check-in each time; past the last one the next day's slot is armed. */
export const HEARTBEAT_RETRY_BACKOFF_MS: readonly number[] = WAKE_RETRY_BACKOFF_MS;

export interface HeartbeatTimer {
  nextFire(): Date;
  stop(): void;
  /** Resolves when the boot catch-up decision (and any resulting write) is done. */
  readonly booted: Promise<void>;
}

const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * Arm the daily heartbeat. Fires at most once per `timeZone` calendar day (the
 * persisted last-fired date is the guard, so a restart never double-fires);
 * if the daemon was down at the hour, the next boot catches up AT MOST once —
 * only for TODAY's missed slot, never a backlog of days.
 */
export function startHeartbeat(deps: HeartbeatDeps): HeartbeatTimer {
  const now = deps.now ?? (() => new Date());
  const setT = deps.setTimer ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
  const clearT =
    deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const log = deps.log ?? (() => {});
  const onError = deps.onError ?? ((err: unknown) => log("heartbeat inbox write failed", err));
  const { hour, minute } = parseHHMM(deps.timeHHMM);

  const backoff = deps.retryBackoffMs ?? HEARTBEAT_RETRY_BACKOFF_MS;

  let stopped = false;
  let handle: unknown = null;
  let target = nextEodFire(now(), deps.timeHHMM, deps.timeZone);
  // Retain the next scheduled day independently of a prior day's retries.
  let dailyTarget = target;
  /** The day a failed write is being retried for, and the retries spent. */
  let retry: { date: string; attempt: number } | null = null;

  /** Write one day's check-in. True when it is delivered (or was already).
   * A delivered check-in whose stamp could not be recorded is still
   * delivered: it is never written again for that. */
  const fire = async (date: string): Promise<boolean> => {
    const last = deps.lastFired();
    if (last === date) return true; // already fired this local day (restart, race)
    try {
      await deps.writeInbox(renderHeartbeatMessage(date, last), date);
    } catch (err) {
      onError(err);
      return false;
    }
    log(`heartbeat written to the inbox for ${date}`);
    try {
      deps.recordFired(date);
    } catch (err) {
      log(`heartbeat for ${date} delivered, but its stamp was not recorded`, err);
    }
    return true;
  };

  const arm = (): void => {
    if (stopped) return;
    if (handle !== null) clearT(handle);
    const delay = Math.max(0, target.getTime() - now().getTime());
    handle = setT(tick, Math.min(delay, MAX_TIMEOUT_MS));
  };

  /** After a fire: a failed one is retried the same day while retries
   * remain, else the next day's slot is armed. */
  const settle = (date: string, delivered: boolean): void => {
    if (stopped) return;
    const attempt = retry?.date === date ? retry.attempt : 0;
    if (!delivered && attempt < backoff.length) {
      retry = { date, attempt: attempt + 1 };
      target = new Date(now().getTime() + backoff[attempt]!);
      log(`heartbeat for ${date} will be retried at ${target.toISOString()}`);
    } else {
      if (!delivered) log(`heartbeat for ${date} not delivered after ${attempt} retries`);
      retry = null;
      target = dailyTarget;
    }
    arm();
  };

  const tick = (): void => {
    handle = null;
    if (stopped) return;
    if (now().getTime() < target.getTime()) {
      arm(); // chunked wait — not yet due
      return;
    }
    const date = retry?.date ?? zoneDateString(target, deps.timeZone);
    if (retry === null) dailyTarget = nextEodFire(target, deps.timeHHMM, deps.timeZone);
    void fire(date).then(
      (delivered) => settle(date, delivered),
      (err: unknown) => {
        onError(err);
        settle(date, false);
      },
    );
  };

  // Boot catch-up: if today's slot already passed and today never fired, fire
  // once now. Days missed entirely while down are NOT replayed — the anomaly
  // table is cumulative, so today's pass reads everything since `lastFired`.
  const boot = (async (): Promise<void> => {
    const t = now();
    const today = zonedParts(t, deps.timeZone);
    const slot = localWallClockToInstant(
      today.year,
      today.month,
      today.day,
      hour,
      minute,
      deps.timeZone,
    );
    if (t.getTime() >= slot.getTime()) {
      const date = zoneDateString(slot, deps.timeZone);
      if (deps.lastFired() !== date) {
        log(`heartbeat boot catch-up for ${date} (daemon was down at ${deps.timeHHMM})`);
        if (!(await fire(date))) settle(date, false);
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

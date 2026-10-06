// EOD scheduling — a daily wall-clock fire in the configured [eod] timezone,
// DST-correct, using Intl only (no date libs).
//
// Why daemon-side (§4): every pi scheduler extension is in-process —
// it fires only while a session happens to be open, queues nothing, and none
// exposes a timezone, so a "Warsaw end of day" trigger would drift an hour
// across CET/CEST and silently skip days. The daemon owns the clock instead.
//
// DST semantics chosen (documented, tested):
//   * The fire instant is the next instant strictly after `now` whose WALL
//     CLOCK in `timeZone` reads exactly `timeHHMM`. Exactly one fire per local
//     calendar day, on transition days too: the spring-forward day is 23h long
//     (gap between consecutive fires 23h), the fall-back day 25h — the fire
//     still lands at 18:00 local on both, with the UTC offset flipping
//     (17:00Z under CEST → 16:00Z... i.e. 18:00 CEST = 16:00Z, 18:00 CET =
//     17:00Z).
//   * Nonexistent wall times (inside a spring-forward gap — cannot happen for
//     18:00 in Warsaw, but the helper is general): fire at the shifted-forward
//     instant, i.e. the candidate whose local clock lands after the requested
//     time. Nothing is skipped.
//   * Ambiguous wall times (inside a repeated fall-back hour — again not 18:00
//     in Warsaw): fire at the FIRST (earlier, still-DST) occurrence, once only.
import { stripModelDocs } from "./promptdoc.js";
import { readFileSync } from "node:fs";
import { NEUTRAL_IDENTITY_VARS } from "./include.js";
import { render, type TemplateVars } from "./templates.js";

const MAX_TIMEOUT_MS = 2 ** 31 - 1;
const DAY_MS = 86_400_000;

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

/** Wall-clock parts of `instant` in `timeZone`. */
export function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const parts = formatter(timeZone).formatToParts(instant);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? "0");
  // hour12:false can render midnight as "24" in some ICU versions — only the
  // hour field is affected.
  const hour = get("hour") % 24;
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour,
    minute: get("minute"),
    second: get("second"),
  };
}

/** "YYYY-MM-DD" local calendar date in `timeZone` — the digest/date stamp. */
export function zoneDateString(instant: Date, timeZone: string): string {
  const p = zonedParts(instant, timeZone);
  return `${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/**
 * The operations-day token: "YYYY-MM-DD" in the configured
 * operations timezone (`[ops] timezone`, `cfg.ops.timezone`). The ONE
 * day-naming implementation — the [feedback] same-day addendum, the agent
 * rebuild rollover and the Slack day caps all derive their day through it;
 * callers thread the zone from config rather than importing a constant.
 */
export function opsDay(timeZone: string, now: Date = new Date()): string {
  return zoneDateString(now, timeZone);
}

/** Zone offset (ms east of UTC) in effect at `instant`. */
export function zoneOffsetMs(instant: Date, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // Millisecond component is not exposed by the formatter; strip it from both sides.
  return asUtc - (instant.getTime() - (instant.getTime() % 1000));
}

/** Parse "HH:MM" strictly. */
export function parseHHMM(time: string): { hour: number; minute: number } {
  const m = /^(\d{2}):(\d{2})$/.exec(time.trim());
  if (!m) throw new Error(`bad eod time '${time}' — expected HH:MM`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) throw new Error(`bad eod time '${time}'`);
  return { hour, minute };
}

/**
 * The instant at which the wall clock in `timeZone` reads
 * yyyy-mm-dd hh:mm — resolving DST gaps/overlaps per the semantics above.
 */
export function localWallClockToInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
  // The offset can only take one of (at most) two values around a transition:
  // sample a day either side of the target.
  const before = zoneOffsetMs(new Date(naive - DAY_MS), timeZone);
  const after = zoneOffsetMs(new Date(naive + DAY_MS), timeZone);
  const candidates = Array.from(new Set([naive - before, naive - after])).sort((a, b) => a - b);

  const matches = candidates.filter((ts) => {
    const p = zonedParts(new Date(ts), timeZone);
    return (
      p.year === year &&
      p.month === month &&
      p.day === day &&
      p.hour === hour &&
      p.minute === minute
    );
  });
  if (matches.length > 0) return new Date(matches[0]!); // ambiguous → first (earlier) occurrence

  // Nonexistent wall time (inside a spring-forward gap): take the candidate
  // whose local clock lands AFTER the requested time — the shifted-forward fire.
  const shifted = candidates.filter((ts) => {
    const p = zonedParts(new Date(ts), timeZone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) > naive;
  });
  return new Date(shifted.length > 0 ? Math.min(...shifted) : Math.max(...candidates));
}

/**
 * The next instant strictly after `now` whose wall clock in `timeZone` reads
 * `timeHHMM`. Pure — no timers, no I/O.
 */
export function nextEodFire(now: Date, timeHHMM: string, timeZone: string): Date {
  const { hour, minute } = parseHHMM(timeHHMM);
  const today = zonedParts(now, timeZone);
  let candidate = localWallClockToInstant(
    today.year,
    today.month,
    today.day,
    hour,
    minute,
    timeZone,
  );
  if (candidate.getTime() > now.getTime()) return candidate;
  // Advance one local calendar day (calendar arithmetic on the wall date, so
  // 23h/25h days do not matter).
  const next = new Date(Date.UTC(today.year, today.month - 1, today.day) + DAY_MS);
  candidate = localWallClockToInstant(
    next.getUTCFullYear(),
    next.getUTCMonth() + 1,
    next.getUTCDate(),
    hour,
    minute,
    timeZone,
  );
  return candidate;
}

/** Render the eod-sweep template: `{{date}}` plus the identity
 * variables (`{{owner_name}}`/`{{repo}}`/`{{bot_login}}`), through the strict
 * renderer — an unknown `{{…}}` throws rather than reaching the session.
 * `dayContext` (optional) is daemon-measured context — e.g. the day's
 * cancellation summary — appended after the seeded template, which
 * we may not edit (rule 6): the sweep session is told to carry it into the
 * digest it writes. */
export function renderEodPrompt(
  template: string,
  date: string,
  dayContext?: string,
  identity: Readonly<TemplateVars> = NEUTRAL_IDENTITY_VARS,
): string {
  const rendered = render(stripModelDocs(template), { ...identity, date });
  if (!dayContext?.trim()) return rendered;
  return (
    `${rendered.replace(/\n*$/, "\n")}\n` +
    `## Daemon-measured context for ${date}\n\n` +
    `Carry these lines into today's digest verbatim (under Spend):\n\n` +
    `${dayContext.trim()}\n`
  );
}

export type TimerHandle = unknown;

/** Why a day's sweep was deferred. */
export type EodHoldReason = "draining" | "sweep_in_flight";

export interface EodTimerDeps {
  timeHHMM: string;
  timeZone: string;
  /** eod-sweep.md contents; read lazily so an edit lands without a restart. */
  readPrompt: () => string;
  /** identity variable map (`identityVars(cfg)` in production);
   * neutral role wording when absent. */
  identity?: Readonly<TemplateVars>;
  /** Daemon-measured lines for the fired date, appended to the prompt so the
   * sweep carries them into the digest (the cancellation summary).
   * A throw here never loses the sweep: the prompt just goes out bare. */
  dayContext?: (date: string) => string;
  /** Deploy-window drain (2026-08-25): when this returns true at fire time
   * the sweep is DEFERRED (S2 — it used to be skipped for the day):
   * `onHeld` fires, the day joins the `deferred` set, and it fires once this
   * returns false again — checked every `deferPollMs`, and across a restart
   * when `deferred` persists the set. A throwing probe counts as "not held":
   * a broken check must not silently eat the sweep. */
  shouldHold?: () => boolean;
  /** True while an earlier sweep is still being worked — wire.ts: the
   * pinned-area watch window is open. A day whose fire comes up
   * then is deferred behind it like a drained one, so two sweeps never run
   * at once: the curator works one day at a time, and the watch judges each
   * day's window on that day's work. A throwing probe counts as "not in
   * flight". */
  sweepInFlight?: () => boolean;
  /** A day was deferred: `draining` (the drain), or `sweep_in_flight` (an
   * earlier day's sweep is still open or still retrying its inject). */
  onHeld?: (date: string, why: EodHoldReason) => void;
  /** Where the deferred days survive a restart (wire.ts: state.db). Without
   * it they live as long as this timer. */
  deferred?: { load(): string[]; save(dates: string[]): void };
  /** How often a deferred sweep re-checks the drain. */
  deferPollMs?: number;
  /** Called when a deferred day finally fires, before its injection. */
  onDeferredFire?: (date: string) => void;
  /** SessionHooks.injectOverseer. `date` is the day the prompt sweeps — a
   * deferred day's, not today's — so a wrapper (the pin watch) can name the
   * window after the day it watches. */
  injectOverseer: (message: string, date: string) => Promise<void>;
  /** The waits before each RETRY of a failed injection (S2) — its
   * length is the retry count. Defaults to `EOD_DEFAULTS.retryBackoffMs`. */
  retryBackoffMs?: readonly number[];
  /** Every attempt failed: the day's sweep did not reach the overseer.
   * wire.ts raises the `eod_inject_failed` wake. */
  onInjectFailed?: (date: string, err: unknown, attempts: number) => void;
  now?: () => Date;
  setTimer?: (cb: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  /** Called after a successful injection, with the local date that fired. */
  onFire?: (date: string) => void;
  /** Every failed attempt, retried or not. */
  onError?: (err: unknown) => void;
}

export const EOD_DEFAULTS = Object.freeze({
  /** A deferred sweep looks for the drain to lift this often. */
  deferPollMs: 60_000,
  /** Three retries of a failed injection: after 1, 5 and 15 minutes. */
  retryBackoffMs: Object.freeze([60_000, 300_000, 900_000]),
});

export interface EodTimer {
  /** The instant the currently-armed timer is aiming at. */
  nextFire(): Date;
  /** The days a drain deferred that have not fired yet (S2). */
  deferredDates(): string[];
  stop(): void;
}

/** Read the seeded prompt file (never rewritten by us). */
export function promptReader(path: string): () => string {
  return () => readFileSync(path, "utf8");
}

/**
 * Arm the daily EOD injection: at each fire, render prompts/eod-sweep.md with
 * the zone-local date and inject it into the overseer, then reschedule.
 * Long waits are chunked around the 2^31-1 ms setTimeout ceiling.
 *
 * Two S2 guarantees ride on top. A drain DEFERS the day rather than
 * skipping it: the date joins a persisted set and fires, oldest first and
 * one at a time, once the drain lifts — a deploy-window drain is usually
 * followed by a restart, which is why the set is persisted. "One at a time"
 * means one SWEEP at a time, not one inject: a day never fires while another
 * fire is in flight or `sweepInFlight` says the last sweep is still being
 * worked, and a day whose hour comes up then is deferred behind it. And an injection
 * that fails is retried (`retryBackoffMs`) before `onInjectFailed` says the
 * day's curation did not happen; a deferred day leaves the set only once its
 * fire has finished, so a restart mid-retry fires it again rather than never.
 */
/** Run an observer callback; a throw from it is swallowed — it must never
 * turn into a lost or a doubled sweep. */
function safely(fn: () => void): void {
  try {
    fn();
  } catch {
    // an observer's problem, not the sweep's
  }
}

export function startEodTimer(deps: EodTimerDeps): EodTimer {
  const now = deps.now ?? (() => new Date());
  const setT = deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
  const clearT = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const backoff = deps.retryBackoffMs ?? EOD_DEFAULTS.retryBackoffMs;
  const deferPollMs = Math.max(1, deps.deferPollMs ?? EOD_DEFAULTS.deferPollMs);

  let target = nextEodFire(now(), deps.timeHHMM, deps.timeZone);
  let handle: TimerHandle | null = null;
  let pollHandle: TimerHandle | null = null;
  /** Pending retry waits: stop() cancels the timer AND releases the waiter,
   * so a fire in its backoff ends ("stopped") instead of hanging forever. */
  const waits = new Map<TimerHandle, () => void>();
  let stopped = false;
  let deferred: string[] = [];
  try {
    deferred = [...new Set(deps.deferred?.load() ?? [])].sort();
  } catch {
    deferred = [];
  }
  /** A fire (the day's own, or a deferred one) is in flight — injecting or
   * waiting out a retry. One at a time. */
  let firing = false;

  const persist = (): void => {
    try {
      deps.deferred?.save(deferred);
    } catch {
      // The in-memory set still fires it; only a restart could lose it.
    }
  };

  const held = (): boolean => {
    try {
      return deps.shouldHold?.() === true;
    } catch {
      return false;
    }
  };

  /** Another sweep is still running: ours, or the one the watch window is
   * open for. */
  const busy = (): boolean => {
    if (firing) return true;
    try {
      return deps.sweepInFlight?.() === true;
    } catch {
      return false;
    }
  };

  const arm = (): void => {
    if (stopped) return;
    const delay = Math.max(0, target.getTime() - now().getTime());
    handle = setT(tick, Math.min(delay, MAX_TIMEOUT_MS));
  };

  const wait = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const h = setT(() => {
        waits.delete(h);
        resolve();
      }, ms);
      waits.set(h, resolve);
    });

  /** Render and inject one day's sweep, retrying a failed injection.
   * `stopped` — the timer was stopped before the day was settled either way. */
  const fire = async (date: string): Promise<"delivered" | "failed" | "stopped"> => {
    let context = "";
    try {
      context = deps.dayContext?.(date) ?? "";
    } catch {
      // context is best-effort; the sweep itself must still fire
    }
    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= backoff.length; attempt += 1) {
      if (stopped) return "stopped";
      try {
        await deps.injectOverseer(
          renderEodPrompt(deps.readPrompt(), date, context, deps.identity),
          date,
        );
      } catch (err) {
        lastErr = err;
        safely(() => deps.onError?.(err));
        if (attempt < backoff.length) await wait(backoff[attempt]!);
        continue;
      }
      // Outside the try: a throwing observer must not read as a failed
      // injection and re-inject a sweep that was delivered.
      safely(() => deps.onFire?.(date));
      return "delivered";
    }
    if (stopped) return "stopped";
    safely(() => deps.onInjectFailed?.(date, lastErr, backoff.length + 1));
    return "failed";
  };

  const armPoll = (): void => {
    if (stopped || pollHandle !== null || deferred.length === 0) return;
    pollHandle = setT(poll, deferPollMs);
  };

  /** A deferred day fires once the drain has lifted — oldest first, one at
   * a time, never while another sweep is in flight; it leaves the set only
   * when its fire has finished. */
  const poll = (): void => {
    pollHandle = null;
    if (stopped || deferred.length === 0) return;
    if (busy() || held()) {
      armPoll();
      return;
    }
    const date = deferred[0]!;
    firing = true;
    safely(() => deps.onDeferredFire?.(date));
    void fire(date).then((outcome) => {
      firing = false;
      // Stopped before the day was settled (a shutdown during the retries):
      // it stays in the persisted set, so the next boot fires it again.
      if (outcome === "stopped") return;
      deferred = deferred.filter((d) => d !== date);
      persist();
      armPoll();
    });
  };

  const tick = (): void => {
    if (stopped) return;
    if (now().getTime() < target.getTime()) {
      arm(); // chunked wait — not yet due
      return;
    }
    const date = zoneDateString(target, deps.timeZone);
    const why: EodHoldReason | null = held() ? "draining" : busy() ? "sweep_in_flight" : null;
    if (why !== null) {
      if (!deferred.includes(date)) {
        deferred = [...deferred, date].sort();
        persist();
      }
      safely(() => deps.onHeld?.(date, why));
      armPoll();
      target = nextEodFire(now(), deps.timeHHMM, deps.timeZone);
      arm();
      return;
    }
    firing = true;
    void fire(date).finally(() => {
      firing = false;
      if (!stopped) {
        target = nextEodFire(now(), deps.timeHHMM, deps.timeZone);
        arm();
      }
    });
  };

  arm();
  // A day a drain deferred before a restart still fires once it lifts.
  armPoll();
  return {
    nextFire: () => target,
    deferredDates: () => [...deferred],
    stop: () => {
      stopped = true;
      if (handle !== null) clearT(handle);
      if (pollHandle !== null) clearT(pollHandle);
      for (const [h, release] of waits) {
        clearT(h);
        release();
      }
      waits.clear();
    },
  };
}

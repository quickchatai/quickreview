// EOD scheduling — 18:00 Europe/Warsaw, DST-correct, using Intl only.
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
import { readFileSync } from "node:fs";

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
    return p.year === year && p.month === month && p.day === day && p.hour === hour && p.minute === minute;
  });
  if (matches.length > 0) return new Date(matches[0]!); // ambiguous → first (earlier) occurrence

  // Nonexistent wall time (inside a spring-forward gap): take the candidate
  // whose local clock lands AFTER the requested time — the shifted-forward fire.
  const shifted = candidates.filter((ts) => {
    const p = zonedParts(new Date(ts), timeZone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) > naive;
  });
  return new Date((shifted.length > 0 ? Math.min(...shifted) : Math.max(...candidates))!);
}

/**
 * The next instant strictly after `now` whose wall clock in `timeZone` reads
 * `timeHHMM`. Pure — no timers, no I/O.
 */
export function nextEodFire(now: Date, timeHHMM: string, timeZone: string): Date {
  const { hour, minute } = parseHHMM(timeHHMM);
  const today = zonedParts(now, timeZone);
  let candidate = localWallClockToInstant(today.year, today.month, today.day, hour, minute, timeZone);
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

/** Substitute {{date}} in the eod-sweep template. */
export function renderEodPrompt(template: string, date: string): string {
  return template.replaceAll("{{date}}", date);
}

export type TimerHandle = unknown;

export interface EodTimerDeps {
  timeHHMM: string;
  timeZone: string;
  /** eod-sweep.md contents; read lazily so an edit lands without a restart. */
  readPrompt: () => string;
  /** SessionHooks.injectOverseer. */
  injectOverseer: (message: string) => Promise<void>;
  now?: () => Date;
  setTimer?: (cb: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  /** Called after a successful injection, with the local date that fired. */
  onFire?: (date: string) => void;
  onError?: (err: unknown) => void;
}

export interface EodTimer {
  /** The instant the currently-armed timer is aiming at. */
  nextFire(): Date;
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
 */
export function startEodTimer(deps: EodTimerDeps): EodTimer {
  const now = deps.now ?? (() => new Date());
  const setT = deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
  const clearT = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let target = nextEodFire(now(), deps.timeHHMM, deps.timeZone);
  let handle: TimerHandle | null = null;
  let stopped = false;

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
    void (async () => {
      try {
        await deps.injectOverseer(renderEodPrompt(deps.readPrompt(), date));
        deps.onFire?.(date);
      } catch (err) {
        deps.onError?.(err);
      } finally {
        if (!stopped) {
          target = nextEodFire(now(), deps.timeHHMM, deps.timeZone);
          arm();
        }
      }
    })();
  };

  arm();
  return {
    nextFire: () => target,
    stop: () => {
      stopped = true;
      if (handle !== null) clearT(handle);
    },
  };
}

// The home's spend line: today's and this month's review cost, summed from
// two sources (src/home/ports.ts `SpendPort`):
//
//   the home     the app's detached review runs (`<state home>/review/
//                detached`, the registry the review button starts in): each
//                run that has ended and whose result says what it cost, in
//                the day and month it ended
//   auto-review  the daemon's recorded costs: its status snapshot's
//                `today_spend_usd` and `month_spend_usd`, read from the
//                daemon's own state on this machine's compose stack
//
// Today and this month are UTC days and months, the daemon's own (its
// snapshot, `qcr spend`): the two halves are summed over one calendar.
//
// When either source cannot be read, the total is unknown, with why (invariant
// 9): never a zero, and never the half that could be read passed off as the
// whole. A source that cannot hold a cost is a known zero, as a missing auth
// file is no login: a registry with no runs yet, a machine with no Docker, or
// a stack that was never brought up (no state volume) recorded nothing.
//
// A run still going is not counted until its result says what it cost. A
// review that finished and whose result names no cost is not a free one: its
// cost is not known (a model pi has no price for is stamped at zero, and the
// review then reports no figure), so it is counted beside the sum, as the
// daemon counts its own such rounds (`*_unknown_spend_rounds` in its
// snapshot), and the line says "$X + N rounds unknown". A snapshot from a
// daemon that predates those counts leaves the count itself unknown (null),
// never zero: the line then says the sum alone and claims nothing more.
import { listRunViews } from "../reviewdetach.js";
import type { ProcessRunner } from "../onboard/engine.js";
import { daemonSnapshot } from "./daemonstatus.js";
import { known, unknown, type Known, type SpendPort, type SpendTotals } from "./ports.js";
import { parseRunStatus } from "./reviews.js";

/** One cost, and when it was spent (ms since the epoch). `usd` null: the
 * review finished and what it cost is not known. */
export interface Cost {
  at: number;
  usd: number | null;
}

/** What auto-review recorded for the UTC day and month of the reading: the
 * sum over the rounds that have a price, and how many rounds have tokens and
 * none (null: the snapshot does not say, so the count is unknown). */
export interface AutoSpend {
  today: number;
  month: number;
  todayUnknown: number | null;
  monthUnknown: number | null;
}

/** Auto-review recorded nothing: a measured zero, and no round left out. */
const NOTHING: AutoSpend = { today: 0, month: 0, todayUnknown: 0, monthUnknown: 0 };

export interface SpendSources {
  /** The home's finished runs' costs. */
  home(): Promise<Known<readonly Cost[]>>;
  /** Auto-review's recorded costs for the day and month of `now`. */
  auto(now: number): Promise<Known<AutoSpend>>;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The UTC day (`YYYY-MM-DD`) and month (`YYYY-MM`) of `ms`. */
export function utcPeriod(ms: number): { day: string; month: string } {
  const iso = new Date(ms).toISOString();
  return { day: iso.slice(0, 10), month: iso.slice(0, 7) };
}

async function safe<T>(read: () => Promise<Known<T>>): Promise<Known<T>> {
  try {
    return await read();
  } catch (err) {
    return unknown(message(err));
  }
}

/** The spend port over its two sources: both read, or unknown. */
export function spendPort(src: SpendSources, now: () => number): SpendPort {
  return {
    totals: async (): Promise<Known<SpendTotals>> => {
      const at = now();
      const [home, auto] = await Promise.all([safe(() => src.home()), safe(() => src.auto(at))]);
      if (home.kind === "unknown") return unknown(`the home's reviews: ${home.why}`);
      if (auto.kind === "unknown") return unknown(`auto-review's: ${auto.why}`);
      const { day, month } = utcPeriod(at);
      let today = auto.value.today;
      let thisMonth = auto.value.month;
      let todayUnknown = 0;
      let monthUnknown = 0;
      for (const c of home.value) {
        if (!Number.isFinite(c.at)) continue;
        const p = utcPeriod(c.at);
        if (p.month !== month) continue;
        if (c.usd === null) {
          // A review with no known cost: beside the sum, never $0 inside it.
          monthUnknown++;
          if (p.day === day) todayUnknown++;
          continue;
        }
        if (!Number.isFinite(c.usd)) continue;
        thisMonth += c.usd;
        if (p.day === day) today += c.usd;
      }
      // A count the daemon's snapshot does not carry is unknown, and so is
      // the total over it: null, never the home's half passed off as all.
      const plus = (mine: number, autos: number | null): number | null =>
        autos === null ? null : autos + mine;
      return known({
        today,
        month: thisMonth,
        todayUnknown: plus(todayUnknown, auto.value.todayUnknown),
        monthUnknown: plus(monthUnknown, auto.value.monthUnknown),
      });
    },
  };
}

// ---- the home's half: the detached registry -------------------------------

/** Is the process with this pid alive? */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The costs of every run in the registry at `registry` that has ended, at
 * the time it ended: what its result says it cost, or null for a finished
 * review whose result names no cost (unknown, not free). A run that did not
 * finish a review and names no cost has nothing to add. */
export function registryCosts(
  registry: string,
  o: { now: () => number; alive?: (pid: number) => boolean } = { now: Date.now },
): SpendSources["home"] {
  return async () => {
    let views;
    try {
      views = listRunViews(registry, { alive: o.alive ?? alive, now: o.now });
    } catch (err) {
      return unknown(`can't read the review runs in ${registry}: ${message(err)}`);
    }
    const out: Cost[] = [];
    for (const v of views) {
      const s = parseRunStatus(v.view, v.argv);
      if (s === null || s.state === "running" || s.result === undefined) continue;
      const usd = s.result.costUsd;
      if (usd === null && s.state !== "done") continue;
      out.push({ at: s.endedAt ?? s.startedAt, usd });
    }
    return known(out);
  };
}

// ---- auto-review's half: the daemon's status snapshot ----------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const usd = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
/** A count of rounds, or null when the snapshot does not carry one (an older
 * daemon's): unknown, not zero. */
const count = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;

/** What a status snapshot's text says auto-review spent, for the UTC day and
 * month of `now`. Pure. A snapshot written on an earlier day is the daemon's
 * last word: it has recorded nothing since (it writes one every heartbeat
 * while it runs), so the days after it add nothing. */
export function snapshotSpend(text: string, now: number): Known<AutoSpend> {
  let s: unknown;
  try {
    s = JSON.parse(text);
  } catch {
    return unknown("its status.json is not readable JSON");
  }
  if (!isObj(s)) return unknown("its status.json is not an object");
  const written = typeof s["written_at"] === "string" ? Date.parse(s["written_at"]) : NaN;
  if (!Number.isFinite(written)) return unknown("its status has no time it was written");
  const today = usd(s["today_spend_usd"]);
  const month = usd(s["month_spend_usd"]);
  if (month === null) return unknown("its status has no month's spend (an older daemon)");
  if (today === null) return unknown("its status has no day's spend");
  const at = utcPeriod(written);
  const want = utcPeriod(now);
  if (at.month !== want.month) return known(NOTHING);
  const sameDay = at.day === want.day;
  return known({
    today: sameDay ? today : 0,
    month,
    todayUnknown: sameDay ? count(s["today_unknown_spend_rounds"]) : 0,
    monthUnknown: count(s["month_unknown_spend_rounds"]),
  });
}

export interface ComposeSpendOptions {
  /** The app's root: the compose project directory. */
  root: string;
  runner: ProcessRunner;
}

/** Auto-review's recorded costs on this machine's compose stack: read from
 * the daemon's own status.json while it runs (src/home/daemonstatus.ts). A
 * daemon that is off keeps its costs in its state volume, where the home
 * cannot read them: unknown. */
export function composeAutoSpend(o: ComposeSpendOptions): SpendSources["auto"] {
  return async (now) => {
    const s = await daemonSnapshot(o.runner, o.root);
    if (s.kind === "text") return snapshotSpend(s.text, now);
    if (s.kind === "none") return known(NOTHING);
    if (s.kind === "off")
      return unknown("auto-review is off, and its costs are read from it while it runs");
    return unknown(s.why);
  };
}

/** The spend port as the home's env shim builds it: the install's registry
 * in the state home, and the compose stack at `root` (null: no stack, so
 * auto-review recorded nothing here). */
export function realSpendPort(o: {
  registry: string;
  root: string | null;
  runner: ProcessRunner;
  now?: () => number;
}): SpendPort {
  const now = o.now ?? Date.now;
  return spendPort(
    {
      home: registryCosts(o.registry, { now }),
      auto:
        o.root === null
          ? async () => known(NOTHING)
          : composeAutoSpend({ root: o.root, runner: o.runner }),
    },
    now,
  );
}

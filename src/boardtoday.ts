// The board's `reviewed_today`: how many pull requests the daemon reviewed
// today, on the install's own calendar.
//
// "Today" runs from midnight to midnight in `[ops] timezone`, the one knob
// that says whose calendar day the system runs on (src/config.ts), with the
// 23 h and 25 h days of a clock change exact (`zoneDayBounds`). A pull
// request counts once, however many rounds it had, when a review round of it
// finished in that day: open or closed now, posted to GitHub or recorded in
// dry-run. The count comes from the round store, because the board's lists
// cannot give it (a closed pull request is in none of them).
//
// The daemon makes the count when it writes board.json and writes the day
// beside it (src/boardfile.ts `BoardReviewedToday`), so the export prints it
// only while that day lasts. A count that cannot be made (the store throws,
// the zone is one this runtime does not know, the clock is no instant) is
// undefined: the field is then absent, never zero.
//
// Kept apart from src/boardfile.ts, which the export's reader imports where
// neither the store nor the day arithmetic may load.
import type { BoardReviewedToday } from "./boardfile.js";
import { zoneDayBounds, zonedParts } from "./eod.js";

/** The one question asked of the round store (src/state.ts
 * `prsReviewedSince`). */
export interface ReviewedSource {
  prsReviewedSince(sinceIso: string): number;
}

/**
 * The count for the day of `timeZone` that holds `at`, or undefined when it
 * cannot be made.
 */
export function reviewedToday(
  store: ReviewedSource,
  at: Date,
  timeZone: string,
): BoardReviewedToday | undefined {
  try {
    const now = at.getTime();
    if (!Number.isFinite(now)) return undefined;
    const p = zonedParts(at, timeZone);
    const day = zoneDayBounds(p.year, p.month, p.day, timeZone);
    const since = day.start.getTime();
    const until = day.end.getTime();
    // a day that does not hold its own instant is no reading of the zone
    if (!(since <= now && now < until)) return undefined;
    const count = store.prsReviewedSince(day.start.toISOString());
    if (!Number.isInteger(count) || count < 0) return undefined;
    return { count, since: day.start.toISOString(), until: day.end.toISOString() };
  } catch {
    return undefined;
  }
}

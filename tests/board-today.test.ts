// The board's `reviewed_today` (src/boardtoday.ts, src/state.ts
// `prsReviewedSince`, src/boardfile.ts): how many pull requests had a review
// round finish since midnight on the install's own calendar, counted by the
// daemon from its round store when it writes board.json. Over a real
// in-memory store on a scripted clock (tests/helpers/board-rig.ts). The
// daemon writing it is tests/board-file.test.ts; the export that prints the
// number is tests/board-export.test.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseBoardFile } from "../src/boardfile.js";
import { reviewedToday } from "../src/boardtoday.js";
import { BoardWorld, T0, at } from "./helpers/board-rig.js";
import { closureReachesStateStore } from "./helpers/worker-fences.js";

let w: BoardWorld;
beforeEach(() => {
  w = new BoardWorld();
});
afterEach(() => {
  w.close();
});

/** The board is written at 12:00 UTC on 2026-11-19 (`T0`). */
const UTC_MIDNIGHT = "2026-11-19T00:00:00.000Z";

/** One round on `pr` that finished `s` seconds from the board's write. */
function reviewedAt(pr: number, s: number, verdict = "APPROVE"): number {
  w.tick(s);
  if (w.store.getPr(pr) === undefined) w.pr(pr);
  const id = w.finished(pr, { verdict });
  w.tick(0);
  return id;
}

const count = (timeZone = "UTC"): number | undefined => reviewedToday(w.store, T0, timeZone)?.count;

describe("what counts", () => {
  // MUTATION: count rounds instead of pull requests (COUNT(*) in
  // prsReviewedSince) — the pull request reviewed twice counts twice, and this fails.
  it("each pull request once, however many rounds it had today", () => {
    reviewedAt(1, -7200, "REQUEST_CHANGES");
    reviewedAt(1, -3600);
    reviewedAt(2, -1800);
    expect(count()).toBe(2);
  });

  // MUTATION: count the pull requests of the `reviewed` list — a closed one
  // and a practice one drop out, and this fails.
  it("open or closed, posted or practice", () => {
    // posted to GitHub
    const posted = reviewedAt(1, -5000);
    w.store.db
      .prepare("UPDATE rounds SET posted_event = 'APPROVE', gh_review_id = 9001 WHERE id = ?")
      .run(posted);
    // a practice round: a verdict, and nothing on GitHub
    reviewedAt(2, -4000);
    // reviewed, then closed: in none of the board's lists, and still counted
    reviewedAt(3, -3000);
    w.store.setPrState(3, "closed");
    expect(count()).toBe(3);
    expect(
      w
        .board()
        .reviewed.map((r) => r.number)
        .sort(),
    ).toEqual([1, 2]);
  });

  // MUTATION: count every round that ended, verdict or none — a cancelled
  // round counts as a review, and this fails.
  it("not a round that is still running, one that ended with no verdict, or one imported from history", () => {
    reviewedAt(1, -3000);
    // running
    w.pr(2, { state: "reviewing" });
    w.store.startRound(2, "first", ["pass-baseline"], 45);
    // cancelled: it ended today, and reviewed nothing
    w.pr(3);
    const cancelled = w.store.startRound(3, "first", ["pass-baseline"], 45);
    w.store.db
      .prepare("UPDATE rounds SET status = 'cancelled', finished_at = ? WHERE id = ?")
      .run(at(-60), cancelled);
    // imported from GitHub's history: no round of this daemon's
    const imported = reviewedAt(4, -2000);
    w.store.db.prepare("UPDATE rounds SET backfilled = 1 WHERE id = ?").run(imported);
    expect(count()).toBe(1);
  });

  it("nothing reviewed today is a count of zero, which is a reading", () => {
    expect(reviewedToday(w.store, T0, "UTC")).toEqual({
      count: 0,
      since: UTC_MIDNIGHT,
      until: "2026-11-20T00:00:00.000Z",
    });
    reviewedAt(1, -13 * 3600);
    expect(count()).toBe(0);
  });
});

describe("since local midnight, in the install's own timezone", () => {
  // The board is written at 12:00 UTC: 04:00 in Los Angeles, and 01:00 on
  // the next day in Auckland.
  // MUTATION: take the UTC day whatever the zone says (pass "UTC" to
  // zoneDayBounds) — every zone below counts what UTC counts, and this fails.
  it("the day is the zone's, not UTC's", () => {
    reviewedAt(1, -13 * 3600); // 23:00 UTC the day before
    reviewedAt(2, -5 * 3600); //  07:00 UTC
    reviewedAt(3, -2 * 3600); //  10:00 UTC
    reviewedAt(4, -1800); //      11:30 UTC
    expect(count("UTC")).toBe(3);
    // midnight in Los Angeles was 08:00 UTC
    expect(reviewedToday(w.store, T0, "America/Los_Angeles")).toEqual({
      count: 2,
      since: "2026-11-19T08:00:00.000Z",
      until: "2026-11-20T08:00:00.000Z",
    });
    // midnight in Auckland was 11:00 UTC
    expect(reviewedToday(w.store, T0, "Pacific/Auckland")).toEqual({
      count: 1,
      since: "2026-11-19T11:00:00.000Z",
      until: "2026-11-20T11:00:00.000Z",
    });
  });

  it("a round that finished on the stroke of midnight is today's", () => {
    w.tick(-12 * 3600);
    w.pr(1);
    w.finished(1, { verdict: "APPROVE" });
    w.tick(0);
    expect(w.store.roundsFor(1)[0]!.finished_at).toBe(UTC_MIDNIGHT);
    expect(count()).toBe(1);
    expect(w.store.prsReviewedSince("2026-11-19T00:00:00.001Z")).toBe(0);
  });

  it("a day with a clock change is as long as it is", () => {
    // the United States end daylight time on 2026-11-01: a 25-hour day
    const day = reviewedToday(w.store, new Date("2026-11-01T18:00:00Z"), "America/New_York")!;
    expect(day.since).toBe("2026-11-01T04:00:00.000Z");
    expect(day.until).toBe("2026-11-02T05:00:00.000Z");
  });
});

describe("absent, never zero, when it cannot be counted", () => {
  // MUTATION: return { count: 0 } where the store throws or the zone is
  // unknown — a daemon that cannot count says nobody was reviewed, and this fails.
  it("a store that cannot be read, a zone this runtime does not know, a clock that is no instant", () => {
    reviewedAt(1, -3600);
    const broken = {
      prsReviewedSince: (): number => {
        throw new Error("database is locked");
      },
    };
    expect(reviewedToday(broken, T0, "UTC")).toBeUndefined();
    expect(reviewedToday(w.store, T0, "Mars/Olympus_Mons")).toBeUndefined();
    expect(reviewedToday(w.store, new Date("not a time"), "UTC")).toBeUndefined();
    for (const junk of [-1, 1.5, Number.NaN])
      expect(reviewedToday({ prsReviewedSince: () => junk }, T0, "UTC")).toBeUndefined();
    // the same store and zone, readable: a number
    expect(count()).toBe(1);
  });

  it("the board carries the count with its day, or carries none", () => {
    reviewedAt(1, -3600);
    const today = reviewedToday(w.store, T0, "UTC")!;
    const withCount = w.board(undefined, today);
    expect(withCount.reviewed_today).toEqual({
      count: 1,
      since: UTC_MIDNIGHT,
      until: "2026-11-20T00:00:00.000Z",
    });
    expect(parseBoardFile(JSON.stringify(withCount))).toEqual(withCount);
    // the daemon could not count: no key at all, and none read back
    const without = w.board();
    expect("reviewed_today" in without).toBe(false);
    expect("reviewed_today" in parseBoardFile(JSON.stringify(without))!).toBe(false);
  });

  // MUTATION: read `count` alone in readReviewedToday — a count with no day
  // is printed as today's for ever, and this fails.
  it("a reader takes the count only whole: a number, and the day it is the count of", () => {
    const read = (reviewed_today: unknown): unknown =>
      parseBoardFile(JSON.stringify({ ...w.board(), reviewed_today }))?.reviewed_today;
    const day = { since: UTC_MIDNIGHT, until: "2026-11-20T00:00:00.000Z" };
    expect(read({ count: 3, ...day })).toEqual({ count: 3, ...day });
    expect(read({ count: 0, ...day })).toEqual({ count: 0, ...day });
    for (const broken of [
      3,
      { count: 3 },
      { count: 3, since: day.since },
      { count: -1, ...day },
      { count: "3", ...day },
      { count: 2.5, ...day },
      { count: 3, since: day.until, until: day.since },
      { count: 3, since: "yesterday", until: "tomorrow" },
      null,
    ])
      expect(read(broken), JSON.stringify(broken)).toBeUndefined();
  });

  // The count is the daemon's to make: the export's reader must not load the
  // day arithmetic, which reaches modules it has no business loading.
  it("the export's reader does not import the counter", () => {
    const root = join(import.meta.dirname, "..");
    const boardfile = readFileSync(join(root, "src", "boardfile.ts"), "utf8");
    // a type is erased; a value import would load the module
    expect(boardfile).not.toMatch(/^import \{[^}]*\} from "\.\/(?:boardtoday|eod)\.js"/m);
    expect(closureReachesStateStore(root, ["src/boardexport.ts"])).toEqual([]);
  });
});

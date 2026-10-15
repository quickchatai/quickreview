// Digest support: the EOD sweep writes digest/<date>.md; the daemon lifts its
// headline into state/status.json (the status collector's pickup surface).
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandboxRoot } from "./config.js";
import { zoneDayBounds } from "./eod.js";
import {
  cancelCauseLabel,
  tallyCancellations,
  type CancellationTally,
  type StateStore,
} from "./state.js";

export const HEADLINE_MAX = 200;

export function defaultDigestDir(): string {
  return join(sandboxRoot(), "digest");
}

/** Write digest/<date>.md. Returns the path written. */
export function writeDigest(
  date: string,
  content: string,
  digestDir: string = defaultDigestDir(),
): string {
  mkdirSync(digestDir, { recursive: true });
  const path = digestPath(date, digestDir);
  writeFileSync(path, content.endsWith("\n") ? content : `${content}\n`);
  return path;
}

/** Has the day's digest been written — the exact file `writeDigest` and the
 * EOD sweep (`digest/{{date}}.md`, cwd = the sandbox root) produce. */
export function digestWritten(date: string, digestDir: string = defaultDigestDir()): boolean {
  return existsSync(digestPath(date, digestDir));
}

/** digest/<date>.md — the one spelling of a day's digest file. */
function digestPath(date: string, digestDir: string): string {
  return join(digestDir, `${date}.md`);
}

/** First non-empty, non-heading line, trimmed and truncated to 200 chars. */
export function digestHeadline(content: string): string | undefined {
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) continue;
    if (/^[-=]{3,}$/.test(line)) continue; // setext underline / rule
    return line.length > HEADLINE_MAX ? line.slice(0, HEADLINE_MAX) : line;
  }
  return undefined;
}

/** Newest digest/<date>.md file name (lexicographic == chronological). */
export function latestDigestFile(digestDir: string = defaultDigestDir()): string | undefined {
  if (!existsSync(digestDir)) return undefined;
  const files = readdirSync(digestDir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .sort();
  const last = files[files.length - 1];
  return last === undefined ? undefined : join(digestDir, last);
}

/** Headline of the most recent digest — what the daemon copies into status.json. */
export function latestDigestHeadline(digestDir: string = defaultDigestDir()): string | undefined {
  const path = latestDigestFile(digestDir);
  if (!path) return undefined;
  try {
    return digestHeadline(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

// ---- daily usage summary ---------------------------------------------------

export interface DailyUsage {
  date: string;
  rounds: number;
  tokens_in: number;
  tokens_out: number;
  /** est_usd is the one spend field (legacy spend_usd folded in). */
  est_usd: number;
}

/**
 * Aggregate one day's measured usage from the rounds table.
 *
 * Expired rounds are included: a round that blew its deadline still burned
 * its tokens, and leaving it out would under-report the day's real cost —
 * see `StateStore.totalSpend`.
 */
export function dailyUsage(store: StateStore, date: string): DailyUsage {
  const rounds = store.roundsOn(date);
  return {
    date,
    rounds: rounds.length,
    tokens_in: rounds.reduce((n, r) => n + (r.tokens_in ?? 0), 0),
    tokens_out: rounds.reduce((n, r) => n + (r.tokens_out ?? 0), 0),
    est_usd: rounds.reduce((n, r) => n + (r.est_usd ?? 0), 0),
  };
}

/** One digest-ready line, e.g. "usage: 3 rounds — 120000 in / 4000 out tokens — est $1.23". */
export function usageSummaryLine(usage: DailyUsage): string {
  return `usage: ${usage.rounds} rounds — ${usage.tokens_in} in / ${usage.tokens_out} out tokens — est $${usage.est_usd.toFixed(2)}`;
}

// ---- cancellations ---------------------------------------------------------

export interface DailyCancellations {
  date: string;
  total: number;
  /** The subset a human should act on — `LOUD_CANCEL_CAUSES`. */
  loud: number;
  by_cause: CancellationTally[];
}

/**
 * One day's cancelled rounds, grouped by cause.
 *
 * The digest is where a day's shape is written down, so cancellations belong
 * in it. Grouping is the whole point: most of the volume is the boot orphan
 * sweep after a redeploy, and a total that lumps it in with a round that
 * stopped dead says nothing.
 */
export function dailyCancellations(
  store: StateStore,
  date: string,
  /** Read `date` as a calendar day in this zone (the EOD timer's). Absent ⇒
   * the UTC date prefix, as every other `roundsOn` reader does. */
  timeZone?: string,
): DailyCancellations {
  const byCause = tallyCancellations(roundsOnDay(store, date, timeZone));
  return {
    date,
    total: byCause.reduce((n, c) => n + c.count, 0),
    loud: byCause.filter((c) => c.loud).reduce((n, c) => n + c.count, 0),
    by_cause: byCause,
  };
}

/** The rounds started on `date` — a zone-local calendar day when `timeZone`
 * is given (midnight to midnight on that zone's wall clock, DST-correct). */
function roundsOnDay(store: StateStore, date: string, timeZone?: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!timeZone || !m) return store.roundsOn(date);
  const { start, end } = zoneDayBounds(Number(m[1]), Number(m[2]), Number(m[3]), timeZone);
  return store.roundsStartedBetween(start.toISOString(), end.toISOString());
}

/**
 * One digest-ready line, e.g.
 * "cancelled: 4 rounds — stopped dead 1 ⚑, orphan sweep (redeploy) 3".
 * A quiet day says so explicitly: "cancelled: none" is a fact, and a missing
 * line would read as "not measured".
 */
export function cancellationSummaryLine(c: DailyCancellations): string {
  if (c.total === 0) return "cancelled: none";
  const parts = c.by_cause.map(
    (b) => `${cancelCauseLabel(b.cause)} ${b.count}${b.loud ? " ⚑" : ""}`,
  );
  return `cancelled: ${c.total} round${c.total === 1 ? "" : "s"} — ${parts.join(", ")}${
    c.loud > 0
      ? ` (${c.loud} stopped dead — worth a look; the orphan sweep is a redeploy artefact and is not)`
      : ""
  }`;
}

/**
 * Daemon-measured context appended to the EOD sweep prompt.
 *
 * The digest itself is written by the sweep's pi session from a frozen seed
 * prompt the daemon may not edit, so the only render the daemon owns is the
 * injected prompt, and the cancellation line rides it.
 */
export function eodDigestContext(store: StateStore, date: string, timeZone?: string): string {
  // The EOD timer names a ZONE-LOCAL date; `timeZone` makes the selection
  // window that same day, not the UTC date prefix.
  return cancellationSummaryLine(dailyCancellations(store, date, timeZone));
}

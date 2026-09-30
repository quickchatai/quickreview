// The COVERAGE LEDGER (spec "Ledger", item 5): what the
// scan has read — one row per file + content hash + lens, with the tier,
// effort, validator setting, scan sha and cost it was read at. Two jobs:
//
//   * the RESUME GRAIN — stage 1 never re-reads a file whose NEWEST ledger
//     row for the lens is at the same content hash, so an interrupted scan (a TUI
//     quit, an expired login, a stop, the hard stop) continues where it
//     stopped and a finished one costs nothing to start again;
//   * the PRICE — after the first-scan calibration run, every cost preview is
//     measured from these rows' actual costs, never from a constant.
//
// A file too big for one case is read in LINE RANGES (scan.ts cutRanges):
// one row per range, carrying it, so a file is covered only when the ranges
// of its newest reading cover every line — a run cut short between ranges
// leaves the rest to read, and changed content re-reads every range.
//
// A row is written only when its case FINISHED — a case cut short leaves no
// row, so it is read again in full. A case's cost is apportioned over its
// files by lines; a case the runner could not price writes null costs, which
// the rate ignores (it never reads as free).
//
// Persistence: `<state home>/scan/ledger.json`, tmp+rename atomic through the
// state port. An unreadable ledger is REPORTED and refuses writes: it is the
// record of money already spent, and starting over on top of it would pay
// for the same files twice.
import type { StateFs } from "./engine.js";
import { coverKey, rangesCover, type FileRange, type ScanRate } from "./scan.js";

export const LEDGER_FILE = "scan/ledger.json";
export const LEDGER_VERSION = 1;

export interface LedgerEntry {
  path: string;
  /** The file's git blob hash at `sha`. */
  blob: string;
  lens: string;
  /** The line range this row read, when the file was cut into ranges;
   * absent (or null) = the whole file. Part of the row's identity. */
  range?: FileRange | null;
  tier: string;
  effort: string;
  /** Whether the validator ran over the case (it is part of the price). */
  validator: boolean;
  sha: string;
  /** Lines read: the file's, or its range's. */
  lines: number;
  /** This file's share of its case's cost; null when the runner reported
   * none. */
  cost_usd: number | null;
  run: string;
  /** The case, within the run (`<unit>` or `<unit>#<i>`). */
  case: string;
  at: string;
}

/** What a price is measured over: the same lens at the same settings. */
export interface RateKey {
  lens: string;
  tier: string;
  effort: string;
  validator: boolean;
}

export interface LedgerFile {
  version: number;
  entries: LedgerEntry[];
}

const entryKey = (e: Pick<LedgerEntry, "path" | "blob" | "lens" | "range">): string =>
  `${e.lens}\0${coverKey(e.path, e.blob)}${e.range ? `\0${e.range.start}-${e.range.end}` : ""}`;

export class Ledger {
  constructor(private readonly state: StateFs) {}

  /** The ledger, or why it cannot be read (then `entries` is empty and
   * UNKNOWN, not absent). */
  load(): { entries: LedgerEntry[]; error: string | null } {
    let text: string | null;
    try {
      text = this.state.read(LEDGER_FILE);
    } catch (err) {
      return { entries: [], error: `${LEDGER_FILE} in ${this.state.location} cannot be read: ${String(err)}` };
    }
    if (text === null) return { entries: [], error: null };
    try {
      const raw = JSON.parse(text) as Partial<LedgerFile> | null;
      if (typeof raw !== "object" || raw === null || raw.version !== LEDGER_VERSION || !Array.isArray(raw.entries)) {
        throw new Error("not a version-1 ledger");
      }
      for (const e of raw.entries) {
        if (typeof e?.path !== "string" || typeof e.blob !== "string" || typeof e.lens !== "string") {
          throw new Error("an entry has no path, blob or lens");
        }
      }
      return { entries: raw.entries, error: null };
    } catch (err) {
      return {
        entries: [],
        error:
          `${LEDGER_FILE} in ${this.state.location} is not a coverage ledger this version reads (${String(err)}) — ` +
          "nothing will overwrite it; move it aside to start the ledger over",
      };
    }
  }

  /** Add (or replace, by file + content hash + lens) finished rows. Throws
   * when the stored ledger cannot be read — never writes over it. */
  record(rows: readonly LedgerEntry[]): void {
    const { entries, error } = this.load();
    if (error !== null) throw new Error(error);
    const byKey = new Map(entries.map((e) => [entryKey(e), e]));
    for (const r of rows) byKey.set(entryKey(r), r);
    const file: LedgerFile = { version: LEDGER_VERSION, entries: [...byKey.values()] };
    this.state.write(LEDGER_FILE, `${JSON.stringify(file)}\n`);
  }
}

/** `path\0blob` of each file's NEWEST reading by `lens` — the same newest
 * row `FindingsStore.reconcile` settles findings against. An older reading a
 * later one superseded covers nothing: its findings may since have been
 * settled `fixed`, so content that comes back to it (a revert) must be read
 * again for them to come back too. */
export function coveredBy(entries: readonly LedgerEntry[], lens: string): Set<string> {
  const out = new Set<string>();
  for (const [path, r] of readings(entries, lens)) if (r.complete) out.add(coverKey(path, r.blob));
  return out;
}

/** A file's newest reading by one lens: the rows at its newest content,
 * back to the last row at other content (an older reading of the same
 * content, superseded since, is not part of it). */
export interface Reading {
  blob: string;
  /** The newest row of the reading. */
  newest: LedgerEntry;
  /** Whole file, or ranges covering every line. */
  complete: boolean;
  /** The ranges read so far (empty when a whole-file row stands). */
  ranges: FileRange[];
}

/** Every path's newest reading by `lens`. */
export function readings(entries: readonly LedgerEntry[], lens: string): Map<string, Reading> {
  const byPath = new Map<string, LedgerEntry[]>();
  for (const e of entries) {
    if (e.lens !== lens) continue;
    const rows = byPath.get(e.path);
    if (rows) rows.push(e);
    else byPath.set(e.path, [e]);
  }
  const out = new Map<string, Reading>();
  for (const [path, rows] of byPath) {
    // Stable by time: equal stamps keep ledger order, as `newestRead` does.
    const sorted = rows.map((e, i) => ({ e, i })).sort((a, b) => (a.e.at < b.e.at ? -1 : a.e.at > b.e.at ? 1 : a.i - b.i));
    const newest = sorted[sorted.length - 1]!.e;
    const streak: LedgerEntry[] = [];
    for (let k = sorted.length - 1; k >= 0 && sorted[k]!.e.blob === newest.blob; k--) streak.push(sorted[k]!.e);
    const whole = streak.some((e) => !e.range);
    const ranges = streak.filter((e) => e.range).map((e) => e.range!);
    const total = ranges[0]?.total ?? 0;
    out.set(path, { blob: newest.blob, newest, complete: whole || (ranges.length > 0 && rangesCover(ranges, 1, total)), ranges: whole ? [] : ranges });
  }
  return out;
}

/** `path\0blob` → the ranges of each newest reading by `lens` that is not
 * yet complete: the ranges a plan need not read again. */
export function partialRanges(entries: readonly LedgerEntry[], lens: string): Map<string, FileRange[]> {
  const out = new Map<string, FileRange[]>();
  for (const [path, r] of readings(entries, lens)) if (!r.complete && r.ranges.length > 0) out.set(coverKey(path, r.blob), r.ranges);
  return out;
}

/** Rows written for `key` at all, and how many of their cases were priced —
 * which is how a preview tells "never calibrated" from "calibrated, but the
 * runner reports no cost". */
export function casesFor(entries: readonly LedgerEntry[], key: RateKey): { cases: number; priced: number } {
  const cases = new Map<string, boolean>();
  for (const e of entries) {
    if (e.lens !== key.lens || e.tier !== key.tier || e.effort !== key.effort || e.validator !== key.validator) continue;
    const id = `${e.run}\0${e.case}`;
    cases.set(id, (cases.get(id) ?? false) || e.cost_usd !== null);
  }
  return { cases: cases.size, priced: [...cases.values()].filter(Boolean).length };
}

/** The measured price for `key`: every priced row's cost over its lines, or
 * null when no priced case has finished at these settings. */
export function measuredRate(entries: readonly LedgerEntry[], key: RateKey): ScanRate | null {
  return rateWhere(
    entries,
    (e) => e.lens === key.lens && e.tier === key.tier && e.effort === key.effort && e.validator === key.validator,
  );
}

/** The measured price over the priced rows `keep` selects (stage 2 borrows
 * another lens's price at the same settings this way), or null when none. */
export function rateWhere(entries: readonly LedgerEntry[], keep: (e: LedgerEntry) => boolean): ScanRate | null {
  let cost = 0;
  let lines = 0;
  const cases = new Set<string>();
  for (const e of entries) {
    if (!keep(e) || e.cost_usd === null) continue;
    cost += e.cost_usd;
    // The file's REAL lines — the count the preview showed. An empty file
    // (an `__init__.py`) is 0 here as there; `Math.max(lines, 1)` belongs to
    // splitting a case's cost across its rows, never to the rate's basis.
    lines += e.lines;
    cases.add(`${e.run}\0${e.case}`);
  }
  if (cases.size === 0 || lines === 0) return null;
  return { usd_per_kline: (cost / lines) * 1000, cases: cases.size, lines, cost_usd: cost };
}

// ---- the delta's basis --------------------------------------------------

/** Each path's NEWEST content hash read by `lens` — the reading findings
 * are settled against. A path whose content is not that one has CHANGED
 * since it was scanned, even when an older, superseded reading saw exactly
 * this content (a revert): that reading's findings may since be `fixed`. */
export function newestRead(entries: readonly LedgerEntry[], lens: string): Map<string, string> {
  const newest = new Map<string, LedgerEntry>();
  for (const e of entries) {
    if (e.lens !== lens) continue;
    const had = newest.get(e.path);
    if (!had || e.at >= had.at) newest.set(e.path, e);
  }
  return new Map([...newest].map(([path, e]) => [path, e.blob]));
}

/** The sha of the LAST scan by `lens` — its newest row's — or null when the
 * ledger holds none: what a delta re-scan compares the tree against. */
export function lastScanned(entries: readonly LedgerEntry[], lens: string): { sha: string; at: string; run: string } | null {
  let last: LedgerEntry | null = null;
  for (const e of entries) if (e.lens === lens && (last === null || e.at >= last.at)) last = e;
  return last === null ? null : { sha: last.sha, at: last.at, run: last.run };
}

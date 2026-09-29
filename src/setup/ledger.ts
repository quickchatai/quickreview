// The COVERAGE LEDGER (spec "Ledger", item 5): what the
// scan has read — one row per file + content hash + lens, with the tier,
// effort, validator setting, scan sha and cost it was read at. Two jobs:
//
//   * the RESUME GRAIN — stage 1 never re-reads a file the ledger holds at
//     the same content hash for the same lens, so an interrupted scan (a TUI
//     quit, an expired login, a stop, the hard stop) continues where it
//     stopped and a finished one costs nothing to start again;
//   * the PRICE — after the first-scan calibration run, every cost preview is
//     measured from these rows' actual costs, never from a constant.
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
import { coverKey, type ScanRate } from "./scan.js";

export const LEDGER_FILE = "scan/ledger.json";
export const LEDGER_VERSION = 1;

export interface LedgerEntry {
  path: string;
  /** The file's git blob hash at `sha`. */
  blob: string;
  lens: string;
  tier: string;
  effort: string;
  /** Whether the validator ran over the case (it is part of the price). */
  validator: boolean;
  sha: string;
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

const entryKey = (e: Pick<LedgerEntry, "path" | "blob" | "lens">): string => `${e.lens}\0${coverKey(e.path, e.blob)}`;

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

/** `path\0blob` of every file the ledger holds for `lens`. */
export function coveredBy(entries: readonly LedgerEntry[], lens: string): Set<string> {
  return new Set(entries.filter((e) => e.lens === lens).map((e) => coverKey(e.path, e.blob)));
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

/** Every content hash the ledger holds per path for `lens` — a path read at
 * none of them now has CHANGED since it was scanned. */
export function blobsRead(entries: readonly LedgerEntry[], lens: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const e of entries) {
    if (e.lens !== lens) continue;
    const s = out.get(e.path) ?? new Set<string>();
    s.add(e.blob);
    out.set(e.path, s);
  }
  return out;
}

/** The sha of the LAST scan by `lens` — its newest row's — or null when the
 * ledger holds none: what a delta re-scan compares the tree against. */
export function lastScanned(entries: readonly LedgerEntry[], lens: string): { sha: string; at: string; run: string } | null {
  let last: LedgerEntry | null = null;
  for (const e of entries) if (e.lens === lens && (last === null || e.at >= last.at)) last = e;
  return last === null ? null : { sha: last.sha, at: last.at, run: last.run };
}

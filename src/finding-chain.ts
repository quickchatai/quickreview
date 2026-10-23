import { storedLensIds } from "./lensids.js";
import type { RoundFindingRow } from "./storerows.js";

/** A finding continuation address; the key may itself contain colons. */
export function carriedToRef(roundNo: number, findingKey: string): string {
  return `${roundNo}:${findingKey}`;
}

export interface CarriedFinding {
  round_no: number;
  finding_key: string;
  carried_to: string | null;
}

/** Follow known links once, ending at a missing target or a cycle. */
export function walkFindingChain<T extends CarriedFinding>(rows: readonly T[], root: T): T[] {
  const byKey = new Map(rows.map((row) => [carriedToRef(row.round_no, row.finding_key), row]));
  const seen = new Set<string>();
  const chain: T[] = [];
  let row: T | undefined = root;
  while (row) {
    const key = carriedToRef(row.round_no, row.finding_key);
    if (seen.has(key)) break;
    seen.add(key);
    chain.push(row);
    row = row.carried_to ? byKey.get(row.carried_to) : undefined;
  }
  return chain;
}

/** Every unpointed root and its last known continuation. */
export function findingChains<T extends CarriedFinding>(
  rows: readonly T[],
): Array<{ root: T; end: T }> {
  const pointed = new Set(rows.map((row) => row.carried_to).filter((ref): ref is string => !!ref));
  return rows
    .filter((row) => !pointed.has(carriedToRef(row.round_no, row.finding_key)))
    .map((root) => ({ root, end: walkFindingChain(rows, root).at(-1)! }));
}

/** Was this row posted on the PR? `posted` with a tag — a downgraded, killed,
 * doubted or withheld entry never reached the author as itself. */
export function isPostedRow(r: RoundFindingRow): boolean {
  return r.disposition === "posted" && r.posted_as !== null && r.posted_as.trim() !== "";
}

/** How far a later round's entry may sit from a finding's line and still be
 * that finding (lines move as the branch moves). */
export const CONTINUATION_LINES = 10;

function lensIdsOf(row: RoundFindingRow): string[] {
  return storedLensIds(row.lens_ids) ?? [];
}

/**
 * Which entry of the round `e` names in `raised_in_round` is `e` again? Only
 * an entry on the same path, sharing a lens, within `CONTINUATION_LINES`:
 * the one carrying `e`'s key when it is such an entry, else the single
 * nearest such entry (a file-level line counts as the farthest near one). A
 * tie is nobody's: two findings a few lines apart in one file and one lens
 * must not both inherit one entry's fate. Returns the owner's key, or null.
 *
 * An equal key ALONE is no match: sessions number their keys per round (f1,
 * f2, …), so a later round's `f1` is usually a different finding; a key-only
 * match would carry one finding's fate onto another far away in the file.
 */
export function predecessorOf(
  round: readonly RoundFindingRow[],
  e: RoundFindingRow,
): string | null {
  const dist = (s: RoundFindingRow) =>
    s.line === null || e.line === null ? CONTINUATION_LINES : Math.abs(s.line - e.line);
  const candidates = round.filter((s) => sameSite(s, e));
  const keyed = candidates.find((s) => s.finding_key === e.finding_key);
  if (keyed) return keyed.finding_key;
  if (candidates.length === 0) return null;
  const best = Math.min(...candidates.map(dist));
  const nearest = candidates.filter((s) => dist(s) === best);
  return nearest.length === 1 ? nearest[0]!.finding_key : null;
}

/** Could `b` be `a` again? The same path, a shared lens, within
 * `CONTINUATION_LINES` (an entry without a line is near). The one eligibility
 * rule of predecessor ownership and of the weak next-round match; who wins
 * among the eligible is each caller's own rule. */
export function sameSite(a: RoundFindingRow, b: RoundFindingRow): boolean {
  if (!a.path || a.path !== b.path) return false;
  if (a.line !== null && b.line !== null && Math.abs(a.line - b.line) > CONTINUATION_LINES)
    return false;
  const ids = lensIdsOf(a);
  return lensIdsOf(b).some((id) => ids.includes(id));
}

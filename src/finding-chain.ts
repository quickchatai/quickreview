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

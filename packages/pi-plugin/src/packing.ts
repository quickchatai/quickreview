/** Greedy file groups in input order. An oversized file keeps its own group;
 * files beyond the group cap are returned in left, never discarded. */
export function packByBudget<T>(
  files: readonly T[],
  limits: { maxGroups: number; maxLines: number; maxFiles?: number },
  pathOf: (file: T) => string,
  sizeOf: (file: T) => number,
): { groups: string[][]; left: string[] } {
  const groups: string[][] = [];
  const left: string[] = [];
  let current: string[] = [];
  let lines = 0;
  for (const file of files) {
    const size = sizeOf(file);
    if (
      current.length > 0 &&
      (current.length >= (limits.maxFiles ?? Infinity) || lines + size > limits.maxLines)
    ) {
      groups.push(current);
      current = [];
      lines = 0;
    }
    if (groups.length >= limits.maxGroups) {
      left.push(pathOf(file));
      continue;
    }
    current.push(pathOf(file));
    lines += size;
  }
  if (current.length > 0) {
    if (groups.length < limits.maxGroups) groups.push(current);
    else left.push(...current);
  }
  return { groups, left };
}

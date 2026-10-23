// The one severity order. A leaf with no imports, so a module that must stay
// off the verdict vocabulary (src/escalation.ts) can read it too.

/** Every severity, highest first — the one vocabulary the severity type and
 * the rank derive from. */
export const SEVERITIES = ["P0", "P1", "P2", "P3", "nit"] as const;

const SEVERITY_ORDER: Readonly<Record<string, number>> = Object.fromEntries(
  SEVERITIES.map((s, i) => [s.toUpperCase(), i]),
);

/** A severity's place in the one order, P0 (0) … nit (4), read without regard
 * to case or surrounding space; undefined for a spelling outside the scale —
 * each caller decides what an unreadable severity means to it. */
export function severityRank(raw: string | null | undefined): number | undefined {
  if (typeof raw !== "string") return undefined;
  const key = raw.trim().toUpperCase();
  return Object.hasOwn(SEVERITY_ORDER, key) ? SEVERITY_ORDER[key] : undefined;
}

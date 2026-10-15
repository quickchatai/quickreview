// Canonical lens ids for a recorded finding.
//
// `round_findings.lens` is whatever the session wrote, which yields many
// spellings per lens: `pass-baseline`, but also
// `pass-baseline + pass-sweep (2 lenses)`, `pass-baseline,pass-claims`,
// `pass-baseline/pass-ui`, `pass-style+pass-baseline` — a finding several
// lenses converged on — and a few that are no lens at all (`recheck`,
// `review session`). A per-lens count over the raw column splits one lens
// across dozens of rows. This parses the column into the ids of the lenses
// the system knows (`ALL_PASSES`, plus the validator), in the order written,
// each once. The raw spelling stays in `lens`; nothing is rewritten.
//
// A token that names no known lens is left out — never guessed onto one. An
// entry raised outside any lens (the recheck, the main session) reads `[]`.
import { ALL_PASSES } from "./passes.js";

const VALIDATOR = "pass-validate";
const KNOWN: ReadonlySet<string> = new Set([...ALL_PASSES, VALIDATOR]);

/** The known lens ids a recorded `lens` value names, in written order. */
export function canonicalLensIds(raw: string | null | undefined): string[] {
  if (typeof raw !== "string") return [];
  const ids: string[] = [];
  const cleaned = raw
    .toLowerCase()
    // "(2 lenses)", "(G1)" — a note, never a lens
    .replace(/\([^)]*\)/g, " ");
  for (const part of cleaned.split(/[+,/&;|]|\band\b/)) {
    // "pass-sweep:G1", "pass-sweep#2", "pass-sweep @ a.ts" — the lens is the
    // first word; what follows names a group or a site.
    const token = part.trim().split(/[\s:#@]+/)[0] ?? "";
    if (!token) continue;
    const id = KNOWN.has(token) ? token : KNOWN.has(`pass-${token}`) ? `pass-${token}` : null;
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** The `round_findings.lens_ids` column as stored — a JSON array of the ids
 * `canonicalLensIds` parsed, its non-string elements dropped — or null when
 * the column is empty or not such an array (each reader picks its own
 * fallback). */
export function storedLensIds(column: string | null | undefined): string[] | null {
  if (!column) return null;
  try {
    const parsed = JSON.parse(column) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : null;
  } catch {
    return null;
  }
}

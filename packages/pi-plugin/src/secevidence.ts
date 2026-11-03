// A security candidate's outcome, computed from the validator's labels.
//
// The validator labels each hop of an exploit chain `valid`, `plausible` or
// `contradicted` (the `validate-sec-evidence` addendum in
// packages/pi-plugin/src/include.ts) and writes the outcome beside them. The
// outcome is a fixed function of the labels, so the code recomputes it here
// and the findings record counts a mismatch
// (packages/pi-plugin/src/findingsrecord.ts `security_outcome_mismatch`) —
// the prompt states the table, this module is the table:
//
//   | hop labels                                  | outcome         |
//   |---------------------------------------------|-----------------|
//   | every hop valid                             | confirmed       |
//   | exactly one plausible, none contradicted    | question        |
//   | two or more plausible, none contradicted    | partial-chain   |
//   | any hop contradicted                        | refuted         |
//
// `partial-chain` is a doubt, never a post: the posting policy withholds one
// whatever the profile says (packages/pi-plugin/src/postingpolicy.ts
// `selectPosted`). `excluded` is a lens's outcome, never a label's: no set of
// labels computes it.
//
// A leaf on purpose — no imports — so the record parser, the posting policy
// and the renderer all read one table.

/** A validator's label for one line of an evidence block or one hop of a
 * chain. */
export const HOP_LABELS = ["valid", "plausible", "contradicted"] as const;
export type HopLabel = (typeof HOP_LABELS)[number];

/** Every outcome a security candidate can end with. */
export const SECURITY_OUTCOMES = [
  "confirmed",
  "question",
  "partial-chain",
  "refuted",
  "excluded",
] as const;
export type SecurityOutcome = (typeof SECURITY_OUTCOMES)[number];

/** Spellings a session plausibly writes, folded onto the closed set. */
const OUTCOME_ALIASES: Readonly<Record<string, SecurityOutcome>> = {
  survives: "confirmed",
  survived: "confirmed",
  plausible: "question",
  partial: "partial-chain",
  partial_chain: "partial-chain",
  contradicted: "refuted",
};

/** A hop label as the closed set, or null for anything else. */
export function normalizeHopLabel(raw: unknown): HopLabel | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  return (HOP_LABELS as readonly string[]).includes(v) ? (v as HopLabel) : null;
}

/** A written `security_outcome` as the closed set, or null for anything
 * else — tolerant input, never a rejection. */
export function normalizeSecurityOutcome(raw: unknown): SecurityOutcome | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase().replace(/\s+/g, "-");
  if ((SECURITY_OUTCOMES as readonly string[]).includes(v)) return v as SecurityOutcome;
  return OUTCOME_ALIASES[v] ?? null;
}

/**
 * The outcome a chain's hop labels compute, by the table in the module
 * header. `unknown` when there are no labels or one is outside the closed
 * set: a label this cannot read is never a hop that held.
 */
export function securityOutcome(
  hopLabels: readonly string[],
): Exclude<SecurityOutcome, "excluded"> | "unknown" {
  if (hopLabels.length === 0) return "unknown";
  const labels = hopLabels.map(normalizeHopLabel);
  if (labels.some((l) => l === null)) return "unknown";
  if (labels.includes("contradicted")) return "refuted";
  const plausible = labels.filter((l) => l === "plausible").length;
  if (plausible === 0) return "confirmed";
  return plausible === 1 ? "question" : "partial-chain";
}

/** The `hop_labels` a record entry carries, as written: an array of strings,
 * or one string separated by commas. Trimmed and lower-cased; null when the
 * entry carries none. Labels outside the closed set are kept, so
 * `securityOutcome` reads them as `unknown` rather than losing a hop. */
export function readHopLabels(raw: unknown): string[] | null {
  const parts = Array.isArray(raw)
    ? raw.filter((x): x is string => typeof x === "string")
    : typeof raw === "string"
      ? raw.replace(/^\[|\]$/g, "").split(",")
      : null;
  if (parts === null) return null;
  const labels = parts.map((p) => p.trim().toLowerCase()).filter((p) => p !== "");
  return labels.length > 0 ? labels : null;
}

/**
 * Is this a partial chain — an exploit chain with more than one unproven
 * hop? Its `kind` begins `partial-chain`, its word is `partial-chain`, or
 * its outcome is. A partial chain is stored for the next round's `delta`
 * strategy and never posted.
 */
export function isPartialChain(e: {
  kind?: string | null;
  word?: string | null;
  security_outcome?: string | null;
}): boolean {
  const kind = (e.kind ?? "").trim().toLowerCase();
  if (/^partial-chain(?![a-z0-9])/.test(kind)) return true;
  if ((e.word ?? "").trim().toLowerCase() === "partial-chain") return true;
  return normalizeSecurityOutcome(e.security_outcome) === "partial-chain";
}

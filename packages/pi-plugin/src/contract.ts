// The versioned JSON contract of `qcr review --json` and `qcr scan --json`.
//
// Plugins and agents call qcr as a headless black box and read what it prints.
// Every `--json` payload leads with `schema_version`, so a caller can refuse a
// version it does not know before it reads another field. The versions move
// independently: schemas/review-result.v<N>.json describes the review verbs
// (`qcr review`, `start`, `status`, `stop`), schemas/scan-result.v<N>.json the
// scan verbs. Adding a field keeps the version; renaming, removing or
// re-typing one bumps it, and the old schema file stays beside the new one.
//
// A host plugin asks for its whole set at once: `qcr --schema N <verb>`
// (src/schemaflag.ts) names a contract, one fixed version per family, listed
// in CONTRACTS. Bumping a family version means a new contract number; the old
// contract keeps working for as long as its family versions are still printed,
// and a contract is never redefined.
//
// A leaf: no imports, so every CLI and `qcr version` read the same numbers.

export const REVIEW_SCHEMA_VERSION = 1;
export const SCAN_SCHEMA_VERSION = 1;
/** The shape of `qcr version --json` itself. */
export const VERSION_SCHEMA_VERSION = 1;

/** One family version per payload family: what a host plugin's contract fixes. */
export interface Contract {
  readonly review: number;
  readonly scan: number;
  readonly version: number;
}

/** The host-plugin contracts, by number. A contract's versions never change;
 * a bumped family version is a new entry. */
export const CONTRACTS: Readonly<Record<number, Contract>> = Object.freeze({
  1: Object.freeze({ review: 1, scan: 1, version: 1 }),
});

/** The contract numbers this build prints payloads for: those whose every
 * family version is the one the code prints, in ascending order. */
export function supportedContracts(): number[] {
  return Object.entries(CONTRACTS)
    .filter(
      ([, c]) =>
        c.review === REVIEW_SCHEMA_VERSION &&
        c.scan === SCAN_SCHEMA_VERSION &&
        c.version === VERSION_SCHEMA_VERSION,
    )
    .map(([n]) => Number(n))
    .sort((a, b) => a - b);
}

/** `data` with `schema_version` first. A payload that already names its
 * version keeps it, so a nested result passed through is not restamped. */
export function withSchemaVersion(
  version: number,
  data: Record<string, unknown>,
): Record<string, unknown> {
  return { schema_version: version, ...data };
}

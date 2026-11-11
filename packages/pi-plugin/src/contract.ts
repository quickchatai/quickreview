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
// contract keeps working for as long as its family versions can still be
// printed, and a contract is never redefined.
//
// The review family is at version 2: a review on a model with no measured
// price has no estimate, so `preview.estimate_usd`, `cap_usd` and `limit_usd`
// may be null there, which version 1 could not say. The code prints version 2
// and can still print version 1 by projection (`toReviewV1`): the same object
// under the older number, legal exactly when every estimate in it is a
// number. A payload that is not is never printed as version 1: its caller is
// refused in words instead (packages/pi-plugin/src/localreview.ts
// `reviewForContract`).
//
// A leaf: no imports, so every CLI and `qcr version` read the same numbers.

export const REVIEW_SCHEMA_VERSION = 2;
export const SCAN_SCHEMA_VERSION = 1;
/** The shape of `qcr version --json` itself. */
export const VERSION_SCHEMA_VERSION = 1;

/** The review family versions the code can print: its own, and the older
 * one by projection. */
export const REVIEW_PRINTABLE_VERSIONS: readonly number[] = Object.freeze([
  1,
  REVIEW_SCHEMA_VERSION,
]);

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
  2: Object.freeze({ review: 2, scan: 1, version: 1 }),
});

/** The contract numbers this build prints payloads for: those whose every
 * family version is one the code can print, in ascending order. */
export function supportedContracts(): number[] {
  return Object.entries(CONTRACTS)
    .filter(
      ([, c]) =>
        REVIEW_PRINTABLE_VERSIONS.includes(c.review) &&
        c.scan === SCAN_SCHEMA_VERSION &&
        c.version === VERSION_SCHEMA_VERSION,
    )
    .map(([n]) => Number(n))
    .sort((a, b) => a - b);
}

/** The review family version a caller reads: the one contract `contract`
 * fixes, or the code's own when the caller named none (or one this build
 * does not know, which the front door has refused before any verb ran). */
export function reviewVersionFor(contract: number | undefined): number {
  const fixed = contract === undefined ? undefined : CONTRACTS[contract]?.review;
  return fixed !== undefined && REVIEW_PRINTABLE_VERSIONS.includes(fixed)
    ? fixed
    : REVIEW_SCHEMA_VERSION;
}

/** `data` with `schema_version` first. A payload that already names its
 * version keeps it, so a nested result passed through is not restamped. */
export function withSchemaVersion(
  version: number,
  data: Record<string, unknown>,
): Record<string, unknown> {
  return { schema_version: version, ...data };
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Does a review payload state every estimate it carries as a number? Its
 * own preview's, and that of the result a detached run's status wraps. */
function statesEveryEstimate(payload: Record<string, unknown>): boolean {
  const preview = payload["preview"];
  if (isObject(preview) && typeof preview["estimate_usd"] !== "number") return false;
  const result = payload["result"];
  return !isObject(result) || statesEveryEstimate(result);
}

/** `payload` (a review payload of any printable version) under `version`,
 * the wrapped result of a detached run's status included. */
function restamped(payload: Record<string, unknown>, version: number): Record<string, unknown> {
  const { schema_version: _was, ...rest } = payload;
  const result = rest["result"];
  return {
    schema_version: version,
    ...rest,
    ...(isObject(result) && "schema_version" in result
      ? { result: restamped(result, version) }
      : {}),
  };
}

/** A review payload under the code's own version, whatever version it was
 * stored under: the fields of version 1 are all fields of version 2. */
export function toReviewNative(payload: Record<string, unknown>): Record<string, unknown> {
  return restamped(payload, REVIEW_SCHEMA_VERSION);
}

/**
 * The version-1 projection of a review payload: the same object with
 * `schema_version: 1`. Legal exactly when every `estimate_usd` it carries is
 * a number, which is what version 1 promises its readers; null otherwise,
 * and the caller says why in words. The fields version 2 added ride along:
 * version 1 allows additions.
 */
export function toReviewV1(payload: Record<string, unknown>): Record<string, unknown> | null {
  return statesEveryEstimate(payload) ? restamped(payload, 1) : null;
}

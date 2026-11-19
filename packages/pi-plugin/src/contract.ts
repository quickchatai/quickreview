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
// Contract 3 is the host contract: what a host that runs a reviewer for its
// operator reads and calls. It adds host families to the three every contract
// has, and they are built one at a time: `board` (schemas/board.v<N>.json,
// the export `qcr --schema 3 board` prints, src/boardexport.ts) is the first,
// and `host` (schemas/host.v<N>.json, what each `qcr --schema 3 host <verb>`
// prints, src/host/) the second.
// A contract lists a host family only once this build prints it, so
// `hostFamilies()` is what a release answers "which of them are here" with.
// A host-family payload leads with the NUMBER OF THE CONTRACT it is printed
// in, not with the family's own version: a host holds one number, its
// contract's, and checks every payload it reads against that one
// (`hostPayloadVersion`). The family's version is what the schema file is
// named by and what CONTRACTS fixes.
//
// A leaf: no imports, so every CLI and `qcr version` read the same numbers.

export const REVIEW_SCHEMA_VERSION = 2;
export const SCAN_SCHEMA_VERSION = 1;
/** The shape of `qcr version --json` itself. */
export const VERSION_SCHEMA_VERSION = 1;
/** The board export's shape (schemas/board.v1.json). */
export const BOARD_SCHEMA_VERSION = 1;
/** The shape of what a host verb prints (schemas/host.v1.json). */
export const HOST_SCHEMA_VERSION = 1;

/** The review family versions the code can print: its own, and the older
 * one by projection. */
export const REVIEW_PRINTABLE_VERSIONS: readonly number[] = Object.freeze([
  1,
  REVIEW_SCHEMA_VERSION,
]);

/** The families a host contract adds to the three every contract has. */
export const HOST_FAMILIES = ["board", "host"] as const;
export type HostFamily = (typeof HOST_FAMILIES)[number];

/** The version of each host family this build prints. */
const HOST_FAMILY_VERSIONS: Readonly<Record<HostFamily, number>> = Object.freeze({
  board: BOARD_SCHEMA_VERSION,
  host: HOST_SCHEMA_VERSION,
});

/** One family version per payload family: what a host plugin's contract
 * fixes. A host family a contract does not list has no payload in it. */
export interface Contract {
  readonly review: number;
  readonly scan: number;
  readonly version: number;
  readonly board?: number;
  readonly host?: number;
}

/** The payload families a contract can fix a version of. */
export type ContractFamily = keyof Contract;

/** The host-plugin contracts, by number. A contract's versions never change;
 * a bumped family version is a new entry. */
export const CONTRACTS: Readonly<Record<number, Contract>> = Object.freeze({
  1: Object.freeze({ review: 1, scan: 1, version: 1 }),
  2: Object.freeze({ review: 2, scan: 1, version: 1 }),
  3: Object.freeze({ review: 2, scan: 1, version: 1, board: 1, host: 1 }),
});

/** The contract numbers this build prints payloads for: those whose every
 * family version is one the code can print, in ascending order. */
export function supportedContracts(): number[] {
  return Object.entries(CONTRACTS)
    .filter(
      ([, c]) =>
        REVIEW_PRINTABLE_VERSIONS.includes(c.review) &&
        c.scan === SCAN_SCHEMA_VERSION &&
        c.version === VERSION_SCHEMA_VERSION &&
        HOST_FAMILIES.every((f) => c[f] === undefined || c[f] === HOST_FAMILY_VERSIONS[f]),
    )
    .map(([n]) => Number(n))
    .sort((a, b) => a - b);
}

/** The supported contracts that carry `family`, ascending: every one for the
 * three base families, and only the host contracts for a host family. */
export function contractsWith(family: ContractFamily): number[] {
  return supportedContracts().filter((n) => CONTRACTS[n]?.[family] !== undefined);
}

/** The host families this build prints, each at its version: what the
 * supported contracts list between them. A family absent here is not built
 * in this release, whatever contract number it will belong to. */
export function hostFamilies(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const family of HOST_FAMILIES)
    if (contractsWith(family).length > 0) out[family] = HOST_FAMILY_VERSIONS[family];
  return out;
}

/** The `schema_version` a host-family payload leads with: the contract its
 * caller named, when that contract carries the family; else the newest
 * supported contract that does (a call that named none). Undefined when no
 * supported contract carries it. */
export function hostPayloadVersion(
  family: HostFamily,
  contract: number | undefined,
): number | undefined {
  const carrying = contractsWith(family);
  if (contract !== undefined && carrying.includes(contract)) return contract;
  return carrying[carrying.length - 1];
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

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
// A leaf: no imports, so every CLI and `qcr version` read the same numbers.

export const REVIEW_SCHEMA_VERSION = 1;
export const SCAN_SCHEMA_VERSION = 1;
/** The shape of `qcr version --json` itself. */
export const VERSION_SCHEMA_VERSION = 1;

/** `data` with `schema_version` first. A payload that already names its
 * version keeps it, so a nested result passed through is not restamped. */
export function withSchemaVersion(
  version: number,
  data: Record<string, unknown>,
): Record<string, unknown> {
  return { schema_version: version, ...data };
}

// The key a start must quote: a hash of everything a preview showed. A leaf
// with only a node import, shared by `qcr scan` (src/setup/scan.ts) and
// `qcr review` (src/localreview.ts) so neither reaches into the other.
import { createHash } from "node:crypto";

/** What a preview's key covers: change any of it and a start quoting the old
 * key is refused — the operator always saw the price of what runs. */
export function planKey(parts: unknown): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

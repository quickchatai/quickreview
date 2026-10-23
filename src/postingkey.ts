// A round's posting key and the marker that carries it: the identity a
// review is posted under, so a retried post is recognised on GitHub and the
// gate (src/gate.ts) can hold a marked body to its key. A leaf: the receipts
// that record a post (src/posting-receipt.ts) and the planner that names the
// key (src/planner.ts) both read it here.

export function roundPostingKey(pr: number, roundNo: number, headSha: string): string {
  return `v1:${pr}:${roundNo}:${headSha.toLowerCase()}`;
}

/** The head a `roundPostingKey` names, when the key is one for exactly this
 * PR and round; undefined for any other key. */
export function postingKeyHead(key: string, pr: number, roundNo: number): string | undefined {
  const prefix = `v1:${pr}:${roundNo}:`;
  if (!key.startsWith(prefix)) return undefined;
  const head = key.slice(prefix.length);
  return head !== "" && !head.includes(":") ? head : undefined;
}

/** The head of any `roundPostingKey`, whatever PR and round it names. */
export function postingKeyAnyHead(key: string): string {
  return key.split(":").slice(3).join(":");
}

export function postingMarker(key: string): string {
  return `<!-- qcr-post:${key} -->`;
}

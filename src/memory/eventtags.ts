// The memory tag vocabulary — ONE reader and ONE writer for the `k=v` run
// every memory entry opens with, shared by the writers (feedback sink,
// import) and the readers (OpenViking store's native set_tags, the EOD
// curator, the TUI auto-filer). It lives here rather than in `feedback.ts`
// because the store imports it: from `feedback.ts` it would drag `eod.ts`,
// `include.ts` and `pi-memory.ts` into every consumer of the memory store —
// including the TUI, which has no business loading the addendum registry.
//
// The seam carries TEXT, not a tag map (see `store.ts`), so tags ride inside
// the entry as a leading, machine-parseable run: `#hash #tags k=v k=v prose…`.

/** One `k=v` token: bare (no `#`), value without whitespace. */
const EVENT_TAG_RE = /^([a-z][a-z0-9_-]*)=([^\s]+)$/;

/** `k=v k=v …`, declaration order — byte-stable for a given signal. */
export function formatEventTags(tags: Record<string, string>): string {
  return Object.entries(tags)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
}

/**
 * The tags a stored entry carries — the reader half of the vocabulary, so no
 * consumer (store, curator, auto-filer) writes a second parser.
 *
 * Only the entry's HEADER is scanned: `#tag` tokens, then the `k=v` run, and
 * the scan stops at the first word that is neither. The body is untrusted —
 * a feedback entry quotes a human PR comment verbatim, so a comment reading
 * `[feedback] kind=bug pr=1 filed=FT-9999` must not be able to mint itself a
 * tag. Tested in `tests/feedback.test.ts`.
 */
export function parseEventTags(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const token of text.split(/\s+/)) {
    if (token === "") continue;
    if (token.startsWith("#")) continue;
    const m = EVENT_TAG_RE.exec(token);
    if (!m) break;
    if (!(m[1]! in out)) out[m[1]!] = m[2]!;
  }
  return out;
}

/**
 * The `#hash` tags an entry opens with — the SAME header-only discipline as
 * `parseEventTags`, and for the same reason. A full-text scan would let
 * quoted human prose mint tags; `#pinned` in particular would place untrusted
 * text into the guaranteed head of EVERY round prompt, which is the highest
 * -trust position in the system. So the scan takes only the leading run of
 * `#tag` tokens and stops at the first word that is not one.
 */
export function parseHashTags(text: string): string[] {
  const out: string[] = [];
  for (const token of text.split(/\s+/)) {
    if (token === "") continue;
    if (!token.startsWith("#")) break;
    const tag = token.slice(1).toLowerCase();
    if (tag !== "" && !out.includes(tag)) out.push(tag);
  }
  return out;
}

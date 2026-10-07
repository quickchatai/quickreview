// The §1 layout of a user's memories tree, built at last (S5).
//
// Ratified 2026-08-20 and never built: every entry the reviewer ever wrote
// sat flat in `experiences/`, so the round's pinned head had to read the whole
// store to find the owner's standing instructions, and the round's context
// search drew ops notes and raw feedback events as readily as lessons. The
// areas, under `viking://user/<user>/memories/`:
//
//   preferences/pinned/  the GUARANTEED HEAD — the owner's standing
//                        instructions, delivered verbatim every round. An
//                        entry is pinned by being HERE (placement), and pin /
//                        unpin MOVE an entry in and out of it.
//   preferences/         unpinned standing instructions — what the owner types
//                        (`#manual`), and where an unpinned instruction goes.
//   experiences/         curated lessons, written by the EOD curator (and the
//                        setup/scan notes) — the ONLY area the round's context
//                        block searches.
//   cases/               one document per posted finding and its fate (S7).
//   events/              feedback, bug and ops signals, with `k=v` tags
//                        (`kind=feedback|bug|ops`, `pr=…`, `day=…`).
//
// This module is the VOCABULARY: area names, address arithmetic and the header
// edits a move needs. It knows nothing about HTTP or OpenViking — an id here
// is the store's `<area>/<file>` (see src/openviking/store.ts), and only the
// store turns it into a URI.
import { parseEventTags, parseHashTags } from "./eventtags.js";

/** The guaranteed head. */
export const PINNED_AREA = "preferences/pinned";
/** Unpinned standing instructions — the owner's own words. */
export const PREFERENCES_AREA = "preferences";
/** Curated lessons — the round's context block searches this area only. */
export const EXPERIENCES_AREA = "experiences";
/** Feedback, bug and ops signals. */
export const EVENTS_AREA = "events";
/** Finding cases (S7). */
export const CASES_AREA = "cases";

/** Every area of the layout, most specific first. */
export const MEMORY_AREAS: readonly string[] = [
  PINNED_AREA,
  PREFERENCES_AREA,
  EXPERIENCES_AREA,
  CASES_AREA,
  EVENTS_AREA,
];

/**
 * The areas the round's context block may draw from (S5): `experiences/`
 * alone. No ops notes, no raw feedback events, no standing instructions that
 * are not pinned (the head carries the pinned ones in full), no repo-wide
 * resources blurbs. They are OpenViking quota buckets by name, which is how
 * the search is confined to them.
 */
export const ROUND_SEARCH_AREAS: readonly string[] = [EXPERIENCES_AREA];

/** The event tag a pinned entry carries to remember where it came from, so an
 * unpin puts it back. */
export const FROM_TAG = "from";

/** `experiences/2026….md` → `experiences`; `preferences/pinned/x.md` →
 * `preferences/pinned`; a file at the root → `""`. */
export function areaOfId(id: string): string {
  const cut = id.lastIndexOf("/");
  return cut < 0 ? "" : id.slice(0, cut);
}

/** The file name of an id (`…/x.md` → `x.md`). */
export function nameOfId(id: string): string {
  return id.slice(id.lastIndexOf("/") + 1);
}

/** Is this entry in the guaranteed head? Placement, never a tag: an address is
 * chosen by the writer of the file, never by text quoted inside it — the
 * feedback sink, for one, always writes into `events/`. */
export function isPinnedId(id: string): boolean {
  return areaOfId(id) === PINNED_AREA;
}

/** Where `id` lands when it is pinned. */
export function pinnedIdFor(id: string): string {
  return `${PINNED_AREA}/${nameOfId(id)}`;
}

/** One or two lowercase segments — an area this layout can spell. */
const AREA_RE = /^[a-z][a-z0-9_-]*(?:\/[a-z][a-z0-9_-]*)?$/;

export function validArea(area: string): boolean {
  return AREA_RE.test(area);
}

/**
 * Where an unpinned entry goes: the area its `from=` tag names (set when it
 * was pinned), else `preferences/` — an entry somebody pinned was a standing
 * instruction, and unpinning keeps it one. Never the pinned area itself.
 */
export function unpinTargetArea(text: string): string {
  const from = parseEventTags(text)[FROM_TAG];
  if (from !== undefined && validArea(from) && from !== PINNED_AREA) return from;
  return PREFERENCES_AREA;
}

/**
 * Where a NEW entry written through the seam lands when its writer names no
 * area: the header decides (header-only, so quoted text cannot choose) —
 * `#pinned` → the head, `#manual` → preferences, anything else → the store's
 * default area.
 */
export function areaForNewEntry(text: string, fallback: string): string {
  const tags = parseHashTags(text.trim());
  if (tags.includes("pinned")) return PINNED_AREA;
  if (tags.includes("manual")) return PREFERENCES_AREA;
  return fallback;
}

/**
 * What the EOD curator is told about the layout (S5). The sweep's seed
 * (`prompts/eod-sweep.md`) is a ratified reseed and frozen (rule 6), so the
 * layout reaches the curator the way the day's cancellation line does: the
 * daemon renders it after the seed (`renderEodPrompt`'s `memoryLayout`). It
 * restates nothing the seed rules on — it only says WHERE each kind of entry
 * lives, which the seed never did.
 */
export const MEMORY_LAYOUT_NOTE = [
  "Reviewer memory (`viking://user/reviewer/memories/`) is laid out in areas — the",
  "§1 layout. Write each entry where it belongs; `viking_write` takes the",
  "full URI, so the area is the directory you name:",
  "",
  "- `experiences/` — the day's learnings (product 1). The ONLY area a review round",
  "  searches, so nothing else belongs here.",
  "- `events/` — feedback, bug and ops signals. An operational defect of the review",
  "  system is an `events/` entry whose header carries `kind=bug area=operations`;",
  "  an ops note that is not a defect carries `kind=ops area=operations`. The",
  "  day's `kind=feedback` entries are here too.",
  "- `preferences/` — the owner's own words (`#manual`). Not yours to write.",
  "- `preferences/pinned/` — THE PINNED AREA: the owner's standing instructions,",
  "  delivered verbatim in every round. Never write, move, retire or rewrite",
  "  anything under it.",
  "- `cases/` — finding cases; not yet written.",
  "",
  "An entry's header is its first tokens — `#tags`, then `k=v` tags, then the",
  "prose (e.g. `#bug kind=bug area=operations day=YYYY-MM-DD What broke …`); a tag",
  "anywhere else in the text is prose, and nothing reads it.",
].join("\n");

// ---- header edits ------------------------------------------------------------
//
// The header is the leading run the two parsers of src/memory/eventtags.ts
// read: tokens that start with `#` (which `parseHashTags` walks through — a
// bare `#` included) and `k=v` tokens (which `parseEventTags` reads while it
// skips every `#` token). An edit here stays inside that run, so both parsers
// see exactly what they saw before plus the edit. A run that holds nothing but
// a bare `#` is a markdown title, not a header: a tag is then not spliced into
// the title but put on a first line of its own.

const KV_RE = /^[a-z][a-z0-9_-]*=[^\s]+$/;
const HASH_RE = /^#[^\s#]+$/;

/** Index (into the separator-keeping token array) just past the header run,
 * and whether the run holds a real tag. */
function headerRun(tokens: string[]): { end: number; real: boolean } {
  let end = 0;
  let real = false;
  for (let i = 0; i < tokens.length; i += 2) {
    const t = tokens[i]!;
    if (t === "") continue;
    const tag = HASH_RE.test(t) || KV_RE.test(t);
    // A bare `#` after a real tag is a markdown title on the next line.
    if (!tag && real) break;
    if (tag || t.startsWith("#")) {
      end = i + 1;
      if (tag) real = true;
      continue;
    }
    break;
  }
  return { end, real };
}

/**
 * `text` with the `k=v` tags it does not already carry in its header added to
 * the header: at the end of the leading run of `#tags` and `k=v`, or — when the
 * text opens with prose or a markdown title — as a first line of their own. A
 * tag the header already has is left as it is (never two values for one key).
 * Returns the trimmed text.
 */
export function withHeaderTags(text: string, tags: Readonly<Record<string, string>>): string {
  const trimmed = text.trim();
  const have = parseEventTags(trimmed);
  const add = Object.entries(tags)
    .filter(([k, v]) => KV_RE.test(`${k}=${v}`) && !(k in have))
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  if (add === "") return trimmed;
  if (trimmed === "") return add;
  const tokens = trimmed.split(/(\s+)/);
  const { end, real } = headerRun(tokens);
  if (!real) return `${add}\n${trimmed}`;
  const head = tokens.slice(0, end).join("");
  const tail = tokens.slice(end).join("");
  return tail.trim() === "" ? `${head} ${add}` : `${head} ${add}${tail}`;
}

/** `text` without the header's `key=…` token. Only the header is touched, and
 * only the gap the token leaves is closed; the rest is the writer's bytes. */
export function withoutHeaderTag(text: string, key: string): string {
  const trimmed = text.trim();
  const tokens = trimmed.split(/(\s+)/);
  const { end } = headerRun(tokens);
  for (let i = 0; i < end; i += 2) {
    const t = tokens[i]!;
    if (!t.startsWith(`${key}=`) || !KV_RE.test(t)) continue;
    // Take the separator before it when there is one (so `#a k=v\nrest`
    // keeps its line break), else the one after it.
    if (i > 0) tokens.splice(i - 1, 2);
    else tokens.splice(i, 2);
    return tokens.join("").trim();
  }
  return trimmed;
}

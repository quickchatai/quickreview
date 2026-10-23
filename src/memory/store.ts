// The one memory seam.
//
// Everything in this codebase that reads or writes reviewer memory talks to
// `MemoryStore` — the daemon's [feedback] sink, the TUI's management verbs,
// the EOD curator. No caller knows how memory is stored. The seam has exactly
// one implementation, `OpenVikingStore` (`src/openviking/store.ts`); the only
// other reader is a read-only `MemorySource` over the archived legacy file
// (`legacy-file.ts`), kept solely so the one-time import can see what it is
// importing.
//
// Nothing in this file may know about HTTP, OpenViking, or any file format.
// It is the vocabulary — entries, ops, results — and only that.
//
// Shape notes (deliberate, they are what keeps the seam swappable):
//
//   * Async everywhere. The engine is an HTTP server on loopback and the
//     TUI's path is a forwarded round trip; a sync signature would be a lie.
//   * One write method taking a discriminated op, not six verb methods. Every
//     writer funnels through a single serialized mutation path (one
//     `content/batch-write` endpoint), so a single `apply` is the honest
//     shape — and adding an op is a union arm, not an interface break for
//     every fake in the test suite.
//   * Writes resolve with a result, they never reject. A refusal ("stale
//     view", "no such batch") is an ordinary answer callers render to the
//     operator, and so is a dead transport. Callers must never have to tell
//     those two apart to decide whether the memory changed. (A READ may
//     reject when there is no transport at all.)
//   * Every addressed op carries an expected-content hash. Memory has other
//     writers (a live session's own memory writes hold no lock), so a
//     mutation addressed at content the store no longer holds is refused
//     rather than applied to whatever moved into its place.

/** One memory entry — the unit the timeline lists and the verbs address. */
export interface MemoryEntry {
  /** The entry's id: the file path under the memories root, extension
   * included (see `src/openviking/store.ts`). The address is the (ts, id)
   * pair plus the block index, which is always 0 for this store. */
  id: string;
  /** Wall-clock stamp of the batch, `YYYY-MM-DD HH:MM:SS`. */
  ts: string;
  /** `YYYY-MM-DD` slice of ts — the day-highlight key. */
  day: string;
  /** Index of this entry inside its batch. */
  block: number;
  /** The entry's text (trimmed, newlines preserved). */
  text: string;
  /** `#tag` tokens found in the text. */
  tags: string[];
  /** `[[link]]` tokens found in the text. */
  links: string[];
  /** In the guaranteed head: a matter of placement — the entry sits in the
   * pinned area of the memory layout (src/memory/layout.ts) — never of a tag
   * quoted in its text. */
  pinned: boolean;
  /** Content hash as the STORE computes it — the optimistic-concurrency
   * token an addressed op carries back. Callers copy it, never compute it
   * (the algorithm is the implementation's business). */
  hash: string;
}

/** Advisory pinned-region budget: the pinned head is delivered in full, but
 * past this many characters pins are warned about (the TUI's memory tab;
 * setup's pin proposals). */
export const PINNED_BUDGET_CHARS = 1900;

/** What the pinned entries among `entries` take of that head. */
export function pinnedBudget(entries: MemoryEntry[]): { chars: number; over: boolean } {
  const chars = entries.filter((e) => e.pinned).reduce((n, e) => n + e.text.length + 2, 0);
  return { chars, over: chars > PINNED_BUDGET_CHARS };
}

/** Where a mutation lands, plus the content it expects to find there. */
export interface MemoryRef {
  id: string;
  ts: string;
  block: number;
  /** The `hash` of the entry as the caller last saw it. */
  expect: string;
}

/** The address half of an entry — how a caller turns a listed entry into the
 * target of a verb without ever touching hashes itself. */
export function refOf(e: MemoryEntry): MemoryRef {
  return { id: e.id, ts: e.ts, block: e.block, expect: e.hash };
}

/**
 * Every mutation memory supports.
 *
 * `add` vs `note` is a real distinction, not a spelling: `add` is the operator
 * typing an entry (the store tags it as hand-written), `note` is a machine
 * writer appending an entry that already carries its own tag and must be
 * stored verbatim. Collapsing them would let the daemon's `#feedback` lines
 * masquerade as the operator's own words.
 *
 * A `note` may carry a deterministic address: `name` (a plain
 * file stem) and `category` (the area it belongs in — the memory layout:
 * `events` for signals, `experiences` for lessons). That is the shape an
 * idempotent writer needs: the note is created at exactly that address or
 * not at all, so a replay of a write that landed but whose answer was lost
 * finds its own entry instead of minting a second one. A replay of the SAME
 * bytes is a plain success; an entry already there with OTHER bytes is kept,
 * untouched, and reported `existed` — never overwritten, never duplicated.
 * Without `name` a note lands under a fresh name — in the area it names, else
 * where its own header-only tags put it (`#pinned` → the pinned area,
 * `#manual` → the owner's preferences, src/memory/layout.ts
 * `areaForNewEntry`), else the store's default area.
 *
 * `pin` and `unpin` move an entry into and out of the pinned area: its id
 * changes, and its old address keeps a retired stub. `retire`
 * and `edit` rewrite it in place. `add` is the owner's own words and lands in
 * the preferences area.
 */
/** note.identity globally deduplicates a named creation across placement changes;
 * an interrupted creation resumes the first claimant's immutable target. */
export type MemoryOp =
  | ({ op: "retire" } & MemoryRef)
  | ({ op: "pin" } & MemoryRef)
  | ({ op: "unpin" } & MemoryRef)
  | ({ op: "edit"; text: string } & MemoryRef)
  | { op: "add"; text: string }
  | { op: "note"; text: string; name?: string; category?: string; identity?: string };

/** Applied, or refused with a reason fit to show an operator. */
export interface MemoryWriteResult {
  ok: boolean;
  message: string;
  /** Where the entry now lives, as the engine addresses it (OpenViking: its
   * `viking://` URI). Set by a store that knows; absent on a refusal. */
  uri?: string;
  /** A named `note` found an entry already at its address holding other
   * bytes, and kept it (`ok` is true: the address is taken by this writer's
   * entry, and nothing was overwritten). */
  existed?: boolean;
  /** The exact named bytes were already present; no new entry was created. */
  unchanged?: boolean;
}

/**
 * One named document a deterministic writer keeps in memory (the daemon's
 * finding cases). Unlike a `note`, a document is the writer's to rewrite: it
 * is created when the writer never wrote it (`expect: null`) and
 * replaced only under the hash of the bytes the writer last wrote there, so
 * an entry somebody else put at the address, or changed since, is never
 * overwritten — it comes back as a `conflict` naming what is there.
 */
export interface DocumentPut {
  /** The area it lives in (`cases`). */
  area: string;
  /** A plain file stem — the writer's deterministic address. */
  name: string;
  /** The bytes to hold (stored trimmed, with one trailing newline). */
  text: string;
  /** The store hash of the bytes this writer last wrote at the address, or
   * null when it never wrote there. */
  expect: string | null;
}

/** How one `DocumentPut` ended. */
export interface DocumentPutResult {
  area: string;
  name: string;
  /**
   * `written` — the address now holds exactly these bytes (created, replaced,
   * or already holding them); `conflict` — it holds something the writer did
   * not expect (see `found`), and nothing was overwritten; `failed` — not
   * written, for a reason a retry may clear (a refusal, a dead server, an
   * outcome that could not be confirmed).
   */
  state: "written" | "conflict" | "failed";
  /** `written`: the hash of the bytes now stored — the next `expect`. */
  hash?: string;
  /** `conflict`: the exact bytes found at the address, or null when it holds
   * nothing (a replace whose document is gone). */
  found?: string | null;
  /** Where the document lives, as the engine addresses it. */
  uri?: string;
  message: string;
}

export interface MemorySearchOptions {
  /** Restrict to entries carrying this tag (leading `#` optional). */
  tag?: string | null;
  /** Cap the result count (newest-relevant first is the store's choice). */
  limit?: number;
}

/**
 * The READ half of the seam, on its own.
 *
 * Split out for the one caller that legitimately has no engine behind it: the
 * one-time import's source is the archived markdown file, which can be read and
 * can never be written. Narrowing the source to this interface is what lets
 * "the seam has exactly one `MemoryStore` implementation" stay literally true.
 */
export interface MemorySource {
  /** Every entry the source holds, oldest first. */
  read(): Promise<MemoryEntry[]>;
}

export interface MemoryStore extends MemorySource {
  /** Entries matching free text and/or a tag. */
  search(query: string, opts?: MemorySearchOptions): Promise<MemoryEntry[]>;
  /** Apply one mutation. Resolves with a refusal rather than throwing. */
  apply(op: MemoryOp): Promise<MemoryWriteResult>;
  /**
   * Make this store ready to be written into, before anything writes.
   *
   * Optional, and most implementations should omit it: a store that is always
   * writable has nothing to do here. It exists for engines where a namespace
   * has to be materialized before it is addressable — see the OpenViking
   * implementation, where a namespace nobody has written to yet is not merely
   * empty but invisible, and a second writer silently retargets somewhere else.
   *
   * Resolves with a refusal rather than throwing, like `apply`.
   */
  ensureWritable?(): Promise<MemoryWriteResult>;
  /** Optional: an entry id as the engine addresses it (the `uri` a write
   * result carries) — so a caller that found an entry by reading can record
   * the same address one it wrote would have. */
  uriOf?(id: string): string;
  /**
   * Optional: create or replace many named documents at once —
   * one write per area (the engine's batch root), every document under its
   * own precondition (`DocumentPut.expect`). Resolves with one result per
   * document, in the order given; never throws. A store without it cannot
   * hold documents, and their writer says so rather than falling back to
   * another route.
   */
  putDocuments?(docs: readonly DocumentPut[]): Promise<DocumentPutResult[]>;
}

/** Normalize a tag for comparison: leading `#`s dropped, lowercased. */
export function normalizeTag(tag: string): string {
  return tag.replace(/^#+/, "").toLowerCase();
}

/** Every `#tag` token ANYWHERE in an entry's text — what `MemoryEntry.tags`
 * carries for search and the import's classifier. Never the privileged
 * reader: placement and event headers read the header alone
 * (`eventtags.ts` `parseHashTags`). */
export function tagsOf(text: string): string[] {
  return [...text.matchAll(/(^|\s)#([\w-]+)/g)].map((m) => m[2]!);
}

/** Every `[[link]]` token in an entry's text — `MemoryEntry.links`. */
export function linksOf(text: string): string[] {
  return [...text.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]!);
}

/** A store's `search`: the entries `matchesQuery` admits, cut to
 * `opts.limit` when one is given (absent or negative: all of them). */
export function searchEntries(
  entries: readonly MemoryEntry[],
  query: string,
  opts?: MemorySearchOptions,
): MemoryEntry[] {
  const hits = entries.filter((e) => matchesQuery(e, query, opts));
  const limit = opts?.limit;
  return limit !== undefined && limit >= 0 ? hits.slice(0, limit) : hits;
}

/** The shared match predicate — case-insensitive substring over the text,
 * AND an exact (normalized) tag when one is given. An empty query matches
 * everything, so `search("", { tag })` is a tag listing. */
export function matchesQuery(e: MemoryEntry, query: string, opts?: MemorySearchOptions): boolean {
  const tag = opts?.tag;
  if (tag !== undefined && tag !== null && tag !== "") {
    const want = normalizeTag(tag);
    if (!e.tags.some((t) => normalizeTag(t) === want)) return false;
  }
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  return e.text.toLowerCase().includes(q);
}

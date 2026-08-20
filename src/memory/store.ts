// The ONE memory seam.
//
// Everything in this codebase that reads or writes reviewer memory talks to
// `MemoryStore` — the daemon's [feedback] sink, the TUI's management verbs,
// the EOD curator. No caller knows how memory is stored. Since the
// seam has exactly ONE implementation, `OpenVikingStore`
// (`src/openviking/store.ts`); the hand-rolled markdown engine it replaced is
// gone, and the only thing left of it is a read-only `MemorySource` over the
// archived file (`legacy-file.ts`), kept solely so the one-time import can
// still see what it is importing.
//
// Nothing in THIS file may know about HTTP, OpenViking, or any file format.
// It is the vocabulary — entries, ops, results — and only that.
//
// Shape notes (deliberate, they are what keeps the seam swappable):
//
//   * Async everywhere. The engine is an HTTP server on loopback and the
//     TUI's path is a forwarded round trip; a sync signature would be a lie.
//   * ONE write method taking a discriminated op, not six verb methods. Every
//     writer funnels through a single serialized mutation path (one
//     `content/batch-write` endpoint), so a single `apply` is the honest
//     shape — and adding an op is a union arm, not an interface break for
//     every fake in the test suite.
//   * Writes RESOLVE with a result, they do not reject. A refusal ("stale
//     view", "no such batch") is an ordinary answer callers render to the
//     operator; only a broken transport throws. Callers must never have to
//     tell those two apart to decide whether the memory changed.
//   * Every addressed op carries an expected-content hash. Memory has other
//     writers (a live session's own memory writes hold no lock), so a
//     mutation addressed at content the store no longer holds is refused
//     rather than applied to whatever moved into its place.

/** One memory entry — the unit the timeline lists and the verbs address. */
export interface MemoryEntry {
  /** Batch id (the writing session's id prefix). NOT unique on its own — the
   * address is the (ts, id) pair plus the block index. */
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
  pinned: boolean;
  /** Content hash as the STORE computes it — the optimistic-concurrency
   * token an addressed op carries back. Callers copy it, never compute it
   * (the algorithm is the implementation's business). */
  hash: string;
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
 * `add` vs `note` is a real distinction, not a spelling: `add` is the owner
 * typing an entry (the store tags it as hand-written), `note` is a machine
 * writer appending an entry that already carries its own tag and must be
 * stored verbatim. Collapsing them would let the daemon's `#feedback` lines
 * masquerade as the operator's own words.
 */
export type MemoryOp =
  | ({ op: "retire" } & MemoryRef)
  | ({ op: "pin" } & MemoryRef)
  | ({ op: "unpin" } & MemoryRef)
  | ({ op: "edit"; text: string } & MemoryRef)
  | { op: "add"; text: string }
  | { op: "note"; text: string };

/** Applied, or refused with a reason fit to show an operator. */
export interface MemoryWriteResult {
  ok: boolean;
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
 * import's SOURCE is the archived markdown file, which can be read and
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
}

/** Normalize a tag for comparison: leading `#`s dropped, lowercased. */
export function normalizeTag(tag: string): string {
  return tag.replace(/^#+/, "").toLowerCase();
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

// `MemoryStore` over OpenViking — the engine behind the memory seam. Nothing
// above this file learns that memory is an HTTP server: the TUI's verbs, the
// [feedback] sink and the companion feed address entries by
// `(id, ts, block)` + an expected hash.
//
// OpenViking keeps one file per entry under
// `viking://user/<user>/memories/<area>/`, so the address is the file. The
// seam's vocabulary maps onto it:
//
//   id     `<category>/<stamp>-<suffix>.md` — the path under the memories
//          root, extension included, so `id → uri` is exact rather than
//          guessed. Opaque to callers; only this module builds or reads it.
//   ts     parsed from the `<stamp>` half of the name, so an entry's time is a
//          property of the entry and not of the server's mtime bookkeeping.
//   block  always 0. One entry per file; there is nothing to index into.
//   hash   `sha256:<hex>` of the stored bytes — the exact token batch-write's
//          `replace_if_hash` precondition wants.
//
// Why `content/read` is a safe hash source here, given the `MEMORY_FIELDS`
// footgun: it is safe *because* of the rule above it, not despite it. Bare
// `content/write` appends a footer that `content/read` strips, which makes
// read → sha256 → write 409 forever; files written by `content/batch-write`
// carry no footer and round-trip byte-exact (verified). This module has no
// route to `content/write` — the client does not expose one — so every file it
// can see was written by batch-write, and the hash it computes is the hash the
// server holds. If that ever stops being true the symptom is a 409 on a fresh
// read, which surfaces as an ordinary refusal, never as a lost update.
//
// Tags come in two flavours, and this module owns neither vocabulary.
//
//   * `#hash-tags` are the seam's own convention: `#pinned` rides an entry
//     the pin verb moved (pinning itself is placement — see the layout),
//     `#manual` marks the owner's own words, `#retired` is a retirement (and
//     retired entries are filtered out of `read()`, which is what makes retire
//     behave like retire). They are PREPENDED to the entry text, exactly as
//     `src/memory/import.ts` and the [feedback] writer already spell them, so
//     an entry means the same thing whichever store holds it.
//   * `k=v` event tags (`kind=`, `pr=`, `day=`, `signal=`) are the vocabulary
//     that the curator filters on and the auto-filer queries. They
//     ride the entry header too, and they are what this store mirrors onto
//     OpenViking's native retrieval tag list. The parser is
//     `parseEventTags` from `src/memory/eventtags.ts` — imported, never re-implemented:
//     it scans the HEADER only, so an untrusted PR body quoted later in the
//     entry cannot mint itself a tag, and a second parser here would be free
//     to disagree about exactly that.
//
// Both live in plain body text on purpose: plain text is what `content/read`
// returns unmodified and what every store re-parses. A `MEMORY_FIELDS`-style
// metadata footer is precisely what the server reserves for its own extractor
// and strips on read.
//
// The layout (the areas of src/memory/layout.ts). An id
// is `<area>/<file>`, an area one or two segments (`experiences`, `events`,
// `preferences`, `preferences/pinned`), so the tree is listed THREE levels
// deep. An entry is PINNED by placement — it sits in `preferences/pinned/` —
// and `pin`/`unpin` MOVE it there and back: the copy is created at the new
// address first, then the old file is replaced by a `#retired #moved` stub
// naming where it went. Never a delete (the store has no route to one), and
// never two live copies once a move has finished; a move whose outcome cannot
// be read is left as found rather than undone on a guess. The round's pinned head
// reads that one directory (`pinnedSweep`) — exact, and never a full sweep.
import { createHash } from "node:crypto";
import { formatEventTags, parseEventTags, parseHashTags } from "../memory/eventtags.js";
import {
  FROM_TAG,
  PINNED_AREA,
  PREFERENCES_AREA,
  SWEEP_EXCLUDED_AREAS,
  areaForNewEntry,
  areaOfId,
  isPinnedId,
  nameOfId,
  pinnedIdFor,
  unpinTargetArea,
  validArea,
  withHeaderTags,
  withoutHeaderTag,
} from "../memory/layout.js";
import {
  matchesQuery,
  type DocumentPut,
  type DocumentPutResult,
  type MemoryEntry,
  type MemoryOp,
  type MemorySearchOptions,
  type MemoryStore,
  type MemoryWriteResult,
} from "../memory/store.js";
import { batchWriteLanded, type OpenVikingClient } from "./client.js";

/** Tag applied to `add` — an entry the owner typed himself. `note` (a machine
 * writer) is stored verbatim, so the two can never masquerade as each other. */
export const MANUAL_TAG = "manual";
export const PINNED_TAG = "pinned";
export const RETIRED_TAG = "retired";

/** Where a new entry lands. `experiences` is a real server quota bucket, which
 * is what lets a context search size it. */
export const DEFAULT_CATEGORY = "experiences";

/** `sha256:<lowercase-hex>` over the exact stored bytes — batch-write's
 * `base_hash` shape. */
export function sha256Prefixed(body: string): string {
  return `sha256:${createHash("sha256").update(Buffer.from(body, "utf8")).digest("hex")}`;
}

const TAG_TOKEN_RE = /(^|\s)#([\w-]+)/g;
const LINK_RE = /\[\[([^\]]+)\]\]/g;

/** An id is a relative path of one to three safe segments ending in a text
 * extension — `<file>`, `<area>/<file>` or `preferences/pinned/<file>`. Anything else is refused rather than turned
 * into a URI: an id ultimately comes back from a caller that got it from us,
 * and `..` in a path we interpolate is exactly the mistake worth making
 * structurally impossible. */
const ID_RE = /^(?:[A-Za-z0-9._-]+\/){0,2}[A-Za-z0-9._-]+\.(?:md|txt)$/;

export function validEntryId(id: string): boolean {
  return ID_RE.test(id) && !id.includes("..") && !id.split("/").some((s) => s === ".");
}

/** The `#moved` stub a move leaves at the old address: retired (so every
 * reader hides it and no recall returns it), naming where the entry went. */
export const MOVED_TAG = "moved";
export const MOVED_TO_TAG = "moved-to";

export function movedStub(to: string): string {
  return `#${RETIRED_TAG} #${MOVED_TAG} ${MOVED_TO_TAG}=${to}\nThis entry moved to ${to}.\n`;
}

/** Is this stored text a move's stub (header `#retired #moved`)? Only such a
 * stub may be written over by a later move into its address. */
export function isMovedStub(text: string): boolean {
  const tags = parseHashTags(text);
  return tags.includes(RETIRED_TAG) && tags.includes(MOVED_TAG);
}

/** `20260820T153000-a1b2c3d4.md` → `2026-08-20 15:30:00`. Null when the name
 * carries no stamp — the caller then falls back to the server's modTime. */
export function tsFromName(name: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/.exec(name);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
}

/** `2026-08-20T15:30:00.000Z` (or anything Date parses) → `2026-08-20 15:30:00`
 * in UTC. Used only for files whose name carries no stamp. */
export function tsFromModTime(modTime: string): string {
  const d = new Date(modTime);
  if (Number.isNaN(d.getTime())) return "1970-01-01 00:00:00";
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/** `2026-08-20 15:30:00` → `20260820T153000`. */
export function stampOf(ts: string): string {
  return `${ts.slice(0, 10).replace(/-/g, "")}T${ts.slice(11).replace(/:/g, "")}`;
}

export function tagsOf(text: string): string[] {
  return [...text.matchAll(TAG_TOKEN_RE)].map((m) => m[2]!);
}

/**
 * The stored body for an entry: `#tags` first, then the text, then exactly one
 * trailing newline.
 *
 * A tag goes at the FRONT, not into a footer line — that is where
 * `src/memory/import.ts` puts `#manual`/`#pinned`, where the [feedback] writer
 * puts `#feedback` and its `k=v` run, and where `parseEventTags` looks.
 */
export function renderEntryBody(text: string, addTags: readonly string[] = []): string {
  const trimmed = text.trim();
  if (trimmed === "") return "";
  // Header-only, like `pinned`: a tag quoted in the body is prose, so it
  // must not stop the real one landing in the header where readers look.
  const have = new Set(parseHashTags(trimmed));
  const missing = addTags
    .map((t) => t.replace(/^#+/, "").toLowerCase())
    .filter((t) => t !== "" && !have.has(t));
  const head = missing.map((t) => `#${t}`).join(" ");
  return `${head === "" ? trimmed : `${head} ${trimmed}`}\n`;
}

/** Prepend a tag to an entry's text, idempotently. */
export function withTag(text: string, tag: string): string {
  return renderEntryBody(text, [tag]);
}

/** Remove every occurrence of a tag token. Idempotent, never touches other
 * tags — the same spelling `import.ts` uses to unpin.
 *
 * Only the gap the token leaves is closed (the token takes its trailing
 * spaces with it): the rest of the body — code indentation, aligned columns —
 * is the owner's bytes, and an unpin must hand them back as `withTag` found
 * them. */
export function withoutTag(text: string, tag: string): string {
  const token = new RegExp(
    `(?<=^|\\s)#${tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\S)[ \t]*`,
    "gi",
  );
  return `${text.replace(token, "").trim()}\n`;
}

/** Parse one stored file into an entry. Total: a file we cannot date still
 * becomes an entry (with the server's modTime), because dropping a memory
 * because its NAME is odd would be the worse failure. */
export function entryFrom(id: string, text: string, modTime: string): MemoryEntry {
  const name = id.slice(id.lastIndexOf("/") + 1);
  const ts = tsFromName(name) ?? tsFromModTime(modTime);
  const trimmed = text.trim();
  const tags = tagsOf(trimmed);
  return {
    id,
    ts,
    day: ts.slice(0, 10),
    block: 0,
    text: trimmed,
    tags,
    links: [...trimmed.matchAll(LINK_RE)].map((m) => m[1]!),
    // Placement, never text: a pinned entry rides the guaranteed
    // head of every round prompt, and that head reads `preferences/pinned/`
    // alone. An address is chosen by whoever writes the file (a `note` names
    // its area, or its own header-only `#pinned` does — `areaForNewEntry`), so
    // text quoted inside an entry can never pin it.
    pinned: isPinnedId(id),
    // The hash is over the STORED bytes, not the trimmed text — it is a
    // precondition token for the server, not a digest of what we display.
    hash: sha256Prefixed(text),
  };
}

/**
 * What one sweep of the store produced: the entries, plus every part
 * of the store the sweep could NOT read.
 *
 * `read()` collapses this to the entries, which is the right answer for a
 * timeline ("nothing to show"). The round path's pinned head must not
 * collapse it: a store that could not be listed and a pinned area nobody has
 * written to yet are different facts, and only the first is an outage.
 */
export interface MemorySweep {
  entries: MemoryEntry[];
  /** One line per failed listing or entry read (`ls <uri>: <message>`,
   * `read <uri>: <message>`). Empty ⇒ `entries` is the whole store. A
   * NOT_FOUND is deliberately NOT recorded here: a root or category nobody
   * has written into yet is ABSENT (the server 404s it until the first write
   * creates it — see `create()`), and absent is known-empty, not unreadable;
   * an entry listed a moment ago and gone now is a race, not an outage — but
   * EVERY listed entry gone is recorded here, because a listing the content
   * contradicts cannot vouch for an empty head. */
  unread: string[];
  /** The RETIRED entries the sweep read and kept out of `entries` (a
   * retirement and a move's `#moved` stub alike), oldest first. A timeline
   * never shows them; a caller that must know an entry once EXISTED does —
   * the [feedback] backfill, before it writes a signal again (a signal
   * whose old entry was retired is not owed twice), and the relayout,
   * which must neither move a retired entry nor write over a stub. */
  retired: MemoryEntry[];
}

/** The pinned area alone: what the round's guaranteed head and
 * the EOD pinned-area watchdog read. `unread` as in `MemorySweep`; an absent
 * pinned directory is known-empty, not unread. */
export interface PinnedSweep {
  entries: MemoryEntry[];
  unread: string[];
}

/** One move or in-place rewrite for `OpenVikingStore.relocate`. */
export interface RelocateItem {
  /** The entry as the plan read it. */
  id: string;
  /** Its hash as the plan read it — the source's `replace_if_hash`. */
  expect: string;
  /** Move here; absent = rewrite in place. */
  to?: string;
  /** The destination holds a `#moved` stub with this hash (an entry moving
   * back to where it once was, or the pointer a failed move left behind): the
   * copy replaces the stub under it instead of being created. */
  toExpect?: string;
  /** The new bytes (the moved copy's, or the in-place rewrite's). */
  text: string;
}

export interface RelocateResult {
  id: string;
  to?: string;
  ok: boolean;
  message: string;
}

export interface RelocateReport {
  /** One per item, in the order given. */
  results: RelocateResult[];
  /** Every batch-write sent: its root, its size, and what came of it. */
  batches: Array<{ root: string; ops: number; ok: boolean; message: string }>;
}

/** The server's `_BATCH_MAX_OPERATIONS` (storage/content_write.py, 0.4.15). */
export const BATCH_MAX_OPERATIONS = 256;

/** One sweep plus the retired entries' URIs it filtered out — kept beside the
 * public `MemorySweep` rather than in it, because only the context search
 * needs them. */
interface SweepRun {
  sweep: MemorySweep;
  retired: string[];
}

/**
 * What one sweep cost: how many files the listing named, how many
 * were READ, how many were answered from the per-file cache because their
 * size and modification time had not moved, and whether this was a periodic
 * FULL refresh (every file read). Observability and tests; never a decision.
 */
export interface SweepStats {
  full: boolean;
  listed: number;
  reread: number;
  reused: number;
}

/** What the incremental sweep remembers of one file. `sig` is the
 * `size:modTime` of the listing that PRECEDED the read, so the bytes are never
 * older than the signature they are filed under (a write in between only
 * costs one more read); null when the listing carried no usable modTime — such
 * a file is read on every sweep. `entry` null = the file read empty. */
interface KnownFile {
  sig: string | null;
  entry: MemoryEntry | null;
  retired: boolean;
}

/** A listed file's change signature, or null when it cannot vouch for one. */
function signatureOf(file: { size: number; modTime: string }): string | null {
  if (file.modTime.trim() === "") return null;
  return `${file.size}:${file.modTime}`;
}

export interface OpenVikingStoreOptions {
  client: OpenVikingClient;
  /** Defaults to the client's own `user/<user>/memories` root. */
  memoriesRoot?: string;
  defaultCategory?: string;
  now?: () => Date;
  log?: (msg: string, extra?: unknown) => void;
  /** Parallel `content/read` calls during a sweep. 8 matches the server's own
   * read concurrency; the point is to bound the burst, not to go fast. */
  readConcurrency?: number;
  /** How long a `read()` sweep is reused. A sweep is one `fs/ls` per category
   * plus one `content/read` per entry, and the round path asks for the pinned
   * head EVERY round — without a cache that is the memory engine's largest
   * recurring cost, and CPU is the resource to watch on the 2-core quota. */
  cacheTtlMs?: number;
  /** How often a sweep re-reads every file. In between, a sweep still lists
   * every category but reads only the files whose size or modification time
   * moved since this store last read them, so the TUI, the companion and the
   * daemon do not each re-read the whole store every few minutes. The full
   * refresh is the belt for a change the listing did not show. `0` makes
   * every sweep full. */
  fullRefreshMs?: number;
  /** Called with the retired URIs whenever that list changes (and once, at
   * the first completed sweep). The daemon publishes it beside the sessions'
   * ovcli.conf so the vendored extension's recall can exclude retired entries
   * (PATCH 7). Must not throw; a throw is swallowed. */
  onRetired?: (uris: readonly string[]) => void;
  /** The retired list a previous process last published (what `onRetired`
   * wrote — `readRetiredUrisFile`), or null when there is none. It is the
   * list this store starts from: a sweep that cannot read everything only
   * ever ADDS to it (only a complete sweep may shrink it), so a daemon that
   * boots while the server is still warming up never wipes the sessions'
   * exclusions with an empty first sweep. A function is called once, at the
   * first sweep or `retiredUris()` — the TUI builds its store before the first
   * paint, which reads no file. */
  initialRetired?: readonly string[] | null | (() => readonly string[] | null);
}

const DEFAULT_READ_CONCURRENCY = 8;
const DEFAULT_CACHE_TTL_MS = 15_000;
/** One full re-read an hour per store: the incremental sweeps in between
 * read only what changed. */
export const DEFAULT_FULL_REFRESH_MS = 60 * 60_000;

export class OpenVikingStore implements MemoryStore {
  private readonly client: OpenVikingClient;
  private readonly root: string;
  private readonly category: string;
  private readonly now: () => Date;
  private readonly log: (msg: string, extra?: unknown) => void;
  /** Category roots known to exist: one lazy mkdir per root per store
   * instance — a second NOT_FOUND is a real error. */
  private readonly ensuredRoots = new Set<string>();
  private readonly concurrency: number;
  private readonly cacheTtlMs: number;
  private readonly fullRefreshMs: number;
  private readonly onRetired: ((uris: readonly string[]) => void) | undefined;
  /** The per-file cache behind the incremental sweep, keyed by
   * entry id. Survives `invalidate()` on purpose: invalidating means "list
   * again", and the listing says which files moved. */
  private known = new Map<string, KnownFile>();
  /** When the last FULL re-read happened (ms), or null before the first. */
  private lastFullAt: number | null = null;
  /** Sweeps of different generations can overlap; only a sweep that STARTED
   * after the one whose file cache is adopted may replace it. */
  private sweepSeq = 0;
  private adoptedSeq = 0;
  /** Files this store rewrote, by id → the sweep sequence current at the
   * write: a sweep that started before it may have read the old bytes, so its
   * record of that file is never adopted. */
  private forgotten = new Map<string, number>();
  private stats: SweepStats | null = null;
  /** Files listed directly in each area by the last adopted sweep
   * (`areaSize`) — a count of the listing, so a file that failed to read
   * still counts; an area whose listing failed keeps its last count (or is
   * `unknown` without one). Null until a sweep was adopted. */
  private listedByArea: { counts: Map<string, number>; unknown: Set<string> } | null = null;

  private cache: { at: number; run: SweepRun } | null = null;
  private inFlight: { gen: number; run: Promise<SweepRun> } | null = null;
  /** The pinned area's own cache — same TTL and generation
   * rules as the sweep's. */
  private pinnedCache: { at: number; gen: number; sweep: PinnedSweep } | null = null;
  private pinnedInFlight: { gen: number; run: Promise<PinnedSweep> } | null = null;
  /** Bumped by every write: a sweep started before it may have read the old
   * bytes, so it neither fills the cache nor serves a later reader. */
  private generation = 0;
  /** Retired URIs from the last sweep that completed un-raced by a write,
   * plus every retire this store has written since. Never expires — see
   * `retiredUris`. Null until one sweep has finished (or `initialRetired`
   * seeded it). Only a sweep that read EVERYTHING may shrink it. */
  private knownRetired: string[] | null = null;
  /** `initialRetired`, not yet taken (see `takeRetiredSeed`). */
  private retiredSeed: (() => readonly string[] | null) | null;

  constructor(opts: OpenVikingStoreOptions) {
    this.client = opts.client;
    this.root = (opts.memoriesRoot ?? opts.client.memoriesRoot()).replace(/\/+$/, "");
    this.category = opts.defaultCategory ?? DEFAULT_CATEGORY;
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? (() => {});
    this.concurrency = Math.max(1, opts.readConcurrency ?? DEFAULT_READ_CONCURRENCY);
    this.cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.fullRefreshMs = Math.max(0, opts.fullRefreshMs ?? DEFAULT_FULL_REFRESH_MS);
    this.onRetired = opts.onRetired;
    const seed = opts.initialRetired;
    this.retiredSeed =
      seed === undefined || seed === null ? null : typeof seed === "function" ? seed : () => seed;
  }

  /** Start `knownRetired` from `initialRetired`, once, before anything reads
   * or replaces it. A seed that throws is no seed. */
  private takeRetiredSeed(): void {
    const seed = this.retiredSeed;
    if (seed === null) return;
    this.retiredSeed = null;
    if (this.knownRetired !== null) return;
    let uris: readonly string[] | null = null;
    try {
      uris = seed();
    } catch {
      uris = null;
    }
    if (uris) this.knownRetired = [...new Set(uris)].sort();
  }

  /** What the last COMPLETED sweep cost, or null before the first. */
  lastSweepStats(): SweepStats | null {
    return this.stats === null ? null : { ...this.stats };
  }

  /**
   * How many files the last adopted sweep LISTED directly in `<root>/<area>/`
   * — retired ones and unread ones included, because the engine indexes them
   * all (it sizes the lesson find's `limit`). Synchronous, no
   * I/O, never starts or waits for a sweep (the round prefetch's
   * `retiredUris()` keeps the sweep fresh). Null before any sweep was
   * adopted, and for an area whose listing failed with no earlier count;
   * 0 for an area listed empty or absent. Never an area `SWEEP_EXCLUDED_AREAS`
   * names (`finding-cases/`): the sweep does not list it, so it is unknown.
   */
  areaSize(area: string): number | null {
    const dir = area.replace(/^\/+|\/+$/g, "");
    if (this.listedByArea === null || dir === "") return null;
    if (SWEEP_EXCLUDED_AREAS.includes(dir.split("/")[0]!)) return null;
    const known = this.listedByArea.counts.get(dir);
    if (known !== undefined) return known;
    for (const u of this.listedByArea.unknown) if (dir === u || dir.startsWith(`${u}/`)) return null;
    return 0;
  }

  uriOf(id: string): string {
    return `${this.root}/${id}`;
  }

  /** Drop the sweep cache. Called after every successful write so a caller
   * that writes and immediately re-reads sees its own edit. The next sweep
   * LISTS again and re-reads every file whose size or modification time moved
   * — the per-file cache is not dropped, because the listing is
   * what says which files changed; a write through THIS store also forgets
   * the file it wrote, so even a same-size edit inside one clock tick is read. */
  invalidate(): void {
    this.cache = null;
    this.pinnedCache = null;
    this.generation += 1;
  }

  /**
   * Materialize this namespace's category root, before anything writes to it.
   *
   * `create()` already self-heals a missing root, and for everything writing
   * through THIS class that is enough. It is not enough for the companion,
   * because the companion does not write through this class — it writes
   * through the vendored pi extension, which chooses WHICH user namespace to
   * write into by listing `viking://user/` and picking a directory that
   * exists (`resolveScopeSpace`, extensions/vendor/openviking-pi/client.ts).
   *
   * To that resolver a namespace nobody has written to yet is not an empty
   * namespace — it is an absent one. It silently falls back to `user/default`,
   * whose `memories/` tree does not exist either, and every write is then
   * refused — with an error ("access denied") that names neither the
   * namespace nor the missing directory.
   *
   * So the root is created EAGERLY for each namespace, before the companion
   * container starts and its extension caches that resolution. Idempotent
   * (`mkdir` treats "already exists" as success) and total, like every other
   * method here: a dead server is a refusal, never a throw.
   */
  async ensureWritable(): Promise<MemoryWriteResult> {
    const uri = `${this.root}/${this.category}`;
    if (this.ensuredRoots.has(uri)) return { ok: true, message: `${uri} ready` };
    if (await this.client.mkdir(uri)) {
      this.ensuredRoots.add(uri);
      return { ok: true, message: `${uri} ready` };
    }
    return { ok: false, message: `could not create the memory root ${uri}` };
  }

  /**
   * Every entry the store holds, oldest first, retirements filtered out.
   *
   * Total by construction: a server that is down yields `[]`, and a single
   * unreadable file is skipped rather than losing the sweep. `[]` therefore
   * means "nothing to show" for BOTH an empty store and an unread one — the
   * right answer for a timeline. A caller that must tell the two apart (the
   * round's pinned head) uses `sweep()`, which keeps the distinction.
   */
  async read(): Promise<MemoryEntry[]> {
    return (await this.sweep()).entries;
  }

  /**
   * The same sweep, with the parts it could not read kept beside the entries.
   * Cached and single-flight exactly like `read()` — the two share one sweep,
   * so the round path and the TUI poll never double the server's load.
   */
  async sweep(): Promise<MemorySweep> {
    return (await this.sweepRun()).sweep;
  }

  /**
   * The URIs of every retired entry, for the round's context search to pass
   * as `excludeUris`. `read()` hides a retirement by filtering, but the file
   * stays under the indexed memories root, so a semantic search would still
   * recall it.
   *
   * Answers from the LAST COMPLETED sweep whatever its age, and waits for a
   * sweep only when none has ever completed; a list older than the cache TTL
   * starts a fresh sweep in the background for the next caller
   * (`refreshInBackground`). The cache is nearly always cold at a round, and
   * waiting here would put a whole store sweep in series in front of the
   * search. Retirements are rare and this store records its own (and its
   * moves' stubs) the moment they land, so a list one round old costs at most
   * one round's recall of an entry retired elsewhere. (A store seeded with
   * `initialRetired` answers from that until its first sweep.)
   */
  async retiredUris(): Promise<string[]> {
    this.takeRetiredSeed();
    if (this.knownRetired !== null) {
      this.refreshInBackground();
      return [...this.knownRetired];
    }
    return [...(await this.sweepRun()).retired];
  }

  /**
   * Start a sweep for the NEXT caller when the last one is older than the
   * cache TTL — never awaited, never thrown. The round's pinned head reads
   * the pinned directory alone, so it is the round's context search that
   * keeps the retired list (this store's exclusions, and the file the
   * sessions' recall reads) fresh, through this, off its critical path.
   */
  private refreshInBackground(): void {
    if (this.inFlight && this.inFlight.gen === this.generation) return;
    if (this.cache && this.now().getTime() - this.cache.at < this.cacheTtlMs) return;
    void this.sweepRun().catch(() => {
      /* total by construction; a sweep that failed is retried next time */
    });
  }

  private async sweepRun(): Promise<SweepRun> {
    const fresh = this.cache && this.now().getTime() - this.cache.at < this.cacheTtlMs;
    if (fresh && this.cache) return this.cache.run;
    // One sweep at a time: the round path and the TUI poll can both land here.
    if (this.inFlight && this.inFlight.gen === this.generation) return this.inFlight.run;
    const gen = this.generation;
    const run = this.runSweep(gen).finally(() => {
      if (this.inFlight?.run === run) this.inFlight = null;
    });
    this.inFlight = { gen, run };
    return run;
  }

  /**
   * One sweep, incremental: every category is listed, and a
   * file is read only when its listed size or modification time differs from
   * the read this store already holds (or it has none, or the listing carries
   * no modTime) — except on a periodic FULL refresh (`fullRefreshMs`), which
   * reads everything. A file that fails to read is unread exactly as before
   * and forgotten, so the next sweep tries it again; a category that fails to
   * LIST keeps its files' cached reads for when it lists again, but none of
   * them is served while it does not.
   */
  private async runSweep(gen: number): Promise<SweepRun> {
    this.takeRetiredSeed();
    const seq = (this.sweepSeq += 1);
    const startedAt = this.now().getTime();
    const full =
      this.fullRefreshMs === 0 ||
      this.lastFullAt === null ||
      startedAt - this.lastFullAt >= this.fullRefreshMs;
    const unread: string[] = [];
    let retired: string[] = [];
    const listing = await this.listFiles(unread);
    const { files } = listing;
    const prior = this.known;
    const next = new Map<string, KnownFile>();
    let vanished = 0;
    let reread = 0;
    let reused = 0;
    await pool(files, this.concurrency, async (file) => {
      const sig = signatureOf(file);
      const had = prior.get(file.id);
      if (!full && sig !== null && had !== undefined && had.sig === sig) {
        next.set(file.id, had);
        reused += 1;
        return;
      }
      reread += 1;
      const uri = this.uriOf(file.id);
      const res = await this.client.readContent(uri);
      if (!res.ok) {
        if (res.code === "NOT_FOUND") vanished += 1;
        else unread.push(`read ${uri}: ${res.message}`);
        return;
      }
      const entry = entryFrom(file.id, res.result, file.modTime);
      if (entry.text === "") {
        next.set(file.id, { sig, entry: null, retired: false });
        return;
      }
      // Header-only, like `pinned`: a [feedback] entry quoting "#retired"
      // must not vanish from every read. `retire` writes the tag at the head.
      next.set(file.id, {
        sig,
        entry,
        retired: parseHashTags(entry.text).includes(RETIRED_TAG),
      });
    });
    const entries: MemoryEntry[] = [];
    const retiredEntries: MemoryEntry[] = [];
    for (const file of files) {
      const known = next.get(file.id);
      if (!known || known.entry === null) continue;
      if (known.retired) {
        retired.push(this.uriOf(file.id));
        retiredEntries.push(known.entry);
      } else entries.push(known.entry);
    }
    // One file gone between the listing and the read is a race (the companion
    // can forget an entry; this store never deletes). EVERY listed file gone
    // is not a race — it is a server whose listing and content disagree — and
    // a head built on it could be missing every standing instruction, so it
    // is unread rather than an exact, empty answer. (Only a sweep that READ
    // every listed file can say that; the hourly full refresh is one.)
    if (files.length > 0 && reread === files.length && vanished === files.length) {
      unread.push(
        `read ${this.root}: all ${files.length} listed files answered NOT_FOUND — the listing and the content disagree`,
      );
    }
    entries.sort(byTsThenId);
    retiredEntries.sort(byTsThenId);
    // A sweep that could not read everything never SHRINKS the retired list:
    // the published list is what every session's recall excludes, and a root
    // or category that failed to list, or a file that failed to read, says
    // nothing about whether its entries are still retired. It keeps what was
    // known (the last list, the cached reads it could not re-check) and adds
    // what it saw; only a complete sweep may drop a URI.
    if (unread.length > 0) {
      const keep = new Set(retired);
      for (const uri of this.knownRetired ?? []) keep.add(uri);
      for (const [id, known] of prior) if (known.retired && !next.has(id)) keep.add(this.uriOf(id));
      retired = [...keep];
    }
    retired.sort();
    // The file cache: what this sweep read or kept, plus the cached reads of
    // any category it could not list (kept for when it lists again). A root
    // that could not be listed changes nothing.
    if (listing.rootListed && seq > this.adoptedSeq) {
      for (const [id, known] of prior) {
        if (underFailedDir(id, listing.failedDirs) && !next.has(id)) next.set(id, known);
      }
      for (const [id, at] of this.forgotten) {
        if (at >= seq) next.delete(id);
        else this.forgotten.delete(id);
      }
      this.known = next;
      this.adoptedSeq = seq;
      if (full) this.lastFullAt = startedAt;
      // Each listed directory counts the files directly in it
      // (`experiences/x.md` is `experiences`'; `preferences/pinned/x.md` is
      // `preferences/pinned`'s, never `preferences`'). A directory whose
      // listing failed keeps its last count, or is unknown without one.
      const counts = new Map<string, number>();
      for (const file of files) {
        const cut = file.id.lastIndexOf("/");
        if (cut < 0) continue;
        const dir = file.id.slice(0, cut);
        counts.set(dir, (counts.get(dir) ?? 0) + 1);
      }
      // A failed listing hides its subdirectories too: they keep their last
      // counts like it, and with none they read unknown (`areaSize` matches
      // an unknown directory by prefix).
      const unknown = new Set<string>();
      const prev = this.listedByArea;
      for (const dir of listing.failedDirs) {
        const under = (d: string): boolean => d === dir || d.startsWith(`${dir}/`);
        for (const d of [...counts.keys()]) if (under(d)) counts.delete(d);
        if (prev) for (const [d, n] of prev.counts) if (under(d)) counts.set(d, n);
        if (!counts.has(dir)) unknown.add(dir);
        if (prev) for (const d of prev.unknown) if (under(d)) unknown.add(d);
      }
      this.listedByArea = { counts, unknown };
    }
    const run: SweepRun = { sweep: { entries, unread, retired: retiredEntries }, retired };
    this.stats = { full, listed: files.length, reread, reused };
    if (gen === this.generation) {
      this.cache = { at: this.now().getTime(), run };
      this.setKnownRetired([...retired]);
    }
    return run;
  }

  /** Record the retired list, telling `onRetired` when it changed (and the
   * first time it is known at all). */
  private setKnownRetired(next: string[]): void {
    const prev = this.knownRetired;
    this.knownRetired = next;
    if (this.onRetired === undefined) return;
    if (prev !== null && prev.length === next.length && prev.every((u, i) => u === next[i])) return;
    try {
      this.onRetired([...next]);
    } catch {
      /* the publication is best-effort; the store never throws */
    }
  }

  /**
   * The memory tree, three levels deep: `<root>/<area>/<file>`,
   * `<root>/<area>/<sub>/<file>` (`preferences/pinned/`) plus any file
   * sitting directly in the root — every area but the ones
   * `SWEEP_EXCLUDED_AREAS` names (`finding-cases/`, the daemon's derived
   * documents, written by `putDocuments` and read through the server's search
   * alone). A bounded depth is the whole convention — a
   * recursive walk against a store this system fully owns would only ever be
   * finding files it did not write.
   *
   * A listing that fails is recorded in `unread` — except NOT_FOUND, which is
   * an absent directory and therefore a known-empty one (see `MemorySweep`).
   */
  private async listFiles(unread: string[]): Promise<{
    files: Array<{ id: string; size: number; modTime: string }>;
    /** The root answered (an absent root is an answer: known-empty). */
    rootListed: boolean;
    /** Areas (`events`, `preferences/pinned`) whose listing failed (not
     * NOT_FOUND) — their cached reads are kept for when they list again. */
    failedDirs: Set<string>;
  }> {
    const failedDirs = new Set<string>();
    const top = await this.client.ls(this.root);
    if (!top.ok) {
      if (top.code !== "NOT_FOUND") {
        unread.push(`ls ${this.root}: ${top.message}`);
        return { files: [], rootListed: false, failedDirs };
      }
      return { files: [], rootListed: true, failedDirs };
    }
    const out: Array<{ id: string; size: number; modTime: string }> = [];
    const dirs: string[] = [];
    for (const row of top.result) {
      if (row.isDir) {
        // `finding-cases/` is the daemon's derived documents, not curated memory
        // (`SWEEP_EXCLUDED_AREAS`): never listed here.
        if (!row.name.startsWith(".") && !SWEEP_EXCLUDED_AREAS.includes(row.name))
          dirs.push(row.name);
      } else if (isTextFile(row.name)) {
        out.push({ id: row.name, size: row.size, modTime: row.modTime });
      }
    }
    const listDir = async (dir: string, deeper: boolean): Promise<void> => {
      const uri = `${this.root}/${dir}`;
      const sub = await this.client.ls(uri);
      if (!sub.ok) {
        if (sub.code !== "NOT_FOUND") {
          unread.push(`ls ${uri}: ${sub.message}`);
          failedDirs.add(dir);
        }
        return;
      }
      const subdirs: string[] = [];
      for (const row of sub.result) {
        if (row.isDir) {
          if (deeper && !row.name.startsWith(".")) subdirs.push(`${dir}/${row.name}`);
        } else if (isTextFile(row.name)) {
          out.push({ id: `${dir}/${row.name}`, size: row.size, modTime: row.modTime });
        }
      }
      await pool(subdirs, this.concurrency, (d) => listDir(d, false));
    };
    await pool(dirs, this.concurrency, (dir) => listDir(dir, true));
    return { files: out, rootListed: true, failedDirs };
  }

  /**
   * The pinned area and nothing else: one listing of
   * `preferences/pinned/` and a read of every file in it — never the rest of
   * the store, never a file from the incremental cache (the head is exact:
   * every byte read now). Cached for `cacheTtlMs` like a sweep, and dropped by
   * `invalidate()`. Total: a dead server is `unread`, never a throw; an absent
   * directory is known-empty (`entries: []`, nothing unread) — a fresh
   * install's healthy answer. Retired entries are left out.
   */
  async pinnedSweep(): Promise<PinnedSweep> {
    const fresh =
      this.pinnedCache &&
      this.pinnedCache.gen === this.generation &&
      this.now().getTime() - this.pinnedCache.at < this.cacheTtlMs;
    if (fresh && this.pinnedCache) return this.pinnedCache.sweep;
    if (this.pinnedInFlight && this.pinnedInFlight.gen === this.generation)
      return this.pinnedInFlight.run;
    const gen = this.generation;
    const run = this.readPinnedArea().then((sweep) => {
      if (gen === this.generation) this.pinnedCache = { at: this.now().getTime(), gen, sweep };
      return sweep;
    });
    const tracked = run.finally(() => {
      if (this.pinnedInFlight?.run === tracked) this.pinnedInFlight = null;
    });
    this.pinnedInFlight = { gen, run: tracked };
    return tracked;
  }

  private async readPinnedArea(): Promise<PinnedSweep> {
    const unread: string[] = [];
    const dir = `${this.root}/${PINNED_AREA}`;
    try {
      const listed = await this.client.ls(dir);
      if (!listed.ok) {
        if (listed.code === "NOT_FOUND") return { entries: [], unread };
        return { entries: [], unread: [`ls ${dir}: ${listed.message}`] };
      }
      const files = listed.result.filter((r) => !r.isDir && isTextFile(r.name));
      const entries: MemoryEntry[] = [];
      let vanished = 0;
      await pool(files, this.concurrency, async (file) => {
        const id = `${PINNED_AREA}/${file.name}`;
        const res = await this.client.readContent(this.uriOf(id));
        if (!res.ok) {
          if (res.code === "NOT_FOUND") vanished += 1;
          else unread.push(`read ${this.uriOf(id)}: ${res.message}`);
          return;
        }
        const entry = entryFrom(id, res.result, file.modTime);
        if (entry.text === "" || parseHashTags(entry.text).includes(RETIRED_TAG)) return;
        entries.push(entry);
      });
      // Every listed file gone: the listing and the content disagree, and an
      // empty head built on that could be missing every standing instruction.
      if (files.length > 0 && vanished === files.length)
        unread.push(
          `read ${dir}: all ${files.length} listed files answered NOT_FOUND — the listing and the content disagree`,
        );
      entries.sort(byTsThenId);
      return { entries, unread };
    } catch (err) {
      return {
        entries: [],
        unread: [`ls ${dir}: ${err instanceof Error ? err.message : String(err)}`],
      };
    }
  }

  /**
   * Free-text / tag matching over the entries, NOT a vector search.
   *
   * Deliberate: `search()` returns ADDRESSABLE entries — every hit carries the
   * hash a management verb writes back with — and OpenViking's context search
   * returns budgeted, tier-degraded prose (an abstract, an overview) whose
   * bytes are not the stored bytes. Handing those back would mint hashes that
   * 409 on first use. The semantic surface is `OpenVikingClient.searchContext`
   * and it is consumed by the round's context block, where nothing is
   * addressed.
   */
  async search(query: string, opts?: MemorySearchOptions): Promise<MemoryEntry[]> {
    const hits = (await this.read()).filter((e) => matchesQuery(e, query, opts));
    const limit = opts?.limit;
    return limit !== undefined && limit >= 0 ? hits.slice(0, limit) : hits;
  }

  /**
   * One mutation, through `content/batch-write` and nothing else.
   *
   * Resolves for every outcome, per the seam's contract: a stale hash is
   * `{ok:false}` with a sentence an operator can act on, and so is a dead
   * server. A caller must never have to tell a refusal from an outage to know
   * whether memory changed — in both cases it did not.
   */
  async apply(op: MemoryOp): Promise<MemoryWriteResult> {
    try {
      // The owner's own words are standing instructions: `preferences/`.
      if (op.op === "add")
        return await this.create(renderEntryBody(op.text, [MANUAL_TAG]), PREFERENCES_AREA);
      if (op.op === "note") {
        const body = renderEntryBody(op.text);
        return await this.create(
          body,
          op.category ?? areaForNewEntry(body, this.category),
          op.name,
        );
      }
      if (!validEntryId(op.id))
        return {
          ok: false,
          message: `refused: '${op.id}' is not a memory address this store can spell`,
        };
      if (!/^sha256:[0-9a-f]{64}$/.test(op.expect)) {
        return {
          ok: false,
          message:
            "refused: this entry was listed without a usable concurrency token — re-read it and retry",
        };
      }
      const current = await this.client.readContent(this.uriOf(op.id));
      if (!current.ok) {
        return {
          ok: false,
          message: `memory write failed: could not read ${op.id} (${current.code})`,
        };
      }
      const entry = entryFrom(op.id, current.result, "");
      if (entry.hash !== op.expect) {
        // Caught before the round trip, but the server's 409 is the real
        // guard — this is only a cheaper, clearer version of the same answer.
        // The caller's copy may have come from this store's own file cache,
        // which a same-size rewrite inside one modTime second cannot move:
        // forget the file, so the re-read the refusal asks for is a real one.
        this.forget(op.id);
        return {
          ok: false,
          message: "refused: the entry changed since you read it — re-read it and retry",
        };
      }
      // Pin and unpin move the entry: into the pinned area, and
      // back to where it came from. On an entry already where the verb would
      // put it, they only fix its tag in place.
      if (op.op === "pin" && !isPinnedId(op.id)) {
        const area = areaOfId(op.id);
        const tagged = area === "" ? entry.text : withHeaderTags(entry.text, { [FROM_TAG]: area });
        return await this.move(op.id, op.expect, pinnedIdFor(op.id), withTag(tagged, PINNED_TAG));
      }
      if (op.op === "unpin" && isPinnedId(op.id)) {
        const to = `${unpinTargetArea(entry.text)}/${nameOfId(op.id)}`;
        const body = renderEntryBody(
          withoutHeaderTag(withoutTag(entry.text, PINNED_TAG), FROM_TAG),
        );
        return await this.move(op.id, op.expect, to, body);
      }
      const next = this.rewrite(op, entry.text);
      if (next === null)
        return { ok: false, message: `refused: unknown memory op '${(op as { op: string }).op}'` };
      if (next.trim() === "")
        return {
          ok: false,
          message: "refused: an edit may not empty an entry — retire it instead",
        };
      const res = await this.replace(op.id, next, op.expect);
      if (res.ok && op.op === "retire" && this.knownRetired !== null) {
        const uri = this.uriOf(op.id);
        if (!this.knownRetired.includes(uri))
          this.setKnownRetired([...this.knownRetired, uri].sort());
      }
      return res;
    } catch (err) {
      // The client is total, but a caller-supplied seam is not, and a write
      // that throws would break the one promise the whole phase rests on.
      return {
        ok: false,
        message: `memory write failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /** The new body for an addressed op. Null for an op this store cannot spell
   * (the union is closed, so this is belt-and-braces against a newer caller). */
  private rewrite(op: MemoryOp, text: string): string | null {
    switch (op.op) {
      case "edit":
        // Verbatim: the caller supplies the
        // whole block, tags included, and gets what it wrote.
        return renderEntryBody(op.text);
      case "pin":
        return withTag(text, PINNED_TAG);
      case "unpin":
        return withoutTag(text, PINNED_TAG);
      case "retire":
        return withTag(text, RETIRED_TAG);
      default:
        return null;
    }
  }

  /**
   * Create a new entry. `create_if_absent` makes a name collision a 409 rather
   * than a silent overwrite of somebody else's memory, so a collision is
   * retried under a fresh name — two writers in the same second is ordinary,
   * losing one of their entries is not.
   *
   * A named create (`note` with `name`) is never renamed: the
   * address IS the writer's idempotency key. The server answers a replay of
   * the same bytes `unchanged` (landed — a plain success), and a 409 there
   * means the address already holds other bytes, which is KEPT and reported
   * `existed`. Only the precondition 409 means that: a BUSY 409 never
   * reaches here as a conflict (the client retries it, then fails it).
   */
  private async create(
    body: string,
    category: string = this.category,
    name?: string,
  ): Promise<MemoryWriteResult> {
    if (body.trim() === "") return { ok: false, message: "refused: an empty memory entry" };
    if (!validArea(category))
      return {
        ok: false,
        message: `refused: '${category}' is not a memory area this store can spell`,
      };
    if (name !== undefined && !validEntryId(`${category}/${name}.md`))
      return { ok: false, message: `refused: '${name}' is not an entry name this store can spell` };
    const dir = `${this.root}/${category}`;
    const ts = tsFromModTime(this.now().toISOString());
    const stamp = stampOf(ts);
    let mkdirTried = false;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const suffix = createHash("sha256").update(`${body}#${attempt}`).digest("hex").slice(0, 8);
      const id =
        name !== undefined ? `${category}/${name}.md` : `${category}/${stamp}-${suffix}.md`;
      const uri = this.uriOf(id);
      const res = await this.client.batchWrite({
        root_uri: dir,
        operations: [{ uri, content: body, precondition: { kind: "create_if_absent" } }],
        // The bytes are durable without waiting; only searchability lags, and
        // ~1.6 core-seconds of index refresh must never sit on a caller.
        wait: false,
      });
      if (res.ok && batchWriteLanded(res.result, uri)) {
        this.invalidate();
        await this.mirrorTags(uri, body);
        const same = res.result.unchanged.includes(uri);
        return { ok: true, message: same ? `already present: ${id}` : `wrote ${id}`, uri };
      }
      if (res.ok)
        return {
          ok: false,
          message: `memory write failed: the server accepted the batch without writing ${id}`,
        };
      // A fresh server holds only `viking://user/default`: our category root
      // does not exist until something makes it, and batch-write 404s rather
      // than creating it. Make it once, here, and let the loop retry — the
      // alternative is a bootstrap step that a restart or a new category
      // silently outlives.
      if (res.code === "NOT_FOUND" && !this.ensuredRoots.has(dir) && !mkdirTried) {
        mkdirTried = true;
        // Recorded only on success: a transient mkdir failure must leave the
        // next write (and ensureWritable) free to try again. One attempt per
        // call still holds — a failed mkdir falls through to the refusal below.
        if (await this.client.mkdir(dir)) {
          this.ensuredRoots.add(dir);
          this.log(`openviking: created the memory root ${dir}`);
          continue;
        }
      }
      if (!res.conflict) return { ok: false, message: `memory write failed: ${res.message}` };
      if (name !== undefined) {
        return {
          ok: true,
          existed: true,
          uri,
          message: `kept ${id}: an entry is already there with other bytes (never overwritten)`,
        };
      }
      this.log(`openviking: memory name ${id} taken — retrying under a fresh name`);
    }
    return { ok: false, message: "refused: could not find a free name for this entry" };
  }

  private async replace(id: string, body: string, expect: string): Promise<MemoryWriteResult> {
    const uri = this.uriOf(id);
    const res = await this.client.batchWrite({
      root_uri: parentOf(uri),
      operations: [
        { uri, content: body, precondition: { kind: "replace_if_hash", base_hash: expect } },
      ],
      wait: false,
    });
    if (res.ok && batchWriteLanded(res.result, uri)) {
      this.forget(id);
      await this.mirrorTags(uri, body);
      return { ok: true, message: `updated ${id}` };
    }
    if (res.ok)
      return {
        ok: false,
        message: `memory write failed: the server accepted the batch without writing ${id}`,
      };
    if (res.conflict) {
      // Somebody else wrote it: the cached read is stale too (see apply).
      this.forget(id);
      return {
        ok: false,
        message: "refused: the entry changed since you read it — re-read it and retry",
      };
    }
    return { ok: false, message: `memory write failed: ${res.message}` };
  }

  /**
   * Move one entry: create `to` holding `body`, then replace
   * `from` — still the bytes hashed `expect`, or nothing happens — with the
   * `#moved` stub. Two batch-writes, each under its own directory: the server
   * locks the root it writes under, and that root must be a directory inside
   * a memory area, so no one root covers two areas. The new copy goes FIRST,
   * so the bytes are never only in a stub.
   *
   * If the stub PROVABLY did not land (a precondition refusal, or a re-read
   * that finds the source still holding the bytes we hashed), the new copy is
   * turned back into a pointer at the source (`movedStub(from)` — which is
   * exactly the stub it replaced, when an entry was moving back), so a failed
   * move leaves one live copy and an address a retry may write over again. If
   * the outcome cannot be proven either way (a timeout, a lost answer, a
   * source holding other bytes, a re-read that fails), NOTHING is undone: two
   * live copies are recoverable by hand, and retiring the only live one is
   * not. (A copy write whose answer was lost is read back the same way —
   * `createExact`.)
   */
  private async move(
    from: string,
    expect: string,
    to: string,
    body: string,
  ): Promise<MemoryWriteResult> {
    if (!validEntryId(to))
      return {
        ok: false,
        message: `refused: '${to}' is not a memory address this store can spell`,
      };
    const content = renderEntryBody(body);
    if (content === "")
      return { ok: false, message: "refused: a move may not empty an entry — retire it instead" };
    const toUri = this.uriOf(to);
    const placed = await this.createExact(toUri, content);
    if (!placed.ok) return { ok: false, message: placed.message };
    const fromUri = this.uriOf(from);
    const stub = movedStub(to);
    const res = await this.client.batchWrite({
      root_uri: parentOf(fromUri),
      operations: [
        {
          uri: fromUri,
          content: stub,
          precondition: { kind: "replace_if_hash", base_hash: expect },
        },
      ],
      wait: false,
    });
    // A 200 naming the stub: it landed. A refusal (`provenUnwritten` — a
    // precondition is checked before the first write): it did not. Anything
    // else — a timeout, a lost connection, a 5xx, a 200 naming nothing —
    // proves nothing: the batch may have committed after its answer was lost,
    // so the source is read back before anything is undone.
    const outcome =
      res.ok && batchWriteLanded(res.result, fromUri)
        ? "landed"
        : !res.ok && provenUnwritten(res)
          ? "absent"
          : await this.writeOutcome(fromUri, stub, expect);
    this.forget(from);
    this.forget(to);
    const why = res.ok ? `the server accepted the batch without writing ${from}` : res.message;
    if (outcome === "landed") {
      this.noteRetired(fromUri);
      await this.mirrorTags(toUri, content);
      const confirmed = res.ok && batchWriteLanded(res.result, fromUri);
      return {
        ok: true,
        message: confirmed
          ? `moved ${from} → ${to}`
          : `moved ${from} → ${to} (its answer was lost — ${why}; a re-read confirmed it)`,
        uri: toUri,
      };
    }
    if (outcome === "unknown") {
      this.log(
        `openviking: a move of ${from} to ${to} has an unknown outcome — both left as found`,
      );
      return {
        ok: false,
        message:
          `memory write failed: ${why} — the move's outcome is unknown: ${to} holds the new copy ` +
          `and ${from} could not be confirmed either way, so both are left as they are; read memory ` +
          `again and retire the copy that should not stay`,
      };
    }
    const undone = await this.unplaceCopy(toUri, content, from);
    const left = undone
      ? ""
      : ` — and the new copy at ${to} could not be turned back into a pointer: retire it`;
    if (!res.ok && res.conflict)
      return {
        ok: false,
        message: `refused: the entry changed since you read it — nothing moved; re-read it and retry${left}`,
      };
    return {
      ok: false,
      message: `memory write failed: ${why} — nothing moved${left}`,
    };
  }

  /**
   * After a write whose answer proves nothing (a timeout, a lost connection,
   * a 5xx, a 200 that names nothing): did it land? `landed` when `uri` now
   * holds exactly `wrote`; `absent` when it still holds the bytes hashed
   * `before` (`null` = it did not exist, and still does not); `unknown`
   * otherwise — other bytes, or a read that failed. Never guessed.
   */
  private async writeOutcome(
    uri: string,
    wrote: string,
    before: string | null,
  ): Promise<"landed" | "absent" | "unknown"> {
    const now = await this.client.readContent(uri);
    if (!now.ok) return before === null && now.code === "NOT_FOUND" ? "absent" : "unknown";
    if (now.result === wrote) return "landed";
    if (before !== null && sha256Prefixed(now.result) === before) return "absent";
    return "unknown";
  }

  /** Create `uri` holding exactly `content` — landed when it was created or
   * was already there byte for byte (a half-finished earlier move); refused
   * when it holds other bytes, unless those bytes are a `#moved` stub (an
   * entry moving back to where it once was, or the pointer a failed move left
   * behind: the stub is only a pointer, and it is replaced under its own
   * hash). A write whose answer was lost is read back: landed if the bytes
   * are there. Makes the area directory once if it is missing. */
  private async createExact(
    uri: string,
    content: string,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const dir = parentOf(uri);
    let precondition:
      { kind: "create_if_absent" } | { kind: "replace_if_hash"; base_hash: string } = {
      kind: "create_if_absent",
    };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const res = await this.client.batchWrite({
        root_uri: dir,
        operations: [{ uri, content, precondition }],
        wait: false,
      });
      if (res.ok && batchWriteLanded(res.result, uri)) return { ok: true };
      if (
        !res.ok &&
        res.code === "NOT_FOUND" &&
        precondition.kind === "create_if_absent" &&
        !this.ensuredRoots.has(dir)
      ) {
        if (await this.client.mkdir(dir)) {
          this.ensuredRoots.add(dir);
          continue;
        }
      }
      if (!res.ok && res.conflict && precondition.kind === "create_if_absent") {
        const there = await this.client.readContent(uri);
        if (there.ok && isMovedStub(there.result)) {
          precondition = { kind: "replace_if_hash", base_hash: sha256Prefixed(there.result) };
          continue;
        }
      }
      if (!res.ok && res.conflict)
        return {
          ok: false,
          message: `refused: ${uri} already holds another entry — nothing moved`,
        };
      if (!res.ok && provenUnwritten(res))
        return { ok: false, message: `memory write failed: ${res.message}` };
      // An answer that proves nothing: the copy may have landed anyway.
      const there = await this.client.readContent(uri);
      if (there.ok && there.result === content) return { ok: true };
      return {
        ok: false,
        message: `memory write failed: ${res.ok ? `the server accepted the batch without writing ${uri}` : res.message}`,
      };
    }
    return { ok: false, message: `memory write failed: could not create the area of ${uri}` };
  }

  /** Undo a copy this store just wrote at `uri` (`content` is its exact
   * bytes) for an entry that provably still lives at `from`: the copy becomes
   * a `#moved` stub pointing back there — retired, so no reader shows it,
   * and a pointer, so a later move may write over it (a retired COPY would
   * block every later move into that address for good). True when it landed. */
  private async unplaceCopy(uri: string, content: string, from: string): Promise<boolean> {
    const res = await this.client.batchWrite({
      root_uri: parentOf(uri),
      operations: [
        {
          uri,
          content: movedStub(from),
          precondition: { kind: "replace_if_hash", base_hash: sha256Prefixed(content) },
        },
      ],
      wait: false,
    });
    if (res.ok && batchWriteLanded(res.result, uri)) {
      this.noteRetired(uri);
      return true;
    }
    this.log(`openviking: a failed move left ${uri} live and could not undo it`);
    return false;
  }

  /** A retirement this store wrote joins the published list at once. */
  private noteRetired(uri: string): void {
    if (this.knownRetired !== null && !this.knownRetired.includes(uri))
      this.setKnownRetired([...this.knownRetired, uri].sort());
  }

  /**
   * Many moves and in-place rewrites at once — the relayout's executor
   * (`qcr memory relayout --apply`), and nothing else's.
   *
   * Every write is a batch-write with a precondition, ONE per directory root
   * (chunked at the server's 256 operations): first every new copy
   * (`create_if_absent`, grouped by destination), then every source — a
   * `#moved` stub for a moved entry, the new bytes for one rewritten in place
   * — under `replace_if_hash` of the bytes the plan read (grouped by where it
   * sits). A source is touched only when its new copy landed. A batch the
   * server refuses writes nothing (its preconditions are checked before the
   * first write); the new copies of moves whose source batch was refused are
   * turned back into pointers at their sources (`movedStub(source)`), so a
   * refused batch leaves one live copy each and a re-run may move them again.
   * A batch whose answer proves nothing (a timeout, a lost connection, a
   * 5xx) may have committed anyway, so each of its items is READ BACK: a
   * landed write is a success, a provably absent one is handled as refused,
   * and one that cannot be proven either way is left exactly as found and
   * reported — the only live copy of an entry is never undone on a guess.
   * Nothing is ever deleted. Total: every outcome is reported per item, never
   * thrown.
   */
  async relocate(items: readonly RelocateItem[]): Promise<RelocateReport> {
    const results = new Map<string, RelocateResult>();
    const batches: RelocateReport["batches"] = [];
    const ok = (it: RelocateItem, message: string): void => {
      results.set(it.id, { id: it.id, ...(it.to ? { to: it.to } : {}), ok: true, message });
    };
    const fail = (it: RelocateItem, message: string): void => {
      results.set(it.id, { id: it.id, ...(it.to ? { to: it.to } : {}), ok: false, message });
    };
    const valid: RelocateItem[] = [];
    const seen = new Set<string>();
    for (const it of items) {
      if (!validEntryId(it.id) || (it.to !== undefined && !validEntryId(it.to)))
        fail(it, "refused: not a memory address this store can spell");
      else if (!/^sha256:[0-9a-f]{64}$/.test(it.expect))
        fail(it, "refused: no usable concurrency token — re-plan");
      else if (renderEntryBody(it.text) === "") fail(it, "refused: an entry may not be emptied");
      else if (seen.has(it.id) || (it.to !== undefined && seen.has(it.to)))
        fail(it, "refused: the plan names this address twice");
      else {
        seen.add(it.id);
        if (it.to !== undefined) seen.add(it.to);
        valid.push(it);
      }
    }
    const content = (it: RelocateItem): string => renderEntryBody(it.text);

    // Phase 1 — every new copy, one batch per destination directory.
    const moves = valid.filter((it) => it.to !== undefined);
    const placed = new Set<string>();
    for (const [root, group] of groupBy(moves, (it) => parentOf(this.uriOf(it.to!)))) {
      for (const chunk of chunks(group, BATCH_MAX_OPERATIONS)) {
        const out = await this.batchWithArea(
          root,
          chunk.map((it) => ({
            uri: this.uriOf(it.to!),
            content: content(it),
            precondition:
              it.toExpect !== undefined
                ? { kind: "replace_if_hash" as const, base_hash: it.toExpect }
                : { kind: "create_if_absent" as const },
          })),
        );
        batches.push({ root, ops: chunk.length, ok: out.ok, message: out.message });
        const unsure: RelocateItem[] = [];
        for (const it of chunk) {
          if (out.landed.has(this.uriOf(it.to!))) placed.add(it.id);
          else if (out.refused) fail(it, out.message);
          else unsure.push(it);
        }
        // An answer that proves nothing: a copy that is there byte for byte
        // landed; any other copy is not placed, and its source is not touched.
        await pool(unsure, this.concurrency, async (it) => {
          const there = await this.client.readContent(this.uriOf(it.to!));
          if (there.ok && there.result === content(it)) placed.add(it.id);
          else fail(it, out.ok ? `the server did not write ${it.to}` : out.message);
        });
      }
    }

    // Phase 2 — every source: a stub after a landed move, or its rewrite.
    // ONLY a move whose new copy landed: a stub over a source whose copy is
    // not there would leave the entry's bytes nowhere live.
    const sources = valid.filter((it) => it.to === undefined || placed.has(it.id));
    const unplace: RelocateItem[] = [];
    for (const [root, group] of groupBy(sources, (it) => parentOf(this.uriOf(it.id)))) {
      for (const chunk of chunks(group, BATCH_MAX_OPERATIONS)) {
        const wrote = (it: RelocateItem): string =>
          it.to !== undefined ? movedStub(it.to) : content(it);
        const out = await this.batchWithArea(
          root,
          chunk.map((it) => ({
            uri: this.uriOf(it.id),
            content: wrote(it),
            precondition: { kind: "replace_if_hash" as const, base_hash: it.expect },
          })),
        );
        batches.push({ root, ops: chunk.length, ok: out.ok, message: out.message });
        const done = (it: RelocateItem, how = ""): void =>
          ok(it, `${it.to !== undefined ? `moved → ${it.to}` : "rewritten in place"}${how}`);
        const unsure: RelocateItem[] = [];
        for (const it of chunk) {
          if (out.landed.has(this.uriOf(it.id))) done(it);
          else if (out.refused) {
            fail(it, out.message);
            if (it.to !== undefined) unplace.push(it);
          } else unsure.push(it);
        }
        // The batch may have committed after its answer was lost: read each
        // source back. Undo a copy only when its source PROVABLY still holds
        // the bytes the plan read; never on a guess.
        await pool(unsure, this.concurrency, async (it) => {
          const why = out.ok ? `the server did not write ${it.id}` : out.message;
          const outcome = await this.writeOutcome(this.uriOf(it.id), wrote(it), it.expect);
          if (outcome === "landed")
            done(it, ` (its answer was lost — ${why}; a re-read confirmed it)`);
          else if (outcome === "absent") {
            fail(it, `${why} — nothing written`);
            if (it.to !== undefined) unplace.push(it);
          } else
            fail(
              it,
              it.to !== undefined
                ? `${why} — the outcome is unknown: ${it.to} holds the new copy and ${it.id} could not be confirmed either way, so both are left as they are; read memory again and retire the copy that should not stay`
                : `${why} — the outcome is unknown: ${it.id} could not be confirmed either way; plan again`,
            );
        });
      }
    }

    // Phase 3 — a move whose source write provably did not land: its new
    // copy becomes a `#moved` pointer back at the source (retired, so no
    // reader shows it; a pointer, so a re-run may write over it), and the
    // source stays the one live copy.
    for (const [root, group] of groupBy(unplace, (it) => parentOf(this.uriOf(it.to!)))) {
      for (const chunk of chunks(group, BATCH_MAX_OPERATIONS)) {
        const out = await this.batchWithArea(
          root,
          chunk.map((it) => ({
            uri: this.uriOf(it.to!),
            content: movedStub(it.id),
            precondition: {
              kind: "replace_if_hash" as const,
              base_hash: sha256Prefixed(content(it)),
            },
          })),
        );
        batches.push({ root, ops: chunk.length, ok: out.ok, message: `undo: ${out.message}` });
        for (const uri of out.landed) this.noteRetired(uri);
        for (const it of chunk) {
          if (out.landed.has(this.uriOf(it.to!))) continue;
          const prior = results.get(it.id);
          fail(
            it,
            `${prior?.message ?? "refused"} — and the new copy at ${it.to} could not be turned back into a pointer: retire it`,
          );
        }
      }
    }

    // Bookkeeping: what this store wrote is re-read, and what it retired is
    // published at once.
    this.invalidate();
    for (const it of valid) {
      this.forget(it.id);
      if (it.to !== undefined) this.forget(it.to);
    }
    for (const it of valid) {
      const r = results.get(it.id);
      if (!r?.ok) continue;
      if (it.to !== undefined) {
        this.noteRetired(this.uriOf(it.id));
        await this.mirrorTags(this.uriOf(it.to), content(it));
      } else if (parseHashTags(content(it)).includes(RETIRED_TAG)) {
        this.noteRetired(this.uriOf(it.id));
      } else {
        await this.mirrorTags(this.uriOf(it.id), content(it));
      }
    }
    return {
      results: items.map(
        (it) =>
          results.get(it.id) ?? {
            id: it.id,
            ...(it.to ? { to: it.to } : {}),
            ok: false,
            message: "not attempted",
          },
      ),
      batches,
    };
  }

  /**
   * Many named DOCUMENTS, each created or replaced under its own
   * precondition (the daemon's finding cases; the seam's `putDocuments`). ONE batch-write per area directory (chunked at the
   * server's 256), so writing twenty cases is one write, never twenty.
   *
   * A batch is all-or-nothing at its preconditions (the server checks every
   * one before the first write), so one document somebody else changed would
   * hold back the rest. When a batch is refused on a precondition, each of
   * its documents is read back: one already holding its bytes is `written`;
   * one still holding what its writer expected (absent, for a create) goes
   * into ONE more batch; anything else is a `conflict` carrying the bytes
   * found — never overwritten. A batch whose answer proves nothing (a
   * timeout, a 5xx) is read back too: a document holding its bytes is
   * `written`, any other `failed`, for the writer's next attempt. Never a
   * delete; total — every outcome is a result, never a throw.
   */
  async putDocuments(docs: readonly DocumentPut[]): Promise<DocumentPutResult[]> {
    interface Item {
      i: number;
      area: string;
      name: string;
      id: string;
      uri: string;
      content: string;
      expect: string | null;
    }
    const results = new Map<number, DocumentPutResult>();
    const items: Item[] = [];
    const seen = new Set<string>();
    docs.forEach((doc, i) => {
      const id = `${doc.area}/${doc.name}.md`;
      const content = renderEntryBody(doc.text);
      const refuse = (message: string): void => {
        results.set(i, { area: doc.area, name: doc.name, state: "failed", message });
      };
      if (!validArea(doc.area) || !validEntryId(id))
        refuse(`refused: '${id}' is not a memory address this store can spell`);
      else if (doc.expect !== null && !/^sha256:[0-9a-f]{64}$/.test(doc.expect))
        refuse("refused: no usable concurrency token for the replace");
      else if (content === "") refuse("refused: an empty document");
      else if (seen.has(id)) refuse("refused: one call names this document twice");
      else {
        seen.add(id);
        items.push({
          i,
          area: doc.area,
          name: doc.name,
          id,
          uri: this.uriOf(id),
          content,
          expect: doc.expect,
        });
      }
    });
    const settle = (it: Item, r: Omit<DocumentPutResult, "area" | "name">): void => {
      results.set(it.i, { area: it.area, name: it.name, ...r });
    };
    const written = (it: Item, how: string): void =>
      settle(it, {
        state: "written",
        hash: sha256Prefixed(it.content),
        uri: it.uri,
        message: `${how} ${it.id}`,
      });
    /** One batch; returns the documents a precondition refusal held back
     * that still hold what their writer expected (retried once). */
    const send = async (root: string, group: Item[], retried: boolean): Promise<Item[]> => {
      const out = await this.batchWithArea(
        root,
        group.map((it) => ({
          uri: it.uri,
          content: it.content,
          precondition:
            it.expect === null
              ? { kind: "create_if_absent" as const }
              : { kind: "replace_if_hash" as const, base_hash: it.expect },
        })),
      );
      if (out.ok) {
        for (const it of group) {
          if (out.landed.has(it.uri)) written(it, "wrote");
          else
            settle(it, {
              state: "failed",
              message: `memory write failed: the server accepted the batch without writing ${it.id}`,
            });
        }
        return [];
      }
      if (out.refused && !out.conflict) {
        // Busy, auth, a bad request: provably nothing written, and nothing
        // a read-back would change.
        for (const it of group) settle(it, { state: "failed", message: out.message });
        return [];
      }
      // A precondition refusal, or an answer that proves nothing: read back.
      const again: Item[] = [];
      await pool(group, this.concurrency, async (it) => {
        const now = await this.client.readContent(it.uri);
        if (now.ok && now.result === it.content) {
          written(it, "already holding its bytes:");
          return;
        }
        if (!now.ok && now.code !== "NOT_FOUND") {
          settle(it, {
            state: "failed",
            message: `${out.message} — and ${it.id} could not be read back (${now.message}); the next attempt retries`,
          });
          return;
        }
        if (!out.conflict) {
          settle(it, { state: "failed", message: `${out.message} — ${it.id} was not written` });
          return;
        }
        const held = now.ok ? now.result : null;
        const asExpected =
          it.expect === null ? held === null : held !== null && sha256Prefixed(held) === it.expect;
        if (asExpected && !retried) again.push(it);
        else if (asExpected)
          settle(it, {
            state: "failed",
            message: `refused: ${it.id} changed while it was being written — the next attempt retries`,
          });
        else
          settle(it, {
            state: "conflict",
            found: held,
            ...(held === null ? {} : { hash: sha256Prefixed(held) }),
            uri: it.uri,
            message:
              held === null
                ? `refused: ${it.id} is not there any more — nothing written`
                : `refused: ${it.id} holds other bytes than its writer last wrote — never overwritten`,
          });
      });
      return again;
    };
    for (const [root, group] of groupBy(items, (it) => parentOf(it.uri))) {
      for (const chunk of chunks(group, BATCH_MAX_OPERATIONS)) {
        const again = await send(root, chunk, false);
        if (again.length > 0) await send(root, again, true);
      }
    }
    // Bookkeeping. An area the sweep never lists (`finding-cases/`) has nothing in
    // this store's caches, and its retirements are not on the sweep's list.
    for (const it of items) {
      if (results.get(it.i)?.state !== "written") continue;
      if (!SWEEP_EXCLUDED_AREAS.includes(it.area)) {
        this.forget(it.id);
        if (parseHashTags(it.content).includes(RETIRED_TAG)) this.noteRetired(it.uri);
      }
      await this.mirrorTags(it.uri, it.content);
    }
    return docs.map(
      (doc, i) =>
        results.get(i) ?? {
          area: doc.area,
          name: doc.name,
          state: "failed",
          message: "not attempted",
        },
    );
  }

  /** One batch-write under `root`, making the directory once if it is
   * missing. `landed` = the URIs the server wrote or already held byte for
   * byte. `refused` = PROVEN that nothing in the batch was written: a
   * precondition refusal (checked before the first write) or a root that does
   * not exist. Any other failure proves nothing — the batch may have
   * committed after its answer was lost — and the caller reads back. */
  private async batchWithArea(
    root: string,
    operations: Array<{
      uri: string;
      content: string;
      precondition: { kind: "create_if_absent" } | { kind: "replace_if_hash"; base_hash: string };
    }>,
  ): Promise<{
    ok: boolean;
    refused: boolean;
    /** The refusal was a precondition's (some target did not hold what its
     * precondition expected) — nothing in the batch was written. */
    conflict: boolean;
    message: string;
    landed: Set<string>;
  }> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const res = await this.client.batchWrite({ root_uri: root, operations, wait: false });
      if (res.ok) {
        const landed = new Set(
          operations.map((o) => o.uri).filter((uri) => batchWriteLanded(res.result, uri)),
        );
        return {
          ok: true,
          refused: false,
          conflict: false,
          message: `${landed.size}/${operations.length} written under ${root}`,
          landed,
        };
      }
      if (res.code === "NOT_FOUND" && attempt === 0 && !this.ensuredRoots.has(root)) {
        if (await this.client.mkdir(root)) {
          this.ensuredRoots.add(root);
          continue;
        }
      }
      return {
        ok: false,
        refused: provenUnwritten(res),
        conflict: res.conflict,
        message: res.conflict
          ? `refused under ${root}: an entry changed since the plan read it, or a destination already holds other bytes — nothing in this batch was written; plan again and re-run`
          : `memory write failed under ${root}: ${res.message}`,
        landed: new Set(),
      };
    }
    return {
      ok: false,
      refused: true,
      conflict: false,
      message: `memory write failed: could not create ${root}`,
      landed: new Set(),
    };
  }

  /**
   * Drop the sweep cache AND this file's cached read: the next sweep reads it
   * whatever its listing says — and a sweep already in flight, which may have
   * read the old bytes, cannot put them back. After a write through this store,
   * and after a refusal that proved the cached bytes stale.
   */
  private forget(id: string): void {
    this.invalidate();
    this.known.delete(id);
    this.forgotten.set(id, this.sweepSeq);
  }

  /**
   * Mirror the entry's EVENT TAGS onto OpenViking's native retrieval tag list,
   * so a `tags`-filtered search finds it server-side.
   *
   * The vocabulary and the extraction are `src/memory/eventtags.ts`'s
   * (`parseEventTags` — header-only, so quoted human text cannot mint a tag);
   * this store only carries them across. BEST-EFFORT by contract: the tags are
   * already inside the bytes just committed and every reader re-parses them
   * from there, so a failure here narrows retrieval — it never loses the
   * memory or its tags.
   */
  private async mirrorTags(uri: string, body: string): Promise<void> {
    const tags = formatEventTags(parseEventTags(body))
      .split(" ")
      .filter((t) => t !== "");
    if (tags.length === 0) return;
    const ok = await this.client.setTags(uri, tags);
    if (!ok)
      this.log(
        `openviking: tags not mirrored for ${uri} — the entry is stored, retrieval by tag may miss it`,
      );
  }
}

// ---- helpers ----------------------------------------------------------------

/** Does a failed batch-write PROVE that nothing was written? Yes when the
 * server answered and refused — any 4xx: a precondition (checked before the
 * first write), a busy lock, a missing root, a bad request, auth. No answer
 * at all (status 0: a timeout, a lost connection) and a 5xx prove nothing:
 * the batch may have committed after its answer was lost. */
export function provenUnwritten(res: {
  status: number;
  conflict: boolean;
  busy: boolean;
}): boolean {
  return res.conflict || res.busy || (res.status >= 400 && res.status < 500 && res.status !== 408);
}

/** Oldest first; the id breaks a tie so the order never depends on listing
 * order. */
function byTsThenId(a: MemoryEntry, b: MemoryEntry): number {
  return a.ts !== b.ts ? (a.ts < b.ts ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Group in first-seen order. */
function groupBy<T>(items: readonly T[], key: (t: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    const group = out.get(k);
    if (group) group.push(it);
    else out.set(k, [it]);
  }
  return out;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Is `id` inside a directory whose listing failed (the area itself or one
 * above it)? */
function underFailedDir(id: string, failed: ReadonlySet<string>): boolean {
  const area = areaOfId(id);
  for (const dir of failed) if (area === dir || area.startsWith(`${dir}/`)) return true;
  return false;
}

function isTextFile(name: string): boolean {
  return (name.endsWith(".md") || name.endsWith(".txt")) && !name.startsWith(".");
}

function parentOf(uri: string): string {
  const cleaned = uri.replace(/\/+$/, "");
  const cut = cleaned.lastIndexOf("/");
  return cut > 0 ? cleaned.slice(0, cut) : cleaned;
}

/** Run `fn` over `items` with at most `limit` in flight. Rejections are
 * swallowed by the callers above (each `fn` is already total); the pool exists
 * to bound the burst against a 2-core server, not to collect results. */
async function pool<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) return;
      try {
        await fn(item);
      } catch {
        /* one bad file never loses the sweep */
      }
    }
  });
  await Promise.all(workers);
}

/** Convenience for wiring: the store the daemon and the TUI both use. */
export function openVikingStore(
  client: OpenVikingClient,
  opts: Omit<OpenVikingStoreOptions, "client"> = {},
): OpenVikingStore {
  return new OpenVikingStore({ client, ...opts });
}

// `MemoryStore` over OpenViking — the engine swap behind the
// seam. Nothing above this file learns that memory is now an HTTP server: the
// TUI's verbs, the [feedback] sink and the companion feed keep addressing
// entries by `(id, ts, block)` + an expected hash, exactly as they did against
// MEMORY.md.
//
// THE SHAPE CHANGE, stated plainly: pi-memory kept every entry in ONE markdown
// file, so an entry's address was its position inside that file. OpenViking
// keeps one FILE PER ENTRY under `viking://user/<user>/memories/<category>/`,
// so the address is the file. The seam's vocabulary survives the change:
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
// WHY `content/read` IS A SAFE HASH SOURCE HERE, given the `MEMORY_FIELDS`
// footgun: it is safe *because* of the rule above it, not despite it. Bare
// `content/write` appends a footer that `content/read` strips, which makes
// read → sha256 → write 409 forever; files written by `content/batch-write`
// carry no footer and round-trip byte-exact (verified). This module has no
// route to `content/write` — the client does not expose one — so every file it
// can see was written by batch-write, and the hash it computes is the hash the
// server holds. If that ever stops being true the symptom is a 409 on a fresh
// read, which surfaces as an ordinary refusal, never as a lost update.
//
// TAGS COME IN TWO FLAVOURS AND THIS MODULE OWNS NEITHER VOCABULARY.
//
//   * `#hash-tags` are the seam's own convention: `#pinned` is a pin,
//     `#manual` marks the owner's own words, `#retired` is a retirement (and
//     retired entries are filtered out of `read()`, which is what makes retire
//     behave like retire). They are PREPENDED to the entry text, exactly as
//     `src/memory/import.ts` and the [feedback] writer already spell them, so
//     an entry means the same thing whichever store holds it.
//   * `k=v` EVENT TAGS are the vocabulary (`kind=`, `pr=`, `day=`,
//     `signal=`) that the curator filters on and the auto-filer queries. They
//     ride the entry header too, and they are what this store mirrors onto
//     OpenViking's NATIVE retrieval tag list. The parser is
//     `parseEventTags` from `src/feedback.ts` — imported, never re-implemented:
//     it scans the HEADER only, so an untrusted PR body quoted later in the
//     entry cannot mint itself a tag, and a second parser here would be free
//     to disagree about exactly that.
//
// Both live in plain body text on purpose: plain text is what `content/read`
// returns unmodified and what every store re-parses. A `MEMORY_FIELDS`-style
// metadata footer is precisely what the server reserves for its own extractor
// and strips on read.
import { createHash } from "node:crypto";
import { formatEventTags, parseEventTags, parseHashTags } from "../memory/eventtags.js";
import {
  matchesQuery,
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

/** An id is a relative path of one or two safe segments ending in a text
 * extension. Anything else is refused rather than turned into a URI: an id
 * ultimately comes back from a caller that got it from us, and `..` in a path
 * we interpolate is exactly the mistake worth making structurally impossible. */
const ID_RE = /^(?:[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+\.(?:md|txt)$/;

/** A memory AREA a write may name (S2): one lowercase segment —
 * `experiences`, `events`, … (the §1 layout). */
const CATEGORY_RE = /^[a-z][a-z0-9_-]*$/;

export function validEntryId(id: string): boolean {
  return ID_RE.test(id) && !id.includes("..");
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
 * puts `#feedback` and its `k=v` run, and where `parseEventTags` looks. It is
 * also what "pin = tag + top placement" means once entries are files.
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
    // Header-only, unlike `tags`: a pinned entry rides the guaranteed head of
    // every round prompt, so untrusted text quoted inside an entry must not
    // be able to pin itself there. See src/memory/eventtags.ts.
    pinned: parseHashTags(trimmed).includes(PINNED_TAG),
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
}

/** One sweep plus the retired entries' URIs it filtered out — kept beside the
 * public `MemorySweep` rather than in it, because only the context search
 * needs them. */
interface SweepRun {
  sweep: MemorySweep;
  retired: string[];
}

/**
 * What one sweep cost (S3): how many files the listing named, how many
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
  /** How often a sweep re-reads EVERY file (S3). In between, a sweep
   * still lists every category but reads only the files whose size or
   * modification time moved since this store last read them — the TUI's
   * candidate sweeper, the companion and the daemon each re-read all ~176
   * files every few minutes before (about 716 reads per 10 min). The full
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
  /** The per-file cache behind the incremental sweep (S3), keyed by
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

  private cache: { at: number; run: SweepRun } | null = null;
  private inFlight: { gen: number; run: Promise<SweepRun> } | null = null;
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

  uriOf(id: string): string {
    return `${this.root}/${id}`;
  }

  /** Drop the sweep cache. Called after every successful write so a caller
   * that writes and immediately re-reads sees its own edit. The next sweep
   * LISTS again and re-reads every file whose size or modification time moved
   * (S3) — the per-file cache is not dropped, because the listing is
   * what says which files changed; a write through THIS store also forgets
   * the file it wrote, so even a same-size edit inside one clock tick is read. */
  invalidate(): void {
    this.cache = null;
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
   * refused. That is exactly what happened on 2026-08-21: the companion had
   * been unable to write a single memory, and the error it surfaced ("access
   * denied") named neither the namespace nor the missing directory.
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
   * sweep only when none has ever completed. The round fetches the pinned head
   * (a sweep) and the context block concurrently under one deadline, and the
   * cache is nearly always cold at a round; waiting here would put a whole
   * store sweep in series in front of the search. Retirements are rare and
   * this store records its own the moment they land, so a list one round old
   * costs at most one round's recall of an entry retired elsewhere. (A store
   * seeded with `initialRetired` answers from that until its first sweep.)
   */
  async retiredUris(): Promise<string[]> {
    this.takeRetiredSeed();
    if (this.knownRetired !== null) return [...this.knownRetired];
    return [...(await this.sweepRun()).retired];
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
   * One sweep, INCREMENTAL since S3: every category is listed, and a
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
    for (const file of files) {
      const known = next.get(file.id);
      if (!known || known.entry === null) continue;
      if (known.retired) retired.push(this.uriOf(file.id));
      else entries.push(known.entry);
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
    entries.sort((a, b) =>
      a.ts !== b.ts ? (a.ts < b.ts ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
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
        const dir = id.includes("/") ? id.slice(0, id.indexOf("/")) : "";
        if (listing.failedDirs.has(dir) && !next.has(id)) next.set(id, known);
      }
      for (const [id, at] of this.forgotten) {
        if (at >= seq) next.delete(id);
        else this.forgotten.delete(id);
      }
      this.known = next;
      this.adoptedSeq = seq;
      if (full) this.lastFullAt = startedAt;
    }
    const run: SweepRun = { sweep: { entries, unread }, retired };
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
   * The memory tree, two levels deep: `<root>/<category>/<file>` plus any file
   * sitting directly in the root. Two levels is the whole convention — a
   * deeper tree would need a recursive walk, and a recursive walk against a
   * store this system fully owns would only ever be finding files it did not
   * write.
   *
   * A listing that fails is recorded in `unread` — except NOT_FOUND, which is
   * an absent directory and therefore a known-empty one (see `MemorySweep`).
   */
  private async listFiles(unread: string[]): Promise<{
    files: Array<{ id: string; size: number; modTime: string }>;
    /** The root answered (an absent root is an answer: known-empty). */
    rootListed: boolean;
    /** Categories whose listing failed (not NOT_FOUND) — their cached reads
     * are kept for when they list again. */
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
        if (!row.name.startsWith(".")) dirs.push(row.name);
      } else if (isTextFile(row.name)) {
        out.push({ id: row.name, size: row.size, modTime: row.modTime });
      }
    }
    await pool(dirs, this.concurrency, async (dir) => {
      const uri = `${this.root}/${dir}`;
      const sub = await this.client.ls(uri);
      if (!sub.ok) {
        if (sub.code !== "NOT_FOUND") {
          unread.push(`ls ${uri}: ${sub.message}`);
          failedDirs.add(dir);
        }
        return;
      }
      for (const row of sub.result) {
        if (!row.isDir && isTextFile(row.name))
          out.push({ id: `${dir}/${row.name}`, size: row.size, modTime: row.modTime });
      }
    });
    return { files: out, rootListed: true, failedDirs };
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
      if (op.op === "add") return await this.create(renderEntryBody(op.text, [MANUAL_TAG]));
      if (op.op === "note")
        return await this.create(renderEntryBody(op.text), op.category ?? this.category, op.name);
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
        // Verbatim, exactly like pi-memory's edit: the caller supplies the
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
   * A NAMED create (S2, `note` with `name`) is never renamed: the
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
    if (!CATEGORY_RE.test(category))
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
   * The vocabulary and the extraction are `src/feedback.ts`'s
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

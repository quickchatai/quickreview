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
  const have = new Set(tagsOf(trimmed).map((t) => t.toLowerCase()));
  const missing = addTags.map((t) => t.replace(/^#+/, "").toLowerCase()).filter((t) => t !== "" && !have.has(t));
  const head = missing.map((t) => `#${t}`).join(" ");
  return `${head === "" ? trimmed : `${head} ${trimmed}`}\n`;
}

/** Prepend a tag to an entry's text, idempotently. */
export function withTag(text: string, tag: string): string {
  return renderEntryBody(text, [tag]);
}

/** Remove every occurrence of a tag token. Idempotent, never touches other
 * tags — the same spelling `import.ts` uses to unpin. */
export function withoutTag(text: string, tag: string): string {
  const token = new RegExp(`(^|\\s)#${tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s|$)`, "gi");
  return `${text.replace(token, "$1").replace(/[ \t]{2,}/g, " ").trim()}\n`;
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
}

const DEFAULT_READ_CONCURRENCY = 8;
const DEFAULT_CACHE_TTL_MS = 15_000;

export class OpenVikingStore implements MemoryStore {
  private readonly client: OpenVikingClient;
  private readonly root: string;
  private readonly category: string;
  private readonly now: () => Date;
  private readonly log: (msg: string, extra?: unknown) => void;
  private readonly concurrency: number;
  private readonly cacheTtlMs: number;

  private cache: { at: number; entries: MemoryEntry[] } | null = null;
  private inFlight: Promise<MemoryEntry[]> | null = null;

  constructor(opts: OpenVikingStoreOptions) {
    this.client = opts.client;
    this.root = (opts.memoriesRoot ?? opts.client.memoriesRoot()).replace(/\/+$/, "");
    this.category = opts.defaultCategory ?? DEFAULT_CATEGORY;
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? (() => {});
    this.concurrency = Math.max(1, opts.readConcurrency ?? DEFAULT_READ_CONCURRENCY);
    this.cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  }

  uriOf(id: string): string {
    return `${this.root}/${id}`;
  }

  /** Drop the sweep cache. Called after every successful write so a caller
   * that writes and immediately re-reads sees its own edit. */
  invalidate(): void {
    this.cache = null;
  }

  /**
   * Every entry the store holds, oldest first, retirements filtered out.
   *
   * Total by construction: a server that is down yields `[]`, and a single
   * unreadable file is skipped rather than losing the sweep. `[]` therefore
   * means "nothing to show" for BOTH an empty store and an absent one — which
   * is the right answer for a timeline and the wrong one for an alert, so the
   * gaps are logged and pushed to the client's `onGap` sink on the way past.
   */
  async read(): Promise<MemoryEntry[]> {
    const fresh = this.cache && this.now().getTime() - this.cache.at < this.cacheTtlMs;
    if (fresh && this.cache) return this.cache.entries;
    // One sweep at a time: the round path and the TUI poll can both land here.
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.sweep().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async sweep(): Promise<MemoryEntry[]> {
    const files = await this.listFiles();
    const entries: MemoryEntry[] = [];
    await pool(files, this.concurrency, async (file) => {
      const res = await this.client.readContent(this.uriOf(file.id));
      if (!res.ok) return;
      const entry = entryFrom(file.id, res.result, file.modTime);
      if (entry.text === "") return;
      if (entry.tags.some((t) => t.toLowerCase() === RETIRED_TAG)) return;
      entries.push(entry);
    });
    entries.sort((a, b) => (a.ts !== b.ts ? (a.ts < b.ts ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    this.cache = { at: this.now().getTime(), entries };
    return entries;
  }

  /**
   * The memory tree, two levels deep: `<root>/<category>/<file>` plus any file
   * sitting directly in the root. Two levels is the whole convention — a
   * deeper tree would need a recursive walk, and a recursive walk against a
   * store this system fully owns would only ever be finding files it did not
   * write.
   */
  private async listFiles(): Promise<Array<{ id: string; modTime: string }>> {
    const top = await this.client.ls(this.root);
    if (!top.ok) return [];
    const out: Array<{ id: string; modTime: string }> = [];
    const dirs: string[] = [];
    for (const row of top.result) {
      if (row.isDir) {
        if (!row.name.startsWith(".")) dirs.push(row.name);
      } else if (isTextFile(row.name)) {
        out.push({ id: row.name, modTime: row.modTime });
      }
    }
    await pool(dirs, this.concurrency, async (dir) => {
      const sub = await this.client.ls(`${this.root}/${dir}`);
      if (!sub.ok) return;
      for (const row of sub.result) {
        if (!row.isDir && isTextFile(row.name)) out.push({ id: `${dir}/${row.name}`, modTime: row.modTime });
      }
    });
    return out;
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
      if (op.op === "note") return await this.create(renderEntryBody(op.text));
      if (!validEntryId(op.id)) return { ok: false, message: `refused: '${op.id}' is not a memory address this store can spell` };
      if (!/^sha256:[0-9a-f]{64}$/.test(op.expect)) {
        return { ok: false, message: "refused: this entry was listed without a usable concurrency token — re-read it and retry" };
      }
      const current = await this.client.readContent(this.uriOf(op.id));
      if (!current.ok) {
        return { ok: false, message: `memory write failed: could not read ${op.id} (${current.code})` };
      }
      const entry = entryFrom(op.id, current.result, "");
      if (entry.hash !== op.expect) {
        // Caught before the round trip, but the server's 409 is the real
        // guard — this is only a cheaper, clearer version of the same answer.
        return { ok: false, message: "refused: the entry changed since you read it — re-read it and retry" };
      }
      const next = this.rewrite(op, entry.text);
      if (next === null) return { ok: false, message: `refused: unknown memory op '${(op as { op: string }).op}'` };
      if (next.trim() === "") return { ok: false, message: "refused: an edit may not empty an entry — retire it instead" };
      return await this.replace(op.id, next, op.expect);
    } catch (err) {
      // The client is total, but a caller-supplied seam is not, and a write
      // that throws would break the one promise the whole phase rests on.
      return { ok: false, message: `memory write failed: ${err instanceof Error ? err.message : String(err)}` };
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
   */
  private async create(body: string): Promise<MemoryWriteResult> {
    if (body.trim() === "") return { ok: false, message: "refused: an empty memory entry" };
    const ts = tsFromModTime(this.now().toISOString());
    const stamp = stampOf(ts);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const suffix = createHash("sha256").update(`${body}#${attempt}`).digest("hex").slice(0, 8);
      const id = `${this.category}/${stamp}-${suffix}.md`;
      const uri = this.uriOf(id);
      const res = await this.client.batchWrite({
        root_uri: `${this.root}/${this.category}`,
        operations: [{ uri, content: body, precondition: { kind: "create_if_absent" } }],
        // The bytes are durable without waiting; only searchability lags, and
        // ~1.6 core-seconds of index refresh must never sit on a caller.
        wait: false,
      });
      if (res.ok && batchWriteLanded(res.result, uri)) {
        this.invalidate();
        await this.mirrorTags(uri, body);
        return { ok: true, message: `wrote ${id}` };
      }
      if (res.ok) return { ok: false, message: `memory write failed: the server accepted the batch without writing ${id}` };
      if (!res.conflict) return { ok: false, message: `memory write failed: ${res.message}` };
      this.log(`openviking: memory name ${id} taken — retrying under a fresh name`);
    }
    return { ok: false, message: "refused: could not find a free name for this entry" };
  }

  private async replace(id: string, body: string, expect: string): Promise<MemoryWriteResult> {
    const uri = this.uriOf(id);
    const res = await this.client.batchWrite({
      root_uri: parentOf(uri),
      operations: [{ uri, content: body, precondition: { kind: "replace_if_hash", base_hash: expect } }],
      wait: false,
    });
    if (res.ok && batchWriteLanded(res.result, uri)) {
      this.invalidate();
      await this.mirrorTags(uri, body);
      return { ok: true, message: `updated ${id}` };
    }
    if (res.ok) return { ok: false, message: `memory write failed: the server accepted the batch without writing ${id}` };
    if (res.conflict) return { ok: false, message: "refused: the entry changed since you read it — re-read it and retry" };
    return { ok: false, message: `memory write failed: ${res.message}` };
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
    const tags = formatEventTags(parseEventTags(body)).split(" ").filter((t) => t !== "");
    if (tags.length === 0) return;
    const ok = await this.client.setTags(uri, tags);
    if (!ok) this.log(`openviking: tags not mirrored for ${uri} — the entry is stored, retrieval by tag may miss it`);
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
async function pool<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
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
export function openVikingStore(client: OpenVikingClient, opts: Omit<OpenVikingStoreOptions, "client"> = {}): OpenVikingStore {
  return new OpenVikingStore({ client, ...opts });
}

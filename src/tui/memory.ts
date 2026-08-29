// Memory & learning tab — the TUI's view of memory, running
// on OpenViking.
//
// The store itself lives behind the ONE seam (`src/memory/store.ts`)
// and its OpenViking implementation in `src/openviking/store.ts`. What stays
// here is what only the TUI cares about — how the timeline is ORDERED, which
// entries the defect auto-filer picks up, and the factory that hands the tab a
// store wired to BOTH of the owner's user keys.
//
// HOW THE TAB REACHES THE VM'S OPENVIKING. It does not ssh, and it does not
// invent a transport: it speaks plain HTTP to the loopback listener of the
// companion memory forward (`scripts/companion-memory-forward.mjs` — run by
// the TUI itself, or by the systemd --user unit when one is
// installed, which the TUI then adopts; `docs/companion-memory-access.md`).
// That process binds BOTH the `qcr-memory` bridge gateway (for the companion
// container) and `127.0.0.1` (for anything on the PC — us), and relays each
// connection over ssh into `docker exec … node` inside the quickreview
// container, whose stdio is piped to OpenViking's own loopback :1933. So the
// daemon's port is still published nowhere, and the TUI holds no second copy
// of the ssh/docker knowledge. If the forward is not running the tab is
// UNREACHABLE, loudly — see `MemoryHealth` below, and the MEMORY STORE row
// the tab paints (`src/tui/memforward.ts`).
//
// BOTH KEYS, NEVER AN ADMIN KEY. The owner's surfaces hold two OpenViking USER
// keys — `reviewer` (what the daemon and every review session hold; the server
// confines it to `user/reviewer/`) and `companion`. The tab builds ONE client
// per user and merges their timelines, which is what makes companion memory
// visible and editable from here while automated review sessions still cannot
// see it. An ADMIN or ROOT key must never appear: verified against 0.4.15, it
// grants no cross-user data access at all *and* can list every user key in
// plaintext.
//
// Nothing in the TUI addresses memory by file offsets or hashes it itself:
// entries carry their own `hash`, and `refOf(entry)` turns a listed entry into
// the address of a verb (see `MemoryStore` for why every addressed op carries
// the content it expects to find).
import { readFileSync } from "node:fs";
import { parseEventTags } from "../memory/eventtags.js";
import { matchesQuery, type MemoryEntry, type MemoryOp, type MemorySearchOptions, type MemoryStore, type MemoryWriteResult } from "../memory/store.js";
import { OpenVikingClient, type HttpFetch, type OvGap } from "../openviking/client.js";
import { OpenVikingStore } from "../openviking/store.js";
import { keysFilePath, MEMORY } from "./companion.js";

export { matchesQuery, normalizeTag, refOf } from "../memory/store.js";
export type { MemoryEntry, MemoryOp, MemoryRef, MemorySearchOptions, MemoryStore, MemoryWriteResult } from "../memory/store.js";

/** The two OpenViking users the TUI can see. `reviewer` is the review
 * system's own memory; `companion` is the local pi's. */
export const MEMORY_USERS = ["reviewer", "companion"] as const;
export type MemoryUser = (typeof MEMORY_USERS)[number];

/**
 * Which env name in the keys file carries each user's USER key, most specific
 * first. `OPENVIKING_API_KEY` is the companion extension's own identity, so it
 * is the companion's fallback spelling and NEVER the reviewer's — a mix-up
 * there would silently address the wrong tree.
 *
 * There is deliberately no ADMIN/ROOT entry in this table.
 */
export const USER_KEY_ENV: Record<MemoryUser, readonly string[]> = {
  reviewer: ["OPENVIKING_REVIEWER_KEY"],
  companion: ["OPENVIKING_COMPANION_KEY", "OPENVIKING_API_KEY"],
};

/** Newest-first ordering for the timeline: by ts desc, then read order desc.
 * Pinned entries float to the top regardless of age — mirroring the pinned
 * area the daemon's guaranteed injection head reads. */
export function timelineOrder(entries: MemoryEntry[]): MemoryEntry[] {
  const indexed = entries.map((e, i) => ({ e, i }));
  indexed.sort((a, b) => {
    if (a.e.pinned !== b.e.pinned) return a.e.pinned ? -1 : 1;
    if (a.e.ts !== b.e.ts) return a.e.ts < b.e.ts ? 1 : -1;
    return b.i - a.i;
  });
  return indexed.map((x) => x.e);
}

/** The tag that marks an operational defect — the auto-filer's query. */
export const DEFECT_TAG = "bug";

/**
 * Is this entry an operational defect? BY TAG, in both spellings the memory
 * vocabulary allows: the `#bug` hash tag (what the import and the overseer
 * write) and the `kind=bug` event tag (`src/memory/eventtags.ts`, the k=v run
 * OpenViking also mirrors onto its native retrieval tags). Never by prose —
 * an entry that merely mentions a bug is not a defect flag.
 */
export function isDefect(e: MemoryEntry): boolean {
  if (e.tags.some((t) => t.replace(/^#+/, "").toLowerCase() === DEFECT_TAG)) return true;
  return parseEventTags(e.text)["kind"] === DEFECT_TAG;
}

/** Operational-defect entries — the auto-filer's input (§9). */
export function defectEntries(entries: MemoryEntry[]): MemoryEntry[] {
  return entries.filter(isDefect);
}

// ---- namespaced addressing ---------------------------------------------------

/** Separator between the user and the store's own id. `:` cannot occur in an
 * OpenViking entry id (`validEntryId` allows `[A-Za-z0-9._-]` and one `/`), so
 * the split is unambiguous in both directions. */
export const NS_SEP = ":";

/** `reviewer` + `experiences/2026….md` → `reviewer:experiences/2026….md`. The
 * merged timeline holds entries from two servers-worth of trees; without the
 * prefix a verb could not tell which one it is addressing. */
export function nsId(user: string, id: string): string {
  return `${user}${NS_SEP}${id}`;
}

export function splitNsId(id: string): { user: string; id: string } {
  const cut = id.indexOf(NS_SEP);
  if (cut <= 0) return { user: "", id };
  return { user: id.slice(0, cut), id: id.slice(cut + 1) };
}

// ---- health ------------------------------------------------------------------

/** One user tree's last-sweep outcome. */
export interface NamespaceHealth {
  user: MemoryUser;
  ok: boolean;
  /** Operator-facing sentence when `ok` is false. */
  reason?: string;
  /** Entries listed but not readable — a narrowing, not an outage. */
  unreadable: number;
}

/**
 * What the tab paints instead of an empty list.
 *
 * `error` is the hard state: NO namespace answered, so an empty timeline means
 * "we cannot see memory", not "there is no memory". Those two must never look
 * alike — an empty tab reads as a healthy tab with nothing in it, which is
 * exactly the failure this field exists to prevent.
 */
export interface MemoryHealth {
  ok: boolean;
  namespaces: NamespaceHealth[];
  /** Set iff every namespace is down. */
  error?: string;
  /** Set when SOME namespace is down, or entries were unreadable. */
  warning?: string;
}

/** A store that can say whether it is actually talking to anything. */
export interface HealthyMemoryStore extends MemoryStore {
  health(): MemoryHealth;
}

/** Narrow a plain `MemoryStore` to one that reports health (test fakes and the
 * seam's other implementations do not). */
export function storeHealth(store: MemoryStore): MemoryHealth | undefined {
  const h = (store as Partial<HealthyMemoryStore>).health;
  return typeof h === "function" ? h.call(store) : undefined;
}

// ---- keys --------------------------------------------------------------------

/** Parse a docker `--env-file`-shaped keys file. Values are returned to the
 * caller and NEVER logged, printed or put on an argv. */
export function parseKeysEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2]!.trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (value !== "") out[m[1]!] = value;
  }
  return out;
}

/**
 * Read the two USER keys out of the keys file, re-reading at most every
 * `ttlMs` — a keys file provisioned after the TUI started is picked up without
 * a restart, and a missing one does not stat the disk per request.
 */
export function keysFileReader(path: string, ttlMs = 60_000, now: () => number = Date.now): (name: string) => string | null {
  let cached: Record<string, string> = {};
  let checkedAt = -Infinity;
  return (name) => {
    if (now() - checkedAt >= ttlMs) {
      checkedAt = now();
      try {
        cached = parseKeysEnv(readFileSync(path, "utf8"));
      } catch {
        cached = {};
      }
    }
    return cached[name] ?? null;
  };
}

/**
 * Where the TUI reaches OpenViking: the memory forward's loopback listener.
 *
 * `QCR_MEMORY_URL` overrides it wholesale; `QCR_MEMORY_PORT` matches the flag
 * the forward itself takes, so a non-default port only has to be spelled once.
 * `MEMORY.port` is the shared constant the forward and the companion already
 * agree on.
 */
export function tuiMemoryBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = (env["QCR_MEMORY_URL"] ?? env["QCR_MEMORY_ENDPOINT"] ?? "").trim();
  if (explicit !== "") return explicit.replace(/\/+$/, "");
  const port = Number(env["QCR_MEMORY_PORT"] ?? MEMORY.port) || MEMORY.port;
  return `http://127.0.0.1:${port}`;
}

// ---- the store ---------------------------------------------------------------

interface Namespace {
  user: MemoryUser;
  store: MemoryStore;
  gaps: OvGap[];
  /** Calls currently collecting into `gaps`. The tab's load and the companion
   * feed write can both be in flight, and the underlying store COALESCES their
   * sweeps — so the gap buffer is cleared only by the first arrival, and every
   * caller reads the whole sweep's gaps rather than the tail after its own
   * reset. */
  busy: number;
  health: NamespaceHealth;
}

export interface TuiMemoryOptions {
  /** Defaults to `tuiMemoryBaseUrl(env)`. */
  baseUrl?: string;
  /** Key lookup by env name; defaults to the keys file. */
  key?: (name: string) => string | null;
  /** Keys file path (`QCR_OPENVIKING_KEYS` honoured through `keysFilePath`). */
  keysFile?: string;
  env?: NodeJS.ProcessEnv;
  fetchFn?: HttpFetch;
  now?: () => Date;
  /** Per-request deadline. The forward adds an ssh hop, so it is generous. */
  timeoutMs?: number;
  /** NEVER console.log from here — the TUI owns the alt screen. */
  log?: (msg: string, extra?: unknown) => void;
  /** Namespaces to build. Tests inject fakes; production passes nothing. */
  namespaces?: Array<{ user: MemoryUser; store: MemoryStore }>;
  /** Where an unaddressed write (`add`/`note`) lands. */
  writeUser?: MemoryUser;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * The store the TUI runs against: BOTH user trees, merged into one timeline,
 * with every entry id prefixed by the user it came from so a verb lands where
 * the operator was looking.
 *
 * The per-user `OpenVikingStore`s are built with NO sweep cache on purpose.
 * `read()` on this class is the tab's load path (tab open, `r`, after a verb,
 * and the ~60s companion feed write) — not a per-poll cost — and a cached
 * sweep would leave `health()` reporting the outcome of a request that did not
 * happen. Freshness and honesty are worth more here than the round path's
 * amortization, which has its own store.
 */
export class TuiMemoryStore implements HealthyMemoryStore {
  private readonly ns: Namespace[];
  private readonly writeUser: MemoryUser;
  private readonly baseUrl: string;
  private readonly keysFile: string;

  constructor(opts: TuiMemoryOptions = {}) {
    const env = opts.env ?? process.env;
    this.baseUrl = opts.baseUrl ?? tuiMemoryBaseUrl(env);
    this.keysFile = opts.keysFile ?? keysFilePath(env);
    this.writeUser = opts.writeUser ?? "reviewer";
    const key = opts.key ?? keysFileReader(this.keysFile);
    const built = opts.namespaces ?? MEMORY_USERS.map((user) => ({ user, store: this.buildStore(user, key, opts) }));
    this.ns = built.map(({ user, store }) => ({
      user,
      store,
      gaps: [],
      busy: 0,
      health: { user, ok: true, unreadable: 0 },
    }));
  }

  private buildStore(user: MemoryUser, key: (name: string) => string | null, opts: TuiMemoryOptions): MemoryStore {
    const client = new OpenVikingClient({
      baseUrl: this.baseUrl,
      // Read lazily on every request, so a keys file that lands later works.
      apiKey: () => {
        for (const name of USER_KEY_ENV[user]) {
          const value = key(name);
          if (value) return value;
        }
        return null;
      },
      user,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
      ...(opts.log ? { log: opts.log } : {}),
      onGap: (gap) => {
        // Buffered per call, drained by read()/apply() — the client never
        // throws, so this is the only channel that distinguishes "the store
        // is empty" from "the store did not answer".
        const slot = this.ns.find((n) => n.user === user);
        if (slot) slot.gaps.push(gap);
      },
    });
    const store = new OpenVikingStore({
      client,
      cacheTtlMs: 0,
      ...(opts.now ? { now: opts.now } : {}),
      ...(opts.log ? { log: opts.log } : {}),
    });
    return store;
  }

  /** Every entry BOTH trees hold, ids namespaced, oldest first. */
  async read(): Promise<MemoryEntry[]> {
    const out: MemoryEntry[] = [];
    await Promise.all(
      this.ns.map(async (n) => {
        if (n.busy === 0) n.gaps = [];
        n.busy += 1;
        let entries: MemoryEntry[] = [];
        try {
          entries = await n.store.read();
        } catch (err) {
          // The OpenViking store is total; a caller-supplied fake need not be.
          n.gaps.push({ op: "ls", status: 0, code: "transport", message: errText(err) });
        } finally {
          n.busy -= 1;
        }
        this.settle(n, entries.length);
        for (const e of entries) out.push({ ...e, id: nsId(n.user, e.id) });
      }),
    );
    out.sort((a, b) => (a.ts !== b.ts ? (a.ts < b.ts ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return out;
  }

  /**
   * Materialize EVERY namespace this store holds keys for, so each is visible
   * to a writer that discovers namespaces by listing (the companion's pi
   * extension does — see `OpenVikingStore.ensureWritable`).
   *
   * The TUI is the right caller: it is the one surface holding both user keys,
   * and it starts the companion container itself, so it can guarantee the
   * ordering the extension's cached namespace resolution depends on. Returns
   * operator-facing notes for the namespaces that could NOT be prepared —
   * never throws, and a failure is degraded memory, never a reason to hold the
   * companion back.
   */
  async ensureNamespaces(): Promise<string[]> {
    const notes: string[] = [];
    await Promise.all(
      this.ns.map(async (n) => {
        const ensure = n.store.ensureWritable?.bind(n.store);
        if (ensure === undefined) return;
        try {
          const res = await ensure();
          if (!res.ok) notes.push(`${n.user}: ${res.message}`);
        } catch (err) {
          notes.push(`${n.user}: ${errText(err)}`);
        }
      }),
    );
    return notes;
  }

  async search(query: string, opts?: MemorySearchOptions): Promise<MemoryEntry[]> {
    const hits = (await this.read()).filter((e) => matchesQuery(e, query, opts));
    const limit = opts?.limit;
    return limit !== undefined && limit >= 0 ? hits.slice(0, limit) : hits;
  }

  /**
   * Route one mutation to the tree that owns the entry.
   *
   * Unaddressed writes (`add`, `note`) land in the reviewer tree: a note
   * the owner types here is an instruction to the review system, and the EOD
   * curator and every round's pinned head read reviewer memory.
   */
  async apply(op: MemoryOp): Promise<MemoryWriteResult> {
    if (op.op === "add" || op.op === "note") {
      const target = this.ns.find((n) => n.user === this.writeUser) ?? this.ns[0];
      if (!target) return { ok: false, message: "refused: no memory namespace configured" };
      return this.applyIn(target, op);
    }
    const { user, id } = splitNsId(op.id);
    const target = this.ns.find((n) => n.user === user);
    if (!target) {
      return { ok: false, message: `refused: '${op.id}' names no memory namespace (expected ${this.ns.map((n) => n.user).join(" or ")}) — refresh and retry` };
    }
    return this.applyIn(target, op.op === "edit" ? { ...op, id } : { ...op, id });
  }

  private async applyIn(n: Namespace, op: MemoryOp): Promise<MemoryWriteResult> {
    if (n.busy === 0) n.gaps = [];
    n.busy += 1;
    let res: MemoryWriteResult;
    try {
      res = await n.store.apply(op);
    } finally {
      n.busy -= 1;
    }
    // A write gap is real evidence about reachability — a conflict is not (the
    // client keeps 409s out of the gap channel by design).
    const fatal = n.gaps.find((g) => g.code === "no_key" || g.code === "transport");
    if (fatal) {
      n.health = { user: n.user, ok: false, reason: this.describe(n.user, fatal), unreadable: 0 };
    }
    return res;
  }

  /** Classify this namespace's sweep: down, degraded, or clean. */
  private settle(n: Namespace, listed: number): void {
    const fatal = n.gaps.find((g) => g.op === "ls" || g.code === "no_key" || g.code === "transport");
    if (fatal) {
      n.health = { user: n.user, ok: false, reason: this.describe(n.user, fatal), unreadable: 0 };
      return;
    }
    const unreadable = n.gaps.filter((g) => g.op === "read").length;
    n.health = {
      user: n.user,
      ok: true,
      unreadable,
      ...(unreadable > 0 ? { reason: `${unreadable} of ${listed + unreadable} ${n.user} entries could not be read` } : {}),
    };
  }

  /** A gap, as a sentence that tells the operator what to DO about it. */
  private describe(user: MemoryUser, gap: OvGap): string {
    if (gap.code === "no_key") {
      return `no ${USER_KEY_ENV[user][0]} in ${this.keysFile} (see docs/companion-memory-access.md)`;
    }
    if (gap.code === "transport" || gap.status === 0) {
      // The TUI runs its own forward, so the first thing to look at
      // is the MEMORY STORE row on this tab — `r` re-probes and restarts it.
      // The unit is the other possibility, and only when one is installed.
      return `cannot reach OpenViking at ${this.baseUrl} (${gap.message}) — see the MEMORY STORE row (r retries), or: systemctl --user status qcr-memory-forward`;
    }
    return `${user} memory refused the read: ${gap.status} ${gap.code} — ${gap.message}`;
  }

  health(): MemoryHealth {
    const namespaces = this.ns.map((n) => n.health);
    const down = namespaces.filter((h) => !h.ok);
    if (namespaces.length > 0 && down.length === namespaces.length) {
      const first = down[0]!;
      return {
        ok: false,
        namespaces,
        error: down.every((h) => h.reason === first.reason)
          ? (first.reason ?? "memory is unreachable")
          : down.map((h) => `${h.user}: ${h.reason ?? "unreachable"}`).join(" · "),
      };
    }
    const notes = [
      ...down.map((h) => `${h.user} memory unreachable — ${h.reason ?? "no answer"}`),
      ...namespaces.filter((h) => h.ok && h.unreadable > 0).map((h) => h.reason!),
    ];
    return { ok: down.length === 0, namespaces, ...(notes.length > 0 ? { warning: notes.join(" · ") } : {}) };
  }
}

/** The store the TUI runs against: memory on the VM, over the memory forward,
 * with both of the owner's user keys. */
export function tuiMemoryStore(opts: TuiMemoryOptions = {}): TuiMemoryStore {
  return new TuiMemoryStore(opts);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

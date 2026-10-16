#!/usr/bin/env node
// OpenViking embedder migration — the re-embed path that lets an existing
// store move to a different embedder.
//
// Why this exists
// ---------------
// The shipped default is the local ENGLISH embedder, bge-small-en-v1.5-f16 at
// 384 dims, served on loopback by scripts/openviking-embedder.py and reached
// through the engine's OpenAI-compatible client (provider "openai", a loopback
// `api_base`), so nothing but the model call leaves the machine. A store may
// have been embedded under another embedder (a hosted model such as
// text-embedding-3-small at 1536 dims, or the server's built-in
// bge-small-zh-v1.5-f16 at 512 dims). Every embedder change is the same
// migration: a store embedded under the old embedder holds vectors the new one
// cannot read — and OpenViking 0.4.15 REFUSES TO START on such a store:
//
//     EmbeddingRebuildRequiredError: Existing collection embedding dimension
//     (1536) does not match current configuration (512). Vectors are
//     incompatible; rebuild is required.
//
// (verified against a running 0.4.15 on a throwaway copy). There
// is no server-side rebuild: the vector collection has to be RESET while the
// server is down, and the vectors rebuilt afterwards through the maintenance
// API `POST /api/v1/content/reindex` (mode `vectors_only`, non-destructive,
// idempotent upsert — verified: a second run rebuilds the same records and
// changes nothing).
//
// THE TWO HALVES, AND WHO RUNS EACH
// ---------------------------------
//   prepare  DISK, server DOWN. The container entrypoint runs it right after
//            rendering ov.conf and BEFORE boot provisioning starts a server.
//            It reads the collection's own embedding metadata
//            (`vectordb/<name>/collection_meta.json`, the same record the
//            server checks) and, when it names a different embedder than
//            ov.conf, writes the journal `reembed.json` beside ov.conf and
//            only then MOVES the collection aside (never deletes — the old
//            vectors stay on disk for a rollback), so no interruption can
//            leave a moved collection with no rebuild on record. The journal
//            names the namespace THIS host re-embeds
//            (`--user`, the reviewer) as `pending`, every other provisioned
//            namespace as `operator` — its key holder's to re-embed, from
//            wherever that key lives. On a matching store it is a no-op and
//            exits in milliseconds, every boot.
//   resume   HTTP, server UP. The daemon runs it once `/ready` passes (from
//            src/openviking/reembed.ts), against the supervised server, with
//            the REVIEWER user key — the server confines a USER key to its own
//            namespace, so this re-embeds `viking://user/reviewer` and nothing
//            else, and it needs no root or admin key anywhere. Resumable: the
//            journal marks the namespace pending until a run completes with
//            zero failed records; a daemon restart mid-run simply runs it
//            again, and the reindex is an upsert.
//   status   what the journal says — the heartbeat's `openviking.reembed`.
//   settle   the operator's receipt for an `operator` namespace: after
//            `qcr memory reembed` has rebuilt it from the PC, this marks the
//            row completed so the journal (and the heartbeat) stop naming it.
//   rehearse prepare + a temporary server + resume + stop, in one command,
//            for proving the migration on a COPY of a store before it touches
//            a live one (docs/memory-embeddings.md has the recipe).
//
// WHAT IT NEVER DOES: read a namespace it holds no key for (the companion's
// memory is re-embedded by the companion key's holder, from the operator's PC
// — `qcr memory reembed`), touch any file under `viking/` (the memory TEXT is
// never rewritten; only vectors are rebuilt), delete the old collection, or
// block a boot: `prepare` is milliseconds and `resume` runs behind the daemon.
//
// MEMORY NEVER BLOCKS THE BOOT. Every failure here is a log line and exit 0;
// `--strict` (tests, manual runs, `rehearse`) is the only way to a non-zero
// exit. Zero dependencies and plain JS on purpose: the entrypoint runs it
// before the TypeScript build, on a container that may have no `dist/` yet.
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  embedderSpecFromFlags,
  readSecret,
  serverArgv,
  startEmbedder,
  stopServerChild,
  waitForReady,
} from "./openviking-provision.mjs";

/** The journal, beside ov.conf under the OpenViking home. */
export const JOURNAL_FILE = "reembed.json";
export const JOURNAL_VERSION = 1;

/** The server's local vector project + collection meta file
 * (`LocalCollectionAdapter.DEFAULT_LOCAL_PROJECT_NAME` and the persistent
 * collection's `collection_meta.json`, OpenViking 0.4.15). */
export const VECTORDB_DIR = "vectordb";
export const COLLECTION_META = "collection_meta.json";
/** `storage.vectordb.name` when ov.conf names none. */
export const DEFAULT_COLLECTION = "context";
/** The separator the server puts between a collection's description and its
 * embedding metadata JSON (`EMBEDDING_META_MARKER`, collection_schemas.py). */
export const META_MARKER = "\n\n[openviking.embedding]\n";

/** The server's BUILT-IN local dense embedder — the only local model 0.4.15
 * ships a spec for, and what the server runs when ov.conf names no embedder at
 * all. A store built before the local English embedder may carry it;
 * `configuredEmbedder` answers it for an ov.conf without an `embedding`
 * section, because that is what such a server really runs. */
export const SERVER_DEFAULT_EMBEDDER = Object.freeze({
  provider: "local",
  model: "bge-small-zh-v1.5-f16",
  dimension: 512,
});

/** The local ENGLISH embedder as the engine records it — the
 * engine's OpenAI-compatible provider pointed at the loopback service. The
 * record the shipped default writes into a collection. Mirrors
 * `LOCAL_EMBEDDING` in src/config.ts (tests/openviking-reembed.test.ts). */
export const LOCAL_EMBEDDER = Object.freeze({
  provider: "openai",
  model: "bge-small-en-v1.5-f16",
  dimension: 384,
});

export const DEFAULTS = {
  base: "http://127.0.0.1:1933",
  user: "reviewer",
  requestTimeoutMs: 10_000,
  /** A namespace reindex is one queued task; polling it is cheap. */
  pollMs: 2_000,
  /** How long one resume run waits for the server's task before giving the
   * namespace back to "pending" for the next run. */
  deadlineMs: 30 * 60_000,
  readyTimeoutMs: 120_000,
};

// ---- the embedder record -------------------------------------------------------

// The shapes below are JSDoc-typed so `allowJs` callers (src/openviking/
// reembed.ts declares the same contract structurally; the tests drive this
// real module through it) see the literal unions rather than `string`.
/** @typedef {{ provider: string, model: string, dimension: number }} Embedder */
/** @typedef {"pending" | "failed" | "completed" | "operator"} NamespaceState */
/** @typedef {{ state: NamespaceState, at?: string, attempts?: number, detail?: string, task_id?: string, scanned_records?: number, rebuilt_records?: number, failed_records?: number, unsupported_records?: number, settled_by?: string }} NamespaceRow */
/** @typedef {{ state: "none" | "pending" | "failed" | "completed" | "unreadable", embedder?: Embedder, previous?: Embedder | null, reset_at?: string, moved_to?: string, awaiting_operator?: string[], namespaces?: Record<string, NamespaceRow> }} JournalStatus */
/** @typedef {{ scanned_records: number, rebuilt_records: number, failed_records: number, unsupported_records: number }} ReindexCounts */
/** @typedef {{ uri: string, detail?: string, task_id?: string } & (({ status: "completed" } & ReindexCounts) | ({ status: "failed" | "busy" | "timeout" } & Partial<ReindexCounts>))} ReindexResult */
/** @typedef {(line: string) => void} Log */
/** @typedef {(url: string, init?: { method?: string, headers?: Record<string, string>, body?: string, signal?: AbortSignal }) => Promise<{ status: number, json?: () => Promise<unknown> }>} OvFetch */

/** The embedder ov.conf configures, WITHOUT its credential: provider, model
 * and dimension — the three keys of the server's own compatibility check that
 * this script can state with certainty (the fourth, `model_identity`, is
 * derived from these and never differs when they agree). Spelled exactly as
 * the SERVER spells them, because that is what it writes into a collection:
 * the local English embedder is `openai/<model>` (its wire provider), and the
 * loopback `api_base` that tells it apart from a hosted model is deliberately
 * not part of the record. An ov.conf with no `embedding` section runs the
 * server's built-in local embedder. */
export function configuredEmbedder(conf) {
  const dense = conf?.embedding?.dense;
  if (!dense || typeof dense !== "object") return { ...SERVER_DEFAULT_EMBEDDER };
  const provider = String(dense.provider ?? "")
    .trim()
    .toLowerCase();
  if (provider === "" || provider === "local") {
    return {
      provider: "local",
      model: String(dense.model ?? SERVER_DEFAULT_EMBEDDER.model),
      dimension: Number(dense.dimension ?? SERVER_DEFAULT_EMBEDDER.dimension),
    };
  }
  return { provider, model: String(dense.model ?? ""), dimension: Number(dense.dimension) };
}

/** The embedder a persisted collection was built under, read out of
 * `collection_meta.json`'s description. `null` when the file carries none
 * (a collection from an older server) or cannot be parsed — the caller treats
 * both as "unknown", never as "compatible". */
export function storedEmbedder(metaText) {
  let meta;
  try {
    meta = JSON.parse(metaText);
  } catch {
    return null;
  }
  const description = typeof meta?.Description === "string" ? meta.Description : "";
  const at = description.indexOf(META_MARKER);
  if (at < 0) return null;
  try {
    const payload = JSON.parse(description.slice(at + META_MARKER.length).trim());
    if (!payload || typeof payload !== "object") return null;
    return {
      provider: String(payload.provider ?? "").toLowerCase(),
      model: String(payload.model ?? ""),
      dimension: Number(payload.dimension),
      model_identity: typeof payload.model_identity === "string" ? payload.model_identity : "",
    };
  } catch {
    return null;
  }
}

export function sameEmbedder(a, b) {
  return (
    !!a &&
    !!b &&
    a.provider === b.provider &&
    a.model === b.model &&
    Number(a.dimension) === Number(b.dimension)
  );
}

/** `<home>/workspace` unless ov.conf says otherwise (it never does here). */
export function workspaceOf(home, conf) {
  const ws = conf?.storage?.workspace;
  return typeof ws === "string" && ws.trim() !== "" ? ws : join(home, "workspace");
}

export function collectionDirOf(workspace, conf) {
  const name = conf?.storage?.vectordb?.name;
  return join(
    workspace,
    VECTORDB_DIR,
    typeof name === "string" && name.trim() !== "" ? name : DEFAULT_COLLECTION,
  );
}

// ---- the journal ----------------------------------------------------------------

export function journalPath(home) {
  return join(home, JOURNAL_FILE);
}

/** `{ journal, unreadable }`: absent ⇒ `{null, false}`; present but not
 * parseable ⇒ `{null, true}` — "could not read" is never "nothing there". */
export function readJournal(home) {
  const path = journalPath(home);
  if (!existsSync(path)) return { journal: null, unreadable: false };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || typeof parsed.namespaces !== "object")
      return { journal: null, unreadable: true };
    return { journal: parsed, unreadable: false };
  } catch {
    return { journal: null, unreadable: true };
  }
}

export function writeJournal(home, journal) {
  const path = journalPath(home);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * The heartbeat's view of the migration. No secrets, no throws.
 *
 * A namespace row is one of `pending` / `failed` / `completed` (this host's
 * own namespace, driven by `resume`) or `operator` (a namespace whose key this
 * host does not hold — re-embedded from wherever that key lives and receipted
 * here with `settle`). The overall `state` is about what THIS host can do:
 *
 *   none        no migration on record — the store matches its embedder
 *   pending     the collection was reset and this host's namespace is not
 *               re-embedded yet
 *   failed      the last resume attempt failed (it will be retried; the
 *               counts say how far it got)
 *   completed   this host's namespace is re-embedded
 *   unreadable  a journal exists and cannot be parsed — unknown, not "none"
 *
 * `awaiting_operator` lists the `operator` rows still open, so a completed
 * state never hides a namespace nobody has rebuilt yet.
 */
/** @returns {JournalStatus} */
export function journalStatus(home) {
  const { journal, unreadable } = readJournal(home);
  if (unreadable) return { state: "unreadable" };
  if (!journal) return { state: "none" };
  const namespaces = journal.namespaces ?? {};
  const own = Object.values(namespaces)
    .filter((n) => n?.state !== "operator")
    .map((n) => n?.state);
  const state = own.some((s) => s === "failed")
    ? "failed"
    : own.some((s) => s !== "completed")
      ? "pending"
      : "completed";
  return {
    state,
    embedder: journal.embedder,
    previous: journal.previous ?? null,
    reset_at: journal.reset_at,
    moved_to: journal.moved_to,
    awaiting_operator: Object.entries(namespaces)
      .filter(([, n]) => n?.state === "operator")
      .map(([user]) => user),
    namespaces,
  };
}

/**
 * The operator's receipt for an `operator` namespace (or a stuck own one, by
 * their explicit word): mark it completed. Refuses — as an answer, never a
 * throw — when there is no journal, no such row, or the row is already
 * completed, so a typo cannot mint a receipt for nothing.
 */
export function settle({ home, user, detail = "", now = () => new Date() }) {
  const { journal, unreadable } = readJournal(home);
  if (unreadable) return { ok: false, detail: `${journalPath(home)} cannot be parsed` };
  const ns = journal?.namespaces?.[user];
  if (!journal || !ns) return { ok: false, detail: `no re-embed on record for ${user}` };
  if (ns.state === "completed")
    return { ok: false, detail: `${user} is already completed (${ns.at ?? "?"})` };
  const entry = {
    ...ns,
    state: "completed",
    at: now().toISOString(),
    settled_by: "operator",
    detail: detail || `settled by the operator (was ${ns.state})`,
  };
  writeJournal(home, { ...journal, namespaces: { ...journal.namespaces, [user]: entry } });
  return { ok: true, detail: entry.detail, entry };
}

// ---- prepare (disk half) -----------------------------------------------------------

/**
 * What `prepare` should do — pure, so the decision is unit-tested apart from
 * the filesystem.
 *
 *   none    the collection matches ov.conf (or does not exist yet — the server
 *           creates one for the configured embedder), nothing to reset
 *   reset   the collection was built under a different embedder: move it aside
 *   refuse  cannot decide safely: the meta is unreadable, or a reset for THIS
 *           embedder already happened and the collection still disagrees
 *           (another server wrote it since) — resetting again would loop
 *
 * The journal is written BEFORE the collection is moved, so a journal whose
 * reset names a `moved_to` that does not exist (`movedAsidePresent` false)
 * records a reset interrupted before its move: that collection is still the
 * old one, and the reset is finished rather than refused.
 */
/** @param {{ stored: (Embedder & { model_identity?: string }) | null, metaPresent: boolean, expected: Embedder, journal: any, movedAsidePresent?: boolean }} args */
export function planPrepare({ stored, metaPresent, expected, journal, movedAsidePresent }) {
  if (!metaPresent)
    return {
      action: "none",
      reason: "no vector collection yet — the server creates one for the configured embedder",
    };
  if (stored === null)
    return {
      action: "refuse",
      reason: `${COLLECTION_META} carries no readable embedding metadata — not touching the collection`,
    };
  if (sameEmbedder(stored, expected))
    return { action: "none", reason: `the collection already matches ${describe(expected)}` };
  if (journal && sameEmbedder(journal.embedder, expected) && journal.reset_at) {
    if (typeof journal.moved_to === "string" && movedAsidePresent === false)
      return {
        action: "reset",
        reason: `a reset for ${describe(expected)} was journalled at ${journal.reset_at} but the collection was never moved aside — finishing it: the collection still reports ${describe(stored)}`,
      };
    return {
      action: "refuse",
      reason: `the collection was already reset for ${describe(expected)} at ${journal.reset_at} and still reports ${describe(stored)} — a server with a different ov.conf wrote it since; not resetting again`,
    };
  }
  return {
    action: "reset",
    reason: `the collection was built under ${describe(stored)}, ov.conf configures ${describe(expected)} — the vectors are incompatible`,
  };
}

export function describe(e) {
  return e ? `${e.provider}/${e.model} (${e.dimension} dims)` : "unknown";
}

/** `20260902T153000Z` — the suffix of a moved-aside collection. */
export function stamp(now = new Date()) {
  return now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

/**
 * Is a server serving this ov.conf's port right now? `prepare` must never move
 * a collection out from under a running server. The port, not the PID file:
 * `.openviking.pid` names a pid from the PREVIOUS container's namespace and is
 * meaningless after a restart, whereas the port is loopback in the same
 * namespace as whoever runs this script.
 */
export async function serverIsUp({
  base,
  fetchFn = /** @type {OvFetch} */ (fetch),
  timeoutMs = 1_500,
}) {
  try {
    const res = await fetchFn(`${base}/health`, {
      method: "GET",
      headers: {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.status >= 200 && res.status < 500;
  } catch {
    return false;
  }
}

/**
 * The disk half. Returns a report and NEVER throws; the only side effects are
 * the journal write and ONE rename (the collection directory, aside), both
 * only on `action: "reset"`, in that order: the rebuild obligation is durable
 * before the collection leaves, and a failed move puts the journal back as it
 * was.
 */
export async function prepare({
  home,
  conf,
  users,
  own = DEFAULTS.user,
  base,
  fetchFn = /** @type {OvFetch} */ (fetch),
  now = () => new Date(),
  log = /** @type {Log} */ (() => {}),
}) {
  const expected = configuredEmbedder(conf);
  const workspace = workspaceOf(home, conf);
  const collectionDir = collectionDirOf(workspace, conf);
  const metaPath = join(collectionDir, COLLECTION_META);
  const { journal, unreadable } = readJournal(home);
  if (unreadable) {
    const reason = `${journalPath(home)} exists and cannot be parsed — not touching the collection until an operator reads it`;
    log(`openviking: reembed prepare REFUSED — ${reason}`);
    return { action: "refuse", reason, expected, collectionDir };
  }
  const metaPresent = existsSync(metaPath);
  let stored = null;
  if (metaPresent) {
    try {
      stored = storedEmbedder(readFileSync(metaPath, "utf8"));
    } catch {
      stored = null;
    }
  }
  const movedAsidePresent =
    journal && typeof journal.moved_to === "string" ? existsSync(journal.moved_to) : undefined;
  const plan = planPrepare({ stored, metaPresent, expected, journal, movedAsidePresent });
  if (plan.action !== "reset") {
    log(`openviking: reembed prepare — ${plan.action}: ${plan.reason}`);
    return { ...plan, expected, stored, collectionDir };
  }
  if (await serverIsUp({ base, fetchFn })) {
    const reason = `a server is answering on ${base} — stop it before resetting the vector collection`;
    log(`openviking: reembed prepare REFUSED — ${reason}`);
    return { action: "refuse", reason, expected, stored, collectionDir };
  }
  const at = now();
  const movedTo = `${collectionDir}.pre-reembed-${stamp(at)}`;
  // This host re-embeds ONLY the namespace whose key it holds; every other
  // provisioned namespace is journalled for its key holder to rebuild (the
  // server confines a user key to its own tree — a 403 otherwise, verified).
  const namespaces = {};
  for (const user of new Set([own, ...users]))
    namespaces[user] = { state: user === own ? "pending" : "operator" };
  const next = {
    version: JOURNAL_VERSION,
    embedder: expected,
    previous: stored,
    reset_at: at.toISOString(),
    moved_to: movedTo,
    namespaces,
  };
  try {
    writeJournal(home, next);
  } catch (err) {
    const reason = `could not write ${journalPath(home)}: ${err instanceof Error ? err.message : String(err)} — the collection stays where it is`;
    log(`openviking: reembed prepare FAILED — ${reason}`);
    return { action: "refuse", reason, expected, stored, collectionDir };
  }
  try {
    renameSync(collectionDir, movedTo);
  } catch (err) {
    const reason = `could not move ${collectionDir} aside: ${err instanceof Error ? err.message : String(err)}`;
    log(`openviking: reembed prepare FAILED — ${reason}`);
    restoreJournal(home, journal, log);
    return { action: "refuse", reason, expected, stored, collectionDir };
  }
  const operators = Object.keys(namespaces).filter((u) => u !== own);
  log(
    `openviking: reembed prepare — RESET: ${plan.reason}. The old collection is kept at ${movedTo}; ` +
      `${own} memory is re-embedded by the daemon once the server is ready` +
      (operators.length
        ? `; ${operators.join(", ")} by its key's holder (qcr memory reembed, then settle — docs/memory-embeddings.md)`
        : ""),
  );
  return {
    action: "reset",
    reason: plan.reason,
    expected,
    stored,
    collectionDir,
    movedTo,
    journal: next,
  };
}

/** Put the journal back as it was before a reset whose move failed: the
 * previous journal, or none. A restore that fails is logged; the journal it
 * leaves names a `moved_to` that does not exist, which the next `prepare`
 * reads as an interrupted reset and finishes. */
function restoreJournal(home, previous, log) {
  try {
    if (previous) writeJournal(home, previous);
    else unlinkSync(journalPath(home));
  } catch (err) {
    log(
      `openviking: reembed prepare — could not restore ${journalPath(home)}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---- resume (HTTP half) --------------------------------------------------------------

/**
 * The USER key as a Bearer, plus the identity header — and deliberately NOT
 * `X-OpenViking-Actor-Peer`, which every other call here carries. VERIFIED
 * LIVE (0.4.15): with an actor-peer header set, the reindex
 * route's authorisation treats a namespace-level URI as one that "may include
 * hidden actor peers" and answers 403 "USER can only reindex their own user
 * namespace" — for the namespace that key does own. Without it the same key
 * reindexes its own namespace and is still refused any other.
 */
export function reindexHeaders(key, user) {
  return {
    Authorization: `Bearer ${key}`,
    "X-OpenViking-User": user,
    "Content-Type": "application/json",
  };
}

async function call(fetchFn, url, init, timeoutMs) {
  try {
    const res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    let body = {};
    if (typeof res.json === "function") body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  } catch (err) {
    return { status: 0, body: {}, error: err instanceof Error ? err.message : String(err) };
  }
}

/** The counts out of a completed reindex result (a task's `result` or the
 * synchronous answer), tolerant of either envelope. */
export function countsOf(result) {
  const r = result && typeof result === "object" ? result : {};
  const n = (k) => (typeof r[k] === "number" ? r[k] : 0);
  return {
    scanned_records: n("scanned_records"),
    rebuilt_records: n("rebuilt_records"),
    failed_records: n("failed_records"),
    unsupported_records: n("unsupported_records"),
  };
}

function envelopeError(body) {
  return body && typeof body === "object" && body.status === "error";
}

function errorMessage(body, fallback) {
  const m = body?.error?.message;
  return typeof m === "string" && m !== "" ? m : fallback;
}

/**
 * Re-embed ONE user namespace through `POST /api/v1/content/reindex`
 * (`mode: "vectors_only"`, `wait: false`), then poll the task it returns until
 * it settles. Total: every outcome is a report, never a throw.
 *
 *   completed  the task finished; `failed_records` says whether every record
 *              made it (the caller re-runs when it did not)
 *   failed     the task failed, the request was refused (401/403 — the key
 *              does not own this namespace), or the server never answered
 *   busy       another reindex of this namespace is already running
 *              (409) — try again later; the server allows one at a time
 *   timeout    the task did not settle within `deadlineMs` — it may still be
 *              running server-side; the next run polls it again via 409
 */
/** @returns {Promise<ReindexResult>} */
export async function reindexNamespace({
  base,
  key,
  user,
  fetchFn = /** @type {OvFetch} */ (fetch),
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  requestTimeoutMs = DEFAULTS.requestTimeoutMs,
  pollMs = DEFAULTS.pollMs,
  deadlineMs = DEFAULTS.deadlineMs,
  log = /** @type {Log} */ (() => {}),
}) {
  const uri = `viking://user/${user}`;
  const headers = reindexHeaders(key, user);
  const started = await call(
    fetchFn,
    `${base}/api/v1/content/reindex`,
    { method: "POST", headers, body: JSON.stringify({ uri, mode: "vectors_only", wait: false }) },
    requestTimeoutMs,
  );
  if (started.status === 401 || started.status === 403) {
    return {
      status: "failed",
      uri,
      detail: `refused (HTTP ${started.status}): ${errorMessage(started.body, "this key does not own the namespace")}`,
    };
  }
  if (started.status === 409)
    return {
      status: "busy",
      uri,
      detail: "a reindex of this namespace is already running — retry later",
    };
  if (started.status < 200 || started.status >= 300 || envelopeError(started.body)) {
    return {
      status: "failed",
      uri,
      detail:
        started.error ??
        `HTTP ${started.status}: ${errorMessage(started.body, "reindex request refused")}`,
    };
  }
  const result =
    started.body?.result && typeof started.body.result === "object" ? started.body.result : {};
  if (result.status === "completed") return { status: "completed", uri, ...countsOf(result) };
  const taskId = typeof result.task_id === "string" ? result.task_id : "";
  if (!taskId)
    return {
      status: "failed",
      uri,
      detail: "the server accepted the reindex but named no task to follow",
    };
  log(`openviking: reembed ${uri} — task ${taskId} accepted`);

  const deadline = now() + deadlineMs;
  for (;;) {
    await sleep(pollMs);
    const task = await call(
      fetchFn,
      `${base}/api/v1/tasks/${encodeURIComponent(taskId)}`,
      { method: "GET", headers },
      requestTimeoutMs,
    );
    if (task.status >= 200 && task.status < 300 && !envelopeError(task.body)) {
      const t = task.body?.result && typeof task.body.result === "object" ? task.body.result : {};
      if (t.status === "completed")
        return { status: "completed", uri, task_id: taskId, ...countsOf(t.result) };
      if (t.status === "failed" || t.status === "cancelled") {
        return {
          status: "failed",
          uri,
          task_id: taskId,
          detail: `task ${t.status}: ${typeof t.error === "string" && t.error ? t.error : "no detail"}`,
        };
      }
    }
    if (now() >= deadline)
      return {
        status: "timeout",
        uri,
        task_id: taskId,
        detail: `task ${taskId} did not settle within ${Math.round(deadlineMs / 1000)}s`,
      };
  }
}

/**
 * One resume pass for `user`'s namespace: nothing to do unless the journal
 * marks it pending or failed. Writes the outcome back to the journal.
 *
 * A namespace is `completed` ONLY when the task finished with zero failed
 * records — a partial rebuild stays `failed` so the next run retries it, and
 * the counts in the journal say exactly how far the last attempt got.
 */
/** @param {{ home: string, base: string, key: string, user: string, fetchFn?: OvFetch, now?: () => Date, sleep?: (ms: number) => Promise<void>, pollMs?: number, deadlineMs?: number, requestTimeoutMs?: number, log?: Log }} opts */
export async function resume({
  home,
  base,
  key,
  user,
  fetchFn = /** @type {OvFetch} */ (fetch),
  now = () => new Date(),
  sleep,
  pollMs,
  deadlineMs,
  requestTimeoutMs,
  log = /** @type {Log} */ (() => {}),
}) {
  const { journal, unreadable } = readJournal(home);
  if (unreadable)
    return { action: "none", state: "unreadable", detail: `${journalPath(home)} cannot be parsed` };
  const ns = journal?.namespaces?.[user];
  if (!journal || !ns)
    return { action: "none", state: "none", detail: `no re-embed on record for ${user}` };
  if (ns.state === "completed")
    return {
      action: "none",
      state: "completed",
      detail: `${user} already re-embedded at ${ns.at ?? "?"}`,
    };
  if (ns.state === "operator")
    return {
      action: "none",
      state: "operator",
      detail: `${user} is another key holder's namespace — this host cannot re-embed it`,
    };
  if (!key)
    return {
      action: "none",
      state: ns.state,
      detail: `no ${user} key — cannot re-embed until one is provisioned`,
    };

  const run = await reindexNamespace({
    base,
    key,
    user,
    fetchFn,
    now: () => now().getTime(),
    sleep,
    pollMs,
    deadlineMs,
    requestTimeoutMs,
    log,
  });
  const at = now().toISOString();
  let state;
  if (run.status === "completed" && run.failed_records === 0) state = "completed";
  else if (run.status === "busy" || run.status === "timeout") state = "pending";
  else state = "failed";
  const entry = {
    state,
    at,
    attempts: (typeof ns.attempts === "number" ? ns.attempts : 0) + 1,
    ...(run.task_id ? { task_id: run.task_id } : {}),
    ...(run.status === "completed"
      ? {
          scanned_records: run.scanned_records,
          rebuilt_records: run.rebuilt_records,
          failed_records: run.failed_records,
          unsupported_records: run.unsupported_records,
        }
      : {}),
    detail:
      run.status === "completed"
        ? run.failed_records === 0
          ? `re-embedded: ${run.rebuilt_records} vector records rebuilt from ${run.scanned_records} sources`
          : `partial: ${run.failed_records} of ${run.scanned_records} sources failed — will retry`
        : run.detail,
  };
  // The rebuild above can run for its whole deadline, and `settle` writes this
  // same file from another process meanwhile. So the outcome is merged into
  // the journal as it stands NOW, touching only this host's own row — never
  // written back over the snapshot read before the rebuild, which would
  // silently undo an operator's receipt. (Read and write are synchronous: no
  // turn of this process can interleave between them.)
  const fresh = readJournal(home).journal;
  const freshNs = fresh?.namespaces?.[user];
  if (!fresh || !freshNs || fresh.reset_at !== journal.reset_at) {
    // The migration this rebuild belonged to is gone or was re-armed: its
    // outcome says nothing about the journal on disk now.
    const detail = `${state}, not journalled: the migration changed underneath`;
    log(`openviking: reembed ${run.uri} — ${detail}`);
    return { action: "reindex", state, run, entry, detail };
  }
  if (freshNs.state === "completed" && freshNs.settled_by === "operator") {
    // The operator settled this row by their explicit word mid-rebuild; that
    // receipt stands.
    const detail = `${state}, not journalled: settled by the operator meanwhile`;
    log(`openviking: reembed ${run.uri} — ${detail}`);
    return { action: "reindex", state, run, entry, detail };
  }
  writeJournal(home, { ...fresh, namespaces: { ...fresh.namespaces, [user]: entry } });
  log(`openviking: reembed ${run.uri} — ${state}: ${entry.detail}`);
  return { action: "reindex", state, run, entry };
}

// ---- cli ----------------------------------------------------------------------------

export function parseArgs(argv, env = process.env) {
  const positional = [];
  const flags = new Map();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const [name, inline] = a.slice(2).split("=", 2);
    if (inline !== undefined) flags.set(name, inline);
    else if (argv[i + 1] && !argv[i + 1].startsWith("--")) flags.set(name, argv[++i]);
    else flags.set(name, "true");
  }
  const home = flags.get("home") ?? env.QCR_OV_HOME ?? "";
  const port = Number(flags.get("port") ?? 1933);
  return {
    command: positional[0] ?? "status",
    home,
    config: flags.get("config") ?? (home ? join(home, "ov.conf") : ""),
    users: String(flags.get("users") ?? "reviewer,companion")
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter((s) => s !== ""),
    base: flags.get("base") ?? env.QCR_OV_BASE ?? DEFAULTS.base,
    user: flags.get("user") ?? DEFAULTS.user,
    keyFile: flags.get("key-file") ?? "",
    keyEnv: flags.get("key-env") ?? "",
    detail: flags.get("detail") ?? "",
    bin: flags.get("bin") ?? "",
    host: flags.get("host") ?? "127.0.0.1",
    port,
    readyTimeoutMs: Number(flags.get("ready-timeout-ms") ?? DEFAULTS.readyTimeoutMs),
    deadlineMs: Number(flags.get("deadline-ms") ?? DEFAULTS.deadlineMs),
    strict: flags.has("strict"),
    // `rehearse` only: the local embedder to run beside the temporary server
    // — a spec, `null`, or an error string.
    embedder: embedderSpecFromFlags(flags),
  };
}

function readConf(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** The namespace key for `resume`/`rehearse`: a file (0600, like every other
 * secret here) or an environment variable name — never a value on the argv. */
function keyFor(cfg, env = process.env) {
  if (cfg.keyFile) return readSecret(cfg.keyFile);
  if (cfg.keyEnv) return String(env[cfg.keyEnv] ?? "").trim();
  return "";
}

export async function main(argv, { env = process.env, log = (line) => console.log(line) } = {}) {
  const cfg = parseArgs(argv, env);
  if (!cfg.home) {
    log("openviking-reembed: --home <openviking home> is required (the directory holding ov.conf)");
    return 2;
  }
  switch (cfg.command) {
    case "status": {
      log(JSON.stringify(journalStatus(cfg.home), null, 2));
      return 0;
    }
    case "prepare": {
      const conf = readConf(cfg.config);
      if (!conf) {
        log(
          `openviking: reembed prepare skipped — ${cfg.config} is missing or not JSON (the render did not run?)`,
        );
        return cfg.strict ? 1 : 0;
      }
      const base = `http://${cfg.host}:${Number(conf?.server?.port ?? cfg.port)}`;
      const report = await prepare({
        home: cfg.home,
        conf,
        users: cfg.users,
        own: cfg.user,
        base,
        log,
      });
      return report.action === "refuse" && cfg.strict ? 1 : 0;
    }
    case "settle": {
      const r = settle({ home: cfg.home, user: cfg.user, detail: cfg.detail });
      log(
        `openviking: reembed settle ${cfg.user} — ${r.ok ? "completed" : "refused"}: ${r.detail}`,
      );
      return r.ok ? 0 : 1;
    }
    case "resume": {
      const report = await resume({
        home: cfg.home,
        base: cfg.base,
        key: keyFor(cfg, env),
        user: cfg.user,
        deadlineMs: cfg.deadlineMs,
        log,
      });
      log(
        `openviking: reembed resume — ${report.action}: ${report.state} (${report.detail ?? report.entry?.detail ?? ""})`,
      );
      return cfg.strict && report.state !== "completed" && report.state !== "none" ? 1 : 0;
    }
    case "rehearse": {
      // Everything, against a COPY: reset, a temporary server of our own,
      // the reindex, stop. Strict by nature — a rehearsal that did not
      // complete is the answer "do not run this on the live store yet".
      const conf = readConf(cfg.config);
      if (!conf) {
        log(`openviking-reembed: ${cfg.config} is missing or not JSON`);
        return 1;
      }
      if (!cfg.bin) {
        log("openviking-reembed: rehearse needs --bin <openviking-server>");
        return 1;
      }
      // An ov.conf on the local English embedder needs it running
      // — the server's /ready probes it, and the reindex is nothing but
      // embedding calls. Same flags as boot provisioning (--embedder-*),
      // checked BEFORE anything on disk moves.
      if (typeof cfg.embedder === "string") {
        log(`openviking-reembed: ${cfg.embedder}`);
        return 1;
      }
      const base = `http://${cfg.host}:${cfg.port}`;
      const prepared = await prepare({
        home: cfg.home,
        conf,
        users: cfg.users,
        own: cfg.user,
        base,
        log,
      });
      if (prepared.action === "refuse") return 1;
      let embedder = null;
      if (cfg.embedder) {
        const started = await startEmbedder(cfg.embedder, {
          log,
          readyTimeoutMs: cfg.readyTimeoutMs,
        });
        embedder = started.child;
        if (!started.ready) {
          await stopServerChild(embedder);
          return 1;
        }
      }
      const child = spawn(
        cfg.bin,
        serverArgv({ config: cfg.config, host: cfg.host, port: cfg.port }),
        { stdio: ["ignore", "inherit", "inherit"] },
      );
      child.on("error", (err) =>
        log(`openviking-reembed: could not start the server (${err.message})`),
      );
      child.unref?.();
      try {
        if (!(await waitForReady({ base, timeoutMs: cfg.readyTimeoutMs }))) {
          log("openviking-reembed: the server never became ready — see its log above");
          return 1;
        }
        const report = await resume({
          home: cfg.home,
          base,
          key: keyFor(cfg, env),
          user: cfg.user,
          deadlineMs: cfg.deadlineMs,
          log,
        });
        log(JSON.stringify(journalStatus(cfg.home), null, 2));
        return report.state === "completed" ? 0 : 1;
      } finally {
        await stopServerChild(child);
        await stopServerChild(embedder);
      }
    }
    default:
      log(
        `openviking-reembed: unknown command '${cfg.command}' (prepare | resume | status | settle | rehearse)`,
      );
      return 2;
  }
}

const invokedDirectly = (() => {
  try {
    return (
      process.argv[1] !== undefined &&
      import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
    );
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      if (typeof code === "number" && code !== 0) process.exit(code);
    })
    .catch((err) => {
      // Never a non-zero exit on an unexpected throw from the boot path:
      // memory must not block the reviewer coming up.
      console.log(
        `openviking: reembed failed (${err instanceof Error ? err.message : String(err)}) — the server may refuse to start until an operator looks`,
      );
    });
}

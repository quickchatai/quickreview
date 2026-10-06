// The OpenViking HTTP client — the ONE place in the daemon that
// knows OpenViking speaks HTTP on loopback :1933.
//
// Everything above this file (the `MemoryStore` seam, the round's
// `ContextAssembler`) is engine-agnostic; everything below is the server. The
// client's whole job is to turn an HTTP surface that can be down, slow, or
// wrong into a TOTAL function: `OvOutcome<T>` for every call, never a
// rejection.
//
// Four facts about the running v0.4.15 server shape this module. They were
// verified against it and they contradict the published docs
// in places — do not "correct" them back:
//
//   1. WRITES GO THROUGH `content/batch-write`, EXCLUSIVELY. For memory-context
//      targets, bare `content/write` appends a server-side `MEMORY_FIELDS`
//      footer that `content/read` strips again, and no API returns the stored
//      hash — so a read → sha256 → write cycle 409s FOREVER on any file that
//      endpoint created. Files written by batch-write carry no footer and
//      round-trip exactly. This client therefore has NO `content/write`
//      wrapper at all: the footgun is removed by absence, not by a comment.
//   2. `replace_if_hash` with a stale `base_hash` returns 409 CONFLICT and
//      leaves the file verifiably unchanged. That is a clean, ordinary answer
//      ("someone edited this since you read it") — `conflict: true` on the
//      outcome, never an exception. The SAME status and code also mean "the
//      directory was locked by another writer" (`details.conflict_type =
//      "path_busy"`: batch-write's root lock is a zero-timeout try-lock), and
//      that one is NOT a refusal — nothing was checked. It is told apart by
//      `details.conflict_type` alone and retried here (S2).
//   3. SEARCH IS `POST /api/v1/search/search` with `mode: "context"`, and the
//      determinism knobs are pinned OFF here rather than left to the caller:
//      `rewrite` and `query_expansion` both invoke a server-side LLM, and the
//      daemon has no LLM in its hot path. Note the wire spelling: `rewrite` is
//      typed `bool | "auto"` server-side, so "off" IS `false` — sending the
//      string "off" is a 422, i.e. a silent memory outage.
//   4. AUTH IS THE REVIEWER USER KEY, `Authorization: Bearer <key>`, and
//      nothing else. The server confines that key to `user/reviewer/` (403
//      across users — a real guarantee, not a convention), the identity
//      headers are ignored in api_key mode, and an ADMIN/ROOT key must never
//      appear here: ADMIN grants no cross-user data access anyway and can list
//      every user key in plaintext. The key is supplied by the caller, read
//      lazily, and NEVER logged — `redact()` scrubs it out of every failure
//      message at construction, before any caller can log or render one.
import { readFileSync, statSync } from "node:fs";

/** The `fetch` slice this client uses — the whole network seam. */
export interface HttpFetch {
  (
    url: string,
    init: {
      method: string;
      headers: Record<string, string>;
      body?: string;
      signal?: AbortSignal;
    },
  ): Promise<HttpResponse>;
}

export interface HttpResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

/** A call that did not do what was asked — logged, and handed to `onGap` for
 * the overseer anomaly. Never carries the key or a header map. */
export interface OvGap {
  /** Short operation name: `batch_write`, `search`, `read`, … */
  op: string;
  /** HTTP status, or 0 for "never got an answer". */
  status: number;
  /** Server error code (`CONFLICT`, `PERMISSION_DENIED`, …) or `transport`. */
  code: string;
  message: string;
}

/**
 * Every call's answer.
 *
 * `conflict` is broken out of the failure arm because it is the one refusal
 * that is not a gap: a 409 means the optimistic-concurrency precondition did
 * its job. Callers surface it to an operator; nothing alerts on it.
 *
 * `busy` is the OTHER 409 (S2), and it is never a `conflict`. The
 * server takes a zero-timeout try-lock on a batch-write's root directory, and
 * a second writer into the same directory gets `409 CONFLICT` with
 * `details.conflict_type = "path_busy"` and `retryable: true` — nothing was
 * checked and nothing was written. Reading that as "the precondition refused"
 * is what dropped 6 of 8 EOD writes on 2026-10-05: the caller was told to
 * re-read a file nobody had touched. The client retries a busy answer itself
 * (bounded, jittered — see `BUSY_RETRY_DEFAULTS`); one that is still busy
 * when the budget runs out comes back `busy: true, conflict: false`, an
 * ordinary failure.
 */
export interface OvFailure {
  ok: false;
  status: number;
  code: string;
  message: string;
  conflict: boolean;
  busy: boolean;
}

export type OvOutcome<T> = { ok: true; status: number; result: T } | OvFailure;

/** Returns the FAILURE arm, not the union: a caller that builds one wants to
 * read `conflict` off it without re-narrowing. A busy answer is never a
 * conflict, whatever its status says. */
export function ovFailed(status: number, code: string, message: string, busy = false): OvFailure {
  return {
    ok: false,
    status,
    code,
    message,
    conflict: !busy && (status === 409 || code === "CONFLICT"),
    busy,
  };
}

/** The `details.conflict_type` the server stamps on a lock it could not take
 * (`server/error_mapping.py`, `ResourceBusyError` / `LockAcquisitionError`). */
export const BUSY_CONFLICT_TYPE = "path_busy";

/**
 * Is this error envelope the server's "directory busy, try again" answer
 * (S2)? Keyed on `details.conflict_type`, never on the message text
 * and never on the status alone: a hash-precondition 409 carries the same
 * status and code, and it must stay a refusal.
 */
export function isBusyConflict(status: number, error: unknown): boolean {
  if (status !== 409 || !error || typeof error !== "object") return false;
  const details = (error as { details?: unknown }).details;
  if (!details || typeof details !== "object") return false;
  return (details as { conflict_type?: unknown }).conflict_type === BUSY_CONFLICT_TYPE;
}

/** How hard the client retries a busy answer: at most `retries` more
 * attempts, the n-th after a jittered `min(capMs, baseMs·2ⁿ)` wait (half to
 * all of it), and never past `budgetMs` from the first attempt — the bound
 * is ≤10 s in total, so a lock held for longer comes back as a failure the
 * caller can see rather than a request that hangs. */
export const BUSY_RETRY_DEFAULTS = Object.freeze({
  retries: 4,
  baseMs: 250,
  capMs: 2000,
  budgetMs: 10_000,
});

export interface BusyRetryOptions {
  retries?: number;
  baseMs?: number;
  capMs?: number;
  budgetMs?: number;
}

/** The wait before busy retry number `retry` (0-based): full exponential
 * step, capped, then jittered into [½, 1] of it so writers that collided once
 * do not collide again in lockstep. Pure — `random` is injected. */
export function busyRetryDelay(
  retry: number,
  random: () => number = Math.random,
  opts: BusyRetryOptions = {},
): number {
  const base = opts.baseMs ?? BUSY_RETRY_DEFAULTS.baseMs;
  const cap = opts.capMs ?? BUSY_RETRY_DEFAULTS.capMs;
  const step = Math.min(cap, base * 2 ** Math.max(0, retry));
  const r = Math.min(1, Math.max(0, random()));
  return Math.round(step * (0.5 + r / 2));
}

/** Server error codes that mean "this key does not authenticate here". */
const AUTH_CODES = new Set([
  "UNAUTHENTICATED",
  "UNAUTHORIZED",
  "PERMISSION_DENIED",
  "FORBIDDEN",
  "INVALID_API_KEY",
]);

/**
 * Is this answer an authentication failure (S1)?
 *
 * A 401/403, an auth error code, or the message the 0.4.15 server actually
 * sends on a bad key ("Invalid API Key"), which it has been seen to wrap in an
 * HTTP-200 error envelope. Five weeks of rounds read that answer as "memory
 * unavailable" and nobody was told; this predicate is what lets every reader
 * call it what it is. `no_key` (nothing to send at all) is NOT this — callers
 * that care treat it alongside, by code.
 */
export function isAuthFailure(status: number, code: string, message = ""): boolean {
  if (status === 401 || status === 403) return true;
  if (AUTH_CODES.has(code.toUpperCase())) return true;
  return /invalid api key|unauthenticated|unauthori[sz]ed/i.test(message);
}

/**
 * Is this answer a NOT_FOUND (S1)? The server authenticates a key
 * before it resolves a path, so a NOT_FOUND is an authenticated ANSWER — the
 * path is not there — never an outage. The store already reads it as "absent,
 * known-empty" and ovsession's delete as the desired end state; the probe and
 * the request observer read it the same way through this one predicate.
 */
export function isNotFound(status: number, code: string): boolean {
  return status === 404 || code === "NOT_FOUND";
}

/** One request, as the client's observer sees it (S1): what was
 * asked, how it ended, how long it took. Never the key, never a header, never
 * a body — it is a counter's input, not a log line. */
export interface OvRequestRecord {
  op: string;
  /** `ok` — answered; `absent` — a NOT_FOUND answer (authenticated; the path
   * is not there — an answer, not a failure); `conflict` — a 409 precondition
   * refusal (an answer, not a failure); `auth` — the key did not
   * authenticate, or there was no key to send; `failed` — everything else
   * (transport, 5xx, bad body). */
  outcome: "ok" | "absent" | "conflict" | "auth" | "failed";
  status: number;
  code: string;
  /** Wall-clock ms the request took (0 when nothing was sent). */
  ms: number;
  /** The failure message, already scrubbed of the key. Absent on success. */
  message?: string;
}

// ---- request/response shapes ------------------------------------------------

/** batch-write's precondition. `create_if_absent` MUST NOT carry a hash and
 * `replace_if_hash` MUST — the server rejects the other combinations. */
export type BatchWritePrecondition =
  { kind: "create_if_absent" } | { kind: "replace_if_hash"; base_hash: string };

export interface BatchWriteOperation {
  uri: string;
  content: string;
  precondition: BatchWritePrecondition;
}

export interface BatchWriteRequest {
  root_uri: string;
  operations: BatchWriteOperation[];
  /** `wait` blocks on the semantic/vector refresh — ~1.6 CORE-seconds per
   * ~500 B write on the 2-CPU container quota. The bytes are durable either
   * way; only searchability lags. Default false: memory never delays a round. */
  wait: boolean;
}

export interface BatchWriteResult {
  root_uri: string;
  created: string[];
  updated: string[];
  unchanged: string[];
}

export interface OvDirEntry {
  uri: string;
  name: string;
  isDir: boolean;
  size: number;
  modTime: string;
}

/** One entry of a `mode: "context"` search. */
export interface ContextSearchEntry {
  uri: string;
  category: string;
  score: number;
  /** Which tier of the document was returned: `abstract` | `overview` | `full`. */
  detail: string;
  text: string;
  origin: string;
}

/** What a context search produced: the server-rendered block the round pastes,
 * the entries behind it, and the budget accounting. Both halves are exposed —
 * the block is what a prompt carries, the stats are what tells us whether the
 * budget was actually spent. */
export interface ContextSearchResult {
  entries: ContextSearchEntry[];
  rendered: string;
  digest: string;
  stats: Record<string, unknown>;
}

/**
 * The quota buckets the server will accept (`CATEGORY_KEYS` in
 * `retrieve/context_assembler/params.py`). An unknown key is a 422 for the
 * WHOLE request, so unknown keys are dropped with a gap rather than sent.
 */
export const QUOTA_CATEGORIES: readonly string[] = [
  "events",
  "entities",
  "preferences",
  "experiences",
  "resources",
  "skills",
];

export type TimeField = "updated_at" | "created_at";

export interface ContextSearchOptions {
  /** Token budget for the assembled block (server clamps to 64…32000). */
  maxTokens?: number;
  /** Per-category caps, keys from `QUOTA_CATEGORIES`. */
  quotas?: Record<string, number>;
  /** Retrieval-tag filter (the `fs/attrs/set_tags` list, not body text). */
  tags?: string[];
  /** ISO instants bounding `timeField` (default the server's `updated_at`). */
  since?: string;
  until?: string;
  timeField?: TimeField;
  scoreThreshold?: number;
  limit?: number;
  purpose?: "chat" | "coding";
  excludeUris?: string[];
  timeoutMs?: number;
}

/** The most exclusions one search request carries. A request-size bound, not
 * a correctness one: past it the search can return an excluded entry, so a
 * caller that must never see one (the round's context block) filters the
 * result against its full list too. */
export const EXCLUDE_URIS_CAP = 200;

/**
 * The exact body of a context search — pure, so the determinism guarantees are
 * unit-testable without a server.
 *
 * `mode`, `rewrite` and `query_expansion` are NOT parameters. A round prompt
 * must be reproducible from the round order, and both `rewrite: "auto"` and
 * `query_expansion: "auto"` (the server's DEFAULT for the latter) put an LLM
 * inside the daemon's hot path. They are pinned off here so no caller can ask
 * for them by accident.
 */
export function buildContextSearchBody(
  query: string,
  opts: ContextSearchOptions = {},
  onGap?: (gap: OvGap) => void,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    query,
    mode: "context",
    // `false`, not "off": the server types this `bool | "auto"`.
    rewrite: false,
    query_expansion: "off",
  };
  if (opts.maxTokens !== undefined)
    body["max_tokens"] = Math.max(64, Math.min(32000, Math.floor(opts.maxTokens)));
  if (opts.limit !== undefined) body["limit"] = Math.max(1, Math.floor(opts.limit));
  if (opts.scoreThreshold !== undefined) body["score_threshold"] = opts.scoreThreshold;
  if (opts.purpose !== undefined) body["purpose"] = opts.purpose;
  if (opts.quotas) {
    const quotas: Record<string, number> = {};
    for (const [key, value] of Object.entries(opts.quotas)) {
      if (!QUOTA_CATEGORIES.includes(key)) {
        onGap?.({
          op: "search",
          status: 0,
          code: "bad_quota",
          message: `dropped unknown quota category '${key}'`,
        });
        continue;
      }
      quotas[key] = Math.max(0, Math.floor(value));
    }
    if (Object.keys(quotas).length > 0) body["quotas"] = quotas;
  }
  const tags = (opts.tags ?? [])
    .map((t) => t.replace(/^#+/, "").trim().toLowerCase())
    .filter((t) => t !== "");
  if (tags.length > 0) body["tags"] = [...new Set(tags)];
  if (opts.since) body["since"] = opts.since;
  if (opts.until) body["until"] = opts.until;
  if (opts.timeField) body["time_field"] = opts.timeField;
  if (opts.excludeUris && opts.excludeUris.length > 0) {
    body["exclude_uris"] = opts.excludeUris.slice(0, EXCLUDE_URIS_CAP);
    if (opts.excludeUris.length > EXCLUDE_URIS_CAP)
      onGap?.({
        op: "search",
        status: 0,
        code: "exclude_truncated",
        message: `sent ${EXCLUDE_URIS_CAP} of ${opts.excludeUris.length} exclusions; the rest are filtered from the result by the caller`,
      });
  }
  return body;
}

/**
 * The session memory policy every session this system creates MUST carry.
 *
 * Our deployment configures no `vlm` on purpose — memories are AUTHORED by
 * sessions and the EOD curator, never extracted. A session created without
 * this policy queues an extraction task on every single commit and every one
 * of them FAILS (verified). Disabling all three at create time makes commit
 * complete cleanly with `memories_extracted: {}` and zero LLM tokens.
 */
export const DISABLED_MEMORY_POLICY = Object.freeze({
  self: { enabled: false },
  peer: { enabled: false },
  working_memory: { enabled: false },
});

export interface OvSessionResult {
  session_id: string;
  uri?: string;
}

// ---- the client -------------------------------------------------------------

/** How the reviewer key is obtained. A function is read on every request (so a
 * secret that appears later is picked up without a restart) — implementations
 * are expected to memoize, see `keyFromFile`. */
export type KeySource = string | (() => string | null | undefined);

export interface OpenVikingClientOptions {
  /** `http://127.0.0.1:1933` — from `openVikingBaseUrl(config.openviking)`. */
  baseUrl: string;
  /** The reviewer USER key. Absent ⇒ every call degrades exactly like a dead
   * server, which is the correct behaviour on a dev PC with no secret. */
  apiKey?: KeySource;
  /** OpenViking user id — the tree the key is confined to. */
  user?: string;
  account?: string;
  /** Sent as `X-OpenViking-Actor-Peer`. A peer is a retrieval hint, NEVER an
   * ACL (verified: a peer header writes freely outside the peer dir). */
  peerId?: string;
  /** Per-request deadline. Memory is a soft dependency; this is its ceiling. */
  timeoutMs?: number;
  fetchFn?: HttpFetch;
  log?: (msg: string, extra?: unknown) => void;
  /** Called for every gap, so the daemon can raise an overseer anomaly. Must
   * not throw; a throwing sink is swallowed rather than escaping a call. */
  onGap?: (gap: OvGap) => void;
  /** Called once per request with its outcome (S1) — successes too,
   * which `onGap` never sees. The daemon counts its own requests per
   * operation and feeds the memory health monitor from here; the TUI counts
   * its own. Must not throw; a throwing observer is swallowed. */
  onRequest?: (record: OvRequestRecord) => void;
  /** Millisecond clock for `OvRequestRecord.ms`. Tests inject one. */
  clock?: () => number;
  /** The busy-retry bound (S2) — `BUSY_RETRY_DEFAULTS` when absent. */
  busyRetry?: BusyRetryOptions;
  /** The wait between busy retries. Tests inject an instant one. */
  sleep?: (ms: number) => Promise<void>;
  /** The jitter source for busy retries. Tests inject a fixed one. */
  random?: () => number;
}

/** A key read lazily from a file: call it for the current key, and
 * `invalidate()` it when the server says the key is wrong, so the next call
 * re-reads the file instead of re-sending a key the server refused. */
export interface KeyFileSource {
  (): string | null;
  invalidate(): void;
}

/**
 * Reads a key file and remembers the answer (including "not there"),
 * re-checking at most every `ttlMs`.
 *
 * A secret that lands after boot is picked up without a restart, and a missing
 * one does not stat the disk per request. Since S1 a FOUND key is no
 * longer remembered forever: every `ttlMs` the file is re-stat'ed, and a file
 * whose identity (inode, size or mtime) changed is re-read — so a rotated key
 * reaches the daemon within one TTL, and a removed one stops being sent. A 401
 * from the server calls `invalidate()` (see `OpenVikingClient`), which makes
 * the very next request re-read the file. The cache that held a dead key for
 * the life of the process is what kept memory down from 2026-09-03 to 10-02.
 */
export function keyFromFile(
  path: string,
  ttlMs = 60_000,
  now: () => number = Date.now,
): KeyFileSource {
  let cached: string | null = null;
  let signature: string | null = null;
  let checkedAt = -Infinity;
  const read = (): string | null => {
    if (now() - checkedAt < ttlMs) return cached;
    checkedAt = now();
    let sig: string;
    try {
      const st = statSync(path);
      sig = `${st.ino}:${st.size}:${st.mtimeMs}`;
    } catch {
      // Gone (or unreadable): a key that is no longer on disk is no longer
      // ours to send. A keyless client is loud (`no_key`), never silent.
      cached = null;
      signature = null;
      return cached;
    }
    if (sig === signature && cached !== null) return cached;
    try {
      const value = readFileSync(path, "utf8").trim();
      cached = value === "" ? null : value;
      signature = sig;
    } catch {
      cached = null;
      signature = null;
    }
    return cached;
  };
  const source = read as KeyFileSource;
  source.invalidate = () => {
    checkedAt = -Infinity;
    signature = null;
  };
  return source;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export class OpenVikingClient {
  private readonly baseUrl: string;
  private readonly key: () => string | null;
  /** The key source's cache-drop, when it has one (`keyFromFile`). */
  private readonly invalidateKey: (() => void) | undefined;
  private readonly user: string;
  private readonly account: string;
  private readonly peerId: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: HttpFetch;
  private readonly log: (msg: string, extra?: unknown) => void;
  private readonly onGap: ((gap: OvGap) => void) | undefined;
  private readonly onRequest: ((record: OvRequestRecord) => void) | undefined;
  private readonly clock: () => number;
  private readonly busyRetry: Required<BusyRetryOptions>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private keyGapReported = false;

  constructor(opts: OpenVikingClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    const source = opts.apiKey;
    this.key = typeof source === "function" ? () => source() ?? null : () => source ?? null;
    const invalidate =
      typeof source === "function" ? (source as Partial<KeyFileSource>).invalidate : undefined;
    this.invalidateKey = typeof invalidate === "function" ? () => invalidate() : undefined;
    this.user = opts.user ?? "reviewer";
    this.account = opts.account ?? "";
    this.peerId = opts.peerId ?? "";
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchFn = opts.fetchFn ?? defaultFetch;
    this.log = opts.log ?? (() => {});
    this.onGap = opts.onGap;
    this.onRequest = opts.onRequest;
    this.clock = opts.clock ?? Date.now;
    this.busyRetry = { ...BUSY_RETRY_DEFAULTS, ...(opts.busyRetry ?? {}) };
    this.sleep = opts.sleep ?? defaultSleep;
    this.random = opts.random ?? Math.random;
  }

  /** Hand one request's outcome to the observer — never throws. */
  private observe(record: OvRequestRecord): void {
    try {
      this.onRequest?.(record);
    } catch {
      // A counter that throws must not become a memory outage.
    }
  }

  /** The user tree this client's key is confined to — the root every memory
   * URI is built under. */
  memoriesRoot(): string {
    return `viking://user/${this.user}/memories`;
  }

  /** Scrub the key out of a string before it can leave this class. The key is
   * never deliberately logged; this is the belt to that braces, because server
   * error bodies have been known to echo request material. It is applied where
   * a failure is CONSTRUCTED (`request()`), so every consumer of an
   * `OvFailure.message` or `OvGap.message` — the round prompt's unreadable
   * note, the overseer anomaly, the daemon log, the `onGap` sink — receives the
   * scrubbed text; `report()` scrubs its own line again as braces. */
  private redact(text: string): string {
    const key = this.key();
    if (!key || key.length < 8) return text;
    return text.split(key).join("<redacted>");
  }

  private report(gap: OvGap): void {
    this.log(
      `openviking: ${gap.op} failed (${gap.status || "no answer"} ${gap.code}): ${this.redact(gap.message)}`,
    );
    try {
      this.onGap?.(gap);
    } catch {
      // An alerting sink that throws must not become a memory outage, and
      // certainly must not propagate into a review round.
    }
  }

  /**
   * One request, total. Every failure mode — no key, connection refused,
   * timeout, non-JSON body, `{status:"error"}` envelope, a `fetch` seam that
   * throws synchronously — comes back as the failure arm of `OvOutcome`.
   *
   * A BUSY answer (`409 path_busy`, see `OvFailure`) is retried here, for
   * every operation: the server answers busy before it checks or writes
   * anything, so a repeat can never double a write. Each retried busy answer
   * is observed as an answer (`conflict` — the server is up and took the
   * key); one still busy when `BUSY_RETRY_DEFAULTS` runs out is reported as
   * the gap it is and returned `busy: true`. A hash-precondition 409 is never
   * retried: it is the refusal it says it is.
   */
  async request<T>(
    op: string,
    path: string,
    init: { method: string; body?: unknown; timeoutMs?: number },
  ): Promise<OvOutcome<T>> {
    const started = this.clock();
    for (let retry = 0; ; retry += 1) {
      const { res, ms } = await this.attempt<T>(op, path, init);
      if (res.ok || !res.busy) return res;
      const delay = busyRetryDelay(retry, this.random, this.busyRetry);
      const elapsed = this.clock() - started;
      if (retry >= this.busyRetry.retries || elapsed + delay > this.busyRetry.budgetMs) {
        const message = `${res.message} — still busy after ${retry} ${retry === 1 ? "retry" : "retries"} (${elapsed} ms); nothing was written`;
        this.report({ op, status: res.status, code: BUSY_CONFLICT_TYPE, message });
        this.observe({
          op,
          outcome: "failed",
          status: res.status,
          code: BUSY_CONFLICT_TYPE,
          ms,
          message,
        });
        return ovFailed(res.status, res.code, message, true);
      }
      this.observe({
        op,
        outcome: "conflict",
        status: res.status,
        code: BUSY_CONFLICT_TYPE,
        ms,
        message: res.message,
      });
      this.log(
        `openviking: ${op} answered busy (${BUSY_CONFLICT_TYPE}) — retry ${retry + 1} in ${delay} ms`,
      );
      await this.sleep(delay);
    }
  }

  /** One attempt of `request()`. Observes and reports everything except a
   * busy answer, which `request()` decides about (retry, or report once). */
  private async attempt<T>(
    op: string,
    path: string,
    init: { method: string; body?: unknown; timeoutMs?: number },
  ): Promise<{ res: OvOutcome<T>; ms: number }> {
    const key = this.key();
    if (!key) {
      // Reported ONCE per client: a keyless deployment is a standing condition
      // (a dev PC with no secret), and every call would otherwise raise the
      // same anomaly. It must still never look like success — and the
      // observer hears EVERY one, because the health monitor counts it as an
      // authentication failure rather than as quiet.
      if (!this.keyGapReported) {
        this.keyGapReported = true;
        this.report({
          op,
          status: 0,
          code: "no_key",
          message:
            "no OpenViking reviewer key configured — every memory call degrades until one is",
        });
      }
      this.observe({
        op,
        outcome: "auth",
        status: 0,
        code: "no_key",
        ms: 0,
        message: "no OpenViking key configured",
      });
      return { res: ovFailed(0, "no_key", "no OpenViking reviewer key configured"), ms: 0 };
    }
    const started = this.clock();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    };
    // Ignored in api_key mode, load-bearing in trusted mode. Harmless either
    // way, and it keeps the identity explicit in the request we send.
    if (this.account) headers["X-OpenViking-Account"] = this.account;
    if (this.user) headers["X-OpenViking-User"] = this.user;
    if (this.peerId) headers["X-OpenViking-Actor-Peer"] = this.peerId;

    let res: HttpResponse;
    let raw: string;
    try {
      const signal = timeoutSignal(init.timeoutMs ?? this.timeoutMs);
      res = await this.fetchFn(`${this.baseUrl}${path}`, {
        method: init.method,
        headers,
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        ...(signal ? { signal } : {}),
      });
      raw = await res.text();
    } catch (err) {
      const gap: OvGap = { op, status: 0, code: "transport", message: this.redact(errText(err)) };
      this.report(gap);
      this.observe({
        op,
        outcome: "failed",
        status: 0,
        code: gap.code,
        ms: this.clock() - started,
        message: gap.message,
      });
      return { res: ovFailed(gap.status, gap.code, gap.message), ms: this.clock() - started };
    }
    const ms = this.clock() - started;

    // Every OpenViking answer is a `{status, result, error}` envelope. Anything
    // else — an nginx error page, a bare `null`, a truncated body — is NOT an
    // answer, and a 200 carrying one must not be read as success: that is how
    // a write that never happened gets reported as a write that did.
    let body: {
      status?: unknown;
      result?: unknown;
      error?: { code?: unknown; message?: unknown };
    } | null = null;
    try {
      const parsed: unknown = raw === "" ? {} : JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed;
    } catch {
      body = null;
    }
    if (body === null) {
      if (res.ok) {
        const gap: OvGap = {
          op,
          status: res.status,
          code: "bad_body",
          message: `response was not an OpenViking envelope (${raw.length} bytes)`,
        };
        this.report(gap);
        this.observe({
          op,
          outcome: "failed",
          status: gap.status,
          code: gap.code,
          ms,
          message: gap.message,
        });
        return { res: ovFailed(gap.status, gap.code, gap.message), ms };
      }
      body = {};
    }

    if (!res.ok || body.status === "error") {
      const code = typeof body.error?.code === "string" ? body.error.code : `http_${res.status}`;
      const message = this.redact(
        typeof body.error?.message === "string" ? body.error.message : `HTTP ${res.status}`,
      );
      // The directory lock was held (S2): nothing was checked or
      // written. `request()` retries it — not observed or reported here.
      if (isBusyConflict(res.status, body.error)) {
        return { res: ovFailed(res.status, code, message, true), ms };
      }
      const outcome = ovFailed(res.status, code, message);
      const auth = isAuthFailure(res.status, code, message);
      // A 409 is the precondition working as designed; it is an answer, not a
      // gap, so it is not alerted on.
      if (!outcome.conflict) this.report({ op, status: res.status, code, message });
      this.observe({
        op,
        outcome: outcome.conflict
          ? "conflict"
          : auth
            ? "auth"
            : isNotFound(res.status, code)
              ? "absent"
              : "failed",
        status: res.status,
        code,
        ms,
        message,
      });
      // The key we sent was refused: drop the source's cache so the NEXT
      // request reads the file again — a rotated key must not wait out a TTL
      // behind a 401 (S1). Last, deliberately: `report()` reads the
      // key to redact with, and a read after the drop would re-cache the very
      // key that was just refused for another full TTL.
      if (auth) this.invalidateKey?.();
      return { res: outcome, ms };
    }

    this.observe({ op, outcome: "ok", status: res.status, code: "", ms });
    return { res: { ok: true, status: res.status, result: (body.result ?? body) as T }, ms };
  }

  // ---- content ---------------------------------------------------------------

  /**
   * The ONE write path. There is deliberately no `content/write` wrapper on
   * this class — see the header. `conflict: true` on the outcome means a
   * precondition refused (stale `base_hash`, or `create_if_absent` on a target
   * that already exists), and the stored file is unchanged.
   */
  async batchWrite(
    request: BatchWriteRequest,
    timeoutMs?: number,
  ): Promise<OvOutcome<BatchWriteResult>> {
    const res = await this.request<unknown>("batch_write", "/api/v1/content/batch-write", {
      method: "POST",
      body: request,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
    if (!res.ok) return res;
    // The three URI lists are the only proof a write landed; normalizing them
    // here means the caller checks membership rather than trusting a 200.
    const raw = (res.result && typeof res.result === "object" ? res.result : {}) as Record<
      string,
      unknown
    >;
    return {
      ok: true,
      status: res.status,
      result: {
        root_uri: str(raw["root_uri"]),
        created: strings(raw["created"]),
        updated: strings(raw["updated"]),
        unchanged: strings(raw["unchanged"]),
      },
    };
  }

  /** L2 full content. Safe as a hash source ONLY because every file this
   * system writes was written by batch-write and so carries no `MEMORY_FIELDS`
   * footer for `content/read` to strip. */
  async readContent(uri: string): Promise<OvOutcome<string>> {
    const res = await this.request<unknown>(
      "read",
      `/api/v1/content/read?uri=${encodeURIComponent(uri)}`,
      { method: "GET" },
    );
    if (!res.ok) return res;
    return {
      ok: true,
      status: res.status,
      result: typeof res.result === "string" ? res.result : "",
    };
  }

  async ls(uri: string): Promise<OvOutcome<OvDirEntry[]>> {
    const res = await this.request<unknown>("ls", `/api/v1/fs/ls?uri=${encodeURIComponent(uri)}`, {
      method: "GET",
    });
    if (!res.ok) return res;
    const rows = Array.isArray(res.result) ? res.result : [];
    return {
      ok: true,
      status: res.status,
      result: rows
        .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
        .map((r) => ({
          uri: str(r["uri"]),
          name: str(r["name"]) || basename(str(r["uri"])),
          isDir: r["isDir"] === true,
          size: typeof r["size"] === "number" ? r["size"] : 0,
          modTime: str(r["modTime"]),
        })),
    };
  }

  remove(uri: string, recursive = false): Promise<OvOutcome<unknown>> {
    return this.request<unknown>(
      "delete",
      `/api/v1/fs?uri=${encodeURIComponent(uri)}&recursive=${recursive}`,
      { method: "DELETE" },
    );
  }

  /**
   * The retrieval tag list search's `tags` filter reads. BEST-EFFORT by
   * contract: the tags are already inside the written body (`Tags: #a #b`),
   * which is what `content/read` returns and what the store parses, so a
   * failure here narrows retrieval — it never loses the memory or its tags.
   */
  /**
   * Create a directory (and its parents). A fresh server has ONLY
   * `viking://user/default`, so the first write into `user/<us>/memories/<cat>`
   * 404s on the missing root — nothing else provisions the tree, and making
   * boot order responsible for it would put a network call in front of the
   * daemon. The store calls this lazily, on exactly that failure.
   */
  async mkdir(uri: string, parents = true): Promise<boolean> {
    const res = await this.request<unknown>("mkdir", "/api/v1/fs/mkdir", {
      method: "POST",
      body: { uri, parents },
    });
    // `fs/mkdir` is NOT idempotent: an existing directory comes back CONFLICT
    // ("already exists"), verified live against 0.4.15. Every caller here wants
    // `mkdir -p` semantics — the directory is there afterwards either way — so
    // the conflict is a success, not a failure to report upward.
    return res.ok || res.conflict;
  }

  async setTags(
    uri: string,
    tags: string[],
    mode: "append" | "replace" = "replace",
  ): Promise<boolean> {
    if (tags.length === 0) return true;
    const res = await this.request<unknown>("set_tags", "/api/v1/fs/attrs/set_tags", {
      method: "POST",
      body: { uri, tags, mode },
    });
    return res.ok;
  }

  // ---- search ----------------------------------------------------------------

  /**
   * A budgeted context search. Returns the rendered block AND the usage stats;
   * callers that only want a prompt block take `.rendered`, callers that need
   * to know what the budget bought read `.stats`.
   */
  async searchContext(
    query: string,
    opts: ContextSearchOptions = {},
  ): Promise<OvOutcome<ContextSearchResult>> {
    const body = buildContextSearchBody(query, opts, (gap) => this.report(gap));
    const res = await this.request<unknown>("search", "/api/v1/search/search", {
      method: "POST",
      body,
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    });
    if (!res.ok) return res;
    const result = (res.result && typeof res.result === "object" ? res.result : {}) as Record<
      string,
      unknown
    >;
    const rawEntries = Array.isArray(result["entries"]) ? result["entries"] : [];
    return {
      ok: true,
      status: res.status,
      result: {
        entries: rawEntries
          .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
          .map((e) => ({
            uri: str(e["uri"]),
            category: str(e["category"]) || "memories",
            score: typeof e["score"] === "number" ? e["score"] : 0,
            detail: str(e["detail"]),
            text: str(e["text"]) || str(e["content"]) || str(e["abstract"]),
            origin: str(e["origin"]),
          })),
        rendered: str(result["rendered"]).trim(),
        digest: str(result["digest"]).trim(),
        stats: (result["stats"] && typeof result["stats"] === "object"
          ? result["stats"]
          : {}) as Record<string, unknown>,
      },
    };
  }

  // ---- sessions --------------------------------------------------------------

  /** Create a per-PR session with extraction fully disabled. The policy is not
   * a parameter: a session without it rots (see `DISABLED_MEMORY_POLICY`). */
  createSession(sessionId: string): Promise<OvOutcome<OvSessionResult>> {
    return this.request<OvSessionResult>("session_create", "/api/v1/sessions", {
      method: "POST",
      body: { session_id: sessionId, memory_policy: DISABLED_MEMORY_POLICY },
    });
  }

  /** Removes the session's messages and archives (verified: the tree is gone).
   * Sessions are absent from the search corpus, so this frees disk, not
   * recall. */
  deleteSession(sessionId: string): Promise<OvOutcome<unknown>> {
    return this.request<unknown>(
      "session_delete",
      `/api/v1/sessions/${encodeURIComponent(sessionId)}`,
      { method: "DELETE" },
    );
  }
}

// ---- helpers ----------------------------------------------------------------

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Did this URI actually land? A batch-write that returns 200 without naming
 * the target in any of its three lists did NOT write it, and reporting that as
 * a success is how a memory silently goes missing. */
export function batchWriteLanded(result: BatchWriteResult, uri: string): boolean {
  return (
    result.created.includes(uri) || result.updated.includes(uri) || result.unchanged.includes(uri)
  );
}

function basename(uri: string): string {
  const cleaned = uri.replace(/\/+$/, "");
  const cut = cleaned.lastIndexOf("/");
  return cut >= 0 ? cleaned.slice(cut + 1) : cleaned;
}

function errText(err: unknown): string {
  if (err instanceof Error)
    return err.name === "TimeoutError" || err.name === "AbortError" ? "timeout" : err.message;
  return String(err);
}

/** `AbortSignal.timeout` where the runtime has it; undefined otherwise. Tests
 * inject their own fetch and never see it. */
function timeoutSignal(ms: number): AbortSignal | undefined {
  try {
    return AbortSignal.timeout(ms);
  } catch {
    return undefined;
  }
}

const defaultFetch: HttpFetch = (url, init) => fetch(url, init);

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });

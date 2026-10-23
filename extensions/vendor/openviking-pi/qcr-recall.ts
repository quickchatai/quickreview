// QCR FORK — file added by PATCH 7 (bounded recall, no commit). Not upstream.
// S3, owner ruling R3: "PR sessions keep the OpenViking extension,
// bounded: the per-turn recall wait is capped at 500 ms and query expansion is
// off."
//
// The pure half of three fixes, kept free of pi and of the OV client so
// `tests/openviking-fork.test.ts` can exercise it (`index.ts` cannot be
// imported from a test).
//
// 1. RECALL NEVER HOLDS A TURN PAST ITS BUDGET. The `context` hook awaited
//    the recall search before every provider request, and that search could
//    spend a 15 s expansion fuse and then a `/search/recall` fallback with its
//    own 10 s — on a server whose local embedder blocks its one event loop
//    (search p50 22 s, max 155 s, 2026-10-03..06). `budgetedFetch` gives every
//    request of one recall the time left on ONE deadline and starts nothing
//    once it has passed (it throws, which ends the fallback chain before it
//    sends a request); `raceBudget` is the belt that returns the hook on time
//    whatever the chain is doing.
// 2. A RETIRED ENTRY IS NEVER RECALLED. Retire is a `#retired` header tag and
//    the file stays in the indexed root, so a semantic search finds it. The
//    daemon already knows the retired set (its store sweep) and publishes the
//    URIs to a file beside the sessions' ovcli.conf (`QCR_OV_RETIRED_FILE`);
//    `retiredGuard` sends them as `exclude_uris`, and drops any recalled entry
//    whose own text opens with the tag (the header-only rule of
//    `src/memory/eventtags.ts` `parseHashTags` — a `#retired` quoted further
//    in is prose, not a retirement).
// 3. NOTHING COMMITS.: commit exists to PROMOTE session notes into
//    memories through an extraction model this deployment never configures,
//    so every commit archived the raw notes and produced nothing (143 archives
//    on the VM, 0 overviews). The commit calls are gone from sync/index; a
//    commit queued on disk by an older build is refused here, never replayed.
import { readFileSync } from "node:fs";

/** The longest the `context` hook waits for recall before the turn proceeds
 * without it (R3). A cap: a caller may ask for less, never for more. */
export const RECALL_WAIT_MS = 500;

/** The server's `MAX_EXCLUDE_URIS` (context_assembler/params.py). */
export const MAX_RECALL_EXCLUSIONS = 200;

/** Where the daemon publishes the retired URIs. Not a secret: the URIs of
 * retired entries the session's own key can already list. */
export const RETIRED_FILE_ENV = "QCR_OV_RETIRED_FILE";

/** The seam's retirement tag (src/openviking/store.ts `RETIRED_TAG`). */
export const RETIRED_TAG = "retired";

/** The answer shape of `OVClient.fetchJSON`, loosened so this file does not
 * import the client. */
export interface FetchAnswer {
  ok: boolean;
  status?: number;
  result?: any;
  error?: any;
  traceId?: string;
}

export type FetchLike = (path: string, init?: any, options?: any) => Promise<FetchAnswer>;

/** Thrown by a budgeted fetch once the deadline has passed. It ends the
 * recall chain where it stands — nothing further is sent, and nothing is
 * cached from a request that was never made — and `raceBudget` turns it into
 * "no recall this turn". */
export class RecallBudgetSpent extends Error {
  constructor() {
    super("recall budget spent");
    this.name = "RecallBudgetSpent";
  }
}

/**
 * Every request of one recall shares ONE deadline. A request gets the time
 * left on it as its own timeout (the client aborts it there), and once none is
 * left nothing is started — the `/search/recall` and raw-find fallbacks
 * included, which used to double the load exactly when the server was slow.
 */
export function budgetedFetch(
  inner: FetchLike,
  deadlineAt: number,
  now: () => number = Date.now,
): FetchLike {
  return async (path, init, options) => {
    const remaining = Math.floor(deadlineAt - now());
    if (remaining < 5) throw new RecallBudgetSpent(); // a few ms only race the abort that just fired
    const asked = Number(options?.timeoutMs);
    const timeoutMs = Number.isFinite(asked) && asked > 0 ? Math.min(asked, remaining) : remaining;
    return inner(path, init, { ...(options ?? {}), timeoutMs });
  };
}

/**
 * `work`, or `fallback` once `ms` have passed. Never rejects: a recall that
 * throws is a recall that found nothing. The work is NOT cancelled — under a
 * `budgetedFetch` it has nothing left to send by then — and a late answer is
 * discarded, never injected into a later turn of the same run (that would
 * rewrite a message the provider has already cached).
 */
export async function raceBudget<T>(
  work: Promise<T>,
  ms: number,
  fallback: T,
): Promise<{ value: T; timedOut: boolean }> {
  const settled = work.then(
    (value) => ({ value, timedOut: false }),
    () => ({ value: fallback, timedOut: false }),
  );
  if (!(ms > 0)) return { value: fallback, timedOut: true };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      settled,
      new Promise<{ value: T; timedOut: boolean }>((resolve) => {
        timer = setTimeout(() => resolve({ value: fallback, timedOut: true }), ms);
        (timer as { unref?: () => void }).unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Does this text OPEN with the `#retired` tag? Header-only, exactly like
 * `parseHashTags` (src/memory/eventtags.ts): the leading run of `#tag` tokens
 * is the header and the scan stops at the first word that is not one, so a
 * `[feedback]` entry quoting "mark it #retired" is not hidden by its prose.
 * `tests/openviking-fork.test.ts` pins the two parsers against each other.
 */
export function hasRetiredHeader(text: unknown): boolean {
  for (const token of String(text ?? "").split(/\s+/)) {
    if (token === "") continue;
    if (!token.startsWith("#")) return false;
    if (token.slice(1).toLowerCase() === RETIRED_TAG) return true;
  }
  return false;
}

/**
 * The retired URIs the daemon published (`{"uris": [...]}`), or `[]`.
 * Total: no path, no file, a garbled file — all mean "no exclusions", and the
 * header filter in `retiredGuard` still applies.
 */
export function readRetiredUris(
  path: string | undefined,
  read: (p: string) => string = defaultRead,
): string[] {
  if (!path || path.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(read(path.trim()));
  } catch {
    return [];
  }
  const raw = (parsed as { uris?: unknown })?.uris;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const uri of raw) {
    if (typeof uri !== "string" || !uri.startsWith("viking://") || out.includes(uri)) continue;
    out.push(uri);
    if (out.length >= MAX_RECALL_EXCLUSIONS) break;
  }
  return out;
}

function defaultRead(p: string): string {
  return readFileSync(p, "utf8");
}

/** One assembled entry exactly as the server renders it
 * (`retrieve/context_assembler/render.py` `render_entry`), so a block we had
 * to re-render after dropping a retired entry reads like the server's. */
export function renderContextEntry(entry: {
  uri?: unknown;
  category?: unknown;
  score?: unknown;
  detail?: unknown;
  text?: unknown;
}): string {
  const attr = (v: unknown) =>
    String(v ?? "")
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;");
  const score = Number(entry.score);
  const head =
    `<memory uri="${attr(entry.uri)}" type="${attr(entry.category)}"` +
    ` score="${(Number.isFinite(score) ? score : 0).toFixed(2)}" detail="${String(entry.detail ?? "")}"`;
  const text = String(entry.text ?? "");
  if (text === "") return `${head} />`;
  return `${head}>\n${text.replace(/<(\/?)memory(?=[\s/>])/gi, "<\\$1memory")}\n</memory>`;
}

const CONTEXT_PATHS = new Set(["/api/v1/search/search", "/api/v1/search/recall"]);
const FIND_PATH = "/api/v1/search/find";

/**
 * Retired entries out of every recall request this fetch carries:
 *   * a context search or the `/search/recall` preset is SENT the published
 *     retired URIs as `exclude_uris` (merged with any it already carried,
 *     capped at the server's 200) — list-mode search rejects the field, so
 *     only a `mode: "context"` body gets it;
 *   * whatever comes back is FILTERED: an entry the list names, or whose own
 *     text opens with `#retired`, is dropped, and the rendered block is
 *     rebuilt from what is left (the digest with it — it was written from the
 *     dropped entry too);
 *   * the raw-find fallback's `memories` are filtered the same way.
 */
export function retiredGuard(inner: FetchLike, retired: () => readonly string[]): FetchLike {
  return async (path, init, options) => {
    let excluded: readonly string[] = [];
    try {
      excluded = retired();
    } catch {
      excluded = [];
    }
    const excludedSet = new Set(excluded);
    let sent = init;
    if (CONTEXT_PATHS.has(path) && typeof init?.body === "string" && excluded.length > 0) {
      try {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        if (path !== "/api/v1/search/search" || body["mode"] === "context") {
          const have = Array.isArray(body["exclude_uris"])
            ? (body["exclude_uris"] as unknown[]).filter((u): u is string => typeof u === "string")
            : [];
          body["exclude_uris"] = [...new Set([...have, ...excluded])].slice(0, MAX_RECALL_EXCLUSIONS);
          sent = { ...init, body: JSON.stringify(body) };
        }
      } catch {
        sent = init;
      }
    }
    const res = await inner(path, sent, options);
    if (!res?.ok || !res.result || typeof res.result !== "object") return res;
    const isRetired = (uri: unknown, text: unknown) =>
      (typeof uri === "string" && excludedSet.has(uri)) || hasRetiredHeader(text);
    if (CONTEXT_PATHS.has(path) && Array.isArray(res.result.entries)) {
      const entries = res.result.entries as Array<Record<string, unknown>>;
      const kept = entries.filter((e) => !isRetired(e?.["uri"], e?.["text"] ?? e?.["content"]));
      if (kept.length === entries.length) return res;
      return {
        ...res,
        result: {
          ...res.result,
          entries: kept,
          rendered: kept.map(renderContextEntry).join("\n"),
          digest: "",
        },
      };
    }
    if (path === FIND_PATH && Array.isArray(res.result.memories)) {
      const memories = res.result.memories as Array<Record<string, unknown>>;
      const kept = memories.filter(
        (m) => !isRetired(m?.["uri"], m?.["abstract"] ?? m?.["overview"]),
      );
      if (kept.length === memories.length) return res;
      return { ...res, result: { ...res.result, memories: kept } };
    }
    return res;
  };
}

/** Is this the commit route of a session? */
export function isCommitPath(path: string): boolean {
  return /^\/api\/v1\/sessions\/[^/]+\/commit(?:[?#].*)?$/.test(path);
}

/** What a refused commit answers: a 400 the pending queue treats as final
 * (`retryable.mjs`), so a commit an older build queued is dropped, not
 * retried. */
export const COMMIT_REFUSED: FetchAnswer = Object.freeze({
  ok: false,
  status: 400,
  result: null,
  error: Object.freeze({
    code: "QCR_COMMIT_DISABLED",
    message:
      "session commit is disabled in this fork: it only promotes notes through an " +
      "extraction model this deployment does not run",
  }),
}) as FetchAnswer;

/** A fetch that never sends a session commit. */
export function refuseCommits(inner: FetchLike): FetchLike {
  return async (path, init, options) => {
    if (isCommitPath(path)) return { ...COMMIT_REFUSED };
    return inner(path, init, options);
  };
}

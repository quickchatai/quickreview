// QCR FORK — file added by PATCH 8 (PR-derived recall). Not upstream.
// a PR session's per-prompt recall searches for ITS PR, and only
// where a round may look.
//
// The pure half, kept free of pi and of the OV client so
// `tests/openviking-fork.test.ts` can exercise it (`index.ts` cannot be
// imported from a test).
//
// Upstream recalls with the whole delivered prompt. For a PR session that is
// a 55–80k-character round order, and the local embedder (S4) embeds a query's
// first 128 tokens — the template's fixed header, the same for every PR, so
// every PR recalled the same ops notes and feedback events. The daemon already
// builds a PR-derived query for the round's own context block (the PR title
// plus the areas and file kinds it touches — `roundContextQuery`,
// src/memory/context.ts) and publishes it, with the areas a round may search
// (`experiences/` alone), to a per-session file (`QCR_OV_RECALL_HINT_FILE`).
// The recall here uses that query and stays inside those areas; with no hint
// (the overseer, the companion, a session born before its first round) it
// recalls exactly as before. S3's 500 ms budget is unchanged — the hint
// changes what is asked, never how long it may take.
import { readFileSync } from "node:fs";
import { renderContextEntry, type FetchLike } from "./qcr-recall.js";

/** Where the daemon publishes this session's hint (PR sessions only). */
export const RECALL_HINT_FILE_ENV = "QCR_OV_RECALL_HINT_FILE";

/** The daemon caps its query at 600 characters (`ROUND_CONTEXT_DEFAULTS`);
 * a longer one in the file is cut, not refused. */
export const MAX_HINT_QUERY_CHARS = 600;

/** Items per area when the request names no count of its own. */
export const DEFAULT_AREA_QUOTA = 10;

export interface RecallHint {
  query: string;
  /** Memory areas (`experiences`) — OpenViking quota buckets by name. */
  areas: string[];
}

const AREA_RE = /^[a-z][a-z0-9_-]*$/;

/**
 * The hint the daemon published (`{"query": "...", "areas": ["..."]}`), or
 * null. Total, and fail-closed toward the old behaviour: no path, no file, a
 * garbled file, an empty query or no usable area all mean "no hint" — the
 * recall then uses the prompt, as upstream did.
 */
export function readRecallHint(
  path: string | undefined,
  read: (p: string) => string = defaultRead,
): RecallHint | null {
  if (!path || path.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(read(path.trim()));
  } catch {
    return null;
  }
  const raw = parsed as { query?: unknown; areas?: unknown } | null;
  const query =
    typeof raw?.query === "string"
      ? raw.query.replace(/\s+/g, " ").trim().slice(0, MAX_HINT_QUERY_CHARS)
      : "";
  if (query === "") return null;
  const areas = Array.isArray(raw?.areas)
    ? [...new Set(raw.areas.filter((a): a is string => typeof a === "string" && AREA_RE.test(a)))]
    : [];
  if (areas.length === 0) return null;
  return { query, areas };
}

function defaultRead(p: string): string {
  return readFileSync(p, "utf8");
}

/** Is this URI inside one of the areas? */
export function inAreas(uri: unknown, areas: readonly string[]): boolean {
  return typeof uri === "string" && areas.some((a) => uri.includes(`/memories/${a}/`));
}

const CONTEXT_PATHS = new Set(["/api/v1/search/search", "/api/v1/search/recall"]);
const FIND_PATH = "/api/v1/search/find";

/**
 * Every recall request this fetch carries stays inside `areas`:
 *   * a context search or the `/search/recall` preset is SENT quotas naming
 *     those areas alone (the count is the request's own `limit`, else
 *     `DEFAULT_AREA_QUOTA`) — so the server never fills the block from
 *     events, preferences or the resources/skills blurbs;
 *   * whatever comes back from elsewhere anyway is DROPPED, and the rendered
 *     block is rebuilt from what is left;
 *   * the raw-find fallback keeps only memories inside the areas, and no
 *     resources or skills.
 * `areas()` empty or null = no scoping (the request goes out untouched).
 */
export function scopeGuard(inner: FetchLike, areas: () => readonly string[] | null): FetchLike {
  return async (path, init, options) => {
    let scope: readonly string[] = [];
    try {
      scope = areas() ?? [];
    } catch {
      scope = [];
    }
    if (scope.length === 0) return inner(path, init, options);
    let sent = init;
    if (CONTEXT_PATHS.has(path) && typeof init?.body === "string") {
      try {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        if (path !== "/api/v1/search/search" || body["mode"] === "context") {
          const n = Math.max(1, Math.floor(Number(body["limit"]) || DEFAULT_AREA_QUOTA));
          body["quotas"] = Object.fromEntries(scope.map((a) => [a, n]));
          sent = { ...init, body: JSON.stringify(body) };
        }
      } catch {
        sent = init;
      }
    }
    const res = await inner(path, sent, options);
    if (!res?.ok || !res.result || typeof res.result !== "object") return res;
    if (CONTEXT_PATHS.has(path) && Array.isArray(res.result.entries)) {
      const entries = res.result.entries as Array<Record<string, unknown>>;
      const kept = entries.filter((e) => inAreas(e?.["uri"], scope));
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
    if (path === FIND_PATH) {
      const memories = Array.isArray(res.result.memories)
        ? (res.result.memories as Array<Record<string, unknown>>).filter((m) =>
            inAreas(m?.["uri"], scope),
          )
        : res.result.memories;
      return { ...res, result: { ...res.result, memories, resources: [], skills: [] } };
    }
    return res;
  };
}

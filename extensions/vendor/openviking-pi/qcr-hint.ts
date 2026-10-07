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
//
// [QCR PATCH 9] (S7) The same areas bound the session's memory
// TOOLS: in a PR session `viking_search` keeps only hits inside them and
// `viking_read` / `viking_browse` refuse a memory URI outside them. Cases
// (`finding-cases/`, the daemon's finding cases — human replies quoted as data) and
// feedback events are the learner's context, not a round's, until S9.
//
// [QCR PATCH 11] (integration review) Three holes in that boundary:
//   * the RECALL failed OPEN: a PR session whose hint was not written yet (a
//     recheck or ping-pong wake before its next full round — every live PR
//     right after the deploy) recalled across the whole tree, cases and
//     feedback events included. It now fails CLOSED, as the tools always did
//     (`recallScope`);
//   * a scoped SEARCH asked the server for a global top-K and filtered after:
//     with ~1,800 cases beside ~180 curated entries, the top 10 was mostly
//     cases and the session's search said "No results found." Both the tool
//     and the recall's raw-find fallback now name the areas as the server's
//     `target_uri` list (`scopedFindTargets`, `scopeGuard`);
//   * a PR session could WRITE a lesson or a pinned entry from its own
//     conclusions while reading untrusted PR text: `viking_write` now refuses
//     `experiences/`, `preferences/` (the pinned head included) and
//     `finding-cases/` in a scoped session (`scopedWriteRefusal`).
import { readFileSync } from "node:fs";
import { renderContextEntry, type FetchLike } from "./qcr-recall.js";

/** Where the daemon publishes this session's hint (PR sessions only). */
export const RECALL_HINT_FILE_ENV = "QCR_OV_RECALL_HINT_FILE";

/** [QCR PATCH 11] What one recall asks and where: the hint's query and
 * areas when the daemon published one; for a PR session (the hint variable
 * set) whose hint cannot be read, the prompt INSIDE the round's areas — never
 * the whole tree; for any other session (no variable: the overseer, the
 * companion) the prompt, unscoped, as upstream. Total. */
export function recallScope(
  path: string | undefined,
  prompt: string,
  read: (p: string) => string = defaultRead,
): { query: string; areas: readonly string[] | null } {
  const hint = readRecallHint(path, read);
  if (hint) return { query: hint.query, areas: hint.areas };
  if (!path || path.trim() === "") return { query: prompt, areas: null };
  return { query: prompt, areas: toolScopeAreas(path, read) ?? DEFAULT_ROUND_AREAS };
}

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
    // [QCR PATCH 11] The raw-find fallback names its target: a memories ROOT
    // becomes the areas inside it (one request, a `target_uri` list — the
    // server ranks inside them, so cases can never crowd a lesson out of the
    // top K), and the skills source is not asked at all.
    if (path === FIND_PATH && typeof init?.body === "string") {
      try {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        const target = typeof body["target_uri"] === "string" ? body["target_uri"] : "";
        if (target !== "" && memoryAreaOf(target) === null)
          return { ok: true, status: 200, result: { memories: [], resources: [], skills: [] } };
        if (target === "" || memoryAreaOf(target) === "") {
          body["target_uri"] = scopedFindTargets(scope, target === "" ? undefined : target);
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

// ---- [QCR PATCH 9] the memory TOOLS of a PR session --------------------------

/** The areas a PR session's tools are held to when its hint cannot be read
 * (a session born before its first round): the round's own areas — the
 * daemon's `ROUND_SEARCH_AREAS` (src/memory/layout.ts), pinned equal by test. */
export const DEFAULT_ROUND_AREAS: readonly string[] = ["experiences"];

/**
 * The memory areas this session's TOOLS may reach, or null for no scoping.
 * The hint variable is set on a PR session only (src/memory/ovsession.ts); a
 * session without it — the overseer, the companion — is unscoped, as
 * upstream. Unlike the recall, a PR session whose hint cannot be read FAILS
 * CLOSED to the round's areas: a recall without a hint merely asks a worse
 * question, while a tool reaching a case is exactly what is being prevented.
 * Total: never throws.
 */
export function toolScopeAreas(
  path: string | undefined,
  read: (p: string) => string = defaultRead,
): readonly string[] | null {
  if (!path || path.trim() === "") return null;
  try {
    const raw = JSON.parse(read(path.trim())) as { areas?: unknown } | null;
    const areas = Array.isArray(raw?.areas)
      ? [...new Set(raw.areas.filter((a): a is string => typeof a === "string" && AREA_RE.test(a)))]
      : [];
    if (areas.length > 0) return areas;
  } catch {
    // the round's areas, below
  }
  return DEFAULT_ROUND_AREAS;
}

/** The memory area a viking:// URI addresses — `experiences` for
 * `viking://user/reviewer/memories/experiences/x.md`, "" for the memories
 * root itself — or null for a URI outside memories. */
export function memoryAreaOf(uri: string): string | null {
  const i = uri.indexOf("/memories");
  if (i < 0) return null;
  const rest = uri.slice(i + "/memories".length);
  if (rest !== "" && !rest.startsWith("/")) return null;
  return rest.replace(/^\/+/, "").split(/[/?#]/)[0] ?? "";
}

/** A `.`/`..` path segment, or an encoded dot — never resolved, never let by. */
const DOT_SEGMENT = /(^|\/)\.\.?(\/|$)|%2e/i;

/** May a scoped session READ this URI, or see it as a search hit? Only
 * inside one of its areas. */
export function readableInScope(uri: unknown, areas: readonly string[]): boolean {
  if (typeof uri !== "string" || DOT_SEGMENT.test(uri)) return false;
  const area = memoryAreaOf(uri);
  return area !== null && area !== "" && areas.includes(area);
}

/** May a scoped session LIST (or scope a search to) this URI? Inside one of
 * its areas, the memories root (which names the areas, nothing in them), or
 * a URI outside memories altogether. */
export function browsableInScope(uri: unknown, areas: readonly string[]): boolean {
  if (typeof uri !== "string" || DOT_SEGMENT.test(uri)) return false;
  const area = memoryAreaOf(uri);
  return area === null || area === "" || areas.includes(area);
}

/** [QCR PATCH 11] Where a scoped session's search is sent: the model's own
 * scope when it lies inside one of the areas, else every area under the
 * memories root it named (or the user's own, `viking://user/memories`) — a
 * `target_uri` list, so the server ranks INSIDE the areas rather than across
 * the whole tree with the rest filtered away afterwards. */
export function scopedFindTargets(areas: readonly string[], scope?: string): string[] {
  if (typeof scope === "string" && readableInScope(scope, areas)) return [scope];
  let root = "viking://user/memories";
  if (typeof scope === "string" && memoryAreaOf(scope) === "" && !DOT_SEGMENT.test(scope))
    root = scope.replace(/\/+$/, "");
  return areas.map((a) => `${root}/${a}`);
}

/** [QCR PATCH 11] The memory areas a scoped (PR) session may never write:
 * curated lessons and the owner's words — both reach every round — and the
 * daemon's own finding cases. A review session reads untrusted PR text; what
 * it concludes is not a lesson until a person's outcome makes it one. */
export const SCOPED_WRITE_REFUSED_AREAS: readonly string[] = [
  "experiences",
  "preferences",
  "finding-cases",
];

/** The refusal for a scoped session's write into a protected area, or null. */
export function scopedWriteRefusal(uris: readonly string[]): string | null {
  const hit = uris.find((u) => {
    const area = memoryAreaOf(u);
    return area !== null && SCOPED_WRITE_REFUSED_AREAS.includes(area);
  });
  if (hit === undefined) return null;
  return (
    `Refusing to write ${hit}: a review session does not write ${SCOPED_WRITE_REFUSED_AREAS.map((a) => `${a}/`).join(", ")} — ` +
    "lessons are curated from people's outcomes at the end of the day, the pinned instructions are the owner's, and cases are the daemon's. Nothing was written."
  );
}

/** The sentence a refused tool call answers with. */
export function scopeRefusal(uri: string, areas: readonly string[]): string {
  return (
    `${uri} is outside this review session's memory (${areas.map((a) => `${a}/`).join(", ")}). ` +
    "A review round reads curated lessons only; finding cases and feedback events are not its to read."
  );
}

/** One line for the system prompt of a scoped session. */
export function toolScopeNote(areas: readonly string[]): string {
  return `In this review session the memory tools reach ${areas.map((a) => `${a}/`).join(", ")} only.`;
}

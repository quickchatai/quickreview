// `LessonEngine` over OpenViking (S9a): the round's lesson prefetch
// (src/lessonselect.ts) asks the server through this, and through nothing
// else.
//
// Each find is ONE `POST /api/v1/search/find` with `target_uri` set to the
// area — `memories/experiences` for a plan row, `memories/finding-cases` for
// the main session — so the server ranks INSIDE the area instead of across
// the tree (vendored patch 0011 sends a session's scoped search the same
// way). No `session_id` rides the body, so the server runs no query
// expansion, and the route has no rewrite stage: the selection is a pure
// function of the round order and the store, like every other read on the
// round path. The retired list is the store's last completed sweep — it
// never waits for a sweep inside the round's budget once one has completed.
//
// ITS OWN CLIENT (`lessonFindClient`). The prefetch's finds run under the
// round's hard budget (≤ 2 s) where every other memory read gets the client's
// 10 s — so on a server that is merely slow (the one-thread embedder busy
// with case writes) they are aborted at the deadline by design. Those aborts
// are the shadow ledger's business (recorded on the round, logged once by the
// selector), never the memory-health monitor's: through the daemon's shared
// client each one would be a `failed`/`transport` request in the health window
// and a counted `openviking_gap`, and a few rounds of them would read memory
// DEGRADED — pausing the case writer, the feedback pump and the learner over
// a probe that must change nothing live. So the lesson engine gets a client
// with NO request observer and NO gap sink; the same key source (a 401 still
// drops its cache), the same server, the daemon's log for a refusal.
//
// Total, like the client under it: a refused or dead server is
// `{ ok: false, reason }`, never a throw.
import type { FindHit, LessonEngine } from "../memory/selection.js";
import { OpenVikingClient, type OpenVikingClientOptions } from "./client.js";
import type { OpenVikingStore } from "./store.js";

/** The options a lesson client may be built with — everything but the two
 * observers the daemon's shared client carries. */
export type LessonFindClientOptions = Omit<OpenVikingClientOptions, "onGap" | "onRequest">;

/**
 * The lesson prefetch's OWN client: no `onRequest` (the memory-health
 * window), no `onGap` (the counted `openviking_gap`). A shadow find aborted at
 * the round's budget therefore never reads as memory failing.
 */
export function lessonFindClient(opts: LessonFindClientOptions): OpenVikingClient {
  // Copied without the two observers, so an options object that happens to
  // carry one (a spread of the shared client's) still cannot pass it on.
  const rest: OpenVikingClientOptions = { ...(opts as OpenVikingClientOptions) };
  delete rest.onGap;
  delete rest.onRequest;
  return new OpenVikingClient(rest);
}

export function openVikingLessonEngine(
  client: Pick<OpenVikingClient, "find" | "memoriesRoot">,
  store: Pick<OpenVikingStore, "retiredUris">,
): LessonEngine {
  return {
    root: () => client.memoriesRoot(),
    async find(area, query, opts) {
      try {
        const res = await client.find(query, {
          targetUri: `${client.memoriesRoot()}/${area}`,
          limit: opts.limit,
          timeoutMs: opts.timeoutMs,
        });
        if (!res.ok) return { ok: false, reason: `find ${res.code}: ${res.message}` };
        const hits: FindHit[] = res.result.map((h) => ({
          uri: h.uri,
          score: h.score,
          text: h.text,
        }));
        return { ok: true, hits };
      } catch (err) {
        return { ok: false, reason: String(err) };
      }
    },
    // A failure rejects: the prefetch then records that the list did not
    // arrive (the entries' own `#retired`/`#moved` headers still exclude).
    retiredUris: () => store.retiredUris(),
  };
}

#!/usr/bin/env node
// Post-deploy search check: one authenticated search against the memory server,
// from where the daemon would make it.
//
//   docker exec quickreview-sandbox node /opt/quickreview/sandbox/scripts/memory-search-check.mjs \
//     --base http://quickreview-memory:1933 --key-file /opt/quickreview/secrets/openviking_reviewer_key
//
// It proves the whole chain a round depends on and `/health` alone does not:
// the container network resolves the sidecar's name, the server answers, the
// REVIEWER key authenticates, and the vector search runs (an empty store
// answers 200 with no hits - that is a pass; a refused key, a down server or
// an embedder that cannot embed is not). Read-only: a search writes nothing.
// scripts/deploy.sh runs it after every deploy that moved memory to the sidecar.
//
// Zero dependencies (it runs in the daemon container with no repo build).
// Exit 0 pass, 1 fail; the key is never printed.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** The request the check sends: the client's `POST /api/v1/search/find` body
 * (src/openviking/client.ts buildFindBody) over the reviewer's own tree. */
export function searchRequest(base, key, uri = "viking://user/reviewer/") {
  return {
    url: `${base.replace(/\/+$/, "")}/api/v1/search/find`,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ query: "post-deploy search check", target_uri: uri, limit: 1 }),
    },
  };
}

/** What a response means. Pure, so the test pins each verdict. */
export function verdict(status, bodyText) {
  if (status === 401 || status === 403) {
    return { ok: false, detail: `the reviewer key was refused (HTTP ${status})` };
  }
  if (status !== 200) {
    return { ok: false, detail: `the search answered HTTP ${status}` };
  }
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return { ok: false, detail: "the search answered 200 with a body that is not JSON" };
  }
  const result = body && typeof body === "object" ? body.result : undefined;
  const memories = result && typeof result === "object" ? result.memories : undefined;
  if (!Array.isArray(memories)) {
    return { ok: false, detail: "the search answered 200 without a result.memories list" };
  }
  return { ok: true, detail: `${memories.length} hit(s)` };
}

export async function run(argv, fetchFn = fetch, read = (p) => readFileSync(p, "utf8")) {
  const flags = new Map();
  for (let i = 0; i < argv.length; i += 2)
    flags.set(String(argv[i]).replace(/^--/, ""), argv[i + 1]);
  const base = flags.get("base");
  const keyFile = flags.get("key-file");
  if (!base || !keyFile) {
    console.error(
      "usage: memory-search-check.mjs --base <url> --key-file <path> [--uri <viking://…>]",
    );
    return 2;
  }
  let key;
  try {
    key = read(keyFile).trim();
  } catch (err) {
    console.error(`memory search check FAILED: cannot read ${keyFile}: ${err.message}`);
    return 1;
  }
  if (key === "") {
    console.error(`memory search check FAILED: ${keyFile} is empty`);
    return 1;
  }
  const { url, init } = searchRequest(base, key, flags.get("uri"));
  try {
    const res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(20_000) });
    const v = verdict(res.status, await res.text());
    if (!v.ok) {
      console.error(`memory search check FAILED against ${base}: ${v.detail}`);
      return 1;
    }
    console.log(`memory search ok against ${base}: ${v.detail}`);
    return 0;
  } catch (err) {
    console.error(
      `memory search check FAILED against ${base}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await run(process.argv.slice(2)));
}

// the OpenViking memory engine: the HTTP client, the `MemoryStore`
// over it, and the round path's `ContextAssembler`.
//
// Two things are pinned here, and they are the reasons the phase is safe:
//
//   1. THE WRITE PATH IS `content/batch-write` AND NOTHING ELSE, carrying
//      `create_if_absent` on a create and `replace_if_hash` on an edit. Bare
//      `content/write` appends a `MEMORY_FIELDS` footer that `content/read`
//      strips, which makes every subsequent preconditioned write 409 forever.
//      A test asserts no request ever reaches that endpoint — the footgun is
//      a path that must not exist, so absence is what gets checked.
//   2. A DEAD SERVER CANNOT MAKE A CALLER THROW. Every public method of every
//      class here is driven against a fetch that rejects, one that throws
//      synchronously, one that 500s with HTML and one that 200s with garbage,
//      and each call must RESOLVE. Memory is a soft dependency; the whole
//      phase rests on it never being able to block or break a review round.
//
// No network and no server: a small in-memory OpenViking implements the
// handful of endpoints the client speaks, including the real precondition
// semantics (409 CONFLICT, file verifiably unchanged), so the round trip
// "write → read back → find by search → edit under a stale hash" is exercised
// end to end.
import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DISABLED_MEMORY_POLICY,
  OpenVikingClient,
  buildContextSearchBody,
  keyFromFile,
  type HttpFetch,
} from "../src/openviking/client.js";
import { OpenVikingContextAssembler } from "../src/openviking/context.js";
import { OpenVikingStore, renderEntryBody, sha256Prefixed, tsFromName, validEntryId, withTag, withoutTag } from "../src/openviking/store.js";
import { refOf } from "../src/memory/store.js";
import type { ContextAssembler } from "../src/memory/context.js";

const KEY = "cWNy.cmV2aWV3ZXI.a2V5LWZvci10ZXN0cy1vbmx5LW5vdC1hLXJlYWwta2V5";
const BASE = "http://127.0.0.1:1933";
const ROOT = "viking://user/reviewer/memories";
const NOW = new Date("2026-08-20T15:30:00.000Z");

// ---- the in-memory server ---------------------------------------------------

interface Recorded {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

class FakeOpenViking {
  files = new Map<string, string>();
  tags = new Map<string, string[]>();
  sessions = new Map<string, unknown>();
  calls: Recorded[] = [];
  /** Set to make the NEXT batch-write 409 whatever its precondition says —
   * the "another writer got there between our read and our write" race. */
  raceNextWrite = false;

  readonly fetch: HttpFetch = async (url, init) => {
    const u = new URL(url);
    const path = u.pathname;
    const body: unknown = init.body === undefined ? undefined : JSON.parse(init.body);
    this.calls.push({ method: init.method, path, headers: init.headers, body });
    if (!(init.headers["Authorization"] ?? "").startsWith("Bearer ")) return json(401, { status: "error", result: null, error: { code: "UNAUTHENTICATED", message: "no key" } });

    if (path === "/api/v1/content/batch-write") return this.batchWrite(body as BatchBody);
    if (path === "/api/v1/content/read") return this.read(u.searchParams.get("uri") ?? "");
    if (path === "/api/v1/fs/ls") return this.ls(u.searchParams.get("uri") ?? "");
    if (path === "/api/v1/fs" && init.method === "DELETE") {
      this.files.delete(u.searchParams.get("uri") ?? "");
      return json(200, { status: "ok", result: {} });
    }
    if (path === "/api/v1/fs/attrs/set_tags") {
      const req = body as { uri: string; tags: string[] };
      this.tags.set(req.uri, req.tags);
      return json(200, { status: "ok", result: {} });
    }
    if (path === "/api/v1/search/search") return this.search(body as { query: string });
    if (path === "/api/v1/sessions" && init.method === "POST") {
      const req = body as { session_id: string; memory_policy?: unknown };
      this.sessions.set(req.session_id, req.memory_policy);
      return json(200, { status: "ok", result: { session_id: req.session_id, uri: `viking://user/reviewer/sessions/${req.session_id}` } });
    }
    if (path.startsWith("/api/v1/sessions/") && init.method === "DELETE") {
      const id = decodeURIComponent(path.slice("/api/v1/sessions/".length));
      if (!this.sessions.delete(id)) return json(404, { status: "error", result: null, error: { code: "NOT_FOUND", message: "no such session" } });
      return json(200, { status: "ok", result: { session_id: id } });
    }
    return json(404, { status: "error", result: null, error: { code: "NOT_FOUND", message: `no route ${path}` } });
  };

  private batchWrite(req: BatchBody): Promise<HttpResponseLike> {
    if (this.raceNextWrite) {
      this.raceNextWrite = false;
      return json(409, { status: "error", result: null, error: { code: "CONFLICT", message: "Batch write replace precondition failed; content hash changed." } });
    }
    // Preconditions are checked for the WHOLE batch before anything lands —
    // the server leaves the tree untouched on a 409, which is what makes a
    // conflict safe to retry.
    for (const op of req.operations) {
      const existing = this.files.get(op.uri);
      if (op.precondition.kind === "create_if_absent" && existing !== undefined) {
        return json(409, { status: "error", result: null, error: { code: "CONFLICT", message: "Batch write create precondition failed; target already exists." } });
      }
      if (op.precondition.kind === "replace_if_hash") {
        if (existing === undefined) return json(404, { status: "error", result: null, error: { code: "NOT_FOUND", message: "no such file" } });
        if (sha256Prefixed(existing) !== op.precondition.base_hash) {
          return json(409, { status: "error", result: null, error: { code: "CONFLICT", message: "Batch write replace precondition failed; content hash changed." } });
        }
      }
    }
    const created: string[] = [];
    const updated: string[] = [];
    for (const op of req.operations) {
      (this.files.has(op.uri) ? updated : created).push(op.uri);
      this.files.set(op.uri, op.content);
    }
    return json(200, { status: "ok", result: { root_uri: req.root_uri, created, updated, unchanged: [] } });
  }

  private read(uri: string): Promise<HttpResponseLike> {
    const content = this.files.get(uri);
    if (content === undefined) return json(404, { status: "error", result: null, error: { code: "NOT_FOUND", message: uri } });
    return json(200, { status: "ok", result: content });
  }

  private ls(uri: string): Promise<HttpResponseLike> {
    const prefix = `${uri.replace(/\/+$/, "")}/`;
    const dirs = new Set<string>();
    const rows: Array<Record<string, unknown>> = [];
    for (const key of this.files.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const cut = rest.indexOf("/");
      if (cut < 0) rows.push({ uri: key, name: rest, isDir: false, size: 1, modTime: "2026-08-20T15:30:00.000Z" });
      else dirs.add(rest.slice(0, cut));
    }
    for (const dir of dirs) rows.push({ uri: `${prefix}${dir}`, name: dir, isDir: true, size: 0, modTime: "2026-08-20T15:30:00.000Z" });
    return json(200, { status: "ok", result: rows });
  }

  /** Enough of `mode: "context"` to prove the plumbing: substring relevance,
   * a rendered block and usage stats. */
  private search(req: { query: string }): Promise<HttpResponseLike> {
    const q = req.query.toLowerCase();
    const entries = [...this.files.entries()]
      .filter(([, text]) => q !== "" && text.toLowerCase().includes(q))
      .map(([uri, text]) => ({ uri, category: "experiences", score: 0.7, detail: "full", text, origin: "self" }));
    const rendered = entries.map((e) => `<memory uri="${e.uri}" type="${e.category}" score="0.70" detail="full">\n${e.text}\n</memory>`).join("\n");
    return json(200, { status: "ok", result: { entries, rendered, digest: "", stats: { used_tokens: rendered.length, candidates: entries.length } } });
  }
}

interface BatchBody {
  root_uri: string;
  operations: Array<{ uri: string; content: string; precondition: { kind: string; base_hash?: string } }>;
  wait: boolean;
}

interface HttpResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

function json(status: number, body: unknown): Promise<HttpResponseLike> {
  const raw = JSON.stringify(body);
  return Promise.resolve({ ok: status >= 200 && status < 300, status, text: () => Promise.resolve(raw) });
}

function wire(server: FakeOpenViking, log: string[] = []): { client: OpenVikingClient; store: OpenVikingStore; assembler: OpenVikingContextAssembler; log: string[] } {
  const client = new OpenVikingClient({ baseUrl: BASE, apiKey: KEY, user: "reviewer", fetchFn: server.fetch, log: (m) => log.push(m) });
  const store = new OpenVikingStore({ client, now: () => NOW, cacheTtlMs: 0, log: (m) => log.push(m) });
  const assembler = new OpenVikingContextAssembler({ client, store, log: (m) => log.push(m) });
  return { client, store, assembler, log };
}

// ---- the round trip ---------------------------------------------------------

describe("OpenVikingStore round trip", () => {
  let server: FakeOpenViking;

  beforeEach(() => {
    server = new FakeOpenViking();
  });

  it("writes an entry, reads it back, finds it by search, and refuses a stale edit", async () => {
    const { store } = wire(server);

    const written = await store.apply({ op: "note", text: "#feedback kind=feedback pr=5314 day=2026-08-20 migration renumber posts as a comment, never a blocker" });
    expect(written.ok).toBe(true);

    const entries = await store.read();
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.text).toContain("migration renumber posts as a comment");
    expect(entry.tags).toContain("feedback");
    expect(entry.ts).toBe("2026-08-20 15:30:00");
    expect(entry.day).toBe("2026-08-20");
    expect(entry.block).toBe(0);
    expect(entry.hash).toMatch(/^sha256:[0-9a-f]{64}$/);

    const hits = await store.search("renumber");
    expect(hits.map((h) => h.id)).toEqual([entry.id]);
    expect(await store.search("nothing-matches-this")).toEqual([]);

    // Somebody else edits the entry after we listed it…
    const uri = store.uriOf(entry.id);
    server.files.set(uri, "#feedback someone else got here first\n");

    const stale = await store.apply({ op: "edit", text: "rewritten under a stale view", ...refOf(entry) });
    expect(stale.ok).toBe(false);
    expect(stale.message).toMatch(/changed since you read it/);
    // …and the refusal left the file exactly as the other writer left it.
    expect(server.files.get(uri)).toBe("#feedback someone else got here first\n");

    // Re-read, retry, land.
    const fresh = (await store.read())[0]!;
    const applied = await store.apply({ op: "edit", text: "#feedback rewritten from a fresh view", ...refOf(fresh) });
    expect(applied.ok).toBe(true);
    expect((await store.read())[0]!.text).toBe("#feedback rewritten from a fresh view");
  });

  it("uses content/batch-write exclusively, with create_if_absent then replace_if_hash", async () => {
    const { store } = wire(server);
    await store.apply({ op: "note", text: "#feedback first" });
    const entry = (await store.read())[0]!;
    await store.apply({ op: "edit", text: "#feedback second", ...refOf(entry) });

    const writes = server.calls.filter((c) => c.method === "POST" && c.path.includes("/content/"));
    expect(writes.map((c) => c.path)).toEqual(["/api/v1/content/batch-write", "/api/v1/content/batch-write"]);
    // The footgun endpoint must be unreachable, not merely unused.
    expect(server.calls.some((c) => c.path === "/api/v1/content/write")).toBe(false);

    const first = writes[0]!.body as BatchBody;
    expect(first.operations[0]!.precondition).toEqual({ kind: "create_if_absent" });
    expect(first.wait).toBe(false); // never block a caller on the index refresh
    const second = writes[1]!.body as BatchBody;
    expect(second.operations[0]!.precondition).toEqual({ kind: "replace_if_hash", base_hash: entry.hash });
  });

  it("surfaces a server-side 409 as a clean refusal, not an exception", async () => {
    const { store } = wire(server);
    await store.apply({ op: "note", text: "#feedback racy" });
    const entry = (await store.read())[0]!;
    // A writer lands between our precondition read and our write — the server
    // is the authority, and its 409 is an ordinary answer.
    server.raceNextWrite = true;
    const res = await store.apply({ op: "edit", text: "#feedback mine", ...refOf(entry) });
    expect(res).toEqual({ ok: false, message: "refused: the entry changed since you read it — re-read it and retry" });
  });

  it("retries a create under a fresh name when the target already exists", async () => {
    const { store } = wire(server);
    await store.apply({ op: "note", text: "#feedback same second" });
    const first = (await store.read())[0]!;
    // Same text, same second, same derived name: the second create MUST NOT
    // overwrite the first — it 409s and retries under another suffix.
    const second = await store.apply({ op: "note", text: "#feedback same second" });
    expect(second.ok).toBe(true);
    const entries = await store.read();
    expect(entries).toHaveLength(2);
    expect(new Set(entries.map((e) => e.id)).size).toBe(2);
    expect(entries.some((e) => e.id === first.id)).toBe(true);
  });

  it("tags `add` as hand-written and stores `note` verbatim", async () => {
    const { store } = wire(server);
    await store.apply({ op: "add", text: "always check the merge base first" });
    await store.apply({ op: "note", text: "#feedback machine-authored" });
    const texts = (await store.read()).map((e) => e.text);
    expect(texts).toContain("#manual always check the merge base first");
    expect(texts).toContain("#feedback machine-authored");
  });

  it("pins, unpins and retires by tag — and a retired entry leaves the timeline", async () => {
    const { store } = wire(server);
    await store.apply({ op: "note", text: "#repo-gotcha guard 2 can suppress a same-head review" });

    let entry = (await store.read())[0]!;
    expect((await store.apply({ op: "pin", ...refOf(entry) })).ok).toBe(true);
    entry = (await store.read())[0]!;
    expect(entry.pinned).toBe(true);
    expect(entry.text.startsWith("#pinned ")).toBe(true);

    expect((await store.apply({ op: "unpin", ...refOf(entry) })).ok).toBe(true);
    entry = (await store.read())[0]!;
    expect(entry.pinned).toBe(false);
    expect(entry.text).toBe("#repo-gotcha guard 2 can suppress a same-head review");

    expect((await store.apply({ op: "retire", ...refOf(entry) })).ok).toBe(true);
    expect(await store.read()).toEqual([]);
    // Retire is a tag, not a delete: the bytes are still there to audit.
    expect([...server.files.values()][0]).toContain("#retired");
  });

  it("refuses an address it cannot spell rather than building a URI from it", async () => {
    const { store } = wire(server);
    for (const id of ["../../etc/passwd", "a/b/c.md", "no-extension", "has space.md"]) {
      const res = await store.apply({ op: "edit", text: "x", id, ts: "2026-08-20 15:30:00", block: 0, expect: `sha256:${"0".repeat(64)}` });
      expect(res.ok).toBe(false);
      expect(res.message).toMatch(/not a memory address/);
    }
    expect(server.calls.some((c) => c.path.includes("batch-write"))).toBe(false);
  });

  it("mirrors the k=v event tags onto the native retrieval tag list", async () => {
    const { store } = wire(server);
    await store.apply({ op: "note", text: '#feedback kind=feedback pr=5314 day=2026-08-20 signal=feedback_comment human said "kind=bug" in the quoted body' });
    const tags = [...server.tags.values()][0]!;
    expect(tags).toEqual(["kind=feedback", "pr=5314", "day=2026-08-20", "signal=feedback_comment"]);
    // The quoted `kind=bug` sits past the header and must not have won.
    expect(tags).not.toContain("kind=bug");
  });
});

// ---- the search call --------------------------------------------------------

describe("context search", () => {
  it("pins the determinism knobs off — the daemon has no LLM in its hot path", () => {
    const body = buildContextSearchBody("migration collision", { maxTokens: 2000 });
    expect(body["mode"]).toBe("context");
    // `false`, NOT the string "off": the server types this `bool | "auto"` and
    // a string it cannot parse is a 422, i.e. a silent memory outage.
    expect(body["rewrite"]).toBe(false);
    expect(body["query_expansion"]).toBe("off");
    expect(body["max_tokens"]).toBe(2000);
  });

  it("carries the token budget, per-category quotas and tag/date filters", () => {
    const body = buildContextSearchBody("q", {
      maxTokens: 1200,
      quotas: { experiences: 4, events: 2 },
      tags: ["#Feedback", "kind=bug", "feedback"],
      since: "2026-08-01T00:00:00Z",
      until: "2026-08-20T00:00:00Z",
      timeField: "created_at",
      limit: 12,
      scoreThreshold: 0.4,
      purpose: "coding",
      excludeUris: ["viking://user/reviewer/memories/experiences/a.md"],
    });
    expect(body["quotas"]).toEqual({ experiences: 4, events: 2 });
    expect(body["tags"]).toEqual(["feedback", "kind=bug"]);
    expect(body["since"]).toBe("2026-08-01T00:00:00Z");
    expect(body["until"]).toBe("2026-08-20T00:00:00Z");
    expect(body["time_field"]).toBe("created_at");
    expect(body["limit"]).toBe(12);
    expect(body["score_threshold"]).toBe(0.4);
    expect(body["purpose"]).toBe("coding");
    expect(body["exclude_uris"]).toHaveLength(1);
  });

  it("clamps the token budget into the server's accepted range", () => {
    expect(buildContextSearchBody("q", { maxTokens: 1 })["max_tokens"]).toBe(64);
    expect(buildContextSearchBody("q", { maxTokens: 99_999 })["max_tokens"]).toBe(32000);
  });

  it("drops an unknown quota bucket rather than 422-ing the whole request", () => {
    const gaps: string[] = [];
    const body = buildContextSearchBody("q", { quotas: { experiences: 3, nonsense: 9 } }, (g) => gaps.push(g.message));
    expect(body["quotas"]).toEqual({ experiences: 3 });
    expect(gaps.join(" ")).toMatch(/nonsense/);
  });

  it("exposes the rendered block AND the usage stats", async () => {
    const server = new FakeOpenViking();
    const { client, store, assembler } = wire(server);
    await store.apply({ op: "note", text: "#feedback migration renumber collision at the base sha" });

    const res = await client.searchContext("renumber", { maxTokens: 800 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.rendered).toContain("migration renumber collision");
    expect(res.result.entries).toHaveLength(1);
    expect(res.result.stats["candidates"]).toBe(1);

    const block = await assembler.contextBlock("renumber", { maxTokens: 800 });
    expect(block).toContain("migration renumber collision");
    expect(assembler.lastSearch?.stats["used_tokens"]).toBeGreaterThan(0);
  });
});

// ---- sessions ---------------------------------------------------------------

describe("sessions", () => {
  it("creates with memory extraction fully disabled, and deletes", async () => {
    const server = new FakeOpenViking();
    const { client } = wire(server);

    const created = await client.createSession("pr-5314");
    expect(created.ok).toBe(true);
    // Without this policy every commit queues an extraction task that FAILS —
    // our deployment configures no vlm on purpose.
    expect(server.sessions.get("pr-5314")).toEqual({
      self: { enabled: false },
      peer: { enabled: false },
      working_memory: { enabled: false },
    });
    expect(DISABLED_MEMORY_POLICY).toEqual(server.sessions.get("pr-5314"));

    expect((await client.deleteSession("pr-5314")).ok).toBe(true);
    expect(server.sessions.has("pr-5314")).toBe(false);
    // Deleting one that is gone is an answer, not a throw.
    expect((await client.deleteSession("pr-5314")).ok).toBe(false);
  });
});

// ---- the reviewer key -------------------------------------------------------

describe("the reviewer USER key", () => {
  it("rides every request as a bearer token and never reaches the log", async () => {
    const server = new FakeOpenViking();
    const log: string[] = [];
    const { client, store } = wire(server, log);
    await store.apply({ op: "note", text: "#feedback something" });
    await store.read();
    // Force a failure so the error path gets a chance to leak it.
    await client.readContent(`${ROOT}/experiences/absent.md`);

    expect(server.calls.length).toBeGreaterThan(0);
    for (const call of server.calls) expect(call.headers["Authorization"]).toBe(`Bearer ${KEY}`);
    expect(log.length).toBeGreaterThan(0);
    expect(log.join("\n")).not.toContain(KEY);
  });

  it("degrades exactly like a dead server when no key is configured, and says so once", async () => {
    const server = new FakeOpenViking();
    const gaps: string[] = [];
    const client = new OpenVikingClient({ baseUrl: BASE, fetchFn: server.fetch, onGap: (g) => gaps.push(g.code) });
    const store = new OpenVikingStore({ client, now: () => NOW, cacheTtlMs: 0 });
    expect(await store.read()).toEqual([]);
    expect((await store.apply({ op: "note", text: "#feedback x" })).ok).toBe(false);
    // Nothing was even attempted: a keyless client cannot touch the server.
    expect(server.calls).toEqual([]);
    // A standing condition is reported once, not once per call.
    expect(gaps).toEqual(["no_key"]);
  });

  it("caches an absent key file but picks one up that appears later", () => {
    const dir = mkdtempSync(join(tmpdir(), "qcr-ov-"));
    const path = join(dir, "openviking_reviewer_key");
    let clock = 0;
    const read = keyFromFile(path, 1000, () => clock);

    expect(read()).toBeNull();
    writeFileSync(path, `${KEY}\n`);
    // Still inside the TTL: the missing-file answer is cached, so a keyless
    // daemon does not stat the disk once per request.
    expect(read()).toBeNull();
    clock = 1500;
    expect(read()).toBe(KEY);
    // Once found it is remembered, not re-read.
    rmSync(dir, { recursive: true, force: true });
    expect(read()).toBe(KEY);
  });
});

// ---- degradation ------------------------------------------------------------

/** Every way the server can fail us. Each must produce a RESOLVED call. */
const BROKEN: Array<{ name: string; fetch: HttpFetch }> = [
  { name: "connection refused", fetch: () => Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:1933")) },
  {
    name: "timeout",
    fetch: () => {
      const err = new Error("aborted");
      err.name = "TimeoutError";
      return Promise.reject(err);
    },
  },
  {
    name: "a fetch seam that throws synchronously",
    fetch: () => {
      throw new TypeError("fetch failed");
    },
  },
  { name: "500 with an HTML body", fetch: () => Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve("<html>nginx</html>") }) },
  { name: "200 with garbage", fetch: () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve("not json at all") }) },
  { name: "200 with an error envelope", fetch: () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{"status":"error","result":null,"error":{"code":"BOOM","message":"nope"}}') }) },
  { name: "403 across users", fetch: () => Promise.resolve({ ok: false, status: 403, text: () => Promise.resolve('{"status":"error","result":null,"error":{"code":"PERMISSION_DENIED","message":"Access denied"}}') }) },
  { name: "a body that reads as null", fetch: () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve("null") }) },
  { name: "text() itself rejecting", fetch: () => Promise.resolve({ ok: true, status: 200, text: () => Promise.reject(new Error("socket hang up")) }) },
];

describe("a dead server cannot make a caller throw", () => {
  for (const broken of BROKEN) {
    it(`survives: ${broken.name}`, async () => {
      const log: string[] = [];
      const gaps: string[] = [];
      const client = new OpenVikingClient({
        baseUrl: BASE,
        apiKey: KEY,
        fetchFn: broken.fetch,
        log: (m) => log.push(m),
        // An alerting sink that throws must not become a memory outage either.
        onGap: (g) => {
          gaps.push(`${g.op}:${g.code}`);
          throw new Error("the overseer sink blew up");
        },
      });
      const store = new OpenVikingStore({ client, now: () => NOW, cacheTtlMs: 0, log: (m) => log.push(m) });
      const assembler = new OpenVikingContextAssembler({ client, store, log: (m) => log.push(m) });

      // The seam.
      await expect(store.read()).resolves.toEqual([]);
      await expect(store.search("anything")).resolves.toEqual([]);
      for (const op of [
        { op: "add", text: "typed by hand" },
        { op: "note", text: "#feedback machine" },
        { op: "edit", text: "new", id: "experiences/20260820T153000-aaaaaaaa.md", ts: "2026-08-20 15:30:00", block: 0, expect: `sha256:${"1".repeat(64)}` },
        { op: "pin", id: "experiences/20260820T153000-aaaaaaaa.md", ts: "2026-08-20 15:30:00", block: 0, expect: `sha256:${"1".repeat(64)}` },
        { op: "unpin", id: "experiences/20260820T153000-aaaaaaaa.md", ts: "2026-08-20 15:30:00", block: 0, expect: `sha256:${"1".repeat(64)}` },
        { op: "retire", id: "experiences/20260820T153000-aaaaaaaa.md", ts: "2026-08-20 15:30:00", block: 0, expect: `sha256:${"1".repeat(64)}` },
      ] as const) {
        const res = await store.apply(op);
        expect(res.ok).toBe(false);
        expect(res.message).not.toBe("");
      }

      // The round path — the contract is "" and never a rejection, because a
      // memory-less round is a normal round.
      await expect(assembler.pinnedHead()).resolves.toBe("");
      await expect(assembler.contextBlock("q", { maxTokens: 2000 })).resolves.toBe("");

      // The client's own surface.
      await expect(client.searchContext("q", {})).resolves.toMatchObject({ ok: false });
      await expect(client.createSession("pr-1")).resolves.toMatchObject({ ok: false });
      await expect(client.deleteSession("pr-1")).resolves.toMatchObject({ ok: false });
      await expect(client.readContent(`${ROOT}/a.md`)).resolves.toMatchObject({ ok: false });
      await expect(client.ls(ROOT)).resolves.toMatchObject({ ok: false });
      await expect(client.remove(`${ROOT}/a.md`)).resolves.toMatchObject({ ok: false });
      await expect(client.setTags(`${ROOT}/a.md`, ["kind=feedback"])).resolves.toBe(false);
      await expect(client.batchWrite({ root_uri: ROOT, operations: [], wait: false })).resolves.toMatchObject({ ok: false });

      // The gap was reported for alerting, and reported in a log line.
      expect(gaps.length).toBeGreaterThan(0);
      expect(log.length).toBeGreaterThan(0);
    });
  }

  it("keeps the assembler's promise even when the store itself throws", async () => {
    const exploding = {
      read: () => Promise.reject(new Error("store is on fire")),
    } as unknown as OpenVikingStore;
    const client = new OpenVikingClient({ baseUrl: BASE, apiKey: KEY, fetchFn: () => Promise.reject(new Error("down")) });
    const assembler: ContextAssembler = new OpenVikingContextAssembler({ client, store: exploding });
    await expect(assembler.pinnedHead()).resolves.toBe("");
    await expect(assembler.contextBlock("q", { maxTokens: 100 })).resolves.toBe("");
  });

  it("skips one unreadable file rather than losing the whole sweep", async () => {
    const server = new FakeOpenViking();
    const { store } = wire(server);
    await store.apply({ op: "note", text: "#feedback good one" });
    await store.apply({ op: "note", text: "#feedback another good one" });
    // One file vanishes between the listing and the read.
    const doomed = [...server.files.keys()][0]!;
    const realFetch = server.fetch;
    const client2 = new OpenVikingClient({
      baseUrl: BASE,
      apiKey: KEY,
      user: "reviewer",
      fetchFn: (url, init) => (url.includes(encodeURIComponent(doomed)) ? Promise.reject(new Error("gone")) : realFetch(url, init)),
    });
    const store2 = new OpenVikingStore({ client: client2, now: () => NOW, cacheTtlMs: 0 });
    const entries = await store2.read();
    expect(entries).toHaveLength(1);
  });
});

// ---- the pinned head --------------------------------------------------------

describe("the pinned head", () => {
  it("delivers pinned entries verbatim, oldest first, and nothing else", async () => {
    const server = new FakeOpenViking();
    const { store, assembler } = wire(server);
    await store.apply({ op: "note", text: "#pinned never dismiss an approval" });
    await store.apply({ op: "note", text: "#feedback not a standing instruction" });
    const head = await assembler.pinnedHead();
    expect(head).toContain("never dismiss an approval");
    expect(head).not.toContain("not a standing instruction");
  });

  it("is empty — not a rejection — when nothing is pinned", async () => {
    const server = new FakeOpenViking();
    const { store, assembler } = wire(server);
    await store.apply({ op: "note", text: "#feedback ordinary" });
    await expect(assembler.pinnedHead()).resolves.toBe("");
  });
});

// ---- pure helpers -----------------------------------------------------------

describe("entry naming and tag helpers", () => {
  it("addresses are exact, not guessed", () => {
    expect(validEntryId("experiences/20260820T153000-a1b2c3d4.md")).toBe(true);
    expect(validEntryId("notes.txt")).toBe(true);
    expect(validEntryId("experiences/../../etc/passwd")).toBe(false);
    expect(validEntryId("experiences/deep/nested/file.md")).toBe(false);
    expect(validEntryId("experiences/file.exe")).toBe(false);
  });

  it("reads the timestamp out of the name, so an entry's time is its own", () => {
    expect(tsFromName("20260820T153000-a1b2c3d4.md")).toBe("2026-08-20 15:30:00");
    expect(tsFromName("no-stamp-here.md")).toBeNull();
  });

  it("prepends tags at the head and never duplicates one", () => {
    expect(renderEntryBody("a lesson", ["manual"])).toBe("#manual a lesson\n");
    expect(renderEntryBody("#manual a lesson", ["manual"])).toBe("#manual a lesson\n");
    expect(withTag("#feedback x", "pinned")).toBe("#pinned #feedback x\n");
    expect(withoutTag("#pinned #feedback x", "pinned")).toBe("#feedback x\n");
    expect(withoutTag("#feedback x", "pinned")).toBe("#feedback x\n");
  });
});

// The embedder migration behind "the local embedder ships as the default".
//
// Three properties are acceptance criteria here, not implementation detail:
//
//   1. A STORE IS NEVER SILENTLY LEFT WITH VECTORS ITS EMBEDDER CANNOT READ.
//      `prepare` compares the collection's OWN embedding record (the one the
//      server checks) against ov.conf, and a mismatch is a reset + a journal —
//      never a quiet boot that the server then refuses.
//   2. THE RESET IS NON-DESTRUCTIVE AND BOUNDED. The old collection is MOVED,
//      never deleted; the memory text under `viking/` is never touched; a
//      running server refuses the reset; a reset that already happened for the
//      same embedder is never repeated (no loop).
//   3. THE RE-EMBED IS RESUMABLE AND HONEST. A namespace is `completed` only
//      when the server's task finished with zero failed records; a partial
//      rebuild, a busy server or a deadline leave it pending/failed for the
//      next run, with the counts on record. The request carries the USER key
//      and nothing else — the server's confinement is what scopes it.
//
// The HTTP shapes below (reindex `accepted` + task polling, the collection
// description marker, the 403 wording) were taken from a running 0.4.15 on a
// throwaway copy — see docs/memory-embeddings.md.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// Plain JS, dependency-free, run by the entrypoint before any build exists;
// `tsconfig.tests.json` sets allowJs so these call sites are type-checked.
import * as reembed from "../scripts/openviking-reembed.mjs";
import { LOCAL_EMBEDDER_WIRE_PROVIDER, LOCAL_EMBEDDING } from "../src/config.js";

const BASE = "http://127.0.0.1:19333";
const HOSTED = { provider: "openai", model: "text-embedding-3-small", dimension: 1536 };
const LOCAL = { provider: "local", model: "bge-small-zh-v1.5-f16", dimension: 512 };

/** The description a real 0.4.15 wrote for a hosted-embedded collection. */
function metaText(
  e: { provider: string; model: string; dimension: number },
  identity = e.model,
): string {
  const payload = JSON.stringify({
    dimension: e.dimension,
    model: e.model,
    model_identity: identity,
    provider: e.provider,
  });
  return JSON.stringify({
    CollectionName: "context",
    Description: `Unified context collection\n\n[openviking.embedding]\n${payload}`,
    Fields: [],
  });
}

const LOCAL_CONF = {
  server: { host: "127.0.0.1", port: 19333 },
  storage: { workspace: "" },
  embedding: { dense: { ...LOCAL, input: "text" } },
};

let home: string;
function collectionDir(): string {
  return join(home, "workspace", "vectordb", "context");
}
function seedStore(e = HOSTED): void {
  mkdirSync(collectionDir(), { recursive: true });
  writeFileSync(join(collectionDir(), "collection_meta.json"), metaText(e));
  mkdirSync(join(collectionDir(), "store"), { recursive: true });
  writeFileSync(join(collectionDir(), "store", "CURRENT"), "MANIFEST-000002");
  const memories = join(
    home,
    "workspace",
    "viking",
    "default",
    "user",
    "reviewer",
    "memories",
    "experiences",
  );
  mkdirSync(memories, { recursive: true });
  writeFileSync(
    join(memories, "20260901T100000-aaaa0000.md"),
    "#calibration never dismiss an approval\n",
  );
}
function conf(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...LOCAL_CONF, storage: { workspace: join(home, "workspace") }, ...overrides };
}
const noServer = async () => {
  throw new Error("ECONNREFUSED");
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "qcr-reembed-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

// ---- the embedder record ----------------------------------------------------

describe("configuredEmbedder — what ov.conf runs, credential excluded", () => {
  it("an absent embedding section is the server's built-in local embedder", () => {
    expect(reembed.configuredEmbedder({})).toEqual(LOCAL);
    expect(reembed.configuredEmbedder(null)).toEqual(LOCAL);
  });

  it("local with no model/dimension fills the one local spec", () => {
    expect(reembed.configuredEmbedder({ embedding: { dense: { provider: "local" } } })).toEqual(
      LOCAL,
    );
  });

  it("a hosted provider is reported as configured — and the api_key never rides along", () => {
    const e = reembed.configuredEmbedder({
      embedding: {
        dense: {
          provider: "OpenAI",
          model: "text-embedding-3-small",
          dimension: 1536,
          api_key: "sk-secret",
        },
      },
    });
    expect(e).toEqual(HOSTED);
    expect(JSON.stringify(e)).not.toContain("sk-secret");
  });
});

describe("storedEmbedder — the collection's own record", () => {
  it("parses the marker a real 0.4.15 writes", () => {
    expect(reembed.storedEmbedder(metaText(HOSTED))).toEqual({
      ...HOSTED,
      model_identity: "text-embedding-3-small",
    });
  });

  it("no marker, or garbage, is null — unknown, never compatible", () => {
    expect(
      reembed.storedEmbedder(
        JSON.stringify({ CollectionName: "context", Description: "Unified context collection" }),
      ),
    ).toBeNull();
    expect(reembed.storedEmbedder("not json")).toBeNull();
    expect(
      reembed.storedEmbedder(
        JSON.stringify({ Description: "x\n\n[openviking.embedding]\nnot-json" }),
      ),
    ).toBeNull();
  });

  it("sameEmbedder compares provider, model and dimension — and nothing null", () => {
    expect(reembed.sameEmbedder(HOSTED, { ...HOSTED, model_identity: "x" })).toBe(true);
    expect(reembed.sameEmbedder(HOSTED, LOCAL)).toBe(false);
    expect(reembed.sameEmbedder(null, LOCAL)).toBe(false);
  });
});

// ---- the decision -------------------------------------------------------------

describe("planPrepare — pure", () => {
  it("no collection yet ⇒ nothing to do", () => {
    expect(
      reembed.planPrepare({ stored: null, metaPresent: false, expected: LOCAL, journal: null })
        .action,
    ).toBe("none");
  });

  it("a collection with unreadable metadata is REFUSED, not reset", () => {
    expect(
      reembed.planPrepare({ stored: null, metaPresent: true, expected: LOCAL, journal: null })
        .action,
    ).toBe("refuse");
  });

  it("a matching collection ⇒ none; a different embedder ⇒ reset", () => {
    expect(
      reembed.planPrepare({
        stored: { ...LOCAL, model_identity: "f7e1" },
        metaPresent: true,
        expected: LOCAL,
        journal: null,
      }).action,
    ).toBe("none");
    const plan = reembed.planPrepare({
      stored: { ...HOSTED, model_identity: HOSTED.model },
      metaPresent: true,
      expected: LOCAL,
      journal: null,
    });
    expect(plan.action).toBe("reset");
    expect(plan.reason).toContain("1536");
    expect(plan.reason).toContain("512");
  });

  it("a reset already recorded for THIS embedder is never repeated — the loop guard", () => {
    const journal = {
      version: 1,
      embedder: LOCAL,
      previous: HOSTED,
      reset_at: "2026-09-02T15:00:00.000Z",
      namespaces: {},
    };
    const plan = reembed.planPrepare({
      stored: { ...HOSTED, model_identity: HOSTED.model },
      metaPresent: true,
      expected: LOCAL,
      journal,
    });
    expect(plan.action).toBe("refuse");
    expect(plan.reason).toContain("already reset");
  });

  it("a reset recorded for a DIFFERENT embedder does not block a new one", () => {
    const journal = {
      version: 1,
      embedder: HOSTED,
      previous: null,
      reset_at: "2026-08-01T00:00:00.000Z",
      namespaces: {},
    };
    expect(
      reembed.planPrepare({
        stored: { ...HOSTED, model_identity: HOSTED.model },
        metaPresent: true,
        expected: LOCAL,
        journal,
      }).action,
    ).toBe("reset");
  });
});

// ---- prepare, on disk -------------------------------------------------------------

describe("prepare — the disk half", () => {
  it("moves a mismatched collection ASIDE, keeps the memory text, and journals its own namespace pending and every other as the operator's", async () => {
    seedStore(HOSTED);
    const lines: string[] = [];
    const now = () => new Date("2026-09-02T15:30:00.000Z");
    const report = await reembed.prepare({
      home,
      conf: conf(),
      users: ["reviewer", "companion"],
      base: BASE,
      fetchFn: noServer,
      now,
      log: (l: string) => lines.push(l),
    });
    expect(report.action).toBe("reset");
    expect(existsSync(collectionDir())).toBe(false);
    const moved = `${collectionDir()}.pre-reembed-20260902T153000Z`;
    expect(report.movedTo).toBe(moved);
    // Moved, not deleted: the old vectors are the rollback.
    expect(readFileSync(join(moved, "store", "CURRENT"), "utf8")).toBe("MANIFEST-000002");
    // The memory TEXT is never touched.
    expect(
      readFileSync(
        join(
          home,
          "workspace",
          "viking",
          "default",
          "user",
          "reviewer",
          "memories",
          "experiences",
          "20260901T100000-aaaa0000.md",
        ),
        "utf8",
      ),
    ).toContain("never dismiss");
    const journal = JSON.parse(readFileSync(join(home, "reembed.json"), "utf8"));
    expect(journal).toMatchObject({
      version: 1,
      embedder: LOCAL,
      previous: { ...HOSTED, model_identity: HOSTED.model },
      reset_at: "2026-09-02T15:30:00.000Z",
      moved_to: moved,
      // This host holds the reviewer key and no other: the companion's row is
      // journalled for its key holder, never marked as something the daemon
      // will do.
      namespaces: { reviewer: { state: "pending" }, companion: { state: "operator" } },
    });
    expect(lines.join("\n")).toContain("RESET");
    expect(lines.join("\n")).toContain("companion by its key's holder");
    expect(reembed.journalStatus(home)).toMatchObject({
      state: "pending",
      awaiting_operator: ["companion"],
    });
  });

  it("the own namespace is journalled even when the users list omits it", async () => {
    seedStore(HOSTED);
    await reembed.prepare({
      home,
      conf: conf(),
      users: ["companion"],
      own: "reviewer",
      base: BASE,
      fetchFn: noServer,
    });
    const journal = JSON.parse(readFileSync(join(home, "reembed.json"), "utf8"));
    expect(journal.namespaces).toEqual({
      reviewer: { state: "pending" },
      companion: { state: "operator" },
    });
  });

  it("a matching collection is a no-op that writes nothing", async () => {
    seedStore(LOCAL);
    const report = await reembed.prepare({
      home,
      conf: conf(),
      users: ["reviewer"],
      base: BASE,
      fetchFn: noServer,
    });
    expect(report.action).toBe("none");
    expect(existsSync(collectionDir())).toBe(true);
    expect(existsSync(join(home, "reembed.json"))).toBe(false);
    expect(reembed.journalStatus(home).state).toBe("none");
  });

  it("a fresh install (no collection) is a no-op", async () => {
    const report = await reembed.prepare({
      home,
      conf: conf(),
      users: ["reviewer"],
      base: BASE,
      fetchFn: noServer,
    });
    expect(report.action).toBe("none");
    expect(readdirSync(home)).toEqual([]);
  });

  it("REFUSES while a server answers on the port — a collection is never moved out from under one", async () => {
    seedStore(HOSTED);
    const up = async () => ({ status: 200, json: async () => ({ version: "0.4.15" }) });
    const report = await reembed.prepare({
      home,
      conf: conf(),
      users: ["reviewer"],
      base: BASE,
      fetchFn: up,
    });
    expect(report.action).toBe("refuse");
    expect(report.reason).toContain("stop it");
    expect(existsSync(collectionDir())).toBe(true);
    expect(existsSync(join(home, "reembed.json"))).toBe(false);
  });

  it("an unreadable journal REFUSES — 'could not read' is not 'nothing there'", async () => {
    seedStore(HOSTED);
    writeFileSync(join(home, "reembed.json"), "{not json");
    const report = await reembed.prepare({
      home,
      conf: conf(),
      users: ["reviewer"],
      base: BASE,
      fetchFn: noServer,
    });
    expect(report.action).toBe("refuse");
    expect(existsSync(collectionDir())).toBe(true);
    expect(reembed.journalStatus(home).state).toBe("unreadable");
  });

  it("the second boot after a reset does nothing: the server owns the new collection", async () => {
    seedStore(HOSTED);
    await reembed.prepare({
      home,
      conf: conf(),
      users: ["reviewer"],
      base: BASE,
      fetchFn: noServer,
    });
    // The server has now created the new collection under the new embedder.
    seedStore(LOCAL);
    const again = await reembed.prepare({
      home,
      conf: conf(),
      users: ["reviewer"],
      base: BASE,
      fetchFn: noServer,
    });
    expect(again.action).toBe("none");
    expect(
      readdirSync(join(home, "workspace", "vectordb")).filter((n) =>
        n.startsWith("context.pre-reembed-"),
      ),
    ).toHaveLength(1);
  });

  it("an ov.conf with no embedding section runs local — a hosted store is reset for it", async () => {
    seedStore(HOSTED);
    const report = await reembed.prepare({
      home,
      conf: { server: { port: 19333 }, storage: { workspace: join(home, "workspace") } },
      users: ["reviewer"],
      base: BASE,
      fetchFn: noServer,
    });
    expect(report.action).toBe("reset");
    expect(report.expected).toEqual(LOCAL);
  });
});

// ---- the HTTP half ----------------------------------------------------------------

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function fakeFetch(
  routes: Array<{
    match: RegExp;
    method?: string;
    status: number;
    body?: unknown;
    throws?: boolean;
    times?: number;
  }>,
) {
  const calls: Call[] = [];
  const fetchFn = async (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, headers: init?.headers ?? {}, body: init?.body });
    const hit = routes.find(
      (r) =>
        r.match.test(url) &&
        (r.method === undefined || r.method === method) &&
        (r.times === undefined || r.times > 0),
    );
    if (!hit)
      return { status: 404, json: async () => ({ status: "error", error: { code: "NOT_FOUND" } }) };
    if (hit.times !== undefined) hit.times -= 1;
    if (hit.throws) throw new Error("ECONNREFUSED");
    return { status: hit.status, json: async () => hit.body ?? {} };
  };
  return { fetchFn, calls };
}

const noSleep = async () => {};
const REINDEX = /\/api\/v1\/content\/reindex$/;
const TASK = /\/api\/v1\/tasks\/task-1$/;
const done = {
  status: "completed",
  uri: "viking://user/reviewer",
  scanned_records: 11,
  rebuilt_records: 14,
  failed_records: 0,
  unsupported_records: 0,
};

describe("reindexNamespace — one namespace, the user's own key", () => {
  it("accepted + polled to completion, with the counts the task reports", async () => {
    const { fetchFn, calls } = fakeFetch([
      {
        match: REINDEX,
        method: "POST",
        status: 200,
        body: { status: "ok", result: { task_id: "task-1", status: "accepted" } },
      },
      {
        match: TASK,
        status: 200,
        body: { status: "ok", result: { task_id: "task-1", status: "running" } },
        times: 2,
      },
      {
        match: TASK,
        status: 200,
        body: { status: "ok", result: { task_id: "task-1", status: "completed", result: done } },
      },
    ]);
    const r = await reembed.reindexNamespace({
      base: BASE,
      key: "reviewer-secret",
      user: "reviewer",
      fetchFn,
      sleep: noSleep,
    });
    expect(r).toMatchObject({
      status: "completed",
      uri: "viking://user/reviewer",
      task_id: "task-1",
      rebuilt_records: 14,
      failed_records: 0,
    });
    const post = calls[0]!;
    expect(JSON.parse(post.body!)).toEqual({
      uri: "viking://user/reviewer",
      mode: "vectors_only",
      wait: false,
    });
    // The USER key, as a Bearer — the confinement is the server's, and no
    // root/admin credential exists on this path.
    expect(post.headers["Authorization"]).toBe("Bearer reviewer-secret");
    expect(post.headers["X-OpenViking-User"]).toBe("reviewer");
    // NO actor-peer header: with one, the live 0.4.15 refuses the key its own
    // namespace (see `reindexHeaders`).
    expect(post.headers["X-OpenViking-Actor-Peer"]).toBeUndefined();
    expect(calls.filter((c) => TASK.test(c.url))).toHaveLength(3);
  });

  it("a synchronous 'completed' answer needs no polling", async () => {
    const { fetchFn, calls } = fakeFetch([
      { match: REINDEX, method: "POST", status: 200, body: { status: "ok", result: done } },
    ]);
    const r = await reembed.reindexNamespace({
      base: BASE,
      key: "k",
      user: "reviewer",
      fetchFn,
      sleep: noSleep,
    });
    expect(r.status).toBe("completed");
    expect(calls).toHaveLength(1);
  });

  it("a 403 is a refusal named as such — the key does not own the namespace", async () => {
    const { fetchFn } = fakeFetch([
      {
        match: REINDEX,
        method: "POST",
        status: 403,
        body: {
          status: "error",
          error: {
            code: "PERMISSION_DENIED",
            message: "USER can only reindex their own user namespace.",
          },
        },
      },
    ]);
    const r = await reembed.reindexNamespace({
      base: BASE,
      key: "k",
      user: "companion",
      fetchFn,
      sleep: noSleep,
    });
    expect(r.status).toBe("failed");
    expect(r.detail).toContain("own user namespace");
  });

  it("a 409 is BUSY, a failed task is failed, a dead server is failed — never a throw", async () => {
    const busy = fakeFetch([{ match: REINDEX, method: "POST", status: 409, body: {} }]);
    expect(
      (
        await reembed.reindexNamespace({
          base: BASE,
          key: "k",
          user: "reviewer",
          fetchFn: busy.fetchFn,
          sleep: noSleep,
        })
      ).status,
    ).toBe("busy");
    const failed = fakeFetch([
      {
        match: REINDEX,
        method: "POST",
        status: 200,
        body: { status: "ok", result: { task_id: "task-1", status: "accepted" } },
      },
      {
        match: TASK,
        status: 200,
        body: {
          status: "ok",
          result: { task_id: "task-1", status: "failed", error: "embedder exploded" },
        },
      },
    ]);
    const f = await reembed.reindexNamespace({
      base: BASE,
      key: "k",
      user: "reviewer",
      fetchFn: failed.fetchFn,
      sleep: noSleep,
    });
    expect(f.status).toBe("failed");
    expect(f.detail).toContain("embedder exploded");
    const dead = fakeFetch([{ match: REINDEX, method: "POST", status: 0, throws: true }]);
    expect(
      (
        await reembed.reindexNamespace({
          base: BASE,
          key: "k",
          user: "reviewer",
          fetchFn: dead.fetchFn,
          sleep: noSleep,
        })
      ).status,
    ).toBe("failed");
  });

  it("a 200 carrying an error envelope is a failure, not a success", async () => {
    const { fetchFn } = fakeFetch([
      {
        match: REINDEX,
        method: "POST",
        status: 200,
        body: { status: "error", error: { message: "queue down" } },
      },
    ]);
    const r = await reembed.reindexNamespace({
      base: BASE,
      key: "k",
      user: "reviewer",
      fetchFn,
      sleep: noSleep,
    });
    expect(r.status).toBe("failed");
    expect(r.detail).toContain("queue down");
  });

  it("gives the task up at the deadline — pending again, never a hang", async () => {
    const { fetchFn } = fakeFetch([
      {
        match: REINDEX,
        method: "POST",
        status: 200,
        body: { status: "ok", result: { task_id: "task-1", status: "accepted" } },
      },
      {
        match: TASK,
        status: 200,
        body: { status: "ok", result: { task_id: "task-1", status: "running" } },
      },
    ]);
    let t = 0;
    const r = await reembed.reindexNamespace({
      base: BASE,
      key: "k",
      user: "reviewer",
      fetchFn,
      sleep: noSleep,
      now: () => (t += 1000),
      deadlineMs: 5000,
    });
    expect(r.status).toBe("timeout");
    expect(r.task_id).toBe("task-1");
  });
});

describe("resume — journal in, journal out", () => {
  const journal = (state: string) => ({
    version: 1,
    embedder: LOCAL,
    previous: HOSTED,
    reset_at: "2026-09-02T15:30:00.000Z",
    namespaces: { reviewer: { state }, companion: { state: "operator" } },
  });
  const completedServer = () =>
    fakeFetch([
      {
        match: REINDEX,
        method: "POST",
        status: 200,
        body: { status: "ok", result: { task_id: "task-1", status: "accepted" } },
      },
      {
        match: TASK,
        status: 200,
        body: { status: "ok", result: { task_id: "task-1", status: "completed", result: done } },
      },
    ]);

  it("a pending namespace is re-embedded and journalled COMPLETED with its counts", async () => {
    reembed.writeJournal(home, journal("pending"));
    const { fetchFn } = completedServer();
    const r = await reembed.resume({
      home,
      base: BASE,
      key: "k",
      user: "reviewer",
      fetchFn,
      sleep: noSleep,
      now: () => new Date("2026-09-02T16:00:00.000Z"),
    });
    expect(r.state).toBe("completed");
    const after = JSON.parse(readFileSync(join(home, "reembed.json"), "utf8"));
    expect(after.namespaces.reviewer).toMatchObject({
      state: "completed",
      at: "2026-09-02T16:00:00.000Z",
      attempts: 1,
      rebuilt_records: 14,
      failed_records: 0,
      task_id: "task-1",
    });
    // The other namespace is untouched: this key cannot reach it — and it
    // does not hold the overall state hostage, it is listed beside it.
    expect(after.namespaces.companion).toEqual({ state: "operator" });
    expect(reembed.journalStatus(home)).toMatchObject({
      state: "completed",
      awaiting_operator: ["companion"],
    });
  });

  it("an operator's settle that lands WHILE the rebuild runs survives resume's write", async () => {
    // resume reads the journal, then awaits the rebuild for up to its
    // deadline; the documented `settle` runs in another process meanwhile.
    // resume must merge its own row into the journal as it stands at write
    // time, never write back the snapshot it read before the rebuild.
    reembed.writeJournal(home, journal("pending"));
    const { fetchFn } = completedServer();
    let settled = false;
    const racing = async (url: string, init?: { method?: string }) => {
      if (!settled && TASK.test(url)) {
        settled = true;
        expect(reembed.settle({ home, user: "companion" }).ok).toBe(true);
      }
      return fetchFn(url, init);
    };
    const r = await reembed.resume({
      home,
      base: BASE,
      key: "k",
      user: "reviewer",
      fetchFn: racing,
      sleep: noSleep,
    });
    expect(settled).toBe(true);
    expect(r.state).toBe("completed");
    const after = JSON.parse(readFileSync(join(home, "reembed.json"), "utf8"));
    expect(after.namespaces.reviewer.state).toBe("completed");
    expect(after.namespaces.companion).toMatchObject({
      state: "completed",
      settled_by: "operator",
    });
    expect(reembed.journalStatus(home)).toMatchObject({
      state: "completed",
      awaiting_operator: [],
    });
  });

  it("an operator's settle of this host's OWN row mid-rebuild is not overwritten by a failed run", async () => {
    reembed.writeJournal(home, journal("pending"));
    let settled = false;
    const fetchFn = async (url: string) => {
      if (!settled) {
        settled = true;
        expect(reembed.settle({ home, user: "reviewer", detail: "by hand" }).ok).toBe(true);
      }
      void url;
      return { status: 500, json: async () => ({ status: "error" }) };
    };
    const r = await reembed.resume({
      home,
      base: BASE,
      key: "k",
      user: "reviewer",
      fetchFn,
      sleep: noSleep,
    });
    expect(settled).toBe(true);
    expect(r.state).toBe("failed");
    const after = JSON.parse(readFileSync(join(home, "reembed.json"), "utf8"));
    expect(after.namespaces.reviewer).toMatchObject({ state: "completed", settled_by: "operator" });
  });

  it("a migration re-armed WHILE the rebuild runs is not overwritten with the old outcome", async () => {
    reembed.writeJournal(home, journal("pending"));
    const { fetchFn } = completedServer();
    const rearmed = { ...journal("pending"), reset_at: "2026-09-02T15:45:00.000Z" };
    let swapped = false;
    const racing = async (url: string, init?: { method?: string }) => {
      if (!swapped && TASK.test(url)) {
        swapped = true;
        reembed.writeJournal(home, rearmed);
      }
      return fetchFn(url, init);
    };
    const r = await reembed.resume({
      home,
      base: BASE,
      key: "k",
      user: "reviewer",
      fetchFn: racing,
      sleep: noSleep,
    });
    expect(swapped).toBe(true);
    // The daemon logs `detail`: it must say the outcome was not journalled.
    expect(r.detail).toMatch(/not journalled/);
    // The rebuild ran against the OLD migration: its outcome must not mark
    // the new one's namespace completed.
    expect(JSON.parse(readFileSync(join(home, "reembed.json"), "utf8"))).toEqual(rearmed);
  });

  it("an operator namespace is never resumed from this host, even with a key", async () => {
    reembed.writeJournal(home, journal("completed"));
    const { fetchFn, calls } = completedServer();
    const r = await reembed.resume({
      home,
      base: BASE,
      key: "companion-key-somehow",
      user: "companion",
      fetchFn,
      sleep: noSleep,
    });
    expect(r).toMatchObject({ action: "none", state: "operator" });
    expect(calls).toHaveLength(0);
  });

  it("a partial rebuild stays FAILED — completed means zero failed records", async () => {
    reembed.writeJournal(home, journal("pending"));
    const { fetchFn } = fakeFetch([
      {
        match: REINDEX,
        method: "POST",
        status: 200,
        body: { status: "ok", result: { ...done, failed_records: 2 } },
      },
    ]);
    const r = await reembed.resume({
      home,
      base: BASE,
      key: "k",
      user: "reviewer",
      fetchFn,
      sleep: noSleep,
    });
    expect(r.state).toBe("failed");
    const after = JSON.parse(readFileSync(join(home, "reembed.json"), "utf8"));
    expect(after.namespaces.reviewer.detail).toContain("partial");
    expect(reembed.journalStatus(home).state).toBe("failed");
  });

  it("busy and timeout leave the namespace pending with the attempt counted", async () => {
    reembed.writeJournal(home, journal("failed"));
    const { fetchFn } = fakeFetch([{ match: REINDEX, method: "POST", status: 409, body: {} }]);
    const r = await reembed.resume({
      home,
      base: BASE,
      key: "k",
      user: "reviewer",
      fetchFn,
      sleep: noSleep,
    });
    expect(r.state).toBe("pending");
    expect(
      JSON.parse(readFileSync(join(home, "reembed.json"), "utf8")).namespaces.reviewer.attempts,
    ).toBe(1);
  });

  it("nothing to do: no journal, an already-completed namespace, or no key", async () => {
    const { fetchFn, calls } = completedServer();
    expect(
      (await reembed.resume({ home, base: BASE, key: "k", user: "reviewer", fetchFn })).action,
    ).toBe("none");
    reembed.writeJournal(home, journal("completed"));
    expect(
      (await reembed.resume({ home, base: BASE, key: "k", user: "reviewer", fetchFn })).state,
    ).toBe("completed");
    reembed.writeJournal(home, journal("pending"));
    const noKey = await reembed.resume({ home, base: BASE, key: "", user: "reviewer", fetchFn });
    expect(noKey.action).toBe("none");
    expect(noKey.detail).toContain("no reviewer key");
    expect(calls).toHaveLength(0);
  });

  it("every namespace completed ⇒ status completed with nobody awaited", () => {
    reembed.writeJournal(home, {
      ...journal("completed"),
      namespaces: { reviewer: { state: "completed" }, companion: { state: "completed" } },
    });
    expect(reembed.journalStatus(home)).toMatchObject({
      state: "completed",
      embedder: LOCAL,
      previous: HOSTED,
      awaiting_operator: [],
    });
  });
});

describe("settle — the operator's receipt", () => {
  const journal = () => ({
    version: 1,
    embedder: LOCAL,
    previous: HOSTED,
    reset_at: "2026-09-02T15:30:00.000Z",
    namespaces: {
      reviewer: { state: "completed", at: "2026-09-02T16:00:00.000Z" },
      companion: { state: "operator" },
    },
  });

  it("marks an operator namespace completed, by the operator, and the status stops naming it", () => {
    reembed.writeJournal(home, journal());
    const r = reembed.settle({
      home,
      user: "companion",
      detail: "qcr memory reembed: 9 records from 7 sources",
      now: () => new Date("2026-09-03T08:00:00.000Z"),
    });
    expect(r.ok).toBe(true);
    const after = JSON.parse(readFileSync(join(home, "reembed.json"), "utf8"));
    expect(after.namespaces.companion).toEqual({
      state: "completed",
      at: "2026-09-03T08:00:00.000Z",
      settled_by: "operator",
      detail: "qcr memory reembed: 9 records from 7 sources",
    });
    expect(reembed.journalStatus(home)).toMatchObject({
      state: "completed",
      awaiting_operator: [],
    });
  });

  it("refuses — as an answer — a missing journal, an unknown row and a row already completed", () => {
    expect(reembed.settle({ home, user: "companion" }).ok).toBe(false);
    reembed.writeJournal(home, journal());
    expect(reembed.settle({ home, user: "nobody" })).toMatchObject({
      ok: false,
      detail: expect.stringContaining("no re-embed on record"),
    });
    expect(reembed.settle({ home, user: "reviewer" })).toMatchObject({
      ok: false,
      detail: expect.stringContaining("already completed"),
    });
    writeFileSync(join(home, "reembed.json"), "{not json");
    expect(reembed.settle({ home, user: "companion" })).toMatchObject({
      ok: false,
      detail: expect.stringContaining("cannot be parsed"),
    });
  });

  it("through main: exit 0 on a receipt, exit 1 on a refusal", async () => {
    reembed.writeJournal(home, journal());
    const lines: string[] = [];
    expect(
      await reembed.main(
        ["settle", "--home", home, "--user", "companion", "--detail", "done from the PC"],
        { env: {}, log: (l: string) => lines.push(l) },
      ),
    ).toBe(0);
    expect(lines.join("\n")).toContain("completed: done from the PC");
    expect(
      await reembed.main(["settle", "--home", home, "--user", "companion"], {
        env: {},
        log: () => {},
      }),
    ).toBe(1);
  });
});

// ---- cli -----------------------------------------------------------------------------

describe("cli surface", () => {
  it("parses the entrypoint's prepare invocation and the daemon's resume", () => {
    const p = reembed.parseArgs(
      [
        "prepare",
        "--home",
        "/opt/quickreview/state/openviking",
        "--config",
        "/opt/quickreview/state/openviking/ov.conf",
        "--users",
        "reviewer,companion",
        "--user",
        "reviewer",
      ],
      {},
    );
    expect(p).toMatchObject({
      command: "prepare",
      home: "/opt/quickreview/state/openviking",
      users: ["reviewer", "companion"],
      user: "reviewer",
      strict: false,
    });
    const r = reembed.parseArgs(
      [
        "resume",
        "--home",
        "/h",
        "--base",
        "http://127.0.0.1:1933",
        "--user",
        "reviewer",
        "--key-file",
        "/s/openviking_reviewer_key",
      ],
      {},
    );
    expect(r).toMatchObject({
      command: "resume",
      base: "http://127.0.0.1:1933",
      user: "reviewer",
      keyFile: "/s/openviking_reviewer_key",
      config: "/h/ov.conf",
    });
  });

  it("prepare with no ov.conf is a boot-safe no-op: exit 0, exit 1 only under --strict", async () => {
    const lines: string[] = [];
    expect(
      await reembed.main(["prepare", "--home", home], {
        env: {},
        log: (l: string) => lines.push(l),
      }),
    ).toBe(0);
    expect(lines.join("\n")).toContain("skipped");
    expect(
      await reembed.main(["prepare", "--home", home, "--strict"], { env: {}, log: () => {} }),
    ).toBe(1);
  });

  it("prepare through main resets a mismatched store and status reports it", async () => {
    seedStore(HOSTED);
    writeFileSync(
      join(home, "ov.conf"),
      JSON.stringify(conf({ server: { host: "127.0.0.1", port: 1 } })),
    );
    const lines: string[] = [];
    expect(
      await reembed.main(["prepare", "--home", home, "--users", "reviewer"], {
        env: {},
        log: (l: string) => lines.push(l),
      }),
    ).toBe(0);
    expect(existsSync(collectionDir())).toBe(false);
    lines.length = 0;
    expect(
      await reembed.main(["status", "--home", home], {
        env: {},
        log: (l: string) => lines.push(l),
      }),
    ).toBe(0);
    expect(JSON.parse(lines.join("\n"))).toMatchObject({
      state: "pending",
      namespaces: { reviewer: { state: "pending" } },
    });
  });

  it("refuses to run without --home, and names the commands on an unknown one", async () => {
    expect(await reembed.main([], { env: {}, log: () => {} })).toBe(2);
    const lines: string[] = [];
    expect(
      await reembed.main(["frobnicate", "--home", home], {
        env: {},
        log: (l: string) => lines.push(l),
      }),
    ).toBe(2);
    expect(lines.join("\n")).toContain("prepare | resume | status | settle | rehearse");
  });
});

// The same migration carries a store from
// the engine's built-in Chinese-first local model (512 dims) to the local
// English embedder (384 dims, the engine's OpenAI-compatible provider at a
// loopback api_base). Nothing new is needed in the script but the records:
// the provider, the model AND the dimension all change, so it is a reset and a
// re-embed, never a server refusing to boot.
describe("the move to the local English embedder (S4)", () => {
  const LOCAL_EN = {
    provider: LOCAL_EMBEDDER_WIRE_PROVIDER,
    model: LOCAL_EMBEDDING.model,
    dimension: LOCAL_EMBEDDING.dimension,
  };
  const EN_CONF = {
    server: { host: "127.0.0.1", port: 19333 },
    embedding: {
      dense: {
        ...LOCAL_EN,
        api_base: "http://127.0.0.1:1934/v1",
        query_param: "query",
        document_param: "passage",
        input: "text",
      },
    },
  };
  const enConf = () => ({ ...EN_CONF, storage: { workspace: join(home, "workspace") } });

  it("LOCAL_EMBEDDER is the record the shipped default writes — config.ts's model, as the engine spells it", () => {
    expect(reembed.LOCAL_EMBEDDER).toEqual(LOCAL_EN);
    expect(reembed.configuredEmbedder(EN_CONF)).toEqual(LOCAL_EN);
    // The loopback api_base is NOT part of the record (the server never
    // stores it); the daemon's drift check compares it separately.
    expect(reembed.configuredEmbedder(EN_CONF)).not.toHaveProperty("api_base");
    // …and an ov.conf with no embedding section is still the server's own
    // built-in model, because that is what such a server runs.
    expect(reembed.SERVER_DEFAULT_EMBEDDER).toEqual(LOCAL);
    expect(reembed.configuredEmbedder({})).toEqual(LOCAL);
  });

  it("a store built under the built-in model (512) is moved aside and journalled for re-embedding at 384", async () => {
    seedStore(LOCAL);
    const lines: string[] = [];
    const report = await reembed.prepare({
      home,
      conf: enConf(),
      users: ["reviewer", "companion"],
      base: BASE,
      fetchFn: noServer,
      now: () => new Date("2026-10-07T09:00:00.000Z"),
      log: (l: string) => lines.push(l),
    });
    expect(report.action).toBe("reset");
    expect(report.reason).toMatch(
      /built under local\/bge-small-zh-v1\.5-f16 \(512 dims\), ov\.conf configures openai\/bge-small-en-v1\.5-f16 \(384 dims\)/,
    );
    expect(existsSync(`${collectionDir()}.pre-reembed-20261007T090000Z`)).toBe(true);
    expect(JSON.parse(readFileSync(join(home, "reembed.json"), "utf8"))).toMatchObject({
      embedder: LOCAL_EN,
      previous: { ...LOCAL, model_identity: LOCAL.model },
      namespaces: { reviewer: { state: "pending" }, companion: { state: "operator" } },
    });
  });

  it("a journal (hosted → built-in local, completed) does not trip the loop guard — a new embedder is a new migration", async () => {
    seedStore(LOCAL);
    writeFileSync(
      join(home, "reembed.json"),
      JSON.stringify({
        version: 1,
        embedder: LOCAL,
        previous: HOSTED,
        reset_at: "2026-09-02T15:30:00.000Z",
        moved_to: `${collectionDir()}.pre-reembed-20260902T153000Z`,
        namespaces: {
          reviewer: { state: "completed" },
          companion: { state: "completed", settled_by: "operator" },
        },
      }),
    );
    const report = await reembed.prepare({
      home,
      conf: enConf(),
      users: ["reviewer", "companion"],
      base: BASE,
      fetchFn: noServer,
      now: () => new Date("2026-10-07T09:00:00.000Z"),
    });
    expect(report.action).toBe("reset");
    expect(reembed.journalStatus(home)).toMatchObject({
      state: "pending",
      embedder: LOCAL_EN,
      awaiting_operator: ["companion"],
    });
  });

  it("the next boot, on the store the new server built, is a no-op", async () => {
    seedStore(LOCAL_EN);
    const report = await reembed.prepare({
      home,
      conf: enConf(),
      users: ["reviewer"],
      base: BASE,
      fetchFn: noServer,
    });
    expect(report.action).toBe("none");
    expect(existsSync(join(home, "reembed.json"))).toBe(false);
  });

  it("rehearse takes the local embedder's --embedder-* flags; a partial set is refused before anything moves", async () => {
    expect(
      reembed.parseArgs([
        "rehearse",
        "--home",
        home,
        "--embedder-python",
        "/v/bin/python",
        "--embedder-script",
        "/s/openviking-embedder.py",
        "--embedder-model",
        LOCAL_EMBEDDING.model,
        "--embedder-file",
        "/m.gguf",
        "--embedder-sha256",
        "a".repeat(64),
        "--embedder-port",
        "19334",
        "--embedder-threads",
        "1",
      ]).embedder,
    ).toMatchObject({ model: LOCAL_EMBEDDING.model, port: 19334, threads: 1 });
    expect(reembed.parseArgs(["rehearse", "--home", home]).embedder).toBeNull();

    seedStore(LOCAL);
    writeFileSync(join(home, "ov.conf"), JSON.stringify(enConf()));
    const lines: string[] = [];
    const code = await reembed.main(
      [
        "rehearse",
        "--home",
        home,
        "--bin",
        "/nonexistent/openviking-server",
        "--port",
        "19333",
        "--embedder-model",
        LOCAL_EMBEDDING.model,
      ],
      { env: {}, log: (l: string) => lines.push(l) },
    );
    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(/the local embedder needs --embedder-python/);
    // Nothing moved: the collection and no journal.
    expect(existsSync(join(collectionDir(), "collection_meta.json"))).toBe(true);
    expect(existsSync(join(home, "reembed.json"))).toBe(false);
  });
});

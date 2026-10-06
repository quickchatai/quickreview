// The TUI's memory store — the [2] tab running on OpenViking.
//
// Three properties are pinned here, and they are the ones the tab's usefulness
// rests on:
//
//   1. BOTH USER KEYS, ONE TIMELINE. The tab holds the reviewer key and the
//      companion key, so companion memory is listed and editable from it. The
//      fake server enforces the SAME confinement the real 0.4.15 does (403
//      across users), so a verb that routed to the wrong key would fail here
//      rather than silently address the wrong tree.
//   2. THE VERB MAPPING. add creates, edit is a batch-write under a hash
//      precondition that refuses cleanly when stale, retire removes the entry
//      from the timeline, pin places it in the pinned area with its tag.
//   3. UNREACHABLE ≠ EMPTY. A store that does not answer must produce an
//      explicit health error, never a bare empty list — an empty tab is
//      indistinguishable from a healthy tab with nothing in it.
import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpFetch } from "../src/openviking/client.js";
import { sha256Prefixed } from "../src/openviking/store.js";
import { refOf } from "../src/memory/store.js";
import {
  MEMORY_USERS,
  type TuiMemoryStore,
  defectEntries,
  keysFileReader,
  nsId,
  parseKeysEnv,
  splitNsId,
  timelineOrder,
  tuiMemoryBaseUrl,
  tuiMemoryStore,
  type MemoryUser,
} from "../src/tui/memory.js";
import { listedFileStat } from "./helpers/ov-listing.js";
import { readRetiredUrisFile } from "../src/memory/ovsession.js";

const KEYS: Record<MemoryUser, string> = {
  reviewer: "cWNy.cmV2aWV3ZXI.reviewer-user-key",
  companion: "cWNy.Y29tcGFuaW9u.companion-user-key",
};

const rootOf = (user: string): string => `viking://user/${user}/memories`;

// ---- a two-user in-memory OpenViking ----------------------------------------

interface HttpResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

function json(status: number, body: unknown): Promise<HttpResponseLike> {
  const raw = JSON.stringify(body);
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(raw),
  });
}

function err(status: number, code: string, message: string): Promise<HttpResponseLike> {
  return json(status, { status: "error", result: null, error: { code, message } });
}

class FakeOpenViking {
  files = new Map<string, string>();
  tags = new Map<string, string[]>();
  /** Directories created through `fs/mkdir` — a namespace root can exist and
   * hold nothing, which is exactly what `ensureNamespaces` produces. */
  dirs = new Set<string>();
  /** Users whose requests should fail as if the server were unreachable. */
  down = new Set<string>();

  seed(user: MemoryUser, name: string, text: string): string {
    const uri = `${rootOf(user)}/experiences/${name}`;
    this.files.set(uri, text);
    return uri;
  }

  readonly fetch: HttpFetch = async (url, init) => {
    const u = new URL(url);
    const path = u.pathname;
    const body: unknown = init.body === undefined ? undefined : JSON.parse(init.body);
    const bearer = (init.headers["Authorization"] ?? "").replace(/^Bearer /, "");
    const owner = (Object.keys(KEYS) as MemoryUser[]).find((k) => KEYS[k] === bearer);
    if (!owner) return err(401, "UNAUTHENTICATED", "no such key");
    if (this.down.has(owner)) throw new Error("connect ECONNREFUSED 127.0.0.1:1933");

    // USER-key confinement, exactly as the real server enforces it: a key may
    // only touch its own user tree, whatever the identity headers claim.
    const uri =
      typeof body === "object" && body !== null && "root_uri" in body
        ? String((body as { root_uri: unknown }).root_uri)
        : (u.searchParams.get("uri") ?? "");
    if (uri !== "" && !uri.startsWith(rootOf(owner)))
      return err(403, "PERMISSION_DENIED", `${owner} may not touch ${uri}`);

    if (path === "/api/v1/fs/ls") return this.ls(u.searchParams.get("uri") ?? "");
    if (path === "/api/v1/content/read") {
      const content = this.files.get(u.searchParams.get("uri") ?? "");
      return content === undefined
        ? err(404, "NOT_FOUND", "no such file")
        : json(200, { status: "ok", result: content });
    }
    if (path === "/api/v1/content/batch-write") return this.batchWrite(body as BatchBody);
    if (path === "/api/v1/fs/mkdir") {
      // 0.4.15 is NOT idempotent here — an existing directory 409s.
      const target = String((body as { uri: unknown }).uri).replace(/\/+$/, "");
      if (this.dirs.has(target)) return err(409, "CONFLICT", `already exists: ${target}`);
      this.dirs.add(target);
      return json(200, { status: "ok", result: { uri: target } });
    }
    if (path === "/api/v1/fs/attrs/set_tags") {
      const req = body as { uri: string; tags: string[] };
      this.tags.set(req.uri, req.tags);
      return json(200, { status: "ok", result: {} });
    }
    return err(404, "NOT_FOUND", `no route ${path}`);
  };

  private ls(uri: string): Promise<HttpResponseLike> {
    const prefix = `${uri.replace(/\/+$/, "")}/`;
    const dirs = new Set<string>();
    const rows: Array<Record<string, unknown>> = [];
    for (const [key, content] of this.files) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const cut = rest.indexOf("/");
      // Size and mtime move with the bytes, as on the real server — the
      // store's sweep is incremental and re-reads only what moved.
      if (cut < 0) rows.push({ uri: key, name: rest, isDir: false, ...listedFileStat(content) });
      else dirs.add(rest.slice(0, cut));
    }
    for (const dir of dirs)
      rows.push({
        uri: `${prefix}${dir}`,
        name: dir,
        isDir: true,
        size: 0,
        modTime: "2026-08-20T15:30:00.000Z",
      });
    return json(200, { status: "ok", result: rows });
  }

  private batchWrite(req: BatchBody): Promise<HttpResponseLike> {
    for (const op of req.operations) {
      const existing = this.files.get(op.uri);
      if (op.precondition.kind === "create_if_absent" && existing !== undefined)
        return err(409, "CONFLICT", "target already exists");
      if (op.precondition.kind === "replace_if_hash") {
        if (existing === undefined) return err(404, "NOT_FOUND", "no such file");
        if (sha256Prefixed(existing) !== op.precondition.base_hash)
          return err(409, "CONFLICT", "content hash changed");
      }
    }
    const created: string[] = [];
    const updated: string[] = [];
    for (const op of req.operations) {
      (this.files.has(op.uri) ? updated : created).push(op.uri);
      this.files.set(op.uri, op.content);
    }
    return json(200, {
      status: "ok",
      result: { root_uri: req.root_uri, created, updated, unchanged: [] },
    });
  }
}

interface BatchBody {
  root_uri: string;
  operations: Array<{
    uri: string;
    content: string;
    precondition: { kind: string; base_hash?: string };
  }>;
  wait: boolean;
}

const NOW = new Date("2026-08-20T15:30:00.000Z");

function wire(
  server: FakeOpenViking,
  keys: Partial<Record<string, string>> = {
    OPENVIKING_REVIEWER_KEY: KEYS.reviewer,
    OPENVIKING_COMPANION_KEY: KEYS.companion,
  },
): TuiMemoryStore {
  return tuiMemoryStore({
    baseUrl: "http://127.0.0.1:1933",
    fetchFn: server.fetch,
    key: (name) => keys[name] ?? null,
    keysFile: "/home/user/.config/quickreview-bot/openviking-keys.env",
    now: () => NOW,
  });
}

// ---- the tests ---------------------------------------------------------------

describe("TuiMemoryStore — both user trees", () => {
  let server: FakeOpenViking;

  beforeEach(() => {
    server = new FakeOpenViking();
    server.seed(
      "reviewer",
      "20260819T181354-aaaa1111.md",
      "#false-positive [[pr-5308]] compare transforms with the merge base first.",
    );
    server.seed(
      "reviewer",
      "20260820T090142-bbbb2222.md",
      "#bug #operations guard 2 suppressed a same-head substantive review.",
    );
    server.seed(
      "companion",
      "20260820T101500-cccc3333.md",
      "#manual remind me the deploy is still pending.",
    );
  });

  it("lists every entry from BOTH trees, ids namespaced by user", async () => {
    const store = wire(server);
    const entries = await store.read();
    expect(entries.map((e) => e.id)).toEqual([
      "reviewer:experiences/20260819T181354-aaaa1111.md",
      "reviewer:experiences/20260820T090142-bbbb2222.md",
      "companion:experiences/20260820T101500-cccc3333.md",
    ]);
    expect(store.health().ok).toBe(true);
    expect(store.health().error).toBeUndefined();
    expect(splitNsId(entries[2]!.id)).toEqual({
      user: "companion",
      id: "experiences/20260820T101500-cccc3333.md",
    });
    expect(nsId("companion", "a/b.md")).toBe("companion:a/b.md");
    expect(MEMORY_USERS).toEqual(["reviewer", "companion"]);
  });

  // the TUI's candidate sweeper and memory tab read BOTH trees
  // every few minutes with no sweep cache (`cacheTtlMs: 0`). With the
  // incremental sweep a poll of an unchanged store lists and reads nothing.
  it("a repeat read lists both trees but re-reads only what changed", async () => {
    const store = wire(server);
    const readsOf = (user: MemoryUser) => store.requestCounts()[`${user}/read`]?.total ?? 0;
    await store.read();
    expect(readsOf("reviewer")).toBe(2);
    expect(readsOf("companion")).toBe(1);
    await store.read();
    expect(readsOf("reviewer")).toBe(2);
    expect(readsOf("companion")).toBe(1);
    server.seed("reviewer", "20260821T000000-dddd4444.md", "#adjudication a new one");
    const after = await store.read();
    expect(readsOf("reviewer")).toBe(3);
    expect(readsOf("companion")).toBe(1);
    expect(after.map((e) => e.text)).toContain("#adjudication a new one");
  });

  it("edits COMPANION memory — the verb routes to the companion key, which the server confines", async () => {
    const store = wire(server);
    const before = await store.read();
    const target = before.find((e) => e.id.startsWith("companion:"))!;
    const res = await store.apply({
      op: "edit",
      ...refOf(target),
      text: "#manual the deploy shipped.",
    });
    expect(res.ok).toBe(true);
    const after = await store.read();
    expect(after.find((e) => e.id === target.id)!.text).toBe("#manual the deploy shipped.");
    // Nothing was written into the reviewer tree by mistake.
    expect([...server.files.keys()].filter((u) => u.includes("/user/reviewer/"))).toHaveLength(2);
  });

  it("add creates a NEW entry in the reviewer tree (memory the review system reads)", async () => {
    const store = wire(server);
    const res = await store.apply({
      op: "add",
      text: "always check the migration number at the merge base.",
    });
    expect(res.ok).toBe(true);
    const entries = await store.read();
    const fresh = entries.find((e) => e.text.includes("migration number"))!;
    expect(fresh.id.startsWith("reviewer:")).toBe(true);
    expect(fresh.tags).toContain("manual"); // `add` = the owner's own words
  });

  it("edit under a STALE hash refuses cleanly and leaves the entry untouched", async () => {
    const store = wire(server);
    const [entry] = await store.read();
    const stale = refOf(entry!);
    // Someone else writes first (a live session's own memory write holds no lock).
    await store.apply({
      op: "edit",
      ...stale,
      text: "#false-positive rewritten by another writer.",
    });
    const res = await store.apply({ op: "edit", ...stale, text: "my edit, based on what I read." });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/changed since you read it/);
    const after = await store.read();
    expect(after.find((e) => e.id === entry!.id)!.text).toBe(
      "#false-positive rewritten by another writer.",
    );
  });

  it("retire removes the entry from the timeline; pin places it in the pinned area with its tag", async () => {
    const store = wire(server);
    const start = await store.read();
    const bug = start.find((e) => e.text.includes("guard 2"))!;
    expect((await store.apply({ op: "pin", ...refOf(bug) })).ok).toBe(true);
    let entries = await store.read();
    const pinned = entries.find((e) => e.id === bug.id)!;
    expect(pinned.pinned).toBe(true);
    expect(pinned.tags).toContain("pinned");
    expect(timelineOrder(entries)[0]!.id).toBe(bug.id); // pinned float to the head

    const other = entries.find((e) => e.id.startsWith("companion:"))!;
    expect((await store.apply({ op: "retire", ...refOf(other) })).ok).toBe(true);
    entries = await store.read();
    expect(entries.some((e) => e.id === other.id)).toBe(false);

    expect(
      (await store.apply({ op: "unpin", ...refOf(entries.find((e) => e.id === bug.id)!) })).ok,
    ).toBe(true);
    expect((await store.read()).find((e) => e.id === bug.id)!.pinned).toBe(false);
  });

  it("a verb addressed at no known namespace is refused, not misrouted", async () => {
    const store = wire(server);
    const res = await store.apply({
      op: "retire",
      id: "experiences/orphan.md",
      ts: "2026-08-20 09:00:00",
      block: 0,
      expect: `sha256:${"0".repeat(64)}`,
    });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/names no memory namespace/);
  });

  it("search filters the merged timeline by tag and text", async () => {
    const store = wire(server);
    expect((await store.search("", { tag: "bug" })).map((e) => e.id)).toEqual([
      "reviewer:experiences/20260820T090142-bbbb2222.md",
    ]);
    expect((await store.search("deploy")).map((e) => e.id)).toEqual([
      "companion:experiences/20260820T101500-cccc3333.md",
    ]);
    expect(defectEntries(await store.read()).map((e) => e.text)).toEqual([
      "#bug #operations guard 2 suppressed a same-head substantive review.",
    ]);
  });

  it("finds `kind=bug` event-tagged defects too — the auto-filer's query is by TAG", async () => {
    server.seed(
      "reviewer",
      "20260820T120000-dddd4444.md",
      "#feedback kind=bug pr=5312 signal=review_dismissed the recheck misfired.",
    );
    const store = wire(server);
    const defects = defectEntries(await store.read());
    expect(defects).toHaveLength(2);
    // Prose that merely mentions a bug is not a defect flag.
    server.seed(
      "reviewer",
      "20260820T130000-eeee5555.md",
      "the author says this is a bug in their own code.",
    );
    expect(defectEntries(await store.read())).toHaveLength(2);
  });

  it("a `#bug` QUOTED inside feedback prose is data, not a defect flag — header tags only", async () => {
    server.seed(
      "reviewer",
      "20260820T140000-ffff6666.md",
      '#feedback kind=feedback pr=5312 signal=comment "please drop the #bug nit"',
    );
    const store = wire(server);
    expect(defectEntries(await store.read()).map((e) => e.text)).toEqual([
      "#bug #operations guard 2 suppressed a same-head substantive review.",
    ]);
  });
});

// S3 (review): the companion's own recall (the vendored extension)
// excludes retired entries by a published list, and no daemon sweeps the
// companion's tree — the TUI's store does, and publishes it into the state
// home the companion mounts (`MEMORY.retiredFile`, `QCR_OV_RETIRED_FILE`).
describe("TuiMemoryStore — the companion tree's retired list", () => {
  it("publishes the companion tree's retired URIs, keeps them up to date, and never wipes them on an outage", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qcr-tui-retired-"));
    try {
      const file = join(dir, "openviking", "companion-retired-uris.json");
      const server = new FakeOpenViking();
      server.seed("reviewer", "20260819T000000-r.md", "#retired a reviewer lesson");
      const old = server.seed("companion", "20260819T000000-a.md", "#retired an old note");
      server.seed("companion", "20260820T000000-b.md", "#manual a live note");
      const build = () =>
        tuiMemoryStore({
          baseUrl: "http://127.0.0.1:1933",
          fetchFn: server.fetch,
          key: (name) =>
            ({ OPENVIKING_REVIEWER_KEY: KEYS.reviewer, OPENVIKING_COMPANION_KEY: KEYS.companion })[
              name
            ] ?? null,
          keysFile: "/home/user/.config/qcr-operator/default/openviking-keys.env",
          now: () => NOW,
          retiredFiles: { companion: file },
        });
      const store = build();
      const entries = await store.read();
      // Only the companion tree's list, and only where it was asked for.
      expect(readRetiredUrisFile(file)).toEqual([old]);
      // A retire through the TUI reaches the file at once.
      const live = entries.find((e) => e.id.startsWith("companion:"))!;
      expect((await store.apply({ op: "retire", ...refOf(live) })).ok).toBe(true);
      const both = [old, `${rootOf("companion")}/experiences/20260820T000000-b.md`].sort();
      expect(readRetiredUrisFile(file)).toEqual(both);
      // A restarted TUI whose forward is not up yet: its first sweep fails
      // and the file the last one wrote stands.
      server.down.add("companion");
      await build().read();
      expect(readRetiredUrisFile(file)).toEqual(both);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("TuiMemoryStore — unreachable is not empty", () => {
  let server: FakeOpenViking;

  beforeEach(() => {
    server = new FakeOpenViking();
    server.seed("reviewer", "20260820T090142-bbbb2222.md", "#bug guard 2 suppressed a review.");
    server.seed("companion", "20260820T101500-cccc3333.md", "#manual the deploy is pending.");
  });

  it("a dead forward yields an EXPLICIT error naming the endpoint and the unit", async () => {
    server.down = new Set(["reviewer", "companion"]);
    const store = wire(server);
    expect(await store.read()).toEqual([]);
    const health = store.health();
    expect(health.ok).toBe(false);
    expect(health.error).toBeDefined();
    expect(health.error).toContain("http://127.0.0.1:1933");
    expect(health.error).toContain("qcr-memory-forward");
  });

  it("a healthy but EMPTY store reports no error at all — the two states never look alike", async () => {
    const empty = new FakeOpenViking();
    const store = wire(empty);
    expect(await store.read()).toEqual([]);
    expect(store.health().ok).toBe(true);
    expect(store.health().error).toBeUndefined();
    expect(store.health().warning).toBeUndefined();
  });

  it("a missing key is an error that names the env var to add, not silence", async () => {
    const store = wire(server, {});
    expect(await store.read()).toEqual([]);
    const health = store.health();
    expect(health.error).toContain("OPENVIKING_REVIEWER_KEY");
    expect(health.error).toContain("openviking-keys.env");
  });

  it("a missing key STAYS an error on every refresh — the client's once-only gap never turns into a healthy empty store", async () => {
    const store = wire(server, {});
    // Startup namespace preparation can spend the client's single no_key gap.
    await store.ensureNamespaces();
    for (let i = 0; i < 3; i++) {
      expect(await store.read()).toEqual([]);
      const health = store.health();
      expect(health.ok).toBe(false);
      expect(health.error).toContain("OPENVIKING_REVIEWER_KEY");
    }
  });

  it("one tree down = a WARNING beside the other tree's entries, never a wiped timeline", async () => {
    server.down = new Set(["companion"]);
    const store = wire(server);
    const entries = await store.read();
    expect(entries.map((e) => e.id)).toEqual(["reviewer:experiences/20260820T090142-bbbb2222.md"]);
    const health = store.health();
    expect(health.ok).toBe(false);
    expect(health.error).toBeUndefined(); // not the hard state — reviewer answered
    expect(health.warning).toContain("companion memory unreachable");
  });

  it("recovers: health flips back once the store answers again", async () => {
    server.down = new Set(["reviewer", "companion"]);
    const store = wire(server);
    await store.read();
    expect(store.health().error).toBeDefined();
    server.down = new Set();
    await store.read();
    expect(store.health().ok).toBe(true);
    expect(store.health().error).toBeUndefined();
  });

  it("a write against a dead store resolves as a refusal and marks the namespace down", async () => {
    const store = wire(server);
    const [entry] = await store.read();
    server.down = new Set(["reviewer", "companion"]);
    const res = await store.apply({ op: "retire", ...refOf(entry!) });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/memory write failed/);
    expect(store.health().ok).toBe(false);
  });
});

// follow-up, 2026-08-21 — the companion wrote nothing for a day
// because `viking://user/companion` did not exist as a DIRECTORY, so the pi
// extension's namespace resolver could not see the namespace and fell back to
// `user/default`. The TUI is where this gets fixed: it is the one surface
// holding both user keys, and it starts the companion container itself.
describe("TuiMemoryStore — materializing both namespaces", () => {
  let server: FakeOpenViking;
  beforeEach(() => {
    server = new FakeOpenViking();
  });

  it("creates the memory root for EVERY namespace, not just the one it writes to", async () => {
    const store = wire(server);
    expect(await store.ensureNamespaces()).toEqual([]);
    // The companion's is the one that was missing in the live incident; the
    // reviewer's has to be covered too, or a fresh server strands the daemon.
    for (const user of MEMORY_USERS) {
      expect(server.dirs.has(`${rootOf(user)}/experiences`)).toBe(true);
    }
  });

  it("is safe to call again — an existing root is not an error", async () => {
    const store = wire(server);
    await store.ensureNamespaces();
    expect(await wire(server).ensureNamespaces()).toEqual([]);
  });

  it("names the namespace it could not prepare, and never throws", async () => {
    const server2 = new FakeOpenViking();
    server2.down.add("companion");
    const notes = await wire(server2).ensureNamespaces();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/^companion: /);
    // The reviewer half still got done — one dead namespace is not both.
    expect(server2.dirs.has(`${rootOf("reviewer")}/experiences`)).toBe(true);
  });

  it("reports the namespace whose key is missing rather than silently skipping it", async () => {
    // No companion key: the server refuses, and the operator must be told
    // which namespace is unprepared — this is the state the machine was in.
    const store = wire(server, { OPENVIKING_REVIEWER_KEY: KEYS.reviewer });
    const notes = await store.ensureNamespaces();
    expect(notes.join(" ")).toMatch(/companion/);
  });
});

describe("keys and endpoint", () => {
  it("parses the docker env-file the forward and the companion share", () => {
    const parsed = parseKeysEnv(
      [
        "OPENVIKING_API_KEY=abc",
        'export OPENVIKING_COMPANION_KEY="abc"',
        "OPENVIKING_REVIEWER_KEY='def'",
        "# a comment",
        "EMPTY=",
      ].join("\n"),
    );
    expect(parsed).toEqual({
      OPENVIKING_API_KEY: "abc",
      OPENVIKING_COMPANION_KEY: "abc",
      OPENVIKING_REVIEWER_KEY: "def",
    });
  });

  it("re-reads the keys file when it appears later — no TUI restart to provision a key", () => {
    const dir = mkdtempSync(join(tmpdir(), "ovkeys-"));
    const path = join(dir, "openviking-keys.env");
    let clock = 0;
    const read = keysFileReader(path, 1000, () => clock);
    expect(read("OPENVIKING_REVIEWER_KEY")).toBeNull();
    writeFileSync(path, "OPENVIKING_REVIEWER_KEY=later\n");
    expect(read("OPENVIKING_REVIEWER_KEY")).toBeNull(); // still inside the ttl
    clock += 2000;
    expect(read("OPENVIKING_REVIEWER_KEY")).toBe("later");
    rmSync(dir, { recursive: true, force: true });
  });

  it("defaults to the memory forward's loopback listener, overridable by env", () => {
    expect(tuiMemoryBaseUrl({})).toBe("http://127.0.0.1:1933");
    expect(tuiMemoryBaseUrl({ QCR_MEMORY_PORT: "2933" })).toBe("http://127.0.0.1:2933");
    expect(tuiMemoryBaseUrl({ QCR_MEMORY_URL: "http://198.51.100.1:1933/" })).toBe(
      "http://198.51.100.1:1933",
    );
  });
});

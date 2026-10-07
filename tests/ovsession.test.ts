// the PR session's OpenViking identity and its raw-notes session.
//
// No server, no HTTP, no pi: the lifecycle runs against a fake `OvSessionApi`,
// and the two-tier proof runs the REAL `OpenVikingClient` against a fake fetch
// that models the server's verified behaviour: a session is a
// tree of its own, and the search corpus is the MEMORIES tree only.
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DISABLED_MEMORY_POLICY, OpenVikingClient } from "../src/openviking/client.js";
import {
  OV_REVIEWER_USER,
  keyChangeWatcher,
  openVikingSessionEnv,
  openVikingSessionLifecycle,
  ovSessionIdForPr,
  ovcliConfPathIn,
  ovRecallHintPathIn,
  ovRetiredPathIn,
  OV_SESSION_SWEEP_MAX,
  planStaleOvSessions,
  prOfOvSessionId,
  readOvcliKey,
  readRetiredUrisFile,
  readServerRootKey,
  renderOvcliConf,
  writeOvcliConf,
  writeRecallHint,
  writeRetiredUris,
} from "../src/memory/ovsession.js";
import { readRetiredUris } from "../extensions/vendor/openviking-pi/qcr-recall.js";
import { readRecallHint } from "../extensions/vendor/openviking-pi/qcr-hint.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-ovsession-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("session ids", () => {
  it("names a PR's raw tier after the PR", () => {
    expect(ovSessionIdForPr(5263)).toBe("pr-5263");
  });
});

describe("lifecycle", () => {
  const api = (
    outcomes: Record<string, { ok: boolean; status: number; conflict?: boolean }>,
    calls: string[] = [],
  ) => ({
    calls,
    createSession: async (id: string) => {
      calls.push(`create ${id}`);
      return outcomes["create"] ?? { ok: true, status: 200 };
    },
    deleteSession: async (id: string) => {
      calls.push(`delete ${id}`);
      return outcomes["delete"] ?? { ok: true, status: 200 };
    },
  });

  it("creates and deletes the PR's session", async () => {
    const fake = api({});
    const life = openVikingSessionLifecycle(fake);
    expect(await life.create("pr-7")).toBe(true);
    expect(await life.remove("pr-7")).toBe(true);
    expect(fake.calls).toEqual(["create pr-7", "delete pr-7"]);
  });

  it("treats an existing session as created — a respawned pi keeps its notes", async () => {
    const life = openVikingSessionLifecycle(
      api({ create: { ok: false, status: 409, conflict: true } }),
    );
    expect(await life.create("pr-7")).toBe(true);
  });

  it("a BUSY 409 is not 'already there' — nothing was created (S2)", async () => {
    const logs: string[] = [];
    const busy = openVikingSessionLifecycle(
      {
        ...api({}),
        createSession: async () => ({ ok: false, status: 409, conflict: false, busy: true }),
      },
      { log: (m) => logs.push(m) },
    );
    expect(await busy.create("pr-7")).toBe(false);
    expect(logs.join("\n")).not.toContain("already exists — reusing it");
    expect(logs.join("\n")).toContain("could not create session pr-7");
    // A plain 409 (no busy flag — an older client's answer) is still a reuse.
    const plain = openVikingSessionLifecycle(api({ create: { ok: false, status: 409 } }));
    expect(await plain.create("pr-7")).toBe(true);
  });

  it("treats a missing session as deleted — 404 is the desired end state", async () => {
    const life = openVikingSessionLifecycle(api({ delete: { ok: false, status: 404 } }));
    expect(await life.remove("pr-7")).toBe(true);
  });

  it("never throws and never hangs — memory can never block a round", async () => {
    const logs: string[] = [];
    const life = openVikingSessionLifecycle(
      {
        createSession: () => Promise.reject(new Error("connection refused")),
        // Never settles: the deadline is what makes this total.
        deleteSession: () => new Promise(() => {}),
      },
      { timeoutMs: 10, log: (m) => logs.push(m) },
    );
    expect(await life.create("pr-7")).toBe(false);
    expect(await life.remove("pr-7")).toBe(false);
    expect(logs.join("\n")).toContain("pr-7");
  });
});

describe("ovcli.conf", () => {
  it("carries url + user + key, and no peer id (the peer is per-session)", () => {
    const body = renderOvcliConf({
      url: "http://127.0.0.1:1933/",
      apiKey: "k",
      user: OV_REVIEWER_USER,
    });
    expect(JSON.parse(body)).toEqual({
      url: "http://127.0.0.1:1933",
      user: "reviewer",
      api_key: "k",
    });
    expect(body).not.toContain("peer");
  });

  it("writes 0600 and reports that a key landed", () => {
    const path = ovcliConfPathIn(join(dir, "pihome"));
    const res = writeOvcliConf(path, {
      url: "http://x:1933",
      apiKey: "reviewer-key",
      user: "reviewer",
    });
    expect(res).toMatchObject({ written: true, keyed: true, reason: "" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8")).api_key).toBe("reviewer-key");
  });

  it("drops a key that IS the server's root key — never a root or admin identity", () => {
    const ovConf = join(dir, "ov.conf");
    writeFileSync(ovConf, JSON.stringify({ server: { root_api_key: "ROOT" } }));
    expect(readServerRootKey(ovConf)).toBe("ROOT");

    const logs: string[] = [];
    const path = ovcliConfPathIn(join(dir, "pihome"));
    const res = writeOvcliConf(
      path,
      { url: "http://x:1933", apiKey: "ROOT", user: "reviewer" },
      { serverConfigPath: ovConf, log: (m) => logs.push(m) },
    );
    expect(res.keyed).toBe(false);
    expect(res.reason).toBe("root-key-refused");
    expect(readFileSync(path, "utf8")).not.toContain("ROOT");
    expect(logs.join("\n")).toContain("REFUSED");
  });

  it("an unreadable ov.conf is not an excuse to skip the check's fail-safe", () => {
    // No root key readable ⇒ nothing to compare against, so a normal key is
    // written as normal. (The fork's own withoutRootKey() is the second layer.)
    const path = ovcliConfPathIn(join(dir, "pihome"));
    const res = writeOvcliConf(
      path,
      { url: "http://x:1933", apiKey: "k", user: "reviewer" },
      { serverConfigPath: join(dir, "missing.conf") },
    );
    expect(res.keyed).toBe(true);
  });
});

describe("session environment", () => {
  it("carries the identity and never a credential", () => {
    const env = openVikingSessionEnv({
      baseUrl: "http://127.0.0.1:1933",
      peerId: "pr-42",
      cliConfigPath: "/home/review/.openviking/ovcli.conf",
      serverConfigPath: "/opt/quickreview/state/openviking/ov.conf",
      ovSessionId: "pr-42",
    });
    expect(env).toEqual({
      OPENVIKING_URL: "http://127.0.0.1:1933",
      OPENVIKING_BASE_URL: "http://127.0.0.1:1933",
      OPENVIKING_USER: "reviewer",
      OPENVIKING_PEER_ID: "pr-42",
      OPENVIKING_CLI_CONFIG_FILE: "/home/review/.openviking/ovcli.conf",
      OPENVIKING_CONFIG_FILE: "/opt/quickreview/state/openviking/ov.conf",
      // The QCR_ spelling, because only prefixed vars ride the tmux argv.
      QCR_OV_SESSION_ID: "pr-42",
    });
    expect(Object.keys(env).some((k) => /KEY|TOKEN|SECRET/i.test(k))).toBe(false);
  });

  it("names the retired-URIs file the extension's recall excludes by (S3)", () => {
    const env = openVikingSessionEnv({
      baseUrl: "http://h:1933",
      peerId: "pr-42",
      cliConfigPath: "/home/review/.openviking/ovcli.conf",
      retiredFile: "/home/review/.openviking/retired-uris.json",
    });
    expect(env.QCR_OV_RETIRED_FILE).toBe("/home/review/.openviking/retired-uris.json");
    expect(
      openVikingSessionEnv({ baseUrl: "http://h:1933", peerId: "p", cliConfigPath: "/c" })
        .QCR_OV_RETIRED_FILE,
    ).toBeUndefined();
  });

  it("omits the session id when there is no raw tier (the overseer)", () => {
    const env = openVikingSessionEnv({
      baseUrl: "http://h:1933",
      peerId: "overseer",
      cliConfigPath: "/c",
    });
    expect(env.QCR_OV_SESSION_ID).toBeUndefined();
    expect(env.OPENVIKING_PEER_ID).toBe("overseer");
  });
});

// ---- the two tiers, against a fake server ---------------------------------

/**
 * A fake OpenViking modelling the two facts this ticket rests on (both
 * verified against a running v0.4.15):
 *
 *   * a session is a tree of its own — session content is written and read
 *     under `/api/v1/sessions/…` and is ABSENT from the search corpus;
 *   * `DELETE /api/v1/sessions/<id>` removes the session's messages and its
 *     archives.
 *
 * Search therefore answers out of the memories map only. If a future change
 * ever routed round notes into the memories tree instead, this test fails.
 */
function fakeServer() {
  const sessions = new Map<string, { policy: unknown; notes: string[] }>();
  const memories = new Map<string, string>();
  const fetchFn = async (url: string, init: { method: string; body?: string }) => {
    const body = init.body ? (JSON.parse(init.body) as Record<string, any>) : {};
    const ok = (result: unknown) => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ status: "ok", result }),
    });
    if (url.endsWith("/api/v1/sessions") && init.method === "POST") {
      sessions.set(body["session_id"], { policy: body["memory_policy"], notes: [] });
      return ok({ session_id: body["session_id"] });
    }
    // The server's list shape (session_service.py `sessions()`).
    if (url.endsWith("/api/v1/sessions") && init.method === "GET") {
      return ok(
        [...sessions.keys()].map((id) => ({
          session_id: id,
          uri: `viking://user/reviewer/sessions/${id}`,
          is_dir: true,
          mod_time: "2026-08-25T10:00:00Z",
        })),
      );
    }
    if (url.includes("/api/v1/sessions/") && init.method === "DELETE") {
      const id = decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));
      const existed = sessions.delete(id);
      return existed
        ? ok({})
        : {
            ok: false,
            status: 404,
            text: async () =>
              JSON.stringify({
                status: "error",
                error: { code: "NOT_FOUND", message: "no such session" },
              }),
          };
    }
    if (url.endsWith("/api/v1/search/search")) {
      const q = String(body["query"] ?? "").toLowerCase();
      const entries = [...memories.entries()]
        .filter(([, text]) => text.toLowerCase().includes(q))
        .map(([uri, text]) => ({
          uri,
          text,
          score: 1,
          category: "experiences",
          detail: "full",
          origin: "memories",
        }));
      return ok({
        entries,
        rendered: entries.map((e) => e.text).join("\n"),
        digest: "",
        stats: {},
      });
    }
    return {
      ok: false,
      status: 404,
      text: async () =>
        JSON.stringify({ status: "error", error: { code: "NOT_FOUND", message: url } }),
    };
  };
  return { sessions, memories, fetchFn };
}

describe("the raw tier is not the durable tier", () => {
  it("creates the session with extraction fully disabled", async () => {
    const server = fakeServer();
    const client = new OpenVikingClient({
      baseUrl: "http://127.0.0.1:1933",
      apiKey: "reviewer-key",
      fetchFn: server.fetchFn,
    });
    expect(await openVikingSessionLifecycle(client).create(ovSessionIdForPr(42))).toBe(true);

    // Self, peer and working memory ALL off: our deployment configures no vlm,
    // so any enabled policy would queue an extraction task that always fails.
    expect(server.sessions.get("pr-42")!.policy).toEqual(DISABLED_MEMORY_POLICY);
    expect(DISABLED_MEMORY_POLICY).toEqual({
      self: { enabled: false },
      peer: { enabled: false },
      working_memory: { enabled: false },
    });
  });

  it("round notes in the session are NOT returned by a memory search", async () => {
    const server = fakeServer();
    const client = new OpenVikingClient({
      baseUrl: "http://127.0.0.1:1933",
      apiKey: "reviewer-key",
      fetchFn: server.fetchFn,
    });
    await openVikingSessionLifecycle(client).create("pr-42");
    // What the session's turn sync puts in the raw tier…
    server.sessions.get("pr-42")!.notes.push("round 2 scratch: the retry lives in HTTPAdapter");
    // …versus what the durable tier holds.
    server.memories.set(
      "viking://user/reviewer/memories/experiences/retry.md",
      "retry policy is set centrally",
    );

    const hit = await client.searchContext("retry");
    expect(hit.ok).toBe(true);
    if (!hit.ok) return;
    expect(hit.result.entries.map((e) => e.uri)).toEqual([
      "viking://user/reviewer/memories/experiences/retry.md",
    ]);
    expect(hit.result.rendered).not.toContain("round 2 scratch");
  });

  it("closing the PR deletes the session and its archives", async () => {
    const server = fakeServer();
    const client = new OpenVikingClient({
      baseUrl: "http://127.0.0.1:1933",
      apiKey: "reviewer-key",
      fetchFn: server.fetchFn,
    });
    const life = openVikingSessionLifecycle(client);
    await life.create("pr-42");
    expect(await life.remove("pr-42")).toBe(true);
    expect(server.sessions.has("pr-42")).toBe(false);
    // Idempotent: a second close finds nothing left and is still a success.
    expect(await life.remove("pr-42")).toBe(true);
  });

  it("never calls commit — the raw tier ages out by DELETE", () => {
    // `commit` exists to PROMOTE session content into durable memories, i.e.
    // exactly the extraction this deployment switched off. Structural check:
    // no daemon-side module has a commit call to make.
    const client = new OpenVikingClient({
      baseUrl: "http://h:1933",
      apiKey: "k",
    }) as unknown as Record<string, unknown>;
    expect(typeof client["commitSession"]).toBe("undefined");
    const src = readFileSync(
      join(import.meta.dirname, "..", "src", "memory", "ovsession.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/commitSession|\/commit/);
  });
});

describe("the pi HOME layout", () => {
  it("puts ovcli.conf where the fork's resolver looks by default", () => {
    mkdirSync(join(dir, "pihome"), { recursive: true });
    expect(ovcliConfPathIn(join(dir, "pihome"))).toBe(
      join(dir, "pihome", ".openviking", "ovcli.conf"),
    );
  });
});

// the sessions' credential is JUDGED (read back and probed), not
// assumed to equal the daemon's; and a key change reaches the sessions.
describe("readOvcliKey — what the sessions are actually handed", () => {
  it("reads the key writeOvcliConf wrote", () => {
    const path = ovcliConfPathIn(dir);
    writeOvcliConf(path, {
      url: "http://127.0.0.1:1933",
      apiKey: "sess-key-123456",
      user: "reviewer",
    });
    expect(readOvcliKey(path)).toEqual({ state: "key", key: "sess-key-123456" });
  });

  it("a file written with no key reads as an empty key (sessions run keyless)", () => {
    const path = ovcliConfPathIn(dir);
    writeOvcliConf(path, { url: "http://127.0.0.1:1933", apiKey: "", user: "reviewer" });
    expect(readOvcliKey(path)).toEqual({ state: "key", key: "" });
  });

  it("no file yet is ABSENT (no session born), a torn file is UNREADABLE", () => {
    expect(readOvcliKey(join(dir, "nope", "ovcli.conf"))).toEqual({ state: "absent" });
    const torn = join(dir, "ovcli.conf");
    writeFileSync(torn, "{ not json");
    expect(readOvcliKey(torn)).toEqual({ state: "unreadable", detail: "ovcli.conf is not JSON" });
  });
});

describe("keyChangeWatcher — a rotated daemon key reaches the sessions", () => {
  it("fires on a change, never on the first sighting or a repeat", () => {
    let fired = 0;
    const watch = keyChangeWatcher(() => {
      fired += 1;
    });
    expect(watch("key-A")).toBe(false); // first sighting only records
    expect(watch("key-A")).toBe(false);
    expect(watch("key-B")).toBe(true);
    expect(fired).toBe(1);
  });

  it("a key that disappears does not fire; one that (re)appears does", () => {
    let fired = 0;
    const watch = keyChangeWatcher(() => {
      fired += 1;
    });
    watch(null);
    expect(watch("key-A")).toBe(true);
    expect(watch(null)).toBe(false);
    expect(watch("key-A")).toBe(true);
    expect(fired).toBe(2);
  });
});

// ---- S3: the retired list and the stale-session sweep --------------

describe("the retired-URIs file (S3)", () => {
  it("lives beside ovcli.conf and round-trips into what the extension's recall reads", () => {
    const home = join(dir, "pihome");
    const path = ovRetiredPathIn(home);
    expect(path).toBe(join(home, ".openviking", "retired-uris.json"));
    const uris = [
      "viking://user/reviewer/memories/experiences/a.md",
      "viking://user/reviewer/memories/experiences/b.md",
    ];
    expect(writeRetiredUris(path, uris, { now: () => new Date("2026-10-06T12:00:00Z") })).toBe(
      true,
    );
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      uris,
      written_at: "2026-10-06T12:00:00.000Z",
    });
    // The DAEMON's writer and the EXTENSION's reader agree on the shape.
    expect(readRetiredUris(path)).toEqual(uris);
    // Rewritten whole: an emptied list is published as empty.
    writeRetiredUris(path, []);
    expect(readRetiredUris(path)).toEqual([]);
  });

  it("a disk that refuses costs the list, never a throw", () => {
    const blocker = join(dir, "file");
    writeFileSync(blocker, "x");
    const logs: string[] = [];
    expect(
      writeRetiredUris(join(blocker, "sub", "retired-uris.json"), ["viking://x"], {
        log: (m) => logs.push(m),
      }),
    ).toBe(false);
    expect(logs.join(" ")).toContain("could not publish the retired list");
  });

  it("reads back what was published — the seed a restarted store starts from — and null for nothing to protect", () => {
    const path = join(dir, "pihome", ".openviking", "retired-uris.json");
    expect(readRetiredUrisFile(path)).toBeNull(); // no file yet
    const uris = [
      "viking://user/reviewer/memories/experiences/a.md",
      "viking://user/reviewer/memories/experiences/b.md",
    ];
    writeRetiredUris(path, [...uris, uris[0]!]);
    expect(readRetiredUrisFile(path)).toEqual(uris);
    writeRetiredUris(path, []);
    expect(readRetiredUrisFile(path)).toEqual([]);
    writeFileSync(path, "{ not json");
    expect(readRetiredUrisFile(path)).toBeNull();
    writeFileSync(path, JSON.stringify({ uris: ["/etc/passwd", 7, "viking://user/x.md"] }));
    expect(readRetiredUrisFile(path)).toEqual(["viking://user/x.md"]);
  });
});

// ---- S5: the PR session's recall hint ---------------------------------

describe("the recall hint (S5)", () => {
  it("lives beside ovcli.conf, one file per PR session, and round-trips into what the extension reads", () => {
    const home = join(dir, "pihome");
    const path = ovRecallHintPathIn(home, "pr-42");
    expect(path).toBe(join(home, ".openviking", "recall-hints", "pr-42.json"));
    const query = "fix(auth): redirect login — backend/appquickreview .py";
    expect(
      writeRecallHint(
        path,
        { query, areas: ["experiences"] },
        { now: () => new Date("2026-10-07T12:00:00Z") },
      ),
    ).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      query,
      areas: ["experiences"],
      written_at: "2026-10-07T12:00:00.000Z",
    });
    // The DAEMON's writer and the EXTENSION's reader agree on the shape.
    expect(readRecallHint(path)).toEqual({ query, areas: ["experiences"] });
    // Rewritten whole at the next round.
    writeRecallHint(path, { query: "another round", areas: ["experiences"] });
    expect(readRecallHint(path)?.query).toBe("another round");
  });

  it("a disk that refuses costs the hint, never a throw", () => {
    const blocker = join(dir, "file");
    writeFileSync(blocker, "x");
    const logs: string[] = [];
    expect(
      writeRecallHint(
        join(blocker, "sub", "pr-1.json"),
        { query: "q", areas: ["experiences"] },
        {
          log: (m) => logs.push(m),
        },
      ),
    ).toBe(false);
    expect(logs.join(" ")).toContain("could not publish the recall hint");
  });

  it("is named on a PR session's environment only", () => {
    const pr = openVikingSessionEnv({
      baseUrl: "http://h:1933",
      peerId: "pr-42",
      cliConfigPath: "/c",
      recallHintFile: "/home/review/.openviking/recall-hints/pr-42.json",
    });
    expect(pr.QCR_OV_RECALL_HINT_FILE).toBe("/home/review/.openviking/recall-hints/pr-42.json");
    expect(
      openVikingSessionEnv({ baseUrl: "http://h:1933", peerId: "overseer", cliConfigPath: "/c" })
        .QCR_OV_RECALL_HINT_FILE,
    ).toBeUndefined();
  });
});

describe("the stale-session sweep plan (S3)", () => {
  const state = (closed: number[], open: number[]) => (pr: number) =>
    closed.includes(pr)
      ? ("closed" as const)
      : open.includes(pr)
        ? ("open" as const)
        : ("unknown" as const);

  it("deletes only pr-<n> sessions of CLOSED PRs — open, unknown and foreign ids are left alone", () => {
    const plan = planStaleOvSessions(
      ["pr-12", "pr-3", "pr-40", "pr-99", "overseer", "pi-abc123", "pr-x", "pr-0"],
      state([3, 12], [40]),
    );
    expect(plan).toEqual({ remove: ["pr-3", "pr-12"], deferred: 0, kept: 2, foreign: 4 });
  });

  it("is bounded per pass, lowest PR first, and says how many it left", () => {
    const ids = Array.from({ length: 25 }, (_, i) => `pr-${100 - i}`);
    const plan = planStaleOvSessions(ids, () => "closed");
    expect(plan.remove).toHaveLength(OV_SESSION_SWEEP_MAX);
    expect(plan.remove[0]).toBe("pr-76");
    expect(plan.deferred).toBe(25 - OV_SESSION_SWEEP_MAX);
    expect(planStaleOvSessions(ids, () => "closed", 0).remove).toEqual([]);
  });

  it("reads only the exact pr-<n> spelling as a PR's raw tier", () => {
    expect(prOfOvSessionId("pr-5263")).toBe(5263);
    for (const id of ["pr-", "pr-0", "pr-1a", "PR-5", "xpr-5", "pr-5/x", "overseer"])
      expect(prOfOvSessionId(id)).toBeNull();
  });
});

describe("lifecycle.list (S3)", () => {
  it("lists the server's sessions through the real client", async () => {
    const server = fakeServer();
    const client = new OpenVikingClient({
      baseUrl: "http://127.0.0.1:1933",
      apiKey: "reviewer-key",
      fetchFn: server.fetchFn,
    });
    const life = openVikingSessionLifecycle(client);
    await life.create("pr-1");
    await life.create("pr-2");
    expect(await life.list!()).toEqual({ ok: true, ids: ["pr-1", "pr-2"] });
  });

  it("a failure, a throw and a hang are each a reason, never a rejection", async () => {
    const base = {
      createSession: async () => ({ ok: true, status: 200 }),
      deleteSession: async () => ({ ok: true, status: 200 }),
    };
    const failing = openVikingSessionLifecycle({
      ...base,
      listSessions: async () => ({ ok: false as const, status: 401, message: "Invalid API Key" }),
    });
    expect(await failing.list!()).toEqual({ ok: false, reason: "401: Invalid API Key" });
    const throwing = openVikingSessionLifecycle({
      ...base,
      listSessions: async () => {
        throw new Error("socket hang up");
      },
    });
    expect(await throwing.list!()).toMatchObject({ ok: false });
    const hanging = openVikingSessionLifecycle(
      { ...base, listSessions: () => new Promise<never>(() => {}) },
      { timeoutMs: 10 },
    );
    expect(await hanging.list!()).toMatchObject({ ok: false });
    // An api with no listing gives a lifecycle with no list — no sweep.
    expect(openVikingSessionLifecycle(base).list).toBeUndefined();
  });
});

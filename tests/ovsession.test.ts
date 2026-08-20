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
  openVikingSessionEnv,
  openVikingSessionLifecycle,
  ovSessionIdForPr,
  ovcliConfPathIn,
  readServerRootKey,
  renderOvcliConf,
  writeOvcliConf,
} from "../src/memory/ovsession.js";

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
    const life = openVikingSessionLifecycle(api({ create: { ok: false, status: 409, conflict: true } }));
    expect(await life.create("pr-7")).toBe(true);
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
    const body = renderOvcliConf({ url: "http://127.0.0.1:1933/", apiKey: "k", user: OV_REVIEWER_USER });
    expect(JSON.parse(body)).toEqual({ url: "http://127.0.0.1:1933", user: "reviewer", api_key: "k" });
    expect(body).not.toContain("peer");
  });

  it("writes 0600 and reports that a key landed", () => {
    const path = ovcliConfPathIn(join(dir, "pihome"));
    const res = writeOvcliConf(path, { url: "http://x:1933", apiKey: "reviewer-key", user: "reviewer" });
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
    const res = writeOvcliConf(path, { url: "http://x:1933", apiKey: "k", user: "reviewer" }, { serverConfigPath: join(dir, "missing.conf") });
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

  it("omits the session id when there is no raw tier (the overseer)", () => {
    const env = openVikingSessionEnv({ baseUrl: "http://h:1933", peerId: "overseer", cliConfigPath: "/c" });
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
    const ok = (result: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify({ status: "ok", result }) });
    if (url.endsWith("/api/v1/sessions") && init.method === "POST") {
      sessions.set(body["session_id"], { policy: body["memory_policy"], notes: [] });
      return ok({ session_id: body["session_id"] });
    }
    if (url.includes("/api/v1/sessions/") && init.method === "DELETE") {
      const id = decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));
      const existed = sessions.delete(id);
      return existed
        ? ok({})
        : { ok: false, status: 404, text: async () => JSON.stringify({ status: "error", error: { code: "NOT_FOUND", message: "no such session" } }) };
    }
    if (url.endsWith("/api/v1/search/search")) {
      const q = String(body["query"] ?? "").toLowerCase();
      const entries = [...memories.entries()]
        .filter(([, text]) => text.toLowerCase().includes(q))
        .map(([uri, text]) => ({ uri, text, score: 1, category: "experiences", detail: "full", origin: "memories" }));
      return ok({ entries, rendered: entries.map((e) => e.text).join("\n"), digest: "", stats: {} });
    }
    return { ok: false, status: 404, text: async () => JSON.stringify({ status: "error", error: { code: "NOT_FOUND", message: url } }) };
  };
  return { sessions, memories, fetchFn };
}

describe("the raw tier is not the durable tier", () => {
  it("creates the session with extraction fully disabled", async () => {
    const server = fakeServer();
    const client = new OpenVikingClient({ baseUrl: "http://127.0.0.1:1933", apiKey: "reviewer-key", fetchFn: server.fetchFn });
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
    const client = new OpenVikingClient({ baseUrl: "http://127.0.0.1:1933", apiKey: "reviewer-key", fetchFn: server.fetchFn });
    await openVikingSessionLifecycle(client).create("pr-42");
    // What the session's turn sync puts in the raw tier…
    server.sessions.get("pr-42")!.notes.push("round 2 scratch: the retry lives in HTTPAdapter");
    // …versus what the durable tier holds.
    server.memories.set("viking://user/reviewer/memories/experiences/retry.md", "retry policy is set centrally");

    const hit = await client.searchContext("retry");
    expect(hit.ok).toBe(true);
    if (!hit.ok) return;
    expect(hit.result.entries.map((e) => e.uri)).toEqual(["viking://user/reviewer/memories/experiences/retry.md"]);
    expect(hit.result.rendered).not.toContain("round 2 scratch");
  });

  it("closing the PR deletes the session and its archives", async () => {
    const server = fakeServer();
    const client = new OpenVikingClient({ baseUrl: "http://127.0.0.1:1933", apiKey: "reviewer-key", fetchFn: server.fetchFn });
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
    const client = new OpenVikingClient({ baseUrl: "http://h:1933", apiKey: "k" }) as unknown as Record<string, unknown>;
    expect(typeof client["commitSession"]).toBe("undefined");
    const src = readFileSync(join(import.meta.dirname, "..", "src", "memory", "ovsession.ts"), "utf8");
    expect(src).not.toMatch(/commitSession|\/commit/);
  });
});

describe("the pi HOME layout", () => {
  it("puts ovcli.conf where the fork's resolver looks by default", () => {
    mkdirSync(join(dir, "pihome"), { recursive: true });
    expect(ovcliConfPathIn(join(dir, "pihome"))).toBe(join(dir, "pihome", ".openviking", "ovcli.conf"));
  });
});

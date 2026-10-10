// The authenticated memory probe, the key source that re-reads a
// rotated key, and the client's per-request observer. Fake fetch, fake clock,
// temp dirs for the key file; no network.
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  OpenVikingClient,
  isAuthFailure,
  keyFromFile,
  type HttpFetch,
  type OvRequestRecord,
} from "../src/openviking/client.js";
import { classifyProbe, credentialProbe } from "../src/openviking/probe.js";
import { GAP_ROW_EVERY_MS, countedGapSink } from "../src/openviking/gapsink.js";
import { anomalySeverity } from "../src/anomalies.js";
import { StateStore } from "../src/state.js";

const BASE = "http://127.0.0.1:1933";
const KEY = "reviewer-user-key-0123456789";

/** A fake fetch answering every call with one status/body, recording the calls. */
function server(status: number, body: unknown) {
  const calls: Array<{ url: string; auth: string | undefined }> = [];
  const fetch: HttpFetch = async (url, init) => {
    calls.push({ url, auth: init.headers["Authorization"] });
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
  };
  return { fetch, calls };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempKeyFile(value?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "qcr-keyfile-"));
  dirs.push(dir);
  const path = join(dir, "openviking_reviewer_key");
  if (value !== undefined) writeFileSync(path, `${value}\n`);
  return path;
}

describe("classifyProbe", () => {
  it.each([
    [true, 200, "", "", "ok"],
    [false, 401, "UNAUTHENTICATED", "Invalid API Key", "auth_failed"],
    [false, 403, "PERMISSION_DENIED", "", "auth_failed"],
    // The 0.4.15 server has wrapped a bad key in an HTTP-200 error envelope.
    [false, 200, "UNKNOWN", "Invalid API Key", "auth_failed"],
    [false, 404, "NOT_FOUND", "no such directory", "ok"],
    [false, 0, "no_key", "", "no_key"],
    [false, 0, "transport", "connect ECONNREFUSED", "unreachable"],
    [false, 503, "http_503", "HTTP 503", "error"],
    [false, 200, "bad_body", "not an envelope", "error"],
  ] as const)("ok=%s %s %s %s → %s", (ok, status, code, message, want) => {
    expect(classifyProbe(ok, status, code, message)).toBe(want);
  });

  it("isAuthFailure reads status, code and the server's own wording", () => {
    expect(isAuthFailure(401, "")).toBe(true);
    expect(isAuthFailure(500, "unauthenticated")).toBe(true);
    expect(isAuthFailure(200, "X", "UNAUTHENTICATED: Invalid API Key")).toBe(true);
    expect(isAuthFailure(409, "CONFLICT", "path busy")).toBe(false);
    expect(isAuthFailure(0, "transport", "timeout")).toBe(false);
  });
});

describe("credentialProbe — fs/ls of the memories root with ONE credential", () => {
  it("lists viking://user/<user>/memories with that key", async () => {
    const s = server(200, { status: "ok", result: [] });
    const probe = credentialProbe({
      baseUrl: BASE,
      user: "reviewer",
      key: () => ({ state: "key", key: KEY }),
      timeoutMs: 1000,
      fetchFn: s.fetch,
    });
    expect(await probe()).toMatchObject({ result: "ok", status: 200 });
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.url).toBe(
      `${BASE}/api/v1/fs/ls?uri=${encodeURIComponent("viking://user/reviewer/memories")}`,
    );
    expect(s.calls[0]!.auth).toBe(`Bearer ${KEY}`);
  });

  it("a 401 is auth_failed, and the detail never carries the key", async () => {
    const s = server(401, {
      status: "error",
      error: { code: "UNAUTHENTICATED", message: `Invalid API Key: ${KEY}` },
    });
    const probe = credentialProbe({
      baseUrl: BASE,
      user: "reviewer",
      key: () => ({ state: "key", key: KEY }),
      timeoutMs: 1000,
      fetchFn: s.fetch,
    });
    const a = await probe();
    expect(a).toMatchObject({ result: "auth_failed", status: 401, code: "UNAUTHENTICATED" });
    expect(a.detail).not.toContain(KEY);
    expect(a.detail).toContain("<redacted>");
  });

  it("a dead transport is unreachable, never a throw", async () => {
    const probe = credentialProbe({
      baseUrl: BASE,
      user: "reviewer",
      key: () => ({ state: "key", key: KEY }),
      timeoutMs: 1000,
      fetchFn: () => Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:1933")),
    });
    expect(await probe()).toMatchObject({ result: "unreachable", status: 0, code: "transport" });
  });

  it("no key, an absent file and an unreadable file are answered without a request", async () => {
    const s = server(200, { status: "ok", result: [] });
    const mk = (key: () => import("../src/openviking/probe.js").ProbeKey) =>
      credentialProbe({ baseUrl: BASE, user: "reviewer", key, timeoutMs: 1000, fetchFn: s.fetch });
    expect(await mk(() => ({ state: "key", key: "" }))()).toMatchObject({ result: "no_key" });
    expect(await mk(() => ({ state: "absent" }))()).toMatchObject({ result: "absent" });
    expect(await mk(() => ({ state: "unreadable", detail: "not JSON" }))()).toMatchObject({
      result: "no_key",
      detail: "not JSON",
    });
    expect(s.calls).toEqual([]);
  });
});

describe("keyFromFile — a rotated key is re-read", () => {
  it("re-stats every TTL and re-reads a key that changed", () => {
    const path = tempKeyFile("old-key-aaaaaaaa");
    let clock = 0;
    const read = keyFromFile(path, 1000, () => clock);
    expect(read()).toBe("old-key-aaaaaaaa");
    writeFileSync(path, "new-key-bbbbbbbbbbbb\n");
    // Inside the TTL the cached key stands (no stat per request)…
    clock = 500;
    expect(read()).toBe("old-key-aaaaaaaa");
    // …and past it the rotation is picked up.
    clock = 1500;
    expect(read()).toBe("new-key-bbbbbbbbbbbb");
  });

  it("notices a same-size key swapped in by rename (the usual secret update)", () => {
    const path = tempKeyFile("key-AAAAAAAAAAAA");
    let clock = 0;
    const read = keyFromFile(path, 1000, () => clock);
    expect(read()).toBe("key-AAAAAAAAAAAA");
    const tmp = `${path}.new`;
    writeFileSync(tmp, "key-BBBBBBBBBBBB\n");
    renameSync(tmp, path);
    clock = 1000;
    expect(read()).toBe("key-BBBBBBBBBBBB");
  });

  it("invalidate() makes the very next call re-read, inside the TTL", () => {
    const path = tempKeyFile("old-key-aaaaaaaa");
    const clock = 0;
    const read = keyFromFile(path, 60_000, () => clock);
    expect(read()).toBe("old-key-aaaaaaaa");
    writeFileSync(path, "new-key-bbbbbbbbbbbb\n");
    expect(read()).toBe("old-key-aaaaaaaa");
    read.invalidate();
    expect(read()).toBe("new-key-bbbbbbbbbbbb");
  });

  it("a key file that disappears stops being sent (a keyless client is loud)", () => {
    const path = tempKeyFile("old-key-aaaaaaaa");
    let clock = 0;
    const read = keyFromFile(path, 1000, () => clock);
    expect(read()).toBe("old-key-aaaaaaaa");
    rmSync(path);
    clock = 2000;
    expect(read()).toBeNull();
  });

  it("the CLIENT drops the cache on a 401, so the next request sends the rotated key", async () => {
    const path = tempKeyFile("old-key-aaaaaaaa");
    const read = keyFromFile(path, 60_000, () => 0);
    const sent: string[] = [];
    let status = 401;
    const fetchFn: HttpFetch = async (_url, init) => {
      sent.push(init.headers["Authorization"] ?? "");
      const body =
        status === 401
          ? { status: "error", error: { code: "UNAUTHENTICATED", message: "Invalid API Key" } }
          : { status: "ok", result: [] };
      return { ok: status === 200, status, text: async () => JSON.stringify(body) };
    };
    const client = new OpenVikingClient({ baseUrl: BASE, apiKey: read, fetchFn });
    expect((await client.ls(client.memoriesRoot())).ok).toBe(false);
    // The operator fixes the secret; the TTL (60 s) has NOT elapsed.
    writeFileSync(path, "fixed-key-cccccccccccc\n");
    status = 200;
    expect((await client.ls(client.memoriesRoot())).ok).toBe(true);
    expect(sent).toEqual(["Bearer old-key-aaaaaaaa", "Bearer fixed-key-cccccccccccc"]);
  });
});

describe("OpenVikingClient onRequest — every request's outcome, successes included", () => {
  function observed(status: number, body: unknown, key: string | null = KEY) {
    const records: OvRequestRecord[] = [];
    let clock = 1000;
    const client = new OpenVikingClient({
      baseUrl: BASE,
      apiKey: key ?? undefined,
      fetchFn: async () => {
        clock += 7;
        return {
          ok: status >= 200 && status < 300,
          status,
          text: async () => JSON.stringify(body),
        };
      },
      onRequest: (r) => records.push(r),
      clock: () => clock,
    });
    return { client, records };
  }

  it("ok, with its duration", async () => {
    const { client, records } = observed(200, { status: "ok", result: [] });
    await client.ls("viking://user/reviewer/memories");
    expect(records).toEqual([{ op: "ls", outcome: "ok", status: 200, code: "", ms: 7 }]);
  });

  it("a 409 is a conflict (an answer), a 401 is auth, a 5xx is failed", async () => {
    const c409 = observed(409, { status: "error", error: { code: "CONFLICT", message: "stale" } });
    await c409.client.batchWrite({ root_uri: "r", operations: [], wait: false });
    expect(c409.records[0]).toMatchObject({ op: "batch_write", outcome: "conflict", status: 409 });
    const c401 = observed(401, {
      status: "error",
      error: { code: "UNAUTHENTICATED", message: "Invalid API Key" },
    });
    await c401.client.readContent("viking://x");
    expect(c401.records[0]).toMatchObject({ op: "read", outcome: "auth", code: "UNAUTHENTICATED" });
    const c503 = observed(503, {});
    await c503.client.searchContext("q");
    expect(c503.records[0]).toMatchObject({ op: "search", outcome: "failed", status: 503 });
  });

  it("a NOT_FOUND is `absent` — an authenticated answer, never `failed` (as the probe and the store read it)", async () => {
    const enveloped = observed(404, {
      status: "error",
      error: { code: "NOT_FOUND", message: "no such session" },
    });
    await enveloped.client.ls("viking://user/reviewer/memories/cases");
    expect(enveloped.records[0]).toMatchObject({ op: "ls", outcome: "absent", code: "NOT_FOUND" });
    // A 200 error envelope that says NOT_FOUND is the same answer.
    const in200 = observed(200, { status: "error", error: { code: "NOT_FOUND", message: "gone" } });
    await in200.client.readContent("viking://x");
    expect(in200.records[0]).toMatchObject({ op: "read", outcome: "absent" });
    // The probe agrees: the same answer proves the key.
    expect(classifyProbe(false, 404, "NOT_FOUND", "no such path")).toBe("ok");
  });

  it("no key is an auth outcome on EVERY call (the gap is reported once; the count is not)", async () => {
    const { client, records } = observed(200, { status: "ok", result: [] }, null);
    await client.ls("a");
    await client.ls("b");
    expect(records.map((r) => [r.outcome, r.code])).toEqual([
      ["auth", "no_key"],
      ["auth", "no_key"],
    ]);
  });

  it("a throwing observer never escapes a call", async () => {
    const client = new OpenVikingClient({
      baseUrl: BASE,
      apiKey: KEY,
      fetchFn: async () => ({
        ok: true,
        status: 200,
        text: async () => '{"status":"ok","result":[]}',
      }),
      onRequest: () => {
        throw new Error("counter bug");
      },
    });
    expect((await client.ls("x")).ok).toBe(true);
  });
});

// The counted `openviking_gap` (wire.ts hands the client this sink): every gap
// counted, ONE quiet row per op:code per hour, carrying the running count.
describe("countedGapSink — the counted, rate-limited openviking_gap", () => {
  const gap = (op = "read", code = "transport") => ({
    op,
    status: 0,
    code,
    message: "connect ECONNREFUSED 127.0.0.1:1933",
  });
  function harness() {
    const store = new StateStore(":memory:");
    let clock = 1_000_000;
    const recorded: string[] = [];
    const sink = countedGapSink({
      logAnomaly: (kind, pr, roundNo, detail) => store.logAnomaly(kind, pr, roundNo, detail),
      record: (g) => recorded.push(`${g.op}:${g.code}`),
      now: () => clock,
    });
    const rows = () => store.anomalies().filter((a) => a.kind === "openviking_gap");
    return {
      sink,
      rows,
      recorded,
      advance: (ms: number) => {
        clock += ms;
      },
    };
  }

  it("is QUIET — the person-facing signal is the memory state, not this row", () => {
    expect(anomalySeverity("openviking_gap")).toBe("quiet");
  });

  it("two gaps of one op:code inside an hour write ONE row; every gap is still counted", () => {
    const h = harness();
    h.sink(gap());
    h.advance(GAP_ROW_EVERY_MS - 1);
    h.sink(gap());
    expect(h.rows()).toHaveLength(1);
    expect(h.rows()[0]!.detail).toMatch(/— 1 such gap since boot$/);
    expect(h.recorded).toEqual(["read:transport", "read:transport"]);
  });

  it("an hour later a SECOND row, carrying the running count", () => {
    const h = harness();
    h.sink(gap());
    h.sink(gap());
    h.advance(GAP_ROW_EVERY_MS);
    h.sink(gap());
    expect(h.rows()).toHaveLength(2);
    expect(h.rows()[1]!.detail).toMatch(/^read transport \(no answer\): connect ECONNREFUSED/);
    expect(h.rows()[1]!.detail).toMatch(/— 3 such gaps since boot$/);
  });

  it("each op:code is limited on its own", () => {
    const h = harness();
    h.sink(gap("read", "transport"));
    h.sink(gap("search", "transport"));
    h.sink(gap("read", "http_500"));
    expect(h.rows()).toHaveLength(3);
  });

  it("a throwing health counter or row writer never escapes", () => {
    const sink = countedGapSink({
      logAnomaly: () => {
        throw new Error("db gone");
      },
      record: () => {
        throw new Error("counter gone");
      },
    });
    expect(() => sink(gap())).not.toThrow();
  });
});

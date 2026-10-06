// boot provisioning for `auth_mode: "api_key"`.
//
// Three properties are pinned here, and each is an acceptance criterion of the
// ticket rather than an implementation detail:
//
//   1. IDEMPOTENCE. Re-running creates nothing and rotates nothing. A user that
//      is already there is left exactly as it is; an unreadable listing creates
//      NOTHING (guessing would mint a duplicate identity for a user who has
//      one, and orphan the key already distributed to the owner's PC).
//   2. NOTHING IS EVER A PASS BY DEFAULT. The reviewer-key check reuses the
//      confinement proof's own verdict logic: 2xx is reach, 401/403 refusal,
//      and anything else — including a 200 carrying an error envelope — is
//      INCONCLUSIVE and reported, never assumed fine.
//   3. MEMORY NEVER BLOCKS THE BOOT. Every failure path resolves a report; the
//      module never throws, and the CLI exits 0 unless asked to be strict.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PROVISION_WOKEN_EVENT,
  provisionWake,
  raiseProvisionWake,
  readProvisionReport,
} from "../src/openviking/provisionreport.js";
import { StateStore, type AnomalyRecord } from "../src/state.js";
// A plain-JS script, deliberately dependency-free so the container entrypoint
// can run it before any TypeScript build exists. `tsconfig.tests.json` sets
// `allowJs`, so tsc now INFERS its exported shapes and this import needs no
// suppression — which is what makes the call sites below checked.
import * as prov from "../scripts/openviking-provision.mjs";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** A fetch that answers from a scripted table and records every call. */
function fakeFetch(
  routes: Array<{ match: RegExp; method?: string; status: number; body?: unknown }>,
) {
  const calls: Call[] = [];
  // `init` is optional here because the module's seam declares it optional —
  // a two-required-parameter double is not assignable to it, which is how the
  // tests/ type-check catches a fake that has drifted from the real contract.
  const fetchFn = async (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: init?.headers ?? {},
      body: init?.body,
    });
    const hit = routes.find(
      (r) => r.match.test(url) && (r.method === undefined || r.method === (init?.method ?? "GET")),
    );
    if (!hit) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: hit.status < 300, status: hit.status, json: async () => hit.body ?? {} };
  };
  return { fetchFn, calls };
}

const BASE = "http://127.0.0.1:1933";

describe("planProvision — the idempotence core", () => {
  it("creates only what is missing", () => {
    expect(prov.planProvision(["reviewer"], ["reviewer", "companion"])).toEqual({
      create: ["companion"],
      keep: ["reviewer"],
      unknown: [],
    });
  });

  it("a second run creates nothing", () => {
    expect(prov.planProvision(["reviewer", "companion"], ["reviewer", "companion"])).toEqual({
      create: [],
      keep: ["reviewer", "companion"],
      unknown: [],
    });
  });

  it("an UNREADABLE listing creates nothing at all", () => {
    // The dangerous branch: "I could not read it" must never read as "there is
    // nothing there" — that would mint a second identity for an existing user.
    expect(prov.planProvision(null, ["reviewer", "companion"])).toEqual({
      create: [],
      keep: [],
      unknown: ["reviewer", "companion"],
    });
  });

  it("dedupes and trims the wanted list", () => {
    expect(prov.planProvision([], [" reviewer ", "reviewer", "", "companion"]).create).toEqual([
      "reviewer",
      "companion",
    ]);
  });
});

describe("usersFromListing — tolerant of envelope shape, honest about garbage", () => {
  it("reads the shapes the server might use", () => {
    expect(
      prov.usersFromListing({ data: { users: [{ user_id: "reviewer" }, { id: "companion" }] } }),
    ).toEqual(["reviewer", "companion"]);
    expect(prov.usersFromListing({ users: ["reviewer"] })).toEqual(["reviewer"]);
    expect(prov.usersFromListing([{ name: "companion" }])).toEqual(["companion"]);
  });

  it("returns null — not [] — for anything that is not a listing", () => {
    expect(prov.usersFromListing({ status: "error" })).toBeNull();
    expect(prov.usersFromListing("nope")).toBeNull();
  });
});

describe("parseUserList", () => {
  it("splits the group_vars spelling", () => {
    expect(prov.parseUserList("reviewer,companion")).toEqual(["reviewer", "companion"]);
    expect(prov.parseUserList("reviewer, companion ")).toEqual(["reviewer", "companion"]);
    expect(prov.parseUserList("")).toEqual([]);
  });
});

describe("provision — one pass against a live-shaped server", () => {
  const listing = (users: string[]) => ({
    match: /\/admin\/accounts\/[^/]+\/users$/,
    method: "GET",
    status: 200,
    body: { users },
  });
  const reviewerReach = {
    match: /\/api\/v1\/fs\/ls/,
    method: "GET",
    status: 200,
    body: { entries: [] },
  };

  it("creates the missing user, keeps the present one, and confirms the reviewer key", async () => {
    const { fetchFn, calls } = fakeFetch([
      listing(["reviewer"]),
      { match: /\/admin\/accounts\/[^/]+\/users$/, method: "POST", status: 201, body: {} },
      reviewerReach,
    ]);
    const lines: string[] = [];
    const report = await prov.provision({
      base: BASE,
      account: "default",
      users: ["reviewer", "companion"],
      rootKey: "root-secret-value",
      reviewerKey: "reviewer-secret-value",
      fetchFn,
      log: (l: string) => lines.push(l),
    });
    expect(report).toMatchObject({
      created: ["companion"],
      kept: ["reviewer"],
      failed: [],
      reviewer: "reach",
      ok: true,
    });
    // The root key authenticates the ADMIN calls and nothing else; the probe
    // carries the reviewer key.
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.headers["Authorization"]).toBe("Bearer root-secret-value");
    const probe = calls.find((c) => /fs\/ls/.test(c.url))!;
    expect(probe.headers["Authorization"]).toBe("Bearer reviewer-secret-value");
    expect(probe.headers["X-OpenViking-User"]).toBe("reviewer");
    // No key value is ever logged.
    expect(lines.join("\n")).not.toContain("secret-value");
  });

  it("is a no-op on the second run", async () => {
    const { fetchFn, calls } = fakeFetch([listing(["reviewer", "companion"]), reviewerReach]);
    const report = await prov.provision({
      base: BASE,
      account: "default",
      users: ["reviewer", "companion"],
      rootKey: "root",
      reviewerKey: "rev",
      fetchFn,
      log: () => {},
    });
    expect(report.created).toEqual([]);
    expect(report.kept).toEqual(["reviewer", "companion"]);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("a 409 on create is success, not a failure — the user was already there", async () => {
    const { fetchFn } = fakeFetch([
      listing([]),
      { match: /\/users$/, method: "POST", status: 409, body: {} },
      reviewerReach,
    ]);
    const report = await prov.provision({
      base: BASE,
      account: "default",
      users: ["reviewer"],
      rootKey: "r",
      reviewerKey: "k",
      fetchFn,
      log: () => {},
    });
    expect(report.kept).toEqual(["reviewer"]);
    expect(report.failed).toEqual([]);
  });

  it("an unreadable listing provisions nothing and says so", async () => {
    const { fetchFn, calls } = fakeFetch([
      {
        match: /\/users$/,
        method: "GET",
        status: 200,
        body: { status: "error", error: { message: "nope" } },
      },
      reviewerReach,
    ]);
    const lines: string[] = [];
    const report = await prov.provision({
      base: BASE,
      account: "default",
      users: ["reviewer"],
      rootKey: "r",
      reviewerKey: "k",
      fetchFn,
      log: (l: string) => lines.push(l),
    });
    expect(report.created).toEqual([]);
    expect(report.ok).toBe(false);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    expect(lines.join("\n")).toContain("could not read the user listing");
  });

  it("a reviewer key that does NOT authenticate is reported — and never rotated", async () => {
    const { fetchFn, calls } = fakeFetch([
      listing(["reviewer", "companion"]),
      { match: /fs\/ls/, method: "GET", status: 403, body: {} },
    ]);
    const lines: string[] = [];
    const report = await prov.provision({
      base: BASE,
      account: "default",
      users: ["reviewer"],
      rootKey: "r",
      reviewerKey: "k",
      fetchFn,
      log: (l: string) => lines.push(l),
    });
    expect(report.reviewer).toBe("refused");
    expect(report.ok).toBe(false);
    expect(lines.join("\n")).toContain("NOT rotating");
    // Nothing was written: no key route was ever called.
    expect(calls.some((c) => /\/key$/.test(c.url))).toBe(false);
  });

  it("an ambiguous answer is INCONCLUSIVE, never a pass", async () => {
    const { fetchFn } = fakeFetch([
      listing(["reviewer"]),
      { match: /fs\/ls/, method: "GET", status: 500, body: {} },
    ]);
    const report = await prov.provision({
      base: BASE,
      account: "default",
      users: ["reviewer"],
      rootKey: "r",
      reviewerKey: "k",
      fetchFn,
      log: () => {},
    });
    expect(report.reviewer).toBe("inconclusive");
    expect(report.ok).toBe(false);
  });

  it("no root key ⇒ nothing is attempted, and the boot is still fine", async () => {
    const { fetchFn, calls } = fakeFetch([listing([])]);
    const lines: string[] = [];
    const report = await prov.provision({
      base: BASE,
      account: "default",
      users: ["reviewer"],
      rootKey: "",
      reviewerKey: "k",
      fetchFn,
      log: (l: string) => lines.push(l),
    });
    expect(calls).toEqual([]);
    expect(report.ok).toBe(false);
    expect(lines.join("\n")).toContain("no root key in the secrets mount");
  });

  it("a dead server never throws — every probe is total", async () => {
    const dead = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    const report = await prov.provision({
      base: BASE,
      account: "default",
      users: ["reviewer"],
      rootKey: "r",
      reviewerKey: "k",
      fetchFn: dead as never,
      log: () => {},
    });
    expect(report.ok).toBe(false);
    expect(report.created).toEqual([]);
  });
});

describe("the temporary provisioning server", () => {
  it("uses the same argv the supervisor does", () => {
    expect(prov.serverArgv({ config: "/s/ov.conf", host: "127.0.0.1", port: 1933 })).toEqual([
      "--config",
      "/s/ov.conf",
      "--host",
      "127.0.0.1",
      "--port",
      "1933",
    ]);
  });

  it("waitForReady gives up on a deadline rather than hanging the boot", async () => {
    let t = 0;
    const ok = await prov.waitForReady({
      base: BASE,
      fetchFn: (async () => ({ ok: false, status: 503, json: async () => ({}) })) as never,
      timeoutMs: 1000,
      sleep: async () => {
        t += 600;
      },
      now: () => t,
    });
    expect(ok).toBe(false);
  });

  it("waitForReady returns as soon as /ready answers", async () => {
    const ok = await prov.waitForReady({
      base: BASE,
      fetchFn: (async () => ({ ok: true, status: 200, json: async () => ({}) })) as never,
      timeoutMs: 1000,
    });
    expect(ok).toBe(true);
  });
});

// S4 (review) — the local embedder may not cost the boot a minute,
// and may not take the users and keys down with it.
describe("the provisioning embedder: a dead one ends the wait, and never blocks provisioning", () => {
  // What a REAL 0.4.15 answered on /ready with its embedder unreachable
  // (scratch venv, 2026-10-07): 503 after ~9.5 s, everything ok but embedding.
  const DEAD_EMBEDDER_READY = {
    status: "not_ready",
    checks: {
      agfs: { status: "ok", checks: { filesystem: "ok", multiwrite_sync: "not_supported" } },
      vectordb: "ok",
      api_key_manager: "ok",
      embedding:
        "error: provider=openai model=bge-small-en-v1.5-f16: OpenAI API error: Connection error.",
      ollama: "not_configured",
    },
  };
  const answer = (status: number, body: unknown) =>
    (async () => ({ ok: status < 300, status, json: async () => body })) as never;

  it("embedderGone names how the child went — exit codes in words, a signal, a spawn failure", () => {
    expect(prov.embedderGone({ exitCode: null, signalCode: null })).toBeNull();
    expect(prov.embedderGone({ exitCode: 3, signalCode: null })).toMatch(
      /exited with code 3 — its model file is missing or does not match the pinned sha256/,
    );
    expect(prov.embedderGone({ exitCode: 4, signalCode: null })).toMatch(/self-check/);
    expect(prov.embedderGone({ exitCode: 9, signalCode: null })).toBe("it exited with code 9");
    expect(prov.embedderGone({ exitCode: null, signalCode: "SIGKILL" })).toMatch(/SIGKILL/);
    expect(prov.embedderGone({ exitCode: null, signalCode: null }, "spawn ENOENT")).toMatch(
      /could not be started \(spawn ENOENT\)/,
    );
  });

  it("waitForEmbedder stops at once when the child is gone — never the whole timeout", async () => {
    let polls = 0;
    let sleeps = 0;
    let exited = false;
    const r = await prov.waitForEmbedder({
      base: "http://127.0.0.1:1934",
      gone: () => (exited ? "it exited with code 3" : null),
      fetchFn: (async () => {
        polls += 1;
        exited = true; // it refused its sha256 while we asked
        throw new Error("ECONNREFUSED");
      }) as never,
      timeoutMs: 60_000,
      sleep: async () => {
        sleeps += 1;
      },
      now: () => 0,
    });
    expect(r).toEqual({ ready: false, gone: "it exited with code 3" });
    expect(polls).toBe(1);
    expect(sleeps).toBe(0);
  });

  it("waitForEmbedder: ready on a 200; still bounded by its deadline for a live child that never answers", async () => {
    expect(
      await prov.waitForEmbedder({ base: "http://x", fetchFn: answer(200, {}), timeoutMs: 1000 }),
    ).toEqual({ ready: true, gone: null });
    let t = 0;
    expect(
      await prov.waitForEmbedder({
        base: "http://x",
        fetchFn: answer(503, {}),
        timeoutMs: 1000,
        sleep: async () => {
          t += 600;
        },
        now: () => t,
      }),
    ).toEqual({ ready: false, gone: null });
  });

  it("startEmbedder over a child that exits at once returns at once, saying why", async () => {
    let sleeps = 0;
    const lines: string[] = [];
    const child = {
      pid: 7,
      exitCode: null as number | null,
      signalCode: null as string | null,
      once: () => undefined,
      kill: () => true,
    };
    const r = await prov.startEmbedder(
      {
        python: "/v/bin/python",
        script: "/s/e.py",
        model: "bge-small-en-v1.5-f16",
        file: "/m.gguf",
        sha256: "0".repeat(64),
        port: 1934,
        threads: 1,
      },
      {
        log: (l: string) => lines.push(l),
        exists: () => true,
        readyTimeoutMs: 60_000,
        spawnFn: () => {
          setImmediate(() => {
            child.exitCode = 3;
          });
          return child;
        },
        fetchFn: (async () => {
          await new Promise((r) => setImmediate(r));
          throw new Error("ECONNREFUSED");
        }) as never,
        sleep: async () => {
          sleeps += 1;
        },
      },
    );
    expect(r.ready).toBe(false);
    expect(r.detail).toMatch(
      /did not come up on http:\/\/127\.0\.0\.1:1934: it exited with code 3/,
    );
    expect(sleeps).toBeLessThanOrEqual(1);
  });

  it("readyButEmbedding reads the real 0.4.15 answer — and only an embedding-ONLY failure", () => {
    expect(prov.readyButEmbedding(DEAD_EMBEDDER_READY)).toMatch(/^error: provider=openai/);
    // Another check failing too: not provisionable.
    expect(
      prov.readyButEmbedding({
        ...DEAD_EMBEDDER_READY,
        checks: { ...DEAD_EMBEDDER_READY.checks, vectordb: "unhealthy" },
      }),
    ).toBeNull();
    expect(
      prov.readyButEmbedding({
        ...DEAD_EMBEDDER_READY,
        checks: {
          ...DEAD_EMBEDDER_READY.checks,
          agfs: { status: "ok", checks: { filesystem: "error: io" } },
        },
      }),
    ).toBeNull();
    // Still initializing (no checks), ready, or no embedding check at all.
    expect(prov.readyButEmbedding({ status: "not_ready", reason: "initializing" })).toBeNull();
    expect(prov.readyButEmbedding({ status: "ready", checks: { embedding: "ok" } })).toBeNull();
    expect(
      prov.readyButEmbedding({ status: "not_ready", checks: { vectordb: "unhealthy" } }),
    ).toBeNull();
    expect(prov.readyButEmbedding(null)).toBeNull();
  });

  it("waitForProvisionable lets an embedding-only failure through, waits out initialization, and keeps its deadline", async () => {
    expect(
      await prov.waitForProvisionable({
        base: BASE,
        fetchFn: answer(503, DEAD_EMBEDDER_READY),
        timeoutMs: 1000,
      }),
    ).toEqual({ ready: true, embedding: DEAD_EMBEDDER_READY.checks.embedding });
    const seq = [answer(503, { status: "not_ready", reason: "initializing" }), answer(200, {})];
    let i = 0;
    expect(
      await prov.waitForProvisionable({
        base: BASE,
        fetchFn: ((url: string, init: unknown) =>
          (seq[Math.min(i++, seq.length - 1)] as unknown as (u: string, n: unknown) => unknown)(
            url,
            init,
          )) as never,
        timeoutMs: 10_000,
        sleep: async () => undefined,
      }),
    ).toEqual({ ready: true, embedding: null });
    let t = 0;
    expect(
      await prov.waitForProvisionable({
        base: BASE,
        fetchFn: answer(503, { status: "not_ready", checks: { vectordb: "unhealthy" } }),
        timeoutMs: 1000,
        sleep: async () => {
          t += 600;
        },
        now: () => t,
      }),
    ).toEqual({ ready: false, embedding: null });
    // Each call outlasts the engine's own 10 s embedding probe.
    expect(prov.READY_PROBE_CALL_MS).toBeGreaterThan(10_000);
  });

  it("main() provisions past an embedding-only failure and carries the embedder's fate into every report", () => {
    const src = readFileSync(resolve(process.cwd(), "scripts/openviking-provision.mjs"), "utf8");
    const mainBody = src.slice(src.indexOf("async function main"));
    expect(mainBody).toContain("await waitForProvisionable({ base: cfg.base");
    expect(mainBody).not.toContain("await waitForReady(");
    expect(mainBody).toMatch(/if \(!started\.ready\) notes\.push\(started\.detail\);/);
    // Every report — a failure's and the finished one — goes out through
    // finish(), which folds the notes in.
    expect(mainBody).toMatch(
      /const finish = \(report\) =>[\s\S]*?errors: \[\.\.\.new Set\(\[\.\.\.\(report\.errors \?\? \[\]\), \.\.\.notes\]\)\]/,
    );
  });
});

describe("stopServerChild — the boot can never hang on the temporary server", () => {
  // Adversarial finding (P2): the child was only ever sent SIGTERM and never
  // unref'd, so a server that trapped SIGTERM kept the node event loop alive
  // forever — and the entrypoint's `|| true` never fired because node never
  // exited. The stop is now SIGTERM → bounded grace → SIGKILL, with the child
  // unref'd so even that cannot keep the loop alive.
  interface FakeChild {
    kills: string[];
    unrefs: number;
    exitCode: number | null;
    signalCode: string | null;
    kill(sig: string): void;
    once(ev: string, fn: () => void): void;
    removeListener(ev: string, fn: () => void): void;
  }

  function fakeChild(opts: { exitOn?: string } = {}): FakeChild {
    const listeners: Array<() => void> = [];
    const child: FakeChild = {
      kills: [],
      unrefs: 0,
      exitCode: null,
      signalCode: null,
      kill(sig: string) {
        child.kills.push(sig);
        if (opts.exitOn === sig) {
          child.signalCode = sig;
          for (const fn of listeners.splice(0)) fn();
        }
      },
      once: (_ev, fn) => void listeners.push(fn),
      removeListener: () => {},
    };
    (child as unknown as { unref: () => void }).unref = () => void child.unrefs++;
    return child;
  }

  it("a child that exits on SIGTERM is terminated, never SIGKILLed", async () => {
    const child = fakeChild({ exitOn: "SIGTERM" });
    expect(await prov.stopServerChild(child, { graceMs: 5 })).toBe("terminated");
    expect(child.kills).toEqual(["SIGTERM"]);
    expect(child.unrefs).toBeGreaterThan(0);
  });

  it("a child that TRAPS SIGTERM is SIGKILLed after the grace — node's loop is released", async () => {
    const child = fakeChild(); // never emits exit on SIGTERM
    expect(await prov.stopServerChild(child, { graceMs: 5 })).toBe("killed");
    expect(child.kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect(child.unrefs).toBeGreaterThan(0); // even a SIGKILL survivor cannot hold the loop
  });

  it("an absent or already-exited child is a no-op", async () => {
    expect(await prov.stopServerChild(undefined)).toBe("absent");
    const gone = fakeChild();
    gone.exitCode = 0;
    expect(await prov.stopServerChild(gone, { graceMs: 5 })).toBe("already-exited");
    expect(gone.kills).toEqual([]);
  });

  it("main() routes every shutdown through the bounded stop — no bare SIGTERM path is left", () => {
    // Structural: reintroducing `child.kill("SIGTERM")` at a call site would
    // reintroduce the hang.
    const src = readFileSync(resolve(process.cwd(), "scripts/openviking-provision.mjs"), "utf8");
    const mainBody = src.slice(src.indexOf("async function main"));
    expect(mainBody).not.toContain('child.kill("SIGTERM")');
    expect(mainBody).toContain("stopServerChild(child)");
  });

  // under the local English embedder the server's /ready probes
  // the loopback service, so the provisioning step runs it FIRST, for the same
  // foreground step, and stops it on every exit path — after the server.
  it("main() starts the local embedder before its server and stops it on every exit path, after the server", () => {
    const src = readFileSync(resolve(process.cwd(), "scripts/openviking-provision.mjs"), "utf8");
    const mainBody = src.slice(src.indexOf("async function main"));
    const startEmb = mainBody.indexOf("await startEmbedder(cfg.embedder");
    const startServer = mainBody.indexOf("child = spawn(cfg.bin, serverArgv(cfg)");
    expect(startEmb).toBeGreaterThan(0);
    expect(startEmb).toBeLessThan(startServer);
    // Both stop paths (never-ready and the finally) stop the embedder too,
    // each after the server.
    const stops = [...mainBody.matchAll(/await stopServerChild\((child|embedder)\);/g)].map(
      (m) => m[1],
    );
    expect(stops).toEqual(["child", "embedder", "child", "embedder"]);
    // A partial flag set is reported (and reported in the provision report),
    // never guessed into a launch.
    expect(mainBody).toMatch(/typeof cfg\.embedder === "string"[\s\S]*?finish\(failed\(/);
  });
});

describe("cli surface", () => {
  it("parses the entrypoint's invocation", () => {
    const cfg = prov.parseArgs([
      "--base",
      "http://127.0.0.1:1933",
      "--users",
      "reviewer,companion",
      "--root-key-file",
      "/secrets/openviking_root_key",
      "--reviewer-key-file",
      "/secrets/openviking_reviewer_key",
      "--start-server",
      "--bin",
      "/opt/openviking/venv/bin/openviking-server",
      "--config",
      "/state/ov.conf",
      "--port",
      "1933",
    ]);
    expect(cfg).toMatchObject({
      base: "http://127.0.0.1:1933",
      users: ["reviewer", "companion"],
      rootKeyFile: "/secrets/openviking_root_key",
      reviewerKeyFile: "/secrets/openviking_reviewer_key",
      startServer: true,
      port: 1933,
      strict: false,
    });
  });

  it("an unreadable secret file reads as empty, never as a throw", () => {
    expect(prov.readSecret("/nonexistent/openviking_root_key")).toBe("");
    expect(prov.readSecret("")).toBe("");
  });
});

// the boot log reached nobody, so the run now leaves a REPORT the
// daemon reads at boot (status.json `memory.provision`, and a
// `memory_provision_failed` wake on a failure or a recreated user).
describe("the provisioning report", () => {
  const listing = (users: string[]) => ({
    match: /\/admin\/accounts\/[^/]+\/users$/,
    method: "GET",
    status: 200,
    body: { users },
  });

  it("every failure lands in report.errors as a sentence", async () => {
    const { fetchFn } = fakeFetch([
      listing(["reviewer", "companion"]),
      { match: /fs\/ls/, method: "GET", status: 401, body: {} },
    ]);
    const report = await prov.provision({
      base: BASE,
      account: "default",
      users: ["reviewer", "companion"],
      rootKey: "root-secret-value",
      reviewerKey: "reviewer-secret-value",
      fetchFn,
      log: () => {},
    });
    expect(report.ok).toBe(false);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toMatch(
      /^the reviewer key does NOT authenticate against user\/reviewer \(refused/,
    );
  });

  it("a clean run has no errors", async () => {
    const { fetchFn } = fakeFetch([
      listing(["reviewer"]),
      { match: /fs\/ls/, method: "GET", status: 200, body: {} },
    ]);
    const report = await prov.provision({
      base: BASE,
      account: "default",
      users: ["reviewer"],
      rootKey: "r",
      reviewerKey: "k",
      fetchFn,
      log: () => {},
    });
    expect(report).toMatchObject({ ok: true, errors: [] });
  });

  it("the report body carries the verdict and never a key", async () => {
    const { fetchFn } = fakeFetch([
      listing([]),
      {
        match: /\/users$/,
        method: "POST",
        status: 201,
        body: { result: { user_key: "MINTED-secret-value" } },
      },
      { match: /fs\/ls/, method: "GET", status: 401, body: {} },
    ]);
    const report = await prov.provision({
      base: BASE,
      account: "default",
      users: ["reviewer"],
      rootKey: "root-secret-value",
      reviewerKey: "reviewer-secret-value",
      fetchFn,
      log: () => {},
    });
    const body = prov.provisionReportBody(report, {
      users: ["reviewer"],
      at: "2026-10-06T12:00:00.000Z",
    });
    expect(body).toEqual({
      version: 1,
      at: "2026-10-06T12:00:00.000Z",
      ok: false,
      users: ["reviewer"],
      created: ["reviewer"],
      kept: [],
      failed: [],
      reviewer: "refused",
      errors: [expect.stringContaining("does NOT authenticate")],
    });
    expect(JSON.stringify(body)).not.toContain("secret-value");
  });

  it("is written atomically where the DAEMON reads it, and reads back as the same verdict", () => {
    const dir = mkdtempSync(join(tmpdir(), "qcr-provreport-"));
    try {
      const path = prov.provisionReportPath(dir);
      expect(path).toBe(join(dir, "state", "openviking", "provision.json"));
      const ok = prov.writeProvisionReport(
        path,
        prov.provisionReportBody(
          {
            created: [],
            kept: ["reviewer"],
            failed: [],
            reviewer: "refused",
            ok: false,
            errors: ["the reviewer key does NOT authenticate"],
          },
          { users: ["reviewer"], at: "2026-10-06T12:00:00.000Z" },
        ),
        () => {},
      );
      expect(ok).toBe(true);
      // The daemon's reader (src/openviking/provisionreport.ts) agrees.
      expect(readProvisionReport(path)).toEqual({
        state: "failed",
        id: expect.stringMatching(/^sha256:[0-9a-f]{16}$/),
        at: "2026-10-06T12:00:00.000Z",
        created: [],
        failed: [],
        reviewer: "refused",
        errors: ["the reviewer key does NOT authenticate"],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an unwritable report is a log line, never a throw", () => {
    const dir = mkdtempSync(join(tmpdir(), "qcr-provreport-"));
    try {
      writeFileSync(join(dir, "state"), "a file where a directory must go");
      const lines: string[] = [];
      expect(
        prov.writeProvisionReport(prov.provisionReportPath(dir), { ok: true }, (l: string) =>
          lines.push(l),
        ),
      ).toBe(false);
      expect(lines.join("\n")).toContain("could not write the provisioning report");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defaults beside the daemon's state, and --report overrides it", () => {
    expect(prov.parseArgs([]).reportPath).toBe(prov.provisionReportPath(prov.ROOT));
    expect(prov.parseArgs(["--report", "/tmp/x.json"]).reportPath).toBe("/tmp/x.json");
  });

  it("main() leaves a report on EVERY exit path — the early ones too", () => {
    const src = readFileSync(resolve(process.cwd(), "scripts/openviking-provision.mjs"), "utf8");
    const mainBody = src.slice(src.indexOf("async function main"));
    expect(mainBody).toMatch(
      /finish\(failed\("openviking: --start-server needs --bin and --config/,
    );
    expect(mainBody).toMatch(
      /finish\(\s*failed\(\s*"openviking: the provisioning server never became ready/,
    );
    expect(mainBody).toMatch(/finally \{\s*finish\(report\);/);
  });
});

describe("the daemon's reading of the report (src/openviking/provisionreport.ts)", () => {
  const withFile = (body: string | undefined, fn: (path: string) => void): void => {
    const dir = mkdtempSync(join(tmpdir(), "qcr-provread-"));
    try {
      const path = join(dir, "provision.json");
      if (body !== undefined) writeFileSync(path, body);
      fn(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("no report is ABSENT and wakes nothing (a dev daemon, a script not synced)", () => {
    withFile(undefined, (path) => {
      const s = readProvisionReport(path);
      expect(s).toEqual({ state: "absent" });
      expect(provisionWake(s)).toBeNull();
    });
  });

  it("a file that is not a report is UNREADABLE — and wakes", () => {
    withFile("{ torn", (path) => {
      const s = readProvisionReport(path);
      expect(s.state).toBe("unreadable");
      expect(provisionWake(s)?.kind).toBe("memory_provision_failed");
    });
    withFile('{"at":"x"}', (path) => {
      expect(readProvisionReport(path).state).toBe("unreadable");
    });
  });

  it("a clean report wakes nothing", () => {
    withFile('{"ok":true,"created":[],"errors":[]}', (path) => {
      expect(provisionWake(readProvisionReport(path))).toBeNull();
    });
  });

  it("a provision FAILURE wakes memory_provision_failed with its errors", () => {
    withFile(
      JSON.stringify({
        ok: false,
        at: "T",
        created: [],
        failed: ["companion"],
        reviewer: "refused",
        errors: ["could not create user companion (HTTP 500)"],
      }),
      (path) => {
        const w = provisionWake(readProvisionReport(path))!;
        expect(w.kind).toBe("memory_provision_failed");
        expect(w.detail).toContain("boot provisioning FAILED");
        expect(w.detail).toContain("not ensured: companion");
        expect(w.detail).toContain("reviewer key: refused");
        expect(w.message).toContain("could not create user companion");
      },
    );
  });

  it("a RECREATED user wakes even when the report says ok — its distributed key is now wrong", () => {
    withFile(JSON.stringify({ ok: true, at: "T", created: ["reviewer"], errors: [] }), (path) => {
      const w = provisionWake(readProvisionReport(path))!;
      expect(w.kind).toBe("memory_provision_failed");
      expect(w.detail).toContain("had to CREATE reviewer");
      expect(w.message).toContain("never rotated");
    });
  });
});

// The boot step itself — where a report BECOMES a wake (S1). Driven
// against a real StateStore with its anomaly sink attached, which is exactly
// the funnel wire.ts hands it: a row in the anomaly table, and the signal the
// overseer's wake policy reads.
describe("raiseProvisionWake — the daemon's boot step over the report", () => {
  const withReport = (body: string | undefined, fn: (path: string) => void): void => {
    const dir = mkdtempSync(join(tmpdir(), "qcr-provwake-"));
    try {
      const path = join(dir, "provision.json");
      if (body !== undefined) writeFileSync(path, body);
      fn(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const harness = () => {
    const store = new StateStore(":memory:");
    const signals: Array<AnomalyRecord & { injectMessage?: string | undefined }> = [];
    store.setAnomalySink((s) => signals.push(s));
    const rows = () => store.anomalies().filter((a) => a.kind === "memory_provision_failed");
    return { store, signals, rows };
  };
  const FAILED = (at: string) =>
    JSON.stringify({ ok: false, at, created: [], failed: ["reviewer"], errors: ["boom"] });

  it("a failed report writes ONE memory_provision_failed row and reaches the wake sink", () => {
    const h = harness();
    withReport(FAILED("2026-10-06T08:00:00.000Z"), (path) => {
      expect(raiseProvisionWake(h.store, readProvisionReport(path))).toBe(true);
    });
    expect(h.rows()).toHaveLength(1);
    expect(h.signals.map((s) => s.kind)).toEqual(["memory_provision_failed"]);
    expect(h.signals[0]!.injectMessage).toContain("MEMORY PROVISIONING");
    expect(h.store.lastEventPayload(PROVISION_WOKEN_EVENT)).toMatchObject({
      at: "2026-10-06T08:00:00.000Z",
      state: "failed",
    });
  });

  it("the SAME report on a daemon restart wakes nothing; a new report wakes again", () => {
    const h = harness();
    withReport(FAILED("2026-10-06T08:00:00.000Z"), (path) => {
      expect(raiseProvisionWake(h.store, readProvisionReport(path))).toBe(true);
      expect(raiseProvisionWake(h.store, readProvisionReport(path))).toBe(false);
    });
    withReport(FAILED("2026-10-06T09:00:00.000Z"), (path) => {
      expect(raiseProvisionWake(h.store, readProvisionReport(path))).toBe(true);
    });
    expect(h.rows()).toHaveLength(2);
  });

  it("an UNREADABLE report (no `at` to key on) still wakes once, not on every restart", () => {
    const h = harness();
    withReport("{ torn", (path) => {
      const s = readProvisionReport(path);
      expect(s.state).toBe("unreadable");
      expect(s.at).toBeUndefined();
      expect(s.id).toMatch(/^sha256:/);
      expect(raiseProvisionWake(h.store, s)).toBe(true);
      expect(raiseProvisionWake(h.store, readProvisionReport(path))).toBe(false);
      expect(raiseProvisionWake(h.store, readProvisionReport(path))).toBe(false);
    });
    // A different torn file is a different report.
    withReport("{ torn differently", (path) => {
      expect(raiseProvisionWake(h.store, readProvisionReport(path))).toBe(true);
    });
    expect(h.rows()).toHaveLength(2);
  });

  it("an absent or clean report writes nothing", () => {
    const h = harness();
    withReport(undefined, (path) => {
      expect(raiseProvisionWake(h.store, readProvisionReport(path))).toBe(false);
    });
    withReport('{"ok":true,"at":"T","created":[],"errors":[]}', (path) => {
      expect(raiseProvisionWake(h.store, readProvisionReport(path))).toBe(false);
    });
    expect(h.rows()).toEqual([]);
    expect(h.signals).toEqual([]);
    expect(h.store.lastEventPayload(PROVISION_WOKEN_EVENT)).toBeNull();
  });
});

// The daemon half of the embedder migration (src/openviking/reembed.ts).
//
// The driver is a thin loop over the script: what it owes is (1) that it
// never runs before /ready, never overlaps two runs and never blocks the
// boot; (2) that the reviewer key is what it sends, read from the secrets
// file — and nothing else; (3) that the heartbeat block is HONEST: journal
// states come from the script's own reading, an unloadable script or an
// unreadable journal is `unknown`, never `none`; and (4) that config.toml's
// declared embedder against ov.conf's real one is reported as drift.
//
// Two module seams are exercised: a scripted fake (deterministic sequences)
// and the REAL scripts/openviking-reembed.mjs against a temp home and a fake
// fetch — the same discipline as tests/tui-memforward.test.ts, which checks the
// real forward module still satisfies the interface the TUI declares.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  OPENVIKING_DEFAULTS,
  resolveOpenVikingPaths,
  type OpenVikingConfig,
} from "../src/config.js";
import { ReembedDriver, reembedNamespaces, type ReembedModule } from "../src/openviking/reembed.js";
import { StateStore, buildStatusSnapshot } from "../src/state.js";
import * as realModule from "../scripts/openviking-reembed.mjs";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "qcr-reembed-driver-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const cfg = (over: Partial<OpenVikingConfig> = {}): OpenVikingConfig =>
  resolveOpenVikingPaths({ ...OPENVIKING_DEFAULTS, home, ...over });

/** A timer seam that records callbacks instead of running them. */
class FakeClock {
  pending: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  schedule = (fn: () => void, ms: number): (() => void) => {
    const entry = { fn, ms, cancelled: false };
    this.pending.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };
  live(): Array<{ fn: () => void; ms: number; cancelled: boolean }> {
    return this.pending.filter((p) => !p.cancelled);
  }
  async fire(): Promise<number> {
    const entry = this.live()[0];
    if (!entry) throw new Error("nothing scheduled");
    entry.cancelled = true;
    entry.fn();
    await flush();
    return entry.ms;
  }
}
const flush = () => new Promise((r) => setTimeout(r, 0));

// The engine's built-in local embedder — what an entrypoint that predates the
// local English embedder still renders.
const LOCAL = { provider: "local", model: "bge-small-zh-v1.5-f16", dimension: 512 };
const HOSTED = { provider: "openai", model: "text-embedding-3-small", dimension: 1536 };
// The local English embedder as ov.conf spells it — the engine's
// OpenAI-compatible provider at the loopback service.
const LOCAL_EN = { provider: "openai", model: "bge-small-en-v1.5-f16", dimension: 384 };
const LOCAL_EN_BASE = "http://127.0.0.1:1934/v1";

interface FakeState {
  journal: ReturnType<ReembedModule["journalStatus"]>;
  resumes: Array<{ home: string; base: string; key: string; user: string }>;
  outcomes: Array<{ state: string; detail: string }>;
  ovConf?: unknown;
}

function fakeModule(state: FakeState): ReembedModule {
  return {
    journalStatus: () => state.journal,
    sameEmbedder: (a, b) =>
      a.provider === b.provider &&
      a.model === b.model &&
      Number(a.dimension) === Number(b.dimension),
    configuredEmbedder: (conf) => {
      const dense = (conf as { embedding?: { dense?: typeof LOCAL } })?.embedding?.dense ?? LOCAL;
      return { provider: dense.provider, model: dense.model, dimension: dense.dimension };
    },
    async resume(opts) {
      state.resumes.push({ home: opts.home, base: opts.base, key: opts.key, user: opts.user });
      const next = state.outcomes.shift() ?? { state: "completed", detail: "done" };
      state.journal = { ...state.journal, state: next.state as FakeState["journal"]["state"] };
      return { action: "reindex", state: next.state, entry: { detail: next.detail } };
    },
    async reindexNamespace() {
      throw new Error("not used by the driver");
    },
  };
}

function driver(
  state: FakeState,
  over: {
    ready?: () => boolean;
    cfg?: Partial<OpenVikingConfig>;
    log?: string[];
    load?: () => Promise<ReembedModule>;
  } = {},
) {
  const clock = new FakeClock();
  const lines = over.log ?? [];
  writeFileSync(join(home, "openviking_reviewer_key"), "reviewer-secret\n");
  const d = new ReembedDriver({
    cfg: cfg(over.cfg),
    repoRoot: home,
    keyPath: join(home, "openviking_reviewer_key"),
    ready: over.ready ?? (() => true),
    log: (m, extra) => lines.push(extra === undefined ? m : `${m} ${String(extra)}`),
    schedule: clock.schedule,
    load: over.load ?? (async () => fakeModule(state)),
    pollMs: 15_000,
    retryMs: 300_000,
    now: () => new Date("2026-09-02T18:00:00.000Z"),
  });
  return { d, clock, lines };
}

async function started(state: FakeState, over: Parameters<typeof driver>[1] = {}) {
  const h = driver(state, over);
  h.d.start();
  await flush();
  return h;
}

describe("the resume loop", () => {
  it("nothing on record ⇒ no timer, no resume, status none", async () => {
    const state: FakeState = { journal: { state: "none" }, resumes: [], outcomes: [] };
    const { d, clock } = await started(state);
    expect(clock.live()).toHaveLength(0);
    expect(state.resumes).toHaveLength(0);
    expect(d.status()).toEqual({ state: "none", attempts: 0 });
  });

  it("pending ⇒ waits for /ready on the poll interval, then resumes ONCE with the reviewer key from the secrets file", async () => {
    const state: FakeState = {
      journal: {
        state: "pending",
        embedder: LOCAL,
        previous: HOSTED,
        reset_at: "2026-09-02T15:00:00.000Z",
        namespaces: { reviewer: { state: "pending" } },
      },
      resumes: [],
      outcomes: [],
    };
    let ready = false;
    const { d, clock } = await started(state, { ready: () => ready });
    expect(d.status().state).toBe("pending");
    // Armed immediately, but the server is not ready: back off, no resume.
    expect(await clock.fire()).toBe(0);
    expect(state.resumes).toHaveLength(0);
    expect(clock.live()[0]?.ms).toBe(15_000);
    ready = true;
    await clock.fire();
    expect(state.resumes).toEqual([
      { home, base: "http://127.0.0.1:1933", key: "reviewer-secret", user: "reviewer" },
    ]);
    expect(d.status()).toMatchObject({
      state: "completed",
      attempts: 1,
      last_run_at: "2026-09-02T18:00:00.000Z",
      embedder: LOCAL,
      previous: HOSTED,
    });
    expect(d.status().last_error).toBeUndefined();
    // Completed: nothing further is scheduled.
    expect(clock.live()).toHaveLength(0);
  });

  it("a run that did not complete is retried on the retry interval — forever, each attempt on record", async () => {
    const state: FakeState = {
      journal: { state: "pending", namespaces: { reviewer: { state: "pending" } } },
      resumes: [],
      outcomes: [
        { state: "pending", detail: "busy" },
        { state: "failed", detail: "task failed: embedder exploded" },
        { state: "completed", detail: "14 records" },
      ],
    };
    const { d, clock, lines } = await started(state);
    await clock.fire();
    expect(d.status()).toMatchObject({ state: "pending", attempts: 1, last_error: "busy" });
    expect(clock.live()[0]?.ms).toBe(300_000);
    await clock.fire();
    expect(d.status()).toMatchObject({
      state: "failed",
      attempts: 2,
      last_error: "task failed: embedder exploded",
    });
    expect(clock.live()[0]?.ms).toBe(300_000);
    await clock.fire();
    expect(d.status()).toMatchObject({ state: "completed", attempts: 3 });
    expect(d.status().last_error).toBeUndefined();
    expect(clock.live()).toHaveLength(0);
    expect(lines.join("\n")).toContain("retrying in 300s");
    expect(lines.join("\n")).toContain("completed — 14 records");
  });

  it("stop() cancels the loop; start() is idempotent; a disabled engine arms nothing", async () => {
    const state: FakeState = { journal: { state: "pending" }, resumes: [], outcomes: [] };
    const { d, clock } = await started(state, { ready: () => false });
    d.start();
    await flush();
    expect(clock.live()).toHaveLength(1);
    d.stop();
    expect(clock.live()).toHaveLength(0);
    const off = await started(
      { journal: { state: "pending" }, resumes: [], outcomes: [] },
      { cfg: { enabled: false } },
    );
    expect(off.clock.live()).toHaveLength(0);
    expect(off.d.status()).toEqual({ state: "unknown", attempts: 0 });
  });
});

describe("honest status", () => {
  it("an unloadable script is `unknown` with the reason — never `none`", async () => {
    const { d, lines } = await started(
      { journal: { state: "none" }, resumes: [], outcomes: [] },
      {
        load: async () => {
          throw new Error("ENOENT scripts/openviking-reembed.mjs");
        },
      },
    );
    expect(d.status()).toMatchObject({
      state: "unknown",
      last_error: expect.stringContaining("could not load"),
    });
    expect(lines.join("\n")).toContain("reembed driver off");
  });

  it("an unreadable journal is reported as such, logged for an operator, and never resumed", async () => {
    const state: FakeState = { journal: { state: "unreadable" }, resumes: [], outcomes: [] };
    const { d, clock, lines } = await started(state);
    expect(d.status().state).toBe("unreadable");
    expect(clock.live()).toHaveLength(0);
    expect(lines.join("\n")).toContain("cannot be parsed");
  });

  it("an operator's `settle` after completion reaches the heartbeat without a restart (selfscan bfd61967)", async () => {
    const state: FakeState = {
      journal: {
        state: "pending",
        awaiting_operator: ["companion"],
        namespaces: { reviewer: { state: "pending" } },
      },
      resumes: [],
      outcomes: [{ state: "completed", detail: "14 records" }],
    };
    const { d, clock } = await started(state);
    await clock.fire();
    expect(d.status()).toMatchObject({ state: "completed", awaiting_operator: ["companion"] });
    expect(clock.live()).toHaveLength(0);
    // `openviking-reembed.mjs settle --user companion` rewrites the journal on
    // disk; no timer is armed any more, so only the read behind status() sees it.
    state.journal = { state: "completed", namespaces: { reviewer: { state: "completed" } } };
    expect(d.status().awaiting_operator).toBeUndefined();
  });

  it("a journal that stops reading after boot is `unknown` in the next status, logged once", async () => {
    const lines: string[] = [];
    const mod = fakeModule({ journal: { state: "none" }, resumes: [], outcomes: [] });
    const { d } = await started(
      { journal: { state: "none" }, resumes: [], outcomes: [] },
      { load: async () => mod, log: lines },
    );
    mod.journalStatus = () => {
      throw new Error("disk on fire");
    };
    expect(d.status()).toMatchObject({
      state: "unknown",
      last_error: expect.stringContaining("disk on fire"),
    });
    d.status();
    expect(lines.filter((l) => l.includes("disk on fire"))).toHaveLength(1);
  });

  it("a journalStatus that throws is `unknown`, not a crash", async () => {
    const mod = fakeModule({ journal: { state: "none" }, resumes: [], outcomes: [] });
    mod.journalStatus = () => {
      throw new Error("disk on fire");
    };
    const { d } = await started(
      { journal: { state: "none" }, resumes: [], outcomes: [] },
      { load: async () => mod },
    );
    expect(d.status()).toMatchObject({
      state: "unknown",
      last_error: expect.stringContaining("disk on fire"),
    });
  });

  it("rides the heartbeat inside the openviking block, operator rows included", () => {
    const store = new StateStore(":memory:");
    try {
      const snapshot = buildStatusSnapshot(store, false, undefined, undefined, 2, undefined, {
        enabled: true,
        running: true,
        reachable: true,
        ready: true,
        pinned_version: "0.4.15",
        restarts: 0,
        reembed: {
          state: "completed",
          attempts: 1,
          awaiting_operator: ["companion"],
          namespaces: { reviewer: { state: "completed" }, companion: { state: "operator" } },
        },
      });
      expect(snapshot.openviking?.reembed).toMatchObject({
        state: "completed",
        awaiting_operator: ["companion"],
      });
    } finally {
      store.close();
    }
  });
});

describe("config.toml against ov.conf", () => {
  function ovConf(dense: unknown): void {
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "ov.conf"),
      JSON.stringify({ server: { port: 1933 }, embedding: { dense } }),
    );
  }

  const renderedLocal = {
    ...LOCAL_EN,
    api_base: LOCAL_EN_BASE,
    query_param: "query",
    document_param: "passage",
    input: "text",
  };

  it("agreeing embedders ⇒ no drift reported (the local English embedder, as the entrypoint renders it)", async () => {
    ovConf(renderedLocal);
    const { d } = await started({ journal: { state: "none" }, resumes: [], outcomes: [] });
    expect(d.status().config_drift).toBeUndefined();
  });

  it("a trailing slash on api_base is not drift", async () => {
    ovConf({ ...renderedLocal, api_base: `${LOCAL_EN_BASE}/` });
    const { d } = await started({ journal: { state: "none" }, resumes: [], outcomes: [] });
    expect(d.status().config_drift).toBeUndefined();
  });

  it("config.toml declaring local over an ov.conf that runs a hosted embedder is DRIFT — logged and in the heartbeat, never corrected", async () => {
    ovConf({ ...HOSTED, input: "text", api_key: "sk-should-not-appear" });
    const { d, lines } = await started({ journal: { state: "none" }, resumes: [], outcomes: [] });
    expect(d.status().config_drift).toEqual({
      config_toml: { ...LOCAL_EN, api_base: LOCAL_EN_BASE },
      ov_conf: HOSTED,
    });
    expect(JSON.stringify(d.status())).not.toContain("sk-should-not-appear");
    expect(lines.join("\n")).toContain("EMBEDDER DRIFT");
    expect(readFileSync(join(home, "ov.conf"), "utf8")).toContain("text-embedding-3-small"); // untouched
  });

  // A `sync` without the `rebuild` keeps the image's old entrypoint,
  // which still renders the engine's built-in Chinese model.
  it("an ov.conf from an entrypoint that predates the local English embedder is DRIFT", async () => {
    ovConf({ ...LOCAL, input: "text" });
    const { d, lines } = await started({ journal: { state: "none" }, resumes: [], outcomes: [] });
    expect(d.status().config_drift).toEqual({
      config_toml: { ...LOCAL_EN, api_base: LOCAL_EN_BASE },
      ov_conf: LOCAL,
    });
    expect(lines.join("\n")).toMatch(/EMBEDDER DRIFT — config\.toml \[openviking\] declares local/);
  });

  it("the right model at another loopback port is DRIFT — the record alone cannot tell, the api_base can", async () => {
    ovConf({ ...renderedLocal, api_base: "http://127.0.0.1:1999/v1" });
    const { d } = await started({ journal: { state: "none" }, resumes: [], outcomes: [] });
    expect(d.status().config_drift).toEqual({
      config_toml: { ...LOCAL_EN, api_base: LOCAL_EN_BASE },
      ov_conf: { ...LOCAL_EN, api_base: "http://127.0.0.1:1999/v1" },
    });
  });

  it("a hosted opt-in over a hosted ov.conf agrees — no api_base on either side", async () => {
    ovConf({ ...HOSTED, input: "text", api_key: "sk-x" });
    const { d } = await started(
      { journal: { state: "none" }, resumes: [], outcomes: [] },
      {
        cfg: {
          embedding_provider: "openai",
          embedding_model: HOSTED.model,
          embedding_dimension: HOSTED.dimension,
        },
      },
    );
    expect(d.status().config_drift).toBeUndefined();
  });

  it("no ov.conf (a dev PC) ⇒ nothing to compare, nothing reported", async () => {
    const { d, lines } = await started({ journal: { state: "none" }, resumes: [], outcomes: [] });
    expect(d.status().config_drift).toBeUndefined();
    expect(lines.join("\n")).not.toContain("DRIFT");
  });
});

// ---- the REAL script through the driver ---------------------------------------

describe("the real scripts/openviking-reembed.mjs satisfies the driver's contract", () => {
  const REINDEX = /\/api\/v1\/content\/reindex$/;
  const TASK = /\/api\/v1\/tasks\/task-9$/;

  it(
    "a journalled pending reviewer namespace is re-embedded through the script with a Bearer reviewer key and no actor-peer header",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const mod: ReembedModule = realModule;
      mod.journalStatus(home); // the module's own reader, on an empty home
      realModule.writeJournal(home, {
        version: 1,
        embedder: LOCAL,
        previous: HOSTED,
        reset_at: "2026-09-02T15:00:00.000Z",
        namespaces: { reviewer: { state: "pending" }, companion: { state: "operator" } },
      });
      const calls: Array<{ url: string; headers: Record<string, string>; body?: string }> = [];
      const fetchFn = async (
        url: string,
        init?: { headers?: Record<string, string>; body?: string },
      ) => {
        calls.push({ url, headers: init?.headers ?? {}, body: init?.body });
        if (REINDEX.test(url))
          return {
            status: 200,
            json: async () => ({ status: "ok", result: { task_id: "task-9", status: "accepted" } }),
          };
        if (TASK.test(url))
          return {
            status: 200,
            json: async () => ({
              status: "ok",
              result: {
                task_id: "task-9",
                status: "completed",
                result: {
                  scanned_records: 3,
                  rebuilt_records: 4,
                  failed_records: 0,
                  unsupported_records: 0,
                },
              },
            }),
          };
        return { status: 404, json: async () => ({}) };
      };
      const clock = new FakeClock();
      writeFileSync(join(home, "openviking_reviewer_key"), "reviewer-secret");
      const lines: string[] = [];
      const d = new ReembedDriver({
        cfg: cfg(),
        repoRoot: home,
        keyPath: join(home, "openviking_reviewer_key"),
        ready: () => true,
        log: (m) => lines.push(m),
        schedule: clock.schedule,
        load: async () => mod,
        fetchFn,
      });
      d.start();
      await flush();
      expect(d.status().state).toBe("pending");
      await clock.fire();
      // The script polls the task on a real 2s sleep; wait for it to settle by
      // deadline, not by a count of ticks, which is too tight on a loaded
      // machine. The deadline sits inside the
      // test's timeout, so a miss still fails on the assertion below.
      const deadline = Date.now() + 45_000;
      while (d.status().state !== "completed" && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 50));
      expect(d.status()).toMatchObject({
        state: "completed",
        attempts: 1,
        awaiting_operator: ["companion"],
      });
      expect(calls[0]!.headers["Authorization"]).toBe("Bearer reviewer-secret");
      expect(calls[0]!.headers["X-OpenViking-User"]).toBe("reviewer");
      expect(calls[0]!.headers["X-OpenViking-Actor-Peer"]).toBeUndefined();
      expect(JSON.parse(calls[0]!.body!)).toEqual({
        uri: "viking://user/reviewer",
        mode: "vectors_only",
        wait: false,
      });
      const journal = JSON.parse(readFileSync(join(home, "reembed.json"), "utf8"));
      expect(journal.namespaces.reviewer).toMatchObject({
        state: "completed",
        rebuilt_records: 4,
        task_id: "task-9",
      });
      expect(journal.namespaces.companion).toEqual({ state: "operator" });
    },
  );
});

// ---- the operator's side ----------------------------------------------------------

describe("reembedNamespaces — qcr memory reembed", () => {
  it("re-embeds each named namespace with ITS key, reports a missing key, and is ok only when every one completed clean", async () => {
    const sent: Array<{ user: string; key: string; base: string }> = [];
    const module: Pick<ReembedModule, "reindexNamespace"> = {
      async reindexNamespace({ base, key, user }) {
        sent.push({ user, key, base });
        if (user === "companion")
          return {
            status: "completed",
            uri: `viking://user/${user}`,
            scanned_records: 7,
            rebuilt_records: 9,
            failed_records: 0,
            unsupported_records: 0,
          };
        return { status: "failed", uri: `viking://user/${user}`, detail: "refused (HTTP 403)" };
      },
    };
    const keys: Record<string, string> = { companion: "companion-key", reviewer: "reviewer-key" };
    const lines: string[] = [];
    const clean = await reembedNamespaces({
      module,
      base: "http://127.0.0.1:1933",
      users: ["companion"],
      keyFor: (u) => keys[u] ?? null,
      log: (l) => lines.push(l),
    });
    expect(clean).toEqual({
      ok: true,
      results: [
        {
          user: "companion",
          status: "completed",
          detail: "9 vector records rebuilt from 7 sources",
        },
      ],
    });
    expect(sent).toEqual([
      { user: "companion", key: "companion-key", base: "http://127.0.0.1:1933" },
    ]);

    const mixed = await reembedNamespaces({
      module,
      base: "http://127.0.0.1:1933",
      users: ["companion", "reviewer", "ghost"],
      keyFor: (u) => keys[u] ?? null,
      log: () => {},
    });
    expect(mixed.ok).toBe(false);
    expect(mixed.results.map((r) => [r.user, r.status])).toEqual([
      ["companion", "completed"],
      ["reviewer", "failed"],
      ["ghost", "no-key"],
    ]);
    expect(mixed.results[1]!.detail).toContain("403");
    // No key ever appears in what is reported.
    expect(JSON.stringify(mixed)).not.toContain("companion-key");
  });

  it("a completed run with failed records is NOT ok — the operator is told to run it again", async () => {
    const module: Pick<ReembedModule, "reindexNamespace"> = {
      async reindexNamespace() {
        return {
          status: "completed",
          uri: "viking://user/companion",
          scanned_records: 7,
          rebuilt_records: 5,
          failed_records: 2,
          unsupported_records: 0,
        };
      },
    };
    const r = await reembedNamespaces({
      module,
      base: "http://x",
      users: ["companion"],
      keyFor: () => "k",
      log: () => {},
    });
    expect(r.ok).toBe(false);
    expect(r.results[0]!.detail).toContain("2 FAILED (run it again)");
  });
});

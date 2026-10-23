// The local English embedder under the daemon, and the server's
// start gate on it. No process, socket or clock: the spawn, fetch, ov.conf and
// timer seams carry everything.
//
// What is pinned:
//   * the daemon starts the embedder only when it is the embedder in use —
//     config.toml says local AND the rendered ov.conf routes to this config's
//     loopback api_base — and always says why when it does not;
//   * a missing interpreter, script or model file is reported once and never
//     respawned (it needs a rebuild, not a retry);
//   * a crash respawns on the ladder forever; ready is a 200 from /health;
//   * the server's FIRST start waits for the embedder, bounded — and never
//     for one that will not come; a respawn never waits;
//   * the heartbeat carries the embedder block beside the server's.
import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { StateStore, buildStatusSnapshot } from "../src/state.js";
import {
  OPENVIKING_DEFAULTS,
  resolveOpenVikingPaths,
  type OpenVikingConfig,
} from "../src/config.js";
import {
  EMBEDDER_FAST_POLL_MS,
  LocalEmbedderSupervisor,
  OpenVikingSupervisor,
  localEmbedderOffReason,
  memoryServing,
  type FetchLike,
  type LocalEmbedderStatus,
  type OpenVikingStatus,
  type SupervisedChild,
} from "../src/openviking/index.js";

const cfg = (over: Partial<OpenVikingConfig> = {}): OpenVikingConfig =>
  resolveOpenVikingPaths({ ...OPENVIKING_DEFAULTS, ...over });

const RENDERED_LOCAL = JSON.stringify({
  embedding: {
    dense: {
      provider: "openai",
      model: "bge-small-en-v1.5-f16",
      dimension: 384,
      api_base: "http://127.0.0.1:1934/v1",
      query_param: "query",
      document_param: "passage",
      input: "text",
    },
  },
});
const RENDERED_OLD = JSON.stringify({
  embedding: { dense: { provider: "local", model: "bge-small-zh-v1.5-f16", dimension: 512 } },
});

class FakeChild extends EventEmitter implements SupervisedChild {
  readonly pid: number | undefined;
  stdout = new EventEmitter() as unknown as SupervisedChild["stdout"];
  stderr = new EventEmitter() as unknown as SupervisedChild["stderr"];
  killed: NodeJS.Signals[] = [];
  constructor(pid: number | undefined) {
    super();
    this.pid = pid;
  }
  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killed.push(signal);
    this.emit("exit", 0, signal);
    return true;
  }
  say(text: string): void {
    (this.stdout as unknown as EventEmitter).emit("data", Buffer.from(text));
  }
}

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
  /** Fire the first live callback scheduled with this delay. */
  fireMs(ms: number): void {
    const entry = this.live().find((p) => p.ms === ms);
    if (!entry)
      throw new Error(
        `nothing scheduled at ${ms}ms (have ${this.live()
          .map((p) => p.ms)
          .join(",")})`,
      );
    entry.cancelled = true;
    entry.fn();
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function harness(
  over: Partial<OpenVikingConfig> = {},
  opts: { ovConf?: string | null; exists?: (p: string) => boolean; healthy?: () => boolean } = {},
) {
  const clock = new FakeClock();
  const children: FakeChild[] = [];
  const spawns: Array<{ cmd: string; args: string[] }> = [];
  const lines: string[] = [];
  const probes: string[] = [];
  let nextPid = 500;
  const fetchFn: FetchLike = async (url) => {
    probes.push(url);
    const ok = opts.healthy ? opts.healthy() : true;
    return { ok, status: ok ? 200 : 503, json: async () => ({}) };
  };
  const sup = new LocalEmbedderSupervisor({
    cfg: cfg(over),
    repoRoot: "/opt/quickreview/sandbox",
    log: (m) => lines.push(m),
    spawn: (cmd, args) => {
      spawns.push({ cmd, args });
      const c = new FakeChild(nextPid++);
      children.push(c);
      return c;
    },
    fetchFn,
    exists: opts.exists ?? (() => true),
    readOvConf: () => (opts.ovConf === undefined ? RENDERED_LOCAL : opts.ovConf),
    schedule: clock.schedule,
    now: () => new Date("2026-10-07T10:00:00Z"),
  });
  return { sup, clock, children, spawns, lines, probes };
}

describe("when the daemon runs the local embedder", () => {
  it("config.toml local + an ov.conf routed to its loopback api_base ⇒ spawned with the pinned argv", () => {
    const h = harness();
    h.sup.start();
    expect(h.spawns).toEqual([
      {
        cmd: "/opt/openviking/venv/bin/python",
        args: [
          "/opt/quickreview/sandbox/scripts/openviking-embedder.py",
          "--model-path",
          "/opt/openviking/models/bge-small-en-v1.5-f16.gguf",
          "--model-name",
          "bge-small-en-v1.5-f16",
          "--sha256",
          OPENVIKING_DEFAULTS.local_embedder_sha256,
          "--host",
          "127.0.0.1",
          "--port",
          "1934",
          "--threads",
          "1",
        ],
      },
    ]);
    expect(h.sup.status()).toMatchObject({ state: "supervised", running: true, ready: false });
  });

  it("a hosted opt-in ⇒ nothing spawned, and the reason says so (no log noise: it is not the embedder in use)", () => {
    const h = harness({
      embedding_provider: "openai",
      embedding_model: "text-embedding-3-small",
      embedding_dimension: 1536,
    });
    h.sup.start();
    expect(h.spawns).toHaveLength(0);
    expect(h.sup.status()).toMatchObject({ state: "off", running: false, ready: false });
    expect(h.sup.status().reason).toMatch(/hosted 'openai' provider/);
    expect(h.lines).toEqual([]);
    expect(h.sup.gateOpen()).toBe(true);
  });

  it("an ov.conf from an entrypoint that predates it (a sync without the rebuild) ⇒ off, loudly, naming the rebuild", () => {
    const h = harness({}, { ovConf: RENDERED_OLD });
    h.sup.start();
    expect(h.spawns).toHaveLength(0);
    const reason = h.sup.status().reason ?? "";
    expect(reason).toMatch(
      /does not route embeddings to http:\/\/127\.0\.0\.1:1934\/v1 \(it says provider 'local'\)/,
    );
    expect(reason).toMatch(/scripts\/deploy\.sh rebuild/);
    expect(h.lines.join("\n")).toMatch(/local embedder NOT started/);
    expect(h.sup.gateOpen()).toBe(true);
  });

  it("an unreadable or garbled ov.conf ⇒ off with that reason", () => {
    expect(localEmbedderOffReason(cfg(), null)).toMatch(/could not be read/);
    expect(localEmbedderOffReason(cfg(), "{nope")).toMatch(/is not JSON/);
    expect(localEmbedderOffReason(cfg(), RENDERED_LOCAL)).toBeNull();
    expect(localEmbedderOffReason(cfg(), RENDERED_LOCAL.replace("1934/v1", "1934/v1/"))).toBeNull();
    expect(localEmbedderOffReason(cfg({ local_embedder_port: 1999 }), RENDERED_LOCAL)).toMatch(
      /does not route embeddings to http:\/\/127\.0\.0\.1:1999\/v1 \(it says api_base http:\/\/127\.0\.0\.1:1934\/v1\)/,
    );
  });

  // A port mismatch is not "an image that needs a rebuild".
  it("tells a port mismatch, an ov.conf that predates it and another embedder apart — each with its own fix", () => {
    const mismatch =
      localEmbedderOffReason(cfg({ local_embedder_port: 1999 }), RENDERED_LOCAL) ?? "";
    expect(mismatch).toMatch(/local_embedder_port and the port the boot rendered disagree/);
    expect(mismatch).toMatch(/nothing serves http:\/\/127\.0\.0\.1:1934\/v1/);
    expect(mismatch).toContain("QCR_OPENVIKING_LOCAL_EMBEDDER_PORT");
    expect(mismatch).not.toMatch(/rebuild/);

    const old = localEmbedderOffReason(cfg(), RENDERED_OLD) ?? "";
    expect(old).toMatch(/predates the local English embedder/);
    expect(old).toMatch(/scripts\/deploy\.sh rebuild/);

    const hosted =
      localEmbedderOffReason(
        cfg(),
        RENDERED_LOCAL.replace("http://127.0.0.1:1934/v1", "https://api.openai.com/v1"),
      ) ?? "";
    expect(hosted).toMatch(/config\.toml says local, but the boot rendered another embedder/);
    expect(hosted).not.toMatch(/rebuild|local_embedder_port/);
  });

  it("memory disabled ⇒ nothing at all", () => {
    const h = harness({ enabled: false });
    h.sup.start();
    expect(h.spawns).toHaveLength(0);
    expect(h.sup.status().reason).toMatch(/disabled/);
  });

  for (const [what, suffix] of [
    ["interpreter", "/bin/python"],
    ["service script", "openviking-embedder.py"],
    ["model file", ".gguf"],
  ] as const) {
    it(`a missing ${what} ⇒ unavailable, reported ONCE, never spawned or retried`, () => {
      const h = harness({}, { exists: (p) => !p.endsWith(suffix) });
      h.sup.start();
      h.sup.start();
      expect(h.spawns).toHaveLength(0);
      expect(h.clock.live()).toHaveLength(0);
      expect(h.sup.status()).toMatchObject({ state: "unavailable", running: false, ready: false });
      expect(h.sup.status().reason).toContain(`${what} not found`);
      expect(h.lines.filter((l) => l.includes("unavailable"))).toHaveLength(1);
      // Never waited for: the server starts at once.
      expect(h.sup.gateOpen()).toBe(true);
    });
  }
});

describe("readiness and the restart ladder", () => {
  it("ready is a 200 from /health on the loopback port, polled fast until it first answers, then at the health cadence", async () => {
    let healthy = false;
    const h = harness({}, { healthy: () => healthy });
    h.sup.start();
    expect(h.sup.gateOpen()).toBe(false);
    h.clock.fireMs(EMBEDDER_FAST_POLL_MS);
    await flush();
    expect(h.probes).toEqual(["http://127.0.0.1:1934/health"]);
    expect(h.sup.isReady()).toBe(false);
    expect(h.sup.gateOpen()).toBe(false);
    healthy = true;
    h.clock.fireMs(EMBEDDER_FAST_POLL_MS);
    await flush();
    expect(h.sup.isReady()).toBe(true);
    expect(h.sup.gateOpen()).toBe(true);
    expect(h.lines.join("\n")).toMatch(/local embedder ready/);
    // Next probe at the server's health interval, not the fast poll.
    expect(h.clock.live().map((p) => p.ms)).toEqual([cfg().health_interval_s * 1000]);
    // Stops answering ⇒ not ready, said once.
    healthy = false;
    h.clock.fireMs(cfg().health_interval_s * 1000);
    await flush();
    expect(h.sup.isReady()).toBe(false);
    expect(h.lines.join("\n")).toMatch(/stopped answering/);
  });

  it("a probe answered after its child was replaced neither readies the replacement nor re-arms its polling", async () => {
    // The first probe hangs until released; the child it probed dies and is
    // replaced meanwhile.
    let release: (ok: boolean) => void = () => undefined;
    let held = true;
    const clock = new FakeClock();
    const children: FakeChild[] = [];
    let pid = 700;
    const sup = new LocalEmbedderSupervisor({
      cfg: cfg(),
      repoRoot: "/opt/quickreview/sandbox",
      log: () => undefined,
      spawn: () => {
        const c = new FakeChild(pid++);
        children.push(c);
        return c;
      },
      fetchFn: async () => {
        const ok = held ? await new Promise<boolean>((r) => (release = r)) : false;
        return { ok, status: ok ? 200 : 503, json: async () => ({}) };
      },
      exists: () => true,
      readOvConf: () => RENDERED_LOCAL,
      schedule: clock.schedule,
      now: () => new Date("2026-10-07T10:00:00Z"),
    });
    sup.start();
    clock.fireMs(EMBEDDER_FAST_POLL_MS); // the probe of child 0 is now in flight
    children[0]!.emit("exit", 1, null);
    clock.fireMs(cfg().restart_backoff_ms[0]!); // child 1, with its own fast probe armed
    expect(children).toHaveLength(2);
    held = false;
    release(true); // child 0's probe answers 200 — about a process that is gone
    await flush();
    expect(sup.isReady()).toBe(false);
    // Only child 1's own fast probe is armed, never a slow one from the stale answer.
    expect(clock.live().map((p) => p.ms)).toEqual([EMBEDDER_FAST_POLL_MS]);
  });

  it("folds the service's own lines into the daemon log", () => {
    const h = harness();
    h.sup.start();
    h.children[0]!.say("openviking-embedder: ready — bge-small-en-v1.5-f16 (384 dims…\npartial");
    expect(h.lines).toContain("openviking-embedder: ready — bge-small-en-v1.5-f16 (384 dims…");
    expect(h.lines.join("\n")).not.toContain("partial");
  });

  it("a crash respawns on the backoff ladder, forever, and is not ready until it answers again", async () => {
    const h = harness();
    h.sup.start();
    h.clock.fireMs(EMBEDDER_FAST_POLL_MS);
    await flush();
    expect(h.sup.isReady()).toBe(true);
    h.children[0]!.emit("exit", 3, null);
    expect(h.sup.isReady()).toBe(false);
    expect(h.sup.status()).toMatchObject({ running: false, restarts: 1, last_exit: { code: 3 } });
    const ladder = cfg().restart_backoff_ms;
    h.clock.fireMs(ladder[0]!);
    expect(h.spawns).toHaveLength(2);
    h.children[1]!.emit("exit", 3, null);
    h.clock.fireMs(ladder[1]!);
    expect(h.spawns).toHaveLength(3);
    expect(h.sup.status().restarts).toBe(2);
  });

  it("a replacement child has not been probed: the last child's probe time does not carry over", async () => {
    const h = harness();
    h.sup.start();
    h.clock.fireMs(EMBEDDER_FAST_POLL_MS);
    await flush();
    expect(h.sup.status().checked_at).toBeDefined();
    h.children[0]!.emit("exit", 3, null);
    h.clock.fireMs(cfg().restart_backoff_ms[0]!);
    expect(h.spawns).toHaveLength(2);
    expect(h.sup.status()).toMatchObject({ running: true, ready: false });
    expect(h.sup.status().checked_at).toBeUndefined();
  });

  it("stop() SIGTERMs the child and cancels a pending restart", async () => {
    const h = harness();
    h.sup.start();
    const child = h.children[0]!;
    await h.sup.stop();
    expect(child.killed).toEqual(["SIGTERM"]);
    expect(h.sup.status().running).toBe(false);
    expect(h.sup.gateOpen()).toBe(true);
    // A crash after stop never respawns.
    const h2 = harness();
    h2.sup.start();
    h2.children[0]!.emit("exit", 1, null);
    await h2.sup.stop();
    expect(h2.clock.live()).toHaveLength(0);
  });
});

describe("the server's start gate", () => {
  function server(
    gate: { open: () => boolean; maxWaitMs: number },
    clock: FakeClock,
    t: { now: number },
  ) {
    const spawns: string[] = [];
    const lines: string[] = [];
    const sup = new OpenVikingSupervisor({
      cfg: cfg(),
      log: (m) => lines.push(m),
      spawn: (cmd) => {
        spawns.push(cmd);
        return new FakeChild(900);
      },
      fetchFn: async () => ({ ok: false, status: 503, json: async () => ({}) }),
      exists: () => true,
      schedule: clock.schedule,
      now: () => new Date(t.now),
      startGate: { ...gate, pollMs: 500, what: "the local embedder" },
    });
    return { sup, spawns, lines };
  }

  it("an open gate starts the server at once", () => {
    const clock = new FakeClock();
    const s = server({ open: () => true, maxWaitMs: 120_000 }, clock, { now: 0 });
    s.sup.start();
    expect(s.spawns).toHaveLength(1);
    expect(s.sup.status().waiting_for).toBeUndefined();
  });

  it("a closed gate holds the FIRST start — start() still returns at once — until it opens", () => {
    const clock = new FakeClock();
    let open = false;
    const t = { now: 0 };
    const s = server({ open: () => open, maxWaitMs: 120_000 }, clock, t);
    s.sup.start();
    expect(s.spawns).toHaveLength(0);
    expect(s.sup.status()).toMatchObject({ running: false, ready: false });
    expect(s.sup.status().waiting_for).toMatch(
      /^the local embedder \(since 1970-01-01T00:00:00\.000Z\)$/,
    );
    t.now = 1_000;
    clock.fireMs(500);
    expect(s.spawns).toHaveLength(0);
    open = true;
    t.now = 1_500;
    clock.fireMs(500);
    expect(s.spawns).toHaveLength(1);
    expect(s.sup.status().waiting_for).toBeUndefined();
    expect(s.lines.join("\n")).toMatch(/the local embedder is ready — starting the server/);
  });

  it("past its bound the server starts anyway, said loudly — memory is degraded, never held back for good", () => {
    const clock = new FakeClock();
    const t = { now: 0 };
    const s = server({ open: () => false, maxWaitMs: 120_000 }, clock, t);
    s.sup.start();
    t.now = 119_999;
    clock.fireMs(500);
    expect(s.spawns).toHaveLength(0);
    t.now = 120_000;
    clock.fireMs(500);
    expect(s.spawns).toHaveLength(1);
    expect(s.lines.join("\n")).toMatch(
      /the local embedder is not ready after 120s — starting the server anyway; memory search fails until it serves/,
    );
  });

  it("a respawn after a crash never waits on the gate", () => {
    const clock = new FakeClock();
    const children: FakeChild[] = [];
    let gateIsOpen = true;
    const sup = new OpenVikingSupervisor({
      cfg: cfg(),
      log: () => {},
      spawn: () => {
        const c = new FakeChild(900 + children.length);
        children.push(c);
        return c;
      },
      fetchFn: async () => ({ ok: false, status: 503, json: async () => ({}) }),
      exists: () => true,
      schedule: clock.schedule,
      startGate: { open: () => gateIsOpen, maxWaitMs: 120_000, what: "the local embedder" },
    });
    sup.start();
    expect(children).toHaveLength(1);
    // The embedder goes away AND the server crashes: the respawn still runs.
    gateIsOpen = false;
    children[0]!.emit("exit", 1, null);
    clock.fireMs(cfg().restart_backoff_ms[0]!);
    expect(children).toHaveLength(2);
  });

  it("stop() while waiting cancels the wait — shutdown never starts the server", async () => {
    const clock = new FakeClock();
    const s = server({ open: () => false, maxWaitMs: 120_000 }, clock, { now: 0 });
    s.sup.start();
    await s.sup.stop();
    expect(clock.live()).toHaveLength(0);
    expect(s.spawns).toHaveLength(0);
  });

  it("a gate that throws is no reason to keep memory down", () => {
    const clock = new FakeClock();
    const s = server(
      {
        open: () => {
          throw new Error("boom");
        },
        maxWaitMs: 120_000,
      },
      clock,
      { now: 0 },
    );
    s.sup.start();
    expect(s.spawns).toHaveLength(1);
  });

  it("with the real embedder supervisor behind it: off/unavailable never holds the server", () => {
    const clock = new FakeClock();
    const emb = harness({}, { ovConf: RENDERED_OLD }).sup;
    emb.start();
    const s = server({ open: () => emb.gateOpen(), maxWaitMs: 120_000 }, clock, { now: 0 });
    s.sup.start();
    expect(s.spawns).toHaveLength(1);
  });
});

describe("the heartbeat", () => {
  it("status.json's openviking block carries the embedder — and an off one says why", () => {
    const store = new StateStore(":memory:");
    try {
      const on = harness();
      on.sup.start();
      const off = harness({}, { ovConf: RENDERED_OLD });
      off.sup.start();
      const base = {
        enabled: true,
        running: true,
        reachable: true,
        ready: true,
        pinned_version: "0.4.15",
        restarts: 0,
      };
      for (const [sup, want] of [
        [
          on.sup,
          {
            state: "supervised",
            model: "bge-small-en-v1.5-f16",
            port: 1934,
            running: true,
            ready: false,
            pid: 500,
          },
        ],
        [off.sup, { state: "off", running: false, ready: false }],
      ] as const) {
        const snap = buildStatusSnapshot(store, false, undefined, undefined, 12, undefined, {
          ...base,
          embedder: sup.status(),
        });
        const read = JSON.parse(JSON.stringify(snap)) as {
          openviking: { embedder: Record<string, unknown> };
        };
        expect(read.openviking.embedder).toMatchObject(want);
      }
      expect(off.sup.status().reason).toMatch(/rebuild/);
    } finally {
      store.close();
    }
  });
});

// Memory health's fs/ls probe needs no embedding, so it is this
// reading of the two supervisors that tells a person search is down.
describe("memoryServing — does memory serve search?", () => {
  const server = (over: Partial<OpenVikingStatus> = {}): OpenVikingStatus => ({
    enabled: true,
    running: true,
    reachable: true,
    ready: true,
    pinned_version: "0.4.15",
    restarts: 0,
    ...over,
  });
  const emb = (over: Partial<LocalEmbedderStatus> = {}): LocalEmbedderStatus => ({
    state: "supervised",
    model: "bge-small-en-v1.5-f16",
    port: 1934,
    threads: 1,
    running: true,
    ready: true,
    restarts: 0,
    checked_at: "2026-10-07T00:00:00.000Z",
    ...over,
  });

  it("both serving ⇒ ok", () => {
    expect(memoryServing("local", server(), emb())).toEqual({ ok: true });
  });

  it("an unavailable embedder under local is NOT serving, whatever the server last said", () => {
    const a = memoryServing(
      "local",
      server(),
      emb({
        state: "unavailable",
        running: false,
        ready: false,
        reason: "model file not found: /m.gguf",
      }),
    );
    expect(a.ok).toBe(false);
    expect(a.reason).toMatch(/^the local embedder is unavailable — model file not found/);
  });

  it("a crash-looping embedder names its last exit and restarts", () => {
    const a = memoryServing(
      "local",
      server(),
      emb({
        running: false,
        ready: false,
        restarts: 4,
        last_exit: { code: 3, signal: null, at: "2026-10-07T00:01:00.000Z" },
      }),
    );
    expect(a.ok).toBe(false);
    expect(a.reason).toMatch(
      /127\.0\.0\.1:1934 is not running \(last exit code=3 signal=null at .*\), 4 restart\(s\)/,
    );
  });

  it("a live embedder that stopped answering, and one still starting, are not serving either", () => {
    expect(
      memoryServing("local", server(), emb({ ready: false, last_error: "timeout" })).reason,
    ).toMatch(/running but not answering \/health \(timeout\)/);
    expect(
      memoryServing("local", server(), emb({ ready: false, checked_at: undefined })).reason,
    ).toMatch(/starting/);
  });

  it("a server that is not answering at all is UNKNOWN here — the authenticated probe judges it", () => {
    expect(memoryServing("local", server({ reachable: false, ready: false }), emb())).toEqual({
      ok: null,
    });
    expect(memoryServing("local", server({ running: false }), emb())).toEqual({ ok: null });
    expect(memoryServing("local", undefined, undefined)).toEqual({ ok: null });
  });

  it("a server that answers but fails /ready is not serving — and an embedder off under local is named", () => {
    const a = memoryServing(
      "local",
      server({ ready: false, last_error: "ready 503" }),
      emb({
        state: "off",
        running: false,
        ready: false,
        reason: "ov.conf does not route embeddings to http://127.0.0.1:1999/v1",
      }),
    );
    expect(a.ok).toBe(false);
    expect(a.reason).toMatch(/\/ready fails \(ready 503\)/);
    expect(a.reason).toMatch(/the local embedder is off — ov\.conf does not route/);
  });

  it("ONE failed /ready poll is unknown — a busy embedder answering slowly is no verdict; the second decides", () => {
    expect(
      memoryServing(
        "local",
        server({ ready: false, not_ready_polls: 1, last_error: "timeout" }),
        emb(),
      ),
    ).toEqual({ ok: null });
    const two = memoryServing(
      "local",
      server({ ready: false, not_ready_polls: 2, last_error: "timeout" }),
      emb(),
    );
    expect(two.ok).toBe(false);
    expect(two.reason).toMatch(/\/ready fails \(timeout\)/);
    // A dead embedder is still not serving at once, whatever the count.
    expect(
      memoryServing(
        "local",
        server({ ready: false, not_ready_polls: 1 }),
        emb({ state: "unavailable", running: false, ready: false }),
      ).ok,
    ).toBe(false);
  });

  it("an ov.conf that predates it (the engine embeds itself) serves when /ready passes — not an outage", () => {
    expect(
      memoryServing(
        "local",
        server(),
        emb({ state: "off", running: false, ready: false, reason: "predates" }),
      ),
    ).toEqual({ ok: true });
  });

  it("a hosted opt-in is judged by the server's /ready alone — the embedder off changes nothing", () => {
    const off = emb({ state: "off", running: false, ready: false, reason: "hosted" });
    expect(memoryServing("openai", server(), off)).toEqual({ ok: true });
    const down = memoryServing("openai", server({ ready: false, last_error: "ready 503" }), off);
    expect(down.ok).toBe(false);
    expect(down.reason).not.toMatch(/local embedder/);
  });
});

// `[openviking] endpoint = "remote"`: the memory sidecar serves, the daemon
// only probes. What is pinned:
//   * the key parses, defaults to local, and a misspelling refuses at load;
//   * the server supervisor spawns nothing and never checks a binary, probes
//     the configured host at once, reports `endpoint: "remote"` with `running`
//     meaning "answering", and fires onReady each time the sidecar turns ready
//     (a sidecar restart re-runs the daemon's ready work, like a respawn);
//   * the local embedder supervisor reports `off` with the sidecar as the
//     reason and gates nothing;
//   * memory health still reads true from the server's own /ready, and a
//     failing /ready names the sidecar's embedder;
//   * the daemon builds no re-embed driver (the journal is the sidecar's).
// The local-mode transcript is tests/openviking-endpoint-local.test.ts.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  OPENVIKING_DEFAULTS,
  parseConfig,
  parseOpenViking,
  resolveOpenVikingPaths,
  type OpenVikingConfig,
} from "../src/config.js";
import {
  LocalEmbedderSupervisor,
  OpenVikingSupervisor,
  REMOTE_EMBEDDER_REASON,
  memoryServing,
  type FetchLike,
} from "../src/openviking/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const remoteCfg = (over: Partial<OpenVikingConfig> = {}): OpenVikingConfig =>
  resolveOpenVikingPaths({
    ...OPENVIKING_DEFAULTS,
    endpoint: "remote",
    host: "qcr-memory",
    ...over,
  });

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
  async fireNext(): Promise<void> {
    const entry = this.live()[0];
    if (!entry) throw new Error("nothing scheduled");
    entry.cancelled = true;
    entry.fn();
    await flush();
  }
}
const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise<void>((r) => setImmediate(r));
};

/** A sidecar that answers per the switches; every probed URL recorded. */
function sidecar() {
  const state = { up: true, ready: true, version: OPENVIKING_DEFAULTS.version };
  const urls: string[] = [];
  const fetchFn: FetchLike = async (url) => {
    urls.push(url);
    if (!state.up) throw new Error("connect ECONNREFUSED");
    const isReady = url.endsWith("/ready");
    const ok = isReady ? state.ready : true;
    return { ok, status: ok ? 200 : 503, json: async () => ({ version: state.version }) };
  };
  return { state, urls, fetchFn };
}

describe("[openviking] endpoint — the config key", () => {
  it("defaults to local, in the defaults and in the tracked example", () => {
    expect(OPENVIKING_DEFAULTS.endpoint).toBe("local");
    expect(
      parseConfig(readFileSync(join(root, "config.example.toml"), "utf8")).openviking.endpoint,
    ).toBe("local");
    expect(parseOpenViking({}).endpoint).toBe("local");
  });

  it("accepts remote, and refuses anything else at load", () => {
    expect(parseOpenViking({ endpoint: "remote", host: "qcr-memory" }).endpoint).toBe("remote");
    expect(() => parseOpenViking({ endpoint: "sidecar" })).toThrow(
      /endpoint must be one of local, remote/,
    );
    expect(() => parseOpenViking({ endpoint: true })).toThrow(/endpoint must be one of/);
  });
});

describe("OpenVikingSupervisor under endpoint = remote", () => {
  function make(over: Partial<OpenVikingConfig> = {}, fetchFn?: FetchLike, onReady?: () => void) {
    const clock = new FakeClock();
    const lines: string[] = [];
    const spawned: string[] = [];
    const existsCalls: string[] = [];
    const sup = new OpenVikingSupervisor({
      cfg: remoteCfg(over),
      log: (m) => lines.push(m),
      spawn: (cmd) => {
        spawned.push(cmd);
        throw new Error("a remote endpoint spawns nothing");
      },
      exists: (p) => {
        existsCalls.push(p);
        return false; // no binary in this container, and that must not matter
      },
      schedule: clock.schedule,
      ...(fetchFn ? { fetchFn } : {}),
      ...(onReady ? { onReady } : {}),
    });
    return { sup, clock, lines, spawned, existsCalls };
  }

  it("spawns nothing, checks no binary, and probes the configured host at once", async () => {
    const s = sidecar();
    const { sup, lines, spawned, existsCalls } = make({}, s.fetchFn);
    sup.start();
    await flush();
    expect(spawned).toEqual([]);
    expect(existsCalls).toEqual([]);
    expect(lines).toEqual([
      "openviking: endpoint = remote — the memory sidecar serves http://qcr-memory:1933; the daemon only probes it",
    ]);
    expect(s.urls).toEqual(["http://qcr-memory:1933/health", "http://qcr-memory:1933/ready"]);
  });

  it("reports remote, running = answering, and the pin drift read from /health", async () => {
    const s = sidecar();
    const { sup } = make({}, s.fetchFn);
    expect(sup.status()).toMatchObject({ enabled: true, running: false, reachable: false });
    sup.start();
    await flush();
    expect(sup.status()).toMatchObject({
      endpoint: "remote",
      enabled: true,
      running: true,
      reachable: true,
      ready: true,
      restarts: 0,
      version: OPENVIKING_DEFAULTS.version,
      version_drift: false,
    });
    expect(sup.status().pid).toBeUndefined();
    s.state.version = "0.4.16";
    await sup.poll();
    expect(sup.status().version_drift).toBe(true);
  });

  it("never respawns: a down sidecar is reported, polled again, and recovers", async () => {
    const s = sidecar();
    const readies: number[] = [];
    const { sup, clock, lines, spawned } = make({}, s.fetchFn, () => readies.push(readies.length));
    sup.start();
    await flush();
    expect(readies).toHaveLength(1);
    s.state.up = false;
    await clock.fireNext();
    expect(sup.status()).toMatchObject({ running: false, reachable: false, ready: false });
    expect(sup.status().last_error).toMatch(/ECONNREFUSED/);
    s.state.up = true;
    await clock.fireNext();
    expect(sup.status()).toMatchObject({ running: true, ready: true });
    // The sidecar came back: the daemon's ready work runs again, as after a respawn.
    expect(readies).toHaveLength(2);
    expect(spawned).toEqual([]);
    expect(lines.some((l) => /restarting|exited|spawn/.test(l))).toBe(false);
    expect(sup.status().restarts).toBe(0);
  });

  it("a ready-but-for-/ready sidecar counts not-ready polls, like the child does", async () => {
    const s = sidecar();
    s.state.ready = false;
    const { sup, clock } = make({}, s.fetchFn);
    sup.start();
    await flush();
    expect(sup.status()).toMatchObject({ reachable: true, ready: false, not_ready_polls: 1 });
    await clock.fireNext();
    expect(sup.status().not_ready_polls).toBe(2);
  });

  it("stop is clean and ends the probing", async () => {
    const s = sidecar();
    const { sup, clock } = make({}, s.fetchFn);
    sup.start();
    await flush();
    await sup.stop();
    expect(clock.live()).toEqual([]);
  });

  it("memory disabled still wins: no probing at all", async () => {
    const s = sidecar();
    const { sup, lines } = make({ enabled: false }, s.fetchFn);
    sup.start();
    await flush();
    expect(s.urls).toEqual([]);
    expect(lines).toEqual(["openviking: disabled in config.toml — the daemon runs memory-less"]);
  });
});

describe("LocalEmbedderSupervisor under endpoint = remote", () => {
  it("is off with the sidecar as the reason, spawns nothing and gates nothing", () => {
    const lines: string[] = [];
    const emb = new LocalEmbedderSupervisor({
      cfg: remoteCfg(),
      repoRoot: "/opt/quickreview/sandbox",
      log: (m) => lines.push(m),
      spawn: () => {
        throw new Error("a remote endpoint spawns nothing");
      },
      exists: () => false,
      readOvConf: () => null,
    });
    emb.start();
    expect(emb.status()).toMatchObject({
      state: "off",
      reason: REMOTE_EMBEDDER_REASON,
      running: false,
      ready: false,
    });
    expect(emb.gateOpen()).toBe(true);
    expect(lines).toEqual([`openviking: local embedder NOT started — ${REMOTE_EMBEDDER_REASON}`]);
  });

  it("says nothing under a hosted provider (there is no local embedder to talk about)", () => {
    const lines: string[] = [];
    const emb = new LocalEmbedderSupervisor({
      cfg: remoteCfg({
        embedding_provider: "openai",
        embedding_model: "text-embedding-3-small",
        embedding_dimension: 1536,
      }),
      repoRoot: "/x",
      log: (m) => lines.push(m),
    });
    emb.start();
    expect(emb.status().state).toBe("off");
    expect(lines).toEqual([]);
  });
});

describe("memory health under endpoint = remote", () => {
  async function pair() {
    const s = sidecar();
    const sup = new OpenVikingSupervisor({
      cfg: remoteCfg(),
      log: () => undefined,
      fetchFn: s.fetchFn,
      schedule: new FakeClock().schedule,
    });
    const emb = new LocalEmbedderSupervisor({
      cfg: remoteCfg(),
      repoRoot: "/x",
      log: () => undefined,
    });
    emb.start();
    sup.start();
    await flush();
    return { s, sup, emb };
  }

  it("serves when the sidecar's /ready passes, whatever the daemon's own embedder block says", async () => {
    const { sup, emb } = await pair();
    expect(memoryServing("local", sup.status(), emb.status())).toEqual({ ok: true });
  });

  it("an unreachable sidecar is unknown here (the authenticated probe judges it)", async () => {
    const { s, sup, emb } = await pair();
    s.state.up = false;
    await sup.poll();
    expect(memoryServing("local", sup.status(), emb.status())).toEqual({ ok: null });
  });

  it("a sidecar whose /ready keeps failing is not serving, and the reason names its embedder", async () => {
    const { s, sup, emb } = await pair();
    s.state.ready = false;
    await sup.poll();
    expect(memoryServing("local", sup.status(), emb.status())).toEqual({ ok: null }); // one poll is no verdict
    await sup.poll();
    const v = memoryServing("local", sup.status(), emb.status());
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/\/ready fails/);
    expect(v.reason).toContain("the memory sidecar runs it");
  });
});

describe("the daemon's wiring", () => {
  it("builds the re-embed driver only for a local endpoint: the journal is the sidecar's", () => {
    const wire = readFileSync(join(root, "src/wire.ts"), "utf8");
    const at = wire.indexOf("reembed = new ReembedDriver(");
    expect(at).toBeGreaterThan(-1);
    expect(wire.slice(Math.max(0, at - 200), at)).toContain('cfg.openviking.endpoint === "local"');
  });
});

// supervision, health polling and the heartbeat block.
//
// Nothing here touches a real process, socket or clock: the supervisor takes a
// spawn seam, a fetch seam and a timer seam precisely so its two dangerous
// behaviours — respawning forever and probing a possibly-hung server — are
// testable without either.
import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPENVIKING_DEFAULTS, loadConfig, resolveOpenVikingPaths, type OpenVikingConfig } from "../src/config.js";
import { createDaemon, type DaemonAdapter } from "../src/daemon.js";
import { stubSessionHooks } from "../src/stubs.js";
import { OpenVikingSupervisor, ProcSampler, parseProcStat, probeHealth, type FetchLike, type SupervisedChild } from "../src/openviking/index.js";
import { StateStore, buildStatusSnapshot } from "../src/state.js";

const cfg = (over: Partial<OpenVikingConfig> = {}): OpenVikingConfig =>
  resolveOpenVikingPaths({ ...OPENVIKING_DEFAULTS, ...over });

// ---- fakes ---------------------------------------------------------------

class FakeChild extends EventEmitter implements SupervisedChild {
  readonly pid: number;
  stdout = new EventEmitter() as unknown as SupervisedChild["stdout"];
  stderr = new EventEmitter() as unknown as SupervisedChild["stderr"];
  killed: NodeJS.Signals[] = [];
  /** SIGTERM is ignored when true — the SIGKILL escalation path. */
  stubborn = false;

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killed.push(signal);
    if (signal === "SIGKILL" || !this.stubborn) this.exit(0, signal);
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit("exit", code, signal);
  }

  say(stream: "stdout" | "stderr", text: string): void {
    (this[stream] as unknown as EventEmitter).emit("data", Buffer.from(text));
  }
}

/** A timer seam that records pending callbacks instead of running them. */
class FakeClock {
  pending: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  schedule = (fn: () => void, ms: number): (() => void) => {
    const entry = { fn, ms, cancelled: false };
    this.pending.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };

  /** Fire the first live callback whose delay matches, or just the first. */
  fire(index = 0): number {
    const live = this.pending.filter((p) => !p.cancelled);
    const entry = live[index];
    if (!entry) throw new Error("nothing scheduled");
    entry.cancelled = true;
    entry.fn();
    return entry.ms;
  }

  /** Fire the MOST RECENTLY scheduled live callback — after a crash that is
   * the respawn, with the long-lived health loop left alone. */
  fireLast(): number {
    const live = this.pending.filter((p) => !p.cancelled);
    const entry = live[live.length - 1];
    if (!entry) throw new Error("nothing scheduled");
    entry.cancelled = true;
    entry.fn();
    return entry.ms;
  }

  get delays(): number[] {
    return this.pending.filter((p) => !p.cancelled).map((p) => p.ms);
  }
}

interface Harness {
  sup: OpenVikingSupervisor;
  clock: FakeClock;
  children: FakeChild[];
  lines: string[];
  spawns: Array<{ cmd: string; args: string[]; opts: { cwd?: string; env: NodeJS.ProcessEnv } }>;
}

function harness(over: Partial<OpenVikingConfig> = {}, opts: { fetchFn?: FetchLike; exists?: (p: string) => boolean } = {}): Harness {
  const clock = new FakeClock();
  const children: FakeChild[] = [];
  const lines: string[] = [];
  const spawns: Harness["spawns"] = [];
  const sup = new OpenVikingSupervisor({
    cfg: cfg(over),
    log: (msg) => lines.push(msg),
    spawn: (cmd, args, o) => {
      spawns.push({ cmd, args, opts: o });
      const child = new FakeChild(1000 + children.length);
      children.push(child);
      return child;
    },
    exists: opts.exists ?? (() => true),
    schedule: clock.schedule,
    ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
  });
  return { sup, clock, children, lines, spawns };
}

const jsonRes = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

// ---- /proc parsing -------------------------------------------------------

describe("parseProcStat", () => {
  const line = (comm: string, utime = 100, stime = 50, rssPages = 4096): string => {
    const fields: Array<string | number> = [];
    for (let f = 3; f <= 52; f++) fields.push(f === 14 ? utime : f === 15 ? stime : f === 24 ? rssPages : 0);
    return `4242 (${comm}) S ${fields.slice(1).join(" ")}`.replace("S ", "S ");
  };

  it("reads utime/stime/rss past a comm containing spaces AND parentheses", () => {
    // The classic way this parse breaks: `openviking-server (worker 1)`.
    const raw = line("openviking-server (worker 1)");
    const parsed = parseProcStat(raw);
    expect(parsed).toEqual({ utimeTicks: 100, stimeTicks: 50, rssPages: 4096 });
  });

  it("returns undefined on garbage rather than NaN", () => {
    expect(parseProcStat("")).toBeUndefined();
    expect(parseProcStat("4242 (x) S not numbers here")).toBeUndefined();
  });

  it("samples RSS immediately and CPU only once there are two points", () => {
    let ticks = 0;
    let ms = 0;
    const sampler = new ProcSampler({
      readStat: () => line("ov", ticks, 0, 100_000),
      now: () => ms,
    });
    const first = sampler.sample(7);
    expect(first?.rss_bytes).toBe(100_000 * 4096);
    expect(first?.cpu_pct).toBeUndefined();

    // 200 ticks (= 2 core-seconds) over 4 wall seconds = 50% of one core.
    ticks = 200;
    ms = 4000;
    expect(sampler.sample(7)?.cpu_pct).toBeCloseTo(50, 1);
  });

  it("does not attribute a dead process's ticks to its replacement", () => {
    let ticks = 900;
    let ms = 0;
    const sampler = new ProcSampler({ readStat: () => line("ov", ticks, 0, 10), now: () => ms });
    sampler.sample(7);
    ticks = 5;
    ms = 1000;
    expect(sampler.sample(8)?.cpu_pct).toBeUndefined(); // different pid ⇒ new baseline
  });

  it("survives an unreadable /proc entry (dead pid, non-Linux dev box)", () => {
    const sampler = new ProcSampler({
      readStat: () => {
        throw new Error("ENOENT");
      },
    });
    expect(sampler.sample(1)).toBeUndefined();
  });
});

// ---- health probe --------------------------------------------------------

describe("probeHealth", () => {
  const probe = (fetchFn: FetchLike) => probeHealth({ baseUrl: "http://127.0.0.1:1933", timeoutMs: 100, fetchFn });

  it("uses /ready as the gate and /health for the version — never `doctor`", async () => {
    const urls: string[] = [];
    const h = await probe(async (url) => {
      urls.push(url);
      return url.endsWith("/health")
        ? jsonRes(200, { status: "ok", healthy: true, version: "0.4.15" })
        : jsonRes(200, { status: "ready", checks: { agfs: "ok" } });
    });
    expect(urls).toEqual(["http://127.0.0.1:1933/health", "http://127.0.0.1:1933/ready"]);
    expect(urls.join()).not.toContain("doctor");
    expect(h).toMatchObject({ reachable: true, ready: true, version: "0.4.15" });
  });

  it("503 from /ready is up-but-not-serving, not a crash", async () => {
    const h = await probe(async (url) =>
      url.endsWith("/health") ? jsonRes(200, { version: "0.4.15" }) : jsonRes(503, { status: "not_ready" }),
    );
    expect(h.reachable).toBe(true);
    expect(h.ready).toBe(false);
    expect(h.version).toBe("0.4.15");
    expect(h.error).toBe("ready 503");
  });

  it("connection refused is reported, never thrown, and skips the second probe", async () => {
    let calls = 0;
    const h = await probe(async () => {
      calls += 1;
      throw new Error("ECONNREFUSED");
    });
    expect(calls).toBe(1);
    expect(h).toMatchObject({ reachable: false, ready: false, error: "ECONNREFUSED" });
  });

  it("an unparseable /health body still proves reachability", async () => {
    const h = await probe(async (url) =>
      url.endsWith("/health")
        ? { ok: true, status: 200, json: async () => Promise.reject(new Error("not json")) }
        : jsonRes(200, {}),
    );
    expect(h.reachable).toBe(true);
    expect(h.ready).toBe(true);
    expect(h.version).toBeUndefined();
  });
});

// ---- supervision ---------------------------------------------------------

describe("OpenVikingSupervisor", () => {
  it("spawns the pinned binary against the templated ov.conf on loopback", () => {
    const h = harness();
    h.sup.start();
    expect(h.spawns).toHaveLength(1);
    expect(h.spawns[0]!.cmd).toBe("/opt/openviking/venv/bin/openviking-server");
    expect(h.spawns[0]!.args).toEqual([
      "--config",
      "/opt/quickreview/state/openviking/ov.conf",
      "--host",
      "127.0.0.1",
      "--port",
      "1933",
    ]);
    expect(h.spawns[0]!.opts.env.OPENVIKING_CONFIG_FILE).toBe("/opt/quickreview/state/openviking/ov.conf");
    expect(h.sup.status()).toMatchObject({ enabled: true, running: true, pid: 1000, ready: false });
  });

  it("start() never blocks on readiness — the daemon boots memory-less", () => {
    const h = harness();
    h.sup.start();
    // Nothing was awaited and /ready has not been polled yet, yet the daemon
    // is free to carry on: the status simply says not-ready.
    expect(h.sup.status().ready).toBe(false);
    expect(h.sup.status().reachable).toBe(false);
  });

  it("a missing binary is reported once and never retried (any dev PC)", () => {
    const h = harness({}, { exists: () => false });
    h.sup.start();
    expect(h.spawns).toHaveLength(0);
    expect(h.clock.delays).toEqual([]);
    expect(h.sup.status()).toMatchObject({ enabled: false, running: false });
    expect(h.sup.status().last_error).toContain("binary not found");
    expect(h.lines.join("\n")).toContain("rounds run memory-less");
  });

  it("disabled in config ⇒ no process, no timers, an honest status block", () => {
    const h = harness({ enabled: false });
    h.sup.start();
    expect(h.spawns).toHaveLength(0);
    expect(h.sup.status()).toMatchObject({ enabled: false, running: false, ready: false });
  });

  it("folds the server's stdout and stderr into the daemon log, line by line", () => {
    const h = harness();
    h.sup.start();
    h.children[0]!.say("stdout", "INFO booting\nINFO listen");
    h.children[0]!.say("stdout", "ing on 1933\n");
    h.children[0]!.say("stderr", "WARN slow embed\n");
    expect(h.lines).toContain("openviking: INFO booting");
    // The split line is reassembled rather than logged twice.
    expect(h.lines).toContain("openviking: INFO listening on 1933");
    expect(h.lines).toContain("openviking: WARN slow embed");
  });

  it("restarts on crash, walking the backoff ladder and never giving up", () => {
    const h = harness({ restart_backoff_ms: [1000, 5000, 30000] });
    h.sup.start();
    const delays: number[] = [];
    for (let i = 0; i < 4; i++) {
      h.children[h.children.length - 1]!.exit(1, null);
      delays.push(h.clock.fireLast()); // the scheduled respawn
    }
    // Ladder walks up and then holds at the ceiling — forever, by design.
    expect(delays).toEqual([1000, 5000, 30000, 30000]);
    expect(h.spawns).toHaveLength(5);
    expect(h.sup.status().restarts).toBe(4);
    expect(h.sup.status().running).toBe(true);
  });

  it("an exit records code/signal without an approve-like guess about why", () => {
    const h = harness();
    h.sup.start();
    h.children[0]!.exit(null, "SIGSEGV");
    expect(h.sup.status().last_exit).toMatchObject({ code: null, signal: "SIGSEGV" });
    expect(h.sup.status().running).toBe(false);
  });

  it("a child that stayed up past the reset window starts the ladder over", () => {
    let clockMs = 0;
    const clock = new FakeClock();
    const children: FakeChild[] = [];
    const sup = new OpenVikingSupervisor({
      cfg: cfg({ restart_backoff_ms: [1000, 60000], restart_reset_after_s: 120 }),
      log: () => {},
      spawn: () => {
        const c = new FakeChild(1);
        children.push(c);
        return c;
      },
      exists: () => true,
      schedule: clock.schedule,
      now: () => new Date(clockMs),
    });
    sup.start();
    children[0]!.exit(1, null); // immediate crash ⇒ rung 0
    expect(clock.fireLast()).toBe(1000);
    children[1]!.exit(1, null); // crash again ⇒ rung 1
    expect(clock.fireLast()).toBe(60000);
    clockMs = 10 * 60 * 1000; // this one lived ten minutes
    children[2]!.exit(1, null);
    expect(clock.fireLast()).toBe(1000); // ladder reset, not stuck at the ceiling
  });

  it("caches the last health sample — status() is synchronous and never awaits", async () => {
    const h = harness({}, {
      fetchFn: async (url) =>
        url.endsWith("/health") ? jsonRes(200, { version: "0.4.15" }) : jsonRes(200, { status: "ready" }),
    });
    h.sup.start();
    await h.sup.poll();
    const s = h.sup.status();
    expect(s).toMatchObject({ reachable: true, ready: true, version: "0.4.15", version_drift: false });
    expect(s.checked_at).toBeTruthy();
  });

  it("flags version drift against the triple-mirrored pin", async () => {
    const h = harness({}, {
      fetchFn: async (url) => (url.endsWith("/health") ? jsonRes(200, { version: "0.4.16" }) : jsonRes(200, {})),
    });
    h.sup.start();
    await h.sup.poll();
    expect(h.sup.status()).toMatchObject({ version: "0.4.16", pinned_version: "0.4.15", version_drift: true });
  });

  it("a throwing fetch seam degrades to unreachable instead of rejecting", async () => {
    const h = harness({}, {
      fetchFn: () => {
        throw new Error("boom");
      },
    });
    h.sup.start();
    await expect(h.sup.poll()).resolves.toBeUndefined();
    expect(h.sup.status()).toMatchObject({ reachable: false, ready: false });
  });

  it("reports RSS and CPU for the supervised pid", async () => {
    const clock = new FakeClock();
    let ms = 0;
    const sampler = new ProcSampler({
      readStat: () => `1000 (openviking-server) S ${Array.from({ length: 50 }, (_, i) => (i + 3 === 14 ? ms / 10 : i + 3 === 24 ? 100_000 : 0)).slice(1).join(" ")}`,
      now: () => ms,
    });
    const sup = new OpenVikingSupervisor({
      cfg: cfg(),
      log: () => {},
      spawn: () => new FakeChild(1000),
      exists: () => true,
      schedule: clock.schedule,
      sampler,
      fetchFn: async () => jsonRes(200, {}),
    });
    sup.start();
    await sup.poll();
    ms = 10_000;
    await sup.poll();
    const s = sup.status();
    expect(s.rss_bytes).toBe(100_000 * 4096);
    expect(typeof s.cpu_pct).toBe("number");
    // Monitoring only: there is no watchdog, so nothing was killed.
    expect(s.running).toBe(true);
  });

  it("the health loop re-arms itself so two probes can never overlap", async () => {
    const h = harness({ health_interval_s: 30 }, { fetchFn: async () => jsonRes(200, {}) });
    h.sup.start();
    expect(h.clock.delays).toContain(30_000);
    const before = h.clock.pending.length;
    h.clock.fire(h.clock.delays.indexOf(30_000));
    await new Promise((r) => setImmediate(r));
    expect(h.clock.pending.length).toBeGreaterThan(before); // re-armed after the poll
  });

  it("stop() SIGTERMs, and escalates to SIGKILL when the server ignores it", async () => {
    const gentle = harness();
    gentle.sup.start();
    await gentle.sup.stop();
    expect(gentle.children[0]!.killed).toEqual(["SIGTERM"]);

    const stuck = harness();
    stuck.sup.start();
    stuck.children[0]!.stubborn = true;
    const stopping = stuck.sup.stop();
    stuck.clock.fire(stuck.clock.delays.indexOf(5000)); // the grace window
    await stopping;
    expect(stuck.children[0]!.killed).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("stopping cancels a pending restart — shutdown never resurrects the server", async () => {
    const h = harness();
    h.sup.start();
    h.children[0]!.exit(1, null);
    expect(h.clock.delays).toContain(1000);
    await h.sup.stop();
    expect(h.clock.delays).not.toContain(1000);
    expect(h.spawns).toHaveLength(1);
  });

  it("an exit during shutdown is not treated as a crash", async () => {
    const h = harness();
    h.sup.start();
    await h.sup.stop();
    expect(h.sup.status().restarts).toBe(0);
    expect(h.spawns).toHaveLength(1);
  });
});

// ---- the heartbeat block -------------------------------------------------

describe("status.json openviking block", () => {
  it("reaches the heartbeat, and a throwing status read never breaks it", async () => {
    const root = mkdtempSync(join(tmpdir(), "qcr-ov-"));
    const store = new StateStore(":memory:");
    try {
      for (const d of ["state", "state/dryrun", "verdict", "inject"]) mkdirSync(join(root, d), { recursive: true });
      const adapter = {
        searchLabelTriggered: async () => [],
        searchTeamTriggered: async () => [],
        listOpenPrs: async () => [],
        stalenessScan: async () => [],
        listBotReviewComments: async () => [],
      } as unknown as DaemonAdapter;

      const h = harness();
      h.sup.start();
      const daemon = createDaemon({
        cfg: loadConfig(),
        root,
        store,
        adapter,
        hooks: stubSessionHooks(root),
        listen: false,
        log: () => {},
        openvikingStatus: () => h.sup.status(),
      });
      await daemon.start();
      const snap = JSON.parse(readFileSync(join(root, "state", "status.json"), "utf8")) as { openviking?: { pid?: number } };
      expect(snap.openviking).toMatchObject({ enabled: true, running: true, pinned_version: "0.4.15" });
      await daemon.stop();

      // A supervisor that throws must never cost us the heartbeat: the daemon
      // still writes status.json, just without the block.
      const store2 = new StateStore(":memory:");
      const angry = createDaemon({
        cfg: loadConfig(),
        root,
        store: store2,
        adapter,
        hooks: stubSessionHooks(root),
        listen: false,
        log: () => {},
        openvikingStatus: () => {
          throw new Error("memory engine on fire");
        },
      });
      await angry.start();
      const after = JSON.parse(readFileSync(join(root, "state", "status.json"), "utf8")) as { heartbeat?: string; openviking?: unknown };
      expect(after.heartbeat).toBeTruthy();
      expect(after.openviking).toBeUndefined();
      await angry.stop();
      store2.close();
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is present when a supervisor is wired and absent when it is not", () => {
    const store = new StateStore(":memory:");
    try {
      const bare = buildStatusSnapshot(store, false);
      expect(bare.openviking).toBeUndefined();

      const h = harness();
      h.sup.start();
      const snap = buildStatusSnapshot(store, false, undefined, undefined, 12, undefined, h.sup.status());
      expect(snap.openviking).toMatchObject({ enabled: true, running: true, pinned_version: "0.4.15", ready: false });
      // Round-trips through JSON — this is what the status collector reads.
      expect(JSON.parse(JSON.stringify(snap)).openviking.pid).toBe(1000);
    } finally {
      store.close();
    }
  });
});

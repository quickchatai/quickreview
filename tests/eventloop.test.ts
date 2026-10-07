// L2 — the daemon reports its event-loop lag. On 2026-10-07 the
// daemon's own /health went unanswered for ~70 s at a time while the 2-CPU
// container was throttled in 39% of its CFS periods, and nothing measured
// either. These pin the watch (src/eventloop.ts) on a fake clock, a fake
// sampler and a fake cpu.stat reader; the thresholds and the cooldown; the
// cause it names; the status.json block through a real (stub-wired) daemon;
// and every surface a person reads — `qcr status`, the TUI board's top bar and
// the companion's view — with honest-unknown when the block is absent.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { boardAnswer, daemonLoadLine as viewLine } from "../extensions/tui-view.js";
import { renderStatus } from "../src/cli.js";
import { loadConfig, type Config } from "../src/config.js";
import { createDaemon, type DaemonAdapter } from "../src/daemon.js";
import {
  CGROUP_CPU_STAT,
  DEFAULT_EVENT_LOOP_STALL_MAX_S,
  DEFAULT_EVENT_LOOP_WINDOW_S,
  DaemonLoadMonitor,
  EVENT_LOOP_WAKE_KIND,
  LOOP_BUSY_SHARE,
  daemonLoadLine,
  driftSampler,
  eventLoopPolicy,
  parseCpuStat,
  readCgroupCpuStat,
  stallShortPhrase,
  type CpuStat,
  type CpuStatRead,
  type DaemonLoadStatus,
  type LoopBusy,
  type LoopDelaySampler,
  type LoopSampleSink,
} from "../src/eventloop.js";
import { buildStatusSnapshot, StateStore, type StatusSnapshot } from "../src/state.js";
import { stubSessionHooks } from "../src/stubs.js";
import {
  alertSegment,
  alertZone,
  eventLoopSegment,
  renderBoard,
  topBar,
  type BoardView,
} from "../src/tui/board.js";
import type { AlertBadge } from "../src/tui/alerts.js";
import { buildTuiView } from "../src/tui/feed.js";
import { sliceDisplay, stripAnsi } from "../src/tui/paint.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const T0 = Date.parse("2026-10-07T13:29:00.000Z");
const S = 1000;
const MIN = 60 * S;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** A sampler the test drives by hand. */
class FakeSampler implements LoopDelaySampler {
  sink: LoopSampleSink | null = null;
  starts = 0;
  stops = 0;
  start(onSample: LoopSampleSink): void {
    this.starts += 1;
    this.sink = onSample;
  }
  stop(): void {
    this.stops += 1;
    this.sink = null;
  }
}

/** cpu.stat as the kernel writes it (cgroup v2, a container with a quota). */
function cpuStatText(s: {
  usage: number;
  periods: number;
  throttled: number;
  throttledUs: number;
}): string {
  return [
    `usage_usec ${s.usage}`,
    `user_usec ${Math.floor(s.usage * 0.7)}`,
    `system_usec ${Math.floor(s.usage * 0.3)}`,
    `nr_periods ${s.periods}`,
    `nr_throttled ${s.throttled}`,
    `throttled_usec ${s.throttledUs}`,
    "nr_bursts 0",
    "burst_usec 0",
    "",
  ].join("\n");
}

/** A real cgroup v2 cpu.stat with no CPU quota (a developer PC's, verbatim):
 * the bandwidth counters are present and zero. */
const NO_QUOTA_CPU_STAT = [
  "usage_usec 1827854799579",
  "user_usec 1436670164257",
  "system_usec 391184635322",
  "nice_usec 178427793187",
  "core_sched.force_idle_usec 0",
  "nr_periods 0",
  "nr_throttled 0",
  "throttled_usec 0",
  "nr_bursts 0",
  "burst_usec 0",
  "",
].join("\n");

/** A cpu.stat whose counters advance by `ratio` throttled per period. */
function cpuCounter(ratio: number): { read: () => CpuStatRead; reads: number } {
  const state = {
    usage: 9_000_000_000,
    periods: 50_000,
    throttled: 15_000,
    throttledUs: 2_500_000_000,
    reads: 0,
  };
  return {
    get reads() {
      return state.reads;
    },
    read: (): CpuStatRead => {
      state.reads += 1;
      const stat: CpuStat = {
        usage_usec: state.usage,
        nr_periods: state.periods,
        nr_throttled: state.throttled,
        throttled_usec: state.throttledUs,
      };
      // 150 periods (15 s of 100 ms periods) between evaluations.
      state.usage += 25_000_000;
      state.periods += 150;
      state.throttled += Math.round(150 * ratio);
      state.throttledUs += Math.round(150 * ratio * 40_000);
      return { ok: true, stat };
    },
  };
}

interface Rig {
  monitor: DaemonLoadMonitor;
  sampler: FakeSampler;
  raised: Array<{ detail: string; message: string }>;
  logged: string[];
  timers: Array<() => void>;
  clock: { ms: number };
  /** One sample; `busyShare` (when given) is the daemon's CPU across the
   * sample's span — the 500 ms interval plus the delay — as the drift
   * sampler measures it. */
  sample: (lagMs: number, busyShare?: number) => void;
  advance: (ms: number) => void;
}

function rig(
  opts: {
    knobs?: Parameters<typeof eventLoopPolicy>[0];
    readCpuStat?: () => CpuStatRead;
    raise?: (detail: string, message: string) => void;
  } = {},
): Rig {
  const clock = { ms: T0 };
  const sampler = new FakeSampler();
  const raised: Array<{ detail: string; message: string }> = [];
  const logged: string[] = [];
  const timers: Array<() => void> = [];
  const monitor = new DaemonLoadMonitor({
    policy: eventLoopPolicy(opts.knobs),
    raise: opts.raise ?? ((detail, message) => raised.push({ detail, message })),
    sampler,
    readCpuStat: opts.readCpuStat ?? cpuCounter(0.39).read,
    now: () => new Date(clock.ms),
    setTimer: (cb) => {
      timers.push(cb);
      return { fake: true };
    },
    clearTimer: () => {},
    log: (msg) => logged.push(msg),
  });
  return {
    monitor,
    sampler,
    raised,
    logged,
    timers,
    clock,
    sample: (lagMs, busyShare) => {
      const spanMs = lagMs + 500;
      sampler.sink!(
        lagMs,
        new Date(clock.ms),
        busyShare === undefined ? undefined : { cpuMs: busyShare * spanMs, spanMs },
      );
    },
    advance: (ms) => {
      clock.ms += ms;
    },
  };
}

/** Feed a steady loop: one sample of `lagMs` every 500 ms for `ms`. */
function steady(r: Rig, ms: number, lagMs = 1): void {
  for (let t = 0; t < ms; t += 500) {
    r.advance(500);
    r.sample(lagMs);
  }
}

// ---- the policy --------------------------------------------------------------

describe("eventLoopPolicy — [daemon] event_loop_* knobs", () => {
  it("defaults: a 5-minute window, 10 s single delay, 2 s p99, one wake an hour, 20% throttled = starved", () => {
    expect(eventLoopPolicy()).toEqual({
      windowMs: 300 * S,
      stallMaxMs: 10 * S,
      stallP99Ms: 2 * S,
      cooldownMs: 60 * MIN,
      starvedRatio: 0.2,
    });
    expect(DEFAULT_EVENT_LOOP_WINDOW_S).toBe(300);
    expect(DEFAULT_EVENT_LOOP_STALL_MAX_S).toBe(10);
  });

  it("a configured number is used, clamped into range; a non-number falls back", () => {
    const p = eventLoopPolicy({
      event_loop_window_s: 120,
      event_loop_stall_max_s: 30,
      event_loop_stall_p99_s: 5,
      event_loop_wake_cooldown_min: 15,
      event_loop_starved_throttle_ratio: 0.5,
    });
    expect(p).toEqual({
      windowMs: 120 * S,
      stallMaxMs: 30 * S,
      stallP99Ms: 5 * S,
      cooldownMs: 15 * MIN,
      starvedRatio: 0.5,
    });
    const clamped = eventLoopPolicy({
      event_loop_window_s: 1,
      event_loop_stall_max_s: 0,
      event_loop_stall_p99_s: 0,
      event_loop_wake_cooldown_min: 0,
      event_loop_starved_throttle_ratio: 7,
    });
    expect(clamped).toEqual({
      windowMs: 60 * S,
      stallMaxMs: 1 * S,
      stallP99Ms: 100,
      cooldownMs: 5 * MIN,
      starvedRatio: 1,
    });
    expect(
      eventLoopPolicy({
        event_loop_window_s: "300" as unknown as number,
        event_loop_stall_max_s: Number.NaN,
      }),
    ).toEqual(eventLoopPolicy());
  });

  it("the shipped example config parses with the same values as the defaults", () => {
    const cfg = loadConfig(join(process.cwd(), "config.example.toml"));
    expect(eventLoopPolicy(cfg.daemon)).toEqual(eventLoopPolicy());
  });

  it("non-default [daemon] event_loop_* values in a config file reach the policy", () => {
    const example = readFileSync(join(process.cwd(), "config.example.toml"), "utf8");
    const edited = example
      .replace(/^event_loop_window_s = 300$/m, "event_loop_window_s = 120")
      .replace(/^event_loop_stall_max_s = 10$/m, "event_loop_stall_max_s = 30")
      .replace(/^event_loop_stall_p99_s = 2$/m, "event_loop_stall_p99_s = 5")
      .replace(/^event_loop_wake_cooldown_min = 60$/m, "event_loop_wake_cooldown_min = 15")
      .replace(
        /^event_loop_starved_throttle_ratio = 0\.2$/m,
        "event_loop_starved_throttle_ratio = 0.5",
      );
    expect(edited).not.toBe(example);
    const path = join(tempDir("qcr-evloop-cfg-"), "config.toml");
    writeFileSync(path, edited);
    expect(eventLoopPolicy(loadConfig(path).daemon)).toEqual({
      windowMs: 120 * S,
      stallMaxMs: 30 * S,
      stallP99Ms: 5 * S,
      cooldownMs: 15 * MIN,
      starvedRatio: 0.5,
    });
  });
});

// ---- cpu.stat ----------------------------------------------------------------

describe("cgroup v2 cpu.stat", () => {
  it("parses the counters the watch uses", () => {
    expect(
      parseCpuStat(
        cpuStatText({
          usage: 9_110_000_000,
          periods: 50_665,
          throttled: 15_826,
          throttledUs: 2_560_000_000,
        }),
      ),
    ).toEqual({
      usage_usec: 9_110_000_000,
      nr_periods: 50_665,
      nr_throttled: 15_826,
      throttled_usec: 2_560_000_000,
    });
    // No quota: the bandwidth counters are absent, not zero.
    expect(parseCpuStat("usage_usec 10\nuser_usec 6\nsystem_usec 4\n")).toEqual({
      usage_usec: 10,
      nr_periods: null,
      nr_throttled: null,
      throttled_usec: null,
    });
    expect(parseCpuStat("garbage\n")).toBeNull();
    // A host (or container) with no quota: the counters are THERE, at zero —
    // this PC's real /sys/fs/cgroup/cpu.stat. Parsed as zeros, not nulls; the
    // monitor's nr_periods === 0 branch is what reads it as no quota.
    expect(parseCpuStat(NO_QUOTA_CPU_STAT)).toEqual({
      usage_usec: 1_827_854_799_579,
      nr_periods: 0,
      nr_throttled: 0,
      throttled_usec: 0,
    });
  });

  it("an absent or unreadable file is a reason, never a throw", () => {
    const dir = tempDir("qcr-cpustat-");
    const absent = readCgroupCpuStat(join(dir, "cpu.stat"));
    expect(absent).toEqual({
      ok: false,
      reason: `no ${join(dir, "cpu.stat")} (not a cgroup v2 container)`,
    });
    const asDir = readCgroupCpuStat(dir);
    expect(asDir.ok).toBe(false);
    if (!asDir.ok) expect(asDir.reason).toMatch(/unreadable \(EISDIR\)/);
    writeFileSync(join(dir, "junk"), "hello\n");
    const junk = readCgroupCpuStat(join(dir, "junk"));
    expect(junk.ok).toBe(false);
    writeFileSync(
      join(dir, "cpu.stat"),
      cpuStatText({ usage: 5, periods: 2, throttled: 1, throttledUs: 3 }),
    );
    expect(readCgroupCpuStat(join(dir, "cpu.stat"))).toEqual({
      ok: true,
      stat: { usage_usec: 5, nr_periods: 2, nr_throttled: 1, throttled_usec: 3 },
    });
    expect(CGROUP_CPU_STAT).toBe("/sys/fs/cgroup/cpu.stat");
  });
});

// ---- the drift sampler ---------------------------------------------------------

describe("the drift sampler — how late its timer fires IS the loop's delay", () => {
  it("measures lateness on a monotonic clock, clamps an early tick to 0, and stops", () => {
    let mono = 1_000;
    const timers: Array<() => void> = [];
    let cleared = 0;
    const s = driftSampler({
      intervalMs: 500,
      monotonic: () => mono,
      now: () => new Date(T0 + mono),
      setTimer: (cb) => {
        timers.push(cb);
        return timers.length;
      },
      clearTimer: () => {
        cleared += 1;
      },
    });
    const seen: number[] = [];
    s.start((lag) => seen.push(lag));
    mono += 500; // on time
    timers.shift()!();
    mono += 70_500; // the loop was held 70 s
    timers.shift()!();
    mono += 499.6; // timer granularity
    timers.shift()!();
    expect(seen).toEqual([0, 70_000, 0]);
    s.stop();
    expect(cleared).toBe(1);
    // A stopped sampler's pending tick records nothing.
    timers.shift()?.();
    expect(seen).toHaveLength(3);
  });

  it("a wall-clock jump is not a stall (lag is read on the monotonic clock)", () => {
    let mono = 0;
    let wall = T0;
    const timers: Array<() => void> = [];
    const s = driftSampler({
      intervalMs: 500,
      monotonic: () => mono,
      now: () => new Date(wall),
      setTimer: (cb) => timers.push(cb),
      clearTimer: () => {},
    });
    const seen: number[] = [];
    s.start((lag) => seen.push(lag));
    mono += 500;
    wall += 3_600_000; // NTP step
    timers.shift()!();
    expect(seen).toEqual([0]);
    s.stop();
  });

  it("each sample carries the daemon's own CPU across its span — and none when it cannot be read", () => {
    let mono = 0;
    let cpuUs = 5_000_000;
    let cpuBroken = false;
    const timers: Array<() => void> = [];
    const s = driftSampler({
      intervalMs: 500,
      monotonic: () => mono,
      now: () => new Date(T0 + mono),
      cpuUsageUs: () => {
        if (cpuBroken) throw new Error("no rusage");
        return cpuUs;
      },
      setTimer: (cb) => timers.push(cb),
      clearTimer: () => {},
    });
    const seen: Array<{ lag: number; busy: LoopBusy | undefined }> = [];
    s.start((lag, _at, busy) => seen.push({ lag, busy }));
    // A 20 s synchronous block: the daemon burned ~20 s of CPU across it.
    mono += 20_500;
    cpuUs += 20_400_000;
    timers.shift()!();
    // A 20 s starve: the daemon got 1 s of CPU across it.
    mono += 20_500;
    cpuUs += 1_000_000;
    timers.shift()!();
    // An unreadable CPU clock: no figure, never a guessed one — on this
    // sample and on the next (it has no baseline).
    cpuBroken = true;
    mono += 500;
    timers.shift()!();
    cpuBroken = false;
    mono += 500;
    timers.shift()!();
    mono += 500;
    cpuUs += 250_000;
    timers.shift()!();
    expect(seen).toEqual([
      { lag: 20_000, busy: { cpuMs: 20_400, spanMs: 20_500 } },
      { lag: 20_000, busy: { cpuMs: 1_000, spanMs: 20_500 } },
      { lag: 0, busy: undefined },
      { lag: 0, busy: undefined },
      { lag: 0, busy: { cpuMs: 250, spanMs: 500 } },
    ]);
    s.stop();
  });

  it("a sink that throws does not kill the sampler: the next tick is still scheduled and delivered", () => {
    let mono = 0;
    const timers: Array<() => void> = [];
    const s = driftSampler({
      intervalMs: 500,
      monotonic: () => mono,
      setTimer: (cb) => timers.push(cb),
      clearTimer: () => {},
    });
    const seen: number[] = [];
    let calls = 0;
    s.start((lag) => {
      calls += 1;
      if (calls === 1) throw new Error("sink broke");
      seen.push(lag);
    });
    mono += 500;
    expect(() => timers.shift()!()).not.toThrow();
    expect(timers).toHaveLength(1); // rescheduled despite the throw
    mono += 1_500;
    timers.shift()!();
    expect(seen).toEqual([1_000]);
    expect(timers).toHaveLength(1);
    s.stop();
  });
});

// ---- the monitor -----------------------------------------------------------------

describe("the watch: figures, state, thresholds", () => {
  it("before any sample the loop is UNKNOWN — never ok — with no figures", () => {
    const r = rig();
    r.monitor.start();
    const e = r.monitor.status().event_loop;
    expect(e.state).toBe("unknown");
    expect(e.samples).toBe(0);
    expect([e.p50_ms, e.p99_ms, e.max_ms, e.max_at, e.longest_stall]).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(r.sampler.starts).toBe(1);
  });

  it("a healthy loop is ok, with p50/p99/max over the window and the longest delay with when", () => {
    const r = rig();
    r.monitor.start();
    steady(r, 60 * S, 2);
    r.advance(500);
    r.sample(400); // one slow tick, well under every threshold
    steady(r, 10 * S, 2);
    const e = r.monitor.evaluate().event_loop;
    expect(e.state).toBe("ok");
    expect(e.samples).toBe(141);
    expect(e.p50_ms).toBe(2);
    expect(e.p99_ms).toBe(2);
    expect(e.max_ms).toBe(400);
    expect(e.max_at).toBe(new Date(T0 + 60_500).toISOString());
    expect(e.longest_stall).toEqual({
      ms: 400,
      began_at: new Date(T0 + 60_100).toISOString(),
      ended_at: new Date(T0 + 60_500).toISOString(),
    });
    expect(e.stall).toBeNull();
    expect(r.raised).toEqual([]);
  });

  it("ONE delay of stall_max or more is a stall: it wakes, and names the cause", () => {
    const r = rig();
    r.monitor.start();
    steady(r, 30 * S);
    r.advance(70 * S);
    r.sample(70_000); // the 2026-10-07 shape: /health unanswered ~70 s
    const st = r.monitor.evaluate();
    expect(st.event_loop.state).toBe("stalled");
    expect(st.event_loop.stall?.trigger).toBe("max");
    expect(st.event_loop.stall?.cause).toBe("cpu_starved");
    expect(r.raised).toHaveLength(1);
    expect(r.raised[0]!.detail).toMatch(
      /^event loop stalled 1m10s \(the longest delay in the last 1m40s; p99 /,
    );
    expect(r.raised[0]!.detail).toContain(
      "CPU starved: the container was throttled in 39% of its CFS periods",
    );
    expect(r.raised[0]!.message).toMatch(/^DAEMON EVENT LOOP STALLED\n/);
    expect(r.raised[0]!.message).toContain("Longest single delay since");
    expect(st.event_loop.last_wake_at).toBe(new Date(T0 + 100 * S).toISOString());
    expect(st.event_loop.since).toBe(new Date(T0 + 100 * S).toISOString());
  });

  it("a delay just under stall_max is not a stall", () => {
    const r = rig();
    r.monitor.start();
    r.advance(10 * S);
    r.sample(9_999);
    expect(r.monitor.evaluate().event_loop.state).toBe("ok");
    r.advance(10 * S);
    r.sample(10_000);
    expect(r.monitor.evaluate().event_loop.state).toBe("stalled");
  });

  it("a sustained p99 over the threshold is a stall — but only over a FULL window", () => {
    const r = rig({ knobs: { event_loop_window_s: 120 } });
    r.monitor.start();
    // Every tick 2.5 s late: no single delay near 10 s, the p99 far over 2 s.
    const slow = (ms: number): void => {
      for (let t = 0; t < ms; t += 3_000) {
        r.advance(3_000);
        r.sample(2_500);
      }
    };
    slow(60 * S);
    expect(r.monitor.evaluate().event_loop.state).toBe("ok"); // half a window: not yet sustained
    slow(60 * S);
    const st = r.monitor.evaluate();
    expect(st.event_loop.state).toBe("stalled");
    expect(st.event_loop.stall?.trigger).toBe("p99");
    expect(r.raised[0]!.detail).toMatch(
      /^event loop slow: p99 2\.5s over the last 2m00s \(max 2\.5s\)/,
    );
  });

  it("the stall slides out of the window and the loop reads ok again; the longest delay stays", () => {
    const r = rig();
    r.monitor.start();
    r.advance(15 * S);
    r.sample(15_000);
    const first = r.monitor.evaluate().event_loop;
    expect(first.state).toBe("stalled");
    const stalledAt = new Date(T0 + 15 * S).toISOString();
    expect(first.since).toBe(stalledAt);
    steady(r, 299 * S);
    // Still inside 5 min: still stalled — and `since` is when it BEGAN, not
    // this evaluation (`qcr status` prints "STALLED since <since>").
    const again = r.monitor.evaluate().event_loop;
    expect(again.state).toBe("stalled");
    expect(again.since).toBe(stalledAt);
    expect(r.monitor.status().event_loop.since).toBe(stalledAt);
    steady(r, 2 * S);
    const e = r.monitor.evaluate().event_loop;
    expect(e.state).toBe("ok");
    expect(e.since).toBe(new Date(T0 + 316 * S).toISOString()); // moved with the flip
    expect(e.max_ms).toBe(1);
    expect(e.longest_stall?.ms).toBe(15_000);
    steady(r, 30 * S);
    expect(r.monitor.evaluate().event_loop.since).toBe(new Date(T0 + 316 * S).toISOString());
  });

  it("the p99 threshold is inclusive: exactly stall_p99 over a full window stalls, a ms under does not", () => {
    const slowRig = (lagMs: number): Rig => {
      const r = rig({ knobs: { event_loop_window_s: 120 } });
      r.monitor.start();
      for (let t = 0; t < 120 * S; t += 3_000) {
        r.advance(3_000);
        r.sample(lagMs);
      }
      return r;
    };
    const at = slowRig(2_000).monitor.evaluate().event_loop;
    expect(at.state).toBe("stalled");
    expect(at.stall?.trigger).toBe("p99");
    expect(at.p99_ms).toBe(2_000);
    expect(slowRig(1_999).monitor.evaluate().event_loop.state).toBe("ok");
  });

  it("a sampler that stops reporting leaves the window empty: UNKNOWN, never ok", () => {
    const r = rig();
    r.monitor.start();
    steady(r, 10 * S);
    expect(r.monitor.evaluate().event_loop.state).toBe("ok");
    r.advance(301 * S);
    expect(r.monitor.evaluate().event_loop.state).toBe("unknown");
  });

  it("a FORWARD wall-clock step (a resume, an NTP step): two samples are not a sustained p99 — the samples must cover the window", () => {
    const r = rig();
    r.monitor.start();
    steady(r, 6 * MIN);
    expect(r.monitor.evaluate().event_loop).toMatchObject({ state: "ok", covered_s: 300 });
    // The wall clock jumps an hour; the monotonic delays stay small. The
    // window now holds only what came after.
    r.advance(60 * MIN);
    r.sample(2_100); // one hiccup, under stall_max, over stall_p99
    r.advance(500);
    r.sample(5);
    const e = r.monitor.evaluate().event_loop;
    expect(e.samples).toBe(2);
    expect(e.p99_ms).toBe(2_100);
    expect(e.state).toBe("ok");
    expect(e.stall).toBeNull();
    expect(e.covered_s).toBe(3); // 2.6 s + 0.5 s back from the first sample's end
    expect(r.raised).toEqual([]);
    // Once the samples cover a window again, a sustained p99 is judged again.
    for (let t = 0; t < 5 * MIN; t += 2_600) {
      r.advance(2_600);
      r.sample(2_100);
    }
    const again = r.monitor.evaluate().event_loop;
    expect(again.state).toBe("stalled");
    expect(again.stall?.trigger).toBe("p99");
    expect(again.covered_s).toBe(300);
    expect(r.raised).toHaveLength(1);
  });

  it("a BACKWARD wall-clock step: a sample stamped after now is dropped — an old stall does not stand for the length of the step", () => {
    const r = rig({ knobs: { event_loop_wake_cooldown_min: 5 } });
    r.monitor.start();
    r.advance(15 * S);
    r.sample(15_000);
    expect(r.monitor.evaluate().event_loop.state).toBe("stalled");
    expect(r.raised).toHaveLength(1);
    r.advance(-60 * MIN);
    steady(r, 10 * S);
    const back = r.monitor.evaluate();
    const e = back.event_loop;
    expect(e.state).toBe("ok");
    expect(e.max_ms).toBe(1);
    // cpu.stat readings from "the future" go too: never a negative window.
    expect(back.cpu).toMatchObject({
      state: "unknown",
      reason: "one reading so far — a ratio needs two",
    });
    // Past the cooldown, still nothing to wake about.
    for (let i = 0; i < 30; i++) {
      steady(r, 15 * S);
      r.monitor.evaluate();
    }
    expect(r.monitor.status().event_loop.state).toBe("ok");
    expect(r.raised).toHaveLength(1);
    // The longest delay since start is history, kept.
    expect(r.monitor.status().event_loop.longest_stall?.ms).toBe(15_000);
  });

  it("before the samples span a window, a high p99 is not sustained; covered_s says how much they span", () => {
    const r = rig({ knobs: { event_loop_window_s: 120 } });
    r.monitor.start();
    for (let t = 0; t < 115 * S; t += 2_500) {
      r.advance(2_500);
      r.sample(2_000);
    }
    const short = r.monitor.evaluate().event_loop;
    expect(short.state).toBe("ok");
    expect(short.covered_s).toBe(115);
    for (let t = 0; t < 5 * S; t += 2_500) {
      r.advance(2_500);
      r.sample(2_000);
    }
    const full = r.monitor.evaluate().event_loop;
    expect(full.covered_s).toBe(120);
    expect(full.state).toBe("stalled");
  });
});

describe("the wake — at most once per cooldown", () => {
  it("does not re-wake while a stall stands inside the cooldown, and re-wakes after it", () => {
    const r = rig({ knobs: { event_loop_wake_cooldown_min: 30 } });
    r.monitor.start();
    r.advance(20 * S);
    r.sample(20_000);
    r.monitor.evaluate();
    r.advance(15 * S);
    r.monitor.evaluate();
    expect(r.raised).toHaveLength(1);
    // A second stall 10 minutes later: still inside the cooldown — the state
    // and the board say so, the overseer is not woken twice.
    steady(r, 10 * MIN);
    r.advance(12 * S);
    r.sample(12_000);
    expect(r.monitor.evaluate().event_loop.state).toBe("stalled");
    expect(r.raised).toHaveLength(1);
    // Past the cooldown, a stall wakes again.
    steady(r, 20 * MIN);
    r.advance(11 * S);
    r.sample(11_000);
    r.monitor.evaluate();
    expect(r.raised).toHaveLength(2);
  });

  it("a raise that throws is swallowed — the watch keeps running", () => {
    const r = rig({
      raise: () => {
        throw new Error("overseer gone");
      },
    });
    r.monitor.start();
    r.advance(30 * S);
    r.sample(30_000);
    expect(() => r.monitor.evaluate()).not.toThrow();
    expect(r.monitor.status().event_loop.state).toBe("stalled");
  });

  it("stop() stops the sampler and the evaluation timer", () => {
    const set: unknown[] = [];
    const cleared: unknown[] = [];
    const sampler = new FakeSampler();
    const m = new DaemonLoadMonitor({
      policy: eventLoopPolicy(),
      raise: () => {},
      sampler,
      readCpuStat: () => ({ ok: false, reason: "x" }),
      setTimer: (_cb, ms) => {
        set.push(ms);
        return "h";
      },
      clearTimer: (h) => cleared.push(h),
    });
    m.start();
    m.start(); // idempotent
    expect(set).toEqual([15_000]);
    expect(sampler.starts).toBe(1);
    m.stop();
    expect(cleared).toEqual(["h"]);
    expect(sampler.stops).toBe(1);
  });

  it("an evaluation that throws never escapes — not from start() (the daemon's boot), not from the timer", () => {
    let throwing = true;
    const counter = cpuCounter(0.39);
    const r = rig({
      readCpuStat: () => {
        if (throwing) throw new Error("cpu.stat reader exploded");
        return counter.read();
      },
    });
    expect(() => r.monitor.start()).not.toThrow();
    expect(r.timers).toHaveLength(1);
    expect(() => r.timers[0]!()).not.toThrow();
    expect(r.logged.filter((m) => m.includes("evaluation failed"))).toHaveLength(2);
    // And the watch is still alive: once the reader recovers, the timer
    // evaluates again.
    throwing = false;
    r.advance(15 * S);
    r.sample(12_000);
    r.timers[0]!();
    expect(r.monitor.status().event_loop.state).toBe("stalled");
  });
});

describe("the cause: CPU starved vs the loop itself blocked — each from its own evidence", () => {
  /** A 25 s stall after 30 s of steady loop; `busyShare` is the daemon's own
   * CPU across the stall (undefined: the sampler did not measure it). */
  const stall = (
    readCpuStat: () => CpuStatRead,
    busyShare?: number,
    knobs?: Parameters<typeof eventLoopPolicy>[0],
  ): DaemonLoadStatus => {
    const r = rig({ readCpuStat, knobs });
    r.monitor.start();
    steady(r, 30 * S);
    r.monitor.evaluate();
    r.advance(25 * S);
    r.sample(25_000, busyShare);
    return r.monitor.evaluate();
  };

  it("throttled at or over the ratio ⇒ CPU starved, with the ratio and the seconds", () => {
    const st = stall(cpuCounter(0.39).read);
    expect(st.cpu).toMatchObject({
      state: "measured",
      source: "/sys/fs/cgroup/cpu.stat",
      periods: 300,
      throttled_periods: 118, // 59 of every 150 (0.39, rounded) over two readings
      throttled_ratio: 0.393,
    });
    expect(st.event_loop.stall?.cause).toBe("cpu_starved");
    expect(st.event_loop.stall?.detail).toContain("CPU starved");
  });

  it("the starved ratio is inclusive: throttled in EXACTLY that share is CPU starved", () => {
    const st = stall(cpuCounter(0.2).read);
    expect(st.cpu).toMatchObject({ state: "measured", throttled_ratio: 0.2 });
    expect(eventLoopPolicy().starvedRatio).toBe(0.2);
    expect(st.event_loop.stall?.cause).toBe("cpu_starved");
  });

  it("the starved ratio is the configured one: at 0.5, a 39%-throttled stall is not starvation", () => {
    // The daemon off CPU across the stall, so only the throttling can speak.
    const st = stall(cpuCounter(0.39).read, 0.1, { event_loop_starved_throttle_ratio: 0.5 });
    expect(st.event_loop.thresholds.starved_throttle_ratio).toBe(0.5);
    expect(st.event_loop.stall?.cause).toBe("unknown");
    expect(
      stall(cpuCounter(0.5).read, 0.1, { event_loop_starved_throttle_ratio: 0.5 }).event_loop.stall
        ?.cause,
    ).toBe("cpu_starved");
  });

  it("the STALL'S OWN evidence wins: on CPU for most of the delay in a container throttled past the ratio ⇒ the loop itself blocked, the throttling named beside it", () => {
    // The post-drain burst: the container 39% throttled over the window, and
    // the daemon on CPU for 95% of a 25 s delay. A throttle lasts only until
    // the next ~100 ms CFS period; the daemon's own work held the loop.
    const st = stall(cpuCounter(0.39).read, 0.95);
    expect(st.cpu).toMatchObject({ state: "measured", throttled_ratio: 0.393 });
    expect(st.event_loop.stall).toMatchObject({ cause: "loop_blocked", busy_share: 0.95 });
    const detail = st.event_loop.stall!.detail;
    expect(detail).toContain(
      "the loop itself blocked: the daemon was on CPU for 95% of the delay, so its own synchronous work held the loop (the container was also throttled in 39% of its CFS periods",
    );
    expect(detail).toContain("a throttle lasts only until the next CFS period");
    expect(detail).not.toContain("CPU starved");
    expect(detail).not.toContain("only 39%");
    // …and the same stall with the daemon OFF CPU is CPU starved.
    expect(stall(cpuCounter(0.39).read, 0.1).event_loop.stall?.cause).toBe("cpu_starved");
  });

  it("the review's probe: a 30 s delay the daemon spent 29 s of on CPU, the window 25% throttled ⇒ loop_blocked, never cpu_starved", () => {
    const r = rig({ readCpuStat: cpuCounter(0.25).read });
    r.monitor.start();
    steady(r, 30 * S);
    r.monitor.evaluate();
    r.advance(30 * S);
    r.monitor.record(30_000, new Date(r.clock.ms), { cpuMs: 29_000, spanMs: 30_500 });
    const st = r.monitor.evaluate();
    expect(st.cpu).toMatchObject({ state: "measured", throttled_ratio: 0.253 });
    expect(st.event_loop.stall).toMatchObject({
      trigger: "max",
      cause: "loop_blocked",
      busy_share: 0.951,
    });
    expect(r.raised[0]!.detail).toContain("the container was also throttled in 25%");
    expect(r.raised[0]!.message).toContain("The loop itself blocked means");
    expect(r.raised[0]!.message).not.toContain("CPU starved means");
  });

  it("barely throttled and the daemon ON CPU across the stall ⇒ the loop itself blocked", () => {
    const st = stall(cpuCounter(0.03).read, 0.97);
    expect(st.cpu.state).toBe("measured");
    expect(st.event_loop.stall?.cause).toBe("loop_blocked");
    expect(st.event_loop.stall?.busy_share).toBe(0.97);
    expect(st.event_loop.stall?.detail).toContain(
      "the loop itself blocked: the daemon was on CPU for 97% of the delay, so its own synchronous work held the loop (the container was throttled in only 3% of its CFS periods",
    );
  });

  it("barely throttled but the daemon NOT on CPU ⇒ cause unknown, naming what remains — never 'the loop itself blocked'", () => {
    // The shared VM: host contention starves the container without it
    // reaching its quota, so a low throttle ratio alone proves nothing.
    const st = stall(cpuCounter(0.03).read, 0.08);
    expect(st.event_loop.stall?.cause).toBe("unknown");
    expect(st.event_loop.stall?.busy_share).toBe(0.08);
    expect(st.event_loop.stall?.detail).toContain(
      "cause unknown: the container was throttled in only 3% of its CFS periods",
    );
    expect(st.event_loop.stall?.detail).toContain("the daemon was on CPU for only 8% of the delay");
    expect(st.event_loop.stall?.detail).toContain("host contention on the VM, or a blocking wait");
    expect(st.event_loop.stall?.detail).not.toContain("loop itself blocked");
  });

  it("barely throttled and the daemon's CPU NOT MEASURED ⇒ cause unknown, never by elimination", () => {
    const st = stall(cpuCounter(0.03).read);
    expect(st.event_loop.stall?.cause).toBe("unknown");
    expect(st.event_loop.stall?.busy_share).toBeNull();
    expect(st.event_loop.stall?.detail).toContain(
      "the daemon's own CPU time across the delay was not measured",
    );
  });

  it("the busy share is the threshold's: just under it is not the daemon's own work", () => {
    expect(LOOP_BUSY_SHARE).toBe(0.5);
    expect(stall(cpuCounter(0.03).read, 0.5).event_loop.stall?.cause).toBe("loop_blocked");
    expect(stall(cpuCounter(0.03).read, 0.49).event_loop.stall?.cause).toBe("unknown");
  });

  it("a sustained (p99) stall judges the daemon's CPU over the whole window", () => {
    // 39 delays of 2.5 s at `busyShare`, and the window's longest (2.6 s, so
    // still the p99 trigger) at the OPPOSITE share — the window decides, not
    // that one delay.
    const run = (busyShare: number, longestShare: number): DaemonLoadStatus => {
      const r = rig({ readCpuStat: cpuCounter(0.03).read, knobs: { event_loop_window_s: 120 } });
      r.monitor.start();
      for (let i = 0; i < 40; i++) {
        r.advance(3_000);
        if (i === 20) r.sample(2_600, longestShare);
        else r.sample(2_500, busyShare);
      }
      return r.monitor.evaluate();
    };
    const busy = run(0.9, 0.05);
    // (39 × 2,700 + 155) CPU-ms over (39 × 3,000 + 3,100) ms = 0.878.
    expect(busy.event_loop.stall).toMatchObject({
      trigger: "p99",
      cause: "loop_blocked",
      busy_share: 0.878,
    });
    expect(busy.event_loop.max_ms).toBe(2_600);
    expect(busy.event_loop.stall?.detail).toContain("on CPU for 88% of the window");
    expect(run(0.1, 0.99).event_loop.stall?.cause).toBe("unknown");
  });

  it("a sustained stall in a throttled container: the window's busy share still decides first", () => {
    const run = (busyShare: number): DaemonLoadStatus => {
      const r = rig({ readCpuStat: cpuCounter(0.39).read, knobs: { event_loop_window_s: 120 } });
      r.monitor.start();
      for (let i = 0; i < 40; i++) {
        r.advance(3_000);
        r.sample(2_500, busyShare);
      }
      return r.monitor.evaluate();
    };
    expect(run(0.9).event_loop.stall).toMatchObject({ trigger: "p99", cause: "loop_blocked" });
    expect(run(0.9).event_loop.stall?.detail).toContain(
      "on CPU for 90% of the window, so its own synchronous work held the loop (the container was also throttled in 39%",
    );
    expect(run(0.1).event_loop.stall).toMatchObject({ trigger: "p99", cause: "cpu_starved" });
  });

  it("no cgroup file ⇒ cpu UNKNOWN with its reason, and the stall's cause unknown", () => {
    const dir = tempDir("qcr-nocg-");
    const st = stall(() => readCgroupCpuStat(join(dir, "cpu.stat")));
    expect(st.cpu).toEqual({
      state: "unknown",
      source: "/sys/fs/cgroup/cpu.stat",
      reason: `no ${join(dir, "cpu.stat")} (not a cgroup v2 container)`,
      at: null,
    });
    expect(st.event_loop.stall?.cause).toBe("unknown");
    expect(st.event_loop.stall?.detail).toContain("cause unknown: no CPU throttling figures");
  });

  it("no cgroup figures but the daemon on CPU across the stall ⇒ the loop itself blocked (its own evidence)", () => {
    const st = stall(() => ({ ok: false, reason: "no cpu.stat" }), 0.99);
    expect(st.cpu.state).toBe("unknown");
    expect(st.event_loop.stall?.cause).toBe("loop_blocked");
    expect(st.event_loop.stall?.detail).toContain(
      "the loop itself blocked: the daemon was on CPU for 99% of the delay, so its own synchronous work held the loop (container throttling unknown: no cpu.stat)",
    );
  });

  it("NO QUOTA as the kernel really writes it (counters present, zero) ⇒ cpu UNKNOWN, and a stall's cause unknown — never a 0% that reads 'the loop itself blocked'", () => {
    let noQuotaReads = 0;
    const realNoQuota = (): CpuStatRead => {
      const stat = parseCpuStat(NO_QUOTA_CPU_STAT)!;
      return { ok: true, stat: { ...stat, usage_usec: stat.usage_usec + noQuotaReads++ * 1_000 } };
    };
    const st = stall(realNoQuota);
    expect(noQuotaReads).toBeGreaterThanOrEqual(2);
    expect(st.cpu).toMatchObject({
      state: "unknown",
      reason: "no CPU quota: cpu.stat has counted no CFS period",
    });
    expect(st.event_loop.stall?.cause).toBe("unknown");
    expect(st.event_loop.stall?.detail).toContain(
      "cause unknown: no CPU throttling figures (no CPU quota",
    );
  });

  it("one failed cpu.stat read is not forever: two good readings later the figures are measured again", () => {
    const counter = cpuCounter(0.39);
    let failNext = false;
    const r = rig({
      readCpuStat: () => {
        if (failNext) {
          failNext = false;
          return { ok: false, reason: "transient EIO" };
        }
        return counter.read();
      },
    });
    r.monitor.start(); // good reading 1
    r.advance(15 * S);
    expect(r.monitor.evaluate().cpu.state).toBe("measured"); // good reading 2
    failNext = true;
    r.advance(15 * S);
    expect(r.monitor.evaluate().cpu).toMatchObject({ state: "unknown", reason: "transient EIO" });
    r.advance(15 * S);
    expect(r.monitor.evaluate().cpu.state).toBe("measured");
    r.advance(10 * S);
    r.sample(20_000);
    expect(r.monitor.evaluate().event_loop.stall?.cause).toBe("cpu_starved");
  });

  it("a baseline reading with no bandwidth counters (a quota appeared since) is UNKNOWN — never a whole-history ratio", () => {
    let n = 0;
    const r = rig({
      readCpuStat: () => {
        n += 1;
        return n === 1
          ? { ok: true, stat: parseCpuStat("usage_usec 10\n")! }
          : {
              ok: true,
              stat: {
                usage_usec: 9_000_000_000,
                nr_periods: 50_000,
                nr_throttled: 45_000,
                throttled_usec: 9_000_000_000,
              },
            };
      },
    });
    r.monitor.start();
    r.advance(15 * S);
    expect(r.monitor.evaluate().cpu).toMatchObject({
      state: "unknown",
      reason:
        "the window's baseline reading carried no CFS bandwidth counters (a CPU quota appeared since)",
    });
    r.advance(5 * S);
    r.sample(20_000);
    expect(r.monitor.evaluate().event_loop.stall?.cause).toBe("unknown");
  });

  it("one reading, no quota, a reset: each UNKNOWN with why — never a 0% that reads healthy", () => {
    const r = rig();
    r.monitor.start();
    expect(r.monitor.status().cpu).toMatchObject({
      state: "unknown",
      reason: "one reading so far — a ratio needs two",
    });

    const noQuota = rig({
      readCpuStat: () => ({ ok: true, stat: parseCpuStat("usage_usec 10\n")! }),
    });
    noQuota.monitor.start();
    noQuota.advance(15 * S);
    expect(noQuota.monitor.evaluate().cpu).toMatchObject({
      state: "unknown",
      reason: "no CPU quota: cpu.stat carries no CFS bandwidth counters",
    });

    let n = 0;
    const reset = rig({
      readCpuStat: () => {
        n += 1;
        const big = n === 1 ? 1_000_000 : 10;
        return {
          ok: true,
          stat: { usage_usec: big, nr_periods: big, nr_throttled: 0, throttled_usec: 0 },
        };
      },
    });
    reset.monitor.start();
    reset.advance(15 * S);
    expect(reset.monitor.evaluate().cpu).toMatchObject({
      state: "unknown",
      reason: "the counters went backwards (the cgroup was reset)",
    });
  });

  it("the deltas span the window: older readings drop out, one stays as the baseline", () => {
    const counter = cpuCounter(0.1);
    const r = rig({ readCpuStat: counter.read, knobs: { event_loop_window_s: 60 } });
    r.monitor.start(); // reading 1 at T0
    for (let i = 0; i < 10; i++) {
      steady(r, 15 * S);
      r.monitor.evaluate();
    }
    const cpu = r.monitor.status().cpu;
    expect(cpu.state).toBe("measured");
    if (cpu.state === "measured") {
      expect(cpu.window_s).toBe(60);
      expect(cpu.periods).toBe(600);
      expect(cpu.throttled_ratio).toBe(0.1);
    }
  });
});

// ---- status.json, through a stub-wired daemon --------------------------------------

/** A stub-wired daemon whose event-loop watch the test drives by hand. */
function stubDaemon(
  root: string,
  store: StateStore,
  opts: { daemon?: Partial<Config["daemon"]>; injected?: string[]; clock: { ms: number } },
): { daemon: ReturnType<typeof createDaemon>; sampler: FakeSampler } {
  for (const d of ["state", "state/dryrun", "verdict", "inject"])
    mkdirSync(join(root, d), { recursive: true });
  const adapter = {
    searchLabelTriggered: async () => [],
    searchTeamTriggered: async () => [],
    listOpenPrs: async () => [],
    stalenessScan: async () => [],
    listBotReviewComments: async () => [],
  } as unknown as DaemonAdapter;
  const base = loadConfig(join(process.cwd(), "tests/fixtures/config.toml"));
  const cfg: Config = { ...base, daemon: { ...base.daemon, ...opts.daemon } };
  const sampler = new FakeSampler();
  const daemon = createDaemon({
    cfg,
    root,
    store,
    adapter,
    hooks: {
      ...stubSessionHooks(root),
      injectOverseer: async (m: string) => {
        opts.injected?.push(m);
      },
    },
    listen: false,
    log: () => {},
    eventLoop: {
      sampler,
      readCpuStat: cpuCounter(0.45).read,
      now: () => new Date(opts.clock.ms),
      setTimer: () => "never",
      clearTimer: () => {},
    },
  });
  return { daemon, sampler };
}

describe("status.json `daemon` — the daemon measuring itself", () => {
  it(
    "the configured [daemon] event_loop_* thresholds reach the daemon's own watch",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const root = tempDir("qcr-evloop-knob-");
      const store = new StateStore(":memory:");
      const clock = { ms: T0 };
      try {
        const { daemon, sampler } = stubDaemon(root, store, {
          daemon: { event_loop_stall_max_s: 30 },
          clock,
        });
        await daemon.start();
        clock.ms += 25 * S;
        sampler.sink!(20_000, new Date(clock.ms)); // over the 10 s default, under the 30 s set
        const e = daemon.load.evaluate().event_loop;
        expect(e.thresholds.stall_max_ms).toBe(30_000);
        expect(e.state).toBe("ok");
        expect(store.anomalies(10).filter((a) => a.kind === EVENT_LOOP_WAKE_KIND)).toEqual([]);
        await daemon.stop();
      } finally {
        store.close();
      }
    },
  );

  it(
    "the heartbeat carries the block; a stall raises `daemon_event_loop_stalled` through the ONE anomaly funnel and wakes the overseer",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const root = tempDir("qcr-evloop-");
      const store = new StateStore(":memory:");
      const injected: string[] = [];
      const clock = { ms: T0 };
      try {
        const { daemon, sampler } = stubDaemon(root, store, { injected, clock });
        await daemon.start();
        const first = JSON.parse(
          readFileSync(join(root, "state", "status.json"), "utf8"),
        ) as StatusSnapshot;
        // Booted, nothing sampled yet: unknown, never ok.
        expect(first.daemon?.event_loop.state).toBe("unknown");
        expect(first.daemon?.cpu.state).toBe("unknown");
        expect(sampler.starts).toBe(1);

        clock.ms += 80 * S;
        sampler.sink!(70_000, new Date(clock.ms));
        daemon.load.evaluate();
        const anomalies = store.anomalies(10).filter((a) => a.kind === EVENT_LOOP_WAKE_KIND);
        expect(anomalies).toHaveLength(1);
        expect(anomalies[0]!.pr).toBeNull();
        expect(anomalies[0]!.detail).toContain("CPU starved");
        await new Promise((r) => setImmediate(r));
        expect(injected.filter((m) => m.startsWith("DAEMON EVENT LOOP STALLED"))).toHaveLength(1);

        await daemon.stop();
        expect(sampler.stops).toBe(1);
        const last = JSON.parse(
          readFileSync(join(root, "state", "status.json"), "utf8"),
        ) as StatusSnapshot;
        expect(last.daemon?.event_loop).toMatchObject({ state: "stalled", max_ms: 70_000 });
        expect(last.daemon?.cpu).toMatchObject({ state: "measured", throttled_ratio: 0.453 });
      } finally {
        store.close();
      }
    },
  );

  it("buildStatusSnapshot carries the block when given, and omits it when not", () => {
    const store = new StateStore(":memory:");
    try {
      expect(buildStatusSnapshot(store, false).daemon).toBeUndefined();
      const r = rig();
      r.monitor.start();
      const snap = buildStatusSnapshot(
        store,
        false,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        r.monitor.status(),
      );
      expect(JSON.parse(JSON.stringify(snap)).daemon.event_loop.state).toBe("unknown");
    } finally {
      store.close();
    }
  });
});

// ---- what a person reads -----------------------------------------------------------

function stalledBlock(cause: "cpu" | "blocked" | "unknown" = "cpu"): DaemonLoadStatus {
  const r = rig({
    readCpuStat:
      cause === "cpu"
        ? cpuCounter(0.39).read
        : cause === "blocked"
          ? cpuCounter(0.02).read
          : () => ({ ok: false, reason: "no /sys/fs/cgroup/cpu.stat (not a cgroup v2 container)" }),
  });
  r.monitor.start();
  steady(r, 30 * S);
  r.monitor.evaluate();
  r.advance(70 * S);
  // "blocked" is the daemon's own work: on CPU for 98% of the delay.
  r.sample(70_000, cause === "blocked" ? 0.98 : undefined);
  return r.monitor.evaluate();
}

function okBlock(): DaemonLoadStatus {
  const r = rig();
  r.monitor.start();
  steady(r, 30 * S, 3);
  return r.monitor.evaluate();
}

function unknownBlock(): DaemonLoadStatus {
  const r = rig();
  r.monitor.start();
  return r.monitor.status();
}

const NOW = new Date(T0 + 200 * S);

function snap(daemon?: DaemonLoadStatus): StatusSnapshot {
  return {
    written_at: NOW.toISOString(),
    dry_run: false,
    prs: [],
    running_rounds: 6,
    max_concurrent_rounds: 12,
    total_spend_usd: 0,
    today_spend_usd: 1.5,
    heartbeat: NOW.toISOString(),
    ...(daemon ? { daemon } : {}),
  };
}

/** A block as a reader gets it back: parsed JSON, to be bent out of shape. */
function json(d: DaemonLoadStatus): Record<string, Record<string, unknown>> {
  return JSON.parse(JSON.stringify(d)) as Record<string, Record<string, unknown>>;
}

/** A snapshot whose `daemon` is whatever JSON a file held. */
function rawSnap(daemon: unknown): StatusSnapshot {
  return { ...snap(), daemon: daemon as DaemonLoadStatus };
}

function view(daemon?: DaemonLoadStatus, over: Partial<BoardView> = {}): BoardView {
  return {
    health: { kind: "ok", heartbeatAgeS: 2 },
    dryRun: false,
    events: [],
    selected: 0,
    eventsFocus: false,
    eventsScroll: 0,
    help: false,
    snapshot: snap(daemon),
    now: NOW,
    ...over,
  };
}

describe("`qcr status` — the daemon event-loop line", () => {
  it("ok: the window's figures, the longest delay and the container's throttling", () => {
    const line = daemonLoadLine(okBlock());
    expect(line).toMatch(
      /^daemon event loop: ok — p50 3ms · p99 3ms · max 3ms over 30\.0s \(60 samples\)/,
    );
    expect(line).toContain("longest since 2026-10-07T13:29:00.000Z: 3ms");
    expect(line).toContain("container CPU: throttled in 39% of 150 CFS periods");
  });

  it("stalled: since when, the detail with its cause, and when the overseer was woken", () => {
    const line = daemonLoadLine(stalledBlock());
    expect(line).toMatch(
      /^daemon event loop: STALLED since 2026-10-07T13:30:40\.000Z — event loop stalled 1m10s/,
    );
    expect(line).toContain("CPU starved");
    expect(line).toContain("overseer woken 2026-10-07T13:30:40.000Z");
  });

  it("never prints ok for a block that is absent, unmeasured, or a cgroup that cannot be read", () => {
    expect(daemonLoadLine(undefined)).toBe(
      "daemon event loop: NOT REPORTED (this daemon predates the event-loop block)",
    );
    expect(daemonLoadLine(unknownBlock())).toMatch(
      /^daemon event loop: UNKNOWN — no sample in the window yet/,
    );
    expect(daemonLoadLine(unknownBlock())).toContain(
      "container CPU throttling: UNKNOWN — one reading so far",
    );
    const st = stalledBlock("unknown");
    expect(daemonLoadLine(st)).toContain("cause unknown: no CPU throttling figures");
  });

  it("renderStatus prints it right after the memory line", () => {
    const lines = renderStatus(snap(stalledBlock())).split("\n");
    expect(lines[2]).toContain("memory:");
    expect(lines[3]).toMatch(/^daemon event loop: STALLED/);
  });

  it("an UNREADABLE block — a newer daemon's state, a missing event_loop or cpu, a wrong type — is UNKNOWN with why, and `qcr status` still prints", () => {
    const ok = json(okBlock());
    const line = (d: unknown): string => renderStatus(rawSnap(d)).split("\n")[3]!;
    expect(line({})).toBe(
      "daemon event loop: UNKNOWN (unreadable block: the daemon block carries no event_loop); container CPU throttling: UNKNOWN — the daemon block carries no cpu figures",
    );
    expect(line({ ...ok, event_loop: { ...ok.event_loop, state: "draining" } })).toMatch(
      /^daemon event loop: UNKNOWN \(unreadable block: state "draining" is not one this build knows\); container CPU: throttled in 39%/,
    );
    expect(line({ event_loop: ok.event_loop })).toMatch(
      /^daemon event loop: ok — p50 3ms .*; container CPU throttling: UNKNOWN — the daemon block carries no cpu figures$/,
    );
    expect(line({ ...ok, cpu: { ...ok.cpu, throttled_s: "lots" } })).toMatch(
      /container CPU throttling: UNKNOWN — the cpu figures are unreadable \(cpu\.throttled_s is "lots", not a number\)$/,
    );
    expect(line({ ...ok, cpu: { state: "melted" } })).toContain(
      'the cpu figures are unreadable (state "melted" is not one this build knows)',
    );
    expect(line({ ...ok, event_loop: { ...ok.event_loop, longest_stall: 5 } })).toContain(
      "UNKNOWN (unreadable block: event_loop.longest_stall is unreadable)",
    );
    expect(line(null)).toContain(
      "UNKNOWN (unreadable block: the daemon block is null, not an object)",
    );
    expect(line("stalled")).toContain('the daemon block is "stalled", not an object');
    expect(line([])).toContain("the daemon block is an array, not an object");
  });

  it("is TOTAL: every field of a real block deleted or retyped — nothing throws, and a broken `state` never reads ok", () => {
    for (const block of [okBlock(), stalledBlock(), stalledBlock("blocked"), unknownBlock()]) {
      const real = json(block);
      for (const part of ["event_loop", "cpu"] as const) {
        const keys = Object.keys(real[part] as object);
        for (const k of keys)
          for (const bad of [undefined, null, "x", 7, {}, []]) {
            const mutated = json(block);
            const target = mutated[part] as Record<string, unknown>;
            if (bad === undefined) delete target[k];
            else target[k] = bad;
            const where = `${part}.${k} = ${JSON.stringify(bad)}`;
            let out = "";
            expect(() => (out = daemonLoadLine(mutated)), where).not.toThrow();
            expect(typeof out, where).toBe("string");
            expect(() => renderStatus(rawSnap(mutated)), where).not.toThrow();
            expect(() => eventLoopSegment(rawSnap(mutated)), where).not.toThrow();
            expect(
              () => renderBoard(view(undefined, { snapshot: rawSnap(mutated) }), 220, 30),
              where,
            ).not.toThrow();
            if (part === "event_loop" && k === "state")
              expect(out, where).toMatch(/^daemon event loop: UNKNOWN \(unreadable block/);
          }
      }
    }
  });
});

describe("the TUI board — a top-bar banner, the way memory incidents are", () => {
  it("a stall is loud, with what held and the cause in a few words", () => {
    const bar = stripAnsi(topBar(view(stalledBlock()), 220));
    expect(bar).toContain("⛔ DAEMON LOOP STALLED 1m10s · CPU starved (39% throttled)");
    expect(bar.indexOf("DAEMON LOOP")).toBeLessThan(bar.indexOf("rounds 6/12"));
    expect(stripAnsi(topBar(view(stalledBlock("blocked")), 220))).toContain(
      "⛔ DAEMON LOOP STALLED 1m10s · loop itself blocked (on CPU 98%)",
    );
    expect(stripAnsi(topBar(view(stalledBlock("unknown")), 220))).toContain(
      "⛔ DAEMON LOOP STALLED 1m10s · cause unknown",
    );
  });

  it("is on the board's first line — whatever tab the operator was in, the bar is the board's", () => {
    const frame = renderBoard(view(stalledBlock()), 220, 30);
    expect(stripAnsi(frame.lines[0]!)).toContain("DAEMON LOOP STALLED");
  });

  it("ok paints nothing; unknown and an older daemon's missing block are a dim `loop ?` at the END", () => {
    expect(eventLoopSegment(snap(okBlock()))).toBeUndefined();
    for (const d of [unknownBlock(), undefined]) {
      const seg = eventLoopSegment(snap(d))!;
      expect(seg.loud).toBe(false);
      expect(stripAnsi(seg.text)).toBe("loop ?");
      const bar = stripAnsi(topBar(view(d), 220));
      expect(bar.indexOf("loop ?")).toBeGreaterThan(bar.indexOf("today"));
    }
    // No snapshot at all: the board already says it knows nothing.
    expect(eventLoopSegment(undefined)).toBeUndefined();
  });

  it("an unreadable block is the quiet `loop ?` — never nothing (which reads ok), never a throw out of the paint", () => {
    const ok = json(okBlock());
    const stalled = json(stalledBlock());
    for (const d of [
      {},
      null,
      { ...ok, event_loop: { ...ok.event_loop, state: "draining" } }, // a newer daemon
      { ...stalled, event_loop: { ...stalled.event_loop, max_ms: "70s" } },
    ]) {
      const seg = eventLoopSegment(rawSnap(d))!;
      expect(seg.loud).toBe(false);
      expect(stripAnsi(seg.text)).toBe("loop ?");
      expect(
        stripAnsi(renderBoard(view(undefined, { snapshot: rawSnap(d) }), 220, 30).lines[0]!),
      ).toContain("loop ?");
    }
    // A stall whose cpu figures are missing is still a stall — the cause from
    // what the block says, the throttling simply not named.
    const noCpu = { event_loop: stalled.event_loop };
    expect(stripAnsi(eventLoopSegment(rawSnap(noCpu))!.text)).toBe(
      "⛔ DAEMON LOOP STALLED 1m10s · CPU starved",
    );
    expect(stallShortPhrase({})).toBe("DAEMON LOOP ? · unreadable block");
    expect(stallShortPhrase(undefined)).toBe("DAEMON LOOP ? · not reported");
  });

  it("neither the banner nor the quiet mark shifts the alert badge's click zone", () => {
    const badge: AlertBadge = {
      count: 1,
      folds: 0,
      latest: { tier: "alert", title: "x overdue", cause: "c", pr: 1, ts: "t" },
    };
    for (const d of [undefined, stalledBlock()]) {
      const v = view(d, { alerts: badge });
      const zone = alertZone(v, 240)!;
      const bar = stripAnsi(topBar(v, 240));
      expect(sliceDisplay(bar, zone.x1 - 1, zone.x2)).toBe(stripAnsi(alertSegment(badge, false)));
    }
  });
});

describe("the companion's view.json carries the block (null when unread)", () => {
  it("null with no snapshot, null for a daemon that reports no block, the block otherwise", () => {
    expect(buildTuiView({ now: NOW, tab: "board" }).daemon).toBeNull();
    expect(buildTuiView({ now: NOW, tab: "board", snapshot: snap() }).daemon).toBeNull();
    const b = stalledBlock();
    expect(buildTuiView({ now: NOW, tab: "board", snapshot: snap(b) }).daemon).toEqual(b);
  });

  it("the tui_board answer says UNKNOWN for a null block — never drops the line", () => {
    expect(viewLine(null)).toMatch(
      /^daemon event loop: UNKNOWN \(the TUI has not been able to read it/,
    );
    expect(viewLine(undefined)).toMatch(
      /^daemon event loop: UNKNOWN \(this TUI build publishes no daemon field\)/,
    );
    expect(viewLine(JSON.parse(JSON.stringify(unknownBlock())))).toMatch(
      /^daemon event loop: UNKNOWN \(not measured yet\); container CPU throttling UNKNOWN \(one reading so far/,
    );
    const stalled = viewLine(JSON.parse(JSON.stringify(stalledBlock())));
    expect(stalled).toMatch(
      /^daemon event loop: STALLED since 2026-10-07T13:30:40\.000Z — event loop stalled 1m10s/,
    );
    expect(stalled).toContain("CPU starved");
    expect(viewLine(JSON.parse(JSON.stringify(okBlock())))).toMatch(
      /^daemon event loop: ok — p50 3ms, p99 3ms, max 3ms over 30s; longest 3ms ended .*; container CPU throttled in 39% of CFS periods/,
    );

    const dir = tempDir("qcr-feed-");
    writeFileSync(
      join(dir, "view.json"),
      JSON.stringify(buildTuiView({ now: NOW, tab: "board", snapshot: snap() })),
    );
    expect(boardAnswer(dir, NOW)).toContain("daemon event loop: UNKNOWN");
    writeFileSync(
      join(dir, "view.json"),
      JSON.stringify(buildTuiView({ now: NOW, tab: "board", snapshot: snap(stalledBlock()) })),
    );
    expect(boardAnswer(dir, NOW)).toContain("daemon event loop: STALLED");
  });
});

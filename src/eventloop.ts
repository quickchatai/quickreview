// The daemon's own event-loop lag, and the container's CPU throttling beside
// it (L2, after the 2026-10-07 post-drain burst).
//
// During that burst six drained rounds started together, the 2-CPU container
// was throttled in 39% of its CFS periods, and the daemon's own `/health` gave
// no answer for up to ~70 s at a time while status.json lagged minutes. Nothing
// measured either, so the stall was invisible: every surface a person looks at
// reads status.json, and status.json is written by the very loop that stalled.
// This module measures both, and says which one it was:
//
//   event-loop delay — a DRIFT SAMPLER: a timer due every SAMPLE_INTERVAL_MS
//     whose lateness IS the loop's delay. (`perf_hooks.monitorEventLoopDelay`
//     is the same timer in native code, but its histogram cannot say WHEN its
//     max happened, and "when" is what lines a stall up with the daemon log.)
//     Reported as p50/p99/max over the last window, plus the longest delay
//     since the daemon started, with when it began and ended.
//   CPU throttling — `/sys/fs/cgroup/cpu.stat` (cgroup v2) read at every
//     evaluation; the counter DELTAS over the same window give the share of
//     CFS periods throttled and the seconds lost. A missing file, a cgroup with
//     no CPU quota, or a single reading is UNKNOWN with its reason — never 0.
//   the daemon's own CPU time — the sampler reads `process.cpuUsage()` at
//     every tick, so each delay carries how much CPU the daemon process used
//     across it. That is the POSITIVE evidence for "the loop itself blocked":
//     cgroup throttling alone cannot say it, because on the shared VM the
//     container can be starved by host contention without reaching its quota.
//
// A stall past the thresholds — one delay of `stall_max` or more, or a p99 of
// `stall_p99` or more over a window the samples COVER (sustained) — is state
// `stalled`, shown in status.json `daemon.event_loop`, `qcr status`, the TUI
// board's top bar and the companion's view, and raises the WAKE kind
// `daemon_event_loop_stalled` (src/anomalies.ts) at most once per cooldown.
// The wake NAMES THE CAUSE, and only from evidence, the stall's OWN first:
// "the loop itself blocked" when the daemon was on CPU for at least
// LOOP_BUSY_SHARE of the stall (its own synchronous work held the loop — the
// container's throttling, if any, is named beside it); else "CPU starved" when
// the container was throttled in at least `starved_throttle_ratio` of its
// periods over the window; else "cause unknown" — with what was and was not
// seen (not throttled and not busy leaves host contention or a blocking wait,
// e.g. synchronous disk I/O; a figure that could not be read says so). The
// order matters: CFS throttling pauses the container only until the next
// period (~100 ms), so it cannot itself make a multi-second delay the daemon
// spent on CPU, and the throttle ratio is the WINDOW's while the busy share is
// the stall's own.
//
// The window is read on the wall clock (its samples carry when they ended) and
// the delays on the monotonic one. A wall-clock step (a resume, an NTP step)
// must neither fabricate nor prolong a stall: a sample stamped after "now" is
// dropped, and the p99 trigger needs the samples themselves to cover the
// window — never just time since start.
//
// status.json is read back by `qcr status` and the TUI board as parsed JSON
// from whichever daemon wrote it, so every reader here is TOTAL: a block this
// build cannot read whole is UNKNOWN with why (`readDaemonLoad`), never a
// throw and never ok.
//
// Nothing here touches GitHub, memory or a round; the wake is an injected sink
// (daemon.ts routes it through `store.logAnomaly`, whose wake policy reaches
// the overseer). Every timer is unref'd, so the watch never holds the process.

import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

/** The wake kind (listed in `src/anomalies.ts` WAKE_KINDS). */
export const EVENT_LOOP_WAKE_KIND = "daemon_event_loop_stalled";

/** Where cgroup v2 keeps the container's CPU accounting, inside the container. */
export const CGROUP_CPU_STAT = "/sys/fs/cgroup/cpu.stat";

/** The drift sampler's cadence: 600 samples in a 5-minute window. */
export const SAMPLE_INTERVAL_MS = 500;

/** How often the monitor reads cpu.stat, re-judges the window and may wake. */
export const EVALUATE_INTERVAL_MS = 15_000;

export const DEFAULT_EVENT_LOOP_WINDOW_S = 300;
export const DEFAULT_EVENT_LOOP_STALL_MAX_S = 10;
export const DEFAULT_EVENT_LOOP_STALL_P99_S = 2;
export const DEFAULT_EVENT_LOOP_WAKE_COOLDOWN_MIN = 60;
export const DEFAULT_EVENT_LOOP_STARVED_THROTTLE_RATIO = 0.2;

/**
 * The share of a stall's wall time the daemon process must have spent on CPU
 * for the stall to read "the loop itself blocked". A synchronous block keeps
 * the main thread on CPU (~1.0, more with helper threads); a starved or
 * waiting process gets far less. A delay's span includes the sampler's own
 * 500 ms idle interval, so even a 1 s block (the clamped minimum threshold)
 * reads ≥ 0.66 when it was the daemon's own work.
 */
export const LOOP_BUSY_SHARE = 0.5;

/**
 * How far short of the window its samples may reach and still COVER it — the
 * sampler's own granularity. Each sample spans the sampler's interval plus its
 * delay, back to the previous tick, so a sampler that ran throughout covers
 * the whole window; one whose earlier samples left it (a forward wall-clock
 * step, a fresh start) does not, and its p99 is not "sustained".
 */
const COVERAGE_SLACK_MS = 2 * SAMPLE_INTERVAL_MS;

/** The resolved, clamped thresholds (from `[daemon] event_loop_*`). */
export interface EventLoopPolicy {
  windowMs: number;
  stallMaxMs: number;
  stallP99Ms: number;
  cooldownMs: number;
  starvedRatio: number;
}

/** The `[daemon]` keys this watch reads — all optional, all defaulted. */
export interface EventLoopKnobs {
  event_loop_window_s?: unknown;
  event_loop_stall_max_s?: unknown;
  event_loop_stall_p99_s?: unknown;
  event_loop_wake_cooldown_min?: unknown;
  event_loop_starved_throttle_ratio?: unknown;
}

/**
 * The policy from config. A value that is not a finite number falls back to
 * its default (a typo must never stop the daemon booting, and never switch the
 * watch off); a number is clamped into a sane range — a 1-second window or a
 * zero threshold would turn every GC pause into a wake.
 */
export function eventLoopPolicy(k: EventLoopKnobs = {}): EventLoopPolicy {
  const num = (v: unknown, def: number, lo: number, hi: number): number =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def;
  return {
    windowMs: num(k.event_loop_window_s, DEFAULT_EVENT_LOOP_WINDOW_S, 60, 3600) * 1000,
    stallMaxMs: num(k.event_loop_stall_max_s, DEFAULT_EVENT_LOOP_STALL_MAX_S, 1, 600) * 1000,
    stallP99Ms: num(k.event_loop_stall_p99_s, DEFAULT_EVENT_LOOP_STALL_P99_S, 0.1, 60) * 1000,
    cooldownMs:
      num(k.event_loop_wake_cooldown_min, DEFAULT_EVENT_LOOP_WAKE_COOLDOWN_MIN, 5, 1440) * 60_000,
    starvedRatio: num(
      k.event_loop_starved_throttle_ratio,
      DEFAULT_EVENT_LOOP_STARVED_THROTTLE_RATIO,
      0.01,
      1,
    ),
  };
}

// ---- cgroup v2 cpu.stat ------------------------------------------------------

/** The cpu.stat counters this watch uses. The three bandwidth counters are
 * null when the file does not carry them (no cpu controller bandwidth). */
export interface CpuStat {
  usage_usec: number;
  nr_periods: number | null;
  nr_throttled: number | null;
  throttled_usec: number | null;
}

/** Parse cpu.stat's `key value` lines; null when it is not a cpu.stat at all. */
export function parseCpuStat(text: string): CpuStat | null {
  const map = new Map<string, number>();
  for (const line of text.split("\n")) {
    const m = /^([a-z_]+)\s+(\d+)$/.exec(line.trim());
    if (m) map.set(m[1]!, Number(m[2]));
  }
  const usage = map.get("usage_usec");
  if (usage === undefined) return null;
  return {
    usage_usec: usage,
    nr_periods: map.get("nr_periods") ?? null,
    nr_throttled: map.get("nr_throttled") ?? null,
    throttled_usec: map.get("throttled_usec") ?? null,
  };
}

export type CpuStatRead = { ok: true; stat: CpuStat } | { ok: false; reason: string };

/** Read the container's cpu.stat. Total: an absent or unreadable file is a
 * reason, never a throw. */
export function readCgroupCpuStat(path: string = CGROUP_CPU_STAT): CpuStatRead {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      ok: false,
      reason:
        code === "ENOENT"
          ? `no ${path} (not a cgroup v2 container)`
          : `${path} unreadable (${code ?? String(err)})`,
    };
  }
  const stat = parseCpuStat(text);
  return stat ? { ok: true, stat } : { ok: false, reason: `${path} carries no usage_usec line` };
}

// ---- the drift sampler -------------------------------------------------------

/**
 * How much CPU the daemon PROCESS (all its threads) used across one sample's
 * span — the wall time from the previous tick to this one, i.e. the sampler's
 * interval plus the delay. `cpuMs / spanMs` near 1 means the daemon itself was
 * running the whole time; far below it, something else held the CPU or the
 * loop waited.
 */
export interface LoopBusy {
  cpuMs: number;
  spanMs: number;
}

export type LoopSampleSink = (lagMs: number, at: Date, busy?: LoopBusy) => void;

/** Something that reports the loop's delay, one sample at a time. */
export interface LoopDelaySampler {
  start(onSample: LoopSampleSink): void;
  stop(): void;
}

export interface DriftSamplerOptions {
  intervalMs?: number;
  /** A monotonic clock in ms (default `performance.now`): a wall-clock jump
   * must never read as a stall. */
  monotonic?: () => number;
  now?: () => Date;
  /** The process's CPU time so far in µs, user + system (default
   * `process.cpuUsage()`). A throw or a non-number leaves the sample with no
   * busy figure — never a guessed one. */
  cpuUsageUs?: () => number;
  setTimer?: (cb: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

function processCpuUs(): number {
  const u = process.cpuUsage();
  return u.user + u.system;
}

/**
 * The drift sampler: one timer due every `intervalMs`; how late it fires is
 * the loop's delay at that moment. A 70-second stall is ONE sample of ~70 s,
 * observed the moment the loop is free again, carrying the CPU the daemon used
 * across it. The timer is unref'd.
 */
export function driftSampler(opts: DriftSamplerOptions = {}): LoopDelaySampler {
  const intervalMs = opts.intervalMs ?? SAMPLE_INTERVAL_MS;
  const mono = opts.monotonic ?? (() => performance.now());
  const now = opts.now ?? (() => new Date());
  const cpuOf = opts.cpuUsageUs ?? processCpuUs;
  const readCpu = (): number | null => {
    try {
      const v = cpuOf();
      return typeof v === "number" && Number.isFinite(v) ? v : null;
    } catch {
      return null;
    }
  };
  const setT =
    opts.setTimer ??
    ((cb: () => void, ms: number): unknown => {
      const t = setTimeout(cb, ms);
      t.unref?.();
      return t;
    });
  const clearT =
    opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let handle: unknown = null;
  let running = false;
  let expected = 0;
  let prevMono = 0;
  let prevCpu: number | null = null;
  let sink: LoopSampleSink = () => {};
  const tick = (): void => {
    if (!running) return;
    const t = mono();
    const cpu = readCpu();
    // Timers never fire early; a negative is clock granularity, never a lead.
    const lag = Math.max(0, t - expected);
    const spanMs = t - prevMono;
    const busy =
      cpu !== null && prevCpu !== null && cpu >= prevCpu && spanMs > 0
        ? { cpuMs: (cpu - prevCpu) / 1000, spanMs }
        : undefined;
    prevMono = t;
    prevCpu = cpu;
    try {
      sink(lag, now(), busy);
    } catch {
      // A sink that throws must not kill the sampler.
    }
    expected = t + intervalMs;
    handle = setT(tick, intervalMs);
  };
  return {
    start(onSample) {
      if (running) return;
      running = true;
      sink = onSample;
      prevMono = mono();
      prevCpu = readCpu();
      expected = prevMono + intervalMs;
      handle = setT(tick, intervalMs);
    },
    stop() {
      running = false;
      if (handle !== null) clearT(handle);
      handle = null;
    },
  };
}

// ---- the status block --------------------------------------------------------

export type EventLoopState = "unknown" | "ok" | "stalled";

/** Why a stall happened, as far as the evidence goes: the daemon's own CPU
 * time across the stall says `loop_blocked` (and wins — it is the stall's own
 * evidence), else the cgroup's throttling over the window says `cpu_starved`,
 * and neither is `unknown` — never a cause by elimination. */
export type StallCause = "cpu_starved" | "loop_blocked" | "unknown";

export interface EventLoopStatus {
  /** `unknown` — no sample in the window (just started, or the sampler is
   * not running): NEVER painted ok. */
  state: EventLoopState;
  /** When this state began. */
  since: string;
  /** When the watch started (the longest stall is counted from here). */
  started_at: string;
  /** The evaluation these figures come from; null before the first. */
  evaluated_at: string | null;
  sample_interval_ms: number;
  /** The configured window, and how much of it the samples cover (0 with
   * none) — what "over the last …" means everywhere this block is read. */
  window_s: number;
  covered_s: number;
  samples: number;
  /** Over the window; null with no samples. */
  p50_ms: number | null;
  p99_ms: number | null;
  max_ms: number | null;
  /** When the window's longest delay ENDED (the sample is taken then). */
  max_at: string | null;
  /** The longest single delay since `started_at`. */
  longest_stall: { ms: number; began_at: string; ended_at: string } | null;
  thresholds: {
    stall_max_ms: number;
    stall_p99_ms: number;
    wake_cooldown_min: number;
    starved_throttle_ratio: number;
  };
  /** Present while `stalled`: which threshold, the cause, the daemon's own
   * CPU time across the stall as a share of its wall time (the longest
   * delay's span for `max`, the window for `p99`; null when not measured),
   * and the sentence the wake carries. */
  stall: {
    trigger: "max" | "p99";
    cause: StallCause;
    busy_share: number | null;
    detail: string;
  } | null;
  last_wake_at: string | null;
}

/** The container's CPU throttling over the window — or UNKNOWN with why. */
export type CpuThrottleStatus =
  | {
      state: "measured";
      source: string;
      /** The newest reading. */
      at: string;
      /** Seconds between the two readings the deltas span. */
      window_s: number;
      periods: number;
      throttled_periods: number;
      /** throttled_periods / periods (0 when no period elapsed). */
      throttled_ratio: number;
      throttled_s: number;
      /** CPU seconds the whole container used across the window. */
      usage_s: number;
    }
  | { state: "unknown"; source: string; reason: string; at: string | null };

/** status.json `daemon` (L2). */
export interface DaemonLoadStatus {
  event_loop: EventLoopStatus;
  cpu: CpuThrottleStatus;
}

// ---- the monitor -------------------------------------------------------------

export interface DaemonLoadMonitorDeps {
  policy: EventLoopPolicy;
  /** Raise the stall wake. daemon.ts: `store.logAnomaly(EVENT_LOOP_WAKE_KIND,
   * …)`. A throw is swallowed and logged — the watch never dies of its sink. */
  raise: (detail: string, message: string) => void;
  /** Default: the drift sampler. */
  sampler?: LoopDelaySampler;
  /** Default: `readCgroupCpuStat(cpuStatPath)`. */
  readCpuStat?: () => CpuStatRead;
  /** Reported as the cgroup figures' `source`. */
  cpuStatPath?: string;
  now?: () => Date;
  evaluateEveryMs?: number;
  setTimer?: (cb: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  log?: (msg: string, extra?: unknown) => void;
}

/** The daemon's CPU time over the wall time the samples span — only the
 * samples that measured it; null when none did. */
function busyShareOf(samples: readonly Sample[]): number | null {
  let cpu = 0;
  let span = 0;
  for (const s of samples)
    if (s.cpuMs !== null && s.spanMs !== null) {
      cpu += s.cpuMs;
      span += s.spanMs;
    }
  return span > 0 ? cpu / span : null;
}

/** Nearest-rank percentile of an ascending array. */
function percentile(sorted: number[], p: number): number {
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i]!;
}

const round1 = (x: number): number => Math.round(x * 10) / 10;

/** A duration in ms, read the way a person reads it: `850ms`, `2.3s`, `1m10s`. */
export function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

const pct = (r: number): string => `${Math.round(r * 100)}%`;

/**
 * The cause half of a stall sentence — each cause from its evidence, and an
 * unknown one saying what was and was not seen. `busyShare` is the daemon's
 * own CPU time across the stall as a share of its wall time (null: not
 * measured); `span` names what that span was ("the delay", "the window");
 * `starvedRatio` is the policy's, so a loop-blocked stall in a container
 * throttled past it says the container was ALSO throttled, never "only".
 */
export function causePhrase(
  cause: StallCause,
  cpu: CpuThrottleStatus,
  busyShare: number | null = null,
  span = "the delay",
  starvedRatio = DEFAULT_EVENT_LOOP_STARVED_THROTTLE_RATIO,
): string {
  const over = cpu.state === "measured" ? `over ${fmtMs(cpu.window_s * 1000)}` : "";
  if (cause === "cpu_starved" && cpu.state === "measured")
    return `CPU starved: the container was throttled in ${pct(cpu.throttled_ratio)} of its CFS periods (${cpu.throttled_s.toFixed(1)}s throttled) ${over}`;
  const throttle =
    cpu.state === "measured"
      ? `the container was throttled in only ${pct(cpu.throttled_ratio)} of its CFS periods ${over}`
      : `no CPU throttling figures (${cpu.reason})`;
  if (cause === "loop_blocked" && busyShare !== null) {
    const beside =
      cpu.state !== "measured"
        ? `container throttling unknown: ${cpu.reason}`
        : cpu.throttled_ratio >= starvedRatio
          ? `the container was also throttled in ${pct(cpu.throttled_ratio)} of its CFS periods (${cpu.throttled_s.toFixed(1)}s throttled) ${over} — a throttle lasts only until the next CFS period, so that is not what held the loop`
          : throttle;
    return `the loop itself blocked: the daemon was on CPU for ${pct(busyShare)} of ${span}, so its own synchronous work held the loop (${beside})`;
  }
  const busy =
    busyShare === null
      ? `the daemon's own CPU time across ${span} was not measured`
      : `the daemon was on CPU for only ${pct(busyShare)} of ${span}`;
  const remains =
    cpu.state === "measured" && busyShare !== null
      ? " — neither its quota nor its own work: host contention on the VM, or a blocking wait (synchronous disk I/O)"
      : "";
  return `cause unknown: ${throttle}, and ${busy}${remains}`;
}

interface Sample {
  lag: number;
  at: number;
  /** The daemon's CPU ms across the sample's span, and the span; null when
   * the sampler did not measure them. */
  cpuMs: number | null;
  spanMs: number | null;
}

export class DaemonLoadMonitor {
  private samples: Sample[] = [];
  private cpuReadings: Array<{ at: number; stat: CpuStat }> = [];
  private cpuError: string | null = null;
  private longest: { ms: number; began: number; ended: number } | null = null;
  private startedAt: number;
  private state: EventLoopState = "unknown";
  private since: number;
  private lastWakeAt: number | null = null;
  private evaluatedAt: number | null = null;
  private last: DaemonLoadStatus;
  private timer: unknown = null;
  private running = false;
  private readonly now: () => Date;
  private readonly sampler: LoopDelaySampler;
  private readonly readCpu: () => CpuStatRead;
  private readonly source: string;
  private readonly log: (msg: string, extra?: unknown) => void;
  private readonly setT: (cb: () => void, ms: number) => unknown;
  private readonly clearT: (handle: unknown) => void;

  constructor(private readonly deps: DaemonLoadMonitorDeps) {
    this.now = deps.now ?? (() => new Date());
    this.source = deps.cpuStatPath ?? CGROUP_CPU_STAT;
    this.sampler = deps.sampler ?? driftSampler({ now: this.now });
    this.readCpu = deps.readCpuStat ?? (() => readCgroupCpuStat(this.source));
    this.log = deps.log ?? (() => {});
    this.setT =
      deps.setTimer ??
      ((cb: () => void, ms: number): unknown => {
        const t = setInterval(cb, ms);
        t.unref?.();
        return t;
      });
    this.clearT =
      deps.clearTimer ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>));
    const t = this.now().getTime();
    this.startedAt = t;
    this.since = t;
    this.last = this.compute(t);
  }

  /** Start sampling and the periodic evaluation (idempotent). */
  start(): void {
    if (this.running) return;
    this.running = true;
    const t = this.now().getTime();
    this.startedAt = t;
    this.since = t;
    this.sampler.start((lag, at, busy) => this.record(lag, at, busy));
    // The daemon calls start() first in its own start(): an evaluation that
    // throws must never take the boot down with it.
    this.evaluateSafely();
    this.timer = this.setT(
      () => this.evaluateSafely(),
      this.deps.evaluateEveryMs ?? EVALUATE_INTERVAL_MS,
    );
  }

  private evaluateSafely(): void {
    try {
      this.evaluate();
    } catch (err) {
      this.log("event-loop watch: evaluation failed (it keeps running)", err);
    }
  }

  stop(): void {
    this.running = false;
    this.sampler.stop();
    if (this.timer !== null) this.clearT(this.timer);
    this.timer = null;
  }

  /** One sample from the sampler (public for tests and other samplers). */
  record(lagMs: number, at: Date, busy?: LoopBusy): void {
    if (!Number.isFinite(lagMs) || lagMs < 0) return;
    const ended = at.getTime();
    const measured =
      busy !== undefined &&
      Number.isFinite(busy.cpuMs) &&
      Number.isFinite(busy.spanMs) &&
      busy.cpuMs >= 0 &&
      busy.spanMs > 0;
    this.samples.push({
      lag: lagMs,
      at: ended,
      cpuMs: measured ? busy.cpuMs : null,
      spanMs: measured ? busy.spanMs : null,
    });
    if (!this.longest || lagMs > this.longest.ms)
      this.longest = { ms: lagMs, began: ended - lagMs, ended };
    // Bound memory between evaluations: drop what has left the window.
    const cutoff = ended - this.deps.policy.windowMs;
    while (this.samples.length > 0 && this.samples[0]!.at < cutoff) this.samples.shift();
  }

  /** Read cpu.stat, re-judge the window, wake on a stall past its cooldown. */
  evaluate(): DaemonLoadStatus {
    const nowMs = this.now().getTime();
    const read = this.readCpu();
    if (read.ok) {
      this.cpuError = null;
      this.cpuReadings.push({ at: nowMs, stat: read.stat });
    } else {
      this.cpuError = read.reason;
    }
    this.evaluatedAt = nowMs;
    const next = this.compute(nowMs);
    const was = this.state;
    if (next.event_loop.state !== was) {
      this.state = next.event_loop.state;
      this.since = nowMs;
      if (next.event_loop.state === "stalled")
        this.log(`event-loop watch: STALLED — ${next.event_loop.stall?.detail ?? ""}`);
      else if (was === "stalled") this.log(`event-loop watch: ${next.event_loop.state} again`);
    }
    const stall = next.event_loop.stall;
    if (
      stall &&
      (this.lastWakeAt === null || nowMs - this.lastWakeAt >= this.deps.policy.cooldownMs)
    ) {
      this.lastWakeAt = nowMs;
      try {
        this.deps.raise(stall.detail, this.wakeMessage(next));
      } catch (err) {
        this.log("event-loop watch: raising the stall wake failed", err);
      }
    }
    this.last = this.compute(nowMs);
    return this.last;
  }

  /** The block for status.json — the last evaluation's figures. */
  status(): DaemonLoadStatus {
    return this.last;
  }

  private compute(nowMs: number): DaemonLoadStatus {
    const p = this.deps.policy;
    const windowStart = nowMs - p.windowMs;
    // A sample stamped after now comes from before a BACKWARD wall-clock step:
    // it cannot be placed in this window, and kept it would hold an old stall
    // in the window for as long as the step.
    this.samples = this.samples.filter((s) => s.at >= windowStart && s.at <= nowMs);
    // The same for cpu.stat readings: one from "the future" would make a
    // negative window of deltas.
    this.cpuReadings = this.cpuReadings.filter((r) => r.at <= nowMs);
    // Keep the newest reading at or before the window's start as the baseline,
    // so the deltas span the whole window once there is one that old.
    let base = 0;
    for (let i = 0; i < this.cpuReadings.length; i++)
      if (this.cpuReadings[i]!.at <= windowStart) base = i;
    if (base > 0) this.cpuReadings = this.cpuReadings.slice(base);
    const cpu = this.cpuStatus();

    const lags = this.samples.map((s) => s.lag).sort((a, b) => a - b);
    const n = lags.length;
    let maxSample: Sample | null = null;
    for (const s of this.samples) if (!maxSample || s.lag >= maxSample.lag) maxSample = s;
    const p50 = n > 0 ? percentile(lags, 50) : null;
    const p99 = n > 0 ? percentile(lags, 99) : null;
    const max = maxSample?.lag ?? null;
    // How much of the window the samples COVER: each spans the sampler's
    // interval plus its delay, back to the previous tick. Time since start is
    // not it — after a FORWARD wall-clock step (a resume, an NTP step) the
    // window holds only the samples since, and a "p99 over the last 5m" from
    // two of them would be their max.
    let coverStart = nowMs;
    for (const s of this.samples)
      coverStart = Math.min(coverStart, s.at - (s.spanMs ?? s.lag + SAMPLE_INTERVAL_MS));
    const coveredMs = n > 0 ? Math.max(0, Math.min(p.windowMs, nowMs - coverStart)) : 0;
    const fullWindow = n > 0 && nowMs - coverStart >= p.windowMs - COVERAGE_SLACK_MS;

    let state: EventLoopState = "unknown";
    let stall: EventLoopStatus["stall"] = null;
    if (n > 0 && max !== null && p99 !== null) {
      const trigger =
        max >= p.stallMaxMs ? "max" : fullWindow && p99 >= p.stallP99Ms ? "p99" : null;
      if (trigger) {
        state = "stalled";
        // The daemon's own CPU across the stall: the longest delay's span for
        // a single stall, the whole window's for a sustained one.
        const busyShare =
          trigger === "max" && maxSample ? busyShareOf([maxSample]) : busyShareOf(this.samples);
        // Each cause from its own evidence, never by elimination: a low
        // throttle ratio alone does not mean the daemon blocked itself — the
        // shared VM can starve the container without it reaching its quota.
        // And the STALL'S OWN evidence first: the busy share is measured
        // across this stall, the throttle ratio across the whole window, and
        // a throttle lasts only until the next CFS period (~100 ms) — a
        // daemon on CPU for most of a 30 s delay held the loop itself, however
        // throttled the container was (a post-drain burst: 39%).
        const starved = cpu.state === "measured" && cpu.throttled_ratio >= p.starvedRatio;
        const cause: StallCause =
          busyShare !== null && busyShare >= LOOP_BUSY_SHARE
            ? "loop_blocked"
            : starved
              ? "cpu_starved"
              : "unknown";
        const win = fmtMs(coveredMs);
        const what =
          trigger === "max"
            ? `event loop stalled ${fmtMs(max)} (the longest delay in the last ${win}; p99 ${fmtMs(p99)})`
            : `event loop slow: p99 ${fmtMs(p99)} over the last ${win} (max ${fmtMs(max)})`;
        const span = trigger === "max" ? "the delay" : "the window";
        stall = {
          trigger,
          cause,
          busy_share: busyShare === null ? null : Math.round(busyShare * 1000) / 1000,
          detail: `${what} — ${causePhrase(cause, cpu, busyShare, span, p.starvedRatio)}`,
        };
      } else {
        state = "ok";
      }
    }
    const iso = (t: number): string => new Date(t).toISOString();
    return {
      event_loop: {
        state,
        since: iso(state === this.state ? this.since : nowMs),
        started_at: iso(this.startedAt),
        evaluated_at: this.evaluatedAt === null ? null : iso(this.evaluatedAt),
        sample_interval_ms: SAMPLE_INTERVAL_MS,
        window_s: p.windowMs / 1000,
        covered_s: Math.round(coveredMs / 1000),
        samples: n,
        p50_ms: p50 === null ? null : round1(p50),
        p99_ms: p99 === null ? null : round1(p99),
        max_ms: max === null ? null : round1(max),
        max_at: maxSample ? iso(maxSample.at) : null,
        longest_stall: this.longest
          ? {
              ms: round1(this.longest.ms),
              began_at: iso(this.longest.began),
              ended_at: iso(this.longest.ended),
            }
          : null,
        thresholds: {
          stall_max_ms: p.stallMaxMs,
          stall_p99_ms: p.stallP99Ms,
          wake_cooldown_min: p.cooldownMs / 60_000,
          starved_throttle_ratio: p.starvedRatio,
        },
        stall,
        last_wake_at: this.lastWakeAt === null ? null : iso(this.lastWakeAt),
      },
      cpu,
    };
  }

  private cpuStatus(): CpuThrottleStatus {
    const unknown = (reason: string, at: number | null = null): CpuThrottleStatus => ({
      state: "unknown",
      source: this.source,
      reason,
      at: at === null ? null : new Date(at).toISOString(),
    });
    if (this.cpuError !== null) return unknown(this.cpuError);
    const newest = this.cpuReadings[this.cpuReadings.length - 1];
    if (!newest) return unknown("not read yet");
    const s = newest.stat;
    if (s.nr_periods === null || s.nr_throttled === null || s.throttled_usec === null)
      return unknown("no CPU quota: cpu.stat carries no CFS bandwidth counters", newest.at);
    if (s.nr_periods === 0)
      return unknown("no CPU quota: cpu.stat has counted no CFS period", newest.at);
    const first = this.cpuReadings[0]!;
    if (first === newest) return unknown("one reading so far — a ratio needs two", newest.at);
    const b = first.stat;
    // A baseline taken before the quota existed carries no bandwidth
    // counters: its "delta" would be the whole cumulative count — a wildly
    // inflated ratio that reads as CPU starved. Unknown until a reading with
    // counters becomes the baseline (one window).
    if (b.nr_periods === null || b.nr_throttled === null || b.throttled_usec === null)
      return unknown(
        "the window's baseline reading carried no CFS bandwidth counters (a CPU quota appeared since)",
        newest.at,
      );
    const periods = s.nr_periods - b.nr_periods;
    const throttled = s.nr_throttled - b.nr_throttled;
    const throttledUs = s.throttled_usec - b.throttled_usec;
    const usageUs = s.usage_usec - b.usage_usec;
    if (periods < 0 || throttled < 0 || throttledUs < 0 || usageUs < 0)
      return unknown("the counters went backwards (the cgroup was reset)", newest.at);
    return {
      state: "measured",
      source: this.source,
      at: new Date(newest.at).toISOString(),
      window_s: Math.round((newest.at - first.at) / 1000),
      periods,
      throttled_periods: throttled,
      throttled_ratio: periods > 0 ? Math.round((throttled / periods) * 1000) / 1000 : 0,
      throttled_s: Math.round(throttledUs / 1e5) / 10,
      usage_s: Math.round(usageUs / 1e5) / 10,
    };
  }

  private wakeMessage(s: DaemonLoadStatus): string {
    const e = s.event_loop;
    const longest = e.longest_stall
      ? `Longest single delay since ${e.started_at}: ${fmtMs(e.longest_stall.ms)}, from ${e.longest_stall.began_at} to ${e.longest_stall.ended_at}.`
      : "";
    return [
      "DAEMON EVENT LOOP STALLED",
      e.stall?.detail ?? "",
      longest,
      "While the loop is held nothing in the daemon runs: webhooks and /health go unanswered, status.json is not rewritten, verdicts and deadlines wait.",
      e.stall?.cause === "cpu_starved"
        ? "CPU starved means the container sits at its CPU quota — concurrent rounds and their lens fan-out, the memory server and its embedder, or an operator TUI's evidence sweep. The figures are status.json `daemon` and `qcr status`."
        : e.stall?.cause === "loop_blocked"
          ? "The loop itself blocked means the daemon was on CPU for most of the stall — synchronous work inside it; read the daemon log around the stall. The figures are status.json `daemon` and `qcr status`."
          : "The cause is unknown: neither the container's throttling nor the daemon's own CPU time explains it (or a figure could not be read — the detail says which). Not throttled and not busy leaves host contention on the VM or a blocking wait such as synchronous disk I/O; compare the host's load around the stall. The figures are status.json `daemon` and `qcr status`.",
      "Flag-owner if it recurs. Do not open rounds or touch GitHub for this.",
    ]
      .filter((l) => l !== "")
      .join("\n");
  }
}

// ---- reading the block back --------------------------------------------------
//
// `qcr status` and the TUI board read status.json `daemon` as parsed JSON from
// whichever daemon wrote it — an older one, a newer one with a state this
// build does not know, a hand-edited or truncated file. The type on
// `StatusSnapshot.daemon` is the WRITER's promise, not something a reader may
// trust, so the readers below check every field they render and answer
// UNKNOWN with why for anything they cannot read whole — never a throw (one
// would take all of `qcr status` or a board paint with it) and never ok.

/** What a reader renders of `event_loop` — each field checked. */
export interface EventLoopView {
  state: EventLoopState;
  since: string;
  started_at: string;
  samples: number;
  covered_s: number;
  p50_ms: number | null;
  p99_ms: number | null;
  max_ms: number | null;
  longest_stall: { ms: number; ended_at: string } | null;
  /** `trigger` and `cause` as written: one this build does not know renders
   * as the plain stall / "cause unknown", never as a guess. */
  stall: { trigger: string; cause: string; busy_share: number | null; detail: string } | null;
  last_wake_at: string | null;
}

export interface DaemonLoadView {
  event_loop: EventLoopView;
  cpu: CpuThrottleStatus;
}

/** status.json `daemon` as a reader finds it. `absent`: a daemon that
 * predates the block; `unreadable`: a block whose `event_loop` this build
 * cannot read whole (its `cpu` still read on its own). */
export type DaemonLoadRead =
  | { kind: "absent" }
  | { kind: "unreadable"; why: string; cpu: CpuThrottleStatus }
  | { kind: "read"; view: DaemonLoadView };

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const EVENT_LOOP_STATES: readonly EventLoopState[] = ["unknown", "ok", "stalled"];

/** A value from the block, as a reason names it: short, quoted, escaped. */
function shown(v: unknown): string {
  if (isStr(v)) return JSON.stringify(v.slice(0, 40));
  if (v === null || v === undefined || typeof v === "number" || typeof v === "boolean")
    return String(v);
  return Array.isArray(v) ? "an array" : `a${typeof v === "object" ? "n" : ""} ${typeof v}`;
}

/** The block's `cpu` as a reader may render it: the figures when they are all
 * there, else UNKNOWN with why. */
export function readCpuThrottle(v: unknown): CpuThrottleStatus {
  const source = isObj(v) && isStr(v.source) ? v.source : CGROUP_CPU_STAT;
  const unknown = (reason: string): CpuThrottleStatus => ({
    state: "unknown",
    source,
    reason,
    at: null,
  });
  const unreadable = (why: string): CpuThrottleStatus =>
    unknown(`the cpu figures are unreadable (${why})`);
  if (v === undefined) return unknown("the daemon block carries no cpu figures");
  if (!isObj(v)) return unreadable(`cpu is ${shown(v)}, not an object`);
  if (v.state === "unknown") {
    if (!isStr(v.reason)) return unreadable("an unknown state with no reason");
    return { state: "unknown", source, reason: v.reason, at: isStr(v.at) ? v.at : null };
  }
  if (v.state !== "measured")
    return unreadable(`state ${shown(v.state)} is not one this build knows`);
  if (!isStr(v.at)) return unreadable(`cpu.at is ${shown(v.at)}, not a string`);
  const nums = [
    "window_s",
    "periods",
    "throttled_periods",
    "throttled_ratio",
    "throttled_s",
    "usage_s",
  ] as const;
  for (const k of nums)
    if (!isNum(v[k])) return unreadable(`cpu.${k} is ${shown(v[k])}, not a number`);
  return {
    state: "measured",
    source,
    at: v.at,
    window_s: v.window_s as number,
    periods: v.periods as number,
    throttled_periods: v.throttled_periods as number,
    throttled_ratio: v.throttled_ratio as number,
    throttled_s: v.throttled_s as number,
    usage_s: v.usage_s as number,
  };
}

function readEventLoop(v: unknown): { ok: true; view: EventLoopView } | { ok: false; why: string } {
  const bad = (why: string) => ({ ok: false as const, why });
  if (v === undefined) return bad("the daemon block carries no event_loop");
  if (!isObj(v)) return bad(`event_loop is ${shown(v)}, not an object`);
  if (!EVENT_LOOP_STATES.includes(v.state as EventLoopState))
    return bad(`state ${shown(v.state)} is not one this build knows`);
  for (const k of ["since", "started_at"] as const)
    if (!isStr(v[k])) return bad(`event_loop.${k} is ${shown(v[k])}, not a string`);
  for (const k of ["samples", "covered_s"] as const)
    if (!isNum(v[k])) return bad(`event_loop.${k} is ${shown(v[k])}, not a number`);
  for (const k of ["p50_ms", "p99_ms", "max_ms"] as const)
    if (v[k] !== null && !isNum(v[k]))
      return bad(`event_loop.${k} is ${shown(v[k])}, not a number or null`);
  if (v.last_wake_at !== null && !isStr(v.last_wake_at))
    return bad(`event_loop.last_wake_at is ${shown(v.last_wake_at)}, not a string or null`);
  const l = v.longest_stall;
  if (l !== null && !(isObj(l) && isNum(l.ms) && isStr(l.ended_at)))
    return bad("event_loop.longest_stall is unreadable");
  const s = v.stall;
  if (
    s !== null &&
    !(
      isObj(s) &&
      isStr(s.trigger) &&
      isStr(s.cause) &&
      (s.busy_share === null || isNum(s.busy_share)) &&
      isStr(s.detail)
    )
  )
    return bad("event_loop.stall is unreadable");
  return {
    ok: true,
    view: {
      state: v.state as EventLoopState,
      since: v.since as string,
      started_at: v.started_at as string,
      samples: v.samples as number,
      covered_s: v.covered_s as number,
      p50_ms: v.p50_ms as number | null,
      p99_ms: v.p99_ms as number | null,
      max_ms: v.max_ms as number | null,
      longest_stall: l === null ? null : { ms: l.ms as number, ended_at: l.ended_at as string },
      stall:
        s === null
          ? null
          : {
              trigger: s.trigger as string,
              cause: s.cause as string,
              busy_share: s.busy_share as number | null,
              detail: s.detail as string,
            },
      last_wake_at: v.last_wake_at as string | null,
    },
  };
}

/** status.json `daemon` read back — total over whatever JSON is there. */
export function readDaemonLoad(v: unknown): DaemonLoadRead {
  if (v === undefined) return { kind: "absent" };
  const cpu = readCpuThrottle(isObj(v) ? v.cpu : undefined);
  if (!isObj(v))
    return { kind: "unreadable", why: `the daemon block is ${shown(v)}, not an object`, cpu };
  const e = readEventLoop(v.event_loop);
  return e.ok
    ? { kind: "read", view: { event_loop: e.view, cpu } }
    : { kind: "unreadable", why: e.why, cpu };
}

// ---- what a person reads -----------------------------------------------------

/** The board banner's words for a stall (no colour): what held, and the
 * cause in a few words — `DAEMON LOOP STALLED 1m10s · CPU starved (39%
 * throttled)`. Total over parsed JSON: a block it cannot read says so. */
export function stallShortPhrase(d: unknown): string {
  const r = readDaemonLoad(d);
  if (r.kind === "absent") return "DAEMON LOOP ? · not reported";
  if (r.kind === "unreadable") return "DAEMON LOOP ? · unreadable block";
  const { event_loop: e, cpu } = r.view;
  const what =
    e.stall?.trigger === "p99"
      ? `DAEMON LOOP SLOW p99 ${fmtMs(e.p99_ms ?? 0)}`
      : `DAEMON LOOP STALLED ${fmtMs(e.max_ms ?? 0)}`;
  const throttled = cpu.state === "measured" ? ` (${pct(cpu.throttled_ratio)} throttled)` : "";
  const busy = typeof e.stall?.busy_share === "number" ? `on CPU ${pct(e.stall.busy_share)}` : null;
  const cause =
    e.stall?.cause === "cpu_starved"
      ? `CPU starved${throttled}`
      : e.stall?.cause === "loop_blocked"
        ? `loop itself blocked${busy ? ` (${busy})` : throttled}`
        : `cause unknown${throttled}`;
  return `${what} · ${cause}`;
}

/** The cgroup half of a status line. */
export function cpuThrottlePhrase(c: CpuThrottleStatus): string {
  if (c.state === "unknown") return `container CPU throttling: UNKNOWN — ${c.reason}`;
  return `container CPU: throttled in ${pct(c.throttled_ratio)} of ${c.periods} CFS periods (${c.throttled_s.toFixed(1)}s throttled, ${c.usage_s.toFixed(1)} CPU-s used) over ${fmtMs(c.window_s * 1000)}`;
}

/**
 * The one-line event-loop status a person reads — `qcr status` prints it; the
 * TUI board paints a shorter cut of the same facts. An absent block (an older
 * daemon), an `unknown` state and a block this build cannot read whole (a
 * newer daemon's state, a missing field) each say so; none ever reads ok, and
 * none throws.
 */
export function daemonLoadLine(d: unknown): string {
  const r = readDaemonLoad(d);
  if (r.kind === "absent")
    return "daemon event loop: NOT REPORTED (this daemon predates the event-loop block)";
  if (r.kind === "unreadable")
    return `daemon event loop: UNKNOWN (unreadable block: ${r.why}); ${cpuThrottlePhrase(r.cpu)}`;
  const { event_loop: e, cpu: c } = r.view;
  const cpu = cpuThrottlePhrase(c);
  const longest = e.longest_stall
    ? `; longest since ${e.started_at}: ${fmtMs(e.longest_stall.ms)} (ended ${e.longest_stall.ended_at})`
    : "";
  const figures =
    e.samples > 0 && e.p50_ms !== null && e.p99_ms !== null && e.max_ms !== null
      ? `p50 ${fmtMs(e.p50_ms)} · p99 ${fmtMs(e.p99_ms)} · max ${fmtMs(e.max_ms)} over ${fmtMs(e.covered_s * 1000)} (${e.samples} samples)`
      : "";
  if (e.state === "stalled")
    return `daemon event loop: STALLED since ${e.since} — ${e.stall?.detail ?? figures}${longest}${e.last_wake_at ? `; overseer woken ${e.last_wake_at}` : ""}`;
  if (e.state === "ok") return `daemon event loop: ok — ${figures}${longest}; ${cpu}`;
  return `daemon event loop: UNKNOWN — no sample in the window yet${longest}; ${cpu}`;
}

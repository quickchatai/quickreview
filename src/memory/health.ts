// Reviewer-memory health (S1) — the state machine that makes a memory
// outage reach a PERSON.
//
// From 2026-09-03 to 2026-10-02 every round got `UNAUTHENTICATED: Invalid API
// Key` on both memory reads and nothing was written, and nothing alerted: the
// health probes were unauthenticated (the server WAS up), the per-round
// `round_memory_degraded` anomaly was not a wake kind, and the overseer — the
// only party ever told — wrote it into 33 daily digests nobody reads. This
// module replaces "memory degraded, logged" with a state a person sees:
//
//   unknown  — nothing has been measured yet (boot, or the server still
//              warming inside the boot grace). NEVER painted healthy.
//   healthy  — the authenticated probe answers and the daemon's own requests
//              mostly succeed.
//   degraded — memory answers, but its latest probe or too many recent
//              requests failed. Visible, not woken.
//   down     — no authenticated answer for `downAfterMs` (10 min), counted
//              from boot when there never was one. Wakes `memory_down` — but a
//              drain (a deploy window) defers that wake until it lifts.
//   auth_failed — a credential in use is refused (401/403, "Invalid API
//              Key") or there is no key to send. Wakes `memory_auth_failed`
//              on the first one, on every transition, and every 6 h while it
//              lasts. Never graced, never deferred by a drain.
//
// Two inputs drive it: an AUTHENTICATED probe of each credential in use (the
// daemon's key file and the `ovcli.conf` the sessions are handed — judged
// separately, because they can fail on different days) every `intervalMs`, and
// the outcomes of the daemon's own requests and round seeds. It is engine-
// agnostic: the probes are injected functions (`src/openviking/probe.ts` is the
// one that speaks HTTP), the wake is an injected sink (wire.ts routes it
// through `store.logAnomaly`, whose wake policy reaches the overseer), and what
// a PERSON sees is the `memory` block of status.json — the TUI's board banner,
// its desktop notification and its tracker ticket, `qcr status`, and the
// companion's view all read that block, never OpenViking.
//
// Memory still never blocks or delays a round: nothing here sits on the round
// path. `recordRoundSeed` is told about a seed after the round was built.

export type MemoryHealthState = "unknown" | "healthy" | "degraded" | "down" | "auth_failed";

/** The credentials the probe judges, reported separately. */
export type CredentialName = "daemon" | "sessions";

/** One probe's verdict on one credential:
 *  `ok` — the key lists the memories root (a 404 for a root nothing created
 *  yet counts: the server authenticates before it resolves a path);
 *  `auth_failed` — the key was refused; `no_key` — there is no key to send;
 *  `unreachable` — no answer; `error` — an answer that is neither;
 *  `absent` — no credential file exists yet (no session born) — not a failure. */
export type ProbeResult = "ok" | "auth_failed" | "no_key" | "unreachable" | "error" | "absent";

export interface ProbeAnswer {
  result: ProbeResult;
  /** HTTP status, 0 for no answer / nothing sent. */
  status: number;
  code: string;
  ms: number;
  detail?: string;
}

/** A credential's latest verdict, from a probe or from a real request. */
export interface CredentialStatus extends ProbeAnswer {
  at: string;
  source: "probe" | "request";
}

/** One request outcome — structurally the client's `OvRequestRecord`.
 * `absent` is a NOT_FOUND answer: the server authenticated the key and said
 * the path is not there — an answer, like `ok`, never a failure. */
export interface HealthRequest {
  op: string;
  outcome: "ok" | "absent" | "conflict" | "auth" | "failed";
  status: number;
  code: string;
  ms: number;
  message?: string;
}

export interface RequestCounter {
  total: number;
  ok: number;
  /** NOT_FOUND answers (a session never created, a root nothing wrote yet) —
   * authenticated answers, not failures. */
  absent: number;
  /** 409 precondition refusals — answers, not failures. */
  conflict: number;
  auth_failed: number;
  failed: number;
}

/** A fresh, all-zero counter — the one shape every counter starts from. */
export function emptyRequestCounter(): RequestCounter {
  return { total: 0, ok: 0, absent: 0, conflict: 0, auth_failed: 0, failed: 0 };
}

/** Count one outcome into `c` (the daemon's counters and the TUI's agree). */
export function countOutcome(c: RequestCounter, outcome: HealthRequest["outcome"]): void {
  c.total += 1;
  if (outcome === "ok") c.ok += 1;
  else if (outcome === "absent") c.absent += 1;
  else if (outcome === "conflict") c.conflict += 1;
  else if (outcome === "auth") c.auth_failed += 1;
  else c.failed += 1;
}

/** An open incident: memory unusable (`auth_failed` or `down`) since `since`,
 * continuously. Persisted, so a daemon restart continues the same incident —
 * the TUI files ONE tracker ticket per incident start. */
export interface MemoryIncident {
  kind: "auth_failed" | "down";
  since: string;
}

/** What `scripts/openviking-provision.mjs` reported at this boot. */
export interface ProvisionSummary {
  /** `absent` — no report (dev daemon, script not synced); `unreadable` — a
   * file that is not a report; `ok`/`failed` — the report's own verdict. */
  state: "absent" | "unreadable" | "ok" | "failed";
  /** A fingerprint of the report file (its bytes, or what stat says when it
   * cannot be read) — the once-per-report key. Absent only for `absent`. */
  id?: string;
  at?: string;
  created?: string[];
  failed?: string[];
  /** The reviewer key's classification (`reach`, `refused`, …). */
  reviewer?: string;
  errors?: string[];
}

/** The `memory` block of status.json. */
export interface MemoryStatus {
  /** false ⇒ nothing is monitored — only when memory is switched OFF
   * (`[openviking] enabled = false`) — and `state` stays `unknown`. Memory
   * configured ON whose server cannot run (a missing binary) is monitored,
   * and reads `down`: that is an outage, not a choice. */
  enabled: boolean;
  state: MemoryHealthState;
  /** When `state` was entered. */
  since: string;
  /** The last authenticated success with the daemon's key (probe or request). */
  last_ok_at: string | null;
  last_error: { at: string; op: string; status: number; code: string; message: string } | null;
  last_probe_at: string | null;
  probe_ms: number | null;
  credentials: Record<CredentialName, CredentialStatus | null>;
  /** The daemon's own requests, per operation (`probe` and `round_seed`
   * included), since boot. */
  requests: Record<string, RequestCounter>;
  /** Client gaps per `op:code`, since boot — the counted `openviking_gap`. */
  gaps: Record<string, number>;
  incident: MemoryIncident | null;
  /** null until wire.ts has read this boot's provisioning report. Its `id`
   * (a fingerprint of the file) is what makes the provision wake fire once
   * per report, even for a report that cannot be parsed. */
  provision: ProvisionSummary | null;
  /** Why `enabled` is false. */
  disabled_reason?: string;
  /** What memory still owes the [feedback] ledger (S2) — read from
   * state.db by the heartbeat; null when that read failed (UNKNOWN, never
   * "nothing owed"); absent on a daemon that predates it. */
  feedback_writes?: FeedbackWritesStatus | null;
}

/** The [feedback] ledger's memory backlog, as the status block carries it. */
export interface FeedbackWritesStatus {
  /** Signals not yet in memory; the backfill pump writes them while healthy. */
  pending: number;
  /** Signals the pump gave up on (memory kept refusing them). */
  failed: number;
  /** Since when the longest-owed signal has been owed; null when none is. */
  oldest_pending_at: string | null;
}

/** `; 3 [feedback] signals owed to memory (oldest 5h12m), 1 given up` — or
 * "" when nothing is owed (and from a daemon that does not report it). A
 * ledger the daemon could not read is said to be UNKNOWN: a dropped clause
 * would read as "nothing owed". */
export function feedbackWritesPhrase(
  w: FeedbackWritesStatus | null | undefined,
  now: Date,
): string {
  if (w === null) return "; [feedback] memory backlog UNKNOWN (the daemon could not read its ledger)";
  if (!w || (w.pending === 0 && w.failed === 0)) return "";
  const parts: string[] = [];
  if (w.pending > 0) {
    const age =
      w.oldest_pending_at !== null
        ? ` (oldest ${fmtDuration(now.getTime() - Date.parse(w.oldest_pending_at))})`
        : "";
    parts.push(`${w.pending} [feedback] signal${w.pending === 1 ? "" : "s"} owed to memory${age}`);
  }
  if (w.failed > 0) parts.push(`${w.failed} given up`);
  return `; ${parts.join(", ")}`;
}

/** The three memory kinds `src/anomalies.ts` lists as WAKE (S1). */
export const MEMORY_WAKE = Object.freeze({
  auth: "memory_auth_failed",
  down: "memory_down",
  provision: "memory_provision_failed",
} as const);

export const MEMORY_HEALTH_DEFAULTS = Object.freeze({
  intervalMs: 120_000,
  downAfterMs: 600_000,
  bootGraceMs: 300_000,
  rewakeMs: 6 * 3_600_000,
  /** The sliding window the "too many recent request failures" rule reads. */
  degradedWindowMs: 600_000,
  /** …and how many failures (at least half the window) it takes. */
  degradedMinFailures: 3,
});

export interface MemoryHealthDeps {
  /** The authenticated probe of each credential in use. Must not throw (a
   * throw is recorded as `unreachable`). */
  probes: Record<CredentialName, () => Promise<ProbeAnswer>>;
  /** Raise a WAKE-class anomaly. wire.ts: `store.logAnomaly(kind, null, null,
   * detail, message)`. Must not throw (a throw is logged and swallowed). */
  wake: (kind: string, detail: string, message: string) => void;
  /** The deploy-window drain. Defers `memory_down` — never an auth wake. */
  draining?: () => boolean;
  now?: () => Date;
  /** Self-rescheduling timer seam; returns its canceller. */
  schedule?: (fn: () => void, ms: number) => () => void;
  /** Where the open incident survives a restart (wire.ts: state.db events). */
  incidents?: {
    load(): MemoryIncident | null;
    save(incident: MemoryIncident | null): void;
  };
  /** Run before every probe tick — the daemon re-reads its key there, which
   * is what notices a rotated key and rewrites the sessions' ovcli.conf. */
  beforeProbe?: () => void;
  /** Where each credential lives, for the wake text. Never a key. */
  where?: Partial<Record<CredentialName, string>>;
  log?: (msg: string, extra?: unknown) => void;
  intervalMs?: number;
  downAfterMs?: number;
  bootGraceMs?: number;
  rewakeMs?: number;
  degradedWindowMs?: number;
}

const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return () => clearTimeout(t);
};

const CREDENTIALS: readonly CredentialName[] = ["daemon", "sessions"];

function isAuthResult(c: CredentialStatus | null): boolean {
  return c !== null && (c.result === "auth_failed" || c.result === "no_key");
}

/** `1h05m` / `12m` / `40s`. */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

/** One credential as a short phrase: `auth_failed (401 UNAUTHENTICATED: Invalid API Key)`. */
export function credentialPhrase(c: CredentialStatus | null): string {
  if (!c) return "not probed yet";
  if (c.result === "ok") return "ok";
  if (c.result === "absent") return "no credential file yet";
  const bits = [c.status ? String(c.status) : "", c.code].filter((b) => b !== "").join(" ");
  const why = c.detail ? `: ${c.detail.slice(0, 120)}` : "";
  return `${c.result}${bits || why ? ` (${bits}${why})` : ""}`;
}

/**
 * The one-line memory status a person reads — `qcr status` prints it and the
 * TUI board banner paints a shorter cut of the same facts. An absent block
 * (an older daemon) and an `unknown` state say so; neither ever reads healthy.
 */
export function memoryStatusLine(m: MemoryStatus | undefined, now: Date = new Date()): string {
  if (!m) return "memory: NOT REPORTED (this daemon predates the memory health block)";
  if (!m.enabled) return `memory: not monitored${m.disabled_reason ? ` — ${m.disabled_reason}` : ""}`;
  const age = fmtDuration(now.getTime() - Date.parse(m.since));
  const creds = `daemon key ${credentialPhrase(m.credentials.daemon)}; sessions' ovcli.conf ${credentialPhrase(m.credentials.sessions)}${feedbackWritesPhrase(m.feedback_writes, now)}`;
  switch (m.state) {
    case "unknown":
      return `memory: UNKNOWN — not measured yet (${age}); ${creds}`;
    case "healthy":
      return `memory: healthy (last ok ${m.last_ok_at ?? "?"}); ${creds}`;
    case "degraded":
      return `memory: DEGRADED for ${age}${m.last_error ? ` — last error ${m.last_error.op}: ${m.last_error.code} ${m.last_error.message.slice(0, 120)}` : ""}; ${creds}`;
    case "down":
      return `memory: DOWN for ${age} — no authenticated answer since ${m.last_ok_at ?? "boot"}${m.incident ? ` (incident since ${m.incident.since})` : ""}; ${creds}`;
    case "auth_failed":
      return `memory: AUTH FAILED for ${age}${m.incident ? ` (incident since ${m.incident.since})` : ""}; ${creds}`;
  }
}

/** The status block before the monitor exists (the daemon is still
 * assembling): monitored-to-be, measured-not-yet — `unknown`, never healthy
 * and never "off". */
export function pendingMemoryStatus(now: Date = new Date()): MemoryStatus {
  const { disabled_reason: _omit, ...rest } = disabledMemoryStatus("", now);
  return { ...rest, enabled: true };
}

/** The status block of a daemon that monitors nothing. */
export function disabledMemoryStatus(reason: string, now: Date = new Date()): MemoryStatus {
  return {
    enabled: false,
    state: "unknown",
    since: now.toISOString(),
    last_ok_at: null,
    last_error: null,
    last_probe_at: null,
    probe_ms: null,
    credentials: { daemon: null, sessions: null },
    requests: {},
    gaps: {},
    incident: null,
    provision: null,
    disabled_reason: reason,
  };
}

export class MemoryHealthMonitor {
  private readonly now: () => Date;
  private readonly schedule: (fn: () => void, ms: number) => () => void;
  private readonly log: (msg: string, extra?: unknown) => void;
  private readonly intervalMs: number;
  private readonly downAfterMs: number;
  private readonly bootGraceMs: number;
  private readonly rewakeMs: number;
  private readonly windowMs: number;
  private readonly bootAt: number;

  private state: MemoryHealthState = "unknown";
  private stateSince: number;
  private readonly creds: Record<CredentialName, CredentialStatus | null> = {
    daemon: null,
    sessions: null,
  };
  private probedOnce = false;
  private lastOkAt: number | null = null;
  private lastProbeAt: number | null = null;
  private lastProbeMs: number | null = null;
  private lastError: MemoryStatus["last_error"] = null;
  private readonly requests: Record<string, RequestCounter> = {};
  private readonly gaps: Record<string, number> = {};
  private window: Array<{ at: number; failed: boolean }> = [];
  private incident: MemoryIncident | null = null;
  /** Loaded from persistence and not yet confirmed or closed by a measurement. */
  private storedIncident: MemoryIncident | null;
  private lastAuthWakeAt: number | null = null;
  private lastAuthSignature = "";
  private lastDownWakeAt: number | null = null;
  private downDeferredLogged = false;
  private provision: ProvisionSummary | null = null;
  private probing: Promise<void> | null = null;
  private cancel: (() => void) | null = null;
  private stopped = false;

  constructor(private readonly deps: MemoryHealthDeps) {
    this.now = deps.now ?? (() => new Date());
    this.schedule = deps.schedule ?? defaultSchedule;
    this.log = deps.log ?? (() => {});
    this.intervalMs = deps.intervalMs ?? MEMORY_HEALTH_DEFAULTS.intervalMs;
    this.downAfterMs = deps.downAfterMs ?? MEMORY_HEALTH_DEFAULTS.downAfterMs;
    this.bootGraceMs = deps.bootGraceMs ?? MEMORY_HEALTH_DEFAULTS.bootGraceMs;
    this.rewakeMs = deps.rewakeMs ?? MEMORY_HEALTH_DEFAULTS.rewakeMs;
    this.windowMs = deps.degradedWindowMs ?? MEMORY_HEALTH_DEFAULTS.degradedWindowMs;
    this.bootAt = this.now().getTime();
    this.stateSince = this.bootAt;
    let stored: MemoryIncident | null = null;
    try {
      stored = deps.incidents?.load() ?? null;
    } catch (err) {
      this.log("memory health: could not read the persisted incident", err);
    }
    this.storedIncident = stored;
  }

  /** Probe now, then every `intervalMs`. Non-blocking: the boot never waits. */
  start(): void {
    if (this.stopped || this.cancel) return;
    const tick = (): void => {
      if (this.stopped) return;
      void this.probeNow().finally(() => {
        if (!this.stopped) this.cancel = this.schedule(tick, this.intervalMs);
      });
    };
    this.cancel = this.schedule(tick, 0);
  }

  stop(): void {
    this.stopped = true;
    this.cancel?.();
    this.cancel = null;
  }

  /** One probe of every credential, then a re-evaluation. Coalesced: a second
   * call while one is in flight joins it. Never rejects. */
  probeNow(): Promise<void> {
    if (this.probing) return this.probing;
    this.probing = this.runProbe().finally(() => {
      this.probing = null;
    });
    return this.probing;
  }

  private async runProbe(): Promise<void> {
    try {
      this.deps.beforeProbe?.();
    } catch (err) {
      this.log("memory health: beforeProbe threw (probing anyway)", err);
    }
    const started = this.now().getTime();
    const answers = await Promise.all(
      CREDENTIALS.map(async (name): Promise<[CredentialName, ProbeAnswer]> => {
        try {
          return [name, await this.deps.probes[name]()];
        } catch (err) {
          return [
            name,
            {
              result: "unreachable",
              status: 0,
              code: "transport",
              ms: 0,
              detail: err instanceof Error ? err.message : String(err),
            },
          ];
        }
      }),
    );
    const t = this.now().getTime();
    this.probedOnce = true;
    this.lastProbeAt = t;
    this.lastProbeMs = t - started;
    for (const [name, answer] of answers) {
      this.creds[name] = { ...answer, at: new Date(t).toISOString(), source: "probe" };
      if (answer.result !== "absent") {
        this.count("probe", answer.result === "ok" ? "ok" : isAuthResult(this.creds[name]) ? "auth" : "failed");
      }
      if (name === "daemon" && answer.result === "ok") this.lastOkAt = t;
      if (answer.result !== "ok" && answer.result !== "absent") {
        this.noteError(t, `probe:${name}`, answer.status, answer.code, answer.detail ?? answer.result);
      }
    }
    this.evaluate();
  }

  /** One of the daemon's own requests (the client's `onRequest`). */
  recordRequest(r: HealthRequest): void {
    const t = this.now().getTime();
    this.count(r.op, r.outcome);
    // A NOT_FOUND is an authenticated ANSWER (the server checks the key before
    // it resolves a path — the probe reads it the same way): it proves the key
    // and the server exactly as a success does, and is never a failure.
    if (r.outcome === "ok" || r.outcome === "absent") {
      this.lastOkAt = t;
      // A key the server just accepted IS a working daemon credential —
      // whatever the last probe said.
      if (this.creds.daemon?.result !== "ok") {
        this.creds.daemon = {
          result: "ok",
          status: r.status,
          code: r.code,
          ms: r.ms,
          at: new Date(t).toISOString(),
          source: "request",
        };
      }
    } else if (r.outcome === "auth") {
      // The first 401 wakes — from a round read just as from a probe.
      this.creds.daemon = {
        result: r.code === "no_key" ? "no_key" : "auth_failed",
        status: r.status,
        code: r.code,
        ms: r.ms,
        at: new Date(t).toISOString(),
        source: "request",
        ...(r.message ? { detail: r.message } : {}),
      };
      this.noteError(t, r.op, r.status, r.code, r.message ?? "");
    } else if (r.outcome === "failed") {
      this.noteError(t, r.op, r.status, r.code, r.message ?? "");
    }
    if (r.outcome !== "conflict") this.pushWindow(t, r.outcome === "auth" || r.outcome === "failed");
    this.evaluate();
  }

  /** One round's memory seed, after the round was built (dispatch's
   * `round_memory_seeded`). A seed that timed out never reached the client's
   * observer — this is the only place that sees it. */
  recordRoundSeed(seed: { degraded: boolean; ms: number; reasons?: string[] }): void {
    const t = this.now().getTime();
    this.count("round_seed", seed.degraded ? "failed" : "ok");
    if (seed.degraded) {
      this.noteError(t, "round_seed", 0, "degraded", (seed.reasons ?? []).join("; ").slice(0, 300));
    }
    this.pushWindow(t, seed.degraded);
    this.evaluate();
  }

  /** One client gap — counted per `op:code`. */
  recordGap(gap: { op: string; code: string }): number {
    const key = `${gap.op}:${gap.code}`;
    const n = (this.gaps[key] ?? 0) + 1;
    this.gaps[key] = n;
    return n;
  }

  /** This boot's provisioning report, as wire.ts read it. */
  setProvision(summary: ProvisionSummary): void {
    this.provision = summary;
  }

  currentState(): MemoryHealthState {
    return this.state;
  }

  status(): MemoryStatus {
    const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());
    return {
      enabled: true,
      state: this.state,
      since: new Date(this.stateSince).toISOString(),
      last_ok_at: iso(this.lastOkAt),
      last_error: this.lastError ? { ...this.lastError } : null,
      last_probe_at: iso(this.lastProbeAt),
      probe_ms: this.lastProbeMs,
      credentials: {
        daemon: this.creds.daemon ? { ...this.creds.daemon } : null,
        sessions: this.creds.sessions ? { ...this.creds.sessions } : null,
      },
      requests: Object.fromEntries(
        Object.entries(this.requests).map(([op, c]) => [op, { ...c }]),
      ),
      gaps: { ...this.gaps },
      incident: this.incident ?? this.storedIncident,
      provision: this.provision,
    };
  }

  /** Re-derive the state from what has been measured, and act on the change.
   * Called after every input; public so a caller can re-check on a clock. */
  evaluate(): void {
    const t = this.now().getTime();
    const authBad = CREDENTIALS.filter((n) => isAuthResult(this.creds[n]));
    const next = this.derive(t, authBad);
    const prev = this.state;
    if (next !== prev) {
      this.state = next;
      this.stateSince = t;
      this.log(`memory health: ${prev} → ${next}`);
    }
    this.trackIncident(t);
    this.authWakes(t, prev, authBad);
    this.downWakes(t);
  }

  private derive(t: number, authBad: CredentialName[]): MemoryHealthState {
    if (authBad.length > 0) return "auth_failed";
    if (this.lastOkAt === null) {
      // Never an authenticated answer since boot.
      if (!this.probedOnce) return "unknown";
      if (t - this.bootAt >= this.downAfterMs) return "down";
      // A server still warming up inside the boot grace is not news.
      if (t - this.bootAt < this.bootGraceMs) return "unknown";
      return "degraded";
    }
    if (t - this.lastOkAt >= this.downAfterMs) return "down";
    const d = this.creds.daemon;
    if (d && d.result !== "ok" && d.result !== "absent") return "degraded";
    if (this.windowDegraded(t)) return "degraded";
    return "healthy";
  }

  private windowDegraded(t: number): boolean {
    this.window = this.window.filter((w) => t - w.at < this.windowMs);
    const failed = this.window.filter((w) => w.failed).length;
    return failed >= MEMORY_HEALTH_DEFAULTS.degradedMinFailures && failed * 2 >= this.window.length;
  }

  private pushWindow(t: number, failed: boolean): void {
    this.window.push({ at: t, failed });
    if (this.window.length > 500) this.window = this.window.slice(-500);
  }

  private count(op: string, outcome: HealthRequest["outcome"]): void {
    countOutcome((this.requests[op] ??= emptyRequestCounter()), outcome);
  }

  private noteError(t: number, op: string, status: number, code: string, message: string): void {
    this.lastError = { at: new Date(t).toISOString(), op, status, code, message: message.slice(0, 300) };
  }

  private trackIncident(t: number): void {
    const s = this.state;
    if (s === "auth_failed" || s === "down") {
      if (!this.incident) {
        // A restart inside an incident continues it — same start, so the TUI
        // files no second ticket for the same outage.
        this.incident = {
          kind: s,
          since: this.storedIncident?.since ?? new Date(t).toISOString(),
        };
        this.storedIncident = null;
        this.save(this.incident);
      } else if (this.incident.kind !== s) {
        this.incident = { ...this.incident, kind: s };
        this.save(this.incident);
      }
      return;
    }
    const open = this.incident ?? this.storedIncident;
    if (open && (s === "healthy" || (s === "degraded" && this.answeredSince(open)))) {
      this.incident = null;
      this.storedIncident = null;
      this.save(null);
    }
    // Only a MEASURED recovery closes an incident. `healthy` is one by
    // construction (it needs a fresh authenticated answer); `degraded` is one
    // only with an authenticated answer since the incident began. A daemon
    // that restarts inside an outage passes through `degraded` with NO answer
    // when its boot grace ends — closing there gave the same outage a new start
    // at 10 min, a fresh wake, and the TUI a second ticket (and a daemon
    // restarted more often than the ticket age would never get one at all).
    // `unknown` decides nothing either: a boot inside an incident keeps it on
    // file.
  }

  /** Has memory given an authenticated answer since `open` began? */
  private answeredSince(open: MemoryIncident): boolean {
    if (this.lastOkAt === null) return false;
    const since = Date.parse(open.since);
    return Number.isNaN(since) || this.lastOkAt > since;
  }

  private save(incident: MemoryIncident | null): void {
    try {
      this.deps.incidents?.save(incident);
    } catch (err) {
      this.log("memory health: could not persist the incident", err);
    }
  }

  private authWakes(t: number, prev: MemoryHealthState, authBad: CredentialName[]): void {
    if (this.state !== "auth_failed") {
      this.lastAuthSignature = "";
      this.lastAuthWakeAt = null;
      return;
    }
    const signature = authBad.map((n) => `${n}:${this.creds[n]!.result}`).join(",");
    const entered = prev !== "auth_failed";
    const changed = signature !== this.lastAuthSignature;
    const due = this.lastAuthWakeAt === null || t - this.lastAuthWakeAt >= this.rewakeMs;
    if (!entered && !changed && !due) return;
    this.lastAuthSignature = signature;
    this.lastAuthWakeAt = t;
    const lines = CREDENTIALS.map(
      (n) => `  ${n === "daemon" ? "daemon key" : "sessions' ovcli.conf"}${this.deps.where?.[n] ? ` (${this.deps.where[n]})` : ""}: ${credentialPhrase(this.creds[n])}`,
    );
    const detail = `reviewer memory refuses a credential in use — ${authBad.map((n) => `${n} ${credentialPhrase(this.creds[n])}`).join("; ")}`;
    this.fire(MEMORY_WAKE.auth, detail, [
      "MEMORY AUTH FAILED — reviewer memory is refusing a credential the review system uses.",
      ...lines,
      `Since ${this.incident?.since ?? new Date(this.stateSince).toISOString()}. Rounds are NOT blocked — they run memory-less — but nothing the reviewer learns is written, and no round recalls anything, until this is fixed.`,
      "Fix the credential, not the symptom: the key in the secrets mount must be the reviewer USER key the server holds (docs/companion-memory-access.md). Never mint or rotate a key from a session.",
      "A person sees this on the TUI board and in `qcr status` (status.json `memory`), and the TUI files a tracker ticket once it is 2 h old. Re-raised every 6 h while it lasts.",
    ].join("\n"));
  }

  private downWakes(t: number): void {
    if (this.state !== "down") {
      this.lastDownWakeAt = null;
      this.downDeferredLogged = false;
      return;
    }
    const due = this.lastDownWakeAt === null || t - this.lastDownWakeAt >= this.rewakeMs;
    if (!due) return;
    let draining = false;
    try {
      draining = this.deps.draining?.() === true;
    } catch {
      draining = false;
    }
    if (draining) {
      // A deploy window restarts the engine on purpose: hold the wake (still
      // due) and raise it on the first evaluation after the drain lifts.
      if (!this.downDeferredLogged) {
        this.downDeferredLogged = true;
        this.log("memory health: memory is down during a drain — wake deferred until it lifts");
      }
      return;
    }
    this.lastDownWakeAt = t;
    this.downDeferredLogged = false;
    const silentFor = fmtDuration(t - (this.lastOkAt ?? this.bootAt));
    const err = this.lastError;
    this.fire(
      MEMORY_WAKE.down,
      `no authenticated answer from reviewer memory for ${silentFor}${err ? ` — last error ${err.op}: ${err.code} ${err.message.slice(0, 160)}` : ""}`,
      [
        `MEMORY DOWN — no authenticated answer from reviewer memory for ${silentFor} (${this.lastOkAt === null ? "none since the daemon booted" : `last at ${new Date(this.lastOkAt).toISOString()}`}).`,
        ...(err ? [`Last error: ${err.op} — ${err.status || "no answer"} ${err.code} ${err.message.slice(0, 200)}`] : []),
        "Rounds are NOT blocked — they run memory-less — but nothing is recalled or written until it answers again.",
        "Check the `openviking` block of state/status.json (running, ready, restarts, last_error) and the daemon log. A person sees this on the TUI board and in `qcr status`; the TUI files a tracker ticket once it is 2 h old. Re-raised every 6 h while it lasts.",
      ].join("\n"),
    );
  }

  private fire(kind: string, detail: string, message: string): void {
    try {
      this.deps.wake(kind, detail, message);
    } catch (err) {
      this.log(`memory health: ${kind} wake failed`, err);
    }
  }
}

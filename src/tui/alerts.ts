// Alert pipeline — the companion's only push channel.
//
// The companion writes `<alerts_dir>/<iso-ts>-<slug>.json` to the schema fixed
// in prompts/companion.md § Alerts; this module is the consumer. Verdict-file
// discipline applies (src/verdicts.ts): strict shape check, digit-string
// coercion for `pr`, and a malformed file is SURFACED (a status-line notice
// naming the file) — never silently dropped.
//
// Policy:
//   tier `notice` → TUI status line only;
//   tier `alert`  → status line + KDE notify-send (no overseer inject: the
//                   overseer is retired, rule 8);
//   one notification per distinct cause per `cooldown_min`, repeats inside the
//   window fold into a counter on the status line, and a genuine escalation
//   (notice → alert) of a folded cause may break the cooldown exactly once a
//   day. Spend is never an alert — that exclusion lives in the prompt.
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { AUTH_FLAG_FRESH_MS } from "@quickchatai/pi-quickreview/src/authwatch.js";
import { zoneDateString } from "../eod.js";
import { curationNeedsAttention } from "../learner/status.js";
import { memoryStatusLine, type MemoryStatus } from "../memory/health.js";
import type { StatusSnapshot } from "../state.js";
import { DEFAULT_BREAKER_LIMITS } from "../workerbreaker.js";

export type AlertTier = "notice" | "alert";

export interface AlertRecord {
  tier: AlertTier;
  cause: string;
  pr: number | null;
  title: string;
  body: string;
  ts: string;
  /** Source file name — what a malformed-file notice names, and what the
   * status line can be traced back to. */
  file: string;
}

export type AlertParse = { ok: true; alert: AlertRecord } | { ok: false; error: string };

export const MAX_TITLE = 60;

/** Strict schema parse of one alert file body. */
export function parseAlert(
  text: string,
  file: string,
  now: () => Date = () => new Date(),
): AlertParse {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `not JSON (${String(err instanceof Error ? err.message : err)})` };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return { ok: false, error: "not an object" };
  const v = raw as Record<string, unknown>;
  // LLM-written files: unambiguous digit-strings coerce, exactly as verdicts do.
  if (typeof v.pr === "string" && /^\d+$/.test(v.pr)) v.pr = Number(v.pr);
  if (v.tier !== "notice" && v.tier !== "alert")
    return { ok: false, error: `bad tier: ${JSON.stringify(v.tier)}` };
  if (typeof v.cause !== "string" || v.cause.trim() === "")
    return { ok: false, error: "cause must be a non-empty string" };
  if (typeof v.title !== "string" || v.title.trim() === "")
    return { ok: false, error: "title must be a non-empty string" };
  if (v.pr !== null && v.pr !== undefined && (typeof v.pr !== "number" || !Number.isInteger(v.pr)))
    return { ok: false, error: "pr must be an integer or null" };
  if (v.body !== undefined && typeof v.body !== "string")
    return { ok: false, error: "body must be a string" };
  if (v.ts !== undefined && typeof v.ts !== "string")
    return { ok: false, error: "ts must be a string" };
  return {
    ok: true,
    alert: {
      tier: v.tier,
      cause: v.cause.trim(),
      pr: typeof v.pr === "number" ? v.pr : null,
      // Over-long titles are trimmed for the status line rather than rejected:
      // the content is right, only the budget is off.
      title: v.title.trim().slice(0, MAX_TITLE),
      body: typeof v.body === "string" ? v.body : "",
      ts: typeof v.ts === "string" && v.ts.trim() !== "" ? v.ts : now().toISOString(),
      file,
    },
  };
}

export type AlertDecision =
  | { action: "route"; bypass: boolean }
  /** Inside the cooldown: no notification, just a bigger counter. */
  | { action: "fold"; count: number };

export interface CauseMemory {
  day: string;
  lastAt: number;
  lastTier: AlertTier;
  folds: number;
  /** The one escalation bypass this cause gets today. */
  bypassed: boolean;
  /** Times this cause was ROUTED (not folded) today — the badge's count.
   * Optional: a state file written before it existed still loads. */
  routed?: number;
}

/** The whole "already told you" memory, as it survives a TUI restart. */
export interface PolicyState {
  /** Ops day the state belongs to; a different day loads as empty. */
  day: string;
  causes: Record<string, CauseMemory>;
}

/** Where the memory lives between TUI runs. Injectable — tests use a temp
 * file or none at all. */
export interface PolicyStore {
  load(): PolicyState | undefined;
  save(state: PolicyState): void;
}

export function readPolicyState(path: string): PolicyState | undefined {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<PolicyState>;
    if (typeof raw.day !== "string" || typeof raw.causes !== "object" || raw.causes === null)
      return undefined;
    return { day: raw.day, causes: raw.causes };
  } catch {
    return undefined;
  }
}

/** Atomic (tmp+rename) file store — the same discipline as every other state
 * file the TUI writes. A failed write is never fatal: the worst case is that
 * one restart re-notifies a cause it had already folded. */
export function filePolicyStore(path: string): PolicyStore {
  return {
    load: () => readPolicyState(path),
    save: (state) => {
      try {
        mkdirSync(dirname(path), { recursive: true });
        const tmp = `${path}.tmp`;
        writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
        renameSync(tmp, path);
      } catch {
        /* the cooldown is a courtesy, not a correctness property */
      }
    },
  };
}

/**
 * Per-cause cooldown + daily fold memory, persisted across TUI restarts.
 *
 * The day boundary is the **operations timezone** (`cfg.ops.timezone`):
 * "already told you today" has to flip when the
 * operator's day flips, and the daily escalation bypass has to reset with it
 * — an hour or two of drift either side of midnight is exactly when a
 * night's worth of folded causes should start speaking again. The TUI passes
 * the zone from config; the bare-UTC default exists only for callers with no
 * config in hand.
 */
export class AlertPolicy {
  private memory = new Map<string, CauseMemory>();

  constructor(
    private readonly cooldownMin: number,
    private readonly now: () => Date = () => new Date(),
    private readonly store?: PolicyStore,
    private readonly timeZone: string = "UTC",
  ) {
    const loaded = store?.load();
    // A state file from an earlier day is discarded wholesale, which IS the
    // day reset: nothing from yesterday can suppress a notification today.
    if (loaded && loaded.day === this.dayKey(this.now())) {
      this.memory = new Map(Object.entries(loaded.causes));
    }
  }

  private dayKey(d: Date): string {
    return zoneDateString(d, this.timeZone);
  }

  /** Drop every cause not belonging to `today` — called on each decision, so a
   * TUI left running across midnight resets without a restart. */
  private reapStaleDays(today: string): void {
    for (const [cause, mem] of this.memory) if (mem.day !== today) this.memory.delete(cause);
  }

  private persist(today: string): void {
    this.store?.save({ day: today, causes: Object.fromEntries(this.memory) });
  }

  /** The operations day it is now — the day every count here belongs to. */
  today(): string {
    return this.dayKey(this.now());
  }

  /** Folded repeats for a cause today (0 when it is fresh, or last folded on
   * an earlier day). */
  folds(cause: string): number {
    const m = this.memory.get(cause);
    return m && m.day === this.today() ? m.folds : 0;
  }

  /** Total folded repeats across all causes today — the status-line counter. */
  totalFolds(): number {
    const today = this.dayKey(this.now());
    let total = 0;
    for (const m of this.memory.values()) if (m.day === today) total += m.folds;
    return total;
  }

  /** Alerts routed (not folded) across all causes today — the badge count. A
   * cause loaded from a state file that predates `routed` routed once. */
  totalRouted(): number {
    const today = this.dayKey(this.now());
    let total = 0;
    for (const m of this.memory.values()) if (m.day === today) total += m.routed ?? 1;
    return total;
  }

  decide(alert: AlertRecord): AlertDecision {
    const now = this.now();
    const today = this.dayKey(now);
    const prev = this.memory.get(alert.cause);
    this.reapStaleDays(today);
    if (!prev || prev.day !== today) {
      // "Already told you" memory is per day: a new day starts clean.
      this.memory.set(alert.cause, {
        day: today,
        lastAt: now.getTime(),
        lastTier: alert.tier,
        folds: 0,
        bypassed: false,
        routed: 1,
      });
      this.persist(today);
      return { action: "route", bypass: false };
    }
    // A cause routed again: its folds restart, its routed count grows.
    const routeAgain = (bypass: boolean): AlertDecision => {
      this.memory.set(alert.cause, {
        ...prev,
        lastAt: now.getTime(),
        lastTier: alert.tier,
        folds: 0,
        bypassed: prev.bypassed || bypass,
        routed: (prev.routed ?? 1) + 1,
      });
      this.persist(today);
      return { action: "route", bypass };
    };
    const elapsedMin = (now.getTime() - prev.lastAt) / 60_000;
    if (elapsedMin >= this.cooldownMin) return routeAgain(false);
    // Genuine escalation of a live cause — breaks the cooldown once a day.
    if (prev.lastTier === "notice" && alert.tier === "alert" && !prev.bypassed)
      return routeAgain(true);
    const folds = prev.folds + 1;
    this.memory.set(alert.cause, { ...prev, folds, lastTier: alert.tier });
    this.persist(today);
    return { action: "fold", count: folds };
  }
}

/** What the top bar shows: how many alerts landed today, the latest one, and
 * how many repeats folded into counters. */
export interface AlertBadge {
  count: number;
  folds: number;
  latest?: { tier: AlertTier; title: string; cause: string; pr: number | null; ts: string };
}

/** Desktop notification. Injectable — tests never spawn, and a box without
 * notify-send degrades silently (the status line already carried it). */
export type NotifyRunner = (title: string, body: string) => void;

export const notifySendRunner: NotifyRunner = (title, body) => {
  try {
    const child = spawn("notify-send", ["--app-name=qcr", "--urgency=critical", title, body], {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => {
      /* no notify-send on this box — the status line is the fallback */
    });
    child.unref();
  } catch {
    /* likewise */
  }
};

export interface AlertSinks {
  /** Status line (App.notice). Every tier lands here — this is the floor. */
  notice(text: string): void;
  /** Top-bar badge state after each change. */
  badge(badge: AlertBadge): void;
  /** KDE notification; alert tier only. */
  notify: NotifyRunner;
}

export function statusLine(alert: AlertRecord, folds: number): string {
  const glyph = alert.tier === "alert" ? "▲" : "•";
  const where = alert.pr !== null ? ` #${alert.pr}` : "";
  const foldTag = folds > 0 ? ` (×${folds + 1})` : "";
  return `${glyph}${where} ${alert.title}${foldTag}`;
}

const ALERT_FILE_RE = /\.json$/;

/**
 * Scans the alerts dir and routes what it finds. Every processed file — good
 * or malformed — moves into `.done/` BEFORE it is routed, and only the
 * consumer whose move succeeded routes it: a scan is idempotent, a bad file
 * is reported exactly once, and two TUIs on one alerts dir never both route
 * one alert. A file that cannot be moved for any other reason (an unwritable
 * `.done/`) is routed once per TUI process, with the failure on the notice
 * line, rather than on every scan.
 */
export class AlertConsumer {
  private timer: NodeJS.Timeout | undefined;
  private readonly badgeState: AlertBadge = { count: 0, folds: 0 };
  /** The ops day `badgeState.latest` was routed on. */
  private latestDay: string | undefined;
  /** Files routed although their move into `.done/` failed. */
  private readonly unarchivable = new Set<string>();

  constructor(
    readonly dir: string,
    private readonly policy: AlertPolicy,
    private readonly sinks: AlertSinks,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get badge(): AlertBadge {
    return this.badgeState;
  }

  /** Alert files, oldest name first (names start with an ISO timestamp). */
  pending(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => ALERT_FILE_RE.test(f) && !f.startsWith("."))
      .filter((f) => {
        try {
          return statSync(join(this.dir, f)).isFile();
        } catch {
          return false;
        }
      })
      .sort();
  }

  scanOnce(): void {
    for (const file of this.pending()) this.consume(file);
    this.refreshBadge();
  }

  /** Publish the badge when the day's counts moved without an alert routing
   * here — today's persisted count at startup, the reset at the ops-day
   * boundary (which also drops an earlier day's latest alert). */
  private refreshBadge(): void {
    const count = this.policy.totalRouted();
    const folds = this.policy.totalFolds();
    const stale = this.badgeState.latest !== undefined && this.latestDay !== this.policy.today();
    if (count === this.badgeState.count && folds === this.badgeState.folds && !stale) return;
    this.badgeState.count = count;
    this.badgeState.folds = folds;
    if (stale) {
      delete this.badgeState.latest;
      this.latestDay = undefined;
    }
    this.sinks.badge(this.badgeState);
  }

  private consume(file: string): void {
    const full = join(this.dir, file);
    let text: string;
    try {
      text = readFileSync(full, "utf8");
    } catch {
      return; // vanished between listing and read — nothing to report
    }
    const claim = this.archive(file);
    if (claim === "taken" || (claim === "failed" && this.unarchivable.has(file))) return;
    if (claim === "claimed" && this.unarchivable.delete(file)) return; // already routed by the fallback
    if (claim === "failed") this.unarchivable.add(file);
    const parsed = parseAlert(text, file, this.now);
    if (!parsed.ok) {
      // Surfaced, never swallowed: the operator learns the companion wrote
      // something the TUI could not read, and which file it was.
      this.sinks.notice(`✖ malformed alert ${file}: ${parsed.error}`);
      return;
    }
    this.route(parsed.alert);
  }

  /** Public so a test (or a future retry path) can route a fabricated alert. */
  route(alert: AlertRecord): void {
    const decision = this.policy.decide(alert);
    // Derived from the policy's per-day memory, so the counts reset at the
    // ops-day boundary and survive a TUI restart.
    this.badgeState.count = this.policy.totalRouted();
    this.badgeState.folds = this.policy.totalFolds();
    if (decision.action === "fold") {
      this.sinks.notice(statusLine(alert, decision.count));
      this.sinks.badge(this.badgeState);
      return;
    }
    this.latestDay = this.policy.today();
    this.badgeState.latest = {
      tier: alert.tier,
      title: alert.title,
      cause: alert.cause,
      pr: alert.pr,
      ts: alert.ts,
    };
    this.sinks.notice(statusLine(alert, 0) + (decision.bypass ? " (escalated)" : ""));
    this.sinks.badge(this.badgeState);
    if (alert.tier === "alert") {
      this.sinks.notify(alert.title, alert.body || alert.cause);
    }
  }

  /** Move `file` into `.done/` — the claim on it. `taken`: it was gone, so
   * another consumer moved it first; `failed`: it could not be moved. */
  protected archive(file: string): "claimed" | "taken" | "failed" {
    const doneDir = join(this.dir, ".done");
    try {
      mkdirSync(doneDir, { recursive: true });
      renameSync(join(this.dir, file), join(doneDir, file));
      return "claimed";
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return "taken";
      if (!this.unarchivable.has(file))
        this.sinks.notice(`✖ alert ${file} could not be archived (${String(err)})`);
      return "failed";
    }
  }

  start(intervalMs: number): void {
    mkdirSync(this.dir, { recursive: true });
    this.scanOnce();
    this.timer = setInterval(() => this.scanOnce(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

/** Publish `record` as `<alertsDir>/<name>` so a consumer never sees a partial
 * file: written under a dot-name (`pending()` skips those), then renamed. */
function publishAlert(alertsDir: string, name: string, record: unknown): void {
  mkdirSync(alertsDir, { recursive: true });
  const tmp = join(alertsDir, `.${name}.tmp`);
  writeFileSync(tmp, JSON.stringify(record));
  renameSync(tmp, join(alertsDir, name));
}

// ---- daemon-detected pi auth failures → the same alert pipeline ----------

export interface PiAuthAlertMemory {
  /** `last_at` of the snapshot flag the last written file covered. */
  lastWritten: string;
}

/**
 * Bridge from the polled status.json flag (`pi_auth_expired`, written by the
 * daemon's passive packages/pi-plugin/src/authwatch.ts) into the alert pipeline: write one
 * alert-tier file per fresh detection into the alerts dir the AlertConsumer
 * already watches — badge, notify-send and per-cause
 * cooldown all come from the existing machinery. Writes at most one file per
 * distinct `last_at`, and nothing when the flag is absent or stale.
 */
export function maybeWritePiAuthAlert(
  alertsDir: string,
  flag: { last_at: string; hits: number } | undefined,
  mem: PiAuthAlertMemory,
  now: () => Date = () => new Date(),
): string | undefined {
  if (!flag || !flag.last_at) return undefined;
  if (mem.lastWritten === flag.last_at) return undefined;
  // Stale flags (e.g. a TUI opening hours later) are history, not an alert.
  if (now().getTime() - new Date(flag.last_at).getTime() > AUTH_FLAG_FRESH_MS) return undefined;
  const name = `${now().toISOString().replace(/[:.]/g, "-")}-pi-auth-expired.json`;
  publishAlert(alertsDir, name, {
    tier: "alert",
    cause: "pi-auth-expired",
    pr: null,
    title: "pi auth: API rejecting tokens as expired",
    body: `The daemon is seeing token-expired API errors in pi session logs (${flag.hits} hit(s), latest ${flag.last_at}). Reviews will wedge until /login is re-run in the container.`,
    ts: now().toISOString(),
  });
  mem.lastWritten = flag.last_at;
  return name;
}

// ---- reviewer memory unusable → the same alert pipeline ---------------------

export interface MemoryAlertMemory {
  /** `<state>@<since>` of the transition the last written file covered. */
  lastWritten: string;
}

/**
 * Bridge from status.json `memory` into the alert pipeline: ONE alert-tier
 * file per TRANSITION into `auth_failed` or `down` — badge, notify-send
 * and the per-cause cooldown all come from the existing consumer, exactly
 * like `maybeWritePiAuthAlert`. This is the desktop notification half of
 * reaching a person.
 *
 * Sourced from the daemon's snapshot, NEVER from OpenViking (the thing that is
 * down), and only from FRESH data: `fresh` is the poller's verdict — a stale
 * snapshot's memory state may long have changed, and an alert built from it
 * would be news about the past. Leaving the bad states re-arms it, so the next
 * outage notifies again.
 */
export function maybeWriteMemoryAlert(
  alertsDir: string,
  memory: MemoryStatus | undefined,
  fresh: boolean,
  mem: MemoryAlertMemory,
  now: () => Date = () => new Date(),
): string | undefined {
  if (!fresh || !memory || !memory.enabled) return undefined;
  if (memory.state !== "auth_failed" && memory.state !== "down") {
    mem.lastWritten = "";
    return undefined;
  }
  const key = `${memory.state}@${memory.since}`;
  if (mem.lastWritten === key) return undefined;
  const auth = memory.state === "auth_failed";
  const name = `${now().toISOString().replace(/[:.]/g, "-")}-memory-${auth ? "auth-failed" : "down"}.json`;
  publishAlert(alertsDir, name, {
    tier: "alert",
    cause: auth ? "memory-auth-failed" : "memory-down",
    pr: null,
    title: auth ? "reviewer memory: a key is refused" : "reviewer memory: down",
    body: `${memoryStatusLine(memory, now())} — rounds run memory-less and nothing is learned until it is fixed (the TUI board shows it; qcr status has the detail).`,
    ts: now().toISOString(),
  });
  mem.lastWritten = key;
  return name;
}

// ---- the day's curation did not reach memory → the same pipeline ----------

export interface CurationAlertMemory {
  /** `<state>@<day>` the last written file covered. */
  lastWritten: string;
}

/**
 * Bridge from status.json `memory.curation` into the alert pipeline: ONE
 * alert-tier file per (state, day) when the EOD curation is `missing` (no
 * receipt) or `not_persisted` (a lesson refused or not found) — badge,
 * notify-send and cooldown from the existing consumer, exactly like the memory
 * alert, so a curation that persisted nothing reaches a person. Fresh
 * snapshots only; a day that recovers re-arms it.
 */
export function maybeWriteCurationAlert(
  alertsDir: string,
  memory: MemoryStatus | undefined,
  fresh: boolean,
  mem: CurationAlertMemory,
  now: () => Date = () => new Date(),
): string | undefined {
  if (!fresh || !memory) return undefined;
  const c = memory.curation;
  if (!curationNeedsAttention(c) || !c) {
    mem.lastWritten = "";
    return undefined;
  }
  const key = `${c.state}@${c.day ?? "?"}`;
  if (mem.lastWritten === key) return undefined;
  const missing = c.state === "missing";
  const name = `${now().toISOString().replace(/[:.]/g, "-")}-eod-${missing ? "curation-missing" : "lessons-not-persisted"}.json`;
  publishAlert(alertsDir, name, {
    tier: "alert",
    cause: missing ? "eod-curation-missing" : "eod-lessons-not-persisted",
    pr: null,
    title: missing
      ? `EOD curation missing for ${c.day ?? "?"}`
      : `EOD lessons not persisted for ${c.day ?? "?"}`,
    body: missing
      ? `The EOD sweep for ${c.day ?? "?"} offered ${c.offered} lesson candidate(s) and no curation receipt came back — nothing says the day's outcomes were curated (state/eod/${c.day ?? "?"}/outcomes.md).`
      : `${c.not_persisted} lesson(s) from the ${c.day ?? "?"} curation are not in reviewer memory (a write refused, or a claimed lesson no header cites); the candidates ride the next packet. qcr status has the detail.`,
    ts: now().toISOString(),
  });
  mem.lastWritten = key;
  return name;
}

// ---- a PR parked by the worker crash-loop breaker → the same alert pipeline ----

export interface WorkerCrashAlertMemory {
  /** `<pr>@<parked_at>` of every park a file was already written for. */
  written: Set<string>;
}

/**
 * Bridge from status.json (`prs[].worker_crash.parked_at`, and `draining_reason`
 * `worker_failures`) into the alert pipeline: ONE alert-tier file per park, and
 * one per breaker drain, keyed by when they began so a TUI that opens later does
 * not repeat what a running one already said. Fresh snapshots only.
 */
export function maybeWriteWorkerCrashAlerts(
  alertsDir: string,
  snapshot:
    | Pick<
        StatusSnapshot,
        "prs" | "draining" | "draining_reason" | "draining_since" | "draining_until"
      >
    | undefined,
  fresh: boolean,
  mem: WorkerCrashAlertMemory,
  now: () => Date = () => new Date(),
): string[] {
  if (!fresh || !snapshot) return [];
  const names: string[] = [];
  const write = (
    key: string,
    cause: string,
    pr: number | null,
    title: string,
    body: string,
  ): void => {
    if (mem.written.has(key)) return;
    const name = `${now().toISOString().replace(/[:.]/g, "-")}-${cause}${pr === null ? "" : `-${pr}`}.json`;
    publishAlert(alertsDir, name, {
      tier: "alert",
      cause,
      pr,
      title,
      body,
      ts: now().toISOString(),
    });
    mem.written.add(key);
    names.push(name);
  };
  for (const pr of snapshot.prs) {
    const crash = pr.worker_crash;
    if (!crash?.parked_at) continue;
    write(
      `${pr.number}@${crash.parked_at}`,
      "worker-crash-loop",
      pr.number,
      `PR #${pr.number} parked: its workers keep failing`,
      `${crash.failures} consecutive worker failures; no worker starts for it until rerun-round or restart-session. Last error: ${crash.last_error ?? "unknown"}`,
    );
  }
  if (snapshot.draining && snapshot.draining_reason === "worker_failures")
    write(
      `drain@${snapshot.draining_since ?? ""}`,
      "worker-failures-drain",
      null,
      "workers failing on several PRs: the bot is draining",
      snapshot.draining_until
        ? `Workers failed on three PRs within 15 minutes with no success, so the bot drains: no round, answer or debug worker starts. It lifts itself at ${snapshot.draining_until} and the queue retries; if workers fail again it drains again, each time waiting twice as long (up to ${DEFAULT_BREAKER_LIMITS.healMaxMs / 3_600_000} h). Run drain off to retry now.`
        : "Workers failed on three PRs within 15 minutes with no success, so the bot drains: no round, answer or debug worker starts. Fix the cause, then run drain off.",
    );
  return names;
}

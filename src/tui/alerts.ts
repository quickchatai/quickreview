// Alert pipeline (slice C2) — the companion's only push channel.
//
// The companion writes `<alerts_dir>/<iso-ts>-<slug>.json` to the schema fixed
// in prompts/companion.md § Alerts; this module is the consumer. Verdict-file
// discipline applies (src/verdicts.ts): strict shape check, digit-string
// coercion for `pr`, and a malformed file is SURFACED (a status-line notice
// naming the file) — never silently dropped.
//
// Policy is, ratified with the owner:
//   tier `notice` → TUI status line only;
//   tier `alert`  → status line + KDE notify-send + an overseer inject;
//   one notification per distinct cause per `cooldown_min`, repeats inside the
//   window fold into a counter on the status line, and a genuine escalation
//   (notice → alert) of a folded cause may break the cooldown exactly once a
//   day. Spend is never an alert — that exclusion lives in the prompt.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

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
export function parseAlert(text: string, file: string, now: () => Date = () => new Date()): AlertParse {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `not JSON (${String(err instanceof Error ? err.message : err)})` };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: "not an object" };
  const v = raw as Record<string, unknown>;
  // LLM-written files: unambiguous digit-strings coerce, exactly as verdicts do.
  if (typeof v.pr === "string" && /^\d+$/.test(v.pr)) v.pr = Number(v.pr);
  if (v.tier !== "notice" && v.tier !== "alert") return { ok: false, error: `bad tier: ${JSON.stringify(v.tier)}` };
  if (typeof v.cause !== "string" || v.cause.trim() === "") return { ok: false, error: "cause must be a non-empty string" };
  if (typeof v.title !== "string" || v.title.trim() === "") return { ok: false, error: "title must be a non-empty string" };
  if (v.pr !== null && v.pr !== undefined && (typeof v.pr !== "number" || !Number.isInteger(v.pr))) return { ok: false, error: "pr must be an integer or null" };
  if (v.body !== undefined && typeof v.body !== "string") return { ok: false, error: "body must be a string" };
  if (v.ts !== undefined && typeof v.ts !== "string") return { ok: false, error: "ts must be a string" };
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

interface CauseMemory {
  day: string;
  lastAt: number;
  lastTier: AlertTier;
  folds: number;
  /** The one escalation bypass this cause gets today. */
  bypassed: boolean;
}

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Per-cause cooldown + daily fold memory. Pure w.r.t. I/O; the consumer owns
 * the side effects. */
export class AlertPolicy {
  private readonly memory = new Map<string, CauseMemory>();

  constructor(
    private readonly cooldownMin: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Folded repeats for a cause today (0 when it is fresh). */
  folds(cause: string): number {
    return this.memory.get(cause)?.folds ?? 0;
  }

  /** Total folded repeats across all causes today — the status-line counter. */
  totalFolds(): number {
    const today = dayKey(this.now());
    let total = 0;
    for (const m of this.memory.values()) if (m.day === today) total += m.folds;
    return total;
  }

  decide(alert: AlertRecord): AlertDecision {
    const now = this.now();
    const today = dayKey(now);
    const prev = this.memory.get(alert.cause);
    if (!prev || prev.day !== today) {
      // "Already told you" memory is per day: a new day starts clean.
      this.memory.set(alert.cause, { day: today, lastAt: now.getTime(), lastTier: alert.tier, folds: 0, bypassed: false });
      return { action: "route", bypass: false };
    }
    const elapsedMin = (now.getTime() - prev.lastAt) / 60_000;
    if (elapsedMin >= this.cooldownMin) {
      this.memory.set(alert.cause, { ...prev, lastAt: now.getTime(), lastTier: alert.tier, folds: 0, bypassed: prev.bypassed });
      return { action: "route", bypass: false };
    }
    if (prev.lastTier === "notice" && alert.tier === "alert" && !prev.bypassed) {
      // Genuine escalation of a live cause — breaks the cooldown once a day.
      this.memory.set(alert.cause, { ...prev, lastAt: now.getTime(), lastTier: "alert", folds: 0, bypassed: true });
      return { action: "route", bypass: true };
    }
    const folds = prev.folds + 1;
    this.memory.set(alert.cause, { ...prev, folds, lastTier: alert.tier });
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
    const child = spawn("notify-send", ["--app-name=qcr", "--urgency=critical", title, body], { detached: true, stdio: "ignore" });
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
  /** Prose message to the VM overseer; alert tier only. */
  inject(text: string): void;
}

/** The overseer message body — prefixed so the overseer can tell instantly
 * that a machine on the owner's PC wrote it, not the owner. */
export function overseerMessage(alert: AlertRecord): string {
  const where = alert.pr !== null ? ` (PR #${alert.pr})` : "";
  return `[companion alert] ${alert.title}${where}\n\ncause: ${alert.cause}\n\n${alert.body}`.trim();
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
 * or malformed — moves into `.done/`, so a scan is idempotent and a bad file
 * is reported exactly once.
 */
export class AlertConsumer {
  private timer: NodeJS.Timeout | undefined;
  private readonly badgeState: AlertBadge = { count: 0, folds: 0 };

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
  }

  private consume(file: string): void {
    const full = join(this.dir, file);
    let text: string;
    try {
      text = readFileSync(full, "utf8");
    } catch {
      return; // vanished between listing and read — nothing to report
    }
    const parsed = parseAlert(text, file, this.now);
    this.archive(file);
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
    if (decision.action === "fold") {
      this.badgeState.folds = this.policy.totalFolds();
      this.sinks.notice(statusLine(alert, decision.count));
      this.sinks.badge(this.badgeState);
      return;
    }
    this.badgeState.count += 1;
    this.badgeState.folds = this.policy.totalFolds();
    this.badgeState.latest = { tier: alert.tier, title: alert.title, cause: alert.cause, pr: alert.pr, ts: alert.ts };
    this.sinks.notice(statusLine(alert, 0) + (decision.bypass ? " (escalated)" : ""));
    this.sinks.badge(this.badgeState);
    if (alert.tier === "alert") {
      this.sinks.notify(alert.title, alert.body || alert.cause);
      this.sinks.inject(overseerMessage(alert));
    }
  }

  private archive(file: string): void {
    const doneDir = join(this.dir, ".done");
    try {
      mkdirSync(doneDir, { recursive: true });
      renameSync(join(this.dir, file), join(doneDir, file));
    } catch {
      /* already moved / unwritable — the scan stays idempotent either way */
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

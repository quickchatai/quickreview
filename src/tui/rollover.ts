// Daily rollover (build slice C3) — a fresh companion conversation
// per ops day, with the five carry items handed over as the first message.
//
// Ratified: rollover fires on the FIRST TUI start of a new day
// (ops timezone), never mid-use; the sequence is the rotateOverseer pattern from
// src/sessions.ts — archive the run date-stamped, kill the tmux session,
// respawn — and the opening context carries: yesterday's EOD digest, the
// compacted summary of yesterday's conversation, yesterday's conversation
// tail, unresolved alerts, and the live board snapshot (plus the alert knobs
// in force, so the companion's tiering matches the config it is judged by).
//
// Everything the container owns goes through the DockerRunner seam (the pihome
// volume is only reachable via `docker exec`); everything the host owns is a
// plain path, so the tests need neither docker nor pi.
//
// The day-open text is delivered as an INJECT FILE, not a pi CLI flag:
// `extensions/inject-bridge.ts` drains its directory on `session_start`
// (VERIFY-ON-PIN: the drain-then-watch behaviour depends only on our own code,
// but `pi.sendUserMessage` and the `session_start` event name are pi's), so
// writing the file BEFORE spawning pi is race-free. The alternative — a pi CLI
// initial-message flag — is undocumented for 0.84.1; if one turns up it is a
// drop-in replacement for writeDayOpen().
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CompanionConfig } from "../config.js";
import { zoneDateString } from "../eod.js";
import type { StatusSnapshot } from "../state.js";
import { parseAlert, readPolicyState, type AlertTier } from "./alerts.js";
import { CONTAINER, type DockerRunner } from "./companion.js";

/** Bounds for the compacted summary and the raw tail — the opening message is
 * a briefing, not a transcript. */
export const SUMMARY_MAX_CHARS = 4000;
export const TAIL_MAX_CHARS = 2000;
export const TURN_MAX_CHARS = 400;
export const HEAD_TURNS = 6;
export const TAIL_TURNS = 12;

// ---- the last-open date -----------------------------------------------------

export interface RolloverState {
  /** Ops-timezone calendar date of the conversation currently on the volume. */
  last_open_date: string;
  /** Bookkeeping only — when the state file was last written. */
  updated_at: string;
  /** Date-stamped archive of the run that was rotated out most recently. */
  last_archive?: string;
  /** Ops-timezone date the first-run interview was delivered. Present
   * ⇒ the interview fired once and never fires again; resuming an abandoned
   * interview is a conversation with the companion, not a re-delivery. */
  first_run_interviewed?: string;
}

export function readRolloverState(path: string): RolloverState | undefined {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<RolloverState>;
    if (typeof raw.last_open_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw.last_open_date)) return undefined;
    return {
      last_open_date: raw.last_open_date,
      updated_at: String(raw.updated_at ?? ""),
      last_archive: raw.last_archive,
      ...(typeof raw.first_run_interviewed === "string" ? { first_run_interviewed: raw.first_run_interviewed } : {}),
    };
  } catch {
    return undefined;
  }
}

export function writeRolloverState(path: string, state: RolloverState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, path);
}

/**
 * Today's calendar date in the operations timezone (`cfg.ops.timezone`,
 *; the TUI threads it through — the UTC default only covers callers
 * with no config in hand). `QCR_FAKE_TODAY=YYYY-MM-DD` overrides it — the
 * only way to exercise a rollover without waiting for midnight (the smoke
 * script uses exactly this).
 */
export function todayDate(now: Date, env: NodeJS.ProcessEnv = process.env, timeZone: string = "UTC"): string {
  const fake = env.QCR_FAKE_TODAY?.trim();
  if (fake && /^\d{4}-\d{2}-\d{2}$/.test(fake)) return fake;
  return zoneDateString(now, timeZone);
}

export type RolloverVerdict =
  /** No recorded day yet — record today and leave the conversation alone. */
  | { kind: "first-run"; today: string }
  | { kind: "same-day"; today: string }
  | { kind: "rollover"; today: string; previous: string };

/** Pure decision: string compare is correct for ISO dates, and a clock that
 * went backwards (previous > today) is treated as same-day, never a rotate. */
export function decideRollover(today: string, state: RolloverState | undefined): RolloverVerdict {
  if (!state) return { kind: "first-run", today };
  if (state.last_open_date >= today) return { kind: "same-day", today };
  return { kind: "rollover", today, previous: state.last_open_date };
}

// ---- yesterday's conversation ----------------------------------------------

export interface Turn {
  role: "user" | "assistant";
  text: string;
}

/**
 * Extract the user/assistant text turns from a pi session .jsonl.
 *
 * VERIFY-ON-PIN: the on-disk session-file schema is not documented for 0.84.1.
 * Three shapes are accepted (`{role,content}`, `{type:"message",message:{…}}`,
 * `{entry:{role,content}}`) and content may be a string or an array of
 * `{type:"text",text}` parts. An unrecognised line is skipped, so a schema
 * drift degrades the summary rather than breaking the rollover.
 */
export function parseConversation(jsonl: string): Turn[] {
  const turns: Turn[] = [];
  for (const line of jsonl.split("\n")) {
    if (line.trim() === "") continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const node = unwrap(obj);
    if (!node) continue;
    const role = node.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = contentText(node.content).trim();
    if (text === "") continue;
    turns.push({ role, text });
  }
  return turns;
}

function unwrap(obj: unknown): { role?: unknown; content?: unknown } | undefined {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return undefined;
  const v = obj as Record<string, unknown>;
  for (const inner of [v, v.message, v.entry]) {
    if (typeof inner === "object" && inner !== null && !Array.isArray(inner)) {
      const cand = inner as Record<string, unknown>;
      if (typeof cand.role === "string") return cand as { role?: unknown; content?: unknown };
    }
  }
  return undefined;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") parts.push(part);
    else if (typeof part === "object" && part !== null) {
      const p = part as Record<string, unknown>;
      if (typeof p.text === "string") parts.push(p.text);
    }
  }
  return parts.join("\n");
}

function oneLine(text: string, max = TURN_MAX_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** The user-turn role label: the configured owner name, or the
 * neutral role when none is configured. */
function ownerLabel(ownerName?: string): string {
  return ownerName?.trim() || "the operator";
}

function renderTurns(turns: Turn[], budget: number, ownerName?: string): string {
  const lines: string[] = [];
  let used = 0;
  for (const t of turns) {
    const line = `- **${t.role === "user" ? ownerLabel(ownerName) : "you"}**: ${oneLine(t.text)}`;
    if (used + line.length > budget) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join("\n");
}

/**
 * Deterministic compaction — no LLM in this path (the daemon's rule applies to
 * the TUI too). Head + tail sectioning with a hard character budget: the
 * opening of the day tells the companion how yesterday started, how it ended,
 * and how much it is not being shown.
 */
export function compactConversation(turns: Turn[], budget: number = SUMMARY_MAX_CHARS, ownerName?: string): string {
  if (turns.length === 0) return "";
  const head = turns.slice(0, HEAD_TURNS);
  const tail = turns.length > HEAD_TURNS ? turns.slice(Math.max(HEAD_TURNS, turns.length - TAIL_TURNS)) : [];
  const skipped = turns.length - head.length - tail.length;
  const half = Math.floor((budget - 200) / 2);
  const sections = [`Yesterday: ${turns.length} turns (${turns.filter((t) => t.role === "user").length} from ${ownerLabel(ownerName)}).`];
  sections.push(`**How it opened**\n${renderTurns(head, half, ownerName)}`);
  if (skipped > 0) sections.push(`…${skipped} turn${skipped === 1 ? "" : "s"} elided…`);
  if (tail.length > 0) sections.push(`**How it ended**\n${renderTurns(tail, half, ownerName)}`);
  const out = sections.join("\n\n");
  return out.length <= budget ? out : `${out.slice(0, budget - 1)}…`;
}

/** The raw last few turns, verbatim-ish and bounded — the carry item that is
 * deliberately NOT summarised. */
export function conversationTail(turns: Turn[], budget: number = TAIL_MAX_CHARS): string {
  if (turns.length === 0) return "";
  return renderTurns(turns.slice(-6), budget);
}

// ---- the other carry items --------------------------------------------------

export function readSnapshot(feedDir: string): StatusSnapshot | undefined {
  try {
    return JSON.parse(readFileSync(join(feedDir, "snapshot.json"), "utf8")) as StatusSnapshot;
  } catch {
    return undefined;
  }
}

/** One paragraph of board state: counts by state, rounds, mode, spend. */
export function snapshotSummary(snap: StatusSnapshot | undefined): string {
  if (!snap) return "";
  const byState = new Map<string, number>();
  for (const p of snap.prs) byState.set(p.state, (byState.get(p.state) ?? 0) + 1);
  const states = [...byState.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([s, n]) => `${n} ${s}`);
  const lines = [
    `${snap.prs.length} tracked PR${snap.prs.length === 1 ? "" : "s"}${states.length > 0 ? ` (${states.join(", ")})` : ""}; ` +
      `${snap.running_rounds} round${snap.running_rounds === 1 ? "" : "s"} running; mode ${snap.dry_run ? "dry-run" : "LIVE"}; ` +
      `spend $${snap.total_spend_usd.toFixed(2)} total${snap.today_spend_usd !== undefined ? ` / $${snap.today_spend_usd.toFixed(2)} today` : ""}.`,
    `Snapshot written ${snap.written_at}.`,
  ];
  const notable = snap.prs
    .filter((p) => p.state !== "closed")
    .slice(0, 8)
    .map((p) => `- #${p.number} ${p.state}${p.last_verdict ? ` (${p.last_verdict})` : ""}${p.paused ? " [paused]" : ""} — ${oneLine(p.title ?? "", 70)}`);
  return [...lines, ...notable].join("\n");
}

/** Digest headline: the feed snapshot carries the daemon's own copy; a local
 * digest/ dir is the offline fallback. Neither → degraded to "—". */
export function digestLine(snap: StatusSnapshot | undefined, localHeadline?: string): string {
  return (snap?.digest_headline ?? "").trim() || (localHeadline ?? "").trim();
}

/**
 * Alerts that are still open at the moment of rollover: anything sitting
 * unconsumed in the alerts dir, plus every `alert`-tier cause the policy state
 * saw on a previous day (a cause that fired yesterday evening and was never
 * spoken to is exactly the thing a fresh conversation would otherwise forget).
 */
export function openAlerts(alertsDir: string, policyStatePath: string, today: string): string {
  const lines: string[] = [];
  if (existsSync(alertsDir)) {
    for (const f of readdirSync(alertsDir).filter((n) => n.endsWith(".json") && !n.startsWith(".")).sort()) {
      let parsed;
      try {
        parsed = parseAlert(readFileSync(join(alertsDir, f), "utf8"), f);
      } catch {
        continue;
      }
      if (parsed.ok) lines.push(`- [${parsed.alert.tier}] ${parsed.alert.title}${parsed.alert.pr !== null ? ` (PR #${parsed.alert.pr})` : ""} — cause \`${parsed.alert.cause}\` (unread)`);
      else lines.push(`- [malformed] ${f}: ${parsed.error}`);
    }
  }
  const policy = readPolicyState(policyStatePath);
  if (policy && policy.day !== today) {
    for (const [cause, mem] of Object.entries(policy.causes)) {
      if ((mem.lastTier as AlertTier) !== "alert") continue;
      lines.push(`- [alert] cause \`${cause}\` last raised ${policy.day}${mem.folds > 0 ? ` (+${mem.folds} folded repeats)` : ""} — carried over`);
    }
  }
  return lines.join("\n");
}

/** The knobs the companion's tiering is judged against, verbatim from config. */
export function alertKnobs(cfg: CompanionConfig): string {
  return [
    `- overdue grace: ${cfg.overdue_grace_min} min`,
    `- stale daemon: ${cfg.stale_alert_s} s`,
    `- awaiting age: ${cfg.awaiting_age_h} h`,
    `- per-cause cooldown: ${cfg.cooldown_min} min`,
  ].join("\n");
}

// ---- the day-open message ---------------------------------------------------

export interface DayOpenSources {
  date: string;
  digest: string;
  yesterday_summary: string;
  yesterday_tail: string;
  open_alerts: string;
  snapshot_summary: string;
  alert_knobs: string;
}

const PLACEHOLDERS: Array<keyof DayOpenSources> = [
  "date",
  "digest",
  "yesterday_summary",
  "yesterday_tail",
  "open_alerts",
  "snapshot_summary",
  "alert_knobs",
];

/** Fill prompts/companion-day-open.md. An empty source renders as `—`, per the
 * template's own header — a missing carry item is stated, never silent. */
export function renderDayOpen(template: string, sources: DayOpenSources): string {
  let out = template;
  for (const key of PLACEHOLDERS) {
    const value = (sources[key] ?? "").trim();
    out = out.replaceAll(`{{${key}}}`, value === "" ? "—" : value);
  }
  return out;
}

/** The inject file the bridge will deliver as the first user message. */
export function dayOpenFileName(date: string): string {
  return `${date}-day-open.md`;
}

// ---- first-run interview ------------------------------------------

/** The onboarding wizard's marker contract: `state/companion/
 * first-run.json` with a `completed_at` ISO stamp, written when onboarding
 * finished. Malformed/absent → undefined, never a throw. */
export interface FirstRunMarker {
  completed_at: string;
}

export function readFirstRunMarker(path: string): FirstRunMarker | undefined {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<FirstRunMarker>;
    if (typeof raw.completed_at !== "string" || raw.completed_at.trim() === "") return undefined;
    return { completed_at: raw.completed_at };
  } catch {
    return undefined;
  }
}

/**
 * Should the first-run interview fire on this start? Pure decision:
 *
 *   * a delivered interview never fires again (the state records it);
 *   * no rollover state has EVER existed ⇒ first run, interview due — the
 *     fallback that makes the feature work before/without the wizard;
 *   * otherwise the wizard's marker decides — its presence on an installation
 *     whose state carries no interview means onboarding finished and the
 *     greeting is owed.
 *
 * An existing installation (state present, no marker) never gets one.
 */
export function interviewDue(marker: FirstRunMarker | undefined, state: RolloverState | undefined): boolean {
  if (state?.first_run_interviewed) return false;
  if (state === undefined) return true;
  return marker !== undefined;
}

export interface FirstRunSources {
  date: string;
  /** Owner label, already defaulted — never empty. */
  owner: string;
  snapshot_summary: string;
}

const FIRST_RUN_PLACEHOLDERS: Array<keyof FirstRunSources> = ["date", "owner", "snapshot_summary"];

/** Fill prompts/companion-first-run.md — same `—`-for-empty discipline as the
 * day-open (the owner label is pre-defaulted, so only the snapshot can be empty). */
export function renderFirstRun(template: string, sources: FirstRunSources): string {
  let out = template;
  for (const key of FIRST_RUN_PLACEHOLDERS) {
    const value = (sources[key] ?? "").trim();
    out = out.replaceAll(`{{${key}}}`, value === "" ? "—" : value);
  }
  return out;
}

export function firstRunFileName(date: string): string {
  return `${date}-first-run.md`;
}

// ---- the sequence -----------------------------------------------------------

export interface RolloverOptions {
  /** Host path of the last-open-date state file. */
  statePath: string;
  /** Host path of the persisted alert-policy state (for carried-over causes). */
  policyStatePath: string;
  /** Host path of prompts/companion-day-open.md. */
  templatePath: string;
  /** Host inject dir for the companion session (= <repo>/inject/companion). */
  injectDir: string;
  /** Offline digest headline, when the feed snapshot has none. */
  localDigestHeadline?: () => string | undefined;
  /** `[owner] name` — the user-turn label in the day-open summary.
   * Absent/empty ⇒ "the operator". */
  ownerName?: string;
  /** Host path of prompts/companion-first-run.md. Absent ⇒ the
   * first-run interview machinery is off entirely — back-compat for callers
   * that only want the daily rollover. */
  firstRunTemplatePath?: string;
  /** Host path of the wizard's marker (`state/companion/
   * first-run.json`). Absent/missing file is fine — the no-state-ever
   * fallback still detects a fresh installation. */
  firstRunMarkerPath?: string;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  timeZone?: string;
}

export interface RolloverReport {
  verdict: RolloverVerdict;
  /** Ordered step log — what actually happened, for the status line and tests. */
  steps: string[];
  /** In-container path the previous conversation was archived to. */
  archivedTo?: string;
  /** Host path of the day-open inject file, when one was written. */
  dayOpenFile?: string;
  /** The rendered day-open text (tests assert on it; the TUI logs its size). */
  dayOpen?: string;
  /** Host path of the first-run interview inject file, when this
   * start delivered one (at most once per installation). */
  interviewFile?: string;
  /** The rendered interview text. */
  interview?: string;
}

/**
 * The rollover itself. Call it after the container is up and BEFORE spawnPi /
 * attach; it returns a report and, on a rollover, leaves the tmux session
 * killed so the caller's spawnPi() births a fresh conversation that opens on
 * the day-open message.
 */
export class CompanionRollover {
  private readonly now: () => Date;
  private readonly env: NodeJS.ProcessEnv;
  private readonly timeZone: string;

  constructor(
    private readonly cfg: CompanionConfig,
    private readonly docker: DockerRunner,
    private readonly opts: RolloverOptions,
  ) {
    this.now = opts.now ?? (() => new Date());
    this.env = opts.env ?? process.env;
    this.timeZone = opts.timeZone ?? "UTC";
  }

  today(): string {
    return todayDate(this.now(), this.env, this.timeZone);
  }

  /** In-container session dir — must match CompanionLifecycle.piArgv(). */
  private sessionDir(): string {
    return `${CONTAINER.piHome}/agent/sessions/${this.cfg.session}`;
  }

  private archiveDir(date: string): string {
    return `${CONTAINER.piHome}/archive/${this.cfg.session}/${date}`;
  }

  /** Newest conversation file on the pihome volume, or "" when there is none. */
  async newestSessionFile(): Promise<string> {
    const res = await this.docker([
      "exec",
      this.cfg.container_name,
      "sh",
      "-c",
      `ls -1t '${this.sessionDir()}'/*.jsonl 2>/dev/null | head -1`,
    ]);
    return res.ok ? res.stdout.trim() : "";
  }

  /** Archive it date-stamped (rotateOverseer pattern), returning the copy's
   * in-container path. Copy, never move: if anything below fails, the original
   * conversation is still where pi left it. */
  async archive(file: string, date: string): Promise<string | undefined> {
    if (file === "") return undefined;
    const dest = `${this.archiveDir(date)}/session.jsonl`;
    const res = await this.docker([
      "exec",
      this.cfg.container_name,
      "sh",
      "-c",
      `mkdir -p '${this.archiveDir(date)}' && cp '${file}' '${dest}'`,
    ]);
    return res.ok ? dest : undefined;
  }

  /** Read a bounded tail of the conversation file through the docker seam. */
  async readConversation(file: string): Promise<string> {
    if (file === "") return "";
    const res = await this.docker(["exec", this.cfg.container_name, "sh", "-c", `tail -c 400000 '${file}'`]);
    return res.ok ? res.stdout : "";
  }

  async killSession(): Promise<void> {
    // Never fatal: no session to kill is the state we want anyway.
    await this.docker(["exec", this.cfg.container_name, "tmux", "kill-session", "-t", this.cfg.session]);
  }

  /** tmp+rename into the inject dir — the bridge must never drain a torn file. */
  private writeInject(name: string, text: string): string {
    mkdirSync(this.opts.injectDir, { recursive: true });
    const target = join(this.opts.injectDir, name);
    const tmp = join(this.opts.injectDir, `.${name}.tmp`);
    writeFileSync(tmp, text);
    renameSync(tmp, target);
    return target;
  }

  /** Write the day-open message where inject-bridge will drain it. */
  writeDayOpen(text: string, date: string): string {
    return this.writeInject(dayOpenFileName(date), text);
  }

  /** Assemble the opening context from the five carry items + the knobs. */
  buildDayOpen(date: string, turns: Turn[]): string {
    const snap = readSnapshot(this.cfg.feed_dir);
    const template = readFileSync(this.opts.templatePath, "utf8");
    return renderDayOpen(template, {
      date,
      digest: digestLine(snap, this.opts.localDigestHeadline?.()),
      yesterday_summary: compactConversation(turns, undefined, this.opts.ownerName),
      yesterday_tail: conversationTail(turns),
      open_alerts: openAlerts(this.cfg.alerts_dir, this.opts.policyStatePath, date),
      snapshot_summary: snapshotSummary(snap),
      alert_knobs: alertKnobs(this.cfg),
    });
  }

  private record(date: string, archive?: string): void {
    // Preserve the interview mark across rewrites: dropping it on a later
    // rollover would re-arm a marker-keyed interview forever.
    const prior = readRolloverState(this.opts.statePath);
    writeRolloverState(this.opts.statePath, {
      last_open_date: date,
      updated_at: this.now().toISOString(),
      ...(archive ? { last_archive: archive } : {}),
      ...(prior?.first_run_interviewed ? { first_run_interviewed: prior.first_run_interviewed } : {}),
    });
  }

  /** Assemble the first-run interview from its template. */
  buildInterview(date: string): string {
    const template = readFileSync(this.opts.firstRunTemplatePath!, "utf8");
    return renderFirstRun(template, {
      date,
      owner: this.opts.ownerName?.trim() || "the operator",
      snapshot_summary: snapshotSummary(readSnapshot(this.cfg.feed_dir)),
    });
  }

  /**
   * Deliver the first-run interview if it is due — at most once per
   * installation, recorded in the rollover state. `prior` is the state as it
   * stood BEFORE this run touched it (the no-state-ever fallback must see the
   * original absence, not the row `record()` just created). Nothing here ever
   * blocks a start: a missing/broken template degrades to a step note.
   */
  private maybeInterview(today: string, prior: RolloverState | undefined, steps: string[]): { interviewFile?: string; interview?: string } {
    if (!this.opts.firstRunTemplatePath) return {};
    const marker = this.opts.firstRunMarkerPath ? readFirstRunMarker(this.opts.firstRunMarkerPath) : undefined;
    if (!interviewDue(marker, prior)) return {};
    let interview: string;
    try {
      interview = this.buildInterview(today);
    } catch {
      steps.push("first-run interview template unreadable — skipped (system unaffected)");
      return {};
    }
    const interviewFile = this.writeInject(firstRunFileName(today), interview);
    steps.push(`queued first-run interview → ${interviewFile}`);
    // Mark it delivered so it fires exactly once; later starts run the normal
    // day-open. An abandoned interview resumes in conversation, never here.
    const state = readRolloverState(this.opts.statePath) ?? { last_open_date: today, updated_at: this.now().toISOString() };
    writeRolloverState(this.opts.statePath, { ...state, first_run_interviewed: today });
    return { interviewFile, interview };
  }

  /**
   * first-run → record the date, touch nothing;
   * same-day  → nothing at all;
   * rollover  → archive → compact → assemble → kill → (caller respawns);
   * …and on any of the three, deliver the first-run interview when it
   * is due (fresh installation, or the wizard's marker with no interview on
   * record) — exactly once, ever.
   */
  async run(): Promise<RolloverReport> {
    const today = this.today();
    const prior = readRolloverState(this.opts.statePath);
    const verdict = decideRollover(today, prior);
    const steps: string[] = [];
    let archivedTo: string | undefined;
    let dayOpenFile: string | undefined;
    let dayOpen: string | undefined;

    if (verdict.kind === "first-run") {
      this.record(today);
      steps.push(`first run — companion day set to ${today}`);
    } else if (verdict.kind === "rollover") {
      const file = await this.newestSessionFile();
      steps.push(file === "" ? "no previous conversation found" : `found conversation ${file}`);
      archivedTo = await this.archive(file, verdict.previous);
      if (archivedTo) steps.push(`archived → ${archivedTo}`);
      const turns = parseConversation(await this.readConversation(file));
      steps.push(`compacted ${turns.length} turn${turns.length === 1 ? "" : "s"}`);
      dayOpen = this.buildDayOpen(today, turns);
      steps.push(`assembled opening context (${dayOpen.length} chars)`);
      await this.killSession();
      steps.push(`killed tmux session ${this.cfg.session}`);
      dayOpenFile = this.writeDayOpen(dayOpen, today);
      steps.push(`queued day-open message → ${dayOpenFile}`);
      this.record(today, archivedTo);
    }

    const interview = this.maybeInterview(today, prior, steps);
    return { verdict, steps, archivedTo, dayOpenFile, dayOpen, ...interview };
  }
}

// Board screen: semantic truecolor everywhere, rich PR rows (author, last-tick
// age, rounds, verdict chip), colored glyph legend, section titles with
// subtitles, clickable zones for full mouse navigation, OSC-8 PR links.
// Pure: (view, cols, rows) → Frame (+ zones/meta for the input layer).
import { archiveAttention, readArchiveStatus } from "../archive/status.js";
import type { WhyPayload } from "../cli.js";
import { readDaemonLoad, stallShortPhrase } from "../eventloop.js";
import { curationNeedsAttention, earlierPhrase } from "../learner/status.js";
import { fmtDuration } from "../memory/health.js";
import { cancelCauseLabel, isLoudCancelCause, type StatusSnapshot } from "../state.js";
import type { AlertBadge } from "./alerts.js";
import { barHeight, paintCmdBar, type BarButton, type LiveKeys } from "./cmdbar.js";
import { filterLabel, visiblePrs, type BoardFilter } from "./filters.js";
import { glyphFor, type EventLine, type SnapshotPr } from "./model.js";
import { windowStart } from "./panes.js";
import {
  ACCENT,
  ACCENT_BG,
  HEADING,
  MUTED,
  RESET as DRESET,
  STRONG,
  WARN,
  modeBadge,
  sectionTitle,
  selected as selectedLine,
} from "./design.js";
import {
  Frame,
  charWidth,
  displayWidth,
  fit,
  rule,
  sanitizeText,
  stripAnsi,
  truncate,
  wrap,
} from "./paint.js";
import type { PiPaneView } from "./pipane.js";
import type { Health } from "./poll.js";
import {
  lensForAgent,
  roundExecutionStage,
  type LiveAgentProgress,
  type RoundProgressSnapshot,
} from "../round-progress.js";
import type { ConnectionDiagnosis } from "./sshtriage.js";
import { FG, RESET, fmtAge, legendLine, osc8, prUrl, stateColor, verdictChip } from "./theme.js";

/** Every clickable thing the board declares. */
export type BoardAction =
  | { t: "select-pr"; pr: number }
  | { t: "open-github"; pr: number }
  | { t: "event-jump"; pr: number }
  | { t: "pi-focus" } // the live pi pane: clicking it types into the session in place
  | { t: "companion" }; // the alert badge: hand the keyboard to the companion column

export interface BoardView {
  health: Health;
  /** `undefined` = not yet known. Only a heartbeat sets it: a rendering
   * default here would paint a DRY-RUN badge on a live install. */
  dryRun: boolean | undefined;
  snapshot?: StatusSnapshot;
  /** The triaged reason the daemon cannot be reached, with the exact
   * remedy. Painted where the PR list would be, because that is where the
   * operator is looking when the list is empty. */
  connection?: ConnectionDiagnosis;
  events: EventLine[]; // newest first
  selected: number;
  detail?: WhyPayload;
  /** The EVENTS overlay is open (and owns j/k) — `e` toggles it. */
  eventsFocus: boolean;
  eventsScroll: number;
  help: boolean;
  /** The quit prompt is up. Painted by App over the composed frame,
   * so it covers every tab without any renderer knowing about it. */
  confirmQuit?: boolean;
  /** Live mirror of the selected PR's pi session (board's lower region). */
  pi?: PiPaneView;
  /** Structured parent/lens activity for the selected running round. */
  progress?: RoundProgressSnapshot;
  /** The PR the pane is showing. Defaults to the selection; while the pane is
   * focused it is locked to the session being typed into, so a poll that
   * reorders the list cannot yank the keyboard to another PR. */
  piPr?: number;
  /** The pi pane owns the keyboard: every key but Ctrl-q goes to the session. */
  piFocus?: boolean;
  /** Extra line rendered on the pi pane header (quick-message state). */
  noticeLine?: string;
  /** Replaces the pi pane while the message box is open. */
  inputBox?: { target: string; text: string };
  /** Wall clock for age rendering; injected for testability. */
  now?: Date;
  /** owner/repo for GitHub links (OSC-8 + click). */
  repo?: string;
  /** Companion alert badge (count + latest, themed by tier). */
  alerts?: AlertBadge;
  /** A live `alert`-tier badge takes ⏎ until it is acknowledged (Esc) or
   * followed into the companion tab. */
  alertFocus?: boolean;
  /** Active board filter (companion `board_filter` verb; F clears).
   * Consumed through `visiblePrs` — never filter a sortPrs call directly. */
  boardFilter?: BoardFilter | null;
}

// ---- layout ----------------------------------------------------------------

/** "held by the operator" / "held by a session, lapses 12:30:00Z";
 * an older daemon reports no holder, and that is said rather than guessed. */
export function leverHolderLabel(
  by: "operator" | "session" | undefined,
  until: string | undefined,
): string {
  if (by === undefined) return "holder unknown (older daemon)";
  const who = by === "operator" ? "held by the operator" : "held by a session";
  return until ? `${who}, lapses ${until.slice(11, 19)}Z` : `${who} until lifted`;
}

/** The pause chip on a PR row: `⏸op` for the operator's hold, `⏸` + the lapse time for a session's. */
function pauseChip(pr: SnapshotPr): string {
  if (!pr.paused) return "";
  if (!pr.pause) return "⏸";
  if (pr.pause.issuer === "operator") return "⏸op";
  return pr.pause.expires_at ? `⏸→${pr.pause.expires_at.slice(11, 16)}Z` : "⏸";
}

/** A PR row's verdict chip: a held review failure, else the last verdict. */
function rowChip(pr: SnapshotPr): string {
  return pr.review_failure ? `${FG.anomaly}FAILED_LOUD${RESET}` : verdictChip(pr.last_verdict);
}

/** A PR title as one inert line — it is the author's text, and the row is
 * written straight to the terminal. */
function rowTitle(pr: SnapshotPr): string {
  return oneLine(pr.title);
}

/** A PR row as `styledRow` paints it, without its styling — what the list
 * is sized to. */
function rowPlain(pr: SnapshotPr, now: Date): string {
  const rounds = pr.rounds ? `r${pr.rounds}` : "";
  return [
    glyphFor(pr),
    `#${pr.number}`,
    pr.author ?? "",
    fmtAge(pr.updated_at, now),
    rounds,
    stripAnsi(rowChip(pr)),
    pauseChip(pr),
    rowTitle(pr),
  ]
    .filter((s) => s !== "")
    .join(" ");
}

/** Left column sized to the longest PR row so titles aren't cropped while
 * the detail pane sits empty — clamped to 45% of the terminal. */
export function listWidth(prs: SnapshotPr[], cols: number, now: Date = new Date(0)): number {
  const widest = prs.reduce(
    (w, pr) => Math.max(w, displayWidth(rowPlain(pr, now))),
    displayWidth(stripAnsi(legendLine())),
  );
  return Math.min(Math.max(24, widest + 3), Math.floor(cols * 0.45));
}

/**
 * What the board answers to on this frame (the bar is state-derived, so a
 * button is painted exactly when its key would do something).
 *
 * The verbs that act on the selected PR appear only while there is one: with
 * no snapshot, or an empty list, a `[u unwedge]` would be an action derived
 * from no data — the second half of the honest-unknown rule. `g` also needs
 * the repo slug the URL is built from. `e` toggles the events overlay
 * regardless, and `I` (setup) is about the repo, not a PR. Inline: `a` is ⏎'s
 * printable twin and `F` clears a filter the PRS subtitle is advertising.
 */
export function boardKeys(
  view: Pick<BoardView, "snapshot" | "boardFilter" | "selected" | "repo">,
): LiveKeys {
  const selected = visiblePrs(view)[view.selected] !== undefined;
  const bar: BarButton[] = [];
  if (selected) bar.push({ key: "\r", label: "⏎ pi pane" }, { key: "m", label: "m message" });
  if (selected && view.repo) bar.push({ key: "g", label: "g github" });
  bar.push({ key: "e", label: "e events" });
  if (selected) bar.push({ key: "u", label: "u unwedge" });
  // Setup is about the repo, not a PR — offered whatever is selected.
  bar.push({ key: "I", label: "I setup" });
  const inline: string[] = [];
  if (selected) inline.push("a");
  if (view.boardFilter != null) inline.push("F");
  return { bar, inline };
}

/** Rows the command bar takes on the board at this width — the one number
 * `renderBoard` and the App's pi-viewport arithmetic must agree on. */
export function boardBarHeight(
  view: Pick<BoardView, "snapshot" | "boardFilter" | "selected" | "repo">,
  cols: number,
): number {
  return barHeight("board", cols, boardKeys(view).bar);
}

/**
 * The live pi mirror owns the bottom half of the board. Two rows are chrome
 * (divider + header), the rest is session tail.
 * Floors at 6 rows and never squeezes the list/detail body below 3.
 */
export function piRows(rows: number, barRows: number): number {
  const usable = rows - 2 - barRows; // top bar + command bar + bottom border
  return Math.max(0, Math.min(Math.max(6, Math.floor(usable * 0.5)), usable - 3));
}

/**
 * The exact terminal geometry the mirrored pi session should have — the
 * rectangle `renderBoard` paints its capture into, and nothing more.
 *
 * One source of truth on purpose, shared with the paint below: if these numbers
 * drift, pi lays itself out for a terminal of a different size than the one its
 * output is rendered in, which is the bug this exists to stop. Two of the pane's
 * rows are chrome (divider + header); of the width, two cells are the board's
 * borders and one is the leading space each mirror row is painted with.
 */
export function piPaneSize(
  cols: number,
  rows: number,
  barRows: number,
): { cols: number; rows: number } | undefined {
  const lines = piRows(rows, barRows) - 2;
  const width = cols - 4;
  if (lines <= 0 || width <= 0) return undefined;
  return { cols: width, rows: lines };
}

/** Geometry of the floating EVENTS overlay: a centered band over the board,
 * bordered top and bottom, ~60% of the height, never under the bar. */
export function eventsOverlayBand(rows: number, barRows: number): { top: number; height: number } {
  const height = Math.max(5, Math.min(Math.floor(rows * 0.6), rows - 3 - barRows));
  return { top: Math.max(1, Math.floor((rows - height) / 2)), height };
}

// ---- pieces ----------------------------------------------------------------

/** The companion's alert badge as it sits in the top bar: tier color, today's
 * count, the latest title, and how many repeats folded into counters. */
export function alertSegment(badge: AlertBadge, focused: boolean): string {
  const latest = badge.latest;
  if (!latest) return "";
  const color = latest.tier === "alert" ? FG.anomaly : FG.accent;
  const glyph = latest.tier === "alert" ? "▲" : "•";
  const where = latest.pr !== null ? ` #${latest.pr}` : "";
  const folds = badge.folds > 0 ? ` +${badge.folds}` : "";
  const label = `${glyph} ${badge.count}${where} ${truncate(latest.title, 40)}${folds}${focused ? " ⏎ companion" : ""}`;
  return focused ? selectedLine(`${color}${label}${RESET}`) : `${color}${label}${RESET}`;
}

/** Short top-bar label per triage class — the long form lives in the list. */
const CONNECTION_LABEL: Record<ConnectionDiagnosis["kind"], string> = {
  ok: "ssh ok",
  local: "local",
  "no-agent-key": "no ssh key loaded",
  "wedged-master": "ssh master wedged",
  "host-unreachable": "host down",
  unknown: "cause unknown",
};

/**
 * What the board says where the PR list would be, when it has never had a
 * snapshot.
 *
 * The count is `?`, never `0` (an empty count reads as "the data is gone" when
 * the truth is "I could not ask"), the reason is named, and the remedy is a
 * command the operator can paste into their own shell.
 */
export function unknownSourceLines(conn: ConnectionDiagnosis | undefined, width: number): string[] {
  const lines = [
    `${FG.anomaly}the daemon has not answered yet${RESET}`,
    `${FG.dim}nothing below is a measurement — it is not known${RESET}`,
    "",
  ];
  if (conn && conn.kind !== "ok" && conn.kind !== "local") {
    for (const l of wrap(stripAnsi(conn.cause), width)) lines.push(`${FG.dim}${l}${RESET}`);
    if (conn.remedy !== "") {
      lines.push("");
      lines.push(`${STRONG}run this:${RESET}`);
      for (const l of wrap(conn.remedy, width)) lines.push(`${FG.accent}  ${l}${RESET}`);
      // The remedy is a shell command, and the operator is inside the alt
      // screen looking at it. For the one class `s` can clear in place — a key
      // that is simply not loaded — say so here rather than leaving it to the
      // `?` key map: otherwise the honest answer reads as "quit the TUI first".
      if (conn.kind === "no-agent-key") {
        for (const l of wrap("…or press s to be prompted for the key passphrase here", width))
          lines.push(`${FG.dim}${l}${RESET}`);
      }
    }
  } else if (!conn) {
    lines.push(`${FG.dim}checking the connection…${RESET}`);
  }
  // Bring-up progress is not painted here: the companion column is on every
  // frame and carries it (sidebar.ts `startup`).
  lines.push("");
  lines.push(`${FG.dim}s re-checks the connection · r refreshes${RESET}`);
  return lines.map((l) => truncate(l, width));
}

/** The detail pane's twin of the above: never "no PR selected" (which implies
 * there were PRs to select from) when the list itself is unknown. */
export function unknownDetailLines(conn: ConnectionDiagnosis | undefined, width: number): string[] {
  const lines = [
    `${STRONG}no data${RESET}`,
    `${FG.dim}the TUI has not been able to read status.json${RESET}`,
  ];
  if (conn?.detail) {
    lines.push("");
    for (const l of wrap(`ssh said: ${stripAnsi(conn.detail)}`, width))
      lines.push(`${FG.dim}${l}${RESET}`);
  }
  return lines.map((l) => truncate(l, width));
}

/**
 * The board's reviewer-memory banner, from status.json `memory` and nothing
 * else — never from OpenViking, which is the thing that may be down. The
 * memory tab [2] only shows what the TUI's own store can reach, so this is
 * where the daemon's view of memory health reaches a person.
 *
 *   `loud`  — down / refusing a key / degraded: painted right after the
 *             daemon health, where truncation reaches it last;
 *   `quiet` — not measured yet, not reported by this daemon, not monitored:
 *             a short dim mark at the end of the bar — honest, never healthy,
 *             and the first thing a narrow terminal drops;
 *   nothing — healthy, or no snapshot at all (the whole board already says
 *             it does not know).
 */
export function memorySegment(
  snapshot: StatusSnapshot | undefined,
  now: Date,
): { text: string; loud: boolean } | undefined {
  if (!snapshot) return undefined;
  const m = snapshot.memory;
  if (!m) return { text: `${FG.dim}mem ?${RESET}`, loud: false };
  if (!m.enabled) return { text: `${FG.dim}mem off${RESET}`, loud: false };
  const since = Date.parse(m.incident?.since ?? m.since);
  const age = Number.isFinite(since) ? ` ${fmtDuration(now.getTime() - since)}` : "";
  switch (m.state) {
    case "healthy":
      return undefined;
    case "unknown":
      return { text: `${FG.dim}mem ?${RESET}`, loud: false };
    case "degraded":
      return {
        // Memory that answers but cannot search says so.
        text: `${WARN}▲ MEMORY DEGRADED${age}${m.serving?.ok === false ? " · search not serving" : ""}${DRESET}`,
        loud: true,
      };
    case "down":
      return {
        text: `${FG.anomaly}⛔ MEMORY DOWN${age} · ${m.down_cause === "not_serving" ? "search not serving" : "no authenticated answer"}${RESET}`,
        loud: true,
      };
    case "auth_failed": {
      const d = m.credentials.daemon?.result;
      const sess = m.credentials.sessions?.result;
      const bad = (r: string | undefined): boolean => r === "auth_failed" || r === "no_key";
      const which =
        bad(d) && bad(sess)
          ? "both keys"
          : bad(d)
            ? "daemon key"
            : bad(sess)
              ? "sessions' key"
              : "a key";
      return {
        text: `${FG.anomaly}⛔ MEMORY AUTH FAILED${age} · ${which} refused${RESET}`,
        loud: true,
      };
    }
  }
}

/**
 * The board's EOD-curation banner, from status.json
 * `memory.curation` alone: loud when the day's curation did not reach memory
 * — no receipt (`missing`), or a lesson refused or not found
 * (`not_persisted`). Both are also overseer wakes; this is the half a person
 * sees, beside the memory banner. A block the daemon could not read (`null`)
 * is a dim `curation ?` — honest-unknown: painting nothing would read the
 * same as a quiet day, which `qcr status` and the companion's view both call
 * unknown. Nothing for a daemon that reports no block (`undefined`: memory
 * off, or an older daemon), and a quiet day is quiet.
 */
export function curationSegment(snapshot: StatusSnapshot | undefined): string | undefined {
  const c = snapshot?.memory?.curation;
  if (c === null && snapshot?.memory) return `${FG.dim}curation ?${RESET}`;
  if (!curationNeedsAttention(c) || !c) return undefined;
  return c.state === "missing"
    ? `${FG.anomaly}⛔ EOD CURATION MISSING ${c.day ?? "?"} · ${c.offered} candidate${c.offered === 1 ? "" : "s"}, no receipt${earlierPhrase(c)}${RESET}`
    : `${FG.anomaly}⛔ LESSONS NOT PERSISTED ${c.day ?? "?"} · ${c.not_persisted}${earlierPhrase(c)}${RESET}`;
}

/**
 * The board's archive banner (docs/archiving.md §11), from
 * status.json `archive` alone, through its total reader: loud only for what
 * needs a person (`archiveAttention`) — held for disk, a restore that failed,
 * a reopened PR no tick or birth will restore (mode not `on`: its archived
 * receipts read unknown until `qcr archive restore`), or repeated verify
 * failures. A block this build cannot read is a dim `archive ?`, never
 * silence; nothing for a daemon that reports no block, and a quiet archiver
 * is quiet.
 */
export function archiveSegment(snapshot: StatusSnapshot | undefined): string | undefined {
  if (!snapshot) return undefined;
  const r = readArchiveStatus(snapshot.archive);
  if (r.kind === "absent") return undefined;
  if (r.kind === "unreadable") return `${FG.dim}archive ?${RESET}`;
  const parts = archiveAttention(r.view);
  return parts.length > 0 ? `${FG.anomaly}⛔ ARCHIVE ${parts.join(" · ")}${RESET}` : undefined;
}

/**
 * The board's event-loop banner, from status.json `daemon` and nothing else:
 * the daemon measuring its own loop, so a stalled loop (an unanswered /health)
 * is visible on the board.
 *
 *   `loud`  — stalled: painted beside the memory banner, with the cause the
 *             evidence names (the loop itself blocked / CPU starved /
 *             cause unknown);
 *   `quiet` — not measured yet, not reported by this daemon (an older one),
 *             or a block this build cannot read whole (a newer daemon's state,
 *             a missing field): a short dim `loop ?` at the end of the bar —
 *             honest, never ok;
 *   nothing — ok, or no snapshot at all.
 *
 * The block is parsed JSON, read through `readDaemonLoad`: nothing in it can
 * throw out of a paint.
 */
export function eventLoopSegment(
  snapshot: StatusSnapshot | undefined,
): { text: string; loud: boolean } | undefined {
  if (!snapshot) return undefined;
  const r = readDaemonLoad(snapshot.daemon);
  if (r.kind !== "read" || r.view.event_loop.state === "unknown")
    return { text: `${FG.dim}loop ?${RESET}`, loud: false };
  if (r.view.event_loop.state === "ok") return undefined;
  return { text: `${FG.anomaly}⛔ ${stallShortPhrase(snapshot.daemon)}${RESET}`, loud: true };
}

/** Top-bar segments, left to right — shared by the renderer and the hit-test
 * geometry so the alert click zone can never drift from the text. */
function barSegments(view: BoardView, alerts: boolean): string[] {
  const mode = modeBadge(view.dryRun);
  let health: string;
  switch (view.health.kind) {
    case "ok":
      health = `${FG.approve}●${RESET} daemon ok (hb ${view.health.heartbeatAgeS}s)`;
      break;
    case "pipeline_unhealthy":
      health = `${FG.anomaly}⛔ daemon alive · PIPELINE FAILED · ${view.health.causes.length} (hb ${view.health.heartbeatAgeS}s)${RESET}`;
      break;
    case "stale":
      health = `${WARN}▲ DATA STALE (${view.health.dataAgeS}s)${DRESET}`;
      break;
    case "unreachable":
      health = `${FG.anomaly}✖ unreachable${view.connection ? ` · ${CONNECTION_LABEL[view.connection.kind]}` : ""}${RESET}`;
      break;
  }
  const s = view.snapshot;
  const rounds = s ? `rounds ${s.running_rounds}/${s.max_concurrent_rounds ?? "?"}` : "";
  const spend = s?.today_spend_usd !== undefined ? `today $${s.today_spend_usd.toFixed(2)}` : "";
  // Deploy-window drain: while the daemon drains, the bar says so loudly,
  // with how many rounds still have to finish before a deploy is safe and how
  // many webhook deliveries were dropped so far — and by whom, and when it
  // lapses: an operator's drain holds until lifted, a session's always has an
  // expiry. An older daemon that reports neither is shown as such rather than
  // guessed at.
  const drainSeg = s?.draining
    ? `${FG.anomaly}⛔ DRAINING — ${s.running_rounds} round${s.running_rounds === 1 ? "" : "s"} finishing · ${s.drain_failed_loud ?? 0} failed loud · ${s.drained_deliveries ?? 0} dropped · ${leverHolderLabel(s.draining_by, s.draining_until)}${RESET}`
    : "";
  const td = s?.thread_decisions;
  const breakerSeg =
    td && (td.breaker_state !== "closed" || td.failed > 0)
      ? `${FG.anomaly}⛔ THREAD RETRY ${td.breaker_state.toUpperCase()}${td.open_until ? ` until ${td.open_until.slice(11, 19)}Z` : ""} · ${td.pending} pending · ${td.failed} failed${RESET}`
      : "";
  const badge = alerts && view.alerts ? alertSegment(view.alerts, view.alertFocus === true) : "";
  const mem = memorySegment(s, view.now ?? new Date());
  const curation = curationSegment(s) ?? "";
  const archive = archiveSegment(s) ?? "";
  const loop = eventLoopSegment(s);
  return [
    `${HEADING}quickreview${DRESET}`,
    mode,
    health,
    mem?.loud ? mem.text : "",
    loop?.loud ? loop.text : "",
    curation,
    archive,
    drainSeg,
    breakerSeg,
    rounds,
    spend,
    badge,
    // Only when `alerts` — the hit-test geometry measures the segments BEFORE
    // the badge, and a quiet mark sits after it.
    alerts && mem && !mem.loud ? mem.text : "",
    alerts && loop && !loop.loud ? loop.text : "",
  ].filter((x) => x !== "");
}

export function topBar(view: BoardView, cols: number): string {
  return rule(cols, "┌", "┐", barSegments(view, true));
}

/**
 * 1-based screen columns of the alert badge inside the top bar, or undefined
 * when there is no badge. Derived from the same segment list `topBar` renders:
 * `rule` lays out `border + " " + segments.join(" ── ") + " "`, so the badge
 * starts one column past the border, the leading space, and every earlier
 * segment.
 */
export function alertZone(view: BoardView, cols: number): { x1: number; x2: number } | undefined {
  if (!view.alerts?.latest) return undefined;
  const before = barSegments(view, false);
  const prefix = before.length > 0 ? `${before.join(" ── ")} ── ` : "";
  const x1 = 3 + displayWidth(stripAnsi(prefix));
  const width = displayWidth(stripAnsi(alertSegment(view.alerts, view.alertFocus === true)));
  if (x1 >= cols) return undefined; // truncated away on a narrow terminal
  return { x1, x2: Math.min(cols - 1, x1 + width - 1) };
}

function styledRow(
  pr: SnapshotPr,
  selected: boolean,
  width: number,
  now: Date,
  repo: string | undefined,
): string {
  const color = stateColor(pr.stale_recheck ? "reviewing" : pr.state);
  const chip = rowChip(pr);
  const rounds = pr.rounds ? `${FG.dim}r${pr.rounds}${RESET}` : "";
  const paused = pr.paused ? `${WARN}${pauseChip(pr)}${DRESET}` : "";
  const head = `${color}${glyphFor(pr)} ${STRONG}#${pr.number}${RESET}`;
  const meta = [
    `${FG.author}${pr.author ?? ""}${RESET}`,
    `${FG.dim}${fmtAge(pr.updated_at, now)}${RESET}`,
    rounds,
    chip,
    paused,
  ]
    .filter((s) => stripAnsi(s) !== "")
    .join(" ");
  const used = displayWidth(`${stripAnsi(head)} ${stripAnsi(meta)} `);
  const title = truncate(rowTitle(pr), Math.max(4, width - used - 1));
  const numLinked = repo
    ? `${color}${glyphFor(pr)} ${STRONG}${osc8(prUrl(repo, pr.number), `#${pr.number}`)}${RESET}`
    : head;
  const body = `${numLinked} ${meta} ${title}`;
  const pad = " ".repeat(Math.max(0, width - displayWidth(body) - 1));
  return selected ? selectedLine(` ${body}${pad}`) : ` ${body}${pad}`;
}

const VERDICT_ABBREV: Record<string, string> = {
  REQUEST_CHANGES: "RC",
  APPROVE: "APPROVE",
  COMMENT: "COMMENT",
};

function section(title: string, subtitle: string): string {
  return sectionTitle(title, subtitle);
}

function durationLabel(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60 > 0 ? ` ${minutes % 60}m` : ""}`;
}

function oneLine(value: string): string {
  return sanitizeText(value).replace(/\s+/g, " ").trim();
}

type CurrentRound = Pick<
  WhyPayload["rounds"][number],
  "round_no" | "status" | "started_at" | "deadline_at" | "lenses" | "validate_tier"
> & {
  command_id?: string;
  command_sha256?: string;
  head_sha?: string;
  stage_deadlines?: {
    first_pass_start: string;
    passes_complete: string;
    running_hard_bound: string;
  };
};

function currentProgressLines(
  round: CurrentRound,
  progress: RoundProgressSnapshot | undefined,
  width: number,
  now: Date,
): string[] {
  const lines: string[] = [];
  const started = Date.parse(round.started_at);
  const deadline = round.deadline_at ? Date.parse(round.deadline_at) : Number.NaN;
  const nowMs = now.getTime();
  const elapsed = Number.isFinite(started) ? durationLabel(nowMs - started) : "?";
  const deadlineText = Number.isFinite(deadline)
    ? deadline >= nowMs
      ? `${durationLabel(deadline - nowMs)} left`
      : `${durationLabel(nowMs - deadline)} OVERDUE`
    : "deadline unavailable";
  lines.push(
    truncate(
      section("CURRENT REVIEW", `round ${round.round_no} · ${elapsed} elapsed · ${deadlineText}`),
      width,
    ),
  );

  // A sticky session may process neighboring wakes at nearly identical times.
  // Only the exact durable delivery + prompt-derived round/head identity may
  // paint this round; timestamp proximity is not identity.
  const current =
    progress?.version === 2 &&
    round.command_id !== undefined &&
    progress.command_id === round.command_id &&
    round.command_sha256 !== undefined &&
    progress.command_sha256 === round.command_sha256 &&
    round.head_sha !== undefined &&
    progress.head_sha === round.head_sha &&
    progress.round_no === round.round_no
      ? progress
      : undefined;
  const planned = round.lenses
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  // The validator runs at its own tier, shown beside its row.
  const tierOf = (name: string): string =>
    name === "pass-validate" && round.validate_tier ? ` · ${round.validate_tier}` : "";

  if (!current) {
    lines.push(truncate(`  ${FG.dim}? parent · live progress unavailable${RESET}`, width));
    for (const name of planned) {
      lines.push(truncate(`  ${FG.dim}? ${name} · unknown${tierOf(name)}${RESET}`, width));
    }
    lines.push(truncate(`  ${FG.dim}? final verdict · unknown${RESET}`, width));
    return lines;
  }

  const signalAge = Math.max(0, nowMs - Date.parse(current.updated_at));
  const signal =
    signalAge >= 60_000
      ? `SILENT ${durationLabel(signalAge)}`
      : `signal ${durationLabel(signalAge)} ago`;
  const parentColor =
    signalAge >= 120_000 ? FG.anomaly : current.parent_status === "active" ? FG.accent : FG.dim;
  const active = current.active_tool ? ` · ${oneLine(current.active_tool)}` : "";
  const stage = roundExecutionStage(current, planned);
  const stageDeadline =
    stage === "accepted" || stage === "preparing"
      ? round.stage_deadlines?.first_pass_start
      : stage === "fanout-started"
        ? round.stage_deadlines?.passes_complete
        : undefined;
  const due = stageDeadline
    ? ` · stage ${Date.parse(stageDeadline) >= nowMs ? `due in ${durationLabel(Date.parse(stageDeadline) - nowMs)}` : `OVERDUE ${durationLabel(nowMs - Date.parse(stageDeadline))}`}`
    : "";
  lines.push(
    truncate(
      `  ${parentColor}parent ${current.parent_status.toUpperCase()} · ${stage}${due} · ${signal}${active}${RESET}`,
      width,
    ),
  );

  const agentLine = (name: string, agent: LiveAgentProgress | undefined): string => {
    const tier = tierOf(name);
    if (!agent) return `  ${FG.dim}○ ${name} · pending${tier}${RESET}`;
    if (agent.status === "running") {
      const tool = agent.current_tool ? ` · ${oneLine(agent.current_tool)}` : "";
      return `  ${FG.accent}⟳ ${name} · running ${durationLabel(agent.duration_ms)}${tool}${RESET}`;
    }
    if (agent.status === "failed") {
      const error = agent.error ? ` · ${oneLine(agent.error)}` : "";
      return `  ${FG.anomaly}✗ ${name} · failed after ${durationLabel(agent.duration_ms)}${error}${RESET}`;
    }
    return `  ${FG.approve}✓ ${name} · done in ${durationLabel(agent.duration_ms)} · ${agent.tool_count} tools${tier}${RESET}`;
  };
  // Every execution of a planned lens is shown — a lens run twice (two task
  // rows) never hides a running or failed sibling behind a finished one.
  const runs = new Map<string, LiveAgentProgress[]>();
  for (const agent of current.agents) {
    const name = lensForAgent(agent.agent);
    runs.set(name, [...(runs.get(name) ?? []), agent]);
  }
  for (const name of new Set(planned)) {
    const executions = runs.get(name) ?? [];
    const rows = Math.max(planned.filter((p) => p === name).length, executions.length);
    for (let i = 0; i < rows; i++) lines.push(truncate(agentLine(name, executions[i]), width));
  }
  // The parent may justify and add a lens outside the dispatch plan. Those
  // agents are real work too; omitting them would make "all agents" false.
  for (const agent of current.agents.filter(
    (item) => !planned.includes(lensForAgent(item.agent)),
  )) {
    const rendered = agentLine(agent.agent, agent).replace(`${RESET}`, ` · added${RESET}`);
    lines.push(truncate(rendered, width));
  }
  lines.push(truncate(`  ${FG.dim}○ final verdict · pending${RESET}`, width));
  const activityAge = Math.max(0, nowMs - Date.parse(current.last_activity_at));
  lines.push(
    truncate(
      `  ${FG.dim}last activity ${durationLabel(activityAge)} ago · ${oneLine(current.last_activity)}${RESET}`,
      width,
    ),
  );
  if (signalAge >= 120_000) {
    lines.push(
      truncate(
        `  ${FG.anomaly}⚠ no live signal for ${durationLabel(signalAge)} — inspect raw PI below${RESET}`,
        width,
      ),
    );
  }
  return lines;
}

/** Doubted findings shown before the "… N more" line. */
const DOUBTED_SHOWN = 8;

/**
 * The DOUBTED section: findings the validator could not stand behind
 * — kept in the findings record as "may not be valid", never posted on the PR,
 * and put here for the operator to judge. Newest round first. Nothing renders
 * when there are none, or when an older daemon did not report the field.
 */
export function doubtedLines(
  doubted: WhyPayload["doubted"],
  width: number,
  title = "DOUBTED",
  note = "may not be valid · kept, never posted",
): string[] {
  if (!doubted || doubted.length === 0) return [];
  const lines = [truncate(section(title, note), width)];
  const newest = [...doubted].sort((a, b) => b.round_no - a.round_no);
  for (const f of newest.slice(0, DOUBTED_SHOWN)) {
    const at = f.path ? ` ${sanitizeText(f.path)}${f.line !== null ? `:${f.line}` : ""}` : "";
    const sev = f.severity ? ` · ${sanitizeText(f.severity)}` : "";
    const word = f.word ? ` · ${sanitizeText(f.word)}` : "";
    const why = f.reason ? ` — ${oneLine(f.reason)}` : "";
    lines.push(
      truncate(
        `  ${WARN}? r${f.round_no} ${sanitizeText(f.lens)}${at}${sev}${word}${DRESET}${FG.dim}${why}${RESET}`,
        width,
      ),
    );
  }
  if (newest.length > DOUBTED_SHOWN)
    lines.push(`${FG.dim}  … ${newest.length - DOUBTED_SHOWN} more (qcr why <pr> --json)${RESET}`);
  return lines;
}

export function detailLines(
  detail: WhyPayload | undefined,
  pr: SnapshotPr | undefined,
  width: number,
  now: Date = new Date(0),
  progress?: RoundProgressSnapshot,
): string[] {
  const lines: string[] = [];
  if (!pr) return ["no PR selected"];
  lines.push(
    `${stateColor(pr.state)}${STRONG}#${pr.number}${RESET} ${STRONG}${truncate(sanitizeText(pr.title), width - 8 - String(pr.number).length)}${RESET}`,
  );
  const delivery = pr.current_round?.posting_delivery;
  if (delivery) {
    lines.push(
      truncate(
        `${FG.dim}POSTING PENDING · automatic retry · attempts ${delivery.attempts}${RESET}`,
        width,
      ),
    );
    lines.push(
      truncate(
        `next ${sanitizeText(delivery.next_attempt_at)}${delivery.last_error ? ` · ${oneLine(delivery.last_error)}` : ""}`,
        width,
      ),
    );
  }
  if (!detail || detail.pr !== pr.number) {
    lines.push(`${FG.dim}loading detail…${RESET}`);
    return lines;
  }
  const round =
    pr.current_round?.round_no ??
    (detail.rounds.length > 0 ? detail.rounds[detail.rounds.length - 1]?.round_no : undefined);
  const facts: string[] = [
    `${stateColor(detail.state ?? pr.state)}${detail.state ?? pr.state}${RESET}`,
  ];
  if (round !== undefined) facts.push(`round ${round}`);
  if (detail.author) facts.push(`by ${FG.author}${detail.author}${RESET}`);
  lines.push(truncate(facts.join(" · "), width));
  const trig = detail.trigger_ts ? `trig ${fmtAge(detail.trigger_ts, now)} ago` : "trig —";
  lines.push(
    truncate(
      `spend $${detail.spend_usd.toFixed(2)} · head ${(detail.head_sha ?? "").slice(0, 7)} · ${trig}`,
      width,
    ),
  );
  if (detail.labels && detail.labels.length > 0) {
    lines.push(
      truncate(
        detail.labels.map((l) => `${FG.accent}[${sanitizeText(l)}]${RESET}`).join(" "),
        width,
      ),
    );
  }
  if (pr.paused) {
    // A held PR says who holds it and when the hold lapses.
    const hold = pr.pause;
    const why = hold?.reason ? ` · ${oneLine(sanitizeText(hold.reason))}` : "";
    lines.push(
      truncate(
        `${WARN}${STRONG}PAUSED${DRESET}${WARN} · ${leverHolderLabel(hold?.issuer, hold?.expires_at ?? undefined)}${why}${DRESET}`,
        width,
      ),
    );
  }
  if (pr.review_failure) {
    const command = pr.review_failure.command_id ? ` · ${pr.review_failure.command_id}` : "";
    const round =
      pr.review_failure.round_no !== null ? ` · round ${pr.review_failure.round_no}` : "";
    lines.push(
      truncate(
        `${FG.anomaly}${STRONG}FAILED_LOUD${RESET}${FG.anomaly} · ${pr.review_failure.stage}${command}${round} · attempt ${pr.review_failure.attempts}/${pr.review_failure.retry_cap} · ${fmtAge(pr.review_failure.failed_at, now)} old${RESET}`,
        width,
      ),
    );
    const retry =
      pr.review_failure.next_action === "retry_wait" && pr.review_failure.next_retry_at
        ? `auto retry ${pr.review_failure.next_retry_at.slice(11, 16)}Z · epoch ${pr.review_failure.retry_epoch} · u now`
        : "press u to recover";
    lines.push(
      truncate(`${FG.anomaly}${oneLine(pr.review_failure.detail)} · ${retry}${RESET}`, width),
    );
  }
  lines.push(`${FG.dim}${"─".repeat(Math.max(0, width))}${RESET}`);
  // status.json advances every poll and therefore owns current timing/plan;
  // `why` is enriched and deliberately cached, so it is only the fallback for
  // an older daemon that has not shipped current_round yet — and only while
  // the snapshot says a round is under way: a cached `running` row outlives
  // the round it describes until the next read lands.
  const runningRound =
    pr.current_round ??
    (pr.state === "reviewing"
      ? [...detail.rounds].reverse().find((r) => r.status === "running")
      : undefined);
  if (runningRound) lines.push(...currentProgressLines(runningRound, progress, width, now));
  const lastSummary = [...detail.rounds]
    .reverse()
    .find((r) => r.summary && r.summary.trim().length > 0)?.summary;
  if (lastSummary) {
    lines.push(truncate(section("NOW", "the session's own 3-4 sentence read"), width));
    for (const l of wrap(sanitizeText(lastSummary).trim(), width)) lines.push(l);
  }
  if (detail.description !== undefined) {
    lines.push(truncate(section("DESCRIPTION", "the PR body"), width));
    const raw = sanitizeText(detail.description).trim();
    const desc = raw.length > 0 ? wrap(raw, width) : ["(empty)"];
    for (const l of desc.slice(0, 12)) lines.push(l);
    if (desc.length > 12)
      lines.push(`${FG.dim}… ${desc.length - 12} more lines (open on GitHub with g)${RESET}`);
  }
  lines.push(truncate(section("LEDGER", "findings the conversation tracks"), width));
  if (detail.ledger) {
    for (const l of sanitizeText(detail.ledger).split("\n")) {
      const t = l.trim();
      if (t.length > 0) for (const wl of wrap(t, width)) lines.push(wl);
    }
  } else {
    lines.push(
      truncate(`${FG.dim}none yet — the live ledger is pinned in the session${RESET}`, width),
    );
  }
  // A cancelled round carries its own glyph, distinct from any other
  // verdictless round, and the one loud cause — a round that stopped dead
  // inside its deadline — is the only one that gets a color; a redeploy orphan
  // stays dim on purpose.
  const roundsBits = detail.rounds.map((r) => {
    const cancelled = r.status === "cancelled";
    const loud = cancelled && isLoudCancelCause(r.cancel_cause);
    const v = r.verdict
      ? (VERDICT_ABBREV[r.verdict] ?? r.verdict)
      : cancelled
        ? "✕"
        : r.status === "running"
          ? "…"
          : "—";
    const color = loud
      ? FG.anomaly
      : r.verdict === "APPROVE"
        ? FG.approve
        : r.verdict === "REQUEST_CHANGES"
          ? FG.request_changes
          : FG.dim;
    return `r${r.round_no} ${color}${v}${RESET}`;
  });
  lines.push(
    truncate(
      `${section("ROUNDS", "review rounds + verdicts")}  ${roundsBits.join(" · ") || "—"}`,
      width,
    ),
  );
  for (const r of detail.rounds) {
    if (r.status !== "cancelled") continue;
    const loud = isLoudCancelCause(r.cancel_cause);
    lines.push(
      truncate(
        `  ${loud ? FG.anomaly : FG.dim}✕ r${r.round_no} cancelled — ${cancelCauseLabel(r.cancel_cause)}${RESET}`,
        width,
      ),
    );
  }
  lines.push(...doubtedLines(detail.doubted, width));
  // The profile's `[posting]` policy: survivors kept off the PR, same grammar.
  lines.push(
    ...doubtedLines(
      detail.withheld,
      width,
      "WITHHELD",
      "over the posting policy · kept, never posted",
    ),
  );
  lines.push(
    truncate(`${section("THREADS", "bot review threads")} ${detail.threads.total} known`, width),
  );
  if (detail.comments && detail.comments.length > 0) {
    lines.push(truncate(section("COMMENTS", "latest PR conversation"), width));
    for (const c of detail.comments) {
      lines.push(
        truncate(
          `${FG.author}${c.author}${RESET} ${FG.dim}${fmtAge(c.created_at, now)} ago${RESET}`,
          width,
        ),
      );
      const body = sanitizeText(c.body)
        .split("\n")
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
        .join(" ");
      const bodyLines = wrap(body, Math.max(8, width - 2));
      for (const bl of bodyLines.slice(0, 2)) lines.push(`  ${bl}`);
      if (bodyLines.length > 2) lines.push(`  ${FG.dim}…${RESET}`);
    }
  }
  return lines;
}

/**
 * The `?` overlay. Pinned against docs/tui.md (tests/tui-surfaces.test.ts):
 * every key named here is in some surface's vocabulary, and every surface
 * the doc lists is named here. The bar shows what the current frame answers
 * to; this is the whole map.
 */
export const HELP_LINES = [
  "1…8            the eight surfaces: board · memory · digest · tickets · deploy · metrics · feedback · scan",
  "               the bar at the foot shows what THIS frame answers to; a button that is not there is a key that would do nothing",
  "r / s / ? / q  refresh · reconnect VM ssh (the one ssh key-passphrase prompt) · this overlay · quit (asks first)",
  "Ctrl-c ×3      kill the TUI from anywhere (terminal restored) — the un-stuck hatch",
  "               an alert in the top bar: click it or ⏎ to open the companion",
  "the companion column down the right edge is on every tab:",
  "               type any key no tab claims (or /) — it is a terminal, every byte reaches pi; Ctrl-q releases",
  "               wheel over the column (or PgUp/PgDn while focused) walks its scrollback · drag its left edge to resize",
  "               the column is always there at full width — nothing in the TUI collapses it or goes full-screen",
  "[1] board — the verbs act on the SELECTED PR, so they exist only while one is selected, and only here:",
  "j/k ↓/↑        select PR (mouse: click a row; click again to focus its pi pane)",
  "⏎ / a          focus the selected PR's pi pane (embedded, below the list; Ctrl-q back) — it is a live terminal, not a picture",
  "g              open the PR on GitHub (PR numbers are Ctrl+clickable links)",
  "m              quick-message the selected PR's session",
  "u              unwedge: cancel the running round and re-queue it (nothing posted, no GitHub write)",
  "e              events overlay (j/k scroll, e/Esc close; click an event → its PR)",
  "F              clear the board filter the PRS title is advertising",
  "I              set up the repo: the companion runs its setup skill (survey, interview, the repo profile)",
  "[2] memory — the store, newest first, grouped by day:",
  "j/k · [ / ]    select an entry · jump to the older / newer day",
  "e / p / x / n  edit · pin or unpin · retire (x twice) · new #manual entry — painted beside the selected entry",
  "W / F          open OpenViking Studio through the memory forward · clear the tag filter",
  "[3] digest — the EOD sweep's document: j/k scroll · [ / ] older / newer day",
  "[4] tickets — what adjudication filed on the tracker: j/k choose · [ / ] scroll the body · c actionable ⇄ all",
  "[5] deploy — D D deploys (or click ▶ DEPLOY TO VM) · S S powers the VM app · x aborts a run / closes its log",
  "[6] metrics — w / m / a switch the 7d / 30d / all window · # <pr> ⏎ opens a PR timeline (Esc back)",
  "[7] feedback — the loop on one surface: signal → adjudication → proposal → change → revert",
  "t              focus the next pane: inbox → proposed → changed",
  "a              show / hide archived (acted-on) signals",
  "A / x          accept / reject the focused rubric proposal (accept applies + auto-ratifies + commits locally)",
  "R then y       arm and confirm a revert of the focused change — a local commit only, never pushed",
  "[8] scan — the whole-repo scan: units left, the unit's findings by validity tier (confirmed first; style grouped per rule) over the detail, the run on top:",
  "[ / ] · j/k    previous / next unit · select a finding",
  "p / d          promote (the companion files one ticket each; unconfirmed ones need an explicit yes) · dismiss with a reason (it becomes reviewer memory)",
  "f / F · t      filter by state, lens, severity, tier, doubted · clear it · step the tier filter (confirmed → likely → doubtful → unknown)",
  "P              the stage 2 plan: space toggles a row, ⏎ approves (hard stop = the kept total), Esc back",
  "x / D          stop the running scan (the ledger resumes it) · ask the companion for a delta re-scan (it shows the price first)",
  "Ctrl-q         release a focused pi pane or the companion column back to the board",
  "",
  "any key to close",
];

// ---- live pi pane ----------------------------------------------------------

/**
 * Header of the pane: which session, whether it is live, whether it currently
 * owns the keyboard, and how far back in scrollback it is parked.
 */
export function piHeader(
  pr: number | undefined,
  pane: PiPaneView | undefined,
  focused = false,
): string {
  if (pr === undefined) return `${FG.dim}PI — no PR selected${RESET}`;
  const name = focused
    ? `${ACCENT_BG}PI pr-${pr}${DRESET}`
    : `${MUTED}PI ${DRESET}${ACCENT}pr-${pr}${DRESET}`;
  const mine = pane && pane.pr === pr ? pane : undefined;
  if (!mine) return `${name}${FG.dim} · connecting…${RESET}`;
  if (mine.missing) {
    return `${name}${FG.dim} · no pi session for #${pr}${mine.stale ? " · (stale)" : ""}${RESET}`;
  }
  const scroll =
    mine.offset > 0
      ? `${FG.accent} · ↑ ${mine.offset} lines back${RESET}${FG.dim} · End live${RESET}`
      : "";
  const mode = focused
    ? `${FG.accent} · focused${RESET}${FG.dim} · Ctrl-q back to board${RESET}`
    : `${FG.dim} · live mirror · click to type${RESET}`;
  return `${name}${mode}${scroll}`;
}

/** The window of the capture that fits the region, already width-clamped.
 * `pane.offset` parks the window that many lines above the live tail. */
export function piBody(
  pr: number | undefined,
  pane: PiPaneView | undefined,
  width: number,
  height: number,
): string[] {
  if (pr === undefined || height <= 0) return [];
  const mine = pane && pane.pr === pr ? pane : undefined;
  if (!mine) return [`${FG.dim}waiting for the first capture…${RESET}`];
  if (mine.lines.length === 0) return mine.missing ? [] : [`${FG.dim}(pane empty)${RESET}`];
  // Bottom-anchored, like the terminal it mirrors: new output lands on a
  // stable edge instead of shifting the whole pane down. A scrollback offset
  // moves that edge up through the captured history.
  const src =
    mine.offset > 0
      ? mine.lines.slice(0, Math.max(0, mine.lines.length - mine.offset))
      : mine.lines;
  const tail = src.slice(-height).map((l) => truncate(l, width));
  return [...new Array<string>(Math.max(0, height - tail.length)).fill(""), ...tail];
}

// ---- events overlay ---------------------------------------------------------

/** The demoted EVENTS strip: a floating, scrollable band over the board. */
function renderEventsOverlay(
  frame: Frame,
  view: BoardView,
  cols: number,
  rows: number,
  barRows: number,
): void {
  const { top, height } = eventsOverlayBand(rows, barRows);
  const visible = Math.max(0, height - 2);
  // The band is opaque: whatever it paints over must not stay clickable
  // underneath it (a hidden PR row, the pi pane's focus zone). Zones are
  // clipped to the rows the band leaves visible; only event rows below are
  // declared in its place.
  const bandY1 = top + 1; // frame row → terminal y
  const bandY2 = top + height;
  frame.zones = frame.zones.flatMap((z) => {
    if (z.y2 < bandY1 || z.y1 > bandY2) return [z];
    const kept: typeof frame.zones = [];
    if (z.y1 < bandY1) kept.push({ ...z, y2: bandY1 - 1 });
    if (z.y2 > bandY2) kept.push({ ...z, y1: bandY2 + 1 });
    return kept;
  });
  frame.set(
    top,
    rule(cols, "├", "┤", [
      sectionTitle("EVENTS"),
      `${MUTED}what the daemon just did${DRESET}`,
      `${MUTED}j/k scroll · e/Esc close${DRESET}`,
    ]),
  );
  const slice = view.events.slice(view.eventsScroll, view.eventsScroll + visible);
  for (let i = 0; i < visible; i++) {
    const e = slice[i];
    const text = e
      ? e.anomaly
        ? `${FG.anomaly}${truncate(e.text, cols - 4)}${RESET}`
        : truncate(e.text, cols - 4)
      : "";
    frame.boxRow(top + 1 + i, [{ text: ` ${text}`, width: cols - 2 }]);
    const prMatch = e ? /#(\d+)/.exec(e.text) : null;
    if (prMatch) {
      frame.zones.push({
        x1: 2,
        y1: top + 1 + i + 1,
        x2: cols - 1,
        y2: top + 1 + i + 1,
        action: { t: "event-jump", pr: Number(prMatch[1]) } satisfies BoardAction,
      });
    }
  }
  frame.set(top + height - 1, rule(cols, "├", "┤", []));
}

// ---- render ----------------------------------------------------------------

/**
 * The draft as one paintable line of at most `width` cells: control bytes
 * stripped, each newline shown as `⏎`, and — when it overflows — its END kept
 * behind a `…`, because the end is where the operator types (the `▁` cursor).
 */
function draftLine(text: string, width: number): string {
  const full = `${sanitizeText(text).replace(/\n/g, "⏎")}▁`;
  if (displayWidth(full) <= width) return full;
  const chars = Array.from(full);
  let tail = "";
  let w = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    const cw = charWidth(chars[i]!.codePointAt(0) ?? 0);
    if (w + cw > width - 1) break;
    tail = chars[i] + tail;
    w += cw;
  }
  return `…${tail}`;
}

/** The input box's three rows: its target, the text being typed, its keys. */
function inputBoxLines(box: NonNullable<BoardView["inputBox"]>, width: number): string[] {
  return [
    ` ${HEADING}MSG → ${oneLine(box.target)}${DRESET}`,
    ` > ${draftLine(box.text, Math.max(1, width - 3))}`,
    ` ⏎ send · Esc cancel · Alt-⏎ newline`,
  ];
}

/**
 * The input box over the foot of a tab's own screen — the board paints it in
 * its pi region, but a prompt a tab opens (a memory edit, a rejection reason)
 * types into the same box and must be seen on that tab: a divider and the
 * box's three rows, just above the frame's bottom border.
 */
export function overlayInputBox(frame: Frame, box: NonNullable<BoardView["inputBox"]>): void {
  const top = frame.rows - 5;
  if (top < 1) return;
  frame.set(top, `├${"─".repeat(Math.max(0, frame.cols - 2))}┤`);
  inputBoxLines(box, frame.cols - 2).forEach((text, i) =>
    frame.boxRow(top + 1 + i, [{ text, width: frame.cols - 2 }]),
  );
}

export function renderBoard(view: BoardView, cols: number, rows: number): Frame {
  const frame = new Frame(cols, rows);
  const now = view.now ?? new Date();
  frame.set(0, topBar(view, cols));
  const az = alertZone(view, cols);
  if (az)
    frame.zones.push({
      x1: az.x1,
      y1: 1,
      x2: az.x2,
      y2: 1,
      action: { t: "companion" } satisfies BoardAction,
    });
  const live = boardKeys(view);
  const barRows = barHeight("board", cols, live.bar);
  const pRows = piRows(rows, barRows);
  const bodyRows = rows - 2 - barRows - pRows; // top bar + command bar + bottom border
  const sorted = visiblePrs(view);
  const listW = listWidth(sorted, cols, now);
  const detailW = cols - 2 - listW - 1;
  const selectedPr = sorted[view.selected];
  frame.meta = { listW, bodyRows, piTop: 1 + bodyRows, piRows: pRows };

  if (view.help) {
    frame.boxRow(1, [
      { text: ` ${sectionTitle("KEYS", "everything the TUI answers to")}`, width: cols - 2 },
    ]);
    HELP_LINES.forEach((l, i) => {
      if (2 + i < rows - 1) frame.boxRow(2 + i, [{ text: `   ${l}`, width: cols - 2 }]);
    });
    for (let r = 2 + HELP_LINES.length; r < rows - 1; r++)
      frame.boxRow(r, [{ text: "", width: cols - 2 }]);
    frame.set(rows - 1, rule(cols, "└", "┘", []));
    return frame;
  }

  // Board body: list | detail.
  //
  // A snapshot that never arrived is unknown, not empty. The count
  // reads `?`, the rows are replaced by the reason and the remedy, and the
  // detail pane says "no data" rather than "no PR selected".
  const known = view.snapshot !== undefined;
  const flabel = filterLabel(view.boardFilter);
  const listLines: string[] = known
    ? [section(`PRS (${sorted.length})`, flabel !== "" ? flabel : "the daemon's live set")]
    : [
        section("PRS (?)", "unknown — the daemon has not answered"),
        ...unknownSourceLines(view.connection, listW - 1),
      ];
  // The list scrolls with the selection: the verbs act on the selected PR, so
  // it must never sit off-screen (`windowStart`, the tabs' shared rule). The
  // header stays put; the last body row is the legend, painted over whatever
  // would sit there, so the PR slots are the rows between the two.
  const prSlots = Math.max(1, bodyRows - 1 - listLines.length);
  const start = windowStart(view.selected, sorted.length, prSlots);
  sorted.slice(start, start + prSlots).forEach((pr, offset) => {
    const i = start + offset;
    listLines.push(styledRow(pr, i === view.selected, listW - 1, now, view.repo));
    const y = 1 + listLines.length - 1 + 1; // frame row of this PR line (below top bar)
    // Only painted rows get zones: with a long list, off-screen rows would
    // otherwise leave phantom click targets over the pi region and the
    // bar-row gaps — a click there could select (or double-click into the
    // pi pane of) an invisible PR. The slice above holds only painted rows,
    // but a body too short for even one slot must still declare nothing.
    if (listLines.length > bodyRows - 1) return;
    frame.zones.push({
      x1: 2,
      y1: y,
      x2: listW,
      y2: y,
      action: { t: "select-pr", pr: pr.number } satisfies BoardAction,
    });
    frame.zones.push({
      x1: 4,
      y1: y,
      x2: 4 + String(pr.number).length + 1,
      y2: y,
      action: { t: "open-github", pr: pr.number } satisfies BoardAction,
    });
  });
  const dLines = known
    ? detailLines(
        view.detail,
        selectedPr,
        detailW - 2,
        now,
        view.progress?.pr === selectedPr?.number ? view.progress : undefined,
      )
    : unknownDetailLines(view.connection, detailW - 2);
  for (let r = 0; r < bodyRows; r++) {
    const isLegendRow = r === bodyRows - 1;
    frame.boxRow(1 + r, [
      { text: isLegendRow ? ` ${legendLine()}` : ` ${listLines[r] ?? ""}`, width: listW },
      { text: ` ${dLines[r] ?? ""}`, width: detailW },
    ]);
  }

  // Live pi mirror (or the quick-message input box) — the lower region.
  const piTop = 1 + bodyRows;
  const piLines = Math.max(0, pRows - 2); // the region is divider + header + lines
  const panePr = view.piPr ?? selectedPr?.number;
  const piFocused = view.piFocus === true && panePr !== undefined;
  if (pRows > 0) {
    // Focused, the divider is drawn heavy and accented — the pane visibly
    // becomes its own window rather than a strip of the board.
    const bar = piFocused ? "━" : "─";
    const inner = `${fit(bar.repeat(listW), listW)}${piFocused ? bar : "┴"}${bar.repeat(detailW)}`;
    frame.set(piTop, `│${piFocused ? `${FG.accent}${inner}${RESET}` : inner}│`);
  }
  if (view.inputBox) {
    inputBoxLines(view.inputBox, cols - 2).forEach((text, i) =>
      frame.boxRow(piTop + 1 + i, [{ text, width: cols - 2 }]),
    );
    for (let i = 4; i <= piLines; i++) frame.boxRow(piTop + i, [{ text: "", width: cols - 2 }]);
  } else if (pRows > 0) {
    frame.boxRow(piTop + 1, [
      {
        text: ` ${piHeader(panePr, view.pi, piFocused)}${view.noticeLine ? `   ${view.noticeLine}` : ""}`,
        width: cols - 2,
      },
    ]);
    // Width comes from piPaneSize so the rectangle tmux is resized to and the
    // rectangle the capture is painted into cannot drift apart.
    const body = piBody(panePr, view.pi, piPaneSize(cols, rows, barRows)?.cols ?? 0, piLines);
    for (let i = 0; i < piLines; i++)
      frame.boxRow(piTop + 2 + i, [{ text: ` ${body[i] ?? ""}`, width: cols - 2 }]);
    // Clicking anywhere in the region (divider, header or body) gives the pane
    // the keyboard, in place — nothing on the board takes the whole terminal.
    if (panePr !== undefined) {
      frame.zones.push({
        x1: 2,
        y1: piTop + 1,
        x2: cols - 1,
        y2: piTop + pRows,
        action: { t: "pi-focus" } satisfies BoardAction,
      });
    }
  }

  // EVENTS: a floating overlay on `e`.
  if (view.eventsFocus) renderEventsOverlay(frame, view, cols, rows, barRows);

  // The shared command bar: exactly the verbs this frame answers to.
  paintCmdBar(frame, "board", cols, rows, live.bar);
  frame.set(rows - 1, rule(cols, "└", "┘", []));
  return frame;
}

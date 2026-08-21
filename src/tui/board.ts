// Board screen — the main-screen mockup, restyled per the 2026-08-14
// design grill: semantic truecolor everywhere, rich PR rows (author, last-tick
// age, rounds, verdict chip), colored glyph legend, section titles with
// subtitles, clickable zones for full mouse navigation, OSC-8 PR links.
// Pure: (view, cols, rows) → Frame (+ zones/meta for the input layer).
import type { WhyPayload } from "../cli.js";
import type { StatusSnapshot } from "../state.js";
import type { AlertBadge } from "./alerts.js";
import { paintCmdBar } from "./cmdbar.js";
import { filterLabel, visiblePrs, type BoardFilter } from "./filters.js";
import { formatEvent, glyphFor, type EventLine, type SnapshotPr } from "./model.js";
import { ACCENT, ACCENT_BG, HEADING, MUTED, OK, RESET as DRESET, STRONG, WARN, modeBadge, sectionTitle, selected as selectedLine } from "./design.js";
import { Frame, displayWidth, fit, rule, sanitizeText, stripAnsi, truncate, wrap } from "./paint.js";
import type { PiPaneView } from "./pipane.js";
import type { Health } from "./poll.js";
import { FG, RESET, fmtAge, legendLine, osc8, prUrl, stateColor, verdictChip } from "./theme.js";

/** Every clickable thing the board declares. */
export type BoardAction =
  | { t: "select-pr"; pr: number }
  | { t: "open-github"; pr: number }
  | { t: "event-jump"; pr: number }
  | { t: "pi-focus" } // the live pi pane: clicking it types into the session in place
  | { t: "tab"; tab: "board" | "digest" | "deploy" | "metrics" }
  | { t: "companion" } // the alert badge: open the companion attach
  | { t: "key"; key: string }; // hint-bar button → synthesized keypress

export interface BoardView {
  health: Health;
  dryRun: boolean;
  snapshot?: StatusSnapshot;
  events: EventLine[]; // newest first
  selected: number;
  detail?: WhyPayload;
  detailFull: boolean;
  /** The EVENTS overlay is open (and owns j/k) — `e` toggles it. */
  eventsFocus: boolean;
  eventsScroll: number;
  help: boolean;
  /**: the quit prompt is up. Painted by App over the composed frame,
   * so it covers every tab without any renderer knowing about it. */
  confirmQuit?: boolean;
  /** Live mirror of the selected PR's pi session (board's lower region). */
  pi?: PiPaneView;
  /** The PR the pane is showing. Defaults to the selection; while the pane is
   * focused it is LOCKED to the session being typed into, so a poll that
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
  /**: companion alert badge (count + latest, themed by tier). */
  alerts?: AlertBadge;
  /** A live `alert`-tier badge takes ⏎ until it is acknowledged (Esc) or
   * followed into the companion tab. */
  alertFocus?: boolean;
  /**: active board filter (companion `board_filter` verb; F clears).
   * Consumed through `visiblePrs` — never filter a sortPrs call directly. */
  boardFilter?: BoardFilter | null;
}

// ---- layout ----------------------------------------------------------------

function rowPlain(pr: SnapshotPr, now: Date): string {
  // "ESCALATE" still appears in rounds recorded before 2026-08-18.
  const chip =
    pr.last_verdict === "APPROVE"
      ? "✓A"
      : pr.last_verdict === "REQUEST_CHANGES"
        ? "✗RC"
        : pr.last_verdict === "NEEDS_HUMAN" || pr.last_verdict === "ESCALATE"
          ? "⚑H"
          : "";
  const rounds = pr.rounds ? `r${pr.rounds}` : "";
  return [glyphFor(pr), `#${pr.number}`, pr.author ?? "", fmtAge(pr.updated_at, now), rounds, chip, pr.title].filter((s) => s !== "").join(" ");
}

/** Left column sized to the longest PR row so titles aren't cropped while
 * the detail pane sits empty — clamped to 45% of the terminal. */
export function listWidth(prs: SnapshotPr[], cols: number, now: Date = new Date(0)): number {
  const widest = prs.reduce((w, pr) => Math.max(w, displayWidth(rowPlain(pr, now))), displayWidth(stripAnsi(legendLine())));
  return Math.min(Math.max(24, widest + 3), Math.floor(cols * 0.45));
}

/**
 * The live pi mirror owns the bottom half of the board — the region that used
 * to sit empty under a short PR list (and, before that, under the EVENTS
 * strip). Two rows are chrome (divider + header), the rest is session tail.
 * Floors at 6 rows and never squeezes the list/detail body below 3.
 */
export function piRows(rows: number): number {
  const usable = rows - 4; // top bar + command bar (2 rows) + bottom border
  return Math.max(0, Math.min(Math.max(6, Math.floor(usable * 0.5)), usable - 3));
}

/** Geometry of the floating EVENTS overlay: a centered band over the board,
 * bordered top and bottom, ~60% of the height. */
export function eventsOverlayBand(rows: number): { top: number; height: number } {
  const height = Math.max(5, Math.min(Math.floor(rows * 0.6), rows - 5)); // never under the 2-row bar
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

/** Top-bar segments, left to right — shared by the renderer and the hit-test
 * geometry so the alert click zone can never drift from the text. */
function barSegments(view: BoardView, alerts: boolean): string[] {
  const mode = modeBadge(view.dryRun);
  let health: string;
  switch (view.health.kind) {
    case "ok":
      health = `${FG.approve}●${RESET} daemon ok (hb ${view.health.heartbeatAgeS}s)`;
      break;
    case "stale":
      health = `${WARN}▲ DATA STALE (${view.health.dataAgeS}s)${DRESET}`;
      break;
    case "unreachable":
      health = `${FG.anomaly}✖ unreachable${RESET}`;
      break;
  }
  const s = view.snapshot;
  const rounds = s ? `rounds ${s.running_rounds}/${s.max_concurrent_rounds ?? "?"}` : "";
  const spend = s?.today_spend_usd !== undefined ? `today $${s.today_spend_usd.toFixed(2)}` : "";
  const badge = alerts && view.alerts ? alertSegment(view.alerts, view.alertFocus === true) : "";
  return [`${HEADING}quickreview${DRESET}`, mode, health, rounds, spend, badge].filter((x) => x !== "");
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

function styledRow(pr: SnapshotPr, selected: boolean, width: number, now: Date, repo: string | undefined): string {
  const color = stateColor(pr.stale_recheck ? "reviewing" : pr.state);
  const chip = verdictChip(pr.last_verdict);
  const rounds = pr.rounds ? `${FG.dim}r${pr.rounds}${RESET}` : "";
  const head = `${color}${glyphFor(pr)} ${STRONG}#${pr.number}${RESET}`;
  const meta = [`${FG.author}${pr.author ?? ""}${RESET}`, `${FG.dim}${fmtAge(pr.updated_at, now)}${RESET}`, rounds, chip]
    .filter((s) => stripAnsi(s) !== "")
    .join(" ");
  const used = displayWidth(`${stripAnsi(head)} ${stripAnsi(meta)} `);
  const title = truncate(pr.title, Math.max(4, width - used - 1));
  const numLinked = repo ? `${color}${glyphFor(pr)} ${STRONG}${osc8(prUrl(repo, pr.number), `#${pr.number}`)}${RESET}` : head;
  const body = `${numLinked} ${meta} ${title}`;
  const pad = " ".repeat(Math.max(0, width - displayWidth(body) - 1));
  return selected ? selectedLine(` ${body}${pad}`) : ` ${body}${pad}`;
}

const VERDICT_ABBREV: Record<string, string> = { REQUEST_CHANGES: "RC", APPROVE: "APPROVE", COMMENT: "COMMENT" };

function section(title: string, subtitle: string): string {
  return sectionTitle(title, subtitle);
}

export function detailLines(detail: WhyPayload | undefined, pr: SnapshotPr | undefined, width: number, now: Date = new Date(0)): string[] {
  const lines: string[] = [];
  if (!pr) return ["no PR selected"];
  lines.push(`${stateColor(pr.state)}${STRONG}#${pr.number}${RESET} ${STRONG}${truncate(sanitizeText(pr.title), width - 8 - String(pr.number).length)}${RESET}`);
  if (!detail || detail.pr !== pr.number) {
    lines.push(`${FG.dim}loading detail…${RESET}`);
    return lines;
  }
  const round = detail.rounds.length > 0 ? detail.rounds[detail.rounds.length - 1]?.round_no : undefined;
  const facts: string[] = [`${stateColor(detail.state ?? pr.state)}${detail.state ?? pr.state}${RESET}`];
  if (round !== undefined) facts.push(`round ${round}`);
  if (detail.author) facts.push(`by ${FG.author}${detail.author}${RESET}`);
  lines.push(truncate(facts.join(" · "), width));
  const trig = detail.trigger_ts ? `trig ${fmtAge(detail.trigger_ts, now)} ago` : "trig —";
  lines.push(truncate(`spend $${detail.spend_usd.toFixed(2)} · head ${(detail.head_sha ?? "").slice(0, 7)} · ${trig}`, width));
  if (detail.labels && detail.labels.length > 0) {
    lines.push(truncate(detail.labels.map((l) => `${FG.accent}[${sanitizeText(l)}]${RESET}`).join(" "), width));
  }
  lines.push(`${FG.dim}${"─".repeat(Math.max(0, width))}${RESET}`);
  const lastSummary = [...detail.rounds].reverse().find((r) => r.summary && r.summary.trim().length > 0)?.summary;
  if (lastSummary) {
    lines.push(truncate(section("NOW", "the session's own 3-4 sentence read"), width));
    for (const l of wrap(sanitizeText(lastSummary).trim(), width)) lines.push(l);
  }
  if (detail.description !== undefined) {
    lines.push(truncate(section("DESCRIPTION", "the PR body"), width));
    const raw = sanitizeText(detail.description).trim();
    const desc = raw.length > 0 ? wrap(raw, width) : ["(empty)"];
    for (const l of desc.slice(0, 12)) lines.push(l);
    if (desc.length > 12) lines.push(`${FG.dim}… ${desc.length - 12} more lines (open on GitHub with g)${RESET}`);
  }
  lines.push(truncate(section("LEDGER", "findings the conversation tracks"), width));
  if (detail.ledger) {
    for (const l of sanitizeText(detail.ledger).split("\n")) {
      const t = l.trim();
      if (t.length > 0) for (const wl of wrap(t, width)) lines.push(wl);
    }
  } else {
    lines.push(truncate(`${FG.dim}none yet — the live ledger is pinned in the session${RESET}`, width));
  }
  const roundsBits = detail.rounds.map((r) => {
    const v = r.verdict ? (VERDICT_ABBREV[r.verdict] ?? r.verdict) : r.status === "running" ? "…" : "—";
    const color = r.verdict === "APPROVE" ? FG.approve : r.verdict === "REQUEST_CHANGES" ? FG.request_changes : FG.dim;
    return `r${r.round_no} ${color}${v}${RESET}`;
  });
  lines.push(truncate(`${section("ROUNDS", "review rounds + verdicts")}  ${roundsBits.join(" · ") || "—"}`, width));
  lines.push(truncate(`${section("THREADS", "bot review threads")} ${detail.threads.total} known`, width));
  if (detail.comments && detail.comments.length > 0) {
    lines.push(truncate(section("COMMENTS", "latest PR conversation"), width));
    for (const c of detail.comments) {
      lines.push(truncate(`${FG.author}${c.author}${RESET} ${FG.dim}${fmtAge(c.created_at, now)} ago${RESET}`, width));
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

export const HELP_LINES = [
  "1/2/3/4       board / memory & learning / deploy / metrics tab",
  "               metrics tab: 7 / 0 / a switch the 7d / 30d / all window; # <pr> ⏎ opens a PR timeline (Esc back)",
  "               deploy tab: click ▶ DEPLOY TO VM (or D D) to deploy · ■ STOP/▶ START VM APP (or S S) to power the container",
  "s              reconnect VM ssh (the one ssh key-passphrase prompt, shared 4h)",
  "Ctrl-c ×3      kill the TUI from anywhere (terminal restored) — the un-stuck hatch",
  "               an alert in the top bar: click it or ⏎ to open the companion",
  "the companion sidebar down the right edge is on every tab:",
  "               type any key no tab claims (or /) — it starts a message; ⏎ sends · Esc clears",
  "               click its input row to type · \\ collapses it to a spine",
  "j/k ↓/↑        select PR (mouse: click a row; click again to attach)",
  "⏎ / a          attach selected PR full-screen (the takeover; Ctrl-q back)",
  "click the PI pane below the list — it is a live terminal, not a picture:",
  "               everything you type goes to that pi session; Ctrl-q hands the keyboard back",
  "               wheel over the pane scrolls its scrollback (End/live once you wheel back down)",
  "g              open the PR on GitHub (PR numbers are Ctrl+clickable links)",
  "w              toggle full-height detail",
  "m              quick-message selected PR",
  "o / M          attach overseer / main session",
  "e              events overlay (j/k scroll, e/Esc close; click an event → its PR)",
  "r              force refresh",
  "[ / ]          older / newer day (memory & learning tab; v toggles digest/memory view)",
  "Ctrl-q         detach (inside attach; twice = literal)",
  "q              quit",
  "",
  "any key to close",
];

// ---- live pi pane ----------------------------------------------------------

/**
 * Header of the pane: which session, whether it is live, whether it currently
 * owns the keyboard, and how far back in scrollback it is parked.
 */
export function piHeader(pr: number | undefined, pane: PiPaneView | undefined, focused = false): string {
  if (pr === undefined) return `${FG.dim}PI — no PR selected${RESET}`;
  const name = focused
    ? `${ACCENT_BG}PI pr-${pr}${DRESET}`
    : `${MUTED}PI ${DRESET}${ACCENT}pr-${pr}${DRESET}`;
  const mine = pane && pane.pr === pr ? pane : undefined;
  if (!mine) return `${name}${FG.dim} · connecting…${RESET}`;
  if (mine.missing) {
    return `${name}${FG.dim} · no pi session for #${pr}${mine.stale ? " · (stale)" : ""}${RESET}`;
  }
  const scroll = mine.offset > 0 ? `${FG.accent} · ↑ ${mine.offset} lines back${RESET}${FG.dim} · End live${RESET}` : "";
  const mode = focused ? `${FG.accent} · focused${RESET}${FG.dim} · Ctrl-q back to board${RESET}` : `${FG.dim} · live mirror · click to type${RESET}`;
  return `${name}${mode}${scroll}`;
}

/** The window of the capture that fits the region, already width-clamped.
 * `pane.offset` parks the window that many lines above the live tail. */
export function piBody(pr: number | undefined, pane: PiPaneView | undefined, width: number, height: number): string[] {
  if (pr === undefined || height <= 0) return [];
  const mine = pane && pane.pr === pr ? pane : undefined;
  if (!mine) return [`${FG.dim}waiting for the first capture…${RESET}`];
  if (mine.lines.length === 0) return mine.missing ? [] : [`${FG.dim}(pane empty)${RESET}`];
  // Bottom-anchored, like the terminal it mirrors: new output lands on a
  // stable edge instead of shifting the whole pane down. A scrollback offset
  // moves that edge up through the captured history.
  const src = mine.offset > 0 ? mine.lines.slice(0, Math.max(0, mine.lines.length - mine.offset)) : mine.lines;
  const tail = src.slice(-height).map((l) => truncate(l, width));
  return [...new Array<string>(Math.max(0, height - tail.length)).fill(""), ...tail];
}

// ---- events overlay ---------------------------------------------------------

/** The demoted EVENTS strip: a floating, scrollable band over the board. */
function renderEventsOverlay(frame: Frame, view: BoardView, cols: number, rows: number): void {
  const { top, height } = eventsOverlayBand(rows);
  const visible = Math.max(0, height - 2);
  frame.set(top, rule(cols, "├", "┤", [sectionTitle("EVENTS"), `${MUTED}what the daemon just did${DRESET}`, `${MUTED}j/k scroll · e/Esc close${DRESET}`]));
  const slice = view.events.slice(view.eventsScroll, view.eventsScroll + visible);
  for (let i = 0; i < visible; i++) {
    const e = slice[i];
    const text = e ? (e.anomaly ? `${FG.anomaly}${truncate(e.text, cols - 4)}${RESET}` : truncate(e.text, cols - 4)) : "";
    frame.boxRow(top + 1 + i, [{ text: ` ${text}`, width: cols - 2 }]);
    const prMatch = e ? /#(\d+)/.exec(e.text) : null;
    if (prMatch) {
      frame.zones.push({ x1: 2, y1: top + 1 + i + 1, x2: cols - 1, y2: top + 1 + i + 1, action: { t: "event-jump", pr: Number(prMatch[1]) } satisfies BoardAction });
    }
  }
  frame.set(top + height - 1, rule(cols, "├", "┤", []));
}

// ---- render ----------------------------------------------------------------

export function renderBoard(view: BoardView, cols: number, rows: number): Frame {
  const frame = new Frame(cols, rows);
  const now = view.now ?? new Date();
  frame.set(0, topBar(view, cols));
  const az = alertZone(view, cols);
  if (az) frame.zones.push({ x1: az.x1, y1: 1, x2: az.x2, y2: 1, action: { t: "companion" } satisfies BoardAction });
  const pRows = piRows(rows);
  const bodyRows = rows - 4 - pRows; // top bar + command bar (2 rows) + bottom border
  const sorted = visiblePrs(view);
  const listW = listWidth(sorted, cols, now);
  const detailW = cols - 2 - listW - 1;
  const selectedPr = sorted[view.selected];
  frame.meta = { listW, bodyRows, piTop: 1 + bodyRows, piRows: pRows };

  if (view.help) {
    frame.boxRow(1, [{ text: ` ${sectionTitle("KEYS", "everything the TUI answers to")}`, width: cols - 2 }]);
    HELP_LINES.forEach((l, i) => {
      if (2 + i < rows - 1) frame.boxRow(2 + i, [{ text: `   ${l}`, width: cols - 2 }]);
    });
    for (let r = 2 + HELP_LINES.length; r < rows - 1; r++) frame.boxRow(r, [{ text: "", width: cols - 2 }]);
    frame.set(rows - 1, rule(cols, "└", "┘", []));
    return frame;
  }

  if (view.detailFull) {
    const lines = detailLines(view.detail, selectedPr, cols - 4, now);
    for (let r = 0; r < rows - 4; r++) {
      frame.boxRow(1 + r, [{ text: ` ${lines[r] ?? ""}`, width: cols - 2 }]);
    }
    paintCmdBar(frame, "board", cols, rows);
    frame.set(rows - 1, rule(cols, "└", "┘", ["w back"]));
    return frame;
  }

  // Board body: list | detail.
  const flabel = filterLabel(view.boardFilter);
  const listLines: string[] = [section(`PRS (${sorted.length})`, flabel !== "" ? flabel : "the daemon's live set")];
  sorted.forEach((pr, i) => {
    listLines.push(styledRow(pr, i === view.selected, listW - 1, now, view.repo));
    const y = 1 + listLines.length - 1 + 1; // frame row of this PR line (below top bar)
    // Only PAINTED rows get zones: with a long list, off-screen rows would
    // otherwise leave phantom click targets over the pi region and the
    // bar-row gaps — a click there could select (or double-click attach)
    // an invisible PR.
    if (i >= bodyRows - 1) return;
    frame.zones.push({ x1: 2, y1: y, x2: listW, y2: y, action: { t: "select-pr", pr: pr.number } satisfies BoardAction });
    frame.zones.push({ x1: 4, y1: y, x2: 4 + String(pr.number).length + 1, y2: y, action: { t: "open-github", pr: pr.number } satisfies BoardAction });
  });
  const dLines = detailLines(view.detail, selectedPr, detailW - 2, now);
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
    frame.boxRow(piTop + 1, [{ text: ` ${HEADING}MSG → ${view.inputBox.target}${DRESET}`, width: cols - 2 }]);
    frame.boxRow(piTop + 2, [{ text: ` > ${view.inputBox.text}▁`, width: cols - 2 }]);
    frame.boxRow(piTop + 3, [{ text: ` ⏎ send · Esc cancel · Alt-⏎ newline`, width: cols - 2 }]);
    for (let i = 4; i <= piLines; i++) frame.boxRow(piTop + i, [{ text: "", width: cols - 2 }]);
  } else if (pRows > 0) {
    frame.boxRow(piTop + 1, [{ text: ` ${piHeader(panePr, view.pi, piFocused)}${view.noticeLine ? `   ${view.noticeLine}` : ""}`, width: cols - 2 }]);
    const body = piBody(panePr, view.pi, cols - 4, piLines);
    for (let i = 0; i < piLines; i++) frame.boxRow(piTop + 2 + i, [{ text: ` ${body[i] ?? ""}`, width: cols - 2 }]);
    // Clicking anywhere in the region (divider, header or body) gives the pane
    // the keyboard — it does NOT open the full-screen attach any more. The
    // takeover is still there, on ⏎ / a from the PR list.
    if (panePr !== undefined) {
      frame.zones.push({ x1: 2, y1: piTop + 1, x2: cols - 1, y2: piTop + pRows, action: { t: "pi-focus" } satisfies BoardAction });
    }
  }

  // EVENTS: no longer a permanent strip — a floating overlay on `e`.
  if (view.eventsFocus) renderEventsOverlay(frame, view, cols, rows);

  // The shared two-row command bar replaces the board's own hint row.
  paintCmdBar(frame, "board", cols, rows);
  frame.set(rows - 1, rule(cols, "└", "┘", []));
  return frame;
}

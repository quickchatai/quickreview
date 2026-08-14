// Board screen — the main-screen mockup: top status bar, PR list
// (left, 30 cells) / detail (right), events strip, key-hint row. Pure:
// (view, cols, rows) → Frame.
import type { WhyPayload } from "../cli.js";
import type { StatusSnapshot } from "../state.js";
import { awaitingRows, formatEvent, glyphFor, sortPrs, type EventLine, type SnapshotPr } from "./model.js";
import { Frame, SGR, displayWidth, fit, rule, truncate } from "./paint.js";
import type { Health } from "./poll.js";

/** Left column sized to the longest PR row so titles aren't cropped while
 * the detail pane sits empty — clamped to 45% of the terminal. */
export function listWidth(prs: SnapshotPr[], cols: number): number {
  const widest = prs.reduce((w, pr) => Math.max(w, displayWidth(`${glyphFor(pr)} #${pr.number} ${pr.title}`)), 0);
  return Math.min(Math.max(24, widest + 3), Math.floor(cols * 0.45));
}

/** Events strip grows with terminal height: divider + header + lines +
 * hints; ~a quarter of the screen, 3–10 visible event lines. */
export function eventsRows(rows: number): number {
  return Math.min(Math.max(6, Math.floor(rows * 0.25)), 13);
}

export interface BoardView {
  health: Health;
  dryRun: boolean;
  snapshot?: StatusSnapshot;
  events: EventLine[]; // newest first
  selected: number;
  detail?: WhyPayload;
  detailFull: boolean;
  eventsFocus: boolean;
  eventsScroll: number;
  help: boolean;
  /** Extra line rendered inside the events strip (quick-message state). */
  noticeLine?: string;
  /** Replaces the events strip when the message box is open. */
  inputBox?: { target: string; text: string };
}

export function topBar(view: BoardView, cols: number): string {
  const mode = view.dryRun ? "DRY-RUN" : `${SGR.bgRed}${SGR.bold} LIVE ${SGR.reset}`;
  let health: string;
  switch (view.health.kind) {
    case "ok":
      health = `${SGR.green}●${SGR.reset} daemon ok (hb ${view.health.heartbeatAgeS}s)`;
      break;
    case "stale":
      health = `${SGR.yellow}▲ DATA STALE (${view.health.dataAgeS}s)${SGR.reset}`;
      break;
    case "unreachable":
      health = `${SGR.red}✖ unreachable${SGR.reset}`;
      break;
  }
  const s = view.snapshot;
  const rounds = s ? `rounds ${s.running_rounds}/${s.max_concurrent_rounds ?? "?"}` : "";
  const spend = s?.today_spend_usd !== undefined ? `today $${s.today_spend_usd.toFixed(2)}` : "";
  return rule(cols, "┌", "┐", ["quickreview", mode, health, rounds, spend]);
}

function prRow(pr: SnapshotPr, selected: boolean, width: number): string {
  const line = `${glyphFor(pr)} #${pr.number} ${pr.title}`;
  const fitted = fit(line, width - 1);
  return selected ? `${SGR.inverse} ${fitted}${SGR.reset}` : ` ${fitted}`;
}

const VERDICT_ABBREV: Record<string, string> = { REQUEST_CHANGES: "RC", APPROVE: "APPROVE", COMMENT: "COMMENT" };

export function detailLines(detail: WhyPayload | undefined, pr: SnapshotPr | undefined, width: number): string[] {
  const lines: string[] = [];
  if (!pr) return ["no PR selected"];
  lines.push(`${SGR.bold}#${pr.number} ${truncate(pr.title, width - 8 - String(pr.number).length)}${SGR.reset}`);
  if (!detail || detail.pr !== pr.number) {
    lines.push(`${SGR.dim}loading detail…${SGR.reset}`);
    return lines;
  }
  const round = detail.rounds.length > 0 ? detail.rounds[detail.rounds.length - 1]?.round_no : undefined;
  const facts: string[] = [`state ${detail.state ?? pr.state}`];
  if (round !== undefined) facts.push(`round ${round}`);
  facts.push(`esc-worthy: ${detail.escalation_worthy ? "yes" : "no"}`);
  lines.push(facts.join(" · "));
  const trig = detail.trigger_ts ? `trig ${detail.trigger_ts.slice(11, 16)}` : "trig —";
  lines.push(`spend $${detail.spend_usd.toFixed(2)} · head ${(detail.head_sha ?? "").slice(0, 7)} · ${trig}`);
  lines.push("─".repeat(Math.max(0, width)));
  lines.push(`${SGR.bold}LEDGER${SGR.reset}`);
  if (detail.ledger) {
    for (const l of detail.ledger.split("\n")) {
      const t = l.trim();
      if (t.length > 0) lines.push(truncate(t, width));
    }
  } else {
    lines.push(`${SGR.dim}(none archived — live ledger is pinned in the session)${SGR.reset}`);
  }
  const roundsBits = detail.rounds.map((r) => {
    const v = r.verdict ? (VERDICT_ABBREV[r.verdict] ?? r.verdict) : r.status === "running" ? "…" : "—";
    return `r${r.round_no} ${v}`;
  });
  lines.push(`${SGR.bold}ROUNDS${SGR.reset}  ${roundsBits.join(" · ") || "—"}`);
  lines.push(`${SGR.bold}THREADS${SGR.reset} ${detail.threads.total} known`);
  return lines;
}

export const BOARD_HINTS = "[1]board [2]digest  ⏎attach  m msg  o overseer  w why  e events  r refresh  ? keys  q quit";

export const HELP_LINES = [
  "1 / 2          board / digest tab",
  "j/k ↓/↑        select PR",
  "⏎              attach selected PR (embedded)",
  "w              toggle full-height detail",
  "m              quick-message selected PR",
  "o / M          attach overseer / main session",
  "e              focus events strip (j/k scroll, Esc back)",
  "r              force refresh",
  "[ / ]          older / newer digest (digest tab)",
  "Ctrl-q         detach (inside attach; twice = literal)",
  "q              quit",
  "",
  "any key to close",
];

export function renderBoard(view: BoardView, cols: number, rows: number): Frame {
  const frame = new Frame(cols, rows);
  frame.set(0, topBar(view, cols));
  const evRows = eventsRows(rows);
  const bodyRows = rows - 2 - evRows; // top bar + bottom border
  const sorted = view.snapshot ? sortPrs(view.snapshot.prs) : [];
  const listW = listWidth(sorted, cols);
  const detailW = cols - 2 - listW - 1;
  const selectedPr = sorted[view.selected];

  if (view.help) {
    frame.boxRow(1, [{ text: ` ${SGR.bold}KEYS${SGR.reset}`, width: cols - 2 }]);
    HELP_LINES.forEach((l, i) => {
      if (2 + i < rows - 1) frame.boxRow(2 + i, [{ text: `   ${l}`, width: cols - 2 }]);
    });
    for (let r = 2 + HELP_LINES.length; r < rows - 1; r++) frame.boxRow(r, [{ text: "", width: cols - 2 }]);
    frame.set(rows - 1, rule(cols, "└", "┘", []));
    return frame;
  }

  if (view.detailFull) {
    const lines = detailLines(view.detail, selectedPr, cols - 4);
    for (let r = 0; r < bodyRows + evRows; r++) {
      frame.boxRow(1 + r, [{ text: ` ${lines[r] ?? ""}`, width: cols - 2 }]);
    }
    frame.set(rows - 1, rule(cols, "└", "┘", ["w back"]));
    return frame;
  }

  // Board body: list | detail.
  const listLines: string[] = [`${SGR.bold}PRS (${sorted.length})${SGR.reset}`];
  sorted.forEach((pr, i) => listLines.push(prRow(pr, i === view.selected, listW - 1)));
  const dLines = detailLines(view.detail, selectedPr, detailW - 2);
  for (let r = 0; r < bodyRows; r++) {
    frame.boxRow(1 + r, [
      { text: ` ${listLines[r] ?? ""}`, width: listW },
      { text: ` ${dLines[r] ?? ""}`, width: detailW },
    ]);
  }

  // Events strip (or the quick-message input box).
  const stripTop = 1 + bodyRows;
  const stripLines = evRows - 3; // minus divider, header, hints
  frame.set(stripTop, `│${fit("─".repeat(listW), listW)}┴${"─".repeat(detailW)}│`);
  if (view.inputBox) {
    frame.boxRow(stripTop + 1, [{ text: ` ${SGR.bold}MSG → ${view.inputBox.target}${SGR.reset}`, width: cols - 2 }]);
    frame.boxRow(stripTop + 2, [{ text: ` > ${view.inputBox.text}▁`, width: cols - 2 }]);
    frame.boxRow(stripTop + 3, [{ text: ` ⏎ send · Esc cancel · Alt-⏎ newline`, width: cols - 2 }]);
    for (let i = 4; i <= stripLines + 1; i++) frame.boxRow(stripTop + i, [{ text: "", width: cols - 2 }]);
  } else {
    const header = view.eventsFocus ? `${SGR.inverse}EVENTS${SGR.reset} (j/k scroll · Esc back)` : `${SGR.bold}EVENTS${SGR.reset}`;
    frame.boxRow(stripTop + 1, [{ text: ` ${header}${view.noticeLine ? `   ${view.noticeLine}` : ""}`, width: cols - 2 }]);
    const visible = view.events.slice(view.eventsScroll, view.eventsScroll + stripLines);
    for (let i = 0; i < stripLines; i++) {
      const e = visible[i];
      const text = e ? (e.anomaly ? `${SGR.red}${truncate(e.text, cols - 4)}${SGR.reset}` : truncate(e.text, cols - 4)) : "";
      frame.boxRow(stripTop + 2 + i, [{ text: ` ${text}`, width: cols - 2 }]);
    }
  }
  frame.boxRow(rows - 2, [{ text: ` ${SGR.dim}${BOARD_HINTS}${SGR.reset}`, width: cols - 2 }]);
  frame.set(rows - 1, rule(cols, "└", "┘", []));
  return frame;
}

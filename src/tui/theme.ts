// Semantic truecolor theme (grill decision 2026-08-14): every lifecycle
// state owns a hue used consistently across the list, detail, events, and
// legend — a glance at the color tells the state without reading. Verdicts
// and anomalies get their own fixed colors.
import { ACCENT, MUTED } from "./design.js";
import { ESC, rgb } from "./paint.js";

export const FG = {
  reviewing: rgb(97, 175, 239), // blue — the daemon is on it
  queued: rgb(140, 148, 160), // grey — waiting its turn
  awaiting_author: rgb(229, 192, 123), // yellow — ball with the author
  awaiting_human: rgb(198, 120, 221), // magenta — needs YOU
  tracked: rgb(92, 99, 112), // dim grey — known, no live trigger
  closed: rgb(92, 99, 112),
  approve: rgb(152, 195, 121), // green
  request_changes: rgb(209, 154, 102), // orange
  anomaly: rgb(224, 108, 117), // red
  accent: ACCENT, // the ONE accent (design.ts, §8) — titles, links, focus
  text: rgb(171, 178, 191),
  dim: MUTED,
  author: rgb(152, 195, 121),
} as const;

export const RESET = `${ESC}0m`;

export function stateColor(state: string): string {
  return (FG as Record<string, string>)[state] ?? FG.text;
}

export function verdictColor(verdict: string | null | undefined): string {
  if (verdict === "APPROVE") return FG.approve;
  if (verdict === "REQUEST_CHANGES") return FG.request_changes;
  // "ESCALATE" persists in rounds recorded before 2026-08-18.
  if (verdict === "NEEDS_HUMAN" || verdict === "ESCALATE") return FG.awaiting_human;
  return FG.dim;
}

/** Compact verdict chip: APPROVE → ✓A, REQUEST_CHANGES → ✗RC, NEEDS_HUMAN → ⚑H. */
export function verdictChip(verdict: string | null | undefined): string {
  if (!verdict) return "";
  const label =
    verdict === "APPROVE"
      ? "✓A"
      : verdict === "REQUEST_CHANGES"
        ? "✗RC"
        : verdict === "NEEDS_HUMAN" || verdict === "ESCALATE"
          ? "⚑H"
          : verdict;
  return `${verdictColor(verdict)}${label}${RESET}`;
}

/** 45s / 12m / 3h / 2d — age at a glance. */
export function fmtAge(iso: string | null | undefined, now: Date): string {
  if (!iso) return "—";
  const s = Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** Colored one-line glyph legend rendered under the PR list. */
export function legendLine(): string {
  const parts: Array<[string, string, string]> = [
    ["▶", "reviewing", FG.reviewing],
    ["●", "queued", FG.queued],
    ["⚑", "needs-you", FG.awaiting_human],
    ["✎", "author", FG.awaiting_author],
    ["·", "tracked", FG.tracked],
    ["↻", "stale", FG.accent],
  ];
  return parts.map(([g, label, color]) => `${color}${g}${RESET} ${FG.dim}${label}${RESET}`).join("  ");
}

/** OSC-8 terminal hyperlink — Ctrl+click works natively in modern terminals. */
export function osc8(url: string, text: string): string {
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

export function prUrl(repo: string, pr: number): string {
  return `https://github.com/${repo}/pull/${pr}`;
}

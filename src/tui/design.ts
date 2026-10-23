// Design tokens: "muted + one accent".
// The only module where visual decisions live: every renderer styles chrome
// through these semantic tokens and helpers — never raw SGR.bold/dim/inverse
// at call sites. Composes over paint.ts's SGR; layout stays ANSI-transparent
// (helpers add zero cells beyond their visible glyphs).
//
// Language, picked once:
//   * accent      — 256-color cyan-teal 73: selection, focus, active tab,
//                   links, key glyphs. The one non-semantic color.
//   * muted       — grey 246 for secondary text (instead of decorative dim).
//   * red/green   — truth only (LIVE badge, CI red, REQUEST_CHANGES/blocked;
//                   green for APPROVE/healthy). Yellow = warnings.
//   * sections    — `▍TITLE` in accent+bold, muted subtitle beside it.
//   * selection   — a selected row (selected()) is accent background, dark ink
//                   (inner SGR stripped so the bar reads as one piece;
//                   OSC-8 links survive); mouse text selection (SELECTION)
//                   is inverse video.
import { ESC, SGR, stripAnsi } from "./paint.js";

const fg256 = (n: number): string => `${ESC}38;5;${n}m`;
const bg256 = (n: number): string => `${ESC}48;5;${n}m`;

/** Dark ink used on top of every solid chip/selection background. */
const INK_ON_FILL = fg256(235);

// ---- tokens ----------------------------------------------------------------

/** The one accent — cyan-teal (reads on dark terminals without glare). */
export const ACCENT = fg256(73);
/** Inverse-selection variant: accent background + dark ink. */
export const ACCENT_BG = `${bg256(73)}${INK_ON_FILL}`;
/** Secondary text — used instead of decorative `dim`. */
export const MUTED = fg256(246);
/** Section titles: accent + bold. */
export const HEADING = `${ACCENT}${SGR.bold}`;
/** Emphasis without color — the sanctioned bold (never raw SGR.bold). */
export const STRONG = SGR.bold;
/** Semantic green — APPROVE / healthy / succeeded. Nothing else. */
export const OK = fg256(71);
/** Semantic red — LIVE, CI red, REQUEST_CHANGES / blocked / failed. */
export const BAD = fg256(167);
/** Semantic yellow — stale data, arming, budget overruns. */
export const WARN = fg256(179);
/** Chip backgrounds — badge()'s fills, also the deploy tab's armed buttons. */
export const OK_BG = `${bg256(71)}${INK_ON_FILL}`;
export const BAD_BG = `${bg256(124)}${fg256(231)}`;
export const WARN_BG = `${bg256(179)}${INK_ON_FILL}`;
export const RESET = SGR.reset;

/** Mouse-selection highlight. Inverse rather than a palette fill:
 * the selected span may be ANY content — a board row, a diff line, pi's own
 * coloured output — and inverse is the one treatment that stays legible over
 * all of it, which is also why terminals use it for their own selection. */
export const SELECTION = SGR.inverse;

/** The uniform " · " separator for status lines (muted, ink restored). */
export const SEP = `${MUTED} · ${RESET}`;

// ---- helpers ---------------------------------------------------------------

/** The one section-header language: `▍TITLE` accent+bold, muted subtitle. */
export function sectionTitle(title: string, subtitle = ""): string {
  const head = `${HEADING}▍${title}${RESET}`;
  return subtitle.length > 0 ? `${head} ${MUTED}${subtitle}${RESET}` : head;
}

// CSI SGR sequences only — OSC-8 hyperlinks must survive a selection wrap.
const SGR_RE = /\x1b\[[0-9;]*m/g;

/**
 * The selection style: accent background over the whole line. Inner SGR
 * styling is stripped (a selection bar reads as one piece; per-token colors
 * return when the row is deselected); OSC-8 links are kept clickable.
 * Cell math is untouched: displayWidth(selected(l)) === displayWidth(l).
 */
export function selected(line: string): string {
  return `${ACCENT_BG}${line.replace(SGR_RE, "")}${RESET}`;
}

/** Focus tick for pane headers/prompts: accent `▌` focused, blank otherwise. */
export function focusMark(focused: boolean): string {
  return focused ? `${ACCENT}▌${RESET}` : " ";
}

export type BadgeKind = "live" | "ok" | "bad" | "warn" | "accent";

const BADGE_BG: Record<BadgeKind, string> = {
  live: BAD_BG,
  ok: OK_BG,
  bad: BAD_BG,
  warn: WARN_BG,
  accent: ACCENT_BG,
};

/** Status chip (LIVE, DRY-RUN, verdicts, CI states): ` TEXT ` on a solid
 * semantic background. Red/green chips carry truth only. */
export function badge(kind: BadgeKind, text: string): string {
  return `${BADGE_BG[kind]}${SGR.bold} ${stripAnsi(text)} ${RESET}`;
}

/**
 * The one top-bar mode chip: LIVE is red truth, DRY-RUN rides the accent.
 *
 * `undefined` means not yet known and must never render as either: a live
 * install painted `DRY-RUN` from a default reads as "someone flipped the flag
 * on my live reviewer". The badge is only ever asserted from a heartbeat.
 */
export function modeBadge(dryRun: boolean | undefined): string {
  if (dryRun === undefined) return badge("warn", "MODE UNKNOWN");
  return dryRun ? badge("accent", "DRY-RUN") : badge("live", "LIVE");
}

/**
 * `[k label]` button: muted brackets, accent-bold key glyph when the label
 * leads with a `<key> <word>` pair, plain ink otherwise. Same visible text as
 * the plain `[label]` — geometry (hit zones, slot widths) is untouched.
 */
export function button(label: string, active = false): string {
  if (active) return `${ACCENT_BG}${SGR.bold}[${stripAnsi(label)}]${RESET}`;
  const chars = [...label];
  const keyed = chars.length > 1 && chars[1] === " ";
  const head = keyed ? `${ACCENT}${SGR.bold}${chars[0]}${RESET}` : "";
  const rest = keyed ? chars.slice(1).join("") : label;
  return `${MUTED}[${RESET}${head}${rest}${MUTED}]${RESET}`;
}

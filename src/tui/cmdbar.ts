// The shared command bar at the foot of every tab. Pure layout, no I/O.
//
// Row A is identical everywhere: the eight nav slots, then the globals
// right-justified so their x-positions depend only on the terminal width,
// never on the tab. The rows after it carry the current tab's live commands.
//
// Two rules:
//
//   * The bar wraps. Nothing is dropped (a dropped button can be the unwedge
//     lever): a slot that would run off the row starts a new one, and
//     `barHeight` tells each renderer how many rows the bar took so the body
//     can give them up.
//
//   * The bar is state-derived. A tab paints the buttons it answers to right
//     now (`LiveKeys`, supplied by the tab's hooks), and `registeredKeys` is
//     computed from the same list — so painted ⇔ registered ⇔ answers. A
//     registered key is denied to the companion column (App routes every
//     other printable there), which is why a dead registration is not inert:
//     it steals a keystroke. `TAB_VOCABULARY` is the static universe each
//     tab draws from; docs/tui.md is pinned to it and the fences check that
//     every live bar is a subset of it.
//
// paintCmdBar and barHitKey share the one layout() computation, so render and
// hit-test cannot drift.
import { button } from "./design.js";
import { type Frame, displayWidth } from "./paint.js";
import { TABS, tabDigit, type Tab } from "./tabs.js";

export interface BarButton {
  key: string;
  label: string;
}

/** What a tab answers to on this frame: the row-B buttons it paints on the
 * bar, and the printable keys it paints beside their object instead (an
 * `[e edit]` next to the entry it edits, a `y` on an armed confirmation). */
export interface LiveKeys {
  bar: BarButton[];
  inline: readonly string[];
}

export const NO_LIVE_KEYS: LiveKeys = { bar: [], inline: [] };

/** Row A left: one slot per tab, constant order and position. */
const NAV: ReadonlyArray<BarButton & { tab: Tab }> = TABS.map((tab) => ({
  key: tabDigit(tab),
  label: `${tabDigit(tab)} ${tab}`,
  tab,
}));

/** Row A right: always the same four, always in the same place. */
const GLOBALS: readonly BarButton[] = [
  { key: "r", label: "r refresh" },
  { key: "s", label: "s ssh" },
  { key: "?", label: "? help" },
  { key: "q", label: "q quit" },
];

/** Row A globals + the navigation keys every tab answers to. */
export const GLOBAL_KEYS: readonly string[] = ["q", "r", "s", "?", "j", "k", ...TABS.map(tabDigit)];

/**
 * Every row-B button a tab can ever paint — its vocabulary, with the canonical
 * label. A live bar picks from this set (labels may say more: `p unpin`,
 * `x close log`); the keys may not go outside it. This is the table
 * docs/tui.md documents and the help overlay is checked against.
 */
export const TAB_VOCABULARY: Readonly<Record<Tab, readonly BarButton[]>> = {
  board: [
    { key: "\r", label: "⏎ pi pane" },
    { key: "m", label: "m message" },
    { key: "g", label: "g github" },
    { key: "e", label: "e events" },
    { key: "u", label: "u unwedge" },
    { key: "I", label: "I setup" },
  ],
  memory: [
    { key: "[", label: "[ older day" },
    { key: "]", label: "] newer day" },
    { key: "n", label: "n new" },
    { key: "W", label: "W studio" },
  ],
  digest: [
    { key: "[", label: "[ older" },
    { key: "]", label: "] newer" },
  ],
  tickets: [
    { key: "c", label: "c show all" },
    { key: "[", label: "[ scroll up" },
    { key: "]", label: "] scroll down" },
  ],
  deploy: [
    { key: "D", label: "D deploy" },
    { key: "S", label: "S power" },
    { key: "x", label: "x abort" },
  ],
  metrics: [
    { key: "w", label: "w 7d" },
    { key: "m", label: "m 30d" },
    { key: "a", label: "a all" },
    { key: "#", label: "# pr" },
    { key: "\r", label: "⏎ open" },
    { key: "\x1b", label: "Esc back" },
  ],
  feedback: [
    { key: "a", label: "a show archived" },
    { key: "t", label: "t focus" },
    { key: "A", label: "A accept" },
    { key: "x", label: "x reject" },
    { key: "R", label: "R revert" },
  ],
  scan: [
    { key: "p", label: "p promote" },
    { key: "d", label: "d dismiss" },
    { key: "f", label: "f filter" },
    { key: "t", label: "t tier" },
    { key: "P", label: "P plan" },
    { key: "x", label: "x stop" },
    { key: "D", label: "D delta" },
    { key: "[", label: "[ prev unit" },
    { key: "]", label: "] next unit" },
    { key: "\r", label: "⏎ approve" },
    { key: " ", label: "space toggle" },
    { key: "\x1b", label: "Esc back" },
  ],
};

/**
 * Every printable a tab can ever paint beside its object rather than on the
 * bar — the `inline` half of a `LiveKeys`, as a universe. `boardKeys` offers
 * `a` (⏎'s twin) only with a PR selected and `F` only with a filter to clear;
 * memory paints `e p x` next to the selected entry; the feedback tab's `y`
 * confirms an armed revert; the metrics `# <pr>` box reads every digit; the
 * scan tab's `F` clears the filter its FINDINGS title is advertising.
 */
export const TAB_INLINE_KEYS: Readonly<Record<Tab, readonly string[]>> = {
  board: ["a", "F"],
  memory: ["e", "p", "x", "F"],
  digest: [],
  tickets: [],
  deploy: [],
  metrics: [..."0123456789"],
  feedback: ["y", "Y"],
  scan: ["F"],
};

/**
 * Every printable the active tab answers to right now. Anything outside this
 * set starts companion-column input instead of dying on the tab.
 */
export function registeredKeys(live: LiveKeys): Set<string> {
  return new Set([...GLOBAL_KEYS, ...live.inline, ...live.bar.map((b) => b.key)]);
}

interface Slot extends BarButton {
  x1: number; // 1-based terminal columns, inclusive
  x2: number;
  active: boolean;
}

/** `[label]` — the brackets are chrome, so a button is label + 2 cells. */
function btnWidth(label: string): number {
  return displayWidth(label) + 2;
}

/**
 * Lay buttons out left to right from terminal column 2 (inside the `│`
 * border), one space apart, wrapping to a new row when the next slot would
 * run past column cols-1. A slot wider than the whole row still gets a row
 * of its own — truncated by the paint, never dropped.
 */
function flow(buttons: ReadonlyArray<BarButton & { active?: boolean }>, cols: number): Slot[][] {
  const rows: Slot[][] = [[]];
  let x = 2;
  for (const b of buttons) {
    const w = btnWidth(b.label);
    const row = rows[rows.length - 1]!;
    if (row.length > 0 && x + w - 1 > cols - 1) {
      rows.push([]);
      x = 2;
    }
    rows[rows.length - 1]!.push({
      key: b.key,
      label: b.label,
      x1: x,
      x2: x + w - 1,
      active: b.active === true,
    });
    x += w + 1;
  }
  return rows;
}

/**
 * The single layout computation: the nav rows (with the globals joined to
 * the last one when they fit after it, else on a row of their own), then the
 * tab's command rows. Always at least two rows, so an empty command list
 * still paints an empty row B rather than pulling the body down.
 */
function layout(tab: Tab, cols: number, commands: readonly BarButton[]): Slot[][] {
  const rows = flow(
    NAV.map((n) => ({ ...n, active: n.tab === tab })),
    cols,
  );
  const gw = GLOBALS.reduce((s, g) => s + btnWidth(g.label), 0) + (GLOBALS.length - 1);
  const gx = cols - gw; // the last global ends at cols-1
  const placeGlobals = (row: Slot[]): void => {
    let g = gx;
    for (const gl of GLOBALS) {
      const w = btnWidth(gl.label);
      row.push({ key: gl.key, label: gl.label, x1: g, x2: g + w - 1, active: false });
      g += w + 1;
    }
  };
  if (gx >= 2) {
    const last = rows[rows.length - 1]!;
    if (last[last.length - 1]!.x2 + 1 < gx) placeGlobals(last);
    else {
      const own: Slot[] = [];
      placeGlobals(own);
      rows.push(own);
    }
  } else {
    // Too narrow even for the four globals side by side: they flow like
    // anything else, each still reachable.
    rows.push(...flow(GLOBALS, cols));
  }
  rows.push(...flow(commands, cols));
  return rows;
}

/** How many rows the bar takes at this width — the body gives them up. */
export function barHeight(tab: Tab, cols: number, commands: readonly BarButton[]): number {
  return layout(tab, cols, commands).length;
}

/** Muted brackets, accent-bold key glyph; the active nav slot ACCENT_BG —
 * the one button language, shared with every in-pane verb (design.button). */
function styleButton(s: Slot): string {
  return button(s.label, s.active);
}

/** Slots composed onto one row string, cell-exact at their layout x-ranges. */
function rowText(slots: Slot[]): string {
  let out = "";
  let w = 0; // plain cells emitted so far; content origin is terminal x=2
  for (const s of slots) {
    const pad = s.x1 - 2 - w;
    if (pad < 0) continue;
    out += " ".repeat(pad) + styleButton(s);
    w = s.x2 - 1;
  }
  return out;
}

/** Paints the bar's rows directly above the bottom border: frame rows
 * `rows - 1 - barHeight` … `rows - 2`, all boxed. */
export function paintCmdBar(
  frame: Frame,
  tab: Tab,
  cols: number,
  rows: number,
  commands: readonly BarButton[],
): void {
  const bar = layout(tab, cols, commands);
  const top = rows - 1 - bar.length;
  bar.forEach((slots, i) => frame.boxRow(top + i, [{ text: rowText(slots), width: cols - 2 }]));
}

/**
 * 1-based terminal click → the button's key, or undefined. Terminal row for
 * frame row r is r+1, so bar row i answers at y = rows - barHeight + i.
 */
export function barHitKey(
  tab: Tab,
  x: number,
  y: number,
  cols: number,
  rows: number,
  commands: readonly BarButton[],
): string | undefined {
  const bar = layout(tab, cols, commands);
  const i = y - (rows - bar.length);
  if (i < 0 || i >= bar.length) return undefined;
  for (const s of bar[i]!) if (x >= s.x1 && x <= s.x2) return s.key;
  return undefined;
}

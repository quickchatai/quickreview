// The shared two-row command bar (frame rows rows-3 / rows-2 on EVERY tab).
// Pure layout, no I/O. Row A is identical everywhere: nav slots left, the
// globals right-JUSTIFIED so their x-positions depend only on cols, never on
// the tab. Row B carries the current tab's commands in a fixed slot order.
// paintCmdBar and barHitKey share the ONE layout() computation, so render and
// hit-test cannot drift.
import type { Tab } from "./app.js";
import { Frame, SGR, displayWidth } from "./paint.js";
import { FG, RESET } from "./theme.js";

export interface BarButton {
  key: string;
  label: string;
}

/** Row A left: one slot per tab, constant order and position. */
const NAV: Array<BarButton & { tab: Tab }> = [
  { key: "1", label: "1 board", tab: "board" },
  { key: "2", label: "2 memory", tab: "digest" },
  { key: "3", label: "3 deploy", tab: "deploy" },
  { key: "4", label: "4 metrics", tab: "metrics" },
];

/** Row A right: always the same four, always in the same place. */
const GLOBALS: BarButton[] = [
  { key: "r", label: "r refresh" },
  { key: "s", label: "s ssh" },
  { key: "?", label: "? help" },
  { key: "q", label: "q quit" },
];

/** Row B: the tab's own commands, fixed slot order per tab. */
export const TAB_COMMANDS: Record<Tab, BarButton[]> = {
  board: [
    { key: "\r", label: "⏎ attach" },
    { key: "m", label: "m message" },
    { key: "w", label: "w detail" },
    { key: "g", label: "g github" },
    { key: "o", label: "o overseer" },
    { key: "M", label: "M main" },
    { key: "e", label: "e events" },
  ],
  digest: [
    { key: "v", label: "v view" },
    { key: "[", label: "[ older" },
    { key: "]", label: "] newer" },
    { key: "t", label: "t focus" },
    { key: "e", label: "e edit" },
    { key: "p", label: "p pin" },
    { key: "x", label: "x retire" },
    { key: "n", label: "n new" },
    { key: "A", label: "A accept" },
    { key: "R", label: "R reject" },
  ],
  deploy: [
    { key: "D", label: "D deploy" },
    { key: "S", label: "S power" },
    { key: "x", label: "x abort" },
  ],
  metrics: [
    { key: "7", label: "7 7d" },
    { key: "0", label: "0 30d" },
    { key: "a", label: "a all" },
    { key: "#", label: "# pr" },
  ],
};

/** Row A globals + the navigation keys every tab answers to. */
const GLOBAL_KEYS = ["q", "r", "s", "?", "1", "2", "3", "4", "j", "k"];

/** Printable keys a tab's own handler consumes BEYOND its row-B buttons. */
const TAB_EXTRA_KEYS: Record<Tab, string[]> = {
  board: ["a"], // ⏎'s full-screen-attach twin
  digest: ["a", "m", "w", "g", "o", "M"], // memory & learning row verbs
  deploy: [],
  metrics: [],
};

/**
 * smart routing's single source of truth: every printable the active
 * tab answers to. Anything OUTSIDE this set starts companion-strip input
 * instead of dying on the tab. Derived from the same TAB_COMMANDS the bar
 * paints, so a new button is automatically a registered key.
 */
export function registeredKeys(tab: Tab): Set<string> {
  return new Set([...GLOBAL_KEYS, ...TAB_EXTRA_KEYS[tab], ...TAB_COMMANDS[tab].map((b) => b.key)]);
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
 * The single slot-layout computation. Content starts at terminal column 2
 * (inside the `│` border); slots are separated by one space. Globals end at
 * column cols-1; a nav slot that would run under them is dropped whole — from
 * paint AND hit — rather than shifting anything. On a terminal too narrow for
 * the globals themselves, they drop and the nav keeps its constant positions.
 */
function layout(tab: Tab, cols: number): { a: Slot[]; b: Slot[] } {
  const a: Slot[] = [];
  let x = 2;
  for (const n of NAV) {
    const w = btnWidth(n.label);
    a.push({ key: n.key, label: n.label, x1: x, x2: x + w - 1, active: n.tab === tab });
    x += w + 1;
  }
  const gw = GLOBALS.reduce((s, g) => s + btnWidth(g.label), 0) + (GLOBALS.length - 1);
  const gx = cols - gw; // last global ends at cols-1
  if (gx >= 2) {
    while (a.length > 0 && a[a.length - 1]!.x2 >= gx - 1) a.pop();
    let g = gx;
    for (const gl of GLOBALS) {
      const w = btnWidth(gl.label);
      a.push({ key: gl.key, label: gl.label, x1: g, x2: g + w - 1, active: false });
      g += w + 1;
    }
  } else {
    while (a.length > 0 && a[a.length - 1]!.x2 > cols - 1) a.pop();
  }
  const b: Slot[] = [];
  x = 2;
  for (const c of TAB_COMMANDS[tab]) {
    const w = btnWidth(c.label);
    if (x + w - 1 > cols - 1) break;
    b.push({ key: c.key, label: c.label, x1: x, x2: x + w - 1, active: false });
    x += w + 1;
  }
  return { a, b };
}

/** Dim brackets, bold key glyph, normal label; the active nav slot inverse. */
function styleButton(s: Slot): string {
  if (s.active) return `${SGR.inverse}${SGR.bold}[${s.label}]${SGR.reset}`;
  const chars = [...s.label];
  const head = chars[0] ?? "";
  const rest = chars.slice(1).join("");
  return `${FG.dim}[${RESET}${SGR.bold}${head}${SGR.reset}${rest}${FG.dim}]${RESET}`;
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

/** Writes row A at frame row rows-3 and row B at rows-2, both boxed. */
export function paintCmdBar(frame: Frame, tab: Tab, cols: number, rows: number): void {
  const { a, b } = layout(tab, cols);
  frame.boxRow(rows - 3, [{ text: rowText(a), width: cols - 2 }]);
  frame.boxRow(rows - 2, [{ text: rowText(b), width: cols - 2 }]);
}

/**
 * 1-based terminal click → the button's key, or undefined. Terminal row for
 * frame row r is r+1, so row A answers at y = rows-2 and row B at y = rows-1.
 */
export function barHitKey(tab: Tab, x: number, y: number, cols: number, rows: number): string | undefined {
  if (y !== rows - 2 && y !== rows - 1) return undefined;
  const { a, b } = layout(tab, cols);
  for (const s of y === rows - 2 ? a : b) if (x >= s.x1 && x <= s.x2) return s.key;
  return undefined;
}

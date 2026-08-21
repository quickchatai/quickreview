// SGR mouse support (grill decision 2026-08-14: full pointer navigation).
// The terminal reports \x1b[<b;x;yM (press) / m (release); we decode presses,
// wheel steps, and hit-test them against the zones the renderer declared.
// ?1002h is BUTTON-EVENT tracking: motion reports while a button is held.
// Without it the terminal reports presses only, so there is no drag to follow
// — and an app that turns mouse reporting on has TAKEN the terminal's own
// selection away. Offering nothing in its place is what made text
// unselectable everywhere in the TUI.
export const MOUSE_ON = "\x1b[?1000h\x1b[?1002h\x1b[?1006h";
export const MOUSE_OFF = "\x1b[?1006l\x1b[?1002l\x1b[?1000l";

export type MouseEvent =
  | { kind: "click"; x: number; y: number } // 1-based cells
  | { kind: "drag"; x: number; y: number } // motion with the left button held
  | { kind: "release"; x: number; y: number }
  | { kind: "wheel-up"; x: number; y: number }
  | { kind: "wheel-down"; x: number; y: number };

const SGR_MOUSE_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

/** Extract mouse events from a raw stdin chunk; returns the remaining bytes
 * with the mouse reports removed (so key decoding never sees them). */
export function extractMouseEvents(buf: Buffer): { events: MouseEvent[]; rest: Buffer } {
  const s = buf.toString("utf8");
  if (!s.includes("\x1b[<")) return { events: [], rest: buf };
  const events: MouseEvent[] = [];
  for (const m of s.matchAll(SGR_MOUSE_RE)) {
    const b = Number(m[1]);
    const x = Number(m[2]);
    const y = Number(m[3]);
    const press = m[4] === "M";
    if (b === 64) events.push({ kind: "wheel-up", x, y });
    else if (b === 65) events.push({ kind: "wheel-down", x, y });
    // Motion carries bit 32; `32` is left-button-held motion, i.e. a drag.
    // Checked BEFORE the click case, which requires b < 32.
    else if (press && (b & 32) !== 0 && (b & 3) === 0) events.push({ kind: "drag", x, y });
    else if (press && (b & 3) === 0 && b < 32) events.push({ kind: "click", x, y }); // left press only
    else if (!press) events.push({ kind: "release", x, y });
  }
  const rest = Buffer.from(s.replace(SGR_MOUSE_RE, ""), "utf8");
  return { events, rest };
}

/** A clickable region declared by the renderer, 1-based inclusive cells. */
export interface Zone<A = string> {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  action: A;
}

export function hitTest<A>(zones: Zone<A>[], x: number, y: number): A | undefined {
  // Last-declared wins so fine-grained zones (a PR number inside a row)
  // override the row zone they sit on.
  for (let i = zones.length - 1; i >= 0; i--) {
    const z = zones[i]!;
    if (x >= z.x1 && x <= z.x2 && y >= z.y1 && y <= z.y2) return z.action;
  }
  return undefined;
}

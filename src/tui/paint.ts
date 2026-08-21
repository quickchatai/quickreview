// The thin ANSI layer (§4 verdict: no TUI framework — a few hundred
// lines of cursor-addressed painting). Pure string builders throughout; the
// only side effect lives in flush().
export const ESC = "\x1b[";
export const SGR = {
  reset: `${ESC}0m`,
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  inverse: `${ESC}7m`,
  red: `${ESC}31m`,
  green: `${ESC}32m`,
  yellow: `${ESC}33m`,
  cyan: `${ESC}36m`,
  bgRed: `${ESC}41m`,
};

export function rgb(r: number, g: number, b: number): string {
  return `${ESC}38;2;${r};${g};${b}m`;
}

// CSI sequences plus OSC (hyperlinks etc., \x07- or ST-terminated).
const ANSI_RE = /\x1b\[[0-9;?<]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/** Terminal cell width of one code point — CJK/fullwidth count 2. A heuristic
 * for chrome text only; the attach pane gets widths from @xterm/headless. */
export function charWidth(cp: number): number {
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
    return 2;
  return 1;
}

export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of stripAnsi(s)) w += charWidth(ch.codePointAt(0) ?? 0);
  return w;
}

const ANSI_AT_START = /^(?:\x1b\[[0-9;?<]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))/;

/** Truncate to `width` cells with a `…` when cut. ANSI-aware: escape
 * sequences are zero-width and never sliced mid-sequence; a truncated
 * styled string gets a trailing reset so styling can't leak. */
export function truncate(s: string, width: number): string {
  if (displayWidth(s) <= width) return s;
  let out = "";
  let w = 0;
  let i = 0;
  let styled = false;
  while (i < s.length) {
    const m = ANSI_AT_START.exec(s.slice(i));
    if (m) {
      out += m[0];
      styled = true;
      i += m[0].length;
      continue;
    }
    const cp = s.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const cw = charWidth(cp);
    if (w + cw > width - 1) break;
    out += ch;
    w += cw;
    i += ch.length;
  }
  return `${out}${styled ? "\x1b[0m" : ""}…`;
}

/** Sanitize foreign text (GitHub bodies, comments) for chrome painting:
 * normalize CRLF, expand tabs, drop C0/C1 controls - a stray CR painted
 * mid-row rehomes the cursor and overwrites the frame border. */
export function sanitizeText(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "  ")
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "");
}

/** Word-wrap plain (unstyled) text to `width` cells; words longer than a
 * line hard-break. Preserves paragraph breaks from the source. */
export function wrap(s: string, width: number): string[] {
  const w = Math.max(1, width);
  const out: string[] = [];
  for (const para of s.split("\n")) {
    if (para.trim().length === 0) {
      out.push("");
      continue;
    }
    let line = "";
    let lineW = 0;
    const flush = (): void => {
      if (lineW > 0) out.push(line);
      line = "";
      lineW = 0;
    };
    for (const word of para.split(/ +/)) {
      const ww = displayWidth(word);
      if (ww === 0) continue;
      if (ww > w) {
        // overlong word: flush, then emit full-width chunks
        flush();
        let piece = "";
        let pieceW = 0;
        for (const ch of word) {
          const cw = charWidth(ch.codePointAt(0) ?? 0);
          if (pieceW + cw > w) {
            out.push(piece);
            piece = "";
            pieceW = 0;
          }
          piece += ch;
          pieceW += cw;
        }
        line = piece;
        lineW = pieceW;
        continue;
      }
      if (lineW > 0 && lineW + 1 + ww > w) flush();
      if (lineW > 0) {
        line += " " + word;
        lineW += 1 + ww;
      } else {
        line = word;
        lineW = ww;
      }
    }
    flush();
  }
  return out;
}

/** Truncate-or-pad to exactly `width` cells. */
export function fit(s: string, width: number): string {
  const t = truncate(s, width);
  return t + " ".repeat(Math.max(0, width - displayWidth(t)));
}

/** `┌ left ── mid ─┐`-style horizontal rule filling `width` cells. */
export function rule(width: number, left: string, right: string, segments: string[]): string {
  const inner = segments.filter((s) => s.length > 0).join(" ── ");
  const label = inner.length > 0 ? ` ${inner} ` : "";
  const fitted = truncate(label, Math.max(0, width - 2 - 2));
  const fill = Math.max(0, width - 2 - displayWidth(fitted));
  return `${left}${fitted}${"─".repeat(fill)}${right}`;
}

/** Frame: fixed-size grid of styled lines, flushed as one write. Renderers
 * may also declare clickable `zones` and layout `meta` for the input layer. */
export class Frame {
  readonly lines: string[];
  zones: Array<{ x1: number; y1: number; x2: number; y2: number; action: unknown }> = [];
  meta: Record<string, number> = {};

  constructor(
    readonly cols: number,
    readonly rows: number,
  ) {
    this.lines = new Array<string>(rows).fill("");
  }

  set(row: number, content: string): void {
    if (row >= 0 && row < this.rows) this.lines[row] = content;
  }

  /** One boxed body row: `│<left fitted>│` or with a column divider. */
  boxRow(row: number, cells: Array<{ text: string; width: number }>): void {
    const body = cells.map((c) => fit(c.text, c.width)).join("│");
    this.set(row, `│${body}│`);
  }

  render(): string {
    // Home, then per-line erase — full repaint without scrollback pollution.
    let out = `${ESC}H`;
    for (const line of this.lines) out += `${line}${ESC}0m${ESC}K\r\n`;
    return out.slice(0, -2); // no trailing newline: the last row must not scroll
  }
}

/** Append a right-hand column to a frame (sidebar composition).
 *
 * Returns a NEW `Frame` of `inner.cols + width` columns and `inner.rows` rows;
 * `inner` is not mutated. Row `r` is `inner.lines[r]` concatenated with
 * `column[r]`. `zones` and `meta` are carried over unchanged: the column is
 * appended to the RIGHT of existing content, so no existing coordinate moves
 * (the inner tab must therefore have been rendered at the reduced width).
 *
 * Total by construction — a caller's bug can never break the frame's
 * row-width discipline (a ragged row shreds the border and rehomes the
 * cursor): a `column` shorter than `inner.rows` pads with blank cells, and an
 * entry of any other display width is `fit()`ed to exactly `width`. */
/** The box glyphs a bordered frame's rows END with. Only these are dropped at
 * the seam — anything else means the row is not a bordered row and is left
 * exactly as the renderer built it. */
const SEAM_GLYPHS = new Set(["│", "┐", "┘", "┤"]);

export function composeColumn(inner: Frame, column: string[], width: number, joinSeam = false): Frame {
  const w = Math.max(0, Math.floor(width));
  // Both halves draw a border at the seam, so a naive concatenation paints a
  // doubled wall (`││`, and `┐┬` at the corners). Joining drops the inner
  // frame's LAST cell and lets the column's own left border be the shared
  // divider — which is why the column carries `┬`/`┴` corners.
  const trim = (line: string): string =>
    joinSeam && SEAM_GLYPHS.has(line.slice(-1)) ? line.slice(0, -1) : line;
  const innerCols = joinSeam ? Math.max(0, inner.cols - 1) : inner.cols;
  const out = new Frame(innerCols + w, inner.rows);
  const blank = " ".repeat(w);
  for (let r = 0; r < inner.rows; r++) {
    const left = trim(inner.lines[r] ?? "");
    if (w === 0) {
      out.set(r, left);
      continue;
    }
    const cell = column[r];
    const right = cell === undefined ? blank : displayWidth(cell) === w ? cell : fit(cell, w);
    out.set(r, left + right);
  }
  out.zones = inner.zones.map((z) => ({ ...z }));
  out.meta = { ...inner.meta };
  return out;
}

/**
 * Overlay `overlay` onto `line` starting at DISPLAY column `at`.
 *
 * Used for modals painted over a finished frame. Splicing by code units would
 * cut an SGR run in half and bleed colour across the rest of the row (or worse,
 * split a wide character), so this walks the line cell by cell: escapes inside
 * the covered span are collected rather than emitted, and replayed immediately
 * after it so the tail keeps the styling it was written with.
 *
 * The result has the same display width as `line` when the overlay fits.
 */
export function spliceDisplay(line: string, at: number, overlay: string): string {
  const width = displayWidth(overlay);
  const end = at + width;
  let out = "";
  // Every SGR seen so far, in order — the ones already emitted before the span
  // AND the ones swallowed by it. The overlay writes a reset, so the tail must
  // be handed the whole run back to end up in the state it was written for;
  // SGR is cumulative, so replaying it reproduces that state exactly.
  let sgrSoFar = "";
  let col = 0;
  let i = 0;
  let placed = false;
  let restored = false;
  const place = (): void => {
    if (placed) return;
    out += `${ESC}0m${overlay}`;
    placed = true;
  };
  while (i < line.length) {
    const seq = /^\x1b\[[0-9;:?]*[A-Za-z]/.exec(line.slice(i))?.[0];
    if (seq !== undefined) {
      sgrSoFar += seq;
      if (!(col >= at && col < end)) out += seq;
      i += seq.length;
      continue;
    }
    const ch = String.fromCodePoint(line.codePointAt(i)!);
    const w = displayWidth(ch);
    if (col >= at && !placed) place();
    if (col >= end && !restored) {
      out += sgrSoFar;
      restored = true;
    }
    if (col < at || col >= end) out += ch;
    col += w;
    i += ch.length;
  }
  if (!placed) {
    out += " ".repeat(Math.max(0, at - col));
    place();
  }
  if (!restored) out += sgrSoFar;
  return out;
}

export const ALT_SCREEN_ON = `${ESC}?1049h${ESC}?25l`;
export const ALT_SCREEN_OFF = `${ESC}?25h${ESC}?1049l`;
export const CLEAR = `${ESC}2J${ESC}H`;

// The thin ANSI layer (§4 verdict: no TUI framework — a few hundred
// lines of cursor-addressed painting). Pure string builders throughout; the
// only side effect lives in flush().
export const ESC = "\x1b[";
/** Close every attribute. Zero display width, so it is safe to splice anywhere
 * a surface boundary needs to start from a known state. */
export const SGR_RESET = `${ESC}0m`;

/**
 * Does `line` end with any styling still switched on?
 *
 * Needed because a line that ends mid-style keeps painting: `Frame.render`
 * closes each row at its END, which stops styling leaking DOWNWARD, but
 * nothing stops it leaking RIGHTWARD — the row's padding, its border, and any
 * column composed beside it all inherit the open attribute.
 *
 * Foreign terminal output is where this bites. A tmux pane row has no reason to
 * end reset; measured on the live pr-5312 mirror, 7 of 23 captured rows ended
 * with a background or foreground still set. `ESC[39m` is the trap — it looks
 * like a reset and only restores the default FOREGROUND.
 *
 * Tracked rather than pattern-matched, so a row that legitimately ends clean
 * stays BYTE-IDENTICAL and the frame gains no escapes it does not need.
 * Ambiguity resolves toward "open": a redundant reset is invisible, a missing
 * one colours the neighbouring pane.
 */
export function sgrOpenAtEnd(line: string): boolean {
  const sgr = /\x1b\[([0-9;:]*)m/g;
  let fg = false;
  let bg = false;
  let attrs = 0;
  for (let m = sgr.exec(line); m !== null; m = sgr.exec(line)) {
    const body = m[1] ?? "";
    const codes = body === "" ? ["0"] : body.split(";");
    for (let i = 0; i < codes.length; i++) {
      const raw = codes[i] ?? "";
      const n = Number((raw === "" ? "0" : raw).split(":")[0]);
      if (!Number.isInteger(n)) continue;
      if (n === 0) {
        fg = false;
        bg = false;
        attrs = 0;
      } else if (n === 38 || n === 48) {
        // Extended colour: the remaining codes in THIS sequence are its
        // arguments, not attributes. Stopping here can leave a trailing `39`
        // unread, which only ever over-estimates "open" — the safe direction.
        if (n === 38) fg = true;
        else bg = true;
        break;
      } else if ((n >= 30 && n <= 37) || (n >= 90 && n <= 97)) fg = true;
      else if (n === 39) fg = false;
      else if ((n >= 40 && n <= 47) || (n >= 100 && n <= 107)) bg = true;
      else if (n === 49) bg = false;
      else if (n >= 1 && n <= 9) attrs |= 1 << n;
      else if (n === 22)
        attrs &= ~((1 << 1) | (1 << 2)); // clears bold AND dim
      else if (n >= 21 && n <= 29) attrs &= ~(1 << (n - 20));
    }
  }
  return fg || bg || attrs !== 0;
}

/** `line`, guaranteed to leave nothing switched on behind it. Byte-identical
 * when it already ends clean. */
export function closeSgr(line: string): string {
  return sgrOpenAtEnd(line) ? `${line}${SGR_RESET}` : line;
}
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

export function composeColumn(
  inner: Frame,
  column: string[],
  width: number,
  joinSeam = false,
): Frame {
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
    // Close the left half at the SEAM. The column is a different surface and
    // starts from default, always — otherwise a row that ends mid-style (an
    // embedded pi mirror does) paints the whole column in it. `closeSgr` is a
    // no-op on the rows that already end clean, which is nearly all of them.
    out.set(r, closeSgr(left) + right);
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
/**
 * The PLAIN text occupying display columns `[from, to)` of `line`.
 *
 * Not `stripAnsi(line).slice(from, to)`: that indexes by code unit, and one
 * double-width character makes every later index disagree with the column the
 * operator actually pointed at — you highlight, and copy, text from somewhere
 * else on the row. A straddling glyph becomes spaces for the cells that fall
 * inside the range, so the result is always exactly `to - from` cells wide
 * (or shorter, when the row ends first).
 */
export function sliceDisplay(line: string, from: number, to: number): string {
  let out = "";
  let col = 0;
  for (const ch of stripAnsi(line)) {
    const w = charWidth(ch.codePointAt(0) ?? 0);
    if (col >= to) break;
    if (col + w > from)
      out +=
        col < from || col + w > to ? " ".repeat(Math.min(to, col + w) - Math.max(from, col)) : ch;
    col += w;
  }
  return out;
}

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
  /** Cells of a wide character left visible on the far side of the span. */
  let tailSliver = 0;
  const place = (): void => {
    if (placed) return;
    out += `${ESC}0m${overlay}`;
    placed = true;
  };
  const restore = (): void => {
    if (restored) return;
    if (tailSliver > 0) {
      out += " ".repeat(tailSliver);
      tailSliver = 0;
    }
    out += sgrSoFar;
    restored = true;
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
    // A DOUBLE-WIDTH character can straddle either edge of the span: half of
    // it covered, half still visible. Emitting the whole glyph would make the
    // row one cell wider than it was — and a row wider than the frame WRAPS,
    // which pushes every row below it sideways and shreds the layout (the
    // 2026-08-21 screenshot). Replace each straddling glyph with spaces for
    // exactly the cells that remain visible, which is what terminals do with
    // their own selections.
    const overlaps = col < end && col + w > at;
    if (overlaps) {
      if (col < at) out += " ".repeat(at - col); // left sliver stays visible
      place();
      if (col + w > end) tailSliver += col + w - end; // right sliver, after the span
    } else {
      if (col >= end) restore();
      out += ch;
    }
    col += w;
    i += ch.length;
  }
  if (!placed) {
    out += " ".repeat(Math.max(0, at - col));
    place();
  }
  restore();
  return out;
}

const FRAME_GLYPHS = new Set(["┌", "┐", "└", "┘", "│", "─", "━", "┬", "┴", "├", "┤", "┼"]);

/** Accent only the existing frame glyphs on one rectangle. Content and labels
 * keep their own styling; the visible coloured square is focus chrome, not a
 * background wash over what the operator is reading. Coordinates are
 * zero-based display cells, inclusive. */
export function accentFrameRect(
  frame: Frame,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  accent: string,
  reset: string,
): void {
  const left = Math.max(0, Math.min(x1, frame.cols - 1));
  const right = Math.max(left, Math.min(x2, frame.cols - 1));
  const top = Math.max(0, Math.min(y1, frame.rows - 1));
  const bottom = Math.max(top, Math.min(y2, frame.rows - 1));
  for (let y = top; y <= bottom; y++) {
    const line = frame.lines[y] ?? "";
    const horizontal = y === top || y === bottom;
    let out = "";
    let activeSgr = "";
    let col = 0;
    let i = 0;
    // ONE pass per row. The first implementation called spliceDisplay once
    // per horizontal-rule cell, making every repaint quadratic in terminal
    // width and timing out the metrics interaction tests.
    while (i < line.length) {
      const seq = /^\x1b\[[0-9;:?]*[A-Za-z]/.exec(line.slice(i))?.[0];
      if (seq !== undefined) {
        out += seq;
        if (seq.endsWith("m")) activeSgr = seq === `${ESC}0m` ? "" : `${activeSgr}${seq}`;
        i += seq.length;
        continue;
      }
      const ch = String.fromCodePoint(line.codePointAt(i)!);
      const width = displayWidth(ch);
      const onEdge = horizontal ? col >= left && col <= right : col === left || col === right;
      out += onEdge && FRAME_GLYPHS.has(ch) ? `${accent}${ch}${reset}${activeSgr}` : ch;
      col += width;
      i += ch.length;
    }
    frame.set(y, out);
  }
}

export const ALT_SCREEN_ON = `${ESC}?1049h${ESC}?25l`;
export const ALT_SCREEN_OFF = `${ESC}?25h${ESC}?1049l`;
export const CLEAR = `${ESC}2J${ESC}H`;

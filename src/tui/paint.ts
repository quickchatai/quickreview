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

const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]/g;

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

/** Truncate to `width` cells with a `…` when cut; ANSI-free input expected. */
export function truncate(s: string, width: number): string {
  if (displayWidth(s) <= width) return s;
  let out = "";
  let w = 0;
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0) ?? 0);
    if (w + cw > width - 1) break;
    out += ch;
    w += cw;
  }
  return `${out}…`;
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

/** Frame: fixed-size grid of styled lines, flushed as one write. */
export class Frame {
  readonly lines: string[];

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

export const ALT_SCREEN_ON = `${ESC}?1049h${ESC}?25l`;
export const ALT_SCREEN_OFF = `${ESC}?25h${ESC}?1049l`;
export const CLEAR = `${ESC}2J${ESC}H`;

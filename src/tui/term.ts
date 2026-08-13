// TermPane — @xterm/headless as the screen model, painted with direct
// truecolor ANSI (§2/§4: xterm is a model, not a painter; the cell
// walk is ours, cribbed from blessed-xterm but emitting 38;2 verbatim so pi's
// colors survive end-to-end).
import { Terminal } from "@xterm/headless";

const ESC = "\x1b[";

function fgSgr(cell: { isFgRGB(): boolean; isFgPalette(): boolean; isFgDefault(): boolean; getFgColor(): number }): string {
  if (cell.isFgDefault()) return "39";
  const c = cell.getFgColor();
  if (cell.isFgRGB()) return `38;2;${(c >> 16) & 0xff};${(c >> 8) & 0xff};${c & 0xff}`;
  return `38;5;${c}`;
}

function bgSgr(cell: { isBgRGB(): boolean; isBgPalette(): boolean; isBgDefault(): boolean; getBgColor(): number }): string {
  if (cell.isBgDefault()) return "49";
  const c = cell.getBgColor();
  if (cell.isBgRGB()) return `48;2;${(c >> 16) & 0xff};${(c >> 8) & 0xff};${c & 0xff}`;
  return `48;5;${c}`;
}

export class TermPane {
  readonly term: Terminal;

  constructor(cols: number, rows: number) {
    this.term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 0 });
  }

  write(data: string | Uint8Array, cb?: () => void): void {
    this.term.write(data, cb);
  }

  resize(cols: number, rows: number): void {
    this.term.resize(cols, rows);
  }

  dispose(): void {
    this.term.dispose();
  }

  /** Paint the whole screen model into the host terminal starting at
   * `offsetRow` (0-based), returning one ANSI string: per-row cursor
   * addressing, SGR runs, and a final cursor-position matching the model. */
  renderFrame(offsetRow: number): string {
    const buf = this.term.buffer.active;
    const cols = this.term.cols;
    const rows = this.term.rows;
    let out = "";
    for (let y = 0; y < rows; y++) {
      out += `${ESC}${offsetRow + y + 1};1H`;
      const line = buf.getLine(buf.viewportY + y);
      if (!line) {
        out += `${ESC}0m${ESC}2K`;
        continue;
      }
      let lastSgr = "";
      let x = 0;
      while (x < cols) {
        const cell = line.getCell(x);
        if (!cell) break;
        const width = cell.getWidth();
        if (width === 0) {
          x++; // trailing half of a wide char — already emitted
          continue;
        }
        const attrs: string[] = ["0"];
        if (cell.isBold()) attrs.push("1");
        if (cell.isDim()) attrs.push("2");
        if (cell.isItalic()) attrs.push("3");
        if (cell.isUnderline()) attrs.push("4");
        if (cell.isInverse()) attrs.push("7");
        if (cell.isStrikethrough()) attrs.push("9");
        attrs.push(fgSgr(cell), bgSgr(cell));
        const sgr = attrs.join(";");
        if (sgr !== lastSgr) {
          out += `${ESC}${sgr}m`;
          lastSgr = sgr;
        }
        out += cell.getChars() || " ";
        x += width;
      }
      out += `${ESC}0m${ESC}K`;
    }
    // Host cursor tracks the model's cursor inside the pane.
    out += `${ESC}${offsetRow + buf.cursorY + 1};${buf.cursorX + 1}H`;
    return out;
  }
}

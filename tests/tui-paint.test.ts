// the frame compositor that hangs the companion sidebar column off
// the right edge of any tab's frame. Row-width discipline is the whole point —
// a ragged row shreds the border and rehomes the cursor.
import { describe, expect, it } from "vitest";
import { composeColumn, displayWidth, fit, Frame, SGR, stripAnsi } from "../src/tui/paint.js";

const COLS = 20;
const ROWS = 4;

function innerFrame(cols = COLS, rows = ROWS): Frame {
  const f = new Frame(cols, rows);
  f.set(0, `┌${"─".repeat(cols - 2)}┐`);
  f.set(1, `│${fit(`${SGR.cyan}styled${SGR.reset} 日本`, cols - 2)}│`);
  f.set(2, `│${fit("plain row", cols - 2)}│`);
  f.set(3, `└${"─".repeat(cols - 2)}┘`);
  f.zones = [{ x1: 2, y1: 3, x2: cols - 1, y2: 3, action: { t: "select-pr", pr: 5265 } }];
  f.meta = { listW: 8, bodyRows: 2 };
  return f;
}

/** A well-formed sidebar column: exactly `rows` strings of width `width`. */
function column(width: number, rows = ROWS): string[] {
  const out = [`┬${"─".repeat(width - 2)}┐`];
  for (let r = 1; r < rows - 1; r++) out.push(`│${fit(`${SGR.dim}pi ${r} 日本${SGR.reset}`, width - 2)}│`);
  out.push(`┴${"─".repeat(width - 2)}┘`);
  return out;
}

describe("composeColumn", () => {
  it("returns a new frame of inner.cols + width, every row exactly that wide", () => {
    const inner = innerFrame();
    const out = composeColumn(inner, column(10), 10);
    expect(out).not.toBe(inner);
    expect(out.cols).toBe(COLS + 10);
    expect(out.rows).toBe(ROWS);
    for (const line of out.lines) expect(displayWidth(line)).toBe(COLS + 10);
  });

  it("keeps styling and wide characters from both halves", () => {
    const inner = innerFrame();
    const out = composeColumn(inner, column(12), 12);
    expect(out.lines[1]).toContain(SGR.cyan);
    expect(out.lines[1]).toContain(SGR.dim);
    expect(stripAnsi(out.lines[1]!)).toContain("日本");
    // one row = the inner row, then the column row
    expect(out.lines[1]).toBe(inner.lines[1]! + column(12)[1]!);
    expect(displayWidth(out.lines[1]!)).toBe(COLS + 12);
  });

  it("carries zones and meta over unchanged (no coordinate moves)", () => {
    const inner = innerFrame();
    const out = composeColumn(inner, column(10), 10);
    expect(out.zones).toEqual(inner.zones);
    expect(out.meta).toEqual(inner.meta);
    // copies, not aliases: mutating the composed frame must not touch inner
    out.zones.push({ x1: 1, y1: 1, x2: 1, y2: 1, action: null });
    out.meta.listW = 99;
    expect(inner.zones).toHaveLength(1);
    expect(inner.meta.listW).toBe(8);
  });

  it("pads with blank cells when the column is short", () => {
    const inner = innerFrame();
    const out = composeColumn(inner, ["│abc│"], 5);
    expect(out.lines[0]).toBe(inner.lines[0]! + "│abc│");
    for (let r = 1; r < ROWS; r++) {
      expect(out.lines[r]).toBe(inner.lines[r]! + "     ");
      expect(displayWidth(out.lines[r]!)).toBe(COLS + 5);
    }
  });

  it("pads with blank cells for an empty column and ignores extra entries", () => {
    const inner = innerFrame();
    const empty = composeColumn(inner, [], 6);
    for (const line of empty.lines) expect(displayWidth(line)).toBe(COLS + 6);
    const over = composeColumn(inner, [...column(6), "│zz│", "│yy│"], 6);
    expect(over.lines).toHaveLength(ROWS);
    for (const line of over.lines) expect(displayWidth(line)).toBe(COLS + 6);
  });

  it("fits entries that are too wide or too narrow", () => {
    const inner = innerFrame();
    const out = composeColumn(inner, ["│a very long sidebar row that overflows│", "│x│", `│${SGR.red}日本語日本語${SGR.reset}│`, ""], 8);
    for (const line of out.lines) expect(displayWidth(line)).toBe(COLS + 8);
    expect(out.lines[0]).toBe(inner.lines[0]! + fit("│a very long sidebar row that overflows│", 8));
    expect(stripAnsi(out.lines[0]!)).toMatch(/…$/); // over-wide entry truncated
    expect(out.lines[1]).toBe(inner.lines[1]! + "│x│     "); // narrow entry padded
    expect(out.lines[2]).toContain(SGR.red);
  });

  it("leaves the inner frame untouched", () => {
    const inner = innerFrame();
    const before = [...inner.lines];
    composeColumn(inner, column(10), 10);
    expect(inner.lines).toEqual(before);
    expect(inner.cols).toBe(COLS);
    for (const line of inner.lines) expect(displayWidth(line)).toBe(COLS);
  });

  it("width 0 (sidebar hidden) is a faithful copy", () => {
    const inner = innerFrame();
    const out = composeColumn(inner, [], 0);
    expect(out.cols).toBe(COLS);
    expect(out.lines).toEqual(inner.lines);
    expect(out.zones).toEqual(inner.zones);
  });

  describe("joinSeam", () => {
    // Both halves draw a border where they meet. Without joining, the frame
    // paints a doubled wall — `││` down the body and `┐┬` at the corners —
    // which reads as two separate windows rather than one.
    it("drops the inner frame's border cell so the two share one wall", () => {
      const inner = new Frame(10, 3);
      inner.set(0, "┌────────┐");
      inner.boxRow(1, [{ text: " body", width: 8 }]);
      inner.set(2, "└────────┘");
      const col = ["┬───┐", "│ x │", "┴───┘"];
      const out = composeColumn(inner, col, 5, true);
      expect(out.cols).toBe(14); // 10 - 1 + 5
      expect(out.lines[0]).toBe("┌────────┬───┐");
      expect(out.lines[1]).toBe("│ body   │ x │");
      expect(out.lines[2]).toBe("└────────┴───┘");
      for (const line of out.lines) expect(displayWidth(line)).toBe(14);
    });

    it("leaves a row that does not end in a border glyph alone", () => {
      // Defensive: a renderer emitting an unbordered row must not silently
      // lose its last character — that would be a content bug, not a seam.
      const inner = new Frame(4, 1);
      inner.set(0, "abcd");
      const out = composeColumn(inner, ["│ y │"], 5, true);
      expect(out.lines[0]).toBe("abcd│ y │");
    });

    it("is off by default — the old concatenation is unchanged", () => {
      const inner = new Frame(3, 1);
      inner.set(0, "ab│");
      expect(composeColumn(inner, ["│z"], 2).lines[0]).toBe("ab││z");
    });
  });
});

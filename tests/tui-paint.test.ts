// The frame compositor that hangs the companion sidebar column off
// the right edge of any tab's frame. Row-width discipline is the whole point —
// a ragged row shreds the border and rehomes the cursor.
import { describe, expect, it } from "vitest";
import {
  closeSgr,
  composeColumn,
  displayWidth,
  fit,
  Frame,
  SGR,
  sgrOpenAtEnd,
  sliceDisplay,
  spliceDisplay,
  stripAnsi,
} from "../src/tui/paint.js";

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
  for (let r = 1; r < rows - 1; r++)
    out.push(`│${fit(`${SGR.dim}pi ${r} 日本${SGR.reset}`, width - 2)}│`);
  out.push(`┴${"─".repeat(width - 2)}┘`);
  return out;
}

// A row that ends mid-style lets the board's embedded pi mirror colour the
// companion sidebar. `Frame.render` resets at each row's END,
// so styling never leaks DOWNWARD — but nothing stopped it leaking RIGHTWARD
// across the row into the column composed beside it.
describe("styling never crosses a surface boundary", () => {
  it("sees through the ESC[39m trap — it restores the FOREGROUND only", () => {
    // The shape the live mirror produces: a background is set, then
    // the row ends on `39`, which looks like a reset and closes nothing of it.
    expect(sgrOpenAtEnd("\x1b[41mred bg\x1b[39m   ")).toBe(true);
    expect(sgrOpenAtEnd("\x1b[31mred fg\x1b[39m   ")).toBe(false);
  });

  it("knows a genuinely closed row from an open one", () => {
    expect(sgrOpenAtEnd("plain text, no escapes")).toBe(false);
    expect(sgrOpenAtEnd("\x1b[36mcyan\x1b[0m")).toBe(false);
    expect(sgrOpenAtEnd("\x1b[1mbold then \x1b[22mnot")).toBe(false); // 22 clears bold AND dim
    expect(sgrOpenAtEnd("\x1b[7mreverse video")).toBe(true);
    expect(sgrOpenAtEnd("\x1b[38;5;103mextended fg")).toBe(true);
    expect(sgrOpenAtEnd("\x1b[48;2;10;20;30mtruecolor bg")).toBe(true);
  });

  it("leaves a clean row byte-identical — the frame gains no escapes it needs", () => {
    const clean = "\x1b[36mcyan\x1b[0m";
    expect(closeSgr(clean)).toBe(clean);
    expect(closeSgr("plain")).toBe("plain");
    expect(closeSgr("\x1b[41mopen")).toBe("\x1b[41mopen\x1b[0m");
  });

  it("stops a mid-style row from colouring the column beside it", () => {
    const inner = new Frame(10, 1);
    inner.set(0, "\x1b[41mleaky bg"); // ends with the background still on
    const out = composeColumn(inner, ["COL"], 3);
    // The column's own text must start from default, not inherit the red.
    const row = out.lines[0]!;
    expect(row.indexOf("\x1b[0m")).toBeGreaterThan(-1);
    expect(row.indexOf("\x1b[0m")).toBeLessThan(row.indexOf("COL"));
    expect(sgrOpenAtEnd(row.slice(0, row.indexOf("COL")))).toBe(false);
  });
});

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
    const out = composeColumn(
      inner,
      [
        "│a very long sidebar row that overflows│",
        "│x│",
        `│${SGR.red}日本語日本語${SGR.reset}│`,
        "",
      ],
      8,
    );
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

describe("spliceDisplay", () => {
  it("overlays at a display column and keeps the row's width", () => {
    const line = "0123456789";
    const out = spliceDisplay(line, 3, "XX");
    expect(out).toContain("XX");
    expect(stripAnsi(out)).toBe("012XX56789");
    expect(displayWidth(stripAnsi(out))).toBe(10);
  });

  it("does not cut an SGR run in half — the tail keeps its colour", () => {
    // The whole reason this exists: slicing by code units would land inside
    // "\x1b[31m" and bleed a broken escape across the rest of the row.
    const line = `${SGR.red}abcdefgh${SGR.reset}`;
    const out = spliceDisplay(line, 2, "##");
    expect(stripAnsi(out)).toBe("ab##efgh");
    // The colour that was covered is replayed after the overlay, so "efgh" is
    // still red rather than inheriting the overlay's reset.
    expect(out.indexOf(SGR.red)).toBeLessThan(out.indexOf("##"));
    expect(out.slice(out.indexOf("##"))).toContain(SGR.red);
  });

  it("survives wide characters on both sides", () => {
    const out = spliceDisplay("日本語です", 2, "AB");
    expect(displayWidth(stripAnsi(out))).toBe(10);
  });

  it("pads when the overlay starts past the end of the line", () => {
    expect(stripAnsi(spliceDisplay("ab", 5, "X"))).toBe("ab   X");
  });
});

describe("width safety under selection", () => {
  // A row wider than the frame wraps, and every row below it shifts — which
  // is how a selection drag shreds the layout. These walk every boundary
  // rather than sampling, because the break happens only where an edge lands
  // inside a wide glyph.
  const LINES = [
    "| ab日本語 cd efgh |",
    `| ${SGR.red}styled${SGR.reset} 日本 tail |`,
    "| plain ascii only, nothing exotic |",
    "|日本語日本語|",
  ];

  it("spliceDisplay never changes a row's width, at ANY offset or length", () => {
    for (const line of LINES) {
      const base = displayWidth(line);
      for (let at = 0; at <= base; at++) {
        for (const len of [1, 2, 3, 5, 8, 13]) {
          const to = Math.min(base, at + len);
          if (to <= at) continue;
          const span = sliceDisplay(line, at, to);
          const out = spliceDisplay(line, at, `${SGR.inverse}${span}${SGR.reset}`);
          expect(displayWidth(out), `at=${at} to=${to} on ${JSON.stringify(line)}`).toBe(base);
        }
      }
    }
  });

  it("sliceDisplay returns exactly the cells asked for, wide glyphs included", () => {
    for (const line of LINES) {
      const base = displayWidth(line);
      for (let from = 0; from < base; from++) {
        for (const len of [1, 2, 4, 7]) {
          const to = Math.min(base, from + len);
          expect(displayWidth(sliceDisplay(line, from, to)), `${from}..${to}`).toBe(to - from);
        }
      }
    }
  });

  it("indexes by COLUMN, not code unit — the wrong-text bug", () => {
    // "日本語" is 3 characters but 6 columns. Asking for columns 8..12 must
    // return what is painted there, not the 8th..12th characters.
    // "|"=col0, " "=col1, 日本語=cols2..7 (three chars, six columns),
    // " "=col8, then "abcdef" from col9.
    const line = "| 日本語 abcdef |";
    expect(sliceDisplay(line, 9, 13)).toBe("abcd");
    // A code-unit slice lands four characters early, putting the highlight
    // over text the operator never pointed at.
    expect(stripAnsi(line).slice(9, 13)).not.toBe("abcd");
  });

  it("splits a straddling wide glyph into spaces on both sides", () => {
    // Half a glyph cannot be painted, so the visible half becomes a space —
    // what terminals do with their own selections. Anything else changes the
    // cell count.
    const line = "ab日cd";
    const out = spliceDisplay(line, 3, `${SGR.inverse}X${SGR.reset}`); // cuts 日 in half
    expect(displayWidth(out)).toBe(displayWidth(line));
    expect(stripAnsi(out)).toBe("ab Xcd"); // left sliver becomes a space
  });
});

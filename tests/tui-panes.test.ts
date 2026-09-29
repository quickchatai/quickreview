import { describe, expect, it } from "vitest";
import { Frame, stripAnsi } from "../src/tui/paint.js";
import { paintSplit, splitWidths, zonedRow } from "../src/tui/panes.js";

describe("paintSplit click zones", () => {
  it("every right-pane zone covers exactly the painted characters of its chunk", () => {
    const cols = 80;
    const { leftW, rightW } = splitWidths(cols);
    const frame = new Frame(cols, 4);
    const row = zonedRow<string>([
      { text: "retire", action: "retire" },
      { text: "pin", action: "pin" },
    ]);
    paintSplit(frame, {
      left: ["item"],
      leftActions: ["select"],
      right: [row],
      leftW,
      rightW,
      top: 1,
      bodyRows: 1,
    });
    const painted = stripAnsi(frame.lines[1] ?? "");
    for (const z of frame.zones.filter((z) => z.action !== "select")) {
      // Zones are 1-based inclusive terminal columns.
      const text = painted.slice(z.x1 - 1, z.x2);
      expect(text).toBe(z.action);
      expect(z.y1).toBe(2);
    }
    expect(frame.zones.filter((z) => z.action !== "select")).toHaveLength(2);
  });
});

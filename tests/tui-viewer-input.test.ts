// The viewer's input line as a pure state machine and a painted row
// (src/tui/viewerinput.ts); the App wiring is in tui-viewer-pane.test.ts.
import { describe, expect, it } from "vitest";
import { CONTROL_TEXT_MAX } from "../src/commands.js";
import { displayWidth, stripAnsi } from "../src/tui/paint.js";
import {
  newViewerInput,
  viewerInputKey,
  viewerInputRow,
  type ViewerInput,
} from "../src/tui/viewerinput.js";

const press = (s: ViewerInput, running: boolean, ...keys: string[]) =>
  keys.reduce(
    (acc, k) => {
      const r = viewerInputKey(acc.state, k, running);
      return { state: r.state, effects: [...acc.effects, r.effect], handled: r.handled };
    },
    { state: s, effects: [] as ReturnType<typeof viewerInputKey>["effect"][], handled: true },
  );

describe("viewerInputKey", () => {
  it("leaves the navigation keys alone only while the line is empty", () => {
    for (const k of ["[", "]", "<", ">"]) {
      expect(viewerInputKey(newViewerInput(), k, true).handled, k).toBe(false);
      const typed = viewerInputKey({ ...newViewerInput(), text: "a" }, k, true);
      expect(typed.handled, k).toBe(true);
      expect(typed.state.text).toBe(`a${k}`);
    }
  });

  it("does not take scrolling keys or escape sequences it does not know", () => {
    for (const k of ["\x1b[5~", "\x1b[6~", "\x1b[A", "\x1b[B", "\x1b[F", "\x1b[200~x"])
      expect(viewerInputKey({ ...newViewerInput(), text: "a" }, k, true).handled, k).toBe(false);
  });

  it("⏎ steers while running, sends a message when idle, trims, and ignores an empty line", () => {
    expect(press({ ...newViewerInput(), text: "  hi  " }, true, "\r").effects).toEqual([
      { t: "send", kind: "steer", text: "hi" },
    ]);
    expect(press({ ...newViewerInput(), text: "hi" }, false, "\r").effects).toEqual([
      { t: "send", kind: "message", text: "hi", may_post: false },
    ]);
    expect(press(newViewerInput(), true, "\r").effects).toEqual([{ t: "none" }]);
    expect(press({ ...newViewerInput(), text: "   " }, true, "\n").effects).toEqual([
      { t: "none" },
    ]);
  });

  it("may_post is carried by an idle message only, and resets on any send", () => {
    const on = press(newViewerInput(), false, "\x1bp").state;
    expect(on.mayPost).toBe(true);
    const sent = press({ ...on, text: "x" }, false, "\r");
    expect(sent.effects).toEqual([{ t: "send", kind: "message", text: "x", may_post: true }]);
    expect(sent.state.mayPost).toBe(false);
    const steered = press({ ...on, text: "x" }, true, "\r");
    expect(steered.effects).toEqual([{ t: "send", kind: "steer", text: "x" }]);
    expect(steered.state.mayPost).toBe(false);
  });

  it("the abort prompt takes exactly the next key", () => {
    const asked = press(newViewerInput(), true, "\x03");
    expect(asked.state.confirmAbort).toBe(true);
    expect(press(asked.state, true, "y").effects).toEqual([{ t: "abort" }]);
    expect(press(asked.state, true, "Y").effects).toEqual([{ t: "abort" }]);
    for (const k of ["n", "\r", "\x1b", "\x03", " "]) {
      const r = press(asked.state, true, k);
      expect(r.effects, k).toEqual([{ t: "none" }]);
      expect(r.state.confirmAbort, k).toBe(false);
    }
  });

  it("the draft is capped at the command's own text limit", () => {
    const r = press(newViewerInput(), true, "x".repeat(CONTROL_TEXT_MAX + 50));
    expect(r.state.text).toHaveLength(CONTROL_TEXT_MAX);
  });

  it("control bytes in a paste never reach the draft", () => {
    expect(press(newViewerInput(), true, "a\x07b\x00c").state.text).toBe("abc");
  });
});

describe("viewerInputRow", () => {
  const view = (over: object) => ({
    ...newViewerInput(),
    running: true,
    focused: true,
    pr: 7,
    ...over,
  });

  it("never paints wider than its row, at any width and draft length", () => {
    for (const width of [1, 4, 8, 12, 20, 40, 80, 120])
      for (const text of ["", "short", "x".repeat(300), "日本語のテキスト".repeat(20)])
        for (const mayPost of [false, true])
          for (const running of [false, true]) {
            const row = stripAnsi(viewerInputRow(view({ text, mayPost, running }), width));
            expect(displayWidth(row), `${width} ${text.slice(0, 6)}`).toBeLessThanOrEqual(width);
          }
  });

  it("keeps the end of a long draft (where the cursor is)", () => {
    const row = stripAnsi(viewerInputRow(view({ text: `${"a".repeat(200)}END` }), 60));
    expect(row).toContain("END▌");
    expect(row).toContain("▌");
  });

  it("shows the toggle's state, and the prompt when asked to abort", () => {
    expect(stripAnsi(viewerInputRow(view({ mayPost: true, running: false }), 80))).toContain(
      "[Alt-p post: ON]",
    );
    expect(stripAnsi(viewerInputRow(view({ confirmAbort: true }), 80))).toContain(
      "abort the running round of #7? y = abort",
    );
  });

  it("fits the abort prompt and the unfocused hint to the width", () => {
    for (const width of [1, 8, 20, 40])
      for (const over of [{ confirmAbort: true }, { focused: false }, { focused: false, running: false }]) {
        const row = stripAnsi(viewerInputRow(view(over), width));
        expect(displayWidth(row), `${width} ${JSON.stringify(over)}`).toBeLessThanOrEqual(width);
      }
  });
});

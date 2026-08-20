// The shared two-row command bar: paint/hit share one layout (round-trip
// pinned here), globals keep the same x on every tab (the constant-position
// guarantee), the active nav slot is highlighted, and an App-level click on a
// bar button IS that keypress (quit from a non-board tab).
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { TUI_DEFAULTS } from "../src/config.js";
import { App, type Tab } from "../src/tui/app.js";
import { barHitKey, paintCmdBar, TAB_COMMANDS } from "../src/tui/cmdbar.js";
import { Frame, stripAnsi } from "../src/tui/paint.js";

const TABS: Tab[] = ["board", "digest", "deploy", "metrics"];
const NAV: Array<[string, string]> = [
  ["1", "1 board"],
  ["2", "2 memory"],
  ["3", "3 deploy"],
  ["4", "4 metrics"],
];
const GLOBALS: Array<[string, string]> = [
  ["r", "r refresh"],
  ["s", "s ssh"],
  ["?", "? help"],
  ["q", "q quit"],
];

function paint(tab: Tab, cols: number, rows: number): Frame {
  const frame = new Frame(cols, rows);
  paintCmdBar(frame, tab, cols, rows);
  return frame;
}

/** Contiguous hit runs along a bar row: which key answers at which x-range. */
function hitRuns(tab: Tab, y: number, cols: number, rows: number): Array<{ key: string; x1: number; x2: number }> {
  const runs: Array<{ key: string; x1: number; x2: number }> = [];
  for (let x = 2; x <= cols - 1; x++) {
    const k = barHitKey(tab, x, y, cols, rows);
    if (k === undefined) continue;
    const last = runs[runs.length - 1];
    if (last && last.key === k && last.x2 === x - 1) last.x2 = x;
    else runs.push({ key: k, x1: x, x2: x });
  }
  return runs;
}

describe("layout/hit round-trip", () => {
  for (const tab of ["board", "digest"] as const) {
    for (const cols of [120, 180]) {
      it(`${tab} @ ${cols} cols: every button's rendered cells hit back to its key`, () => {
        const rows = 40;
        const frame = paint(tab, cols, rows);
        const plainA = stripAnsi(frame.lines[rows - 3]!);
        const plainB = stripAnsi(frame.lines[rows - 2]!);
        const wantA = [...NAV, ...GLOBALS];
        const wantB = TAB_COMMANDS[tab].map((b) => [b.key, b.label] as [string, string]);
        const runsA = hitRuns(tab, rows - 2, cols, rows); // terminal y = frame row + 1
        const runsB = hitRuns(tab, rows - 1, cols, rows);
        expect(runsA.map((r) => r.key)).toEqual(wantA.map(([k]) => k));
        expect(runsB.map((r) => r.key)).toEqual(wantB.map(([k]) => k));
        // …and the hit range covers exactly the rendered `[label]` cells.
        runsA.forEach((r, i) => expect(plainA.slice(r.x1 - 1, r.x2)).toBe(`[${wantA[i]![1]}]`));
        runsB.forEach((r, i) => expect(plainB.slice(r.x1 - 1, r.x2)).toBe(`[${wantB[i]![1]}]`));
        // Between buttons and off the two bar rows: nothing.
        expect(barHitKey(tab, runsA[0]!.x2 + 1, rows - 2, cols, rows)).toBeUndefined();
        expect(barHitKey(tab, runsA[0]!.x1, rows - 5, cols, rows)).toBeUndefined();
      });
    }
  }
});

describe("constant positions", () => {
  it("globals sit at identical x-ranges on all four tabs (fixed cols)", () => {
    const cols = 132;
    const rows = 36;
    const positions = TABS.map((tab) =>
      hitRuns(tab, rows - 2, cols, rows)
        .filter((r) => GLOBALS.some(([k]) => k === r.key))
        .map((r) => `${r.key}:${r.x1}-${r.x2}`)
        .join(" "),
    );
    expect(positions[0]).toContain("q:");
    for (const p of positions) expect(p).toBe(positions[0]);
  });

  it("nav slots too: row A hit ranges are identical on every tab", () => {
    const cols = 132;
    const rows = 36;
    const ranges = TABS.map((tab) =>
      hitRuns(tab, rows - 2, cols, rows)
        .map((r) => `${r.x1}-${r.x2}`)
        .join(" "),
    );
    for (const r of ranges) expect(r).toBe(ranges[0]);
  });
});

describe("active-tab highlight", () => {
  it("inverses exactly the current tab's nav slot", () => {
    const rows = 30;
    for (const tab of TABS) {
      const raw = paint(tab, 140, rows).lines[rows - 3]!;
      const label = NAV.find(([, l]) => l.startsWith({ board: "1", digest: "2", deploy: "3", metrics: "4" }[tab]))![1];
      expect(raw).toContain(`\x1b[7m\x1b[1m[${label}]`);
      expect(raw.split("\x1b[7m").length).toBe(2); // one inverse run only
    }
  });
});

describe("App-level bar clicks", () => {
  function fakeStreams(cols: number, rows: number) {
    const out = new EventEmitter() as unknown as NodeJS.WriteStream;
    let buf = "";
    (out as unknown as { columns: number }).columns = cols;
    (out as unknown as { rows: number }).rows = rows;
    out.write = ((s: string) => ((buf += s), true)) as never;
    const input = new EventEmitter() as unknown as NodeJS.ReadStream;
    (input as unknown as { isTTY: boolean }).isTTY = false;
    input.resume = (() => input) as never;
    input.pause = (() => input) as never;
    return { out, input, written: () => buf };
  }

  it("a click on the quit slot quits, from a non-board tab", async () => {
    const { out, input } = fakeStreams(120, 30);
    const app = new App(TUI_DEFAULTS, async () => ({ ok: true, stdout: "", stderr: "", code: 0 }), out, input);
    app.tab = "deploy";
    let qx: number | undefined;
    for (let x = 2; x < 120 && qx === undefined; x++) if (barHitKey("deploy", x, 28, 120, 30) === "q") qx = x;
    expect(qx).toBeDefined();
    const running = app.run();
    (input as unknown as EventEmitter).emit("data", Buffer.from(`\x1b[<0;${qx};28M`));
    await running; // resolves only because the click became a real `q`
  });

  it("bar clicks are INERT while an input box is open (review P1: [enter] must not submit a draft)", async () => {
    const { out, input } = fakeStreams(120, 30);
    const app = new App(TUI_DEFAULTS, async () => ({ ok: true, stdout: "", stderr: "", code: 0 }), out, input);
    app.tab = "board";
    const sent: string[] = [];
    app.hooks.sendMessage = (_s, text) => void sent.push(text);
    let ex: number | undefined; // the board row-B enter button
    for (let x = 2; x < 120 && ex === undefined; x++) if (barHitKey("board", x, 29, 120, 30) === "\r") ex = x;
    expect(ex).toBeDefined();
    let qx: number | undefined;
    for (let x = 2; x < 120 && qx === undefined; x++) if (barHitKey("board", x, 28, 120, 30) === "q") qx = x;
    const running = app.run();
    app.openMessageBox("pr-5012");
    (input as unknown as EventEmitter).emit("data", Buffer.from("draft"));
    (input as unknown as EventEmitter).emit("data", Buffer.from(`\x1b[<0;${ex};29M`)); // click [⏎] — must NOT submit
    expect(sent).toEqual([]);
    expect(app.view.inputBox).toBeDefined();
    expect(app.view.inputBox!.text).toBe("draft"); // and no key was typed into the box
    (input as unknown as EventEmitter).emit("data", Buffer.from(`\x1b[<0;${qx};28M`)); // click [q] — must NOT quit or type
    expect(app.view.inputBox!.text).toBe("draft");
    (input as unknown as EventEmitter).emit("data", Buffer.from("\x1b")); // esc closes the box
    app.quit();
    await running;
  });

  it("a click on a nav slot switches tabs from every tab", async () => {
    const { out, input } = fakeStreams(120, 30);
    const app = new App(TUI_DEFAULTS, async () => ({ ok: true, stdout: "", stderr: "", code: 0 }), out, input);
    app.tab = "metrics";
    let x1: number | undefined;
    for (let x = 2; x < 120 && x1 === undefined; x++) if (barHitKey("metrics", x, 28, 120, 30) === "1") x1 = x;
    const running = app.run();
    (input as unknown as EventEmitter).emit("data", Buffer.from(`\x1b[<0;${x1};28M`));
    expect(app.tab).toBe("board");
    app.quit();
    await running;
  });
});

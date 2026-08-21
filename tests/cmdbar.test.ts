// The shared two-row command bar: paint/hit share one layout (round-trip
// pinned here), globals keep the same x on every tab (the constant-position
// guarantee), the active nav slot is highlighted, and an App-level click on a
// bar button IS that keypress (quit from a non-board tab).
import { ACCENT_BG } from "../src/tui/design.js";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { TUI_DEFAULTS } from "../src/config.js";
import { App, type Tab } from "../src/tui/app.js";
import { barHitKey, paintCmdBar, TAB_COMMANDS } from "../src/tui/cmdbar.js";
import { Frame, stripAnsi } from "../src/tui/paint.js";
import { CompanionSidebar } from "../src/tui/sidebar.js";
import type { DockerRunner } from "../src/tui/companion.js";

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
      expect(raw).toContain(`${ACCENT_BG}\x1b[1m[${label}]`);
      expect(raw.split(ACCENT_BG).length).toBe(2); // one selection fill only
      expect(raw).not.toContain("\x1b[7m"); // no ad-hoc inverse (§8)
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
    // the click becomes a real `q`, and `q` now ASKS. The prompt is
    // the proof the click was routed; `y` is what actually leaves.
    expect(app.view.confirmQuit).toBe(true);
    (input as unknown as EventEmitter).emit("data", Buffer.from("y"));
    await running;
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

describe("clean exit", () => {
  const ALT_OFF = "\x1b[?1049l";
  const CLEARED = "\x1b[2J";

  function streams(cols = 120, rows = 30) {
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

  function harness() {
    const { out, input, written } = streams();
    const app = new App(TUI_DEFAULTS, async () => ({ ok: true, stdout: "", stderr: "", code: 0 }), out, input);
    const type = (s: string) => (input as unknown as EventEmitter).emit("data", Buffer.from(s));
    return { app, written, type, running: app.run() };
  }

  it("q asks before it quits, and any other key cancels", async () => {
    const h = harness();
    h.type("q");
    expect(h.app.view.confirmQuit).toBe(true);
    h.type("n"); // anything that is not yes
    expect(h.app.view.confirmQuit).toBe(false);
    // Still alive: a second q re-asks, and y leaves.
    h.type("q");
    expect(h.app.view.confirmQuit).toBe(true);
    h.type("y");
    await h.running;
  });

  it("a repeated q cancels rather than confirming — that is what the prompt is for", async () => {
    const h = harness();
    h.type("q");
    h.type("q");
    expect(h.app.view.confirmQuit).toBe(false);
    h.type("q");
    h.type("\r"); // ⏎ is the other yes
    await h.running;
  });

  it("Ctrl-C twice exits; once only warns", async () => {
    const h = harness();
    h.type("\x03");
    expect(h.app.view.confirmQuit).toBeFalsy(); // no modal — repetition IS the confirm
    expect(h.app.view.noticeLine).toContain("Ctrl-C again");
    h.type("\x03");
    await h.running;
  });

  it("restores the terminal AND clears it, in that order", async () => {
    const h = harness();
    h.type("q");
    h.type("y");
    await h.running;
    const written = h.written();
    const off = written.lastIndexOf(ALT_OFF);
    const cleared = written.lastIndexOf(CLEARED);
    expect(off).toBeGreaterThan(-1);
    // Clearing BEFORE leaving the alt screen would wipe the screen we are
    // about to throw away and leave the operator's own screen untouched.
    expect(cleared).toBeGreaterThan(off);
  });
});

describe("the focused companion column is a TERMINAL, not a text box", () => {
  // The regression this exists to prevent: gave the column a TUI-side
  // draft line, so pi never saw the keys — no `/` commands, no completion
  // menu, nothing clickable. Running pi under tmux is pointless if the bytes
  // stop at the TUI. Root CLAUDE.md carries the rule.
  function harness() {
    const out = new EventEmitter() as unknown as NodeJS.WriteStream;
    (out as unknown as { columns: number }).columns = 140;
    (out as unknown as { rows: number }).rows = 40;
    out.write = (() => true) as never;
    const input = new EventEmitter() as unknown as NodeJS.ReadStream;
    (input as unknown as { isTTY: boolean }).isTTY = false;
    input.resume = (() => input) as never;
    input.pause = (() => input) as never;
    const app = new App(TUI_DEFAULTS, async () => ({ ok: true, stdout: "", stderr: "", code: 0 }), out, input);
    const sent: string[][] = [];
    const docker: DockerRunner = async (argv) => {
      if (argv.includes("send-keys")) sent.push(argv);
      return { ok: true, stdout: "", stderr: "", code: 0 };
    };
    app.sidebar = new CompanionSidebar(
      { container_name: "qcr-companion", session: "companion" },
      docker,
      { available: () => true },
    );
    const type = (t: string) => (input as unknown as EventEmitter).emit("data", Buffer.from(t));
    return { app, sent, type, running: app.run() };
  }
  const settle = () => new Promise((r) => setTimeout(r, 10));
  const literals = (sent: string[][]) => sent.filter((a) => a.includes("-l")).map((a) => a[a.length - 1]);

  it("forwards every printable — including `/`, which opens pi's command menu", async () => {
    const h = harness();
    h.app.sidebar!.focus();
    h.type("/");
    h.type("help");
    await settle();
    expect(literals(h.sent).join("")).toContain("/help");
    h.app.quit();
    await h.running;
  });

  it("forwards ⏎, Esc and Backspace — pi owns its own editing", async () => {
    const h = harness();
    h.app.sidebar!.focus();
    h.type("\r");
    h.type("\x1b");
    h.type("\x7f");
    await settle();
    const names = h.sent.flat();
    expect(names).toContain("Enter");
    expect(names).toContain("Escape");
    expect(names).toContain("BSpace");
    h.app.quit();
    await h.running;
  });

  it("forwards Ctrl-C — interrupting a turn is pi's, not a TUI quit", async () => {
    const h = harness();
    h.app.sidebar!.focus();
    h.type("\x03");
    await settle();
    expect(h.sent.flat()).toContain("C-c");
    expect(h.app.view.confirmQuit).toBeFalsy();
    h.app.sidebar!.blur();
    h.app.quit();
    await h.running;
  });

  it("Ctrl-q is the ONE byte that never travels — it releases focus", async () => {
    const h = harness();
    h.app.sidebar!.focus();
    h.type("\x11");
    await settle();
    expect(h.sent).toEqual([]);
    expect(h.app.sidebar!.focused).toBe(false);
    h.app.quit();
    await h.running;
  });

  it("the `/` that focuses the column also REACHES pi (it opens pi's menu)", async () => {
    // Caught live: `/` was consumed as a pure focus key, so pressing it took
    // the keyboard and pi never saw the slash — the command menu you were
    // reaching for never opened. Of all keys, this is the one that must
    // travel.
    const h = harness();
    expect(h.app.sidebar!.focused).toBe(false);
    h.type("/");
    await settle();
    expect(h.app.sidebar!.focused).toBe(true);
    expect(literals(h.sent)).toContain("/");
    h.app.sidebar!.blur();
    h.app.quit();
    await h.running;
  });

  it("typing an unclaimed key on the board sends it to pi, not to a draft", async () => {
    const h = harness();
    h.type("h"); // unregistered printable → focuses the column
    await settle();
    expect(h.app.sidebar!.focused).toBe(true);
    expect(literals(h.sent)).toContain("h");
    h.app.sidebar!.blur();
    h.app.quit();
    await h.running;
  });
});

describe("drag-to-copy", () => {
  // Turning mouse reporting on takes the terminal's own selection away, so the
  // TUI owes one back. the owner: "99% I select something to copy it" — release
  // IS the copy; there is no copy key and no copy mode.
  function harness(cols = 60, rows = 12, withSidebar = false) {
    const out = new EventEmitter() as unknown as NodeJS.WriteStream;
    (out as unknown as { columns: number }).columns = cols;
    (out as unknown as { rows: number }).rows = rows;
    out.write = (() => true) as never;
    const input = new EventEmitter() as unknown as NodeJS.ReadStream;
    (input as unknown as { isTTY: boolean }).isTTY = false;
    input.resume = (() => input) as never;
    input.pause = (() => input) as never;
    const app = new App(TUI_DEFAULTS, async () => ({ ok: true, stdout: "", stderr: "", code: 0 }), out, input);
    if (withSidebar) {
      app.sidebar = new CompanionSidebar(
        { container_name: "qcr-companion", session: "companion" },
        async () => ({ ok: true, stdout: "", stderr: "", code: 0 }),
        { available: () => true },
      );
    }
    const copied: string[] = [];
    app.clipboard = { write: async (t: string) => (copied.push(t), true) };
    const mouse = (b: number, x: number, y: number, press = true) =>
      (input as unknown as EventEmitter).emit("data", Buffer.from(`\x1b[<${b};${x};${y}${press ? "M" : "m"}`));
    /** The plain-text block the operator can SEE at those cells — computed
     * independently of the app, so the assertion is a real check of the
     * extraction and not a restatement of it. */
    const onScreen = (x1: number, y1: number, x2: number, y2: number) => {
      const f = (app as unknown as { lastFrame?: Frame }).lastFrame!;
      const out: string[] = [];
      for (let y = y1; y <= y2; y++) out.push(stripAnsi(f.lines[y - 1] ?? "").slice(x1 - 1, x2).replace(/\s+$/, ""));
      while (out.length > 0 && out[out.length - 1] === "") out.pop();
      return out.join("\n");
    };
    return { app, copied, mouse, onScreen, running: app.run() };
  }
  const settle = () => new Promise((r) => setTimeout(r, 10));

  it("dragging the sidebar seam resizes instead of copying; other drags still copy", async () => {
    const h = harness(160, 20, true);
    expect(h.app.sidebarWidth(160)).toBe(80);
    h.mouse(0, 81, 5); // responsive sidebar's left seam
    h.mouse(32, 101, 5); // drag right → 60 total columns
    h.mouse(0, 101, 5, false);
    await settle();
    expect(h.app.sidebar!.preferredWidth).toBe(60);
    expect(h.app.sidebarWidth(160)).toBe(60);
    expect(h.copied).toEqual([]);
    expect(h.app.view.noticeLine).toContain("sidebar 60 cols");

    // A drag one cell inside the resized panel is content selection, unchanged.
    h.mouse(0, 103, 2);
    h.mouse(32, 120, 3);
    h.mouse(0, 120, 3, false);
    await settle();
    expect(h.copied).toHaveLength(1);
    h.app.quit();
    await h.running;
  });

  it("press → drag → release copies the block, and says what it copied", async () => {
    const h = harness();
    // Row 1 is the title bar — always painted, whatever the board holds.
    h.mouse(0, 3, 1); // press
    h.mouse(32, 20, 1); // drag right with the button held
    h.mouse(0, 20, 1, false); // release
    await settle();
    const want = h.onScreen(3, 1, 20, 1);
    expect(want.length).toBeGreaterThan(0); // the board painted something there
    expect(h.copied).toEqual([want]);
    expect(h.app.view.noticeLine).toContain(`copied ${want.length} chars`);
    h.app.quit();
    await h.running;
  });

  it("selects a BLOCK, so a drag stays inside the pane it started in", async () => {
    // Linear selection would splice the board and the companion column
    // together on every row. A block is what makes "copy this bit of pi's
    // output" mean the pi output and nothing else.
    const h = harness();
    h.mouse(0, 30, 3);
    h.mouse(32, 40, 5);
    h.mouse(0, 40, 5, false);
    await settle();
    expect(h.copied).toEqual([h.onScreen(30, 3, 40, 5)]);
    // Every copied line came from columns 30..40 ONLY — a block, not a run of
    // whole rows spliced across panes.
    for (const line of h.copied[0]!.split("\n")) expect(line.length).toBeLessThanOrEqual(11);
    h.app.quit();
    await h.running;
  });

  it("a plain click copies nothing — only a drag selects", async () => {
    const h = harness();
    h.mouse(0, 5, 4);
    h.mouse(0, 5, 4, false);
    await settle();
    expect(h.copied).toEqual([]);
    h.app.quit();
    await h.running;
  });

  it("says so when there is no clipboard tool, instead of failing silently", async () => {
    const h = harness();
    h.app.clipboard = { write: async () => false };
    h.mouse(0, 3, 4);
    h.mouse(32, 6, 4);
    h.mouse(0, 6, 4, false);
    await settle();
    expect(h.app.view.noticeLine).toContain("no clipboard tool");
    h.app.quit();
    await h.running;
  });

  it("copies PLAIN text — no escape sequences out of a styled frame", async () => {
    // The board's own rows are full of SGR runs (the title bar, badges, the
    // selected-row fill), so this drags across real styled content.
    const h = harness();
    h.mouse(0, 2, 1);
    h.mouse(32, 40, 3);
    h.mouse(0, 40, 3, false);
    await settle();
    expect(h.copied[0]).toBe(h.onScreen(2, 1, 40, 3));
    expect(h.copied[0]).not.toContain("\x1b");
    expect(h.copied[0]!.length).toBeGreaterThan(0);
    h.app.quit();
    await h.running;
  });
});

// The shared command bar: paint/hit share one layout (round-trip pinned
// here), globals keep the same x on every tab (the constant-position
// guarantee), the active nav slot is highlighted, an App-level click on a bar
// button IS that keypress — and,, the bar WRAPS instead of
// dropping buttons and paints only the verbs the frame answers to.
import { ACCENT_BG } from "../src/tui/design.js";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { TUI_DEFAULTS } from "../src/config.js";
import { App, type Tab, type TabHooks } from "../src/tui/app.js";
import {
  barHeight,
  barHitKey,
  NO_LIVE_KEYS,
  paintCmdBar,
  TAB_VOCABULARY,
  type BarButton,
} from "../src/tui/cmdbar.js";
import { boardKeys, renderBoard, type BoardView } from "../src/tui/board.js";
import { Frame, stripAnsi } from "../src/tui/paint.js";
import { CompanionSidebar, sidebarWidth } from "../src/tui/sidebar.js";
import { TABS } from "../src/tui/tabs.js";
import type { DockerRunner } from "../src/tui/companion.js";

const NAV: Array<[string, string]> = TABS.map((t, i) => [String(i + 1), `${i + 1} ${t}`]);
const GLOBALS: Array<[string, string]> = [
  ["r", "r refresh"],
  ["s", "s ssh"],
  ["?", "? help"],
  ["q", "q quit"],
];

function paint(
  tab: Tab,
  cols: number,
  rows: number,
  commands: readonly BarButton[] = TAB_VOCABULARY[tab],
): Frame {
  const frame = new Frame(cols, rows);
  paintCmdBar(frame, tab, cols, rows, commands);
  return frame;
}

/** Contiguous hit runs along a bar row: which key answers at which x-range. */
function hitRuns(
  tab: Tab,
  y: number,
  cols: number,
  rows: number,
  commands: readonly BarButton[] = TAB_VOCABULARY[tab],
): Array<{ key: string; x1: number; x2: number }> {
  const runs: Array<{ key: string; x1: number; x2: number }> = [];
  for (let x = 2; x <= cols - 1; x++) {
    const k = barHitKey(tab, x, y, cols, rows, commands);
    if (k === undefined) continue;
    const last = runs[runs.length - 1];
    if (last && last.key === k && last.x2 === x - 1) last.x2 = x;
    else runs.push({ key: k, x1: x, x2: x });
  }
  return runs;
}

describe("layout/hit round-trip", () => {
  for (const tab of ["board", "memory", "feedback"] as const) {
    for (const cols of [140, 200]) {
      it(`${tab} @ ${cols} cols: every button's rendered cells hit back to its key`, () => {
        const rows = 40;
        const frame = paint(tab, cols, rows);
        expect(barHeight(tab, cols, TAB_VOCABULARY[tab])).toBe(2); // wide enough for the classic two rows
        const plainA = stripAnsi(frame.lines[rows - 3]!);
        const plainB = stripAnsi(frame.lines[rows - 2]!);
        const wantA = [...NAV, ...GLOBALS];
        const wantB = TAB_VOCABULARY[tab].map((b) => [b.key, b.label] as [string, string]);
        const runsA = hitRuns(tab, rows - 2, cols, rows); // terminal y = frame row + 1
        const runsB = hitRuns(tab, rows - 1, cols, rows);
        expect(runsA.map((r) => r.key)).toEqual(wantA.map(([k]) => k));
        expect(runsB.map((r) => r.key)).toEqual(wantB.map(([k]) => k));
        // …and the hit range covers exactly the rendered `[label]` cells.
        runsA.forEach((r, i) => expect(plainA.slice(r.x1 - 1, r.x2)).toBe(`[${wantA[i]![1]}]`));
        runsB.forEach((r, i) => expect(plainB.slice(r.x1 - 1, r.x2)).toBe(`[${wantB[i]![1]}]`));
        // Between buttons and off the bar rows: nothing.
        expect(
          barHitKey(tab, runsA[0]!.x2 + 1, rows - 2, cols, rows, TAB_VOCABULARY[tab]),
        ).toBeUndefined();
        expect(
          barHitKey(tab, runsA[0]!.x1, rows - 5, cols, rows, TAB_VOCABULARY[tab]),
        ).toBeUndefined();
      });
    }
  }

  it("paints exactly the LIVE commands it is handed, not the vocabulary", () => {
    const rows = 20;
    const frame = paint("memory", 160, rows, [{ key: "n", label: "n new" }]);
    const rowB = stripAnsi(frame.lines[rows - 2]!);
    expect(rowB).toContain("[n new]");
    expect(rowB).not.toContain("older day");
    expect(
      hitRuns("memory", rows - 1, 160, rows, [{ key: "n", label: "n new" }]).map((r) => r.key),
    ).toEqual(["n"]);
  });
});

describe("the bar wraps instead of dropping buttons (→)", () => {
  /** Every `[label]` painted on the bar rows, in order. */
  function paintedLabels(frame: Frame, rows: number, height: number): string[] {
    const out: string[] = [];
    for (let i = 0; i < height; i++) {
      const plain = stripAnsi(frame.lines[rows - 1 - height + i]!);
      for (const m of plain.matchAll(/\[([^\]]+)\]/g)) out.push(m[1]!);
    }
    return out;
  }

  it("at EVERY width, every nav slot, global and command is painted whole and hits back to its key", () => {
    const rows = 40;
    for (let cols = 16; cols <= 240; cols++) {
      const commands = TAB_VOCABULARY.board;
      const h = barHeight("board", cols, commands);
      const frame = paint("board", cols, rows, commands);
      const labels = paintedLabels(frame, rows, h);
      const want = [
        ...NAV.map(([, l]) => l),
        ...GLOBALS.map(([, l]) => l),
        ...commands.map((b) => b.label),
      ];
      // A label wider than the whole row is truncated by the paint (a `…`
      // shows), never dropped: count those as present when the row is too
      // narrow to hold the label at all.
      const fits = (l: string): boolean => l.length + 2 <= cols - 2;
      expect(labels, `cols=${cols}`).toEqual(want.filter(fits));
      // Hit-test agrees with the paint: every key answers somewhere on the bar.
      const keys = new Set<string>();
      for (let i = 0; i < h; i++)
        for (const r of hitRuns("board", rows - h + i, cols, rows, commands)) keys.add(r.key);
      for (const k of [...NAV, ...GLOBALS].map(([k]) => k))
        expect(keys.has(k), `key ${k} @ cols=${cols}`).toBe(true);
      for (const b of commands)
        expect(keys.has(b.key), `key ${JSON.stringify(b.key)} @ cols=${cols}`).toBe(true);
    }
  });

  it("the bar sits directly above the bottom border and is never shorter than two rows", () => {
    for (const cols of [20, 61, 81, 120]) {
      const h = barHeight("feedback", cols, TAB_VOCABULARY.feedback);
      expect(h).toBeGreaterThanOrEqual(2);
      const frame = paint("feedback", cols, 30, TAB_VOCABULARY.feedback);
      for (let i = 0; i < h; i++) expect(frame.lines[29 - h + i]!.startsWith("│")).toBe(true);
      expect(frame.lines[29 - h - 1]).toBe(""); // the row above the bar was not painted by the bar
    }
  });

  it("[u unwedge] survives on the board at the shipped companion width — the ratified lever is always on screen", () => {
    // The shipped default gives the companion column half the terminal, so
    // the board renders at `cols - sidebarWidth(cols) + 1`. Before
    // the board's row B was silently truncated at that width and `u` was the
    // button that fell off.
    const view: BoardView = {
      health: { kind: "ok", heartbeatAgeS: 1 },
      dryRun: false,
      snapshot: {
        written_at: "",
        dry_run: false,
        prs: [
          {
            number: 5012,
            state: "reviewing",
            title: "t",
            head_sha: "x",
            stale_recheck: 0,
            author: "alice",
          },
        ],
        running_rounds: 0,
        total_spend_usd: 0,
        heartbeat: "",
      },
      events: [],
      selected: 0,
      eventsFocus: false,
      eventsScroll: 0,
      help: false,
      repo: "exampleorg/example-app",
      now: new Date("2026-09-02T10:00:00Z"),
    };
    expect(boardKeys(view).bar.map((b) => b.key)).toContain("u");
    // 64 is the cramped case: the column keeps its 24-column minimum and the
    // board gets 41, where the five verbs no longer fit on one row.
    for (const terminal of [64, 88, 100, 120, 160, 200, 240]) {
      const inner = terminal - sidebarWidth(terminal) + 1;
      const rows = 40;
      const frame = renderBoard(view, inner, rows);
      const h = barHeight("board", inner, boardKeys(view).bar);
      const labels = paintedLabels(frame, rows, h);
      expect(labels, `terminal ${terminal} → inner ${inner}`).toContain("u unwedge");
      let hit = false;
      for (let i = 0; i < h && !hit; i++)
        for (const r of hitRuns("board", rows - h + i, inner, rows, boardKeys(view).bar))
          if (r.key === "u") hit = true;
      expect(hit, `u must hit-test at inner ${inner}`).toBe(true);
    }
  });
});

describe("constant positions", () => {
  it("globals sit at identical x-ranges on all seven tabs (fixed cols)", () => {
    const cols = 140;
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
    const cols = 140;
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
      const raw = paint(tab, 160, rows).lines[rows - 3]!;
      const label = NAV.find(([, l]) => l.endsWith(` ${tab}`))![1];
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
  const findKey = (
    app: App,
    key: string,
    y: number,
    cols: number,
    rows: number,
  ): number | undefined => {
    for (let x = 2; x < cols; x++)
      if (barHitKey(app.tab, x, y, cols, rows, app.liveKeys().bar) === key) return x;
    return undefined;
  };

  it("a click on the quit slot quits, from a non-board tab", async () => {
    const { out, input } = fakeStreams(120, 30);
    const app = new App(
      TUI_DEFAULTS,
      async () => ({ ok: true, stdout: "", stderr: "", code: 0 }),
      out,
      input,
    );
    app.tab = "deploy";
    const qx = findKey(app, "q", 28, 120, 30);
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
    const app = new App(
      TUI_DEFAULTS,
      async () => ({ ok: true, stdout: "", stderr: "", code: 0 }),
      out,
      input,
    );
    app.tab = "board";
    app.view.snapshot = {
      written_at: "",
      dry_run: true,
      prs: [{ number: 5012, state: "reviewing", title: "a", head_sha: "x", stale_recheck: 0 }],
      running_rounds: 0,
      total_spend_usd: 0,
      heartbeat: "",
    };
    const sent: string[] = [];
    app.hooks.sendMessage = (_s, text) => void sent.push(text);
    const ex = findKey(app, "\r", 29, 120, 30); // the board row-B enter button
    expect(ex).toBeDefined();
    const qx = findKey(app, "q", 28, 120, 30);
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
    const app = new App(
      TUI_DEFAULTS,
      async () => ({ ok: true, stdout: "", stderr: "", code: 0 }),
      out,
      input,
    );
    app.tab = "metrics";
    // The nav is the bar's FIRST row, wherever the bar's height put it (at
    // 120 columns the eight nav slots and the globals no longer share a row).
    const navY = (): number => 30 - barHeight(app.tab, 120, app.liveKeys().bar);
    const x1 = findKey(app, "1", navY(), 120, 30);
    const running = app.run();
    (input as unknown as EventEmitter).emit("data", Buffer.from(`\x1b[<0;${x1};${navY()}M`));
    expect(app.tab).toBe("board");
    const x7 = findKey(app, "7", navY(), 120, 30);
    (input as unknown as EventEmitter).emit("data", Buffer.from(`\x1b[<0;${x7};${navY()}M`));
    expect(app.tab).toBe("feedback");
    const x8 = findKey(app, "8", navY(), 120, 30);
    (input as unknown as EventEmitter).emit("data", Buffer.from(`\x1b[<0;${x8};${navY()}M`));
    expect(app.tab).toBe("scan");
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
    const app = new App(
      TUI_DEFAULTS,
      async () => ({ ok: true, stdout: "", stderr: "", code: 0 }),
      out,
      input,
    );
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
    const app = new App(
      TUI_DEFAULTS,
      async () => ({ ok: true, stdout: "", stderr: "", code: 0 }),
      out,
      input,
    );
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
  const literals = (sent: string[][]) =>
    sent.filter((a) => a.includes("-l")).map((a) => a[a.length - 1]);

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

  it("clicking the main TUI releases companion focus without Ctrl-q", async () => {
    const h = harness();
    h.app.sidebar!.focus();
    h.type("\x1b[<0;10;10M"); // left/main pane, outside the companion column
    await settle();
    expect(h.app.sidebar!.focused).toBe(false);
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

describe("the wheel scrolls the companion column, not the tab behind it", () => {
  // Reported live: with the companion column focused, wheeling back through
  // the conversation moved the BOARD's selection instead — and the pi mirror
  // followed the new selection, so the notch scrolled away the thing being
  // read. The column is chrome on every tab, so it has to answer the wheel
  // before the tab dispatch does.
  const INSTALLED = ["memory", "digest", "tickets", "deploy", "metrics", "feedback"] as const;
  function harness(tab: Tab = "board") {
    const out = new EventEmitter() as unknown as NodeJS.WriteStream;
    (out as unknown as { columns: number }).columns = 140;
    (out as unknown as { rows: number }).rows = 40;
    out.write = (() => true) as never;
    const input = new EventEmitter() as unknown as NodeJS.ReadStream;
    (input as unknown as { isTTY: boolean }).isTTY = false;
    input.resume = (() => input) as never;
    input.pause = (() => input) as never;
    const tabNotches: string[] = [];
    const tabKeys: Array<{ kind: string; wheel?: boolean }> = [];
    const hooks: TabHooks = {
      screen: (_a, cols, rows) => new Frame(cols, rows),
      key: (_a, k) => (tabKeys.push(k), tabNotches.push(k.kind), true),
      keys: () => NO_LIVE_KEYS,
    };
    const app = new App(
      TUI_DEFAULTS,
      async () => ({ ok: true, stdout: "", stderr: "", code: 0 }),
      out,
      input,
      {
        tabs: Object.fromEntries(INSTALLED.map((t) => [t, hooks])),
      },
    );
    app.tab = tab;
    app.view.snapshot = {
      written_at: "",
      dry_run: true,
      prs: [
        { number: 1, state: "reviewing", title: "a", head_sha: "x", stale_recheck: 0 },
        { number: 2, state: "reviewing", title: "b", head_sha: "x", stale_recheck: 0 },
        { number: 3, state: "reviewing", title: "c", head_sha: "x", stale_recheck: 0 },
      ],
      running_rounds: 0,
      total_spend_usd: 0,
      heartbeat: "",
    };
    app.sidebar = new CompanionSidebar(
      { container_name: "qcr-companion", session: "companion" },
      async () => ({ ok: true, stdout: "", stderr: "", code: 0 }),
      { available: () => true },
    );
    // 140 cols → a 70-column companion column occupying x 71…140.
    const wheel = (up: boolean, x: number) =>
      (input as unknown as EventEmitter).emit(
        "data",
        Buffer.from(`\x1b[<${up ? 64 : 65};${x};10M`),
      );
    return { app, tabNotches, tabKeys, wheel, running: app.run() };
  }
  const settle = () => new Promise((r) => setTimeout(r, 10));

  it("a focused column keeps the wheel wherever the pointer rests", async () => {
    const h = harness();
    h.app.sidebar!.focus();
    h.wheel(true, 10); // pointer over the BOARD, keyboard on the companion
    h.wheel(true, 10);
    await settle();
    expect(h.app.sidebar!.offset).toBeGreaterThan(0);
    expect(h.app.view.selected).toBe(0); // the board never moved
    h.app.sidebar!.blur();
    h.app.quit();
    await h.running;
  });

  it("the pointer over the column scrolls it even unfocused (the pi pane's rule)", async () => {
    const h = harness();
    h.wheel(true, 100);
    await settle();
    expect(h.app.sidebar!.offset).toBeGreaterThan(0);
    expect(h.app.view.selected).toBe(0);
    expect(h.app.sidebar!.focused).toBe(false); // a wheel notch is not a click
    h.app.quit();
    await h.running;
  });

  it("wheeling back down returns the mirror to the live tail", async () => {
    const h = harness();
    h.wheel(true, 100);
    await settle();
    const parked = h.app.sidebar!.offset;
    expect(parked).toBeGreaterThan(0);
    h.wheel(false, 100);
    h.wheel(false, 100);
    await settle();
    expect(h.app.sidebar!.offset).toBe(0);
    h.app.quit();
    await h.running;
  });

  it("leaves the tab's own wheel alone when the pointer is outside an unfocused column", async () => {
    const h = harness();
    h.wheel(false, 10);
    await settle();
    expect(h.app.sidebar!.offset).toBe(0);
    expect(h.app.view.selected).toBe(1); // the board's wheel meaning, unchanged
    h.app.quit();
    await h.running;
  });

  for (const tab of INSTALLED) {
    it(`the ${tab} tab still owns the wheel outside the column, and never inside it`, async () => {
      const h = harness(tab);
      h.wheel(false, 10);
      await settle();
      expect(h.tabNotches).toEqual(["down"]);
      expect(h.tabKeys[0]).toMatchObject({ kind: "down", wheel: true });
      h.app.sidebar!.focus();
      h.wheel(true, 10);
      await settle();
      expect(h.tabNotches).toEqual(["down"]); // the focused column took it
      expect(h.app.sidebar!.offset).toBeGreaterThan(0);
      h.app.sidebar!.blur();
      h.app.quit();
      await h.running;
    });
  }
});

describe("drag-to-copy", () => {
  // Turning mouse reporting on takes the terminal's own selection away, so the
  // TUI owes one back. The owner: "99% I select something to copy it" — release
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
    const app = new App(
      TUI_DEFAULTS,
      async () => ({ ok: true, stdout: "", stderr: "", code: 0 }),
      out,
      input,
    );
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
      (input as unknown as EventEmitter).emit(
        "data",
        Buffer.from(`\x1b[<${b};${x};${y}${press ? "M" : "m"}`),
      );
    /** The plain-text block the operator can SEE at those cells — computed
     * independently of the app, so the assertion is a real check of the
     * extraction and not a restatement of it. */
    const onScreen = (x1: number, y1: number, x2: number, y2: number) => {
      const f = (app as unknown as { lastFrame?: Frame }).lastFrame!;
      const out: string[] = [];
      for (let y = y1; y <= y2; y++)
        out.push(
          stripAnsi(f.lines[y - 1] ?? "")
            .slice(x1 - 1, x2)
            .replace(/\s+$/, ""),
        );
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

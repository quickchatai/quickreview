// companion strip: geometry (STRIP_ROWS / stripHit), paint states,
// smart keyboard routing (unregistered printables become companion input),
// mouse (input row focuses, mirror rows open the full-screen attach), and the
// renderer contract that tab content never paints into the strip's rows.
import { ACCENT_BG } from "../src/tui/design.js";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { TUI_DEFAULTS } from "../src/config.js";
import { App } from "../src/tui/app.js";
import { registeredKeys } from "../src/tui/cmdbar.js";
import type { DockerRunner } from "../src/tui/companion.js";
import { renderBoard, type BoardView } from "../src/tui/board.js";
import { renderDigestTab } from "../src/tui/digesttab.js";
import { Frame, stripAnsi } from "../src/tui/paint.js";
import {
  CompanionStrip,
  STRIP_OFF,
  STRIP_PLACEHOLDER,
  STRIP_ROWS,
  paintStrip,
  stripHeight,
  stripHit,
  type StripView,
} from "../src/tui/strip.js";

const CFG = { container_name: "qcr-companion", session: "companion" };

function fakeRunner(log: string[][]): DockerRunner {
  return async (argv) => {
    log.push(argv);
    return { ok: true, stdout: "pi> hello\nfrom the companion\n", stderr: "", code: 0 };
  };
}

function view(over: Partial<StripView> = {}): StripView {
  return { mirror: [], input: "", focused: false, available: true, ...over };
}

describe("strip geometry", () => {
  it("STRIP_ROWS: 7 from 32 rows up, 1 below (auto-collapse)", () => {
    expect(STRIP_ROWS(32)).toBe(7);
    expect(STRIP_ROWS(60)).toBe(7);
    expect(STRIP_ROWS(31)).toBe(1);
    expect(STRIP_ROWS(24)).toBe(1);
  });

  it("a down companion reserves one row even on a tall terminal", () => {
    expect(stripHeight(50, false)).toBe(1);
    expect(stripHeight(50, true)).toBe(7);
    expect(stripHeight(24, true)).toBe(1);
  });

  it("stripHit: input row at y=rows-3, mirror band (divider included) above it", () => {
    const rows = 40;
    expect(stripHit(10, rows - 3, 120, rows)).toBe("input");
    expect(stripHit(10, rows - 4, 120, rows)).toBe("mirror");
    expect(stripHit(10, rows - 9, 120, rows)).toBe("mirror");
    expect(stripHit(10, rows - 10, 120, rows)).toBeUndefined(); // last content row
    expect(stripHit(10, rows - 2, 120, rows)).toBeUndefined(); // command bar
    // Collapsed (short terminal): only the input row answers.
    expect(stripHit(10, 24 - 3, 120, 24)).toBe("input");
    expect(stripHit(10, 24 - 4, 120, 24)).toBeUndefined();
    // Down companion on a tall terminal: caller passes the 1-row height.
    expect(stripHit(10, 40 - 4, 120, 40, stripHeight(40, false))).toBeUndefined();
    expect(stripHit(10, 40 - 3, 120, 40, stripHeight(40, false))).toBe("input");
  });
});

describe("paintStrip states", () => {
  const rows = 40;
  const cols = 100;

  it("empty + unfocused paints the dim placeholder on the input row", () => {
    const frame = new Frame(cols, rows);
    paintStrip(frame, view(), cols, rows);
    expect(stripAnsi(frame.lines[rows - 4]!)).toContain(STRIP_PLACEHOLDER);
    expect(stripAnsi(frame.lines[rows - 10]!)).toContain("companion"); // the ─ companion ─ divider
  });

  it("focused paints the draft with an inverse cursor block", () => {
    const frame = new Frame(cols, rows);
    paintStrip(frame, view({ focused: true, input: "why is #5012 parked" }), cols, rows);
    const raw = frame.lines[rows - 4]!;
    expect(stripAnsi(raw)).toContain("❯ why is #5012 parked");
    expect(raw).toContain(ACCENT_BG); // the cursor block (accent fill, no ad-hoc inverse)
    expect(stripAnsi(raw)).not.toContain(STRIP_PLACEHOLDER);
  });

  it("mirror rows show the TAIL of the companion pane", () => {
    const frame = new Frame(cols, rows);
    const mirror = ["l1", "l2", "l3", "l4", "l5", "l6", "l7"];
    paintStrip(frame, view({ mirror }), cols, rows);
    const body = [];
    for (let r = rows - 9; r <= rows - 5; r++) body.push(stripAnsi(frame.lines[r]!));
    expect(body.join("\n")).toContain("l7");
    expect(body.join("\n")).not.toContain("l1"); // only the tail fits
  });

  it("companion off: one dim row, even where the full strip would fit", () => {
    const frame = new Frame(cols, rows);
    paintStrip(frame, view({ available: false }), cols, rows);
    expect(stripAnsi(frame.lines[rows - 4]!)).toContain(STRIP_OFF);
    expect(frame.lines[rows - 10]).toBe(""); // no divider, no mirror rows
    expect(frame.lines[rows - 9]).toBe("");
  });
});

// ---- app harness ------------------------------------------------------------

function fakeStreams(cols = 120, rows = 40) {
  const out = new EventEmitter() as unknown as NodeJS.WriteStream;
  let buf = "";
  (out as unknown as { columns: number }).columns = cols;
  (out as unknown as { rows: number }).rows = rows;
  out.write = ((s: string) => ((buf += s), true)) as never;
  const input = new EventEmitter() as unknown as NodeJS.ReadStream;
  (input as unknown as { isTTY: boolean }).isTTY = false;
  input.resume = (() => input) as never;
  input.pause = (() => input) as never;
  return { out, input, written: () => buf, type: (s: string) => (input as unknown as EventEmitter).emit("data", Buffer.from(s)) };
}

function harness(available = true, rows = 40) {
  const s = fakeStreams(120, rows);
  const app = new App(TUI_DEFAULTS, async () => ({ ok: false, stdout: "", stderr: "", code: 1 }), s.out, s.input);
  const docker: string[][] = [];
  app.strip = new CompanionStrip(CFG, fakeRunner(docker), { available: () => available });
  const running = app.run();
  return { app, s, docker, close: () => (app.quit(), running) };
}

describe("smart keyboard routing", () => {
  it("an unregistered printable focuses the strip input, seeded with the char", async () => {
    const h = harness();
    h.s.type("z");
    expect(h.app.strip!.focused).toBe(true);
    expect(h.app.strip!.input).toBe("z");
    await h.close();
  });

  it("retired tab keys c and 5 are unregistered — they seed the strip", async () => {
    for (const ch of ["c", "5"]) {
      const h = harness();
      h.s.type(ch);
      expect(h.app.tab).toBe("board");
      expect(h.app.strip!.input).toBe(ch);
      await h.close();
    }
  });

  it("a registered verb key still goes to the tab, never to the strip", async () => {
    const h = harness();
    h.s.type("e"); // board: events overlay
    expect(h.app.view.eventsFocus).toBe(true);
    expect(h.app.strip!.focused).toBe(false);
    expect(registeredKeys("board").has("e")).toBe(true);
    await h.close();
  });

  it("while the input is non-empty, ALL printables are text — verb chars included", async () => {
    const h = harness();
    h.s.type("z");
    h.s.type("e");
    h.s.type("q");
    expect(h.app.strip!.input).toBe("zeq");
    expect(h.app.view.eventsFocus).toBe(false);
    h.s.type("\x7f"); // backspace edits the draft
    expect(h.app.strip!.input).toBe("ze");
    await h.close();
  });

  it("/ always focuses the strip input (empty seed)", async () => {
    const h = harness();
    h.s.type("/");
    expect(h.app.strip!.focused).toBe(true);
    expect(h.app.strip!.input).toBe("");
    await h.close();
  });

  it("⏎ sends the draft through tmux send-keys (-l literal, then Enter) and blurs", async () => {
    const h = harness();
    h.s.type("z");
    h.s.type("z");
    h.s.type("\r");
    await new Promise((r) => setTimeout(r, 0));
    const sends = h.docker.filter((a) => a.includes("send-keys"));
    expect(sends[0]).toEqual(["exec", "qcr-companion", "tmux", "send-keys", "-t", "companion", "-l", "zz"]);
    expect(sends[1]).toEqual(["exec", "qcr-companion", "tmux", "send-keys", "-t", "companion", "Enter"]);
    expect(h.app.strip!.focused).toBe(false);
    expect(h.app.strip!.input).toBe("");
    await h.close();
  });

  it("Esc clears and blurs without sending", async () => {
    const h = harness();
    h.s.type("z");
    h.s.type("\x1b");
    expect(h.app.strip!.focused).toBe(false);
    expect(h.app.strip!.input).toBe("");
    expect(h.docker.filter((a) => a.includes("send-keys"))).toEqual([]);
    await h.close();
  });

  it("companion down: the input is inert and routing falls back to tab keys", async () => {
    const h = harness(false);
    h.s.type("z");
    h.s.type("/");
    expect(h.app.strip!.focused).toBe(false);
    expect(h.app.strip!.input).toBe("");
    h.s.type("3"); // tab nav still works
    expect(h.app.tab).toBe("deploy");
    await h.close();
  });
});

describe("mouse on the strip", () => {
  it("clicking the input row focuses it", async () => {
    const h = harness();
    h.s.type(`\x1b[<0;10;${40 - 3}M`);
    expect(h.app.strip!.focused).toBe(true);
    await h.close();
  });

  it("clicking the mirror rows opens the full-screen companion attach", async () => {
    const h = harness();
    let attached = 0;
    h.app.hooks.companionAttach = async () => {
      attached += 1;
    };
    h.s.type(`\x1b[<0;10;${40 - 6}M`);
    expect(attached).toBe(1);
    expect(h.app.strip!.focused).toBe(false);
    await h.close();
  });
});

describe("renderer row contract", () => {
  const bview: BoardView = {
    health: { kind: "ok", heartbeatAgeS: 2 },
    dryRun: true,
    events: [],
    selected: 0,
    detailFull: false,
    eventsFocus: false,
    eventsScroll: 0,
    help: false,
  };

  it("board content never paints into the strip rows (content ends at rows-11)", () => {
    const rows = 40;
    const frame = renderBoard(bview, 120, rows, view({ mirror: ["companion tail line"] }));
    expect(frame.lines[rows - 10]!.startsWith("├")).toBe(true); // the divider IS the strip's first row
    expect(stripAnsi(frame.lines[rows - 10]!)).toContain("companion");
    expect(stripAnsi(frame.lines[rows - 5]!)).toContain("companion tail line");
    expect(stripAnsi(frame.lines[rows - 4]!)).toContain(STRIP_PLACEHOLDER);
    // The pi region sits strictly above the strip.
    expect(frame.meta["piTop"]! + frame.meta["piRows"]! - 1).toBe(rows - 11);
    // No clickable board zone reaches into the strip band (terminal y ≥ rows-9).
    for (const z of frame.zones) expect(z.y2).toBeLessThan(rows - 9);
  });

  it("collapsed (rows<32): content ends at rows-5, input row at rows-4", () => {
    const rows = 24;
    const frame = renderBoard(bview, 120, rows, view());
    expect(stripAnsi(frame.lines[rows - 4]!)).toContain(STRIP_PLACEHOLDER);
    expect(frame.meta["piTop"]! + frame.meta["piRows"]! - 1).toBe(rows - 5);
  });

  it("the digest tab shrinks the same way and paints the strip", () => {
    const rows = 40;
    const frame = renderDigestTab(
      { files: [], back: 0, scroll: 0, awaitingSelected: 0, loaded: true },
      [],
      true,
      "2026-08-20",
      120,
      rows,
      view(),
    );
    expect(frame.lines[rows - 10]!.startsWith("├")).toBe(true);
    expect(stripAnsi(frame.lines[rows - 4]!)).toContain(STRIP_PLACEHOLDER);
  });
});

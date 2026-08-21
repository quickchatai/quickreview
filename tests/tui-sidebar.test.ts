import { describe, expect, it } from "vitest";
import type { DockerResult, DockerRunner } from "../src/tui/companion.js";
import { displayWidth, stripAnsi } from "../src/tui/paint.js";
import {
  CompanionSidebar,
  paintSidebar,
  SIDEBAR_BORDER,
  SIDEBAR_COLS,
  SIDEBAR_HIDE_BELOW,
  SIDEBAR_MIN_COLS,
  SIDEBAR_PLACEHOLDER,
  SIDEBAR_SPINE,
  sidebarHit,
  sidebarWidth,
  type SidebarView,
} from "../src/tui/sidebar.js";

const CFG = { container_name: "qcr-companion", session: "companion" };

const OK: DockerResult = { ok: true, stdout: "", stderr: "", code: 0 };
const FAIL: DockerResult = { ok: false, stdout: "", stderr: "no server running", code: 1 };

/** Records every docker call and answers from a scripted queue (tests never
 * spawn docker — same discipline as tui-companion.test.ts). */
function fakeDocker(answer: (argv: string[]) => DockerResult = () => OK): { runner: DockerRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: DockerRunner = async (argv) => {
    calls.push(argv);
    return answer(argv);
  };
  return { runner, calls };
}

const VIEW = (over: Partial<SidebarView> = {}): SidebarView => ({
  header: { up: true, piUp: true, day: "2026-08-21", lastWake: "3m ago", memory: "ok" },
  lines: [],
  input: "",
  focused: false,
  collapsed: false,
  available: true,
  offset: 0,
  alerts: [],
  ...over,
});

const WIDE = SIDEBAR_COLS + SIDEBAR_BORDER;

describe("sidebarWidth", () => {
  it("is the full column on a wide terminal and 0 when the companion is off", () => {
    expect(sidebarWidth(200, { collapsed: false, available: true })).toBe(WIDE);
    expect(sidebarWidth(200, { collapsed: false, available: false })).toBe(0);
  });

  it("auto-collapses to the spine below SIDEBAR_MIN_COLS and hides when tiny", () => {
    expect(sidebarWidth(SIDEBAR_MIN_COLS, { collapsed: false, available: true })).toBe(WIDE);
    expect(sidebarWidth(SIDEBAR_MIN_COLS - 1, { collapsed: false, available: true })).toBe(SIDEBAR_SPINE);
    expect(sidebarWidth(200, { collapsed: true, available: true })).toBe(SIDEBAR_SPINE);
    expect(sidebarWidth(SIDEBAR_HIDE_BELOW - 1, { collapsed: true, available: true })).toBe(0);
  });
});

describe("paintSidebar geometry", () => {
  const shapes: Array<[number, number]> = [
    [WIDE, 40],
    [WIDE, 24],
    [WIDE, 11],
    [WIDE, 7],
    [WIDE, 5],
    [WIDE, 4],
    [WIDE, 3],
    [WIDE, 2],
    [WIDE, 1],
    [30, 20],
    [SIDEBAR_SPINE, 20],
    [SIDEBAR_SPINE, 2],
  ];

  for (const [width, rows] of shapes) {
    it(`emits exactly ${rows} rows of width ${width}`, () => {
      const out = paintSidebar(
        VIEW({
          lines: ["one", "two", "three", "four", "five", "six"],
          alerts: [{ tier: "alert", title: "companion stalled", ts: "12:01" }],
          input: "hello",
          focused: true,
        }),
        width,
        rows,
      );
      expect(out).toHaveLength(rows);
      for (const line of out) expect(displayWidth(line)).toBe(width);
    });
  }

  it("returns nothing for 0 rows and blank rows for a hidden column", () => {
    expect(paintSidebar(VIEW(), WIDE, 0)).toEqual([]);
    expect(paintSidebar(VIEW(), 0, 3)).toEqual(["", "", ""]);
  });

  it("carries the junction glyphs that continue the inner frame", () => {
    const out = paintSidebar(VIEW(), WIDE, 12);
    expect(out[0]).toBe(`┬${"─".repeat(SIDEBAR_COLS)}┐`);
    expect(out[11]).toBe(`┴${"─".repeat(SIDEBAR_COLS)}┘`);
    for (const line of out.slice(1, 11)) {
      expect(line.startsWith("│")).toBe(true);
      expect(line.endsWith("│")).toBe(true);
    }
  });

  it("shows the header facts and the input placeholder", () => {
    const out = paintSidebar(VIEW(), WIDE, 16).map(stripAnsi);
    expect(out[1]).toContain("companion");
    expect(out[1]).toContain("2026-08-21");
    expect(out[1]).toContain("mem ok");
    expect(out[2]).toContain("last wake 3m ago");
    expect(out[14]).toContain(SIDEBAR_PLACEHOLDER);
  });

  it("marks a down pi and a degraded memory in the header", () => {
    const out = paintSidebar(VIEW({ header: { up: true, piUp: false, day: "", lastWake: "—", memory: "degraded" } }), WIDE, 16).map(
      stripAnsi,
    );
    expect(out[1]).toContain("mem degraded");
    expect(out[2]).toContain("pi down");
  });

  it("says the companion is off in the input row when unavailable", () => {
    const out = paintSidebar(VIEW({ available: false }), WIDE, 16).map(stripAnsi);
    expect(out[14]).toContain("companion off");
  });
});

describe("paintSidebar content", () => {
  it("paints the mirror tail, newest at the bottom", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line-${i}`);
    const out = paintSidebar(VIEW({ lines }), WIDE, 12).map(stripAnsi);
    expect(out[9]).toContain("line-29"); // the last mirror row, above the input row
    expect(out.join("\n")).not.toContain("line-0");
  });

  it("scrollback offset parks the window above the live tail", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line-${i}`);
    const out = paintSidebar(VIEW({ lines, offset: 5 }), WIDE, 12).map(stripAnsi);
    expect(out.join("\n")).toContain("line-24");
    expect(out.join("\n")).not.toContain("line-25");
    expect(out.join("\n")).toContain("↑5");
  });

  it("keeps display width exact when truncating SGR-styled mirror lines", () => {
    const styled = `\x1b[38;5;73m${"x".repeat(200)}\x1b[0m and \x1b[1mmore\x1b[0m`;
    const out = paintSidebar(VIEW({ lines: [styled] }), WIDE, 10);
    for (const line of out) expect(displayWidth(line)).toBe(WIDE);
    // The cut lands inside the run, never mid-escape: no bare "[38" leaks.
    expect(out.join("\n")).not.toContain("[38;5;73mx…");
    expect(stripAnsi(out[7] ?? "")).toContain("…");
  });

  it("shows at most three alerts, newest last", () => {
    const alerts: SidebarView["alerts"] = [
      { tier: "notice", title: "a1", ts: "10:00" },
      { tier: "notice", title: "a2", ts: "10:01" },
      { tier: "alert", title: "a3", ts: "10:02" },
      { tier: "alert", title: "a4", ts: "10:03" },
    ];
    const text = paintSidebar(VIEW({ alerts }), WIDE, 24).map(stripAnsi).join("\n");
    expect(text).not.toContain("a1");
    expect(text).toContain("a2");
    expect(text).toContain("a4");
    expect(text.indexOf("a2")).toBeLessThan(text.indexOf("a4"));
  });

  it("sheds the alerts block before the mirror on a short terminal", () => {
    const alerts: SidebarView["alerts"] = [{ tier: "alert", title: "boom", ts: "10:00" }];
    const out = paintSidebar(VIEW({ lines: ["tail-line"], alerts }), WIDE, 7).map(stripAnsi);
    expect(out).toHaveLength(7);
    expect(out.join("\n")).not.toContain("boom");
    expect(out.join("\n")).toContain("tail-line");
  });
});

describe("paintSidebar collapsed spine", () => {
  it("renders the vertical companion affordance inside its own borders", () => {
    const out = paintSidebar(VIEW({ collapsed: true }), SIDEBAR_SPINE, 20);
    expect(out).toHaveLength(20);
    for (const line of out) expect(displayWidth(line)).toBe(SIDEBAR_SPINE);
    expect(out[0]).toBe("┬─┐");
    expect(out[19]).toBe("┴─┘");
    expect(out.slice(1, 19).map(stripAnsi).join("").replace(/\s|│/g, "")).toBe("companion");
  });

  it("flags a pending alert with an attention marker at the top", () => {
    const out = paintSidebar(
      VIEW({ collapsed: true, alerts: [{ tier: "alert", title: "boom", ts: "10:00" }] }),
      SIDEBAR_SPINE,
      20,
    ).map(stripAnsi);
    expect(out[1]).toBe("│●│");
  });
});

describe("sidebarHit", () => {
  const cols = 160;
  const rows = 30;

  it("routes clicks inside the expanded column and ignores the tab side", () => {
    expect(sidebarHit(cols - WIDE, 10, cols, rows, WIDE)).toBeUndefined();
    expect(sidebarHit(cols + 1, 10, cols, rows, WIDE)).toBeUndefined();
    expect(sidebarHit(cols - WIDE + 1, 1, cols, rows, WIDE)).toBe("collapse");
    expect(sidebarHit(cols, 2, cols, rows, WIDE)).toBe("header");
    expect(sidebarHit(cols, 3, cols, rows, WIDE)).toBe("header");
    expect(sidebarHit(cols, 10, cols, rows, WIDE)).toBe("mirror");
    expect(sidebarHit(cols, rows - 1, cols, rows, WIDE)).toBe("input");
    expect(sidebarHit(cols, rows, cols, rows, WIDE)).toBeUndefined();
    expect(sidebarHit(cols, rows + 1, cols, rows, WIDE)).toBeUndefined();
  });

  it("treats every spine cell as the expand affordance, and a hidden column as inert", () => {
    expect(sidebarHit(cols, 10, cols, rows, SIDEBAR_SPINE)).toBe("collapse");
    expect(sidebarHit(cols, 1, cols, rows, SIDEBAR_SPINE)).toBe("collapse");
    expect(sidebarHit(cols, 10, cols, rows, 0)).toBeUndefined();
  });
});

describe("CompanionSidebar", () => {
  it("captures with -e -p -J and keeps the last good mirror on failure", async () => {
    let ok = true;
    const { runner, calls } = fakeDocker(() => (ok ? { ...OK, stdout: "alpha\nbeta\n" } : FAIL));
    const sb = new CompanionSidebar(CFG, runner);
    await sb.refresh();
    expect(calls[0]).toEqual(["exec", "qcr-companion", "tmux", "capture-pane", "-e", "-p", "-J", "-t", "companion"]);
    expect(sb.lines).toEqual(["alpha", "beta"]);
    expect(sb.view().header.piUp).toBe(true);

    ok = false;
    await sb.refresh();
    expect(sb.lines).toEqual(["alpha", "beta"]); // never blanked on a transient error
    expect(sb.view().header.piUp).toBe(false);
    sb.stop();
  });

  it("does not capture at all while the companion is unavailable", async () => {
    const { runner, calls } = fakeDocker();
    const sb = new CompanionSidebar(CFG, runner, { available: () => false });
    await sb.refresh();
    expect(calls).toEqual([]);
    expect(sb.view().available).toBe(false);
    expect(sb.view().header.up).toBe(false);
    sb.stop();
  });

  it("asks for history above the window once parked in scrollback", async () => {
    const { runner, calls } = fakeDocker(() => ({ ...OK, stdout: "x\n" }));
    const sb = new CompanionSidebar(CFG, runner);
    sb.scroll(1);
    await sb.refresh();
    expect(calls[calls.length - 1]).toContain("-S");
    sb.stop();
  });

  it("sends literal text and Enter as two invocations", async () => {
    const { runner, calls } = fakeDocker();
    const sb = new CompanionSidebar(CFG, runner);
    await sb.send("hello there");
    const sends = calls.filter((c) => c[3] === "send-keys");
    expect(sends).toEqual([
      ["exec", "qcr-companion", "tmux", "send-keys", "-t", "companion", "-l", "--", "hello there"],
      ["exec", "qcr-companion", "tmux", "send-keys", "-t", "companion", "Enter"],
    ]);
    sb.stop();
  });

  it("strips newlines from a pasted draft so the row discipline holds", async () => {
    const { runner, calls } = fakeDocker();
    const sb = new CompanionSidebar(CFG, runner);
    await sb.send("one\ntwo\tthree");
    expect(calls[0]![calls[0]!.length - 1]).toBe("onetwothree");
    sb.stop();
  });

  it("throws with tmux's own stderr when a send fails", async () => {
    const { runner } = fakeDocker(() => FAIL);
    const sb = new CompanionSidebar(CFG, runner);
    await expect(sb.send("x")).rejects.toThrow(/no server running/);
    sb.stop();
  });

  it("forwards raw stdin through keysToTmux, one invocation per group", async () => {
    const { runner, calls } = fakeDocker();
    const sb = new CompanionSidebar(CFG, runner);
    await sb.sendKeys(Buffer.from("ab\x1b[A\r"));
    const sends = calls.filter((c) => c[3] === "send-keys").map((c) => c.slice(6));
    expect(sends).toEqual([["-l", "ab"], ["Up", "Enter"]]);
    sb.stop();
  });

  it("sends nothing when the chunk translates to no keys", async () => {
    const { runner, calls } = fakeDocker();
    const sb = new CompanionSidebar(CFG, runner);
    await sb.sendKeys(Buffer.from([0x11])); // Ctrl-q — the TUI's own focus chord
    expect(calls).toEqual([]);
    sb.stop();
  });

  it("clamps the scrollback offset at the live tail", async () => {
    const { runner } = fakeDocker(() => ({ ...OK, stdout: "x\n" }));
    const sb = new CompanionSidebar(CFG, runner);
    sb.scroll(2);
    expect(sb.offset).toBe(6);
    sb.scroll(-5);
    expect(sb.offset).toBe(0);
    sb.scroll(-5);
    expect(sb.offset).toBe(0);
    sb.stop();
  });

  it("focus seeds the draft, blur drops it, and collapse toggles", () => {
    const { runner } = fakeDocker();
    const sb = new CompanionSidebar(CFG, runner);
    sb.focus("h");
    sb.input += "i";
    expect(sb.view().input).toBe("hi");
    expect(sb.view().focused).toBe(true);
    sb.toggleCollapse();
    expect(sb.view().collapsed).toBe(true);
    sb.blur();
    expect(sb.view()).toMatchObject({ input: "", focused: false });
    sb.stop();
  });

  it("does not take focus while the companion is down", () => {
    const { runner } = fakeDocker();
    const sb = new CompanionSidebar(CFG, runner, { available: () => false });
    sb.focus("h");
    expect(sb.view().focused).toBe(false);
    sb.stop();
  });

  it("carries orchestrator-supplied header facts into the view", () => {
    const { runner } = fakeDocker();
    const sb = new CompanionSidebar(CFG, runner);
    sb.setHeader({ day: "2026-08-21", memory: "ok", lastWake: "3m ago" });
    sb.setAlerts([{ tier: "notice", title: "n", ts: "10:00" }]);
    expect(sb.view().header).toMatchObject({ day: "2026-08-21", memory: "ok", lastWake: "3m ago", up: true });
    expect(sb.view().alerts).toHaveLength(1);
    sb.stop();
  });
});

// The TUI has ONE layout (the owner, 2026-09-02): the tab on the left, the
// companion column on the right, on every frame, in every configuration.
// Nothing takes the whole terminal, nothing folds the column away, no config
// removes it. Three things were removed that day and this file is the fence
// that keeps them out: the full-screen attach (overseer / main / PR), the
// collapsed spine (`\`, the border click, the narrow-terminal auto-spine) and
// the no-column configuration (`--no-companion`, `[companion] enabled=false`).
//
// The assertions are STRUCTURAL where they can be — a module that does not
// exist, a hook that has no name, a state field that is not on the class —
// because a prompt-level "please don't" is exactly what let `o`/`M` keep the
// takeover alive for two weeks after ruled it out.
import { EventEmitter } from "node:events";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TUI_DEFAULTS } from "../src/config.js";
import { App } from "../src/tui/app.js";
import { TAB_COMMANDS, registeredKeys } from "../src/tui/cmdbar.js";
import { decodeKey } from "../src/tui/keys.js";
import { parseTarget } from "../src/tui/index.js";
import { stripAnsi } from "../src/tui/paint.js";
import { CompanionSidebar, SIDEBAR_MIN_WIDTH, sidebarWidth } from "../src/tui/sidebar.js";
import type { DockerRunner } from "../src/tui/companion.js";

const ROOT = resolve(process.cwd());
const TUI = join(ROOT, "src", "tui");

function tuiSources(): Array<[string, string]> {
  return readdirSync(TUI)
    .filter((n) => n.endsWith(".ts"))
    .map((n) => [n, readFileSync(join(TUI, n), "utf8")] as [string, string]);
}

function bareApp(cols = 200, rows = 40): { app: App; type: (s: string) => void } {
  const out = new EventEmitter() as unknown as NodeJS.WriteStream;
  (out as unknown as { columns: number }).columns = cols;
  (out as unknown as { rows: number }).rows = rows;
  out.write = (() => true) as never;
  const input = new EventEmitter() as unknown as NodeJS.ReadStream;
  (input as unknown as { isTTY: boolean }).isTTY = false;
  input.resume = (() => input) as never;
  input.pause = (() => input) as never;
  const app = new App(TUI_DEFAULTS, async () => ({ ok: true, stdout: "", stderr: "", code: 0 }), out, input);
  const type = (s: string) => (input as unknown as EventEmitter).emit("data", Buffer.from(s));
  return { app, type };
}

const docker: DockerRunner = async () => ({ ok: true, stdout: "", stderr: "", code: 0 });

describe("① no full-screen attach exists", () => {
  it("the attach screen, its terminal model and the pty dependency are gone from src/tui", () => {
    expect(existsSync(join(TUI, "attach.ts"))).toBe(false);
    expect(existsSync(join(TUI, "term.ts"))).toBe(false);
    for (const [name, text] of tuiSources()) {
      expect(text, `${name} must not load node-pty — a pty is how a surface takes the whole terminal`).not.toMatch(/node-pty/);
      // companion.ts keeps `attachArgv()` for ONE reader: `qcr companion
      // status` PRINTS it as a hint for the operator's own shell. The TUI
      // never executes it — nothing in src/tui spawns anything interactive.
      if (name === "companion.ts") continue;
      expect(text, `${name} must not build a \`tmux attach\``).not.toMatch(/["']attach["']\s*,\s*["']-t["']/);
    }
  });

  it("App has no attach hook to install, and the board's key map has no verb that reaches one", () => {
    const { app } = bareApp();
    expect("attach" in app.hooks).toBe(false);
    // `o` and `M` were the overseer / main-session attach verbs.
    expect(decodeKey(Buffer.from("o"))).toEqual({ kind: "char", ch: "o" });
    expect(decodeKey(Buffer.from("M"))).toEqual({ kind: "char", ch: "M" });
    const boardBar = TAB_COMMANDS.board.map((b) => b.key);
    expect(boardBar).not.toContain("o");
    expect(boardBar).not.toContain("M");
    // Unregistered means the board hands them to the companion column — which
    // is where the owner wants overseer questions to go.
    expect(registeredKeys("board").has("o")).toBe(false);
    expect(registeredKeys("board").has("M")).toBe(false);
  });

  it("the deep-links that opened an attach are refused, and a PR deep-link is just a selection", () => {
    expect(parseTarget("overseer")).toMatchObject({ kind: "bad" });
    expect(parseTarget("main")).toMatchObject({ kind: "bad" });
    expect((parseTarget("overseer") as { reason: string }).reason).toMatch(/companion/);
    expect(parseTarget("5012")).toEqual({ kind: "pr", pr: 5012 });
    expect(parseTarget(undefined)).toEqual({ kind: "none" });
  });

  it("⏎ with no PR selected opens nothing (it used to attach the selected non-PR session)", async () => {
    const { app, type } = bareApp();
    const running = app.run();
    type("\r");
    expect(app.piFocused()).toBe(false);
    expect(app.isBusy()).toBe(false);
    app.quit();
    await running;
  });

  it("the ONE remaining borrower of the real terminal is the `s` passphrase prompt", () => {
    // `suspend()` hands the terminal out. The attach used to be a caller; now
    // only index.ts's onRealTerminal (the GCP key prompt, which is ssh's own
    // UI and paints no TUI surface) may call it.
    const callers = tuiSources().filter(([name, text]) => name !== "app.ts" && /\bsuspend\(\)/.test(text)).map(([n]) => n);
    expect(callers).toEqual(["index.ts"]);
  });
});

describe("② the column never collapses", () => {
  it("sidebar state has no collapsed flag and no toggle", () => {
    const sb = new CompanionSidebar({ container_name: "c", session: "s" }, docker);
    expect("collapsed" in sb).toBe(false);
    expect("toggleCollapse" in sb).toBe(false);
    expect("collapsed" in sb.view()).toBe(false);
    sb.stop();
  });

  it("the column has a positive width at EVERY terminal width — no spine, no hide threshold", () => {
    for (let cols = 1; cols <= 400; cols++) {
      const w = sidebarWidth(cols);
      expect(w, `cols=${cols}`).toBeGreaterThanOrEqual(SIDEBAR_MIN_WIDTH);
      expect(w, `cols=${cols}`).toBe(sidebarWidth(cols, {}));
    }
  });

  it("`\\` is plain text for the companion, not a layout key", async () => {
    const { app, type } = bareApp();
    const sent: string[][] = [];
    app.sidebar = new CompanionSidebar({ container_name: "c", session: "s" }, async (argv) => {
      if (argv.includes("send-keys")) sent.push(argv);
      return { ok: true, stdout: "", stderr: "", code: 0 };
    });
    const running = app.run();
    const before = app.sidebarWidth(200);
    type("\\");
    await new Promise((r) => setTimeout(r, 5));
    expect(app.sidebarWidth(200)).toBe(before);
    expect(app.sidebar.focused).toBe(true); // an unclaimed printable focuses the column, seeded
    expect(sent.some((argv) => argv.includes("\\"))).toBe(true);
    app.quit();
    await running;
  });
});

describe("③ no configuration removes the column", () => {
  it("CompanionSidebar has no shown()/enabled — the width is a function of the terminal and the seam drag only", () => {
    const sb = new CompanionSidebar({ container_name: "c", session: "s" }, docker, { available: () => false });
    expect("shown" in sb).toBe(false);
    const { app } = bareApp(200, 40);
    app.sidebar = sb;
    expect(app.sidebarWidth(200)).toBe(100);
    sb.setOff("--no-companion");
    expect(app.sidebarWidth(200)).toBe(100);
    sb.stop();
  });

  it("an off companion says so in the column instead of pretending to start", async () => {
    const { paintSidebar } = await import("../src/tui/sidebar.js");
    const sb = new CompanionSidebar({ container_name: "c", session: "s" }, docker, { available: () => false });
    sb.setStartup(["– companion container · --no-companion"]);
    sb.setOff("--no-companion");
    const plain = paintSidebar(sb.view(), 60, 14).map(stripAnsi).join("\n");
    expect(plain).toContain("companion off — --no-companion");
    expect(plain).toContain("companion container"); // the skipped checklist still shows
    expect(plain).not.toContain("starting up — progress above");
    sb.stop();
  });

  it("an unwired tab paints its notice INSIDE the layout, beside the column", async () => {
    const { app } = bareApp(200, 40);
    app.sidebar = new CompanionSidebar({ container_name: "c", session: "s" }, docker);
    const running = app.run();
    app.tab = "metrics"; // no metricsScreen hook wired in this harness
    app.repaint();
    const frame = (app as unknown as { lastFrame?: { cols: number; lines: string[] } }).lastFrame;
    expect(frame, "the fallback must go through the frame compositor, not a bare write").toBeDefined();
    expect(frame!.cols).toBe(200);
    const plain = frame!.lines.map(stripAnsi);
    expect(plain[1]).toContain("metrics tab not wired");
    expect(plain[0]).toContain("┬"); // the column's junction glyph is on the same frame
    app.quit();
    await running;
  });
});

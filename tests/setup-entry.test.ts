// Starting setup: `qcr setup` and the board's `I` key ask the
// companion to run its setup skill through ONE inject file into its own
// column (src/tui/setupentry.ts); `qcr setup validate` is the direct edit's
// check; the memory tab marks the pins setup proposed. Temp dirs only.
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cmdSetup } from "../src/cli.js";
import { TUI_DEFAULTS } from "../src/config.js";
import { App } from "../src/tui/app.js";
import { boardKeys } from "../src/tui/board.js";
import { TAB_VOCABULARY } from "../src/tui/cmdbar.js";
import { companionInjectDir } from "../src/tui/companion.js";
import { entryLine } from "../src/tui/memtab.js";
import { stripAnsi } from "../src/tui/paint.js";
import { requestSetup, SETUP_REQUEST_TEXT, setupRequestName } from "../src/tui/setupentry.js";
import type { MemoryEntry } from "../src/memory/store.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-setup-entry-"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("the setup request", () => {
  it("is one whole inject file naming the setup skill — never a torn one", () => {
    const inject = companionInjectDir({ repo_dir: dir, session: "companion" });
    expect(inject).toBe(join(dir, "inject", "companion"));
    const file = requestSetup({ injectDir: inject, now: new Date("2026-09-29T10:00:00.123Z") });
    expect(readdirSync(inject)).toEqual(["2026-09-29T10-00-00-123Z-setup.md"]);
    expect(readFileSync(file, "utf8")).toBe(`${SETUP_REQUEST_TEXT}\n`);
    expect(SETUP_REQUEST_TEXT).toMatch(/skills\/companion\/setup\/SKILL\.md/);
    expect(SETUP_REQUEST_TEXT).toMatch(/setup_profile/);
  });

  it("sorts after that day's day-open, so a fresh conversation reads the day first", () => {
    const name = setupRequestName(new Date("2026-09-29T10:00:00Z"));
    expect(["2026-09-29-day-open.md", name].sort()).toEqual(["2026-09-29-day-open.md", name]);
    expect([name, "2026-09-30-day-open.md"].sort()).toEqual([name, "2026-09-30-day-open.md"]);
  });
});

describe("the board's I key", () => {
  function streams() {
    const out = new EventEmitter() as unknown as NodeJS.WriteStream;
    (out as unknown as { columns: number }).columns = 120;
    (out as unknown as { rows: number }).rows = 30;
    out.write = (() => true) as never;
    const input = new EventEmitter() as unknown as NodeJS.ReadStream;
    (input as unknown as { isTTY: boolean }).isTTY = false;
    input.resume = (() => input) as never;
    input.pause = (() => input) as never;
    return { out, input };
  }

  it("is on the board's bar with or without a selected PR, and drawn from its vocabulary", () => {
    const view = { snapshot: undefined, boardFilter: null, selected: 0, repo: undefined } as never;
    expect(boardKeys(view).bar).toContainEqual({ key: "I", label: "I setup" });
    expect(TAB_VOCABULARY.board).toContainEqual({ key: "I", label: "I setup" });
  });

  it("asks through the setup hook on the board, and nowhere else", async () => {
    const { out, input } = streams();
    const app = new App(TUI_DEFAULTS, async () => ({ ok: true, stdout: "", stderr: "", code: 0 }), out, input);
    const asked: string[] = [];
    app.hooks.setup = () => void asked.push(app.tab);
    app.tab = "board";
    const running = app.run();
    (input as unknown as EventEmitter).emit("data", Buffer.from("I"));
    expect(asked).toEqual(["board"]);
    app.tab = "digest";
    (input as unknown as EventEmitter).emit("data", Buffer.from("I"));
    expect(asked).toEqual(["board"]);
    app.quit();
    await running;
  });
});

describe("qcr setup validate — the direct edit's check", () => {
  function home(profileToml: string): void {
    const cfgHome = join(dir, "config");
    vi.stubEnv("QCR_CONFIG_HOME", cfgHome);
    vi.stubEnv("QCR_CONFIG", "");
    const write = (p: string, t: string): void => {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, t);
    };
    write(join(cfgHome, "config.toml"), '[review]\nprofile = "acme"\n');
    write(join(cfgHome, "profiles", "acme", "profile.toml"), profileToml);
  }

  it("passes a profile the daemon would boot with, naming its chain", async () => {
    home('extends = "default"\n[lenses.pass-security]\neffort = "high"\n');
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await cmdSetup(["validate"])).toBe(0);
      expect(log.mock.calls.flat().join("\n")).toMatch(/Profile "acme" loads[\s\S]*chain: default → acme/);
    } finally {
      log.mockRestore();
    }
  });

  it("fails a typo the daemon would refuse at boot, and says where", async () => {
    home('extends = "default"\n[lenses.pass-security]\neffrot = "high"\n');
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await cmdSetup(["validate"])).toBe(1);
      expect(log.mock.calls.flat().join("\n")).toMatch(/would NOT load[\s\S]*unknown key "effrot"/);
    } finally {
      log.mockRestore();
    }
  });
});

describe("the memory tab marks what setup proposes to pin", () => {
  it("☆ on a proposed entry, ● still on a pinned one", () => {
    const e: MemoryEntry = { id: "a", ts: "2026-09-29 09:00:00", day: "2026-09-29", block: 0, text: "#survey x", tags: [], links: [], pinned: false, hash: "h" };
    expect(stripAnsi(entryLine(e, 60, true))).toMatch(/^☆ 09-29 09:00 #survey x/);
    expect(stripAnsi(entryLine(e, 60))).toMatch(/^ {2}09-29/);
    expect(stripAnsi(entryLine({ ...e, pinned: true }, 60, true))).toMatch(/^● /);
  });
});

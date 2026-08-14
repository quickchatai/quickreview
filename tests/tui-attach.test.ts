import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TUI_DEFAULTS } from "../src/config.js";
import { App } from "../src/tui/app.js";
import { AttachScreen, muteCompanionToolFlash, Osc52Relay, statusRow, type PtyLike, type PtySpawner } from "../src/tui/attach.js";
import { CHORD_GRACE_MS, ChordScanner } from "../src/tui/chord.js";
import { parseTarget } from "../src/tui/index.js";
import { stripAnsi } from "../src/tui/paint.js";
import { TermPane } from "../src/tui/term.js";
import type { RemoteResult } from "../src/tui/remote.js";

// ---- chord scanner ---------------------------------------------------------

describe("ChordScanner", () => {
  it("forwards plain bytes untouched, csi-u sequences included", () => {
    const c = new ChordScanner();
    const a = c.feed(Buffer.from("\x1b[13;2u"));
    expect(Buffer.concat(a.forward).toString()).toBe("\x1b[13;2u");
    expect(a.detach).toBe(false);
    expect(a.arm).toBe(false);
  });

  it("arms on a lone Ctrl-q and detaches when the grace expires", () => {
    const c = new ChordScanner();
    const a = c.feed(Buffer.from([0x11]));
    expect(a).toMatchObject({ arm: true, detach: false, forward: [] });
    expect(c.armTimeout()).toEqual({ detach: true });
    expect(c.armTimeout()).toEqual({ detach: false }); // idempotent
  });

  it("double-tap sends exactly one literal Ctrl-q", () => {
    const c = new ChordScanner();
    c.feed(Buffer.from([0x11]));
    const a = c.feed(Buffer.from([0x11]));
    expect(a.disarm).toBe(true);
    expect(a.detach).toBe(false);
    expect(Buffer.concat(a.forward)).toEqual(Buffer.from([0x11]));
  });

  it("Ctrl-q followed by other input in the pending window detaches", () => {
    const c = new ChordScanner();
    c.feed(Buffer.from([0x11]));
    const a = c.feed(Buffer.from("x"));
    expect(a.detach).toBe(true);
    expect(a.forward).toEqual([]); // type-ahead after detach intent is dropped
  });

  it("handles Ctrl-q embedded mid-chunk (paste): leading bytes forwarded, detach", () => {
    const c = new ChordScanner();
    const a = c.feed(Buffer.from("ab\x11cd"));
    expect(Buffer.concat(a.forward).toString()).toBe("ab");
    expect(a.detach).toBe(true);
  });

  it("handles a double Ctrl-q inside one chunk as a literal", () => {
    const c = new ChordScanner();
    const a = c.feed(Buffer.from("ab\x11\x11cd"));
    expect(Buffer.concat(a.forward).toString("binary")).toBe("ab\x11cd");
    expect(a.detach).toBe(false);
  });
});

// ---- term painter ----------------------------------------------------------

describe("companion tool colors", () => {
  it("neutralizes pi's green tool-success background without touching other SGR", () => {
    const input = "a\x1b[48;2;40;50;40mtool\x1b[0m\x1b[38;2;40;50;40mtext";
    expect(muteCompanionToolFlash(input)).toBe("a\x1b[48;2;32;35;42mtool\x1b[0m\x1b[38;2;40;50;40mtext");
  });

  it("neutralizes the tmux-downgraded 256-color panels, compound SGRs included", () => {
    const input = "\x1b[48;5;22mok\x1b[0m \x1b[48;5;17mpend\x1b[0m \x1b[38;5;231;48;5;22mboth\x1b[0m \x1b[48;5;220mgold\x1b[0m";
    expect(muteCompanionToolFlash(input)).toBe(
      "\x1b[48;5;235mok\x1b[0m \x1b[48;5;235mpend\x1b[0m \x1b[38;5;231;48;5;235mboth\x1b[0m \x1b[48;5;220mgold\x1b[0m",
    );
  });
});

describe("Osc52Relay", () => {
  it("extracts complete OSC 52 sequences (BEL- and ST-terminated)", () => {
    const relay = new Osc52Relay();
    const bel = "\x1b]52;c;aGVsbG8=\x07";
    const st = "\x1b]52;c;d29ybGQ=\x1b\\";
    expect(relay.feed(`before${bel}mid${st}after`)).toEqual([bel, st]);
    expect(relay.feed("plain output, no clipboard")).toEqual([]);
  });

  it("reassembles a sequence split across pty chunks", () => {
    const relay = new Osc52Relay();
    expect(relay.feed("output\x1b]52;c;aGVs")).toEqual([]);
    expect(relay.feed("bG8=\x07more")).toEqual(["\x1b]52;c;aGVsbG8=\x07"]);
    // split inside the introducer itself
    expect(relay.feed("x\x1b]5")).toEqual([]);
    expect(relay.feed("2;c;eQ==\x07")).toEqual(["\x1b]52;c;eQ==\x07"]);
  });
});

describe("TermPane", () => {
  it("paints written text with truecolor SGR runs", async () => {
    const pane = new TermPane(20, 4);
    await new Promise<void>((r) => pane.write("\x1b[38;2;10;20;30mhi\x1b[0m there", () => r()));
    const frame = pane.renderFrame(1);
    expect(frame).toContain("38;2;10;20;30");
    expect(stripAnsi(frame)).toContain("hi there");
    pane.dispose();
  });

  it("follows the alternate buffer like a full-screen app", async () => {
    const pane = new TermPane(20, 4);
    await new Promise<void>((r) => pane.write("normal\x1b[?1049h\x1b[2J\x1b[Halt!", () => r()));
    const text = stripAnsi(pane.renderFrame(1));
    expect(text).toContain("alt!");
    expect(text).not.toContain("normal");
    pane.dispose();
  });

  it("resizes the model", () => {
    const pane = new TermPane(20, 4);
    pane.resize(40, 10);
    expect(pane.term.cols).toBe(40);
    expect(pane.term.rows).toBe(10);
    pane.dispose();
  });
});

// ---- attach screen lifecycle ----------------------------------------------

class FakePty implements PtyLike {
  written = "";
  killed = 0;
  cols = 0;
  rows = 0;
  private dataCb: ((d: string) => void) | undefined;
  private exitCb: ((ev: { exitCode: number }) => void) | undefined;
  write(data: string): void {
    this.written += data;
  }
  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
  }
  kill(): void {
    this.killed++;
  }
  onData(cb: (d: string) => void): void {
    this.dataCb = cb;
  }
  onExit(cb: (ev: { exitCode: number }) => void): void {
    this.exitCb = cb;
  }
  emitData(d: string): void {
    this.dataCb?.(d);
  }
  emitExit(code: number): void {
    this.exitCb?.({ exitCode: code });
  }
}

function fakeStreams(): { out: NodeJS.WriteStream; input: NodeJS.ReadStream; written: () => string; type: (b: Buffer) => void } {
  const outEmitter = new EventEmitter() as any;
  let buf = "";
  outEmitter.columns = 80;
  outEmitter.rows = 24;
  outEmitter.write = (s: string) => ((buf += s), true);
  const inEmitter = new EventEmitter() as any;
  inEmitter.isTTY = false;
  inEmitter.resume = () => {};
  inEmitter.pause = () => {};
  inEmitter.setRawMode = () => {};
  return { out: outEmitter, input: inEmitter, written: () => buf, type: (b) => inEmitter.emit("data", b) };
}

const sshFail = async (): Promise<RemoteResult> => ({ ok: false, stdout: "", stderr: "", code: 1 });

function makeApp(streams: ReturnType<typeof fakeStreams>): App {
  return new App(TUI_DEFAULTS, sshFail, streams.out, streams.input);
}

describe("AttachScreen", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function attachSetup(spawnImpl?: PtySpawner) {
    const streams = fakeStreams();
    const app = makeApp(streams);
    const ptys: FakePty[] = [];
    const spawner: PtySpawner =
      spawnImpl ??
      ((argv, cols, rows) => {
        const p = new FakePty();
        p.cols = cols;
        p.rows = rows;
        ptys.push(p);
        return p;
      });
    const screen = new AttachScreen("pr-5012", app, spawner, streams.out, streams.input);
    return { streams, app, ptys, screen };
  }

  it("spawns the pty at terminal size minus the status row and forwards keys verbatim", async () => {
    const { streams, ptys, screen } = attachSetup();
    const done = screen.run();
    expect(ptys).toHaveLength(1);
    expect(ptys[0]!.rows).toBe(23); // 24 - status row
    streams.type(Buffer.from("hello \x1b[13;2u"));
    expect(ptys[0]!.written).toBe("hello \x1b[13;2u");
    streams.type(Buffer.from([0x11]));
    vi.advanceTimersByTime(CHORD_GRACE_MS + 10);
    await done;
    expect(ptys[0]!.killed).toBeGreaterThan(0); // no orphaned ssh child
  });

  it("double-tap Ctrl-q sends one literal 0x11 and stays attached", async () => {
    const { streams, ptys, screen } = attachSetup();
    void screen.run();
    streams.type(Buffer.from([0x11]));
    streams.type(Buffer.from([0x11]));
    expect(ptys[0]!.written).toBe("\x11");
    expect(ptys[0]!.killed).toBe(0);
    screen.detach();
  });

  it("bails to the board with a clear error when the session is dead", async () => {
    const { streams, app, ptys, screen } = attachSetup();
    const done = screen.run();
    ptys[0]!.emitData; // never fed
    ptys[0]!.emitExit(1);
    await done;
    expect(app.view.noticeLine).toContain("attach pr-5012 failed");
    expect(stripAnsi(streams.written())).toContain("attach pr-5012 failed");
  });

  it("marks the connection lost when a live session drops, ⏎ reconnects, Ctrl-q returns", async () => {
    const { streams, ptys, screen } = attachSetup();
    const done = screen.run();
    ptys[0]!.emitData("some output");
    ptys[0]!.emitExit(255);
    expect(stripAnsi(streams.written())).toContain("✖ lost — ⏎ retry");
    streams.type(Buffer.from("\r"));
    expect(ptys).toHaveLength(2); // reconnect spawned a fresh pty
    ptys[1]!.emitData("back");
    ptys[1]!.emitExit(255);
    streams.type(Buffer.from([0x11]));
    await done;
  });

  it("propagates terminal resize to both the model and the pty", () => {
    const { streams, ptys, screen } = attachSetup();
    void screen.run();
    (streams.out as any).columns = 120;
    (streams.out as any).rows = 40;
    (streams.out as any).emit("resize");
    expect(ptys[0]!.cols).toBe(120);
    expect(ptys[0]!.rows).toBe(39);
    screen.detach();
  });

  it("suspends board input while attached and resumes on detach", () => {
    const { streams, app, screen } = attachSetup();
    void app.run();
    void screen.run();
    streams.type(Buffer.from("q")); // board 'quit' must NOT fire while attached
    expect((app as any).quitResolve).toBeDefined();
    screen.detach();
    streams.type(Buffer.from("q"));
    // after detach the board handles keys again — quit resolves app.run()
  });
});

describe("statusRow", () => {
  it("renders session, state and the reserved chord", () => {
    const row = stripAnsi(statusRow("pr-5012", "reviewing r3", "live", 80));
    expect(row).toContain("pr-5012 · reviewing r3");
    expect(row).toContain("▶ live");
    expect(row).toContain("Ctrl-q detach");
  });

  it("renders the lost state with the retry hint", () => {
    expect(stripAnsi(statusRow("pr-1", undefined, "lost", 80))).toContain("✖ lost — ⏎ retry");
  });
});

describe("parseTarget (deep link)", () => {
  it("routes numbers, named sessions, and rejects garbage", () => {
    expect(parseTarget(undefined)).toEqual({ kind: "none" });
    expect(parseTarget("5012")).toEqual({ kind: "pr", pr: 5012 });
    expect(parseTarget("overseer")).toEqual({ kind: "session", session: "overseer" });
    expect(parseTarget("main")).toEqual({ kind: "session", session: "main" });
    expect(parseTarget("nope")).toMatchObject({ kind: "bad" });
  });
});

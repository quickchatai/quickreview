// The board's live pi mirror (2026-08-14 layout rebuild): capture argv,
// escape-sequence hygiene, and the debounced stale-while-revalidate cache.
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { TUI_DEFAULTS } from "../src/config.js";
import { App } from "../src/tui/app.js";
import { piHeader } from "../src/tui/board.js";
import { stripAnsi } from "../src/tui/paint.js";
import { PiMirror, keepSgrOnly, keysToTmux, splitCapture } from "../src/tui/pipane.js";
import { captureArgv, sendKeysArgv, type RemoteResult, type SshRunner } from "../src/tui/remote.js";
import type { StatusSnapshot } from "../src/state.js";

const ok = (stdout: string): RemoteResult => ({ ok: true, stdout, stderr: "", code: 0 });
const fail = (): RemoteResult => ({ ok: false, stdout: "", stderr: "no such session", code: 1 });

describe("captureArgv", () => {
  it("captures the pane inside the container, colors kept, wrapped lines joined", () => {
    expect(captureArgv(TUI_DEFAULTS, "pr-5012")).toEqual([
      "sudo",
      "docker",
      "exec",
      "quickreview-sandbox",
      "tmux",
      "capture-pane",
      "-e",
      "-p",
      "-J",
      "-t",
      "pr-5012",
    ]);
  });

  it("uses the shared docker prefix (sudo off = plain docker, no -it)", () => {
    const argv = captureArgv({ ...TUI_DEFAULTS, sudo_docker: false }, "overseer");
    expect(argv[0]).toBe("docker");
    expect(argv).not.toContain("-it");
    expect(argv[argv.length - 1]).toBe("overseer");
  });

  it("asks for scrollback with tmux's negative line numbers (-S above the visible top)", () => {
    expect(captureArgv(TUI_DEFAULTS, "pr-5012", { startBack: 212 })).toEqual([
      "sudo",
      "docker",
      "exec",
      "quickreview-sandbox",
      "tmux",
      "capture-pane",
      "-e",
      "-p",
      "-J",
      "-S",
      "-212",
      "-t",
      "pr-5012",
    ]);
    // Both edges when a caller knows them; `-E` is omitted by the mirror so the
    // capture always runs through the bottom of the visible pane.
    expect(
      captureArgv(TUI_DEFAULTS, "pr-5012", { startBack: 30, endBack: 10 }).join(" "),
    ).toContain("-S -30 -E -10");
    expect(captureArgv(TUI_DEFAULTS, "pr-5012", { startBack: 0 })).not.toContain("-S");
  });
});

describe("sendKeysArgv", () => {
  it("writes into the session's tmux pane inside the container", () => {
    expect(sendKeysArgv(TUI_DEFAULTS, "pr-5012", ["-l", "hi"])).toEqual([
      "sudo",
      "docker",
      "exec",
      "quickreview-sandbox",
      "tmux",
      "send-keys",
      "-t",
      "pr-5012",
      "-l",
      "hi",
    ]);
  });

  it("drops sudo when configured off and passes key names through", () => {
    expect(sendKeysArgv({ ...TUI_DEFAULTS, sudo_docker: false }, "overseer", ["Enter"])).toEqual([
      "docker",
      "exec",
      "quickreview-sandbox",
      "tmux",
      "send-keys",
      "-t",
      "overseer",
      "Enter",
    ]);
  });
});

describe("keysToTmux", () => {
  const t = (s: string): string[][] => keysToTmux(Buffer.from(s, "utf8"));

  it("batches a printable run into one literal send-keys", () => {
    expect(t("hello world")).toEqual([["-l", "hello world"]]);
    expect(t("")).toEqual([]);
  });

  it("names the specials tmux knows", () => {
    expect(t("\r")).toEqual([["Enter"]]);
    expect(t("\n")).toEqual([["Enter"]]);
    expect(t("\x1b")).toEqual([["Escape"]]);
    expect(t("\x7f")).toEqual([["BSpace"]]);
    expect(t("\t")).toEqual([["Tab"]]);
    expect(t("\x1b[A\x1b[B\x1b[C\x1b[D")).toEqual([["Up", "Down", "Right", "Left"]]);
    expect(t("\x1bOA")).toEqual([["Up"]]);
    expect(t("\x1b[5~\x1b[6~")).toEqual([["PPage", "NPage"]]);
    expect(t("\x1b[H\x1b[F")).toEqual([["Home", "End"]]);
    expect(t("\x1b[3~")).toEqual([["DC"]]);
  });

  it("maps control bytes to C-<letter> and ESC-<char> to M-<char>", () => {
    expect(t("\x01")).toEqual([["C-a"]]);
    expect(t("\x03")).toEqual([["C-c"]]);
    expect(t("\x18")).toEqual([["C-x"]]);
    expect(t("\x1a")).toEqual([["C-z"]]);
    expect(t("\x1bb")).toEqual([["M-b"]]);
    expect(t("\x1b\r")).toEqual([["M-Enter"]]);
  });

  it("never translates Ctrl-q — the focus chord belongs to the board", () => {
    expect(t("\x11")).toEqual([]);
    expect(t("a\x11b")).toEqual([["-l", "ab"]]);
  });

  it("splits literal runs from named keys (send-keys -l is per invocation)", () => {
    expect(t("hi\r")).toEqual([["-l", "hi"], ["Enter"]]);
    expect(t("\x1b[Aabc\rz")).toEqual([["Up"], ["-l", "abc"], ["Enter"], ["-l", "z"]]);
  });

  it("keeps a pasted multi-line block to one invocation per run", () => {
    expect(t("line one\nline two")).toEqual([["-l", "line one"], ["Enter"], ["-l", "line two"]]);
  });
});

describe("keepSgrOnly", () => {
  it("keeps SGR color runs verbatim", () => {
    expect(keepSgrOnly("\x1b[38;2;1;2;3mhi\x1b[0m")).toBe("\x1b[38;2;1;2;3mhi\x1b[0m");
    expect(keepSgrOnly("\x1b[1;31mbold red\x1b[m")).toBe("\x1b[1;31mbold red\x1b[m");
  });

  it("strips cursor movement, erase and mode sequences that would corrupt the frame", () => {
    expect(keepSgrOnly("\x1b[2J\x1b[Hclean")).toBe("clean");
    expect(keepSgrOnly("a\x1b[3Db\x1b[K")).toBe("ab");
    expect(keepSgrOnly("\x1b[?25lhidden\x1b[?25h")).toBe("hidden");
    expect(keepSgrOnly("\x1b[1;40r\x1b[2Ascroll")).toBe("scroll");
  });

  it("drops OSC (titles, hyperlinks, clipboard) and stray control bytes", () => {
    expect(keepSgrOnly("\x1b]0;title\x07x")).toBe("x");
    expect(keepSgrOnly("\x1b]52;c;QUJD\x1b\\y")).toBe("y");
    expect(keepSgrOnly("a\rb\x00c")).toBe("abc");
    expect(keepSgrOnly("a\tb")).toBe("a  b");
  });

  it("never eats the ESC of a sequence it keeps", () => {
    expect(keepSgrOnly("\x1b[32mok\x1b[0m")).toContain("\x1b[32m");
  });

  // Reported 2026-08-21: the mirror "escaped its container" and coloured the
  // companion sidebar. A tmux pane row has no reason to end reset — 7 of 23
  // rows captured from the live pr-5312 session ended with a background or a
  // foreground still set — and the row does not END at the mirror's edge: the
  // pane's padding, the board's right border and the column beside it all
  // follow on the same physical line.
  it("closes a row that ends mid-style, so nothing paints past the mirror", () => {
    // The real shape: a background set, then `39` — foreground-only, which
    // looks like a reset and closes nothing of the background.
    expect(keepSgrOnly("\x1b[48;5;236mstatus bar\x1b[39m   ")).toBe(
      "\x1b[48;5;236mstatus bar\x1b[39m   \x1b[0m",
    );
    expect(keepSgrOnly("\x1b[7mreverse")).toBe("\x1b[7mreverse\x1b[0m");
  });

  it("adds nothing to rows that are already clean", () => {
    // Byte-identity matters: the mirror is repainted several times a second.
    expect(keepSgrOnly("plain output line")).toBe("plain output line");
    expect(keepSgrOnly("\x1b[32mok\x1b[0m")).toBe("\x1b[32mok\x1b[0m");
    expect(keepSgrOnly("\x1b[38;5;103mfg\x1b[39m")).toBe("\x1b[38;5;103mfg\x1b[39m");
  });

  it("survives the whole capture path — every mirrored line is self-contained", async () => {
    const { sgrOpenAtEnd } = await import("../src/tui/paint.js");
    const captured = [
      "\x1b[38;5;188mCompacted from 95,862 tokens\x1b[39m          ",
      "\x1b[7m\x1b[39m \x1b[0m",
      "\x1b[48;5;236m\x1b[38;5;103m────────\x1b[39m",
      "plain",
    ].join("\n");
    for (const line of splitCapture(captured)) expect(sgrOpenAtEnd(line)).toBe(false);
  });
});

describe("splitCapture", () => {
  it("sanitizes, trims trailing blank rows, and keeps oldest-first order", () => {
    expect(splitCapture("\x1b[Hone\ntwo\n\n\n")).toEqual(["one", "two"]);
  });
});

describe("PiMirror", () => {
  function mirrorWith(responses: Record<number, RemoteResult>, debounceMs = 300) {
    const calls: string[][] = [];
    const ssh: SshRunner = async (_h, argv) => {
      calls.push(argv);
      const pr = Number(/pr-(\d+)/.exec(argv[argv.length - 1] ?? "")?.[1]);
      return responses[pr] ?? fail();
    };
    let repaints = 0;
    const mirror = new PiMirror(TUI_DEFAULTS, ssh, () => (repaints += 1), debounceMs);
    return { mirror, calls, repaints: () => repaints };
  }

  it("caches a successful capture per PR and serves it instantly", async () => {
    const { mirror, calls, repaints } = mirrorWith({ 5012: ok("hello\nworld\n") });
    expect(mirror.view(5012)).toEqual({
      pr: 5012,
      lines: [],
      missing: false,
      stale: false,
      offset: 0,
    });
    await mirror.refresh(5012);
    expect(mirror.view(5012)).toEqual({
      pr: 5012,
      lines: ["hello", "world"],
      missing: false,
      stale: false,
      offset: 0,
    });
    expect(calls).toHaveLength(1);
    expect(repaints()).toBe(1);
  });

  it("marks a vanished session missing but keeps the last capture as (stale)", async () => {
    let live = true;
    const ssh: SshRunner = async () => (live ? ok("output") : fail());
    const mirror = new PiMirror(TUI_DEFAULTS, ssh, () => {}, 0);
    await mirror.refresh(7);
    live = false;
    await mirror.refresh(7);
    expect(mirror.view(7)).toEqual({
      pr: 7,
      lines: ["output"],
      missing: true,
      stale: true,
      offset: 0,
    });
  });

  it("reports a never-seen session as missing without a stale marker", async () => {
    const { mirror } = mirrorWith({});
    await mirror.refresh(9);
    expect(mirror.view(9)).toEqual({ pr: 9, lines: [], missing: true, stale: false, offset: 0 });
  });

  it("has nothing to say without a selection", () => {
    const { mirror } = mirrorWith({});
    expect(mirror.view(undefined)).toBeUndefined();
  });

  it("debounces selection changes — scrolling the list fires one capture", async () => {
    vi.useFakeTimers();
    try {
      const { mirror, calls } = mirrorWith({ 5049: ok("x") });
      mirror.select(5012);
      mirror.select(5020);
      mirror.select(5049);
      expect(calls).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(300);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain("pr-5049");
      mirror.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop() cancels a pending debounced capture", async () => {
    vi.useFakeTimers();
    try {
      const { mirror, calls } = mirrorWith({ 1: ok("x") });
      mirror.select(1);
      mirror.stop();
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not stack concurrent captures for the same PR", async () => {
    let resolveIt: ((r: RemoteResult) => void) | undefined;
    const calls: string[][] = [];
    const ssh: SshRunner = (_h, argv) => {
      calls.push(argv);
      return new Promise<RemoteResult>((res) => (resolveIt = res));
    };
    const mirror = new PiMirror(TUI_DEFAULTS, ssh, () => {}, 0);
    const first = mirror.refresh(3);
    void mirror.refresh(3);
    expect(calls).toHaveLength(1);
    resolveIt!(ok("done"));
    await first;
    expect(mirror.view(3)?.lines).toEqual(["done"]);
  });

  it("invalidate drops a PR's mirror", async () => {
    const { mirror } = mirrorWith({ 4: ok("y") });
    await mirror.refresh(4);
    mirror.invalidate(4);
    expect(mirror.view(4)).toEqual({ pr: 4, lines: [], missing: false, stale: false, offset: 0 });
  });
});

// ---- the board follows the selection --------------------------------------

const snapshot: StatusSnapshot = {
  written_at: "2026-08-14T12:00:00Z",
  dry_run: true,
  prs: [
    { number: 5012, state: "reviewing", title: "a", head_sha: "aa", stale_recheck: 0 },
    { number: 5049, state: "reviewing", title: "b", head_sha: "bb", stale_recheck: 0 },
  ],
  running_rounds: 0,
  max_concurrent_rounds: 12,
  total_spend_usd: 0,
  today_spend_usd: 0,
  heartbeat: "2026-08-14T12:00:00Z",
};

function fakeStreams() {
  const out = new EventEmitter() as any;
  let buf = "";
  out.columns = 100;
  out.rows = 24;
  out.write = (s: string) => ((buf += s), true);
  const input = new EventEmitter() as any;
  input.isTTY = false;
  input.resume = () => {};
  input.pause = () => {};
  input.setRawMode = () => {};
  return {
    out,
    input,
    written: () => buf,
    type: (s: string | Buffer) => input.emit("data", Buffer.from(s)),
  };
}

function appWith(opts: { liveSessions?: number[] } = {}) {
  const captures: number[] = [];
  const captureArgvs: string[][] = [];
  const sendKeys: string[][] = [];
  const ssh: SshRunner = async (_h, argv) => {
    if (argv.includes("capture-pane")) {
      const pr = Number(/pr-(\d+)/.exec(argv.join(" "))?.[1]);
      captures.push(pr);
      captureArgvs.push(argv);
      if (opts.liveSessions && !opts.liveSessions.includes(pr)) return fail();
      return ok(`pane of pr-${pr}`);
    }
    if (argv.includes("send-keys")) {
      sendKeys.push(argv);
      return ok("");
    }
    if (argv[0] === "cat") return ok(JSON.stringify(snapshot));
    if (argv.includes("events")) return ok(JSON.stringify({ events: [] }));
    return ok("{}");
  };
  const streams = fakeStreams();
  const app = new App(TUI_DEFAULTS, ssh, streams.out, streams.input);
  const running = app.run(); // installs the input handler and the poller
  app.view.snapshot = snapshot;
  app.selectPr(5012);
  return { app, streams, captures, captureArgvs, sendKeys, running };
}

/** Let the fire-and-forget send/capture chains settle (real timers). */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
};

/** A click inside the pane region of a 100x24 board (piTop 12, rows 13–22). */
const CLICK_IN_PANE = "\x1b[<0;40;18M";
const CLICK_ON_ROW = "\x1b[<0;20;3M";

describe("App ↔ pi mirror", () => {
  it("follows the selection through a debounce and caches per PR", async () => {
    vi.useFakeTimers();
    try {
      const { app, streams, captures, running } = appWith();
      await vi.advanceTimersByTimeAsync(300); // initial poll + first capture settle
      captures.length = 0;

      streams.type("j"); // move to #5049
      expect(captures).toEqual([]); // debounced, not one ssh per keystroke
      await vi.advanceTimersByTimeAsync(300);
      expect(captures).toEqual([5049]);
      expect(app.view.pi).toMatchObject({ pr: 5049, missing: false });
      expect(app.view.pi?.lines[0]).toContain("pr-5049");

      streams.type("k"); // back to #5012: the cached capture paints immediately
      expect(app.view.pi?.pr).toBe(5012);
      expect(app.view.pi?.lines[0]).toContain("pr-5012");
      await vi.advanceTimersByTimeAsync(300);
      expect(captures).toEqual([5049, 5012]);
      app.quit();
      await running;
    } finally {
      vi.useRealTimers();
    }
  });

  it("a click on the pane focuses it in place — it never opens the full-screen attach", async () => {
    const { app, streams, running } = appWith();
    app.repaint(); // publish the frame the hit test reads
    streams.type(CLICK_IN_PANE);
    // Structural since 2026-09-02: there is no attach hook to fire at all.
    expect("attach" in app.hooks).toBe(false);
    expect(app.piFocused()).toBe(true);
    expect(app.view.piPr).toBe(5012);
    app.quit();
    await running;
  });

  it("⏎ and 'a' focus the EMBEDDED pane — never the full-screen attach", async () => {
    // The owner, 2026-08-21: "I dont EVER WANT IT to go into full screen mode …
    // same goes for the PI on the board view". The pane is the same live
    // terminal the attach was, bounded to its region — so the full-screen
    // hook must not fire for a PR row at all.
    const { app, streams, running } = appWith();
    app.repaint();
    streams.type("\r");
    expect(app.piFocused()).toBe(true);
    expect(app.view.piPr).toBe(5012);
    // Ctrl-q releases, and 'a' (the attach verb) does the same thing as ⏎.
    streams.type("\x11");
    expect(app.piFocused()).toBe(false);
    streams.type("a");
    expect(app.piFocused()).toBe(true);
    app.quit();
    await running;
  });
});

// ---- the pane as an embedded terminal --------------------------------------

describe("focused pi pane — keys go to the session", () => {
  async function focused() {
    const h = appWith();
    h.app.repaint();
    h.streams.type(CLICK_IN_PANE);
    await settle();
    h.sendKeys.length = 0;
    h.captureArgvs.length = 0;
    return h;
  }

  it("forwards printable text as one literal send-keys and re-captures", async () => {
    const { app, streams, sendKeys, captureArgvs, running } = await focused();
    streams.type("hello");
    await settle();
    expect(sendKeys).toEqual([
      [
        "sudo",
        "docker",
        "exec",
        "quickreview-sandbox",
        "tmux",
        "send-keys",
        "-t",
        "pr-5012",
        "-l",
        "hello",
      ],
    ]);
    expect(captureArgvs.length).toBeGreaterThan(0); // echo lands now, not next tick
    app.quit();
    await running;
  });

  it("board bindings are just text while focused — j/k/q/1-5 never act", async () => {
    const { app, streams, sendKeys, running } = await focused();
    const before = app.view.selected;
    streams.type("j");
    streams.type("k");
    streams.type("q");
    streams.type("5");
    streams.type("?");
    await settle();
    expect(sendKeys.map((a) => a.slice(-2))).toEqual([
      ["-l", "j"],
      ["-l", "k"],
      ["-l", "q"],
      ["-l", "5"],
      ["-l", "?"],
    ]);
    expect(app.view.selected).toBe(before);
    expect(app.tab).toBe("board");
    expect(app.view.help).toBe(false);
    app.quit();
    await running;
  });

  it("translates specials: Enter, Escape, arrows, Ctrl-x", async () => {
    const { app, streams, sendKeys, running } = await focused();
    streams.type("\r");
    streams.type("\x1b");
    streams.type("\x1b[A");
    streams.type("\x18");
    await settle();
    expect(sendKeys.map((a) => a.slice(8))).toEqual([["Enter"], ["Escape"], ["Up"], ["C-x"]]);
    app.quit();
    await running;
  });

  it("Ctrl-q hands the keyboard back to the list and never reaches the session", async () => {
    const { app, streams, sendKeys, running } = await focused();
    streams.type("\x11");
    await settle();
    expect(sendKeys).toEqual([]);
    expect(app.piFocused()).toBe(false);
    streams.type("j"); // the board answers again
    expect(app.view.selected).toBe(1);
    app.quit();
    await running;
  });

  it("locks follow: a selection change cannot move the keyboard to another session", async () => {
    const { app, streams, captures, running } = await focused();
    app.selectPr(5049); // e.g. an event jump while typing
    await settle();
    expect(app.view.piPr).toBe(5012);
    expect(captures).not.toContain(5049);
    streams.type("x");
    await settle();
    expect(app.view.piPr).toBe(5012);
    app.quit();
    await running;
  });

  it("clicking back in the list blurs the pane and still selects the row", async () => {
    const { app, streams, running } = await focused();
    streams.type(CLICK_ON_ROW);
    await settle();
    expect(app.piFocused()).toBe(false);
    expect(app.currentPr()).toBe(5012); // first sorted row
    app.quit();
    await running;
  });

  it("drops focus gracefully when the focused session dies", async () => {
    const live = [5012];
    const h = appWith({ liveSessions: live });
    h.app.repaint();
    h.streams.type(CLICK_IN_PANE);
    await settle();
    expect(h.app.piFocused()).toBe(true);

    live.length = 0; // the round finished, tmux session archived
    await h.app.pi.refresh(5012);
    await settle();
    expect(h.app.piFocused()).toBe(false);
    expect(h.app.view.pi?.stale).toBe(true); // the last capture stays on screen
    expect(h.app.view.noticeLine).toContain("gone");
    h.streams.type("j"); // the board has the keyboard back
    expect(h.app.view.selected).toBe(1);
    h.app.quit();
    await h.running;
  });
});

describe("pi pane scrollback (wheel)", () => {
  it("wheel over the pane scrolls its history and shows the offset", async () => {
    const { app, streams, captureArgvs, running } = appWith();
    app.repaint();
    captureArgvs.length = 0;
    streams.type("\x1b[<64;40;18M"); // wheel-up inside the pane
    await settle();
    expect(app.view.pi?.offset).toBe(3);
    // The resize rides the same invocation as the capture (100×24 terminal →
    // a 96×7 mirror rectangle: at 100 columns the command bar wraps to three
    // rows); without it pi would wrap at tmux's detached 80-column
    // default and the capture would crowd into the left of the pane.
    expect(captureArgvs.at(-1)).toEqual([
      "sudo",
      "docker",
      "exec",
      "quickreview-sandbox",
      "tmux",
      "resize-window",
      "-t",
      "pr-5012",
      "-x",
      "96",
      "-y",
      "7",
      ";",
      "capture-pane",
      "-e",
      "-p",
      "-J",
      "-S",
      "-203",
      "-t",
      "pr-5012",
    ]);
    expect(stripAnsi(piHeader(5012, app.view.pi, true))).toContain("↑ 3 lines back · End live");

    streams.type("\x1b[<65;40;18M"); // wheel-down: back to the live tail
    await settle();
    expect(app.view.pi?.offset).toBe(0);
    expect(captureArgvs.at(-1)).not.toContain("-S");
    app.quit();
    await running;
  });

  it("a keypress while parked in history snaps the pane back to live", async () => {
    const { app, streams, captureArgvs, running } = appWith();
    app.repaint();
    streams.type(CLICK_IN_PANE);
    streams.type("\x1b[<64;40;18M");
    streams.type("\x1b[<64;40;18M");
    await settle();
    expect(app.view.pi?.offset).toBe(6);
    captureArgvs.length = 0;
    streams.type("z");
    await settle();
    expect(app.view.pi?.offset).toBe(0);
    expect(captureArgvs.at(-1)).not.toContain("-S");
    app.quit();
    await running;
  });

  it("wheel outside the pane keeps its board meaning (move the selection)", async () => {
    const { app, streams, running } = appWith();
    app.repaint();
    streams.type("\x1b[<65;20;3M"); // wheel-down over the PR list
    await settle();
    expect(app.view.selected).toBe(1);
    expect(app.view.pi?.offset ?? 0).toBe(0);
    app.quit();
    await running;
  });
});

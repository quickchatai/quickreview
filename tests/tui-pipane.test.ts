// The board's live pi mirror (2026-08-14 layout rebuild): capture argv,
// escape-sequence hygiene, and the debounced stale-while-revalidate cache.
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { TUI_DEFAULTS } from "../src/config.js";
import { App } from "../src/tui/app.js";
import { PiMirror, keepSgrOnly, splitCapture } from "../src/tui/pipane.js";
import { captureArgv, type RemoteResult, type SshRunner } from "../src/tui/remote.js";
import type { StatusSnapshot } from "../src/state.js";

const ok = (stdout: string): RemoteResult => ({ ok: true, stdout, stderr: "", code: 0 });
const fail = (): RemoteResult => ({ ok: false, stdout: "", stderr: "no such session", code: 1 });

describe("captureArgv", () => {
  it("captures the pane inside the container, colors kept, wrapped lines joined", () => {
    expect(captureArgv(TUI_DEFAULTS, "pr-5012")).toEqual([
      "sudo", "docker", "exec", "quickreview-sandbox", "tmux", "capture-pane", "-e", "-p", "-J", "-t", "pr-5012",
    ]);
  });

  it("mirrors attachArgv's docker prefix (sudo off = plain docker, no -it)", () => {
    const argv = captureArgv({ ...TUI_DEFAULTS, sudo_docker: false }, "overseer");
    expect(argv[0]).toBe("docker");
    expect(argv).not.toContain("-it");
    expect(argv[argv.length - 1]).toBe("overseer");
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
    expect(mirror.view(5012)).toEqual({ pr: 5012, lines: [], missing: false, stale: false });
    await mirror.refresh(5012);
    expect(mirror.view(5012)).toEqual({ pr: 5012, lines: ["hello", "world"], missing: false, stale: false });
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
    expect(mirror.view(7)).toEqual({ pr: 7, lines: ["output"], missing: true, stale: true });
  });

  it("reports a never-seen session as missing without a stale marker", async () => {
    const { mirror } = mirrorWith({});
    await mirror.refresh(9);
    expect(mirror.view(9)).toEqual({ pr: 9, lines: [], missing: true, stale: false });
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
    expect(mirror.view(4)).toEqual({ pr: 4, lines: [], missing: false, stale: false });
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
  return { out, input, written: () => buf, type: (s: string | Buffer) => input.emit("data", Buffer.from(s)) };
}

function appWith() {
  const captures: number[] = [];
  const ssh: SshRunner = async (_h, argv) => {
    const last = argv[argv.length - 1] ?? "";
    if (argv.includes("capture-pane")) {
      captures.push(Number(/pr-(\d+)/.exec(last)?.[1]));
      return ok(`pane of ${last}`);
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
  return { app, streams, captures, running };
}

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

  it("a click on the mirror region attaches the selected session", async () => {
    const { app, streams, running } = appWith();
    let attached: string | undefined;
    app.hooks.attach = async (session) => void (attached = session);
    app.repaint(); // publish the frame the hit test reads
    streams.type("\x1b[<0;40;18M"); // inside the lower mirror region
    expect(attached).toBe("pr-5012");
    app.quit();
    await running;
  });
});

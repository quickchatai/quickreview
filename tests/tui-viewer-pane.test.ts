// The PR pane chooses its surface per PR from status.json `runtime`, with no
// toggle: a tmux PR keeps today's mirror, a worker / answer / idle PR gets the
// transcript viewer, a debug / takeover PR gets the termmirror pi terminal of
// debug-pr-<n> / takeover-pr-<n> — every byte but Ctrl-q forwarded to pi, and
// no viewer input line on it. The App runs against a fake state dir and a fake
// tmux; nothing here touches a box or a model.
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { TUI_DEFAULTS } from "../src/config.js";
import type { PrRuntime, StatusSnapshot } from "../src/state.js";
import { App } from "../src/tui/app.js";
import { piHeader, renderBoard, type BoardAction } from "../src/tui/board.js";
import type { Zone } from "../src/tui/mouse.js";
import { stripAnsi } from "../src/tui/paint.js";
import type { ControlRequest } from "../src/tui/livecontrol.js";
import type { RemoteResult, SshRunner } from "../src/tui/remote.js";
import { stateDirRunner } from "./helpers/live-state-runner.js";

const tmp = mkdtempSync(join(tmpdir(), "tui-viewer-pane-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const ok = (stdout: string): RemoteResult => ({ ok: true, stdout, stderr: "", code: 0 });

const PRS: Array<[number, PrRuntime | undefined]> = [
  [5012, undefined], // the legacy tmux VM: no runtime field at all
  [5013, "tmux"],
  [5049, "worker"],
  [5050, "idle"],
  [5051, "debug"],
  [5052, "takeover"],
];

/** The round PR 5049 is in, and the progress its worker publishes for it. */
const ROUND = {
  round_no: 1,
  round_type: "initial",
  status: "running" as const,
  started_at: "2026-10-19T11:50:00Z",
  deadline_at: "2026-10-19T12:50:00Z",
  lenses: "pass-baseline,pass-security",
  validate_tier: null,
  command_id: "cmd-1",
  command_sha256: "c".repeat(64),
  head_sha: "aa",
};
const PROGRESS = {
  version: 2,
  pr: 5049,
  session: "pr-5049",
  command_id: "cmd-1",
  command_sha256: "c".repeat(64),
  command_accepted_at: "2026-10-19T11:50:01Z",
  preparing_at: "2026-10-19T11:50:01Z",
  first_lens_started_at: "2026-10-19T11:51:00Z",
  fanout_started_at: "2026-10-19T11:51:00Z",
  round_no: 1,
  head_sha: "aa",
  run_started_at: "2026-10-19T11:50:01Z",
  updated_at: "2026-10-19T11:59:59Z",
  parent_status: "active",
  last_activity_at: "2026-10-19T11:59:58Z",
  last_activity: "pass-security · grep",
  agents: [
    {
      execution_id: "a",
      agent: "pass-baseline--sol-high",
      status: "completed",
      duration_ms: 1000,
      tool_count: 1,
      started_at: "2026-10-19T11:51:00Z",
      finished_at: "2026-10-19T11:52:00Z",
    },
    {
      execution_id: "b",
      agent: "pass-security--sol-high",
      status: "running",
      duration_ms: 1000,
      tool_count: 1,
      started_at: "2026-10-19T11:51:00Z",
    },
  ],
};
const WHY = {
  pr: 5049,
  known: true,
  state: "reviewing",
  title: "pr 5049",
  head_sha: "aa",
  trigger_ts: "2026-10-19T11:00:00Z",
  spend_usd: 0,
  rounds: [],
  threads: { open: 0, total: 0 },
  ledger: "",
};

function snapshotOf(runtimes: Map<number, PrRuntime | undefined>): StatusSnapshot {
  return {
    written_at: "2026-10-19T12:00:00Z",
    dry_run: true,
    prs: PRS.map(([number]) => ({
      number,
      state: "reviewing" as const,
      title: `pr ${number}`,
      head_sha: "aa",
      stale_recheck: 0,
      ...(runtimes.get(number) !== undefined ? { runtime: runtimes.get(number)! } : {}),
      ...(number === 5049 ? { current_round: ROUND } : {}),
    })),
    running_rounds: 0,
    max_concurrent_rounds: 12,
    total_spend_usd: 0,
    today_spend_usd: 0,
    heartbeat: "2026-10-19T12:00:00Z",
  };
}

const line = (seq: number, body: Record<string, unknown>): string =>
  JSON.stringify({ v: 1, seq, at: "2026-10-19T12:00:00.000Z", ...body }) + "\n";

/** A round log for each PR that has a runtime of its own: 40 user rows, so the
 * viewer has scrollback, and two lens sessions. */
function writeLogs(root: string, pr: number): void {
  const put = (rel: string, body: string): void => {
    const path = join(root, "state", "live", `pr-${pr}`, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  };
  const rows = Array.from({ length: 40 }, (_, i) =>
    line(i + 3, { type: "message_start", role: "user", text: `transcript row ${i + 1} of #${pr}` }),
  ).join("");
  put(
    "r1/main.jsonl",
    line(1, {
      type: "session_start",
      stream: "main",
      key: `pr-${pr}`,
      round: 1,
      pr,
      session: "s",
    }) +
      line(2, {
        type: "tool_update",
        id: "t",
        tool: "lens",
        n: 1,
        results: [{ slot: 0, agent: "pass-security--sol-high", id: "L1" }],
      }) +
      rows,
  );
  put("r1/lens-L1.jsonl", line(1, { type: "message_delta", text: `lens words for #${pr}` }));
}

function fakeStreams() {
  const out = new EventEmitter() as any;
  out.columns = 100;
  out.rows = 24;
  out.write = () => true;
  const input = new EventEmitter() as any;
  input.isTTY = false;
  input.resume = () => {};
  input.pause = () => {};
  input.setRawMode = () => {};
  return { out, input, type: (s: string | Buffer) => input.emit("data", Buffer.from(s)) };
}

function rig() {
  const root = mkdtempSync(join(tmp, "state-"));
  for (const [pr, rt] of PRS) if (rt === "worker" || rt === "idle") writeLogs(root, pr);
  const runtimes = new Map<number, PrRuntime | undefined>(PRS);
  const captured: string[] = []; // the tmux session of each capture-pane
  const sent: string[][] = []; // each send-keys argv
  const fallback: SshRunner = async (_h, argv) => {
    const target = argv[argv.indexOf("-t") + 1] ?? "";
    if (argv.includes("capture-pane")) {
      captured.push(target);
      return ok(`pane of ${target}`);
    }
    if (argv.includes("send-keys")) {
      sent.push(argv);
      return ok("");
    }
    if (argv.at(-1)?.endsWith("round-progress/pr-5049.json")) return ok(JSON.stringify(PROGRESS));
    if (argv.includes("why")) return ok(JSON.stringify(WHY));
    if (argv[0] === "cat") return ok(JSON.stringify(snapshotOf(runtimes)));
    if (argv.includes("events")) return ok(JSON.stringify({ events: [] }));
    return ok("{}");
  };
  const state = stateDirRunner(root, fallback);
  const streams = fakeStreams();
  const app = new App(TUI_DEFAULTS, state.ssh, streams.out, streams.input);
  const running = app.run();
  app.view.snapshot = snapshotOf(runtimes);
  return { app, streams, runtimes, captured, sent, calls: state.calls, running };
}

/** Select a PR and let its debounced read land. */
async function show(h: ReturnType<typeof rig>, pr: number): Promise<void> {
  h.app.selectPr(pr);
  await vi.advanceTimersByTimeAsync(400);
}

const sessionsOf = (sent: string[][]): string[] => sent.map((a) => a[a.indexOf("-t") + 1]!);
const liveReads = (calls: string[][]): string[] =>
  calls.filter((c) => c.some((w) => w.includes("/live/"))).map((c) => c.at(-1)!);

async function withApp<T>(body: (h: ReturnType<typeof rig>) => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  const h = rig();
  try {
    await vi.advanceTimersByTimeAsync(400);
    return await body(h);
  } finally {
    h.app.quit();
    await h.running;
    vi.useRealTimers();
  }
}

const frame = (h: ReturnType<typeof rig>): string[] =>
  renderBoard(h.app.view, 100, 24).lines.map((l) => stripAnsi(l));

describe("the PR pane picks its surface per PR from status.json runtime", () => {
  it("a mixed board: the tmux PR is mirrored, the worker PR is a viewer — both on one screen", async () => {
    await withApp(async (h) => {
      h.captured.length = 0;
      h.calls.length = 0;

      await show(h, 5012);
      expect(h.captured).toContain("pr-5012");
      expect(h.app.view.pi?.viewer).toBeUndefined();
      expect(h.app.view.pi?.lines).toEqual(["pane of pr-5012"]);
      expect(liveReads(h.calls)).toEqual([]);

      await show(h, 5049);
      expect(h.captured).not.toContain("pr-5049");
      expect(h.app.view.pi?.viewer).toMatchObject({ round: 1, stream: "main" });
      expect(stripAnsi(h.app.view.pi!.lines.at(-1)!)).toContain("transcript row 40 of #5049");
      expect(liveReads(h.calls).some((p) => p.includes("/live/pr-5049/r1/main.jsonl"))).toBe(true);
      const screen = frame(h).join("\n");
      expect(screen).toContain("LIVE pr-5049");
      expect(screen).toContain("transcript row 40 of #5049");

      // and back: the cached mirror paints at once, with no viewer on it
      await show(h, 5013); // runtime "tmux" is the mirror too
      expect(h.captured).toContain("pr-5013");
      expect(frame(h).join("\n")).toContain("PI pr-5013");
      expect(frame(h).join("\n")).not.toContain("LIVE");
    });
  });

  it("an idle PR gets the viewer, and so does an answer worker's", async () => {
    await withApp(async (h) => {
      await show(h, 5050);
      expect(h.app.view.pi?.viewer).toMatchObject({ round: 1 });
      expect(h.captured).not.toContain("pr-5050");
      h.runtimes.set(5050, "answer");
      await h.app.poller.tick();
      await show(h, 5050);
      expect(h.app.view.pi?.viewer).toBeDefined();
    });
  });

  it.each([
    [5051, "debug-pr-5051"],
    [5052, "takeover-pr-5052"],
  ])("PR %i (debug / takeover) is the termmirror of %s, never the viewer", async (pr, session) => {
    await withApp(async (h) => {
      h.calls.length = 0;
      await show(h, pr);
      expect(h.captured).toContain(session);
      expect(h.captured).not.toContain(`pr-${pr}`);
      expect(h.app.view.pi?.viewer).toBeUndefined();
      expect(h.app.view.pi?.session).toBe(session);
      expect(h.app.view.pi?.lines).toEqual([`pane of ${session}`]);
      expect(liveReads(h.calls)).toEqual([]);
      expect(piHeader(pr, h.app.view.pi)).toContain(session);
    });
  });

  it.each([
    [5051, "debug-pr-5051"],
    [5052, "takeover-pr-5052"],
  ])(
    "%i: every byte but Ctrl-q goes to pi, and no input line ever appears",
    async (pr, session) => {
      await withApp(async (h) => {
        await show(h, pr);
        h.app.repaint();
        h.streams.type("\r"); // ⏎ focuses the pane
        expect(h.app.piFocused()).toBe(true);
        h.sent.length = 0;

        // text, Esc, ⏎, Ctrl-C, `/`, `q`, a digit, `[`, `<`: none is the board's
        const typed = ["hello", "\x1b", "\r", "\x03", "/", "q", "2", "[", "<", "\x1b[5~", "\x7f"];
        for (const bytes of typed) {
          h.streams.type(bytes);
          await vi.advanceTimersByTimeAsync(5);
          expect(h.app.piFocused(), JSON.stringify(bytes)).toBe(true);
        }
        expect(sessionsOf(h.sent)).toHaveLength(typed.length);
        expect(new Set(sessionsOf(h.sent))).toEqual(new Set([session]));
        expect(h.sent[0]).toContain("hello");
        expect(h.sent.map((a) => a.slice(a.indexOf("send-keys") + 3).join(" "))).toEqual([
          "-l -- hello",
          "Escape",
          "Enter",
          "C-c",
          "-l -- /",
          "-l -- q",
          "-l -- 2",
          "-l -- [",
          "-l -- <",
          "PPage",
          "BSpace",
        ]);

        const screen = frame(h).join("\n");
        expect(screen).not.toContain("read-only"); // the viewer's header, not a terminal's
        expect(screen).not.toContain("MSG →");
        expect(screen).toContain(`PI ${session}`);

        // Ctrl-q is the one reserved byte: it releases and travels nowhere
        h.sent.length = 0;
        h.streams.type("\x11");
        await vi.advanceTimersByTimeAsync(5);
        expect(h.app.piFocused()).toBe(false);
        expect(h.sent).toEqual([]);
      });
    },
  );
});

describe("the viewer is not a terminal", () => {
  it("focused, nothing is forwarded to tmux; PgUp parks, End follows, [ ] and < > step, Ctrl-q releases", async () => {
    await withApp(async (h) => {
      await show(h, 5049);
      h.app.repaint();
      h.captured.length = 0;
      h.streams.type("\r");
      expect(h.app.piFocused()).toBe(true);
      h.sent.length = 0;

      h.streams.type("hello world q 1 /"); // text for the input line, not for the board or tmux
      expect(frame(h).join("\n")).toContain("hello world q 1 /");
      h.streams.type("\x1b"); // Esc clears the draft
      h.streams.type("\x03"); // a single ^C is not the kill chord: it asks to abort the round
      await vi.advanceTimersByTimeAsync(5);
      expect(h.sent).toEqual([]);
      expect(h.app.piFocused()).toBe(true);
      expect(frame(h).join("\n")).toContain("abort the running round of #5049?");
      h.streams.type("n"); // anything but y cancels
      expect(frame(h).join("\n")).not.toContain("abort the running round");
      expect(frame(h).join("\n")).toContain("steer ›");

      h.streams.type("\x1b[5~");
      const parked = h.app.view.pi!.offset;
      expect(parked).toBeGreaterThan(0);
      expect(frame(h).join("\n")).toContain(`↑ ${parked} rows back`);
      h.streams.type("\x1b[F"); // End
      expect(h.app.view.pi!.offset).toBe(0);
      h.streams.type("\x1b[A");
      expect(h.app.view.pi!.offset).toBe(1);
      h.streams.type("\x1b[B");
      expect(h.app.view.pi!.offset).toBe(0);

      h.streams.type("]");
      await vi.advanceTimersByTimeAsync(5);
      expect(h.app.view.pi?.viewer).toMatchObject({ stream: "pass-security--sol-high" });
      expect(stripAnsi(h.app.view.pi!.lines.join("\n"))).toContain("lens words for #5049");
      h.streams.type("[");
      expect(h.app.view.pi?.viewer?.stream).toBe("main");

      expect(h.sent).toEqual([]);
      expect(h.captured).toEqual([]);
      h.streams.type("\x11");
      expect(h.app.piFocused()).toBe(false);
    });
  });

  it("a click on a lens row of the progress panel picks that lens's transcript", async () => {
    await withApp(async (h) => {
      h.streams.out.rows = 50; // tall enough that the progress rows are on screen
      await show(h, 5049);
      await vi.advanceTimersByTimeAsync(400); // detail and progress land
      h.app.repaint();
      const zone = (renderBoard(h.app.view, 100, 50).zones as Zone<BoardAction>[]).find(
        (z) => z.action.t === "viewer-lens" && z.action.lens === "pass-security",
      );
      expect(zone, "the pass-security row is a click target").toBeDefined();
      h.streams.type(`\x1b[<0;${zone!.x1 + 2};${zone!.y1}M`);
      await vi.advanceTimersByTimeAsync(5);
      expect(h.app.view.pi?.viewer?.stream).toBe("pass-security--sol-high");
      expect(stripAnsi(h.app.view.pi!.lines.join("\n"))).toContain("lens words for #5049");
      expect(h.app.piFocused()).toBe(false); // picking a row does not take the keyboard

      // a lens that never logged says so rather than doing nothing
      const base = (renderBoard(h.app.view, 100, 50).zones as Zone<BoardAction>[]).find(
        (z) => z.action.t === "viewer-lens" && z.action.lens === "pass-baseline",
      )!;
      h.streams.type(`\x1b[<0;${base.x1 + 2};${base.y1}M`);
      await vi.advanceTimersByTimeAsync(5);
      expect(h.app.view.pi?.viewer?.stream).toBe("pass-security--sol-high");
      expect(h.app.view.noticeLine ?? "").toMatch(/pass-baseline: no transcript yet/);
    });
  });

  it("registers [ ] < > only while the selected PR's pane is the viewer", async () => {
    await withApp(async (h) => {
      for (const [pr, expected] of [
        [5012, false],
        [5013, false],
        [5049, true],
        [5050, true],
        [5051, false],
        [5052, false],
      ] as const) {
        await show(h, pr);
        const keys = h.app.registeredKeys();
        for (const k of ["[", "]", "<", ">"]) expect(keys.has(k), `#${pr} ${k}`).toBe(expected);
      }
    });
  });

  it("[ ] and < > work unfocused on the selected viewer PR", async () => {
    await withApp(async (h) => {
      await show(h, 5049);
      h.streams.type("]");
      await vi.advanceTimersByTimeAsync(5);
      expect(h.app.view.pi?.viewer?.streamIndex).toBe(2);
      h.streams.type("<"); // only one round: nothing earlier, nothing changes
      expect(h.app.view.pi?.viewer?.round).toBe(1);
      expect(h.app.piFocused()).toBe(false);
    });
  });

  it("hands the keyboard back when the PR's runtime flips the pane's surface", async () => {
    await withApp(async (h) => {
      await show(h, 5049);
      h.app.repaint();
      h.streams.type("\r");
      expect(h.app.piFocused()).toBe(true);
      h.runtimes.set(5049, "debug"); // the operator started a debug round
      await h.app.poller.tick();
      expect(h.app.piFocused()).toBe(false);
      expect(h.app.view.noticeLine).toMatch(/#5049's pane changed/);
      await vi.advanceTimersByTimeAsync(400);
      expect(h.captured).toContain("debug-pr-5049");
      expect(h.app.view.pi?.viewer).toBeUndefined();
    });
  });

  it("a mirror whose PR went to debug drops the old capture instead of painting it", async () => {
    await withApp(async (h) => {
      h.runtimes.set(5012, undefined);
      await show(h, 5012);
      expect(h.app.view.pi?.lines).toEqual(["pane of pr-5012"]);
      h.runtimes.set(5012, "debug");
      await h.app.poller.tick();
      expect(h.app.view.pi?.session).toBe("debug-pr-5012");
      expect(h.app.view.pi?.lines).toEqual([]); // nothing of pr-5012's text
      await vi.advanceTimersByTimeAsync(400);
      expect(h.app.view.pi?.lines).toEqual(["pane of debug-pr-5012"]);
    });
  });
});

describe("the viewer's input line (worker, answer and idle panes only)", () => {
  /** Focus the selected PR's pane and record every control the line sends. */
  async function focused(h: ReturnType<typeof rig>, pr: number) {
    const sent: ControlRequest[] = [];
    h.app.hooks.liveControl = vi.fn(async (req: ControlRequest) => {
      sent.push(req);
      return { state: "handled" as const, label: `✓ ${req.kind} #${req.pr} delivered` };
    });
    await show(h, pr);
    h.app.repaint();
    h.streams.type("\r");
    expect(h.app.piFocused()).toBe(true);
    return sent;
  }
  const type = async (h: ReturnType<typeof rig>, ...keys: string[]): Promise<void> => {
    for (const k of keys) h.streams.type(k);
    await vi.advanceTimersByTimeAsync(5);
  };
  const screen = (h: ReturnType<typeof rig>): string => frame(h).join("\n");

  it("exists on the viewer only: a mirror and a pi terminal have none", async () => {
    await withApp(async (h) => {
      for (const [pr, has] of [
        [5012, false],
        [5013, false],
        [5049, true],
        [5050, true],
        [5051, false],
        [5052, false],
      ] as const) {
        await show(h, pr);
        expect(h.app.view.viewerInput !== undefined, `#${pr}`).toBe(has);
        expect(screen(h).includes("⏎ focus this pane, then type"), `#${pr}`).toBe(has);
      }
    });
  });

  it("unfocused it says how to reach it; focused it shows the prompt and the visible toggle", async () => {
    await withApp(async (h) => {
      await show(h, 5049);
      expect(screen(h)).toContain("⏎ focus this pane, then type to steer #5049");
      await show(h, 5050);
      expect(screen(h)).toContain("⏎ focus this pane, then type to message #5050");
      h.streams.type("\r");
      expect(screen(h)).toContain("msg ›");
      expect(screen(h)).toContain("[Alt-p post: off]");
    });
  });

  it("⏎ steers while a round runs, and the draft is cleared", async () => {
    await withApp(async (h) => {
      const sent = await focused(h, 5049);
      await type(h, "look at the ", "lock order [1]");
      expect(screen(h)).toContain("steer › look at the lock order [1]");
      await type(h, "\r");
      expect(sent).toEqual([{ kind: "steer", pr: 5049, text: "look at the lock order [1]" }]);
      expect(h.app.view.viewerInput?.text).toBe("");
      await type(h, "\r"); // an empty line sends nothing
      expect(sent).toHaveLength(1);
      expect(h.sent).toEqual([]); // nothing went to tmux
    });
  });

  it("Alt-⏎ queues a follow-up behind the running turn", async () => {
    await withApp(async (h) => {
      const sent = await focused(h, 5049);
      await type(h, "and then the migration", "\x1b\r");
      expect(sent).toEqual([{ kind: "follow-up", pr: 5049, text: "and then the migration" }]);
    });
  });

  it("on an idle PR ⏎ sends a message; Alt-⏎ has nothing to queue behind", async () => {
    await withApp(async (h) => {
      const sent = await focused(h, 5050);
      await type(h, "why did you block this?", "\x1b\r");
      expect(sent).toEqual([]);
      expect(h.app.view.noticeLine).toContain("⏎ sends a message to the PR instead");
      expect(h.app.view.viewerInput?.text).toBe("why did you block this?"); // the draft is kept
      await type(h, "\r");
      expect(sent).toEqual([
        { kind: "message", pr: 5050, text: "why did you block this?", may_post: false },
      ]);
    });
  });

  it("Alt-p marks the next message may_post: shown, carried, and reset after the send", async () => {
    await withApp(async (h) => {
      const sent = await focused(h, 5050);
      expect(screen(h)).toContain("[Alt-p post: off]");
      await type(h, "\x1bp");
      expect(screen(h)).toContain("[Alt-p post: ON]");
      expect(h.app.view.viewerInput?.mayPost).toBe(true);
      await type(h, "approve it if the lock is fixed", "\r");
      expect(sent).toEqual([
        { kind: "message", pr: 5050, text: "approve it if the lock is fixed", may_post: true },
      ]);
      expect(h.app.view.viewerInput?.mayPost).toBe(false);
      expect(screen(h)).toContain("[Alt-p post: off]");
      await type(h, "and the next one", "\r");
      expect(sent[1]).toMatchObject({ may_post: false });
      // toggling twice is off again
      await type(h, "\x1bp", "\x1bp");
      expect(h.app.view.viewerInput?.mayPost).toBe(false);
    });
  });

  it("a steer never carries may_post, and the toggle still resets", async () => {
    await withApp(async (h) => {
      const sent = await focused(h, 5049);
      await type(h, "\x1bp", "go left", "\r");
      expect(sent).toEqual([{ kind: "steer", pr: 5049, text: "go left" }]);
      expect(h.app.view.viewerInput?.mayPost).toBe(false);
    });
  });

  it("abort-round asks for confirmation: only y sends it", async () => {
    await withApp(async (h) => {
      const sent = await focused(h, 5049);
      await type(h, "\x03");
      expect(screen(h)).toContain("abort the running round of #5049? y = abort");
      await type(h, "n");
      expect(sent).toEqual([]);
      expect(screen(h)).not.toContain("abort the running round");
      await type(h, "\x03", "\r"); // ⏎ is not a yes
      expect(sent).toEqual([]);
      await type(h, "\x03", "y");
      expect(sent).toEqual([{ kind: "abort-round", pr: 5049 }]);
      expect(screen(h)).not.toContain("abort the running round");
    });
  });

  it("Ctrl-c on an idle PR has nothing to abort", async () => {
    await withApp(async (h) => {
      const sent = await focused(h, 5050);
      await type(h, "\x03");
      expect(h.app.view.noticeLine).toContain("nothing to abort");
      expect(sent).toEqual([]);
    });
  });

  it("[ ] < > navigate while the line is empty and are text once it has a draft", async () => {
    await withApp(async (h) => {
      await focused(h, 5049);
      await type(h, "]");
      expect(h.app.view.pi?.viewer?.stream).toBe("pass-security--sol-high");
      await type(h, "[");
      expect(h.app.view.pi?.viewer?.stream).toBe("main");
      await type(h, "a", "]");
      expect(h.app.view.pi?.viewer?.stream).toBe("main");
      expect(h.app.view.viewerInput?.text).toBe("a]");
    });
  });

  it("Backspace, Ctrl-u and Esc edit the draft; a paste's newlines become spaces", async () => {
    await withApp(async (h) => {
      await focused(h, 5049);
      await type(h, "abc", "\x7f");
      expect(h.app.view.viewerInput?.text).toBe("ab");
      await type(h, "\x15");
      expect(h.app.view.viewerInput?.text).toBe("");
      await type(h, "one\ntwo\r\nthree");
      expect(h.app.view.viewerInput?.text).toBe("one two three");
      await type(h, "\x1b");
      expect(h.app.view.viewerInput?.text).toBe("");
      expect(h.app.piFocused()).toBe(true); // Esc on a draft only clears it
    });
  });

  it("the draft survives moving to another PR; Ctrl-q is still the only way out", async () => {
    await withApp(async (h) => {
      await focused(h, 5049);
      await type(h, "half a thought");
      await type(h, "\x11");
      expect(h.app.piFocused()).toBe(false);
      await show(h, 5050);
      expect(h.app.view.viewerInput?.text).toBe("");
      await show(h, 5049);
      expect(h.app.view.viewerInput?.text).toBe("half a thought");
    });
  });

  it("with no control route wired the line says so instead of dropping the text silently", async () => {
    await withApp(async (h) => {
      await show(h, 5049);
      h.streams.type("\r");
      await type(h, "hello", "\r");
      expect(h.app.view.noticeLine).toContain("not sent (no control route wired)");
    });
  });

  it("a PR whose runtime flips to debug hands the keyboard back, the line gone", async () => {
    await withApp(async (h) => {
      await focused(h, 5049);
      h.runtimes.set(5049, "debug");
      await h.app.poller.tick();
      await vi.advanceTimersByTimeAsync(5);
      expect(h.app.piFocused()).toBe(false);
      expect(h.app.view.viewerInput).toBeUndefined();
    });
  });
});

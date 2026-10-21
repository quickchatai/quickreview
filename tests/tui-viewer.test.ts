// The board's transcript viewer (src/tui/viewer.ts): which surface a PR's
// runtime gets, how a LiveEvent log reads as a transcript, and what the viewer
// asks the box for. The logs here are a replay of a recorded PR session through
// the LiveEvent writer (the real write path) and hand-written ones where the
// test needs to name the bytes.
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { TUI_DEFAULTS, type TuiConfig } from "../src/config.js";
import { stripAnsi } from "../src/tui/paint.js";
import { liveListArgv, liveReadArgv } from "../src/tui/remote.js";
import { TranscriptViewer, paneSurface, surfaceSession, wrapRow } from "../src/tui/viewer.js";
import { eventsFromSession, mkReplayRoot, replay, type Replayed } from "./helpers/live-replay.js";
import { stateDirRunner } from "./helpers/live-state-runner.js";

const tmp = mkdtempSync(join(tmpdir(), "tui-viewer-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const text = (lines: readonly string[] | undefined): string[] =>
  (lines ?? []).map((l) => stripAnsi(l));

describe("paneSurface — the runtime picks the surface, nothing else does", () => {
  it("absent or tmux is the viewer: the bot runs no `pr-<n>` tmux session to mirror (P9.6)", () => {
    expect(paneSurface(undefined, 7)).toEqual({ kind: "viewer" });
    expect(paneSurface("tmux", 7)).toEqual({ kind: "viewer" });
  });

  it("worker, answer and idle get the viewer", () => {
    for (const r of ["worker", "answer", "idle"])
      expect(paneSurface(r, 7), r).toEqual({ kind: "viewer" });
  });

  it("debug and takeover are pi terminals of their own tmux sessions", () => {
    expect(paneSurface("debug", 7)).toEqual({ kind: "terminal", session: "debug-pr-7" });
    expect(paneSurface("takeover", 7)).toEqual({ kind: "terminal", session: "takeover-pr-7" });
  });

  it("a runtime it does not know is the viewer, which only reads — never a terminal to type into", () => {
    expect(paneSurface("quantum", 7)).toEqual({ kind: "viewer" });
    expect(paneSurface("", 7).kind).toBe("viewer");
  });

  it("only a pi terminal has a tmux session, and it is never `pr-<n>`", () => {
    expect(surfaceSession(paneSurface("worker", 7))).toBeUndefined();
    expect(surfaceSession(paneSurface("debug", 7))).toBe("debug-pr-7");
    expect(surfaceSession(paneSurface("takeover", 7))).toBe("takeover-pr-7");
    for (const r of [undefined, "tmux", "idle", "quantum"])
      expect(surfaceSession(paneSurface(r, 7)), String(r)).toBeUndefined();
  });
});

describe("liveReadArgv / liveListArgv", () => {
  const LOCAL: TuiConfig = { ...TUI_DEFAULTS, target: "local", sudo_docker: false };

  it("cats the whole file, or tails from the byte after the last one read", () => {
    const rel = ["pr-7", "r2", "main.jsonl"];
    expect(liveReadArgv(TUI_DEFAULTS, rel)).toEqual([
      "cat",
      "/opt/quickreview/state/live/pr-7/r2/main.jsonl",
    ]);
    expect(liveReadArgv(TUI_DEFAULTS, rel, 0)).toEqual(liveReadArgv(TUI_DEFAULTS, rel));
    expect(liveReadArgv(TUI_DEFAULTS, rel, 1234)).toEqual([
      "tail",
      "-c",
      "+1235",
      "/opt/quickreview/state/live/pr-7/r2/main.jsonl",
    ]);
  });

  it("is the same command on both transports; the laptop one runs it in the container", () => {
    const rel = ["pr-7", "r2", "main.jsonl"];
    const vm = liveReadArgv(TUI_DEFAULTS, rel, 10);
    const laptop = liveReadArgv(LOCAL, rel, 10);
    expect(laptop).toEqual(["docker", "exec", "quickreview-sandbox", ...vm]);
    expect(liveListArgv(TUI_DEFAULTS, ["pr-7"])).toEqual([
      "ls",
      "-1",
      "/opt/quickreview/state/live/pr-7",
    ]);
    expect(liveListArgv(LOCAL, ["pr-7"]).slice(3)).toEqual(liveListArgv(TUI_DEFAULTS, ["pr-7"]));
  });

  it("refuses a path component that is not a plain token", () => {
    for (const bad of ["..", "a/b", "", "-x", "a b", "a;b"])
      expect(() => liveReadArgv(TUI_DEFAULTS, ["pr-7", bad])).toThrow(/not a live log path/);
  });
});

describe("wrapRow", () => {
  it("leaves a row that fits, breaks at spaces, and keeps the indent", () => {
    expect(wrapRow("    short", 20)).toEqual(["    short"]);
    expect(wrapRow("    the quick brown fox jumps", 16)).toEqual([
      "    the quick",
      "    brown fox",
      "    jumps",
    ]);
  });

  it("hard-breaks a word longer than the row, and never exceeds the width", () => {
    const rows = wrapRow("x".repeat(25), 10);
    expect(rows).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
    for (const w of [4, 7, 13]) {
      const wrapped = wrapRow("ab cdefghij klm nopqrstuvwxyz 日本語のテキスト end", w);
      expect(wrapped.join("").replace(/ /g, "")).toBe(
        "abcdefghijklmnopqrstuvwxyz日本語のテキストend",
      );
    }
  });
});

// ---- hand-written logs -----------------------------------------------------------

const ROOT = (name: string): string => join(tmp, name);

let clock = 0;
const line = (seq: number, body: Record<string, unknown>): string =>
  JSON.stringify({
    v: 1,
    seq,
    at: `2026-10-19T12:${String(Math.floor(seq / 60) % 60).padStart(2, "0")}:${String(seq % 60).padStart(2, "0")}.000Z`,
    ...body,
  }) + "\n";

function put(root: string, rel: string, lines: string): string {
  const path = join(root, "state", "live", rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines);
  return path;
}

/** Round `round` of PR 7: a user order, streamed assistant text, a lens call
 * that started two `pass-security` sessions (L1, L2), and a settled turn. */
function mainLog(round: number, over: { settle?: boolean } = {}): string {
  const bodies: Array<Record<string, unknown>> = [
    {
      type: "session_start",
      stream: "main",
      key: "pr-7",
      round,
      pr: 7,
      session: "s7",
    },
    { type: "agent_start" },
    { type: "message_start", role: "user", text: `Round order for PR 7 round ${round}` },
    { type: "message_delta", text: "Looking at " },
    { type: "message_delta", text: "the diff\nsecond line" },
    { type: "message_end", role: "assistant", stop_reason: "toolUse", tool_calls: ["lens"] },
    {
      type: "tool_start",
      id: "t1",
      tool: "lens",
      executions: [{ agent: "pass-security--sol-high" }, { agent: "pass-security--sol-high" }],
    },
    {
      type: "tool_update",
      id: "t1",
      tool: "lens",
      n: 2,
      results: [
        {
          slot: 0,
          agent: "pass-security--sol-high",
          id: "L1",
          progress: { status: "running", tool_count: 2 },
        },
        {
          slot: 1,
          agent: "pass-security--sol-high",
          id: "L2",
          progress: { status: "running", tool_count: 1 },
        },
      ],
    },
  ];
  if (over.settle !== false) bodies.push({ type: "agent_settled", aborted: false });
  return bodies.map((b, i) => line(i + 1, b)).join("");
}

function lensLog(id: string, round: number, said: string): string {
  return [
    {
      type: "session_start",
      stream: "lens",
      key: "pr-7",
      round,
      pr: 7,
      session: `lens-${id}`,
      lens_id: id,
      agent: "pass-security--sol-high",
    },
    { type: "message_delta", text: said },
  ]
    .map((b, i) => line(i + 1, b))
    .join("");
}

function fixture(name: string): string {
  const root = ROOT(name);
  put(root, "pr-7/r1/main.jsonl", mainLog(1));
  put(root, "pr-7/r1/lens-L1.jsonl", lensLog("L1", 1, "first lens speaking"));
  put(root, "pr-7/r1/lens-L2.jsonl", lensLog("L2", 1, "second lens speaking"));
  return root;
}

function viewerOver(root: string, over: { now?: () => number } = {}) {
  const runner = stateDirRunner(root);
  let updates = 0;
  const v = new TranscriptViewer(
    TUI_DEFAULTS,
    runner.ssh,
    () => updates++,
    0,
    over.now ?? (() => clock),
  );
  v.setViewport({ cols: 60, rows: 6 });
  return { v, runner, updates: () => updates };
}

const lists = (calls: string[][]): string[][] => calls.filter((c) => c[0] === "ls");
const reads = (calls: string[][]): string[][] =>
  calls.filter((c) => c[0] === "cat" || c[0] === "tail");

describe("TranscriptViewer — a hand-written round", () => {
  it("reads the main log as a transcript: the order, streamed text joined into its line, the tool call", async () => {
    const { v, updates } = viewerOver(fixture("main"));
    await v.refresh(7);
    expect(updates()).toBe(1);
    const view = v.view(7)!;
    const lines = text(view.lines);
    expect(view.missing).toBe(false);
    expect(lines.some((l) => l.includes("> Round order for PR 7 round 1"))).toBe(true);
    expect(lines).toContain("    Looking at the diff");
    expect(lines).toContain("    second line");
    expect(lines.join(" ")).toMatch(/tool lens pass-security--sol-high, pass-security--sol-high/);
    expect(lines.some((l) => /agent settled/.test(l))).toBe(true);
    // the assistant's text streamed, so message_end does not print it again
    expect(lines.filter((l) => l.includes("Looking at")).length).toBe(1);
    expect(view.viewer).toMatchObject({
      round: 1,
      rounds: 1,
      roundIndex: 1,
      atLatest: true,
      stream: "main",
      streamIndex: 1,
      streams: 3,
      live: false,
    });
  });

  it("strips terminal control bytes out of foreign text", async () => {
    const root = ROOT("hostile");
    put(
      root,
      "pr-7/r1/main.jsonl",
      line(1, { type: "message_start", role: "user", text: "a\x1b[2Jb\x07\rc" }) +
        line(2, { type: "message_delta", text: "x\x1b]0;title\x07y\x9bz" }),
    );
    const { v } = viewerOver(root);
    await v.refresh(7);
    for (const l of v.view(7)!.lines) {
      // only our own SGR styling may be left
      expect(l.replace(/\x1b\[[0-9;]*m/g, "")).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
    }
  });

  it("wraps to the pane width", async () => {
    const root = ROOT("wide");
    put(
      root,
      "pr-7/r1/main.jsonl",
      line(1, { type: "message_delta", text: `${"word ".repeat(40)}end` }),
    );
    const { v } = viewerOver(root);
    await v.refresh(7);
    const lines = text(v.view(7)!.lines);
    expect(lines.length).toBeGreaterThan(3);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(60);
    expect(lines.join(" ").replace(/\s+/g, " ")).toContain("word word word");
  });

  it("asks for only what was appended: cat once, then tail -c +<offset>", async () => {
    const root = fixture("tail");
    const { v, runner } = viewerOver(root);
    await v.refresh(7);
    const first = reads(runner.calls).at(-1)!;
    expect(first[0]).toBe("cat");
    const path = join(root, "state/live/pr-7/r1/main.jsonl");
    const size = readFileSync(path).length;
    appendFileSync(path, line(10, { type: "message_delta", text: "late news" }));
    await v.refresh(7);
    const second = reads(runner.calls).at(-1)!;
    expect(second.slice(0, 3)).toEqual(["tail", "-c", `+${size + 1}`]);
    expect(text(v.view(7)!.lines).join("\n")).toContain("late news");
  });

  it("leaves a half-written last line for the next read, then shows it whole", async () => {
    const root = ROOT("torn");
    const path = put(root, "pr-7/r1/main.jsonl", line(1, { type: "message_delta", text: "whole" }));
    const { v } = viewerOver(root);
    await v.refresh(7);
    const whole = line(2, { type: "message_delta", text: " and later" });
    appendFileSync(path, whole.slice(0, 20));
    await v.refresh(7);
    expect(text(v.view(7)!.lines)).toEqual(["    whole"]);
    appendFileSync(path, whole.slice(20));
    await v.refresh(7);
    expect(text(v.view(7)!.lines)).toEqual(["    whole and later"]);
  });

  it("follows the tail by default and parks a stable window above it", async () => {
    const root = ROOT("park");
    const body = Array.from({ length: 30 }, (_, i) =>
      line(i + 1, { type: "message_start", role: "user", text: `row ${i + 1}` }),
    ).join("");
    const path = put(root, "pr-7/r1/main.jsonl", body);
    const { v } = viewerOver(root);
    await v.refresh(7);
    expect(v.offsetFor(7)).toBe(0);
    // bottom-anchored: the last rows are the tail
    expect(text(v.view(7)!.lines).at(-1)).toContain("row 30");

    expect(v.scroll(7, 2)).toBe(6); // two notches of three rows
    const before = text(v.view(7)!.lines);
    const shown = (view: ReturnType<typeof v.view>): string[] =>
      text(view!.lines)
        .slice(0, view!.lines.length - view!.offset)
        .slice(-6);
    const parked = shown(v.view(7));

    // three more rows arrive while parked: the window keeps its text
    appendFileSync(
      path,
      [31, 32, 33]
        .map((n) => line(n, { type: "message_start", role: "user", text: `row ${n}` }))
        .join(""),
    );
    await v.refresh(7);
    expect(v.offsetFor(7)).toBe(9);
    expect(shown(v.view(7))).toEqual(parked);
    expect(text(v.view(7)!.lines).length).toBe(before.length + 3);

    // End follows the tail again
    v.setOffset(7, 0);
    expect(text(v.view(7)!.lines).at(-1)).toContain("row 33");
    // the top of the log is the limit
    expect(v.setOffset(7, 10_000)).toBe(33 - 6);
    expect(v.page(7, -1)).toBe(33 - 6 - 5);
  });

  it("steps through the streams: main, then each lens the main log named", async () => {
    const { v, runner } = viewerOver(fixture("streams"));
    await v.refresh(7);
    v.stepStream(7, 1);
    await v.refresh(7);
    let view = v.view(7)!;
    expect(view.viewer).toMatchObject({
      stream: "pass-security--sol-high",
      streamIndex: 2,
      streams: 3,
    });
    expect(text(view.lines).join("\n")).toContain("first lens speaking");
    expect(reads(runner.calls).some((c) => c.at(-1)!.endsWith("/r1/lens-L1.jsonl"))).toBe(true);

    v.stepStream(7, 1);
    await v.refresh(7);
    view = v.view(7)!;
    expect(view.viewer?.streamIndex).toBe(3);
    expect(text(view.lines).join("\n")).toContain("second lens speaking");

    v.stepStream(7, 1); // past the last: stays
    expect(v.view(7)!.viewer?.streamIndex).toBe(3);
    v.stepStream(7, -1);
    v.stepStream(7, -1);
    expect(v.view(7)!.viewer).toMatchObject({ stream: "main", streamIndex: 1 });
    expect(text(v.view(7)!.lines).join("\n")).toContain("Round order");
  });

  it("a progress row picks its lens: the nth run of that lens the main log named", async () => {
    const { v } = viewerOver(fixture("rows"));
    await v.refresh(7);
    expect(v.selectLens(7, "pass-security", 1)).toBe(true);
    await v.refresh(7);
    expect(text(v.view(7)!.lines).join("\n")).toContain("second lens speaking");
    expect(v.selectLens(7, "pass-security", 0)).toBe(true);
    await v.refresh(7);
    expect(text(v.view(7)!.lines).join("\n")).toContain("first lens speaking");
    // a lens the round never started has no transcript to show
    expect(v.selectLens(7, "pass-tests", 0)).toBe(false);
    expect(v.view(7)!.viewer?.stream).toBe("pass-security--sol-high");
  });

  it("follows the newest round, and a past round stays pinned and is read no more", async () => {
    const root = fixture("rounds");
    const { v, runner } = viewerOver(root, { now: () => clock });
    await v.refresh(7);
    expect(v.view(7)!.viewer).toMatchObject({ round: 1, rounds: 1, atLatest: true });

    put(root, "pr-7/r2/main.jsonl", mainLog(2, { settle: false }));
    clock += 10_000; // past the listing throttle
    await v.refresh(7);
    expect(v.view(7)!.viewer).toMatchObject({ round: 2, rounds: 2, roundIndex: 2, atLatest: true });
    expect(v.view(7)!.viewer?.live).toBe(true);
    expect(text(v.view(7)!.lines).join("\n")).toContain("round 2");

    v.stepRound(7, -1);
    expect(v.view(7)!.viewer).toMatchObject({ round: 1, atLatest: false });
    clock += 10_000;
    await v.refresh(7); // one last catch-up read of r1, which r2 has replaced
    expect(text(v.view(7)!.lines).join("\n")).toContain("round 1");
    runner.calls.length = 0;
    clock += 10_000;
    await v.refresh(7);
    // r1 is final now: not read again
    const asked = reads(runner.calls).map((c) => c.at(-1)!);
    expect(asked.some((p) => p.includes("/r1/"))).toBe(false);

    put(root, "pr-7/r3/main.jsonl", mainLog(3, { settle: false }));
    clock += 10_000;
    await v.refresh(7);
    expect(v.view(7)!.viewer).toMatchObject({ round: 1, rounds: 3, atLatest: false }); // pinned
    v.stepRound(7, 1);
    v.stepRound(7, 1);
    expect(v.view(7)!.viewer).toMatchObject({ round: 3, atLatest: true }); // follows again
    v.stepRound(7, 1); // past the newest: stays
    expect(v.view(7)!.viewer?.round).toBe(3);
  });

  it("lists the box only every few seconds, but reads the log every tick", async () => {
    const { v, runner } = viewerOver(fixture("throttle"));
    await v.refresh(7);
    const first = lists(runner.calls).length;
    expect(first).toBe(2); // the PR's rounds, then the round's logs
    await v.refresh(7);
    await v.refresh(7);
    expect(lists(runner.calls).length).toBe(first);
    expect(reads(runner.calls).length).toBeGreaterThanOrEqual(3);
    clock += 4_000;
    await v.refresh(7);
    expect(lists(runner.calls).length).toBe(first + 2);
  });

  it("says so when a PR has no round log, and when the box cannot be read", async () => {
    const empty = viewerOver(ROOT("nothing-here"));
    await empty.v.refresh(9);
    expect(text(empty.v.view(9)!.lines)).toEqual([
      "no transcript for #9 yet — it has no round log",
    ]);
    expect(empty.v.view(9)!.viewer?.round).toBeUndefined();

    const broken = new TranscriptViewer(
      TUI_DEFAULTS,
      async () => ({ ok: false, stdout: "", stderr: "ssh: connect timed out", code: 255 }),
      () => {},
      0,
      () => clock,
    );
    await broken.refresh(9);
    expect(text(broken.view(9)!.lines)[0]).toMatch(/could not be read: ssh: connect timed out/);
  });

  it("before the first read it says it is waiting, and a view of no PR is nothing", () => {
    const { v } = viewerOver(ROOT("unread"));
    expect(text(v.view(7)!.lines)).toEqual(["waiting for the first read…"]);
    expect(v.view(undefined)).toBeUndefined();
  });

  it("invalidate forgets a PR", async () => {
    const { v } = viewerOver(fixture("forget"));
    await v.refresh(7);
    v.invalidate(7);
    expect(text(v.view(7)!.lines)).toEqual(["waiting for the first read…"]);
  });
});

// ---- a recorded session, replayed through the writer --------------------------------

describe("TranscriptViewer — a recorded PR session", () => {
  const done: Replayed[] = [];
  afterEach(() => {
    for (const r of done.splice(0)) r.cleanup();
  });

  it("reads back the round the LiveEvent writer logged from it", async () => {
    const root = mkReplayRoot(5409);
    const session = readFileSync(
      join(import.meta.dirname, "fixtures", "live-events", "pr-session.jsonl"),
      "utf8",
    );
    done.push(replay({ root, pr: 5409, events: eventsFromSession(session, root) }));
    const { v } = viewerOver(root);
    await v.refresh(5409);
    const view = v.view(5409)!;
    const lines = text(view.lines);
    expect(lines.some((l) => l.includes("> Round order for PR 5409."))).toBe(true);
    expect(lines.some((l) => /tool bash/.test(l))).toBe(true);
    expect(lines.some((l) => /agent settled/.test(l))).toBe(true);
    expect(view.viewer).toMatchObject({ round: 1, rounds: 1, stream: "main", live: false });
    expect(view.lines.length).toBeGreaterThan(10);
  });
});

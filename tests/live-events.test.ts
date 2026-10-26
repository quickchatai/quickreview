// LiveEvent v1 (src/live/): the slim log a viewer reads. The writer's schema and
// coalescing, the reader's torn-line and offset behaviour, and that a log
// projects to a round-progress snapshot the supervisor's parser accepts.
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LIVE_MAIN_FILE,
  lensLogName,
  liveRoundDir,
  readLiveEvents,
  resumePoint,
  type LiveEvent,
} from "@quickchatai/pi-quickreview/src/live/events.js";
import { createLiveWriter, slimResult } from "@quickchatai/pi-quickreview/src/live/writer.js";
import { projectRoundProgress } from "@quickchatai/pi-quickreview/src/live/projection.js";
import { parseRoundProgress } from "@quickchatai/pi-quickreview/src/round-progress.js";

const tmp = mkdtempSync(join(tmpdir(), "live-events-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
const roundDir = (): string => join(tmp, `r${n++}`);
const META = { key: "pr-7", round: 1, pr: 7, session: "pr-7" };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(Date.parse("2026-10-01T10:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

const read = (dir: string, file = LIVE_MAIN_FILE): LiveEvent[] =>
  readLiveEvents(join(dir, file)).events;

describe("the writer's lines", () => {
  it("starts with session_start, then numbers every line from 1 with an ISO instant", () => {
    const dir = roundDir();
    const sink = createLiveWriter({ dir }).main(META);
    sink.feed({ type: "agent_start" });
    vi.advanceTimersByTime(10);
    sink.feed({ type: "turn_start" });
    sink.close();
    const events = read(dir);
    expect(events.map((e) => e.type)).toEqual(["session_start", "agent_start", "turn_start"]);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(events[0]).toMatchObject({
      v: 1,
      type: "session_start",
      stream: "main",
      key: "pr-7",
      round: 1,
      pr: 7,
      session: "pr-7",
    });
    expect(events.every((e) => new Date(e.at).toISOString() === e.at)).toBe(true);
    expect(events[2]!.at).toBe("2026-10-01T10:00:00.010Z");
  });

  it("writes the round under state/live/<key>/r<round>/", () => {
    expect(liveRoundDir("/run", "pr-7", 3)).toBe("/run/state/live/pr-7/r3");
  });

  it("keeps a user message's text (the command marker) and not other roles'", () => {
    const dir = roundDir();
    const sink = createLiveWriter({ dir }).main(META);
    sink.feed({
      type: "message_start",
      message: {
        role: "user",
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      },
    });
    sink.feed({ type: "message_start", message: { role: "assistant", content: [] } });
    sink.feed({ type: "message_start", message: { role: "toolResult" } });
    sink.close();
    expect(read(dir).slice(1)).toMatchObject([
      { type: "message_start", role: "user", text: "a\nb" },
      { type: "message_start", role: "assistant" },
    ]);
    expect(read(dir)[2]).not.toHaveProperty("text");
  });

  it("records an assistant message's text, tool calls, stop reason and cost", () => {
    const dir = roundDir();
    const sink = createLiveWriter({ dir }).main(META);
    sink.feed({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "going" },
          { type: "toolCall", id: "c", name: "bash", arguments: { command: "ls" } },
        ],
        stopReason: "toolUse",
        usage: { input: 10, output: 2, cacheRead: 5, cost: { total: 0.25 } },
      },
    });
    sink.feed({ type: "message_end", message: { role: "toolResult", content: [] } });
    sink.close();
    const ends = read(dir).filter((e) => e.type === "message_end");
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({
      role: "assistant",
      text: "going",
      tool_calls: ["bash"],
      stop_reason: "toolUse",
      usage: { input: 10, output: 2, cache_read: 5, cost_usd: 0.25 },
    });
  });

  it("keeps a lens tool's arguments, a plain tool's preview, and the parent call", () => {
    const dir = roundDir();
    const sink = createLiveWriter({ dir }).main(META);
    sink.feed({
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "lens",
      args: { agent: "pass-security", task: "x" },
    });
    sink.feed({
      type: "tool_execution_start",
      toolCallId: "t2",
      toolName: "write",
      parentToolCallId: "t1",
      args: { path: "a.txt", content: "A".repeat(100_000) },
    });
    sink.close();
    const lines = readFileSync(join(dir, LIVE_MAIN_FILE), "utf8");
    expect(lines.length).toBeLessThan(2_000);
    const [, lens, plain] = read(dir);
    expect(lens).toMatchObject({
      type: "tool_start",
      id: "t1",
      tool: "lens",
      args: { agent: "pass-security", task: "x" },
      executions: [{ agent: "pass-security" }],
    });
    expect(plain).toMatchObject({ id: "t2", tool: "write", parent: "t1", preview: "a.txt" });
    expect(plain).not.toHaveProperty("args");
  });

  it("resolves a launch_plan call's tasks through the host's resolver at call start", () => {
    const dir = roundDir();
    const seen: unknown[] = [];
    const sink = createLiveWriter({
      dir,
      env: { QCR_PR: "7" },
      launchExecutions: (args, env) => {
        seen.push([args, env.QCR_PR]);
        return [
          { agent: "pass-a", phase: "plan" },
          { agent: "pass-b", phase: "plan" },
        ];
      },
    }).main(META);
    sink.feed({
      type: "tool_execution_start",
      toolCallId: "lp",
      toolName: "launch_plan",
      args: { dirs: ["/x"] },
    });
    sink.close();
    expect(seen).toEqual([[{ dirs: ["/x"] }, "7"]]);
    expect(read(dir)[1]).toMatchObject({
      executions: [
        { agent: "pass-a", phase: "plan" },
        { agent: "pass-b", phase: "plan" },
      ],
    });
  });

  it("resolves a lens_wave call's task directories through the host's resolver too", () => {
    const dir = roundDir();
    const sink = createLiveWriter({
      dir,
      launchExecutions: () => [{ agent: "pass-a", phase: "sweep" }],
    }).main(META);
    sink.feed({
      type: "tool_execution_start",
      toolCallId: "lw",
      toolName: "lens_wave",
      args: { dirs: ["/x/tasks-sweep"] },
    });
    sink.close();
    expect(read(dir)[1]).toMatchObject({ executions: [{ agent: "pass-a", phase: "sweep" }] });
  });

  it("drops events a viewer has no use for", () => {
    const dir = roundDir();
    const sink = createLiveWriter({ dir }).main(META);
    sink.feed({ type: "entry_appended", entry: {} });
    sink.feed({ type: "bash_execution_update", delta: "x" });
    sink.feed(null);
    sink.feed("nonsense");
    sink.close();
    expect(read(dir).map((e) => e.type)).toEqual(["session_start"]);
  });

  it("writes a lens session to lens-<id>.jsonl and refuses an id that is not a plain token", () => {
    const dir = roundDir();
    const writer = createLiveWriter({ dir });
    const sink = writer.lens("L1", { ...META, agent: "pass-security" });
    sink.feed({ type: "agent_start" });
    sink.close();
    expect(read(dir, lensLogName("L1"))).toMatchObject([
      { type: "session_start", stream: "lens", lens_id: "L1", agent: "pass-security" },
      { type: "agent_start" },
    ]);
    expect(() => writer.lens("../escape", META)).toThrow(/not a lens log id/);
  });

  it("never throws into the session when the log cannot be written", () => {
    const dir = roundDir();
    mkdirSync(join(dir, LIVE_MAIN_FILE), { recursive: true }); // a directory where the file goes
    const warn = vi.fn();
    const sink = createLiveWriter({ dir, warn }).main(META);
    expect(() => {
      sink.feed({ type: "agent_start" });
      sink.feed({ type: "agent_settled", aborted: false });
      sink.close();
    }).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("coalescing", () => {
  it("turns the message_updates of one ~250 ms window into one message_delta", () => {
    const dir = roundDir();
    const sink = createLiveWriter({ dir }).main(META);
    const piece = (delta: string, type = "text_delta") => ({
      type: "message_update",
      assistantMessageEvent: { type, delta },
    });
    for (const d of ["he", "llo", " ", "world"]) {
      sink.feed(piece(d));
      vi.advanceTimersByTime(40);
    }
    sink.feed(piece("hmm", "thinking_delta"));
    expect(read(dir)).toHaveLength(1); // still held
    vi.advanceTimersByTime(250);
    const events = read(dir);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      type: "message_delta",
      text: "hello world",
      thinking: "hmm",
      // the instant of the window's first update
      at: "2026-10-01T10:00:00.000Z",
    });
  });

  it("opens a new window after a flush, and the lines keep their order", () => {
    const dir = roundDir();
    const sink = createLiveWriter({ dir }).main(META);
    const upd = (delta: string) => ({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta },
    });
    sink.feed(upd("a"));
    vi.advanceTimersByTime(300);
    sink.feed(upd("b"));
    vi.advanceTimersByTime(300);
    expect(read(dir).map((e) => (e.type === "message_delta" ? e.text : e.type))).toEqual([
      "session_start",
      "a",
      "b",
    ]);
  });

  it("flushes a held delta before the next ordinary event, never after it", () => {
    const dir = roundDir();
    const sink = createLiveWriter({ dir }).main(META);
    sink.feed({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "x" },
    });
    sink.feed({ type: "turn_end" });
    expect(read(dir).map((e) => e.type)).toEqual(["session_start", "message_delta", "turn_end"]);
    vi.advanceTimersByTime(1000);
    expect(read(dir)).toHaveLength(3); // the timer found nothing left
  });

  it("flushes on close", () => {
    const dir = roundDir();
    const sink = createLiveWriter({ dir }).main(META);
    sink.feed({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "tail" },
    });
    sink.close();
    expect(read(dir)[1]).toMatchObject({ type: "message_delta", text: "tail" });
    sink.feed({ type: "agent_start" });
    expect(read(dir)).toHaveLength(2); // closed: nothing after
  });

  it("keeps the latest tool_execution_update of a call, and only the children that changed", () => {
    const dir = roundDir();
    const sink = createLiveWriter({ dir }).main(META);
    const update = (a: string, b: string) => ({
      type: "tool_execution_update",
      toolCallId: "w",
      toolName: "lens_wave",
      partialResult: {
        details: {
          mode: "parallel",
          results: [
            {
              agent: "pass-a",
              id: "A",
              exitCode: -1,
              progress: { status: "running", toolCount: 1, lastMessage: a },
            },
            {
              agent: "pass-b",
              id: "B",
              exitCode: -1,
              progress: { status: "running", toolCount: 1, lastMessage: b },
            },
          ],
        },
      },
    });
    sink.feed(update("a1", "b1"));
    vi.advanceTimersByTime(50);
    sink.feed(update("a2", "b1"));
    vi.advanceTimersByTime(300);
    sink.feed(update("a2", "b2")); // only B differs from the line before
    vi.advanceTimersByTime(300);
    const updates = read(dir).filter((e) => e.type === "tool_update");
    expect(updates).toHaveLength(2);
    const first = updates[0]!;
    if (first.type !== "tool_update") throw new Error("unreachable");
    expect(first).toMatchObject({ id: "w", mode: "parallel", n: 2 });
    expect(first.results.map((r) => [r.slot, r.progress?.last_message])).toEqual([
      [0, "a2"],
      [1, "b1"],
    ]);
    const second = updates[1]!;
    if (second.type !== "tool_update") throw new Error("unreachable");
    expect(second.n).toBe(2);
    expect(second.results.map((r) => [r.slot, r.progress?.last_message])).toEqual([[1, "b2"]]);
  });

  it("flushes a held update before the call's end, and the end repeats no unchanged child", () => {
    const dir = roundDir();
    const sink = createLiveWriter({ dir }).main(META);
    const result = (code: number) => ({
      details: {
        results: [
          {
            agent: "pass-a",
            exitCode: code,
            progress: { status: code === 0 ? "completed" : "running" },
          },
        ],
      },
    });
    sink.feed({
      type: "tool_execution_update",
      toolCallId: "c",
      toolName: "subagent",
      partialResult: result(-1),
    });
    sink.feed({
      type: "tool_execution_end",
      toolCallId: "c",
      toolName: "subagent",
      result: result(0),
      isError: false,
    });
    const types = read(dir).map((e) => e.type);
    expect(types).toEqual(["session_start", "tool_update", "tool_end"]);
    const end = read(dir)[2]!;
    if (end.type !== "tool_end") throw new Error("unreachable");
    expect(end.n).toBe(1);
    expect(end.results).toHaveLength(1); // it changed: -1 running -> 0 completed
  });
});

describe("slimResult", () => {
  it("keeps what round-progress reads and a bounded form of it", () => {
    const slim = slimResult(
      {
        agent: " pass-a ",
        id: "L9",
        exitCode: 0,
        stopReason: "stop",
        errorMessage: "",
        usage: { cost: 0.5 },
        messages: [
          {
            role: "assistant",
            content: [
              { type: "toolCall", name: "grep" },
              { type: "text", text: " found " },
            ],
          },
          { role: "user", content: [{ type: "text", text: "ignored" }] },
        ],
        progress: {
          status: "running",
          durationMs: 1200,
          toolCount: 3,
          recentTools: [{ tool: "grep", args: "  x  ", status: "running" }, 5],
        },
      },
      2,
    );
    expect(slim).toEqual({
      slot: 2,
      agent: "pass-a",
      id: "L9",
      exit_code: 0,
      stop_reason: "stop",
      error_message: "",
      progress: {
        status: "running",
        duration_ms: 1200,
        tool_count: 3,
        recent_tools: [{ tool: "grep", args: "x", status: "running" }],
      },
      native: { tool_count: 1, last_text: "found", last_tool: "grep" },
      cost_usd: 0.5,
    });
  });
});

describe("the reader", () => {
  const line = (seq: number, type = "agent_start"): string =>
    `${JSON.stringify({ v: 1, seq, at: "2026-10-01T10:00:00.000Z", type })}\n`;

  it("reads a missing file as empty and keeps the offset it was given", () => {
    expect(readLiveEvents(join(tmp, "nope.jsonl"), 12)).toEqual({
      events: [],
      nextOffset: 12,
      skipped: 0,
    });
  });

  it("survives a torn last line: it is left for the next read", () => {
    const file = join(roundDir() + "-torn.jsonl");
    const torn = '{"v":1,"seq":3,"at":"2026-10-01T10:00:0';
    writeFileSync(file, line(1) + line(2) + torn);
    const first = readLiveEvents(file);
    expect(first.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(first.nextOffset).toBe(Buffer.byteLength(line(1) + line(2)));
    expect(first.skipped).toBe(0);
    // the writer finishes the line
    writeFileSync(file, line(1) + line(2) + line(3));
    const next = readLiveEvents(file, first.nextOffset);
    expect(next.events.map((e) => e.seq)).toEqual([3]);
    expect(next.nextOffset).toBe(Buffer.byteLength(line(1) + line(2) + line(3)));
  });

  it("does not consume a last line that parses but has no newline yet", () => {
    const file = join(roundDir() + "-nonl.jsonl");
    writeFileSync(file, line(1) + line(2).trimEnd());
    expect(readLiveEvents(file).events.map((e) => e.seq)).toEqual([1]);
  });

  it("resumes from an offset and reads only what was appended", () => {
    const file = join(roundDir() + "-off.jsonl");
    writeFileSync(file, line(1));
    const a = readLiveEvents(file);
    appendFileSync(file, line(2) + line(3));
    const b = readLiveEvents(file, a.nextOffset);
    expect(b.events.map((e) => e.seq)).toEqual([2, 3]);
    expect(readLiveEvents(file, b.nextOffset).events).toEqual([]);
  });

  it("skips garbage and foreign lines but reads those around them", () => {
    const file = join(roundDir() + "-junk.jsonl");
    writeFileSync(
      file,
      line(1) +
        "not json\n" +
        '{"v":2,"seq":2,"at":"2026-10-01T10:00:00.000Z","type":"x"}\n' +
        '{"v":1,"seq":0,"at":"x","type":"y"}\n' +
        line(2),
    );
    const read = readLiveEvents(file);
    expect(read.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(read.skipped).toBe(3);
  });

  it("reads multibyte text across a byte offset", () => {
    const file = join(roundDir() + "-utf.jsonl");
    const ev = (seq: number, text: string) =>
      `${JSON.stringify({ v: 1, seq, at: "2026-10-01T10:00:00.000Z", type: "message_delta", text })}\n`;
    writeFileSync(file, ev(1, "zażółć gęślą jaźń 🙂"));
    const a = readLiveEvents(file);
    appendFileSync(file, ev(2, "日本語"));
    const b = readLiveEvents(file, a.nextOffset);
    expect(b.events).toMatchObject([{ seq: 2, text: "日本語" }]);
  });
});

describe("a writer that finds a log already there", () => {
  it("continues the numbering after the last good line", () => {
    const dir = roundDir();
    const first = createLiveWriter({ dir }).main(META);
    first.feed({ type: "agent_start" });
    first.close();
    const again = createLiveWriter({ dir }).main(META);
    again.feed({ type: "agent_settled", aborted: false });
    again.close();
    expect(read(dir).map((e) => [e.seq, e.type])).toEqual([
      [1, "session_start"],
      [2, "agent_start"],
      [3, "session_start"],
      [4, "agent_settled"],
    ]);
  });

  it("closes off a torn last line before writing, and the reader skips only that line", () => {
    const dir = roundDir();
    mkdirSync(dir, { recursive: true });
    const file = join(dir, LIVE_MAIN_FILE);
    writeFileSync(
      file,
      `${JSON.stringify({ v: 1, seq: 1, at: "2026-10-01T10:00:00.000Z", type: "agent_start" })}\n{"v":1,"seq":2,"at":"2026-10`,
    );
    expect(resumePoint(file)).toEqual({ lastSeq: 1, torn: true });
    const sink = createLiveWriter({ dir }).main(META);
    sink.feed({ type: "turn_start" });
    sink.close();
    const result = readLiveEvents(file);
    expect(result.events.map((e) => [e.seq, e.type])).toEqual([
      [1, "agent_start"],
      [2, "session_start"],
      [3, "turn_start"],
    ]);
    expect(result.skipped).toBe(1);
  });
});

describe("projecting a log", () => {
  it("projects a round to a snapshot the supervisor's parser accepts", () => {
    const dir = roundDir();
    const sink = createLiveWriter({ dir, env: {} }).main(META);
    const sha = "a".repeat(64);
    sink.feed({ type: "agent_start" });
    sink.feed({
      type: "message_start",
      message: {
        role: "user",
        content: [{ type: "text", text: `order <!-- qcr-command:cmd-7:${sha} -->` }],
      },
    });
    sink.feed({
      type: "tool_execution_start",
      toolCallId: "t",
      toolName: "lens",
      args: { agent: "pass-security", task: "x" },
    });
    vi.advanceTimersByTime(1000);
    sink.feed({
      type: "tool_execution_end",
      toolCallId: "t",
      toolName: "lens",
      result: {
        details: {
          results: [
            {
              agent: "pass-security",
              id: "L1",
              exitCode: 0,
              progress: { status: "completed", durationMs: 1000, toolCount: 2 },
            },
          ],
        },
      },
      isError: false,
    });
    sink.feed({ type: "agent_settled", aborted: false });
    sink.close();

    const projection = projectRoundProgress(read(dir))!;
    const parsed = parseRoundProgress(projection.snapshotJson!);
    expect(parsed).toMatchObject({
      version: 2,
      pr: 7,
      session: "pr-7",
      parent_status: "settled",
      command_id: "cmd-7",
      agents: [{ agent: "pass-security", status: "completed", tool_count: 2 }],
    });
    expect(projection.transitions.map((t) => t.event)).toEqual([
      "parent_start",
      "command_accepted",
      "pass_start",
      "pass_end",
      "parent_settle",
    ]);
  });

  it("projects nothing for a log with no identity, a lens log, or a round without a PR", () => {
    expect(projectRoundProgress([])).toBeUndefined();
    const dir = roundDir();
    const writer = createLiveWriter({ dir });
    writer.lens("L1", META).close();
    expect(projectRoundProgress(read(dir, lensLogName("L1")))).toBeUndefined();
    const none = createLiveWriter({ dir: roundDir() }).main({ ...META, pr: null });
    none.close();
    expect(projectRoundProgress(readLiveEvents(none.path).events)).toBeUndefined();
  });
});

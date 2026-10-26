// A lens pass's live activity (packages/pi-plugin/src/engine/lens/activity.ts):
// the tracker the runner feeds its session's events, the progress record the
// lens tools lay on a slot; and the one-line formatter over a projected entry
// (packages/pi-plugin/src/live/lensline.ts) the plugin's status line and the
// app's home print. Pure: no session, no file.
import { describe, expect, it } from "vitest";
import {
  LensActivityTracker,
  lensProgressRecord,
  toolTarget,
} from "@quickchatai/pi-quickreview/src/engine/lens/activity.js";
import {
  clockOf,
  lensActivityLine,
  lensShortName,
  runningLensLines,
} from "@quickchatai/pi-quickreview/src/live/lensline.js";
import type { LiveAgentProgress } from "@quickchatai/pi-quickreview/src/round-progress.js";

const start = (id: string, toolName: string, args: Record<string, unknown>) => ({
  type: "tool_execution_start",
  toolCallId: id,
  toolName,
  args,
});
const end = (id: string, toolName: string) => ({
  type: "tool_execution_end",
  toolCallId: id,
  toolName,
  result: {},
  isError: false,
});

describe("LensActivityTracker", () => {
  it("counts tool starts, names the running tool and its path, and keeps the last one once it ends", () => {
    let now = 1_000;
    const t = new LensActivityTracker(1_000, () => now, "/work/tree");
    expect(t.view()).toEqual({ durationMs: 0, toolCount: 0, toolRunning: false });

    now = 3_000;
    expect(t.feed(start("1", "read", { path: "/work/tree/src/x.ts" }))).toBe(true);
    expect(t.view()).toEqual({
      durationMs: 2_000,
      toolCount: 1,
      tool: "read",
      args: "/work/tree/src/x.ts",
      target: "src/x.ts",
      toolRunning: true,
    });
    expect(t.feed(end("1", "read"))).toBe(true);
    expect(t.view()).toMatchObject({ toolCount: 1, tool: "read", toolRunning: false });

    // a tool with no path names none
    t.feed(start("2", "bash", { command: "git diff --stat" }));
    expect(t.view()).toMatchObject({ toolCount: 2, tool: "bash", args: "git diff --stat" });
    expect(t.view()).not.toHaveProperty("target");

    // events that are not tool calls change nothing; an end it never saw neither
    expect(t.feed({ type: "message_update" })).toBe(false);
    expect(t.feed(end("9", "grep"))).toBe(false);

    // an attempt that ended leaves no call open
    t.settle();
    expect(t.view()).toMatchObject({ toolCount: 2, toolRunning: false });
  });

  it("keeps a path outside the pass's cwd as given, and a relative one as it is", () => {
    expect(toolTarget({ path: "/elsewhere/a.ts" }, "/work/tree")).toBe("/elsewhere/a.ts");
    expect(toolTarget({ path: "src" }, "/work/tree")).toBe("src");
    expect(toolTarget({ path: "/work/tree" }, "/work/tree")).toBe(".");
    expect(toolTarget({ pattern: "TODO" }, "/work/tree")).toBeUndefined();
  });
});

describe("lensProgressRecord", () => {
  const a = {
    durationMs: 41_000,
    toolCount: 7,
    tool: "grep",
    args: "TODO",
    target: "src",
    toolRunning: true,
  };

  it("is the native progress shape while the pass runs: count, time, the current tool and its path", () => {
    expect(lensProgressRecord(a, "running")).toEqual({
      status: "running",
      durationMs: 41_000,
      toolCount: 7,
      currentTarget: "src",
      recentTools: [{ tool: "grep", args: "TODO", status: "running" }],
    });
  });

  it("carries only the totals once the pass has ended, either way", () => {
    expect(lensProgressRecord(a, "completed")).toEqual({
      status: "completed",
      durationMs: 41_000,
      toolCount: 7,
    });
    expect(lensProgressRecord(a, "failed")).toMatchObject({ status: "failed", toolCount: 7 });
  });
});

describe("lensActivityLine", () => {
  const entry = (over: Partial<LiveAgentProgress>): LiveAgentProgress => ({
    execution_id: "c1:pass-security--sol-high",
    agent: "pass-security--sol-high",
    status: "running",
    duration_ms: 0,
    tool_count: 0,
    started_at: "2026-10-26T12:00:00.000Z",
    ...over,
  });

  it("names a running lens, its tool and file, its count and its time", () => {
    expect(
      lensActivityLine(
        entry({
          duration_ms: 41_000,
          tool_count: 7,
          current_tool: "read: src/x.ts",
          current_target: "src/x.ts",
        }),
      ),
    ).toBe("security · read src/x.ts · 7 tools · 0:41");
  });

  it("keeps a running lens's time counting from its start between updates", () => {
    const now = Date.parse("2026-10-26T12:01:05.000Z");
    expect(
      lensActivityLine(entry({ duration_ms: 41_000, tool_count: 1, current_tool: "bash: ls" }), {
        nowMs: now,
      }),
    ).toBe("security · bash · 1 tool · 1:05");
  });

  it("says starting before the first tool, and leaves out a time nobody measured", () => {
    expect(lensActivityLine(entry({}))).toBe("security · starting");
  });

  it("reads a finished lens as done with its final count, a failed one as failed", () => {
    const finished = { finished_at: "2026-10-26T12:02:00.000Z" };
    expect(
      lensActivityLine(
        entry({ ...finished, status: "completed", tool_count: 12, duration_ms: 80_000 }),
      ),
    ).toBe("security · done · 12 tools · 1:20");
    expect(
      lensActivityLine(
        entry({ ...finished, status: "failed", tool_count: 3, duration_ms: 15_000 }),
      ),
    ).toBe("security · failed · 3 tools · 0:15");
  });

  it("keeps the end of a long path", () => {
    const line = lensActivityLine(
      entry({
        tool_count: 1,
        current_tool: "read: x",
        current_target: `deep/${"a".repeat(80)}.ts`,
      }),
      { maxPath: 20 },
    );
    expect(line).toBe(`security · read …${"a".repeat(16)}.ts · 1 tool`);
  });

  it("lists the running lenses only", () => {
    expect(
      runningLensLines([
        entry({ tool_count: 2, current_tool: "grep: x", current_target: "src" }),
        entry({ agent: "pass-tests", status: "completed", tool_count: 4, finished_at: "x" }),
      ]),
    ).toEqual(["security · grep src · 2 tools"]);
  });

  it("short names and clocks", () => {
    expect(lensShortName("pass-data-safety--sol-high")).toBe("data-safety");
    expect(lensShortName("pass-validate")).toBe("validate");
    expect(lensShortName("reviewer")).toBe("reviewer");
    expect(clockOf(59_999)).toBe("0:59");
    expect(clockOf(3_725_000)).toBe("1:02:05");
  });
});

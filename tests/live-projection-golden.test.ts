// Golden: the LiveEvent projection reproduces round-progress v2 byte for byte.
//
// extensions/round-progress.ts is the reference publisher (the tmux pi). The
// same pi events go to it and to the LiveEvent writer; the writer's log is read
// back from disk and projected (src/live/projection.ts). The snapshot file and
// the transition log must be identical bytes.
//
// The committed session (fixtures/live-events/pr-session.jsonl) is a recorded-
// shape PR session - the layout `qcr archive extract` restores, with synthetic
// content. Set QCR_GOLDEN_SESSION=<path to an extracted real session JSONL> to
// hold the same line against a real archived PR; the test is skipped otherwise.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseRoundProgress, roundExecutionStage } from "../src/round-progress.js";
import {
  eventsFromSession,
  mkReplayRoot,
  replay,
  type Replayed,
  type TimedEvent,
} from "./helpers/live-replay.js";

const PR = 5409;
const SESSION = readFileSync(
  join(import.meta.dirname, "fixtures", "live-events", "pr-session.jsonl"),
  "utf8",
);

const done: Replayed[] = [];
afterEach(() => {
  for (const r of done.splice(0)) r.cleanup();
});

function run(events: (root: string) => TimedEvent[]): Replayed {
  const root = mkReplayRoot(PR);
  const r = replay({ root, pr: PR, events: events(root) });
  done.push(r);
  return r;
}

describe("a recorded PR session replays to the extension's round-progress v2", () => {
  it("is byte-equal: snapshot and transition log", () => {
    const r = run((root) => eventsFromSession(SESSION, root));
    expect(r.projection?.snapshotJson).toBe(r.extensionSnapshot);
    expect(r.projection?.transitionsJsonl).toBe(r.extensionTransitions);
  });

  it("is a snapshot the supervisor's parser accepts, with the round's identity and passes", () => {
    const r = run((root) => eventsFromSession(SESSION, root));
    const snapshot = parseRoundProgress(r.projection!.snapshotJson!)!;
    expect(snapshot).toMatchObject({
      version: 2,
      pr: PR,
      session: `pr-${PR}`,
      parent_status: "settled",
      command_id: "cmd-5409-2",
      round_no: 2,
      head_sha: "abc1234",
    });
    // launch_plan's three passes, the sweep's three tasks (one agent twice),
    // the added lens, lens_wave's two runs and a refused call: ten rows, none lost or doubled.
    expect(snapshot.agents.map((a) => a.agent)).toEqual([
      "pass-baseline--sol-high",
      "pass-security--sol-high",
      "pass-data-safety--sol-high",
      "pass-security--sol-high",
      "pass-security--sol-high",
      "pass-validate--sol-high",
      "pass-tests--sol-high",
      "pass-baseline--sol-high",
      "pass-api--sol-high",
      "pass-style--sol-high",
    ]);
    expect(snapshot.agents.find((a) => a.agent === "pass-data-safety--sol-high")).toMatchObject({
      status: "failed",
      error: "provider overloaded",
    });
    expect(snapshot.agents.find((a) => a.agent === "pass-style--sol-high")?.status).toBe("failed");
    expect(
      roundExecutionStage(snapshot, [
        "pass-baseline",
        "pass-security",
        "pass-data-safety",
        "pass-validate",
      ]),
    ).toBe("finalized");
  });

  it.runIf(process.env.QCR_GOLDEN_SESSION !== undefined)(
    "holds for the real archived session in QCR_GOLDEN_SESSION",
    () => {
      const real = readFileSync(process.env.QCR_GOLDEN_SESSION!, "utf8");
      const r = run((root) => eventsFromSession(real, root));
      expect(r.projection?.snapshotJson).toBe(r.extensionSnapshot);
      expect(r.projection?.transitionsJsonl).toBe(r.extensionTransitions);
    },
  );
});

describe("a live stream with updates", () => {
  // Updates more than one coalescing window apart, so every held line carries
  // the instant of the update it stands for and the two stay byte-equal.
  const ms = Date.parse("2026-10-01T10:00:00.000Z");
  const at = (s: number): number => ms + s * 1000;
  const sha = "d".repeat(64);
  const text = (delta: string) => ({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta },
  });
  const wave = (a: Record<string, unknown>, b: Record<string, unknown>) => ({
    details: {
      mode: "parallel",
      results: [
        { agent: "pass-baseline--sol-high", ...a },
        { agent: "pass-security--sol-high", ...b },
      ],
    },
  });
  const events = (): TimedEvent[] => [
    { at: at(0), event: { type: "agent_start" } },
    {
      at: at(0.1),
      event: {
        type: "message_start",
        message: {
          role: "user",
          content: [{ type: "text", text: `go <!-- qcr-command:cmd-9:${sha} -->` }],
        },
      },
    },
    { at: at(1), event: { type: "turn_start" } },
    { at: at(2), event: text("thinking out loud") },
    {
      at: at(3),
      event: {
        type: "tool_execution_start",
        toolCallId: "sa",
        toolName: "subagent",
        args: {
          tasks: [
            { agent: "pass-baseline--sol-high", task: "t" },
            { agent: "pass-security--sol-high", task: "t" },
          ],
        },
      },
    },
    {
      at: at(4),
      event: {
        type: "tool_execution_update",
        toolCallId: "sa",
        toolName: "subagent",
        partialResult: wave(
          {
            exitCode: -1,
            progress: {
              status: "running",
              durationMs: 900,
              toolCount: 1,
              lastMessage: "reading",
              recentTools: [{ tool: "read", args: "a.ts", status: "running" }],
            },
          },
          { exitCode: -1, progress: { status: "running", durationMs: 800, toolCount: 0 } },
        ),
      },
    },
    { at: at(5), event: text("more") },
    {
      at: at(6),
      event: {
        type: "tool_execution_update",
        toolCallId: "sa",
        toolName: "subagent",
        partialResult: wave(
          {
            exitCode: 0,
            progress: {
              status: "completed",
              durationMs: 5000,
              toolCount: 4,
              lastMessage: "all clear",
            },
          },
          {
            exitCode: -1,
            progress: {
              status: "running",
              durationMs: 5000,
              toolCount: 2,
              recentTools: [{ tool: "grep", status: "running" }],
            },
          },
        ),
      },
    },
    // a bash tool streaming output: a heartbeat for the extension
    {
      at: at(7),
      event: {
        type: "tool_execution_start",
        toolCallId: "b",
        toolName: "bash",
        args: { command: "sleep 3" },
      },
    },
    {
      at: at(8.5),
      event: {
        type: "tool_execution_update",
        toolCallId: "b",
        toolName: "bash",
        partialResult: { content: [] },
      },
    },
    {
      at: at(10),
      event: {
        type: "tool_execution_end",
        toolCallId: "b",
        toolName: "bash",
        result: {},
        isError: false,
      },
    },
    {
      at: at(12),
      event: {
        type: "tool_execution_end",
        toolCallId: "sa",
        toolName: "subagent",
        result: wave(
          {
            exitCode: 0,
            progress: {
              status: "completed",
              durationMs: 5000,
              toolCount: 4,
              lastMessage: "all clear",
            },
          },
          {
            exitCode: 1,
            stopReason: "error",
            errorMessage: "overloaded",
            progress: { durationMs: 9000, toolCount: 2 },
          },
        ),
        isError: false,
      },
    },
    { at: at(14), event: { type: "agent_settled", aborted: false } },
  ];

  it("is byte-equal: snapshot and transition log", () => {
    const r = run(() => events());
    expect(r.projection?.snapshotJson).toBe(r.extensionSnapshot);
    expect(r.projection?.transitionsJsonl).toBe(r.extensionTransitions);
    expect(parseRoundProgress(r.projection!.snapshotJson!)?.agents.map((a) => a.status)).toEqual([
      "completed",
      "failed",
    ]);
  });

  it("holds the same line for a lens_wave that names its children only in its results", () => {
    const run2 = (): TimedEvent[] => [
      { at: at(0), event: { type: "agent_start" } },
      {
        at: at(0.1),
        event: {
          type: "message_start",
          message: {
            role: "user",
            content: [{ type: "text", text: `<!-- qcr-command:cmd-9:${sha} -->` }],
          },
        },
      },
      {
        at: at(2),
        event: { type: "tool_execution_start", toolCallId: "w", toolName: "lens_wave", args: {} },
      },
      {
        at: at(4),
        event: {
          type: "tool_execution_update",
          toolCallId: "w",
          toolName: "lens_wave",
          partialResult: wave(
            { id: "A", exitCode: -1, progress: { status: "running" } },
            { id: "B", exitCode: 0, progress: { status: "completed" } },
          ),
        },
      },
      {
        at: at(8),
        event: {
          type: "tool_execution_end",
          toolCallId: "w",
          toolName: "lens_wave",
          result: wave({ id: "A", exitCode: 0 }, { id: "B", exitCode: 0 }),
          isError: false,
        },
      },
      { at: at(9), event: { type: "agent_settled", aborted: false } },
    ];
    const r = run(() => run2());
    expect(r.projection?.snapshotJson).toBe(r.extensionSnapshot);
    expect(r.projection?.transitionsJsonl).toBe(r.extensionTransitions);
  });
});

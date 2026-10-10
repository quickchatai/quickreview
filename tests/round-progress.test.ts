import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import activate from "../extensions/round-progress.js";
import { parseRoundProgress, roundExecutionStage } from "../src/round-progress.js";
import type { PiEventHandler } from "@earendil-works/pi-coding-agent";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("round progress extension", () => {
  it("publishes parent and lens lifecycle as one atomic per-PR snapshot", async () => {
    const root = mkdtempSync(join(tmpdir(), "qcr-progress-"));
    dirs.push(root);
    const previous = { ...process.env };
    process.env.QCR_SANDBOX_ROOT = root;
    process.env.QCR_SESSION_NAME = "pr-5408";
    process.env.QCR_PR = "5408";
    const handlers = new Map<string, PiEventHandler[]>();
    const pi = {
      on(name: string, handler: PiEventHandler) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
    };
    const emit = async (name: string, event: Record<string, unknown> = {}) => {
      for (const handler of handlers.get(name) ?? []) await handler(event);
    };

    try {
      activate(pi as never);
      await emit("agent_start");
      await emit("message_start", {
        message: {
          role: "user",
          content: [
            { type: "text", text: `round order\n<!-- qcr-command:cmd-5408:${"a".repeat(64)} -->` },
          ],
        },
      });
      await emit("tool_execution_start", {
        toolName: "subagent",
        toolCallId: "lens-1",
        args: { agent: "pass-security", task: "check auth" },
      });
      await emit("tool_execution_update", {
        toolName: "subagent",
        toolCallId: "lens-1",
        partialResult: {
          details: {
            results: [
              {
                agent: "pass-security",
                progress: {
                  status: "running",
                  durationMs: 12_000,
                  toolCount: 3,
                  lastMessage: "Tracing the bearer into the logger",
                  recentTools: [{ tool: "grep", args: "bearer", status: "running" }],
                },
              },
            ],
          },
        },
      });

      const path = join(root, "state", "round-progress", "pr-5408.json");
      const running = JSON.parse(readFileSync(path, "utf8"));
      expect(running).toMatchObject({
        version: 2,
        pr: 5408,
        session: "pr-5408",
        parent_status: "active",
        command_id: "cmd-5408",
        command_sha256: "a".repeat(64),
        command_accepted_at: expect.any(String),
        preparing_at: expect.any(String),
        first_lens_started_at: expect.any(String),
        fanout_started_at: expect.any(String),
        active_tool: "subagent: pass-security",
      });
      expect(running.preparing_at).toBe(running.command_accepted_at);
      expect(running.fanout_started_at).toBe(running.first_lens_started_at);
      expect(
        roundExecutionStage(parseRoundProgress(JSON.stringify(running))!, [
          "pass-security",
          "pass-validate",
        ]),
      ).toBe("fanout-started");
      expect(running.agents).toEqual([
        expect.objectContaining({
          agent: "pass-security",
          status: "running",
          duration_ms: 12_000,
          tool_count: 3,
          started_at: running.first_lens_started_at,
          current_tool: "grep: bearer",
          last_message: "Tracing the bearer into the logger",
        }),
      ]);
      expect(running.agents[0].finished_at).toBeUndefined();

      await emit("tool_execution_end", {
        toolName: "subagent",
        toolCallId: "lens-1",
        result: {
          details: {
            results: [
              {
                agent: "pass-security",
                exitCode: 0,
                progress: { status: "completed", durationMs: 15_000, toolCount: 4 },
              },
            ],
          },
        },
      });
      await emit("agent_settled");
      const done = JSON.parse(readFileSync(path, "utf8"));
      expect(done.parent_status).toBe("settled");
      expect(
        roundExecutionStage(parseRoundProgress(JSON.stringify(done))!, ["pass-security"]),
      ).toBe("finalized");
      expect(done.agents[0]).toMatchObject({
        agent: "pass-security",
        status: "completed",
        duration_ms: 15_000,
        tool_count: 4,
        started_at: running.first_lens_started_at,
        finished_at: expect.any(String),
      });
      expect(done.last_activity).toContain("session settled");
    } finally {
      process.env = previous;
    }
  });

  // The round templates carry the round number as an env prefix on the
  // posting call (`export` is refused by the exec policy); an order from an
  // older template still carries the `export` line. Both are read.
  it.each([
    [
      "the env-prefix posting call",
      "QCR_EXPECTED_HEAD=head-native QCR_ROUND_NO=10 scripts/approve-pr.sh 5467 state/a.md state/b.json",
    ],
    ["the legacy export line", "export QCR_ROUND_NO=10"],
  ])(
    "records native tasks[] parallel fanout at tool start, before any progress update (%s)",
    async (_label, roundLine) => {
      const root = mkdtempSync(join(tmpdir(), "qcr-progress-"));
      dirs.push(root);
      const previous = { ...process.env };
      process.env.QCR_SANDBOX_ROOT = root;
      process.env.QCR_SESSION_NAME = "pr-5467";
      process.env.QCR_PR = "5467";
      const handlers = new Map<string, PiEventHandler[]>();
      const pi = {
        on(name: string, handler: PiEventHandler) {
          handlers.set(name, [...(handlers.get(name) ?? []), handler]);
        },
      };
      const emit = async (name: string, event: Record<string, unknown> = {}) => {
        for (const handler of handlers.get(name) ?? []) await handler(event);
      };
      try {
        activate(pi as never);
        await emit("agent_start");
        await emit("message_start", {
          message: {
            role: "user",
            content: [
              {
                type: "text",
                text: [
                  `<!-- qcr-command:cmd-native:${"b".repeat(64)} -->`,
                  "**Worktree**: `/worktree` @ `head-native`",
                  roundLine,
                ].join("\n"),
              },
            ],
          },
        });
        await emit("tool_execution_start", {
          toolName: "subagent",
          toolCallId: "parallel-1",
          args: {
            tasks: [
              { agent: "pass-baseline--sol-med", task: "baseline" },
              { agent: "pass-security--sol-high", task: "security" },
            ],
          },
        });

        const snapshot = parseRoundProgress(
          readFileSync(join(root, "state", "round-progress", "pr-5467.json"), "utf8"),
        )!;
        expect(snapshot).toMatchObject({ round_no: 10, head_sha: "head-native" });
        expect(snapshot.fanout_started_at).toBe(snapshot.first_lens_started_at);
        expect(snapshot.agents).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              execution_id: "parallel-1:pass-baseline--sol-med",
              status: "running",
            }),
            expect.objectContaining({
              execution_id: "parallel-1:pass-security--sol-high",
              status: "running",
            }),
          ]),
        );
        expect(
          roundExecutionStage(snapshot, ["pass-baseline", "pass-security", "pass-validate"]),
        ).toBe("fanout-started");
      } finally {
        process.env = previous;
      }
    },
  );

  it("keeps execution milestones immutable across progress updates", async () => {
    const root = mkdtempSync(join(tmpdir(), "qcr-progress-"));
    dirs.push(root);
    const previous = { ...process.env };
    process.env.QCR_SANDBOX_ROOT = root;
    process.env.QCR_SESSION_NAME = "pr-5408";
    process.env.QCR_PR = "5408";
    const handlers = new Map<string, PiEventHandler[]>();
    const pi = {
      on(name: string, handler: PiEventHandler) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
    };
    const emit = async (name: string, event: Record<string, unknown> = {}) => {
      for (const handler of handlers.get(name) ?? []) await handler(event);
    };
    try {
      activate(pi as never);
      await emit("agent_start");
      await emit("message_start", {
        message: {
          role: "user",
          content: [{ type: "text", text: `<!-- qcr-command:cmd-5408:${"a".repeat(64)} -->` }],
        },
      });
      await emit("tool_execution_start", {
        toolName: "subagent",
        toolCallId: "lens-1",
        args: { agent: "pass-security" },
      });
      const path = join(root, "state", "round-progress", "pr-5408.json");
      const first = JSON.parse(readFileSync(path, "utf8"));
      await emit("tool_execution_update", {
        toolName: "subagent",
        toolCallId: "lens-1",
        partialResult: {
          details: {
            results: [{ agent: "pass-security", progress: { status: "running", durationMs: 10 } }],
          },
        },
      });
      await emit("message_update");
      const later = JSON.parse(readFileSync(path, "utf8"));
      expect(later.command_accepted_at).toBe(first.command_accepted_at);
      expect(later.preparing_at).toBe(first.preparing_at);
      expect(later.first_lens_started_at).toBe(first.first_lens_started_at);
      expect(later.fanout_started_at).toBe(first.fanout_started_at);
      expect(later.agents[0].started_at).toBe(first.agents[0].started_at);

      await emit("tool_execution_end", {
        toolName: "subagent",
        toolCallId: "lens-1",
        result: { details: { results: [{ agent: "pass-security", exitCode: 0 }] } },
      });
      await emit("tool_execution_start", {
        toolName: "subagent",
        toolCallId: "lens-2",
        args: { agent: "pass-security" },
      });
      const repeated = JSON.parse(readFileSync(path, "utf8"));
      expect(repeated.agents).toHaveLength(2);
      expect(repeated.agents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            execution_id: "lens-1:pass-security",
            agent: "pass-security",
            status: "completed",
            finished_at: expect.any(String),
          }),
          expect.objectContaining({
            execution_id: "lens-2:pass-security",
            agent: "pass-security",
            status: "running",
            started_at: expect.any(String),
          }),
        ]),
      );
      expect(
        repeated.agents.find(
          (agent: { execution_id: string }) => agent.execution_id === "lens-2:pass-security",
        ).finished_at,
      ).toBeUndefined();
    } finally {
      process.env = previous;
    }
  });

  it("rejects malformed milestone ordering while retaining legacy display snapshots", () => {
    const legacy = {
      version: 1,
      pr: 5408,
      session: "pr-5408",
      run_started_at: "2026-08-28T09:00:00Z",
      updated_at: "2026-08-28T09:01:00Z",
      parent_status: "active" as const,
      last_activity_at: "2026-08-28T09:01:00Z",
      last_activity: "working",
      agents: [],
    };
    expect(parseRoundProgress(JSON.stringify(legacy))?.version).toBe(1);
    expect(
      roundExecutionStage(
        {
          ...legacy,
          version: 2,
          command_id: "cmd-1",
          command_sha256: "a".repeat(64),
          command_accepted_at: "2026-08-28T09:00:10Z",
          preparing_at: "2026-08-28T09:00:10Z",
          last_activity: "compact context read",
        },
        ["pass-baseline"],
      ),
    ).toBe("preparing");
    expect(
      parseRoundProgress(
        JSON.stringify({
          ...legacy,
          version: 2,
          command_id: "cmd-1",
          command_sha256: "a".repeat(64),
          command_accepted_at: "2026-08-28T09:00:10Z",
          preparing_at: "2026-08-28T09:00:10Z",
          first_lens_started_at: "2026-08-28T09:00:05Z",
          fanout_started_at: "2026-08-28T09:00:05Z",
        }),
      ),
    ).toBeUndefined();
  });

  it("does nothing outside a numbered PR session", () => {
    const root = mkdtempSync(join(tmpdir(), "qcr-progress-"));
    dirs.push(root);
    const previous = { ...process.env };
    process.env.QCR_SANDBOX_ROOT = root;
    process.env.QCR_SESSION_NAME = "overseer";
    delete process.env.QCR_PR;
    try {
      activate({ on() {} } as never);
      expect(() => readFileSync(join(root, "state", "round-progress", "pr-0.json"))).toThrow();
    } finally {
      process.env = previous;
    }
  });
});

// A `launch_plan` call names task directories, not agents. The
// pre-fanout stall clock must still see the fan-out begin at tool START, from
// the same plan the tool computes; a refused plan starts nothing.
describe("round progress — launch_plan", () => {
  it("records the planned agents and the fan-out start at tool start", async () => {
    const root = mkdtempSync(join(tmpdir(), "qcr-progress-lp-"));
    dirs.push(root);
    const tasks = join(root, "state", "pr-5409-round-1-passes", "tasks");
    mkdirSync(tasks, { recursive: true });
    writeFileSync(join(tasks, "01-pass-baseline--sol-high.md"), "t");
    writeFileSync(join(tasks, "02-pass-security--sol-high.md"), "t");
    const previous = { ...process.env };
    process.env.QCR_SANDBOX_ROOT = root;
    process.env.QCR_SESSION_NAME = "pr-5409";
    process.env.QCR_PR = "5409";
    const handlers = new Map<string, PiEventHandler[]>();
    const pi = {
      on(name: string, handler: PiEventHandler) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
    };
    const emit = async (name: string, event: Record<string, unknown> = {}) => {
      for (const handler of handlers.get(name) ?? []) await handler(event);
    };
    try {
      activate(pi as never);
      await emit("agent_start");
      await emit("message_start", {
        message: {
          role: "user",
          content: [
            { type: "text", text: `round order\n<!-- qcr-command:cmd-5409:${"b".repeat(64)} -->` },
          ],
        },
      });
      const path = join(root, "state", "round-progress", "pr-5409.json");
      await emit("tool_execution_start", {
        toolName: "launch_plan",
        toolCallId: "refused",
        args: { dirs: [join(root, "elsewhere")] },
      });
      await emit("tool_execution_end", {
        toolName: "launch_plan",
        toolCallId: "refused",
        isError: true,
      });
      expect(JSON.parse(readFileSync(path, "utf8")).fanout_started_at).toBeUndefined();

      await emit("tool_execution_start", {
        toolName: "launch_plan",
        toolCallId: "plan-1",
        args: { dirs: [tasks] },
      });
      const running = JSON.parse(readFileSync(path, "utf8"));
      expect(running.fanout_started_at).toEqual(expect.any(String));
      expect(running.agents.map((a: { agent: string }) => a.agent)).toEqual([
        "pass-baseline--sol-high",
        "pass-security--sol-high",
      ]);
      expect(
        roundExecutionStage(parseRoundProgress(JSON.stringify(running))!, [
          "pass-baseline",
          "pass-security",
          "pass-validate",
        ]),
      ).toBe("fanout-started");
    } finally {
      process.env = previous;
    }
  });
});

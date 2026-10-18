import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import activate from "../extensions/round-progress.js";
import { WIDE_FANOUT_ENV, WeightedSemaphore, wrapExecute } from "../extensions/subagents.js";
import {
  appendProgressLog,
  parseRoundProgress,
  progressLogPath,
  roundExecutionStage,
} from "../src/round-progress.js";
import { PASS_TIER_ORDER } from "../src/types.js";
/** A handler as the fake pi records it. */
type PiEventHandler = (event: Record<string, unknown>) => unknown;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the posting boundary tier vocabulary", () => {
  // MUTATION: replace sol-high by sol-low in the Python suffix — this fails.
  it("keeps the Python suffix mirror equal to the authoritative tier registry", () => {
    const source = readFileSync(
      join(import.meta.dirname, "..", "scripts", "required-passes.py"),
      "utf8",
    );
    const suffix = source.match(/TIER_SUFFIX = re\.compile\(r"--\(\?:([^)]*)\)\$"\)/)?.[1];
    expect(suffix?.split("|")).toEqual([...PASS_TIER_ORDER]);
  });
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
        args: {
          agent: "pass-security",
          task: `Task file: ${root}/state/pr-5408-round-1-passes/tasks-sweep/01-pass-security.md. Read it first; it is your complete task.`,
        },
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
      expect(running.agents[0].phase).toBe("sweep");
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

  it("an inner agent_start (retry or continuation) keeps the run's command, milestones and passes", async () => {
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
    const command = (id: string) => ({
      message: {
        role: "user",
        content: [{ type: "text", text: `<!-- qcr-command:${id}:${"a".repeat(64)} -->` }],
      },
    });
    try {
      activate(pi as never);
      const path = join(root, "state", "round-progress", "pr-5408.json");
      await emit("agent_start");
      await emit("message_start", command("cmd-1"));
      await emit("tool_execution_start", {
        toolName: "subagent",
        toolCallId: "lens-1",
        args: { agent: "pass-security" },
      });
      const before = JSON.parse(readFileSync(path, "utf8"));
      await new Promise((r) => setTimeout(r, 5));

      // pi's automatic retry: another agent_start, no settle in between.
      await emit("agent_start");
      const inner = JSON.parse(readFileSync(path, "utf8"));
      expect(inner.run_started_at).toBe(before.run_started_at);
      expect(inner.command_id).toBe("cmd-1");
      expect(inner.command_accepted_at).toBe(before.command_accepted_at);
      expect(inner.first_lens_started_at).toBe(before.first_lens_started_at);
      expect(inner.agents).toEqual(before.agents);
      expect(inner.parent_status).toBe("active");

      // A different command delivered into the same run starts afresh.
      await emit("message_start", command("cmd-2"));
      const next = JSON.parse(readFileSync(path, "utf8"));
      expect(next.command_id).toBe("cmd-2");
      expect(next.agents).toEqual([]);
      expect(next.first_lens_started_at).toBeUndefined();

      // After the run settles, the next agent_start is a new run.
      await emit("agent_settled");
      await new Promise((r) => setTimeout(r, 5));
      await emit("agent_start");
      const fresh = JSON.parse(readFileSync(path, "utf8"));
      expect(fresh.command_id).toBeUndefined();
      expect(fresh.parent_status).toBe("active");
      expect(fresh.run_started_at > next.run_started_at).toBe(true);
    } finally {
      process.env = previous;
    }
  });

  it("keeps every task slot of one agent within a single call apart", async () => {
    const root = mkdtempSync(join(tmpdir(), "qcr-progress-"));
    dirs.push(root);
    const previous = { ...process.env };
    process.env.QCR_SANDBOX_ROOT = root;
    process.env.QCR_SESSION_NAME = "pr-5410";
    process.env.QCR_PR = "5410";
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
          content: [{ type: "text", text: `<!-- qcr-command:cmd-5410:${"c".repeat(64)} -->` }],
        },
      });
      await emit("tool_execution_start", {
        toolName: "subagent",
        toolCallId: "sweep-1",
        args: {
          tasks: [
            { agent: "pass-sweep", task: "files a" },
            { agent: "pass-sweep", task: "files b" },
          ],
        },
      });
      const path = join(root, "state", "round-progress", "pr-5410.json");
      const started = parseRoundProgress(readFileSync(path, "utf8"))!;
      expect(started.agents.map((a) => a.execution_id)).toEqual([
        "sweep-1:pass-sweep",
        "sweep-1:pass-sweep#2",
      ]);

      await emit("tool_execution_update", {
        toolName: "subagent",
        toolCallId: "sweep-1",
        partialResult: {
          details: {
            mode: "parallel",
            results: [
              { agent: "pass-sweep", exitCode: 0 },
              { agent: "pass-sweep", exitCode: -1 },
            ],
          },
        },
      });
      const mid = parseRoundProgress(readFileSync(path, "utf8"))!;
      expect(mid.agents).toHaveLength(2);
      const byId = new Map(mid.agents.map((a) => [a.execution_id, a]));
      expect(byId.get("sweep-1:pass-sweep")).toMatchObject({
        status: "completed",
        finished_at: expect.any(String),
      });
      expect(byId.get("sweep-1:pass-sweep#2")?.status).toBe("running");
      expect(byId.get("sweep-1:pass-sweep#2")?.finished_at).toBeUndefined();

      await emit("tool_execution_end", {
        toolName: "subagent",
        toolCallId: "sweep-1",
        result: {
          details: {
            results: [
              { agent: "pass-sweep", exitCode: 0 },
              { agent: "pass-sweep", exitCode: 1 },
            ],
          },
        },
      });
      const done = parseRoundProgress(readFileSync(path, "utf8"))!;
      expect(done.agents.map((a) => [a.execution_id, a.status])).toEqual([
        ["sweep-1:pass-sweep", "completed"],
        ["sweep-1:pass-sweep#2", "failed"],
      ]);
    } finally {
      process.env = previous;
    }
  });

  it("stamps a parallel slot's completion on the update that first reports it finished", async () => {
    const root = mkdtempSync(join(tmpdir(), "qcr-progress-"));
    dirs.push(root);
    const previous = { ...process.env };
    process.env.QCR_SANDBOX_ROOT = root;
    process.env.QCR_SESSION_NAME = "pr-5470";
    process.env.QCR_PR = "5470";
    const handlers = new Map<string, PiEventHandler[]>();
    const pi = {
      on(name: string, handler: PiEventHandler) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
    };
    const emit = async (name: string, event: Record<string, unknown> = {}) => {
      for (const handler of handlers.get(name) ?? []) await handler(event);
    };
    const update = (exitCodes: [number, number]) =>
      emit("tool_execution_update", {
        toolName: "subagent",
        toolCallId: "par-1",
        partialResult: {
          details: {
            mode: "parallel",
            results: [
              { agent: "pass-baseline", exitCode: exitCodes[0] },
              { agent: "pass-security", exitCode: exitCodes[1] },
            ],
          },
        },
      });
    try {
      activate(pi as never);
      await emit("agent_start");
      await emit("tool_execution_start", {
        toolName: "subagent",
        toolCallId: "par-1",
        args: { tasks: [{ agent: "pass-baseline" }, { agent: "pass-security" }] },
      });
      const path = join(root, "state", "round-progress", "pr-5470.json");
      await update([0, -1]);
      const first = parseRoundProgress(readFileSync(path, "utf8"));
      expect(first).toBeDefined();
      const done = first!.agents.find((agent) => agent.agent === "pass-baseline")!;
      const live = first!.agents.find((agent) => agent.agent === "pass-security")!;
      expect(done).toMatchObject({ status: "completed", finished_at: expect.any(String) });
      expect(live.status).toBe("running");
      expect(live.finished_at).toBeUndefined();

      await update([0, -1]);
      const later = parseRoundProgress(readFileSync(path, "utf8"));
      expect(later).toBeDefined();
      expect(later!.agents.find((agent) => agent.agent === "pass-baseline")!.finished_at).toBe(
        done.finished_at,
      );
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

// The wide fan-out runs each pass as its own one-task native call,
// but the events round-progress sees still belong to the ONE outer call: its
// slot keys come from the outer name list and are matched by position. Pin
// that the per-pass fan-out keeps every update positional, including two
// tasks of one agent finishing out of order.
describe("round progress — wide fan-out, one permit per pass", () => {
  it("keys every slot of the outer call by position while passes finish out of order", async () => {
    const root = mkdtempSync(join(tmpdir(), "qcr-progress-wide-"));
    dirs.push(root);
    const previous = { ...process.env };
    process.env.QCR_SANDBOX_ROOT = root;
    process.env.QCR_SESSION_NAME = "pr-5583";
    process.env.QCR_PR = "5583";
    const handlers = new Map<string, PiEventHandler[]>();
    const pi = {
      on(name: string, handler: PiEventHandler) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
    };
    const emit = async (name: string, event: Record<string, unknown> = {}) => {
      for (const handler of handlers.get(name) ?? []) await handler(event);
    };
    const tick = () => new Promise<void>((r) => setTimeout(r, 0));
    const tasks = [
      { agent: "pass-baseline", task: "t0" },
      { agent: "pass-sweep", task: "t1" },
      { agent: "pass-security", task: "t2" },
      { agent: "pass-sweep", task: "t3" },
      { agent: "pass-style", task: "t4" },
    ];
    const finish = new Map<string, () => void>();
    const native = (async (
      _id: string,
      params: Record<string, unknown>,
      _signal: unknown,
      onUpdate: (u: unknown) => void,
    ) => {
      const task = (params.tasks as typeof tasks)[0]!;
      await new Promise<void>((r) => finish.set(task.task, r));
      // Native emits a parallel update as each child completes.
      onUpdate({
        content: [{ type: "text", text: "Parallel: 1/1 done" }],
        details: { mode: "parallel", results: [{ ...task, exitCode: 0 }] },
      });
      return {
        content: [{ type: "text", text: `Parallel: 1/1 succeeded\n\n${task.task}` }],
        details: { mode: "parallel", results: [{ ...task, exitCode: 0 }] },
      };
    }) as unknown as Parameters<typeof wrapExecute>[0];
    const pending: Array<Promise<void>> = [];
    try {
      activate(pi as never);
      await emit("agent_start");
      await emit("tool_execution_start", {
        toolName: "subagent",
        toolCallId: "wide-1",
        args: { tasks },
      });
      const wrapped = wrapExecute(native, new WeightedSemaphore(4), { [WIDE_FANOUT_ENV]: "1" });
      const call = wrapped("wide-1", { tasks }, undefined, (u: unknown) => {
        pending.push(
          emit("tool_execution_update", {
            toolName: "subagent",
            toolCallId: "wide-1",
            partialResult: u,
          }),
        );
      }) as unknown as Promise<unknown>;
      await tick();
      const path = join(root, "state", "round-progress", "pr-5583.json");
      // The later pass-sweep (#2) ends first, while the first one still runs.
      finish.get("t3")!();
      await tick();
      await tick();
      await Promise.all(pending);
      const mid = parseRoundProgress(readFileSync(path, "utf8"))!;
      const byId = new Map(mid.agents.map((a) => [a.execution_id, a.status]));
      expect(byId.get("wide-1:pass-sweep#2")).toBe("completed");
      expect(byId.get("wide-1:pass-sweep")).toBe("running");
      expect(byId.get("wide-1:pass-style")).toBe("running");
      expect(mid.agents).toHaveLength(5);
      finish.get("t0")!();
      await tick();
      await tick();
      for (const t of ["t1", "t2", "t4"]) {
        finish.get(t)!();
        await tick();
        await tick();
      }
      const result = await call;
      await Promise.all(pending);
      await emit("tool_execution_end", { toolName: "subagent", toolCallId: "wide-1", result });
      const done = parseRoundProgress(readFileSync(path, "utf8"))!;
      expect(done.agents.map((a) => [a.execution_id, a.status])).toEqual([
        ["wide-1:pass-baseline", "completed"],
        ["wide-1:pass-sweep", "completed"],
        ["wide-1:pass-security", "completed"],
        ["wide-1:pass-sweep#2", "completed"],
        ["wide-1:pass-style", "completed"],
      ]);
    } finally {
      process.env = previous;
    }
  });
});

// A `launch_plan` call names task directories, not agents. The
// pre-fanout stall clock must still see the fan-out begin at tool START, from
// the same plan the tool computes; a refused plan starts nothing.
describe("round progress — launch_plan", () => {
  it.each(["plan", "sweep", "optional"] as const)(
    "records %s phase with the agents at tool start",
    async (phase) => {
      const root = mkdtempSync(join(tmpdir(), "qcr-progress-lp-"));
      dirs.push(root);
      const tasks = join(
        root,
        "state",
        "pr-5409-round-1-passes",
        phase === "plan" ? "tasks" : `tasks-${phase}`,
      );
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
              {
                type: "text",
                text: `round order\n<!-- qcr-command:cmd-5409:${"b".repeat(64)} -->`,
              },
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
        expect(running.agents.map((a: { phase?: string }) => a.phase)).toEqual([phase, phase]);
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
    },
  );
});

// D3: the engine's tools are `lens` and `lens_wave`; the tmux bot still runs
// `subagent` and `launch_plan`. The extension reads both, and one lens run
// (one LensResult `id`) is one row however many calls report it.
describe("round progress — lens and lens_wave", () => {
  async function rig(pr: string) {
    const root = mkdtempSync(join(tmpdir(), "qcr-progress-lens-"));
    dirs.push(root);
    const previous = { ...process.env };
    process.env.QCR_SANDBOX_ROOT = root;
    process.env.QCR_SESSION_NAME = `pr-${pr}`;
    process.env.QCR_PR = pr;
    const handlers = new Map<string, PiEventHandler[]>();
    const pi = {
      on(name: string, handler: PiEventHandler) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
    };
    const emit = async (name: string, event: Record<string, unknown> = {}) => {
      for (const handler of handlers.get(name) ?? []) await handler(event);
    };
    activate(pi as never);
    await emit("agent_start");
    await emit("message_start", {
      message: {
        role: "user",
        content: [{ type: "text", text: `<!-- qcr-command:cmd-${pr}:${"d".repeat(64)} -->` }],
      },
    });
    const read = () =>
      parseRoundProgress(
        readFileSync(join(root, "state", "round-progress", `pr-${pr}.json`), "utf8"),
      )!;
    return { emit, read, restore: () => void (process.env = previous) };
  }

  it("reads a lens call's tasks at start, like subagent", async () => {
    const t = await rig("5501");
    try {
      await t.emit("tool_execution_start", {
        toolName: "lens",
        toolCallId: "l-1",
        args: {
          tasks: [
            { agent: "pass-security", task: "a" },
            { agent: "pass-baseline", task: "b" },
          ],
        },
      });
      const started = t.read();
      expect(started.agents.map((a) => [a.execution_id, a.status])).toEqual([
        ["l-1:pass-security", "running"],
        ["l-1:pass-baseline", "running"],
      ]);
      expect(started.first_lens_started_at).toEqual(expect.any(String));
    } finally {
      t.restore();
    }
  });

  it("a lens_wave has no arguments: its rows come from its results, and a repeat call adds none", async () => {
    const t = await rig("5502");
    try {
      await t.emit("tool_execution_start", { toolName: "lens_wave", toolCallId: "w-1", args: {} });
      expect(t.read().agents).toEqual([]);
      const wave = [
        { id: "L1", agent: "pass-security", exitCode: 0 },
        { id: "L2", agent: "pass-baseline", exitCode: -1 },
      ];
      await t.emit("tool_execution_update", {
        toolName: "lens_wave",
        toolCallId: "w-1",
        partialResult: { details: { mode: "parallel", results: wave } },
      });
      expect(t.read().agents.map((a) => [a.execution_id, a.status])).toEqual([
        ["w-1:pass-security", "completed"],
        ["w-1:pass-baseline", "running"],
      ]);
      await t.emit("tool_execution_end", {
        toolName: "lens_wave",
        toolCallId: "w-1",
        result: { details: { results: wave.map((r) => ({ ...r, exitCode: 0 })) } },
      });
      // The main session joins the same wave a second time.
      await t.emit("tool_execution_start", { toolName: "lens_wave", toolCallId: "w-2", args: {} });
      await t.emit("tool_execution_end", {
        toolName: "lens_wave",
        toolCallId: "w-2",
        result: { details: { results: wave.map((r) => ({ ...r, exitCode: 0 })) } },
      });
      const done = t.read();
      expect(done.agents.map((a) => [a.execution_id, a.status])).toEqual([
        ["w-1:pass-security", "completed"],
        ["w-1:pass-baseline", "completed"],
      ]);
    } finally {
      t.restore();
    }
  });

  it("results without an id (the native shape) still get a row per call", async () => {
    const t = await rig("5503");
    try {
      for (const call of ["s-1", "s-2"])
        await t.emit("tool_execution_end", {
          toolName: "subagent",
          toolCallId: call,
          result: { details: { results: [{ agent: "pass-security", exitCode: 0 }] } },
        });
      expect(t.read().agents.map((a) => a.execution_id)).toEqual([
        "s-1:pass-security",
        "s-2:pass-security",
      ]);
    } finally {
      t.restore();
    }
  });
});

// The snapshot is rewritten on every event; the transition log
// beside it keeps the order a run took, so an ended round can be diagnosed.
describe("round progress — append-only transition log", () => {
  it("appends every transition in order and survives snapshot rewrites", async () => {
    const root = mkdtempSync(join(tmpdir(), "qcr-progress-"));
    dirs.push(root);
    const previous = { ...process.env };
    process.env.QCR_SANDBOX_ROOT = root;
    process.env.QCR_SESSION_NAME = "pr-5948";
    process.env.QCR_PR = "5948";
    const handlers = new Map<string, PiEventHandler[]>();
    const pi = {
      on(name: string, handler: PiEventHandler) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
    };
    const emit = async (name: string, event: Record<string, unknown> = {}) => {
      for (const handler of handlers.get(name) ?? []) await handler(event);
    };
    const snapshotPath = join(root, "state", "round-progress", "pr-5948.json");
    const logPath = join(root, "state", "round-progress", "pr-5948.jsonl");
    const lines = () =>
      readFileSync(logPath, "utf8")
        .trimEnd()
        .split("\n")
        .map((l) => JSON.parse(l));
    const order = (cmd: string) => ({
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: `round order\nexport QCR_ROUND_NO=4\n**Worktree**: wt @ \`head-4\`\n<!-- qcr-command:${cmd}:${"c".repeat(64)} -->`,
          },
        ],
      },
    });
    try {
      activate(pi as never);
      await emit("agent_start");
      await emit("message_start", order("cmd-r4"));
      await emit("tool_execution_start", {
        toolName: "subagent",
        toolCallId: "sweep",
        args: {
          tasks: [
            { agent: "pass-sweep", task: "a" },
            { agent: "pass-sweep", task: "b" },
          ],
        },
      });
      // A parallel slot finishes mid-call (update), then the call ends: one end line each.
      await emit("tool_execution_update", {
        toolName: "subagent",
        toolCallId: "sweep",
        partialResult: {
          details: {
            mode: "parallel",
            results: [
              { agent: "pass-sweep", exitCode: 0 },
              { agent: "pass-sweep", exitCode: -1 },
            ],
          },
        },
      });
      await emit("message_update"); // heartbeat rewrite: no transition
      await emit("tool_execution_end", {
        toolName: "subagent",
        toolCallId: "sweep",
        result: {
          details: {
            mode: "parallel",
            results: [
              { agent: "pass-sweep", exitCode: 0 },
              { agent: "pass-sweep", exitCode: 1 },
            ],
          },
        },
      });
      await emit("tool_execution_start", {
        toolName: "bash",
        toolCallId: "b1",
        args: { command: "ls" },
      });
      await emit("agent_settled");
      // The next run REWRITES the snapshot from scratch; the log only grows.
      await emit("agent_start");
      await emit("message_start", order("cmd-r5"));

      const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
      expect(snapshot).toMatchObject({ command_id: "cmd-r5", agents: [] });

      const log = lines();
      expect(log.map((l) => [l.event, l.execution_id ?? null, l.status ?? null])).toEqual([
        ["parent_start", null, null],
        ["command_accepted", null, null],
        ["pass_start", "sweep:pass-sweep", null],
        ["pass_start", "sweep:pass-sweep#2", null],
        ["pass_end", "sweep:pass-sweep", "completed"],
        ["pass_end", "sweep:pass-sweep#2", "failed"],
        ["parent_settle", null, null],
        ["parent_start", null, null],
        ["command_accepted", null, null],
      ]);
      expect(log[1]).toMatchObject({
        pr: 5948,
        session: "pr-5948",
        command_id: "cmd-r4",
        round_no: 4,
        head_sha: "head-4",
      });
      expect(log[6].command_id).toBe("cmd-r4");
      expect(log[7].command_id).toBeUndefined();
      expect(log[8].command_id).toBe("cmd-r5");
      expect(log.every((l) => typeof l.run_started_at === "string")).toBe(true);
      const at = log.map((l) => Date.parse(l.at));
      expect(at.every((t, i) => i === 0 || t >= at[i - 1]!)).toBe(true);
    } finally {
      process.env = previous;
    }
  });

  it("is bounded: past the cap it rotates once to .jsonl.1", () => {
    const root = mkdtempSync(join(tmpdir(), "qcr-progress-"));
    dirs.push(root);
    const path = progressLogPath(join(root, "pr-1.json"));
    expect(path).toBe(join(root, "pr-1.jsonl"));
    const line = (n: number) => ({
      at: new Date(n * 1000).toISOString(),
      pr: 1,
      session: "pr-1",
      run_started_at: new Date(0).toISOString(),
      event: "parent_start" as const,
    });
    const size = Buffer.byteLength(`${JSON.stringify(line(1))}\n`);
    for (let n = 1; n <= 7; n++) appendProgressLog(path, line(n), size * 3);
    // 1-3 filled the first file, 4-6 the second (1-3 rotated, later replaced), 7 starts a third.
    const read = (p: string) =>
      readFileSync(p, "utf8")
        .trimEnd()
        .split("\n")
        .map((l) => Date.parse(JSON.parse(l).at) / 1000);
    expect(read(`${path}.1`)).toEqual([4, 5, 6]);
    expect(read(path)).toEqual([7]);
    expect(existsSync(`${path}.2`)).toBe(false);
  });
});

describe("subagent event ordering", () => {
  async function harness(
    run: (
      emit: (name: string, event?: Record<string, unknown>) => Promise<void>,
      read: () => ReturnType<typeof parseRoundProgress>,
    ) => Promise<void>,
  ) {
    const root = mkdtempSync(join(tmpdir(), "qcr-progress-order-"));
    dirs.push(root);
    const previous = { ...process.env };
    Object.assign(process.env, { QCR_SANDBOX_ROOT: root, QCR_SESSION_NAME: "pr-42", QCR_PR: "42" });
    const handlers = new Map<string, PiEventHandler[]>();
    const emit = async (name: string, event: Record<string, unknown> = {}) => {
      for (const handler of handlers.get(name) ?? []) await handler(event);
    };
    try {
      activate({
        on(name: string, handler: PiEventHandler) {
          handlers.set(name, [...(handlers.get(name) ?? []), handler]);
        },
      } as never);
      await emit("agent_start");
      await run(emit, () =>
        parseRoundProgress(readFileSync(join(root, "state/round-progress/pr-42.json"), "utf8")),
      );
    } finally {
      process.env = previous;
    }
  }
  it("publishes a readable snapshot when a chain is the first fanout", async () => {
    await harness(async (emit, read) => {
      await emit("tool_execution_start", {
        toolName: "subagent",
        toolCallId: "c",
        args: {
          chain: [
            { agent: "pass-a", task: "a" },
            { agent: "pass-b", task: "b" },
          ],
        },
      });
      await emit("tool_execution_update", {
        toolName: "subagent",
        toolCallId: "c",
        partialResult: { details: { mode: "chain", results: [{ agent: "pass-a", exitCode: 0 }] } },
      });
      expect(read()).toBeDefined();
      expect(read()?.fanout_started_at).toBeDefined();
    });
  });
  it("preserves completed siblings when a parallel call ends with no results", async () => {
    await harness(async (emit, read) => {
      await emit("tool_execution_start", {
        toolName: "subagent",
        toolCallId: "c",
        args: {
          tasks: [
            { agent: "pass-a", task: "a" },
            { agent: "pass-b", task: "b" },
          ],
        },
      });
      await emit("tool_execution_update", {
        toolName: "subagent",
        toolCallId: "c",
        partialResult: {
          details: {
            mode: "parallel",
            results: [
              { agent: "pass-a", exitCode: 0 },
              { agent: "pass-b", exitCode: -1 },
            ],
          },
        },
      });
      await emit("tool_execution_end", { toolName: "subagent", toolCallId: "c", isError: true });
      expect(read()?.agents.map((a) => a.status)).toEqual(["completed", "failed"]);
    });
  });
});

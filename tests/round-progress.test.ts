import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import activate from "../extensions/round-progress.js";
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
          content: [{ type: "text", text: `round order\n<!-- qcr-command:cmd-5408:${"a".repeat(64)} -->` }],
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
            results: [{
              agent: "pass-security",
              progress: {
                status: "running",
                durationMs: 12_000,
                toolCount: 3,
                lastMessage: "Tracing the bearer into the logger",
                recentTools: [{ tool: "grep", args: "bearer", status: "running" }],
              },
            }],
          },
        },
      });

      const path = join(root, "state", "round-progress", "pr-5408.json");
      const running = JSON.parse(readFileSync(path, "utf8"));
      expect(running).toMatchObject({
        version: 1,
        pr: 5408,
        session: "pr-5408",
        parent_status: "active",
        command_id: "cmd-5408",
        command_sha256: "a".repeat(64),
        active_tool: "subagent: pass-security",
      });
      expect(running.agents).toEqual([expect.objectContaining({
        agent: "pass-security",
        status: "running",
        duration_ms: 12_000,
        tool_count: 3,
        current_tool: "grep: bearer",
        last_message: "Tracing the bearer into the logger",
      })]);

      await emit("tool_execution_end", {
        toolName: "subagent",
        toolCallId: "lens-1",
        result: { details: { results: [{ agent: "pass-security", exitCode: 0, progress: { status: "completed", durationMs: 15_000, toolCount: 4 } }] } },
      });
      await emit("agent_settled");
      const done = JSON.parse(readFileSync(path, "utf8"));
      expect(done.parent_status).toBe("settled");
      expect(done.agents[0]).toMatchObject({ agent: "pass-security", status: "completed", duration_ms: 15_000, tool_count: 4 });
      expect(done.last_activity).toContain("session settled");
    } finally {
      process.env = previous;
    }
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

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const rig = vi.hoisted(() => ({
  root: "",
  session: "",
  transcript: "",
  spawnFail: false,
  killed: false,
  remainsLive: false,
  unknown: false,
}));
vi.mock("../src/config.js", () => ({
  loadConfig: () => ({ pi: { version: "1.0.0" }, models: { conversation: "fixture/model" } }),
  sandboxRoot: () => rig.root,
}));
vi.mock("../src/tmux.js", () => ({
  nodeExec: async () => ({ code: 0, stdout: "1.0.0", stderr: "" }),
}));
vi.mock("../src/sessions.js", () => ({
  PiSessionManager: class {
    tmux = {
      killSession: async () => {
        rig.killed = true;
      },
      listSessionsKnown: async () => (rig.unknown ? null : rig.remainsLive ? [rig.session] : []),
    };
    sessionDir() {
      return join(rig.root, "session");
    }
    injectDir() {
      return join(rig.root, "inject");
    }
    promptPath() {
      return join(rig.root, "prompt.md");
    }
    async spawnSession(session: string) {
      rig.session = session;
      mkdirSync(this.sessionDir(), { recursive: true });
      mkdirSync(this.injectDir(), { recursive: true });
      mkdirSync(join(rig.root, "state/sessions"), { recursive: true });
      writeFileSync(this.promptPath(), "system");
      writeFileSync(join(this.sessionDir(), "trace.jsonl"), rig.transcript);
      writeFileSync(join(rig.root, "state/sessions", `${session}.json`), "birth");
      writeFileSync(
        join(rig.root, "state/sessions", `${session}.bridge-generation.json`),
        "bridge",
      );
      if (rig.spawnFail) throw new Error("partial spawn failed");
    }
    injectFile() {
      return join(this.injectDir(), "wake.md");
    }
    newestSessionFile() {
      return join(this.sessionDir(), "trace.jsonl");
    }
    removeSessionBirthMetadata(session: string) {
      rmSync(join(rig.root, "state/sessions", `${session}.json`), { force: true });
      rmSync(join(rig.root, "state/sessions", `${session}.bridge-generation.json`), {
        force: true,
      });
    }
  },
}));
const { main } = await import("../src/smoke-session.js");
const assistant = JSON.stringify({
  type: "message",
  message: { role: "assistant", content: [{ type: "text", text: "QCR-SMOKE-OK" }] },
});
beforeEach(() => {
  rig.root = mkdtempSync(join(tmpdir(), "qcr-smoke-"));
  rig.session = "";
  rig.transcript = assistant;
  rig.spawnFail = false;
  rig.killed = false;
  rig.remainsLive = false;
  rig.unknown = false;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-01T12:00:00Z"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(rig.root, { recursive: true, force: true });
});
async function run() {
  const result = main();
  await vi.runAllTimersAsync();
  return result;
}
it("requires the marker in an assistant reply rather than user or tool data", async () => {
  rig.transcript = ["user", "toolResult"]
    .map((role) =>
      JSON.stringify({
        type: "message",
        message: { role, content: [{ type: "text", text: "QCR-SMOKE-OK" }] },
      }),
    )
    .join("\n");
  expect(await run()).toBe(1);
});
it("removes birth and bridge metadata after a confirmed successful smoke cleanup", async () => {
  expect(await run()).toBe(0);
  expect(rig.killed).toBe(true);
  expect(existsSync(join(rig.root, "state/sessions", `${rig.session}.json`))).toBe(false);
  expect(
    existsSync(join(rig.root, "state/sessions", `${rig.session}.bridge-generation.json`)),
  ).toBe(false);
});
it("cleans up a session whose spawn partially succeeded then threw", async () => {
  rig.spawnFail = true;
  const result = main().then(
    () => undefined,
    (error: unknown) => error,
  );
  await vi.runAllTimersAsync();
  expect(await result).toBeInstanceOf(Error);
  expect(String(await result)).toContain("partial spawn failed");
  expect(rig.killed).toBe(true);
  expect(existsSync(join(rig.root, "session"))).toBe(false);
});
it("preserves routing evidence when the killed process is still present", async () => {
  rig.remainsLive = true;
  const result = main().then(
    () => undefined,
    (error: unknown) => error,
  );
  await vi.runAllTimersAsync();
  expect(String(await result)).toMatch(/still.*running|not.*gone|absence/i);
  expect(existsSync(join(rig.root, "state/sessions", `${rig.session}.json`))).toBe(true);
});

it("retains routing metadata when tmux cannot prove absence", async () => {
  rig.unknown = true;
  const result = main().then(
    () => undefined,
    (error: unknown) => error,
  );
  await vi.runAllTimersAsync();
  expect(String(await result)).toMatch(/absence/);
  expect(existsSync(join(rig.root, "state/sessions", `${rig.session}.json`))).toBe(true);
});
it("ignores thinking and tool-call marker payloads in assistant messages", async () => {
  rig.transcript = JSON.stringify({
    type: "message",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "QCR-SMOKE-OK" },
        { type: "toolCall", arguments: { text: "QCR-SMOKE-OK" } },
      ],
    },
  });
  expect(await run()).toBe(1);
});

import { describe, expect, it } from "vitest";
import { TUI_DEFAULTS } from "../src/config.js";
import { ArchiveOpSender } from "../src/tui/archiveops.js";
import { CommandDrainSender } from "../src/tui/deploy-drain.js";
import { PrLeverSender } from "../src/tui/prpause.js";
import { LessonSwitchSender } from "../src/tui/lessonswitch.js";
import { GithubIssueSink } from "../src/tui/issuesink.js";
import { type SshRunner } from "../src/tui/remote.js";
import { FakeMemory } from "./helpers/tui-rig.js";

const now = () => new Date("2026-08-13T12:00:00Z");
const sleep = async () => {};
function replies(receipt: object): SshRunner {
  const values = ["", '{"ok":', JSON.stringify(receipt)];
  return async () => ({ ok: true, stdout: values.shift() ?? "pending", stderr: "", code: 0 });
}
describe("partially published command receipts", () => {
  it("retries an archive receipt until the valid verdict arrives", async () => {
    const s = new ArchiveOpSender(TUI_DEFAULTS, replies({ ok: true }), now, sleep);
    expect((await s.send({ command: "archive-run" })).ok).toBe(true);
  });
  it("retries a drain receipt until the valid verdict arrives", async () => {
    const s = new CommandDrainSender(
      TUI_DEFAULTS,
      replies({ ok: true, draining: false }),
      now,
      sleep,
    );
    expect((await s.set(false)).ok).toBe(true);
  });
  it.each(["null", "[]", "7"])("retries a drain receipt that decodes to %s", async (junk) => {
    // layout probe, command write, then two receipt reads
    const values = ["", "", junk, JSON.stringify({ ok: true, draining: false })];
    const ssh: SshRunner = async () => ({
      ok: true,
      stdout: values.shift() ?? "pending",
      stderr: "",
      code: 0,
    });
    const s = new CommandDrainSender(TUI_DEFAULTS, ssh, now, sleep);
    expect((await s.set(false)).ok).toBe(true);
  });
  it("retries a lesson receipt until the valid verdict arrives", async () => {
    const s = new LessonSwitchSender(TUI_DEFAULTS, replies({ ok: true }), now, sleep);
    expect((await s.send({ command: "lessons-off" })).ok).toBe(true);
  });
  it("retries an issue receipt before filing/stamping the verdict", async () => {
    const memory = new FakeMemory();
    const s = new GithubIssueSink(
      TUI_DEFAULTS,
      replies({ ok: true, issue: 42 }),
      memory,
      now,
      sleep,
    );
    const result = await s.file([(await memory.read())[2]!], now().toISOString());
    expect(result).toMatchObject({ filed: [expect.objectContaining({ id: "#42" })] });
  });
  describe("a receipt that decodes to non-object JSON is re-read", () => {
    // Only the result.json probe sees the junk first, then the real receipt.
    function junkFirst(junk: string, receipt: object): SshRunner {
      const values = [junk, JSON.stringify(receipt)];
      return async (_host, argv) => ({
        ok: true,
        stdout: argv.some((a) => a.includes("result.json")) ? (values.shift() ?? "pending") : "",
        stderr: "",
        code: 0,
      });
    }
    it.each(["null", "[]", "7"])("lesson switch: %s", async (junk) => {
      const s = new LessonSwitchSender(TUI_DEFAULTS, junkFirst(junk, { ok: true }), now, sleep);
      expect((await s.send({ command: "lessons-off" })).ok).toBe(true);
    });
    it.each(["null", "[]", "7"])("pr lever: %s", async (junk) => {
      const s = new PrLeverSender(TUI_DEFAULTS, junkFirst(junk, { ok: true }), now, sleep);
      expect((await s.send({ command: "pause-pr", pr: 7, reason: "r" } as const)).ok).toBe(true);
    });
    it.each(["null", "[]", "7"])("issue sink: %s", async (junk) => {
      const memory = new FakeMemory();
      const s = new GithubIssueSink(
        TUI_DEFAULTS,
        junkFirst(junk, { ok: true, issue: 42 }),
        memory,
        now,
        sleep,
      );
      const result = await s.file([(await memory.read())[2]!], now().toISOString());
      expect(result).toMatchObject({ filed: [expect.objectContaining({ id: "#42" })] });
    });
  });
});

import { describe, expect, it } from "vitest";
import { ExecError, Tmux, runOrThrow } from "../src/tmux.js";
import type { ExecFn, ExecOpts, ExecResult } from "../src/tmux.js";

interface Call {
  cmd: string;
  args: string[];
  opts?: ExecOpts;
}

function fakeExec(
  respond: (cmd: string, args: string[]) => Partial<ExecResult> = () => ({}),
): { exec: ExecFn; calls: Call[] } {
  const calls: Call[] = [];
  const exec: ExecFn = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { code: 0, stdout: "", stderr: "", ...respond(cmd, args) };
  };
  return { exec, calls };
}

describe("Tmux", () => {
  it("lists session names", async () => {
    const { exec, calls } = fakeExec(() => ({ stdout: "pr-1\noverseer\n\n" }));
    const names = await new Tmux({ exec }).listSessions();
    expect(names).toEqual(["pr-1", "overseer"]);
    expect(calls[0]).toMatchObject({ cmd: "tmux", args: ["list-sessions", "-F", "#{session_name}"] });
  });

  it("returns no sessions when the tmux server is not running", async () => {
    const { exec } = fakeExec(() => ({ code: 1, stderr: "no server running on /tmp/tmux-1000/default" }));
    expect(await new Tmux({ exec }).listSessions()).toEqual([]);
  });

  it("checks session existence with an exact-match target", async () => {
    const { exec, calls } = fakeExec((_c, args) => ({ code: args[2] === "=pr-7" ? 0 : 1 }));
    const tmux = new Tmux({ exec });
    expect(await tmux.hasSession("pr-7")).toBe(true);
    expect(await tmux.hasSession("pr-70")).toBe(false);
    expect(calls[0]!.args).toEqual(["has-session", "-t", "=pr-7"]);
  });

  it("creates a detached session with cwd, env and argv command", async () => {
    const { exec, calls } = fakeExec();
    await new Tmux({ exec }).newSession("pr-9", ["pi", "--model", "m"], {
      cwd: "/sandbox",
      env: { PATH: "/usr/bin" },
    });
    expect(calls[0]!.args).toEqual([
      "new-session", "-d", "-s", "pr-9", "-c", "/sandbox", "pi", "--model", "m",
    ]);
    expect(calls[0]!.opts?.env).toEqual({ PATH: "/usr/bin" });
  });

  it("throws when tmux fails to create a session", async () => {
    const { exec } = fakeExec(() => ({ code: 1, stderr: "duplicate session" }));
    await expect(new Tmux({ exec }).newSession("pr-9", ["pi"])).rejects.toBeInstanceOf(ExecError);
  });

  it("kills by exact target and never by prefix", async () => {
    const { exec, calls } = fakeExec();
    await new Tmux({ exec }).killSession("pr-9");
    expect(calls[0]!.args).toEqual(["kill-session", "-t", "=pr-9"]);
  });

  it("sends literal text plus Enter", async () => {
    const { exec, calls } = fakeExec();
    await new Tmux({ exec }).send("pr-9", "hi");
    expect(calls.map((c) => c.args)).toEqual([
      // `=name:` — tmux 3.5 rejects bare `=name` as a pane target (live, 2026-08-17)
      ["send-keys", "-t", "=pr-9:", "-l", "hi"],
      ["send-keys", "-t", "=pr-9:", "Enter"],
    ]);
  });

  it("honors a custom binary name", async () => {
    const { exec, calls } = fakeExec();
    await new Tmux({ exec, bin: "/usr/local/bin/tmux" }).hasSession("x");
    expect(calls[0]!.cmd).toBe("/usr/local/bin/tmux");
  });
});

describe("runOrThrow", () => {
  it("returns the result on success", async () => {
    const { exec } = fakeExec(() => ({ stdout: "ok" }));
    expect((await runOrThrow(exec, "git", ["status"])).stdout).toBe("ok");
  });

  it("throws ExecError carrying the command on failure", async () => {
    const { exec } = fakeExec(() => ({ code: 128, stderr: "boom" }));
    await expect(runOrThrow(exec, "git", ["status"])).rejects.toThrow(/git status exited 128: boom/);
  });
});

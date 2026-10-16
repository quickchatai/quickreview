// The laptop topology: `[tui] target = "local"` drives every TUI
// remote op through the local runner. The property that matters is absolute:
// in local mode NO ssh argv is ever constructed and no ssh process is ever
// spawned — not by the runner, not by attach, not by the power buttons, not
// by the ssh-master bootstrap. The ssh route is the live production path and
// local mode leaves it byte-identical.
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.fn();
const spawnSyncMock = vi.fn();
const execFileMock = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: (...a: unknown[]) => spawnMock(...a),
  spawnSync: (...a: unknown[]) => spawnSyncMock(...a),
  execFile: (...a: unknown[]) => execFileMock(...a),
}));

const { TUI_DEFAULTS, loadConfig, parseConfig } = await import("../src/config.js");
type TuiConfig = import("../src/config.js").TuiConfig;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { killInFlightSsh, realLocalCommandRunner, realSshRunner, runnerFor, transportOf } =
  await import("../src/tui/remote.js");
const { powerCommand, powerSpawnArgv } = await import("../src/tui/deploytab.js");
const { ensureSshMaster } = await import("../src/tui/connect.js");
type SyncSsh = import("../src/tui/connect.js").SyncSsh;

const LOCAL: TuiConfig = { ...TUI_DEFAULTS, target: "local" };

/** A child that never exits on its own (see tui-ssh-inflight.test.ts). */
function fakeChild(): EventEmitter & {
  kill: ReturnType<typeof vi.fn>;
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { end: ReturnType<typeof vi.fn> };
} {
  const child = new EventEmitter() as ReturnType<typeof fakeChild>;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end: vi.fn() };
  child.kill = vi.fn();
  return child;
}

afterEach(() => {
  killInFlightSsh(); // never leak tracked children between tests
  spawnMock.mockReset();
  spawnSyncMock.mockReset();
  execFileMock.mockReset();
});

describe("[tui] target — the knob itself", () => {
  const fixture = readFileSync(resolve(ROOT, "tests/fixtures/config.toml"), "utf8");

  it("defaults to ssh when a config predating the knob omits it", () => {
    expect(fixture).not.toContain("target =");
    expect(parseConfig(fixture).tui.target).toBe("ssh");
  });

  it("reads an explicit local topology", () => {
    expect(parseConfig(fixture.replace("[tui]", '[tui]\ntarget = "local"')).tui.target).toBe(
      "local",
    );
  });

  it("refuses anything else rather than silently falling back to a transport", () => {
    expect(() => parseConfig(fixture.replace("[tui]", '[tui]\ntarget = "Local"'))).toThrow(
      /target must be "ssh" or "local"/,
    );
    expect(() => parseConfig(fixture.replace("[tui]", "[tui]\ntarget = 1"))).toThrow(
      /target must be/,
    );
  });

  it("config.example.toml documents the knob and ships the ssh default", () => {
    const example = readFileSync(resolve(ROOT, "config.example.toml"), "utf8");
    expect(example).toMatch(/^target = "ssh"$/m);
    expect(example).toContain('"local"'); // the alternative is spelled out, not implied
    expect(loadConfig(resolve(ROOT, "config.example.toml")).tui.target).toBe("ssh");
  });
});

describe("transport selection", () => {
  it("defaults to ssh — the live production path — and is never inferred", () => {
    expect(TUI_DEFAULTS.target).toBe("ssh");
    expect(transportOf(TUI_DEFAULTS)).toBe("ssh");
    expect(runnerFor(TUI_DEFAULTS)).toBe(realSshRunner);
    // An empty ssh_host does NOT flip the transport — only the explicit knob.
    expect(transportOf({ ...TUI_DEFAULTS, ssh_host: "" })).toBe("ssh");
  });

  it("picks the local runner only on the explicit knob", () => {
    expect(transportOf(LOCAL)).toBe("local");
    expect(runnerFor(LOCAL)).toBe(realLocalCommandRunner);
  });
});

describe("realLocalCommandRunner", () => {
  it("executes argv[0] directly — same argv the builders produce, no ssh, no shell", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValueOnce(child);
    const done = realLocalCommandRunner(
      "my-vm-ignored",
      ["sudo", "docker", "exec", "quickreview-sandbox", "cat", "/x"],
      { stdin: "hi" },
    );
    child.stdout.emit("data", Buffer.from("ok"));
    child.emit("close", 0);
    await expect(done).resolves.toMatchObject({ ok: true, stdout: "ok", code: 0 });
    const [bin, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(bin).toBe("sudo");
    expect(args).toEqual(["docker", "exec", "quickreview-sandbox", "cat", "/x"]);
    // The host param is transport detail — never a spawned word, never ssh.
    expect(bin).not.toBe("ssh");
    expect(args).not.toContain("my-vm-ignored");
    expect(child.stdin.end).toHaveBeenCalledWith("hi");
  });

  it("reports a non-zero exit as a refusal with the code, like the ssh runner", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValueOnce(child);
    const done = realLocalCommandRunner("x", ["docker", "ps"]);
    child.stderr.emit("data", Buffer.from("permission denied"));
    child.emit("close", 1);
    await expect(done).resolves.toMatchObject({ ok: false, stderr: "permission denied", code: 1 });
  });

  it("names a spawn error and a timeout in stderr — a missing binary prints nothing of its own", async () => {
    const missing = fakeChild();
    spawnMock.mockReturnValueOnce(missing);
    const gone = realLocalCommandRunner("x", ["docker", "ps"]);
    missing.emit("error", Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" }));
    await expect(gone).resolves.toMatchObject({
      ok: false,
      stderr: "spawn docker ENOENT",
      code: null,
    });

    vi.useFakeTimers();
    try {
      const slow = fakeChild();
      spawnMock.mockReturnValueOnce(slow);
      const late = realLocalCommandRunner("x", ["docker", "ps"], { timeoutMs: 50 });
      slow.stderr.emit("data", Buffer.from("still trying"));
      vi.advanceTimersByTime(60);
      await expect(late).resolves.toMatchObject({
        ok: false,
        stderr: "still trying\ndocker: timed out after 50ms",
        code: null,
      });
      expect(slow.kill).toHaveBeenCalledWith("SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses an empty argv without spawning anything", async () => {
    await expect(realLocalCommandRunner("x", [])).resolves.toMatchObject({ ok: false });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rides the same in-flight set — the re-exec teardown kills wedged local children too", () => {
    const child = fakeChild();
    spawnMock.mockReturnValueOnce(child);
    void realLocalCommandRunner("x", ["docker", "exec", "c", "cat", "/x"]);
    expect(killInFlightSsh()).toBe(1);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });
});

describe("powerSpawnArgv", () => {
  it("ssh mode is the remote shell line, exactly as before", () => {
    expect(powerSpawnArgv(TUI_DEFAULTS, "stop")).toEqual([
      "ssh",
      "my-vm",
      powerCommand(TUI_DEFAULTS, "stop"),
    ]);
  });

  it("local mode runs the same words directly — no ssh", () => {
    expect(powerSpawnArgv(LOCAL, "stop")).toEqual(["sudo", "docker", "stop", "quickreview-sandbox"]);
    expect(powerSpawnArgv({ ...LOCAL, sudo_docker: false }, "start")).toEqual([
      "docker",
      "start",
      "quickreview-sandbox",
    ]);
    expect(powerSpawnArgv(LOCAL, "stop")).not.toContain("ssh");
  });
});

describe("ensureSshMaster in local mode", () => {
  it("is a silent no-op — the injected ssh is never invoked", () => {
    const calls: string[][] = [];
    const ssh: SyncSsh = (argv) => {
      calls.push(argv);
      return { status: 0, stderr: "" };
    };
    const said: string[] = [];
    expect(ensureSshMaster(LOCAL, ssh, (l) => said.push(l)).kind).toBe("local");
    expect(calls).toEqual([]);
    expect(said).toEqual([]);
  });

  it("spawns nothing even on the default (real) path", () => {
    expect(ensureSshMaster(LOCAL, undefined, () => {}).kind).toBe("local");
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

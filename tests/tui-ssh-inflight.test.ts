// The hot reload freezes this process inside spawnSync, and every ssh still in
// flight at that moment loses the only thing that would ever kill it: the
// per-call SIGKILL timer, which lives on the loop that just stopped. Measured
// live at 4h58m against a wedged ControlMaster, with 26 stacked generations
// each holding its own orphan. `killInFlightSsh` is what the re-exec teardown
// calls while the loop still turns — these pin that it tracks and releases.
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));

const { killInFlightSsh, realSshRunner } = await import("../src/tui/remote.js");

/** A child that never exits — exactly the wedged-ControlMaster case. */
function hangingChild(): EventEmitter & {
  kill: ReturnType<typeof vi.fn>;
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { end: () => void };
} {
  const child = new EventEmitter() as ReturnType<typeof hangingChild>;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end: () => {} };
  child.kill = vi.fn();
  return child;
}

afterEach(() => {
  killInFlightSsh(); // never leak tracked children between tests
  spawnMock.mockReset();
});

describe("in-flight ssh children", () => {
  it("kills every child still running, and reports how many", () => {
    const a = hangingChild();
    const b = hangingChild();
    spawnMock.mockReturnValueOnce(a).mockReturnValueOnce(b);

    void realSshRunner("my-vm", ["cat", "/x"]);
    void realSshRunner("my-vm", ["cat", "/y"]);

    expect(killInFlightSsh()).toBe(2);
    expect(a.kill).toHaveBeenCalledWith("SIGKILL");
    expect(b.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("forgets a child once it settles — a finished call is not killed later", async () => {
    const child = hangingChild();
    spawnMock.mockReturnValueOnce(child);

    const done = realSshRunner("my-vm", ["cat", "/x"]);
    child.stdout.emit("data", Buffer.from("ok"));
    child.emit("close", 0);
    await expect(done).resolves.toMatchObject({ ok: true, stdout: "ok" });

    expect(killInFlightSsh()).toBe(0);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("is total — nothing in flight is a no-op, never a throw", () => {
    expect(() => killInFlightSsh()).not.toThrow();
    expect(killInFlightSsh()).toBe(0);
  });
});

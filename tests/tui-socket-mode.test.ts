// A real `runTui` in the containerised TUI's shape (D35): the companion is a
// container the host wrapper ran, reached through a shared tmux socket; the VM
// is reached by ssh. No docker, no model, no network: child_process is replaced
// by a fake tmux (which answers like the companion's server) and a fake remote
// (which answers like the VM's `cat status.json`), and every spawn is logged.
//
// What it pins end to end:
//   - the companion is brought up with `tmux -S <socket>` and nothing else: its
//     session is born only after the server answered, the rollover and the
//     column's mirror go through the same socket, and not one docker process
//     is spawned, at start or at quit;
//   - quitting does not try to stop a container this process never ran;
//   - the channel dirs the companion shares are the host's, from the wrapper's
//     env, not the container's own HOME;
//   - the remote board still comes over ssh (the fake remote's snapshot is on
//     the board).
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../src/tui/paint.js";
import { CONTAINER } from "../src/tui/companion.js";

interface Rig {
  spawned: string[];
  tmux: string[][];
  sessions: number;
}
function rigState(): Rig {
  const g = globalThis as Record<string, unknown>;
  g.__qcrSocketRig ??= { spawned: [], tmux: [], sessions: 0 } satisfies Rig;
  return g.__qcrSocketRig as Rig;
}

const SNAPSHOT = {
  written_at: new Date().toISOString(),
  dry_run: true,
  prs: [
    {
      number: 5012,
      state: "reviewing",
      title: "fix(crm): retry send_message",
      head_sha: "a2e380ff11",
      stale_recheck: 0,
    },
  ],
  running_rounds: 1,
  max_concurrent_rounds: 12,
  total_spend_usd: 1,
  heartbeat: new Date().toISOString(),
};

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const g = globalThis as Record<string, unknown>;
  const state = (): Rig => {
    g.__qcrSocketRig ??= { spawned: [], tmux: [], sessions: 0 };
    return g.__qcrSocketRig as Rig;
  };
  type Answer = { code: number; stdout?: string; stderr?: string };
  const tmuxAnswer = (args: string[]): Answer => {
    const s = state();
    s.tmux.push(args);
    const word = args.slice(2).find((a) => !a.startsWith("-"));
    switch (word) {
      case "show-options":
        return { code: 0, stdout: "exit-empty off\n" };
      case "has-session":
        return { code: s.sessions > 0 ? 0 : 1, stderr: s.sessions > 0 ? "" : "can't find session" };
      case "new-session":
        s.sessions++;
        return { code: 0 };
      case "resize-window":
        return { code: 0, stdout: "FAKE COMPANION PANE\n" };
      default:
        // run-shell: the rollover's scripts — an empty volume, nothing yet
        return { code: 0 };
    }
  };
  const remoteAnswer = (args: string[]): Answer =>
    args.join(" ").includes("status.json")
      ? { code: 0, stdout: JSON.stringify(SNAPSHOT) }
      : { code: 1, stderr: "fake remote: nothing here" };
  const child = (answer: Answer): EventEmitter & Record<string, unknown> => {
    const c = new EventEmitter() as EventEmitter & Record<string, unknown>;
    c.stdout = new PassThrough();
    c.stderr = new PassThrough();
    c.stdin = new PassThrough();
    c.kill = () => true;
    c.unref = () => c;
    c.exitCode = answer.code;
    c.killed = false;
    setTimeout(() => {
      (c.stdout as PassThrough).end(answer.stdout ?? "");
      (c.stderr as PassThrough).end(answer.stderr ?? "");
      c.emit("close", answer.code);
      c.emit("exit", answer.code);
    }, 0);
    return c;
  };
  const argsOf = (rest: unknown[]): string[] =>
    Array.isArray(rest[0]) ? (rest[0] as string[]) : [];
  return {
    ...actual,
    default: actual,
    spawn: (bin: string, ...rest: unknown[]) => {
      const args = argsOf(rest);
      state().spawned.push([bin, ...args].join(" "));
      if (bin === "tmux") return child(tmuxAnswer(args));
      if (bin === "ssh") return child(remoteAnswer(args));
      return child({ code: 1, stderr: `fake: ${bin} is not available` });
    },
    spawnSync: (bin: string, ...rest: unknown[]) => {
      state().spawned.push([bin, ...argsOf(rest)].join(" "));
      return {
        status: 1,
        stdout: "",
        stderr: "",
        signal: null,
        pid: 0,
        output: [],
        error: undefined,
      };
    },
    execFile: (bin: string, ...rest: unknown[]) => {
      state().spawned.push([bin, ...argsOf(rest)].join(" "));
      const cb = rest.find((r) => typeof r === "function") as
        ((e: Error | null, o: string, s: string) => void) | undefined;
      if (cb) setTimeout(() => cb(new Error("mocked"), "", ""), 0);
      return child({ code: 1 });
    },
  };
});

function fakeTerminal() {
  const written: string[] = [];
  let painted!: () => void;
  const firstFrame = new Promise<void>((r) => (painted = r));
  const out = new EventEmitter() as unknown as NodeJS.WriteStream;
  Object.assign(out, {
    isTTY: true,
    columns: 160,
    rows: 48,
    write: (s: string) => {
      written.push(s);
      if (stripAnsi(s).includes("quickreview")) painted();
      return true;
    },
  });
  const input = new EventEmitter() as unknown as NodeJS.ReadStream;
  Object.assign(input, {
    isTTY: true,
    setRawMode: () => input,
    resume: () => input,
    pause: () => input,
  });
  return { out, input, written, firstFrame };
}

async function until(step: () => boolean, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!step() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
}

describe("runTui with the companion behind a tmux socket", () => {
  const tmp = mkdtempSync(join(tmpdir(), "qcr-socket-tui-"));
  const home = join(tmp, "home");
  const saved: Record<string, string | undefined> = {};
  const realFetch = globalThis.fetch;
  afterAll(() => {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  it("brings the companion up over tmux -S, spawns no docker, and does not stop what it did not run", async () => {
    const env: Record<string, string> = {
      QCR_TUI_COMPANION: "tmux-socket",
      QCR_HOST_HOME: home,
      QCR_HOST_XDG_CONFIG_HOME: join(home, ".config"),
      QCR_HOST_XDG_STATE_HOME: join(home, ".local", "state"),
      QCR_MEMORY_PORT: "0",
      QCR_MEMORY_GATEWAY: "127.0.0.1",
    };
    for (const [k, v] of Object.entries(env)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    globalThis.fetch = (() => Promise.reject(new Error("no network in tests"))) as typeof fetch;

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig(join(process.cwd(), "tests/fixtures/config.toml"));
    const { out, input, written, firstFrame } = fakeTerminal();
    const { runTui } = await import("../src/tui/index.js");
    const running = runTui(["--no-reload"], { out, input, config, exit: () => {} });
    await Promise.race([
      firstFrame,
      running.then(() => {
        throw new Error("runTui exited before it painted");
      }),
    ]);

    const s = rigState();
    // the companion column mirrors the fake pane once the bring-up is through,
    // and the remote board shows the fake remote's snapshot
    await until(() => s.sessions > 0);
    expect(s.sessions, "the companion's pi session was never spawned").toBe(1);
    await until(() => stripAnsi(written.join("")).includes("FAKE COMPANION PANE"));
    // the first launch on a machine opens the key map over the board; any key closes it
    input.emit("data", Buffer.from("\x1b"));
    await until(() => stripAnsi(written.join("")).includes("5012"));
    const frame = stripAnsi(written.join(""));
    expect(frame).toContain("FAKE COMPANION PANE");
    expect(frame).toContain("5012");

    input.emit("data", Buffer.from([0x03]));
    input.emit("data", Buffer.from([0x03]));
    await running;

    // every tmux call is on the shared socket
    expect(s.tmux.length).toBeGreaterThan(3);
    for (const args of s.tmux)
      expect(args.slice(0, 2)).toEqual(["-S", "/run/qcr-tmux/companion.sock"]);
    // the server answered before the session was born
    const words = s.tmux.map((a) => a.slice(2).find((w) => !w.startsWith("-")));
    expect(words.indexOf("show-options")).toBeGreaterThanOrEqual(0);
    expect(words.indexOf("show-options")).toBeLessThan(words.indexOf("new-session"));
    // the companion's pi, from the image's extensions
    const born = s.tmux.find((a) => a.includes("new-session"))!;
    expect(born).toContain(`${CONTAINER.app}/node_modules/.bin/pi`);
    expect(born).toContain("/opt/qcr/extensions/cli/lens.ts");
    expect(born).toContain("QCR_FEED_DIR=/feed");

    // no docker anywhere: not to start, not to inspect, not to stop at quit
    expect(s.spawned.filter((c) => /(^|\/)docker\b/.test(c.split(" ")[0]!))).toEqual([]);
    expect(written.join("")).not.toContain("stopping the companion container");
    // the remote board was reached by ssh
    expect(s.spawned.some((c) => c.startsWith("ssh "))).toBe(true);
    // the channels the wrapper shares are the host's own dirs, created under HOME
    const ops = join(home, ".local", "state", "qcr-operator", "default", "companion");
    expect(existsSync(join(ops, "feed"))).toBe(true);
  }, 60_000);
});
